/**
 * Chrome DevTools Protocol (CDP) service.
 * Discovers Kiro IDE instances and communicates via WebSocket.
 */

import WebSocket from 'ws';

const CDP_PORTS = [9000, 9001, 9002, 9003, 9222];
const DISCOVERY_TIMEOUT = 3000;

/**
 * Fetch CDP targets from a debugging port
 */
async function fetchTargets(port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, {
      signal: controller.signal,
    });
    return await res.json();
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Connect to a CDP target via WebSocket
 */
function connectWebSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    let msgId = 1;
    const pending = new Map();

    ws.on('open', () => {
      resolve({
        ws,
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = msgId++;
            pending.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params }));
            // Timeout after 10s
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                rej(new Error(`CDP timeout: ${method}`));
              }
            }, 10000);
          });
        },
        close() {
          ws.close();
        },
      });
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id && pending.has(msg.id)) {
          const { resolve: res, reject: rej } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message));
          else res(msg.result);
        }
      } catch { /* ignore parse errors */ }
    });

    ws.on('error', reject);
    ws.on('close', () => {
      for (const { reject: rej } of pending.values()) {
        rej(new Error('WebSocket closed'));
      }
      pending.clear();
    });
  });
}

/**
 * Discover Kiro IDE targets (agent webviews)
 */
export async function discoverKiro(ports = CDP_PORTS) {
  const results = { webviews: [], mainWindow: null };

  for (const port of ports) {
    const targets = await fetchTargets(port);
    if (targets.length > 0) {
      console.log(`[CDP] Port ${port}: ${targets.length} targets found`);
    }

    for (const target of targets) {
      const url = (target.url || '').toLowerCase();
      const title = (target.title || '').toLowerCase();

      // Main VS Code/Kiro window
      if (
        target.type === 'page' &&
        (url.startsWith('vscode-file://') || url.includes('workbench')) &&
        target.webSocketDebuggerUrl
      ) {
        if (!results.mainWindow) {
          results.mainWindow = {
            title: target.title,
            wsUrl: target.webSocketDebuggerUrl,
            port,
          };
        }
      }

      // Kiro Agent webviews — look for kiroAgent in URL (relaxed filter)
      if (
        target.webSocketDebuggerUrl &&
        url.includes('kiroagent')
      ) {
        console.log(`[CDP] Found kiroAgent: type=${target.type} port=${port}`);
        results.webviews.push({
          title: target.title,
          wsUrl: target.webSocketDebuggerUrl,
          port,
          parentId: target.parentId,
        });
      }
    }
  }

  return results;
}

/**
 * Create a CDP connection to a target
 */
export async function createCDPConnection(wsUrl) {
  const cdp = await connectWebSocket(wsUrl);

  // Enable Runtime domain
  await cdp.send('Runtime.enable');

  // Get the execution context — for webviews with nested iframes,
  // we need to find the right context (the one inside active-frame)
  let rootContextId = null;

  try {
    // Try to get all execution contexts
    const contexts = [];
    const originalSend = cdp.send.bind(cdp);

    // Listen for execution context created events
    cdp.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'Runtime.executionContextCreated') {
          contexts.push(msg.params.context);
        }
      } catch {}
    });

    // Wait a bit for contexts to be reported
    await new Promise((r) => setTimeout(r, 500));

    // Use the default context (id from evaluate)
    const testResult = await cdp.send('Runtime.evaluate', {
      expression: '1+1',
      returnByValue: true,
    });

    if (testResult.result?.value === 2) {
      // Get the executionContextId from a simple evaluation
      rootContextId = testResult.executionContextId || null;
    }
  } catch {}

  cdp.rootContextId = rootContextId;
  return cdp;
}

/**
 * Evaluate JavaScript in the CDP target
 */
export async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout: 15000,
  });

  if (result.exceptionDetails) {
    const desc = result.exceptionDetails.exception?.description || 'Evaluation failed';
    // Ignore "Promise was collected" — it means the script ran but took too long to report back
    if (desc.includes('Promise was collected')) {
      return { success: true, method: 'async_fire_and_forget' };
    }
    throw new Error(desc);
  }

  return result.result?.value;
}

/**
 * Inject a message into Kiro's chat input and send it
 * Based on kiro-mobile-bridge's proven injection strategy
 */
