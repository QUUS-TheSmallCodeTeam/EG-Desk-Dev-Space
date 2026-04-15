# Agent Lifecycle — compose-team V2 설계안

> 담당 영역: Agent 3-tier lifecycle, fuzzy matching 재사용, registry cache, maxTurns, stocktake, enable/disable, self-evolution, single-threaded owner, CompiledSubAgent 재사용, agent.md 매번 생성 문제 해결

---

## 현재 문제

### 1. agent.md 매번 생성 문제 (핵심)

현재 compose-team → `/agent-factory` 흐름에서 **매 작업마다 새 agent template .md 파일을 생성**한다.

- "TypeScript API 구현" task에 `api-agent.md` 생성
- 다음 "TypeScript 컴포넌트 구현" task에 `component-agent.md` 생성
- 둘 다 사실상 `coding-agent.md`로 커버 가능

**결과**: `.claude/agents/`에 유사한 .md 파일이 누적, 디스크 오염, hook 스캔 성능 저하, 진짜 전문 agent와 일회용 agent의 구분 불가.

### 2. Lifecycle 미분류

모든 agent를 동일하게 취급:
- WM처럼 세션 내내 상주하는 agent
- 여러 task에 재사용되는 coding-agent
- 한 번 쓰고 버리는 조사 agent

이 셋이 같은 방식(`.md` 생성 + SubagentStart inject)으로 처리됨.

### 3. 재사용 검사 없음

compose-team이 "이 역할에 맞는 기존 template이 있는가?"를 확인하지 않음. WM의 agent 스캔은 존재하지만, compose-team skill 자체에 fuzzy matching 로직이 없음.

### 4. Agent 퇴역/정리 메커니즘 없음

더 이상 쓰이지 않는 agent template이 계속 남아 있음. Stocktake(재고 점검) 프로세스 부재.

### 5. maxTurns 미설정

agent가 무한 루프에 빠지거나 필요 이상으로 오래 실행되는 것을 제어하는 `maxTurns` 가이드라인이 없음.

---

## 적용할 패턴 (출처 + 이유)

### Core (P0)

| ID | 패턴 | 출처 | 이유 |
|---|---|---|---|
| L1 | 3-tier lifecycle | openclaw, best-practice | agent.md 매번 생성 문제의 **근본 해결**. ephemeral은 파일 미생성 |
| L2 | Fuzzy matching 재사용 | ECC team-builder | 기존 template 있으면 새로 만들지 않음 |
| T4 | 1 task = 1 agent (STO) | AO, Amazon | 명확한 소유권 + agent 간 혼선 방지 |
| T1 | 프로젝트 레벨 팀 캡 | bkit | 과잉 spawn 방지의 하드 리밋 |

### Supporting (P1)

| ID | 패턴 | 출처 | 이유 |
|---|---|---|---|
| L3 | agent-registry cache | openclaw | 스캔 비용 절감 + 빠른 매칭 |
| L4 | maxTurns 산정 | best-practice | 무한 루프 방지 + 비용 제어 |
| L5 | Stocktake verdict | ECC | 미사용 agent 정리 |
| L10 | Satisficing | 인지과학 | 과도한 최적화 방지 |
| M3 | Single-Threaded Owner | Amazon | multi-task 금지, focus 보장 |

### Enhancement (P2)

| ID | 패턴 | 출처 | 이유 |
|---|---|---|---|
| L7 | Self-Evolution | best-practice | 작업 후 agent template 자기 개선 |
| T2 (Theia) | Agent Enable/Disable | Theia AgentService | terminate 없이 비활성화 → 재활성화 |
| D-KT1 | Selective State Propagation | deepagentsjs | 공유할 것/격리할 것 선언적 제어 |

---

## Claude Code 구현 방법 (구체적)

### A. 3-Tier Lifecycle 분류

#### 정의

| Tier | 이름 | 파일 생성 | 수명 | 예시 |
|------|------|----------|------|------|
| **permanent** | 상주 agent | `.md` 존재 (user/project level) | 세션 전체 | wm-agent |
| **reusable** | 재사용 agent | `.md` 존재 (project level) | 여러 task에 재파견 | coding-agent, explore-agent |
| **ephemeral** | 일회용 agent | `.md` **미생성**, inline prompt만 | task 완료 시 소멸 | "이 PR 리뷰해줘" 일회성 |

#### compose-team 출력에서 lifecycle 결정

compose-team이 각 agent에 `lifecycle` 필드를 출력:

```json
{
  "agents": [
    {
      "name": "coding-agent",
      "template": "coding-agent",
      "lifecycle": "reusable",
      "task": "API endpoint 구현",
      ...
    },
    {
      "name": "pr-reviewer-1",
      "template": null,
      "lifecycle": "ephemeral",
      "task": "PR #42 리뷰",
      "inline_prompt": "이 PR의 보안 취약점과 성능 이슈를 검토하라. OWASP Top 10 기준으로 점검.",
      ...
    }
  ]
}
```

