# Agent 실행 엔진 계층(EngineAdapter) 설계 — SUB-06

- 작성일: 2026-10-24 · 기준 코드: `ce20398`(브랜치 `claude/vision-gap-20261024`) · 상태: **설계안 + Claude 어댑터 부분 구현(§14, 실제 claude 미검증)**
- 받는 쪽: 다음 구현을 지휘할 Main 개발자, 그리고 §11 결정을 내릴 대표님
- 관련 원장 항목: SUB-06(이 문서), SUB-07~11, SUB-14, AGENT-08 — [EGDESK_VISION_GAP_LEDGER.md](../../ideas/confirmed/EGDESK_VISION_GAP_LEDGER.md)
- 표기: [공식] 공식 문서·`--help` 문구 · [런타임] 이 Mac에서 직접 관찰 · [제안] 이 문서의 설계 판단(미구현·미검증) · [추정] 근거는 있으나 확인 안 됨
- 조사 범위: 코드 읽기, 공식 문서, `claude --version`/`--help` 정적 조회, `ps` 관찰. 테스트·Firefox·모델 호출은 하지 않았다.
- 갱신 2026-10-24(묶음 1-C): §5.3·§9·§10·§12를 공식 Agent SDK 코드에서 확인한 stdio 제어 통로 기준으로 고쳤다. 승인·질문은 `--permission-prompt-tool stdio`, EG-Desk 도구는 'sdk' MCP(포트·Run 토큰 없음), 질문 건너뛰기는 deny가 아니라 allow + 빈 답이다. 부품 3개(`claude-engine-permissions.mjs`, `egdesk-claude-mcp.mjs`, `claude-stream-translate.mjs`의 한도 창 구분)는 만들었고 단위 시험만 통과했다. 실제 `claude` 실행은 D1 결정 전이라 하지 않았다.

- 갱신 2026-10-24(묶음 2-E): D-S1 (b)대로 Claude 어댑터(`helper/claude-engine-adapter.mjs`)를 만들어 bridge에 실행 가능한 엔진으로 등록했다. 설치·버전 범위·로그인 게이트, D-S2 격리, D-S4 키 확인, D-S5 자동 이어가기 끔, 로그인 버튼 명령 계약까지 넣었고 가짜 `claude`로 단위 시험만 통과했다. 이 Mac의 `claude`가 로그아웃 상태라 실제 왕복은 하지 않았다. 지금 상태와 남은 일은 §14에 있다.

---

## 0. 결론과 권고

1. **엔진 계층은 Claude 연결 방식 결정을 기다리지 않고 지금 만든다.** Chat 런타임은 지금처럼 1개만 두고(스트림 번호·로컬 기록·승인 규칙을 한 곳에서 관리), 그 아래에 엔진 어댑터를 여러 개 꽂는다. Codex 어댑터가 첫 구현이고 Claude 어댑터는 자리만 둔다. [제안]
2. **내부 기준 이벤트는 지금의 Codex app-server 형태(thread/turn/item 알림 + 승인·질문·도구 요청)를 그대로 쓴다.** Claude 어댑터가 Claude 출력을 이 형태로 번역해 런타임에 넣는다. 화면과 SQLite가 받는 `chat.event` v2는 바꾸지 않고 `engineId` 필드만 더한다. 기존 런타임의 승인·질문·하위 Agent·보안 규칙(약 900줄)을 그대로 재사용할 수 있기 때문이다. [제안]
3. **어댑터 인터페이스는 "의미 단위 메서드 + Codex 형태 이벤트"로 정한다**(§4). Codex 어댑터는 처음에 기존 `request()`를 그대로 통과시킨다. 그래서 기존 테스트가 확인하는 호출 이름·인자·순서가 바뀌지 않는다. [제안]
4. **저장은 2단계로 바꾼다.** 1단계는 스키마를 바꾸지 않고 기존 `native.thread.bound` 기록과 Run 기록(`run.engine`)에 엔진·버전·계정 슬롯을 넣는다. 2단계에서 `threads.engine_id` 등을 더하는 v2 이전(추가만)을 한다. 이름 충돌을 막기 위해 **Agent Profile(성격·지침, 이미 `run.profileBinding`에 기록)** 과 **엔진 계정 슬롯(`engineProfileId`)** 을 구분한다(§6). [제안]
5. **Claude 쪽은 결정에 따라 "전송 모듈" 하나만 달라진다.** CLI stream-json을 직접 쓰든 Agent SDK를 쓰든 나오는 메시지 형태가 같으므로(SDKMessage 계열 [공식]), 번역 계층은 공통으로 둔다. API 키 경로는 둘 중 하나에서 인증 환경변수만 바꾸면 된다(§10). [제안]
6. **RAM 정책은 다음과 같다.** Codex는 지금처럼 app-server 1개를 공유하고, 계정이 여러 개가 되면 활성 계정의 것만 상주시킨다. Claude는 대화당 프로세스 1개를 두고, idle이면 종료하며, 동시 상주는 기본 2개로 제한한다. EG-Desk 도구는 helper 안에서 MCP로 제공해 대화마다 추가 프로세스가 생기지 않게 하고, 사용자 MCP 서버 상속은 막는다. 참고로 이 Mac에서 관찰한 stream-json `claude` 프로세스 RSS는 148·153·590MB였다 [런타임](§9).
7. **대표님 결정이 필요한 것은 5가지다**(§11). (D1) Claude 연결 방식, (D2) `~/.claude` 설정 상속, (D3) 대화 중 엔진 전환 정책, (D4) 기본 엔진을 기억할 범위, (D5) EG-Desk 전용 로그인 저장소. 이 중 D1·D2만 Claude 구현을 막는다. 엔진 계층(§8의 1~7단계)은 결정 없이 진행할 수 있다.
8. **첫 구현 묶음(결정과 무관)**: §8의 1~4단계. 어댑터 모듈 → 런타임 호출 교체 → 엔진 기록 → `/v1/state engines[]` 순서이며, Claude는 이 단계에서 '연결 방식 결정 대기'로만 표시된다.

## 1. 대표님 화면에서 달라지는 점

- 대화마다 어떤 AI로 실행했는지(Codex / Claude) 배지가 붙고 그 대화는 그 엔진에 고정된다. 기본 엔진을 바꿔도 진행 중인 작업은 원래 엔진에서 끝난다(SUB-06).
- 설정의 '계정 & AI 엔진'이 실제 엔진 목록(`/v1/state engines[]`)에서 나온다. 지금의 가짜 데이터를 지우는 SUB-05와 이어진다.
- Claude는 연결 방식이 정해지기 전까지 '설치됨 2.1.300 · 연결 방식 결정 대기'처럼 보이고 고를 수 없다.
- 오류 문구가 엔진과 무관하게 같은 기준(로그인 필요 / 한도 도달·초기화 시각 / 권한 / 연결 / 모델)으로 나뉜다(SUB-14).

---

## 2. 지금 구조에서 확인한 사실 (Codex 단일 경로)

모두 `ce20398` 기준 [런타임: 코드 읽기]이다. 다른 작업자가 같은 파일을 고치고 있으므로 줄 번호는 이동할 수 있다.

| 영역 | 사실 | 위치 |
|---|---|---|
| 엔진 식별 | `PROVIDER_ID = 'codex'` 하나뿐 | `helper/codex-bridge-server.mjs:38` |
| 프로세스 | app-server 프로세스 1개(`appServerProcess`)를 모든 대화가 공유(WebSocket JSON-RPC 다중화) | `codex-bridge-server.mjs:42`, `spawnAppServer` :356, `connectToAppServer` :384 |
| 이벤트 라우팅 | 알림은 Context Reader가 먼저 가져가고, 남은 것은 `chat.handleNotification`, 요청은 `chat.handleServerRequest`로 간다 | `codex-bridge-server.mjs:400-404` |
| 인증 | Chat 요청 전 Codex 로그인만 확인(`ensureChatAuth`). 계정이 바뀌면 런타임 전체 `chat.reset()` | `:167-171`, `:242` |
| 런타임 주입점 | `new CodexChatRuntime({ request, respond, ... })`. `request`=app-server 호출, `respond`=서버 요청 응답(`nativeRespond`) | `helper/codex-chat-runtime.mjs:161-178`, 생성 `codex-bridge-server.mjs:145` |
| Codex 호출 지점 | `thread/start`(:1021), `turn/start`(:1068), `thread/resume`(:1162), `thread/unsubscribe`(:1009, :1259), `turn/interrupt`(:1137, :1289, :1561, :1834), `config/read`(:992). QA 정책 모듈도 `config/read`·`mcpServerStatus/list`를 직접 호출 | `codex-chat-runtime.mjs`, `codex-chat-execution-policy.mjs:22,55` |
| 알림 정리 | `cleanNotification`이 `turn/started·completed`, `item/started·completed`, `item/agentMessage/delta`, `item/reasoning/summaryTextDelta`, `item/plan/delta`, `turn/plan/updated`, `error`, `thread/tokenUsage/updated`, `serverRequest/resolved`만 통과시킨다. 항목은 `safeItem`이 `agentMessage·userMessage·reasoning·plan·commandExecution·fileChange·mcpToolCall·dynamicToolCall·collabAgentToolCall·subAgentActivity`만 남긴다 | `:139-158`, `:44-98` |
| 서버 요청 | `item/tool/call`(EG-Desk 도구), `item/tool/requestUserInput`(질문), 그 밖의 승인(`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`만 지원) | `:1398-1424`, `:1551-1607` |
| 공개 이벤트 | `chat.event` v2, `provider:'codex'`. 이벤트 이름: `run.started`, `run.configuration`, `run.executionPolicy`, `message.started/delta/completed`, `activity.started/completed`, `plan.updated`, `summary.delta`, `approval.required/resolved`, `userInput.required/resolved`, `subagent.updated`, `artifact.available`, `qa.command.receipt`, `run.stop_requested`, `run.unavailable`, `run.reconciled`, `run.completed` (+ 저장 전용 `run.dispatching`, `native.thread.bound`, `run.recovery_unknown`) | `emit` :426-467 |
| 연결 상태 | 연결·epoch가 런타임 전체에 하나. 프로세스가 끝나면 진행 중인 모든 Run이 `failed` | `setConnection` :497-529 |
| 저장소 | SQLite `user_version=1`. 다른 버전은 열기를 거부(초기화 안 함). `threads`에 엔진 컬럼 없음. 공개 JSON에 `apikey`·`secret`·`systemprompt`·`reasoning` 같은 키가 있으면 저장 거부 | `helper/egdesk-chat-store.mjs:7`, `:147-154`, `:156-161`, `:12-18` |
| 화면 필터 | `provider !== 'codex'`인 이벤트는 버림. QA 계약 스크립트도 같다 | `overlay/resources/EGDeskChatState.sys.mjs:494`, `scripts/egdesk-chat-qa-contract.sys.mjs:104` |
| 오류 분류 | `ERROR_KINDS = ['auth','quota','permission','network','model','unknown']`, `publicError`가 `kind`·`retryAt`을 붙임 | `helper/codex-chat-values.mjs:43`, `:91-97` |
| Codex 전용 의존 | Context Reader(`NativeReaderClient`)와 사용 한도 동기화(`createRateLimitSync`)는 app-server를 직접 쓴다 | `codex-bridge-server.mjs:141`, `:183` 부근 |

리팩터 순서를 정할 때 지켜야 하는 테스트 고정점:

