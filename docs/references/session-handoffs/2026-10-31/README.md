# 2026-10-31 세션 handoff 보관

2026-10-31(KST) 라운드에서 병렬 세션 16개(1차 12 · 2차 2 · 재개 2)가 각자 worktree와 브랜치 `claude/<slug>-<hash>`에서 남긴 인계 노트 18건과 main 세션의 라운드 기록을 다음 세션이 쓸 수 있게 한곳에 옮겨 둔 것이다. 16개 브랜치는 모두 `claude/vision-gap-20261024`에 병합·push됐고, 정본 진행 상태는 `ideas/confirmed/EGDESK_VISION_GAP_LEDGER.md`(이번 라운드 결과 3차까지 반영)다. 2026-10-31 17:44 KST에 세션 16개·worktree 16개·브랜치 16개를 삭제했고 세션 대화 기록은 복구할 수 없으므로, 이 폴더의 노트 18건과 `overnight-report-2026-10-31.md`가 세션별 유일 기록이다.

## 이 폴더의 파일

- `README.md`: 이 색인.
- `overnight-report-2026-10-31.md`: main 세션 라운드 기록 `.tmp/overnight-20261031/REPORT.md`의 사본 — 세션별 상태, 병합 사전 점검, 회귀 수정, 원장·file-map 반영, 다음 단계, 유저 결정 대기, 교훈.
- 노트 18건(파일명 원문 그대로, 공유 노트 폴더에서 byte-identical 복사). 세션별로 묶으면 16줄:
  - `agent-05-identity-display.md`: AGENT-05 Agent 정체성 표시(아바타·생각 버블·배지) — 사진 아바타·run별 작업 중 버블·Browser 카드 정체성 칩 인계.
  - `brw-05-07-11-plan.md`, `brw-05-07-11-handoff.md`: BRW-05·07·11 Agent 브라우저 navigate·다중 카드·권한 수명 — plan(03:58 KST 구현 계획)과 handoff(11:35 KST 인계) 두 파일.
  - `brw-09-screenshot-observe.md`: BRW-09 Agent용 카드 스크린샷 관찰(마스킹 포함) — `egdesk_browser_screenshot` 도구와 가림 정책 인계(brw-05-07-11 브랜치 병합 기록 포함).
  - `chat-01-agent-persist.md`: CHAT-01 방별 Agent 선택을 재시작·Board 복원 뒤에도 유지 — 대화 저장소 v3 `thread.agent` 복원 인계.
  - `chat-03-plan.md`, `chat-03-handoff.md`: CHAT-03 Agent DM → Board Thread 옮기기·태그·복귀 — plan(03:58 KST 6단계 계획)과 handoff(11:20 KST 인계) 두 파일.
  - `chat-08-output-chips-handoff.md`: CHAT-08 긴 출력 → Canvas 결과 카드 + Chat 연결 칩 — `[결과] 제목 · 버전 n` 칩 인계와 원장 갱신 제안 문구.
  - `cnv-03-board-membership.md`: CNV-03 Board 소속 편집·View bar 표시·제안 칩 — View bar Board 메뉴·'넣을까요?' 칩 인계.
  - `cnv-06-canvas-memo.md`: CNV-06 Canvas Memo: 고정 메모·Agent 답글·수신자 지정 질문 — Dock [메모] 노트 카드 인계.
  - `code-02-project-folder.md`: CODE-02 Board 프로젝트 폴더: 상속·cwd 일치·재연결 — Board [⋯] 메뉴 프로젝트 폴더·헤더 칩 인계.
  - `code-05-plan.md`: CODE-05 변경 diff 2단계 승인·hunk별 되돌리기 — 조사·커밋·회귀 수정(`db15cd2`)까지 한 파일에 기록.
  - `code-06-run-result-handoff.md`: CODE-06 실행·테스트 결과 카드(통과/실패·위치 이동) — Terminal 결과 카드·File 줄 열기 인계.
  - `ctx-02-recovery-journal.md`: CTX-02 Desk 복구 journal 세대·시점 선택 복원 UI — 보존·묶음 규칙 모듈 분리 인계와 원장 갱신 제안 문구.
  - `sub-05-settings-accounts.md`: SUB-05·01 Settings 계정 탭 실데이터 + 계정 메뉴 — '계정' 탭 연결 상태·계정 메뉴·Claude 카드 인계.
  - `sub-14-auth-states.md`: SUB-14 인증 실패·한도 소진·권한 부족 상태 구분 — bridge `auth.access` 공개 필드·HUD 칩 인계.
  - `ux-02-minimap.md`: UX-02 미니맵 Board 영역·겹침 목록·이름 검색 이동 — 미니맵 행 유형·Board 표시, rail search 카메라 이동 진행 노트.
  - `ux-05-placement-ops.md`: UX-05 배치 조작: 격자 맞춤·undo·정리·그룹 — 스냅·레이아웃 undo·정렬·그룹 화면 연결 인계.

## 공통 전제

- 병합 상태: 16개 브랜치 모두 `claude/vision-gap-20261024`에 `--no-ff` 병합 완료(최종 `b476945`), origin push 완료. 병합 전 임시 worktree에서 순차 병합 + 고정 Node 단건 테스트로 점검했고, 회귀 7건은 각 세션이 수정한 뒤 재병합했다. 노트에 적힌 "push 안 함"은 노트 작성 시점 기준이며 지금은 해소된 상태다.
- 실화면 검증 0건: 어느 항목도 Firefox 실화면 검증을 하지 않았다(코드 + Node 단건 테스트까지만). 아래 '실화면 검증 체크리스트'가 그 공백이다.
- 테스트는 고정 Node 단건 실행만: `apps/firefox-ui-demo/.tmp/node-runtime/node-v24.22.1-darwin-arm64/bin/node --test --test-reporter=tap <파일>` (핀 파일 `apps/firefox-ui-demo/.node-version`).
- 금지: 전체 테스트 glob · Firefox 실행 · `npm install` (RAM 16GB).
- 세션·worktree·브랜치는 2026-10-31 17:44 KST에 삭제됨. 노트가 가리키는 worktree 경로(`.claude/worktrees/<slug>-<hash>`)는 더 이상 없다. 커밋 해시는 `claude/vision-gap-20261024` 이력에서 찾는다(`--no-ff` 병합이라 각 커밋이 보존됨).

## 세션별 요약

세션 제목·노트 파일·브랜치는 원문 그대로. '결과 한 줄'과 '병합·후속 주의'는 해당 노트에 적힌 것을 옮기고, 노트 간 대조로 덧붙인 문장은 괄호로 표시했다. 주의 열이 짧게 줄인 것이라 상세는 표 아래 '세션별 상세 주의'를 본다.

