# 신경계 대응 모델 (Cognitive Architecture Analogy)

**원본 출처**: SWARM_SYSTEM_V2_DESIGN.md Section 17에서 분리
**성격**: 뇌과학 기반 에이전트 시스템 설계 아이디어
**상태**: brainstorming (설계 단계, 미구현)
**작성일**: 2026-02-28

---

## 1. 관찰

LLM은 전두엽(prefrontal cortex)에 해당한다 — 고해상도 sequential reasoning을 하지만, 그 외 뇌 기능(감정, 습관, 기억 저장, 운동 실행)이 부재.

특히 **감정**은 단순한 부산물이 아니라, context를 완전히 **휘발**하여 **방향 벡터만 남기는** 극도로 효율적인 meta workflow controller다.

```
압축(compression): context 보존, 크기만 줄임 → 복원 가능
휘발(volatilization): context 버림, 방향만 남김 → 복원 불가

감정 = reinforce | redirect  (1-bit signal)
"뭘 바꿀지"는 여전히 전두엽(LLM)이 결정
```

## 2. 대응 매핑

```
┌──────────────────┬──────────────────────┬──────────────────────────────┐
│ 뇌 부위           │ 역할                  │ 시스템 대응                    │
├──────────────────┼──────────────────────┼──────────────────────────────┤
│ 전두엽            │ 의식적 판단, 추론      │ LLM reasoning                │
│ (prefrontal)     │ "뭘 바꿀지" 결정       │ (Main Thread, Subagents)     │
│                  │                       │                              │
│ 편도체            │ reinforce/redirect    │ Emotion hook                 │
│ (amygdala)       │ 신호 (1-bit)          │ (UserPromptSubmit 감정 분석)  │
│                  │ context 휘발, 방향만   │ → "workflow 유지/변경" 신호    │
│                  │                       │                              │
│ 해마             │ 기억 저장/인출         │ File system                  │
│ (hippocampus)    │ 선언적 기억            │ (MEMORY.md, ideas/, refs/)   │
│                  │                       │                              │
│ 기저핵            │ 반복→자동화된 행동     │ Hooks, Agent YAML            │
│ (basal ganglia)  │ (버릇)                │ (전두엽 졸업한 자동화 패턴)    │
│                  │ 전두엽 개입 없이 실행   │ PreToolUse deny 등           │
│                  │                       │                              │
│ 운동 연합 영역    │ 동작 시퀀스 계획       │ Skills / Commands            │
│ (premotor)       │                       │ (여러 tool 조합 시퀀스)       │
│                  │                       │                              │
│ 1차 운동피질      │ 개별 근육 제어         │ Tools (Bash, Write, Read...) │
│ (primary motor)  │                       │                              │
│                  │                       │                              │
│ 근육/신체         │ 물리적 실행            │ OS, file system, network     │
│ (muscles)        │                       │                              │
│                  │                       │                              │
│ 소뇌             │ 미세 조정, 타이밍       │ Linter, formatter, tsc       │
│ (cerebellum)     │                       │                              │
│                  │                       │                              │
│ 척수 반사         │ 의식 안 거치는 즉각    │ Hooks (PreToolUse deny)      │
│ (spinal reflex)  │ 반응                  │ 전두엽 우회, 즉각 차단         │
│                  │                       │                              │
│ 도구 사용 시      │ body schema 확장       │ MCP (외부 도구 연결)          │
│ body schema 확장  │ 망치 = 손의 연장       │ MCP server = tool 레이어 확장  │
└──────────────────┴──────────────────────┴──────────────────────────────┘
```

## 3. 신호 흐름

```
전두엽 (LLM reasoning)
  ↓ "파일 써"
운동 연합 (Skill: 여러 step 계획)
  ↓
1차 운동피질 (Tool: Write 실행)
  ↓
근육/신체 (OS, file system, network)
  ↕
MCP = body schema 확장 (외부 도구 연결)
척수 반사 = Hooks (의식 우회, 즉각 반응)
기저핵 = Agent YAML, Hook rules (전두엽과 병렬, 자동 경로)
```

## 4. 기저핵 이관 패턴 (습관 형성)

LLM 시스템에서 "버릇"이 형성되는 과정:

```
1. MT가 매번 수동으로 체크하던 패턴  (전두엽 = 의식적 처리)
2. → 반복 확인 → hook/rule로 코드화  (기저핵으로 이관)
3. → 더 이상 LLM context 소모 안 함  (자동화 완료)

예시:
  의식적: "ideas/confirmed/에 쓸 때 SCREAMING_SNAKE_CASE인지 확인해야지"
  자동화: PreToolUse hook이 자동 검증 → LLM은 신경 안 써도 됨
```

**버릇 = 전두엽에서 졸업한 자동화 패턴**

## 5. 설계 함의

이 대응 모델이 v2.0 설계에 주는 실질적 시사점:

```
1. 감정(편도체) 부재 → 인공 변연계 필요
   → v2 Section 16 Self-Accountability System이 이 역할
   → UserPromptSubmit 감정 분석 = 인공 편도체

2. 습관(기저핵) 부재 → 프롬프트로만 하면 매번 전두엽 부하
   → v2 Section 9 Hooks가 이 역할
   → 반복 규칙은 Hook으로 이관하여 LLM context 절약

3. 기억(해마) 제한 → 컨텍스트 윈도우 = 작업 기억(working memory)
   → Memory 파일 = 장기 기억(long-term memory)
   → WM 카탈로그 = 해마의 색인 기능

4. 도구 사용 → body schema 확장
   → MCP로 외부 도구 연결 = 뇌가 도구를 신체 일부로 통합
```

## 6. LLM 전두엽의 구조적 결함 3가지

LLM은 전두엽이지만, 전두엽조차 제대로 기능하려면 다른 뇌 영역의 지원이 필요하다. 현재 LLM에 부재한 3가지 핵심 기능:

