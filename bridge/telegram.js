/**
 * Telegram Bot API service using long polling.
 * Handles incoming messages, inline keyboard buttons, and callback queries.
 */

const API_BASE = (token) => `https://api.telegram.org/bot${token}`;

/**
 * Create a Telegram bot instance with inline button support
 * @param {string} token - Bot token
 * @param {string} chatId - Target chat ID
 */
export function createTelegramBot(token, chatId) {
  let offset = 0;
  let polling = false;
  let messageHandler = null;
  let commandHandlers = new Map();
  let callbackHandler = null;

  async function apiCall(method, body = {}) {
    const res = await fetch(`${API_BASE(token)}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
    return data.result;
  }

  async function sendMessage(text, options = {}) {
    const body = {
      chat_id: chatId,
      reply_markup: options.replyMarkup || undefined,
    };

    // Support @gramio/format FormattableString (has text + entities)
    if (options.entities) {
      body.text = options.text || text;
      body.entities = options.entities;
    } else {
      body.text = text;
      if (options.parseMode) body.parse_mode = options.parseMode;
    }

    return apiCall('sendMessage', body);
  }

  /**
   * Send a formatted message using @gramio/format FormattableString
   * @param {import('@gramio/format').FormattableString} formatted
   */
  async function sendFormatted(formatted, options = {}) {
    return sendMessage(formatted.text, {
      entities: formatted.entities,
      replyMarkup: options.replyMarkup,
    });
  }

  async function sendMarkdown(text) {
    return sendMessage(text, { parseMode: 'MarkdownV2' });
  }

  async function sendHTML(text) {
    return sendMessage(text, { parseMode: 'HTML' });
  }

  /**
   * Send a message with inline keyboard buttons
   * @param {string} text - Message text
   * @param {Array<Array<{text: string, callback_data: string}>>} buttons - 2D array of buttons
   */
  async function sendWithButtons(text, buttons) {
    return sendMessage(text, {
      replyMarkup: JSON.stringify({
        inline_keyboard: buttons,
      }),
    });
  }

  /**
   * Send an action prompt with inline buttons
   * @param {string} prompt - What Kiro is asking
   * @param {Array<{label: string, action: string}>} actions - Available actions
   */
  async function sendActionPrompt(prompt, actions) {
    const buttons = [
      actions.map((a) => ({
        text: a.label,
        callback_data: a.action,
      })),
    ];

    const text =
      `┌─ ⚡ ACTION REQUIRED ─────────────\n` +
      `│\n` +
      `│ 🤖 ${prompt}\n` +
      `│\n` +
      `└─────────────────────────────────`;

    return sendWithButtons(text, buttons);
  }

  /**
   * Answer a callback query (removes loading state from button)
   */
  async function answerCallback(callbackQueryId, text = '') {
    return apiCall('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  /**
   * Edit a message to show which action was taken
   */
  async function editMessage(messageId, newText) {
    return apiCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: newText,
    });
  }

  async function getUpdates() {
    try {
      const updates = await apiCall('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message', 'callback_query'],
      });

      for (const update of updates) {
        offset = update.update_id + 1;

        // Handle callback queries (inline button presses)
        if (update.callback_query) {
          const cb = update.callback_query;
          if (String(cb.message?.chat?.id) !== String(chatId)) continue;

          if (callbackHandler) {
            await callbackHandler(cb.data, cb);
          }

          // Acknowledge the callback
          await answerCallback(cb.id, `✓ ${cb.data}`).catch(() => {});
          continue;
        }

        // Handle text messages
        if (update.message && update.message.text) {
          const msg = update.message;
          if (String(msg.chat.id) !== String(chatId)) continue;

          const text = msg.text.trim();

          // Check for commands
          if (text.startsWith('/')) {
            const [cmd, ...args] = text.split(' ');
            const handler = commandHandlers.get(cmd);
            if (handler) {
              await handler(args.join(' '), msg);
              continue;
            }
          }

          // Regular message
          if (messageHandler) {
            await messageHandler(text, msg);
          }
        }
      }
    } catch (err) {
      if (!err.message?.includes('ETIMEDOUT')) {
        console.error('[Telegram] Polling error:', err.message);
      }
    }
  }

  async function startPolling() {
    polling = true;
    console.log('[Telegram] Bot polling started');
    while (polling) {
      await getUpdates();
    }
  }

  function stopPolling() {
    polling = false;
  }

  function onMessage(handler) {
    messageHandler = handler;
  }

  function onCommand(command, handler) {
    commandHandlers.set(command, handler);
  }

  function onCallback(handler) {
    callbackHandler = handler;
  }

  return {
    sendMessage,
    sendFormatted,
    sendMarkdown,
    sendHTML,
    sendWithButtons,
    sendActionPrompt,
    answerCallback,
    editMessage,
    startPolling,
    stopPolling,
    onMessage,
    onCommand,
    onCallback,
    apiCall,
  };
}
