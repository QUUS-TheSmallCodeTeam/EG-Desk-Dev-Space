# 레퍼런스 갱신 보고 (2026-11-26 KST, 기준선 2026-10-24)

표기: [검증] = 공식 페이지/저장소 원문을 직접 읽음. [2차] = 블로그·비교 사이트·이슈 등 간접 보도. 판정: 변화 없음 / 조정 / 위험.

## 요약 (중요도 순)
1. [위험·조정] Claude Code CLI에 내장 `computer-use` MCP 서버(macOS, research preview)가 공식 문서화됨. 단 대화형 세션 전용(`-p` 불가), Pro/Max/Ultra 한정, 세션 단일 잠금. EG-Desk의 stream-json 호스팅과 충돌 가능 -> 자체 `egdesk_computer_*` 카탈로그 결정(D-C1)은 오히려 강화. 단, 사용자가 내장 서버를 켜면 이중 경로가 생기므로 --settings 격리에서 차단 필요(검증 필요).
2. [변화 없음, 근거 강화] Claude Code 법무 페이지: "수정되지 않은 바이너리에 사용자가 자기 구독으로 로그인"은 플랫폼 호스팅 포함해서 명시 허용. 자격증명 수집·저장·중개 금지, 로그인은 Anthropic 흐름에서 완료, 사전 통지 없는 집행 유보.
3. [위험] Agent SDK 문서는 여전히 "사전 승인 없이는 제3자가 claude.ai 로그인/요금한도 제공 불가". EG-Desk가 SDK가 아닌 CLI를 stream-json으로 구동하는 점은 OpenCode(SDK로 설치된 claude 실행)와 다름. "사용자가 설치·로그인한 Claude Code를 구동하는 앱"은 문서가 명시적으로 이름 붙이지 않음([2차] shuriken.sh 분석).
4. [조정] cua-driver는 Swift에서 Rust 워크스페이스(`cua-driver-rs`)로 바뀌어 있고 릴리스 속도가 매우 빠름(11/16 한 주에 0.52.10~0.56.8, 11/18 0.53.1, 11/25 nightly 0.62.2). 포팅 레퍼런스는 이제 Rust 코드이므로 D-C1(자체 Rust 도우미)에 유리. MIT 유지, 텔레메트리 기본 ON.
5. [변화 없음] B1(관찰 전용) 범위, 네이티브 Rust 도우미, 단일 카탈로그: OpenAI·Anthropic 어느 쪽 변화도 이를 뒤집지 않음.

## 1. 기준선 레퍼런스 프로젝트

### 1.1 cua-driver / trycua (MIT)
- 변경 [검증]: 현재 구현은 Rust(`libs/cua-driver/rust/`, 데몬·UniFFI SDK·플랫폼 크레이트). 릴리스 태그 `cua-driver-rs-v*`. 0.53.1 (2026-11-18) 수정 4건: macOS AX 열거 카운트 보고, 표시 전용 행 관찰 게시, 백그라운드 픽셀 메뉴 키 등가, stale token 오류 설명. nightly 0.62.2 (2026-11-25). 출처: https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.53.1 , https://github.com/trycua/cua/releases , https://cua.ai/changelog/2026-11-16
- 인터페이스 [검증]: MCP stdio(`cua-driver mcp`), `cua-driver call` CLI, Rust/Python/TS SDK(C ABI `cua_driver_*_v1`, UniFFI). `get_window_state`(트리+스크린샷), `get_desktop_state`, `zoom`, `list_windows`, `invoke_menu`, `run_script`(기본 ON 샌드박스 JS), `element_token` 전용 요소 지정(`element_index` 제거), 0.35부터 `get_window_state` 기본 간결화(노드 250개 상한, 닫힌 메뉴 접힘), 별도 `screenshot` 도구 없음. 출처: https://cua.ai/docs/reference/cua-driver/telemetry (운영 문서 페이지, "Before updating to 0.35"), https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md
  - 함의: 관찰 API 설계(egdesk_computer_* 의 window state = 트리 + 스크린샷, 토큰으로 요소 지정, stale 토큰 거부, 노드 상한)를 그대로 참고할 만함. 조정(설계 참고): 요소 지정은 인덱스 대신 스냅샷 한정 토큰.
