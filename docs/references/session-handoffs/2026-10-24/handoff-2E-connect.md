[Main developer]
- Commit: commit_message below.
- WM file-map: register apps/firefox-ui-demo/helper/claude-engine-adapter.mjs and claude-engine-adapter.test.mjs.
- Live check once the user has run `claude auth login`: follow design doc §14.5, 1-2 runs, in an empty temp folder. First use the transport alone with tools:[] and the prompt 'Reply with exactly: ok'; then run through the adapter once. Record only event type/subtype and init.capabilities, permissionMode and apiKeySource. If the run passes, consider CLAUDE_VERSION_POLICY.verified=['2.1.300'].
- The worker_brief's other bridge lines (2-BH, 2-CH, 1-G, 2-X) are not done.

[2-R runtime], contract (doc §14.6):
1. Lift the send() guard `this.store && engineId !== 'codex'`. Let native.thread.bound and assertNativeAccount accept Claude bindings; ownerHash hashes adapter.ownerKey() = `claude:<method>:<email lowercased>`.
2. Make this.respond route by the rpc id's engine (adapter.owns?.(id), or claudeRpcThreadId). The bridge wrapper at codex-bridge-server.mjs:198 can then go.
3. In replyApproval and replyUserInput, call assertReady(this.runEngine(run)) instead of assertReady() (today a Codex outage also blocks Claude approvals).
4. Let acceptForSession through the approval choices filter.
5. Keep multiSelect:true in safeUserInputQuestions.
6. Let cleanNotification pass egdesk/engine/rateLimit {engineId,status,window,windowMinutes,resetsAt,utilization,usedPercent,overageStatus,creditsRequired}. No automatic retry (D-S5).
7. Do not add error.definite===true failures to uncertainThreads.
8. On resumeThread, pass the conversation's dynamicTools and its recorded cwd.

[S2/S9 screens]
- engines[] Claude status values: ready / loginRequired / notInstalled / versionUnsupported (statusReason versionUnknown, belowMinimum, or a code such as CLAUDE_CAPABILITIES_MISSING) / offline (notChecked, authUnknown) / disabled.
- A ready row with statusReason CLAUDE_API_KEY_DETECTED means: show the confirm card, then POST /engines/claude/api-key-env {confirm:true}.
- Login: GET /engines/claude/login-command?method=claudeai or console returns {line, argv, billing, afterward}. Call /terminal/spawn, then /terminal/write with line plus Enter, then POST /engines/claude/refresh.
- profiles[0].usage fields: level, percentLabel, windowLabel, resetLabel, resetsAt, stale, windows, rejected, creditsRequired, billing ('subscription' or 'apiKey'), autoResume:false.
- Error codes: CLAUDE_API_KEY_DETECTED 409 (with detected variable names), ENGINE_BUSY 429, ENGINE_LOGIN_REQUIRED 401, ENGINE_NOT_INSTALLED or ENGINE_VERSION_UNSUPPORTED 503, CWD_CHANGE_UNSUPPORTED 409, EFFORT_UNSUPPORTED 400 (Claude accepts low through max only).