export async function injectMessage(cdp, text) {
  const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');

  const script = `(async () => {
    const text = '${escaped}';
    let targetDoc = document;
    const activeFrame = document.getElementById('active-frame');
    if (activeFrame && activeFrame.contentDocument) targetDoc = activeFrame.contentDocument;

    let editor = null;

    // Strategy 1: Find by chat input container patterns
    const inputContainerSelectors = [
      '[class*="chat-input"]',
      '[class*="message-input"]',
      '[class*="composer"]',
      '[class*="input-area"]',
      '[class*="InputArea"]',
      'form[class*="chat"]',
      '[data-testid*="input"]'
    ];

    for (const containerSel of inputContainerSelectors) {
      const container = targetDoc.querySelector(containerSel);
      if (container) {
        const editorInContainer = container.querySelector('.tiptap.ProseMirror[contenteditable="true"], [data-lexical-editor="true"][contenteditable="true"], [contenteditable="true"], textarea');
        if (editorInContainer && editorInContainer.offsetParent !== null) {
          editor = editorInContainer;
          break;
        }
      }
    }

    // Strategy 2: TipTap/ProseMirror near a submit button
    if (!editor) {
      const allEditors = [...targetDoc.querySelectorAll('.tiptap.ProseMirror[contenteditable="true"]')].filter(el => el.offsetParent !== null);
      for (const ed of allEditors) {
        const parent = ed.closest('form') || ed.parentElement?.parentElement?.parentElement;
        if (parent) {
          const hasSubmit = parent.querySelector('button[data-variant="submit"], button[type="submit"], svg.lucide-arrow-right');
          if (hasSubmit) { editor = ed; break; }
        }
      }
      if (!editor && allEditors.length > 0) editor = allEditors.at(-1);
    }

    // Strategy 3: Lexical editors
    if (!editor) {
      const lexicalEditors = [...targetDoc.querySelectorAll('[data-lexical-editor="true"][contenteditable="true"]')].filter(el => el.offsetParent !== null);
      for (const ed of lexicalEditors) {
        const parent = ed.closest('form') || ed.parentElement?.parentElement?.parentElement;
        if (parent) {
          const hasSubmit = parent.querySelector('button[data-variant="submit"], button[type="submit"]');
          if (hasSubmit) { editor = ed; break; }
        }
      }
      if (!editor && lexicalEditors.length > 0) editor = lexicalEditors.at(-1);
    }

    // Strategy 4: Generic contenteditable
    if (!editor) {
      const editables = [...targetDoc.querySelectorAll('[contenteditable="true"]')].filter(el => el.offsetParent !== null);
      editor = editables.at(-1);
    }

    // Strategy 5: Textarea fallback
    if (!editor) {
      const textareas = [...targetDoc.querySelectorAll('textarea')].filter(el => el.offsetParent !== null);
      editor = textareas.at(-1);
    }

    if (!editor) return { success: false, error: 'Chat input not found' };

    const isTextarea = editor.tagName.toLowerCase() === 'textarea';
    const isProseMirror = editor.classList.contains('ProseMirror') || editor.classList.contains('tiptap');
    const isLexical = editor.hasAttribute('data-lexical-editor');

    // Focus the editor
    editor.focus();
    await new Promise(r => setTimeout(r, 50));

    if (isTextarea) {
      editor.value = text;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (isProseMirror) {
      editor.innerHTML = '';
      const p = targetDoc.createElement('p');
      p.textContent = text;
      editor.appendChild(p);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    } else if (isLexical) {
      const selection = targetDoc.getSelection();
      const range = targetDoc.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      targetDoc.execCommand('delete', false, null);
      await new Promise(r => setTimeout(r, 30));
      const inserted = targetDoc.execCommand('insertText', false, text);
      if (!inserted) {
        editor.textContent = text;
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    } else {
      const selection = targetDoc.getSelection();
      const range = targetDoc.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      targetDoc.execCommand('delete', false, null);
      try { targetDoc.execCommand('insertText', false, text); } catch (e) {}
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }

    // Wait for editor state to sync
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise(r => setTimeout(r, 100));

    // Find and click submit button
    const submitButton = targetDoc.querySelector('button[data-variant="submit"]:not([disabled])') ||
                         targetDoc.querySelector('svg.lucide-arrow-right')?.closest('button:not([disabled])') ||
                         targetDoc.querySelector('button[type="submit"]:not([disabled])') ||
                         targetDoc.querySelector('button[aria-label*="send" i]:not([disabled])');

    if (submitButton) {
      submitButton.click();
      return { success: true, method: 'click_submit' };
    }

    // Fallback: Enter key
    editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
    return { success: true, method: 'enter_key' };
  })()`;

  return evaluate(cdp, script);
}

/**
 * Capture the current chat content from Kiro
 */
export async function captureChat(cdp) {
  const script = `
    (function() {
      // Try to find chat messages container
      const selectors = [
        '.chat-messages',
        '[class*="message-list"]',
        '[class*="chat-content"]',
        '[role="log"]',
        '.messages-container',
      ];

      let container = null;
      for (const sel of selectors) {
        container = document.querySelector(sel);
        if (container) break;
      }

      if (!container) {
        // Fallback: get all text content from body
        const body = document.body;
        if (!body) return { messages: [], raw: '' };
        return { messages: [], raw: body.innerText?.substring(0, 5000) || '' };
      }

      // Extract messages
      const messageEls = container.querySelectorAll('[class*="message"], [class*="Message"]');
      const messages = [];

      for (const el of messageEls) {
        const role = el.querySelector('[class*="role"], [class*="author"], [class*="sender"]');
        const content = el.querySelector('[class*="content"], [class*="body"], [class*="text"]');
        messages.push({
          role: role?.textContent?.trim() || 'unknown',
          content: (content || el).textContent?.trim()?.substring(0, 2000) || '',
        });
      }

      return {
        messages: messages.slice(-20), // Last 20 messages
        raw: container.innerText?.substring(0, 5000) || '',
      };
    })()
  `;

  return evaluate(cdp, script);
}

