# REA 구현 메커니즘 가져오기 — 브라우저 조작·Mac 조작

- 작성: 2026-10-24
- 읽을 사람: 대표님(결정). 이어서 구현 작업자를 배정할 Main 개발자.
- 상태: 소스 읽기 조사만 끝났다. Firefox·Mac에서 실행해 확인한 항목은 0개다. 이 문서 말고 바뀐 파일은 없다(작성 시점).
- 대표님 결정(2026-10-24): 6장 결정 1~12 중 10건을 정했다(5·10은 미결정). Mac 조작은 자체 도우미를 Rust로(결정 7·8), 실제 화면 시험은 관찰 전용부터(결정 11).
- 함께 볼 문서
  - [REA 분석글](computer-use-browser-control-rea.md): 안전 원칙 EG-01~08, 주장 ID(B·T·N·S·P)
  - [Mac 앱 조작 방식 선택](computer-use-options.md): Q1~Q4. 2026-10-24에 Q1 (다), Q2 관찰 전용부터, Q3 자체 Rust 도우미로 결정됨. Q4는 결정 전
  - 갭 장부 `ideas/confirmed/EGDESK_VISION_GAP_LEDGER.md`: BRW-05~14, CU-01~09, RT-04
  - 계약 `ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md`: §12, `impl-e24-computer-use`
- 표기
  - **[공식]** 공개 API 문서나 공개 소스에 있는 기능
  - **[분석]** 소스를 읽고 내린 판단. 실행으로 확인한 것은 아니다
  - **[제안]** 이 문서가 권하는 설계. 구현·검증 전이다
  - **(추정)** 근거가 간접적인 판단
  - **확인 필요** 실측 전에는 단정하지 않는 것. 7장에 모았다

---

## 1. 이 문서가 하는 일

REA 분석글의 EG-01~08은 "무엇을 지켜야 하는가"다. 이 문서는 거기에 더해 그 앱이 **"어떻게" 했는가**를 가져온다. 입력 경로, 좌표 계산, 시간 예산, 포커스 처리, 캡처, 중지 방식을 하나씩 뽑아, 같은 일을 하는 Firefox·macOS **공개 API로 EG-Desk가 직접 구현**하는 계획이다.

OpenAI 코드는 복사하지 않는다. OpenAI 쪽은 REA 주장 ID 수준으로만 인용한다. 독립 오픈소스(Apache-2.0·MIT·MPL-2.0)는 구조와 호출 순서만 참고한다. 비공개 macOS SPI와 OpenAI 번들을 다시 쓴 파생물은 근거로도 쓰지 않는다.

**가져오면 대표님 화면에서 달라지는 것** [제안]

| 어디서 | 달라지는 것 | 해당 줄 |
|---|---|---|
| Browser 카드 | 클릭에 반응 없던 메뉴·버튼(마우스다운·호버에 반응하는 것)이 사람 클릭처럼 동작한다 | 웹1 |
| Browser 카드 | 검색창·편집기에서 Agent가 친 글자와 Enter가 사람 입력처럼 처리된다 | 웹2 |
| Browser 카드 | Agent가 카드 스크린샷으로 그림·차트·캔버스도 보고 판단한다. 비밀번호 같은 칸은 가린다 | 웹6 |
| Browser 카드 | 보내기 전에 막힌 동작은 '안 눌렸음'으로 처리되어 카드를 다시 고르지 않아도 된다 | 웹8 |
| Browser 카드 | 누르기 직전 표시점이 대상으로 미끄러져 가서, 무엇을 누를지 미리 보인다 | 웹7 |
| Mac 앱 | Agent가 다른 앱 버튼을 눌러도 대표님 포인터와 앞 창은 그대로다 | 맥2·맥4 |
| Mac 앱 | 대표님이 마우스·키보드를 만지면 Agent 입력이 바로 멈춘다 | 맥6 |
| Mac 앱 | 관찰 View에서 앱 하나만 [중지]하거나, 긴급 중지 키 한 번으로 모든 Agent 입력을 끊는다 | 맥7·맥11 |
| Codex 컴퓨터 조작 중 | 지금 앞에 온 앱, 'OpenAI 조작 서비스 실행 중'이 관찰 View에 보인다 | 맥10 |

## 2. 조사 중 새로 드러난 것

지금 코드와 문서에 바로 영향이 있는 사실이다.

1. **지금의 안전 클릭(`egdesk_browser_click`)은 trusted 클릭이다. 다만 위치가 없다.** actor child가 `target.click()`을 system 코드로 부르므로 Gecko는 trusted로 표시한다. 하지만 click 이벤트 하나뿐이다. pointerdown·mousedown·mouseup·hover·좌표가 없다 [분석: `nsGenericHTMLElement.cpp:2401-2412`]. 그래서 BRW-10(일반 클릭이 안 먹는 사이트)의 원인은 "합성 클릭이라서"가 아니라 **"포인터 순서와 좌표가 없어서"**다.
   - 고칠 후보: 갭 장부 BRW-10의 근거·빠진 것("합성 클릭을 거부하는 사이트"), 도구 설명 `egdesk-browser-tool-runtime.mjs:31`("A site may ignore synthetic clicks"). 도구 설명은 manifest hash 규칙(`:22-23`)에 걸리는지 먼저 확인해야 한다.
   - `apps/firefox-ui-demo/docs/BROWSER_AGENT_OBSERVATION_RUNTIME.md:38`은 "DOM `click()`, no mousedown, no focus"로 이미 맞게 적혀 있다. trusted라는 점만 덧붙이면 된다.
   - 확신: 높음~중간. actor child 호출이 CallerType::System이라는 점은 system principal 호출의 일반 원리에 기댔다.
2. **예전(unguarded) 클릭 경로는 지금 Firefox에서 untrusted로 떨어진다.** 그 경로가 쓰는 `nsIDOMWindowUtils.sendMouseEventToWindow`는 ESR 140에만 있고 Firefox 153 ESR·159 release에는 없다 [분석: 각 버전 IDL 대조]. 그래서 `EGDeskBrowserAgentRuntimeChild.sys.mjs:1116-1140`이 오류 없이 `dispatchEvent`로 넘어간다. 영수증에는 `dispatchScope: "dom-fallback"`으로만 남는다. 갭 장부 BRW-10의 "좌표 입력 sendMouseEventToWindow는 legacy 경로에만 있음"도 이 사실을 반영해야 한다.
3. **일반 Firefox에는 Chromium식 "포커스 있는 척"(focus emulation)이 없다.** Playwright가 쓰는 `overrideHasFocus`·`forceActiveState`는 Gecko C++ 패치다. 일반 Firefox에서는 창별 포커스 모델로 부분 대체만 가능하다(웹3).
4. **기존 Mac 쪽 helper는 Agent 입력 서비스로 키우기에 맞지 않다.**
   - `helper-rust/src/main.rs`: 127.0.0.1 WebSocket. `--token` 인자를 받기만 하고 검사하지 않는다(L23-25).
   - `helper/macos-gesture-helper/.../main.swift`: TCP 39217에 `Access-Control-Allow-Origin: *`로 응답한다. 포트만 지정해 열어서 모든 네트워크 인터페이스에서 들을 가능성이 있다(추정).
   - 그래서 Mac 조작은 새 도우미 앱(맥1)으로 만든다.

---

## 3. 브라우저 메커니즘 (Firefox)

**전제**
- 사용자가 설치한 일반 Firefox release에 fx-autoconfig로 올라간다고 본다. 패치된 Gecko에서만 되는 API는 '불가'로 분류했다. 관측된 버전은 Windows Firefox 158.0뿐이고, macOS의 실제 버전은 **확인 필요**다.
- 공개 API 줄 번호는 mozilla-firefox/firefox main `774fa0cf`(2026-10-23) 기준이다. searchfox 최신과 몇 줄 다를 수 있다.
- `eg-desk-surface.uc.js` 줄 번호는 조사 시점 기준이다. 이 파일은 다른 작업으로 계속 바뀌고 있다.
- 오픈소스 표기: Playwright = Juggler(`browser_patches/firefox/juggler/`), remote = mozilla-central `remote/`, OBU = open-browser-use. 고정 커밋은 8장에 있다.

### 3.1 한눈에 보기

