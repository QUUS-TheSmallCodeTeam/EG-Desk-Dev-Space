# firefox-ui-demo

> **2026-04-17 Platform pivot 확정**: 본 데모가 EG-Desk 의 Electron → Firefox shell 전환을 증명하는 **Path 1 POC** 로 공식화됨.
> - 결정: [`ADR-007`](../../.claude/docs/decisions/007-firefox-shell-over-electron.md)
> - 전략: [`FIREFOX_SHELL_STRATEGY.md`](../../ideas/confirmed/FIREFOX_SHELL_STRATEGY.md)
> - 로드맵: [`FIREFOX_SHELL_ROADMAP.md`](../../ideas/confirmed/FIREFOX_SHELL_ROADMAP.md)
> - 현재 안정화 gate: [`docs/PATH_1_5_STABILIZATION.md`](./docs/PATH_1_5_STABILIZATION.md)
> - Chat design grammar: [`docs/CHAT_DESIGN_GRAMMAR_V1.md`](./docs/CHAT_DESIGN_GRAMMAR_V1.md)
> - Chat/canvas/agent UX model: [`docs/CHAT_CANVAS_AGENT_LAYER_MODEL.md`](./docs/CHAT_CANVAS_AGENT_LAYER_MODEL.md)
> - [Desk/Board/Card runtime model](./docs/DESK_AGENDA_CARD_RUNTIME_MODEL.md)
> - AI canvas annotation layer: [`docs/AI_CANVAS_ANNOTATION_LAYER.md`](./docs/AI_CANVAS_ANNOTATION_LAYER.md)
> - Legacy canvas Run Playback note (superseded by Answer Briefing in the Contract/Atlas): [`docs/CANVAS_RUN_PLAYBACK_MODEL.md`](./docs/CANVAS_RUN_PLAYBACK_MODEL.md)
> - Viewport layout/interaction model: [`docs/VIEWPORT_LAYOUT_INTERACTION_MODEL.md`](./docs/VIEWPORT_LAYOUT_INTERACTION_MODEL.md)
> - Ontology canvas rendering: [`docs/ONTOLOGY_CANVAS_RENDERING.md`](./docs/ONTOLOGY_CANVAS_RENDERING.md)

**Firefox를 EG-Desk의 UI 캔버스로 쓸 수 있는가?** 에 대한 실제 동작 데모.

Electron browser-in-canvas POC (`docs/browser-canvas-osr-poc-2026-04-15.md`)는 OSR + shared texture까지 갔지만 popup / IME / file chooser / focus 같은 "진짜 브라우저 UX"를 canvas 안에 복제하는 건 근본적으로 호스트 컴포지터 문제라서 막혔다. 이 데모는 **정반대 접근** — 브라우저를 canvas 안에 집어넣는 대신, **브라우저 자체를 우리 UI로 재프로그래밍**한다.

## 핵심 아이디어

Firefox의 브라우저 chrome (`browser.xhtml`)은 **실제로 XHTML + JavaScript** 다. Firefox 70+부터 XUL이 HTML로 바뀌면서 브라우저 UI가 일반 DOM이 됐다. `autoconfig` 메커니즘 + `userChrome.js` 로더를 통해 이 DOM에 임의 JS를 주입할 수 있다. 주입된 JS는 `document.documentElement` 부터 시작해서 **툴바를 숨기고, 사이드바를 그리고, 탭을 재구성**할 수 있다 — 그러면서도 popup, IME, 확장, DevTools, 프로필, 비밀번호 관리, WebRTC 등 **full browser capabilities는 그대로 유지**된다. Gecko 코어는 건드리지 않기 때문.

Zen Browser가 하는 "workspaces + 수직 탭 + split view" UX도 같은 원리 — 차이는 Zen이 Firefox를 **fork해서 다시 빌드**하는 반면 (공식 Surfer 빌드 툴), 이 데모는 **Firefox 바이너리는 그대로 두고 runtime에 주입**한다는 것. Zero-build, 5분.

## 디렉터리 구조

```
apps/firefox-ui-demo/
├── README.md                 ← 이 파일
├── scripts/
│   ├── install.bat           Windows 설치 스크립트
│   ├── install.sh            macOS/Linux 설치 스크립트
│   └── uninstall.sh
├── overlay/                  우리의 커스텀 UI (fx-autoconfig 로더가 여기 파일을 읽음)
│   ├── JS/
│   │   ├── eg-desk-banner.uc.js      상단 banner (sanity check)
│   │   └── eg-desk-sidebar.uc.js     좌측 workspace sidebar (핵심 데모)
│   └── CSS/
│       └── eg-desk-demo.uc.css
└── docs/
    ├── RESEARCH.md           경로 조사 요약 (autoconfig vs fork vs GeckoView)
    └── CODEX_HUD_DESIGN_V1.md Codex Chat HUD 상세 UX/기능 설계
```

## 실행 방법 (Windows)

**사전 준비**: Firefox Desktop 설치 (Stable 110+ 또는 ESR). 관리자 권한 필요 (인스톨 디렉터리에 bootstrap 파일을 복사하므로).

```bash
cd apps/firefox-ui-demo/scripts
# 관리자 cmd에서:
install.bat
```

`install.bat`은 다음을 수행한다:

