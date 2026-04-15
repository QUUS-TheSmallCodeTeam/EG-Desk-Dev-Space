# compose-team V2 설계: Memory & Context Management

> 담당 영역: Context Budget, Progressive Context, Handoff, Session Continuity, Team/Individual Memory, Decay/Eviction, Decision Registry, Episodic Snapshot, Entity/Process Attribution, Shared Storage, 그룹챗 부재 해결
> 기반: COMPOSE_TEAM_V2_RESEARCH.md 183+ 패턴 + 서재 deep scan 20 패턴

---

## 1. 문제 정의

### 1.1 현재 시스템의 Memory/Context 문제

| 문제 | 증상 | 근본 원인 |
|------|------|----------|
| **Context 소멸** | agent 종료 → "뭘 했는지" 사라짐 | SubagentStop이 요약 저장하나 재spawn 시 자동 로드 없음 |
| **그룹챗 부재** | agent간 1:1 DM만 가능, 팀 전체 공유 불가 | SendMessage는 to:name 또는 to:* (비용 높음). 공유 채널 없음 |
| **Context 예산 무시** | agent 5개 spawn → 각각 context window 소비 | compose-team이 토큰 예산 미계산 |
| **Handoff 비구조화** | phase간 인수인계가 자유 형식 | 표준 포맷 없음 → 정보 누락 |
| **결정 추적 불가** | "왜 이렇게 했지?" 답변 불가 | 설계 결정 기록 메커니즘 없음 |
| **Team vs Individual 미분리** | agent-memory가 agent별 독립 → 팀 지식 공유 어려움 | 공유 memory 레이어 없음 |
| **Memory 비대화** | 장기 세션에서 .tmp/ 파일 누적 | decay/eviction 정책 없음 |

### 1.2 Claude Code 제약

| 제약 | 영향 | 활용 가능 자원 |
|------|------|--------------|
| SendMessage DM only | 그룹챗/브로드캐스트 비용 높음 | `.tmp/` 공유 파일로 보완 |
| SQLite/Redis 불가 | 구조화 DB 없음 | JSONL + JSON 파일 기반 |
| agent-memory는 agent별 | 팀 공유 memory 없음 | `.tmp/team-memory/` 경로로 해결 |
| SubagentStart hook 존재 | context 자동 주입 가능 | hook에서 이전 snapshot 로드 |
| SubagentStop hook 존재 | 종료 시 자동 저장 가능 | 구조화 snapshot 저장 |
| WM 상주 agent | 파일 수준 인텔리전스 | file-map + agent-file-bindings |

---

## 2. 아키텍처 개요

```
.tmp/                                    # 세션 임시 저장소 (git-ignored)
├── team-memory/                         # [NEW] 팀 공유 메모리
│   ├── shared-context.jsonl             # 팀 전체 공유 사실/결정 (append-only)
│   ├── decision-registry.jsonl          # 설계 결정 원장
│   └── negative-results.jsonl           # 실패 경로 공유
│
├── handoff/                             # [NEW] Phase간 인수인계
│   ├── phase-1-summary.json             # 구조화 handoff
│   └── phase-2-summary.json
│
├── agent-context/                       # [기존] SubagentStop 요약
│   ├── {agent-type}.md                  # 기존 자유 형식
│   └── {agent-name}.snapshot.json       # [NEW] 구조화 episodic snapshot
│
├── context-budget.json                  # [NEW] 팀 전체 context 예산 추적
│
└── file-write-log.jsonl                 # [기존] 파일 생성 추적

.claude/agent-memory/{name}/             # [기존] Agent별 영속 메모리
                                         # cross-session, agent 고유 지식
```

---

## 3. 상세 설계

### 3.1 Context Budget 계산 (X1, O17, C8)

WM이 팀 구성 시 context 예산을 사전 산정하여 과도한 spawn 방지. compose-team은 WM의 산정 결과를 JSON에 포함.

**계산 공식:**
```
per_agent_base = 8,000 tokens    # CLAUDE.md + hook inject + template
per_agent_task = variable        # WM file mapping 기반 추정
total_budget = Σ(per_agent_base + per_agent_task[i]) for i in agents

# 경고 임계값
warn_threshold = 0.6 * model_context_window   # 60% = 경고
hard_cap = 0.8 * model_context_window         # 80% = 거부
```

**compose-team 출력 필드:**
```json
{
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
  }
}
```

**BATS 연동**: `utilization > 0.5` → sonnet 우선, `> 0.7` → tool 호출 최소화 경고.

**구현**: WM이 file-map에서 agent별 `reads` 파일 크기 합산으로 `task` 토큰 추정하여 산정. compose-team은 WM의 산정 결과를 JSON에 포함.

### 3.2 Progressive Context (X2, C9, C10, V15)

