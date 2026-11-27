#!/bin/bash
# Person's path: when a Card shows the site question, click its "허용" button with a real pointer click. Usage: allow-site.sh <cardId> <maxSec>
cd "$(dirname "$0")" || exit 1; N=${NODE:-node}; OUT="${EGDESK_QA_OUT:-/tmp/egdesk-real-window-qa}"; mkdir -p "$OUT"; CARD=$1; MAX=${2:-90}; T0=$(date +%s)
while [ $(( $(date +%s) - T0 )) -lt $MAX ]; do
  P=$($N mn.mjs exec "const c=document.getElementById('$CARD'); const b=[...c.querySelectorAll('button')].find(x=>x.textContent.trim()==='이 대화에서 허용' && x.getBoundingClientRect().width>0); if(!b) return ''; const q=(b.closest('[role=dialog],[role=alertdialog],section,div')?.textContent||'').replace(/\s+/g,' ').slice(0,90); const r=b.getBoundingClientRect(); return Math.round(r.left+r.width/2)+' '+Math.round(r.top+r.height/2)+' | '+q" 300)
  if echo "$P" | grep -qE "^\"?[0-9]+ [0-9]+ \|"; then P=$(echo "$P" | tr -d '"');  XY=$(echo "$P" | cut -d'|' -f1); echo "question at +$(( $(date +%s) - T0 ))s: $(echo "$P" | cut -d'|' -f2)"; sleep 1.2; $N mn.mjs shot "$OUT/site-question.png" >/dev/null; $N click.mjs $XY; exit 0; fi
  sleep 1; done; echo "no site question in ${MAX}s"
