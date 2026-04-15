# EG-DESK Swarm System v2.0 설계서

**작성일**: 2026-02-07
**기반**: System Audit (14 Critical), Architecture Critique (7 Fundamental Issues), Platform Research (10 Feature Gaps), Multi-Model Research (Gemini CLI, Codex CLI)

---

## 1. 설계 원칙

### v1.0의 근본 문제

v1.0은 "subagent는 완전 무상태, 파일만이 유일한 통신 수단"이라는 전제 위에 설계되었다. 이 전제는 2025년 중반까지는 맞았으나, 이후 Claude Code가 session resume, persistent memory, skills preload, Agent Teams를 도입하면서 **더 이상 사실이 아니다**.

결과적으로 v1.0은:
- 모든 상호작용에 파일 I/O를 강제하여 토큰을 낭비
- PM을 모든 구현에 의무 호출하여 병목 생성
- 7개 분기로 과분류하여 라우팅 복잡도 증가
- 14개 에이전트를 코드 0줄 단계에서 유지

### v2.0 설계 원칙

```
1. 가벼운 것이 먼저    파일 보고서보다 직접 반환, 직접 반환보다 session resume
2. 점진적 에스컬레이션  분류부터 하지 않는다. 시작하고, 필요하면 올린다
3. 기억하는 에이전트    무상태 반복 대신 memory로 지식 누적
4. 모델은 도구다        Claude만 쓰지 않는다. 상황에 맞는 모델을 쓴다
5. 필요할 때 만든다     코드가 없으면 에이전트도 없다
6. 불변/가변 분리       Agent YAML은 불변 역할, 로직은 Skills/Memory에
7. 디스크는 디스크가 지킨다  프롬프트가 아닌 Hooks로 파일시스템 규칙 강제
8. 작업과 회상을 분리    실행 컨텍스트는 최신 상태만, 상세 이력은 아카이브로 분리
```

### 원칙 6 상세: 불변/가변 분리 (Hot-Reload 아키텍처)