Agent에게 모든 context를 한번에 주지 않고 3단계로 나눠 전달.

**3-Phase 모델:**

| Phase | 내용 | 시점 | 토큰 영향 |
|-------|------|------|----------|
| **initial** | task 설명 + 핵심 파일 경로 + 팀 구조 | spawn 시 prompt | 최소 (2-4K) |
| **deferred** | 관련 파일 내용 + 선행 phase 결과 | agent가 Read 시 자연 로드 | 필요 시만 |
| **summary_only** | 대용량 파일은 요약만 | WM이 사전 생성 | 80%+ 절약 |

**compose-team 출력 명세:**
```json
{
  "agents": [{
    "name": "worker-1",
    "context_strategy": {
      "initial_reads": ["src/api/auth.ts", "src/types/user.ts"],
      "deferred_reads": ["src/api/middleware/*.ts"],
      "summary_only": ["src/api/legacy/*.ts"],
      "prerequisite_context": "API 인증 흐름 이해 필요 (auth.ts L1-50)"
    }
  }]
}
```

**Fading Scaffolding 연동**: Phase 1 agent에게는 `guidance_level: "full"` (예제 코드 포함), Phase 2+는 `"partial"`, 최종 Phase는 `"minimal"`.

**Cache-Aware 구조**: Agent template의 앞부분(시스템 규칙 + 역할)을 불변으로 유지, 뒷부분(task-specific)만 변경 → KV cache hit율 극대화.

### 3.3 Handoff 파일 명세 (X3, X13, H1, H7)

Phase간 인수인계를 구조화 JSON으로 표준화.

**파일 경로**: `.tmp/handoff/phase-{N}-summary.json`

**스키마:**
```json
{
  "phase": 1,
  "completed_at": "2026-03-26T14:30:00Z",
  "status": "DONE",
  "agents_involved": ["worker-1", "worker-2"],

  "deliverables": {
    "files_created": ["src/api/auth.ts", "src/types/user.ts"],
    "files_modified": ["src/api/index.ts"],
    "tests_status": {"passed": 12, "failed": 0, "skipped": 2}
  },

  "strip_encoding": "DONE/3files/none/phase2-integration",

  "decisions_made": [
    {"id": "D001", "summary": "JWT over session cookies", "rationale": "stateless API 요구"}
  ],

  "open_questions": [
    "refresh token rotation 주기 미결정"
  ],

  "entry_requirements_for_next": {
    "required_files": ["src/api/auth.ts"],
    "required_state": "all auth tests passing",
    "context_needed": "JWT 구조 이해"
  },

  "negative_results": [
    {"attempted": "OAuth2 PKCE flow", "reason": "server-side only이므로 불필요", "learning": "클라이언트 없는 API에는 PKCE 불필요"}
  ]
}
```

**Strip Encoding (X13)**: 한 줄 요약 `{status}/{files_touched}/{blockers}/{next_action}` — DM 전송 시 사용.

**Accepting Controller Pre-Condition (H1)**: `entry_requirements_for_next` 필드를 다음 phase agent의 spawn 전 검증. 미충족 시 spawn 거부.

**Continue-As-New (H7)**: agent가 `max_steps_before_refresh` 초과 시 현재 state를 handoff 파일로 저장 → 자신을 재spawn 요청. Context 비대화 방지.

### 3.4 Agent 세션 보존 — Episodic Snapshot + Resume (X18)

Agent 종료 시 구조화 스냅샷 저장, 재spawn 시 자동 복원.

**Snapshot 스키마** (`.tmp/agent-context/{agent-name}.snapshot.json`):
```json
{
  "agent_name": "scan-memori-nemoclaw",
  "agent_type": "coding-agent",
  "snapshot_at": "2026-03-26T15:00:00Z",
  "session_id": "abc123",

  "task_state": {
    "original_task": "Memori + NemoClaw deep scan",
    "completion_pct": 100,
    "current_step": "completed"
  },

  "files_read": ["memori/memory/_manager.py", "nemoclaw/src/blueprint/runner.ts"],
  "files_modified": [],

  "key_findings": [
    "Memori: Entity/Process 3-Level Attribution",
    "NemoClaw: Dual-User Filesystem Isolation"
  ],

  "decisions_made": ["D001", "D002"],

  "open_questions": [],
  "next_steps": [],

  "context_summary": "10개 패턴 발견, compose-team 적용 가능 패턴 분류 완료"
}
```

**SubagentStop hook 확장:**
```
기존: transcript에서 핵심 turns 추출 → {type}.md 저장
추가: 구조화 snapshot 생성 → {name}.snapshot.json 저장
```

**SubagentStart hook 확장:**
```
기존: template matching → body + Agent Config 주입
추가: 동일 name의 .snapshot.json 존재 시 → prompt에 자동 주입
      "이전 세션 컨텍스트:" + snapshot 요약
```

