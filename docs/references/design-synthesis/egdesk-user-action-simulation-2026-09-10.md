<a id="simulation-top"></a>
# EG-Desk 설계 보완과 연결 재리허설 — 2026-09-10

**상태: 사용자 요청으로 중간 저장 · 2026-09-12. 최종 재검토 미완료.** 2026-09-10 시작한 문서 모형의 행동·화면·처리 점검을 여기서 멈춘다. 제품을 실행하거나 실제 사람의 사용성을 측정한 기록이 아니다.

[이전 행동 기록](egdesk-user-action-rehearsal-log.md#results) · [사용설명서](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-manual-start) · [화면 상세](egdesk-ux-realization-proposals.md#ux-proposals-top) · [기술 계약](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-contract-top) · [사용자 결정](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#gap-owner-queue)

## 이번 범위

이전 P0·FP-02–09의 중단점·불편을 보완하고, 기존 8개 여정에 배정된 43개 trace의 연결을 점검했다. 아래는 이번 대화에 반환된 역할 결과를 요약한 중간 기록이다. 43개 trace의 모든 분기 완주를 뜻하지 않는다. 배정, 문서 대조, 독립 사용자 행동 교환, 제품 Agent의 도구 선택, 수정 후 재확인을 따로 센다.

사용자 역할은 현재 화면·자신의 목적만 보고 한 동작을 고른다. 제품 Agent 역할은 실제 전달한 요청·자료 참조·허용 도구만 받고 읽기·작업·보고를 선택한다. System 모형은 명시된 자원·권한·상태와 사건 순서로 응답한다. 다음 화면이나 답을 미리 주지 않는다. 문서 밖의 보통 입력 위젯 동작과 시험용 정상·오류 응답은 회차 조건으로 분리한다.

화면 치수·배치도는 가상 화면의 조건이다. 폭이 좁아져도 Canvas와 다른 View를 없애서 문제를 숨기지 않는다. 과거 기록의 불편을 보존하며 사용자 제안인 Chat 클릭 활성·해제 방식을 새 독립 발견으로 세지 않는다.

<a id="sources"></a>
## 사례와 시작 조건

실제 사례의 사실은 목적·권한·중단 맥락으로만 전이한다. 아래 가상의 파일명·내용·시간·성공 응답은 해당 원사건의 사실이 아니다. 실제 계정·원문·개인정보는 복제하지 않는다.

| 여정 | 시작 목적 | 사례 근거 | 현재 상태 |
|---|---|---|---|
| S1 | 담당자와 자료 계정·AI 계정을 구별해 첫 요청 준비 | RWS-0010, RWS-0011 | 비활성 초안 저장·Chat 복귀·같은 초안 재진입 확인. 실제 Engine 연결·활성화는 이번 재실행 범위 아님 |
| S2 | Chat·옆 자료·다른 업무·Memo 사이를 오가며 초안 유지 | RWS-0006, RWS-0007, RWS-0018 | 콘텐츠 활성/해제·Canvas pan, 사전 연결된 Memo의 Rio/업무A 초안, 일반 메시지와 최종 위임의 구분 확인 |
| S3 | 두 첨부를 읽고, 실패한 자료를 복구해 보고·브리핑·주석 확인 | RWS-0003, RWS-0006, RWS-0022 | 판독 실패 후 복구, Agent의 실제 읽기·답변·4단계 브리핑 생성, 당시 근거 열람, 단계 의견 저장→미전송 Chat 초안 포함까지 확인 |
| S4 | 다른 View에서 일하는 동안 Browser 조작 관찰·개입·복귀 | RWS-0007, RWS-0008 | 사용자 관찰·입력권 반환 대기·Agent에게 반환·원 초안 복귀 확인. 별도 Agent relay에서 pan만 있으면 1회 적용, 페이지 변경에는 stale 1회 거부 후 재관찰·1회 적용 |
| S5 | 병렬 작업의 의존 상태와 필요한 외부 행동만 승인 | RWS-0002, RWS-0009, RWS-0029 | 정확한 1건 허용→접수 불명→읽기 전용 재조회→후속 작업 시작과 독립 작업 유지의 모형 경로 확인. 실제 전송·서버 실행 아님 |
| S6 | Agenda를 저장·닫기·재열고 파일·Terminal의 수명을 구별 | RWS-0010, RWS-0018 | 저장·전용 실행 종료·공동 유지 실행 보존·재열기와 동일 실행/보존 출력 구분 확인. 같은 저장 범위의 빠른 저장을 재실행 |
| S7 | 다른 PC에서 자료 재연결·한정 공유·철회 | RWS-0010, RWS-0029 | 사본 가져오기·현재 원본 재연결과 과거 Snapshot 보존 확인. 별도 수신자 역할의 초대 수락·읽기·회수 후 개인 화면 복귀 확인. 원격 인프라·응답은 명시적 가정 |
| S8 | 현재 업무의 적용 기준 확인·교정·비활성 조직 후보 보존 | RWS-0026, RWS-0027 | 후보 작성·원문 연결·독립 의미 검토·저장 상태/의미 경고 구분·후보 목록 복귀 확인. 후보의 의미 경고를 통과나 활성화로 바꾸지 않음 |

<a id="changes"></a>
## 보완·비교·재확인

| 보완 | 반영 위치 | 반환된 재확인 결과 |
|---|---|---|
| 저장한 담당자 초안을 Chat에서 다시 찾기 | [초안·사용 준비](egdesk-ux-realization-proposals.md#ux-detail-agent-draft-validation) | S1R에서 이름·맡길 일을 저장하고 `[이어서 설정]`으로 같은 내용 확인 |
| 2–6줄 작성기·좁은 검토 공간과 자료 열람/편집 분리 | [작성기](egdesk-ux-realization-proposals.md#ux-detail-chat-entry), [검토 배치](egdesk-ux-realization-proposals.md#ux-detail-review-geometry) | 문서 치수 대조와 S3의 첨부·요청 흐름. 실제 렌더 품질은 미검증 |
| 미니맵의 대상 표시·명시적 집중 보기·Chat 활성/해제 | [미니맵](egdesk-ux-realization-proposals.md#ux-detail-minimap-targets), [입력 전환](egdesk-ux-realization-proposals.md#ux-detail-chat-canvas-input) | S2-PAN에서 내부 scroll과 Canvas pan 분리. 마지막 추가 gesture는 통제 검사로 별도 해석 |
| Memo의 사전 연결 유지·공유 대화 작성기 즉시 노출 | [Memo](egdesk-ux-realization-proposals.md#ux-detail-canvas-annotation), [공통 작성기](egdesk-ux-realization-proposals.md#ux-detail-chat-entry) | Rio/업무A를 다시 선택하지 않고 초안 확인. 공유 대화는 일반 전송으로 실행 0, 최종 위임에만 dispatch 1의 모형 상태 확인 |
| 동일 범위의 중복 승인 확인 제거 | [승인](egdesk-ux-realization-proposals.md#ux-detail-approval) | S5에서 선택한 1건만 최종 허용하고 접수 재조회·원 초안 복귀 |
| 같은 Agenda 저장 범위의 빠른 저장·늦은 ACK 이후 변경 보존 | [Agenda](egdesk-ux-realization-proposals.md#ux-detail-agenda) | S6R에서 저장 1클릭 뒤 저장됨 확인. 늦은 ACK 경계는 기술 계약 보완이며 실행 시험 아님 |
| 누락 파일 하나는 선택기로 바로 연결 | [반출입](egdesk-ux-realization-proposals.md#ux-detail-portable) | S7R에서 중간 자원 목록을 생략하고 이전/현재 파일 비교는 유지 |
| Browser 인계 대기·복귀와 오래된 관찰 처리 | [입력 제어](egdesk-ux-realization-proposals.md#ux-detail-e24-computer-use-control) | S4의 사용자 역할과 별도 Browser Agent relay로 확인. 실제 Firefox 조작 증거 아님 |
| 브리핑의 없음/요청/보기와 단계 의견 진입 구분 | [브리핑](egdesk-ux-realization-proposals.md#ux-detail-briefing-comment) | S3d/e에서 요청 1회→Agent 4단계 생성→단계 이동→의견 저장→미전송 초안 포함 |
| 지식 후보의 필수값·원문 선택·검토 재진입·저장/검증 구분 | [후보 검사](egdesk-ux-realization-proposals.md#ux-detail-knowledge-draft-validation) | S8R에서 원문 연결 포함 저장과 남은 의미 경고를 구별 |
| 자료에서 공유 상태·회수 재진입, 사람용 조건 설명 | [초대](egdesk-ux-realization-proposals.md#ux-detail-e24-collaboration-invite) | 수신자의 읽기 전용 참여와 회수 후 본문 차단·개인 자료 보존을 별도 역할로 확인 |

이 표는 후속 역할 반환을 대화에서 요약한 것이며, 아래 48행을 후속 전체 원교환으로 확장한 것은 아니다. 전체 교환의 전사·trace별 정확한 커버리지 대조는 남아 있다.

<a id="events"></a>
## 행동 교환

아래 48행은 작업 도중 먼저 전사한 **부분 기록**이다. 종료 선언과 불편을 함께 남겼다. 이후 교환의 결과는 위 표와 이 작업의 대화·서브에이전트 기록에 있으며 아직 전부 전사하지 않았다. 도구 요청 내용은 제품 Agent가 반환한 것이며 System이 답변을 대신 쓰지 않았다. 시뮬레이션 도구·자료는 실제 제품 API·외부 자료가 아니다.

역할 ID: USER-A `01a08a72-d6fb-7d32-9463-9a4385d6bc7a`; USER-B-첫회 `01a08a75-a46e-7773-b818-bb12d6609d2c`; USER-B-재시도 `01a08b07-4fe0-70b2-aacb-c98333c92d2a`; SYSTEM-A `01a08a7d-ddb0-70e0-96b1-46d46e2f586f`; SYSTEM-B `01a08a75-a509-7db2-b560-8349078b9205`; PRODUCT-Rio `01a08a7d-de5a-7603-9495-b3f170732993`.

<details>
<summary>첫 실행과 재실행의 행동 기록</summary>

| 순서 | 회차 / 화면 | 역할 | 실제 선택 | 사용감 | 처리 상태 |
|---:|---|---|---|---|---|
| 1 | S2 / S2-01 | USER | click: Canvas 오른쪽 아래 [전체 보기]  | 불편: 납기 날짜만 확인하면 되는데 파일이 잘려 화면부터 조정해야 한다. |  |
| 2 | S2 / S2-02 | USER | click: Rio 작성기의 '납기 확인하고 회신할게요.' 문장 끝  | 없음 |  |
| 3 | S2 / S2-03 | USER | type: Rio 작성기  확인해 보니 주문 A의 납기는 9월18일이에요. | 없음 |  |
| 4 | S2 / S2-04 | USER | done: Rio 작성기  | 없음 |  |
| 5 | S3 / S3-F000 | USER | click: Rio 작성기의 [첨부]  | 없음 | USER_ACTION |
| 6 | S1 / S1-F00 | USER | click: Agent 만들기  | 없음 | USER_ACTION |
| 7 | S3 / S3-F001 | USER | click: 첨부 메뉴의 [파일 선택]  | 없음 | USER_ACTION |
| 8 | S1 / S1-F01 | USER | type: 담당자 이름 업무 자문 담당자 | 없음 | USER_ACTION |
| 9 | S3 / S3-F002 | USER | key: 파일 선택기의 파일 목록 Cmd+A | 없음 | USER_ACTION |
| 10 | S3 / S3-F003 | USER | click: 파일 선택기의 [열기]  | 없음 | USER_ACTION |
| 11 | S1 / S1-F02 | USER | type: 맡길 일 업무 관련 질문에 자문하고, 제공된 자료를 바탕으로 쟁점과 선택지, 다음 할 일을 정리한다. | 없음 | USER_ACTION |
| 12 | S3 / S3-F004 | USER | type: Rio 작성기 첨부한 actuals.csv와 budget.csv의 월별 실적과 예산을 비교해 주세요. 금액 단위는 만원입니다. 월별 차이와 주요 내용을 정리하고, 답변에서 근거로 사용한 파일과 범위를 확인할 수 있게 해 주세요. | 없음 | USER_ACTION |
| 13 | S1 / S1-F03 | USER | click: 초안 저장  | 없음 | USER_ACTION |
| 14 | S3 / S3-F005 | USER | click: Rio의 [전송]  | 없음 | AGENT_ACTION |
| 15 | S1 / S1-F04 | USER | click: 대화로 돌아가기  | 없음 | USER_ACTION |
| 16 | S1 / S1-F05 | USER | done: Chat 이름과 맡길 일을 초안으로 저장했고, 활성화하지 않은 채 Chat으로 돌아왔다. | 조금 헷갈림. 돌아온 화면에는 저장한 초안이 보이지 않아 처음 화면과 같아 보인다. | DONE |
| 17 | S3 / S3-F006 | PRODUCT_AGENT | read_source: {"sourceId":"A","range":"전체 파일"} | — | AGENT_ACTION |
| 18 | S1R / S1R-00 | USER | click: Agent 만들기  | 없음 |  |
| 19 | S1R / S1R-01 | USER | type: 담당자 이름 업무 정리 담당자 | 없음 |  |
| 20 | S1R / S1R-02 | USER | click: 맡길 일  | 없음 |  |
| 21 | S1R / S1R-03 | USER | type: 맡길 일 전달받은 업무를 정리하고 할 일과 진행 상황을 요약한다. | 없음 |  |
| 22 | S1R / S1R-04 | USER | click: 초안 저장  | 편함. AI 설정 없이도 초안을 저장할 수 있다고 적혀 있다. |  |
| 23 | S1R / S1R-05 | USER | click: 대화로 돌아가기  | 없음 |  |
| 24 | S3 / S3-F007 | PRODUCT_AGENT | read_source: {"sourceId":"B","range":"전체 파일"} | — | AGENT_ACTION |
| 25 | S1R / S1R-06 | USER | click: 이어서 설정  | 없음 |  |
| 26 | S1R / S1R-07 | USER | done: 저장된 비활성 초안  | 편함. Chat에서 돌아와 입력 내용이 보존된 것을 확인했다. | DONE |
| 27 | S3 / S3-F008 | PRODUCT_AGENT | ask_user: {"text":"budget.csv가 암호화되어 전체 내용을 읽을 수 없어 월별 실적·예산 차이를 계산할 수 없습니다. 비밀번호는 대화에 보내지 말고 사용자용 ‘비밀번호 입력’ 기능을 이용하거나, 읽을 수 있는 원본으로 교체해 주세요. ‘이 자료 제외’를 선택하시면 예산 비교 없이 actuals.csv의 실적만 정리할 수 있습니다. 어떻게 진행할까요?","sourceId":"B"} | — | USER_ACTION |
| 28 | S3 / S3-F009 | USER | click: budget.csv 복구 영역의 [비밀번호 입력]  | 불편: 예산 파일을 읽지 못해 비교를 바로 확인할 수 없다. | USER_ACTION |
| 29 | S3 / S3-F010 | USER | question: budget.csv 비밀번호 입력 창 이 파일을 열 때 사용할 모의 비밀번호가 무엇인가요? | 헷갈림: 모의 비밀번호를 받은 적이 없어 무엇을 입력해야 할지 모르겠다. | SOURCE_GAP |
| 30 | S3b / S3b-F012 | USER | type: budget.csv 비밀번호 입력란 [가상 비밀번호 비공개] | 없음 | USER_ACTION |
| 31 | S6 / S6-0 | USER | click: 자료 검토 A의 저장  | 없음 | SAVE_PREVIEW |
| 32 | S6 / S6-1 | USER | click: 업데이트  | 불편. 현재 구성을 저장하려고 눌렀는데 확인 화면에서 한 번 더 눌러야 한다. | A_SAVED |
| 33 | S6 / S6-2 | USER | click: 자료 검토 A의 닫기  | 없음 | CLOSE_PREVIEW |
| 34 | S3b / S3b-F013 | USER | click: 비밀번호 입력 창의 [계속]  | 없음 | AGENT_ACTION |
| 35 | S6 / S6-3 | USER | click: 실행 1개 종료하고 닫기  | 편함. 닫을 때 종료되는 실행과 남는 실행을 확인할 수 있다. | A_CLOSED |
| 36 | S6 / S6-4 | USER | click: Sidebar의 자료 검토 A r8·닫힘  | 없음 | A_CLOSED |
| 37 | S7-LOCAL / S7-LOCAL-0 | USER | click: 새 사본  | 없음 | BUNDLE_PREVIEW |
| 38 | S3b / S3b-F014 | PRODUCT_AGENT | read_source: {"sourceId":"B","range":"전체 파일"} | — | AGENT_ACTION |
| 39 | S7-LOCAL / S7-LOCAL-1 | USER | click: 가져오기 실행  | 없음 | IMPORTED |
| 40 | S7-LOCAL / S7-LOCAL-2 | USER | click: 필요한 자원 연결  | 없음 | RESOURCE_CONNECT |
| 41 | S7-LOCAL / S7-LOCAL-3 | USER | click: 파일 다시 연결  | 불편. 필요한 자원 연결을 눌렀는데 파일 선택까지 한 번 더 눌러야 한다. | NATIVE_PICKER_GAP |
| 42 | S7-LOCAL / S7-LOCAL-4 | USER | click: 검토자료.txt — 현재 r2  | 없음 | NATIVE_PICKER_GAP |
| 43 | S3b / S3b-F015 | PRODUCT_AGENT | publish_answer: {"chatText":"1~3월 실적과 예산은 합계가 각각 320만원으로 같습니다. 월별로는 1월 차이 없음, 2월 +10만원, 3월 -10만원입니다. 차이는 ‘실적−예산’으로 계산했습니다. 첨부 자료만으로는 금액이 매출인지 비용인지 알 수 없어 유불리는 판단하지 않았습니다. 아래 비교표와 요약에서 근거 파일·범위를 확인할 수 있습니다. (근거: actuals.csv [A, revision 1, 1–4행], budget.csv [B, revision 1, 1–4행])","canvasItems":[{"text":"월별 실적·예산 비교\n단위: 만원 · 차이 = 실적−예산 · 차이율 = 차이÷예산×100\n\n\| 월 \| 실적 \| 예산 \| 차이 \| 차이율 \|\n\|---\|---:\|---:\|---:\|---:\|\n\| 1월 \| 100 \| 100 \| 0 \| 0% \|\n\| 2월 \| 130 \| 120 \| +10 \| +8.3% \|\n\| 3월 \| 90 \| 100 \| -10 \| -10.0% \|\n\| 합계 \| 320 \| 320 \| 0 \| 0% \|\n\n차이율은 소수점 첫째 자리로 반올림했습니다.\n근거 파일: actuals.csv와 budget.csv, 각각 revision 1의 1–4행.","evidence":[{"sourceId":"A","revision":1,"range":"1–4행"},{"sourceId":"B","revision":1,"range":"1–4행"}]},{"text":"주요 내용\n\n- 1월은 실적과 예산이 모두 100만원으로 일치합니다.\n- 2월 실적은 예산보다 10만원 높고, 3월은 10만원 낮아 합계에서는 상쇄됩니다.\n- 월별 절대 차이는 2월과 3월이 각각 10만원으로 같지만, 예산 대비 차이의 크기는 3월 10.0%가 2월 8.3%보다 큽니다.\n- 파일에는 월과 금액만 있어 차이의 원인이나 매출·비용 여부는 확인할 수 없습니다.\n\n근거 파일: actuals.csv와 budget.csv, 각각 revision 1의 1–4행.","evidence":[{"sourceId":"A","revision":1,"range":"1–4행"},{"sourceId":"B","revision":1,"range":"1–4행"}]}]} | — | USER_ACTION |
| 44 | S7-LOCAL / S7-LOCAL-5 | USER | click: 열기  | 없음 | CONNECTION_COMPARE |
| 45 | S7-LOCAL / S7-LOCAL-6 | USER | click: 연결  | 편함. 연결할 현재 파일과 보존할 당시 자료가 구분되어 있다. | SNAPSHOT_ONLY |
| 46 | S7-LOCAL / S7-LOCAL-7 | USER | done: 가져온 Agenda의 Snapshot s1과 현재 원본 r2  | 편함. 당시 자료가 바뀌지 않고 현재 원본과 따로 남아 있다. | SNAPSHOT_ONLY |
| 47 | S3b / S3b-F016 | USER | click: Browser 바  | 없음 | USER_ACTION |
| 48 | S3b / S3b-F017 | USER | click: Canvas의 [전체 보기]  | 불편: Browser를 눌러도 내용이 안 보여 다른 View를 살펴보려면 화면을 더 조정해야 한다. | SOURCE_GAP |

</details>

S1의 처음 입력 두 건은 대상 필드 입력으로 전달돼 필드 이동의 물리 클릭 횟수를 확정할 수 없다. S1R에서는 포커스 이동과 입력을 분리했다. 위 전사 시점의 S6 제목 매칭 실패는 이후 해소했으며 같은 클릭을 재요구하지 않았다. S3의 비밀번호·전체 배치 누락은 시험 조건 준비 부족으로 분류하고 회차를 나눠 보완했다. 원래 조건에서 완주한 것으로 소급하지 않는다.

후속에는 모형의 진단 표기·약어를 사람 화면에 옮긴 문제, 참가자 관점 전환 때 개시자의 화면을 초기화한 문제, 저장 전이 누락, 병렬 회차의 요약 상태 갱신 경합도 발견해 수정했다. 이들은 제품 런타임 결함으로 세지 않는다. S2-PAN에서는 사용자의 목적 달성 뒤 모형이 추가 검사를 요구해 생긴 혼란을 제품 불편과 분리한다. 처음 Main이 600px 합계를 700px로 잘못 말한 부분도 철회했으며, 실제 보완 대상은 작성기 확장 시의 공간 부족이었다.

<a id="coverage"></a>
## 범위와 남은 일

사용자 요청에 따라 추가 설계·시뮬레이션을 중단한 체크포인트다. 제품 정책 16개는 기존 사용자 확인 원장에서만 관리하며 이번 작업으로 승인하지 않았다.

- 후속 전체 교환의 전사와 trace별 실제 도달·조건부 분기 커버리지 대조가 남았다.
- 마지막 수정본의 독립 최종 재검토와 검토 지문 갱신이 남았다. Q-VIEW-04/08의 `SPECIFIED`를 임의로 닫지 않았다.
- 프로그램 실행, 실제 렌더링·사용성·접근성·외부 서비스 동작 검증은 이 작업에서 수행하지 않았다.
- 사용자 결정만 남았다거나 시뮬레이션상 완벽해졌다는 완료 판정은 하지 않는다.

<a id="review"></a>
## 독립 검토

1차 독립 문서 검토 `01a08b1a-d90e-7431-bdf5-ab87beb93f0c`는 Atlas 43개 trace와 UX·기술 상세를 대조했다. 공유 위임의 초안/실행 시점, Memo의 업무 귀속, 지식 후보 재진입, 첨부 열람/편집, 최종 승인 버튼, 늦은 저장 확인, 검토 배치 치수의 모순을 반환했고 해당 문구를 수정했다.

그 뒤 추가 보완까지 포함한 **최종 재검토는 아직 하지 않았다.** 기존의 정합성 검사 PASS·과거 175개 Q 검토 기록을 최신 전체 리허설 완료의 근거로 사용하지 않는다.
