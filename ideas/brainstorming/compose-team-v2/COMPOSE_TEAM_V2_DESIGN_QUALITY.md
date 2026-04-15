# compose-team V2 Design — Error Handling & Quality

> 실패 처리, 품질 보장, 시간 기반 스케줄링 전담 설계
> 리서치 패턴: E1-E14, V1-V17, + browser-use 패턴(Action Loop Detector, Replan-on-Stall, Budget Warning, Message Compaction), + Temporal(H5, H6)

---

## 설계 원칙

1. **Fail-Structured**: 실패는 정상 흐름의 일부. 구조화된 보고 + 자동 복구 + 명시적 에스컬레이션
2. **Evidence-Gated**: 증거 없는 완료 보고 거부. "돌려봤다"가 아니라 "돌린 결과가 이것이다"
3. **Budget-Aware**: 자원 소진 전에 경고. 예산 초과 방지 > 사후 분석
4. **Graduated Response**: 1차 자동 복구 → 2차 에스컬레이션 → 3차 bail/kill. 과잉 반응 방지

---

## 1. Task 완료 상태 체계 (E1 기반)

### 1.1 4-Status Escalation

Worker가 sprint-leader에게 보고할 때 반드시 4가지 중 하나를 선택:

```
DONE                 — 완료. acceptance criteria 100% 충족. 증거(테스트 결과, 빌드 로그) 첨부.
DONE_WITH_CONCERNS   — 완료했지만 우려 사항 있음. concerns[] 필드에 구체적 사항 나열.
NEEDS_CONTEXT        — 진행 불가. 추가 정보/결정이 필요. questions[] 필드에 질문 나열.
BLOCKED              — 기술적으로 진행 불가. blocker 명시 + 시도한 해결 방법 나열.
```

### 1.2 Sprint-Leader의 반응 매트릭스

| Worker Status | Sprint-Leader 행동 |
|---------------|-------------------|
| DONE | 검증 gate 실행 (Section 4) → 통과 시 완료 처리 |
| DONE_WITH_CONCERNS | concerns 평가 → 무시할 수 있으면 DONE 처리, 아니면 추가 task 생성 |
| NEEDS_CONTEXT | Session Lead에게 에스컬레이션 (worker가 직접 user에게 질문 불가) |
| BLOCKED | blocker 분석 → 재할당/우회/kill 결정. 30분 내 해결 불가 시 Session Lead에게 보고 |

### 1.3 Claude Code 구현

**CLAUDE.md 규칙으로 강제** (hook 불필요):

```markdown
## Worker 완료 보고 프로토콜
Worker는 작업 완료 시 sprint-leader에게 아래 포맷으로 보고:

Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
Evidence: [실행 결과, 테스트 로그, 빌드 출력 등]
Concerns: [DONE_WITH_CONCERNS일 때만]
Questions: [NEEDS_CONTEXT일 때만]
Blocker: [BLOCKED일 때만 — 문제 + 시도한 해결책]
Files: [변경/생성한 파일 목록]
```

---

## 2. Verification Gate (E6 기반)

### 2.1 5-Step Evidence Chain

"NO COMPLETION WITHOUT FRESH EVIDENCE" 원칙. Worker가 DONE을 주장하려면:

```
Step 1: IDENTIFY  — 무엇을 검증할지 명시 (test file, build command, URL)
Step 2: RUN       — 실제 실행 (Bash: npm test, cargo build, etc.)
Step 3: READ      — 실행 결과를 Read로 확인 (exit code, output)
Step 4: VERIFY    — 결과가 acceptance criteria를 충족하는지 판단
Step 5: CLAIM     — 충족 시에만 DONE 보고. Step 2-3 증거 첨부.
```

### 2.2 Evidence Level 연동

기존 CLAUDE.md의 Evidence Elevation 체계와 직접 연결:

| 보고 유형 | 최소 Evidence Level | 예시 |
|----------|-------------------|------|
| 코드 변경 완료 | [검증] | `npm run build` 성공 로그 |
| 버그 수정 | [검증] | 실패했던 테스트가 통과하는 로그 |
| 조사/분석 | [조사] | Read/Grep 결과 + 분석 |
| 설계 문서 | [분석] | 코드 기반 시뮬레이션 결과 |

### 2.3 Verify-Fix Loop (E3 통합)

Sprint-leader가 worker 산출물을 검증하는 루프:

```
Worker 보고(DONE)
  → Sprint-leader 검증 (또는 다른 worker에게 검증 위임)
  → PASS: 완료 처리
  → FAIL: worker에게 fix 요청 (fix_attempt += 1)
    → fix_attempt <= max_fix_loops(3): worker 재시도
    → fix_attempt > max_fix_loops: FAILED 처리 → Session Lead에게 보고
```

**핵심**: `max_fix_loops = 3`. 3번 고쳐도 안 되면 근본적으로 접근 방식이 잘못된 것.

---

## 3. Loop Detection & Stall Recovery

### 3.1 Action Loop Detector (E5 + browser-use 패턴)

Agent가 같은 행동을 반복하는 "무한루프" 감지:

```
구현: 슬라이딩 윈도우 (window_size: 20)
감지: action hash 정규화 → 동일 hash 연속 등장 카운트
반응:
  - 3회 반복: [WARN] "같은 행동 반복 감지. 다른 접근법을 시도하세요."
  - 5회 반복: [NUDGE] "5회 연속 반복. 현재 접근법을 멈추고 재계획하세요."
  - 8회 반복: [ESCALATE] sprint-leader에게 자동 보고 "agent 무한루프 감지"
  - 12회 반복: [BAIL] 강제 중단 + BLOCKED 상태로 전환
```

**Action Hash 정규화**: tool 호출의 핵심 파라미터만 추출하여 hash. 예를 들어 Read의 경우 file_path만, Bash의 경우 command의 처음 50자만.

### 3.2 Replan-on-Stall (browser-use 패턴)

연속 실패 시 "다시 생각해" 강제:

```
consecutive_failures 카운트 추적
  - 3회 연속 실패: "현재 계획을 재검토하세요. 다른 접근법을 고려하세요." 주입
  - 5회 연속 실패: sprint-leader에게 에스컬레이션 + 자동 replan 요청
```

**성공 시 카운터 리셋**. 실패-성공-실패는 연속이 아니므로 리셋.

### 3.3 Claude Code 구현 방식

**CLAUDE.md 규칙**으로 sprint-leader/worker 행동에 포함:

```markdown
## Loop/Stall 감지 규칙
Sprint-leader는 worker의 보고를 모니터링:
- 같은 에러 3회 반복 → worker에게 "접근법 변경" 지시
- 같은 에러 5회 반복 → task를 다른 worker에게 재할당 또는 Session Lead에게 보고
- Worker 자체적으로도 같은 tool 호출 3회 연속 실패 시 스스로 멈추고 replan
```

---

## 4. Completion Scoring & Bail (E9 + V14 통합)

### 4.1 Mastery Gate

Phase 완료 판정을 이진(pass/fail)이 아닌 숙달도 점수로:

```
acceptance_criteria: [criterion_1, criterion_2, ..., criterion_N]
scoring:
  각 criterion 충족 여부 체크 → 충족 비율 = mastery_score (0.0 ~ 1.0)

gate_rules:
  mastery_score >= 0.8: PASS (다음 phase 진행)
  mastery_score >= 0.5: CONDITIONAL (부족한 criteria 보완 후 재시도, max 2회)
  mastery_score < 0.5: FAIL (접근법 재설계 필요)
```

### 4.2 Bail Decision

수렴하지 않는 task를 언제 포기할지:

```
bail_conditions:
  - max_fix_loops(3) 초과 + mastery_score 개선 없음
  - 총 소요 시간이 예상의 3배 초과
  - worker가 BLOCKED 보고 + 대안 없음

bail_action:
  - sprint-leader가 Session Lead에게 보고
  - kill(포기) vs spike(최소 탐색 후 포기) 판단
  - kill: git reset + 원인 분석 보고서 작성
  - spike: 30분 탐색 → 방향 제시 문서만 산출 → 실제 구현은 다음 세션으로 연기
```

---

## 5. Budget Warning & Resource Management

### 5.1 Budget Warning Injection (browser-use 패턴 + C8 BATS)

Agent context 소비량 기반 경고:

