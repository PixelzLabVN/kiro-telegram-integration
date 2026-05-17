import type { TelegramConfig, ValidationResult, ConnectivityResult } from './types.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

/**
 * Create a TelegramConfig from raw key-value pairs.
 *
 * Reads bot token and chat ID from environment-style keys (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
 * or camelCase keys (botToken, chatId). Numeric options fall back to sensible defaults.
 *
 * @param record - A flat record of string key-value pairs (e.g. process.env).
 * @returns A fully populated TelegramConfig.
 */
export function fromRecord(record: Record<string, string | undefined>): TelegramConfig {
  const botToken = record['TELEGRAM_BOT_TOKEN'] ?? record['botToken'] ?? '';
  const chatId = record['TELEGRAM_CHAT_ID'] ?? record['chatId'] ?? '';

  const timeoutMs = parseIntOrDefault(
    record['TELEGRAM_TIMEOUT_MS'] ?? record['timeoutMs'],
    600_000,
  );
  const maxRetries = parseIntOrDefault(
    record['TELEGRAM_MAX_RETRIES'] ?? record['maxRetries'],
    3,
  );
  const maxBackoffMs = parseIntOrDefault(
    record['TELEGRAM_MAX_BACKOFF_MS'] ?? record['maxBackoffMs'],
    60_000,
  );

  return { botToken, chatId, timeoutMs, maxRetries, maxBackoffMs };
}

/**
 * Validate that a TelegramConfig has the required fields populated.
 *
 * Rejects missing, empty, or whitespace-only botToken and chatId values.
 * Returns descriptive error messages with setup instructions when validation fails.
 *
 * @param config - The TelegramConfig to validate.
 * @returns A ValidationResult indicating whether the config is valid.
 */
export function validateConfig(config: TelegramConfig): ValidationResult {
  const errors: string[] = [];

  if (!config.botToken || config.botToken.trim().length === 0) {
    errors.push(
      'botToken is required. Create a bot via https://t.me/BotFather and set TELEGRAM_BOT_TOKEN.',
    );
  }

  if (!config.chatId || config.chatId.trim().length === 0) {
    errors.push(
      'chatId is required. Send a message to your bot and retrieve the chat ID, then set TELEGRAM_CHAT_ID.',
    );
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Verify connectivity to the Telegram Bot API by calling the getMe endpoint.
 *
 * @param config - A TelegramConfig with a botToken to verify.
 * @returns A ConnectivityResult indicating whether the bot is reachable.
 */
export async function verifyConnectivity(config: TelegramConfig): Promise<ConnectivityResult> {
  const url = `${TELEGRAM_API_BASE}/bot${config.botToken}/getMe`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        connected: false,
        error: response.status === 401
          ? 'Invalid bot token. Please verify your TELEGRAM_BOT_TOKEN.'
          : `Telegram API returned HTTP ${response.status}: ${body}`,
      };
    }

    const data = (await response.json()) as { ok: boolean; result?: { username?: string } };

    if (data.ok && data.result?.username) {
      return { connected: true, botUsername: data.result.username };
    }

    return { connected: false, error: 'Unexpected response from Telegram getMe endpoint.' };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      connected: false,
      error: `Telegram Bot API is unreachable: ${message}`,
    };
  }
}

/**
 * Create a sanitized copy of a TelegramConfig safe for logging or serialization.
 *
 * The botToken is replaced with a masked placeholder so it is never exposed
 * in logs, error messages, or serialized output.
 *
 * @param config - The TelegramConfig to sanitize.
 * @returns A new object with the botToken masked.
 */
export function sanitizeConfig(config: TelegramConfig): Record<string, unknown> {
  return {
    botToken: maskToken(config.botToken),
    chatId: config.chatId,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    maxBackoffMs: config.maxBackoffMs,
  };
}

/** Parse a string as an integer, returning the default if parsing fails or the value is undefined. */
function parseIntOrDefault(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/** Mask a bot token, showing only the first 4 and last 4 characters. */
function maskToken(token: string): string {
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}
