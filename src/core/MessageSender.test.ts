import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  escapeMarkdownV2,
  truncateMessage,
  formatConfirmationMessage,
  formatInformationMessage,
  calculateBackoff,
  MessageSender,
} from './MessageSender.js';
import type { TelegramConfig, ActionContext } from './types.js';

const defaultConfig: TelegramConfig = {
  botToken: 'test-token-123',
  chatId: '999',
  timeoutMs: 600_000,
  maxRetries: 3,
  maxBackoffMs: 60_000,
};

function mockFetchSuccess(messageId = 42) {
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ ok: true, result: { message_id: messageId } }),
      { status: 200 },
    ),
  );
}

describe('escapeMarkdownV2', () => {
  it('escapes all MarkdownV2 special characters', () => {
    const input = '_*[]()~`>#+\\-=|{}.!';
    const result = escapeMarkdownV2(input);
    expect(result).toBe('\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\\\\\-\\=\\|\\{\\}\\.\\!');
  });

  it('leaves plain text unchanged', () => {
    expect(escapeMarkdownV2('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(escapeMarkdownV2('')).toBe('');
  });
});

describe('truncateMessage', () => {
  it('returns short messages unchanged', () => {
    const msg = 'Hello';
    expect(truncateMessage(msg)).toBe(msg);
  });

  it('returns messages at exactly 4096 chars unchanged', () => {
    const msg = 'a'.repeat(4096);
    expect(truncateMessage(msg)).toBe(msg);
  });

  it('truncates messages exceeding 4096 chars', () => {
    const msg = 'a'.repeat(5000);
    const result = truncateMessage(msg);
    expect(result.length).toBeLessThanOrEqual(4096);
    expect(result).toContain('truncated');
  });

  it('truncates and appends indicator, total within 4096', () => {
    const msg = 'a'.repeat(4097);
    const result = truncateMessage(msg);
    expect(result.length).toBeLessThanOrEqual(4096);
    expect(result).toContain('⚠️');
    expect(result).toContain('truncated');
  });
});

describe('formatConfirmationMessage', () => {
  it('includes action type, summary, and files', () => {
    const ctx: ActionContext = {
      actionType: 'File Edit',
      summary: 'Refactor utils',
      affectedFiles: ['src/utils.ts', 'src/index.ts'],
    };
    const msg = formatConfirmationMessage(ctx, 10);
    expect(msg).toContain('Action Required');
    expect(msg).toContain('File Edit');
    expect(msg).toContain('Refactor utils');
    expect(msg).toContain('src/utils\\.ts');
    expect(msg).toContain('src/index\\.ts');
    expect(msg).toContain('10 minutes');
  });

  it('escapes special characters in context fields', () => {
    const ctx: ActionContext = {
      actionType: 'test_action',
      summary: 'summary (with parens)',
      affectedFiles: ['file[0].ts'],
    };
    const msg = formatConfirmationMessage(ctx, 5);
    expect(msg).toContain('test\\_action');
    expect(msg).toContain('\\(with parens\\)');
    expect(msg).toContain('file\\[0\\]\\.ts');
  });
});

describe('formatInformationMessage', () => {
  it('includes prompt and context', () => {
    const msg = formatInformationMessage('What is the API key?', 'Deploying to prod', 10);
    expect(msg).toContain('Information Needed');
    expect(msg).toContain('What is the API key?');
    expect(msg).toContain('Deploying to prod');
    expect(msg).toContain('10 minutes');
  });
});

describe('calculateBackoff', () => {
  it('returns 1000ms for attempt 0', () => {
    expect(calculateBackoff(0, 60_000)).toBe(1000);
  });

  it('doubles each attempt', () => {
    expect(calculateBackoff(1, 60_000)).toBe(2000);
    expect(calculateBackoff(2, 60_000)).toBe(4000);
    expect(calculateBackoff(3, 60_000)).toBe(8000);
  });

  it('caps at maxBackoffMs', () => {
    expect(calculateBackoff(20, 60_000)).toBe(60_000);
  });

  it('respects a small maxBackoffMs', () => {
    expect(calculateBackoff(5, 5000)).toBe(5000);
  });
});

describe('MessageSender', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetchSuccess());
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('sendConfirmationRequest', () => {
    it('sends a MarkdownV2 message with inline keyboard', async () => {
      const sender = new MessageSender(defaultConfig);
      const ctx: ActionContext = {
        actionType: 'Edit',
        summary: 'Change file',
        affectedFiles: ['a.ts'],
      };

      const result = await sender.sendConfirmationRequest(ctx, 'req-1');

      expect(result.messageId).toBe(42);
      expect(result.chatId).toBe('999');

      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toContain('/sendMessage');
      const body = JSON.parse(call[1]!.body as string);
      expect(body.chat_id).toBe('999');
      expect(body.parse_mode).toBe('MarkdownV2');
      expect(body.text).toContain('Action Required');
      expect(body.reply_markup.inline_keyboard[0]).toHaveLength(2);
      expect(body.reply_markup.inline_keyboard[0][0].callback_data).toBe('req-1:approve');
      expect(body.reply_markup.inline_keyboard[0][1].callback_data).toBe('req-1:cancel');
    });

    it('uses configured chatId', async () => {
      const config = { ...defaultConfig, chatId: '12345' };
      const sender = new MessageSender(config);
      await sender.sendConfirmationRequest(
        { actionType: 'x', summary: 'y', affectedFiles: [] },
        'r1',
      );

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.chat_id).toBe('12345');
    });
  });

  describe('sendInformationRequest', () => {
    it('sends a MarkdownV2 message with force_reply markup', async () => {
      const sender = new MessageSender(defaultConfig);
      const result = await sender.sendInformationRequest('What?', 'Some context', 'req-2');

      expect(result.messageId).toBe(42);

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.parse_mode).toBe('MarkdownV2');
      expect(body.text).toContain('Information Needed');
      expect(body.text).toContain('What?');
      expect(body.reply_markup.force_reply).toBe(true);
      expect(body.reply_markup.selective).toBe(true);
    });
  });

  describe('editMessage', () => {
    it('calls editMessageText API', async () => {
      const sender = new MessageSender(defaultConfig);
      await sender.editMessage(100, 'Updated text');

      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[0]).toContain('/editMessageText');
      const body = JSON.parse(call[1]!.body as string);
      expect(body.chat_id).toBe('999');
      expect(body.message_id).toBe(100);
      expect(body.text).toBe('Updated text');
    });
  });

  describe('sendNotification', () => {
    it('sends a plain text message without parse_mode', async () => {
      const sender = new MessageSender(defaultConfig);
      const result = await sender.sendNotification('Hello!');

      expect(result.messageId).toBe(42);
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.text).toBe('Hello!');
      expect(body.parse_mode).toBeUndefined();
      expect(body.reply_markup).toBeUndefined();
    });
  });

  describe('retry logic', () => {
    it('retries on 5xx errors', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
        .mockResolvedValueOnce(new Response('Server Error', { status: 502 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
        );
      vi.stubGlobal('fetch', fetchMock);

      const sender = new MessageSender(defaultConfig);
      const result = await sender.sendNotification('test');

      expect(result.messageId).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does not retry on 4xx errors', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response('Bad Request', { status: 400 }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const sender = new MessageSender(defaultConfig);
      await expect(sender.sendNotification('test')).rejects.toThrow('400');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries on network errors', async () => {
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 }),
        );
      vi.stubGlobal('fetch', fetchMock);

      const sender = new MessageSender(defaultConfig);
      const result = await sender.sendNotification('test');

      expect(result.messageId).toBe(7);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws after exhausting all retries', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response('Server Error', { status: 500 }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const sender = new MessageSender({ ...defaultConfig, maxRetries: 2 });
      await expect(sender.sendNotification('test')).rejects.toThrow();
      // 1 initial + 2 retries = 3 total
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe('message truncation in send methods', () => {
    it('truncates long confirmation messages', async () => {
      const sender = new MessageSender(defaultConfig);
      const ctx: ActionContext = {
        actionType: 'Edit',
        summary: 'x'.repeat(5000),
        affectedFiles: [],
      };

      await sender.sendConfirmationRequest(ctx, 'req-t');

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.text.length).toBeLessThanOrEqual(4096);
      expect(body.text).toContain('truncated');
    });

    it('truncates long notification messages', async () => {
      const sender = new MessageSender(defaultConfig);
      await sender.sendNotification('z'.repeat(5000));

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.text.length).toBeLessThanOrEqual(4096);
    });
  });
});
