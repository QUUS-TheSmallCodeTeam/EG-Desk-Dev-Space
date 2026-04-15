# compose-team V2 — UX & Cost 설계안

> 담당 영역: 사용자 인터랙션(UX), 비용 최적화, Agent=Tool 등가 원칙, 그룹챗 UX
> 기반: COMPOSE_TEAM_V2_RESEARCH.md (183+ 패턴) + 서재 Deep Scan (19 신규 패턴)
> 2026-03-26

---

## 1. Clarification-First Pipeline

### 문제
compose-team이 모호한 요청을 그대로 팀 구성에 반영 → 불필요한 agent spawn + rework.

### 설계

**패턴**: U1 (Clarification-first), D12 (ESI 2-Step Triage), D15 (Fast Track Lane)

```
User Request
    │
    ▼
┌─────────────────────────────┐
│  Step 1: ESI Triage (2축)   │
│  ─────────────────────────  │
│  축1: 긴급도 (urgency)      │
│    - 즉시 개입? → Level 1   │
│    - 지연 가능? → Level 2-5 │
│  축2: 자원량 (resources)     │
│    - 1 agent 충분? → L4-5   │
│    - multi-agent? → L2-3    │
│    - 전략 판단? → L1        │
└────────────┬────────────────┘
             │
    ┌────────┴────────┐
    │                 │
    ▼                 ▼
 L4-5              L1-3
 Fast Track        Full Pipeline
 (skip below)      (continue)
    │                 │
    │                 ▼
    │    ┌────────────────────────┐
    │    │  Step 2: 모호성 검사    │
    │    │  ─────────────────────  │
    │    │  5가지 유형 분류:       │
    │    │  - missing_info         │
    │    │  - ambiguous_scope      │
    │    │  - conflicting_req      │
    │    │  - unknown_constraint   │
    │    │  - taste_decision       │
    │    └────────────┬───────────┘
    │                 │
    │         모호?   ├── NO → Step 3
    │                 │
    │                 ▼ YES
    │    ┌────────────────────────┐
    │    │  AskUserQuestion       │
    │    │  (유형별 질문 생성)     │
    │    │  + Effort Display      │
    │    └────────────┬───────────┘
    │                 │
    ▼                 ▼
  Single           Step 3:
  Agent            Plan Generation
  즉시 실행         (Section 2)
```

### Claude Code 구현

```markdown
## compose-team Clarification Protocol

1. **ESI Triage** (모든 요청에 적용):
   - `esi_level: 1` = 전략 판단 필요, opus + multi-agent
   - `esi_level: 2` = 복잡 구현, sonnet + 2-4 agents
   - `esi_level: 3` = 표준 구현, sonnet + 1-2 agents
   - `esi_level: 4` = 단순 수정, sonnet + 1 agent (Fast Track)
   - `esi_level: 5` = 사소한 변경, sonnet + skill chain only (Fast Track)

2. **Fast Track** (ESI 4-5):
   - compose-team 전체 프로세스 스킵
   - 즉시 single agent 또는 skill chain 추천
   - 출력: `{ "fast_track": true, "agent": "coding-agent", "task": "...", "model": "sonnet" }`

3. **Clarification** (ESI 1-3, 모호성 감지 시):
   - `AskUserQuestion`으로 질문
   - 질문에 항상 Effort Display 포함 (Section 5)
   - 답변 후 재분류 가능 (Re-Triage, D14)
```

---

## 2. Plan-then-Execute (Dry Run → 승인 → 실행)

### 문제
compose-team이 JSON만 출력 → 사용자가 뭘 실행하는지 이해 못 한 채 승인.

### 설계

**패턴**: U3 (Human-readable summary), U4 (Plan-then-execute), U8 (Score Annotation), X17 (Decision Registry)

**4단계 파이프라인:**

```
Step 1: Dry Run (계획만, 실행 없음)
    │
    ├── Human-readable summary (텍스트 + Mermaid)
    ├── Rationale (왜 이 구성인지)
    ├── Execution notes (어떻게 실행할지)
    ├── Cost estimate (예상 토큰/시간)
    └── Key assumptions (핵심 가정 + fallback)
    │
    ▼
Step 2: Interactive Checkpoint (Section 3)
    │
    ▼
Step 3: 승인
    │
    ├── 승인 → JSON 생성 + 디스크 기록
    └── 거부/수정 → Step 1로 (수정사항 반영)
    │
    ▼
Step 4: 실행 (Session Lead가 JSON 기반 spawn)
```

