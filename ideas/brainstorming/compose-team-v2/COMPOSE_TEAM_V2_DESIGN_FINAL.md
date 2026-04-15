# compose-team V2 — Final Integrated Design

> 5개 영역 설계안 통합 문서
> 기반: 45개 AI 프로젝트 + 22개 비-AI 도메인, 291+ 패턴
> 2026-03-27

---

## Executive Summary: 핵심 변경 5가지

| # | 변경 | Before (V1) | After (V2) | 해결하는 문제 |
|---|------|------------|-----------|--------------|
| 1 | **3-tier Agent Lifecycle** | 모든 agent에 .md 생성 | permanent/reusable/ephemeral 분류. ephemeral은 파일 미생성, inline prompt만 | Agent 라이프사이클 무시 |
| 2 | **ESI 2-Step Triage + DKT** | LLM이 매번 팀 구성 | 긴급도x자원량 2축 분류. keyword fast-path(DKT)로 trivial 요청 즉시 처리 | 현실 감각 부족, UX 사이클 |
| 3 | **Evidence-Gated 보고** | 자유 형식 완료 보고 | 4-Status(DONE/CONCERNS/NEEDS_CONTEXT/BLOCKED) + Verification Gate(5-Step Evidence Chain) | 메타적 자기반성 부족 |
| 4 | **Team Memory Layer** | agent별 독립 memory만 | 팀 공유 memory(.tmp/team-memory/) + Decision Registry + Structured Compaction(Goal/Progress/Decisions/NextSteps) | Context 소멸, 결정 추적 불가 |
| 5 | **Budget-Transparent 설계** | 비용 미표시 | Context Budget 사전 계산 + BATS zone 경고 + Effort Display(AI/Human 시간) + 75% Budget Warning | 현실 감각 부족 |

---

## 1. 전체 아키텍처

```
[유저 요청]
    │
    ▼
Stage 0: DKT (Deterministic Keyword Triage)     ← keyword 매칭, LLM 미사용
    ├── MATCH + fast_track → 즉시 single-agent (compose-team SKIP)
    └── NO MATCH / requires_wm →
            │
            ▼
Stage 1: Classify                                ← LLM 기반 분석
    ├── ESI 2-Step Triage (긴급도 × 자원량)
    ├── Task Decomposition (atomic/composite)
    ├── Foreground/Background 분류
    ├── Lifecycle Tier 판정 (permanent/reusable/ephemeral)
    └── Orchestration Pattern 선택 (6가지)
            │
            ▼
Stage 2: Match                                   ← agent-task 매칭
    ├── Pattern Library 검색 (Custom → Cross-Project → Builtin)
    ├── WM Hard Contextual Read (기존 template 재사용)
    ├── Filter → Score 2단계 매칭
    └── Context Budget 계산
            │
            ▼
Stage 3: Validate                                ← 자기 검증
    ├── 팀 규모 하드캡 (max 5, span 1:4, Brooks ≤ 10)
    ├── Key Assumption Check
    ├── ESS 자기검증 ("빼면? 추가하면?")
    ├── Above/Below the Line 검증
    └── Budget 초과 검사
            │
            ▼
[JSON 출력] → [Dry Run 시각화] → [유저 확인] → [실행]
```

---

## 2. 통합 JSON 스키마

5개 영역의 JSON 필드를 하나로 통합:

