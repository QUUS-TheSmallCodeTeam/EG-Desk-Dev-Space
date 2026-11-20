# 물류 담당자가 합류하는 공용 Board

**개발 리허설, 제품 기능 아님.** [index.html](./index.html)을 다운로드해 브라우저에서 연다. 설치·서버·로그인이 필요 없고, 새로고침하면 초기화된다. 출고 협업은 가상 보드이고 `SH-42`는 가상 운송 참조다. 모든 자료·합성 실행 결과가 같은 HTML에 있다. 시점을 전환하는 연습은 실제 신원 인증, 다중 PC 격리 또는 접근 통제의 증명이 아니다.

이 예시는 초대가 도착한 뒤부터 시작한다. Desk 자체가 어떻게 보이는지, 공개받은 요청서에서 일을 맡고 직접 회신하는 경로는 [지우의 작업 화면](../board-collaboration-entry/README.md)에서 확인한다. 여기의 역할·회수 버튼은 수신자별 결과를 검증하는 개발 장치이며 제품 작업면을 뜻하지 않는다.

1. **배송 인계:** `[다음 단계]`를 누른다. 지우가 초대를 수락해도 카드는 없다. 민재가 배송 카드 한 장을 공개하고 지우가 이를 맡는다. 민재가 한 번 허용한 검수 Agent에게 집하 상태를 묻는다. 서윤이 나가도 배송 건은 계속된다. 답은 지우에게 먼저 오고 지우가 회신한 뒤에만 민재에게 보인다.
2. **답이 오기 전 회수:** 지우가 자기 배송 Agent에게 묻고 민재가 공개를 회수한다. 새 허가로 같은 자료를 열어도 옛 실행의 답은 나타나지 않는다. 새로 맡아 시작한 요청만 답을 받는다.
3. **나갔다 다시 합류:** 답을 받은 지우가 나갔다가 새 초대로 돌아온다. 새 지정 공개 전에는 옛 카드·개인 답이 보이지 않는다. 시점만 바꿔 보기, 서윤의 창 닫기, 자료 연결 회수, 멤버 탈퇴는 서로 다른 동작이다.

`누구의 화면?`은 관찰만 바꾼다. 참가자가 직접 버튼을 누르면 안내는 멈추고 자유 조작이 된다. 외부 실행 대신 `[결과 도착을 직접 진행하기]`로 해당 요청의 합성 완료를 전달한다. 처음부터 다시 진행하려면 `[처음부터]`를 누른다.

이 예시의 정책: 민재가 물류 업무를 지정 공개하고 민재·서윤은 수량 대조를 볼 수 있다. ERP와 이를 사용한 차이 계산은 서윤의 멤버십과 유효한 조회 허가에 의존한다. 지우에게 허가될 수 있는 Agent 실행 입력은 `SH-42` 및 `pickupStatus` 필드뿐이다. 지우가 **명시적으로 민재에게 보낸** 허용 회신은 이 예시의 보존 조건에 따라 민재에게 남는다. 다른 조직의 관리자·보존·위임 기본값을 정한 것이 아니고, 이미 전달된 내용의 회수도 약속하지 않는다. 운영 구현이라면 서버에서 각 수신자에게 보낼 데이터를 제한해야 한다.

[사용자 흐름](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-third-person-shipping) · [기술 계약](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-shipping-handoff) · [기대 결과와 현재 검증](../../apps/firefox-ui-demo/docs/BOARD_COLLABORATION_AND_CROSS_AGENT_DESIGN.md#shipping-handoff-rehearsal)

상태 모델은 [격리 fixture](../../apps/firefox-ui-demo/scripts/egdesk-joint-board-rehearsal-fixture.mjs), 검사는 [테스트](../../apps/firefox-ui-demo/scripts/egdesk-joint-board-rehearsal-fixture.test.mjs)다. `node --test apps/firefox-ui-demo/scripts/egdesk-joint-board-rehearsal-fixture.test.mjs`로 실행한다. HTML의 `script#fixture`에는 같은 모델 함수가 들어가며 테스트가 일치 여부를 검사한다. `sketches/` 외부의 제품 셸, HTTP 경로나 Agent 도구에는 연결하지 않는다.
