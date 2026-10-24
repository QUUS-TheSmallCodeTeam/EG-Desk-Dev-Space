# Agent가 Mac 앱을 다루는 방식 선택 (CU-01~09)

- 작성: 2026-10-24 · 상태: 조사 완료. 실제 화면 제어·입력·권한 요청은 하지 않았다. 대표님 지시대로 OS 전면 입력 검증은 계속 보류 중이다.
- 읽을 사람: 결정할 대표님. 결정이 나면 구현할 Main 개발자.
- 관련 원장 항목: CU-01~09 (`ideas/confirmed/EGDESK_VISION_GAP_LEDGER.md`), 계약 §12·`impl-e24-computer-use` (`ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md`), Atlas CU-01
- 표기
  - **[공식]**: OpenAI·Apple·Anthropic 공식 문서, 또는 설치된 `codex-cli 0.162.1`이 직접 만든 app-server 스키마
  - **[런타임]**: 2026-10-24 live probe에서 실제로 확인한 동작. 범위는 Codex app-server에서 ephemeral thread를 시작하고 다시 읽은 데까지다. turn은 한 번도 실행하지 않았고 Mac 화면 조작도 0회다.
  - **[설치본]**: 이 Mac에 설치된 파일을 읽기만 해서 확인한 것. 실행한 것은 없다.
  - **[제안]**: 이 문서가 권하는 설계. 구현·검증 전이다.
  - **(추정)**: 근거가 간접적인 판단

---

## 1. 결론과 권고

**권고: 한 번에 하나를 고르지 말고 단계를 밟는다. 먼저 끄고 보이게 만든다. 다음에 Codex 내장 기능을 대표님이 지켜보는 상태로 시험한다. 입력권 보장이 필요한 일은 EG-Desk 자체 adapter로 넘긴다.** 선택지로 치면 D → A(감독 모드) → B 순서이고, C(격리 VM)는 기본 경로에서 빼서 위험한 작업과 시험용으로 남긴다.

| 단계 | 하는 일 | 대표님 화면에서 달라지는 점 | 크기 | OS 전면 입력 |
|---|---|---|---|---|
| **1단계 (지금)** — D | EG-Desk 대화에서는 Codex 컴퓨터 조작을 기본으로 끈다. 꺼졌는지 Codex에서 다시 읽어 확인하고, Mac을 조작할 수 있는 외부 도구도 빠짐없이 표시한다. | 설정의 외부 도구 목록에 "컴퓨터 조작 — EG-Desk 대화에서는 꺼짐"이 보인다. 꺼졌는지 확인이 안 되면 그 대화는 시작하지 않고 이유를 보여 준다. 대표님의 Codex 앱·ChatGPT 앱 설정은 바뀌지 않는다. | S~M | 필요 없음 |
| **2단계 (승인 1회 필요)** — A 감독 모드 | 시험용 앱 하나(예: TextEdit 새 문서)에서 Codex 컴퓨터 조작을 대화 단위로 켠다. 그러고 나서 네 가지를 확인한다. ① EG-Desk에서 실제로 동작하는가 ② 무엇이 보이는가 ③ 호출마다 허락을 받을 수 있는가 ④ 중지가 먹는가. 되면 `[관찰]` View(host-activity)에 호출 기록을 띄운다. | `[업무 메뉴 ⋯] → [컴퓨터 사용 범위]`에서 앱을 고르고 `[이 범위에서 시작]`을 누른다. 그러면 Desk 안 관찰 View에서 호출별 화면·상태·`[중지]`가 보인다. | M | **필요** (대표님 결정 Q2) |
| **3단계** — B | EG-Desk 자체 macOS adapter를 만든다. 순서는 관찰 전용(선택 창 캡처 + 접근성 읽기) → 접근성 행동 → 좌표 입력이다. 입력권(lease)·긴급 중지 키·감시 프로세스를 EG-Desk가 직접 갖는다. | 관찰 View의 `[직접 입력]`·`[Agent에게 돌려주기]`·`[모든 Agent 입력 긴급 중지]`가 실제로 동작한다. Claude 엔진에서도 같은 화면으로 쓴다. | XL | 입력 단계부터 필요 |

**지금 1단계부터 해야 하는 이유.** EG-Desk 일반 대화에는 이미 Codex 컴퓨터 조작 도구가 붙어 있다. 대표님이 고른 적은 없다.
- 사용자 Codex 설정을 그대로 물려받은 thread는 `computer_use` 기능이 켜져 있고, `unified-computer-use` 플러그인의 `cua_repl` 서버도 도구 3개로 연결된다. 도구 설명은 사용자 컴퓨터의 네이티브 앱이나 브라우저를 조작한다는 내용이다. [런타임]
- EG-Desk가 이 호출을 막는 것은 Agent 도구 한도의 브라우저 축을 "안 함/보기만"으로 정했을 때와 QA thread뿐이다(`9ce901c`). [조사: `helper/codex-chat-tool-ceiling.mjs:119-156`]
- 이 도구가 EG-Desk 실행 경로에서 실제로 Mac을 움직이는지는 아직 모른다(미확인 U1). 그래도 모델에게는 이미 보인다.
- Chat에는 "cua_repl / js" 한 줄만 남는다. 무엇을 했는지, 어디까지 멈췄는지는 보이지 않는다. [조사: `helper/codex-chat-runtime.mjs:73-77, 2118-2121`]

**A만으로 끝내지 않는 이유.**
1. EG-Desk가 끼어들 수 있는 단위가 JavaScript 호출(`cua_repl.js`) 한 번이다. 호출 하나에 여러 클릭·입력이 들어갈 수 있다(추정). 그 사이에 입력권을 확인하거나 사람 입력을 감지해 양보할 연결점은 없다(3장).
2. 중지는 "turn을 멈춰 달라"는 요청까지만 확인된다. 이미 보낸 입력이 취소되는지는 OpenAI 네이티브 쪽 빈칸으로 남아 있다(REA N-05~07, 미확인 U5).
3. 공식 문서가 밝힌 지원 화면은 ChatGPT 데스크톱 앱과 Codex 앱이다. app-server나 서드파티 클라이언트는 언급이 없다. [공식] 서비스 앱은 alpha 채널에서 자동 업데이트된다. [설치본] 동작이 예고 없이 바뀔 수 있고 외부 배포에는 쓸 수 없다고 가정한다.

