/** Configuration for the Telegram Bot integration. */
export interface TelegramConfig {
  botToken: string;
  chatId: string;
  /** Timeout for pending requests in milliseconds. Default: 600_000 (10 minutes). */
  timeoutMs: number;
  /** Maximum number of retry attempts for failed API calls. Default: 3. */
  maxRetries: number;
  /** Maximum backoff interval in milliseconds for exponential backoff. Default: 60_000. */
  maxBackoffMs: number;
}

/** Describes the pending Kiro action requiring user input. */
export interface ActionContext {
  actionType: string;
  affectedFiles: string[];
  summary: string;
}

/** Represents a message successfully sent to Telegram. */
export interface SentMessage {
  messageId: number;
  chatId: string;
  timestamp: number;
}

/** The type of request sent to the user. */
export type RequestType = 'confirmation' | 'information';

/** The lifecycle status of a pending request. */
export type RequestStatus = 'pending' | 'approved' | 'cancelled' | 'answered' | 'timed_out';

/** A request awaiting user response, stored in the RequestRegistry. */
export interface PendingRequest {
  id: string;
  type: RequestType;
  status: RequestStatus;
  messageId: number;
  createdAt: number;
  timeoutMs: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
  resolve: (result: RequestResult) => void;
}

/** The result of a resolved request, returned to the caller. */
export interface RequestResult {
  requestId: string;
  status: RequestStatus;
  /** Reply text for information requests. */
  data?: string;
}

/** Result of validating a TelegramConfig. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Result of verifying connectivity to the Telegram Bot API. */
export interface ConnectivityResult {
  connected: boolean;
  botUsername?: string;
  error?: string;
}

/** A single update received from the Telegram Bot API. */
export interface TelegramUpdate {
  update_id: number;
  callback_query?: CallbackQuery;
  message?: TelegramMessage;
}

/** A callback query triggered by an inline keyboard button tap. */
export interface CallbackQuery {
  id: string;
  data: string;
  message: TelegramMessage;
}

/** A Telegram message object. */
export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  reply_to_message?: TelegramMessage;
}

/** Result of routing an incoming update to a pending request. */
export interface RoutingResult {
  matched: boolean;
  requestId?: string;
  error?: string;
}
