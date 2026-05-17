import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('UpdatePoller', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('onUpdate', () => {
    it('registers a handler that receives updates', async () => {
      const updates = [makeUpdate(100), makeUpdate(101)];
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(mockGetUpdatesResponse(updates))
        .mockImplementation(() => new Promise(() => {})); // hang on second call

      vi.stubGlobal('fetch', fetchMock);

      const poller = new UpdatePoller(defaultConfig);
      const received: TelegramUpdate[] = [];
      poller.onUpdate((u) => received.push(u));

      poller.start();
      await vi.advanceTimersByTimeAsync(0);

      poller.stop();
      expect(received).toHaveLength(2);
      expect(received[0].update_id).toBe(100);
      expect(received[1].update_id).toBe(101);
    });

    it('supports multiple handlers', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(mockGetUpdatesResponse([makeUpdate(1)]))
        .mockImplementation(() => new Promise(() => {}));

      vi.stubGlobal('fetch', fetchMock);

      const poller = new UpdatePoller(defaultConfig);
      const handler1: number[] = [];
      const handler2: number[] = [];
      poller.onUpdate((u) => handler1.push(u.update_id));
      poller.onUpdate((u) => handler2.push(u.update_id));

      poller.start();
      await vi.advanceTimersByTimeAsync(0);

      poller.stop();
      expect(handler1).toEqual([1]);
      expect(handler2).toEqual([1]);
    });
  });

  describe('offset tracking', () => {
    it('sends no offset on first poll', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(mockGetUpdatesResponse([]))
        .mockImplementation(() => new Promise(() => {}));

      vi.stubGlobal('fetch', fetchMock);

      const poller = new UpdatePoller(defaultConfig);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      poller.stop();

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('timeout=30');
      expect(url).not.toContain('offset=');
    });

    it('uses offset = lastUpdateId + 1 on subsequent polls', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(mockGetUpdatesResponse([makeUpdate(50), makeUpdate(51)]))
        .mockResolvedValueOnce(mockGetUpdatesResponse([]))
        .mockImplementation(() => new Promise(() => {}));

      vi.stubGlobal('fetch', fetchMock);

      const poller = new UpdatePoller(defaultConfig);
      poller.onUpdate(() => {});
      poller.start();

      // Let first poll complete and second poll start
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      poller.stop();

      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      const secondUrl = fetchMock.mock.calls[1][0] as string;
      expect(secondUrl).toContain('offset=52');
    });
  });

  describe('start/stop lifecycle', () => {
    it('does not double-start if already running', async () => {
      const fetchMock = vi.fn()
        .mockImplementation(() => new Promise(() => {}));

      vi.stubGlobal('fetch', fetchMock);

      const poller = new UpdatePoller(defaultConfig);
      poller.start();
      poller.start(); // second call should be a no-op

      await vi.advanceTimersByTimeAsync(0);
      poller.stop();

      // Only one poll loop should have started
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('stops gracefully after current poll', async () => {
      let resolveHangingFetch: ((value: Response) => void) | undefined;
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(mockGetUpdatesResponse([makeUpdate(1)]))
        .mockImplementation(() => new Promise((resolve) => { resolveHangingFetch = resolve; }));

      vi.stubGlobal('fetch', fetchMock);

      const poller = new UpdatePoller(defaultConfig);
      const received: number[] = [];
      poller.onUpdate((u) => received.push(u.update_id));

      poller.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(received).toEqual([1]);
      poller.stop();

      // Resolve the hanging fetch so the loop can exit
      if (resolveHangingFetch) {
        resolveHangingFetch(mockGetUpdatesResponse([]));
      }
      await vi.advanceTimersByTimeAsync(0);

      // No more updates should be processed after stop
      expect(received).toEqual([1]);
    });
  });

  describe('error handling and backoff', () => {
    it('retries with backoff on fetch failure', async () => {
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce(mockGetUpdatesResponse([makeUpdate(10)]))
        .mockImplementation(() => new Promise(() => {}));

      vi.stubGlobal('fetch', fetchMock);

      const poller = new UpdatePoller(defaultConfig);
      const received: number[] = [];
      poller.onUpdate((u) => received.push(u.update_id));

      poller.start();

      // First poll fails, backoff attempt 0 = 1000ms
      await vi.advanceTimersByTimeAsync(0); // trigger first fetch (fails)
      await vi.advanceTimersByTimeAsync(1000); // wait for backoff
      await vi.advanceTimersByTimeAsync(0); // trigger second fetch (succeeds)

      poller.stop();
      expect(received).toEqual([10]);
    });

    it('retries with backoff on non-ok HTTP response', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
        .mockResolvedValueOnce(mockGetUpdatesResponse([makeUpdate(20)]))
        .mockImplementation(() => new Promise(() => {}));

      vi.stubGlobal('fetch', fetchMock);

      const poller = new UpdatePoller(defaultConfig);
      const received: number[] = [];
      poller.onUpdate((u) => received.push(u.update_id));

      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);

      poller.stop();
      expect(received).toEqual([20]);
    });

    it('increases backoff on consecutive failures', async () => {
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockResolvedValueOnce(mockGetUpdatesResponse([makeUpdate(30)]))
        .mockImplementation(() => new Promise(() => {}));

      vi.stubGlobal('fetch', fetchMock);

      const poller = new UpdatePoller(defaultConfig);
      const received: number[] = [];
      poller.onUpdate((u) => received.push(u.update_id));

      poller.start();

      // First failure: backoff 1000ms
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);

      // Second failure: backoff 2000ms
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2000);

      // Third attempt succeeds
      await vi.advanceTimersByTimeAsync(0);

      poller.stop();
      expect(received).toEqual([30]);
      expect(fetchMock).toHaveBeenCalledTimes(4); // 3 attempts + 1 hanging
    });

    it('resets backoff after successful poll', async () => {
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce(mockGetUpdatesResponse([makeUpdate(40)]))
        .mockRejectedValueOnce(new Error('fail again'))
        .mockResolvedValueOnce(mockGetUpdatesResponse([makeUpdate(41)]))
        .mockImplementation(() => new Promise(() => {}));

      vi.stubGlobal('fetch', fetchMock);

      const poller = new UpdatePoller(defaultConfig);
      const received: number[] = [];
      poller.onUpdate((u) => received.push(u.update_id));

      poller.start();

      // First failure: backoff 1000ms (attempt 0)
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);

      // Success — backoff resets
      await vi.advanceTimersByTimeAsync(0);

      // Second failure: backoff should be 1000ms again (attempt 0, not 2000ms)
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);

      // Success
      await vi.advanceTimersByTimeAsync(0);

      poller.stop();
      expect(received).toEqual([40, 41]);
    });

    it('caps backoff at maxBackoffMs', async () => {
      const config = { ...defaultConfig, maxBackoffMs: 3000 };
      const failures = Array.from({ length: 5 }, () =>
        vi.fn().mockRejectedValue(new Error('fail'))
      );

      const fetchMock = vi.fn()
        .mockRejectedValueOnce(new Error('fail')) // attempt 0: 1000ms
        .mockRejectedValueOnce(new Error('fail')) // attempt 1: 2000ms
        .mockRejectedValueOnce(new Error('fail')) // attempt 2: 3000ms (capped)
        .mockRejectedValueOnce(new Error('fail')) // attempt 3: 3000ms (capped)
        .mockResolvedValueOnce(mockGetUpdatesResponse([makeUpdate(50)]))
        .mockImplementation(() => new Promise(() => {}));

      vi.stubGlobal('fetch', fetchMock);

      const poller = new UpdatePoller(config);
      const received: number[] = [];
      poller.onUpdate((u) => received.push(u.update_id));

      poller.start();

      // attempt 0 fails, backoff 1000ms
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);

      // attempt 1 fails, backoff 2000ms
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2000);

      // attempt 2 fails, backoff 3000ms (capped)
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3000);

      // attempt 3 fails, backoff 3000ms (still capped)
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3000);

      // attempt 4 succeeds
      await vi.advanceTimersByTimeAsync(0);

      poller.stop();
      expect(received).toEqual([50]);
    });
  });

  describe('API URL construction', () => {
    it('calls the correct Telegram getUpdates endpoint', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(mockGetUpdatesResponse([]))
        .mockImplementation(() => new Promise(() => {}));

      vi.stubGlobal('fetch', fetchMock);

      const poller = new UpdatePoller(defaultConfig);
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      poller.stop();

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('https://api.telegram.org/bottest-token/getUpdates');
      expect(url).toContain('timeout=30');
    });
  });

  describe('resume from last offset', () => {
    it('resumes from last known offset after failure', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(mockGetUpdatesResponse([makeUpdate(200), makeUpdate(201)]))
        .mockRejectedValueOnce(new Error('connection lost'))
        .mockResolvedValueOnce(mockGetUpdatesResponse([makeUpdate(202)]))
        .mockImplementation(() => new Promise(() => {}));

      vi.stubGlobal('fetch', fetchMock);

      const poller = new UpdatePoller(defaultConfig);
      const received: number[] = [];
      poller.onUpdate((u) => received.push(u.update_id));

      poller.start();

      // First poll succeeds with updates 200, 201 → offset becomes 202
      await vi.advanceTimersByTimeAsync(0);

      // Second poll fails → backoff
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);

      // Third poll succeeds — should use offset=202
      await vi.advanceTimersByTimeAsync(0);

      poller.stop();

      expect(received).toEqual([200, 201, 202]);

      // Verify the third call used offset=202
      const thirdUrl = fetchMock.mock.calls[2][0] as string;
      expect(thirdUrl).toContain('offset=202');
    });
  });
});
