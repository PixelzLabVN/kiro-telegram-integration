import type { TelegramConfig, TelegramUpdate } from './types.js';
import { calculateBackoff } from './MessageSender.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
/** Long-polling timeout in seconds sent to Telegram's getUpdates. */
const POLL_TIMEOUT_SECONDS = 30;

/**
 * UpdatePoller handles long-polling the Telegram Bot API for incoming updates.
 *
 * It continuously calls the `getUpdates` endpoint, tracks the last processed
 * `update_id`, and uses exponential backoff on failures. Registered handlers
 * are invoked for each incoming `TelegramUpdate`.
 */
export class UpdatePoller {
  private readonly config: TelegramConfig;
  private running = false;
  private offset: number | undefined;
  private handlers: Array<(update: TelegramUpdate) => void> = [];
  private backoffAttempt = 0;

  /**
   * Create a new UpdatePoller.
   *
   * @param config - The Telegram configuration including bot token and backoff settings.
   */
  constructor(config: TelegramConfig) {
    this.config = config;
  }

  /**
   * Start the long-polling loop.
   *
   * Begins calling Telegram's `getUpdates` endpoint in a loop. Each successful
   * poll advances the offset to `lastUpdateId + 1`. On failure, reconnects
   * with exponential backoff capped at `maxBackoffMs`.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollLoop();
  }

  /**
   * Stop the polling loop gracefully.
   *
   * Sets the running flag to false so the loop exits after the current
   * poll request completes.
   */
  stop(): void {
    this.running = false;
  }

  /**
   * Register a callback handler for incoming Telegram updates.
   *
   * @param handler - A function invoked for each `TelegramUpdate` received.
   */
  onUpdate(handler: (update: TelegramUpdate) => void): void {
    this.handlers.push(handler);
  }

  /**
   * The internal polling loop. Runs as long as `running` is true.
   * On success, processes updates and resets backoff. On failure,
   * waits with exponential backoff before retrying.
   */
  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.fetchUpdates();
        this.backoffAttempt = 0;

        for (const update of updates) {
          this.offset = update.update_id + 1;
          for (const handler of this.handlers) {
            handler(update);
          }
        }
      } catch {
        if (!this.running) break;
        const delay = calculateBackoff(this.backoffAttempt, this.config.maxBackoffMs);
        this.backoffAttempt++;
        await this.sleep(delay);
      }
    }
  }

  /**
   * Call the Telegram `getUpdates` endpoint with the current offset.
   *
   * @returns An array of `TelegramUpdate` objects from the API response.
   * @throws Error if the request fails or the response is not ok.
   */
  private async fetchUpdates(): Promise<TelegramUpdate[]> {
    const url = new URL(`${TELEGRAM_API_BASE}/bot${this.config.botToken}/getUpdates`);
    url.searchParams.set('timeout', String(POLL_TIMEOUT_SECONDS));
    if (this.offset !== undefined) {
      url.searchParams.set('offset', String(this.offset));
    }

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Telegram API error ${response.status}`);
    }

    const data = (await response.json()) as { ok: boolean; result: TelegramUpdate[] };
    if (!data.ok) {
      throw new Error('Telegram API returned ok: false');
    }

    return data.result;
  }

  /**
   * Sleep for the given number of milliseconds.
   *
   * @param ms - Duration to sleep in milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
