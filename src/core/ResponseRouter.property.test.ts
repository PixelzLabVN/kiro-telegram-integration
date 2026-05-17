import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { ResponseRouter, parseCallbackData, encodeCallbackData } from './ResponseRouter.js';
import { RequestRegistry } from './RequestRegistry.js';
import { MessageSender } from './MessageSender.js';
import type { TelegramConfig, TelegramUpdate, PendingRequest } from './types.js';

/** Build a TelegramConfig with sensible defaults. */
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

/** Build a PendingRequest with sensible defaults and the given overrides. */
function makePendingRequest(overrides: Partial<PendingRequest> = {}): PendingRequest {
  return {
    id: overrides.id ?? 'req-default',
    type: overrides.type ?? 'confirmation',
    status: overrides.status ?? 'pending',
    messageId: overrides.messageId ?? 100,
    createdAt: overrides.createdAt ?? Date.now(),
    timeoutMs: overrides.timeoutMs ?? 600_000,
    timeoutHandle: overrides.timeoutHandle ?? setTimeout(() => {}, 0),
    resolve: overrides.resolve ?? vi.fn(),
  };
}

/** Arbitrary for actions used in callback data. */
const actionArb = fc.constantFrom('approve', 'cancel');

/** Arbitrary for request IDs that don't contain colons (for clean round-trip testing). */
const safeRequestIdArb = fc.uuid();

/** Arbitrary for positive message IDs. */
const messageIdArb = fc.integer({ min: 1, max: 1_000_000 });

/** Arbitrary for non-empty reply text. */
const replyTextArb = fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0);