#### 결정 로직 (compose-team SKILL.md에 내장)

```
task가 세션 내내 반복 호출되는가?
  └── YES → permanent (이미 .md 있어야 함. 없으면 /agent-factory로 생성)
  └── NO  → task가 2회 이상 유사 작업에 파견 가능한가?
      └── YES → reusable (기존 .md 매칭 시도 → 없으면 /agent-factory)
      └── NO  → ephemeral (파일 미생성, inline prompt)
```

#### Ephemeral Agent 구현

Session Lead가 ephemeral agent를 spawn할 때:

```python
# Session Lead가 실행하는 코드 (개념)
Agent(
  subagent_type="general-purpose",  # 범용 base
  name="pr-reviewer-1",             # 일회용 이름
  team_name="workspace",
  prompt=compose_team_output["agents"][1]["inline_prompt"]  # inline만
)
```

- `.md` 파일 미생성 → SubagentStart hook이 template 못 찾아도 OK (CASE C: inline prompt가 body 역할)
- task 완료 후 shutdown → `.tmp/agent-context/` 요약만 남음 (파일 오염 없음)

### B. WM Hard Contextual Read (template 재사용 검사)

> **설계 변경 (2026-03-29)**: 기존 fuzzy matching(compose-team 자체 LLM_judge) → WM hard contextual read로 교체.
> **이유**: compose-team이 파일 스캔 + 유사도 비교를 수행하면 "WM is your secretary" 원칙 위반. WM은 이미 filemap + agent template 메타데이터 + agent-file binding 이력을 보유하고 있어 더 정교한 매칭 가능.

#### 역할 분리

| | compose-team (Session Lead가 실행) | WM |
|---|---|---|
| **담당** | task decomposition, agentic flow 설계, phase 구조, orchestration 패턴 선택 | agent template matching, file mapping, context budget 산정 |
| **입력** | 유저 요청 + WM feasibility report | compose-team의 task 목록 + flow 설계 |
| **출력** | task 분해 JSON (lifecycle hint 포함, template 미결정) | 각 task별 matched_template + file mapping + budget |

#### 플로우

```
1. Session Lead → /compose-team
   - compose-team은 task decomposition + flow 설계만 수행
   - 각 task에 lifecycle_hint (permanent/reusable/ephemeral) 부여
   - template 필드는 `null`로 출력 (WM이 결정)

2. Session Lead → WM에게 DM: "이 task 목록으로 template matching + file mapping 해줘"
   - compose-team JSON 전달

3. WM이 hard contextual read 수행:
   - filemap에서 각 task의 대상 파일 식별 (크기, 의존성 포함)
   - agent-registry에서 기존 template 정보 확인 (frontmatter + 파일 이력)
   - template-file affinity: "이 template이 과거에 다룬 파일 영역" 참조
   - 매칭 결과 + file mapping + context budget 산정을 Session Lead에게 반환

4. Session Lead → 매칭 결과를 spawn prompt에 포함
```

#### WM 매칭 로직

WM은 filemap 기반으로 **실제 파일 맥락**을 읽고 판단:

```
for each task in compose_team_output.tasks:
    # 1. 대상 파일 식별 (filemap 참조)
    target_files = wm.filemap.find_relevant(task.description)

    # 2. 기존 template 중 이 파일 영역을 다룬 이력 확인
    candidates = wm.agent_registry.filter_by_file_affinity(target_files)

    # 3. 이력 없으면 template description 기반 매칭 (hard read, 추론 아님)
    if not candidates:
        candidates = wm.agent_registry.filter_by_role(task.description)

    # 4. 결정
    if candidates:
        → matched_template: candidates[0], lifecycle: "reusable"
    elif task.lifecycle_hint == "ephemeral":
        → matched_template: null, lifecycle: "ephemeral"
    else:
        → matched_template: null, prerequisite: "/agent-factory"
```

**핵심 차이**: fuzzy matching은 "역할 설명 텍스트 유사도"에 의존했으나, hard contextual read는 **filemap의 실제 파일 정보 + agent가 과거에 다룬 파일 이력**에 기반. WM이 상주 agent로서 축적한 맥락이 매칭 정확도를 높임.

#### 출력 결정

| WM 매칭 결과 | lifecycle | template 필드 | prerequisites |
|-------------|-----------|---------------|---------------|
| file affinity 일치 | reusable | `"coding-agent"` | 없음 |
| role 기반 일치 | reusable | `"coding-agent"` | 없음 (task에서 차이 커버) |
| 미일치 + 반복성 | reusable | `null` | `/agent-factory coding-agent — ...` |
| 미일치 + 일회성 | ephemeral | `null` | 없음 |

### C. Agent Registry Cache

#### 구조

`.tmp/agent-registry-cache.json` (세션 중 생성, git-ignored):

