# 007. Firefox Shell over Electron — Platform Pivot

**Status**: Decided
**Date**: 2026-04-17 (Decided 2026-04-17 — 유저 승인)
**Deciders**: Session Lead, User
**Related SPEC**: `ideas/confirmed/FIREFOX_SHELL_STRATEGY.md` (전략 PRD), `ideas/confirmed/FIREFOX_SHELL_ROADMAP.md` (phase plan)
**Related ADR**:
- **Amends**: ADR-003 (Electron Sidebar Drag-Resize UX) — UX 패턴은 유효, 구현 경로는 Firefox chrome JS 로 전환
- **Implementation note**: ADR-006 (Canvas Entity Foundation) — Entity 모델은 유효, `<browser>` XUL 엘리먼트 기반으로 구현
- **Not affected**: ADR-001, 002, 004, 005 (엔진 독립적 UX/design/라이선스)
- **Supersedes (doc level)**: `ideas/confirmed/AGENT_BROWSER_PROTOCOL_INTEGRATION.md` (ABP = Chromium fork, engine 불일치), `ideas/confirmed/UNIFIED_BROWSER_AUTOMATION_API.md` (CDP wrapper 층 불필요)

---

## Context

EG-Desk 는 지금까지 Electron 기반 desktop workspace app 으로 구현돼 왔다:

- `src/main/` — Electron main process
- `src/renderer/` — Chromium renderer
- `docs/browser-canvas-osr-poc-2026-04-15.md` — OSR + shared texture 로 "브라우저를 캔버스 카드 안에 넣는" POC
- `ideas/confirmed/AGENT_BROWSER_PROTOCOL_INTEGRATION.md` — Chromium fork (ABP) 로 agent-aware engine 도입 계획

그 과정에서 드러난 근본 한계:

### 한계 1 — Canvas 안에 실제 브라우저 UX 넣기 어려움

OSR POC (2026-04-15) 결론:
- `OSR + shared texture` 가 최선 live-canvas 경로이나
- **popup, IME (한글), file chooser, focus ring, DevTools** 를 canvas 내부에 렌더하기가 호스트 컴포지터 수준 문제
- "canvas 에 브라우저" 와 "real browser UX" 는 Electron 이 동시 제공 불가

### 한계 2 — Agent 가 "웹페이지 안" 과 "OS" 양쪽에 동시 거주하기 어려움

Electron 모델:
- Main = Node (OS 접근) / Renderer = Chromium (웹). **서로 분리된 프로세스**.
- Agent 가 웹페이지 DOM 을 직접 조작하려면 `webContents.executeJavaScript` + `contextBridge` 등 **여러 IPC 홉 필요**.
- Renderer sandbox 때문에 **agent 가 OS 에 직접 접근 불가** — 매번 main 경유.

EG-Desk 의 비전 (agent + canvas + browser entity) 에서 agent 는 "브라우저 내부 DOM + OS + canvas UI" 세 영역에 자유 접근해야 한다. Electron 의 프로세스 경계가 이를 어렵게 만든다.

### 한계 3 — ABP 경로의 비용

Chromium fork + agent HTTP server 엔진 내장 (`ideas/confirmed/AGENT_BROWSER_PROTOCOL_INTEGRATION.md`) 은:
- Chromium 빌드 인프라 필요 (수 시간/일 단위 빌드, 복잡한 toolchain)
- Chromium rebase 부담 (매 릴리즈 patch conflict)
- 별개 브라우저 제품 → 원래 Electron workspace app 맥락에서 이질적

### 한계 4 — 사용자 프라이버시 + 엔진 다변화 가치

Chromium 독점 엔진 생태계에서 **Gecko-based 제품** 이 전략적 가치 (Firefox 사용자 base, MPL 라이선스, Mozilla 의 지속적 보안 패치 수혜).

---

## 대안 발견 — Firefox chrome JS 기반 shell

2026-04-17 `apps/firefox-ui-demo/` POC 를 통해 검증:

- Firefox 의 `browser.xhtml` (chrome document) 은 **XHTML + privileged JavaScript** — `fx-autoconfig` (MrOtherGuy) 로 runtime injection 가능
- Chrome JS 는 **OS 권한 + DOM 접근 동시** 보유 — agent 가 두 영역 자유 왕래
- XUL `<browser>` 엘리먼트로 canvas card 에 **실제 웹페이지 렌더** — Firefox native content process 사용
- `window.browserDOMWindow` override 로 popup/`window.open` 을 card 로 라우팅
- `Subprocess.sys.mjs` 로 임의 바이너리 (node/bun/rust helper) spawn — mini-app 생태계 구현 가능
- `IOUtils`, `PathUtils`, `Services.*` 로 OS 기능 대부분 커버 (fs ~90% 동등)

