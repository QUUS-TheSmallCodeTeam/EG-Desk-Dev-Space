# Desk 밖 조작 보기 (CU-01 · CU-02 · CU-05)

설정 → 계정 → '컴퓨터 조작' 아래 [Desk 밖 조작 보기]를 누르면 Canvas에 'Desk 밖 조작' 창이 열립니다(한 번에 하나, Desk 저장에는 넣지 않음).

## 보이는 것
- 지금 조작: EG-Desk Agent / Codex 컴퓨터 조작 / 사람 / 없음
- 대상 앱: 앞 앱 이름·bundle id·pid
- 입력권(lease) 상태와 차례(epoch), 입력 게이트 열림/닫힘과 이유, 관찰 도우미 상태
- 기록: 앞 앱 변화, OpenAI 조작 서비스, Codex 조작 횟수, 입력권 변화·양보·중지, 게이트, Agent 동작 영수증
- 화면·창 제목·입력 글자·좌표는 받지도 보여 주지도 않음

## 버튼
- 일시중지 · 내가 쓰기: `lease.takeOver()` — Agent 동작을 멈추고 사람에게 넘김(돌려줄 때까지)
- 이 앱만 중지: `lease.stopApp(target)`
- 모두 중지: 게이트를 닫고 `lease.stopAll()` (차례 번호 없이 언제나 가능)
- Agent에게 돌려주기: 화면이 본 입력권 차례와 게이트 차례가 지금과 같을 때만 `handBack` + 게이트 다시 열기

## 브리지
- `GET /host/activity?sinceAt=&limit=` (처음 부를 때 관찰 전용 도우미 시작)
- `POST /host/control {action: pause|stop|stopApp|handBack|emergencyStop, epoch?, gateEpoch?, target?}`
- SSE `host.activity {row}`, `host.control {control}`
- 코드: `helper/egdesk-host-control.mjs`, `helper/egdesk-host-input-gate.mjs`, `overlay/resources/EGDeskHostActivityView.sys.mjs`

## 입력 게이트 (CU-05, 순수 상태 기계)
닫힌 채 시작. 감시 신호(1.5초) 없음·늦음·순번 역행, 모르는 입력권 상태, 중지 요청, Ctrl+Alt+Shift+. 는 게이트를 닫고 차례를 올림. 다시 열기는 지금 차례 번호 + 새 신호 + 아는 상태가 있어야 하며, 열 때 새 차례를 발급해 이전 표는 다시 통과하지 못함. 실제 전역 단축키와 별도 감시 프로세스는 입력 모니터링 권한이 필요해 아직 없음. 지금은 관찰 도우미의 살아 있음 신호가 감시 신호를 대신함.