### 출력 포맷 (Dry Run)

```markdown
## Team Plan: [요청 제목]

### Summary
[1-3줄 자연어 요약]

### Architecture
\```mermaid
graph TD
    SL[Session Lead] --> SP[sprint-leader]
    SP --> W1[worker-1: API 구현]
    SP --> W2[worker-2: 테스트]
    WM[WM] -.-> SP
\```

### Agents (3명)
| Role | Template | Model | Lifecycle | Task |
|------|----------|-------|-----------|------|
| sprint-leader | coding-agent | sonnet | reusable | API + 테스트 조율 |
| worker-1 | coding-agent | sonnet | ephemeral | REST API endpoint 구현 |
| worker-2 | coding-agent | sonnet | ephemeral | 통합 테스트 작성 |

### Rationale
- 왜 3명인가: [Brooks 공식: 3명=3채널, 관리 가능]
- 왜 이 패턴인가: [Leader 패턴 — 명확한 spec, 병렬 가능]
- 왜 이 모델인가: [표준 구현 = sonnet 충분]

### Cost Estimate
| 항목 | 예상 |
|------|------|
| 총 agent 수 | 3 (+ WM 상주) |
| 예상 토큰 | ~120K input + ~40K output |
| Context 사용률 | ~35% (여유 충분) |
| 예상 시간 | AI: ~8분 / Human: ~2시간 |

### Key Assumptions (V11)
1. API spec이 확정됨 → 아닐 경우: clarification 추가
2. 기존 테스트 프레임워크 있음 → 아닐 경우: worker-2 task 확장
3. DB 스키마 변경 없음 → 아닐 경우: worker 추가 필요

### Decision Registry Entry
\```json
{
  "decision_id": "CT-2026-0326-001",
  "context": "REST API 엔드포인트 3개 추가",
  "alternatives_considered": ["1명 순차", "2명 분리", "3명 병렬"],
  "chosen": "3명 병렬 (Leader 패턴)",
  "rationale": "API와 테스트 독립적, 병렬 가능, 3명이 최적 팀 규모"
}
\```
```

---

## 3. Interactive Checkpoints

### 문제
compose-team 결과가 일회성 — 중간 확인 없이 전체 실행, 문제 발견 시 rework 비용 큼.

### 설계

**패턴**: U2 (Interactive checkpoints, -71% rework), V11 (Key Assumption Check), U5 (Mechanical vs Taste)

**5개 체크포인트:**

```
CP1: Scope Confirmation (계획 직후)
    "이 범위가 맞나요? [Y/n/수정]"
    - Mechanical 결정 (자동): 파일 수, agent 수, 모델 선택
    - Taste 결정 (노출): 아키텍처 선택, 기존 코드 수정 vs 신규 생성
    │
    ▼
CP2: Pre-Spawn (첫 agent spawn 직전)
    "이 agents를 생성합니다. [Y/n]"
    - Key Assumptions 목록 표시
    - Cost estimate 최종 확인
    │
    ▼
CP3: Phase Gate (각 phase 완료 시)
    "Phase 1 완료. 결과: [요약]. Phase 2 진행? [Y/n/수정]"
    - Mastery Gate (V14): 80%+ 충족 시에만 자동 진행
    - 80% 미만: 사유 + 재시도/스킵 선택지
    │
    ▼
CP4: Pre-Merge (최종 merge 전)
    "다음 변경사항을 merge합니다. [diff 요약] [Y/n]"
    │
    ▼
CP5: Retrospective (작업 완료 후)
    "완료. [결과 요약]. 피드백이 있나요?"
    - Decision Registry 최종 기록
```

### Mechanical vs Taste 분류 규칙

```
Mechanical (자동, 사용자 노출 안 함):
  - 파일 경로 결정 (WM이 제공)
  - agent 수 (팀 캡 내)
  - 모델 선택 (복잡도 기반)
  - lifecycle tier (패턴 규칙)
  - phase 순서 (의존성 기반)

Taste (반드시 사용자 확인):
  - 아키텍처 선택 (새 패턴 vs 기존 패턴 확장)
  - 기존 코드 수정 범위
  - 테스트 전략 (단위 vs 통합 vs E2E)
  - 외부 의존성 추가 여부
  - 성능 vs 가독성 트레이드오프
```

