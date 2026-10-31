# UX-05 배치 조작 — 세션 ux-05-placement-ops 인계 노트 (2026-10-31 16:03 KST)

브랜치 `claude/ux-05-placement-ops-ea21b9` (push 안 함). main `claude/vision-gap-20261024` a61b70f 병합 완료.

## 커밋
- bbb8052 Add placement groups, in-view arrange and guide boxes to the Canvas layout module
- c828880 Wire snapping, layout undo, arrange and groups into the Canvas screen (04:05 끊김 전 미커밋 513줄을 그대로 수습)
- 6259750 Merge main — 충돌 1곳(uc.js 상단 import 줄: AgentIdentityView vs CanvasLayout) → 두 줄 모두 유지
- 68b67f2 Style snap guides, group frames and the placement input
- e56df16 Document Canvas placement operations in the interaction model

## 화면 연결 방식 (uc.js 다른 블록을 고치지 않음)
`installCanvasPlacementOps(viewport, layer)` — `installCanvasPanZoom` 끝에서 호출, 그 바로 뒤에 정의.
카드별 드래그/리사이즈 리스너(spawnDeskWindowShell·Chat·Settings·outline proxy)는 그대로 두고,
window capture `pointerdown`으로 제스처를 감지한 뒤 그 카드의 `style` MutationObserver로 raw rect를 스냅 rect로
덧쓴다(paint 전, `takeRecords()`로 자기 쓰기 무시). 그룹 멤버는 같은 delta로 이동.
소유 영역 밖 배선 3줄: import 1줄(L31), `serializeDeskSnapshot().groups` 1줄, `restoreDeskSession` 안
`state.restoreCanvasGroups?.(...)` 1줄, 마퀴 선택에 `state.expandCanvasSelection` 1줄.

## 실화면 미검증 (Firefox 실행 금지 규칙)
- MutationObserver 덧쓰기 타이밍, remote `<browser>` 위 pointer 이벤트 target, header focus 이동(배치 변경 뒤 View bar에 tabindex=-1 부여 후 focus).
- 확인 시나리오: 창 두 개 띄우고 끌기 → 24px 격자/가장자리 스냅 + 안내선; Option 누르면 해제; 끌고 난 뒤 ⌘Z; View bar 우클릭 → 메뉴; 두 창 선택 후 [그룹으로 묶기] → 점선 프레임, 한 창 끌면 함께 이동; Desk 저장 후 재시작해 그룹 유지.

## 테스트 (고정 Node v24.22.1, 단건)
canvas-layout 41/41 · surface-state 955 (954 pass, 1 skipped, 0 fail) · surface-modules 13/13 · design-tokens 37/37 · chat-presentation 9/9. `node --check` 통과.
