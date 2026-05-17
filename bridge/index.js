#!/usr/bin/env node
/**
 * Kiro-Telegram Bridge
 *
 * Bidirectional bridge between Kiro IDE and Telegram.
 * - Monitors Kiro's chat/task status via Chrome DevTools Protocol (CDP)
 * - Forwards updates to Telegram in real-time
 * - Receives messages from Telegram and injects them into Kiro's chat
 *
 * Prerequisites:
 *   1. Start Kiro with: kiro --remote-debugging-port=9000
 *   2. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env
 *
 * Usage:
 *   node bridge/index.js
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { discoverKiro, createCDPConnection, captureChat, captureStatus, injectMessage, detectActionButtons, clickButton } from './cdp.js';
import { createTelegramBot } from './telegram.js';
import { createSnapshotTracker, formatStatusChange, formatChatUpdate } from './snapshot.js';
import { format, bold, code, italic, pre } from '@gramio/format';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// =============================================================================
// Configuration
// =============================================================================

// Load .env
try {
  const envContent = readFileSync(join(PROJECT_ROOT, '.env'), 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^(\w+)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
} catch { /* no .env file */ }

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CDP_PORT = parseInt(process.env.CDP_PORT || '9000', 10);
const POLL_INTERVAL = parseInt(process.env.BRIDGE_POLL_INTERVAL || '2000', 10);

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in environment');
  console.error('Set them in .env file or as environment variables');
  process.exit(1);
}

// =============================================================================
// State
// =============================================================================

let cdpConnection = null;
let isConnected = false;
let pollTimer = null;
let lastActionHash = '';

const tracker = createSnapshotTracker();
const bot = createTelegramBot(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID);

// =============================================================================
// CDP Discovery & Connection
// =============================================================================

async function connectToKiro() {
  if (isConnected) return true;

  const portsToScan = [CDP_PORT, CDP_PORT + 1, CDP_PORT + 2, CDP_PORT + 3, 9000, 9001, 9222];
  const uniquePorts = [...new Set(portsToScan)];
  console.log(`[Bridge] Discovering Kiro IDE on ports: ${uniquePorts.join(', ')}...`);
  const targets = await discoverKiro(uniquePorts);

  console.log(`[Bridge] Found: ${targets.webviews.length} webviews, mainWindow: ${targets.mainWindow ? 'yes' : 'no'}`);
  if (targets.webviews.length > 0) {
    targets.webviews.forEach((w, i) => console.log(`[Bridge]   webview[${i}]: port=${w.port} title=${w.title?.substring(0, 50)}`));
  }

  if (targets.webviews.length === 0) {
    return false;
  }

  const target = targets.webviews[0];
  console.log(`[Bridge] Connecting to: ${target.title} (port ${target.port})`);

  try {
    cdpConnection = await createCDPConnection(target.wsUrl);
    isConnected = true;

    cdpConnection.ws.on('close', () => {
      console.log('[Bridge] CDP connection lost');
      isConnected = false;
      cdpConnection = null;
      tracker.reset();
      bot.sendMessage('🔌 Connection lost. Reconnecting...').catch(() => {});
    });

    console.log('[Bridge] Connected to Kiro via CDP');
    await bot.sendMessage(
      '✅ *Connected to Kiro IDE*\n\n' +
      'Commands: /help\n' +
      'Or type directly to send to Kiro.'
    );

    return true;
  } catch (err) {
    console.error('[Bridge] Connection failed:', err.message);
    return false;
  }
}

// =============================================================================
// Snapshot Polling
// =============================================================================