```json
{
  "version": "2.0",
  "request_summary": "유저 요청 1줄 요약",

  // ── Orchestration 영역 ──
  "classification": {
    "esi_level": 3,
    "operation": "CREATE | READ | UPDATE | FIX",
    "complexity": "trivial | standard | complex | strategic",
    "orchestration_pattern": "Leader | Council | Pipeline | Swarm | Watchdog | FastTrack",
    "pattern_source": "library:feature-implementation | custom:my-pattern | generated",
    "decision_type": "mechanical | taste"
  },

  "tasks": [
    {
      "id": "t1",
      "description": "API 엔드포인트 구현",
      "operation": "CREATE",
      "execution_mode": "foreground | background",
      "files": ["src/api/users.ts"],
      "relations": [
        {"type": "DEPENDS_ON | CONFLICTS_WITH | EXTENDS | REPLACES", "target": "t2"}
      ],
      "acceptance_criteria": ["GET /api/users 200 응답", "Jest 테스트 통과"]
    }
  ],

  // ── Lifecycle 영역 ──
  "team": {
    "team_name": "short-descriptive-name",
    "max_agents": 4,
    "orchestration": "Leader",
    "prerequisites": ["/agent-factory agent-name — brief description"],
    "sprint_leader": {
      "name": "sprint-leader",
      "template": "coding-agent",
      "lifecycle": "reusable",
      "model": "opus",
      "tier": "above",
      "role": "architect + coordinator",
      "max_turns": 30
    },
    "workers": [
      {
        "name": "worker-1",
        "template": "coding-agent",
        "lifecycle": "reusable",
        "model": "sonnet",
        "tier": "below",
        "role": "backend implementation",
        "task_ids": ["t1"],
        "file_scope": "src/api/**",
        "max_turns": 15,
        "capabilities": {"read": true, "write": true, "bash": true},
        "isolation": "worktree",
        "inline_prompt": null
      }
    ],
    "staging": [],
    "default_agent": {
      "name": "default",
      "template": "coding-agent",
      "lifecycle": "ephemeral",
      "model": "sonnet",
      "role": "residual task handler"
    }
  },

  // ── Memory 영역 ──
  "context": {
    "context_budget": {
      "model_window": 200000,
      "estimated_total": 85000,
      "utilization": 0.425,
      "per_agent": [
        {"name": "sprint-leader", "base": 8000, "task": 12000, "total": 20000},
        {"name": "worker-1", "base": 8000, "task": 15000, "total": 23000}
      ],
      "headroom": 115000,
      "warning": null
    },
    "per_agent_context": [
      {
        "name": "worker-1",
        "initial_reads": ["src/api/auth.ts"],
        "deferred_reads": ["src/api/middleware/*.ts"],
        "summary_only": ["src/api/legacy/*.ts"],
        "prerequisite_context": "API 인증 흐름 이해 필요",
        "guidance_level": "full | partial | minimal"
      }
    ],
    "propagation": {
      "propagate": ["files", "decisions"],
      "isolate": ["memory", "scratch"]
    },
    "compaction_format": "Goal/Progress/Decisions/NextSteps",
    "decision_registry_path": ".tmp/team-memory/decision-registry.jsonl",
    "shared_context_path": ".tmp/team-memory/shared-context.jsonl"
  },

  // ── Orchestration: Phase 정의 ──
  "phases": [
    {
      "id": "p1",
      "name": "implement",
      "agents": ["worker-1", "worker-2"],
      "sterile": true,
      "call_sheet": ".tmp/call-sheets/phase-1.md",
      "handoff": {
        "trigger": "all_complete | quorum | llm_tool_call | max_iterations",
        "includeToolResults": false,
        "entry_requirements": ["t2 완료"],
        "compaction_format": "Goal/Progress/Decisions/NextSteps"
      }
    }
  ],

  // ── UX & Cost 영역 ──
  "budget": {
    "estimated_tokens": 120000,
    "budget_warning_threshold": 0.75,
    "model_chain": ["opus", "sonnet"],
    "budget_strategy": "standard | conservative | minimal"
  },
  "effort": {
    "ai_minutes": 8,
    "human_hours": 2.0,
    "compression_pct": 93
  },

  // ── Quality 영역 ──
  "quality": {
    "verification_gate": true,
    "max_fix_loops": 3,
    "mastery_threshold": 0.8,
    "report_format": "4-status + SBAR",
    "circuit_breaker": {
      "failure_threshold": 3,
      "cooldown_sec": 60,
      "cooldown_multiplier": 2
    },
    "loop_detection": {
      "window_size": 20,
      "warn_at": 3,
      "halt_at": 5
    }
  },
  "saga": {
    "mode": "orchestration",
    "phases": [
      {"name": "phase_1", "compensating_action": "git revert phase_1"}
    ]
  },
  "temporal": {
    "phase_timeout_minutes": 30,
    "health_check_interval_minutes": 10,
    "replan_triggers": {
      "stall_threshold": 3,
      "replan_interval_min": 30
    }
  },

  // ── Orchestration: Task Ledger ──
  "task_ledger": {
    "facts": [],
    "guesses": [],
    "plan": ["Phase 1: implement", "Phase 2: test"],
    "completed": [],
    "blocked": []
  },

  // ── Cross-cutting ──
  "kill_criteria": {
    "phase_1": "30분 내 빌드 에러 미해결 시 접근법 재검토",
    "global": "budget 90% 소진 시 현재 산출물로 종료"
  },
  "concurrency": {
    "lock_mechanism": "mkdir",
    "stale_lock_timeout_sec": 60,
    "orphan_reap_interval_min": 5
  },
  "validation": {
    "assumptions": [
      {"assumption": "TypeScript 프로젝트", "confidence": 0.9, "fallback": "JS 변환 task 추가"}
    ],
    "ess_check": "worker-2 제거 시 test coverage 부족 → 유지",
    "brooks_channels": 6,
    "above_below_check": "pass"
  },
  "rationale": "ESI Level 3 → Leader. 3파일 → worker 2 + test 1. Brooks 6(OK).",
  "execution_notes": "file_scope 겹침 주의. Reconcile에서 인터페이스 일관성 확인."
}
```

