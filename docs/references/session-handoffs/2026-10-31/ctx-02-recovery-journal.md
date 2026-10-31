# CTX-02 — Desk 복구 journal (worktree ctx-02-recovery-journal-a9af04, 2026-10-31 03:47~)

## 바뀐 동작
- `helper/egdesk-recovery-journal.mjs` (신규, 순수): `planDeskRetention(rows, {rule, now, utcOffsetMinutes, sharedBytes, hashesOf, blobBytesOf})` → `{keep, remove}`, `autosaveWindowMerges({head, ts, mergeMs, contested})` → boolean, `localDayOf`, 상수 `DESK_RETENTION`(200/30일/512MiB)·`DESK_AUTOSAVE_MERGE_MS`(60초)·`DAY_MS`. 테스트 `egdesk-recovery-journal.test.mjs` 8/8.
- `helper/egdesk-desk-store.mjs`: `prune`·`mergeable`이 위 순수 함수에 위임(동작 동일, 기존 retention/merge 테스트 그대로 통과). 상수는 journal 모듈에서 re-export(공개 이름 유지). `generations()` 행에 `boardCount`(저장 텍스트의 `boardProjections.projections` 키 수를 SQL `json_type`/`json_each`로 읽기 시점에 계산 — 스키마 변경 없음). 테스트 20/20.
- `EGDeskRecoveryState.sys.mjs`: `deskGenerationRows` 행에 `boards`('Board N개', bridge가 세지 않으면 ''), `changes`(바로 아래 이전 시점 대비 '카드 +2 · 도형 -1 · Board +1', 개수 같으면 '개수 변화 없음', 페이지 마지막 행은 ''). 신규 `deskGenerationChanges`, `deskRetentionText`(D-R1 안내문).
- uc.js 복구 기록 패널: 행 메타에 Board 수·주요 변경 표시, 패널 상단에 보존 규칙 안내 1줄(`data-testid=desk-history-retention`). '이 시점으로 복원'·'지금 작업에 합치기' 동작은 그대로.
- 문서 `docs/DESK_AGENDA_CARD_RUNTIME_MODEL.md`에 'Desk recovery journal (CTX-02, D-R1)' 절 추가.

## 경계
- Board store(uc.js L3907-4690, CNV-03)·Portable(RT-03)·Chat/Settings/Browser/Canvas 미수정. 스키마(v2) 변경 없음.
- ledger·TODO 미수정(지시). 아래 '갱신 제안' 참조.

## 미검증
- 실제 Firefox 창·브리지 기동은 하지 않음(지시). 검증은 `node --test` 단건: 저장소 20/20, journal 8/8, `egdesk-surface-state.test.mjs`의 '복구 기록 rows…' 1건만 `--test-name-pattern`으로 통과. 그 파일 전체는 돌리지 않음.

## ledger 갱신 제안 (CTX-02 행)
- 진행(2026-10-31): 보존·묶음 규칙을 `helper/egdesk-recovery-journal.mjs` 순수 함수로 분리(테스트 8/8, 저장소 20/20). 복구 기록 목록에 Board 수·이전 시점 대비 주요 변경·D-R1 보존 안내 표시. 실제 Firefox 창 미검증 유지.

## 커밋 (브랜치 claude/ctx-02-recovery-journal-a9af04, push 안 함)
- 0fe679d Add pure Desk recovery journal rules for D-R1 retention and autosave windows
- 62bcb48 Apply the D-R1 journal rules from the pure module and count open Boards per generation
- e132292 Show Board counts, changes and the D-R1 retention in the 복구 기록 list
- 6c54987 Document the Desk recovery journal rules and the 복구 기록 panel
- 022810e Join 복구 기록 pages before making rows so changes span page boundaries
- 추가: '더 보기'로 이어 붙인 페이지는 세대 목록을 합친 뒤 행을 만들어, 페이지 경계 행의 '주요 변경'도 비교됨(uc.js `loadDeskHistoryPage`, `deskHistory.generations`).
