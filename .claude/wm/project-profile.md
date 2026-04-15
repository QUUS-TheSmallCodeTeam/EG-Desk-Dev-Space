# EG-DESK — Project Profile

> **Purpose**: Agent 온보딩용 프로젝트 요약. 세션 시작 시 가장 먼저 읽는 문서.
> **Source of truth**: 이 문서는 실측 기반 (package.json, 실제 디렉토리, DESIGN_SYSTEM_SPEC.md). 추상적 비전은 `docs/vision/`에 따로 있음.
> **Last refresh**: 2026-04-10 (WM v8+)
> **Companion**: `file-map.json` (파일 단위 세부 정보), `MEMORY.md` (WM 누적 지식)

---

## 1. Identity

- **Name**: EG-DESK (ambient AI workspace)
- **Type**: Electron desktop application
- **Language**: TypeScript (primary), + HTML/CSS (renderer), + Markdown (docs)
- **Phase**: **Early implementation** — 셸 구축 완료, Desk Home v1 구현 중
- **Repository**: `/Users/minsoocha/Projects/EG-Desk-Dev-Space`
- **Git**: main branch, 초기 커밋 위주 (Electron/React 전환은 아직 uncommitted working copy)

## 2. Core Concept

EG-DESK는 **ambient AI workspace** — 유저가 "뭘 하고 있는지"를 앱이 자연스럽게 알아차리고 필요한 도구/에이전트를 주변에 배치하는 공간형 데스크톱. 단순한 챗봇이 아니라, 파일/탭/앱을 하나의 캔버스 위에 놓고 묶어(preset) 저장하고, 엣지에서 호출하는 UX.

핵심 철학: **Ontology Bridge** — 현실세계의 "무엇(객체)/어디(장소)" 두 축이 디지털화에서 납작해졌다는 문제의식. 자세히는 `docs/vision/ontology-bridge.md` (454줄, 2026-03-25).

## 3. Current Source Code (실측 2026-04-10)

**실제 살아있는 코드는 `src/` 하위 3개 프로세스**:

```
src/
├── main/           Electron main process (BrowserWindow, IPC, lifecycle)
│   └── index.ts    59줄. 1440x900 window, LIGHT #F5F3EF 배경, hiddenInset titleBar
├── preload/        contextBridge로 renderer에 API 노출
│   ├── index.ts    18줄. electronAPI + api 노출
│   └── index.d.ts  8줄. window 타입 선언
└── renderer/       Vite + React 진입점
    ├── index.html  17줄
    └── src/
        ├── main.tsx           10줄. ReactDOM.createRoot
        ├── App.tsx            7줄. DeskHome 렌더링
        ├── DeskHome.tsx       44줄. L0 Canvas + 4-Edge 통합 (Task #6 완료)
        ├── styles/
        │   └── globals.css    88줄. Tailwind base + .paper-surface + .glass 유틸 + CSS 변수
        └── components/
            ├── icons.tsx      112줄. 인라인 SVG (Search/Bell/ChatBubble/FolderStack/Plus/Trash/Globe/Timer/Bag/Map)
            └── edges/         4-Edge Framework (DESIGN_SPEC §7 구현)
                ├── DeskRail.tsx        67줄. Top Edge
                ├── Dock.tsx            62줄. Bottom Edge
                ├── PresetBag.tsx       63줄. Left Edge
                └── ContextualHUD.tsx   61줄. Right Edge
```

**총 코드 라인 수**: ~630줄 (src/ 전체)

**주의**: `src/canvas/*` (이전 Theia 기반) 및 `src/CODEBASE_STRUCTURE.md`는 **deprecated**. 이전 아키텍처 산물로, 현재 아무것도 import하지 않음. file-map에 아직 일부 항목이 남아있을 수 있음 — cleanup 필요.

## 4. Design System — Source of Truth

**`ideas/brainstorming/DESIGN_SYSTEM_SPEC.md` (313줄)** 이 유일한 design source of truth. 모든 UI 구현은 이 문서를 참조.