---

## 3. 영역별 핵심 설계 요약

### 3.1 Orchestration (DESIGN_ORCHESTRATION.md)

**3단계 파이프라인**: Classify → Match → Validate

- **Stage 0 DKT**: keyword fast-path (lint→single, refactor→WM 필수)
- **6가지 패턴**: Leader(구현), Council(조사), Pipeline(순차), Swarm/Best-of-N(대안), Watchdog(품질), FastTrack(단순)
- **Team Pattern Library**: Builtin(6개) → Custom(프로젝트) → Cross-Project(전역) 3계층
- **Filter→Score**: tool 권한/model tier/file_scope/capacity 필터 → 전문성/부하/재사용/비용 스코어
- **하드캡**: max_agents ≤ 5, span 1:4, Brooks n(n-1)/2 ≤ 10

### 3.2 Lifecycle (DESIGN_LIFECYCLE.md)

**3-Tier 분류 + WM Hard Contextual Read + Stocktake**

- **permanent**: 세션 전체 상주 (WM). .md 필수 존재
- **reusable**: 여러 task에 재파견 (coding-agent). .md 존재, WM hard contextual read로 재사용
- **ephemeral**: 1회용. .md 미생성, inline prompt만
- **판정**: 세션 전체? → permanent / 재사용? → reusable / 일회성? → ephemeral
- **WM Hard Contextual Read**: WM이 filemap + agent-file affinity 기반으로 기존 template 매칭 (compose-team은 task decomposition만)
- **maxTurns**: one-shot=5, standard=15, complex=30, orchestrated=omit
- **Stocktake**: agent-registry 스캔 → Keep/Improve/Retire/Merge 판정
- **Lifecycle Rules**: ephemeral-first, reuse-first, STO(1 task = 1 agent), no template pollution, idle retention(유저 지시 전 해제 금지)

### 3.3 Quality (DESIGN_QUALITY.md)

**Evidence-Gated + Graduated Response + Saga**

- **4-Status**: DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED
- **Verification Gate**: IDENTIFY → RUN → READ → VERIFY → CLAIM (5-Step)
- **PACE**: Probe → Alert → Challenge → Emergency (worker 이의제기)
- **Verify-Fix Loop**: max_fix_loops=3, 초과→bail
- **Loop Detection**: 해시 윈도우 20, 3회 경고, 5회 강제 중단
- **Circuit Breaker**: failure_threshold=3, cooldown 60초 × multiplier
- **Saga Compensation**: phase별 compensating_action 정의, 실패 시 역순 보상
- **Temporal**: phase_timeout 30분, health_check 10분, CronCreate 활용
- **Mastery Gate**: acceptance_criteria 80%+ 충족 시에만 다음 phase
- **Kill/Spike**: sunk cost 무시 중단 결정. phase별 kill_criteria 사전 정의

### 3.4 Memory & Context (DESIGN_MEMORY.md)

**Team Memory + Decision Registry + Progressive Context + Episodic Snapshot**

- **팀 공유 memory**: `.tmp/team-memory/shared-context.jsonl` (append-only, 팀 전체 공유)
- **Decision Registry**: `.tmp/team-memory/decision-registry.jsonl` (설계 결정 원장)
- **Negative Results**: `.tmp/team-memory/negative-results.jsonl` (실패 경로 공유)
- **Context Budget**: agent수 × (base 8K + task 추정) = 총 예상 토큰. 60% 경고, 80% 거부
- **Progressive Context**: initial(spawn 시 최소) → deferred(Read 시 자연 로드) → summary_only(대용량 요약)
- **Handoff**: 구조화 JSON (status/files_touched/blockers/next_action + Goal/Progress/Decisions/NextSteps)
- **Episodic Snapshot**: SubagentStop시 `{task_state, files_modified, decisions_made, open_questions, next_steps}` 저장
- **Session Continuity**: SubagentStart에서 동일 name의 이전 snapshot 자동 로드
- **Selective State Propagation**: key 단위 공유/격리 선언 (propagate/isolate)
- **Memory Eviction**: phase 전환 시 오래된 항목 폐기 (priority 기반)

### 3.5 UX & Cost (DESIGN_UX_COST.md)

**Clarification-First + Budget-Transparent + Agent=Tool**

