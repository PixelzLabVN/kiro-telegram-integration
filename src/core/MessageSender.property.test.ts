import { describe, expect, test, vi, afterEach } from 'vitest';
import * as fc from 'fast-check';
import {
  formatConfirmationMessage,
  formatInformationMessage,
  truncateMessage,
  calculateBackoff,
  MessageSender,
} from './MessageSender.js';
import type { TelegramConfig, ActionContext } from './types.js';

/** Arbitrary for non-empty strings (no empty or whitespace-only). */
const nonEmptyString = fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0);

/** Arbitrary for ActionContext with non-empty fields. */
const actionContextArb = fc.record({
  actionType: nonEmptyString,
  summary: nonEmptyString,
  affectedFiles: fc.array(nonEmptyString, { minLength: 1, maxLength: 5 }),
});

/** Build a TelegramConfig with the given overrides. */
function makeConfig(overrides: Partial<TelegramConfig> = {}): TelegramConfig {
  return {
    botToken: 'test-token-123',
    chatId: '999',
    timeoutMs: 600_000,
    maxRetries: 3,
    maxBackoffMs: 60_000,
    ...overrides,
  };
}

/** Create a fetch mock that returns a fresh successful Response on every call. */
function createFetchMock(messageId = 42) {
  return vi.fn().mockImplementation(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({ ok: true, result: { message_id: messageId } }),
        { status: 200 },
      ),
    ),
  );
}

