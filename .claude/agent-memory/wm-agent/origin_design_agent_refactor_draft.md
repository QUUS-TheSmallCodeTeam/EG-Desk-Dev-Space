---
name: design-agent 리팩터링 draft 생성 (2026-04-10)
description: design-agent 템플릿을 Figma MCP 기반에서 HTML/React + Playwright 검증 기반으로 리팩터링한 draft 의 기원/WHY/후속조치
type: project
---

**Fact**: 2026-04-10 에 `.claude/agents/design-agent.draft.md` (449줄) 생성됨. 기존 `.claude/agents/design-agent.md` (251줄) 는 보존 상태. 유저 검토 후 draft 가 `.md` 로 rename/replace 될 예정.

**Why**:
프로젝트 설계상 디자인 툴 전략이 2026-04-10 전면 전환됐는데 (`project-profile.md` §7 line 153: "Figma/Stitch/Pencil 계열 디자인 MCP는 2026-04-10 이후 전면 폐기 결정. HTML/React 직접 작성 + Playwright 스크린샷 검증이 현재 워크플로우") design-agent 템플릿은 여전히 "Figma MCP (via Codex CLI) 기반 UI/UX 디자이너" 로 선언돼 있어서 완전히 stale. Task #6 (DeskHome.tsx v1 구현) 을 기존 design-agent 로 돌렸을 때 프로토콜 충돌이 발생하지 않은 건 운이 좋았고, 앞으로 재사용하려면 명시적으로 현행 워크플로우에 맞춰야 한다.

유저 원요청: "디자이너는 혹시 우리 서재에 있는 수많은 agent 들 참고 자료에서 쓸만한 config 들 뽑아서 우리 디자이너 에이전트 prompt로 쓸만한거 없는지부터 작업해보자."
Team-lead 재frame: META task (agent prompt engineering research), `design-agent` 본인은 spawn 금지 (bootstrap paradox — 약한 designer 가 강한 자기 버전을 못 만듦 + role mismatch).

**핵심 변경점 (draft 내용, sprint-leader 보고 기준)**:
1. Figma MCP 워크플로우 완전 제거
2. XML-tagged skeleton 도입 (`references/omc-scan/agents/designer.md` 골드 스탠다드 차용)
3. Writer/verifier 분리 명문화 (기존 template 은 한 agent 가 design + implement + verify 혼재)
4. `playwright-electron` MCP 를 verification gate 로 격상 (draft 가 screenshot 검증을 필수 단계로 강제)

**Draft v1 입력 소스 (2026-04-10 previous session, E1/E2/E3 only)**:
- `subagent_reports/20260410_explorer-1-direct-hits_designer_prompt_patterns.md` (520줄) — Tier A: OMC, bkit, awesome-openclaw creative (brand-designer, ux-researcher, thumbnail-designer)
- `subagent_reports/20260410_explorer-2-vendor-shipped_designer_prompt_patterns.md` (662줄) — Tier B: Anthropic frontend-design, Google CodebaseInvestigator/BrowserAgent/analyzeScreenshot
- `subagent_reports/20260410_explorer-3-orchestrator-blueprints_designer_prompt_patterns.md` (267줄) — Tier C: 23 orchestrator patterns 스코어링 (14 direct / 7 adapt / 2 incompatible)
- `.claude/agents/design-agent.md` (기존, 251줄) — refactoring base
- `ideas/brainstorming/DESIGN_SYSTEM_SPEC.md` (436줄, 2026-04-10 실측) — source of truth for LIGHT/#F5F3EF/Inter/4-Edge Framework
- `.claude/wm/project-profile.md` — Figma 폐기 근거

**RELATIONSHIP**:
- 기존 `design-agent.md` (251줄, Figma MCP 기반) 은 **보존** 중. 유저 검토 후 draft → main 교체 결정 대기.
- 이 리팩터링은 직전 ORIGIN 엔트리 (`Electron + Vite + React + Tailwind 셸 직접 구현`, 2026-04-10) 와 같은 프로젝트 전환의 **agent-template-layer 반영**. 코드 셸은 먼저 전환됐고, 에이전트 템플릿은 이제 따라잡는 중.
- Draft v1 의 3개 explorer 리포트 (E1/E2/E3, 합 1449줄) 는 **입력 아티팩트**. Draft 가 rename/replace 되면 이 리포트들은 (a) 보존 참조용, 또는 (b) 이력 정리 후 삭제/archive 대상. 유저 결정 필요.
- **E4/E5/E6 는 draft v1 이후 추가 조사** — team-lead 가 WM 초기 scope miss 를 유저 지적 받고 복구, Task #6 v2 iteration 의 입력. (E4: gstack+bkit gold 843줄, E5: shelf gaps 502줄, E6: web research 532줄. Timestamp 증거: E4 23:23 / E5 23:26 / E6 23:28 vs draft v1 생성 23:13 — draft v1 생성 시점에는 존재하지 않았음)
- **Draft v1.1 (2026-04-10 current session)**: Context Locality 긴급 패치 — Why_This_Matters 30줄 copy-paste 제거, `<Handoff_Patterns>` 섹션 신설, `docs/vision/ontology-bridge.md` 참조 4곳 제거. Role ownership 검증 없이 /agent-factory 호출한 sprint-leader 실수의 교훈. v1.1 결과 458줄 (v1 449줄 대비 +9줄 순변화 — strip 효과와 `<Handoff_Patterns>` 신설 효과가 상쇄)

**How to apply**:
- 다음 session 에서 `.claude/agents/design-agent.draft.md` 가 `.md` 로 rename 됐는지 확인 → MEMORY.md 이 엔트리 업데이트 ("TRANSITIONED" 상태로 변경)
- Draft rename 후 기존 251줄짜리 `.md` 는 삭제되므로 file-map 에서도 엔트리 제거 필요
- 새 design-agent 가 사용되는 첫 작업에서 프로토콜이 제대로 작동하는지 확인 (특히 writer/verifier 분리가 실제 agent spawn 시 준수되는지)
- Draft 가 기각되면 이 ORIGIN 엔트리를 REJECTED 로 격하 + 이유 기록