1. Firefox 인스톨 디렉터리 탐지 (`C:\Program Files\Mozilla Firefox\`)
2. Firefox 프로필 디렉터리 탐지 (`%APPDATA%\Mozilla\Firefox\Profiles\*.default-release`)
3. [MrOtherGuy/fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) clone (github.com 접근 필요)
4. `program/config.js` + `defaults/pref/config-prefs.js` → Firefox 인스톨 디렉터리
5. `profile/chrome/` → Firefox 프로필의 `chrome/` 폴더
6. 우리의 `overlay/JS/*.uc.js` + `overlay/CSS/*.uc.css` → `chrome/JS/` + `chrome/CSS/`

설치 완료 후:

1. Firefox 실행
2. 주소창에 `about:support` 입력
3. "Clear startup cache…" 버튼 클릭 → Firefox 재시작
4. 브라우저 상단에 분홍색 `EG-DESK UI ACTIVE` 배너 + 좌측에 workspace sidebar가 표시되면 성공

## 실행 방법 (macOS / Linux)

```bash
cd apps/firefox-ui-demo/scripts
sudo ./install.sh       # macOS: /Applications/Firefox.app/Contents/Resources
                        # Linux: /usr/lib/firefox 또는 /opt/firefox
```

### macOS gesture helper prototype

트랙패드 `gesture begin/end` latency 를 보기 위한 macOS 전용 helper 프로토타입도 포함되어 있다.

```bash
cd apps/firefox-ui-demo/scripts
./run-macos-gesture-helper.sh
```

helper 는 `http://127.0.0.1:39217/events` 로 SSE를 열고, overlay 는 여기에 연결해 `gestureScrollBegin / gestureScrollEnd` 와 latency 를 표시한다.

### Codex Chat HUD design

Firefox HUD 에 붙는 Codex chat 의 상세 화면/상태/행동 규칙은 아래 문서를 기준으로 한다.

- [`docs/CHAT_DESIGN_GRAMMAR_V1.md`](./docs/CHAT_DESIGN_GRAMMAR_V1.md)
- [`docs/CODEX_HUD_DESIGN_V1.md`](./docs/CODEX_HUD_DESIGN_V1.md)

## 제거

```bash
# Windows (관리자 cmd)
cd apps\firefox-ui-demo\scripts
uninstall.bat

# macOS/Linux
sudo ./uninstall.sh
```

## 데모에서 실제로 보는 것

- **상단 배너**: `EG-DESK UI ACTIVE` — autoconfig가 브라우저 chrome DOM에 접근할 수 있다는 sanity check
- **좌측 사이드바** (300px): 세 개의 workspace (`Work`, `Research`, `Personal`) 탭. 클릭하면 현재 창의 탭들이 필터링 애니메이션으로 재배치됨 — Zen Browser의 workspaces UX를 runtime injection으로 구현
- **기본 tab strip 숨김**: `#TabsToolbar { display: none }` 으로 상단 탭 바를 제거하고 사이드바에 탭 목록을 직접 렌더
- **`gBrowser` 제어**: Firefox 내부 API 그대로 호출 (`gBrowser.selectedTab`, `gBrowser.addTab(url)`) — 우리가 만든 사이드바가 진짜 탭 제어를 함

## 검증 체크리스트 (full browser capabilities 유지)

설치 후 다음이 그대로 작동해야 한다:

- [ ] 우클릭 컨텍스트 메뉴
- [ ] 파일 업로드 다이얼로그 (ex: Gmail 첨부)
- [ ] 한글 IME (ex: `한`-영 전환)
- [ ] 비밀번호 저장 프롬프트
- [ ] 확장 프로그램 (uBlock Origin 같은 것)
- [ ] DevTools (F12)
- [ ] WebRTC (Google Meet 같은 것)
- [ ] `about:config`, `about:addons`

이 중 하나라도 깨지면 우리 JS가 너무 공격적으로 DOM을 수정한 것 — `eg-desk-sidebar.uc.js`에서 `#TabsToolbar.remove()` 대신 `display: none`을 쓰는 이유.

## EG-Desk 본체와의 관계

이 데모는 **Electron 본체를 대체하자는 제안이 아니다**. EG-Desk의 agent / workspace / canvas 로직은 Electron에 남는다. 다만 "브라우저를 캔버스 안에 띄운다" 같은 UX 시나리오에서 OSR shared texture 경로가 해결 못 하는 문제들 (popup, IME, file chooser)이 있었다. 이 데모는 대안 아키텍처의 가능성을 보여주는 것:

- **Option A** (현재): Electron이 host + canvas, 브라우저는 OSR 텍스처로 그린다 → 제약 많음
- **Option B** (이 데모): Firefox 바이너리가 host + UI, EG-Desk agents는 Firefox chrome에 주입된 JS로 동작 → capabilities 그대로, 다만 Electron 기반 기능 중 Firefox에서 안 되는 게 있을 수 있음
- **Option C** (Zen 방식): Firefox fork해서 빌드 → 가장 강력하지만 CI 복잡도 급증, Firefox 업데이트 따라가기 필요

결정은 안 났다. 이 데모는 **Option B의 기술적 가능성**만 증명한다.

## 레퍼런스

- [MrOtherGuy/fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) — 이 데모의 로더
- [aminomancer/uc.css.js](https://github.com/aminomancer/uc.css.js) — 대규모 chrome UI 재작성 예시
- [xiaoxiaoflood/firefox-scripts](https://github.com/xiaoxiaoflood/firefox-scripts) — 수십 개의 .uc.js 예시
- [zen-browser/desktop](https://github.com/zen-browser/desktop) — fork-and-patch reference
- [Mozilla Support - AutoConfig](https://support.mozilla.org/en-US/kb/customizing-firefox-using-autoconfig) — 공식 문서

세부 조사 결과는 `docs/RESEARCH.md` 참고.
