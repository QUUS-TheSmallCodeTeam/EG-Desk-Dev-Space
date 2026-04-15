# compose-team V2 Design — Team Orchestration

> 영역 전담: 팀 구성, 오케스트레이션 패턴 선택, task-agent 매칭, 팀 규모 제어
> 기반: COMPOSE_TEAM_V2_RESEARCH.md (291+ 패턴 중 orchestration 관련 ~70개 추출)

---

## 1. 현재 문제 → 이 영역의 해결 목표

| 문제 | 이 영역에서 해결하는 것 |
|------|----------------------|
| 메타적 자기반성 부족 | compose-team이 자기 출력의 근거를 설명 + 대안 비교 |
| 현실 감각 부족 | 팀 캡 하드코딩, context budget 사전 계산, agent 용량 제한 |
| Agent 라이프사이클 무시 | 오케스트레이션 패턴이 lifecycle tier를 참조하여 결정 |
| UX 사이클 미고려 | Team Pattern Library로 "이전에 잘 된 구성" 즉시 재사용 |
| 그룹챗 부재 | Expediter 패턴으로 sprint-leader bottleneck 완화 |

---

## 2. 핵심 설계: 3단계 파이프라인

compose-team V2의 오케스트레이션은 **Classify → Match → Validate** 3단계 파이프라인으로 작동한다.

```
[유저 요청] → ① Classify → ② Match → ③ Validate → [JSON 출력]
              (무엇이 필요?)  (누가 할까?)  (이게 맞나?)
```

### Stage 0: Deterministic Keyword Triage (DKT)

**목표**: LLM 호출 없이 keyword 매칭으로 fast-path 라우팅. ESI Triage 이전에 실행.

리서치 패턴: claude-memory의 Deterministic Keyword Triage (6카테고리 keyword 필터링)

**규칙 테이블 (compose-team SKILL.md에 내장):**

```
유저 요청을 아래 keyword 패턴과 먼저 매칭한다. 적중 시 해당 결정을 즉시 적용.

| 키워드 패턴                              | fast_track | agents | 비고                    |
|----------------------------------------|-----------|--------|------------------------|
| lint, format, prettier, eslint         | true      | 1      | ESI 5, single          |
| typo, rename, s/old/new               | true      | 1      | ESI 5, single          |
| type error, TS\d+                      | true      | 1      | ESI 4, single          |
| add test, write test, test for         | true      | 1      | ESI 4, single          |
| refactor, restructure, reorganize      | false     | WM 판단 | requires_wm: true      |
| migration, 데이터 이전                   | false     | WM 판단 | requires_wm: true      |
| 설계, architecture, design              | false     | 2+     | esi_floor: 2           |
| 조사, research, investigate, 분석        | false     | 2+     | esi_floor: 2           |
```

**실행 흐름:**

```
User Request
    │
    ▼
Stage 0: Deterministic Keyword Triage
    ├── MATCH + fast_track=true  → 즉시 single-agent (compose-team 전체 SKIP)
    │                              출력: { "fast_track": true, "agent": "coding-agent", "task": "..." }
    ├── MATCH + fast_track=false → ESI floor/requires_wm 설정 후 Stage 1로
    └── NO MATCH                 → Stage 1: Classify (ESI Triage)
```

**효과**: "lint 수정해줘" 같은 trivial 요청에 LLM 기반 팀 설계 과정 전체를 건너뜀 → 토큰 절약 + 응답 속도 향상.

---

### Stage 1: Classify (무엇이 필요한가?)

**목표**: 유저 요청을 분석하여 task 구조 + 오케스트레이션 패턴을 결정

#### 1.1 Task Decomposition

리서치 패턴: O3 Task Decomposer, O28 Field-Presence Operation Derivation, O30 Foreground/Background

```
유저 요청 → LLM 분석:
  1. atomic vs composite 판별
     - atomic: 단일 파일/단일 목적 → 1 agent 직행
     - composite: 다중 파일/다중 목적 → 재귀 분해
  2. Field-Presence로 operation 유형 자동 도출:
     - 파일 목록 있음 → CREATE/UPDATE (구현)
     - 파일 목록 없음 + 질문 형태 → READ (조사)
     - 기존 ID 참조 → UPDATE/FIX (수정)
  3. Foreground/Background 분류 (O30):
     - foreground: 다음 task가 이 결과에 의존 → 완료 대기 필수
     - background: 독립 실행 가능 → run_in_background: true
     - 판단 기준: relations에 DEPENDS_ON이 있으면 foreground, 없으면 background
  4. 결과: task_tree (leaf = atomic task, 각각 execution_mode 태그)
```

**출력 구조**:
```json
{
  "tasks": [
    {
      "id": "t1",
      "description": "API 엔드포인트 구현",
      "operation": "CREATE",
      "complexity": "standard",
      "files_involved": ["src/api/users.ts", "src/api/users.test.ts"],
      "execution_mode": "foreground",
      "relations": [
        {"type": "DEPENDS_ON", "target": "t2"},
        {"type": "CONFLICTS_WITH", "target": "t3"}
      ]
    }
  ]
}
```

#### 1.2 Orchestration Pattern Selection

리서치 패턴: O1 (5패턴), O4 (Decision Principles), D12 (ESI 2-Step)

