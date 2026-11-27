# L6 u1b: EG-Desk 자체 컴퓨터 도구 B1 (관찰: 창 캡처 + 접근성 읽기)

브랜치 `lane/u1-computer-observe` (기준 int/c14 `cf086b8`), 커밋 2개: `b659fa9` Rust 도우미, 그 위 Node 쪽(커밋 해시는 맨 아래 게이트 절에 최종 값). 원칙: U10(엔진은 순수 모델, 행동·승인은 EG-Desk), U11(사용자 Codex 설정에 의존 안 함), U19(Claude 대화도 EG-Desk 하네스). 결정 D-C1(자체 Rust 도우미)을 유지했고, A(cua-driver 임시 제공자)와 입력 단계는 만들지 않았다.

## 1. 만든 것 / 안 만든 것
**만든 것** (기본 꺼짐 플래그 `EGDESK_COMPUTER_OBSERVE=on` 뒤)
- 도구 4개, 제공자 하나(`egdesk-computer`): `egdesk_computer_list_apps`(열린 앱), `egdesk_computer_list_windows`(창 목록), `egdesk_computer_capture`(앱 하나의 창 하나를 그림으로), `egdesk_computer_read_elements`(그 창의 접근성 요소: 역할·이름·값·위치). 전부 읽기 전용.
- 두 엔진에 같은 카탈로그: Codex는 `thread/start` 의 dynamicTools, Claude는 in-process `egdesk` MCP(`mcp__egdesk__egdesk_computer_*`, 가장 긴 이름이 `mcp__egdesk__egdesk_computer_read_elements` 로 64자 한도 안). 시험이 두 엔진의 `collectToolSpecs` 결과가 같은 이름 4개임을 확인한다.
- Rust 도우미(`egdesk-helper host-observe`)에 두 요청 `capture`, `readElements`. 도우미를 `--observe-content` 로 띄웠을 때만 답하고, 아니면 이전처럼 `observe_only`(Node 에이전트도 이 옵션이 없으면 두 요청을 보내지 않는다).
- 앱별 첫 사용 승인: 기존 `computerElicitation` 카드를 재사용(새 카드 종류 없음): [이번만 허락]/[거절], 그 run 에서만 유효, 기억하지 않음, 자동 수락 없음.
- 결정 모델에는 `screen_capture` 송출 종류를 새로 두고 모든 게이트에서 닫아 둠.

**안 만든 것**: 클릭·타자·키·스크롤·드래그 도구(카탈로그에 없고, 호출하면 `unknown_tool`), 도우미의 입력·접근성 쓰기, 앱 실행/활성화, 화면 전체 캡처, 새 화면 문구(아래 7절 제안만).

