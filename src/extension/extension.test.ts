import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so mock fns are available inside the hoisted vi.mock factory
const {
  mockGet,
  mockGetConfiguration,
  mockShowWarningMessage,
  mockShowErrorMessage,
  mockShowInformationMessage,
  mockStatusBarItem,
  mockCreateStatusBarItem,
  mockRegisterCommand,
  mockExecuteCommand,
} = vi.hoisted(() => {
  const mockGet = vi.fn();
  const mockGetConfiguration = vi.fn(() => ({ get: mockGet }));
  const mockShowWarningMessage = vi.fn();
  const mockShowErrorMessage = vi.fn();
  const mockShowInformationMessage = vi.fn();
  const mockStatusBarItem = {
    text: '',
    tooltip: '',
    command: '',
    show: vi.fn(),
    dispose: vi.fn(),
  };
  const mockCreateStatusBarItem = vi.fn(() => mockStatusBarItem);
  const mockRegisterCommand = vi.fn(() => ({ dispose: vi.fn() }));
  const mockExecuteCommand = vi.fn();
  return {
    mockGet,
    mockGetConfiguration,
    mockShowWarningMessage,
    mockShowErrorMessage,
    mockShowInformationMessage,
    mockStatusBarItem,
    mockCreateStatusBarItem,
    mockRegisterCommand,
    mockExecuteCommand,
  };
});

vi.mock('vscode', () => ({
  workspace: { getConfiguration: mockGetConfiguration },
  window: {
    showWarningMessage: mockShowWarningMessage,
    showErrorMessage: mockShowErrorMessage,
    showInformationMessage: mockShowInformationMessage,
    createStatusBarItem: mockCreateStatusBarItem,
  },
  commands: {
    registerCommand: mockRegisterCommand,
    executeCommand: mockExecuteCommand,
  },
  StatusBarAlignment: { Right: 2 },
}));

// Mock fetch globally for verifyConnectivity
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { activate, deactivate, getService } from './extension.js';
import { registerCommands } from './commands.js';
import { createStatusBar, updateStatusBar } from './statusBar.js';

function makeContext(): { subscriptions: { dispose: () => void }[] } {
  return { subscriptions: [] };
}

describe('activate()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatusBarItem.text = '';
    mockStatusBarItem.tooltip = '';
    mockStatusBarItem.command = '';
  });

  it('reads config from VS Code settings', async () => {
    mockGet.mockImplementation((key: string) => {
      if (key === 'botToken') return 'test-token-123';
      if (key === 'chatId') return '99999';
      if (key === 'timeoutMinutes') return 5;
      return undefined;
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { username: 'test_bot' } }),
    });

    const ctx = makeContext();
    await activate(ctx as any);

    expect(mockGetConfiguration).toHaveBeenCalledWith('kiroTelegram');
    expect(mockGet).toHaveBeenCalledWith('botToken', '');
    expect(mockGet).toHaveBeenCalledWith('chatId', '');
    expect(mockGet).toHaveBeenCalledWith('timeoutMinutes', 10);

    await deactivate();
  });

  it('shows warning when config is invalid (missing token and chatId)', async () => {
    mockGet.mockImplementation((_key: string, defaultVal: unknown) => defaultVal ?? '');

    const ctx = makeContext();
    await activate(ctx as any);

    expect(mockShowWarningMessage).toHaveBeenCalledTimes(1);
    const msg = mockShowWarningMessage.mock.calls[0][0] as string;
    expect(msg).toContain('Kiro Telegram:');
    expect(msg).toContain('botToken');
  });

  it('does not initialize service when config is invalid', async () => {
    mockGet.mockImplementation((_key: string, defaultVal: unknown) => defaultVal ?? '');

    const ctx = makeContext();
    await activate(ctx as any);

    expect(getService()).toBeUndefined();
  });

  it('initializes service when config is valid and connectivity succeeds', async () => {
    mockGet.mockImplementation((key: string) => {
      if (key === 'botToken') return 'valid-token';
      if (key === 'chatId') return '12345';
      if (key === 'timeoutMinutes') return 10;
      return undefined;
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { username: 'my_bot' } }),
    });

    const ctx = makeContext();
    await activate(ctx as any);

    expect(getService()).toBeDefined();
    await deactivate();
  });

  it('shows error when initialization fails', async () => {
    mockGet.mockImplementation((key: string) => {
      if (key === 'botToken') return 'bad-token';
      if (key === 'chatId') return '12345';
      if (key === 'timeoutMinutes') return 10;
      return undefined;
    });

    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const ctx = makeContext();
    await activate(ctx as any);

    expect(mockShowErrorMessage).toHaveBeenCalledTimes(1);
    expect(getService()).toBeUndefined();
  });
});

describe('registerCommands()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers all 3 commands', () => {
    const ctx = makeContext();
    registerCommands(ctx as any);

    expect(mockRegisterCommand).toHaveBeenCalledTimes(3);
    const names = mockRegisterCommand.mock.calls.map((c) => c[0]);
    expect(names).toContain('kiroTelegram.configure');
    expect(names).toContain('kiroTelegram.testConnection');
    expect(names).toContain('kiroTelegram.status');
  });

  it('pushes disposables to context subscriptions', () => {
    const ctx = makeContext();
    registerCommands(ctx as any);

    expect(ctx.subscriptions.length).toBe(3);
  });
});

describe('statusBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatusBarItem.text = '';
    mockStatusBarItem.tooltip = '';
    mockStatusBarItem.command = '';
  });

  it('creates and shows a status bar item', () => {
    const ctx = makeContext();
    createStatusBar(ctx as any);

    expect(mockCreateStatusBarItem).toHaveBeenCalledWith(2, 100);
    expect(mockStatusBarItem.command).toBe('kiroTelegram.status');
    expect(mockStatusBarItem.show).toHaveBeenCalled();
  });

  it('shows disconnected state when no service is running', () => {
    const ctx = makeContext();
    createStatusBar(ctx as any);

    expect(mockStatusBarItem.text).toContain('Telegram');
    expect(mockStatusBarItem.tooltip).toContain('Not connected');
  });
});
