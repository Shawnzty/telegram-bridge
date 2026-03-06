import type { Bot } from 'grammy';
import { promises as fs } from 'node:fs';
import type { SessionStore } from '../session/sessionStore.js';
import type { ProcessManager } from '../cli/processManager.js';
import type { OutputStreamer } from '../cli/outputStreamer.js';
import { config } from '../config.js';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function registerMessageHandler(
  bot: Bot,
  store: SessionStore,
  processManager: ProcessManager,
  outputStreamer: OutputStreamer,
): void {
  bot.on('message:text', async (ctx) => {
    const session = store.get(ctx.chat.id);

    if (session.isRunning) {
      return ctx.reply('⚠️ A process is already running. Use /stop or /kill first, or /stdin to send input.');
    }

    const prompt = ctx.message.text;
    const shortCwd = session.cwd.replace(config.basePath, '~');
    const header = `🤖 ${session.selectedModel.cli} (${session.selectedModel.model}) | ${shortCwd}`;

    // Send initial message
    const sentMessage = await ctx.reply(`${header}\n\n⏳ Starting...`);

    store.update(ctx.chat.id, {
      currentMessageId: sentMessage.message_id,
      messageHistory: [sentMessage.message_id],
      outputBuffer: '',
      isRunning: true,
      startedAt: new Date(),
    });

    try {
      const stat = await fs.stat(session.cwd);
      if (!stat.isDirectory()) {
        throw new Error(`Working directory is not a directory: ${session.cwd}`);
      }

      const proc = processManager.spawn({
        prompt,
        model: session.selectedModel,
        cwd: session.cwd,
        continueSession: session.lastSessionId ?? undefined,
        reasoningLevel: session.reasoningLevel,
        fullPermissions: session.fullPermissions,
      });

      store.update(ctx.chat.id, { activeProcess: proc });

      // Wire the output streamer
      outputStreamer.attach(ctx.api, ctx.chat.id, store, proc);
    } catch (err: any) {
      console.error('Spawn error:', err);
      store.update(ctx.chat.id, {
        isRunning: false,
        activeProcess: null,
        startedAt: null,
      });

      let errorMsg: string;
      if (err.code === 'ENOENT') {
        errorMsg = err.path === session.cwd
          ? `Working directory not found: ${session.cwd}`
          : `Command '${session.selectedModel.cli}' not found. Make sure it is installed and in PATH.`;
      } else {
        errorMsg = `Failed to start: ${err.message ?? err}`;
        if (err.errno) errorMsg += ` (errno: ${err.errno})`;
      }

      await ctx.api.editMessageText(
        ctx.chat.id,
        sentMessage.message_id,
        `${header}\n\n❌ ${escapeHtml(errorMsg)}`,
        { parse_mode: 'HTML' },
      );
    }
  });
}
