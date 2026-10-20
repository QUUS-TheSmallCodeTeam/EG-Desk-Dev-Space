# Firefox Shell Path 1.5 Stabilization

**Date**: 2026-05-18
**현황 갱신**: 2026-09-27 (KST; 검증 시작 2026-09-26)
**Status**: 선정한 Firefox Shell 로컬 기반 구현·검증 완료; 제품 전체·Gecko 배포는 범위 밖
**Scope**: `apps/firefox-ui-demo/`

---

## Goal

Path 1 proved that Firefox chrome JS can host the EG-Desk surface. Path 1.5 turns that proof into a repeatable local POC before packaging starts.

This phase is not for expanding the product surface. It is for making the current surface reliable enough that Path 2 is mostly packaging, branding, updater, and distribution work.

---

## Source Anchors

| Area | Source |
|------|--------|
| Firefox chrome runtime | `overlay/JS/eg-desk-surface.uc.js` |
| Surface styles | `overlay/CSS/eg-desk-surface.uc.css` |
| Codex bridge | `helper/codex-bridge-server.mjs` |
| Terminal iframe | `overlay/resources/terminal.html` |
| Terminal shell selection / HTTP contract | `helper/terminal-platform.mjs`, `helper/terminal-http.mjs` |
| Windows per-session ConPTY driver | `helper/terminal-windows-process.mjs`, `helper/terminal-pty-worker.mjs` |
| Rust helper candidate (not the active terminal route) | `helper-rust/` |
| Repeatable scripts | `scripts/` |
| Chat/canvas/agent UX model | `docs/CHAT_CANVAS_AGENT_LAYER_MODEL.md` |

---

## 구현·검증 현황 — 2026-09-27

로컬 브랜치 `codex/local-product-foundation`의 체크포인트는 `217482b`이다.
최종 런타임 코드 기준은 `f88eeb5`이며 Markdown 표시 보정과 문자열
`Origin: null` 거부를 포함한다. Node 통합 검사 184/184와 최종 완료 응답
재표시 16/16을 포함해 선정한 로컬 기반의 구현·검증이 완료됐다.
원격 push는 없었다. 완료 범위는 Firefox Shell 프로토타입의 선정한 로컬
기반이며 제품 전체와 Gecko 독립 배포·패키징은 포함하지 않는다.

구현된 로컬 경로는 브라우저 우선 진입, 독립 Board 투영·저장, 일반 Codex
app-server의 Chat 스트림·유형별 활동·중지·수동 승인·`artifactRefs`이다.
일반 런타임의 작업 디렉터리 컨텍스트 전달과, 잘못된 경로에 대한 네이티브
RPC 이전 `400 INVALID_CWD` 응답도 코드에 반영됐다.
Terminal 카드는 `127.0.0.1:39218`의 Node HTTP helper를 사용하며
`node-pty`를 우선하고 불가하면 `child_process` pipe로 대체한다. Codex
app-server는 별도 loopback `127.0.0.1:39219`에서 동작한다.
Terminal 초기화는 CSP가 허용하는 외부 chrome 리소스
`overlay/resources/egdesk-terminal-init.js`로 옮겼다. Helper는 전달된
Fetch Metadata 값의 허용 목록 검사를 보강했다. 후속 `6f6162c`는 문자열
`Origin: null`을 모든 경우에 거부하며, 헤더가 없는 정상 요청은 계속 허용한다.
Markdown 표시 보정 `f88eeb5`도 반영됐다. CSP·CORS·principal 보안 경계의
완화는 없다.

검증은 2026-09-26~27(KST)에 진행됐다. Terminal 결과 JSON은 11개 검사
통과와 동일 세션의 네이티브 종료를 확인하며, 실행 메타데이터의 소스 지문
11개는 `16e4c0b`의 파일과 모두 일치한다. 최종 재표시 결과 JSON은 16개
검사 통과를 확인하고 실행 메타데이터의 소스 지문 13개는 `f88eeb5`와 모두
일치한다. 기존 artifact 파일의 실제 해시도 이전 실행·최종 재표시 기록과
같다. 핵심 UI·복구 실행 기록과 최종 화면 검토가 완료됐으며, 검증 유형과
적용 범위는 다음과 같다.