- **Clarification Pipeline**: ESI Triage → 모호성 검사(5유형) → AskUserQuestion → Plan 생성
- **Dry Run**: 실행 전 계획 시각화 (Mermaid phase diagram + effort table)
- **5-Checkpoint**: CP1(팀 구성) → CP2(계획) → CP3(phase 완료) → CP4(검증) → CP5(최종)
- **Effort Display**: AI minutes / Human hours / Compression % 항상 표시
- **BATS Zones**: standard(예산 충분) → conservative(50%+ 소진) → minimal(80%+ 소진)
- **Agent=Tool 등가**: handoff = tool call, Task(foreground, 파일 수정) vs Delegate(background, read-only)
- **Call Sheet**: phase별 1장 브리핑 문서 자동 생성 (`.tmp/call-sheets/phase-N.md`)
- **Mechanical vs Taste**: 자동 결정 가능 → 조용히 처리, 판단 필요 → 유저에게 선택지 제시

---

## 4. 통합 SKILL.md 변경 사항

compose-team SKILL.md에 적용할 변경을 실행 순서대로:

### 4.1 Stage 0: DKT 규칙 추가 (Orchestration)

```markdown
## Deterministic Keyword Triage (Stage 0)

유저 요청을 아래 keyword 패턴과 먼저 매칭. 적중 시 LLM 팀 설계 전체를 건너뜀.

| 키워드 패턴                              | fast_track | agents | 비고           |
|----------------------------------------|-----------|--------|----------------|
| lint, format, prettier, eslint         | true      | 1      | ESI 5, single  |
| typo, rename, s/old/new               | true      | 1      | ESI 5, single  |
| type error, TS\d+                      | true      | 1      | ESI 4, single  |
| add test, write test, test for         | true      | 1      | ESI 4, single  |
| refactor, restructure, reorganize      | false     | WM 판단 | requires_wm    |
| migration, 데이터 이전                   | false     | WM 판단 | requires_wm    |
| 설계, architecture, design              | false     | 2+     | esi_floor: 2   |
| 조사, research, investigate             | false     | 2+     | esi_floor: 2   |

fast_track=true → JSON: `{"fast_track": true, "agent": "coding-agent", "task": "..."}`
```

### 4.2 Lifecycle Rules 추가 (Lifecycle)

```markdown
## Lifecycle Rules

1. **Ephemeral-first**: Default to ephemeral. 파일 생성은 reusable/permanent만.
2. **Reuse-first**: /agent-factory 요청 전 기존 template 70%+ 커버 확인.
3. **STO**: Each agent gets exactly ONE task.
4. **maxTurns**: one-shot=5, standard=15, complex=30, orchestrated=omit.
5. **No template pollution**: 1 세션에 3+ 새 template 생성 시 재고.
```

### 4.3 ESI Triage + Clarification (UX & Cost)

```markdown
## ESI Triage

- Level 1: 전략 판단, opus + multi-agent
- Level 2: 복잡 구현, sonnet + 2-4 agents
- Level 3: 표준 구현, sonnet + 1-2 agents
- Level 4-5: Fast Track (compose-team 스킵)

## Clarification Protocol

모호한 요청 → 5유형 분류 → AskUserQuestion → Effort Display 포함
```

### 4.4 Quality Gates (Quality)

```markdown
## Worker 완료 보고

Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
Evidence: [실행 결과, 테스트 로그]
DONE은 반드시 Verification Gate 5-Step 통과 후에만 보고.
```

### 4.5 Context Budget (Memory)

```markdown
## Context Budget

per_agent = 8,000(base) + task_estimate(WM이 file-map 기반으로 산정)
total ≤ 80% of model_context_window
초과 시 agent 수 감축 또는 model downgrade
```

### 4.6 Composition Rules 통합

```markdown
## Composition Rules

1. max_agents ≤ 5 (절대 하드캡)
2. sprint-leader 직속 ≤ 4 (span of control)
3. n(n-1)/2 ≤ 10 (Brooks 통신 채널)
4. 각 agent estimated_tokens ≤ context_window × 0.7
5. 팀 전체 estimated_tokens ≤ budget
6. 단순 task (ESI 4-5) → skill chain 우선, multi-agent 금지
7. Pattern Library 매칭 우선 (Custom → Cross-Project → Builtin)
8. Assumptions + ESS 자기검증 필수
```

---

## 5. 구현 로드맵

### P0 — 즉시 적용 (CLAUDE.md 규칙 + compose-team SKILL.md 변경)

