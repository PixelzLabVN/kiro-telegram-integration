#!/bin/bash
# Launch Kiro with CDP (Chrome DevTools Protocol) enabled
# Usage: ./launch-kiro.sh [project-path]
#
# This enables the Telegram bridge to connect to Kiro via CDP.

CDP_PORT=${CDP_PORT:-9000}
KIRO_APP="/Applications/Kiro.app/Contents/MacOS/Electron"

if [ ! -f "$KIRO_APP" ]; then
  echo "❌ Kiro not found at $KIRO_APP"
  echo "   Please install Kiro or update the path."
  exit 1
fi

echo "🚀 Launching Kiro with CDP on port $CDP_PORT..."

if [ -n "$1" ]; then
  "$KIRO_APP" --remote-debugging-port="$CDP_PORT" "$1" &
else
  "$KIRO_APP" --remote-debugging-port="$CDP_PORT" &
fi

KIRO_PID=$!
echo "✅ Kiro started (PID: $KIRO_PID)"
echo "🔗 CDP endpoint: http://127.0.0.1:$CDP_PORT"
echo ""
echo "Now run the bridge:"
echo "  cd bridge && npm start"