- `helper/codex-chat-runtime.test.mjs:1835-1837`은 `'accept','run.dispatching','thread/start','native.thread.bound','turn/start','run.started','run.configuration'` **순서**를 단언한다. 새 이벤트를 끼우면 깨진다. 기존 이벤트의 details에 필드를 더하는 것은 괜찮다.
- `helper/egdesk-chat-store.test.mjs:86`은 `user_version === 1`을 단언한다. 스키마 v2로 올리는 커밋에서 같이 고친다. `:359-361`(버전 99 거부)은 그대로 유지된다.
- `codex-bridge-server.mjs` **원문 문자열**을 읽어 단언하는 테스트가 3개 있다. `codex-bridge-http.test.mjs:521-540`(`'const chat = new CodexChatRuntime({'`, `'  profiles: profileStore,'` 등), `egdesk-native-capabilities.test.mjs:241-259`(`'spawn(executable, appServerLaunch.args, {'`, `"appServerProcess.kill('SIGTERM')"` 등), `egdesk-file-mount.test.mjs:217-235`. app-server 기동 코드를 다른 파일로 옮기면 이 3개를 같은 커밋에서 고쳐야 한다.
- 정적 grep 기준 `test(` 호출 수는 helper/*.test.mjs 523건, scripts/*.test.mjs를 포함하면 987건이다(실행하지 않음). 원장의 중앙 회귀는 534/534(b706baa) → 596/598(`2480174`)이다.

---

## 3. 계층 구조

```
 Chat UI (overlay)          ← chat.event v2 (provider 필드 + engineId 추가), SSE 'codex' 채널 이름 유지
        │
 bridge HTTP (/chat/*, /v1/state)  ← ensureAuth(body) 엔진별
        │
 ChatRuntime (현 CodexChatRuntime, 1개)
   - requestId 멱등·로컬 기록(SQLite)·승인/질문/하위 Agent 규칙·EG-Desk 도구 권한 검사
   - 대화(thread)마다 engineId 고정 → engineOf(threadId)
   - 입력: "내부 기준 이벤트" = Codex app-server 형태 알림·요청 (cleanNotification/safeItem이 정리)
        │                                   ▲
        ▼ 의미 단위 메서드                   │ Codex 형태 이벤트
 EngineRegistry ── CodexEngineAdapter ── app-server(WS JSON-RPC, 프로세스 1개/활성 계정)
               └─ ClaudeEngineAdapter
                     ├─ 번역 계층: SDKMessage 계열 → Codex 형태 (순수 함수, fixture 시험)
                     └─ 전송 모듈 (D1 결정 후 하나): CLI stream-json 직접 | Agent SDK query()
                           └─ claude 프로세스 1개/대화 (idle 종료, 상주 상한)
 EG-Desk 도구 제공: Codex=dynamicTools(지금 그대로) / Claude=helper가 직접 제공하는 MCP(추가 프로세스 없음)
```

- **런타임을 1개로 두는 이유** [제안]. SSE `ready` 메시지가 런타임 하나의 `streamId`·`seq`로 재동기화한다(`codex-bridge-server.mjs` `/events`). 엔진마다 런타임을 따로 두면 스트림 번호·대화 잠금·요청 멱등이 둘로 갈린다. 화면 쪽 `reduceChatEvent`는 스트림 여러 개를 받을 수 있지만, 재동기화 계약은 스트림 하나를 전제로 한다.
- **이름 원칙**: 이미 런타임 안에 "tool provider"(`egdesk-browser`, Context)라는 이름이 있으므로 실행 AI는 일관되게 **engine**이라 부른다. `provider:'codex'` 필드는 화면 하위 호환을 위해 당분간 남긴다(§8 7단계에서 정리).

---

## 4. EngineAdapter 인터페이스

### 4.1 메서드

```ts
type EngineId = 'codex' | 'claude'

interface EngineAdapter {
  readonly id: EngineId

  // ── 상태 (/v1/state engines[]의 한 줄)
  describe(): EngineDescriptor                  // 동기·캐시. 비밀값·자격증명 경로 없음
  refresh(): Promise<EngineDescriptor>          // 실행 파일·버전·로그인 상태 재확인(정적 조회만)
  capabilities(engineProfileId?: string): ReadonlySet<EngineCapability>
  ownerKey(engineProfileId: string): string | null   // 계정 식별 원문. 런타임이 해시해 기록
  isReady(engineProfileId?: string): boolean

  // ── 대화
  startThread(spec: ThreadSpec): Promise<ThreadStarted>
  resumeThread(threadId: string, spec: ThreadSpec): Promise<ThreadResumed>
  releaseThread(threadId: string): Promise<'released' | 'notLoaded'>
  startTurn(threadId: string, input: TurnInput): Promise<TurnStarted>
  interruptTurn(threadId: string, turnId: string): Promise<void>
  steerTurn?(threadId: string, turnId: string, input: TurnInput): Promise<void>  // 선택 능력

  // ── 엔진이 보낸 요청(승인·질문·EG-Desk 도구)에 응답. 지금 nativeRespond와 같은 서명
  respond(rpcId: string | number, result: unknown, error?: { code: number, message: string }): boolean

  // ── 이벤트 구독
  subscribe(sink: EngineSink): () => void
  dispose(reason?: string): Promise<void>
}

interface EngineSink {
  notification(engineId: EngineId, msg: { method: string, params: object }): void   // → runtime.handleNotification
  serverRequest(engineId: EngineId, msg: { id: string | number, method: string, params: object }): void // → runtime.handleServerRequest
  connection(engineId: EngineId, state: { ready: boolean, processLost?: boolean }): void  // 엔진 전체 상태만
}

type ThreadSpec = {
  clientThreadId: string, engineProfileId: string,
  cwd?: string, model?: string, effort?: string,
  developerInstructions?: string,               // Agent Profile 합성 결과(AGENT-03)
  tools: ToolSpec[],                            // EG-Desk 도구 카탈로그(collectToolSpecs 결과)
  executionPolicy: null | 'readOnlyQa' | 'browserBounded' | 'fixtureBrowserQa',
}
type TurnInput = { text: string, clientUserMessageId: string /* = requestId */, model?: string, effort?: string, cwd?: string, additionalContext?: string }
type ThreadStarted = { threadId: string, model: string | null, effort: string | null, cwd: string | null, engineVersion: string | null, policyReceipt?: object }
type ThreadResumed = ThreadStarted & { turns: CodexTurn[], historySource: 'engine' | 'egdesk-local', historyIncomplete: boolean }
type TurnStarted = { turnId: string, status: 'inProgress' | 'completed' | 'failed' | 'interrupted', model?: string, effort?: string }
```

- **Codex 어댑터 전용 탈출구** [제안]: `request(method, params)`를 Codex 어댑터에만 남긴다. QA 정책 검증(`loadQaThreadOverrides`, `verifyQaMcpIsolation`), `config/read`, Context Reader가 이것을 계속 쓴다. 런타임은 해당 능력(`boundedQa`, `profileOffInstructions`)이 있는 엔진에서만 이 경로를 탄다.
- **Claude 프로세스 손실은 엔진 전체 연결 끊김이 아니다** [제안]. 대화 하나의 프로세스가 죽으면 Claude 어댑터가 그 대화의 진행 중 turn을 `turn/completed {status:'failed', error:{code:'RUNTIME_LOST'}}`로 합성하고, 대기 중인 승인·질문을 `serverRequest/resolved`로 합성한다. 그러면 런타임의 전역 epoch를 건드리지 않아도 된다. `sink.connection`은 실행 파일이 없어졌거나 로그아웃된 경우처럼 엔진 전체 상태가 바뀔 때만 쓴다.

### 4.2 능력(capabilities)

| 이름 | 뜻 | Codex | Claude |
|---|---|---|---|
| `stream` | 실시간 답변 | 있음 | 있음(`--include-partial-messages` [공식]) |
| `resume` | 대화 재개 | 있음 | 있음(`--resume`/`resume` 옵션 [공식]) |
| `nativeHistory` | 재개 시 엔진이 과거 turn을 돌려줌 | 있음 | 없음 → 로컬 기록이 원본 [제안] |
| `interrupt` | 중지 | 있음 | 있음(SIGINT 또는 SDK `interrupt()` [공식]) |
| `approvals.command` / `approvals.fileChange` | 명령·파일 변경 승인 카드 | 있음 | 있음(Bash / Edit·Write) |
| `approvals.tool` | 그 밖의 도구 승인(WebFetch, MCP 등) | 없음 | 필요(새 승인 종류) |
| `userInput` / `userInput.multiSelect` | 질문 카드 / 복수 선택 | 있음 / 없음 | 있음(AskUserQuestion) / 있음 |
| `subagents` | 하위 Agent 진행 | 있음 | 있음(Agent 도구 + task_* 메시지) |
| `dynamicTools` | EG-Desk 도구(Browser·Context) | 있음 | MCP로 제공(SUB-10) |
| `boundedQa` | 읽기 전용 QA·Browser 한정 정책 검증 | 있음 | 처음엔 없음 → 해당 정책 요청 거부 |
| `modelSelect.perTurn` / `effortSelect.perTurn` | 턴마다 모델·추론 강도 | 있음 | 프로세스 단위(바뀌면 재시작) |
| `usage.rateLimits` | 요금제 한도 조회 | 있음(`account/rateLimits/read`) | 실행 중 `rate_limit_event`만 [공식] |

### 4.3 오류 분류

오류를 "언제 나는가"로 3층으로 나누고, 화면 분류(`kind`)는 기존 `ERROR_KINDS`를 그대로 쓴다. [제안]

| 층 | 코드(HTTP) | kind | 화면 문구 방향 |
|---|---|---|---|
| 엔진 상태(보내기 전) | `ENGINE_NOT_INSTALLED`(503) | unknown | 'Claude가 이 Mac에 설치되어 있지 않음' |
| | `ENGINE_VERSION_UNSUPPORTED`(503) | unknown | '지원 버전 아님' |
| | `ENGINE_LOGIN_REQUIRED`(401) — 기존 `LOGIN_REQUIRED`를 엔진별로 일반화 | auth | '로그인 필요' + 공식 로그인 열기 |
| | `ENGINE_DECISION_PENDING`(403) | unknown | '연결 방식 결정 대기' |
| | `ENGINE_BUSY`(429) | unknown | '다른 Claude 대화가 작업 중' |
| | `ENGINE_UNAVAILABLE`(503) — 기존 `BRIDGE_OFFLINE` 대응 | network | '연결 끊김 · 재시도' |
| 대화 바인딩 | `ENGINE_MISMATCH`(409) | unknown | '이 대화는 Codex로 시작됨 · 새 대화로 이어가기' |
| | `ENGINE_PROFILE_MISMATCH`(403) — 기존 `NATIVE_ACCOUNT_MISMATCH`의 엔진판 | auth | '다른 계정으로 시작한 대화' |
| 실행 중 | `turn.error {code, origin: engineId, kind, retryAt?}` | 아래 표 | kind별 문구·버튼(SUB-14) |
| 도구 | `classifyPublicToolError` 그대로 | — | 엔진과 무관 |

Claude 출력 → `kind` 대응:

| Claude 출력 | 값 | kind |
|---|---|---|
| `system/api_retry.error` [공식] | `authentication_failed`, `oauth_org_not_allowed`, `cloud_credential_error` | auth |
| | `rate_limit`, `billing_error` | quota |
| | `account_on_hold` | permission [제안: 재로그인으로 안 풀림] |
| | `overloaded`, `server_error` | network |
| | `invalid_request`, `model_not_found`, `max_output_tokens` | model |
| | `unknown` | unknown |
| `assistant.error` [공식] | `rate_limit`, `billing_error` → quota · `overloaded` → network · `max_output_tokens` → model | |
| `rate_limit_event.rate_limit_info` [공식] | `status:'rejected'` → quota + `retryAt = resetsAt` · `errorCode:'credits_required'` → quota('추가 사용량 필요') · `allowed_warning` → 오류 아님, 사용량 경고 표시 · (2026-10-24) `rateLimitType` → `window`(`fiveHour` 300분 / `weekly`·`weeklyOpus`·`weeklySonnet`·`weeklyIncluded` 10080분 / `overage`)과 `usedPercent`(0~100)를 `egdesk/engine/rateLimit`에 실음, 여러 이벤트는 `applyClaudeRateLimit()`으로 창마다 한 줄 | |
| `result.subtype` [공식] | `error_max_budget_usd` → quota · `error_max_turns`, `error_max_structured_output_retries` → model · `error_during_execution` → 동반 오류로 판별, 없으면 unknown | |
| `system/permission_denied`, `result.permission_denials` [공식] | 도구가 허락되지 않아 건너뜀 → permission(활동 카드 표시, Run 실패 아님) | |

- `api_retry`는 Codex의 `error {willRetry:true}`로 번역하고, 최종 실패만 `turn.error`가 된다.
- `safeTurn`이 지금 `publicError(turn.error, 'TURN_FAILED', 'codex')`로 origin을 고정하고 있다(`codex-chat-runtime.mjs:131`). origin은 엔진 id로 바꾼다.

---

## 5. 내부 기준 이벤트 대응표 (Codex ↔ Claude CLI stream-json ↔ Agent SDK)

원칙 [제안]: Claude 어댑터는 Codex 형태의 **원본 알림**(`{method, params}`)을 만들어 런타임의 `handleNotification`/`handleServerRequest`에 넣는다. 정리(`cleanNotification`·`safeItem`)는 런타임에 남기므로 어댑터가 보안 정리를 우회하지 못한다. CLI stream-json과 Agent SDK는 같은 메시지 계열을 낸다(CLI 문서가 `claude -p`를 "Agent SDK via the CLI"로 설명 [공식]). 그래서 아래 표의 Claude 열 두 개는 대부분 같고, 전송 방법만 다르다.

### 5.1 대화·턴 흐름

| 내부 기준(Codex 형태) | Codex app-server | Claude CLI stream-json | Agent SDK (TS) |
|---|---|---|---|
| 대화 시작 `thread/start` → `{thread:{id}, model, cwd}` | 그대로 | `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --session-id <EG-Desk가 만든 UUID>` 실행. threadId는 미리 정한 UUID. model·version은 첫 `system/init`(session_id, model, cwd, tools, mcp_servers, permissionMode, claude_code_version, capabilities) [공식]에서 채움 | `query({ prompt: AsyncIterable, options: { sessionId, cwd, model, effort, ... } })`, 첫 `SDKSystemMessage` init [공식] |
| 대화 재개 `thread/resume` → turns | 그대로(엔진이 기록 반환) | `--resume <session_id>`로 다시 실행 [공식]. turns는 돌려받지 않음 → `turns: []`, `historySource:'egdesk-local'` [제안]. Claude 내부 기록 파일은 읽지 않음 | `options.resume` [공식] |
| 대화 해제 `thread/unsubscribe` | 그대로 | stdin 닫기 → 종료 대기 [제안] | `query.close()` [공식] |
| 턴 시작 `turn/start {threadId, input, clientUserMessageId}` → `{turn:{id}}` | 그대로 | stdin에 사용자 메시지 한 줄 `{"type":"user","message":{"role":"user","content":...}}` [추정: SDKUserMessage 형태, CLI 문서에 원문 예시 없음]. turnId는 어댑터가 만들고, `--replay-user-messages`로 되돌아온 사용자 메시지로 접수를 확인 [공식 플래그] | `streamInput()` 또는 prompt iterator에 SDKUserMessage [공식] |
| `turn/started` | 그대로 | 어댑터가 합성(접수 확인 시점) | 같음 |
| `turn/completed {status, error}` | 그대로 | `result` [공식]: `success` → completed, `error_*` → failed, 중지 뒤의 result → interrupted(`terminal_reason`, `aborted:true` 참고 [공식 필드, 값 해석은 추정]) | `SDKResultMessage` |
| 중지 `turn/interrupt` | 그대로 | SIGINT [공식: "To end the turn instead, send SIGINT"]. SIGINT 뒤 프로세스가 살아 있는지는 미확인 → 끝나면 다음 보내기에서 `--resume` | `query.interrupt()` (스트리밍 입력 모드에서만 [공식]) |
| 강제 종료 | — | SIGTERM은 진행 중 턴을 **미완료로 남김**(exit 143) [공식] → 일반 경로에서는 쓰지 않음 | SDK는 신호 전에 입력을 먼저 닫음 [공식] |
| 턴별 모델·추론 강도 | `turn/start {model, effort}` | 프로세스 단위 `--model`, `--effort`만 → 바뀌면 idle 상태에서 `--resume`으로 재시작 [제안] | `setModel()` [공식], effort는 시작 옵션(실행 중 변경 수단 미확인) |
| Agent Profile 지침 | `developerInstructions` | `--append-system-prompt` [공식]. **주의**: `--system-prompt-snapshot`이 기본 on이라 첫 요청의 시스템 프롬프트를 기록해 두고 이후 재개 때 다른 문구를 줘도 기록본을 보낸다 [공식 `--help` 문구] → 새 Profile revision을 다음 보내기에 반영하는 AGENT-03 동작과 충돌. `off` 필요 여부 검증 대상 | `systemPrompt: { type:'preset', preset:'claude_code', append }` [공식] |
| cwd | thread/turn `cwd` | 프로세스 cwd + `--add-dir` | `options.cwd` |
| 토큰 사용 `thread/tokenUsage/updated` | 그대로 | `assistant` usage, `result.usage`·`modelUsage` [공식]. 컨텍스트 창 크기의 필드 위치는 미확인 | `context_usage`, `getContextUsage()` [공식] |
| 프로세스 끝남 | 전역 `setConnection(false,{processLost})` | 그 대화만: turn 실패·승인 해제 합성(§4.1) [제안] | 같음 |

### 5.2 항목(item)

| 내부 기준 item | Codex | Claude (CLI·SDK 공통: `assistant`/`user` 메시지의 content block) |
|---|---|---|
| `agentMessage` started → delta → completed | 그대로 | `stream_event` content_block_start(text) → `text_delta` → `assistant` 메시지의 text block(완성본). partial 이벤트는 본 대화에서만 나온다(`parent_tool_use_id` 항상 null [공식]). itemId = `${message.id}:${blockIndex}` [제안] |
| `reasoning`(요약) | `summaryTextDelta` | thinking block. 처음에는 본문을 보여 주지 않고 '생각 중' 표시만 한다 [제안]. 저장소가 `reasoning` 계열 키를 거부하고, Codex도 요약만 쓴다 |
| `commandExecution` | 그대로 | `tool_use` name=`Bash`(input.command) → started. 같은 `tool_use_id`의 `tool_result` → completed, `is_error` → failed. exitCode는 알 수 없음 → null(`tool_use_result`는 도구별 unknown [공식]) |
| `fileChange` | 그대로 | `Edit`·`Write`·`MultiEdit`·`NotebookEdit` → changes[{path: input.file_path, kind}]. Write의 새 파일 여부는 구분 불가 → `update` [제안] |
| `mcpToolCall` | 그대로 | `mcp__<server>__<tool>` → server/tool로 분리(EG-Desk 서버 제외) |
| `dynamicToolCall` | EG-Desk 도구 | `mcp__egdesk__<tool>` → 기존 이름(`egdesk_browser_observe` 등)으로 되돌려 같은 카드를 쓴다. 대응 항목이 없는 내장 도구(Read·Grep·Glob·WebFetch·WebSearch·Skill)도 일반 활동 카드(`dynamicToolCall{tool}`)로 보낸다 [제안] |
| `plan` / `turn/plan/updated` | 그대로 | `TodoWrite` 입력의 할 일 목록 → `plan[{step, status}]` (`in_progress` → `inProgress`) [추정: 입력 구조와 최신 버전의 계획 도구 이름 확인 필요] |
| `collabAgentToolCall`(spawnAgent) | 그대로 | `tool_use` name=`Agent`(하위 Agent 시작) → tool `spawnAgent`, receiverThreadIds=[tool_use_id], 결과 `tool_result` → completed |
| `subAgentActivity` | 그대로 | `system/task_started`·`task_progress`·`task_notification`(task_type `local_agent`, tool_use_id, status completed/failed/stopped) [공식 SDK 타입]. 하위 Agent의 assistant/user 메시지(`parent_tool_use_id`≠null 또는 `agent_id`)는 본 대화 말풍선으로 내보내지 않는다. 짝은 `agent_id`로 맞춘다(재개된 하위 Agent는 `parent_tool_use_id` 짝이 깨질 수 있음 [공식]) |
| `userMessage` | 그대로 | `--replay-user-messages`의 되돌아온 메시지 → `userMessage{clientId=requestId}` [추정: 입력 uuid가 그대로 돌아오는지 미확인] |

### 5.3 승인·질문·EG-Desk 도구

> **2026-10-24 보강(묶음 1-C) [제안, 근거는 공식 SDK 코드]**: Claude는 공식 Agent SDK와 같은 stdio 제어 통로로 연결한다. SDK는 canUseTool 콜백이 있으면 CLI를 `--permission-prompt-tool stdio`로 띄우고(claude-agent-sdk-python `types.py` `_configure_can_use_tool`, MIT), 대화와 같은 stdin/stdout에 `control_request`/`control_response` 줄을 주고받는다(`_internal/query.py` `_handle_control_request`). 그래서 명령·파일 승인, AskUserQuestion, EG-Desk 도구 호출이 모두 한 파이프로 온다. CLI를 직접 띄우든 SDK를 쓰든 이 통로는 같다. 다만 CLI 공개 문서의 계약이 아니라 SDK 코드가 근거이므로, D1 결정 뒤 실제 실행 1회로 확인한다(§12).
>
> 만든 부품(결정 없이 완료, 실행 연결은 2-E): `helper/claude-engine-permissions.mjs`(승인·질문 변환과 보류 기록), `helper/egdesk-claude-mcp.mjs`(EG-Desk 도구 MCP 서버), `helper/claude-stream-translate.mjs`(control 줄은 번역하지 않고 '무시'로 셈). 셋 다 순수 함수이고, 기존 런타임(`CodexChatRuntime`)에 넣어 승인 카드·질문 카드·도구 호출이 그대로 동작하는 것을 단위 시험으로 확인했다.

| 내부 기준 요청 | Codex | Claude (stdio 제어 통로, CLI 직접·SDK 공통) |
|---|---|---|
| `item/commandExecution/requestApproval` | 그대로 | `control_request {subtype:'can_use_tool', tool_name:'Bash' 또는 'PowerShell', input, tool_use_id, permission_suggestions, title…}` → 같은 요청으로 바꾼다. `itemId = tool_use_id`라서 번역기가 만든 활동 행의 명령이 카드에 붙는다 |
| `item/fileChange/requestApproval` | 그대로 | 같은 경로(`Edit`·`Write`·`MultiEdit`·`NotebookEdit`). 경로는 번역기의 활동 행에서 온다 |
| (확장) 그 밖의 도구 승인 | 없음 | 1차는 카드 없이 거절한다(`behavior:'deny'`, interrupt 없음 → Claude는 다른 방법으로 계속). `mcp__egdesk__*`만 여기서 허용하고, 실제 권한은 호출 때 런타임이 검사한다(Codex dynamicTools와 같음) |
| 응답 `{decision}` | 그대로 | `control_response {subtype:'success', response: PermissionResult}`. accept → `{behavior:'allow', updatedInput: 원래 입력}`(SDK도 원래 입력을 돌려줌), decline → deny, cancel → deny + `interrupt:true`, acceptForSession → allow + `updatedPermissions`(CLI 제안을 `destination:'session'`으로 바꿈. 제안이 없으면 Bash는 1회 허용만 — 'Bash' 전체 규칙은 모든 명령을 허용하므로). 런타임이 오류로 답하면(카드를 못 띄움, run 없음) deny만 하고 중지 여부는 런타임이 정한다 |
| `item/tool/requestUserInput` | 그대로 | `can_use_tool` + `tool_name:'AskUserQuestion'`. 콜백이 등록되면 SDK가 AskUserQuestion도 이 경로로 보낸다(claude-agent-acp `src/elicitation.ts` 머리 주석, Apache-2.0) |
| 질문 식별 | `question.id` | id가 없음 → `q<index>`. 질문 원문은 메모리의 보류 기록에만 두고 공개 상태·저장소의 키로 쓰지 않는다 |
| 답 | `{answers:{[id]:{answers:[label]}}}` | `updatedInput: {...원래 입력, answers:{[질문 원문]: 라벨 또는 직접 입력}}`. 복수 선택은 쉼표로 잇고, 쉼표·따옴표가 든 항목은 JSON 따옴표로 감싼다(claude-agent-acp `applyAskElicitationResponse` 패턴). 답 객체는 prototype 없는 객체라 '__proto__' 같은 질문 문장도 보통 키다 |
| 건너뛰기 | error -32000 | **allow + 빈 answers**. Claude는 "사용자가 건너뜀"을 읽고 대화가 계속된다(같은 패턴: claude-agent-acp decline, t3code). 이전 계획의 deny는 쓰지 않는다 |
| 한도·제약 | 질문 ≤8, 선택지 ≤12 (EG-Desk) | Claude: 질문 1~4, 선택지 2~4, 하위 Agent 안에서는 불가 [공식]. 변환은 EG-Desk 한도까지 받는다. 같은 질문 문장이 두 번 오면 답의 키가 겹치므로 거절한다 |
| `item/tool/call`(EG-Desk 도구) → `{success, contentItems}` | dynamicTools | **'sdk' MCP**: `--mcp-config '{"mcpServers":{"egdesk":{"type":"sdk","name":"egdesk"}}}'`(SDK `subprocess_cli.py`와 같은 모양). CLI가 `control_request {subtype:'mcp_message', server_name:'egdesk', message: JSON-RPC}`로 보낸다. tools/list는 그 스레드의 도구 카탈로그(=Codex에 주는 dynamicTools specs, inputSchema 그대로), tools/call은 `item/tool/call`로 바꿔 `runtime.handleServerRequest`에 넣는다 → 기존 검사(run 바인딩, 실행 정책, Browser 카드 권한, Agent 한도) 뒤 provider.dispatch → 결과를 MCP CallToolResult로. 런타임이 거절하면 `isError` 결과로 Claude에게 알린다 |
| `serverRequest/resolved` | Codex 알림 | CLI가 `control_cancel_request {request_id}`를 보내면 합성한다. 프로세스가 끝나면 남은 보류 전부 합성한다 |

- **2026-10-25 구현 상태**: 런타임은 `acceptForSession`과 `multiSelect`를 전달한다. 세션 허용은 정규화된 같은 도구의 `addRules/allow` 규칙이 있을 때만 제공하며, `terminal: ask` 등 Agent 상한을 넘지 않는다. 규칙이 없는 세션 허용 요청을 1회 허용으로 조용히 바꾸지 않는다. 위 표의 2026-10-24 fallback 제안보다 이 제한이 우선한다. 일반 도구 승인 카드는 여전히 미구현이며, 화면 연결·실계정 검증 범위는 §14.7에서 구분한다.
- **런타임 응답 경로(2026-10-25)**: 실제 요청을 소유한 엔진 어댑터로 보낸다. `claude:<threadId>:perm:<n>`·`claude:<threadId>:mcp:<n>`의 번호는 어댑터 수명 동안 재사용하지 않는다. 프로세스 재시작·모델 변경·세션 퇴출 후 도착한 이전 응답이 새 요청을 소비하지 않으며, Claude의 늦은 응답을 Codex로 우회하지 않는다. 전송 결과가 `false`이면 `replySent`나 성공으로 기록하지 않는다. [가짜 전송 기반 실제 어댑터·런타임 시험]
- **승인 대기 시간**: stdio 통로의 승인·질문은 MCP 호출이 아니므로 이전에 걱정한 'MCP 호출 시간 제한에 걸린 승인'은 해당하지 않는다(SDK `canUseTool`은 무기한 대기 가능 [공식]). EG-Desk 도구 호출(tools/call)은 MCP 요청이므로 CLI의 MCP 시간 제한 영향은 받을 수 있다 [추정, §12].
- **시작·중지 순서**: SDK는 스트리밍 입력 모드에서 먼저 `control_request {subtype:'initialize', hooks:null, …}`를 보낸다(query.py `initialize`). 이 요청에 `systemPromptSnapshot` 필드가 있으므로 §5.1의 `--system-prompt-snapshot` 충돌을 이 값으로 끌 수 있는지 확인한다 [추정]. 중지는 SIGINT 대신 `control_request {subtype:'interrupt'}`(query.py `interrupt`)를 기본으로 한다. 두 요청 모두 `buildControlRequest()`로 만든다. [제안]
- **hooks·그 밖의 제어 요청**: EG-Desk는 hook 콜백을 등록하지 않는다. `hook_callback`이나 모르는 제어 요청이 오면 SDK처럼 `control_response {subtype:'error'}`로 그 요청만 실패시킨다.

### 5.4 대응 안 되는 것과 처리

| 항목 | 처리 [제안] |
|---|---|
| Codex 한정 정책(readOnlyQa·browserBounded·fixtureBrowserQa)의 엔진 측 검증 | Claude에는 `boundedQa` 능력이 없으므로 요청을 `QA_POLICY_UNAVAILABLE`로 거부한다. 나중에 `--tools`·`--strict-mcp-config`·`--permission-mode dontAsk`·`--restricted` [공식 플래그] + `system/init`의 tools/mcp_servers 목록 대조로 같은 수준의 영수증을 만들 수 있는지 검토한다 |
| Context Reader(smart-read·answer-briefing) | Codex app-server 전용이다. Claude 대화에서도 EG-Desk Context 도구(`egdesk_list_context`·`egdesk_read_source`)는 MCP로 쓸 수 있지만, 읽기 전용 Reader 기능은 Codex가 켜져 있어야 한다. Claude만 쓰는 사용자 시나리오에서 빠지는 기능이므로 화면에 표시한다 |
| Codex collab 도구 중 `sendInput`·`wait`·`closeAgent` 등 | Claude는 시작·진행·종료만 대응한다 |
| `system/compact_boundary` [공식] | 활동 카드 '대화 압축됨'(확장 알림) 또는 무시 |
| 비용(`total_cost_usd`) | 구독 경로에서는 표시하지 않는다. API 키 프로필(SUB-15)에서만 확장 알림 `egdesk/engine/usage`로 표시 |
| 확장 알림 이름 | Codex에 없는 것은 `egdesk/…` 접두어(예: `egdesk/engine/rateLimit`)로 같은 형태 안에 두고, `cleanNotification`에 허용 목록으로 추가한다 |

---

## 6. 저장 스키마 변경안 (`egdesk-chat-store`)

### 6.1 이름 정리

| 이름 | 뜻 | 지금 |
|---|---|---|
| `profileBinding {profileId, revision, hash}` | Agent Profile(성격·지침) 어느 revision으로 실행했는가 | 이미 Run에 기록(AGENT-03) |
| `engineId` | `codex` \| `claude` | 없음 |
| `engineVersion` | 그 Run을 실행한 엔진 버전. Codex는 `codex --version`, Claude는 `system/init.claude_code_version` | 없음 |
| `engineProfileId` | 엔진 계정 슬롯(어느 로그인·어느 `CODEX_HOME`/`CLAUDE_CONFIG_DIR`). 지금은 `codex-default` 하나 | 없음(SUB-11) |

과제 문구의 "profileId"는 계정 슬롯이므로 **`engineProfileId`** 로 쓰고, Agent Profile의 `profileId`와 섞지 않는다. [제안]

### 6.2 1단계 — 스키마 변경 없음

- `native.thread.bound` 기록의 details에 `engine: { id, version, engineProfileId }`를 더한다. 이벤트 순서는 그대로이므로 `codex-chat-runtime.test.mjs:1835` 순서 단언이 깨지지 않는다.
- Run에 `run.engine = { id, version, engineProfileId }`를 둔다. `emit`이 Run 전체를 checkpoint로 저장하므로 `runs.public_json`에 자동으로 남는다. 키 이름에 `apiKey`·`secret` 같은 금지 키가 없어야 한다.
- 예전 기록 읽기 규칙: `engine`이 없는 `native.thread.bound`는 `codex`(버전 미상)로 본다.
- `assertNativeAccount`가 엔진 바인딩도 함께 돌려주고, 요청 엔진과 다르면 `ENGINE_MISMATCH`로 거부한다.
- 요청 fingerprint에 `engineId`는 **값이 있을 때만** 넣는다. 그러면 업그레이드 전에 접수된 요청을 재전송해도 fingerprint가 같아 `REQUEST_CONFLICT`가 나지 않는다(`JSON.stringify`가 undefined 필드를 빼기 때문).
- 계정 해시(ownerHash): **Codex는 지금 키를 그대로 쓴다.** 접두어 `codex:`를 붙이면 기존 대화의 기록된 ownerHash와 달라져 전부 `NATIVE_ACCOUNT_MISMATCH`가 된다. 새 엔진만 `claude:` 접두어로 시작한다(SUB-02 메모 보정).

### 6.3 2단계 — 스키마 v2 (추가만)

```sql
-- user_version 1 → 2. BEGIN IMMEDIATE … COMMIT, 실패하면 ROLLBACK하고 원본을 유지한다.
ALTER TABLE threads ADD COLUMN engine_id TEXT;          -- NULL = 아직 한 번도 보내지 않은 대화
ALTER TABLE threads ADD COLUMN engine_profile_id TEXT;
ALTER TABLE threads ADD COLUMN engine_bound_at INTEGER;
UPDATE threads SET engine_id = 'codex', engine_profile_id = 'codex-default'
 WHERE conversation_id IS NOT NULL;                     -- v1 데이터는 전부 Codex
