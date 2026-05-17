import type { PendingRequest, RequestResult } from './types.js';

/**
 * Manages the lifecycle of pending requests in an in-memory registry.
 *
 * Each request is stored in a Map keyed by its unique ID. A timeout timer
 * is started when a request is added; if the timeout elapses without a
 * response, the request is automatically resolved as `timed_out` and removed.
 */
export class RequestRegistry {
  private readonly requests = new Map<string, PendingRequest>();

  /**
   * Add a new pending request and start its timeout timer.
   *
   * The timeout timer will resolve the request with `timed_out` status
   * when `timeoutMs` elapses, then remove it from the registry.
   *
   * @param request - The pending request to register. Its `timeoutHandle`
   *   field will be overwritten with the newly created timer.
   */
  add(request: PendingRequest): void {
    const timeoutHandle = setTimeout(() => {
      this.resolve(request.id, {
        requestId: request.id,
        status: 'timed_out',
      });
    }, request.timeoutMs);

    request.timeoutHandle = timeoutHandle;
    this.requests.set(request.id, request);
  }

  /**
   * Look up a pending request by its unique ID.
   *
   * @param requestId - The unique identifier of the request.
   * @returns The pending request, or `undefined` if not found.
   */
  get(requestId: string): PendingRequest | undefined {
    return this.requests.get(requestId);
  }

  /**
   * Check if a request ID exists and is still pending.
   *
   * @param requestId - The unique identifier to check.
   * @returns `true` if the request is in the registry.
   */
  isPending(requestId: string): boolean {
    return this.requests.has(requestId);
  }

  /**
   * Get the count of currently pending requests.
   *
   * @returns The number of pending requests in the registry.
   */
  pendingCount(): number {
    return this.requests.size;
  }

  /**
   * Resolve a request with a result, clear its timeout timer, and remove it.
   *
   * Calls the request's `resolve` callback with the provided result.
   * If the request ID is not found, this is a no-op.
   *
   * @param requestId - The unique identifier of the request to resolve.
   * @param result - The result to pass to the request's resolve callback.
   */
  resolve(requestId: string, result: RequestResult): void {
    const request = this.requests.get(requestId);
    if (!request) return;

    clearTimeout(request.timeoutHandle);
    this.requests.delete(requestId);
    request.resolve(result);
  }

  /**
   * Remove a request from the registry and clear its timeout timer.
   *
   * Does not call the request's resolve callback. If the request ID
   * is not found, this is a no-op.
   *
   * @param requestId - The unique identifier of the request to remove.
   */
  remove(requestId: string): void {
    const request = this.requests.get(requestId);
    if (!request) return;

    clearTimeout(request.timeoutHandle);
    this.requests.delete(requestId);
  }
  /**
   * Find a pending request by its Telegram message ID.
   *
   * Iterates over all pending requests to find one whose `messageId` matches
   * the given value. Used by the ResponseRouter to match text replies to
   * information requests via `reply_to_message.message_id`.
   *
   * @param messageId - The Telegram message ID to search for.
   * @returns The matching pending request, or `undefined` if not found.
   */
  findByMessageId(messageId: number): PendingRequest | undefined {
    for (const request of this.requests.values()) {
      if (request.messageId === messageId) {
        return request;
      }
    }
    return undefined;
  }
}