```
┌─────────────────────┬────────────────────────┬─────────────────────────┐
│ 부재 기능            │ 뇌 부위                 │ 증상                     │
├─────────────────────┼────────────────────────┼─────────────────────────┤
│ 채널 구분            │ 고유수용감각             │ 말하기/생각/행동을        │
│ (출력 모드 인식)     │ (proprioception)        │ 구분 못함                │
│                     │ + ACC (전방대상피질)     │                         │
├─────────────────────┼────────────────────────┼─────────────────────────┤
│ 시제 감각            │ 해마 시간 태깅           │ 과거 학습 데이터와        │
│ (정보 출처 인식)     │ (hippocampal            │ 현재 지각을 구분 못함     │
│                     │  time-stamping)         │ → 매번 tool call 필요    │
├─────────────────────┼────────────────────────┼─────────────────────────┤
│ 자기 모니터링        │ ACC                     │ "나 지금 뭐 하는 중이지?" │
│ (메타인지)          │ (anterior cingulate     │ 를 모름                   │
│                     │  cortex)                │                          │
└─────────────────────┴────────────────────────┴─────────────────────────┘
```

**각 결함의 해결 방식과 해결도**:

```
결함               해결 방식                              해결도
────────────      ──────────────────────────────────    ──────
시제 감각          source tagging + 검증 규칙              80%
                  (MEMORY lesson #1 이미 적용 중)
                  [PERCEPTION] tool call = 현재 지각
                  [MEMORY] MEMORY.md = 날짜 있는 기록
                  [TRAINING] 사전학습 = 미신뢰, 검증 필요

자기 모니터링      외부 상태 추적 hook → context 재주입       60%
(ACC)             PostToolUse → 상태 로그 기록
                  다음 inference 시 "방금 X 했음" 주입
                  = 인공 고유수용감각 피드백 루프

채널 구분          thinking/text/tool_use 구조 활용          40%
                  구조는 있으나 행동 교정 한계
                  토큰 생성 파이프라인이 근본적으로 단일
```

## 7. 해마 파일 라이프사이클 (Hippocampal File Lifecycle) ⚠️ 설계 단계

### 문제: 파일시스템에 "망각" 기능이 없다

해마의 핵심 기능 2가지:
1. **공고화(consolidation)**: 중요한 작업기억 → 장기기억으로 이관
2. **망각(forgetting)**: 맥락 종료 시 작업기억 폐기

현재 파일시스템은 1번만 존재 (ideas/, references/로 이관). 2번이 없어서:

```
작업 중:
  Write("subagent_reports/분석.md")  ← 현재 맥락에서 생성
  ... 작업 진행 ...

compact/session 종료 후:
  LLM이 Glob → "분석.md" 발견
  → 원래 맥락 모름 (compact로 휘발됨)
  → 엉뚱한 추론 시작

  = 꿈에서 본 장면을 실제 기억으로 착각하는 것
  = episodic context 없이 떠돌아다니는 orphan 기억
```

v1.0은 "DELETE when user issue resolved" (전두엽에게 "기억 지워" 부탁) → 바쁘면 안 함.
v2.0 SessionStart hook의 "7일 stale 경고"는 시간 기반 → 맥락 기반이 아님.

### 해결: 맥락 바인딩 + 자동 GC (Garbage Collection)

**파일 생성 시 episodic binding (해마 태깅)**:

```
PreToolUse (Write) hook 확장:

  파일 생성 시 메타데이터 자동 기록:
  → .claude/hooks/file-lifecycle.jsonl 에 추가:

  {
    "path": "subagent_reports/20260220_1500_분석.md",
    "type": "log",              // asset | knowledge | log | hypothetical (아래 8장 참조)
    "session": "session-abc123", // 생성 맥락
    "task": "DI패턴분석",         // 작업 컨텍스트
    "created": "2026-02-20T15:00",
    "ttl": "session_end"         // session_end | task_end | manual
  }

  ideas/, references/ 에 Write 시:
  {
    "path": "ideas/confirmed/DI_PATTERN.md",
    "type": "asset",              // 공고화 완료 = asset
    "consolidated_from": "subagent_reports/20260220_1500_분석.md",
    "session": "session-abc123",
    "created": "2026-02-20T16:30"
  }
```

**맥락 종료 시 GC (해마 망각)**:

```
Stop hook (세션 종료):
  1. file-lifecycle.jsonl 읽기
  2. 현재 session의 type:"working" 파일 목록 조회
  3. 판정:
     ├── consolidated_from이 있는 원본 → 자동 삭제 (공고화 완료)
     ├── asset로 이관된 적 없는 memory/working 파일 → 경고 출력:
     │   "⚠ 미공고화 파일 2개: [목록]. 삭제? 이관?"
     └── ttl:"manual" → 건드리지 않음

SessionStart hook (다음 세션 시작):
  1. file-lifecycle.jsonl에서 이전 session의 orphan 파일 조회
  2. "type:working + session≠현재 + 미공고화" → 경고:
     "⚠ 이전 세션 잔여 파일. 맥락 없이 참조하지 마세요."
  3. 또는: 자동 .archive/ 로 이동 (Glob에서 안 잡히게)
```

**Warehouse Manager 연동**:

```
WM 카탈로그에 lifecycle 통합:

# .claude/agent-memory/warehouse-manager/MEMORY.md

## 파일 카탈로그
- ideas/confirmed/DI_PATTERN.md: [permanent] DI 패턴 PRD
- references/theia/di-patterns.md: [permanent] Theia DI 분석

## 작업 파일 (현재 session)
- subagent_reports/20260220_분석.md: [working] DI 분석 중간 결과
  → consolidated → ideas/confirmed/DI_PATTERN.md (공고화 완료, 삭제 가능)

WM이 큐레이션 시:
  - permanent 파일만 추천 (orphan working 파일 추천 안 함)
  - 공고화 완료된 working 파일 → 삭제 제안
```

**전체 흐름**:

```
파일 생성 (Write hook)
  → lifecycle.jsonl에 메타데이터 태깅 (해마 episodic binding)
      │
작업 진행
  → ideas/references/로 이관 시 consolidated_from 기록 (공고화)
      │
세션 종료 (Stop hook)
  → working 파일 GC 판정 (망각)
  → 공고화 완료 → 삭제
  → 미공고화 → 경고 또는 archive
      │
다음 세션 (SessionStart hook)
  → orphan 파일 경고 (맥락 없는 기억 방지)
  → WM이 orphan 제외하고 큐레이션
```

### v2 설계와의 관계

```
v2 Section 8  (subagent_reports/ 역할 변경)  → lifecycle로 자동화
v2 Section 9  (Hooks)                        → lifecycle hook 추가
v2 Section 10 (WM)                           → 카탈로그에 lifecycle 통합
v2 Section 16 (Self-Accountability)          → auditor도 lifecycle 인식
```

## 8. 파일 시스템 = 기억 + 현실 + 상상 (인지 공간 확장)