| 세션(항목 ID·제목) | 노트 파일 | 브랜치 | 결과 한 줄 | 병합·후속 주의(짧게) |
|---|---|---|---|---|
| AGENT-05 Agent 정체성 표시(아바타·생각 버블·배지) | `agent-05-identity-display.md` | `claude/agent-05-identity-display-692f81` | 사진 아바타·run별 작업 중 버블·Browser 카드 Agent 정체성 칩 배선 | uc.js L245-370·L9245-9410·L10480·L16765·L18338 접촉, BRW 세션과 L16765·L18338 근처 겹침 가능. `egdesk-surface-state.test.mjs`가 함수를 홀로 컴파일 → 새 식별자는 `typeof fn === 'function'` 가드. `egdesk-surface-state.test.mjs` 전체 재실행 안 함 |
| BRW-05·07·11 Agent 브라우저 navigate·다중 카드·권한 수명 | `brw-05-07-11-plan.md`, `brw-05-07-11-handoff.md` | `claude/brw-05-07-11-browser-tools-8c6387` | 허용 사이트 이동·다중 카드 도구 5개·대화 단위 grant를 helper·Browser 카드에 배선 | 하네스 2개가 uc.js를 텍스트 구간으로 자름 → 앵커 문자열 4개 변경 금지. actor(BRW-09 소유)·`helper/codex-chat-runtime.mjs` 미수정. 계약 수치(30분·4개·55초·Stop 종료)는 가정. 테스트 통과 수치·마지막 커밋 해시는 노트에 없음 |
| BRW-09 Agent용 카드 스크린샷 관찰(마스킹 포함) | `brw-09-screenshot-observe.md` | `claude/brw-09-screenshot-observe-4885e9` | Browser 카드 가린 스크린샷을 모델에 주는 `egdesk_browser_screenshot` 도구 | 11:47에 brw-05-07-11 브랜치(c92b2d3)를 이미 병합(44fe7f4), spec 개수 단언 14. 충돌 지점은 `helper/egdesk-browser-tool-runtime.mjs`·`helper/codex-browser-tool-provider.mjs` 끝부분 — 양쪽 유지. uc.js·`codex-chat-runtime.mjs` 미수정 |
| CHAT-01 방별 Agent 선택을 재시작·Board 복원 뒤에도 유지 | `chat-01-agent-persist.md` | `claude/chat-01-agent-persist-901f75` | 방별 Agent 선택을 대화 저장소 v3 `thread.agent`에서 복원, ⋯ 메뉴 변경 즉시 저장 | uc.js 2곳만(`ensureLocalHistoryThread` L11216 근처·`setThreadAgentProfile` L12791 근처). surface-state 시험이 `setThreadAgentProfile` 블록을 `cycleThreadAgentProfile` 앞까지 잘라 컴파일 → 새 식별자는 keys도. verify-chat-history-restart 재시작 프로브 미실행 |
| CHAT-03 Agent DM → Board Thread 옮기기·태그·복귀 | `chat-03-plan.md`, `chat-03-handoff.md` | `claude/chat-03-dm-to-board-thread-c34176` | Agent DM 버블을 Board Thread로 옮기기(단건·다중)·@이름 칩·'@' 배지 화면 연결 | 소유 밖 2곳(`helper/codex-chat-runtime.mjs` shareMessages, `scripts/egdesk-surface-state.test.mjs`). 새 `overlay/resources/EGDeskThreadRouting.sys.mjs` 배포 경로(설치/복사 스크립트) 미확인. /chat/board/send 미연결(CHAT-10) |
| CHAT-08 긴 출력 → Canvas 결과 카드 + Chat 연결 칩 | `chat-08-output-chips-handoff.md` | `claude/chat-08-output-chips-ceb480` | 답변 아래 `[결과] 제목 · 버전 n` 칩 → CHAT-04 결과 카드 열기 화면 연결(S3) | `spawnResultCard(` 호출 수 단언 4→5 — 같은 단언 가진 브랜치와 충돌. messageStack 줄 미변경(정규식 고정). helper 변경 없음. D-K3 미결(본문 사본 저장 vs 참조만) |
| CNV-03 Board 소속 편집·View bar 표시·제안 칩 | `cnv-03-board-membership.md` | `claude/cnv-03-board-membership-d4007f` | Desk Window View bar에 Board 소속 ▾ 메뉴·'넣을까요?' 칩·새 Board 저장 시 영역 묶기 | uc.js 소유 밖 3곳(L5255·L5317/5323·L6372). spawnDeskWindowShell은 `state.toggleViewBoardMenu?.()`/`state.offerBoardMembership?.()`로만 호출 — 셸 안 직접 참조 금지. 헤더 칩 행 추가로 헤더 높이 변함 |
| CNV-06 Canvas Memo: 고정 메모·Agent 답글·수신자 지정 질문 | `cnv-06-canvas-memo.md` | `claude/cnv-06-canvas-memo-f3e067` | Dock [메모] 노트 카드: 카드 고정 추적, Agent 묻기·답글 붙임, Desk/Board 저장 | uc.js 'Canvas Memo (CNV-06)' 블록 + 한 줄 훅 다수. Board 재오픈 시 `anchor.cardId` remap 미구현 → '대상 없음'. helper 변경 없음 |
| CODE-02 Board 프로젝트 폴더: 상속·cwd 일치·재연결 | `code-02-project-folder.md` | `claude/code-02-project-folder-6bbbfc` | Board [⋯] 메뉴 프로젝트 폴더 선택/해제 + 헤더 프로젝트 칩 + agenda.project 저장 | CNV-03과 겹침(`EGDeskSurfaceState.sys.mjs` `boardProjectReference()`·`project` 필드, uc.js `refreshBoardRegion`·`toggleBoardRegionMenu` 1줄씩, surface-state 하네스 stub). D-X3(참조만으로 자동 연결 금지). `helper/egdesk-file-http.test.mjs` 1 fail은 환경 의존 |
| CODE-05 변경 diff 2단계 승인·hunk별 되돌리기 | `code-05-plan.md` | `claude/code-05-diff-two-stage-0e220b` | Chat fileChange에서 '적용된 변경 검토 · 되돌리기' 2단계 패널 열기 배선 | CSS Chat diff 셀렉터 원문 유지 필수(`:is()`로 합치면 surface-state 2건 깨짐) + `readOrigin`은 command 항목만 — 둘을 `db15cd2`가 회귀 수정. read scope: `readChangeOrigin`=같은 run의 완료된 fileChange만. SOURCE_CHANGED(D-X1)면 쓰지 않음 |
| CODE-06 실행·테스트 결과 카드(통과/실패·위치 이동) | `code-06-run-result-handoff.md` | `claude/code-06-run-result-surface-d13e97` | Terminal 결과 카드·File 줄 열기·'요약 없음 · 원문 보기' fallback 배선 | 구역 밖 접촉은 wiring only — 파일 6개 중 4개는 +4줄씩, FileCard는 openBoardProjectFileAt 메서드+return key, surface-modules.test는 기대값. `scripts/egdesk-surface-modules.test.mjs` deps count 단언 33→35 — 다른 브랜치가 deps/forwards 추가 시 충돌, 병합 후 그 단건 재실행 |
| CTX-02 Desk 복구 journal 세대·시점 선택 복원 UI | `ctx-02-recovery-journal.md` | `claude/ctx-02-recovery-journal-a9af04` | D-R1 보존·묶음 규칙을 순수 모듈로 분리, 복구 기록에 Board 수·주요 변경 표시 | 스키마(v2) 변경 없음. Board store(uc.js L3907-4690, CNV-03)·Portable·Chat/Settings/Browser/Canvas 미수정. `egdesk-surface-state.test.mjs`는 '복구 기록 rows…' 1건만 패턴 실행 |
| SUB-05·01 Settings 계정 탭 실데이터 + 계정 메뉴 | `sub-05-settings-accounts.md` | `claude/sub-05-settings-accounts-ea6524` | Settings '계정' 탭: 연결 상태 구분·계정 메뉴·확인 블록·Claude 계정 카드 | uc.js 변경은 Settings 구역 L13828-14110과 L14943 한 줄뿐. `scripts/egdesk-surface-state.test.mjs` 하네스 6곳에 인자 2개 추가 — 공유 파일이라 SUB-14도 고쳤다면 충돌 확인(README 대조: SUB-14 노트에는 이 파일 수정 기록 없음). onCodexChange signature에 bridgeFailures/error 추가 |
| SUB-14 인증 실패·한도 소진·권한 부족 상태 구분 | `sub-14-auth-states.md` | `claude/sub-14-auth-states-ee1729` | bridge에 계정 접근 상태 `auth.access` 공개 필드 + HUD 칩 추가 | 기존 `/v1/state.auth` 필드 변경 없음(`access` 추가만; `accessFailure`는 helper 내부 `authState` 필드 — 공개 여부 노트 미기재). recovery는 유저 선택용, bridge 자동 실행 없음(D-S5). `codex-chat-runtime.mjs` 금지 영역 → RPC 수준 거부 미연결 |
| UX-02 미니맵 Board 영역·겹침 목록·이름 검색 이동 | `ux-02-minimap.md` | `claude/ux-02-minimap-boards-8cec7e` | 미니맵 행에 유형·소속 Board 표시, rail search 선택 시 카메라 이동 | 소속 Board를 `card.dataset.projectionId`(uc.js L4310·L5003)로 읽음 — CNV-03이 마커 바꾸면 읽기 3곳 연동. minimapUiHarness 고정 의존성 목록 → 새 식별자는 ReferenceError. Pan/Zoom(UX-05 구역) 미접촉 |
| UX-05 배치 조작: 격자 맞춤·undo·정리·그룹 | `ux-05-placement-ops.md` | `claude/ux-05-placement-ops-ea21b9` | Canvas 스냅·레이아웃 undo·정렬·그룹 배치 조작을 화면에 연결 | 소유 밖 배선 4항목(import L31·`serializeDeskSnapshot().groups`·`state.restoreCanvasGroups?.(...)`·`state.expandCanvasSelection`) (README 대조: 노트는 '3줄'로 표기). 스냅은 `style` MutationObserver 덧쓰기(`takeRecords()`). main 병합 충돌 1곳 import 줄 두 줄 유지 |

### 세션별 상세 주의

