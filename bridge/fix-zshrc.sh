#!/bin/bash
# Fix zshrc - remove broken kiro entries and add correct ones

# Remove ALL kiro-cdp and kiro-bridge related lines
sed -i '' '/kiro-cdp/d' ~/.zshrc
sed -i '' '/kiro-bridge/d' ~/.zshrc
sed -i '' '/# Kiro-Telegram Bridge/d' ~/.zshrc
sed -i '' '/local port=.CDP_PORT/d' ~/.zshrc
sed -i '' '/Kiro\.app.*Electron.*remote-debugging/d' ~/.zshrc

# Remove any orphan } or function lines left over
sed -i '' '/^}$/d' ~/.zshrc
sed -i '' '/^function kiro/d' ~/.zshrc

# Add correct entries - one-liner function (no multiline issues)
printf '\n# Kiro-Telegram Bridge\nfunction kiro-cdp { local port=${CDP_PORT:-9000}; /Applications/Kiro.app/Contents/MacOS/Electron --remote-debugging-port=$port "$@"; }\nalias kiro-bridge="node /Users/itmanz/Workspace/pixelzlab/docs/kiro-telegram-integration/bridge/index.js"\n' >> ~/.zshrc

echo "✅ Fixed! Run: unalias kiro-cdp 2>/dev/null; source ~/.zshrc"