compose-team이 task 특성에 따라 5가지 오케스트레이션 패턴 중 하나를 자동 선택한다.

**ESI 2-Step Triage로 선택**:

| Step 1: 긴급도 | Step 2: 자원량 | 패턴 | 설명 |
|---------------|--------------|------|------|
| 긴급 + 단순 | 1 agent | **Fast Track** | compose-team 스킵, 즉시 single agent |
| 긴급 + 복잡 | 2-3 agents | **Pipeline** | 순차 실행, 빠른 산출 |
| 비긴급 + 탐색적 | 2-3 agents | **Council** | 독립 조사 → 합의 |
| 비긴급 + 구현 | 2-4 agents | **Leader** | sprint-leader가 분배+취합 |
| 지속적 품질 관리 | 1 watchdog | **Watchdog** | 별도 QA agent 상시 감시 |
| 불확실 + 대안 필요 | 2 agents | **Swarm** | 경쟁적 대안 탐색 (Best of N) |

**Mechanical vs Taste 분류** (O4):
- Mechanical(자동 결정 가능): ESI 점수가 명확 → compose-team이 자동 선택. 유저에게 노출 안 함
- Taste(판단 필요): ESI 점수가 경계 → 유저에게 "Leader vs Council 중 선택" 제시

**Decision Principles 6가지**:
1. 가역성: 되돌릴 수 있으면 빠르게 결정
2. 영향 범위: 좁으면 worker 자율, 넓으면 sprint-leader 판단
3. 정보 충분성: 부족하면 Council(조사), 충분하면 Leader(실행)
4. 시간 압박: 높으면 Pipeline, 낮으면 Council
5. 전문성 필요: 높으면 전문 agent, 낮으면 general-purpose
6. 선례 존재: 있으면 Pattern Library에서 재사용

#### 1.3 Dynamic Task Ledger

리서치 패턴: O7, O8 (Dual-Loop), O9 (OODA), O26 (Operational Period)

**고정 plan이 아닌 살아있는 원장**:

```json
{
  "task_ledger": {
    "facts": ["기존 API는 Express 기반", "테스트는 Jest 사용"],
    "guesses": ["마이그레이션에 2-3 파일 수정 예상"],
    "plan": ["Phase 1: 조사", "Phase 2: 구현", "Phase 3: 테스트"],
    "completed": [],
    "blocked": []
  },
  "progress_ledger": {
    "phase": 1,
    "stall_count": 0,
    "last_replan": null
  }
}
```

**3가지 재계획 트리거**:
1. **이벤트 기반 (OODA)**: phase 완료 시 결과 관찰 → 다음 phase 조정
2. **실패 기반 (Replan-on-Stall)**: 연속 3회 실패 → 자동 replan
3. **시간 기반 (Operational Period)**: 30분마다 강제 상태 점검 (CronCreate)

#### 1.4 Decision Registry + Structured Compaction

리서치 패턴: X17 (Decision Registry), X38 (Structured Context Compaction)

**모든 설계 결정을 구조화 기록** — phase 전환/context 압축 시에도 보존:

```json
{
  "decision_registry": [
    {
      "id": "d1",
      "decision": "Express 대신 Fastify 사용",
      "alternatives": ["Express (기존)", "Hono (경량)"],
      "rationale": "성능 요구사항 + 기존 팀 경험",
      "phase": "p1",
      "timestamp": "2026-03-27T10:30:00"
    }
  ]
}
```

**Structured Context Compaction (X38)**: context 압축 시 자유 형식이 아닌 4필드 강제:

```
## Goal
API 마이그레이션 Express → Fastify

## Progress
- Phase 1 완료: 엔드포인트 3개 변환
- Phase 2 진행 중: 미들웨어 변환

## Decisions
- d1: Express → Fastify (성능 + 팀 경험)
- d2: 기존 테스트 유지, 새 테스트는 Vitest

## Next Steps
- 미들웨어 변환 완료 → Phase 3(통합 테스트)
```

이 포맷은 handoff, phase 전환, agent 재spawn 시 모두 동일하게 사용된다.

---

### Stage 2: Match (누가 할 것인가?)

**목표**: task에 최적 agent를 매칭

#### 2.1 Filter → Score 2단계 (O10)

K8s Scheduler 패턴을 agent-task 매칭에 적용:

**Filter (불가능 제거)**:
- agent의 tool 권한이 task에 필요한 tool을 포함하는가?
- agent의 model tier가 task complexity에 충분한가?
- file_scope 충돌이 없는가? (Anti-Affinity, F5)
- Capacity 초과가 아닌가? (O17)

**Score (적합도 순위)**:
- 전문성 점수: WM이 filemap + agent-file affinity 기반으로 산정 (template이 과거에 다룬 파일 영역 참조)
- 부하 점수: 현재 할당된 task 수 (적을수록 높은 점수)
- 재사용 점수: 이전에 동일 task 수행 이력 (CompiledSubAgent, L12)
- 비용 점수: model tier × 예상 토큰 (낮을수록 높은 점수, BATS 연계)

```
Filter 통과 agent 목록 → Score 계산 → 상위 1개 매칭
동점: Resource Typing(T11) 등급이 task 요구에 가장 근접한 agent 우선
슬롯 부족: Agent Pool(I23) event-driven 대기 → 슬롯 해제 시 자동 매칭
```

