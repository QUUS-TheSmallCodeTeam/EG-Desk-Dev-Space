# EG-DESK Technology Stack Registry

> **Purpose**: Centralized registry of all technologies, frameworks, and libraries used in EG-DESK
> **Maintained by**: PM Agent (auto-update) + Human decisions (ideation/research phases)
> **Used by**: PM Agent for technology selection guidance during feature implementation
> **Last Updated**: 2026-04-17 (v3 — Firefox Shell pivot per ADR-007. Section 2 renamed to "App Shell Framework", Electron → Transitional, Firefox chrome JS + fx-autoconfig + Surfer + WASM + Rust helper 신규 entries)

> ### 🟠 2026-04-17 PIVOT NOTE
>
> EG-Desk 는 **Electron 에서 Firefox chrome JS shell 로 전환** (ADR-007). 이 문서 섹션 2 (App Shell Framework) 구조가 바뀜:
> - Electron 은 **Transitional** — 현 Electron 코드베이스는 단계적 이관 대상, 신규 기능은 Firefox shell 에 작성
> - Firefox + fx-autoconfig + Surfer 가 새 primary framework
> - Rust helper 바이너리가 OS-deep 기능 담당 (tray / hotkey / pty / file-watch)
> - WASM 이 연산 헤비 in-process 모듈 담당
> - Mini-app 은 번들된 bun/node subprocess
>
> **관련 문서**: [`FIREFOX_SHELL_STRATEGY.md`](FIREFOX_SHELL_STRATEGY.md), [`ADR-007`](../../.claude/docs/decisions/007-firefox-shell-over-electron.md), [`apps/firefox-ui-demo/`](../../apps/firefox-ui-demo/)

---

## How to Use This Document

### For PM Agent
1. **Always discover this file dynamically**: `Glob: ideas*/**/eg-desk*ideas*/*tech*.md`
2. **Read entire document** to understand available technologies
3. **Match user requirements** to technology capabilities
4. **Update this document** when new technology added (Write/Edit tools)

### For Developers
- Reference this before implementing features
- Propose new technologies during ideation/research
- Update when new framework/library integrated

---

## 1. IDE Component Framework

### Eclipse Theia
- **Category**: IDE Component Framework
- **Version**: (Check package.json)
- **Purpose**: IDE 컴포넌트 프레임워크 — 에디터, 터미널, 파일 탐색기 등 IDE 기능 제공. 앱 전체의 base framework가 아님 (→ Electron이 앱 전체 desktop framework)
- **Capabilities**:
  - Terminal integration and management
  - Editor (Monaco) integration
  - Workspace and file system management
  - Command palette and keybinding system
  - Preference/settings system
  - Extension system (VS Code compatible)
  - Menu contributions
  - View containers and widgets
- **Use When**:
  - IDE 기능 구현 (editor, terminal, file system)
  - Command/keybinding 시스템
  - Workspace 관리
  - Extension 개발
- **Location**: `packages/*` (upstream Theia packages)
- **Documentation**:
  - Official: https://theia-ide.org/docs/
  - Local: See Theia source code in packages/
- **Integration Notes**: IDE 컴포넌트 프레임워크. IDE 관련 기능(에디터, 터미널, 파일시스템 등)은 Theia 서비스와 통합. 앱 전체 아키텍처는 Electron이 담당

---

## 2. App Shell Framework (App-level)

### 2.1 Firefox Chrome JS Shell — **PRIMARY (2026-04-17+)**
- **Category**: App shell framework — primary, per ADR-007
- **Purpose**: EG-Desk 앱 전체 shell. Firefox 바이너리 위에 chrome JS 로 커스텀 UI (4-Edge Framework + canvas + entity cards) 구축. Privileged context 라 agent 가 DOM + OS 동시 자연 접근
- **Engine**: Gecko (웹 렌더) + SpiderMonkey (privileged JS)
- **Capabilities**:
  - Full browser web 렌더 (카드 안에 real webpage)
  - Privileged API: `IOUtils`, `PathUtils`, `Services.*`, `Subprocess.sys.mjs`
  - XPCOM: `nsIFile`, `nsIChannel`, `nsIFilePicker`, etc.
  - JSActor 기반 content↔chrome 통신 (Electron IPC 대응)
  - XUL `<browser>` 로 canvas 에 실제 웹페이지 embed (popup/oauth 도 `window.browserDOMWindow` override 로 카드 라우팅)
  - WebAssembly native-speed in-process
  - System tray / hotkey / pty → 별도 Rust helper 바이너리 (섹션 2.3)
