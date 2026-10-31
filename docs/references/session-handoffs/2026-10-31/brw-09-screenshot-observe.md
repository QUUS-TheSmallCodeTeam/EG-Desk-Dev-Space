# BRW-09 — Agent용 시각 관찰(Browser 카드 스크린샷) hand-over

브랜치 `claude/brw-09-screenshot-observe-4885e9` (worktree `.claude/worktrees/brw-09-screenshot-observe-4885e9`). push 안 함.

## 동작 요약

- 관찰 허용(observe grant) 카드에서 모델이 `egdesk_browser_screenshot { cardId }`를 부르면 보이는 뷰포트의 JPEG(긴 변 ≤ 1280px)를 `inputImage`로 받는다.
- Firefox 안에서 가린 뒤 내보낸다: `type=password`·기존 민감 칸 규칙·`autocomplete` cc-*/one-time-code/current-password/new-password, 읽지 못한 frame(cross-origin·unreadable·private·depth-limit·unscanned), `<object>/<embed>`.
- 가리기 신뢰 불가면 이미지 없이 `screenshot.reason`만 돌려준다(`scan-budget`, `rect-unavailable`, `frame-transform`, `mask-moved`, `document-changed`, `viewport-changed`, `image-size-mismatch`, `image-too-large`, `capture-unsupported`, `unauthorized` 등).
- 스크린샷은 카드의 fresh observation이 되지 않는다. 조작 전에는 observe 필요.
- 캡처는 parent actor가 자기 `sendQuery('snapshot', {options.screenshot})`에 심은 1회용 ticket으로만 수행 → content process가 임의로 캡처 시작 불가. 가리지 않은 비트맵은 parent process 밖으로 안 나간다.

## 파일

- 신규 `overlay/resources/EGDeskScreenshotMask.sys.mjs` — 순수 정책(가림 박스, 전송 판정, 인코딩 시도 목록).
- `overlay/resources/EGDeskBrowserAgentRuntimeChild.sys.mjs` — `screenshotMask()`, `screenshotThenSnapshot()`, `paints()`, `scanRoots` 반환에 `truncated` 추가.
- `overlay/resources/EGDeskBrowserAgentRuntimeParent.sys.mjs` — `sendQuery` override(ticket), `captureScreenshot()`(`WindowGlobalParent.drawSnapshot(null, 1, "white")` → canvas 칠하기 → `toDataURL`), `receiveMessage` 분기.
- `helper/egdesk-browser-tool-runtime.mjs` — spec 1개 append(`BROWSER_TOOL_SPECS` 9번째), `BROWSER_READ_TOOL_NAMES`에 추가, `validateArgs` 1줄, `validScreenshot`, `executeDispatch` 분기(~12줄).
- `helper/codex-browser-tool-provider.mjs` — `SUCCESS_STATUSES`에 `screenshot-observed`, `inputImage` contentItem 3줄.
- 테스트: 신규 `scripts/egdesk-screenshot-mask.test.mjs`(14건). 기존 `helper/egdesk-browser-tool-runtime.test.mjs`·`helper/codex-browser-tool-provider.test.mjs`의 spec 개수/이름 단언을 8→9로.
- 문서: `docs/BROWSER_AGENT_OBSERVATION_RUNTIME.md` 'Masked Screenshot' 절 + Tools 표·Wiring Status.

## 병합 시 주의

- BRW-07(새 spec append)·BRW-05와 `BROWSER_TOOL_SPECS` 끝부분, 두 테스트 파일의 spec 개수 단언(9)에서 충돌 가능. 둘 다 유지하고 개수만 맞추면 됨.
- `codex-chat-runtime.mjs`는 손대지 않음. 카탈로그가 `BROWSER_READ_TOOL_NAMES`를 그대로 따르므로 readOnlyQa·browserBounded에서 자동 노출.
- uc.js 수정 없음. surface의 observe 경로가 `request.options`를 actor `snapshot`에 그대로 넘기는 것(eg-desk-surface.uc.js:15636, 18513)에 의존.

## 실행 검증 안 된 것 (실제 창 Firefox 필요)

- `drawSnapshot(null, 1, …)` 비트맵 크기가 `innerWidth/innerHeight`와 같은지(다르면 정책이 ±24px까지는 가림을 넓혀 보내고, 그 이상은 `image-size-mismatch`로 보내지 않음).
- JSWindowActorParent 서브클래스의 `sendQuery` override가 chrome 쪽 `actor.sendQuery` 호출에 적용되는지.
- 실제 페이지 JPEG 크기(150000자 예산 안에 드는지), Codex `inputImage` 왕복.

## brw-05-07-11 노트와 대조한 충돌 지점 (2026-10-31 11:12)

같은 줄을 둘 다 고친다 → 병합 때 양쪽 유지:
- `helper/egdesk-browser-tool-runtime.mjs`: `BROWSER_TOOL_SPECS` 끝(내 screenshot spec 1개 + 그쪽 5개), `BROWSER_READ_TOOL_NAMES`(내 `egdesk_browser_screenshot` + 그쪽 `list_cards`), `validateArgs` 조기 return 줄, `executeDispatch` 분기.
- `helper/codex-browser-tool-provider.mjs`: `SUCCESS_STATUSES` 한 줄, dispatch 끝 `return { success, contentItems … }` (내 쪽은 inputImage 3줄).
- 테스트: `helper/egdesk-browser-tool-runtime.test.mjs` L93·L104·L110·L1256-1262(spec 이름 목록·개수 9), `helper/codex-browser-tool-provider.test.mjs` L46(개수 9). 내 screenshot spec 단언은 `find(name)`로 바꿔 두어 끝에 뭐가 붙어도 통과.
- `docs/BROWSER_AGENT_OBSERVATION_RUNTIME.md`: Tools 표(내 행은 wait 바로 아래), Wiring Status 표(내 4행은 'Real Firefox run' 바로 위), 헤더 Date.

## 병합 완료 (2026-10-31 11:47)

- `claude/brw-05-07-11-browser-tools-8c6387`(c92b2d3)을 이 브랜치에 병합: 커밋 44fe7f4. 다섯 파일 모두 양쪽 유지. spec 순서는 list_cards·request_site·open_card·close_card·history 뒤에 screenshot(14번째). `BROWSER_READ_TOOL_NAMES` = observe·wait_text·list_cards·screenshot. `SUCCESS_STATUSES` 합집합. 개수 단언 14.
- `helper/codex-chat-runtime.test.mjs` 카탈로그 기대 3곳에 screenshot 추가: 후속 커밋. 관찰 전용 카탈로그에 screenshot 노출은 설계 의도(D-B6: 관찰 허용 카드도 스크린샷).
- 테스트 8파일 실패 0: runtime 54, provider 13, chat-runtime 195, screenshot-mask 14, guard 73, grant 5, transport 65, surface-state 943(+1 skip).