describe('ResponseRouter property tests', () => {
  let config: TelegramConfig;
  let registry: RequestRegistry;
  let sender: MessageSender;
  let router: ResponseRouter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sendNotificationSpy: any;

  beforeEach(() => {
    vi.useFakeTimers();
    config = makeConfig();
    registry = new RequestRegistry();
    sender = new MessageSender(config);

    sendNotificationSpy = vi.spyOn(sender, 'sendNotification').mockResolvedValue({
      messageId: 999,
      chatId: config.chatId,
      timestamp: Date.now(),
    });

    // Mock fetch globally for answerCallbackQuery calls
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: true }),
    }));

    router = new ResponseRouter(registry, sender, config);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Feature: kiro-telegram-integration, Property 7: Callback query routing resolves the correct pending request with the correct status
  // **Validates: Requirements 2.4, 2.5, 5.2**
  describe('Property 7: Callback query routing resolves the correct pending request with the correct status', () => {
    test('for any pending confirmation request and matching callback query, resolves with the correct status', async () => {
      await fc.assert(
        fc.asyncProperty(
          safeRequestIdArb,
          actionArb,
          async (requestId: string, action: string) => {
            // Reset state for each iteration
            const freshRegistry = new RequestRegistry();
            const freshRouter = new ResponseRouter(freshRegistry, sender, config);
            const resolveFn = vi.fn();

            freshRegistry.add(makePendingRequest({
              id: requestId,
              type: 'confirmation',
              resolve: resolveFn,
            }));

            const callbackData = encodeCallbackData(requestId, action);
            const update: TelegramUpdate = {
              update_id: 1,
              callback_query: {
                id: 'cb-test',
                data: callbackData,
                message: { message_id: 100, chat: { id: 12345 } },
              },
            };

            const result = await freshRouter.routeUpdate(update);

            expect(result.matched).toBe(true);
            expect(result.requestId).toBe(requestId);

            const expectedStatus = action === 'approve' ? 'approved' : 'cancelled';
            expect(resolveFn).toHaveBeenCalledOnce();
            expect(resolveFn).toHaveBeenCalledWith({
              requestId,
              status: expectedStatus,
            });

            // Request should no longer be pending
            expect(freshRegistry.isPending(requestId)).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: kiro-telegram-integration, Property 8: Text reply routing resolves the correct pending information request with the reply text
  // **Validates: Requirements 3.3, 5.3**
  describe('Property 8: Text reply routing resolves the correct pending information request with the reply text', () => {
    test('for any pending information request and matching text reply, resolves with answered status and reply text', async () => {
      await fc.assert(
        fc.asyncProperty(
          safeRequestIdArb,
          messageIdArb,
          replyTextArb,
          async (requestId: string, msgId: number, text: string) => {
            const freshRegistry = new RequestRegistry();
            const freshRouter = new ResponseRouter(freshRegistry, sender, config);
            const resolveFn = vi.fn();

            freshRegistry.add(makePendingRequest({
              id: requestId,
              type: 'information',
              messageId: msgId,
              resolve: resolveFn,
            }));

            const update: TelegramUpdate = {
              update_id: 1,
              message: {
                message_id: msgId + 1,
                chat: { id: 12345 },
                text,
                reply_to_message: { message_id: msgId, chat: { id: 12345 } },
              },
            };

            const result = await freshRouter.routeUpdate(update);

            expect(result.matched).toBe(true);
            expect(result.requestId).toBe(requestId);
            expect(resolveFn).toHaveBeenCalledOnce();
            expect(resolveFn).toHaveBeenCalledWith({
              requestId,
              status: 'answered',
              data: text,
            });

            // Request should no longer be pending
            expect(freshRegistry.isPending(requestId)).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: kiro-telegram-integration, Property 9: Unmatched responses trigger a notification
  // **Validates: Requirements 5.4**
  describe('Property 9: Unmatched responses trigger a notification', () => {
    test('for any callback query with a non-existent request ID, sends a notification', async () => {
      await fc.assert(
        fc.asyncProperty(
          safeRequestIdArb,
          actionArb,
          async (requestId: string, action: string) => {
            // Use a fresh registry with NO pending requests
            const freshRegistry = new RequestRegistry();
            const freshSender = new MessageSender(config);
            const freshNotifySpy = vi.spyOn(freshSender, 'sendNotification').mockResolvedValue({
              messageId: 999,
              chatId: config.chatId,
              timestamp: Date.now(),
            });
            const freshRouter = new ResponseRouter(freshRegistry, freshSender, config);

            const callbackData = encodeCallbackData(requestId, action);
            const update: TelegramUpdate = {
              update_id: 1,
              callback_query: {
                id: 'cb-unmatched',
                data: callbackData,
                message: { message_id: 100, chat: { id: 12345 } },
              },
            };

            const result = await freshRouter.routeUpdate(update);

            expect(result.matched).toBe(false);
            expect(freshNotifySpy).toHaveBeenCalledOnce();
          },
        ),
        { numRuns: 100 },
      );
    });

    test('for any text reply with a non-existent message ID, sends a notification', async () => {
      await fc.assert(
        fc.asyncProperty(
          messageIdArb,
          replyTextArb,
          async (msgId: number, text: string) => {
            // Use a fresh registry with NO pending requests
            const freshRegistry = new RequestRegistry();
            const freshSender = new MessageSender(config);
            const freshNotifySpy = vi.spyOn(freshSender, 'sendNotification').mockResolvedValue({
              messageId: 999,
              chatId: config.chatId,
              timestamp: Date.now(),
            });
            const freshRouter = new ResponseRouter(freshRegistry, freshSender, config);

            const update: TelegramUpdate = {
              update_id: 1,
              message: {
                message_id: msgId + 1,
                chat: { id: 12345 },
                text,
                reply_to_message: { message_id: msgId, chat: { id: 12345 } },
              },
            };

            const result = await freshRouter.routeUpdate(update);

            expect(result.matched).toBe(false);
            expect(freshNotifySpy).toHaveBeenCalledOnce();
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: kiro-telegram-integration, Property 13: Responses to expired requests trigger an expiry notification
  // **Validates: Requirements 4.4**
  describe('Property 13: Responses to expired requests trigger an expiry notification', () => {
    test('for any callback query for a request that was once pending but is now gone, sends an expiry notification', async () => {
      await fc.assert(
        fc.asyncProperty(
          safeRequestIdArb,
          actionArb,
          async (requestId: string, action: string) => {
            const freshRegistry = new RequestRegistry();
            const freshSender = new MessageSender(config);
            const freshNotifySpy = vi.spyOn(freshSender, 'sendNotification').mockResolvedValue({
              messageId: 999,
              chatId: config.chatId,
              timestamp: Date.now(),
            });
            const freshRouter = new ResponseRouter(freshRegistry, freshSender, config);

            // Add and then resolve the request to simulate expiry
            const resolveFn = vi.fn();
            freshRegistry.add(makePendingRequest({
              id: requestId,
              type: 'confirmation',
              resolve: resolveFn,
            }));
            freshRegistry.resolve(requestId, { requestId, status: 'timed_out' });

            // Now the request is gone from registry
            expect(freshRegistry.isPending(requestId)).toBe(false);

            const callbackData = encodeCallbackData(requestId, action);
            const update: TelegramUpdate = {
              update_id: 1,
              callback_query: {
                id: 'cb-expired',
                data: callbackData,
                message: { message_id: 100, chat: { id: 12345 } },
              },
            };

            const result = await freshRouter.routeUpdate(update);

            expect(result.matched).toBe(false);
            expect(result.error).toContain('expired');
            expect(freshNotifySpy).toHaveBeenCalledOnce();
            expect(freshNotifySpy).toHaveBeenCalledWith(
              expect.stringContaining('expired'),
            );
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: kiro-telegram-integration, Property 17: Callback data round trip
  // **Validates: Requirements 5.2**
  describe('Property 17: Callback data round trip', () => {
    test('for any request ID (without colons) and action, encode then parse yields the original values', () => {
      fc.assert(
        fc.property(
          safeRequestIdArb,
          actionArb,
          (requestId: string, action: string) => {
            const encoded = encodeCallbackData(requestId, action);
            const parsed = parseCallbackData(encoded);

            expect(parsed).not.toBeNull();
            expect(parsed!.requestId).toBe(requestId);
            expect(parsed!.action).toBe(action);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