---

## 4. 3-Tier Model Routing (비용 최적화)

### 문제
모든 agent에 동일 모델 → 비용 과다 또는 품질 부족.

### 설계

**패턴**: C1 (3-Tier Routing), C2 (Task complexity signals), C4 (Cost mode downgrade), C5 (Agent frontmatter 패턴)

### 모델 라우팅 매트릭스

```
프로젝트 규칙: opus > sonnet > never haiku

Tier 1 — opus (전략/설계):
  - compose-team 자체 실행 (팀 구성 판단)
  - 아키텍처 설계
  - 복잡한 리팩토링 판단
  - 리뷰/검증 (최종 gate)
  - ESI Level 1 tasks

Tier 2 — sonnet (실행/구현):
  - 코드 구현 (모든 worker 기본)
  - 테스트 작성
  - 문서 작성
  - sprint-leader 조율
  - ESI Level 2-5 tasks

Tier 3 — (never haiku, 프로젝트 규칙)
  - 사용하지 않음
```

### 복잡도 시그널 → 모델 매핑

```
Signal                              → Model
─────────────────────────────────────────────
1-2 파일 + 완전한 spec              → sonnet
multi-file + 명확한 패턴             → sonnet
설계 판단 필요                       → opus
기존 코드 분석 + 수정 판단           → opus
순수 조사 (read-only)               → sonnet
검증/리뷰 (최종 gate)               → opus (V6: Expert Witness 독립성)
```

### BATS (Budget-Aware Tool-use Strategy)

**패턴**: C8 (BATS), C10 (Lazy Skill Loading)

```
Budget Zones:
  Zone A (0-50% 소진): Normal mode
    - 모든 tool 자유 사용
    - 모델 기본 매핑 유지

  Zone B (50-80% 소진): Conservative mode
    - opus task만 유지, 나머지 sonnet
    - tool 호출 횟수 경고 표시

  Zone C (80%+ 소진): Minimal mode
    - 새 agent spawn 금지
    - 기존 agent만 활용
    - 필수 tool만 허용

compose-team 출력에 포함:
  "budget_strategy": {
    "zone": "A",
    "estimated_total_tokens": 160000,
    "budget_remaining_pct": 85,
    "model_overrides": null
  }
```

### Lazy Skill Loading 3-Phase

```
Phase 1: Index Only (97% 토큰 절약)
  agent prompt에 스킬 전체 내용 대신:
  "Available skills: setup-refs (레퍼런스 관리), simulate (UX 시뮬), ..."
  → 이름 + 1줄 설명만

Phase 2: On-Demand Load
  agent가 스킬 필요 판단 → Skill tool 호출 → 해당 스킬만 전체 로드

Phase 3: Execute
  로드된 스킬 지시에 따라 실행

compose-team이 agent prompt에:
  "skills_available" 필드에 요약만 포함 (전체 주입 금지)
```

---

## 5. Effort Compression 표시

### 문제
사용자가 AI 작업의 가치를 체감 못 함. "이거 직접 해도 되는데?"

### 설계

**패턴**: C3 (Effort Compression), U7 (Effort display)

### 모든 AskUserQuestion에 Effort Display 포함

```markdown
## 제안: REST API 엔드포인트 3개 추가

| 방법 | 예상 시간 | 비고 |
|------|----------|------|
| 🤖 AI (이 팀) | ~8분 | 3 agents 병렬 |
| 👤 Human (직접) | ~2시간 | 순차 작업 |
| 절약 | **~93%** | |

진행할까요? [Y/n/수정]
```

### Effort 계산 공식

```
AI_time = (estimated_tokens / tokens_per_second) + spawn_overhead
Human_time = file_count * avg_minutes_per_file + test_time + review_time

compression_ratio = 1 - (AI_time / Human_time)
```

### compose-team 출력 필드

```json
{
  "effort": {
    "ai_minutes": 8,
    "human_hours": 2.0,
    "compression_pct": 93,
    "breakdown": {
      "implementation": { "ai": "5m", "human": "1h" },
      "testing": { "ai": "2m", "human": "40m" },
      "review": { "ai": "1m", "human": "20m" }
    }
  }
}
```

---

## 6. Agent=Tool 등가 원칙 (Handoff UX)

### 문제
Agent와 Tool이 별개 개념 → handoff가 복잡, 사용자에게 불투명.

### 설계

