# 사람과 공용 Board 사용하기

**현재 코드:** Firefox용 EG-Desk 안의 Board 목록, Board 영역, 독립 Window shell과 연결된 텍스트 카드 협업. HTML 시안이나 로컬 Agent 방 초대가 아니다. 참가자마다 Firefox, 카메라, 창 위치, 로그인은 따로다. 서버가 받은 사람별로 보낼 보드와 카드를 다시 만든다.

## 처음부터 다시 들어오기까지

1. **Desk → Board 목록 → 사람과 공유**에서 협업 서비스 주소와 운영자가 별도로 준 개인 계정 키를 넣는다. Firefox 창의 메모리에만 둔다. 사이트 쿠키, SSO나 Agent 로그인은 필요하지 않다. **공용 Board 함께 만들기**에서 이름과 상대의 계정 ID를 입력한다. 개인 Board 메뉴의 **공용 Board 제안…**은 새 Board 제안이며, 원본이나 배치를 옮기는 기능이 아니다.
2. 상대가 **받은 초대 → 수락하고 열기**를 누르면 두 개설자가 같은 Board 하나에 참여한다. 둘 중 한 명이 제안만 하면 보드는 아직 없다. 이후에는 왼쪽 Board 목록에서 같은 보드를 연다. 지역에 붙은 Board 이름과 카드별 제목은 독립적이다.
3. **Board 작업 → 카드·사람 관리 → 카드 추가**에서 전표·메모·텍스트 발췌를 여러 장 추가한다. 개인 메모 본문을 선택해 가져올 수도 있다. **추가 시 제목·본문이 협업 서버에 업로드된다.** 다른 참가자에게는 자동으로 공개되지 않는다. 원본 파일·브라우저·실행 권한은 복사되지 않는다.
4. 카드의 **공개·회신 관리 → 공개할 사람 선택 → 보내기 전 확인**에서 수신자와 내용을 확인한다. 이미 참가한 사람에게 보드 안에서 공개하거나, 보드 밖의 사람에게 카드 한 장만 제안한다. 단독 초대를 수락하기 전에는 초대 표제·보낸 사람·기한만, 수락한 뒤에는 지정된 카드만 보인다. 부모 보드 이름·ID·배치·인원·이웃 카드는 단독 응답에 없다. 원문이 바뀌면 미수락 초대는 다시 보내야 한다.
5. 수신자는 **이 일 맡기 → 회신 쪽지 열기**에서 따로 작성한다. 초안이나 **회신 내용 확인**은 전송이 아니다. **이 사람에게 회신**을 눌러야 원 제공자가 결과를 본다. 보드 전체·Agent 방에는 게시하지 않는다. 초안은 메모리 전용이며 연결을 잃으면 버릴 수 있다. 개인 수첩은 기존 메모 창을 쓴다.
6. 카드를 끌면 내 위치가 바뀐다. 원 제공자가 **현재 위치를 공용 배치로 제안… → 확인하고 적용**을 눌러야 서버에 그 카드의 위치가 반영된다. 기존 개인 배치는 덮지 않는다. 좌표 변경이 원문 버전이나 이미 보낸 회신을 무효화하지 않는다. 화면을 닫아도 탈퇴하지 않는다. 다시 인증해 왼쪽 목록에서 열면 **현재 접근 가능한** 자료만 받는다.
7. **공개 회수**는 서버가 즉시 집행한다. 연결된 수신 창은 권한 응답을 다시 받으면 열린 카드·회신 편집기·행을 내린다. 클라이언트는 약 3초마다 확인하며, 네트워크 요청은 7초 후 타임아웃한다. 단절/오류 확인 시 공유 화면을 닫고 재검사한다. 오프라인 화면을 원격에서 즉시 지웠다고 하지는 않는다. 검색 재조회와 재시작이 접근권을 되살리지 않는다. 이미 본 내용·복사본·명시적으로 보낸 답은 지워졌다고 표시하지 않는다.

## 운영자 실행

필수: Node에서 `node:sqlite`를 사용할 수 있어야 한다(검증: Node 26.5). 아래 명령은 이 체크아웃의 `apps/firefox-ui-demo` 디렉터리 기준이다. 실제 서비스를 대신 개설하거나 계정을 발행한 것이 아니다.

```sh
DATA="$HOME/.egdesk-joint-demo"
(umask 077 && mkdir -p "$DATA")
node helper/egdesk-joint-board-server.mjs issue "$DATA" seoyun '서윤' "$DATA/seoyun.new-key"
node helper/egdesk-joint-board-server.mjs issue "$DATA" minjae '민재' "$DATA/minjae.new-key"
node helper/egdesk-joint-board-server.mjs serve "$DATA" 47631
```