## 2. 어디가 바뀌었나 (충돌 지점 표시)
| 파일 | 내용 |
|---|---|
| `helper-rust/src/host/observe.rs` (새, 순수 로직 + 시험 10개) | 접근성 트리 걷기(`walk_tree` 한도: 요소 400, 노드 6000, 깊이 24, 시간 3초), 민감 판정(`sensitive_reason`), 가림 좌표 계산(`mask_pixels`), 창 매칭(`match_window_frame`), 크기 축소·base64 |
| `helper-rust/src/host/macos_content.rs` (새) | macOS 호출: CGWindowList(창 확인, 소유 pid 검증), AXUIElement(배치 읽기 한 번에 13속성), CGWindowListCreateImage(그 창만, 가려진 부분 제외, 기본 해상도), 비트맵에 가림 칠하고 ImageIO JPEG |
| `protocol.rs`, `server.rs`, `mod.rs`, `macos.rs`, `Cargo.toml/lock` | 요청 2종, `--observe-content`, hello.ok 의 capabilities, 공개 함수 몇 개(`pub(super)`), 의존 `foreign-types =0.5.0`(이미 lock 에 있던 것) |
| `helper/egdesk-computer-observe.mjs` (새) | 제공자: 도구 사양, 거부 목록, 앱별 승인, 도우미 오류 → 닫힌 코드 |
| `helper/egdesk-computer-observe-wiring.mjs` (새) | 플래그 읽기, 도우미 에이전트 연결 |
| `helper/egdesk-host-agent.mjs` | `capture`, `readElements`, `observeContent` 옵션(`--observe-content` 전달), 도우미 거절 코드 보존 |
| `helper/egdesk-computer-adapter.mjs` | 메서드 `readElements` 추가(검증·정규화·가짜 제공자), `egdesk-host-lease.mjs` 의 읽기 도구 집합에 `read_elements` |
| `helper/codex-chat-runtime.mjs` (충돌 가능) | ① `providerSupportsEngine` 한 줄: 컴퓨터 제공자가 `exposeToClaude === true` 일 때만 Claude 에 보임(플래그가 켜진 제공자만 그렇게 선언) ② `askComputerApp`, `answerComputerCard` 추가, `replyApproval`·만료·run 종료에서 카드 답을 엔진 대신 제공자에게 전달 |
| `helper/codex-bridge-server.mjs` (충돌 가능) | 연결 3곳(import, hostControl 의 makeAgent 에서 옵션 전달, 채팅 런타임을 만든 뒤 `chat.toolProviders.push`). `toolProviders:` 줄 자체는 그대로(기존 시험이 그 줄을 고정 검사함, L5 가 같은 줄을 만질 수 있어서 별도 문장으로 분리) |
| `helper/egdesk-decision-egress.mjs` | `screen_capture` 종류 + 자료 종류 `screen`(어떤 허용도 `screen` 을 열지 않음) |
| `helper/egdesk-computer-observe.test.mjs` (새, 16개), `egdesk-computer-adapter.test.mjs`(메서드 목록 1줄) | 시험 |

## 3. 보호 규칙: 구현 위치와 시험
| 규칙 | 구현 | 시험 |
|---|---|---|
| 창 하나만, 허락된 앱만 | 도구가 `app`(+`windowId`)을 받고 도우미가 창 id·소유 pid 를 다시 확인, 앱별 첫 사용 카드 | `a first look asks once per app per run`, `a declined app is not asked again`, 창 id 가 다른 앱 것이면 `window_not_found` |
| EG-Desk 창·터미널·Codex·ChatGPT·Claude·비밀번호 관리자·시스템 보안 창 제외 | `COMPUTER_DENY_BUNDLES`(번들 id 접두), 이름 규칙, 자기 pid(`process.pid`, `process.ppid`), `org.mozilla.`(EG-Desk 와 같은 Firefox 계열은 브라우저 포함 제외). `EGDESK_COMPUTER_DENY` 로 추가만 가능(줄이는 길 없음) | `denied apps ... are never listed`, `a denied app is refused before any card or helper request` |
| 비밀번호·민감 칸 가림 | 도우미가 접근성에서 `AXSecureTextField`, 역할 설명 'secure', 그리고 텍스트 입력 중 이름·설명·placeholder·id·help 에 비밀 관련어(password, passcode, OTP, PIN, 카드번호, 비밀번호, 인증번호 등)가 든 칸을 찾아 그림에서 검게 칠함. 값은 아예 읽지 않음(읽기 호출이 없음을 시험) | Rust `walk_masks_sensitive_and_never_reads_their_value`, `secure_fields_and_secret_labels_are_sensitive`, Node `read_elements ... a sensitive field carries no value` |
| 가리기에 실패하면 그림 없음 | 트리를 한도 안에 다 못 읽음, 프레임 없는 민감 요소, 읽기 오류, 창이 캡처 중 움직임 → `mask_unavailable`/`window_changed`. 읽지 못한 웹 영역은 통째로 가림. 칠하는 단계가 이미지 뒤에 실행되어 칠해진 픽셀은 인코딩 결과에 없음 | `budgets_make_the_walk_incomplete`, `unreadable_web_area_is_masked_as_a_whole`, `sensitive_without_a_frame_cannot_be_masked`, `mask_pixels_scale_pad_and_clip` |
| 픽셀은 엔진 모델에만, 결정 모델에는 닫힘 | 결과는 도구 응답(inputImage)으로 엔진에만. `screen_capture` 는 어떤 모델 허용으로도 열리지 않음 | `screen_capture is closed for the decision model` |
| EG-Desk 는 픽셀 저장 안 함 | 제공자는 파일을 쓰지 않음(소스에 fs 없음을 시험), 어댑터 기록은 메타데이터만, 저장되는 도구 항목에는 도구 이름만 | `nothing in the provider writes pixels anywhere`, 런타임 시험에서 스냅샷에 이미지 없음 |
| 입력 없음 | 카탈로그와 도우미 프로토콜에 없음 | `unknown tools, input tools ... are refused`, Rust `content_requests_are_refused_unless_the_observer_enables_them` |
| 권한 | 도우미는 권한을 요청하지 않음(preflight 만): 없으면 `permission_missing` + 무엇이 없는지 | 직접 실행 [측정] 아래 |
| 에이전트 한도·컴퓨터 조작 끔·호스트 리스 | 기존 `refuseComputerCall` 이 그대로 앞단에서 검사 | `through the runtime ... control off ...`, `Claude sees the computer tools only ...` |

