#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  cat <<EOF
usage: $0 <EXTENSION_ID>

to get your extension ID:
  1. open chrome://extensions (or arc://extensions)
  2. enable 'developer mode'
  3. click 'load unpacked' and select the 'extension/' directory
  4. copy the ID shown under the extension's name (32 lowercase letters)
EOF
  exit 1
fi

EXT_ID="$1"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
HOST_PATH="$SCRIPT_DIR/host.py"
TEMPLATE="$SCRIPT_DIR/com.vishal.x_summariser.json"

if [ ! -f "$HOST_PATH" ]; then
  echo "error: $HOST_PATH not found"
  exit 1
fi

chmod +x "$HOST_PATH"

# install for any chromium-based browser the user has
TARGETS=(
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
)

installed_any=0
for dir in "${TARGETS[@]}"; do
  parent="$(dirname "$dir")"
  if [ ! -d "$parent" ]; then
    continue
  fi
  mkdir -p "$dir"
  manifest="$dir/com.vishal.x_summariser.json"
  sed -e "s|__HOST_PATH__|$HOST_PATH|g" -e "s|__EXTENSION_ID__|$EXT_ID|g" \
    "$TEMPLATE" > "$manifest"
  echo "installed: $manifest"
  installed_any=1
done

if [ "$installed_any" -eq 0 ]; then
  echo "no supported browser profiles found under ~/Library/Application Support/"
  exit 1
fi

echo
echo "done. reload the extension and click the toolbar icon."
