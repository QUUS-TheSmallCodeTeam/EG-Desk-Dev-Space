# Firefox Shell Strategy

**작성일**: 2026-04-17
**상태**: Confirmed — 플랫폼 pivot 결정 (ADR-007)
**관련 ADR**: [007-firefox-shell-over-electron](../../.claude/docs/decisions/007-firefox-shell-over-electron.md)
**관련 문서**:
- `FIREFOX_SHELL_ROADMAP.md` — phase 별 실행 계획
- `apps/firefox-ui-demo/` — Path 1 POC 산출물
- `apps/firefox-ui-demo/docs/RESEARCH.md` — 경로 조사 원본

---

## 한 줄 요약

EG-Desk 는 Electron + Chromium 기반에서 **Firefox chrome JS shell** 로 전환한다. 이유: canvas 안에 real browser UX 를 넣는 게 OSR POC 에서 근본 차단됐고, Firefox chrome JS 는 privileged context 라 agent 가 OS + DOM 에 동시 자연 접근 가능하다. 단계: Path 1 (POC, 현재) → Path 2 (Portable 재패키징, Alpha) → Path 2+WASM (연산 헤비) → Path 3 (Firefox fork, Beta).

---

## Why — 왜 이 전환이 필요한가

### 1. Electron 으로 막힌 벽

`docs/browser-canvas-osr-poc-2026-04-15.md` 결론:

- **OSR + shared texture** 로 브라우저 프레임을 캔버스에 그리는 데 성공
- 그러나 **popup, IME (한글), file chooser, focus ring, DevTools** 같은 "진짜 브라우저 UX" 는 호스트 컴포지터 문제라 canvas 안에 못 넣음
- "Spatial canvas 에 놓인 real browser entity" 가 EG-Desk 핵심 UX 인데, 이 벽을 Electron 으로는 못 뚫음

### 2. Agent 삼각 접근의 근본 제약

EG-Desk agent 는 세 영역에 자유 접근해야 한다:

1. **웹페이지 DOM** — browsing entity 내용 조작, 폼 채우기, 스크립트 평가
2. **OS** — 파일, 프로세스, 네트워크
3. **Canvas UI** — 4-Edge, entity 카드, state

Electron 에서 이 셋은 **각기 다른 프로세스 경계** 에 있다:
- Node (main) ↔ Chromium renderer ↔ 웹페이지 content process
- Agent 가 웹페이지 DOM 조작하려면 `webContents.executeJavaScript` + `contextBridge` 홉 여러 번
- Sandbox 때문에 agent 가 OS 에 직접 접근 못 함 — 매번 main 경유

Firefox chrome JS 에선 **하나의 privileged context 에서 셋 모두 직접 접근**. JSActor 로 content 와 1-hop 소통, `Services.*` 로 OS, 같은 문서에서 canvas UI DOM 조작. Agent 의 "손" 이 짧아짐.

### 3. ABP (Chromium fork) 경로의 ROI 불일치

`AGENT_BROWSER_PROTOCOL_INTEGRATION.md` 의 ABP 는 기술적으로 멋지나:

- Chromium 빌드 인프라 (수십 GB, 수 시간 빌드)
- Chromium rebase 부담
- "workspace app" 이 아닌 "custom browser product" 포지션 — EG-Desk 정체성과 어긋남

Firefox shell 은 ABP 가 제공하려던 "agent-aware capability" 의 **상당 부분을 chrome JS 내부 API 로 직접** 획득한다 — HTTP 서버 층 없이.

### 4. 엔진 다변화 전략 가치

Chromium 독점 생태계에서 Gecko-based 제품 = 엔진 다변화 기여 + Mozilla 보안 패치 자동 수혜 + MPL 라이선스 안정성.

---

## What — 어떻게 작동하는가

### 레이어 구조

