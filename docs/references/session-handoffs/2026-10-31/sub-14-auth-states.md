# SUB-14 hand-over (branch claude/sub-14-auth-states-ee1729, 2026-10-31 04:00 KST)

Commits: 0813e4b (helper), a960327 (HUD chip + CSS + docs/CODEX_HUD_DESIGN_V1.md §9.1).

New public field other sessions may read (no breaking change, existing fields unchanged):
- `/v1/state.auth.access` and SSE `auth.status.status.access` =
  `{ state, label, detail, recovery, cause, failedAt, resetsAt, resetPassed }`
  - state: ok | loginRequired | loginInProgress | authFailed | quotaExhausted | permissionDenied
  - label: Korean chip text, e.g. `한도 도달 · 오후 3:10에 초기화`, `인증 만료 · 다시 로그인 필요`, `권한 부족 · 접근 거부`
  - recovery: login | reauth | switchAccount | wait | refresh (user picks; bridge never acts on them; D-S5 no auto-continue)
- `authState.accessFailure = { kind, cause, at, identity }` (last auth/quota/permission turn rejection; allowlisted cause).

Where: helper/codex-auth-state.mjs `accountAccessState`, `usageRefreshDue`; helper/codex-bridge-http.mjs `createAccountAccessTracker`.
Bridge wiring in helper/codex-bridge-server.mjs: import lines, `accessFailure: null` in authState, tracker creation after rateLimitSync,
`accessTracker.notify(message)` first line of handleAppServerNotification, `authSnapshot()` adds `access`, refreshAccountState usage re-read condition.

SUB-05 (Settings account card): `auth.access.label/detail` can replace any isLoggedIn-only wording; `auth.access.state === 'quotaExhausted'` + `resetsAt` for the limit note.

Not done: RPC-level rejections of turn/start (seen only by codex-chat-runtime.mjs, forbidden area) do not reach the tracker;
Claude engine states untouched; no send blocking while quota is exhausted.