기본 주소는 `http://127.0.0.1:47631`이며 **다른 PC는 이 주소로 연결할 수 없다**. 발급 명령은 키를 터미널에 출력하지 않고 새 0600 파일에 기록한다. 키 파일은 안전한 별도 경로로 해당 사람에게만 전달하고 관리한다. 재발급은 `rotate`와 새로운 출력 파일을 쓴다. DB에는 키 해시와 업무 자료가 저장된다. 업무 자료는 DB 안에서 암호화되지 않으므로 데이터 폴더·디스크·백업은 운영자의 보호 대상이다.

서로 다른 기기에서 쓸 때는 운영자가 DNS, 도달 가능한 네트워크, 참가자 Firefox가 신뢰하는 인증서/키를 준비한 뒤 TLS 모드를 명시한다. 예시는 `board.example.org`를 실제 주소로 바꿔야 한다. 참가자에게 HTTP 평문 주소나 인증서 경고 무시를 안내하지 않는다.

```sh
node helper/egdesk-joint-board-server.mjs serve-tls "$DATA" \
  'https://board.example.org:8443' '0.0.0.0' '/absolute/fullchain.pem' '/absolute/key.pem'
```

발급/회전은 로컬 CLI만 가능하다. HTTP에는 `GET /v1/joint/view`, `POST /v1/joint/action` 두 경로만 있다. 쓰기는 계정별 요청 ID, 유효 참여·수신권·내용 버전을 검사하고 트랜잭션으로 처리한다. 키 자동 동기화·자동 등록은 없다. 기본 릴리스 설치기에 이 서비스를 끼워 넣거나 상시 실행시키지 않는다.

## 구현 결정과 한계

- 이 MVP에서는 두 개설자가 가입·일반 멤버 제외를 처리한다. 제공자가 자신의 카드와 공개 대상을 관리한다. 탈퇴하면 자신의 카드와 거기에 의존한 권한은 더 이상 열 수 없다. 다른 제공자의 자료는 자기 조건을 따른다. 마지막 개설자 이탈은 거부한다. 팀 소유권 이전·폐쇄·법적 보존·DB 영구 삭제는 확정하지 않았다.
- 서비스 상태와 Desk 세션은 별개다. 개인 Firefox에는 권한별 배치 수치·불투명 식별자만 별도 보관하며, 권한 목록 확인 뒤 지난 배치를 정리한다. 일반 Desk 복구 저장본에는 공용 원문·보드 제목·회신·키를 넣지 않는다. 이 구현은 OS 관리자, 사진·스크린샷이나 과거 수신자의 수동 복사를 통제하지 않는다.
- 실시간 스트리밍이 아니라 권한별 최신 상태 재조회다. 충돌은 자동 병합하지 않는다. 오류 후 상태를 확인하고 사용자가 다시 선택한다. 개인 업무 사이트, 라이브 Browser 공유/원격 입력, Agent 위임, 미니앱 설치, 종단간 암호화, 장치별 영수증, 오프라인 공동 편집은 이 기능이 아니다.
- 검증: `node --test helper/egdesk-joint-board.test.mjs helper/egdesk-board-presentation-plan.test.mjs` 및 `scripts/verify-firefox-mcp-board-two-profiles.mjs`. 후자는 신규 표시된 헤드리스 Firefox 프로필 2개·합성 사용자 3명·로컬 SQLite 서비스로 실제 chrome을 사용한다. 기존 프로필을 받지 않는다. `TMPDIR`와 그 아래 비어 있는 합성 `HOME`, `EGDESK_FIREFOX_BIN`, 6개 파일 전용 `EGDESK_QA_LOADER_SOURCE`, 설치된 Firefox MCP/Geckodriver가 필요하다. 기본 helper는 로컬 거부 응답 fixture로 격리하며 외부 모델은 쓰지 않는다. 검증 결과는 운영망·실조직 보안 인증이 아니다.

소스: [권한·상태](../helper/egdesk-joint-board-store.mjs), [운영자/HTTP/TLS](../helper/egdesk-joint-board-server.mjs), [수신 검증·세션 필터](../overlay/resources/EGDeskJointBoardClient.sys.mjs), [Firefox UI](../overlay/resources/EGDeskJointBoardView.sys.mjs). [확장 설계와 미해결 인수 사례](./BOARD_COLLABORATION_AND_CROSS_AGENT_DESIGN.md#collab-checks).