```
EG-Desk 앱 (Firefox 바이너리 기반)
│
├─ Layer 1: chrome JS (privileged, SpiderMonkey)
│   ├─ 4-Edge Framework UI (Desk Rail / Dock / Preset Bag / Contextual HUD)
│   ├─ Canvas pan/zoom + entity 카드 관리
│   ├─ Agent orchestration (OS + DOM 동시 접근 가능한 유일한 층)
│   ├─ State, config, 세션
│   └─ IPC 관리 (helper, mini-apps, WASM 모듈)
│
├─ Layer 2: WASM in-process (연산 헤비)
│   ├─ Vector search (embedding similarity)
│   ├─ Syntax parser (tree-sitter-wasm)
│   ├─ Image / audio DSP
│   └─ Cryptography, compression
│
├─ Layer 3: egdesk-helper (단일 Rust 바이너리, WebSocket IPC)
│   ├─ PTY (portable-pty crate)
│   ├─ System tray (tray-icon crate)
│   ├─ Global hotkey (global-hotkey crate)
│   ├─ File watcher (notify crate)
│   └─ 기타 OS-deep 기능
│
├─ Layer 4: Mini-apps (npm/node/bun, 각각 별 프로세스)
│   ├─ Manifest 기반 설치/라이프사이클
│   ├─ localhost HTTP/WS 로 chrome JS 와 통신
│   └─ Canvas card 가 localhost:PORT 렌더
│
└─ Layer 5: XUL <browser> canvas cards
    ├─ 실제 웹 브라우징 (각 카드 = 독립 content process)
    ├─ Mini-app UI 호스팅
    └─ Popup capture 로 window.open 도 카드로 라우팅
```

### 층별 담당 원칙

| 니즈 | 담당 레이어 | 이유 |
|------|-------------|------|
| UI 렌더, agent 로직 | Layer 1 | privileged + DOM 직접. 근본 UX |
| 파일 I/O, 프로세스 spawn, 네트워크 | Layer 1 (`IOUtils`, `Subprocess`) | Firefox 내장 API 로 커버 |
| 고빈도 연산 (타이핑 중 파싱, vector lookup) | Layer 2 (WASM) | IPC 회피, near-native 속도 |
| OS GUI (tray, hotkey) / PTY | Layer 3 (helper) | Firefox 내장 없음, subprocess 필수 |
| 유저 앱 (kanban, todo, 외부 서비스) | Layer 4 (mini-app) | 의도된 격리, npm 생태계 활용 |
| 실제 웹 렌더 | Layer 5 (XUL browser) | Gecko content process |

### 기술 조합

| 요소 | 기술 |
|------|------|
| Browser shell | Firefox (Stable 또는 ESR) |
| Chrome JS 로더 | fx-autoconfig (MrOtherGuy) |
| 4-Edge UI 구현 | `eg-desk-surface.uc.js` (apps/firefox-ui-demo 에 baseline) |
| WASM 컴파일 | Rust + `wasm32-unknown-unknown` |
| Helper 바이너리 | Rust + tokio + portable-pty + tray-icon + notify |
| Mini-app 런타임 | 번들된 bun (또는 node) |
| Path 2 패키징 | 수동 재패키징 + NSIS/WiX/pkg/AppImage |
| Path 3 빌드 | Surfer (zen-browser 프로젝트) |
| 업데이트 | Path 2: 자체 updater / Path 3: AUS 프로토콜 + 자체 서버 |

---

## Paths — 단계적 실행 경로

각 path 는 이전 단계 산출물을 보존하며 증분 추가. 상세는 `FIREFOX_SHELL_ROADMAP.md` 참조.

### Path 1 — Runtime Injection POC (✅ 완료)

- 위치: `apps/firefox-ui-demo/`
- 기법: fx-autoconfig 를 사용자 PC 의 Firefox 에 설치
- 증명: 4-Edge + canvas + pan/zoom + Browser entity + popup capture 전부 작동
- 용도: 기술 가능성 증명, 디자인 탐색
- 시간: 투자 완료

### Path 2 — Portable 재패키징 (Alpha 배포)

- 변경: Firefox 바이너리 + 우리 overlay + 번들 bun + helper 를 **단일 앱** 으로 재패키징
- 결과물: `EGDesk.exe` / `EGDesk.app` / `EGDesk.AppImage` (사용자 PC 의 Firefox 불필요)
- 브랜드: 앱명 `EGDesk` 단독, "Built on Mozilla Firefox" 고지 (MPL + trademark 준수)
- 시간: 약 2~3 주 (브랜드 에셋, 인스톨러, 자체 updater 포함)
- 사용자: 초기 테스터 100명 수준

### Path 2 + WASM — 연산 레이어 추가 (점진)

