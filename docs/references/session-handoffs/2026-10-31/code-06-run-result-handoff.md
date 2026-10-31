# CODE-06 handoff (worktree code-06-run-result-surface-d13e97)

Commits (not pushed): e13dd8e parser+test · 9a3c756 run watch+registry/bridge wiring · 6d4283b '요약 없음 · 원문 보기' fallback · b672c52 Terminal result card + File line open (+ docs commit after).

Merge notes
- Touches outside my area, all wiring only: helper/terminal-sessions.mjs (+4 lines: runWatch option, observeOutput/observeInput/take), helper/codex-bridge-server.mjs (+4 lines: import, construct watch, close), overlay/JS/eg-desk-surface.uc.js (+4 lines: RunResult import, openBoardProjectFileAt forward, 2 deps entries), egdesk-terminal-init.js (+4 lines: postMessage 'terminal-run-result'), surface/EGDeskSurfaceFileCard.mjs (+openBoardProjectFileAt method and return key), scripts/egdesk-surface-modules.test.mjs (expectations: forwards list, fileCard interface, deps count 33→35).
- If another branch also adds installer deps / forwards, egdesk-surface-modules.test.mjs counts will conflict (deps count assertion). Re-run that single test after merge.
- EGDeskRunResult.sys.mjs: headline for unknown outcome changed '결과 확인 안 됨' → '요약 없음 · 원문 보기', plus `summaryless` field; renderer opens the tail <details> when summaryless. EGDeskChatRunResult (CHAT-08) sets its own '완료 결과 확인 안 됨' and is untouched.
- Not done: Chat chip for Terminal-origin results (needs CHAT-08 module), Canvas standalone result card (the panel lives inside the Terminal card), real Firefox/shell verification.
