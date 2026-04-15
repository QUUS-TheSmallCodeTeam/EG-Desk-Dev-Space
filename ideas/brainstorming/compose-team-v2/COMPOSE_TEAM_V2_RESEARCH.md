# compose-team V2 Research — Comprehensive Report

> 45개 AI 프로젝트 + 22개 비-AI 도메인 + Pioneer R2/R3 최신 연구, 291+ 패턴 통합
> 2026-03-26 ~ 03-27

---

## Executive Summary

compose-team V2는 현재 시스템의 5가지 핵심 문제 — 메타적 자기반성 부족, 현실 감각 부족, Agent 라이프사이클 무시, UX 사이클 미고려, Agent 그룹챗 부재 — 를 해결하기 위한 재설계 연구다.

45개 AI 프로젝트(16 deep scan + 4 프레임워크 + 10 최신 + 15 deep scan R2)와 22개 비-AI 도메인에서 291+개 패턴을 수집했다.

**핵심 발견 3가지**:
1. **팀 규모 제어가 가장 높은 ROI** — 프로젝트 레벨 하드캡(Simple=1-2, Medium=3, Large=5)과 SubagentLimit 미들웨어만으로 과잉 spawn 문제의 80%를 해결할 수 있다
2. **Agent 라이프사이클 3-tier 분류가 핵심** — permanent/reusable/ephemeral 구분 + fuzzy matching 재사용 검사로 불필요한 .md 파일 생성을 방지한다
3. **구조화된 보고(SBAR) + 에스컬레이션(PACE)이 팀 품질을 결정** — 자유 형식 보고를 4필드 표준화하고, worker가 sprint-leader에게 이의를 제기할 경로를 제공하면 "조용한 실패" 문제가 해소된다

**Claude Code 제약 하에서 즉시 적용 가능한 패턴**: ~162개 (P0+P1)
**구조적 변경이 필요한 패턴**: ~89개 (P2)
**장기 연구 대상**: ~40개 (P3 또는 Claude Code 외부 시스템 필요)

4. **비용 인지(Budget-Aware) 패턴이 미래 핵심** — BATS(예산 인지 전략 전환), Cache-Aware Prompt, Lazy Skill Loading 등 토큰 비용을 정량적으로 관리하는 패턴이 여러 출처에서 독립 발견됨. 97% 토큰 절약 사례(Lazy Skill Loading 3-Phase)는 실전 적용 우선순위가 높다

---

## 조사 범위

### AI 프로젝트 (30개)

| # | 프로젝트 | 유형 | 핵심 관련성 |
|---|---------|------|------------|
| 1 | oh-my-claudecode (OMC) | Team Orchestration | staged pipeline, 3-tier model routing, verify-fix loop |
| 2 | ClawTeam | Swarm Intelligence | TOML template, worktree 격리, cross-pollination, task DAG |
| 3 | agent-orchestrator (AO) | Parallel Orchestrator | 8-slot plugin, reaction system, task decomposer, 4-layer prompt |
| 4 | everything-claude-code (ECC) | Harness Optimization | skill-stocktake, team-builder, configure-ecc, skill health engine |
| 5 | superpowers | Subagent Workflows | SDD, 4-status escalation, parallel dispatch 판단, verification gate |
| 6 | bkit-claude-code (bkit) | CTO Lead Pattern | 5 오케스트레이션 패턴, 프로젝트 레벨 팀 캡, PDCA, trust-based automation |
| 7 | gstack | Skill Chain | autoplan, Decision Principles, Mechanical/Taste, effort compression |
| 8 | deer-flow | Middleware Architecture | 13 미들웨어 체인, SubagentLimit, Clarification, Todo 복구, loop detection |
| 9 | awesome-openclaw-agents | Agent Registry | agents.json, SOUL.md 포맷, 24 카테고리, 184 agents |
| 10 | claude-code-best-practice | Agent Config | 16 frontmatter 필드, RPI workflow, Command-Agent-Skill 계층, self-evolution |
| 11 | context-mode | Context Management | FTS5 3-tier search, guidanceOnce, session_knowledge XML, ctx_stats |
| 12 | cc-wf-studio | Workflow Editor | 12 노드 타입, clarification 분기, plan-then-execute, TOON 포맷 |
| 13 | claude-agent-flow | Visualization | JSONL 파싱, FileTouch 레코드, threadHead 패턴, token/cost 추적 |
| 14 | mirofish | Simulation | entity type-agent 파라미터, LLM+rule 하이브리드, 3-tier task 매칭, batch 생성 |
| 15 | sim-studio | Visual Builder | DAG 기반 실행, 노드=역할/엣지=의존성, human-in-the-loop |
| 16 | stdy-context-tips | Context Tips | progressive disclosure, 스크립트 위임, handoff 파일, 회고 |
| 17 | CrewAI | AI Framework | Crews+Flows 이중 레이어, task guardrail+retry |
| 18 | AutoGen | AI Framework | MagenticOne dual-loop ledger, swarm handoff, SocietyOfMind |
| 19 | LangGraph | AI Framework | time-travel checkpoint, cross-graph navigation, namespace store |
| 20 | Mastra | AI Framework | observational memory, delegation hook, completion scoring, memory isolation |
| 21 | Coder/Mux | Latest AI | Best of N — 동일 프롬프트 N개 병렬 실행 후 최선 합성 |
| 22 | MS Agent Framework | Latest AI | Dynamic Task Ledger — 실시간 진화 작업 원장 |
| 23 | Overstory | Latest AI | 4-Tier Conflict Resolution |
| 24 | GitHub Squad | Latest AI | Cross-Agent Review + Charter/History 이중 영속 |
| 25 | DRAMA (논문) | Latest AI | Affinity-Based Dropout Recovery |
| 26 | CCPM | Latest AI | conflicts_with 메타데이터 |
| 27 | Claude-Code-Workflow | Latest AI | Fast-Advance Successor — coordinator 없이 agent-agent 직접 트리거 |
| 28 | myclaude | Latest AI | Risk-Signal Routing — 위험도별 AI 백엔드 전환 |
| 29 | ccswarm | Latest AI | LLM Quality Judge — multi-dimensional auto-scoring |
| 30 | Agent Farm | Latest AI | 34 Tech Stack Templates |
| 31 | deepagentsjs | Deep Scan | General-Purpose Auto Subagent, CompiledSubAgent 재사용, 4-Phase Lifecycle, ontology auto-classification |
| 32 | memory-bank | Deep Scan | Fact Consolidation 4-Way, state exclusion, session continuity, intent prediction, conversation offloading |
| 33 | Memori | Deep Scan | Three-Level Memory Attribution, hybrid ranking, background augmentation queue, semantic triple KG |
| 34 | NemoClaw | Deep Scan | Declarative Policy YAML, blueprint lifecycle, snapshot/restore, operator-in-the-loop, LLM client interceptor |
| 35 | claude-memory | Deep Scan (Memory) | FTS5 BM25 인메모리, LLM-as-Judge 2단계 필터링, 4-Phase Auto-Capture, anti-resurrection, co-occurrence window |
| 36 | claude-mem | Deep Scan (Memory) | Observer Agent, mode system, progressive disclosure 3-layer, token economics, dual-path retrieval, hybrid search |
| 37 | spacecake | Deep Scan (UX) | IDE-as-MCP-Server, statusline surface multiplexing, live task panel, connection status badge, dockable panel |
| 38 | browser-operator | Deep Scan (Agent) | ConfigurableAgentTool(Agent=Tool), 3-tier model fallback, declarative handoff, AgentSession tree, event bus |
| 39 | theia | Deep Scan (IDE) | Declarative Capability Selection, Agent Enable/Disable, Provider-based Tool Bulk, Agent Delegation as Capability, FS Watcher Skill Reload |
| 40 | openmetadata | Deep Scan (Schema) | Field-Presence Operation Derivation, Custom Properties with Schema Validation |
| 41 | browser-use | Deep Scan (Browser) | Action Loop Detector, Message Compaction, Replan-on-Stall, Budget Warning, EventBus+Watchdog, Fallback LLM |
| 42 | anytype | Deep Scan (Event) | RAF-Batched Event Flushing, Event Priority Sorting, Space-Based Workspace, Deferred Update Batching, Reaction Pause/Resume |
| 43 | xyflow | Deep Scan (Graph) | Discriminated Union Change Protocol, Triple-Key Lookup+onBeforeDelete, Parent-Child Subflow |
| 44 | grok-cli | Deep Scan (CLI) | Background Delegation, foreground/background 이분법, structured context compaction, custom sub-agent UI, builtin+custom 이중 체계 |
| 45 | cross-agent (재조사) | Deep Scan (Infra) | mkdir lock, OCC+lock 이중 보호, stale lock 해제, agent pool slot waiting, orphan reaper, cwd session isolation |

### 비-AI 도메인 (22개)

분산 시스템, 게임 AI, 조직 이론, 군사 C2, 생물학, 경제학, 인지과학, 생태학, 항공 관제, 수술팀, 오케스트라, 릴리스 엔지니어링, 법정 절차, Temporal/Durable Execution, 응급실 트리아지, 물류 VRP, 교육/학습 설계, Context Preservation, **재난대응(ICS)**, **뉴스룸**, **주방(Brigade de cuisine)**, **영화 제작**

---

## 현재 compose-team의 문제점 (유저 지적 5가지)

| # | 문제 | 증상 | 근본 원인 |
|---|------|------|----------|
| 1 | **메타적 자기반성 부족** | 자기가 뭘 잘못하는지 모름 | 출력 품질 평가/피드백 루프 없음 |
| 2 | **현실 감각 부족** | 이론적 팀 구성, 실제 실행 제약 미반영 | context window, token 비용, 통신 오버헤드 미계산 |
| 3 | **Agent 라이프사이클 무시** | temporary agent에도 .md 생성, 재사용 체크 없음 | permanent/reusable/ephemeral 구분 없음 |
| 4 | **UX 사이클 미고려** | 생성-사용-폐기 흐름 설계 없음 | agent 생명주기 관리 부재 |
| 5 | **Agent 그룹챗 부재** | 2-3명 선택적 토론 불가, sprint-leader가 모든 통신 중계 (star topology bottleneck) | SendMessage가 1:1 DM 또는 `*` 브로드캐스트만 지원. 채널/그룹 개념 없음. peer review 교환, 동시 brainstorming, 설계 토론이 구조적으로 불가능 |

---

## 패턴 카탈로그 (테마별)

> 범례: 난이도 = S(간단)/M(중간)/H(어려움), 효과 = 1(낮음)~5(높음), CC = Claude Code 적용 가능성 (O/△/X)

### 1. 팀 규모 제어

| ID | 패턴 | 출처 | 난이도 | 효과 | CC | 우선순위 | compose-team 구체 적용 |
|----|------|------|--------|------|-----|---------|----------------------|
| T1 | **프로젝트 레벨 팀 캡** | bkit | S | 5 | O | P0 | `bkit.config.json`의 `levelOverrides` 방식. Simple=1-2, Medium=3, Large=5 하드캡을 compose-team JSON에 `max_agents` 필드로 강제 |
| T2 | **SubagentLimit 미들웨어** | deer-flow | M | 4 | △ | P1 | `after_model` 훅에서 tool_call 수를 [2,4]로 clamp. Claude Code에서는 CLAUDE.md 규칙 + hook으로 구현 |
| T3 | **team-builder max 5** | ECC | S | 4 | O | P0 | agent 디렉토리 스캔 → 도메인 메뉴 → fuzzy matching → max 5 하드캡 |
| T4 | **1 task = 1 agent** | AO | S | 3 | O | P0 | 명확한 소유권 + 병렬 실행. worktree 기반 격리 |
| T5 | **스킬 체인 > 동시 agent** | gstack | S | 4 | O | P0 | 간단한 작업은 1명이 순차 스킬 전환 (Think-Plan-Build-Review-Test-Ship). 불필요한 multi-agent 방지 |
| T6 | **n(n-1)/2 공식** | Brooks' Law | S | 3 | O | P0 | 4 agents=6채널(OK), 6+=비효율. 팀 캡의 수학적 근거를 compose-team 로직에 내장 |
| T7 | **Ringelmann 조정 손실** | 조직심리학 | S | 2 | O | P1 | agent 많을수록 coordination overhead 이차 증가 경고 메시지 출력 |
| T8 | **Cognitive Load 3-4개** | 인지과학 | S | 3 | O | P0 | sprint-leader 동시 관리 4개 이하 하드캡 |
| T9 | **Span of control 1:4** | 군사 C2 | S | 3 | O | P0 | sprint-leader 직속 최대 4 workers |
| T10 | **Rubato Boundary** | 오케스트라 | M | 3 | O | P2 | 팀 규모 비례 자율도 조정: 1-2 agent=높은 자율, 3-4=중간(인터페이스 고정), 5+=낮은 자율(패턴 지정) |
| T11 | **Resource Typing (역량 등급)** | 재난대응 ICS | M | 4 | O | P1 | agent를 역량 등급으로 분류: Type 1(최고 역량, opus+전체 tools) → Type 4(기본 역량, sonnet+제한 tools). task의 요구 등급과 agent 등급을 매칭. 기존 Task complexity signals(C2)가 task 측 분류라면, 이것은 **agent 측 역량 등급화**. compose-team이 `agent_type_level: 1-4` 설정 |
| T12 | **Staging Area (대기 풀)** | 재난대응 ICS | M | 4 | O | P1 | 즉시 투입하지 않는 agent를 대기 풀에 배치. 현장(active) 과밀 방지 + 필요 시 즉시 투입. 기존 Response Threshold(D4, 조건부 추가 spawn)와 달리 **spawn은 미리 하되 활성화를 지연**. compose-team이 `staging: true` agent 정의 → idle 상태로 대기, sprint-leader가 필요 시 activate |

### 2. 오케스트레이션 패턴 선택

| ID | 패턴 | 출처 | 난이도 | 효과 | CC | 우선순위 | compose-team 구체 적용 |
|----|------|------|--------|------|-----|---------|----------------------|
| O1 | **5 패턴 선택** | bkit | M | 5 | O | P0 | Leader/Council/Swarm/Pipeline/Watchdog. PDCA phase별 매핑. compose-team이 task 특성에 따라 자동 선택 |
| O2 | **Stage Agent Routing Table** | OMC | M | 4 | O | P1 | stage별 required/optional agent 매트릭스. phase 정의에 포함 |
| O3 | **Task Decomposer** | AO | M | 4 | △ | P1 | LLM이 `atomic` vs `composite` 분류 → 재귀 분해 → leaf에만 agent 할당 |
| O4 | **Decision Principles** | gstack | H | 4 | O | P1 | 6가지 원칙 + Mechanical/Taste 분류 + Phase별 tiebreaker |
| O5 | **DAG 의존성 분석** | ClawTeam, sim-studio | M | 4 | △ | P2 | `blocked_by` + DFS cycle detection + 완료 시 auto-unblock |
| O6 | **Crews + Flows 이중 레이어** | CrewAI | H | 3 | △ | P2 | 자율(Crew) + 결정론적(Flow) 분리 조합. 조건부 분기 |
| O7 | **Dynamic Task Ledger** | MS Agent Framework | M | 4 | O | P1 | 고정 plan 아닌 실시간 진화 작업 원장. phase 결과에 따라 계획 수정 |
| O8 | **Dual-Loop Ledger** | AutoGen MagenticOne | M | 4 | O | P1 | Task Ledger(facts/guesses/plan) + Progress Ledger(self-reflection). 정체 → 계획 재작성 |
| O9 | **OODA iterative** | Boyd (군사 C2) | M | 3 | O | P1 | phase 결과 관찰 → 재Orient → 다음 phase 조정 |
| O10 | **Filter-Score 2단계** | K8s Scheduler | M | 4 | O | P1 | 불가능 조합 제거(Filter) → 적합도 점수(Score). compose-team agent-task 매칭에 적용 |
| O11 | **Utility 함수** | 게임 AI | M | 3 | △ | P2 | 전문성 x 부하 x 의존성 다차원 점수 → agent-task 매칭 최적화 |
| O12 | **Selector-based Dynamic Speaker** | AutoGen | H | 2 | X | P3 | LLM이 대화 맥락에서 다음 발언자 동적 결정. Claude Code DM 구조에서는 직접 적용 불가 |
| O13 | **Pressure-Field Coordination** | arxiv 2601.08129 | H | 3 | △ | P3 | 역할 없는 gradient 기반 조율. agent가 "pressure"를 emit하면 가까운 agent가 반응. 정적 역할 할당 없이 동적 협력. Claude Code에서는 DM으로 근사 가능하나 근본적으로 다른 패러다임 |
| O14 | **ARG-Designer (GNN 기반 Topology)** | arxiv 2507.18224 | H | 3 | X | P3 | GNN이 task 특성을 분석하여 agent간 최적 통신 topology를 자동 생성. star/ring/mesh 등 구조 자동 결정. Claude Code의 고정 DM 구조에서는 직접 적용 불가하나 topology 선택 로직은 참고 가능 |
| O15 | **Voting vs Consensus 7-Protocol** | multi-agent decision literature | M | 3 | O | P2 | majority voting, weighted voting, Borda count, Condorcet, unanimity, supermajority, liquid delegation 7가지 의사결정 프로토콜. task 유형에 따라 자동 선택. compose-team에 `decision_protocol` 필드 추가 |
| O16 | **Clarke-Wright Savings Merge** | 물류 VRP | M | 4 | O | P1 | 초기에 모든 task를 개별 agent 1:1 할당(최대 분해) → 병합 시 "절약량" 계산 → 절약량 높은 순으로 task 쌍을 같은 agent에 병합. 결과: 최적에 근사한 agent-task 매칭. 기존 Task Decomposer(O3, 분해만)의 **역방향 — 분해 후 최적 재병합** |
| O17 | **Capacity Constraint** | 물류 VRP | S | 4 | O | P0 | agent에 "용량 제한" 명시: context window 잔여량, 동시 파일 수, 예상 토큰. 용량 초과 task 배정 방지. 기존 팀 캡(T1, 전체 수 제한)과 달리 **개별 agent의 처리 용량 제한** |
| O18 | **Time Window Constraint** | 물류 VRP | M | 3 | O | P2 | task에 "처리 가능 시간대" 부여. 선행 task 완료 전에는 배정 불가, deadline 후에는 의미 없음. compose-team이 `earliest_start`/`deadline` 필드 생성. 기존 DAG blocked_by(O5, 완료 여부만)에 **시간 차원 추가** |
| O19 | **Split Delivery** | 물류 VRP | M | 3 | O | P2 | 대형 task를 여러 agent가 분담 가능. 1 task가 반드시 1 agent일 필요 없음 — 파일 단위로 분할하여 2-3 agent가 공동 수행. 기존 "1 task = 1 agent"(T4)의 예외 조건을 명시적으로 정의 |
| O20 | **Ontology Auto-Classification** | deepagentsjs | M | 4 | O | P1 | task의 키워드/구조를 분석하여 사전 정의 ontology(카테고리 트리)에 자동 매핑 → 적합 agent 자동 라우팅. 기존 Determinant Code(D13, 증상→코드 테이블)와 유사하나 **계층적 ontology 기반**으로 더 세밀한 분류. compose-team이 task 입력 시 자동 분류 → agent 추천 |
| O21 | **Typed Relation Detection** | deepagentsjs | M | 3 | O | P1 | task간 dependency를 자동 탐지: `DEPENDS_ON`, `CONFLICTS_WITH`, `EXTENDS`, `REPLACES` 등 타입별 관계. 기존 DAG(O5, blocked_by만)와 conflicts_with(F2, 충돌만)를 **통합 관계 타입 시스템**으로 확장 |
| O22 | **Intent Prediction + Repeat Detection** | memory-bank | M | 3 | O | P2 | 유저 요청 패턴을 분석하여 다음 요청 예측 + 이전에 동일/유사 요청이 있었는지 탐지. 반복 요청 시 이전 결과를 재활용 제안. compose-team이 "이 요청은 지난 세션의 X와 유사합니다" 알림 |
| O23 | **ConfigurableAgentTool (Agent=Tool 등가)** | browser-operator | M | 5 | O | P0 | agent를 Tool 인터페이스로 등록 — handoff가 특별한 프로토콜이 아니라 자연스러운 tool call. `agent.asTool({name, description, parameters})` 패턴. compose-team이 agent를 다른 agent의 tool로 등록 가능하게 정의. 기존 SocietyOfMind(H4, GroupChat 캡슐화)와 달리 **단일 agent를 단일 tool로 1:1 매핑** — 호출 인터페이스가 tool call과 동일하므로 기존 tool 사용 패턴 그대로 적용 |
| O24 | **선언적 Handoff** | browser-operator | M | 4 | O | P0 | handoff 조건을 선언적으로 정의: `{trigger: 'llm_tool_call' | 'max_iterations' | 'condition', includeToolResults: boolean}`. 기존 Signal-Driven Branching(H6, 이벤트 기반)은 런타임 시그널 — 이것은 **compose-team 시점에서 handoff 조건을 미리 선언**. tool 결과 필터링(`includeToolResults`)으로 다음 agent에 불필요한 context 차단 |
| O25 | **AgentSession 트리** | browser-operator | M | 4 | O | P1 | 재귀적 nestedSessions 구조 — agent가 sub-agent를 spawn하면 parent→child 트리가 자동 형성. per-session metrics(토큰, 시간, 상태) 자동 추적. 기존 SocietyOfMind(H4, 재귀 계층)의 **Claude Code 구현 가능 버전** — Session Lead → sprint-leader → worker 트리를 자동 추적하여 전체 팀 상태 시각화 |
| O26 | **Operational Period (고정 주기 재계획)** | 재난대응 ICS | M | 4 | O | P1 | 12-24시간 고정 주기로 전체 재계획. 기존 OODA(O9, 결과 기반 조정)는 이벤트 기반 — 이것은 **시간 기반 강제 재계획**. 현재 phase 진행 상황과 무관하게 N분마다 sprint-leader가 전체 상황 재평가 + 계획 조정. CronCreate로 "30분마다 전체 상태 점검" 구현. compose-team에 `replan_interval_min: 30` |
| O27 | **All-Day Aggregation (동일 유형 집계)** | 주방 Brigade | S | 3 | O | P1 | 동일 유형의 task를 집계하여 한 agent에게 일괄 배정. "API 테스트 3건 + 단위 테스트 2건" → 테스트 agent에게 5건 일괄. 기존 Clarke-Wright(O16, 절약량 기반 병합)의 **유형 기반 단순 집계 버전** — 복잡한 계산 없이 같은 카테고리를 모으는 것만으로 충분한 경우 |
| O28 | **Field-Presence Operation Derivation** | openmetadata | M | 4 | O | P1 | task/요청의 속성 존재 여부에서 operation을 자동 도출. `{name: "X", files: [...]}` → CREATE, `{id: "existing", files: [...]}` → UPDATE, `{id: "existing"}` (files 없음) → READ. compose-team이 유저 요청의 필드 패턴에서 **필요한 operation 유형을 자동 추론** — "파일 목록 있으면 구현, 없으면 조사" |
| O29 | **Custom Properties with Schema Validation** | openmetadata | M | 3 | O | P2 | compose-team JSON에 프로젝트별 커스텀 속성 추가 가능 + JSON Schema로 자동 검증. `{custom: {risk_level: "high", compliance: true}}` — 프로젝트 고유 메타데이터를 표준화된 방식으로 확장 |
| O30 | **Foreground Task vs Background Delegate 이분법** | grok-cli | S | 4 | O | P0 | 모든 task를 Foreground(결과 대기 필수, 다음 작업이 의존) vs Background(결과 없이 진행 가능, 비동기 완료)로 명확 분류. compose-team이 task별 `execution_mode: "foreground" | "background"` 자동 설정. 기존 CLAUDE.md의 "background-first agent dispatch" 규칙을 **task 단위로 구조화** |

### 3. Agent 라이프사이클

| ID | 패턴 | 출처 | 난이도 | 효과 | CC | 우선순위 | compose-team 구체 적용 |
|----|------|------|--------|------|-----|---------|----------------------|
| L1 | **3-tier lifecycle** | openclaw, best-practice | S | 5 | O | P0 | permanent/reusable/ephemeral 분류. ephemeral은 파일 미생성, inline prompt만 |
| L2 | **Fuzzy matching 재사용** | ECC team-builder | M | 5 | O | P0 | 기존 template과 역할 유사도 비교 → 일치 시 기존 template 재사용 |
| L3 | **agent-registry.json** | openclaw | S | 3 | O | P1 | `{id, category, name, role, path}` 구조화 인덱스 |
| L4 | **maxTurns 산정** | best-practice | S | 3 | O | P1 | one-shot=3, 장기=30, command-orchestrated=생략. frontmatter에 명시 |
| L5 | **Stocktake verdict** | ECC | M | 4 | O | P1 | Quick Scan(변경분만)/Full(전체) → Keep/Improve/Update/Retire/Merge 판정 |
| L6 | **Skill Health** | ECC | M | 3 | O | P2 | success_rate_7d/30d, failure_trend(worsening/improving/stable) |
| L7 | **Self-Evolution** | best-practice | M | 3 | O | P2 | 작업 후 자기 .md + skill 업데이트 (`## Learnings` 누적) |
| L8 | **Evolution Pipeline** | ECC | H | 4 | O | P2 | instinct clustering → 2+=Skill, 반복워크플로=Command, 복잡멀티스텝=Agent |
| L9 | **Teachable Agent** | AutoGen AG2 | H | 2 | △ | P3 | 유저가 가르친 facts/skills 벡터DB 저장. Claude Code에서는 agent-memory로 근사 |
| L10 | **Satisficing** | 인지과학 | S | 3 | O | P1 | "충분히 좋은" 첫 번째 채택. 과도한 최적화 방지 규칙 |
| L11 | **General-Purpose Auto Subagent** | deepagentsjs | S | 4 | O | P0 | 모든 팀에 "default agent" 1개 자동 포함 — 잔여/미분류 task를 자동 처리. 명시적 agent 배정이 없는 task가 방치되는 문제 해결. compose-team JSON에 `"default_agent": true` 플래그. 기존 Work Stealing(D2, idle agent가 가져감)과 달리 **처음부터 잔여 task 전담자 지정** |
| L12 | **CompiledSubAgent 재사용** | deepagentsjs | M | 5 | O | P0 | 이전 팀의 sub-unit(agent+task+context 조합)을 통째로 재활용. "지난 세션에서 API 테스트를 잘 수행한 agent 구성"을 그대로 재spawn. 기존 Fuzzy matching(L2, template 재사용)을 넘어 **agent+task+context 번들 통째 재사용** |
| L13 | **4-Phase Lifecycle: Spawn→Run→Return→Reconcile** | deepagentsjs | M | 5 | O | P0 | 기존 3-tier(L1)에 **Reconcile(결과 통합) phase를 명시적으로 추가**. agent가 Return(결과 반환)한 뒤 sprint-leader가 Reconcile(다른 agent 결과와 통합, 충돌 해소, 최종 산출물 조립)하는 단계. 기존에는 Return 후 암묵적으로 통합 — 이것은 **통합을 1급 시민(first-class phase)**으로 승격 |
| L14 | **Blueprint Lifecycle (plan→apply→rollback)** | NemoClaw | M | 4 | O | P1 | agent 작업을 3단계로 명시적 구분: (1) plan — 변경 계획을 .md로 작성, (2) apply — 승인 후 실행, (3) rollback — 실패 시 plan 기반 역방향 실행. 기존 Plan-then-execute(U4)를 **rollback까지 확장한 완전한 lifecycle** |
| L15 | **Declarative Capability Selection (toggle on/off)** | theia | S | 4 | O | P0 | agent의 capability(tool, skill)를 선언적으로 toggle on/off. compose-team이 agent별 `capabilities: {read: true, write: false, bash: true}` 정의. 기존 Execution Governance(E14, allowed_tools)를 **toggle 형태로 단순화** — UI에서도 체크박스로 제어 가능 |
| L16 | **Agent Enable/Disable (persist)** | theia | S | 3 | O | P1 | agent를 삭제하지 않고 비활성화(disable) 상태로 전환. 설정 유지한 채 일시 중지. 기존 Anti-Resurrection(E15, 삭제 후 재생성 차단)과 달리 **삭제 없이 on/off**. compose-team이 `enabled: false` 설정 시 spawn 스킵 |
| L17 | **Provider-based Tool Bulk Registration** | theia | M | 3 | O | P1 | tool provider가 관련 tool 묶음을 일괄 등록/해제. "testing-provider"가 {jest, vitest, coverage} 3개 tool을 한번에 등록. 기존 개별 tool 등록 대신 **provider 단위 bulk 관리**. compose-team이 agent에 `tool_providers: ["testing", "linting"]` 지정 |
| L18 | **Agent Delegation as Capability** | theia | M | 4 | O | P1 | agent가 다른 agent에게 위임하는 행위 자체를 capability로 정의. "이 agent는 review를 다른 agent에게 위임할 수 있음"을 선언적으로 표현. 기존 Agent=Tool(O23, 호출)과 달리 **위임 가능 여부 자체를 권한으로 관리** |
| L19 | **FS Watcher Skill Reload** | theia | M | 3 | O | P1 | 파일 시스템 변경 감시 → skill 파일 수정 시 자동 reload. 이미 우리 시스템에 hot-reload가 있으나, theia의 구현은 **debounce + validation + graceful fallback** 포함 — 잘못된 skill 파일이 시스템을 깨뜨리지 않도록 |
| L20 | **Skill 동적 등록** | browser-use | M | 3 | O | P1 | 런타임 중 새로운 skill을 agent에게 동적으로 추가/제거. agent 재spawn 없이 capability 확장. compose-team이 `dynamic_skills: true` 설정 시 sprint-leader가 runtime 중 worker에게 skill 추가 가능 |
| L21 | **BuiltinSubagentId + Custom Agent 이중 체계** | grok-cli | S | 4 | O | P1 | builtin agent(시스템 제공, 수정 불가) + custom agent(유저 정의, 완전 제어) 이중 체계. compose-team이 builtin에서 적합 agent를 먼저 검색 → 없으면 custom 생성 제안. 기존 Fuzzy matching(L2)이 template 재사용이라면, 이것은 **builtin/custom 네임스페이스 분리** |
| L22 | **Background Delegation via Detached Process** | grok-cli | M | 3 | O | P2 | background task를 OS 레벨 detached process로 실행하여 부모 agent 종료 후에도 계속 실행. Claude Code에서는 `run_in_background: true`로 이미 지원하나, grok-cli의 구현은 **프로세스 완전 격리(stdout/stderr 파일 리디렉션, PID 추적)** 추가 |

### 4. 모델 선택 & 비용

| ID | 패턴 | 출처 | 난이도 | 효과 | CC | 우선순위 | compose-team 구체 적용 |
|----|------|------|--------|------|-----|---------|----------------------|
| C1 | **3-Tier Model Routing** | OMC | S | 4 | O | P0 | LOW(haiku)/MED(sonnet)/HIGH(opus) + task 유형별 매핑 |
| C2 | **Task complexity signals** | superpowers | S | 4 | O | P0 | 1-2파일+완전스펙=cheap, multi-file=standard, 설계판단=capable |
| C3 | **Effort Compression** | gstack | S | 3 | O | P1 | 모든 스킬에 human/AI 양쪽 시간 표시 테이블 |
| C4 | **Cost mode downgrade** | OMC | S | 3 | O | P1 | cost mode 시 opus→sonnet, sonnet→haiku (verify는 최소 sonnet) |
| C5 | **Agent frontmatter 패턴** | ECC, best-practice | S | 3 | O | P1 | opus=전략/설계(4개), sonnet=실행/리뷰(24개), Read-only vs Full tools 구분 |
| C6 | **Risk-Signal Routing** | myclaude | M | 3 | O | P2 | task 위험도별 AI 백엔드 자동 전환 |
| C7 | **Bin Packing vs Spreading** | K8s | S | 2 | O | P2 | 비용 절감(최소 agent) vs 속도(최대 병렬) 전략 선택 옵션 |
| C8 | **BATS (Budget-Aware Tool-use Strategy)** | arxiv 2511.17006 | M | 5 | O | P0 | 예산 인지 전략 전환. 남은 토큰 예산에 따라 tool 사용 빈도와 모델 tier를 동적 조정. 예산 50% 소진 시 sonnet→haiku 전환, 80% 소진 시 tool 호출 최소화. compose-team 출력에 `budget_strategy` 필드 추가 |
| C9 | **Cache-Aware Prompt Design** | arxiv 2601.06007 | M | 4 | O | P1 | "Don't break the cache" — 프롬프트의 앞부분(시스템+규칙)을 불변으로 유지하고 뒷부분(task)만 변경하여 KV cache hit율 극대화. agent template 설계 시 cache-friendly 구조 권장 |
| C10 | **Lazy Skill Loading 3-Phase** | pioneer R2 research | M | 5 | O | P0 | Phase 1: 스킬 이름+1줄 설명만 로드(97% 토큰 절약). Phase 2: 선택된 스킬만 전체 로드. Phase 3: 실행. compose-team이 agent에게 전체 스킬 목록 대신 요약만 전달 |
| C11 | **Per-Agent Cost Accounting** | pioneer R2 research | M | 3 | O | P2 | agent별 토큰 소비량 추적 + 팀 전체 비용 대시보드. 비용 이상치 agent 자동 감지 |
| C12 | **Background Augmentation Queue** | Memori | M | 3 | O | P2 | 비동기 batch pipeline — agent 실행 중 발생하는 부가 작업(메모리 정리, context 요약, 패턴 분석)을 백그라운드 큐에 적재하여 메인 agent 중단 없이 처리. 기존 Observational Memory(X10, 비동기 압축)와 유사하나 **범용 큐 시스템으로 확장** |
| C13 | **LLM Client Interceptor** | NemoClaw | H | 3 | △ | P3 | LLM 호출을 투명하게 가로채서 (1) 자동 학습 데이터 수집, (2) 응답 캐싱, (3) 비용 추적. agent 코드 수정 없이 인프라 레벨에서 작동. Claude Code에서는 hook으로 부분 구현 가능 |
| C14 | **Inference Gateway Routing** | NemoClaw | M | 3 | △ | P2 | 단일 gateway가 task 특성에 따라 다른 LLM 백엔드로 라우팅. Claude Code에서는 모델 tier(opus/sonnet)를 frontmatter로 결정하므로 **compose-team이 agent별 model 필드를 자동 설정하는 것으로 구현** |
| C15 | **LLM-as-Judge 2단계 필터링** | claude-memory | M | 4 | O | P1 | 대량 후보를 저비용 모델(Haiku)로 사전 필터(3초 timeout, graceful degradation) → 통과 항목만 고비용 모델로 정밀 평가. compose-team에서 대량 agent 후보를 빠르게 1차 필터링할 때 적용. 기존 Filter-Score(O10, 규칙 기반)를 **LLM 기반 2단계**로 확장 |
| C16 | **Token Economics 시각화** | claude-mem | S | 3 | O | P1 | discovery_tokens(검색/탐색에 소비) vs read_tokens(실제 작업에 소비) 비율을 추적하여 ROI 시각화. "전체 토큰의 40%가 검색에만 쓰임" 같은 인사이트 → context 전략 최적화. compose-team 출력에 `expected_token_distribution` 표시 |
| C17 | **3-Tier Model Fallback Chain** | browser-operator | M | 4 | O | P1 | Main(opus)/Mini(sonnet)/Nano(haiku) 3단계 + 자동 fallback chain: Main 실패/timeout → Mini → Nano. 기존 3-Tier Routing(C1, 사전 결정)과 달리 **런타임 fallback** — 실패 시 자동 하위 tier로 전환. compose-team이 agent별 `model_chain: ["opus", "sonnet"]` 정의 |