POC 산출물: `apps/firefox-ui-demo/` — 4-Edge Framework (Desk Rail / Dock / Preset Bag / Contextual HUD) + canvas pan/zoom + Browser entity card + popup capture 전부 작동 확인.

---

## Options Considered

### A. Electron 유지 + OSR 경로 지속

**Pros**:
- 기존 코드베이스 / 팀 경험 / npm 생태계 그대로
- Node native addon 인-프로세스 로드 (better-sqlite3, node-pty 등)
- 성숙한 배포 도구 (electron-builder, electron-updater)

**Cons**:
- OSR POC 의 popup/IME/focus 한계 해결 불가
- Agent-DOM-OS 삼각 접근 제약 (IPC 홉)
- Chromium 엔진 독점 의존

**Verdict**: 거절. OSR 한계가 EG-Desk 핵심 UX (spatial canvas + real browser entity) 를 근본 차단.

### B. Electron + ABP (Chromium fork)

**Pros**:
- ABP 엔진 레벨 기능 (settled boundary, composited hit test, 자동 스크린샷)
- Agent-first 브라우저 비전과 정렬
- Mind2Web 90.53% 벤치마크 검증

**Cons**:
- Chromium 빌드 인프라 + rebase 비용 높음
- "workspace app" 이 아닌 "custom browser product" 로 포지셔닝 이탈
- Host shell (Electron) 과 engine (ABP) 두 층 모두 유지

**Verdict**: 보류. ABP 철학 (agent-aware engine) 은 유효하나 현 단계 ROI 낮음. 향후 필요시 WASM 으로 일부 이식 또는 Path 3 Firefox fork 에서 Gecko patch 로 재도입 가능.

### C. Firefox chrome JS shell (선택)

**Pros**:
- Chrome JS 가 privileged context — agent 가 DOM + OS 동시 자연 접근
- `apps/firefox-ui-demo/` 로 기술 feasibility 증명 완료 (zero-build runtime injection)
- Gecko 엔진 (Chromium 대체 다양성), Mozilla 보안 패치 자동 수혜
- Escalation path (Path 1 → 2 → 2+WASM → 3) 각 단계가 compound, 투자 보존
- ABP 가 외부 HTTP 로 노출한 기능 상당수를 chrome JS 내부 API 로 직접 (IPC 불필요)

**Cons**:
- Node 생태계 직접 사용 불가 (SpiderMonkey ≠ V8). `.node` native 모듈 subprocess 로 우회
- Firefox 를 "app shell" 로 쓰는 선례 희소 (Zen/Floorp 는 브라우저, 우리는 workspace app)
- 개발자 풀 작음 (chrome JS / XPCOM 경험자)
- "나만의 Electron-on-Gecko" 를 점진 구축해야 — Electron 이 무료로 주는 것 (IPC bridge, 패키징, 업데이트) 을 우리가 만듦

**Verdict**: 채택.

### D. Tauri / Neutralino (Rust + 시스템 WebView)

**Pros**:
- 작은 바이너리, 빠른 시동
- Rust native + 웹 UI

**Cons**:
- 시스템 WebView 의존 (macOS WebKit, Windows WebView2) — 일관성 부족
- Agent 가 웹 DOM 과 Rust 양쪽 접근하려면 여전히 IPC 필요
- EG-Desk 의 canvas + browser entity 비전엔 Tauri 의 "작은 창 하나" 모델이 어색

**Verdict**: 거절. Architecture 철학은 참고하나 EG-Desk 니즈엔 부적합.

### E. Servo / 자체 엔진

**Pros**: 완전 커스텀

**Cons**: Servo embedding 실험 단계, 수년 단위 투자

**Verdict**: 거절. 현실성 낮음.

---

## Decision

**EG-Desk 는 Electron 에서 Firefox chrome JS shell 로 전환한다.** 점진적 경로:

- **Path 1 (POC, 현재)**: `apps/firefox-ui-demo/` fx-autoconfig runtime injection. 기술 증명 완료.
- **Path 2 (Alpha, 2~3주)**: Portable 재패키징 — Firefox 바이너리 + 우리 chrome JS + 번들 node/bun + Rust helper 를 단일 앱 (`EGDesk.exe` / `EGDesk.app` / `EGDesk.AppImage`) 으로 배포. 브랜드 리브랜딩 (Mozilla trademark 규정 준수 — 앱명 `EGDesk`, "Built on Mozilla Firefox" 고지).
- **Path 2 + WASM (점진적)**: 연산 헤비 기능 (vector search, syntax parser, image/audio DSP) 을 Rust → WASM 으로 in-process 추가. WebSocket IPC 회피.
- **Path 3 (Beta/GA, 필요시)**: Surfer 기반 Firefox fork + Gecko patch. 구조적 UX 변경, 브랜드 완전 독립, 자체 업데이트 채널.

---