#### 2.1.1 Concurrency 안전 (cross-agent 인프라)

리서치 패턴: I20-I26

agent-task 매칭과 실행 시 동시성 문제를 방지하는 인프라:

| 메커니즘 | 용도 | 구현 |
|---------|------|------|
| **mkdir Lock (I20)** | 공유 자원(파일, task 큐) 접근 시 원자적 lock | `.tmp/locks/{resource}/` 디렉토리 생성 |
| **OCC + Lock 이중 보호 (I21)** | 낙관적(hash) → 충돌 시 비관적(lock) escalation | 대부분 lock 없이 처리, 충돌 시만 lock |
| **Stale Lock 60초 해제 (I22)** | agent crash 후 lock 영구 점유 방지 | lock 파일에 timestamp, 60초 초과 시 자동 해제 |
| **Agent Pool Slot (I23)** | hard cap 내에서 event-driven agent 관리 | 슬롯 해제 시 대기 agent 자동 활성화 |
| **Orphan Reaper (I24)** | 좀비 agent 자동 정리 | CronCreate 5분마다 orphan 체크 → 자동 종료 |
| **cwd Session Isolation (I25)** | 인증 공유 + 상태 분리 | worktree + cwd 기반 격리 |

#### 2.2 Agent-Task 매칭 규칙

| 규칙 | 출처 | 구현 |
|------|------|------|
| **1 task = 1 agent** (기본) | T4 | 명확한 소유권. compose-team 기본값 |
| **Split Delivery** (예외) | O19 | 대형 task에 한해 `split: true` → 파일 단위 분할. **Split 판단 기준**: 대상 파일 총 토큰 > context_window × 0.4 이면 split 검토, 또는 파일 10+개. 단 "파일 10개 × 20줄"과 "파일 2개 × 3000줄"은 전혀 다른 배정 → WM이 filemap의 실제 크기 참조하여 판단 |
| **All-Day Aggregation** | O27 | 동일 유형 task → 같은 agent에 일괄 배정 |
| **Clarke-Wright Merge** | O16 | 초기 1:1 → 절약량 순 병합 (최적화 모드) |
| **Niche Partitioning** | I7 | agent별 file_scope 겹침 금지 |
| **Affinity/Anti-Affinity** | F5 | 관련 task는 같은 phase에, 충돌 task는 다른 phase에 |

#### 2.3 Team Pattern Library (RPD)

리서치 패턴: R7, R2 (Team archetype), L12 (CompiledSubAgent)

**사전 정의 팀 패턴 = "이전에 잘 된 구성"을 즉시 재사용**

```json
{
  "patterns": {
    "feature-implementation": {
      "description": "새 기능 구현 (API + UI + 테스트)",
      "orchestration": "Leader",
      "team": {
        "sprint-leader": {"model": "opus", "role": "architect+coordinator"},
        "workers": [
          {"role": "backend", "model": "sonnet", "scope": "src/api/**"},
          {"role": "frontend", "model": "sonnet", "scope": "src/ui/**"},
          {"role": "test", "model": "sonnet", "scope": "**/*.test.*"}
        ]
      },
      "phases": ["design", "implement", "test"],
      "estimated_tokens": 150000,
      "success_history": 12
    },
    "bug-fix": {
      "description": "버그 수정 (조사 + 수정 + 검증)",
      "orchestration": "Pipeline",
      "team": {
        "investigator": {"model": "opus", "role": "root-cause-analysis"},
        "fixer": {"model": "sonnet", "role": "implement-fix"},
        "verifier": {"model": "sonnet", "role": "test+verify"}
      },
      "phases": ["investigate", "fix", "verify"],
      "estimated_tokens": 80000,
      "success_history": 25
    },
    "research": {
      "description": "기술 조사 / 비교 분석",
      "orchestration": "Council",
      "team": {
        "researchers": [
          {"model": "sonnet", "role": "domain-A-researcher"},
          {"model": "sonnet", "role": "domain-B-researcher"}
        ],
        "synthesizer": {"model": "opus", "role": "synthesize-findings"}
      },
      "phases": ["parallel-research", "synthesize"],
      "estimated_tokens": 120000,
      "success_history": 8
    },
    "refactor": {
      "description": "코드 리팩토링",
      "orchestration": "Leader",
      "team": {
        "sprint-leader": {"model": "opus", "role": "refactor-architect"},
        "workers": [
          {"role": "refactor-impl", "model": "sonnet"}
        ]
      },
      "phases": ["analyze", "refactor", "verify"],
      "estimated_tokens": 100000
    },
    "code-review": {
      "description": "코드 리뷰",
      "orchestration": "Watchdog",
      "team": {
        "reviewer": {"model": "opus", "role": "code-reviewer"}
      },
      "phases": ["review"],
      "estimated_tokens": 50000
    },
    "single-task": {
      "description": "단일 파일 간단 작업",
      "orchestration": "FastTrack",
      "team": {
        "worker": {"model": "sonnet", "role": "general-purpose"}
      },
      "phases": ["execute"],
      "estimated_tokens": 30000
    }
  }
}
```

