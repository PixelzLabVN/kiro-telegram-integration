import type { TelegramConfig, ActionContext, SentMessage } from './types.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const MAX_MESSAGE_LENGTH = 4096;
const TRUNCATION_SUFFIX = '\n\n⚠️ _Message truncated\\. Full details available in Kiro IDE\\._';
const TRUNCATION_THRESHOLD = MAX_MESSAGE_LENGTH - TRUNCATION_SUFFIX.length;

/**
 * Escape special characters for Telegram MarkdownV2 format.
 *
 * @param text - The raw text to escape.
 * @returns The escaped text safe for MarkdownV2 parsing.
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Truncate a message to fit within Telegram's 4096-character limit.
 *
 * If the content exceeds 4096 characters, it is truncated at 4050 characters
 * and a truncation indicator is appended.
 *
 * @param content - The message content to potentially truncate.
 * @returns The content, truncated if necessary.
 */
export function truncateMessage(content: string): string {
  if (content.length <= MAX_MESSAGE_LENGTH) {
    return content;
  }
  return content.slice(0, TRUNCATION_THRESHOLD) + TRUNCATION_SUFFIX;
}

/**
 * Format a confirmation request message in MarkdownV2.
 *
 * @param context - The action context describing the pending action.
 * @param timeoutMinutes - The timeout in minutes for the request.
 * @returns The formatted MarkdownV2 message string.
 */
export function formatConfirmationMessage(context: ActionContext, timeoutMinutes: number): string {
  const escapedType = escapeMarkdownV2(context.actionType);
  const escapedSummary = escapeMarkdownV2(context.summary);
  const escapedFiles = context.affectedFiles
    .map((f) => escapeMarkdownV2(f))
    .join('\n');

  return (
    `🔔 *Action Required*\n\n` +
    `*Type:* ${escapedType}\n` +
    `*Summary:* ${escapedSummary}\n` +
    `*Files:*\n${escapedFiles}\n\n` +
    `_Reply within ${timeoutMinutes} minutes or this request will expire\\._`
  );
}

/**
 * Format an information request message in MarkdownV2.
 *
 * @param prompt - The question or prompt text.
 * @param context - Relevant context about the current operation.
 * @param timeoutMinutes - The timeout in minutes for the request.
 * @returns The formatted MarkdownV2 message string.
 */
export function formatInformationMessage(prompt: string, context: string, timeoutMinutes: number): string {
  const escapedPrompt = escapeMarkdownV2(prompt);
  const escapedContext = escapeMarkdownV2(context);

  return (
    `❓ *Information Needed*\n\n` +
    `${escapedPrompt}\n\n` +
    `_Context:_ ${escapedContext}\n\n` +
    `_Reply to this message with your answer\\. This request expires in ${timeoutMinutes} minutes\\._`
  );
}

/**
 * Determine whether a failed request should be retried.
 *
 * Retries on HTTP 5xx errors and network errors. Does NOT retry on HTTP 4xx errors.
 *
 * @param error - The error or response status to evaluate.
 * @returns True if the request should be retried.
 */
function isRetryable(status: number | undefined): boolean {
  // No status means a network error — retryable
  if (status === undefined) return true;
  // 5xx server errors are retryable
  return status >= 500;
}

/**
 * Calculate exponential backoff delay for a given attempt.
 *
 * @param attempt - The zero-based attempt index.
 * @param maxBackoffMs - The maximum backoff interval in milliseconds.
 * @returns The delay in milliseconds.
 */
export function calculateBackoff(attempt: number, maxBackoffMs: number): number {
  return Math.min(1000 * Math.pow(2, attempt), maxBackoffMs);
}

/**
 * MessageSender handles formatting and sending messages to the Telegram Bot API.
 *
 * Includes retry logic with exponential backoff for transient failures,
 * and message truncation to respect Telegram's 4096-character limit.
 */
export class MessageSender {
  private readonly config: TelegramConfig;

  /**
   * Create a new MessageSender.
   *
   * @param config - The Telegram configuration including bot token, chat ID, and retry settings.
   */
  constructor(config: TelegramConfig) {
    this.config = config;
  }