| # | What | Why | How |
|---|------|-----|-----|
| 1 | **DKT keyword fast-path** | trivial 요청에 LLM 팀 설계 비용 제거 | SKILL.md Stage 0 규칙 |
| 2 | **3-tier lifecycle** | .md 파일 오염 방지 | SKILL.md lifecycle rules + compose-team 판정 로직 |
| 3 | **WM Hard Contextual Read** | 기존 template 재사용 | WM이 filemap 기반 template 매칭 (compose-team은 task decomposition만) |
| 4 | **ESI 2-Step Triage** | 현실적 팀 규모 결정 | SKILL.md ESI 규칙 + 6가지 패턴 자동 선택 |
| 5 | **팀 규모 하드캡** | 과잉 spawn 구조적 차단 | SKILL.md composition rules (max 5, span 1:4, Brooks ≤ 10) |
| 6 | **4-Status + Verification Gate** | 조용한 실패 방지 | CLAUDE.md 보고 프로토콜 |
| 7 | **PACE 이의제기** | 잘못된 지시 교정 경로 | CLAUDE.md worker 이의제기 규칙 |
| 8 | **Context Budget 계산** | context window 과소비 방지 | WM이 산정, compose-team은 결과를 JSON에 포함 |
| 9 | **JSON V2 스키마** | 5개 영역 필드 통합 | compose-team 출력 포맷 변경 |
| 10 | **Budget Warning 75%** | 자원 소진 사전 경고 | CLAUDE.md sprint-leader 모니터링 규칙 |

### P1 — 단기 (compose-team 출력 확장 + hook 변경)

| # | What | Why | How |
|---|------|-----|-----|
| 11 | **Team Pattern Library** | "이전에 잘 된 구성" 재사용 | SKILL.md에 6 builtin 패턴 + `.claude/wm/team-patterns.json` |
| 12 | **Filter→Score 매칭** | 최적 agent-task 배정 | compose-team 내부 알고리즘 |
| 13 | **Decision Registry** | 설계 결정 추적 | `.tmp/team-memory/decision-registry.jsonl` append-only |
| 14 | **Structured Compaction** | context 압축 시 정보 보존 | Goal/Progress/Decisions/NextSteps 4필드 강제 |
| 15 | **Episodic Snapshot + Session Continuity** | agent 세션 보존 | SubagentStop snapshot 저장 + SubagentStart 자동 로드 |
| 16 | **Team Shared Memory** | 팀 지식 공유 | `.tmp/team-memory/shared-context.jsonl` |
| 17 | **Verify-Fix Loop** | 자동 수정 시도 | compose-team JSON `max_fix_loops` |
| 18 | **Saga Compensation** | 실패 시 원상복구 | compose-team JSON `compensating_action` per phase |
| 19 | **Call Sheet** | phase별 1장 브리핑 | `.tmp/call-sheets/phase-N.md` 자동 생성 |
| 20 | **Effort Display** | 비용 투명성 | compose-team 출력에 ai_minutes/human_hours/compression |

### P2 — 중기 (구조적 확장)

| # | What | How |
|---|------|-----|
| 21 | Task Decomposer (atomic/composite) | LLM 기반 재귀 분해 |
| 22 | Dynamic Task Ledger + 3 replan triggers | OODA + stall + operational period |
| 23 | Foreground/Background 자동 분류 | DEPENDS_ON 관계 기반 |
| 24 | Typed Relation Detection | DEPENDS_ON/CONFLICTS_WITH/EXTENDS/REPLACES |
| 25 | Pattern Library 학습 | 성공 패턴 자동 추가 (custom) |
| 26 | Progressive Context 3-Phase | initial/deferred/summary_only |
| 27 | Handoff 구조화 JSON | Strip Encoding + entry_requirements |
| 28 | Memory Eviction | phase 전환 시 priority 기반 폐기 |
| 29 | Circuit Breaker | failure_threshold + cooldown |
| 30 | Temporal Scheduling | CronCreate phase timeout + health check |

### P3 — 장기 (고급 최적화)

Clarke-Wright Merge, Above/Below 검증, Expediter 분리, Staging Area, Operational Period, Observer Agent, Cross-Project Pattern Mining, Adversarial Pair, Naked Reasoner, Orphan Reaper

---

## 6. 영역간 인터페이스 맵

```
                    ┌─────────────┐
                    │ Orchestration│
                    │ (팀 구성)    │
                    └──────┬──────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
            ▼              ▼              ▼
     ┌──────────┐  ┌──────────┐  ┌──────────┐
     │ Lifecycle │  │ UX & Cost│  │ Memory   │
     │ (agent)  │  │ (사용자)  │  │ (context)│
     └─────┬────┘  └─────┬────┘  └─────┬────┘
           │             │             │
           └──────┬──────┘             │
                  │                    │
                  ▼                    ▼
           ┌──────────┐        ┌──────────┐
           │ Quality  │◄───────│ Memory   │
           │ (검증)   │ saga   │ (context)│
           └──────────┘ state  └──────────┘
```

