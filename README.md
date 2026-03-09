# Telegram Bridge

Control Claude Code CLI and OpenAI Codex CLI on your laptop remotely from Telegram. The bot streams all intermediate output (thinking, tool use, file edits, shell commands) in real time — not just the final response.

## Prerequisites

- Node.js 20+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- [Codex CLI](https://github.com/openai/codex) installed and authenticated (optional, for Codex models)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Xcode Command Line Tools (macOS) — needed for `node-pty` native compilation

## Setup

```bash
git clone <repo-url> telegram-bridge
cd telegram-bridge
npm install
cp .env.example .env
# Edit .env with your values
npm start
```

### Configuration (.env)

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather |
| `ALLOWED_USER_IDS` | Comma-separated Telegram user IDs (whitelist) |
| `BASE_PATH` | Root directory for project selection (default: `/Users/tianyi/Documents/Zheng/Code`) |
| `DEFAULT_CLI` | Default CLI tool: `claude` or `codex` |
| `DEFAULT_MODEL` | Default model ID (e.g., `claude-opus-4-6`) |

To find your Telegram user ID, message [@userinfobot](https://t.me/userinfobot).

## Commands

| Command | Description |
|---------|-------------|
| `/ls` | List subdirectories as tap-able buttons |
| `/cd <folder>` | Set working directory (relative or absolute path) |
| `/pwd` | Show current working directory |
| `/new <name>` | Create a new project folder and cd into it |
| `/model` | Select CLI + model from an inline keyboard |
| `/status` | Show current directory, model, and process state |
| `/stop` | Send SIGINT (Ctrl+C) to the running process |
| `/kill` | Force-terminate the running process (SIGKILL) |
| `/y` | Send "y" to the CLI (for confirmation prompts) |
| `/n` | Send "n" to the CLI |
| `/stdin <text>` | Send arbitrary text to the process stdin |

Any regular text message is treated as a prompt and sent to the active CLI.

## Adding or Removing Models

Edit the `AVAILABLE_MODELS` array in `src/config.ts`:

```typescript
export const AVAILABLE_MODELS: ModelConfig[] = [
  { label: 'Claude Opus 4.6', cli: 'claude', model: 'claude-opus-4-6', group: 'Claude Code' },
  { label: 'Claude Sonnet 4.5', cli: 'claude', model: 'claude-sonnet-4-5', group: 'Claude Code' },
  { label: 'GPT-5.4', cli: 'codex', model: 'gpt-5.4', group: 'Codex' },
  // Add new models here:
  { label: 'My Model', cli: 'codex', model: 'my-model-id', group: 'Codex' },
];
```

- `label`: Display name shown in the Telegram keyboard
- `cli`: Which CLI to use (`claude` or `codex`)
- `model`: Model ID passed to the CLI via `--model`
- `group`: Grouping label in the model selection menu

## Running as a Background Service

### Using pm2

```bash
npm install -g pm2
pm2 start npm --name telegram-bridge -- start
pm2 save
pm2 startup  # auto-start on boot
```

### Using tmux

```bash
tmux new -s bridge
npm start
# Ctrl+B, D to detach
# tmux attach -t bridge to reattach
```

### Using systemd (Linux)

Create `/etc/systemd/system/telegram-bridge.service`:

```ini
[Unit]
Description=Telegram Bridge
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/telegram-bridge
ExecStart=/usr/bin/npm start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable telegram-bridge
sudo systemctl start telegram-bridge
```

## Development

```bash
npm run dev  # watch mode with tsx
```
