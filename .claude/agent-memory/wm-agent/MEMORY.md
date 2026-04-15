# WM Agent Memory

## Project Knowledge
<!-- Key facts about this project's structure, conventions, and architecture -->

- [paste.md is intentional clipboard scratch](paste-md-intentional.md) — 루트의 paste.md는 유저 clipboard 스크래치, delta sync에서 flag 금지
- [Shelf scope filter — 이름만 보고 out-of-scope 금지](feedback_shelf_scope_filter.md) — feasibility 시 모든 clone `ls` 필수, AGENTS.md/SKILL.md/design-* 신호 놓치면 re-spawn 발생 (2026-04-10 gstack miss)
- [design-agent 리팩터링 draft (2026-04-10)](origin_design_agent_refactor_draft.md) — Figma MCP 기반 251줄 → HTML/React+Playwright 기반 draft 449줄. 유저 검토 대기. Input: 3 explorer 리포트 + explore-agent-4 recovery
- [Context Locality Principle — agent template 간 content 복제 금지](feedback_context_locality_principle.md) — `docs/`, `.claude/docs/`, `ideas/` 는 PM-OWNED. 다른 agent 가 copy-paste 로 내용 embed 금지. 2026-04-10 draft 에서 ontology-bridge.md 무단 copy 적발
- [강한 주장 relay 전 1회 tool verify 필수](feedback_strong_claim_verification.md) — byte-identical/always/never/100% 같은 수식어는 DM 전송 전 tool (diff/shasum/grep) 1회 확인 필수. 2026-04-10 mirror clone 단정 사건 교훈
- [Retraction guard: DESIGN_SYSTEM_SPEC "313 lines L436 hardcode bug" 는 환각](feedback_hallucination_retraction_313_bug.md) — 2026-04-11 retract. 재주장 시 즉시 grep "313" 재검증 후 거부. file-map v18 에 [RETRACTED] marking
- [Incident: Mirror clone verification — omc-scan ↔ oh-my-claudecode](incident_mirror_verification_omc_scan.md) — 2026-04-10 byte-identical 단정 → diff -rq 로 40+ drift 발견. agents/designer.md 만 identical (SHA1 cafcd65f...). Evidence + stable_zones insight
- Line count는 `wc -l` 실측 필수 — agent 눈짐작 ±3~5줄 drift (2026-04-13 coding-agent 78→82 case). file-map 정확도 확보용
- [Browser Architecture Research 문서 (2026-04-14)](origin_browser_architecture_research_20260414.md) — Session Lead 직접 작성, pre-ADR research (Open Questions), ideas/brainstorming/ 배치, ADR-007 입력용

### ORIGIN: compose-team-v2 설계 문서 확장 (2026-03-28)
- `ideas/brainstorming/compose-team-v2/` 7개 파일에 EG-Library 확장 조사(16 repos) 결과가 분배 통합됨
- 원본: `subagent_reports/20260328_eg-library-expansion-research.md` (1차) + `20260328_eg-library-expansion-deep-research.md` (심층) → 통합 후 삭제
- 조사 관점: EG-DESK Swarm System 5개 축 (orchestration, memory, lifecycle, quality, UX/cost)