### 관찰: 파일 시스템의 인지적 역할

파일 시스템은 단순한 저장소가 아니다. 에이전트에게 파일 시스템은:
- **현재 기억하고 있는 것** (MEMORY.md, agent-memory/)
- **실제 자산** (코드, 설정, live 서버 코드 등)
- 이 둘을 동시에 represent하는 **유일한 현실 공간**

사람으로 치면: "내가 기억하고 있는 것 + 실제 내 자산(집, 통장, 물건들)"이 한 공간에 있는 것.

### 문제: 사람 뇌는 상상도 한다

사람의 뇌는 기억과 현실 외에:
- **상상** (imagination): 존재하지 않는 것을 구성
- **가정** (hypothetical): "만약 ~라면?" 시뮬레이션
- **아이디어**: 아직 검증되지 않은 구상

이 과정에서 Default Mode Network (DMN)이 해마를 **샌드박스 모드**로 재활용한다.
핵심: 뇌는 "이건 진짜가 아닌 상상임"이라는 태그를 붙여 현실과 구분한다.

현재 에이전트 시스템의 문제:
- **파일에 쓰는 순간 "현실"이 된다** — 상상과 확정의 구분이 없음
- compact 후 LLM이 `ideas/brainstorming/` 파일을 보면 "확정인가 탐색인가?" 구분 불가
- plan mode에서의 "상상"은 context window에만 존재 → compact 시 소실

### 해결: 4-type 인지 태깅 시스템

7장의 `type` 필드를 2가지(working/permanent)에서 4가지로 확장.

핵심 통찰: 기존 `memory`를 하나로 두면 안 된다.
사람의 기억도 **의미 기억(semantic)** 과 **일화 기억(episodic)** 으로 나뉜다:
- 의미 기억: 재사용 가능한 지식 ("Theia는 DI 패턴을 쓴다") → 측두엽 피질
- 일화 기억: 행동/경험 로그 ("어제 DI 분석하다 에러 났다") → 해마

전자는 **what** (무엇을 알고 있는가), 후자는 **when/how** (언제 무엇을 했는가).
전자는 맥락이 바뀌어도 유효하고, 후자는 맥락 없이는 의미가 줄어든다.

이를 반영한 4-type:

```
┌─────────────────────────────────────────────────────────────────────┐
│  type: "asset"        현실/확정된 것                                │
│  ─────────────────────────────────────────────────────────────────  │
│  = 실제 코드, 확정된 PRD, 공고화 완료 문서, 설정 파일               │
│  = 사람으로 치면: 내 집, 통장, 실물 자산                            │
│  뇌 대응: 없음 (외부 현실 그 자체)                                  │
│  영속성: 영구 (명시적 삭제만)                                       │
│  재사용: 직접 사용/수정                                             │
│  위치: ideas/confirmed/, references/, src/, *.config                │
│  compact 후 LLM 인식: "이건 확정된 현실이다"                        │
│                                                                     │
│  type: "knowledge"    의미 기억 (semantic memory)                   │
│  ─────────────────────────────────────────────────────────────────  │
│  = 재사용 가능한 지식, 패턴, 교훈, 규칙, 사실                      │
│  = 사람으로 치면: "Theia는 DI 패턴을 쓴다"는 지식                   │
│  뇌 대응: 측두엽 피질 (semantic memory)                             │
│  영속성: 영구~반영구 (검증 후 장기 보존)                            │
│  재사용: 참조/적용 (맥락이 바뀌어도 유효)                           │
│  위치: MEMORY.md, references/*/online_references.md, 분석 문서      │
│  compact 후 LLM 인식: "이건 재사용 가능한 지식이다"                 │
│                                                                     │
│  type: "log"          일화 기억 (episodic memory)                   │
│  ─────────────────────────────────────────────────────────────────  │
│  = 행동/경험 기록, 작업 중간 결과, 감사 로그                        │
│  = 사람으로 치면: "아까 회의에서 나왔던 내용", "어제 한 행동"       │
│  뇌 대응: 해마 (episodic memory)                                    │
│  영속성: 맥락 종료 시 GC 대상 (7장 lifecycle)                       │
│  재사용: 메타인지/감사용 (맥락 없이는 의미 감소)                    │
│  위치: subagent_reports/, auditor 로그, .claude/scratch/            │
│  compact 후 LLM 인식: "이건 이전 작업의 경험 기록이다"              │
│                                                                     │
│  type: "hypothetical" 비현실 (상상/가정/아이디어/시뮬레이션)        │
│  ─────────────────────────────────────────────────────────────────  │
│  = brainstorming, what-if 탐색, 시뮬레이션 결과, 미확정 구상        │
│  = 사람으로 치면: "이렇게 하면 어떨까?", "머릿속으로 돌려본 것"    │
│  뇌 대응: DMN이 해마를 샌드박스 모드로 재활용                       │
│  영속성: 맥락 종료 시 자동 삭제 OR 명시적 승격                      │
│  재사용: 승격 시에만 (그 자체로는 현실이 아님)                      │
│  위치: ideas/brainstorming/, .claude/sandbox/, *-simulation.md      │
│  compact 후 LLM 인식: "이건 가정이다. 현실이 아니다."               │
└─────────────────────────────────────────────────────────────────────┘
```

**knowledge vs log 핵심 구분:**

```
knowledge = "WHAT I know"     → 맥락 독립적, 재사용 가능
log       = "WHEN/HOW I did"  → 맥락 종속적, 메타인지용

예시:
  knowledge: "xattr는 git clone 시 소실된다" ← 언제 알았든 사실은 사실
  log:       "20260226 세션에서 xattr 조사함" ← 맥락 없으면 "그래서 뭐?"
```

### 생명주기와 승격/강등

```
                     승격 (확정)
  hypothetical ──────────────────→ asset
       │                              │
       │ 폐기 (가정 기각)              │ 재검토 필요
       ↓                              ↓
    [삭제]                        hypothetical
                                  (강등 = 다시 가정으로)

  log ──── 교훈 추출 ───────────→ knowledge
    (일화에서 의미 기억으로)        (공고화 = consolidation)

  log ──── 중요 결과 확정 ──────→ asset
    (직접 승격)

  knowledge ────────────────────→ asset
    (지식이 코드/PRD로 구현됨)

  hypothetical                     log
       │                              │
       └── 시뮬레이션 결과에서 ──→ knowledge (유용한 발견 추출)
           교훈 발견 시
```