| 검증 구분 | 기준과 확인 결과 | 범위·제한 |
|---|---|---|
| 정적 검토 | 알려진 P1/P2 항목 종료. 최종 Markdown 원본 `77007a7`와 Origin 보강 원본 `d15b274`의 검토도 P1/P2 지적 없이 통과했으며 통합 기준은 `f88eeb5`다. QA 스크립트·pre-commit 범위의 검토도 통과했다. | 정적 검토 결과다. 아래 자동 검사·실제 UI 결과와 구분한다. |
| 통합 로직·인프라 검사 | 통합 HEAD `f88eeb5`와 QA 스크립트 기준 184/184 통과: UI 73, production helper 79, Firefox profile guard 9, QA 인프라 23. | QA 인프라 23건은 테스트 도구 검사다. 아래 실제 UI 수용 결과와 별도로 집계한다. |
| 실제 Firefox 첫 사용 | 8/8 통과. 첫 화면에서 sidebar/dock이 숨겨지고 Desk 진입 뒤 표시되며, 논리 Browser 크기 `1440×817`과 동일 Browser 인스턴스가 유지됐다. | 전용 QA profile의 첫 사용·Desk 전환 검증이다. |
| 실제 Firefox Board | 이전 `UI301`에서 열기·재열기·resource ID 충돌 저장·닫기 4개 흐름 통과. | 이후 수정 전체의 재검증 결과로 간주하지 않는다. |
| 실제 Firefox Chat fixture | 새 전체 실행 43/43 통과. 스트림 원문·표시 줄, 사용자 말풍선 정렬, 네이티브 스크롤, 활동 표시, hydration/replay 중복 방지, 명시적 artifact 열기와 일반 텍스트의 artifact 미생성을 포함한다. | 격리된 stub 전송으로 실제 UI를 검사했다. 실제 계정 로그아웃·새 OAuth는 실행하지 않았다. |
| 실제 Chat UI artifact | 기존 ChatGPT 인증으로 16/16 통과. UI 클릭 전 manifest의 작업 디렉터리가 반영됐고, 실제 네이티브 run 1개가 완료되어 고유 TXT 파일 1개가 생성됐다. 같은 응답의 구조화된 참조, 새로고침 후 사용자 메시지 중복 방지, chip 클릭 전 카드·카메라 변화 없음, 클릭 후 Canvas의 실제 파일 내용 표시를 확인했다. | 승인·재전송·인증 변경은 필요하지 않았다. 실제 provider 실행과 TXT 파일 검증 근거다. |
| 최종 완료 응답 재표시 | `f88eeb5`에서 제어된 이어검사 16/16 통과. 코드의 언더스코어가 원문 그대로 표시되고 로컬 파일 링크는 읽을 수 있는 이름으로 나타났다. 같은 응답의 artifact 활성화와 원문 보존을 확인했다. 신뢰된 HTTP/SSE는 200, 문자열 `Origin: null`은 403이었다. | MCP 응답 확인 timeout 당시 동작은 이미 반영돼 있었으며 이를 반복하지 않고 기존 완료 이력의 검사를 이어갔다. `POST /chat/send` 0회, 새 네이티브 run 0개였으며 기존 run 1개와 artifact 파일 해시가 유지됐다. |
| 손상된 Desk 복구 | 제어된 이어가기 5/5, 같은 profile 재시작 4/4 통과. | 손상 원본과 새 작업이 보존됐다. 검증 범위는 제어된 이어가기와 재시작이다. |
| 부분 Desk 복구 | 최초 복구 5/5, 같은 profile 재시작 4/4 통과. | 원본과 새 작업이 재시작 후에도 보존됐다. |
| 실제 Terminal / PTY | 통합 HEAD `16e4c0b`에서 11/11 통과. UI의 명시적 새 세션 요청으로 HTTP spawn 1회가 200을 반환했고 `Origin`·`Sec-Fetch-Site` 헤더는 없었다. `printf` nonce 출력 후 Board 닫기에서 동일 session ID의 종료 영수증(`status: EXITED`, `exitConfirmed: true`, `exitSource: pty.onExit`)을 확인했다. | 실제 네이티브 node-pty 종료 결과다. 네트워크 기록의 JSON `null`은 헤더 부재를 뜻하며 문자열 `Origin: null`이 아니다. |
| 실제 Codex backend | 이전 backend `2b`에서 기존 ChatGPT 인증(`ready`, `chatgpt`)으로 Sol/max 무도구 턴이 `EGDESK_BRIDGE_OK`를 반환하며 완료됐다. | 최근 Chat UI 전체와 새 OAuth, 실제 사용자 로그아웃을 검증한 것은 아니다. |

