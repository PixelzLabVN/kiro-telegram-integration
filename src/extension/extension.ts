import * as vscode from 'vscode';
import { fromRecord, validateConfig } from '../core/ConfigManager.js';
import { IntegrationService } from '../core/IntegrationService.js';
import { registerCommands } from './commands.js';
import { createStatusBar, updateStatusBar } from './statusBar.js';

let service: IntegrationService | undefined;

/**
 * Returns the current IntegrationService instance, if initialized.
 *
 * Used by commands.ts and statusBar.ts to access the running service.
 *
 * @returns The active IntegrationService or undefined if not initialized.
 */
export function getService(): IntegrationService | undefined {
  return service;
}

/**
 * Activate the Kiro Telegram extension.
 *
 * Reads bot configuration from VS Code settings, validates it, and initializes
 * the IntegrationService. Shows a warning notification with a link to settings
 * if the configuration is missing or invalid.
 *
 * @param _context - The VS Code extension context.
 */
export async function activate(_context: vscode.ExtensionContext): Promise<void> {
  registerCommands(_context);
  createStatusBar(_context);

  const config = vscode.workspace.getConfiguration('kiroTelegram');
  const botToken = config.get<string>('botToken', '');
  const chatId = config.get<string>('chatId', '');
  const timeoutMinutes = config.get<number>('timeoutMinutes', 10);

  const telegramConfig = fromRecord({
    botToken,
    chatId,
    timeoutMs: String(timeoutMinutes * 60_000),
  });

  const validation = validateConfig(telegramConfig);
  if (!validation.valid) {
    const action = await vscode.window.showWarningMessage(
      `Kiro Telegram: ${validation.errors.join('; ')}`,
      'Open Settings',
    );
    if (action === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'kiroTelegram');
    }
    return;
  }

  service = new IntegrationService();
  try {
    await service.initialize(telegramConfig);
    updateStatusBar();
  } catch (err) {
    vscode.window.showErrorMessage(
      `Kiro Telegram: Failed to initialize — ${err instanceof Error ? err.message : String(err)}`,
    );
    service = undefined;
  }
}

/**
 * Deactivate the Kiro Telegram extension.
 *
 * Shuts down the IntegrationService, stopping polling and resolving
 * all pending requests as timed out.
 */
export async function deactivate(): Promise<void> {
  if (service) {
    await service.shutdown();
    service = undefined;
  }
}
