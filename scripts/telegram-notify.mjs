#!/usr/bin/env node
/**
 * Standalone Telegram notification script for Kiro hooks.
 *
 * Sends a formatted notification to Telegram. Reads stdin for tool details.
 * Does not block execution — always exits with code 0.
 *
 * Usage: echo '{"command":"ls -la"}' | node scripts/telegram-notify.mjs "Shell Command"
 *        echo '{"path":"src/index.ts"}' | node scripts/telegram-notify.mjs "File Write"
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// Load env vars, falling back to .env file
if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
  try {
    const envContent = readFileSync(join(PROJECT_ROOT, '.env'), 'utf-8');
    for (const line of envContent.split('\n')) {
      const match = line.match(/^(\w+)=(.*)$/);
      if (match) process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env file */ }
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = process.env.TELEGRAM_CHAT_ID;

if (!token || !chat) {
  // Silently exit — don't block execution if not configured
  process.exit(0);
}

const actionType = process.argv[2] || 'Action';
const emoji = actionType.includes('Shell') ? '🔧' : '📝';
const API = `https://api.telegram.org/bot${token}`;

// Read stdin (non-blocking with timeout)
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

// Extract details from stdin JSON
let command = '';
let files = '';
let summary = '';
try {
  const parsed = JSON.parse(stdinData);
  if (parsed.command) command = parsed.command;
  if (parsed.path) files = parsed.path;
  if (parsed.summary) summary = parsed.summary;
  if (parsed.files) files = Array.isArray(parsed.files) ? parsed.files.join(', ') : parsed.files;
} catch {
  if (stdinData.trim()) summary = stdinData.trim();
}

// Build notification message
let message = `${emoji} Pending Action\n\nType: ${actionType}`;
if (summary) message += `\nSummary: ${summary}`;
if (command) message += `\nCommand: ${command}`;
if (files) message += `\nFiles: ${files}`;

// Send notification
try {
  await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: message }),
  });
} catch { /* best-effort — don't block */ }

process.exit(0);