**Cross-Session Continuity**: agent-memory(`/.claude/agent-memory/{name}/`)는 세션을 넘어 영속. Snapshot은 세션 내 임시. 중요한 발견은 agent가 자체적으로 agent-memory에 저장하도록 template에 지시.

### 3.5 Team Memory vs Individual Memory 분리

Memori의 Entity/Process 3-Level Attribution 패턴을 Claude Code에 적용.

**3-Level 모델:**

| Level | 대상 | 저장소 | 공유 범위 | 예시 |
|-------|------|--------|----------|------|
| **Team** (= Entity) | 프로젝트/팀 전체 | `.tmp/team-memory/shared-context.jsonl` | 모든 agent | "React 18 사용", "API v2 규격" |
| **Role** (= Process) | 같은 template의 agent 그룹 | `.claude/agent-memory/{template}/` | 같은 역할 | "coding-agent의 이전 코딩 패턴" |
| **Individual** (= Session) | 개별 agent 인스턴스 | `.tmp/agent-context/{name}.snapshot.json` | 자기 자신만 | "현재 작업 진행도" |

**Team Memory 파일 포맷** (`.tmp/team-memory/shared-context.jsonl`):
```jsonl
{"ts":"2026-03-26T14:00:00Z","author":"sprint-leader","type":"fact","content":"프로젝트는 React 18 + TypeScript 5.x 사용","confidence":1.0}
{"ts":"2026-03-26T14:05:00Z","author":"worker-1","type":"discovery","content":"auth 모듈에 순환 의존성 발견","confidence":0.9}
{"ts":"2026-03-26T14:10:00Z","author":"worker-2","type":"constraint","content":"legacy API는 v1 호환 필수","confidence":1.0}
```

**접근 규칙:**
- **쓰기**: 모든 agent가 append 가능 (append-only, 수정/삭제 불가)
- **읽기**: 모든 agent가 전체 읽기 가능
- **관리**: sprint-leader만 eviction 판단 가능

**Memory Isolation by Default (X11)**: agent의 working memory (context window 내용)는 기본 격리. Team memory에 올릴 정보는 agent가 명시적으로 `.tmp/team-memory/shared-context.jsonl`에 append.

### 3.6 Memory Decay / Eviction

장기 세션에서 `.tmp/` 파일 비대화 방지.

**Decay 정책:**

| 파일 | 보존 기간 | Eviction 조건 | 처리 |
|------|----------|-------------|------|
| `shared-context.jsonl` | 현재 세션 | 200줄 초과 | confidence 낮은 순 삭제 |
| `decision-registry.jsonl` | 현재 세션 | 100개 초과 | 오래된 순 요약 압축 |
| `negative-results.jsonl` | 현재 세션 | 50개 초과 | 오래된 순 삭제 |
| `handoff/phase-*.json` | phase+2까지 | phase-3 이전 것 | 삭제 (strip_encoding만 보존) |
| `agent-context/*.snapshot.json` | 다음 세션까지 | 세션 종료 | 핵심만 agent-memory로 승격 |
| `context-budget.json` | 현재 세션 | 세션 종료 | 삭제 |

**Eviction 실행 주체**: sprint-leader가 phase 전환 시 수행. WM에게 "team-memory cleanup 필요" DM → WM이 실행.

**Confidence 기반 정렬 (X6)**: `shared-context.jsonl` 읽기 시 confidence 내림차순 정렬. 상위 N개만 agent prompt에 주입.

### 3.7 Decision Registry (X17)

팀 실행 중 내려진 모든 설계 결정을 구조화 기록.

**파일**: `.tmp/team-memory/decision-registry.jsonl`

**스키마:**
```jsonl
{"id":"D001","ts":"2026-03-26T14:00:00Z","author":"sprint-leader","context":"인증 방식 선택","alternatives":["JWT","session cookie","OAuth2"],"chosen":"JWT","rationale":"stateless API + 마이크로서비스 호환","phase":1,"confidence":0.9}
{"id":"D002","ts":"2026-03-26T14:30:00Z","author":"worker-1","context":"테스트 프레임워크","alternatives":["vitest","jest"],"chosen":"vitest","rationale":"프로젝트 기존 설정 활용","phase":1,"confidence":1.0}
```

**작성 규칙:**
- 기술 선택, 설계 방향, trade-off 판단 시 필수 기록
- agent가 결정 시 자동으로 registry에 append
- `rationale` 필드 필수 — 빈 값 금지
- `alternatives` 2개 이상 필수 — 단일 선택지는 "결정"이 아님

**활용:**
- 다음 phase agent가 handoff 읽을 때 decision-registry 참조
- 사용자가 "왜 이렇게 했어?" 질문 시 registry 검색
- 재작업(rework) 시 이전 결정의 rationale 확인 → 같은 실수 방지

