# 실창 브라우저 조작 QA (real-window-qa)

실행 중인 EG-Desk 실제 창에서 대화(Claude·Codex)에 브라우저 요청을 보내고, 끝난 뒤 카드 페이지 DOM을 직접 읽어 결과를 검증하는 도구다. 라운드 b(2026-11-26~27)의 브라우저 조작 케이스 20개 측정에 썼다. 결과와 기록은 `../../docs/decision-loop/`에 있다.

## 전제
1. EG-Desk를 자동 조작 모드로 띄운다: `./restart.sh` (브리지 127.0.0.1:39218, Marionette 2828). 직접 띄우려면 앱 폴더에서 `scripts/run-codex-bridge.sh`와 `scripts/run-firefox-mcp-target.sh --automation about:blank`.
2. 환경 변수
   - `EGDESK_FIREFOX_PROFILE` (restart.sh 필수): EG-Desk가 쓰는 Firefox 프로필 폴더
   - `EGDESK_CODEX_BIN` (선택): 기본 `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`
   - `EGDESK_QA_OUT` (선택): 측정 기록·캡처 폴더, 기본 `/tmp/egdesk-real-window-qa`
   - `EGDESK_APP_DIR` (선택): 앱 폴더, 기본 이 폴더의 두 단계 위(`apps/firefox-ui-demo`)
   - `NODE` (선택): node 실행 파일
3. 개인 설정 파일(`~/Library/Application Support/EG-Desk/settings/egdesk-personal-flags.json`): 측정 당시 `EGDESK_BROWSER_ENTRY=alternate`, `EGDESK_BROWSER_TASK_TOOL`, `EGDESK_BROWSER_STEPS_UI` 등 12개를 켰다.
4. 결정 호출 기록 감시기(분석기가 씀): 앱 폴더에서 `node scripts/egdesk-turn-timeline.mjs --watch-calls "$EGDESK_QA_OUT/calls.json"`.
5. `cases.mjs`의 카드 id(`egd-browser-card-1/6/12/13`)는 측정한 Desk 기준이다. 자기 Desk의 카드 id로 바꿔 쓴다.

## 사용
- 케이스 하나: `node run-case.mjs <번호> <Claude|Codex> [회차]` → 한 줄 PASS/FAIL, `$EGDESK_QA_OUT/matrix.jsonl`에 기록
- 행렬: `./run-matrix.sh <엔진> <회차 시작> <회차 끝> [케이스...]` (회차 꼬리표 F1, F2…)
- 요약: `node summarize.mjs F1` (케이스·엔진별 통과 수, 전체 시간·대화 모델 구간·결정 모델 시간 중앙값)

## 파일
| 파일 | 하는 일 |
|---|---|
| `cases.mjs` | 케이스 20개 정의(카드, 시작 주소, 메시지, 사람 역할, 검증식) |
| `run-case.mjs` | 준비(이동·새 대화·카드 허용) → 전송 → 대기 → 검증 → 분석기 한 줄 → 기록 |
| `run-matrix.sh`, `summarize.mjs` | 반복 측정과 요약 |
| `page-eval.mjs` | 카드 페이지에서 식 하나를 읽기 전용으로 평가(프레임 스크립트) |
| `observe-card.mjs` | 제품 경로 관찰(`toolObserve(toolBinding())`) 저장 |
| `record.mjs` | 화면 녹화 제어(임시 이름): `start [--source egdesk-windows\|window] [--fps N] [--scale S] [--max-sec N] [라벨]`, `stop`, `status`. 브리지 HTTP만 씀(브리지에 `EGDESK_SCREEN_RECORDING=on` 필요). 기본 `--source egdesk-windows` = EG-Desk Firefox 프로세스가 가진 창만(본창+그 프로세스의 별도 창·대화상자, ScreenCaptureKit 포함-창 필터, MP4; 다른 앱은 앞에 있어도 안 찍힘, `scripts/build-screen-recorder.sh`로 먼저 빌드, 화면 기록 권한 필요, **마스크 생산자 미연결**). `window` = 본창만 마스크 캡처 WebM. 파일은 `<EG-Desk 데이터>/recordings/<id>.mp4\|webm`+`.json` |
| `frames.sh` | `frames.sh <mp4 또는 webm> <출력 폴더> [fps]`: 녹화에서 프레임 PNG 추출(ffmpeg) |
| `go-card.mjs` | 카드 자체 `navigate()`로 이동하고 도착 확인(주소창 합성 키 안 씀) |
| `new-dm-grant.sh`, `grant-card.sh` | 새 Agent DM(엔진 선택) + 카드 'Chat 조작 허용', 카드 추가 허용 |
| `send-chat.mjs`, `read-chat.mjs`, `track.sh`, `wait-idle.mjs` | 보내기, 채팅 글 읽기, 상태 추적, 실행 끝 대기(`/v1/state` chat.runs) |
| `allow-site.sh`, `pause-card.sh` | 사람 역할: 카드 안 사이트 질문 '이 대화에서 허용', 카드 '일시중지' |
| `shot-chat.mjs` | 채팅 카드만 잘라 캡처 |
| `mn.mjs`, `click.mjs`, `mlock.mjs` | Marionette 최소 클라이언트, 실제 포인터 클릭, 클라이언트 하나씩 쓰기 잠금 |
| `restart.sh`, `run-scn.sh`, `check-l9.mjs` | 안전 재시작(PID로만 종료), 라운드 a 장면 실행기, 같은 주소 이동 확인 |