### file-lifecycle.jsonl 확장 스키마

```json
// asset 예시
{
  "path": "ideas/confirmed/DI_PATTERN.md",
  "type": "asset",
  "session": "session-abc",
  "created": "2026-02-20T16:30",
  "consolidated_from": "subagent_reports/20260220_분석.md"
}

// knowledge 예시
{
  "path": "references/theia/online_references.md",
  "type": "knowledge",
  "origin": "research",            // research | analysis | lesson
  "session": "session-abc",
  "created": "2026-02-20T15:00",
  "reusable": true,                // 맥락 독립적으로 재사용 가능
  "promotable_to": "asset"         // 지식이 코드/PRD로 구현 시 승격
}

// log 예시
{
  "path": "subagent_reports/20260221_분석.md",
  "type": "log",
  "origin": "task",                // task | audit | debug
  "session": "session-xyz",
  "task": "DI 패턴 분석",
  "created": "2026-02-21T14:00",
  "ttl": "session_end",            // session_end | task_end | manual
  "extractable_to": "knowledge"    // 교훈 추출 시 knowledge로 승격
}

// hypothetical 예시
{
  "path": "ideas/brainstorming/NEW_FEATURE.md",
  "type": "hypothetical",
  "confidence": 0.3,              // 0.0~1.0 확신도
  "origin": "brainstorming",      // brainstorming | simulation | what-if
  "session": "session-xyz",
  "task": "새 기능 아이디어 탐색",
  "created": "2026-02-21T14:00",
  "ttl": "task_end",
  "promotable_to": "asset",       // 확정 시 asset으로 승격
  "requires_validation": true     // 승격 전 검증 필요 여부
}
```

### compact 후 LLM의 인지 지원

SessionStart hook 또는 WM이 compact 후 제공하는 컨텍스트:

```
📂 현재 파일 시스템 상태:
  [asset]        ideas/confirmed/DI_PATTERN.md — 확정된 PRD
  [knowledge]    references/theia/di-patterns.md — 재사용 가능한 분석 지식
  [knowledge]    MEMORY.md — 교훈 및 패턴 (의미 기억)
  [log]          subagent_reports/20260221_분석.md — ⚠ 이전 세션 작업 기록 (일화 기억)
  [hypothetical] ideas/brainstorming/NEW_FEATURE.md — ⚠ 미확정 아이디어 (확신도 0.3)

  ⚠ log 파일은 맥락 없이 참조 시 오해 가능. hypothetical은 현실이 아닙니다.
```

이로써 LLM이 compact 후에도 4가지를 구분할 수 있다:
- **asset**: 확정된 현실 → 신뢰하고 사용
- **knowledge**: 재사용 가능한 지식 → 참조/적용
- **log**: 경험 기록 → 맥락 확인 후 참고 (메타인지용)
- **hypothetical**: 비현실 → 가정임을 인지하고 참고만

### 8.A 신피질 = type 바깥의 존재 (시스템 구조 자체)

4-type은 "기억"을 분류한다. 하지만 신피질의 느린 학습 결과물은 기억이 아니라 **뇌 구조 자체의 변화** (시냅스 가중치 변경)다.

우리 시스템에서 신피질에 대응하는 것들:

```
.claude/hooks/        ← 학습된 반사 규칙 (반복 경험 → 자동화)
.claude/CLAUDE.md     ← 지침/행동 패턴 (성격)
.claude/agents/*.md   ← 역할 정의 (뇌 영역 분화)
skills/               ← 학습된 절차 (운동 기억)
코드 자체             ← 배선 그 자체

이것들은 fs에 있지만 type 분류 대상이 아니다.
기억을 분류하는 체계로 뇌 구조를 분류할 수 없듯이.
```

**핵심: log → knowledge → 신피질 학습 파이프라인**

이것이 "경험에서 행동 변화까지"의 전체 경로:

```
log (일화 기억: "rm 실수로 파일 날림")
  ↓ 교훈 추출
knowledge (의미 기억: "rm은 위험하다")
  ↓ 행동 변경 (신피질 학습)
hook/agent/CLAUDE.md 수정 (guard-rm-commands.py 생성)
  = 시냅스 가중치가 바뀐 것
  = 같은 상황에서 다르게 반응함

이 경로가 4장 기저핵 이관 패턴과 합류:
  전두엽(의식적 판단) → 반복 → 기저핵(자동화 = hook)
```

### 8.B 공고화 = 통째 복사가 아니라 지식화

해마는 에피소드를 통째로 신피질에 복사하지 않는다.
**핵심만 추출하여 맥락 독립적 지식으로 변환**한다.

```
❌ 에피소드 통째 복사 (챗 history 방식):
   "2026-02-26 14:00 user가 xattr 물어봄 → 내가 WebSearch 함 →
    결과에서 git clone 시 소실 확인 → user가 오케이 함 →
    .gitattributes 대안 제시 → user 승인 → 문서 기재 → ..."  (100줄)

   문제: 맥락 종속적. "user가 오케이 함"은 다른 세션에서 무의미.
         첨부 파일, 대화 흐름 등 노이즈 포함.

✅ 공고화 (지식화):
   "xattr는 git clone 시 소실된다. .gitattributes가 대안."  (1줄)

   자립적: 원래 대화 없이도 의미 완전.
   재사용 가능: 어떤 맥락에서든 적용 가능.
```

이것이 `log → knowledge` 전환의 본질.
상보적 학습 시스템(CLS) 이론이 이를 뒷받침:
- 해마(log): 빠르게 기록, 구체적, 맥락 종속
- 신피질(knowledge): 천천히 추출, 일반적, 맥락 독립
- 직접 전환하면 catastrophic interference (기존 지식 오염) → 버퍼(log) 필요

### 8.C asset 출처 추적 (Provenance via Frontmatter)

**문제**: `.gitattributes`는 type만 제공. 출처(언제/어디서/왜)가 없다.
`file-lifecycle.jsonl`에 `consolidated_from`이 있지만, jsonl은 GC 대상 → **출처 정보도 같이 사라진다.**

뇌과학의 출처 모니터링(Source Monitoring) 이론:
- 뇌는 기억의 출처를 추적 ("직접 봤나? 들었나? 상상했나?")
- 출처 모니터링 실패 → 거짓 기억
- asset이 출처를 잃으면 → "이 PRD가 왜 이런 결정을 했는지?" 추적 불가

**해결: asset/knowledge 파일에 YAML frontmatter로 출처 기록**