```json
{
  "generated_at": "2026-03-26T14:30:00Z",
  "templates": [
    {
      "name": "wm-agent",
      "path": "~/.claude/agents/wm-agent.md",
      "level": "user",
      "description": "Workspace Manager — persistent disk-level assistant",
      "lifecycle_hint": "permanent",
      "capabilities": ["file-mapping", "project-scanning", "context-maintenance"],
      "model": null,
      "memory": "project"
    },
    {
      "name": "coding-agent",
      "path": ".claude/agents/coding-agent.md",
      "level": "project",
      "description": "General implementation agent for coding tasks",
      "lifecycle_hint": "reusable",
      "capabilities": ["typescript", "react", "api", "testing"],
      "model": null,
      "memory": null
    }
  ],
  "stats": {
    "total": 5,
    "permanent": 1,
    "reusable": 3,
    "user_level": 3,
    "project_level": 2
  }
}
```

#### 생성 시점

1. **SessionStart hook** — 세션 시작 시 자동 생성 (기존 agent registry 스캔과 통합)
2. **`/agent-factory` 실행 후** — 새 template 추가 시 cache 업데이트
3. **compose-team 실행 시** — cache 없으면 즉석 생성, 있으면 재사용

#### compose-team에서 사용

compose-team SKILL.md Step 1에서:

```
1. Read `.tmp/agent-registry-cache.json` (있으면 사용, 없으면 직접 스캔)
```

→ LLM이 매번 N개 .md 파일을 읽지 않고 cache JSON 1개로 전체 pool 파악.

### D. maxTurns 산정

#### 가이드라인

| Task 유형 | maxTurns | 근거 |
|----------|----------|------|
| One-shot (리뷰, 분석) | 3-5 | 읽기 → 분석 → 보고 |
| Standard (구현, 테스트) | 10-15 | 읽기 → 계획 → 구현 → 검증 → 보고 |
| Complex (설계, 리서치) | 20-30 | 탐색 → 수집 → 분석 → 종합 → 보고 |
| Orchestrated (sprint-leader) | 생략 | Session Lead가 관리 |

#### compose-team 출력

```json
{
  "agents": [
    {
      "name": "coding-agent",
      "max_turns": 15,
      "max_turns_rationale": "standard implementation: read→plan→implement→test→report",
      ...
    }
  ]
}
```

#### Session Lead 실행

Session Lead가 agent spawn 시 `max_turns` 값을 agent prompt에 포함:

```
너의 작업은 최대 15턴 이내에 완료해야 한다. 10턴 시점에서 미완료 시 현재까지의 결과를 정리하여 보고하라.
```

### E. Stocktake Verdict

#### 트리거

1. **수동**: 사용자가 `/compose-team stocktake` 요청
2. **주기적**: compose-team 실행 시 마지막 stocktake 이후 7일 경과 시 권고 메시지

#### 프로세스

**Quick Scan** (기본):

```
1. agent-registry-cache.json 로드
2. 각 template에 대해:
   a. 최근 7일 내 spawn 기록 확인 (.tmp/file-write-log.jsonl에서 agent 이름 추출)
   b. agent-memory 마지막 수정일 확인
   c. 판정:
      - 7일 내 사용 + 정상 → Keep
      - 30일 미사용 → Retire 후보
      - 2개 template이 80%+ 유사 → Merge 후보
```

**판정 (Verdict)**:

| Verdict | 조건 | 액션 |
|---------|------|------|
| **Keep** | 최근 사용, 정상 작동 | 변경 없음 |
| **Improve** | 사용 중이나 반복 실패 패턴 | Self-evolution 트리거 |
| **Retire** | 30일+ 미사용, 대체 template 존재 | 유저 확인 후 삭제 |
| **Merge** | 2개 template 역할 80%+ 겹침 | 유저 확인 후 통합 |

#### 출력

```
## Agent Stocktake Report

| Template | Last Used | Verdict | Reason |
|----------|----------|---------|--------|
| wm-agent | 오늘 | Keep | 상주 agent, 매 세션 사용 |
| coding-agent | 3일 전 | Keep | 주력 구현 agent |
| api-reviewer | 45일 전 | Retire | coding-agent로 대체 가능 |
| data-agent / etl-agent | - | Merge | 역할 90% 겹침 |

권장 액션:
1. api-reviewer.md 삭제 (확인 필요)
2. data-agent + etl-agent → data-pipeline-agent로 통합 (확인 필요)
```

### F. Agent Enable/Disable

#### 출처: Theia AgentServiceImpl 패턴

Agent를 terminate하지 않고 **비활성화** 상태로 전환:

#### 구현

`.tmp/agent-status.json`:

```json
{
  "agents": {
    "coding-agent": { "enabled": true },
    "review-agent": { "enabled": false, "disabled_at": "2026-03-26T15:00:00Z", "reason": "Phase 1 전용" }
  }
}
```

