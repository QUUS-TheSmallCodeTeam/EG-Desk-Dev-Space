# CODE-05 계획 (worktree code-05-diff-two-stage, 2026-10-31 03:55 KST)

## 현재 상태(조사)
- 1단계(D-X2 승인 전): uc.js L3510 `detailsView.approval(run, approval)` → `EGDeskChatChangeReview.renderApproval` '변경 보기'(hunk·줄번호 diff, 읽기 전용) + 기존 승인 카드 버튼(허용/거절/취소). 이미 연결돼 있음.
- 2단계(적용 후 덩어리별 되돌리기): `EGDeskChangeReview.createChangeReview`(모듈)와 `EGDeskFileView.showChangeReview`(패널)는 있으나 호출자가 없음(ledger 8580896 행 "화면 연결 S3·S10 남음").
- `/chat/run-project-origin` 읽기는 `createCodexActivityReadScope.read`에서 commandExecution 항목에만 허용돼 있어 fileChange 항목은 origin 확인 불가.

## 구현
1. `EGDeskChangeReview.mjs`: 되돌리기/취소/삭제 뒤 실제 파일 재읽기로 요청≠관찰 구분해 표시. SOURCE_CHANGED(D-X1)면 쓰지 않고 '검토 시점(−) vs 지금(+)' 비교 블록 + 해시 표시.
2. `EGDeskChatChangeReview.sys.mjs`: activity 카드에 `readOrigin`+`onReviewApplied` 훅(RunResult와 같은 쌍). 적용 완료(completed) 항목에만 '적용된 변경 검토 · 되돌리기' 버튼. 모듈은 FS를 만지지 않고 보존된 change 행만 넘김.
3. uc.js: `openAppliedChangeReview(request)` — `openVerifiedRunFile`(origin 재검증)로 File 카드 열고 `card._fileView.showChangeReview(changes)`. read scope의 origin 읽기를 fileChange 항목에도 허용(2줄).
4. CSS: 2단계 패널 규칙을 diff 규칙 옆에.
5. 테스트: `scripts/egdesk-chat-change-review.test.mjs` 보강 + 새 `scripts/egdesk-change-review.test.mjs`(가짜 service로 되돌리기·SOURCE_CHANGED·재읽기 확인).

## 결과 (2026-10-31 11:08 KST, 04:05 한도 중단 뒤 재개)
- 커밋 2개(브랜치 claude/code-05-diff-two-stage-0e220b, push 안 함): `9821978` Confirm reverted and deleted files by rereading them / 다음 커밋 Open the applied-change review from a chat file change.
- 테스트: `node --test scripts/egdesk-change-review.test.mjs` 4/4, `node --test scripts/egdesk-chat-change-review.test.mjs` 20/20. 실제 Firefox 창 미검증.
- 소유 영역 밖 수정: 없음(uc.js는 ChangeReview 배선 함수 안에서만 — read scope의 origin 읽기 2줄 + 새 함수 openAppliedChangeReview + reader 훅 배선). fileCard zone·FileView 본문은 읽기만.
- 알려진 한계: /chat/run-changes 보존 diff는 redact 처리돼 비밀값이 섞인 hunk는 되돌리기 전 원문 복원에 실패해 'drifted'로 표시(되돌리기 버튼 없음). 삭제된 파일만 있는 변경은 File 카드를 열 파일이 없어 2단계 진입 불가.

## 회귀 수정 (2026-10-31 11:50 KST) — `db15cd2`
- egdesk-surface-state.test.mjs 2건 실패 → 944 중 943 통과·1 skipped(기존)·0 실패. 테스트 파일은 바꾸지 않음.
- CSS: Chat diff 셀렉터를 원래 문자열 그대로 유지하고 `.egdesk-change-review .egdesk-diff-*`를 같은 규칙에 쉼표 셀렉터로 추가(`:is()` 제거).
- uc.js: `readOrigin`은 다시 '정확히 일치하는 command 항목'만. 2단계용 `readChangeOrigin`을 scope에 추가 — 같은 run의 정확히 일치하는 **완료된** fileChange 항목만, itemKind는 호출자 options로 바꿀 수 없음.