async function pollKiro() {
  if (!isConnected || !cdpConnection) {
    const connected = await connectToKiro();
    if (!connected) return;
  }

  try {
    const [chatData, statusData] = await Promise.all([
      captureChat(cdpConnection).catch(() => null),
      captureStatus(cdpConnection).catch(() => null),
    ]);

    const diff = tracker.diff(chatData, statusData);

    if (diff.statusChanged) {
      const msg = formatStatusChange(diff.status, diff.previousStatus);
      await bot.sendMessage(msg).catch((err) => {
        console.error('[Bridge] Failed to send status update:', err.message);
      });
    }

    if (diff.changed && diff.newContent) {
      const msg = formatChatUpdate(diff.newContent);
      if (msg) {
        await bot.sendMessage(msg).catch((err) => {
          console.error('[Bridge] Failed to send chat update:', err.message);
        });
      }
    }

    const actions = await detectActionButtons(cdpConnection).catch(() => null);
    if (actions?.hasActions) {
      const actionHash = actions.buttons.map((b) => b.label).join('|');
      if (actionHash !== lastActionHash) {
        lastActionHash = actionHash;
        const buttonActions = actions.buttons.map((b) => ({
          label: b.label,
          action: b.label.toLowerCase().replace(/\s+/g, '_'),
        }));
        const prompt = actions.dialogText
          ? actions.dialogText.substring(0, 150)
          : 'Kiro needs your input';
        await bot.sendActionPrompt(prompt, buttonActions).catch((err) => {
          console.error('[Bridge] Failed to send action prompt:', err.message);
        });
      }
    } else {
      lastActionHash = '';
    }
  } catch (err) {
    if (err.message?.includes('WebSocket closed') || err.message?.includes('not open')) {
      isConnected = false;
      cdpConnection = null;
    } else {
      console.error('[Bridge] Poll error:', err.message);
    }
  }
}

// =============================================================================
// Telegram Command Handlers
// =============================================================================

bot.onCommand('/start', async () => {
  await bot.sendFormatted(format`🤖 ${bold`Kiro-Telegram Bridge`}

Control your Kiro IDE remotely.

${code`/status`}  — Kiro status
${code`/send`}    — Send message
${code`/chat`}    — Recent messages
${code`/browser`} — Web UI + tunnel
${code`/help`}    — All commands

${italic`Type directly to send to Kiro`}`);
});

bot.onCommand('/help', async () => {
  await bot.sendFormatted(format`📖 ${bold`Commands`}

${code`/status`}       — Kiro status (working/idle)
${code`/send <msg>`}   — Send to Kiro agent
${code`/chat`}         — Last chat messages
${code`/browser`}      — Web UI + Cloudflare Tunnel
${code`/browser_stop`} — Stop web UI
${code`/reconnect`}    — Force reconnect
${code`/stop`}         — Stop bridge

${italic`Any text without / is sent directly to Kiro`}`);
});

bot.onCommand('/status', async () => {
  if (!isConnected) {
    await bot.sendFormatted(format`🔌 Not connected

${code`CDP_PORT=${CDP_PORT}`}
Use /reconnect`);
    return;
  }

  try {
    const status = await captureStatus(cdpConnection);
    const icon = status.status === 'working' ? '⚙️' : '💤';
    await bot.sendFormatted(format`${icon} ${bold`Kiro Status`}

${pre`Status: ${status.status}
Title:  ${status.title || 'N/A'}
Port:   ${CDP_PORT}
Time:   ${new Date().toLocaleTimeString()}`}`);
  } catch (err) {
    await bot.sendFormatted(format`❌ Error: ${code`${err.message}`}`);
  }
});

bot.onCommand('/chat', async () => {
  if (!isConnected) {
    await bot.sendMessage('🔌 Not connected to Kiro.');
    return;
  }

  try {
    const chatData = await captureChat(cdpConnection);
    if (chatData.messages && chatData.messages.length > 0) {
      const recent = chatData.messages.slice(-5);
      const formatted = recent
        .map((m) => `[${m.role}]\n${m.content.substring(0, 400)}`)
        .join('\n\n');
      await bot.sendFormatted(format`💬 ${bold`Recent Chat`}

${pre`${formatted}`}`);
    } else if (chatData.raw) {
      await bot.sendFormatted(format`💬 ${bold`Chat`}

${pre`${chatData.raw.substring(0, 3000)}`}`);
    } else {
      await bot.sendMessage('💬 No chat content available.');
    }
  } catch (err) {
    await bot.sendFormatted(format`❌ Error: ${code`${err.message}`}`);
  }
});

bot.onCommand('/send', async (text) => {
  if (!text) {
    await bot.sendMessage('Usage: `/send <your message>`');
    return;
  }
  await sendToKiro(text);
});

