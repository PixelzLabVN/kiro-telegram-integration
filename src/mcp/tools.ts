import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IntegrationService } from '../core/IntegrationService.js';

/**
 * Register all Telegram integration MCP tools on the given server.
 *
 * Defines four tools — `telegram_confirm`, `telegram_ask`, `telegram_notify`,
 * and `telegram_status` — each delegating to the corresponding
 * IntegrationService method.
 *
 * @param server - The MCP server instance to register tools on.
 * @param service - The initialized IntegrationService instance.
 */
export function registerTools(server: McpServer, service: IntegrationService): void {
  server.tool(
    'telegram_confirm',
    'Sends a confirmation request to Telegram and waits for user response.',
    {
      actionType: z.string().describe('The type of action requiring confirmation'),
      summary: z.string().describe('A human-readable summary of the proposed change'),
      affectedFiles: z.array(z.string()).describe('List of files affected by the action'),
    },
    async ({ actionType, summary, affectedFiles }) => {
      const result = await service.requestConfirmation({ actionType, summary, affectedFiles });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ status: result.status, requestId: result.requestId }) }],
      };
    },
  );

  server.tool(
    'telegram_ask',
    'Sends an information request to Telegram and waits for user reply.',
    {
      prompt: z.string().describe('The question or prompt text to send'),
      context: z.string().describe('Relevant context about the current operation'),
    },
    async ({ prompt, context }) => {
      const result = await service.requestInformation(prompt, context);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ status: result.status, data: result.data, requestId: result.requestId }) }],
      };
    },
  );

  server.tool(
    'telegram_notify',
    'Sends a one-way notification to Telegram (no response expected).',
    {
      message: z.string().describe('The notification message to send'),
    },
    async ({ message }) => {
      const result = await service.sendNotification(message);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ messageId: result.messageId }) }],
      };
    },
  );

  server.tool(
    'telegram_status',
    'Returns the current status of the Telegram integration.',
    async () => {
      const status = service.getStatus();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(status) }],
      };
    },
  );
}
