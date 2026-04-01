import type { Api, RawApi } from 'grammy';
import type { IPty } from 'node-pty';
import stripAnsi from 'strip-ansi';
import type { ChatSession } from '../session/sessionStore.js';
import type { SessionStore } from '../session/sessionStore.js';
import { config } from '../config.js';
import { InlineKeyboard } from 'grammy';

const CONFIRMATION_PATTERNS = [
  /\(y\/n\)/i,
  /\[Y\/n\]/,
  /\[y\/N\]/,
  /Do you want to proceed/i,
  /Allow\s+(Bash|Read|Write|Edit)/i,
  /approve|reject|accept|deny/i,
];

function detectConfirmationPrompt(text: string): boolean {
  return CONFIRMATION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Simulate terminal carriage-return behaviour.
 * `\r` (not followed by `\n`) moves the cursor to the start of the line,
 * so the next text overwrites what was there.  Progress bars emit hundreds
 * of such overwrites per second — we collapse them to just the latest one.
 */
function processCarriageReturns(buffer: string): string {
  const lines = buffer.split('\n');
  return lines
    .map((line) => {
      if (!line.includes('\r')) return line;
      const segments = line.split('\r');
      // Last non-empty segment is what the terminal would display
      for (let i = segments.length - 1; i >= 0; i--) {
        if (segments[i].length > 0) return segments[i];
      }
      return '';
    })
    .join('\n');
}

function buildHeader(session: ChatSession): string {
  if (session.headerOverride) return session.headerOverride;
  const shortCwd = session.cwd.replace(config.basePath, '~');
  return `🤖 ${session.selectedModel.cli} (${session.selectedModel.model}) | ${shortCwd}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function simpleHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash;
}

export class OutputStreamer {
  private editTimers = new Map<number, ReturnType<typeof setInterval>>();
  private lastEditHash = new Map<number, number>();
  /** Timestamp (ms) until which API calls should be skipped for a chat */
  private backoffUntil = new Map<number, number>();

  attach(
    api: Api<RawApi>,
    chatId: number,
    store: SessionStore,
    process: IPty,
  ): void {
    const session = store.get(chatId);

    process.onData((data: string) => {
      const cleaned = stripAnsi(data);
      session.outputBuffer += cleaned;
      // Collapse carriage-return overwrites (progress bars, spinners, etc.)
      session.outputBuffer = processCarriageReturns(session.outputBuffer);

      // Check for confirmation prompts in the tail of the buffer
      const tail = session.outputBuffer.slice(-300);
      if (detectConfirmationPrompt(tail)) {
        this.sendConfirmationButtons(api, chatId).catch(() => {});
      }
    });

    // Start the edit interval
    const timer = setInterval(() => {
      this.flushBuffer(api, chatId, store).catch((err) => {
        console.error('Flush error:', err);
      });
    }, config.editIntervalMs);

    this.editTimers.set(chatId, timer);

    process.onExit(({ exitCode }) => {
      // Clear the timer
      const t = this.editTimers.get(chatId);
      if (t) {
        clearInterval(t);
        this.editTimers.delete(chatId);
      }

      // Final flush
      this.finalFlush(api, chatId, store, exitCode).catch((err) => {
        console.error('Final flush error:', err);
      });
    });
  }

  detach(chatId: number): void {
    const timer = this.editTimers.get(chatId);
    if (timer) {
      clearInterval(timer);
      this.editTimers.delete(chatId);
    }
    this.lastEditHash.delete(chatId);
    this.backoffUntil.delete(chatId);
  }

  // ---------------------------------------------------------------------------
  //  Rate-limited API call wrapper
  // ---------------------------------------------------------------------------

  /**
   * Execute an API call with 429 detection, backoff, and single retry.
   * Returns `null` when the call is suppressed or fails after retry.
   */
  private async rateLimitedCall<T>(
    chatId: number,
    apiCall: () => Promise<T>,
    { silenceNotModified = false }: { silenceNotModified?: boolean } = {},
  ): Promise<T | null> {
    try {
      const result = await apiCall();
      this.backoffUntil.set(chatId, 0);
      return result;
    } catch (error: any) {
      const description: string = error?.description ?? error?.message ?? '';

      // "message is not modified" is harmless — suppress silently
      if (silenceNotModified && description.includes('message is not modified')) {
        return null;
      }

      if (error?.error_code === 429 || description.includes('Too Many Requests')) {
        const retryAfter = error?.parameters?.retry_after ?? 5;
        this.backoffUntil.set(chatId, Date.now() + retryAfter * 1000);
        console.warn(`Rate limited for chat ${chatId}, backing off ${retryAfter}s`);
        await sleep(retryAfter * 1000);
        // Retry once
        try {
          const result = await apiCall();
          this.backoffUntil.set(chatId, 0);
          return result;
        } catch {
          return null; // give up
        }
      }

      console.error('API error:', description);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  //  Flush helpers
  // ---------------------------------------------------------------------------

  private async flushBuffer(
    api: Api<RawApi>,
    chatId: number,
    store: SessionStore,
  ): Promise<void> {
    // Skip flush if we're still in a rate-limit backoff period
    const until = this.backoffUntil.get(chatId) ?? 0;
    if (Date.now() < until) return;

    const session = store.get(chatId);
    if (!session.outputBuffer || !session.currentMessageId) return;

    const header = buildHeader(session);
    const body = session.outputBuffer;
    const displayText = this.renderOutputMessage(header, body, { streaming: true });

    if (displayText.length <= config.maxMessageLength) {
      await this.editIfChanged(api, chatId, session.currentMessageId, displayText);
      return;
    }

    const firstSplit = this.findSafeBreakIndex(
      body,
      this.maxEscapedBodyLength(header, { streaming: false }),
    );
    const firstBody = body.slice(0, firstSplit);
    let remaining = body.slice(firstSplit);

    await this.editIfChanged(
      api,
      chatId,
      session.currentMessageId,
      this.renderOutputMessage(header, firstBody),
    );

    if (!remaining) {
      session.outputBuffer = firstBody;
      return;
    }

    let lastChunk = '';
    while (remaining.length > 0) {
      const split = this.findSafeBreakIndex(
        remaining,
        this.maxEscapedBodyLength(header, { streaming: true }),
      );
      const chunk = remaining.slice(0, split);
      remaining = remaining.slice(split);

      const sent = await this.rateLimitedCall(chatId, () =>
        api.sendMessage(
          chatId,
          this.renderOutputMessage(header, chunk, { streaming: true }),
          { parse_mode: 'HTML' },
        ),
      );

      if (sent) {
        session.currentMessageId = sent.message_id;
        session.messageHistory.push(sent.message_id);
        lastChunk = chunk;
      } else {
        break; // rate-limited or failed — stop sending chunks this cycle
      }
    }

    if (lastChunk) {
      session.outputBuffer = lastChunk;
      this.lastEditHash.delete(chatId);
    }
  }

  private async finalFlush(
    api: Api<RawApi>,
    chatId: number,
    store: SessionStore,
    exitCode: number,
  ): Promise<void> {
    const session = store.get(chatId);
    const header = buildHeader(session);
    const statusEmoji = exitCode === 0 ? '✅' : '❌';
    const body = session.outputBuffer;
    const statusLine = `${statusEmoji} Exited (code ${exitCode})`;

    if (!session.currentMessageId) {
      const chunks = this.splitBodyForLimit(
        body,
        this.maxEscapedBodyLength(header, { statusLine }),
      );
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const sent = await this.rateLimitedCall(chatId, () =>
          api.sendMessage(
            chatId,
            this.renderOutputMessage(header, chunks[i], {
              statusLine: isLast ? statusLine : undefined,
            }),
            { parse_mode: 'HTML' },
          ),
        );
        if (!sent) break;
      }
    } else {
      const chunks = this.splitBodyForLimit(
        body,
        this.maxEscapedBodyLength(header, { statusLine }),
      );
      const firstChunk = chunks.shift() ?? '';
      const firstText = this.renderOutputMessage(
        header,
        firstChunk,
        chunks.length === 0 ? { statusLine } : undefined,
      );
      await this.editIfChanged(api, chatId, session.currentMessageId, firstText);

      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const sent = await this.rateLimitedCall(chatId, () =>
          api.sendMessage(
            chatId,
            this.renderOutputMessage(header, chunks[i], {
              statusLine: isLast ? statusLine : undefined,
            }),
            { parse_mode: 'HTML' },
          ),
        );
        if (!sent) break;
      }
    }

    // Reset session state
    store.update(chatId, {
      isRunning: false,
      activeProcess: null,
      outputBuffer: '',
      currentMessageId: null,
      headerOverride: null,
    });
  }

  // ---------------------------------------------------------------------------
  //  Rendering & splitting
  // ---------------------------------------------------------------------------

  private renderOutputMessage(
    header: string,
    body: string,
    options?: { streaming?: boolean; statusLine?: string },
  ): string {
    let text = `${header}\n\n<pre>${escapeHtml(body)}</pre>`;
    if (options?.streaming) {
      text += '\n\n🔄';
    } else if (options?.statusLine) {
      text += `\n\n${options.statusLine}`;
    }
    return text;
  }

  private maxEscapedBodyLength(
    header: string,
    options?: { streaming?: boolean; statusLine?: string },
  ): number {
    const wrapper = this.renderOutputMessage(header, '', options).length;
    return Math.max(1, config.maxMessageLength - wrapper);
  }

  private splitBodyForLimit(body: string, maxEscapedBodyLength: number): string[] {
    if (!body) return [''];

    const chunks: string[] = [];
    let remaining = body;
    while (remaining.length > 0) {
      const split = this.findSafeBreakIndex(remaining, maxEscapedBodyLength);
      chunks.push(remaining.slice(0, split));
      remaining = remaining.slice(split);
    }
    return chunks;
  }

  private findSafeBreakIndex(text: string, maxEscapedLen: number): number {
    if (!text) return 0;
    let escapedLen = 0;
    let i = 0;
    let lastNewline = -1;

    while (i < text.length) {
      const ch = text[i];
      const charLen = ch === '&' ? 5 : (ch === '<' || ch === '>' ? 4 : 1);
      if (escapedLen + charLen > maxEscapedLen) break;
      escapedLen += charLen;
      if (ch === '\n') lastNewline = i;
      i += 1;
    }

    if (i === 0) return 1;

    const half = Math.floor(i / 2);
    if (lastNewline >= half) {
      return lastNewline + 1;
    }
    return i;
  }

  // ---------------------------------------------------------------------------
  //  Edit helpers
  // ---------------------------------------------------------------------------

  private async editIfChanged(
    api: Api<RawApi>,
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<void> {
    const hash = simpleHash(text);
    if (this.lastEditHash.get(chatId) === hash) return;
    this.lastEditHash.set(chatId, hash);

    await this.rateLimitedCall(
      chatId,
      () => api.editMessageText(chatId, messageId, text, { parse_mode: 'HTML' }),
      { silenceNotModified: true },
    );
  }

  private async sendConfirmationButtons(
    api: Api<RawApi>,
    chatId: number,
  ): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text('✅ Yes', 'confirm:yes')
      .text('❌ No', 'confirm:no');

    try {
      await api.sendMessage(chatId, 'The CLI is asking for confirmation:', {
        reply_markup: keyboard,
      });
    } catch (err) {
      console.error('Failed to send confirmation buttons:', err);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
