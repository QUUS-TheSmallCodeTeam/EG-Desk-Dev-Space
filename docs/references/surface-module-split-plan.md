# 화면 파일 모듈 분리 계획

> 2026-10-24 · 근거: `reference-adoption-map.md` 4.3 끝 문단(화면 차례가 전체 속도의 병목), 0장(레퍼런스 원칙·라이선스)
> 기준 코드: `d76bb67` (`eg-desk-surface.uc.js`는 `b3ae83e` 이후 그대로, 18,652줄 / `eg-desk-surface.uc.css` 7,592줄). 줄 번호는 이 기준이며 계속 밀리므로, 구현할 때는 함수 이름·배너 주석으로 다시 찾는다.
> 이 문서는 계획([제안])이다. 저장소 코드는 바꾸지 않았고, 아래 "사본 시험" 결과는 저장소 사본에서만 돌렸다.

---

## 결과 먼저

- **무엇이 달라지나.** 지금은 화면 파일 5개(`eg-desk-surface.uc.js`·`.uc.css`·`EGDeskChatState`·`EGDeskSurfaceState`·`egdesk-surface-state.test.mjs`)를 한 번에 한 묶음만 고칠 수 있어 S1 → S10이 한 줄로 선다. 1~5단계를 마치면 화면 일이 **최대 6줄**(설정 / Browser / Chat 활동 / Chat 대화·연결 / 파일 창 / 나머지 공용)로 나뉘어 동시에 간다. 6단계까지 하면 Canvas·Board(S4·S7)도 따로 간다.
- **화면 동작은 그대로다.** 코드를 다시 쓰지 않고 **통째로 옮기기만** 한다. 단계마다 실제로 바뀌는 코드는 2~10줄(공유 카운터를 함수로 부르는 줄 등)이다.
- **사본에서 1~5단계를 미리 해 봤다.** 저장소 사본에 기계적으로 적용하고 매 단계 화면 시험 5개 파일을 돌렸다. 457개 중 **453 통과·0 실패·4 todo가 매 단계 그대로**였다. 그러려고 고친 시험 줄은 35곳이고, 그중 26곳은 "파일 읽는 줄"을 도우미 호출로 바꾼 것이다. `eg-desk-surface.uc.js`는 18,652줄 → 8,143줄이 됐다.
- **아직 모르는 것.** 실제 Firefox에서 새 모듈이 불리는지는 확인하지 않았다(이번 작업은 Firefox 실행 금지). 1단계 끝에 Main이 headless 1회로 확인한다. 안 되면 1단계 커밋 하나만 되돌리면 된다.
- **첫 단계는 반나절.** 14일 넘게 아무도 고치지 않은 카드 3개(온톨로지·파일·터미널, 2,143줄)를 떼면서 떼는 방식(불러오기·시험 읽기·지킴 시험)을 굳힌다. 진행 중인 다른 작업과 겹칠 곳이 거의 없다.

| 단계 | 떼는 구역 → 새 파일 (`overlay/resources/surface/`) | 옮기는 줄 | 끝나면 따로 갈 수 있는 화면 일 | 시작 조건 | 크기 |
|---|---|---|---|---|---|
| **1** | 온톨로지·파일·터미널 카드 → `EGDeskSurfaceOntology.mjs`·`EGDeskSurfaceFileCard.mjs`·`EGDeskSurfaceTerminal.mjs` | 2,143 | **파일 창 줄**: S3 '파일 창 자동 갱신 연결', S10 '변경 탭 연결·원본 저장'의 화면 쪽 | 화면 차례 사이 짧은 틈(S1 머지 직후 권장) | 반나절 |
| **2** | 구역 CSS 장치(터미널·온톨로지 CSS) + 설정 카드 → `EGDeskSurfaceSettings.mjs`·`.css` (+2-C ChatState 나누기, 선택) | 769 (+CSS 약 1,350) | **설정 줄**: S2 Agent 만들기·'컴퓨터 조작' 창, S9 Agent 프리셋·컴퓨터·엔진 설정 | 1단계 뒤, S2 시작 전. 설정 구역에 열린 수정이 없을 때 | 반나절~1일 |
| **3** | Browser 카드·Browser 도구 권한 → `EGDeskSurfaceBrowser.mjs` | 2,913 (+선택 145) | **Browser 줄**: S6 전체, S1의 Browser 쪽 남은 일 | REA 묶음 가 머지 뒤, S6 전 | 반나절~1일 |
| **4** | Chat 활동·결과·입력 → `EGDeskSurfaceChatActivity.mjs` | 1,040 | **Chat 활동 줄**: S3 결과 줄·브리핑·'변경 보기'·결과 카드·선택지 대기 | 3단계 뒤, S3 전 | 반나절 |
| **5** | Chat 연결 → `EGDeskSurfaceChatBridge.mjs`, Chat 대화(HUD·Chat 카드) → `EGDeskSurfaceChatView.mjs` | 2,196 + 1,592 | **Chat 대화·연결 줄**: S8 전체, S2 계정 칩·코드 입력 로그인, S9 엔진 화면 | 4단계 뒤, Chat 대화 구역에 열린 수정이 없을 때 | 1일 |
| **6** | Board 저장·전환·검색·미니맵·카메라·Desk 저장 | 약 4,700 | **Canvas·Board 줄**(S4·S7), **Desk 저장 줄**(S10 일부) | 5단계 뒤, 같은 도구로 사본 시제품부터 | 1~2일 |

5단계 뒤 `eg-desk-surface.uc.js`에 남는 것(약 8,100줄)은 상태·공용 도구·카드 틀·배치·껍데기(레일·Dock·HUD)·Canvas·Board·boot이며, 이것이 지금의 '화면 차례'를 이어받는 공용 줄이 된다(S4·S5·S7, 6단계 뒤에는 S5 중심).

---

## 1. 지금 구조

### 1.1 수치

파서(@babel/parser)로 센 값이다.

- IIFE 안 최상위 선언 544개, 그중 함수 448개.
- 큰 덩어리 5개가 7,570줄(41%): `installCodexBridge` 2,184줄(7545), `spawnBrowserCard` 2,155줄(14097), `mountCodexHUD` 1,328줄(6142, 그 안의 `render` 하나가 1,257줄), `renderOntologyMap` 1,137줄(11069), `spawnSettingsCard` 766줄(12598).
- 모든 구역이 함수 선언 끌어올림(hoisting)으로 서로를 이름만으로 부른다. 그래서 파일을 떼면 "누가 누구 이름을 쓰는지"가 곧 넘길 인터페이스다.

### 1.2 구역

'3일 안'은 최근 3일 안에 바뀐 줄 수(`git blame`, HEAD 기준). '가져옴/내줌'은 그 구역이 다른 구역 이름을 몇 개 쓰는지 / 다른 구역이 그 구역 이름을 몇 개 쓰는지.

| 구역 | 줄 | 줄 수 | 3일 안 | 가져옴/내줌 | 관련 화면 묶음 |
|---|---|---|---|---|---|
| 시작·모듈 불러오기·Browser actor 등록 | 9–60 | 48 | – | 0/16 | S1·S6 |
| Dock·Agent 프로필·방 모델 | 61–499 | 393 | – | 2/28 | S2·S8 |
| `state` 객체 | 500–642 | 143 | – | 모두가 씀 | – |
| 방 도우미·Chat 표시 이름 | 643–913 | 226 | – | 18/25 | S8 |
| **Chat 활동·결과·입력·브리핑** | 914–1946 | 1,033 | 613 | 38/18 | S3 |
| 상수·`el`·`svgEl`·`deskIcon` | 1948–2062 | 105 | – | 0/15 | 공용 |
| Browser 주소·sourceRef | 2063–2238 | 157 | – | 4/18 | 공용 |
| Board 저장·버전·복원·닫기 | 2239–3609 | 1,371 | 424 | 43/41 | S7·S10 |
| 상단 검색·Board 전환 | 3610–4489 | 880 | 29 | 41/16 | S7 |
| 선택·배치·화면 Board 이름 | 4490–4854 | 321 | – | 15/22 | S4 |
| 미니맵 | 4855–5330 | 476 | 184 | 11/5 | S4 |
| 창 단추·자원 표시·레일·Dock·HUD | 5331–5883 | 539 | – | 33/6 | S5 |
| 글·링크 도우미·연결 안내 | 5884–6141 | 226 | – | 14/18 | S8 |
| **Chat 대화(HUD)** `mountCodexHUD` | 6142–7469 | 1,328 | 483 | 58/1 | S8·S2·S1 |
| 제스처 도우미 + **Chat 연결** `installCodexBridge` | 7471–9728 | 2,258 | 827 | 62/2 | S8·S9 |
| HUD 열기·**Chat 카드** | 9730–9995 | 266 | 69 | 21/6 | S8 |
| 카드 틀·전체 화면·창 껍데기 | 9996–10452 | 437 | – | 17/15 | 공용 |
| Canvas 도형 | 10453–10673 | 211 | – | 10/7 | S7 |
| **온톨로지 카드** | 10674–12418 | 1,745 | 6 | 12/1 | – |
| **파일 카드** | 12420–12593 | 174 | 3 | 15/1 | S3·S10 |
| **설정 카드** | 12595–13363 | 769 | 659 | 18/1 | S2·S9 |
| **Browser 도구 권한·실행** | 13365–14096 | 732 | 847(카드 포함) | 8/21 | S1·S6 |
| **Browser 카드** `spawnBrowserCard` | 14097–16251 | 2,155 | (위와 합산) | 52/1 | S1·S6 |
| **터미널 카드** | 16252–16475 | 224 | 6 | 18/1 | – |
| 팝업 가로채기·Firefox 껍데기 숨김·Browser 표시 크기 | 16478–16645 | 168 | – | – | S1·S6 |
| 의미 확대·카메라 이동 | 16647–17672 | 1,026 | 221 | 39/6 | S4·S7 |
| 설정값·Desk 저장·휴대 묶음·Desk 기록·복구 | 17674–18403 | 730 | 625 | 21/21 | S10 |
| 화면 모드·`boot` | 18404–18651 | 248 | – | 103/1 | 공용 |

