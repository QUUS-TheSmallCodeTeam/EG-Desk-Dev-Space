# compose-team V2 — Implementation Plan

> DESIGN 문서들(이상적 설계)에서 Claude Code에서 실제 구현 가능한 것만 필터링한 구현 계획
> 입력: DESIGN_FINAL, DESIGN_LIFECYCLE, DESIGN_ORCHESTRATION, DESIGN_QUALITY, DESIGN_MEMORY, DESIGN_UX_COST, DESIGN_SETUP_PROTOCOL
> 2026-03-29

---

## 1. Scope: Claude Code 제약 정의

### 사용 가능한 Primitives

| Primitive | 용도 | 제약 |
|-----------|------|------|
| **Hooks (8종)** | SessionStart, PreToolUse, PostToolUse, SubagentStart, SubagentStop, TeammateIdle, UserPromptSubmit, PreCompact | stdout → additionalContext 주입, exit code로 allow/deny |
| **SendMessage** | Agent간 통신 | to:name (1:1) 또는 to:* (broadcast, 비용 높음) |
| **Agent spawn** | cached (subagent_type) / uncached (general-purpose + name) | model, tools, allowedTools, memory, maxTurns 설정 가능 |
| **File I/O** | Read, Write, Edit, Glob, Grep | 파일 시스템 전체 접근 |
| **CLAUDE.md** | Global (~/.claude/CLAUDE.md) + Project (.claude/CLAUDE.md) | 자동 로드, 행동 규칙 정의 |
| **Agent template** | .claude/agents/*.md | frontmatter (model, tools, allowedTools, memory) + body (instructions) |
| **Skills** | .claude/skills/*/SKILL.md | 호출 시 동적 로드, $ARGUMENTS 라우팅 |
| **.tmp/** | 세션 임시 저장소 | git-ignored, 세션 간 비공유 |
| **TaskCreate/Update** | 작업 추적 | UI에 표시, 진행 상태 관리 |
| **Bash** | 임의 명령 실행 | 스크립트, 빌드, 테스트 |
| **WebSearch/WebFetch** | 외부 정보 조회 | 인터넷 접근 |

### 사용 불가

| 불가 항목 | 영향 | 대안 |
|----------|------|------|
| 커스텀 런타임 | 별도 서버/프로세스 불가 | Hook + Bash 조합 |
| 외부 서비스 (DB, Redis) | 구조화 쿼리 불가 | JSONL/JSON 파일 기반 |
| 커스텀 프로토콜 | WebSocket, gRPC 불가 | SendMessage + .tmp/ 파일 |
| Native API 확장 | Claude Code API 수정 불가 | 기존 API 범위 내 활용 |
| MCP 서버 자체 구축 | 서버 프로세스 유지 불가 | 기존 MCP 도구 활용 |
| 실시간 이벤트 스트림 | Push 알림 불가 | Polling (.tmp/ 파일 감시) |

---

## 2. 구현 대상 필터링

### 2.1 DESIGN_FINAL 5대 핵심 변경

| # | 변경 | 우선순위 | 판정 근거 |
|---|------|---------|----------|
| 1 | **3-tier Agent Lifecycle** | **P0** | compose-team SKILL.md에 lifecycle 판정 규칙 추가 + agent template frontmatter 활용. 기존 primitive로 즉시 구현 |
| 2 | **ESI 2-Step Triage + DKT** | **P0** | SKILL.md에 keyword 테이블 + ESI 규칙 추가. LLM 기반 triage는 skill 내부 프롬프트로 구현 |
| 3 | **Evidence-Gated 보고** | **P0** | CLAUDE.md에 4-Status + Verification Gate 프로토콜 추가. 자연어 규칙 |
| 4 | **Team Memory Layer** | **P1** | .tmp/team-memory/ 디렉토리 + JSONL 파일. SubagentStop hook에서 snapshot 저장 |
| 5 | **Budget-Transparent 설계** | **P1** | compose-team 출력 JSON에 budget 필드 추가. WM이 file-map 기반으로 토큰 추정 |

### 2.2 영역별 패턴 필터링

#### DESIGN_ORCHESTRATION

| 패턴 | 우선순위 | 판정 근거 |
|------|---------|----------|
| DKT keyword fast-path (Stage 0) | **P0** | SKILL.md에 keyword 테이블 내장. 순수 프롬프트 규칙 |
| 3단계 파이프라인 (Classify→Match→Validate) | **P0** | SKILL.md 내 단계별 지시문. LLM이 순차 실행 |
| 6가지 오케스트레이션 패턴 | **P0** | SKILL.md에 패턴 정의 + 선택 기준. LLM 판단 |
| 팀 규모 하드캡 (max 5, span 1:4, Brooks) | **P0** | SKILL.md composition rules. 자연어 + 자기 검증 |
| ESI Triage (긴급도 × 자원량) | **P0** | SKILL.md 규칙. LLM 기반 분류 |
| Team Pattern Library (Builtin 6개) | **P1** | SKILL.md에 builtin 패턴 내장. Custom은 .claude/wm/team-patterns.json |
| Filter→Score 매칭 알고리즘 | **P1** | compose-team skill 내부 프롬프트로 구현. WM 데이터 참조 |
| Task Decomposer (atomic/composite) | **P2** | LLM 기반 재귀 분해. 복잡한 프롬프트 엔지니어링 필요 |
| Dynamic Task Ledger + 3 replan triggers | **P2** | .tmp/ 파일 기반 가능하나 OODA loop 자동화 복잡 |
| Typed Relation Detection | **P2** | LLM 기반 의존성 분석. 정확도 보장 어려움 |
| Clarke-Wright Merge | **DEFER** | 수학적 최적화. LLM으로 근사 가능하나 정확도 부족 |
| Above/Below Line 검증 | **DEFER** | 개념적으로 유용하나 자동 판정 기준 불명확 |

출처: DESIGN_ORCHESTRATION.md Section 2-7, RESEARCH.md O1-O9

#### DESIGN_LIFECYCLE

| 패턴 | 우선순위 | 판정 근거 |
|------|---------|----------|
| 3-tier 분류 (permanent/reusable/ephemeral) | **P0** | SKILL.md 판정 규칙. ephemeral → inline prompt, reusable → 기존 template 재사용 |
| WM Hard Contextual Read | **P0** | WM agent가 file-map + agent-file affinity 기반 매칭. SendMessage로 WM에게 요청 |
| maxTurns 가이드라인 | **P0** | Agent template frontmatter `maxTurns` 필드 (native 지원) |
| Lifecycle Rules (ephemeral-first, reuse-first, STO) | **P0** | SKILL.md + CLAUDE.md 규칙 |
| Stocktake (Keep/Improve/Retire/Merge) | **P1** | /codebase-check skill 확장 또는 별도 skill. Glob + Read로 registry 스캔 |
| CompiledSubAgent 재사용 | **P2** | Claude Code의 cached agent 메커니즘 활용. 하지만 세션 간 캐시 보장 없음 |
| Self-evolution (Gene 탈착) | **DEFER** | 런타임 template 동적 수정은 가능하나 안전성 미검증 |

출처: DESIGN_LIFECYCLE.md Section 1-8, RESEARCH.md L1-L4

#### DESIGN_QUALITY

| 패턴 | 우선순위 | 판정 근거 |
|------|---------|----------|
| 4-Status 보고 (DONE/CONCERNS/NEEDS_CONTEXT/BLOCKED) | **P0** | CLAUDE.md 규칙. SendMessage 포맷 표준화 |
| Verification Gate (5-Step Evidence Chain) | **P0** | CLAUDE.md 규칙. worker가 IDENTIFY→RUN→READ→VERIFY→CLAIM 순서 준수 |
| PACE 이의제기 (Probe→Alert→Challenge→Emergency) | **P0** | CLAUDE.md worker 규칙. 자연어 프로토콜 |
| Loop Detection (해시 윈도우) | **P1** | Hook(PreToolUse)에서 tool 호출 패턴 해싱 + .tmp/ 카운터. 경고 주입 |
| Verify-Fix Loop (max 3) | **P1** | compose-team JSON의 max_fix_loops + sprint-leader 규칙 |
| Circuit Breaker | **P1** | .tmp/ 파일 기반 failure 카운트 + cooldown 타이머 (Bash date 비교) |
| Mastery Gate (acceptance_criteria 80%) | **P1** | Sprint-leader 규칙. LLM 판정 |
| Saga Compensation | **P2** | compose-team JSON에 compensating_action 정의. 실행은 sprint-leader가 git revert 등 수동 |
| Temporal Scheduling (CronCreate) | **P2** | CronCreate native 지원. 하지만 phase timeout 자동화는 복잡 |
| Architecture Rule Injection (11-A) | **P1** | 4-Layer Rule Stack은 기존 CLAUDE.md + template + skill + prompt로 즉시 구현. Hook 검증은 P2 |
| Pre-Action Self-Simulation (11-B) | **P1** | Layer 1(template self-check 지시)은 P0급. Layer 2(hook interception)는 P2 |
| Kill/Spike 결정 | **P1** | compose-team JSON의 kill_criteria + sprint-leader 규칙 |
| Naked Reasoner | **DEFER** | 별도 agent spawn (tool 없이 reasoning만) — 비용 높음. 고위험 작업에만 |
| Adversarial Pair | **DEFER** | 2 agent 대립 검증 — 비용 2배. 전략적 결정에만 |

출처: DESIGN_QUALITY.md Section 1-12 + 11-A + 11-B, RESEARCH.md E1-E14

#### DESIGN_MEMORY

| 패턴 | 우선순위 | 판정 근거 |
|------|---------|----------|
| Team Shared Memory (.tmp/team-memory/) | **P1** | .tmp/ 디렉토리 + JSONL. Read/Write로 접근 |
| Decision Registry (append-only JSONL) | **P1** | .tmp/team-memory/decision-registry.jsonl. agent가 Write로 append |
| Negative Results 공유 | **P1** | .tmp/team-memory/negative-results.jsonl. 동일 패턴 |
| Context Budget 계산 | **P1** | WM이 file-map 기반 토큰 추정. compose-team JSON에 포함 |
| Progressive Context (initial/deferred/summary_only) | **P1** | compose-team JSON의 per_agent_context 필드. WM이 file mapping 제공 |
| Structured Compaction (Goal/Progress/Decisions/NextSteps) | **P1** | CLAUDE.md handoff 포맷 규칙. SubagentStop hook에서 강제 |
| Episodic Snapshot + Session Continuity | **P1** | SubagentStop hook에서 JSON snapshot 저장. SubagentStart hook에서 자동 로드 |
| Handoff 구조화 JSON | **P2** | .tmp/handoff/ 디렉토리 + JSON. Phase 전환 시 자동 생성은 hook 복잡도 높음 |
| Selective State Propagation (propagate/isolate) | **P2** | compose-team JSON 선언은 쉬우나 실제 격리 enforcement는 hook 필요 |
| Memory Eviction (priority 기반) | **P2** | .tmp/ 파일의 자동 정리. CronCreate로 주기적 스캔 가능하나 복잡 |
| Frozen Snapshot (prefix cache 보존) | **DEFER** | Claude Code가 prefix cache를 노출하지 않음 |

출처: DESIGN_MEMORY.md Section 1-10, RESEARCH.md M1-M5

#### DESIGN_UX_COST

| 패턴 | 우선순위 | 판정 근거 |
|------|---------|----------|
| Clarification Pipeline (모호성 5유형) | **P0** | SKILL.md 규칙. LLM이 모호성 검사 후 AskUserQuestion |
| Dry Run 시각화 | **P0** | compose-team 출력 후 Mermaid diagram + effort table 생성. 텍스트 출력 |
| Effort Display (AI min / Human hr / Compression %) | **P1** | compose-team JSON의 effort 필드. LLM 추정 |
| BATS Zones (standard/conservative/minimal) | **P1** | Sprint-leader 규칙. budget 소진율에 따라 행동 전환 |
| 5-Checkpoint (CP1~CP5) | **P1** | CLAUDE.md Session Lead 규칙. 각 checkpoint에서 유저 확인 |
| Agent=Tool 등가 (Task/Delegate) | **P1** | SKILL.md에 foreground(Task) vs background(Delegate) 분류 규칙 |
| Call Sheet (.tmp/call-sheets/) | **P1** | Sprint-leader가 phase 시작 시 .tmp/call-sheets/phase-N.md 생성 |
| Mechanical vs Taste 분류 | **P0** | SKILL.md 규칙. decision_type 필드로 자동/유저 선택 분기 |
| Budget Warning 75% | **P0** | CLAUDE.md sprint-leader 모니터링 규칙 |

출처: DESIGN_UX_COST.md Section 1-9, RESEARCH.md U1-U4

#### DESIGN_SETUP_PROTOCOL

| 패턴 | 우선순위 | 판정 근거 |
|------|---------|----------|
| 작업 규모별 세팅 전략 (One-shot/Layered/Phased) | **P0** | SKILL.md에 ESI 기반 mode 선택 규칙. DKT와 연동 |
| 4계층 역할 분리 (L1 Ground/L2 Meta/L3 Writer/L4 Orchestration) | **P0** | compose-team JSON의 역할 필드. SKILL.md 규칙 |
| 사전 컨텍스트 준비 (Pre-staging) | **P1** | WM file mapping → compose-team JSON의 per_agent_context. initial_reads 지정 |
| Task Signaling (ACK/진행/완료) | **P1** | CLAUDE.md 규칙. SendMessage 포맷 표준화. TaskUpdate 활용 |
| Split Delivery (대용량 파일 분할) | **P1** | WM이 file size 기반 분할 판단. context_window × 0.4 임계값 |

출처: DESIGN_SETUP_PROTOCOL.md Section 1-5

---

## 3. 구현 계획 (P0 + P1)

### Phase 1: Foundation (P0 — 의존성 없음, 즉시 구현)

#### 1-1. compose-team SKILL.md 전면 개편

- **What**: V2 3단계 파이프라인 (DKT → Classify → Match → Validate) 적용
- **Where**: `.claude/skills/compose-team/SKILL.md`
- **How**:
  - Stage 0: DKT keyword 테이블 추가 (8 패턴, fast_track/agents/비고)
  - Stage 1: ESI Triage 규칙 (5 Level, 긴급도×자원량 2축)
  - Stage 1: 6가지 오케스트레이션 패턴 정의 (Leader/Council/Pipeline/Swarm/Watchdog/FastTrack)
  - Stage 1: Lifecycle 판정 규칙 (permanent/reusable/ephemeral 3-tier)
  - Stage 1: 작업 규모별 세팅 전략 (One-shot/Layered/Phased)
  - Stage 2: WM Hard Contextual Read 요청 프로토콜 ("WM에게 기존 template 매칭 요청")
  - Stage 2: Filter→Score 매칭 가이드라인
  - Stage 3: Composition Rules (max 5, span 1:4, Brooks ≤ 10)
  - Stage 3: ESS 자기검증 ("빼면? 추가하면?")
  - Stage 3: Context Budget 검사 (agent수 × (8K base + task) ≤ 80% window)
  - 출력 포맷: V2 통합 JSON 스키마 (DESIGN_FINAL Section 2)
  - Clarification Pipeline: 모호성 5유형 → AskUserQuestion
  - Dry Run: 실행 전 Mermaid + effort table 출력
  - Mechanical vs Taste: decision_type 분류 규칙
- **Deps**: 없음

#### 1-2. CLAUDE.md 프로토콜 추가

- **What**: V2 행동 규칙을 CLAUDE.md에 추가
- **Where**: `/Users/minsoocha/Projects/EG-Desk-Dev-Space/.claude/CLAUDE.md` (project-level)
- **How**:
  - **Worker 보고 프로토콜**: 4-Status (DONE/CONCERNS/NEEDS_CONTEXT/BLOCKED) + SBAR 포맷
  - **Verification Gate**: IDENTIFY→RUN→READ→VERIFY→CLAIM 5-Step. DONE 보고 전 필수
  - **PACE 이의제기**: Probe→Alert→Challenge→Emergency 4단계
  - **Budget Warning**: sprint-leader가 75% 소진 시 경고, 90% 시 critical
  - **4계층 역할 분리**: L1 Ground / L2 Meta / L3 Writer / L4 Orchestration 정의
  - **Lifecycle Rules**: ephemeral-first, reuse-first, STO, maxTurns 가이드라인
- **Deps**: 없음

#### 1-3. maxTurns 표준화

- **What**: Agent template에 maxTurns 기본값 적용
- **Where**: `.claude/agents/*.md` (기존 template들)
- **How**: frontmatter에 maxTurns 추가
  - one-shot (조사): maxTurns: 5
  - standard (구현): maxTurns: 15
  - complex (설계): maxTurns: 30
  - orchestrated (sprint-leader): maxTurns 생략 (무제한)
- **Deps**: 없음

### Phase 2: Memory & Context (P1 — Phase 1 완료 후)

#### 2-1. Team Memory 디렉토리 구조

- **What**: .tmp/team-memory/ 기반 팀 공유 메모리
- **Where**: `.tmp/team-memory/` (세션 임시)
- **How**:
  - `shared-context.jsonl`: 팀 전체 공유 사실/결정 (append-only)
  - `decision-registry.jsonl`: 설계 결정 원장 (JSON: {timestamp, agent, decision, rationale, alternatives})
  - `negative-results.jsonl`: 실패 경로 공유 (JSON: {timestamp, agent, approach, failure_reason})
  - CLAUDE.md에 "중요 결정 시 decision-registry에 append" 규칙 추가
- **Deps**: 1-2 (CLAUDE.md 규칙 정의)

#### 2-2. Episodic Snapshot + Session Continuity

- **What**: Agent 종료 시 구조화 snapshot 저장, 재spawn 시 자동 로드
- **Where**: SubagentStop hook (저장), SubagentStart hook (로드)
- **How**:
  - SubagentStop: agent transcript에서 `{task_state, files_modified, decisions_made, open_questions, next_steps}` 추출 → `.tmp/agent-context/{name}.snapshot.json` 저장
  - SubagentStart: 동일 name의 snapshot 존재 시 additionalContext로 주입
  - 기존 SubagentStop hook 확장 (현재 `.tmp/agent-context/{type}.md` 저장 중)
- **Deps**: 없음 (기존 hook 확장)

#### 2-3. Context Budget 계산

- **What**: WM이 file-map 기반으로 agent별 토큰 추정
- **Where**: WM agent 지시문 + compose-team SKILL.md
- **How**:
  - WM에게 "각 agent의 file_scope 파일 크기 합산 → 토큰 추정" 요청 프로토콜
  - compose-team JSON에 context_budget 필드 포함
  - 임계값: agent별 ≤ context_window × 0.7, 팀 전체 ≤ 80%
- **Deps**: 1-1 (compose-team SKILL.md에 JSON 스키마)

#### 2-4. Progressive Context

- **What**: agent별 initial_reads / deferred_reads / summary_only 구분
- **Where**: compose-team JSON의 per_agent_context 필드
- **How**:
  - WM file mapping 시 3단계 분류 요청
  - initial_reads: spawn 시 즉시 읽어야 할 핵심 파일 (< 5개)
  - deferred_reads: 작업 중 필요 시 Read (file 경로만 전달)
  - summary_only: 대용량 파일은 WM이 요약 제공
- **Deps**: 2-3 (Context Budget)

#### 2-5. Structured Compaction

- **What**: Handoff 시 Goal/Progress/Decisions/NextSteps 4필드 강제
- **Where**: CLAUDE.md 규칙 + SubagentStop hook
- **How**:
  - CLAUDE.md: "Phase 전환 handoff 시 4필드 포맷 필수"
  - SubagentStop hook: snapshot에 4필드 구조 강제
- **Deps**: 2-2 (Episodic Snapshot)

### Phase 3: Quality & UX (P1 — Phase 1 완료 후, Phase 2와 병렬 가능)

#### 3-1. Team Pattern Library

- **What**: Builtin 6개 패턴 + Custom 패턴 저장
- **Where**: `.claude/skills/compose-team/SKILL.md` (builtin) + `.claude/wm/team-patterns.json` (custom)
- **How**:
  - SKILL.md에 6 builtin 패턴 정의 (Leader/Council/Pipeline/Swarm/Watchdog/FastTrack)
  - 각 패턴: {name, agents, roles, use_when, avoid_when}
  - Custom: 성공한 팀 구성을 WM이 team-patterns.json에 저장 (수동 트리거)
- **Deps**: 1-1 (compose-team SKILL.md)

#### 3-2. Loop Detection

- **What**: PreToolUse hook에서 반복 패턴 감지 + 경고
- **Where**: PreToolUse hook 확장
- **How**:
  - Tool 호출 (tool_name + file_path) 해싱 → `.tmp/loop-detection.json`에 카운트
  - 3회 반복: warn 메시지 주입 ("동일 패턴 3회 반복. 다른 접근을 고려하세요.")
  - 5회 반복: halt 메시지 주입 ("5회 반복. sprint-leader에게 에스컬레이션하세요.")
- **Deps**: 없음

#### 3-3. Verify-Fix Loop + Kill Criteria

- **What**: 자동 수정 시도 제한 + 중단 기준
- **Where**: CLAUDE.md sprint-leader 규칙 + compose-team JSON
- **How**:
  - compose-team JSON: max_fix_loops (기본 3), kill_criteria per phase
  - CLAUDE.md: "Verification fail 시 3회까지 수정 시도. 초과 시 bail + 현재 상태 보고"
  - kill_criteria: "30분 내 빌드 에러 미해결 시 접근법 재검토"
- **Deps**: 1-2 (CLAUDE.md 프로토콜)

#### 3-4. Effort Display + BATS Zones

- **What**: 비용 투명성 + 예산 기반 행동 전환
- **Where**: compose-team JSON + CLAUDE.md
- **How**:
  - compose-team 출력에 effort 필드: {ai_minutes, human_hours, compression_pct}
  - BATS: standard(< 50%) → conservative(50-80%) → minimal(80%+)
  - Sprint-leader 규칙: BATS zone 전환 시 행동 변경 (conservative: 병렬 축소, minimal: 필수만)
- **Deps**: 1-1 (compose-team SKILL.md)

#### 3-5. Call Sheet

- **What**: Phase별 1장 브리핑 문서
- **Where**: `.tmp/call-sheets/phase-N.md`
- **How**:
  - Sprint-leader가 phase 시작 시 자동 생성
  - 포맷: {phase_goal, agents, task_assignments, file_scope, entry_requirements, kill_criteria}
  - Worker spawn 시 call sheet 경로를 prompt에 포함
- **Deps**: 1-1 (compose-team JSON), 2-4 (Progressive Context)

#### 3-6. Task Signaling (ACK/진행/완료)

- **What**: Worker → Sprint-leader 표준 시그널 프로토콜
- **Where**: CLAUDE.md 규칙
- **How**:
  - ACK: worker가 task 수신 후 "ACK: task [id] 수신, 시작합니다" SendMessage
  - 진행: TaskUpdate로 상태 업데이트 (in_progress)
  - 완료: 4-Status 보고 + TaskUpdate (completed)
  - Sprint-leader: ACK 미수신 시 60초 후 재전송, 2회 실패 시 Session Lead 에스컬레이션
- **Deps**: 1-2 (CLAUDE.md 프로토콜)

#### 3-7. Architecture Rule Injection (Layer 1 + Layer 3)

- **What**: Agent template에 역할 기반 행동 규칙 + self-check 지시 삽입
- **Where**: `.claude/agents/*.md` (기존 template들)
- **How**:
  - 각 template body에 "CAN/CANNOT" 규칙 섹션 추가
  - Sprint-leader: "CAN: 조율, 계획, 검증 지시. CANNOT: 직접 파일 수정, 코드 작성"
  - Worker: "CAN: 지정된 file_scope 내 파일 수정. CANNOT: 다른 worker 영역 수정"
  - Self-check 지시: "Write/Edit 호출 전 '이 행동이 내 역할 규칙에 맞는가?' 확인"
- **Deps**: 1-2 (CLAUDE.md 역할 정의)

#### 3-8. 5-Checkpoint UX

- **What**: 작업 흐름에서 유저 확인 5포인트
- **Where**: CLAUDE.md Session Lead 규칙
- **How**:
  - CP1: 팀 구성 확인 (compose-team Dry Run 후)
  - CP2: 계획 확인 (sprint-leader 계획 수립 후)
  - CP3: Phase 완료 확인 (Phase N 완료 보고 후)
  - CP4: 검증 결과 확인 (Verification Gate 통과 후)
  - CP5: 최종 확인 (전체 작업 완료 후)
- **Deps**: 1-2 (CLAUDE.md 프로토콜)

### Phase 순서 요약

```
Phase 1 (P0): Foundation
  1-1 compose-team SKILL.md 전면 개편
  1-2 CLAUDE.md 프로토콜 추가
  1-3 maxTurns 표준화
  (의존성 없음, 모두 병렬 가능)

Phase 2 (P1): Memory & Context
  2-1 Team Memory 디렉토리 → 2-2 Episodic Snapshot
  2-3 Context Budget → 2-4 Progressive Context → 2-5 Structured Compaction

Phase 3 (P1): Quality & UX
  3-1 Team Pattern Library
  3-2 Loop Detection
  3-3 Verify-Fix Loop
  3-4 Effort Display + BATS
  3-5 Call Sheet (depends: 2-4)
  3-6 Task Signaling
  3-7 Architecture Rule Injection
  3-8 5-Checkpoint UX
  (대부분 병렬 가능, 3-5만 2-4 의존)
```

---

## 4. 기존 시스템 마이그레이션

### 4.1 V1 → V2 전환 대상

| 파일 | 변경 유형 | Breaking Change |
|------|----------|----------------|
| `.claude/skills/compose-team/SKILL.md` | **전면 개편** | Yes — JSON 출력 스키마 변경 |
| `.claude/CLAUDE.md` (project) | **섹션 추가** | No — 기존 내용 유지, 새 프로토콜 추가 |
| `~/.claude/CLAUDE.md` (global) | **수정 불필요** | No — project-level에서 override |
| `.claude/agents/*.md` | **frontmatter 추가** | No — maxTurns, CAN/CANNOT 추가 (기존 호환) |
| SubagentStop hook | **확장** | No — 기존 .md 저장 유지 + .snapshot.json 추가 |
| SubagentStart hook | **확장** | No — snapshot 존재 시 추가 주입 |
| PreToolUse hook | **확장** | No — loop detection 추가 (기존 로직 유지) |
| `.claude/wm/` | **파일 추가** | No — team-patterns.json 추가 |

### 4.2 Breaking Change 상세

**compose-team JSON 출력 스키마 변경**:
- V1: `{agents: [...], prerequisites: [...]}` (간단한 agent 목록)
- V2: 통합 스키마 (classification, tasks, team, context, phases, budget, quality, saga, temporal, validation 등)
- **마이그레이션**: SKILL.md 교체로 즉시 전환. V1 JSON을 소비하는 코드는 없음 (Session Lead가 LLM으로 해석)

### 4.3 Rollback 계획

compose-team SKILL.md를 git으로 관리하므로, V2 문제 발생 시 `git checkout` 으로 V1 복원 가능.

---

## 5. P2/DEFER 항목 로드맵

### P2 항목 (구조 변경 필요)

| # | What | 못하는 이유 | 가능 조건 |
|---|------|-----------|----------|
| 21 | Task Decomposer (재귀 분해) | LLM 기반 재귀 분해의 정확도 보장 어려움. 1회 분해는 P0에 포함되나, atomic/composite 자동 판별은 프롬프트 정교화 필요 | 충분한 few-shot 예시 축적 + 프롬프트 테스트 |
| 22 | Dynamic Task Ledger + 3 replan triggers | OODA loop + stall detection + operational period 자동화. .tmp/ 기반 가능하나 hook 간 상태 공유 복잡 | Hook 간 상태 공유 메커니즘 확립 |
| 23 | Foreground/Background 자동 분류 | DEPENDS_ON 관계 기반 자동 판별. 관계 자체의 정확한 추출이 선행 필요 | Typed Relation Detection (P2 #24) 완료 후 |
| 24 | Typed Relation Detection | LLM 기반 의존성 분석. task 설명만으로 정확한 관계 추출 어려움 | 코드 레벨 의존성 분석 도구 (WM file-map 확장) |
| 27 | Handoff 구조화 JSON 자동 생성 | Phase 전환 시 자동 JSON 생성. hook에서 "현재 phase가 무엇인지" 추적 필요 | Phase lifecycle 상태 머신 구현 (.tmp/ 기반) |
| 28 | Memory Eviction | priority 기반 자동 정리. priority 산정 기준 + CronCreate 주기적 스캔 필요 | BATS zone과 연동한 eviction 정책 정의 |
| 29 | Circuit Breaker | .tmp/ 파일 기반 failure 카운트 + cooldown. Bash date 비교로 가능하나 hook 복잡도 높음 | PreToolUse hook에 failure tracking 추가 |
| 30 | Temporal Scheduling | CronCreate native 지원. 하지만 phase timeout→자동 에스컬레이션 체인 복잡 | CronCreate + SendMessage 연동 패턴 확립 |
| 18 | Saga Compensation | compensating_action 정의는 쉬우나, 자동 실행(git revert 등)의 안전성 검증 필요 | 안전한 rollback 명령 화이트리스트 정의 |
| 26 | Selective State Propagation | compose-team JSON 선언은 쉬우나, 실제 격리 enforcement는 hook 복잡 | agent간 파일 접근 격리 hook 구현 |
| 11-B L2 | Pre-Action Self-Simulation Hook | PreToolUse hook에서 역할별 금지 패턴 매칭. 역할 정보를 hook에 전달하는 메커니즘 필요 | current-agent.json에 역할 정보 포함 |

### DEFER 항목 (현재 불가능)

| # | What | 못하는 이유 | 가능 조건 |
|---|------|-----------|----------|
| Frozen Snapshot | Claude Code가 prefix cache를 노출하지 않음. 캐시 경계 제어 불가 | Claude Code API가 prefix cache hint 제공 시 |
| Clarke-Wright Merge | 수학적 최적화 알고리즘. LLM 근사는 가능하나 정확도 부족 | 외부 최적화 도구 연동 또는 Claude Code 계산 API |
| Above/Below Line 검증 | "이 agent가 sprint-leader 직속(above)인가 아닌가(below)" 자동 판정 기준 불명확 | 충분한 팀 구성 데이터 축적 후 패턴 추출 |
| Self-evolution (Gene 탈착) | 런타임 agent template 동적 수정은 기술적으로 가능하나 안전성 미검증. 의도치 않은 행동 변화 위험 | 안전한 hot-reload 프로토콜 + rollback 보장 |
| Naked Reasoner | Tool 없이 reasoning만 하는 별도 agent. 비용 높음 (opus 모델 필수) | 비용 최적화 + 고위험 결정 식별 자동화 |
| Adversarial Pair | 2 agent 대립 검증. 비용 2배 | 비용 대비 품질 향상 실증 데이터 축적 |
| GEPA 자동 최적화 | 외부 서비스 의존 ($2-10/run). Claude Code에서 직접 실행 불가 | 외부 API 연동 + 비용 승인 프로토콜 |
| AG-UI Protocol | UI layer 구현 필요. Claude Code는 터미널 기반 | Claude Code가 rich UI 지원 시 |
| Observer Agent | 항시 상주하며 모니터링. WM 외 추가 permanent agent는 비용 부담 | 비용 최적화 + 모니터링 필요성 실증 |
| Cross-Project Pattern Mining | 프로젝트 간 팀 구성 패턴 자동 학습. global-team-patterns.json은 가능하나 자동 추출은 복잡 | 충분한 프로젝트 간 팀 구성 데이터 축적 |

---

## 부록: 출처 추적

| 구현 항목 | DESIGN 문서 | 원본 패턴/repo |
|----------|------------|---------------|
| DKT | FINAL 4.1, ORCH 2 | claude-memory Keyword Triage |
| ESI Triage | FINAL 4.3, UX 1 | 응급의학 ESI + D12 |
| 3-tier Lifecycle | FINAL 3.2, LIFE 1-3 | openclaw, best-practice L1 |
| WM Hard Contextual Read | FINAL 3.2, LIFE 4 | ECC team-builder L2 → WM 대체 |
| 4-Status Report | FINAL 3.3, QUAL 1 | 4-Status D3, SBAR 의료 |
| Verification Gate | FINAL 3.3, QUAL 2 | Anthropic harness Sprint Contract |
| PACE | QUAL 3 | PACE 의료 이의제기 |
| Team Pattern Library | ORCH 3 | openclaw RegistryAggregator |
| Loop Detection | QUAL 3.1 | browser-use Action Loop Detector |
| Circuit Breaker | QUAL 8 | Resilience4j, nodeskclaw |
| Saga Compensation | QUAL 9 | Saga Pattern (마이크로서비스) |
| Team Memory | MEM 2-3 | hermes-agent Frozen Snapshot, nodeskclaw Blackboard |
| Decision Registry | MEM 4 | agent-deck Conductor LEARNINGS |
| Context Budget | MEM 5 | agent-skills-cli 4-Signal, blakecrosley 60% threshold |
| Progressive Context | MEM 6 | hermes-agent Progressive Disclosure 3단계 |
| Episodic Snapshot | MEM 7 | context-mode Session Continuity |
| Structured Compaction | MEM 8 | walnut Files at Different Speeds |
| Effort Display | UX 5 | agent-deck Cost Tracking |
| BATS Zones | UX 6 | nodeskclaw Backpressure 4단계 |
| Call Sheet | UX 7 | 영화 제작 Call Sheet |
| Setup Protocol | SETUP 1-5 | 이번 세션 실증 (EG-Library 확장 조사) |
| Architecture Rule Injection | QUAL 11-A | autoresearch program.md, hermes-agent SOUL.md, nodeskclaw Gene System |
| Pre-Action Self-Simulation | QUAL 11-B | nodeskclaw SecurityPipeline, Gene trust check, NO_REPLY |