**Builtin + Custom + Cross-Project 3계층 (L21 + Cross-Project Insight Mining)**:
- **Builtin patterns**: 위 6개 — 시스템 제공, 수정 불가, 검증 완료
- **Custom patterns**: 프로젝트별 학습 — `.claude/wm/team-patterns.json`에 저장, 유저 수정 가능
- **Cross-Project patterns**: 다른 프로젝트에서 성공한 패턴 참조 — `~/.claude/global-team-patterns.json` (user level, 프로젝트 간 공유). "이전 프로젝트에서 이 유형 작업에 어떤 팀 구성이 성공했는가?"

**매칭 알고리즘**:
1. 유저 요청 → Ontology Auto-Classification (O20)으로 카테고리 분류
2. Custom patterns 먼저 검색 (현재 프로젝트 특화 우선)
3. Custom 매칭 없음 → Cross-Project patterns 검색 (다른 프로젝트 성공 이력)
4. Cross-Project 매칭 없음 → Builtin patterns 검색
5. 매칭 패턴 있음 → 패턴의 team/phases 기본값 사용 + task-specific 조정
6. 어디에도 매칭 없음 → Stage 1의 ESI Triage 결과로 새 구성 생성
7. 새 구성이 성공하면 → Custom Pattern Library에 추가 + Cross-Project에도 전파 (학습)

---

### Stage 3: Validate (이게 맞는가?)

**목표**: 출력 전 자기 검증

#### 3.1 팀 규모 하드캡

리서치 패턴: T1, T3, T6, T8, T9

```
검증 규칙 (순서대로, 모두 통과해야 출력):
1. max_agents ≤ 5 (절대 하드캡)
2. sprint-leader 직속 workers ≤ 4 (Span of control)
3. n(n-1)/2 ≤ 10 (Brooks 통신 채널 10 이하)
4. 각 agent의 estimated_tokens ≤ context_window * 0.7
5. 팀 전체 estimated_tokens ≤ budget (BATS 연계)

위반 시: agent 수 감소 → 스킬 체인으로 대체(T5) → 재검증
```

#### 3.2 Key Assumption Check (V11)

compose-team이 팀 구성을 출력하기 전에 핵심 가정을 명시:

```json
{
  "assumptions": [
    {"assumption": "기존 코드가 TypeScript", "confidence": 0.9, "fallback": "JS일 경우 worker에 TS→JS 변환 task 추가"},
    {"assumption": "테스트 프레임워크가 Jest", "confidence": 0.7, "fallback": "다를 경우 test worker의 tool 조정 필요"}
  ]
}
```

#### 3.3 ESS 자기검증 (생태학)

"빼면? 추가하면?" 테스트:
- 각 agent를 제거해도 전체 task가 커버되는가? → 제거 가능하면 불필요 agent
- agent를 추가하면 새로운 가치가 있는가? → 없으면 과잉

#### 3.4 Above/Below the Line 검증 (R8)

- Above(설계) agent가 Below(실행) task를 수행하고 있지 않은가?
- Below(실행) agent가 설계 결정을 내리고 있지 않은가?
- 경계가 명확한가?

---

## 3. 오케스트레이션 패턴 상세

### 3.1 Leader 패턴

```
[Session Lead] → [sprint-leader(opus)] → [worker-1(sonnet)]
                                        → [worker-2(sonnet)]
                                        → [worker-3(sonnet)]
```

- **적용**: 구현 작업, 명확한 요구사항
- **sprint-leader 역할**: task 분배, 진행 추적, 결과 Reconcile(L13)
- **Expediter 분리(K12)**: 5+ worker 시 sprint-leader를 Expediter(외부 인터페이스) + Sous-Chef(내부 조율)로 분리
- **Sterile Cockpit(K3)**: 구현 phase에서 sprint-leader → worker 중간 질문 금지

### 3.2 Council 패턴

```
[Session Lead] → [researcher-1(sonnet)] ─┐
               → [researcher-2(sonnet)] ─┤→ [synthesizer(opus)]
               → [researcher-3(sonnet)] ─┘
```

- **적용**: 조사, 비교 분석, 대안 탐색
- **Scout-Quorum(A1)**: 독립 탐색 → 정족수 합의 → 실행
- **Deliberation Protocol(V12)**: 독립 분석 → 차이점 대비 → 합성안

### 3.3 Pipeline 패턴

```
[agent-1] → [agent-2] → [agent-3]
(조사)      (구현)      (검증)
```

- **적용**: 순차적 의존성이 있는 작업
- **Handoff**: 선언적 Handoff(O24) + Strip Encoding(X13)
- **Fire/Hold Sync(H8)**: 병렬 부분이 있으면 동기화 후 다음 단계

### 3.4 Swarm 패턴 (Best of N)

```
[agent-A] ──→ [결과 A] ─┐
[agent-B] ──→ [결과 B] ─┤→ [판정자(opus)] → [최선 합성]
```

- **적용**: 불확실한 접근법, 설계 결정
- **Adversarial Pair(V6)**: 의도적 반대 입장 할당
- **Naked Reasoner(V7)**: 판정자에게 "누가 작성했는지" 숨김

### 3.5 Watchdog 패턴

```
[구현 agent(sonnet)] ←→ [watchdog(opus)]
                          (지속적 품질 감시)
```

- **적용**: 코드 리뷰, 보안 감사, 스타일 준수
- **Expert Witness Independence(V5)**: watchdog의 충성 대상은 프로젝트 표준

### 3.6 Fast Track

```
[single agent(sonnet)] → [결과]
```

