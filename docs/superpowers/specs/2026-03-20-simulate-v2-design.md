# Simulate v2 — Dynamic Cross-Probing Simulation

## Summary

Agent간 자유 대화 + 선택적 유저 agent로 UI/UX 흐름과 기술적 모듈 연동의 GAP을 창발적으로 발견하는 동적 시뮬레이션 skill. UX와 Technical을 분리하지 않고, 한 시나리오 안에서 유저 행동과 시스템 이벤트가 자연스럽게 섞인다.

## Problem

Claude Code는 파일 기반 코딩은 잘 하지만, 모듈간 연동이 UI/UX상 또는 런타임상 어떻게 동작하는지 파악하기 어렵다. 정적 코드 리딩만으로는 발견할 수 없는 GAP이 존재한다:
- 에러/엣지 케이스에서 사용자에게 뭘 보여줘야 하는지 빠뜨림
- 여러 모듈 연결 지점에서 데이터/타이밍 문제
- 기능 구현 후 실제 UX 흐름이 어색
- LLM 앱처럼 유저 행동과 코드 동작이 밀접한 경우, UX와 기술적 시뮬레이션을 분리하면 연결 지점의 GAP을 놓침

## Design

### Unified Simulation (모드 분리 없음)

한 시나리오 안에서 UX step과 Technical step이 자유롭게 공존한다:

```
"유저가 2000자 프롬프트 전송"       ← UX
  → "프론트가 스트리밍 연결 시작"   ← UX + Tech
  → "백엔드가 LLM API 호출"        ← Tech
  → "토큰 리밋 초과"               ← Tech
  → "유저에게 에러 표시"            ← UX
```

Role도 UI 레이어와 기술 모듈이 같은 시뮬레이션에 공존:

```json
{
  "roles": [
    { "name": "chat-ui", "scope": "src/components/Chat*" },
    { "name": "api-layer", "scope": "src/services/llm/" },
    { "name": "stream-handler", "scope": "src/lib/streaming/" }
  ]
}
```

호출:
```
/simulate login-flow                     # 시나리오 직접 기술
/simulate --edge-cases payment-flow      # 엣지 케이스 집중
/simulate --user=beginner onboarding     # 페르소나 지정
```

### Plan Schema (유연)

```json
{
  "scenario": "유저가 LLM 채팅에서 긴 프롬프트 전송",
  "options": {
    "user_agent": false,
    "user_persona": null,
    "edge_cases": false
  },
  "steps": [
    "유저가 2000자 프롬프트 입력 후 전송",
    "프론트가 스트리밍 연결 시작",
    "백엔드가 LLM API 호출",
    "응답 스트리밍 중 토큰 리밋 도달",
    "유저에게 결과 표시"
  ],
  "roles": [
    { "name": "chat-ui", "scope": "src/components/Chat*" },
    { "name": "api-layer", "scope": "src/services/llm/" },
    { "name": "stream-handler", "scope": "src/lib/streaming/" }
  ],
  "guidelines": {
    "default_max_rounds": 3,
    "flexible": true,
    "max_role_agents": 3
  }
}
```

**유연성 원칙:**
- `steps`는 시작점이지 rigid script가 아님
- Step 순서 조정, 삽입, 스킵 가능 (sprint-leader 재량)
- `max_rounds`는 가이드라인, 의미 있는 대화면 sprint-leader 재량으로 연장

**제약:**
- Role agents: max 3 + 선택적 user agent = **max 5 총 팀원** (sprint-leader 포함)
- 추가 모듈이 필요하면 기존 agent를 re-scope (새 spawn보다 재할당 우선)
- re-scope로 불가능하면 sprint-leader → Session Lead에게 spawn 요청 (다음 step 전에)

### Core: Cross-Probing (핵심 변경)

현재(v1): agent → sprint-leader로만 보고
v2: agent → agent 직접 DM 허용 (step 내), sprint-leader에게 CC

```
Sprint-leader: "Step 1: 유저가 2000자 프롬프트 전송
  검증 포인트: input validation → API 전달 → 스트리밍 시작"
         │
         ▼
  Phase A — 1차 보고 (병렬)
    관련 agent들이 자기 코드 기반으로 독립 보고
    sprint-leader에게 DM: "내 모듈에서는 이렇게 동작한다"
         │
         ▼
  Phase B — Cross-probing (CC DM)
    agent가 다른 agent에게 질문/요청 시 sprint-leader에게 CC
    sprint-leader가 실시간으로 흐름 관찰 가능
    개입 조건:
      1. 방향 이탈 → 검증 포인트와 대조하여 리다이렉트
      2. 얕은 보고 → "코드에 실제로 뭐가 있어?" 추궁
      3. edge case 주입 → "여기서 네트워크 끊기면?"
    종료 조건:
      - 각 참여 agent가 1회 DM = 1 round
      - max_rounds 도달 시 sprint-leader가 Phase C 선언
      - 또는 agent들이 자연 종료 (더 이상 질문 없음)
         │
         ▼
  Phase C — 수거
    sprint-leader → 각 agent에게: "이 step 최종 보고 + GAP 선언"
    정리: 정상 흐름 / GAP / 다음 step 조정 필요 여부
         │
         ▼
  다음 step (또는 step 삽입/스킵)
```

**Round 정의:** 각 참여 agent가 1회 DM을 보내면 1 round. `default_max_rounds: 3`이면 agent당 최대 3회 DM 후 수거.

**CC 메커니즘:** Agent가 cross-probing DM을 보낼 때, 같은 내용을 sprint-leader에게도 전송. Sprint-leader가 실시간 관찰 가능하므로 이탈 감지 + 적시 개입 가능.

