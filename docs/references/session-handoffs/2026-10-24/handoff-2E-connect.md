## 후속 인수인계 — 2026-10-25

아래 원본은 2026-10-24 작업 종료 시점의 기록이다. 2026-10-25에는 같은 `claude/vision-gap-20261024` 브랜치에서 다음을 연결했다. 현재 계약은 [engine-adapter-design.md §14.7](../../engine-adapter-design.md#147-후속-연결-체크포인트-2026-10-25)을 우선한다.

- 2-R 계약 8가지와 HTTP 인증을 대화에 저장된 엔진·계정 기준으로 연결했다. 준비된 Claude의 전송·승인·질문 응답이 Codex 로그인 상태 때문에 막히지 않는다.
- `acceptForSession`은 유효한 동일 도구의 허용 규칙이 있고 Agent 상한도 허용할 때만 제공한다. 화면 명칭은 **이번 연결 세션에서 허용**이며, 프로세스가 바뀌어도 지속되는 대화 전체의 권한이라고 약속하지 않는다. 상한이 `ask`이면 세션 허용으로 우회할 수 없다.
- 복수 선택 질문·한도 이벤트를 보존한다. 전달 실패를 성공으로 표시하지 않고, 한도 초기화 뒤 자동 재시도하지 않는다.
- Claude permission/MCP 요청 번호는 프로세스별이 아니라 어댑터 생애 동안 증가한다. 재시작·모델 변경·release/resume 뒤 이전 응답이 새 요청에 붙지 않는다.
- **선택 자료와 Codex 의존 EG-Desk provider의 Claude 연결(B2)은 아직 남았다.** 자료를 고른 요청은 명시적으로 보내지 않고 입력과 선택을 남긴다. 다른 엔진 권한으로 우회하거나 자료를 빼고 몰래 보내지 않는다. 옛 manifest 검증도 완화하지 않는다.
- 실제 Claude 로그인·구독 모델 호출은 이번 작업에서 하지 않았다. 아래 과거 live-check 절차는 자동 실행 승인이 아니다. 운영 프로필 적용·main 통합·push·OS 전면 입력도 하지 않는다.

중앙 검증과 남은 화면 항목은 [비전 Gap 원장](../../../../ideas/confirmed/EGDESK_VISION_GAP_LEDGER.md)의 2026-10-25 기록에 함께 남긴다.

---

[Main developer — 2026-10-24 원본]
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
