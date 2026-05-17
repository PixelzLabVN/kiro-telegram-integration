import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResponseRouter, parseCallbackData, encodeCallbackData } from './ResponseRouter.js';
import { RequestRegistry } from './RequestRegistry.js';
import { MessageSender } from './MessageSender.js';
import type { TelegramConfig, TelegramUpdate, PendingRequest } from './types.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeConfig(overrides: Partial<TelegramConfig> = {}): TelegramConfig {
  return {
    botToken: 'test-bot-token',
    chatId: '12345',
    timeoutMs: 600_000,
    maxRetries: 3,
    maxBackoffMs: 60_000,
    ...overrides,
  };
}

function makePendingRequest(overrides: Partial<PendingRequest> = {}): PendingRequest {
  return {
    id: overrides.id ?? 'req-1',
    type: overrides.type ?? 'confirmation',
    status: overrides.status ?? 'pending',
    messageId: overrides.messageId ?? 100,
    createdAt: overrides.createdAt ?? Date.now(),
    timeoutMs: overrides.timeoutMs ?? 600_000,
    timeoutHandle: overrides.timeoutHandle ?? setTimeout(() => {}, 0),
    resolve: overrides.resolve ?? vi.fn(),
  };
}

describe('parseCallbackData', () => {
  it('parses valid callback data', () => {
    expect(parseCallbackData('abc123:approve')).toEqual({
      requestId: 'abc123',
      action: 'approve',
    });
  });

  it('parses cancel action', () => {
    expect(parseCallbackData('req-42:cancel')).toEqual({
      requestId: 'req-42',
      action: 'cancel',
    });
  });

  it('handles request IDs containing colons', () => {
    expect(parseCallbackData('ns:req:123:approve')).toEqual({
      requestId: 'ns:req:123',
      action: 'approve',
    });
  });

  it('returns null for empty string', () => {
    expect(parseCallbackData('')).toBeNull();
  });

  it('returns null for string without colon', () => {
    expect(parseCallbackData('nocolon')).toBeNull();
  });

  it('returns null for string ending with colon', () => {
    expect(parseCallbackData('abc:')).toBeNull();
  });

  it('returns null for string starting with colon only', () => {
    expect(parseCallbackData(':action')).toBeNull();
  });
});

describe('encodeCallbackData', () => {
  it('encodes request ID and action', () => {
    expect(encodeCallbackData('abc123', 'approve')).toBe('abc123:approve');
  });

  it('round-trips with parseCallbackData', () => {
    const encoded = encodeCallbackData('my-req', 'cancel');
    const parsed = parseCallbackData(encoded);
    expect(parsed).toEqual({ requestId: 'my-req', action: 'cancel' });
  });
});