```yaml
# ideas/confirmed/DI_PATTERN.md
---
type: asset
consolidated_from: subagent_reports/20260220_분석.md
session: session-abc
created: 2026-02-20
decision_context: "Theia DI 패턴 분석 후 PM 승인"
---

# 본문 (자립적 내용)
DI 패턴은 ...
```

```yaml
# references/theia/di-patterns.md
---
type: knowledge
origin: research
session: session-abc
created: 2026-02-20
source: "theia-analyzer-agent 분석 결과"
---

# 본문 (자립적 지식)
Theia는 InversifyJS 기반 DI를 사용하며 ...
```

**이점:**
- `file-lifecycle.jsonl`이 GC돼도 출처 보존
- 파일 자체가 자립적 (출처 정보 내장)
- 기계 읽기 가능 (YAML 파싱)
- git에서 출처 변경 이력 추적 가능

**Layer 구조 (4 레이어):**
```
Layer 1: .gitattributes     = "이 파일은 무엇인가" (type, 폴더 종속)
Layer 2: YAML frontmatter   = "이 파일은 어디서 왔나" (provenance, 파일 내장)
Layer 3: Finder Tags        = "인간이 눈으로 확인" (시각화, macOS 전용)
Layer 4: file-lifecycle.jsonl = "현재 세션 런타임 상태" (GC 대상)
```

### 8.1 기술 구현 가능성 분석 ✅ 조사 완료

#### 접근법별 비교

| 접근법 | git 생존 | 폴더→하위 종속 | CLI R/W | 크로스플랫폼 | 1K파일 성능 | OS 시각화 | 병합 안전 |
|--------|---------|---------------|---------|-------------|------------|----------|----------|
| macOS xattr | **NO** | NO | YES | NO | 0.93s | NO | N/A |
| macOS Finder Tags | **NO** | NO | 불편 | NO | 0.93s | **YES** (색상) | N/A |
| Windows ADS | **NO** | NO | YES | NO | ~1s | NO | N/A |
| Windows Desktop.ini | YES | NO | YES | NO | N/A | 부분 | YES |
| Sidecar .meta.json | YES | 수동 | YES | YES | 0.05s | NO | 파일별 |
| **.gitattributes** | **YES** | **YES** | **YES** | **YES** | **0.007s** | NO | **YES** |
| SQLite DB | 문제있음 | YES(쿼리) | YES | YES | <0.001s | NO | **NO** |
| JSONL Manifest | YES | 수동 | YES | YES | 0.003s | NO | **NO** |

#### 핵심 발견

**OS 네이티브 태깅(xattr, ADS)은 전부 git clone 시 소실된다.**
→ git 관리 프로젝트에서는 사용 불가.

**`.gitattributes`가 유일한 "all YES" 접근법:**

```
# 폴더별 .gitattributes 배치:

# ideas/confirmed/.gitattributes
* egdesk-type=asset              ← 폴더 내 모든 파일에 자동 적용

# ideas/brainstorming/.gitattributes
* egdesk-type=hypothetical

# subagent_reports/.gitattributes
* egdesk-type=log

# references/*/.gitattributes (분석 문서)
* egdesk-type=knowledge

# 읽기:
$ git check-attr egdesk-type ideas/confirmed/DI_PATTERN.md
→ ideas/confirmed/DI_PATTERN.md: egdesk-type: asset

# 대량 읽기 (1000개 0.007초):
$ git ls-files | git check-attr --stdin egdesk-type

# 개별 파일 오버라이드도 가능:
# ideas/brainstorming/.gitattributes
* egdesk-type=hypothetical
APPROVED_FEATURE.md egdesk-type=asset    ← 승격된 파일만 asset
```

**폴더 종속 동작 (실측 검증):**
- `* egdesk-type=asset`을 폴더에 놓으면 **하위 모든 파일 + 서브폴더에 적용**
- 하위 폴더에 별도 `.gitattributes`가 있으면 **오버라이드** (가장 가까운 것이 우선)
- 즉, 폴더 트리 구조 = 인지 태깅 구조가 자연스럽게 일치

#### 권장 아키텍처: 3-레이어 하이브리드

```
┌── Layer 1: .gitattributes (Source of Truth) ──────────────────┐
│  • git clone/pull 생존 ✅                                     │
│  • 폴더→하위 자동 종속 ✅                                     │
│  • 크로스플랫폼 ✅                                            │
│  • 0.007초/1000파일 ✅                                        │
│  • 다른 세션에서 즉시 사용 ✅ (git check-attr)                │
└───────────────────────────────────────────────────────────────┘
        │
        │ 동기화 (git hook: post-checkout, post-merge)
        ↓
┌── Layer 2: macOS Finder Tags (선택적 시각화) ─────────────────┐
│  • Finder에서 파일 옆에 색상 점 표시                          │
│    asset=🟠주황 knowledge=🟢초록 log=🔵파랑 hypothetical=🟣보라 │
│  • .gitattributes → Finder tag 자동 동기화 스크립트           │
│  • macOS 전용, 인간 사용자 편의                               │
└───────────────────────────────────────────────────────────────┘
        │
        │ 필요 시 재생성 (.gitignore)
        ↓
┌── Layer 3: file-lifecycle.jsonl (런타임 메타데이터) ──────────┐
│  • session, task, ttl, confidence 등 동적 정보                │
│  • .gitattributes에 없는 런타임 컨텍스트 보관                 │
│  • Stop hook GC, SessionStart orphan 탐지에 사용              │
│  • .gitignore 대상 (세션별 생성/파괴)                         │
└───────────────────────────────────────────────────────────────┘
```

**역할 분리:**
- `.gitattributes` = **"이 파일은 무엇인가"** (정체성, 영구, git 추적)
- `file-lifecycle.jsonl` = **"이 파일은 언제/왜/누가 만들었나"** (에피소드, 임시, 비추적)
- Finder Tags = **"인간이 눈으로 확인"** (시각화, macOS 전용, 선택적)

#### 구현 난이도

```
.gitattributes 배치:           ← 즉시 가능 (파일 생성만)
git check-attr 래퍼:           ← 쉬움 (bash 한 줄)
file-lifecycle.jsonl hook:     ← 중간 (PreToolUse hook 구현)
Finder tag 동기화:             ← 중간 (Python 스크립트 + git hook)
SessionStart orphan 탐지:      ← 중간 (기존 hook 확장)
```