선정한 로컬 기반의 구현·검증은 완료됐다. 승인·계정 로그아웃 검사는 격리
fixture에 한정했고 실제 사용자 계정 로그아웃과 새 OAuth는 실행하지 않았다.
전체 제품 기능과 Gecko 배포·패키징은 별도 과제로 남는다. Owner의 15개
질문은 열려 있고 Jev 초안은 채택되지 않았다. API 키·네트워크 인프라·개인
프로필 데이터 변경은 없었다.

검증 전용 런타임 정리는 완료됐으며 2829·6001·39218·39219 포트에
리스너가 없음을 확인했다. 검증 프로필·증거·기존 artifact 파일은 보존됐다.

저장소 루트에서 실행하는 반복 검사 명령:

```sh
node --test apps/firefox-ui-demo/scripts/test-firefox-profile-guard.mjs
node --test apps/firefox-ui-demo/helper/*.test.mjs
node --test apps/firefox-ui-demo/scripts/egdesk-surface-state.test.mjs
node --test apps/firefox-ui-demo/scripts/egdesk-chat-fixture-transport.test.mjs apps/firefox-ui-demo/scripts/egdesk-chat-qa-contract.test.mjs apps/firefox-ui-demo/scripts/firefox-mcp-chat-harness.test.mjs
```

실제 Firefox 재현 진입점은
`scripts/verify-firefox-mcp-first-use-board.mjs`,
`scripts/verify-firefox-mcp-chat-baseline.mjs`,
`scripts/verify-firefox-mcp-chat-fixture-flow.mjs`,
`scripts/verify-firefox-mcp-chat-real-turn.mjs`이다. 실행 대상은 별도로
기동한 전용 QA profile이어야 한다. Board·복구 사례는 명시적
`EGDESK_QA_STATE_FIXTURES=1` 설정이, Chat fixture 전송은 별도 선택한
`EGDESK_QA_FIXTURE_TRANSPORT=1`과 fixture token이 필요하다. QA runtime
lease의 자동 fixture 생명주기 처리는 표시된 전용 profile과 stub server에만
한정된다. 실제 Chat UI 검사는 `EGDESK_QA_REAL_TURN=1`과 fixture 전송
비활성화가 필요하다. 기존 인증을 사용하며 실제 계정 로그아웃·새 OAuth는
검사 범위에 포함하지 않는다.

---

## P0 Order

### 1. Codex HUD Runtime Contract

Stabilize the Codex path before multi-provider work.

Acceptance criteria:
- `/v1/state`, `/auth/status`, `/auth/start`, `/auth/cancel`, `/auth/signout`, `/chat/send` return stable shapes.
- Duplicate login attempts do not create stuck UI states.
- `conversationId` is owned by the active thread and survives HUD-to-canvas moves.
- Send failure shows a product error state, not raw transport leakage.
- Diagnostics remain available but are not the primary UX.

### 2. Browser Entity / Popup / Gesture

Stabilize the real browser card because it is the core EG-Desk execution surface.

Acceptance criteria:
- Browser card create, close, move, resize, back, forward, reload, and URL entry work repeatedly.
- `window.open` / OAuth-like popup routes to a browser card.
- Active card scroll and desk pan/zoom do not switch owner mid-gesture.
- Failure to create a XUL `<browser>` is visible as a blocker, not silently treated as equivalent to the iframe fallback.