- 변경: Rust 로 연산 헤비 모듈 (vector search, parser 등) 작성 → `wasm32` 컴파일 → chrome JS 에서 `WebAssembly.instantiateStreaming` 로 로드
- 필요시점: WebSocket IPC 가 실제 latency 병목이 될 때
- 시간: 모듈당 1주 × N (수요 발생 순서)

### Path 3 — Firefox Fork (Beta/GA)

- 변경: Surfer 로 Firefox 소스 fork, patches 로 `browser.xhtml` 구조적 수정, 브랜드 완전 독립
- 필요시점: runtime injection 으로 못 하는 구조적 UX 요구 발생 시 OR 완전 독립 브랜드 필요시
- 시간: 약 2~3 주 초기 + 지속 rebase 비용 (Firefox 월 1회 릴리즈 추적)
- 결과물: 자체 업데이트 서버, 자체 CI, 완전 독립 제품

**Zen Browser 가 Path 3 의 실제 레퍼런스.** 단 Zen 은 browser 제품이고 우리는 workspace app 이라 Gecko 수정 양은 더 작을 전망.

---

## 문서 재정렬 — Firefox 전환 ripple

### 신규 문서 (이번 작업)

| 경로 | 역할 |
|------|------|
| `.claude/docs/decisions/007-firefox-shell-over-electron.md` | 공식 ADR |
| `ideas/confirmed/FIREFOX_SHELL_STRATEGY.md` (이 문서) | 전략 PRD |
| `ideas/confirmed/FIREFOX_SHELL_ROADMAP.md` | Phase 별 실행 계획 |
| `ideas/brainstorming/EGDESK_HELPER_BINARY_SPEC.md` | Rust helper 설계 |
| `ideas/brainstorming/MINI_APP_ECOSYSTEM.md` | Mini-app 라이프사이클 / manifest |
| `ideas/brainstorming/FIREFOX_CHROME_JS_PATTERNS.md` | Chrome JS 개발 패턴 |
| `ideas/brainstorming/EGDESK_WASM_LAYER.md` | WASM in-process 전략 |

### Supersede 배너 (in-place 보존, archive 안 함)

- `ideas/confirmed/AGENT_BROWSER_PROTOCOL_INTEGRATION.md` — 엔진 불일치 (Chromium fork). ABP 철학은 향후 Path 3 Gecko patch 에서 일부 재도입 가능
- `ideas/confirmed/UNIFIED_BROWSER_AUTOMATION_API.md` — CDP wrapper 층이 chrome JS 직접 API 로 대체됨

### Update (섹션 교체 또는 Firefox shell 반영)

- `ideas/confirmed/CONTEXT_AWARE_BROWSER_AUTOMATION.md` — chrome JS 기반 구현으로 재작성
- `ideas/confirmed/technology-stack.md` — Electron entry 수정, Firefox / fx-autoconfig / Surfer / WASM / Rust helper 추가
- `ideas/confirmed/INFINITE_CANVAS_BROWSER_INTEGRATION.md` — XUL `<browser>` 카드 기반 업데이트
- `ideas/confirmed/AI_TERMINAL_CHAT_INTEGRATION.md` — helper + xterm.js + WebSocket 구조 반영
- `ideas/confirmed/EG-DESK_Spatial_Canvas_UX_Solutions.md` — Firefox chrome JS 전제 반영 (UX 본문 대부분 유효)
- `ideas/brainstorming/APP_RUNTIME_ARCHITECTURE.md` — Firefox 기반으로 재작성
- `ideas/brainstorming/BROWSER_ARCHITECTURE_RESEARCH.md` — `apps/firefox-ui-demo/docs/RESEARCH.md` 링크로 간소화
- `ideas/brainstorming/ELECTRON_MAIN_PROCESS_OBSERVABILITY.md` — Firefox 등가 (Browser Console / Services.obs) 섹션 추가

### Postmortem / 크로스 링크

- `docs/browser-canvas-osr-poc-2026-04-15.md` 하단에 "2026-04-17: Firefox shell 방향 전환. ADR-007 참조" 섹션
- `apps/firefox-ui-demo/README.md` 에 본 문서 링크
- `apps/firefox-ui-demo/docs/RESEARCH.md` 는 현재 위치 유지, 본 문서에서 canonical 참조

### ADR amendments

