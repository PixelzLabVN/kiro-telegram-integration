import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { IntegrationService } from '../core/IntegrationService.js';
import { registerTools } from './tools.js';

describe('registerTools', () => {
  let server: McpServer;
  let service: IntegrationService;

  beforeEach(() => {
    server = new McpServer({ name: 'test-server', version: '0.1.0' });
    service = new IntegrationService();
  });

  it('registers all 4 tools on the server', () => {
    const toolSpy = vi.spyOn(server, 'tool');
    registerTools(server, service);
    expect(toolSpy).toHaveBeenCalledTimes(4);

    const toolNames = toolSpy.mock.calls.map((call) => call[0]);
    expect(toolNames).toContain('telegram_confirm');
    expect(toolNames).toContain('telegram_ask');
    expect(toolNames).toContain('telegram_notify');
    expect(toolNames).toContain('telegram_status');
  });

  it('telegram_confirm delegates to service.requestConfirmation', async () => {
    const mockResult = { requestId: 'abc-123', status: 'approved' as const };
    const confirmSpy = vi.spyOn(service, 'requestConfirmation').mockResolvedValue(mockResult);

    const toolSpy = vi.spyOn(server, 'tool');
    registerTools(server, service);

    // Find the telegram_confirm handler (first call)
    const confirmCall = toolSpy.mock.calls.find((c) => c[0] === 'telegram_confirm')!;
    const handler = confirmCall[confirmCall.length - 1] as Function;

    const result = await handler({
      actionType: 'file-edit',
      summary: 'Edit main.ts',
      affectedFiles: ['src/main.ts'],
    }, {});

    expect(confirmSpy).toHaveBeenCalledWith({
      actionType: 'file-edit',
      summary: 'Edit main.ts',
      affectedFiles: ['src/main.ts'],
    });
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ status: 'approved', requestId: 'abc-123' }) }],
    });
  });

  it('telegram_ask delegates to service.requestInformation', async () => {
    const mockResult = { requestId: 'def-456', status: 'answered' as const, data: 'yes' };
    const infoSpy = vi.spyOn(service, 'requestInformation').mockResolvedValue(mockResult);

    const toolSpy = vi.spyOn(server, 'tool');
    registerTools(server, service);

    const askCall = toolSpy.mock.calls.find((c) => c[0] === 'telegram_ask')!;
    const handler = askCall[askCall.length - 1] as Function;

    const result = await handler({ prompt: 'Which branch?', context: 'Deploying to prod' }, {});

    expect(infoSpy).toHaveBeenCalledWith('Which branch?', 'Deploying to prod');
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ status: 'answered', data: 'yes', requestId: 'def-456' }) }],
    });
  });

  it('telegram_notify delegates to service.sendNotification', async () => {
    const notifySpy = vi.spyOn(service, 'sendNotification').mockResolvedValue({ messageId: 42 });

    const toolSpy = vi.spyOn(server, 'tool');
    registerTools(server, service);

    const notifyCall = toolSpy.mock.calls.find((c) => c[0] === 'telegram_notify')!;
    const handler = notifyCall[notifyCall.length - 1] as Function;

    const result = await handler({ message: 'Build complete' }, {});

    expect(notifySpy).toHaveBeenCalledWith('Build complete');
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ messageId: 42 }) }],
    });
  });

  it('telegram_status delegates to service.getStatus', async () => {
    const statusResult = { connected: true, botUsername: 'test_bot', pendingRequests: 2 };
    vi.spyOn(service, 'getStatus').mockReturnValue(statusResult);

    const toolSpy = vi.spyOn(server, 'tool');
    registerTools(server, service);

    const statusCall = toolSpy.mock.calls.find((c) => c[0] === 'telegram_status')!;
    const handler = statusCall[statusCall.length - 1] as Function;

    const result = await handler({});

    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify(statusResult) }],
    });
  });
});
