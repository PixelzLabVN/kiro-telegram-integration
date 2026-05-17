import * as vscode from 'vscode';
import { getService } from './extension.js';

let statusBarItem: vscode.StatusBarItem;

/**
 * Create and show the Kiro Telegram status bar item.
 *
 * Displays connection status (✓ connected, ✗ disconnected) and pending
 * request count. Clicking the item opens the command palette filtered
 * to kiroTelegram commands.
 *
 * @param context - The VS Code extension context for subscription management.
 */
export function createStatusBar(context: vscode.ExtensionContext): void {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'kiroTelegram.status';
  context.subscriptions.push(statusBarItem);
  updateStatusBar();
  statusBarItem.show();
}

/**
 * Update the status bar item text and tooltip based on current service state.
 *
 * Shows a check icon when connected, an X icon when disconnected, and
 * appends the pending request count when greater than zero.
 */
export function updateStatusBar(): void {
  const service = getService();
  if (!service) {
    statusBarItem.text = '$(circle-slash) Telegram';
    statusBarItem.tooltip = 'Kiro Telegram: Not connected';
    return;
  }
  const status = service.getStatus();
  if (status.connected) {
    const pending = status.pendingRequests > 0 ? ` (${status.pendingRequests})` : '';
    statusBarItem.text = `$(check) Telegram${pending}`;
    statusBarItem.tooltip = `Kiro Telegram: Connected as @${status.botUsername}${pending ? ` | ${status.pendingRequests} pending` : ''}`;
  } else {
    statusBarItem.text = '$(x) Telegram';
    statusBarItem.tooltip = 'Kiro Telegram: Disconnected';
  }
}