**패턴**: browser-operator의 ConfigurableAgentTool, grok-cli의 Foreground Task vs Background Delegate

### 핵심 원칙

```
Agent는 Tool이다.
  - 다른 agent를 "호출"하는 것은 tool을 호출하는 것과 동일
  - agent의 입력 = tool의 arguments
  - agent의 출력 = tool의 result
  - handoff = tool call chain
```

### Claude Code 적용: Task/Delegate 이분법

grok-cli에서 발견한 패턴을 Claude Code에 매핑:

```
Task (Foreground, 파일 수정 가능):
  - Session Lead → Agent(subagent_type, name, team_name)
  - 결과를 기다림 (동기)
  - worker가 파일 생성/수정 가능
  - sprint-leader에게 보고

Delegate (Background, Read-only):
  - Session Lead → Agent(run_in_background: true)
  - 결과를 나중에 수신 (비동기)
  - 조사/분석만 (파일 수정 불가)
  - 완료 시 notification
```

### Handoff UX 시각화

```
compose-team 출력의 phase diagram에 handoff 표시:

Phase 1 ──[handoff: SBAR report]──▶ Phase 2
  │                                    │
  ├─ worker-1 (task)                   ├─ worker-3 (task)
  ├─ worker-2 (task)                   └─ worker-4 (task)
  └─ scout (delegate, bg)
         │
         └──[notification]──▶ sprint-leader
```

### Handoff 메시지 표준 (Strip Encoding, X13)

```
{status}/{files_touched}/{blockers}/{next_action}

예: DONE/3 files (api.ts, test.ts, types.ts)/none/ready for Phase 2 integration
예: BLOCKED/1 file (auth.ts)/missing env var CLERK_SECRET/need clarification
```

---

## 7. 그룹챗 UX 설계

### 문제
현재 모든 통신이 1:1 DM → 사용자에게 팀 전체 상태가 불투명.

### 설계: 3-Layer Communication

```
Layer 1: User-Facing (Session Lead ↔ User)
  ─────────────────────────────────────────
  - 자연어, 태그 미노출
  - 결과 먼저, 그 다음 action/질문
  - Effort Display 포함
  - 진행 상황은 Task 시스템으로 표시

Layer 2: Team Internal (Lead ↔ sprint-leader ↔ workers)
  ─────────────────────────────────────────
  - SendMessage DM (현행 유지)
  - SBAR 포맷 강제 (K1)
  - Closed-Loop 복창 (K2)
  - Evidence 태그 필수 ([조사], [검증] 등)

Layer 3: Coordination (sprint-leader ↔ WM)
  ─────────────────────────────────────────
  - File mapping 요청/응답
  - file-map 업데이트 통보
  - wm-protocol.md 포맷
```

### 사용자에게 보이는 팀 상태 UI

```markdown
## 현재 팀 상태

| Agent | Role | Status | Task | Progress |
|-------|------|--------|------|----------|
| sprint-leader | 조율 | 🟢 active | Phase 1 관리 | 2/3 workers 완료 |
| worker-1 | API 구현 | ✅ done | REST endpoints | 3 files created |
| worker-2 | 테스트 | 🟢 active | 통합 테스트 | 진행 중 |
| scout-1 | 조사 (bg) | 🔵 running | 의존성 분석 | notification 대기 |
| WM | 파일 관리 | 🟢 idle | 상주 | — |
```

Session Lead가 이 테이블을 **phase 완료 시점 (CP3)**에 자동 생성하여 사용자에게 보고.

### Expediter 패턴 (내부 조율 / 외부 인터페이스 분리)

```
외부 인터페이스 (User-facing):
  Session Lead = 유일한 user 접점
  - 깔끔한 요약
  - Effort display
  - 선택지 제시 (AskUserQuestion)
  - 진행률 보고 (CP 시점)

내부 조율 (Team-internal):
  sprint-leader = 내부 조율 전담
  - SBAR 보고 수집
  - 충돌 해결
  - 재배정/에스컬레이션
  - WM 통신

원칙: 내부 복잡성이 외부로 노출되지 않는다
  - worker 실패 → sprint-leader가 재시도 → 성공 시 user에게는 결과만
  - 충돌 발생 → sprint-leader가 해결 → user에게는 최종 결과만
  - user에게 올라가는 것: 결과, 선택 필요 사항, 블로커
```

---

## 8. Call Sheet (1문서 Phase 브리핑)