| From → To | 데이터 흐름 |
|-----------|-----------|
| **Orchestration → Lifecycle** | lifecycle_hint, template 요청 |
| **Lifecycle → Orchestration** | WM hard contextual read 결과, registry 목록 |
| **Orchestration → UX** | ESI level, decision_type(mechanical/taste) |
| **UX → Orchestration** | 유저 확인 결과, clarification 답변 |
| **Orchestration → Memory** | file_scope, propagate/isolate, compaction_format |
| **Memory → Orchestration** | context_budget, 이전 session pattern history |
| **Orchestration → Quality** | kill_criteria, stall_threshold, sterile flag |
| **Quality → Orchestration** | 4-status 결과, replan 요청, circuit breaker 상태 |
| **Memory → Quality** | decision_registry, saga state |
| **Lifecycle → Memory** | agent snapshot 경로, lifecycle tier |
| **UX → Quality** | mastery_threshold, checkpoint 결과 |

---

## 7. 파일 시스템 변경 요약

```
.tmp/                                    # 세션 임시 (git-ignored)
├── team-memory/                         # [NEW] 팀 공유
│   ├── shared-context.jsonl             # 팀 전체 사실/결정
│   ├── decision-registry.jsonl          # 설계 결정 원장
│   └── negative-results.jsonl           # 실패 경로
├── handoff/                             # [NEW] Phase 인수인계
│   └── phase-N-summary.json
├── call-sheets/                         # [NEW] Phase 브리핑
│   └── phase-N.md
├── agent-context/                       # [기존 확장]
│   ├── {type}.md                        # 기존 자유 형식 유지
│   └── {name}.snapshot.json             # [NEW] 구조화 snapshot
├── context-budget.json                  # [NEW] 예산 추적
├── locks/                               # [NEW] mkdir lock
│   └── {resource}/
└── file-write-log.jsonl                 # [기존] 유지

.claude/wm/
├── team-patterns.json                   # [NEW] Custom pattern library
└── agent-registry-cache.json            # [NEW] Agent registry cache

~/.claude/
└── global-team-patterns.json            # [NEW] Cross-project patterns
```

---

## 8. 메타 교훈: 이 세션에서 겪은 팀 관리 문제

이 세션 자체가 compose-team V2가 해결해야 하는 문제를 실시간으로 재현했다:

### 8.1 실제로 겪은 문제

| 문제 | 이 세션에서의 증상 | V2가 해결하는 방법 |
|------|------------------|------------------|
| **팀 규모 과잉** | 5개 영역 × 다수 agent 동시 실행 → 결과 통합 병목 | ESI Triage로 필요 최소 agent만 spawn |
| **통신 bottleneck** | Session Lead가 모든 agent 결과를 1:1 DM으로 수신/중계 | Team Shared Memory + Call Sheet로 중계 부담 감소 |
| **결과 통합 비용** | 10+ 배치의 패턴을 하나의 보고서에 순차 통합 → 반복 편집 | 4-Phase Lifecycle의 Reconcile phase를 명시적 1급 시민으로 |
| **Context 소멸** | 이전 배치에서 통합한 내용을 Session Lead가 재전송 (이미 통합됨) | Decision Registry + Episodic Snapshot으로 "뭘 했는지" 추적 |
| **작업 완료 인식 불일치** | 설계안 완료 보고 4회에도 Session Lead가 미완료로 인식 | Verification Gate의 Evidence Chain — 파일 존재 + 내용 검증 + 상태 보고를 구조화 |
| **Phase 간 Handoff 누락** | "리서치 통합" → "설계안 작성" 전환 시 명시적 handoff 없음 | Structured Handoff (Goal/Progress/Decisions/NextSteps) 강제 |

### 8.2 교훈 → 설계 반영

1. **"보고했다" ≠ "인식됐다"**: Evidence-Gated 보고 + Closed-Loop Communication(복창) 필수
2. **단일 integrator가 N개 소스를 통합하는 패턴은 O(N) bottleneck**: Team Shared Memory로 중앙 집중 통합 부담 분산
3. **Context 소멸은 가장 비싼 실패**: Decision Registry + Structured Compaction이 P0인 이유
4. **Fast Track 미적용 시 모든 요청이 동일 비용**: DKT Stage 0이 P0인 이유

---

## 보충: EG-Library Expansion Deep Research 종합 (2026-03-28)

> 출처: EG-Library Expansion Deep Research (2026-03-28), 16개 프로젝트 심층 조사

### Executive Summary

16개 대상 심층 조사로 compose-team V2 설계에 직접 영향을 미치는 5가지 핵심 발견:

