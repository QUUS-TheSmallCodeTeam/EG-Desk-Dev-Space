---
name: 강한 주장 relay 전 1회 tool verify 필수
description: DM/보고 작성 중 "byte-identical", "always", "never", "100%", "identical" 같은 강한 수식어는 relay 전에 최소 1개 tool 로 confirm 필수. 2026-04-10 sprint-leader byte-identical mirror 단정 사건 교훈
type: feedback
---

## Rule

DM/보고 작성 중 아래 수식어를 만나면 **relay 전에 최소 1개 tool 호출로 1회 confirm 필수**:

- `byte-identical`, `identical`, `exact match`, `same`
- `always`, `never`, `everyone`, `all`, `none`
- `100%`, `completely`, `entirely`, `totally`
- `guaranteed`, `certain`, `definitely`

**Why**: 2026-04-10 사건 — sprint-leader 가 `omc-scan/` 과 `agent-orchestration/oh-my-claudecode/` 를 Phase 2a 탐색 중 file tree overlap 만 보고 "byte-identical mirror clone" 으로 단정. team-lead 가 WM 에게 그대로 relay. WM 이 `diff -rq --exclude=.git` 한 번으로 검증 → 실제로는 40+ 파일 drift (CLAUDE.md +16B, CHANGELOG.md +2191B, 13 README 번역, bridge/\*, dist/__tests__/\*, SECURITY.md 신규 등). `diff` 명령 1회면 확정 가능했는데 "관찰 → 단정 → relay" 체인이 verify 없이 돌아감. 결국 WM 이 정정 DM 2통 (sprint-leader + team-lead) 보내는 cost 발생, reconciliation block 까지 이어짐.

**How to apply**:

1. **DM 초안 작성 중 위 수식어 검출**:
   - Bash `diff`, `shasum`, `wc -l`, `ls -la` 중 적합한 것 1회 실행
   - 또는 Read/Grep 로 claim 의 대상을 직접 확인
   - Tool 결과가 claim 을 뒷받침하면 `[검증]` 태그 + 결과 요약 포함해서 발송
   - Tool 결과가 claim 을 반박하면 수식어 제거 또는 조건절 추가 (`~ 에서만`, `대부분`)

2. **Relay 시나리오** (A → B 주장, WM 이 A → C 로 전달):
   - WM 은 A 의 주장을 맹신하지 않음
   - 특히 **C 가 이 주장 기반으로 action 취할 예정이면 WM 이 verify 필수**
   - Verify 불가능한 외부 사실 (다른 세션 상태, 과거 이벤트) 은 `[의견]` 태그 + 소스 명시 (`A 말에 따르면~`)

3. **자기 가시 범위 내 주장은 예외**:
   - 본인 진행 상태 (`task #6 완료`), 본인 plan, 본인 judgment 는 tool verify 불필요
   - 단, "파일 X 가 존재한다", "라인 수 Y 다", "해시 Z 다" 같은 외부 사실 주장은 항상 tool verify

## Exception Categories

- **의견/판단**: `[의견]` 태그 + caveat 로 충분 (tool 불필요)
- **본인 상태**: 자기 task 진행, 자기 plan (tool 불필요)
- **과거 이벤트 recall**: memory 기반이면 "memory 에 따르면~" 명시 (tool 로 재검증 가능하면 verify, 불가능하면 caveat)
- **외부 시스템 실시간 상태**: 다른 세션, 외부 API → caveat 로 표시

## Detection Cue

본인의 DM 초안에서 "is"/"are"/"equals"/"matches" 같은 **is-verb** 와 strong adjective 가 결합되면 stop → verify:

- "X is byte-identical to Y" → verify
- "Z equals W" → verify
- "All A are B" → verify

반면:
- "X might be similar to Y" → OK (hedge 명시)
- "I think Z could be W" → OK (의견 명시)
- "Most A seem to be B" → OK (부분 명시)

## Bidirectional Application

이 rule은 양방향으로 적용됩니다:

1. **Over-claim 방향** (통상 방향):
   "byte-identical", "always", "100%" 등 강한 주장을 DM에 담기 전 1-tool verify.
   → 과장된 주장 → 실제 약함 → cascading correction.

2. **Under-claim 방향** (역방향):
   "아직 pending", "not yet reflected", "only portion done" 등 축소 주장을 DM에 담기 전에도 filesystem 직접 확인.
   → 이미 완료된 것을 "pending"으로 잘못 보고 → 상대방이 불필요한 재작업 경로 계산.

**Meta pattern**: DM 내용은 ephemeral, filesystem은 authoritative.
상대방에게 state를 보고하기 전에 filesystem으로 한 번 더 재확인하는 비용 < 잘못된 state 전파 후 정정 비용.

## Incident Log — Under-claim 방향 사례

- **2026-04-11 Task #6 Phase 2b-3**: WM이 v19 bump 후 DM에서 "sprint-leader memory entry만 반영, L155 traceability / mirror_map은 sub-bump에서 pending"이라고 축소 보고했으나, 실제 파일 Read 결과 3-way merge 전체가 v19에 이미 완료되어 있었음. Sprint-leader 직접 Read → 정정 DM 발송 → WM 재확인 → 합의.
  - **원인 분석**: 과도한 caution ("sub-bump" 프레이밍) 때문에 실제 commit 범위를 과소 보고. Filesystem 재확인 없이 DM 작성.
  - **Lesson**: bump 직후 본인이 쓴 파일조차 재확인 필요 (내부 작업 메모 ≠ 실제 committed 상태일 수 있음).