### 3.8 그룹챗 부재 해결 — Shared File Channel

**문제**: Claude Code의 `SendMessage`는 1:1 DM 또는 `to: "*"` 브로드캐스트만 지원. 브로드캐스트는 모든 agent에게 전달되어 비용 높음. 특정 그룹(예: Phase 1 workers만)에게 메시지 전달 불가.

**해결: `.tmp/team-memory/shared-context.jsonl`을 팀 게시판으로 활용**

```
                    ┌─────────────────────────────────┐
                    │  .tmp/team-memory/               │
                    │  shared-context.jsonl             │
                    │  (append-only bulletin board)     │
                    └──────┬───────────┬───────────┬───┘
                           │           │           │
                    ┌──────┴───┐ ┌─────┴────┐ ┌────┴─────┐
                    │ sprint-  │ │ worker-1 │ │ worker-2 │
                    │ leader   │ │          │ │          │
                    └──────────┘ └──────────┘ └──────────┘
```

**프로토콜:**

1. **공유 사실 게시**: Agent가 팀 전체에 알릴 사항 발견 시 → `shared-context.jsonl`에 append
2. **읽기 시점**: Agent가 작업 시작 전, phase 전환 시 최신 항목 읽기
3. **DM 보충**: 긴급 사항은 여전히 DM(`SendMessage`) 사용. 게시판은 비동기.

**메시지 유형 태그:**
```jsonl
{"type":"fact","..."}          # 프로젝트 사실
{"type":"discovery","..."}     # 발견 사항
{"type":"constraint","..."}    # 제약 조건
{"type":"warning","..."}       # 경고/주의
{"type":"decision","..."}      # 결정 사항 (→ decision-registry에도 기록)
{"type":"negative","..."}      # 실패 결과 (→ negative-results.jsonl에도 기록)
```

**비용 비교:**
- `SendMessage to: "*"` (4 agents) = 4 DM = 4 context injection
- 공유 파일 append = 1 Write + agents가 필요 시 1 Read = 최대 5 operation, but context injection 없음

**sprint-leader의 역할**: 주기적으로 shared-context를 읽고, 중요 항목을 특정 agent에게 DM으로 highlight. 게시판 = 비동기 정보 풀, DM = 동기적 지시.

### 3.9 Entity/Process 3-Level Attribution 구현 (서재 Memori)

Memori의 Entity/Process/Session 모델을 Claude Code file-based 시스템으로 매핑.

**매핑:**

| Memori 개념 | Claude Code 구현 | 공유 범위 |
|------------|-----------------|----------|
| **Entity** (사용자/조직) | `.tmp/team-memory/` | 팀 전체 (현재 세션) |
| **Process** (agent 유형) | `.claude/agent-memory/{template}/` | 같은 template (cross-session) |
| **Session** (개별 대화) | agent context window | 자기 자신 (임시) |

**Singleton Writer Queue 적용**:
- 여러 agent가 동시에 `shared-context.jsonl`에 write 시도 → 충돌 가능
- **해결**: append-only JSONL + 파일 시스템 atomic write
- Claude Code에서는 각 agent가 별도 프로세스이므로 동시 write가 드묾
- 만약 충돌 시: 각 agent가 고유 `{agent-name}-buffer.jsonl`에 먼저 쓰고, sprint-leader가 주기적으로 merge

### 3.10 Path-Based Shared Storage

NemoClaw의 Per-Agent Workspace + Shared Skills 패턴 적용.

**디렉토리 구조:**

| 경로 | 소유자 | 접근 | 용도 |
|------|--------|------|------|
| `.tmp/team-memory/` | 팀 전체 | R/W all | 공유 사실, 결정, 실패 |
| `.tmp/handoff/` | sprint-leader | R: all, W: phase 완료 agent | Phase간 인수인계 |
| `.tmp/agent-context/{name}.*` | 개별 agent | R/W: 해당 agent만 | Episodic snapshot |
| `.claude/agent-memory/{template}/` | template 그룹 | R/W: 같은 template | Cross-session 지식 |
| `.claude/wm/` | WM 전용 | R: all, W: WM만 | file-map, project-profile |

**NemoClaw의 Dual-Layer 적용**:
- **읽기 전용 레이어** (gateway): `.claude/wm/`, CLAUDE.md → agent가 수정 불가
- **쓰기 가능 레이어** (sandbox): `.tmp/`, `.claude/agent-memory/` → agent가 자유롭게 기록

---

## 4. compose-team 출력 확장

compose-team JSON에 memory/context 관련 필드 추가.