describe('ResponseRouter', () => {
  let config: TelegramConfig;
  let registry: RequestRegistry;
  let sender: MessageSender;
  let router: ResponseRouter;

  beforeEach(() => {
    vi.useFakeTimers();
    config = makeConfig();
    registry = new RequestRegistry();
    sender = new MessageSender(config);

    // Mock sendNotification on the sender
    vi.spyOn(sender, 'sendNotification').mockResolvedValue({
      messageId: 999,
      chatId: config.chatId,
      timestamp: Date.now(),
    });

    // Mock fetch for answerCallbackQuery
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: true }),
    });

    router = new ResponseRouter(registry, sender, config);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('callback query routing', () => {
    it('resolves a pending confirmation request as approved', async () => {
      const resolveFn = vi.fn();
      registry.add(makePendingRequest({ id: 'req-1', resolve: resolveFn }));

      const update: TelegramUpdate = {
        update_id: 1,
        callback_query: {
          id: 'cb-1',
          data: 'req-1:approve',
          message: { message_id: 100, chat: { id: 12345 } },
        },
      };

      const result = await router.routeUpdate(update);

      expect(result.matched).toBe(true);
      expect(result.requestId).toBe('req-1');
      expect(resolveFn).toHaveBeenCalledWith({
        requestId: 'req-1',
        status: 'approved',
      });
    });

    it('resolves a pending confirmation request as cancelled', async () => {
      const resolveFn = vi.fn();
      registry.add(makePendingRequest({ id: 'req-2', resolve: resolveFn }));

      const update: TelegramUpdate = {
        update_id: 2,
        callback_query: {
          id: 'cb-2',
          data: 'req-2:cancel',
          message: { message_id: 101, chat: { id: 12345 } },
        },
      };

      const result = await router.routeUpdate(update);

      expect(result.matched).toBe(true);
      expect(result.requestId).toBe('req-2');
      expect(resolveFn).toHaveBeenCalledWith({
        requestId: 'req-2',
        status: 'cancelled',
      });
    });

    it('acknowledges the callback query via Telegram API', async () => {
      registry.add(makePendingRequest({ id: 'req-1' }));

      const update: TelegramUpdate = {
        update_id: 1,
        callback_query: {
          id: 'cb-100',
          data: 'req-1:approve',
          message: { message_id: 100, chat: { id: 12345 } },
        },
      };

      await router.routeUpdate(update);

      expect(mockFetch).toHaveBeenCalledWith(
        `https://api.telegram.org/bottest-bot-token/answerCallbackQuery`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ callback_query_id: 'cb-100' }),
        }),
      );
    });

    it('sends expiry notification for already resolved request', async () => {
      // Don't add the request to registry — simulates already resolved
      const update: TelegramUpdate = {
        update_id: 3,
        callback_query: {
          id: 'cb-3',
          data: 'req-gone:approve',
          message: { message_id: 200, chat: { id: 12345 } },
        },
      };

      const result = await router.routeUpdate(update);

      expect(result.matched).toBe(false);
      expect(result.error).toContain('expired');
      expect(sender.sendNotification).toHaveBeenCalledWith(
        expect.stringContaining('expired'),
      );
    });

    it('returns error for invalid callback data format', async () => {
      const update: TelegramUpdate = {
        update_id: 4,
        callback_query: {
          id: 'cb-4',
          data: 'invalid-no-colon',
          message: { message_id: 300, chat: { id: 12345 } },
        },
      };

      const result = await router.routeUpdate(update);

      expect(result.matched).toBe(false);
      expect(result.error).toContain('Invalid callback data');
    });
  });

  describe('text reply routing', () => {
    it('resolves a pending information request with reply text', async () => {
      const resolveFn = vi.fn();
      registry.add(makePendingRequest({
        id: 'info-1',
        type: 'information',
        messageId: 500,
        resolve: resolveFn,
      }));

      const update: TelegramUpdate = {
        update_id: 10,
        message: {
          message_id: 501,
          chat: { id: 12345 },
          text: 'Here is my answer',
          reply_to_message: { message_id: 500, chat: { id: 12345 } },
        },
      };

      const result = await router.routeUpdate(update);

      expect(result.matched).toBe(true);
      expect(result.requestId).toBe('info-1');
      expect(resolveFn).toHaveBeenCalledWith({
        requestId: 'info-1',
        status: 'answered',
        data: 'Here is my answer',
      });
    });

    it('sends notification when no matching request found for reply', async () => {
      const update: TelegramUpdate = {
        update_id: 11,
        message: {
          message_id: 601,
          chat: { id: 12345 },
          text: 'Reply to nothing',
          reply_to_message: { message_id: 999, chat: { id: 12345 } },
        },
      };

      const result = await router.routeUpdate(update);

      expect(result.matched).toBe(false);
      expect(result.error).toContain('No matching');
      expect(sender.sendNotification).toHaveBeenCalledWith(
        expect.stringContaining('No matching'),
      );
    });

    it('handles reply with empty text', async () => {
      const resolveFn = vi.fn();
      registry.add(makePendingRequest({
        id: 'info-2',
        type: 'information',
        messageId: 700,
        resolve: resolveFn,
      }));

      const update: TelegramUpdate = {
        update_id: 12,
        message: {
          message_id: 701,
          chat: { id: 12345 },
          reply_to_message: { message_id: 700, chat: { id: 12345 } },
        },
      };

      const result = await router.routeUpdate(update);

      expect(result.matched).toBe(true);
      expect(resolveFn).toHaveBeenCalledWith({
        requestId: 'info-2',
        status: 'answered',
        data: '',
      });
    });
  });

  describe('unmatched updates', () => {
    it('returns not matched for update with no callback or reply', async () => {
      const update: TelegramUpdate = {
        update_id: 20,
        message: {
          message_id: 800,
          chat: { id: 12345 },
          text: 'Just a random message',
        },
      };

      const result = await router.routeUpdate(update);

      expect(result.matched).toBe(false);
      expect(result.error).toContain('neither callback query nor reply');
    });
  });

  describe('answerCallbackQuery failure handling', () => {
    it('still routes successfully even if answerCallbackQuery fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const resolveFn = vi.fn();
      registry.add(makePendingRequest({ id: 'req-net', resolve: resolveFn }));

      const update: TelegramUpdate = {
        update_id: 30,
        callback_query: {
          id: 'cb-net',
          data: 'req-net:approve',
          message: { message_id: 100, chat: { id: 12345 } },
        },
      };

      const result = await router.routeUpdate(update);

      expect(result.matched).toBe(true);
      expect(resolveFn).toHaveBeenCalledWith({
        requestId: 'req-net',
        status: 'approved',
      });
    });
  });
});