표의 주의 열에서 뺀 나머지. 출처는 각 소제목의 노트 파일.

#### AGENT-05 — `agent-05-identity-display.md`
- uc.js 접촉 지점: L245-370(face 헬퍼·working row·카드 정체성 함수), L9245-9410(메시지 목록), L10480(브리지 avatarImage), L16765(Browser 카드 칩 2줄), L18338(refreshAgentControl 1줄). BRW 세션과 L16765·L18338 근처가 겹칠 수 있음.
- `egdesk-surface-state.test.mjs`가 `codexMessageAvatarFace`·`codexAgentWorkingRow`·`codexProfileAvatar`·BRW-13 블록을 `new Function`/`compileFunction`으로 홀로 컴파일 → 그 함수 안에서 새 식별자를 쓰면 ReferenceError → `typeof fn === 'function'` 가드로 보호함.
- `egdesk-surface-state.test.mjs` L14940-14943·L16418이 작업 중 버블 배선 줄을 정규식으로 고정 → 고정된 줄은 그대로 두고 앞뒤에 추가했음. `95be763`로 L14941 부근 pin 1줄이 바뀜(버블이 run 포커스로 기록을 연다).
- 검증은 `egdesk-agent-identity-view.test.mjs` 7/7, `egdesk-surface-claude.test.mjs` 76/76, `egdesk-design-tokens.test.mjs` 37/37. `egdesk-surface-state.test.mjs`는 pin 갱신 전 942 통과/1 실패(그 pin), pin 갱신 후 그 테스트 1개만 재실행해 통과 — 전체 재실행 안 함.
- 못 한 것: File 카드 배지(BRW-13 같은 활동 데이터 자체가 없고 `EGDeskSurfaceFileCard.mjs`는 CODE-02 세션 구역), 사진 읽기 실패 시 재시도 없음(이니셜 유지). `aa4e501` 문서 2건 갱신은 어떤 문서인지 노트에 미기재.
- 커밋 `49f6414`(모듈+테스트+ChatState `displayProfileAvatar`) · `d0dffde`(uc.js·CSS 배선) · `aa4e501`(문서 2건) · `95be763`(pin 1줄).

#### BRW-05·07·11 — `brw-05-07-11-plan.md`, `brw-05-07-11-handoff.md`
- 하네스(`scripts/egdesk-browser-tool-transport.test.mjs`, `scripts/egdesk-surface-state.test.mjs`)는 uc.js를 텍스트 구간으로 자르므로, 다른 세션이 앵커 문자열 `const browserToolActionLeases = new Map();`, `const browserToolFixtureAuthorizationByCard = new Map();`, `function registerBrowserToolSelection(`, `card._browserControls = {`를 바꾸면 깨짐.
- uc.js 변경은 모두 브라우저 도구 transport 함수들(L14985~15900대)과 spawnBrowserCard 내부(toolAct 뒤·_browserControls·onLocationChange·showBrowserMenu)와 상단 import 1줄. Settings/Chat/Popup/Canvas/Board 구역 미접촉. transport 함수들은 파일상 Settings 마커 뒤(L14985~)에 있으나 과제가 grep으로 지정한 이 세션 영역.
- `helper/codex-tool-errors.mjs` BROWSER_CODES에 코드 2개 추가(소유 밖, 1줄). `helper/codex-browser-tool-provider.test.mjs` L71 기대 수정 + 추가(plan 기준, handoff 미확인).
- 커밋 c874a44(신규 `overlay/resources/EGDeskBrowserGrant.sys.mjs` + `scripts/egdesk-browser-grant.test.mjs` + codex-tool-errors 1줄) → 7ac4105(helper) → 3c37118(uc.js·CSS·하네스 테스트 2개 파일에 grant 구간 공급 + BRW-11 테스트 1개) → 633bbea(문서) → 마지막(해시 미기재; actor 경로 navigate/click/press 뒤 착지도 commit 검사, 미사용 재발급 토큰 정리). plan 범위 밖: Child/Parent actor·transport 모듈 수정 없음.
- Child/Parent actor(BRW-09 소유)는 same-site 하드코딩 그대로 — 허용 사이트 이동은 actor 경로가 아닌 parent(uc.js) `chrome-load-uri` 경로(`toolNavigateChrome`). `helper/codex-chat-runtime.mjs` 미수정(공유 도구 목록으로 자동 반영). runtime guard.navigationScope는 `same-site|allowed-site`(설계).
- 계약 수치는 가정: 유휴 만료 30분, interact 명시 선택 ≤4(카드 4개/Run 상한), 허용 사이트 요청 대기 55초(transport 60초 상한 안), observe 선택은 1회용 유지, Stop도 standing grant 종료.
- plan 발견: navigate 카탈로그 노출은 BRW-06에서 이미 됨(`BROWSER_INTERACTION_TOOL_NAMES`에 `egdesk_browser_navigate` 포함). ledger L929-937의 "188-191/96-99에서 걸러짐"은 옛 상태 — ledger 수정은 범위 밖.
- 하네스가 open-card/close-card/history/allow-site UI 핸들러는 직접 돌리지 않음(helper 쪽만 테스트). D-B10/D-B11 미구현(범위 밖). 마지막 커밋(Guard link and redirect landings …) 해시는 노트 미기재.

#### BRW-09 — `brw-09-screenshot-observe.md`
- 파일: 신규 `overlay/resources/EGDeskScreenshotMask.sys.mjs`(순수 정책). `EGDeskBrowserAgentRuntimeChild.sys.mjs`(`screenshotMask()`·`screenshotThenSnapshot()`·`paints()`, `scanRoots` 반환에 `truncated`), `EGDeskBrowserAgentRuntimeParent.sys.mjs`(`sendQuery` override(ticket)·`captureScreenshot()`·`receiveMessage` 분기) (README 대조: BRW-05·07·11이 '미수정'이라 적은 actor는 이 세션이 고쳤다).
- 충돌 지점 `helper/egdesk-browser-tool-runtime.mjs`: `BROWSER_TOOL_SPECS` 끝(screenshot spec 1개 + brw-05-07-11 쪽 5개), `BROWSER_READ_TOOL_NAMES`(`egdesk_browser_screenshot` + `list_cards`), `validateArgs` 조기 return 줄, `executeDispatch` 분기 — 양쪽 유지. 병합 후 spec 순서는 list_cards·request_site·open_card·close_card·history 뒤에 screenshot(14번째), `BROWSER_READ_TOOL_NAMES` = observe·wait_text·list_cards·screenshot.
- 충돌 지점 `helper/codex-browser-tool-provider.mjs`: `SUCCESS_STATUSES` 한 줄(합집합), dispatch 끝 `return { success, contentItems … }`(screenshot 쪽은 inputImage 3줄).
- 테스트 충돌 줄: `helper/egdesk-browser-tool-runtime.test.mjs` L93·L104·L110·L1256-1262(spec 이름 목록·개수), `helper/codex-browser-tool-provider.test.mjs` L46(개수). screenshot spec 단언은 `find(name)`로 바꿔 두어 끝에 뭐가 붙어도 통과. `helper/codex-chat-runtime.test.mjs` 카탈로그 기대 3곳에 screenshot 포함(관찰 전용 카탈로그 노출은 D-B6 설계 의도).
- uc.js 수정 없음 — surface의 observe 경로가 `request.options`를 actor `snapshot`에 그대로 넘기는 것(eg-desk-surface.uc.js:15636, 18513)에 의존. `codex-chat-runtime.mjs`도 손대지 않음(카탈로그가 `BROWSER_READ_TOOL_NAMES`를 따르므로 readOnlyQa·browserBounded에서 자동 노출).
- `docs/BROWSER_AGENT_OBSERVATION_RUNTIME.md`: Tools 표(screenshot 행은 wait 바로 아래), Wiring Status 표(4행은 'Real Firefox run' 바로 위), 헤더 Date.
- 계약 수치: JPEG 긴 변 ≤ 1280px, 비트맵 크기 불일치 허용 ±24px, 응답 예산 150000자. 스크린샷은 카드의 fresh observation이 되지 않음(조작 전 observe 필요). 캡처는 parent actor의 1회용 ticket으로만, 가리지 않은 비트맵은 parent process 밖으로 안 나감.
- 테스트 8파일 실패 0: runtime 54, provider 13, chat-runtime 195, screenshot-mask 14, guard 73, grant 5, transport 65, surface-state 943(+1 skip).