읽는 법: 온톨로지·파일·터미널은 차갑고(14일 넘게 안 바뀜) 밖으로 내주는 이름이 하나뿐이라 먼저 떼기 좋다. 설정·Browser·Chat은 뜨겁고 화면 묶음과 직접 겹쳐서, 떼면 동시 진행 효과가 크다. Board 저장 구역은 41개 이름을 16개 구역에 내주어 가장 엉켜 있다.

### 1.3 공유 상태 (떼어도 지켜야 하는 경계)

- **`state` 객체**(500–642): 모든 구역이 읽고 쓴다. 객체 하나라서 참조로 넘기면 그대로 공유된다.
- **여러 구역이 고쳐 쓰는 `let`**: `cardSeq`·`cardZ`(9996–9997, 카드 틀 밖 10개 구역 21곳에서 `++`), Browser 권한 번호 `browserToolAuthorityEpoch`·`browserToolFixtureLastAction`(13420–13421, Chat 연결 7581–7582·7967–7968에서 씀), 활동 기록 입력 중 표시 `activityPanelComposing`·`Deferred`(1648–1649, Chat 연결 7976–7977에서 씀), Agent 프로필 목록 `codexProfileCatalog`(210, Chat 연결 8034–8037에서 씀). ES 모듈은 다른 파일의 변수에 값을 다시 넣을 수 없으므로 함수로 바꿔야 한다(3.2).
- **state 훅**: 카메라 쪽이 `state.setCanvasPanTarget`(17264)·`setCanvasViewportTarget`(17285)·`panCanvasByWheel`(17292)·`startCanvasPanDrag`(17420)·`nativeGestureHook`(17334)·`renderSemanticProjections`(17165)·`focusChatDockIfCompact`(17028)를 state에 걸어 둔다. 이미 늦게 묶이는 구조라 그대로 둔다.
- **Chat 연결 핸들**: `state.codexBridge = installCodexBridge(...)`(18506). 동작 약 83개 + `subscribe`(바뀔 때 알림)이며 uc.js 안에서 34번 `state.codexBridge`로 쓴다. Chat 대화와 설정 카드는 이 객체로만 Chat 연결을 부른다. 이것이 5단계의 연결↔대화 경계다.
- **`window.__egdesk`**(18507–18630): headless QA가 쓰는 계약이다(예: `verify-firefox-mcp-headless-ui-regression.mjs:84`). 키 목록을 바꾸지 않는다.
- **공유 모듈**(10–18의 `ChromeUtils.importESModule`): 프로세스 하나에 하나인 `.sys.mjs`. 특히 Browser actor 부모 모듈은 모듈 안에 승인 등록부(`browserAuthorizers = new Map()`, `EGDeskBrowserAgentRuntimeParent.sys.mjs:3`)를 가진다. 인스턴스가 둘로 갈리면 Browser 조작 승인이 깨진다.

---

## 2. 모듈 방식 (레퍼런스 근거와 결정)

### 2.1 레퍼런스에서 확인한 사실

세 레퍼런스 모두 MPL-2.0이라 0장 규칙대로 **패턴만** 쓴다. 코드는 복사하지 않으므로 고지 의무가 없다.

**fx-autoconfig** (`brw_fx-autoconfig` `dfdab56`, 우리 로더)
- `JS/` 폴더에서 이름이 `.uc.js`·`.uc.mjs`·`.sys.mjs`로 끝나면 자동으로 불러온다(`profile/chrome/utils/boot.sys.mjs:421-422`). `.sys.mjs`는 창이 생기기 전에 배경 모듈로 바로 import된다(`:427-431`).
- `.uc.js`는 창마다 `Services.scriptloader.loadSubScriptWithOptions`로 창 전역에 **동기** 주입된다(`:195-205`, `:527-532`). 지금 `eg-desk-surface.uc.js`가 이 방식이다.
- `.uc.mjs`는 `module_loader.mjs`가 `import()`로 **비동기** 로드한다(`:522-525`, `module_loader.mjs:16`). 클래식 `.uc.js`보다 늦고 순서가 없다.
- 같은 창에서 스타일(`.uc.css`)은 스크립트 주입 **뒤에** 붙는다(`:533-537`).
- `resources/`는 `chrome://userchrome/content/`로 등록된다(`utils/chrome.manifest:4`). 하위 폴더도 된다. 지금도 `chrome://userchrome/content/ontology/graph.json`(uc.js:1958)을 쓰고 있다 [런타임].

**Zen** (`brw_zen-browser` `f2b18c4`)
- 창마다 도는 코드는 `.mjs`(sys 없음), 프로세스에 하나인 것은 `.sys.mjs`로 이름을 나눈다(`src/zen/` 아래 92개 모듈).
- 클래식 스크립트 하나가 창 모듈들을 `ChromeUtils.importESModule(script, { global: "current" })`로 차례대로 불러온다(`src/zen/common/ZenPreloadedScripts.js:15-36`). 지금 uc.js가 맡게 될 자리와 같다.
- 창 모듈 안에서 공유 싱글턴은 `ChromeUtils.defineESModuleGetters(lazy, {...})`로 늦게 받는다(`src/zen/spaces/ZenSpaceManager.mjs:12-14`).
- 창 모듈은 창 전역에 객체 하나를 남긴다(`window.gZenCompactModeManager = {...}`, `src/zen/compact-mode/ZenCompactMode.mjs:70`).

**Floorp** (`brw_floorp` `0be3a86`)
- 기능마다 폴더 하나, 입구 `index.ts`의 `init()`이 창마다 컨텍스트 객체 하나를 만들어 하위 부품에 넘긴다(`const ctx = new CPanelSidebar(); new PanelSidebarElem(ctx)`, `browser-features/chrome/common/panel-sidebar/index.ts:22-32`).
- 창별 컨텍스트는 `WeakMap<Window, Service>`에 둔다(`.../workspaces/index.ts:27-51`).
- TS+번들러라 파일 경계가 빌드에서 사라진다. 우리는 번들러가 없으므로 "기능별 파일 + 컨텍스트 하나 넘기기"만 따른다.

**Firefox 공식**
- `ChromeUtils.importESModule(url, { global: "current" })`는 모듈을 "현재 전역에" 불러온다(`gecko-sparse` `774fa0cf`, `dom/chrome-webidl/ChromeUtils.webidl:1230-1266`). 같은 URL은 그 전역에서 한 번만 평가된다(`:510-514`).
- 설치된 Firefox는 158.0.1이다(`~/Applications/Firefox.app` Info.plist). [공식] 문서와 Zen 코드가 근거이며, Firefox 158에서 직접 돌려 보지는 않았다 → **1단계 확인 항목**.

### 2.2 결정 [제안]

