# UX-02 미니맵 — 진행 노트 (worktree ux-02-minimap-boards-8cec7e, 2026-10-31 03:58)

## 상태
- Board 영역·겹침 목록·이름 검색·카메라 이동은 `dca10a3`·`5ac3e42`(10-24/10-29)로 이미 화면에 연결돼 있었다. 이번 라운드의 남은 범위는 "결과 행에 대상 유형·소속 Board 표시"와 "rail search 선택 시 카메라 이동".
- 커밋: `4fe2cd6` 미니맵 행에 유형·Board 이름, `ebae4ef` rail search Canvas 결과 선택 시 카메라 reveal + 소속 Board 자막, `a8cdc54` VIEWPORT 문서.

## 다른 세션이 알아둘 것
- 미니맵은 View의 소속 Board를 `card.dataset.projectionId`(uc.js L4310·L5003에서 설정)로 읽는다. CNV-03이 소속 마커를 `dataset.boardId` 등으로 바꾸면 `renderDeskMinimapWorld`·`buildDeskMinimapEntityRows`·`buildRailSearchCardResults`의 읽기 3곳을 같이 바꿔야 한다.
- 새 순수 로직은 별도 모듈이 아니라 `EGDeskCanvasLayout.sys.mjs`의 UX-02 구역(`minimapSearchRows` 바로 아래 `minimapRowKindLabel`)에 넣었다. 이유: `egdesk-surface-state.test.mjs`의 minimapUiHarness가 미니맵 함수들을 고정 의존성 목록(`MinimapLayout` 포함, 새 식별자 불포함)으로 컴파일하므로 새 모듈 식별자를 uc.js에 넣으면 그 테스트가 ReferenceError로 깨진다.
- 카메라는 기존 `moveCameraToMinimapNode`(pan만, zoom 불변)만 호출. Pan/Zoom 본문(UX-05 구역)은 건드리지 않았다.

- `65118bc` 하네스 테스트: 목록·겹침 행의 유형·Board 이름을 컴파일된 미니맵 함수로 검증 (surface-state 944/945 pass, 1 skip은 기존).