1. **Frozen Snapshot 패턴** (hermes-agent): prefix cache 보존을 위해 세션 시작 시 Memory를 고정하고 세션 중 write는 디스크만 업데이트. compose-team V2의 Shared Memory 설계에 적용 가능
2. **AG-UI Protocol 수렴** (CopilotKit, 12.7K stars): Oracle/Google/MS/AWS 11+ 채택. compose-team V2가 UI reporting을 구현할 때 사실상 유일한 표준
3. **ReMe 99.5% compression** (AgentScope): 223,838→1,105 tokens. compose-team V2의 Context Budget 관리와 Handoff 압축에 참조
4. **Self-evaluation 실패** (Anthropic 블로그): Generator-Evaluator 반드시 분리. compose-team V2의 Verification Gate 설계 근거 강화
5. **Agent 자율 진화 실용화**: GEPA $2-10/run (ICLR 2026), Trinity-RFT 15%→86%. compose-team V2의 Lifecycle 설계 Phase 3-4에 해당

### compose-team V2 설계에 직접 영향을 미치는 패턴

| V2 설계 요소 | 외부 검증 패턴 | 출처 |
|-------------|--------------|------|
| **ESI Triage** | Hierarchical Agent Teams (LangGraph), 6-agent+1-manager (AutoGen) | langchain-ai/langgraph, 500-AI-Agents |
| **Budget Transparency** | agent-deck Budget 80%/100% CheckTx, Anthropic harness V2 breakdown ($124.70) | asheshgoplani/agent-deck, Anthropic 블로그 |
| **Shared Memory** | Frozen Snapshot (prefix cache), ReMe 99.5%, PreCompact 2KB XML | NousResearch/hermes-agent, agentscope-ai/ReMe, mksglu/context-mode |
| **Verification Gate** | Sprint Contract 27 criteria + Self-evaluation 실패 근거 | Anthropic 블로그 |
| **Lifecycle 3-Tier** | GEPA $2-10/run, Trinity-RFT, Karpathy Loop 3요소 | NousResearch/hermes-agent-self-evolution, agentscope-ai/Trinity-RFT, karpathy/autoresearch |
| **Structured Handoff** | Files at Different Speeds (walnut), JSON > Markdown (Anthropic) | stackwalnuts/walnut, Anthropic 블로그 |
| **feedback memory 승격** | Conductor LEARNINGS→POLICY (Recurrence 3+) | asheshgoplani/agent-deck |
| **Skill 생태계** | agentskills.io 표준, SKILL.md 100% 호환, Progressive Disclosure 3단계 | agentskills.io, Karanjot786/agent-skills-cli, NousResearch/hermes-agent |
| **Context Budget** | Context Budget 4-Signal (LLM 불필요), 60% quality degradation threshold | Karanjot786/agent-skills-cli, blakecrosley.com |
| **Agent 보안** | Skills Guard Trust 4단계 + 6카테고리 정적 분석, GuardrailsEngine WARN/REDACT/BLOCK | NousResearch/hermes-agent, open-jarvis/OpenJarvis |

### 핵심 설계 원칙 (심층 조사에서 추가 확인)

6. **"Every component encodes an assumption"** (Anthropic harness): 모델 업그레이드 시 기존 컴포넌트 재검증 필수. compose-team V2도 정기적으로 ESI/Triage/Phase 필요성 재검증
7. **Centaur(Human-AI Hybrid)가 최고 성과** (arxiv 2603.24647): compose-team V2의 human-in-the-loop 설계 (DKT + Dry Run + 확인)가 학술적으로 뒷받침됨
8. **비파괴적 Memory 관리** (AgentScope MemoryMark, walnut log.md): 삭제 아닌 마킹/아카이빙이 안전한 패턴. compose-team V2의 Decision Registry에 적용

### 구현 로드맵 보충 (심층 조사 기반)

**P0 추가 고려:**
- JSON > Markdown 전환: `.tmp/agent-context/` 포맷을 JSON으로 전환 검토 (Anthropic: "model is less likely to inappropriately change JSON")
- Frozen Snapshot: Memory 주입 시 세션 시작 스냅샷 고정 → prefix cache 보존 (hermes-agent 패턴)

**P1 추가 고려:**
- Self-evaluation 분리: Verification Gate에서 작성자와 검증자를 별도 agent로 (Anthropic GAN식 분리)
- Evaluator 캘리브레이션: 로그 분석 → 인간 판단과 차이점 식별 → QA 프롬프트 업데이트 (few-shot + score breakdowns)

