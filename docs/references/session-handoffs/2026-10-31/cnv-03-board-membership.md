# CNV-03 Board 소속 편집·표시 — 인계 노트

- 브랜치: `claude/cnv-03-board-membership-d4007f` (worktree `.claude/worktrees/cnv-03-board-membership-d4007f`)
- 커밋: `b8fc50a` 순수 모듈+테스트 · `03137fe` uc.js 배선+CSS · `1ada5f9` 문서
- 검증: `node --test apps/firefox-ui-demo/scripts/egdesk-board-membership.test.mjs` 7/7 통과, `egdesk-design-tokens.test.mjs` 37/37 통과. Firefox 실행 검증 없음.

## 사용자가 보는 변화
- 모든 Desk Window(Browser·File·Terminal·Settings·Ontology·Result) View bar에 Board 제어가 생겼다. 소속 Board가 기록돼 있으면 이름 옆 ▾, 없으면 '소속 없음 ▾'.
- ▾ 메뉴: `'○○'에서 빼기` / `'△△'에 넣기`(열린 Board마다). 한 View는 한 Board(D-V1).
- Board 영역 안에서 새 View를 열거나 영역 안으로 끌어 놓으면 View bar 아래에 `'○○'에 넣을까요? [넣기] [아니요]` 칩. 수락 시에만 소속(D-V2·V3). 복원 중엔 칩 없음.
- 새 Board 저장(선택한 화면 N개 저장)은 그 자리에서 영역으로 묶는다. 사본 없음(D-V4). 빈 Board 저장은 종전처럼 목록에만.
- 소속 변경은 해당 Board '저장 안 됨' 표시(기존 dirty 경로).

## 병합 시 주의
- uc.js 소유 영역 밖 수정 3곳(각 1~3줄): `restoreDeskSession` 구성원 mousedown 리스너를 dataset 기반으로(L5255), `saveCurrentAgendaState`에 D-V4 묶기 2줄(L5317·5323), `showBoardScopeChooser` 안내 문구 1줄(L6372). UX-05/CTX-02 영역(L19230~, L21094~)은 손대지 않음.
- `spawnDeskWindowShell`은 새 기능을 `state.toggleViewBoardMenu?.()` / `state.offerBoardMembership?.()`로만 호출 — 기존 테스트 하네스가 셸 함수를 단독 컴파일하기 때문. 셸 안에 직접 참조를 넣지 말 것.
- 창 헤더에 칩 행이 추가되면 헤더 높이가 변한다(.egd-card-header flex column). Browser 제목줄 충돌 보정(L19380대)은 라벨만 보고 판정하며 새 버튼은 보지 않음.

## 남은 것
- Chat 카드(`spawnCodexChatCard`, Desk Window 셸 아님)와 도형에는 View bar 메뉴·칩이 없다(모듈은 kind 'shape' 지원).
- 실제 Firefox 화면·접근성 트리 미확인. 제안 칩은 `setTimeout 0` 뒤 창 위치로 판정하므로 비동기로 재배치되는 열기 경로가 있으면 오판 가능.