**B부터 하지 않는 이유.** 크기가 XL이다. EG-Desk가 화면 기록·손쉬운 사용·입력 모니터링 권한을 새로 받아야 한다. 입력 단계는 OS 전면 입력 시험 없이는 검증할 수 없는데, 그 시험은 지금 보류 중이다.

**원장의 기존 권고와 다른 점.** 원장은 "격리 실행(가상 디스플레이·VM) 우선"으로 적어 두었다. 이 문서는 VM을 기본 경로에서 뺐다. 이유는 셋이다.
- 대표님이 원하는 것은 "내 Mac 앱"(내 파일·내 로그인)을 다루는 일이다. VM 안에는 그것들이 없다.
- 16GB Mac에서 macOS VM을 상시로 띄우는 것은 부담이 크다.
- 계약 §12도 대안을 열어 둔다. "사용자가 active desktop을 명시적으로 넘기는 경우"다. 2단계에서 대화를 켜고 앱 범위를 정하는 동작이 바로 그 명시적 인계(handoff)에 해당한다. [제안]

---

## 2. 지금 확인된 사실

### 2.1 이 Mac에 설치된 것 [설치본]

| 항목 | 확인한 내용 | 뜻 |
|---|---|---|
| `~/.codex/computer-use/Codex Computer Use.app` | 번들 id `com.openai.sky.CUAService`, 표시명 "ChatGPT Computer Use", 버전 26.1015.1001540, `LSUIElement=true`(Dock에 안 보이는 배경 앱), 실행 파일 `SkyComputerUseService`(25MB) | OpenAI의 네이티브 조작 서비스 |
| 같은 앱의 업데이트 설정 | `SUFeedURL` 경로에 `cua/alpha`, `SUAutomaticallyUpdate=true` | alpha 채널 자동 업데이트. 우리가 버전을 고정할 수 없다 |
| 내부 보조 앱 3개 | `SkyComputerUseClient`(`…CUAService.cli`), `CUALockScreenGuardian`(`…guardian`), `Codex Computer Use Installer`(`…AuthorizationPluginInstaller`) | 공식 문서의 "잠긴 화면 사용 시 macOS 인증 플러그인 설치" 설명과 이름이 맞는다(추정) |
| `Info.plist` 권한 설명 문자열 | 연락처·캘린더·Apple Events만 있다. 화면 기록·손쉬운 사용 문자열은 없다 | 두 권한이 필요하다는 것은 공식 문서에 근거한다(2.4) |
| `computer-use/config.json` | locale `ko-KR`, 화면 문구 키 `usingComputer`("ChatGPT is using your computer"), `escToCancel`("Esc to cancel") | OpenAI 서비스가 자체 "사용 중" 표시와 Esc 취소를 가진 것으로 보인다. 실제로 뜨는지는 확인하지 않았다 |
| `computer-use/sessions/*.toml` 2개 | `[apps] allowed` 목록(각 1개) | 앱별 허용 기록이 OpenAI 쪽 파일에 남는다 |
| 플러그인 `~/.codex/plugins/cache/openai-bundled/unified-computer-use/26.1016.62342` | `.mcp.json`: 서버 `cua_repl`, 노출 도구 `js`·`js_reset`·`turn_ended`. 실행 파일은 `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node`와 `@oai/cua-repl`. 환경 변수 `BROWSER_USE_ACCESS_EXECUTOR_ID`·`…_PIPE_PATH`·`…_VERIFYING_IDENTITY`는 부모 프로세스에서 넘겨받는다. `CUA_REPL_ENABLED_SURFACES=browser,computer`, `SKY_CUA_SERVICE_PATH`는 위 서비스 앱을 가리킨다 | ChatGPT 앱이 설치되어 있어야 돌아간다. 한 서버가 브라우저 조작과 Mac 앱 조작을 함께 맡는다 |
| 같은 플러그인 `plugin.json` | 훅이 있다. Codex의 `Interrupt`·`Stop`·`SubagentStop` 때 `cua_repl.turn_ended`를 부른다 | EG-Desk가 turn을 중지하면 Codex가 이 훅을 부를 것으로 보인다(3장 연결점 5) |
| `@oai/cua-repl` 0.1.2 README·지침 | `js`는 `cua` API를 쓰는 JavaScript를 실행한다. 앱은 이름·번들 id·경로로 고른다. 기존 승인·권한 설정을 물려받는다. computer를 끄면 "Native computer APIs are disabled." 지침이 붙는다 | 호출 하나가 JS 코드 한 덩어리다 |
| `/Applications/ChatGPT.app` | 번들 id `com.openai.codex`, 26.1016.62342 | 플러그인 버전과 같다 |
| `~/.codex/config.toml`(EG-Desk가 물려받는 설정) | `notify`가 `SkyComputerUseClient turn-ended`를 호출한다. 직접 등록한 MCP `node_repl`(cua_node + `SKY_CUA_SERVICE_PATH`)과 `computer-use`(`SkyComputerUseClient`)가 있다. `approval_policy="never"`, `sandbox_mode="danger-full-access"`. `playwright-electron`의 두 도구는 `approval_mode="approve"` | Mac을 조작할 수 있는 길이 플러그인 외에 두 개 더 있다 |
| 기기 | Apple M5, RAM 16GB, macOS 26.6.2. VM 소프트웨어는 설치되어 있지 않다 | C 선택지의 RAM 부담 판단에 쓴다 |

### 2.2 Codex app-server에서 확인한 것 [런타임]