#### CHAT-01 — `chat-01-agent-persist.md`
- 다른 세션 영역 미접촉: AGENT-05 L245-370·L9245-9410, CHAT-03 메시지 루프.
- `POST /chat/rooms/agent`는 `CHAT_ACTIONS` + `LOCAL_WRITES`(ensureAuth 면제) — 로그아웃 상태 선택도 기록, 오프라인 QA 프로브도 기록 가능. 보낸 적 없는 방은 404(화면은 조용히 넘김, 첫 보내기가 기록).
- pref 우선: 화면 thread가 `profileEnabled === true`면 pref 선택 유지. store agent는 `profileEnabled`가 true가 아닐 때만 채움(`EGDeskChatState.restoredRoomAgentFields`).
- `thread.agent`는 항상 snapshot(서버) 값으로 덮어씀(pref 사본 교체); 옛 브리지(필드 없음)면 방의 것 그대로. revision은 복원에 적용 안 함 — `thread.agent.revision` 보존·전달만; ⋯ 메뉴 쓰기 값은 카탈로그 activeRevision(없으면 null).
- 커밋 `66d4162`·`c34e2d9`·`47f7c4f`·`7fb5089`. 검증(고정 Node, 단건): egdesk-surface-state 948/947 pass/1 skipped(기존)/0 fail · egdesk-chat-presentation 9/9 · egdesk-surface-modules 13/13 · egdesk-thread-routing 9/9 · egdesk-chat-store 26/26 · codex-chat-runtime 196/196 · codex-bridge-http 36/36 · `node --check` 통과.
- 미착수: Board 저장 record(chat card)에 thread binding 추가(원장 '빠진 것' 3번째 항목, 범위 밖). 원장·docs 수정 없음.