- **적용**: ESI Level 4-5 (단순, 자원 1개)
- compose-team 자체를 스킵하고 즉시 실행
- **판단 기준**: 1-2 파일, 완전한 스펙, 기존 패턴 존재

---

## 4. compose-team JSON 출력 스키마

```json
{
  "version": "2.0",
  "request_summary": "유저 요청 1줄 요약",

  "classification": {
    "esi_level": 3,
    "operation": "CREATE",
    "complexity": "standard",
    "orchestration_pattern": "Leader",
    "pattern_source": "library:feature-implementation",
    "decision_type": "mechanical"
  },

  "tasks": [
    {
      "id": "t1",
      "description": "API 엔드포인트 구현",
      "operation": "CREATE",
      "files": ["src/api/users.ts"],
      "execution_mode": "foreground",
      "relations": [{"type": "DEPENDS_ON", "target": "t2"}],
      "acceptance_criteria": ["GET /api/users 200 응답", "Jest 테스트 통과"]
    }
  ],

  "team": {
    "max_agents": 4,
    "orchestration": "Leader",
    "sprint_leader": {
      "name": "sprint-leader",
      "template": "coding-agent",
      "model": "opus",
      "tier": "above",
      "role": "architect + coordinator"
    },
    "workers": [
      {
        "name": "worker-1",
        "template": "coding-agent",
        "model": "sonnet",
        "tier": "below",
        "task_ids": ["t1"],
        "file_scope": "src/api/**",
        "capabilities": {"read": true, "write": true, "bash": true},
        "isolation": "worktree"
      }
    ],
    "staging": [],
    "default_agent": {
      "name": "default",
      "template": "coding-agent",
      "model": "sonnet",
      "role": "residual task handler"
    }
  },

  "phases": [
    {
      "id": "p1",
      "name": "implement",
      "agents": ["worker-1", "worker-2"],
      "sterile": true,
      "call_sheet": ".tmp/call-sheets/phase-1.md",
      "handoff": {
        "trigger": "all_complete",
        "includeToolResults": false,
        "entry_requirements": ["t2 완료"]
      }
    }
  ],

  "budget": {
    "estimated_tokens": 120000,
    "budget_warning_threshold": 0.75,
    "model_chain": ["opus", "sonnet"],
    "budget_strategy": "standard"
  },

  "validation": {
    "assumptions": [
      {"assumption": "TypeScript 프로젝트", "confidence": 0.9, "fallback": "JS 변환 task 추가"}
    ],
    "ess_check": "worker-2 제거 시 test coverage 부족 → 유지",
    "brooks_channels": 6,
    "above_below_check": "pass"
  },

  "task_ledger": {
    "facts": [],
    "guesses": [],
    "plan": ["Phase 1: implement", "Phase 2: test"],
    "replan_triggers": {
      "stall_threshold": 3,
      "replan_interval_min": 30
    }
  },

  "kill_criteria": {
    "phase_1": "30분 내 빌드 에러 미해결 시 접근법 재검토",
    "global": "budget 90% 소진 시 현재 산출물로 종료"
  },

  "decision_registry_path": ".tmp/decision-registry.jsonl",

  "context_compaction_format": "Goal/Progress/Decisions/NextSteps",

  "concurrency": {
    "lock_mechanism": "mkdir",
    "stale_lock_timeout_sec": 60,
    "orphan_reap_interval_min": 5
  },

  "rationale": "ESI Level 3(비긴급+구현) → Leader 패턴. 3파일 변경 → worker 2명 + test 1명. Brooks 채널 6(OK).",
  "execution_notes": "worker-1과 worker-2의 file_scope가 겹치지 않도록 주의. Phase 1 완료 후 Reconcile에서 API 인터페이스 일관성 확인 필요."
}
```

---

## 5. Stage Agent Routing Table

각 오케스트레이션 패턴 × phase별 agent 배치:

| Pattern | Design Phase | Implement Phase | Test Phase | Review Phase |
|---------|-------------|-----------------|------------|--------------|
| **Leader** | sprint-leader(R) | workers(R) + sprint-leader(O) | test-worker(R) | sprint-leader(R) |
| **Council** | researchers(R) | synthesizer(R) | — | synthesizer(O) |
| **Pipeline** | agent-1(R) | agent-2(R) | agent-3(R) | — |
| **Swarm** | agent-A+B(R) | 판정자(R) | — | — |
| **Watchdog** | impl-agent(R) + watchdog(R) | impl-agent(R) + watchdog(R) | watchdog(R) | watchdog(R) |
| **Fast Track** | single(R) | single(R) | single(R) | — |

R = Required, O = Optional

---

## 6. 통합 포인트 (다른 4개 설계안과의 인터페이스)

### 6.1 DESIGN_LIFECYCLE.md 연동

