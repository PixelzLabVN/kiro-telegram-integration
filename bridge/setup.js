#!/usr/bin/env node
/**
 * Cross-platform setup script for Kiro-Telegram Bridge.
 * Auto-detects OS and configures shell aliases/functions.
 *
 * Supports: macOS (zsh/bash), Linux (bash/zsh/fish), Windows (PowerShell)
 *
 * Usage: node bridge/setup.js
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = join(__dirname, 'index.js');
const HOME = homedir();
const OS = platform(); // 'darwin', 'linux', 'win32'

// =============================================================================
// Kiro binary paths per OS
// =============================================================================

function getKiroBinary() {
  switch (OS) {
    case 'darwin':
      return '/Applications/Kiro.app/Contents/MacOS/Electron';
    case 'linux': {
      const paths = [
        '/usr/share/kiro/kiro',
        '/usr/bin/kiro',
        '/opt/Kiro/kiro',
        join(HOME, '.local/bin/kiro'),
      ];
      for (const p of paths) {
        if (existsSync(p)) return p;
      }
      try {
        return execSync('which kiro', { encoding: 'utf-8' }).trim();
      } catch {}
      return '/usr/bin/kiro';
    }
    case 'win32': {
      const paths = [
        join(process.env.LOCALAPPDATA || '', 'Programs', 'Kiro', 'Kiro.exe'),
        join(process.env.PROGRAMFILES || '', 'Kiro', 'Kiro.exe'),
        join(HOME, 'AppData', 'Local', 'Programs', 'Kiro', 'Kiro.exe'),
      ];
      for (const p of paths) {
        if (existsSync(p)) return p;
      }
      return paths[0];
    }
    default:
      return 'kiro';
  }
}

// =============================================================================
// Shell config per OS
// =============================================================================

function getShellConfig() {
  switch (OS) {
    case 'darwin': {
      const shell = process.env.SHELL || '/bin/zsh';
      if (shell.includes('zsh')) return { file: join(HOME, '.zshrc'), type: 'zsh' };
      return { file: join(HOME, '.bashrc'), type: 'bash' };
    }
    case 'linux': {
      const shell = process.env.SHELL || '/bin/bash';
      if (shell.includes('zsh')) return { file: join(HOME, '.zshrc'), type: 'zsh' };
      if (shell.includes('fish')) return { file: join(HOME, '.config', 'fish', 'config.fish'), type: 'fish' };
      return { file: join(HOME, '.bashrc'), type: 'bash' };
    }
    case 'win32': {
      const psProfile = join(HOME, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
      return { file: psProfile, type: 'powershell' };
    }
    default:
      return { file: join(HOME, '.bashrc'), type: 'bash' };
  }
}

// =============================================================================
// Generate shell entries
// =============================================================================

function generateEntries(shellType, kiroBinary, bridgePath) {
  const marker = '# Kiro-Telegram Bridge';

  switch (shellType) {
    case 'zsh':
    case 'bash':
      return [
        marker,
        `function kiro-cdp { local port=\${CDP_PORT:-9000}; "${kiroBinary}" --remote-debugging-port=\$port "\$@"; }`,
        `alias kiro-bridge="node ${bridgePath}"`,
      ].join('\n');

    case 'fish':
      return [
        marker,
        'function kiro-cdp',
        '  set -l port (set -q CDP_PORT; and echo $CDP_PORT; or echo 9000)',
        `  "${kiroBinary}" --remote-debugging-port=\$port \$argv`,
        'end',
        `alias kiro-bridge="node ${bridgePath}"`,
      ].join('\n');

    case 'powershell':
      return [
        marker,
        'function kiro-cdp {',
        '  $port = if ($env:CDP_PORT) { $env:CDP_PORT } else { "9000" }',
        `  & "${kiroBinary}" --remote-debugging-port=\$port @args`,
        '}',
        'function kiro-bridge {',
        `  node "${bridgePath}" @args`,
        '}',
      ].join('\n');

    default:
      return '';
  }
}

// =============================================================================
// Remove old entries
// =============================================================================

function removeOldEntries(content) {
  const lines = content.split('\n');
  const filtered = lines.filter((line) => {
    const lower = line.toLowerCase();
    return (
      !lower.includes('kiro-cdp') &&
      !lower.includes('kiro-bridge') &&
      !lower.includes('# kiro-telegram bridge')
    );
  });
  return filtered.join('\n');
}

// =============================================================================
// Ensure directory exists (for PowerShell profile)
// =============================================================================

function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
  }
}

// =============================================================================
// Main
// =============================================================================

function main() {
  console.log('');
  console.log('🔧 Kiro-Telegram Bridge Setup');
  console.log('═════════════════════════════');
  console.log(`  OS:     ${OS === 'darwin' ? 'macOS' : OS === 'win32' ? 'Windows' : 'Linux'}`);

  const kiroBinary = getKiroBinary();
  console.log(`  Kiro:   ${kiroBinary}`);
  console.log(`  Bridge: ${BRIDGE_PATH}`);

  const { file: shellFile, type: shellType } = getShellConfig();
  console.log(`  Shell:  ${shellType} → ${shellFile}`);
  console.log('');

  // Check if Kiro binary exists
  if (!existsSync(kiroBinary)) {
    console.log(`⚠️  Kiro not found at: ${kiroBinary}`);
    console.log(`   Update the path in your shell config after installation.`);
    console.log('');
  }

  // Ensure shell config directory exists
  const shellDir = dirname(shellFile);
  if (!existsSync(shellDir)) {
    const { mkdirSync } = require ? require('node:fs') : { mkdirSync: null };
    if (mkdirSync) mkdirSync(shellDir, { recursive: true });
  }

  // Read existing config
  let content = '';
  if (existsSync(shellFile)) {
    content = readFileSync(shellFile, 'utf-8');
  }

  // Remove old entries
  content = removeOldEntries(content);

  // Clean up extra blank lines
  content = content.replace(/\n{3,}/g, '\n\n').trimEnd();

  // Add new entries
  const entries = generateEntries(shellType, kiroBinary, BRIDGE_PATH);
  content += '\n\n' + entries + '\n';

  // Write back
  writeFileSync(shellFile, content, 'utf-8');

  console.log(`✅ Updated: ${shellFile}`);
  console.log('');

  // Post-setup instructions
  switch (shellType) {
    case 'zsh':
      console.log('Now run:  source ~/.zshrc');
      break;
    case 'bash':
      console.log('Now run:  source ~/.bashrc');
      break;
    case 'fish':
      console.log('Now run:  source ~/.config/fish/config.fish');
      break;
    case 'powershell':
      console.log('Now run:  . $PROFILE');
      break;
  }

  console.log('');
  console.log('Usage:');
  console.log('  kiro-cdp .              # Open Kiro with CDP on port 9000');
  console.log('  CDP_PORT=9001 kiro-cdp . # Open Kiro on port 9001');
  console.log('  kiro-bridge             # Start Telegram bridge');
  console.log('');
}

main();