- **위치**: `overlay/resources/surface/EGDeskSurface<구역>.mjs`(창 모듈이라 `.sys` 없음, Zen 이름 규칙).
- **불러오기**: uc.js가 창마다 한 번 `ChromeUtils.importESModule('chrome://userchrome/content/surface/<파일>', { global: 'current' })`.
- **고르지 않은 것**
  - `overlay/JS/*.uc.mjs`: 로더가 따로 비동기로 불러 uc.js보다 늦고 순서가 없다. 그리고 설치 스크립트 3곳이 `JS/*.uc.js`만 복사한다(`scripts/install.sh:251`, `install.bat:77`, `run-firefox-mcp-target.sh:56`; 앞 두 파일은 지금 1-Q가 고치는 중이라 줄이 바뀐다) → 새 PC에서 빠진다.
  - `overlay/JS/*.sys.mjs`: 시작할 때 창 없이 바로 실행된다.
  - `overlay/resources/EGDesk*.sys.mjs`(공유 전역): `document`·`window`가 없어 화면 코드를 그대로 옮길 수 없다. 옮긴 코드가 쓰는 창 전역(document·window·fetch·setTimeout·Cc/Ci·ChromeUtils·performance·structuredClone·CustomEvent·KeyboardEvent 등, 사본에서 센 것)을 모두 넘겨야 하고, 모듈 안 값이 모든 창(팝업 포함)에서 공유된다.
- **설치 쪽 변경 없음**: `resources/`는 설치·실행 스크립트 5곳이 모두 하위 폴더째 복사한다(`install.sh:253`, `install.bat:79`, `run-firefox-mcp-target.sh:58`, `run-firefox-mcp-target.mjs:98-106`, `run-egdesk-windows.mjs:178-183`).

### 2.3 옮기는 규칙 [제안]

- **R1 통째로 옮긴다.** 구역 코드를 `export function create<구역>Zone(deps) { const {…} = deps; <원래 코드> return {…}; }` 안에 넣는다. 원래 코드의 들여쓰기(2칸)와 줄바꿈을 그대로 둔다. 그래야 시험의 정규식(`/  function X\(/`, 끝 `\n  }\n`)이 옮긴 뒤에도 맞는다.
- **R2 공유 모듈(.sys.mjs)은 정적 `import` 금지.** uc.js가 이미 가진 것(ChatState·SurfaceState·InputContext·BriefingState·Markdown·FileCardState·BrowserAgentReceipts·RecoveryState·PortableState)은 deps로 받는다. 새로 필요한 `.sys.mjs`는 구역 안에서 `ChromeUtils.importESModule(url)`(전역 지정 없음 = 공유 인스턴스) 또는 `defineESModuleGetters`로 부른다. 파일 카드가 이미 이렇게 `EGDeskFileView`를 부른다(uc.js:12538). 창 모듈에서 정적 import하면 그 창 전역에 두 번째 인스턴스가 생길 수 있고 [의견·확인 필요], 1.3의 승인 등록부처럼 모듈 안 값이 갈리면 안전 장치가 깨진다. 이 규칙을 지키면 새 모듈을 쓰려고 uc.js를 고칠 일도 없다.
- **R3 다른 파일이 고쳐 쓰는 `let`은 함수로 바꾼다**(3.2).
- **R4 함수가 아닌 공유 값(Map·Set·상수)은 core(uc.js)에 남긴다.** 예: Browser 권한 Map·Set 9개(13408–13419), `userInputDrafts`(1647), `CHAT_ZOOM_GAP`(9797), `boardCloseRequests`(3279).
- **R5 원래 자리에 이어주기 한 줄.** `const spawnBrowserCard = surfaceForward('browser', 'spawnBrowserCard');` 부르는 쪽 코드는 그대로다. 이 모양은 시험이 세는 `spawnBrowserCard(` 횟수를 늘리지 않는다. 사본에서 `(...args) => surfaceZones.x.spawnBrowserCard(...args)` 모양은 호출 횟수 시험 1개를 깨뜨렸다(test:9764).
- **R6 설치 지점은 하나.** uc.js 끝 `if (document.readyState === 'complete') boot();` 바로 위의 `installSurfaceZones()`. 이때는 모든 const가 준비돼 있어 순서 문제가 없고, 이어주기는 부를 때 찾으므로 구역끼리 서로 불러도 된다.
- **R7 구역 파일 맨 위에서는 아무것도 실행하지 않는다**(정의만). 그래서 node에서 import하고 가짜 deps로 factory를 부를 수 있다(사본에서 8개 모두 확인).
- **R8 이름**: 넘기는 객체 이름은 `deps`. `ctx`는 Canvas 2D 문맥 이름과 헷갈려 피했다(지금 uc.js에 식별자 `deps`는 0회).
- **R9 deps 목록은 한 줄에 한 이름, 가나다(알파벳)순.** 여러 줄이 서로 다른 이름을 더해도 git이 대부분 자동으로 합친다(5단계 뒤 이름 168개).

### 2.4 코드 모양

구역 파일(사본에서 만든 그대로, 줄임):

```js
// overlay/resources/surface/EGDeskSurfaceTerminal.mjs
// Moved verbatim from overlay/JS/eg-desk-surface.uc.js.
// Loaded once per window: ChromeUtils.importESModule(url, { global: 'current' }).
// Never statically import a .sys.mjs here; shared modules arrive through deps.
export function createTerminalZone(deps) {
  const {
    TAG, allocCardSeq, bindCardSourceRef, boardCloseRequests, /* … 18개 */ state,
  } = deps;

  // ============ Terminal Canvas Card ============   ← 원래 코드, 들여쓰기 그대로
  function spawnTerminalCard(options = {}) {
    const id = `egd-terminal-card-${allocCardSeq()}`;  // 원래 ++cardSeq
    …
  }

  return { spawnTerminalCard };
}
```

uc.js 쪽:

```js
  // 원래 터미널 코드가 있던 자리
  // 터미널 카드 → overlay/resources/surface/EGDeskSurfaceTerminal.mjs
  const spawnTerminalCard = surfaceForward('terminal', 'spawnTerminalCard');

  // let cardSeq = 0; 바로 아래
  function allocCardSeq() { return ++cardSeq; }
  function raiseCardZ() { return ++cardZ; }

  // 파일 끝, readyState 줄 바로 위
  // ============ Surface zone modules (overlay/resources/surface) ============
  const SURFACE_MODULE_BASE = 'chrome://userchrome/content/surface/';
  const surfaceZones = Object.create(null);
  function surfaceForward(zone, name) { return (...args) => surfaceZones[zone][name](...args); }
  function installSurfaceZones() {
    const deps = Object.freeze({
      FileCardState,
      ONTOLOGY_GRAPH_URL,
      // … 한 줄에 한 이름
    });
    const load = (file) => ChromeUtils.importESModule(SURFACE_MODULE_BASE + file, { global: 'current' });
    surfaceZones.ontology = load('EGDeskSurfaceOntology.mjs').createOntologyZone(deps);
    surfaceZones.fileCard = load('EGDeskSurfaceFileCard.mjs').createFileCardZone(deps);
    surfaceZones.terminal = load('EGDeskSurfaceTerminal.mjs').createTerminalZone(deps);
  }
  try { installSurfaceZones(); } catch (err) { console.error(TAG, 'surface zone install failed', err); }
```

---

## 3. 공유 상태 경계와 넘길 인터페이스

### 3.1 deps 하나

uc.js가 `Object.freeze`한 객체 하나를 모든 구역에 넘긴다(Floorp의 "컨텍스트 하나"). 구역은 필요한 이름만 꺼낸다. 사본에서 센 구역별 이름 수: 온톨로지 12, 파일 15, 터미널 18, 설정 18, Browser 51, Chat 활동 39, Chat 연결 64, Chat 대화 75. 1단계 뒤 deps는 31개, 5단계 뒤 168개.

### 3.2 고쳐 쓰는 `let` → 함수

| 값 | 선언 | 다른 파일에서 쓰는 곳 | 바꾸는 법 | 단계 |
|---|---|---|---|---|
| `cardSeq`·`cardZ` | 9997·9996 | 카드 틀 밖 10개 구역 21곳의 `++` | core에 `allocCardSeq()`·`raiseCardZ()`. 저장 복원에서 최댓값 맞추는 곳(2398·3043)은 core라 그대로 | 1단계부터 |
| `browserToolAuthorityEpoch`·`browserToolFixtureLastAction` | 13421·13420 | Chat 연결 7581–7582·7967–7968 | Browser 구역이 갖고 `resetBrowserToolAuthority()`를 내준다(번호 올림 → 마지막 동작 비움, 순서 그대로) | 3 |
| `browserAgentActorReady` | 25 | Browser 카드 14610 | actor 등록 함수(28–59)와 함께 Browser 구역으로 | 3 |
| `activityPanelComposing`·`Deferred` | 1648–1649 | Chat 연결 7976–7977 | Chat 활동 구역이 갖고 `resetActivityPanelComposition()`을 내준다 | 4 |
| `codexProfileCatalog` | 210 | Chat 연결 8034·8036·8037·8873, Chat 대화 7166 | core에 두고 `getCodexProfileCatalog()`·`setCodexProfileCatalog()`. core 프로필 함수(228·323)가 읽고 시험도 이 이름으로 넣는다(test:4758) | 5 |