### ORIGIN: Electron + Vite + React + Tailwind 셸 직접 구현 (2026-04-10)
- `package.json`, `electron.vite.config.ts`, `tsconfig.{json,node.json,web.json}`, `tailwind.config.js`, `postcss.config.js`, `src/{main,preload,renderer}/` 전부 2026-04-10 신규
- WHY: Figma MCP(Starter plan 읽기 월 6회 제한), Pencil.dev/OpenPencil(IDE/앱 의존성), 기타 10+ 디자인 MCP 검토 → UI 화면 생성에 쓸만한 도구 없음을 확인. Electron 앱이 최종 목표이므로 디자인 도구 중간 단계는 불필요. HTML/React 직접 작성 + Playwright 스크린샷 검증이 더 효율적
- REJECTED 대안들: Figma MCP, Pencil.dev, OpenPencil, Stitch (중복 오염)
- 구현 기준: `ideas/brainstorming/DESIGN_SYSTEM_SPEC.md` (LIGHT only, #F5F3EF warm off-white, Inter, §7 4-Edge Framework)
- RELATIONSHIP: 이전 Theia 기반 `src/canvas/*`, `src/CODEBASE_STRUCTURE.md`, `AGENTS.md`, `theia_overview.md`는 deprecated 상태. 업데이트 or 삭제 결정 대기
- 프로토콜 위반 메모: 셸은 Session Lead가 혼자 직접 구현함 (유저가 지적) — 정상 플로우는 compose-team → sprint-leader → worker

### FEEDBACK: Line count 보고는 `wc -l` 실측 사용 (2026-04-13)
- coding-agent 가 "78줄" 보고 → WM `wc -l` 실측 82줄 → 4줄 drift 발견 → agent 원인 확인: 눈짐작
- **Rule**: Agent 보고의 line count 무비판 수용 금지. 신규 파일 file-map 등록 시 **항상 `wc -l` 실측 확인**
- **Why**: Agent 가 Write 할 때 멀티라인 callback/함수 분리를 눈짐작으로 세면 ±3~5줄 drift 발생 가능. file-map 의 줄수는 feasibility 계산 근거 (total context 추정) 이므로 정확해야 함
- **How to apply**:
  - WM side — disk read 기본 (이번 flow 로 확립)
  - drift 발견 시 disk 값 채택 + agent 에게 flag (silent correction 금지)
  - 향후 다른 agent 도 동일 실수 가능성 있으므로 통용 규칙

### ORIGIN: Task #30 Phase 1 MVP — Canvas Entity Foundation (2026-04-13)
- 신규 10파일 936줄 + DeskHome.tsx 53줄 재작성 (90→53, Canvas 통합하며 코드 감소) + package.json 5 deps
- **Authority**: ADR-006 `.claude/docs/decisions/006-canvas-entity-foundation.md` Decided (§5.1 구조, §5.2 entity model, §5.4 viewport intersection, §5.9 warn threshold, §5.10 extension points, §5.11 FIFO)
- **구조 결정**: `Canvas > ViewportContainer > EntityLayer > Entity` (ADR-006 §5.1). EntityLayer 가 lifecycle supervisor (Option 3A, §5.3)
- **WHY discriminated union + adapter pattern**: Entity type 확장성. Phase 2+ 에서 FIFO 로 Note→Text→Image→Link... 추가될 때 adapter 만 추가하면 되는 구조 (§5.10)
- **WHY d3-zoom**: 표준 pan/zoom 라이브러리. scaleExtent [0.2, 4], modifier-only filter (Space/Meta/Ctrl 로 pan). ADR-001 Canvas Library Reference 검토 결과 채택
- **WHY html-to-image**: suspend 시 DOM snapshot → `<img>` replace (메모리 절약). data-screenshot-skip attribute 로 동적 요소 제외
- **구현 특이점**:
  - `store.tsx` — 원래 계획 `.ts` 였으나 JSX (Context Provider) 사용으로 `.tsx` 확장자 변경
  - Zustand 없이 순수 React useReducer + Context — 디펜던시 최소화
  - hydrated>20 일 때 dev console warning (§5.9 memory safety)
- **RELATIONSHIP**:
  - Edge hooks (`src/renderer/src/hooks/`) vs Canvas hooks (`src/renderer/src/canvas/hooks/`) 분리 — scope 명확
  - DeskHome.tsx 가 CanvasStoreProvider 래핑 + Canvas 마운트. Pan Immersion (Task #13) 과 공존
  - ContextualHUD/DebugPanel 은 pan immersion + canvas 둘 다 wrapper 밖 유지
- **다음 Phase (Phase 2)**: Entity Type 추가 (§5.11 FIFO). NoteAdapter 패턴 복제

### ORIGIN: Task #13 Pan Immersion Mode v1 — Edge fade scope 결정 (2026-04-13)
- `src/renderer/src/hooks/usePanImmersion.ts` (82줄 신규) + `src/renderer/src/DeskHome.tsx` (44→90줄 수정)
- **WHY scope 제한**: Space/Cmd + mouse drag (pan) 중 canvas 몰입도 확보를 위해 Edge UI fade-out. 하지만 ContextualHUD/DebugPanel 은 wrapper 밖 → pan 중에도 계속 표시
- **RELATIONSHIP**: HUD 는 현재 활성 task 의 contextual tools (pan 중에 꺼지면 작업 흐름 단절), DebugPanel 은 개발자 진단 (fade 대상 아님). DeskRail/Dock/PresetBag 은 global navigation → fade OK
- **동작 상세**: (Space | Meta | Ctrl) hold + mouseDown → isPanning=true. keyup/mouseup/5s idle/window blur → false. 텍스트 input focused 시 Space 무시 (타이핑 중 오인 방지)
- **구현 패턴**: 3 Edge 를 `edgeWrapperClass` div (opacity 150ms transition) 로 감쌈, HUD/Debug 는 wrapper 밖 DOM
- **향후 Canvas Toolbar 연동 가능성**: 배치 3 의 Canvas Toolbar 도 pan 중 fade 할지 결정 미정 — SPEC §9-1 참조 필요

### DONE: Task #6 DeskHome.tsx v1 재작성 (2026-04-10)
- `src/renderer/src/DeskHome.tsx` 40줄 dark placeholder → 44줄 LIGHT + 4-Edge 통합 완료
- 구조: L0 Canvas Surface (`.paper-surface`) + L3 Edge System (DeskRail/Dock/PresetBag/ContextualHUD) + debug-panel
- 수행: design-agent (WM+PM 병렬 리뷰 프로토콜 준수), typecheck node+web 양쪽 0 errors
- PM 리뷰: HR1~5 PASS, 조건 1 PASS, 조건 2 옵션 B(주석) 수락
- 4-Edge 컴포넌트/icons/App.tsx/main.tsx/globals.css 모두 원본 보존 (scope 엄격 준수)

### REJECTED: `.mcp.json`의 `"type": "url"` MCP 서버 형식 (2026-04-10)
- 시도: `openpencil` 엔트리를 `.mcp.json`에 `"type": "url"` 형식으로 선언 (HTTP endpoint 방식)
- 실패: Claude Code `/doctor` 에러 — `mcpServers.openpencil: Does not adhere to MCP server configuration schema`
- 영향도: 파일 **전체 파싱 실패** → 정상 선언된 다른 6개 엔트리(playwright-electron 포함)도 **모두 로드 안 됨**. 단일 스키마 위반이 설정 전체를 무력화함
- WHY: Claude Code MCP config 스키마는 stdio 기반 `command`/`args` 형식만 허용 (혹은 이후 스펙 변경 전까지). `type: url` 같은 URL/HTTP 기반 서버 형식은 미지원
- 해결: 2026-04-10에 openpencil 엔트리 제거 (design-agent). 6개 엔트리만 유지
- 후속 원칙: `.mcp.json` 편집 시 반드시 `python3 -c "import json; json.load(open('.mcp.json'))"` + `/doctor` 둘 다 검증. 스키마 위반은 개별 엔트리가 아니라 파일 전체를 무력화하므로 "다른 서버는 그래도 뜨겠지"는 **틀린 멘탈모델**

### ORIGIN: design-agent v3.1 patch — OpenAI frontend-skill 4 additions (2026-04-11, v29)
- `.claude/agents/design-agent.md`: 586 → 624 lines (+38), 29615 → 31593 bytes (+1978)
- `.claude/agents/design-agent.draft.v3.1.md`: 신규 624/31593 (production 과 byte-equivalent archive)
- 소스: `github.com/openai/skills/.curated/frontend-skill/SKILL.md` 의 'Apps' + 'Utility Copy For Product UI' 섹션
- 4 additions: (1) Card philosophy `<Constraints>` L133 (2) Utility copy `<Execution_Policy>` L285 (3) Operator scan test `<Final_Checklist>` L507 (4) External reference `<Investigation_Protocol>` L206
- WHY: OpenAI frontend-skill 의 Apps/Utility Copy 섹션이 EG-Desk 의 restrained/Linear-style 방향과 정합. Anthropic frontend-design 과 다른 design philosophy — EG-Desk 는 OpenAI 방향 차용. 두 skill 은 같은 이름 유사성에도 불구하고 서로 다른 원칙. Landing/Imagery/Hero 섹션은 무시 (OpenAI skill 내에서도 EG-Desk 무관).
- Dogfooding #2 (meta, strong-claim violation): team-lead 이 이전 세션에서 'frontend-design is incompatible with EG-Desk' 주장 — Anthropic 버전만 본 실수. 두 skill identity 혼동. sprint-leader v24 '잔재 없음' dogfooding #1 에 이은 두 번째 사례.
- **Meta Lesson (중요)**: **External skill identity 가 uncertain 할 때 (출처/이름 충돌 가능성) 반드시 WebFetch 로 primary source 확인 후 분석. 이름 기반 추정 금지.** 이름 ambiguity 는 강한 주장 전 verification 대상. 재발 방지.
- RELATIONSHIP: v3 (585/29614) → v3.1 (624/31593) successor, v3 archive 보존 (base/diff 용), v1.1/v2 도 보존
- 작업자: team-lead one-shot general-purpose agent Write overwrite (Bash cp → sandbox denial → Write 전환, byte-equivalent 결과 달성)

### ORIGIN: agent-factory skill 강화 — 5 role presets + 8 principles + sections catalog (2026-04-11, Task #10 v30)
- `~/.claude/skills/agent-factory/` user-level skill 확장 (one-shot general-purpose agent 수행, team-lead dispatch)
- 4 files / 438줄 total: SKILL.md (153줄/5256B — 97줄에서 확장), roles.md (133줄/5143B, 신규), principles.md (84줄/4485B, 신규), sections.md (68줄/3404B, 신규). mtime 2026-04-11 19:27-19:28
- **5 role presets (roles.md)**: Orchestrator / Worker-Writer / Consultant / Reviewer-Validator / Researcher-Explorer — agent template 생성 시 starting point 로 역할별 구조 제공
- **8 swarm-wide principles (principles.md)**: Context Locality / Status taxonomy 4-state / Strong Claim Verification bidirectional / Writer-verifier split / Hook integration awareness / Language / Response format / files_created — 모든 project agent template 이 준수해야 할 공통 원칙 catalog
- WHY: 이전 agent-factory 는 개별 template 생성만 지원. 반복되는 patterns (5 roles) 과 enforce 되어야 할 rules (8 principles) 가 implicit 했음. Catalog 로 명시하면 (1) template author 가 match 하는 role 을 선택만 하면 됨, (2) 생성된 template 이 principles 에서 벗어나지 않도록 enforce, (3) swarm-wide consistency 확보. 직전 세션의 sprint-leader/design-agent dogfooding 두 건 (strong_claim_verification 위반) 이 principles.md 에 codify 되는 계기.
- RELATIONSHIP: compose-team v28 contract pair 와 symmetric — compose-team 은 *runtime routing* 주입 (sprint-leader.md 가 target), agent-factory 는 *authoring-time role/principles* 주입 (`.claude/agents/` 의 template 들이 target). 둘 다 user-level skill → project-level artifact 의 2-level parent pattern.
- **Meta observation (중요)**: 한 세션 내에서 **2-level parent pattern 이 2번 적용**됨 — v28 compose-team (sprint-leader.md entry 안 contract pair) + v30 agent-factory (`.claude/agents/` entry 안 generator cross-reference). Pattern reusability 입증. 향후 user-level skill 이 project-level artifact 집합을 대상으로 할 때 default convention.
- 파일 source (user-level): `~/.claude/skills/agent-factory/` — 개별 file-map entry 없음 (user-level). 참조는 `.claude/agents/` directories entry 의 Generator cross-reference 섹션.
- Task #10 = 이번 세션 작업 종결 지점 (team-lead 명시)

### ORIGIN: compose-team ↔ sprint-leader contract pair (2026-04-11, Task #9 v28)
- `~/.claude/skills/compose-team/SKILL.md` (user-level, 118→224 lines) 와 `.claude/agents/sprint-leader.md` (project-level, 452 lines) 가 contract pair 형성
- compose-team Step 4 `sprint_leader_routing` 필드 (7 subfields: pm_agent / wm_agent / validator_templates / worker_templates_available / project_context_sources / language / response_format) 가 sprint-leader template 의 generic `<Role>` abstraction 을 runtime 에 concrete 하게 overlay
- compose-team Step 5 `session_lead_spawn_instructions` 필드 가 5-item handoff bundle 계약 정의
- WHY: sprint-leader.md 는 Task #8 에서 project-agnostic template 로 생성됨 (Context Locality 0 hardcodes). Cross-project 통용 위해 project-specific routing 은 spawn 시 compose-team 이 JSON overlay 로 주입, template 본문 불변
- Backwards-compat: single-agent task 에선 compose-team General Rules #6 가 `sprint_leader_routing` / `session_lead_spawn_instructions` skip
- REJECTED: sprint-leader template 본문에 project-specific routing 삽입 (Task #8 때 고려했으나 Context Locality Principle 위반으로 거부)
- RELATIONSHIP: compose-team 이 project-profile.md 를 Read → §7 Agent Infrastructure (pm, agents, skills, MCP) 를 pluck → `sprint_leader_routing` JSON 에 overlay → sprint-leader 가 spawn prompt 에서 받음
- 파일 source (user-level): `~/.claude/skills/compose-team/SKILL.md` — 이 프로젝트 file-map.json 에는 개별 entry 로 기록 안 됨 (user-level), sprint-leader.md entry 의 Contract pair 섹션에만 상호 참조 기록

### REJECTED: `import.meta.env.DEV` 조건부 렌더 (2026-04-10, Task #6)
- 시도: DeskHome.tsx debug-panel을 `{import.meta.env.DEV && (...)}` 로 감싸 prod 빌드 자동 제거
- 실패: TS2339 (Property 'env' does not exist on type 'ImportMeta')
- 원인: `tsconfig.web.json`이 `@electron-toolkit/tsconfig` extends — `vite/client` types 미포함
- Fallback: 주석 방식 `TODO: remove before prod release` + 수동 제거
- 해결 sub-task (future): `src/renderer/src/vite-env.d.ts` 생성 또는 tsconfig.web.json에 `"types": ["vite/client"]` 추가
- 영향: prod 빌드 전 debug-panel 수동 제거 필요. Task 별도 생성 고려

## File Mapping Notes
<!-- Important file locations, relationships, and size observations -->

## Topic Files
<!-- When this file approaches 200 lines, move details to separate files: -->
<!-- - file-patterns.md: recurring file organization patterns -->
<!-- - size-reports.md: agent feasibility / file size analysis results -->
<!-- - conventions.md: project-specific naming and structure rules -->
