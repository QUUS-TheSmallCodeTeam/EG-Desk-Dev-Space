# EG-Desk 비전 Gap 원장

**기준일**: 2026-10-25 (최초 조사 코드 기준 `bebe45c`, 상태 표 집계는 `5760981`까지. 그 이후 연결·검증은 아래 2026-10-25 체크포인트에 기록. 작업 브랜치 `claude/vision-gap-20261024`)

**정본 백로그**: [EGDESK_PRODUCT_VISION_AND_DEV_TODO.md](./EGDESK_PRODUCT_VISION_AND_DEV_TODO.md)  
**범위**: 비전 문서의 미체크 항목 + 2026-10-24 대표님 추가 목표(기능·UI/UX·디자인 전부, Codex+Claude 구독 지원, 브라우저 제어, 컴퓨터 사용, Agent 캐릭터 설정)

총 95개 항목 — 없음 12 · 일부 52 · 완료 31 · 미확인 0 (아래 영역 표의 상태 열을 2026-10-24 `5760981`까지의 진행 기록 반영 뒤 다시 센 값. `d7aac51` 기준은 없음 17 · 일부 47 · 완료 31. 그 뒤 CHAT-03·CHAT-10·CU-01·CU-03·CODE-02가 helper·모듈만으로 없음 → 일부가 됐고, 완료로 바뀐 항목은 없다. 최초 조사 때는 없음 45 · 일부 47 · 완료 2 · 미확인 1).
상태는 처음에 코드·git 기록과 대조해 판별했다(읽기 전용 조사, 테스트·Firefox 미실행). 그 뒤 바뀐 것은 진행 기록에 근거를 남겼다. 체크박스가 아니라 이 원장의 상태 열이 현재 판단이다. '일부(helper·모듈)'는 helper나 순수 모듈만 있고 화면 연결 전이라는 뜻이다.

## 진행 기록

| 날짜 | 항목 | 상태 변화 | 근거 |
|---|---|---|---|
| 2026-10-24 | CHAT-12 Agent 질문 응답 | 없음 → 완료 | `2480174`. helper 단위(질문 수신·답변·건너뛰기·비밀 답 미저장·같은 run 이어가기) + 중앙 회귀 596/598(skip 2는 BRW 화면 연결 대기) + headless 렌더링 fixture 72/72 중 질문 구간 17건 통과(`63a7592`). 실제 Codex 계정·모델로는 미실행 |
| 2026-10-24 | CHAT-13 하위 Agent 진행·막힘 | 없음 → 완료 | `2480174`. 같은 검증 + headless 렌더링 fixture 하위 Agent 구간 10건 통과. 실제 multi-agent 실행은 미실행 |
| 2026-10-24 | AGENT-01 Profile 저장소 | 없음 → 일부(핵심부) | `cfa2344`. 저장소·HTTP·캐릭터 필드·합성 함수 + 단위 14건. 브리지·화면 연결은 3묶음 진행 중 |
| 2026-10-24 | SUB-03 요금제·사용 한도, SUB-14 오류 분류 | 없음 → 일부(핵심부) | `cfa2344`. 정규화·표시·오류 kind 단위 31건. 브리지·화면 연결은 3묶음 진행 중 |
| 2026-10-24 | BRW-05 navigate(같은 사이트), BRW-06 scroll·press·wait | 일부/없음 → 일부(핵심부) | `cfa2344`. guarded 도구 단위 128건 통과. 카탈로그·화면 연결은 3묶음 진행 중 |
| 2026-10-24 | (발견) 요청 재확인 버튼이 방을 풀지 못함 | 버그 수정 | `5728cd0`. headless fixture 흐름에서 발견, probe 전후 비교로 확인 |
| 2026-10-24 | (검증 기반) headless 렌더링 fixture 흐름 | 실행 불가 → 72/72 | `63a7592`. 기존 250개 headless UI 회귀도 250/250(조작 26, skip 0) 재확인 |
| 2026-10-24 | AGENT-07 설정 카드 가짜 데이터, SUB-05 계정 탭 | 일부 → 완료/일부 | `ce20398`. 가짜 계정·모델·Agent 상수 제거, 실제 ChatGPT 로그인·요금제·사용 한도 표시. Claude는 결정 대기 한 줄(SUB-05는 Claude 연결 전까지 일부) |
| 2026-10-24 | AGENT-01/03 Profile 저장소·실행 적용, CHAT-02/AGENT-02 편집·만들기 | → 완료/일부 | `cfa2344`·`ce20398`. 저장소 mount, profileId→developerInstructions 합성·Run binding 기록, Agent 관리 탭(만들기·초안·활성화·버전 비교·되돌리기). 'Agent 사용 준비' 점검표·이미지 아바타 미구현 |
| 2026-10-24 | SUB-03 사용 한도, SUB-14 오류 kind | → 완료/일부 | `ce20398`. 로그인·turn 뒤 rateLimits 읽기, Chat 머리 사용률 링, 오류 kind별 안내. Claude 쪽 분류는 엔진 연결 후 |
| 2026-10-24 | BRW-05/06 브라우저 도구 | → 일부/완료 | `ce20398`. 조작 허용 카드에 navigate(같은 사이트)·scroll·press·wait 제공. navigate 허용 범위는 결정 대기 |
| 2026-10-24 | CNV-04 도형, CNV-01 Board 영역, UX-01 보이는 Board, UX-03 용어 | → 완료 | `163a60e`. headless UI 회귀 274/274, fixture 72/72. Firefox 실제 창 시각 확인은 별도 |
| 2026-10-24 | DSN-02 팔레트, DSN-04 동작 줄이기 | → 일부 | `163a60e`. 남은 파란 그림자·분류 배지·글자 확대는 5묶음에서 진행 |
| 2026-10-24 | RT-05 브리지 재연결 | → 일부 | `1143240`·`163a60e`. backoff·재시작 감시·bridge build·상태 문구. overlay 기대 빌드 표식 작성·읽기 미연결 |
| 2026-10-24 | SUB-06 실행 엔진 계층 | → 일부(1~6단계) | `8b406b4`. 어댑터·엔진 기록·registry·스키마 v2·엔진별 연결. 7단계(화면)는 5묶음, 8단계(Claude)는 결정 대기 |
| 2026-10-24 | CODE-01 코딩 화면 조사 | → 완료 | `620cec0`. CodeMirror 6 권고. 설치 허락·계약 문서 편집기 기준 변경 결정 대기 |
| 2026-10-24 | CNV-02 배치 정책, UX-02 미니맵 Board 영역 | → 완료/일부 | `dca10a3`. 모든 새 View가 보이는 빈자리에 열림, 미니맵 Board 영역·겹침 목록. UX-02의 목록 검색·Briefing 마커는 남음 |
| 2026-10-24 | DSN-01 다크 테마, DSN-04 글자 확대·동작 줄이기 | → 완료 | `dca10a3`·`135a97e`. headless 다크 UI 회귀 274/274, 스크린샷 시각 확인. 다크 아바타 2종 대비 2.9~3.4:1은 남음 |
| 2026-10-24 | BRW-08 iframe·shadow DOM·contenteditable·긴 값 | → 일부 | `5c3b7e4`. 단위·transport 148/149. 실제 Firefox 페이지로는 미검증 |
| 2026-10-24 | CHAT-09 일회성·분기 대화와 배지 | → 완료 | `6126e93`·`135a97e`. 실제 Codex thread/fork·ephemeral 왕복은 미실행 |
| 2026-10-24 | CU-07 물려받은 MCP 가시화 | → 일부 | `6126e93`·`135a97e`. 이름·상태·종류 표시. 차단 정책은 결정 대기 |
| 2026-10-24 | RT-05 브리지 재연결·버전 감지 | → 완료 | `1143240`·`6126e93`·`135a97e`. backoff·재시작 감시·상태 문구·기대 빌드 표식과 불일치 안내 |
| 2026-10-24 | SUB-06/07 엔진·모델 선택 | → 일부 | `8b406b4`·`dca10a3`·`4c19a24`. 엔진 칩, 대화별 엔진 잠금, 실제 Codex 모델 목록(7개 실측)·모델별 추론 강도 검증. 모델 선택 화면 연결은 7묶음 진행 중 |
| 2026-10-24 | RT-06 이벤트 버스, CHAT-06 작업 그래프·대기 조건, BRW-04 OAuth 완료 조건 | → 완료/일부/일부 | `358cc94`. 가짜 OAuth 서버로 조건 해제→자동 시작 확인. 화면(작업 목록)은 7묶음, Agent 계획 제안·같은 쓰레드 재개는 진행 중 |
| 2026-10-24 | SUB-09 Claude 엔진(8a 번역) | → 일부 | `a605dd1`. 공식 문서 예시 기반 번역 18/18. 실제 claude 실행·프로세스 연결은 Claude 연결 방식 결정 뒤 |
| 2026-10-24 | SUB-07 모델·추론 강도 선택 | → 완료 | `4c19a24`·`7e58321`. 실제 Codex 모델 7개(실측)·모델별 강도, 거절 처리 |
| 2026-10-24 | CHAT-06 작업 그래프·Await 화면, Agent 계획 제안·승인 | → 완료 | `358cc94`·`db5deff`·`7e58321`·`df7a061`. 계획 승인 카드, 작업 승인, 재시작 후 이어가기, 같은 대화 재개, 조건 만료. 실제 Codex 왕복은 미실행 |
| 2026-10-24 | BRW-13 Browser 카드 Agent 활동·일시중지 | → 완료 | `df7a061`. 배지·타임라인(입력값 비노출)·일시중지 시 권한 회수·돌려주기는 권한 자동 부여 없음 |
| 2026-10-24 | AGENT-04 도구 권한 상한, AGENT-02/CHAT-02 편집·점검표, CHAT-07 프로필 미리보기, AGENT-05 작업 중 버블 | → 완료/일부 | `a0b6ea2`·`9ce901c`·`18e8d7e`. 상한은 실제 Codex 일회성 쓰레드로 설정 수용·컴퓨터 조작 플러그인 차단 확인. AGENT-05의 Browser 카드 Agent 배지 외 부분은 남음 |
| 2026-10-24 | CU-06 Codex 컴퓨터 조작 조사, CU-07 가시화·끄기 스위치 | → 완료/일부 | `4947219`·`7ddb434`. 일반 대화가 Codex 컴퓨터 조작 플러그인을 물려받음을 실측. 끄기 스위치(기본 inherit)와 readback 확인. 기본값은 대표님 결정 대기 |
| 2026-10-24 | CTX-03 맥락 후보 해석기 | → 일부 | `b6b48b9`. 제안만·동의 필요·계정 범위 제외·원문 없는 기록. 화면 연결 남음 |
| 2026-10-24 | CHAT-04 답변을 Canvas 카드로, CHAT-08 긴 답변 접기, CU-07 컴퓨터 조작 스위치·배지 (누락 보충) | 없음 → 완료 / 일부 유지 / 일부 유지 | `8dc695d`. 끝난 답변의 '카드로 보기'가 Canvas 결과 카드로 남긴다(출처 줄, '채팅에서 보기'로 원래 답변까지 스크롤·강조, 열린 카드 재사용, Desk·Board와 함께 저장). 아주 긴 답변은 Chat에서 접히고 '카드로 펼치기'/'여기서 모두 보기'(본문을 자르지 않고 Canvas로 저절로 옮기지 않음). 설정에 브리지가 보고한 컴퓨터 조작 상태('켜 둠 · 내 Codex 설정 그대로')와 'EG-Desk 대화에서는 끔' 스위치·readback, 활동 행 MCP 호출 배지(컴퓨터 조작/브라우저 제어/코드 실행, 인자 비노출). 화면 시험 543/543, 렌더링 fixture 72/72, headless 다크 UI 회귀 274/274. 결과 카드 저장 방식(D-K3)은 미결정. 실제 Firefox 창 미검증 |
| 2026-10-24 | CU-07 컴퓨터 조작 선택 유지, AGENT-04 QA 셸 끔 확인 (누락 보충) | 일부 유지 / 완료 유지 | `a7c66cc`. 컴퓨터 조작 선택(computerControlPolicy)을 비공개 설정 파일(0600, 원자적 교체, 깨진 파일은 옆에 보관, 더 새 버전은 손대지 않음)에 저장해 브리지를 다시 켜도 유지. 저장에 실패해도 정책은 적용하고 /v1/state·응답·SSE에 persisted:false. terminal none 상한 QA 대화는 turn 전에 shell_tool=false를 다시 읽어 확인. helper 744/752(skip 8) |
| 2026-10-24 | CU-07 컴퓨터 조작 사용 기록(결정 Q1 (다) 후속) | 일부 → 일부(helper) | `0387f73`. Codex 컴퓨터 조작 호출마다 크기만 기록(인자 바이트·결과 이미지 수·결과 글자 바이트, 내용 없음), run별 `computerUse`(호출 수·마지막 시각·서버·진행 중), 바뀔 때마다 'computer.used' 이벤트, run.started에 컴퓨터 조작 정책 기록, 활동 행 제목 '컴퓨터 조작 · {도구}'. helper 단위 codex-computer-control 17/17. 화면 연결은 진행 중. 실제 모델 왕복은 미검증 |
| 2026-10-24 | RT-03 .egdesk 내보내기·가져오기 | 일부 → 일부(helper HTTP) | `2f9b030`. 브리지에 내보내기·미리보기·가져오기·목록 HTTP(`/v1/portable/export·inspect·import`, `GET /v1/portable/exports`). Desk 또는 Board 묶음, 암호 선택, 대화·Profile은 기본 제외, 비밀값·계정 식별자 제외, `~/Downloads/EG-Desk`에 덮어쓰지 않고 저장, 파일 전체를 확인한 뒤 새 사본으로만 가져옴(겹치는 id는 참조와 함께 새 id). helper 테스트 754/762(실패 0), 그중 portable HTTP 10/10. 화면(내보내기·가져오기 패널) 연결은 진행 중. 실제 Firefox 창에서는 미검증 |
| 2026-10-24 | CTX-03 맥락 후보, CTX-04 볼 자료와 고른 이유 | 일부 → 일부(화면 연결) | `0943557`(해석기 `b6b48b9` 위). Chat 입력칸에 들어가면 화면 신호로 후보를 물어 입력 트레이 위에 '이것도 붙일까요?'를 띄움. 고른 것만 붙음(로그인된 페이지는 따로 확인, 다른 계정은 흐리게 제외). 보낼 때 해석 결과가 함께 가고, 활동 기록에 Agent가 볼 자료와 고른 이유가 남음. 중앙 회귀 771/771, headless UI 회귀 274/274. headless 대화 흐름은 첫 화면 회귀로 실패 → 수정 진행 중. 실제 Firefox 창·실제 모델로는 미검증 |
| 2026-10-24 | CTX-01 Board 버전·충돌, CTX-02 복구 기록, RT-07 Desk 저장소 | 일부 → 일부(저장소·화면 연결) | `35f772c`(로컬 SQLite 저장소, helper 720/728) 위에 `0943557`(화면). 브리지에 저장소가 있으면 기존 prefs를 한 번 가져오고(prefs는 남김), 자동 저장·Board 저장이 저장소에도 감. 복구 기록 패널에서 시점을 미리 보고 되돌리거나 합침. Board 메뉴에 버전 기록·되돌리기, 저장 충돌 시 덮어쓰지 않고 물어봄. 검증은 위 행과 같음(headless 대화 흐름 실패 → 수정 중). 보존 개수·기간은 임시값(결정 대기). 실제 Firefox 창·비정상 종료 복구는 미검증 |
| 2026-10-24 | (검증 기반) helper 테스트 정리 경합 | 간헐 실패 수정 | `d6dc3f5`. task-native 시험이 불확실 기록 저장이 끝나기 전에 임시 폴더를 지워 드물게 ENOTEMPTY로 실패하던 것을 고침. 제품 변경 없음 |
| 2026-10-24 | (문서) REA 구현 메커니즘 채택안, BRW-10 원인 정정 | 문서 추가·정정 | `6a07111`. [rea-mechanism-adoption.md](../../docs/references/rea-mechanism-adoption.md): REA 브라우저 조작(웹1~10)·Mac 조작(맥1~11) 방식을 Firefox·macOS 공개 API로 옮기는 안, 구현 묶음 가~차, 대표님 결정 12건. 소스 읽기 조사만이고 Firefox·Mac에서 실행 확인한 항목은 0개. 이 문서 2장에 따라 BRW-10 원인을 '포인터 순서·좌표 없음'으로 정정하고, BRW-09/10/12/13·CU-01~05에 해당 줄 링크 |
| 2026-10-24 | BRW-12 시간 초과 뒤 판정·같은 시계 기록, BRW-05 이동 직후 관찰 (REA 묶음 가) | 일부 유지 / 일부 유지 | `4c156f1`(helper: 표면·actor 거절의 dispatchPhase가 'not-dispatched'로 확실할 때만 카드를 잠그지 않음, 'dispatched'·'unknown'·빈 값은 계속 잠가 결과 미확정 동작을 반복하지 않음. 요청마다 run 안 순번·보낸 시각, 시간 초과 시각 기록) + `b3ae83e`(화면: 보류·중지·취소·크기 초과·권한 없음 등 거절은 'not-dispatched'로 돌려줌, 관찰·guard에 Gecko 문서 번호(innerWindowId·browsingContextId) 대조와 doc.isActive() 검사, 주소 이동 뒤 새 문서에서 관찰·대기 1회 재시도, 조작은 재시도 안 함, 응답에 시각 기록). 소유 headless browser-negative 통과(크기 초과 fill이 not-dispatched 뒤 같은 run에서 회복, 이동 뒤 관찰 재시도 충족), 대화 흐름 72/72, UI 회귀 274/274. 실제 외부 사이트·실제 모델 미검증 |
| 2026-10-24 | CU-07 컴퓨터 조작 사용 표시, RT-03 .egdesk 내보내기·가져오기, CTX-03/04 첫 화면 클릭 회귀 | 일부 유지(화면 연결) / 일부 유지(화면 연결) / 회귀 수정 | `9dbfa51`. 호출 중 '[···] 컴퓨터 조작 중', 답변 아래 호출 수 줄(누르면 활동 행으로 이동), 활동 행은 크기만, 활동 머리에 run 정책. Desk 메뉴·Board 메뉴에 .egdesk 내보내기·가져오기(브리지가 지원할 때만 보임, 암호 선택과 잠금 없음 경고, 미리보기·잠금 해제, Desk 교체 경고, 새 사본으로 가져오기). 맥락 후보 답이 화면을 바꿀 때만 Chat을 다시 그려, 첫 화면 뒤로 가기 클릭이 사라지던 회귀를 고침. 중앙 515/515, headless 대화 흐름 72/72, UI 회귀 274/274, 렌더 probe 21/21. 실제 브리지 Desk 저장소가 있는 Firefox, OS 파일 선택 창, 다크 모드는 미확인 |
| 2026-10-24 | CU-02 입력권(lease), CU-03 Mac 앱 도구 계약, CU-07 분류 보강 (1-H) | 없음 → 일부(helper 모듈) / 없음 유지 / 일부 유지 | `3696996`. egdesk-host-lease: ready/user/ai/unavailable 상태와 epoch, 입력 이벤트마다 확인, 사람 입력이 오면 바로 양보(재개는 직접 돌려줄 때만), 앱별 차례, stopApp/stopAll은 눌린 키를 놓은 뒤 ACK, 프로세스 간 기기 잠금. egdesk-computer-adapter: capture·listApps·listWindows·click·typeText·key·scroll·drag 계약과 가짜 provider만 있어 실제 Mac 조작은 없음(CU-03은 없음 유지). Codex Computer Use·cua-driver 서버를 desktop으로 분류. 화면 연결 없음, OS 입력 0. 커밋 메시지에 시험 수치 없음 |
| 2026-10-24 | CHAT-13 하위 Agent 신호, AGENT-08 Agent 모델 적용, CODE-05/06 바뀐 줄·명령 출력 (1-R) | 완료 유지 / 없음 → 일부 / 일부 유지(helper) | `4d2a1a4`. 하위 Agent 행이 Codex thread/status/changed(승인 기다림·답 기다림·오류)와 별명·역할, 최근 활동 3줄(메시지 본문 없음)을 받음. 저장한 Agent의 Codex 모델·추론 강도가 요청에 따로 없을 때 실행에 쓰이고, 없는 모델은 PROFILE_MODEL_UNAVAILABLE로 거절(Claude 엔진 선택은 아직 없음). 메모리 안 RunOutputStore(파일 diff 파일당 256KiB·회차당 1MiB, turn diff 1MiB, 명령 출력 앞 8KiB+끝 64KiB, 읽을 때 가림)와 GET /chat/run-changes·/chat/command-output. 화면 연결은 S1·S3. 커밋 메시지에 시험 수치 없음 |
| 2026-10-24 | SUB-08 Claude 로그인 감지, SUB-04 코드 입력 로그인, SUB-13 버전 범위, SUB-03/14 기본 한도 행 유지 (1-E) | 없음 → 일부(helper) / 일부 유지 / 일부 유지 / 완료·일부 유지 | `b650366`. claude-engine-auth: claude CLI를 읽기만 함(`--version`, `auth status --json`, 5초 제한, 허용 필드만, 자동 업데이트 끔, Keychain·자격 파일 미접근) — 설치 여부·버전 범위·요금제/이메일. Claude 행은 이 커밋 시점에 decisionPending 유지. 엔진 행에 versionStatus(supported/untested/unsupported)·installed. POST /auth/start {mode:'device'}로 ChatGPT 코드 입력 로그인(모드를 바꾸면 진행 중 로그인 취소). 모델별 한도 버킷이 기본 5시간·주간 행을 덮지 않음. 화면(설정의 Claude 줄·코드 입력 로그인 버튼)은 S2. 커밋 메시지에 시험 수치 없음 |
| 2026-10-24 | SUB-09 Claude 승인·질문, SUB-10 EG-Desk 도구, SUB-14 Claude 한도 이름 (1-C) | 일부 유지 / 없음 → 일부(helper 모듈) / 일부 유지 | `2a8d699`. claude-engine-permissions: can_use_tool을 명령·파일·질문 요청으로, 답을 PermissionResult로(건너뛰기=빈 답으로 허용, 취소=거부+중단, 이번 대화 허용=세션 규칙), 대기·취소·프로세스 끊김 broker. egdesk-claude-mcp: 프로세스 안 'sdk' MCP 서버가 같은 run·정책·상한 검사를 거쳐 EG-Desk 도구를 제공. Claude 5시간·주간 한도 창 이름. engine-adapter-design §5.3·§9·§10·§12를 stdio 제어 통로 기준으로 고침. 실제 claude 실행 연결 전(D-S1은 오늘 결정, 연결은 2-E 묶음) |
| 2026-10-24 | AGENT-02 복제·말투 예시·하지 말 것, RT-03 가져온 Agent는 초안 (1-P) | 완료 유지 / 일부 유지 | `1003db3`. Profile 저장소 스키마 v2(출처 source_json 덧붙이기 전용, v1에서 한 트랜잭션으로 올림, 더 새롭거나 깨진 파일은 손대지 않고 거절), 복제(POST /profiles/:id/duplicate, '<이름> 사본' 초안, 원본 불변), 말투 예시(최대 3쌍)·하지 말 것(최대 8)이 지침에 '# 말투 예시'·'# 하지 말 것'으로 들어감(빈 값이면 기존 해시·지침 불변). .egdesk로 가져온 Agent는 활성화하지 않고 검토 필요 초안으로. 화면 입력란은 S2 |
| 2026-10-24 | BRW-05 이동 정책, BRW-11 위험 행동 분류 (1-X) | 일부 유지(모듈 준비, 미연결) | `c07e9cb`. egdesk-browser-url-policy(차단 목록 우선, 정확·'*.' 호스트 규칙, 위험 스킴 차단, https→http 금지, 판단 실패 시 차단. 정책이 없으면 지금의 같은 사이트 규칙과 같음 — 13×23 URL 쌍 대조 시험), egdesk-browser-action-classifier(결제·권한 부여·삭제·제출·없음, 한국어 어휘, 오탐 쪽으로 기울임). 기존 도구에는 연결하지 않음(2-BH, D-B1·D-B3는 오늘 결정) |
| 2026-10-24 | BRW-04 팝업 로그인 → 원래 카드 대기, BRW-03 팝업 회귀 시험 (1-B) | 일부 유지(helper) / 없음 → 일부(시험 스크립트) | `249696d`. 이벤트 버스·POST /events/browser가 openerCardId(선택)를 받고, oauth 대기 조건이 그 카드가 연 팝업 카드의 로그인 완료로도 열림. scripts/verify-firefox-mcp-browser-popups.mjs(attach 전용, 127.0.0.1 사이트 + localhost 가짜 로그인, 5개 시나리오), popup-test.html 수동 버튼. 시험 스크립트 실행 결과는 커밋 메시지에 없음. 팝업 창에서 Desk가 다시 뜨지 않게 막기·팝업 카드(D-B7)는 S1·S6 |
| 2026-10-24 | (문서) 레퍼런스 채택 지도 | 문서 추가 | `2913edf`. [reference-adoption-map.md](../../docs/references/reference-adoption-map.md): 영역별 레퍼런스 조사 11건(조사 작업자 자기 보고)으로 gap마다 가져올 패턴·우리 파일·구현 묶음(1차 1-A~1-W, 화면 S1~S10, 2차 묶음)·대표님 결정(5장)을 정리. 조사만이고 서재 등록은 없음. 1.2의 11번이 이 원장의 CHAT-04·CHAT-11·CODE-03 정정을 짚음(아래 정정 행) |
| 2026-10-24 | CHAT-08 Canvas 결과 게시, CHAT-05/CNV-07 브리핑 근거 여러 개·단계 의견 (1-O) | 일부 유지(helper·모듈) | `bf085a4`. egdesk_publish_output{title, markdown ≤20,000, outputKey?}(본문 blob 저장, 대화+outputKey별 버전, 'output.published'는 메타데이터만, GET /context/outputs), egdesk_publish_briefing_multi(단계당 대상 1~6·강조, 기존 브리핑 도구 스키마 불변), 브리핑 단계 의견 기록(번호·해결 상태, HTTP), EGDeskBriefingState의 다중 대상·흐리게 경로·미니맵 단계 표시·의견 초안. 화면 연결은 S3 |
| 2026-10-24 | UX-05 맞춤·배치 실행 취소·정리, UX-02 미니맵 검색, UX-06 접기, CNV-03 한 창 한 Board (1-L) | 없음 → 일부(모듈) / 일부 유지 / 일부 유지 / 없음 → 일부(모듈) | `f2058a6`. EGDeskCanvasLayout(24px 격자·가장자리·가운데 맞춤, Option/Alt로 해제, 새 위치를 덮어쓰지 않는 배치 실행 취소, 겹침 없이 정리, 채팅이 연 창은 그 옆, 화면 밖 가장자리 점, 미니맵 검색·초점 카메라, 접힌 크기, 가장 안쪽 Board 영역, 끌어 놓기 제안, 한 창은 한 Board 소속), EGDeskLayerStack(Esc 한 번에 가장 위 층만, 한글 조합 중 무시). 순수 모듈, 화면 연결은 S4·S7 |
| 2026-10-24 | CNV-05 AI 표식, CNV-06 메모 (1-N) | 없음 → 일부(모듈) / 없음 → 일부(모듈) | `31bc4ba`. 카드 위 Agent 표식의 제안·묶음/하나씩 받기·지우기·원본 보존 편집·받은 것만 Board에 저장, 받기 전에 페이지를 다시 확인(다른 문서의 표식은 거절). 메모는 아래 카드에 고정·답글 스레드·'Agent에게 묻기' 초안, Agent 답은 물어본 동안에만 한 번 붙음. 순수 모듈 + node 시험, 화면 연결은 S7 |
| 2026-10-24 | BRW-01 툴바 키보드, DSN-04 키보드 툴팁, DSN-03 대비 검사 (1-F) | 일부 유지 / 완료 유지 / 일부 유지 | `00ace44`. EGDeskFocusNavigation(툴바·라디오·탭 화살표 이동, 비활성 항목도 포커스 유지, 입력칸 커서 경계, 다시 그린 뒤 포커스 복원, 키보드 툴팁 1500ms/500ms·Esc가 먼저 닫음), EGDeskDesignTokens(CSS의 var()·color-mix()를 풀어 밝게·어둡게 대비 검사, 아바타 tone-2/3·포커스 테두리 미달은 todo 시험). 화면 연결은 S1·S5 |
| 2026-10-24 | CODE-05 바뀐 줄 보기, CODE-06 실행 결과 카드 (1-D) | 일부 유지 / 없음 → 일부(helper·모듈) | `a684c9d`. EGDeskDiffView(Codex fileChange·/chat/run-changes·git turn diff·두 텍스트 비교를 번호 붙은 −/+ 줄로, textContent만, 1MiB/100ms 한도), EGDeskRunResult(명령 종류 분류, node --test·jest·vitest·mocha·playwright·pytest·cargo·go·bun·deno·tsc·eslint 통과/실패 수, 실패별 첫 프로젝트 파일:줄, 끝부분 토큰 가림, '12 통과 · 1 실패' 카드). jsdiff 9.0.0 무수정 vendor(BSD-3-Clause)와 VENDOR.md. 시험 scripts/egdesk-diff-run-result.test.mjs(수치는 커밋 메시지에 없음). CODE-06의 helper 쪽 명령 출력은 `4d2a1a4`. 화면 연결은 S3 |
| 2026-10-24 | CODE-03 내용 검색·git 상태, CODE-05 '변경' 탭 (1-G) | 일부 유지 / 일부 유지 | `4ae184d`. egdesk-git-review(셸 없이 execFile, 선택 잠금·fsmonitor 끔, 파일당 patch 1MiB) + /v1/files/git/{status,changes,diff}·/v1/files/search/contents. 이름 검색이 .git·node_modules·빌드 폴더를 건너뛰고 .gitignore를 따름. EGDeskFileView에 '변경' 탭(커밋 안 한 변경과 파일별 diff), 이름/내용 검색 전환(결과를 누르면 그 줄), 트리의 git 상태 글자, onFileChanged(바뀐 폴더만 다시 목록). 외부 변경 자동 갱신의 uc.js 이벤트 연결은 S3. 실제 Firefox 창 미확인, 시험 수치는 커밋 메시지에 없음 |
| 2026-10-24 | RT-07 작업 기록 SQLite, CHAT-06 선택지·짧은 답 대기 (1-W) | 일부 유지 / 완료 유지 | `d7aac51`. 작업 그래프 journal·native ledger·task sources·Agent 계획이 이벤트마다 전체를 다시 쓰던 JSON 4개에서 비공개 SQLite 하나(workflow-store/workflow.sqlite)로: task_events는 덧붙이기 전용(UPDATE·DELETE 없음), 이전 JSON은 한 번 가져오고 그대로 둠. 이벤트 2만 개에서 추가가 22.4ms → 0.2ms. egdesk_propose_plan의 userAction 대기 조건에 선택지(2~6개)·짧은 답(500자 이하), /tasks/continue가 답을 질문과 대조하고 비밀번호·키·개인 번호처럼 보이는 글은 거절. 맥락 저장소는 여전히 JSON. 선택지 버튼 화면은 S3 |
| 2026-10-24 | (원장 정정) CHAT-04 상태 | 없음 → 완료 | 위 `8dc695d` 행. 원장에 '없음'으로 남아 있었음(reference-adoption-map 1.2의 11번이 짚음) |
| 2026-10-24 | (원장 정정) CHAT-11 Chat 'Agenda' 표기 | 일부 → 완료 | `163a60e`(UX-03과 같은 커밋)에서 화면의 'Agenda'가 'Board'로 바뀜(내부 id 유지). 지금 코드 문구: 'Board Thread', '새 Board Thread', 'Board Thread · 멤버 N명', 'Board Thread에서 제거'. 같은 커밋 기준 headless 렌더링 fixture 72/72, UI 회귀 274/274 |
| 2026-10-24 | (원장 정정) CODE-03 근거 | 문구 정정, 상태 일부 유지 | "200개를 넘으면 페이지 없음"은 사실이 아님. `d40ad5c`(2026-09-27)부터 listDirectory가 cursor·nextCursor로 나눠 주고, 파일 창 트리에 '더 보기' 행이 있다(EGDeskFileView moreRow). 항목 본문의 빠진 것·구현 스케치를 고침 |
| 2026-10-24 | (결정) 대표님 결정 반영 | 결정 기록 / SUB-12 없음 → 완료 | 레퍼런스 채택 지도 5장·REA 채택안 6장 권고안을 모두 채택. 따로 정한 것: Claude 연결 D-S1(= SUB-12, (b) 무수정 claude + 공식 SDK와 같은 stdio 제어 통로), Mac 앱 조작 D-C1(= Q3·REA 7·8, 자체 Rust 도우미), 실제 화면 시험 D-C4(= Q2·REA 11, 관찰 전용부터). 아직 정하지 않은 것은 아래 '대표님 결정이 필요한 것' 표에 남김. 같은 결정 표시: reference-adoption-map 5장, rea-mechanism-adoption 6장, computer-use-options 5장 |
| 2026-10-24 | RT-07 Desk·대화 저장소 v2/v3, CTX-01 Board 검색·카드 단위 병합, CHAT-01 방별 Agent 저장, RT-03 JSON Canvas (2-RT) | 일부 유지 / 일부 유지 / 일부 유지(helper) / 일부 유지(helper 모듈) | `b4e51f8`. Desk 저장소 v2: 60초 안의 자동 저장은 머리 자동 저장 하나를 바꿔 씀(D-R1, 직접 저장·복원·가져오기는 늘 남음), 대화 메시지는 메시지마다 한 번만 저장하고 세대끼리 공유, Board 제목·카드 이름·메모 검색 색인(FTS5 trigram, 없으면 일반 검색), 카드 단위 병합과 충돌 목록(쓰기 없음). HTTP `GET /v1/boards/_search`·`POST /v1/boards/:id/merge`. 대화 저장소 v3: 방마다 고른 Agent(profileId·revision)와 방 멤버 객체, 옛 이름 목록 변환. v1/v2 파일은 `.bak`으로 남기고 제자리에서 올림(옛 빌드로 돌아가려면 .bak을 되돌림). `egdesk-json-canvas.mjs`: Board ↔ JSON Canvas 1.0 변환(첨부·캡처 기본 제외, D-R3). 방 Agent·멤버 HTTP 라우트(`/chat/rooms/...`)와 화면(병합 선택 화면·방별 Agent 복원, S10)은 연결 전. 커밋 메시지에 시험 수치 없음 |
| 2026-10-24 | SUB-09 Claude 실행 통로 (2-E 전송) | 일부 유지(helper 모듈) | `d76bb67`. `claude-engine-transport.mjs`: 대표님이 설치한 무수정 claude를 셸 없이 절대 경로로 띄우고, stream-json 입출력과 숨은 `--permission-prompt-tool stdio`로 제어 요청을 주고받음(D-S1 (b)). 멈출 때 프로세스 그룹에 stdin 닫기 → SIGTERM → SIGKILL 순서로 보내 claude나 도구 자식 프로세스가 남지 않게 함. 격리(D-S2): hooks 끔, EG-Desk sdk MCP만(`--strict-mcp-config`), claude.ai MCP·설정 파일·CLAUDE.md·skills 끔, 로그인은 공유. 환경에 API 키가 있으면 시작 전에 멈춤(D-S4). 최소 CLI 2.1.205와 init.capabilities로 실행을 막음. 이 통로는 CLI 공개 계약이 아니어서 따라 만든 SDK 커밋을 파일 머리말에 기록. 가짜 프로세스 단위 시험만 있고 실제 claude로는 미실행 |
| 2026-10-24 | RT-01 깨끗한 첫 실행 점검, fx-autoconfig 로더 고정 (1-Q) | 일부 유지(스크립트·단위 시험) | `0557a36`. install.sh·install.bat이 fx-autoconfig 커밋 `dfdab56`(2026-07-23)만 받고, 복사할 8개 파일을 SHA-256으로 확인한 뒤에야 Firefox를 건드림. `--check-loader`는 받기·확인만. `scripts/verify-clean-profile-boot.mjs`: 임시 프로필 → 격리 브리지 → Firefox → Desk 뜸 확인 → Firefox 종료 → 브리지 종료 → 포트 해제 → 영수증. 자기가 띄운 프로세스만 멈추고 쓰는 중인 포트는 거절, `--plan`은 계획만 출력. 가짜 프로세스 단위 시험만 있고, 새 로더와 overlay 호환을 포함한 실제 실행은 안 함(apps/firefox-ui-demo/docs/PATH_1_5_STABILIZATION.md에 기록) |
| 2026-10-24 | (문서) 화면 파일 분리 계획 | 문서 추가 | `ac1f8d6`. [surface-module-split-plan.md](../../docs/references/surface-module-split-plan.md): eg-desk-surface.uc.js의 구역을 `overlay/resources/surface/*.mjs`로 그대로 옮기는 6단계(차가운 카드 3개 → 설정 → Browser → Chat 활동 → Chat 연결·대화 → Canvas·Board). 화면 작업을 한 줄이 아니라 최대 6줄로 나눠 돌리려는 것. 1~5단계를 사본에 적용해 화면 시험 5개 파일 457개(통과 453·실패 0·todo 4)를 유지함(시험 줄 35곳 수정). 실제 저장소에는 아직 적용 안 함, Firefox 로딩 미확인 |
| 2026-10-24 | SUB-09 Claude 엔진 어댑터, SUB-08 Claude 상태·로그인 명령, SUB-06 Claude 등록, SUB-10 EG-Desk 도구, SUB-14 Claude 한도 (2-E 연결) | 일부 유지(helper) ×5 | `bcbbd11`. `claude-engine-adapter.mjs`: 대화당 claude 프로세스 하나(첫 회차 `--session-id`, 이후 `--resume`), 5분 유휴면 종료, 동시 2개까지(넘으면 ENGINE_BUSY), 중지는 interrupt 제어 요청 + 안전장치, 프로세스가 죽으면 그 회차만 끝남. 승인·질문은 permission broker, EG-Desk 도구는 프로세스 안 'sdk' MCP, 출력은 stream 번역기로. Claude 행이 설치·버전(최소 2.1.205)·init.capabilities·로그인으로 ready/loginRequired/notInstalled/versionUnsupported를 판정. API 키가 EG-Desk 환경에 있으면 확인 전까지 시작 안 함(D-S4, 키는 claude에 넘기지 않음), 한도 뒤 자동 이어가기 없음(D-S5, 초기화 시각만). `GET /engines/claude/login-command`가 Terminal 카드용 `claude auth login --claudeai`/`--console` 줄을 돌려줌. 브리지가 Claude를 등록하고 이벤트를 Chat으로 보냄. 다만 런타임 쪽 계약 8가지([engine-adapter-design.md §14.6](../../docs/references/engine-adapter-design.md), 예: 저장소가 있으면 `send()`가 Codex 외 엔진을 거절)가 남아, 지금 Chat에서 Claude 대화는 시작되지 않음. 이 Mac의 claude가 로그아웃 상태라 실제 claude로는 미실행. 패턴: claude-agent-sdk-python(MIT), claude-agent-acp(Apache-2.0) |
| 2026-10-24 | CU-01 컴퓨터 허락 카드·사람 사용 중 양보, CU-02 컴퓨터 도구 입력권 게이트, CHAT-10 Board 멤버 라우팅, CHAT-03 메시지 보내기, CHAT-13 하위 Agent 다시 맡기기, CHAT-01 방 Agent 기록 (2-R) | 없음 → 일부(helper) / 일부 유지 / 없음 → 일부(helper) / 없음 → 일부(helper) / 완료 유지 / 일부 유지 | `2d9672e`(대화 저장소 v3 `b4e51f8` 위). D-C3: Codex 컴퓨터 조작 MCP의 '이 앱 써도 될까요'(elicitation)를 한 번짜리 허락 카드 'computerElicitation'([이번만 허락]/[거절])으로 바꿈. 예/아니오·하나 고르기 칸만 받고 '이번 대화'·'항상'은 내놓지 않으며, 회차가 끝나거나 5분이 지나면 취소. 'egdesk-computer' 도구는 입력권(host lease)이 있고 컴퓨터 조작이 꺼져 있지 않을 때만 제공(관찰 상한이면 읽기 도구만). 사람이 Mac을 쓰는 중·키가 눌린 중·입력 중지 상태면 provider에 가기 전에 거절하고, 사람이 Mac을 쓰는 중 Codex 컴퓨터 호출(cua_repl)이 오면 회차를 한 번 중단함(best effort). 이 중단은 결정표의 REA 10('지금은 표시만', 남음)과 겹치므로 연결할 때 맞춰 봐야 함. D-M2 `POST /chat/board/send`: @로 부른 Agent만, 없으면 Lead가 답함. 멤버는 자기 대화에서 Board 맥락 블록을 받아 답하고(run.board 귀속), 방당 Board 회차는 2개까지. D-M1 `POST /chat/subagent/reassign`: 막힌 하위 Agent의 일을 유휴 부모에게 돌려줌. D-M3 `POST /chat/share`: 고른 메시지를 복사하고 양쪽 기록에 줄을 남기며, 받는 쪽 다음 회차에 한 번 `<egdesk-shared-messages>`로 읽힘. 보낼 때 방의 Agent를 setRoomAgent로 기록. 이 라우트들은 브리지 HTTP에 들어 있음. 컴퓨터 provider·hostLease·noteHostControl을 브리지에 끼우는 줄과 화면(허락 카드·멤버 칩·다시 맡기기 버튼, S8·S9)은 연결 전. 커밋 메시지에 시험 수치 없음. 패턴: codex-computer-use-mcp, t3code(MIT) |
| 2026-10-24 | AGENT-02 Agent 파일 가져오기·내보내기·사진 아바타, AGENT-04 새 Agent 도구 범위 프리셋 (2-P) | 완료 유지(helper 추가) / 완료 유지(helper 추가) | `6cd17ca`. Agent를 .md(agency-agents·Claude Code 머리말 + 합성된 지침)와 Codex .toml(샌드박스 한계는 머리 주석)로 내보냄. EG-Desk가 만든 .md는 같은 본문·해시로 다시 읽힘(D-A2). 다른 도구의 .md는 검토를 기다리는 초안이 됨(미리보기 먼저, 8000자 한도, Claude Code 도구 목록은 상한을 좁히기만, 모르는 필드는 이름만 보여 줌). 사진 아바타(PNG·JPEG·WebP 512KB 이하)는 확인 뒤 메타데이터 없이 다시 써서 profile_assets(Profile 저장소 스키마 v3)에 보관하고, 내보낸 파일에는 넣지 않음(D-A3). 도구 범위 프리셋은 만들 때만 적용하고 기본값은 '제한 없음' 유지(D-A1 미결정). 라우트 `/profiles/tool-presets`·`/profiles/import`·`/profiles/:id/export`·`/profiles/avatar-images`. 화면(S9)은 연결 전이고, 지금 화면의 Profile 편집은 사진 아바타를 떨어뜨리므로 S9에서 함께 고쳐야 함(2-P 작업자 보고). 커밋 메시지에 시험 수치 없음 |
| 2026-10-24 | CU-03 Mac 관찰 도우미 1단계, CU-01 host-activity 행, RT-04 Rust 도우미 통합·터미널 토큰, CU-02 입력권 연결 부품 (2-CH Rust) | 없음 → 일부(helper·관찰 전용) / 위 2-R 행과 함께 일부 / 일부 유지 / 일부 유지 | `30c8eca`. helper-rust에 `egdesk-helper host-observe`: 앞 앱 바뀜, 실행 중인 앱(bundleId·pid·이름), 화면의 창(번호·위치·소유 pid, 제목은 요청할 때만 + 화면 기록 사전 확인), 권한 미리 보기(사전 확인만), com.openai.sky.CUAService 실행 여부를 알림. 0700 폴더 안 0600 Unix 소켓에 클라이언트 하나, 실행마다 nonce와 같은 uid 확인, stdin 끝·heartbeat 끊김·규약 위반이면 종료. 입력·캡처·접근성 쓰기는 없음(CU-03의 창 캡처·AX는 2단계). WebSocket 터미널은 이제 실행 토큰이 없으면 연결을 거절(상수 시간 비교). Node 쪽 `egdesk-host-agent.mjs`(도우미 감독: 절대 경로, 셸 없음, heartbeat, 재시작 backoff, guardAlive·attachLease, 입력 감시는 끔)와 `egdesk-host-activity.mjs`(앞 앱·서비스·Codex 컴퓨터 조작 행). 브리지·화면 연결 전이고, 실제 Mac에서 앱 전환 감지는 미확인, 커밋 메시지에 시험 수치 없음. 패턴: trycua/cua cua-driver, open-computer-use(MIT, 출처 표기) |
| 2026-10-24 | CODE-02 Board 프로젝트 폴더, CODE-04 원본에 저장·충돌 비교, CODE-05 덩어리별 되돌리기, CODE-06 프로젝트 명령·결과 카드 (2-X) | 없음 → 일부(helper·모듈) / 일부 유지 / 일부 유지 / 일부 유지 | `8580896`. 원본 저장과 검토 중 되돌리기는 원본이 사용자가 본 해시와 같을 때만 쓰고(다르면 SOURCE_CHANGED와 두 해시, D-X1), 임시 파일 + 이름 바꾸기로 권한을 유지. Agent가 만든 파일은 그대로일 때만 지움. 프로젝트 폴더는 고르기 창 선택으로만 Board·방에 붙고, 재시작 뒤 같은 dev/ino일 때만 다시 연결(D-X3). 명령은 사용자가 입력한 것만 돌리고 package.json scripts는 제안만(D-X6). File view에 '원본에 저장'과 비교 화면, EGDeskDiffView 검토, 프로젝트 '검사' 결과 카드와 줄 이동. EGDeskChangeReview: 승인 본문, 적용 뒤 덩어리별 되돌리기·취소, 만든 파일은 확인 후 지우기(D-X2). Codex·Claude·ACP·git 공통 파일 변경 모양, git checkpoint(기본 끔, 전용 ref, 사용자 index 미변경, D-X4), Terminal 프로젝트 명령 실행 캡처. 브리지가 회차 cwd에 프로젝트 폴더를 쓰는 줄(resolveProjectWorkspace)과 화면 연결(S3·S10)은 남음. 실제 Firefox 창 미확인, 커밋 메시지에 시험 수치 없음 |
| 2026-10-24 | CTX-04 보낸 뒤 바뀐 자료, CTX-03 추천 모드·제외 목록·관련 Board 후보 (2-CTX) | 일부 유지(helper) / 일부 유지(helper) | `5a650c7`. 맥락 런타임이 대화별 Browser·파일 자료를 기억하고, 버스의 file.changed·browser.navigated를 따라 '바뀜'으로 표시함. 다음 메시지(일반 후속 질문 포함)에 내용 없는 한 줄(id·종류·이유 코드)과 context.sources.changed 이벤트가 붙음. `GET /context/sources`, packet의 staleSources. 메모리 안·상한 있음·계정이 바뀌면 지움. D-R2는 미결정이라 기본값은 그대로 두고 설정만 둠: contextSuggest {mode: always·firstMessage·off, neverSuggest: 사이트·폴더}, `GET/POST /context/suggest-settings`(목록의 사이트·폴더는 후보에서 빠지고, 직접 고른 것은 유지). 입력한 말이 들어 있는 저장 Board가 'board' 후보가 됨(가중치 15, 그 말은 Board 검색에만 쓰고 기록에 남기지 않음). QA 브리핑 계약이 targets[]를 받음. 브리지 한 줄(`contexts.attachServices`)과 화면 칩·설정(S10)은 연결 전. 패턴만: VS Code chat implicit context(MIT), cline FileContextTracker(Apache-2.0) |
| 2026-10-24 | BRW-08 닫힌 shadow·내부 스크롤, BRW-12 시간 초과 뒤 동작 확인(reconcile), BRW-06 글자 기다리기·조용해질 때까지 대기 (1-A) | 일부 유지 / 일부 유지 / 완료 유지 | `5760981`(REA 묶음 가 계약 위). Agent가 보는 페이지 목록에 cursor:pointer·onclick 요소(clickable), 숨은 라디오·체크박스를 감싼 label, 내부 스크롤 상자(scrollable), 닫힌 shadow root(openOrClosedShadowRoot, 기본 위젯 제외)가 들어감. ref는 WeakRef(최신 관찰의 ref만 강하게 붙듦). 거절된 클릭은 무엇이 가렸는지 구조로만 알려 주고(obscuredBy), 뷰포트 안 중심을 누름. 조작 뒤 100ms마다 살펴 500ms 조용하면 끝냄(최대 1.5초, 입력권·예산 - 500ms를 넘지 않음). 새 읽기 전용 도구 `egdesk_browser_wait_text`(보이는 글자만, 찾는 글을 되읽어 주지 않음). 기존 도구 스키마는 그대로(해시 고정 시험). UI 시간 초과 뒤 helper가 한 번 물어 '확실히 안 들어감'일 때만 카드를 풀고, 동작은 다시 보내지 않음(REA EG-01). 시험: 소유 150/150, helper 전체 1104 통과·9 skip·실패 0, surface-state 354/354. chat 런타임의 도구 목록 import·wait_text 읽기 전용 표시와 화면 쪽 callId·budgetMs·reconcile 처리(S1)는 연결 전. Firefox 미실행이고, 이 커밋 뒤 headless browser-negative·대화 흐름은 다시 돌리지 않음 |

