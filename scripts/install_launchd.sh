#!/bin/bash
# Installs (or reinstalls) the launchd agent that starts the backend at login.
# Run once: bash scripts/install_launchd.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
START_SCRIPT="$SCRIPT_DIR/start_backend.sh"
LABEL="com.x_summariser.backend"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/x_summariser.log"

chmod +x "$START_SCRIPT"

# Unload if already installed
if launchctl list "$LABEL" &>/dev/null; then
  launchctl unload "$PLIST" 2>/dev/null || true
fi

cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>             <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$START_SCRIPT</string>
  </array>
  <key>RunAtLoad</key>         <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>  <false/>
  </dict>
  <key>ThrottleInterval</key>  <integer>15</integer>
  <key>StandardOutPath</key>   <string>$LOG</string>
  <key>StandardErrorPath</key> <string>$LOG</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>            <string>$HOME</string>
    <key>PATH</key>            <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
EOF

launchctl load "$PLIST"
echo "✓ installed — backend will start at login and is starting now"
echo "  logs: $LOG"
echo "  to stop:      launchctl unload ~/Library/LaunchAgents/$LABEL.plist"
echo "  to uninstall: launchctl unload ~/Library/LaunchAgents/$LABEL.plist && rm ~/Library/LaunchAgents/$LABEL.plist"