## 주의
- Marionette는 한 번에 연결 하나만 받는다. 모든 도구가 `mlock.mjs`로 차례를 지킨다.
- `page-eval.mjs`는 `data:` 프레임 스크립트를 쓴다. Latin-1로 풀리므로 식 안의 한글은 도구가 `\u` 이스케이프로 바꿔 보낸다.
- 앱 창이 뒤에 있으면 캔버스 애니메이션이 멈춰 좌표 클릭을 믿을 수 없다. 사람 역할은 버튼 DOM 클릭으로 한다.
- Claude 실행은 Claude 사용량을 쓴다.

## RWS 케이스 세트 (라운드 f, 실제 업무 시나리오 15개)
`cases-rws.mjs`(케이스 `rws-01`~`rws-15`)와 `fixtures-rws.mjs`(data: URL 모의 포털·에디터). `node run-case.mjs rws-03 Codex [회차]`처럼 id가 `rws-`로 시작하면 `run-case.mjs`가 이 세트를 읽는다(기존 숫자 id는 그대로). 추가 필드: `rws`(원본 RWS id), `patterns`, `handoffs`(기대 사람 넘김), `expected`, `answerNotRe`(답에 나오면 안 되는 말). 구조 검증: `node --test cases-rws.test.mjs`.

### data: 픽스처는 http로 서빙된다 (QA_POLICY_UNVERIFIED 회피)
EG-Desk 픽스처 QA 정책이 data: 페이지를 거절하므로 `run-case.mjs`는 케이스의 `url`/`then`/`also.url`이 data:면 디코드해 `$EGDESK_QA_OUT/fixtures/<케이스id>[-2].html`(UTF-8)로 쓰고 `http://127.0.0.1:8770/<파일>`로 바꿔 이동한다(포트: `EGDESK_QA_FIXTURE_PORT`). 서버(`fixture-server.mjs serve`)는 별도 프로세스로 뜨고 이미 떠 있으면 재사용, 직접 띄운 것만 끝에 종료한다. 대상: `cases-rws.mjs` 전부와 21번(`change-fixture.mjs`). 숫자 케이스 중 data: 없는 것은 그대로. 테스트: `node --test fixture-server.test.mjs cases-rws.test.mjs`.

## 브라우저 절차 케이스 (라운드 g, P1~P7)
`cases-proc.mjs`(케이스 `P1`~`P7`, 배송지 폼 픽스처: 6칸 폼, "수령인" 변형, POST 제출 버튼, 비밀번호 칸)와 `run-proc.mjs`. 계약: `round-g-procedures.md` 5절. 절차 API(`/v1/procedures*`)는 브리지 `http://127.0.0.1:39218`(`EGDESK_BRIDGE`로 변경), 픽스처는 `fixture-server.mjs`가 `http://127.0.0.1:8770/proc-P<n>.html`로 서빙한다.

| 케이스 | 내용 |
|---|---|
| P1 | 채팅으로 6칸 입력 → `POST /v1/procedures/capture` → 6 fill/6 params/start.url/confirm 없음 확인 → 저장·목록 확인 |
| P2 | 절차를 시드 → 이름 변경, 기본값 하나 변경, 단계 하나 삭제로 PUT → GET에 반영 |
| P3 | 새 페이지 사본에서 "‘이름’ 절차를 실행해줘. 받는 분: 이하늘" → 덮어쓰기, 기본값, 삭제된 단계의 칸은 빈 채로, 제출 없음 |
| P4 | L55 변화 픽스처에서 1단계 절차 실행 → 이름 칸 채워짐 |
| P5 | 마지막이 제출 클릭(confirm:submit)인 절차 → 제출 전에 멈춤 → "응 제출해" 뒤 제출 |
| P6 | 비밀번호 단계는 person·sensitive, 값 미저장, 실행은 거기서 멈춤 |
| P7 | "받는 분"이 "수령인"이 된 페이지 → 폴백으로 채우거나 단계를 짚어 깔끔히 멈춤(anyOf) |

명령(앱 실행 중, `$EGDESK_QA_OUT`과 `NODE` 설정, `cd apps/firefox-ui-demo/scripts/real-window-qa`):
```
node run-proc.mjs P1          # 한 케이스 (두 번째 인자는 회차)
node run-proc.mjs all         # P1~P7 순서대로
node cases-proc.mjs P3        # 케이스 하나 출력
node --test cases-proc.test.mjs   # 구조 테스트 (앱 불필요)
```
- 결과는 `$EGDESK_QA_OUT/matrix-proc.jsonl`에 한 줄씩 쌓인다. `/v1/state`에 `capabilities.browserProcedures`가 없으면(플래그 `EGDESK_BROWSER_PROCEDURES=on` 필요) SKIP을 출력하고 종료 코드 0으로 끝난다.
- 엔진은 `EGDESK_QA_ENGINE`(기본 Codex). 케이스가 만든 절차는 끝에 DELETE로 지운다(`EGDESK_QA_KEEP=1`이면 남김). 캡처에 필요한 clientThreadId는 `/v1/state`의 `chat.runs` 또는 `/chat/history/threads`에서 찾고, 못 찾으면 `EGDESK_QA_THREAD`로 지정한다.