## 후속 연결 체크포인트 (2026-10-25)

2026-10-24 인계를 받아 같은 브랜치에서 개발했다. 아래 첫 연결 묶음은 `ff9ae10`으로 커밋했다. 이어진 Claude 선택 자료 연결의 최신 상태는 이 절 아래 **B2 선택 자료 후속**에 구분한다. 상태 표의 95개 항목은 이번 부분 연결만으로 완료로 올리지 않는다. Main은 통합·중앙 검증을, Astra/max 작업자는 구현·테스트·독립 검토를 나누어 맡았다.

| 작업 | 이번 변경 | 검증 경계 |
|---|---|---|
| 화면 분리 1단계 | Ontology·File·Terminal 구역을 window 범위의 세 모듈로 이동하고 기존 진입점은 얇게 유지했다. | 실제 임시 Firefox 프로필에서 모듈 로딩과 카드 연결 확인. 전체 분리 계획의 2단계 이후는 아직 적용하지 않았다. Terminal 카드 로딩은 PTY 실행 확인이 아니다. |
| Claude 런타임·HTTP 연결 | 저장된 엔진·계정에 따른 전송·재개·승인·질문, 원래 cwd·도구 목록 검증, 확정 거절 구분, 한도 이벤트를 연결했다. | 가짜 전송을 쓰는 실제 런타임·저장소·HTTP 테스트. 실제 Claude 구독 호출은 하지 않았다. 상세: [엔진 설계 §14.7](../../docs/references/engine-adapter-design.md#147-후속-연결-체크포인트-2026-10-25). |
| 승인 경계·오래된 응답 | Agent 상한을 세션 허용으로 우회하지 못하게 하고, 응답 전달 실패를 성공으로 남기지 않는다. 프로세스 재시작 후에도 permission/MCP 요청 번호를 재사용하지 않는다. | 독립 검토 후 helper 전체 1,138 pass / 0 fail / 9 skip. 별도 검토자의 관련 109개·RPC 8개도 통과. |
| 대비·포커스 | 남아 있던 4개 TODO를 실제 CSS 아바타·포커스·대비 증가 토큰으로 해결했다. 일반 모드의 옅은 테두리·목재 Canvas·화면 구조는 유지했다. | CSS 대비 기준을 낮추지 않았다. headless 밝은/어두운 화면을 확인했다. OS 대비 증가 모드는 실제로 활성화하지 못했으므로 해당 부분은 CSS 시험 근거만 있다. |
| 테스트 격리·브라우저 회귀 | 별도 임시 프로필과 별도 브리지 포트에서만 fixture를 사용하고 복사본의 소스 해시를 남긴다. wait_text 읽기 전용 카탈로그도 런타임에 연결했다. | headless browser-negative의 12개 거절에서 실행 횟수 증가 0·자료 변경 없음, 카드·카메라 경계 확인. 모델 호출 0회이며 브라우저 시나리오 스크린샷 검증은 지원되지 않아 DOM·actor 증거와 구별한다. |

**중앙 검증 결과**: helper 1,138 pass / 0 fail / 9 skip, scripts 930 pass / 0 fail / 1 skip / 0 todo. 일반 대화 fixture 72/72, Claude 화면 fixture 12/12, 4개 창 크기의 headless UI 회귀 274/274(직접 UI 조작 26개, 생략 0) 통과. 실제 Claude·Codex 모델 호출은 0회다. fixture는 UI와 응답 계약을 검증하며 실제 provider 실행이나 권한의 지속을 입증하지 않는다.

독립 검토에서 찾은 계정 전환 경합은 수정했다. Claude 방이 있어도 이전 Codex 계정의 Browser·파일 캡처를 취소하며, 지연 완료 뒤 새 계정에 캡처 POST가 생기지 않는다. Claude 요청은 유지된다. 수정 후 독립 재검토 2/2도 통과했다. 엔진 메뉴가 Canvas 변환을 이중 적용받아 카드 밖에 뜨던 문제와 한도 안내의 여백 누락은 실제 스크린샷 확인 후 수정했다. 밝은/어두운 화면, 메뉴·승인·질문·한도·선택 자료 차단 화면을 확인했지만 모든 제품 사용성을 검증했다는 뜻은 아니다.

**첫 연결 묶음에서 남겨 둔 범위**:

- Claude 선택 자료·Codex 의존 EG-Desk provider(B2)는 아직 미지원이다. 선택 자료가 있으면 보내지 않고 요청문과 선택을 보존한다. Codex 권한으로 우회하거나 자료를 빼고 자동 전송하지 않는다.
- 화면 분리 2단계 이후, S1의 callId·budgetMs·reconcile·대화상자·obscuredBy 연결과 2-BH 후속은 남았다. 이번 browser-negative 통과를 이 전체 연결의 완료로 해석하지 않는다.
- 높이 600px의 작은 창에서는 긴 작성문이 입력칸 내부 스크롤로 일부만 보인다. 버튼 접근성 회귀는 통과했지만, 보내기 전 요청 전체를 다시 읽기 쉬운지는 별도 편집 UX 후속으로 남긴다. 이번 연결에서 작성기 구조를 새로 설계하지 않았다.
- 실제 Claude 로그인·구독 모델 왕복, 운영 프로필 적용, Windows, OS 전면 포커스·키 입력은 이번 확인에 포함하지 않았다. 과거 인계 문서의 실계정 시험 절차만으로 자동 실행하지 않는다.
- Rust는 관찰 전용 범위를 유지한다. REA 10 자동 중단, Jev 도입, 미결정 제품 정책은 이번 연결로 바꾸지 않았다. main 통합·push도 하지 않았다.

**다음 재개 순서**: S1의 아직 연결되지 않은 브라우저 계약부터 작업 파일 소유권을 다시 나눈다. Claude B2는 엔진별 Context 권한·소유권 계약과 실제 CLI 확인을 분리해서 진행한다. 실제 계정 시험은 계정과 짧은 시험 범위를 먼저 확인하며, OS 전면 입력은 계속 별도 승인 대상으로 둔다.

### B2 선택 자료 후속 (2026-10-25)

Claude 대화에 완전한 텍스트 캡처를 연결하는 후속 구현을 진행했다. 이 절이 위의 B2 전체 미지원 설명을 대체하며, 실제 모델 호출이나 Claude 전체 기능 완료를 뜻하지 않는다. 상세 계약은 [엔진 설계 §14.8](../../docs/references/engine-adapter-design.md#148-claude-선택-자료-연결-b2-2026-10-25)에 있다.

- Claude 실행 계정·방별로 선택 캡처를 분리하고 `egdesk_list_context`·`egdesk_read_source`만 연결했다. 자료의 브라우저 프로필·사이트 계정과 AI 구독 계정은 서로 달라도 된다.
- 계정 변경 알림보다 캡처 완료가 먼저 도착하는 경우에도, 이전 연결에서 시작한 요청이 새 계정으로 저장·전송되지 않도록 서버의 연결 범위 확인값을 사용한다.
- 원본 수정·대화 재개·저장소 재개방 뒤에도 원래 캡처·해시·읽은 범위·도구 목록을 검증한다. 저장만 한 캡처와 도구 응답으로 전달된 기록은 구별한다.
- Reader가 필요한 큰 자료, 불완전한 캡처, 지원하지 않는 형식은 명시적으로 거절한다. Codex Reader 우회·자동 축약·자료를 뺀 자동 전송은 하지 않는다. 요청문과 선택은 유지한다.

**중앙 검증**: helper 1,188 pass / 0 fail / 9 skip, scripts 968 pass / 0 fail / 1 skip / 0 todo. 격리한 headless Firefox에서 일반 채팅 72/72, Claude 화면 18/18, 4개 창 크기 UI 회귀 274/274(직접 조작 26개)를 통과했다. 브라우저 거절 12개도 DOM·actor 근거로 재확인했다. 실제 구독 모델 호출은 0회다. 화면의 읽기 영수증은 합성 fixture이며, 실제 HTTP handler·저장소·어댑터와 가짜 MCP 전송의 통합 시험은 별도로 수행했다.

독립 검토에서 찾은 계정 프로필 잔류·재시작 후 확정 거절 결과 유실·형식 오류 유실·불확실 전송 상태 오표시를 수정하고 재검토를 통과했다. 요청이 실제 전송된 뒤 응답만 유실됐다면 재조회에서도 확인 필요 상태로 남긴다. 시험의 부드러운 스크롤 중 오클릭과 자료 카드 배치 후 카메라 이동은 관찰·대기 절차를 보완했고, 제품의 클릭·화면 처리를 강제 우회하지 않았다.

**남은 범위와 다음 단계**: Claude용 Reader·큰 자료 처리, 실제 계정의 짧은 모델 왕복 검증, S1 브라우저 계약 후속 연결은 남았다. 운영 프로필 적용·Windows·OS 전면 입력은 이번 후속에 포함하지 않는다. Rust 네이티브 보조 기능과 Node.js 엔진/자료 연결 구조는 유지하며 전체 Rust 전환은 하지 않았다. 이번 부분 연결만으로 SUB-09 전체나 95개 상태 항목을 완료로 올리지 않는다.

### B3 대용량 Reader 연결 기반 후속 (2026-10-25)

Claude 전용 Reader와 큰 텍스트 자료의 엔진별 읽기 경로를 추가했다. **코어·연결 시험은 통과했지만 실제 구독 Reader는 아직 비활성이다.** B2 작은 첨부 직접 읽기는 유지된다. 상세와 활성화 전 연결 목록은 [엔진 설계 §14.9](../../docs/references/engine-adapter-design.md#149-claude-대용량-reader-연결-기반-b3-2026-10-25)를 따른다.

- 고정 원문을 범위별로 읽고, 부분 처리·전체 범위 완료·Main 전달을 구별한다. 원문을 임의로 자르거나 다른 엔진으로 우회하지 않는다.
- 정확한 Reader 입력과 인용 범위를 보존하고, 같은 원문을 다른 질문으로 다시 읽을 수 있다. 취소·계정·모델 변경 뒤 늦은 결과를 전달하지 않으며 동시 읽기의 예산 중복 사용을 막는다.
- 실제 클래스들을 연결한 가짜 전송 시험에서 대용량 읽기·재질문·원본 변경 후 재개·중복 호출 방지를 확인했다. 실제 bridge의 용량·관리 정책 수집기는 미연결이므로 합성 시험의 준비 완료를 실계정에 적용하지 않는다.
- 중앙 helper 1,281 pass / 0 fail / 9 skip, scripts 997 pass / 0 fail / 1 skip. headless 일반 채팅 72/72, 기존 Claude 첨부 18/18, Reader 화면 27/27, UI 274/274(4개 크기·직접 조작 26개), Browser 거절 12개를 확인했다. 실제 모델 생성 0회이며 운영 프로필·OS 전면 입력·Windows 검증은 하지 않았다.

**다음 연결**: 부모 Claude 세션의 현재 용량·사용량 수집, 적용된 MCP 출력 한도와 직렬화 비용 검증, 관리 정책·hook 격리 확인, 부모와 Reader의 합산 실행 제한. helper 재시작 뒤 처리 중 continuation 커서 복원도 남았으며, 현재는 고정 원문·영수증 복원 후 명시적인 새 읽기가 필요하다. 이를 연결한 뒤 실제 구독 모델 왕복을 별도로 확인한다. 이번 기반 구현만으로 대용량 Reader 실사용이나 SUB-09 전체를 완료로 올리지 않는다.

Git 전송 확인 범위는 기존 `ff9ae10`·`4b40588`까지다. B3 후속은 별도 로컬 체크포인트로 보존하며, 원격 전송·main 통합 여부와 구분한다. 이 검증으로 원격 전송이나 main 통합을 완료했다고 표시하지 않는다.

## 이전 세션 인계 원본 (2026-10-24 마감)

아래는 당시 상태와 계획이다. 완료 여부가 달라진 항목은 위 2026-10-25 체크포인트를 우선한다.

**지금 상태**: 브랜치 `claude/vision-gap-20261024`, 마지막 기능 커밋 `5760981`(1-A 브라우저 정확도, 이 원장 갱신 커밋은 그 위에 얹힘). 진행 중인 변경은 없다. 합친 상태에서 helper 시험 1104/1113 통과·실패 0(skip 9), 화면 쪽 시험 764/768 통과·실패 0·todo 4(todo는 S1·S5 몫). 마지막 headless 대화 흐름 72/72·UI 회귀 274/274는 `9dbfa51`·`b3ae83e` 시점 값이다. 그 뒤 1-A(`5760981`)가 Browser actor를 바꿨으므로 headless browser-negative와 대화 흐름을 다시 돌려 확인해야 한다.

**바로 이어 할 순서** (중단된 작업 포함):

1. **화면 파일 분리 1~5단계** — [surface-module-split-plan.md](../../docs/references/surface-module-split-plan.md). 사본에서는 1~5단계 뒤에도 화면 시험이 유지됐고, 실제 저장소 적용과 Firefox 로딩 확인은 아직이다.
2. **화면 1차 S1(다시 시작)** → 그 뒤 S2~S10을 분리된 모듈 줄마다 병렬로. S1 범위는 [reference-adoption-map.md 4.5](../../docs/references/reference-adoption-map.md)의 S1에, 1-A가 S1에 넘긴 것(act 요청의 callId·budgetMs, 새 요청 'reconcile', 대화상자 종류, obscuredBy 전달)을 더한다.
3. **통합 연결** — 오늘 helper 커밋들이 남긴 "끼우는 줄". 계약은 아래 문서·커밋에서 다시 확인한다.
   - Claude 런타임 계약 8가지: [engine-adapter-design.md §14.6](../../docs/references/engine-adapter-design.md) — `send()`의 Codex 외 엔진 거절 풀기, rpc id의 엔진으로 응답 보내기, 승인·질문의 assertReady를 그 Run의 엔진 기준으로, acceptForSession 통과, multiSelect 유지, `egdesk/engine/rateLimit` 알림 사용(자동 재시도 없음), 시작 전 거절은 '불확실한 대화'로 두지 않기, 재개 때 dynamicTools·cwd 넘기기.
   - 컴퓨터 도구(`2d9672e`·`30c8eca`): `new CodexChatRuntime({ hostLease })`, toolProviders에 'egdesk-computer' provider, 입력권 이벤트 → `chat.noteHostControl(event)`, 브리지에 `egdesk-host-agent`·`egdesk-host-activity`(`GET /host/activity`, SSE 'host.activity'). 컴퓨터 도구는 새 대화부터만 보인다.
   - 2-CTX·2-X 브리지 줄(`5a650c7`·`8580896`): `contexts.attachServices({ bus, settings, boards })`, 회차 cwd·allowedRoots에 `resolveProjectWorkspace(...)`.
   - chat 방 Agent·멤버 라우트(`b4e51f8`의 대화 저장소 v3 함수 위): `PUT /chat/rooms/:id/agent`, `GET·PUT·POST /chat/rooms/:id/members`, `DELETE /chat/rooms/:id/members/:memberKey`(제안된 경로).
   - 1-A(`5760981`): codex-chat-runtime의 브라우저 조작 도구 사본을 `BROWSER_INTERACTION_TOOL_NAMES` import로 바꾸고, 관찰 자리를 `BROWSER_READ_TOOL_NAMES`로 넓히고, `egdesk_browser_wait_text`를 readOnly 목록과 관찰 상한에 넣는다.
   - 2-P(`6cd17ca`): .egdesk 내보내기의 Agent에서 사진 id를 빼기(`withoutAvatarImage`), D-A1이 정해지면 `openProfileStore`에 기본 프리셋.
   - REA 10 맞추기: `2d9672e`는 사람이 Mac을 쓰는 중 Codex 컴퓨터 호출이 오면 회차를 한 번 중단한다. 결정표의 REA 10은 '지금은 표시만'으로 남아 있으니 noteHostControl을 끼울 때 대표님 결정과 맞춘다.
4. **2-M 작업 흐름 2차(다시 시작)** — Lead 계획 단계의 담당 Agent·종합, 팝업 닫힘으로 로그인 끝남(D-B11 결정 뒤), 한도 초기화 대기 조건, 트레이 단축키 이벤트.
5. **2-BH 브라우저 2차** — 스크린샷(가림·거부), trusted 클릭(착지 가드), 이동 가드, 대화 단위 조작 권한, 다중 카드, iframe 관찰·조작, Agent 표식 제안 도구.
6. **Rust Mac 도우미 2단계** — .app 번들·권한 버튼·창 캡처·AX 읽기(입력 없음). 번들 ID와 서명 방식을 정해야 한다(ad-hoc 서명은 빌드마다 화면 기록 등 허락이 풀릴 수 있어 확인 필요).
7. **문서 정리** — 비전 문서 체크박스(원장에서 완료가 된 항목, 예: CHAT-04·CHAT-11), atlas 편집 원장에 HUM-ENGINE-002 기록.

근거 문서: [reference-adoption-map.md 4장](../../docs/references/reference-adoption-map.md)(묶음 정의, 4.5 묶음별 요약), [rea-mechanism-adoption.md 5장](../../docs/references/rea-mechanism-adoption.md)(REA 구현 묶음).

**작업자 handoff 파일**: `docs/references/session-handoffs/2026-10-24/handoff-*.md`(1-A, 2-R, 2-CH-rust, 2-CTX, 2-P, 2-X, 2E-connect, 2E-transport, 2RT, decisions)와 결정 기록·묶음 지시문을 세션 scratchpad에서 저장소로 옮겨 보관했다(같은 폴더 README.md). 핵심 계약은 각 커밋 메시지, [engine-adapter-design.md §14](../../docs/references/engine-adapter-design.md), [reference-adoption-map.md 4.5](../../docs/references/reference-adoption-map.md)와 위 3번 목록에 남아 있다. 화면용 세부 모양(SSE 필드, 응답 모양)은 handoff에만 있는 것도 있으니, 파일이 없으면 해당 helper 코드와 시험에서 읽는다.

**대표님이 직접 할 일**:

- Terminal에서 `claude auth login`. 로그인하면 다음 세션이 짧은 실제 왕복 1~2회를 확인한다(빈 임시 폴더에서 먼저 전송만, 그다음 어댑터로 한 번 — engine-adapter-design §14.5).
- Rust 도우미의 앱 전환 감지 확인: 도우미를 띄운 채 앱을 한두 번 바꿔 본다.
- 실제 Firefox 창에서 오늘 바뀐 화면을 눈으로 확인한다.
- 남은 결정: D-C2, REA 5·10, D-B10, D-B11, D-A1, D-A5, D-A6, D-K2, D-K3, D-G4, D-X5(CodeMirror 6과 vendor 설치), D-R2, D-R4~R6(패키징). 나머지(Q4·D-L2·외부 배포·Profile 소유 범위·Agent/Profile 화면 구분)는 아래 '대표님 결정이 필요한 것' 표에 있다.

**확인 필요(실측 전)**: 실제 Codex·Claude 왕복(Claude는 0회), Firefox 고유 동작(닫힌 shadow·WeakRef ref·beforeunload 대화상자 감지), 새 로더 `dfdab56`과 overlay 호환(`scripts/verify-clean-profile-boot.mjs` 실제 실행), Windows 전부.

## 대표님 결정이 필요한 것

2026-10-24 대표님은 [레퍼런스 채택 지도 5장](../../docs/references/reference-adoption-map.md)과 [REA 채택안 6장](../../docs/references/rea-mechanism-adoption.md)의 권고안을 모두 채택했다. Claude 연결(D-S1), Mac 앱 조작(D-C1), 실제 화면 시험(D-C4)은 따로 정했다. 같은 결정이 두 문서와 [computer-use-options.md 5장](../../docs/references/computer-use-options.md)에 결정 ID 그대로 표시돼 있다. 집계: 아래 표 18줄 중 결정됨 11 · 일부 결정 1 · 남음 6.

| 결정 | 선택지와 현재 권고 | 막히는 항목 |
|---|---|---|
| **결정됨(2026-10-24)** Claude 구독 연결 방식 (SUB-12 · D-S1) | **(b)**: 대표님이 직접 설치·로그인한 무수정 `claude`를 EG-Desk가 하위 프로세스로 실행하고, 공식 SDK와 같은 stdio 제어 통로로 승인·질문·중지·도구를 주고받는다. EG-Desk는 토큰에 손대지 않는다. 외부 배포 전에는 Anthropic에 문의한다. (a) 앱 안 claude.ai 로그인은 쓰지 않는다(Anthropic이 승인 없는 서드파티에 금지 [공식, code.claude.com/docs/en/legal-and-compliance]). (c) API 키(종량) 프로필도 두되 키는 EG-Desk가 받지 않고 CLI 공식 로그인에 맡기며, 구독 대화에서 키가 감지되면 시작 전에 멈추고 확인한다(D-S4) | 풀림: SUB-08, SUB-09, SUB-12, AGENT-08. SUB-15는 비용 상한 정책 남음. 연결 구현은 2-E 묶음 |
| **결정됨(2026-10-24)** EG-Desk의 Claude 실행이 `~/.claude` 설정(hooks·CLAUDE.md·MCP·skills)을 물려받을지 (D-S2 · D-S3) | hooks와 개인·claude.ai MCP는 끈다. 로그인은 공유한다. CLAUDE.md·skills는 기본 끄고 선택지로 둔다. 로그인 저장소는 지금은 공유하고, 계정 여러 개가 필요해지면 EG-Desk 전용으로 나눈다 | 풀림: SUB-09. SUB-11은 HUM-ENGINE-001(기본 범위) 남음 |
| **결정됨(2026-10-24)** 구독 나머지 (D-S5 · D-S6) | D-S5 한도 초기화 뒤 자동 이어가기는 기본 끔. D-S6 개인 사용이면 Codex 연결은 지금 방식 유지 | SUB-14, SUB-13 |
| **결정됨(2026-10-24)** 컴퓨터 사용(Desk 밖 앱 제어) Q1~Q3 | 선택지 비교: [computer-use-options.md](../../docs/references/computer-use-options.md). **Q1 (다)**: 일반 대화의 Codex 컴퓨터 조작은 켜 둔 채 표시만 보강(끄기 스위치는 선택지). **Q2 관찰 전용부터**(D-C4 · REA 11): 실제 화면 시험은 앱 목록·창 상태 읽기까지, OS 입력은 보내지 않는다(OS 전면 입력 보류 유지). **Q3 EG-Desk 자체 도우미를 Rust로**(D-C1 · REA 7·8): RT-04 Rust helper와 합친다. cua-driver를 띄우는 권고안은 채택하지 않고 cua-driver(MIT) Rust 코드는 참고·이식한다(출처 표기). 권한은 별도 도우미 .app만 받는다(REA 9). 함께 정한 것: D-C3 Codex '이 앱 써도 될까요' → 허락 카드([이번만 허락]/[거절], 자동 수락 없음), D-C5 앱 범위 기본값(브라우저 보기만, 터미널·IDE 금지, EG-Desk 자신·ChatGPT·Codex·Claude 앱·암호·시스템 설정 금지, Finder 경고 후 허락, 앞으로 가져오기는 작업마다 허락·저장 안 함), D-C6 긴급 중지 키 Ctrl+Alt+Shift+., D-C7 사람 입력 뒤 10초 대기·Agent 입력권 15초 유지·기기 잠금, D-C8 VM을 하게 되면 Lume, REA 12 전역 포인터는 대표님이 화면을 명시적으로 넘긴 경우만 | 풀림: CU-02, CU-03, CU-05. 일부: CU-01, CU-04, CU-06, CU-07, RT-04 |
| 남음 — 컴퓨터 사용 Q4 · D-C2 · REA 10 | Q4 격리 VM을 쓸지(권고: 기본으로 쓰지 않고 위험한 작업·시험용으로 나중에). D-C2 A'(설치된 Codex Computer Use를 동작 하나씩 직접 호출, 비공식) — 지금은 쓰지 않는다. REA 10 Codex 조작 중 대표님이 손대면 자동 중지 — 지금은 표시만 | CU-04, CU-06, CU-01 |
| **결정됨(2026-10-24)** 브라우저 제어 (D-B1~B9 · D-B12 · REA 1~4 · 6) | D-B1 같은 사이트 기본 + 대화마다 허용 사이트 추가(링크·리디렉트에도 같은 규칙). D-B2 허용 사이트 안에서 Agent가 연 카드는 같은 Run 권한 승계(페이지가 연 팝업은 보기만, 사람이 연 카드는 자동 부여 없음). D-B3 조작 허락은 같은 대화 동안(카드·계정·사이트 변경·일시중지·철회·유휴 시 만료, 결제·OAuth 동의는 늘 대표님, 제출·삭제는 확인 후). D-B4 · REA 1 일반 클릭이 효과 없을 때만 새로 관찰 뒤 진짜(trusted) 클릭 1회 + 착지 가드, 별도 도구(키보드 trusted 입력은 2단계). REA 2 조작 허용 카드에는 user activation 부여. D-B5 · REA 4 다른 사이트 iframe 보기+클릭(비밀 칸은 늘 대표님). D-B6 · REA 3 관찰 허용 카드도 스크린샷 전송(비밀·민감 칸, 다른 사이트 iframe, 읽지 못한 창은 가림, 가리기 실패면 보내지 않음). D-B7 팝업 창 안전망 먼저, 그다음 팝업 카드. D-B8 Firefox 컨테이너. D-B9 Firefox 방식. D-B12 실제 사이트 검증은 공개·로그인 불필요 사이트 5~10개. REA 6 일반 Firefox 유지(부분 대체) | BRW-02, BRW-03, BRW-05, BRW-07, BRW-08, BRW-09, BRW-10, BRW-11, BRW-14 |
| 남음 — 브라우저 D-B10 · D-B11 · REA 5 | D-B10 '이 사이트는 항상 이 계정으로' 기억 위치와 기본값. D-B11 로그인 팝업이 스스로 닫히면 로그인 끝남으로 볼지. REA 5 표시점 이동 애니메이션(지금은 승인 순간 바로 나타남) | BRW-02, BRW-04, BRW-13 |
| **일부 결정(2026-10-24)** Agent 캐릭터 설정의 범위 | 정함: 아바타 사진 허용(PNG·JPEG·WebP 512KB 이하, 재인코딩, 내보내기에서 제외, D-A3). Agent 파일 가져오기·내보내기(agency-agents·Claude Code 형식 머리말 .md + Codex .toml 내보내기, 가져온 Agent는 늘 초안, D-A2). 모델은 방에서 따로 고르지 않았을 때만 Agent 모델(D-A4). **남음**: Profile 소유 범위(개인 로컬 / Desk 공유), 기본 제공 6종의 지위(D-A5), 새 Agent 기본 도구 범위(D-A1, 지금 '제한 없음' 유지, 프리셋은 선택지로만), 설명 한 줄로 초안 만들기(D-A6), Agent(담당자 방)와 Profile(설정 버전)을 화면에서 나눠 보여 줄 방식(Q-AGENT-01 앞부분). 남은 것이 정해지기 전에는 "개인 로컬 + 6종은 예시 템플릿"으로 진행 | AGENT-01, AGENT-02, AGENT-04, CHAT-02 |
| **결정됨(2026-10-24)** Board 대화방의 여러 Agent (D-M1~M5) | D-M1 하위 Agent 승인 요청은 지금처럼 거절 + '부모 Agent에게 다시 맡기기'. D-M2 @로 부른 Agent만 답하고, 안 부르면 Lead만. D-M3 개인 대화 → Board는 고른 메시지 복사본 + 원래 대화 링크, 받는 Agent에는 다음 turn에 블록으로 첨부. D-M4 동시 실행 상한 2. D-M5 Codex agent message board는 관찰만 | CHAT-03, CHAT-06, CHAT-10, CHAT-13 |
| **결정됨(2026-10-24)** Chat → Canvas · Canvas · Board (D-K1 · K4 · K5 · D-V1~V6) | D-K1 AI 표식은 대상 카드 위 점선 '제안'으로 바로(카메라 안 움직임). D-K4 Agent가 게시한 결과는 칩으로만(자동 열기 없음), 같은 결과 수정은 버전 2. D-K5 메모 질문의 답은 메모 답글로 자동. D-V1 한 창은 한 Board. D-V2 새 창 자동 소속 없음(영역 안에서 열거나 놓을 때 제안). D-V3 끌어 놓기 = 제안 칩. D-V4 새 Board 저장 = 그 자리 영역으로 묶기(사본 없음). D-V5 격자·안내선 맞춤 + 배치 실행 취소 + 겹침 없이 정리. D-V6 채팅 엿보기는 오른쪽 가장자리 대기(Zen 방식) | CNV-03, CNV-05, CNV-06, CHAT-08, UX-05, UX-06 |
| 남음 — Canvas D-K2 · D-K3 | D-K2 상단 검색 요청의 수신자와 Tab 키. D-K3 CHAT-04 결과 카드 저장 방식(지금은 Desk·Board와 함께 저장되는 Canvas 카드 — 확정할지, '파일로 저장'을 나중에 더할지) | UX-04, CHAT-04 |
| **결정됨(2026-10-24)** 디자인 (D-G1 · G2 · G3 · G5) | D-G1 13px 기준 토큰. D-G2 (가) 아바타는 옅은 배경 + 진한 잉크 글자. D-G3 (가) 입력칸 테두리는 대비 증가·고대비에서만 진하게. D-G5 (가) CSS 원본·토큰 표는 시험 기준만 | DSN-03, DSN-04 |
| **결정됨(2026-10-24)** 코딩 (D-X1~X4 · X6) | D-X1 원본 파일 덮어쓰기는 사용자 저장·검토 중 되돌리기만(열 때와 해시가 다르면 비교 화면). D-X2 1단계 승인 전 '변경 보기' + 전체 허용/거절 → 2단계 적용 후 덩어리별 되돌리기. D-X3 프로젝트 폴더는 Board에 붙이고 채팅방은 상속, 재시작 뒤 같은 폴더(dev/ino)일 때만 자동 재연결. D-X4 회차별 git checkpoint 기본 끔. D-X6 '검사'·IDE는 사용자가 직접 입력한 명령만 | CODE-02, CODE-04, CODE-05, CODE-06 |
| **결정됨(2026-10-24)** 런타임 (D-R1 · R3) | D-R1 자동 저장 묶음 60초, 복구 기록 보존은 현재 임시값(최근 200개 + 30일간 하루 1개, 512MiB). D-R3 Board 내보내기에 첨부·캡처 기본 끔 | CTX-02, RT-03 |
| 남음 — 디자인·코딩·런타임 D-G4 · D-X5 · D-R2 · D-R4~R6 | D-G4 화면 모드 '시스템·밝게·어둡게' 직접 선택. D-X5 편집기 기준 CodeMirror 6과 vendor 설치. D-R2 자료 추천 기본 방식과 '절대 추천 안 함' 목록. D-R4~R6 패키징 경로·업데이트 방식·터미널/Node 동봉·트레이 | DSN-01, CODE-04, CTX-03, RT-02, RT-04 |
| **결정됨(2026-10-24)** 레퍼런스 이식 범위 (D-L1) | MIT·Apache·BSD는 출처 표기 후 이식, MPL은 패턴만, GPL·AGPL·FSL·ELv2·tldraw·LobeHub은 패턴만 | — |
| 남음 — 레퍼런스 서재 등록 (D-L2) | 대표님 메모: 확장 등록은 하지 않고 조사만 | — |
| 남음 — 외부 배포 계획 | 배포형이면 Codex는 Sign in with ChatGPT client ID(현재 선택된 파트너 대상), Claude는 외부 배포 전 Anthropic 문의(D-S1). 개인 사용이면 지금 방식 유지(D-S6, 결정됨). 패키징은 D-R4~R6(남음) | SUB-13, RT-02 |

아래 영역 표의 "결정" 열은 2026-10-24 기준으로 **결정됨**(그 항목에 걸린 결정을 모두 정함) · **일부 결정**(일부만 정함) · **필요**(아직 안 정함)로 적고 결정 ID를 붙였다. 빈칸은 결정이 걸리지 않은 항목이다.

## 진행 순서

| 묶음 | 항목 | 이유 |
|---|---|---|
| 1 (진행 중) | CHAT-12 Agent 질문 응답, CHAT-13 하위 Agent 진행·막힘 | Codex 회차가 남긴 다음 우선순위. 승인·질문 뒤 같은 작업 이어가기 |
| 2 | AGENT-07·SUB-05 설정 카드의 가짜 데이터 제거, SUB-03 요금제·사용 한도 표시, SUB-14 인증 실패·한도 소진 구분, RT-05 브리지 재연결 UX | 지금 화면이 사실과 다른 정보를 보여 주는 곳부터 바로잡는다 |
| 3 | AGENT-01 Profile 저장소 → AGENT-03 실행 적용·기록 → CHAT-02 Profile 편집 → AGENT-02 Agent 만들기(이름·아바타·말투·전문 영역) → AGENT-05/CHAT-07 정체성 표시, CHAT-01 프로필 영속화 | Agent 캐릭터 설정 |
| 4 | SUB-06 실행 엔진 계층(EngineAdapter) → SUB-07 엔진·모델 선택 UI → (결정 후) SUB-08/09/10 Claude 엔진 | Codex+Claude 구독 지원. 엔진 계층은 결정과 무관하게 먼저 만든다 |
| 5 | BRW-05 navigate, BRW-06 스크롤·키 입력·대기, BRW-11 여러 턴 조작 권한, BRW-07 다중 카드, BRW-13 Agent 브라우저 활동 표시, BRW-01 툴바, CU-07 상속 MCP 가시화 | 브라우저 제어 |
| 6 | UX-03 Agenda→Board 용어, CNV-04 화살표·펜·레이블·하이라이트, CNV-01 Board 영역 시각, CNV-02 배치 정책, UX-01 보이는 Board 감지, DSN-02 팔레트 정리, DSN-01 다크 테마, DSN-04 접근성 | UI/UX·디자인 |
| 7 | CODE-07 IDE 진입, CODE-05 변경 diff, CODE-06 실행·테스트 결과, CODE-02 프로젝트 폴더, CTX-04 Context 확인·수정 | 코딩 화면 |
| 8 | CHAT-04/08 결과 카드·칩, CHAT-09 세션 배지, CHAT-05/CNV-07 Briefing 완성, CNV-05/06 AI 주석·Memo, CHAT-06 의존성 그래프, CHAT-03/10 Board Thread 다중 Agent, CU-01~05 컴퓨터 사용, RT-01~07 | 큰 항목·결정 의존 항목 |

## Chat · Agent · 캐릭터 설정

Chat·Agent·캐릭터성 영역은 "고른 프로필을 실제 지침으로 보내는 길"과 "Answer Briefing"까지는 코드로 있고, 그 위의 사용자 경험은 대부분 없다. 지금 사용자는 대화방 ⋯ 메뉴에서 개발용 고정 프로필 6개 중 하나를 고를 수 있고, 그 지침은 Codex developerInstructions로 실제 전달된다(codex-chat-runtime.mjs:733-738). 반면 Agent를 직접 만들거나(이름·아바타·말투·성격·전문 영역·도구 권한) 저장·적용하는 기능은 없다. Dock에서 여는 설정 카드의 'Agent 관리'·계정·모델 탭은 가짜 데이터를 실제처럼 보여 주는 mock이다(고정 이메일·'Pro' 플랜·GPT-4.1 목록, eg-desk-surface.uc.js:7751-7777). 프로필 선택은 Desk 세션 pref에서만 유지되고 SQLite 기록 저장소와 저장 Board에는 남지 않는다. Board Thread는 이름만 있는 참여자 목록일 뿐 실제 다중 Agent도, Board 연결도 없다. 의존성 스케줄러는 helper 라이브러리와 테스트만 있고 브리지·UI에는 연결되지 않았다. Answer Briefing은 핵심 흐름이 구현·검증됐지만 다중 대상·강조·독립 Comment 객체가 빠져 있다. A(requestUserInput)와 B(collab/subAgent)는 코드 흔적이 없어 기존 계획과 중복되지 않는다.

| ID | 상태 | 크기 | 대표님 화면에서 달라지는 점 | 결정 | 환경 제약 |
|---|---|---|---|---|---|
| CHAT-12 | 완료 | M | Agent가 작업 중에 물어보면 Chat 안에서 바로 답하고 같은 작업이 이어진다. |  |  |
| CHAT-13 | 완료 | M | Agent가 하위 Agent에게 일을 나눴을 때 누가 무엇을 하고 어디서 막혔는지 Chat에서 보인다. | 결정됨(D-M1) |  |
| AGENT-07 | 완료 | S | 설정 화면에 실제로 연결된 계정과 실제로 쓸 수 있는 Agent만 보인다. |  |  |
| CHAT-01 | 일부 | M | 앱을 껐다 켜거나 Board를 다시 열어도 대화방마다 고른 Agent가 그대로 남는다. |  |  |
| AGENT-01 | 완료 | L | 내가 만든 Agent 설정이 저장되고, 고친 뒤에도 이전 버전으로 되돌릴 수 있다. | 필요 |  |
| AGENT-03 | 완료 | M | 내가 정한 말투와 맡길 일이 실제 답변에 반영되고, 어떤 설정으로 답했는지 나중에 확인할 수 있다. |  |  |
| CHAT-02 | 완료 | L | Agent의 역할과 지침을 화면에서 확인하고 고쳐서 다음 대화부터 적용할 수 있다. | 필요 |  |
| AGENT-02 | 완료 | L | 이름·얼굴·말투·전문 분야를 정한 나만의 Agent를 만들어 그 Agent와 대화방에서 일할 수 있다. | 일부 결정(D-A2·A3·A4 정함, Agent/Profile 화면 구분·D-A6 남음) |  |
| AGENT-05 | 일부 | M | 어떤 Agent가 지금 무엇을 하고 있는지 얼굴과 작업 표시로 바로 알아보고, 눌러서 기록을 볼 수 있다. |  |  |
| CHAT-07 | 완료 | M | Agent 얼굴을 누르면 그 Agent의 역할과 최근 작업 기록이 한 곳에 펼쳐진다. |  |  |
| AGENT-04 | 완료 | L | '읽기만 하는 Agent'처럼 정해 두면 그 Agent는 실제로 파일 수정이나 브라우저 조작을 하지 못한다. | 일부 결정(D-A2 정함, D-A1 남음) |  |
| CHAT-09 | 완료 | M | 대화방이 이어진 대화인지, 새 대화인지, 갈라져 나온 대화인지 목록에서 바로 구별된다. |  |  |
| CHAT-04 | 완료 | M | Agent 답변을 버튼 하나로 Canvas 카드로 꺼내 Board에 남겨 둘 수 있다. | 필요(D-K3) |  |
| CHAT-08 | 일부 | M | 긴 보고서는 Canvas 카드로 열리고 Chat에는 짧은 설명과 바로가기만 남아 대화가 읽기 쉽다. | 결정됨(D-K4) |  |
| CHAT-11 | 완료 | S | 대화 목록과 메뉴에서 Board라는 같은 이름으로 보여 헷갈리지 않는다. |  |  |
| CHAT-05 | 일부 | M | 답변 브리핑에서 여러 근거를 한 번에 강조해 보며, 남긴 단계 의견이 사라지지 않고 남는다. |  |  |
| CHAT-06 | 완료 | L | 앞 작업이 끝나면 다음 Agent 작업이 알아서 시작되고, 무엇 때문에 기다리는지 화면에 보인다. | 일부 결정(D-M4 정함, 자동 시작 기본값·사용량 한도 남음) |  |
| AGENT-08 | 일부 | M | Agent마다 Codex로 돌릴지 Claude로 돌릴지 정해 두면 그 구독으로 답한다. | 결정됨(D-S1·D-A4) | 있음 |
| CHAT-03 | 일부 | L | 개인 대화에서 시작한 일을 Board 대화방으로 넘기고, 필요한 메시지만 골라 같이 볼 수 있다. | 결정됨(D-M3) |  |
| CHAT-10 | 일부 | XL | Board 대화방에서 여러 Agent가 각자 맡은 일을 하고, 누가 진행 중이고 누가 막혔는지 한눈에 보인다. | 결정됨(D-M1·M2·M4) |  |
| AGENT-06 | 완료 | S | 고른 Agent 설정이 실제 답변 지침으로 들어간다. |  |  |

<details><summary>항목별 근거·빠진 것·구현 스케치</summary>

### CHAT-12 — (이미 정해진 A) Codex app-server item/tool/requestUserInput 질문에 답하는 Chat UI

- 출처: 작업 지시: 이미 정해진 다음 구현 대상 (A)
- 상태: 없음 · 크기 M
- 근거: helper/codex-chat-runtime.mjs: server request 처리는 item/tool/call(L1230)과 approval/dynamic 이벤트(L1288-1289)만 있음. helper/*.mjs·overlay 전체 grep 'requestUserInput' 0건.
- 빠진 것: 요청 수신·대기 상태·답변 전송 경로와 Chat UI가 모두 없음. 중복 판별만 함(깊게 보지 않음).
- 구현 스케치: codex-chat-runtime.mjs handleServerRequest에 requestUserInput 분기 추가(run에 pendingQuestion 저장, SSE emit) → EGDeskChatState.sys.mjs reducer → eg-desk-surface.uc.js 메시지 스택에 질문 카드·답변 버튼. 기존 approval 응답 경로(receiveApproval)를 본뜬다.

### CHAT-13 — (이미 정해진 B) collabAgentToolCall/subAgentActivity 기반 하위 Agent 진행·막힘 표시

- 출처: 작업 지시: 이미 정해진 다음 구현 대상 (B)
- 상태: 없음 · 크기 M
- 근거: helper/codex-chat-runtime.mjs safeItem switch(L31-56)에 agentMessage/reasoning/plan/commandExecution/fileChange/mcpToolCall/dynamicToolCall만 있고 collabAgentToolCall 분기 없음. grep 'collab\|subAgentActivity' 0건.
- 빠진 것: 하위 Agent 항목을 공개 이벤트로 변환하는 경로와 표시 UI 없음. 중복 판별만 함.
- 구현 스케치: safeItem에 collabAgentToolCall 공개 필드 추가 → applyItem → renderCodexActivityPanel(eg-desk-surface.uc.js:982)과 메시지 스택에 하위 Agent 행. CHAT-10(Board Thread 참여 상태)의 기반이 된다.

### AGENT-07 — 설정 카드의 가짜 계정·모델·Agent 목록(mock)을 실제 상태로 교체하거나 숨김

- 출처: 코드 조사 결과 + 사용자 요청(구독 요금제 지원, 캐릭터성 설정) + Contract §14 'Profile은 계정 grant가 아니다'
- 상태: 일부 · 크기 S
- 근거: eg-desk-surface.uc.js:7751 SETTINGS_MODELS(GPT-4.1·Claude 4 Sonnet·Gemini 2.5 하드코딩), :7759 CODEX_ACCOUNT(고정 이메일·plan 'Pro'·loggedIn true), :7773 SETTINGS_AGENTS(메모리 배열). 로그인 버튼은 고정 이메일을 대입만 함(providers 탭). 설정 카드는 Dock '설정'(:70, :4221-4222)에서 열림.
- 빠진 것: 사용자가 Dock에서 여는 설정 카드가 실제 Codex 인증·모델·Agent와 무관한 가짜 정보를 실제처럼 보여 준다. 저장·적용 없음.
- 구현 스케치: providers 탭은 state.codex.authStatus(실제 auth 상태)로 교체하거나 '준비 중'으로 숨김, models 탭은 숨김(구독 영역 작업에서 model/list로 교체), Agent 탭은 CODEX_AGENT_PROFILE_DEFS 읽기 전용 목록으로 우선 교체. spawnSettingsCard(:9709) 안에서만 수정.

### CHAT-01 — 채팅 프로필 선택을 브라우저 재시작·Board 복원 후에도 유지

- 출처: EGDESK_PRODUCT_VISION_AND_DEV_TODO.md P0 L176
- 상태: 일부 · 크기 M
- 근거: Desk 세션 pref 경로는 thread 전체(profileEnabled/agentProfileId/systemPrompt)를 저장(eg-desk-surface.uc.js:1628-1631 serializeDeskSnapshot)하고 복원 때 정규화(:5721-5735). 반면 SQLite chat store threads 테이블은 title만 보관(helper/egdesk-chat-store.mjs:156-159, shape L352). store 기반 복원 ensureLocalHistoryThread(:5942)는 page.thread(EGDeskChatState.sys.mjs:313)에서 profile을 읽으므로 항상 profileEnabled=false. 저장 Board의 chat card는 activeThreadId/chatDockMode만 저장(:1558-1562). scripts/verify-chat-history-restart.mjs에 profile 단언 없음.
- 빠진 것: durable store에 thread의 profile binding이 없음. Desk pref가 유실되거나 legacy 이관 뒤 store에서 복원하면 profile이 사라짐. Board 저장·복원 record에 thread binding 없음. 재시작 검증 없음.
- 구현 스케치: egdesk-chat-store.mjs threads에 profile_binding_json(profileId, revision, profileEnabled) 추가(또는 thread.config event) → /chat/history/threads 응답에 포함 → EGDeskChatState threadSnapshot → ensureLocalHistoryThread가 복원. Board chat card record(:1558)에 threadId·binding 참조 추가. verify-chat-history-restart.mjs에 profile 단언 추가. AGENT-01 이후에는 profileId+revision만 저장.

### AGENT-01 — Agent Profile 저장소: 안정 ID·owner·activeRevision, 불변 revision, draft/active/disabled/archived/deleted 수명, expectedRevision 충돌 처리

- 출처: Contract §14 L1030-1098, §17.C 'Profile revision과 Engine adapter' L1786-1813; Atlas §5.2 L2664-2680
- 상태: 없음 · 크기 L
- 근거: Profile은 eg-desk-surface.uc.js:101-192 CODEX_AGENT_PROFILE_DEFS 6개 상수뿐. helper에 profile 저장소·HTTP route 없음(codex-bridge-server.mjs import L1-26에 해당 모듈 없음). thread에는 systemPrompt 원문이 인라인 복사됨(:334).
- 빠진 것: 사용자가 만든 Profile을 저장할 곳, revision·수명 상태, 조회/저장/활성화 API가 없음.
- 결정: Q-AGENT-02: Profile 소유 범위(개인 로컬만 vs Desk 공유)와 기본 제공 Profile을 제품에 둘지(현재 개발용 6종)·예시만 둘지·없앨지. 결정 전에는 '개인 로컬 전용 + 6종은 예시 템플릿'으로 진행 가능.
- 구현 스케치: helper/egdesk-profile-store.mjs 신설(SQLite, egdesk-chat-store.mjs와 같은 dataDir·ownerScope 패턴): profiles(id, owner, activeRevision, lifecycle), profile_revisions(hash, parent, author, body_json). helper/egdesk-profile-http.mjs로 GET/POST/activate 라우트, codex-bridge-server.mjs에 mount. 6종 상수는 최초 실행 시 템플릿으로 seed.

### AGENT-03 — 선택한 Profile(성격·지침)을 실제 실행에 적용하고 Run에 profileId+revision binding을 기록

- 출처: Contract §14 'Run identity와 출발 조건' L1047-1062; CHAT_AGENT_PROFILE_RUNTIME.md; 사용자 요청(캐릭터성 적용)
- 상태: 일부 · 크기 M · 선행: AGENT-01
- 근거: 전달 경로는 동작: codex-chat-runtime.mjs:733-738 profileEnabled 시 systemPrompt(최대 8000자)를 native developerInstructions로 전달, 프로필 변경 시 thread/unsubscribe 후 resume(:884-907). 테스트 helper/codex-chat-runtime.test.mjs:296, 897, 1476, 1491. 단 Run/store에 어떤 profile·revision이 적용됐는지 기록 없음, personality와 instructions 구분 없이 단일 문자열.
- 빠진 것: personality/instructions를 합성하는 규칙 없음, Run binding(profileId·revision·hash) 기록 없음, 활동 기록에서 적용 Profile 확인 불가.
- 구현 스케치: EGDeskChatState.buildChatRequest(L433-442)가 profileId+revision만 보내고, 런타임이 AGENT-01 store에서 revision을 읽어 personality+instructions를 developerInstructions로 합성(threadOverrides). run checkpoint·chat store event details에 profileBinding 기록 → renderCodexActivityPanel에 표시.

### CHAT-02 — 설정 패널(Canvas 카드)에서 Agent Profile/지침 전체를 보고 편집·초안 저장·차이 보기·활성화

- 출처: EGDESK_PRODUCT_VISION_AND_DEV_TODO.md P0 L177; UX proposal #ux-detail-agent-profile L2228-2290; Atlas AGENT-01 L752-766
- 상태: 일부 · 크기 L · 선행: AGENT-01, AGENT-07
- 근거: 실제 profile은 thread ⋯ 메뉴에서 6개 중 선택만 가능(eg-desk-surface.uc.js:4811-4834, setThreadAgentProfile :6484-6497). 지침 보기·편집 UI 없음. 설정 카드 'Agent 관리' 탭(:9857-9934)에 편집 폼이 있으나 mock 배열만 수정(AGENT-07).
- 빠진 것: Profile 목록·상세(선언/현재 연결/이번 Run 기능)·편집·초안 저장·활성화·사용 중단 UI 없음.
- 결정: 지침 원문을 사용자에게 그대로 보여줄지, 요약·hash만 보여줄지(Contract §14 L1088-1090: 원문 노출은 필수 아님, Atlas AGENT-01 #1 경계).
- 구현 스케치: spawnSettingsCard(:9709)의 agents 탭을 AGENT-01 HTTP 기반 'Profile 관리'로 교체: 목록 행(이름·역할·활성 revision·상태) → 상세 → 편집 폼 → 초안 저장 → 차이 보기 → 활성화. Chat header ⋯에 '담당자 설정' 진입 추가(Atlas L731).

### AGENT-02 — Agent 만들기: 이름·아바타·말투/성격·전문 영역(맡길 일)·도구 후보·모델을 사용자가 정하고 저장 후 담당자 방으로 사용

- 출처: 사용자 요청(에이전트 캐릭터성 설정); Atlas §0.4 L148-200, §5.2 L2664-2680; UX proposal #ux-detail-agent-draft-validation
- 상태: 없음 · 크기 L · 선행: AGENT-01, CHAT-02, AGENT-03
- 근거: 사용자 정의 Agent 생성 경로 없음. 아바타는 제목 첫 글자+id 해시 색(eg-desk-surface.uc.js:4903-4904), 메시지 아바타는 작성자 첫 글자(:5185). personality 필드 자체가 profile 정의(:101-192)에 없음. 'Agent 만들기' 폼은 mock(:9857-9934).
- 빠진 것: 캐릭터 필드(이름·아바타·말투·성격·전문 영역·도구) 입력·저장·활성화와, 만든 Agent의 담당자 방 생성이 모두 없음.
- 결정: Q-AGENT-01: Agent(담당자 방 정체성)와 Profile(설정 revision)을 화면에서 어떻게 나눠 보여줄지; 아바타를 이미지 업로드까지 허용할지(이모지·색·이니셜만 vs 파일).
- 구현 스케치: 설정 카드 또는 Chat 방 목록에 [Agent 만들기] 폼(담당자 이름 필수, 나머지는 '미설정' 허용) → AGENT-01 draft 저장 → [사용 준비]에서 빠진 항목 표시 → 활성화 → createCodexThread(:302)로 agentId·profileId를 가진 dm thread 생성. personality는 별도 필드로 저장해 AGENT-03 합성에 사용.

### AGENT-05 — Agent 정체성 표시: 메시지 작성자 아바타·이름, 작업 중 생각 버블 [···]+'Agent 작업 중', 버블 클릭 시 기록 패널, 실제 작업 대상의 Agent 배지

- 출처: Atlas #atlas-agent-thought-space L210-225; Contract §4.1 L530-540
- 상태: 일부 · 크기 M · 선행: AGENT-02
- 근거: profileEnabled thread의 streaming 메시지에만 typing dots 표시(eg-desk-surface.uc.js:5166-5172, aria-label '응답 중'), 클릭 불가. 기록 패널은 존재(renderCodexActivityPanel :982)하지만 '활동' 칩(:5178-5181)으로만 열림. Browser 대상 표시 marker는 일반 표시(96e1a74 egd-browser-agent-target)로 Agent 정체성 없음.
- 빠진 것: 아바타가 사용자 지정값을 반영하지 않음, 생각 버블 클릭→기록 패널 연결 없음, 작업 대상 배지에 어떤 Agent인지 표시 없음.
- 구현 스케치: 메시지 avatar(:5183-5187)와 방 목록 avatar(:4903)를 profile identity(avatar/color/name)로 렌더. typing dots를 button으로 바꿔 openCodexActivityPanel 호출. createBrowserAgentProjection(96e1a74)에 profile 이니셜·색 전달.

### CHAT-07 — 아바타/프로필 클릭 시 상세 peek: 정체성(이름·역할·모델·도구·Board 연결)과 plan/run/action/context 기록 층

- 출처: EGDESK_PRODUCT_VISION_AND_DEV_TODO.md P1 L210; apps/firefox-ui-demo/docs/CHAT_CANVAS_AGENT_LAYER_MODEL.md L181-240
- 상태: 일부 · 크기 M · 선행: AGENT-01
- 근거: 기록 층 내용은 활동 패널에 이미 있음: run 상태·context 읽기·전달 payload·plan steps·activity 행·승인(eg-desk-surface.uc.js:982-1060). 진입은 '첨부 입력 · 기록 보기' 칩(:5178-5181)과 openActivity(:6305)뿐. 메시지 아바타는 aria-hidden div(:5183-5187)로 클릭 불가, 프로필 정체성 섹션 없음.
- 빠진 것: 아바타·프로필 칩 클릭 진입점, 프로필 정체성 요약(모델·도구·최근 Run) 섹션.
- 구현 스케치: avatar·egd-codex-agent-profile-chip을 button으로 바꾸고 openCodexActivityPanel에 profile 섹션(이름·역할·toolMode·모델·최근 run 목록) 추가. AGENT-01 전에는 CODEX_AGENT_PROFILES 값으로 먼저 표시 가능.

### AGENT-04 — Profile별 도구 권한 상한(tool/capability ceiling)을 실제 실행에 집행

- 출처: Contract §14 'effective action set' L1064-1066, §17.B L1590; Atlas §5.2 tools/capability ceiling; 사용자 요청(도구 권한)
- 상태: 없음 · 크기 L · 선행: AGENT-01, AGENT-03
- 근거: toolMode는 표시 칩 전용: helper/*.mjs(테스트 제외) grep 'toolMode\|agentProfile' 0건. 실제 실행 정책은 readOnlyQa/browserBounded/fixtureBrowserQa 3종뿐(helper/codex-chat-execution-policy.mjs:3-13)이며 profile과 연결 안 됨.
- 빠진 것: Profile이 선언한 도구(Browser 조작·파일 쓰기·Terminal 명령·네트워크)를 thread/start 설정·dynamicTools 선택·승인 정책으로 좁히는 경로가 없음.
- 결정: 사용자에게 보여줄 도구 분류(예: Browser 보기/조작, 파일 읽기/쓰기, Terminal 명령, 인터넷)와 새 Agent의 기본 권한 수준.
- 구현 스케치: profile revision에 toolCeiling 필드 → codex-chat-runtime.mjs collectToolSpecs(:916 부근)에서 ceiling 밖 dynamic tool 제외, thread/start·resume의 sandbox/approvalPolicy를 ceiling으로 제한, 위반 시 거절 이벤트. codex-chat-runtime.test.mjs에 ceiling별 케이스.

### CHAT-09 — 대화방/세션 배지: Resumed, Fresh, Forked, Stateless

- 출처: EGDESK_PRODUCT_VISION_AND_DEV_TODO.md P1 L212
- 상태: 일부 · 크기 M
- 근거: codexThreadSessionLabel(eg-desk-surface.uc.js:266)이 Local/Resumed/Fresh만 반환, 방 목록 배지(:4915 부근)·CSS(overlay/CSS/eg-desk-surface.uc.css:2834-2867). helper에 thread/fork 사용 없음, ephemeral은 스키마 probe 확인만(helper/codex-native-schema-probe.mjs:82).
- 빠진 것: Forked(의도적 분기)·Stateless(ephemeral) 상태와 이를 만드는 동작이 없음.
- 구현 스케치: Stateless: thread/start ephemeral 옵션 + thread.stateless 표시. Forked: app-server의 fork 지원 여부를 schema probe로 먼저 확인(미확인) 후 '이 지점에서 분기' 메뉴 → 새 clientThreadId + forkedFrom 기록. 배지는 codexThreadSessionLabel 확장.

### CHAT-04 — Chat 요약/결과 칩에서 Canvas 결과 카드 만들기

- 출처: EGDESK_PRODUCT_VISION_AND_DEV_TODO.md P0 L179; Contract §4 L486-490(chip은 비영속, 연결된 artifact는 영속)
- 상태: 없음 · 크기 M
- 근거: buildCodexResultChips(eg-desk-surface.uc.js:609-621)는 답변이 참조한 기존 파일 열기만 함. 카드 생성 함수는 chat/ontology/file/settings/browser/terminal뿐(spawn*Card :7041, :9317, :9606, :9709, :10575, :12397), 결과·메모 카드 없음. 관리 초안 쓰기 기반은 있음(helper/egdesk-managed-drafts.mjs, File Card).
- 빠진 것: 답변 본문·요약을 Canvas 카드로 남기는 동작과 그 카드와 원 답변(answerId/runId) 연결이 없음.
- 결정: 결과 카드를 파일(관리 초안 .md, File Card로 열림)로 저장할지, Board 안의 메모 카드로만 둘지.
- 구현 스케치: 메시지 스택(:5147-5178)에 '카드로 남기기' 버튼 → egdesk-managed-drafts 경로로 .md 생성 → spawnFileCard(:9606)로 열고 sourceRef에 answerId/runId/conversationId 기록 → 결과 칩이 그 카드를 focus.
- 진행(2026-10-24, 원장 정정): `8dc695d` — 끝난 답변의 '카드로 보기'가 Canvas 결과 카드로 남긴다(출처 줄, '채팅에서 보기'로 원래 답변으로 돌아감, 열린 카드 재사용, Desk·Board와 함께 저장). 위 스케치의 .md 파일 경로가 아니라 Desk·Board에 저장되는 카드로 구현됐다. 화면 시험 543/543, 렌더링 fixture 72/72, headless 다크 UI 회귀 274/274. 상태 없음 → 완료.
- 남은 것(2026-10-24): 저장 방식 확정(D-K3: 지금 방식으로 확정할지, '파일로 저장'을 나중에 더할지)은 미결정. 실제 Firefox 창 미검증.

### CHAT-08 — 긴 출력을 Canvas 결과로 보내고 Chat에는 연결 칩만 두기

- 출처: EGDESK_PRODUCT_VISION_AND_DEV_TODO.md P1 L211; Contract §4 L484-490
- 상태: 일부 · 크기 M · 선행: CHAT-04
- 근거: 칩은 usableArtifact 파일 참조(eg-desk-surface.uc.js:609-621)와 브리핑 버튼(:5148-5150)만. 기본 profile 지침이 '긴 출력은 canvas로'라고 요구하지만(:111-114) Agent가 Canvas 출력을 만들 도구는 없음(context 도구는 egdesk_publish_briefing 등 읽기·브리핑만, helper/egdesk-context-runtime.mjs:10).
- 빠진 것: Agent가 긴 결과를 Canvas 산출물로 게시하는 도구와 그 칩 표시.
- 구현 스케치: egdesk-context-runtime.mjs에 egdesk_publish_output(제목·markdown) dynamic tool 추가 → CHAT-04의 결과 카드 생성 경로 재사용 → artifactRefs로 칩 표시.

### CHAT-11 — Chat UI의 'Agenda' 표기를 제품 용어 Board로 정리

- 출처: EGDESK_PRODUCT_VISION_AND_DEV_TODO.md L9-11(Board가 제품 용어, UI 일부 Agenda 잔존)
- 상태: 일부 · 크기 S
- 근거: THREAD_KIND_META.group label 'Agenda'/'Agenda Thread'/'새 Agenda Thread'(eg-desk-surface.uc.js:93-98), 필터 'Agenda'(:4792), 멤버 메뉴 'Agenda에서 제거'(:5058), subtitle 'Agenda Thread · 멤버 N명'(:281).
- 빠진 것: 화면 문구가 Agenda로 남아 있음(내부 식별자는 유지 가능).
- 구현 스케치: 표시 문자열만 교체(THREAD_KIND_META, 필터, 멤버 메뉴, buildThreadSubtitle). Firefox MCP 검증 스크립트의 문자열 단언 함께 갱신.
- 진행(2026-10-24, 원장 정정): `163a60e`(UX-03과 같은 커밋)에서 화면 문구가 Board로 바뀜(내부 식별자 유지). 지금 코드: 'Board Thread', '새 Board Thread', 'Board Thread · 멤버 N명', 'Board Thread에서 제거'. 상태 일부 → 완료.

### CHAT-05 — Canvas run playback → Answer Briefing(단계 탐색·카메라 이동·단계 의견을 다음 Chat 초안에 넣기)

- 출처: EGDESK_PRODUCT_VISION_AND_DEV_TODO.md P0 L180; Contract §8 L816-855, §17.B 'Briefing·Step·Comment 계약' L1713-1725; Atlas AI-05 L1025, OBJ-038 L2416
- 상태: 일부 · 크기 M
- 근거: 핵심 구현·검증 흔적 있음: egdesk_publish_briefing 도구(helper/egdesk-context-runtime.mjs:10, 182-187), EGDeskBriefingState.sys.mjs(70줄), openAnswerBriefing/renderAnswerBriefing(eg-desk-surface.uc.js:860-945), 단계 의견→초안 attachBriefingComment(:6467-6479), 커밋 b135ef9·f370eab·4e920cd·824c632·1453889, scripts/verify-firefox-mcp-context-briefing.mjs.
- 빠진 것: 단계당 대상 1개(resolveBriefingTargets가 [step.target]만 처리), visibility·dimming·emphasis 상태 없음, 대상이 sourceId/artifactId뿐(Canvas 도형·출력 불가), Comment가 독립 객체(commentId·revision)가 아니라 초안 텍스트로 바로 변환됨. 비전 문서 체크박스도 미갱신.
- 구현 스케치: briefing step schema를 targets[] + emphasis로 확장(egdesk-context-runtime.mjs tool schema, BriefingState.resolveBriefingTargets/briefingBounds), Canvas dimming 클래스 적용, Comment를 context store record로 저장 후 초안에 참조로 첨부(dedupe draftId+commentId).

### CHAT-06 — 의존성 그래프·Task 상태 registry와 자동 하류 시작; 사용자 행동 대기를 dependency gate 한 종류로 모델링

- 출처: EGDESK_PRODUCT_VISION_AND_DEV_TODO.md P0 L181; Contract §9 L858-890, §11 L914-930
- 상태: 일부 · 크기 L · 선행: CHAT-13
- 근거: helper/egdesk-task-graph.mjs(b779e42): queued/waiting-on-dependency/ready/approval-required 상태와 ready 시 자동 execute(L147-151, L653), atomic journal; native adapter·HTTP(d18298c, egdesk-task-native.mjs, egdesk-task-http.mjs:37 createTaskHttpHandler); 테스트 12+14+5개. 그러나 codex-bridge-server.mjs(import L1-26)에 mount 안 됨, UI(eg-desk-surface.uc.js) grep 'dependency\|graphId' 0건. gate는 dependsOn+approvalRequired만(task-graph.mjs:67-79).
- 빠진 것: 브리지 mount, Agent/사용자가 그래프를 만드는 경로, Chat/Canvas의 막는 조건 표시, OAuth·파일 도착·Terminal 종료 같은 사용자 행동 gate 종류.
- 결정: 자동 시작 기본값과 동시 실행 상한(현재 maxConcurrency=2), 하위 작업이 쓰는 구독 사용량 한도.
- 구현 스케치: codex-bridge-server.mjs에서 openTaskGraph + createTaskHttpHandler mount → task 상태를 SSE로 UI에 전달 → Chat '진행 N건' 행과 Canvas 업무 projection(UX #ux-detail-run-control). gate 타입 필드(userAction/oauth/file/terminalExit) 추가해 approvalRequired를 그 중 하나로 일반화.

### AGENT-08 — Profile의 provider/model 정책: Agent마다 Codex 또는 Claude 구독 Engine·모델을 고름

- 출처: 사용자 요청(Codex+Claude 구독 요금제 지원, 캐릭터성 설정); Atlas §5.2 provider/model policy; Contract §17.C 모델 선택 순서 L1811
- 상태: 없음 · 크기 M · 선행: AGENT-01, 다른 영역: Claude 구독 Engine 연결
- 근거: thread 런타임은 Codex app-server 단일 경로(codex-chat-runtime.mjs). profile 정의(eg-desk-surface.uc.js:101-192)에 provider/model 필드 없음. 설정 카드의 Claude 모델 표시는 mock(:7751).
- 빠진 것: Profile에 Engine/모델을 지정하고 그 Engine으로 실행하는 경로 없음.
- 결정: Claude 구독 연결 방식(Aside처럼 로컬 CLI 로그인 재사용 여부)은 구독 영역 결정을 따름.
- 환경 제약: 실제 Claude 구독 계정 로그인 없이는 실행 검증 불가.
- 구현 스케치: profile revision에 engine(codex\|claude)·model 필드 → 런타임 선택기가 Engine adapter로 분기. Codex 쪽은 threadOverrides model(:730-733) 재사용.

### CHAT-03 — Agent DM에서 Board Thread로 보내기: 스레드로 옮기기, 스레드에서 사용자 태그, DM으로 돌아오기

- 출처: EGDESK_PRODUCT_VISION_AND_DEV_TODO.md P0 L178; Contract §5 L707-735, §17.B 공유 relation L1592
- 상태: 없음 · 크기 L · 선행: CHAT-01
- 근거: chat thread에 Board 연결 필드 없음(createThread eg-desk-surface.uc.js:6650-6676, createCodexThread :302-342). chat store는 boardRefs 참조 종류를 지원(helper/egdesk-chat-store.mjs:61, 112, 461)하지만 생성하는 코드 없음. 라우팅 UI·mention 없음.
- 빠진 것: DM↔Board Thread 연결 모델, 선택 메시지만 옮기는 공유 operation, 사용자 태그, 복귀 경로 전부.
- 결정: Q-AI-12 / HUM-CONV-001: 공유 대화를 Board Thread·workroom 중 무엇으로 보여줄지, 옮길 때 무엇을 복사·연결할지(Contract는 방 전체 history 자동 공개 금지).
- 구현 스케치: thread에 boardId/agendaRefs 추가 → 메시지 선택 후 'Board 대화로 보내기' → 대상 group thread에 messageRefs(boardRefs/contextRefs)로 연결 메시지 생성 → 원 DM에 복귀 링크. 공유 operation 필드(operationId, selectedRefs, recipients)는 Contract L1592 형식.

### CHAT-10 — Board Thread에 여러 Agent가 실제로 참여하고 각자의 상태(작업 중·막힘·완료)를 표시

- 출처: EGDESK_PRODUCT_VISION_AND_DEV_TODO.md P1 L213; Contract §5 L716-726, §11
- 상태: 없음 · 크기 XL · 선행: AGENT-02, CHAT-13, CHAT-06, CHAT-03
- 근거: group 참여자는 이름 문자열뿐: 기본값 '코덱스 어시스턴트'·'디자인 리뷰어'(eg-desk-surface.uc.js:303-316), 초대는 '멤버 N' placeholder 추가(:6723-6744). 전송은 thread당 native 대화 1개(registerChatRequest :6852). 참여자별 runtime·상태 없음.
- 빠진 것: 참여자 = 실제 Agent(Profile+runtime) 연결, mention으로 특정 Agent에 맡기기, 참여자별 진행·막힘 상태, integration 결과.
- 결정: Q-AI-12: 참여자·위임 관계 표시와 작성기에서 특정 Agent 지정 방식.
- 구현 스케치: 1) participant를 {agentId, profileRef} 객체로 전환 2) mention 파싱→해당 Agent의 별도 native thread에 Task 위임(CHAT-06 graph) 3) CHAT-13의 하위 Agent 상태를 참여자 칩에 projection 4) integration 답변. 단계별로 쪼개서 진행.

### AGENT-06 — Profile 지침을 Codex 실행에 전달(비전 문서상 runtime-context envelope)

- 출처: EGDESK_PRODUCT_VISION_AND_DEV_TODO.md Agent Runtime 절 L121-131, P0 체크 항목; CHAT_AGENT_PROFILE_RUNTIME.md 'Bridge Boundary'
- 상태: 완료 · 크기 S
- 근거: 현재 코드는 envelope이 아니라 native developerInstructions로 전달(helper/codex-chat-runtime.mjs:733-738, 7644c08·2f07b65), profile off 시 일반 지침 복원(:884-895). 테스트 helper/codex-chat-runtime.test.mjs:296, 897, 1491; scripts/egdesk-surface-state.test.mjs:135-137, 2288-2296. 문서 두 곳은 envelope 설명이 낡음.
- 구현 스케치: 코드 작업 없음. 비전 문서·CHAT_AGENT_PROFILE_RUNTIME.md의 envelope 설명을 developerInstructions로 고치는 문서 갱신만 필요.

</details>

## Codex + Claude 구독 지원

요약: ChatGPT(Codex) 구독은 로그인, 로그인 상태 chip, 로그아웃이 이미 동작합니다. 계정을 바꾸면 대화·요청도 계정별로 분리됩니다(9/26 커밋). Claude는 구독 연결이든 실행이든 전혀 없습니다. 코드에 있는 Claude 관련 항목은 5/11에 만든 Settings 카드의 가짜 데이터(가짜 이메일, 'Anthropic 연결됨', '무제한' 사용량)뿐입니다. 요금제(planType)와 남은 사용량 표시, 엔진 선택 계층, 계정별 격리, API 키 경로도 없습니다.

정책 확인 결과 [공식]:
- Aside는 Claude Pro/Max를 앱 안의 OAuth 팝업으로 연결합니다(docs.aside.com/help/ai). 그런데 Anthropic은 승인받지 않은 서드파티 앱이 claude.ai 로그인을 제공하거나 Pro/Max 자격증명으로 요청을 대신 보내는 것을 금지합니다(code.claude.com/docs/en/legal-and-compliance, agent-sdk/overview). 따라서 EG-Desk가 'Aside처럼' 앱 안에서 Claude 로그인을 띄우는 방식은 쓸 수 없습니다.
- 허용 범위로 보이는 경로는 대표님이 직접 설치하고 Anthropic 공식 흐름으로 로그인한 무수정 `claude` 바이너리를 EG-Desk가 하위 프로세스로 실행하는 방식입니다. EG-Desk는 토큰에 손대지 않습니다. 이 해석은 [제안]입니다. 외부 배포 전에는 Anthropic 문의가 필요합니다. 그 밖에 API 키 경로는 정책상 명확히 허용됩니다.
- Codex는 사용자가 설치한 codex의 app-server 내장 ChatGPT 로그인을 쓰는 현재 방식이 공식 통합 경로(rich client)와 같습니다. 배포형으로 갈 경우 대안은 'Sign in with ChatGPT' client ID인데, 현재 선택된 commercial partner 대상 대기자 등록 단계입니다.

설계 스케치('Agent 실행 엔진 선택' 계층) [제안]:
- 내부 기준 이벤트는 지금의 Codex wire 형태(thread/turn/item + serverRequest 승인)를 그대로 씁니다. 그러면 Chat UI와 SQLite store를 거의 고치지 않아도 됩니다.
- CodexChatRuntime의 request/nativeRespond 주입점을 EngineAdapter로 감싸고, Claude adapter가 `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`(또는 Claude Agent SDK의 query()+canUseTool) 출력을 같은 형태로 변환합니다.
- 변환 대응:
  - stream_event text_delta → item/agentMessage/delta
  - tool_use Bash/Edit/Write → commandExecution/fileChange
  - result → turn/completed
  - 권한 요청 → 기존 승인 카드
  - AskUserQuestion → (A) 질문 카드
  - parent_tool_use_id → (B) 하위 Agent 표시
- EG-Desk 도구(Browser·컨텍스트)는 helper의 stdio MCP 서버로 노출합니다.
- 구독 경로에서는 `--bare`를 쓸 수 없습니다. bare 모드는 OAuth를 읽지 않습니다 [공식].

| ID | 상태 | 크기 | 대표님 화면에서 달라지는 점 | 결정 | 환경 제약 |
|---|---|---|---|---|---|
| SUB-01 | 일부 | S | Chat 상단에서 지금 쓰는 ChatGPT 계정을 확인하고, 계정 메뉴에서 바로 로그아웃하거나 다른 계정으로 바꿀 수 있다. |  | 있음 |
| SUB-02 | 완료 | S | 다른 ChatGPT 계정으로 바꿔도 이전 계정의 대화와 실행이 새 계정에 섞이지 않는다. |  |  |
| SUB-03 | 완료 | M | Chat 상단에 'ChatGPT Pro · 5시간 한도 42% 사용 · 3시 10분 초기화'처럼 요금제와 남은 사용량이 보인다. |  | 있음 |
| SUB-04 | 일부 | S | 로그인 창이 EG-Desk로 돌아오지 못하는 환경에서도 코드를 입력해 로그인할 수 있다. |  | 있음 |
| SUB-05 | 일부 | M | 설정 화면의 '계정 & AI 엔진'에 실제로 연결된 ChatGPT·Claude 계정, 요금제, 남은 사용량만 보인다. |  |  |
| SUB-06 | 일부 | L | 대화마다 어떤 AI(Codex 또는 Claude)로 실행했는지 고정·표시되고, 기본 엔진을 바꿔도 진행 중인 작업은 원래 엔진에서 끝난다. |  |  |
| SUB-07 | 완료 | M | Chat 상단에서 'Codex · ChatGPT Pro'나 'Claude · Max'를 골라 이 대화에 쓰고, 모델과 추론 강도도 고를 수 있다. | 필요 |  |
| SUB-08 | 일부 | M | EG-Desk가 이 Mac의 Claude 로그인 상태(Pro/Max 구독인지 API 키인지)를 보여 주고, 로그인되어 있지 않으면 Terminal 카드에서 Anthropic 공식 로그인을 바로 열 수 있다. | 결정됨(D-S1) | 있음 |
| SUB-09 | 일부 | XL | Claude 구독으로도 Codex와 같은 Chat 화면(실시간 답변, 명령·파일 변경 카드, 승인 버튼, 질문 카드, 중지)으로 일을 시킬 수 있다. | 결정됨(D-S1·D-S2) | 있음 |
| SUB-10 | 일부 | L | Claude로 실행해도 Browser 카드 읽기·조작과 붙인 자료 읽기를 Codex와 같은 허락 절차로 쓸 수 있다. | 결정됨(D-S1) |  |
| SUB-11 | 없음 | L | 회사·개인 ChatGPT(또는 Claude) 계정을 둘 다 연결해 두고, 대화마다 어느 계정 사용량을 쓸지 고를 수 있다. | 일부 결정(D-S3 정함, HUM-ENGINE-001 남음) | 있음 |
| SUB-12 | 완료 | S | Claude 구독을 EG-Desk에서 어떤 방식으로 쓸지 정해져, 계정 정지 위험 없이 Claude 엔진을 붙일 수 있다. | 결정됨(D-S1) | 있음 |
| SUB-13 | 일부 | S | ChatGPT 구독 연결이 OpenAI 공식 경로 안에서 유지되어, codex 업데이트나 배포 후에도 로그인과 기능이 끊기지 않는다. | 결정됨(D-S6, 개인 사용 기준) | 있음 |
| SUB-14 | 일부 | M | 사용량이 다 떨어지면 '로그인 필요'가 아니라 '한도 도달 · 3시 10분 초기화'로 보이고, 다른 계정으로 이어서 할지 직접 고를 수 있다. | 결정됨(D-S5) | 있음 |
| SUB-15 | 없음 | M | 구독이 없거나 한도가 끝났을 때 본인 API 키로 이어서 쓸 수 있고, 종량 과금이라는 표시가 붙는다. | 일부 결정(D-S4 정함, 비용 상한 남음) | 있음 |

<details><summary>항목별 근거·빠진 것·구현 스케치</summary>

### SUB-01 — Codex(ChatGPT 구독) 로그인·상태 표시·로그아웃·계정 전환 동선

- 출처: Contract §0.3 'Codex 인증'(SELECTED-BASELINE); Atlas ENGINE-01; 사용자 요청(구독 요금제 지원)
- 상태: 일부 · 크기 S
- 근거: helper/codex-bridge-server.mjs:421-440 startChatgptLogin(account/login/start type chatgpt), :563-630 /auth/status·start·cancel·signout; overlay/JS/eg-desk-surface.uc.js:4665-4730 상태 chip + 인증 카드(전용 Browser card), :5257-5263 로그아웃 버튼은 '상태 보기' 진단 토글 안에만 있음; scripts/egdesk-chat-fixture-transport.test.mjs:59-68 fixture 검사; docs/PATH_1_5_STABILIZATION.md:71-80 '실제 계정 로그아웃·새 OAuth는 실행하지 않았다'
- 빠진 것: (1) 계정 메뉴가 없어 계정 전환은 진단 패널에서 로그아웃한 뒤 다시 로그인하는 방법뿐임. (2) EG-Desk가 사용자의 기본 ~/.codex 로그인을 공유해 EG-Desk에서 로그아웃하면 터미널 codex/IDE 로그인도 끊김. Codex CLI와 IDE가 캐시 로그인 하나를 공유한다는 점은 learn.chatgpt.com/docs/auth에서 확인 [공식]. 이에 대한 화면 경고가 없음. (3) 실제 계정으로 새 OAuth·로그아웃을 처음부터 끝까지 검증한 적 없음
- 환경 제약: 실제 새 OAuth·로그아웃 검증은 실제 ChatGPT 계정 로그인이 필요함(로그아웃하면 대표님 계정 연결이 끊김)
- 구현 스케치: eg-desk-surface.uc.js chrome row(4665~)의 계정 chip을 popover로 바꾼다(이메일 / 로그아웃 / 다른 계정으로 로그인). 로그아웃 확인 문구에 '터미널 codex도 로그아웃됩니다'를 넣는다. 기존 codexBridge.signOut()·startLogin()과 /auth/* 라우트를 재사용하고, fixture transport 테스트에 계정 메뉴 경로를 추가한다.

### SUB-02 — AI 계정이 바뀌면 이전 계정의 대화·요청·실행을 새 계정과 분리

- 출처: Contract §14.1('Run은 engineProfileId를 고정'), HUM-ENGINE-001 확정 부분
- 상태: 완료 · 크기 S
- 근거: helper/codex-bridge-server.mjs:213 identity가 바뀌면 chat.reset(); helper/codex-auth-state.mjs:18-40 normalizeNativeAuth/publicAuthIdentityKey; overlay/resources/EGDeskChatState.sys.mjs:333-345 codexAccountKey; eg-desk-surface.uc.js:1016 리셋 안내 문구; 커밋 e7b2513·7007c2a·c3368f2·c1d5f37·9e34766·e283943(2026-09-26); 테스트 helper/codex-auth-state.test.mjs, scripts/egdesk-surface-state.test.mjs
- 구현 스케치: 추가 작업 없음. 다중 엔진을 도입할 때 ownerKey 접두어를 'codex:'/'claude:'로 넓히는 일만 SUB-06에 포함한다.

### SUB-03 — ChatGPT 요금제(planType)와 사용 한도(rate limit: 사용률·초기화 시각) 표시

- 출처: Contract §0.3:77 'App Server의 active account·planType·rate-limit 상태를 검증'; Atlas ENGINE-01 #2; 사용자 요청('Aside처럼'. Aside는 구독 provider 사용량 표시를 제공, docs.aside.com/help/ai)
- 상태: 없음 · 크기 M
- 근거: helper/codex-auth-state.mjs:15-33은 account/read의 planType을 버림(주석에서만 존재를 언급); helper/·overlay/에서 grep 'rateLimits' 0건(테스트 fixture 외); [공식] app-server account/rateLimits/read(primary·secondary usedPercent, windowDurationMins, resetsAt, rateLimitReachedType), account/rateLimits/updated 알림, account/updated.planType — https://learn.chatgpt.com/docs/app-server
- 빠진 것: planType·rate limit 읽기와 알림 처리, authSnapshot 공개 필드, Chat header·Settings의 사용량 표시가 모두 없음
- 환경 제약: 실제 값 검증은 ChatGPT 구독 로그인이 필요함. 구현과 테스트는 fixture로 가능
- 구현 스케치: codex-auth-state.mjs normalizeNativeAuth에 planType을 allowlist로 추가한다. codex-bridge-server.mjs에서 로그인 후와 turn 완료 후 account/rateLimits/read를 호출하고, 'account/rateLimits/updated' case를 추가해 authState.rateLimits(usedPercent/resetsAt/windowDurationMins만)를 만든다. 이를 /v1/state와 SSE auth.status로 보낸다. surface chrome row에는 작은 원형 사용량 표시를 단다(리소스 모니터 스타일 재사용). codex-auth-state.test.mjs와 fixture transport 테스트를 추가한다.

### SUB-04 — device code 방식 ChatGPT 로그인

- 출처: learn.chatgpt.com/docs/app-server account/login/start type chatgptDeviceCode [공식]; MULTI_CLI plan §5
- 상태: 일부 · 크기 S
- 근거: UI는 이미 그림: eg-desk-surface.uc.js:4705-4730(loginMode 'device'·userCode·코드 복사). helper는 codex-bridge-server.mjs:421-422 {type:'chatgpt'}만 시작함. grep 'chatgptDeviceCode' 0건
- 빠진 것: helper에 device code 시작 경로와 라우트가 없음
- 환경 제약: 실제 검증에는 ChatGPT 계정과 계정 보안 설정의 device code 허용이 필요함
- 구현 스케치: /auth/start body {mode:'device'}를 받으면 account/login/start {type:'chatgptDeviceCode'}를 호출하고, verificationUrl/userCode/loginMode='device'를 authState에 저장한다. 기존 UI가 그대로 렌더한다.

### SUB-05 — Settings '계정 & Provider' 탭을 실제 엔진·계정 상태에 연결(가짜 데이터 제거)

- 출처: 사용자 요청('Aside처럼' Settings > Models > Providers); Atlas ENGINE-01 #1 '설정 또는 Chat header에서 [AI Engine]'
- 상태: 일부 · 크기 M · 선행: SUB-03, SUB-08
- 근거: eg-desk-surface.uc.js:7751-7778에 상수로 박힌 가짜 데이터: SETTINGS_MODELS(GPT-4.1, Claude 4 Sonnet 등), CODEX_ACCOUNT(가짜 이메일, plan 'Pro', connectedProviders openai/anthropic/google), SETTINGS_PROVIDERS(quota '무제한'). :9775-9850 renderProvidersTab의 로그인/로그아웃 버튼은 상수만 바꿈. Agent 탭(SETTINGS_AGENTS :7773)도 가짜 데이터. 출처 커밋 65ad8ae(2026-05-11)
- 빠진 것: 실제 auth 상태·엔진 목록과 무관함. 존재하지 않는 Anthropic/Google/Ollama 연결과 '무제한' 사용량을 실제처럼 보여 줌
- 구현 스케치: 1차(S): CODEX_ACCOUNT/SETTINGS_PROVIDERS 상수를 지우고 state.codex.authStatus에 연결한다. 미구현 provider는 숨긴다. 2차: /v1/state engines[](SUB-06)에 연결하고, 섹션을 '구독 연결'(Codex·ChatGPT / Claude)과 'API 키'(SUB-15 결정 후)로 나눈다. Agent 탭의 모델 선택은 캐릭터성 영역과 같이 정리한다.

### SUB-06 — Agent 실행 엔진 계층(engine adapter 경계)과 대화·Run별 엔진/프로필/버전 고정

- 출처: Contract §0.3 'Agent engine boundary' FIXED-PRINCIPLE('제품은 engine adapter 경계를 가지며 Run은 사용한 engine/profile/version을 고정'), §14.1; apps/firefox-ui-demo/docs/MULTI_CLI_CHAT_UIUX_IMPLEMENTATION_PLAN_V1.md §4(2026-04-19 계획, 미구현)
- 상태: 없음 · 크기 L
- 근거: codex-bridge-server.mjs:35 PROVIDER_ID='codex' 하나뿐, :553-558 capabilities에 엔진 목록 없음; codex-chat-runtime.mjs:74-93 cleanNotification이 Codex app-server 메서드를 직접 소비하고, :913/:960/:1053에서 thread/start·turn/start·thread/resume를 직접 호출; egdesk-chat-store.mjs:156-160 threads 테이블에 engine/profile 컬럼 없음; grep engineProfile 0건
- 빠진 것: EngineAdapter 인터페이스, 엔진 registry, thread·run별 engineId/profileId/version 저장, /v1/state의 engines 목록이 모두 없음
- 구현 스케치: 내부 기준 이벤트는 현재 Codex wire 형태(thread/turn/item + serverRequest 승인)를 유지하고, CodexChatRuntime의 request/nativeRespond 주입점을 EngineAdapter{start,resume,turn,steer,interrupt,respond,onNotification}로 감싼다(UI·store 변경 최소). helper/engine-registry.mjs를 새로 만들어 기존 app-server 로직은 codex 어댑터로 옮기고 claude 어댑터 자리를 둔다. egdesk-chat-store.mjs schema를 v+1로 올려 threads.engine_id·engine_profile_id를 추가하고 run public_json에 engine{id,version,profileId}를 넣는다. /v1/state capabilities.engines[]를 추가하고 ownerKey 접두어를 엔진별로 둔다.

### SUB-07 — 엔진·모델·추론 강도 선택 UI(Chat header / 새 대화 / 요청별)

- 출처: Atlas ENGINE-01 #1·#3('Click [AI Engine]', '이 Chat에서 사용', 요청별 Engine 선택기); 사용자 요청('Aside처럼' Task models)
- 상태: 없음 · 크기 M · 선행: SUB-06
- 근거: eg-desk-surface.uc.js:238-253 codexThreadRuntimeConfig에 engine/model 필드 없음; :6866-6880 /chat/send body에 엔진·모델 지정 없음; runtime은 body.model/effort를 받지만(codex-chat-runtime.mjs:575) UI가 보내지 않음; 모델 지정은 환경변수 EGDESK_CODEX_MODEL로만 가능(egdesk-native-capabilities.mjs:21-43)
- 빠진 것: Chat header 엔진 chip, 새 대화·요청별 선택기, 모델·추론 강도 선택, 기존 Run의 엔진 잠금 표시가 없음
- 결정: HUM-ENGINE-001(OPEN, docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md:149-161): 기본 엔진·계정을 앱·Desk·방·요청 중 어디에 기억할지, 진행 중 Run을 전환할 때 어떻게 처리할지
- 구현 스케치: chrome row(4665~)에 엔진 chip과 popover를 둔다. thread state에 engineId/model/effort를 저장하고 EGDeskChatState.buildChatRequest에 전달한다. Codex 모델 목록은 model/list에서 가져온다(카탈로그일 뿐 권한 확인이 아님 [공식]). Claude는 모델 별칭 목록을 쓴다. 기존 thread에는 엔진 잠금 배지를 표시한다. 엔진이 하나일 때도 Codex 모델·추론 강도 선택부터 먼저 제공할 수 있다.

### SUB-08 — Claude 로그인 상태 감지·표시(로그인은 Anthropic 공식 흐름, EG-Desk는 토큰 미접근)

- 출처: 사용자 요청(Claude 구독 지원); code.claude.com/docs/en/legal-and-compliance 'sign-in to a Claude account must complete through Anthropic's own flow' [공식]
- 상태: 없음 · 크기 M · 선행: SUB-12, SUB-06
- 근거: helper·overlay에서 grep anthropic/claude 결과는 가짜 데이터 상수(eg-desk-surface.uc.js:7754-7775)뿐; helper/package.json에 Anthropic 패키지 없음; 로컬: claude 2.1.300 설치(/Users/minsoocha/.local/bin/claude, --version 실행 확인); `claude auth status` JSON 필드(로그아웃 상태 기준): loggedIn, authMethod, apiProvider, configDirectory 등. authMethod 값은 none\|claude.ai\|oauth_token\|api_key\|api_key_helper\|third_party, 로그인 시 exit 0, 아니면 1 [공식 cli-reference]
- 빠진 것: claude 실행 파일 탐색, auth status 조회, 로그인 안내(EG-Desk Terminal card에서 `claude auth login`), 로그아웃(`claude auth logout`) UI가 모두 없음
- 결정: SUB-12에서 연결 방식이 정해진 뒤에만 진행
- 환경 제약: 실제 Claude Pro/Max 로그인 계정이 필요함. 로그인 상태에서 나오는 필드(이메일·구독 종류)는 아직 확인 못 함
- 구현 스케치: helper/claude-engine-auth.mjs를 만든다: resolveClaudeExecutable(EGDESK_CLAUDE_BIN 또는 PATH, egdesk-native-capabilities.mjs:107 패턴 재사용), spawnSync claude auth status JSON에서 공개 필드만 사용, `claude --version`으로 버전 고정. keychain과 ~/.claude/.credentials.json은 읽지 않는다. 로그인은 terminal-sessions로 `claude auth login` 세션을 열어 사용자가 직접 끝내게 한다. 결과는 engines[].auth로 노출한다.

### SUB-09 — Claude 엔진 실행 어댑터: Codex와 같은 Chat 이벤트 계약으로 스트리밍·도구 카드·승인·질문·중단·재개

- 출처: 사용자 요청; MULTI_CLI_CHAT_UIUX_IMPLEMENTATION_PLAN_V1.md §4.3('claude: --print - --output-format stream-json --verbose'), §9 P2 'Claude adapter'; Contract §0.3 engine boundary
- 상태: 없음 · 크기 XL · 선행: SUB-06, SUB-08, SUB-12, A:requestUserInput-ChatUI, B:subAgentActivity
- 근거: helper/에 Claude 실행 코드 0건(grep); 계획 문서만 있음(MULTI_CLI_CHAT_UIUX_IMPLEMENTATION_PLAN_V1.md:93-97, 193-196); [공식] headless.md: stream-json 이벤트(system/init, stream_event, assistant/user, result, system/api_retry), subagent 메시지의 parent_tool_use_id, `--bare`는 OAuth를 읽지 않음, SIGTERM은 turn을 미완료로 남김; agent-sdk/user-input.md: canUseTool이 권한 요청과 AskUserQuestion을 모두 받음
- 빠진 것: 프로세스 수명 관리, stream-json을 내부 이벤트로 바꾸는 변환, 승인·AskUserQuestion 연결, interrupt, session resume, 오류 분류가 모두 없음
- 결정: SUB-12 결정이 먼저임. 추가로 대표님 ~/.claude 설정(hooks·CLAUDE.md·MCP·skills)을 EG-Desk의 Claude 실행에 그대로 불러올지, 격리할지 정해야 함(CLAUDE_CONFIG_DIR로 격리하면 그 디렉터리에서 다시 로그인해야 함 [공식])
- 환경 제약: 구독 경로는 Claude Pro/Max 로그인이 필요함. `--bare`는 쓸 수 없음
- 구현 스케치: helper/claude-engine-adapter.mjs. 실행 명령: claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --session-id <uuid> 또는 --resume <id>, --permission-prompt-tool mcp__egdesk__approve, --mcp-config <helper MCP>. 또는 @anthropic-ai/claude-agent-sdk의 query()+canUseTool을 pathToClaudeCodeExecutable=사용자 설치본으로 쓴다. 변환: system/init → thread 시작, stream_event text_delta → item/agentMessage/delta, tool_use Bash → commandExecution, Edit/Write → fileChange, mcp__* → mcpToolCall, tool_result → item/completed, result → turn/completed, api_retry → error willRetry. 권한 요청은 기존 승인 카드 형태로, AskUserQuestion은 (A) 질문 카드로 정규화한다. 단계를 나눈다: 텍스트 → 도구 카드 → 승인/질문 → 중단/재개. RAM 대책으로 대화당 상주 프로세스 1개, idle 후 종료한다.

### SUB-10 — EG-Desk 도구(Browser card 읽기·조작, 붙인 자료 읽기)를 Claude 엔진에도 같은 허락 절차로 제공

- 출처: 사용자 요청(브라우저 컨트롤); Contract §0.3 engine boundary
- 상태: 없음 · 크기 L · 선행: SUB-09
- 근거: Codex 쪽은 dynamicTools로 제공: codex-chat-runtime.mjs:171-205 provider 카탈로그, :1230 item/tool/call, helper/codex-browser-tool-provider.mjs, helper/egdesk-context-runtime.mjs. MCP 서버 형태로 노출하는 코드는 없음
- 빠진 것: 같은 도구 카탈로그를 MCP(stdio)로 노출하는 서버가 없고, ownerKey·browserBounded 실행 정책 검사를 Claude 실행에 연결하는 부분도 없음
- 구현 스케치: helper/egdesk-mcp-server.mjs: provider.specs()를 MCP tools/list로 내보내고, tools/call은 기존 provider 호출 경로로 연결한다. run 컨텍스트 토큰으로 ownerKey·executionPolicy를 검사한다. 같은 서버에 permission-prompt 도구(egdesk approve)를 넣는다. --mcp-config로 해당 Claude 프로세스에만 연결한다.

### SUB-11 — 계정별 격리(ChatGPT 계정 여러 개·Claude 계정 여러 개를 Engine Profile로 분리)

- 출처: Contract §0.3:78 'Engine Profile 격리' SELECTED-BASELINE, §14.1; Atlas ENGINE-01
- 상태: 없음 · 크기 L · 선행: SUB-06, SUB-07
- 근거: egdesk-native-capabilities.mjs:21-43 buildCodexAppServerLaunch에 CODEX_HOME 지정이 없어 기본 ~/.codex를 공유; codex-bridge-server.mjs:41 appServerProcess 하나뿐; [공식] Codex 자격증명은 CODEX_HOME/auth.json 또는 keyring(learn.chatgpt.com/docs/auth); Claude는 CLAUDE_CONFIG_DIR마다 로그인이 분리됨(code.claude.com/docs/en/authentication)
- 빠진 것: Engine Profile registry, 프로필별 CODEX_HOME/CLAUDE_CONFIG_DIR, 프로필별 app-server 프로세스, Run에 profileId 고정이 모두 없음
- 결정: HUM-ENGINE-001(기본 범위·미리 위임할지). 그리고 EG-Desk 전용 로그인 저장소를 따로 둘지(터미널 codex/claude 로그인과 분리, 처음에 한 번 더 로그인), 사용자 기본 로그인을 공유할지
- 환경 제약: 실제 계정 2개 이상 로그인이 필요함
- 구현 스케치: engine-registry에 profiles[{id, engine, homeDir}]를 둔다. Codex는 env CODEX_HOME=<appData>/engines/<profileId>로 app-server를 프로필별로 띄우고 포트도 나눈다. RAM 대책으로 활성 프로필만 상주시킨다. Claude는 CLAUDE_CONFIG_DIR=<appData>/engines/<profileId>를 쓴다. run에 profileId를 고정한다.

### SUB-12 — Claude 구독 연결 방식 정책 결정(Aside식 앱 내 로그인 / 본인 설치 claude 재사용 / API 키 / Anthropic 승인)

- 출처: 사용자 요청('Codex+Claude 구독 요금제 지원, Aside처럼'); Anthropic 공식 정책 문서
- 상태: 없음 · 크기 S
- 근거: 저장소에 Claude 구독 정책을 다룬 결정 기록 없음(grep). MULTI_CLI plan은 정책 검토 없이 claude CLI를 전제함. [공식] legal-and-compliance: 'Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users'. 같은 페이지에 'Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription'도 있음. 제품에서 실행할 때는 Commercial Terms 동의 + 바이너리 무수정 + 사용량 대리 결제·중개 금지. [공식] agent-sdk/overview: 'Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products'. [공식] support.claude.com/en/articles/15036540: Agent SDK·claude -p 사용량은 구독 한도에서 차감(월 크레딧 변경은 보류). [공식] docs.aside.com/help/ai: Aside는 Claude Pro/Max를 앱 내 'OAuth sign-in flow'로 연결. Anthropic 승인 여부는 공개 자료로 확인 불가
- 빠진 것: 결정과 기록이 없음
- 결정: true. (a) Aside처럼 앱 안에서 claude.ai 로그인 팝업을 띄우는 방식은 Anthropic 승인 없이는 불가 [공식]. 채택하지 않을 것을 권고. (b) 대표님 Mac에 직접 설치·로그인한 무수정 claude를 EG-Desk가 하위 프로세스로 실행(EG-Desk는 토큰 미접근). 개인·내부 사용으로는 가장 정책에 부합하는 해석 [제안]. 단 Agent SDK 문구와 충돌 소지가 있어 외부 배포 전 Anthropic 문의가 필요함. (c) Anthropic API 키(Console) 경로는 명확히 허용되며 종량 과금. 대표님이 정할 것: (b)를 개인·내부용으로 채택할지, 외부 배포 계획이 있으면 Anthropic sales에 문의할지, (c)를 같이 둘지
- 환경 제약: Anthropic 승인 여부는 외부 문의가 필요함
- 결정(2026-10-24, 대표님, D-S1): (b). 설치된 무수정 `claude`를 하위 프로세스로 실행하고 공식 SDK와 같은 stdio 제어 통로를 쓴다. EG-Desk는 토큰에 손대지 않는다. 외부 배포 전 Anthropic 문의. (c) API 키 프로필은 두되 키는 EG-Desk가 받지 않고 CLI 공식 로그인에 맡긴다(D-S4). (a)는 쓰지 않는다. 상태 없음 → 완료(결정). 아래 스케치의 atlas 원장 HUM-ENGINE-002 기록은 이 갱신 범위 밖이라 하지 않았다.
- 구현 스케치: 결정을 docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md에 HUM-ENGINE-002로 기록한다. UI 명칭은 'Claude' 또는 'Claude Agent'로 한다('Claude Code' 명칭·로고를 기능명으로 쓰는 것은 금지 [공식 브랜딩]). 로그인 안내 문구는 'Anthropic 공식 로그인에서 진행'으로 쓴다.

### SUB-13 — Codex 구독 연결 경로를 공식 범위로 유지(현재 managed login vs Sign in with ChatGPT client ID) + 지원 codex 버전 고정

- 출처: Contract §0.3 'Codex 인증'; OpenAI 공식 문서
- 상태: 일부 · 크기 S
- 근거: helper/codex-app-server-rpc.mjs:17 clientInfo {name:'egdesk-firefox-bridge'}; codex-bridge-server.mjs:421 app-server 내장 ChatGPT 로그인. [공식] app-server는 'deep integration inside your own product'용이고 clientInfo.name이 Compliance Logs에서 클라이언트를 식별함(learn.chatgpt.com/docs/app-server). [공식] Sign in with ChatGPT 토큰 공유는 'open-source and locally hosted apps' 대상: ACCESS_TOKEN env + custom provider(requires_openai_auth=false), 앱이 토큰 갱신 책임, hosted MCP·computer use 미지원(developers.openai.com/siwc/token-sharing-open-source/codex-app-server, /preview-limitations). client ID는 'currently offered to a select group of commercial partners'(/siwc/request-client-id). 버전: egdesk-native-capabilities.mjs:13 허용 버전 0.157.1/0.160.1/0.163.0-alpha.10.2 vs 이 Mac의 PATH codex 0.162.1
- 빠진 것: 배포형에서 어느 경로로 갈지 결정·기록이 없음. PATH codex 버전이 허용 목록과 달라, EGDESK_CODEX_BIN 없이 실행하면 컨텍스트·QA 기능이 꺼질 수 있음(런타임 설정은 확인 안 함)
- 결정: 외부 배포를 계획한다면 SIWC 대기자 신청을 할지. 개인 사용은 현재 방식 유지를 권고 [제안]
- 환경 제약: SIWC client ID는 OpenAI 승인이 필요함
- 구현 스케치: 지금은 결정 기록과 codex 버전 안내(설정 화면에 '지원 버전 아님' 표시)만 한다. SIWC를 채택하면(L) helper에 OAuth, 토큰 파일, 갱신 후 app-server 재시작, thread/resume 루프를 문서 절차대로 추가한다.

### SUB-14 — 인증 실패·사용 한도 소진·권한 부족을 서로 다른 상태로 표시하고 복구 선택지 제공

- 출처: HUM-ENGINE-001 확정 부분(ledger:155 '인증·권한·사용 한도 부족은 서로 다른 상태로 복구', '진행 중 Run을 다른 계정으로 조용히 옮기지 않음')
- 상태: 일부 · 크기 M · 선행: SUB-03, SUB-09
- 근거: codex-bridge-server.mjs:150-154는 LOGIN_REQUIRED(401)만 따로 분류; codex-chat-values.mjs:42-44 publicError가 turn 오류를 code와 message로만 줄여 원인 분류를 버림; codex-chat-runtime.mjs:91은 error willRetry만 전달; grep usageLimit/quota 0건(가짜 데이터 제외). Run을 다른 계정으로 옮기지 않는 부분은 SUB-02로 충족
- 빠진 것: 한도 소진 상태, 초기화 시각, '다른 계정으로 계속' 같은 복구 버튼이 없음. Codex 오류의 원인 필드 이름은 공식 문서로 확인하지 않음
- 환경 제약: 실제 한도 소진은 재현이 어려움. fixture로 구현함
- 구현 스케치: cleanNotification error·turn.error에서 공개 원인 enum만 allowlist로 통과시키고, publicError에 kind(auth\|quota\|permission\|network)를 추가한다. rateLimitReachedType(SUB-03)과 연결한다. Claude 어댑터는 api_retry.error(rate_limit\|authentication_failed\|billing_error)를 같은 kind로 매핑한다. run 카드에 kind별 문구와 버튼을 단다.

### SUB-15 — API 키 Engine Profile(OpenAI·Anthropic 종량 과금 키)

- 출처: Contract §0.3:77 'API key는 별도 profile이다'; Aside 'Bring your own API key'(docs.aside.com/help/ai)
- 상태: 없음 · 크기 M · 선행: SUB-06, SUB-11
- 근거: helper는 account/login/start {type:'chatgpt'}만 호출(codex-bridge-server.mjs:422); codex-auth-state.mjs:1에는 apikey가 식별 불가 라벨로만 있음; Anthropic 키 경로 없음
- 빠진 것: API 키 입력·저장(OS keychain)·삭제 UI와 엔진 연결이 없음
- 결정: 종량 과금 API 키 경로를 제품에 넣을지, 키 저장 위치(macOS Keychain 또는 Firefox 로그인 관리자), 비용 상한 정책(Contract 비용 행: '가격 불명은 엄격 유료 작업 차단')
- 환경 제약: 실제 API 키가 필요함
- 구현 스케치: Codex는 별도 프로필 CODEX_HOME에서 account/login/start {type:'apiKey'}를 쓴다. Claude는 프로필 프로세스 env ANTHROPIC_API_KEY 또는 keychain을 조회하는 apiKeyHelper를 쓴다. 키는 SQLite·로그·export에 넣지 않는다(Contract §14.1).

</details>

## 브라우저 제어 · 컴퓨터 사용

브라우저 제어: Agent가 실제로 쓸 수 있는 도구는 observe·click·fill 3개뿐이다(helper/codex-chat-runtime.mjs:188-191, helper/codex-browser-tool-provider.mjs:96-99). navigate는 runtime·actor에 구현돼 있지만 카탈로그에서 걸러져 노출되지 않는다. scroll·press·type은 legacy 비보호 경로(window.__egdesk.browserAgent.act)에만 있다. 한 Run에 카드 1개만 조작할 수 있고, 최상위 문서만 다루며(allFrames:false), iframe·shadow DOM·contenteditable·120자 초과 값·스크린샷은 지원하지 않는다. 안전 경계(stale 거부, lease, Stop 철회, 표시 마커, page zoom stale)는 소유 fixture 범위에서 깊게 검증됐다(REA §6.1, 534/534). Windows에서는 실제 모델이 소유 fixture에서 성공했다. 비전 P1의 툴바 polish는 대부분 반영됐다. SourceRef 분리는 키가 하나로 합쳐져 있고 컨테이너 모듈(EGDeskBrowserIdentity.sys.mjs)이 배선되지 않았다. OAuth 팝업은 opener·container·self-close 처리가 없고 회귀 시험도 0개다. OAuth 완료→Await는 전혀 없다. 컴퓨터 사용(Desk 밖): 코드가 0이다. gesture helper는 트랙패드 입력 수신용이고 helper-rust는 PTY 전용이다. 계약 §12/impl-e24에 상세 설계만 있다. 새로 발견한 점: EG-Desk가 app-server를 사용자 ~/.codex 설정 그대로 띄우므로, 일반 thread가 사용자 MCP(playwright, firefox-devtools, Codex Computer Use 관련 node_repl)를 상속할 수 있다. 이 경로는 EG-Desk lease·관찰 밖에서 돈다(동작 여부는 미검증).

| ID | 상태 | 크기 | 대표님 화면에서 달라지는 점 | 결정 | 환경 제약 |
|---|---|---|---|---|---|
| BRW-01 | 일부 | S | Browser 카드 버튼이 언제 눌리는지·무엇을 하는지 항상 똑같이 보이고, 키보드로도 막힘 없이 쓸 수 있다. |  |  |
| BRW-02 | 일부 | L | 같은 사이트를 다른 계정으로 열 때 기존 카드로 잘못 이동하지 않고, 계정별로 카드를 구분해 쓸 수 있다. | 일부 결정(D-B8·B9 정함, D-B10 남음) | 있음 |
| BRW-03 | 일부 | M | 사이트에서 '구글로 로그인' 같은 팝업을 눌러도 로그인이 끝까지 진행되고, 끝나면 팝업 카드가 알아서 닫힌다. | 결정됨(D-B7) | 있음 |
| BRW-04 | 일부 | L | 로그인을 마치면 '계속' 버튼을 누르지 않아도 멈춰 있던 Agent 작업이 자동으로 이어진다. | 필요(D-B11) | 있음 |
| BRW-05 | 일부 | S | Agent에게 '이 사이트 열어서 찾아봐'라고 하면 Agent가 직접 주소를 열고 이어서 작업한다. | 결정됨(D-B1) |  |
| BRW-06 | 완료 | M | Agent가 긴 페이지를 내려 보며 찾고, 검색어 입력 후 Enter로 제출하는 등 사람처럼 페이지를 다룬다. |  |  |
| BRW-07 | 없음 | L | Agent가 여러 사이트를 카드로 나란히 열어 비교·정리할 수 있다. | 결정됨(D-B2) |  |
| BRW-08 | 일부 | L | 메일 작성창·임베드된 로그인창 같은 곳에서도 Agent가 입력하고 누를 수 있다. | 결정됨(D-B5·REA 4) |  |
| BRW-09 | 없음 | M | Agent가 그림·차트처럼 글자가 아닌 화면 내용도 보고 판단한다. | 결정됨(D-B6·REA 3) | 있음 |
| BRW-10 | 없음 | L | 일반 클릭이 안 먹는 사이트에서도 Agent 클릭이 실제로 동작한다. | 결정됨(D-B4·REA 1·2) | 있음 |
| BRW-11 | 일부 | S | 정한 범위 안에서는 매번 다시 허용하지 않아도 Agent가 같은 카드에서 여러 턴 이어서 작업한다. | 결정됨(D-B3) |  |
| BRW-12 | 일부 | M | Agent 클릭이 시간 초과돼도 같은 동작이 두 번 실행되지 않는다는 것을 확인된 상태로 쓸 수 있다. |  | 있음 |
| BRW-13 | 완료 | M | Agent가 브라우저에서 무엇을 했는지 카드에서 바로 보고, 필요하면 그 자리에서 멈추거나 직접 손댈 수 있다. |  |  |
| BRW-14 | 일부 | M | 실제로 쓰는 웹사이트에서 Agent 브라우저 조작이 된다는 것을 확인하고 쓸 수 있다. | 결정됨(D-B12) | 있음 |
| CU-01 | 일부 | XL | Agent가 다른 앱을 조작할 때 Desk 안 창에서 누가 조작 중인지, 무엇을 했는지 보고 멈출 수 있다. | 일부 결정(D-C3 정함, REA 10 남음) | 있음 |
| CU-02 | 일부 | L | 사람과 Agent가 동시에 마우스·키보드를 잡아 엉키는 일이 생기지 않는다. | 결정됨(D-C5·D-C7) | 있음 |
| CU-03 | 일부 | XL | Agent가 Finder·메모·엑셀 같은 데스크톱 앱도 보고 조작할 수 있다. | 결정됨(Q3·D-C1) | 있음 |
| CU-04 | 없음 | XL | Agent가 내 화면을 빼앗지 않고 따로 일하며, 내 화면을 쓰려면 반드시 먼저 허락을 받는다. | 일부 결정(D-C5·D-C8 정함, Q4 남음) | 있음 |
| CU-05 | 없음 | L | Agent가 엉뚱하게 조작하면 단축키 하나로 즉시 모든 Agent 입력을 멈출 수 있다. | 결정됨(D-C6) | 있음 |
| CU-06 | 완료 | M | 이미 설치된 Codex Computer Use를 EG-Desk Agent가 쓸 수 있는지 알게 되고, 되면 데스크톱 조작을 빨리 쓸 수 있다. | 일부 결정(Q1·Q3·D-C3 정함, D-C2 남음) | 있음 |
| CU-07 | 일부 | M | EG-Desk 밖 브라우저나 앱을 몰래 조작하는 도구가 켜져 있는지 알 수 있고, 끌 수 있다. | 일부 결정(Q1 정함, 컴퓨터 조작 외 물려받은 MCP 차단 남음) |  |
| CU-08 | 없음 | XL | (승인 후) 다른 사람이 내 Agent의 데스크톱 작업을 허락된 범위만 원격으로 볼 수 있다. | 필요 | 있음 |
| CU-09 | 없음 | XL | Windows PC에서도 Agent가 데스크톱 앱을 조작할 수 있다. |  | 있음 |

<details><summary>항목별 근거·빠진 것·구현 스케치</summary>

### BRW-01 — Browser 카드 툴바 polish: 예측 가능한 아이콘, 비활성 상태, 툴팁, 포커스 동작 (비전 P1 미체크)

- 출처: EGDESK_PRODUCT_VISION_AND_DEV_TODO.md: P1 - Browser Control L189
- 상태: 일부 · 크기 S
- 근거: overlay/JS/eg-desk-surface.uc.js:10672-10745 (back/forward/reload/home/duplicate/menu 버튼, deskIcon, title 툴팁), :11839-11849 (back/forward disabled, reload<->stop 아이콘·aria-label·aria-busy 전환), overlay/CSS/eg-desk-surface.uc.css:905-910(:disabled), :1035(:focus-visible). 커밋 6549793, 98ebb6a, da44138(메뉴 키보드 접근), 3d07c0b(메뉴 포커스 유지).
- 빠진 것: 코드는 대부분 반영됐으나 back/forward/home/duplicate 버튼에 aria-label이 없고 title만 있음. 툴바 상태(비활성·로딩·포커스 복귀)를 확인하는 회귀 시험이 없음(scripts/verify-firefox-mcp-browser-controls.mjs 최종 수정 b7587a4, 9월 이전). 비전 문서 체크박스도 갱신되지 않음.
- 구현 스케치: eg-desk-surface.uc.js 10672-10720 버튼들에 aria-label 통일 추가. syncBrowserChrome(11825~) 상태를 확인하는 node 단위 테스트(기존 scripts/*.test.mjs 패턴) 추가. 비전 문서 L189 체크 갱신.

### BRW-02 — SourceRef에서 콘텐츠/정규 자원 중복 제거와 프로필·계정 실행 컨텍스트를 분리하고, Browser 카드 포커스 동작에 반영

- 출처: EGDESK_PRODUCT_VISION_AND_DEV_TODO.md: P1 - Browser Control L190
- 상태: 일부 · 크기 L
- 근거: overlay/JS/eg-desk-surface.uc.js:1274-1284 sourceRefKey = kind\|scope\|profileId\|accountId\|uri 단일 키, :1294-1301 browserSourceRef, :395 defaultProfileId='firefox-egdesk-default'(고정), accountId 항상 ''. :10579-10582 focus-existing이 이 단일 키로 판별. overlay/resources/EGDeskBrowserIdentity.sys.mjs(configureBrowser/switchCardContext/popupContextOptions, 커밋 3f075d0)는 helper/egdesk-browser-identity.test.mjs(18 tests)만 import하고 chrome UI에는 연결되지 않음(grep 결과 surface에서 import 없음).
- 빠진 것: 정규 자원 키와 실행 컨텍스트 키가 분리되지 않음. 카드별 프로필/계정(container userContextId) 선택 UI·적용이 없음. 컨테이너 모듈이 구현·테스트만 되고 미배선.
- 결정: 같은 URL을 다른 계정으로 열 때 기존 카드로 이동할지 새 카드를 열지, 그리고 계정 구분 단위(Firefox container vs 별도 프로필)와 기본 계정 기억 위치(ledger HUM 계정 질문 L153)를 정해야 함.
- 환경 제약: 실제 사이트 로그인 분리 검증은 실제 계정 로그인이 필요(로컬 fixture로 container 분리만은 검증 가능).
- 구현 스케치: eg-desk-surface.uc.js: sourceRefKey를 resourceKey(kind\|uri)와 executionKey(profileId\|accountId\|userContextId)로 분리, findOpenCardBySourceRef가 둘을 함께 비교. spawnBrowserCard(10575)에서 xulBrowser 생성 직후 EGDeskBrowserIdentity.configureBrowser 호출. 카드 메뉴(12049~)에 계정/컨테이너 선택 항목 추가.

### BRW-03 — OAuth/window.open 팝업 흐름 회귀 시험 묶음

- 출처: EGDESK_PRODUCT_VISION_AND_DEV_TODO.md: P1 - Browser Control L191
- 상태: 없음 · 크기 M · 선행: BRW-02
- 근거: overlay/JS/eg-desk-surface.uc.js:12624-12672 installPopupCapture: nsIBrowserDOMWindow.createContentWindow/openURI가 aOpenWindowInfo를 무시하고 spawnBrowserCard(url)만 호출. popupContextOptions(EGDeskBrowserIdentity.sys.mjs:72)는 미사용. DOMWindowClose 처리 없음(grep 0). 시험은 수동 overlay/resources/popup-test.html(9b0e6ee, 최초 커밋)뿐이고 자동 시험 0.
- 빠진 것: 자동 회귀 시험이 없음. 분석상(미검증) opener 연결이 유지되지 않아 window.opener.postMessage를 쓰는 OAuth 팝업이 실패할 가능성이 큼. 팝업이 opener 카드의 container를 상속하지 않음. 팝업이 window.close()를 해도 카드가 남음.
- 환경 제약: 실제 OAuth 제공자 E2E는 실제 계정이 필요. 로컬 opener/postMessage/close fixture로 회귀 시험은 가능.
- 구현 스케치: installPopupCapture에서 aOpenWindowInfo를 새 xulBrowser 생성에 전달(openWindowInfo 경로)하고 popupContextOptions(opener)로 userContextId 상속. 카드 xulBrowser에 DOMWindowClose 리스너로 카드 제거. scripts/에 opener·postMessage·self-close 로컬 fixture 기반 headless 시험 추가.

### BRW-04 — OAuth/브라우저 완료 이벤트를 감지해 Await Token(의존 게이트)을 충족

- 출처: EGDESK_PRODUCT_VISION_AND_DEV_TODO.md: P1 - Browser Control L192, Human-in-the-Loop Await 절
- 상태: 없음 · 크기 L · 선행: BRW-03
- 근거: Await token/dependency gate 구현 grep 0건(overlay, helper, scripts). 설계만 apps/firefox-ui-demo/docs/HUMAN_IN_LOOP_WORKFLOW_AWAIT_MODEL.md(L5, L27, L172 OAuth 예시). 비전 P0 'dependency graph/task state registry' 도 미체크.
- 빠진 것: 완료 감지(리다이렉트 URL 패턴, 팝업 close+opener 메시지, Terminal 'authentication complete' 출력)와 이를 소비하는 Await 레지스트리가 모두 없음.
- 환경 제약: 실제 OAuth 완료 검증은 실제 계정 로그인 필요(로컬 모의 OAuth 서버로 흐름 검증은 가능).
- 구현 스케치: Await 레지스트리(다른 영역 P0 dependency registry)에 browser-completion 조건 타입 추가. eg-desk-surface.uc.js의 카드 location change/popup close 이벤트에서 조건 매칭 후 이벤트 발행. HUMAN_IN_LOOP_WORKFLOW_AWAIT_MODEL.md 계약에 맞춰 helper 측 run 재개 연결.

### BRW-05 — Agent의 브라우저 이동(navigate) 도구 노출

- 출처: 사용자 요청(브라우저 컨트롤: 이동) + BROWSER_AGENT_OBSERVATION_RUNTIME.md Runtime Contract
- 상태: 일부 · 크기 S · 선행: BRW-11
- 근거: helper/egdesk-browser-tool-runtime.mjs:28-29 egdesk_browser_navigate spec, :256-264 navigate 처리, overlay/resources/EGDeskBrowserAgentRuntimeChild.sys.mjs:501,585-589 guarded navigate 허용. 그러나 helper/codex-chat-runtime.mjs:188-191 collectToolSpecs가 browserBounded에서 observe/click/fill만 카탈로그에 넣고, helper/codex-browser-tool-provider.mjs:96-99 dispatch도 observe/click/fill만 허용. 즉 모델이 실제로 쓰는 도구는 observe·click·fill 3개.
- 빠진 것: navigate가 구현돼 있지만 Codex 카탈로그·provider 양쪽에서 차단되어 Agent가 URL 이동을 할 수 없음.
- 결정: 한 Run의 조작 허용 안에서 Agent가 임의 http(s) URL로 이동해도 되는지(허용 도메인 제한 여부) 정해야 함.
- 구현 스케치: codex-chat-runtime.mjs:189-190 browserInteraction 목록에 egdesk_browser_navigate 추가, codex-browser-tool-provider.mjs:96 허용 목록에 추가. 필요 시 도메인 정책 검사 추가. codex-browser-tool-provider.test.mjs에 navigate 허용/거부 시험 추가.

### BRW-06 — Agent의 스크롤·키 입력(press/type)·hover·대기 동작을 guarded 도구 경로에 추가

- 출처: 사용자 요청(브라우저 컨트롤: 스크롤·입력) + BROWSER_AGENT_OBSERVATION_RUNTIME.md(click/fill/type/press/scroll/navigate 계약)
- 상태: 없음 · 크기 M · 선행: BRW-05
- 근거: scroll/type/press는 legacy 비보호 경로에만 있음: EGDeskBrowserAgentRuntimeChild.sys.mjs:591-594(scroll), :609-621(type), :623-630(press, target.focus 호출), eg-desk-surface.uc.js:11516-11566. guarded 경로는 ref 필수(Child:501-503)라 scroll 불가, press는 focus 단계가 있어 '포커스 없는 guarded 입력' 정책과 충돌. BROWSER_TOOL_SPECS(runtime.mjs:25-36)에 해당 도구 없음. BROWSER_AGENT_OBSERVATION_RUNTIME.md는 2026-05-20 기준으로 guarded 경로를 반영하지 않음.
- 빠진 것: 긴 페이지 스크롤, 검색창 Enter 제출, 단축키, hover 메뉴, 로딩 대기를 Agent가 할 수 없음. 관찰 런타임 문서도 현재 구조와 어긋남.
- 구현 스케치: egdesk-browser-tool-runtime.mjs에 egdesk_browser_scroll/press/wait spec과 postcondition 추가. Child assertGuard에 scroll(ref 없는 문서 단위 guard)·press(포커스된 대상 일치 검사) 분기 추가. collectToolSpecs·provider 허용 목록 갱신. scripts/egdesk-browser-agent-guard.test.mjs에 stale·거부 시험 추가. BROWSER_AGENT_OBSERVATION_RUNTIME.md 갱신.

### BRW-07 — Agent의 다중 카드/탭 관리: 새 카드 열기, 카드 전환, 닫기, 뒤로/앞으로/새로고침

- 출처: 사용자 요청(브라우저 컨트롤: 탭 관리)
- 상태: 없음 · 크기 L · 선행: BRW-05, BRW-11
- 근거: helper/codex-browser-tool-provider.mjs:44-46 interact Run은 정확히 카드 1개만 선택 허용. 도구 카탈로그에 open/close/switch/back/forward 없음(runtime.mjs:25-36). 사람용 API는 존재: eg-desk-surface.uc.js:13995-14003 browserRuntime.back/forward/reload/duplicate.
- 빠진 것: Agent가 링크를 새 카드로 열거나 여러 사이트를 비교하는 작업 불가. 새로 연 카드에 권한을 어떻게 넘길지 모델이 없음.
- 결정: Agent가 연 새 카드가 같은 Run의 조작 권한을 자동 상속할지, 사람이 매번 허용할지 정해야 함.
- 구현 스케치: runtime.mjs에 egdesk_browser_open_card/close_card/history(back\|forward\|reload) spec 추가. provider.mjs prepare의 1카드 제한을 'Run이 연 카드' 집합으로 확장. eg-desk-surface.uc.js bind/lease(10420~)에 agent-spawned 카드 epoch 등록 경로 추가.

### BRW-08 — iframe·shadow DOM·contenteditable·긴 값 입력 지원

- 출처: 사용자 요청(브라우저 컨트롤: 클릭·입력 범위) + REA §7 R-04(frame)
- 상태: 없음 · 크기 L · 선행: BRW-06
- 근거: eg-desk-surface.uc.js:35 actor allFrames:false(최상위 문서만). EGDeskBrowserAgentRuntimeChild.sys.mjs:177 IFRAME/FRAME/CANVAS를 opaque 처리, :216-218 shadowRoot 있으면 관찰 불가, :68-76 isFillableControl에 contenteditable 없음, :513-516 값 120자 초과 거부.
- 빠진 것: 결제·로그인 iframe, 웹 컴포넌트 기반 사이트, Gmail/Notion 같은 리치 에디터, 긴 글 입력을 Agent가 다룰 수 없음.
- 구현 스케치: actor 등록을 allFrames:true로 바꾸고 frame별 actor ref에 browsingContext id 포함(guard 비교 확장). open shadowRoot 순회 추가. contenteditable fill을 bounded 길이 정책과 함께 허용. scripts/egdesk-browser-agent-guard.test.mjs에 frame stale 시험 추가.

### BRW-09 — Agent용 시각 관찰(카드 스크린샷)

- 출처: 사용자 요청(브라우저 관찰) + 계약 impl-e24-computer-use(semantic→접근성→좌표 fallback)
- 상태: 없음 · 크기 M
- 근거: 도구 경로에 drawSnapshot/captureScreenshot 없음(grep: eg-desk-surface.uc.js·runtime.mjs 0건). headless QA도 screenshot unsupported·visualPass:null(REA §6.1 EGQ3, 커밋 c79c087).
- 빠진 것: DOM 텍스트만 관찰하므로 캔버스·이미지·차트 위주 페이지를 Agent가 이해하지 못함.
- 환경 제약: headless에서는 캡처 미지원이라 시각 검증은 실제 창 Firefox 실행이 필요.
- 구현 스케치: EGDeskBrowserAgentRuntimeParent 또는 chrome 측에서 browsingContext.currentWindowGlobal.drawSnapshot으로 카드 viewport 캡처, 민감 입력 영역 mask 후 이미지 contentItem으로 반환하는 egdesk_browser_screenshot spec 추가(runtime.mjs, provider.mjs).
- REA 메커니즘 채택안: [docs/references/rea-mechanism-adoption.md](../../docs/references/rea-mechanism-adoption.md) 웹6(카드 스크린샷, 결정 3 대기·묶음 다)

### BRW-10 — DOM click에 반응하지 않는 사이트를 위한 좌표·포인터 순서 입력(사람처럼 누르기)

- 출처: REA §6 EG-02, §7 R-04; 계약 impl-e24-computer-use; [rea-mechanism-adoption.md](../../docs/references/rea-mechanism-adoption.md) 2장 1·2번
- 상태: 없음 · 크기 L · 선행: BRW-08, BRW-09
- 근거: guarded click은 `dom-click-no-pointerdown` 경로 하나다(EGDeskBrowserAgentRuntimeChild.sys.mjs:1105-1107의 `target.click()`). actor child가 system 코드로 부르므로 Gecko는 이 클릭을 trusted로 표시한다. 하지만 click 이벤트 하나뿐이고 pointerdown·mousedown·mouseup·hover·좌표가 없다(rea-mechanism-adoption.md 2장 1번, 확신 높음~중간). 좌표 입력 `sendMouseEventToWindow`는 legacy 비보호 경로에만 있다(:1116-1120). 이 API는 Firefox ESR 140에만 있고 Firefox 153 ESR·159 release에서는 제거되어, 그 경로는 오류 없이 `dispatchEvent`로 떨어진다. 이렇게 보낸 이벤트는 untrusted이고 영수증에는 `dispatchScope: "dom-fallback"`(:1140)으로만 남는다(같은 문서 2장 2번). 도구 설명(egdesk-browser-tool-runtime.mjs:45, 조사 당시 :31)의 'A site may ignore synthetic clicks'도 원인을 '합성'으로 적고 있어 정정 후보다. REA §7 R-04: frame·OS DPR·좌표 입력 조합 UNVERIFIED, EGQ7 coordinateInputVerified:false.
- 빠진 것: 포인터 순서(pointerdown·mousedown·mouseup)나 좌표·hover에 반응하는 메뉴·버튼에서 Agent 클릭이 효과 없음. 지금 Firefox(153 ESR·159)에서 쓸 수 있는 trusted 좌표 입력 경로(`synthesizeMouseEvent`)가 없음. 좌표 입력의 page zoom·DPR·frame 조합 검증 없음.
- 환경 제약: OS 화면 배율·전면 전환 조합 실험은 사용자 승인 필요(REA §7: OS 전면 실험 보류).
- 구현 스케치: Child perform에 guarded coordinate 경로 추가(관찰 revision·viewport·DPR·zoom 일치 시에만, 변경 시 좌표 폐기). 실패 후 자동 재시도 금지 규칙(EG-01) 유지. DOM click 결과가 미확인일 때 이 경로로 자동 전환하지 않는다. EGQ7 하네스를 확장해 zoom/DPR 조합 시험.
- 다음 단계: REA 메커니즘 채택안 [rea-mechanism-adoption.md](../../docs/references/rea-mechanism-adoption.md) 웹1(사람처럼 누르기: `synthesizeMouseEvent`로 move→down→up, 기존 click은 그대로 두고 새 도구로만)·웹2(사람처럼 키 입력: `nsITextInputProcessor`). 둘 다 대표님 결정 1·2 대기(묶음 라).

### BRW-11 — Browser 조작 권한 수명(BROWSER-CARD-GRANT-01)과 여러 턴 연속 조작

- 출처: docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md:180 (PROPOSED), apps/firefox-ui-demo/docs/PATH_1_5_STABILIZATION.md:190-192
- 상태: 일부 · 크기 S
- 근거: 한 Run 권한 방식이 구현됨: 카드 메뉴 'Chat 조작 허용' eg-desk-surface.uc.js:12053-12057, 선택 토큰 1회 사용 usedRunId :10446, Stop 시 즉시 철회(커밋 cb9b9c0, 2849cb2). Windows 실제 모델 소유 fixture 4개 도구 성공(PATH_1_5_STABILIZATION.md:327-345, 커밋 b9a98d9). 소유자 결정은 ledger에 PROPOSED로 남음.
- 빠진 것: 권한 수명 결정이 확정되지 않음. 현재는 매 턴마다 사람이 다시 '조작 허용'을 눌러야 해서 여러 턴 작업이 끊김.
- 결정: Run 단위 권한(추천)과 철회 전까지 유지되는 권한 중 선택. HUM-COLLAB-001의 위임 기간과 함께 정해야 함.
- 구현 스케치: 결정 후 eg-desk-surface.uc.js registerBrowserToolSelection/usedRunId(10104~10150, 10446)에 thread 단위 지속 grant와 만료 조건(카드·계정 변경, 철회) 추가. ledger 상태 갱신.

### BRW-12 — REA §6~7 남은 항목(EG-01~08 적용 이후 R-01~R-06)

- 출처: docs/references/computer-use-browser-control-rea.md §6, §6.1, §7
- 상태: 일부 · 크기 M · 선행: BRW-10
- 근거: EG-01~08은 소유 fixture 범위에서 반영·검증: a8d88ae(EGA1, 11/11), dd5c5bd+b1cc997(EGA2 Stop 표시), 96e1a74(EGA3 표시 마커), 783bd2e(EGA4), EGQ3~EGQ7(browser-negative 11거부, page zoom 1->1.25 stale 거부), 중앙 534/534(b706baa). §7 R-01 timeout 후 late effect UNKNOWN, R-04 frame·OS DPR·좌표·배경 조합 UNVERIFIED, R-02/R-03/R-05는 OpenAI native 쪽 미확인, R-06 범위 확대 시 재검증.
- 빠진 것: EG-Desk에 직접 해당하는 것은 R-01(같은 시계로 command ID·dispatch·timeout 연결)과 R-04(Gecko 조합). R-02/R-03/R-05는 OpenAI 앱 분석이라 제품 선행조건 아님.
- 환경 제약: R-01 전환 재현·R-02·R-04 OS 배율 조합은 통제된 OS 전면 전환이 필요(사용자 승인 대상).
- 구현 스케치: R-01: helper/codex-browser-tool-transport.mjs와 actor 영수증에 단조시계 timestamp·command ID를 붙여 소유 fixture에서 timeout 후 수신 여부 기록. R-04: EGQ7 하네스에 iframe·다른 zoom 조합 추가(배경 시험은 승인 범위 내).
- REA 메커니즘 채택안: [docs/references/rea-mechanism-adoption.md](../../docs/references/rea-mechanism-adoption.md) 웹4·웹8·웹9·웹10(문서 번호 교차 확인, 시간 예산·보내기 전/후 구분, 문서 준비 대기, 요청 순번·같은 시계 기록 — 결정 불필요, 묶음 가), 웹1·웹3·웹5·웹7(결정 1·2·4·5·6 대기)

### BRW-13 — Desk 안에서 보이는 Agent 브라우저 활동: 카드별 행동 타임라인, 지속 표시, 사람의 일시중지/직접 조작 전환

- 출처: 계약 §12(Agent 활동은 Desk 안에서 관찰 가능한 projection), 비전 Browser Agent 절
- 상태: 일부 · 크기 M · 선행: BRW-11
- 근거: 카드 상태 텍스트가 4초 후 사라짐(eg-desk-surface.uc.js:10657-10666, 12159-12185), 표시 전용 target marker(:10775-10777, createBrowserAgentProjection :10268, 커밋 96e1a74), 행동 이력 API browserAgent.history(:14013) 존재. Stop은 Chat에서만.
- 빠진 것: 카드에 남는 행동 타임라인 UI, 'Agent 조작 중' 지속 배지, 카드에서 바로 일시중지·직접 조작·돌려주기 버튼이 없음. (A)/(B) 하위 Agent 진행 표시와는 별개 항목.
- 구현 스케치: eg-desk-surface.uc.js 카드 identity slot에 활동 배지·타임라인 popover 추가(browserAgent.history 데이터 사용). 카드 헤더에 일시중지/중지 버튼을 두고 기존 Chat Stop·lease 철회 경로(browserToolStoppedRuns :10068, browserToolCardLeases :10070) 재사용.
- REA 메커니즘 채택안: [docs/references/rea-mechanism-adoption.md](../../docs/references/rea-mechanism-adoption.md) 웹7(표시점 이동, 결정 5 대기·묶음 마)

### BRW-14 — 실제 모델로 일반(외부) 사이트에서 브라우저 도구 E2E 검증

- 출처: PATH_1_5_STABILIZATION.md:190-192 (일반 사이트 상호작용 미활성 명시), REA §6.1(providerTurns 0)
- 상태: 일부 · 크기 M · 선행: BRW-05, BRW-06, BRW-11
- 근거: 실제 모델 성공은 소유 로컬 fixture뿐(PATH_1_5_STABILIZATION.md:327-345, Windows). macOS headless EGQ3~7은 providerTurns 0, nativeModelOriginVerified:false(REA §6.1).
- 빠진 것: 실제 외부 사이트에서 실제 모델이 observe/click/fill을 수행한 기록 없음. macOS 실제 모델 Browser run 기록도 이 문서들에서는 확인 못 함.
- 결정: 검증할 외부 사이트와 계정 사용 범위(로그인 필요 사이트 포함 여부) 승인 필요.
- 환경 제약: 실제 Codex 계정 로그인과 외부 사이트 접속, Firefox 실제 실행 필요.
- 구현 스케치: scripts/egdesk-qa-ui-flow.mjs 계열 하네스에 외부 공개 사이트(로그인 불필요) 시나리오 추가, 결과 영수증을 PATH_1_5_STABILIZATION.md에 기록.

### CU-01 — Desk 밖 computer-use를 Desk 안에서 보는 host-activity view (대상 앱/창, 현재 제어자·lease, Agent 포인터·포커스 표시, 행동 타임라인, 일시중지/중지, 결과 검증, privacy 경계)

- 출처: EGDESK_PRODUCT_VISION_AND_DEV_TODO.md: P2 L231; 계약 §12(L932-975); Atlas CU-01(L1265-1285)
- 상태: 없음 · 크기 XL · 선행: CU-02, CU-03
- 근거: 앱 코드 전체에서 computer-use/host-activity/control-lease grep 0건(helper, overlay, scripts, docs; ontology graph.json의 'computer used' 우연 일치 1건 제외). 설계만 존재: 계약 impl-e24-computer-use(L2579~, 모든 항목 '미실행 oracle').
- 빠진 것: 관찰 View, 제어자 표시, 타임라인, 결과 확인 UI 전부 없음.
- 환경 제약: 실제 앱 관찰은 macOS 화면 기록 권한이 필요.
- 구현 스케치: overlay/JS/eg-desk-surface.uc.js에 kind:'host-activity' Desk Window 추가(spawnDeskWindowShell 재사용). helper에 host bridge 이벤트 스트림(SSE) 추가해 프레임·행동·lease 상태 전달. 결과 검증은 browser postcondition 패턴(runtime.mjs:95-97)을 일반화.
- REA 메커니즘 채택안: [docs/references/rea-mechanism-adoption.md](../../docs/references/rea-mechanism-adoption.md) 맥10(Codex 조작 중 감독 — 관찰은 Q1 (다) 범위라 지금 가능, 자동 중지만 결정 10), 맥3·맥4·맥6·맥7·맥9(포인터 표시, 앞 앱 되돌리기, 사람이 손대면 양보, 앱 하나만 중지, 창 하나만 캡처 — 결정 7(Q3) 전제)

### CU-02 — Desk 밖 computer-use의 control-lease 모델 (입력권 확보·양보·회수, epoch, deadline, 사람 입력과 비중첩)

- 출처: 비전 P2 L231; 계약 §12, impl-e24 '입력 출처·감시자·긴급 중지'; ledger HUM-COLLAB-001
- 상태: 없음 · 크기 L
- 근거: Desk 밖용 lease 없음. 재사용 가능한 패턴은 Browser 카드 lease만 존재: eg-desk-surface.uc.js:10070 browserToolCardLeases, :10319 browserToolAuthorizePhysicalAction, EGDeskBrowserAgentRuntimeChild.sys.mjs:640-660 lease·authorizeAct 재확인.
- 빠진 것: OS 수준 입력권 개념, 사람 입력 감지 시 양보, lease 만료 fail-closed가 없음.
- 결정: HUM-COLLAB-001(OPEN): PC 제어 위임 주체·범위·기간을 정해야 함.
- 환경 제약: 사람 입력 감지는 macOS 입력 모니터링/손쉬운 사용 권한 필요.
- 구현 스케치: helper/에 host-lease 모듈(run·target·epoch·deadline·grant) 추가, browser lease 코드의 epoch/tombstone 규칙 이식. UI는 CU-01 view와 Chat Stop에 연결.
- REA 메커니즘 채택안: [docs/references/rea-mechanism-adoption.md](../../docs/references/rea-mechanism-adoption.md) 맥5(앱별 차례 줄)·맥6(사람이 손대면 양보)·맥2(그 앱에만 보내는 입력)·맥4(앞 앱 되돌리기). 결정 7(Q3)·11 전제

### CU-03 — macOS native adapter: 선택 창 캡처(ScreenCaptureKit) + 접근성(AX) action 우선 + CGEvent 좌표 입력 fallback

- 출처: 계약 impl-e24-computer-use(L2585~: macOS ScreenCaptureKit·AX); 사용자 요청(컴퓨터 유스)
- 상태: 없음 · 크기 XL · 선행: CU-02, CU-05
- 근거: helper/macos-gesture-helper/egdesk_gesture_helper.m(277줄)는 NSEvent 트랙패드 phase를 TCP 39217로 내보내는 입력 수신용(CGEventPost/AXUIElement/ScreenCaptureKit 0건). helper-rust/src/main.rs(458줄)는 PTY spawn/write/resize/kill만(:156-447).
- 빠진 것: 데스크톱 앱 관찰·조작 수단이 전혀 없음.
- 결정: 자체 adapter를 만들지, Codex Computer Use 앱(CU-06)에 맡길지 결정 필요.
- 환경 제약: macOS 화면 기록·손쉬운 사용 권한과 실제 데스크톱(OS 전면 입력) 필요.
- 구현 스케치: helper/macos-gesture-helper(Swift Package) 또는 helper-rust에 capture/ax/input 명령 추가, Node helper가 JSON-RPC로 호출. 행동 순서 identity→권한→lease→관찰 revision→전제 검사→입력→readback(계약 L2589) 준수.
- REA 메커니즘 채택안: [docs/references/rea-mechanism-adoption.md](../../docs/references/rea-mechanism-adoption.md) 맥1(권한을 가진 별도 도우미 앱, 결정 8·9)·맥2(그 앱에만 보내는 입력, 결정 7·11·12)·맥8(권한 3종과 앱별 승인)·맥9(창 하나만 캡처). 채택안은 기존 gesture helper·helper-rust를 키우지 않고 새 도우미 앱으로 만들자고 권한다(같은 문서 2장 4번)

### CU-04 — 격리 실행 우선(가상 디스플레이·VM·분리 데스크톱), 사용자 활성 데스크톱 제어 전 명시적 handoff

- 출처: EGDESK_PRODUCT_VISION_AND_DEV_TODO.md: P2 L232; 계약 §12
- 상태: 없음 · 크기 XL · 선행: CU-02, CU-03
- 근거: 격리 surface·handoff 관련 코드 grep 0건. Atlas CU-01 단계 1~2의 '[컴퓨터 사용 범위]'·'[직접 입력]/[Agent에게 돌려주기]' UI 없음.
- 빠진 것: 격리 실행 환경 선택·준비, 활성 데스크톱 인계 확인 UI 모두 없음.
- 결정: 격리 방식(macOS VM, 별도 사용자 세션, 클라우드 VM 등)과 비용·성능 허용 범위를 정해야 함.
- 환경 제약: VM·가상 디스플레이 등 OS/외부 인프라가 있어야 구현·검증 가능.
- 구현 스케치: helper에 execution-surface 추상화(local-active/isolated) 추가, isolated가 없을 때 handoff 대화상자를 거쳐서만 local-active lease 발급. UI는 CU-01 view의 범위 확인 단계로 구현.
- REA 메커니즘 채택안: [docs/references/rea-mechanism-adoption.md](../../docs/references/rea-mechanism-adoption.md) 맥1(별도 도우미 앱)·맥4(앞 앱 되돌리기)·맥8(권한 3종과 앱별 승인). 결정 7(Q3)·8·9 전제

### CU-05 — 전역 긴급 중지 키(Ctrl+Alt+Shift+.)와 별도 watchdog 프로세스의 fail-closed 입력 gate

- 출처: 계약 impl-e24 '입력 출처·감시자·긴급 중지' 표(macOS session CGEventTap)
- 상태: 없음 · 크기 L · 선행: CU-02
- 근거: 전역 hotkey·event tap·watchdog 코드 grep 0건. 기존 gesture helper는 NSEvent 관찰만.
- 빠진 것: Agent 입력을 즉시 끊는 물리 경로가 없음.
- 환경 제약: macOS 입력 모니터링 권한과 실제 키보드 입력 필요.
- 구현 스케치: macos-gesture-helper에 CGEventTap 기반 chord 감지 추가, 감지 시 helper host-lease epoch 증가·대기 입력 폐기·안전 key-up 후 ACK. watchdog 연결 상실 시 입력 차단.
- REA 메커니즘 채택안: [docs/references/rea-mechanism-adoption.md](../../docs/references/rea-mechanism-adoption.md) 맥11(감시 프로세스와 긴급 중지 키)·맥7(앱 하나만 중지)·맥5(앱별 차례 줄)·맥6(사람이 손대면 양보)·맥1(별도 도우미 앱). 채택안은 gesture helper가 아니라 새 도우미 앱에 둔다. 결정 7(Q3) 전제

### CU-06 — Codex Computer Use 앱/Codex 쪽 browser·computer-use 연동 가능성

- 출처: 사용자 요청(컴퓨터 유스, Codex Computer Use 앱 연동 가능성)
- 상태: 미확인 · 크기 M
- 근거: ~/.codex/computer-use/'Codex Computer Use.app' 설치됨, ~/.codex/config.toml L4 notify가 SkyComputerUseClient 호출, node_repl MCP에 BROWSER_USE_* env(L191-205). EG-Desk는 app-server를 process.env 그대로, MCP override 없이 실행(helper/egdesk-native-capabilities.mjs:37-41, helper/codex-bridge-server.mjs:320-322) -> 일반 thread가 사용자 Codex MCP 설정을 상속할 가능성. 그러나 BROWSER_USE_ACCESS_PIPE_PATH 등 Codex 데스크톱 앱 전용 env가 EG-Desk 환경에는 없어 실제 동작 여부는 미확인(실행 금지라 검증 안 함).
- 빠진 것: 연동 가능 여부 자체가 미확인. 된다 해도 EG-Desk lease·관찰 View 밖에서 돌아감.
- 결정: OpenAI 독점 Computer Use(ChatGPT 데스크톱 앱·요금제 의존)를 쓸지, 자체 adapter(CU-03)를 만들지 선택.
- 환경 제약: 실제 Codex 계정 로그인, Codex 데스크톱 앱 실행, OS 화면 기록/손쉬운 사용 권한 필요.
- 구현 스케치: 승인 후 별도 프로필로 app-server config/read와 mcpServerStatus 조회만 하는 probe 스크립트(scripts/)로 상속 MCP 목록 확인. 가능하면 mcpToolCall 항목(codex-chat-runtime.mjs:51,1523)을 CU-01 view에 투영.

### CU-07 — 일반 thread가 상속하는 외부 제어 MCP(playwright, firefox-devtools, node_repl 등) 가시화·제한

- 출처: 계약 §12(모든 Agent 제어 활동은 Desk 안 projection 필요) + 분석 결과
- 상태: 일부 · 크기 M
- 근거: QA·bounded 정책 thread만 MCP 격리 검증(helper/codex-chat-runtime.mjs:920,1059 verifyQaMcpIsolation). 일반 thread는 사용자 ~/.codex MCP를 상속(egdesk-native-capabilities.mjs:37-41에 override 없음). mcpToolCall은 Chat 활동 항목으로만 표시(codex-chat-runtime.mjs:51,1523).
- 빠진 것: 일반 thread에서 외부 브라우저·데스크톱 제어 MCP가 EG-Desk lease·guard 없이 호출될 수 있고, 어떤 제어 도구가 활성인지 사용자에게 보이지 않음.
- 결정: 일반 대화에서 사용자 Codex MCP 상속을 허용·차단·선택 허용 중 무엇으로 할지 결정.
- 구현 스케치: egdesk-native-capabilities.mjs buildCodexAppServerLaunch에 MCP 정책 옵션 추가(-c mcp_servers.<name>.enabled=false 등, 공식 설정 키는 Codex 문서로 확인 필요). 설정 화면에 상속 MCP 목록·토글 추가.
- 진행(2026-10-24): 물려받은 MCP 이름·상태·종류 표시(`6126e93`·`135a97e`), 컴퓨터 조작 도구 분류·끄기 스위치(기본 inherit, `4947219`·`7ddb434`), 대표님 결정 Q1 (다) 기록(`6585727`: 일반 대화의 Codex 컴퓨터 조작은 켜 둔 채 표시 보강, 끄기 스위치는 설정 선택지로 유지). 그 후속으로 사용 기록 helper(`0387f73`): 호출마다 크기만 기록(인자 바이트·결과 이미지 수·결과 글자 바이트, 내용 없음), run별 `computerUse`(호출 수·마지막 시각·서버·진행 중), 'computer.used' 이벤트, run.started에 정책 기록, 활동 행 제목 '컴퓨터 조작 · {도구}'. helper 단위 codex-computer-control 17/17.
- 진행(2026-10-24, 이어서): `8dc695d` 설정의 컴퓨터 조작 상태·'EG-Desk 대화에서는 끔' 스위치·readback, 활동 행 배지. `a7c66cc` 선택을 비공개 설정 파일에 저장해 브리지 재시작 뒤에도 유지. `9dbfa51` 사용 기록 화면 연결: 호출 중 '[···] 컴퓨터 조작 중', 답변 아래 호출 수 줄(활동 행으로 이동), 활동 머리에 run 정책. `3696996` Codex Computer Use·cua-driver 서버를 desktop으로 분류.
- 남은 것(2026-10-24): 사용 기록의 화면 연결은 `9dbfa51`로 됨. 실제 모델 왕복 미검증. 컴퓨터 조작 외 물려받은 MCP(playwright·firefox-devtools 등)의 차단 정책은 이 원장에 결정 기록 없음. OS 수준 관찰(앞 앱 변화·OpenAI 조작 서비스 실행)은 REA 채택안 맥10.

### CU-08 — 원격 host-activity 스트리밍·identity·authorization은 외부 인프라 승인 게이트 뒤에 둠

- 출처: EGDESK_PRODUCT_VISION_AND_DEV_TODO.md: P2 L233; 계약 impl-e24-remote-transport(L2540~); ledger HUM-REMOTE-001, A-INFRA-02
- 상태: 없음 · 크기 XL · 선행: CU-01, CU-02
- 근거: 원격 전송 코드 없음(정책상 의도된 미구현). 설계만 존재(WSS/WebRTC/TURN/SFU, PKCE, 비용 모델; 모두 미실행 oracle).
- 빠진 것: 승인 전에는 구현 대상 아님. 로컬 모의(권한 정책별 경합·철회 시험)만 가능.
- 결정: HUM-REMOTE-001: 원격 인프라 구성·공급 방식·비용 승인.
- 환경 제약: 서버·네트워크·identity 외부 인프라 필요.
- 구현 스케치: 승인 전: 계약 L2546-2556의 command envelope(ID·epoch·deadline)만 로컬 host-lease에 미리 맞춰 둠. 승인 후 별도 coordinator 서비스.

### CU-09 — Windows/Linux computer-use adapter (Graphics Capture·UI Automation, XDG RemoteDesktop/EIS)

- 출처: 계약 impl-e24-computer-use(L2593-2610)
- 상태: 없음 · 크기 XL · 선행: CU-03
- 근거: Windows는 Terminal·Browser run만 지원(커밋 3f57dc6, b9a98d9). OS 데스크톱 adapter 코드 0건.
- 빠진 것: macOS 외 플랫폼의 데스크톱 관찰·조작 없음.
- 환경 제약: 각 OS 실제 장비와 권한 필요.
- 구현 스케치: CU-03의 adapter 인터페이스를 OS별 구현으로 분리(helper-rust에 windows/linux feature). macOS 완성 후 착수.

</details>

## Canvas · UI/UX · 디자인

Canvas·Viewport·UI/UX·디자인 영역은 바탕이 이미 깔려 있다. 의미 확대(semantic zoom), 1–400% 확대, 미니맵 드래그, 최대화 시 HUD 숨김, Board 영역 사각형, 자원 사용량 표시 4개(호스트 기준), Answer Briefing(단계 이동·카메라 맞춤·단계 의견을 다음 Chat에 첨부), 승인된 데스크톱 색 토큰(:root)이 동작한다. 아직 없는 것과 덜 된 것은 아래 17개다.

1. 확인된 문서-코드 불일치
- 비전 문서 P1 "[x] Shape tools: square, ellipse, line, arrow, pen"에서 arrow와 pen은 구현되어 있지 않다.
- Dock의 '선택'은 arrow 아이콘을 쓰는 선택 도구일 뿐이다.
- Dock의 '펜' 버튼은 눌러도 아무 동작이 없다(캔버스 mousedown이 marquee 선택으로 빠진다).
- 도형 검증 스크립트도 사각형·원·선만 그린다.

2. 아예 없는 것
- AI Canvas annotation 레이어 전체
- Canvas Memo
- 화면에 보이는 Board 감지(교차 면적 순위, "+N" 표시)
- 미니맵의 Board별 영역
- 배치 조작(격자 맞춤·배치 실행 취소·정리·그룹)
- 다크 테마
- 상단 검색의 'AI에게 요청' 경로

3. 덜 된 것
- Board 영역 시각: 점선과 파란 버튼 줄이라 승인 스타일과 다르다. 활성 Board 표시가 없다.
- 카드 배치 정책: 빈자리 탐색은 Chat 카드만 쓰고, File 카드는 월드 좌표 180,140에 고정된다.
- 리소스 모니터: 네트워크는 macOS 전용이다. 디스크 읽기·쓰기 속도와 앱 범위 값이 없다.
- Briefing: 단계 대상이 원문 줄 범위로 한정된다.
- 화면 용어: 'Agenda'와 영어 문구가 남아 있다.
- 비승인 파란 계열 색: 코드 블록, 활동 패널, Board 바에 남아 있다.

4. 디자인 기준 문서끼리의 충돌
- egdesk-ux-realization-proposals.md의 토큰 표(파란 #2B57C8, 본문 16px)와 승인된 데스크톱 스타일(세이지 #49634F, 13px/12px)이 서로 다르다.

| ID | 상태 | 크기 | 대표님 화면에서 달라지는 점 | 결정 | 환경 제약 |
|---|---|---|---|---|---|
| CNV-01 | 완료 | M | 캔버스 위에서 어느 카드들이 어떤 Board에 묶여 있고 지금 작업 중인 Board가 어디인지 한눈에 보인다. |  |  |
| CNV-02 | 완료 | M | 새 창이나 Board를 열면 지금 보고 있는 화면 안의 빈자리에 겹치지 않게 나타나서 찾으러 다닐 필요가 없다. |  |  |
| CNV-03 | 일부 | M | 작업 중 연 화면을 원하는 Board에 넣거나 빼고, 각 창이 어느 Board 소속인지 창 머리에서 바로 본다. | 결정됨(D-V1~V4) |  |
| CNV-04 | 완료 | M | Dock의 펜으로 실제로 그릴 수 있고, 화살표와 글자 메모로 캔버스 위 자료를 가리키며 설명할 수 있다. |  |  |
| CNV-05 | 일부 | XL | '이 화면에서 로그인 버튼 찾아서 표시해줘'라고 하면 AI가 해당 카드 위에 상자와 이름표를 그리고, 사용자가 옮기거나 지우거나 받아들일 수 있다. | 결정됨(D-K1) | 있음 |
| CNV-06 | 일부 | L | 캔버스에 짧은 메모를 붙여 두고, 필요할 때 그 메모를 근거로 특정 Agent에게 바로 물어볼 수 있다. | 결정됨(D-K5) |  |
| CNV-07 | 일부 | L | AI 답변을 단계별로 따라갈 때 화면이 해당 위치로 움직이고 그 단계의 표식이 강조되어, 긴 결과도 순서대로 이해할 수 있다. |  |  |
| CNV-08 | 일부 | M | Windows에서도 네트워크 사용량이 보이고, 지금 느린 게 PC 전체 탓인지 EG-Desk 탓인지 구분할 수 있다. | 필요 | 있음 |
| UX-01 | 완료 | S | 캔버스를 이리저리 옮겨도 상단 이름이 지금 화면에 보이는 Board를 따라가서 현재 위치를 잃지 않는다. |  |  |
| UX-02 | 일부 | M | 작은 지도에서 각 Board 위치를 보고 눌러서 바로 이동할 수 있고, 창이 많아도 이름으로 찾아간다. |  |  |
| UX-03 | 완료 | S | 화면 어디서나 같은 이름(Board)과 한국어 문구를 보게 되어 헷갈리지 않는다. |  |  |
| UX-04 | 없음 | S | 상단 검색창에 할 일을 적고 Enter를 누르면 바로 Agent에게 요청 초안이 만들어진다. | 필요(D-K2) | 있음 |
| UX-05 | 일부 | L | 창을 깔끔하게 줄 맞춰 놓고, 실수로 옮긴 배치를 되돌리고, 여러 창을 한 번에 정리하거나 묶을 수 있다. | 결정됨(D-V5) |  |
| UX-06 | 일부 | M | 카드를 크게 띄운 채로 채팅을 잠깐 열어 보거나 옆에 고정해 둘 수 있고, 창을 접어 둘 수도 있다. | 결정됨(D-V6) |  |
| DSN-01 | 완료 | M | 시스템을 다크 모드로 쓰면 EG-Desk도 눈부시지 않은 어두운 화면으로 바뀐다. |  |  |
| DSN-02 | 일부 | S | 활동 패널·코드 블록·Board 표시까지 승인된 따뜻한 무채색과 세이지 톤으로 통일되어 화면이 한 제품처럼 보인다. |  |  |
| DSN-03 | 일부 | S | 디자인 기준이 하나로 정리되어 새 화면을 만들 때마다 색이나 글자 크기가 들쭉날쭉하지 않다. | 결정됨(D-G1·G5) |  |
| DSN-04 | 완료 | S | 화면 움직임에 어지러움을 느끼는 사용자는 동작 줄이기 설정만으로 화면이 순간 이동하게 바꿀 수 있다. | 결정됨(D-G2·G3) |  |

<details><summary>항목별 근거·빠진 것·구현 스케치</summary>

### CNV-01 — Board 영역을 무한 캔버스에서 시각적으로 구분한다. 승인 스타일 기준은 옅은 실선 테두리, 14px 모서리, 아이콘이 붙은 영역 이름이다. 활성 영역만 2px 경계와 '현재 Board' 표시를 갖고, 안쪽 여백 24px·제목줄 36px를 지키며, 축소 상태에서도 Board 이름을 읽을 수 있어야 한다.

- 출처: EGDESK_PRODUCT_VISION_AND_DEV_TODO.md: P1 Canvas and Viewport 'Board region visual distinction'; egdesk-ux-realization-proposals.md:1503(새 Board 영역 규칙); egdesk-approved-desktop-style.html .eg-board-region/.eg-region-label
- 상태: 일부 · 크기 M · 선행: DSN-02
- 근거: overlay/JS/eg-desk-surface.uc.js:1747-1768 refreshBoardRegion가 멤버 bounding box에서 18px·48px 여백으로 egd-board-region을 만들고, 바에 '저장/Chat 첨부/닫기' 버튼을 둔다. overlay/CSS/eg-desk-surface.uc.css:334-336은 '1px dashed #a9b7c1'과 버튼 글자색 #2d5a7b로, 승인 팔레트에 없는 파란 계열이다. 활성 projection을 구분하는 CSS 클래스나 '현재 Board' 문구는 검색되지 않는다. 영역은 world layer에 있어 확대 배율에 따라 함께 줄어든다(의미 확대용 화면 공간 표식 없음, 정적 판단).
- 빠진 것: 승인 스타일의 영역 테두리·이름 표식으로 바꿔야 한다(점선과 버튼 줄 대신 아이콘+이름, 행동은 [⋯] 메뉴로). 활성 Board 강조와 '현재 Board' 표시, 영역의 미저장 상태 표시가 없다. 24px/36px 규격과, 멀리 축소했을 때 화면 공간에 이름을 띄우는 처리도 필요하다.
- 구현 스케치: eg-desk-surface.uc.js refreshBoardRegion: 버튼 줄을 이름 표식(아이콘+제목)과 [⋯] 메뉴로 바꾸고, 활성 projection에 data-active를 붙인다(selectBoardProjection 1737에서 토글). uc.css 334-336은 승인 HTML의 .eg-board-region/.eg-region-label 값을 --egd 토큰으로 옮긴다. 의미 확대 render(13300 부근)에 Board 이름 proxy를 추가한다. 검증은 verify-firefox-mcp-first-use-board.mjs에 활성 표시 단언을 추가한다.

### CNV-02 — 카드 배치 정책을 정한다. 모든 View 유형이 새로 열릴 때 보이는 안전 영역 안의 빈자리를 찾고, 기존 View를 밀지 않으며, 새 Board 영역은 24px 간격의 가장 가까운 빈 위치에 놓는다. 유형별 기본 크기(Browser 960×640, File 720×640, Chat 420×600, Terminal 800×400)를 적용하고, 미저장 변경 보호를 둔다.

- 출처: 비전 P1 'Card placement policy: empty-space search, active Board placement, unsaved changes guard'; VIEWPORT_LAYOUT_INTERACTION_MODEL.md 'Safe Area'·'Auto Layout Policy'; proposals.md:1634, 1696-1704
- 상태: 일부 · 크기 M
- 근거: uc.js:3385-3434 resolveCanvasCardPlacement(겹침 점수 기반 후보 탐색)는 Chat 카드 생성(uc.js:7054)에서만 호출된다. File 카드는 uc.js:9613에서 월드 좌표 left 180px·top 140px 고정이다. Browser(uc.js:10585-10590)와 Terminal(12407-12412)은 화면 중심 기준 24px씩 계단식으로 놓인다. 기존 Board 다시 열기 배치는 uc.js:1777-1781 'max right + 64, y:0'이다. 미저장 보호는 Board 전환 확인('Agenda를 전환할까요?' uc.js:2944-2945)과 scripts/verify-firefox-mcp-agenda-close-guard.mjs로 존재한다.
- 빠진 것: Browser, File, Terminal, Settings, Ontology 카드에 빈자리 탐색이 적용되지 않는다. 특히 File 카드는 카메라가 다른 곳을 보고 있으면 화면 밖에 열린다. Board 다시 열기 배치가 '가장 가까운 빈 위치·24px 간격'이 아니다. 유형별 기본·최소 크기 표준이 없다(Browser는 720폭).
- 구현 스케치: uc.js의 resolveCanvasCardPlacement를 공통 배치 함수로 승격하고, 모든 spawn*Card(9606, 10575, 12397, 9709, 9317)가 이 함수를 통해 위치를 잡게 한다. 기존 Board 다시 열기(1777)도 occupied rect 기준 최근접 빈 위치 탐색으로 바꾼다. 유형별 기본·최소 크기 표는 EGDeskSurfaceState.sys.mjs에 순수 함수로 두고 scripts/egdesk-surface-state.test.mjs로 단위 검증한다.

### CNV-03 — Board 소속 편집과 표시: 열린 Board에 화면을 추가하거나 제외할 수 있어야 한다. View bar 오른쪽에 소속 Board 이름을 보이고, 여러 Board에 속하면 '+1'로 표시한다. 새 View를 활성 Board에 넣는 정책도 필요하다.

- 출처: 비전 P1 'active Board placement'; proposals.md:1505-1507(다중 소속 표시), 1525-1529(제외 메뉴); approved-desktop-style.html .eg-win-meta(창 제목줄 오른쪽 Board 이름)
- 상태: 없음 · 크기 M · 선행: CNV-01
- 근거: 구성원은 Board를 만들 때 고정된다. serializeAgendaSnapshot(uc.js:1656-1680)은 projection.members만 저장하고, members에 추가·제거하는 코드는 grep 'members.push\|addBoardMember\|Board에서 제외' 0건이다. 창 제목줄(uc.js:7470-7477)은 신호등 점·grip·identity·actions뿐이고 소속 Board 표시가 없다.
- 빠진 것: 기존 Board에 화면을 추가·제외하는 조작과 상태 변경이 없다. 창 bar에 소속 Board 표시가 없고, 같은 View가 여러 Board에 속할 때의 표시도 없다. 활성 Board가 있을 때 새 View를 어떻게 다룰지에 대한 정책도 없다.
- 결정: true: 활성 Board가 있을 때 새로 연 View를 그 Board에 자동으로 넣을지, 사용자가 [Board에 추가]로 명시할 때만 넣을지 정해야 한다. proposals.md는 '묵시적으로 포함하지 않는다'와 '경계를 넘겨도 소속 자동 변경 없음'을 적고 있고, 비전은 'active Board placement'를 적고 있어 서로 엇갈린다.
- 구현 스케치: EGDeskSurfaceState.sys.mjs에 addProjectionMember/removeProjectionMember 순수 함수와 테스트를 추가한다. uc.js에서는 창 [⋯]에 'Board에 추가/○○에서 제외' 메뉴를 붙이고 markAgendaDirty로 dirty 처리한다. spawnDeskWindowShell의 identity 옆에 .egd-window-board-meta를 두고 dataset.boardId와 projection 제목으로 갱신한다.

### CNV-04 — 캔버스 도형 도구를 완성한다. 화살표, 펜(자유선), 레이블(텍스트), 하이라이트(반투명 사각형)를 기존 사각형·원·선과 같은 편집·선택·삭제·Board 저장 경로로 제공한다.

- 출처: 비전 P1 '[x] Shape tools: square, ellipse, line, arrow, pen'(체크되어 있으나 미구현); AI_CANVAS_ANNOTATION_LAYER.md 'Next primitives: arrow, label, highlight, freehand path'; Atlas CANVAS-01 [주석 도구] 8종
- 상태: 일부 · 크기 M
- 근거: Dock 정의 uc.js:73-80: '펜'(pencil), '사각형', '원', '선', '선택'(id 'arrow'은 선택 포인터다). activeToolIsShape(uc.js:3288-3290)는 square·ellipse·line만 참이다. 캔버스 mousedown(uc.js:13577-13590)에는 pencil 분기가 없어 marquee 선택으로 빠진다. 'pencil'은 아이콘 정의(1154·4274) 말고는 처리 코드가 없다. createCanvasShape(7655-7672)는 rect·ellipse·line만 만든다. scripts/verify-firefox-mcp-shapes.mjs:169-171은 square·ellipse·line만 검증한다.
- 빠진 것: 화살표 도형이 없다(현재 Dock의 'arrow'은 선택 도구). 펜 버튼은 눌러도 무동작이다. 레이블·하이라이트 도형이 없다. 비전 문서의 체크 표시가 사실과 다르다.
- 구현 스케치: uc.js의 createCanvasShape/updateCanvasShapeGeometry에 arrow(선+머리), path(SVG polyline 누적), label(contenteditable), highlight를 추가한다. activeToolIsShape와 shapeTypeForTool을 확장하고, serializeShapeState/restoreShapeFromState에 points·text 필드를 추가한다. DOCK_CENTER의 '선택' id를 'select'로 바꿔 화살표 도구와 구분한다. verify-firefox-mcp-shapes.mjs에 4종 그리기·저장·복원 단언을 추가하고, 비전 문서 체크박스를 고친다.

### CNV-05 — AI Canvas annotation 레이어를 만든다. 에이전트는 구조화된 AnnotationSet(box·ellipse·line·arrow·label·highlight)을 반환하고, EG-Desk는 이를 카드 기준 정규화 좌표로 편집 가능한 도형으로 표시한다. 상태(제안·수락·편집·기각)와 출처(run·message)를 보존하고, 카드·Board별로 표시하거나 숨길 수 있다. Chat에는 짧은 요약과 결과 chip만 남긴다.

- 출처: 비전 P1 'AI canvas annotation mode'; apps/firefox-ui-demo/docs/AI_CANVAS_ANNOTATION_LAYER.md 전체(MVP P0/P1/P2); Atlas CANVAS-01; proposals.md:2197-2224
- 상태: 없음 · 크기 XL · 선행: CNV-04, CNV-01, BRW 영역: Browser 카드 화면 캡처
- 근거: grep 'annotat' in helper/*.mjs, overlay/resources/*.mjs, overlay/JS/eg-desk-surface.uc.js: 0건. Browser 도구는 helper/codex-browser-tool-provider.mjs의 egdesk_browser_click/fill/observe 3개뿐이고 화면 캡처 도구가 없다(grep screenshot 0건). 참고 패턴으로 쓸 수 있는 에이전트→캔버스 게시 도구는 helper/egdesk-context-runtime.mjs:10 egdesk_publish_briefing이다.
- 빠진 것: AnnotationSet 스키마, 카드 기준 정규화 좌표와 이동·크기 변경 시 재투영, 제안·수락·기각 UI, 출처 연결, 표시·숨김, Board 저장, 에이전트 게시 도구, Browser 카드 화면 캡처, Chat 요약 chip까지 전부 없다.
- 환경 제약: P0(수동·API 생성, 표시, 저장)는 fixture로 검증할 수 있다. 시각 근거 기반 자동 표식(P1·P2)은 실제 Codex 계정 로그인과 이미지 입력을 받는 모델 호출이 있어야 실검증할 수 있다.
- 구현 스케치: 두 단계로 나눈다. P0: overlay/resources에 EGDeskAnnotationState.sys.mjs를 새로 두어 스키마 검증과 정규화·재투영 순수 함수, 단위 테스트를 만든다. uc.js에서는 대상 카드의 자식 overlay로 CNV-04 도형을 렌더하고, 상태 배지와 [수락]/[기각]/[숨기기]를 붙이고, Board 저장에 annotations를 추가한다. P1: helper/egdesk-context-runtime.mjs에 egdesk_publish_annotation 도구(egdesk_publish_briefing과 같은 검증 패턴)를 추가하고, Chat 메시지에 결과 chip을 단다. 화면 캡처는 BRW 영역과 함께 만든다.

### CNV-06 — Canvas Memo를 만든다. 대상이나 위치에 고정되는 240×160 메모(펼치면 320×280)로, 사용자 본문과 작성자별 Agent 답글을 분리한다. [Rio에게 묻기]처럼 실제 수신자를 명시해 질문하고, 저장만으로는 에이전트를 호출하지 않는다.

- 출처: Atlas CANVAS-01(시각 표식과 위치 메모); proposals.md:2207-2224, flow-memo(314-357); approved-desktop-style.jpg의 '회의 준비 메모' 창, --eg-note 토큰
- 상태: 없음 · 크기 L · 선행: CNV-02, CHAT 영역: Agent DM 초안 생성·전송 경로
- 근거: uc.js에서 grep 'memo\|egd-note'를 하면 '메모리'(자원 표시)만 나오고 Memo 카드 코드는 0건이다. uc.css:27에 --egd-note: #F5F0DF 토큰은 정의되어 있지만 사용처가 없다.
- 빠진 것: Memo View 유형, 저장과 Board 소속, 본문과 답글 분리, 수신자를 명시한 질문 초안 연결, 대상이 없어졌을 때의 경고가 전부 없다.
- 구현 스케치: uc.js에 spawnMemoCard를 추가한다(spawnDeskWindowShell 사용, --egd-note 배경). serializeCardState와 Board 복원(mountBoardMember 1690대)에 'memo' type을 추가한다. 1단계는 본문 편집·이동·삭제·저장만 하고, 2단계는 [Agent에게 묻기…]가 openChatInputPanel 계열로 Memo revision을 첨부한 초안을 여는 방식으로 연결한다. verify 스크립트를 새로 만든다.

### CNV-07 — Canvas 후속 설명 모드(Answer Briefing)를 완성한다. 단계별 카메라 이동과 단계 의견은 이미 있다. 남은 것은 단계 대상으로 캔버스 영역·annotation·Browser View를 지정하는 것, 진행 중 화면 chrome 조정, 미니맵의 다음·이전 화면 밖 대상 표시, 단계 내 표식 강조다.

- 출처: 비전 P1 'Canvas output follow-up mode: temporal/spatial steps, camera movement, annotations, and comment anchors'; 비전 P0 'Prezi-like canvas run playback with step comments'; VIEWPORT 문서 Chrome Mode 'runPlayback' 행
- 상태: 일부 · 크기 L · 선행: CNV-05, UX-02
- 근거: 구현된 부분: uc.js:860-946 openAnswerBriefing·renderAnswerBriefing(이전·다음·전체 보기·종료, fitBriefingTargets 카메라 맞춤, 단계 의견 → '다음 Chat 초안에 포함'). overlay/resources/EGDeskBriefingState.sys.mjs(70줄). helper/egdesk-context-runtime.mjs:10에서 에이전트 도구 egdesk_publish_briefing의 target이 sourceId/artifactId/viewId+line range로 한정된다. 검증 스크립트는 scripts/verify-firefox-mcp-context-briefing.mjs.
- 빠진 것: 단계 대상이 원문 줄 범위 중심이라 캔버스 영역 좌표, annotation 묶음, Browser 화면 영역을 지정할 수 없다. 진행 중 Dock과 레일을 줄이는 chrome 모드가 없다. 미니맵에 화면 밖 단계 대상이 표시되지 않는다. 단계에서 annotation을 강조할 수 없다.
- 구현 스케치: egdesk-context-runtime.mjs의 briefing target 스키마에 canvasRect·annotationSetId를 추가하고 검증한다(paths·URL 금지 유지). BriefingState.resolveBriefingTargets를 확장한다. uc.js renderAnswerBriefing에 data-chrome-mode='briefing' 토글과 annotation 강조를 넣고, renderDeskMinimapWorld에 단계 대상 마커를 추가한다.

### CNV-08 — 자원 모니터의 남은 범위: Windows·Linux 네트워크 측정, 디스크 읽기·쓰기 전송률(공간과 별개), PC 전체와 EG-Desk 앱 범위의 구분, 경고 임계값·이력 보존 결정.

- 출처: 비전 P1 'CPU/RAM/disk/network monitoring ... distinguish host/app scope' (placement·scope·cadence·thresholds·history 미선정); Contract impl-resource-monitor(1285-1310); proposals ux-resource-monitor(1386-1414)
- 상태: 일부 · 크기 M
- 근거: 구현된 부분: uc.js:3906-4060 buildResourceGadget(4개 링, 5초 poll, 15초 지나면 미측정 처리, Esc·바깥 클릭 닫기, 상세에 기준·대상 표시). helper/system-resource-monitor.mjs(214줄)와 test(275줄, 12개 테스트), 커밋 6a1ef62·08238f0. 위치는 VIEWPORT 문서에서 상단 오른쪽으로 승인됐다. 남은 부분: system-resource-monitor.mjs:158-165에서 네트워크는 platform==='darwin'일 때만 측정하고 그 외는 'unsupported'다. 191에서 scope는 'host'만 있다. 디스크는 statfs 공간만 보고, 읽기·쓰기 속도 필드가 없다.
- 빠진 것: Windows 실행 경로(b9a98d9)가 있는데 네트워크 링이 항상 미지원으로 나온다. Contract가 요구하는 디스크 전송률과 앱 범위 표시가 없다. 임계값과 이력은 미정이다.
- 결정: true: (1) 기본 범위를 PC 전체 하나로 둘지, EG-Desk 앱 값을 상세에 함께 보일지 (2) 경고 임계값을 둘지, 둔다면 값 (3) 장기 이력을 보존할지. 현재 코드는 PC 전체 기준, 5초 간격, 임계값·이력 없음을 임의로 택한 상태다.
- 환경 제약: Windows·Linux 네트워크와 디스크 I/O 수집은 해당 OS 실기기에서만 실측 검증할 수 있다(파서 단위 테스트는 가능).
- 구현 스케치: helper/system-resource-monitor.mjs의 readNetwork에 Windows(Get-NetAdapterStatistics 또는 netstat -e)와 Linux(/proc/net/dev) 파서를 추가하고, 디스크 I/O는 macOS(iostat)와 Linux(/proc/diskstats)를 추가한다. 응답에 app 섹션(process.memoryUsage와 Firefox PID 합산은 범위 결정 뒤)을 넣는다. uc.js buildResourceGadget의 rows()에 디스크 속도와 앱 행을 추가한다. 각 파서에 단위 테스트를 단다.

### UX-01 — 화면에 보이는 Board를 감지해 상단 표시에 반영한다. 순위는 '보이는 활성 Board → 화면과 가장 많이 겹치는 Board → 활성 카드 소속 → 최근 포커스 → Desk'다. 여러 Board가 보이면 '이름 · +2'로 표시하고, 없으면 'Board 없음'으로 표시한다.

- 출처: VIEWPORT_LAYOUT_INTERACTION_MODEL.md 'Viewport Board Detection'(ranking, '태화 5월 리포트 · +2'); Acceptance 'The top bar tells the user which Board they are looking at'
- 상태: 없음 · 크기 S · 선행: CNV-01
- 근거: uc.js:3457-3461 currentViewportAgendaLabel은 state.agenda.activeTitle을 반환하고, 없으면 group thread 제목이나 'EG-Desk'를 반환한다. 카메라와 Board 영역의 교차 계산, '+N' 표시 코드는 없다(grep 0건). syncViewportAgendaRail(3479-)은 이 라벨을 그대로 쓴다.
- 빠진 것: 카메라 이동에 따른 Board 판별, 순위 규칙, 여러 Board가 보일 때의 표시, Board가 없을 때의 표시가 없다.
- 구현 스케치: EGDeskSurfaceState.sys.mjs에 resolveViewportBoard(viewportWorldRect, regions, activeId, activeEntityBoard, recent) 순수 함수와 테스트를 추가한다. uc.js의 카메라 apply()(13353대)와 refreshBoardRegion 뒤에 throttle된 갱신을 걸고, currentViewportAgendaLabel이 결과와 '+N'을 반환하게 한다.

### UX-02 — 미니맵에서 대상을 찾게 한다. Board별 영역을 표시하고, 영역을 누르면 그 Board로 카메라가 이동한다. 겹친 지점은 '이 위치의 N개' 목록으로 고르고, 전체 화면 목록을 검색할 수 있게 하며, 한국어 라벨과 Briefing 대상 표시를 넣는다.

- 출처: VIEWPORT 문서 'Desk Minimap'(Board regions, click Board region → pan/zoom, focusTarget); proposals.md:1659-1664 ux-detail-minimap-targets
- 상태: 일부 · 크기 M · 선행: CNV-01
- 근거: 완료된 부분은 미니맵 viewport 박스 드래그(scripts/verify-firefox-mcp-minimap-drag.mjs)와 희소도 기반 크기(uc.js:3629-3643)다. 남은 부분: renderDeskMinimapWorld(uc.js:3705-3725)는 전체 bounds 하나만 'egd-minimap-agenda'로 그리고 현재 라벨을 붙인다(Board별 영역 없음). 목록은 처음 8개로 잘린다(3728 slice(0,8)). 영어 라벨이 남아 있다: 'Desk Minimap'(3854), '0 objects · 1x spread'(3641·3858), 'Rect/Ellipse/Line'(3736-3738).
- 빠진 것: Board별 영역 표시와 그 영역으로 이동하는 동작, 겹친 대상 선택, 8개를 넘는 대상 검색, Briefing 대상 마커가 없고 라벨이 영어다.
- 구현 스케치: uc.js renderDeskMinimapWorld에서 state.boards.projections를 돌며 각 영역 rect를 그리고 onclick에 setCanvasPanTarget을 단다. buildDeskMinimapEntityRows를 검색 input과 전체 목록으로 바꾼다. 같은 지점 클릭이면 egd-minimap-stack 팝업을 띄운다. 문구를 한국어로 바꾼다. verify-firefox-mcp-minimap-drag.mjs에 Board 영역 클릭 단언을 추가한다.

### UX-03 — 제품 용어와 문구를 정리한다. 화면에 보이는 'Agenda'를 'Board'로 바꾸고(채팅 'Agenda Thread'는 'Board Thread'), 영어 상태 문구('Unsaved', 'Agenda saved', 'Desk Minimap', 검색 구역 'Canvas/History/Files/Web', 'Search "q"', 'Browser card')를 한국어 제품 문구로 바꾼다.

- 출처: 비전 문서 머리말 'Some current runtime identifiers and UI copy still say Agenda'; CHAT_DESIGN_GRAMMAR_V1 Naming Rules('Board Thread // not group chat'); VIEWPORT 'The existing label 메인 데스크 should be treated as a temporary placeholder'
- 상태: 일부 · 크기 S
- 근거: uc.js:94-97 THREAD_KIND_META label 'Agenda'·'Agenda Thread'·'새 Agenda Thread', 282 'Agenda Thread · 멤버', 2614 검색 구역 'Agenda', 2945 'Agenda를 전환할까요?', 3161 'Agenda 검색...', 3508 'Agenda saved', 4772 'Agenda N', 4792 필터 'Agenda', 5061 'Agenda에서 제거'. 그 밖의 영어 문구: 2284·4116 'Unsaved', 2647/2672/2690/2731 구역명, 2732-2733 'Search "…"'·'Browser card'. 'Board 이름'(3033)과 '새 Board'(3035)처럼 일부는 이미 Board로 바뀌어 섞여 있다.
- 빠진 것: 화면 문구의 Agenda/Board 혼용과 영어 상태 문구가 남아 있다(내부 식별자 state.agenda 등은 그대로 둬도 된다).
- 구현 스케치: uc.js에서 사용자에게 보이는 문자열 리터럴만 바꾼다(aria-label, textContent, placeholder, title). state·dataset·testid는 유지한다. 바꾼 문자열을 단언하는 verify 스크립트(verify-firefox-mcp-agenda-switcher.mjs, rail-search.mjs 등)의 기대값도 함께 수정한다. 비전 문서 머리말의 주석도 갱신한다.

### UX-04 — 상단 검색창 '검색 또는 AI에게 요청...'에서 실제로 AI 요청을 보낼 수 있게 한다. 입력 문장을 지정된 Agent 대화의 초안으로 넘기고, 수신자를 표시한다.

- 출처: approved-desktop-style.jpg 상단 검색 '검색 또는 AI에게 요청...'; uc.js:4125 placeholder; proposals.md:2215 '마지막 채팅 상대나 가까운 View로 수신자를 추정하지 않는다'
- 상태: 없음 · 크기 S · 선행: CHAT 영역: 초안 생성·전송 경로
- 근거: uc.js:4125 placeholder '검색 또는 AI에게 요청...'. buildRailSearchResults(2740-) 구역은 Agenda·Canvas·History·Files·Chat(기존 대화 찾기)·Web뿐이고, 'AI에게 요청' 결과나 동작이 없다(grep 'AI에게\|askAi' 결과는 placeholder 1건).
- 빠진 것: 자리표시 문구가 약속한 AI 요청 경로가 없다.
- 결정: true: 상단 요청을 누구에게 보낼지 정해야 한다. 선택지는 '항상 기본 Codex 새 대화', '현재 선택된 대화', '매번 고르기'다. proposals는 수신자 추정을 금지하므로 고정 기본값이나 선택 UI 중 하나가 필요하다.
- 환경 제약: 실제 전송까지 검증하려면 Codex 로그인 계정이 필요하다(초안 생성까지는 fixture로 가능).
- 구현 스케치: uc.js buildRailSearchResults에 type 'ask' 결과(수신자 이름 표시)를 추가한다. execute에서는 openCodexThreadFromRailSearch와 composer draft 주입을 한다(자동 전송 금지). handleRailSearchKeydown의 Enter 기본 동작에 ask를 포함할지는 결정에 따른다.

### UX-05 — 배치 조작을 제공한다. 24px 격자와 8px 안내선 맞춤(Option/Alt로 해제), 배치 실행 취소(View bar 포커스일 때 ⌘/Ctrl+Z), [선택 N개 겹침 없이 정리], [그룹으로 묶기]·[그룹 해제], [이동]/[크기] 숫자 입력이다.

- 출처: proposals.md:1640-1646, 1708-1720(ux-detail-view, 배치 실행 취소, Pan·zoom·스냅); 1545-1549(겹침 없이 정리)
- 상태: 없음 · 크기 L · 선행: CNV-02
- 근거: uc.js에서 grep 'snap\|GRID_SIZE\|alignGuide\|undo\|groupId\|겹침\|정리\b' 0건이다(12674 'Firefox chrome 정리' 주석만 나옴). 다중 선택은 marquee(uc.js:13591-13598)와 egd-entity-selected로 존재한다.
- 빠진 것: 격자·안내선 맞춤, 배치 되돌리기, 겹침 정리, 중첩 그룹, 숫자로 이동·크기 지정이 모두 없다.
- 결정: true: proposals 6.A는 '후보' 상태다. 1차로 넣을 조작을 골라야 한다(추천: 격자 맞춤 + 배치 실행 취소 + 겹침 정리. 그룹·숫자 입력은 2차).
- 구현 스케치: EGDeskSurfaceState.sys.mjs에 snapRect·arrangeWithoutOverlap(선택 외는 장애물) 순수 함수와 테스트를 추가한다. uc.js의 카드 드래그·resize 핸들러에 snap을 적용하고, 배치 변경 명령 스택(state.layoutHistory)을 두어 ⌘Z를 bar 포커스로 한정한다. 선택 도구줄에 [정리]를 추가한다.

### UX-06 — 최대화와 집중 보기 표현 모드를 나눈다. 최대화 중 HUD는 엿보기(덮어 보이고 재배치 없음)와 고정(최대화 카드만 재배치) 두 방식을 둔다. Browser 외 유형에도 전체 화면 집중 모드를 두고, Esc는 위에 열린 것부터 닫는다. View 최소화는 접힌 node로 대신한다.

- 출처: VIEWPORT 문서 'Card Presentation Modes', 'HUD Visibility While Maximized'(peek/pinned), 'Keyboard policy Esc'; proposals.md:1427-1435(View 닫기 → 접힌 node)
- 상태: 일부 · 크기 M
- 근거: 완료된 부분: uc.js:7268-7330 enterCardFullscreen·exitCardFullscreen(HUD 숨김, 미니맵 닫기·복원, restoreRect 보존, Browser는 egd-browser-fullscreen-active 전체 화면), 커밋 050b7db·ba7f008, 상단 'Maximized' 배지(3523-3531). 남은 부분: 'focusFullscreen\|peek\|pinned\|chromeMode' grep 0건. 창 최소화 컨트롤은 uc.js:7446-7449에서 aria-disabled이고 title이 '창 최소화는 아직 지원되지 않음'이다.
- 빠진 것: HUD 엿보기와 고정 모드, Browser 외 유형의 전체 화면 집중 모드, Esc 우선순위의 일관 처리, 최소화나 접힌 node가 없다(비활성 버튼이 화면에 보인다).
- 구현 스케치: uc.js에서 state.cardFullscreen에 mode('maximized'\|'focus')와 hudMode('hidden'\|'peek'\|'pinned')를 추가한다. setHudPresentationHidden을 hudMode에 맞게 확장하고 syncCardFullscreenLayout이 pinned일 때 safeViewportRect({avoidHud:true})를 쓰게 한다. 최소화는 접힌 bar 표시(본문 renderer는 유지)로 구현하고, 그 전까지는 비활성 버튼을 숨긴다.

### DSN-01 — 다크 테마: 승인 스타일 HTML의 light-dark 토큰 쌍을 production --egd-* 토큰에 반영하고, 시스템 설정에 따라 전환한다.

- 출처: egdesk-approved-desktop-style.html 루트 스타일(color-scheme: light dark; --eg-ink: light-dark(#252a26,#edece7) 등 전 토큰); proposals.md:52-62 토큰 표 '어두운 화면' 열
- 상태: 없음 · 크기 M · 선행: DSN-02, DSN-03
- 근거: overlay/CSS/eg-desk-surface.uc.css(5,887줄)에서 grep 'prefers-color-scheme\|light-dark\|data-theme' 0건이다. :root 토큰(10-49)은 밝은 값만 있다. 하드코딩 색이 많다(#fff 19회, #2d5a7b 7회 등). 반면 승인 HTML은 모든 --eg-* 토큰을 light-dark로 정의한다.
- 빠진 것: 다크 모드 토큰과 전환이 없다. 하드코딩 색이 남아 있어 토큰만 바꿔서는 일부가 밝게 남는다.
- 구현 스케치: uc.css :root 아래에 @media (prefers-color-scheme: dark)로 승인 HTML의 어두운 값을 --egd-*에 매핑한다. DSN-02에서 남은 하드코딩 색을 토큰으로 치환한 뒤 적용한다. 사이트 본문(Browser 내용)과 Terminal은 강제 변경하지 않는다. 헤드리스 UI 회귀(verify-firefox-mcp-headless-ui-regression.mjs)에 다크 캡처를 추가한다.

### DSN-02 — 승인 팔레트에서 벗어난 색과 이중 덧칠 CSS를 정리한다. 레거시 파란 계열 하드코딩 색을 --egd-* 토큰으로 치환하고, 같은 선택자를 여러 번 덮어쓰는 구간을 하나로 합친다.

- 출처: CHAT_DESIGN_GRAMMAR_V1 'Approved Visual Baseline (overlay/CSS/eg-desk-surface.uc.css owns the accepted token values)'; VIEWPORT 문서 approved style 색 목록
- 상태: 일부 · 크기 S
- 근거: Chat 말풍선과 composer는 uc.css:5641-5714에서 승인 토큰으로 재정의되어 정렬됐다. 아래는 레거시 색이 아직 최종값으로 남는 곳이다(정적 판단). uc.css:336 Board 바 #2d5a7b. 5507-5508 inline code #354F65/#E5EBF1, 코드 블록 #F0F3F6/#2B4053/#DEE6ED. 5572 #egd-codex-activity-panel #FFFFFF/#DCE4EB/#243342(3545의 토큰값을 덮음). 5588 thread search #F4F7F9. 5519 chip-subtle #F4F7F9. 그리고 5482-5600 블록 전체가 뒤에서 다시 덮이는 이중 구조다.
- 빠진 것: 활동 패널, 코드 표시, 대화 검색창, Board 바에 승인되지 않은 파란 회색 계열이 남아 있다. 덧칠이 겹친 구조라 이후 수정 때 회귀 위험이 크다.
- 구현 스케치: uc.css에서 #2D5A7B/#244a66/#607688/#243342/#E3EEF5/#F4F7F9/#E5EBF1/#F0F3F6 계열을 찾아 --egd-primary/on-surface/window-alt/outline 등으로 치환한다. 5482-5600 레거시 블록에서 5641-5714와 겹치는 선택자를 지워 하나의 정의만 남긴다. 실행 검증은 헤드리스 UI 회귀 캡처로 전후를 비교한다(RAM 여유가 있을 때).

### DSN-03 — 디자인 기준 문서끼리의 충돌을 정리한다. ux-realization-proposals의 공통 시각 기준선(파란 행동색 #2B57C8, Canvas #F5F6F8, 본문 16px, 보조 14px)을 승인된 데스크톱 스타일(세이지 #49634F, 나무결 #E8E2D7, 셸 13px·말풍선 12px)에 맞춰 갱신하거나, 두 값 중 하나로 확정한다.

- 출처: docs/references/design-synthesis/egdesk-ux-realization-proposals.md:46-62(공통 시각 기준선·토큰 표); CHAT_DESIGN_GRAMMAR_V1 'Approved Visual Baseline (2026-10-20)'; VIEWPORT 문서 'Approved desktop style (2026-10-20)'
- 상태: 일부 · 크기 S
- 근거: proposals 문서는 승인 스타일을 참조하지 않는다(grep 'approved-desktop-style' 0건). 마지막 수정 커밋도 04aca76(10-20 자원 모니터 요구)과 a160f18로, 승인 스타일 반영 이전이다. 그런데 토큰 표와 글자 크기(16px/24px)가 production 토큰(uc.css:10-49)과 Chat 문법(13px/1.45, 12px/1.52)과 다르다.
- 빠진 것: 작업자가 어느 문서를 따르느냐에 따라 색과 글자 크기가 달라질 수 있다. 접근성 기준(본문 16px, 대비 4.5:1 계산)을 승인 스타일 값으로 다시 확인하지도 않았다.
- 결정: true: 기본 본문 글자 크기를 승인 스타일의 12–13px로 둘지, proposals의 16px 접근성 기준으로 키울지 정해야 한다. 승인 스타일 색이 대비 기준(본문 4.5:1)을 충족하는지 확인한 뒤 정하는 것을 권장한다.
- 구현 스케치: proposals.md의 ux-layout-review 토큰 표를 승인 스타일 값과 대비 계산 결과로 갱신한다(문서 수정만). 결정이 16px이면 uc.css의 Chat 글자 크기 토큰화도 함께 계획한다. 비전 문서 Source Documents에 승인 스타일 링크를 추가한다.

### DSN-04 — 접근성 기본값: 동작 줄이기 설정에서 카메라 이동과 전환을 즉시 처리하고, 글자를 키우면 행과 버튼 높이도 늘어나며, 상태를 색만으로 구분하지 않게 한다.

- 출처: proposals.md:1650(모션 감소에서는 즉시 이동), 62-66(텍스트 확대 시 높이 증가·색만으로 구분 금지); Contract impl-resource-monitor('색만으로 상태를 구별하게 하지 않는다')
- 상태: 일부 · 크기 S
- 근거: uc.css:5599-5601 prefers-reduced-motion은 typing dots만 처리한다. uc.js:846은 Briefing 카메라만 matchMedia로 즉시 이동한다. 일반 카메라 smoothing(ZOOM_SMOOTHING uc.js:1101), Board 열기와 미니맵 이동에는 reduced-motion 분기가 확인되지 않는다(grep 결과 846 1건).
- 빠진 것: Briefing 외의 카메라 애니메이션에 동작 줄이기가 적용되지 않는다. 글자 확대 대응은 확인되지 않았다(실행 확인 필요).
- 구현 스케치: uc.js의 setCanvasPanTarget과 setCanvasViewportTarget 기본 옵션에 reduced-motion 감지를 넣는다(immediate 기본 true). uc.css에 transition과 animation 전역 축소 규칙을 추가한다. 글자 확대 확인은 헤드리스 회귀에서 layout.css.devPixelsPerPx 변경 캡처로 별도 진행한다.

</details>

## Context · 코딩 화면 · 런타임/패키징

Context, Recovery, Coding UX and Runtime/Packaging. The underlying pieces are mostly built; the screens and connections users would touch are still largely missing. Already in place: immutable context snapshots, Reader and packets with explicit attachment chips and an inspector; Desk auto-save with backup and retry when the saved Desk can't be read; storage and lifecycle separation between saved Boards and the Desk; a File Card (folder connect, tree, filename search, textarea working copy, line diff, create-only Save As, durable drafts on SQLite); SQLite with WAL/FULL for chat and drafts; automatic app-server respawn and SSE reconnect. Missing:
- Automatic context resolver (best-matching Board, visible resources, signal record)
- Board revision history and conflict handling, and a Desk generation journal
- Diff view of agent changes, and command output / test result cards
- Project folder binding (agent cwd = File Card root); the IDE Dock entry is a placeholder
- Saving to the original file (currently `originalUpdated:false`)
- Watcher/event bus
- Wiring the .egdesk bundle into the app
- App packaging and a production move to the Rust helper
- A one-command clean-profile gate

The SQLite-first persistence choice is already adopted in the CONTRACT (L79-80, L1343). Only the vision checkbox and the move of Desk/Board/recovery off Firefox prefs remain. None of this duplicates the scheduled (A) requestUserInput and (B) subAgent work. CODE-05 attaches to the existing fileChange approval card.

| ID | 상태 | 크기 | 대표님 화면에서 달라지는 점 | 결정 | 환경 제약 |
|---|---|---|---|---|---|
| RT-05 | 완료 | M | 브리지가 끊겨도 원문 오류 대신 '다시 연결 중'만 잠깐 보이고 저절로 돌아오며, 안 되면 버튼 하나로 다시 시작할 수 있다. |  |  |
| CODE-02 | 일부 | M | 채팅방이나 Board마다 '프로젝트 폴더'를 고르면 에이전트 작업 위치와 파일 창 폴더가 같아지고, 화면 위에 어떤 프로젝트인지 늘 보인다. | 결정됨(D-X3) |  |
| CODE-05 | 일부 | L | 에이전트가 파일을 고치면 무엇이 바뀌었는지 줄 단위 비교로 보고, 승인 전에 내용을 확인할 수 있다. | 결정됨(D-X2·X4) |  |
| CODE-06 | 일부 | L | 에이전트가 테스트나 빌드를 돌리면 통과/실패 수와 실패 위치가 결과 카드로 보이고, 눌러서 해당 파일 줄로 이동한다. | 결정됨(D-X6) |  |
| CODE-07 | 없음 | S | Dock의 IDE 버튼을 누르면 프로젝트 파일·편집·변경 비교·테스트 결과가 한 번에 열린다. |  |  |
| CODE-01 | 완료 | M | (바로 보이는 변화는 없음) 이후 편집기·변경 비교 화면이 검증된 부품으로 만들어져 끊김이 적다. |  |  |
| CODE-04 | 일부 | L | 코드가 색과 줄번호로 보이고, 고친 내용을 원래 파일에 안전하게 저장할 수 있다(외부에서 바뀌었으면 충돌 안내). | 일부 결정(D-X1 정함, D-X5 남음) |  |
| CODE-03 | 일부 | M | 파일 이름뿐 아니라 내용으로도 찾고, 바뀐 파일 표시와 새로 생긴 파일이 자동으로 트리에 보인다. |  |  |
| RT-01 | 일부 | M | (바로 보이는 변화는 없음) 새 PC에 처음 설치해도 첫 화면이 깨지지 않는지 배포 전에 자동으로 확인된다. |  | 있음 |
| RT-07 | 일부 | L | (바로 보이는 변화는 없음) Desk·Board·대화 기록이 한 저장소에 안전하게 쌓여, 비정상 종료 후에도 같은 시점으로 돌아온다. | 필요 |  |
| CTX-02 | 일부 | M | 실수로 카드를 닫거나 Desk가 꼬여도 '복구 기록'에서 시점을 골라 되돌릴 수 있다(현재 작업은 보존). | 결정됨(D-R1) |  |
| CTX-01 | 일부 | L | Board를 저장할 때마다 버전이 남아, 예전 구성을 골라 새 버전으로 되살릴 수 있고 동시에 고친 경우 충돌을 알려준다. | 필요 |  |
| CTX-03 | 일부 | XL | 자료를 일일이 첨부하지 않아도 지금 보고 있는 Board·창을 바탕으로 에이전트가 쓸 자료 후보가 자동으로 잡힌다(전체 Desk를 몰래 넣지 않음). | 필요(D-R2) |  |
| CTX-04 | 일부 | M | 보내기 전에 '이번에 에이전트가 볼 자료'와 고른 이유를 한눈에 보고, 빼거나 더할 수 있다. |  |  |
| RT-06 | 완료 | L | 터미널 명령이 끝나거나 로그인·파일 변경이 일어나면 연결된 작업과 파일 창이 알아서 다음 단계로 넘어가거나 새로 고쳐진다. |  |  |
| RT-03 | 일부 | L | Board나 대화를 .egdesk 파일 하나로 내보내고(암호 선택) 다른 PC에서 새 사본으로 가져올 수 있다. | 결정됨(D-R3) |  |
| RT-04 | 일부 | XL | (바로 보이는 변화는 없음) 설치본이 가벼워지고 터미널·단축키·트레이가 하나의 도우미로 안정적으로 동작한다. | 일부 결정(D-C1 정함: Mac 조작을 이 Rust 도우미에 합침, D-R6 남음) | 있음 |
| RT-02 | 없음 | XL | Firefox를 따로 깔지 않고 EGDesk 설치 파일 하나로 설치·실행·업데이트할 수 있다. | 필요(D-R4~R6) | 있음 |

<details><summary>항목별 근거·빠진 것·구현 스케치</summary>

### RT-05 — Bridge restart/reconnect UX without noisy user-facing diagnostics

- 출처: EGDESK_PRODUCT_VISION_AND_DEV_TODO.md: P2 Runtime/Packaging
- 상태: 일부 · 크기 M
- 근거: helper/codex-bridge-server.mjs:306-341 (app-server child loss → 1s fixed respawn, no backoff); overlay/JS/eg-desk-surface.uc.js:6076-6081, 6260-6268 (SSE reconnect every 1.2s, protocol.connection='offline'); :639-644 run status distinguishes RUNTIME_LOST (commit b1cc997, dd5c5bd); :4570-4572 HUD text '브리지 오프라인' / '브리지 온라인 · Nms'; :6192 raw text `코덱스 브리지에 연결할 수 없습니다: ${fallbackError.message}`. Overlay uses no Subprocess/nsIProcess (grep 0 hits), so Firefox cannot restart a dead Node bridge. docs/PATH_1_5_STABILIZATION.md, last section: Windows launcher reuses an existing bridge without comparing source hashes.
- 빠진 것: (1) When the Node bridge itself dies, nothing restarts it; only scripts/run-egdesk-windows.mjs / run-codex-bridge.sh can start it. (2) Raw transport error text and latency numbers appear directly on screen. (3) No quiet '다시 연결 중' state with backoff and no one-click 'restart'. (4) A stale bridge (older source than the overlay) is not detected.
- 구현 스케치: Add a supervisor (backoff, health probe, source-hash/version handshake) to scripts/run-egdesk-windows.mjs and run-codex-bridge.sh, or have the overlay start the bridge via Subprocess.sys.mjs. Add exponential backoff to scheduleAppServerReconnect in helper/codex-bridge-server.mjs. In eg-desk-surface.uc.js:4570 and 6192, change the main text to state-based wording and move raw messages into a details panel. Expose bridge build hash in /v1/state.

### CODE-02 — Project/folder as the unit of coding work: let the user choose a project folder for a Chat/Board so the agent cwd and the File Card root use the same project

- 출처: Vision P1 Context, Recovery, and Coding UX item 5 (project/folder); CONTRACT §6 사람 중심 코딩 표면
- 상태: 없음 · 크기 M
- 근거: overlay/JS/eg-desk-surface.uc.js:244 sends thread.cwd only when it is already set; only 3 lines in the surface mention cwd (244, 1044, 1065) and none of them sets thread.cwd. helper/codex-bridge-server.mjs:321 spawns app-server with cwd: process.cwd(); :123 EGDESK_CONTEXT_ROOTS defaults to [process.cwd()]. Explicit-cwd validation exists (commits d4c59c7, 09001f2). The File Card root comes from a separate picker (eg-desk-surface.uc.js:9655-9661).
- 빠진 것: No UI to pick or show the project folder for a thread or Board. The agent's working folder and the File Card's connected folder are unrelated. The Chat header does not show the current project.
- 결정: What the project folder is attached to: a Board, a Chat room, or both (inheritance rule). Also how a project switch applies to runs that are already in progress.
- 구현 스케치: Add a project chip and folder picker (reuse createEGDeskNativeFilePickers.chooseRoot) to the Chat header in eg-desk-surface.uc.js. Store cwd on thread/Board; codexThreadRuntimeConfig already forwards cwd. Have the File Card open the same root handle. Add the cwd to the allowed roots in helper/egdesk-context-store/codex-bridge-server.

### CODE-05 — Diff and proposed changes: show the hunks the agent changed or proposed

- 출처: Vision P1 Coding UX item 5 (diff); CONTRACT §6 'diff와 제안된 변경'
- 상태: 일부 · 크기 L · 선행: CODE-01
- 근거: The user's own working-copy diff is done: overlay/resources/EGDeskFileView.sys.mjs:406-428 (hunk before/after) and helper/egdesk-file-service.mjs:302-305 lineDiff. Agent changes keep only path and kind: helper/codex-chat-runtime.mjs:44-50, 1510-1520. 'turn/diff', 'outputDelta' and 'unifiedDiff' are never consumed (grep 0 hits in helper/codex-*.mjs). The fileChange approval exists (EGDeskChatState.sys.mjs:643, commit b706baa).
- 빠진 것: No per-file diff of the agent's fileChange or turn diff. The approval card shows no change content. No per-hunk accept/reject and no side-by-side view. No overlap with the scheduled (A) requestUserInput and (B) subAgent work, but it attaches to the fileChange approval card.
- 구현 스케치: Project the turn/diff/updated notification and fileChange change content (diff) in codex-chat-runtime.mjs, with a size limit. Add a diff projection to EGDeskChatState. Render a diff view in the approval and activity rows of eg-desk-surface.uc.js, or in a File Card 'proposed changes' tab. Reuse the hunk markup from EGDeskFileView.review.

### CODE-06 — Run/build/test/review result surface

- 출처: Vision P1 Coding UX item 5; CONTRACT §6 'run·build·test·review 결과'
- 상태: 없음 · 크기 L · 선행: CODE-02
- 근거: The File Card '검사' button exists (EGDeskFileView.sys.mjs:462-475), but spawnFileCard does not pass runCheck (eg-desk-surface.uc.js:9655-9663), so the button is always disabled. Chat activity rows list only command/cwd/exitCode/durationMs as 'key: value' pre lines (eg-desk-surface.uc.js:1038-1047). Command output (aggregatedOutput) is not projected (grep 0 hits in codex-chat-runtime.mjs).
- 빠진 것: No result card for test or build runs: no pass/fail counts, no failing-item → file:line link, no output view. The File Card check runner is not connected.
- 구현 스케치: Add bounded projection of commandExecution output to codex-chat-runtime.mjs. Add a result-card type to eg-desk-surface.uc.js with summary first and expandable original output. Connect the FileView runCheck to the project's test command, chosen explicitly by the user, through the terminal/bridge. Parse failure locations into file refs.

### CODE-07 — Make the IDE Dock entry a real entry into the coding workspace

- 출처: Vision P1 Coding UX item 5 (user-facing coding surface); Dock definition in the code
- 상태: 없음 · 크기 S · 선행: CODE-02
- 근거: overlay/JS/eg-desk-surface.uc.js:68 declares the Dock item { id: 'ide' }. In the click handler (:4216-4236) there is no ide branch, so it falls through to toggleHUD(item.id, item.label), a placeholder.
- 빠진 것: Pressing IDE opens nothing meaningful. It should open the project, File Card and result surfaces together.
- 구현 스케치: Add an item.id === 'ide' branch in eg-desk-surface.uc.js:4216. Have it call spawnFileCard with the current project root and optionally place the result card and terminal next to it. Add a headless-regression case to the existing DOCK_IDS check.

### CODE-01 — Research current project/file/editor/diff/test-result frameworks and active implementations, then choose the coding-surface integration path

- 출처: Vision P1 Context, Recovery, and Coding UX item 4
- 상태: 일부 · 크기 M
- 근거: The CONTRACT (ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md around L2115-2119) names a 'selected baseline' (Monaco ESM, PDF.js, Tika, SheetJS CE, LibreOffice) but states it is 'not evidence of actual installation, performance or support'. The current editor is a <textarea> (EGDeskFileView.sys.mjs:131-134). overlay/resources/vendor has only xterm. The references shelf has only theia (docs/references/theia-overview.md).
- 빠진 것: No spike confirming Monaco ESM (or CodeMirror 6) loads in a Firefox privileged chrome document under CSP. No license or bundle-size evidence. No decision on diff viewer, test-result format adapters, or LSP.
- 구현 스케치: Build a minimal load spike for Monaco ESM vs CodeMirror 6 in overlay/resources/vendor. Check CSP, IME and bundle size. Compare their diff editors. Record sources and licenses in apps/firefox-ui-demo/docs/CODING_SURFACE_SELECTION.md. Measure memory with a small test only (RAM constraint).

### CODE-04 — Editor/viewer: code-editing quality and saving to the original file

- 출처: Vision P1 Coding UX item 5 (editor/viewer); CONTRACT §6, §17.D 파일 adapter·조건부 저장
- 상태: 일부 · 크기 L · 선행: CODE-01
- 근거: Done: textarea working copy, IME composition handling and 250ms flush (EGDeskFileView.sys.mjs:400-404), durable drafts (helper/egdesk-managed-drafts.mjs:30 SQLite CAS), restore across restarts (EGDeskFileCardState.restoreFileCard, commit d40ad5c), create-only Save As (commit 25baa03). Saving writes only the managed working copy: helper/egdesk-file-service.mjs:299 returns `originalUpdated: false`.
- 빠진 것: No syntax highlighting, line numbers, in-file search or go-to-line. No conditional write-back to the original file (expectedHead/hash CAS); the only option is Save As to a new file, so a project cannot really be edited and saved in place.
- 결정: Whether EG-Desk may overwrite original project files: never / only on user Save / also through agent approval. Also the conflict rule when the file changed externally.
- 구현 스케치: Swap the textarea in EGDeskFileView for the selected editor, keeping composition handling. Add an original-save mode (sourceHash CAS, operationId idempotency) to egdesk-file-service.saveDraft. Reuse posix-file-helper descriptor semantics. Change the UI button wording to separate 'working copy' from 'original'.

### CODE-03 — File tree and search

- 출처: Vision P1 Coding UX item 5 (file tree/search)
- 상태: 일부 · 크기 M · 선행: RT-06
- 근거: overlay/resources/EGDeskFileView.sys.mjs:113-127 (tree role=tree, filename search); helper/egdesk-file-service.mjs:7-11 (MAX_LIST 200, MAX_SEARCH 100, depth 12); helper/egdesk-file-service.test.mjs (21 tests); commits c5d25c4, d40ad5c.
- 빠진 것: Filename search only, no content search. No git status marks. The tree does not refresh automatically on external changes (no watcher, see RT-06). (정정 2026-10-24: 이전 판의 'No paging beyond 200 entries'는 사실이 아니다. `d40ad5c`(2026-09-27)부터 listDirectory가 cursor·nextCursor로 나눠 주고 파일 창 트리에 '더 보기' 행이 있다.)
- 구현 스케치: Add a limited content search to egdesk-file-service.mjs (size, binary and depth caps). Add an optional git status query. Have FileView subscribe to file.changed events. (cursor는 이미 있음)
- 진행(2026-10-24): `4ae184d` — 내용 검색(/v1/files/search/contents), git 상태·변경 읽기(/v1/files/git/*), 이름 검색이 .git·node_modules·빌드 폴더를 건너뛰고 .gitignore를 따름, 파일 창 모듈에 이름/내용 검색 전환·트리 git 상태 글자·onFileChanged. 상태 일부 유지.
- 남은 것(2026-10-24): 외부 변경 자동 갱신의 uc.js 이벤트 연결(S3). 실제 Firefox 창 미확인.

### RT-01 — Clean-profile boot verification gate

- 출처: Vision P2 Runtime/Packaging; docs/PATH_1_5_STABILIZATION.md Gate To Path 2
- 상태: 일부 · 크기 M
- 근거: scripts/egdesk-chat-qa-profile.mjs bootstrapQaProfile; scripts/bootstrap-egdesk-chat-test-profile.mjs:2 says 'Preparation only. Main owns the Firefox/bridge process lifecycle'. scripts/verify-firefox-mcp-first-use-board.mjs:76 has fixtureMode 'fresh-profile'. scripts/verify-firefox-mcp-headless-ui-regression.mjs:577, 674 checks that a fresh profile starts with one live first-use Browser and no recovery state, but the runner is attach-only (header comment). Commit 2c19ffd.
- 빠진 것: No one-command gate that runs clean profile creation → overlay install → Firefox+bridge launch → checks (overlay loaded, no console errors, first-use Browser, bridge health) → teardown → pass/fail record. Today it is a manual launch followed by attach.
- 환경 제약: Running the check requires a real Firefox launch (heavy on RAM). Firefox must not run in parallel during this analysis.
- 구현 스케치: Add scripts/verify-clean-profile-boot.mjs that chains bootstrapQaProfile + run-firefox-mcp-target + the first-use check from the headless regression, with a time limit and guaranteed teardown. Record results and the gate criteria in docs/PATH_1_5_STABILIZATION.md.

### RT-07 — Local persistence schema decision: SQLite-first, possible PocketBase/Convex sync bridge later

- 출처: Vision P2 Runtime/Packaging
- 상태: 일부 · 크기 L
- 근거: The decision is already in the CONTRACT: L79-80 SELECTED-BASELINE SQLite + content-addressed object store; L1343 single writer/WAL/synchronous=FULL. Implemented in helper/egdesk-chat-store.mjs:143-145 and helper/egdesk-managed-drafts.mjs:30. Not migrated: Desk session, Board and recovery still use Firefox prefs (eg-desk-surface.uc.js:1103-1105 egdesk.agendaState.v1 / egdesk.deskSession.v1, EGDeskRecoveryState prefix egdesk.deskRecovery.v1.). Context store uses JSON files (egdesk-context-store.mjs:74, 89); task store uses JSON atomic rename (egdesk-task-store.mjs:82-86). PocketBase/Convex do not appear in the CONTRACT (grep 0).
- 빠진 것: The vision checkbox is not updated to match the CONTRACT decision. Desk, Board and recovery are not on the SQLite generation model (the whole snapshot is kept as a single prefs string). Context and task stores are separate JSON stores. The sync backend is undecided.
- 결정: The sync backend (PocketBase / Convex / none) is external infrastructure, so it is the owner's decision. SQLite-first local storage is already adopted in the CONTRACT, so only updating the vision checkbox needs confirmation.
- 구현 스케치: Add helper/egdesk-desk-store.mjs (node:sqlite, generation, seq/parentSeq/stateHash) with /v1/desk HTTP routes. Change eg-desk-surface.uc.js persistDeskSession and saveCurrentAgendaState to bridge calls, and import existing prefs once while keeping the originals. Keep a prefs fallback for when the bridge is offline. Update vision L230.
- 진행(2026-10-24): `35f772c` — helper/egdesk-desk-store.mjs·egdesk-desk-http.mjs(로컬 SQLite, 비공개 폴더·0600, `POST /v1/desk/import`로 prefs 1회 가져오기, 저장소를 못 열어도 브리지는 계속 동작). helper 720/728. `0943557` — 화면이 저장소에 연결: prefs를 한 번 가져오고(prefs는 남김), 자동 저장·Board 저장이 저장소에도 감. 중앙 회귀 771/771, headless UI 회귀 274/274.
- 진행(2026-10-24, 이어서): `d7aac51` — task 저장소(작업 그래프 journal·native ledger·task sources·Agent 계획)가 JSON 4개에서 비공개 SQLite 하나로(task_events 덧붙이기 전용, 이전 JSON은 한 번 가져오고 그대로 둠).
- 남은 것(2026-10-24): context 저장소는 여전히 별도 JSON. task 저장소는 `d7aac51`에서 SQLite로 옮김. 동기화 백엔드 미결정. 비전 체크박스 미갱신. headless 대화 흐름 첫 화면 회귀는 `9dbfa51`에서 고침(72/72). 실제 Firefox 창 미검증.

### CTX-02 — Automatically journaled Desk recovery surface (journal of generations and a browsable recovery list)

- 출처: Vision P1 Context, Recovery, and Coding UX item 1 (Desk recovery side); CONTRACT §1339 자동 세션의 commit과 복구
- 상태: 일부 · 크기 M · 선행: RT-07
- 근거: Desk auto-save goes to the egdesk.deskSession.v1 pref (eg-desk-surface.uc.js:13864). The original is backed up when unreadable or partially restored (EGDeskRecoveryState.sys.mjs:26-40). The UI shows only the latest record with retry/continue (eg-desk-surface.uc.js:13809-13826). Tests: scripts/egdesk-surface-state.test.mjs:89, 482, 518. The vision status section records Firefox corrupt Desk 5/5 and restart 4/4 (commits 76921bc, 6c331ad).
- 빠진 것: Saving is a single snapshot overwrite, not a generation journal (sessionId/seq/parentSeq/stateHash), so a normal but unwanted state (e.g. many cards closed by mistake) cannot be rolled back. The recovery UI exposes only the latest record; there is no list to browse.
- 결정: How long and how many recovery generations to keep (disk use).
- 구현 스케치: Use the RT-07 desk store generations. Extend EGDeskRecoveryState to list generations. Change renderDeskRecoveryNotice into a recovery list panel (time, card count, reason). Restore merges additively, reusing missingDeskRecoveryViews.
- 진행(2026-10-24): 저장소 `35f772c` — Desk 자동 저장이 세대로 쌓임(같은 내용이면 새 세대 없음, 오래된 parent는 409와 head 반환, 어느 세대든 새 세대로 복원). helper 720/728. 화면 `0943557` — 브리지에 저장소가 있으면 prefs를 한 번 가져오고(prefs는 남김) 자동 저장이 저장소에도 감. 복구 기록 패널에서 세대를 미리 보고 되돌리거나 합침. 중앙 회귀 771/771, headless UI 회귀 274/274.
- 남은 것(2026-10-24): 보존 개수·기간은 지금 임시값(최근 200 + 30일간 하루 1개, 512 MiB 이하)을 그대로 쓰기로 결정됨(D-R1). 같은 결정에서 자동 저장 묶음 간격은 60초로 정함(구현 여부는 이 원장에 기록 없음). headless 대화 흐름 첫 화면 회귀는 `9dbfa51`에서 고침(72/72). 실제 Firefox 창에서 비정상 종료 뒤 복구는 미검증.

### CTX-01 — Separate saved Board revisions from the Desk recovery journal: Board immutable revisions, head, conflict handling

- 출처: Vision P1 Context, Recovery, and Coding UX item 1; CONTRACT §1369 저장 구성, 충돌과 정본 revision
- 상태: 일부 · 크기 L · 선행: RT-07
- 근거: Storage and lifecycle separation is done: three separate prefs (eg-desk-surface.uc.js:1103-1105) and Desk auto-save does not modify saved Boards (commit 76921bc). The revision model is missing: saveCurrentAgendaState (eg-desk-surface.uc.js:1961-1993) overwrites store.agendas[agendaId] each time. headRevision/expectedHead/metadataVersion appear only in the file modules (grep), not in Board code. The dirty counter only shows 'rev N' text (:3225, :3507).
- 빠진 것: No CONTRACT-style Board model: metadataVersion, headRevision, immutable composition revisions (parent revision), expectedHead CAS, operationId idempotency, '저장됨 · 이후 변경 있음', 3-way conflict. No Board revision list or 'publish an old composition as a new revision' UI.
- 결정: Board save-history policy: latest only vs full history, and retention period.
- 구현 스케치: Add board/board_revision tables to the RT-07 store (expectedHead CAS in one transaction). Send operationId and expectedHead from saveCurrentAgendaState and handle conflict responses. Show revision list, restore and conflict preview in the Board switcher. Keep the agendaId identifier.
- 진행(2026-10-24): 저장소 `35f772c` — Board 저장이 불변 버전으로 남고, expectedRevision이 어긋나면 409, 되돌리기는 새 버전으로 기록, 제목 변경은 메타데이터만 올림. helper 720/728. 화면 `0943557` — Board 저장이 저장소에도 가고, Board 메뉴에 버전 기록·되돌리기, 저장 충돌 시 덮어쓰지 않고 물어봄. 중앙 회귀 771/771, headless UI 회귀 274/274.
- 남은 것(2026-10-24): 저장 기록 정책(전체 기록 / 최신만, 보존 기간) 결정 대기. headless 대화 흐름 첫 화면 회귀는 `9dbfa51`에서 고침(72/72). 실제 Firefox 창에서 동시 수정 충돌은 미검증.

### CTX-03 — Resolve run context: combine explicit selection, best-matching Board, transient Desk grouping/layout, visible resources and account/permission scope

- 출처: Vision P1 Context, Recovery, and Coding UX item 2; CONTRACT §2 Context 조립
- 상태: 일부 · 크기 XL (감사 시점에는 없음)
- 근거: Only explicit selection is implemented: EGDeskInputContext.sys.mjs:19-28 accepts only browser/file/board-element sources; the attach panel at eg-desk-surface.uc.js:745-800 is checkbox-based. Board contextBindings are always [] (eg-desk-surface.uc.js:1616, 1677). helper/egdesk-context-runtime.mjs:52-60 prepare takes only contextSnapshotIds/attachments. The only account scope is the owner key (context-runtime:33-37). Immutable snapshots, Reader and packets are done (commits f370eab, b135ef9, f84bc20; egdesk-context-core.test.mjs 20 tests).
- 빠진 것: No context resolver: no best-matching Board, no use of spatial grouping, focus or visible resources as relevance signals, no recent interactions, no execution/permission scope. No record of which signals were chosen. No context revision update between model calls.
- 결정: Default for automatic candidates: 'suggest only (user confirms)' vs 'auto-attach'. Whether visible Browsers/accounts are included by default (privacy and account scope).
- 구현 스케치: Split into (1) a signal collector (overlay: current Board members, visible and focused cards, proximity clusters via SurfaceState.surfaceProximityClusters), (2) a ranking and policy filter (helper/egdesk-context-runtime: owner, permission and scope checks), and (3) a resolver record on the packet. Feed candidates to the existing attach chips so the user confirms before capture.
- 진행(2026-10-24): 해석기 `b6b48b9`(`POST /context/resolve`: 화면 신호로 후보 최대 12개·고정 이유 코드, 제안만, 로그인된 페이지·브라우저 내용은 동의 필요, 다른 계정·권한 밖은 목록에만 두고 제외, 원문 없는 해석 기록). 화면 연결 `0943557`: Chat 입력칸에 들어가면 화면 신호로 후보를 물어 입력 트레이 위에 '이것도 붙일까요?'를 띄우고, 고른 것만 붙음. 보낼 때 해석 결과가 함께 감. 중앙 회귀 771/771, headless UI 회귀 274/274.
- 남은 것(2026-10-24): headless 대화 흐름 첫 화면 회귀는 `9dbfa51`에서 고침(72/72). 실제 Firefox 창·실제 모델 미검증. 자동 후보 기본값은 구현상 '제안만(사용자 선택)'이며 대표님 확인 기록은 없음. 모델 호출 사이 맥락 갱신은 두 커밋 메시지에 없음.

### CTX-04 — Selected run context can be inspected and corrected without exposing the whole Desk by default

- 출처: Vision P1 Context, Recovery, and Coding UX item 3; CONTRACT §2 (선택 signal 기록·검사·수정)
- 상태: 일부 · 크기 M · 선행: CTX-03
- 근거: For explicit attachments: chip view, re-inspect and remove (eg-desk-surface.uc.js:803-829); after-send '당시 입력 캡처' snapshot view (:749-751); GET /context/packets/:id with deliveryStatus (helper/egdesk-context-http.mjs:14-30); inspector pagination and range retention (commits a5d7445, 168f5ce, 19ffcbd, 4e920cd); Firefox context-briefing verification script scripts/verify-firefox-mcp-context-briefing.mjs.
- 빠진 것: Only explicit attachments can be inspected. There is no 'why it was chosen' (signal), no pre-send preview of the overall scope, and no include/exclude correction of resolver candidates (depends on CTX-03). Context changes after tool results are not shown.
- 구현 스케치: Extend buildChatInputTray with a 'candidates (unconfirmed)' section and reason labels. Add a resolver record to /context/packets. Add a 'this run's context' section that tracks context revisions in the activity panel.
- 진행(2026-10-24): `0943557` — 보내기 전 입력 트레이 위 후보 행에 고른 이유가 보이고, 고른 것만 붙음(로그인된 페이지는 따로 확인, 다른 계정은 흐리게 제외). 활동 기록에 Agent가 볼 자료와 고른 이유가 남음. 해석 기록은 `b6b48b9`부터 /context/packets로 돌려줌. 중앙 회귀 771/771, headless UI 회귀 274/274.
- 남은 것(2026-10-24): headless 대화 흐름 첫 화면 회귀는 `9dbfa51`에서 고침(72/72). 실제 Firefox 창 미검증. 도구 결과 뒤 맥락 변화 표시는 커밋 메시지에 없음.

### RT-06 — Terminal/browser/auth/file watcher bus for cross-app workflow sync

- 출처: Vision P2 Runtime/Packaging
- 상태: 없음 · 크기 L
- 근거: No fs.watch/watchFile/chokidar/EventEmitter/event-bus in helper/*.mjs or overlay/resources (grep 0 hits). File source status is queried on demand (helper/egdesk-file-service.mjs:307 sourceStatus). SSE carries only chat/auth/Browser tool transport (codex-bridge-server.mjs:503). helper-rust/Cargo.toml claims file-watch in its description, but src/main.rs implements only pty_* methods.
- 빠진 것: No common event stream for terminal exit, Browser navigation/OAuth completion, auth changes or file changes. The task graph (helper/egdesk-task-graph.mjs) dependency gates and File Card refresh therefore cannot use these events.
- 구현 스케치: Add helper/egdesk-event-bus.mjs (topic, bounded queue, owner scope) and publish from terminal-sessions exit, auth state changes, and fs.watch on connected roots. Relay Browser events from overlay to bridge. Send to clients over the existing BoundedSseClient. Connect to egdesk-task-graph gates.

### RT-03 — Connect the .egdesk portable bundle (Desk/Board/Chat export and import) to the app

- 출처: Related code: helper/egdesk-portable-bundle.mjs, overlay/resources/EGDeskPortableState.sys.mjs (connected to the vision P2 portable item)
- 상태: 일부 · 크기 L · 선행: RT-07
- 근거: Library done: helper/egdesk-portable-bundle.mjs:93, 224, 456 (zip codec, encrypted envelope, bundle) and EGDeskPortableState.sys.mjs:4 (export/import presentation controller); helper/egdesk-portable-bundle.test.mjs 12 tests; commit e1f807a. Not wired: codex-bridge-server.mjs imports (:1-26) and eg-desk-surface.uc.js have no bundle references (grep 0).
- 빠진 것: No HTTP route. No objectProvider/importStore adapters connecting to the chat, context and file stores. No export preview, password or import-as-new-copy UI. The user cannot reach the feature.
- 구현 스케치: Add helper/egdesk-bundle-http.mjs and mount it in codex-bridge-server. Implement objectProvider on chat-store, context-store and drafts, and importStore. Add an export/import panel to the eg-desk-surface Board menu, with createEGDeskPortableState handling the presentation.
- 진행(2026-10-24): `2f9b030` — 위 근거의 'Not wired'(HTTP 없음)는 helper 쪽에서 해소. helper/egdesk-portable-http.mjs + helper/egdesk-portable-service.mjs를 브리지에 연결: `POST /v1/portable/export|inspect|import`, `GET /v1/portable/exports`. Desk 또는 Board 묶음, 암호 선택, 대화·Profile은 기본 제외, 비밀값·계정 식별자 제외, `~/Downloads/EG-Desk`에 덮어쓰지 않고 저장, 파일 전체를 확인한 뒤 새 사본으로만 가져옴(겹치는 id는 참조와 함께 새 id). Desk·대화 저장소에 가져오기 메서드 추가. helper 테스트 754/762(실패 0), 그중 portable HTTP 10/10.
- 진행(2026-10-24, 이어서): `9dbfa51` — Desk 메뉴·Board 메뉴에 내보내기·가져오기(브리지가 지원할 때만, 암호 선택과 잠금 없음 경고, 미리보기·잠금 해제, Desk 교체 경고, 새 사본으로 가져오기). `1003db3` — 가져온 Agent는 검토 필요 초안. 중앙 515/515, headless 대화 흐름 72/72, UI 회귀 274/274. 실제 브리지 Desk 저장소가 있는 Firefox·OS 파일 선택 창은 미확인.
- 남은 것(2026-10-24): 화면(Board 메뉴의 내보내기 미리보기·암호 입력·새 사본 가져오기 패널) 연결은 `9dbfa51`로 됨. 붙인 자료(context 저장소)·파일 초안은 이번 묶음 대상에 없음(portable-service가 Desk·대화·Profile 저장소만 연결). 실제 Firefox 창과 다른 PC에서 가져오기는 미검증.

### RT-04 — Rust helper consolidation for terminal/PTY/native functions

- 출처: Vision P2 Runtime/Packaging; FIREFOX_SHELL_ROADMAP Path 2 egdesk-helper
- 상태: 일부 · 크기 XL
- 근거: helper-rust/src/main.rs (458 lines) has only WebSocket PTY spawn/write/resize/kill; tray, hotkey and file-watch from the Cargo description are not implemented. PATH_1_5_STABILIZATION.md:28, 144 call it a 'historical candidate'. helper-rust/terminal-worker (commit 7edf605) is an experimental Windows ConPTY driver; helper/terminal-rust-process.mjs:27-30 says 'Experimental only' and the production default is Node node-pty (PATH_1_5_STABILIZATION.md:375). Other native code is separate: helper/macos-gesture-helper (Swift/ObjC), helper/posix-file-helper (C+Rust).
- 빠진 것: No decision on moving the production terminal to Rust (the benchmark harness exists). No macOS/Linux Rust driver. Gesture, file and PTY are not merged into one binary. Tray, hotkey and file-watch are not implemented.
- 결정: Keep Node node-pty or move to Rust. This is tied to whether a Node runtime must be bundled for packaging (RT-02).
- 환경 제약: ConPTY verification needs a real Windows machine; macOS gesture testing needs OS input permission.
- 구현 스케치: Collect the scripts/benchmark-windows-terminal.mjs results and record the decision. If moving to Rust, put the terminal-worker protocol in the common helper and add a macOS/Linux portable-pty driver. Absorb the gesture and file helpers as subcommands of one binary.

### RT-02 — Portable EGDesk packaging path (a single app that runs without an existing Firefox)

- 출처: Vision P2 Runtime/Packaging; FIREFOX_SHELL_ROADMAP.md:101-130 Path 2
- 상태: 없음 · 크기 XL · 선행: RT-01, RT-04, RT-05
- 근거: apps/firefox-ui-demo/README.md: install.sh/install.bat copy into the system Firefox install directory. scripts/run-egdesk-windows.mjs:2 is a 'Normal Windows launcher for the existing dedicated EG-Desk profile' (uses installed Firefox). PATH_1_5_STABILIZATION.md:179-184 defers 'Path 2 packaging start'. All ROADMAP Path 2 gating checkboxes are unchecked. The bridge requires Node 24+ with node:sqlite (helper/egdesk-file-mount.mjs:12-18). helper/egdesk-portable-bundle.mjs is a data export format, not app packaging.
- 빠진 것: No bundled Firefox binary, branding, installer (exe/dmg/AppImage), bundled Node runtime and helper, updater, signing/notarization or CI builds. Entry is gated on the Path 1.5 gate (80%+) per the roadmap.
- 결정: Firefox Stable vs ESR; code-signing and notarization costs (Authenticode, Apple Developer); trademark and branding review; OS priority; updater approach; Node runtime bundling vs moving to Rust; when to declare the Path 1.5 → Path 2 transition.
- 환경 제약: Needs a code-signing certificate and Apple Developer account, Windows/Linux build machines or CI, and installer verification on clean machines.
- 구현 스케치: Step 1: a Windows Firefox repackaging proof of concept (config.js, defaults/pref, bundled overlay profile) in apps/firefox-ui-demo/packaging/. Step 2: bundle Node or helper and update the launcher. Step 3: installer and updater. Gate on the RT-01 clean-profile check.

</details>

## 갱신 규칙

- 항목을 구현·검증하면 상태 열과 근거(커밋·테스트 수치)를 이 원장에 갱신하고, 비전 문서의 해당 체크박스도 맞춘다.
- 검증 수치는 실행한 커밋·시점·범위에 한정해 적고 합산하지 않는다(단위 테스트, fixture headless, 실제 계정·모델 실행을 구분).