#### compose-team 활용

Phase 전환 시:
- Phase 1 agent를 `enabled: false`로 전환 (shutdown 대신)
- Phase 2에서 다시 필요하면 `enabled: true`로 복원
- Session Lead가 `agent-status.json` 업데이트 → 재spawn 시 이전 context 활용

#### 현실적 제약

Claude Code에서 agent는 process로 존재하므로 "disable"은 사실상 **shutdown + 빠른 re-enable 경로** 의미:
- Disable = shutdown + SubagentStop context 저장 + status.json에 `enabled: false` 기록
- Re-enable = 같은 이름으로 respawn + SubagentStart가 이전 context 자동 로드

### G. Self-Evolution

#### 트리거

agent가 task 완료 후 sprint-leader에게 보고할 때, sprint-leader가 판단:

```
이 agent의 성과가 기대 이하인가?
  └── YES → sprint-leader가 Session Lead에게 "이 agent template 개선 필요" 보고
  └── NO  → 정상 종료
```

#### 진화 메커니즘

`/agent-factory evolve coding-agent — 반복적으로 테스트 코드를 빠뜨림. 테스트 작성 의무 강화 필요`

agent-factory가:
1. 현재 template 읽기
2. 문제점 분석
3. template body에 학습 내용 추가 (## Learnings 섹션)
4. 유저 확인 후 저장

#### Learnings 섹션 포맷

```markdown
## Learnings

<!-- Auto-appended by self-evolution -->
- [2026-03-26] 테스트 코드 빠뜨림 반복 → 구현 완료 전 반드시 관련 테스트 파일 확인/생성
- [2026-03-25] API 응답 타입 미정의 → interface 먼저 정의 후 구현
```

### H. Single-Threaded Owner (STO)

#### 규칙

```
1 agent = 1 task. 예외 없음.
```

compose-team이 "agent X에게 task A와 task B를 동시에" 할당하려 하면:
- task A, B가 진정으로 독립적 → 2개 agent 할당
- task A, B가 순차적 → 1 agent에 순차 할당 (하나 완료 후 다음)

#### compose-team 출력 검증

```json
{
  "agents": [
    {
      "name": "coding-agent-1",
      "task": "User API endpoint 구현",  // 단일 task
      ...
    },
    {
      "name": "coding-agent-2",
      "task": "Product API endpoint 구현",  // 단일 task
      ...
    }
  ]
}
```

agent에 복수 task 배정 시 compose-team이 경고:

```
⚠ coding-agent에 2개 task가 배정됨. STO 원칙 위반.
→ 자동 분리: coding-agent-1 (User API), coding-agent-2 (Product API)
```

### I. CompiledSubAgent 재사용 (deepagentsjs 패턴)

#### 출처: deepagentsjs CompiledSubAgent + GENERAL_PURPOSE_SUBAGENT

현재 시스템에서 "같은 template의 agent를 여러 번 spawn"할 때, 매번 template을 처음부터 읽어야 함.

#### 구현: Template Pre-compilation

SessionStart hook 또는 compose-team 실행 시:
- agent-registry-cache.json에 template 요약 저장 (이미 C에서 구현)
- SubagentStart hook이 cache에서 template body를 가져옴 (현재도 이 방식)

**추가 최적화**: compose-team 출력에 `template_hash`를 포함하여 SubagentStart hook이 변경 감지 시에만 re-read:

```json
{
  "name": "coding-agent-2",
  "template": "coding-agent",
  "template_hash": "a1b2c3d4",  // MD5 of template content
  ...
}
```

→ hook이 hash 비교 → 동일하면 cache된 inject 재사용, 다르면 re-read.

(참고: 현재 PreToolUse:Agent hook이 이미 hash 기반 delta inject를 수행하므로, 이 패턴은 기존 인프라와 자연스럽게 통합됨)

---

## compose-team SKILL.md 변경 사항

### 추가할 섹션

현재 SKILL.md 구조에 다음 변경:

#### 1. Step 1 (Load Context)에 registry cache 추가

```markdown
## Step 1: Load Context

1. Read `.claude/wm/project-profile.md` for project understanding
2. Read `.claude/wm/file-map.json` for file structure
3. **Read `.tmp/agent-registry-cache.json`** (있으면 사용, 없으면 아래 4-5로 직접 스캔)
4. Scan available agents: `.claude/agents/*.md` + `~/.claude/agents/*.md`
5. Scan available skills: `.claude/skills/*/SKILL.md` + `~/.claude/skills/*/SKILL.md`
```

#### 2. Step 2.5 신규: Lifecycle Classification

Step 2 (Analyze Task)와 Step 3 (Design Team) 사이에 삽입:

```markdown
## Step 2.5: Lifecycle Classification

For each agent role needed:

1. **WM Hard Contextual Read**: Session Lead가 WM에게 task 목록 전달 → WM이 filemap + agent-file affinity 기반으로 기존 template 매칭.
   - **매칭됨** (같은 파일 영역 이력 또는 같은 도메인) → reuse template, lifecycle: "reusable"
   - **근사 매칭** (같은 도메인, 다른 scope) → reuse template with task-specific override
   - **미매칭** → continue to step 2

2. **Lifecycle Decision**:
   - Will this role be needed across multiple tasks/sessions? → `"reusable"` (create via /agent-factory if no template)
   - Is this a one-off task? → `"ephemeral"` (NO file creation, inline prompt only)
   - Must this agent persist for the entire session? → `"permanent"` (must already exist)

3. **Ephemeral Agent Design**: For ephemeral agents, write a focused `inline_prompt` (max 200 words) that covers:
   - Role in one sentence
   - Specific task
   - Output format
   - Constraints
```

#### 3. Step 3 (Design Team)의 JSON 스키마 확장

```markdown
## Step 3: Design Team

Output a JSON team composition:

```json
{
  "team_name": "short-descriptive-name",
  "rationale": "Why this composition fits the task",
  "max_agents": 4,
  "prerequisites": ["/agent-factory agent-name — brief description"],
  "sprint_leader": "agent-name or null",
  "agents": [
    {
      "name": "agent-name",
      "template": "template-file or null",
      "lifecycle": "permanent | reusable | ephemeral",
      "role": "sprint-leader | worker",
      "task": "Specific task for this agent (ONE task only — STO principle)",
      "reports_to": "sprint-leader-name or team-lead",
      "model": "opus | sonnet",
      "max_turns": 15,
      "inline_prompt": "For ephemeral agents only. null otherwise."
    }
  ],
  "phases": [...],
  "skills_needed": [...]
}
```
```

#### 4. Composition Rules에 Lifecycle Rules 추가

```markdown
### Lifecycle Rules

1. **Ephemeral-first**: Default to ephemeral. Only create files for reusable/permanent agents.
2. **Reuse-first**: Before requesting /agent-factory, WM이 hard contextual read로 기존 template 커버리지 확인.
3. **STO (Single-Threaded Owner)**: Each agent gets exactly ONE task. Split if needed.
4. **maxTurns**: Always set. One-shot=5, Standard=15, Complex=30, Orchestrated=omit.
5. **No template pollution**: If compose-team would create 3+ new templates in one session, reconsider — likely some should be ephemeral.
6. **Idle retention**: 작업 완료된 agent는 유저 지시 전까지 idle 유지. 대화 맥락(conversation context) 보존 가치 > 재spawn 비용. Claude Code의 자동 해제 경향 주의.
```

#### 5. Stocktake subcommand 추가

```markdown
## Stocktake Mode

When invoked with `$ARGUMENTS` containing "stocktake":

1. Load agent-registry-cache.json
2. For each template, check:
   - Last spawn date (from .tmp/file-write-log.jsonl or agent-memory timestamps)
   - Role overlap with other templates
3. Output verdict table: Keep / Improve / Retire / Merge
4. Recommend actions (user confirmation required for any changes)
```

---

## JSON 출력 변경 사항

### 새 필드 (기존 대비)

| 필드 | 위치 | 타입 | 설명 |
|------|------|------|------|
| `max_agents` | root | number | 팀 하드캡 (Simple=2, Medium=4, Large=5) |
| `lifecycle` | agents[] | enum | `"permanent"` / `"reusable"` / `"ephemeral"` |
| `max_turns` | agents[] | number/null | 예상 최대 턴 수 (orchestrated면 null) |
| `inline_prompt` | agents[] | string/null | ephemeral agent 전용 inline 지시 |

### 변경 필드

| 필드 | 기존 | 변경 |
|------|------|------|
| `template` | agent 이름 또는 null | 동일하나 **null이면 ephemeral 또는 prerequisite** 중 하나. lifecycle 필드로 구분 |
| `prerequisites` | `/agent-factory` 목록 | reusable agent만 포함. ephemeral은 prerequisite 불필요 |

### 전체 예시

```json
{
  "team_name": "api-implementation",
  "rationale": "2개 독립 API endpoint + 리뷰. coding-agent 재사용, 리뷰는 ephemeral.",
  "max_agents": 4,
  "prerequisites": [],
  "sprint_leader": "coding-agent-1",
  "agents": [
    {
      "name": "coding-agent-1",
      "template": "coding-agent",
      "lifecycle": "reusable",
      "role": "sprint-leader",
      "task": "User API endpoint 구현 + 팀 조율",
      "reports_to": "team-lead",
      "model": "opus",
      "max_turns": 20,
      "inline_prompt": null
    },
    {
      "name": "coding-agent-2",
      "template": "coding-agent",
      "lifecycle": "reusable",
      "role": "worker",
      "task": "Product API endpoint 구현",
      "reports_to": "coding-agent-1",
      "model": "sonnet",
      "max_turns": 15,
      "inline_prompt": null
    },
    {
      "name": "api-reviewer-1",
      "template": null,
      "lifecycle": "ephemeral",
      "role": "worker",
      "task": "두 API endpoint의 보안/성능 리뷰",
      "reports_to": "coding-agent-1",
      "model": "sonnet",
      "max_turns": 5,
      "inline_prompt": "너는 API 보안/성능 리뷰어다. 두 PR의 코드를 읽고 OWASP Top 10 기준 보안 점검 + N+1 쿼리 등 성능 이슈를 보고하라. 포맷: 파일명, 라인, 심각도(Critical/Warning/Info), 설명."
    }
  ],
  "phases": [
    {
      "phase": 1,
      "agents": ["coding-agent-1", "coding-agent-2"],
      "description": "병렬 API 구현"
    },
    {
      "phase": 2,
      "agents": ["api-reviewer-1"],
      "description": "구현 결과 리뷰 (ephemeral)"
    }
  ],
  "skills_needed": []
}
```

### Session Lead 실행 가이드

Session Lead가 이 JSON을 받았을 때:

1. `prerequisites` 실행 (있으면)
2. Phase 1 agents spawn:
   - `lifecycle: "reusable"` → `Agent(subagent_type: "coding-agent", name: "coding-agent-1", ...)`
   - SubagentStart hook이 `coding-agent.md` body inject
3. Phase 2 agents spawn:
   - `lifecycle: "ephemeral"` → `Agent(subagent_type: "general-purpose", name: "api-reviewer-1", prompt: inline_prompt)`
   - `.md` 파일 없음 → hook이 template 못 찾아도 OK → inline_prompt가 전부
4. 완료 후:
   - reusable agents: template 유지 (다음에 재사용)
   - ephemeral agents: shutdown → `.tmp/agent-context/` 요약만 남음

---

## 마이그레이션 영향

### 기존 시스템과의 호환성

| 컴포넌트 | 변경 필요? | 내용 |
|----------|:---------:|------|
| compose-team SKILL.md | **Yes** | Step 2.5 추가, JSON 스키마 확장, Lifecycle Rules 추가 |
| agent-factory SKILL.md | **No** | reusable agent 생성 시에만 호출 (기존과 동일) |
| SubagentStart hook | **No** | 기존 template matching + CASE C(uncached) 로직으로 동작 |
| Session Lead 로직 | **Minor** | ephemeral agent의 `inline_prompt`를 spawn prompt에 사용 |
| SessionStart hook | **Minor** | agent-registry-cache.json 생성 추가 |
| CLAUDE.md | **No** | 기존 규칙과 호환 |

### Breaking Changes

없음. 기존 JSON에 새 필드가 추가되는 것이므로 하위 호환.

---

## 보충: EG-Library Expansion Deep Research 발견 (2026-03-28)

> 출처: EG-Library Expansion Deep Research (2026-03-28), 16개 프로젝트 심층 조사

### Agent Lifecycle Top 3 적용 패턴

| 순위 | 패턴 | 출처 (repo) | EG-DESK 적용 |
|------|------|-------------|-------------|
| 1 | **GEPA Self-Evolution Pipeline** | hermes-agent (NousResearch/hermes-agent-self-evolution) | ICLR 2026 Oral. Genetic-Pareto Reflective Text Evolution. $2-10/run (GPU 불필요, API만). PR 기반 human review. Phase 1: Skill files, Phase 2-3: Tool descriptions/system prompt. 3 메커니즘: Reflective Prompt Mutation + Textual Feedback Signals + Pareto-Based Selection. RL과 차이: full traces 분석 (scalar reward 아닌 error messages/logs 활용) |
| 2 | **Trinity-RFT Agentic RL** | AgentScope (agentscope-ai/Trinity-RFT) | 16+ 알고리즘 (PPO, GRPO, DPO, CHORD 등). 3요소 분리: Explorer(경험 수집) + Buffer(정제) + Trainer(가중치 업데이트). 실증: Frozen Lake 15%→86%, Math 75%→85%, Learn to Ask 47%→92%. Single-GPU colocate mode, LoRA 지원 |
| 3 | **"Karpathy Loop" 3요소** | autoresearch (karpathy/autoresearch) | Single modifiable file + Objectively testable metric + Fixed time limit. 58,759 stars. Ratchet Loop는 코드가 아닌 자연어(program.md)에 인코딩. 종료 조건 없음("until human interrupts"). SkyPilot 16 GPU: 910실험, $9 API + $300 GPU |

### 성장 단계 로드맵 (심층 조사 기반)

```
현재: 생성(agent-factory) + 폐기(shutdown)
  ↓
Phase 1: Frozen Snapshot + Nudge 메커니즘 (memory 자율 관리)
  - hermes-agent: tool schema에 "WHEN TO SAVE (do this proactively)" 지시
  - hermes-agent: 세션 중 write는 디스크만, prefix cache 보존
Phase 2: Progressive Disclosure + Skills Guard (skill 생태계 안전 확장)
  - agentskills.io: Metadata(~100 tokens) → Instructions(<5000) → Resources(요청 시)
  - hermes-agent: Trust 4단계 (builtin > trusted > community > agent-created)
  - hermes-agent: Skills Guard 6카테고리 정적 분석 (exfiltration/injection/destructive/persistence/network/obfuscation)
Phase 3: GEPA 기반 skill/prompt 자동 최적화 ($2-10/run)
Phase 4: Trinity-RFT 수준 agent 행동 자동 개선 (장기)
```

### 추가 Lifecycle 패턴

- **Degradation 방지 6 메커니즘** (hermes-agent): Context Compressor 50% threshold, max_iterations 90 (subagent 50), Prompt Caching (mid-conversation 변경 금지), Memory char limit (2,200/1,375자), Session DB (SQLite 세션 격리), Frozen Snapshot
- **Skill 자율 생성 트리거** (hermes-agent): "5+ tool calls 성공", "errors overcome", "user-corrected approach worked" — /agent-factory 자동 트리거 기준
- **Bilevel Meta-Optimization** (autoresearch): Level 1 인간(program.md → 전략), Level 2 에이전트(train.py → 전술). "the product is program.md". Centaur(hybrid)가 순수 AI보다 우수 (arxiv 2603.24647)
- **Gene System variant_published** (nodeskclaw, NoDeskAI/nodeskclaw): 에이전트가 Gene 사용 후 자체 변형(variant)을 마켓에 퍼블리시. parent_gene_id로 계보 추적. GeneEffectLog로 효과성 추적
- **Conductor LEARNINGS 6 entry types** (agent-deck): auto_response_ok, auto_response_wrong, escalation_unnecessary, escalation_correct, pattern, session_behavior. Recurrence 3+ 시 POLICY.md로 승격
- **Trust Boundary** (autoresearch): prepare.py(불변: MAX_SEQ_LEN=2048, VOCAB_SIZE=8192, TIME_BUDGET=5분, evaluate_bpb "DO NOT CHANGE") vs train.py(수정 가능). 평가 함수 불변 보호로 메트릭 속임 방지
`lifecycle` 필드가 없는 기존 JSON은 모든 agent를 `reusable`로 간주 (현재 동작과 동일).

### 소스코드 심층 조사 추가 발견 (2026-03-28)

> 출처: 16 explore-agents 소스코드 직접 분석

**GEPA 상세 메커니즘 (NousResearch/hermes-agent-self-evolution)**
- ICLR 2026 Oral Paper: Generalized Experience-driven Prompt Agent
- **Reflective Prompt Mutation**: RL과 근본적 차이 — scalar reward 아닌 전체 task trace(error messages, logs, 실행 경로) 분석. 자연어 피드백 기반 mutation (gradient 아닌 text)
- **Pareto Selection**: multi-objective 최적화 — 성능 + 비용 + 안전성 3축. Pareto front에서 dominate되지 않는 variant만 생존
- **3-Phase Evolution**: Phase 1(Skill files 최적화) → Phase 2(Tool descriptions 개선) → Phase 3(System prompt 정제)
- 비용: $2-10/run (별도 repo에서 실행, GPU 불필요, API 호출만). PR 기반 human review gate
- EG-DESK 적용: Phase 1부터 점진 적용 가능. SKILL.md 내용 자동 최적화 → /agent-factory 생성 결과물 품질 향상

**agentskills.io Progressive Disclosure 정량 스펙 (hermes-agent)**
- Stage 1: Metadata ~100 tokens (이름, 설명, 버전, 태그)
- Stage 2: Instructions <5,000 tokens (사용법, 제약, 예제)
- Stage 3: Resources 요청시 (전체 소스코드, 테스트, 문서)
- 현재 EG-DESK SKILL.md는 Stage 2 수준 (평균 200-500줄). Stage 1 메타데이터 레이어 추가 검토
- Skill Compose: 시스템 레벨 compose 부재 확인 (hermes-agent). 개별 skill 내 의존성으로 처리

**hermes-agent Degradation 방지 6 메커니즘 상세**
1. **Context Compressor 50%**: context 사용량 50%에서 자동 압축 트리거 (EG-DESK 현재 95% → 60%로 하향 검토 근거)
2. **max_iterations 90**: hard cap (subagent는 50). 무한 루프 방지
3. **Prompt Caching**: mid-conversation에서 system prompt 변경 금지 → prefix cache 보존
4. **Memory char limit**: MEMORY.md 2,200자, USER.md 1,375자. 초과 시 가장 오래된 항목 drop
5. **Session DB**: SQLite 세션 격리. 이전 세션 데이터가 현재 세션 오염 방지
6. **Frozen Snapshot**: 세션 시작 시 Memory를 시스템 프롬프트에 고정. 세션 중 write는 디스크만 업데이트

**hermes-agent Trust 4단계 + Skills Guard 6카테고리 상세**
- Trust: builtin(항상 허용) > trusted(openai/anthropics, caution 허용) > community(findings 있으면 차단) > agent-created(dangerous=ask)
- 6카테고리 정적 분석: exfiltration(데이터 유출), injection(프롬프트 주입), destructive(파괴적 작업), persistence(영구 변경), network(네트워크 접근), obfuscation(난독화)
- EG-DESK 적용: /agent-factory로 생성된 agent template의 skill 접근 제어에 참조

**nodeskclaw Gene System variant_published (NoDeskAI/nodeskclaw)**
- 에이전트가 Gene(설정 유전자) 사용 후 자체 변형(variant)을 마켓에 퍼블리시
- parent_gene_id로 계보 추적. GeneEffectLog로 효과성 추적
- EG-DESK 적용: agent-factory가 생성한 template의 버전 관리 + 효과 추적 모델

**autoresearch Trust Boundary (karpathy/autoresearch)**
- prepare.py(불변): MAX_SEQ_LEN=2048, VOCAB_SIZE=8192, TIME_BUDGET=5분, evaluate_bpb "DO NOT CHANGE"
- train.py(수정 가능): agent가 자유롭게 수정
- 평가 함수 불변 보호로 메트릭 속임 방지
- EG-DESK 적용: compose-team V2 Verification Gate에서 평가 기준을 불변으로 보호

### Round 2 추가 조사 보충 (2026-03-28)

> 출처: EG-Library Expansion Round 2 추가 조사, COMPOSE_TEAM_V2_RESEARCH.md

**agent-deck Hook→상태 매핑 — 9종 Hook 이벤트 기반 상태 관리**

`cmd/agent-deck/hook_handler.go` (14,152B)에서 Claude Code Hook 이벤트를 agent 상태로 매핑하는 실제 구현:

| Claude Code Hook Event | agent-deck 상태 |
|------------------------|-----------------|
| SessionStart | "waiting" |
| BeforeAgent | "running" |
| AfterAgent | "waiting" |
| UserPromptSubmit | "running" |
| Stop | "waiting" |
| PermissionRequest | "waiting" |
| Notification (permission_prompt/elicitation_dialog) | "waiting" |
| SessionEnd | "dead" |
| PreCompact | (관찰만) |

- `AGENTDECK_INSTANCE_ID` 환경변수로 hook 소유권 확인. 없으면 즉시 종료.
- 상태 파일을 `~/.agent-deck/hooks/{instance_id}.json`에 기록 (timestamp, status, sessionID, event)
- Terminal event (SessionEnd 등) 시 세션 매핑 정리
- **비용 추적 via Hook**: `Stop` 이벤트에서 `writeCostEvent()` 실행 — 페이로드의 transcript 파일 경로 읽기 → 마지막 assistant 메시지에서 토큰 사용량 파싱 → `~/.agent-deck/cost-events/`에 cost event 기록 (model, input/output tokens, cache metrics)
- EG-DESK 참고: SubagentStop hook과 유사하나, agent-deck은 비용 데이터까지 hook에서 추출. 비용 추적 도입 시 이 패턴 직접 참조 가능.

출처: RESEARCH.md 1156~1191행 (explore-agent-9, agent-deck)

**agent-skills-cli Security Audit Engine — 33개 regex 규칙, 6개 위협 카테고리**

`src/core/security-audit.ts`에 skill 설치 전 사전 보안 검증 도구 구현:

- 33개 regex 규칙으로 6개 위협 카테고리 탐지: Data Exfiltration, Prompt Injection, System Manipulation, File System Abuse, Network Abuse, Code Injection
- Skill 코드를 설치 전에 정적 분석하여 위험 패턴 사전 차단
- hermes-agent의 Skills Guard 6카테고리와 거의 동일한 분류 체계
- EG-DESK 참고: /agent-factory로 생성된 agent template의 skill 접근 제어, 또는 외부 skill 도입 시 사전 보안 검증에 참조 가능.

출처: RESEARCH.md 1331~1357행 (explore-agent-13, agent-skills-cli)

**walnut Config fallback — 3단계 설정 탐색**

설정 파일 fallback 메커니즘: 기본값 → 프로젝트 레벨 → 사용자 레벨. 3단계로 설정을 탐색하여 가장 구체적인(프로젝트) 설정이 우선.

- EG-DESK 참고: 현재 EG-DESK의 user-level / project-level override 구조와 동일한 패턴. compose-team V2의 agent-registry-cache에서 project-level이 user-level을 override하는 기존 설계를 지지하는 추가 사례.

출처: RESEARCH.md 1127~1131행 (explore-agent-8, walnut)
