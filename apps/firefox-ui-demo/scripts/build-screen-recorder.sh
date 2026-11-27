#!/bin/bash
# Builds egdesk-screen-recorder (temporary name) into apps/firefox-ui-demo/.tmp/bin/ (git-ignored). macOS only.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$here/.tmp/bin/egdesk-screen-recorder}"
mkdir -p "$(dirname "$out")"
swiftc -O -swift-version 5 "$here/helper-native/screen-recorder/main.swift" -o "$out" \
  -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia -framework CoreVideo
echo "$out"