Agent YAML(`.claude/agents/*.md`)은 세션 시작 시 스캔되어 캐시된다 (issue #6497 OPEN).
세션 중간에 agent 파일을 수정하거나 새로 생성해도 인식되지 않으며, `--continue`/`--resume`으로도 캐시는 갱신되지 않는다. 오직 새 세션(`claude` 단독 실행)만이 agent 목록을 fresh scan한다.

이 제약을 **설계 원칙으로 승격**한다: agent YAML은 불변 골격, 동적 변경은 가변 계층과 제어 평면에서 처리.

#### 3계층 + 제어 평면 모델

```
┌── 불변 계층: Agent YAML ──────────────────────────┐
│  name, tools, model, memory scope, skills 목록     │
│  = 역할 정의 (한번 잡으면 거의 안 바뀜)             │
│  변경 시: 세션 재시작 필요                          │
└──────────────────────────────────────────────────┘

┌── 가변 계층 ──────────────────────────────────────┐
│                                                    │
│  Skills (.claude/commands/*.md)                     │
│    = 방법론, 프로세스, 판단 기준                     │
│    = Skill tool 호출 시 디스크에서 fresh read        │
│    변경 시: 핫 리로드 ✅                             │
│                                                    │
│  Memory (.claude/agent-memory/<agent>/MEMORY.md)    │
│    = 누적된 결정, 패턴, 분석 결과                    │
│    = spawn 시 시스템 프롬프트에 자동 주입             │
│    변경 시: 핫 리로드 ✅                             │
│                                                    │
└──────────────────────────────────────────────────┘

┌── 제어 평면: settings.json ───────────────────────┐
│  agent.md의 불변성을 보완하는 핫리로드 가능 인프라   │
│                                                    │
│  SubagentStart hooks → agent별 동적 컨텍스트 주입   │
│    matcher로 agent_type별 분기, shell script 실행   │
│    디스크 읽기·API 호출·환경변수 참조 자유           │
│                                                    │
│  PreToolUse hooks → 도구 사용 전 검증/차단          │
│    (→ 원칙 7: 디스크는 디스크가 지킨다)             │
│                                                    │
│  SubagentStop hooks → 라이프사이클 아카이브          │
│    (→ 원칙 8: 작업과 회상을 분리)                   │
│                                                    │
│  settings.json 자체가 핫 리로드 ✅                   │
│  → hook 추가/수정 시 세션 재시작 불필요              │
└──────────────────────────────────────────────────┘
```

**설계 규칙**:
- 자주 바뀔 수 있는 로직 → Skills에 (agent 본문에 넣지 않는다)
- 누적 지식 → Memory에 (파일 보고서로 전달하지 않는다)
- 외부에서 주입할 동적 규칙 → SubagentStart hook에
- Agent YAML → 역할/도구/이름만 (최소한으로 유지)

#### 로딩 메커니즘 (실증 기반, 2026-02-28)

5회 반복 실험 + Task tool/Team 교차 검증으로 확인된 메커니즘:

```
┌──────────────────────┬──────────────┬───────────────┬──────────┬──────────┐
│                      │ 핫 리로딩    │ 주입 방식      │ Task tool│ Team     │
├──────────────────────┼──────────────┼───────────────┼──────────┼──────────┤
│ agents/*.md body     │ ❌           │ 자동 (패시브)  │ 캐시     │ 캐시     │
│ agents/*.md model    │ ❌ (캐시)    │ 오버라이드 가능 │ ✅       │ ✅       │
│ commands/*.md        │ ✅           │ 수동 (액티브)  │ ✅       │ ✅       │
│ agent-memory/        │ ✅           │ 자동 (패시브)  │ ✅       │ ✅       │
│ SubagentStart hook   │ ✅           │ 자동 (패시브)  │ ✅       │ ✅       │
│ settings.json        │ ✅           │ -             │ -        │ -        │
└──────────────────────┴──────────────┴───────────────┴──────────┴──────────┘
```

**Agent 로딩**: 세션 시작 시 `.claude/agents/` 스캔 → 목록+내용 캐시. `.md` body가 시스템 프롬프트로 자동 주입 (에이전트가 Read 불필요). `--continue`/`--resume`은 이전 캐시를 복원하므로 새 agent를 인식하지 못한다.

**Commands 로딩**: 파일 목록은 실시간 스캔 (핫 리로딩). 내용은 `Skill` tool 호출 시점에 디스크에서 fresh read. 팀원도 Skill tool로 호출 가능.

**Memory 로딩**: `.claude/agent-memory/[agent-name]/MEMORY.md`가 spawn 시 시스템 프롬프트에 자동 주입 (패시브). 세션 중간 수정 즉시 반영. 200줄 초과 시 자동 truncation.

**Model 오버라이드**: `.md`의 `model:`은 기본값이며, spawn 시 `model` 파라미터가 항상 우선 (실증 완료).

**Agent spawn 시 컨텍스트 구성 순서**:
1. `agent.md` body (불변, 캐시) → 역할 정의
2. `agent-memory/MEMORY.md` (핫 리로딩) → 누적 지식
3. `SubagentStart` hook `additionalContext` (핫 리로딩) → 외부 동적 규칙
4. Task/Team prompt (매번 다름) → 작업 지시

#### 제어 평면 상세: 통합 SubagentStart Hook

SubagentStart hook은 shell script가 agent 컨텍스트에 `<system-reminder>`를 주입하는 메커니즘이다. agent마다 별도 .sh를 만들지 않고, **고정된 단일 script가 파일 시스템 규약에 따라 자동 분기**한다.

**settings.json 설정** (고정, 변경 불필요):
```json
"SubagentStart": [
  { "hooks": [{"command": ".claude/hooks/inject-agent-context.sh"}] }
]
```

matcher 없이 하나의 script. agent별 분기는 script 내부에서 `agent_type` + 파일 존재 여부로 처리.

**주입 흐름**:
```
Agent spawn 요청
  → settings.json hooks.SubagentStart 확인
  → inject-agent-context.sh 실행
    stdin: {"agent_type": "...", "session_id": "...", ...}
  → script가 agent_type 기준으로 4가지 소스 탐색:
    1. .claude/agents/{type}.md         → 동적 agent 로딩 (body)
    2. .claude/agent-memory/{type}/     → Memory 주입
    3. .claude/hooks/rules/{type}.md    → agent별 동적 규칙
    4. .claude/hooks/rules/_common.md   → 공통 규칙
  → 발견된 것을 모두 합쳐 additionalContext로 출력
  → agent에게 <system-reminder>로 주입
```

**agent_type 필드 동작** (실증 완료):
- Task tool: `agent_type` = `subagent_type` 파라미터 (예: `"coding-agent"`)
- Team: `agent_type` = `name` 파라미터 (예: `"my-custom-name"`)

**디렉토리 구조 = 설정** (Convention-over-Configuration):
```
.claude/
├── hooks/
│   ├── inject-agent-context.sh   ← 유일한 script (고정, 안 바뀜)
│   └── rules/                    ← agent별 규칙 (.md만 추가하면 적용)
│       ├── _common.md            ← 모든 agent 공통 (파일 명명 규칙 등)
│       ├── egdesk-pm-agent.md    ← PM 전용 (비전 변경사항 등)
│       └── coding-agent.md       ← coding 전용 (린트 규칙 등)
├── agents/                       ← agent 정의 (body, 불변 계층)
├── agent-memory/                 ← agent별 누적 지식 (가변 계층)
```

**새 agent 추가 시**: .sh 생성 불필요. 해당 디렉토리에 .md 파일만 만들면 script가 자동 감지.
**WM 연계**: WM(Warehouse Manager)이 도입되면 rules/*.md 내용을 WM이 관리. script는 불변, 규칙 파일만 WM이 갱신.

**Memory와의 역할 분담**:
- Memory (`agent-memory/`) = agent 자기가 쓰고 읽는 **누적 지식** (자기주도)
- Rules (`hooks/rules/`) = 외부에서 주입하는 **동적 규칙** (외부주도, WM 관리 가능)
- Agent body (`agents/*.md`) = 역할 정의 (캐시된 agent는 자동 로드, 미캐시 agent는 hook이 로드)

#### 동적 Agent Spawn (세션 중 생성된 agent)

세션 중간에 새 `.claude/agents/*.md`를 생성해도 캐시에 없어 정상 spawn이 불가능하다:
- Task tool: `Agent type not found` 하드 에러
- Team: 에러 없이 통과하지만 agent 정의 무시, CLAUDE.md로 폴백 (silent failure)

**해결**: 통합 SubagentStart hook이 자동으로 처리한다.

Team spawn 시 `agent_type` = `name` 파라미터라는 점을 활용:

```
정상 경로 (캐시된 agent):
  Task(subagent_type: "coding-agent")
  → 캐시에서 agent.md body 로드 → 시스템 프롬프트 주입
  → hook도 발동: rules/coding-agent.md 주입 (보충)

Fallback 경로 (캐시 안 된 agent):
  Task(subagent_type: "general-purpose", name: "new-agent")
  → 캐시에 없으므로 agent.md body 미로드
  → hook 발동 (agent_type = "new-agent"):
    1. agents/new-agent.md 존재 → body 주입 (역할 정의)
    2. agent-memory/new-agent/MEMORY.md 존재 → 누적 지식 주입
    3. hooks/rules/new-agent.md 존재 → 동적 규칙 주입
    4. hooks/rules/_common.md → 공통 규칙 주입
  → agent는 <system-reminder>로 모두 수신
```

**핵심**:
- hook script가 **shell 레벨에서 파일을 읽으므로** Main Thread의 컨텍스트를 소비하지 않는다
- Main Thread는 `name`만 지정하면 되고, agent.md/memory 내용을 알 필요가 없다
- 캐시된 agent에게도 hook은 발동하므로, rules/를 통한 **동적 규칙 보충**이 가능하다

**Fallback 시 Memory write-back**: 자동 Memory 로딩은 YAML `memory:` 기준이므로 fallback agent는 memory 경로를 모른다. hook이 additionalContext에 경로를 명시해야 agent가 write-back 가능:
```
"Your memory file: .claude/agent-memory/new-agent/MEMORY.md"
```

**제약**: 도구 제한은 general-purpose의 도구셋을 따른다 (YAML tools 하드 제한 불가). 도구 제한이 필요한 agent는 세션 시작 전에 등록해야 한다.

**CLAUDE.md 지시사항** (3줄):
```
세션 중간에 생성된 agent는 캐시에 없다.
Fallback: subagent_type: "general-purpose", name: "[agent-name]" 으로 spawn.
SubagentStart hook이 해당 agent.md + memory + rules를 자동 주입한다.
```

#### 설계 함의

- Agent `.md`는 **템플릿**(불변 골격)으로만 사용. 동적 변경은 Memory/Skills/Hook으로.
- settings.json은 **가변 계층의 제어 인프라**: SubagentStart(주입), PreToolUse(차단), SubagentStop(아카이브). 세 가지 원칙(6, 7, 8)을 하나의 인프라가 관통한다.
- 제어 평면의 핵심은 **고정 script + 파일 규약**: .sh는 하나, agent별 차이는 .md 파일로 표현. WM이 도입되면 .md 관리를 WM에 위임.
- 세션 중간에 새 에이전트가 필요하면: fallback 경로(general-purpose + name + hook). 도구 하드 제한이 필요하면 세션 재시작.
- Commands의 공용성 활용: 팀원도 Skill tool로 호출 가능 → 공유 로직은 commands에 배치.
- Model은 agent 정의와 분리: `.md`에는 기본 모델만, spawn 시 오버라이드.

### 원칙 8 상세: State Revision vs History Recall 분리

chat 기반 운영에서 "상태 수정 과정"과 "과거 이력 조회"가 같은 컨텍스트에 섞이면 토큰 낭비와 집중도 저하가 커진다.
v2.0에서는 이를 명시적으로 분리한다.

```
Execution 컨텍스트: 현재 작업 수행용
  - 최신 상태(state)와 현재 정책만 유지
  - 실행 품질/속도 최적화가 목표

Revision 컨텍스트: 상태 변경 검토용
  - subagent의 변경 제안(delta) 검토
  - 수락/보류/기각 결정 후 상태 버전 갱신

Recall 컨텍스트: 과거 회상/감사 조회용
  - 실패 로그, 실험 기록, 상세 근거 조회
  - 실행 컨텍스트에 상시 주입하지 않음
```

**운영 규칙**:
- subagent는 main 컨텍스트를 직접 수정하지 않고 `변경 제안`만 제출한다.
- main thread만 상태 정본(canonical state)을 갱신한다.
- `/compact`는 자유 요약이 아니라 아래 최소 스키마를 남긴다.

```yaml
context_version: <number>
decision: <applied|deferred|rejected>
state_diff: <from -> to>
reason_summary: <1-2 lines>
archive_refs:
  - <log-id-or-file-path>
```

- "왜 그때 실패했지?" 같은 질문은 `archive_refs`를 통해 Recall 컨텍스트에서 재로딩해 답한다.

---

## 2. 개체 모델 (v2.0)

```
+============================================================+
|                     사용자 (USER)                            |
+==============================|=============================+
                               |
                    요청 / 결정 / 피드백
                               |
                               v
+============================================================+
|              MAIN THREAD (Claude Code)                      |
|                                                             |
|  역할: 오케스트레이터 + 1차 실행자                           |
|  도구: 전부                                                 |
|  비전 제약: vision-constraints.md 내장                       |
|  멀티모델: /gemini, /codex (Bash 기반, 로직 검증 전용)        |
|                                                             |
|  판단:                                                      |
|   "직접 할 수 있나?" ──yes──> 직접 한다                      |
|   "프레임워크 지식 필요?" ──> framework-analyzer              |
|   "전략적 결정 필요?" ──> PM (memory 있음)                   |
|   "코드 구현 필요?" ──> coding-agent                        |
|   "로직 검증 필요?" ──> Gemini CLI / Codex CLI               |
|  "파일 큐레이션 필요?" ──> warehouse-manager (WM)             |
+==|====================|===================|==========|========+
   |                    |                   |          |
   v                    v                   v          v
+===============+  +==============+  +============+  +==================+
| PM 에이전트   |  | framework-   |  | warehouse- |  | coding-agent     |
| (전략, 선택적)|  | analyzer     |  | manager    |  | (구현)            |
|               |  | (통합 분석)  |  | (WM)       |  |                   |
| memory:       |  | memory:      |  | memory:    |  | Write, Edit,     |
|   project     |  |   project    |  |   project  |  | Read, Glob, Grep |
| skills:       |  |              |  | (카탈로그) |  |                   |
|   pm-*x8      |  | Theia +      |  |            |  | 지시 기반 실행    |
|               |  | Electron     |  | 메타데이터 |  |                   |
| 호출 빈도:    |  | 통합         |  | 기반 큐레  |  |                   |
|   낮음        |  |              |  | 이션       |  |                   |
+===============+  +==============+  +============+  +==================+

+================================================================+
|                    외부 모델 (Multi-Model Layer)                 |
|                    Bash 기반 직접 호출만 사용                    |
|                                                                 |
|  +-- Gemini CLI ──> gemini -p "prompt" (Bash 직접 호출)        |
|  |   무료 1000회/일, 1M 토큰 컨텍스트                           |
|  |   용도: 코드 리뷰, 로직 검증, 세컨드 오피니언                 |
|  |                                                              |
|  +-- Codex CLI ──> codex exec "prompt" (Bash 직접 호출)        |
|      코드 리뷰, 보안 감사, 버그 탐지                            |
+================================================================+
```

### v1.0 vs v2.0 개체 비교

| 구분 | v1.0 | v2.0 |
|------|------|------|
| 에이전트 수 | 9 커스텀 + 2 내장 + 3 제안 = 14 | 4 커스텀 + 1 내장 = 5 |
| PM 역할 | 모든 구현의 필수 게이트키퍼 | 선택적 전략 자문, memory로 효율화 |
| 외부 모델 | 없음 | Gemini CLI + Codex CLI (Bash 기반) |
| 통신 방식 | 파일 보고서 의무 | 직접 반환 우선, 파일은 선택 |
| 에이전트 기억 | 완전 무상태 | PM, framework-analyzer, WM에 memory: project |

---

## 3. 통신 모델

### v1.0 통신: 파일 핑퐁 (모든 경우)

```
MT ──Task(prompt)──> Agent
MT <──파일 생성────── Agent (Write로 subagent_reports/ 에 보고서)
MT ──Read 파일──────> (보고서 읽기)
MT ──Edit 파일──────> (코멘트 추가: <!-- MT: 질문 -->)
MT ──Task(UPDATE)──> Agent (재호출, 보고서 재읽기)
MT <──파일 갱신────── Agent
MT ──Read 파일──────> (재읽기)
MT ──rm 파일────────> (정리)

최소 5회 파일 I/O / 상호작용
```

### v2.0 통신: 3단계 우선순위

```
=== 1순위: 직접 반환 (Direct Return) ===

MT ──Task(prompt)──> Agent
MT <──function_results── Agent (결과가 바로 MT 컨텍스트에)

파일 I/O: 0회
용도: 간단한 질문, 분석 요청, 짧은 리서치
예시: "Theia의 MenuContribution 패턴 알려줘"


=== 2순위: Session Resume (Multi-turn) ===

MT ──Task(prompt)──> Agent (agent_id 발급)
MT <──결과 반환────── Agent
... 사용자와 논의 ...
MT ──Task(resume=agent_id)──> Agent (이전 컨텍스트 유지)
MT <──후속 결과 반환───────── Agent

파일 I/O: 0회
용도: 멀티턴 작업, 후속 질문, 반복 분석
예시: "아까 그 분석 이어서, electron-main 쪽도 봐줘"


=== 3순위: 파일 보고서 (선택적) ===

MT ──Task(prompt)──> Agent (CREATE REPORT FILE 지시)
MT <──보고서 파일 생성── Agent
MT ──Read 파일─────────>

파일 I/O: 2-3회
용도:
  - PRD 같은 영구 아티팩트 생성
  - 여러 에이전트 간 findings 공유 (PM → framework → coding)
  - 감사 추적이 필요한 경우
예시: "이 기능의 PRD를 ideas/confirmed/에 만들어줘"
```

### 파일 생성 패턴

3순위(파일 보고서) 사용 시, 관여하는 에이전트 수에 따라 2가지 패턴으로 나뉜다.

```
=== 패턴 A: 단일 에이전트 ===

MT ──Task──> Agent A
              Agent A가 직접 파일 Write
              (Agent A의 full context 보존)

예시: PM이 PRD 작성, framework-analyzer가 분석 보고서 작성


=== 패턴 B: 복수 에이전트 (n개) 합성 ===

각 에이전트의 full context가 모두 필요할 때 사용.
MT는 각 agent의 요약만 가지므로 직접 합성하면 디테일 손실.

MT ──Task──> Agent A ──> report_A.md (full detail)
MT ──Task──> Agent B ──> report_B.md (full detail)
  ...
MT ──Task──> Agent N ──> report_N.md (full detail)
                |
                v
합성 모델 우선순위:
  1순위: Gemini CLI (gemini -p) — 무료 1000회/일, 1M context
  2순위: sonnet[1m] — Gemini quota 소진 시 fallback

MT ──Bash(gemini -p "report_A.md, ..., report_N.md 읽고 최종 파일 작성")──>
              → final_output.md
  또는
MT ──Task(general-purpose, model: sonnet[1m])──>
              → final_output.md

핵심:
- 각 agent가 자기 full context로 보고서 작성 (디테일 무손실)
- 합성은 분석이 아닌 편집/조합 → 대형 context + 경량 모델 조합이 최적
- Gemini 1M context가 무료이므로 합성 용도에 가장 경제적
- 합성 완료 후 중간 보고서(report_*.md)는 삭제
```

### 통신 방식 결정 흐름

```
에이전트 호출 필요?
    |
    v
결과가 단순한 텍스트/분석? ──yes──> 1순위: 직접 반환
    |no
    v
후속 대화가 필요할 가능성? ──yes──> 2순위: session resume
    |no
    v
영구 파일이 필요? (PRD, references/) ──yes──> 3순위: 파일 보고서
    |no
    v
여러 에이전트가 공유해야? ──yes──> 3순위: 파일 보고서
    |no
    v
1순위: 직접 반환 (기본값)
```

---

## 4. 워크플로우 구조

### v1.0: 7분기 사전 분류

```
요청 → 분류기 → Branch 1|2|3a|3b|4A|4B|5
(분류 시점에 모든 경로가 결정됨)
```

### v2.0: 3분기 점진적 에스컬레이션

```
요청 → 최소 행동부터 시작 → 필요 시 에스컬레이션
(시작 후 필요에 따라 경로가 확장됨)
```

---

### Branch A: Direct (직접 처리)

**시작 조건**: 대부분의 요청은 여기서 시작

```
사용자 요청
    |
    v
Main Thread가 직접 처리 가능? ──yes──> 직접 응답
    |no                                 (파일 읽기, git, 간단한 설명)
    v
프레임워크 코드 분석 필요? ──yes──> framework-analyzer 호출
    |no                              (직접 반환, session resume 가능)
    v
[에스컬레이션 판단]
  "이건 리서치가 필요하다" ──> Branch B로 승격
  "이건 구현이 필요하다" ──> Branch C로 승격
```

**특징**:
- PM 호출 없음
- 파일 보고서 없음
- 가장 빈번한 경로 (80% 예상)

**예시**:
- "package.json 보여줘" → 직접 Read
- "Theia의 DI 패턴 설명해줘" → framework-analyzer (직접 반환)
- "git status 보여줘" → 직접 Bash
- "이 코드 뭐하는 거야?" → 직접 설명

---

### Branch B: Research (리서치)

**시작 조건**: 조사/학습이 필요한 요청

```
사용자 요청 (리서치 성격)
    |
    v
general-purpose 또는 직접 WebSearch
(직접 반환 — 파일 보고서 안 만듦)
    |
    v
사용자에게 제시
    |
    +── 사용자: "고마워" ──> 종료 (cleanup 불필요)
    |
    +── 사용자: "더 자세히" ──> session resume로 이어서
    |
    +── 사용자: "이거 적용하자" ──> Branch C로 에스컬레이션
    |                                (이 시점에서 PM 호출)
    |
```

**v1.0과의 차이**:
- PM 진단 단계 없음 (시작이 가벼움)
- Type A / Type B 구분 없음 (자연스럽게 전환)
- references/ 추가는 사용자 명령 시 (워크플로우에 무관, 절차만 숙지)
- 멀티모델은 리서치에 불필요 (Claude WebSearch로 충분)

---

### Branch C: Implement (구현)

**시작 조건**: 사용자가 구현을 결정한 시점

```
사용자: "[기능] 구현해줘" (또는 Branch B에서 에스컬레이션)
    |
    v
기존 PRD 있음? (ideas/confirmed/ 검색)
    |
    +── 있음 ──> PM 스킵, PRD 기반 바로 진행
    |
    +── 없음 ──> PM 호출 (memory로 과거 결정 참조)
                   |
                   v
                 PM이 전략 가이드 + PRD 생성
                 (skills: 로 methodology 자동 로드)
                 (memory: project로 비전/기술스택 기억)
                   |
                   v
                 ideas/confirmed/[FEATURE].md 생성 (영구)
    |
    v
framework-analyzer 조사 (직접 반환 또는 session resume)
    |
    v
Main Thread가 구현 계획 수립
    |
    +── 단순한 구현 ──> Main Thread가 직접 코딩
    |
    +── 대규모 구현 ──> coding-agent 스폰 (1개 또는 병렬)
    |
    +── 로직 검증/코드 리뷰 ──> Gemini CLI 또는 Codex CLI
    |                           (세컨드 오피니언, 보안 감사)
    v
빌드/테스트/커밋
```

**v1.0과의 차이**:

| 항목 | v1.0 | v2.0 |
|------|------|------|
| PM 호출 | 모든 구현에 필수 | PRD 존재 시 스킵 |
| PM 비용 | 매번 50-170K 토큰 | memory로 재읽기 최소화 |
| PM methodology | 슬래시 커맨드 (미작동) | skills: 필드로 자동 로드 |
| 프레임워크 조사 | 보고서 파일 핑퐁 | 직접 반환 또는 session resume |
| 코드 리뷰 | 없음 | Codex/Gemini로 세컨드 오피니언 |
| UX 검증 | ux-flow-simulator (Write 없음) | ux-flow-simulator (Write 수정) 또는 직접 |

---

## 5. 에이전트 설계

### 5.1 에이전트 구성 (v2.0)

```
v1.0 (11개 + 3개 제안)          v2.0 (7개)
=========================       =========================
egdesk-pm-agent          ──>    egdesk-pm-agent (개선)
theia-analyzer-agent     ──┐
                           ├──> framework-analyzer (통합, 신규)
electron-analyzer-agent  ──┘
coding-agent             ──>    coding-agent (경로 수정)
ux-flow-simulator-agent  ──>    (Write 수정, 유지 검토*)
(해당 없음)              ──>    code-reviewer (신규)
(해당 없음)              ──>    auditor (신규, ⚠️ 미실증)
(해당 없음)              ──>    warehouse-manager (신규, WM)
swarm-team-agent         ──>    /validate-structure 커맨드로 전환
claude-agent-sdk-analyzer ──>   삭제 (general-purpose로 대체)
gemini-cli-analyzer      ──>    삭제 (/gemini 커맨드 + Gemini CLI)
infinite-canvas-analyzer ──>    삭제 (general-purpose로 대체)

* ux-flow-simulator: 앱 코드 존재 시까지 보류 가능
```

### 5.2 framework-analyzer (신규, 통합)

**설계 근거**: Theia와 Electron은 분리된 프레임워크가 아니라 EG-DESK의 단일 통합 플랫폼이다. DI 패턴(Theia) → IPC 통신(Electron) → 위젯 렌더링(Theia+Electron) 같은 질문은 양쪽을 동시에 이해해야 답할 수 있다.

```yaml
---
name: framework-analyzer
tools: Bash, Glob, Grep, Read, Write, Edit, WebFetch, WebSearch, BashOutput, KillShell, TodoWrite
model: inherit
memory: project     # 분석 패턴 누적
---
```

**memory 활용**:
```
1차 호출: "Theia의 MenuContribution 패턴 분석해줘"
  → references/theia/theia/ 코드 분석
  → 패턴 발견, MEMORY.md에 기록:
    "MenuContribution: browser/src/*-contribution.ts 패턴,
     ContainerModule에서 bind, CommandContribution + MenuContribution 인터페이스"

2차 호출 (다른 세션): "메뉴 추가하려면 어떻게 해?"
  → MEMORY.md에서 이전 분석 결과 참조
  → 코드 재분석 없이 즉시 가이드 제공 + 필요 시 보완 분석
```

**scope**: Theia 코드베이스 분석 + Electron API/보안/IPC 분석 + 통합 패턴

**확장성** (원칙 6 적용):
- 분석 패턴/체크리스트 추가 → skills 파일로 (핫 리로드)
- 발견한 코드 패턴 축적 → memory로 (자동 누적)
- 도구 변경이 필요한 경우만 → YAML 수정 (세션 재시작)

### 5.3 egdesk-pm-agent (개선)

**변경 포인트**:

```yaml
---
name: egdesk-pm-agent
tools: Bash, Glob, Grep, Read, Write, Edit, WebFetch, WebSearch, BashOutput, KillShell, TodoWrite
memory: project     # 과거 전략 결정 기억
skills:             # 슬래시 커맨드 문제 해결
  - pm-strategic-guide
  - pm-plan-review
  - pm-research-planning
  - pm-research-evaluation
  - pm-clarification
  - pm-conflict-resolution
  - pm-decision-support
  - pm-progressive-phases
---
```

**memory 활용**:
```
1차 호출: "Docker 오케스트레이션 구현해야 할까?"
  → 비전 문서 + 기술 스택 읽기
  → 분석 결과 + 결정을 MEMORY.md에 기록:
    "2026-02-07: Docker 오케스트레이션 APPROVE.
     이유: 미니앱 격리에 필수. 기술 스택에 추가됨."

2차 호출 (다른 세션): "미니앱 배포 전략 세워줘"
  → MEMORY.md에서 Docker 승인 이력 참조
  → 비전 문서 전체 재읽기 불필요
  → 이전 결정과 일관된 전략 제시
```

**skills 활용** (원칙 6: 가변 로직은 Skills에):
```
v1.0: PM 내부에서 "/pm-strategic-guide" 실행 시도
  → Skill 도구 없음 → 커맨드 내용 미로드 → PM이 30% 역량으로 동작

v2.0: skills: 필드에 8개 커맨드 등록
  → PM 스폰 시 8개 methodology가 자동으로 컨텍스트에 주입
  → PM이 100% 역량으로 동작
  → 슬래시 커맨드 결정 트리를 직접 methodology 참조로 교체

핵심 이점: methodology 파일 수정 시 세션 재시작 불필요
  → pm-strategic-guide.md 내용 변경 → 다음 PM spawn에서 즉시 반영
  → agent 본문에 로직을 넣었다면 세션 재시작 필요했을 것
```

**호출 빈도 변경**:
```
v1.0: 모든 구현에 필수 (Branch 3b Step 1-2)
v2.0: 선택적 호출
  - PRD 존재 시 → 스킵
  - 단순 기능 추가 → 스킵 (vision-constraints.md로 자체 판단)
  - 전략적 결정 필요 시 → 호출
```

### 5.4 coding-agent (유지, 경로 수정)

변경: Windows 경로 → 상대경로. 나머지 동일. 잘 설계됨.

### 5.5 ux-flow-simulator-agent (유지, 도구 수정)

변경: Write, Edit 도구 추가. 앱 코드가 생길 때까지 실제 사용 빈도 낮음.

### 5.6 code-reviewer (신규)

**설계 근거**: 코드 품질 감시는 구현 에이전트(coding-agent)가 담당하기 어렵다. 만드는 입장과 검토하는 입장은 분리되어야 하며, 특히 UI/UX 흐름과 dead code는 전체 코드베이스를 보는 별도 시각이 필요하다.

```yaml
---
name: code-reviewer
tools: Glob, Grep, Read, Bash
model: sonnet
memory: project     # 반복 이슈 패턴 누적
---
```

**역할**:

```
1. UI/UX 리뷰
   - 컴포넌트 구조: 계층 깊이, 책임 분리 확인
   - 사용자 흐름: 비정상 경로(빈 상태, 에러 상태, 로딩 상태) 누락 탐지
   - 접근성: ARIA 속성, 키보드 탐색 누락 확인

2. Dead Code 감시
   - Dead import: 선언됐지만 사용 안 되는 import
   - Unused 함수/변수/컴포넌트: 정의됐지만 참조 없는 심볼
   - Isolated codepart: 다른 모듈에서 참조되지 않는 파일/클래스
   - Grep + AST 수준 분석 (Bash로 tsc --noEmit, eslint --rule unused-vars 등 활용)
```

**호출 시점**:
```
- coding-agent 구현 완료 후 (Branch C 마지막 단계)
- PostToolUse hook으로 자동 트리거 가능 (Write 후)
- 사용자 명시 요청 시 ("코드 리뷰 해줘")
```

**멀티모델 연계** (Section 6):
```
code-reviewer (Claude) + Gemini CLI 또는 Codex CLI 세컨드 오피니언
→ 서로 다른 학습 데이터의 관점으로 dead code/UX 이슈 교차 검증
```

### 5.7 auditor (신규, 미실증 - 설계 단계)

**설계 근거**: MT가 fault 추적까지 담당하면 context 과부하. 전담 에이전트가 독립 context에서 분석 후 결과 요약만 MT에 반환. 해당 에이전트 MEMORY에 직접 기록.

```yaml
---
name: auditor
tools: Glob, Grep, Read, Write, Edit, Bash
model: sonnet
memory: project     # 에이전트별 fault 패턴 누적
---
```

**트리거**:
```
1. 사용자 감정 분석 → 부정 감정 감지 시 MT → auditor 호출
   (UserPromptSubmit hook에서 감정 분석 → MT에 신호)

2. code-reviewer가 이슈 발견 시 자동 연계

3. 빌드/테스트 실패 시
```

**역할**:
```
1. Fault 추적
   - 최근 에이전트 transcript 분석
     (~/.claude/projects/[project]/agent-[id].jsonl)
   - 어떤 에이전트가 어떤 작업을 했는가?
   - 무엇을 놓쳤는가?

2. 피드백 기록
   - 해당 에이전트의 MEMORY.md에 직접 기록:
     "이 패턴에서 이런 실수 발생, 다음엔 X 확인 필요"
   - 자기 MEMORY에 에이전트별 fault 패턴 누적

3. (Agent Teams 모드) MT 개입 없이 피어 DM으로 직접 피드백
```

**transcript 추적 현황** (⚠️ 실증 필요):
```
확인됨 ✅:
  - 에이전트별 JSONL 파일 실제 존재 확인
  - ~/.claude/projects/[project]/agent-[id].jsonl
  - Task() 반환 시 agentId 제공됨

미실증 ⚠️:
  - SubagentStop hook에서 agent_transcript_path 자동 제공 여부
  - 설계서에는 있으나 실제 테스트 미완료
  → 실증 후 설계 확정 예정

대안 (확실):
  - agentId로 직접 파일 시스템에서 경로 조합 가능
  - ls ~/.claude/projects/[project]/agent-[id].jsonl
```

### 5.8 warehouse-manager (신규)

**설계 근거**: Section 10에서 상세 설명. Work agent가 개별적으로 프로젝트 폴더를 탐색하면 토큰 낭비 + 불일관한 해석이 발생한다. 전담 1명이 메타데이터 기반으로 파일을 큐레이션하고 카탈로그를 유지한다.

```yaml
---
name: warehouse-manager
tools: Glob, Grep, Read, Write, Edit
model: haiku          # 메타데이터 작업이므로 경량 모델 충분
memory: project       # 카탈로그 = MEMORY.md
---
```

**역할**: 도서관 사서 (도메인 전문성 불필요)
- **Read 경로 (큐레이션)**: 카탈로그 + Glob/Grep으로 관련 파일 경로 안내
- **Write 경로 (카탈로그 갱신)**: Work Agent 작업 결과를 카탈로그에 반영

**memory 활용**:
```
# .claude/agent-memory/warehouse-manager/MEMORY.md

## 파일 카탈로그
- references/theia/di-patterns.md: Theia DI, @injectable, ContainerModule
- references/theia/online_references.md: API 문서 링크 모음
- ideas/confirmed/technology-stack.md: 기술 스택 확정
...

## 최근 변경 (pending 분류)
- ideas/confirmed/DOCKER_ORCHESTRATION.md: Docker 컨테이너 관리 (2026-02-08)
```

**토큰 격리 원칙**:
- WM: 메타데이터만 (Glob/Grep, 카탈로그). 파일 내용 Read 안 함.
- Work Agent: WM이 추천한 파일만 Read. 탐색 불필요.
- 겹침: 0

**호출 패턴**:
```
MT → WM(큐레이션) → 경로 3개 반환
MT → Work Agent(경로 포함 프롬프트) → 작업 수행
MT → WM(resume, 카탈로그 갱신) → 완료
```

**확장성** (원칙 6 적용):
- 카탈로그 형식/분류 규칙 → memory에서 자체 진화
- 큐레이션 전략 → skills 파일로 추가 가능
- 도구 변경 필요 시만 → YAML 수정

---

## 6. 멀티모델 통합 설계

### 6.1 접근 전략

```
Claude Code (Main Thread)
    = 주 오케스트레이터 + 주 실행자
    = 모든 작업의 기본 모델

외부 모델은 "로직 검증 도구"로 취급:
    - 코드 리뷰 세컨드 오피니언 (다른 학습 데이터의 관점)
    - 보안 감사 / 버그 탐지
    - 아키텍처 결정 시 다른 관점 수집
    ※ 웹 리서치에는 불필요 (Claude WebSearch로 충분)
```

### 6.2 통합 메커니즘 2종

```
+-- Bash 직접 호출 (간단, 안정적) ────────────────────+
|                                                     |
|  gemini -p "prompt" (Gemini CLI)                    |
|  codex exec "prompt" (Codex CLI)                    |
|                                                     |
|  장점: 설정 불필요, 안정적, subagent에서도 가능       |
|  단점: 매 호출 새 프로세스, 컨텍스트 미유지            |
|  용도: 코드 리뷰, 보안 감사, 세컨드 오피니언           |
+-----------------------------------------------------+

+-- 슬래시 커맨드 (사용자 편의) ──────────────────────+
|                                                     |
|  /gemini [prompt] → Bash로 gemini -p 호출            |
|  /codex [prompt]  → Bash로 codex exec 호출           |
|                                                     |
|  장점: 사용자가 직접 빠르게 호출, 핫 리로드 가능       |
|  단점: 단순 래퍼                                     |
|  용도: 사용자 주도의 빠른 멀티모델 쿼리               |
+-----------------------------------------------------+

MCP 기반 외부 모델 통합(OpenRouter 등)은 사용하지 않는다.
커스텀 subagent에서 MCP가 불안정한 알려진 버그가 있고,
Bash 직접 호출이 더 단순하고 안정적이기 때문이다.
```

### 6.3 멀티모델 사용 시나리오

```
시나리오 1: 코드 리뷰 세컨드 오피니언
──────────────────────────────────────
coding-agent가 기능 구현 완료

Main Thread: 코드 품질 검증 필요

Bash: codex exec --full-auto -o /tmp/review.md \
  "Review this code for bugs, security issues, and improvements: \
   $(cat eg-desk/packages/terminal-theme/src/browser/theme-service.ts)"

→ Codex 리뷰 결과를 Claude가 검토 + 필요 시 수정 지시


시나리오 2: 아키텍처 결정 세컨드 오피니언
─────────────────────────────────────────
PM이 "WebSocket vs SSE" 결정 필요, 로직적 관점에서 검증

Main Thread: 여러 모델의 관점 수집

병렬:
  - Claude 자체 분석
  - Gemini: gemini -p "WebSocket vs SSE for real-time: 각각의 failure mode,
            scaling bottleneck, 구현 복잡도 비교"
  - Codex: codex exec "WebSocket vs SSE: edge cases, error handling 비교"

→ 3개 관점 종합 → PM에게 전달 또는 직접 사용자에게 제시

※ 웹 리서치(기술 조사, 문서 탐색)에는 멀티모델 불필요.
  Claude WebSearch + general-purpose로 충분.
```

### 6.4 비용 구조

```
| 모델         | 비용               | 일일 한도    | 최적 용도              |
|-------------|-------------------|------------|----------------------|
| Claude Opus | API 가격           | 없음        | 주 오케스트레이션, 코딩  |
| Gemini CLI  | 무료 (Google 계정) | 1000회/일   | 코드 리뷰, 세컨드 오피니언 |
| Codex CLI   | ChatGPT Plus $20  | API 기반    | 코드 리뷰, 보안 감사    |
```

---

## 7. Vision Constraints 내장 설계

### 7.1 문제

v1.0에서 PM은 모든 호출마다 비전 문서, 기술 스택, 기존 코드를 재읽는다 (50-170K 토큰/호출). PM의 핵심 역할 중 "비전 정합성 검증"은 사실 Main Thread가 자체적으로 할 수 있는 일이다.

### 7.2 해결: .claude/docs/vision-constraints.md

Main Thread의 CLAUDE.md가 `@docs/vision-constraints.md`를 포함. Main Thread는 매 세션 시작 시 비전 제약을 자동으로 인식.

```
vision-constraints.md 내용 예시:

## 기술 스택 제약
- 프레임워크: Eclipse Theia (Electron 통합)
- 언어: TypeScript (strict mode)
- 패키지 관리: yarn workspaces
- 빌드: Theia CLI
- 테스트: Vitest + Playwright

## 아키텍처 원칙
- 기능 기반 패키지 (레이어 기반 아님)
- Theia 플랫폼 분리: common/ | browser/ | node/
- 파일당 750줄 최대
- 깊이 4단계 제한

## 금지 사항
- React 외부 UI 프레임워크 도입 금지 (Theia가 React 사용)
- 모노레포 외부 패키지 생성 금지
- Electron main process에서 직접 비즈니스 로직 금지

## 승인된 외부 의존성
- (ideas/confirmed/technology-stack.md 참조)
```

**효과**:
- 단순한 구현("위젯 추가해줘")에서 PM 호출 불필요
- Main Thread가 vision-constraints.md로 자체 판단
- PM은 정말 전략적 결정("새 기술 도입", "아키텍처 변경")에만 호출

---

## 8. subagent_reports/ 역할 변경

### v1.0: 의무적 중간 저장소

```
모든 에이전트 상호작용 → 보고서 생성 → 읽기 → 코멘트 → 재호출 → 재읽기 → 삭제
"DELETE when user issue resolved" (의무)
"NEVER leave reports indefinitely" (압박)
```

### v2.0: 선택적 아티팩트 저장소

```
대부분의 에이전트 상호작용 → 직접 반환 또는 session resume (보고서 없음)
영구 아티팩트 필요 시 → ideas/confirmed/ 또는 references/ 에 직접 생성
크로스-에이전트 공유 필요 시 → subagent_reports/ 사용 (드묾)

정리: 주기적 (7일 이상 된 파일 자동 정리), 의무적 즉시 삭제 없음
```

**subagent_reports/가 여전히 필요한 경우**:
1. PM이 생성한 전략 가이드를 framework-analyzer와 coding-agent가 참조해야 할 때
2. 병렬 에이전트 결과를 수집할 때
3. 감사 추적이 필요한 중요한 결정일 때

**하지만 기본값은 "보고서 없음"**

---

## 9. Hooks: 파일시스템 가드레일 설계

### 9.1 문제: 프롬프트 ≠ 강제

```
LLM (메모리 상의 존재)          파일시스템 (디스크 상의 개체)
========================       ============================
컨텍스트 윈도우 안에서 동작      물리적 디렉토리/파일로 존재
프롬프트로 규칙을 "알려줌"       규칙을 "알아도" 실행 시 무시 가능
system prompt + memory 한계     무한한 파일 수/깊이

비유: 오피스 사무원에게 창고 정리 규칙을 종이로 전달
  → 바쁘면 종이를 안 봄
  → 창고 현황을 머리에 다 외울 수 없음
  → 규칙 위반을 사후에야 발견
```

v1.0은 이 문제를 **더 자세한 프롬프트**로 해결하려 했다:
- "SCREAMING_SNAKE_CASE.md 사용" (organization.md)
- "DELETE when user issue resolved" (protocol.md)
- "NEVER leave reports indefinitely" (protocol.md)

결과: 에이전트가 바쁘면 무시. Main Thread가 기억 못하면 누락.

### 9.2 해결: Hooks = 창고 담당자

```
v1.0: 종이 규칙 (Prompt-based)
  LLM ──Write──> 파일시스템  (규칙은 LLM 머릿속에만)

v2.0: 실시간 감시 (Hook-based)
  LLM ──Write──> [Hook 검증] ──pass──> 파일시스템
                      |
                      +──deny──> LLM에게 거부 사유 피드백
                      +──fix───> 경로 자동 교정 후 허용
```

Hooks는 **OS 레벨에서 도구 호출을 가로채는** 결정적(deterministic) 시스템이다.
프롬프트와 달리 LLM이 "무시"할 수 없다 — 실행 자체가 차단된다.

### 9.3 EG-DESK v2.0 Hook 아키텍처

```
+================================================================+
|                    Hook 계층 구조                                |
|                                                                 |
|  SessionStart ──> 시작 시 환경 점검                             |
|    - subagent_reports/ 내 7일 이상 된 파일 경고                  |
|    - 프로젝트 구조 무결성 빠른 확인                              |
|                                                                 |
|  PreToolUse (Write|Edit) ──> 파일 쓰기 전 검증                  |
|    - 경로 검증 (허용된 디렉토리인가?)                            |
|    - 이름 규칙 검증 (SCREAMING_SNAKE_CASE? YYYYMMDD_HHMM?)     |
|    - 보호 디렉토리 차단 (.git/, node_modules/)                  |
|    - 자동 교정 (경로/이름 수정 후 허용)                         |
|                                                                 |
|  PreToolUse (Bash) ──> 파일 삭제 커맨드 감시                    |
|    - rm, rm -rf, rmdir 등 destructive 커맨드 탐지               |
|    - 보호 경로 대상 rm 차단 (ideas/, references/, .claude/)     |
|    - subagent_reports/ rm은 허용 (정리 용도)                    |
|    - 되돌릴 수 없는 작업이므로 Hard 차단 (프롬프트로 불충분)     |
|                                                                 |
|  PostToolUse (Write|Edit) ──> 파일 쓰기 후 기록                 |
|    - 감사 로그 추가 (.claude/hooks/audit.jsonl)                 |
|    - (선택) 파일 매니페스트 자동 갱신                            |
|                                                                 |
|  SubagentStart ──> 서브에이전트 스폰 시 컨텍스트 주입           |
|    - 파일 조직 규칙을 additionalContext로 주입                  |
|    - 에이전트가 CLAUDE.md를 안 읽어도 규칙을 "알게" 됨          |
|                                                                 |
|  SubagentStop ──> 서브에이전트 완료 전 검증                     |
|    - 기대한 산출물(PRD, 보고서) 존재 확인                       |
|    - 미완성 시 블로킹 가능 (decision: "block")                  |
|                                                                 |
|  Stop ──> 세션 종료 시 정리 알림                                |
|    - 미정리 subagent_reports/ 파일 목록 출력                    |
+================================================================+
```

### 9.4 구체적 Hook 설계

#### Hook 1: 파일 경로/이름 검증 (PreToolUse - Write/Edit)

```
트리거: Write 또는 Edit 호출 시
매처: "Write|Edit"

검증 규칙:
┌─────────────────────────┬──────────────────────────────┐
│ 경로 패턴               │ 이름 규칙                     │
├─────────────────────────┼──────────────────────────────┤
│ ideas/confirmed/*       │ SCREAMING_SNAKE_CASE.md       │
│ ideas/brainstorming/*   │ SCREAMING_SNAKE_CASE.md       │
│ subagent_reports/*      │ YYYYMMDD_HHMM_*-*.md          │
│ references/*/           │ lowercase-kebab-case/          │
│ .claude/agents/*        │ lowercase-kebab-case.md        │
│ .claude/commands/*      │ lowercase-kebab-case.md        │
└─────────────────────────┴──────────────────────────────┘

판정:
  - 규칙 위반 → deny + 피드백 (올바른 형식 안내)
  - 자동 교정 가능 → allow + updatedInput (경로 수정)
  - 보호 디렉토리 → deny (절대 차단)
```

#### Hook 1b: 파일 삭제 커맨드 감시 (PreToolUse - Bash)

```
트리거: Bash 호출 시
매처: "Bash"

감시 패턴 (정규식):
  \brm\b.*-rf?   또는   \brm\b.*ideas/   또는   \brm\b.*references/
  \brm\b.*\.claude/   (hooks, agents, commands 등 핵심 설정)

판정:
  - 보호 경로 대상 rm → deny + "이 경로는 삭제 보호됩니다. 수동 확인 필요."
  - subagent_reports/ 대상 rm → allow (정리 용도)
  - 비보호 경로 rm → allow
```

#### Hook 2: SubagentStart 컨텍스트 주입

```
트리거: 모든 subagent 스폰 시
매처: (전체 - 또는 특정 agent_type)

용도 1: 파일 규칙 주입 (프롬프트 + Hook 이중 방어)
  주입 내용:
    "파일 생성 규칙:
     - ideas/confirmed/: SCREAMING_SNAKE_CASE.md
     - subagent_reports/: YYYYMMDD_HHMM_[topic]-[agent].md
     이 규칙은 PreToolUse hook으로도 강제되므로 위반 시 Write가 차단됩니다."

용도 2: 동적 agent 로딩 (원칙 6 fallback)
  세션 중간에 생성된 agent.md를 shell 레벨에서 읽어 주입.
  Main Thread 컨텍스트 비용 0.
  상세: 원칙 6 상세 "동적 Agent Spawn" 참조.

용도 3: agent별 동적 설정 분기 (matcher 활용)
  PM에게는 최신 비전 변경사항, coding-agent에게는 현재 린트 규칙 등
  agent_type별로 다른 shell script 실행.
```

#### Hook 3: 세션 시작 시 위생 점검 (SessionStart)

```
트리거: 세션 시작/재개 시
매처: (startup|resume)

점검 항목:
  - subagent_reports/ 내 7일+ 파일 → 경고 메시지
  - .claude/agent-locks/ 잔여 락 파일 → 정리
  - ideas/confirmed/ 이름 규칙 위반 파일 → 경고

출력: Claude 컨텍스트에 주입 (stdout)
  "⚠ 2개 stale report 발견: [...]. 정리 필요."
```

#### Hook 4: SubagentStop 산출물 검증

```
트리거: subagent 종료 시
매처: "egdesk-pm-agent|framework-analyzer"

검증:
  - PM 호출 후: ideas/confirmed/ 에 PRD 생성되었는가?
  - framework-analyzer 호출 후: 요청된 분석이 반환되었는가?

판정:
  - 산출물 미발견 → decision: "block" + reason
  - 정상 → 통과
```

### 9.5 Hookify 활용

`.claude/hookify.*.local.md` 파일로 자연어 규칙 정의 가능:

```
/hookify ideas/confirmed/ 에 파일 쓸 때 SCREAMING_SNAKE_CASE.md 아니면 차단해줘
/hookify subagent_reports/ 에 YYYYMMDD_HHMM 패턴 아닌 파일명이면 거부해줘
/hookify .git/ 이나 node_modules/ 에 쓰기 시도하면 무조건 차단
```

Hookify 장점:
- JSON 설정 불필요 (자연어 → 규칙 자동 생성)
- 즉시 반영 (세션 재시작 불필요)
- 대화 분석으로 반복 실수 자동 감지 (`/hookify` 인자 없이)

### 9.6 프롬프트 vs Hook 역할 분담

```
프롬프트 (Soft - "알려주기")          Hook (Hard - "강제하기")
================================    ================================
"이 디렉토리에 파일을 넣어라"         경로가 틀리면 Write 자체를 차단
"이 이름 규칙을 따라라"              이름이 틀리면 자동 교정 또는 거부
"보고서 정리해라"                    7일 이상 stale 파일 자동 경고
"subagent에게 규칙 전달해라"         SubagentStart에서 자동 주입

프롬프트 = 의도 전달 (LLM이 판단)
Hook = 물리적 강제 (LLM이 무시 불가)

둘 다 필요: 프롬프트로 "왜" 이해, Hook으로 "실행" 보장
```

### 9.7 설정 파일 위치

```
.claude/
├── settings.local.json     ← Hook 설정 (command type hooks)
├── hooks/                  ← Hook 스크립트
│   ├── validate-file-path.py   ← PreToolUse 검증
│   ├── inject-subagent-context.sh ← SubagentStart: 규칙 주입 + 동적 agent 로딩
│   ├── inject-pm.sh             ← SubagentStart: PM 전용 (비전 변경사항 등)
│   ├── inject-coding.sh         ← SubagentStart: coding-agent 전용
│   ├── session-hygiene.sh       ← SessionStart 점검
│   └── audit.jsonl              ← 감사 로그 (자동 생성)
├── hookify.*.local.md      ← Hookify 자연어 규칙 (자동 생성)
```

---

## 10. Warehouse Manager (창고 관리자) 아키텍처

### 10.1 문제: 파일 중구난방 + 기존 리소스 미참조

```
문제 1: 파일 생성이 중구난방
  → Agent가 경로/이름 규칙 무시
  → Hook으로 해결 (Section 9: enforcement)

문제 2: 기존 리소스를 참고하지 않음
  → references/에 이미 분석이 있는데 새로 조사
  → ideas/confirmed/에 PRD가 있는데 중복 작업
  → 각 agent가 폴더를 제각각 해석
  → Hook만으로는 부족 (awareness 문제)
```

문제 2의 근본 원인: 각 work agent가 개별적으로 프로젝트 폴더를 탐색하면 **토큰 낭비 + 불일관한 해석**. 또한 agent memory에 폴더 맥락을 분산시키면 **각 agent의 context window 압박 + 해석 편차** 발생.

**해결**: 프로젝트 파일 맥락을 아는 **전담 1명**이 일관되게 관리.

### 10.2 도서관 사서 모델

```
사서 (창고 관리자)                  학자 (work agent)
─────────────────                  ──────────────────
"DI 관련 자료는 이쪽에"             "DI 패턴의 장단점은..."
파일이 어디 있는지 앎                파일 내용을 깊게 이해
태그/키워드로 매칭                   도메인 전문 분석
구조 규칙을 앎                      기술 판단을 함
```

**창고 관리자는 도메인 전문성 불필요**. 카탈로그와 색인(Glob/Grep)으로 파일 위치를 안내하고, 실제 내용 해석은 work agent가 한다.

### 10.3 양방향 역할

```
Read 경로 (큐레이션):
  MT → WM: "DI 패턴 관련 파일 찾아줘"
  WM: Glob + Grep + 카탈로그 조회 (메타데이터만)
  WM → MT: "이 3개 파일이 관련됩니다" (경로만)
  MT → Work Agent: "이 파일들 참고해서 작업해"

Write 경로 (카탈로그 갱신):
  Work Agent 작업 완료 → MT에 결과 반환
  MT → WM resume: "Work Agent가 X 생성, Y 수정했음"
  WM: 카탈로그 업데이트
```

### 10.4 토큰 격리 (정보 깔때기)

**핵심**: WM과 Work Agent의 context window 내용이 겹치지 않는다.

```
프로젝트 전체 (수백 개 파일)
        │
  WM context window:
  │  카탈로그 (~200줄, memory 자동 로드)
  │  Glob 결과 (파일 경로 목록, 극소)
  │  Grep 결과 (매칭 줄만, 극소)
  │  = 메타데이터만, 파일 내용 Read 안 함
        │
  관련 파일 3~5개 경로 + 한줄 설명
        │
  Work Agent context window:
     역할 + 임무 (고정)
     WM 추천 경로 3개 (극소)
     Read(file1) 500줄 ← 최초이자 유일한 full Read
     Read(file2) 300줄
     = 실작업 토큰만 소모

겹침: 0 (WM은 메타데이터, Work Agent는 내용)
```

### 10.5 카탈로그 시스템

WM의 agent memory에 파일 카탈로그를 유지한다.

```markdown
# .claude/agent-memory/warehouse-manager/MEMORY.md

## 파일 카탈로그
- references/theia/di-patterns.md: Theia DI, @injectable, ContainerModule
- references/theia/online_references.md: API 문서 링크 모음
- ideas/confirmed/technology-stack.md: 기술 스택 확정 (DI=InversifyJS)
- ideas/confirmed/CONTEXT_AWARE_BROWSER_AUTOMATION.md: Puppeteer CDP 방식

## 최근 변경 (pending 분류)
- ideas/confirmed/DOCKER_ORCHESTRATION.md: Docker 컨테이너 관리 (2026-02-08)
```

**카탈로그 갱신 방법** (토큰 중복 0):

```
WM이 직접 Read 해서 갱신하지 않는다.
정보는 항상 "남이 알려주는 것":

1. 최초 구축: Glob + Grep + 파일 첫 줄 (한 번만)
2. Work Agent가 생성/수정: 자기 보고 → MT 중계 → WM 카탈로그에 추가
3. 사용자가 구조 변경: 직접 WM 호출 → 재인덱싱
```

### 10.6 플랫폼 제약과 현실적 설계

WM 아키텍처 설계 과정에서 발견된 Claude Code 플랫폼 제약:

```
┌─────────────────────────────────────────────────────────────────┐
│ 제약 1: Subagent는 다른 subagent를 spawn할 수 없다              │
│   "Subagents cannot spawn other subagents"                     │
│   → Work Agent가 직접 WM을 호출하는 것은 불가능                  │
│                                                                 │
│ 제약 2: Hook에서 Task(resume) 호출 불가                          │
│   Command hook = shell script만 실행                            │
│   Prompt/Agent hook = ok/block만 반환                           │
│   → SubagentStop hook으로 자동 WM 연결 불가                     │
│                                                                 │
│ 제약 3: function_results는 항상 호출자(MT)에게 반환               │
│   Task()는 도구 호출이므로 결과는 반드시 MT에게 돌아옴             │
│   → Work Agent → WM 직접 통신 경로 없음                         │
│                                                                 │
│ 실증 4: Agent Teams + Custom Agent 조합 (2026-02-09 실증 완료)    │
│   .claude/agents/ 정의를 팀원으로 spawn 가능 (공식 문서에 없음)    │
│   실증 결과:                                                      │
│     ✅ YAML tools 제한 적용 (Bash 차단 확인)                       │
│     ✅ YAML memory: project 적용 (세션 재시작 후)                  │
│     ✅ YAML instructions 로드 (에이전트 역할 인식)                  │
│     ✅ CLAUDE.md 프로젝트 컨텍스트 (모든 teammate에 로드)           │
│     ✅ peer DM (teammate 간 SendMessage 정보 교환)                 │
│     ✅ Task model 파라미터 오버라이드 (tmux 모드 확인, in-process는 │
│        세션에 따라 불안정)                                         │
│     ✅ YAML skills: 필드 적용 (2026-02-10 실증)                    │
│        - Skills preload: 각 teammate가 독립적 skills 보유          │
│          (test-agent-alpha/skill-alpha, test-agent-beta/skill-beta) │
│        - Dynamic sharing: Agent 간 파일 경로 공유 → Read → 즉시 적용 │
│        - SendMessage 자동 제공: tools에 명시 안 해도 통신 가능      │
│        - 파일 경로 발견: content만 주입, 경로는 agent가 추론        │
│   제한:                                                           │
│     ❌ teammate resume 불가 (트랜스크립트 미저장)                   │
│     ❌ 비정상 종료 시 config에 좀비 멤버 잔존 (수동 rm 필요)        │
│     ❌ 팀 자체가 일회성 (세션 간 복원 불가)                         │
│   → Custom Agent를 Teams에 활용 가능하나, 일회성 세션으로 설계     │
│                                                                 │
│ 결론: MT 중계는 불가피하나, 전달량은 요약 3줄 수준으로 최소화      │
└─────────────────────────────────────────────────────────────────┘
```

### 10.7 SubagentStop + Transcript 활용

Work Agent의 자연어 요약은 형식/완전성이 보장되지 않는다 (`function_results`는 자유형 텍스트). 그러나 **transcript는 실제 tool call 기록**이므로 100% 정확하다.

```
SubagentStop hook이 받는 데이터:
{
  "agent_id": "def456",
  "agent_type": "coding-agent",
  "agent_transcript_path": "~/.claude/.../subagents/agent-def456.jsonl"
}
```

**Command hook으로 실제 파일 변경 추출**:

```bash
#!/bin/bash
# .claude/hooks/extract-file-changes.sh
INPUT=$(cat)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.agent_transcript_path')

# transcript에서 실제 Write/Edit tool call만 추출
jq -r 'select(.tool_name == "Write" or .tool_name == "Edit")
  | .tool_input.file_path' "$TRANSCRIPT" \
  >> "$CLAUDE_PROJECT_DIR/.claude/wm-pending.txt"
```

```
agent 자연어 요약:  "파일 몇 개 만들었습니다" ← 부정확할 수 있음
transcript 파싱:   Write("ideas/confirmed/DOCKER.md") ← 사실(fact)
```

**이중 안전망**: transcript로 사실 확인 + 자연어 요약으로 semantic 맥락 보완.

### 10.8 최종 워크플로우

```
사용자: "DI 패턴 분석해서 PRD 만들어줘"
    │
    v
[1] MT → WM 호출 (큐레이션)
    WM: 카탈로그 + Glob("references/theia/*") + Grep("DI")
    WM → MT: "관련 파일 3개: [경로 목록]"
    (WM agentId 획득)
    │
    v
[2] MT → Work Agent 호출
    프롬프트: "이 파일들 참고: [경로 3개]. DI 패턴 분석 후 PRD 작성.
              완료 시 변경 사항을 구조화 보고:
              CREATED: [경로] | [주제] | [태그]
              MODIFIED: [경로] | [변경내용]"
    │
    v
[3] Work Agent 작업 수행
    Read(di-patterns.md), Read(technology-stack.md) ← 최초 유일 Read
    분석 → Write(ideas/confirmed/DI_PATTERN_PRD.md)
    │
    v
[4] Work Agent 종료 → function_results MT에 반환
    "CREATED: ideas/confirmed/DI_PATTERN_PRD.md | DI 패턴 PRD | DI, Theia"
    │
    ├── SubagentStop command hook 자동 발동
    │   → transcript에서 Write 경로 추출 → wm-pending.txt에 기록
    │
    v
[5] MT → Task(resume: wmAgentId)
    "카탈로그 업데이트:
     CREATED: ideas/confirmed/DI_PATTERN_PRD.md
     주제: DI 패턴 PRD, 태그: DI, Theia"
    │
    v
[6] WM: 카탈로그 memory에 추가 → 끝
```

**토큰 비용 분석**:

```
WM 1차 호출 (큐레이션): ~300 토큰 (카탈로그 + Glob/Grep)
Work Agent:             실작업 토큰만 (탐색 불필요)
MT 중계:                요약 3줄 (~50 토큰)
WM resume (갱신):       ~100 토큰 (이전 context + 업데이트)

추가 비용 합계: ~450 토큰
절약 효과: Work Agent의 폴더 탐색 제거 (수천 토큰)
```

---

## 11. 에이전트 라이프사이클

```
반복 현상 발견 (개발 중 on-demand)
    |
    v
[1단계: Skill로 프로토타이핑]
    .claude/commands/[name].md 생성
    → /[name] "테스트 프롬프트"
    → 수정 → 즉시 반영 (핫 리로드)
    → 검증 반복
    |
    v
[2단계: 승격 판단]
    memory 필요? tools 제한 필요? model 변경 필요?
    │
    +── 아니오 → Skill로 유지 (대부분의 경우)
    │
    +── 예 → Agent로 승격
              .claude/agents/[name].md 생성
              ├── 즉시 사용: fallback 경로 (general-purpose + name + hook)
              │   도구 하드 제한 불가, 지시사항은 hook이 자동 주입
              └── 다음 세션: 정상 경로 (캐시 로드, 도구 제한 적용)
    |
    v
[3단계: 운영]
    로직 변경 → Skills 파일 수정 (핫 리로드)
    지식 축적 → Memory 자동 갱신 (핫 리로드)
    역할 변경 → YAML 수정 (세션 재시작, 드묾)
    |
    v
[4단계: 비활성화 (필요 시)]
    .claude/agents/ → .claude/agents-archive/ 로 이동
    → 로드되지 않음, 삭제하지 않고 보관
    → 필요 시 agents/ 로 복원 (세션 재시작)
```

**디렉토리 구조**:
```
.claude/
├── agents/              ← 활성 에이전트 (자동 로드)
├── agents-archive/      ← 비활성 에이전트 (로드 안됨, 보관)
├── commands/            ← Skills (핫 리로드, 프로토타이핑)
└── agent-memory/        ← 에이전트별 누적 지식
```

---

## 12. 삭제 대상 에이전트 분석

### 12.1 gemini-cli-analyzer-agent → 삭제

**이유**: 이 에이전트는 `references/gemini-cli/gemini-cli/` 코드베이스를 분석하는 용도였다. 그런데 이제 Gemini CLI 자체를 도구로 사용할 수 있다 (`gemini -p`). 외부 도구를 분석하는 에이전트 대신, 외부 도구를 직접 호출하는 것이 더 낫다.

**대체**: `general-purpose` 에이전트 + Gemini CLI 직접 호출

### 12.2 infinite-canvas-analyzer-agent → 삭제

**이유**: 단일 라이브러리 분석 전용. 이 수준의 전문성은 `general-purpose`에 프롬프트로 주면 충분하다. 전용 에이전트를 유지하는 비용(컨텍스트 오버헤드, 유지보수) > 이득.

**대체**: `general-purpose` + `references/infinite-canvas/` 경로 지정

### 12.3 swarm-team-agent → /validate-structure 커맨드

**이유**: 폴더 구조 검증은 에이전트가 아니라 스크립트/커맨드가 적합. Skills는 핫 리로드되므로 에이전트보다 유연하다.

**대체**: `.claude/commands/validate-structure.md` (skills로 핫 리로드)

### 12.4 claude-agent-sdk-analyzer-agent → 삭제

**이유**: 에이전트 생성 빈도가 낮음. general-purpose에 `references/claude-agent-sdk/subagent-best-practices.md` 읽기 지시하면 동일 결과.

**대체**: `general-purpose` + best-practices 파일 경로 지정

### 12.5 theia-analyzer / electron-analyzer → framework-analyzer로 통합

**이유**: 섹션 5.2에서 설명. 단일 플랫폼의 두 레이어.

---

## 13. 에러 복구 설계

v1.0에는 에러 복구 프로토콜이 없었다.

### v2.0 에러 복구

```
에이전트 호출 실패?
    |
    v
실패 유형 판단:
    |
    +── 타임아웃/컨텍스트 초과 ──> session resume로 이어서
    |                              (이전 컨텍스트 유지됨)
    |
    +── 파일 생성 실패 ──> Main Thread가 function_results에서
    |                      내용 추출하여 직접 파일 생성
    |
    +── Bash 도구 실패 ──> 재시도 (최대 2회)
    |                      실패 지속 시 사용자에게 보고
    |
    +── 에이전트 자체 오류 ──> 같은 prompt로 재호출 (최대 2회)
    |                          실패 지속 시 사용자에게 보고
    |
    +── 병렬 에이전트 중 일부 실패 ──> 성공한 결과로 계속 진행
                                       실패한 부분만 재시도
```

**session resume의 에러 복구 이점**:
```
v1.0: 에이전트 실패 → 보고서 미생성 → 파일 not found → 워크플로우 중단
v2.0: 에이전트 실패 → session resume → 이전 지점에서 이어서 → 워크플로우 계속
```

---

## 14. 번호 체계 통일

v1.0에서 4개 이상의 번호 체계가 충돌:
- CLAUDE.md: Pattern 1, 2a, 2b, 3
- pm-workflows.md: Section 3a, 3b
- research-workflows.md: Type A, Type B
- PM commands: Pattern A~G

### v2.0 통일 체계

```
Branch A: Direct      (CLAUDE.md, protocol.md, agent-capabilities.md)
Branch B: Research     (CLAUDE.md, research-workflows.md)
Branch C: Implement    (CLAUDE.md, pm-workflows.md)

모든 문서에서 동일한 이름과 코드 사용.
알파벳 접두사로 문서 간 교차 참조 용이.
```

---

## 15. 파일 변경 요약

### 생성
| 파일 | 용도 |
|------|------|
| `.claude/agents/framework-analyzer.md` | Theia+Electron 통합 분석기 |
| `.claude/agents/code-reviewer.md` | UI/UX 리뷰 + dead code 감시 |
| `.claude/agents/auditor.md` | fault 추적 + 에이전트 피드백 (⚠️ 미실증) |
| `.claude/agents/warehouse-manager.md` | 파일 큐레이션 + 카탈로그 관리 (WM) |
| `.claude/docs/vision-constraints.md` | 비전 제약 내장 (PM 부하 감소) |
| `.claude/docs/multi-model.md` | 멀티모델 통합 가이드 |
| `.claude/commands/gemini.md` | Gemini CLI 래퍼 |
| `.claude/commands/codex.md` | Codex CLI 래퍼 |
| `.claude/commands/validate-structure.md` | 구조 검증 (swarm-team 대체) |
| `.claude/hooks/validate-file-path.py` | PreToolUse Write/Edit 경로/이름 검증 |
| `.claude/hooks/guard-rm-commands.py` | PreToolUse Bash rm 커맨드 감시 |
| `.claude/hooks/inject-subagent-context.sh` | SubagentStart 규칙 주입 |
| `.claude/hooks/session-hygiene.sh` | SessionStart 환경 점검 |
| `.claude/hooks/extract-file-changes.sh` | SubagentStop transcript 파싱 → wm-pending.txt |
| `.claude/agents-archive/` | 비활성 에이전트 보관 디렉토리 |

### 재작성
| 파일 | 변경 |
|------|------|
| `.claude/CLAUDE.md` | 3-Branch 구조, vision-constraints 참조, multi-model 참조 |
| `.claude/docs/protocol.md` | 3단계 통신 우선순위, session resume 중심 |
| `.claude/docs/agent-capabilities.md` | 실제 YAML 기반 재작성, 4개 에이전트 |
| `.claude/docs/pm-workflows.md` | PM 선택적 호출, memory/skills 활용 |
| `.claude/docs/research-workflows.md` | 단일 흐름 + 에스컬레이션, 멀티모델 |
| `.claude/docs/parallel-delegation.md` | 상대경로, Agent Teams 옵션 |
| `.claude/docs/organization.md` | subagent_reports/ 선택적, 정리 규칙 완화 |

### 수정
| 파일 | 변경 |
|------|------|
| `.claude/agents/egdesk-pm-agent.md` | memory, skills, Glob 수정, 지시사항 재작성 |
| `.claude/agents/ux-flow-simulator-agent.md` | Write, Edit 추가 |
| `.claude/agents/coding-agent.md` | Windows 경로 → 상대경로 |
| `.claude/settings.local.json` | Hook 설정 추가 (PreToolUse, SubagentStart, SubagentStop, SessionStart) |

### 삭제
| 파일 | 이유 |
|------|------|
| `.claude/agents/theia-analyzer-agent.md` | framework-analyzer로 통합 |
| `.claude/agents/electron-analyzer-agent.md` | framework-analyzer로 통합 |
| `.claude/agents/gemini-cli-analyzer-agent.md` | Gemini CLI 직접 사용 |
| `.claude/agents/infinite-canvas-analyzer-agent.md` | general-purpose로 대체 |
| `.claude/agents/swarm-team-agent.md` | /validate-structure로 전환 |
| `.claude/agents/claude-agent-sdk-analyzer-agent.md` | general-purpose로 대체 |
| `.claude/commands/my-workflow.md` | Dead code |
| `.claude/prompts/agent-orchestration.md` | Duplicate |
| `subagent_reports/README.md` | 임시 저장소에 부적절 |

---

---

## 16. Self-Accountability System (가칭 "월급 시스템") ⚠️ 설계 단계

### 16.1 동기

에이전트들이 작업을 "완료"라고 보고하지만 실제로 놓친 것들이 있어 사용자가 계속 "이거 확인해", "저거 확인해" 역할을 해야 하는 문제.

체크리스트 강제나 완료 기준 명확화 같은 자기보고 방식은 "완료했음"이라고 쓰면 그만이라 효과 없음.

**근본 원인**: LLM은 동기가 없다. 외부에서 강제로 검증하는 것만 실제 행동을 바꿀 수 있다.

### 16.2 설계 원칙

```
자기보고(X)          외부 검증(O)
체크리스트(X)        실제 결과 검증(O)
사후 처벌(△)         자동 재작업 루프(O)
```

### 16.3 전체 루프

```
사용자 짜증/불만 표출
        ↓
UserPromptSubmit hook → 감정 분석 (부정 감정 감지)
        ↓
MT에 신호 전달
        ↓
MT → Task(auditor)  ← 독립 context, MT 부하 없음
        ↓
auditor:
  1. 최근 에이전트 transcript 분석 (agent-[id].jsonl)
  2. 어떤 에이전트가 무엇을 놓쳤는가?
  3. 해당 에이전트 MEMORY.md에 직접 기록:
     "이 상황에서 이걸 놓침, 다음엔 X 확인"
  4. 결과 요약만 MT에 반환
        ↓
다음 에이전트 spawn 시 MEMORY 자동 로드
→ 같은 실수 감소
```

### 16.4 감정 분석 트리거

```python
# UserPromptSubmit hook
# 사용자 메시지에서 부정 감정 신호 감지

FRUSTRATION_SIGNALS = [
    "왜 안 됨", "이거 확인해", "또", "왜 이렇게",
    "짜증", "아니", "틀렸잖아", "다시"
]

# 감지 시 → MT context에 주입:
# "⚠ 사용자 불만 감지. fault 추적 필요."
```

### 16.5 자동 검증 가능한 것 vs 불가능한 것

```
자동 검증 가능 (객관적):          자동 검증 불가 (주관적):
  빌드 성공/실패                   "일 대충했다"
  타입 에러 수                     엣지케이스 누락
  테스트 통과 여부                 사용자 기대 불일치
  code-reviewer 이슈 수
        ↓                                ↓
  즉시 재작업 루프               감정 분석 → auditor 트리거
```

### 16.6 미해결 과제 (실증 필요)

```
1. SubagentStop hook에서 agent_transcript_path 자동 제공 여부
   → 실증 후 auditor 설계 확정

2. 감정 분석 정확도
   → 한국어 혼합 텍스트에서 부정 감정 감지 패턴 정의 필요

3. "월급 포인트" 수치화 여부
   → 수치보다 MEMORY 누적 자체가 핵심이므로 포인트 불필요할 수 있음
```

---

## 17. 신경계 대응 모델 (Cognitive Architecture Analogy)

> **별도 문서로 분리됨**
> 상세 내용: `ideas/brainstorming/COGNITIVE_ARCHITECTURE_ANALOGY.md`
>
> 이 섹션은 뇌과학 기반 에이전트 시스템 설계 아이디어 모음이다.
> v2 실제 구현과 직접 연결되는 항목은 아래 요약에서 확인.

### 17.1 핵심 매핑 요약

```
전두엽(prefrontal)   = LLM reasoning (Main Thread, Subagents)
편도체(amygdala)     = Emotion hook → Section 16 Self-Accountability
해마(hippocampus)    = File system (MEMORY.md, ideas/, refs/)
기저핵(basal ganglia) = Hooks, Agent YAML → Section 9
운동피질(motor)      = Tools (Bash, Write, Read...)
운동 연합(premotor)  = Skills / Commands
척수 반사            = Hooks (PreToolUse deny, 의식 우회)
MCP                 = Body schema 확장 (외부 도구 연결)
신피질(neocortex)    = hooks/CLAUDE.md/agents (시스템 구조 자체, type 바깥)
```

### 17.2 v2 설계에 직접 연결되는 아이디어

아래 개념들은 `COGNITIVE_ARCHITECTURE_ANALOGY.md`에서 상세 설계:

| 아이디어 | 관련 v2 섹션 | 상태 |
|---------|------------|------|
| 4-type 인지 태깅 (asset/knowledge/log/hypothetical) | Section 8, 9, 10 | ⚠️ 설계 단계 |
| .gitattributes 기반 파일 태깅 | Section 8 | ⚠️ 설계 단계 |
| 에피소드 기반 기억 구조 (episodes/) | Section 8 | ⚠️ 설계 단계 |
| 작업 기억 스코프 관리 (File-as-Stack) | Section 3, 10 | ⚠️ 설계 단계 |
| 외수용감각 (출력 매체 메타데이터 주입) | Section 9 | ⚠️ 설계 단계 |
| 자율신경 모드 전환 (emergency/balanced/efficient) | Section 1, 9 | ⚠️ 설계 단계 |
| 해마 파일 라이프사이클 + GC | Section 8, 9 | ⚠️ 설계 단계 |

### 17.3 기저핵 이관 패턴 (현재 v2에 반영된 것)

```
전두엽(LLM)에서 반복→자동화된 패턴을 기저핵(Hook)으로 이관:

  의식적: "ideas/confirmed/에 쓸 때 SCREAMING_SNAKE_CASE 확인"
  자동화: PreToolUse hook이 자동 검증 → LLM context 절약

log → knowledge → hook 수정 파이프라인:
  경험(log) → 교훈 추출(knowledge) → 행동 변경(hook/agent)
```

→ 상세: `ideas/brainstorming/COGNITIVE_ARCHITECTURE_ANALOGY.md`

---

*설계서 끝*