- 권한 모델 [검증]: macOS 14+, Accessibility + Screen Recording을 `CuaDriver.app`(번들 id `com.trycua.driver`)에 부여. TCC는 호출 프로세스가 아니라 "책임 앱(responsible app)" 기준. 터미널/IDE에서 직접 띄우면 IDE의 TCC로 판정됨. 서명되지 않은/ad-hoc 빌드는 designated requirement가 cdhash라 재빌드마다 grant가 무효화(토글해도 복구 안 됨), 릴리스는 CI 안정 서명이라 업데이트 후에도 유지, 로컬 개발은 안정적 자체서명 + `tccutil reset`. 날것의 `cua-driver serve`를 앱 번들 밖에서 띄우는 구성은 "미지원". 임베딩은 권한을 가진 앱이 `EmbeddedCuaDriverHost`로 private daemon을 띄워 책임 체인 상속. 출처: https://cua.ai/docs/cua-driver/guide/getting-started/faq , README 위 링크
  - 함의: [조정] EG-Desk Rust 도우미는 (a) 안정적 Developer ID 서명 번들 id를 가진 앱/헬퍼로 배포, (b) TCC 책임 체인을 Codex·Claude 자식 프로세스가 아니라 EG-Desk 쪽에 고정(Claude Code가 자식으로 도우미를 띄우면 귀속이 터미널/호스트로 흘러감 -> in-process MCP 또는 EG-Desk 소유 데몬 경유 유지), (c) 개발 빌드는 안정 자체서명 인증서 사용을 B1 체크리스트에 추가. 이는 기존 계획과 충돌하지 않고 구체화.
- 텔레메트리 [검증]: 기본 ON, PostHog EU, 내용 없는 가명 이벤트(버전·OS·아키텍처·도구 이름·구간 지연·결과). 끄기: `cua-driver telemetry disable`, `CUA_DRIVER_RS_TELEMETRY_ENABLED=false`, `DO_NOT_TRACK=1`, `CUA_TELEMETRY=0`. 업데이트 확인은 별도(`update_check_enabled`). 출처: https://cua.ai/docs/reference/cua-driver/telemetry 및 https://cua.ai/docs/cua-driver/guide/getting-started/faq . 함의: 직접 임베딩하지 않으므로 직접 영향 없음. 만약 설치본을 사용자에게 권한다면 텔레메트리/업데이트 확인 끄기 필요. 변화 없음.
- 라이선스 [검증]: 드라이버 MIT 유지(PyPI 분류 MIT). `cua-perception`(OmniParser 아이콘 검출기)은 AGPL-3.0-only, "frozen: no new work". ClawHub에 게시되는 스킬 사본은 MIT-0. 출처: README, https://pypi.org/project/cua-driver/ . 변화 없음(기준선도 AGPL 확장 설치 금지).
- 보안/권한 모드 [검증]: 권한 모드 `standard`(무프롬프트 기본)/`bounded`(검토된 매니페스트만)/`unrestricted`(`--dangerously-bypass-approvals`), 실행 시 고정. "Cua Driver는 자체 승인 모달/배너를 그리지 않음"(임베딩 호스트가 `DriverAuthorizationHost` 제공). 기존 Chromium 프로필 부착은 `--grant existing-profile` 명시. 짧은 포그라운드 단계(drag)는 `CUA_DRIVER_ALLOW_BRIEF_FOREGROUND=1` 때만. Computer History(암호화 로컬 액션 기록)는 deprecated, 11/26 이후 릴리스에서 도구 제거 예정. 함의: 참고(승인 UI는 호스트 책임이라는 점은 EG-Desk의 CU-01/04 설계와 일치). 변화 없음.
- Cua Spaces [검증]: macOS 26+용 앱이 Cua Driver를 내장하고 Claude Code/Codex를 연결. 출처: README. 함의: 사용자가 이미 설치했을 수 있는 병행 드라이버 – EG-Desk는 무관하게 자체 도우미 사용, 충돌 시 권한 목록에 CuaDriver가 별도 항목으로 보일 뿐.
- 버그 보고 [2차, 이슈 트래커]: 릴리스 노트에 macOS AX 열거 실패(`ax_window_unresolved`), 메뉴 키 등가 등 – 즉 AX 트리 읽기 엣지케이스가 아직 활발히 수정되는 영역. 함의: B1의 AX 트리 읽기는 "창 해석 실패 시 사유 반환" 계약을 처음부터 넣을 것.