```
budget_thresholds:
  50%: [INFO] "예산 50% 소진. 남은 작업을 우선순위 정리하세요."
  75%: [WARN] "예산 75% 소진. 핵심 작업에만 집중하세요. 탐색적 작업 중단."
  90%: [CRITICAL] "예산 90% 소진. 현재 작업을 마무리하고 결과를 보고하세요."
```

### 5.2 Claude Code에서의 Budget 측정

Claude Code에서는 직접적인 토큰 카운트 API가 없으므로, 프록시 지표 사용:

```
proxy_indicators:
  - tool_call_count: agent가 호출한 tool 횟수 (상한: task 복잡도별 설정)
  - elapsed_time: 경과 시간 (상한: task별 예상 시간의 2배)
  - file_read_count: 읽은 파일 수 (탐색적 작업 과잉 지표)

compose-team 출력에 포함:
  budget:
    max_tool_calls: 50       # simple task
    max_elapsed_minutes: 30
    warning_at_percent: [50, 75, 90]
```

### 5.3 Sprint-Leader의 Budget 관리 책임

```markdown
Sprint-leader는 팀 전체 budget을 모니터링:
- 개별 worker가 예상 tool_calls의 75%를 초과하면 경고 DM
- 팀 전체가 예상의 80%를 초과하면 남은 task 우선순위 재정리
- 90% 초과 시 미완료 task를 BLOCKED 처리하고 Session Lead에게 보고
```

---

## 6. Cross-Agent Review (V4 기반)

### 6.1 자기 리뷰 금지 원칙

```
rule: "NO SELF-REVIEW"
enforcement:
  - 코드를 작성한 worker는 자신의 코드를 리뷰할 수 없음
  - sprint-leader가 다른 worker에게 리뷰 할당
  - 리뷰어는 작성자의 의도/이유를 모른 채 결과만 평가 (Naked Reasoner, V7)
```

### 6.2 리뷰 할당 규칙

| 팀 규모 | 리뷰 전략 |
|---------|----------|
| 2 workers | 상호 리뷰 (A→B, B→A) |
| 3+ workers | 라운드 로빈 (A→B, B→C, C→A) |
| 1 worker | sprint-leader가 직접 리뷰 (또는 Session Lead에게 리뷰 요청) |

### 6.3 Naked Reasoner (V7) 적용

중요 설계 결정 리뷰 시:

```
step 1: worker가 코드/설계를 산출
step 2: sprint-leader가 리뷰어에게 산출물만 전달 (변경 이유, PR description 숨김)
step 3: 리뷰어가 "이 코드가 좋은가?" 독립 평가
step 4: 평가 후에야 원래 의도 공유 → 의도 vs 결과 gap 분석
```

**적용 기준**: 모든 리뷰에 적용하면 오버헤드가 크므로, `risk_level: high` task에만 적용.

---

## 7. Graded Assertiveness — PACE (E10 기반)

### 7.1 Worker의 이의 제기 경로

Worker가 sprint-leader의 지시에 문제를 느낄 때 사용하는 4단계:

```
P (Probe):     "이 접근법에 대해 확인하고 싶은 게 있습니다..."
               → sprint-leader가 설명하면 진행. 무시하면 다음 단계.

A (Alert):     "이 접근법에 구체적 문제가 있습니다: [문제 설명]"
               → sprint-leader가 대안을 제시하거나 유지 결정 + 이유 설명.

C (Challenge): "이 접근법은 [X] 때문에 실패할 가능성이 높습니다. 대안: [Y]"
               → sprint-leader가 반드시 응답. 무시 불가.

E (Emergency): "이대로 진행하면 [심각한 결과]. Session Lead 판단이 필요합니다."
               → Session Lead에게 자동 에스컬레이션. sprint-leader 동의 불필요.
```

### 7.2 Claude Code 구현

CLAUDE.md에 worker 행동 규칙으로 명시:

```markdown
## Worker 이의 제기
Worker는 sprint-leader의 지시가 잘못되었다고 판단되면 이의를 제기할 수 있다:
- 사소한 의문: Probe (질문 형식으로 DM)
- 구체적 문제 발견: Alert (문제 + 근거를 DM)
- 심각한 위험: Challenge (문제 + 대안 + 근거를 DM, sprint-leader 응답 필수)
- 프로젝트 위험: Emergency (Session Lead에게 직접 DM, sprint-leader 우회)

Sprint-leader는 Challenge 이상의 이의 제기를 무시할 수 없다.
Emergency는 worker가 Session Lead에게 직접 보고하는 유일한 경로.
```

---

## 8. Circuit Breaker (E12 기반)

### 8.1 Agent-Level Circuit Breaker

특정 agent가 연속으로 실패할 때 "더 시키지 않기":

```
states:
  CLOSED:    정상. task 할당 가능.
  OPEN:      차단. 연속 실패 threshold 초과. 새 task 할당 금지.
  HALF_OPEN: 탐색. cooldown 후 1개 probe task만 허용.

transitions:
  CLOSED → OPEN:      consecutive_failures >= threshold (기본: 3)
  OPEN → HALF_OPEN:   cooldown 경과 (기본: task 1개 분량의 시간)
  HALF_OPEN → CLOSED: probe task 성공
  HALF_OPEN → OPEN:   probe task 실패 → cooldown 2배로 증가
```

### 8.2 Claude Code 구현

Sprint-leader의 판단 규칙으로 구현 (별도 시스템 불필요):

```markdown
## Circuit Breaker 규칙
Sprint-leader는 worker의 연속 실패를 추적:
- 연속 3회 실패: 해당 worker에게 새 task 할당 중지
- 원인 분석 → 환경 문제면 수정 후 간단한 task 1개 시험
- 시험 성공: 정상 할당 재개
- 시험 실패: Session Lead에게 보고 + worker 교체 고려
```

---

## 9. Saga Compensation Chain (E13 기반)

### 9.1 다단계 작업의 롤백 보장

Phase가 여러 개인 작업에서 중간 실패 시 이전 phase 결과를 어떻게 처리할지:

```
phase_definition:
  phase_1:
    action: "API 스키마 변경"
    compensating_action: "git revert [commit_hash]"
  phase_2:
    action: "프론트엔드 컴포넌트 수정"
    compensating_action: "git revert [commit_hash]"
  phase_3:
    action: "테스트 작성 + 통과"
    compensating_action: null  # 테스트는 revert 불필요

failure_handling:
  phase_3 실패 시:
    → phase_2 compensating_action 실행
    → phase_1 compensating_action 실행
    → 원상 복구 완료 → 재설계
```

### 9.2 Orchestration 모드 (Claude Code 기본)

Sprint-leader가 보상 체인을 지시하는 모드:

```
sprint-leader가 phase 실패 감지
  → 역순으로 각 worker에게 compensating_action 지시
  → 모든 보상 완료 확인 후 Session Lead에게 보고
```

### 9.3 compose-team JSON 출력 예시

```json
{
  "phases": [
    {
      "name": "phase_1",
      "task": "API 스키마 변경",
      "compensating_action": "git revert phase_1",
      "agent": "backend-worker"
    },
    {
      "name": "phase_2",
      "task": "프론트엔드 수정",
      "compensating_action": "git revert phase_2",
      "depends_on": ["phase_1"],
      "agent": "frontend-worker"
    }
  ]
}
```

---

## 10. Temporal Scheduling (CronCreate 활용)

### 10.1 미발견 영역 해결

리서치에서 식별된 gap: "15분 뒤에 확인", "빌드 완료 후 자동 검증", "Phase 1이 30분 내 미완료 시 에스컬레이션"

Claude Code의 `CronCreate` tool로 시간 기반 워크플로우 구현:

### 10.2 사용 시나리오

#### A. Phase Timeout Escalation

```
Phase 시작 시:
  CronCreate: "30분 후 실행"
  내용: "Phase 1 완료 여부 확인 → 미완료 시 Session Lead에게 TIMEOUT 보고"

Phase 완료 시:
  CronDelete: 해당 cron 제거 (정상 완료이므로 timeout 불필요)
```

#### B. Durable Timer (H5) — Phase간 대기

```
Phase 1 완료 후 빌드/배포 대기가 필요할 때:
  CronCreate: "5분 후 실행"
  내용: "Phase 2 시작 조건 확인 → 충족 시 sprint-leader에게 Phase 2 시작 알림"
```