describe('MessageSender property tests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // Feature: kiro-telegram-integration, Property 4: Confirmation messages contain complete ActionContext and correct markup
  // **Validates: Requirements 2.2, 2.3, 6.1, 6.2**
  describe('Property 4: Confirmation messages contain complete ActionContext and correct markup', () => {
    test('formatted confirmation message contains actionType, summary, affectedFiles and uses MarkdownV2 formatting', () => {
      fc.assert(
        fc.property(actionContextArb, (context: ActionContext) => {
          const message = formatConfirmationMessage(context, 10);

          const escape = (s: string) => s.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
          expect(message).toContain(escape(context.actionType));
          expect(message).toContain(escape(context.summary));
          for (const file of context.affectedFiles) {
            expect(message).toContain(escape(file));
          }

          // MarkdownV2 formatting markers
          expect(message).toContain('*Action Required*');
          expect(message).toContain('*Type:*');
          expect(message).toContain('*Summary:*');
          expect(message).toContain('*Files:*');
        }),
        { numRuns: 100 },
      );
    });

    test('sendConfirmationRequest payload uses MarkdownV2 parse mode and includes Approve/Cancel inline keyboard', async () => {
      const fetchMock = createFetchMock();
      vi.stubGlobal('fetch', fetchMock);

      await fc.assert(
        fc.asyncProperty(actionContextArb, async (context) => {
          fetchMock.mockClear();
          const sender = new MessageSender(makeConfig());
          await sender.sendConfirmationRequest(context, 'req-prop4');

          const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
          expect(body.parse_mode).toBe('MarkdownV2');
          expect(body.reply_markup.inline_keyboard).toBeDefined();

          const buttons = body.reply_markup.inline_keyboard[0];
          expect(buttons).toHaveLength(2);
          expect(buttons[0].text).toContain('Approve');
          expect(buttons[1].text).toContain('Cancel');
          expect(buttons[0].callback_data).toBe('req-prop4:approve');
          expect(buttons[1].callback_data).toBe('req-prop4:cancel');
        }),
        { numRuns: 100 },
      );
    }, 30_000);
  });

  // Feature: kiro-telegram-integration, Property 5: Information messages contain prompt, context, and ForceReply markup
  // **Validates: Requirements 3.2, 3.4, 6.3**
  describe('Property 5: Information messages contain prompt, context, and ForceReply markup', () => {
    test('formatted information message contains prompt and context', () => {
      fc.assert(
        fc.property(nonEmptyString, nonEmptyString, (prompt: string, context: string) => {
          const message = formatInformationMessage(prompt, context, 10);

          const escape = (s: string) => s.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
          expect(message).toContain(escape(prompt));
          expect(message).toContain(escape(context));
          expect(message).toContain('*Information Needed*');
        }),
        { numRuns: 100 },
      );
    });

    test('sendInformationRequest payload includes force_reply: true', async () => {
      const fetchMock = createFetchMock();
      vi.stubGlobal('fetch', fetchMock);

      await fc.assert(
        fc.asyncProperty(nonEmptyString, nonEmptyString, async (prompt, context) => {
          fetchMock.mockClear();
          const sender = new MessageSender(makeConfig());
          await sender.sendInformationRequest(prompt, context, 'req-info');

          const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
          expect(body.reply_markup.force_reply).toBe(true);
        }),
        { numRuns: 100 },
      );
    }, 30_000);
  });

  // Feature: kiro-telegram-integration, Property 6: All outgoing messages target the configured Chat_ID
  // **Validates: Requirements 2.1, 3.1**
  describe('Property 6: All outgoing messages target the configured Chat_ID', () => {
    test('sendConfirmationRequest and sendInformationRequest use the configured chatId', async () => {
      const chatIdArb = fc.stringOf(
        fc.constantFrom(...'0123456789'),
        { minLength: 1, maxLength: 15 },
      );

      await fc.assert(
        fc.asyncProperty(chatIdArb, async (chatId) => {
          const fetchMock = createFetchMock();
          vi.stubGlobal('fetch', fetchMock);

          const sender = new MessageSender(makeConfig({ chatId }));

          // Test confirmation request
          await sender.sendConfirmationRequest(
            { actionType: 'test', summary: 'test', affectedFiles: ['a.ts'] },
            'req-1',
          );
          const confirmBody = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
          expect(confirmBody.chat_id).toBe(chatId);

          // Test information request
          await sender.sendInformationRequest('prompt', 'ctx', 'req-2');
          const infoBody = JSON.parse(fetchMock.mock.calls[1][1]!.body as string);
          expect(infoBody.chat_id).toBe(chatId);
        }),
        { numRuns: 100 },
      );
    }, 30_000);
  });

  // Feature: kiro-telegram-integration, Property 10: Message truncation respects the 4096-character limit
  // **Validates: Requirements 6.4**
  describe('Property 10: Message truncation respects the 4096-character limit', () => {
    test('truncated output never exceeds 4096 characters', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 10000 }), (content: string) => {
          const result = truncateMessage(content);
          expect(result.length).toBeLessThanOrEqual(4096);
        }),
        { numRuns: 100 },
      );
    });

    test('messages exceeding 4096 chars end with a truncation indicator', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 4097, maxLength: 10000 }), (content: string) => {
          const result = truncateMessage(content);
          expect(result).toContain('truncated');
          expect(result.length).toBeLessThanOrEqual(4096);
        }),
        { numRuns: 100 },
      );
    });

    test('messages within 4096 chars are returned unchanged', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 4096 }), (content: string) => {
          const result = truncateMessage(content);
          expect(result).toBe(content);
        }),
        { numRuns: 100 },
      );
    });
  });

  // Feature: kiro-telegram-integration, Property 14: Retry count respects configuration
  // **Validates: Requirements 8.1**
  describe('Property 14: Retry count respects configuration', () => {
    test('sender retries exactly maxRetries times, total attempts = maxRetries + 1', async () => {
      const maxRetriesArb = fc.integer({ min: 1, max: 5 });

      await fc.assert(
        fc.asyncProperty(maxRetriesArb, async (maxRetries) => {
          vi.useFakeTimers({ shouldAdvanceTime: true });

          const fetchMock = vi.fn().mockImplementation(() =>
            Promise.resolve(new Response('Server Error', { status: 500 })),
          );
          vi.stubGlobal('fetch', fetchMock);

          const sender = new MessageSender(makeConfig({ maxRetries, maxBackoffMs: 1 }));

          await expect(sender.sendNotification('test')).rejects.toThrow();
          expect(fetchMock).toHaveBeenCalledTimes(maxRetries + 1);

          vi.useRealTimers();
          vi.restoreAllMocks();
        }),
        { numRuns: 100 },
      );
    }, 30_000);
  });

  // Feature: kiro-telegram-integration, Property 15: Exponential backoff intervals are bounded
  // **Validates: Requirements 8.3**
  describe('Property 15: Exponential backoff intervals are bounded', () => {
    test('calculateBackoff never exceeds maxBackoffMs', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 20 }),
          fc.integer({ min: 1000, max: 120_000 }),
          (attempt: number, maxBackoffMs: number) => {
            const backoff = calculateBackoff(attempt, maxBackoffMs);
            expect(backoff).toBeLessThanOrEqual(maxBackoffMs);
            expect(backoff).toBeGreaterThan(0);
          },
        ),
        { numRuns: 100 },
      );
    });

    test('calculateBackoff increases exponentially up to the cap', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 19 }),
          fc.integer({ min: 1000, max: 120_000 }),
          (attempt: number, maxBackoffMs: number) => {
            const current = calculateBackoff(attempt, maxBackoffMs);
            const next = calculateBackoff(attempt + 1, maxBackoffMs);
            expect(next).toBeGreaterThanOrEqual(current);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
