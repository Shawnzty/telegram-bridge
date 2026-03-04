import { Bot } from 'grammy';
import { config } from './config.js';
import { SessionStore } from './session/sessionStore.js';
import { ProcessManager } from './cli/processManager.js';
import { OutputStreamer } from './cli/outputStreamer.js';
import { registerCommands } from './bot/commands.js';
import { registerCallbackHandlers } from './bot/callbackHandler.js';
import { registerMessageHandler } from './bot/messageHandler.js';

// Validate config
if (!config.telegramBotToken) {
  console.error('Error: TELEGRAM_BOT_TOKEN is required. Set it in .env');
  process.exit(1);
}
if (config.allowedUserIds.length === 0) {
  console.error('Error: ALLOWED_USER_IDS is required. Set it in .env');
  process.exit(1);
}

const bot = new Bot(config.telegramBotToken);
const store = new SessionStore();
const processManager = new ProcessManager();
const outputStreamer = new OutputStreamer();

// Security middleware: reject unauthorized users (silently ignore)
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || !config.allowedUserIds.includes(userId)) {
    return; // Silently ignore
  }
  return next();
});

// Register handlers
registerCommands(bot, store);
registerCallbackHandlers(bot, store);
registerMessageHandler(bot, store, processManager, outputStreamer);

// Error handler
bot.catch((err) => {
  console.error('Bot error:', err.error);
});

// Start the bot
console.log('Starting Telegram Bridge...');
console.log(`  Base path: ${config.basePath}`);
console.log(`  Default CLI: ${config.defaultCli}`);
console.log(`  Default model: ${config.defaultModel}`);
console.log(`  Allowed users: ${config.allowedUserIds.join(', ')}`);

bot.start({
  onStart: (botInfo) => {
    console.log(`  Bot username: @${botInfo.username}`);
    console.log('🟢 Bridge online');

    // Notify all allowed users
    for (const userId of config.allowedUserIds) {
      bot.api
        .sendMessage(userId, '🟢 Bridge online')
        .catch(() => {
          // User may not have started the bot yet
        });
    }
  },
});

// Graceful shutdown
const shutdown = () => {
  console.log('Shutting down...');
  for (const chatId of store.getAllChatIds()) {
    const session = store.get(chatId);
    if (session.activeProcess) {
      session.activeProcess.kill('SIGKILL');
    }
    outputStreamer.detach(chatId);
  }
  bot.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