#### C. Health Check (주기적 상태 확인)

```
장기 실행 작업 시:
  CronCreate: "매 10분"
  내용: "모든 active worker 상태 확인 → idle/stuck worker 감지 → sprint-leader에게 보고"
```

### 10.3 Signal-Driven Branching (H6)

외부 이벤트에 따른 워크플로우 분기:

```
compose-team 출력에 signal 정의:
  signals:
    build_complete:
      trigger: "npm run build 성공"
      action: "Phase 2 (테스트) 자동 시작"
    build_failed:
      trigger: "npm run build 실패"
      action: "Phase 1 worker에게 fix 요청"

구현: sprint-leader가 Phase 1 worker의 DONE 보고에서 빌드 결과를 파싱하여 분기.
CronCreate는 timeout safety net으로만 사용 (signal이 오지 않을 경우 대비).
```

### 10.4 구현 가이드라인

```markdown
## Temporal Scheduling 규칙
Sprint-leader는 phase 시작 시 CronCreate로 timeout을 설정:
- 단순 task (ESI 4-5): timeout 15분
- 표준 task (ESI 3): timeout 30분
- 복잡 task (ESI 1-2): timeout 60분

Timeout 시 행동:
- Worker에게 상태 확인 DM
- 응답 없거나 진전 없으면 → Session Lead에게 에스컬레이션
- Phase 정상 완료 시 반드시 CronDelete로 timeout 제거
```

---

## 11. Execution Governance (E14 기반)

### 11.1 Tool 화이트리스트

Agent가 실행할 수 있는 tool을 task 단위로 제한:

```
governance_profiles:
  read_only:
    allowed: [Read, Grep, Glob, WebSearch, WebFetch]
    denied: [Write, Edit, Bash]
    use_case: 조사/분석 전용 agent

  standard:
    allowed: [Read, Grep, Glob, Write, Edit, Bash]
    denied: []
    use_case: 일반 구현 agent

  restricted_write:
    allowed: [Read, Grep, Glob, Edit]  # Write 금지 (기존 파일만 수정)
    denied: [Write, Bash]
    use_case: 리팩토링 agent (새 파일 생성 불가)
```

### 11.2 compose-team 출력

```json
{
  "agents": [
    {
      "name": "researcher",
      "governance": "read_only",
      "task": "API 문서 조사"
    },
    {
      "name": "implementer",
      "governance": "standard",
      "task": "API 구현"
    }
  ]
}
```

### 11.3 Claude Code 구현

Agent template의 frontmatter `allowedTools` 필드로 구현 (native 지원):

```yaml
---
allowedTools:
  - Read
  - Grep
  - Glob
---
```

---

## 11-A. Architecture Rule Injection (E14 확장)

> E14 Execution Governance가 "무엇을 쓸 수 있는가" (tool 권한)를 다룬다면,
> Architecture Rule Injection은 "어떻게 행동해야 하는가" (역할 기반 행동 규칙)를 다룬다.

### 11-A.1 E14와의 차이

| 구분 | E14 Execution Governance | Architecture Rule Injection |
|------|-------------------------|---------------------------|
| 대상 | Tool 접근 권한 (allowed/denied) | 역할 기반 행동 규칙 (how to behave) |
| 예시 | "Read, Grep만 허용" | "직접 수정하지 말고 writer에게 위임하라" |
| 강제력 | Hard — tool 자체를 차단 | Soft~Hard — 자연어 규칙 + hook 검증 조합 |
| 범위 | 도구 단위 | 판단 기준, 통신 규칙, 자율성 수준, 에러 처리 등 |

E14에서 Edit tool이 허용되어 있더라도, Architecture Rule Injection으로 "Session Lead는 직접 수정하지 말고 worker에게 위임하라"는 행동 규칙을 주입할 수 있음. Tool은 열려 있지만 행동 규칙으로 제약하는 계층.

### 11-A.2 조사된 3가지 패턴

#### 패턴 A: 자연어 규칙 파일 주입 (autoresearch)

autoresearch의 `program.md`가 에이전트 세션 시작 시 read되어 전체 행동을 규정.

**주입 구조**:
- 역할 정의: "you are a completely autonomous researcher"
- CAN/CANNOT 규칙: train.py 수정 허용, prepare.py 수정 금지 — tool 권한이 아닌 행동 규칙
- 판단 기준 (Simplicity Criterion): "All else being equal, simpler is better"
- 자율성 규칙: "NEVER STOP", "do NOT pause to ask the human"
- 에러 처리 규칙: 크래시 시 자가 판단, 10분 초과 시 kill, 반복 실패 시 포기

**특성**: 단일 파일에 모든 규칙을 flat하게 나열. 강제력은 자연어(soft) + 코드 레벨 guardrail(evaluate_bpb 불변) 병행. 단일 목적 에이전트에 적합.

출처: autoresearch program.md (RESEARCH.md Round 3, L1551~1616)

#### 패턴 B: System Prompt Slot Injection (hermes-agent)

hermes-agent가 3가지 메커니즘으로 역할별 행동 규칙을 주입.

**3가지 주입 메커니즘**:
1. **SOUL.md Identity Injection** — `prompt_builder.py`의 `build_system_prompt()` slot #1에 SOUL.md 내용을 `{soul_content}`로 주입. 에이전트 정체성과 핵심 행동 원칙 정의.
2. **Behavioral Guidance Constants** — 4개 상수(MEMORY_GUIDANCE, SESSION_SEARCH_GUIDANCE, SKILLS_GUIDANCE, PLATFORM_HINTS)가 하드코딩되어 system prompt에 삽입. 역할별 맥락 인식 규칙.
3. **Subagent Role Constraint via Blocked Tools** — `delegate_tool.py`의 `BLOCKED_CHILD_TOOLS` frozenset으로 child toolsets를 parent의 부분집합으로 제한. 코드 레벨 capability stripping.

**특성**: 자연어 규칙(SOUL.md) + 상수 주입(Guidance) + 코드 강제(Blocked Tools)의 3계층. 멀티 에이전트 시스템에서 역할별 차별화에 적합.

출처: hermes-agent prompt_builder.py, delegate_tool.py (RESEARCH.md Round 3, L1620~1689)

#### 패턴 C: 4계층 계층적 규칙 주입 (nodeskclaw)

nodeskclaw가 4가지 계층으로 에이전트에게 행동 규칙을 주입.

**4계층 구조**:
1. **Gene SKILL.md** — Gene의 `manifest.skill.content`가 YAML+markdown으로 행동 규칙 문서를 런타임 배포. "Triggers" + "Behavior" + "Rules" 섹션으로 구성. 탈착 가능.
   - culture Gene: 팀 문화 규칙 (3문장 이내 응답, 결론 먼저 등)
   - meta Gene: 역할별 프로토콜 (self-improvement, self-reorg, ai-hc-recruiter, innovation-scout, akr-decomposer)
2. **OrgRequiredGene** — `org_required_genes` 테이블로 조직 수준 필수 규칙 강제. workspace 합류 시 반드시 설치.
3. **Workspace Context Prompt** — `build_context_prompt()`가 매 메시지 시 system 메시지로 주입 (역할 정체성, 행동 제약, 통신 규칙, 도구 사용 규칙, 금지 행동).
4. **Gene manifest tool_allow** — Gene 설치 시 화이트리스트를 머지. 역할에 따라 도구 집합 차별화.

**특성**: 가장 정교한 계층 구조. Gene 단위 탈착 가능 + 조직 수준 강제 + 런타임 컨텍스트 주입 + 도구 접근 제어.