| 줄 | REA ID | 그 앱이 하는 방식 | Firefox 공개 API (근거) | 독립 오픈소스 예시 | 우리 지금 | 바꿀 것 [제안] | gap · 크기 · 가능 여부 |
|---|---|---|---|---|---|---|---|
| **웹1** 사람처럼 누르기 | B-05, B-01, T-03 | CDP `Input.dispatchMouseEvent`로 move→down→up. 표시 좌표와 입력 좌표를 따로 계산. 중단 시 finally에서 mouse-up만 보상(취소 아님) | `Window.synthesizeMouseEvent(…, {toWindow:true})` [ChromeOnly] ([Window.webidl#648](https://searchfox.org/mozilla-central/source/dom/webidl/Window.webidl#648)). trusted 이벤트 생성 ([nsContentUtils.cpp#10501](https://searchfox.org/mozilla-central/source/dom/base/nsContentUtils.cpp#10501)). 153 ESR·159에 있음. ESR 140은 `sendMouseEventToWindow` | Playwright `content/PageAgent.js:566`. remote `Actions.sys.mjs:1437`(down 뒤에만 up 보상) | `target.click()` 하나. trusted지만 좌표·pointerdown 없음(Child:1096-1107). 예전 경로는 untrusted로 하향(Child:1112-1140) | 새 도구로 move/down/up 경로 추가. down만 갔으면 up 1회 보상. 기존 click 스키마 유지, 자동 전환 금지 | BRW-10·12·08 · **L** · 가능. **결정 1·2** |
| **웹2** 사람처럼 키 입력 | B-01, B-05 | CDP `Input.dispatchKeyEvent`로 실제 키 경로에 넣음. 글자·Enter 제출·Tab을 브라우저가 처리 | `nsITextInputProcessor` keydown/keyup/commitCompositionWith ([idl#282](https://searchfox.org/mozilla-central/source/dom/interfaces/base/nsITextInputProcessor.idl#282)). 키는 그 창의 포커스 요소로 감 ([PresShell.cpp#9057](https://searchfox.org/mozilla-central/source/layout/base/PresShell.cpp#9057)) | Playwright `content/PageAgent.js:469-507`, `content/FrameTree.js:595-600`. remote `Event.sys.mjs:240` | `new KeyboardEvent` + dispatchEvent(`trustedInput:false`, Child:1028-1057). Enter만 흉내(:1014-1026). 글자 입력 도구 없음 | 이미 포커스된 칸일 때만 TIP로 keydown/keyup. Enter 흉내 제거. 글자 입력은 별도 'type' 동작 | BRW-06·08·10 · **M** · 가능, 실측 필요. **결정 2** |
| **웹3** 포커스 유지 | B-02, T-02 | `Input.*` 직전 CDP focus emulation 켬. 탭 전면 전환과 별개 | 동등 API 없음. `isActive`는 렌더링 여부 ([BrowsingContext.webidl#164](https://searchfox.org/mozilla-central/source/dom/chrome-webidl/BrowsingContext.webidl#164)). 대체: 비활성 창은 그 창 포커스 요소만 바꾸고 창을 올리지 않음 ([nsFocusManager.cpp#1891](https://searchfox.org/mozilla-central/source/dom/base/nsFocusManager.cpp#1891)) | Playwright `content/main.js:53-54`는 C++ 패치(`patches/bootstrap.diff:379-396`) — 재사용 불가 | 없음. 안전 경로는 포커스를 움직이지 않는 정책(`focusApi:'not-called'`) | 완전 위장은 안 함. 웹1·웹2 영수증에 포커스 전후와 Chat 포커스 불변을 기록 | BRW-10·12 · **M** · 부분 가능(실측 필요). 완전판은 패치 빌드 → **결정 6** |
| **웹4** 문서 번호 교차 확인 | B-03, B-05 | 요소를 `frameId:loaderId:localRef`로 묶고 클릭 직전 stale·프레임 변경 검사 | `Document.isActive()` [ChromeOnly] ([Document.webidl#788](https://searchfox.org/mozilla-central/source/dom/webidl/Document.webidl#788)), `innerWindowId` ([WindowGlobalActors.webidl#250](https://searchfox.org/mozilla-central/source/dom/chrome-webidl/WindowGlobalActors.webidl#250)), `BrowsingContext.id` | remote `shared/DOM.sys.mjs:552`(isStale), `NodeCache.sys.mjs:60-93` | 대부분 있음: ref·frame 세대·documentId·revision·guard 비교(Child:101-149, :710-743, :864-906). Gecko 문서 번호와의 교차 확인만 없음 | guard에 `innerWindowId`·`browsingContext.id` 추가, Parent 승인 때 일치 확인, `doc.isActive()` 검사 | BRW-12·08 · **S** · 가능. 결정 불필요 |
| **웹5** 다른 사이트 iframe 안 조작 | B-05(qv/j2), B-03 | 프레임 안 입력 좌표와 최상위 표시 좌표를 따로 계산 | JSWindowActor `allFrames:true` ([JSActors 문서](https://firefox-source-docs.mozilla.org/dom/ipc/jsactors.html)). frame마다 자기 창에서 synthesize. top에서 보내면 OOP iframe으로 안 넘어감 ([nsContentUtils.cpp#10561](https://searchfox.org/mozilla-central/source/dom/base/nsContentUtils.cpp#10561)) | remote `root/input.sys.mjs:128`, `windowglobal/input.sys.mjs:211-236`. Playwright `components/Juggler.js:42` | actor는 top frame만(surface:36). same-origin frame만 조작, cross-origin은 `inaccessibleFrames`로 보고만 | frame마다 actor, ref에 frame 번호, lease 검증을 frame까지, 입력·표시 좌표 분리 | BRW-08·10·12 · **L** · 가능. **결정 4** |
| **웹6** 카드 스크린샷 | B-03 | `Page.captureScreenshot`으로 그 탭만 캡처. OS 전체 화면 아님 | `WindowGlobalParent.drawSnapshot` → ImageBitmap. parent 전용, OOP frame 포함 ([WindowGlobalActors.webidl#212](https://searchfox.org/mozilla-central/source/dom/chrome-webidl/WindowGlobalActors.webidl#212)). 참고 구현 [ext-tabs-base.js#97](https://searchfox.org/mozilla-central/source/toolkit/components/extensions/parent/ext-tabs-base.js#97), [MDN captureTab](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/captureTab) | Playwright `protocol/PageHandler.js:315-370`(탐색 중 재시도, 크기 제한). remote `shared/Capture.sys.mjs:183` | 없음(BRW-09). 응답 형식 `inputImage{imageUrl}`은 이미 허용(`codex-chat-runtime.mjs:447-448`) | 새 도구 `egdesk_browser_screenshot`. 민감 영역 가림 후 이미지 반환. 스크린샷 좌표로 바로 입력 금지 | BRW-09 · **M** · 가능(실제 창 Firefox 필요). **결정 3** |
| **웹7** 표시점 이동 | B-01, B-05 | 커서 상태 게시 → 페이지 위 DOM 오버레이가 그림 → 도착 알림. 도착 대기는 도착 또는 1,500ms 중 먼저. 성공 신호 아님 | chrome 문서의 `Element.animate()`·CSS transition + `Animation.finished` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/animate)). 페이지 DOM에는 넣지 않음(EG-08 유지) | OBU `apps/chrome-extension/background.js:644-683`(증가형 moveSequence), `:1011-1028`(도착 대기 상한 1,000ms) | 표시 마커가 승인 순간 그 자리에 바로 나타남(surface:13573, :13664). 이동·도착 대기 없음 | 카드별 직전 위치에서 대상으로 glide. 대기 상한 600ms, 만료돼도 진행. 도착을 성공으로 안 씀 | BRW-13·12 · **S** · 가능. **결정 5** |
| **웹8** 시간 예산과 '보내기 전/후' 구분 | T-01, T-02, T-03 | 3,000ms 절대 deadline을 하위 명령마다 나눠 씀. 보내기 전 초과는 따로 구분. timeout은 '효과 없음'도 '취소 완료'도 아님 | 특별한 API 불필요. 입력 처리 대기는 `Services.tm.dispatchToMainThread` ([windowglobal/input.sys.mjs#273](https://searchfox.org/mozilla-central/source/remote/webdriver-bidi/modules/windowglobal/input.sys.mjs#273)) | remote `Actions.sys.mjs:1422-1438` + `root/input.sys.mjs:336-362`. OBU `background.js:1503-1517`(타이머만 정리 = T-03과 같은 한계) | deadline 15초, settle 150ms 고정. surface 거절에 보내기 전/후 구분이 없어 helper가 모두 미확정으로 잠금(`egdesk-browser-tool-runtime.mjs:510-513`) → EGQ8 재선택 원인 | 거절에 `dispatchPhase` 추가. 확실히 안 보낸 것만 잠그지 않음. 여러 단계 입력은 단계별 잔여 예산 | BRW-12·10 · **M** · 가능. 결정 불필요(단계별 예산은 웹1과 함께) |
| **웹9** 문서 준비 대기와 1회 재시도 | T-02 | 초기화 중인 탭은 공유 대기. 연결 끊김 오류일 때만 같은 deadline으로 1회 재시도. timeout은 재시도 조건 아님 | `currentWindowGlobal`, `isInitialDocument`. actor 파괴 시 sendQuery가 AbortError ([RootTransport.sys.mjs#180](https://searchfox.org/mozilla-central/source/remote/shared/messagehandler/transports/RootTransport.sys.mjs#180)) | remote `BrowsingContextUtils.sys.mjs:276-299`, `RootTransport.sys.mjs:112-208` | 문서가 없으면 즉시 'not ready' 실패(surface:14450-14454). 탐색 중 actor 파괴 시 관찰 실패, 재시도 없음 | 관찰·대기만 공유 대기 + AbortError 1회 재시도. act는 재시도 안 함 | BRW-05·12 · **S** · 가능. 결정 불필요 |
| **웹10** 요청 순번과 같은 시계 기록 | B-04, T-04 | 증가형 RPC ID + pending map. 과거 fixture는 명령 ID·mousemove를 기록하지 않아 늦은 효과를 판별 못 함 | `performance.timeOrigin + performance.now()` — Node·Firefox 공통 ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Performance/timeOrigin)) | OBU `background.js:655-657`(moveSequence로 늦은 알림 격리) | 응답 격리는 REA보다 강함(UUID wire ID, 세대별 pending, `codex-browser-tool-transport.mjs:56-118`). run 안 순번과 helper·surface·actor 시각 연결 기록이 없음 | 순번·보낸/받은/승인/실행 시각을 영수증에 기록. 소유 fixture가 같은 시계로 수신 기록 | BRW-12 · **S** · 가능. 결정 불필요 |

### 3.2 줄별 세부 (구현 작업자용)

**웹1 사람처럼 누르기** — 고칠 곳: `overlay/resources/EGDeskBrowserAgentRuntimeChild.sys.mjs`, `EGDeskBrowserAgentRuntimeParent.sys.mjs`, `overlay/JS/eg-desk-surface.uc.js`, `helper/egdesk-browser-tool-runtime.mjs`, `helper/codex-browser-tool-provider.mjs`, `helper/codex-chat-runtime.mjs`, `helper/codex-tool-errors.mjs`, `docs/BROWSER_AGENT_OBSERVATION_RUNTIME.md`, `scripts/egdesk-browser-agent-guard.test.mjs` (모두 `apps/firefox-ui-demo/` 아래)
1. 기존 guard를 통과한 뒤, 대상이 속한 문서의 창에서 live rect로 화면 안 중심점을 구한다. same-origin frame이면 그 frame 창 좌표다.
2. 같은 점에서 `elementFromPoint` hit-test를 한다. 대상이나 그 자손이어야 한다.
3. mousemove → mousedown → mouseup을 `synthesizeMouseEvent(toWindow:true)`로 보낸다. try/finally에서 down만 보냈으면 mouseup을 1회 보상한다.
4. 영수증: `{inputRoute:'trusted-pointer', trustedInput:true, point, downDispatched, upDispatched, compensatedUp, targetClickObserved}`.
- 노출: 기존 click 스키마는 manifest hash 규칙(`egdesk-browser-tool-runtime.mjs:22-23`) 때문에 바꾸지 않는다. 새 도구 이름(예: `egdesk_browser_pointer_click`)으로 추가한다.
- DOM click 결과가 미확인일 때 이 경로로 자동 전환하지 않는다. 자동 전환은 EG-01 위반이다.
- 함께 고칠 곳: Parent `browserToolDispatchReceiptFields`, helper `readbackIsCurrent`, provider `PUBLIC_INPUT_ROUTES`에 새 경로를 추가한다.
- 예전 경로: `synthesizeMouseEvent`(153+/159)와 `sendMouseEventToWindow`(ESR 140)를 둘 다 기능 감지하도록 바꾼다.
- 좌표 계산: `synthesizeMouseEvent`는 CSS px를 presContext 기준으로 위젯 좌표로 바꾸므로 page zoom이 반영된다 [분석: `nsGlobalWindowInner.cpp:2822-2851`]. OS 이벤트 큐를 거치지 않는다.
- 부작용: mousedown 기본 동작으로 **페이지 안** 포커스가 누른 칸으로 옮겨진다. trusted 입력은 '사용자가 직접 눌렀음' 권한(user activation)을 준다 [분석: `UserActivation.cpp:89-117`]. 그래서 결정 1·2가 필요하다.

**웹2 사람처럼 키 입력** — 고칠 곳: Child, Parent, surface, `egdesk-browser-tool-runtime.mjs`, `codex-browser-tool-provider.mjs`
- 조건: `pressPolicy`가 `already-focused`이고 `deepActiveElement === target`일 때만 쓴다. TIP는 포커스 요소로 보내므로 `after-fill`은 이 경로를 쓸 수 없다.
- 카드 창의 TIP로 keydown/keyup을 보내고, Enter 흉내(`implicitSubmission`)는 제거한다. 제출은 브라우저가 처리한다.
- 글자 입력은 `commitCompositionWith(text)` 기반의 별도 'type' 동작으로 둔다. 리치 에디터 대응이다(BRW-08).
- `beginInputTransaction`이 false면(대표님이 같은 순간 IME로 조합 중) `not-dispatched`로 거절한다.
- 영수증: `trustedInput:true`, `keydownConsumed`, `defaultPreventedByPage`.
- **확인 필요**: 비활성 카드에서도 키가 그 창의 포커스 요소로 가는지, 편집기가 그 입력을 받는지.

**웹3 포커스 유지 (부분 대체)** — 고칠 곳: Child, surface, `docs/BROWSER_AGENT_OBSERVATION_RUNTIME.md`
- Gecko 동작: 페이지 쪽 trusted mousedown은 `FLAG_BYMOUSE|FLAG_NOSCROLL`로 포커스를 옮긴다([EventStateManager.cpp#4275](https://searchfox.org/mozilla-central/source/dom/events/EventStateManager.cpp#4275)). 카드가 활성 창이 아니면 그 창의 포커스 요소만 바뀌고 focus 이벤트도 창 올리기도 없다. 창 올리기는 `FLAG_RAISE`일 때만이다([nsFocusManager.cpp#2048](https://searchfox.org/mozilla-central/source/dom/base/nsFocusManager.cpp#2048)). `forceAppWindowActive`([BrowsingContext.webidl#447](https://searchfox.org/mozilla-central/source/dom/chrome-webidl/BrowsingContext.webidl#447))는 app window용이라 맞지 않다.
- 영수증 필드: `activeElementBefore/After`, `documentHasFocus`, `chromeFocusUnchanged`(surface가 chrome `document.activeElement`를 전후 비교).
- 페이지가 hasFocus나 focus 이벤트에 의존해 반응하지 않으면 `postcondition-unverified`로 보고한다.
- **확인 필요**: 페이지 쪽 trusted mousedown이 Chat 입력칸(chrome) 포커스를 건드리지 않는지.

**웹4 문서 번호 교차 확인** — 고칠 곳: Child, Parent, surface, `egdesk-browser-tool-runtime.mjs`
- snapshot과 guard에 `innerWindowId`(`this.manager.innerWindowId`)와 `browsingContext.id`를 추가한다.
- Parent `authorizeAct`에서 `windowGlobal.innerWindowId === guard.innerWindowId`를 확인한다.
- `frameRecordLive`와 `nodeForRef`에 `doc.isActive?.()` 검사를 추가한다. helper는 값을 전달하기만 한다.
- 지금 있는 것: surface `browserToolAuthorizePhysicalAction`이 browsingContext와 currentWindowGlobal 동일성을 이미 검사한다.

**웹5 다른 사이트 iframe** — 고칠 곳: surface, Child, Parent, `egdesk-browser-tool-runtime.mjs`
- `allFrames:true`로 등록한다. frame actor 응답에 `browsingContext.id`와 `innerWindowId`를 넣고, ref는 `bc<id>:<innerWindowId>:el_N` 형식으로 한다.
- surface가 action을 해당 frame의 `windowGlobal.getActor`로 보낸다.
- parent lease 검증을 frame BC까지 넓힌다. 카드 확인은 top embedder로 한다.
- 영수증에서 `inputPoint`(frame 좌표)와 `displayPoint`(top viewport)를 분리한다. 표시 좌표는 부모 문서들의 iframe rect를 이어서 구한다.
- 웹1이 먼저 있어야 frame마다 사람처럼 누르기를 쓸 수 있다.

**웹6 카드 스크린샷** — 고칠 곳: Parent, Child, surface, `egdesk-browser-tool-runtime.mjs`, `codex-browser-tool-provider.mjs`, `codex-chat-runtime.mjs`
1. surface가 캡처 직전과 직후에 `currentWindowGlobal.innerWindowId`가 관찰 때와 같은지 확인한다.
2. child에게서 같은 revision의 민감 영역 rect를 받는다. 대상은 password, `data-sensitive`·private·secret 힌트이고, 결정 3에 따라 `inaccessibleFrames`도 포함한다.
3. OffscreenCanvas에서 그 영역을 불투명하게 칠한 뒤 JPEG/PNG data URL로 만든다. 긴 변 길이에 상한을 둔다.
4. 결과에 viewport, imageScale, innerWindowId를 기록하고 `inputImage` contentItem으로 돌려준다.
- 스크린샷 좌표를 입력에 직접 쓰지 않는다. 입력 전에는 fresh observe와 guard를 거친다.
- headless는 캡처를 지원하지 않는다(REA EGQ3 `visualPass:null`). 실제 창 Firefox로 검증해야 한다.
- **확인 필요**: 카메라 이동으로 화면 밖에 있거나 숨은 카드도 캡처되는지. Codex `inputImage` 응답이 실제 모델 왕복에서 동작하는지.

**웹7 표시점 이동** — 고칠 곳: surface, `overlay/CSS/eg-desk-surface.uc.css`, `scripts/egdesk-browser-tool-transport.test.mjs`
- surface projection에 `glide(from, to, moveSequence)`를 추가한다. 승인 요청 전에 카드별 직전 위치에서 displayPoint로 이동시킨다.
- 대기 시간 = min(도착, 600ms, deadline까지 남은 시간 − 여유). 만료돼도 그대로 진행한다. 도착을 성공 영수증으로 쓰지 않는다(EG-03).
- 대기 중 Stop이나 cancel이 오면 기존 lease 폐기로 parent가 거부한다(입력 0). 표시가 실패해도 입력에는 영향이 없다.
- 지금 CSS는 `pointer-events:none`, `aria-hidden`이고 이동 애니메이션이 없다(`eg-desk-surface.uc.css:271-284`).

**웹8 시간 예산과 '보내기 전/후' 구분** — 고칠 곳: Child, surface, `egdesk-browser-tool-runtime.mjs`, `egdesk-browser-tool-runtime.test.mjs`, `scripts/egdesk-browser-tool-transport.test.mjs`
- (a) actor와 surface의 거절에 `dispatchPhase`(`not-dispatched` / `dispatched` / `unknown`)를 넣는다.
  - `not-dispatched`는 `lease.authorized=false`이거나 `actorPerformCalls`가 늘지 않았음이 확인될 때만이다.
  - helper는 `not-dispatched`면 관찰만 소모하고 `card.uncertain`을 걸지 않는다. 나머지는 지금처럼 잠근다. 확실히 보내지 않은 경우만 풀어 주므로 EG-01(미확정 중복 금지)을 약화하지 않는다.
- (b) 여러 단계 입력(웹1)에서는 단계마다 `remaining = deadline − now`를 계산한다. down 시작 전 remaining이 최소값(예: 250ms + settle)보다 작으면 `not-dispatched`로 거절한다. down 이후에는 up 보상까지 마치고, deadline을 넘겼으면 `unknown`으로 보고한다.
- (c) settle은 `min(150, remaining − 여유)`로 둔다.
- 지금: 요청마다 `deadline = now() + 15000`(`egdesk-browser-tool-runtime.mjs:258-279`), transport 타이머도 그 deadline(`codex-browser-tool-transport.mjs:80-85`), actor가 승인 전후 deadline 검사(Child:1205-1227), settle 150ms 고정(surface:15736), surface 거절 `{status:'rejected', error}`(surface:13703).

**웹9 문서 준비 대기와 1회 재시도** — 고칠 곳: surface, `scripts/egdesk-browser-tool-transport.test.mjs`
- surface에 카드별 공유 `whenWindowGlobalReady(deadline)`를 추가한다. 관찰·대기에만 쓴다.
- observe/wait의 sendQuery가 AbortError로 끝나면 같은 deadline으로 새 windowGlobal에서 1회만 재시도한다.
- act는 재시도하지 않는다. 문서가 바뀌었으면 stale이고, 웹8의 `dispatchPhase`로 보고한다. timeout은 재시도 조건이 아니다.
- 지금: actor 등록 `ensureBrowserAgentActor`는 1회만 하고 공유한다(surface:24-45). 관찰 실패는 `BROWSER_OBSERVATION_UNAVAILABLE`(`egdesk-browser-tool-runtime.mjs:212-218`).

**웹10 요청 순번과 같은 시계 기록** — 고칠 곳: `egdesk-browser-tool-runtime.mjs`, `codex-browser-tool-transport.mjs`, surface, Child
- requestUi에 run별 `seq`와 `sentAtMs`를 넣는다. surface는 `receivedAtMs`·`authorizedAtMs`를 찍는다.
- actor는 `performEnterMs/ExitMs`, perform 횟수 전후, 첫 이벤트 시각을 영수증에 넣는다(지금은 perform 횟수만, Child:1230). helper는 timeout 시각과 함께 기록한다.
- 소유 fixture 페이지가 pointerdown·mousemove·click을 같은 시계로 기록해 REA R-01(timeout 뒤 늦은 효과)을 검증한다.

---

## 4. Mac 메커니즘 (macOS)

**전제**
- macOS 26.6.2, Apple M5 기준이다(computer-use-options §2.1).
- Q1은 (다)로 결정됐다: Codex 컴퓨터 조작을 켜 두고 표시를 보강한다. Q2는 2026-10-24에 **관찰 전용부터**로 결정됐다: 실제 화면 시험은 앱 목록·창 상태 읽기까지만 하고 OS 입력은 보내지 않는다(결정 11).
- Q3은 2026-10-24에 **EG-Desk 자체 도우미를 Rust로**로 결정됐다(결정 7·8 (나), RT-04 Rust helper와 합침). cua-driver를 띄우는 안은 채택하지 않고 cua-driver(MIT) Rust 코드는 참고·이식한다(출처 표기). 권한은 별도 도우미 .app만 받는다(결정 9). 그래서 맥1~맥9·맥11(**EG-Desk 자체 Mac adapter**, computer-use-options의 B안)은 만들 대상이다. 아래 4.2와 5.2의 Swift 파일 계획은 Rust 모듈로 바뀐다(5.2 메모).
- 맥10은 Codex 컴퓨터 조작을 켜 둔 **지금** 쓸 감독 기능이다.
- macOS 14부터 앱 활성화가 협조적으로 바뀌었다. `activate()`·`yieldActivation(to:)`는 활성화를 보장하지 않고, `activateIgnoringOtherApps`는 deprecated이며 효과가 없다 [공식: Apple 문서 메타데이터].
- 오픈소스 표기: OCU = open-computer-use, cua = trycua/cua의 cua-driver Rust(`libs/cua-driver/rust/crates/`), Peekaboo, macOS-use. 고정 커밋은 8장에 있다. OCU의 `experiments/LockedUse` 코드는 검증 단계 경로이고 주 실행 경로가 아니다.

### 4.1 한눈에 보기

| 줄 | REA ID | 그 앱이 하는 방식 | macOS 공개 API (근거) | 독립 오픈소스 예시 | 우리 지금 | 바꿀 것 [제안] | gap · 크기 · 가능 여부 |
|---|---|---|---|---|---|---|---|
| **맥1** 권한을 가진 별도 도우미 앱 | §2 연결도(SkyComputerUseService), N-07, P-03 | 권한을 가진 배경 서비스(Dock에 안 보이는 앱)가 캡처·입력을 맡고, 앱 UI는 IPC로 요청만 보냄 | [NSWorkspace.openApplication](https://developer.apple.com/documentation/appkit/nsworkspace/openapplication(at:configuration:completionhandler:)) + [activates=false](https://developer.apple.com/documentation/appkit/nsworkspace/openconfiguration/activates). Node에서는 `/usr/bin/open -g -n`. 대안 [SMAppService.agent](https://developer.apple.com/documentation/servicemanagement/smappservice/agent(plistname:)). IPC는 Unix socket 0600 + peer uid | OCU `MacOSAppAgentProxy.swift:85-120`(activates=false 실행), `:230-280`(socket 0600), `:322-339`(끊김 감시). cua `cua-driver/src/serve.rs:716-723`(peer uid) | 입력·캡처 서비스 없음(CU-03). 기존 helper는 확장 부적합(2장 4번) | 새 'EG-Desk Host Agent.app' + Node `egdesk-host-agent.mjs`. 실행별 nonce·peer uid 확인. 지연·끊김은 결과 미확정, 자동 재시도 없음 | CU-03·04·05, RT-04 · **L** · 새 앱 번들·서명 필요. **결정 8·9** |
| **맥2** 그 앱에만 보내는 입력 | N-01, N-04, P-02 | PID 대상 게시(postToPid → wrapper → 간접 전송, 최종 대상 UNKNOWN). 전역 포인터·전면 앱을 바꾸지 않음. 독립 구현(P-02)은 접근성 동작을 먼저 씀 | [AXUIElementPerformAction](https://developer.apple.com/documentation/applicationservices/1462091-axuielementperformaction), [AXUIElementSetAttributeValue](https://developer.apple.com/documentation/applicationservices/1460434-axuielementsetattributevalue), [CGEvent.postToPid](https://developer.apple.com/documentation/coregraphics/cgevent/posttopid(_:)) | OCU `ComputerUseService.swift:1287-1322`(AXPress→AXConfirm→AXOpen→AXShowMenu), `:266-289`(postToPid는 창 끌기 불가 명시). cua `platform-macos/src/input/ax_actions.rs:200-222`(직전 AXEnabled 재확인) | 없음(CU-03 grep 0건) | 경로 순서: 접근성 동작 → 값 설정 → PID 대상 좌표 → 전역 HID(화면 넘김 때만). 한 동작 한 경로 | CU-03·02 · **XL**(클릭·값 설정만 먼저면 L) · 손쉬운 사용 권한, OS 입력 시험 필요. **결정 7·11·12** |
| **맥3** Agent 포인터 표시 | N-01, B-01, B-05, EG-08 | 대상 창 위에 가상 커서. OpenAI virtualCursor 안에는 postToPid 호출이 있어 표시 전용으로 볼 수 없음 | NSPanel [.nonactivatingPanel](https://developer.apple.com/documentation/appkit/nswindow/stylemask-swift.struct/nonactivatingpanel), [ignoresMouseEvents](https://developer.apple.com/documentation/appkit/nswindow/ignoresmouseevents), [order(_:relativeTo:)](https://developer.apple.com/documentation/appkit/nswindow/order(_:relativeto:)) | OCU `SoftwareCursorOverlay.swift:373-388`, `:404-426`(대상 창 바로 위 정렬), `ComputerUseService.swift:686-742`(커서와 입력 경로 분리) | Desk 브라우저 카드 표시 마커만(EG-08 `96e1a74`) | 표시 전용 모듈. 입력 API를 import하지 않음(시험으로 강제). 커서 도착을 기다리지 않음 | CU-01 · **M** · 권한 불필요(추정). 화면 확인은 OS 시험 |
| **맥4** 앞 앱 되돌리기 | N-02, N-04 | focusEnforcer: 대상 앱 B가 스스로 앞에 나오면 이전 앱 A를 다시 활성화(`activateWithOptions:0`, 50ms/2s 형태) | [didActivateApplicationNotification](https://developer.apple.com/documentation/appkit/nsworkspace/didactivateapplicationnotification), [NSRunningApplication.activate(options:)](https://developer.apple.com/documentation/appkit/nsrunningapplication/activate(options:)). 14+ 협조적 활성화로 보장 안 됨 | cua `platform-macos/src/focus_steal.rs:72`(5초 deadline), `:192-230`(lease), `:498-531`(activateWithOptions(0)) | 없음 | 동작 전 앞 앱 기록 → 대상이 튀어나오면 되돌림 → 50ms 뒤 다시 읽어 '복원됨/복원 실패' 표시 | CU-02·04·01 · **M** · 권한 불필요, best-effort. OS 시험 필요 |
| **맥5** 앱별 차례 줄 | N-05, S-01 | 대상 앱마다 직렬 실행 큐. 각 동작 직전에 중지 표식·취소·사람 개입 사유를 확인하고 걸리면 안 보냄 | [Task.checkCancellation()](https://developer.apple.com/documentation/swift/task/checkcancellation()), 앱별 serial queue 또는 actor | OCU `LockedUseActionScope.swift:14-26`, `LockedUseDiagnostics.swift:186-198`(모든 이벤트 직전 확인) | 브라우저만 있음: card lease epoch 재확인(surface:13371-13390), 승인 직전 재확인(Child:1209-1219) | 앱별 FIFO + worker 1개. 이벤트마다 lease 표 확인(IPC 왕복 없이). 어긋나면 거절 | CU-02·05 · **L** · 가짜 poster로 단위 시험 가능. '중지 후 입력 0'은 OS 시험 |
| **맥6** 사람이 손대면 양보 | N-05, P-03 | 사용자 개입을 감지하면 대상별 debounce를 재시작하고 그동안 Agent 입력을 멈춤 | [CGEvent.tapCreate](https://developer.apple.com/documentation/coregraphics/cgevent/tapcreate(tap:place:options:eventsofinterest:callback:userinfo:)) [listenOnly](https://developer.apple.com/documentation/coregraphics/cgeventtapoptions/listenonly), [eventSourceUserData](https://developer.apple.com/documentation/coregraphics/cgeventfield/eventsourceuserdata), IOHIDManager | OCU `experiments/LockedUse/Sources/Guardian/DisplayGuardian.swift:249-296`(tap 꺼지면 중지). Peekaboo `scripts/support/background-computer-use-probe.swift:910-998` | gesture helper가 스크롤만 관찰, lease와 무관(main.swift:180-186) | 자기 표식 없는 입력 = 사람. 그 레인에 개입 표시, 재개는 [Agent에게 돌려주기]로만. 원시 문자 기록 안 함 | CU-02·05·01 · **M** · 입력 모니터링 권한 새로. **결정 7·11** |
| **맥7** 앱 하나만 중지 | N-07, N-06, S-01 | 앱별 Stop 메뉴 → AppStop 요청 → PID 대상 AppleEvent(`SkCu/SndR`). 서비스가 중지 표식·대기열 정리 | 우리 socket 메시지로. [AESendMessage](https://developer.apple.com/documentation/coreservices/1442994-aesendmessage)는 공개지만 [Apple Events 엔타이틀먼트](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events)와 사용자 권한 요청이 필요해 안 씀 | cua `cua-driver/src/stop.rs:1-30`(기대한 pid만 중지). OCU `MCPServer.swift:77-78` | Chat Stop 3단계 표시(EGA2·EGQ5), 브라우저 lease 무효화. 네이티브 앱별 중지 없음 | `stopApp`/`stopAll` 메시지. 대기 동작은 '안 보냄', 눌린 키 해제 후 ACK. 이미 보낸 입력은 취소로 표시 안 함 | CU-01·05 · **S**(맥5 위) · ACK 전후 수신 구분은 OS 시험 |
| **맥8** 권한 3종과 앱별 승인 | P-03 | 처음 쓰는 앱마다 승인을 받고 앱별 허용을 기록. 터미널·자기 자신·관리자 인증·OS 보안 프롬프트는 자동화 불가 | [AXIsProcessTrustedWithOptions](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions), [CGRequestScreenCaptureAccess](https://developer.apple.com/documentation/coregraphics/cgrequestscreencaptureaccess()), [CGRequestListenEventAccess](https://developer.apple.com/documentation/coregraphics/cgrequestlisteneventaccess()) (각 Preflight 짝) | OCU `docs/ARCHITECTURE.md:46`(TCC 기록 + 런타임 확인). 앱 승인 기능은 오픈소스에 없음 | `codex-computer-control.mjs:16-19` inherit/off만. 승인 저장소·권한 표시 없음 | 앱 승인 저장소(1회/항상/거부) + 고정 거부 목록. 권한은 미리보기(묻지 않음)와 버튼 눌렀을 때 요청을 구분 | CU-03·04·07 · **M** · 저장소·UI는 OS 없이 시험 가능. Q3 전제 |
| **맥9** 창 하나만 캡처 | B-03의 네이티브 대응. REA에 네이티브 캡처 경로 주장은 없음 | 브라우저처럼 대상만 찍는다는 원칙(계약 `impl-e24`의 선택 창 필터) | [SCContentFilter(desktopIndependentWindow:)](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(desktopindependentwindow:)), [SCScreenshotManager](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager) (14.0) | OCU `AccessibilitySnapshot.swift:617-635`(windowID로 선택, 커서 숨김). cua `platform-macos/src/capture.rs:466-558` | 없음(CU-01·03) | `captureWindow`. 프레임에 창 번호·bounds·배율·revision. 캡처 → 범위 확인 → 가림 → 인코딩. 같은 revision에서만 좌표 입력 | CU-01·03 · **M** · 화면 기록 권한. 입력이 아니라 OS 입력 보류와 별개 |
| **맥10** Codex 조작 중 감독 | N-02, N-05~07, S-01, P-03 | Codex 컴퓨터 조작은 OpenAI 서비스가 입력·포커스 복원·중지를 내부에서 처리. EG-Desk에는 연결점이 없음(computer-use-options §3 연결점 8). 대기열 취소는 UNKNOWN | didActivateApplicationNotification, runningApplications(`com.openai.sky.CUAService`) — 권한 불필요. [AXObserverCreate](https://developer.apple.com/documentation/applicationservices/1460133-axobservercreate) — 손쉬운 사용. listen-only tap — 입력 모니터링 | Peekaboo `background-computer-use-probe.swift:1005-1033`(활성화 추적), `:1045-1105`(포커스 창 관찰) | mcpToolCall을 '컴퓨터 조작' 활동과 호출 수로 표시(`codex-chat-runtime.mjs:2216-2252`). OS 수준 관찰 없음 | 입력 없는 관찰 모드. 앞 앱 변화·서비스 실행을 Codex 호출 기록과 같은 시계로 표시. 선택: 대표님 입력 시 Codex 중지 | CU-01·06·07 · **M** · 관찰은 권한 불필요(Q1 (다) 범위). 자동 중지는 **결정 10** |
| **맥11** 감시 프로세스와 긴급 중지 키 | S-01, N-05 (+계약 `impl-e24`) | REA는 Stop 층위만 보여 줌. 감시 프로세스·긴급 중지 키는 계약 요구를 독립 구현에서 가져옴 | session tap 키 감지, [CGGetEventTapList](https://developer.apple.com/documentation/coregraphics/cggeteventtaplist(_:_:_:)), Process + pipe heartbeat | OCU `DisplayGuardian.swift:312-325`(`--watchdog` 자식), `GuardianMain.swift:236-277`(heartbeat 1.5초). cua `serve.rs:705-713`(stdin EOF면 종료) | 없음(CU-05). 비슷한 부품은 `terminal-worker` ShutdownWatchdog(5초 강제 종료)뿐 | 감시 자식이 끊기거나 tap이 꺼지면 입력 차단. Ctrl+Alt+Shift+. 으로 전체 중지 | CU-05 · **L** · 입력 모니터링 권한. 끊김 시험은 OS 없이 가능 |

### 4.2 줄별 세부 (구현 작업자용)

**맥1 권한을 가진 별도 도우미 앱** — 새로 만들 곳: `helper/macos-host-agent/`(Swift package, LSUIElement), `helper/egdesk-host-agent.mjs`(+test), `scripts/build-macos-host-agent.sh`. 연결: `helper/codex-bridge-server.mjs`
1. Node가 0700 디렉터리에 socket 경로와 실행별 nonce를 만들고 `open -g -n --args --socket <p> --nonce <n>`으로 띄운다. LaunchServices로 띄워야 TCC 권한 주체가 이 앱이 된다(추정, 8장).
2. 연결 뒤 peer uid와 nonce를 확인한다.
3. NDJSON 요청 `{id, type, deadlineMs}`에 바이트 한도를 둔다. 프레임 한도와 '결과 미확정' 오류는 `terminal-rust-process.mjs:27-30,53-54`, `egdesk-file-native.mjs:192` 방식을 따른다.
4. 응답 지연·연결 끊김은 `HOST_ACTION_OUTCOME_UNKNOWN`으로 처리하고 자동 재시도하지 않는다(EG-01).
5. 연결이 끊기면 helper는 모든 입력 gate를 닫는다.
- NSXPCConnection은 Node에서 직접 쓸 수 없어 제외했다.
- **확인 필요**: 서명이 바뀌어도 권한이 유지되는지(U11).

**맥2 그 앱에만 보내는 입력** — 새로 만들 곳: `helper/macos-host-agent/Sources/HostAgent/Actions/`, `helper/egdesk-host-tool-provider.mjs`. 연결: `codex-chat-runtime.mjs`
- 경로 순서: ① 접근성 의미 동작 ② `AXIsAttributeSettable` 확인 뒤 AXValue 설정 ③ postToPid 좌표(새로 읽은 창 bounds와 스크린샷 배율로 창 내부 좌표 재계산) ④ 전역 HID(`.cghidEventTap`)는 화면 넘김 lease가 있을 때만.
- 한 동작에 경로는 하나다. 이중 게시는 금지한다. cua의 'Both' 모드는 논리 이벤트 하나를 두 번 보내는 반례다(`platform-macos/src/input/mouse.rs:19-80`).
- 동작 직전에 AXEnabled와 창 소유 PID를 다시 확인한다(EG-02).
- 영수증 `{route: ax/pid/hid, dispatched, readback}`. readback은 별도로 다시 관찰한다(EG-03).
- Node 동적 도구: `host_click`, `host_set_value`, `host_type`, `host_key`, `host_scroll`.
- 창 끌기·텍스트 드래그 선택은 postToPid로 안 된다(OCU `ComputerUseService.swift:266-289`). 이 동작은 화면 넘김 경로가 필요하다(결정 12).
- 참고: OCU `InputSimulation.swift:116-124`(scroll), `:204-225`(unicode 키 묶음), `:325-334`(마우스). macOS-use `mlx_use/mac/actions.py:32,76`(접근성만 씀).

**맥3 Agent 포인터 표시** — 새로 만들 곳: `.../HostAgent/CursorOverlay.swift`. 연결: surface
- 모듈 경계 규칙: CGEvent·AX 쓰기를 import하지 않는다. 시험으로 강제한다. 입력은 Actions 모듈만 한다.
- host-activity View의 캡처 프레임에도 같은 좌표 마커를 겹친다(EG-08 재사용).
- turn·lease가 끝나면 즉시 숨긴다. 참고: OCU `SoftwareCursorOverlay.swift:913-916`(키 창이 되지 않음), `:71-73`(30초 idle 정리).

**맥4 앞 앱 되돌리기** — 새로 만들 곳: `.../HostAgent/FocusGuard.swift`. 연결: `egdesk-host-agent.mjs`
1. 동작 전에 앞 앱(A)을 기록하고 억제 항목 `{targetPid:B, restoreTo:A, deadline 5s}`를 건다.
2. 범위 안에서 B가 활성화되면 A를 `activate(options:[])`로 되돌린다.
3. 50ms 뒤 앞 앱을 다시 읽어 `focus.restored` / `focus.restore-failed`를 낸다. 성공을 가정하지 않는다.
- 기본 경로(접근성·postToPid)는 대상을 활성화하지 않는 것이 원칙이다. FocusGuard는 보상 수단이다.
- REA N-02의 제한된 A→B→A 시험에서는 복귀가 동작했다. macOS 14+에서 성공하는지는 **확인 필요**다.

**맥5 앱별 차례 줄** — 새로 만들 곳: `helper/egdesk-host-lease.mjs`(+test), `.../HostAgent/AppLane.swift`
- 동작은 `{commandId, leaseId, epoch, deadlineMs}`를 가진다.
- worker는 이벤트 하나를 보낼 때마다 helper 안의 lease 표에서 epoch, 앱 중지 표식, 사람 개입 표식, deadline을 원자적으로 확인한다.
- 어긋나면 `STOPPED` / `LEASE_REVOKED` / `USER_INTERVENTION` / `EXPIRED`로 거절하고 보내지 않는다.
- 영수증 enqueue/dispatch/ACK/receive에 같은 단조 시계와 commandId·순서·PID를 붙인다(REA §4·R-02).
- Node lease는 브라우저 lease의 epoch·tombstone 규칙을 이식한다.

**맥6 사람이 손대면 양보** — 새로 만들 곳: `.../HostAgent/HumanInputMonitor.swift`. 연결: `egdesk-host-lease.mjs`, surface
- 자기 tag(`eventSourceUserData`)와 pid가 붙은 이벤트가 아니면 '사람/외부'로 본다.
- 포인터가 대상 창 위에 있으면 그 레인, 키보드는 앞 앱 레인에 개입 표시를 한다. 대상별 debounce(예: 800ms 무입력)를 재시작한다.
- Node에 `control.yielded{reason:'human-input'}`를 보내고 lease를 사람 쪽으로 바꾼다. 재개는 UI의 [Agent에게 돌려주기]로만 한다.
- tap이 꺼지거나 권한을 잃으면 gate를 닫는다(OCU `DisplayGuardian.swift:249-296`과 같은 fail-closed). 원시 문자는 기록하지 않는다(계약).
- 참고: Peekaboo probe는 `CGGetEventTapList`로 tap 설치를 확인하고 `eventSourceUnixProcessID`로 출처를 가린다.
- **확인 필요**: PID 대상으로 보낸 자기 입력이 session tap에 보이는지(안 보일 가능성이 있음, 추정).

**맥7 앱 하나만 중지** — 연결: `egdesk-host-agent.mjs`, `egdesk-host-lease.mjs`, surface
- 메시지: `{type:'stopApp', target:{bundleId,pid}, stopEpoch}` / `{type:'stopAll'}`.
- helper가 맥5 레인에 중지 표식을 세우고 epoch를 올린다. 대기 동작은 `not-dispatched`로 돌려주고, 진행 중 동작은 다음 확인 지점에서 멈춘다.
- 눌린 키·버튼은 안전하게 해제하고 별도 cleanup 영수증을 남긴다. 정리가 끝난 뒤에만 ACK를 보낸다.
- 화면 문구는 EG-04 층위를 따른다: 중지 요청 중 → 중지 확인됨, 이미 보낸 입력은 취소로 표시하지 않는다.
- Chat Stop은 `stopAll`과 `turn/interrupt`를 함께 보낸다.

**맥8 권한 3종과 앱별 승인** — 새로 만들 곳: `helper/egdesk-host-approvals.mjs`, `.../HostAgent/Permissions.swift`. 연결: surface(설정)
- 승인 저장소: `{bundleId, teamId}` → allow-once / always / deny. 앱 식별은 `bundleIdentifier`와 코드 서명 팀 ID로 한다. lease 발급 조건에 승인을 넣는다.
- 고정 거부 목록: Terminal류, EG-Desk 자신, System Settings, loginwindow·SecurityAgent.
- 권한: 미리보기는 묻지 않는 Preflight 함수만, 요청은 대표님이 버튼을 누를 때만. 결과를 다시 읽어 설정 화면에 표시한다.
- 설정 UI: 권한 3종 행과 앱 승인 목록. 승인 카드는 Agent 질문 카드와 분리한다(U15 교훈).
- 참고: Codex 쪽 `computer_use.macos.bundle_ids` 키는 [공식]으로 있지만 thread에 넣은 값이 반영되는지는 미확인(U4). OpenAI는 `sessions/*.toml`에 앱별 허용을 남긴다(computer-use-options §2.1).

**맥9 창 하나만 캡처** — 새로 만들 곳: `.../HostAgent/WindowCapture.swift`. 연결: `egdesk-host-agent.mjs`, surface
- `captureWindow{windowId, maxEdge, format}`. 바이너리 프레임에 한도를 둔다.
- 프레임에 `{windowId, bounds, scale, geometryRevision}`를 붙인다. 순서는 계약대로 capture → 범위 확인 → 가림 → 인코딩이다.
- 좌표 입력은 같은 revision 프레임에서만 허용한다(EG-02). 스크린샷 픽셀→창 point 변환은 OCU `ComputerUseService.swift:315-351`을 참고한다.
- 제외: OCU `AccessibilitySnapshot.swift:606-614`의 비공개 SLSHW 우선 경로.

**맥10 Codex 조작 중 감독** — 새로 만들 곳: `helper/egdesk-host-activity.mjs`, `.../HostAgent/ActivityObserver.swift`. 연결: `codex-chat-runtime.mjs`, surface
- Host Agent를 관찰 전용으로 띄운다. 이 모드에서는 입력 기능을 끈다.
- Node가 OS 관찰과 mcpToolCall 타임라인을 같은 시계로 합친다. host-activity View에 '현재 제어자: Codex 컴퓨터 조작(OpenAI)'과 앞 앱 변화를 표시한다. OpenAI focusEnforcer의 A→B→A 동작이 여기서 보인다.
- 선택 토글 '대표님 입력 시 Codex 중지'(결정 10): 사람 입력을 감지하면 `turn/interrupt`를 보내고 EG-04 문구로 표시한다.
- 하지 않는 것: OpenAI 비공개 AppleEvent `SkCu/SndR` 모방, OpenAI 대기열 취소 주장.
- Codex의 PID 대상 입력은 session tap에 안 보일 것으로 추정한다. OpenAI 서비스 안의 대기 입력 취소는 비공개라 불가하다.

**맥11 감시 프로세스와 긴급 중지 키** — 새로 만들 곳: `.../HostAgent/Watchdog.swift`, `.../HostAgent/EmergencyStop.swift`. 연결: `egdesk-host-agent.mjs`
- `--watchdog` 자식 프로세스를 pipe로 연결한다. 입력을 보내는 쪽은 매 이벤트 전에 heartbeat 나이를 확인한다(예: 1.5초 이내).
- tap에서 키 조합(modifier + keydown, 반복 아님)이 감지되면 `stopAll`(맥7)과 ACK를 보낸다.
- tap 비활성·권한 상실·secure input 경계에서 gate를 닫는다. Node 연결이 끊겨도 닫는다(맥1).
- 제외: OCU `GuardianMain.swift`의 relock SPI 부분.

---

## 5. 구현 묶음 제안

### 5.1 파일 소유 원칙

- **브라우저 핵심 파일은 한 번에 한 묶음만 소유한다.** `eg-desk-surface.uc.js`(약 18,000줄), `EGDeskBrowserAgentRuntimeChild.sys.mjs`·`Parent.sys.mjs`, `egdesk-browser-tool-runtime.mjs`를 브라우저 10줄 대부분과 Mac 화면 연결(맥3·6·7·8·9·10)이 함께 건드린다. 그래서 브라우저 묶음은 차례로 진행한다.
- **Mac Node·Swift 쪽은 새 파일이라 브라우저 묶음과 병렬로 갈 수 있다.** Mac 화면 연결(surface)과 bridge 연결은 브라우저 묶음이 surface를 놓은 사이에 넣는다.
- `codex-chat-runtime.mjs`는 웹1·웹6과 맥2·맥10이 함께 건드린다. 같은 시기에 배정하지 않는다.
- 지금 `eg-desk-surface.uc.js`는 다른 작업이 수정 중이다. 묶음 가를 띄우기 전에 그 작업이 끝났는지 먼저 확인한다.

### 5.2 묶음

| 묶음 | 담는 줄 | 소유 파일 | 필요한 결정 | 검증 | 크기 | 대표님이 볼 변화 |
|---|---|---|---|---|---|---|
| **가. 브라우저 판정·기록** (지금) | 웹8 (a)(c), 웹9, 웹10, 웹4 | Child, Parent, surface, `egdesk-browser-tool-runtime.mjs`(+test), `codex-browser-tool-transport.mjs`, `scripts/egdesk-browser-tool-transport.test.mjs` | 없음 | 단위 시험 + 소유 headless fixture(EGQ 하네스). OS 전면 전환 없음 | M~L | 보내기 전에 막힌 동작이 카드를 잠그지 않는다(EGQ8 재선택 마찰 해소). 주소 이동 직후 관찰 실패가 준다. 시간 초과 뒤 실제로 눌렸는지 같은 시계로 판별할 수 있다 |
| **나. 문서 정정** (지금, Main 판단) | 2장 1·2번 | 갭 장부 BRW-10, `apps/firefox-ui-demo/docs/BROWSER_AGENT_OBSERVATION_RUNTIME.md` | 없음 | — | S | 화면 변화 없음. 다음 작업자가 BRW-10 원인을 잘못 잡지 않는다 |
| **다. 카드 스크린샷** | 웹6 | Parent, Child(민감 영역), surface, `egdesk-browser-tool-runtime.mjs`, `codex-browser-tool-provider.mjs`, `codex-chat-runtime.mjs` | 결정 3 | 실제 창 Firefox 필요(headless 캡처 미지원) | M | Agent가 그림·차트도 보고 판단한다 |
| **라. 사람처럼 누르기·키 입력** | 웹1, 웹2, 웹3, 웹8 (b) | Child, Parent, surface, `egdesk-browser-tool-runtime.mjs`, `codex-browser-tool-provider.mjs`, `codex-chat-runtime.mjs`, `codex-tool-errors.mjs`, `scripts/egdesk-browser-agent-guard.test.mjs`, 관찰 런타임 문서 | 결정 1·2 (웹3 완전판은 결정 6) | 소유 headless fixture가 isTrusted·좌표·순서·activeElement·hasFocus·수신 시각을 기록. OS 전면 전환 없음 | L | 클릭에 반응 없던 메뉴·버튼, 키 입력을 직접 받는 검색창·편집기에서도 Agent 조작이 된다 |
| **마. 표시점 이동** | 웹7 | surface, `eg-desk-surface.uc.css`, `scripts/egdesk-browser-tool-transport.test.mjs` | 결정 5 | 단위 시험 + 소유 fixture | S | 누르기 직전 표시점이 대상으로 이동한다 |
| **바. 다른 사이트 iframe** | 웹5 | surface, Child, Parent, `egdesk-browser-tool-runtime.mjs` | 결정 4. 라 이후 | 소유 fixture(cross-origin iframe) | L | 메일 작성창·임베드 로그인창 안에서도 Agent가 누르고 입력한다 |
| **사. Mac Node 상태기계** | 맥5·맥7의 Node 쪽, 맥8 승인 저장소, 맥1 Node 프로세스·소켓 규약 | 새 파일만: `egdesk-host-agent.mjs`(+test), `egdesk-host-lease.mjs`(+test), `egdesk-host-approvals.mjs` | 결정 7(Q3) | 가짜 poster로 단위 시험. OS 입력 0 | L | 화면 변화 없음(뒤 묶음의 바탕) |
| **아. Host Agent 앱 골격 (관찰 전용)** | 맥1 앱·실행·소켓, 맥8 권한 미리보기, 맥10 활성화·프로세스 관찰, 맥9 창 캡처 | 새 파일만: `helper/macos-host-agent/`, `scripts/build-macos-host-agent.sh`, `egdesk-host-activity.mjs` | 결정 8·9. 맥9는 화면 기록 권한 승인 | 관찰만, 입력 0. 맥10의 권한 불필요 부분은 Q1 (다) 범위 | L | (자와 함께) Codex 조작 중 앞 앱 변화와 서비스 실행이 보인다 |
| **자. Mac 화면 연결** | host-activity View, 설정의 권한·앱 승인 행, 중지 3단계 표시, bridge 연결 | surface, `codex-bridge-server.mjs`, `codex-chat-runtime.mjs` | 사·아 이후. 브라우저 묶음이 surface를 놓은 사이 | 소유 fixture | M | 관찰 View와 설정 화면에 Mac 조작 상태·권한이 보인다 |
| **차. Mac 입력** | 맥2, 맥3, 맥4, 맥6, 맥11, 맥10 자동 중지 토글 | `macos-host-agent/Sources/HostAgent/` 아래 Actions·CursorOverlay·FocusGuard·HumanInputMonitor·Watchdog·EmergencyStop, `egdesk-host-tool-provider.mjs` | 결정 7·10·11·12 + 손쉬운 사용·입력 모니터링 권한 | OS 전면 입력 시험 필수 | XL | 포인터·앞 창을 뺏지 않는 Mac 조작, 손대면 양보, 앱별 중지, 긴급 중지 키 |

> **메모 (2026-10-24, 결정 8 (나))**: 묶음 사·아·차는 Rust로 바뀐다. 표의 Swift package `helper/macos-host-agent/`와 그 아래 `.swift` 모듈(Actions·CursorOverlay·FocusGuard·HumanInputMonitor·Watchdog·EmergencyStop·WindowCapture·ActivityObserver·Permissions·AppLane)은 RT-04 Rust helper(`helper-rust/`) 안의 Rust 모듈로 만든다. 정확한 경로는 착수 때 다시 정한다. 권한을 받는 별도 도우미 .app 번들과 서명은 그대로 필요하다(결정 9). cua-driver(MIT)의 Rust 크레이트(objc2·screencapturekit 사용 예)는 참고·이식 대상이다(출처 표기). 결정 7·8·9가 정해져 사·아는 시작할 수 있다. 아는 관찰 전용이라 결정 11(관찰 전용부터)과 맞는다. 차는 OS 입력을 보내므로 결정 11의 입력 시험 보류가 풀려야 하고, 결정 10은 아직 정하지 않았다.

### 5.3 진행 순서

1. **지금**: 묶음 가(작업자 1명)와 묶음 나(Main)를 시작한다. 결정이 필요 없다.
2. **결정 3이 나오면** 다, **결정 1·2가 나오면** 라. 둘 다 가 뒤에 하고, 같은 파일을 쓰므로 서로 차례로 한다.
3. **결정 5가 나오면** 마. 작아서 브라우저 묶음 사이 surface가 비는 틈에 넣는다.
4. **결정 4가 나오면** 바. 라가 끝난 뒤다.
5. **Mac**: 결정 7(Q3) → 사(병렬). 결정 8·9 → 아(병렬). 사·아 뒤 surface가 비면 자. 결정 11(Q2 범위) 뒤 차.

---

## 6. 대표님 결정이 필요한 것

"권고"는 조사 측 의견이다. 결정은 대표님이 한다.

### 브라우저

**결정 1. 사람처럼 누르기(웹1)를 도입할지**
- 사람 클릭처럼 누르면 **페이지 안** 포커스가 누른 칸으로 옮겨진다. Chat 입력칸 포커스는 그대로일 것으로 보이지만 실측 전이다.
- (가) 별도 '사람처럼 누르기' 도구로만 허용한다 — 지금 안전 클릭은 그대로 두고, Agent가 따로 고를 때만 쓴다
- (나) 쓰지 않는다

> **결정 (2026-10-24, 대표님): (가).** 별도 '사람처럼 누르기' 도구로만 쓴다. 일반 클릭이 효과 없을 때만, 새로 관찰한 뒤 1회 누르고 착지 가드를 둔다. 키보드 trusted 입력(웹2)은 2단계로 따로 한다(reference-adoption-map D-B4).

**결정 2. '사용자가 직접 눌렀음' 권한을 줄지**
- 사람 클릭과 키 입력은 페이지에 팝업 열기·다운로드·클립보드 쓰기 같은 권한을 준다.
- (가) 조작을 허용한 카드에서는 준다
- (나) 주지 않는다 — 이 권한만 빼는 방법은 **확인 필요**라서, 지금으로서는 웹1·웹2를 쓰지 않는 것과 같다

> **결정 (2026-10-24, 대표님): (가).** 조작을 허용한 카드에는 '사용자가 직접 눌렀음'(user activation)을 준다.

**결정 3. 카드 스크린샷(웹6)의 가림 범위와 허용 조건**
- 가림 범위: (가) 비밀번호·민감 표시 칸만 / (나) 다른 사이트 iframe(결제·로그인)까지 / (다) 스크린샷을 도입하지 않는다
- 허용 조건: 관찰 권한만으로 허용할지, 조작 허용 카드에서만 허용할지

> **결정 (2026-10-24, 대표님): 가림은 (나) 비밀번호·민감 표시 칸 + 다른 사이트 iframe.** 허용 조건은 관찰 허용 카드도 포함한다. 읽지 못한 창도 가리고, 가리기에 실패하면 보내지 않는다(reference-adoption-map D-B6).

**결정 4. 다른 사이트 iframe 안 조작(웹5)을 열지**
- (가) 연다 — 결제·로그인·임베드 편집기 안도 Agent가 조작할 수 있다
- (나) 열지 않는다 — 지금처럼 '들어갈 수 없는 영역'으로 보고만 한다

> **결정 (2026-10-24, 대표님): (가) 연다.** 범위는 보기와 클릭까지다. 비밀 칸은 어느 경우든 대표님이 직접 한다(reference-adoption-map D-B5).

**결정 5. 표시점 이동 애니메이션(웹7)을 넣을지**
- 동작마다 최대 약 0.6초가 늘어난다.
- (가) 넣는다 / (나) 넣지 않는다

> **아직 정하지 않음 (2026-10-24 기준).** 지금 동작을 유지한다: 표시점은 승인 순간 그 자리에 바로 나타난다. 묶음 마는 시작하지 않는다.

**결정 6. '항상 포커스 있음' 위장(웹3 완전판)**
- 일반 Firefox로는 불가능하고 패치된 Firefox 빌드가 필요하다.
- (가) 일반 Firefox를 유지하고 부분 대체만 한다 ← 권고
- (나) 패치 빌드를 검토한다

> **결정 (2026-10-24, 대표님): (가).** 일반 Firefox를 유지하고 부분 대체만 한다.

### Mac

**결정 7. Mac 조작의 장기 방향 (= computer-use-options Q3)**
- Mac 묶음 사·아·차는 (가) 단계적 또는 (나) 자체 adapter일 때만 시작할 의미가 있다. (다) Codex 내장만이면 맥10(감독)만 남는다.

> **결정 (2026-10-24, 대표님): EG-Desk 자체 도우미를 Rust로 만든다.** cua-driver를 띄우는 안이 아니라 자체 adapter를 RT-04 Rust helper와 합쳐 만든다. cua-driver(MIT) Rust 코드는 참고·이식한다(출처 표기). (다)가 아니므로 사·아·차는 만들 대상이고, Codex 컴퓨터 조작은 Q1 (다)대로 켜 두므로 맥10(감독)도 쓴다. computer-use-options Q3, reference-adoption-map D-C1과 같은 결정이다.

**결정 8. Mac adapter를 무엇으로 만들지**
- (가) Swift 'EG-Desk Host Agent.app' ← 권고. 접근성·ScreenCaptureKit을 1급으로 쓰고, 기존 `macos-gesture-helper` Swift package(macOS 14) 경험이 있다
- (나) RT-04 Rust helper에 통합한다. cua-driver가 objc2·screencapturekit 크레이트로 같은 일을 한 예가 있다
- 어느 쪽이든 권한 주체가 되려면 .app 번들과 서명이 필요하다.

> **결정 (2026-10-24, 대표님): (나) RT-04 Rust helper에 통합한다.** 묶음 사·아·차의 Swift 계획은 Rust로 바뀐다(5.2 메모). 권한을 받는 .app 번들과 서명은 그대로 필요하다.

**결정 9. Mac 조작 권한을 누구에게 줄지**
- (가) 별도 Host Agent 앱에만 준다 ← 권고. 권한이 웹 내용과 분리된다
- (나) EG-Desk(Firefox) 앱 자체에 준다

> **결정 (2026-10-24, 대표님): (가).** Mac 조작 권한은 별도 도우미 .app에만 준다.

**결정 10. Codex 컴퓨터 조작 중 '대표님이 마우스·키보드를 만지면 Codex 자동 중지'를 켤지**
- 입력 모니터링 권한이 새로 필요하다. Q1 (다)의 '표시만'을 넘는 동작 변경이다.
- (가) 선택 토글로 넣는다 / (나) 표시만 유지한다

> **아직 정하지 않음 (2026-10-24 기준).** 지금은 표시만 한다(자동 중지 없음).

**결정 11. OS 전면 입력 시험 보류를 풀 범위 (= computer-use-options Q2와 연결)**
- 다음은 실제 입력 시험 없이는 검증할 수 없다: 접근성·postToPid 입력이 들어가는지, 앞 앱 되돌리기가 되는지, '중지 후 입력 0', 사람 입력 감지.

> **결정 (2026-10-24, 대표님): 관찰 전용부터.** 실제 화면 시험은 앱 목록·창 상태 읽기까지만 하고 OS 입력은 보내지 않는다. 위 네 가지 입력 시험은 아직 하지 않는다. computer-use-options Q2, reference-adoption-map D-C4와 같은 결정이다.

**결정 12. 전역 포인터 경로(HID)를 허용할지**
- 창 끌기·텍스트 드래그 선택은 앱 대상 입력으로 되지 않는다.
- (가) 대표님이 화면을 명시적으로 넘긴 경우에만 허용한다 ← 권고
- (나) 허용하지 않는다 — 그 동작은 Agent가 할 수 없다

> **결정 (2026-10-24, 대표님): (가).** 전역 포인터 경로(HID)는 대표님이 화면을 명시적으로 넘긴 경우에만 허용한다.

---

## 7. 확인 필요 (실측 전에는 단정하지 않는 것)

**브라우저**
- 비활성 카드에서 TIP 키 입력이 그 창의 포커스 요소로 들어가는지, 편집기가 받는지 (웹2)
- 페이지 쪽 trusted mousedown이 Chat 입력칸(chrome) 포커스를 건드리지 않는지 (웹1·웹3)
- 화면 밖이나 숨은 카드에서 `drawSnapshot`이 되는지 (웹6)
- 지금 `click()` 경로가 user activation을 주는지 (2장 1번, 결정 2)
- `isDOMEventSynthesized`(`mIsSynthesizedForTests`) 플래그의 부수효과 (웹1)
- actor child 호출이 CallerType::System인지. 확신은 높음~중간 (2장 1번)
- macOS에서 쓰는 실제 Firefox 버전. `synthesizeMouseEvent`(153+/159)와 `sendMouseEventToWindow`(ESR 140) 중 어느 쪽이 있는지가 여기에 달렸다
- Codex 동적 도구의 `inputImage` 응답이 실제 모델 왕복에서 동작하는지 (웹6)
- 실제 사이트에서 trusted 포인터가 효과를 내는지 (BRW-14)

**Mac**
- `CGEvent.postToPid` 이벤트가 전역 session tap을 거치지 않는지. postToPSN 문서 문구("대상 프로세스의 tap 앞에 게시")에서 유추했고, postToPid 문서에는 본문이 없다 (맥6·맥10)
- TCC 권한이 '책임 프로세스'(띄운 쪽)에 귀속되는지. 공식 문서가 아니라 cua `responsibility.rs` 주석과 OCU `docs/ARCHITECTURE.md:42` 설계에서 나온 근거다 (맥1)
- `macos-gesture-helper`가 모든 네트워크 인터페이스에서 듣는지 (2장 4번)
- 서명이 바뀔 때 권한이 유지되는지 (U11)
- macOS 14+ 협조적 활성화에서 앞 앱 되돌리기가 성공하는지 (맥4)
- 포인터 표시 패널이 권한 없이 동작하는지 (맥3)
- 접근성·postToPid 입력의 실제 수신, '중지 후 입력 0' (맥2·맥5·맥7)
- bytebot은 비교하지 않았다. Linux 컨테이너 기반이라 macOS 접근성 비교 대상이 아니라고 판단했지만 도구로 확인하지는 않았다

---

## 8. 근거와 출처

**조사 범위**: 2026-10-24 브라우저·Mac 조사 작업자 2명의 소스 읽기. Firefox 실행, Mac 입력·권한 요청, helper 빌드, 테스트 실행은 모두 0회다.

**공개 소스 (고정 커밋)**
- Gecko: [mozilla-firefox/firefox `774fa0cf`](https://github.com/mozilla-firefox/firefox/tree/774fa0cf68ccf50e8da30f50e71714abdc4686b5) (2026-10-23, MPL-2.0). 필요한 경로만 받았다.
- Firefox 버전별 API 대조: release 159.0(`9a2dc53c`), ESR 153.7.0(`bf92ad2c`), ESR 140.17.1(`02f6079d`)의 `nsIDOMWindowUtils.idl`·`Window.webidl`. `sendMouseEvent`·`sendMouseEventToWindow`는 ESR 140에만 있고(:363, :448), `synthesizeMouseEvent`는 159(:648)·ESR 153(:641)에 있다.
- Playwright Juggler: [microsoft/playwright `b4695e3e`](https://github.com/microsoft/playwright/tree/b4695e3eb2e6736d1a7b1fd255c4e94f78553660/browser_patches/firefox/juggler) (Apache-2.0)
- open-browser-use: [iFurySt/open-browser-use `b136cac`](https://github.com/iFurySt/open-browser-use/tree/b136cac71a3c497b5696aefd871dd15cba7d7559) (MIT). REA P-01과 같은 커밋이다.
- open-computer-use: [iFurySt/open-computer-use `43eb4b5`](https://github.com/iFurySt/open-computer-use/tree/43eb4b53de7a15b3f99ec2c9922bedeb95602266) (MIT). REA P-02와 같은 커밋이다.
- cua-driver: [trycua/cua `cbdc04a`](https://github.com/trycua/cua/tree/cbdc04a7beddf4e624ee30958c1b88db67e54c4c/libs/cua-driver/rust) (MIT)
- Peekaboo: [openclaw/Peekaboo `ba93bc0`](https://github.com/openclaw/Peekaboo/tree/ba93bc035b8418ec81e286fad5687c65320c260b) (MIT)
- macOS-use: [browser-use/macOS-use `7bb5003`](https://github.com/browser-use/macOS-use/tree/7bb5003f4a60a24cda9cf55daf63e5b14d15ee3b) (MIT)
- Codex 응답 형식: [DynamicToolCallOutputContentItem.ts](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/schema/typescript/v2/DynamicToolCallOutputContentItem.ts) (inputText/inputImage/inputAudio)
- Apple API 도입 버전·deprecation: developer.apple.com 문서 JSON 메타데이터 30여 개

**근거로 쓰지 않은 것**
- open-browser-use `packages/browser-client-rewrite`: OpenAI 번들을 다시 쓴 파생물이라 복사 위험이 있다.
- 비공개 macOS SPI: SkyLight `SLEventPostToPid`·`SLPS*`·`SLSHWCaptureWindowList`, `_AXUIElementGetWindow`, `responsibility_spawnattrs_setdisclaim`, OCU Locked Use의 relock SPI.
- OpenAI 설치 코드: REA 주장 ID 수준으로만 인용한다.

**우리 코드에서 확인한 곳**: 각 표의 '우리 지금' 열에 파일:줄로 적었다. 경로는 모두 `apps/firefox-ui-demo/` 아래다. `eg-desk-surface.uc.js` 줄 번호는 다른 작업 때문에 조사 중에도 약 258줄 밀렸으므로, 작업 전에 함수 이름으로 다시 찾는다.

**참고**
- 웹1~웹10은 브라우저 조사 보고의 M1~M10, 맥1~맥11은 Mac 조사 보고의 M1~M11과 같은 순서다.
- 조사에 쓴 clone은 세션 임시 폴더 `/private/tmp/claude-501/-Users-minsoocha-Projects-EG-Desk-Dev-Space/dac7ff27-92ee-4567-9d7f-546e39ec2742/scratchpad/refs/`에 있다. 세션이 끝나면 사라질 수 있으므로 위 고정 커밋 링크가 정본이다.
