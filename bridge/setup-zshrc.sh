#!/bin/bash
# Setup kiro-cdp function and kiro-bridge alias in ~/.zshrc

# Remove old entries
sed -i '' '/kiro-cdp/d' ~/.zshrc
sed -i '' '/kiro-bridge/d' ~/.zshrc
sed -i '' '/# Kiro-Telegram Bridge/d' ~/.zshrc

# Add new entries
echo '' >> ~/.zshrc
echo '# Kiro-Telegram Bridge' >> ~/.zshrc
echo 'function kiro-cdp {' >> ~/.zshrc
echo '  local port=${CDP_PORT:-9000}' >> ~/.zshrc
echo '  /Applications/Kiro.app/Contents/MacOS/Electron --remote-debugging-port=$port "$@"' >> ~/.zshrc
echo '}' >> ~/.zshrc
echo 'alias kiro-bridge="node /Users/itmanz/Workspace/pixelzlab/docs/kiro-telegram-integration/bridge/index.js"' >> ~/.zshrc

echo "✅ Done! Run: source ~/.zshrc"
