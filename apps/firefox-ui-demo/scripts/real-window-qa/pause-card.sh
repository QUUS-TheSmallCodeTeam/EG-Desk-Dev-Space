#!/bin/bash
# Person path: as soon as the Card shows its "일시중지" (pause) button during Agent control, press it once. Usage: pause-card.sh <cardId> [minDelaySec]
cd "$(dirname "$0")" || exit 1; N=${NODE:-node}; OUT="${EGDESK_QA_OUT:-/tmp/egdesk-real-window-qa}"; mkdir -p "$OUT"; CARD=$1; sleep "${2:-1.5}"
for i in $(seq 1 60); do
  R=$($N mn.mjs exec "const c=document.getElementById('$CARD'); const b=[...c.querySelectorAll('button')].find(b=>/^일시중지/.test((b.getAttribute('aria-label')||b.textContent||'').trim()) && b.getBoundingClientRect().width>0); if(!b) return 'none'; b.click(); return 'paused'" 50)
  if echo "$R" | grep -q paused; then echo "paused after ${i} tries"; exit 0; fi; sleep 0.25
done; echo "no pause button seen"