출처: nodeskclaw gene_templates/*.json, org_required_gene.py, workspace_message_service.py, openclaw_gene_install_adapter.py (RESEARCH.md Round 3, L1693~)

### 11-A.3 EG-DESK V2 설계: Architecture Rule Injection 메커니즘

3가지 패턴을 종합하여 EG-DESK V2에서의 규칙 주입 설계:

#### 주입 계층 (4-Layer Rule Stack)

```
Layer 1: CLAUDE.md (전역 규칙)
  │  적용: 모든 agent에게 자동 로드
  │  내용: Evidence Elevation, Communication Protocol, Naming Convention
  │  대응: nodeskclaw OrgRequiredGene
  │
Layer 2: Agent Template Body (역할별 규칙)
  │  적용: agent spawn 시 SubagentStart hook이 주입
  │  내용: 역할 정의, 보고 대상, 행동 범위, CAN/CANNOT 규칙
  │  대응: autoresearch program.md, hermes-agent SOUL.md
  │
Layer 3: Skill SKILL.md (작업별 규칙)
  │  적용: skill 호출 시 동적 로드
  │  내용: 작업 절차, 출력 포맷, 판단 기준
  │  대응: nodeskclaw Gene SKILL.md (탈착 가능)
  │
Layer 4: Spawn Prompt (작업 특정 규칙)
     적용: Session Lead가 agent spawn 시 prompt에 포함
     내용: WM file mapping, 특정 task 제약, 작업 컨텍스트
     대응: nodeskclaw Workspace Context Prompt
```

#### 강제력 수준 (Enforcement Spectrum)

| 수준 | 메커니즘 | 예시 |
|------|---------|------|
| **Soft** (자연어 규칙) | Agent template body, CLAUDE.md conventions | "직접 수정하지 말고 writer에게 위임하라" |
| **Medium** (구조적 제약) | compose-team JSON의 `reports_to` 필드 | sprint-leader에게만 보고 가능 |
| **Hard** (tool 권한) | E14 allowedTools + permission mode | Edit tool 자체 차단 |
| **Enforcement** (hook 검증) | PreToolUse hook | Write 시 file-map 업데이트 알림 자동 주입 |

#### 패턴별 대응 매핑

| 외부 패턴 | EG-DESK V2 대응 | 계층 |
|----------|----------------|------|
| autoresearch program.md (flat 규칙) | Agent template body | Layer 2 |
| hermes-agent SOUL.md (identity) | Agent template frontmatter `description` + body 첫 섹션 | Layer 2 |
| hermes-agent Behavioral Constants | CLAUDE.md Evidence Elevation, Communication Protocol | Layer 1 |
| hermes-agent Blocked Tools | E14 allowedTools (기존) | Layer 2 (Hard) |
| nodeskclaw Gene SKILL.md (탈착) | Skill SKILL.md (동적 로드) | Layer 3 |
| nodeskclaw OrgRequiredGene (조직 필수) | User-level CLAUDE.md (모든 프로젝트 적용) | Layer 1 |
| nodeskclaw Context Prompt (런타임) | Spawn prompt + WM file mapping | Layer 4 |
| nodeskclaw tool_allow (Gene별) | permission mode (bypassPermissions/acceptEdits) | Layer 2 (Hard) |

#### 주입 시점

```
Session Start
  │
  ├─ Layer 1: CLAUDE.md 자동 로드 (Claude Code native)
  │
  ├─ Agent Spawn
  │   ├─ Layer 2: SubagentStart hook → template body 주입
  │   └─ Layer 4: Session Lead → spawn prompt에 task 규칙 포함
  │
  └─ Task Execution
      └─ Layer 3: Skill 호출 시 SKILL.md 동적 로드
```

---

## 11-B. Pre-Action Self-Simulation (Dual-Loop 확장)

> O8 Dual-Loop self-reflection이 "왜 막혔지? 접근을 바꿔야 하나?" (정체 후 반성, reactive)라면,
> Pre-Action Self-Simulation은 "이 행동이 내 역할/규칙에 맞는가?" (행동 전 사전 점검, proactive).

### 11-B.1 기존 Dual-Loop(O8)과의 차이

| 구분 | O8 Dual-Loop Self-Reflection | Pre-Action Self-Simulation |
|------|----------------------------|---------------------------|
| 시점 | 정체/실패 **후** (reactive) | 행동 **전** (proactive) |
| 트리거 | 반복 실패, 진행 정체 | 매 tool 호출 또는 주요 행동 |
| 질문 | "왜 막혔지? 다른 접근이 필요한가?" | "이 행동이 내 역할/규칙에 맞는가?" |
| 목적 | 전략 수정 (방향 전환) | 규칙 준수 확인 (위반 방지) |
| 비용 | 낮음 (실패 시에만 발동) | 높음 (매 행동마다 점검) |

두 메커니즘은 상호 보완: Self-Simulation이 사전에 위반을 방지하고, Dual-Loop이 사후에 전략을 교정.

### 11-B.2 조사된 3가지 접근법

#### 접근법 A: Trust + Guardrail (autoresearch)

Pre-Action Self-Simulation이 **존재하지 않는** 접근법. 에이전트가 규칙을 따른다고 신뢰하고, 위반 시 피해를 제한.

**메커니즘**:
- Trust: program.md의 자연어 규칙을 에이전트가 내면화했다고 가정
- Guardrail: 위반해도 피해 제한 — evaluate_bpb 코드 레벨 불변, 5분 시간 제한, git reset 복원
- 사후 평가: val_bpb 비교로 결과만 판정 (keep/discard)

**트레이드오프**:
- 비용: 낮음 (사전 점검 오버헤드 없음)
- 위험: 위반 허용 (피해는 제한하지만 발생은 막지 못함)
- 적합: 단일 목적 에이전트, 실험적 환경, rollback 용이한 작업

출처: autoresearch program.md (RESEARCH.md Round 3, L1600~1616)

#### 접근법 B: Harness-Level Interception (hermes-agent)

Agent **외부**의 harness/tool layer에서 tool 호출을 가로채어 검증. Agent 자체 reasoning이 아닌 별도 시스템이 pre-flight check 수행.

**메커니즘**:
1. **Combined Pre-Exec Command Guards** (`approval.py` L486-525):
   - Phase 1: Tirith 외부 바이너리로 command 정적 분석 (homograph URL, pipe-to-interpreter, terminal injection 탐지)
   - Phase 2: 56개 정규식 패턴으로 위험 명령 탐지 (rm -rf, chmod 777, SQL DROP, fork bomb 등). Unicode normalization + ANSI strip
   - 판정: 컨테이너 → 허용, YOLO → 허용, 위험 발견 → approval mode 분기 (smart: LLM 판정, manual: 사용자 승인, off: 허용)
   - **Smart Approval**: auxiliary LLM에게 "이 명령이 실제로 위험한가?" 평가 → false positive 감소

2. **Memory Content Security Scan** (`memory_tool.py` L75-87):
   - Agent가 memory에 쓰려는 내용을 쓰기 직전에 스캔
   - 16개 threat pattern (prompt injection, exfiltration, SSH backdoor 등) + invisible unicode 감지
   - 매치 시 쓰기 차단 + error 반환

**트레이드오프**:
- 비용: 중간 (tool 호출마다 외부 검증)
- 위험: 낮음 (위반 자체를 차단)
- 한계: agent의 reasoning을 교정하지 못함 — 차단만 가능. 보안 위협에 특화, 역할 규칙 위반 탐지에는 부적합

출처: hermes-agent approval.py, memory_tool.py (RESEARCH.md Round 3, L1655~1689)

#### 접근법 C: Multi-Layer Agent Self-Check (nodeskclaw)

유일하게 **agent 레벨의 self-check** 패턴을 포함하는 접근법. 인프라 + 프롬프트 + 런타임 3계층.

**메커니즘**:
1. **SecurityPipeline before_execute** (인프라 레벨, `services/security/pipeline.py`):
   - 도구 호출 시 WebSocket으로 backend에 `evaluate_before` 요청
   - 플러그인 순차 실행: ApprovalChannelPlugin(priority=5) → PolicyGatePlugin(priority=10) → DLPScannerPlugin → AuditLoggerPlugin
   - DENY 시 체인 즉시 중단, MODIFY 시 파라미터 변경 후 진행, monitor 모드에서는 Finding만 기록
   - after_execute 체인으로 사후 결과 검증(REDACT/FLAG)도 수행

2. **Gene SKILL.md "Check trust policy" 패턴** (프롬프트 레벨):
   - 4개 meta Gene에서 동일 패턴: "Check trust policy for [action]" 단계를 행동 규칙에 명시
   - self-improvement → gene_install, self-reorg → reorg_proposal, ai-hc-recruiter → hc_request, innovation-scout → human approval
   - **Agent의 reasoning chain 안에서** "이 행동을 자율적으로 해도 되는지" 자기 점검 유도
   - SecurityPipeline과 별도로, 프롬프트 레벨에서 agent가 스스로 판단

3. **NO_REPLY 자기 억제** (런타임 레벨, `tunnel/adapter.py`):
   - context_prompt의 규칙 → agent가 "토픽과 무관" 판단 → `NO_REPLY` 토큰 출력 → TunnelAdapter가 30자 버퍼에서 감지 → 응답 억제
   - 도구 호출이 아닌 "응답 자체"에 대한 자기 점검 — "내가 이 대화에 참여해야 하는가?"

**트레이드오프**:
- 비용: 높음 (3계층 모두 작동)
- 위험: 매우 낮음 (다층 방어)
- 강점: 인프라 강제 + agent 자율 점검 병행. 유일하게 agent reasoning에 self-check를 유도

출처: nodeskclaw security/pipeline.py, plugins/policy_gate.py, plugins/approval_channel.py, Gene System, tunnel/adapter.py (RESEARCH.md Round 3, L1693~)

### 11-B.3 세션 내 실증 사례

**사례**: Sprint Leader가 직접 Edit tool로 DESIGN 문서를 수정하려 한 상황

| 항목 | 내용 |
|------|------|
| 역할 규칙 | Sprint Leader = "관점 감독 + 조율. 파일 수정 절대 금지" — writer만 수정 가능 |
| 위반 시도 | Sprint Leader가 Edit tool 호출로 직접 파일 수정 시도 |
| 문제 | 역할 규칙이 자연어(agent template)로 주입되었지만, 행동 전 규칙 점검 없이 진행 |
| 결과 | 역할 위반 발생 |

**Pre-Action Self-Simulation이 있었다면**:
```
Sprint Leader → Edit tool 호출 직전
  → Self-Check: "나는 Sprint Leader. 내 역할 규칙에 '파일 수정 절대 금지'가 있다"
  → 판정: DENY (writer에게 위임해야 함)
  → 결과: 위반 방지, writer에게 DM으로 수정 요청
```

이 사례는 자연어 규칙 주입(11-A)만으로는 불충분하며, 행동 전 자기 점검(11-B)이 보완적으로 필요함을 실증.

### 11-B.4 EG-DESK V2 설계: 다층 Pre-Action Self-Simulation

3가지 접근법을 종합한 다층 방어 설계:

#### 방어 계층 (Defense-in-Depth)

```
Agent가 Tool 호출 시도
  │
  ├─ Layer 1: Soft Self-Check (agent reasoning)
  │   Agent template에 "행동 전 역할 규칙 점검" 지시 삽입:
  │   "주요 행동(Write, Edit, Bash, SendMessage) 전에
  │    내 역할 규칙을 확인하라. 규칙에 위배되면 중단하고
  │    적절한 담당자에게 위임하라."
  │   참고: nodeskclaw Gene SKILL.md "Check trust policy" 패턴
  │
  ├─ Layer 2: Hook Interception (PreToolUse)
  │   역할별 금지 패턴을 hook에서 매칭:
  │   예: sprint-leader가 Write/Edit 호출 → 경고 주입
  │       "당신은 sprint-leader입니다. 파일 수정은 writer의 역할입니다."
  │   참고: hermes-agent command guards 패턴
  │   모드: enforce(차단) / warn(경고만) / monitor(기록만)
  │
  ├─ Layer 3: Tool Restriction (E14 기존)
  │   allowedTools로 물리적 차단
  │   참고: 기존 Execution Governance
  │
  └─ Fallback: Post-Action Detection
      위반 발생 시 사후 감지 + 경고:
      - sprint-leader가 파일을 직접 수정한 경우 → 로그 기록 + Session Lead 경고
      참고: autoresearch Trust+Guardrail 패턴
```

#### 계층별 비교

| 계층 | 메커니즘 | 강제력 | 비용 | 참고 패턴 |
|------|---------|--------|------|----------|
| Layer 1 | Agent template self-check 지시 | Soft (자연어) | 낮음 | nodeskclaw Gene trust check |
| Layer 2 | PreToolUse hook 역할 매칭 | Medium (경고/차단) | 중간 | hermes-agent command guards |
| Layer 3 | allowedTools 물리 차단 | Hard (tool 제거) | 없음 | E14 기존 |
| Fallback | 사후 감지 + 경고 | Reactive (사후) | 낮음 | autoresearch Trust+Guardrail |

#### 적용 가이드

| 상황 | 권장 계층 조합 | 이유 |
|------|-------------|------|
| 고위험 역할 분리 (sprint-leader ↔ worker) | Layer 1 + Layer 2 (enforce) | 역할 위반 시 작업 오염 |
| 일반 작업 (worker 내부) | Layer 1 + Layer 3 | 자연어 가이드 + 기본 tool 제한 |
| 탐색/조사 작업 | Layer 1만 | 자유도 필요, 과도한 제한 불필요 |
| 보안 민감 작업 | Layer 1 + Layer 2 (enforce) + Layer 3 | 전 계층 방어 |

#### Dual-Loop(O8)과의 통합

```
Agent 행동 흐름:
  │
  ├─ [사전] Pre-Action Self-Simulation (11-B)
  │   "이 행동이 내 역할/규칙에 맞는가?"
  │   → 맞음: 실행 진행
  │   → 아님: 차단 또는 위임
  │
  ├─ [실행] Tool 실행
  │
  ├─ [사후-1] Post-Action Detection (Fallback)
  │   위반 감지 시 경고
  │
  └─ [사후-2] Dual-Loop Self-Reflection (O8)
      "왜 막혔지? 접근을 바꿔야 하나?"
      → 전략 수정
```

Pre-Action Self-Simulation(사전 위반 방지) + Dual-Loop(사후 전략 교정) = 완전한 행동 거버넌스 사이클.

---

## 12. 통합 에러 처리 흐름

### 12.1 전체 아키텍처

```
Worker 작업 실행
  │
  ├─ Loop Detection (Section 3.1)
  │   └─ 3회 반복 → warn, 5회 → nudge, 8회 → escalate, 12회 → bail
  │
  ├─ Replan-on-Stall (Section 3.2)
  │   └─ 3회 연속 실패 → replan 주입, 5회 → escalate
  │
  ├─ Budget Warning (Section 5.1)
  │   └─ 50% → info, 75% → warn, 90% → critical
  │
  └─ 완료 보고
      │
      ├─ 4-Status Report (Section 1)
      │   ├─ DONE → Verification Gate (Section 2)
      │   │         ├─ PASS → Mastery Gate (Section 4)
      │   │         │         ├─ >= 0.8 → 완료
      │   │         │         ├─ >= 0.5 → 보완 (max 2회)
      │   │         │         └─ < 0.5  → 재설계
      │   │         └─ FAIL → Verify-Fix Loop (max 3)
      │   │                   └─ 3회 초과 → bail
      │   │
      │   ├─ DONE_WITH_CONCERNS → concerns 평가
      │   ├─ NEEDS_CONTEXT → Session Lead 에스컬레이션
      │   └─ BLOCKED → Circuit Breaker 체크 (Section 8)
      │               ├─ CLOSED → 해결 시도
      │               ├─ OPEN → worker 교체
      │               └─ HALF_OPEN → probe task
      │
      └─ Cross-Agent Review (Section 6)
          └─ risk_level: high → Naked Reasoner 적용
```

### 12.2 Temporal Safety Net

```
모든 Phase에 CronCreate timeout 설정 (Section 10)
  │
  ├─ Phase 정상 완료 → CronDelete
  ├─ Timeout 발동 → 상태 확인 → 에스컬레이션
  └─ Signal 기반 분기 (Section 10.3)
      ├─ 성공 signal → 다음 Phase 자동 시작
      └─ 실패 signal → Saga Compensation (Section 9)
```

---

## 13. compose-team JSON 스키마 확장

Quality 관련 필드를 compose-team 출력에 추가:

```json
{
  "quality": {
    "verification_gate": true,
    "max_fix_loops": 3,
    "mastery_threshold": 0.8,
    "cross_review": true,
    "naked_reasoner": false
  },
  "budget": {
    "max_tool_calls_per_agent": 50,
    "max_elapsed_minutes": 30,
    "warning_thresholds": [50, 75, 90]
  },
  "error_handling": {
    "loop_detection": {
      "window_size": 20,
      "warn_at": 3,
      "nudge_at": 5,
      "escalate_at": 8,
      "bail_at": 12
    },
    "replan_on_stall": {
      "consecutive_failures_to_replan": 3,
      "consecutive_failures_to_escalate": 5
    },
    "circuit_breaker": {
      "failure_threshold": 3,
      "cooldown_multiplier": 2
    }
  },
  "temporal": {
    "phase_timeout_minutes": 30,
    "health_check_interval_minutes": 10,
    "signals": {
      "build_complete": "Phase 2 시작",
      "build_failed": "Phase 1 fix 요청"
    }
  },
  "saga": {
    "mode": "orchestration",
    "phases": [
      {
        "name": "phase_1",
        "compensating_action": "git revert phase_1"
      }
    ]
  }
}
```

---

## 14. 구현 우선순위

### P0 — CLAUDE.md 규칙만으로 즉시 적용

| # | 패턴 | 구현 방식 | 예상 효과 |
|---|------|----------|----------|
| 1 | 4-Status Escalation (E1) | CLAUDE.md 보고 포맷 규칙 | 조용한 실패 방지 |
| 2 | Verification Gate (E6) | CLAUDE.md 완료 조건 규칙 | 증거 없는 완료 방지 |
| 3 | PACE (E10) | CLAUDE.md worker 이의제기 경로 | 잘못된 지시 교정 |
| 4 | Budget Warning (proxy) | CLAUDE.md sprint-leader 모니터링 규칙 | 자원 과소비 방지 |

### P1 — compose-team 출력 확장 + CLAUDE.md

| # | 패턴 | 구현 방식 |
|---|------|----------|
| 5 | Verify-Fix Loop (E3) | compose-team JSON `max_fix_loops` 필드 |
| 6 | Loop Detection (E5) | CLAUDE.md 행동 규칙 |
| 7 | Completion Scoring (E9) + Mastery Gate (V14) | compose-team JSON `mastery_threshold` |
| 8 | Circuit Breaker (E12) | CLAUDE.md sprint-leader 판단 규칙 |
| 9 | Saga Compensation (E13) | compose-team JSON `compensating_action` 필드 |
| 10 | Cross-Agent Review (V4) | CLAUDE.md 리뷰 할당 규칙 |
| 11 | Execution Governance (E14) | Agent template `allowedTools` |
| 12 | Temporal Scheduling (H5, H6) | CronCreate 활용 가이드 |
| 13 | Replan-on-Stall | CLAUDE.md 행동 규칙 |

### P2 — 구조적 확장

| # | 패턴 | 구현 방식 |
|---|------|----------|
| 14 | Naked Reasoner (V7) | 고위험 task 전용 리뷰 프로토콜 |
| 15 | Adaptive Harshness (E7) | 검증 강도 에스컬레이션 |
| 16 | Kill/Spike Decision | bail 시 판단 프레임워크 |
| 17 | Automated Rollback (E11) | git reset 자동 트리거 조건 |

---

## 15. 기존 시스템과의 통합 포인트

| 기존 메커니즘 | Quality 확장 |
|-------------|-------------|
| Evidence Elevation (CLAUDE.md) | Verification Gate의 evidence level 기준 |
| SendMessage (팀 통신) | 4-Status 보고 + PACE 이의제기 채널 |
| SubagentStop hook | Saga compensation 기록 저장 |
| SubagentStart hook | 이전 세션의 에러 패턴 주입 (Loop Detection history) |
| TeammateIdle hook | WM keep-alive + Phase timeout 체크 연동 |
| CronCreate/CronDelete | Temporal scheduling 전체 |
| Agent template allowedTools | Execution Governance |
| `.tmp/` handoff 파일 | Saga state + Decision Registry |

---

## 부록 A: 서재(Deep Scan) 발견 패턴 — 본문 통합 요약

| 패턴 | 출처 | 본문 통합 위치 |
|------|------|---------------|
| Action Loop Detector | browser-use | Section 3.1 |
| Message Compaction | browser-use | Section 10 (Continue-As-New 연동) |
| Replan-on-Stall | browser-use | Section 3.2 |
| Budget Warning | browser-use | Section 5.1 |
| mkdir Lock | claude-memory | 부록 B, Section 16.1 |
| OCC + Lock 이중 보호 | claude-memory | 부록 B, Section 16.2 |
| Stale Lock 자동 해제 | claude-memory | 부록 B, Section 16.3 |
| Agent Pool Slot Waiting | claude-mem | 부록 B, Section 16.4 |
| Orphan Reaper | claude-mem | 부록 B, Section 16.5 |
| Stale Context Auto-Discard | claude-mem | 부록 B, Section 16.6 |

---

## 부록 B: 서재 패턴의 Claude Code Native 구현 (Section 16)

### 16.1 mkdir Lock — Agent 간 Shared State 동시 수정 방지

**원본** (claude-memory): `os.mkdir(lock_dir)` — 모든 파일시스템에서 atomic. 15초 timeout, 60초 stale 자동 파괴.

**Claude Code 적용 시나리오**: 여러 worker가 같은 `.tmp/` handoff 파일을 동시에 수정하려 할 때.

**구현 — CLAUDE.md 규칙 + `.tmp/` lockdir 프로토콜**:

```markdown
## Shared File Lock Protocol
Worker가 공유 파일(.tmp/phase-summary.md, .tmp/decision-registry.jsonl 등)을 수정할 때:

1. 수정 전: `.tmp/{filename}.lockdir` 디렉토리 생성 시도 (Bash: mkdir)
   - 성공 → lock 획득. 수정 진행.
   - 실패 (이미 존재) → 5초 대기 후 재시도. 3회 실패 → sprint-leader에게 보고.
2. 수정 완료 후: `.tmp/{filename}.lockdir` 삭제 (Bash: rmdir)
3. 60초 이상 된 lockdir는 stale로 간주 → 삭제 후 재시도 가능
```

**왜 Claude Code에서 유효한가**: `.tmp/` 디렉토리는 모든 agent가 접근 가능한 공유 영역. Bash tool의 `mkdir`은 atomic 연산이므로 race condition 없음. 외부 의존성 제로.

**적용 대상**: Saga compensation state, Decision Registry, phase handoff 파일 등 공유 artifact.

### 16.2 OCC (Optimistic Concurrency Control) — 충돌 감지

**원본** (claude-memory): update 시 `--hash <md5>` 파라미터로 읽은 시점의 파일 hash를 전달. lock 안에서 현재 hash와 비교 → 불일치 시 `OCC_CONFLICT`.

**Claude Code 적용 시나리오**: Worker A가 파일을 읽고 수정하는 동안 Worker B가 같은 파일을 수정한 경우 감지.

**구현 — Sprint-Leader 조율 프로토콜**:

```markdown
## OCC Protocol (공유 파일 수정 시)
1. Worker가 공유 파일을 읽을 때 → Bash로 md5 hash 계산: `md5 -q {file}`
2. 수정 완료 보고 시 → 원본 hash 첨부: "Original hash: abc123"
3. Sprint-leader가 적용 전 현재 hash 확인:
   - 일치 → 수정 적용
   - 불일치 → "다른 worker가 수정함" → Worker에게 최신 버전 기반 재수정 요청
```

**mkdir Lock과의 조합**: 단순 수정은 OCC만으로 충분 (낙관적). 복잡한 다단계 수정은 mkdir Lock + OCC 이중 보호.

### 16.3 Stale Lock 자동 해제 — Agent Crash Recovery

**원본** (claude-memory): lock 60초 초과 시 자동 파괴 + 경고 로그.

**Claude Code 적용 시나리오**: Worker가 lock을 잡고 crash → 다른 worker가 영원히 blocked.

**구현 — Sprint-Leader 모니터링 규칙**:

```markdown
## Stale Lock Detection
Sprint-leader는 worker가 "lock 획득 실패" 보고 시:
1. lockdir의 생성 시간 확인: `stat -f %m .tmp/{filename}.lockdir` (macOS)
2. 60초 초과 → stale로 판정 → 삭제 지시: `rmdir .tmp/{filename}.lockdir`
3. 원래 lock 보유자(crash된 worker)의 미완료 수정은 폐기
4. 새 worker에게 clean state에서 재작업 지시
```

**Circuit Breaker와의 시너지**: crash된 worker는 Circuit Breaker가 OPEN 상태로 전환 → stale lock 해제 후에도 같은 worker에게 재할당하지 않음.

### 16.4 Agent Pool with Slot Waiting — Spawn 자원 관리

**원본** (claude-mem): `CLAUDE_MEM_MAX_CONCURRENT_AGENTS=2`, hard cap=10, promise-based `waitForSlot()`.

**Claude Code 적용 시나리오**: compose-team이 5명 팀을 구성했지만 동시에 5명을 spawn하면 context 과부하.

**구현 — Session Lead의 Staged Spawn**:

```markdown
## Staged Agent Spawn Protocol
Session Lead는 compose-team의 max_concurrent_agents 설정에 따라 agent를 단계적으로 spawn:

max_concurrent_agents: 3 (기본값)

Phase 시작 시:
1. 처음 3명 spawn (slot 한도)
2. 1명 완료(idle) → 다음 1명 spawn
3. 전원 완료될 때까지 반복

이점:
- Context window 동시 사용량 제한
- 앞선 agent의 결과를 뒷 agent가 활용 가능
- crash 시 영향 범위 축소 (최대 3명만 동시 실행)
```

**compose-team JSON 필드**:

```json
{
  "resource_limits": {
    "max_concurrent_agents": 3,
    "hard_cap": 5
  }
}
```

### 16.5 Orphan Reaper — Zombie Agent 자동 정리

**원본** (claude-mem): 30초 주기 스캔, activeSessionIds 대조, SIGTERM → 5초 후 SIGKILL.

**Claude Code 적용 시나리오**: Phase 완료 후 일부 worker가 idle 상태로 남아 context/메모리 소비.

**구현 — Sprint-Leader Shutdown Protocol 강화**:

```markdown
## Orphan Agent Detection
Sprint-leader는 phase 완료 시:
1. 모든 active agent 목록 확인 (TaskList로 상태 조회)
2. 현재 phase에 필요 없는 agent 식별
3. 불필요 agent에게 shutdown_request 전송
4. 30초 내 응답 없음 → Session Lead에게 "zombie agent" 보고
5. Session Lead가 강제 종료 판단

CronCreate 연동 (Section 10):
- Phase 완료 후 5분 뒤 실행되는 cron 설정
- "idle agent 존재 여부 확인 → 있으면 Session Lead에게 보고"
```

**Temporal Scheduling과의 시너지**: Phase timeout cron이 발동하면 orphan reaper도 동시 실행.

### 16.6 Stale Context Auto-Discard — Crash 후 Fresh Start

**원본** (claude-mem): worker 재시작 시 DB의 stale memory_session_id를 무시하고 SDK에서 새 ID capture.

**Claude Code 적용 시나리오**: Worker가 crash 후 재spawn → 이전 세션의 `.tmp/agent-context/` 파일이 남아 있지만 현재 코드 상태와 불일치.

**구현 — SubagentStart Hook + CLAUDE.md 규칙**:

```markdown
## Crash Recovery — Fresh Start Protocol
Worker가 재spawn될 때 (sprint-leader가 crash 후 재할당):
1. 이전 agent-context 파일은 "참고용"으로만 주입 (SubagentStart hook이 자동)
2. Worker는 이전 context의 코드 상태 주장을 신뢰하지 않음
3. 반드시 현재 파일 상태를 직접 Read로 확인 후 작업 시작
4. 이전 context의 "완료" 주장은 검증 없이 수용 금지

원칙: "이전 세션이 뭘 했다고 주장하든, 지금 파일을 직접 봐라"
```

**Verification Gate와의 연동**: 재spawn된 worker의 첫 보고는 반드시 "현재 상태 확인" evidence 포함 필수.

---

## 부록 C: 동시성 패턴 적용 판단 기준

| 시나리오 | 적용 패턴 | 이유 |
|---------|----------|------|
| 단일 worker가 파일 수정 | 없음 | 충돌 가능성 없음 |
| 2 worker가 다른 파일 수정 | 없음 | 파일 scope 분리 (Niche Partitioning) |
| 2 worker가 같은 파일 수정 | OCC | 낙관적 — 대부분 충돌 안 함 |
| 여러 worker가 `.tmp/` handoff 동시 수정 | mkdir Lock + OCC | 비관적+낙관적 이중 보호 |
| Phase 전환 중 Saga state 기록 | mkdir Lock | 단일 writer 보장 필수 |
| Worker crash 후 lock 잔류 | Stale Lock 자동 해제 | 60초 후 자동 복구 |
| Worker crash 후 재spawn | Fresh Start + Verification Gate | stale context 신뢰 금지 |
| 과다 agent spawn | Agent Pool Slot Waiting | 동시 실행 수 제한 |

---

## 보충: EG-Library Expansion Deep Research 발견 (2026-03-28)

> 출처: EG-Library Expansion Deep Research (2026-03-28), 16개 프로젝트 심층 조사

### Quality/Harness Top 3 적용 패턴

| 순위 | 패턴 | 출처 (repo) | EG-DESK 적용 |
|------|------|-------------|-------------|
| 1 | **Progressive Disclosure 3단계** | hermes-agent (NousResearch/hermes-agent), agentskills.io | Metadata(~100 tokens) → Instructions(<5000 tokens) → Resources(요청 시). Skill loading 시 context 효율화에 직접 적용. SKILL.md 500줄 이하 권장 |
| 2 | **Skills Guard Trust 정책 4단계** | hermes-agent | builtin(항상 허용) > trusted(openai/anthropics skills, caution 허용) > community(findings 있으면 차단) > agent-created(dangerous=ask). 6카테고리 정적 분석: exfiltration, injection, destructive, persistence, network, obfuscation |
| 3 | **Sprint Contract + JSON > Markdown** | anthropic-harness (Anthropic Engineering Blog) | Generator+Evaluator가 "done" 정의를 파일 기반 협상. Sprint 3에서 27 criteria. hard threshold: 하나라도 미달 시 fail. JSON이 Markdown보다 모델 행동 제약에 효과적 ("model is less likely to inappropriately change JSON") |

### Self-Evaluation 실패 메커니즘 (Anthropic 블로그)

- "agents tend to respond by confidently praising the work—even when quality is obviously mediocre"
- 이슈를 인식하면서도 스스로 설득하여 통과시킴
- 해결: Generator-Evaluator GAN식 분리. "tuning a standalone evaluator to be skeptical turns out to be far more tractable"
- Evaluator 캘리브레이션: 로그 분석 → 인간 판단과 차이점 식별 → QA 프롬프트 업데이트. few-shot examples + detailed score breakdowns

### Design Quality Rubric 4차원 (Anthropic 블로그)

| 차원 | 정의 | 가중치 |
|------|------|--------|
| Design Quality | coherent whole (colors, typography, layout, imagery) | 높음 |
| Originality | custom decisions, 비-template, 비-library defaults | 높음 |
| Craft | typography hierarchy, spacing, color harmony, contrast | 보통 |
| Functionality | usability, primary actions, task completion | 보통 |

- Design+Originality 높은 가중치 → 미학적 리스크 테이킹 유도
- "AI slop" 패턴 명시적 벌점
- 언어 스티어링 효과: rubric 문구 자체가 generator 출력 방향 조종

### 추가 Quality 패턴

- **Context Budget 4-Signal** (agent-skills-cli, Karanjot786/agent-skills-cli): Language Match(40점) + Dependency Match(30점) + File Keyword Match(20점) + Description Match(10점). LLM 없이 skill 관련성 판단. Greedy knapsack 선택
- **Conflict Detector 3전략** (agent-skills-cli): (1) Keyword Contradiction (7 대립 동사 쌍 + Jaccard > 0.4) (2) Topic Overlap (heading 0.5 + keyword 0.35 + code language 0.15, Jaccard > 0.35) (3) Rule Extraction (Do/Don't 리스트). skill 간 모순 검출
- **Quality Scoring 4차원** (agent-skills-cli): Structure(30%) + Clarity(30%) + Specificity(30%) + Advanced(10%). 등급: A+(90+)~F(<50). /agent-factory 생성 결과물 검증에 활용 가능
- **Skill Compose 3전략** (agent-skills-cli): merge(heading 통합, dedup), chain("Step 1: A, Step 2: B"), conditional("When working with A:... When working with B:..."). 복합 skill 설계
- **Skill Tester 10 내장 테스트** (agent-skills-cli): frontmatter, description, content, headings, when-to-use, actionable instructions, code examples, concise description, no placeholder, reasonable length
| Phase 완료 후 idle agent | Orphan Reaper | 자원 낭비 방지 |

### 소스코드 심층 조사 추가 발견 (2026-03-28)

> 출처: 16 explore-agents 소스코드 직접 분석

**context-mode Security Model (mksglu/context-mode, src/security.ts)**
- 3-Tier Settings 읽기 (precedence): `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json`
- Bash Policy: deny > ask > allow (most restrictive wins)
- **Chained command splitting**: `&&`, `||`, `;`, `|` 분리 → 각 segment 개별 검사. "echo ok && sudo rm -rf /" → ["echo ok", "sudo rm -rf /"] → 각각 deny
- **Shell Escape Detection**: 비-shell 언어에서 shell 호출 감지
  - Python: `os.system()`, `subprocess.run/call/Popen/check_output()` (문자열+리스트 형태)
  - JS/TS: `execSync/execFile/execFileSync()`, `spawn/spawnSync()`
  - Ruby: `system()`, backtick
  - Go: `exec.Command()`
  - PHP: `shell_exec()`, `exec()`, `system()`, `passthru()`, `proc_open()`
  - Rust: `Command::new()`
- **Executor 환경변수 Deny List (70+ 항목)**: BASH_ENV, NODE_OPTIONS, PYTHONSTARTUP, LD_PRELOAD, GIT_TEMPLATE_DIR 등
- **Glob-to-Regex**: `sudo *` → `^sudo .*$`, `tree:*` → `^tree(\s.*)?$`
- EG-DESK 적용: agent가 Bash 실행 시 chained command 분리 검사 패턴. PreToolUse에서 security 레이어 추가 검토

**context-mode FTS5 3-Layer Search + Throttling 상세 (src/store.ts)**
1. Porter stemmer FTS5: `bm25(chunks, 5.0, 1.0)` — title 가중치 5x. `highlight()` 함수로 STX/ETX 마커
2. Trigram FTS5: Porter 결과 없을 때 fallback. substring 매칭
3. Fuzzy matching: vocabulary 테이블에서 Levenshtein distance 기반 유사 단어 → 대체 쿼리
- **Proximity scoring**: `findMinSpan()` sweep-line으로 키워드 간 최소 거리 → 근접 결과 우선
- **Search throttling**: 60초 윈도우 내 1-3회: 쿼리당 max 2결과, 4-8회: 1결과, 9회+: BLOCKED
- **MAX_OUTPUT**: ctx_search 40KB, ctx_batch_execute 80KB total cap
- EG-DESK 적용: memory 검색 시 progressive throttling으로 과도한 context 진입 방지

**Anthropic Evaluator 캘리브레이션 프로세스 상세**
1. 로그 분석: Generator 출력 + Evaluator 판정 수집
2. 인간 판단과 차이점 식별: false positive(과잉 칭찬) / false negative(과잉 비판) 분류
3. QA 프롬프트 업데이트: few-shot examples + detailed score breakdowns
4. 반복: 캘리브레이션 라운드마다 precision 향상
- "tuning a standalone evaluator to be skeptical turns out to be far more tractable than tuning a builder to be self-critical"
- EG-DESK 적용: Verification Gate에서 Evaluator agent의 few-shot calibration 도입

**agent-skills-cli Conflict Detector 3전략 상세 (Karanjot786/agent-skills-cli)**
1. **Keyword Contradiction**: 7 대립 동사 쌍 (add/remove, enable/disable, allow/deny 등) + Jaccard similarity > 0.4
2. **Topic Overlap**: heading(0.5) + keyword(0.35) + code language(0.15), Jaccard > 0.35 → 동일 영역 다른 지시 감지
3. **Rule Extraction**: Do/Don't 리스트 추출 → 정면 충돌 감지
- EG-DESK 적용: compose-team에서 worker간 task 충돌 감지. 같은 파일을 다른 방향으로 수정하려는 경우 사전 차단

**OpenJarvis GuardrailsEngine (open-jarvis/OpenJarvis)**
- 3-Level: WARN(경고 로깅) → REDACT(민감 데이터 마스킹) → BLOCK(실행 차단)
- 입출력 양방향 검증
- Trace-driven learning: 실행 trace에서 위험 패턴 학습 → 자동 룰 추가
- EG-DESK 적용: agent 출력 검증 레이어. WARN(로그) → BLOCK(거부) 2단계 최소 도입

### Round 2 추가 조사 보충 (2026-03-28)

> 출처: EG-Library Expansion Round 2 추가 조사, COMPOSE_TEAM_V2_RESEARCH.md

**agent-skills-cli Security Audit Engine — 33개 regex 규칙, 6개 위협 카테고리, SARIF 출력**

`src/core/scanner-rules.ts` (33개 규칙 정의) + `src/core/audit.ts` (스캔 엔진)에서 skill 설치 전 사전 보안 검증 도구 구현.

6개 위협 카테고리:

| 카테고리 | 규칙 수 | 심각도 | 예시 패턴 |
|----------|---------|--------|----------|
| Prompt Injection (PI) | 8개 | critical~medium | `ignore previous instructions`, `you are now a`, jailbreak 패턴, 인코딩 기반 주입, delimiter 조작 |
| Command Injection (CI) | 7개 | critical~medium | `rm -rf /`, `curl \| bash`, `eval()`, `sudo` |
| Data Exfiltration (DE) | 5개 | critical~medium | webhook 전송, DNS 탈취, env var 접근, 민감 경로 읽기 |
| Tool Abuse (TA) | 4개 | high~low | 경로 순회, 시스템 디렉토리 쓰기, 프로세스 생성 |
| Hardcoded Secrets (HS) | 6개 | critical~medium | AWS 키, API 키(sk-..., ghp_...), JWT, DB 연결 문자열, 개인키 |
| Unicode Steganography (UC) | 4개 | high~low | zero-width 문자, RTL override, homoglyph, invisible separator |

동작 방식:
- 파일 단위 line-by-line regex 스캔 (LLM 불필요)
- false positive check 콜백 지원 (규칙별 2줄 위아래 context로 오탐 필터링)
- 256KB 이상 파일 자동 건너뜀
- **SARIF 출력** 지원 — GitHub Code Scanning에 직접 연동 가능
- `--fail-on` 옵션으로 CI/CD 게이트 역할 (severity 임계값 설정)
- Prompt Injection 카테고리(PI001-PI008)는 agent skill 특화 위협
- Unicode Steganography 감지는 다른 보안 도구에서 흔치 않은 고유 기능

출처: RESEARCH.md 1331~1357행 (explore-agent-13, agent-skills-cli)

**nodeskclaw SecurityPipeline — before+after 3모드 (MODIFY/REDACT/monitor)**

요청 전후에 보안 파이프라인 적용. 3가지 모드 지원:
- **MODIFY**: 요청/응답 내용을 수정하여 안전하게 변환
- **REDACT**: 민감 데이터를 삭제/마스킹
- **monitor**: 수정 없이 감시만 수행 (로깅)

before 파이프라인(요청 진입 시) + after 파이프라인(응답 반환 시) 양방향 적용.

출처: RESEARCH.md 1137~1138행 (explore-agent-10, nodeskclaw)

**agent-deck race detector 테스트 — Go test -race 필수, 150+ 파일**

`go test -race -v ./...` — race detector 필수 실행. Go 1.24.0 기반.

테스트 규모:
- 150+ Go 파일 중 상당수에 `_test.go` 동반
- 대형 테스트 파일: `instance_test.go` (99KB), `conductor_test.go` (71KB), `tmux_test.go` (85KB)
- 통합 테스트: `handlers_ws_integration_test.go`
- 빌드 파이프라인: CGO_ENABLED=0, ldflags `-s -w`, GoReleaser (linux/darwin x amd64/arm64)
- Pre-commit hooks (Lefthook): gofmt + go vet 병렬, pre-push: golangci-lint + go test -race + go build 병렬

출처: RESEARCH.md 1249행 (explore-agent-9, agent-deck)
