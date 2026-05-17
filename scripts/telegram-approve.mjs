#!/usr/bin/env node
/**
 * Standalone Telegram approval script for Kiro hooks.
 *
 * Reads the intercepted tool input from stdin to show what's being approved.
 * Sends a confirmation message with Approve/Cancel buttons to Telegram.
 * Communicates with the MCP server via signal files in .telegram-signals/.
 *
 * Exits with code 0 (approved) or 1 (denied/timeout/error).
 *
 * Usage: echo "tool input" | node scripts/telegram-approve.mjs "action type"
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const SIGNALS_DIR = join(PROJECT_ROOT, '.telegram-signals');

// Load env vars, falling back to .env file
if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
  try {
    const envContent = readFileSync(join(PROJECT_ROOT, '.env'), 'utf-8');
    for (const line of envContent.split('\n')) {
      const match = line.match(/^(\w+)=(.*)$/);
      if (match) process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // No .env file
  }
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = process.env.TELEGRAM_CHAT_ID;

if (!token || !chat) {
  console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set');
  process.exit(1);
}

const actionType = process.argv[2] || 'Action';
const API = `https://api.telegram.org/bot${token}`;
const requestId = crypto.randomUUID();
const TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL = 500;

function escapeMarkdownV2(text) {
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

// Read stdin to get the intercepted tool input (non-blocking with timeout)
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => {
      process.stdin.pause();
      resolve(data);
    }, 200);
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.resume();
  });
}

const stdinData = await readStdin();

// Try to extract the command from stdin (hook passes tool input as JSON)
let commandDetail = '';
try {
  const parsed = JSON.parse(stdinData);
  if (parsed.command) commandDetail = parsed.command;
  else if (parsed.text) commandDetail = parsed.text;
  else if (typeof parsed === 'string') commandDetail = parsed;
} catch {
  if (stdinData.trim()) commandDetail = stdinData.trim();
}

// Build the summary line
const summary = commandDetail
  ? `${actionType}: \`${commandDetail}\``
  : actionType;

// Ensure signals directory exists
if (!existsSync(SIGNALS_DIR)) {
  mkdirSync(SIGNALS_DIR, { recursive: true });
}

const signalFile = join(SIGNALS_DIR, `${requestId}.json`);

// Write pending signal file with summary for post-approval display
writeFileSync(signalFile, JSON.stringify({ requestId, status: 'pending', messageId: null, summary }));

// Send confirmation message
const text =
  `🔔 *Action Required*\n\n` +
  `*${escapeMarkdownV2(actionType)}*\n` +
  (commandDetail ? `\`\`\`\n${escapeMarkdownV2(commandDetail)}\n\`\`\`\n\n` : '\n') +
  `_Reply within 10 minutes or this request will expire\\._`;

const sendRes = await fetch(`${API}/sendMessage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    chat_id: chat,
    text,
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `${requestId}:approve` },
        { text: '❌ Cancel', callback_data: `${requestId}:cancel` },
      ]],
    },
  }),
});

const sendData = await sendRes.json();
if (!sendData.ok) {
  console.error('Failed to send message:', sendData.description);
  cleanup();
  process.exit(1);
}

const messageId = sendData.result.message_id;

// Update signal file with messageId
writeFileSync(signalFile, JSON.stringify({ requestId, status: 'pending', messageId, summary }));

// Poll the signal file for a result written by the MCP server's ResponseRouter
const deadline = Date.now() + TIMEOUT_MS;

while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, POLL_INTERVAL));

  try {
    if (!existsSync(signalFile)) {
      console.log('Cancelled');
      process.exit(1);
    }

    const content = JSON.parse(readFileSync(signalFile, 'utf-8'));

    if (content.status === 'approved') {
      console.log('Approved');
      cleanup();
      process.exit(0);
    } else if (content.status === 'cancelled') {
      console.log('Cancelled');
      cleanup();
      process.exit(1);
    }
  } catch {
    // File read error — retry
  }
}

// Timeout — edit message and clean up
await fetch(`${API}/editMessageText`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    chat_id: chat,
    message_id: messageId,
    text: `⏰ Expired\n\n${summary}`,
    reply_markup: { inline_keyboard: [] },
  }),
}).catch(() => {});

console.log('Timed out');
cleanup();
process.exit(1);

function cleanup() {
  try { unlinkSync(signalFile); } catch { /* ignore */ }
}
