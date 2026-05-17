import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { RequestRegistry } from './RequestRegistry.js';
import type { PendingRequest, RequestResult, RequestType } from './types.js';

/** Build a PendingRequest with sensible defaults and the given overrides. */
function makePendingRequest(
  overrides: Partial<PendingRequest> = {},
): PendingRequest {
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

/** Arbitrary for request type. */
const requestTypeArb: fc.Arbitrary<RequestType> = fc.constantFrom('confirmation', 'information');

describe('RequestRegistry property tests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Feature: kiro-telegram-integration, Property 11: Registry add/resolve round trip
  // **Validates: Requirements 7.2, 7.3**
  describe('Property 11: Registry add/resolve round trip', () => {
    test('all added requests are retrievable by ID, and resolving one decreases pending count', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(fc.uuid(), { minLength: 1, maxLength: 20 }),
          requestTypeArb,
          (ids: string[], reqType: RequestType) => {
            const registry = new RequestRegistry();
            const resolveFns = new Map<string, ReturnType<typeof vi.fn>>();

            // Add all requests
            for (const id of ids) {
              const resolveFn = vi.fn();
              resolveFns.set(id, resolveFn);
              registry.add(makePendingRequest({ id, type: reqType, resolve: resolveFn }));
            }

            // All should be retrievable and pending
            expect(registry.pendingCount()).toBe(ids.length);
            for (const id of ids) {
              expect(registry.isPending(id)).toBe(true);
              const req = registry.get(id);
              expect(req).toBeDefined();
              expect(req!.id).toBe(id);
            }

            // Resolve the first request
            const resolvedId = ids[0];
            const countBefore = registry.pendingCount();
            const result: RequestResult = { requestId: resolvedId, status: 'approved' };
            registry.resolve(resolvedId, result);

            // Resolved request should no longer be retrievable
            expect(registry.isPending(resolvedId)).toBe(false);
            expect(registry.get(resolvedId)).toBeUndefined();
            expect(registry.pendingCount()).toBe(countBefore - 1);

            // Resolve callback should have been called
            expect(resolveFns.get(resolvedId)).toHaveBeenCalledWith(result);

            // Remaining requests should still be pending
            for (const id of ids.slice(1)) {
              expect(registry.isPending(id)).toBe(true);
            }

            // Cleanup: remove remaining to clear timers
            for (const id of ids.slice(1)) {
              registry.remove(id);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: kiro-telegram-integration, Property 12: Timeout resolves requests as timed out
  // **Validates: Requirements 4.1, 4.2**
  describe('Property 12: Timeout resolves requests as timed out', () => {
    test('when timeout elapses, request resolves with timed_out status', () => {
      fc.assert(
        fc.property(
          fc.uuid(),
          fc.integer({ min: 100, max: 5000 }),
          requestTypeArb,
          (id: string, timeoutMs: number, reqType: RequestType) => {
            const registry = new RequestRegistry();
            const resolveFn = vi.fn();

            registry.add(makePendingRequest({ id, timeoutMs, type: reqType, resolve: resolveFn }));

            // Before timeout: request should be pending
            expect(registry.isPending(id)).toBe(true);
            expect(resolveFn).not.toHaveBeenCalled();

            // Advance time to exactly the timeout
            vi.advanceTimersByTime(timeoutMs);

            // After timeout: resolve should have been called with timed_out
            expect(resolveFn).toHaveBeenCalledOnce();
            expect(resolveFn).toHaveBeenCalledWith({
              requestId: id,
              status: 'timed_out',
            });

            // Request should be removed from registry
            expect(registry.isPending(id)).toBe(false);
            expect(registry.get(id)).toBeUndefined();
            expect(registry.pendingCount()).toBe(0);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: kiro-telegram-integration, Property 3: All requests receive unique identifiers
  // **Validates: Requirements 2.6, 3.5**
  describe('Property 3: All requests receive unique identifiers', () => {
    test('registry correctly stores and retrieves N requests with N distinct generated IDs', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(fc.uuid(), { minLength: 1, maxLength: 30 }),
          (ids: string[]) => {
            const registry = new RequestRegistry();

            // Add N requests with N unique IDs
            for (const id of ids) {
              registry.add(makePendingRequest({ id }));
            }

            // pendingCount should equal N
            expect(registry.pendingCount()).toBe(ids.length);

            // Each ID should be retrievable
            for (const id of ids) {
              expect(registry.isPending(id)).toBe(true);
              expect(registry.get(id)!.id).toBe(id);
            }

            // The set of IDs should have exactly N distinct elements (guaranteed by fc.uniqueArray)
            expect(new Set(ids).size).toBe(ids.length);

            // Cleanup: remove all to clear timers
            for (const id of ids) {
              registry.remove(id);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