- **ADR-003** (Electron Sidebar Drag-Resize UX) — UX 패턴 유효, 구현 경로만 Firefox chrome JS. 제목 retroactive 변경 안 함 (히스토리 보존)
- **ADR-006** (Canvas Entity Foundation) — 모델 유효, Implementation = XUL `<browser>` + `spawnBrowserCard` (참조: `apps/firefox-ui-demo/overlay/JS/eg-desk-surface.uc.js`)

---

## Success Criteria

Path 2 Alpha 배포 시점까지:

- [ ] 단일 설치 파일 (`.exe` / `.dmg` / `.AppImage`) 로 사용자 PC 의 기존 Firefox 없이 실행
- [ ] 앱명 `EGDesk` 로 리브랜딩, Mozilla trademark 규정 준수 (audit 1회 통과)
- [ ] 4-Edge UI + canvas + Browser entity card 가 Path 1 동등 수준 작동
- [ ] 최소 3 개 mini-app (예: kanban, notes, browser entity) 번들 + 동작
- [ ] 전역 단축키 + tray + PTY 터미널 카드 모두 helper 경유로 작동
- [ ] 크래시 없이 8 시간 연속 사용 가능
- [ ] 메모리 사용량 2GB 이하 (기본 상태 + 카드 5 개)
- [ ] 시작 시간 (cold start) 5 초 이하
- [ ] 자체 updater 가 새 Firefox 버전 patch 배포 가능
- [ ] CI 에서 Windows / macOS / Linux 빌드 자동화

Path 3 Beta 로 승격 trigger:

- Runtime injection 으로 못 하는 UX 요구 3 개 이상 누적, 또는
- 완전 독립 브랜드 필요성 (Mozilla 명시 없이 배포), 또는
- Gecko patch 가 필요한 agent-native 기능 요청

---

## Risks & Mitigations

| 리스크 | 영향 | 완화 |
|--------|------|------|
| Firefox chrome API 변경으로 chrome JS 깨짐 | 배포 중단 | Firefox ESR 채널 사용 (보수적), CI smoke test |
| fx-autoconfig 유지보수 중단 | 로더 교체 | 코드 내재화 가능 (<500 LOC), 자체 loader fallback |
| Mozilla trademark 침해 판단 | 배포 금지 | 법무 리뷰, 초기 앱명 `EGDesk` 단독, brand guideline 문서화 |
| Node ecosystem 비호환 라이브러리 | 기능 누락 | WASM 변환 시도 → 실패시 helper 또는 mini-app 경유 |
| Firefox 업데이트 주기 추적 부담 | 보안 패치 지연 | ESR 채널 (주기 길음), 자동화 CI |
| 개발자 onboarding 비용 | 팀 확장 난이도 | `FIREFOX_CHROME_JS_PATTERNS.md` 문서화, 외부 컨설턴트 |
| "Electron-on-Gecko 를 다시 만드는 것" 의 누적 부채 | 장기 속도 저하 | Path 별 scope 제한, WASM + Rust helper 로 공통 모듈 추출, 오픈소스 공개로 contributor 확보 |

---

## 상위 전략 맥락

이 pivot 은 기술 최적화가 아니라 **EG-Desk 의 존재 이유와 정렬** 된 결정:

- **"Agent 가 브라우저 내부에 거주"** — Electron 은 이걸 못 함, Firefox chrome JS 가 자연 제공
- **"Spatial canvas 가 real browser entity 를 품음"** — OSR 벽을 Firefox XUL `<browser>` 가 해결
- **"Mini-app 생태계 = 유저가 자기 앱 실행"** — Firefox Subprocess API 로 Electron 과 동등 구현
- **"Privacy + 엔진 다변화"** — Gecko 기반이 전략적 가치 추가

ABP 의 "agent-aware engine" 비전은 장기적으로 Path 3 Gecko patch 로 일부 이식 가능. 현 단계 ROI 는 Firefox chrome JS 경로가 압도적.

---

## 다음 단계

1. ADR-007 / 본 문서 / 로드맵 lock-in (2026-04-17, 이 작업)
2. 기존 confirmed 문서 supersede 배너 + update (Phase B)
3. 세부 설계 문서 (helper / mini-app / chrome JS patterns / WASM) 초안 (Phase C)
4. 기존 brainstorming 조정 (Phase D)
5. Path 2 prototype 착수 (기술 스택 선정 + 첫 번째 helper 기능 — PTY 가 유력)