### 3. Terminal / Helper Path

The current local POC route is `terminal.html` through the Node bridge HTTP
endpoints on `127.0.0.1:39218`. On Windows, Node 24 and `node-pty` 1.1.0 use
ConPTY in an owned per-session worker process; PowerShell is the default and
CMD is selectable. Windows fails explicitly if ConPTY is unavailable rather
than returning a limited pipe session as a successful terminal. POSIX retains
the native PTY route with an explicitly limited `child_process` pipe fallback.
Windows exit confirmation requires both a native shell `onExit` receipt and
clean termination of that session's worker. The Rust/WebSocket `39300` route is
historical candidate material, not an equal active product route. The Codex
app-server on `127.0.0.1:39219` is a separate loopback dependency.

Acceptance criteria:
- Spawn, write, read/output, resize, and kill pass from the UI card.
- Helper/bridge unavailable state is shown inside the terminal card.
- Closing the card cleans up the PTY session.

### 4. Repeatable Smoke Scripts

Move from one-off probes to scripts that can be rerun before each packaging attempt.

Minimum scripts:
- bridge health/auth state smoke
- HUD send/resume smoke
- browser card spawn/popup smoke
- terminal spawn/write/kill smoke
- console error capture smoke

All repeatable scripts should live under `apps/firefox-ui-demo/scripts/`.

---

## Gate To Path 2

Path 2 starts only when:

- 80% or more of the Path 1.5 checklist in `ideas/confirmed/FIREFOX_SHELL_ROADMAP.md` is satisfied.
- Remaining gaps are explicitly classified as `packaging blocker` or `deferred`.
- The active implementation path is still `apps/firefox-ui-demo/`.
- No root-level probe scripts are required to validate the POC.

---

## Deferred For Later Discussion

These are intentionally out of Path 1.5:

- First real execution workflow demo
- Path 2 packaging start
- Multi-provider expansion beyond Codex
- Mini-app marketplace
- WASM acceleration

## Windows Browser guard QA — 2026-10-19 follow-up

This Windows path is isolated fixture QA. It does not enable ordinary-site
interaction, accept the proposed Browser grant lifetime, or prove a native
model turn. The earlier macOS acceptance results above remain separate.

Prerequisites:

- Node 24+ for the application/helper tests; Firefox installed locally with the
  existing fx-autoconfig bootstrap. The QA launcher does not install or replace
  Firefox's application-wide bootstrap.
- An explicit `chrome/utils` source containing exactly the six allowlisted
  loader utilities. It is read only; no existing user profile is modified.