ALTER TABLE runs ADD COLUMN engine_id TEXT;
ALTER TABLE runs ADD COLUMN engine_version TEXT;
ALTER TABLE runs ADD COLUMN engine_profile_id TEXT;
UPDATE runs SET engine_id = 'codex' WHERE engine_id IS NULL;
CREATE INDEX threads_engine ON threads(engine_id, updated_at DESC);
PRAGMA user_version = 2;
```

- `initialize()`: 2이면 테이블과 컬럼을 확인하고, 1이면 위 이전을 실행하고, 0이면 v2로 바로 만든다. 그 밖의 버전은 지금처럼 `UNSUPPORTED_STORE_VERSION`으로 닫힌다.
- 이전 직전에 `chat-<hash>.sqlite`를 `.v1.bak`으로 복사해 둔다. 옛 빌드는 v2 파일을 열지 못하므로(닫힘 실패, 초기화 안 함) 되돌릴 때 이 백업이 필요하다. [제안]
- `bindNative({clientThreadId, conversationId, engineId, engineProfileId})`: 처음 바인딩할 때 기록하고, 이미 다른 엔진이면 `ENGINE_MAPPING_CONFLICT`(409)로 거부한다. 대화 잠금을 저장소에서도 지키기 위해서다.
- `thread()` 결과에 `engineId`·`engineProfileId`를 더한다. `projectRun`은 `run.engine`을 runs 컬럼에 복사한다.
- runs 컬럼은 선택 사항이다(`public_json`에 이미 있음). threads 컬럼은 대화 목록을 엔진으로 거르고 잠금을 검사할 때 이벤트를 훑지 않으려면 필요하다.
- conversation_id 충돌: Codex thread id와 Claude session UUID가 같을 확률은 무시할 만하다. 런타임 메모리 맵 키는 `${engineId}:${threadId}`로 바꾸는 것을 권고한다. [제안]
- 테스트 영향: `egdesk-chat-store.test.mjs:86`의 1을 2로 바꾸고, v1 파일 → v2 이전 시험과 엔진 잠금 충돌 시험을 추가한다.

---

## 7. `/v1/state` `engines[]` 공개 형태

기존 최상위 필드(`provider:'codex'`, `auth`, `native`, `engineConfiguration`, `capabilities`)는 화면 하위 호환을 위해 그대로 둔다. `engines`는 최상위에 추가한다. 능력 목록이 아니라 상태이기 때문이다. 화면이 기능 유무를 알 수 있도록 `capabilities.engines = ['registry', 'thread-lock']` 표시도 함께 둔다. [제안]

```json
{
  "engines": [
    {
      "id": "codex",
      "label": "Codex",
      "status": "ready",
      "version": "0.162.1",
      "versionSupported": false,
      "isDefault": true,
      "capabilities": ["stream", "resume", "nativeHistory", "interrupt", "approvals.command", "approvals.fileChange",
                       "userInput", "subagents", "dynamicTools", "boundedQa", "modelSelect.perTurn",
                       "effortSelect.perTurn", "usage.rateLimits"],
      "profiles": [
        {
          "id": "codex-default",
          "label": "ChatGPT",
          "credentialStore": "shared-user-default",
          "active": true,
          "auth": { "status": "signedIn", "method": "chatgpt", "account": "(지금 auth.accountEmail과 같은 공개 수준)", "planType": "pro" },
          "usage": "(지금 auth.usage = usageDisplay() 형태 그대로)"
        }
      ],
      "runtime": { "residentProcesses": 1, "residentLimit": 1, "idleTimeoutMs": null }
    },
    {
      "id": "claude",
      "label": "Claude",
      "status": "decisionPending",
      "statusReason": "SUB-12",
      "version": "2.1.300",
      "versionSupported": null,
      "isDefault": false,
      "capabilities": [],
      "profiles": [],
      "runtime": { "residentProcesses": 0, "residentLimit": 2, "idleTimeoutMs": 300000 }
    }
  ],
  "capabilities": { "engines": ["registry", "thread-lock"] }
}
```

- `status` 값: `ready` · `starting` · `offline` · `notInstalled` · `versionUnsupported` · `loginRequired` · `decisionPending` · `disabled`.
- `profiles[].auth.status`: `signedIn` · `signedOut` · `signingIn` · `unknown`. `method`: Codex는 `chatgpt`·`apiKey`, Claude는 `claude auth status`의 `authMethod`(`claude.ai`·`api_key`·`api_key_helper`·`oauth_token`·`third_party`·`none` [공식]).
- 넣지 않는 것: 토큰, 자격증명 파일·Keychain 경로, 실행 파일 절대경로(화면에 필요 없음). Claude 로그인 정보는 `claude auth status --json` 또는 SDK `accountInfo()`(email·organization·subscriptionType [공식 타입])에서 공개 필드만 쓴다. Keychain과 `.credentials.json`은 읽지 않는다(원장 SUB-08과 같음).
- 표시 이름은 'Claude'로 한다. 'Claude Code'를 기능명·제품명으로 쓰는 것은 금지다 [공식 브랜딩 조항].
- Claude 버전 표시: 결정 전에도 `claude --version` 정적 조회는 무해하므로 '설치됨 2.1.300'을 보여 줄 수 있다 [런타임: 이 Mac `2.1.300 (Claude Code)`].
- SSE: 엔진 상태가 바뀌면 `{type:'engine.status', v:1, engineId, status:<engines[] 한 줄>, ts}`를 보낸다. 기존 `auth.status`(Codex)는 유지한다.
- `chat.event` 봉투: `engineId`를 추가한다. `provider:'codex'`는 화면 필터(§2)가 넓어질 때까지 유지한다(§8 7단계).

---

## 8. 기존 런타임을 Codex 어댑터로 옮기는 단계별 계획

공통 규칙 [제안]:
- 각 단계는 **혼자 커밋해도 전체 테스트가 통과**해야 한다. 각 단계 시작 전후로 `node --test apps/firefox-ui-demo/helper/*.test.mjs`와 scripts 회귀(`docs/PATH_1_5_STABILIZATION.md:91-94`의 명령)를 실행해 기준선과 비교한다(이 문서 작성 중에는 실행하지 않음).
- 지금 다른 작업자가 `codex-chat-runtime.mjs`·`codex-bridge-server.mjs`·`eg-desk-surface.uc.js`를 고치고 있다. 2단계 이후는 그 작업이 커밋된 뒤에 시작해 충돌을 피한다.
- `CodexChatRuntime` 클래스 이름과 `'const chat = new CodexChatRuntime({'` 문자열은 마지막까지 유지한다(원문 단언 테스트). 이름을 바꾸려면 `export { ChatRuntime as CodexChatRuntime }` 별칭을 남긴다.

| 단계 | 바꾸는 것 | 바뀌지 않는 것 | 테스트 영향 | 완료 기준 |
|---|---|---|---|---|
| 0 기준선 | 전체 테스트 결과를 기록 | 코드 | — | 통과·skip 수 기록 |
| 1 어댑터 모듈 추가 | 새 파일 `helper/engine-adapter.mjs`(계약 주석, `ENGINE_CAPABILITIES`, 엔진 오류 코드, `validateEngineAdapter()`, Claude→kind 대응 함수), `helper/codex-engine-adapter.mjs`(기존 `request`/`respond` 통과: `startThread=p=>request('thread/start',p)` 등) | 기존 파일 전부 | 새 단위 테스트만 추가 | 새 테스트 통과, 기존 결과 동일 |
| 2 런타임이 어댑터로 호출 | 생성자에 `engines` 옵션 추가. 없으면 `{request, respond}`로 Codex 어댑터를 만든다. `this.request`·`this.nativeRespond`는 Codex 어댑터의 함수를 가리킨다(QA 정책 모듈 호환). Codex 호출 9곳을 `this.engineOf(cid).startThread()` 등으로 교체 | Codex 어댑터는 **같은 메서드 이름·같은 인자·같은 순서**로 `request`를 부른다. `config/read`와 QA 검증은 Codex 전용 탈출구로 남긴다 | 런타임 121건·bridge-http 23건이 수정 없이 통과해야 한다(특히 :1835) | 기존 결과 동일 |
| 3 엔진 기록(스키마 그대로) | §6.2: `native.thread.bound` details.engine, `run.engine`, 봉투 `engineId`, `send()`의 `body.engineId` 검증(없음 또는 `codex`만 허용, 나머지는 `ENGINE_UNAVAILABLE`), fingerprint 규칙 | 이벤트 순서, ownerHash 계산 | details·Run 전체를 deepEqual하는 테스트가 있으면 갱신(grep상 Run 하위 필드만 단언함). 엔진 필드 단위 테스트 추가 | 기존 대화 열기·이어 보내기 정상 |
| 4 엔진 registry + `/v1/state engines[]` | 새 `helper/engine-registry.mjs`(등록·기본 엔진·대화별 엔진 결정: `body.engineId` → 대화 바인딩 → 기본값). bridge에서 registry를 만들되 Codex만 등록하고 Claude는 `decisionPending` 설명만 둔다. `ensureChatAuth(body)`를 엔진별로, `assertReady(engineId)` | 기존 `/v1/state` 필드, 원문 단언 문자열 | `/v1/state` 형태 테스트 추가. 원문 단언 3개는 문자열을 지우지 않는 한 영향 없음 | 화면에서 엔진 목록 조회 가능 |
| 5 스키마 v2 | §6.3 이전 + 백업, `bindNative` 엔진 잠금, `thread()` 필드 | 이벤트·Run JSON | store 테스트 :86 수정, 이전·충돌 시험 추가 | v1 파일이 v2로 열리고 기존 대화 유지 |
| 6 연결 상태를 엔진별로 | `setConnection(engineId, ready, opts)`(첫 인자가 boolean이면 `codex`로 간주하는 호환 서명), `reset(engineId)`(Codex 계정이 바뀌어도 Claude Run은 그대로), Codex epoch는 기존 `this.epoch` 별칭 | Codex 동작 | 기존 `setConnection(false)` 호출 테스트 그대로 통과 | Codex 끊김이 다른 엔진 Run을 실패시키지 않음(단위 시험) |
| 7 화면 수용 | `reduceChatEvent`와 QA 계약의 `provider !== 'codex'` 필터를 엔진 목록으로 넓히고, 엔진 배지·잠금 표시(SUB-07). overlay 담당과 조율 | 런타임 | `scripts/egdesk-surface-state.test.mjs`(provider 고정 fixture 3곳), QA 계약 테스트 갱신 | Codex 화면 회귀 동일 |
| 8 Claude 어댑터(D1·D2 결정 후) | 8a 번역 순수 함수(stream-json 줄 → Codex 형태, fixture 단위 시험) → 8b 전송 모듈(CLI 또는 SDK) + 프로세스 관리(§9) → 8c 승인·질문 → 8d EG-Desk 도구 MCP(SUB-10) → 8e 중지·재개·오류 분류 | Codex 경로 | 가짜 전송(fake stdout / mock `query()`)으로 시험. 실제 계정 E2E는 대표님 로그인 필요 | 원장 SUB-09 단계 기준 |
| 9 (선택) Codex 기동 코드 이동 | app-server 기동·재연결·preflight를 `helper/codex-engine-process.mjs`로 이동(SUB-11 다계정에 필요) | 동작 | 원문 단언 테스트 3개를 **같은 커밋에서** 새 파일을 읽도록 수정 | 기존 결과 동일 |

---

## 9. 엔진별 RAM 대책

관찰 [런타임, 2026-10-24 `ps`]: 이 Mac의 Claude 데스크톱 앱이 띄운 `claude` 2.1.308 프로세스 3개가 모두 `--input-format stream-json --output-format stream-json` 방식이었고, RSS는 각각 148MB·153MB·590MB였다(실행 시간 1.5시간~10시간, 590MB는 긴 세션). 지금 EG-Desk bridge는 떠 있지 않아 Codex app-server RSS는 관찰하지 못했다. 같은 관찰에서 사용자 `~/.codex` 설정의 MCP 서버(playwright 등)가 별도 프로세스로 떠 있는 것도 보였다. 상속한 MCP가 프로세스 수를 늘린다는 근거다.

| 엔진 | 상주 단위 | 기본값 [제안] | idle 종료 | 상한 | 종료하지 않는 경우 |
|---|---|---|---|---|---|
| Codex | app-server 1개/활성 계정 슬롯(모든 대화가 공유) | 지금 그대로 1개 | 계정이 여러 개가 되면(SUB-11) 비활성 슬롯의 app-server를 진행 중 턴·대기 승인이 없을 때 5분 뒤 종료 | 활성 1 + 직전 1 | Context Reader 사용 중 |
| Claude | `claude` 프로세스 1개/대화 | 보낼 때 실행, 마지막 `result` 뒤 idle 5분이면 종료 | 우아한 종료 순서: stdin 닫기 → 10초 대기 → SIGTERM → 5초 → SIGKILL. 입력을 먼저 닫는 순서는 SDK의 공식 동작과 같다 | 동시 상주 2개. 넘으면 가장 오래 쉰 idle 프로세스를 종료하고, 모두 바쁘면 `ENGINE_BUSY`(429) | 진행 중 턴, 대기 중 승인·질문(SIGTERM은 턴을 미완료로 남김 [공식]) |

추가 규칙 [제안]:
- **턴이 끝난 뒤 남는 프로세스 막기**: `claude -p`는 턴이 끝나고 stdin이 닫혀도 백그라운드 작업을 기본 최대 10분 기다린다 [공식]. EG-Desk 실행에는 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`를 켜거나 `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`를 짧게 준다(변수 이름은 공식 문서에 있음, 정확한 효과는 env-vars 문서로 확인).
- **EG-Desk 도구는 추가 프로세스 없이 제공**: CLI 직접 실행이든 SDK든 'sdk' MCP 서버(`--mcp-config`의 `{"type":"sdk","name":"egdesk"}`)로 대화와 같은 stdin/stdout 파이프에서 제공한다(§5.3, `helper/egdesk-claude-mcp.mjs`). helper 포트를 열지 않고 Run별 토큰도 필요 없다. 대화마다 stdio MCP 자식을 띄우지 않는다. (2026-10-24 갱신: 이전의 loopback HTTP MCP + Run 토큰 계획은 쓰지 않는다 [제안].)
- **사용자 MCP 상속 차단**: `--strict-mcp-config` [공식]로 `--mcp-config`에 준 서버만 쓰게 한다. 사용자 MCP 서버는 대화마다 각자 프로세스로 뜬다. D2와 연결된다. SDK도 sdk 서버를 넣은 `--mcp-config`와 `--strict-mcp-config`를 함께 붙이므로(`subprocess_cli.py` `_build_command`) 둘을 같이 쓰는 조합은 SDK 설계 안에 있다 [조사: 코드].
- **Agent SDK의 프로세스 수**: SDK는 helper(Node) 안에서 돌고 `claude` 자식 1개를 띄우므로 CLI 직접 방식과 프로세스 수가 같다. SDK 모듈이 helper 메모리에 더해지는 양은 측정이 필요하다 [추정].
- **승인 대기 중 메모리**: 승인을 기다리는 대화는 프로세스를 계속 잡고 있다. 나중에 `PreToolUse` hook의 `defer` 결정으로 프로세스를 내렸다가 재개하는 방식을 검토할 수 있다 [공식 기능, 적용은 제안].
- **측정**: `helper/system-resource-monitor.mjs`에 엔진 프로세스 RSS 합계를 더하고 `engines[].runtime`에 노출한다. idle 시간과 상한은 측정한 뒤 조정한다.

---

## 10. Claude 연결 방식 선택지별 차이 (엔진 계층에 미치는 영향만)

(a) 앱 안 claude.ai 로그인은 Anthropic이 금지하므로 제외한다 [공식, 원장 인용].

| 구분 | (b) 설치된 `claude` CLI 직접 실행 | (b') Agent SDK + 사용자 설치 `claude` | (c) API 키 |
|---|---|---|---|
| 어댑터에서 바뀌는 곳 | 전송 모듈(stdin/stdout 줄 처리) | 전송 모듈(`query()`) | 인증만. 전송은 (b) 또는 (b')를 재사용하고 env에 키를 넣는다(SUB-15) |
| 프로세스 | 대화당 `claude` 1개 | 같음(SDK가 띄움) | 같음 |
| 승인·질문 | `--permission-prompt-tool stdio` 제어 통로(§5.3). 공식 SDK가 canUseTool을 구현하는 바로 그 통로라 승인과 AskUserQuestion이 함께 온다 [조사: SDK 코드]. Claude 데스크톱도 같은 플래그로 쓴다 [런타임]. CLI 공개 문서의 계약은 아님 | `canUseTool` 콜백 하나로 승인과 AskUserQuestion을 모두 받는다 [공식] (내부적으로 같은 stdio 통로) | 전송 방식을 따름 |
| 중지 | SIGINT(턴 종료 [공식], 프로세스 생존 미확인) | `interrupt()` [공식] | 전송 방식을 따름 |
| 턴 중 모델 변경 | 재시작 | `setModel()` [공식] | 전송 방식을 따름 |
| EG-Desk 도구 | 'sdk' MCP(같은 파이프의 `mcp_message`) | 같은 프로세스 안 MCP(`createSdkMcpServer`, 내부적으로 같은 `mcp_message`) | 전송 방식을 따름 |
| 의존성 | 없음(사용자 `claude`) | npm `@anthropic-ai/claude-agent-sdk` 추가. 플랫폼별 바이너리를 optional dependency로 함께 받으므로 `pathToClaudeCodeExecutable`로 사용자 설치본을 지정해야 (b)와 같은 정책 해석이 유지된다 [공식] | — |
| 버전 | `claude`는 자동 업데이트된다 → 최소 버전 + `system/init.capabilities`로 기능을 확인한다(공식 권고) | SDK 버전이 번들 CLI 버전을 따라간다(공식 예: SDK 0.3.191 ↔ CLI 2.1.191). 사용자 설치본(2.1.300)과 맞지 않으면 프로토콜 차이 위험 [추정] | 같음 |
| 정책 문구 | "end user signing in to the unmodified Claude Code binary with their own Claude subscription"을 막지 않는다는 문구 [공식]에 가장 가깝다. 개인·내부 사용 해석은 [제안] | 같은 문서에 "Developers … including those using the Agent SDK, should use API key authentication" [공식]이 있다. **구독 + SDK 조합이 문구상 가장 애매하다** | 명확히 허용(종량 과금) |
| 사용 한도 | 구독 한도에서 차감 [공식, 원장 인용] | 같음 | 키 소유자 종량 과금 |
| `--bare` | 쓸 수 없음(OAuth를 안 읽음) [공식] | 같음 | 쓸 수 있음 |
| 앞으로의 위험 | "`--bare` … will become the default for `-p`" [공식] → 구독 경로가 바뀔 수 있으므로 버전 게이트와 `system/init.apiKeySource` 확인 필요 | 같음 | 영향 없음 |
| 시험 | 가짜 stdout 줄 fixture | `query()` mock | 같음 |

공통 실행 조건 [제안, 근거 공식]:
- 구독 프로필로 실행할 때는 env에서 `ANTHROPIC_API_KEY`·`ANTHROPIC_AUTH_TOKEN`·`CLAUDE_CODE_OAUTH_TOKEN`을 뺀다. `-p`에서는 `ANTHROPIC_API_KEY`가 있으면 항상 그것을 쓴다 [공식 인증 우선순위].
- `--permission-mode`를 항상 명시한다. 2.1.302부터 `-p` 기본이 Manual로 바뀐다 [공식]. 이 Mac의 2.1.300 `--help` 선택지는 `acceptEdits·auto·bypassPermissions·manual·dontAsk·plan`이다 [공식 `--help`].
- 계정 슬롯은 `CLAUDE_CONFIG_DIR`로 나눈다. 디렉터리마다 로그인·Keychain 항목이 따로 있다 [공식](D5).

권고 [제안]: 번역 계층은 SDKMessage 형태를 기준으로 만들고, 전송 모듈은 결정 후 하나만 구현한다. 정책 문구 기준으로는 (b)가 (b')보다 해석 부담이 작고, 구현 편의는 (b')가 크다. (2026-10-24 갱신) (b)를 골라도 승인·질문·EG-Desk 도구는 SDK와 같은 stdio 제어 통로로 하므로 (b')와 구현 차이는 '줄 읽기·쓰기를 직접 하느냐'뿐이다. 이전 권고(승인은 MCP `--permission-prompt-tool`, 질문은 EG-Desk 질문 도구로 대체)는 쓰지 않는다. MCP prompt tool은 '사용자 상호작용 필요' MCP 도구를 승인하지 못한다는 공식 cli-reference 문구도 근거다(레퍼런스 채택 지도 3.1).

---

## 11. 대표님 결정이 필요한 지점

| # | 결정 | 선택지와 영향 | 현재 권고 [제안] | 막히는 것 |
|---|---|---|---|---|
| D1 | Claude 연결 방식 (SUB-12) | (b) CLI 직접: 정책 해석이 가장 단순, 승인 경로 검증이 더 필요. (b') SDK: 구현이 쉬움, 구독과 함께 쓰면 정책 문구가 애매하고 npm 의존 추가. (c) API 키: 정책 명확, 종량 과금. (b)+(c) 병행 가능(엔진 계층은 같고 계정 슬롯만 다름) | 개인·내부용 (b), (c)는 SUB-15 별도 계정 슬롯으로. 외부 배포 전 Anthropic 문의 | §8 8단계 전체 |
| D2 | `~/.claude` 설정 상속 (SUB-09) | 상속: 재로그인 없음. 대신 대표님 hooks·CLAUDE.md·MCP·skills가 EG-Desk 채팅 안에서 돌아 동작 예측이 어렵고, MCP 서버가 대화마다 떠서 RAM이 는다. 격리(`CLAUDE_CONFIG_DIR`): 처음 1회 로그인, 동작 예측 가능. 중간안: 로그인은 공유하고 `--strict-mcp-config` + `--setting-sources` 제한, 후보로 `--safe-mode`(CLAUDE.md·skills·plugins·hooks·MCP 끄고 인증 유지 [공식 `--help`]). 단 `--mcp-config`로 준 EG-Desk MCP까지 꺼지는지, `--setting-sources`로 hooks와 CLAUDE.md가 빠지는지는 미확인 | 중간안을 먼저 검증하고, 안 되면 격리 | 8b |
| D3 | 대화 중 엔진 전환 | 잠금(엔진을 바꾸면 '새 대화로 이어가기' + 요약 전달) / 같은 대화에서 전환(기록을 새 엔진에 다시 보냄). 2026-04-19 MULTI_CLI §13.5("provider 전환 시 기존 대화 내역을 보존하고 그대로 submit")와 SUB-06("진행 중인 작업은 원래 엔진에서 끝남")이 부딪힌다 | 대화는 엔진에 잠그고, 전환은 새 대화로 이어 가기. §13.5 갱신 필요 | 7단계 화면 |
| D4 | 기본 엔진 기억 범위 (HUM-ENGINE-001) | 앱 / Desk / 방 / 요청. MULTI_CLI §13.1은 이미 '최근 사용 provider'로 정했다 | §13.1 유지(앱 전역 최근 사용) + 방별 잠금. 그대로 받아들이면 추가 결정 불필요 | SUB-07 |
| D5 | EG-Desk 전용 로그인 저장소 (SUB-11) | 공유: 터미널과 같은 로그인이라 EG-Desk에서 로그아웃하면 터미널도 끊긴다(Codex는 지금 이렇다). 전용: `CODEX_HOME`·`CLAUDE_CONFIG_DIR`를 EG-Desk 폴더로, 처음 1회 로그인, 계정 여러 개 가능 | 1차는 공유(지금 Codex와 같게), 다계정 요구가 생기면 전용 | SUB-11 |

Main 개발자 선에서 정할 것(대표님 결정 불필요): 일반 도구 승인 카드 추가 시점, `multiSelect` 질문 UI, thinking 표시 여부, Claude idle 시간과 상주 상한 값(측정 후).

---

## 12. 위험·미확인 목록

| 항목 | 상태 | 확인 방법 |
|---|---|---|
| CLI stream-json 입력 줄 형식 | [추정] SDKUserMessage 형태 | 실제 실행 1회(결정 후) |
| stdio 제어 통로(`can_use_tool`·`mcp_message`·`control_response`) 형식 | (2026-10-24) 공식 SDK 코드로 형식 확인 [조사]. CLI 공개 문서의 계약은 아님. 부품은 fixture 시험만 통과 | D1 뒤 실제 실행 1회. 형식이 다르면 `claude-engine-permissions.mjs`·`egdesk-claude-mcp.mjs`의 변환만 고친다 |
| AskUserQuestion이 승인 통로로 오는가 | (2026-10-24) stdio 통로에서는 `can_use_tool`로 온다(claude-agent-acp 코드 주석·구현) [조사] | 실제 실행 |
| 승인 응답에 SDK TS가 덧붙이는 필드(`toolUseID`, `decisionClassification`)가 필요한가 | Python SDK는 보내지 않음 → 부품도 보내지 않음 [조사] | 실제 실행 |
| tools/call의 `_meta['claudecode/toolUseId']`로 tool_use id가 오는가 | [추정]. 없으면 부품이 자체 callId를 쓴다(기능 영향 없음, 활동 행과 짝만 약해짐) | 실제 실행 |
| `--allowedTools mcp__egdesk`가 그 서버의 모든 도구에 맞는가 | [추정]. 안 맞아도 `can_use_tool`로 오면 부품이 허용한다 | 실제 실행 |
| EG-Desk 도구 호출(tools/call)의 CLI 쪽 MCP 시간 제한 | 미확인. 가장 긴 `egdesk_browser_wait`는 10초+여유 | 실제 실행 |
| SIGINT 뒤 stream-json 프로세스 생존 | 미확인. (2026-10-24) 중지는 `control_request {subtype:'interrupt'}`를 기본으로 하므로 SIGINT는 예비 수단 [제안] | 실제 실행 |
| `system/init`이 첫 입력 전에 나오는가 | 미확인 | 실제 실행(threadId는 미리 정하므로 설계 영향 작음) |
| `--system-prompt-snapshot` 기본 on과 Profile 지침 변경 | [공식 `--help`] 충돌 소지 | `off` 지정 시 재개에서 새 지침 반영 확인 |
| 2.1.302 `-p` 기본 Manual, `--bare` 기본화 예고 | [공식] | 버전 게이트 |
| 로그인 상태의 이메일·구독 종류 필드 | CLI는 미확인, SDK `accountInfo()`는 있음 [공식 타입] | 로그인 상태에서 `claude auth status --json` |
| `TodoWrite` 입력 구조·최신 계획 도구 이름 | 미확인 | 도구 스키마 확인 |
| Claude 대화 기록을 엔진에서 다시 받을 공식 경로 | 미확인 → 로컬 기록이 원본 | — |
| Codex ownerHash 접두어 변경 | 바꾸면 기존 대화 전부 불일치 | Codex는 바꾸지 않음(§6.2) |
| Context Reader는 Codex 전용 | 사실 | Claude만 쓰는 시나리오에서 빠지는 기능 표시 |
| MCP 승인 대기 시간 제한 | (2026-10-24) 승인은 stdio 통로라 해당 없음. EG-Desk 도구 호출만 위 행 | — |
| 다른 작업자와 파일 충돌 | 진행 중 | 2단계 이후는 그 커밋 뒤에 시작 |

---

## 13. 출처

공식 문서(2026-10-24 조회):
- Headless(`claude -p`, stream-json, `--bare`, SIGTERM, `api_retry`, `system/init`, 권한, 재개): https://code.claude.com/docs/en/headless
- CLI reference(`--permission-prompt-tool`, `--permission-prompts`, `--include-partial-messages`, `--replay-user-messages`, `--session-id`, `--strict-mcp-config`, `claude auth status`): https://code.claude.com/docs/en/cli-reference
- Agent SDK TypeScript(`query()`, `Query` 메서드, `Options`, `CanUseTool`, `PermissionResult`, SDKMessage 타입, `AccountInfo`, 번들 바이너리·`pathToClaudeCodeExecutable`): https://code.claude.com/docs/en/agent-sdk/typescript
- Agent SDK 승인·질문(`canUseTool`, AskUserQuestion 형식·제한): https://code.claude.com/docs/en/agent-sdk/user-input
- 인증(`CLAUDE_CONFIG_DIR`별 로그인 분리, Keychain, 우선순위, `--bare`와 OAuth): https://code.claude.com/docs/en/authentication
- Legal and compliance(서드파티 claude.ai 로그인 금지, 무수정 바이너리, Agent SDK 개발자는 API 키, 이름·로고): https://code.claude.com/docs/en/legal-and-compliance
- `--permission-prompt-tool` 응답 형식(커뮤니티, 비공식): https://github.com/anthropics/claude-code/issues/1175 , https://github.com/UnknownJoe796/claude-code-mcp-permission
- 원장이 인용한 정책·한도 자료(재확인 안 함): code.claude.com/docs/en/agent-sdk/overview, support.claude.com/en/articles/15036540, docs.aside.com/help/ai

레퍼런스 코드(2026-10-24 갱신 때 읽음, 패턴만 따름):
- anthropics/claude-agent-sdk-python (MIT, 2026-10-24 push): `src/claude_agent_sdk/_internal/query.py`(`initialize`, `_read_messages`의 control 분기, `_handle_control_request`의 can_use_tool·mcp_message, `interrupt`·`set_model`), `_internal/sdk_mcp_bridge.py`(재초기화·ping·미지원 메서드), `_internal/transport/subprocess_cli.py`(`_build_command`: `--permission-prompt-tool`, sdk 서버를 넣은 `--mcp-config`, `--strict-mcp-config`), `types.py`(`_configure_can_use_tool` → `"stdio"`, `SDKControlPermissionRequest`, `PermissionUpdate` destination, `RateLimitType`)
- agentclientprotocol/claude-agent-acp (Apache-2.0): `src/elicitation.ts`(`applyAskElicitationResponse`: 건너뛰기 = 빈 answers, 복수 선택 이음), `src/permissions/normalization.ts`·`effects.ts`(제안 검증, allow/deny 모양), `src/acp-agent.ts` `handleAskUserQuestion`
- pingdotgg/t3code (MIT): `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` `permissionResultFromDecision`·`toSessionPermissionUpdates`, `apps/server/src/provider/claudeUsageLimits.ts`(rateLimitType → 5시간/주간 창)

로컬:
- `claude --version` → `2.1.300 (Claude Code)`, `claude --help`, `claude auth --help`, `claude auth status --help`(정적 조회) [런타임]
- `ps` 관찰: Claude 데스크톱 앱의 `claude` 2.1.308 stream-json 프로세스 플래그와 RSS [런타임]
- `references/claude-code/CHANGELOG.md`(2.1.81까지, `--bare`·`--include-partial-messages`·`CLAUDE_CONFIG_DIR` 이력). `references/claude-agent-sdk/`는 비어 있음
- 코드: `apps/firefox-ui-demo/helper/codex-chat-runtime.mjs`, `codex-bridge-server.mjs`, `egdesk-chat-store.mjs`, `codex-chat-values.mjs`, `codex-bridge-http.mjs`, `egdesk-native-capabilities.mjs`, `overlay/resources/EGDeskChatState.sys.mjs`, `docs/MULTI_CLI_CHAT_UIUX_IMPLEMENTATION_PLAN_V1.md`, 테스트 파일(§2)

---

## 14. Claude 어댑터 연결 상태 (묶음 2-E, 2026-10-24)

### 14.1 대표님 화면에서 달라지는 점

- 설정 '계정 & AI 엔진'의 Claude 줄이 '연결 방식 결정 대기'에서 실제 상태로 바뀐다: `ready` · `loginRequired` · `notInstalled` · `versionUnsupported`(버전 미확인·하한 미만·이 버전이 기능 목록을 보내지 않음) · `offline`(아직 확인 전·로그인 답이 이상함). [런타임: 단위 시험]
- 로그인이 안 돼 있으면 Terminal 카드에서 공식 로그인을 띄운다. EG-Desk는 명령 한 줄만 주고 자격증명은 보지 않는다(§14.4). [런타임: 단위 시험]
- EG-Desk 환경에 Anthropic API 키가 있으면 Claude 줄에 `statusReason: 'CLAUDE_API_KEY_DETECTED'`가 붙고, 확인 전에는 Claude 대화를 시작하지 않는다. 확인하면 이번 helper 실행 동안 키를 빼고 구독으로 돈다. [런타임: 단위 시험]
- 한도 도달은 초기화 시각만 보여 주고 저절로 다시 보내지 않는다(`usage.autoResume: false`). [런타임: 단위 시험]
- **2026-10-24 시점에는 저장소가 있는 Chat에서 Claude 전송이 차단돼 있었다.** 이 공통 차단은 2026-10-25 제거하고 저장된 엔진·계정 바인딩 검증으로 대체했다. 이것만으로 Chat 사용 완료나 실계정 동작을 뜻하지 않으며, 현재 화면·자료 연결 제한은 §14.7에 기록한다.

### 14.2 구성 [런타임: 단위 시험, 실제 `claude` 미실행]

| 부품 | 역할 | 파일 |
|---|---|---|
| 어댑터 | EngineAdapter 계약. 대화당 프로세스 1개, 첫 turn에 실행, 마지막 turn 뒤 5분 idle이면 종료, 동시 상주 2개(넘으면 가장 오래 쉰 것을 닫고, 모두 바쁘면 `ENGINE_BUSY` 429) | `helper/claude-engine-adapter.mjs` |
| 전송 | `claude -p` stream-json 양방향, `--permission-prompt-tool stdio`, initialize, 제어 요청 | `helper/claude-engine-transport.mjs`(+ `--tools`, `--system-prompt-snapshot` 추가) |
| 승인·질문 | `can_use_tool` → `item/commandExecution/requestApproval`·`item/fileChange/requestApproval`, `item/tool/requestUserInput`. '이번 대화 동안 허용'(`acceptForSession`)도 제안한다 | `helper/claude-engine-permissions.mjs` |
| EG-Desk 도구 | 대화의 도구 목록(startThread `dynamicTools`)을 'sdk' MCP로. `--allowedTools mcp__egdesk` | `helper/egdesk-claude-mcp.mjs` |
| 번역 | Claude 출력 → thread/turn/item 알림, `egdesk/engine/rateLimit` | `helper/claude-stream-translate.mjs` |
| 게이트 | 설치·버전·로그인 정적 확인(표시 하한 = 실행 하한 2.1.205로 맞춤) | `helper/claude-engine-auth.mjs` |
| 행 | 위 상태 결정, 연결 전 목록 전용 행(`decisionPending`)은 어댑터 없이 부를 때만 | `helper/engine-registry.mjs` `describeClaudeEngine(check, connection)` |

메서드 대응:
- `startThread` → 대화 id = Claude 세션 UUID를 정하고 기록만 만든다(프로세스 없음). 첫 turn이 `--session-id=<UUID>`로 실행한다.
- `startTurn` → 프로세스가 없으면 실행(이후는 `--resume=<UUID>`), `turn/started`를 보내고 사용자 줄을 쓴다. 모델·추론 강도가 바뀌면 프로세스를 닫고 `--resume`으로 다시 연다. 작업 폴더는 대화를 시작한 폴더로 고정(`CWD_CHANGE_UNSUPPORTED` 409, Claude 세션 파일이 폴더별로 저장되기 때문).
- `interruptTurn` → `control_request {subtype:'interrupt'}`. 10초 안에 답이 없거나 15초 안에 turn이 끝나지 않으면 프로세스를 닫고 그 turn을 `interrupted`로 끝낸다(claude-agent-acp `cancelTurns`의 backstop 패턴).
- `releaseThread` → 프로세스를 닫는다. `resumeThread` → 기록을 다시 열고 다음 turn이 `--resume`. 이번 helper 실행에서 처음 보는 UUID도 `--resume`으로 연다(도구 목록은 런타임이 넘겨야 함, §14.6).
- 프로세스가 turn 중에 끝나면 그 turn만 `turn/completed {status:'failed', error.code:'RUNTIME_LOST'}`(기능 확인 실패면 그 코드), 대기 중 승인은 `serverRequest/resolved`. 엔진 전체 연결은 그대로다(§4.1).
- `sink.connection`은 로그인·버전·계정이 바뀔 때만 보낸다. 다른 계정이면 `{ready:false}` 뒤 `{ready:true}`.
- 시작 전에 거절한 오류에는 `definite: true`를 붙인다(아무것도 Claude에 가지 않았음).

### 14.3 격리와 실행 플래그 (D-S2·D-S4)

- 항상: `-p --output-format stream-json --input-format stream-json --verbose --permission-prompt-tool stdio --settings {"disableAllHooks":true} --setting-sources= --strict-mcp-config --disable-slash-commands --include-partial-messages`, env는 허용 목록 + `ENABLE_CLAUDEAI_MCP_SERVERS=false`, API 키 변수는 넘기지 않는다. HOME·`CLAUDE_CONFIG_DIR`은 그대로라 로그인을 공유한다. [공식 `--help` 2.1.300 · 코드]
- 2.1.300 이상에만: `--permission-mode manual`('바꾸기 전에 늘 묻기', 읽기 도구는 묻지 않음 — claude-agent-acp `session-mode.ts:358-362`), `--system-prompt-snapshot=off`(대화 중 Agent 지침이 바뀌어도 재개에서 반영). 더 낮은 버전은 이 두 플래그를 받는지 확인하지 않았다.
- 도구가 있을 때만: `--mcp-config {"mcpServers":{"egdesk":{"type":"sdk","name":"egdesk"}}}`, `--allowedTools mcp__egdesk`.
- CLAUDE.md·skills는 어댑터 옵션 `inherit: { instructions, skills }` 자리만 있고 bridge는 끈 채로 둔다.
- 승인 카드가 없는 도구(WebFetch, WebSearch 등)를 Claude가 물으면 묻지 않고 거절한다(`approvals.tool` 능력 없음).

### 14.4 bridge 경로

| 경로 | 하는 일 |
|---|---|
| `GET /engines/claude/login-command?method=claudeai` (또는 `console`) | `{ method, billing, argv, line: 'claude auth login --claudeai', credentialStore: 'claude-cli', afterward: { method:'POST', route:'/engines/claude/refresh' } }`. 화면은 `POST /terminal/spawn` 뒤 `/terminal/write`로 `line` + Enter를 쓰고, 끝나면 refresh를 부른다. `console`은 D-S4 API 키 프로필(키는 CLI가 보관). 실행 파일 경로는 넣지 않는다(사용자 셸의 PATH 이름 `claude`). |
| `GET /engines/claude/api-key-env` | `{ detected: [변수 이름], confirmed, engine }` (값은 읽지 않음) |
| `POST /engines/claude/api-key-env {confirm: true}` (`false`면 취소) | D-S4 확인(이번 helper 실행 동안만, 저장 안 함) |
| `POST /engines/claude/refresh` | 기존 그대로. 바뀌면 어댑터 게이트를 다시 계산한다 |

`engines[].profiles[0].usage`(Claude): `usageDisplay` 형태(`level`, `percentLabel`, `windowLabel`, `resetLabel`, `resetsAt`, `stale`) + `windows`, `rejected`, `creditsRequired`, `billing`(`'subscription'` 또는 `'apiKey'`)(system/init `apiKeySource`), `autoResume: false`.

### 14.5 확인하지 못한 것 (이 Mac `claude` 2.1.300이 로그아웃 상태: `auth status` → `loggedIn:false`, `authMethod:'none'`)

| 항목 | 상태 |
|---|---|
| stdio 왕복(initialize → user 줄 → result) | 가짜 `claude`로만 [런타임: 단위 시험] |
| `--setting-sources=`(빈 값) 수락, CLAUDE.md 제외 | 미확인 |
| `system/init.capabilities` 실제 목록, `permissionMode` 값 | 미확인. 어댑터는 목록이 **있는지만** 요구한다(`requiredCapabilities: []`) |
| `--permission-mode manual`·`--system-prompt-snapshot=off`가 stream-json 모드에서 받아지는지 | `--help` 문구만 [공식] |
| 구독 로그인 공유(Keychain)와 격리 플래그의 조합 | 미확인 |
| `--resume` + `--include-partial-messages` 조합, 재개 뒤 tools/list 재요청 | 미확인 |

확인 절차(`claude auth login` 뒤 1~2회, 빈 임시 폴더): `createClaudeTransport({ executablePath, cwd: <임시폴더>, tools: [], sessionId: <새 UUID>, onMessage })`로 내장 도구까지 끈 채 `start()` → `sendUserMessage('Reply with exactly: ok')` → `result`를 받으면 `close()`. 받은 이벤트 종류(`type`/`subtype`)와 `system/init`의 `capabilities`·`permissionMode`·`apiKeySource`만 기록하고 답변 원문은 남기지 않는다. 그다음 같은 조건으로 어댑터(`startThread({cwd})` → `startTurn`)를 1회.

### 14.6 런타임(2-R)에 필요한 변경 — 계약

1. `send()`의 `this.store && engineId !== 'codex'` 거절을 풀고, 저장소의 `native.thread.bound`·`assertNativeAccount`가 Claude 바인딩을 받게 한다(ownerHash는 `adapter.ownerKey()` 해시, 형식 `claude:<method>:<email 소문자>`).
2. `this.respond`가 Codex 응답기로만 가는 대신 rpc id의 엔진으로 보낸다(`adapter.owns?.(id)` 또는 `claudeRpcThreadId(id)` → `threadEngine`). 지금은 bridge가 Codex 응답기 앞에서 `claudeEngine.owns(id)`로 대신 가른다.
3. `replyApproval`·`replyUserInput`의 `this.assertReady()`를 그 Run의 엔진 기준(`assertReady(this.runEngine(run))`)으로. 지금은 Codex가 끊기면 Claude 승인도 막힌다.
4. 승인 선택지 필터(`['accept','decline','cancel']`)에 `acceptForSession`을 통과시키면 '이번 대화 동안 허용'이 동작한다(어댑터는 이미 제안하고 `updatedPermissions` destination 'session'으로 보낸다).
5. 질문 공개 형태에 `multiSelect: true`를 남긴다(`safeUserInputQuestions`). 답은 `answers: { q0: { answers: [라벨…] } }` 그대로.
6. `cleanNotification`이 `egdesk/engine/rateLimit`(`{engineId, status, window, windowMinutes, resetsAt, utilization, usedPercent, overageStatus, creditsRequired}`)을 버리지 않고 Run 오류·한도 표시에 쓴다. 자동 재시도는 하지 않는다(D-S5).
7. 시작 전 거절(`error.definite === true`, 예: `CLAUDE_API_KEY_DETECTED` 409, `ENGINE_BUSY` 429)은 숫자 코드가 아니어도 '불확실한 대화'로 표시하지 않는다(`uncertainThreads`).
8. 재개(`resumeThread`)에 그 대화의 `dynamicTools`와 기록된 `cwd`를 넘긴다(Claude는 도구 목록을 세션에 저장하지 않고, 세션 파일은 폴더별이다).

출처(2-E에서 읽음): claude-agent-sdk-python `_internal/client.py:177-189`(initialize 뒤 prompt 줄), `types.py:1509-1512`(init.capabilities, 2.1.205부터); claude-agent-acp `src/acp-agent.ts:8620-8913`(cancelTurns·backstop), `:2903-2941`(터미널 로그인 방법 `auth login --claudeai|--console`), `src/session-mode.ts:358-362`('Manual' = default 모드); `claude 2.1.300 --help`(`--tools ""`, `--system-prompt-snapshot`, `--permission-mode` 선택지), `claude auth login --help`(`--claudeai`, `--console`).

### 14.7 후속 연결 체크포인트 (2026-10-25)

§14.6은 최초 인수인계 계약이다. 다음은 그 이후 구현·검증 상태이며, 실제 Claude 로그인이나 구독 모델 응답을 확인했다는 뜻은 아니다.

| 경계 | 구현과 검증 범위 |
|---|---|
| 저장·인증·응답 | 대화에 저장된 엔진과 계정을 검증한 뒤 전송·재개·승인·질문 응답을 처리한다. 요청의 엔진 지정이 바인딩과 다르면 거부한다. Codex가 끊겼다는 이유만으로 준비된 Claude의 HTTP 요청을 막지 않는다. 실제 HTTP handler·저장소·어댑터와 가짜 전송으로 시험했다. |
| 재개·불확실성 | 기록된 cwd와 검증된 원래 도구 subset만 복원한다. 원래 manifest를 확인할 수 없으면 축소하거나 새 대화로 몰래 대체하지 않는다. 시작 전 확정 거절과 이미 전달됐는지 알 수 없는 실패를 구별한다. |
| 승인·질문·한도 | 일회성/세션 권한을 구별하고 Agent 상한을 재검사한다. 복수 선택은 고른 라벨 배열을 보낸다. 해당 Run의 한도·초기화 시각을 전달하지만 자동 재전송하지 않는다. 실제 응답 전달 실패를 성공으로 표시하지 않는다. |
| 프로세스 재시작 | permission/MCP 요청 번호를 어댑터 단위로 증가시킨다. crash·release/resume·모델 변경·퇴출 뒤 동일한 CLI request_id가 다시 와도 이전 응답은 새 요청에 적용되지 않는다. 숫자 한계에 도달하면 재사용하지 않고 거부한다. |
| 선택 자료·EG-Desk provider | **Claude 연결에서는 아직 미지원.** 선택 자료가 있으면 전송 전에 명시적으로 거부하며 Codex 계정·권한으로 우회하지 않는다. Codex 의존 provider는 Claude의 새 도구 목록에서 제외한다. 해당 provider를 포함한 과거 manifest는 검증을 완화해 복원하지 않는다. 최종 제품 능력을 폐기한 결정이 아니라 B2 엔진별 Context 연결 전의 구현 제한이다. |
| 중앙 백엔드 회귀 | `node --test helper/*.test.mjs`: 1,138 pass / 0 fail / 9 skip. 별도 검토자가 관련 109개와 재시작 RPC 관련 8개를 실행해 확인했다. skip은 성공으로 세지 않았다. |
| 계정 전환 중 캡처 | Codex 계정이 바뀌면 이전 Codex 요청·자료 캡처 토큰만 무효화하고 Claude 요청은 유지한다. 실제 지연 Browser·파일 캡처 함수를 시험해 이전 계정의 후속 캡처 POST 0건을 확인했고 독립 검토를 다시 받았다. |
| 화면 연결 | 준비된 Claude와 로그아웃된 Codex를 제공하는 격리 fixture에서 실제 UI 전송·같은 방 재개·세션 승인 유무·복수 선택·한도·선택 자료 차단을 12/12 확인했다. 엔진 메뉴의 Canvas 좌표 보정과 한도 문구 여백은 스크린샷으로도 확인했다. 선택 자료 차단은 요청문·첨부를 보존하며 capture/send HTTP를 보내지 않는다. |
| 중앙 화면 코드 회귀 | `node --test scripts/*.test.mjs`: 930 pass / 0 fail / 1 skip / 0 todo. 기존 대화 fixture 72/72도 재실행했다. fixture는 임시 프로필·전용 포트·검증된 복사본만 사용하며 실제 모델 호출은 없다. |
| 실계정 범위 | 실제 CLI 로그인·모델 왕복, 운영 프로필 적용, OS 포커스·입력 검증은 이번 체크포인트에 포함하지 않는다. 화면 fixture는 어댑터의 실계정 실행·권한의 실제 지속·CLI 프로세스 전체 재시작을 입증하지 않는다. |

실계정 시험은 §14.5의 과거 절차가 있다는 이유만으로 실행하지 않는다. 계정과 시험 범위를 확인한 별도 실행으로 남긴다.