**Hard rules** (어기면 곧 rewrite):
- **LIGHT mode only** — dark classes 금지 (`bg-neutral-950` 등)
- **Warm off-white canvas**: `#F5F3EF` (CSS 변수 `--surface`)
- **Primary**: `#2D5A7B` (deep navy)
- **Fonts**: Inter (UI), JetBrains Mono (code/debug)
- **No external icon libs** — `components/icons.tsx`의 인라인 SVG만 사용

**Visual Hierarchy (§8)**:
- **L0 Surface** — paper-surface canvas (바닥)
- **L1 Covered cards** — 약한 그림자, 넓게 깔린 카드
- **L2 Spread/Full cards** — 집중 작업용 카드
- **L3 Edge System** — 4-Edge Framework, z-40 frosted glass

**4-Edge Framework (§7)**:
| Edge | Component | 역할 |
|---|---|---|
| Top | `DeskRail` | Desk 스위처, Cmd+K, Minimap, Bell, Profile |
| Bottom | `Dock` | Chat/Shelf/+ · 핀 앱 · Trash |
| Left | `PresetBag` | 저장된 preset (파일+탭+앱 묶음) |
| Right | `ContextualHUD` | Dock 앱 클릭 시 HUD 모드로 렌더링 |

**Frosted glass spec**: `rgba(255,255,255,0.6)` + `backdrop-filter: blur(20px) saturate(180%)`. `globals.css`의 `.glass` 클래스 사용.

## 5. Tech Stack (실측, package.json 기준)

**Runtime**:
- Electron 33.0.2
- Node >= 20 (implied)

**Dependencies**:
- `react` 18.3.1, `react-dom` 18.3.1
- `@electron-toolkit/preload` 3.0.1, `@electron-toolkit/utils` 3.0.0

**Dev / Build**:
- `electron-vite` 2.3.0 (main/preload/renderer 3-target build)
- `vite` 5.4.10, `@vitejs/plugin-react` 4.3.3
- `typescript` 5.6.3
- `tailwindcss` 3.4.14, `postcss` 8.4.47, `autoprefixer` 10.4.20
- `@electron-toolkit/tsconfig` 1.0.1 (base for `tsconfig.node.json` / `tsconfig.web.json`)

**ts 구조**: `tsconfig.json` (project refs) → `tsconfig.node.json` (main/preload, NodeNext) + `tsconfig.web.json` (renderer, DOM + React JSX)

**⚠ Stale doc**: `ideas/confirmed/technology-stack.md`는 Theia 기반으로 쓰여 있어 위 실측과 크게 다름. **별도 갱신 task 필요**. 현재 scope 밖이라 건드리지 않음.

## 6. Build & Run

```bash
npm run dev              # electron-vite dev (HMR + Electron 런칭)
npm run build            # 3-target production build → out/
npm run preview          # 빌드 결과 실행
npm run typecheck        # node + web 양쪽 체크 (사전 검증용)
npm run typecheck:node   # main/preload만
npm run typecheck:web    # renderer만
```

