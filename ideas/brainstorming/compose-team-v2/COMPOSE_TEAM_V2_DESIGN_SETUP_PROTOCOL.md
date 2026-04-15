# compose-team V2 Design — Agent Setting & File Prep Protocol

> 담당 영역: 작업 규모별 팀 세팅 전략, agent 토폴로지, 역할 분리, 계층 아키텍처, 사전 컨텍스트 준비, task signaling
> 기반: 16개 프로젝트 심층 조사 (8 worker 보고 + 기존 데이터 종합)
> 2026-03-28

---

## 1. 문제 정의

### 현재 V2에 빠진 개념

| 문제 | 증상 | 근본 원인 |
|------|------|----------|
| **작업 규모별 세팅 전략 부재** | 소규모 lint 수정에도 multi-agent spawn, 대규모 조사에도 one-shot 시도 | compose-team이 "어떻게 팀을 세팅할지"를 규모별로 구분하지 않음 |
| **역할 계층 미정의** | leader가 조사+검증+문서화+조율을 모두 수행 → bottleneck | ground work / metacognitive / writing / orchestration 분리 없음 |
| **사전 준비 프로토콜 없음** | agent spawn 후 "뭘 읽어야 하지?" → 불필요한 Read 폭발 | 작업 시작 전 context pre-staging 프로토콜 미정의 |
| **Task signaling 없음** | leader가 "worker가 받았는지, 시작했는지, 끝났는지" 모름 | ACK/진행/완료 시그널 프로토콜 미정의 |

### 이번 세션의 실증 — EG-Library 확장 조사 (2026-03-28)

이번 세션은 "16개 외부 프로젝트 소스코드 심층 분석 → 7개 V2 설계 문서에 통합"이라는 ESI 1급 작업을 수행하면서 Setup Protocol의 필요성을 실시간으로 재현했다. 아래는 추정이 아닌 실제 발생 경과이다.

**Phase 1: One-shot 시도 (8 worker × 2 repo bundle)**

| 항목 | 실제 값 |
|------|--------|
| Worker 수 | 8명 (explore-agent-3 ~ explore-agent-10) |
| 배정 방식 | 2 repo씩 bundle (예: worker-3 = context-mode + hermes-agent) |
| 결과 | 1차 조사(개요 수준) 완료. 그러나 심층 분석 depth 부족 |
| 전환 사유 | bundle 배정 시 worker가 각 repo에 충분한 context를 할당하지 못함. 2 repo 동시 분석은 "증거 수집만, 판단 금지" L1 원칙을 지키기 어려움 |

**Phase 2: Layered 전환 (16 worker × 1 repo 전담)**

| 항목 | 실제 값 |
|------|--------|
| Worker 수 | 16명 (1:1 repo 전담) |
| 배정 방식 | 1 worker = 1 repo. 예: explore-agent-3 = context-mode, explore-agent-5 = hermes-agent |
| Sprint-leader | explore-agent (L2 Metacognitive — 관점 커버리지 5축 검증) |
| Writer | report-writer (L3 — 유일한 파일 수정자, 7개 문서에 +535줄 통합) |
| Orchestration | Session Lead (L4 — phase 전환, spawn/shutdown) |

**관찰된 문제점 (이 설계의 근거):**