  /**
   * Send a confirmation request with Approve/Cancel inline keyboard.
   *
   * Formats the action context as a MarkdownV2 message and attaches an inline
   * keyboard with "Approve" and "Cancel" buttons. Callback data is encoded as
   * `{requestId}:approve` and `{requestId}:cancel`.
   *
   * @param context - The action context describing the pending action.
   * @param requestId - The unique identifier for this request.
   * @returns The sent message details.
   */
  async sendConfirmationRequest(context: ActionContext, requestId: string): Promise<SentMessage> {
    const timeoutMinutes = Math.round(this.config.timeoutMs / 60_000);
    const text = truncateMessage(formatConfirmationMessage(context, timeoutMinutes));

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `${requestId}:approve` },
          { text: '❌ Cancel', callback_data: `${requestId}:cancel` },
        ],
      ],
    };

    return this.callSendMessage(text, 'MarkdownV2', inlineKeyboard);
  }

  /**
   * Send an information request with ForceReply markup.
   *
   * Formats the prompt and context as a MarkdownV2 message and attaches
   * `force_reply: true` markup so the user's Telegram client prompts a direct reply.
   *
   * @param prompt - The question or prompt text.
   * @param context - Relevant context about the current operation.
   * @param requestId - The unique identifier for this request.
   * @returns The sent message details.
   */
  async sendInformationRequest(prompt: string, context: string, requestId: string): Promise<SentMessage> {
    const timeoutMinutes = Math.round(this.config.timeoutMs / 60_000);
    const text = truncateMessage(formatInformationMessage(prompt, context, timeoutMinutes));

    const replyMarkup = {
      force_reply: true as const,
      selective: true as const,
    };

    return this.callSendMessage(text, 'MarkdownV2', replyMarkup);
  }

  /**
   * Edit an existing Telegram message.
   *
   * Used to update messages when a request times out or expires.
   *
   * @param messageId - The ID of the message to edit.
   * @param text - The new text content for the message.
   */
  async editMessage(messageId: number, text: string): Promise<void> {
    const url = `${TELEGRAM_API_BASE}/bot${this.config.botToken}/editMessageText`;
    const body = {
      chat_id: this.config.chatId,
      message_id: messageId,
      text: truncateMessage(text),
    };

    await this.fetchWithRetry(url, body);
  }

  /**
   * Edit a message to update its text and remove the inline keyboard.
   *
   * Used after a confirmation request is approved or cancelled to show
   * the result and remove the Approve/Cancel buttons.
   *
   * @param messageId - The ID of the message to edit.
   * @param text - The new text content for the message.
   */
  async editMessageRemoveKeyboard(messageId: number, text: string): Promise<void> {
    const url = `${TELEGRAM_API_BASE}/bot${this.config.botToken}/editMessageText`;
    const body = {
      chat_id: this.config.chatId,
      message_id: messageId,
      text: truncateMessage(text),
      reply_markup: { inline_keyboard: [] },
    };

    await this.fetchWithRetry(url, body);
  }


  /**
   * Send a plain text notification message.
   *
   * @param text - The notification text to send.
   * @returns The sent message details.
   */
  async sendNotification(text: string): Promise<SentMessage> {
    return this.callSendMessage(truncateMessage(text));
  }

  /**
   * Send a message via the Telegram sendMessage API with optional parse mode and reply markup.
   */
  private async callSendMessage(
    text: string,
    parseMode?: string,
    replyMarkup?: unknown,
  ): Promise<SentMessage> {
    const url = `${TELEGRAM_API_BASE}/bot${this.config.botToken}/sendMessage`;
    const body: Record<string, unknown> = {
      chat_id: this.config.chatId,
      text,
    };

    if (parseMode) {
      body.parse_mode = parseMode;
    }
    if (replyMarkup) {
      body.reply_markup = replyMarkup;
    }

    const data = await this.fetchWithRetry(url, body);

    return {
      messageId: data.result.message_id,
      chatId: String(this.config.chatId),
      timestamp: Date.now(),
    };
  }

  /**
   * Execute a fetch request with retry logic and exponential backoff.
   *
   * Retries on HTTP 5xx and network errors up to `maxRetries` times.
   * Does NOT retry on HTTP 4xx errors.
   *
   * @param url - The Telegram API URL.
   * @param body - The JSON request body.
   * @returns The parsed JSON response.
   * @throws Error if all attempts fail.
   */
  private async fetchWithRetry(url: string, body: Record<string, unknown>): Promise<any> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (response.ok) {
          return await response.json();
        }

        // Do not retry on 4xx client errors
        if (!isRetryable(response.status)) {
          const errorBody = await response.text().catch(() => '');
          throw new Error(
            `Telegram API error ${response.status}: ${errorBody}`,
          );
        }

        // 5xx — will retry
        lastError = new Error(`Telegram API error ${response.status}`);
      } catch (err: unknown) {
        if (err instanceof Error && err.message.startsWith('Telegram API error 4')) {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
      }

      // Wait before retrying (skip delay after last attempt)
      if (attempt < this.config.maxRetries) {
        const delay = calculateBackoff(attempt, this.config.maxBackoffMs);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError ?? new Error('All retry attempts failed');
  }
}