**현재 검증 상태**:
- ✅ `typecheck` 양쪽 통과 (Task #6 기준)
- ✅ `playwright-electron` MCP로 런칭 검증 완료 (Task #5)

**알려진 기술 제약**:
- `import.meta.env.DEV` 사용 시 TS2339 발생 — `tsconfig.web.json`이 `@electron-toolkit/tsconfig` extends하는데 `vite/client` types 미포함. 해결: `src/renderer/src/vite-env.d.ts` 생성 또는 tsconfig에 `"types": ["vite/client"]` 추가. 현재는 주석 방식으로 우회.

## 7. Agent Infrastructure

### Team Roles
- **Session Lead** (root session) — 유저와 직접 소통, 오케스트레이션
- **WM (wm-agent)** — 파일 수준 인텔리전스 상주, `.claude/wm/` 관리
- **Sprint Leader** — compose-team이 지정한 task 조율자
- **Worker** — 구체적 작업 수행 (coding-agent, design-agent, etc.)

자세히는 `~/.claude/CLAUDE.md` (global), `.claude/CLAUDE.md` (project).

### Project-Specific Agent Templates (`.claude/agents/`)
- `egdesk-pm-agent.md` — 전략 PM (vision alignment, PRD 검토)
- `design-agent.md` — Figma MCP 기반 UI/UX 디자이너 (디자인 툴 전환 후 Electron 구현에도 투입됨)
- `paperclip-analyzer-agent.md` — Paperclip 분석 전문 (미사용 가능성)

### Project-Specific Skills (`.claude/skills/`)
- `pm/SKILL.md` — 전략 PM 컨설팅 (reads `.claude/docs/`)
- `onboard/SKILL.md` — 프로젝트 온보딩 (이 profile.md 생성 담당)

### MCP Servers (`.mcp.json`)
| Server | 용도 |
|---|---|
| `claude-subagent` | Claude Code MCP (subagent spawning) |
| `playwright-electron` | Electron 브라우저 자동화 (런칭 검증용) |
| `codex-cli` | Codex CLI MCP bridge |
| `gemini-cli` | Gemini MCP tool |
| `pencil` | Pencil.dev MCP (IDE 의존) — 현재 미활용 |
| `openpencil` | OpenPencil HTTP MCP — 정리 대상 가능성 |
| `stitch-extended` | Stitch API MCP — 디자인 툴 전환 후 사실상 미사용 |

**참고**: Figma/Stitch/Pencil 계열 디자인 MCP는 2026-04-10 이후 **전면 폐기** 결정 (MEMORY.md 참조). HTML/React 직접 작성 + Playwright 스크린샷 검증이 현재 워크플로우.

### WM Storage
- `.claude/wm/project-profile.md` — 이 문서
- `.claude/wm/file-map.json` — 파일 단위 정보 (v8+)
- `.claude/agent-memory/wm-agent/MEMORY.md` — WM 누적 지식 (REJECTED/ORIGIN/DONE 엔트리)

## 8. Knowledge Artifacts

### Confirmed PRDs (`ideas/confirmed/`)
| File | 주제 |
|---|---|
| `AI_TERMINAL_CHAT_INTEGRATION.md` | AI 터미널 채팅 통합 |
| `INFINITE_CANVAS_BROWSER_INTEGRATION.md` | Infinite canvas + 브라우저 통합 |
| `EG-DESK_Spatial_Canvas_UX_Solutions.md` | Spatial canvas UX 솔루션 |
| `UNIFIED_BROWSER_AUTOMATION_API.md` | 통합 브라우저 자동화 API |
| `CONTEXT_AWARE_BROWSER_AUTOMATION.md` | Context-aware 브라우저 자동화 |
| `technology-stack.md` | ⚠ stale (Theia 기반) |

### Active Brainstorming (`ideas/brainstorming/`)
- **`DESIGN_SYSTEM_SPEC.md`** — 현재 UI 구현의 source of truth (위 §4 참조)
- `APP_RUNTIME_ARCHITECTURE.md` — 앱 런타임 아키텍처 패턴
- `COGNITIVE_ARCHITECTURE_ANALOGY.md` — 인지 아키텍처 analogy
- `AI_UI_Agent_Architecture.md` — 차세대 프론트엔드 AI 에이전트 (AG-UI + Pretext + Yoga)
- `Self_Correcting_Agent_Architecture.md` — 범용 자가 교정 에이전트
- **`compose-team-v2/`** — V2 swarm 설계 9파일, 7488줄 (orchestration/memory/lifecycle/quality/ux-cost/setup/research/final/implementation-plan)

### Vision (`docs/vision/`)
- `ontology-bridge.md` (454줄, 2026-03-25) — 현실/디지털 세계 간극 논의

### Production Whitepapers (`docs/production/`)
- v1~v8 한/영 버전 (초기 비전 문서)

### References (`docs/references/`)
- `SWARM_SYSTEM_V2_DESIGN.md`, `SWARM_SYSTEM_COMPREHENSIVE_GUIDE[_KOR].md`

### Agent Reports (`subagent_reports/`)
- 파일 기반 agent 통신 로그 (예: `20260302_1500_subagent-context-compaction-research.md`)

## 9. External Reference Library (`references/`)

**선반 (Shelf) 시스템**: `references/[name]/`은 서재(EG-Library)에서 꺼낸 로컬 clone. git-ignored. 관리 도구는 `setup.sh` / `setup.bat` / `/setup-refs` skill.

| 카테고리 | Projects |
|---|---|
| **IDE/Framework** | `theia/` (deprecated 참고), `egdesk-scratch/` |
| **Canvas** | `infinite-canvas/`, `drag-drop-frameworks/` |
| **Browser Automation** | `playwright/`, `puppeteer/`, `puppeteer-in-electron/`, `electron-playwright-integration/` |
| **Browsers** | `brave/`, `surf/` |
| **AI CLI** | `claude-agent-sdk/`, `claude-code/`, `gemini-cli/`, `ai-cli-integration/` |
| **Agent Systems** | `light-system/` |
| **Memory/Data** | `memori/`, `memvid/`, `openmetadata/` |

자세한 각 프로젝트의 온라인 자료는 `references/<name>/online_references.md`.

## 10. Deprecated / Stale Artifacts (⚠ 피할 것)

다음 파일/디렉토리는 outdated — **읽을 때 주의**, cleanup 대상:

| Path | 상태 | 비고 |
|---|---|---|
| `src/canvas/*` | deprecated | 이전 Theia 기반 canvas module, 현재 아무것도 import 안 함 |
| `src/CODEBASE_STRUCTURE.md` | deprecated | Theia 기반 구조 문서 |
| `AGENTS.md` | partially deprecated | Theia 기반 build 명령 포함 |
| `theia_overview.md` | deprecated | Theia 전환 전 메모 |
| `ideas/confirmed/technology-stack.md` | **stale** | Theia 기반, 실제 Electron+React 스택 미반영. **PM 갱신 대상** |
| `docs/EG-DESK_Whitepaper.md` 등 whitepapers | 비전 문서 | 현재 구현과 괴리 있을 수 있음 — 참고용 |

## 11. Recent Timeline (2026-04-xx)

**2026-04-10** — Electron + React 전환 완료 + Desk Home v1 구현 진입
- Task #4: Electron + Vite + React 셸 scaffold (package.json, 3-target build, CSS 변수, 4-Edge 컴포넌트 생성)
- Task #5: playwright-electron MCP로 런칭 검증 통과
- Task #6: DeskHome.tsx 재작성 — LIGHT 테마 + 4-Edge 통합 완료 (44줄, design-agent, WM+PM 병렬 리뷰 프로토콜)
- 디자인 툴 전략 폐기: Figma MCP (월 6회 제한), Pencil.dev/OpenPencil (IDE 의존), Stitch (오염) → 직접 HTML/React 작성으로 전환

**2026-03-25~** — Vision v1.1 `ontology-bridge.md` 작성, `compose-team-v2/` 설계 문서군 작성

**History**: 그 이전은 Research & Architecture Planning phase. Theia 기반으로 초기 구상됨 → 2026-04-10 전환.

---

## For Future Agents — Quick Start

처음 이 프로젝트에 들어왔다면:

1. **이 파일 먼저 읽기** — 전체 맥락
2. **`file-map.json`** — 파일별 세부 정보 검색용
3. **`DESIGN_SYSTEM_SPEC.md`** — UI 작업이면 반드시
4. **`docs/vision/ontology-bridge.md`** — 제품 철학 이해
5. **`MEMORY.md` (WM agent-memory)** — REJECTED/ORIGIN/DONE 누적 지식

**작업 시작 전**:
- 코드 변경이면 `npm run typecheck`로 기준선 확인
- UI 작업이면 LIGHT rules 엄수 (dark classes 금지)
- 새 파일 생성 시 WM에 DM (wm-protocol.md 형식) — file-map 동기화 유지

**피해야 할 함정**:
- `src/canvas/`, `CODEBASE_STRUCTURE.md`, `AGENTS.md` 참고하지 말 것 — 전부 deprecated
- `technology-stack.md`의 Theia 기반 내용 믿지 말 것 — package.json이 실측 source
- Figma MCP / Stitch MCP로 디자인 생성 시도하지 말 것 — 직접 Electron + Tailwind 작성

---

**Maintained by**: WM agent. Changes via WM DM protocol (`~/.claude/wm-protocol.md`).