| Orchestration 제공 | Lifecycle 제공 | 연동 지점 |
|-------------------|---------------|----------|
| task별 `lifecycle_hint` (permanent/reusable/ephemeral) | WM hard contextual read 결과 (`matched_template` or `null`) | **Stage 2 Match**: Filter에서 lifecycle tier를 참조. reusable이면 WM이 filemap + agent-file affinity 기반으로 기존 template 매칭, ephemeral이면 inline prompt 생성(파일 미생성) |
| team JSON의 각 agent에 `lifecycle` 필드 | 3-tier 판정 알고리즘 (`세션 전체? → permanent / 재사용? → reusable / 일회성? → ephemeral`) | **Stage 1 Classify**: task 분해 시 각 task의 반복성 판단 → lifecycle hint 결정 |
| Pattern Library의 agent role 정의 | agent-registry.json (L3) + stocktake verdict (L5) | **매칭 순서**: WM이 filemap + agent-file affinity 기반으로 매칭 → 미일치 시 `/agent-factory` prerequisite |
| `default_agent` (L11) 포함 여부 | enable/disable 상태 (L16) | default agent는 항상 `lifecycle: "ephemeral"` + `enabled: true` |

### 6.2 DESIGN_UX_COST.md 연동

| Orchestration 제공 | UX & Cost 제공 | 연동 지점 |
|-------------------|---------------|----------|
| DKT fast_track 결과 | ESI 2-Step Triage 상세 알고리즘 | **Stage 0→1 전환**: DKT miss → UX의 ESI Triage가 esi_level 산출 → Orchestration이 패턴 선택 |
| `budget.estimated_tokens` | BATS zone 판정 (standard/conservative/minimal) | **Stage 3 Validate**: 예상 토큰이 budget의 75% 초과 시 UX가 budget_warning 발행 → Orchestration이 agent 수 감축 또는 model downgrade |
| `phases[].call_sheet` 경로 | Call Sheet 자동 생성 + Dry Run 시각화 | Orchestration이 phase 구조 정의 → UX가 call sheet를 `.tmp/call-sheets/phase-N.md`에 생성하여 유저에게 표시 |
| `classification.decision_type` (mechanical/taste) | Clarification-first + Mechanical/Taste 분류 | Taste 결정 → UX가 유저에게 AskUserQuestion으로 선택지 제시 |
| `team.max_agents` | Effort display (human/AI 시간 표시) | UX가 팀 구성에 대한 예상 비용을 유저에게 표시 |

### 6.3 DESIGN_QUALITY.md 연동

| Orchestration 제공 | Quality 제공 | 연동 지점 |
|-------------------|------------|----------|
| `kill_criteria` (phase별 + global) | Kill/Spike 판정 실행, Saga Compensation Chain 실행 | Orchestration이 기준 정의 → Quality가 기준 위반 감지 시 kill/spike/compensate 실행 |
| `task_ledger.replan_triggers.stall_threshold` | Replan-on-Stall 실행 (E20), Action Loop Detector (E19) | Quality가 연속 실패/반복 행동 감지 → Orchestration의 Dynamic Task Ledger에 replan 요청 |
| `phases[].sterile` flag | Sterile Cockpit Zone (K3) 집행 | Orchestration이 sterile phase 지정 → Quality가 해당 phase에서 sprint-leader 중간 개입 차단 |
| 4-status escalation (DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED) | 4-status 결과 처리 로직 | Quality가 worker 보고를 4-status로 분류 → BLOCKED일 경우 Orchestration이 Re-Triage(D14) 실행 |
| `concurrency.lock_mechanism` | Circuit Breaker (E12) 상태 관리 | Quality가 circuit breaker open → Orchestration이 해당 agent에 task 배정 중지 |
| Saga `compensating_action` per phase | Orchestration 모드(sprint-leader 지시) 보상 실행 | Orchestration이 phase별 보상 action 정의 → Quality가 실패 시 역순 실행 |

### 6.4 DESIGN_MEMORY.md 연동

| Orchestration 제공 | Memory 제공 | 연동 지점 |
|-------------------|------------|----------|
| `file_scope`, `propagate/isolate` 설정 | Selective State Propagation (X36) 실행 | Orchestration이 agent별 공유/격리 키 정의 → Memory가 state key 단위로 전파/격리 |
| `context_compaction_format` | Structured Compaction (X38) 실행 | Orchestration이 Goal/Progress/Decisions/NextSteps 포맷 지정 → Memory가 compaction 시 이 포맷 강제 |
| `decision_registry_path` | Decision Registry (X17) append-only 기록 관리 | Orchestration이 경로 지정 → Memory가 모든 설계 결정을 해당 JSONL에 기록 |
| Pattern Library 성공 이력 | Session Continuity (X21) + Episodic Snapshot (X18) | Memory가 이전 세션의 팀 구성 결과를 저장 → Orchestration의 Pattern Library custom에 자동 반영 |
| `phases[].handoff.includeToolResults` | Tool Result Sanitization (X32) | Memory가 handoff 시 tool 결과 정제 → 다음 phase agent에 clean context 전달 |

---

## 7. 구현 우선순위

### Iteration 1 (compose-team V2 MVP)

0. **Deterministic Keyword Triage** — LLM 이전 fast-path (trivial 요청 즉시 처리)
1. ESI 2-Step Triage → 6가지 패턴 자동 선택
2. 팀 규모 하드캡 (max 5, span 1:4, Brooks ≤ 10)
3. Team Pattern Library 6개 builtin 패턴 + custom 저장소
4. Filter → Score agent-task 매칭
5. JSON 출력 스키마 V2
6. **Foreground/Background 자동 분류** (O30)
7. **Structured Context Compaction** (X38) — Goal/Progress/Decisions/NextSteps
8. **Decision Registry** (X17) — 설계 결정 append-only 기록

