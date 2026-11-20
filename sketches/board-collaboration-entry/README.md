# 공용 Board 입구 리허설

[단일 HTML 열기](./index.html). 설치·로그인 없이 브라우저에서 열어 `다음 조작`을 누르거나, 어느 사람의 Desk에서 어떤 메뉴를 직접 누르는지 살펴본다. 같은 Canvas 안에 개인 영역과 공용 영역이 함께 있는 개념 모형이며 제품 스크린샷이나 실제 원격 권한 검사가 아니다. 가상 직원을 바꾸는 버튼은 연습용이다. 새로고침하면 초기화된다.

| 구분 | 어디서 시작해 어디로 가는가 |
| --- | --- |
| **현재 제품에 있는 로컬 동작을 재현** | 처음에는 `[Desk 시작]` 또는 Browser 도구 모음의 `[Desk]`. Desk 안에서는 왼쪽 `[Desk]` 또는 좌상단 현재 이름 ▾ → `Board` 목록 → 저장된 이름. 왼쪽에 보이는 보드 이름을 바로 눌러도 된다. 새 창이 열리지 않는다. 같은 Canvas의 빈 곳에 저장 배치를 펼치거나, 이미 열려 있으면 그 영역만 선택하고 필요할 때만 카메라를 옮긴다. 모형의 `자료 정리`는 가상이름이다. |
| **기존 설계: 내가 가진 Board에 초대** | 보드 제목의 `⋯ → 공유 → 미리보기 → 보내기`. 상대는 앱 알림(또는 설정한 채널) → `[초대 내용 보기]`에서 사람·대상·역할·기간을 확인 → `[수락하고 참여]`. 성공하면 한 동작으로 자신의 Canvas에 허용된 범위가 열리고 제목에 포커스가 간다. 채팅, ERP 로그인 또는 원격 조작에 들어가는 게 아니다. |
| **이번 UI 제안: 둘이 새로 개설** | `[Desk] → [새 Board] → [함께 만들기]`에서 목적·참여자·자료 범위를 제안. 같은 개설에 둘 다 수락해야 한 공용 Board가 생긴다. 개시자의 Canvas는 상대가 수락했다는 이유로 이동하지 않는다. 상대도 개인 보드를 복제하거나 합치지 않는다. |
| **다시 열기** | 기존 상세 설계: `[설정] → [공유 관리] → [받은 초대] → 항목 → [열기]`. 일상용 바로가기로, 현재 유효한 **Board 전체 참여권**이 있는 경우만 기존 왼쪽 목록에 `출고 협업 · 공용`을 두는 것이 이 모형의 제안이다. 같은 보드를 다시 열며 새 사본을 만들지 않는다. **한 자료만** 허용된 경우 받은 초대에서 그 자료만 열고, 원래 보드 전체의 이름·항목은 보이지 않아야 한다(자료 전용 경로는 이 Board 모형에서 별도 재현하지 않는다). |

- `초대받기`에서 초대만 받았을 때에는 카드가 없고, 수락 뒤에는 공용 영역의 제목과 빈 상태가 보인다. `민재가 배송 카드 공개`는 모형 조건이다. 이때서야 지우에게 SH-42가 보인다. 그 이후의 [배송 업무 인계 시연](../board-collaboration-rehearsal/README.md)은 별도 예제이며 상태를 주고받지 않는다.
- 수락 직전 `수락 후 첫 열기 실패해 보기`를 켜면 수락은 유지되고 현재 위치에 안내가 남는다. `[수락 상태 확인] → [공유 대상 다시 열기]`로 복구한다. 접근 회수가 적용된 후 옛 행·바로가기에서는 열 수 없다. 개인 영역에 놓은 자료는 그대로다.
- 실제 제품의 근거: [Board switcher·openBoardSnapshot·왼쪽 rail](../../apps/firefox-ui-demo/overlay/JS/eg-desk-surface.uc.js), [사용자 안내](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-local-share). 기존 사람 초대 설계는 [초대·권한 상세](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-collaboration-invite), 이번 접근 경로는 [매뉴얼](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-board-entry-doors)과 [기술 계약](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-board-entry-doors)에서 구분한다. 로컬 Board Thread의 `[초대]`는 사람을 초대하는 버튼이 아니라 Agent 멤버 추가다.