bot.onCommand('/reconnect', async () => {
  isConnected = false;
  cdpConnection?.close();
  cdpConnection = null;
  tracker.reset();
  await bot.sendMessage('🔄 Reconnecting...');
  const connected = await connectToKiro();
  if (!connected) {
    await bot.sendMessage(`❌ Kiro not found.\n\nMake sure it's running:\n\`kiro-cdp . --remote-debugging-port=${CDP_PORT}\``);
  }
});

bot.onCommand('/stop', async () => {
  await bot.sendMessage('👋 Bridge stopped.');
  cleanup();
  process.exit(0);
});

// =============================================================================
// /browser - Web UI + Cloudflare Tunnel
// =============================================================================

let browserProcess = null;
let tunnelProcess = null;
let tunnelUrl = null;

bot.onCommand('/browser', async () => {
  if (browserProcess && tunnelUrl) {
    await bot.sendFormatted(format`🌐 ${bold`Web UI Running`}

🌍 ${tunnelUrl}
LAN: ${code`http://localhost:3000`}

${italic`/browser_stop to close`}`);
    return;
  }

  if (browserProcess) { browserProcess.kill(); browserProcess = null; }
  if (tunnelProcess) { tunnelProcess.kill(); tunnelProcess = null; }
  tunnelUrl = null;

  await bot.sendMessage('🚀 Starting web UI...');

  try {
    const webReady = await startWebUI();
    if (!webReady) {
      await bot.sendMessage('❌ Web UI failed.\n\nTry: `npx kiro-mobile-bridge --no-auth`');
      return;
    }

    await bot.sendMessage('✅ Web UI ready\n⏳ Starting tunnel...');

    const url = await startTunnelAndWait();
    if (!url) {
      await bot.sendFormatted(format`⚠️ Tunnel failed

LAN only: ${code`http://localhost:3000`}

Try manually:
${code`cloudflared tunnel --url http://localhost:3000`}`);
      return;
    }

    await bot.sendMessage('✅ Tunnel active\n⏳ Waiting for DNS...');
    await new Promise(r => setTimeout(r, 5000));

    await bot.sendFormatted(format`🌐 ${bold`Web UI Ready`}

🌍 ${tunnelUrl}

${code`Chat`} · ${code`Code`} · ${code`Tasks`}

${italic`Access from anywhere`}
${italic`/browser_stop to close`}`);

  } catch (err) {
    await bot.sendMessage(`❌ Error: \`${err.message}\``);
  }
});

function startWebUI() {
  return new Promise((resolve) => {
    browserProcess = spawn('npx', ['kiro-mobile-bridge', '--no-auth'], {
      stdio: 'pipe',
      detached: false,
      env: { ...process.env, CDP_PORT: String(CDP_PORT) },
    });

    let output = '';
    const timeout = setTimeout(() => resolve(false), 30000);

    browserProcess.stdout.on('data', (data) => {
      output += data.toString();
      if (output.includes('Network:') || output.includes('Local:')) {
        clearTimeout(timeout);
        resolve(true);
      }
    });

    browserProcess.stderr.on('data', (data) => {
      const err = data.toString();
      if (err.includes('ERR') || err.includes('Error')) {
        console.error('[Browser]', err);
      }
    });

    browserProcess.on('close', () => {
      clearTimeout(timeout);
      browserProcess = null;
      resolve(false);
    });

    browserProcess.on('error', (err) => {
      clearTimeout(timeout);
      browserProcess = null;
      console.error('[Browser] Spawn error:', err.message);
      resolve(false);
    });
  });
}

function startTunnelAndWait() {
  return new Promise((resolve) => {
    tunnelProcess = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:3000'], {
      stdio: 'pipe',
      detached: false,
    });

    let tunnelOutput = '';
    const timeout = setTimeout(() => {
      console.log('[Tunnel] Timeout waiting for URL');
      resolve(null);
    }, 20000);

    tunnelProcess.stderr.on('data', (data) => {
      tunnelOutput += data.toString();
      if (!tunnelUrl) {
        const match = tunnelOutput.match(/https:\/\/[a-z0-9][-a-z0-9]*\.trycloudflare\.com/);
        if (match) {
          tunnelUrl = match[0];
          clearTimeout(timeout);
          console.log(`[Tunnel] URL detected: ${tunnelUrl}`);
          setTimeout(() => resolve(tunnelUrl), 2000);
        }
      }
    });

    tunnelProcess.on('close', () => {
      clearTimeout(timeout);
      tunnelProcess = null;
      tunnelUrl = null;
      resolve(null);
    });

    tunnelProcess.on('error', (err) => {
      clearTimeout(timeout);
      tunnelProcess = null;
      console.error('[Tunnel] Error:', err.message);
      resolve(null);
    });
  });
}