**P3 추가:**
- GEPA 기반 skill/prompt 자동 최적화 ($2-10/run, ICLR 2026 Oral, NousResearch/hermes-agent-self-evolution)
- AG-UI Protocol 통합 (UI layer 구현 시, 30+ 이벤트, 8 SDK, ag-ui-protocol/ag-ui)
- Trinity-RFT 수준 agent 행동 자동 개선 (agentscope-ai/Trinity-RFT, 16+ RL 알고리즘)

### 정량 데이터 하이라이트

| 지표 | 값 | 출처 | V2 적용 |
|------|-----|------|---------|
| ReMe compression | 99.5% (223K→1.1K tokens) | agentscope-ai/ReMe | SubagentStop 추출 강화 |
| Harness V2 비용 | $124.70/3h50m (V1 대비 38% 감소) | Anthropic 블로그 | 모델 업그레이드 ROI 근거 |
| Build vs QA 비율 | 86.6% vs 8.4% | Anthropic 블로그 | QA agent 도입 비용 저렴 증명 |
| 60% 임계점 | context 60%에서 품질 저하 시작 | blakecrosley.com 50세션 | ProactiveCompaction 트리거 시점 |
| C 컴파일러 규모 | 16에이전트, 2000세션, $20K/2주 | Anthropic 블로그 | 대규모 프로젝트 비용 참고 |
| Centaur vs AI-only | 0.9763 vs 0.9814 val_bpb | arxiv 2603.24647 | human-in-the-loop 우위 실증 |
| GEPA 자동 최적화 | $2-10/run (GPU 불필요) | NousResearch/hermes-agent-self-evolution | 성장 단계 비용 참고 |
| Auto compaction | input 60% 감소 (204K→82K) | Anthropic 공식 cookbook | compaction 효율 벤치마크 |

### 소스코드 심층 조사 추가 발견 (2026-03-28)

> 출처: 16 explore-agents 소스코드 직접 분석

**context-mode Session Continuity 전체 흐름 (mksglu/context-mode)**
```
[1. SessionStart (startup)] → cleanup 7일+ 세션 → CLAUDE.md 캡처→SessionDB → routing block 주입
[2. Tool 사용 중] → PreToolUse(deny/modify/guidance) + PostToolUse(15 events→SessionDB) + UserPromptSubmit(decision/role/intent)
[3. Context Compact] → PreCompact(events→2KB XML snapshot) → SessionStart(compact: snapshot 소비→session_knowledge 14섹션 XML)
[4. Session Resume] → SessionStart(resume: events→markdown→FTS5, session_directive 주입)
```
- MCP + hooks 이원 구조: protocol layer에서 context 진입 차단 (EG-DESK는 hooks only, context 진입 후 압축)
- EG-DESK 적용: PreCompact hook 도입으로 compact 직전 핵심 정보 보존 가능

**Additional Key Takeaways (심층 조사에서 추가 확인)**

9. **MCP + Hooks 이원 구조가 context 절감에 최적** — context-mode 96% 절감의 핵심. protocol layer에서 차단(MCP sandbox) + behavior layer에서 추출(hooks event capture)
10. **Progressive Disclosure는 3단계가 최적** — hermes-agent/agentskills.io: Metadata(~100 tokens) → Instructions(<5,000) → Resources(요청시). 단계별 10-50x token 절감
11. **Shell Escape Detection이 보안의 마지막 방어선** — context-mode: 6개 언어의 shell 호출 패턴 감지. agent가 비-shell 코드에서 우회 실행 방지
12. **Backpressure 4단계가 자원 관리의 정답** — nodeskclaw: Normal→Warning(80%)→Throttle(90%)→Reject(100%). 단순 on/off보다 gradual degradation

**검증 상태 확장**

| 수치 | 검증 | 결과 |
|------|------|------|
| context-mode 98% | BENCHMARK.md 직접 확인 | **확인**: 전체 96%, file 98%, debug 94% |
| context-mode 10 platforms | src/adapters/ 확인 | **확인**: Claude Code, Gemini CLI, VS Code Copilot, Cursor, OpenCode, Codex CLI, Kiro, Zed, OpenClaw, Antigravity |
| context-mode 7 MCP tools | src/server.ts 확인 | **확인** |
| context-mode 1000 event cap | src/session/db.ts 확인 | **확인**: FIFO eviction |
| hermes-agent GEPA ICLR 2026 | 소스코드+논문 | **확인**: Oral, Reflective Prompt Mutation + Pareto Selection |
| hermes-agent $2-10/run | 별도 repo 비용 | **보고값** |
| BrowserOS 53 MCP tools | 소스코드 확인 | **확인** |
| nodeskclaw 9-stage middleware | 소스코드 확인 | **확인** |

5. **팀 규모와 자율도는 반비례**: 큰 팀일수록 구조화된 프로토콜 필수 (Rubato Boundary)
