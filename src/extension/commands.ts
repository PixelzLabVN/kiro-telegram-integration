import * as vscode from 'vscode';
import { getService } from './extension.js';
import { fromRecord, verifyConnectivity } from '../core/ConfigManager.js';

/**
 * Register all Kiro Telegram VS Code commands.
 *
 * Registers three commands:
 * - `kiroTelegram.configure` — Opens VS Code settings filtered to kiroTelegram.
 * - `kiroTelegram.testConnection` — Verifies connectivity to the Telegram Bot API.
 * - `kiroTelegram.status` — Shows the current connection status as a notification.
 *
 * @param context - The VS Code extension context used to manage command subscriptions.
 */
export function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('kiroTelegram.configure', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'kiroTelegram');
    }),

    vscode.commands.registerCommand('kiroTelegram.testConnection', async () => {
      const config = vscode.workspace.getConfiguration('kiroTelegram');
      const telegramConfig = fromRecord({
        botToken: config.get<string>('botToken', ''),
        chatId: config.get<string>('chatId', ''),
      });
      const result = await verifyConnectivity(telegramConfig);
      if (result.connected) {
        vscode.window.showInformationMessage(`Kiro Telegram: Connected as @${result.botUsername}`);
      } else {
        vscode.window.showErrorMessage(`Kiro Telegram: ${result.error}`);
      }
    }),

    vscode.commands.registerCommand('kiroTelegram.status', () => {
      const service = getService();
      if (!service) {
        vscode.window.showWarningMessage('Kiro Telegram: Not connected');
        return;
      }
      const status = service.getStatus();
      const msg = status.connected
        ? `Connected as @${status.botUsername} | ${status.pendingRequests} pending request(s)`
        : 'Disconnected';
      vscode.window.showInformationMessage(`Kiro Telegram: ${msg}`);
    }),
  );
}
