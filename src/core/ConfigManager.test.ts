import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fromRecord, validateConfig, verifyConnectivity, sanitizeConfig } from './ConfigManager.js';

describe('ConfigManager', () => {
  describe('fromRecord', () => {
    it('reads TELEGRAM_ prefixed env vars', () => {
      const config = fromRecord({
        TELEGRAM_BOT_TOKEN: '123:ABC',
        TELEGRAM_CHAT_ID: '456',
      });
      expect(config.botToken).toBe('123:ABC');
      expect(config.chatId).toBe('456');
    });

    it('reads camelCase keys as fallback', () => {
      const config = fromRecord({
        botToken: 'tok',
        chatId: 'cid',
      });
      expect(config.botToken).toBe('tok');
      expect(config.chatId).toBe('cid');
    });

    it('prefers TELEGRAM_ keys over camelCase', () => {
      const config = fromRecord({
        TELEGRAM_BOT_TOKEN: 'env-token',
        botToken: 'camel-token',
        TELEGRAM_CHAT_ID: 'env-chat',
        chatId: 'camel-chat',
      });
      expect(config.botToken).toBe('env-token');
      expect(config.chatId).toBe('env-chat');
    });

    it('applies defaults for numeric fields when missing', () => {
      const config = fromRecord({});
      expect(config.timeoutMs).toBe(600_000);
      expect(config.maxRetries).toBe(3);
      expect(config.maxBackoffMs).toBe(60_000);
    });

    it('parses numeric fields from strings', () => {
      const config = fromRecord({
        TELEGRAM_TIMEOUT_MS: '30000',
        TELEGRAM_MAX_RETRIES: '5',
        TELEGRAM_MAX_BACKOFF_MS: '120000',
      });
      expect(config.timeoutMs).toBe(30000);
      expect(config.maxRetries).toBe(5);
      expect(config.maxBackoffMs).toBe(120000);
    });

    it('falls back to defaults for non-numeric strings', () => {
      const config = fromRecord({
        TELEGRAM_TIMEOUT_MS: 'not-a-number',
        TELEGRAM_MAX_RETRIES: '',
      });
      expect(config.timeoutMs).toBe(600_000);
      expect(config.maxRetries).toBe(3);
    });

    it('returns empty strings for missing token and chatId', () => {
      const config = fromRecord({});
      expect(config.botToken).toBe('');
      expect(config.chatId).toBe('');
    });
  });

  describe('validateConfig', () => {
    it('returns valid for a complete config', () => {
      const result = validateConfig({
        botToken: '123:ABC',
        chatId: '456',
        timeoutMs: 600_000,
        maxRetries: 3,
        maxBackoffMs: 60_000,
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects empty botToken', () => {
      const result = validateConfig({
        botToken: '',
        chatId: '456',
        timeoutMs: 600_000,
        maxRetries: 3,
        maxBackoffMs: 60_000,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('botToken');
    });

    it('rejects whitespace-only botToken', () => {
      const result = validateConfig({
        botToken: '   ',
        chatId: '456',
        timeoutMs: 600_000,
        maxRetries: 3,
        maxBackoffMs: 60_000,
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('botToken');
    });

    it('rejects empty chatId', () => {
      const result = validateConfig({
        botToken: '123:ABC',
        chatId: '',
        timeoutMs: 600_000,
        maxRetries: 3,
        maxBackoffMs: 60_000,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('chatId');
    });

    it('rejects whitespace-only chatId', () => {
      const result = validateConfig({
        botToken: '123:ABC',
        chatId: '\t\n',
        timeoutMs: 600_000,
        maxRetries: 3,
        maxBackoffMs: 60_000,
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('chatId');
    });

    it('returns two errors when both fields are missing', () => {
      const result = validateConfig({
        botToken: '',
        chatId: '',
        timeoutMs: 600_000,
        maxRetries: 3,
        maxBackoffMs: 60_000,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
    });

    it('includes setup instructions in error messages', () => {
      const result = validateConfig({
        botToken: '',
        chatId: '',
        timeoutMs: 600_000,
        maxRetries: 3,
        maxBackoffMs: 60_000,
      });
      expect(result.errors[0]).toContain('BotFather');
      expect(result.errors[1]).toContain('TELEGRAM_CHAT_ID');
    });
  });

  describe('verifyConnectivity', () => {
    const validConfig = {
      botToken: 'test-token-1234567890',
      chatId: '456',
      timeoutMs: 600_000,
      maxRetries: 3,
      maxBackoffMs: 60_000,
    };

    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns connected with botUsername on success', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { username: 'test_bot' } }), { status: 200 }),
      );

      const result = await verifyConnectivity(validConfig);
      expect(result.connected).toBe(true);
      expect(result.botUsername).toBe('test_bot');
    });

    it('calls the correct getMe URL', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { username: 'bot' } }), { status: 200 }),
      );

      await verifyConnectivity(validConfig);
      expect(fetch).toHaveBeenCalledWith(
        `https://api.telegram.org/bot${validConfig.botToken}/getMe`,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('returns error for 401 (invalid token)', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('Unauthorized', { status: 401 }),
      );

      const result = await verifyConnectivity(validConfig);
      expect(result.connected).toBe(false);
      expect(result.error).toContain('Invalid bot token');
    });

    it('returns error for other HTTP errors', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('Server Error', { status: 500 }),
      );

      const result = await verifyConnectivity(validConfig);
      expect(result.connected).toBe(false);
      expect(result.error).toContain('500');
    });

    it('returns error on network failure', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'));

      const result = await verifyConnectivity(validConfig);
      expect(result.connected).toBe(false);
      expect(result.error).toContain('unreachable');
      expect(result.error).toContain('Network error');
    });
  });

  describe('sanitizeConfig', () => {
    it('masks the botToken', () => {
      const sanitized = sanitizeConfig({
        botToken: '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ',
        chatId: '456',
        timeoutMs: 600_000,
        maxRetries: 3,
        maxBackoffMs: 60_000,
      });
      expect(sanitized.botToken).not.toContain('123456789:ABCdefGHIjklMNOpqrSTUvwxYZ');
      expect(sanitized.botToken).toBe('1234...wxYZ');
    });

    it('fully masks short tokens', () => {
      const sanitized = sanitizeConfig({
        botToken: 'short',
        chatId: '456',
        timeoutMs: 600_000,
        maxRetries: 3,
        maxBackoffMs: 60_000,
      });
      expect(sanitized.botToken).toBe('****');
    });

    it('preserves other fields unchanged', () => {
      const sanitized = sanitizeConfig({
        botToken: '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ',
        chatId: '456',
        timeoutMs: 30000,
        maxRetries: 5,
        maxBackoffMs: 120000,
      });
      expect(sanitized.chatId).toBe('456');
      expect(sanitized.timeoutMs).toBe(30000);
      expect(sanitized.maxRetries).toBe(5);
      expect(sanitized.maxBackoffMs).toBe(120000);
    });

    it('does not contain the original token in JSON serialization', () => {
      const token = '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ';
      const sanitized = sanitizeConfig({
        botToken: token,
        chatId: '456',
        timeoutMs: 600_000,
        maxRetries: 3,
        maxBackoffMs: 60_000,
      });
      const json = JSON.stringify(sanitized);
      expect(json).not.toContain(token);
    });
  });
});