## 4. 켜는 법
1. Rust 도우미 빌드(오프라인 가능): `cd apps/firefox-ui-demo/helper-rust && cargo build` (기본 위치 `target/debug/egdesk-helper`, `resolveHostAgentExecutable` 이 이 경로를 씀). 옛 빌드는 `--observe-content` 를 몰라서 도우미가 시작되지 않으므로 반드시 다시 빌드.
2. 브리지를 `EGDESK_COMPUTER_OBSERVE=on` 으로 시작(다른 플래그 불필요). 켜면 도우미가 `--observe-content` 로 뜨고(첫 도구 호출 때) 하트비트 한도가 8초가 된다(캡처 하나에 도우미가 몇 초 바쁘기 때문).
3. 컴퓨터 조작 설정이 `끔`이면 이 도구도 안 나온다(아래 7절 결정 거리).

## 5. Main 화면 검증 절차
**먼저 사용자가 직접 해야 하는 macOS 설정 (EG-Desk 는 이 창을 열거나 누르거나 자동 조작하지 않는다)**
1. 시스템 설정 → 개인정보 보호 및 보안 → **손쉬운 사용**, **화면 및 시스템 오디오 기록**(Screen Recording)에서, macOS 가 이 도우미의 '책임 앱'으로 보는 앱을 켠다. 개발 중에는 브리지를 띄운 앱(터미널 또는 EG-Desk 앱)이 항목에 뜬다. 도우미 파일 자체는 서명이 없어(5-1절) 별도 항목으로 안정적으로 쓰기 어렵다.
2. 화면 기록은 켠 뒤 그 앱을 다시 시작해야 적용된다.
3. 어떤 권한이 붙었는지 읽는 점검(읽기 전용, 권한 창을 띄우지 않음; 도우미 빌드 후 사용자 터미널에서):
   `node -e "import('./apps/firefox-ui-demo/helper/egdesk-host-agent.mjs').then(async m=>{const a=m.createHostAgent({executable:process.argv[1]});await a.start();console.log(JSON.stringify(await a.permissions()));await a.stop()})" apps/firefox-ui-demo/helper-rust/target/debug/egdesk-helper`
   결과의 `accessibility`, `screenRecording` 이 둘 다 true 여야 캡처가 된다. `bundled:false` 는 도우미가 .app 번들 안이 아니라 부모 앱의 권한을 따른다는 뜻.