### 1.2 cua-spacesd
- [검증] cua-spacesd는 샌드박스/호스트 데몬(gRPC, `/mcp` Streamable HTTP, 포트 3211·3212 QUIC), cua-driver를 in-process로 링크, macOS는 ScreenCaptureKit + VideoToolbox, LaunchAgent, "안정 서명 신원에 Screen Recording/Accessibility 필요". 0.12.x(11/5) -> 0.17.7(11/24). 출처: https://github.com/trycua/cua/blob/main/libs/cua-spacesd/README.md , CHANGELOG.md , releases. 라이선스는 기준선(FSL, 패턴만) 그대로, 이번에 변경 확인하지 못함(이번 조사에서 LICENSE 원문은 읽지 않음). 함의: 변화 없음(코드 복사 금지, 패턴만).

### 1.3 Peekaboo
- [검증] 저장소가 `openclaw/Peekaboo`, Developer ID "OpenClaw Foundation (FWJYW4S8P8)"로 서명·공증. v4.9.7(10/23) -> 4.9.8(11/05) -> 4.9.9(11/15) -> 4.9.10(11/20). 4.9.10: 임베디드 Bridge(OpenClaw.app)에서 네이티브 도구만 기동, 브라우저 자동화를 감사된 Chrome DevTools MCP 1.13.0으로 이동, 전체 페이지 캡처는 포그라운드 권한 필요, AXorcist 0.2.3. 출처: https://github.com/openclaw/Peekaboo/releases . 라이선스 MIT는 기준선 기록 유지(이번에 LICENSE 재확인 안 함). 함의: 변화 없음. AXorcist(AX 관찰 라이브러리)와 "임베디드 Bridge가 TCC 책임을 갖는" 구조는 B1 참고 가치.

### 1.4 Hermes (NousResearch)
- [검증] 내장 `computer_use` 툴셋이 stdio MCP로 cua-driver 사용. `pm/lock.json`에 cua-driver 고정, 설치기·`hermes update`가 모든 macOS/Windows/glibc Linux에 기본 설치(`--skip-computer-use`로 제외), 데스크톱 앱 번들에도 포함. 모델 비종속("Anthropic-native schema 불필요"). macOS 입력은 SkyLight SPI `SLPSPostEventRecordTo`(pid 지정, 커서 이동 없음). 출처: https://hermes-agent.nousresearch.com/docs/user-guide/features/computer-use . 함의: 변화 없음. 참고로 AX 트리 읽기는 공개 API, 백그라운드 입력은 비공개 SPI라는 구분이 문서에 명시 -> B1이 관찰 전용이라 SPI 의존을 피하는 이점이 재확인됨(입력 단계 B2 이후의 위험 항목).

### 1.5 Windows-MCP (CursorTouch, MIT)
- [검증, 부분] 저장소 페이지에서 "Claude Desktop Extensions 200만+ 사용자", PyPI(`uvx windows-mcp`), MCP Registry 등재 확인. 상세 버전/라이선스 변경은 이번에 확인하지 못함. 함의: B1(macOS)과 무관, CU-09(Windows)는 기준선대로 후순위. 변화 없음.

### 1.6 tmustier/codex-computer-use-mcp
- 이번에 갱신 여부 확인하지 못함. 아래 3.1의 OpenAI 측 변화(플러그인 구조·권한 대상 이름) 때문에 이 비공식 래퍼는 깨질 수 있음 -> 의존하지 말 것(기준선 입장 유지).

## 2. 새로 등장/주목받은 macOS 드라이버·MCP 서버
- 비교 글 [2차] https://shadowcursor.com/guides/best-macos-mcp-servers (갱신 2026-11-11, 작성자가 유료 제품 ShadowCursor 판매자라 이해관계 있음): 8개 중 무료 오픈소스는 Cua Driver, Peekaboo(MIT), computer-use-mcp(소형 MIT, 보이는 에이전트 커서), Macuse(Calendar/Mail/Notes 연동, 무료 일일 한도), PyAutoGUI 계열은 실제 포인터 사용. ShadowCursor는 유료로 에이전트마다 커서·키보드·클립보드 분리. 신뢰도 낮음, 라이선스·성숙도 직접 검증 안 함.
- Muse Code(Meta)가 cua-driver를 stdio MCP로 사용하도록 README에 문서화 [검증]: https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md
- Factory Droid, Cursor, Prime Agent(스킬/CLI) 연동 문서화 [검증]: https://cua.ai/docs/cua-driver/guides/connect-your-agent
- 결론: 신규 대체재 중 성숙도·라이선스가 검증된 것은 없음. 함의: 변화 없음(D-C1 유지). 이번 조사는 웹 검색 한계로 GitHub 전체 탐색은 하지 않았음.

