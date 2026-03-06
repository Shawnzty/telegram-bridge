import { type Bot, InlineKeyboard } from 'grammy';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { config, AVAILABLE_MODELS, REASONING_LEVELS } from '../config.js';
import type { SessionStore } from '../session/sessionStore.js';

function isPathSafe(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  const base = path.resolve(config.basePath);
  return resolved === base || resolved.startsWith(base + path.sep);
}

export function registerCallbackHandlers(bot: Bot, store: SessionStore): void {
  // Menu button: Change Model → show model keyboard
  bot.callbackQuery('menu:model', async (ctx) => {
    const session = store.get(ctx.chat!.id);
    const keyboard = new InlineKeyboard();

    const groups = new Map<string, typeof AVAILABLE_MODELS>();
    for (const m of AVAILABLE_MODELS) {
      if (!groups.has(m.group)) groups.set(m.group, []);
      groups.get(m.group)!.push(m);
    }

    for (const [, models] of groups) {
      for (const m of models) {
        const isCurrent = session.selectedModel.model === m.model;
        const prefix = isCurrent ? '✓ ' : '';
        keyboard.text(`${prefix}${m.label}`, `model:${m.model}`).row();
      }
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText('Select a model:', { reply_markup: keyboard });
  });

  // Menu button: Change Folder → show folder list
  bot.callbackQuery('menu:folder', async (ctx) => {
    const session = store.get(ctx.chat!.id);

    try {
      const entries = await fs.readdir(session.cwd, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name));

      if (dirs.length === 0) {
        await ctx.answerCallbackQuery({ text: 'No subdirectories found.' });
        return;
      }

      const keyboard = new InlineKeyboard();
      for (const dir of dirs) {
        keyboard.text(`📁 ${dir.name}`, `cd:${dir.name}`).row();
      }

      await ctx.answerCallbackQuery();
      await ctx.editMessageText(`📂 ${session.cwd}`, { reply_markup: keyboard });
    } catch (err: any) {
      await ctx.answerCallbackQuery({ text: `Error: ${err.message}` });
    }
  });

  // Menu button: Status
  bot.callbackQuery('menu:status', async (ctx) => {
    const session = store.get(ctx.chat!.id);
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
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(lines.join('\n'));
  });

  // Menu button: Change Reasoning level
  bot.callbackQuery('menu:reasoning', async (ctx) => {
    const session = store.get(ctx.chat!.id);
    const keyboard = new InlineKeyboard();
    for (const r of REASONING_LEVELS) {
      const isCurrent = session.reasoningLevel === r.value;
      const prefix = isCurrent ? '✓ ' : '';
      keyboard.text(`${prefix}${r.label}`, `reasoning:${r.value}`).row();
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('Select reasoning level:', { reply_markup: keyboard });
  });

  // Menu button: Toggle permissions
  bot.callbackQuery('menu:toggleperm', async (ctx) => {
    const session = store.get(ctx.chat!.id);
    const newValue = !session.fullPermissions;
    store.update(ctx.chat!.id, { fullPermissions: newValue });
    const label = newValue ? '🔓 Full Access' : '🔒 Safe Mode';
    await ctx.answerCallbackQuery({ text: label });
    await ctx.editMessageText(
      `${label}\n\nClaude: ${newValue ? '--dangerously-skip-permissions' : 'will ask for approval'}\nCodex: ${newValue ? '--dangerously-bypass-approvals-and-sandbox' : '--full-auto'}`,
    );
  });

  // Menu button: Stop
  bot.callbackQuery('menu:stop', async (ctx) => {
    const session = store.get(ctx.chat!.id);
    if (session.activeProcess) {
      session.activeProcess.kill('SIGINT');
      await ctx.answerCallbackQuery({ text: '⏹️ Sent SIGINT' });
    } else {
      await ctx.answerCallbackQuery({ text: 'No process running.' });
    }
  });
  // Folder selection from /ls
  bot.callbackQuery(/^cd:(.+)$/, async (ctx) => {
    const folder = ctx.match![1];
    const session = store.get(ctx.chat!.id);

    // Resolve relative to current cwd (since /ls shows cwd contents)
    const resolved = path.resolve(session.cwd, folder);

    if (!isPathSafe(resolved)) {
      return ctx.answerCallbackQuery({ text: '⛔ Path traversal blocked.' });
    }

    try {
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) {
        return ctx.answerCallbackQuery({ text: 'Not a directory.' });
      }
    } catch {
      return ctx.answerCallbackQuery({ text: 'Directory not found.' });
    }

    store.update(ctx.chat!.id, { cwd: resolved });
    await ctx.answerCallbackQuery({ text: `📂 ${resolved}` });
    await ctx.editMessageText(`📂 Working directory: ${resolved}`);
  });

  // Model selection
  bot.callbackQuery(/^model:(.+)$/, async (ctx) => {
    const modelId = ctx.match![1];
    const model = AVAILABLE_MODELS.find((m) => m.model === modelId);
    if (!model) {
      return ctx.answerCallbackQuery({ text: 'Model not found.' });
    }

    store.update(ctx.chat!.id, { selectedModel: model });

    if (model.cli === 'codex') {
      // Codex selected → show reasoning level picker
      const session = store.get(ctx.chat!.id);
      const keyboard = new InlineKeyboard();
      for (const r of REASONING_LEVELS) {
        const isCurrent = session.reasoningLevel === r.value;
        const prefix = isCurrent ? '✓ ' : '';
        keyboard.text(`${prefix}${r.label}`, `reasoning:${r.value}`).row();
      }
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        `Selected <b>${model.label}</b>. Choose reasoning level:`,
        { parse_mode: 'HTML', reply_markup: keyboard },
      );
    } else {
      await ctx.answerCallbackQuery({ text: `✅ ${model.label}` });
      await ctx.editMessageText(
        `✅ Switched to <b>${model.group}</b> — <b>${model.label}</b>`,
        { parse_mode: 'HTML' },
      );
    }
  });

  // Reasoning level selection (Codex)
  bot.callbackQuery(/^reasoning:(.+)$/, async (ctx) => {
    const value = ctx.match![1] as import('../config.js').ReasoningLevel;
    const levelInfo = REASONING_LEVELS.find((r) => r.value === value);
    if (!levelInfo) {
      return ctx.answerCallbackQuery({ text: 'Unknown reasoning level.' });
    }

    store.update(ctx.chat!.id, { reasoningLevel: value });
    const session = store.get(ctx.chat!.id);
    await ctx.answerCallbackQuery({ text: `✅ ${levelInfo.label}` });
    await ctx.editMessageText(
      `✅ Switched to <b>${session.selectedModel.label}</b> — reasoning: <b>${levelInfo.label}</b>`,
      { parse_mode: 'HTML' },
    );
  });

  // Yes/No confirmation buttons
  bot.callbackQuery('confirm:yes', async (ctx) => {
    const session = store.get(ctx.chat!.id);
    if (session.activeProcess) {
      session.activeProcess.write('y\n');
      await ctx.answerCallbackQuery({ text: 'Sent: yes' });
    } else {
      await ctx.answerCallbackQuery({ text: 'No process running.' });
    }
  });

  bot.callbackQuery('confirm:no', async (ctx) => {
    const session = store.get(ctx.chat!.id);
    if (session.activeProcess) {
      session.activeProcess.write('n\n');
      await ctx.answerCallbackQuery({ text: 'Sent: no' });
    } else {
      await ctx.answerCallbackQuery({ text: 'No process running.' });
    }
  });
}
