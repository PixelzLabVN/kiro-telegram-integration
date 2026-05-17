#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fromRecord, validateConfig } from '../core/ConfigManager.js';
import { IntegrationService } from '../core/IntegrationService.js';
import { registerTools } from './tools.js';

async function main() {
  const config = fromRecord(process.env);
  const validation = validateConfig(config);
  if (!validation.valid) {
    console.error('Configuration error:', validation.errors.join('; '));
    process.exit(1);
  }

  const service = new IntegrationService();
  await service.initialize(config);

  const server = new McpServer({
    name: 'kiro-telegram-integration',
    version: '0.1.0',
  });

  registerTools(server, service);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on('SIGINT', async () => {
    await service.shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await service.shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
