import 'dotenv/config';

export interface ModelConfig {
  label: string;
  cli: 'claude' | 'codex';
  model: string;
  group: string;
}

export const AVAILABLE_MODELS: ModelConfig[] = [
  { label: 'Claude Opus 4.6', cli: 'claude', model: 'claude-opus-4-6', group: 'Claude Code' },
  { label: 'Claude Sonnet 4.5', cli: 'claude', model: 'claude-sonnet-4-5', group: 'Claude Code' },
  { label: 'GPT-5.3 Codex', cli: 'codex', model: 'gpt-5.3-codex', group: 'Codex' },
  { label: 'GPT-4.1 Codex', cli: 'codex', model: 'gpt-4.1-codex', group: 'Codex' },
  { label: 'o3', cli: 'codex', model: 'o3', group: 'Codex' },
];

export const config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  allowedUserIds: (process.env.ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((id) => Number(id.trim()))
    .filter((id) => !Number.isNaN(id) && id > 0),
  basePath: process.env.BASE_PATH ?? '/Users/tianyi/Documents/Zheng/Code',
  defaultCli: (process.env.DEFAULT_CLI ?? 'claude') as 'claude' | 'codex',
  defaultModel: process.env.DEFAULT_MODEL ?? 'claude-opus-4-6',

  // Streaming tuning
  editIntervalMs: 1500,
  maxMessageLength: 3800,
} as const;

export function getDefaultModelConfig(): ModelConfig {
  const found = AVAILABLE_MODELS.find(
    (m) => m.model === config.defaultModel && m.cli === config.defaultCli,
  );
  return found ?? AVAILABLE_MODELS[0];
}