### 문제
Phase 시작 시 각 agent에게 개별 지시 → 전체 맥락 파편화.

### 설계

**패턴**: K4 (Brief-Debrief Cycle), K6 (Auftragstaktik), K7 (Commander's Intent)

### Call Sheet 포맷

```markdown
# Phase [N] Call Sheet

## Commander's Intent (유저 원본 요청 축약)
[유저가 달성하려는 최종 목표 1-2줄]

## Phase Objective
[이 phase에서 달성할 구체 목표]

## Agents & Tasks
| Agent | Task | Files | Deadline Signal |
|-------|------|-------|-----------------|
| worker-1 | API endpoints | api/*.ts | Phase 1 completion |
| worker-2 | Tests | tests/*.ts | After worker-1 |

## Constraints
- [file scope 제한]
- [모델 제한]
- [budget zone]

## Previous Phase Results (있을 경우)
[Phase N-1 SBAR 요약]

## Handoff Requirements
[다음 phase가 시작되려면 무엇이 필요한지]

## Risk & Fallback
| Risk | Probability | Fallback |
|------|------------|----------|
| [위험1] | [확률] | [대안] |
```

### 구현

compose-team이 phase별 Call Sheet를 자동 생성 → sprint-leader prompt에 포함.
sprint-leader가 worker 개별 task는 Call Sheet에서 추출하여 전달.
Agent별 prompt에는 Call Sheet 전체가 아닌 자기 행(task + files + constraints)만.

---

## 9. Deadline Cascade (역산 마감)

### 문제
Phase간 시간 관리 없음 → 앞 phase가 지연되면 전체 지연.

### 설계

**패턴**: O18 (Time Window Constraint), H5 (Durable Timer), D14 (Re-Triage Protocol)

### 역산 구조

```
Total deadline (사용자 기대 또는 세션 제한)
    │
    ├── Phase N deadline = Total - buffer(20%)
    │     │
    │     ├── Phase N-1 deadline = Phase N deadline - Phase N estimated time
    │     │     │
    │     │     └── ...
    │     │
    │     └── Phase 1 deadline = computed
    │
    └── Buffer = 20% of total (rework, re-triage 여유)
```

### compose-team 출력 필드

```json
{
  "timeline": {
    "total_estimate_minutes": 25,
    "buffer_pct": 20,
    "phases": [
      {
        "phase": 1,
        "estimate_minutes": 8,
        "deadline_from_start": 10,
        "agents": ["worker-1", "worker-2"],
        "trigger": "immediate"
      },
      {
        "phase": 2,
        "estimate_minutes": 6,
        "deadline_from_start": 18,
        "agents": ["worker-3"],
        "trigger": "phase_1_complete"
      }
    ]
  }
}
```

### Re-Triage (D14)

Phase deadline 초과 시:
1. sprint-leader → Session Lead: "Phase 1 지연, 예상 +5분"
2. Session Lead: Deadline cascade 재계산
3. 옵션 제시: (a) 대기, (b) scope 축소, (c) agent 추가
4. User 선택 → 재구성

---

## 10. 서재 Deep Scan 신규 패턴 통합

서재 스캔에서 발견한 19개 신규 패턴 중 UX/Cost 관련:

### spacecake — IDE-as-MCP-Server

**적용**: compose-team의 tool 목록에 IDE 도구 포함 가능성 인지. agent에게 "IDE에서 제공하는 tool이 있을 수 있다"는 context 제공.

### spacecake — Statusline Surface Multiplexing

**적용**: 다중 agent의 상태를 단일 statusline으로 집약 표시. Section 7의 "사용자에게 보이는 팀 상태 UI"의 기술적 근거.

### spacecake — 3-Tier Connection Health Badge

**적용**: agent 상태를 green/yellow/gray 3색으로 집약. compose-team의 agent status를 색상 기반으로 단순화.

### browser-operator — ConfigurableAgentTool

**적용**: Section 6 (Agent=Tool 등가 원칙)의 핵심 레퍼런스. `AgentToolConfig { name, systemPrompt, tools[], handoffs[], lifecycle }` 구조가 우리 agent template frontmatter + body와 유사.

### browser-operator — AgentRunnerEventBus

**적용**: 구조화된 progress event (session_started, tool_started, tool_completed, child_agent_started)를 Section 7 그룹챗 UX의 Layer 2 내부 통신에 참고.

### grok-cli — Foreground Task vs Background Delegate

**적용**: Section 6에 직접 통합. Task(동기, 파일 수정) vs Delegate(비동기, read-only) 이분법.

### grok-cli — Custom Sub-agent Definition UI

**적용**: compose-team이 사용자에게 "이 agent를 커스터마이즈하시겠습니까?" 옵션 제공 가능성. 이름 검증 + reserved name 보호 로직 참고.

### grok-cli — Structured Context Compaction

**적용**: 장기 실행 agent의 context 관리. Section 9의 deadline cascade에서 Phase 간 handoff 시 compaction 포맷 활용 가능:
```
## Goal / ## Constraints / ## Progress (Done/InProgress/Blocked)
## Key Decisions / ## Next Steps / ## Critical Context
```

---

## 구현 우선순위

### P0 (compose-team V2 출시 필수)

| # | 기능 | Section | 패턴 |
|---|------|---------|------|
| 1 | ESI 2-Step Triage + Fast Track | 1 | D12, D15, U1 |
| 2 | Plan-then-Execute (Dry Run) | 2 | U3, U4 |
| 3 | Effort Compression 표시 | 5 | C3, U7 |
| 4 | 3-Tier Model Routing | 4 | C1, C2 |
| 5 | BATS Budget Zone | 4 | C8 |
| 6 | Lazy Skill Loading | 4 | C10 |
| 7 | Expediter (내외부 분리) | 7 | — |

### P1 (V2 출시 후 1-2 iteration)

| # | 기능 | Section | 패턴 |
|---|------|---------|------|
| 1 | 5개 Interactive Checkpoints | 3 | U2, V11, U5 |
| 2 | Mechanical vs Taste 분류 | 3 | U5 |
| 3 | Call Sheet | 8 | K4, K6, K7 |
| 4 | Agent=Tool Handoff UX | 6 | browser-op, grok-cli |
| 5 | Deadline Cascade | 9 | O18, H5, D14 |
| 6 | Decision Registry | 2 | X17 |
| 7 | 그룹챗 3-Layer | 7 | K1, K2 |
| 8 | Strip Encoding | 6 | X13 |
| 9 | Score Annotation 이중 체계 | 2 | U8 |
| 10 | Cache-Aware Prompt Design | 4 | C9 |

### P2 (중기)

- 팀 상태 UI 실시간 갱신
- Custom sub-agent UI 제안 기능
- Per-agent cost accounting (C11)
- Re-Triage 자동 감지
- guidanceOnce (U6)

---

## 다른 설계안과의 인터페이스

이 설계안은 다음 영역과 연동됨:

| 영역 | 인터페이스 포인트 |
|------|------------------|
| **팀 규모 & 오케스트레이션** | ESI level → 팀 캡 결정, 오케스트레이션 패턴 선택 |
| **Agent 라이프사이클** | lifecycle tier → Effort 계산, model routing |
| **실패 처리 & 에스컬레이션** | SBAR 보고 → 그룹챗 Layer 2, Re-Triage → Deadline cascade |
| **컨텍스트 관리** | Context budget → BATS zone, Lazy Loading → agent prompt 크기 |
| **검증 & 품질** | Mastery Gate → CP3, Verification Gate → CP4 |

---

## 핵심 설계 원칙 요약

1. **Fast Track 우선**: 단순한 건 빠르게 (ESI 4-5는 compose-team 스킵)
2. **보여주고 물어라**: Dry Run → 시각화 → 확인 → 실행
3. **비용을 투명하게**: 모든 제안에 Effort + Budget + Model 표시
4. **내부는 복잡, 외부는 단순**: Expediter 원칙 — 내부 조율이 사용자에게 노출되지 않음
5. **Taste는 사용자에게, Mechanical은 자동으로**: 판단이 필요한 결정만 사용자에게 올림

---

## 보충: EG-Library Expansion Deep Research 비용 데이터 (2026-03-28)

> 출처: EG-Library Expansion Deep Research (2026-03-28), 16개 프로젝트 심층 조사

### Anthropic Harness 비용 실측 (anthropic.com/engineering)

| 구성 | 시간 | 비용 | 모델 |
|------|------|------|------|
| Solo Agent | 20분 | $9 | Opus 4.5 |
| Full Harness V1 | 6시간 | $200 | Opus 4.5 |
| Full Harness V2 | 3시간 50분 | $124.70 | Opus 4.6 |

**V2 비용 breakdown**:
| 단계 | 시간 | 비용 | 비율 |
|------|------|------|------|
| Planner | 4.7분 | $0.46 | 0.4% |
| Build Round 1 | 2시간 7분 | $71.08 | 57.0% |
| QA Round 1 | 8.8분 | $3.24 | 2.6% |
| Build Round 2 | 1시간 2분 | $36.89 | 29.6% |
| QA Round 2 | 6.8분 | $3.09 | 2.5% |
| Build Round 3 | 10.9분 | $5.88 | 4.7% |
| QA Round 3 | 9.6분 | $4.06 | 3.2% |

**핵심**: Build가 전체의 86.6%, QA가 8.4%, Planner 0.4% → QA agent 도입 비용이 상대적으로 저렴. V1→V2: 38% 비용 감소 (모델 업그레이드 ROI 근거)

### C 컴파일러 대규모 프로젝트 (Anthropic 블로그 글 C)
- 16 에이전트 x 2주 연속 가동
- 2,000 Claude Code 세션
- Opus 4.6: 2B input + 140M output tokens
- 총 비용: $20,000 미만

### 기타 비용 데이터

| 항목 | 비용 | 출처 |
|------|------|------|
| GEPA Self-Evolution 1 run | $2-10 (GPU 불필요, API 호출만) | NousResearch/hermes-agent-self-evolution |
| autoresearch SkyPilot 16 GPU | $9 Claude API + $300 GPU (8시간) | blog.skypilot.co |
| autoresearch Shopify CEO | 37실험, overnight | fortune.com |
| autoresearch Karpathy 2일 | 700실험, 20 optimizations | fortune.com |

### Budget 관리 패턴 (agent-deck, asheshgoplani/agent-deck)

- **5-Level CheckTx**: daily/weekly/monthly + group/session 한도
- **80% 경고 / 100% 중단**: `BudgetActionWarn` at 80% + `BudgetActionStop` at 100%
- **Fail-safe**: DB 쿼리 실패 시에도 Stop (안전 우선)
- **9-model 가격 테이블**: claude-sonnet-4-6 $3/$15, claude-opus-4-6 $15/$75, gemini-2.5-pro $1.25/$10 등
- **가격 우선순위**: user override > cached pricing.json > hardcoded defaults
- 적용: compose-team V2의 "budget transparency" 설계에 직접 차용 가능

### Auto Compaction API 비용 효과 (Anthropic 공식 cookbook)
- 5 ticket 워크플로우에서 input token 60% 감소 (204K → 82K)
- 총 토큰 58.6% 감소
- haiku 요약 모델로 비용 절감 가능 (compaction_control.model = "claude-haiku-4-5")
6. **Agent는 Tool이다**: handoff = tool call, 사용자에게 투명한 agent 전환

### 소스코드 심층 조사 추가 비용 데이터 (2026-03-28)

> 출처: 16 explore-agents 소스코드 직접 분석

**context-mode 벤치마크 상세 (mksglu/context-mode, BENCHMARK.md)**

| 시나리오 | 원본 | 압축 후 | 절감률 |
|---------|------|---------|--------|
| ctx_execute_file (14 시나리오) | 315KB | 5.5KB | **98%** |
| ctx_index + ctx_search (6 시나리오) | 60.3KB | 11.0KB | **82%** |
| 전체 (21 시나리오) | 376KB | 16.5KB | **96%** |
| 디버깅 세션 | 177.1KB (45,300 tokens) | 10.2KB (2,600 tokens) | **94%** |
- Smart truncation: Head 60% + Tail 40% 보존
- 코드 예제: 100% 보존 (exact, not summarized)
- 테스트: 125 tests all pass
- EG-DESK 적용: SubagentStop 추출 시 head/tail 비율 참고. 코드 블록 보존 우선

**agent-deck 9-Model 가격 테이블 (asheshgoplani/agent-deck)**

| 모델 | Input $/M | Output $/M |
|------|-----------|------------|
| claude-sonnet-4-6 | $3 | $15 |
| claude-opus-4-6 | $15 | $75 |
| gemini-2.5-pro | $1.25 | $10 |
| gemini-2.5-flash | $0.15 | $0.60 |
| gpt-4.1 | $2 | $8 |
| gpt-4.1-mini | $0.40 | $1.60 |
| o4-mini | $1.10 | $4.40 |
| deepseek-r1 | $0.55 | $2.19 |
| deepseek-chat | $0.14 | $0.28 |
- 가격 우선순위: user override > cached pricing.json > hardcoded defaults
- EG-DESK 적용: compose-team V2 budget estimation에 모델별 단가 테이블 내장

**context-mode Search Throttling 비용 절감 (src/store.ts)**
- 60초 윈도우: 1-3회 → 쿼리당 max 2결과, 4-8회 → 1결과, 9회+ → BLOCKED
- ctx_search MAX_TOTAL = 40KB, ctx_batch_execute MAX_OUTPUT = 80KB
- EG-DESK 적용: agent가 과도한 검색으로 context를 낭비하는 패턴 방지

**context-mode Session Lifecycle 비용 효과**
- SessionDB: MAX_EVENTS = 1000 (FIFO eviction으로 메모리 bounded)
- PreCompact snapshot: 2KB (DEFAULT_MAX_BYTES = 2048)
- 7일 이상 된 세션 자동 cleanup
- EG-DESK 적용: team-memory의 TTL 기반 자동 정리 패턴

**hermes-agent Self-Evolution 비용 vs 효과**
- $2-10/run: GPU 불필요, LLM API 호출만
- PR 기반 human review: 자동 적용 아닌 승인 후 반영
- 별도 repo에서 실행: production에 영향 없음
- EG-DESK 적용: skill 자동 최적화의 비용 대비 효과 근거. 월 10회 실행 시 $20-100

**autoresearch 비용 구조 (karpathy/autoresearch)**
- Claude API: $9 (910 실험)
- SkyPilot 16 GPU (8시간): $300
- Shopify CEO: 37실험 overnight
- Karpathy 2일: 700실험, 20 optimizations
- EG-DESK 적용: 대규모 실험의 비용 참고. API 비용은 저렴하나 GPU 비용이 주요

### Round 2 추가 조사 보충 (2026-03-28)

> 출처: EG-Library Expansion Round 2 추가 조사, COMPOSE_TEAM_V2_RESEARCH.md

**agent-deck 비용 추적 via Hook — Stop 이벤트 기반 토큰 사용량 파싱**

`cmd/agent-deck/hook_handler.go`에서 Claude Code Hook의 `Stop` 이벤트를 활용한 비용 추적 구현:

- `Stop` 이벤트 수신 시 `writeCostEvent()` 실행
- 페이로드의 transcript 파일 경로 읽기 → 마지막 assistant 메시지에서 토큰 사용량 파싱
- `~/.agent-deck/cost-events/`에 cost event 기록 (model, input/output tokens, cache metrics)
- StateDB의 `cost_events` 테이블로 LLM 사용 추적 + 예산 중단 트리거
- 비용 데이터를 hook에서 직접 추출하여 별도 API 호출 불필요

출처: RESEARCH.md 1189~1191행 (explore-agent-9, agent-deck)

**agent-skills-cli Suggest Engine — 프로젝트 분석 기반 skill 자동 추천 점수 계산**

`src/core/suggest.ts` (L1-302)에서 프로젝트 분석 → skill 자동 추천 엔진 구현:

Tech Stack 자동 감지:
- Framework: 21개 패턴 (react, next.js, vue, nuxt, angular, svelte, express, fastify, nest.js, remix, astro, gatsby, electron, react-native, flutter, django, flask, fastapi, rails, spring, laravel)
- Library: 20개 패턴 (tailwindcss, prisma, drizzle, zod, redux, zustand, tanstack-query, trpc, graphql, stripe, supabase, firebase, aws-sdk, socket.io, three.js 등)
- Test Tools: 7개 (jest, vitest, mocha, cypress, playwright, testing-library, storybook)
- Build Tools: 7개 (vite, webpack, turbopack, esbuild, tsup, rollup, parcel)
- 언어: JS/TS + Python (pyproject.toml/requirements.txt) + Go (go.mod) + Rust (Cargo.toml) + Java (pom.xml/build.gradle)

Skill 점수 계산 (max 100점):
- Framework match: 40점
- Library match: 30점
- Language match: 15점
- Category match: 10점
- Keyword match: 5점/키워드 (max 20점)
- Popularity bonus: stars >1000 → 5점, >100 → 3점, >10 → 1점

출처: RESEARCH.md 1359~1381행 (explore-agent-13, agent-skills-cli)