1. **Signaling 부재로 인한 작업 전환 지연**: explore-agent(sprint-leader)가 report-writer에게 "7개 문서 분배 통합 migration 시작" DM을 5회 이상 전송했으나 작업 전환이 발생하지 않음. 원인: DM 미수신 버그 (#34668 — idle 후 DM 수신 불가) + ACK 프로토콜 부재로 미수신 자체를 감지 불가
2. **역할 경계 위반 시도**: report-writer 미응답 시 sprint-leader가 직접 문서 수정을 시도하려 했으나, 기존 feedback memory("문서 수정은 Writer만")에 의해 차단. 이것이 L3 Writer 전용화의 실증 근거
3. **사전 준비 프로토콜 부재**: 16 worker spawn 시 각 worker에게 "어떤 파일을 읽고, 5축 중 어떤 관점에서 분석할지" 사전 매핑 없이 DM으로 지시 → worker별 분석 depth 편차 발생
4. **Phase 전환 비용**: One-shot → Layered 전환 시 기존 8 worker 결과를 16 worker 체제로 재배분해야 했음. 사전에 ESI 기반 mode 선택이 있었다면 불필요한 전환

---

## 2. 핵심 설계: Scale-Dependent Setup Protocol

### 2.1 Setup Mode 선택 (ESI 연동)

compose-team이 ESI triage 결과에 따라 **3가지 Setup Mode** 중 하나를 자동 선택:

| ESI Level | Setup Mode | 팀 구조 | 역할 분리 | 사전 준비 |
|-----------|-----------|--------|----------|----------|
| **4-5** (trivial) | **Direct** | Single agent, no team | 없음 (단일 agent가 전부) | Minimal (task prompt만) |
| **2-3** (standard) | **One-shot** | Leader + Workers bundle | 2-role (Leader/Worker) | Standard (WM file mapping) |
| **1** (strategic) | **Layered** | 4-layer hierarchy | 4-role (Ground/Meta/Write/Orch) | Full (Pre-staging + Bootstrap) |

**결정 기준:**

```
ESI 4-5 → Direct (DKT fast-track, compose-team 스킵)
ESI 3   → One-shot (leader가 workers에게 task 분배, 한 번에 끝내려는 전략)
ESI 2   → One-shot 또는 Layered (복잡도에 따라 compose-team이 판단)
ESI 1   → Layered (반드시 4-layer, phase 분리)
```

**외부 검증:**
- Anthropic harness: "The simplest solution possible, and only increase complexity when needed" (anthropic.com/research/building-effective-agents)
- autoresearch: ESI 4-5급 one-shot의 극단적 예시 (단일 agent + program.md)
- Anthropic 글 C: ESI 1급 layered의 실증 (16 agent × 2주, $20K)

---

### 2.2 Direct Mode (ESI 4-5)

**세팅 내용**: 없음. DKT fast-track으로 즉시 single agent 실행.

```
유저 요청 → DKT keyword 매칭 → single coding-agent spawn → 작업 → 완료
```

**사전 준비**: task prompt에 파일 경로만 포함. WM file mapping 불필요.

**Signaling**: 없음 (단일 agent이므로 Session Lead가 직접 결과 확인).

---

### 2.3 One-shot Mode (ESI 2-3)

**세팅 내용**: Leader + Workers를 한 번에 spawn. Workers에게 task bundle 배정.

```
compose-team JSON → Session Lead가 sprint-leader + workers 동시 spawn
→ sprint-leader가 workers에게 task 분배
→ workers 병렬 작업
→ sprint-leader가 결과 취합 → Session Lead에게 보고
```

**2-Role 분리:**

| 역할 | 담당 | 모델 |
|------|------|------|
| **Leader** (sprint-leader) | task 분배, 결과 취합, 품질 검증 | opus |
| **Worker** (N명) | 실제 작업 수행 | sonnet |

**사전 준비 (Standard Pre-staging):**

1. **WM File Mapping**: WM에게 "이 task에 필요한 파일은?" → agent별 reads + context 매핑
2. **Context Budget 계산**: per_agent = 8K(base) + task_estimate
3. **Spawn Prompt 조립**: task description + file mapping + team structure

**Signaling (Lightweight):**

| 시점 | Worker 행동 | Leader 행동 |
|------|------------|------------|
| 지시 수신 | 즉시 작업 시작 (암묵적 ACK) | 타이머 시작 |
| 작업 중 | (silent — 결과에 집중) | TeammateIdle hook으로 생존 확인 |
| 완료 | SendMessage로 결과 보고 | 결과 수신 확인 → 다음 단계 |

**외부 검증:**
- agent-deck: Dual Launch Mode의 "one-shot" 변형 (`agent-deck launch -m "prompt"`)
- autoresearch: 단일 agent one-shot (program.md → 즉시 실험 루프)
- AutoGen: AgentBuilder (작업 설명 → 자동 팀 구성 → 즉시 실행)

---

### 2.4 Layered Mode (ESI 1)

**세팅 내용**: 4-layer hierarchy로 팀 구성. Phase 분리 + 역할별 전문화.

```
compose-team JSON (layered mode)
→ Session Lead가 Phase 1 agents spawn
→ Phase 1 (Ground Work) 완료
→ Sprint-leader가 Phase 2 (Metacognitive) 실행
→ Phase 3 (Writing) → Phase 4 (Reconcile)
→ 최종 결과
```

**4-Layer Architecture:**

| Layer | 역할 | 담당자 | 모델 | 핵심 원칙 |
|-------|------|--------|------|----------|
| **L1: Ground Work** | 원초적 데이터 수집/생성 | Workers (N명, 1:1 source 전담) | sonnet | "증거 수집만, 판단 금지" |
| **L2: Metacognitive** | 관점 커버리지 검증, 품질 감독 | Sprint-leader | opus | "관점이 빠졌는지, 데이터가 충분한지" |
| **L3: Writing** | 문서화, 유일한 파일 수정자 | Writer (1명) | opus | "파일 수정은 writer만" |
| **L4: Orchestration** | 조율, phase 전환, 사용자 소통 | Session Lead | opus | "결정은 인간에게, 조율은 자동으로" |

**4-Role 분리 상세:**

### L1: Ground Work Workers
- **원칙**: 1 worker per source (1:1 전담). 여러 source를 bundle하지 않음.
- **행동**: 소스 읽기 → 구조화된 발견 보고 (증거 + 출처). 요약/판단 금지.
- **보고 포맷**: 구조화 JSON 또는 Markdown (사전 정의 템플릿)
- **검증**: walnut의 "structured findings with file paths and evidence — no summaries" 원칙

### L2: Metacognitive (Sprint-leader)
- **원칙**: 디테일이 아니라 관점 커버리지를 확인하는 사람.
- **행동**: L1 결과 수신 → 빠진 관점 식별 → L1에 추가 조사 지시 → 새 finding 없을 때까지 반복
- **검증**: Anthropic의 "self-evaluation 실패" 근거로 Generator(L1)와 반드시 분리
- **도구**: L3(Writer)에게 "어느 worker에게 뭘 물어봐라" 지시

### L3: Writing (Writer)
- **원칙**: 파일을 수정하는 유일한 agent. Writer만 Write/Edit 도구 사용.
- **행동**: L2의 지시에 따라 workers에게 DM → 데이터 수집 → 문서 작성
- **검증**: "단일 integrator" 패턴 — 다수 소스의 결과를 한 agent가 통합
- **주의**: Writer가 DM 미수신할 수 있음 (버그 #34668) → sprint-leader가 대안 실행

### L4: Orchestration (Session Lead)
- **원칙**: Phase 전환, agent spawn/shutdown, 사용자 소통만.
- **행동**: compose-team JSON 실행 → phase 1 agents spawn → 완료 시 phase 2 → ... → 최종 보고
- **검증**: Anthropic의 "Orchestration을 LLM이 아닌 deterministic code로" 원칙. 가능한 한 규칙 기반.

**사전 준비 (Full Pre-staging + Bootstrap):**

```
[Phase 0: Bootstrap] ← Layered 모드에서만 실행
  │
  ├── 1. WM Feasibility Report
  │     WM에게 유저 요청 전달 → 관련 파일/복잡도/의존관계 분석
  │
  ├── 2. compose-team JSON 생성
  │     ESI triage → task decomposition → 4-layer 구성 → context budget
  │
  ├── 3. Pre-staging Files
  │     각 L1 worker에게 필요한 파일을 사전 식별:
  │     - initial_reads: spawn prompt에 포함 (즉시 필요)
  │     - deferred_reads: 작업 중 Read 시 자연 로드
  │     - summary_only: 대용량은 WM이 사전 요약
  │
  ├── 4. Call Sheet 생성
  │     .tmp/call-sheets/phase-N.md — phase별 1장 브리핑
  │     "누가 뭘 하고, 어떤 파일을 읽고, 완료 기준은 무엇인지"
  │
  ├── 5. Team Memory 초기화
  │     .tmp/team-memory/ 디렉토리 생성
  │     shared-context.jsonl, decision-registry.jsonl 초기화
  │
  └── 6. Signaling Protocol 설정
        각 agent의 ACK/진행/완료 기대 시그널 정의
```

**외부 검증:**
- Anthropic 글 A: Initializer Agent의 Bootstrap (init.sh + progress.txt + feature_list.json)
- Anthropic 글 B: Planner의 Sprint Contract 사전 협상
- Anthropic 글 C: Docker + bare git repo 사전 준비
- walnut: Pre-Response Protocol (8파일 순서 읽기 + 15K자 예산)
- hermes-agent: Frozen Snapshot (세션 시작 시 Memory 고정)
- context-mode: SessionStart hook (CLAUDE.md 캡처 + routing block 주입)
- OpenJarvis: Pre-execution Context Pipeline (5단계)
- agent-deck: 3-Stage Pre-Session Prep (Shell → Skills → MCP)

---

## 3. Task Signaling Protocol

### 3.1 3-Level Signaling

| Level | Mode | 시그널 | 구현 |
|-------|------|--------|------|
| **Silent** | Direct (ESI 4-5) | 없음 | Session Lead가 직접 결과 확인 |
| **Lightweight** | One-shot (ESI 2-3) | 완료 DM만 | Worker → Leader SendMessage("완료, 결과: ...") |
| **Structured** | Layered (ESI 1) | ACK + 진행 + 완료 | 아래 상세 |

### 3.2 Structured Signaling (Layered 모드)

**Worker → Sprint-leader 시그널:**

| 시점 | 시그널 | 포맷 | 필수? |
|------|--------|------|------|
| 지시 수신 | **ACK** | `[ACK] 지시 수신. {task 요약}. 시작합니다.` | 필수 |
| 작업 시작 | (암묵적) | ACK에 포함 | - |
| 중간 발견 | **DISCOVERY** | `[DISCOVERY] {발견 내용}` (team-memory에도 append) | 선택 |
| 블로커 발생 | **BLOCKED** | `[BLOCKED] {사유}. 대안: {제안}` | 필수 |
| 완료 | **DONE** | `[DONE] {결과 요약}. files_created: [...]` | 필수 |

**Sprint-leader → Session Lead 시그널:**

| 시점 | 시그널 | 포맷 |
|------|--------|------|
| Phase 시작 | **PHASE_START** | `[PHASE_START] Phase {N}: {목표}. Workers: {목록}` |
| 중간 상태 | **STATUS** | `[STATUS] {N}/{total} workers 완료. 발견: {핵심}. 빠진 관점: {있으면}` |
| Phase 완료 | **PHASE_DONE** | `[PHASE_DONE] Phase {N} 완료. Handoff 준비됨.` |
| 에스컬레이션 | **ESCALATE** | `[ESCALATE] {사유}. 유저 판단 필요.` |

**외부 검증:**
- agent-deck: Heartbeat Protocol (`[HEARTBEAT]` → `[STATUS]` + `AUTO:` + `NEED:`)
- nodeskclaw: CloudEvents IntentType (CHAT/COLLABORATE/NOTIFY/COMMAND/ACK)
- CopilotKit AG-UI: Lifecycle Events (RunStarted → StepStarted → ... → RunFinished)
- OpenJarvis: EventBus (AGENT_TURN_START/END, TOOL_CALL_START/END)
- walnut: Session YAML 즉시 등록 (ACK 패턴) + Validation Gate (완료 시그널)

### 3.3 EG-DESK 현행 시스템 매핑

아래는 Signaling Protocol의 각 시그널이 EG-DESK 현행 시스템의 어떤 primitive로 구현되는지를 매핑한다. 추정이 아닌, CLAUDE.md와 hook 구현에서 확인한 매핑이다.

**시그널 → EG-DESK Primitive 매핑:**

| 시그널 | EG-DESK Primitive | 현행 구현 | 비고 |
|--------|------------------|----------|------|
| **ACK** | `SendMessage(to: "sprint-leader")` | Worker가 지시 수신 즉시 DM 전송 | 현재 CLAUDE.md에 ACK 포맷 미정의 → P0에서 추가 필요 |
| **DISCOVERY** | `SendMessage(to: "sprint-leader")` + `.tmp/team-memory/` append | DM + 파일 기록 병행 | team-memory 디렉토리는 Layered mode Phase 0에서 초기화 |
| **BLOCKED** | `SendMessage(to: "sprint-leader")` | Worker가 블로커 보고 | 현행 feedback memory "Agent 미응답 시 유저에게만 보고" 규칙과 연동 |
| **DONE** | `SendMessage(to: "sprint-leader")` + `files_created: [...]` 필수 | CLAUDE.md "완료 보고 시 files_created 필수" 규칙 | 이미 존재하는 convention |
| **PHASE_START** | `SendMessage(to: "session-lead")` | Sprint-leader → Session Lead | 현재 암묵적 — P1에서 명시적 포맷 추가 |
| **STATUS** | `SendMessage(to: "session-lead")` | Sprint-leader 중간 보고 | 현행 "독촉 시 5분 background 알람" 규칙이 STATUS 폴링의 근거 |
| **PHASE_DONE** | `SendMessage(to: "session-lead")` | Sprint-leader → Session Lead | Shutdown Protocol 1단계(WM DM) 트리거 |
| **ESCALATE** | `SendMessage(to: "session-lead")` | Sprint-leader → Session Lead | 현행 "Agent 미응답 시 유저에게만 보고" 규칙의 구조화 버전 |

**Hook 연동:**

| Hook | Signaling 연동 |
|------|---------------|
| `TeammateIdle` | ACK timeout 감지 — Worker idle이면 ACK 미전송으로 판단 |
| `SubagentStop` | 비정상 종료 시 자동 BLOCKED 시그널 생성 가능 (P2) |
| `PreToolUse:Write` (file tracking) | DONE 시그널의 `files_created` 자동 수집 후보 (P2) |
| `SessionStart` | Bootstrap Phase 0의 team-memory 초기화 트리거 |

**TaskUpdate 연동 (현행 vs 제안):**

현행 EG-DESK는 `TaskCreate`/`TaskUpdate`를 Session Lead가 관리하며, agent간 signaling과는 분리되어 있다. 제안: Structured Signaling의 PHASE_START/PHASE_DONE을 TaskUpdate status 변경과 동기화.

```
Worker DONE → sprint-leader가 수신 → TaskUpdate(status: "completed")
Worker BLOCKED → sprint-leader가 수신 → TaskUpdate(status: "blocked", note: 사유)
PHASE_DONE → Session Lead가 수신 → 해당 phase task 일괄 완료 처리
```

### 3.4 Timeout & Fallback

| 시그널 | 기대 시간 | Timeout 시 |
|--------|----------|-----------|
| ACK | 30초 이내 | Sprint-leader가 재지시 1회 → 실패 시 Session Lead에게 에스컬레이션 |
| DONE | Phase timeout (30분) | Sprint-leader가 status 확인 DM → 응답 없으면 agent crash로 판단 → 재spawn |
| BLOCKED | 즉시 | Sprint-leader가 대안 결정 또는 Session Lead에게 에스컬레이션 |

---

## 4. compose-team JSON 확장

### 4.1 Setup Mode 필드 추가

```json
{
  "setup": {
    "mode": "direct | one-shot | layered",
    "bootstrap": {
      "pre_staging": true,
      "call_sheet": true,
      "team_memory_init": true,
      "frozen_snapshot": true
    },
    "signaling": {
      "level": "silent | lightweight | structured",
      "ack_timeout_sec": 30,
      "phase_timeout_min": 30
    }
  }
}
```

### 4.2 Layer 배정 필드 (Layered 모드)

```json
{
  "team": {
    "layers": {
      "ground_workers": [
        {"name": "worker-1", "source": "repo-A", "task": "deep scan"},
        {"name": "worker-2", "source": "repo-B", "task": "deep scan"}
      ],
      "metacognitive": {
        "name": "sprint-leader",
        "role": "관점 커버리지 검증 + 추가 조사 지시"
      },
      "writer": {
        "name": "report-writer",
        "role": "유일한 파일 수정자 + 문서 통합"
      },
      "orchestration": "session-lead (implicit)"
    }
  }
}
```

---

## 5. V2 기존 설계와의 통합

> 아래 매핑은 V2 기존 7개 문서의 **구체적 섹션**과 이 Setup Protocol의 연결점을 명시한다. 참조만 하고 중복 기술하지 않는다.

### 5.1 Orchestration 설계 연동 (→ DESIGN_ORCHESTRATION.md)

| Orchestration 기존 섹션 | 이 설계에서 연결 | 근거 |
|------------------------|----------------|------|
| ESI 5-Level Triage | Setup Mode 3분류의 입력값. ESI 결과가 Direct/One-shot/Layered 선택을 결정 | §2.1 |
| DKT Fast-Track | Direct mode의 실행 경로 그 자체 | §2.2 |
| Handoff Protocol | Phase 전환 시 sprint-leader→Session Lead PHASE_DONE 시그널이 handoff 트리거 | §3.2 |
| AG-UI CoAgent Loop (DESIGN_ORCHESTRATION.md "소스코드 심층 조사" 섹션) | Lifecycle Events (RunStarted→StepStarted→RunFinished)가 Structured Signaling의 외부 표준 참조 | CopilotKit worker 보고 |

### 5.2 ESI Triage 연동

| V2 기존 | 이 설계에서 추가 | 외부 검증 |
|---------|----------------|----------|
| ESI 4-5 → Fast Track | = **Direct** mode | autoresearch: 단일 agent one-shot (worker-5 보고) |
| ESI 3 → Leader pattern | = **One-shot** mode | AutoGen AgentBuilder 자동 팀 구성 (worker-12 보고) |
| ESI 2 → Leader/Council | = **One-shot** 또는 **Layered** | Microsoft CAF 의사결정 트리: 보안/규정/팀 경계 중 하나 해당 시 multi-agent (worker-15 보고) |
| ESI 1 → Multi-agent | = **Layered** mode | Anthropic 글 C: 16 agent × Docker (worker-16 보고) |

### 5.3 Lifecycle 설계 연동 (→ DESIGN_LIFECYCLE.md)

| Lifecycle 기존 섹션 | 이 설계에서 연결 | 근거 |
|--------------------|----------------|------|
| 3-Tier Lifecycle (permanent/reusable/ephemeral) | permanent(WM)=모든 mode 사전 준비. reusable=One-shot workers / Layered L1. ephemeral=Direct single agent | §2.1 |
| GEPA Self-Evolution (DESIGN_LIFECYCLE.md "소스코드 심층 조사" 섹션) | Layered mode에서 L2(Metacognitive)가 worker 관점 커버리지를 반복 검증하는 패턴이 GEPA의 Reflective Prompt Mutation과 유사 | hermes-agent worker 보고 |
| Trust Level 4단계 | Setup mode별 agent 권한 차등: Direct=full trust, One-shot=standard, Layered L1=restricted (Write 금지) | §2.4 L1 규칙 |

### 5.4 Memory 설계 연동 (→ DESIGN_MEMORY.md)

| Memory 기존 섹션 | 이 설계에서 연결 | 외부 검증 |
|-----------------|----------------|----------|
| Team Memory (.tmp/team-memory/) | Layered mode Phase 0에서 초기화. DISCOVERY 시그널이 team-memory에 append | §3.2 |
| Episodic Snapshot | Worker DONE 시 자동 저장 | SubagentStop hook이 transcript 추출 |
| Progressive Context | Pre-staging의 initial/deferred/summary 3단계 | walnut Tiered Context Loading: Tier1(Brief Pack)→Tier2(People)→Tier3(Capsule deep-load) (worker-11 보고) |
| Decision Registry | Layered mode에서 L2가 관리 | walnut Conflict agent 패턴 (worker-11 보고) |
| Frozen Snapshot (DESIGN_MEMORY.md "소스코드 심층 조사" 섹션) | Bootstrap Phase 0에서 Memory 고정. context-mode SessionStart hook이 CLAUDE.md를 캡처하는 것과 동일 원리 | context-mode worker-2 보고, hermes-agent worker-4 보고 |
| BrowserOS 3-Tier Memory (DESIGN_MEMORY.md "소스코드 심층 조사" 섹션) | Pre-staging과 구조적으로 유사: CORE.md(identity)=base prompt, SOUL.md(행동)=task rules, Daily Notes(세션)=context | BrowserOS worker-7 보고 |

### 5.5 Quality 설계 연동 (→ DESIGN_QUALITY.md)

| Quality 기존 섹션 | 이 설계에서 연결 | 외부 검증 |
|-----------------|----------------|----------|
| 4-Status 보고 | Signaling의 DONE/BLOCKED 포맷과 통합 | nodeskclaw Chat Streaming SSE: typing→chunk→done/error 체인 (worker-10 보고) |
| Verification Gate | L2 (Metacognitive)의 관점 커버리지 검증과 통합 | walnut Save Protocol Validation Gate (worker-11 보고) |
| PACE 이의제기 | Worker가 BLOCKED 시그널로 이의제기 | - |
| Security Model (DESIGN_QUALITY.md "소스코드 심층 조사" 섹션) | Layered mode에서 L1 worker의 Write 권한 제한이 OpenDev의 Schema-Level Restrictions와 동일 원리: Planner에게 write tool이 schema에 아예 존재하지 않음 | stdy-context-tips worker-15 보고 |

### 5.6 UX/Cost 설계 연동 (→ DESIGN_UX_COST.md)

| UX/Cost 기존 섹션 | 이 설계에서 연결 | 외부 검증 |
|-----------------|----------------|----------|
| Context Budget | Pre-staging에서 per_agent context budget 계산. initial_reads vs deferred_reads 분리가 token 절약의 핵심 | agent-skills-cli `budget -b 8000` 명령: 토큰 예산 내 최적 skill 조합 결정 (worker-13 보고) |
| Setup Mode별 비용 | Direct < One-shot < Layered 순으로 agent 수/context 비용 증가. ESI triage가 불필요한 over-staffing 방지 | AgentScope Meta Planner Dual-Mode: lightweight ReAct(소규모) vs comprehensive planning(대규모) 자동 선택 (worker-6 보고) |

### 5.7 Research 연동 (→ RESEARCH.md)

| Research 기존 | 이 설계에서 연결 |
|-------------|----------------|
| 16개 프로젝트 조사 결과 | 이 설계 전체의 외부 검증 기반. §7 외부 검증 요약에서 프로젝트별 매핑 |
| 5축 Cross-Reference | Setup Protocol은 Orchestration축(ESI/Handoff) + Memory축(Pre-staging) + Lifecycle축(role 분리) + Quality축(Signaling) 4축에 걸쳐 있음 |

---

## 6. 구현 로드맵

### P0 — 즉시 적용

| # | What | How |
|---|------|-----|
| 1 | Setup Mode 3분류 (direct/one-shot/layered) | compose-team SKILL.md에 ESI→mode 매핑 규칙 추가 |
| 2 | Lightweight Signaling | CLAUDE.md에 worker 완료 보고 포맷 추가 |
| 3 | Pre-staging (initial/deferred/summary) | compose-team JSON의 context_strategy 필드 활용 (기존) |

### P1 — 단기

| # | What | How |
|---|------|-----|
| 4 | Structured Signaling (ACK/DISCOVERY/BLOCKED/DONE) | CLAUDE.md sprint-leader/worker 보고 프로토콜 |
| 5 | Layered mode 4-layer 정의 | compose-team JSON layers 필드 추가 |
| 6 | Bootstrap Phase 0 (call sheet + team memory init) | compose-team 실행 시 자동 생성 |
| 7 | ACK timeout + fallback | sprint-leader 규칙에 추가 |

### P2 — 중기

| # | What | How |
|---|------|-----|
| 8 | Writer 역할 전용화 (유일한 파일 수정자) | bypassPermissions 조정 + worker Write 제한 |
| 9 | Frozen Snapshot 통합 | SessionStart에서 Memory 고정 (hermes-agent 패턴) |
| 10 | Phase 0 자동화 (WM feasibility → compose-team → pre-staging → spawn) | Session Lead 워크플로우 자동화 |

---

## 7. 외부 검증 요약

> 16개 프로젝트 심층 조사 + 6개 키워드 추가 조사에서 확인된 패턴. 출처는 worker 보고 기반.

### 7.1 키워드별 검증 종합

#### #1 Team Setup Strategy (One-shot vs Iterative)

| 패턴 | 출처 | 이 설계에서의 위치 | Worker |
|------|------|------------------|--------|
| "simplest first, add complexity when needed" | Anthropic Building Effective Agents | Setup Mode 3분류의 핵심 원칙 | explore-agent-16 |
| Harness 3단계 진화 (Solo→3-Agent→Simplified) | Anthropic 블로그 | Direct → One-shot → Layered 진화와 대응 | explore-agent-16 |
| Dual Launch Mode (one-shot launch vs iterative conductor) | agent-deck | One-shot vs Layered 구분의 직접 외부 검증 | explore-agent-9 |
| Eager Construction (one-shot agent 조립) | OpenDev Agent Architecture (arxiv 2603.05344) | Direct mode의 즉시 실행 근거 | explore-agent-15 |
| Three-Phase Factory Assembly | OpenDev Agent Architecture (arxiv 2603.05344) | Layered mode Bootstrap 순서의 참조 | explore-agent-15 |
| Single-first Decision Tree | Microsoft CAF | ESI→mode 자동 선택의 판단 기준 참조 | explore-agent-15 |
| Meta Planner Dual-Mode (lightweight ReAct vs comprehensive planning) | AgentScope (arxiv 2508.16279) | ESI 높으면 lightweight, 낮으면 full planning | explore-agent-6 |
| Embedded→Connected 점진적 팀 구성 | CopilotKit / Microsoft Copilot Studio | One-shot(embedded) → Layered(connected) 마이그레이션 | explore-agent-3 |
| One-shot Batch Delegation (최대 3 tasks 병렬) | hermes-agent delegate_tool.py | One-shot mode workers bundle 패턴 | explore-agent-4 |
| autoresearch one-shot setup (program.md 5단계) | autoresearch (Karpathy) | Direct mode의 극단적 one-shot 예시 | explore-agent-5 |
| AutoGen AgentBuilder 자동 팀 구성 | AutoGen (500-ai-agents) | compose-team 자동 팀 구성의 외부 검증 | explore-agent-12 |

#### #2 Agent Topology by Task Scale

| 패턴 | 출처 | 이 설계에서의 위치 | Worker |
|------|------|------------------|--------|
| Centralized-Decentralized-Hybrid 삼분법 | HMAS Taxonomy (arxiv 2508.12683) | Direct(centralized) / One-shot(centralized) / Layered(hybrid) | explore-agent-15 |
| 17x Error Amplification (Flat swarm 위험성) | Towards Data Science | Flat(One-shot)에서 Layered로 전환 필요성의 정량적 근거 | explore-agent-15 |
| Scope-Based Agent Dispatch Scaling (2→5+ agents) | walnut session-context-rebuild | 작업 규모별 agent 수 결정 | explore-agent-11 |
| Java SDK 9종 토폴로지 패턴 | AgentScope Java | Setup mode별 topology 선택지 카탈로그 | explore-agent-6 |
| LangGraph Hierarchical Agent Teams vs Agent Supervisor | LangGraph (500-ai-agents) | Layered(hierarchical) vs One-shot(flat) 양쪽 구현 | explore-agent-12 |
| ChatDev "Software Company" topology | ChatDev (awesome-ai-agents) | Layered mode의 조직도 기반 접근 | explore-agent-14 |
| WorkspaceTemplate topology_snapshot | nodeskclaw | 사전 정의된 topology 템플릿 저장/적용 패턴 | explore-agent-10 |
| Flat parentRunId hierarchy | CopilotKit AG-UI | Flat(단일 canvas) + Hierarchical(subgraph) 지원 | explore-agent-3 |

#### #3 Role Separation Protocol

| 패턴 | 출처 | 이 설계에서의 위치 | Worker |
|------|------|------------------|--------|
| Generator-Evaluator GAN식 분리 | Anthropic 블로그 | L1(Generator) ↔ L2(Evaluator) 분리 근거 | explore-agent-16 |
| Dual-Agent Separation (Plan=read-only vs Execute=read-write) | OpenDev (arxiv 2603.05344) | L1 Write 금지 원칙의 외부 검증 (Schema-level enforcement) | explore-agent-15 |
| Deep Agents 3-Middleware (plan/file/subagent) | CopilotKit | L2(plan) / L3(file=writing) / L1(subagent=ground work) 대응 | explore-agent-3 |
| Supervisor Pattern (조율 + Specialist 실행) | AgentScope Java | L4(Supervisor) + L1(Specialist) 분리 | explore-agent-6 |
| Meta Planner 3-모듈 (RoadmapManager/WorkerManager/Meta) | AgentScope (arxiv 2508.16279) | L2(계획) / L1(실행) / L4(조율) 대응 | explore-agent-6 |
| NodeTypeRegistry RoutingRole (SINK/RELAY/SENSOR) | nodeskclaw | 메시지 라우팅 레벨 역할 강제 | explore-agent-10 |
| researcher-writer-reviewer 3역할 | CrewAI MCP (500-ai-agents) | L1/L3/L2 역할 분리의 직접 외부 검증 | explore-agent-12 |
| MetaGPT SOP-based Role Assignment | MetaGPT (awesome-ai-agents) | 역할별 표준 운영 절차 | explore-agent-14 |
| Conductor/Executor 2-Role Model | agent-deck | L4(Conductor)+L1(Executor) 단순화 | explore-agent-9 |
| Wrapper-based Role Composition (Sandboxed/Guardrails/Trace) | OpenJarvis | Cross-cutting concern 래핑 패턴 | explore-agent-8 |
| Specialized Parallel Subagent Roles (log/file/task/people/conflict) | walnut session-context-rebuild | L1 ground workers 역할별 전문화의 직접 구현 | explore-agent-11 |

#### #4 Layer-Based Team Architecture

| 패턴 | 출처 | 이 설계에서의 위치 | Worker |
|------|------|------------------|--------|
| 3-Layer Architecture (Planner→Generator→Evaluator) | Anthropic 블로그 | 4-layer 중 Ground/Metacognitive/Orchestration 대응 | explore-agent-16 |
| Orchestration = 외부 bash loop (LLM 아님) | Anthropic 글 C | L4를 deterministic code로 처리하는 원칙 | explore-agent-16 |
| 4-Phase Layered Rebuild (Scout→Deep Read→Merge→Resume) | walnut session-context-rebuild | 4-layer와 직접 대응하는 구현 사례 | explore-agent-11 |
| 3-Layer Temporal Hierarchy (Strategic/Tactical/Reactive) | HMAS Taxonomy (arxiv 2508.12683) | 시간 스케일별 계층 분리 | explore-agent-15 |
| 5-Layer Safety Architecture | OpenDev (arxiv 2603.05344) | 보안 관점 계층 분리 | explore-agent-15 |
| data-to-paper Sequential Phase Architecture | data-to-paper (awesome-ai-agents) | Ground→Analysis→Writing 순차 계층 | explore-agent-14 |
| 2-Layer (Orchestrator+Worker) | CopilotKit Deep Agents | 최소 계층 구조 | explore-agent-3 |
| 3-Layer Implicit (Bridge/Conductor/Executor) | agent-deck | 자연 발생 계층 | explore-agent-9 |

#### #5 File/Context Preparation Before Work Starts

| 패턴 | 출처 | 이 설계에서의 위치 | Worker |
|------|------|------------------|--------|
| Initializer Agent Bootstrap (init.sh + progress.txt + feature_list.json) | Anthropic 블로그 A | Bootstrap Phase 0 참조 | explore-agent-16 |
| Sprint Contract 사전 협상 ("done" 정의 합의 후 코딩) | Anthropic 블로그 B | Call Sheet의 완료 기준 사전 정의 | explore-agent-16 |
| Docker + bare git repo 사전 준비 | Anthropic 블로그 C | 인프라 사전 준비 | explore-agent-16 |
| Pre-Response Protocol (8파일 순서 읽기 + 15K자 예산) | walnut | Pre-staging의 initial_reads 참조 | explore-agent-11 |
| Tiered Context Loading (Tier1 Brief Pack→Tier2 People→Tier3 Capsule) | walnut load-context | Progressive Context의 3단계와 직접 대응 | explore-agent-11 |
| Pre-execution Context Pipeline (5단계: Config→Engine→Model→Memory→Routing) | OpenJarvis | Bootstrap Phase 0의 5단계 참조 | explore-agent-8 |
| 3-Stage Pre-Session Prep (Shell→Skills→MCP) | agent-deck | Bootstrap의 환경 준비 3단계 참조 | explore-agent-9 |
| Frozen Snapshot (세션 시작 시 Memory 고정) | hermes-agent | Memory 고정으로 prefix cache 보존 | explore-agent-4 |
| 5종 Context File Pre-loading (SOUL/HERMES/AGENTS/Memory/Skills) | hermes-agent prompt_builder.py | Pre-staging의 다종 파일 사전 로드 참조 | explore-agent-4 |
| SessionStart hook CLAUDE.md 사전 캡처 | context-mode | Bootstrap의 규칙 캡처 참조 | explore-agent-2 |
| Skills Progressive Disclosure (description→read_skill on-demand) | AgentScope Java | initial(description)→deferred(full content) 2단계 | explore-agent-6 |
| Worker Agent Dynamic Instantiation with Toolkit Allocation | AgentScope Meta Planner | Worker spawn 시 사전 toolkit 할당 | explore-agent-6 |
| Planning-before-execution + Context externalization | CopilotKit Deep Agents | To-Do List Middleware(계획) + Filesystem Middleware(외부화) | explore-agent-3 |
| autoresearch 5단계 Setup (파일 읽기→데이터 검증→브랜치→초기화→확인) | autoresearch (Karpathy) | "setup 완료 확인 후에만 작업 시작" 원칙 | explore-agent-5 |
| 3-Tier Memory Pre-loading (CORE/SOUL/Daily Notes) | BrowserOS | Pre-staging의 identity/rules/context 3단계 | explore-agent-7 |
| Vault as Pre-staged Context (3계층 lazy-load + CLAUDE.md + ETL) | obsidian-claude-mcp 생태계 | 외부 지식 저장소 사전 준비 패턴 | explore-agent-17 |
| Bootstrap (agent instruction 파일 자동 생성) + Context Budget | agent-skills-cli | /onboard + compose-team context_strategy의 외부 검증 | explore-agent-13 |
| Deploy Pipeline 2단계 (동기 기록 + 비동기 실행) + Workspace Context 조립 | nodeskclaw | Phase 0의 DB 기록 후 agent 실행 분리 패턴 | explore-agent-10 |
| copilot-setup-steps.yml (의존성 사전 설치) | OpenAI Codex | 작업 전 환경 사전 준비 | explore-agent-15 |

#### #6 Agent Task Signaling

| 패턴 | 출처 | 이 설계에서의 위치 | Worker |
|------|------|------------------|--------|
| Heartbeat Protocol ([HEARTBEAT]→[STATUS]+AUTO:+NEED:) | agent-deck | Structured Signaling 포맷의 주요 참조 | explore-agent-9 |
| Status Transition 기반 시그널링 (상태 전이 자체가 시그널) | agent-deck | ACK 대안: 명시적 ACK 없이 상태 감지로 수신 확인 | explore-agent-9 |
| EventBus Lifecycle Signaling (AGENT_TURN_START/END, TOOL_CALL) | OpenJarvis | PHASE_START/DONE 이벤트의 참조 | explore-agent-8 |
| AG-UI Lifecycle Events (RunStarted→StepStarted→RunFinished) | CopilotKit AG-UI Protocol | Structured Signaling 이벤트 체계의 외부 표준 | explore-agent-3 |
| A2A Protocol Task Signaling (Requests/Results/Errors/Notifications) | Google A2A Protocol | ACK/DONE/BLOCKED/DISCOVERY의 표준화 참조 | explore-agent-15 |
| MCP 4-Type Message Protocol (Requests/Results/Errors/Notifications) | MCP Specification | Signaling 메시지 유형 분류의 참조 | explore-agent-15 |
| Tunnel AUTH→AUTH_OK 즉시 ACK + Ping/Pong 30초 heartbeat | nodeskclaw | ACK 즉시 응답 + liveness check 간격 참조 | explore-agent-10 |
| SSE Registry Heartbeat (15초) + Deploy Progress SSE Streaming | nodeskclaw | Structured Signaling의 인프라 구현 패턴 | explore-agent-10 |
| Chat Streaming SSE 체인 (typing→chunk→done/error) | nodeskclaw | DONE/BLOCKED 시그널의 인프라 구현 패턴 | explore-agent-10 |
| Dual Health Monitoring (HTTP 30초 + Process Poll 5초) | BrowserOS | TeammateIdle hook의 liveness check 강화 참조 | explore-agent-7 |
| File-Based Task Claim (current_tasks/ lock) + Git Commit as Completion | Anthropic 글 C | 비동기 signaling 대안 (file-based) | explore-agent-16 |
| Subagent Progress Callback (tool call relay + thinking relay) | hermes-agent delegate_tool.py | 실시간 진행 피드백 패턴 | explore-agent-4 |
| Session YAML 즉시 등록 (ACK) + Validation Gate (완료 시그널) | walnut | Session 시작 ACK + 완료 검증 게이트 | explore-agent-11 |
| Crash Insurance Checkpoint (5항목 or 20분마다 stash) | walnut | Heartbeat 유사 주기적 중간 저장 | explore-agent-11 |
| Lifecycle Guard (30초마다 parent process 생존 확인) | context-mode lifecycle.ts | 프로세스 수준 liveness check | explore-agent-2 |

### 7.2 키워드별 프로젝트 커버리지 요약

| 프로젝트 | #1 Setup | #2 Topology | #3 Role | #4 Layer | #5 File Prep | #6 Signaling |
|----------|----------|-------------|---------|----------|-------------|-------------|
| Anthropic harness | ● | ● | ● | ● | ● | ○ |
| agent-deck | ● | ● | ○ | ○ | ● | ● |
| walnut | - | ● | ● | ● | ● | ● |
| AgentScope | ● | ● | ● | ● | ● | - |
| CopilotKit | ● | ● | ● | ○ | ● | ○ |
| OpenDev (arxiv) | ● | - | ● | ● | ● | ● |
| nodeskclaw | - | ● | ● | - | ● | ● |
| hermes-agent | ○ | - | - | - | ● | ○ |
| OpenJarvis | - | ○ | ○ | - | ● | ● |
| autoresearch | ● | ○ | ○ | - | ● | - |
| context-mode | - | - | ○ | - | ● | ○ |
| BrowserOS | - | - | ○ | - | ● | ● |
| 500-ai-agents | ○ | ● | ○ | ○ | - | - |
| awesome-ai-agents | - | ● | ● | ○ | - | - |
| obsidian-claude-mcp | - | - | - | - | ● | - |
| agent-skills-cli | - | - | - | - | ○ | - |
| HMAS Taxonomy (arxiv) | - | ● | - | ● | - | - |

> ● = 강한 관련, ○ = 부분 관련, - = 해당 없음

### 7.3 핵심 발견

1. **#5 (File/Context Prep)이 가장 보편적**: 16개 프로젝트 중 14개에서 관련 패턴 발견. Multi-agent든 single-agent든 "작업 전 컨텍스트 준비"는 거의 보편적 패턴.
2. **#6 (Signaling)은 인프라 프로젝트에 집중**: nodeskclaw, agent-deck, BrowserOS 등 인프라 수준 프로젝트에서 정교한 구현. 순수 agent 프레임워크(AgentScope, CopilotKit)에서는 파이프라인/이벤트 시스템에 의존하여 명시적 ACK 미구현.
3. **#1/#2 (Setup/Topology)의 "simplest first" 합의**: Anthropic, Microsoft CAF, AgentScope 모두 "단순→복잡" 점진적 전환을 권장. 이 설계의 ESI-based mode 선택이 업계 합의와 일치.
4. **#3 (Role Separation)의 Generator-Evaluator 분리 합의**: Anthropic, OpenDev, walnut, CopilotKit 모두 "실행자와 평가자를 반드시 분리"에 합의. L1/L2 분리의 강력한 외부 검증.
5. **#4 (Layer Architecture)는 2~4 layer 스펙트럼**: 프로젝트마다 2-layer(CopilotKit)→3-layer(Anthropic)→4-layer(walnut)로 다양. 이 설계의 4-layer는 가장 정교한 쪽이며, ESI 기반으로 필요 시 2-layer(One-shot)로 축소 가능.

---

*설계 초안: explore-agent (Sprint Leader), 2026-03-28*
*보강: report-writer, 16 worker 심층 조사 + 6 키워드 추가 조사 데이터 기반, 2026-03-28*
*기반: 16개 프로젝트 심층 조사 (16 worker 보고) + 6 키워드 추가 조사 (12 worker 보고) + 기존 데이터*
*상태: 보강 완료 — 유저 검토 필요*