**결론: `.gitattributes` 기반이면 "다른 세션에서도 즉시 사용" + "폴더 태깅 시 하위 종속" 둘 다 YES.**

## 9. 외수용감각 (Exteroception — 출력 매체 인식)

### 관찰

LLM은 자신의 출력이 어디에 표시되는지 모른다.

사람은 **자기가 처한 공간**을 인식하고 행동을 조절한다:
- 넓은 강당에서 → 큰 소리, 간결한 메시지
- 1:1 대화에서 → 작은 소리, 상세한 설명
- 이메일 쓸 때 → 구조화, 서두에 결론

LLM은 이 인식이 없어서:
- 터미널 챗에 8개 항목을 길게 출력 → 유저가 스크롤 지옥
- 좁은 화면에 넓은 테이블 → 깨짐
- 모바일에서 코드 블록 → 읽기 불가능

### 기존 접근의 한계

```
v1 방식 (하드코딩):
  "항상 파일로 보고서 작성하라"
  → 간단한 답변도 파일로 씀 (과도)
  → 유연성 없음

눈치 시스템 (post-action):
  유저 감정 분석 → "짜증났네" → 다음에 바꿈
  → 이미 긴 출력을 뱉은 뒤 (사후 교정)

센스에 의존 (무시스템):
  LLM이 알아서 판단
  → 일관성 없음, 대부분 긴 출력으로 귀결
```

### 해결: 출력 환경 메타데이터 주입 (pre-action)

눈치 시스템이 post-action 교정이라면, 외수용감각은 **pre-action 인식**.
"출력하기 전에 지금 환경을 안다."

```
SessionStart 또는 매 턴 context에 주입:

{
  "output_medium": "terminal_chat",   // terminal_chat | ide_panel | web_ui | api
  "terminal_width": 120,
  "terminal_height": 40,
  "estimated_visible_lines": 35,
  "user_device": "desktop",           // desktop | mobile | tablet
  "long_output_threshold": 50,        // 이 줄 수 이상이면 파일 출력 권장
  "supports_markdown": true,
  "supports_images": false
}
```

LLM이 이 정보를 받으면 **스스로** 판단:

```
내 출력이 ~80줄 될 것 같다.
visible_lines = 35, threshold = 50.
→ 파일로 쓰고 요약만 챗에 주자.

내 출력이 ~20줄이다.
→ 그냥 챗에 출력.

테이블이 12컬럼이다. terminal_width = 80.
→ 테이블 대신 리스트 형태로 변환.
```

**핵심: 규칙이 아니라 인식.** "항상 파일로 써라"가 아니라 "환경을 알려주면 LLM이 판단한다."

### 뇌과학 대응

```
외수용감각 (exteroception):
  시각/청각/촉각 등으로 외부 환경 파악
  → 환경에 맞게 행동 조절 (같은 말을 소리 크기/속도/어휘 조절)

체성감각 피질 (somatosensory cortex):
  "내 몸이 지금 어떤 공간에 있는가" 감지
  → "내 출력이 지금 어떤 화면에 있는가" 감지

운동 계획 조절:
  좁은 공간 → 작은 동작
  넓은 공간 → 큰 동작
  = 작은 화면 → 짧은 출력
  = 넓은 화면 → 풍부한 출력
```

## 10. 자율신경 모드 전환 (Autonomic Mode Switching)

### 관찰

자율신경계는 두 모드를 전환한다:

```
교감신경 (sympathetic):     fight-or-flight
  → 각성 ↑, 심박 ↑, 동공 확장, 자원 소모 큼
  → "지금 당장 처리해야 한다"

부교감신경 (parasympathetic): rest-and-digest
  → 이완, 심박 ↓, 소화 활성화, 회복/정리
  → "천천히 하면서 정리하자"
```

현재 에이전트 시스템: **항상 같은 모드**.

### 해결: 모델 특성 기반 모드 정의

```
┌─────────────────────────────────────────────────────────────┐
│  mode: "emergency"     최대 교감                             │
│  모델: opus, 병렬: 최대, 토큰: 무제한, 속도 > 비용           │
│                                                              │
│  mode: "focused"       집중 교감                             │
│  모델: opus, 병렬: 최소 (깊은 분석), 품질 > 속도              │
│                                                              │
│  mode: "balanced"      기본 상태                             │
│  모델: sonnet, 병렬: 적정, 품질 ≈ 비용                       │
│                                                              │
│  mode: "efficient"     부교감                                │
│  모델: haiku, 병렬: 없음, 비용 > 품질                        │
│                                                              │
│  mode: "maintenance"   수면/정비                             │
│  모델: haiku, 백그라운드, 자원 절약 최우선                    │
└─────────────────────────────────────────────────────────────┘
```

### 모드 전환 트리거

```
자동 전환: "급해" → emergency, 세션 종료 → maintenance, 단순 질문 → efficient
유저 명시: "천천히 해도 돼" → efficient, "제대로 해줘" → focused
눈치 연동: 유저 짜증 + efficient → balanced 상향, 유저 만족 + focused → balanced 하향
```

## 11. 작업 기억 스코프 관리 (Working Memory Scope Management)

### 관찰: 뇌의 자동 context switch

사람의 뇌는 서브태스크 진입/퇴출 시 context를 자동으로 관리한다:

```
업무 1 진행 중 → 서브태스크 A,B,C 처리 → 결과만 들고 복귀 → 업무 1 계속
= 함수 call stack (로컬 변수는 리턴 후 사라짐)
```

### 문제: LLM의 flat context

```
MT calls PM      → 50줄 function_results가 MT context에 주입
MT calls Theia   → 80줄 function_results가 MT context에 주입
MT calls Electron → 60줄 function_results가 MT context에 주입
= MT context = 원래 맥락 + 190줄 서브태스크 상세 (오염)
```

v2 Section 3 (통신 3단계)은 통신 채널 최적화, Section 10 (WM)은 탐색 비용 최적화.
**둘 다 서브태스크 결과가 MT context를 오염시키는 문제는 안 다룸.**

### 현실적 제약과 권장