조건: `codex-cli 0.162.1`, ephemeral thread 시작과 readback만 했다. turn은 0회다.
근거 파일: probe 결과 `live-config-probe/result2.json`, `result3.json`, `live-config-probe2/result.json`(세션 scratchpad).

| thread 시작 설정 | `cua_repl` | `computer-use` 서버 | `node_repl`·`playwright-electron`·`firefox-devtools` | 기능 readback |
|---|---|---|---|---|
| 설정을 바꾸지 않음(사용자 설정 상속) | 연결됨, 도구 3개 | 도구 0 | 연결됨 | `computer_use`·`browser_use`·`browser_use_external` 모두 true |
| `features.computer_use=false`만 | **여전히 연결됨** | 꺼짐(disabled) | 연결됨 | computer_use false |
| 위 + `plugins."unified-computer-use@openai-bundled".enabled=false` | **없음** | 꺼짐 | **연결됨** | false |
| QA thread(플러그인·기능·직접 MCP 전부 끔) | 없음 | 꺼짐 | 꺼짐 | false, 외부 도구 목록 비어 있음 |

정리하면 이렇다.
- `computer_use` 기능 스위치만으로는 플러그인 서버가 꺼지지 않는다. 플러그인 스위치를 함께 꺼야 한다.
- 직접 등록한 `node_repl`은 브라우저 한도로는 꺼지지 않는다.
- `cua_repl`이 "연결됨"이라는 것은 서버가 떴다는 뜻일 뿐이다. 실제 Mac 조작이 되는지는 별개다(U1).
- MCP 서버 시작 알림(`mcpServer/startupStatus/updated`)이 thread id마다 온다. 대화마다 서버 프로세스가 따로 뜨는 것으로 보인다(추정, U14).

### 2.3 EG-Desk 코드 현황 [조사]

- **활동 표시**: `mcpToolCall`에서 server·tool·status·durationMs만 남긴다. arguments(JS 코드)와 result는 버린다. `helper/codex-chat-runtime.mjs:73-77, 2118-2121`
- **승인 처리**: EG-Desk가 받는 요청은 명령 실행·파일 변경 승인과 Agent 질문(`item/tool/requestUserInput`, CHAT-12)이다. 그 밖의 요청은 `-32601`로 거절하고 run을 `UNSUPPORTED_INTERACTION`으로 끝낸다. 예를 들어 `mcpServer/elicitation/request`가 오면 이렇게 되어, 모르는 승인은 허락하지 않는 쪽으로 닫힌다. `helper/codex-chat-runtime.mjs:1680-1705, 1854-1870`
- **도구 한도**: Agent의 브라우저 축이 "안 함/보기만"일 때만 브라우저·데스크톱을 조작하는 플러그인 서버를 끈다. 일반 대화는 `ordinaryThreadConfig()`만 거치므로 `cua_repl`이 켜진 채다. `helper/codex-chat-tool-ceiling.mjs:112-156`, `helper/codex-chat-runtime.mjs:1203-1210`
- **외부 도구 분류**: `cua_repl`과 `computer-use`는 "desktop"으로 분류한다. `node_repl`은 이름 때문에 "repl"로 분류된다. 그래서 Sky 서비스 경로가 설정돼 있어도 "외부 브라우저·컴퓨터 조작 도구가 남아 있음" 안내에서 빠진다. `helper/codex-inherited-mcp.mjs:20-30`
- **없는 것**: host-activity View, Desk 밖용 입력권, 창 캡처, 긴급 중지 키, 감시 프로세스. 원장 CU-01~05에 적힌 대로 코드는 0건이다.
- **재사용할 수 있는 것**
  - 브라우저 카드 lease와 행동 직전 재확인: `browserToolAuthorizePhysicalAction`(`overlay/JS/eg-desk-surface.uc.js`)
  - Desk Window 껍데기: `spawnDeskWindowShell`(`eg-desk-surface.uc.js:9168`)
  - thread 기능·MCP readback: `readNativeThreadFeatures`, `verifyCeilingNativeThread`
  - 동적 도구(`item/tool/call`) 실행 경로: B에서 EG-Desk가 직접 도구를 제공할 때 그대로 쓴다

### 2.4 공식 문서가 말하는 것 [공식]

