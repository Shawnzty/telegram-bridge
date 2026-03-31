import { type Bot, type Context, InlineKeyboard } from 'grammy';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config, AVAILABLE_MODELS, REASONING_LEVELS } from '../config.js';
import type { SessionStore } from '../session/sessionStore.js';
import type { ProcessManager } from '../cli/processManager.js';
import type { OutputStreamer } from '../cli/outputStreamer.js';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isPathSafe(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  const base = path.resolve(config.basePath);
  return resolved === base || resolved.startsWith(base + path.sep);
}

export function registerCommands(
  bot: Bot,
  store: SessionStore,
  processManager: ProcessManager,
  outputStreamer: OutputStreamer,
): void {
  bot.command('ls', async (ctx) => {
    const session = store.get(ctx.chat.id);
    const targetDir = session.cwd;

    try {
      const entries = await fs.readdir(targetDir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name));

      if (dirs.length === 0) {
        return ctx.reply('No subdirectories found.');
      }

      const keyboard = new InlineKeyboard();
      for (const dir of dirs) {
        keyboard.text(`📁 ${dir.name}`, `cd:${dir.name}`).row();
      }

      await ctx.reply(`📂 ${targetDir}`, { reply_markup: keyboard });
    } catch (err: any) {
      await ctx.reply(`Error listing directory: ${err.message}`);
    }
  });

  bot.command('cd', async (ctx) => {
    const folder = ctx.match;
    if (!folder) {
      return ctx.reply('Usage: /cd <folder_name> or /cd /full/path');
    }

    // Support both relative (to basePath) and absolute paths
    const resolved = path.isAbsolute(folder)
      ? path.resolve(folder)
      : path.resolve(config.basePath, folder);

    if (!isPathSafe(resolved)) {
      return ctx.reply('⛔ Path must be within the base directory.');
    }

    try {
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) {
        return ctx.reply('Not a directory.');
      }
    } catch {
      return ctx.reply(`Directory not found: ${resolved}`);
    }

    store.update(ctx.chat.id, { cwd: resolved });
    await ctx.reply(`📂 Working directory: ${resolved}`);
  });

  bot.command('pwd', async (ctx) => {
    const session = store.get(ctx.chat.id);
    await ctx.reply(`📂 ${session.cwd}`);
  });

  bot.command('new', async (ctx) => {
    const folderName = ctx.match;
    if (!folderName) {
      return ctx.reply('Usage: /new <folder_name>');
    }

    if (!/^[a-zA-Z0-9_\-.]+$/.test(folderName)) {
      return ctx.reply('Invalid folder name. Use alphanumeric, dash, underscore, or dot.');
    }

    const newPath = path.join(config.basePath, folderName);

    try {
      await fs.mkdir(newPath, { recursive: true });
      store.update(ctx.chat.id, { cwd: newPath });
      await ctx.reply(`✅ Created and switched to: ${newPath}`);
    } catch (err: any) {
      await ctx.reply(`Error creating directory: ${err.message}`);
    }
  });

  bot.command('model', async (ctx) => {
    const session = store.get(ctx.chat.id);
    const keyboard = new InlineKeyboard();

    // Group models
    const groups = new Map<string, typeof AVAILABLE_MODELS>();
    for (const m of AVAILABLE_MODELS) {
      if (!groups.has(m.group)) groups.set(m.group, []);
      groups.get(m.group)!.push(m);
    }

    for (const [groupName, models] of groups) {
      // Add group header as a row of buttons
      for (const m of models) {
        const isCurrent = session.selectedModel.model === m.model;
        const prefix = isCurrent ? '✓ ' : '';
        keyboard.text(`${prefix}${m.label}`, `model:${m.model}`).row();
      }
    }

    await ctx.reply('Select a model:', { reply_markup: keyboard });
  });

  bot.command('menu', async (ctx) => {
    const session = store.get(ctx.chat.id);
    const shortCwd = escapeHtml(session.cwd.replace(config.basePath, '~'));
    const statusIcon = session.isRunning ? '⚡ Running' : '💤 Idle';

    let elapsed = '';
    if (session.isRunning && session.startedAt) {
      const secs = Math.round((Date.now() - session.startedAt.getTime()) / 1000);
      elapsed = ` (${secs}s)`;
    }

    const permLabel = session.fullPermissions ? '🔓 Full Access' : '🔒 Safe Mode';
    const lines = [
      `🤖 <b>${escapeHtml(session.selectedModel.label)}</b> (${escapeHtml(session.selectedModel.cli)})`,
    ];
    if (session.selectedModel.cli === 'codex') {
      const rl = REASONING_LEVELS.find((r) => r.value === session.reasoningLevel);
      lines.push(`🧠 Reasoning: ${rl?.label ?? session.reasoningLevel}`);
    }
    lines.push(`${permLabel}`);
    lines.push(`📂 ${shortCwd}`);
    lines.push(`${statusIcon}${elapsed}`);

    const keyboard = new InlineKeyboard()
      .text('🔄 Change Model', 'menu:model')
      .text('📂 Change Folder', 'menu:folder')
      .row();

    if (session.selectedModel.cli === 'codex') {
      keyboard.text('🧠 Reasoning', 'menu:reasoning');
    }

    const permToggleLabel = session.fullPermissions ? '🔒 Safe Mode' : '🔓 Full Access';
    keyboard.text(permToggleLabel, 'menu:toggleperm');
    keyboard.row().text('📋 Status', 'menu:status');

    if (session.isRunning) {
      keyboard.text('⏹️ Stop', 'menu:stop');
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: keyboard });
  });

  bot.command('status', async (ctx) => {
    const session = store.get(ctx.chat.id);
    const lines = [
      `🤖 CLI: ${session.selectedModel.cli}`,
      `🧠 Model: ${session.selectedModel.label} (${session.selectedModel.model})`,
    ];
    if (session.selectedModel.cli === 'codex') {
      const rl = REASONING_LEVELS.find((r) => r.value === session.reasoningLevel);
      lines.push(`💡 Reasoning: ${rl?.label ?? session.reasoningLevel}`);
    }
    lines.push(session.fullPermissions ? '🔓 Permissions: Full Access' : '🔒 Permissions: Safe Mode');
    lines.push(`📂 CWD: ${session.cwd}`);
    lines.push(`⚡ Running: ${session.isRunning ? 'Yes' : 'No'}`);
    if (session.isRunning && session.startedAt) {
      const elapsed = Math.round((Date.now() - session.startedAt.getTime()) / 1000);
      lines.push(`⏱️ Elapsed: ${elapsed}s`);
    }
    await ctx.reply(lines.join('\n'));
  });

  bot.command('stop', async (ctx) => {
    const session = store.get(ctx.chat.id);
    if (!session.activeProcess) {
      return ctx.reply('No process running.');
    }
    session.activeProcess.kill('SIGINT');
    await ctx.reply('⏹️ Sent SIGINT.');
  });

  bot.command('kill', async (ctx) => {
    const session = store.get(ctx.chat.id);
    if (!session.activeProcess) {
      return ctx.reply('No process running.');
    }
    session.activeProcess.kill('SIGKILL');
    await ctx.reply('💀 Sent SIGKILL.');
  });

  bot.command('y', async (ctx) => {
    const session = store.get(ctx.chat.id);
    if (!session.activeProcess) {
      return ctx.reply('No process running.');
    }
    session.activeProcess.write('y\n');
    await ctx.reply('Sent: y');
  });

  bot.command('n', async (ctx) => {
    const session = store.get(ctx.chat.id);
    if (!session.activeProcess) {
      return ctx.reply('No process running.');
    }
    session.activeProcess.write('n\n');
    await ctx.reply('Sent: n');
  });

  bot.command('stdin', async (ctx) => {
    const text = ctx.match;
    if (!text) {
      return ctx.reply('Usage: /stdin <text>');
    }
    const session = store.get(ctx.chat.id);
    if (!session.activeProcess) {
      return ctx.reply('No process running.');
    }
    session.activeProcess.write(text + '\n');
    await ctx.reply(`Sent: ${text}`);
  });

  bot.command('sh', async (ctx) => {
    const session = store.get(ctx.chat.id);

    if (session.isRunning) {
      return ctx.reply('A process is already running. Use /stop or /kill first.');
    }

    let rawArgs = ctx.match;
    if (!rawArgs) {
      return ctx.reply('Usage: /sh <command>\nExample: /sh git status\nOptional: /sh -d /path command');
    }

    // Parse optional -d flag for directory override
    let cwd = session.cwd;
    const dirMatch = rawArgs.match(/^-d\s+(\S+)\s+(.+)$/s);
    if (dirMatch) {
      const targetDir = dirMatch[1];
      const resolved = path.isAbsolute(targetDir)
        ? path.resolve(targetDir)
        : path.resolve(session.cwd, targetDir);

      if (!isPathSafe(resolved)) {
        return ctx.reply('⛔ Path must be within the base directory.');
      }

      try {
        const stat = await fs.stat(resolved);
        if (!stat.isDirectory()) {
          return ctx.reply('Not a directory: ' + resolved);
        }
      } catch {
        return ctx.reply('Directory not found: ' + resolved);
      }

      cwd = resolved;
      rawArgs = dirMatch[2];
    }

    const shortCwd = cwd.replace(config.basePath, '~');
    const headerText = `$ ${escapeHtml(rawArgs.length > 60 ? rawArgs.slice(0, 57) + '...' : rawArgs)} | ${escapeHtml(shortCwd)}`;

    const sentMessage = await ctx.reply(`${headerText}\n\n<pre>Starting...</pre>`, { parse_mode: 'HTML' });

    store.update(ctx.chat.id, {
      headerOverride: `$ ${rawArgs.length > 60 ? rawArgs.slice(0, 57) + '...' : rawArgs} | ${shortCwd}`,
      currentMessageId: sentMessage.message_id,
      messageHistory: [sentMessage.message_id],
      outputBuffer: '',
      isRunning: true,
      startedAt: new Date(),
    });

    try {
      const proc = processManager.spawnShell(rawArgs, cwd);
      store.update(ctx.chat.id, { activeProcess: proc });
      outputStreamer.attach(ctx.api, ctx.chat.id, store, proc);
    } catch (err: any) {
      store.update(ctx.chat.id, {
        isRunning: false,
        activeProcess: null,
        startedAt: null,
        headerOverride: null,
      });
      await ctx.api.editMessageText(
        ctx.chat.id,
        sentMessage.message_id,
        `${headerText}\n\n<pre>${escapeHtml(err.message)}</pre>`,
        { parse_mode: 'HTML' },
      );
    }
  });

  bot.command(['help', 'start'], async (ctx) => {
    const text = [
      '<b>Telegram Bridge</b>',
      'Control Claude Code &amp; Codex CLI remotely.',
      '',
      '<b>Navigation</b>',
      '/menu — Dashboard with quick actions',
      '/ls — List folders (tap to select)',
      '/cd &lt;folder&gt; — Change directory',
      '/pwd — Show current directory',
      '/new &lt;name&gt; — Create &amp; enter new folder',
      '',
      '<b>Model &amp; Config</b>',
      '/model — Pick model from keyboard',
      '/status — Show full session info',
      '',
      '<b>Shell</b>',
      '/sh &lt;command&gt; — Run a shell command',
      '/sh -d &lt;path&gt; &lt;cmd&gt; — Run in specific directory',
      '',
      '<b>Process Control</b>',
      '/stop — Send Ctrl+C (SIGINT)',
      '/kill — Force kill (SIGKILL)',
      '/y — Send "y" to stdin',
      '/n — Send "n" to stdin',
      '/stdin &lt;text&gt; — Send arbitrary text',
      '',
      '<i>Any other text message is sent as a prompt to the active CLI.</i>',
    ];
    await ctx.reply(text.join('\n'), { parse_mode: 'HTML' });
  });
}