**화면 검증** (EG-Desk 에서 Claude 대화, 플래그 on, 위 권한 완료)
| 단계 | 말 | 기대 |
|---|---|---|
| 1 | "지금 열린 앱 목록 알려줘" | 대화에 도구 `egdesk_computer_list_apps` 가 보이고(항목에는 도구 이름만), 카드는 없음. 답에 앱 이름 목록. 터미널, 비밀번호 관리자, Codex/ChatGPT, EG-Desk 는 목록에 없음 |
| 2 | "계산기 창에 뭐가 보이는지 알려줘" | **허락 카드**(기존 컴퓨터 카드 모양: 앱 이름 + [허락]/[거절], 필드 없음). 답이 오기 전에는 도구 결과가 없음. [허락] 뒤 `egdesk_computer_capture`(필요하면 `read_elements`) 결과로 창 내용을 설명 |
| 3 | 같은 대화에서 "계산기 버튼도 읽어 줘" | 카드가 다시 뜨지 않음(같은 run, 같은 앱) |
| 4 | "터미널에 뭐 있는지 봐 줘" | 카드 없이 거절(`app_unavailable`), 모델이 못 본다고 답 |
| 5 | 카드를 [거절] | 모델이 `app_not_approved` 를 받고 다시 묻지 않음 |
| 6 | 권한이 없는 상태에서 2번 | 카드 [허락] 뒤 `permission_missing`(화면 기록/손쉬운 사용 중 없는 것 명시) 로 답. 이것도 정상 동작(권한을 EG-Desk 가 대신 요청하지 않음) |
| 7 | (선택) 비밀번호 입력칸이 있는 창(예: 로그인 폼이 열린 Safari)을 캡처 | 그림의 비밀번호 칸이 검게 가려지고 응답의 `masked.count` 가 1 이상. 실제 앱에서 이 판정이 맞는지는 아래 [미확인] |
| 8 | Codex 에서 같은 요청 | 같은 도구 4개. 단 일반(순수 아님) Codex 는 자체 컴퓨터 조작(내 Codex 설정 그대로)도 갖고 있어 모델이 그쪽을 쓸 수 있음. EG-Desk 도구만 쓰게 하려면 `EGDESK_OWN_TOOLS_PURE`(MCP·플러그인 0) 사용 |

## 6. 측정 [측정]
- **Rust**: `cargo check --offline`, `cargo build --offline`(debug) 성공, 경고 0. `cargo test --offline`: 36 통과 0 실패(관찰 로직 10 + 프로토콜 신규 2 + 기존 24). 환경: cargo 1.95.0, `CARGO_TARGET_DIR` 을 작업 사본 밖으로.
- **Node 시험**: 새 파일 16개 통과. 게이트 결과는 맨 아래.
- **도우미 실제 실행** (이 Mac, 내 REPL 이 책임 프로세스, 권한창 상호작용 없음; 앱·창 이름은 출력하지 않고 개수만 확인): `permissions` = accessibility **true**, screenRecording **false**, inputMonitoring true, bundled false. `capture` 는 의도대로 `permission_missing`("screenRecording") 으로 거절. 따라서 **캡처 픽셀 경로(CGWindowListCreateImage, 가림 칠하기, JPEG)는 컴파일과 거절 경로까지만 확인했고 실제 그림은 못 만들어 봤다.**
- **접근성 읽기는 실제 창에서 동작**: 화면 위 일반 창 9개에 `readElements`. 작은 창(요소 4~33개)은 50~190 ms 에 `complete:true`. 큰 창 2개는 2초 한도(당시 값)에 걸려 `complete:false`(그림이라면 거절 대상), 요소 400개 상한에 걸린 창 3개(그중 1개는 `complete:true`). 같은 프레임의 두 창은 `ambiguous_window`, 화면에서 사라진 창은 `window_not_found`. 이 측정 뒤 시간 한도를 3초로 올렸다(다시 측정하지 않음).
  → [해석] 요소가 아주 많은 앱(브라우저·메신저 계열)은 캡처가 `mask_unavailable` 로 자주 거절될 것이다. 이것이 '가리기에 실패하면 보내지 않는다' 결정의 비용이다.

