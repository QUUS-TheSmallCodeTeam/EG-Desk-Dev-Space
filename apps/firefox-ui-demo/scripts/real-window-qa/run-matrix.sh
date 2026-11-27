#!/bin/bash
# Final matrix: for each rep, each case, each engine. Results go to evidence/b-live/matrix.jsonl with rep tags F<rep>. Usage: run-matrix.sh <engine> <repFrom> <repTo> [cases...]
cd "$(dirname "$0")" || exit 1; N=${NODE:-node}; OUT="${EGDESK_QA_OUT:-/tmp/egdesk-real-window-qa}"; mkdir -p "$OUT"; ENGINE=$1; FROM=$2; TO=$3; shift 3; CASES=${*:-$(seq 1 20)}
for r in $(seq "$FROM" "$TO"); do for c in $CASES; do $N run-case.mjs "$c" "$ENGINE" "F$r" 2>&1 | head -1 | cut -c1-110; done; done