- An explicitly installed [Firefox MCP moz 0.10.4](https://github.com/mozilla/firefox-devtools-mcp/tree/v0.10.4) entry and
  Windows x64 [geckodriver 0.37.0](https://github.com/mozilla/geckodriver/releases/tag/v0.37.0). The harness does not run npx or download tools.
  The official geckodriver ZIP SHA256 is
  `9ae5cb90ea9364cd385bb8313b57699e090bbec7c92af4bd65a79d6d8bbc3036`.
  Local tool installations may live under ignored `.tmp/windows-browser-qa-tools/`.

From the repository root, prepare one dedicated profile:

```powershell
# Select an installed Node 24+ executable and a dedicated loader source.
$qaNode = '<absolute path to node.exe>'
$qaLoader = '<absolute path to the six-file chrome/utils directory>'
$qa = (& $qaNode apps/firefox-ui-demo/scripts/bootstrap-egdesk-chat-test-profile.mjs --loader-source $qaLoader) | ConvertFrom-Json
$qaProfile = $qa.profile
$env:EGDESK_QA_MCP_ENTRY = '<canonical installed path to dist.moz/index.js>'
$env:EGDESK_QA_GECKODRIVER = '<canonical installed path to geckodriver.exe>'
$env:EGDESK_MARIONETTE_PORT = '2828'
$env:EGDESK_QA_BROWSER_NEGATIVE = '1'
$env:EGDESK_QA_FIXTURE_TRANSPORT = '1'
$env:EGDESK_QA_FIXTURE_TOKEN = 'QA_' + [guid]::NewGuid().ToString('N')
```

The profile and evidence directories are direct canonical children of the OS
temp directory. Windows ownership uses SID/DACL validation, not POSIX uid/mode.
Only newly created QA directories have inheritance removed and access restricted
to the current user, SYSTEM and Administrators. The user's temp parent is not
re-permissioned. Existing writable or linked targets are refused.

Start the following in separate terminals carrying the same explicit profile
and environment values. Do not attach to an existing production bridge on
39218. No existing process is automatically stopped.

```powershell
& $qaNode apps/firefox-ui-demo/scripts/egdesk-chat-fixture-transport.mjs --profile $qaProfile
& $qaNode apps/firefox-ui-demo/scripts/run-firefox-mcp-target.mjs --profile $qaProfile --mode automation --marionette-port 2828 --remote-agent-port 6000
# Use a short execution timeout, independent of any scheduled development round.
$qaDeadline = [DateTime]::UtcNow.AddMinutes(20).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
& $qaNode apps/firefox-ui-demo/scripts/verify-firefox-mcp-native-tool-flow.mjs --serve-browser-fixture --browser-fixture-port 39220 --deadline-utc $qaDeadline
# Copy the exact URL and marker printed by that owned fixture server.
& $qaNode apps/firefox-ui-demo/scripts/verify-firefox-mcp-native-tool-flow.mjs --cases browser-negative --profile $qaProfile --browser-fixture-url '<fixture URL>' --browser-fixture-marker '<fixture marker>' --deadline-utc $qaDeadline
```

Automation mode suppresses the Firefox first-run notification with [Mozilla's
test preference](https://github.com/mozilla-firefox/firefox/blob/main/remote/shared/RecommendedPreferences.sys.mjs)
`termsofuse.bypassNotification`; it never sets accepted terms
version/date or installs an enterprise acceptance policy. Normal mode disables
remote automation and removes that notification bypass. Windows's persistent
`parent.lock` is checked with an exclusive open-existing handle before writing.

Expected evidence consists of eight scoped B/UI/actor denials, exact request/run/
Card correlation, independent before/after DOM and viewport, and an unchanged
actor `perform` entry count. A controlled fixture click must first advance that
count exactly once. This is not a physical-input counter. The fixture backend
must remain bound to the same profile with zero sends, auth writes and Chat runs
before and after. Results and screenshots are retained in the dedicated
`egdesk-chat-evidence-*` directory; the result prints its `evidenceFile` path.

Native/source/browser model cases still require the real-provider, authentication,
native schema, read-only policy and Memories-isolation gates. Their negative-model
adapter remains unavailable. Native/source command receipts are still POSIX-only.
Windows native descriptor-relative Save As is unavailable; managed drafts and
reading remain available without advertising that unsupported capability.

Observed on 2026-10-19, Windows / Firefox 158.0:

- The owned live Firefox fixture passed all eight B/UI/actor denial cases.
  The positive control advanced the actor perform-entry counter from 0 to 1;
  every denied action left it unchanged, together with the independent fixture
  DOM/input observations. A height-only viewport change (1440×870 → 1440×997)
  was observed and its old action was rejected.
- Before and after: fixture Chat sends 0, auth writes 0, Chat runs 0; native
  provider turns 0. `nativeModelOriginVerified=false`,
  `actorPhysicalDispatchCounterVerified=false`, `fullScenarioVerified=false`.
- Related regression suite: 123 passed, 0 failed, 2 skipped (the POSIX shell
  receipt and actual POSIX native Save As binary). A file-symlink test branch
  requires Windows Developer Mode; directory junction denial and real DACL
  write-permission tampering were checked on this host.
- Regression Node was 24.19.0; the standalone live fixture runner used 22.23.2.
  The installed Windows Codex 0.160.1 executable also passed its generated-schema
  checks without starting a model turn. The screenshot was inspected separately;
  the automated runner's `visualReview` field remains `pending`.
- This is not the nine-case native-model negative E2E acceptance. Initial live
  attempts exposed first-run notification/Desk entry and width-only resize-wait
  problems, which were corrected before the complete passing run.

## Windows native Browser execution and Chat polish — 2026-10-20

The ordinary Chat send now forwards its explicit Browser selection with the
existing `browserBounded` native safety envelope. A fresh native conversation
registers observe/click/fill only when its first request has an explicit single
HTTP(S) Card interaction selection. Actual authority comes from that run's UI
token binding, not from its native catalog, saved policy or history. An omitted
selection on a following send grants no Browser action. A previously registered
observe-only conversation cannot silently gain click/fill: the UI asks for an
explicit new Chat while retaining the old history and draft. Navigation is not
exposed by this path. No permanent/default Browser grant policy was adopted.

The native policy remains verified read-only/offline/never-approval with an empty
external MCP catalog. UI token binding completes before Browser callback dispatch;
it is not a pre-native-turn reservation. A failed bind declines buffered tool
callbacks, revokes authority and interrupts the owned native turn.

For the ordinary UI path, create an explicit new Chat before its first native
turn, choose `Chat 조작 허용` from the intended Browser Card menu, then send the
page-local request from Chat. The menu describes this Card and this Chat execution
only. Re-select the Card for a later run; the previous selection is not renewed
by continuing the conversation. No QA fixture environment or policy interceptor
is required for this path.

Windows startup now accepts the exact installed `0.163.0-alpha.10.2` prerelease
only with its generated experimental schema and executable fingerprint proof;
other prereleases are not implicitly enabled. Windows Chat storage uses actual
owner SID/DACL checks shared with QA, refusing unsafe existing files without
changing their permissions. The current installed native binary was used rather
than running an older binary against the shared native account/state directory.

Chat styling now uses a calmer neutral palette, a clearer header/message/input
hierarchy, readable auxiliary controls, and a compact attachment/composer layout.
Stop, errors, approvals, activity records, diagnostics and existing selectors are
retained. Pending scroll intent survives rapid SSE rerenders before the next
animation frame; user scrolling and message anchors still win. Unknown history
coverage is presented as an unconfirmed range, not as a failed history fetch.

Observed on Windows / Firefox 158.0 / Node 24.19.0:

- An actual native model completed observe/click/observe/fill on the owned local
  fixture, with four correlated native tool items and independent DOM/input
  changes. Its first acceptance run correctly failed the stronger final-answer
  visibility check, exposing the rapid-rerender scroll bug fixed above.
- Updated Chat screenshots were inspected at 440×680 Card size. The persisted
  actual final answer and fixture marker were visible after reload; the activity
  and composer controls remained available. This screenshot is not a new model
  execution receipt.
- The actual completed run's activity drawer showed all four completed tool
  records. Opening and closing that drawer preserved a long unsent draft. A
  separate 420×420 layout probe exposed an over-tall composer; the compact
  composer follow-up retained the title, run status and transcript space.
- Runtime/provider/UI/real-proof regression suite: 277 passed, zero failed,
  one skipped POSIX command receipt. A subsequent history-copy test also passed.
- The ordinary unmodified-request Browser acceptance passed on the second real
  model run: `browserBounded`, four native tool items, exact single-Card binding,
  independent DOM/input change, unchanged focus/Canvas/control Card, and a visible
  final Chat answer linked to its actual native item. The request witness forwarded
  the exact original fetch input/init/body; the bridge had no fixture-transport or
  fixture-Browser opt-in environment. `ordinaryUiRequestUnmodified=true`,
  `renderedFinalAnswerVerified=true`, `nativeModelOriginVerified=true` and
  `selectedRealExecutionVerified=true` were observed. Evidence was retained under
  `egdesk-chat-evidence-1fcb8657edd12e3d/result.json` in the OS temp directory.
- Two non-overlapping Windows regression groups subsequently passed: 229 and
  149 tests, zero failures; three inapplicable checks were skipped (old 0.160.1
  native discovery, POSIX shell receipt, actual POSIX native Save As).
- The compact-composer follow-up added six geometry/observer/style regression
  cases; the full surface-state suite then passed 163/163. The textarea budget accounts
  for real title/status/notices and composer chrome, reserves transcript space,
  and observes vertical Card resizing without a self-triggering height loop.
- The final actual Windows 420×420 interior probe measured input height 57px,
  scrollable long draft, log height 104px and readable content height 80px after
  subtracting padding. Title, run status, Send and log all remained inside the
  Card. The long draft was preserved; no model turn was started by this probe.
  Screenshot: OS temp `egdesk-chat-evidence-7c712f1263f03168/`.
- Final non-overlapping regression totals after the compact follow-up: 385 passed,
  zero failed, three skipped across the same two groups (236 + 149 passed).
- Local-fixture success is not proof of arbitrary-site workflows,
  account operations, navigation, submissions or the nine-case native negative
  acceptance. The existing `fullScenarioVerified` result must remain false while
  that negative adapter is unavailable.

## Windows Terminal strengthening — 2026-10-20 (KST)

- Windows selects normally installed PowerShell 7, otherwise OS Windows
  PowerShell 5.1; CMD is an independent selectable Card. Shell commands retain
  their own syntax. The developer tool's private bundled `pwsh` is not selected
  just because it happens to precede system shells on PATH.
- The active route remains Node HTTP plus `node-pty`/ConPTY, not Rust.
  Each Windows terminal owns a separate Node worker so native driver residue
  cannot accumulate in the long-lived Chat/HTTP bridge. Only native `onExit`
  plus a clean worker close publishes `EXITED`; missing evidence stays unknown.
- Windows PowerShell and CMD rebuild their child-only `PSModulePath`, avoiding
  inherited PowerShell 7 module collisions through an intermediate Node host.
  This follows Microsoft's [intermediate-process guidance](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath).
  No registry, persistent environment or execution-policy setting is changed.
- UI input is serialized without replay, reconnect retains the known session,
  and composition handling waits for native xterm input before a bounded fallback.
  Definite rejection is separate from ambiguous startup; the latter cannot
  silently spawn again or invent an empty-session close receipt.
- The explicit `scripts/verify-windows-terminal.mjs --run` fixture passed on
  this PC (Windows build 26200, Node 24.19.0, `node-pty` 1.1.0), using the actual
  product HTTP handler/factory on an owned ephemeral loopback port. PowerShell
  and CMD both executed constructed bare output markers, default-codepage Korean
  text, DEL character deletion, native BS8 previous-word deletion and multiline
  input. Actual Console dimensions changed from 80×24 to 103×31. Ctrl+C interrupted
  a 30-second child operation and the same shell continued within one second.
  Explicit `exit 0` and requested termination were independently verified for
  each shell: four native/worker exit receipts, zero remaining owned sessions,
  closed test HTTP server and natural verifier process exit code 0.
- The PowerShell fixture sets no-save history at an owned path before interactive
  input; those QA initialization arguments differ from the ordinary product
  defaults. It does not start the normal bridge, invoke a model or touch the
  running Firefox profile. Physical Windows keyboard/IME/clipboard input and
  rendered Firefox Terminal Card verification remain unverified by this fixture.
- Final relevant regression: 246 passed, zero failed/skipped (38 Terminal backend,
  188 Terminal/surface frontend, 16 existing Chat HTTP, four proof-contract tests).
  A follow-up OS process inventory found zero scoped Terminal worker or
  `node-pty` console-list agent processes. One passing rerun emitted upstream
  `AttachConsole failed` diagnostics from the library's console-list agents
  during explicit termination; native shell exit and clean worker closure were
  still independently observed. This intermittent diagnostic is retained as an
  upstream stabilization limitation, not hidden or converted into exit evidence.
- The running app/helper were not restarted. The normal Windows launcher copies
  current overlay resources when its profile is closed, but reuses an existing
  owned bridge without comparing source hashes. Applying this backend requires
  safely restarting the dedicated bridge as well as the EG-Desk Firefox instance;
  no new installation is needed.
