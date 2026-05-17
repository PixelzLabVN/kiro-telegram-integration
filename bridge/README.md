# Kiro-Telegram Bridge

Bidirectional bridge between Kiro IDE and Telegram via Chrome DevTools Protocol (CDP).

Monitor Kiro's real-time status and send commands directly from Telegram — like having Kiro IDE in your pocket.

## Architecture

```
┌─────────────────┐     CDP/WS     ┌─────────────────┐   Telegram API   ┌──────────────┐
│   Kiro IDE      │◄──────────────►│  Bridge Server  │◄────────────────►│  Your Phone  │
│ (port 9000)     │                │  (Node.js)      │                  │  (Telegram)  │
└─────────────────┘                └─────────────────┘                  └──────────────┘
```

## Features

- 📱 **Real-time monitoring** — Chat updates forwarded to Telegram as they happen
- 💬 **Send messages** — Type in Telegram, message appears in Kiro's chat
- ⚙️ **Status tracking** — Know when Kiro is working or idle
- 🔄 **Auto-reconnect** — Handles disconnections gracefully
- 🎯 **Zero config UI** — No web interface needed, just Telegram

## Quick Start

### 1. Start Kiro with CDP enabled

```bash
kiro --remote-debugging-port=9000
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your Telegram credentials:

```bash
TELEGRAM_BOT_TOKEN=your-bot-token-here
TELEGRAM_CHAT_ID=your-chat-id-here
CDP_PORT=9000
```

### 3. Run the bridge

```bash
cd bridge
npm install
npm start
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/status` | Get Kiro's current status (working/idle) |
| `/chat` | Get recent chat messages |
| `/send <msg>` | Send a message to Kiro agent |
| `/reconnect` | Force reconnect to Kiro |
| `/stop` | Stop the bridge |
| `/help` | Show all commands |

**Direct messages** (without `/` prefix) are sent directly to Kiro as prompts.

## How It Works

1. **Discovery** — Scans CDP ports (9000-9003, 9222) for Kiro webview targets
2. **Connection** — Connects to Kiro Agent webview via CDP WebSocket
3. **Polling** — Captures chat/status snapshots every 2s (configurable)
4. **Diffing** — Only sends Telegram notifications when content changes
5. **Injection** — Injects messages into Kiro's chat input via DOM manipulation

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | (required) | Your Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | (required) | Your Telegram chat ID |
| `CDP_PORT` | `9000` | Primary CDP port to scan |
| `BRIDGE_POLL_INTERVAL` | `2000` | Snapshot polling interval in ms |

## Troubleshooting

### Bridge can't find Kiro
- Make sure Kiro is running with `--remote-debugging-port=9000`
- Check that a chat/agent session is open in Kiro
- Try `/reconnect` in Telegram

### Messages not being injected
- The chat input selector may have changed — check bridge logs
- Ensure Kiro's chat panel is visible/active

### No updates in Telegram
- Check bot token and chat ID are correct
- Verify the bot has permission to send messages to your chat
- Check bridge console for errors

---

## Author

**@itmanz** — [PixelzLab](https://pixelz-lab.com)

Built with ❤️ for the Kiro community.