/**
 * Capture task status from Kiro
 */
export async function captureTasks(cdp) {
  const script = `
    (function() {
      // Look for task-related elements
      const taskSelectors = [
        '[class*="task"]',
        '[class*="Task"]',
        '[data-testid*="task"]',
      ];

      let taskContainer = null;
      for (const sel of taskSelectors) {
        taskContainer = document.querySelector(sel);
        if (taskContainer) break;
      }

      if (!taskContainer) return { tasks: [], status: 'unknown' };

      // Check for working/processing indicators
      const isWorking = !!document.querySelector(
        '[class*="working"], [class*="Working"], [class*="progress"], [class*="spinner"], [class*="loading"]'
      );

      const statusEl = document.querySelector('[class*="status"], [class*="Status"]');

      return {
        status: isWorking ? 'working' : 'idle',
        statusText: statusEl?.textContent?.trim() || '',
        content: taskContainer.textContent?.substring(0, 3000) || '',
      };
    })()
  `;

  return evaluate(cdp, script);
}

/**
 * Get Kiro's current working status
 */
export async function captureStatus(cdp) {
  const script = `
    (function() {
      const body = document.body;
      if (!body) return { status: 'disconnected' };

      // Check for working indicators
      const workingIndicators = [
        '[class*="working"]', '[class*="Working"]',
        '[class*="progress"]', '[class*="spinner"]',
        '[class*="loading"]', '[class*="Processing"]',
        'button:has-text("Cancel")',
      ];

      let isWorking = false;
      for (const sel of workingIndicators) {
        try {
          if (document.querySelector(sel)) { isWorking = true; break; }
        } catch {}
      }

      // Get page title/status
      const title = document.title || '';

      return {
        status: isWorking ? 'working' : 'idle',
        title,
        timestamp: Date.now(),
      };
    })()
  `;

  return evaluate(cdp, script);
}

/**
 * Detect action buttons/dialogs in Kiro (trust, cancel, continue, etc.)
 * Returns array of detected buttons with their labels and selectors
 */
export async function detectActionButtons(cdp) {
  const script = `
    (function() {
      const buttons = [];

      // Common action button selectors in Kiro/VS Code
      const buttonSelectors = [
        'button',
        '[role="button"]',
        'a.monaco-button',
        '.dialog-button',
        '.notification-actions button',
      ];

      const actionKeywords = [
        'trust', 'cancel', 'continue', 'allow', 'deny',
        'accept', 'reject', 'yes', 'no', 'ok', 'confirm',
        'proceed', 'skip', 'retry', 'abort', 'approve',
        'run', 'install', 'update', 'restart',
      ];

      for (const sel of buttonSelectors) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            const text = (el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
            if (text && actionKeywords.some(kw => text.includes(kw))) {
              // Generate a unique selector for this button
              const id = el.id ? '#' + el.id : '';
              const cls = el.className ? '.' + el.className.split(' ').filter(c => c).join('.') : '';
              const selector = id || (el.tagName.toLowerCase() + cls);

              buttons.push({
                label: el.textContent?.trim() || el.getAttribute('aria-label') || '',
                selector: selector,
                index: Array.from(el.parentElement?.children || []).indexOf(el),
                tagName: el.tagName.toLowerCase(),
              });
            }
          }
        } catch {}
      }

      // Also check for dialog/notification overlays
      const dialogSelectors = [
        '.monaco-dialog-box',
        '.notification-toast',
        '[class*="dialog"]',
        '[class*="Dialog"]',
        '[role="dialog"]',
        '[role="alertdialog"]',
      ];

      let dialogText = '';
      for (const sel of dialogSelectors) {
        try {
          const dialog = document.querySelector(sel);
          if (dialog) {
            dialogText = dialog.textContent?.substring(0, 300)?.trim() || '';
            break;
          }
        } catch {}
      }

      return {
        hasActions: buttons.length > 0,
        buttons: buttons.slice(0, 5), // Max 5 buttons
        dialogText,
      };
    })()
  `;

  return evaluate(cdp, script);
}

/**
 * Click a specific button in Kiro by its label text
 */
export async function clickButton(cdp, buttonLabel) {
  const script = `
    (function() {
      const label = ${JSON.stringify(buttonLabel.toLowerCase())};

      const allButtons = document.querySelectorAll('button, [role="button"], a.monaco-button');
      for (const btn of allButtons) {
        const text = (btn.textContent || btn.getAttribute('aria-label') || '').trim().toLowerCase();
        if (text.includes(label)) {
          btn.click();
          return { success: true, clicked: btn.textContent?.trim() };
        }
      }

      return { success: false, error: 'Button not found: ' + ${JSON.stringify(buttonLabel)} };
    })()
  `;

  return evaluate(cdp, script);
}
