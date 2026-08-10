#!/usr/bin/env bash
# Registers the native messaging host so the extension's launch/stop buttons work.
# Run once:  bash native-host/install.sh   (pass an extension ID to override auto-detect)
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
HOST_PY="$SCRIPT_DIR/host.py"
TEMPLATE="$SCRIPT_DIR/com.vishal.x_summariser.json"
EXT_DIR="$( cd "$SCRIPT_DIR/../extension" && pwd )"
STATE_DIR="$HOME/.x_summariser"
LAUNCHER="$STATE_DIR/launcher.sh"

[ -f "$HOST_PY" ]   || { echo "error: $HOST_PY not found"; exit 1; }
[ -f "$TEMPLATE" ]  || { echo "error: $TEMPLATE not found"; exit 1; }

# Chromium derives an unpacked extension's ID from the absolute load path:
# sha256(path) -> first 32 hex chars -> each nibble mapped 0-f to a-p.
if [ $# -ge 1 ]; then
  EXT_ID="$1"
else
  EXT_ID="$(python3 -c '
import hashlib, sys
h = hashlib.sha256(sys.argv[1].encode()).hexdigest()[:32]
print("".join(chr(ord("a") + int(c, 16)) for c in h))
' "$EXT_DIR")"
fi

# The browser launches the host with a bare PATH, so call python by absolute
# path through a generated launcher instead of relying on the shebang resolving.
PYTHON=""
for candidate in "$HOME/.x_summariser_venv/bin/python3" /usr/bin/python3 /opt/homebrew/bin/python3; do
  [ -x "$candidate" ] && { PYTHON="$candidate"; break; }
done
[ -n "$PYTHON" ] || { echo "error: no python3 found"; exit 1; }

chmod +x "$HOST_PY"
mkdir -p "$STATE_DIR"
cat > "$LAUNCHER" <<EOF
#!/bin/bash
exec "$PYTHON" "$HOST_PY" "\$@"
EOF
chmod +x "$LAUNCHER"

TARGETS=(
  "$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
)

installed=0
for dir in "${TARGETS[@]}"; do
  [ -d "$(dirname "$dir")" ] || continue
  mkdir -p "$dir"
  sed -e "s|__HOST_PATH__|$LAUNCHER|g" -e "s|__EXTENSION_ID__|$EXT_ID|g" \
    "$TEMPLATE" > "$dir/com.vishal.x_summariser.json"
  echo "installed: $dir/com.vishal.x_summariser.json"
  installed=1
done

[ "$installed" -eq 1 ] || { echo "no chromium-based browser profiles found"; exit 1; }

echo
echo "extension id: $EXT_ID   (from $EXT_DIR)"
echo "python:       $PYTHON"
echo
echo "next: reload the extension at arc://extensions (or chrome://extensions),"
echo "then open x.com — the sidebar header shows a launch/stop control."
echo "if the id above doesn't match the one shown on the extensions page,"
echo "re-run: bash native-host/install.sh <that-id>"
