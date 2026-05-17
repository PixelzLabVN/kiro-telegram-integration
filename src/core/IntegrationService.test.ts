import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IntegrationService } from './IntegrationService.js';
import type { TelegramConfig, ActionContext } from './types.js';

const defaultConfig: TelegramConfig = {
  botToken: 'test-token-123',
  chatId: '999',
  timeoutMs: 600_000,
  maxRetries: 0,
  maxBackoffMs: 60_000,
};

/**
 * Build a mock fetch that handles all Telegram API endpoints.
 *
 * getUpdates calls are resolved via a queue of resolvers — the test pushes
 * updates by calling `resolveNextPoll(updates)`, which unblocks the poller.
 */
function buildFetchMock(options: { messageId?: number } = {}) {
  const { messageId = 42 } = options;
  const sendMessageCalls: any[] = [];

  // Queue of pending getUpdates resolvers
  let pendingPollResolve: ((response: Response) => void) | null = null;

  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();

    if (urlStr.includes('/getMe')) {
      return new Response(
        JSON.stringify({ ok: true, result: { username: 'test_bot' } }),
        { status: 200 },
      );
    }

    if (urlStr.includes('/sendMessage')) {
      const body = JSON.parse(init?.body as string);
      sendMessageCalls.push(body);
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: messageId } }),
        { status: 200 },
      );
    }

    if (urlStr.includes('/getUpdates')) {
      return new Promise<Response>((resolve) => {
        pendingPollResolve = resolve;
      });
    }

    if (urlStr.includes('/answerCallbackQuery')) {
      return new Response(
        JSON.stringify({ ok: true, result: true }),
        { status: 200 },
      );
    }

    if (urlStr.includes('/editMessageText')) {
      return new Response(
        JSON.stringify({ ok: true, result: true }),
        { status: 200 },
      );
    }

    return new Response('Not Found', { status: 404 });
  });

  function resolveNextPoll(updates: any[]) {
    if (pendingPollResolve) {
      const resolve = pendingPollResolve;
      pendingPollResolve = null;
      resolve(
        new Response(JSON.stringify({ ok: true, result: updates }), { status: 200 }),
      );
    }
  }

  return { fetchMock, sendMessageCalls, resolveNextPoll };
}

describe('IntegrationService', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('confirmation flow', () => {
    it('sends confirmation, receives approve callback, resolves with approved status', async () => {
      const sentMessageId = 100;
      const { fetchMock, sendMessageCalls, resolveNextPoll } = buildFetchMock({
        messageId: sentMessageId,
      });
      vi.stubGlobal('fetch', fetchMock);

      const service = new IntegrationService();
      await service.initialize(defaultConfig);

      // The poller has started and is waiting on its first getUpdates call.
      // Resolve it with empty updates so the loop continues.
      await vi.advanceTimersByTimeAsync(0);
      resolveNextPoll([]);
      await vi.advanceTimersByTimeAsync(0);

      const context: ActionContext = {
        actionType: 'File Edit',
        summary: 'Refactor utils module',
        affectedFiles: ['src/utils.ts'],
      };

      const resultPromise = service.requestConfirmation(context);

      // Wait for sendMessage to be called
      await vi.advanceTimersByTimeAsync(0);

      // Extract the requestId from the sendMessage callback_data
      const confirmCall = sendMessageCalls.find((c: any) => c.reply_markup?.inline_keyboard);
      expect(confirmCall).toBeDefined();
      const callbackData = confirmCall.reply_markup.inline_keyboard[0][0].callback_data as string;
      const requestId = callbackData.split(':')[0];

      // Now resolve the pending getUpdates with a callback_query simulating "Approve"
      resolveNextPoll([
        {
          update_id: 1001,
          callback_query: {
            id: 'cb-1',
            data: `${requestId}:approve`,
            message: { message_id: sentMessageId, chat: { id: 999 } },
          },
        },
      ]);

      // Let the poller process the update and the router resolve the request
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      const result = await resultPromise;

      expect(result.status).toBe('approved');
      expect(result.requestId).toBe(requestId);

      await service.shutdown();
    });
  });

  describe('information flow', () => {
    it('sends information request, receives text reply, resolves with answered status', async () => {
      const sentMessageId = 200;
      const { fetchMock, resolveNextPoll } = buildFetchMock({
        messageId: sentMessageId,
      });
      vi.stubGlobal('fetch', fetchMock);

      const service = new IntegrationService();
      await service.initialize(defaultConfig);

      // Let the first poll start and resolve it empty
      await vi.advanceTimersByTimeAsync(0);
      resolveNextPoll([]);
      await vi.advanceTimersByTimeAsync(0);

      const resultPromise = service.requestInformation(
        'What is the API key?',
        'Deploying to production',
      );

      // Wait for sendMessage
      await vi.advanceTimersByTimeAsync(0);

      // Resolve the pending getUpdates with a text reply referencing the sent message
      resolveNextPoll([
        {
          update_id: 2001,
          message: {
            message_id: 2002,
            chat: { id: 999 },
            text: 'my-secret-api-key-123',
            reply_to_message: {
              message_id: sentMessageId,
              chat: { id: 999 },
            },
          },
        },
      ]);

      // Let the poller process the update
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      const result = await resultPromise;

      expect(result.status).toBe('answered');
      expect(result.data).toBe('my-secret-api-key-123');

      await service.shutdown();
    });
  });

  describe('timeout flow', () => {
    it('resolves with timed_out when timeout elapses, and edits the message', async () => {
      const sentMessageId = 300;
      const timeoutMs = 5000;
      const config: TelegramConfig = { ...defaultConfig, timeoutMs };

      const { fetchMock } = buildFetchMock({ messageId: sentMessageId });
      vi.stubGlobal('fetch', fetchMock);

      const service = new IntegrationService();
      await service.initialize(config);

      const context: ActionContext = {
        actionType: 'Delete',
        summary: 'Remove old files',
        affectedFiles: ['old.ts'],
      };

      const resultPromise = service.requestConfirmation(context);

      // Wait for sendMessage to complete
      await vi.advanceTimersByTimeAsync(0);

      // Advance time past the timeout
      await vi.advanceTimersByTimeAsync(timeoutMs + 100);

      const result = await resultPromise;

      expect(result.status).toBe('timed_out');

      // Verify editMessageText was called with the expiry message
      const editCalls = fetchMock.mock.calls.filter(
        (call) => (call[0] as string).includes('/editMessageText'),
      );
      expect(editCalls.length).toBeGreaterThanOrEqual(1);

      const editBody = JSON.parse(editCalls[0][1]!.body as string);
      expect(editBody.message_id).toBe(sentMessageId);
      expect(editBody.text).toContain('expired');

      await service.shutdown();
    });
  });
});
