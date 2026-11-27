#!/bin/bash
# One scenario in the real window: put the Card on a verified page, new DM (engine) with the Card granted, send, measure, screenshot.
# Usage: run-scn.sh <cardId> <Claude|Codex> "<message>" <shotName> <url> [titleRegex]
Q=$(cd "$(dirname "$0")" && pwd); D="${EGDESK_APP_DIR:-$(cd "$Q/../.." && pwd)}"; N=${NODE:-node}; OUT="${EGDESK_QA_OUT:-/tmp/egdesk-real-window-qa}"; mkdir -p "$OUT"
CARD=$1; ENGINE=$2; MSG=$3; SHOT=$4; URL=$5; TITLE=${6:-}
cd "$Q"; $N go-card.mjs "$CARD" "$URL" "$TITLE" || { echo "PRECONDITION FAILED"; exit 1; }
sleep 1.5; ./new-dm-grant.sh "$CARD" "$ENGINE" >/dev/null; sleep 6
T0=$(date +%H:%M); ./track.sh "$MSG" "$CARD" 150 | tail -1
$N read-chat.mjs 500 | tail -c 380 | tr '\n' ' '; echo
$N mn.mjs shot "$OUT/$SHOT.png" >/dev/null
cd "$D" && $N scripts/egdesk-turn-timeline.mjs --since "$T0" --browser --calls "$OUT/calls.json" 2>&1 | grep -E "^■|요약|대화 모델 [0-9]+구간|브라우저 한 단계" | tail -4 | cut -c1-200