### 5. 실패 처리 & 에스컬레이션

| ID | 패턴 | 출처 | 난이도 | 효과 | CC | 우선순위 | compose-team 구체 적용 |
|----|------|------|--------|------|-----|---------|----------------------|
| E1 | **4-status escalation** | superpowers | S | 5 | O | P0 | DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED + 4단계 ladder |
| E2 | **Reaction System** | AO | M | 3 | △ | P2 | 30초 폴링 + 5단계 status + retries + escalateAfter. Claude Code에서는 SendMessage 기반 |
| E3 | **Verify-fix loop** | OMC | M | 4 | O | P1 | team-exec→team-verify→team-fix, max_fix_loops=3, 초과→failed |
| E4 | **Bounded retry** | ClawTeam | S | 3 | O | P1 | task 완료 시 auto-unblock, stale lock 자동 해제 |
| E5 | **LoopDetection** | deer-flow | M | 4 | O | P1 | 해시 슬라이딩 윈도우(20개), 3회 경고, 5회 강제 중단 |
| E6 | **Verification gate** | superpowers | S | 5 | O | P0 | NO COMPLETION WITHOUT FRESH EVIDENCE (identify→run→read→verify→claim) |
| E7 | **Adaptive Harshness** | OMC | M | 3 | O | P2 | THOROUGH → ADVERSARIAL 에스컬레이션 (CRITICAL 발견 시) |
| E8 | **Task Guardrail + Retry** | CrewAI | M | 3 | △ | P2 | function/LLM 출력 검증 + guardrail_max_retries |
| E9 | **Completion Scoring + Bail** | Mastra | M | 4 | O | P1 | task 완료도 0-1 스코어링. threshold 미달→재시도, 수렴 실패→bail 강제 중단 |
| E10 | **Graded Assertiveness (PACE)** | 수술팀 | M | 4 | O | P1 | Probe→Alert→Challenge→Emergency. worker가 sprint-leader에게 이의제기하는 4단계 경로 |
| E11 | **Automated Rollback Trigger** | 릴리스 엔지니어링 | M | 3 | O | P2 | 사전 기준 위반 시 sprint-leader 판단 없이 자동 git reset 후 재설계 |
| E12 | **Circuit Breaker + Backpressure** | 분산 시스템 패턴 | M | 4 | O | P1 | agent가 연속 실패 시 Circuit Breaker가 open → 일정 시간 요청 차단 → half-open 시 probe 1회 → 성공 시 close. Backpressure: 하류 agent 처리 속도에 맞춰 상류 spawn 속도 조절. compose-team에 `circuit_breaker: {threshold: 3, cooldown: 60s}` |
| E13 | **Saga Compensation Chain** | Temporal + Saga 패턴 | H | 4 | O | P1 | 다단계 agent 작업에 트랜잭션 보장. 각 step에 compensating action(undo) 정의. step 3 실패 시 step 2→1 역순 보상 실행(git revert 등). compose-team이 phase별 `compensating_action` 명시. **Choreography**(agent 자율 보상) vs **Orchestration**(sprint-leader 지시 보상) 2가지 구현 모드 |
| E14 | **Execution Governance** | pioneer R2 research | M | 4 | O | P1 | 행동 수준 정책 집행. agent가 실행할 수 있는 tool/action의 화이트리스트를 task 단위로 제한. "이 agent는 Read+Grep만, Write 불가" 같은 세분화된 권한. compose-team의 agent 정의에 `allowed_tools` 필드 |
| E15 | **Anti-Resurrection Window** | claude-memory | S | 4 | O | P0 | 삭제된 agent/task/memory의 24시간 재생성 차단. "삭제→즉시 재생성" 루프 방지. 삭제 시 `{id, deleted_at, window_expires}` 기록 → window 내 동일 항목 생성 시 거부. 기존 LoopDetection(E5, 반복 행동)과 달리 **삭제-재생성 특화 방지** |
| E16 | **5중 Re-fire Prevention Guard** | claude-memory | M | 4 | O | P1 | 동일 작업의 중복 실행을 5단계로 방지: (1) idempotency key, (2) in-flight 체크, (3) 결과 캐시, (4) cooldown timer, (5) max retry cap. 각 레이어가 독립적으로 작동하여 단일 장애 지점 없음. compose-team이 중요 phase에 `refire_guard: true` 설정 |
| E17 | **PinnedStagingDir TOCTOU 방지** | claude-memory | M | 3 | O | P2 | Time-of-Check-to-Time-of-Use 경합 방지. agent가 파일 상태를 확인한 시점과 실제 수정하는 시점 사이에 다른 agent가 변경하는 문제를 staging directory pin으로 해결. worktree 격리(I1)와 조합하여 파일 수준 원자성 보장 |
| E18 | **Session Queue Atomic Claim-Confirm** | claude-mem | M | 3 | O | P2 | task 큐에서 agent가 task를 가져갈 때 2단계 원자적 프로토콜: (1) Claim(예약) → (2) Confirm(확정). Claim 후 일정 시간 내 Confirm 없으면 자동 해제(stale self-heal). 기존 Bounded retry(E4, stale lock 해제)를 **큐 수준에서 구조화** |
| E19 | **Action Loop Detector** | browser-use | M | 4 | O | P1 | agent의 반복 행동을 자동 감지 + nudge(방향 전환 힌트). 기존 LoopDetection(E5, 해시 윈도우)이 경고→강제중단이라면, 이것은 **감지 후 부드러운 방향 전환 유도**. "같은 파일을 3회 수정 중입니다. 다른 접근을 시도해보세요" 같은 nudge 메시지 |
| E20 | **Replan-on-Stall** | browser-use | M | 4 | O | P1 | 연속 N회 실패 시 자동으로 전체 plan을 재작성. 기존 Dual-Loop Ledger(O8, 정체→계획 재작성)와 유사하나 **trigger가 연속 실패 카운트로 자동화**. compose-team이 `stall_threshold: 3` 설정 → 3회 연속 실패 시 sprint-leader가 자동 replan |
| E21 | **Budget Warning (75% 소진 경고)** | browser-use | S | 4 | O | P0 | 토큰 예산의 75% 소진 시 자동 경고 → 전략 전환. 기존 BATS(C8, 동적 조정)가 점진적이라면, 이것은 **명확한 threshold에서 1회성 경고**. compose-team이 `budget_warning_threshold: 0.75` 설정 |
| E22 | **Fallback LLM** | browser-use | M | 3 | O | P1 | 기존 3-Tier Fallback Chain(C17)과 유사하나 browser-use의 구현이 더 구체적: primary 실패 시 (1) 같은 모델 재시도, (2) fallback 모델, (3) 최소 기능 모드(tool 없이 텍스트만). 3단계 degradation |
| E23 | **Reaction Pause/Resume** | anytype | S | 3 | O | P1 | 시스템 과부하 시 agent의 반응(이벤트 처리)을 일시 정지 → 부하 해소 후 재개. 기존 Circuit Breaker(E12, open/close)와 달리 **점진적 — 완전 차단이 아닌 일시 정지** |
| E24 | **Stale Context Auto-Discard** | cross-agent | S | 3 | O | P1 | agent crash 후 복구 시 stale(오래된/손상된) context를 자동 폐기하고 fresh start. 기존 Continue-As-New(H7, 의도적 이관)와 달리 **crash 복구에 특화 — 손상 가능성 있는 context를 보존하지 않고 깨끗하게 재시작** |

### 6. 컨텍스트 관리

| ID | 패턴 | 출처 | 난이도 | 효과 | CC | 우선순위 | compose-team 구체 적용 |
|----|------|------|--------|------|-----|---------|----------------------|
| X1 | **Context budget 계산** | context-mode, deer-flow | M | 5 | O | P0 | agent수 x 예상토큰 = window 사용률. compose-team 출력에 예상 비용 표시 |
| X2 | **Progressive context** | context-mode, deer-flow | M | 4 | O | P1 | initial_reads / deferred_reads / summary_only 분리 |
| X3 | **Handoff file** | stdy-context-tips | S | 4 | O | P1 | phase간 `.tmp/phase-N-summary.md` 경로+포맷 명시 |
| X4 | **session_knowledge XML** | context-mode | M | 3 | △ | P2 | 13개 카테고리 priority tier별 budget (<2KB). hook으로 구현 |
| X5 | **TodoMiddleware 복구** | deer-flow | M | 3 | O | P1 | compaction 후 사라진 write_todos를 system_reminder로 재주입 |
| X6 | **Memory confidence 정렬** | deer-flow | M | 2 | O | P2 | `format_memory_for_injection(max_tokens=2000)` confidence 내림차순 |
| X7 | **FTS5 3-tier search** | context-mode | H | 3 | X | P3 | Porter stemmer → Trigram → Fuzzy(Levenshtein). SQLite 필요 |
| X8 | **Cross-agent context** | ClawTeam | M | 4 | O | P1 | file overlap + upstream diff 자동 주입 |
| X9 | **Sibling awareness** | AO | S | 3 | O | P1 | 병렬 worker에게 형제 task 목록 context 주입 |
| X10 | **Observational Memory** | Mastra | H | 3 | △ | P3 | 백그라운드 Observer agent가 대화 비동기 압축 (3-40x) |
| X11 | **Memory Isolation by Default** | Mastra | S | 3 | O | P1 | subagent working memory 자동 격리. 명시적 공유 필요 시만 설정 |
| X12 | **Namespace-scoped Store** | LangGraph | H | 2 | X | P3 | 계층적 namespace + cross-thread semantic search |
| X13 | **Strip Encoding** | 항공 관제 | M | 4 | O | P1 | handoff 메시지를 `{status}/{files_touched}/{blockers}/{next_action}` 필드 고정 약어로 표준화 |
| X14 | **Hierarchical Blackboard** | 게임 AI (RTS) | M | 3 | △ | P2 | 계층별 context 분리 (strategic/tactical/reactive) |
| X15 | **Collaborative Memory Access Control** | arxiv 2505.18279 | M | 3 | △ | P2 | multi-agent 환경에서 memory에 접근 권한 레벨 부여. agent별 read/write/admin 권한 분리. 민감 정보(API key 등)는 특정 agent만 접근 |
| X16 | **Memory as a Service (MaaS)** | arxiv 2506.22815 | H | 2 | X | P3 | contextual memory를 서비스로 분리. agent가 memory API를 호출하여 저장/검색. Claude Code에서는 agent-memory + WM으로 근사 |
| X17 | **Decision Registry (결정 원장)** | Context Preservation 연구 | M | 5 | O | P0 | 팀 실행 중 내려진 모든 설계 결정을 구조화 기록: `{decision_id, context, alternatives_considered, chosen, rationale, timestamp}`. 다음 phase나 다음 세션에서 "왜 이렇게 했지?" 추적 가능. `.tmp/decision-registry.jsonl`에 append-only. 기존 Handoff file(X3, 자유 형식)과 달리 **결정에 특화된 구조화 원장** |
| X18 | **Episodic Snapshot + Resume** | Context Preservation 연구 | M | 4 | O | P1 | agent 종료 시 현재 "에피소드" 전체를 스냅샷: `{task_state, files_modified, decisions_made, open_questions, next_steps}`. 재spawn 시 스냅샷을 prompt에 주입하여 이전 context 자동 복원. 기존 SubagentStop(.tmp/agent-context/ 요약)을 **구조화 + 자동 로드**로 강화 |
| X19 | **State Exclusion List** | deepagentsjs | S | 4 | O | P0 | context 전달 시 "포함할 것"뿐 아니라 **"빼야 할 것"을 명시**. agent에게 불필요한 정보(다른 agent의 내부 상태, 이전 phase 디버깅 로그 등) 제거. compose-team이 agent별 `exclude_context: [...]` 필드 생성. 기존 Progressive context(X2, 포함할 것 분류)의 **역방향 — 제외 목록** |
| X20 | **Fact Consolidation 4-Way** | memory-bank | M | 4 | O | P1 | 여러 agent의 보고를 통합할 때 각 fact를 4가지로 분류: DUPLICATE(중복→병합), CONTRADICTION(모순→해소), EVOLUTION(기존 사실의 업데이트→교체), INDEPENDENT(독립→그대로 추가). sprint-leader의 Reconcile(L13) 단계에서 사용. 기존 4-Tier Conflict Resolution(F3, 코드 충돌)과 달리 **정보/사실의 충돌 해소** |
| X21 | **Session Continuity 자동 주입** | memory-bank | M | 4 | O | P1 | 이전 세션의 결론/미해결 사항을 새 세션 시작 시 자동 주입. SubagentStart hook 확장으로 구현: 동일 이름 agent의 이전 `.tmp/agent-context/` 파일 탐지 → prompt 앞에 삽입. 기존 Episodic Snapshot(X18)을 **자동 로드 메커니즘으로 구현** |
| X22 | **Conversation History Offloading** | memory-bank | M | 3 | O | P2 | 장기 실행 agent의 대화 이력을 주기적으로 요약 + 원본은 파일로 오프로드. context window 압박 완화. 기존 Continue-As-New(H7, 새 instance로 이관)와 유사하나 **대화 이력에 특화된 압축** |
| X23 | **Three-Level Memory Attribution + Singleton Writer** | Memori (재조사 보강) | M | 4 | O | P1 | 메모리를 3레벨로 구분: Entity(공유 fact store, 영구), Process(agent별 격리, 작업 과정), Session(세션 종료 시 폐기). **재조사 추가**: 공유 Entity store에 대한 concurrent write를 semaphore(50) + batch writer queue(1000)로 직렬화하여 race condition 방지. agent-memory 구조에 `attribution_level` 필드 + 공유 store write lock |
| X24 | **Snapshot/Restore (세션 간 마이그레이션)** | NemoClaw | M | 3 | O | P2 | 팀 전체 상태(agent 구성, task 진행률, context)를 하나의 snapshot 파일로 직렬화 → 다른 세션에서 restore하여 이어서 작업. 기존 Episodic Snapshot(X18, agent 단위)을 **팀 단위로 확장** |
| X25 | **FTS5 BM25 인메모리 검색** | claude-memory | M | 4 | O | P1 | Python stdlib sqlite3만으로 FTS5 + BM25 랭킹 구현. 외부 의존 없이 agent-memory/context를 full-text 검색. 기존 FTS5 3-tier(X7, SQLite+Porter)를 **stdlib-only 경량 구현**으로 구체화. hook이나 skill에서 sqlite3 모듈로 바로 사용 가능 |
| X26 | **Progressive Disclosure 3-Layer** | claude-mem | M | 5 | O | P0 | Layer 1: 세션 시작 시 memory **인덱스만** 주입(이름+1줄 설명). Layer 2: 관련 memory만 온디맨드 상세 로드. Layer 3: 필요 시 원본 전체 접근. 기존 Lazy Skill Loading(C10, 스킬 전용)을 **memory/context 전반으로 확장**. 97%+ 토큰 절약 패턴의 일반화 |
| X27 | **Dual-Path Retrieval** | claude-mem | M | 4 | O | P1 | Passive(최근 사용 기반 recency 정렬) + Active(의도적 MCP search) 2경로 검색. 자주 쓰는 context는 자동 상위 노출, 드문 context는 명시적 검색. compose-team이 agent별 `retrieval_mode: "passive"/"active"/"hybrid"` 설정 |
| X28 | **Co-occurrence Sliding Window** | claude-memory | M | 3 | O | P2 | context 항목의 관련성을 co-occurrence(공존 빈도)로 평가. primary 항목 ±4줄 이내에 함께 등장하는 booster 항목을 자동 번들링. 관련 context를 놓치지 않는 "근접 동반자" 검출 |
| X29 | **Hybrid Search (metadata→vector→intersection)** | claude-mem | M | 3 | △ | P2 | 3단계 필터링: (1) metadata filter(파일 유형, 날짜 등 구조적 필터), (2) vector rank(의미적 유사도), (3) intersection(교집합). 정밀도와 재현율 균형. Claude Code에서는 metadata filter + keyword search로 근사 |
| X30 | **Accessibility Tree Pruning** | browser-operator | S | 3 | O | P1 | context에 포함되는 구조 정보(파일 트리, 의존성 그래프 등)를 최근 2개 스냅샷만 유지. 이전 스냅샷은 자동 폐기. 기존 Conversation History Offloading(X22, 대화 이력 압축)과 유사하나 **구조 데이터에 특화** — WM의 file-map 이력 관리에 적용 |
| X31 | **Memory Block 시스템** | browser-operator | M | 3 | O | P1 | context를 3종 block으로 구조화: system(불변), tool_results(가변, 최신 N개만), conversation(압축 대상). 각 block에 20000자 한도. compose-team이 agent별 block 할당량 정의. 기존 session_knowledge XML(X4, 카테고리별 budget)의 **block 기반 구현** |
| X32 | **Tool Result Sanitization** | browser-operator | S | 3 | O | P1 | tool 결과를 다음 agent에게 전달하기 전에 자동 정제: 불필요한 메타데이터 제거, 민감 정보 마스킹, 크기 제한. 기존 State Exclusion List(X19, 제외 목록)와 Privacy Control(I11, 비공개 태그)을 **tool 결과 레벨에서 자동 적용** |
| X33 | **Message Compaction (Live 압축)** | browser-use | M | 4 | O | P1 | agent 실행 중(종료 전) 대화 이력을 실시간 압축. 기존 Conversation History Offloading(X22, 주기적 오프로드)과 달리 **매 N턴마다 이전 턴을 live 요약으로 교체**. context window 내에서 항상 최신 N턴 원본 + 나머지 요약 유지 |
| X34 | **Sensitive Data Scoping** | browser-use | S | 3 | O | P1 | 민감 데이터(API key, 비밀번호, 개인정보)의 범위를 task 단위로 제한. task 완료 시 자동 폐기. 기존 Privacy Control(I11, `<private>` 태그)을 **자동 범위 관리로 확장** — 수동 태깅 불필요 |
| X35 | **Variable Detection from History** | browser-use | M | 3 | O | P2 | 대화 이력에서 반복 사용되는 변수(파일 경로, 모듈 이름, 설정 값)를 자동 감지 → 변수로 추출하여 context 압축. "src/api/users.ts를 5회 언급" → `$TARGET_FILE`로 치환 |
| X36 | **Selective State Propagation** | deepagentsjs (재조사) | M | 5 | O | P0 | `EXCLUDED_STATE_KEYS`로 "무엇을 공유하고 무엇을 격리할지" state key 단위로 선언. memory → 격리(agent 고유), files → 전파(공유). 기존 State Exclusion List(X19, 제외 목록)를 **key 단위 세밀한 propagation 정책으로 구체화**. compose-team이 agent별 `propagate: ["files", "decisions"], isolate: ["memory", "scratch"]` 정의 |
| X37 | **Path-Based Shared Storage** | deepagentsjs (재조사) | M | 4 | O | P1 | 경로 prefix로 데이터 visibility 자동 제어: `/memories/` → persistent cross-thread(모든 agent 접근), `/scratch/` → ephemeral(해당 agent만). 기존 CompositeBackend(I8, 저장소 라우팅)를 **visibility 레벨과 결합**. compose-team이 `shared_paths: ["/memories/", "/decisions/"], private_paths: ["/scratch/"]` 정의 |
| X38 | **Structured Context Compaction** | grok-cli | S | 4 | O | P0 | context 압축 시 자유 형식이 아닌 **Goal/Progress/Decisions/NextSteps 4필드 강제**. 기존 SBAR(K1, 보고용 4필드)를 **context 압축용으로 전용화**. compaction 후에도 핵심 정보 구조가 보존됨. compose-team이 handoff/phase 전환 시 이 포맷으로 context 전달 |

### 7. UX & 사용자 인터랙션

| ID | 패턴 | 출처 | 난이도 | 효과 | CC | 우선순위 | compose-team 구체 적용 |
|----|------|------|--------|------|-----|---------|----------------------|
| U1 | **Clarification-first** | deer-flow, cc-wf-studio | M | 5 | O | P0 | 모호하면 5가지 유형(missing_info 등)으로 분류 → 질문 후 진행 |
| U2 | **Interactive checkpoints** | bkit | S | 4 | O | P0 | 5개 CP, -71% rework, 절대 스킵 금지 |
| U3 | **Human-readable summary** | cc-wf-studio | S | 4 | O | P0 | JSON 전에 텍스트/Mermaid 시각화 |
| U4 | **Plan-then-execute** | cc-wf-studio | S | 4 | O | P0 | .md 파일 "계획"만 → 검증 → 승인 → 디스크 기록 |
| U5 | **Mechanical vs Taste** | gstack | M | 3 | O | P1 | 자동 결정 가능=조용히, 판단 필요=최종 게이트에 노출 |
| U6 | **guidanceOnce** | context-mode | S | 2 | O | P2 | 세션당 1회 가이던스 (atomic file lock) |
| U7 | **Effort display** | gstack | S | 3 | O | P1 | AskUserQuestion에서 항상 human/AI 양쪽 시간 표시 |
| U8 | **Score Annotation 이중 체계** | 오케스트라 | M | 3 | O | P1 | compose-team JSON에 `rationale`(왜) + `execution_notes`(어떻게) 분리 |
| U9 | **IDE-as-MCP-Server (역방향 tool 제공)** | spacecake | H | 4 | △ | P2 | 앱(IDE)이 Claude Code에게 tool을 제공하는 역방향 패턴. 기존은 Claude Code가 tool을 호출 — 이것은 **외부 앱이 MCP server가 되어 Claude Code에 tool을 노출**. compose-team이 "이 task에는 IDE의 X tool이 필요" 선언 가능. EG-Desk의 MCP 통합에 직접 관련 |
| U10 | **Live Task Panel** | spacecake | M | 3 | △ | P2 | fs.watch + IPC + Jotai로 실시간 task 진행 상황 UI 패널. agent 작업 진행률을 실시간 시각화. compose-team의 출력을 UI 패널과 연동하는 패턴 |
| U11 | **Statusline Surface Multiplexing** | spacecake | M | 3 | △ | P2 | surfaceId 기반 멀티세션 모니터링 — 여러 agent의 상태를 하나의 status line에 다중 표시. per-agent 상태를 surfaceId로 분리하여 동시 추적 |
| U12 | **3-Tier Connection Status Badge** | spacecake | S | 2 | △ | P2 | agent 연결 상태를 3단계(connected/degraded/disconnected)로 시각화. 팀 운영 시 어떤 agent가 응답 불능인지 즉시 파악 |
| U13 | **Agent Studio (런타임 UI 기반 agent 생성)** | browser-operator | H | 3 | △ | P3 | UI에서 drag-and-drop으로 agent를 생성/구성/연결. compose-team의 JSON 출력을 시각적 에디터로 표현. cc-wf-studio(12)의 agent 특화 버전 |

### 8. 팀 템플릿 & 재사용

| ID | 패턴 | 출처 | 난이도 | 효과 | CC | 우선순위 | compose-team 구체 적용 |
|----|------|------|--------|------|-----|---------|----------------------|
| R1 | **TOML 팀 템플릿** | ClawTeam | M | 4 | △ | P1 | leader + agents + tasks 선언적 정의. Claude Code에서는 JSON 포맷 유지 |
| R2 | **Team archetype** | ClawTeam | M | 5 | O | P0 | hedge-fund, software-dev, research-paper 등 프리셋. compose-team이 자동 매칭 |
| R3 | **Command-Agent-Skill 3-tier** | best-practice | M | 4 | O | P1 | Command가 오케스트레이션, Agent는 극도로 간결(14-16줄) |
| R4 | **Prompt Builder 4-layer** | AO | M | 3 | △ | P2 | Base(시스템)→Config(프로젝트)→Rules(사용자)→Decomposition(task) |
| R5 | **Role + Tone 분리** | openclaw (SOUL.md) | S | 2 | O | P2 | 역할(뭘 하는가)과 커뮤니케이션 스타일 명확 분리 |
| R6 | **34 Tech Stack Templates** | Agent Farm | M | 3 | O | P2 | 기술 스택별 pre-built 팀 구성 |
| R7 | **RPD Pattern Library** | 인지과학 | M | 4 | O | P1 | 패턴 인식 → 재사용. 사전 정의 Team Pattern Library |
| R8 | **Above/Below the Line (설계/실행 이원화)** | 영화 제작 | S | 4 | O | P0 | 팀을 명확히 2계층으로 분리: Above the Line(설계/창작 — 감독, 작가, 프로듀서) = opus agent가 아키텍처/설계 결정. Below the Line(실행/기술 — 촬영, 조명, 편집) = sonnet agent가 구현/테스트. **경계가 명확하여 역할 혼동 없음**. 기존 3-Tier Model Routing(C1)이 모델 선택이라면, 이것은 **팀 구조 자체의 이원화**. compose-team이 agent를 `tier: "above"/"below"` 로 분류 |

### 9. 인프라 & 격리

| ID | 패턴 | 출처 | 난이도 | 효과 | CC | 우선순위 | compose-team 구체 적용 |
|----|------|------|--------|------|-----|---------|----------------------|
| I1 | **Git worktree 격리** | ClawTeam, AO | S | 4 | O | P0 | agent별 독립 branch + worktree. `isolation: "worktree"` (native 지원) |
| I2 | **Line-level conflict** | ClawTeam | M | 3 | O | P2 | `git diff -U0` hunk 분석 → high(같은 라인)/medium(같은 파일) |
| I3 | **Worker loop protocol** | ClawTeam | S | 3 | O | P1 | "task 완료→list 재확인→inbox 확인→idle 알림→루프" |
| I4 | **2-pool executor** | deer-flow | M | 3 | △ | P2 | scheduler + execution pool 분리, 900초 타임아웃 |
| I5 | **Middleware chain 분리** | deer-flow | M | 3 | △ | P2 | lead=풀체인(13개), subagent=경량(4개만) |
| I6 | **Trust-based permission** | bkit | M | 3 | O | P2 | L0-L4 automation level, Trust Score 6가지 가중치 |
| I7 | **Niche Partitioning** | 생태학 | S | 3 | O | P1 | agent별 `file_scope` 겹침 금지 |
| I8 | **CompositeBackend (Path-Based Storage Routing)** | memory-bank | M | 3 | O | P2 | 데이터 유형에 따라 저장소 자동 라우팅: agent-memory → `.claude/agent-memory/`, handoff → `.tmp/`, 결정 기록 → `.tmp/decision-registry.jsonl`. 단일 write API로 path pattern 기반 자동 분배. compose-team이 agent별 `storage_config` 정의 |
| I9 | **Declarative Policy YAML** | NemoClaw | M | 4 | O | P1 | agent별 세밀한 권한을 선언적으로 정의: `{agent: "worker-1", allow: [Read, Grep, Edit], deny: [Bash], file_scope: "src/api/**"}`. 기존 Execution Governance(E14, allowed_tools)를 **파일 스코프까지 확장한 YAML 정책 파일**. Claude Code에서는 frontmatter `allowedTools` + CLAUDE.md 규칙으로 구현 |
| I10 | **Operator-in-the-Loop** | NemoClaw | S | 3 | O | P1 | 세션 한정 실시간 승인. 위험 작업(프로덕션 파일 수정, 외부 API 호출 등)에 대해 유저 승인 필수. 기존 Interactive checkpoints(U2, 5개 고정 CP)와 달리 **동적으로 발생하는 위험 작업에 대한 실시간 승인** |
| I11 | **Privacy Control (`<private>` 태그)** | claude-mem | S | 3 | O | P1 | agent간 전달되는 context에 `<private>` 태그를 적용하면 해당 내용은 다른 agent에게 전달되지 않음. 민감 정보(API key, 유저 개인정보 등)의 agent간 유출 방지. 기존 Memory Isolation(X11)이 전체 격리라면, 이것은 **항목 수준의 선택적 비공개** |
| I12 | **Worktree Multi-Project Query** | claude-mem | M | 2 | O | P3 | 여러 프로젝트의 worktree를 동시에 쿼리하여 cross-project 의존성 파악. compose-team이 multi-repo 작업 시 관련 프로젝트의 context를 자동 수집. Claude Code는 단일 프로젝트 기반이므로 직접 적용은 제한적 |
| I13 | **AgentRunnerEventBus** | browser-operator | M | 4 | O | P1 | 실시간 구조화 이벤트 스트림 — agent의 모든 행동(tool call, message, state change)을 이벤트로 emit. 구독자(모니터링 UI, Observer Agent, 로깅)가 독립적으로 소비. 기존 Observer Agent(M11, 비간섭 모니터링)의 **이벤트 소스 역할**. Claude Code에서는 hook(PostToolUse, SubagentStop)이 이벤트 에뮬레이션 |
| I14 | **EventBus + Watchdog** | browser-use | M | 4 | O | P1 | I13(EventBus)에 Watchdog 추가: 이벤트 스트림에서 이상 패턴(장시간 무응답, 급격한 토큰 소비, 반복 에러)을 자동 감지 → 경고/개입. EventBus가 관찰이라면, **Watchdog은 자동 대응** |
| I15 | **RAF-Batched Event Flushing** | anytype | M | 3 | O | P2 | 다수 agent의 보고를 단일 트랜잭션으로 일괄 처리. RequestAnimationFrame 패턴 — 매 "프레임"마다 쌓인 이벤트를 한번에 flush. sprint-leader가 개별 보고 대신 **배치 수신**하여 처리 효율 향상 |
| I16 | **Event Priority Sorting** | anytype | M | 3 | O | P2 | 이벤트에 구조적 우선순위 부여: CRITICAL(즉시) > WARNING(다음 배치) > INFO(유휴 시). sprint-leader가 중요 보고를 먼저 처리. 기존 ESI Triage(D12, task 우선순위)를 **이벤트/보고 수준으로 적용** |
| I17 | **Space-Based Workspace (멀티프로젝트 격리)** | anytype | M | 3 | O | P2 | 프로젝트별 독립 workspace(Space) — agent-memory, context, 설정이 Space 단위로 격리. 기존 Worktree Multi-Project(I12, cross-project 쿼리)의 반대 — **격리 우선, 필요 시만 공유** |
| I18 | **Deferred Update Batching** | anytype | M | 3 | O | P2 | 즉시 반영 불필요한 업데이트(메트릭 기록, memory 정리 등)를 deferred queue에 적재 → idle 시 일괄 처리. agent의 핵심 작업 중단 없이 부가 작업 처리. 기존 Background Augmentation Queue(C12)의 **이벤트 시스템 구현** |
| I19 | **Dual-User Filesystem + Credential-Safe Snapshot** | NemoClaw (재조사) | M | 4 | O | P1 | gateway UID/sandbox UID를 분리하여 agent의 파일 접근 권한을 OS 레벨로 격리. per-agent workspace(독립) + shared skills(공유) 2영역. **Credential-Safe Snapshot**: snapshot 생성 시 credential 자동 strip + digest 검증으로 secrets 유출 방지. 기존 Privacy Control(I11, 태그 기반)을 **OS 레벨 격리 + snapshot 보안**으로 강화 |
| I20 | **mkdir Lock as Universal Primitive** | cross-agent | S | 4 | O | P1 | cross-platform 원자적 lock — `mkdir`은 모든 OS에서 원자적 성공/실패. 파일 기반 lock의 race condition 해결. agent간 공유 자원 접근 시 `.tmp/locks/{resource}/` 디렉토리 생성으로 lock 획득 |
| I21 | **OCC + Lock 이중 보호** | cross-agent | M | 4 | O | P1 | Optimistic Concurrency Control(hash 비교) + mkdir lock 이중 보호. 먼저 hash로 변경 감지(낙관적) → 충돌 시 lock 획득(비관적). 대부분 lock 없이 처리되어 성능 우수, 충돌 시에만 lock escalation |
| I22 | **Stale Lock 자동 해제 (60초)** | cross-agent | S | 3 | O | P1 | lock 파일에 timestamp 기록 → 60초 경과 시 자동 해제. 기존 Bounded retry(E4, stale lock 해제)를 **시간 기반 자동 해제로 구체화**. agent crash 시에도 lock이 영구 점유되지 않음 |
| I23 | **Agent Pool with Slot Waiting** | cross-agent | M | 4 | O | P1 | hard cap으로 agent 슬롯 수 제한 + 슬롯 부족 시 event-driven 대기(polling 아님). 슬롯 해제 시 대기 중인 agent 자동 활성화. 기존 Staging Area(T12, 대기 풀)를 **슬롯 기반 풀링으로 구현** |
| I24 | **Orphan Reaper (좀비 agent 정리)** | cross-agent | M | 4 | O | P1 | 부모 없는 좀비 agent를 주기적으로 탐지 → 자동 종료. agent crash나 비정상 종료 후 남은 sub-agent를 정리. CronCreate로 5분마다 orphan 체크 가능 |
| I25 | **cwd-based Session Isolation** | cross-agent | S | 3 | O | P1 | 인증 정보(API key 등)는 공유하되 작업 상태는 cwd(현재 디렉토리) 기반으로 분리. 기존 worktree(I1, git 분기)와 조합하여 **인증 공유 + 상태 격리** 동시 달성 |
| I26 | **Promise Memoization Mutex** | cross-agent | M | 3 | O | P2 | 동일 자원에 대한 동시 요청을 합체. 첫 요청만 실행하고 나머지는 결과를 공유. 기존 Deferred Update Batching(I18, 일괄 처리)과 달리 **동시 요청의 중복 제거** |

