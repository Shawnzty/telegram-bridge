import type { IPty } from 'node-pty';
import type { ModelConfig, ReasoningLevel } from '../config.js';
import { config, getDefaultModelConfig } from '../config.js';

export interface ChatSession {
  chatId: number;
  cwd: string;
  selectedModel: ModelConfig;
  reasoningLevel: ReasoningLevel;
  fullPermissions: boolean;
  activeProcess: IPty | null;
  lastSessionId: string | null;
  currentMessageId: number | null;
  outputBuffer: string;
  messageHistory: number[];
  isRunning: boolean;
  startedAt: Date | null;
}

export class SessionStore {
  private sessions = new Map<number, ChatSession>();

  get(chatId: number): ChatSession {
    let session = this.sessions.get(chatId);
    if (!session) {
      session = {
        chatId,
        cwd: config.basePath,
        selectedModel: getDefaultModelConfig(),
        reasoningLevel: 'medium',
        fullPermissions: true,
        activeProcess: null,
        lastSessionId: null,
        currentMessageId: null,
        outputBuffer: '',
        messageHistory: [],
        isRunning: false,
        startedAt: null,
      };
      this.sessions.set(chatId, session);
    }
    return session;
  }

  update(chatId: number, partial: Partial<ChatSession>): void {
    const session = this.get(chatId);
    Object.assign(session, partial);
  }

  getAllChatIds(): number[] {
    return [...this.sessions.keys()];
  }
}
