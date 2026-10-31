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

### STATE: WM 저장소 stale 확인 — apps/firefox-ui-demo 미등록 (2026-10-31 세션 시작 스캔)
- `file-map.json` v35 (2026-04-14) + `project-profile.md` (2026-04-10) 모두 Electron 시대 기준. `apps/firefox-ui-demo/` 디렉토리·파일 entry 0개. inventory hash 불일치 (20d12b26 → 0598a3c6)
- 실측: 살아있는 코드는 `apps/firefox-ui-demo/` (ADR-007 2026-04-17 Firefox shell pivot). 최근 100 커밋 중 src/ 터치 0. `src/` (Electron, 4,535줄)는 마지막 커밋 2026-05-20 chore — deprecated 취급
- 규모: overlay/JS/eg-desk-surface.uc.js 21,544줄 단일 파일(!), overlay/resources/*.sys.mjs 67개, helper 비테스트 94파일/34,154줄, scripts 비테스트 66파일/39,717줄, 테스트 ~98k줄. feasibility 판단 시 surface.uc.js 는 한 agent 컨텍스트 초과 — 반드시 섹션 단위로 쪼개 매핑
- 테스트 러너: `node --test` (vitest/jest 없음). Firefox 실행 테스트 = `scripts/verify-firefox-mcp-*.mjs` (24개) + .test.mjs 7개 (cookie-import, popups, browser-import-flow, headless-ui-regression, first-codex-auth-flow, clean-profile-boot, run-egdesk-windows). 고정 Node 24.22.1 → `apps/firefox-ui-demo/.tmp/node-runtime/`
- TODO: Session Lead 요청 시 file-map 재구축 (대규모 — `/onboard` 재실행 수준). 이번 세션은 즉석 스캔 보고로 대체

### ORIGIN: 2026-10-31 야간 자율 라운드 — firefox-ui-demo 기능 모듈 분리 (586e348..7a5a031, file-map v36)
- 14개 병렬 세션(브랜치별 `.claude/worktrees/<name>/`), 12개를 `claude/vision-gap-20261024` 에 `--no-ff` 병합 → 7a5a031 (push 없음). 라운드 보고서 `.tmp/overnight-20261031/REPORT.md`. cnv-06-canvas-memo·ux-05-placement-ops 는 중단(미병합)
- ledger → 산출물: CTX-02 helper/egdesk-recovery-journal / UX-02 EGDeskCanvasLayout 미니맵 / SUB-14 helper/codex-auth-state 접근 상태 / AGENT-05 EGDeskAgentIdentityView / BRW-05·07·11 EGDeskBrowserGrant + helper/egdesk-browser-tool-runtime(navigate·카드 관리·권한 수명) / BRW-09 EGDeskScreenshotMask + EGDeskBrowserAgentRuntimeParent·Child / CHAT-03 EGDeskThreadRouting / CNV-03 EGDeskBoardMembership / CODE-02 helper/egdesk-project-identity / CODE-05 EGDeskChangeReview 2단계 / CODE-06 helper/egdesk-run-result-parse·egdesk-terminal-run-watch + docs/RUN_RESULT_SURFACE.md / SUB-05 EGDeskAccountSettingsView
- **WHY 모듈 분리**: uc.js(22,878줄) 비대화 회피 — 신규 기능은 기능 단위 `EGDesk*.sys.mjs`(overlay/resources, pure 뷰모델) 또는 helper `.mjs` 로 분리, 기존 EGDeskChatState 패턴 유지. 각 모듈에 단건 `node --test` 파일 짝 (resources 모듈 테스트 → scripts/egdesk-*.test.mjs, helper 모듈 테스트 → helper/*.test.mjs 같은 폴더)
- **REJECTED**: 없음 (세션 보고에 기각 대안 기록 없음)
- **RELATIONSHIP**:
  - EGDeskBrowserGrant 는 BRW-05·07·11 과 BRW-09 가 공유 — BRW-09 브랜치가 BRW-05 브랜치를 먼저 병합해 충돌 해소. 충돌 파일: helper/egdesk-browser-tool-runtime(.test).mjs, helper/codex-browser-tool-provider
  - EGDeskScreenshotMask ↔ EGDeskBrowserAgentRuntimeParent(캡처·페인트) / Child(측정) — mask 모듈이 판정, fail-closed
  - CODE-06 체인: helper/egdesk-run-result-parse(runSummaryEnd) → egdesk-terminal-run-watch → /terminal/read runResult → resources/egdesk-terminal-init.js postMessage → surface/EGDeskSurfaceTerminal → EGDeskRunResult(chrome 렌더) → surface/EGDeskSurfaceFileCard.openBoardProjectFileAt. 파서 로직이 helper/chrome 양쪽에 존재하는 것은 의도된 짝
  - EGDeskThreadRouting 은 helper codex-chat-runtime 의 shareMessages(POST /chat/share) 를 쓰고, 멘션 규칙은 helper boardMentions 와 **동일하게 유지**해야 함 (양쪽 수정 필요)
  - helper/egdesk-project-identity 는 egdesk-file-http(live root 비교) 와 egdesk-project-store(저장 identity; projectReconnectState 재export) 가 공유
  - EGDeskBoardMembership → EGDeskCanvasLayout(add/removeProjectionMember, regionDropSuggestion) + EGDeskSurfaceState(planBoardProjection)
  - **회귀 함정**: `scripts/egdesk-chat-presentation.test.mjs` 는 uc.js Chat 헤더 칩 블록을 문자열로 잘라 vm.compileFunction — 그 블록에 새 심볼을 넣으면 테스트 키 목록도 바꿔야 함 (이번 라운드 회귀 1건 원인). uc.js 해당 블록 수정 agent 에게 반드시 전달
- **TEMPORARY**: `.tmp/overnight-20261031/` 라운드 보고 산출물(커밋 대상 아님). `.claude/worktrees/*` 14개 worktree — 병합 완료 후 정리 대상
- **환경**: 테스트는 고정 Node 24.22.1 로 — `apps/firefox-ui-demo/.tmp/node-runtime/node-v24.22.1-darwin-arm64/bin/node`. 핀 파일은 `apps/firefox-ui-demo/.node-version` (Session Lead DM 은 `.nvmrc` 라 했으나 disk 실측 `.node-version`; `.nvmrc` 는 프로젝트에 없음). egdesk-file-http·desk-store 테스트의 node:sqlite 요구 버전 충족용
- **file-map 커버리지**: v36 은 이 라운드의 66개 파일 + apps/firefox-ui-demo 디렉토리 골격(14개) + `.tmp/`·`.claude/worktrees/` 만 등록. 나머지 (helper 비테스트 ~98 .mjs, scripts ~178, resources 35 중 미등록분) 는 `/onboard` 재실행 TODO 유지 — 위 STATE 항목 참조

### ORIGIN: 2026-10-31 2차 라운드 — CHAT-01 방 Agent 영속화 · CHAT-08 게시 결과 칩 (1011163..1a2f304, file-map v37)
- 세션 2개(worktree `.claude/worktrees/chat-01-agent-persist-901f75`, `chat-08-output-chips-ceb480`). CHAT-01 커밋 66d4162·c34e2d9·47f7c4f·7fb5089, CHAT-08 6f4b4fb·69d205c, 병합 9e45e00·1a2f304 (충돌 없음, push 없음). 보고서 `.tmp/overnight-20261031/REPORT.md` "2차 결과·병합 점검" 절. 1차 v36 file-map 은 커밋 1011163 에 포함됨
- **WHY (CHAT-01)**: Desk pref(`profileEnabled === true`)가 store agent 보다 우선, store 는 pref 가 비었을 때만 채움 — 사용자가 보내기 없이 바꾼 최신 선택을 지키기 위해. `thread.agent` 는 떼지 않고 명시 필드로 유지(서버 snapshot 값으로 항상 덮어씀), revision 은 복원에 적용 안 하고 보존·전달만. `/chat/rooms/agent` 를 LOCAL_WRITES(ensureAuth 면제)로 둔 이유: 로컬 저장소 쓰기라 `/chat/history/import` 와 같은 성격 + 로그아웃·오프라인에서도 선택을 남겨야 함
- **WHY (CHAT-08)**: 칩 로직을 `mountCodexHUD` 밖 새 함수(`buildCodexOutputChips`·`openPublishedOutputChip`)에 두어 메시지 렌더 블록 접촉면을 3줄로 최소화(병합 충돌 회피 — 1차 교훈 반영). 카드 본문은 CHAT-04 와 같은 ≤20,000자 사본 저장 — **D-K3 미결**: 'reference only' 로 정해지면 `publishedOutputCardRecord` 의 text 만 비우고 복원 시 읽기
- **REJECTED**: CHAT-01 — 화면 thread 에서 agent 필드 제거안(명시 필드 유지로 대체). CHAT-08 — helper 수정(불필요: `codex-chat-runtime.mjs snapshot()` 이 run 을 통째 copy 해 `context.outputs` 가 이미 overlay 도달), `/context/outputs` 목록 라우트 사용(칩이 versions 보유하므로 불필요)
- **RELATIONSHIP**:
  - **회귀 함정 2호**: `scripts/egdesk-surface-state.test.mjs` 는 uc.js `setThreadAgentProfile(threadId, profileId) {` ~ `cycleThreadAgentProfile(threadId) {` 블록을 잘라 compileFunction(L4760) — 그 블록에 새 식별자를 넣으면 keys 도 함께 (chat-presentation 과 같은 함정). uc.js 매핑 시 두 테스트 모두 context 로 전달
  - CHAT-08 결과 카드 기록 `source.outputId/outputKey/outputVersion` 은 CHAT-04 결과 카드(`spawnResultCard`)와 Desk 저장 type 공유 — 카드 키 `{room}/output/{key}`. 기존 시험 기대값 1건 변경(`spawnResultCard(` 호출 수 4→5)
  - CHAT-01 체인: uc.js `setThreadAgentProfile` → POST /chat/rooms/agent (codex-bridge-http CHAT_ACTIONS) → codex-chat-runtime `setRoomAgent` → store.setRoomAgent(폴백 setThreadAgent) → 재시작/복원 시 EGDeskChatState `restoredRoomAgentFields` ← uc.js `ensureLocalHistoryThread`. 양쪽 history 라우트가 같은 agent 를 보고해야 함(verify-chat-history-restart.mjs assertRoomAgent)
- **TEMPORARY — 위치 확정 (2026-10-31 15:4x, Session Lead 확인)**: 2026-10-31 라운드 세션 인계 노트 16개(2차 `chat-01-agent-persist.md` 3,471B·`chat-08-output-chips-handoff.md` 6,238B + 1차 14건: agent-05, brw-05-07-11 handoff/plan, brw-09, chat-03 handoff/plan, cnv-03, code-02, code-05-plan, code-06, ctx-02, sub-05, sub-14, ux-02)는 `~/Library/Application Support/Claude/side-session-notes/local_e667fc3f-9d17-4fd4-b233-6da2867c4719/` 에 있음 — Claude 데스크톱 앱이 이 main 세션에 연결된 side session 들에게 주는 공유 노트 폴더(앱 관리, 프로젝트 밖·git 밖, 세션별 폴더; WM 의 프로젝트·worktree·~/.claude 탐색 범위 밖이라 처음엔 못 찾음). 내용은 임시(정본은 ledger/Contract/Atlas). 1차(2026-10-24) handoff 처럼 `docs/references/session-handoffs/2026-10-31/` 로 반입할지는 **유저 결정 사항**
- **미검증**: 실화면·재시작 프로브 미실행(세션 보고 기준). ledger 어휘 번역(일부→완료)은 PM 판단