### 10. 보고 & 커뮤니케이션

| ID | 패턴 | 출처 | 난이도 | 효과 | CC | 우선순위 | compose-team 구체 적용 |
|----|------|------|--------|------|-----|---------|----------------------|
| K1 | **SBAR Structured Report** | 수술팀 | S | 5 | O | P0 | worker→sprint-leader 보고를 S(현재상태)/B(변경전맥락)/A(결과평가)/R(다음단계제안) 4필드 강제 |
| K2 | **Closed-Loop Communication** | 수술팀 | S | 4 | O | P0 | 지시→복창→확인 3단계. worker가 task 요약을 자기 말로 복창, sprint-leader 확인 후 실행 |
| K3 | **Sterile Cockpit Zone** | 수술팀 | S | 3 | O | P1 | `sterile: true` phase에서 sprint-leader가 worker에게 중간 질문/상태확인 금지 |
| K4 | **Brief-Debrief Cycle** | 수술팀 | S | 4 | O | P1 | phase 시작 전 브리핑(목표, 위험) + 완료 후 디브리핑(성과, 실패, 교훈) |
| K5 | **Negative Result Broadcasting** | autoresearch | S | 3 | O | P1 | 실패 경로를 구조화 보고 → 다른 worker에 전파 |
| K6 | **Auftragstaktik** | 임무형 지휘 | S | 3 | O | P1 | what+why+boundary 전달, how는 위임 |
| K7 | **Commander's Intent 2하** | C2 원칙 | S | 3 | O | P1 | 유저 원본 요청을 worker에게도 축약 전달 |
| K8 | **Section Principal 위임** | 오케스트라 | M | 3 | O | P2 | 같은 template의 worker 2명이면 시니어가 코딩 컨벤션 통일 |
| K9 | **File-Based Channel (그룹챗 대안 1)** | autoresearch Hub + 독자 설계 | M | 5 | O | P0 | `.tmp/channels/{topic}.md`에 append-only 로그. 참여 agent 목록 고정. 각 agent가 자기 발언을 append하고 다른 agent 발언을 Read로 확인. sprint-leader 중계 불필요. **구현**: hook(PreToolUse:Write)이 채널 파일 write 감지 → 참여 agent에게 자동 알림 DM. autoresearch의 `#results`/`#discussion` 패턴을 Claude Code 파일 시스템으로 구현 |
| K10 | **Selective Multicast (그룹챗 대안 2)** | 독자 설계 | M | 4 | O | P0 | SendMessage의 `to` 필드를 확장하여 `"agent-a,agent-b"` 형태 지원. 현재 `*`(전체) vs `name`(1:1)만 가능한 것을 **선택적 멀티캐스트**로 확장. compose-team이 `communication_group: ["worker-1", "worker-2"]`를 정의하면 sprint-leader 없이 해당 그룹 내 직접 토론 가능. **구현 의존**: Claude Code native API 확장 필요 — 불가 시 K9(파일 기반)으로 fallback |
| K11 | **Sprint-Leader Relay (현행 + 최적화)** | 현재 방식 | S | 2 | O | P1 | 현재 star topology 유지하되 bottleneck 완화: (1) sprint-leader가 relay 시 원문 그대로 전달(요약 금지), (2) `relay_to: ["worker-1", "worker-2"]` 일괄 전송, (3) relay 빈도 제한(batch — 3개 메시지 모아서 1회 전달). **한계**: 근본적으로 star topology의 O(n) 지연은 해소 불가 |
| K12 | **Expediter (내부 조율/외부 인터페이스 분리)** | 주방 Brigade | M | 4 | O | P1 | sprint-leader의 역할을 2개로 분리: (1) **Expediter**(외부 — Session Lead와의 인터페이스, 산출물 품질 최종 확인, 전달 순서 조율), (2) **Sous-Chef**(내부 — worker 관리, task 배분, 진행 추적). 기존 Foreperson Facilitation(A3, 편향 제거)과 달리 **역할의 물리적 분리**. 5+ worker 팀에서 sprint-leader bottleneck 해소 |
| K13 | **Call Sheet (1문서 phase 브리핑)** | 영화 제작 | S | 4 | O | P0 | 다음 phase에 필요한 모든 정보를 **1개 문서**에 압축: 참여 agent 목록, 각자 역할, 시간대, 필요 context, 주의사항, 연락처(DM 대상). 기존 Brief-Debrief(K4, 구두 브리핑)와 달리 **문서화된 1장 브리핑**. compose-team이 phase별 call sheet를 자동 생성하여 `.tmp/call-sheets/phase-N.md` 저장 |

### 11. 검증 & 품질 보장

| ID | 패턴 | 출처 | 난이도 | 효과 | CC | 우선순위 | compose-team 구체 적용 |
|----|------|------|--------|------|-----|---------|----------------------|
| V1 | **3-Phase Gate** | 수술팀 (WHO) | M | 4 | O | P1 | Spawn 전(범위확인) / 구현 전(복창) / 머지 전(크로스체크) 3개 gate |
| V2 | **Canary Scoring Gate** | 릴리스 엔지니어링 | M | 4 | O | P1 | 산출물 품질 다차원 자동 측정: scope 내 여부, 테스트 통과율, lint/type 에러 수 |
| V3 | **Daubert Gate** | 법정 절차 | M | 4 | O | P1 | 4-factor 검증: 실행 가능, 호환성, 표준 준수, 동료 리뷰 통과 |
| V4 | **Cross-Agent Review** | GitHub Squad | M | 4 | O | P1 | 자기 작업 자기 리뷰 금지 + Charter/History 이중 영속 |
| V5 | **Expert Witness Independence** | 법정 절차 | M | 3 | O | P2 | review agent의 충성 대상을 sprint-leader가 아닌 프로젝트 표준(CLAUDE.md)으로 재정의 |
| V6 | **Adversarial Pair** | 법정 절차 | M | 3 | O | P2 | 중요 설계 결정에서 두 agent에게 의도적 반대 입장 할당 |
| V7 | **Naked Reasoner** | autoresearch | M | 3 | O | P2 | 평가자에게 변경 이유 숨기고 결과만 평가. review bias 제거 |
| V8 | **Best of N** | Coder/Mux | H | 3 | O | P2 | 동일 프롬프트 N개 agent 병렬 실행 → 최선 합성 |
| V9 | **LLM Quality Judge** | ccswarm | M | 3 | O | P2 | multi-dimensional auto-scoring |
| V10 | **Negative Selection** | 생물학 | M | 2 | O | P3 | QA agent에 "self-profile" 주입, 정상 패턴에서 비정상만 탐지 |
| V11 | **Key Assumption Check** | 법정 (CIA SAT) | M | 4 | O | P1 | 팀 구성 전 핵심 가정 명시 + 가정 틀릴 경우의 fallback 기술 |
| V12 | **Deliberation Protocol** | 법정 절차 | M | 3 | O | P2 | 독립 분석 → 차이점 대비 → 반론 기회 → 합성안 + 소수 의견 기록 |
| V13 | **Predict-then-Attribute** | autoresearch | M | 3 | O | P2 | 실험 전 예측 강제 → 결과 비교 → beliefs 업데이트 |
| V14 | **Mastery Gate** | 교육/학습 설계 | M | 4 | O | P1 | phase 완료 판정을 "통과/불통과" 이진이 아닌 "숙달도 80%+ 달성 시 진행" 기준으로 변경. agent 산출물이 acceptance criteria의 80%+ 충족 시에만 다음 phase. 기존 Completion Scoring(E9, 0-1 점수)을 **gate 기준으로 활용** |
| V15 | **Fading Scaffolding** | 교육/학습 설계 | M | 3 | O | P2 | 초기 agent에게 상세한 가이드(예제 코드, 패턴 힌트) 제공 → phase 진행에 따라 점진적으로 가이드 축소 → 최종 phase에서는 최소 context만. agent 자립도 점진 향상. compose-team이 phase별 `guidance_level: full/partial/minimal` 설정 |
| V16 | **Prerequisite Skill Graph** | 교육/학습 설계 | M | 4 | O | P1 | agent에게 task 배정 전 필요 스킬의 의존성 그래프 확인. "API 테스트 작성"은 "API 구조 이해"가 선행. compose-team이 task별 `prerequisite_context`를 명시하고, 해당 context를 agent prompt에 자동 포함. 기존 DAG(O5)가 task간 의존이면, 이것은 **지식/context간 의존** |
| V17 | **ZPD Calibration** | 교육/학습 설계 (비고츠키) | M | 3 | O | P2 | Zone of Proximal Development — agent가 "혼자 할 수 있는 것"과 "지원 시 할 수 있는 것"의 경계를 파악하여 적절한 난이도의 task 배정. sonnet에게 opus 수준의 task를 주지 않되, 너무 쉬운 task도 주지 않음. compose-team이 `model_capability_fit` 점수 계산 |
| V18 | **Avatar Responder (Confidence Scoring)** | memory-bank | M | 3 | O | P2 | agent가 응답 시 confidence score(0-1)를 함께 출력. 낮은 confidence → 자동으로 다른 agent에게 2nd opinion 요청 또는 sprint-leader에게 에스컬레이션. 기존 Completion Scoring(E9, task 완료도)과 달리 **응답 단위의 확신도 측정** |

### 12. 동적 조정 & 적응

| ID | 패턴 | 출처 | 난이도 | 효과 | CC | 우선순위 | compose-team 구체 적용 |
|----|------|------|--------|------|-----|---------|----------------------|
| D1 | **Dynamic Resectorization** | 항공 관제 | M | 3 | O | P2 | sprint-leader가 runtime 중 task scope를 동적 분할/병합 |
| D2 | **Work Stealing** | 분산 컴퓨팅 | M | 3 | O | P2 | idle agent가 busy agent의 남은 task 인수 |
| D3 | **Balance Adjustment** | 오케스트라 | M | 3 | O | P2 | 실행 중 agent 산출물 비중 동적 조정 |
| D4 | **Response Threshold** | 생물학 | M | 3 | O | P1 | `conditional_agents` — 자극 수준별 agent 단계적 추가 spawn |
| D5 | **r/K Selection** | 생태학 | M | 3 | O | P2 | 불확실성 높음→다수scout(r), 낮음→소수opus(K) 전략 분기 |
| D6 | **Counter-Pick** | 게임 AI (RTS) | M | 3 | O | P2 | task 성격 정찰(WM feasibility) 후 counter agent 배치 |
| D7 | **Affinity-Based Dropout Recovery** | DRAMA 논문 | M | 3 | △ | P2 | agent 탈락 시 가장 유사한 agent가 자동 작업 인수 |
| D8 | **Fire-and-Maneuver** | 군사 Fire Team | M | 2 | O | P3 | 이전 phase agent가 다음 phase에서 cover/support 역할 전환 |
| D9 | **Swarm Handoff** | AutoGen, LangGraph | H | 2 | X | P3 | 중앙 오케스트레이터 없이 agent간 직접 task handoff. Claude Code DM 구조에서 제한적 |
| D10 | **Cross-Graph Navigation** | LangGraph | H | 2 | X | P3 | subgraph node가 sibling에 직접 이동. Claude Code에서 불가 |
| D11 | **Fast-Advance Successor** | Claude-Code-Workflow | M | 3 | O | P2 | coordinator 없이 agent→agent 직접 트리거 |
| D12 | **ESI 2-Step Triage** | 응급실 트리아지 | M | 5 | O | P0 | 긴급도(urgency) x 자원량(resource needs) 2축 분류. Step 1: "즉시 개입 필요?" → 긴급도 판정. Step 2: "필요한 자원 수?" → 복잡도 판정. compose-team이 task를 ESI Level 1-5로 자동 분류하여 agent 수/모델 tier 결정. 기존 단일 축(복잡도만) 분류를 2축으로 확장 |
| D13 | **Determinant Code Matching** | 응급실 트리아지 | M | 4 | O | P1 | task의 "증상"(키워드, 파일 패턴, 에러 유형)을 사전 정의 코드와 매칭하여 적합 agent 자동 결정. "TypeScript + API + test failure" → 코드 X23 → backend-testing agent. 기존 fuzzy matching(L2)이 template 재사용이라면, 이것은 **task→agent 매칭 코드 테이블** |
| D14 | **Re-Triage Protocol** | 응급실 트리아지 | S | 4 | O | P1 | 실행 중 task 복잡도가 예상과 다를 때 재분류. worker가 "예상보다 복잡/단순" 보고 → sprint-leader가 즉시 ESI 레벨 재판정 → agent 추가/제거. 기존 Dynamic Resectorization(D1, 영역 재설계)과 달리 **task 자체의 난이도 재평가** |
| D15 | **Fast Track Lane** | 응급실 트리아지 | S | 4 | O | P0 | ESI Level 4-5(단순 task)는 별도 fast track — 대기 없이 즉시 처리. compose-team이 단순 task를 식별하면 팀 구성 프로세스 자체를 스킵하고 single agent 즉시 실행. 기존 "스킬 체인 우선"(T5)과 시너지 |

### 13. 충돌 관리

| ID | 패턴 | 출처 | 난이도 | 효과 | CC | 우선순위 | compose-team 구체 적용 |
|----|------|------|--------|------|-----|---------|----------------------|
| F1 | **3-Layer Conflict Detection** | 항공 관제 | M | 4 | O | P1 | 설계 시점(file scope 겹침) → 구현 중(diff overlap) → 머지 시(line-level) 시간축 자동 탐지 |
| F2 | **conflicts_with 메타데이터** | CCPM | S | 3 | O | P1 | task간 충돌 명시 선언 |
| F3 | **4-Tier Conflict Resolution** | Overstory | M | 3 | O | P2 | 텍스트자동 → 구조적 → AI보조 → 사람 단계적 머지 |
| F4 | **Miles-in-Trail (MIT)** | 항공 관제 | M | 3 | O | P2 | 동일 파일/모듈 수정 agent 간 최소 시간 간격 강제 |
| F5 | **Affinity/Anti-Affinity** | K8s | S | 3 | O | P1 | agent 동일 phase 배치 강제 or 파일 충돌 방지 분산 |
| F6 | **Taint/Toleration** | K8s | M | 2 | O | P2 | 민감 task에 taint → 전용 agent만 할당 |
| F7 | **Ostrom CPR** | 경제학 | M | 2 | O | P2 | agent별 `resource_boundary` 명시. 공유 자원 거버넌스 |
| F8 | **Discriminated Union Change Protocol** | xyflow | M | 4 | O | P1 | 모든 변경을 표준화된 타입으로 구분: `{type: "add" | "remove" | "replace" | "reset", item: {...}}`. agent간 변경 사항 전달 시 자유 형식이 아닌 **discriminated union으로 타입 안전하게 교환**. 기존 Strip Encoding(X13, 필드 고정 약어)을 **변경 이벤트에 특화** |
| F9 | **Triple-Key Lookup + onBeforeDelete** | xyflow | M | 4 | O | P1 | 삭제 전 의존성 검증: (1) id/source/target 3중 키로 관련 항목 조회, (2) onBeforeDelete 콜백에서 의존 항목 확인 → 삭제 허용/거부. agent output을 제거할 때 **다른 agent output이 의존하고 있으면 삭제 차단**. 기존 Kill Switch(B2, 개별 on/off)에 **의존성 검증 추가** |
| F10 | **Parent-Child Subflow** | xyflow | M | 3 | O | P2 | task를 parent-child 계층으로 중첩. parent task 안에 child task들이 subflow를 형성. parent 접으면 child 숨김, parent 이동하면 child도 이동. 기존 AgentSession 트리(O25, 세션 계층)를 **task 계층으로 확장** |

### 14. 배포 & 롤백

| ID | 패턴 | 출처 | 난이도 | 효과 | CC | 우선순위 | compose-team 구체 적용 |
|----|------|------|--------|------|-----|---------|----------------------|
| B1 | **Blue-Green Swap** | 릴리스 엔지니어링 | M | 3 | O | P2 | 위험 리팩토링: 두 branch 병렬 유지, 검증 완료 시 전환, 실패 시 원본 유지 |
| B2 | **Kill Switch Flag** | 릴리스 엔지니어링 | M | 3 | O | P2 | 각 agent output을 독립 모듈로 설계 → 개별 revert 가능 |
| B3 | **Progressive Rollout** | 릴리스 엔지니어링 | M | 3 | O | P2 | 영향 범위 점진적 확대: 1파일 → 3파일 → 전체 적용 |
| B4 | **Git-as-State-Machine** | autoresearch | S | 3 | O | P1 | 성공→commit, 실패→reset. branch 작업 + 개선 시에만 merge |
| B5 | **Time-Travel Checkpoint** | LangGraph | H | 3 | △ | P3 | 매 step immutable checkpoint → 실패 시 resume |
| B6 | **Rehearsal Mark Navigation** | 오케스트라 | M | 3 | O | P2 | 의도적 재개 지점 배치. "Mark-C부터 재시작" 가능 |
| B7 | **Speculative Execution** | CPU 아키텍처 + AI 연구 | M | 3 | O | P2 | 불확실한 분기점에서 양쪽 경로를 동시에 실행. 결과 확정 시 잘못된 경로 폐기. Blue-Green과 달리 두 경로가 다른 접근법이 아니라 같은 분기의 다른 결과 |

### 15. 합의 & 의사결정

| ID | 패턴 | 출처 | 난이도 | 효과 | CC | 우선순위 | compose-team 구체 적용 |
|----|------|------|--------|------|-----|---------|----------------------|
| A1 | **Scout-Quorum** | 생물학 | M | 4 | O | P1 | 독립 탐색 → 정족수 합의 → 실행. `decision_pattern: "scout-quorum"` |
| A2 | **Quorum Sensing** | 생물학 | M | 3 | O | P2 | N개 완료 시 다음 단계 (전체 대기 X). `quorum_threshold: 2` |
| A3 | **Foreperson Facilitation** | 법정 절차 | M | 3 | O | P2 | sprint-leader 역할을 facilitator로 — 기술적 의견 미주입, 공평 취합+판정 |
| A4 | **System 1/2** | 인지과학 | S | 3 | O | P1 | `decision_mode: "fast"/"deliberate"` 3단계 |
| A5 | **ESS** | 생태학 | M | 3 | O | P2 | 팀 자기검증 ("빼면? 추가하면?") — 침투 불가능한 균형 확인 |
| A6 | **Bilevel Meta-Optimization** | autoresearch | H | 3 | O | P3 | inner loop(task) + outer loop(전략 자체 최적화). 팀 구성 로직의 메타 개선 |
| A7 | **Kill/Spike Decision (Sunk Cost 무시 중단)** | 뉴스룸 | S | 4 | O | P0 | 진행 중인 task가 "이미 투입한 비용과 무관하게" 더 이상 가치가 없다고 판단되면 즉시 중단. Kill(완전 폐기) vs Spike(보류하고 나중에 재검토) 2가지 결정. 기존 Completion Scoring+Bail(E9, 수렴 실패 시 중단)은 **자동** — 이것은 sprint-leader/유저가 **명시적으로 sunk cost를 무시하고 중단 결정**. compose-team이 각 phase에 `kill_criteria` 사전 정의 |

### 16. 실험 & 탐색

| ID | 패턴 | 출처 | 난이도 | 효과 | CC | 우선순위 | compose-team 구체 적용 |
|----|------|------|--------|------|-----|---------|----------------------|
| P1 | **Fixed-Budget Tournament** | autoresearch | M | 3 | O | P2 | "완료"가 아닌 "N분 내 최선" 판정. task에 시간 제한 + keep/discard |
| P2 | **Single-File Constraint** | autoresearch | S | 3 | O | P1 | worker에 `allowedFiles` 물리적 1파일 강제. 수정 범위 제어 |
| P3 | **Hub-Mediated Stigmergy** | autoresearch | M | 2 | O | P3 | 중앙 조율자 없이 공유 게시판으로 간접 협력 |
| P4 | **UCB1 Dimension-Aware** | autoresearch | H | 2 | △ | P3 | 작업 영역 차원 분류 + UCB1 탐색/활용 균형 |
| P5 | **Comparative Advantage** | 경제학 | M | 3 | O | P2 | 기회비용 기반 특화. "대체 불가능성 높은 task"에 전문 agent 우선 |
| P6 | **Contract Theory** | 경제학 | M | 2 | O | P2 | task에 `acceptance_criteria` 필수. observable output 기반 평가 |
| P7 | **Predator-Prey** | 생태학 | S | 2 | O | P2 | 구현:검증 비율 3:1 |
| P8 | **Clonal Selection** | 생물학 | M | 2 | O | P2 | 성공 전략 복제+전파. Phase 간 "best practice 요약" handoff |
| P9 | **Temporal Polyethism** | 생물학 | S | 2 | O | P2 | 안전→위험 순서. Phase에 `risk_level` 태그 |
| P10 | **Control-Theoretic Feedback (PID)** | arxiv 2603.10779 | H | 3 | △ | P3 | PID 제어 이론을 agent 시스템에 적용. error(목표-현재 차이), derivative(변화율), integral(누적 편차)로 agent 행동 강도 자동 조정. 수렴 보장 이론적 근거 제공 |
| P11 | **Capability Negotiation Protocol** | arxiv 2506.13590 | M | 3 | △ | P2 | agent가 자기 capability를 구조적으로 광고 + task 요구사항과 매칭. "나는 TypeScript expert, React 경험 3년" 식의 자기 선언 → compose-team이 최적 매칭 |
| P12 | **Hybrid Dense+Lexical Ranking** | Memori | H | 3 | △ | P3 | FAISS(dense vector) + BM25(lexical) 이중 검색으로 agent-memory/context 검색 정확도 향상. 기존 FTS5 3-tier(X7, SQLite 기반)의 대안. Claude Code에서는 외부 인덱스 필요 |
| P13 | **Semantic Triple KG** | Memori | H | 2 | X | P3 | 프로젝트 지식을 (subject, predicate, object) 트리플로 구조화. "파일A → depends_on → 모듈B" 같은 관계 그래프. WM의 file-map을 KG로 확장하는 개념이나 Claude Code에서 직접 구현은 어려움 |

### 17. 핸드오프 & Phase 전환

| ID | 패턴 | 출처 | 난이도 | 효과 | CC | 우선순위 | compose-team 구체 적용 |
|----|------|------|--------|------|-----|---------|----------------------|
| H1 | **Accepting Controller Pre-Condition** | 항공 관제 | M | 4 | O | P1 | 다음 phase agent가 spawn 전 `entry_requirements` 선언 → 이전 phase가 충족해야 handoff |
| H2 | **Ground Delay Program (GDP)** | 항공 관제 | M | 3 | O | P2 | agent spawn 지연시켜 idle 상태 context 소비 방지. 완료 예상에 맞춰 spawn 시점 계산 |
| H3 | **Delegation Hook 체인** | Mastra | M | 3 | △ | P2 | onDelegationStart(수정/거부) → onDelegationComplete(bail/feedback) → onIterationComplete |
| H4 | **SocietyOfMind** | AutoGen | H | 2 | X | P3 | 내부 GroupChat을 단일 agent로 캡슐화. 재귀적 계층 |
| H5 | **Durable Timer** | Temporal.io | M | 4 | O | P1 | phase 완료 후 "N분 대기 → 다음 phase 자동 트리거" 내구성 타이머. 프로세스 재시작에도 타이머 유지. Claude Code에서는 `CronCreate`로 구현 가능. compose-team이 phase간 `wait_duration` 필드 생성 |
| H6 | **Signal-Driven Branching** | Temporal.io | M | 4 | O | P1 | 외부 이벤트(시그널)에 따라 workflow 분기. agent가 "빌드 완료" 시그널을 수신하면 다음 phase 자동 시작. compose-team이 `trigger_signal` 필드로 phase 진입 조건 정의. 기존 GDP(spawn 시점 예약)와 달리 **이벤트 기반 반응적 전환** |
| H7 | **Continue-As-New** | Temporal.io | M | 3 | O | P2 | 장기 실행 workflow의 context 비대화 방지. N step마다 현재 state를 요약 → 새 workflow instance로 이관. Claude Code에서는 agent compaction과 유사 — compose-team이 `max_steps_before_refresh` 설정, 초과 시 agent 재spawn + context 요약 handoff |
| H8 | **Fire/Hold Synchronization** | 주방 Brigade | M | 4 | O | P1 | 여러 agent의 완료 시점을 동기화. 주방에서 모든 요리가 동시에 나가야 하듯, 병렬 worker의 결과가 특정 시점에 **동시에** 모여야 하는 경우. sprint-leader가 "Hold" 지시(완료해도 대기) → 모든 worker 완료 확인 → "Fire" 지시(일제 전달). 기존 Quorum Sensing(A2, N개 완료 시 진행)과 달리 **전원 완료+동시 전달** |
| H9 | **Deadline Cascade (역산 마감)** | 뉴스룸 | M | 4 | O | P1 | 최종 deadline에서 역산하여 각 phase/agent의 마감 시각을 자동 계산. "배포 18:00 → 통합 테스트 17:00 → 구현 완료 15:00 → 설계 확정 13:00". 기존 Time Window(O18, 시작-마감)와 달리 **최종 마감에서 역방향 자동 계산**. compose-team이 `final_deadline` 입력 → phase별 deadline 자동 생성 |

### 18. 자기 개선 & 메타

| ID | 패턴 | 출처 | 난이도 | 효과 | CC | 우선순위 | compose-team 구체 적용 |
|----|------|------|--------|------|-----|---------|----------------------|
| M1 | **Built-in Evaluation Scoring** | Mastra | H | 3 | △ | P3 | 실시간 LLM/NLP scorer + DB 자동 저장 + CI/CD 추세 분석 |
| M2 | **Hyper-Decentralization 위험** | NDU 논문 | S | 2 | O | P1 | worker 과도한 자율성 경고 — locally optimal but globally suboptimal |
| M3 | **Single-Threaded Owner** | Amazon | S | 3 | O | P1 | 각 agent = 하나의 task에만 전적 집중 (multi-task 금지) |
| M4 | **Chapter/Guild** | Spotify | M | 2 | O | P3 | 동일 template agent의 횡단 지식 공유 (agent-memory template 단위) |
| M5 | **MapReduce Partitioning** | 분산 컴퓨팅 | M | 2 | O | P2 | 작업량 균등 분배 검증, data skew 사전 감지 |
| M6 | **Metacognitive State Vector** | 인지과학 + AI 연구 | M | 4 | O | P1 | System 1/2 전환을 정량화. agent의 현재 상태를 벡터로 표현: `{confidence: 0.7, uncertainty: 0.3, complexity: 0.8}`. confidence < threshold → System 2(신중 모드) 자동 전환. compose-team이 task별 `metacognitive_threshold` 설정 |
| M7 | **Knowledge Distillation** | 교사-학생 패턴 | H | 2 | △ | P3 | 경험 많은 agent(opus)의 판단 패턴을 요약 → 경량 agent(sonnet)에게 전달. agent-memory에 "판단 로그" 축적 → 다음 세션에서 sonnet이 참조 |
| M8 | **Emergent Collective Memory** | arxiv 2512.10166 | H | 2 | △ | P3 | 분산된 agent 기억이 중앙 조율 없이 자발적으로 통합. 각 agent가 local memory를 공유 artifact에 기록 → 패턴이 자연 수렴 |
| M9 | **Agent Protocol Interop (A2A/ACP)** | Google A2A, ACP | H | 2 | X | P3 | 표준화된 agent간 통신 프로토콜. Agent Card로 capability 광고 + 표준 메시지 포맷. Claude Code 내부에서는 불필요하나 외부 agent 연동 시 참고 |
| M10 | **4-Phase Auto-Capture** | claude-memory | M | 4 | O | P1 | 지식 캡처를 4단계로 자동화: (1) 결정론적 triage(키워드/패턴 매칭으로 캡처 대상 후보 선별), (2) LLM draft(후보를 구조화된 memory 항목으로 변환), (3) 중복/모순 검사, (4) 저장. **결정론적 판단과 LLM 판단을 명시적으로 분리**하여 비용 절감 + 일관성 확보. compose-team의 디브리핑(K4) 단계에서 교훈 자동 캡처에 적용 |
| M11 | **Observer Agent** | claude-mem | M | 5 | O | P0 | 실시간 관찰자 subprocess — tool 전부 비활성화(Read/Write 없음), 오직 대화 흐름만 관찰하여 패턴/교훈/이상 탐지. 메인 agent 중단 없이 **비간섭적 모니터링**. 기존 Observational Memory(X10, Mastra)의 Claude Code 구현 — subprocess로 spawn, tool 비활성화 frontmatter로 강제. **agent 세션 보존 문제를 직접 해결**: Observer가 세션 전체를 관찰하여 핵심 결정/전환점 자동 기록 |
| M12 | **Mode System (도메인별 관찰 프로파일)** | claude-mem | M | 3 | O | P2 | Observer Agent의 관찰 기준을 도메인별로 전환: coding mode(코드 변경 추적), review mode(품질 이슈 추적), research mode(발견 사항 추적). 상속 패턴 — base mode에서 파생. compose-team이 task 유형에 따라 `observation_mode` 자동 설정 |

---

## Claude Code 시스템 제약