### Iteration 2

9. Task Decomposer (atomic/composite 자동 분류)
10. Dynamic Task Ledger + 3가지 replan trigger
11. Key Assumption Check + ESS 자기검증
12. Typed Relation Detection (DEPENDS_ON, CONFLICTS_WITH)
13. Pattern Library 학습 (성공 패턴 자동 추가 → custom)
14. **mkdir Lock + OCC** (I20, I21) — 공유 자원 동시성 보호
15. **Orphan Reaper** (I24) — 좀비 agent 자동 정리

### Iteration 3

16. Clarke-Wright Savings Merge (최적화 모드)
17. Above/Below the Line 검증
18. Expediter 분리 (5+ worker 자동 적용)
19. Operational Period (CronCreate 30분 점검)
20. Staging Area (대기 풀) + Agent Pool Slot Waiting (I23)

---

## 보충: EG-Library Expansion Deep Research 발견 (2026-03-28)

> 출처: EG-Library Expansion Deep Research (2026-03-28), 16개 프로젝트 심층 조사

### Orchestration 관련 Top 3 외부 검증 패턴

| 순위 | 패턴 | 출처 (repo) | EG-DESK 적용 |
|------|------|-------------|-------------|
| 1 | **Hierarchical Agent Teams** | LangGraph (langchain-ai/langgraph), CopilotKit AG-UI (ag-ui-protocol/ag-ui) | EG-DESK의 3계층 (Session Lead → Sprint Leader → Worker)이 업계 표준임을 확인. LangGraph supervisor + AutoGen 6-agent+1-manager와 동일 구조 |
| 2 | **Conductor LEARNINGS→POLICY 승격 (Recurrence 3+)** | agent-deck (asheshgoplani/agent-deck) | EG-DESK의 "feedback memory 3+ recall → CLAUDE.md 승격" 규칙과 정확히 동일. 6가지 entry type (auto_response_ok/wrong, escalation_unnecessary/correct, pattern, session_behavior). Safe/Escalate 이분법 정책 |
| 3 | **MsgHub 동적 참여자 관리** | AgentScope (agentscope-ai/agentscope) | `hub.add(agent)`, `hub.delete(agent)` API. async context manager. Phase Management에서 worker 교체 시 참고 |

### 추가 Orchestration 패턴

- **Harness 3단계 진화** (Anthropic 블로그): Two-Agent(Sonnet 4.5) → Three-Agent(Opus 4.5) → Simplified(Opus 4.6). 핵심 원칙: "every harness component encodes an assumption about what the model can't do alone" — 모델 업그레이드 시 컴포넌트 재검증
- **Sprint Contract 27 criteria** (Anthropic 블로그): Generator가 구현 계획 제안 → Evaluator가 리뷰 → 합의 후 코드 작성. compose-team의 task 정의 정밀화에 참고
- **Self-evaluation 실패** (Anthropic 블로그): "agents confidently praise mediocre work" — Generator-Evaluator 반드시 분리 (GAN식). 코드 리뷰 agent 도입 시 별도 에이전트 + few-shot calibrated rubric 필수
- **Subagent toolset 교집합 상속** (hermes-agent, NousResearch/hermes-agent): child가 parent보다 더 많은 도구 불가 (MAX 3 parallel, MAX 2 depth). 보안 원칙
- **WFQ + Priority Aging** (nodeskclaw, NoDeskAI/nodeskclaw): virtual_time = epoch/weight, BACKGROUND 5분→NORMAL, NORMAL 10분→CRITICAL. Starvation 완전 방지
- **Delegation/Escalation 동적 감지** (nodeskclaw): 에이전트 응답에서 `delegate:`/`escalate:` 프리픽스 감지 → 런타임 위임. MAX_COLLABORATION_DEPTH + visited 목록으로 무한 루프 방지
- **File-Based Communication 3패턴** (Anthropic 블로그): (A) 세션간 핸드오프: progress.txt+feature_list.json+git (B) 멀티에이전트 실시간: 파일 읽기/쓰기 (C) 병렬 잠금: current_tasks/ + git sync. 16 에이전트 규모에서 검증
- **C 컴파일러 규모 검증** (Anthropic 블로그): 16 에이전트 x 2주, 2,000 세션, $20,000 미만 — 대규모 multi-agent 운영의 실증 비용 데이터

### 소스코드 심층 조사 추가 발견 (2026-03-28)

> 출처: 16 explore-agents 소스코드 직접 분석

**context-mode PreToolUse Routing 결정 트리 (mksglu/context-mode, src/hooks/core/routing.mjs)**
1. 무조건 차단: WebFetch → deny, Bash(curl/wget)+stdout → modify (sandbox redirect)
2. 조건부 가이던스 (세션 1회): Read, Grep, Bash — Guidance throttle: in-memory Set + O_EXCL file markers (cross-process 원자성)
3. 자동 전파: Agent/Task tool → prompt에 `<context_window_protection>` routing block 주입
4. 보안 검사: ctx_execute(shell) → deny 정책 적용
5. Passthrough: 기타 tool → null
- EG-DESK 적용: SubagentStart hook의 routing block 주입 패턴과 동일 문제 해결. PreToolUse에서 Agent spawn 감지 → 규칙 자동 전파

