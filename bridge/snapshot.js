/**
 * Snapshot diffing service.
 * Tracks changes in Kiro's chat and notifies when new content appears.
 */

/**
 * Create a snapshot tracker that detects changes
 */
export function createSnapshotTracker() {
  let lastChatHash = '';
  let lastStatus = 'unknown';
  let lastMessageCount = 0;

  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return hash.toString(36);
  }

  /**
   * Check if chat content has changed
   * @returns {{ changed: boolean, newMessages: string[], statusChanged: boolean, status: string }}
   */
  function diff(chatData, statusData) {
    const result = {
      changed: false,
      newContent: '',
      statusChanged: false,
      status: statusData?.status || 'unknown',
      previousStatus: lastStatus,
    };

    // Check status change
    if (statusData?.status && statusData.status !== lastStatus) {
      result.statusChanged = true;
      lastStatus = statusData.status;
    }

    // Check chat content change
    if (chatData) {
      const currentHash = hashString(chatData.raw || JSON.stringify(chatData.messages));

      if (currentHash !== lastChatHash) {
        result.changed = true;
        lastChatHash = currentHash;

        // Extract new messages
        if (chatData.messages && chatData.messages.length > lastMessageCount) {
          const newMsgs = chatData.messages.slice(lastMessageCount);
          result.newContent = newMsgs
            .map((m) => `${m.role}: ${m.content}`)
            .join('\n\n');
          lastMessageCount = chatData.messages.length;
        } else if (chatData.raw) {
          result.newContent = chatData.raw.substring(0, 2000);
        }
      }
    }

    return result;
  }

  function reset() {
    lastChatHash = '';
    lastStatus = 'unknown';
    lastMessageCount = 0;
  }

  return { diff, reset };
}

/**
 * Format a status change for Telegram
 */
export function formatStatusChange(status, previousStatus) {
  const icons = {
    working: '⚙️',
    idle: '💤',
    disconnected: '🔌',
    unknown: '❓',
  };

  const icon = icons[status] || '❓';
  return `${icon} Kiro Status: ${previousStatus} → ${status}`;
}

/**
 * Format new chat content for Telegram
 */
export function formatChatUpdate(content) {
  if (!content) return null;

  // Truncate if too long for Telegram (4096 char limit)
  const maxLen = 3500;
  const truncated = content.length > maxLen
    ? content.substring(0, maxLen) + '\n\n... (truncated)'
    : content;

  return `💬 Kiro Chat Update:\n\n${truncated}`;
}