```json
{
  "team_name": "auth-implementation",
  "context_budget": {
    "model_window": 200000,
    "estimated_total": 85000,
    "utilization": 0.425,
    "per_agent": [
      {"name": "sprint-leader", "base": 8000, "task": 12000, "total": 20000},
      {"name": "worker-1", "base": 8000, "task": 15000, "total": 23000},
      {"name": "worker-2", "base": 8000, "task": 18000, "total": 26000}
    ],
    "budget_strategy": "standard"
  },

  "memory_config": {
    "team_memory_path": ".tmp/team-memory/",
    "handoff_path": ".tmp/handoff/",
    "decision_registry": true,
    "negative_results_sharing": true,
    "max_shared_context_lines": 200,
    "eviction_policy": "confidence_desc"
  },

  "phases": [{
    "id": 1,
    "agents": [{
      "name": "worker-1",
      "context_strategy": {
        "initial_reads": ["src/api/auth.ts"],
        "deferred_reads": ["src/api/middleware/*.ts"],
        "summary_only": [],
        "prerequisite_context": "JWT 인증 흐름 이해"
      },
      "guidance_level": "full",
      "max_steps_before_refresh": 50
    }],
    "handoff_schema": "standard",
    "entry_requirements": null
  }, {
    "id": 2,
    "entry_requirements": {
      "required_files": ["src/api/auth.ts"],
      "required_state": "auth tests passing",
      "depends_on_decisions": ["D001"]
    }
  }]
}
```

---

## 5. Hook 변경 명세

### 5.1 SubagentStop 확장

```
기존 동작:
  Agent transcript → 핵심 turns 추출 → .tmp/agent-context/{type}.md

추가 동작:
  1. transcript에서 구조화 정보 추출:
     - task_state (완료도)
     - files_read / files_modified
     - key_findings
     - decisions_made (decision-registry ID 참조)
     - open_questions / next_steps
  2. .tmp/agent-context/{name}.snapshot.json 저장
  3. 기존 {type}.md도 유지 (하위 호환)
```

### 5.2 SubagentStart 확장

```
기존 동작:
  Uncached agent: template matching → body + Agent Config 주입

추가 동작:
  1. .tmp/agent-context/{name}.snapshot.json 존재 확인
  2. 존재 시 → prompt 끝에 "## 이전 세션 컨텍스트" 섹션 주입
     - task_state, key_findings, open_questions, next_steps
     - 전체 snapshot이 아닌 요약 (2K 토큰 이내)
  3. .tmp/team-memory/shared-context.jsonl에서 최근 20줄 주입
     - "## 팀 공유 컨텍스트" 섹션
```

### 5.3 Phase 전환 시 (sprint-leader 책임)

```
Phase N 완료 시:
  1. 각 worker에게 SBAR 보고 수집
  2. .tmp/handoff/phase-{N}-summary.json 생성
  3. decision-registry에서 해당 phase 결정 요약
  4. negative-results에서 해당 phase 실패 결과 포함
  5. Memory eviction: phase-(N-2) handoff 삭제, shared-context 정리
  6. 다음 phase entry_requirements 검증
  7. Session Lead에게 phase 완료 + 다음 phase spawn 요청
```

---

## 6. 구현 우선순위

### P0 — compose-team V2 출시에 필수

| # | 항목 | 패턴 ID | 구현 난이도 |
|---|------|---------|-----------|
| 1 | Context budget 계산 | X1, O17, C8 | M — compose-team skill 내 로직 |
| 2 | Decision Registry | X17 | S — JSONL append |
| 3 | 그룹챗 대안 (shared-context.jsonl) | 신규 | S — 파일 규약 |
| 4 | Handoff 파일 표준 스키마 | X3, X13, H1 | S — JSON 스키마 정의 |

### P1 — V2 출시 후 1-2 iteration

| # | 항목 | 패턴 ID | 구현 난이도 |
|---|------|---------|-----------|
| 5 | Progressive context 3-Phase | X2, C9, C10, V15 | M — compose-team + WM 연동 |
| 6 | Episodic Snapshot + Resume | X18 | M — SubagentStop/Start hook 확장 |
| 7 | Cross-agent context 주입 | X8, X9 | M — SubagentStart hook에 sibling info |
| 8 | Strip Encoding | X13 | S — handoff 포맷에 포함 |
| 9 | Memory Isolation by Default | X11 | S — 규약 명시 |
| 10 | Negative Results Sharing | K5 | S — JSONL + handoff 포함 |

### P2 — 구조적 변경 필요

| # | 항목 | 패턴 ID | 구현 난이도 |
|---|------|---------|-----------|
| 11 | Memory confidence 정렬 + eviction | X6 | M |
| 12 | session_knowledge XML (hook) | X4 | M |
| 13 | Hierarchical Blackboard | X14 | M |
| 14 | Memory Access Control | X15 | M |
| 15 | Continue-As-New (context 비대화 방지) | H7 | M |
| 16 | Team Memory → agent-memory 승격 | 신규 | M |

---

