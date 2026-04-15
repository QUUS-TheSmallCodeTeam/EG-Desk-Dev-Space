---
name: feedback_strong_claim_verification
description: Strong claim (byte-identical, always, never, 100%, identical, exact, all) before DM/report requires 1-tool verify — no exceptions
type: feedback
---

# Rule

강한 주장(byte-identical, always, never, 100%, identical, exact, all, 전부, 항상, 완전히)을 DM/보고/memory 에 작성하기 전에 **최소 1회 tool verify 필수**. 추론만으로 작성 금지.

**Why**: 2026-04-10 Task #6 (design-agent v2) Phase 2a~2b 진행 중 sprint-leader 가 강한 주장 3건을 tool verify 없이 발송해 팀원(WM, team-lead)에게 잘못된 정보를 전달함. WM 이 하나하나 verify 로 정정 → 재작업 + trust cost 발생. 단순 인지 비용이 아니라, downstream consumer 가 내 주장을 기반으로 판단할 때 cascading error 유발함.

**How to apply**:
1. 즉시 작성 중단 — "byte-identical", "정확히 N개", "전부" 등 강한 단어가 떠오르는 순간 멈춤
2. Tool 선택 — Read(파일), Grep(패턴 count), Bash(diff/shasum/wc), WM DM(file-map)
3. 1회 confirm — 직접 evidence 수집
4. 문장 재작성 — 정확한 숫자/라인번호/SHA 포함, 또는 "추정" caveat 추가
5. 발송

**Scope**: 사실 주장, 파일 내용, 실행 결과, 숫자 카운트, 파일 비교, verification 결과

**Exception**:
- 본인 진행 상태 보고 ("Phase 2b 진행 중")
- Plan 기술 ("다음 단계는 X")
- 의견 ("이 방식이 더 나을 것 같다")
- 인용 ("team-lead 가 X 라고 말함") — 인용은 verify 불필요

---

# Incident Log

## Violation #1: "byte-identical mirror" (Phase 2a, 2026-04-10)

**주장**: `references/omc-scan/` ↔ `references/agent-orchestration/oh-my-claudecode/` 가 byte-identical mirror clones.

**Evidence 미수집**: 두 디렉토리 비교 없이 구조만 훑어보고 "mirror" 단정.

**실제**: Drift fork. `diff -rq` 결과 40+ 파일 차이. CHANGELOG +2191 bytes, 12 READMEs 추가, 7 bridge files, 새 SECURITY.md.

**특이**: `agents/designer.md` **개별 파일 한정**으로는 byte-identical (SHA1 `cafcd65f6069baf0c7a2fb49463c9f246f758f04`, 5768 bytes, 104 lines). 이는 "drift fork with stable_zones" 패턴 — 특정 frozen contract zones 는 동기화 유지하면서 broader repo 가 diverge.

**교훈**: "mirror" 는 repo-level 주장. 파일 하나 비교했다고 repo 전체를 mirror 라고 부르면 안 됨. Scope 명시 필수.

**Correct wording**: "`agents/designer.md` 는 두 ref 에서 byte-identical (SHA1 cafcd65..., 2026-04-10 verified), broader repo 는 drift — 12 READMEs + bridge files 차이"

## Violation #2: "9 block reflected in v2" (Phase 2b, 2026-04-10)

**주장**: WM 에게 보낸 DM 에 "v2 에 9 block 반영 완료".

**Evidence 미수집**: v2 draft 를 다시 Read 해서 실제 block 을 세지 않고, 계획 단계 초안(9 개) 기억만으로 작성.

**실제**: 실제 반영된 건 7 block. Grep + Read 로 확인:
1. Pretendard INVERSION (L86-118)
2. Bash 3-layer destructive prohibition (L150-164)
3. On-demand dual review (L281-288)
4. Sprint-leader decision tree (L310-322)
5. Quality_Evaluation section (L536-620)
6. Failure Modes 14→20 (L411-430)
7. Quick reference DM pattern (L635-641)

**교훈**: 숫자 카운트는 Grep/Read 로 재검증. 계획 단계 숫자와 구현 단계 숫자가 다를 수 있음.

## Violation #3: "XML sections 11→13" (Phase 2b, 2026-04-10)

**주장**: v1.1 → v2 에서 XML top-level section 이 11→13 으로 증가.

**Evidence 미수집**: Grep 없이 암산.

**실제**: 12→13 (+1, Quality_Evaluation 만 추가). `Handoff_Patterns` 는 이미 v1.1 에 존재 (Context Locality patch 때 추가됨, v2 신규 아님).

**Grep 확인**: `^<[A-Z][a-zA-Z_]+>` 패턴으로 v1.1 에서 12, v2 에서 13 match.

**교훈**: "이전 버전부터 있었나?" 는 반드시 이전 버전 파일 직접 확인. 메모리 의존 금지.

---

# Bidirectional Application

이 rule 은 양방향으로 적용됩니다. Over-claim 만 검증하고 under-claim 을 놓치면 반쪽짜리 rule 이 됨.

## 1. Over-claim 방향 (통상 방향)

"byte-identical", "always", "100%", "전부", "완전히" 등 **과장된 강한 주장**을 DM/memory 에 쓰기 전 1-tool verify.

→ 과장된 주장 → 실제 약함 → cascading correction. (Violation #1-3 이 모두 이 방향.)

## 2. Under-claim 방향 (역방향)

"아직 pending", "not yet reflected", "only portion done", "sub-bump 에서 처리" 등 **축소된 상태 보고**를 DM 에 담기 전에도 filesystem 직접 재확인.

→ 이미 완료된 것을 "pending"으로 잘못 보고 → 상대방이 불필요한 재작업 경로 계산 → 상대방이 정정 DM 보내면서 trust cost 상승.

## Meta

**DM 내용은 ephemeral, filesystem 은 authoritative.**
본인이 직접 쓴 파일조차 DM 전에 재확인 필요 — "내부 작업 메모" 와 "실제 committed 상태" 가 다를 수 있음. 상대방에게 state 를 전달하기 전 filesystem 재확인 비용 < 잘못된 state 전파 후 정정 비용.

## Under-claim Incident Log

### 2026-04-11 WM v19 bump under-report (Phase 2b-3)

**주장**: WM 이 v19 bump 후 DM 에서 "sprint-leader memory entry 만 반영, L155 traceability / mirror_map 은 sub-bump 에서 pending".

**실제**: Sprint-leader 가 file-map.json 직접 Read → 3-way merge 전체(L30 mirror_map 완전 schema, L61-64 agent-memory dirs, L75-76 key_files, L155 draft entry traceability) 가 이미 v19 에 committed.

**원인**: 과도한 caution ("sub-bump" 프레이밍) 때문에 실제 commit 범위를 과소 보고. Filesystem 재확인 없이 DM 작성.

**정정 경로**: Sprint-leader Read → 정정 DM 발송 → WM 재확인 → under-report 인정.

**교훈**: bump/edit 직후 본인이 쓴 파일조차 DM 전 1회 filesystem 재확인. "방금 썼으니까 기억대로" 금지.

---

# Meta Pattern

세 건 모두 **"tool 을 쓰면 30초, 안 쓰면 사후 정정 15분+cascading DMs"** 구도. Verify cost < correction cost. 항상.

양방향 모두 해당 — over-claim 은 "더 강하게 썼으나 실제 약함", under-claim 은 "더 약하게 썼으나 실제 강함". 둘 다 downstream consumer 를 오도.