## Consequences

### 아키텍처 — 신규

```
EG-Desk 앱 (Firefox 기반)
  ├─ chrome JS layer (privileged, SpiderMonkey)
  │   ├─ 4-Edge Framework UI (Desk Rail / Dock / Preset Bag / Contextual HUD)
  │   ├─ Canvas pan/zoom + entity 카드 관리
  │   ├─ Agent orchestration (OS + DOM 동시 접근)
  │   └─ Subprocess / IOUtils / Services.* 직접 호출
  │
  ├─ WASM layer (in-process native-speed)
  │   └─ 연산 헤비 모듈 (Rust → wasm32)
  │
  ├─ egdesk-helper (Rust 바이너리, Subprocess spawn, WebSocket IPC)
  │   ├─ PTY (portable-pty)
  │   ├─ Tray / hotkey / file-watch
  │   └─ 기타 OS-deep 기능
  │
  ├─ Mini-apps (npm/node/bun, localhost HTTP)
  │   └─ 각 mini-app = 별개 프로세스, canvas card 가 localhost:PORT 로 로드
  │
  └─ XUL <browser> canvas cards
      └─ 각 카드 = 독립 content process, 웹 엔트리 또는 mini-app UI 렌더
```

### 기존 코드베이스

- **Electron src/ 는 deprecate** — 단계적 이관, 즉시 삭제 안 함
- **기존 chrome JS 자산 없음** — `apps/firefox-ui-demo/` 가 baseline
- **React 컴포넌트 중 pure UI (agent chat, preset 카드 등)** 는 mini-app 또는 canvas card 내부 content 로 이관 가능

### 문서

- 이 ADR 과 연관된 **Amend / Supersede / Update** 문서 리스트는 `ideas/confirmed/FIREFOX_SHELL_STRATEGY.md` 의 "문서 재정렬" 섹션 참조
- 기존 Electron/ABP 문서는 **archive 하지 않고 supersede 배너** 부착 후 in-place 보존 (축적된 지식 가치)

### ADR amendments

- **ADR-003 (Electron Sidebar Drag-Resize UX)** — UX 패턴 (4-Edge Framework) 은 유효. 구현 경로는 Firefox chrome JS 로 전환. 별도 후속 ADR 필요시 amend
- **ADR-006 (Canvas Entity Foundation)** — Entity 모델 유효. Implementation 은 XUL `<browser>` 기반. 세부 구현 문서 `apps/firefox-ui-demo/overlay/JS/eg-desk-surface.uc.js::spawnBrowserCard()` 참조

### 팀 / 일정 영향

- Rust 경험자 또는 학습 계획 필요 (egdesk-helper 바이너리)
- Firefox chrome JS 학습 곡선 (JSActor, XPCOM, IOUtils 등)
- 단기 shipping 속도 저하 (ecosystem/tooling 구축) → 장기적으로 Electron 탈출 + Gecko 독립성

### 리스크

| 리스크 | 완화 |
|--------|------|
| Firefox API 변경으로 chrome JS 깨짐 | Firefox ESR 채널 사용 (보수적 업데이트), Path 2 재패키징 시 smoke test |
| fx-autoconfig (MrOtherGuy) 유지보수 중단 | 코드 내재화 가능 (<500 LOC). 최악의 경우 자체 loader 작성 |
| Mozilla trademark 제약 | 앱명 `EGDesk` 단독 사용, "Built on Mozilla Firefox" 고지. Path 3 fork 시 전면 리브랜딩 |
| Node ecosystem 호환성 (일부 라이브러리 WASM 불가) | 해당 기능은 helper 바이너리 또는 mini-app 경유 |
| 개발자 onboarding 비용 | Phase C 문서 중 `FIREFOX_CHROME_JS_PATTERNS.md` 에 일반적 패턴 축적 |

---

## References

- `apps/firefox-ui-demo/README.md` — POC 개요
- `apps/firefox-ui-demo/docs/RESEARCH.md` — Firefox UI 커스터마이징 경로 조사 (autoconfig vs fork-and-patch vs GeckoView 등)
- `docs/browser-canvas-osr-poc-2026-04-15.md` — 이전 Electron OSR POC postmortem
- [MrOtherGuy/fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) — Runtime injection loader
- [zen-browser/surfer](https://github.com/zen-browser/surfer) — Path 3 빌드 툴
- [Subprocess.sys.mjs](https://searchfox.org/mozilla-central/source/toolkit/modules/subprocess/Subprocess.sys.mjs) — 프로세스 spawn API
- [IOUtils.webidl](https://searchfox.org/mozilla-central/source/dom/chrome-webidl/IOUtils.webidl) — 파일 I/O API
- [Mozilla Trademark Policy](https://www.mozilla.org/en-US/foundation/trademarks/policy/) — 리브랜딩 규정