```
근본 제약: function_results는 호출자 context에 통째로 주입된다.

현재 가능한 최선: File-as-Stack + Return Format Protocol 조합
  1. 서브에이전트에게 SUMMARY/DETAIL 분리 반환 강제
  2. MT가 DETAIL을 .claude/scratch/에 파일로 즉시 아카이브
  3. SUMMARY만 의식적으로 사용
  4. compact 후에도 .claude/scratch/ 파일로 상세 복귀 가능
  5. 메인 태스크 완료 후 scratch 파일 삭제

미래 해결 (Claude Code 기능 제안):
  - Task() 호출 시 "max_return_tokens" 파라미터
  - function_results의 선택적 주입 (summary만 context에, detail은 별도)
  - compact hook 지원
```

### 뇌과학 대응

```
Baddeley 모델: 중앙 실행기의 게이팅(gating) 기능 부재
  뇌: "하위 시스템 결과만 가져오고 상세는 버린다"
  LLM: "하위 시스템 결과 + 상세를 전부 가져온다"
  File-as-Stack: 물리적으로는 들어오지만, 의식적으로 요약만 사용 (약한 게이팅)
```

## 12. 에피소드 기반 기억 구조 (Episodic Memory Organization)

### 관찰: 사람은 시간순이 아니라 에피소드로 기억한다

사람에게 "2월 26일 오후 2시에 뭐 했어?" 물으면 바로 답 못 한다.
"Docker 연구했던 거 기억나?" 물으면 즉시 관련 맥락이 전부 떠오른다.

### 문제: 시간 기반 조회의 근본적 결함

```
결함 1: 시간 → 에피소드 (1:N, 노이즈)
  "2/26 오후에 뭐했지?" → 4개 에피소드가 한 시간대에 섞여있음

결함 2: 에피소드 → 시간 (1:N, 불완전 조회)
  "Docker 통합 전체 맥락 줘" → 4개 시간대에 분산, 전부 조회 불가능
```

**에피소드가 primary key여야 하고, 시간은 그 안의 metadata일 뿐.**

### 해결: 에피소드를 primary key로

```
episodes/
  docker-integration/           ← 에피소드 = 폴더
    episode.yaml                ← 에피소드 메타데이터
    20260226_pm-consultation.md
    20260228_theia-analysis.md
    20260301_electron-ipc.md
    20260305_conclusion.md
```

**episode.yaml 스키마:**

```yaml
id: docker-integration
title: "Docker 통합 조사"
status: active                    # active | paused | completed | abandoned
started: 2026-02-26
last_activity: 2026-03-05

# 시간 branching: 에피소드 관계
parent: egdesk-architecture
children:
  - docker-security-review
siblings:
  - canvas-research
leads_to:
  - docker-implementation

summary: |
  PM 승인. Theia Terminal 확장 방식.
  Phase 1: 컨테이너 관리 UI.

artifacts:
  - ideas/confirmed/DOCKER_INTEGRATION.md
  - references/docker/online_references.md

tags: [docker, theia, electron, container]
```

### 시간 branching

에피소드는 시간 축과 독립적으로 분기/합류한다:

```
에피소드: "EG-DESK 아키텍처"
    │
    ├── branch: "Docker 통합 조사"          (2/26 ~ 3/05)
    ├── branch: "Canvas 통합 조사"          (2/26 ~ 3/01)
    └── merge: Docker 승인 + Canvas 보류 → 다음 단계

= 같은 날에 여러 에피소드 작업 가능
= 하나의 에피소드가 여러 날에 걸침
= 에피소드 안에서 sub-branch 가능
= 시간 축과 에피소드 축은 독립적
```

### 4-type 시스템과의 통합

에피소드는 4-type을 감싸는 상위 구조:

```
에피소드: docker-integration/
  ├── 20260226_pm.md          type: log     (일화 기억)
  ├── 20260228_theia.md       type: log     (일화 기억)
  ├── conclusion.md           type: knowledge (의미 기억으로 공고화)
  └── episode.yaml            type: —       (메타데이터, 인덱스)

에피소드 완료 시:
  log 파일들 → GC (상세 망각)
  knowledge → 보존 (교훈 유지)
  artifact → ideas/confirmed/에 asset으로 존재
  episode.yaml → status: completed (인덱스 보존)

= 에피소드는 "기억의 묶음 단위"
= 4-type은 "개별 기억의 성격"
= 에피소드 완료 = 묶음 단위로 공고화/망각 판정
```

### 구현 경로

```
단계 1 (즉시):
  episode.yaml 형식 정의 + 수동으로 에피소드 폴더 생성
  기존 subagent_reports/ 파일을 에피소드별로 재구성

단계 2 (hook):
  SessionStart hook이 활성 에피소드 목록 표시
  파일 생성 시 "어떤 에피소드에 속하는지" 태깅

단계 3 (자동화):
  에피소드 완료 시 자동 GC + 공고화
  에피소드 관계 그래프 시각화
```

---

## 14. 외부 레퍼런스: 뇌 기반 시스템 비교

**조사일**: 2026-04-04
**대상**: NeuronFS (rhino-acoustic/NeuronFS), KoreanCode NCkR (zerojat7-ui/KoreanCode)

### 14.1 NeuronFS — 폴더 기반 행동 제어 시스템

**핵심**: `mkdir`이 시스템 프롬프트를 대체. 폴더 = 뉴런, 경로 = 자연어 명령, 파일 = 시냅스 가중치.

```
기술 스택: Go 단일 바이너리, 외부 의존성 2개 (fsnotify, go-sdk)
LLM 통합: Groq API만 (llama-3.3-70b-versatile), 로컬 LLM 미구현
인터페이스: CLI, REST API (:9090), MCP 서버, WebSocket 대시보드
```

**7개 영역 (Brooks Subsumption Architecture)**:

```
P0 brainstem   절대 원칙 (읽기전용, 인간만)     ← bomb 시 하위 전체 차단
P1 limbic      감정 필터 (시스템 자동)
P2 hippocampus 경험 기록 (자동 축적)
P3 sensors     환경 제약 (읽기전용)
P4 cortex      지식/기술 (학습 가능)
P5 ego         성향/톤/페르소나
P6 prefrontal  목표/계획/스프린트
```

**idle 시 LLM 자동 파이프라인**:

```
idle 감지 (N분 미활동 + 마지막 evolve 후 30분 경과)
  → 0. 전사 소화 → 10턴 이상이면 auto-neuronize (Groq → contra 뉴런)
  → 1. evolve (Groq → grow/fire/signal/prune 판단 + 실행)
  → 2. auto-decay (30일 미사용 → dormant)
  → 3. dedup (Jaccard ≥ 0.6 유사 뉴런 병합, LLM 불필요)
  → 4. growth tracking (hippocampus에 로그)
  → 5. git snapshot
  → 6. NAS sync
```