**OpenAI Computer Use** — [learn.chatgpt.com/docs/computer-use](https://learn.chatgpt.com/docs/computer-use) (developers.openai.com/codex/app/computer-use에서 리다이렉트)
- 지원 범위
  - macOS·Windows, 지원 지역에서 쓸 수 있다.
  - 지원 화면은 ChatGPT 데스크톱 앱(Work)과 Codex다. CLI·app-server·서드파티 클라이언트는 언급이 없다.
- 설정
  - 플러그인을 설치한다.
  - macOS는 "Codex Computer Use" 앱에 화면 기록 권한과 손쉬운 사용 권한을 준다.
- 앱 승인
  - 작업 중 앱을 처음 쓸 때마다 묻는다. "Always allow"를 고르면 다음부터 묻지 않는다.
- 자동화할 수 없는 것: 터미널 앱, ChatGPT 자신, 관리자 인증, OS 보안 권한 프롬프트 승인
- 실행 방식
  - macOS는 범위가 정해진 작업을 백그라운드에서 실행할 수 있다.
  - Windows는 활성 데스크톱 전면에서 포인터와 키보드를 가져간다.
- 잠긴 화면 사용(macOS, 선택)
  - 켜면 인증 플러그인을 설치한다.
  - 로컬에서 키보드·포인터 입력이 감지되면 다시 잠근다.
- 중지
  - 언제든 중지하거나 직접 조작으로 넘어올 수 있다고만 적혀 있다.
  - 특정 단축키는 문서에 없다.

**관리 정책** — [learn.chatgpt.com/docs/enterprise/chatgpt-work-local-security](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-local-security)
- `requirements.toml`의 `features.computer_use = false`로 네이티브 Computer Use를 끈다. 같은 파일에 `allow_appshots`, `computer_use.allow_locked_computer_use` 키도 있다.
- 스크린샷·도구 결과는 작업 맥락으로 OpenAI 서비스에 보내질 수 있다.

**설정 키** — [config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- 플러그인과 그 안의 MCP 서버
  - `plugins.<plugin>.enabled`
  - `plugins.<plugin>.mcp_servers.<server>.enabled` / `enabled_tools` / `disabled_tools`
  - `plugins.<plugin>.mcp_servers.<server>.tools.<tool>.approval_mode`
- 승인 모드 값은 `auto | prompt | writes | approve`다. 각 값의 뜻은 페이지에 정의되어 있지 않다.
- 앱 접근 범위
  - `computer_use.default_app_access`(`allow | deny`)
  - `computer_use.macos.bundle_ids`(번들 id별 `allow | deny`)

**App-server 프로토콜** — [learn.chatgpt.com/docs/app-server](https://learn.chatgpt.com/docs/app-server), 그리고 설치본 `codex app-server generate-json-schema`로 같은 내용을 확인했다.
- `mcpToolCall` 항목 필드: `{id, server, tool, status, arguments, appContext?, pluginId?, result?, error?}`. 설치본 스키마에는 `readOnlyHint`, `durationMs`도 있다.
- 진행 알림 `item/mcpToolCall/progress`가 있다.
- 커넥터(App) 도구 호출의 승인
  - `tool/requestUserInput`으로 올 수 있다.
  - 파괴적 도구 표시(annotation)가 있으면 항상 승인을 요구한다.
  - 거절하면 그 `mcpToolCall`은 도구를 실행하지 않고 오류로 끝난다.
  - 플러그인 MCP 도구도 같은 흐름인지는 문서에 없다.
- `mcpServer/elicitation/request`: MCP 서버가 turn 도중 입력이나 확인을 요청하는 요청
- `hook/started`·`hook/completed`: 동기 훅에서만 나온다.
- `turn/interrupt`: 성공하면 turn이 `interrupted`로 끝난다. 진행 중이던 도구 호출이 어떻게 되는지는 문서에 없다.
- `mcpServer/tool/call`: 클라이언트가 thread의 MCP 도구를 직접 부르는 요청이다.

**Anthropic computer use**(비교용) — [platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- 클라이언트 실행 도구다. 앱이 모든 행동을 실행하고 스크린샷을 돌려준다. B와 같은 구조라서 Claude 엔진을 붙일 때 B는 그대로 쓸 수 있다.
- 권장 사항
  - 권한을 최소화한 전용 VM·컨테이너에서 돌린다.
  - 민감 정보를 주지 않는다.
  - 도메인 허용 목록을 쓴다.
  - 중요한 결정은 사람이 확인한다.

**Apple API**(B·C의 재료)
- [`SCContentFilter`](https://developer.apple.com/documentation/screencapturekit/sccontentfilter): `init(desktopIndependentWindow:)`로 창 하나만 캡처한다. macOS 12.3+.
- [`CGRequestScreenCaptureAccess`](https://developer.apple.com/documentation/coregraphics/cgrequestscreencaptureaccess()): 화면 기록 권한을 요청한다. macOS 10.15+.
- [`AXIsProcessTrustedWithOptions`](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions): 손쉬운 사용 신뢰 여부를 묻는다. `kAXTrustedCheckOptionPrompt`를 주면 시스템이 안내를 띄운다.
- [`CGEvent.postToPid`](https://developer.apple.com/documentation/coregraphics/cgevent/posttopid(_:)): 특정 프로세스에 이벤트를 보낸다. macOS 10.11+.
- [macOS VM](https://developer.apple.com/documentation/virtualization/running-macos-in-a-virtual-machine-on-apple-silicon)
  - Apple silicon과 restore image가 필요하다. CPU·메모리는 이미지가 정한 최소값 이상이어야 한다.
  - Mac 한 대에 추가 macOS VM은 2개까지다. 이는 라이선스 §2B(iii)에 대한 제3자 요약([eclecticlight](https://eclecticlight.co/2022/08/04/virtualisation-on-apple-silicon-macs-8-how-apple-limits-vms/))에 근거한다.

**이전 정적 분석에서 이어받는 원칙** — [computer-use-browser-control-rea.md](./computer-use-browser-control-rea.md)(기존 산출물)
- **EG-01**: 결과 미확정과 실패를 구분한다.
- **EG-02**: 입력 직전에 대상을 다시 확인한다.
- **EG-03**: 표시와 효과를 따로 검증한다.
- **EG-04**: Stop은 층위를 나눈다. 상위 중지 / lease 무효화 / 새 입력 차단 / 이미 보낸 입력의 최종 수신은 서로 다르다.
- 네이티브 쪽 사실
  - PID로 입력을 보내고 앞 앱으로 포커스를 되돌리는 경로가 있다(N-01·N-02).
  - Stop 뒤 대기 입력이 취소되는지는 미확인이다(N-05~07).

---

## 3. A의 연결점: EG-Desk가 Codex 컴퓨터 조작을 보고 멈출 수 있는가

| # | 연결점 | EG-Desk가 할 수 있는 일 | 근거 | 상태 |
|---|---|---|---|---|
| 1 | thread 시작 설정: `plugins.<id>.enabled`, `features.computer_use`, `mcp_servers.<name>.enabled` | 대화별로 켜기·끄기. 시작 직후 `experimentalFeature/list(threadId)`와 `mcpServerStatus/list`로 다시 읽어, 꺼졌는지 확인되지 않으면 turn을 시작하지 않는다 | 2.2 표, `9ce901c` | **[런타임] 확인** |
| 2 | 앱 범위: `computer_use.default_app_access="deny"` + `computer_use.macos.bundle_ids` | 허용한 앱(예: `com.apple.TextEdit`)만 조작하게 제한 | 설정 키 문서 | [공식] 키는 있다. thread별로 넘긴 값이 별도 프로세스인 Sky 서비스에 반영되는지는 **미확인**(U4) |
| 3 | 호출 전 승인: `plugins."unified-computer-use@openai-bundled".mcp_servers.cua_repl.tools.js.approval_mode` | `js` 호출마다 대표님 허락을 받는 관문 | 설정 키 문서 | [공식] 키는 있다. 어떤 요청으로 오는지(`tool/requestUserInput`? elicitation?), `approval_policy="never"`와 어떻게 맞물리는지는 **미확인**(U3). 지금 EG-Desk는 elicitation이 오면 거절하고(안전), requestUserInput이 오면 Agent 질문 카드로 보여 준다(승인인 줄 모르고 답할 위험, U15) |
| 4 | 관찰: `item/started`·`item/completed`의 `mcpToolCall`(server=`cua_repl`, tool=`js`, `arguments`=JS 코드, `result`, `pluginId`) + `item/mcpToolCall/progress` | 호출별 타임라인: 무엇을 하려 했는지(코드), 결과(텍스트·이미지 추정), 걸린 시간, 실패 | 프로토콜 문서·설치본 스키마 | [공식] 필드는 있다. `cua_repl`이 실제로 무엇을 담아 보내는지는 **미확인**(U2). 단위는 호출 1회다. 그 안의 개별 클릭은 보이지 않는다(추정) |
| 5 | 중지: `turn/interrupt` → Codex `Interrupt` 훅 → `cua_repl.turn_ended`, 그리고 `hook/started`·`hook/completed`로 실행 여부 관찰 | Chat `[중지]`를 누르면 OpenAI 쪽 정리 신호까지 간 것을 확인 | `plugin.json` [설치본], 프로토콜 [공식] | 진행 중 `js` 호출이 멈추는지, 이미 보낸 입력의 최종 효과는 **미확인**(U5). 화면 표시는 EG-04대로 "중지 요청됨 / 중지 확인됨 / 이미 보낸 입력은 취소로 표시하지 않음"으로 나눈다 |
| 6 | 직접 호출: `mcpServer/tool/call`로 `cua_repl.js_reset`·`turn_ended` | 중지 보조 수단 | 프로토콜 [공식] | [제안]. 효과는 미확인이다 |
| 7 | OpenAI 자체 표시와 취소: "ChatGPT is using your computer", "Esc to cancel" | 대표님이 Mac 화면에서 바로 취소 | `config.json` [설치본] | EG-Desk 경로에서도 뜨는지 **미확인**(U6) |
| 8 | 입력권(lease)·사람 입력 감지·긴급 중지 키·감시 프로세스 | — | — | **연결점 없음.** OpenAI 서비스의 입력 경로 중간에 EG-Desk가 끼어들 방법이 없다. EG-Desk가 할 수 있는 것은 "다음 호출 거절"과 "turn 중지 요청"까지다. [분석] |

**판정.**
- A로 할 수 있을 가능성이 있는 것: 보이기(4), 호출 단위 허락(3), 중지 요청(5).
- A로는 할 수 없는 것: 계약 §12·`impl-e24`가 요구하는 입력권 보장, 사람 입력과 겹치지 않음, 긴급 중지 후 추가 입력 0.
- 그래서 A는 "감독 모드"로만 쓴다. 대표님이 화면을 보고 있고 허용 앱이 하나일 때다. 보장이 필요한 일은 B로 넘긴다.

---

## 4. 선택지 비교

| 기준 | **A** Codex 내장 기능 + EG-Desk 표시·중지 | **B** EG-Desk 자체 macOS adapter | **C** 격리 실행 우선 | **D** 지금은 끔 |
|---|---|---|---|---|
| 안전성 | 중간. OpenAI의 앱별 승인·Esc 취소가 있다(공식·설치본). EG-Desk는 호출 단위 거절과 turn 중지 요청만 한다. 입력과 입력 사이의 차단·긴급 키·감시 프로세스는 없다 | 높음(설계상). 계약 순서 identity→권한→lease→관찰 revision→전제 검사→입력→readback과 장애 시 입력 차단(fail-closed)을 EG-Desk가 갖는다. 실제 안전성은 구현 품질에 달려 있다 | 가장 높음. 대표님 데스크톱과 분리된다. 다만 내 앱·파일·로그인이 VM 밖에 있다 | 가장 높음. 조작 자체가 없다 |
| 가시성 | 호출 1회 단위: 코드·결과·상태·시간. 포인터 표시는 OpenAI 오버레이가 한다. 실제 내용은 미확인 | 행동 1개 단위: 대상 창 캡처, 접근성 요소, 입력 좌표, 결과 다시 읽기를 모두 EG-Desk가 만든다 | VM 화면 전체를 Desk로 보낼 수 있다(추가 구현 필요) | 꺼져 있음을 readback으로 확인해 표시한다 |
| 제어권 | 대화 켜기·끄기, 허용 앱 목록(반영 미확인), 호출 승인(미확인), turn 중지 요청 | 입력권 확보·양보·회수, 긴급 중지 키, 사람 입력 감지 시 양보, 대상 재확인 | VM 단위 정지·스냅샷, 내 데스크톱 인계 대화상자 | 해당 없음 |
| 검증 가능성 | 낮음~중간. 내부가 독점 바이너리이고 alpha 채널로 자동 업데이트된다. EG-Desk 이벤트 단위로만 시험할 수 있다 | 높음. 소유 fixture로 단위·headless 시험을 할 수 있다. 입력 단계는 OS 전면 입력 시험이 필수다(보류 중) | 중간. VM 안 시험은 대표님 데스크톱에 영향 없이 반복할 수 있다 | 높음. readback 검증 패턴이 이미 있다(`9ce901c`) |
| RAM (16GB) | 대화마다 `cua_repl` Node 프로세스(추정) + Sky 서비스. 측정하지 않았다(실행 중이 아니었다) | helper 1개 + 창 캡처 버퍼. 측정하지 않았다. 창 단위로 캡처하면 작게 유지할 수 있다(추정) | macOS VM이 수 GB를 상시로 쓴다(추정. Apple은 이미지 최소값을 요구). 가장 크다 | 오히려 줄어든다. 대화마다 `cua_repl` 프로세스가 뜨지 않는다(추정) |
| 의존성 | `/Applications/ChatGPT.app`(cua_node), `Codex Computer Use.app`, ChatGPT 요금제, Codex 0.162.x 설정 키 | Apple 공개 API만 쓴다. Swift helper(또는 helper-rust) 빌드·서명이 필요하다 | Virtualization.framework, VM 이미지(예시 디스크 128GB), VM 안 재로그인 | 없음 |
| 정책 | 공식 지원 화면은 ChatGPT 앱·Codex 앱이다. app-server·서드파티는 언급이 없다. 개인 사용은 대표님 설치본으로 하고, 외부 배포는 불가로 가정한다(Claude 연결 결정 (b)와 같은 성격) | EG-Desk가 TCC 권한 3종(화면 기록·손쉬운 사용·입력 모니터링)을 직접 받는다. 사용자 고지가 필요하다 | Mac당 추가 macOS VM 2개(제3자 요약) | 없음 |
| 엔진 | Codex 전용 | Codex·Claude 공통 | A·B와 조합해서 쓴다 | — |
| Windows (CU-09) | 공식 Windows 버전은 전면에서 포인터를 가져간다. 계약과 충돌한다 | OS별 구현을 따로 만든다 | Windows VM 권장(공식 문서도 VM을 언급) | — |
| 크기 | 감독 모드 M | XL (관찰 전용은 L) | XL | S~M |
| OS 전면 입력 시험 | 감독 모드부터 필요 | 입력 단계부터 필요 | VM 안이면 대표님 데스크톱 시험은 불필요 | 불필요 |

---

## 5. 대표님 결정 질문

**Q1. EG-Desk 일반 대화의 Codex 컴퓨터 조작 (지금은 켜져 있음)**
- (가) **기본 끔. 2단계부터 대화에서 켤 때만 쓴다** ← 권고
- (나) 완전히 끔. 다시 결정할 때까지 켜는 방법을 만들지 않는다.
- (다) 지금처럼 켜 두고 표시만 추가한다.

> **결정 (2026-10-24, 대표님): (다).** EG-Desk 일반 대화의 Codex 컴퓨터 조작은 지금처럼 켜 둔다(`DEFAULT_COMPUTER_CONTROL_POLICY = 'inherit'` 유지). 끄기 스위치(`7ddb434`·`a7c66cc`)는 설정의 선택지로만 남기고, 실제 호출이 대화와 활동 기록에서 보이도록 표시를 보강한다. Q2~Q4는 아직 결정 전이다.

**Q2. OS 전면 입력 보류를 시험 1회만 풀지**
- (가) **시험용 앱 하나(TextEdit 새 문서)에서 Codex 컴퓨터 조작을 1회 시험한다** ← 권고
  - 대표님이 화면을 지켜보는 상태에서 하고, Esc와 Chat `[중지]`를 준비해 둔다.
  - 결과는 7장의 확인표로 남긴다.
- (나) 계속 보류한다. 1단계만 하고 멈춘다.

**Q3. 장기 방향**
- (가) **단계적으로 간다** ← 권고
  - Codex 내장 기능을 감독 모드로 먼저 쓴다.
  - 입력권 보장이 필요한 일은 EG-Desk 자체 adapter로 옮긴다.
- (나) 처음부터 자체 adapter만 만든다. Claude에서도 동작하지만 XL이고 권한 3종을 새로 받는다.
- (다) Codex 내장 기능만 쓴다. 입력권·긴급 중지 보장은 포기한다.

**Q4. 격리 실행(VM)**
- (가) **기본으로 쓰지 않는다. 위험한 작업과 시험용으로 나중에 추가한다** ← 권고
- (나) 처음부터 VM 안에서만 한다.
  - 16GB에서 수 GB를 상시로 쓴다.
  - 내 앱·로그인을 VM에 다시 설정해야 한다.

---

## 6. 1단계 구현 범위 (Main 개발자용) [제안]

**목표**
- EG-Desk 대화에서는 Codex 컴퓨터 조작이 기본으로 꺼진다.
- 꺼졌다는 것을 Codex에서 다시 읽어 확인하고, Mac을 조작할 수 있는 외부 도구를 빠짐없이 보여 준다.
- 다음은 하지 않는다: OS 입력, 새 권한 요청, 사용자 `~/.codex/config.toml` 수정. 모든 변경은 thread 시작 설정으로만 한다.

**helper**
- `helper/codex-chat-execution-policy.mjs`
  - `computerControlOffConfig(servers, directDecls)`를 추가한다. `mcpServerStatus/list`의 `pluginId`로 판단한다.
  - 끄는 대상
    - 데스크톱·브라우저를 조작하는 플러그인 서버 전체: `plugins[id].enabled=false`. `cua_repl` 하나가 browser·computer를 함께 맡으므로 Codex 자체 Chrome 조작도 같이 꺼진다. EG-Desk 브라우저 카드는 자체 동적 도구라서 영향이 없다.
    - `NATIVE_COMPUTER_FEATURES` 세 가지: false
    - desktop으로 분류된 직접 등록 MCP: `mcp_servers[name].enabled=false`
- `helper/codex-inherited-mcp.mjs`
  - 직접 등록 MCP 선언(`config/read`)에 다음 신호 중 하나가 있으면 이름과 상관없이 "desktop"으로 분류한다: `SKY_CUA_SERVICE_PATH` 환경 변수, `cua_node` 실행 경로, `SkyComputerUseClient` 실행 경로.
  - 지금 `node_repl`이 "repl"로 빠지는 문제를 고친다.
- `helper/codex-chat-runtime.mjs`
  - 일반 대화 경로: `ordinaryThreadConfig()`(L129)에 위 설정을 병합한다. 이 함수는 thread 시작(L1207)과 재개(L1363)가 함께 쓴다. 복원 경로(L1194-1198)도 같은 설정을 받는지 함께 맞춘다.
  - 시작 직후 확인
    - `verifyCeilingNativeThread`와 같은 방식으로 플러그인 서버 부재와 세 기능 false를 다시 읽는다.
    - 어긋나면 새 오류 코드 `COMPUTER_CONTROL_UNVERIFIED`로 turn을 시작하지 않는다.
    - 기능 목록을 못 주는 구버전이면 그 검사만 건너뛰고 notice로 기록한다(`9ce901c`와 같은 규칙).
  - `run.started`에 `computerControl: 'off'`를 싣는다. notice 키는 `computer-control-off`이고, 대화당 한 번 낸다.
  - `mcpToolCall` 표시(L73-77, L2118-2121)
    - `pluginId`를 내부 판정에만 쓰고, `nativeMcpServerKind`로 `controlKind`(desktop/browser/…)를 붙인다.
    - desktop 호출이면 활동 제목을 "컴퓨터 조작"으로 바꾼다.
    - arguments·result 원문과 이미지는 아직 저장하지 않는다. 길이와 이미지 개수만 남긴다. 저장 범위는 2단계에서 privacy 경계와 함께 정한다.
  - 승인 요청
    - `mcpServer/elicitation/request`는 지금처럼 거절하고 run을 끝낸다.
    - 이때 활동에 "Codex 외부 도구가 허락을 요청해 거절했습니다"를 남겨 원인이 보이게 한다. 기존 -32601 경로에 문구만 더한다.

**overlay**
- `overlay/JS/eg-desk-surface.uc.js`
  - 설정 > 외부 도구 목록(L11675 부근)
    - desktop 줄에 "컴퓨터 조작" 표시를 붙인다.
    - 상태는 "EG-Desk 대화에서는 꺼짐"으로 쓴다. Codex 앱에서는 여전히 쓸 수 있다는 한 줄을 덧붙인다.
  - Chat 활동 행: desktop 호출은 "컴퓨터 조작" 이름으로 표시한다. `[관찰]` 버튼은 2단계까지 만들지 않는다.
  - Agent 관리 탭의 도구 한도: 축을 아직 추가하지 않는다. "컴퓨터 조작: 꺼짐(EG-Desk 기본)"을 읽기 전용으로 표시한다.

**이벤트·데이터**
- 새 저장 필드는 run 기록의 `computerControl` 하나다. 활동 detail에는 `controlKind`, `argumentsLength`, `resultImageCount`만 둔다.

**검증**
- helper 단위
  - 설정 생성(플러그인·기능·직접 MCP)
  - readback 불일치 시 거절
  - 구버전 skip notice
  - `node_repl` 분류
- 중앙 회귀
- headless UI: 설정 목록의 "컴퓨터 조작" 줄
- live 확인
  - probe2와 같은 방식으로 ephemeral thread 시작과 readback만 한다. turn은 0회, OS 입력도 0회다.
  - 보류 지시 안에서 할 수 있다.

**하지 않는 것**
- 켜기 스위치. 대화에서 켜는 기능은 Q2 승인 후 2단계에서 만든다.
- host-activity View, 창 캡처, lease

---

## 7. 2단계 시험 계획 (Q2 승인 시) [제안]

**시험 대화에만 넘길 설정**
- 플러그인을 켠다. `computer_use=true`
- `computer_use.default_app_access="deny"`, `computer_use.macos.bundle_ids={"com.apple.TextEdit"="allow"}`
- `cua_repl.tools.js.approval_mode="prompt"`

**작업**: "TextEdit 새 문서에 '시험' 한 줄을 입력하고 ~/…/fixture.txt로 저장"

**확인표**

| 확인 | 통과 기준 | 실패하면 |
|---|---|---|
| U1 EG-Desk 경로에서 실제로 조작되는가 | 독립 확인으로 파일 내용이 '시험'이다. 파일을 다시 읽어 확인하고, 입력 로그는 증거로 쓰지 않는다 | A를 포기하고 3단계 B로 간다 |
| U2 무엇이 보이는가 | `arguments`·`result` 형태와 크기, 이미지 포함 여부를 기록한다 | 관찰 View 설계를 바꾼다 |
| U3 호출 전 허락 | 첫 `js` 전에 어떤 요청이 오는지, 거절하면 도구가 실행되지 않는지 | 승인 관문이 없으면 감독 모드는 "대표님이 지켜볼 때만"으로 더 좁힌다 |
| U4 앱 범위 | 허용 안 한 앱(예: Notes)을 요청하면 거절되는지 | 범위 제한을 EG-Desk 지시문에만 의존하지 않는다. 범위 밖 호출이 보이면 즉시 중지한다 |
| U5·U6 중지 | 입력 도중 Chat `[중지]`를 누른다. `turn/interrupt` → `hook/completed`(turn_ended) → 이후 TextEdit 변화 0을 같은 시계로 기록한다. Esc 오버레이가 뜨는지도 본다 | 중지 후 변화가 있으면 감독 모드를 막고 B로 간다 |
| RAM | 시험 중 `cua_repl` Node와 Sky 서비스의 메모리를 기록한다 | — |

**통과 시 붙일 화면**
- 관찰 View: `kind:'host-activity'`, `spawnDeskWindowShell`을 재사용한다.
- 보여 줄 것
  - "현재 제어자: Codex 컴퓨터 조작(OpenAI)"
  - 허용 앱
  - 호출 타임라인(코드 요약·결과 화면·상태)
- 버튼
  - `[중지]`
  - `[결과 확인]`: 입력 재생이 아니라 파일·앱 상태를 독립으로 다시 읽는다.
- `[직접 입력]`·`[Agent에게 돌려주기]`·긴급 중지 키는 A에서는 만들 수 없다. 화면에 "자체 adapter에서 제공"으로 비활성 표시한다.

---

## 8. 미확인 목록

| ID | 무엇 | 왜 중요한가 | 확인 방법 |
|---|---|---|---|
| U1 | EG-Desk app-server에서 `cua_repl.js`가 실제로 Mac 앱을 조작하는지. EG-Desk 실행 환경에는 `BROWSER_USE_ACCESS_*` 변수가 없다 | A 전체의 전제(CU-06 핵심) | 7장 시험 |
| U2 | `cua_repl` 호출의 arguments·result 실제 형태와 크기 | 관찰 View·저장 범위·RAM | 7장 시험 |
| U3 | 플러그인 MCP 도구의 `approval_mode="prompt"`가 어떤 요청으로 오는지, `approval_policy="never"`와의 관계, 값의 뜻. 사용자 설정의 `approve` 기록은 "항상 허용" 저장일 가능성이 있다(추정) | 호출 전 관문이 있는지 | 7장 시험 + Codex 문서 재확인 |
| U4 | thread 설정의 `computer_use.macos.bundle_ids`가 Sky 서비스에 반영되는지 | 앱 범위 제한 | 7장 시험 |
| U5 | `turn/interrupt` 뒤 진행 중 `js`와 이미 보낸 입력의 최종 효과 | 중지 보장(EG-04, REA P2와 같은 빈칸) | 7장 시험(같은 시계 기록) |
| U6 | OpenAI "사용 중"·Esc 취소 오버레이가 EG-Desk 경로에서도 뜨는지 | 대표님의 즉시 취소 수단 | 7장 시험 |
| U7 | `notify`(`SkyComputerUseClient turn-ended`)가 EG-Desk turn이 끝날 때도 실행되는지 | EG-Desk가 OpenAI 바이너리를 간접 실행하는지 | turn 1회 뒤 프로세스 기록 |
| U8 | 직접 등록 `node_repl`이 Sky 서비스로 Mac을 조작할 수 있는지 | 1단계에서 끌 대상 판정. 미확인이어도 끄는 쪽으로 처리한다 | 7장 시험에서 별도 확인 |
| U9 | "Codex Computer Use"의 현재 TCC 허용 상태(화면 기록·손쉬운 사용) | A 시험 가능 여부 | 대표님이 시스템 설정에서 확인. TCC DB는 읽지 않았다 |
| U10 | `cua_repl` Node·Sky 서비스의 실제 메모리 | 16GB 예산 | 7장 시험 |
| U11 | B helper의 TCC 권한 주체. 누가 띄우느냐(Firefox·Node·직접 실행)와 코드 서명이 바뀔 때 권한이 유지되는지 | B 설치·업데이트 경험 | B 착수 시 서명된 시험 helper로 확인 |
| U12 | macOS 백그라운드 조작이 대표님 포인터·포커스를 정말 건드리지 않는지. REA N-01·N-02(PID 입력·포커스 복원) 참고 | 감독 모드 중 대표님이 다른 일을 해도 되는지 | 7장 시험에서 대표님 입력 병행 여부 관찰. 병행하지 않는 것을 기본으로 한다 |
| U13 | OpenAI가 서드파티 app-server 클라이언트에서 Computer Use를 쓰는 것을 허용하는지 | 정책. 배포는 불가로 가정한다 | OpenAI 문의(배포 계획 결정과 함께) |
| U14 | MCP 서버 프로세스가 대화마다 따로 뜨는지 | D의 RAM 이득 크기 | 대화 2개를 열고 프로세스 수를 센다 |
| U15 | 승인이 `tool/requestUserInput`으로 오면 EG-Desk Agent 질문 카드가 그것을 승인이 아니라 "질문"으로 보여 줄 위험 | 대표님이 의미를 모르고 허락할 수 있다 | U3 확인 후 승인 카드로 분리 |

---

## 9. 출처

- OpenAI Computer Use: https://learn.chatgpt.com/docs/computer-use (https://developers.openai.com/codex/app/computer-use 리다이렉트), https://learn.chatgpt.com/use-cases/use-your-computer-with-codex
- OpenAI 로컬 보안·관리 정책: https://learn.chatgpt.com/docs/enterprise/chatgpt-work-local-security
- Codex 설정 키: https://learn.chatgpt.com/docs/config-file/config-reference
- Codex app-server: https://learn.chatgpt.com/docs/app-server. 설치본 `codex app-server generate-json-schema --experimental`(0.162.1) 결과로 같은 필드를 확인했다.
- Anthropic computer use: https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- Apple
  - https://developer.apple.com/documentation/screencapturekit/sccontentfilter
  - https://developer.apple.com/documentation/coregraphics/cgrequestscreencaptureaccess()
  - https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions
  - https://developer.apple.com/documentation/coregraphics/cgevent/posttopid(_:)
  - https://developer.apple.com/documentation/virtualization/running-macos-in-a-virtual-machine-on-apple-silicon
- macOS VM 개수 제한(제3자): https://eclecticlight.co/2022/08/04/virtualisation-on-apple-silicon-macs-8-how-apple-limits-vms/
- 기존 산출물
  - `docs/references/computer-use-browser-control-rea.md`(EG-01~08, N-01~07)
  - 계약 §12·`impl-e24-computer-use`
  - Atlas CU-01
  - 원장 CU-01~09
- 이 Mac 설치본(읽기만 함)
  - `~/.codex/computer-use/`
  - `~/.codex/plugins/cache/openai-bundled/unified-computer-use/26.1016.62342/`
  - `/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/`(README·지침)
  - `~/.codex/config.toml`(키 이름·경로만)
- 런타임 근거: 세션 scratchpad `live-config-probe/result2.json`, `live-config-probe/result3.json`, `live-config-probe2/result.json`(2026-10-24, thread 시작·readback만)
