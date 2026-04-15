---
name: Context Locality Principle — 다른 agent 의 domain content 복제 금지
description: Agent template 이 다른 agent 의 소유 영역 content 를 copy-paste 로 포함하면 role boundary 위반. Context 는 소유자에게 있고, 런타임 DM 으로 전달된다
type: feedback
---

**Rule**: **Agent template must not duplicate another agent's domain content. Context lives where it's owned; it travels via runtime DM.**

Agent template 을 작성/리뷰할 때:
1. 그 template 안에 다른 agent 의 owned territory (예: PM 의 `docs/`, `ideas/`, `.claude/docs/`) 에서 가져온 내용이 copy-paste 돼 있는가?
2. 있다면 **role boundary violation**. 제거하고 "필요 시 [owner-agent] 에 DM 해서 최신 context 요청" 으로 치환.

**Why**:
2026-04-10 sprint-leader 가 `.claude/agents/design-agent.draft.md` 를 생성할 때 `docs/vision/ontology-bridge.md` (PM-owned territory) 의 Ontology Bridge 철학 30+ 줄을 `<Why_This_Matters>` 블록에 그대로 **copy-paste** 했다. 유저가 지적 → team-lead 가 파일 존재 여부를 직접 확인 (WM 영역 shortcut, 이것도 role 위반) → PM template (egdesk-pm-agent.md) 의 Write 영역 선언을 검증해서 `docs/` 전체가 PM-owned 임을 확인.

**왜 이게 문제인가**:
- **Staleness**: PM 이 철학을 업데이트하면 designer template 의 copy 는 stale. 두 copy 가 영원히 drift.
- **Source of truth 오염**: Designer 가 자기 template 에 박힌 철학을 "내가 아는 것" 으로 착각. PM 이 실제 source 이라는 사실이 흐려짐.
- **DM channel 의 존재 이유**: Agents 는 DM 으로 소통하라고 만들어졌는데, copy-paste 가 그 채널을 우회함. "필요하면 PM 에게 물어봐" 라는 명시가 없으면 designer 가 PM 에게 context 를 요청할 동기 자체가 없음.
- **Template 비대화**: Agent prompt 가 다른 domain content 로 부풀면 LLM context window 낭비 + 프롬프트 유지보수 난이도 상승.

**How to apply** (WM feasibility + file mapping 단계에서):

1. **file-map 에서 PM-owned 디렉토리 표시**: `docs/`, `docs/production/`, `docs/vision/`, `docs/references/`, `.claude/docs/`, `ideas/` 전부 "★ PM-OWNED" 마크 + "Context Locality Principle 적용" 주석. 2026-04-10 file-map v15 부터 적용.

2. **Feasibility 에서 경고**: Task 가 철학/비전/PRD content 를 필요로 하는데 해당 agent 가 owner 아니면 feasibility notes 에 명시:
   > "이 task 는 ontology-bridge.md (PM-owned) 철학이 필요함. Worker agent prompt 에 내용 embed 금지 — sprint-leader 가 런타임에 PM 에게 DM 해서 context 받아서 worker 에게 전달하는 flow 권장"

3. **Agent template 리뷰 시** (agent-factory 호출 전후에 WM 이 patterns 감지 가능하면 경고):
   - 눈에 띄는 copy-paste 흔적: 긴 인용 블록, `<Why_This_Matters>` 류 철학 설명, 다른 agent 이름 언급
   - Template 리뷰 요청이 오면 "이 블록은 어느 source 에서 copy 했는가? Owner 가 다르면 runtime context 로 전환해야 함" 이라고 반환

4. **Owner 매트릭스 유지**: PM 만 명시적 Write 영역이 있지만, 다른 agent 도 owned territory 가 있을 수 있다:
   - `egdesk-pm-agent`: `docs/`, `ideas/`, `.claude/docs/`, `.claude/wm/project-profile.md` (단, 이것은 WM 과 공동 관리 — 주의)
   - `wm-agent`: `.claude/wm/` 전체, `.claude/agent-memory/wm-agent/`
   - `design-agent`: 없음 (읽기만, code 는 coding-agent 가 씀)
   - `coding-agent`: `src/` (application code)
   - **주의**: `.claude/wm/project-profile.md` 는 PM 과 WM 둘 다 Write 가능 선언돼 있음 → 경계 충돌 가능성. 실제로는 WM 이 auto-maintain, PM 은 touched 안 함. 만약 PM 이 project-profile.md 를 수정하면 WM 에 DM 해서 알려야 함 (반대도 마찬가지).

5. **Retroactive 검토**: 현재 existing agent templates (`.claude/agents/*.md`) 에도 이 위반이 있는지 주기적 감지. Scan 대상:
   - `egdesk-pm-agent.md` — self-owner 라서 copy 문제 없음
   - `design-agent.md` (현행 251줄) — Figma MCP 기반이라 아마 design system 만 embed. 검토 필요.
   - `design-agent.draft.md` (현행 449줄) — **이미 위반 확인됨**. Context Locality v1.1 patch (Task #5) 에서 strip 중.
   - `paperclip-analyzer-agent.md` — 검토 미완료
   - 향후 agent 추가 시 review step 에 이 체크 포함

**파생 원칙 — Dual Ownership 규칙 (2026-04-10 추가)**:
`.claude/wm/project-profile.md` 같이 두 agent 가 Write 영역으로 선언하는 경우:
- Primary owner 는 실제로 유지하는 agent (WM)
- Secondary owner 는 read 우선, write 시 primary 에 DM 통보
- Template 에서 secondary owner 의 write 권한을 **제거**하거나 **"WM 에 DM 후 write"** 로 제한 명시

**Cross-ref**:
- `feedback_shelf_scope_filter.md` — shelf scope miss 와 마찬가지로 "추측 대신 검증" 패턴
- `origin_design_agent_refactor_draft.md` — Context Locality 위반 사례가 발생한 draft 의 출처