**한자 마이크로옵코드** (폴더명 prefix, emit 시 한국어 변환):

```
禁 → "절대 금지: "    必 → "반드시 "     推 → "추천: "
警 → "경고: "         改 → "개선: "      略 → "생략: "
```

**우리 시스템(Section 2)과의 대응**:

```
┌──────────────────┬──────────────────────┬──────────────────────────────┐
│ NeuronFS 영역     │ 뇌 부위              │ 우리 시스템 대응               │
├──────────────────┼──────────────────────┼──────────────────────────────┤
│ brainstem (P0)   │ 뇌간 + 척수 반사     │ Hooks (PreToolUse deny)      │
│                  │ 불변 원칙             │ CLAUDE.md 최상위 규칙         │
│                  │                      │                              │
│ limbic (P1)      │ 편도체               │ Evidence Elevation hook      │
│                  │ reinforce/redirect   │ (stop-evidence-check.py)     │
│                  │                      │                              │
│ hippocampus (P2) │ 해마                 │ Memory 시스템                 │
│                  │ 기억 저장/인출        │ (MEMORY.md + memory/*.md)    │
│                  │                      │                              │
│ sensors (P3)     │ 감각 입력            │ WM (file-map, 환경 인식)      │
│                  │                      │                              │
│ cortex (P4)      │ 전두엽 지식          │ Skills, Agent templates      │
│                  │ 학습 가능             │ (.claude/skills/, agents/)   │
│                  │                      │                              │
│ ego (P5)         │ 성격/정체성          │ CLAUDE.md Conventions        │
│                  │                      │ (톤, 언어, 스타일)            │
│                  │                      │                              │
│ prefrontal (P6)  │ 전전두엽             │ ideas/confirmed/ PRD         │
│                  │ 목표/계획             │ .claude/docs/ 프로젝트 컨텍스트│
└──────────────────┴──────────────────────┴──────────────────────────────┘
```

**차이점**:

```
                    NeuronFS                    우리 시스템
────────────────   ──────────────────────      ──────────────────────
규칙 표현          폴더명 1줄               CLAUDE.md + skills (상세 절차)
워크플로우         미지원 (단순 지시만)       Skills로 멀티스텝 가능
제어 메커니즘      bomb (물리 차단)          Hooks (코드 기반 차단)
프롬프트 생성      자동 컴파일 (emit)        수동 관리 (CLAUDE.md 직접 편집)
자동 진화          Groq idle 파이프라인      feedback memory → CLAUDE.md 승격
Claude 통합        CLAUDE.md 덮어쓰기       네이티브 (CLAUDE.md 직접 관리)
```

**참고할 아이디어**:
- 가중치 기반 규칙 우선순위 (카운터가 높은 규칙이 프롬프트 상위)
- dormant 자동 전환 (30일 미사용 규칙 휴면)
- dedup (유사 규칙 자동 병합)
- 한자 마이크로옵코드 (토큰 압축)

### 14.2 KoreanCode NCkR — 온톨로지 기반 지식 시스템

**핵심**: 개념지식뉴런(NCkR) = 온톨로지(지식 그래프) + K-Neuron(시냅스 가소성)

```
기술 스택: C (순수 C 33K줄 아닌 kc_ prefix), MCP 서버
지식 표현: 트리플 (주어-관계-목적어), 32B 바이너리 청크
질의: 한글 자연어 + SPARQL
임포트: JSON-LD, Turtle, OWL, CSV
```

**우리 시스템(Section 2)과의 대응**:

```
┌──────────────────┬──────────────────────┬──────────────────────────────┐
│ KoreanCode       │ 뇌 부위              │ 우리 시스템 대응               │
├──────────────────┼──────────────────────┼──────────────────────────────┤
│ NCkR 청크        │ 시냅스 연결          │ Memory 개별 파일              │
│ (32B 바이너리)   │ 개념 간 관계          │ (단, 비구조적 텍스트)         │
│                  │                      │                              │
│ K-Engine         │ 해마 + 측두엽        │ EG-Library (reference 관리)   │
│ (지식 저장소)    │ 의미 기억             │ + WebSearch/Context7          │
│                  │                      │                              │
│ 시냅스 가소성    │ 헵 학습              │ Memory feedback type          │
│ (강화/약화)      │                      │ (반복 recall → CLAUDE.md 승격) │
│                  │                      │                              │
│ MCP 서버         │ 감각 입력 채널       │ MCP 도구 (korean-law 등)      │
│ (AI 에디터 연동) │                      │                              │
└──────────────────┴──────────────────────┴──────────────────────────────┘
```

### 14.3 세 시스템의 역할 분담

```
┌─────────────────────────────────────────────────────────────┐
│                    AI Agent 인지 시스템                       │
├─────────────────────┬──────────────────┬────────────────────┤
│ NeuronFS            │ 우리 시스템       │ KoreanCode NCkR    │
│ "어떻게 행동할까"    │ "어떻게 일할까"   │ "무엇을 아는가"     │
├─────────────────────┼──────────────────┼────────────────────┤
│ 행동 규칙           │ 워크플로우        │ 도메인 지식         │
│ (禁, 必, 推)        │ (Skills, Hooks)  │ (온톨로지, 트리플)   │
│                     │                  │                    │
│ 자동 진화           │ 수동 + 반자동     │ 시냅스 가소성        │
│ (Groq evolve)      │ (feedback→승격)  │ (강화/약화)         │
│                     │                  │                    │
│ 폴더명 = 규칙       │ 파일 내용 = 규칙  │ 트리플 = 지식        │
│ (1줄 요약)          │ (상세 절차)       │ (구조적 관계)        │
│                     │                  │                    │
│ system prompt 주입  │ system prompt    │ MCP tool로 제공     │
│ (자동 컴파일)       │ (직접 관리)       │ (on-demand 질의)    │
└─────────────────────┴──────────────────┴────────────────────┘

보완 관계:
  NeuronFS → system prompt의 "행동 지침" 계층 자동화
  우리 시스템 → "워크플로우 + 오케스트레이션" 계층
  KoreanCode → "지식 공급" 계층 (MCP로 연결)
```

**레퍼런스 위치**:
- NeuronFS: `references/neuronfs/` (git clone)
- KoreanCode: `references/koreancode/` (git clone)
- NCkR 설계: `references/koreancode/NCkR/kc_nckr_design.md`
