# AGENT-05 — Agent 정체성 표시 (worktree agent-05-identity-display-692f81)

작성 2026-10-31 04:00 KST. 세션: AGENT-05.

## 문서 리뷰 결과 (출발점)
- `18e8d7e`(2026-10-24)가 AGENT-05의 기본을 이미 넣었다: 답변 밖 작성자 아바타(이모지/이니셜+톤)·이름(`egd-codex-message-role`), `codexAgentWorkingRow` '[···] Agent 작업 중'(`ChatState.agentWorkingView`), 클릭 → `openActivity(threadId)`, CHAT-07 peek.
- 남은 격차: (1) D-A3 사진 아바타는 `publicProfileAvatar`가 `kind:'image'`를 버려 어디에도 안 보임. (2) 작업 중 버블이 `codexCurrentRun` 하나뿐 → Board 다중 Agent 구분 없음. (3) 버블 클릭이 Run 포커스 없이 패널만 연다. (4) Browser 카드 BRW-13 배지(`SurfaceState.browserAgentBadge`)에 Agent 정체성 없음. (5) File 카드에는 BRW-13 같은 활동 데이터 자체가 없음.

## 구현 계획
1. `EGDeskChatState.sys.mjs`: `displayProfileAvatar = publicProfileAvatar || profileImageReference` 도입, `profileAvatarView`·`normalizeProfileCatalog`·`projectRunMessages`·`agentPeekView`가 사진 참조를 유지(최소 줄).
2. 신규 `overlay/resources/EGDeskAgentIdentityView.sys.mjs` + `scripts/egdesk-agent-identity-view.test.mjs`: `agentAvatarView`, `agentAvatarImageSource`(data URL 검증), `messageAuthorAvatar`, `agentWorkingRows`(busy run마다 1행), `resolveCardAgentIdentity`, `cardAgentIdentityView`.
3. uc.js(소유 구역): 사진 face 렌더(`codexAvatarPhotoSource` + 브리지 `avatarImage(assetId)` 캐시, GET /profiles/avatar-images/:id), Board 다중 run 버블, 버블 클릭 `openActivity(threadId, { runId })`, Browser 카드 헤더에 `egd-browser-agent-identity` 칩(배지 옆, 2줄 + refreshAgentControl 1줄).
4. CSS: `--egd-*` 토큰만. 5. 문서 2건 갱신.

## 테스트 하네스 주의 (다른 세션 참고)
- `egdesk-surface-state.test.mjs`가 `codexMessageAvatarFace`·`codexAgentWorkingRow`·`codexProfileAvatar`·BRW-13 블록을 `new Function`/`compileFunction`으로 **홀로 컴파일**한다. 그 함수들 안에서 새 식별자를 쓰면 ReferenceError → `typeof fn === 'function'` 가드로 보호했다.
- 같은 파일 L14940-14943·L16418이 작업 중 버블 배선 줄을 정규식으로 고정한다. 고정된 줄은 그대로 두고 앞뒤에 추가했다.

## 결과 (2026-10-31 11:20 KST, 커밋 4개, push 없음)
- `49f6414` 모듈 `EGDeskAgentIdentityView.sys.mjs` + 테스트 + ChatState 사진 참조 유지(`displayProfileAvatar`).
- `d0dffde` uc.js·CSS 배선: 사진 face, run별 작업 중 버블(+이름), 버블 → `openActivity(threadId, { runId })`, Browser 카드 `egd-browser-agent-identity` 칩.
- `aa4e501` 문서 2건. `95be763` 테스트 pin 1줄 갱신(`egdesk-surface-state.test.mjs` L14941 부근: 버블이 run 포커스로 기록을 연다).
- 검증: `egdesk-agent-identity-view.test.mjs` 7/7. `egdesk-surface-state.test.mjs` 전체 실행은 pin 갱신 전 942 통과/1 실패(그 pin)였고, pin 갱신 후 그 테스트만 다시 실행해 통과(전체 재실행은 안 함). `egdesk-surface-claude.test.mjs` 76/76, `egdesk-design-tokens.test.mjs` 37/37. Firefox 미실행.
- 못 한 것: File 카드 배지(BRW-13 같은 활동 데이터 없음, `EGDeskSurfaceFileCard.mjs`는 CODE-02 세션 구역). 사진 읽기 실패 시 재시도 없음(이니셜 유지).
- 병합 주의: uc.js L245-370(face 헬퍼·working row·카드 정체성 함수), L9245-9410(메시지 목록), L10480(브리지 avatarImage), L16765(Browser 카드 칩 2줄), L18338(refreshAgentControl 1줄). BRW 세션과 L16765·L18338 근처가 겹칠 수 있음.