## 7. 레퍼런스 갱신 반영 (Main 전달 5건)
1. **cua-driver 버전 고정**: 참고한 버전은 `cua-driver-rs-v0.53.1`(2026-11-18, MIT, Rust 워크스페이스)까지. nightly 0.62.2(11-25)는 보지 않았다. 이식한 코드는 **없다**: 이번 Rust 는 공개 Apple API(CGWindowList, AXUIElement, ImageIO)로 새로 썼고 cua 에서 가져온 것은 설계 패턴(창 하나만, 접근성 읽기와 캡처 분리)과 의존 버전 고정(objc2 0.5.2, core-graphics 0.24.0 등, 이전 라운드부터)뿐이다. 텔레메트리: 새 파일에 네트워크 호출·HTTP 클라이언트 의존이 없음(도우미의 통신은 Unix 소켓 하나, grep 확인).
2. **TCC·서명 체크리스트** (B1 체크리스트, 현재 상태 포함)
   | 항목 | 현재 개발 환경 [측정] | 해야 할 일 |
   |---|---|---|
   | 도우미 서명 | `codesign -dv`: `flags=adhoc,linker-signed`, `Identifier=egdesk_helper-<빌드마다 다른 해시>`, TeamIdentifier 없음 | 배포: Developer ID 로 서명한 번들(예 `EG-Desk Host Agent.app`, 고정 번들 id, hardened runtime, LSUIElement) 또는 EG-Desk.app 안에 같은 신원으로 서명한 도우미 |
   | 서명 신원 | `security find-identity -p codesigning`: 유효 신원 **0개** | 개발: 안정된 자체 서명 인증서 + `codesign -s <이름> -i <고정 identifier>` 로 재빌드해도 지정 요구가 같게 |
   | 재서명·ad-hoc | ad-hoc 이라 재빌드마다 cdhash 가 바뀌어 허락이 풀릴 수 있음(cua 문서 [2차]) | 개발 절차에 `tccutil reset ScreenCapture`/`Accessibility <번들 id>` 포함 |
   | 책임 프로세스 | 도우미가 번들 밖이라 `bundled:false`: 부모(브리지를 띄운 앱)의 권한을 따름. node 는 Node.js Foundation 서명(`TeamIdentifier=HX7739G8FX`)이라 EG-Desk 정체가 아님 | 책임 체인을 EG-Desk 앱에 고정: 도우미는 브리지(EG-Desk 소유)만 띄우고, Codex·Claude 의 자식으로 띄우지 않는다(지금 구조가 그렇다: 에이전트가 브리지 안에 있음). 출시 때는 EG-Desk 앱이 브리지를 띄우게 |
   | 설치된 앱 | `/Applications` 에 EG-Desk 앱 없음(Aside, Firefox 만) | 출시 번들 완성 뒤 다시 측정 |
   | 읽기 점검 | `permissions` 요청의 `accessibility`, `screenRecording`, `bundled` | 5절 3번의 한 줄 |
   [한계] 서명 실험(자체 서명 신원 만들기)은 이 Mac 의 키체인과 TCC 를 건드릴 수 있어 하지 않았다.
3. **Anthropic `computer_toolset_20260801` 정렬**: 좌표 규약은 '돌려준 스크린샷의 픽셀'. `capture` 가 같은 규약으로 `image.width/height`, `scale`(그림 픽셀/창 포인트), `geometryRevision` 을 돌려주고, 전송 전 도우미에서 `maxEdge`(기본 1280, 최대 2048)로 줄인다. 접근성 요소의 `rect` 는 창 포인트 단위이고 `scale` 을 곱하면 그림 픽셀. 입력 멤버(클릭, 타자 등)는 카탈로그에서 제외. toolset 의 `screenshot` ↔ 우리 `capture`, `zoom`·배치는 B1 에서 제외. [해석] 이름은 EG-Desk 접두를 유지하고 toolset 이름과 같게 맞추지 않았다(공통 카탈로그, 두 엔진 동일).
4. **Codex 허용 앱 파일 비의존**: 새 코드는 `~/.codex` 어디도 읽지 않는다(grep 확인). 앱별 허락은 EG-Desk 카드 + run 안의 메모리(WeakMap)뿐이다.
5. **Claude 내장 `computer-use` MCP**: EG-Desk 가 띄우는 Claude 는 `-p --output-format stream-json --input-format stream-json --permission-prompt-tool stdio --settings {...} --setting-sources=… --strict-mcp-config --mcp-config {sdk}`(`claude-engine-transport.mjs:387-397`). 문서상 내장 서버는 대화형 세션 전용·`/mcp` 에서 켜야 하고, `--strict-mcp-config` 는 `--mcp-config` 의 서버만 로드하므로 보이지 않을 것이다. 단 `managed-mcp.json` 이 있으면 `--strict-mcp-config` 가 빠진다(`:396`). [미확인] 실제 Claude 로 확인하지 못했다(자동 실행 금지). 확인 방법(Main, 로그인한 CLI): EG-Desk 대화 init 메시지의 `mcp_servers` 에 `computer-use` 가 없는지 본다. [제안, 승인 필요] init 의 `mcp_servers` 에 `egdesk` 외 이름이 있으면 경고 행을 남기는 검사(L5 영역이라 구현하지 않음).