## 7. 데이터 흐름 다이어그램

```
Session Start
    │
    ▼
compose-team 실행
    │
    ├── Context Budget 계산 ──→ context-budget.json
    ├── Progressive Context 분류 ──→ per-agent context_strategy
    └── Memory Config 설정 ──→ memory_config in JSON
    │
    ▼
Phase 1 시작
    │
    ├── SubagentStart hook
    │   ├── template inject (기존)
    │   ├── 이전 snapshot 로드 (신규)
    │   └── team shared-context 최근 20줄 주입 (신규)
    │
    ├── Worker 실행 중
    │   ├── 발견/결정 → shared-context.jsonl append
    │   ├── 설계 결정 → decision-registry.jsonl append
    │   └── 실패 → negative-results.jsonl append
    │
    ├── Worker 완료/종료
    │   └── SubagentStop hook
    │       ├── {type}.md 저장 (기존)
    │       └── {name}.snapshot.json 저장 (신규)
    │
    └── Phase 1 완료
        │
        ├── sprint-leader: handoff/phase-1-summary.json 생성
        ├── sprint-leader: memory eviction 실행
        └── sprint-leader: entry_requirements 검증
            │
            ▼
Phase 2 시작 (Phase 1 handoff 자동 주입)
    │
    └── ... (반복)
        │
        ▼
세션 종료
    ├── 중요 team-memory → agent-memory 승격 (선택)
    ├── .tmp/ 정리
    └── WM file-map 업데이트
```

---

## 8. 기존 시스템과의 호환성

| 기존 메커니즘 | 변경 | 호환성 |
|-------------|------|--------|
| SubagentStop → {type}.md | 유지 + snapshot.json 추가 | 100% 하위 호환 |
| SubagentStart → template inject | 유지 + snapshot/shared-context 추가 주입 | 100% 하위 호환 |
| WM file-map | 변경 없음 | 100% |
| agent-memory/{name}/ | 변경 없음, 승격 대상으로 활용 | 100% |
| .tmp/file-write-log.jsonl | 변경 없음 | 100% |
| SendMessage DM | 변경 없음, 공유 파일이 보완 | 100% |
| CLAUDE.md | 규약 추가 (team-memory 경로, 작성 규칙) | 추가만 |

---

## 9. Anytype/XYFlow 서재 패턴 반영

서재 deep scan에서 발견한 패턴 중 memory/context에 직접 적용 가능한 것:

| 서재 패턴 | 적용 위치 | 구체 적용 |
|----------|----------|----------|
| **RAF-Batched Event Flushing** (anytype) | shared-context.jsonl 읽기 | 여러 agent의 write를 배치로 묶어 읽기 — sprint-leader가 주기적으로 batch read |
| **Event Priority Sorting** (anytype) | shared-context.jsonl 읽기 순서 | type 우선순위: constraint > warning > decision > discovery > fact |
| **Space-Based Workspace** (anytype) | 멀티 팀 동시 작업 | 팀별 `.tmp/team-memory-{team-name}/` 격리 |
| **Discriminated Union Change** (xyflow) | handoff 파일 변경 유형 | `FileAddChange | FileEditChange | FileDeleteChange` 표준화 |
| **Deferred Update Batching** (anytype) | Phase 전환 | phase 전환 시 handoff + eviction + spawn을 atomic batch로 처리 |
| **Entity/Process Attribution** (Memori) | 3-Level memory | Team(entity) / Role(process) / Individual(session) 분리 |
| **Singleton Writer Queue** (Memori) | shared-context 동시 쓰기 | agent별 buffer → sprint-leader merge |

---

## 보충: EG-Library Expansion Deep Research 발견 (2026-03-28)

> 출처: EG-Library Expansion Deep Research (2026-03-28), 16개 프로젝트 심층 조사

### Context/Memory Top 3 적용 패턴

| 순위 | 패턴 | 출처 (repo) | EG-DESK 적용 |
|------|------|-------------|-------------|
| 1 | **Frozen Snapshot 패턴** | hermes-agent (NousResearch/hermes-agent) | 세션 시작 시 Memory 스냅샷 캡처 → 시스템 프롬프트 주입. 세션 중 write는 디스크만 업데이트 → **prefix cache 보존**. MEMORY.md 2,200자, USER.md 1,375자 char 제한. Skill도 system prompt이 아닌 user message로 주입 |
| 2 | **ReMe 99.5% Compression** | AgentScope (agentscope-ai/agentscope, agentscope-ai/ReMe) | 223,838→1,105 tokens. Hybrid search (vector 70% + BM25 30%). file-based memory (MEMORY.md + daily journals + dialog JSONL). SubagentStop 추출 패턴 강화에 참조 |
| 3 | **60% 임계점 + Proactive Compaction** | stdy-context-tips 간접 검증 (blakecrosley.com) | 50세션 분석: context 60%에서 품질 저하 시작. 현재 95% auto-compaction보다 선제적 트리거 검토 (25-30분 주기). 단일 파일 읽기 비용 8,000-20,000 tokens |