### 3.3 그대로 두는 경계

- `state`: 참조로 넘긴다. 키를 옮기거나 나누지 않는다.
- 카메라 state 훅: 그대로.
- Chat 연결 ↔ 화면: `state.codexBridge`의 동작·`subscribe`. 설정·Chat 대화는 지금처럼 `state.codexBridge?.x()`로 부르므로 deps가 필요 없다.
- `window.__egdesk`: boot 안의 객체 그대로. 값으로 들어가는 함수가 이어주기로 바뀔 뿐 키와 동작은 같다.
- `.sys.mjs` 인스턴스: uc.js가 불러 deps로 넘기거나(R2), 구역이 공유 전역으로 부른다.

---

## 4. 시험 영향과 대응

### 4.1 지금 시험이 화면 파일을 읽는 방식

- `scripts/egdesk-surface-state.test.mjs`(11,420줄): uc.js 전체를 문자열로 읽어(`:30`) 정규식 `match` 122곳, `indexOf` 35곳, `slice` 15곳, `assert.match` 120곳, `includes` 11곳으로 함수 본문을 뽑고, `compileFunction` 171곳으로 실행해 본다. CSS 문자열 읽기 18곳.
- `scripts/egdesk-browser-tool-transport.test.mjs`: `between(start, end)`로 22쌍을 자른다(`:11-37` 등). CSS 1곳.
- `scripts/egdesk-terminal-init.test.mjs:326-332`(`onTerminalReady`), `scripts/verify-semantic-zoom.test.mjs:8`(+CSS 2곳), `scripts/egdesk-design-tokens.test.mjs:13`(CSS).
- Firefox 시험 14개(`verify-firefox-mcp-*.mjs`)는 저장소 uc.js를 `loadSubScript`로 다시 붙인다(예: `verify-firefox-mcp-ontology-card.mjs:171`).

### 4.2 대응: 시험 도우미 하나

새 파일 `scripts/egdesk-surface-source.mjs`(사본에서 쓴 그대로):

```js
import { readFileSync } from 'node:fs';

// The screen source as Firefox runs it: eg-desk-surface.uc.js followed by every
// surface module it loads, in load order.
const overlay = new URL('../overlay/', import.meta.url);
const read = (relative) => readFileSync(new URL(relative, overlay), 'utf8').replace(/\r\n/g, '\n');

export function surfaceModuleFiles(script = read('JS/eg-desk-surface.uc.js')) {
  return [...script.matchAll(/load\('([A-Za-z0-9]+\.mjs)'\)/g)].map((match) => `resources/surface/${match[1]}`);
}
export function readSurfaceSource() {
  const script = read('JS/eg-desk-surface.uc.js');
  return [script, ...surfaceModuleFiles(script).map(read)].join('\n');
}
export function surfaceSheetFiles(script = read('JS/eg-desk-surface.uc.js')) {
  const list = script.match(/const SURFACE_ZONE_SHEETS = \[([^\]]*)\]/)?.[1] || '';
  return [...list.matchAll(/'([A-Za-z0-9]+\.css)'/g)].map((match) => `resources/surface/${match[1]}`);
}
export function readSurfaceCss() {
  return [read('CSS/eg-desk-surface.uc.css'), ...surfaceSheetFiles().map(read)].join('\n');
}
```

- 1단계: 읽는 줄 4곳을 `readSurfaceSource()`로(state test:30, transport:10, terminal-init:326, semantic-zoom:8). 2단계부터 CSS 읽기 22곳을 `readSurfaceCss()`로.
- **왜 이것으로 충분한가.** R1로 들여쓰기가 같아 정규식이 그대로 맞는다. 옮긴 본문이 표에 적은 줄 말고는 같아서 `compileFunction`에 넣는 인자 이름도 그대로 맞는다. 붙인 문자열에 옮긴 코드가 모두 들어 있으니 "이 글이 없어야 한다"는 부정 시험도 의미를 잃지 않는다. 도우미 없이 옮기면 이 부정 시험들이 **조용히 통과**하게 되는 것이 가장 큰 위험이다.
- **음성 대조(사본).** 도우미 없이 1단계만 적용하면 6개가 실패했다(파일 카드 4, 배치 정책 1, 터미널 1). 도우미를 쓰면 0개.

### 4.3 시험을 고쳐야 하는 네 모양 (사본 1~5단계에서 나온 전부)

1. **`compileFunction` 인자로 `cardSeq`·`cardZ`를 숫자로 넣는 곳** → 코드 문자열 앞에 `const allocCardSeq = () => ++cardSeq, raiseCardZ = () => ++cardZ;` 한 줄. 설정 4곳(test:5120·7630·9303·9559), 결과 카드(test:9785), Chat 카드 끌기(test:3752).
2. **다음 구역의 첫 함수를 끝 표지로 쓰는 `slice`** → 구역 끝 표지로. 설정(test:4741, `'\n  function resolveBrowserCard('` → `'\n  return { spawnSettingsCard };'`), Chat 카드(test:853, 배너 → `'\n  }\n'`). 주의: 끝 표지를 못 찾으면 `indexOf`가 -1을 돌려 `slice`가 문자열 끝까지 넓어진다. **실패하지 않고 느슨해진다**(사본에서 853이 그랬다). 그래서 단계마다 9.3의 경계 표지 목록을 확인한다.
3. **호출 횟수를 세는 시험**(test:9764-9765) → R5 이어주기 모양으로 피했다. 시험 수정 없음.
4. **옮긴 `let`을 흉내 내는 시험 틀**(transport:937 근처) → `const resetBrowserToolAuthority = () => { browserToolAuthorityEpoch++; browserToolFixtureLastAction = null };` 한 줄.

### 4.4 지킴 시험 (1단계에 새로 만든다)

`scripts/egdesk-surface-modules.test.mjs`, node 내장 모듈만 쓴다.

- (a) uc.js의 `load('…mjs')` 목록의 파일이 모두 있고, node에서 import되며 `create…Zone`을 내보낸다.
- (b) 구역 파일에 `import … from` 문이 없다(R2).
- (c) 각 구역 factory를 가짜 deps(Proxy)로 불러, uc.js의 `surfaceForward('구역', '이름')`이 가리키는 이름이 모두 돌려받은 객체에 함수로 있다. 사본 5단계 뒤 44개 모두 일치.
- (d) 구역 파일이 꺼내는 deps 이름이 모두 uc.js deps 목록에 있다.
- (e) uc.js 최상위 이름이 구역 파일에서 deps 없이 쓰이지 않는다(정규식 근사). 사본에서는 파서로 8개 구역 모두 0건이었다.
- (f) boot의 `window.__egdesk` 키 목록이 분리 전과 같다.

### 4.5 새 시험은 줄별 파일로

분리 뒤 각 줄의 새 시험은 `scripts/egdesk-surface-<구역>.test.mjs`에 둔다(도우미를 쓰거나 구역 모듈을 직접 import). 11,420줄짜리 state test에 계속 더하면 시험 파일이 새 병목이 된다. 기존 시험은 그대로 둔다.

---

## 5. 회귀 확인 (모든 단계 공통)

1. **옮김 그대로 검사**: 원래 줄 범위와 구역 파일 본문을 `diff`한다. 다른 줄이 단계 표에 적은 줄뿐이어야 한다. 사본 1단계: 1,745+174+224줄 중 5줄만 달랐다.
2. `node --check overlay/JS/eg-desk-surface.uc.js`, 구역 파일 node import.
3. node 시험(같은 수가 나와야 한다. 사본 기준 457개, 453 통과·0 실패·4 todo, 여기에 지킴 시험이 더해진다):
   `cd /Users/minsoocha/Projects/EG-Desk-Dev-Space/apps/firefox-ui-demo && node --test scripts/egdesk-surface-state.test.mjs scripts/egdesk-browser-tool-transport.test.mjs scripts/egdesk-terminal-init.test.mjs scripts/verify-semantic-zoom.test.mjs scripts/egdesk-design-tokens.test.mjs scripts/egdesk-surface-modules.test.mjs`