### Sprint-Leader 역할: 감독관

**하는 것:**
- Step 선언 + 검증 포인트 명시
- WM에게 granularity 상담 (모듈 크기 기반 agent 분배, v1 Phase 1 유지)
- Phase B에서 CC DM 관찰 + 이탈/얕은 보고/edge case에만 개입
- Phase C에서 수거 + GAP 판정
- Step 순서 조정, 새 step 삽입
- 필요 시 agent re-scope 또는 Session Lead에게 추가 spawn 요청

**안 하는 것:**
- 코드를 직접 읽거나 판단 (agent 보고에 의존)
- Agent 대신 답변

### User Agent (선택적)

`user_agent: true` 시 추가되는 역할:

- 페르소나 부여 (beginner / power-user / adversarial)
- 스크립트된 step은 그대로 수행
- 추가로 즉흥 행동 생성: "뒤로가기", "빈 폼 제출", "탭 전환 중 입력"
- 다른 agent에게 직접 질문: "프론트엔드, 내가 비밀번호 20자 넣으면?"
- Technical step에서는 caller 역할: 다양한 input (null, 초대형 payload, malformed JSON) 생성

**페르소나별 행동 성향:**

| 페르소나 | 성향 |
|----------|------|
| beginner | 헤매기, 잘못된 순서, 도움말 찾기 |
| power-user | 단축키, 빠른 전환, 동시 작업 |
| adversarial | 잘못된 입력, 빠른 반복 클릭, 의도적 오류 |

유저 agent 없으면 sprint-leader가 "유저가 X를 한다"로 대신 선언 (v1과 동일).

### Simulation Report

```markdown
## Simulation Report: {scenario}

### 참여자
- chat-ui (scope: src/components/Chat*)
- api-layer (scope: src/services/llm/)
- stream-handler (scope: src/lib/streaming/)
- user-agent (persona: beginner) — 선택적

### Step-by-Step

#### Step 1: 유저가 2000자 프롬프트 전송
검증 포인트: input validation → API 전달 → 스트리밍 시작

**정상 흐름:**
- chat-ui: textarea에서 입력 → onSubmit → api-layer.send(message)
- api-layer: POST /api/chat → stream 연결 시작

**Cross-probing 발견:**
- chat-ui → api-layer: "2000자 넘는 입력은?"
  → api-layer: "maxTokens 체크 없음" → GAP
- user-agent (adversarial): "전송 버튼 3번 연타"
  → chat-ui: "debounce 없음" → GAP

### GAP 목록
| # | 위치 | 설명 | 발견 경로 |
|---|------|------|-----------|
| 1 | api-layer | 입력 길이 체크 없음 | cross-probing |
| 2 | chat-ui | 전송 버튼 debounce 없음 | user-agent(adversarial) |
| 3 | stream-handler | 스트림 중단 시 정리 로직 없음 | static-report |

### 권장사항
1. api-layer에 입력 길이 validation 추가
2. chat-ui 전송 버튼에 debounce 적용
3. stream-handler에 abort/cleanup 로직 추가
```

**발견 경로 vocabulary (4종):**

| 경로 | 의미 |
|------|------|
| `static-report` | Phase A 1차 보고에서 발견 |
| `cross-probing` | Phase B agent간 DM에서 발견 |
| `user-agent({persona})` | 유저 agent의 즉흥 행동에서 발견 |
| `sprint-leader-probe` | Sprint-leader의 edge case 주입에서 발견 |

## Integration

### 기존 시스템과의 연동

- **compose-team**: 그대로. simulate이 plan 출력 → compose-team이 팀 구성
- **WM**: 그대로. role의 scope를 WM file mapping으로 구체화. Sprint-leader가 granularity 상담.
- **호출 방식**: user-invoked only (변경 없음)
- **SKILL.md 위치**: `~/.claude/skills/simulate/SKILL.md` (변경 없음)

### 흐름

```
/simulate 호출
  → Simulate skill이 plan 생성 (유연한 스키마)
  → Session Lead가 /compose-team 실행 (plan 포함)
  → compose-team이 팀 구성: sprint-leader + role agents (+ user agent)
  → WM이 file mapping 제공
  → Sprint-leader가 WM에게 granularity 상담
  → Sprint-leader가 step별 실행 (A→B→C 루프)
  → 리포트 → Session Lead → 유저
```

## What Changes

| 항목 | v1 | v2 |
|------|----|----|
| Agent간 통신 | sprint-leader 경유만 | 직접 DM + sprint-leader CC |
| 유저 역할 | sprint-leader가 선언 | 선택적 유저 agent (UX + Tech 겸용) |
| Step 유연성 | 고정 스크립트 | 가이드 + 실행 중 조정 |
| 시나리오 범위 | UI/UX만 | UX + Tech 통합 (한 시나리오에 공존) |
| 리포트 | GAP 목록 | GAP + 발견 경로 추적 (4종) |
| Sprint-leader | 진행자 | 감독관 (CC 관찰 + 선택적 개입) |
| Phase B 종료 | 미정의 | round 정의 (agent당 1 DM = 1 round) + max_rounds |
| 팀 규모 | 제한 없음 | max 5 (role 3 + user 1 + sprint-leader 1) |

## What Stays

- compose-team / WM 연동
- user-invoked only
- SKILL.md 위치 + 기본 구조
- agent가 실제 코드 기반으로 보고하는 원칙
- `steps` 필드명 유지 (v1 호환)