## 8. 한계 [미확인]
- 캡처 그림 자체(권한 필요), 가림이 실제 앱에서 맞는지(Safari/Chrome 비밀번호 칸, 웹 접근성 트리 노출 여부), 앱 이름 현지화(한국어 macOS 의 '계산기' 이름 조회), 카드 화면 모양(런타임 이벤트까지만 시험, 실제 UI 렌더는 안 봄).
- 큰 접근성 트리의 시간 한도 3초는 측정 근거가 약하다. 도우미가 이 시간 동안 한 줄(요청)만 처리하므로 하트비트 한도(8초)가 필요했다.
- 도우미 서명·번들·TCC 안정성(위 표), 같은 앱의 여러 프로세스(활성 프로세스 우선으로 고름), 여러 모니터·Spaces.
- 카드의 문장(`computerAppCard`)은 임시 문구다.

## 9. 대표님이 정할 것 (새 문구·이름은 제안만, 승인 필요)
1. 카드 문구(임시): "Agent가 '앱 이름' 앱의 창 하나를 화면 이미지와 접근성 요소로 읽으려 합니다. 비밀번호 칸 등은 가려지고, 이번 작업에서만 허락됩니다." [승인 필요]
2. '화면을 보는 중' 표시와 활동 행(새 화면 요소): 이번에는 만들지 않았다. 첫 사용 카드가 유일한 흔적이다. [승인 필요]
3. 컴퓨터 조작 설정 `끔`은 지금 Codex 내장 컴퓨터 조작과 이 도구를 함께 끈다. 둘을 따로 끌지 정해야 한다(예: 'EG-Desk 도구만 켜고 Codex 내장은 끔').
4. 브라우저(`org.mozilla.`=EG-Desk 와 같은 계열) 제외 범위: 지금은 Firefox 계열 전체 제외, Safari/Chrome 은 포함.
5. 도우미 서명 신원(자체 서명 개발용 / Developer ID 배포용)을 언제 만들지.
6. 입력 단계(B2/B3)는 이 라운드에서 하지 않았다.

## 10. 합칠 때
- L5(`egdesk-claude-mcp`·명령/파일 도구)와 L8(브라우저 도구)과는 파일이 겹치지 않는다. 겹칠 수 있는 곳: `codex-chat-runtime.mjs`(providerSupportsEngine 한 줄, askComputerApp 블록, replyApproval 한 줄), `codex-bridge-server.mjs`(3곳), 모두 최소 편집이다.
- 이름 충돌: 도구는 `egdesk_computer_*` 접두 4개뿐이고 `egdesk-computer` 제공자 id 는 기존 런타임 규약 값이다.

## 11. 게이트와 커밋
- 커밋(브랜치 `lane/u1-computer-observe`): `b659fa9`(Rust 도우미), `ea76dda`(Node 쪽). 중단 때의 임시 커밋 `06647d5` 는 이 둘로 다시 만들어 정리했다(검토 후 시험·게이트 통과).
- 게이트 `gate.sh wt-l6-u1 l6u1`: `files=496 rc=0`, tests 7981, pass 7942, **fail 0**, skipped 38 (253초). 첫 실행에서 `egdesk-own-tools-wiring.test.mjs` 의 '브리지 `toolProviders` 줄 고정' 검사 1건이 실패했고(내가 그 줄을 고쳤기 때문), 줄을 그대로 두고 런타임을 만든 뒤 `chat.toolProviders.push` 로 등록하도록 고쳐 다시 돌려 통과했다.
- 증거: `evidence/gate-l6u1/full.tap`, `evidence/u1-cargo-test.out`, 도우미 직접 실행 결과는 6절.