4. **Main**: 중앙 회귀(전체 node 시험, `9dbfa51` 때 515/515), headless Chat 흐름 72/72(`verify-firefox-mcp-chat-fixture-flow.mjs`), headless UI 회귀 274/274(`verify-firefox-mcp-headless-ui-regression.mjs`), 그리고 단계별 확인(6장). 콘솔에 `surface zone install failed`·`surface sheet failed`가 없어야 한다.
5. **live remount 시험 주의**: 14개 remount 시험은 저장소 uc.js만 다시 붙이고 구역 파일은 프로필 복사본(chrome://)을 쓴다. 구역 파일은 한 번 불린 창에서 다시 평가되지 않으므로, 구역 파일을 고친 뒤에는 overlay를 다시 복사하고 Firefox를 새로 띄워야 바뀐 코드가 시험된다 [의견·확인 필요]. `run-firefox-mcp-target`은 띄울 때 복사하므로 띄운 직후에는 같다.

---

## 6. 단계별 계획

각 단계는 (1) 옮길 것과 줄 범위 (2) 공유 상태 경계와 넘길 인터페이스 (3) 시험 영향과 대응 (4) 회귀 확인 (5) 그 단계 뒤 동시에 고칠 수 있게 되는 화면 줄 순서다. 단계마다 소유 파일은 `eg-desk-surface.uc.js`, 그 단계의 새 구역 파일, 고치는 시험 파일이다(그 사이 화면 차례를 잠깐 잡는다).

### 1단계 — 차가운 카드 3개와 떼는 장치 (반나절)

**시작 조건**: 화면 차례 사이 짧은 틈(S1 머지 직후 권장). 세 구역은 14일 넘게 거의 안 바뀌어(3일 안 바뀐 줄 6·3·6) 다른 작업의 diff와 겹칠 곳이 적다. 그래도 시험 파일 4곳의 첫 줄을 고치므로 Main이 그 순간만 맞춘다.

(1) **옮길 것**
- 온톨로지 10674–12418(1,745줄): `ONTOLOGY_*` 상수 7개, `ontologyModelCache`, `ontologyTitleCase` … `renderOntologyMap`(11069–12205) … `loadOntologyGraph`, `spawnOntologyMapCard`(12213–12418) → `EGDeskSurfaceOntology.mjs`. 내줌: `spawnOntologyMapCard`.
- 파일 카드 12420–12593(174줄): `requestLocalFilePacket`, `pickNativeFileDirectory`, `pickNativeFileSaveFile`, `spawnFileCard` → `EGDeskSurfaceFileCard.mjs`. 내줌: `spawnFileCard`.
- 터미널 16252–16475(224줄): 배너, `EGDESK_HELPER_PORT`(어디서도 안 쓰는 상수), `TERMINAL_HTML_URL`, `spawnTerminalCard` → `EGDeskSurfaceTerminal.mjs`. 내줌: `spawnTerminalCard`.
- 바뀌는 코드 5줄: 12222·12496·16259 `++cardSeq` → `allocCardSeq()`, 12242·16273 `++cardZ` → `raiseCardZ()`.
- uc.js에 더하는 것: `allocCardSeq`·`raiseCardZ`(9997 다음 2줄), 이어주기 3줄(옛 자리), 설치 묶음 약 20줄(2.4).

(2) **경계**: 온톨로지 deps 12개(`el`, `svgEl`, `ONTOLOGY_GRAPH_URL`, `spawnDeskWindowShell`, `focusCanvasCard`, `syncOntologyPresentationState`, `singletonSourceRef`, `focusOpenSourceCard`, `resolveCanvasCardPlacement`, `revealPlacedCanvasCard`, `allocCardSeq`, `raiseCardZ`; `state`는 안 쓴다), 파일 15개(위 일부 + `state`, `FileCardState`, `chatBindingNonce`, `getCodexThreadById`, `boardNotice`, `cloneJson`, `chatInputSourceForView`, `openChatInputPanel`, `markAgendaDirty`), 터미널 18개(+ `TAG`, `makeSourceRef`, `bindCardSourceRef`, `setActiveEntity`, `closeCanvasCard`, `isCardFullscreen`, `installCardHeaderFullscreenToggle`, `canvasZoom`, `boardCloseRequests`, `completeAgendaClose`). 합쳐 31개. 창 전역은 `document`·`window`·`fetch`·`setTimeout`·`Cc`·`Ci`·`ChromeUtils`·`console`만 쓴다.

(3) **시험**: 도우미 새 파일 + 읽는 줄 4곳 + 지킴 시험 새 파일. 옮긴 구역을 읽는 기존 시험(state test:3714·3730·3792 파일 서비스, :6107 배치 정책, terminal-init:327)은 고치지 않고 통과했다(사본).

(4) **회귀**: 5장 + Main headless에서 `window.__egdesk.cardRuntime.openOntologyMapCard()`·`openFileCard()`·`openTerminalCard()`가 카드를 만들고 `.egd-ontology-error`가 없는지, 세 카드가 든 저장 Desk가 복원되는지, Dock 단추로 열리는지. **이것이 `global: 'current'` 첫 실제 확인이다.** 실패하면 1단계 커밋(uc.js, 새 파일 5개, 시험 4줄)을 되돌린다.

(5) **열리는 줄**: **파일 창 줄** — `EGDeskSurfaceFileCard.mjs`에서 1-G의 '변경' 탭·`onFileChanged` 연결(S3 '파일 창 자동 갱신 연결'), S10 '변경 탭 연결·원본 저장'의 화면 쪽을 화면 차례와 따로 할 수 있다. 온톨로지·터미널은 지금 S 차례에 일이 없지만 이후 이 둘의 일은 차례를 기다리지 않는다. uc.js 18,652 → 약 16,540줄.

### 2단계 — 구역 CSS 장치 + 설정 카드

**시작 조건**: 1단계 확인 뒤, S2 시작 전. 설정 구역은 최근 3일에 769줄 중 659줄이 바뀐 곳이라 열린 설정 수정이 없을 때.

**2-A 구역 CSS 장치와 차가운 CSS 두 덩어리**
- (1) 터미널 CSS 5356–5402(47줄), 온톨로지 CSS 5404–6122(719줄) → `resources/surface/EGDeskSurfaceTerminal.css`·`EGDeskSurfaceOntology.css`. 각 파일 맨 위에 주 CSS 7번째 줄과 같은 `@namespace url("http://www.w3.org/1999/xhtml");`를 반복한다(빠지면 요소 선택자가 다르게 맞는다).
- (2) uc.js에 `SURFACE_ZONE_SHEETS` 목록과 `loadSurfaceZoneSheets()`를 두고 `paintSurface()` 첫 줄에서 부른다. boot는 load 이벤트 뒤에 돌아서 이때는 로더가 주 CSS를 이미 붙였다(`boot.sys.mjs:527-537`). 붙이는 방법은 `window.windowUtils.loadSheetUsingURIString(url, AUTHOR_SHEET)` — [공식] 그 문서의 추가 스타일시트 목록에 붙인다(`gecko-release-files/nsIDOMWindowUtils.release.idl:1757-1771`). 목록 뒤에 붙으니 같은 명시도면 구역 CSS가 이긴다 [의견·확인 필요]. 같은 시트를 두 번 붙일 때를 대비해 `removeSheetUsingURIString` 뒤 붙이도록 한다.
- 겹침 검사(옮기는 덩어리마다): 덩어리 원래 자리 뒤에서 같은 요소를 고르는 규칙을 찾는다. 이 두 덩어리 뒤(6124–7592)에는 동작 줄이기 `[class*="egd-"]` 규칙(6259–6264, 모두 `!important`)뿐이라 순서가 바뀌어도 결과가 같다 [조사].
- (3) 시험: CSS 읽기 22곳 → `readSurfaceCss()`. state test:5952의 Terminal→Ontology 배너 `slice`는 `SURFACE_ZONE_SHEETS`가 Terminal, Ontology 순일 때만 맞으므로 끝 표지를 고쳐 두기를 권한다. 사본: 457/453/0/4 그대로.

**2-B 설정 카드**
- (1) 12595–13363(769줄): 배너 + `spawnSettingsCard`(계정 탭·'컴퓨터 조작' 행·'연결된 도구'·Agent 관리 목록/상세/폼) → `EGDeskSurfaceSettings.mjs`. 바뀌는 코드 2줄(12607 카운터, 12617 z순서). CSS: 설정 덩어리 4808–5229, 뒤쪽 설정 규칙 6892–6912(CU-07), 7181–7287(AGENT-04·02), 7374–7405(CU-01) → `EGDeskSurfaceSettings.css`(순서 유지, 겹침 검사 후).
- (2) deps 18개: `ChatState`, `state`, `codexProfileAvatar`, `el`, `singletonSourceRef`, `focusOpenSourceCard`, `bindCardSourceRef`, `resolveCanvasCardPlacement`, `revealPlacedCanvasCard`, `setActiveEntity`, `closeCanvasCard`, `isCardFullscreen`, `focusCanvasCard`, `installCardHeaderFullscreenToggle`, `canvasZoom`, `markAgendaDirty`, `allocCardSeq`, `raiseCardZ`. Chat 연결은 지금처럼 `state.codexBridge`(`loadProfiles`·`subscribe` 등)로.
- (3) 시험 5줄: test:4741 끝 표지, test:5120·7630·9303·9559 카운터 한 줄. 고치기 전 7개 실패(사본) → 고친 뒤 457/453/0/4.
- (4) 회귀: 5장 + headless에서 설정 열기(계정·Agent 탭), Agent 저장(픽스처), '컴퓨터 조작' 행, 4개 크기 스크린샷.
- (5) **열리는 줄**: **설정 줄** — S2의 Agent 만들기(복제·예시 대화·하지 말 것·선호 도구 숨김)와 '컴퓨터 조작' 창 1단계, S9의 Agent 프리셋·'지금 할 수 있는 것'·컴퓨터 허락 설정·엔진 설정 화면. S2의 계정 칩 popover·코드 입력 로그인·Claude 상태 줄은 Chat 대화 쪽이라 5단계 전까지 공용 줄에 남는다.

**2-C (선택, 다른 작업자) `EGDeskChatState` 나누기** — 화면 파일이 아니라 상태 모듈이므로 uc.js 이동과 따로 할 수 있다(이 파일을 잡은 S 묶음이 없을 때).
- 줄 범위로 나눈다: 프로필·도구 범위·준비 상태 1032–1381 → `EGDeskChatProfileState.sys.mjs`(설정 줄), 엔진·모델·사용량·오류·일회성·분기 1382–1807 → `EGDeskChatEngineState`(설정·Chat 대화), 컴퓨터 조작·사용·MCP 1808–1996 → `EGDeskChatComputerState`(설정), 작업 목록·계획·대기 1997–2552 → `EGDeskChatTaskState`(Chat 활동), 결과 카드·긴 답·Browser 사용자 제어 2553–2712 → `EGDeskChatResultState`(Chat 활동). 1–1031(프로토콜·기록·요청·맥락·리듀서)은 그대로.
- `EGDeskChatState.sys.mjs`는 `export * from './EGDeskChat…State.sys.mjs'`만 남겨 `ChatState.x` 이름 202개가 그대로 보인다 → uc.js·시험·helper 수정 없음. `.sys.mjs`끼리 상대 경로 import는 이미 쓰는 방식이다(`EGDeskMarkdown.sys.mjs:1`).
- 영역끼리 서로 부른다(파서로 셈): 프로필↔프로토콜(`isProfileId`·`publicProfileAvatar` / `copy`·`isRunBusy`·`pendingUserInputCount`), 엔진↔프로토콜, 컴퓨터↔프로토콜·엔진(`MCP_STATUS_TEXT` 등), 작업·결과→프로토콜. 순환 import가 생기므로 화살표 const로 된 공용 도우미(`copy`:2, `nonEmptyId`:888, `lookup`:1050, `isEngineId`:1387)를 먼저 `EGDeskChatStateBase.sys.mjs`로 뺀다(순환에서 const는 평가 순서에 따라 초기화 전 접근 오류).
- 확인: facade에서 202개 export가 모두 보이는지 시험 1개 + 기존 시험.
- `EGDeskSurfaceState`(999줄)도 같은 방식: Browser 작업 보고·Agent 배지 628–915 → `EGDeskSurfaceBrowserState`(3단계 줄), 나머지는 6단계 때.

### 3단계 — Browser

**시작 조건**: REA 묶음 가(uc.js·actor Child/Parent)가 머지된 뒤, S6 전. 안전 경로(0장 4번 EG-01·03·08)이므로 바뀌는 코드는 아래 표의 줄뿐이어야 한다.

(1) **옮길 것**(사본 범위 2,913줄)
- actor 등록: `let browserAgentActorReady`(25), `ensureBrowserAgentActor`(28–59).
- `resolveBrowserCard`·`browserCardState`·`browserCardControl`(13365–13406).
- Browser 도구 권한·실행(13420–14095): `revokeBrowserToolRunImmediately` … `registerBrowserToolSelection` … `browserToolDispatchOnce`·`browserToolDispatch`·`attachBrowserToolTransport`.
- `spawnBrowserCard`(14097–16251).
- core에 남기는 것: 권한 Map·Set 9개(13408–13419, Chat 연결도 지운다), Browser 주소 도우미(2063–2124, 6개 구역이 씀), `BROWSER_*` 상수(19–24).
- 선택(시제품 안 함, 145줄): 팝업 가로채기 16478–16527, Browser 표시 크기 16550–16644(`spawnBrowserCard`만 씀). S1 '팝업 창 안전망·팝업 차단 표시'와 S6 '팝업 카드'가 여기라 같이 옮기기를 권한다.
- 바뀌는 코드: 14106·14129 카운터, `resetBrowserToolAuthority()` 추가(13421 뒤 4줄), Chat 연결 7581–7582·7967–7968의 두 줄씩 → `resetBrowserToolAuthority();`(지우는 순서 그대로: 번호 올림 → 마지막 동작 비움 → Map 비움). 사본에서는 범위를 한 덩어리로 만들려고 Map 9줄을 범위 앞으로, actor 등록을 범위 안으로 옮겼다.

(2) **경계**: deps 51개(상수·공유 모듈 6개·Map·Set 9개·core 함수). 내줌 14개: `spawnBrowserCard`, `browserCardState`, `registerBrowserToolSelection`, `attachBrowserToolTransport`, `revokeBrowserToolRunImmediately`, `browserToolSelectedSources`, `resolveBrowserCard`, `browserCardControl`, `browserToolDispatch`, `browserToolAuthorizePhysicalAction`, `browserToolFixtureActionDiagnostic`, `browserToolFixtureObserveDiagnostic`, `resetBrowserToolAuthority`, `ensureBrowserAgentActor`. actor 모듈(`EGDeskBrowserAgentRuntimeChild/Parent.sys.mjs`)은 그대로 공유 전역이다(ActorManagerParent가 부른다). 승인 등록(`registerBrowserActionAuthorizer`)은 지금처럼 함수 안에서 `ChromeUtils.importESModule`(공유)로 부른다(R2).

(3) **시험 1줄**: transport 시험 틀(:937 다음)에 `resetBrowserToolAuthority` 흉내. transport 시험의 `between` 22쌍은 모두 한 구역 안이라 그대로 맞는다(Browser 도구→Browser 카드 경계 :18도 같은 파일에 같은 순서로 옮기므로 맞다). 고치기 전 1개 실패 → 고친 뒤 457/453/0/4(사본).

(4) **회귀**: 5장 + Chat 흐름 72(Browser transport 포함), browser-negative 픽스처(EGQ3: 11개 거부 각각 perform 증가 0), Browser 카드 열기·이동·메뉴·Chat에 붙이기, 팝업(옮겼다면). 옮김 그대로 검사로 다른 줄이 위 표의 줄뿐인지 확인한다.

(5) **열리는 줄**: **Browser 줄** — S6 전체(대화 단위 조작 허락 배지·확인 카드, 다중 카드, 팝업 카드, 카드별 계정, 사이트 계정 기억, 캡처 dispatch, 이동 가드 설치, iframe actor), S1의 Browser 쪽 남은 일(툴바 키보드·이름·한국어 상태, Browser 배지의 Agent 이름·얼굴, reconcile·hop·대화상자 화면). Browser CSS는 흩어져 있어(388–417, 1239–1846, 6443–6528, 7160–7180 근처) 처음엔 **새 규칙만** `EGDeskSurfaceBrowser.css`에 쓰고, 기존 규칙 옮기기는 겹침 검사 뒤에 한다. uc.js 약 12,900줄.

### 4단계 — Chat 활동·결과·입력

**시작 조건**: 3단계 뒤, S3 전.

(1) **옮길 것**: 914–1946(1,040줄, `userInputDrafts` Map 한 줄만 core): `renderChatTaskBoard`·`renderChatPlanCard`(CHAT-06), 입력(`chatInputSourceForView`·`captureChatInputs`·`openChatInputPanel`·`buildChatInputTray`), 맥락 제안(CTX-03/04), 브리핑(`openAnswerBriefing`·`renderAnswerBriefing`), 입력 근거·결과 카드(`spawnInputEvidence`·`spawnResultCard`·`openResultCardSource`), Agent 질문(`codexUserInputBlock`), 하위 Agent(`codexSubAgentSection`), 활동 기록(`renderCodexActivityPanel`) → `EGDeskSurfaceChatActivity.mjs`. 바뀌는 코드: 1527·1566 카운터, `resetActivityPanelComposition()` 추가, Chat 연결 7976–7977 → 한 줄.

(2) **경계**: deps 39개, 내줌 18개(위 함수들 + `resetActivityPanelComposition`). Browser 구역의 `browserCardState`·`registerBrowserToolSelection`, Chat 카드의 `spawnCodexChatCard`는 이어주기로 받는다.

(3) **시험 1줄**: test:9785 결과 카드 `compileFunction`에 카운터 한 줄. 호출 횟수 시험(test:9764-9765)은 R5 덕에 그대로. 활동 기록 입력 중 처리 정규식(test:4368)은 본문이 같아 그대로.

(4) **회귀**: 5장 + Chat 흐름 72, 결과 카드·브리핑·작업 목록·계획 카드·활동 기록 열기.

(5) **열리는 줄**: **Chat 활동 줄** — S3의 다중 근거 강조·흐리게·의견 저장·배지(브리핑), 승인 카드·활동 행 '변경 보기'(1-D `EGDeskDiffView` 연결), 테스트·빌드 결과 카드(1-D `EGDeskRunResult`), 선택지 대기 버튼(1-W), 결과 카드 쪽 결과 줄. S1의 하위 Agent 행도 여기다. CSS는 CHAT-06(6913–7159), 활동 기록·CU-01(7369–7452), CHAT-08·CTX-03/04(7453–7583)가 파일 끝쪽 연속 덩어리라 옮기기 쉽다(겹침 검사 후). uc.js 약 11,900줄.

### 5단계 — Chat 연결 + Chat 대화

**시작 조건**: 4단계 뒤, Chat 대화 구역에 열린 수정이 없을 때(S2의 로그인·계정 칩 일 전후).

(1) **옮길 것**
- 5-A Chat 연결: `createCodexMessage` + `installCodexBridge` 7531–9728(2,196줄) → `EGDeskSurfaceChatBridge.mjs`. 준비: core에 `getCodexProfileCatalog`·`setCodexProfileCatalog`, 연결 쪽 4곳(8034·8036·8037·8873). 제스처 도우미 `installNativeGestureHelperBridge`(7471–7529)는 Canvas 쪽이라 core에 남긴다.
- 5-B Chat 대화: `mountCodexHUD` 6142–7469 + `toggleHUD`·`detachCodexChatFromHud`·`dockCodexChatToHud`·`visibleChatZoomRect`·`fitCodexChatCardToReadableViewport`·`spawnCodexChatCard` 9730–9994(합 1,592줄) → `EGDeskSurfaceChatView.mjs`. 준비: 두 범위를 붙이려고 제스처 도우미를 앞으로, `CHAT_ZOOM_GAP`(카메라 코드가 씀)은 core. 바뀌는 코드: 7166 catalog 읽기, 카운터 5곳(9738·9851·9856·9868·9937).

(2) **경계**: 연결↔대화 = `state.codexBridge` 동작 약 83개 + `subscribe`. 연결 deps 64개, 대화 deps 75개이며 대부분 core의 방 모델·방 도우미·글 도우미(61–913, 5884–6141)다. 이 공용 Chat 도우미는 core에 두고, 6단계 뒤 'Chat 공용' 파일로 뺄지 판단한다. 내줌: 연결 `installCodexBridge` 1개, 대화 6개(+`mountCodexHUD`는 안에서만 쓰여 이어주기 불필요).

(3) **시험**: 5-A 0줄. 5-B 2줄(test:3752 카운터, test:853 끝 표지). 사본: 둘 다 457/453/0/4.

(4) **회귀**: 5장 + Chat 흐름 72, UI 회귀 274, HUD↔Chat 카드 전환, 로그인 카드, 실제 대화 1회(Main 판단).

(5) **열리는 줄**: **Chat 대화·연결 줄** — S8 전체(멤버 칩·상태 요약, @ 자동완성·라우팅, Lead 계획 담당 표시, 메시지 보내기·안내 줄, '나를 불렀어요', 하위 Agent 개입 버튼), S2의 계정 칩 popover·로그아웃 경고·코드 입력 로그인·Claude 상태 줄, S9의 Claude 엔진 화면·로그인 버튼·종량 배지·한도 버튼, S1의 방 목록 아바타·Agent 상태 묶음. 2-R·2-E helper를 화면에 잇는 일도 이 줄이다. uc.js 약 8,140줄.

### 6단계 — Canvas·Board·Desk 저장 (시제품 먼저)

- **대상**: Board 저장·버전·복원·닫기 2239–3609(1,371줄), 상단 검색 3610–4185(576)·Board 전환 4186–4489(304), 미니맵 4855–5330(476), Canvas 도형 10453–10673(221), 의미 확대·카메라 16647–17672(1,026), Desk 저장·휴대 묶음·기록·복구 17674–18403(730).
- **어려운 점**: Board 저장 구역이 41개 이름을 16개 구역에 내준다. 여러 곳이 쓰는 작은 도구(`boardNotice`·`cloneJson`·`persistentEntityGeometry`·`parsePxNumber`·`serializeShapeState`)는 core의 공용 도구 자리에 둔다. 함수가 아닌 공유 값(`recentBoardProjectionIds`, `boardCloseRequests`, `boardCloseInFlight`, `boardHistory`, `deskHistory`)과 `let`(`boardRegionMenu`, `deskMenu`, `deskSaveTimer`, `portable*` 4개, `deskRecoveryStore`, `deskStoreSyncRef`) 정리가 먼저다.
- **방법**: 1~5단계에 쓴 도구로 사본에 먼저 적용해 실패 목록을 받고(각 단계 몇 분), 그 목록으로 작업자 지시문을 쓴다.
- **열리는 줄**: **Canvas·Board 줄**(S4 미니맵·Esc 층·접기·집중 보기·opener 옆 배치, S7 Board 소속·맞춤·실행 취소·정리·AI 표식 레이어·메모 카드 — 1-L `EGDeskCanvasLayout`·`EGDeskLayerStack`, 1-N `EGDeskAnnotationState`·`EGDeskMemoState` 연결), **Desk 저장 줄**(S10 방별 Agent 복원·묶음 패널·Board 병합 화면). 남는 uc.js는 상태·공용 도구·카드 틀·껍데기·boot 약 3,500줄로, S5(토큰·키보드·툴팁, 1-F `EGDeskFocusNavigation`)의 공용 줄이 된다.

---

## 7. 분리 뒤 소유 규칙 (4.1에 더할 안)

| 파일 | 소유하는 줄 |
|---|---|
| `eg-desk-surface.uc.js`(core) + `eg-desk-surface.uc.css`(토큰·공용) + `EGDeskChatState`(프로토콜) + `egdesk-surface-state.test.mjs` | 공용 화면 줄(지금의 화면 차례를 이어받음). 다른 줄은 deps 이름 추가·이어주기 한 줄만 고칠 수 있고, 겹치면 Main이 합친다 |
| `surface/EGDeskSurfaceSettings.mjs`·`.css` + `EGDeskChatProfile/Engine/ComputerState` | 설정 줄 |
| `surface/EGDeskSurfaceBrowser.mjs`·`.css` + `EGDeskSurfaceBrowserState` + Browser actor Child/Parent | Browser 줄 |
| `surface/EGDeskSurfaceChatActivity.mjs`·`.css` + `EGDeskChatTask/ResultState` | Chat 활동 줄 |
| `surface/EGDeskSurfaceChatView.mjs`·`EGDeskSurfaceChatBridge.mjs`·`.css` | Chat 대화·연결 줄 |
| `surface/EGDeskSurfaceFileCard.mjs` + `EGDeskFileView` | 파일 창 줄 |
| `surface/EGDeskSurfaceOntology`·`Terminal` | 차례 없음(필요한 쪽이 고침) |
| 각 줄의 새 시험 | `scripts/egdesk-surface-<구역>.test.mjs` |

함께 고칠 것:
- `scripts/egdesk-chat-qa-profile.mjs:47-51`의 QA 지문 목록에 `resources/surface/*`를 더해 QA 결과에 구역 파일 해시가 남게 한다(1-Q 또는 Main).
- WM `file-map.json`에 새 파일과 소유 줄을 등록한다(Main → WM).

---

## 8. 하지 않는 것 · 위험 · 확인 필요

**하지 않는 것**
- 옮기면서 코드 정리·이름 바꾸기·구역 안 쪼개기를 하지 않는다(예: `mountCodexHUD`의 `render` 1,257줄을 방 목록/대화로 나누기). 옮김과 섞으면 "옮김 그대로 검사"가 불가능해진다. 쪼개기는 분리 뒤 각 줄이 자기 파일에서 한다.
- 번들러·빌드 단계를 더하지 않는다.
- 레퍼런스 코드를 복사하지 않는다(Zen·Floorp·fx-autoconfig 모두 MPL-2.0, 패턴만).

**위험**
- Firefox 158에서 `global: 'current'` import가 기대와 다를 수 있다 → 1단계 headless 확인. 대안은 구역 파일을 `Services.scriptloader.loadSubScript`로 창 전역에 붙이는 클래식 스크립트로 바꾸는 것(Zen의 같은 파일이 두 방식을 함께 쓴다, `ZenPreloadedScripts.js:13·64`). 1단계만 되돌리고 다시 정한다.
- 구역 CSS의 순서·명시도 → 2단계 스크린샷 비교, 덩어리마다 겹침 검사.
- 팝업 창에서도 `installSurfaceZones`가 돈다(정의만이라 비용 작음). S1의 boot 맨 앞 팝업 판별과 함께 boot 안으로 옮길지 S1이 정한다.
- 이어주기는 호출이 한 단계 늘어난다. 성능 영향은 무시할 만하다고 본다 [의견].
- 줄 번호는 계속 밀린다. 사본 도구는 함수 이름·배너로 범위를 찾는다.

**확인 필요**
1. `ChromeUtils.importESModule(url, { global: 'current' })`가 fx-autoconfig로 주입된 클래식 스크립트에서 창 전역으로 불리는지(1단계).
2. `loadSheetUsingURIString`로 붙인 구역 CSS가 주 CSS보다 뒤 순서인지, 같은 시트를 다시 붙이면 오류인지(2단계).
3. 창 모듈에서 `.sys.mjs`를 정적 import하면 두 번째 인스턴스가 생기는지 — R2로 피하므로 몰라도 진행할 수 있다.
4. live remount에서 구역 파일이 다시 평가되는지(5장 5번).

---

## 9. 부록

### 9.1 사본 시험 기록

- 사본: `apps/firefox-ui-demo`의 `overlay`·`scripts`를 복사하고 `helper`·`docs`는 링크(저장소는 건드리지 않음). 기준은 2026-10-24 13:54 작업 트리(uc.js·CSS·state test가 `d76bb67`과 같음).
- 시험: `node --test --test-reporter=tap` 5개 파일(state·transport·terminal-init·semantic-zoom·design-tokens).

| 단계 | 시험 고치기 전 | 고친 시험 줄 | 고친 뒤 | uc.js 줄 |
|---|---|---|---|---|
| 기준 | – | – | 457 / 453 통과 / 0 실패 / 4 todo | 18,652 |
| 1 | 0 실패(도우미 적용 후) · 도우미 없으면 6 실패 | 4 | 457 / 453 / 0 / 4 | 16,540 |
| 2-A CSS | 0 실패 | 22 | 457 / 453 / 0 / 4 | 16,550 |
| 2-B 설정 | 7 실패 | 5 | 457 / 453 / 0 / 4 | 15,784 |
| 3 Browser | 1 실패 | 1 | 457 / 453 / 0 / 4 | 12,901 |
| 4 Chat 활동 | 1 실패 | 1 | 457 / 453 / 0 / 4 | 11,889 |
| 5-A Chat 연결 | 0 실패 | 0 | 457 / 453 / 0 / 4 | 9,713 |
| 5-B Chat 대화 | 1 실패 | 2 | 457 / 453 / 0 / 4 | 8,143 |

- 옮김 그대로 검사(1단계): 원래 줄과 구역 파일 본문의 차이는 카운터 5줄뿐.
- 구역 파일 8개 모두: node import 됨, 가짜 deps로 factory 호출 됨, uc.js 최상위 이름을 deps 없이 쓰는 곳 0건(파서), 이어주기 44개 모두 내준 이름과 일치, 최상위 화살표 함수의 `this` 0건(Chat 연결의 `this` 16건은 돌려주는 API 객체의 메서드 안이라 의미가 같음).
- 시험 4개 4종 중 3종(4.3의 1·2·4)은 실패로 드러났고, 1종(끝 표지를 못 찾아 넓어지는 slice, test:853)은 실패 없이 느슨해졌다. 그래서 9.3 목록 확인을 단계 체크에 넣었다.
- 도구(세션 임시 폴더라 지워질 수 있음, 다음 작업자가 같은 세션이면 그대로 쓸 수 있다): `/private/tmp/claude-501/-Users-minsoocha-Projects-EG-Desk-Dev-Space/dac7ff27-92ee-4567-9d7f-546e39ec2742/scratchpad/split/`의 `transform-step1.mjs`, `transform-css.mjs`, `transform-add-zone.mjs`, `transform-browser-prep.mjs`, `transform-activity-prep.mjs`, `transform-bridge-prep.mjs`, `transform-view-prep.mjs`, `test-edits.py`, `chain.sh`, `freecheck.mjs`(구역 파일의 빈 이름 검사), `analyze.mjs`·`zones.mjs`·`inner.mjs`·`pairs.mjs`·`modgraph.mjs`(구조 분석). 결과: 같은 폴더 위 `chainA/*.tap`, `chainB/6-bridge.tap`, `chainD/7-view-b.tap`. 도구는 저장소 경로를 받으면 멈춘다. 분석 도구가 쓰는 `@babel/parser`는 루트의 간접 의존성이므로 저장소 시험에는 쓰지 않는다(지킴 시험은 node 내장만).

### 9.2 근거 위치

- 우리 코드: `apps/firefox-ui-demo/overlay/JS/eg-desk-surface.uc.js`(줄은 본문), `overlay/CSS/eg-desk-surface.uc.css:7`(@namespace)·`:6259-6264`(동작 줄이기), `overlay/resources/EGDeskBrowserAgentRuntimeParent.sys.mjs:3`, `overlay/resources/EGDeskMarkdown.sys.mjs:1`, `overlay/resources/EGDeskChatState.sys.mjs`(나눌 범위는 2-C).
- 설치·실행: `scripts/install.sh:251-253`, `scripts/install.bat:77-79`, `scripts/run-firefox-mcp-target.sh:56-58`, `scripts/run-firefox-mcp-target.mjs:98-106`, `scripts/run-egdesk-windows.mjs:171-183`, `scripts/egdesk-chat-qa-profile.mjs:47-51`.
- 시험: `scripts/egdesk-surface-state.test.mjs:30·853·3752·4741·4758·5120·5952·7630·9303·9559·9764·9785`, `scripts/egdesk-browser-tool-transport.test.mjs:10·11-37·937`, `scripts/egdesk-terminal-init.test.mjs:326`, `scripts/verify-semantic-zoom.test.mjs:8`, `scripts/egdesk-design-tokens.test.mjs:13`, `scripts/verify-firefox-mcp-ontology-card.mjs:171`, `scripts/verify-firefox-mcp-headless-ui-regression.mjs:84`.
- 레퍼런스(사본 `scratchpad/refs/`): `brw_fx-autoconfig/profile/chrome/utils/boot.sys.mjs:195-205·421-431·522-537`, `.../module_loader.mjs:16`, `.../chrome.manifest:4`, `brw_fx-autoconfig/readme.md:131-135·255-297·476-486`; `brw_zen-browser/src/zen/common/ZenPreloadedScripts.js:8-36`, `.../spaces/ZenSpaceManager.mjs:7-20`, `.../compact-mode/ZenCompactMode.mjs:64-70`; `brw_floorp/browser-features/chrome/common/panel-sidebar/index.ts:20-37`, `.../workspaces/index.ts:27-51`; `gecko-sparse/dom/chrome-webidl/ChromeUtils.webidl:505-549·1230-1266`; `gecko-release-files/nsIDOMWindowUtils.release.idl:1753-1791`.
- 중앙·headless 수치: 커밋 `9dbfa51` 메시지(central 515/515, headless chat flow 72/72, headless UI regression 274/274).

### 9.3 시험이 쓰는 경계 표지 중 구역 경계를 넘는 것 (단계마다 확인)

| 시험 위치 | 시작 → 끝 | 걸리는 단계 | 대응 |
|---|---|---|---|
| state test:4741 | `spawnSettingsCard(` → `\n  function resolveBrowserCard(` | 2 | 끝 표지를 `\n  return { spawnSettingsCard };`로 |
| state test:853 | `spawnCodexChatCard(` → 배너 `Canvas Entity: Browser Card`(실제로는 카드 틀 시작) | 5-B | 끝 표지를 `\n  }\n`로 |
| transport:18 | `attachBrowserToolTransport(` → `\n\n  function spawnBrowserCard(` | 3 | 같은 파일에 같은 순서로 옮기면 그대로(빈 줄 유지) |
| state test:5952 (CSS) | Terminal 배너 → Ontology 배너 | 2-A | `SURFACE_ZONE_SHEETS` 순서(Terminal, Ontology)를 지키거나 끝 표지 고침 |

나머지 구역 경계 안 쌍(state test 16쌍, transport 22쌍)은 파서로 확인했을 때 모두 한 구역 안이다.
