import type {
  TelegramConfig,
  ActionContext,
  RequestResult,
  PendingRequest,
} from './types.js';
import { validateConfig, verifyConnectivity } from './ConfigManager.js';
import { MessageSender } from './MessageSender.js';
import { RequestRegistry } from './RequestRegistry.js';
import { UpdatePoller } from './UpdatePoller.js';
import { ResponseRouter } from './ResponseRouter.js';

/**
 * IntegrationService is the main entry point for the Kiro Telegram integration.
 *
 * Both the MCP server adapter and VS Code extension adapter call this class
 * to send confirmation/information requests and receive user responses via Telegram.
 */
export class IntegrationService {
  private config!: TelegramConfig;
  private sender!: MessageSender;
  private registry!: RequestRegistry;
  private poller!: UpdatePoller;
  private router!: ResponseRouter;
  private initialized = false;
  private botUsername?: string;
  private readonly activeRequestIds = new Set<string>();

  /**
   * Initialize the service with a pre-built TelegramConfig.
   *
   * Validates the config, verifies connectivity to the Telegram Bot API,
   * creates all internal components, starts polling, and wires the update
   * handler to the response router.
   *
   * @param config - The Telegram configuration to use.
   * @throws Error if config validation fails or connectivity cannot be verified.
   */
  async initialize(config: TelegramConfig): Promise<void> {
    const validation = validateConfig(config);
    if (!validation.valid) {
      throw new Error(`Invalid configuration: ${validation.errors.join('; ')}`);
    }

    const connectivity = await verifyConnectivity(config);
    if (!connectivity.connected) {
      throw new Error(`Telegram connectivity check failed: ${connectivity.error}`);
    }

    this.config = config;
    this.botUsername = connectivity.botUsername;
    this.sender = new MessageSender(config);
    this.registry = new RequestRegistry();
    this.poller = new UpdatePoller(config);
    this.router = new ResponseRouter(this.registry, this.sender, config);

    this.poller.onUpdate((update) => {
      this.router.routeUpdate(update);
    });

    this.poller.start();
    this.initialized = true;
  }

  /**
   * Request user confirmation for an action.
   *
   * Sends a confirmation message to Telegram with Approve/Cancel buttons and
   * returns a promise that resolves when the user responds or the timeout elapses.
   * On timeout, the original Telegram message is edited to show expiry.
   *
   * @param context - The action context describing the pending action.
   * @returns A promise that resolves with the user's decision.
   * @throws Error if the service has not been initialized.
   */
  async requestConfirmation(context: ActionContext): Promise<RequestResult> {
    this.ensureInitialized();

    const requestId = crypto.randomUUID();
    const sent = await this.sender.sendConfirmationRequest(context, requestId);

    this.activeRequestIds.add(requestId);

    return new Promise<RequestResult>((resolve) => {
      const request: PendingRequest = {
        id: requestId,
        type: 'confirmation',
        status: 'pending',
        messageId: sent.messageId,
        createdAt: Date.now(),
        timeoutMs: this.config.timeoutMs,
        timeoutHandle: undefined as unknown as ReturnType<typeof setTimeout>,
        resolve: (result) => {
          this.activeRequestIds.delete(requestId);
          if (result.status === 'timed_out') {
            this.sender.editMessageRemoveKeyboard(sent.messageId, '⏰ This request has expired.').catch(() => {});
          }
          resolve(result);
        },
      };

      this.registry.add(request);
    });
  }

  /**
   * Request additional information from the user.
   *
   * Sends an information request message to Telegram with ForceReply markup and
   * returns a promise that resolves when the user replies or the timeout elapses.
   * On timeout, the original Telegram message is edited to show expiry.
   *
   * @param prompt - The question or prompt text.
   * @param context - Relevant context about the current operation.
   * @returns A promise that resolves with the user's reply.
   * @throws Error if the service has not been initialized.
   */
  async requestInformation(prompt: string, context: string): Promise<RequestResult> {
    this.ensureInitialized();

    const requestId = crypto.randomUUID();
    const sent = await this.sender.sendInformationRequest(prompt, context, requestId);

    this.activeRequestIds.add(requestId);

    return new Promise<RequestResult>((resolve) => {
      const request: PendingRequest = {
        id: requestId,
        type: 'information',
        status: 'pending',
        messageId: sent.messageId,
        createdAt: Date.now(),
        timeoutMs: this.config.timeoutMs,
        timeoutHandle: undefined as unknown as ReturnType<typeof setTimeout>,
        resolve: (result) => {
          this.activeRequestIds.delete(requestId);
          if (result.status === 'timed_out') {
            this.sender.editMessageRemoveKeyboard(sent.messageId, '⏰ This request has expired.').catch(() => {});
          }
          resolve(result);
        },
      };

      this.registry.add(request);
    });
  }

  /**
   * Shut down the service, cleaning up timers and polling.
   *
   * Stops the update poller and resolves all pending requests as timed_out.
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    this.poller.stop();

    // Resolve all tracked pending requests as timed_out
    for (const requestId of [...this.activeRequestIds]) {
      this.registry.resolve(requestId, {
        requestId,
        status: 'timed_out',
      });
    }

    this.initialized = false;
  }

  /**
   * Get the current status of the integration.
   *
   * @returns An object with connection status, bot username, and pending request count.
   */
  getStatus(): { connected: boolean; botUsername?: string; pendingRequests: number } {
    return {
      connected: this.initialized,
      botUsername: this.botUsername,
      pendingRequests: this.initialized ? this.registry.pendingCount() : 0,
    };
  }

  /**
   * Send a one-way notification message to Telegram.
   *
   * @param message - The notification text to send.
   * @returns The sent message details.
   * @throws Error if the service has not been initialized.
   */
  async sendNotification(message: string): Promise<{ messageId: number }> {
    this.ensureInitialized();
    const sent = await this.sender.sendNotification(message);
    return { messageId: sent.messageId };
  }

  /**
   * Ensure the service has been initialized before use.
   * @throws Error if initialize() has not been called.
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('IntegrationService has not been initialized. Call initialize() first.');
    }
  }
}