**AG-UI Protocol CoAgent 루프 (CopilotKit/CopilotKit, ag-ui-protocol/ag-ui)**
- Agent↔Frontend 양방향 state sync: STATE_SNAPSHOT(전체) + STATE_DELTA(차분) 이벤트
- Multi-agent state 격리: 각 agent별 독립 state namespace → 동시 실행 시 충돌 방지
- Intermediate State Streaming: 중간 결과 실시간 UI 반영 (TEXT_MESSAGE_CONTENT 이벤트)
- 3 실행 모드: Single-turn, Multi-turn, Streaming
- EG-DESK 적용: sprint-leader가 worker 상태를 실시간 추적하는 패턴에 참조

**nodeskclaw Backpressure 4단계 (NoDeskAI/nodeskclaw)**
- Normal → Warning(80%) → Throttle(90%) → Reject(100%)
- EG-DESK 적용: Agent Pool Slot Waiting의 정밀화. 80% 경고 시 새 spawn 대기, 90% 시 우선순위 낮은 task 지연, 100% 시 거부
- Gene System 3-tier: Configuration(설정) → Behavior(행동) → Evolution(진화). 에이전트가 variant_published로 자체 변형 마켓에 퍼블리시

**context-mode 15 Event Categories (src/session/extract.ts)**
| # | 카테고리 | 이벤트 타입 | Priority |
|---|----------|------------|----------|
| 1 | file | file_read, file_write, file_edit, file_glob, file_search | P1/P3 |
| 2 | rule | rule, rule_content | P1 |
| 3 | task | task_create, task_update | P1 |
| 4 | cwd | cwd | P2 |
| 5 | error | error_tool | P2 |
| 6 | git | 18개 git 명령 패턴 | P2 |
| 7 | plan | plan_enter/exit/approved/rejected | P1-P2 |
| 8 | env | 17개 환경 패턴 | P2 |
| 9 | skill | skill | P3 |
| 10 | subagent | subagent_launched/completed | P2-P3 |
| 11 | mcp | mcp__ 접두사 tool | P3 |
| 12 | decision | decision_question (AskUserQuestion) | P2 |
| 13 | decision | decision (교정 패턴) | P2 |
| 14 | role/intent/data | 페르소나/모드/대량 데이터 | P3-P4 |
| 15 | prompt | user_prompt (모든 사용자 메시지) | P1 |
- EG-DESK 적용: PostToolUse hook + file-write-log.jsonl 패턴의 확장 모델. 15개 카테고리 구조화로 SubagentStop 추출 강화

### Round 2 추가 조사 보충 (2026-03-28)

> 출처: EG-Library Expansion Round 2 추가 조사, COMPOSE_TEAM_V2_RESEARCH.md

**agent-deck SQLite StateDB + Leader Election — 멀티프로세스 상태 동기화**

`internal/statedb/statedb.go` (22,990B) + `migrate.go` (11,528B)에서 SQLite 기반 멀티프로세스 조율 구현.

DB 스키마 (6 테이블):

| 테이블 | 용도 |
|--------|------|
| `metadata` | K/V (schema_version, last_modified) |
| `instances` | 세션 레코드 (상태, 도구, tmux, 워크트리) |
| `groups` | 세션 그룹 (확장 상태, 정렬 순서) |
| `instance_heartbeats` | 프로세스 수명 추적 (PID, primary 선출) |
| `recent_sessions` | 삭제된 세션 스냅샷 (빠른 재생성, 최대 20개) |
| `cost_events` | LLM 사용 추적 (토큰, 비용, 예산 중단 트리거) |

핵심 패턴:
1. **Primary 선출 (Leader Election)**: `ElectPrimary(timeout)` — 여러 agent-deck 인스턴스가 동시 실행 시 하나만 primary로 선출. heartbeat 기반 stale entry 정리.
2. **Polling 기반 변경 감지**: `last_modified` 타임스탬프를 metadata에 저장 → filesystem watcher 대신 DB 폴링으로 변경 감지. 크로스 프로세스 동기화.
3. **트랜잭션 기반 벌크 저장**: `SaveInstances()` — 목록에 없는 ID 삭제 → prepared statement로 일괄 insert. 고아 레코드 방지.
4. **최근 세션 재생성**: SHA-256 해시 (title + paths + tool options + flags)로 중복 방지. 최대 20개 유지.
5. **WAL 모드**: 읽기/쓰기 동시성. 5초 timeout.

- EG-DESK 참고: 현재 파일 기반 (.tmp/agent-context/, .claude/wm/) 상태 관리. 멀티프로세스 환경에서의 상태 동기화 패턴으로 참고 가치. Leader Election은 여러 Claude Code 인스턴스 동시 실행 시 유용.

출처: RESEARCH.md 1193~1215행 (explore-agent-9, agent-deck)

**nodeskclaw RegistryAggregator — 병렬 레지스트리 검색 집계 패턴**

여러 레지스트리를 병렬로 검색하는 집계 패턴. 분산된 agent/tool 레지스트리에서 동시에 검색하여 결과를 통합.

- EG-DESK 참고: compose-team의 agent registry 검색 시, user-level과 project-level을 병렬 스캔하는 패턴에 참조. 현재는 순차 스캔이나 레지스트리 규모 증가 시 병렬화 고려 근거.

출처: RESEARCH.md 1139~1141행 (explore-agent-10, nodeskclaw)
