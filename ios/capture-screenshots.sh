#!/bin/bash
#
# capture-screenshots.sh
#
# Captures App Store screenshots from the running iOS Simulator.
# Requires: Xcode, iOS Simulator with HogaresRD installed and logged in.
#
# Usage:
#   1. Build & run HogaresRD in Simulator (iPhone 16 Pro Max for 6.7")
#   2. Log in and navigate to each screen manually
#   3. Run: bash ios/capture-screenshots.sh <screen_name>
#      Example: bash ios/capture-screenshots.sh feed
#
# Or capture all screens at once (interactive — pauses between each):
#   bash ios/capture-screenshots.sh --all
#
# Output goes to ios/screenshots/appstore/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/screenshots/appstore"
mkdir -p "$OUT_DIR"

# Get the booted simulator device ID
DEVICE_ID=$(xcrun simctl list devices booted -j | python3 -c "
import json, sys
data = json.load(sys.stdin)
for runtime, devices in data.get('devices', {}).items():
    for d in devices:
        if d.get('state') == 'Booted':
            print(d['udid'])
            sys.exit(0)
print('', file=sys.stderr)
sys.exit(1)
" 2>/dev/null) || {
    echo "Error: No booted simulator found. Start one in Xcode first."
    exit 1
}

DEVICE_NAME=$(xcrun simctl list devices booted -j | python3 -c "
import json, sys
data = json.load(sys.stdin)
for runtime, devices in data.get('devices', {}).items():
    for d in devices:
        if d.get('state') == 'Booted':
            print(d['name'])
            sys.exit(0)
")

echo "Capturing from: $DEVICE_NAME ($DEVICE_ID)"
echo "Output: $OUT_DIR/"
echo ""

capture() {
    local name="$1"
    local filename="${name}.png"
    xcrun simctl io "$DEVICE_ID" screenshot "$OUT_DIR/$filename"
    echo "  Saved: $filename"
}

if [[ "${1:-}" == "--all" ]]; then
    SCREENS=("01_feed" "02_explorar" "03_listing_detail" "04_mapa" "05_mensajes" "06_perfil")

    echo "Interactive screenshot capture. Navigate to each screen when prompted."
    echo ""

    for screen in "${SCREENS[@]}"; do
        read -p "Navigate to ${screen} and press Enter to capture... "
        capture "$screen"
    done

    echo ""
    echo "Done! ${#SCREENS[@]} screenshots saved to $OUT_DIR/"
    echo ""
    echo "Required sizes for App Store:"
    echo "  6.7\" (iPhone 16 Pro Max): 1320 x 2868 — use 'iPhone 16 Pro Max' simulator"
    echo "  5.5\" (iPhone 8 Plus):     1242 x 2208 — use 'iPhone 8 Plus' simulator"
    echo ""
    echo "To capture for the other size, switch simulators and run again."
else
    if [[ -z "${1:-}" ]]; then
        echo "Usage:"
        echo "  bash $0 <screen_name>   # capture single screenshot"
        echo "  bash $0 --all           # interactive capture of all screens"
        echo ""
        echo "Screen names: feed, explorar, listing_detail, mapa, mensajes, perfil"
        exit 0
    fi
    capture "$1"
fi