- **Loader**: fx-autoconfig (MrOtherGuy) — runtime chrome JS 주입
- **Path**: 1 (runtime injection POC) → 2 (portable 재패키징) → 2+WASM → 3 (Firefox fork + Surfer)
- **Current POC**: `apps/firefox-ui-demo/`
- **Documentation**:
  - Strategy: [`FIREFOX_SHELL_STRATEGY.md`](FIREFOX_SHELL_STRATEGY.md)
  - ADR: [`007-firefox-shell-over-electron`](../../.claude/docs/decisions/007-firefox-shell-over-electron.md)
  - Mozilla chrome docs: https://firefox-source-docs.mozilla.org/
- **License**: MPL 2.0 (Firefox). Custom overlay 코드는 우리 소유
- **Trademark**: Mozilla trademark policy 준수 — 앱명 `EGDesk` 단독, "Built on Mozilla Firefox" 고지

### 2.2 Surfer — Firefox Fork Build Tool (Path 3)
- **Category**: Browser fork 빌드 오케스트레이터 (필요시, Path 3)
- **Purpose**: Firefox 소스 다운로드 + patch 적용 + `mach build` 호출 + packaging 자동화. Zen Browser 가 쓰는 툴
- **Source**: [zen-browser/surfer](https://github.com/zen-browser/surfer)
- **Prerequisite**: Mozilla 빌드 환경 (Rust, clang, MSVC/Xcode, ~30GB)
- **Use When**: Path 3 fork 필요시 (runtime injection 한계 도달 또는 완전 독립 브랜드 요구)
- **License**: Apache 2.0
- **Build 시간**: 환경 setup 2~3일 + 최초 `mach build` 30분~2시간 (머신 의존)

### 2.3 egdesk-helper — OS Bridge Rust Binary
- **Category**: 단일 Rust 바이너리. Firefox 내장에 없는 OS 기능 담당
- **Purpose**: chrome JS 에서 `Subprocess.call` 로 spawn, WebSocket IPC 로 이벤트 교환
- **Crates (후보)**:
  - `portable-pty` — 크로스플랫폼 PTY (Windows ConPTY + Unix forkpty)
  - `alacritty_terminal` — 터미널 상태머신 + ANSI 파서
  - `tray-icon` — 시스템 트레이
  - `global-hotkey` — OS 레벨 단축키 후킹
  - `notify` — 파일시스템 watcher (fs.watch 대응)
  - `tokio-tungstenite` — async WebSocket
- **Spec**: [`EGDESK_HELPER_BINARY_SPEC.md`](../brainstorming/EGDESK_HELPER_BINARY_SPEC.md) (작성 예정)
- **License**: MIT / Apache 2.0 (우리 소유, 오픈소스 공개 검토)
- **Size**: ~5MB static link 목표

### 2.4 WebAssembly (WASM) — In-process Native Layer
- **Category**: 연산 헤비 in-process 모듈 (IPC 회피용)
- **Purpose**: SpiderMonkey 내장 WASM 실행기로 Rust → wasm32 컴파일 모듈 직접 로드. near-native 속도, sandboxed
- **Use When**: 고빈도/지연 민감 연산 (vector search, syntax parser, image/audio DSP, crypto)
- **Not For**: OS syscall 필요 기능 (→ Helper 바이너리 또는 chrome JS `IOUtils/Subprocess` 경유)
- **Spec**: [`EGDESK_WASM_LAYER.md`](../brainstorming/EGDESK_WASM_LAYER.md) (작성 예정)

### 2.5 ~~Electron~~ — Transitional
- **Status**: ~~PRIMARY~~ → **Transitional per ADR-007 (2026-04-17)**. 신규 기능 작성 금지. 기존 코드베이스 단계 이관 대상
- **역사적 Purpose**: 이전엔 EG-Desk 앱 전체의 메인 desktop framework 였음
- **Why Superseded**: OSR + shared texture 로 canvas 안에 real browser UX 를 넣는 한계, agent 의 DOM+OS 동시 접근 제약, ABP (Chromium fork) 경로의 ROI 불일치. ADR-007 참조
- **Current Location**: `src/main/`, `src/renderer/`, `src/preload/` — 단계 이관 / deprecate 대상
- **Capabilities 매핑 (Electron → Firefox shell)**:
  | Electron | Firefox shell 대응 |
  |----------|-------------------|
  | `electron.app`, `BrowserWindow` | chrome JS boot + `spawnBrowserCard` (XUL `<browser>`) |
  | `ipcMain` / `ipcRenderer` | JSActor (`sendQuery` / `sendAsyncMessage`) |
  | `contextBridge` | JSActor 쌍 + content script |
  | `electron.Tray` | egdesk-helper (`tray-icon` crate) |
  | `electron.globalShortcut` | egdesk-helper (`global-hotkey` crate) |
  | `electron.Menu` | Firefox chrome menubar 커스터마이즈 + chrome JS 메뉴 |
  | `electron.dialog` | `nsIFilePicker` XPCOM |
  | `electron.clipboard` | `Services.clipboard` |
  | `electron.Notification` | 웹 `Notification` API |
  | `desktopCapturer` | `getDisplayMedia()` (권한 모델 다름) |
  | `autoUpdater` | Firefox AUS 프로토콜 + 자체 업데이트 서버 |
  | Node `fs` | `IOUtils` |
  | Node `child_process` | `Subprocess.sys.mjs` |
  | Node `path` | `PathUtils` |
  | Native `.node` addon | WASM in-process OR helper subprocess |

---

## 3. Canvas System

### Infinite Canvas
- **Category**: Canvas Rendering System
- **Status**: Research phase / To be integrated
- **Purpose**: Infinite scrollable canvas with viewport management for spatial UI
- **Capabilities**:
  - Viewport rendering (visible area optimization)
  - Camera control (zoom, pan)
  - Infinite scroll (no boundaries)
  - Coordinate transformation
  - Performance optimization (only render visible)
- **Use When**:
  - 무한 캔버스 UI
  - Spatial canvas interaction
  - Large-scale visualizations
  - Zoom/pan required
- **Location**: TBD (planned: eg-desk_taehwa/canvas/)
- **Documentation**: `references/infinite-canvas/`
- **Integration Notes**:
  - To be used with Konva.js for object manipulation
  - Consider performance implications

### Konva.js
- **Category**: Canvas Object Manipulation Library
- **Status**: Research phase / To be integrated
- **Purpose**: 2D canvas library for interactive shapes, drag-and-drop, transformations
- **Capabilities**:
  - Shapes (Rectangle, Circle, Path, Custom)
  - Drag-and-drop
  - Transformations (rotate, scale, translate)
  - Animations
  - Event handling (click, drag, hover)
  - Layer management
  - Hit detection
- **Use When**:
  - Canvas 객체 조작
  - 드래그앤드롭 interaction
  - Shape drawing and manipulation
  - Interactive canvas elements
- **Location**: TBD (planned: eg-desk_taehwa/canvas/)
- **Documentation**: https://konvajs.org/
- **Integration Notes**:
  - Use with Infinite Canvas for viewport
  - Performance: Use layers wisely

### Canvas Entity Coordinate System (SPEC §9-3 → v1 명세, ADR-006)

- **Category**: Canvas Architecture
- **Status**: **Phase 1 MVP implemented (2026-04-13)** — DONE_WITH_CONCERNS (Dock drag-drop 미구현, pan activator key 분열)
- **Purpose**: Entity(카드/브라우저/가젯) 배치 시 **viewport transform**과 **entity 좌표계**를 일관 동기화하는 규칙. Pan/Zoom 중 entity가 canvas 공간 내 고정 위치를 유지하되 `proximity=relevance` 원칙(SPEC §7-4 L300-306)을 반영.
- **확정 방향** (ADR-001 + ADR-006):
  - **d3-zoom wrapper**: Pan/Zoom은 xyflow `XYPanZoom.ts` 패턴을 자체 구현으로 차용
  - **ViewportPortal 패턴**: xyflow `packages/react/src/components/ViewportPortal/index.tsx` 개념 참고 — `createPortal` + viewport transform 동기화
  - **4-State Lifecycle**: hydrated / suspended / static / discarded (Chrome tab discard 패턴)
  - **Viewport-based Performance Budget**: Hard cap 없음. 중심점 기준 viewport out + 3초 dwell → suspended → static. Static → hydrated 는 click 만 (ADR-006 §5.9)
  - **`@xyflow/react` 의존성 추가 금지** — 전체 라이브러리 대신 4 패턴만 개념 차용 (ADR-001 Option B)
- **비채택**:
  - `Handle` / `EdgeWrapper` / `ConnectionLine` (node-graph 전용, 객체/장소 2축 ontology와 불일치)
  - `Panel` position system (4-Edge Framework 충돌)
  - `Background` Dots/Lines/Cross variant (격자 금지 SPEC §9 L346 / §10-2 L597)
- **Phase 1 MVP 구현 (2026-04-13)**:
  - **파일**: `src/renderer/src/canvas/` 10 파일, 936 라인
    - `Canvas.tsx`, `ViewportContainer.tsx`, `EntityLayer.tsx`, `Entity.tsx`
    - `store.tsx` (Zustand canvas store, 신규 — §8 참조)
    - `types.ts`, `hooks/{useCanvasTransform,useViewportIntersection,useScreenshotCapture}.ts`
    - `adapters/NoteAdapter.ts` (첫 entity type)
  - **의존성 (Green tier, ADR-002)**: `d3-zoom`, `d3-selection`, `html-to-image` (모두 MIT) — §9 참조
  - **검증 상태**: typecheck PASS, build PASS, GUI 런타임 pending (유저 수동 smoke test 필요)
- **Phase 1 Concerns**:
  - §5.7 Dock 드래그드롭 → Entity 생성 API 미구현 (Phase 2)
  - Pan activator key 분열: Cmd/Ctrl/Shift = pan, Space = edge fade 전용 (d3-zoom API 제약, ADR-006 §5.4.1 Phase 1 잠정)
  - `src/CODEBASE_STRUCTURE.md` 미갱신 — canvas/ 디렉토리 반영 필요
- **Location**: `ideas/brainstorming/DESIGN_SYSTEM_SPEC.md` §9-3 (v1 명세 8 sub-sections)
- **Integration Notes**:
  - ADR-006 [Canvas Entity Foundation v1](../../.claude/docs/decisions/006-canvas-entity-foundation.md) — Phase 1 Kickoff block 에 구현 결과 기록
  - ADR-001 [Canvas Library Reference](../../.claude/docs/decisions/001-canvas-library-reference.md) — xyflow 개념 차용 기조
  - Phase 2 = Entity type FIFO lazy addition (ADR-006 §5.11)

---

## 4. Browser Automation

### Playwright
- **Category**: Browser Automation Framework
- **Status**: Production
- **Purpose**: Browser-first automation enabling AI execution on any web system
- **Capabilities**:
  - Multi-browser support (Chromium, Firefox, WebKit)
  - Headless and headed modes
  - Network interception and request modification
  - Screenshot and PDF generation
  - Session management and cookies
  - File upload/download handling
  - Auto-wait mechanisms (visibility, stability, enabled state)
- **Use When**:
  - AI needs to execute actions on web systems
  - API not available for target system
  - Browser-level automation required
  - Web scraping and data extraction
- **Location**: Core infrastructure layer
- **Documentation**: https://playwright.dev
- **Integration Notes**:
  - Primary execution mechanism for AI agents
  - Supports Ontology-driven workflows
  - Handles dynamic environment adaptation
  - Error handling and retry patterns essential

---

## 5. AI Integration

### Anthropic Claude API
- **Category**: AI/LLM Integration
- **Status**: Production
- **Purpose**: AI chat and assistance functionality powered by Claude
- **Capabilities**:
  - Chat completion
  - Streaming responses
  - Context management
  - Prompt engineering
  - Vision (image understanding)
- **Use When**:
  - AI 채팅 기능
  - AI-powered assistance
  - Code generation/explanation
  - Content analysis
- **Location**: `packages/ai-anthropic/`
- **Documentation**: https://docs.anthropic.com/
- **Integration Notes**: Use Theia AI packages for integration

### OpenAI GPT
- **Category**: AI/LLM Integration
- **Status**: Production
- **Purpose**: Multi-model AI flexibility - cost-effective general tasks
- **Capabilities**:
  - GPT-4, GPT-3.5 models
  - Chat completion
  - Function calling
  - Vision (GPT-4V)
  - Embeddings
- **Use When**:
  - Cost-effective general AI tasks
  - Function calling required
  - OpenAI-specific features needed
- **Documentation**: https://platform.openai.com/docs/
- **Integration Notes**: Part of multi-model AI strategy

### Google Gemini
- **Category**: AI/LLM Integration
- **Status**: Production
- **Purpose**: Multi-model AI flexibility - Google ecosystem integration
- **Capabilities**:
  - Gemini Pro models
  - Multimodal understanding
  - Long context windows
  - Google services integration
- **Use When**:
  - Google workspace integration
  - Long context handling
  - Multimodal tasks
- **Documentation**: https://ai.google.dev/docs
- **Integration Notes**: Part of multi-model AI strategy

### Ollama
- **Category**: Local AI Runtime
- **Status**: Production
- **Purpose**: On-premise AI execution for sensitive data and enterprise requirements
- **Capabilities**:
  - Local LLM execution
  - No internet dependency
  - Multiple model support (Llama, Mistral, etc.)
  - Privacy-first design
- **Use When**:
  - Data security is critical
  - Enterprise privacy requirements
  - Offline AI execution needed
  - Sensitive data processing
- **Documentation**: https://ollama.ai/
- **Integration Notes**:
  - Zero data leaves local machine
  - Performance depends on local hardware
  - Model management required

### Theia AI Packages
- **Category**: AI Integration Framework
- **Purpose**: Theia's built-in AI integration framework
- **Capabilities**:
  - ai-core: Core AI abstractions
  - ai-core-ui: AI UI components
  - ai-chat: Chat interface
  - ai-mcp: Model Context Protocol
- **Use When**: Integrating AI features into Theia IDE
- **Location**: `packages/ai-*/`
- **Integration Notes**: Provides standardized AI integration patterns

---

## 6. Data Storage

### SQLite
- **Category**: Database
- **Status**: Production
- **Purpose**: Local structured data storage (Data Irrigation model)
- **Capabilities**:
  - Embedded database (no server)
  - ACID transactions
  - SQL query support
  - File-based storage
  - Zero configuration
- **Use When**:
  - Local data persistence
  - Structured data storage
  - Relational data modeling
  - Workflow history and logs
- **Documentation**: https://www.sqlite.org/docs.html
- **Integration Notes**:
  - Part of "Data Irrigation" philosophy (local-first)
  - Distributed via third-party cloud services
  - No central data lake

---

## 7. Security

### AES-256 Encryption
- **Category**: Security/Encryption
- **Status**: Production
- **Purpose**: Data encryption at rest and in transit
- **Use When**:
  - Storing sensitive credentials
  - Encrypting local data
  - Secure data transmission

### TLS 1.3
- **Category**: Security/Network
- **Status**: Production
- **Purpose**: Secure network communication
- **Use When**:
  - API communication
  - External service integration
  - Data transmission security

---

## 8. State Management

### Zustand + shallow equality (Renderer-side)

- **Category**: React State Management
- **Status**: Proposed (Pan Immersion v1 체감 평가 완료 후 확정 예정)
- **Purpose**: Renderer 프로세스의 canvas/edge/entity 상태를 관리하는 경량 스토어. 도메인별 slice 분리로 re-render 최소화.
- **선택 근거**:
  - **단순성**: Redux 대비 boilerplate 제거 (action/reducer 불필요). Provider 없이 hook으로 직접 구독.
  - **Shallow equality**: `useStore(selector, shallow)` 패턴으로 selector가 반환한 객체의 shallow 비교만 수행 → 불필요 re-render 방지. xyflow 내부 store 패턴 차용 (`references/xyflow/packages/react/src/store/` 개념 참고, ADR-001 Option B).
  - **도메인 slice 분리**: viewport / tools / edges / entities 등 독립 store. anytype의 상태 독립 철학 참고(개념만, 코드 포팅 없음 — ADR-002 🔴 Red 준수, ADR-003 비차용 근거).
- **Capabilities**:
  - Hook-based subscription (`useStore`)
  - Selector + equality comparator
  - Middleware (persist, immer, devtools)
  - SSR-friendly (EG-Desk는 N/A이나 미래 호환성)
- **Use When**:
  - Canvas viewport transform (pan/zoom 좌표)
  - Edge 상태 (Pan Immersion hide/show, PresetBag expand/collapse, HUD 활성 타겟)
  - Entity 모델 도입 시 entity list/selection/proximity 상태
  - 도구 선택 (Canvas Toolbar active tool)
- **Use When NOT**:
  - Main 프로세스와 동기화되는 persistent state → IPC + main-side store 별도 (추후 결정)
  - 단일 컴포넌트 local state → `useState`로 충분
- **Location**:
  - `src/renderer/src/stores/` (예정, Pan Immersion v1 이후 도입)
  - `src/renderer/src/canvas/store.tsx` — Canvas entity state store (ADR-006 Phase 1 MVP, 2026-04-13 도입). Viewport transform + entity lifecycle(hydrated/suspended/static) 관리. Zustand 기반.
- **Documentation**: https://docs.pmnd.rs/zustand
- **Integration Notes**:
  - **Shallow equality 필수**: selector가 객체/배열을 반환하면 반드시 `shallow`를 2번째 인자로 전달. 미사용 시 매 액션마다 re-render
  - **Slice당 파일 1개**: `useViewportStore`, `useEdgeStore`, `useToolStore`, `useEntityStore` 등 도메인별 분리
  - **Cross-slice 참조 금지**: 한 slice의 action이 다른 slice를 직접 호출하지 않음. 조율이 필요하면 컴포넌트 레이어에서 조합
  - **Devtools middleware**: 개발 중에만 활성화 (`process.env.NODE_ENV === 'development'`)
  - **ADR 근거**: xyflow 패턴 차용은 [`.claude/docs/decisions/001-canvas-library-reference.md`](../../.claude/docs/decisions/001-canvas-library-reference.md), anytype 코드 포팅 금지는 [`.claude/docs/decisions/002-external-reference-license-policy.md`](../../.claude/docs/decisions/002-external-reference-license-policy.md) 및 [`003-electron-sidebar-drag-resize-ux.md`](../../.claude/docs/decisions/003-electron-sidebar-drag-resize-ux.md)

---

## 9. External Reference License Policy

> **근거 ADR**: [`.claude/docs/decisions/002-external-reference-license-policy.md`](../../.claude/docs/decisions/002-external-reference-license-policy.md) (Status: Proposed v2 — **2-tier 전환**, user 승인 대기). 본 섹션은 ADR 요약. 상세 근거/대안 평가는 ADR 본문 참조.
> **EG-Desk는 상업화 전제 프로덕트** — `docs/EG-DESK_Whitepaper.md §10`, `docs/vision/EG-DESK 백서 - Vision_v1.md L663`, `docs/production/EG-DESK 백서 - Production_v7_temp_한글.md L1467`.

### Purpose

`references/` 아래 clone한 외부 repo를 coding-agent가 참고해 코드를 작성할 때, **라이선스 분류 없는 코드 복사**로 EG-Desk 상업화가 법적 리스크를 떠안지 않도록 하는 정책. copyleft 파일 단위 침투 리스크까지 차단하기 위해 **2-tier 단순화**(Green / Red).

### 2-Tier 분류 (v2)

| Tier | 해당 라이선스 | 허용 범위 |
|------|-------------|----------|
| 🟢 **Green** (permissive) | MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0, ISC, 0BSD, Unlicense | **코드 포팅 허용**. 라이선스 표기 의무 (파일 상단 주석 또는 `NOTICE.md` 집중 기록). npm dep 자유 추가. |
| 🔴 **Red** (copyleft + non-commercial + proprietary) | **MPL-2.0, EPL-2.0, LGPL**, CDDL, ASAL 1.0, AGPL-3.0, SSPL, GPL-2/3, Non-Commercial (CC-BY-NC 등), Source-Available (Elastic 등), Proprietary | **코드 포팅 금지** (단 한 줄도). 개념/아키텍처 참고만. npm dep 추가 시 **개별 ADR로 유저 승인 필요** (기존 사용 중 binary는 유지 가능). |

### 현재 레퍼런스 분류 스냅샷 (2026-04-13 v2)

| Reference | License | Tier |
|-----------|---------|------|
| xyflow | MIT | 🟢 Green |
| anytype | ASAL 1.0 | 🔴 Red |
| zen-browser | MPL 2.0 (추정) | 🔴 **Red** (v1 Yellow → v2 승격) |
| surf | Apache 2.0 (verified, 2026-04-13) | 🟢 Green |
| electron | MIT | 🟢 Green |
| playwright | Apache 2.0 | 🟢 Green |
| puppeteer | Apache 2.0 | 🟢 Green |
| theia | EPL 2.0 + GPL 2 w/ Classpath | 🔴 **Red** (v1 Yellow → v2 승격). 기존 npm binary 사용은 유지, **소스 포팅은 금지**. |
| claude-agent-sdk / gemini-cli / infinite-canvas / light-system | 미확인 | ⏳ TBD |

> ⏳ TBD 항목은 다음 세션에서 `references/[name]/LICENSE*` 확인 후 갱신. ADR-002 Decided 전환 시 재분류 반영.

### 운영 규칙 (요약)

1. **setup.sh / 수동**: 신규 clone 시 `references/[name]/LICENSE_CATEGORY.md`에 🟢 Green 또는 🔴 Red + 원본 라이선스 경로 기록
2. **Agent template rule** (coding-agent / design-agent 등 Write 권한 agent):
   > "코드 작성 중 `references/[name]/` 코드 복사/포팅 시 `references/[name]/LICENSE_CATEGORY.md`를 선행 확인. 🔴 Red는 **개념 참고만, 단 한 줄도 복사 금지**. 🟢 Green은 표기 조건 준수 (파일 상단 주석 또는 NOTICE.md)."
3. **PM 책임**: 신규 reference 추가 시 egdesk-pm-agent가 Green/Red 분류. 모호한 dual-license / custom license는 ADR 개별 평가.
4. **npm 의존성 정책**: Red tier 라이브러리를 `package.json`에 신규 추가하려면 **개별 ADR로 유저 승인**. Binary만 쓰는 기존 사용(예: Theia)은 유지.
5. **Status 전환**: 본 정책은 ADR-002 Decided 승인 시 구속력 발생. Proposed 단계에서도 권고로 작동.

### 현재 세션 파생 결정

- **anytype 영구 포팅 금지** — ADR-003 근거. 드래그 리사이즈/auto-close UX 개념조차 역할 중복으로 v1 비채택
- **xyflow 개념 차용만** — ADR-001. 4 패턴(Pan/Zoom, ViewportPortal, NodeToolbar, Background는 paper-surface 유지) 개념 참고, `@xyflow/react` 의존성 추가 금지
- **Theia / zen-browser 소스 포팅 금지** — v2 2-tier 전환으로 Red 편입. Theia npm binary 사용은 유지, 소스 파일 단위 포팅은 중단
- **Canvas Phase 1 MVP npm deps 추가 (2026-04-13, ADR-006)** — `d3-zoom` (MIT, 🟢 Green), `d3-selection` (MIT, 🟢 Green, d3-zoom peer dep), `html-to-image` (MIT, 🟢 Green). 모두 Green tier 라 신규 ADR 없이 `package.json` 추가 가능. 라이선스 표기는 `NOTICE.md` (또는 파일 상단 주석)에 누적.

---

## 10. (Future Technologies)

_New frameworks and libraries will be added here during ideation/research phases_

### Template for Adding New Technology

When proposing/adding a new technology, use this format:

```markdown
### [Technology Name]
- **Category**: [Framework / Library / Service / Tool]
- **Version**: [Version if known]
- **Status**: [Research / Integration / Production]
- **Purpose**: [One-line description of what it does]
- **Capabilities**:
  - [Capability 1]
  - [Capability 2]
  - [Capability 3]
- **Use When**:
  - [Use case 1]
  - [Use case 2]
- **Location**: [Where in codebase or TBD]
- **Documentation**: [Links or local paths]
- **Integration Notes**: [Important considerations, dependencies, performance notes]
```

**Example: Adding Three.js**
```markdown
### Three.js
- **Category**: 3D Rendering Library
- **Version**: TBD
- **Status**: Proposed (2025-10-15)
- **Purpose**: 3D visualization and rendering for spatial canvas
- **Capabilities**:
  - 3D object rendering
  - Camera control
  - Lighting and materials
  - Animation
  - WebGL optimization
- **Use When**:
  - 3D visualization needs
  - Spatial representation in 3D
  - Complex geometric rendering
- **Location**: TBD (proposed: eg-desk_taehwa/3d-renderer/)
- **Documentation**: https://threejs.org/docs/
- **Integration Notes**:
  - Works with Infinite Canvas for viewport
  - Performance: WebGL context management
  - Bundle size: Consider tree-shaking
```

---

## Technology Selection Guidelines

### Decision Process (for PM Agent)

When user requests a feature:

1. **Analyze User Requirements**:
   - What is the user trying to achieve?
   - What are the key technical characteristics?
   - What existing features does it relate to?

2. **Read This Document**:
   - Discover available technologies dynamically
   - Understand capabilities of each technology
   - Check integration notes

3. **Match Requirements to Technologies**:
   - Which technology's capabilities match the requirements?
   - Are multiple technologies needed? (common!)
   - Is custom implementation needed?

4. **Make Selection**:
   - **Primary Technology**: Main technology for the feature
   - **Secondary Technologies**: Supporting technologies (if needed)
   - **Custom Implementation**: Areas requiring custom code

5. **Check Implementation Status**:
   - Does this technology exist in codebase? (Glob for it)
   - Is it in research phase? Integration phase? Production?

6. **Document Decision**:
   - Include technology selection in Strategic Guide
   - Provide rationale for choice
   - Note integration points

### Multi-Technology Features

Many features require **multiple technologies working together**:

**Examples**:
- **Canvas Node Editor**:
  - Primary: Infinite Canvas (viewport/rendering)
  - Secondary: Konva.js (node manipulation)
  - Custom: Node data model, state management

- **AI Chat UI**:
  - Primary: Theia AI packages (integration framework)
  - Secondary: Anthropic Claude API (LLM provider)
  - Custom: Chat UI components

- **Native Menu with Commands**:
  - Primary: Electron (native menu API)
  - Secondary: Theia (command system)
  - Integration: Menu items trigger Theia commands

### When No Technology Fits

If no existing technology matches requirements:

1. **Consider Custom Implementation**:
   - Pure TypeScript/React
   - Use existing tech as foundation
   - Document rationale in PRD

2. **Propose New Technology**:
   - Present to user: "This requires [NewTech]. Should we add to stack?"
   - If approved: Research phase → Integration → Update this document

3. **Never Force-Fit**:
   - Don't use wrong technology just because it exists
   - Wrong choice = technical debt
   - Better to add right technology or go custom

---

## Technology Status Tracking

### Research Phase
- Proposed, being evaluated
- Documentation review ongoing
- Proof-of-concept needed

### Integration Phase
- Approved, being integrated into codebase
- Package installation, configuration
- Example implementation

### Production
- Fully integrated and ready for use
- Examples available in codebase
- Documented patterns established

**Current Status**:
- ✅ **Production**: Theia, Electron, Playwright, Claude API, OpenAI GPT, Google Gemini, Ollama, SQLite, AES-256, TLS 1.3
- 🔬 **Research**: Infinite Canvas, Konva.js
- 📋 **Proposed**: Zustand + shallow equality (Pan Immersion v1 체감 평가 후 확정), External Reference License Policy (ADR-002 Decided 대기)

---

## Maintenance Log

### 2025-10-15: Initial Template
- Created technology stack registry
- Documented existing technologies: Theia, Electron, AI packages
- Added research-phase technologies: Infinite Canvas, Konva.js
- Established template for new technologies

### 2025-12-04: Production Technologies Update
- **Added Browser Automation**: Playwright (browser-first automation)
- **Added Multi-Model AI**: OpenAI GPT, Google Gemini, Ollama (local LLM)
- **Added Data Storage**: SQLite (Data Irrigation model)
- **Added Security**: AES-256, TLS 1.3
- **Reason**: Aligned technology-stack.md with production whitepaper (백서)
- **Source**: PM agent disparity analysis report

### 2026-04-13: Addenda — State Management + License Policy (v1 초안, 3-tier)
- **Added §8 State Management**: Zustand + shallow equality + 도메인별 slice 분리 (xyflow store 패턴 차용, ADR-001 근거)
- **Added §9 External Reference License Policy**: 3-tier 분류 (🟢 Green / 🟡 Yellow / 🔴 Red) addendum, ADR-002 요약 반영
- **Renumber**: 기존 "Future Technologies" → §10
- **Status**: 둘 다 Proposed. ADR-001/002 Decided 전환 시 정식 발효
- **Source**: shelf-review-agent 1라운드(xyflow/anytype) 리뷰 결과 + ADR-001/002/003 초안

### 2026-04-13 v2: License Policy 2-tier 전환
- **Updated §9 External Reference License Policy**: 3-tier → **2-tier** (Green permissive / Red copyleft+NC+proprietary). MPL-2.0, EPL-2.0, LGPL, CDDL을 Yellow에서 Red로 승격
- **근거**: 상업 프로덕트에서 파일 단위 copyleft도 viral risk + 유지보수 오버헤드 > 이득. shelf-review-agent 2라운드 결과 반영 + team-lead 지시
- **레퍼런스 재분류**: zen-browser (🟡→🔴), theia (🟡→🔴). Theia는 기존 npm binary 사용 유지, 소스 포팅만 금지
- **ADR-002 v2 동기화**: ADR-002 본문도 v2 업데이트 (Option D 신규 채택, Option B Yellow안은 rejected로 전환)
- **Source**: shelf-review-agent 2라운드 보고 + team-lead 2-tier 전환 지시

### 2026-04-13 v3: Canvas Entity Foundation Phase 1 MVP 반영 (ADR-006)
- **Updated §3 Canvas Entity Coordinate System**: Placeholder → **Phase 1 MVP implemented (DONE_WITH_CONCERNS)**. 구현 파일 (`src/renderer/src/canvas/` 10 files, 936 lines), 4-state lifecycle, viewport-based perf budget 확정 반영.
- **Updated §8 State Management Location**: `src/renderer/src/canvas/store.tsx` (Canvas entity store) 추가 — viewport transform + lifecycle 관리.
- **Updated §9 현재 세션 파생 결정**: Canvas Phase 1 MVP npm deps (`d3-zoom`, `d3-selection`, `html-to-image`) 모두 MIT/🟢 Green tier 명시. 신규 ADR 없이 추가 가능.
- **Phase 1 Concerns 기록**: Dock drag-drop 미구현 (Phase 2 이월), Pan activator key 분열 (§5.4.1 Phase 1 잠정 — Cmd/Ctrl/Shift pan, Space edge fade), CODEBASE_STRUCTURE.md 미갱신.
- **근거**: coding-agent Task #30 완료 보고 + ADR-006 Phase 1 Kickoff block 업데이트.
- **Source**: coding-agent 구현 결과 + PM 선제적 기록 (egdesk-pm-agent §5 기록 의무).

### (Future updates will be logged here by PM Agent)

---

**Note**: This document is **dynamically referenced** by PM Agent. Never hardcode technology lists in agent prompts. Always read this file to discover current technology stack.
