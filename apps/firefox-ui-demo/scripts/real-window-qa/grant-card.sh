#!/bin/bash
# Grant one more Card "Chat 조작 허용" for the chat currently open (person path). Usage: grant-card.sh <cardId>
cd "$(dirname "$0")" || exit 1; N=${NODE:-node}; OUT="${EGDESK_QA_OUT:-/tmp/egdesk-real-window-qa}"; mkdir -p "$OUT"; CARD=$1
$N mn.mjs exec "const c=document.getElementById('$CARD'); [...c.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||'')==='더보기')?.click(); return 1" >/dev/null; sleep 0.8
$N mn.mjs exec 'const items=[...document.querySelectorAll("[role=menuitem],[role=menuitemcheckbox],menuitem,button")].filter(i=>i.getBoundingClientRect().width>0); const it=items.find(i=>/^Chat 조작 허용$/.test((i.getAttribute("aria-label")||i.getAttribute("label")||i.textContent||"").trim())); it?.click(); return !!it' >/dev/null; sleep 1
