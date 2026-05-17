# 🚀 Quick Start — Kiro-Telegram Bridge

Control Kiro IDE remotely via Telegram. View real-time chat, send prompts, receive action buttons, open web UI from anywhere.

---

## Requirements

- **macOS**, **Linux**, or **Windows**
- [Node.js 18+](https://nodejs.org/)
- [Kiro IDE](https://kiro.dev)
- Telegram account

---

## Step 1: Clone source code

```bash
git clone https://github.com/PixelzLabVN/kiro-telegram-integration.git
cd kiro-telegram-integration
```

---

## Step 2: Create Telegram Bot

### 2.1 Create bot from BotFather

1. Open Telegram, search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Set bot name (e.g.: `Kiro Agent`)
4. Set username (e.g.: `my_kiro_agent_bot`)
5. BotFather will return a **Bot Token** — copy it

```
Use this token to access the HTTP API:
123456789:ABCdefGHIjklMNOpqrsTUVwxyz
```

### 2.2 Get Chat ID

1. Open Telegram, search for [@userinfobot](https://t.me/userinfobot)
2. Send `/start`
3. The bot will return your **Id** — that is your Chat ID

```
Id: 123456789
```

### 2.3 (Optional) Setup bot commands

Chat with @BotFather, send `/setcommands`, select your bot, paste:

```
status - View Kiro status
chat - View recent messages
send - Send message to Kiro
browser - Open web UI
browser_stop - Stop web UI
reconnect - Reconnect
stop - Stop bridge
help - View all commands
```

---

## Step 3: Configure .env

```bash
cp .env.example .env
```

Open `.env` and fill in the information:

```env
TELEGRAM_BOT_TOKEN=your-bot-token-here
TELEGRAM_CHAT_ID=your-chat-id-here
CDP_PORT=9000
BRIDGE_POLL_INTERVAL=2000
```

---

## Step 4: Install dependencies

```bash
cd bridge
npm install
```

---

## Step 5: Setup shell commands (only needed once)

```bash
node setup.js
```

The script auto-detects OS and shell, adds 2 commands:
- `kiro-cdp` — open Kiro with Chrome DevTools Protocol enabled
- `kiro-bridge` — run Telegram bridge

| OS | Shell | Config file |
|----|-------|-------------|
| macOS | zsh | `~/.zshrc` |
| macOS | bash | `~/.bashrc` |
| Linux | bash | `~/.bashrc` |
| Linux | zsh | `~/.zshrc` |
| Linux | fish | `~/.config/fish/config.fish` |
| Windows | PowerShell | `$PROFILE` |

Reload shell after setup:

```bash
# macOS/Linux
source ~/.zshrc   # or ~/.bashrc

# Windows PowerShell
. $PROFILE
```

---

## Step 6: Install Cloudflare Tunnel (optional)

Allows `/browser` to create a public URL — access web UI from 4G, other WiFi, anywhere.

```bash
# macOS
brew install cloudflared

# Linux (amd64)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

# Windows
winget install Cloudflare.cloudflared
```

No account needed, no config needed. The bridge automatically runs the tunnel when you type `/browser`.

---

## Step 7: Start

### 7.1 Close current Kiro

- macOS: `Cmd+Q`
- Windows: `Alt+F4`
- Linux: Close window

### 7.2 Open Kiro with CDP

```bash
kiro-cdp .
# or open a specific project
kiro-cdp /path/to/your/project
```

### 7.3 Verify CDP is running

Wait for Kiro to finish opening (~5 seconds):

```bash
curl http://127.0.0.1:9000/json
```

✅ See JSON → continue
❌ `Connection refused` → wait longer or check step 7.2

### 7.4 Open chat panel in Kiro

**Important:** Click on the **Kiro Agent icon** in the sidebar to open the chat panel.

Verify:
```bash
curl -s http://127.0.0.1:9000/json | grep -c kiroAgent
```
Output must be ≥ 1.

### 7.5 Run bridge

```bash
kiro-bridge
```

Result:
```
🌉 Kiro-Telegram Bridge
═══════════════════════
CDP Port: 9000
Poll Interval: 2000ms

[Bridge] Discovering Kiro IDE on ports: 9000, 9001, 9002, 9003, 9222...
[CDP] Port 9000: 5 targets found
[CDP] Found kiroAgent: type=iframe port=9000
[Bridge] Connected to Kiro via CDP
[Telegram] Bot polling started
```

🎉 **Done!** Open Telegram and chat with the bot.

---

## Using from Telegram

| Command | Description |
|---------|-------------|
| `/status` | View whether Kiro is working or idle |
| `/chat` | View recent messages |
| `/send <msg>` | Send message to Kiro agent |
| `/browser` | Open web UI + public URL (Cloudflare Tunnel) |
| `/browser_stop` | Stop web UI + tunnel |
| `/reconnect` | Reconnect |
| `/stop` | Stop bridge |
| `/help` | View all commands |

**Type directly** (without `/`) → automatically sent to Kiro chat.

**Inline buttons** — When Kiro needs an action (trust, cancel, continue), Telegram shows buttons for you to tap.

---

## Quick launch (after initial setup)

```bash
# Terminal 1
kiro-cdp .

# Terminal 2
kiro-bridge
```

Open Telegram → chat with bot → control Kiro remotely 📱

---

## Multiple projects simultaneously

```bash
# Project A (port 9000 — default)
kiro-cdp /project-a

# Project B (port 9001)
CDP_PORT=9001 kiro-cdp /project-b

# Bridge for project B
CDP_PORT=9001 kiro-bridge
```

> ⚠️ Each bridge instance needs a **separate bot token** if running in parallel. Or only run 1 bridge at a time.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `Kiro not found` | Open with `kiro-cdp`, not regular `kiro` |
| `Connection refused` | Quit Kiro completely then reopen with `kiro-cdp` |
| `Chat input not found` | Open chat panel in Kiro (click Kiro Agent icon) |
| `Promise was collected` | Normal — message was sent successfully |
| Bridge doesn't see updates | Chat panel must be visible in Kiro |
| Telegram not receiving messages | Check bot token and chat ID in `.env` |
| `/browser` LAN only | Install `cloudflared` for public URL |
| `Conflict: terminated by other getUpdates` | Kill old bridge: `pkill -f "bridge/index.js"` |
| zshrc parse error | Run `node bridge/setup.js` again |

---

## Important notes

- **Only run 1 bridge instance** at a time (with the same bot token). "Conflict" error = 2 instances running.
- **Chat panel must be open** in Kiro — bridge only detects when panel is visible.
- CDP port must match between `kiro-cdp` and `kiro-bridge` (use `CDP_PORT` env var).
- `/browser` auto-creates a Cloudflare Tunnel — URL changes on each restart.

---

## Author

**@itmanz** — [PixelzLab](https://pixelz-lab.com)

Built with ❤️ for the Kiro community.
