#!/bin/bash
# Extract frames from a screen recording: frames.sh <file.webm or .mp4> <out dir> [fps]   (default 2 frames per second; needs ffmpeg)
# Names are f0001.png ...; frame N is at (N-1)/fps seconds from the start of the file.
set -eu
[ $# -ge 2 ] || { echo "usage: frames.sh <file.webm or .mp4> <out dir> [fps]" >&2; exit 2; }
FFMPEG=${FFMPEG:-$(command -v ffmpeg || echo /opt/homebrew/bin/ffmpeg)}
mkdir -p "$2"
"$FFMPEG" -v error -y -i "$1" -vf "fps=${3:-2}" "$2/f%04d.png"
echo "frames: $(ls "$2" | grep -c '^f.*\.png$') in $2"
