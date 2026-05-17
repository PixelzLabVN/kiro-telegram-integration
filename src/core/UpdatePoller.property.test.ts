import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { UpdatePoller } from './UpdatePoller.js';
import type { TelegramConfig, TelegramUpdate } from './types.js';

const defaultConfig: TelegramConfig = {
  botToken: 'test-token',
  chatId: '123',
  timeoutMs: 600_000,
  maxRetries: 3,
  maxBackoffMs: 60_000,
};

function makeUpdate(updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: { message_id: updateId, chat: { id: 123 }, text: 'hello' },
  };
}

function mockGetUpdatesResponse(updates: TelegramUpdate[]) {
  return new Response(JSON.stringify({ ok: true, result: updates }), { status: 200 });
}

describe('UpdatePoller property tests', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // Feature: kiro-telegram-integration, Property 16: Polling resumes from last known offset
  // **Validates: Requirements 8.4**
  describe('Property 16: Polling resumes from last known offset', () => {
    test('next poll uses offset = highest update_id + 1', async () => {
      const samples = fc.sample(
        fc.uniqueArray(fc.integer({ min: 1, max: 100000 }), { minLength: 1, maxLength: 10 }).map(
          (arr) => [...arr].sort((a, b) => a - b),
        ),
        { numRuns: 100 },
      );

      for (const updateIds of samples) {
        const updates = updateIds.map(makeUpdate);
        const maxUpdateId = updateIds[updateIds.length - 1];

        const fetchMock = vi.fn()
          .mockResolvedValueOnce(mockGetUpdatesResponse(updates))
          .mockResolvedValueOnce(mockGetUpdatesResponse([]))
          .mockImplementation(() => new Promise(() => {})); // hang on third call

        vi.stubGlobal('fetch', fetchMock);

        const poller = new UpdatePoller(defaultConfig);
        poller.onUpdate(() => {});

        poller.start();

        // Let first poll complete (returns updates) and second poll start (returns empty)
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);

        poller.stop();

        // The second fetch call should contain offset = maxUpdateId + 1
        expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
        const secondUrl = fetchMock.mock.calls[1][0] as string;
        expect(secondUrl).toContain(`offset=${maxUpdateId + 1}`);
      }
    });
  });
});
