# Session Findings (2026-02-26)

## Scope
- Workspace: `EG-Desk-Dev-Space`
- Purpose: Today’s verified findings about resume/subagent behavior and related notes.

## Key Findings (Verified Today)
1. Concurrent active agent limit is effectively `6` (spawn blocked at max 6).
2. `close_agent(id)` does not mean guaranteed permanent deletion; some closed IDs were later resumed successfully.
3. `resume_agent(id)` worked for:
- classic subagent IDs
- thread-like IDs observed from other contexts (including AU-side tests shared by user)
4. Practical behavior in this runtime looks like a shared resumable ID space (`thread-like context handle`), not strictly separate spaces.
5. `timed_out` from `wait` means no completion within timeout window, not necessarily agent death.
6. `not found` can be transient and is not always permanent loss.
7. `/compact` mainly compresses conversational context; it may lose detail-level history for model context, but is different from ephemeral persistence behavior.

## Important Clarification
- Strong operational model from today’s experiments:
  - Treat IDs as resumable context handles.
  - Always verify with `resume -> ping`.
  - If unavailable, retry and then respawn if needed.
- Persistence is empirical/operationally validated here, but not guaranteed forever under all backend retention conditions.

## Cowork Notes (Today)
- Cowork: local conversation history storage exists.
- Cowork: no memory across sessions.
- Long-term reusable workflow knowledge should be stored as files/instructions (runbook/checklists), not assumed as session memory.

## ID Inventory (Today)

### Root / Thread-like IDs
- `019c8e4f-a195-7d12-9644-4af2b366cc4f` - EG root session/thread ID (user-provided/used)
- `019c982e-3cfa-7e72-bc2c-84cc0034a9ba` - AU-side session/thread ID (user-provided; cross-context test target)
- `019c4af7-4ca0-70d2-8d37-260ab9963d15` - additional resumable thread-like ID (alive confirmed today)

### Subagent / Agent IDs seen today
- `019c929d-3732-71b0-8aa4-eee1a0943796` - Claude Code feature research (v1)
- `019c929f-a88e-7ad1-a932-ff4b1c5da8d2` - Claude Code feature research (v2; later closed in one flow)
- `019c92b2-f5ea-7741-84a0-9cae5f0b0172` - Swarm v2 dedicated
- `019c92b7-409c-7921-a0d0-dcbee486909d` - Codex vs Claude structure/integration investigation
- `019c92d4-03d0-74e1-921d-b44e11f0d2cc` - persistence investigation (initial)
- `019c9301-5df0-7613-a002-a0eac117141a` - persistence re-audit
- `019c93aa-409d-7b81-8324-16089d0dccb7` - Cowork delete/search investigation
- `019c9440-f721-7fe2-b2a3-2358fe348ac9` - Cowork workflow knowledge reuse investigation
- `019c9832-0583-78d1-8ddc-dca1e57bb5d5` - audit agent (`Redwood`)

## Operational Checklist
1. Keep critical IDs in a secure note.
2. On reconnect: run `resume -> ping` first.
3. If `not found`, retry once, then respawn with same mission spec.
4. Do not assume infinite retention.

## Workflow Note (Hybrid: Code + Instruction)
- Workflow는 `고정 단계(코드)` + `가변 단계(LLM 판단)` 혼합 구조를 허용한다.
- 고정 단계는 스크립트/툴 실행으로 재현 가능하게 유지한다.
- 가변 단계는 LLM decision 노드로 분리하고 출력 스키마(`next_step`, `confidence`, `reason`)를 강제한다.
- `confidence` 임계치 미만이면 고정 fallback 경로로 보낸다.
- 실행 결과/분기 로그는 파일로 남겨 재실행 가능성을 보장한다.
- 원칙: 절차 뼈대는 파일/코드로 고정하고, 분기 판단만 LLM에 위임한다.

## V2 Note: State Revision vs History Recall Separation
- 문제 정의: chat 기반 UI에서는 `기억(recall)`과 `현재 작업 attention`이 같은 창에 섞여 토큰/집중도 낭비가 발생한다.
- 관점: 사람처럼 `작업 맥락 갱신(state revision)`과 `과거 회상(history recall)`을 분리해야 한다.
- 운영 원칙:
  - 실행 컨텍스트는 최신 상태(state)만 유지한다.
  - 변경 과정 대화는 실행창에서 드롭하고, 변경 결과(diff)만 반영한다.
  - 과거 과정은 아카이브로만 보관하고 필요 시 조회한다.
- 역할 분리:
  - Execution: 현재 상태로 실제 작업 수행
  - Revision: 상태 변경 제안/검토
  - Recall: 과거 근거 탐색(조회 전용)
- 의사결정 규칙: subagent는 컨텍스트를 직접 수정하지 않고 `변경 제안`을 제출, main이 수락/보류/기각 후 상태 버전을 갱신한다.
