#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
HELPER_DIR="$REPO_ROOT/helper/macos-gesture-helper"
SRC="$HELPER_DIR/egdesk_gesture_helper.m"
OUT="$HELPER_DIR/.build/egdesk-gesture-helper"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[ERROR] macOS helper is only supported on Darwin."
  exit 1
fi

mkdir -p "$HELPER_DIR/.build"

clang -fobjc-arc -framework Cocoa "$SRC" -o "$OUT"
exec "$OUT"