## 3. 공식 벤더 변화

### 3.1 OpenAI Codex / ChatGPT Computer Use
- [검증] 공식 문서(https://learn.chatgpt.com/docs/computer-use)의 현재 내용:
  - 위치가 ChatGPT 데스크톱 앱 `Settings > Computer use`의 "Any App" 항목으로 바뀜(플러그인 페이지 대체 가능). macOS와 Windows 지원, ChatGPT Work와 Codex 공통. 어려운 시각 과제는 모델 선택기에서 "GPT-6.2 Astra" 권장.
  - macOS 권한 이름이 문서에서는 "Codex Computer Use"(System Settings > Privacy & Security)로 안내됨.
  - 새 기능 "Locked use"(macOS): Mac이 잠긴 뒤에도 연결 기기의 작업이 가능하도록 Apple authorization plug-in 설치, 활성 신뢰 Computer Use 턴에 한해 일시 해제, 전체 디스플레이 가림, 로컬 입력 감지 시 재잠금.
  - 터미널 앱·ChatGPT 자신은 자동화 불가, 관리자 인증/보안 권한 프롬프트 승인 불가.
  - 관리 정책: `requirements.toml`의 `[features].computer_use = false`로 관리자가 끔. Windows 앱 허용 목록은 `$CODEX_HOME/config.toml`의 `[computer_use.windows] always_allowed_app_ids`, 예전 `$CODEX_HOME/computer-use/config.toml` 항목은 새 설정으로 이관, 그 `denied` 목록은 현재 스키마에 없음.
  - 함의: [조정] 기준선(2026-10-24)은 `~/.codex/computer-use/*.toml`의 `[apps] allowed`, `unified-computer-use` 플러그인의 `cua_repl` 도구 3개에 의존한 분석을 담고 있음. 허용 앱 저장 위치와 설정 키가 이동 중이므로 EG-Desk가 Codex 쪽 허용 기록을 파일로 읽는 설계가 있다면 깨질 수 있음. B1은 자체 도우미라 영향 작음.
- [2차, GitHub 이슈 openai/codex#58972, 2026-11-02]: Computer Use 26.1015.1001540의 `SkyComputerUseClient`(`com.openai.sky.CUAService.cli`)가 managed `codex app-server` 데몬에서 시작할 때 `_RegisterApplication`에서 SIGABRT, 10/27~10/31 25회 크래시. 함의: managed app-server가 Sky 클라이언트를 자식으로 띄우면 LaunchServices 등록 문제 -> TCC/책임 체인 취약성의 실례. 자체 도우미를 앱 번들로 설계하는 근거.
- [2차, #59114, 2026-11-03] Windows 업데이트 후 native pipe 오류. [2차, #62077, 2026-11-17] macOS 26.1106/26.1111에서 `cua_repl` MCP 서버가 채팅마다 사라짐(플러그인 재조정 실패, Edge/Brave 디렉터리 EPERM, TCC 귀속 로그). 함의: OpenAI 내장 경로는 불안정 징후 -> EG-Desk가 Codex dynamic tools로 자체 카탈로그를 노출하는 방식의 가치 재확인. 변화 없음.
- 공식 changelog 최신 항목 중 읽은 것은 2026-08-25(브라우저 확장 등)까지이며 10/24 이후 항목은 직접 확인하지 못함(미확인).

### 3.2 Anthropic computer use (API)
- [검증] https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool : 새 클라이언트 툴셋 `{"type":"computer_toolset_20260801"}` 하나로 멤버 도구 17개(`screenshot`, `left_click`, `type`, `zoom` 등), 베타 헤더 불필요, `toolset_name:"computer"`. 이전 `computer_20251124`의 `display_width_px/height_px/display_number/enable_zoom` 파라미터는 거부(좌표는 항상 반환한 스크린샷 픽셀 공간). 배치 액션(순서대로 실행, 첫 실패에서 중단, 나머지 `is_error` + 정해진 중단 문구, 모든 tool_use에 tool_result 필요), 멤버별 `configs.enabled`/`defer_loading`. 스크린샷은 모델 이미지 한도 안으로 앱이 미리 줄여야 하고(API가 줄여주지 않음) 스케일 계수로 좌표 복원. Managed Agents에서는 미지원. 프롬프트 인젝션 분류기가 스크린샷 등 도구 결과를 자동 검사(끄려면 지원 문의).
- 함의: [조정(설계 정렬)] `egdesk_computer_*`가 Claude/Codex 양쪽에 같은 카탈로그를 낸다면 (a) 좌표는 반환 스크린샷 픽셀 공간으로 통일하고 스케일 계수를 도우미가 기억, (b) 스크린샷은 전송 전에 모델 한도로 다운스케일, (c) 관찰 전용 B1에서는 입력 멤버(click/type 등)를 카탈로그에서 제외(`configs`로 가리는 방식과 동일 개념). B1 범위 자체는 변화 없음.

### 3.3 Claude Code의 컴퓨터 제어 기능
- [검증] https://code.claude.com/docs/en/computer-use : CLI 내장 MCP 서버 `computer-use`(기본 꺼짐, `/mcp`에서 활성화, 프로젝트별 저장). macOS 전용 research preview, Pro/Max/Ultra, Team/Enterprise 불가, 대화형 세션 필요(`-p` 불가), claude.ai 인증 필요(Bedrock/Vertex/Foundry 불가). 앱별 세션 승인, 브라우저 view-only·터미널/IDE click-only, 터미널 창은 스크린샷에서 제외하고 다른 앱은 숨김, Esc 전역 중단, 한 세션만 잠금 보유. 스크린샷 자동 다운스케일(3456x2234 -> 약 1372x887). 권한: 터미널 앱에 Accessibility + Screen Recording.
- [검증] Desktop 앱은 macOS/Windows에서 같은 엔진, macOS는 백그라운드 실행 가능: https://code.claude.com/docs/en/desktop
- [검증, 공식 릴리스 노트] 2026-11-20: Team/Enterprise에 Computer use(beta) 제공(새 Claude 경험, Claude Desktop), 점진 롤아웃: https://support.claude.com/en/articles/12138966-release-notes
- 함의: [위험] (1) EG-Desk가 Claude Code를 stream-json(--permission-prompt-tool stdio)으로 구동하면 `-p` 계열 비대화형일 가능성이 큼 -> 내장 `computer-use`는 표시되지 않을 가능성이 높음(추정, 실제 확인 필요: 대표님 환경에서 `--mcp-config`로 호스팅 시 /mcp 목록 점검). 즉 EG-Desk가 `egdesk_computer_*`를 주입해야 하는 이유가 문서로도 뒷받침됨. (2) 사용자가 별도로 대화형 Claude Code에서 내장 서버를 켜 둔 경우 `--settings` 격리가 그 설정을 가져오지 않는지 확인 필요. (3) 내장 서버의 "다른 앱 숨기기, 터미널 제외, Esc 전역 중단, 세션 잠금" 설계는 CU-01/02/04/05 요구와 거의 동일 -> 공식 UX 선례로 인용 가능(복사 대상 아님). (4) Claude 쪽 TCC는 터미널/호스트 앱에 귀속된다는 문서 서술 -> EG-Desk 호스팅 시 책임 앱 관점 확인 필요.

## 4. 다른 제품의 Claude Code 호스팅, 법무/도움말, 집행

### 4.1 Anthropic 공식 문구 [검증, 2026-11-26 읽음]
출처: https://code.claude.com/docs/en/legal-and-compliance (페이지에 날짜 없음)
- "Can customers offer Claude Code in their products?": 제품에 Claude Code를 사전 설치/실행하려면(호스팅 샌드박스·에이전트 인프라 예시) 상용 약관 동의와 다음 조건 준수. (1) 바이너리 수정 금지, 게시된 대로 설치·실행, 내장 인증 방식(Claude 계정 로그인, 사용자 API 키 포함)을 제거·비활성·제한 금지. (2) 고객이 최종 사용자 대신 비용 지불·재판매·중개 금지, 각 사용자가 자기 API 키/구독/3P 자격증명으로 인증하고 직접 과금.
- 이름·로고: "Claude Code를 사전 설치했다/실행한다"를 평문으로 말하는 것은 허용, 제품·기능·회사명·로고에 Claude Code/Anthropic 명칭 사용, 제휴·보증 암시 금지.
- 인증: OAuth는 구독 구매자용이며 "Claude Code 및 기타 네이티브 Anthropic 앱의 일반적 사용"을 위해 설계됨. Agent SDK 등으로 제품을 만드는 개발자는 API 키 사용. "제3자 개발자가 claude.ai 로그인을 제공하거나 Free/Pro/Max/Ultra 자격증명으로 사용자 대신 요청을 라우팅하는 것"은 불허. 개발자는 Claude.ai 자격증명·세션 토큰을 수집·저장·중개할 수 없고 로그인은 Anthropic 흐름에서 완료되어야 함. 단 "수정되지 않은 Claude Code 바이너리에 최종 사용자가 자기 구독으로 로그인하는 것"은 "플랫폼이 Claude Code를 호스팅하는 경우 포함"하여 막지 않음. 조치는 사전 통지 없이 가능. 한도는 "일반적·개인적 사용"을 전제.
- 변화 판단: 2026-10 초 [2차] bringyoursubs(2026-10-03)가 "플랫폼 호스팅 포함" 문구를 인용했으므로 이 예외 문구는 10/24 이전부터 존재 가능. 즉 10/24 이후의 새 변경으로 확인되지는 않음(페이지에 날짜 없음). 11/13 [2차, fixit.co.jp]은 "바이너리 비수정 + 내장 인증 방식 제거/비활성/제한 금지" 요건이 확인되는 상태로 읽었다고 서술. 이번 [검증] 내용과 일치.
- Agent SDK 개요 [검증, 2026-11-12 게시일 표기] https://code.claude.com/docs/en/agent-sdk/overview : "사전 승인이 없는 한 제3자 개발자가 claude.ai 로그인이나 요금한도를 제품에 제공하는 것을 허용하지 않음. API 키 인증 사용." 
- 이용정책 [2차, cellcog 2026-11-14 인용]: Anthropic Usage Policy(효력 2026-11-12)에 "소비자 구독을 통해 요청을 라우팅하거나 사용 중인 제품·클라이언트를 허위 표시하는 비인가 수단을 포함해 Claude 접근을 재판매·프록시·제공" 금지 문구. 원문은 이번에 직접 읽지 못함. https://www.anthropic.com/legal/aup 확인 필요(미검증).
- 함의: [변화 없음, 유지 조건 구체화] EG-Desk의 현재 계획(무수정 설치본 호스팅, 사용자가 Anthropic 흐름으로 직접 로그인, --settings 격리, 토큰을 읽지도 저장하지도 않음)은 문구와 부합. 위험 방지 체크: (a) `~/.claude` 자격증명 파일·키체인 항목을 EG-Desk가 읽거나 복사·저장하지 않을 것, (b) 내장 인증 방식을 막는 설정(`--settings`의 인증 관련 키 제한 등)을 넣지 않을 것, (c) UI 이름·로고에 "Claude Code"를 제품 일부로 쓰지 말고 평문 "runs Claude Code"만, (d) EG-Desk가 요금을 대신 내거나 공용 계정을 쓰게 하지 말 것, (e) 자동화/비인간 접근 조항([2차] 소비자 약관 인용: API 키 또는 명시 허용 외 봇·스크립트 접근 금지) 때문에 stream-json 구동이 "Claude Code 자체의 공식 프로그램 인터페이스"로 해석될 근거를 문서로 확보(Claude Code 공식 CLI 문서의 stream-json·MCP·permission-prompt-tool 기재를 근거 링크로 보관)해 둘 것. 이 (e)는 위험으로 표시.

### 4.2 OpenCode Claude Agent provider [검증+2차]
- [2차, 다수 일치] OpenCode v2.2.3 (2026-10-30)에 Claude Agent provider 추가. 설치된 `claude`를 Anthropic Agent SDK로 실행, Claude Code가 모든 요청을 보냄, OpenCode는 로그인을 읽지 않음, Claude Code 내장 도구는 끄고 OpenCode 도구를 주입, CLAUDE.md 로딩 끔, 원격/호스트 워크스페이스 미지원(같은 머신 필수), Claude Code 2.1.248+ 필요. 출처: https://cellcog.ai/blog/opencode-claude-subscription/ (2026-10-30, 11-14 정정), https://aicodewith.ai/en/blog/opencode-claude-agent-provider-subscription-api-key , https://dalao.ai/news/a/w21FAWr86a . 릴리스: https://github.com/anomalyco/opencode/releases/tag/v2.2.3 (cellcog가 링크, 이번에 직접 열지 않음), 2.2.7(11/10)·2.3.0(11/13)에 provider 수정.
- 허가 [2차]: PR #58782에서 OpenCode 구성원이 "We got permission from Anthropic and everything here is fully tos compliant"(2026-10-30 16:24 UTC) 주장. Anthropic의 공개 확인은 없음(cellcog 11/14 기준). 근거 문서 PR: https://github.com/anomalyco/opencode/pull/58782
- 배경 [2차, 일부 2차 보도 인용]: 2026-01-09 Anthropic 직원이 "Claude Code harness 스푸핑 단속, 제3자 하니스의 구독 사용은 ToS 위반" 발표, 2026-02-20 법무 페이지 OAuth 조항 강화(The Register: https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access ), 2026-04-04 OpenClaw 등 제3자 도구 구독 사용 종료(구독 한도 대신 extra usage, The Register: https://www.theregister.com/software/2026/04/06/anthropic-closes-door-on-subscription-use-of-openclaw/5222854 ).
- 집행 소식(10/24 이후) [2차]: cellcog(11/14)는 Anthropic 성명이나 이 provider 이용 계정 정지 보도를 찾지 못했다고 기록("부재 증명은 아님"). 이번 조사에서도 10/24 이후 신규 집행 사례를 찾지 못함(미발견).
- 구분 [2차 해석]: shuriken.sh(2026-10-27)는 "플랫폼이 무수정 Claude Code를 호스팅하고 사용자가 자기 구독으로 로그인"은 허용으로 명시, "사용자가 설치·로그인한 Claude Code를 구동하는 앱"은 이름 지어 허용/불허 표기가 없다고 분류: https://shuriken.sh/guides/claude-subscription-in-other-tools
- 함의: [위험(법적 해석), 계획 변경 없음] EG-Desk는 OpenCode와 달리 SDK가 아니라 CLI 프로토콜(stream-json) 구동 + 도구를 MCP로 주입하는 구조이므로 Claude Code 도구를 끄는 OpenCode 방식과는 다름. OpenCode는 "승인 받았다"는 주장에 기대고 있어 선례로 단정하지 말 것. EG-Desk 쪽은 문서의 "무수정 바이너리 + 사용자 자체 로그인 + 호스팅 플랫폼" 예외에 직접 기대는 구조여야 함. 도구 주입(--mcp-config)은 Claude Code가 제공하는 공식 확장 기능이므로 바이너리 수정이 아님. 내장 도구를 EG-Desk가 끄는 것이 "내장 인증 방식 제한"에는 해당하지 않으나, 모호하면 Anthropic sales에 확인(문서가 안내한 문의 경로: https://www.anthropic.com/contact-sales ).

### 4.3 Zed, Cline, 기타
- Zed [검증]: https://zed.dev/docs/ai/external-agents : Claude Agent를 ACP 외부 에이전트로 사용, "Claude Agent가 자체 인증·과금을 소유", Zed Agent에 설정한 API 키는 자동 연동 안 됨, `/login`에서 API 키 또는 가능한 경우 Claude Code로 인증. 함의: 호스트가 인증을 소유하지 않는 모델 = EG-Desk 방침과 동일, 선례로 인용 가능.
- Cline [2차, shuriken 2026-10-24 읽음]: 구독 로그인은 직접 지원하지 않고 API 키 또는 Claude Code를 구동하는 구성. 이번에 Cline 공식 문서는 직접 읽지 못함(미검증).
- Pi, Hermes [2차 everpod 2026-10-23, 11-07 재확인]: Pi는 설치된 Claude Code로 요청을 보내는 확장을 별도 제공하되 "미래 불확실" 경고, Hermes는 Anthropic 로그인이 extra usage로 과금되며 `claude-subscription-directsdk` 플러그인이 있음. https://everpod.ai/guides/claude-subscription-hermes-pi-opencode
- 함의: 변화 없음. 호스팅 제품군의 공통 패턴 = 호스트는 Claude Code가 로그인 소유, 인증 비접촉.

## 5. 판정 표

| # | 발견 | 판정 | EG-Desk 영향 |
|---|---|---|---|
| 1 | cua-driver가 Rust 워크스페이스, 빠른 릴리스, MIT 유지 | 조정(유리) | 포팅 참고가 Rust 코드. 포크/복사 시 버전 고정이 필요(0.5x~0.6x 변동 큼) |
| 2 | cua-driver TCC: 책임 앱 기준, 비서명/재서명 시 grant 무효화, 번들 밖 raw serve 미지원 | 조정 | 도우미를 안정 서명 번들로, 책임 체인을 EG-Desk에 고정, 개발용 안정 자체서명 + tccutil reset 절차 B1 체크리스트화 |
| 3 | cua-driver 텔레메트리 기본 ON(PostHog EU) | 변화 없음 | 직접 사용 안 하므로 영향 없음. 설치본 안내 시 끄기 옵션 문서화 |
| 4 | element_token 전용, get_window_state 간결화, run_script 기본 ON | 조정(설계 참고) | B1 observation API에 스냅샷 한정 토큰, 노드 상한, 실패 사유 코드 반영. run_script류 임의 JS는 도입하지 말 것 |
| 5 | Peekaboo 4.9.10(openclaw org, Developer ID 서명·공증), AXorcist | 변화 없음 | AX 읽기 구현 참고 |
| 6 | Hermes가 cua-driver를 기본 번들 | 변화 없음 | 비공개 SPI는 입력 단계 위험 |
| 7 | Windows-MCP, cua-spacesd | 변화 없음 | B1 범위 밖 |
| 8 | 신규 macOS 드라이버 | 변화 없음 | 검증된 대안 없음 |
| 9 | OpenAI: Settings > Computer use "Any App", Locked use, 허용 앱 설정 위치 이동, Codex Computer Use 안정성 이슈 | 위험/조정 | Codex 허용 앱 파일 읽기 같은 의존 제거, 자체 도구 경유 유지 |
| 10 | Anthropic API: computer_toolset_20260801 (17 멤버, 배치, 좌표 규약) | 조정 | 도구 스키마·좌표 규약 정렬, B1은 입력 멤버 제외 |
| 11 | Claude Code CLI 내장 computer-use MCP (macOS preview, 대화형만, 구독 한도) + Team/Enterprise 베타(11/20) | 위험/조정 | stream-json 호스팅에서 내장 경로 사용 불가 가능성(실측 필요), 이중 경로 차단, UX 선례 인용 |
| 12 | 법무 페이지: 무수정 바이너리 + 사용자 자체 로그인은 호스팅 플랫폼 포함 허용, 자격증명 수집·저장 금지, 통지 없는 집행 | 변화 없음(유지 조건) | 위 4.1 체크리스트(a)~(e) |
| 13 | Agent SDK 문서의 "사전 승인" 문구 + OpenCode의 '승인 받음' 주장 | 위험 | EG-Desk는 SDK 로그인 제공이 아닌 CLI 호스팅 예외 근거로 서야 함. OpenCode를 선례로 단정하지 말 것 |
| 14 | 10/24 이후 신규 집행/밴 보도 | 미발견 | 지속 모니터링 |

## 한계 / 미확인
- Peekaboo·Windows-MCP·cua-spacesd의 LICENSE 원문 재확인 안 함.
- OpenAI 공식 changelog의 10/24 이후 항목, Cline 공식 문서, Anthropic Usage Policy 원문, support.claude.com 호스팅/앱 관련 도움말 개별 문서는 직접 읽지 못함.
- "stream-json 호스팅에서 내장 computer-use가 안 보인다"는 추정이며 실측하지 않음.
- 법무 문구의 변경일은 페이지에 날짜가 없어 10/24 이전/이후 구분 불가.