### 정량 데이터 종합

| 지표 | 값 | 출처 |
|------|-----|------|
| ReMe compression | 99.5% (223,838→1,105 tokens) | agentscope-ai/ReMe |
| context-mode reduction | 98% (315KB→5.4KB) | mksglu/context-mode BENCHMARK.md |
| MemCP reduction | 20x (9,380→462 tokens) | dev.to (dalimay28) |
| Knowledge Graph MCP | 49x reduction (monorepo) | medium.com |
| Attention dilution | 20-40% capacity에서 시작 (간접 뒷받침: GPT-4o 99.3%→69.7% at 32K) | diffray.ai |
| Quality degradation | 60% capacity에서 시작 | blakecrosley.com 50세션 |
| Redundant reads | 전체 평균 8%, 세션별 14-68% | dev.to 107세션 (Egor Fedorov) |

### 추가 Memory 패턴

- **PreCompact 2KB Snapshot XML** (context-mode, mksglu/context-mode): 3-tier priority budget (P1 50%=1024B, P2 35%=716B, P3 15%=308B). XML 구조: active_files(최대 10), task_state(pending만), rules(CLAUDE.md 400자), decisions, environment, errors. Budget 초과 시 P3→P2→P1 순 drop
- **BM25 3-layer 검색** (context-mode): Porter stemmer FTS5 → Trigram FTS5 → Fuzzy(Levenshtein). Proximity scoring (sweep-line). Snippet 300자 window + 1500자 cap
- **Files at Different Speeds** (walnut, stackwalnuts/walnut): key.md(거의 안 바뀜) / now.md(매 세이브) / log.md(prepend-only 불변) / insights.md(검증 시에만) / tasks.md(매 세이브). Zero-Context Standard: 새 agent가 사전 컨텍스트 없이 로드해도 작업 가능
- **MemoryMark 비파괴적 마킹** (AgentScope): Important/Compressed/Normal enum. 삭제 아닌 마킹으로 원본 보존. 5필드 요약: task_overview, current_state, important_discoveries
- **Stash Crash Insurance** (walnut): 5개 항목 또는 20분마다 squirrel YAML에 기록 → 터미널 종료 시에도 데이터 보존. 30분 규칙: 30분간 stash 없으면 역방향 스캔
- **Context Anxiety 완화** (Anthropic 블로그 + Inkeep): 모델이 context limit 인지 시 조기 완료. Opus 4.6에서 해소. 5전략: Confidence through abundance, Explicit memory systems, Progressive disclosure, Hybrid retrieval, Pattern monitoring
- **Session Directive Builder 14섹션** (context-mode): Last Request, Pending Tasks, Key Decisions, Files Modified, Unresolved Errors, Git state, Project Rules, MCP Tools Used, Subagent Tasks, Skills Used, Environment, Data References, Intent/Role, Plan Mode
| **Per-Agent Workspace + Shared Skills** (NemoClaw) | 디렉토리 구조 | agent-context = per-agent, team-memory = shared |

### 소스코드 심층 조사 추가 발견 (2026-03-28)

> 출처: 16 explore-agents 소스코드 직접 분석

**context-mode SessionDB SQLite Schema (mksglu/context-mode, src/session/db.ts)**
```sql
-- session_events: SHA256 dedup, priority 1-4
CREATE TABLE session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,         -- "file_read", "git", "decision" 등
  category TEXT NOT NULL,     -- "file", "git", "decision" 등
  priority INTEGER NOT NULL DEFAULT 2,
  data TEXT NOT NULL,         -- truncate 300자
  source_hook TEXT NOT NULL,  -- "PostToolUse", "UserPromptSubmit"
  data_hash TEXT NOT NULL DEFAULT ''  -- SHA256[:16]
);
-- session_resume: 2KB XML snapshot
CREATE TABLE session_resume (
  session_id TEXT NOT NULL UNIQUE,
  snapshot TEXT NOT NULL,     -- 2KB XML
  consumed INTEGER NOT NULL DEFAULT 0  -- 1=already injected
);
```
- MAX_EVENTS_PER_SESSION = 1000 (초과 시 lowest priority + oldest FIFO eviction)
- DEDUP_WINDOW = 5 (최근 5개 내 동일 type+hash 중복 방지)
- WAL mode + synchronous=NORMAL
- Worktree isolation: `__sha256(cwd)[:8]` suffix
- DB 경로: `~/.claude/context-mode/sessions/{sha256(projectDir)[:16]}.db`
- EG-DESK 적용: file-write-log.jsonl → SQLite 전환 시 참조. Priority eviction으로 memory bound 보장