#### CHAT-03 — `chat-03-plan.md`, `chat-03-handoff.md`
- 소유 영역 밖 수정 2곳: (1) `helper/codex-chat-runtime.mjs` shareMessages — 받는 쪽 대화가 store에 없으면 createConversation(2줄+주석; plan 시점엔 `to` 대화 없으면 404였음) (2) `scripts/egdesk-surface-state.test.mjs` — 컴파일 키에 ThreadRouting 추가, branch-menu 테스트의 닫기 버튼 인덱스(메뉴 항목 2개 추가 반영).
- uc.js 메시지 루프의 세 소스 형태(messageStack 줄, appendPlanCards 순서, appendControlNotices→if(working))는 surface-state 테스트가 정규식으로 고정 → 복사본 블록은 '다음 저장 버블 앞' + 끝(trailing)에 끼움. AGENT-05(createCodexMessage L9796~)는 건드리지 않음.
- 새 `overlay/resources/EGDeskThreadRouting.sys.mjs`(ChatState에서 clientThreadBinding import) — 설치/복사 스크립트가 resources/*.sys.mjs를 통째로 복사하는지 확인 안 함, QA 격리 매니페스트에도 추가 안 함.
- @태그 파싱은 runtime boardMentions와 같은 규칙, 복사본 블록 배치는 localSeq 기준. /chat/board/send(D-M2 라우팅)는 화면에 연결 안 함 — 멘션은 표시만(CHAT-10 범위).
- helper 쪽 D-M3(`POST /chat/share` → `shareMessages()`, `messages.shared.in/out/attached`)는 2d9672e에 이미 있었음.
- 커밋 5개(586e348 위): 7a2cfd4 → 3022a13 → aaaf04d → eeac9e6 → (docs). 테스트: egdesk-thread-routing 9/9 · egdesk-chat-presentation 9/9 · egdesk-surface-state 944(943 pass, 1 skipped, 0 fail) · codex-chat-runtime 195/195(D-M3 테스트에 fresh-room 공유 추가) · egdesk-design-tokens 37/37.

#### CHAT-08 — `chat-08-output-chips-handoff.md`
- 메시지 렌더 블록 messageStack 줄은 손대지 않음(surface-state regex 고정). resultRow 줄만 바뀜. `egdesk-chat-presentation.test.mjs`가 자르는 블록(renderThreadSection·bridgeNotice)에는 새 심볼 없음 → keys 수정 불필요.
- spawnResultCard는 선언 1 + 호출 4 → 기존 시험 기대값 `spawnResultCard(` 호출 수 4→5(칩 경로 = 브리지 openPublishedOutput 추가). 렌더·이벤트·run 종료에서는 여전히 호출 없음을 regex로 고정.
- 카드 기록 source의 outputId/outputKey/outputVersion은 셋이 함께만 유효, 깨지면 일반 답변 카드로 복원. Claude 방은 칩을 아예 안 그림(브리지가 claude에 publish 라우트를 막아 둠). 칩의 '버전 1'도 항상 표시.
- helper 변경 없음: codex-chat-runtime.mjs snapshot()이 run을 통째로 copy해 보내므로 context.outputs가 이미 overlay에 도달. GET /context/outputs 목록 라우트는 화면에서 아직 안 씀.
- 커밋 6f4b4fb(ChatState) → 69d205c(uc.js·CSS). 테스트: egdesk-surface-state 952(951 pass, 1 skipped, 0 fail; 새 시험 7건) · egdesk-chat-presentation 9/9 · egdesk-surface-modules 13/13 · egdesk-design-tokens 37/37 · egdesk-chat-run-result 30/30 · codex-chat-runtime 195/195 · egdesk-context-core 107/107 · `node --check` ok.

#### CNV-03 — `cnv-03-board-membership.md`
- uc.js 소유 영역 밖 수정 3곳(각 1~3줄): restoreDeskSession 구성원 mousedown 리스너를 dataset 기반으로(L5255), saveCurrentAgendaState에 D-V4 묶기 2줄(L5317·5323), showBoardScopeChooser 안내 문구 1줄(L6372). UX-05/CTX-02 영역(L19230~, L21094~)은 손대지 않음.
- spawnDeskWindowShell은 새 기능을 `state.toggleViewBoardMenu?.()` / `state.offerBoardMembership?.()`로만 호출 — 기존 테스트 하네스가 셸 함수를 단독 컴파일하기 때문. 셸 안에 직접 참조를 넣지 말 것.
- 창 헤더에 칩 행이 추가되면 헤더 높이가 변한다(.egd-card-header flex column). Browser 제목줄 충돌 보정(L19380대)은 라벨만 보고 판정하며 새 버튼은 보지 않음.
- Chat 카드(spawnCodexChatCard, Desk Window 셸 아님)와 도형에는 View bar 메뉴·칩이 없다(모듈은 kind 'shape' 지원).
- 커밋 b8fc50a(순수 모듈+테스트) · 03137fe(uc.js 배선+CSS) · 1ada5f9(문서). 테스트: `apps/firefox-ui-demo/scripts/egdesk-board-membership.test.mjs` 7/7, egdesk-design-tokens 37/37.

#### CNV-06 — `cnv-06-canvas-memo.md`
- uc.js 'Canvas Memo (CNV-06)' 블록이 '// ============ Settings Canvas Card' 직전. 한 줄 훅 목록: MemoState import, DOCK_LEFT 'memo' + handler, `note` icon, cardKindForPersistence/runtimeStateForCard 'memo', mountBoardMember/restoreCardFromState 'memo', syncProtocolRun → attachMemoRepliesFromRun, chat chips row 3줄(memoChipForAnswer), identity/minimap icon maps.
- CSS `.egd-memo-*`는 `.egd-result-card-files-title` 뒤. `EGDeskMemoState.sys.mjs`에서 size/baseHeight/resizeMemo/memoDisplayHeight 제거됨(저장 데이터 없었음).
- 계약 수치: 접힘 240×160, 펼침 320×280, 저장 디바운스 400ms, MEMO_FRAME. 리사이즈 핸들 없음.
- 못 한 것: Memo→card `links` 그리지 않음, '수정 전 메모에 대한 답' 마커 미표시, 재촉(reminder) 알림 없음, Board 재오픈 시 `anchor.cardId` remap 미구현(bindings만 remap → '대상 없음'), 칩은 다음 Chat 렌더에 나타남(강제 emit 없음), memoId origin 서버측 미저장(사용자 메시지 텍스트의 '[메모 #N · memo-id]'가 사실상의 추적, helper 변경 없음).
- main `claude/vision-gap-20261024`를 a61b70f에서 이미 머지(충돌 없음). 테스트 `scripts/egdesk-annotation-memo.test.mjs` 18 tests. 문서 `docs/AI_CANVAS_ANNOTATION_LAYER.md` memo 섹션.

#### CODE-02 — `code-02-project-folder.md`
- CNV-03과 겹치는 파일: `EGDeskSurfaceState.sys.mjs`에 `boardProjectReference()` 추가, `planBoardProjection`/`snapshotBoardProjection`에 `project` 필드(있을 때만). uc.js `refreshBoardRegion`에 칩 1줄 + `syncBoardRegionProject` 1줄, `toggleBoardRegionMenu` items에 `...boardProjectMenuItems(projection, item)` 1줄. `scripts/egdesk-surface-state.test.mjs` 두 Board 하네스에 stub(L9222, L10198, L10256, L17068 부근) (README 대조: AGENT-05·BRW-05·07·11·CHAT-01·CHAT-03·CHAT-08·SUB-05·UX-02도 같은 파일을 고쳤다).
- D-X3: `agenda.project = {projectId, title}` 참조만으로 폴더를 자동 연결하지 않음 — 자동 연결 추가 시 결정 위반. 폴더는 네이티브 picker → `/v1/files/projects/attach`로만, 경로 문자열 전달 없음. Board 폴더 변경 시 `invalidateRoomProjectDefaults`.
- File 카드는 Board 폴더 변경을 자동 반영하지 않음(기존 '보드 프로젝트 연결'/openProject 재검증 경로) — CODE-05/07 영역.
- `helper/egdesk-file-http.test.mjs` 77 pass / 1 fail / 2 skip — 실패 1건은 `EGDESK_SQLITE_RUNTIME_UNSAFE`(이 머신 Node 24.11.1의 SQLite가 고정 런타임 조건 미달, 변경과 무관). 그 외 project-identity 3/3, surface-state 943/0/1, canvas-layout 33/33.
- 커밋 `1f37cae` → `bacb4ff` → `1b558e4` → `e6ea9f5`.

#### CODE-05 — `code-05-plan.md`
- uc.js 변경은 ChangeReview 배선 함수 안에서만: read scope origin 읽기 2줄 + 새 함수 `openAppliedChangeReview` + reader 훅 배선. fileCard zone·FileView 본문은 읽기만. uc.js L3510 `detailsView.approval(run, approval)`은 1단계 연결 지점(변경 없음).
- 회귀 수정 `db15cd2`(egdesk-surface-state.test.mjs 2건 실패 → 944 중 943 통과·1 skipped·0 실패, 테스트 파일은 안 바꿈): CSS Chat diff 셀렉터를 원래 문자열 그대로 유지하고 `.egdesk-change-review .egdesk-diff-*`를 같은 규칙에 쉼표 셀렉터로 추가(`:is()` 제거). uc.js `readOrigin`은 다시 '정확히 일치하는 command 항목'만, 2단계용 `readChangeOrigin`을 scope에 추가 — 같은 run의 정확히 일치하는 완료된 fileChange 항목만, itemKind는 호출자 options로 바꿀 수 없음.
- `EGDeskChatChangeReview.sys.mjs` 모듈은 FS를 만지지 않음 — 보존된 change 행만 넘기는 계약. SOURCE_CHANGED(D-X1)면 쓰지 않고 '검토 시점(−) vs 지금(+)' 비교 블록 + 해시 표시.
- 알려진 한계: /chat/run-changes 보존 diff가 redact 처리돼 비밀값이 섞인 hunk는 원문 복원 실패 → 'drifted' 표시(되돌리기 버튼 없음); 삭제된 파일만 있는 변경은 File 카드를 열 파일이 없어 2단계 진입 불가.
- 커밋 `9821978` + 다음 커밋(해시 미기재, "Open the applied-change review from a chat file change") + `db15cd2`. 테스트: `scripts/egdesk-change-review.test.mjs` 4/4(새), `scripts/egdesk-chat-change-review.test.mjs` 20/20(보강). 04:05 한도 중단 뒤 재개, 결과 기록 11:08 KST.

#### CODE-06 — `code-06-run-result-handoff.md`
- 구역 밖 접촉은 전부 wiring only(helper·uc.js·terminal-init 4개 파일은 +4줄씩): `helper/terminal-sessions.mjs`(runWatch option, observeOutput/observeInput/take), `helper/codex-bridge-server.mjs`(import, construct watch, close), `overlay/JS/eg-desk-surface.uc.js`(RunResult import, openBoardProjectFileAt forward, deps 2개), `egdesk-terminal-init.js`(postMessage 'terminal-run-result'), `surface/EGDeskSurfaceFileCard.mjs`(openBoardProjectFileAt 메서드 + return key), `scripts/egdesk-surface-modules.test.mjs`(forwards list·fileCard interface 기대값, deps count 33→35).
- `EGDeskRunResult.sys.mjs`의 unknown outcome headline이 '결과 확인 안 됨' → '요약 없음 · 원문 보기'로 바뀌고 `summaryless` 필드가 생김(renderer가 summaryless일 때 tail <details>를 열어 둠). EGDeskChatRunResult(CHAT-08)는 자체 문구 '완료 결과 확인 안 됨'을 쓰며 미접촉.
- 못 한 것: Chat chip for Terminal-origin results(CHAT-08 모듈 필요), Canvas standalone result card(패널은 Terminal 카드 안에 있음).
- 커밋 e13dd8e(parser+test) · 9a3c756(run watch+registry/bridge wiring) · 6d4283b(fallback) · b672c52(Terminal result card + File line open) + 뒤에 docs commit.

#### CTX-02 — `ctx-02-recovery-journal.md`
- `helper/egdesk-recovery-journal.mjs` 신규(순수): planDeskRetention → {keep, remove}, autosaveWindowMerges, localDayOf, 상수 DESK_RETENTION(200/30일/512MiB)·DESK_AUTOSAVE_MERGE_MS(60초)·DAY_MS. `helper/egdesk-desk-store.mjs`는 prune·mergeable을 위임하고 상수를 journal 모듈에서 re-export(공개 이름 유지), generations() 행에 boardCount(SQL json_type/json_each로 읽기 시점 계산, 스키마 변경 없음).
- `EGDeskRecoveryState.sys.mjs`: deskGenerationRows 행에 boards·changes, 신규 deskGenerationChanges·deskRetentionText(D-R1 안내문). uc.js 변경 지점: 복구 기록 패널(data-testid=desk-history-retention), loadDeskHistoryPage, deskHistory.generations(022810e — 페이지 경계 행도 비교).
- 테스트: egdesk-recovery-journal 8/8, desk-store 20/20, `egdesk-surface-state.test.mjs`의 '복구 기록 rows…' 1건만 `--test-name-pattern`으로 통과(파일 전체는 안 돌림).
- 커밋 5개(0fe679d, 62bcb48, e132292, 6c54987, 022810e). 문서 `docs/DESK_AGENDA_CARD_RUNTIME_MODEL.md` 'Desk recovery journal (CTX-02, D-R1)' 절. ledger·TODO 미수정(갱신 제안 텍스트만 노트에).

#### SUB-05·01 — `sub-05-settings-accounts.md`
- uc.js 변경은 Settings 구역 L13828-14110·L14943 한 줄뿐: 섹션 머리 lazy importESModule로 `EGDeskAccountSettingsView.sys.mjs` 로드, spawnSettingsCard 안 renderAccountTab, onCodexChange signature에 bridgeFailures/error 추가.
- `scripts/egdesk-surface-state.test.mjs`는 공유 파일 — Settings 하네스 6곳에 AccountSettingsView·codexBridgeNotice 두 인자 추가 + import 1줄 + settingsBridgeNotice 1줄 + production 카드 테스트를 메뉴→확인→로그아웃 경로로 갱신(943 pass / 0 fail). SUB-14가 같은 파일의 다른 부분을 고쳤다면 자동 병합될 가능성이 높으나 확인 필요.
- CSS는 '/* --- 계정 --- */' 블록 뒤. 가짜 상수 0개(`egdesk-surface-state.test.mjs`가 source 검사). 신규 `scripts/egdesk-account-settings-view.test.mjs` 9 pass. 커밋 87d253b(11:08 KST).
- 못 한 것: Claude 강제 재확인(POST /engines/claude/refresh) 미배선(bridge 클라이언트 메서드 없음; 지금 '다시 확인'은 refreshAuthStatus → /v1/state 재조회(브리지가 최대 1분 간격으로 재검사)), Terminal 카드에서 `claude auth login` 자동 실행 미구현(힌트 문구만), HUD 상단 chip에서 계정 메뉴 열기 미배선(mountCodexHUD 8318-9796은 SUB-14 구역), helper/* 전부(SUB-14)·SUB-11 다중 계정은 범위 밖.

#### SUB-14 — `sub-14-auth-states.md`
- 새 공개 필드 `/v1/state.auth.access` 및 SSE `auth.status.status.access` = `{ state, label, detail, recovery, cause, failedAt, resetsAt, resetPassed }`. state 값 ok | loginRequired | loginInProgress | authFailed | quotaExhausted | permissionDenied. recovery 값 login | reauth | switchAccount | wait | refresh — 유저가 선택, bridge는 실행하지 않음(D-S5 no auto-continue). `authState.accessFailure = { kind, cause, at, identity }`(마지막 auth/quota/permission turn 거부, cause는 allowlist).
- `helper/codex-bridge-server.mjs` 배선 지점: import 줄 / authState `accessFailure: null` / rateLimitSync 뒤 tracker 생성 / handleAppServerNotification 첫 줄 `accessTracker.notify(message)` / `authSnapshot()`의 `access` / refreshAccountState usage 재읽기 조건. `helper/codex-auth-state.mjs`에 `accountAccessState`·`usageRefreshDue`, `helper/codex-bridge-http.mjs`에 `createAccountAccessTracker`.
- `codex-chat-runtime.mjs`는 금지 영역이라 turn/start의 RPC 수준 거부는 tracker에 도달하지 않음. Claude 엔진 상태는 건드리지 않음. quota 소진 중 send 차단 없음.
- 커밋 0813e4b(helper), a960327(HUD chip + CSS + `docs/CODEX_HUD_DESIGN_V1.md` §9.1).

#### UX-02 — `ux-02-minimap.md`
- Board 영역·겹침 목록·이름 검색·카메라 이동은 `dca10a3`·`5ac3e42`(10-24/10-29)로 이미 화면에 연결돼 있었음 — 이번 범위는 '결과 행에 대상 유형·소속 Board 표시'와 'rail search 선택 시 카메라 이동'.
- 미니맵은 View의 소속 Board를 `card.dataset.projectionId`(uc.js L4310·L5003에서 설정)로 읽음 — CNV-03이 소속 마커를 `dataset.boardId` 등으로 바꾸면 `renderDeskMinimapWorld`·`buildDeskMinimapEntityRows`·`buildRailSearchCardResults` 읽기 3곳을 같이 바꿔야 함.
- `egdesk-surface-state.test.mjs`의 minimapUiHarness가 미니맵 함수들을 고정 의존성 목록(`MinimapLayout` 포함, 새 식별자 불포함)으로 컴파일 → 새 모듈 식별자를 uc.js에 넣으면 ReferenceError. 그래서 새 로직은 별도 모듈 아닌 `EGDeskCanvasLayout.sys.mjs`의 UX-02 구역(`minimapSearchRows` 바로 아래 `minimapRowKindLabel`)에 둠.
- 카메라는 기존 `moveCameraToMinimapNode`(pan만, zoom 불변)만 호출, Pan/Zoom 본문(UX-05 구역)은 건드리지 않음.
- 커밋 `4fe2cd6`(행에 유형·Board 이름) · `ebae4ef`(rail search 카메라 reveal + 소속 Board 자막) · `a8cdc54`(VIEWPORT 문서) · `65118bc`(하네스 테스트; surface-state 944/945 pass, 1 skip은 기존). 노트에 '못 한 일' 항목 없음.

#### UX-05 — `ux-05-placement-ops.md`
- 소유 영역 밖 배선: import 1줄(L31), `serializeDeskSnapshot().groups` 1줄, `restoreDeskSession` 안 `state.restoreCanvasGroups?.(...)` 1줄, 마퀴 선택에 `state.expandCanvasSelection` 1줄 — 노트는 '3줄'이라 쓰고 4항목을 나열함.
- `installCanvasPlacementOps(viewport, layer)`는 `installCanvasPanZoom` 끝에서 호출, 그 바로 뒤에 정의(uc.js 다른 블록 고치지 않음). 카드별 드래그/리사이즈 리스너(spawnDeskWindowShell·Chat·Settings·outline proxy)는 그대로 두고, window capture `pointerdown`으로 제스처 감지 후 그 카드의 `style` MutationObserver로 raw rect를 스냅 rect로 덧쓰기(paint 전, `takeRecords()`로 자기 쓰기 무시). 그룹 멤버는 같은 delta로 이동.
- main `claude/vision-gap-20261024` a61b70f 병합 완료(6259750) — 충돌 1곳(uc.js 상단 import 줄: AgentIdentityView vs CanvasLayout) → 두 줄 모두 유지. c828880은 04:05 끊김 전 미커밋 513줄을 그대로 수습한 커밋.
- 계약 수치: 24px 격자 스냅, Option 키로 해제. 커밋 bbb8052 · c828880 · 6259750 · 68b67f2 · e56df16. 테스트(고정 Node, 단건): canvas-layout 41/41 · surface-state 955(954 pass, 1 skipped, 0 fail) · surface-modules 13/13 · design-tokens 37/37 · chat-presentation 9/9 · `node --check` 통과.

## 실화면 검증 체크리스트

이번 라운드는 어느 항목도 Firefox 실화면을 보지 않았다. 아래는 각 노트가 "실화면에서 확인해야 한다"고 적은 것 전부(노트 표현 그대로 또는 노트의 '사용자가 보는 변화'를 확인 항목으로 옮긴 것). 실행은 `overnight-report-2026-10-31.md`와 원장의 다음 단계를 따른다.

### AGENT-05 — `agent-05-identity-display.md`
노트는 실화면 확인 항목을 따로 나열하지 않음. 배선만 되고 실화면 미확인인 것:
- [ ] 사진 face(`codexAvatarPhotoSource` + 브리지 `avatarImage(assetId)` 캐시, GET /profiles/avatar-images/:id)가 메시지 아바타에 보이는지
- [ ] Board 다중 run별 작업 중 버블(+이름)이 run마다 뜨는지
- [ ] 버블 클릭 → `openActivity(threadId, { runId })`로 run 포커스 기록이 열리는지
- [ ] Browser 카드 헤더 `egd-browser-agent-identity` 칩(배지 옆)이 보이는지

### BRW-05·07·11 — `brw-05-07-11-handoff.md` (`brw-05-07-11-plan.md`에는 실화면 항목 없음)
- [ ] 스폰 카드의 toolBinding 준비 시점
- [ ] documentURI vs location.href 비교
- [ ] about:blank 대체 흐름(commit layer: onLocationChange → about:blank)
- [ ] 55초 허락 패널(사이트 허락 패널 `toolAskSite`)
- [ ] open-card/close-card/history/allow-site UI 핸들러 — 하네스가 직접 돌리지 않음(helper 쪽만 테스트)

### BRW-09 — `brw-09-screenshot-observe.md`
- [ ] `drawSnapshot(null, 1, …)` 비트맵 크기가 `innerWidth/innerHeight`와 같은지(다르면 정책이 ±24px까지는 가림을 넓혀 보내고, 그 이상은 `image-size-mismatch`로 보내지 않음)
- [ ] JSWindowActorParent 서브클래스의 `sendQuery` override가 chrome 쪽 `actor.sendQuery` 호출에 적용되는지
- [ ] 실제 페이지 JPEG 크기(150000자 예산 안에 드는지), Codex `inputImage` 왕복

### CHAT-01 — `chat-01-agent-persist.md`
노트는 '미실행: Firefox 실화면, verify-chat-history-restart(재시작 프로브), 전체 glob' 한 줄만 적음. 노트의 '사용자가 보는 변화' 3건을 확인 항목으로:
- [ ] Agent 선택 후 브라우저 재시작·Board 복원 시 Desk pref 없어도 같은 Agent로 복원되는지
- [ ] 보내기 없이 ⋯ 메뉴에서 Agent 변경·'기본 Codex' 되돌림이 즉시 기록되어 재시작 뒤 '옛 Agent'가 안 되살아나는지
- [ ] 저장소 Agent가 카탈로그에 없음·보관·중지면 '찾을 수 없는 Agent' placeholder + 보내기 차단인지
- [ ] (실화면 아닌 프로브) verify-chat-history-restart 재시작 프로브 실행

### CHAT-03 — `chat-03-handoff.md` (`chat-03-plan.md`에는 실화면 항목 없음)
노트 명시: Firefox 실행 검증 없음(전용 검증 목록 없음). 화면 동작 설명을 확인 항목으로:
- [ ] Agent DM 버블 ⋯ 메뉴에 [Board Thread로 옮기기] / [여러 메시지 골라 옮기기](체크박스 + 로그 위 선택 바, 최대 20)가 나오는지
- [ ] 대상 선택에서 기존 Board Thread 목록 또는 [새 Board Thread 만들기](DM의 Agent가 Lead)가 되는지
- [ ] Board Thread에 복사본 블록(회차 저장 위치) + [원래 대화 보기] → DM의 그 버블로 이동(revealMessage 재사용)하는지
- [ ] DM에 원래 버블 유지 + '스레드로 보냄' 칩(클릭 → 해당 Board Thread)이 보이는지
- [ ] Board Thread 헤더 [DM으로 돌아오기] → 가장 최근에 보낸 DM으로 가는지
- [ ] @이름 칩(Board Thread 버블 아래), 방 목록 '@' 배지(안 읽은 Agent 줄이 @나/@사용자/@사람을 부름)가 표시되는지

### CHAT-08 — `chat-08-output-chips-handoff.md`
- [ ] 긴 결과 게시 → 답변 아래 `[결과] 제목 · 버전 1` 칩, Canvas는 그대로
- [ ] 칩 클릭 → 결과 카드 열림, 출처 줄 '게시한 결과 · 버전 1', 마크다운 렌더
- [ ] 같은 outputKey 재게시 → 칩 `버전 2`, 클릭 시 열린 카드가 새 본문으로 바뀜
- [ ] 브리지 끈 채 클릭 → 칩에 '열 수 없음', 토스트 없음; 브리지 켜고 재클릭 → 열림
- [ ] Desk 저장 후 재시작 → 카드·칩 복원, '채팅에서 보기' 동작

### CNV-03 — `cnv-03-board-membership.md`
노트 명시: 실제 Firefox 화면·접근성 트리 미확인(전용 검증 목록 없음).
- [ ] 제안 칩은 setTimeout 0 뒤 창 위치로 판정하므로 비동기로 재배치되는 열기 경로가 있으면 오판 가능 — 열기 경로별 칩 판정 확인
- [ ] 모든 Desk Window(Browser·File·Terminal·Settings·Ontology·Result) View bar에 Board 제어가 보이는지 — 소속 Board 있으면 이름 옆 ▾, 없으면 '소속 없음 ▾'
- [ ] ▾ 메뉴에 `'○○'에서 빼기` / `'△△'에 넣기`(열린 Board마다)가 나오고 한 View는 한 Board(D-V1)인지
- [ ] Board 영역 안에서 새 View 열기/영역 안으로 끌어 놓기 시 View bar 아래 `'○○'에 넣을까요? [넣기] [아니요]` 칩이 뜨고 수락 시에만 소속(D-V2·V3), 복원 중엔 칩 없음인지
- [ ] 새 Board 저장(선택한 화면 N개 저장)이 그 자리에서 영역으로 묶이고 사본 없음(D-V4), 빈 Board 저장은 목록에만인지
- [ ] 소속 변경 시 해당 Board '저장 안 됨' 표시(기존 dirty 경로)가 뜨는지
- [ ] 칩 행으로 헤더 높이가 바뀐 뒤 Browser 제목줄 충돌 보정(L19380대)이 새 ▾ 버튼·칩을 잘못 가리거나 겹치지 않는지

### CNV-06 — `cnv-06-canvas-memo.md`
- [ ] 메모 카드 전체 동작(생성·고정·드래그 재고정·펼치기·저장·묻기·답글 붙임·Desk/Board 복원)을 실화면에서 확인
- [ ] 메모 textarea에 입력 중 글로벌 Desk 키 핸들러(Delete, ⌘W)가 간섭하는지(노트: Unknown)
- [ ] Desk 창 안의 `select` 드롭다운이 정상 동작하는지(노트: Unknown)

### CODE-02 — `code-02-project-folder.md`
실제 Firefox 창·브리지 왕복 미검증(금지 범위).
- [ ] Board 헤더 [⋯] 메뉴의 '프로젝트 폴더…'(선택/바꾸기)·'프로젝트 폴더 해제' → 네이티브 picker → `/v1/files/projects/attach` 왕복
- [ ] 프로젝트 칩(testid `board-project`) 3상태: 폴더명 / '프로젝트 폴더를 다시 선택'(클릭 → picker) / '이름 · 확인 필요'(클릭 → 재조회)
- [ ] Board 폴더 변경 뒤 채팅방 기본값 캐시 무효화(`invalidateRoomProjectDefaults`)가 방 상속에 반영되는지

### CODE-05 — `code-05-plan.md`
실제 Firefox 창 미검증.
- [ ] Chat activity 카드의 적용 완료(completed) fileChange 항목에만 '적용된 변경 검토 · 되돌리기' 버튼이 보이는지
- [ ] 버튼 → `openAppliedChangeReview` → File 카드 열림 → `showChangeReview` 2단계 패널에서 덩어리별 되돌리기/취소/삭제 뒤 재읽기 결과(요청≠관찰) 표시
- [ ] SOURCE_CHANGED 시 '검토 시점(−) vs 지금(+)' 비교 블록 + 해시가 보이고 쓰기가 일어나지 않는지
- [ ] 1단계 '변경 보기'(승인 카드) diff 스타일이 회귀 수정 뒤에도 그대로인지

### CODE-06 — `code-06-run-result-handoff.md`
- [ ] real Firefox/shell verification — 미실시(노트가 구체 확인 항목은 적지 않음)

### CTX-02 — `ctx-02-recovery-journal.md`
실제 Firefox 창·브리지 기동 미실시.
- [ ] 복구 기록 패널 행 메타의 Board 수·주요 변경 표시
- [ ] 복구 기록 패널 상단 보존 규칙 안내 1줄(data-testid=desk-history-retention)
- [ ] '이 시점으로 복원'·'지금 작업에 합치기' 동작이 그대로인지
- [ ] '더 보기'로 이어 붙인 페이지 경계 행의 '주요 변경' 비교

### SUB-05·01 — `sub-05-settings-accounts.md`
- [ ] ChatGPT 카드가 '연결 확인 중'(첫 접속·조용한 재연결)과 '연결이 끊겼습니다'(재연결 소진, [다시 연결])를 구분하는지
- [ ] 계정 메뉴(상태 새로고침 / 다른 계정으로 로그인 / 로그아웃) → 확인 블록(계정 이메일·터미널 codex 공유 로그인 경고·진행 중 Run 수와 대화방 이름) → signOut → (전환이면) startLogin → refreshAuthStatus 결과 문구가 나오는지
- [ ] Claude 카드 7상태(구독 라벨+이메일 / Anthropic API 키 / 외부 제공자 / 미로그인 안내 / 미설치 / 확인 안 됨 / 연결 안 됨) + [다시 확인]이 /v1/state 재조회로 갱신되는지

### SUB-14 — `sub-14-auth-states.md`
- [ ] HUD 칩이 상태별 라벨(`한도 도달 · 오후 3:10에 초기화` / `인증 만료 · 다시 로그인 필요` / `권한 부족 · 접근 거부`)을 보이는지
- [ ] recovery(login|reauth|switchAccount|wait|refresh)는 표시만 하고 bridge가 자동 실행하지 않는지(D-S5)

### UX-02 — `ux-02-minimap.md`
- [ ] 미니맵 목록·겹침 행에 대상 유형과 소속 Board 이름이 보이는지
- [ ] rail search에서 Canvas 결과를 선택하면 카메라가 reveal(pan만, zoom 불변)되고 소속 Board 자막이 뜨는지

### UX-05 — `ux-05-placement-ops.md`
- [ ] MutationObserver 덧쓰기 타이밍
- [ ] remote `<browser>` 위 pointer 이벤트 target
- [ ] header focus 이동(배치 변경 뒤 View bar에 tabindex=-1 부여 후 focus)
- [ ] 창 두 개 띄우고 끌기 → 24px 격자/가장자리 스냅 + 안내선
- [ ] Option 누르면 (스냅) 해제
- [ ] 끌고 난 뒤 ⌘Z
- [ ] View bar 우클릭 → 메뉴
- [ ] 두 창 선택 후 [그룹으로 묶기] → 점선 프레임, 한 창 끌면 함께 이동
- [ ] Desk 저장 후 재시작해 그룹 유지

## 대표님 결정 대기

노트가 '가정' 또는 '미결'로 표기한 것. 지금 코드는 아래 값대로 동작한다.

- `brw-05-07-11-plan.md`, `brw-05-07-11-handoff.md` (BRW-05·07·11):
  - 유휴 만료 30분 — D-B3에 수치 없음(가정)
  - Stop도 standing grant를 끝낸다(보수적, 가정)
  - 카드 4개/Run 상한(가정, handoff)
  - 허용 사이트 요청 대기 55초(transport 60초 상한 안, 가정, handoff)
  - observe 선택은 기존대로 1회용 유지(가정; 변경 없음)
- `chat-08-output-chips-handoff.md` (CHAT-08): D-K3 미결 — 결과 카드 기록에 본문 사본(≤20,000자)을 저장(현재, CHAT-04 방식·채택 지도 '기본값으로 진행 가능') vs 참조만('reference only'). 'reference only'로 결정되면 publishedOutputCardRecord의 text를 비우고 복원 때 브리지에서 읽도록 변경(코드 주석에 남김).

그 외 노트에는 적힌 결정 대기 없음.

## 다음 작업 포인터

노트의 '남은 것/못 한 것/다른 세션에 알릴 것'을 모았다. '(참조)' 표시는 완료된 산출물 위치. 괄호는 출처 노트.

공통
- Firefox 실화면 확인 — 전 세션. 위 '실화면 검증 체크리스트'가 목록(전 노트).
- 브랜치 push·후속 병합 포인터는 16개 브랜치 병합·origin push 완료로 해소됨(`agent-05-identity-display.md`, `brw-05-07-11-handoff.md`, `brw-09-screenshot-observe.md`, `chat-01-agent-persist.md`, `chat-03-handoff.md`, `code-06-run-result-handoff.md`, `ux-05-placement-ops.md` 등).
- 원장(`ideas/confirmed/EGDESK_VISION_GAP_LEDGER.md`)은 이번 라운드 결과를 3차까지 반영함. 노트의 갱신 제안 문구는 대조용: CHAT-08 상태표 `일부` → `완료(실화면 미검증)` + 상세 진행·남은 것 문구(`chat-08-output-chips-handoff.md`), CTX-02 행 진행 문구(`ctx-02-recovery-journal.md`), CODE-05 ledger 8580896 행 "화면 연결 S3·S10 남음" 갱신(`code-05-plan.md`), ledger L929-937 navigate 걸러짐 서술 stale(`brw-05-07-11-plan.md`), CHAT-01·CHAT-03 원장·docs 미반영(`chat-01-agent-persist.md`, `chat-03-handoff.md`).
- `egdesk-surface-state.test.mjs` 전체 단건 재실행 — AGENT-05(pin 갱신 후 1개만 재실행)·CTX-02(1건만 패턴 실행)가 미실행으로 남김(`agent-05-identity-display.md`, `ctx-02-recovery-journal.md`).

AGENT-05 (`agent-05-identity-display.md`)
- File 카드 Agent 정체성 배지 — `EGDeskSurfaceFileCard.mjs`(CODE-02 세션 구역), BRW-13 같은 활동 데이터부터 필요.
- 사진 읽기 실패 시 재시도(미구현).

BRW-05·07·11 (`brw-05-07-11-plan.md`, `brw-05-07-11-handoff.md`)
- (참조) `docs/BROWSER_AGENT_OBSERVATION_RUNTIME.md` Tools 표·새 절·Wiring Status(633bbea로 갱신됨).
- (참조) 테스트: `helper/egdesk-browser-tool-runtime.test.mjs`, `helper/codex-browser-tool-provider.test.mjs`(L71 기대 수정 + 추가), 신규 `scripts/egdesk-browser-grant.test.mjs`.
- D-B10/D-B11(이 세션 범위 밖).
- 마지막 커밋(Guard link and redirect landings) 해시 노트 미기재 — `claude/vision-gap-20261024` 이력에서 확인.

BRW-09 (`brw-09-screenshot-observe.md`)
- (참조) `docs/BROWSER_AGENT_OBSERVATION_RUNTIME.md` 'Masked Screenshot' 절·Tools 표·Wiring Status.
- brw-05-07-11 노트(충돌 대조 대상, 이미 병합됨).

CHAT-01 (`chat-01-agent-persist.md`)
- verify-chat-history-restart 재시작 프로브 실행.
- Board 저장 record(chat card) thread binding — 원장 '빠진 것' 3번째 항목, 별도 작업.

CHAT-03 (`chat-03-plan.md`, `chat-03-handoff.md`)
- /chat/board/send(D-M2 라우팅) 화면 연결 → CHAT-10 범위.
- 설치/복사 스크립트가 resources/*.sys.mjs를 통째로 복사하는지 확인(`EGDeskThreadRouting.sys.mjs` 배포 경로).
- helper D-M3 기존 구현 커밋 2d9672e(`POST /chat/share`, `shareMessages()`, `messages.shared.*`) — 참조.

CHAT-08 (`chat-08-output-chips-handoff.md`)
- D-K3가 'reference only'로 결정되면 publishedOutputCardRecord의 text를 비우고 복원 때 읽도록 바꾸면 됨(코드 주석에 남김).

CNV-03 (`cnv-03-board-membership.md`)
- Chat 카드(spawnCodexChatCard, Desk Window 셸 아님)와 도형에 View bar 메뉴·칩 추가 — 모듈은 kind 'shape' 지원.
- 제안 칩 setTimeout 0 판정 — 비동기로 재배치되는 열기 경로가 있는지 점검(오판 가능).
- 실제 Firefox 화면·접근성 트리 확인.

CNV-06 (`cnv-06-canvas-memo.md`)
- (참조) `docs/AI_CANVAS_ANNOTATION_LAYER.md` memo 섹션.
- 후속: Memo→card `links` 그리기 / '수정 전 메모에 대한 답' 마커 표시 / 재촉(reminder) 알림 / Board 재오픈 시 runtimeState `anchor.cardId` remap / 답글 붙은 뒤 Chat 칩 강제 emit 여부 / memoId origin 서버측 저장 여부(현재 helper 변경 없음).

CODE-02 (`code-02-project-folder.md`)
- CNV-03 세션에 알릴 것: SurfaceState `boardProjectReference()`/`project` 필드, uc.js `refreshBoardRegion`·`toggleBoardRegionMenu` 1줄씩, surface-state 테스트 하네스 stub.
- CODE-05/07에 알릴 것: File 카드는 Board 폴더 변경을 자동 반영하지 않음(기존 '보드 프로젝트 연결'/openProject 재검증 경로).
- 테스트 수치 기준선: project-identity 3/3, file-http 77/1/2, surface-state 943/0/1, canvas-layout 33/33.

CODE-05 (`code-05-plan.md`)
- 후속: redact 처리된 hunk(비밀값 포함)의 'drifted' 표시 — 되돌리기 가능하게 할지.
- 후속: 삭제된 파일만 있는 변경의 2단계 진입 경로(File 카드 없음).
- 결정 참조: D-X1(SOURCE_CHANGED면 쓰지 않음), D-X2(승인 전 1단계). 테스트 파일 `scripts/egdesk-change-review.test.mjs`(새), `scripts/egdesk-chat-change-review.test.mjs`(보강).

CODE-06 (`code-06-run-result-handoff.md`)
- Chat chip for Terminal-origin results → CHAT-08 모듈 완성 후.
- Canvas standalone result card.
- b672c52 뒤에 docs commit 있음.

CTX-02 (`ctx-02-recovery-journal.md`)
- (참조) `docs/DESK_AGENDA_CARD_RUNTIME_MODEL.md` 'Desk recovery journal (CTX-02, D-R1)' 절.
- 실제 Firefox 창·브리지 기동 검증.

SUB-05·01 (`sub-05-settings-accounts.md`)
- Claude 강제 재확인: bridge 클라이언트에 메서드 추가 후 POST /engines/claude/refresh 배선.
- Terminal 카드에서 claude auth login 자동 실행.
- HUD chip 계정 메뉴 → SUB-14. 다중 계정 → SUB-11.

SUB-14 (`sub-14-auth-states.md`)
- SUB-05(Settings account card): `auth.access.label/detail`로 isLoggedIn 전용 문구 대체 가능, `auth.access.state === 'quotaExhausted'` + `resetsAt`로 한도 안내.
- (참조) `docs/CODEX_HUD_DESIGN_V1.md` §9.1(HUD 칩 문서).
- 미완 후속: RPC 수준 turn/start 거부의 tracker 연결, quota 소진 시 send 차단.

UX-02 (`ux-02-minimap.md`)
- CNV-03(소속 마커 변경 시 미니맵 읽기 3곳 연동).
- (참조) VIEWPORT 문서(`a8cdc54`).

UX-05 (`ux-05-placement-ops.md`)
- (참조) interaction model 문서(e56df16).