function stopTunnel() {
  if (tunnelProcess) {
    tunnelProcess.kill();
    tunnelProcess = null;
    tunnelUrl = null;
  }
}

bot.onCommand('/browser-stop', async () => {
  if (!browserProcess && !tunnelProcess) {
    await bot.sendMessage('ℹ️ Web UI is not running.');
    return;
  }
  if (browserProcess) { browserProcess.kill(); browserProcess = null; }
  stopTunnel();
  await bot.sendMessage('🛑 Web UI + Tunnel stopped.');
});

bot.onCommand('/browser_stop', async () => {
  if (!browserProcess && !tunnelProcess) {
    await bot.sendMessage('ℹ️ Web UI is not running.');
    return;
  }
  if (browserProcess) { browserProcess.kill(); browserProcess = null; }
  stopTunnel();
  await bot.sendMessage('🛑 Web UI + Tunnel stopped.');
});

// =============================================================================
// Message handling
// =============================================================================

bot.onMessage(async (text) => {
  await sendToKiro(text);
});

bot.onCallback(async (action, callbackQuery) => {
  if (!isConnected) {
    await bot.editMessage(callbackQuery.message.message_id, '❌ Not connected to Kiro').catch(() => {});
    return;
  }

  try {
    const buttonLabel = action.replace(/_/g, ' ');
    const result = await clickButton(cdpConnection, buttonLabel);

    if (result?.success) {
      await bot.editMessage(
        callbackQuery.message.message_id,
        `✅ Clicked: *${result.clicked}*`
      ).catch(() => {});
      lastActionHash = '';
    } else {
      await bot.editMessage(
        callbackQuery.message.message_id,
        `⚠️ Failed: \`${result?.error || 'Button not found'}\``
      ).catch(() => {});
    }
  } catch (err) {
    await bot.editMessage(
      callbackQuery.message.message_id,
      `❌ Error: \`${err.message}\``
    ).catch(() => {});
  }
});

async function sendToKiro(text) {
  if (!isConnected) {
    await bot.sendMessage('🔌 Not connected. Use /reconnect');
    return;
  }

  try {
    const result = await injectMessage(cdpConnection, text);
    if (result?.success) {
      const preview = text.length > 60 ? text.substring(0, 60) + '...' : text;
      await bot.sendFormatted(format`✅ Sent → ${code`${preview}`}`);
    } else {
      await bot.sendFormatted(format`⚠️ Failed: ${code`${result?.error || 'Unknown'}`}

${italic`Make sure chat panel is open in Kiro`}`);
    }
  } catch (err) {
    await bot.sendFormatted(format`❌ ${code`${err.message}`}`);
  }
}

// =============================================================================
// Lifecycle
// =============================================================================

function cleanup() {
  if (pollTimer) clearInterval(pollTimer);
  if (browserProcess) browserProcess.kill();
  if (tunnelProcess) tunnelProcess.kill();
  bot.stopPolling();
  cdpConnection?.close();
}

process.on('SIGINT', () => {
  console.log('\n[Bridge] Shutting down...');
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log('');
  console.log('🌉 Kiro-Telegram Bridge');
  console.log('═══════════════════════');
  console.log(`CDP Port: ${CDP_PORT}`);
  console.log(`Poll Interval: ${POLL_INTERVAL}ms`);
  console.log('');

  const connected = await connectToKiro();
  if (!connected) {
    console.log('[Bridge] Kiro not found. Will keep trying...');
    await bot.sendMessage(
      '⏳ Kiro not detected\n\n' +
      `Scanning port: \`${CDP_PORT}\`\n\n` +
      'Make sure Kiro is running:\n' +
      `\`kiro-cdp .\`\n\n` +
      '_Will keep trying..._'
    );
  }

  pollTimer = setInterval(pollKiro, POLL_INTERVAL);
  await bot.startPolling();
}

main().catch((err) => {
  console.error('[Bridge] Fatal error:', err);
  process.exit(1);
});
