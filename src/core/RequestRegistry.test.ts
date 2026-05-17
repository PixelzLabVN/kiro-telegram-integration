import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RequestRegistry } from './RequestRegistry.js';
import type { PendingRequest, RequestResult } from './types.js';

function makePendingRequest(
  overrides: Partial<PendingRequest> = {},
): PendingRequest {
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

describe('RequestRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('add', () => {
    it('stores a request retrievable by id', () => {
      const registry = new RequestRegistry();
      const request = makePendingRequest({ id: 'r1' });
      registry.add(request);

      expect(registry.get('r1')).toBe(request);
    });

    it('increments pending count', () => {
      const registry = new RequestRegistry();
      expect(registry.pendingCount()).toBe(0);

      registry.add(makePendingRequest({ id: 'a' }));
      expect(registry.pendingCount()).toBe(1);

      registry.add(makePendingRequest({ id: 'b' }));
      expect(registry.pendingCount()).toBe(2);
    });
  });

  describe('get', () => {
    it('returns undefined for unknown id', () => {
      const registry = new RequestRegistry();
      expect(registry.get('nonexistent')).toBeUndefined();
    });
  });

  describe('isPending', () => {
    it('returns true for a registered request', () => {
      const registry = new RequestRegistry();
      registry.add(makePendingRequest({ id: 'p1' }));
      expect(registry.isPending('p1')).toBe(true);
    });

    it('returns false for an unknown id', () => {
      const registry = new RequestRegistry();
      expect(registry.isPending('unknown')).toBe(false);
    });

    it('returns false after request is resolved', () => {
      const registry = new RequestRegistry();
      registry.add(makePendingRequest({ id: 'p2' }));
      registry.resolve('p2', { requestId: 'p2', status: 'approved' });
      expect(registry.isPending('p2')).toBe(false);
    });
  });

  describe('resolve', () => {
    it('calls the resolve callback with the result', () => {
      const registry = new RequestRegistry();
      const resolveFn = vi.fn();
      registry.add(makePendingRequest({ id: 'r1', resolve: resolveFn }));

      const result: RequestResult = { requestId: 'r1', status: 'approved' };
      registry.resolve('r1', result);

      expect(resolveFn).toHaveBeenCalledOnce();
      expect(resolveFn).toHaveBeenCalledWith(result);
    });

    it('removes the request from the registry', () => {
      const registry = new RequestRegistry();
      registry.add(makePendingRequest({ id: 'r1' }));
      registry.resolve('r1', { requestId: 'r1', status: 'cancelled' });

      expect(registry.get('r1')).toBeUndefined();
      expect(registry.pendingCount()).toBe(0);
    });

    it('clears the timeout timer', () => {
      const registry = new RequestRegistry();
      const resolveFn = vi.fn();
      registry.add(makePendingRequest({ id: 'r1', resolve: resolveFn, timeoutMs: 5000 }));

      registry.resolve('r1', { requestId: 'r1', status: 'approved' });

      // Advance past the timeout — resolve should NOT be called again
      vi.advanceTimersByTime(10_000);
      expect(resolveFn).toHaveBeenCalledOnce();
    });

    it('is a no-op for unknown request id', () => {
      const registry = new RequestRegistry();
      // Should not throw
      registry.resolve('nonexistent', { requestId: 'nonexistent', status: 'approved' });
    });
  });

  describe('remove', () => {
    it('removes the request without calling resolve', () => {
      const registry = new RequestRegistry();
      const resolveFn = vi.fn();
      registry.add(makePendingRequest({ id: 'r1', resolve: resolveFn }));

      registry.remove('r1');

      expect(registry.get('r1')).toBeUndefined();
      expect(registry.pendingCount()).toBe(0);
      expect(resolveFn).not.toHaveBeenCalled();
    });

    it('clears the timeout timer', () => {
      const registry = new RequestRegistry();
      const resolveFn = vi.fn();
      registry.add(makePendingRequest({ id: 'r1', resolve: resolveFn, timeoutMs: 5000 }));

      registry.remove('r1');

      vi.advanceTimersByTime(10_000);
      expect(resolveFn).not.toHaveBeenCalled();
    });

    it('is a no-op for unknown request id', () => {
      const registry = new RequestRegistry();
      registry.remove('nonexistent'); // should not throw
    });
  });

  describe('timeout behavior', () => {
    it('resolves with timed_out when timeout elapses', () => {
      const registry = new RequestRegistry();
      const resolveFn = vi.fn();
      registry.add(makePendingRequest({ id: 't1', resolve: resolveFn, timeoutMs: 3000 }));

      vi.advanceTimersByTime(3000);

      expect(resolveFn).toHaveBeenCalledOnce();
      expect(resolveFn).toHaveBeenCalledWith({
        requestId: 't1',
        status: 'timed_out',
      });
    });

    it('removes the request from registry after timeout', () => {
      const registry = new RequestRegistry();
      registry.add(makePendingRequest({ id: 't2', timeoutMs: 1000 }));

      vi.advanceTimersByTime(1000);

      expect(registry.isPending('t2')).toBe(false);
      expect(registry.pendingCount()).toBe(0);
    });

    it('does not fire timeout if resolved before timeout', () => {
      const registry = new RequestRegistry();
      const resolveFn = vi.fn();
      registry.add(makePendingRequest({ id: 't3', resolve: resolveFn, timeoutMs: 5000 }));

      registry.resolve('t3', { requestId: 't3', status: 'approved' });
      vi.advanceTimersByTime(10_000);

      // Only the explicit resolve call, not the timeout
      expect(resolveFn).toHaveBeenCalledOnce();
      expect(resolveFn).toHaveBeenCalledWith({ requestId: 't3', status: 'approved' });
    });
  });

  describe('concurrent requests', () => {
    it('supports multiple concurrent pending requests', () => {
      const registry = new RequestRegistry();
      registry.add(makePendingRequest({ id: 'c1' }));
      registry.add(makePendingRequest({ id: 'c2' }));
      registry.add(makePendingRequest({ id: 'c3' }));

      expect(registry.pendingCount()).toBe(3);
      expect(registry.isPending('c1')).toBe(true);
      expect(registry.isPending('c2')).toBe(true);
      expect(registry.isPending('c3')).toBe(true);
    });

    it('resolving one does not affect others', () => {
      const registry = new RequestRegistry();
      const resolve1 = vi.fn();
      const resolve2 = vi.fn();
      registry.add(makePendingRequest({ id: 'c1', resolve: resolve1 }));
      registry.add(makePendingRequest({ id: 'c2', resolve: resolve2 }));

      registry.resolve('c1', { requestId: 'c1', status: 'approved' });

      expect(resolve1).toHaveBeenCalledOnce();
      expect(resolve2).not.toHaveBeenCalled();
      expect(registry.isPending('c2')).toBe(true);
      expect(registry.pendingCount()).toBe(1);
    });
  });
});