**context-mode Session Directive 14섹션 상세 (src/session/snapshot.ts)**
compact/resume 시 `<session_knowledge>` XML로 주입:
1. Last Request (마지막 사용자 요청, 300자)
2. Pending Tasks (completed/deleted/failed 제외)
3. Key Decisions (150자)
4. Files Modified
5. Unresolved Errors (150자)
6. Git (unique operations)
7. Project Rules (경로만, 마지막 2 segments)
8. MCP Tools Used (tool:count)
9. Subagent Tasks (120자)
10. Skills Used
11. Environment (cwd, env)
12. Data References (150자)
13. Intent / Role
14. Plan Mode (APPROVED/REJECTED/ACTIVE/COMPLETED + 상태별 지시)
- EG-DESK 적용: SubagentStop의 `.tmp/agent-context/` 추출 패턴 강화. 14개 섹션 구조화로 handoff 품질 향상

**walnut ALIVE Framework (stackwalnuts/walnut)**
- Archive: 오래된 데이터, 참조용 보존
- Live: 현재 활성, 항상 로드
- Inactive: 비활성, 조건부 로드
- Volatile: 세션 한정, 세션 종료 시 폐기
- Expired: TTL 초과, 자동 정리
- EG-DESK 적용: team-memory의 lifetime 관리에 참조. shared-context.jsonl의 항목별 TTL 분류

**walnut Capsule System (stackwalnuts/walnut)**
- 프로젝트별 독립 memory capsule
- 교차 프로젝트 참조 가능 (import/export)
- EG-DESK 적용: multi-project 워크스페이스에서 프로젝트간 knowledge 공유 패턴

**walnut Read→Stash→Save 3-Phase Protocol**
1. Read: 파일 읽기 (context에 진입)
2. Stash: 핵심만 추출하여 임시 보관 (squirrel YAML, 5항목 또는 20분마다)
3. Save: 구조화된 memory 파일에 저장
- Crash Insurance: stash가 squirrel YAML에 기록 → 터미널 종료 시에도 데이터 보존
- 30분 규칙: 30분간 stash 없으면 역방향 스캔
- EG-DESK 적용: SubagentStop 추출의 중간 버퍼링. agent crash 시에도 부분 결과 보존

**BrowserOS 3-Tier Memory (browseros-ai/BrowserOS)**
- CORE.md: permanent, 항상 로드
- Daily Notes: 30d TTL, 자동 정리
- SOUL.md: 150 lines max, agent 성격/선호도
- EG-DESK 적용: agent-memory의 tier 분류 모델. CORE(프로젝트 프로필) + Daily(세션 이벤트) + SOUL(agent 특성)

**OpenJarvis 5 메모리 백엔드 (open-jarvis/OpenJarvis)**
- SQLite, Redis, File, Vector, Hybrid
- 하드웨어 인식 라우팅: GPU/CPU/메모리 기반 task 분배
- EG-DESK 적용: 현재 File 기반 → 장기적으로 SQLite/Vector 하이브리드 검토

### Round 2 추가 조사 보충 (2026-03-28)

> 출처: EG-Library Expansion Round 2 추가 조사, COMPOSE_TEAM_V2_RESEARCH.md

**context-mode SQLite FTS5 98% 압축 — MCP 컨텍스트 가상화 + 세션 복원**

context-mode (mksglu/context-mode)에서 MCP 컨텍스트 가상화 + 샌드박스 격리 + SQLite FTS5 전문 검색을 결합한 세션 컨텍스트 관리:

- MCP 컨텍스트 가상화: 세션 데이터를 SQLite에 저장하여 context window 외부에서 관리
- 샌드박스 격리: 각 세션/에이전트의 컨텍스트를 독립적으로 격리
- SQLite FTS5 전문 검색: Full-text search를 통한 세션 컨텍스트 검색. Porter stemmer + Trigram fallback + Fuzzy matching 3계층 검색
- 98% 압축률 달성: 컨텍스트 데이터의 극단적 압축
- 세션 복원 메커니즘: 이전 세션 상태를 FTS5 기반으로 검색하여 복원

> NOTE: Context compaction으로 인해 원문 세부사항이 요약 수준으로 축소됨.

출처: RESEARCH.md 992~1012행 (explore-agent-2, context-mode)

**walnut 세션 간 기억 플러그인 — plain file 기반 프로젝트/사람/결정 기억**

walnut (stackwalnuts/walnut)의 Claude Code context 관리 플러그인:

- 세션 간 프로젝트/사람/결정 기억을 유지
- Plain file 기반 (외부 DB 불필요)
- 설정 파일 fallback 메커니즘: 기본값 → 프로젝트 레벨 → 사용자 레벨 3단계 탐색

출처: RESEARCH.md 1129~1131행 (explore-agent-8, walnut)