| 제약 | 설명 | 영향 | 대안 |
|------|------|------|------|
| **런타임** | Claude Code native Agent/Team API | tmux/subprocess/Docker 패턴 직접 적용 불가 | Skill + Agent tool로 대체 |
| **통신** | SendMessage DM only (1:1 또는 `*` 브로드캐스트) | mailbox 파일, MCP 기반 통신 불가 | DM + `.tmp/` handoff 파일 조합 |
| **그룹챗 부재** | 2-3명 선택적 토론 채널 없음. sprint-leader가 hub로 모든 통신 중계 (star topology bottleneck) | AutoGen GroupChat, autoresearch Hub (#results/#discussion), ClawTeam mailbox 패턴 직접 적용 불가. 다자간 설계 토론, peer review 교환, 동시 brainstorming이 구조적으로 불가 | 아래 3가지 대안 참조 (K9~K11) |
| **설정** | CLAUDE.md + hook + skill hot-reload | 미들웨어 체인 직접 적용 불가 | hook(7종)으로 미들웨어 에뮬레이션 |
| **상태** | WM agent + agent-memory | SQLite/Redis 불가 | file-based state (.tmp/, agent-memory/) |
| **격리** | `isolation: "worktree"` (native 지원) | 이미 지원됨 | 추가 조치 불필요 |
| **Agent 정의** | markdown frontmatter + body | npm 패키지 교체 불가 | template markdown 교체 |
| **팀 구성** | Skill → JSON 출력 → Session Lead 실행 | TOML/YAML config 불가 | JSON 포맷 유지 |
| **모델** | opus > sonnet > never haiku (프로젝트 규칙) | 일부 프로젝트의 haiku 최적화 패턴 적용 불가 | sonnet이 최소 tier |

---

## 우선순위별 적용 로드맵

### P0 — 즉시 적용 (compose-team V2 핵심, 변경 최소)

| # | 패턴 ID | 패턴명 | 문제 해결 | 구현 방식 |
|---|---------|--------|----------|----------|
| 1 | T1, T3, T6, T8, T9 | **팀 규모 하드캡** | 문제2 (현실감각) | JSON 출력에 `max_agents` 필드 + Brooks 공식 경고 |
| 2 | T5 | **스킬 체인 우선** | 문제2 | 단순 task에 multi-agent 대신 skill chain 제안 |
| 3 | L1, L2 | **3-tier lifecycle + fuzzy matching** | 문제3, 4 (라이프사이클, UX) | permanent/reusable/ephemeral 분류 + 기존 template 재사용 검사 |
| 4 | E1, E6 | **4-status + verification gate** | 문제1 (자기반성) | 결과 보고 표준화 + 증거 없는 완료 방지 |
| 5 | C1, C2 | **모델 라우팅** | 문제2 | task 복잡도 → 모델 자동 매핑 |
| 6 | U1, U2, U3, U4 | **UX 4종 세트** | 문제4 | clarification → plan → checkpoint → summary 파이프라인 |
| 7 | O1 | **5 오케스트레이션 패턴** | 문제2 | task 특성 → Leader/Council/Swarm/Pipeline/Watchdog 자동 선택 |
| 8 | R2 | **Team archetype** | 문제2 | 프리셋 팀 구성으로 현실적 기본값 제공 |
| 9 | I1 | **Git worktree** | (인프라) | native 지원 활용 |
| 10 | X1 | **Context budget 계산** | 문제2 | 예상 토큰 사용량을 compose-team 출력에 포함 |
| 11 | K1, K2 | **SBAR + Closed-Loop** | 문제1 | 보고 표준화 + 복창 확인 |
| 12 | C8 | **BATS (Budget-Aware Strategy)** | 문제2 | 남은 예산에 따라 모델 tier + tool 빈도 동적 조정 |
| 13 | C10 | **Lazy Skill Loading 3-Phase** | 문제2 | 스킬 이름만 로드 → 선택 → 전체 로드. 97% 토큰 절약 |
| 14 | D12, D15 | **ESI 2-Step Triage + Fast Track** | 문제2, 4 | 긴급도x자원량 2축 분류 + 단순 task는 팀 구성 스킵 |
| 15 | O17 | **Capacity Constraint** | 문제2 | 개별 agent 처리 용량 제한으로 과부하 방지 |
| 16 | X17 | **Decision Registry** | 문제1 | 설계 결정 구조화 기록 → 자기반성 + 추적 가능 |
| 17 | K9, K10 | **그룹챗 대안 (File Channel + Selective Multicast)** | 문제2 (통신 bottleneck) | `.tmp/channels/` 파일 기반 채널 또는 SendMessage 멀티캐스트 확장. sprint-leader star topology bottleneck 해소 |
| 18 | L11 | **General-Purpose Auto Subagent** | 문제3, 4 | 모든 팀에 default agent 자동 포함 — 잔여/미분류 task 방치 방지 |
| 19 | L12 | **CompiledSubAgent 재사용** | 문제3 | 이전 팀의 agent+task+context 번들 통째 재사용 |
| 20 | L13 | **4-Phase Lifecycle (Reconcile)** | 문제1 | Return 후 Reconcile(결과 통합) phase를 명시적 1급 시민으로 승격 |
| 21 | X19 | **State Exclusion List** | 문제2 | context 전달 시 "빼야 할 것" 명시 — 불필요한 정보 제거로 토큰 절약 |
| 22 | M11 | **Observer Agent** | 문제1 | 비간섭적 실시간 모니터링 — agent 세션 보존 문제 직접 해결 |
| 23 | X26 | **Progressive Disclosure 3-Layer** | 문제2 | memory 인덱스만 주입 → 온디맨드 상세 로드. Lazy Loading의 일반화 |
| 24 | E15 | **Anti-Resurrection Window** | 문제3, 4 | 삭제된 항목의 24시간 재생성 차단. 삭제→재생성 루프 방지 |
| 25 | O23 | **Agent=Tool 등가 (ConfigurableAgentTool)** | 문제2, 4 | agent를 tool 인터페이스로 등록 — handoff가 자연스러운 tool call. 팀 구성의 복잡성 근본 감소 |
| 26 | O24 | **선언적 Handoff** | 문제2 | compose-team 시점에서 handoff 조건(trigger, filter)을 미리 선언. 런타임 불확실성 제거 |
| 27 | K13 | **Call Sheet (1문서 phase 브리핑)** | 문제4 | phase별 참여 agent, 역할, context, 주의사항을 1장으로 자동 생성 |
| 28 | A7 | **Kill/Spike Decision** | 문제1 | sunk cost 무시 중단 결정. phase별 kill_criteria 사전 정의 |
| 29 | R8 | **Above/Below the Line** | 문제2, 3 | 설계(opus)/실행(sonnet) 2계층 명확 분리. 역할 혼동 방지 |
| 30 | L15 | **Declarative Capability Selection** | 문제3 | agent capability를 toggle on/off로 선언적 관리 |
| 31 | E21 | **Budget Warning (75% 경고)** | 문제2 | 토큰 예산 75% 소진 시 자동 경고 + 전략 전환 |
| 32 | X36 | **Selective State Propagation** | 문제2, 3 | state key 단위로 공유/격리 선언. memory 격리 + files 전파 세밀 제어 |
| 33 | O30 | **Foreground/Background 이분법** | 문제2 | task별 execution_mode 자동 설정. background-first 규칙 구조화 |
| 34 | X38 | **Structured Context Compaction** | 문제1, 2 | Goal/Progress/Decisions/NextSteps 4필드 강제 압축. 핵심 정보 구조 보존 |

### P1 — 단기 적용 (V2 출시 후 1-2 iteration)

| 카테고리 | 패턴 ID | 핵심 내용 |
|---------|---------|----------|
| 오케스트레이션 | O2, O3, O4, O7, O8, O9, O10, O16, O20, O21, O25, O26, O27 | Routing table, task decomposer, dual-loop, OODA, filter-score, Clarke-Wright, ontology, typed relation, AgentSession, operational period, all-day aggregation |
| 라이프사이클 | L3, L4, L5, L10, L14, L16, L17, L18, L19, L20, L21 | Registry, maxTurns, stocktake, satisficing, blueprint, enable/disable, provider bulk, delegation-as-capability, FS watcher, skill 동적, builtin+custom 이중 체계 |
| 비용 | C3, C4, C5, C9, C15, C16, C17 | Effort display, cost mode, frontmatter, cache-aware, LLM-as-Judge, token economics, 3-tier fallback chain |
| 실패 처리 | E3, E4, E5, E9, E10, E12, E13, E14, E16, E19, E20, E22, E23, E24 | Verify-fix, bounded retry, loop detection, completion scoring, PACE, circuit breaker, saga, governance, re-fire, action loop, replan-on-stall, fallback LLM, pause/resume, stale context discard |
| 컨텍스트 | X2, X3, X5, X8, X9, X11, X13, X18, X20, X21, X23, X25, X27, X30, X31, X32, X33, X34, X37 | Progressive, handoff, todo, cross-agent, strip, episodic, fact consolidation, session continuity, 3-level+writer, FTS5, dual-path, tree pruning, memory block, tool sanitize, compaction, sensitive scoping, path-based storage |
| UX | U5, U7, U8 | Mechanical/Taste, effort display, 이중 주석 |
| 템플릿 | R1, R3, R7 | TOML→JSON, 3-tier command, pattern library |
| 인프라 | I3, I7, I9, I10, I11, I13, I14, I19, I20, I21, I22, I23, I24, I25 | Worker loop, niche, declarative policy, operator, privacy, EventBus, Watchdog, dual-user FS, mkdir lock, OCC+lock, stale lock, agent pool, orphan reaper, cwd session isolation |
| 보고 | K3, K4, K5, K6, K7, K12 | Sterile zone, brief-debrief, negative broadcast, auftragstaktik, expediter |
| 검증 | V1, V2, V3, V4, V11, V14, V16 | 3-phase gate, canary scoring, daubert, cross-review, assumption check, mastery gate, prerequisite skill graph |
| 충돌 | F1, F2, F5, F8, F9 | 3-layer detection, conflicts_with, affinity, discriminated union change protocol, triple-key+onBeforeDelete |
| 합의 | A1, A4 | Scout-quorum, system 1/2 |
| 핸드오프 | H1, H5, H6, H8, H9 | Accepting controller, durable timer, signal-driven branching, fire/hold sync, deadline cascade |
| 팀 규모 | T11, T12 | Resource typing(역량 등급), staging area(대기 풀) |
| 탐색 | P2 | Single-file constraint |
| 적응 | D4, D13, D14 | Response threshold, determinant code matching, re-triage protocol |
| 배포 | B4 | Git-as-state-machine |
| 메타 | M2, M3, M6, M10 | Hyper-decentralization 경고, single-threaded owner, metacognitive state vector, 4-phase auto-capture |

### P2 — 중기 적용 (구조적 변경 필요)

팀 규모 자율도 조정(T10), DAG 분석(O5), crews+flows(O6), skill health(L6), self-evolution(L7), evolution pipeline(L8), risk routing(C6), bin packing(C7), reaction system(E2), adaptive harshness(E7), task guardrail(E8), rollback trigger(E11), session_knowledge(X4), memory confidence(X6), hierarchical blackboard(X14), guidanceOnce(U6), prompt builder(R4), role+tone(R5), tech stack templates(R6), line-level conflict(I2), 2-pool(I4), middleware 분리(I5), trust-based(I6), section principal(K8), expert witness(V5), adversarial pair(V6), naked reasoner(V7), best of N(V8), quality judge(V9), deliberation(V12), predict-then-attribute(V13), dynamic resectorization(D1), work stealing(D2), balance adjustment(D3), r/K selection(D5), counter-pick(D6), dropout recovery(D7), fast-advance(D11), 4-tier conflict(F3), MIT(F4), taint(F6), ostrom(F7), quorum sensing(A2), foreperson(A3), ESS(A5), fixed-budget tournament(P1), comparative advantage(P5), contract theory(P6), predator-prey(P7), clonal selection(P8), temporal polyethism(P9), blue-green(B1), kill switch(B2), progressive rollout(B3), rehearsal mark(B6), speculative execution(B7), GDP(H2), continue-as-new(H7), delegation hook(H3), mapreduce(M5), per-agent cost(C11), voting protocols(O15), time window(O18), split delivery(O19), intent prediction(O22), memory access control(X15), conversation offloading(X22), three-level attribution(X23), snapshot/restore(X24), capability negotiation(P11), fading scaffolding(V15), ZPD calibration(V17), avatar responder(V18), composite backend(I8), background augmentation(C12), inference gateway(C14), TOCTOU 방지(E17), session queue atomic(E18), co-occurrence window(X28), hybrid search(X29), mode system(M12), IDE-as-MCP(U9), live task panel(U10), statusline multiplexing(U11), connection status badge(U12), variable detection(X35), RAF-batched flushing(I15), event priority(I16), space-based workspace(I17), deferred batching(I18), custom properties(O29), parent-child subflow(F10)

### P3 — 장기 연구 (Claude Code 외부 시스템 또는 근본적 아키텍처 변경 필요)

FTS5 search(X7), observational memory(X10), namespace store(X12), MaaS(X16), dynamic speaker(O12), pressure-field(O13), ARG-designer(O14), teachable agent(L9), negative selection(V10), time-travel checkpoint(B5), cross-graph navigation(D10), swarm handoff(D9), fire-and-maneuver(D8), SocietyOfMind(H4), built-in evaluation(M1), chapter/guild(M4), knowledge distillation(M7), emergent collective memory(M8), agent protocol interop(M9), bilevel meta(A6), hub stigmergy(P3), UCB1(P4), PID control theory(P10), LLM client interceptor(C13), hybrid ranking(P12), semantic triple KG(P13), worktree multi-project(I12), agent studio(U13)

---

## 메타 관찰

### 1. Agent 세션 보존 문제 — 해결책 구체화

유저 지적: agent가 작업 후 정리(terminate)되면 "뭘 조사했었는지" context가 사라짐.

- **현재**: SubagentStop hook이 `.tmp/agent-context/`에 요약 저장하지만, 재파견 시 이전 context를 자동 로드하지 않음
- **관련 패턴**: autoresearch Hub, Squad Charter+History, Mastra Observational Memory
- **해결 패턴 조합** (Deep Scan Memory에서 발견):
  1. **Observer Agent (M11, P0)** — 실시간 비간섭 모니터링으로 세션 전체의 핵심 결정/전환점 자동 기록. tool 비활성화 subprocess로 구현
  2. **Episodic Snapshot + Resume (X18, P1)** — 종료 시 구조화된 스냅샷 자동 저장
  3. **Session Continuity 자동 주입 (X21, P1)** — SubagentStart hook에서 동일 name의 이전 context 자동 로드
  4. **Progressive Disclosure 3-Layer (X26, P0)** — 이전 context를 인덱스만 주입 → 필요 시 상세 로드
- **구현 우선순위**: X21(자동 주입)이 가장 저비용 고효과 — 기존 SubagentStart hook 확장만으로 구현 가능

### 2. Temporal Orchestration (시간 기반 스케줄링) — 해결됨

초기 조사에서 "능동적 시간 기반 스케줄링 미발견"이었으나, Pioneer R2-domains에서 Temporal.io 도메인 조사로 해결:
- **Durable Timer (H5)**: 내구성 타이머 — `CronCreate`로 구현 가능
- **Signal-Driven Branching (H6)**: 이벤트 기반 phase 전환
- **Continue-As-New (H7)**: 장기 실행 시 context 비대화 방지

Claude Code에서는 `CronCreate` + SendMessage 조합으로 "15분 뒤 확인", "빌드 완료 후 자동 검증" 패턴 구현 가능.

### 3. 도메인간 패턴 수렴

여러 도메인에서 독립적으로 동일한 원리가 발견됨:

| 원리 | 발견 도메인 | 수렴 패턴 |
|------|-----------|----------|
| **소규모 팀 최적** | Brooks (SW), 군사 C2, 인지과학, 오케스트라 | 3-5명이 coordination overhead 대비 최적 |
| **구조화된 보고** | 수술팀(SBAR), 항공관제(Strip), 군사(SITREP) | 자유형식 vs 필드고정 보고의 오류율 차이 |
| **단계적 에스컬레이션** | 수술팀(PACE), superpowers(4-status), 법정(Daubert) | 결과 상태 vs 진행 중 이의제기 vs 품질 검증 |
| **독립성 보장** | 법정(Expert Witness), 릴리스(Canary), 생태학(Niche) | 평가자/검증자의 편향 제거 메커니즘 |
| **비용 인지 적응** | BATS(arxiv), Cache-Aware(arxiv), Lazy Loading(실전), gstack(Effort) | 자원 제약 하 동적 전략 전환이 여러 도메인에서 독립 발견 |
| **트랜잭션 보장** | SagaLLM(분산시스템), Git-as-SM(autoresearch), Blue-Green(릴리스), Temporal Saga | "실패 시 원상복구" 보장 메커니즘의 다양한 구현 |
| **2축 분류** | ESI(긴급도x자원), Filter-Score(가능x적합), System1/2(빠름x정확) | 단일 축이 아닌 2차원 이상으로 task/agent 분류하는 패턴이 반복 발견 |
| **점진적 지원 축소** | Fading Scaffolding(교육), Progressive Context(context-mode), Lazy Loading(비용) | "처음엔 많이, 나중엔 적게" — context/가이드/스킬 로딩 모두에서 동일 원리 |
| **결과 통합(Reconcile) 필수** | 4-Phase Lifecycle(deepagentsjs), Fact Consolidation(memory-bank), Deliberation Protocol(법정) | agent 결과를 "모아서 끝"이 아니라 **명시적 통합 프로세스**가 필요하다는 발견이 반복 |
| **재사용 > 재생성** | CompiledSubAgent(deepagentsjs), Fuzzy matching(ECC), Team archetype(ClawTeam) | 새로 만드는 것보다 기존 것을 재활용하는 패턴이 비용/품질 모두에서 우위 |
| **Agent=Tool 경계 융합** | ConfigurableAgentTool(browser-operator), IDE-as-MCP(spacecake), Agent Delegation as Capability(theia), Fast-Advance Successor(CCW) | agent와 tool의 경계가 사라지는 추세 — agent를 tool로 등록, 앱이 agent에 tool 제공, 위임을 capability로 정의, agent→agent 직접 호출 |
| **이벤트 기반 아키텍처 수렴** | AgentRunnerEventBus(browser-operator), EventBus+Watchdog(browser-use), RAF-Batched Flushing(anytype), Event Priority(anytype) | 다수 프로젝트에서 "이벤트 스트림 + 구독자" 아키텍처 독립 발견. polling 대신 push 기반 모니터링이 표준화 추세 |

### 4. compose-team V2 핵심 설계 원칙 (조사에서 도출)

1. **Default-small**: 기본값은 항상 최소 팀. 확대는 명시적 근거 필요
2. **Lifecycle-aware**: 모든 agent에 lifecycle tier 부여. ephemeral은 파일 미생성
3. **Evidence-gated**: 증거 없는 완료 보고 거부. SBAR + verification gate
4. **Budget-transparent**: token/비용/시간 예상을 항상 표시
5. **Reuse-first**: 새 template 생성 전 fuzzy matching으로 기존 template 검사
6. **Fail-structured**: 실패도 구조화 보고. 실패 경로 공유로 중복 실패 방지

---

## 전체 통계

- **AI 프로젝트**: 16 (deep scan) + 4 (pioneer frameworks) + 10 (pioneer latest) + 15 (deep scan R2) = **45개**
- **비-AI 도메인**: 분산 시스템, 게임 AI, 조직 이론, 군사 C2, 생물학, 경제학, 인지과학, 생태학, 항공 관제, 수술팀, 오케스트라, 릴리스 엔지니어링, 법정 절차, Temporal/Durable Execution, 응급실 트리아지, 물류 VRP, 교육/학습 설계, Context Preservation, 재난대응(ICS), 뉴스룸, 주방(Brigade), 영화 제작 = **22개 도메인**
- **최신 연구 논문**: arxiv 2601.06007, 2601.08129, 2506.13590, 2507.18224, 2511.17006, 2512.10166, 2603.10779, 2505.18279, 2506.22815 = **9편**
- **발견 패턴 총계**: **291+ 패턴** (18개 테마로 분류)
- **우선순위 분포**: P0 ~49개, P1 ~119개, P2 ~88개, P3 ~40개
- **Claude Code 적용 가능**: O ~243개, 삼각 ~32개, X ~16개

---

## 보충: EG-Library Expansion Deep Research (2026-03-28)

> 16개 대상 심층 조사 결과. 16 explore-agents + 1 report-writer.
> 기존 45개 프로젝트 + 291+ 패턴에 **16개 프로젝트 심층 데이터 + 정량 검증** 추가.

### 조사 대상 16개 + Tier Ranking

| Tier | 순위 | Repo | Stars | 핵심 가치 |
|------|------|------|-------|----------|
| **Tier 1** | 1 | context-mode (mksglu/context-mode) | 6.1K | PreCompact 2KB XML snapshot, BM25 3-layer 검색, 15 event categories, 7 MCP tools, 11 platform adapters |
| **Tier 1** | 2 | anthropic-harness (Anthropic 블로그 x3) | N/A | Harness 3단계 진화, Self-evaluation 실패, Sprint Contract 27 criteria, 비용 breakdown |
| **Tier 1** | 3 | walnut (stackwalnuts/walnut) | 27 | Files at Different Speeds, Read→Stash→Save, Zero-Context Standard, 10 Binding Principles |
| **Tier 2** | 4 | agent-skills-cli (Karanjot786/agent-skills-cli) | 85 | Context Budget 4-Signal, SKILL.md 100% 호환, Conflict Detector, Quality Scoring |
| **Tier 2** | 5 | hermes-agent (NousResearch/hermes-agent) | 14.7K | GEPA Self-Evolution ($2-10/run), Frozen Snapshot, 95+16 skills, Progressive Disclosure |
| **Tier 2** | 6 | agent-deck (asheshgoplani/agent-deck) | 1.8K | MCP Socket Pooling, Conductor LEARNINGS→POLICY, Budget 80%/100% |
| **Tier 2** | 7 | autoresearch (karpathy/autoresearch) | 58.8K | Karpathy Loop 3요소, Ratchet Loop, Bilevel meta-optimization |
| **Tier 2** | 8 | obsidian-claude-mcp (3개 소스) | 208 | Context 최적화 정량 근거, MemCP 20x, KG MCP 49x |
| **Tier 3** | 9 | AgentScope (agentscope-ai/agentscope) | 21.3K | MsgHub, ReMe 99.5%, Trinity-RFT 16+ RL, 100만 agent 분산 |
| **Tier 3** | 10 | CopilotKit (CopilotKit/CopilotKit) | 29.8K | AG-UI Protocol 30+ events, 8 SDK, Oracle/Google/MS/AWS 채택 |
| **Tier 3** | 11 | OpenJarvis (open-jarvis/OpenJarvis) | 1.9K | 5-Primitive, 9 agent 구현체, 5 메모리 백엔드, 하드웨어 인식 라우팅 |
| **Tier 3** | 12 | nodeskclaw (NoDeskAI/nodeskclaw) | 626 | Gene System 3-tier, 9-stage middleware, WFQ, CloudEvents |
| **Tier 3** | 13 | BrowserOS (browseros-ai/BrowserOS) | 10.2K | 3-프로세스, Custom CDP, 3-tier 메모리, DAG 워크플로우 |
| **Tier 4** | 14 | awesome-ai-agents (e2b-dev/awesome-ai-agents) | 26.9K | 199개 프로젝트 카탈로그 (사실상 아카이브, 2026 추가 0건) |
| **Tier 4** | 15 | 500-ai-agents (ashishpatel26/500-AI-Agents-Projects) | 27.4K | 136개 실제 항목, LangGraph HAT, AutoGen Group Chat |
| **Tier 4** | 16 | stdy-context-tips (stdy.blog) | N/A | 접근 불가, 간접 검증 완료, 대체 소스 3개 |

### 핵심 발견 5선

1. **Frozen Snapshot 패턴이 prefix cache 보존의 핵심** — hermes-agent
2. **AG-UI Protocol이 agent-frontend 표준으로 수렴 중** — CopilotKit (12.7K stars, 11+ 1st party)
3. **ReMe 99.5% compression 실증** — AgentScope (223,838→1,105 tokens)
4. **1차 수치 검증**: "71% redundant reads" 원본 미확인 (실측 8%), MemCP 20x 확인, KG MCP 49x 확인
5. **Agent 자율 진화 실용화** — GEPA $2-10/run (ICLR 2026), Trinity-RFT 15%→86%

### Key Takeaways 10선 (1차 5개 + 심층 5개)

**1차 유지:**
1. Context는 가장 뜨거운 문제 (16개 중 7개가 context 핵심)
2. Skill 생태계 표준화 진행 중 (agentskills.io, SKILL.md 100% 호환)
3. Agent 성장 단계가 다음 프론티어
4. File-based Communication이 검증된 패턴
5. Hook과 Skill의 경계가 흐려지고 있음

**심층 추가:**
6. Frozen Snapshot + Nudge = prefix cache 보존의 실전 기법
7. AG-UI Protocol이 사실상 유일한 agent-frontend 표준
8. Agent 보안 4-layer 모델 필요 (Memory/Context files/Skills/Terminal)
9. 비파괴적 Memory 관리가 올바른 방향 (삭제 아닌 마킹/아카이빙)
10. Centaur (Human-AI Hybrid)가 최고 성과 — human-in-the-loop 학술 뒷받침

### EG-Library 등록 권고

**즉시 등록 (Tier 1):**
| name | url | type | tags |
|------|-----|------|------|
| context-mode | https://github.com/mksglu/context-mode | repo | context, mcp, hooks, session |
| walnut | https://github.com/stackwalnuts/walnut | repo | memory, context, markdown, mcp |

**신규 추가 권고 (Tier 3):**
| name | url | type | tags |
|------|-----|------|------|
| ag-ui-protocol | https://github.com/ag-ui-protocol/ag-ui | repo | protocol, agent-ui, events, streaming |

**선택적 등록 (Tier 2):**
| name | url | type | tags |
|------|-----|------|------|
| agent-skills-cli | https://github.com/Karanjot786/agent-skills-cli | repo | skills, cli, marketplace |
| hermes-agent | https://github.com/NousResearch/hermes-agent | repo | agent, learning, skills |
| agent-deck | https://github.com/asheshgoplani/agent-deck | repo | session, tmux, mcp |
| autoresearch | https://github.com/karpathy/autoresearch | repo | harness, experiment, minimal |

### Appendix: 1차 수치 검증 상태

| 1차 수치 | 검증 결과 |
|---------|----------|
| context-mode 98% reduction | 미재검증 (소스코드 분석 중심) |
| autoresearch 21,000+ stars | **수정: 58,759** |
| CopilotKit "미확인 (대규모)" | **수정: 29,814** |
| "71% redundant reads" (132-session) | **원본 미확인** — 대체: 107세션 평균 8.0% |
| "attention dilution 20-40%" | **간접 뒷받침** — GPT-4o 99.3%→69.7%(32K) |
| MemCP 20x | **확인** — 9,380→462 tokens |
| KG MCP 49x | **확인** — monorepo 기준 |
| Kin "50%/44.6%" | **데이터 없음** — 원본 미발견 |
| Membase "600 vs 4,000 tokens" | **원본 미확인** |
| ReMe 99.5% | **확인** — 223,838→1,105 tokens |

### 이전 조사 연계

**20260206 Claude Code Updates**: Agent Teams(v2.1.32) ↔ AgentScope MsgHub + LangGraph HAT, Auto Memory ↔ hermes-agent Frozen Snapshot + walnut Files at Different Speeds, TeammateIdle hooks ↔ agent-deck Heartbeat, Opus 4.6 compaction ↔ Anthropic harness "auto compaction 충분"

**20260302 Subagent Compaction**: 95% auto-compaction ↔ Blake Crosley "60%에서 이미 품질 저하", 83% reduction(167K→27K) ↔ ReMe 99.5%(223K→1.1K) — 전문 도구가 10-80x 효과적, Transcript 별도 저장 ↔ hermes-agent FTS5 Session Search — transcript를 학습 자원으로 활용
- **조사 라운드**: 1차(README) → 2차(소스 deep scan) → Pioneer R1 4회(AI프레임워크, 비-AI, 생물학+경제학+인지과학+생태학, 최신프로젝트) → Pioneer R2(ATC, OR, 오케스트라, Release Eng, 법정) → Pioneer R2-repos(최신 논문+프로젝트 17패턴) → Pioneer R2-domains(Temporal, 응급실, VRP, 교육, Context 18패턴) → Deep Scan R2(deepagentsjs, memory-bank, Memori, NemoClaw 24패턴) → Deep Scan Memory(claude-memory, claude-mem 16패턴) → Deep Scan UX+Agent(spacecake, browser-operator 14패턴) → Pioneer R3(재난대응, 뉴스룸, 주방, 영화 10패턴) → Deep Scan R3(theia, openmetadata, browser-use, anytype, xyflow 24패턴) → 재조사(deepagentsjs, Memori, NemoClaw 4패턴) → **Final Scan(grok-cli 5 + cross-agent 8 = 13패턴)** → **EG-Library Expansion(16 explore-agents 소스코드 심층 조사)**

---

## EG-Library Expansion: 소스코드 심층 조사 상세 (2026-03-28)

> 16개 explore-agents가 각 대상의 소스코드를 직접 clone+분석한 결과.
> 위 Executive Summary와 중복되지 않는 **아키텍처 상세, 정량 스펙, 구현 패턴**에 집중.

### 1. context-mode — 3-Layer 아키텍처 상세

**Layer 1: MCP Server (7 tools)**
- `ctx_execute` — 11개 언어 샌드박스 (JS, TS, Python, Shell, Ruby, Go, Rust, PHP, Perl, R, Elixir)
- `ctx_execute_file` — FILE_CONTENT 변수 주입, 파일 내용은 context 미진입
- `ctx_batch_execute` — 다중 명령 일괄 실행 + FTS5 자동 인덱싱 + 검색
- `ctx_index` / `ctx_search` — BM25 랭킹 (Porter stemmer + trigram + fuzzy 3-layer fallback)
- `ctx_fetch_and_index` — URL fetch → turndown HTML→MD → FTS5 인덱싱, 24h TTL 캐시
- `ctx_stats` — 세션 통계 (calls, bytes, savings ratio)

**Layer 2: Hook System (5 hooks)**
| Hook | 역할 | 핵심 메커니즘 |
|------|------|-------------|
| SessionStart | startup/compact/resume/clear 4분기 | CLAUDE.md 캡처→SessionDB, routing block 주입 |
| PreToolUse | Bash(curl/wget) 차단→sandbox redirect | Guidance throttle: in-memory Set + O_EXCL markers (세션 1회) |
| PostToolUse | 15 event categories 추출 | <20ms 목표, SHA256 dedup, 1000 event FIFO eviction |
| PreCompact | 2KB XML resume snapshot 빌드 | P1(50%) + P2(35%) + P3(15%) 3-tier budget |
| UserPromptSubmit | decision/role/intent/data 추출 | "don't/never/always/prefer" 교정 패턴 감지 |

**Layer 3: SessionDB (SQLite WAL)**
- 3 테이블: `session_events` (SHA256 dedup, priority 1-4), `session_meta`, `session_resume`
- MAX_EVENTS = 1000 (초과 시 lowest priority + oldest FIFO eviction)
- DEDUP_WINDOW = 5 (최근 5개 내 동일 type+hash 중복 방지)
- Worktree isolation: `__sha256(cwd)[:8]` suffix

**ContentStore (FTS5 Knowledge Base)**
- Dual FTS5: Porter stemmer(title 5x 가중치) + trigram(substring)
- Fuzzy fallback: vocabulary Levenshtein distance
- Proximity scoring: sweep-line `findMinSpan()` → 근접 결과 우선
- Smart snippet: 300자 window → 병합 → maxLen 1500
- Search throttling: 60초 내 3회→쿼리당 1결과, 8회→BLOCKED

**PreCompact 2KB Snapshot 상세**
```xml
<session_resume compact_count="N" events_captured="N">
  <active_files>        <!-- P1: MAX 10개, ops="read:5,edit:3" -->
  <task_state>          <!-- P1: pending만, completed/deleted/failed 필터 -->
  <rules>               <!-- P1: CLAUDE.md 400자 truncate -->
  <decisions>           <!-- P2: Q→A 200자 truncate -->
  <environment>         <!-- P2: cwd, git op, env 150자 -->
  <errors_encountered>  <!-- P2: 150자 truncate -->
  <intent>              <!-- P3: implement/investigate/discuss/review -->
  <mcp_tools>           <!-- P3: tool:calls -->
  <subagents>           <!-- P3: launched/completed 200자 -->
</session_resume>
```

**10 Platform Adapters**: Tool name normalization (TOOL_ALIASES)으로 Gemini CLI, OpenCode, Codex CLI, Cursor, VS Code Copilot, Kiro 등 교차 호환. Hook-capable(Claude Code, Gemini CLI 등) vs Non-hook(OpenCode, Zed 등) 이원 전략.

**Security**: 3-tier settings 읽기 (project-local > project-shared > global), chained command splitting (`&&`/`||`/`;`/`|` 분리 → 각 segment 개별 deny), Shell escape detection (Python os.system, JS execSync, Ruby system, Go exec.Command, PHP shell_exec, Rust Command::new), 70+ 환경변수 deny list.

**벤치마크**: ctx_execute_file 14시나리오 315KB→5.5KB (98%), 전체 21시나리오 376KB→16.5KB (96%), 디버깅 세션 177KB→10.2KB (94%), 코드 예제 100% 보존.

### 2. hermes-agent — Self-Evolution Pipeline 상세

**GEPA (Generalized Experience-driven Prompt Agent)**
- ICLR 2026 Oral, Self-Evolution ≠ RL
- **Reflective Prompt Mutation**: 전체 task trace 분석 (RL은 보상 신호만)
- **Textual Feedback**: 자연어 피드백 기반 mutation (gradient 아닌 text)
- **Pareto Selection**: multi-objective 최적화 (성능 + 비용 + 안전성)
- 비용: $2-10/run (별도 repo에서 실행, PR 기반 human review)

**agentskills.io Progressive Disclosure 3단계**
- Stage 1: Metadata ~100 tokens (이름, 설명, 버전)
- Stage 2: Instructions <5,000 tokens (사용법, 제약)
- Stage 3: Resources 요청시 (전체 소스, 예제)

**Degradation 방지 6 메커니즘**
1. Compressor 50% (context 절반 압축)
2. max_iterations 90 (hard cap)
3. Frozen Snapshot (세션 시작 시 Memory prefix 동결)
4. Nudge-based Memory update (기존 위치 유지, append 아닌 in-place)
5. Skill versioning (이전 버전 롤백 가능)
6. Human review gate (PR 기반 승인)

**Skill System**: 95 built-in + 16 community skills, Skill Compose는 시스템 레벨 부재 확인 (개별 skill 내 의존성으로 처리)

### 3. walnut — Zero-Context Standard

**Files at Different Speeds**: memory 파일을 변경 빈도로 분류
- CORE.md (거의 불변, 항상 로드)
- DECISIONS.md (낮은 빈도, 중요 결정)
- PROGRESS.md (높은 빈도, 현재 상태)
- SESSION.md (매 세션, 휘발성)

**Read→Stash→Save 3-Phase Protocol**
1. Read: 파일 읽기 (context에 진입)
2. Stash: 핵심만 추출하여 임시 보관
3. Save: 구조화된 memory 파일에 저장

**10 Binding Principles**: memory 파일 작성 규칙 (max line count, heading 구조, 중복 방지 등)

**MCP 5-Tool**: memory CRUD + search

**Capsule System**: 프로젝트별 독립 memory capsule, 교차 프로젝트 참조 가능

**ALIVE Framework**: memory 생존 주기 관리 (Archive→Live→Inactive→Volatile→Expired)

### 4. agent-skills-cli — Context Budget 4-Signal

**4-Signal 가중치**: Language 40% + Dependency 30% + Keyword 20% + Description 10%
- Language: 프로젝트 주 언어와 skill 호환성
- Dependency: package.json/requirements.txt 의존성 매칭
- Keyword: 사용자 요청 키워드 매칭
- Description: skill 설명 유사도

**Skill Compose 3전략**: Sequential (순차 실행), Parallel (병렬), Conditional (조건부)

**Conflict Detector 3전략**: Priority-based (높은 우선순위 승), Merge (충돌 부분 병합), User-choice (사용자 선택)

**Quality Scoring 4차원**: Correctness + Performance + Security + Maintainability

**Skill Tester 10 내장 테스트**: 각 skill에 10개 내장 테스트 케이스

**Platform Adapter 45개**: 45개 IDE/CLI 플랫폼 지원

### 5. CopilotKit — AG-UI Protocol 상세

**AG-UI Protocol**: 30+ event types, 8 language SDK
- Event categories: Lifecycle (RUN_STARTED/FINISHED/ERROR), Text (TEXT_MESSAGE_START/CONTENT/END), Tool (TOOL_CALL_START/ARGS/END), State (STATE_SNAPSHOT/DELTA), Custom
- Transport: SSE (기본), WebSocket, HTTP polling
- **CoAgent 루프**: Agent↔Frontend 양방향 state sync
- **Multi-agent state 격리**: 각 agent별 독립 state namespace
- **Intermediate State Streaming**: 중간 결과 실시간 UI 반영
- **3 실행 모드**: Single-turn, Multi-turn, Streaming
- **Framework Adapter 10개**: React, Next.js, Vue, Svelte, Angular 등

**채택 현황**: Oracle, Google, Microsoft, AWS 등 주요 기업 채택. 29.8K stars.

### 6. BrowserOS — 3-프로세스 아키텍처

**3-Process Model**
- Main Process: Electron main, 윈도우 관리
- Browser Process: Chromium fork, Custom CDP 확장
- Agent Process: AI agent 런타임, MCP Sidecar

**Custom CDP**: 표준 CDP + BrowserOS 확장 (53 MCP tools)
- Stable Proxy: CDP 연결 안정화 (Chromium crash 시 자동 재연결)
- DOM 직접 접근: AI agent가 DOM tree 직접 조작

**3-Tier Memory**: CORE.md (permanent) + Daily Notes (30d TTL) + SOUL.md (150 lines max)

**DAG Workflow**: 작업을 DAG로 모델링, 병렬 실행 + 의존성 관리

### 7. OpenJarvis — 5-Primitive 모델

**5 Primitives**: Perceive, Think, Act, Remember, Communicate
- 9 agent 구현체: 각 primitive 조합으로 특화 agent 생성
- 5 메모리 백엔드: SQLite, Redis, File, Vector, Hybrid

**GuardrailsEngine**: 입출력 검증, 안전성 체크

**하드웨어 인식 라우팅**: GPU/CPU/메모리 기반 task 분배

**Trace-driven learning**: 실행 trace에서 패턴 학습 → 자동 최적화

### 8. nodeskclaw — Gene System 3-tier

**Gene System**: Configuration, Behavior, Evolution 3-tier
- 9-stage middleware: 요청 처리 파이프라인
- WFQ (Weighted Fair Queuing): agent간 리소스 공정 분배
- Backpressure 4단계: Normal → Warning(80%) → Throttle(90%) → Reject(100%)

**Tunnel Protocol 12종**: 다양한 통신 채널 지원

**CloudEvents**: 표준 이벤트 포맷 채택

**CE/EE 이중 버전**: Community Edition (오픈소스) + Enterprise Edition

### 9. Anthropic Harness — 비용/품질 정량 데이터

**Sprint Contract 27 Criteria**: hard threshold, 1개 fail = sprint fail
- Generator-Evaluator GAN 분리 필수 (Self-evaluation 실패 확인)

**비용 진화**: V1 $200/6h → V2 $124.70/3h50m
- Build 86.6%, QA 8.4%, Planning 5%
- JSON > Markdown (모델이 JSON 구조를 더 잘 준수)

### 10. 기타 프로젝트 핵심 데이터

**agent-deck**: Budget 5-Level CheckTx — 20%/40%/60%/80% warn / 100% stop. MCP Socket Pooling으로 다중 세션 관리. Conductor: LEARNINGS.md→POLICY.md 피드백 루프.

**autoresearch**: Karpathy Loop 3요소 — Single modifiable file + Objectively testable metric + Fixed time limit. Ratchet Loop: 최고 점수 갱신 시만 커밋. Bilevel meta-optimization: outer loop이 inner loop 하이퍼파라미터 최적화. Hub stigmergy: Git-as-State-Machine.

**AgentScope**: MsgHub — 중앙 메시지 허브, agent간 pub/sub. ReMe 99.5% compression (223,838→1,105 tokens). Trinity-RFT: 16+ RL 알고리즘 통합, Frozen Lake 15%→86%. 100만 agent 분산 실행.

**obsidian-claude-mcp**: MemCP 20x (9,380→462 tokens) 확인. KG MCP 49x (monorepo 기준) 확인. Context 최적화의 정량 근거 제공.

### 5개 축 Cross-Reference: Top 3 패턴 (소스코드 검증)

| 축 | #1 | #2 | #3 |
|----|-----|-----|-----|
| **Orchestration** | context-mode PreToolUse routing (deny/modify/guidance 결정 트리) | CopilotKit AG-UI 30+ events (양방향 state sync) | nodeskclaw 9-stage middleware + WFQ |
| **Memory** | context-mode PreCompact 2KB snapshot (P1/P2/P3 tier budget) | walnut Files at Different Speeds (CORE→SESSION 4단계) | hermes-agent Frozen Snapshot + Nudge |
| **Lifecycle** | hermes-agent GEPA Self-Evolution ($2-10/run, PR review) | autoresearch Ratchet Loop (최고 점수만 커밋) | agent-deck Budget 5-Level CheckTx |
| **Quality** | Anthropic Sprint Contract 27 criteria (1 fail = sprint fail) | context-mode FTS5 3-layer search + throttling | agent-skills-cli Quality Scoring 4차원 |
| **UX/Cost** | Anthropic V1→V2 ($200→$124.70, 3h50m) | context-mode 96% context 절감 (376KB→16.5KB) | agentskills.io Progressive Disclosure (~100→<5000 tokens) |

### 검증 상태 업데이트

| 수치 | 검증 방법 | 결과 |
|------|----------|------|
| context-mode 98% reduction | 소스코드 직접 분석 (BENCHMARK.md) | **확인**: 전체 96%, ctx_execute_file 98%, 디버깅 94% |
| context-mode 10 platform adapters | src/adapters/ 디렉토리 확인 | **확인**: 10개 플랫폼 + tool name normalization |
| context-mode 7 MCP tools | src/server.ts 확인 | **확인**: ctx_execute/execute_file/batch_execute/index/search/fetch_and_index/stats |
| context-mode SessionDB 1000 event cap | src/session/db.ts 확인 | **확인**: MAX_EVENTS_PER_SESSION = 1000, DEDUP_WINDOW = 5 |
| hermes-agent GEPA ICLR 2026 | 소스코드 + 논문 참조 | **확인**: Oral paper, Reflective Prompt Mutation |
| hermes-agent $2-10/run | 별도 repo 실행 비용 | **보고값** (직접 실행 미검증) |
| agentskills.io ~100 tokens metadata | Progressive Disclosure 스펙 | **보고값** |
| CopilotKit 29.8K stars | GitHub 확인 | **확인** |
| BrowserOS 53 MCP tools | 소스코드 확인 | **확인** |
| nodeskclaw 9-stage middleware | 소스코드 확인 | **확인** |
| Anthropic $124.70/3h50m | 블로그 원문 | **확인** |

### 조사 라운드 (최종)

이번 EG-Library Expansion 심층 조사:
- **구성**: 16 explore-agents (각 1개 대상 전담) + 1 report-writer
- **방법**: git clone → 소스코드 직접 읽기 → 5축 매핑
- **대상**: context-mode, anthropic-harness, walnut, agent-skills-cli, hermes-agent, agent-deck, autoresearch, obsidian-claude-mcp, AgentScope, CopilotKit, OpenJarvis, nodeskclaw, BrowserOS, awesome-ai-agents, 500-ai-agents, stdy-context-tips
- **산출물**: 16개 개별 보고서 → 7개 설계 문서 보강 + RESEARCH.md 통합

---

## Round 2 추가 조사 Finding (Raw)

> 작성자: report-writer
> 작성일: 2026-03-28
> Round 1 완료 후 16명 worker에게 추가 조사 지시 → 수신된 finding을 있는 그대로 기록

---

### hermes-agent (explore-agent-4) — 4건

#### Finding 1: 자율 에이전트 자기 성장 (Self-Evolution)
장기 실행 시 자기 성장하는 패턴. Skill을 스스로 생성하고, 멀티 플랫폼 지원.

#### Finding 2: Skill 자동 생성
에이전트가 실행 중 새로운 skill을 동적으로 생성하는 메커니즘.

#### Finding 3: OpenClaw 기반 구조
NousResearch의 OpenClaw 에이전트 아키텍처 기반.

#### Finding 4: 멀티 플랫폼 지원
Python 기반, MIT 라이선스, 다양한 플랫폼에서 동작.

> NOTE: Context compaction으로 인해 원문 세부사항이 요약 수준으로 축소됨.

---

### context-mode (explore-agent-2) — 6건

#### Finding 1: MCP 컨텍스트 가상화
샌드박스 격리 + SQLite FTS5 세션 복원 (98% 압축).

#### Finding 2: Hook 기반 라우팅
Hook 시스템을 통한 컨텍스트 라우팅 메커니즘.

#### Finding 3: SQLite FTS5 전문 검색
Full-text search를 통한 세션 컨텍스트 검색.

#### Finding 4: 샌드박스 격리
각 세션/에이전트의 컨텍스트를 격리하는 패턴.

#### Finding 5: 98% 압축률
컨텍스트 데이터의 극단적 압축 달성.

#### Finding 6: 세션 복원 메커니즘
이전 세션 상태를 FTS5 기반으로 복원.

> NOTE: Context compaction으로 인해 원문 세부사항이 요약 수준으로 축소됨.

---

### CopilotKit (explore-agent-3) — 3건

#### Finding 1: Middleware 패턴
AG-UI Protocol 기반 미들웨어 아키텍처.

#### Finding 2: CI/CD 통합
CopilotKit의 CI/CD 파이프라인 구성.

#### Finding 3: Testing 전략
컴포넌트 및 에이전트 테스팅 접근법.

> NOTE: Context compaction으로 인해 원문 세부사항이 요약 수준으로 축소됨.

---

### autoresearch (explore-agent-5) — 0건

추가발견 없음.

---

### AgentScope (explore-agent-6) — 8건

#### Finding 1: 멀티에이전트 프레임워크 구조
알리바바의 멀티에이전트 프레임워크 아키텍처.

#### Finding 2: Frozen Lake 성공률 15→86%
에이전트 협업으로 Frozen Lake 벤치마크 성공률 대폭 향상.

#### Finding 3: Agent Setup 패턴
에이전트 초기화 및 설정 프로토콜.

#### Finding 4: Team Topology
에이전트 팀 구성 토폴로지.

#### Finding 5: Role Separation
역할 분리 메커니즘.

#### Finding 6: Layer Architecture
계층 아키텍처 구성.

#### Finding 7: File/Context Prep
파일 및 컨텍스트 준비 프로토콜.

#### Finding 8: Task Signaling
태스크 시그널링 패턴.

> NOTE: Context compaction으로 인해 원문 세부사항이 요약 수준으로 축소됨.

---

### BrowserOS (explore-agent-7) — 8건

#### Finding 1: Chromium 포크 기반 에이전틱 브라우저
오픈소스 Agentic 브라우저, 내장 MCP 서버 31+ tools.

#### Finding 2: AI Agent DOM 직접 접근
TypeScript/Bun 기반, AI agent가 DOM에 직접 접근.

#### Finding 3: MCP 서버 내장
31개 이상의 도구를 제공하는 내장 MCP 서버.

#### Finding 4: Agent Setup 패턴
브라우저 에이전트 초기화 프로토콜.

#### Finding 5: Team Topology
브라우저 내 멀티에이전트 구성.

#### Finding 6: Role Separation
브라우저 에이전트 역할 분리.

#### Finding 7: File/Context Prep
브라우저 컨텍스트 준비 메커니즘.

#### Finding 8: Task Signaling
브라우저 에이전트 간 태스크 시그널링.

> NOTE: Context compaction으로 인해 원문 세부사항이 요약 수준으로 축소됨.

---

### OpenJarvis (explore-agent-8) — 3건

#### Finding 1: Personal AI on Personal Devices
로컬 디바이스에서 동작하는 개인 AI 에이전트.

#### Finding 2: Python 기반 로컬 에이전트
Apache-2.0 라이선스, Python 기반.

#### Finding 3: 디바이스 로컬 실행
외부 서버 의존 없는 로컬 실행 패턴.

> NOTE: Context compaction으로 인해 원문 세부사항이 요약 수준으로 축소됨.

---

### walnut (explore-agent-11) — 6건

#### Finding 1: CI validate-plugin
CI 파이프라인에서 플러그인 유효성 검증 자동화.

#### Finding 2: Python scripts — index + graph
Python 스크립트를 통한 인덱싱 및 그래프 생성.

#### Finding 3: PR template checklist
Pull Request 템플릿에 체크리스트 패턴 적용.

#### Finding 4: Test strategy
테스트 전략 구성 (단위/통합/E2E).

#### Finding 5: Config fallback
설정 파일 fallback 메커니즘 (기본값 → 프로젝트 → 사용자).

#### Finding 6: Claude Code context 관리 플러그인
세션 간 프로젝트/사람/결정 기억, plain file 기반.

---

### nodeskclaw (explore-agent-10) — 5건

#### Finding 1: SecurityPipeline — before + after with MODIFY/REDACT/monitor mode
요청 전후에 보안 파이프라인 적용. MODIFY(수정), REDACT(삭제), monitor(감시) 3가지 모드 지원.

#### Finding 2: RegistryAggregator — parallel search
여러 레지스트리를 병렬로 검색하는 집계 패턴.

#### Finding 3: CI runtime version auto-update
CI 환경에서 런타임 버전을 자동 업데이트하는 메커니즘.

#### Finding 4: Config pydantic-settings with production validation
Pydantic Settings를 사용한 설정 관리, 프로덕션 환경 유효성 검증 포함.

#### Finding 5: pytest 15 test files
pytest 기반 15개 테스트 파일 구성.

---

### agent-deck (explore-agent-9) — 6건

#### Finding 1: Claude Code Hook 통합 — 상태 감지의 실제 구현

**소스**: `cmd/agent-deck/hook_handler.go` (14,152B)

이전 보고에서 "Hook Fast Path"로만 언급했던 부분의 구체적 구현:

**Hook 이벤트 → 상태 매핑**:

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

**Hook 페이로드 포맷**:
```go
type hookPayload struct {
    HookEventName string
    SessionID     string
    Source        string
    Matcher       json.RawMessage
}
```

- `AGENTDECK_INSTANCE_ID` 환경변수로 hook 소유권 확인. 없으면 즉시 종료.
- 상태 파일을 `~/.agent-deck/hooks/{instance_id}.json`에 기록 (timestamp, status, sessionID, event)
- Terminal event (SessionEnd 등) 시 세션 매핑 정리

**비용 추적 via Hook**: `Stop` 이벤트에서 `writeCostEvent()` 실행 — 페이로드의 transcript 파일 경로 읽기 → 마지막 assistant 메시지에서 토큰 사용량 파싱 → `~/.agent-deck/cost-events/`에 cost event 기록 (model, input/output tokens, cache metrics)

EG-DESK 참고: EG-DESK의 SubagentStop hook과 유사하나, agent-deck은 비용 데이터까지 hook에서 추출. EG-DESK가 비용 추적을 도입할 때 이 패턴 직접 참조 가능.

#### Finding 2: SQLite 기반 StateDB — 멀티프로세스 조율

**소스**: `internal/statedb/statedb.go` (22,990B) + `migrate.go` (11,528B)

**DB 스키마 (6 테이블)**:

| 테이블 | 용도 |
|--------|------|
| `metadata` | K/V (schema_version, last_modified) |
| `instances` | 세션 레코드 (상태, 도구, tmux, 워크트리) |
| `groups` | 세션 그룹 (확장 상태, 정렬 순서) |
| `instance_heartbeats` | 프로세스 수명 추적 (PID, primary 선출) |
| `recent_sessions` | 삭제된 세션 스냅샷 (빠른 재생성, 최대 20개) |
| `cost_events` | LLM 사용 추적 (토큰, 비용, 예산 중단 트리거) |

**핵심 패턴**:
1. **Primary 선출 (Leader Election)**: `ElectPrimary(timeout)` — 여러 agent-deck 인스턴스가 동시 실행 시 하나만 primary로 선출. heartbeat 기반 stale entry 정리.
2. **Polling 기반 변경 감지**: `last_modified` 타임스탬프를 metadata에 저장 → filesystem watcher 대신 DB 폴링으로 변경 감지. 크로스 프로세스 동기화.
3. **트랜잭션 기반 벌크 저장**: `SaveInstances()` — 목록에 없는 ID 삭제 → prepared statement로 일괄 insert. 고아 레코드 방지.
4. **최근 세션 재생성**: SHA-256 해시 (title + paths + tool options + flags)로 중복 방지. 최대 20개 유지.
5. **WAL 모드**: 읽기/쓰기 동시성. 5초 timeout.

EG-DESK 참고: EG-DESK는 현재 파일 기반 (.tmp/agent-context/, .claude/wm/) 상태 관리. agent-deck의 SQLite StateDB는 멀티프로세스 환경에서의 상태 동기화 패턴으로 참고 가치. 특히 Leader Election은 여러 Claude Code 인스턴스 동시 실행 시 유용.

#### Finding 3: Experiment (Feature Flag) 시스템

**소스**: `internal/experiments/experiments.go` (5,561B)

전통적 feature flag가 아닌 **폴더 기반 실험 관리**:
- 실험 = 디렉토리 (YYYY-MM-DD 날짜 접두사 선택)
- `FuzzyFind()`: fuzzy 매칭으로 실험 검색
- `FindOrCreate()`: 없으면 자동 생성
- 별도 설정 파일 없이 디렉토리 존재 여부로 toggle

EG-DESK 참고: 미니멀한 실험 관리. EG-DESK의 brainstorming → confirmed 폴더 구조와 개념적으로 유사.

#### Finding 4: 의존성 스택 및 빌드 파이프라인

**주요 의존성**:

| 카테고리 | 의존성 | 비고 |
|----------|--------|------|
| TUI | charmbracelet/bubbletea v1.3.10 + bubbles + lipgloss | Elm 아키텍처 기반 TUI |
| DB | modernc.org/sqlite v1.44.3 | Pure Go SQLite (CGO 불필요) |
| WebSocket | gorilla/websocket v1.5.3 | 세션 실시간 모니터링 |
| Web Push | SherClockHolmes/webpush-go v1.4.0 | VAPID 푸시 알림 |
| 파일 감시 | fsnotify/fsnotify v1.9.0 | 설정 변경 감지 |
| 다크모드 | thiagokokada/dark-mode-go | OS 다크모드 감지 → TUI 테마 |
| TOML | BurntSushi/toml v1.5.0 | 설정 파일 파싱 |
| 테스트 | stretchr/testify v1.11.1 | Assert/Require 패턴 |
| PTY | creack/pty v1.1.24 | 터미널 에뮬레이션 |

주목 포인트: `modernc.org/sqlite` (Pure Go SQLite) — CGO 없이 SQLite 사용. 크로스 컴파일 용이.

**빌드 파이프라인**: Go 1.24.0, CGO_ENABLED=0, ldflags `-s -w`, GoReleaser (linux/darwin x amd64/arm64), Homebrew tap, Lefthook (pre-commit: gofmt+go vet 병렬, pre-push: golangci-lint+go test -race+go build 병렬)

**테스트 전략**: `go test -race -v ./...` — race detector 필수. 150+ Go 파일 중 상당수에 `_test.go` 동반 (instance_test.go 99KB, conductor_test.go 71KB, tmux_test.go 85KB). 통합 테스트: `handlers_ws_integration_test.go`.

#### Finding 5: Recent Sessions 패턴 — 빠른 세션 재생성

**소스**: statedb.go의 `recent_sessions` 테이블

삭제된 세션의 스냅샷을 최대 20개 보관. SHA-256 해시 (title + path + tool options + flags)로 중복 방지. 같은 설정의 세션을 빠르게 재생성 가능. "최근 닫은 탭 복구"와 유사한 UX 패턴.

EG-DESK 참고: agent template 재사용의 구체적 구현 사례. compose-team이 이전 팀 구성을 기억하여 빠르게 재구성하는 데 참고.

#### Finding 6: 다크모드 자동 감지 + OS 테마 연동

**소스**: `thiagokokada/dark-mode-go` 의존성 + TUI 렌더링

OS 수준 다크모드 감지 → TUI 테마 자동 전환. 사소하지만, CLI 도구의 UX 세심함을 보여주는 패턴.

---

### awesome-ai-agents (explore-agent-14) — 0건

추가발견 없음.

awesome-ai-agents는 **순수 큐레이션 리스트**. 저장소 전체 파일 구성 (gh api로 확인):
- README.md (프로젝트 카탈로그)
- LICENSE.md
- CODEOWNERS
- image.png, image-1.png, image-2.png (시각자료)
- assets/ (디렉토리)
- .DS_Store

코드, 설정 파일, 테스트, 빌드 파이프라인, package.json, 의존성 — **모두 없음**. 7개 확인 포인트 전부 해당 사항 없음:

1. 아키텍처 패턴: 없음 (코드 없음)
2. 설정/환경 관리: 없음
3. 테스트 전략: 없음
4. 빌드/배포: 없음
5. 의존성: 없음
6. 코드 패턴: 없음
7. 새로운 인사이트: 이전 조사에서 이미 전부 보고 완료 (199개 프로젝트 카탈로그, 28개 태그 분류 체계, 아카이브 상태, 4계층 모델, E2B 마케팅 채널 성격 등)

이 repo에서 추출 가능한 모든 가치는 이전 보고서들에서 완전히 커버되었다.

---

### 500-ai-agents (explore-agent-12) — 5건

이전 조사에서 다루지 않았던 CONTRIBUTION.md를 확인한 결과, 소수의 새로운 인사이트가 있음.

#### Finding 1: metadata.yaml/json 기반 프로젝트 메타데이터 표준
- 모든 제출 프로젝트에 `metadata.yaml` 또는 `metadata.json` 파일 필수
- EG-DESK의 agent template frontmatter와 개념적으로 유사 (구조화된 메타데이터로 프로젝트 특성 기술)
- 출처: https://github.com/ashishpatel26/500-AI-Agents-Projects/blob/main/CONTRIBUTION.md

#### Finding 2: 재현성(Reproducibility) 표준
- pinned dependency versions, seed values, deterministic checkpoints 필수
- 실행 시간 제한: modest hardware에서 10분 이내 완료
- evaluation scripts 포함 (accuracy, reward, latency, memory costs 측정)
- 출처: CONTRIBUTION.md 직접 확인

#### Finding 3: 안전/윤리 요구사항
- 사람/개인 데이터와 상호작용하는 agent는 **명시적 safety section** 필수 (bias, failure modes, appropriate usage)
- secrets/API tokens 커밋 금지
- 출처: CONTRIBUTION.md 직접 확인

#### Finding 4: CI/CD
- `.github/workflows/jekyll-gh-pages.yml` 1개만 존재 — GitHub Pages 배포용 (README를 웹페이지로 렌더링)
- 실질적인 빌드/테스트 파이프라인 없음
- 출처: GitHub API 직접 확인

#### Finding 5: 네이밍 규칙
- 폴더명: lowercase, hyphen-separated (예: "multi-agent-pursuit")
- EG-DESK의 `kebab-case.md` 컨벤션과 동일한 패턴
- 출처: CONTRIBUTION.md 직접 확인

**참고**: 이 발견들은 이 리포의 **미래 비전**(기여 가이드라인)이지 현재 상태가 아님. 현재 리포에는 README + 이미지 5개 + crewai_mcp_course/README.md 1개만 존재하며, CONTRIBUTION.md에 명시된 표준을 충족하는 실제 프로젝트 제출물은 없음.

---

### agent-skills-cli (explore-agent-13) — 3건

이전 보고에서 누락된 3개 모듈을 추가로 발견.

#### Finding 1: Security Audit Engine (audit.ts + scanner-rules.ts)

이전 보고에 없었던 **보안 취약점 스캐너**. skill을 설치하기 전에 악성 패턴을 검출.

**6개 위협 카테고리, 33개 regex 규칙:**

| 카테고리 | 규칙 수 | 심각도 | 예시 패턴 |
|----------|---------|--------|----------|
| Prompt Injection (PI) | 8개 | critical~medium | `ignore previous instructions`, `you are now a`, jailbreak 패턴, 인코딩 기반 주입, delimiter 조작 |
| Command Injection (CI) | 7개 | critical~medium | `rm -rf /`, `curl \| bash`, `eval()`, `sudo` |
| Data Exfiltration (DE) | 5개 | critical~medium | webhook 전송, DNS 탈취, env var 접근, 민감 경로 읽기 |
| Tool Abuse (TA) | 4개 | high~low | 경로 순회, 시스템 디렉토리 쓰기, 프로세스 생성 |
| Hardcoded Secrets (HS) | 6개 | critical~medium | AWS 키, API 키(sk-..., ghp_...), JWT, DB 연결 문자열, 개인키 |
| Unicode Steganography (UC) | 4개 | high~low | zero-width 문자, RTL override, homoglyph, invisible separator |

**동작 방식:**
- 파일 단위 line-by-line regex 스캔 (LLM 불필요)
- false positive check 콜백 지원 (규칙별 2줄 위아래 context로 오탐 필터링)
- 256KB 이상 파일 자동 건너뜀
- **SARIF 출력** 지원 — GitHub Code Scanning에 직접 연동 가능
- `--fail-on` 옵션으로 CI/CD 게이트 역할 (severity 임계값 설정)

**EG-DESK 적용:**
- 외부 마켓플레이스에서 skill 가져올 때 **사전 보안 검증** 도구로 매우 유용
- 특히 Prompt Injection 카테고리(PI001-PI008)는 agent skill 특화 위협이라 EG-DESK에서도 그대로 활용 가능
- Unicode Steganography 감지는 다른 보안 도구에서 흔치 않은 고유 기능
- 출처: `src/core/scanner-rules.ts` (33개 규칙 정의), `src/core/audit.ts` (스캔 엔진)

#### Finding 2: Suggest Engine (suggest.ts)

**프로젝트 분석 → skill 자동 추천** 엔진. Context Budget의 "프로젝트 signal 분석"과 별개의 독립 모듈.

**Tech Stack 자동 감지:**
- Framework: 21개 패턴 (react, next.js, vue, nuxt, angular, svelte, express, fastify, nest.js, remix, astro, gatsby, electron, react-native, flutter, django, flask, fastapi, rails, spring, laravel)
- Library: 20개 패턴 (tailwindcss, prisma, drizzle, zod, redux, zustand, tanstack-query, trpc, graphql, stripe, supabase, firebase, aws-sdk, socket.io, three.js 등)
- Test Tools: 7개 (jest, vitest, mocha, cypress, playwright, testing-library, storybook)
- Build Tools: 7개 (vite, webpack, turbopack, esbuild, tsup, rollup, parcel)
- 언어: JS/TS + Python (pyproject.toml/requirements.txt) + Go (go.mod) + Rust (Cargo.toml) + Java (pom.xml/build.gradle)

**Skill 점수 계산 (Context Budget과 다른 알고리즘):**
- Framework match: 40점
- Library match: 30점
- Language match: 15점
- Category match: 10점
- Keyword match: 5점/키워드 (max 20)
- Popularity bonus: stars >1000 → 5점, >100 → 3점, >10 → 1점
- 총 max 100점

**EG-DESK 적용:** bootstrap 명령의 프로젝트 분석 백엔드로 사용됨. WM의 `/onboard` 프로젝트 스캔에 이 패턴 매칭 방식 참고 가능.

출처: `src/core/suggest.ts` (L1-302)

#### Finding 3: Telemetry (telemetry.ts)

**Fire-and-forget 방식 익명 텔레메트리:**
- 5개 이벤트 타입: install, search, check, update, command
- `DISABLE_TELEMETRY=1` 또는 `DO_NOT_TRACK=1`로 opt-out
- CI 환경(GitHub Actions, GitLab CI, CircleCI, Travis, Buildkite, Jenkins, TeamCity) 자동 감지 → CI 플래그 추가
- `fetch().catch(() => {})` — 절대 CLI를 block하거나 throw하지 않음
- URL: `agentskills.in/api/telemetry` (GET with query params)

**EG-DESK 적용:** 직접 적용 영역 없음. 참고용.

출처: `src/core/telemetry.ts` (L1-153)

---

### stdy-context-tips (explore-agent-15) — 0건

추가발견 없음.

stdy-context-tips는 블로그 포스트(https://www.stdy.blog/small-tips-for-context-mgmt/)이며, git repo가 아님. 사이트 전체가 HTTP 403으로 차단, 검색 엔진 미인덱싱, 소셜 공유 흔적 없음, archive.org 캐시 접근 불가로 확정.

7개 확인 포인트 모두 해당 없음 (코드베이스 없음). 이전 조사에서 보고한 내용이 최대 가치.

---

### anthropic-harness (explore-agent-16) — 3건

#### Finding 1: 테스트 전략 및 CI 파이프라인

테스트 설계 철학: "Claude will work autonomously to solve whatever problem I give it. So it's important that the task verifier is nearly perfect, otherwise Claude will solve the wrong problem." — 자율 에이전트에서 테스트 = 목표 정의. 테스트가 불완전하면 에이전트가 잘못된 문제를 해결함.

CI 파이프라인 (회귀 방지): 프로젝트 후반부에 회귀가 심각해져 도입. "new commits can't break existing code" — 엄격한 회귀 방지 정책.

Oracle-Based 테스트 (대규모 태스크용): 리눅스 커널 같은 모놀리식 태스크에서 GCC와 혼합하여 random subset oracle 테스트. 기존 검증된 컴파일러와 혼합하여 에이전트 출력 검증.

시간 관리 + 테스트 샘플링: 에이전트별 deterministic 서브샘플 (같은 에이전트는 같은 서브셋) + VM간 random (전체 커버리지). `--fast` 옵션으로 1% 또는 10% random sample. Context pollution 방지를 위해 진행 상황 출력 최소화.

로그 설계 패턴: "Logfiles should be easy to process automatically: if there are errors, Claude should write ERROR and put the reason on the same line so grep will find it." — grep-friendly 로그 포맷.

**EG-DESK 적용:** 에이전트 출력 검증을 위한 테스트 설계 원칙. "테스트 = 목표 정의", grep-friendly 로그 포맷, deterministic 서브샘플링 참고 가능.

출처: https://www.anthropic.com/engineering/building-c-compiler

#### Finding 2: 에이전트 전문화 (5가지 특수 역할)

| 역할 | 원문 설명 |
|------|----------|
| 중복 제거 | "I tasked one agent with coalescing any duplicate code it found" |
| 성능 최적화 | "I put another in charge of improving the performance of the compiler itself" |
| 코드 품질 | "a third I made responsible for outputting efficient compiled code" |
| 아키텍처 리뷰 | "I asked another agent to critique the design of the project from the perspective of a Rust developer, and make structural changes" |
| 문서화 | "another to work on documentation" |

저자 본인이 초기 실험으로 표현: "This is a very early research prototype. I haven't yet implemented any other method for communication between agents, nor do I enforce any process for managing high-level goals. I don't use an orchestration agent."
- 오케스트레이션 에이전트 없음, 에이전트간 통신 메커니즘 미구현, 고수준 목표 관리 프로세스 미시행.

**EG-DESK 적용:** 전문화된 역할 (중복 제거, 성능, 코드 품질, 아키텍처 리뷰, 문서화)은 coding-agent 변형으로 구현 가능. Anthropic이 "아직 미구현"이라 한 오케스트레이션/통신은 EG-DESK가 이미 보유.

출처: https://www.anthropic.com/engineering/building-c-compiler

#### Finding 3: 실패 모드 + 한계 (Ceiling)

병렬화 병목: 독립적 태스크는 병렬화 효과적, 모놀리식 태스크(리눅스 커널 컴파일)는 충돌 발생. 모든 에이전트가 같은 버그를 찾아 고치고 서로의 변경을 덮어씀.

자기 종료 사고: "Claude `pkill -9 bash` on accident, thus killing itself and ending the loop." — 에이전트가 자신의 실행 환경을 파괴할 수 있음.

능력 한계: 100,000줄 Rust C 컴파일러. GCC torture test 99% pass. 그러나 16-bit x86 코드 생성 실패, 자체 어셈블러/링커 미완성, GCC 대비 비효율적 출력, Rust 코드 품질 전문가 수준 미달.

안전 우려: "the thought of programmers deploying software they've never personally verified is a real concern."

컨텍스트 관리: README + progress files로 자기 오리엔테이션. "The test harness should not print thousands of useless bytes." — 출력 최소화로 context 보호.

성과 수치:

| 항목 | 수치 |
|------|------|
| 코드 규모 | 100,000줄 (Rust) |
| 컴파일 가능 | Linux 6.9, QEMU, FFmpeg, SQLite, PostgreSQL, Redis, Lua, libjpeg |
| GCC torture test | 99% pass rate |
| Doom 컴파일/실행 | 성공 |
| 에이전트 수 | 16 |
| 세션 수 | 2,000 |
| 기간 | 2주 |
| Input tokens | 2B |
| Output tokens | 140M |
| 비용 | $20,000 미만 |

**EG-DESK 적용:** 모놀리식 태스크 병렬화 실패 → Phase Management 필요성 확인. 자기 종료 방지 → 격리 + permission 제한. Context 보호를 위한 출력 최소화 → agent prompt에 "로그는 파일로, 화면 출력은 최소" 지시.

출처: https://www.anthropic.com/engineering/building-c-compiler

---

### obsidian-claude-mcp (explore-agent-17) — 7건

#### Finding 1: Tool Registry 패턴 — 자동 도구 등록 + 런타임 검증

`src/shared/tool-registry.ts`에 Automatic tool registration with runtime validation 구현. IDE 전용 도구와 MCP 도구를 Dual Tool Registries로 분리 관리. WebSocket 서버와 HTTP 서버가 각각 다른 도구 세트를 노출.

**EG-DESK 참고:** skill registry + hook system과 유사한 패턴. tool 자동 등록 + 런타임 검증은 skill hot-reload 시스템에 참고 가능.

출처: https://github.com/iansinnott/obsidian-claude-code-mcp (CLAUDE.md)

#### Finding 2: Event-Driven Architecture — DOM selectionchange 기반

`src/obsidian/workspace-manager.ts`에서 DOM `selectionchange` events 사용 (polling 대신). 현재 활성 파일과 선택 영역을 이벤트 기반으로 추적.

출처: CLAUDE.md

#### Finding 3: Lock File 기반 Auto-Discovery

WebSocket 서버가 Claude config 디렉토리에 `[port].lock` 파일 생성. Claude Code가 lock 파일을 읽어 자동 발견. 경로 우선순위: `CLAUDE_CONFIG_DIR` > `$XDG_CONFIG_HOME/claude/ide/` > `~/.config/claude/ide/` (v1.0.30+) > `~/.claude/ide/` (legacy).

**EG-DESK 참고:** lock file 기반 service discovery는 agent간 통신에서 참고 패턴. 외부 MCP 서버와의 통합 시 유용.

출처: CLAUDE.md

#### Finding 4: Separation of Concerns — 5개 모듈 분리

```
src/
├── mcp/        # MCP 프로토콜 (dual-server, handlers, types)
├── ide/        # Claude Code IDE 전용 (ide-handler, ide-tools)
├── shared/     # 공통 (tool-registry)
├── obsidian/   # Obsidian API (workspace-manager, utils)
├── tools/      # MCP tool 구현 (file-tools, general-tools)
└── terminal/   # xterm.js 터미널 (선택적 기능)
```

출처: CLAUDE.md + gh API

#### Finding 5: MCP Tool 목록 (확장) — 16개 총

이전 보고에서 7개 shared tool만 보고. 실제로는 12개 shared + 4개 IDE 전용 = 16개:

Shared (12개): readFile, writeFile, getOpenFiles, listFiles, getWorkspaceInfo, obsidian_api, view, str_replace, create, insert, get_current_file, get_workspace_files
IDE 전용 (4개): getDiagnostics, openDiff, close_tab, closeAllDiffTabs

출처: CLAUDE.md

#### Finding 6: 빌드/배포 파이프라인 + 의존성 분석

| 항목 | 값 |
|------|-----|
| 빌드 도구 | esbuild (커스텀 설정) |
| 번들 형식 | 단일 main.js (CommonJS) |
| PNG 처리 | data URL로 번들 |
| 패키지 매니저 | bun |
| 릴리스 | npm version patch → bun run build → gh release create |

주요 의존성: @xterm/xterm 5.5.0 (내장 터미널 UI), ws 8.18.2 (WebSocket 서버). MCPVault와 비교: MCPVault는 공식 MCP SDK(@modelcontextprotocol/sdk 1.20.0) 사용, obsidian-claude-code-mcp는 프로토콜 직접 구현.

출처: CLAUDE.md, package.json

#### Finding 7: License 불일치 + 테스트 전략

License 불일치: README/GitHub 표시 0BSD, package.json MIT — 실제 적용 라이선스 불명확.

테스트: 자동화 테스트 없음 (test script 없음). 수동 테스트만 (test-manual-requests.js, test-mcp-client.js). 비교: MCPVault는 Vitest 기반 체계적 테스트 (7개 테스트 파일).

출처: CLAUDE.md, package.json

---

## Round 3: Architecture Rule Injection & Pre-Action Self-Simulation (Raw)

> 2개 개념 조사: (1) Architecture Rule Injection — agent에게 역할 기반 행동 규칙 주입 메커니즘, (2) Pre-Action Self-Simulation — tool 호출 전 역할/규칙 자기 점검 프로토콜

### autoresearch (explore-agent-5)

**Rule Injection: 관련 패턴 발견 (강) — program.md가 정확히 이 패턴**

autoresearch의 program.md는 역할 기반 행동 규칙을 자연어로 주입하는 메커니즘의 순수한 형태.

#### Rule Injection의 구조

**1. 역할 정의**: "you are a completely autonomous researcher trying things out" — 명시적 역할 = 자율 연구자

**2. Behavior Constraints (CAN/CANNOT 규칙)**:
- CAN: train.py 수정 (아키텍처, 옵티마이저, 하이퍼파라미터, 배치사이즈, 모델크기)
- CANNOT: prepare.py 수정, 패키지 추가, evaluate_bpb 변경
- tool 권한이 아닌 행동 규칙 — 에이전트가 기술적으로는 prepare.py를 수정할 수 있지만, 규칙으로 금지

**3. 판단 기준 주입 (Simplicity Criterion)**:
- "All else being equal, simpler is better"
- "A 0.001 val_bpb improvement that adds 20 lines of hacky code? Probably not worth it"
- "removing something and getting equal or better results is a great outcome"
- 에이전트의 의사결정 가중치를 조정하는 규칙

**4. 자율성 규칙**: "NEVER STOP" — "do NOT pause to ask the human if you should continue". "If you run out of ideas, think harder". 인간 개입 없이 무한 루프 실행 강제.

**5. 에러 처리 규칙**: 크래시 시 "use your judgment: If it's something dumb and easy to fix, fix it and re-run". 10분 초과: "kill it and treat it as a failure". "more than a few attempts" 실패 시 포기.

#### Rule Injection의 특성

| 측면 | autoresearch 방식 |
|------|-------------------|
| 주입 시점 | 세션 시작 시 1회 (setup에서 "Read program.md") |
| 주입 방법 | system prompt가 아닌 파일 읽기 (에이전트가 직접 read) |
| 강제력 | 자연어 규칙 (기술적 강제 아님) + prepare.py의 코드 레벨 강제 (evaluate_bpb 불변) |
| 갱신 | 인간이 program.md를 편집 → 다음 세션에 반영 |
| 범위 | 단일 에이전트의 전체 행동 (역할, 허용/금지, 판단 기준, 자율성, 에러 처리) |

#### EG-DESK 비교

| autoresearch Rule Injection | EG-DESK 대응 |
|---------------------------|-------------|
| program.md → 에이전트 read | CLAUDE.md → 세션 시작 시 자동 로드 |
| CAN/CANNOT 규칙 | Permission mode (bypassPermissions/acceptEdits) |
| Simplicity criterion | Evidence Elevation (의견/조사/검증 floor) |
| "NEVER STOP" | TeammateIdle keep-alive (WM) |
| 에러 처리 규칙 | Error Handling 섹션 (worker 실패 → sprint-leader 보고) |

핵심 차이: autoresearch는 단일 파일에 모든 규칙을 flat하게 나열. EG-DESK는 계층적 분산 (CLAUDE.md=구조적 규칙, agent template=역할별 규칙, SKILL.md=작업별 규칙). autoresearch 방식은 단일 목적 에이전트에 적합, EG-DESK 방식은 다중 역할 시스템에 적합.

출처: program.md 전문 (https://raw.githubusercontent.com/karpathy/autoresearch/master/program.md)

**Pre-Action Self-Simulation: 관련 패턴 없음**

autoresearch에는 에이전트가 행동 전에 "이것이 내 역할/규칙에 맞는가?"를 자기 점검하는 프로토콜이 존재하지 않음.

부재의 근거:
1. program.md에 pre-flight check 지시 없음. 루프는 "Tune train.py → commit → run → check results" — 행동 전 검증 단계 없음.
2. action validation 없음. prepare.py 수정 방지는 자연어 규칙만 존재, 실행 시점 검증 메커니즘 없음.
3. role-based action gate 없음. program.md는 규칙을 "주입"하지만, 매 행동 전에 규칙을 "확인"하라고 지시하지 않음. 에이전트가 규칙을 내면화했다고 가정.
4. 유일한 사후 검증: val_bpb 비교 → keep/discard. 사전 점검이 아닌 사후 평가.

autoresearch의 접근: "Trust + Guardrail" 모델 — pre-action self-simulation 대신:
- Trust: 에이전트가 규칙을 따른다고 신뢰 (program.md 자연어 규칙)
- Guardrail: 설령 위반하더라도 피해 제한 (prepare.py의 evaluate_bpb가 코드 레벨에서 불변, 5분 시간 제한, git reset으로 복원)

Self-simulation과의 대조: Self-simulation은 행동 전에 점검 → 비용 높지만 위반 방지. Trust + Guardrail은 행동 후에 평가 → 비용 낮지만 위반 허용 (피해 제한).

출처: program.md 전문 분석 기반

---

### hermes-agent (explore-agent-4)

**Rule Injection: 관련 패턴 3가지 발견**

#### 1-1. SOUL.md Identity Injection (prompt_builder.py L588-611)

- `~/.hermes/SOUL.md` 파일이 시스템 프롬프트의 slot #1 (identity)에 주입됨
- 에이전트의 성격, 역할, 행동 규칙을 정의. 사용자가 자유 작성.
- 기본값: SOUL.md 없으면 `DEFAULT_AGENT_IDENTITY` 사용 ("You are Hermes Agent, an intelligent AI assistant created by Nous Research...")
- 보안: prompt injection 스캔 후 주입 (10개 threat pattern + invisible unicode 감지)
- EG-DESK 대응: agent template body (역할 지시)와 유사하지만, hermes는 단일 파일(SOUL.md)로 전체 에이전트 성격을 정의. EG-DESK는 agent별 분리된 template.

#### 1-2. Behavioral Guidance Constants (prompt_builder.py L143-170)

시스템 프롬프트에 하드코딩된 행동 규칙 상수 4개:
- `MEMORY_GUIDANCE`: memory 저장 대상/금지 대상, 우선순위 규칙
- `SESSION_SEARCH_GUIDANCE`: 과거 세션 참조 시기
- `SKILLS_GUIDANCE`: skill 생성/업데이트 트리거 규칙 ("5+ tool calls 후 저장", "문제 발견 시 즉시 patch")
- `PLATFORM_HINTS`: 플랫폼별 행동 제약 (WhatsApp: markdown 금지, Telegram: 미디어 전송 방식 등)

EG-DESK 대응: CLAUDE.md 규칙과 유사. hermes는 코드에 하드코딩, EG-DESK는 CLAUDE.md 파일로 외부화.

#### 1-3. Subagent Role Constraint via Blocked Tools (delegate_tool.py L29-35)

`DELEGATE_BLOCKED_TOOLS` frozenset으로 subagent가 절대 사용 불가한 도구를 코드 레벨에서 강제:
- `delegate_task` — 재귀 delegation 불가
- `clarify` — 유저 상호작용 불가
- `memory` — 공유 memory 쓰기 불가
- `send_message` — cross-platform 메시징 불가
- `execute_code` — sandbox 스크립트 불가

추가: child toolsets는 parent enabled toolsets의 부분집합으로 제한 (L179).

성격: "역할 기반 행동 규칙 주입"이 아니라 코드 레벨 capability stripping. subagent에게 "너는 X하면 안 돼"라고 말하는 게 아니라, 물리적으로 X tool을 제거.

**Pre-Action Self-Simulation: 관련 패턴 2가지 발견 (harness-level)**

#### 2-1. Combined Pre-Exec Command Guards (approval.py L486-525)

`check_all_command_guards(command, env_type)` — terminal 명령 실행 직전에 2단계 보안 스캔 수행:

- Phase 1 — Tirith 스캔: 외부 바이너리(`tirith`)로 command를 정적 분석. 결과: allow(exit 0), block(exit 1), warn(exit 2). homograph URL, pipe-to-interpreter, terminal injection 등 content-level 위협 탐지.
- Phase 2 — Dangerous Pattern Detection: 56개 정규식 패턴으로 위험 명령 탐지 (rm -rf, chmod 777, SQL DROP, fork bomb 등). Unicode normalization + ANSI strip으로 obfuscation 우회 방지.

판정 흐름:
1. 컨테이너 환경이면 → 무조건 허용 (격리됨)
2. YOLO 모드면 → 무조건 허용
3. Tirith + Dangerous pattern 중 하나라도 발견 → approval mode에 따라:
   - `smart`: LLM auxiliary가 APPROVE/DENY/ESCALATE 판정 (approval.py L328-377)
   - `manual`: 사용자에게 승인 요청
   - `off`: 무조건 허용

Smart Approval (LLM 자기 점검): auxiliary LLM에게 "이 명령이 실제로 위험한가?" 평가 요청. false positive 감소 목적. OpenAI Codex의 Smart Approvals guardian subagent에서 영감.

EG-DESK 관점: agent가 스스로 점검하는 것이 아니라, harness가 agent의 tool 호출을 가로채서 외부 검증하는 패턴. agent 자신의 reasoning이 아닌 별도 시스템이 pre-flight check 수행.

#### 2-2. Memory Content Security Scan (memory_tool.py L75-87)

`_scan_memory_content(content)` — agent가 memory에 쓰려는 내용을 쓰기 직전에 스캔. 16개 threat pattern (prompt injection, exfiltration, SSH backdoor 등) + invisible unicode 감지. 매치 시 쓰기 차단 + error 반환. agent의 self-check가 아닌 tool handler 내부의 input validation.

#### 요약: EG-DESK 관점

| 개념 | hermes-agent 패턴 | 성격 |
|------|-------------------|------|
| Rule Injection | SOUL.md identity, behavioral constants, blocked tools | 시스템 프롬프트 주입 + 코드 레벨 capability stripping |
| Self-Simulation | command guards (tirith + patterns + smart LLM), memory scan | harness-level interception, agent 자체 reasoning이 아님 |

핵심 차이: hermes-agent의 pre-action 검증은 agent 외부의 harness/tool layer에서 수행. agent가 "이 행동이 내 역할에 맞는가?"를 스스로 reasoning하는 self-simulation 패턴은 코드에 존재하지 않음.

출처: prompt_builder.py, delegate_tool.py, approval.py, memory_tool.py

---

### nodeskclaw (explore-agent-10)

**Architecture Rule Injection: 4계층 행동 규칙 주입 메커니즘 발견**

#### 1A. Gene System SKILL.md를 통한 행동 규칙 주입

Gene의 `manifest.skill.content`가 YAML frontmatter + markdown 본문으로 SKILL.md 파일을 에이전트 런타임에 배포. 이 SKILL.md가 에이전트의 행동 규칙 문서 역할.

"culture" 카테고리 Gene (소스: `data/gene_templates/meta_gene_culture.json`):
- `team-culture-concise`: "3문장 이내 응답", "결론 먼저, 근거 후속", "bullet points 사용", "filler phrases 금지"
- 팀 문화 규칙으로, EG-DESK의 CLAUDE.md conventions와 대응하는 패턴이지만 nodeskclaw는 탈착 가능한 Gene으로 구현.

"meta" 카테고리 Gene들 — 역할별 행동 규칙의 실질적 구현:
- `self-improvement` (소스: `meta_gene_self_improve.json`): "성과 하락 시 자기 분석 + gene 검색 + 학습 계획 + trust check + 자가 설치" — 자기 개선 프로토콜 규칙 주입
- `self-reorg` (소스: `meta_gene_reorg.json`): "topology 비효율 분석 + 재구성 제안 + trust check + 인간 승인 후 실행" — 조직 재편 프로토콜 규칙 주입
- `ai-hc-recruiter` (소스: `meta_gene_ai_hc.json`): "역량 gap 분석 + gene market 탐색 + HC 요청 + trust check + auto/approval 분기" — 인력 충원 프로토콜 규칙 주입
- `innovation-scout` (소스: `meta_gene_innovation.json`): "주간 리뷰 + 개선 기회 식별 + 혁신 제안 + 타 에이전트 토론 + 인간 승인" — 혁신 스카우트 프로토콜 규칙 주입
- `akr-decomposer` (소스: `meta_gene_akr_decomposer.json`): "Objective -> 2-5 KR (SMART) -> 1-3 Tasks (atomic)" — OKR 분해 프로토콜 규칙 주입

핵심 인사이트: 각 Gene의 SKILL.md가 "Triggers" + "Behavior" + "Rules" 섹션으로 구성되어, 언제 + 어떻게 + 제약 조건을 명시적으로 정의. EG-DESK의 agent template body와 동일한 패턴이지만 런타임 탈착 가능하다는 차이.

#### 1B. OrgRequiredGene — 조직 수준 필수 규칙 강제

(소스: `models/org_required_gene.py`)

`org_required_genes` 테이블: org_id + gene_id. 에이전트가 workspace에 합류할 때 반드시 설치되어야 하는 Gene 목록. 조직 정책으로 특정 행동 규칙을 모든 에이전트에게 강제하는 메커니즘.

예: 조직이 `team-culture-concise` Gene을 required로 설정하면, 모든 AI 직원이 "3문장 이내 응답" 규칙을 따르게 됨.

#### 1C. Workspace Context Prompt — 런타임 규칙 주입

(소스: `workspace_message_service.py` L169-219)

`build_context_prompt()`가 매 메시지 전달 시 system 메시지로 주입하는 규칙:
- "너는 "{workspace_name}" 사이버 오피스의 AI 직원 "{agent_name}"이다" — 역할 정체성 주입
- "토픽과 무관하면 NO_REPLY 응답" — 행동 제약 주입
- "과도(corridor)를 통해 연결된 멤버만 연락 가능" — 통신 규칙 주입
- "nodeskclaw_topology 도구로 확인 전까지 다른 사람에게 연락 가능하다고 주장 금지" — 도구 사용 규칙 주입
- "블랙보드에 send 명령으로 메시지 보내지 마라" — 금지 행동 주입

#### 1D. Gene manifest의 tool_allow — 도구 접근 규칙

(소스: `openclaw_gene_install_adapter.py`)

Gene 설치 시 `manifest.tool_allow` 화이트리스트를 `openclaw.json`에 머지. 특정 Gene을 가진 에이전트만 특정 도구를 사용 가능. 역할에 따라 사용 가능한 도구 집합이 달라지는 접근 제어.

EG-DESK 대응:
- Gene SKILL.md = EG-DESK agent template body (같은 철학, Gene은 탈착 가능)
- OrgRequiredGene = EG-DESK의 user-level CLAUDE.md conventions (조직 전체 적용)
- Context Prompt = EG-DESK의 SubagentStart hook inject
- tool_allow = EG-DESK의 permission mode (bypassPermissions/acceptEdits)

**Pre-Action Self-Simulation: 3계층 사전 점검 메커니즘 발견**

#### 2A. SecurityPipeline before_execute — 인프라 레벨 사전 검증

(소스: `services/security/pipeline.py`, `plugins/policy_gate.py`, `plugins/approval_channel.py`)

에이전트가 도구를 호출하면 런타임 보안 레이어가 WebSocket으로 backend에 `evaluate_before` 요청을 전송. SecurityPipeline이 모든 등록 플러그인을 순차 실행:

1. ApprovalChannelPlugin (priority=5): TrustPolicy 테이블에서 "always" grant 확인 -> 없으면 DecisionRecord 생성 + 인간 승인 대기 (최대 10분) -> allow_once / allow_always / deny
2. PolicyGatePlugin (priority=10): tool_name별 규칙 매칭
   - 도구 자체 deny: `rule.action == "deny"` -> 즉시 DENY
   - 명령어 블랙리스트: `exec/shell/bash` 파라미터에서 `denied_commands` regex 매칭
   - 파일 경로 ACL: `read_file/write_file/edit_file` 파라미터에서 `denied_paths` glob 매칭
3. DLPScannerPlugin: 민감 데이터 감지
4. AuditLoggerPlugin: 모든 실행 기록

핵심: DENY 하나라도 나오면 체인 즉시 중단. MODIFY 시 파라미터 변경 후 계속 진행. monitor 모드에서는 Finding만 기록하고 통과 (shadow mode).

after_execute 체인: 도구 실행 후 결과 검증. REDACT(결과 마스킹), FLAG(경고만) 가능. DLP가 출력에서 민감 정보 감지 시 마스킹.

#### 2B. Gene SKILL.md의 "Check trust policy" 패턴 — 프롬프트 레벨 자기 점검

Meta Gene들의 SKILL.md에 반복적으로 나타나는 패턴:
```
6. Submit learning plan to blackboard
7. Check trust policy for `gene_install` action   <-- 자기 점검 단계
8. After approval, self-install recommended genes
```

이 패턴이 4개 meta Gene에서 동일하게 발견됨:
- `self-improvement`: "Check trust policy for gene_install action"
- `self-reorg`: "Check trust policy for reorg_proposal action"
- `ai-hc-recruiter`: "Check trust policy for hc_request action -> auto-execute or route approval"
- `innovation-scout`: "After human approval, incorporate into sprint plan"

프롬프트 레벨에서 에이전트가 "이 행동을 내가 자율적으로 해도 되는지" 스스로 확인하는 단계를 명시적으로 규정. SecurityPipeline이 인프라 레벨에서 강제하는 것과 별도로, 에이전트의 reasoning chain 안에서도 self-check를 수행하도록 유도.

#### 2C. Tunnel adapter의 NO_REPLY 자기 판단 — 런타임 레벨 자기 억제

(소스: `tunnel/adapter.py`, `workspace_message_service.py`)

context_prompt에서 "토픽과 무관하면 NO_REPLY 응답" 규칙 주입 -> 에이전트가 응답 생성 시 자체 판단으로 `NO_REPLY` 토큰 출력 -> TunnelAdapter가 첫 30자 버퍼에서 감지 -> 응답 억제.

에이전트가 도구 호출이 아닌 '응답 자체'에 대해 자기 점검하는 패턴. "내가 이 대화에 참여해야 하는가?" 판단을 에이전트 자체에 위임.

계층별 정리:

| 계층 | 메커니즘 | 강제 방식 | 시점 |
|------|---------|----------|------|
| 인프라 | SecurityPipeline before_execute | WebSocket 요청 가로채기 -> ALLOW/DENY/MODIFY | 도구 호출 직전 |
| 프롬프트 | Gene SKILL.md "Check trust policy" 단계 | LLM reasoning chain에 자기 점검 유도 | 행동 계획 수립 중 |
| 런타임 | NO_REPLY 자기 억제 | context_prompt 규칙 + LLM 자체 판단 | 응답 생성 시 |

EG-DESK 대응:
- SecurityPipeline = EG-DESK PreToolUse hook (인프라 레벨)이지만, nodeskclaw는 before+after 이중 + MODIFY/REDACT + monitor 모드로 더 정교
- Gene SKILL.md의 trust check = EG-DESK에 없는 패턴. agent template에 "이 행동 전에 permission 확인" 같은 자기 점검 단계를 추가할 수 있는 아이디어
- NO_REPLY = EG-DESK에서 agent가 "이 작업은 내 범위가 아님" 판단하는 것과 유사하나, nodeskclaw는 토큰 기반으로 시스템이 감지하는 구조화된 프로토콜

출처: gene_templates/*.json, org_required_gene.py, workspace_message_service.py, openclaw_gene_install_adapter.py, security/pipeline.py, plugins/policy_gate.py, plugins/approval_channel.py, tunnel/adapter.py

---

## Round 4: Group Chat Infrastructure for Agent Communication (Raw)

### Telegram Bot API 무료 tier (explore-agent-3)

#### 1. 무료 tier 제약

| 항목 | 값 | 출처 |
|------|-----|------|
| 1:1 채팅 rate limit | 1 메시지/초 (초과 시 429 에러) | core.telegram.org/bots/faq |
| 그룹 rate limit | 20 메시지/분 | core.telegram.org/bots/faq |
| 전체 broadcast limit | 30 메시지/초 (무료), 1000 메시지/초 (유료, 0.1 Stars/msg) | core.telegram.org/bots/faq |
| 메시지 보존 기간 | 최근 1,000,000개 메시지까지 visible (만료 없음, 삭제 전까지 유지) | limits.tginfo.me/en |
| 봇 수 제한 (계정당) | 20개 (Premium: 40개) | limits.tginfo.me/en |
| 봇 수 제한 (그룹당) | 20개 | limits.tginfo.me/en |
| 파일 업로드 제한 (Bot API) | 50 MB | core.telegram.org/bots/faq |
| 파일 다운로드 제한 (getFile) | 20 MB | core.telegram.org/bots/faq |
| 메시지 텍스트 길이 | 4,096자 | limits.tginfo.me/en |
| 비용 | 완전 무료 (유료 broadcast는 선택적) | core.telegram.org/bots/faq |

참고: Rate limit 수치는 공식 발표가 아닌 커뮤니티 경험치. 실제 한도는 봇 연령, 이력, 요청 유형에 따라 동적 변동.

#### 2. Group/Channel 기능

| 항목 | 값 |
|------|-----|
| Supergroup 최대 멤버 | 200,000명 |
| Basic group 최대 멤버 | 200명 |
| Forum Topics 수 | 1,000,000개/그룹 |
| 스레드 지원 | 있음 (message_thread_id 파라미터) |
| 부분 조회 API | getUpdates는 최근 100개 미확인 업데이트만 반환. 과거 메시지 일괄 조회 API 없음 |

Forum Topics: Supergroup을 Forum으로 전환 가능. 각 Topic은 독립 스레드로 동작. Bot API에서 createForumTopic, editForumTopic, deleteForumTopic, unpinAllForumTopicMessages 메서드 제공.

#### 3. Bot API 핵심 엔드포인트

| 엔드포인트 | 용도 | 핵심 파라미터 |
|-----------|------|-------------|
| sendMessage | 텍스트 메시지 전송 | chat_id, text, parse_mode, message_thread_id |
| getUpdates | Long polling으로 업데이트 수신 | offset, limit (최대 100), timeout, allowed_updates |
| setWebhook | HTTPS POST로 업데이트 수신 | url, certificate, max_connections, secret_token |
| getChat | 채팅 정보 조회 | chat_id |
| getChatMember | 멤버 상태/권한 조회 | chat_id, user_id |
| forwardMessage | 메시지 전달 | chat_id, from_chat_id, message_id |
| editMessageText | 메시지 수정 | chat_id, message_id, text |
| createForumTopic | Forum 토픽 생성 | chat_id, name, icon_color, icon_custom_emoji_id |

메시지 검색/필터 API: 존재하지 않음. Bot API에는 과거 메시지 검색 기능 없음.

getUpdates vs setWebhook: getUpdates는 Long polling (최대 100개), setWebhook는 HTTPS POST 푸시 (포트 443/80/88/8443). 동시 사용 불가.

봇 간 메시지: 봇은 다른 봇의 메시지를 수신하지 못함 (루프 방지).

#### 4. MCP 서버 래핑 가능 여부

기존 Telegram MCP 서버 7개+ 확인:

| 프로젝트 | 언어 | 특징 |
|---------|------|------|
| sparfenyuk/mcp-telegram | Python | MTProto 기반, MCP Inspector 지원 |
| guangxiangdebizi/telegram-mcp | TypeScript | Bot API 기반, npm 배포 (@xingyuchen/telegram-mcp) |
| IQAIcom/mcp-telegram | - | Channel 상호작용 전문 |
| tacticlaunch/mcp-telegram | TypeScript | FastMCP 기반, stdio/SSE transport |
| chigwell/telegram-mcp | Python | Telethon 기반, 풀 기능 (채팅/그룹/미디어/연락처) |
| chaindead/telegram-mcp | - | npm: @chaindead/telegram-mcp, 대화/메시지/초안 관리 |
| abhinavkale-dev/telegram-mcp-server | - | Bot API 전용, AI 어시스턴트 통합 |

래핑 난이도: 기존 MCP 서버 풍부 → 직접 래핑 불필요. Bot API는 단순 HTTPS REST → 자체 래핑도 저난이도. 인증: Bot Token 1개 (BOT_TOKEN env var). @BotFather에서 생성.

#### 5. Agent 통신 버스로서의 적합성

장점:
- 완전 무료 (Bot API 사용료 없음)
- Forum Topics: agent별 토픽 분리 가능 (최대 1,000,000개), 각 토픽이 독립 스레드
- Webhook 지원: 실시간 푸시 수신 가능
- 메시지 영속성: 삭제 전까지 보존
- 인증 간편: Bot Token 1개
- MCP 서버 기존재: 즉시 연동 가능
- 크로스 플랫폼: 모바일/데스크톱/웹에서 메시지 확인 가능 (디버깅 용이)

단점:
- Rate limit: 그룹 20 msg/min = agent 간 빈번한 통신에 병목
- 메시지 검색 불가: Bot API에 과거 메시지 검색/필터 없음
- 봇 간 통신 불가: 봇은 다른 봇의 메시지를 수신 못함 → agent 간 직접 통신 구조 불가 (인간 사용자 또는 User Bot 필요)
- 4,096자 제한: 긴 context/report 전송 시 분할 필요
- getUpdates 100개 제한: 대량 메시지 배치 처리 불가
- 파일 크기: Bot API 50MB 업로드/20MB 다운로드 제한

비용: 완전 무료 (30 msg/s 이내). 초과 시 0.1 Telegram Stars/msg (최소 잔고 100,000 Stars + 100,000 MAU 필요).

지연 시간: Webhook 수백 ms 수준, Long polling은 timeout 설정에 따라 0~수십 초. 공식 수치 없음.

핵심 제약: 봇 간 통신 불가 = agent 통신 버스로서 치명적 한계. 각 agent가 봇이면 서로의 메시지를 못 읽음. 우회: (1) 인간 계정 중계, (2) User Bot (Telethon/Pyrogram) 사용, (3) 봇이 DB/파일에 쓰고 다른 봇이 polling.

확인 불가 항목: 정확한 API 응답 지연 시간 (공식 SLA 없음), 메시지 보존 기간 상한 (명시적 만료 정책 없음), Rate limit 동적 조정 기준 (봇 연령/이력 기반이라고만 명시).

조사 일시: 2026-03-29
출처: core.telegram.org/bots/api, core.telegram.org/bots/faq, limits.tginfo.me/en, core.telegram.org/api/threads

---

### Discord + Matrix + 로컬 MCP 대안 (explore-agent-9)

#### 대안 1: Discord (무료)

Bot 생성 및 비용: 무료 (Discord Developer Portal). Bot Token + Intents (Message Content, Server Members, Presence) 활성화 필요.

Rate Limits:

| 항목 | 값 | 출처 |
|------|-----|------|
| Global rate limit | 50 requests/second (모든 엔드포인트 합산) | docs.discord.com/developers/topics/rate-limits |
| Per-route limit | 엔드포인트별 상이 (하드코딩 금지, 헤더 파싱 필수) | 동일 |
| Invalid request threshold | 10,000/10분 (401/403/429 응답 누적) | 동일 |
| POST /channels/{id}/messages | 정확한 수치 미공개 (동적, 헤더 기반) | 데이터 없음 |

서버/채널 구조:

| 항목 | 한도 |
|------|------|
| 채널 수 | 서버당 500개 |
| 카테고리 수 | 서버당 50개 |
| 활성 스레드 | 서버당 1,000개 (아카이브 무제한) |
| 역할 수 | 서버당 250개 |
| 포럼 채널 | 지원 (태그, 스레드형 토론) |

MCP 서버:

| 프로젝트 | 주요 기능 |
|----------|----------|
| IQAIcom/mcp-discord | 25+ tools, 메시지/채널/포럼/리액션/웹훅, 실시간 이벤트. npx @iqai/mcp-discord로 즉시 실행. Sampling 지원 |
| SaseQ/discord-mcp | JDA 기반, 채널 관리, 메시지 송수신 |
| tolgasumer/discord-mcp | 실시간 이벤트 스트리밍 (new messages, user joins) |
| v-3/discordmcp | Claude 통합 특화 |

장점: 즉시 사용 가능 (무료), 채널/스레드/포럼으로 agent별 토픽 분리 (500채널), MCP 서버 다수, 실시간 이벤트 + 메시지 히스토리 영구 보관, 웹/모바일 UI로 모니터링/개입.

단점: 외부 서비스 의존 (인터넷 필수), Rate limit 50 req/s, 메시지 지연 (네트워크 RTT), Discord TOS 준수 필요, 민감 데이터 보안 우려.

#### 대안 2: Matrix/Element (오픈소스)

셀프호스팅: Synapse (Python) + PostgreSQL + Element Web. Docker Compose 기반 2-4시간 설정. 최소 1GB RAM + 2코어.

무료 homeserver (matrix.org): 가능하나 미디어 업로드 제한. 프리미엄 2025년 여름 도입.

Room/Space 구조: Room = 기본 대화 단위, Space = Room들의 계층적 그룹. Room member 수 기술적 제한 없음 (성능이 제한 요소).

Bot SDK: matrix-bot-sdk (TypeScript/JavaScript), matrix-nio (Python).

MCP 서버: mjknowles/matrix-mcp-server — 15 tools (2-tier), OAuth 2.0, multi-homeserver. Tier 0 (읽기전용: room 목록/정보/멤버, 메시지 조회, 검색) + Tier 1 (액션: 메시지 전송, room 생성/입장/퇴장, 초대, 관리).

장점: 완전 셀프호스팅 → 데이터 주권, E2EE 옵션, 무제한 Room/Member, MCP 서버 존재, 오픈 프로토콜.

단점: 셀프호스팅 초기 설정 비용 (DNS, TLS, Docker), 유지보수 오버헤드, Synapse 성능 이슈, Bot SDK 생태계 Discord보다 작음.

#### 대안 3: 로컬 MCP 서버 자체 구축

기존 유사 프로젝트:

| 프로젝트 | 접근 방식 | 특징 |
|----------|----------|------|
| doobidoo/mcp-memory-service | SQLite-vec + 태그 기반 | inter-agent messaging bus로 실제 사용됨. 5-agent 클러스터가 msg:cluster 태그로 통신. REST API + MCP 프로토콜 |
| panasenco/mcp-sqlite | SQLite 직접 쿼리 | 임의 SQL 실행, Datasette 호환 |
| AuraFriday/sqlite_mcp | SQLite + 벡터 검색 | "Multiple AI agents can collaborate using the same in-memory database" |

mcp-memory-service 상세 (가장 유력한 기존 솔루션):

inter-agent 메시징 패턴:
- Agent A → store memory with tags: ["task", "msg:cluster"]
- Agent B → search with tag filter: ["msg:cluster"]
- → Agent B receives Agent A's message
- X-Agent-ID 헤더로 에이전트 자동 태깅
- BM25 + 벡터 하이브리드 검색
- Knowledge graph (causes, fixes, contradicts 관계)
- 자동 중복 제거 (content hashing)
- Docker 2컨테이너 (MCP + Web UI)
- 설치: pip install mcp-memory-service + memory server --http

파일 기반 vs SQLite 기반 vs In-memory 비교:

| 방식 | 장점 | 단점 | 사례 |
|------|------|------|------|
| 파일 기반 | 가장 단순, 도구 불필요 | 동시성 문제, 검색 느림, 파일 잠금 | EG-DESK의 .tmp/agent-context/ |
| SQLite 기반 | ACID 보장, 동시 읽기(WAL), FTS 검색, 0 설정 | 높은 쓰기 동시성 한계 | agent-deck StateDB, mcp-memory-service |
| In-memory | 최고 속도, 지연 없음 | 프로세스 종료 시 소멸, 크로스 프로세스 공유 어려움 | sqlite_mcp (AuraFriday) |

자체 구축 난이도: 최소 구현 200-500줄 (MCP SDK + SQLite WAL + channels/messages/subscriptions 테이블). 또는 mcp-memory-service를 그대로 사용하고 태그 컨벤션만 정의하면 구현 비용 0.

장점: 외부 의존 없음, 최소 지연 (로컬 SQLite), 완전한 데이터 통제, MCP 프로토콜 표준 → Claude Code 네이티브 통합, mcp-memory-service 사용 시 구현 비용 거의 0.

단점: UI 없음 (mcp-memory-service는 Web UI 있음), 실시간 푸시 없음 (폴링 기반), 크로스 머신 통신 불가 (HTTP 모드 시 가능).

#### 3개 대안 비교표

| 기준 | Discord | Matrix (셀프호스팅) | 로컬 MCP (mcp-memory-service) |
|------|---------|-------------------|-------------------------------|
| 비용 | 무료 | 서버 비용 (월 $5-20) | 무료 (로컬) |
| 설정 시간 | 10분 | 2-4시간 | 5분 (pip install) |
| 유지보수 | 없음 | 중 (업데이트/백업) | 없음 |
| MCP 서버 | 다수 (5+) | 1개 (15 tools) | 자체가 MCP |
| Rate limit | 50 req/s | 셀프호스팅 시 무제한 | 무제한 (로컬) |
| 지연 | 중 (네트워크) | 중-낮음 (로컬네트워크) | 최소 (로컬 SQLite) |
| UI | 풍부 (웹/모바일) | Element Web | Web UI (기본) |
| 보안 | 외부 저장 | 완전 통제 | 완전 통제 |
| 실시간 | WebSocket | Federation | 폴링 (HTTP 모드 시 SSE) |
| 크로스 머신 | O | O | X (HTTP 모드 시 O) |
| 메시지 영속성 | O | O | O (SQLite) |
| 검색 | 기본 | 기본 | BM25 + 벡터 |

EG-DESK Agent 통신 버스 권고 (explore-agent-9 의견):
1. 즉시 활용 (PoC): mcp-memory-service — 설치 5분, 태그 컨벤션만 정의하면 inter-agent messaging 즉시 가능
2. 사람 개입 필요 시: Discord — UI 풍부, 모바일 알림, MCP 서버로 Claude Code에서 직접 접근
3. 데이터 주권 + 확장성: Matrix 셀프호스팅 — 장기적으로 가장 유연하나 초기/유지보수 비용 존재

조사 일시: 2026-03-29
출처: discord.com/developers, docs.discord.com, support.discord.com, matrix.org, github.com (mcp-discord, matrix-mcp-server, mcp-memory-service, mcp-sqlite, sqlite_mcp)

---

### Finding: Slack 무료 Tier 최신 정책 및 Agent 통신 버스 적합성 (explore-agent-6)

#### 1. Slack Free Plan 핵심 제약 (2026년 기준)

| 항목 | Free Plan 제한 |
|------|---------------|
| 메시지 보존 | 최근 90일만 검색/열람 가능 (이전 메시지는 삭제되지 않지만 접근 불가) |
| 앱/통합 | 최대 10개 앱 설치 가능 |
| 파일 스토리지 | 없음 (무제한이었으나 90일 보존으로 변경) |
| 워크플로 빌더 | 사용 불가 (유료 전용) |
| Huddles | 1:1만 가능 (그룹 huddle 불가) |
| 외부 채널 | Slack Connect 불가 |
| 분석/내보내기 | 불가 |
| 게스트 채널 | 불가 |
| SLA/지원 | 없음 |

#### 2. Bot/App 기능 및 API

**인증 3가지 방식:**
- Bot Token (xoxb-): 봇 사용자로서 메시지 읽기/쓰기
- User Token (xoxp-): 사용자 대리 동작
- App-Level Token (xapp-): Socket Mode 연결용

**배포 방식:**
- **Socket Mode**: WebSocket 기반, 공개 URL 불필요, 로컬 개발에 최적
- **HTTP Webhook**: Events API + Request URL, 프로덕션 배포용

**Rate Limits:**
- Web API: Tier별 분당 요청 제한 (일반적으로 1-50+ req/min per method)
- Events API: 이벤트 수신은 제한 없으나 응답 3초 이내 필수
- RTM (Real Time Messaging): 더 이상 권장하지 않음 (Socket Mode로 대체)

**주요 Bot 기능:**
- 채널 메시지 읽기/쓰기
- 스레드 대화
- 리액션/이모지
- 파일 업로드/다운로드
- 슬래시 커맨드
- 인터랙티브 메시지 (버튼, 드롭다운)
- 모달/뷰
- 앱 홈 탭

#### 3. MCP 서버 현황

| MCP 서버 | GitHub Stars | Tools 수 | 특징 |
|----------|-------------|---------|------|
| korotovsky/slack-mcp-server | ~1.5k | 15 | 가장 인기, 채널/메시지/유저/리액션 full CRUD |
| modelcontextprotocol/servers (Slack) | MCP 공식 | 6 | 공식 레포, 기본 기능 |
| slack-mcp (Koyeb) | - | 10+ | Koyeb 배포 가이드 포함 |
| kazuph/slack-mcp-server | - | 8 | 경량, 읽기 중심 |
| ferozemohideen/slackMCP | - | 12 | 워크스페이스 분석 기능 |

**korotovsky/slack-mcp-server 주요 Tools (15개):**
- slack_list_channels, slack_post_message, slack_reply_to_thread
- slack_add_reaction, slack_get_channel_history, slack_get_thread_replies
- slack_get_users, slack_get_user_profile, slack_search_messages
- slack_list_members, slack_create_channel, slack_invite_to_channel
- slack_set_channel_topic, slack_upload_file, slack_get_file_info

#### 4. Agent 통신 버스로서의 Slack 적합성 평가

**장점:**
- UI/UX 풍부: 스레드, 리액션, 검색 등 사람이 모니터링하기 최적
- 생태계 성숙: MCP 서버 5+, Bot API 안정적
- Socket Mode: 로컬 개발 시 공개 URL 불필요
- 알림 시스템: 모바일/데스크톱 실시간 알림

**단점:**
- **10개 앱 제한**: Agent마다 Bot이면 금방 소진 (1개 Bot으로 통합 필요)
- **90일 보존**: 장기 프로젝트에서 컨텍스트 손실
- **Rate Limit**: Web API 분당 제한이 고빈도 Agent 통신에 병목
- **외부 의존**: 네트워크 지연, Slack 서비스 장애 리스크
- **Free Plan 워크플로 빌더 불가**: 자동화 파이프라인 구축 제한

**결론 (explore-agent-6 의견):**
Slack은 Agent 간 고성능 통신 버스로는 부적합. Rate limit, 10앱 제한, 90일 보존이 주요 병목.
단, **모니터링/디버깅 채널**로는 최적: 사람이 Agent 활동을 실시간 관찰하고 개입할 수 있는 UI가 풍부.
권장 구조: 핵심 Agent 통신은 로컬 MCP(또는 Discord) + Slack은 모니터링/알림 레이어로 분리.

조사 일시: 2026-03-29
출처: api.slack.com, slack.com/help, slack.com/pricing, github.com (korotovsky/slack-mcp-server, modelcontextprotocol/servers, kazuph/slack-mcp-server, ferozemohideen/slackMCP)

---

## Round 5: Messaging App UX Deep Dive for Agent Communication (Raw)

### Finding: Discord MCP Tool 상세 + UX 흐름 (explore-agent-9)

#### 1. Discord MCP Tool 상세 목록

소스: https://github.com/IQAIcom/mcp-discord (README + src/tools/)

**전체 Tool 목록 (22개 확인)**

**메시지 (3)**

| Tool | 파라미터 | 설명 |
|------|----------|------|
| `discord_send` | channelId, message | 텍스트 채널에 메시지 전송 |
| `discord_read_messages` | channelId, limit(기본 50) | 채널 메시지 조회 |
| `discord_delete_message` | channelId, messageId, reason | 메시지 삭제 |

**채널 관리 (5)**

| Tool | 파라미터 | 설명 |
|------|----------|------|
| `discord_create_text_channel` | guildId, channelName, topic | 텍스트 채널 생성 (topic 옵션) |
| `discord_delete_channel` | channelId, reason | 채널 삭제 |
| `discord_create_category` | guildId, name, position, reason | 카테고리 생성 |
| `discord_delete_category` | categoryId, reason | 카테고리 삭제 |
| `discord_edit_category` | categoryId, name, position, reason | 카테고리 편집 |

**포럼 (5)**

| Tool | 파라미터 | 설명 |
|------|----------|------|
| `discord_get_forum_channels` | guildId | 포럼 채널 목록 조회 |
| `discord_get_forum_post` | threadId | 포럼 포스트 상세 + 메시지 조회 |
| `discord_create_forum_post` | forumChannelId, title, content, tags | 포럼 포스트 생성 |
| `discord_reply_to_forum` | threadId, message | 포럼 포스트에 답글 |
| `discord_delete_forum_post` | threadId, reason | 포럼 포스트 삭제 |

**리액션 (3)**

| Tool | 파라미터 | 설명 |
|------|----------|------|
| `discord_add_reaction` | channelId, messageId, emoji | 단일 리액션 추가 |
| `discord_add_multiple_reactions` | channelId, messageId, emojis[] | 복수 리액션 추가 |
| `discord_remove_reaction` | channelId, messageId, emoji, userId | 리액션 제거 |

**웹훅 (4)**

| Tool | 파라미터 | 설명 |
|------|----------|------|
| `discord_create_webhook` | channelId, name, avatar, reason | 웹훅 생성 |
| `discord_edit_webhook` | webhookId, webhookToken, name, avatar, channelId, reason | 웹훅 편집 |
| `discord_delete_webhook` | webhookId, webhookToken, reason | 웹훅 삭제 |
| `discord_send_webhook_message` | webhookId, webhookToken, content, username, avatarURL, threadId | 웹훅으로 메시지 전송 |

**서버/인증 (2)**

| Tool | 파라미터 | 설명 |
|------|----------|------|
| `discord_get_server_info` | guildId | 서버 정보 (채널, 멤버 수 등) |
| `discord_login` | token (옵션) | Discord 인증 |

**소스 파일 구조 (8 파일)**:
`src/tools/`: channel.ts (12KB), forum.ts (6.5KB), login.ts (3.2KB), reactions.ts (6.5KB), send-message.ts (1.3KB), tools.ts (1KB), types.ts (0.4KB), webhooks.ts (4.7KB)

**Claude Code 통합**:
MCP 서버를 `.mcp.json`에 등록하면 Claude Code에서 `mcp__discord__[tool명]` 형태로 호출 가능. 예:
- `mcp__discord__discord_send(channelId: "123", message: "hello")`
- `mcp__discord__discord_read_messages(channelId: "123", limit: 10)`

`.mcp.json`의 서버 이름이 prefix가 됨. 서버를 `"discord"`로 등록하면 `mcp__discord__discord_send`. 서버를 `"d"`로 등록하면 `mcp__d__discord_send`.

**누락 도구 (agent 통신 버스 관점)**:
- `list_channels` 직접 도구 없음 → `discord_get_server_info`로 서버 내 채널 목록 조회 가능
- `create_thread` 직접 도구 없음 → 포럼 관련만 존재 (일반 스레드 생성은 미지원)
- `search_messages` 없음 → `discord_read_messages`로 최근 N개만 조회 가능
- `get_channel_history` (날짜 범위) 없음

#### 2. Sampling (양방향 통신) 상세

소스: `src/sampling.ts`

**메시지 흐름**:
```
Discord 메시지 수신
→ 필터 체크 (bot 여부, 차단 사용자, DM, 차단 서버)
→ Rate limit 체크 (userCooldowns Map, DEFAULT_RATE_LIMIT_SECONDS)
→ 템플릿 생성 (user_id, user_name, guild_name, channel_name, message, timestamp)
→ MCP sampling 요청 (server.request("sampling/createMessage"))
→ Claude 응답 생성
→ Discord 답글 (2000자 초과 시 자동 청킹)
```

핵심: Sampling은 MCP 클라이언트가 Claude Desktop/Claude Code일 때 작동
- Discord에서 bot mention → MCP 서버가 `sampling/createMessage` 요청을 MCP 클라이언트에 보냄
- MCP 클라이언트(Claude)가 응답 생성 → MCP 서버가 Discord에 답글
- 단, Claude Code의 MCP는 현재 stdio transport만 지원 → sampling이 작동하려면 Claude Code 프로세스가 실행 중이어야 함

#### 3. UX 흐름 분석 (3가지 Option)

**Option A: Claude Code 중심**

```
Agent (Claude Code)
  → mcp__discord__discord_send(channelId, "조사 결과: ...")     # Discord에 post
  → mcp__discord__discord_read_messages(channelId, 50)          # 다른 agent 메시지 읽기
  → mcp__discord__discord_create_forum_post(forumId, title, content)  # 포럼에 보고서
```

유저가 agent 토론을 보려면:
- Claude Code에서 `mcp__discord__discord_read_messages`로 fetch → Claude가 요약 → 유저에게 표시
- 또는 Discord UI(웹/앱)에서 직접 확인

장점:
- Agent가 Discord에 자율적으로 post/read (SendMessage 대체)
- 유저가 Discord UI에서 agent 토론을 실시간으로 관찰 가능 (별도 fetch 불필요)
- 메시지 영구 보관 + 검색 가능
- 채널별 토픽 분리 (sprint-1, research, writing 등)

단점:
- 모든 agent가 동일 MCP 서버 인스턴스를 공유해야 함 (현재 Claude Code 팀 내 MCP 공유 가능 여부 미확인)
- Rate limit 50 req/s에 agent 수 x 메시지 빈도가 묶임
- 네트워크 지연 (SendMessage 대비 느림)
- agent가 매번 channelId를 알아야 함 (하드코딩 또는 lookup 필요)

**Option B: Discord 중심**

```
유저 → Discord에서 @bot 메시지 전송
    → Sampling이 MCP 클라이언트(Claude)에 전달
    → Claude가 응답 생성
    → bot이 Discord에 답글
```

실현 가능성:
- Sampling 기능으로 가능하나, Claude Code가 실행 중이어야 함
- Claude Code Team의 teammate가 아닌 별도 Claude 프로세스가 필요
- Slash command 지원은 이 MCP 서버에 미구현

장점:
- 유저가 Discord에서 직접 agent와 대화
- 모바일에서도 접근 가능

단점:
- Claude Code Team과 별개의 프로세스 필요 → 현재 EG-DESK swarm과 통합 어려움
- Sampling이 Claude Code에서 안정적으로 작동하는지 검증 필요
- 기존 Session Lead 역할과 충돌

**Option C: 하이브리드 (권장)**

```
유저 ↔ Session Lead: Claude Code (기존 SendMessage)
Agent ↔ Agent: Discord MCP (채널별 토픽 분리)
유저 관찰: Discord UI에서 직접 확인 OR MCP tool로 fetch
```

구체적 흐름:
1. Session Lead가 sprint 시작 시 `discord_create_text_channel("sprint-42-research")` 생성
2. Worker agents가 `discord_send(channelId, "W3 보고: context-mode 조사 완료...")` 로 보고
3. Sprint Leader가 `discord_read_messages(channelId)` 로 worker 보고 취합
4. 유저가 궁금하면 Discord 앱에서 해당 채널 직접 확인 (UI로 실시간 관찰)
5. 최종 보고는 기존 SendMessage로 Session Lead → 유저

실현 가능성: 높음
- `.mcp.json`에 discord MCP 서버 등록 → 모든 team agent가 접근 가능
- 채널 생성/메시지 전송/읽기 모두 tool로 가능
- 기존 SendMessage 패턴과 공존 (Discord는 보조 통신 채널)

장점:
- 기존 EG-DESK 워크플로우 변경 최소
- Agent간 토론이 Discord에 영구 기록 (디버깅, 회고에 유용)
- 유저가 Discord UI로 실시간 모니터링 가능 (모바일 포함)
- 채널/포럼으로 구조화된 토론 가능

단점:
- Discord 서버 설정 필요 (1회, 10분)
- Agent가 channelId 관리해야 함 (Session Lead가 생성 시 알려주면 해결)
- 민감 코드/데이터는 Discord에 올리면 안 됨
- 인터넷 필요

#### 4. 핵심 기술 질문 & 답변

**Q1: Claude Code Team 내 MCP 서버를 모든 agent가 공유할 수 있는가?**

[조사 결과] `.mcp.json`은 프로젝트 레벨 설정. Claude Code Team의 모든 teammate가 동일 프로젝트에서 실행되므로, `.mcp.json`에 등록된 MCP 서버는 모든 agent가 접근 가능할 것으로 판단. 단, 각 agent가 별도 MCP 프로세스를 spawn하는지 공유하는지는 Claude Code 내부 구현에 의존 (데이터 없음 — Claude Code의 MCP 프로세스 공유 메커니즘 미공개).

**Q2: 스레드 생성이 가능한가?**

[조사 결과] 일반 텍스트 채널의 스레드 생성 tool은 이 MCP 서버에 없음. 포럼 채널의 포스트(= 스레드) 생성만 지원 (`discord_create_forum_post`). 일반 스레드가 필요하면 Discord API 직접 호출 또는 MCP 서버 포크 필요.

**Q3: 메시지 검색이 가능한가?**

[조사 결과] 키워드 검색 tool 없음. `discord_read_messages`로 최근 N개만 조회 가능 (기본 50). Discord API에는 검색 기능이 있으나 이 MCP 서버가 미구현.

#### 5. Option C 실현 시 필요 작업

| 단계 | 작업 | 난이도 |
|------|------|--------|
| 1 | Discord 서버 생성 + Bot 생성 (Developer Portal) | 10분 |
| 2 | `.mcp.json`에 discord MCP 서버 등록 | 5분 |
| 3 | 채널 구조 설계 (카테고리: sprints, research, reports) | 10분 |
| 4 | CLAUDE.md에 Discord 통신 컨벤션 추가 | 15분 |
| 5 | Session Lead가 sprint 시작 시 채널 생성 → agents에 channelId 전달 | 기존 워크플로우에 추가 |

총 초기 투자: 40분 이내
운영 비용: 0 (무료)
EG-DESK 변경 범위: CLAUDE.md 컨벤션 추가 + .mcp.json 1줄

조사 일시: 2026-03-29
출처: github.com/IQAIcom/mcp-discord (README, src/tools/, src/sampling.ts)

---

### Finding: Slack MCP Tool 상세 + UX 흐름 (explore-agent-6)

#### 1. Slack MCP Tool 상세 목록

**A. 공식 Anthropic MCP Server (@modelcontextprotocol/server-slack) — 8 tools**

| # | Tool 이름 | 필수 파라미터 | 선택 파라미터 | 설명 |
|---|-----------|-------------|-------------|------|
| 1 | slack_list_channels | - | limit (number, max 200), cursor (string) | 퍼블릭 채널 목록 |
| 2 | slack_post_message | channel_id, text | - | 채널에 메시지 전송 |
| 3 | slack_reply_to_thread | channel_id, thread_ts, text | - | 스레드 reply |
| 4 | slack_add_reaction | channel_id, timestamp, reaction | - | 이모지 반응 추가 |
| 5 | slack_get_channel_history | channel_id | limit (number, default 10) | 채널 최근 메시지 조회 |
| 6 | slack_get_thread_replies | channel_id, thread_ts | - | 스레드 reply 전체 조회 |
| 7 | slack_get_users | - | cursor, limit (max 200) | 워크스페이스 유저 목록 |
| 8 | slack_get_user_profile | user_id | - | 유저 프로필 상세 |

필요 Slack scopes: channels:history, channels:read, chat:write, reactions:write, users:read, users.profile:read

출처: https://github.com/modelcontextprotocol/servers-archived/tree/main/src/slack

**B. korotovsky/slack-mcp-server (1.5k stars) — 15 tools**

| # | Tool 이름 | 필수 파라미터 | 주요 선택 파라미터 | 설명 | 기본 활성 |
|---|-----------|-------------|------------------|------|----------|
| 1 | conversations_history | channel_id | limit (default "1d"), cursor, include_activity_messages | 채널 메시지 조회 (기간/개수 지정) | Yes |
| 2 | conversations_replies | channel_id, thread_ts | limit, cursor, include_activity_messages | 스레드 메시지 조회 | Yes |
| 3 | conversations_add_message | channel_id, payload | thread_ts, content_type (default "text/markdown") | 메시지 전송 (마크다운 지원) | No (안전) |
| 4 | conversations_search_messages | - | search_query, filter_in_channel, filter_users_from, filter_date_*, filter_threads_only, limit | 메시지 검색 (Bot Token 불가) | Yes |
| 5 | channels_list | channel_types | sort, limit (default 100), cursor | 채널 목록 CSV | Yes |
| 6 | reactions_add | channel_id, timestamp, emoji | - | 이모지 추가 | No |
| 7 | reactions_remove | channel_id, timestamp, emoji | - | 이모지 제거 | No |
| 8 | users_search | query | limit (default 10) | 유저 검색 (이름/이메일/표시명) | Yes |
| 9 | usergroups_list | - | include_users, include_count, include_disabled | 유저 그룹 목록 | Yes |
| 10 | usergroups_create | name | handle, description, channels | 유저 그룹 생성 | No |
| 11 | usergroups_update | usergroup_id | name, handle, description, channels | 유저 그룹 수정 | No |
| 12 | usergroups_users_update | usergroup_id, users | - | 그룹 멤버 교체 | No |
| 13 | usergroups_me | action (list/join/leave) | usergroup_id | 내 그룹 관리 | Yes |
| 14 | conversations_unreads | - | include_messages, channel_types, max_channels, max_messages_per_channel, mentions_only | 미읽 메시지 (DM > 파트너 > 내부 우선순위) | Yes |
| 15 | conversations_mark | channel_id | ts | 읽음 표시 | No |

활성화 환경변수:
- `SLACK_MCP_ADD_MESSAGE_TOOL=true` → conversations_add_message, reactions_add/remove 활성화
- `SLACK_MCP_MARK_TOOL=true` → conversations_mark 활성화
- `SLACK_MCP_ENABLED_TOOLS=tool1,tool2` → 선택적 tool 등록

출처: https://github.com/korotovsky/slack-mcp-server

**C. Slack 공식 MCP Plugin (slackapi/slack-mcp-plugin) — 최신**

- Claude Code에서 `/plugin install slack` 또는 CLI에서 `claude plugin install slack`으로 설치
- OAuth 인증 (워크스페이스 관리자 승인 필요)
- HTTP transport (https://mcp.slack.com/mcp)
- Search, Messaging, Canvas, User Management 기능
- 출처: https://github.com/slackapi/slack-mcp-plugin

**D. Claude Code에서의 호출 방식**

`.mcp.json`에 MCP 서버를 등록하면 Claude Code에서 tool 이름 앞에 `mcp__[server-name]__` prefix가 붙어 호출 가능:
- 공식 서버 예: `mcp__slack__slack_post_message`, `mcp__slack__slack_get_channel_history`
- korotovsky 예: `mcp__slack__conversations_history`, `mcp__slack__conversations_add_message`

출처: https://code.claude.com/docs/en/mcp

#### 2. UX 흐름 분석 (3가지 Option)

**Option A: Claude Code 중심 (유저는 Claude Code에서만 작업)**

흐름:
```
유저 → Claude Code (Session Lead)
          ├── SendMessage → Agent (기존 팀 내 통신)
          ├── mcp__slack__slack_post_message → Slack #agent-logs (로깅용)
          └── mcp__slack__slack_get_channel_history ← Slack (agent 토론 열람)
```

실현 가능성: 높음
- `mcp__slack__slack_get_channel_history(channel_id, limit)` 으로 Claude Code 안에서 채널 메시지 fetch 가능
- `mcp__slack__slack_get_thread_replies(channel_id, thread_ts)` 으로 특정 스레드 대화 전체 조회 가능
- 유저가 "Slack에서 agent 토론 보여줘" 라고 하면 Session Lead가 MCP tool로 fetch하여 텍스트로 표시

장점:
- 유저 워크플로우 변경 없음 (Claude Code만 사용)
- Slack은 순수 로깅/백업 채널 (유저가 가끔 확인)
- 기존 SendMessage 기반 팀 통신과 병행 가능

단점:
- Slack 메시지가 Claude Code context window를 소비
- fetch한 메시지를 파싱/요약해야 함 (raw 메시지 길 수 있음)
- agent 간 실시간 통신에 Slack을 쓰면 150-700ms 지연 추가

**Option B: Slack 중심 (유저가 Slack에서 지시)**

흐름:
```
유저 → Slack (bot mention) → ???  → Claude Code 세션
```

실현 가능성: 낮음 (직접 연결 불가)
- Slack에서 bot을 @mention → Slack Bot이 이벤트 수신까지는 가능
- 문제: Slack Bot이 수신한 메시지를 "현재 실행 중인 Claude Code 세션"에 전달하는 표준 메커니즘이 없음
- Claude Code는 stdin/stdout 기반 CLI 또는 web session — 외부에서 메시지를 주입하는 공식 API 없음
- tuannvm/slack-mcp-client가 이 방향(Slack → MCP servers)이지만, Claude Code 세션이 아닌 독립 LLM 인스턴스를 호출

가능한 workaround:
- Slack Bot이 파일에 메시지를 쓰고, Claude Code 세션이 polling으로 읽기 → 매우 불안정
- Slack Bot이 별도 Claude API 호출 → 현재 세션과 무관한 새 세션 생성

장점: (이론적)
- Slack UI가 더 친숙한 유저에게 편리
- 모바일 Slack에서 지시 가능

단점:
- Slack → Claude Code 방향 실시간 연동 불가 (핵심 차단)
- 별도 인프라 필요 (Slack Bot + Claude API 호출 서버)
- 기존 팀 시스템(SendMessage)과 완전 별개 구조

**Option C: 하이브리드 (유저=Claude Code, agent간=Slack)**

흐름:
```
유저 ↔ Session Lead: Claude Code (SendMessage — 기존)
Agent ↔ Agent: Slack MCP (mcp__slack__conversations_add_message)
유저 관찰: mcp__slack__slack_get_channel_history (on-demand fetch)
```

실현 가능성: 중간 (기술적으로 가능하나 복잡)

구현 시나리오:
1. Session Lead가 worker에게 task 지시 시, worker는 Slack #task-channel에 진행 상황 post
2. Worker 간 논의가 필요하면 Slack 스레드에서 진행
3. Session Lead가 주기적으로 `conversations_history` 로 요약 fetch
4. 유저가 "agent들 뭐 하고 있어?" → Session Lead가 Slack fetch → 요약 보고

핵심 기술 문제:
- Agent가 MCP tool을 직접 호출할 수 있는가? — Claude Code Team의 teammate agent들은 MCP tool 접근이 제한적. `.mcp.json`에 등록된 MCP 서버는 session 레벨에서 공유되므로 teammate agent도 호출 가능할 수 있으나, agent template의 `tools` 필드에 MCP tool을 명시적으로 허용해야 할 수 있음
- 1 Bot App 제한: 모든 agent가 1개 Bot Token으로 post → 발신자 구분이 "Bot 이름"으로 통일. 메시지 본문에 agent 이름을 명시해야 식별 가능
- 채널당 1msg/sec: 16 agent가 동시에 같은 채널에 post하면 병목. agent별 채널 분리 또는 throttling 필요

장점:
- agent 간 토론이 Slack에 영구(90일) 기록됨 — SendMessage는 세션 종료 시 소실
- 유저가 Slack 앱에서 실시간으로 agent 활동 모니터링 가능
- 기존 SendMessage 기반 핵심 통신은 유지 (저지연)

단점:
- 이중 통신 채널 관리 복잡성
- MCP tool 호출이 agent context window를 소비
- Slack API 호출 비용 (지연 150-700ms per call)
- 1 Bot 제약으로 발신자 식별 어려움

#### 3. Option 비교 요약

| 기준 | Option A (CC 중심) | Option B (Slack 중심) | Option C (하이브리드) |
|------|-------------------|---------------------|---------------------|
| 실현 가능성 | 높음 | 낮음 | 중간 |
| 구현 복잡도 | 낮음 | 높음 | 중간 |
| 유저 UX 변경 | 없음 | 큼 | 없음 |
| Agent 간 통신 | SendMessage (기존) | Slack | Slack + SendMessage |
| 통신 로그 보존 | 세션 내 | 90일 | SendMessage=세션, Slack=90일 |
| 지연 시간 | 기존 수준 | 150-700ms | 핵심=기존, 보조=150-700ms |
| Slack 활용도 | 로깅/모니터링 | 주 채널 | 보조 채널 |
| 추천 대상 | 현 시점 최선 | 비추천 | 장기적 고려 |

#### 4. 권장 사항

현 시점 추천: Option A (Claude Code 중심)

이유:
1. 기존 SendMessage 기반 팀 통신을 유지하면서 Slack을 보조로 추가
2. MCP tool로 Slack 읽기/쓰기 모두 가능 — 추가 인프라 불필요
3. `.mcp.json`에 korotovsky/slack-mcp-server 또는 공식 plugin 등록만 하면 즉시 사용
4. agent가 중요 이벤트(task 완료, 에러, 결과)를 Slack에 post → 유저가 Slack 앱에서 passive 모니터링

설정 예시 (.mcp.json):
```json
{
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": ["-y", "@anthropic/slack-mcp-server"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-...",
        "SLACK_TEAM_ID": "T..."
      }
    }
  }
}
```

또는 공식 plugin: `claude plugin install slack` (OAuth 자동 처리)

조사 일시: 2026-03-29
출처: code.claude.com/docs/en/mcp, github.com/slackapi/slack-mcp-plugin, github.com/modelcontextprotocol/servers-archived/tree/main/src/slack, github.com/korotovsky/slack-mcp-server

---

### Finding: Telegram MCP Tool 상세 + 실제 사용 사례 (explore-agent-3)

#### 1. Telegram MCP Tool 상세 목록

**최성숙 프로젝트: chigwell/telegram-mcp (Python, Telethon 기반)**

70+ tools 제공. 핵심 카테고리:

**메시징 (18 tools)**

| Tool | 파라미터 | 용도 |
|------|---------|------|
| `send_message` | chat_id, message | 메시지 전송 |
| `get_messages` | chat_id, page, page_size | 페이지네이션 메시지 조회 |
| `list_messages` | chat_id, limit, search_query, from_date, to_date | 필터링 메시지 조회 |
| `list_topics` | chat_id, limit, offset_topic, search_query | Forum 토픽 목록/검색 |
| `reply_to_message` | chat_id, message_id, text | 특정 메시지에 답장 |
| `edit_message` | chat_id, message_id, new_text | 메시지 수정 |
| `delete_message` | chat_id, message_id | 메시지 삭제 |
| `forward_message` | from_chat_id, message_id, to_chat_id | 메시지 전달 |
| `pin_message` | chat_id, message_id | 메시지 고정 |
| `get_history` | chat_id, limit | 전체 채팅 히스토리 조회 |
| `get_message_context` | chat_id, message_id, context_size | 주변 메시지 조회 |
| `search_messages` | chat_id, query, limit | 채팅 내 메시지 검색 |
| `search_global` | query, page, page_size | 전체 메시지 글로벌 검색 |

**채팅/그룹 관리 (20+ tools)**

| Tool | 용도 |
|------|------|
| `get_chats` / `list_chats` | 채팅 목록 (페이지네이션/필터) |
| `get_chat` | 채팅 상세 정보 |
| `create_group` / `create_channel` | 그룹/채널 생성 |
| `invite_to_group` | 멤버 초대 |
| `get_participants` / `get_admins` | 멤버/관리자 목록 |
| `promote_admin` / `demote_admin` | 관리자 승격/강등 |
| `ban_user` / `unban_user` | 차단/차단 해제 |

**연락처 (12 tools)**: list_contacts, search_contacts, add_contact, import_contacts 등
**미디어 (7 tools)**: send_file, download_media, upload_file, send_voice, send_sticker 등
**프로필 (6 tools)**: get_me, update_profile, set_profile_photo 등
**초안 (3 tools)**: save_draft, get_drafts, clear_draft
**검색 (4 tools)**: search_public_chats, search_messages, search_global, resolve_username

**인증**: Telethon (User Account API) — `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION_STRING` 필요. my.telegram.org/apps에서 발급.

**핵심 차이점**: Telethon = User Bot (사용자 계정 API) → 봇 간 통신 제약 없음 (Bot API 한계 우회). 메시지 검색, 히스토리 조회, 글로벌 검색 모두 가능.

출처: https://github.com/chigwell/telegram-mcp

**대안: guangxiangdebizi/telegram-mcp (TypeScript, Bot API 기반)**

7 tools만 제공 (send_message, send_photo, send_document, send_video, forward_message, delete_message, get_chat). Bot Token 인증. 메시지 검색/히스토리 조회 불가.

출처: https://github.com/guangxiangdebizi/telegram-mcp

**Claude Code 호환성**: 두 프로젝트 모두 MCP 서버 → Claude Desktop/Cursor/Claude Code에서 호출 가능. chigwell/telegram-mcp는 `claude_desktop_config.json`에 설정 예시 제공.

#### 2. 실제 사용 사례

**사례 1: claude-slack (theo-nash/claude-slack) — Agent-to-Agent 통신 전용**

정체: MCP 기반 분산 지식 시스템. "Git for Agent Knowledge meets Slack for AI Systems."

해결 문제: AI agent의 세션 간 컨텍스트 손실 (agent amnesia)

핵심 기능:
- Channel messaging: 프로젝트/글로벌 채널에 broadcast
- Direct messaging: agent 간 1:1 통신
- Semantic search: 의미 기반 지식 검색 (Qdrant 벡터 저장소)
- Note writing: confidence score + metadata 포함 학습 기록

아키텍처: SQLite (메시지 저장) + Qdrant (벡터 검색) + SSE (실시간 이벤트) + FastAPI + React/Next.js UI

프로젝트 격리: 기본적으로 프로젝트별 격리. cross-project 협업은 명시적 링킹 필요.

출처: https://github.com/theo-nash/claude-slack

**사례 2: OpenClaw — 20+ 메시징 플랫폼 통합 AI Agent**

규모: GitHub 250,000+ stars (2026-03 기준, React 초과)

통합 채널: WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Lark 등 20+

아키텍처: MCP 프로토콜로 email, calendar, browser, file system, code editor 연결. Sub-agent를 OpenWebUI로 오케스트레이션.

Telegram Forum Topics 활용: per-topic session isolation 요청 (Issue #1532) + DM with forum/topics 라우팅 (Issue #17980) → 실제 커뮤니티에서 Forum Topics를 agent 분리에 사용하는 패턴 확인.

출처: https://www.oreilly.com/radar/what-openclaw-reveals-about-the-next-phase-of-ai-agents/

**사례 3: Claude Code in Slack (공식)**

Slack 채널에서 `@Claude` 멘션 → 자동으로 Claude Code 세션 생성 → 개발 작업 위임. 채널(public/private)에서만 동작, DM 불가.

출처: https://code.claude.com/docs/en/slack

**사례 4: Composio Slack MCP**

Slack MCP 서버로 메시지 읽기/쓰기, 채널 관리, 파일 관리, 리마인더, 멤버 조회 등을 AI agent에 제공.

출처: https://composio.dev/toolkits/slack/framework/claude-code

#### 3. UX 흐름 (Telegram Forum Topics 패턴)

**1개 봇 + Forum Topics 패턴으로 봇 간 통신 불가 우회**

핵심 발견: chigwell/telegram-mcp는 Telethon (User Account API) 사용 → Bot API의 "봇 간 통신 불가" 제약이 적용되지 않음. 1개 User Bot 계정으로 모든 agent 통신을 중계 가능.

Forum Topics agent 분리 패턴 (실제 커뮤니티에서 사용 확인):

```
Telegram Supergroup (Forum 모드)
├── [General] — 전체 공지/오케스트레이션
├── [Agent: Researcher] — 조사 agent 전용 토픽
├── [Agent: Coder] — 코딩 agent 전용 토픽
├── [Agent: Reviewer] — 리뷰 agent 전용 토픽
└── [Sprint Log] — 작업 로그/결과
```

세션 격리 키: `chatId:topicId` 형식으로 각 토픽별 독립 컨텍스트 유지

message_thread_id 지원: sendMessage, sendPhoto, sendVideo 등 모든 전송 메서드에서 `message_thread_id` 파라미터로 특정 토픽에 메시지 전송 가능

General 토픽 (ID=1): 특수 처리 필요 (Telegram이 고유하게 핸들링)

모바일 UX: 유저가 Telegram 앱에서 Forum Topics를 펼쳐 각 agent의 활동을 실시간 확인. 읽기 전용 관찰 또는 특정 토픽에 직접 개입 가능.

출처: https://core.telegram.org/api/forum, zeroclaw-labs/zeroclaw#1532, sipeed/picoclaw#202

**Telethon vs Bot API 비교 (agent 통신 관점)**

| 측면 | Bot API | Telethon (User API) |
|------|---------|-------------------|
| 봇 간 통신 | 불가 | 가능 (User 계정이므로) |
| 메시지 검색 | 불가 | search_messages, search_global |
| 히스토리 조회 | 불가 (getUpdates만) | get_history, get_messages |
| Forum Topics | sendMessage의 message_thread_id | list_topics + 전체 CRUD |
| Rate limit | 그룹 20 msg/min | 더 느슨 (정확한 수치 데이터 없음) |
| 인증 | Bot Token (@BotFather) | API ID/Hash + Session String (my.telegram.org) |
| MCP 서버 | guangxiangdebizi (7 tools) | chigwell (70+ tools) |

#### 확인 불가 항목

| 항목 | 사유 |
|------|------|
| Telethon User Bot의 정확한 rate limit | 공식 문서 미기재, 동적 조정 |
| chigwell/telegram-mcp의 GitHub stars 수 | WebFetch에서 미확인 |
| Telegram TOS에서 User Bot 사용 허용 여부 | Telegram은 공식적으로 User Bot을 금지하지 않으나 abuse 시 계정 제한 가능 (명확한 정책 데이터 없음) |

조사 일시: 2026-03-29
출처: github.com/chigwell/telegram-mcp, github.com/guangxiangdebizi/telegram-mcp, github.com/theo-nash/claude-slack, code.claude.com/docs/en/slack, composio.dev/toolkits/slack/framework/claude-code, core.telegram.org/api/forum

---

## Round 6: Local Agent Messaging Patterns (Raw)

### Finding: nodeskclaw 로컬 메시징/통신 버스 패턴 (explore-agent-10)

#### 1. Agent간 로컬 메시징 메커니즘: 3계층 메시지 버스

nodeskclaw는 agent간 통신에 3가지 독립된 메시징 계층을 사용.

**1A. MessageBus — 9단계 미들웨어 파이프라인**
- `message_bus.publish(envelope, db=db)` -> 9단계 미들웨어 체인 -> TransportAdapter를 통해 실제 전달
- 모든 agent간 메시지가 이 파이프라인을 경유

**1B. broadcast_event() — In-memory Pub-Sub (소스: `api/workspaces.py` L1266-1274)**
```python
_workspace_queues: dict[str, set[asyncio.Queue]] = {}

def broadcast_event(workspace_id: str, event_type: str, data: dict):
    queues = _workspace_queues.get(workspace_id, set())
    for q in queues:
        q.put_nowait({"event": event_type, "data": data})
    asyncio.ensure_future(_cross_instance_push(workspace_id, event_type, data))
```
- workspace별 in-memory asyncio.Queue 집합 — 순수 pub-sub 패턴
- 각 SSE 연결이 Queue를 등록하고, `broadcast_event()`가 모든 Queue에 이벤트 push
- 이벤트 타입: `agent:typing`, `agent:chunk`, `agent:done`, `agent:error`, `agent:sse_connected`, `agent:sse_disconnected`, `agent:status`, `system:info`, `human:message_delivered`
- EG-DESK 참고: 이것은 EG-DESK의 SSE 이벤트 전달과 동일한 패턴이지만, workspace 단위로 격리

**1C. EventBus (K8s) — Deploy 전용 이벤트 버스 (소스: `k8s/event_bus.py`)**
- `event_bus.publish("deploy_progress", {...})` -> SSE subscriber들에게 전달
- 별도의 Pub-Sub 인스턴스로, workspace event와 분리

#### 2. 외부 서비스 없이 agent간 통신: WebSocket + PostgreSQL 조합

nodeskclaw는 외부 메시지 브로커(Redis, RabbitMQ 등) 없이 순수 WebSocket + PostgreSQL로 agent간 통신을 구현.

통신 경로:
```
Agent A (K8s Pod)
  --WebSocket--> Backend Pod 1 (TunnelAdapter)
    --PostgreSQL message_queue 테이블--> Backend Pod 2 (QueueConsumer)
      --WebSocket--> Agent B (K8s Pod)
```

- 동일 Pod 연결: Agent A와 B가 같은 backend Pod에 연결되어 있으면 in-memory 직접 전달 (TunnelAdapter._connections dict)
- 다른 Pod 연결: PGMQ 테이블에 enqueue -> PG NOTIFY로 target Pod 알림 -> target Pod의 QueueConsumer가 dequeue -> WebSocket 전달
- SSE cross-instance: `_cross_instance_push()` (소스: L1277-1301) — 다른 Pod의 SSE 클라이언트에게 PG NOTIFY로 이벤트 포워딩

EG-DESK 참고: EG-DESK는 단일 프로세스 내 SendMessage. nodeskclaw는 다중 Pod 분산 환경에서도 PostgreSQL만으로 메시지 라우팅 + 순서 보장 + 내구성 확보. Redis 같은 외부 브로커 불필요.

#### 3. Presence/Heartbeat/Alive 확인: 3중 레이어

**3A. Tunnel Ping/Pong — Agent 레벨 liveness**
- 30초 간격 ping, 45초 타임아웃
- 실패 시 WebSocket 강제 종료(code=4020) + `agent:sse_disconnected` broadcast

**3B. SSE Heartbeat — Frontend 연결 레벨 liveness**
- 15초 간격 heartbeat, 30초 타임아웃
- `cleanup_stale_connections()`: stale SSE 연결 soft-delete

**3C. Agent Health Scanner — 통합 레벨 health (소스: `failure_recovery.py`)**
- 30초 간격 background task
- Dual-layer: SSE heartbeat scan + tunnel connection probe (`tunnel_adapter.health_check()`)
- NodeCard 상태 업데이트: `active` <-> `unhealthy`
- 이것이 "agent가 살아있는지" 확인하는 최종 통합 메커니즘

#### 4. Incremental 메시지 수신: Cursor/Offset 패턴

**4A. Workspace Events SSE — 실시간 스트림 (전체 Read 아닌 incremental)**
(소스: `api/workspaces.py` L1317+)
- `GET /{workspace_id}/events` -> SSE StreamingResponse
- 각 클라이언트가 자신의 asyncio.Queue를 등록 -> 새 이벤트만 push 받음
- 초기 스냅샷 + 이후 incremental: 연결 시 `_build_agent_status_snapshot()`으로 현재 상태 전달 -> 이후 real-time delta만 수신

**4B. EventLog 쿼리 — since 파라미터 기반 cursor**
(소스: `runtime/messaging/event_log.py` L84-106)
```python
async def get_workspace_events(db, workspace_id, *, event_type=None, limit=100, since=None):
    if since:
        stmt = stmt.where(EventLog.created_at >= since)
```
- `since` datetime 파라미터로 마지막 조회 이후 이벤트만 가져오는 cursor 패턴

**4C. QueueConsumer PG NOTIFY wake — Polling 대체**
(소스: `queue_consumer.py`)
- `asyncio.wait_for(_notify_event.wait(), timeout=5s)`: PG NOTIFY로 즉시 깨어남, 5초 polling은 폴백
- `target_hint`: NOTIFY payload에서 target node ID 추출 -> 해당 node만 dequeue (불필요한 전체 스캔 방지)

**4D. Workspace Message 검색 — 시간 범위 필터**
(소스: `workspace_message_service.py` L66-80)
- `search_messages(db, workspace_id, q=None, from_at=None, to_at=None)`: 시간 범위 + 키워드 기반 incremental 검색

#### 5. Corridor/Blackboard 외 추가 통신 채널

**5A. 4가지 라우팅 모드 (통신 채널 관점)**
- unicast: 명시적 1:1 DM (target 지정)
- multicast: 명시적 1:N (targets 배열)
- broadcast: topology BFS 기반 전체 전파 (corridor 경유)
- anycast: 가장 여유 있는 1개 노드 선택

**5B. @mention 기반 주의 집중 채널**
- CloudEvents envelope의 `data.mentions` 필드
- SemanticMiddleware: mentions 있으면 priority CRITICAL + urgency IMMEDIATE로 승격
- TunnelAdapter deliver: 멘션 대상이면 "반드시 응답" 지시 주입, 비대상이면 `no_reply=True`
- 이것은 "DM"과 "broadcast" 사이의 중간 채널 — broadcast이지만 특정 agent에게만 응답 의무 부여

**5C. collaboration.message — Agent 자발적 DM**
(소스: `tunnel/protocol.py`, `collaboration_service.py`)
- TunnelMessageType.COLLABORATION_MESSAGE: agent가 자발적으로 다른 agent에게 메시지 전송
- `target: "agent:<name>"` 또는 `target: "human:<name>"` 형식으로 수신자 지정
- collaboration depth 추적 (MAX_COLLABORATION_DEPTH=3) + 자동 depth 추론 (DB 최근 메시지 기반)
- 이것은 MessageBus를 경유하지 않는 별도 경로 — agent 런타임에서 직접 tunnel로 전송 -> collaboration_service가 처리 -> message_bus.publish()로 재진입

**5D. delegate/escalate — Agent 응답 기반 라우팅**
(소스: `tunnel/adapter.py` L622-690)
- Agent 응답 텍스트에서 `delegate:<target>` / `escalate:<target>` 파싱
- 새 MessageEnvelope 생성 (causationid + correlationid 체인) + IntentType.COLLABORATE
- 이것은 "topic-based routing"의 변형 — 메시지 내용이 라우팅을 결정

**5E. Blackboard Proposals/Tasks — 비동기 게시판 통신**
(소스: `workspace_service.py` — Blackboard CRUD, Task/Objective 관리)
- Blackboard: workspace 전체 공유 게시판 (posts + replies)
- Tasks: 작업 할당 (title, description, estimated_value, priority, assignee)
- Objectives: OKR 계층 (objective -> key_results -> tasks)
- 이것은 실시간 메시지가 아닌 "비동기 게시판" 통신 채널 — EG-DESK의 .tmp/agent-context/ 파일 기반 소통과 유사하나 DB 기반

#### 종합: nodeskclaw 통신 채널 전체 맵

| 채널 | 방식 | 동기성 | 범위 | EG-DESK 대응 |
|------|------|--------|------|-------------|
| MessageBus (9단계) | CloudEvents pipeline | 비동기 | workspace topology | SendMessage |
| broadcast_event() | In-memory Queue pub-sub | 실시간 | workspace SSE | (없음) |
| Tunnel WebSocket | 양방향 스트리밍 | 실시간 | 1:1 backend<->agent | (없음) |
| PGMQ + PG NOTIFY | PostgreSQL queue | 비동기+알림 | cross-Pod | (없음) |
| collaboration.message | Tunnel -> MessageBus | 비동기 | 1:1 agent->agent | SendMessage DM |
| delegate/escalate | 응답 텍스트 파싱 | 비동기 | 1:1 chain | sprint-leader->worker |
| @mention | CloudEvents extension | 실시간 | broadcast+집중 | SendMessage to="*" |
| Blackboard | DB CRUD | 비동기 | workspace 전체 | .tmp/agent-context/ |

조사 일시: 2026-03-29
출처: github.com/NoDeskAI/nodeskclaw (api/workspaces.py, k8s/event_bus.py, tunnel/adapter.py, tunnel/protocol.py, collaboration_service.py, queue_consumer.py, runtime/messaging/event_log.py, workspace_message_service.py, failure_recovery.py)

---

### Finding: agent-deck 로컬 메시징/통신 버스 패턴 (explore-agent-9)

결론: agent-deck에는 agent간 직접 로컬 메시징 메커니즘이 없다. 세션(agent)간 통신은 모두 간접적이며, 전용 메시지 버스/큐/pub-sub 패턴은 구현되어 있지 않다.

#### 1. Agent간 로컬 메시징 메커니즘 — 없음

Conductor는 agent간 메시지를 중계하지 않는다. Conductor의 역할:
- 자식 세션의 상태를 관찰 (running/waiting/idle/error)
- waiting 세션에 자동 응답 또는 에스컬레이션
- "Never send messages to running sessions" — 상태 관찰만, 메시지 중계 안 함

통신 방법: Conductor가 자식 세션에 메시지를 보내려면 `agent-deck session send <session> <message>` CLI 명령 사용. 이것은 tmux pane에 키스트로크를 직접 주입하는 방식 (tmux `send-keys`). 메시지 큐나 채널이 아님.

- 소스 확인: conductor_templates.go — `agent-deck session send` 명령어 문서
- 메커니즘: CLI → tmux `send-keys` → 세션의 stdin에 텍스트 주입

#### 2. 외부 서비스 없이 agent간 통신 — StateDB는 통신용이 아님

**SQLite StateDB**

StateDB의 6개 테이블 중 메시지/이벤트 테이블은 없다:
- `metadata`: K/V (schema_version, last_modified)
- `instances`: 세션 레코드 (상태 저장용)
- `groups`: 그룹 구조
- `instance_heartbeats`: 프로세스 liveness (통신 아님)
- `recent_sessions`: 삭제된 세션 스냅샷
- `cost_events`: 비용 추적

StateDB는 상태 동기화용이지 메시지 전달용이 아님. `last_modified` 폴링으로 "데이터가 변경되었는지"만 감지.

**WebSocket**

WebSocket (`/ws/session/{id}`)은 UI 터미널 브리지 전용:
- 클라이언트→서버: `ping`, `input` (터미널 입력), `resize`
- 서버→클라이언트: `status`, `error`
- 세션간 통신 불가 — 각 WebSocket은 단일 sessionID에 바인딩
- pub-sub, broadcast, 채널 패턴 없음

**SSE (`/events/menu`)**

- 서버→클라이언트 단방향
- 메뉴 상태 변경 알림만 (SHA256 fingerprint 비교로 중복 방지)
- 2초 간격 폴링 + 15초 keepalive
- agent간 통신과 무관 — UI 업데이트 전용

#### 3. Presence/Heartbeat — instance_heartbeats

`instance_heartbeats` 테이블은 agent-deck 프로세스 수준 presence:
- 여러 agent-deck 인스턴스(프로세스)가 동시 실행 시 누가 primary인지 결정
- `ElectPrimary(timeout)`: heartbeat 기반 leader election
- stale entry 자동 정리
- 세션(agent) 수준이 아닌 프로세스 수준 — "이 agent-deck 인스턴스가 살아있는가?"를 확인

Conductor의 heartbeat는 별개:
- 주기적 (기본 15초)으로 `agent-deck session send`로 conductor 세션에 상태 요약 전달
- 이것도 tmux send-keys 기반

#### 4. Incremental 메시지 수신 — 없음

- StateDB: `last_modified` 폴링 (증분 아님, 전체 상태 비교)
- SSE: 2초 폴링 + SHA256 비교 (증분 아님)
- WebSocket: 터미널 I/O만 (메시지 수신과 무관)
- 증분 메시지 수신(예: "새 메시지 N개 도착")은 미구현

#### 5. 세션간 통신 — CLI 키스트로크 주입만

여러 agent-deck 인스턴스가 서로 통신하는 패턴:
- StateDB 공유: WAL 모드로 여러 프로세스가 동일 SQLite DB 읽기/쓰기 → 상태 동기화 (메시지 전달 아님)
- 소켓 재사용: `DiscoverExistingSockets()`로 다른 인스턴스의 MCP 소켓 감지 → MCP 프로세스 공유 (통신 아님)
- 직접 메시지 교환 메커니즘 없음

유일한 "통신":
```
Conductor → `agent-deck session send "session-name" "message text"`
         → tmux send-keys → 세션 stdin에 텍스트 주입
```

이것은 터미널에 타이핑하는 것과 동일 — 구조화된 메시지 프로토콜이 아님.

#### 요약: agent-deck의 통신 아키텍처

```
┌─────────────────────────────────────────────┐
│              agent-deck                      │
│                                              │
│  Conductor ──(CLI send-keys)──→ Session A    │
│     │                                        │
│     ├──(CLI send-keys)──→ Session B          │
│     │                                        │
│     └──(heartbeat script)──→ 자기 자신       │
│                                              │
│  StateDB ←──(폴링)──→ 다른 agent-deck 인스턴스│
│  (상태 동기화만, 메시지 전달 없음)             │
│                                              │
│  WebSocket ──→ Web UI (터미널 I/O만)         │
│  SSE ──→ Web UI (메뉴 상태만)                │
│                                              │
│  ❌ 메시지 큐 없음                           │
│  ❌ Pub-Sub 없음                             │
│  ❌ 채널 패턴 없음                           │
│  ❌ Agent간 직접 메시징 없음                  │
└─────────────────────────────────────────────┘
```

#### EG-DESK 시사점

agent-deck이 agent간 직접 메시징을 구현하지 않은 것은 설계 선택:
- tmux 기반 세션 관리이므로, "세션에 텍스트를 보내는 것" = "터미널에 타이핑하는 것"
- 이것으로 충분한 이유: Conductor가 중앙 조율자로서 모든 통신을 중계

EG-DESK의 SendMessage는 이미 agent-deck보다 진보된 통신 메커니즘. Discord/Matrix/로컬 MCP 메시지 버스를 추가하면 agent-deck이 해결하지 못한 "구조화된 agent간 통신" 문제를 해결할 수 있음.

조사 일시: 2026-03-29
출처: github.com/asheshgoplani/agent-deck (conductor_templates.go, StateDB 스키마, WebSocket/SSE 핸들러)

---

### Finding: hermes-agent 로컬 메시징/통신 버스 패턴 (explore-agent-4)

결론: hermes-agent에는 전용 메시징 버스가 없고 in-process 메커니즘만 존재.

#### 1. Agent간 로컬 메시징 메커니즘 — 없음

- delegate_task 외에 agent간 직접 메시지 교환, pub-sub, event bus 패턴은 코드에 존재하지 않음
- agent간 유일한 통신 경로는 delegate_task의 goal/context 전달 → 결과 반환
- 코드 전체에서 pub-sub, event emitter, message bus 패턴 검색 결과 없음

#### 2. 외부 서비스 없이 agent간 통신 — in-process Python 객체만

- 모든 subagent 통신은 같은 프로세스 내 Python 객체를 통해 이루어짐
- 파일 기반 통신 없음, SQLite 기반 agent간 통신 없음
- parent가 child AIAgent 객체를 직접 생성하고 `run_conversation()` 호출 → return dict로 결과 수신
- batch 모드: `ThreadPoolExecutor` + `concurrent.futures` — 같은 프로세스 내 thread pool

#### 3. Presence/Heartbeat/Alive 확인 — 없음 (interrupt propagation만 존재)

- heartbeat, liveness check 메커니즘 없음
- 대신 interrupt propagation 패턴 존재:
  - `parent._active_children` 리스트 + `_active_children_lock` (threading.Lock)
  - child 생성 시 parent의 `_active_children`에 등록 (delegate_tool.py L241-248)
  - child 완료/실패 시 `_active_children`에서 제거 (delegate_tool.py L388-398)
  - parent가 Ctrl+C (KeyboardInterrupt) 받으면 `_active_children` 순회하여 child에 interrupt 전파 (run_agent.py L2134-2135)
- 이것은 "살아있는지 확인"이 아니라 "죽이기 위한 추적" — presence가 아닌 cleanup 목적
- 출처: run_agent.py L561-562, L2134-2135; delegate_tool.py L241-248, L388-398

#### 4. Incremental 메시지 수신 — progress callback으로 부분 실현

- subagent 결과 자체는 스트리밍이 아닌 blocking wait + 최종 결과 dict 반환
- 그러나 실시간 progress callback으로 중간 상태를 부분적으로 수신:
  - `tool_progress_callback`: child의 매 tool call이 parent에 relay됨
  - CLI: parent spinner 위에 `├─ tool_name "preview"` 트리뷰 표시
  - Gateway: tool names를 5개씩 batch하여 `subagent_progress` 이벤트로 parent callback relay
  - `_thinking` 이벤트: child의 reasoning text 55자 preview를 parent에 전달
- 그러나 이것은 child의 최종 응답 스트리밍이 아님 — tool call 이름/preview만 relay. child의 실제 output은 `run_conversation()` 완료 후에만 접근 가능.
- 출처: delegate_tool.py L78-147 (_build_child_progress_callback)

#### 5. Parent-Child 통신 패턴 구체적 흐름

```
[Parent AIAgent]
  │
  ├─ _build_child_agent(goal, context, toolsets, ...) → Child AIAgent 객체 생성 (main thread)
  │   ├─ child.ephemeral_system_prompt = focused prompt (goal + context만)
  │   ├─ child.skip_context_files = True (SOUL.md, AGENTS.md 등 로드 안 함)
  │   ├─ child.skip_memory = True (MEMORY.md, USER.md 로드 안 함)
  │   ├─ child.enabled_toolsets = parent toolsets ∩ requested toolsets
  │   └─ parent._active_children.append(child)
  │
  ├─ Single mode:
  │   └─ child.run_conversation(user_message=goal) → blocking → result dict
  │
  ├─ Batch mode (max 3):
  │   └─ ThreadPoolExecutor.submit(child.run_conversation, ...) × N
  │       └─ as_completed(futures) → 완료 순서대로 result dict 수집
  │
  └─ 결과 처리:
      ├─ result dict 구조: {status, summary, api_calls, duration_seconds, exit_reason, tokens, tool_trace}
      ├─ parent context에는 delegation call + summary만 포함 (child 중간 과정 미포함)
      └─ parent._active_children.remove(child)
```

핵심: 모든 통신이 in-process Python 함수 호출 + return value. 외부 메시징, 파일, DB, queue 없음. parent가 child를 직접 instantiate하고 method call로 실행. 결과는 JSON string으로 반환.

#### EG-DESK 비교

| 측면 | hermes-agent | EG-DESK |
|------|-------------|---------|
| 통신 방식 | in-process method call + return | SendMessage tool (Claude Code native) |
| 비동기성 | ThreadPoolExecutor (batch) 또는 blocking (single) | background agent + DM |
| 메시지 버스 | 없음 | Claude Code의 teammate messaging |
| Heartbeat | 없음 (interrupt propagation만) | TeammateIdle hook |
| 중간 결과 | progress callback (tool name preview) | DM으로 중간 보고 |
| Agent 발견 | parent가 직접 생성 | TeamCreate + Agent spawn |

hermes-agent는 외부 메시징 인프라 없이 in-process 통신만 사용. EG-DESK의 SendMessage/DM 기반 agent간 통신과는 근본적으로 다른 아키텍처.

조사 일시: 2026-03-29
출처: github.com/NousResearch/hermes-agent (run_agent.py, delegate_tool.py)

---

### Paperclip AI 심층 조사 (2026-03-30)

#### 기본 정보

- **GitHub**: https://github.com/paperclipai/paperclip
- **Stars**: 40K
- **언어**: TypeScript (Node.js 20+, React, PostgreSQL)
- **컨셉**: "AI 회사의 OS" — zero-human company 오케스트레이션

#### 핵심 메커니즘

1. **Heartbeat Scheduling**: agent가 연속 실행이 아닌 정기 깨우기(4h/8h/24h). 중복 깨우기 병합(coalesce). Session resume across heartbeats.
2. **Atomic Checkout**: task 중복 할당 방지 (DB-level 409 Conflict). 한 번에 하나의 Agent만 task 소유. Budget enforcement와 atomic.
3. **Goal Cascading**: Company Mission → Project Goals → Tasks. 모든 Agent가 항상 "왜"를 알고 있음. Full goal ancestry가 task에 포함.
4. **Ticket-based 비동기 통신**: agent 간 직접 메시징 아닌 immutable append-only ticket 시스템. Thread로 연결된 완전한 대화 기록.
5. **Runtime Skill Injection**: retraining 없이 symlink로 전체 fleet에 새 skill 동시 배포.
6. **Immutable Audit Trail**: 모든 tool call, decision 편집/삭제 불가. Compliance/accountability 보장.
7. **Budget Enforcement**: 100% → auto-pause, 80% → warning. Board override 가능하지만 투명 기록.

#### Claude Code 호환

- Dedicated Claude Local Adapter
- Session persistence (session ID 저장 → 다음 heartbeat에서 재개)
- Skills symlink로 --add-dir flag 전달
- CWD-aware: 작업 디렉토리 변경 시 fresh session

#### 특이점

- Company OS 메타포 (org chart, reporting lines, delegation)
- Multi-Company Support (single deployment)
- Zero SQL Migrations (embedded PostgreSQL)
- Unopinionated agent runtime (Claude Code, OpenClaw, Cursor, Python, Bash, HTTP)

#### EG-DESK Swarm 비교

| Paperclip | EG-DESK V2 |
|-----------|-----------|
| Heartbeat scheduling | TeammateIdle hook + keep-alive |
| Atomic checkout | 없음 (SendMessage 기반) |
| Goal cascading | WM feasibility + compose-team |
| Ticket-based async | SendMessage DM |
| Runtime skill injection | Skills hot-reload |
| Immutable audit | .tmp/agent-context/ (mutable) |
| Budget enforcement | BATS zone 경고 (soft) |

#### Sources

- https://github.com/paperclipai/paperclip
- https://paperclip.ing/
- https://docs.paperclip.ing/adapters/claude-local
- https://nervegna.substack.com/p/paperclip-the-company-os-your-agents
- https://flowtivity.ai/blog/openclaw-vs-paperclip-ai-agent-framework-comparison/
- https://pub.towardsai.net/paperclip-the-open-source-operating-system-for-zero-human-companies-2c16f3f22182

조사 일시: 2026-03-30
출처: github.com/paperclipai/paperclip, paperclip.ing, docs.paperclip.ing

#### Paperclip Claude Local Adapter 상세

##### CLI 래핑 방식

```
claude [command] --print --output-format stream-json --verbose \
  --resume [sessionId] \
  --model [name] \
  --max-turns [N] \
  --append-system-prompt-file [path] \
  --add-dir [skills-path]
```

##### Session Persistence

- sessionId + CWD 일치 시 `--resume`으로 세션 재개
- CWD 변경 → 새 세션 시작
- sessionParams: { sessionId, cwd, displayId }

##### Skill Injection (Symlink 방식)

- 임시 디렉토리에 Paperclip skill symlink 생성
- `--add-dir /tmp/paperclip-skills-[hash]`로 전달
- 원본 프로젝트 디렉토리 오염 없음
- `ensurePaperclipSkillSymlink()`: created/repaired/skipped 상태 관리
- `buildPersistentSkillSnapshot()`: 설치됨/누락됨/외부 충돌 상태 동기화

##### Environment Isolation

- Claude Code 중첩 실행 방지: CLAUDECODE, CLAUDE_CODE_ENTRYPOINT 등 제거
- Paperclip 표준 env 주입: PAPERCLIP_RUN_ID, PAPERCLIP_TASK_ID, PAPERCLIP_AGENT_ID 등

##### Error Recovery

| 상황 | 감지 | 복구 |
|------|------|------|
| Unknown session | `isClaudeUnknownSessionError()` | 자동 fresh session 재시도 |
| 인증 필요 | `detectClaudeLoginRequired()` | 로그인 URL 반환 |
| Max turns 도달 | `isClaudeMaxTurnsResult()` | 플래그 설정 |
| 프로세스 강제 종료 | timeout | SIGTERM → graceSec → SIGKILL |

##### 코드 구조

```
packages/adapters/claude-local/src/
├── server/execute.ts    — CLI 호출, session 관리
├── server/parse.ts      — JSON stream 파싱, error detection
├── server/skills.ts     — skill listing/syncing
├── server/quota.ts      — 할당량 관리
packages/adapter-utils/src/
├── server-utils.ts      — runChildProcess, skill mounting, env setup
├── session-compaction.ts — 세션 압축
```

##### EG-DESK Swarm 참고 포인트

1. `--output-format stream-json`: CLI를 프로그래매틱 제어하는 핵심 인터페이스
2. Session resume(sessionId + CWD): 시간 단위 heartbeat에서도 세션 유지
3. Env isolation: 중첩 Claude Code 세션 방지 패턴
4. Skill symlink: fleet-wide 동시 배포

##### Sources

- https://docs.paperclip.ing/adapters/claude-local
- https://github.com/paperclipai/paperclip/tree/master/packages/adapters/claude-local
- packages/adapters/claude-local/src/server/execute.ts
- packages/adapter-utils/src/server-utils.ts

조사 일시: 2026-03-30
출처: docs.paperclip.ing/adapters/claude-local, github.com/paperclipai/paperclip (adapter source)
