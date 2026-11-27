# EG-Desk Product Vision and Development Todo

**Status**: Living source-of-truth index
**Implementation path**: `apps/firefox-ui-demo/`
**Last updated**: 2026-11-19

This document tracks product decisions and development backlog items that came from active design/development discussion. It is not a marketing whitepaper. The public-facing whitepaper is [Production v8](../../docs/production/EG-DESK%20백서%20-%20Production_v8_한글.md), while this file keeps the current product/runtime direction and todo surface aligned.

Board is the product term used here. Some current runtime identifiers (for
example `state.agenda`, `data-agenda-id`, search result type `agenda`) still say
`Agenda`; since 2026-10-24 the visible overlay copy says Board (`Board Thread`,
`Board 검색...`, `Board를 전환할까요?`) and the former English status words are
Korean. Checked backlog items describe the underlying behavior.

## 구현 현황 — 2026-09-27

검증은 2026-09-26(KST)에 시작해 9월 27일까지 이어졌다. 로컬 브랜치
`codex/local-product-foundation`의 체크포인트는 `217482b`이다.
최종 런타임 코드 기준은 `f88eeb5`이며 Markdown 표시 보정과 문자열
`Origin: null` 거부를 포함한다. 선정한 로컬 기반의 구현·검증은 완료됐고
원격 push는 없었다. 완료 범위는 Firefox Shell 프로토타입의 선정한 로컬
기반이며 제품 전체와 Gecko 독립 배포·패키징은 포함하지 않는다.

- 구현 범위: 브라우저 우선 진입, 독립적으로 투영·저장되는 Board, 일반 Codex
  app-server 기반 Chat 스트림·활동 표시·중지·수동 승인·`artifactRefs`.
  일반 런타임의 작업 디렉터리 전달과 잘못된 작업 디렉터리의 네이티브 RPC
  이전 `400 INVALID_CWD` 거부도 코드에 반영됐다. Terminal 초기화는 CSP가
  허용하는 외부 리소스로 옮겼으며 CSP와 보안 정책은 완화하지 않았다.
  후속 Origin 검사는 문자열 `null`을 거부하고 헤더가 없는 정상 요청은 유지한다.
  Markdown 표시 보정도 반영됐으며 CSP·principal 보안 경계를 완화하지 않았다.
- 검증 범위: `f88eeb5` 기준 Node 통합 검사 184/184(UI 73, helper 79,
  profile guard 9, QA 인프라 23)가 통과했다. 알려진 P1/P2 항목과 최종
  Markdown·Origin 변경의 정적 검토도 통과했다. 실제 Firefox 첫 사용 8/8,
  전체 Chat fixture 43/43, 기존 ChatGPT 인증의 실제 Chat UI artifact
  16/16, 실제 네이티브 Terminal 11/11, 최종 완료 응답의 제어된 이어검사 16/16이
  통과했다. 손상된 Desk는 제어된 이어가기 5/5와 같은 프로필 재시작 4/4,
  부분 Desk는 최초 복구 5/5와 재시작 4/4에서 원본과 새 작업을 보존했다.
  이전 `UI301`의 Board 4개 흐름도 통과했다. QA 인프라 23건은 앱 수용
  건수와 구분한다. 검증 유형과 적용 범위는
  [`PATH_1_5_STABILIZATION.md`](../../apps/firefox-ui-demo/docs/PATH_1_5_STABILIZATION.md)에 구분했다.
- 최종 재표시: MCP 응답 확인 timeout 당시 이미 반영된 동작을 반복하지
  않고 이어서 검사했다. 코드의 언더스코어 원문, 읽을 수 있는 로컬 파일 링크,
  같은 응답의 artifact 열기를 확인했다. 신뢰된 HTTP/SSE는 200,
  문자열 `Origin: null`은 403이었다. `POST /chat/send`는 0회였고
  기존 네이티브 run 1개와 파일 해시는 유지됐다. 전용 검증 런타임 정리도
  완료했다. 실제 사용자 계정 로그아웃과 새 OAuth는 시험하지 않았다.
- Owner의 15개 질문은 아직 열려 있다. Jev 초안은 채택되지 않았다.
  이번 라운드에 OpenAI Decisions API 키 저장소와 외부 API 클라이언트(결정
  모델)가 추가됐다. 기본값은 꺼짐이며 키를 저장하고 모드를 설정했을 때만
  동작한다. EG-Desk가 소유한 로그인 폴더를 쓰는 Engine Profile도 추가됐다.
- 2026-11-18 상태(2026-11-17 22:40 ~ 2026-11-18 01:00 KST 라운드,
  `claude/vision-gap-20261024`에 병합): Chat/Agent, 구독, 브라우저, computer
  use, Canvas, 디자인, 코딩/컨텍스트, portable 영역의 패키지가 병합됐다.
  `0b66e1b`에서 전체 회귀 225개 파일이 5,807건 통과, 실패 0건이었다.
  headless 검증에서 RT-01, CHAT-01, BRW-03은 통과했고 BRW-08/CNV-04의
  포커스 문제는 남아 있다. 실제 계정이나 실제 화면에서 검증한 항목은 없다.

### 2026-11-19 로컬 구현 기준

앞의 날짜별 기록은 당시의 상태다. 이후 Browser가 아니라 **Canvas가 보이는 상태**에서 라벨 편집·Board 저장·재열기를 확인했다. 이 결과를 실제 한글 IME나 모든 Browser 입력 포커스의 검증으로 확대하지 않는다. 일반 Agent DM의 원본 줄과 동의 이후 발언 재사용, Board의 공개 발언 전달은 [현재 조작 안내](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-local-guide)에 정리했다. 이 안내의 기준은 로컬 기능 브랜치 `feat/agent-memory-grounding-20261119`이며 정식 배포 상태를 뜻하지 않는다.

## Current Product Frame

EG-Desk is a live work surface that organizes durable work through a Board
rather than reducing work to a folder. A Desk is the active computer-like
surface and can contain transient unsaved work before it is retained in a
Board. A Board pairs the work objective with browser cards, files, chat,
agents, execution state, outputs, and context. Cards are views/runtime surfaces,
not the Board itself.

Core principles:

- 익숙한 브라우저로 바로 시작한다. 웹을 쓰다가 축소하면 방금 쓰던 페이지가 같은 Desk의 카드였음을 발견한다. 사람·기기·계정·Agent는 각각 설정하고 조합할 수 있지만, Desk를 열기 위해 그 조합을 먼저 완성할 필요는 없다.
- Treat Board as the work boundary and Card as the view/runtime form.
- Compose one answer across Chat and Canvas using each medium's own interaction grammar.
- Put spatial, visual, interactive, artifact, and playback expressions on Canvas while keeping conversational explanation complete in Chat.
- Let AI act on the same visible browser/canvas state the user can inspect.
- Prefer repeatable Firefox MCP verification scripts for UI/runtime changes.

## Source Documents

| Area | Current source |
|---|---|
| Public-facing whitepaper | [Production v8](../../docs/production/EG-DESK%20백서%20-%20Production_v8_한글.md) |
| Vision gap ledger (2026-10-24 code audit, current state per item) | [`EGDESK_VISION_GAP_LEDGER.md`](./EGDESK_VISION_GAP_LEDGER.md) |
| Interaction and orchestration contract | `ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md` |
| Interaction trace and acceptance coverage (non-normative; not runtime evidence) | `ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md` |
| Firefox shell strategy | `ideas/confirmed/FIREFOX_SHELL_STRATEGY.md` |
| Firefox shell roadmap | `ideas/confirmed/FIREFOX_SHELL_ROADMAP.md` |
| Desk/Board/Card runtime | `apps/firefox-ui-demo/docs/DESK_AGENDA_CARD_RUNTIME_MODEL.md` |
| Chat/canvas/agent layer | `apps/firefox-ui-demo/docs/CHAT_CANVAS_AGENT_LAYER_MODEL.md` |
| Chat visual grammar | `apps/firefox-ui-demo/docs/CHAT_DESIGN_GRAMMAR_V1.md` |
| Viewport/HUD interaction | `apps/firefox-ui-demo/docs/VIEWPORT_LAYOUT_INTERACTION_MODEL.md` |
| Answer Briefing | `ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md` §8 and `ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md` `OBJ-038` / `AI-05`; legacy `apps/firefox-ui-demo/docs/CANVAS_RUN_PLAYBACK_MODEL.md` is superseded |
| AI canvas annotation | `apps/firefox-ui-demo/docs/AI_CANVAS_ANNOTATION_LAYER.md` |
| Chat agent profiles | `ideas/confirmed/CHAT_AGENT_PROFILE_RUNTIME.md` |
| Browser agent observation runtime | `apps/firefox-ui-demo/docs/BROWSER_AGENT_OBSERVATION_RUNTIME.md` |
| Human-in-the-loop workflow await | `apps/firefox-ui-demo/docs/HUMAN_IN_LOOP_WORKFLOW_AWAIT_MODEL.md` |
| Historical browser-agent protocol (Electron-era; superseded by ADR-007 and the Firefox runtime sources above) | `ideas/confirmed/AGENT_BROWSER_PROTOCOL_INTEGRATION.md` |

## Decided Product Concepts

### Desk

Desk is closer to "computer / live work surface" than a browser profile or folder. One Desk can contain multiple browser profiles/accounts, files, chats, terminals, and cards. Switching Desk is closer to switching the working computer/work surface than changing a single project folder.

Desk has an automatic local recovery lifecycle distinct from Board
persistence. An unsaved arrangement may be restored after restart without
becoming a saved Board revision.

<a id="agenda"></a>
### Board

Board is the reusable work pairing. It can contain browser cards, file cards, chat cards, terminal cards, agent context, outputs, and workflow state. Nested Board is allowed as a work decomposition graph, but the UI should show the active slice instead of an infinite tree.

### Card

Card is a view/runtime form. "Show it as a card" should be a first-class output mode, similar to "show it as a sheet" or "show it as slides." Browser, terminal, chat, file, report, and annotation cards are all card forms.

### Chat

There are two chat entry modes:

- Agent DM: 한 Agent에게 말하는 개인 채널이다. 공동 작업을 Board에서 이어도 DM 이력은 따라가지 않는다. 공유가 필요하면 대상·범위가 허용된 자료나 발췌만 별도로 연결한다.
- Board Thread: project/work-room chat attached to a Board. Multiple agents can participate like a group chat.

Chat should remain conversationally complete and avoid pasting artifact bodies
or raw execution traces. When Canvas carries the spatial/visual result, Chat
uses an appropriate explanation plus links/chips into that result.

Chat and Canvas are medium-specific projections of one answer. Chat keeps the
conversational explanation; Canvas carries spatial, visual, interactive, and
artifact-oriented expression. A result chip is a navigation affordance, not a
durable product object.

<a id="vision-agent-channels"></a>
### 한 Agent, 여러 대화 장소

Agent를 식별하는 질문은 ‘어느 창인가?’가 아니라 **‘누구의 경험으로 이어지는가?’**다. 성격·설정과 그 Agent에게 귀속된 이력이 연속성을 만든다. 프로필은 설정의 한 버전이고 활동 기록은 한 실행에서 일어난 일이다. 둘 중 어느 것도 그 자체로 인격체가 아니다. 같은 설정을 복사한 새 Agent가 원래 Agent의 약속이나 비공개 기억을 이어받지는 않는다.

1. **인격과 기억:** Agent는 이번 일에서 재사용할 수 있는 자신의 경험을 찾는다. 같은 Agent라는 이유로 다른 방의 원문이 열리지는 않는다.
2. **몸과 환경:** 현재 Desk에서 허용된 화면·도구, 대화 장소와 듣는 사람을 먼저 정한다. 사이드바나 카드의 위치는 수신자도 권한도 아니다.
3. **판단:** 그 환경에서 무엇을 알고 무엇이 필요한지 판단한다. 내부 판단이나 작업 메모는 대화 발언이 아니다.
4. **행동:** 화면을 읽거나 변경할 때에는 그 대상에 실제로 위임된 권한을 쓴다. 결과는 해당 실행의 기록에 연결한다.
5. **대화:** 답은 받는 사람이 있는 채널에 그 Agent의 이름으로 보낸다. 사용자에게는 질문에 필요한 결론을, 요청하면 확인할 수 있는 근거를 준다. 시험 표식이나 엔진 진단을 Agent의 말처럼 붙이지 않는다.

`@A @B`로 같은 방에서 물으면 두 DM에 복사하는 것이 아니다. 두 Agent는 먼저 지목된 쪽이 답을 마칠 때까지 기다리지 않고 각자 생각을 진행한다. 이미 공개된 상대 발언이 자기 턴에 도착하면 하던 일을 이어가며 답할 수 있어야 한다. 접수는 읽음·동의가 아니며 자동 토론 횟수나 합의를 약속하지 않는다. [공개 발언과 진행 중인 턴의 계약](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-room-speech)

### Agent Runtime

Agent profile config is runtime context, not visible chat content. Current seeded profiles:

- `conversational-coding`
- `tool-operator`
- `coding-project-manager`
- `codebase-explorer`
- `implementation-worker`
- `review-verifier`

The current Codex SDK path has no dedicated system-prompt field, so EG-Desk sends profile/system prompt data as an application runtime-context envelope before the user message.

### Browser Agent

Browser cards should expose AI-observable state and action history. After an AI action, DOM/title/focus changes should be summarized back to the agent instead of forcing the model to rediscover the page from scratch every time.

**판정과 실행:** 채팅에서 추론하기 전에 호스트가 허용된 자료·시점·응답 유형을 보기로 내고 Decision Model이 관련 항목을 고른다. 브라우저에서도 현재 화면에서 가능한 정형 동작을 먼저 고른다. 새 문장·계획·시뮬레이션 설명이 필요할 때에는 추론 모델이 맡는다. 모델의 선택을 실행하기 전에 호스트가 대상·권한·변경 여부를 검사한다. 이 분업은 목표다. 현재 일반 Chat은 문맥 선별을 켜도 최종 답변을 만드는 모델을 건너뛰지 않는다.

<a id="vision-subscription-routing"></a>
**구독을 연결한 사용자의 비용 원칙:** 판정은 별도로 허용한 Decisions API 키로, 생성·서술형 추론은 **항상 그 실행에 선택한 구독 계정의 사용량**으로 처리한다. 답변뿐 아니라 요약·초안·백그라운드 교훈 제안에도 같은 기준이 적용된다. 적용 가능한 API 크레딧은 API 측 혜택이지 추론의 비용 경로를 바꾸는 권한이 아니다. 구독 인증·한도가 막히면 이유를 알리고 해당 생성을 보류한다. 유료 생성 API나 다른 계정으로 우회하지 않는다. [현재 경로와 남은 차이](../../apps/firefox-ui-demo/docs/DECISION_MODEL_CONTEXT_SETUP.md#billing-boundary)

### Human-in-the-Loop Await

AI workflows should support dependency-aware Await states. When an upstream
agent task completes with the required evidence and approvals, dependent tasks
should become ready and start automatically. OAuth/login handoffs,
terminal/browser events, file arrival, and user action are possible dependency
conditions, not the definition of Await. Manual "continue" remains a fallback,
not the default path.

### Ontology Runtime and View

Ontology is the system model that organizes agent context, relations, state,
constraints, actions, and evidence. The current Ontology Desk Window visualizes
and helps inspect/co-design that model; it is not a primary workflow in which an
agent or end user manually manages the ontology.

<a id="vision-membrain"></a>
### MemBrain: 기억을 지금 질문에 맞게 읽는 층

MemBrain은 온톨로지 전체의 새 이름이 아니다. Agent가 **언제의 일이고, 무엇에 관한 말이며, 어떻게 아는지** 구분해 답하기 위한 작업명이다. 기존 영업 CRM인 Membrain과 혼동될 수 있어 공개 명칭은 확정하지 않는다. 파일 전체를 ‘과거/현재/미래’ 한 칸에 넣지 않는다. 질문의 ‘지금’이 한 시간인지 한 해인지는 호출하는 쪽에서 정한다. 같은 기록에서도 물리적 대상, 그 대상을 나타내는 디지털 장부, 미래 계획과 가정은 다를 수 있다. 과거임은 알지만 날짜를 모르는 사건, 별도 공지까지 유효한 조건, 시기 미정인 미래 계획, 시점 자체가 미상인 정보도 구별한다.

- **같은 대화에서 큰 주제로 돌아오기(로컬 Codex Agent DM):** 한 DM에서 다른 일을 잠시 다룬 뒤 돌아오면, 이번 요청을 원래 주제에 연결하고 답에 필요한 상위 목적과 하위 결정만 골라 붙일 수 있다. ‘어느 주제에 속하는가’와 ‘어느 앞선 대화가 지금 답에 필요한가’는 별개다. 무관한 곁가지를 이번 추가 입력에서 빼도 채팅 원문이나 기존 엔진 이력은 바뀌지 않는다. Decisions를 켜는 것과 이전 대화를 그 서비스로 보낼 수 있게 하는 것은 별도 동의다. [Decisions에 전달되는 내용](../../apps/firefox-ui-demo/docs/DECISION_MODEL_CONTEXT_SETUP.md#membrain-turn-wire) · [같은 세션 토픽 트리와 권한 계약](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-session-topic-tree)
- **시간 범위(설계):** 먼저 원문과 연결된 대화에서 *무슨 일의 언제*를 묻는지 해석한다. 인용 속 ‘다다음 주’의 기준은 오늘이 아닐 수 있다. 기준 사건·표현·시간대가 정해진 뒤에만 코드가 달력을 계산한다. 월·일·시 재귀 문항은 기본 경로가 아니다. 시간 해석은 어느 기록을 찾아야 하는지도 정한다. 예전 사용량 보고를 인용해 ‘그때 빠른 모드를 썼어?’라고 물으면 인용의 원래 세션과 당시 실제 실행 기록을 찾는다. 현재 작업자 목록으로 과거를 추정하지 않으며, 원본을 볼 수 없거나 실제 모드 기록이 없으면 확인할 수 없다고 답한다. [과거 실행을 묻는 사용자 예](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-quoted-usage-time) · [시간 선별 예시](../../apps/firefox-ui-demo/docs/DECISION_MODEL_CONTEXT_SETUP.md#temporal-refinement)
- **근거:** 파일·발언의 정확한 버전과 구간은 원본이고, 기억 조각은 거기서 다시 쓸 한 주장·결정·교훈이다. 누가 언제 그렇게 말했다는 확인과 그 말이 현실과 맞는다는 확인을 나눈다. 실사 보고와 전언, 전표와 실제 인수, 계산과 추측은 같지 않다. 절차서는 그때 실행됐다는 증거가 아니고 복사본은 두 번째 관측이 아니다. 질문이 장부 기재를 묻는지 현재 현물을 묻는지에 따라 필요한 만큼 근거를 거슬러 올라간다.
- **선택과 생성:** 검색뿐 아니라 입력도 보기가 있으면 객관식이다. 호스트가 원본을 고정하면 Decision Model이 허용된 구간·분류 또는 ‘해당 없음’을 고른다. 사람이 완성한 조각에도 생성 작업자는 필요 없다. 여러 기록에서 원문에 없는 조건·교훈을 작성할 때만 생성형 작업자가 근거를 붙인 초안을 낸다. 비동기 실행이 저장·공유 권한을 뜻하지 않는다.
- **저장과 정정:** 호스트만 동의, 대상 Agent·소유자·방, 원본 버전·범위, 중복을 확인해 등록하거나 보류한다. 후속 확인은 이전 판단을 덮지 않고 연결한다. 회의록의 ‘금요일 출고 예정’과 나중 전표의 ‘출고 처리’는 둘 다 남으며 수취 완료를 뜻하지 않는다. 장기 보존·다른 채널·외부 서비스에 넘기는 일에는 각각 맞는 권한이 필요하다.
- **답의 길이:** 9시 실사 30개에서 2개가 출고됐고 10시까지 다른 변동이 없다는 근거가 있다면, 10시에 ‘지금 몇 개야?’의 답은 ‘지금 28개예요.’다. ‘왜?’에 실사와 출고를 설명한다. 기간이 비거나 출고가 예정뿐이면 그 차이를 숨기지 않는다.

**현재와 목표:** 로컬 기능판의 일반 Agent DM에는 파일 버전·줄 등록과 별도 동의 이후 최근 발언 12개를 연결하는 기능이 있다. 같은 세션의 토픽 연결은 기존에 연결한 Codex의 일반 Agent DM에서만, Decisions `[사용]` 및 API 키에 더해 그 DM에서 별도로 허용한 경우에 적용한다. 허용 이후에 완료·확정된 사용자 메시지와 최종 답변 쌍을 최대 96개까지 참조하고, 새 턴의 주제 소속과 필요한 선행 대화의 관계를 그때그때 추가한다. 트리 전체를 다시 판정하거나 이전 채팅을 소급 등록하지 않으며, 본문 사본도 만들지 않는다. 외부 Decisions는 허용 범위에서 앞선 발언쌍 원문과 새 사용자 메시지를 받아 맥락을 선별할 수 있지만, 실제 답변은 선택한 구독이 작성한다. 범용 기억 조각 등록 API, 새 교훈을 만드는 백그라운드 작업자, 정정 관계의 자동 관리·장기 승격은 설계다. [기억 계약](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-membrain) · [같은 DM에서 주제 이어가기](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-local-topic-tree)

<a id="vision-board-cross-agent"></a>

### 사람·기기·계정·Agent를 따로 조합한다

누가 요청하는지, 어느 PC에서 실행하는지, 어느 AI 계정이 비용을 부담하는지, 어느 업무 계정이 자료를 읽는지는 독립적이다. 로그인과 Agent 기본 설정을 관리하고, 실제 실행 조합을 확인할 수 있어야 한다. 쓸 수 없는 계정을 다른 사람의 계정으로 조용히 대체하지 않는다. 브라우저 쿠키나 CLI 로그인은 Agent의 성격·기억이 아니다.

**두 가지 협업 출발점(설계).** 내 기존 Board의 일부를 상대에게 열어 주는 방식과, 어느 쪽의 개인 Board에도 들어가지 않고 **둘이 공용 Board를 새로 구성하는 방식**을 구별한다. 후자는 각자 고른 카드·자료·상대에게 허용한 Agent 역할을 업무별로 모으는 것이다. 각자의 Desk·로그인은 남고 새로 붙인 배치와 공동 산출물에는 별도의 공개·보존 조건이 적용된다. 한 사람이 먼저 제안하거나 실행 PC를 제공했다는 이유만으로 다른 사람의 원본이나 공용 Board 관리권을 얻지는 않는다. [주문 317을 둘이 시작하는 예](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-joint-board-start) Agent 설정 사본 가져오기, 소유자가 공개한 발췌로 한 번 질문하기, 사람의 실시간 초대는 서로 다르다. 같은 Board에서 일해도 원본 파일·메일·자격 증명·발송 권한을 나눠 갖지 않는다. [현재 가능한 파일 교환과 한계](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-local-share)

**현재와 다음 단계:** [서로 다른 사람의 Firefox에서 같은 공용 Board 열기](../../apps/firefox-ui-demo/docs/JOINT_BOARD_RUNTIME.md)는 텍스트 자료·수신자·회신까지 연결했다. [표시 구성을 Decision Model이 선택하는 안](../../apps/firefox-ui-demo/docs/DECISION_MODEL_CONTEXT_SETUP.md#board-presentation-choice)과 [팀 호스트 미니앱 한 인스턴스를 카드로 쓰는 안](../brainstorming/MINI_APP_ECOSYSTEM.md#npx-sharing)은 설계/격리 검증이며 제품에서 자동 실행하지 않는다.

**협업 목표: 같은 보드 안에서도 누구의 브라우저와 누구의 Agent를 쓰는지 보인다.** 배치를 함께 편집하거나 발표자의 시점을 따라가는 데에는 업무 사이트 화면 전송이 필요하지 않다. 반대로 상대가 로그인해 둔 카드에서 허용한 조회만 맡기거나, 그 카드에 입력 중인 내용까지 함께 보거나, 잠시 조작을 넘기는 일도 선택할 수 있어야 한다. 초대 자체가 이 중 하나로 정의되거나 전부를 허용하는 것은 아니다. 로그인은 실제 실행 기기에 남는다.

민재가 서윤의 정산 Agent로 **민재의 주문**을 검토하고, 동시에 서윤은 민재의 검수 Agent에 **서윤의 주문**을 맡길 수 있는 것이 목표다. 같은 Agent에게 **상대의 로그인된 주문**을 맡기는 것은 별도 범위다. 사용자에게는 ‘누가 부탁했나, 누구의 Agent가 어느 계정에서 무엇을 하나, 답은 누가 받나’가 드러나야 한다. 상대의 개인 대화·기억·구독을 통째로 빌리는 방식은 아니다. 원격 사람 초대, 카드 화면 동시 시청과 사람 간 Agent 직접 호출은 현재 로컬 기능이 아니다. [같은 사이트를 다르게 보는 사용 예](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-shared-card-agents) · [상태와 실행 권한의 기술 경계](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-board-cross-agent)

**협업의 입구는 각자의 Desk에 둔다(목표).** 초대받아 참여하든 둘이 새 보드를 만들든, 허용된 카드는 각자의 기존 Canvas에 이름 있는 한 영역으로 보인다. 상대의 개인 Desk나 채팅방으로 옮겨 가는 것이 아니다. 보드 전체에 참여한 사람이 다음 날 왼쪽 목록에서 다시 열 수 있게 하는 것은 UI 제안이며, 카드만 전달받은 사람에게는 그 카드 밖의 자료나 비공개 보드 이름이 보이지 않아야 한다. 승인된 Desk 안에서 자료를 공개받은 사람이 곧바로 일할 수 있게 한다. 시연자의 역할 선택이나 다음 단계 안내가 업무보다 먼저 보이지 않게 한다. 전표를 앞으로 당기고 개인 메모를 밀어 둔 자리 자체가 일의 맥락이다. 창 크기나 포커스에 맞춰 책상을 자동 정렬하지 않는다. [입장·재진입 매뉴얼과 현재/제안 구분](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-board-entry-doors)

**새 사람이 들어와도 필요한 일만 넘긴다(목표).** 물류 담당 지우가 두 사람의 공용 Board에 합류해도 주문 원본이나 두 수량의 차이는 따라오지 않는다. 별도로 받은 배송 건을 자기 Agent나 사용이 허용된 동료 Agent와 처리하고, 허용된 수신자에게 집하 상태만 회신할 수 있어야 한다. [누가 무엇을 보는지 직접 비교하는 가상 예](../../sketches/board-collaboration-rehearsal/README.md)

### Coding Surface

Terminal is an agent execution substrate and optional expert/debug view. The
primary user-facing coding experience should support project/folder, file tree,
editor/viewer, diff, and run/test/review results. Non-trivial implementation
design starts with current official documentation, active reference
implementations, the local `references/` library, and verified license evidence.

### Viewport/HUD/Minimap

Viewport HUD should reflect the Board or maximized card currently in view. When a card is maximized, HUD should hide and return only on specific user actions. The minimap is desk-level navigation: its viewport box must be draggable like RTS minimaps, and its world bounds should adapt to the sparsity of cards and Boards.

## Development Todo

Organization use extends the existing one Desk/Canvas with multiple Boards;
departments or locations do not by themselves introduce new Desks, workspaces,
or Canvases. The [organization delivery sequence](./EGDESK_VISION_GAP_LEDGER.md#org-delivery-priority)
is the single proposed ordering for these increments; P0–P2 below group backlog work and
do not replace that sequence. The [organization use](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-org-use)
and [execution contract](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-org-execution)
describe the corresponding behavior and safeguards. These items describe
planned product capability, not proof of implementation or operational
validation. Continue unfinished individual-client Chat, Browser, File, and
other work as well: sharing or adding a host alone does not complete the product.

### P0 - Active Stabilization

- [x] Seed chat agent profiles and attach them to Agent DM / Board Thread runtime.
- [x] Send chat profile/system prompt through the Codex bridge runtime-context envelope.
- [x] Add profile chips/tool-mode chips to chat thread UI.
- [x] Add Firefox MCP verification for chat profile payload, visible chips, HUD fit, and bubble overflow.
- [x] Add browser agent observation and action history for browser cards.
- [x] Add dynamic minimap viewport box and drag navigation.
- [ ] Persist chat profile selection across browser restart and Board restore.
- [ ] Add UI for viewing/editing full agent profile/system prompt config in a canvas settings panel.
- [ ] Add Board Thread routing affordance from Agent DM: move to thread, tag user in thread, or return to DM.
- [ ] Add result-card creation from chat summary/result chips.
- [ ] Add Prezi-like canvas run playback with step comments that can be inserted into the next chat message.
- [ ] Add dependency graph/task state registry and automatic downstream start; model user-action awaits as one dependency-gate type.
- [ ] Make the local request-to-result flow dependable, including safe local
  writing and saving: bind the intended resource, account and action,
  distinguish a draft or request from an observed result, and retain enough
  state for a user to inspect or correct it. This local client work continues
  alongside organization-sharing increments.
- [ ] Bind authorization and attribution to distinct employee, requesting PC,
  executing PC, Agent, AI Engine account, site/service account, resource and
  action identities. A shared account may be used only within its permitted
  terms and does not establish an employee's identity. Each organization
  configures its own registered PCs and allowed role combinations; collecting
  every company's list is not a prerequisite for general product development.
- [ ] Enforce effective access before search, read, context assembly, summaries,
  titles, tool results and subagent delegation, and at the actual file, shell,
  browser and service boundaries. A visible permission tag or Agent prompt is
  not an enforcement mechanism; unauthorized data must not enter results or
  Agent context through another path.
- [ ] Preserve authorized work evidence and conversation history with original
  and derived records, attribution, attachments and correction history
  distinguishable. Search, sharing, retention and recovery must respect the
  applicable access and privacy policies; a portable export alone is not a
  complete organizational backup.
- [ ] Design and implement the first authorized two-PC, read-only sharing slice
  around a designated, registered PC with a supported OS and the required host,
  coordinator and store capability. Keep host/coordinator/store roles distinct
  from executor roles, even when co-located; another PC connects only within
  granted scope. Common Wi-Fi neither grants access nor automatically makes a
  PC a host. From this first slice, require a basic backup and tested restore,
  an explicit unconfirmed state after connection loss, and safeguards against
  blindly repeating an execution whose outcome is unknown. Actual remote
  infrastructure remains subject to the existing approval gate.

### P1 - Browser Control

- [x] Basic browser controls: navigate, back, forward, reload, stop, home, duplicate, copy URL.
- [x] Browser agent snapshot/action APIs.
- [x] Action history API and event emission.
- [x] DOM-change notification summaries after AI/browser actions.
- [ ] Browser control toolbar polish: predictable icons, disabled states, tooltips, focus behavior.
- [ ] Separate content/canonical-resource deduplication from profile/account execution context in SourceRef and Browser Card focus behavior.
- [ ] OAuth/window.open popup flow regression suite.
- [ ] Detect OAuth/browser completion events for Await Token satisfaction.
- [ ] For external actions, distinguish prepared, awaiting approval, requested,
  executed, verified and unconfirmed states. Apply the selected per-action
  approval or bounded standing delegation before acting; bind the target and
  account, then read back the actual destination before reporting completion.
  Do not retry an action with an unknown outcome as if it had failed.
- [ ] 브라우저 작업 절차 기억(임시 이름): 완료·검증된 목표의 단계를 값 없이 남기고, 다음 같은 요청에서 결정 모델의 첫 후보로 쓰고, 결과로 고친다. 권한은 매번 그 대화의 사람 말에서만. 설계 제안: `apps/firefox-ui-demo/docs/BROWSER_TASK_PROCEDURE_MEMORY.md`(2026-11-27 소유자 요청, 미구현).

### P1 - Canvas and Viewport

- [x] Shape tools: square, ellipse, line, arrow, pen (freehand), label, highlight; select is its own Dock tool. Arrow, pen, label and highlight share selection, move, delete and Board save/restore with the original shapes; covered by unit tests, while the Firefox run of `apps/firefox-ui-demo/scripts/verify-firefox-mcp-shapes.mjs` is still pending.
- [x] Card maximized/fullscreen behavior with HUD hiding.
- [x] HUD viewport fit checks.
- [x] Board region visual distinction on infinite canvas: faint solid edge, 14px corners, icon + name, actions in [⋯], 24px padding and 36px title row, 2px edge and `현재 Board` on the active Board, unsaved mark, and a far-zoom name chip; the top bar follows the Board on screen (`이름 · +N`, `Board 없음`). Unit-tested; the Firefox run of `verify-firefox-mcp-first-use-board.mjs` is still pending.
- [ ] Card placement policy: empty-space search, active Board placement, unsaved changes guard.
- [ ] Canvas output follow-up mode: temporal/spatial steps, camera movement, annotations, and comment anchors.
- [ ] AI canvas annotation mode: draw boxes/arrows/labels over cards or screenshots.
- [ ] Add quiet, always-available CPU/RAM/disk/network monitoring with small circular indicators in EG-Desk; distinguish host/app scope, meaningful units, and stale/unavailable samples. [UX proposal](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-resource-monitor) · [Technical contract](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-resource-monitor). Placement, default scope, sampling cadence, thresholds, and history retention remain unselected; not implemented.

### P1 - Chat UX

- [x] KakaoTalk-like message metadata outside bubbles.
- [x] Agent DM / Board Thread split.
- [x] Profile and tool-mode badges.
- [ ] Profile detail peek: plan/run/action/context layers from avatar/profile interaction.
- [ ] Canvas-linked result chips for long outputs.
- [ ] Thread/session badges: `Resumed`, `Fresh`, `Forked`, `Stateless`.
- [ ] Multi-agent participant state in Board Thread.
- [ ] Support a cross-department request and the minimum approved result in the
  existing Board/Chat flow. Share only the information the receiving role is
  allowed and needs to see, rather than exposing the source department's full
  files, conversations or working context by default.

### P1 - Context, Recovery, and Coding UX

- [ ] Separate saved Board revisions from the automatically journaled Desk recovery surface.
- [ ] Resolve run context from explicit selection, best-matching Board, transient Desk grouping/layout, visible resources, and account/permission scope.
- [ ] Make the selected run context inspectable and correctable without exposing the whole Desk by default.
- [ ] Research current project/file/editor/diff/test-result frameworks and active implementations before selecting the coding-surface integration path.
- [ ] Add user-facing project/folder, file tree/search, editor/viewer, diff, and run/test/review result surfaces; keep terminal as an optional expert/debug view and agent substrate.
- [ ] Support saving permitted changes to the intended existing file on the
  intended PC, preserving required format and history and reading the result
  back from that same target. Apply the file safety contract and the owner's
  outstanding choice on concurrent-write protection; never silently substitute
  another PC's same-named file or treat a draft as a saved original.

### P2 - Runtime/Packaging

- [ ] Clean-profile boot verification gate.
- [ ] Portable EGDesk packaging path.
- [ ] Rust helper consolidation for terminal/PTY/native functions.
- [ ] Bridge restart/reconnect UX without noisy user-facing diagnostics. Screen side done 2026-10-24 (unit-tested, not yet run in Firefox): Chat says `다시 연결 중…` during the first quiet retries, then `연결이 끊겼습니다` with one `다시 시도` button; the raw transport error and timing sit under a folded `자세히`; `/v1/state` `bridge.sourceMismatch` shows `브리지 버전이 맞지 않습니다 · 다시 시작 필요`. The bridge side landed in `1143240` (app-server reconnect backoff, `/v1/state` `bridge` build fields, launcher restart of a crashed bridge). Still open: the overlay does not send its expected build (`X-EGDesk-Overlay-Build`) yet, so the mismatch line cannot fire, and none of this has run in Firefox.
- [ ] Terminal/browser/auth/file watcher bus for cross-app workflow sync.
- [ ] Local persistence schema decision: SQLite-first with possible PocketBase/Convex sync bridge later.
- [ ] Add a Desk-visible host-activity view and control-lease model for computer-use that occurs outside native Desk Windows.
- [ ] Prefer isolated app/desktop execution for global pointer/keyboard computer-use; require explicit handoff before controlling the user's active desktop.
- [ ] Keep remote host-activity streaming, identity, and authorization behind the external-infrastructure approval gate.
- [ ] Extend the initial shared slice to multiple authorized executors and
  explicit handoff, reconnect and recovery across PCs. Preserve the actual
  actor, target, account and last confirmed result; distinguish transferred
  context from resumed execution. Automatic host succession is a later
  extension, not a substitute for the first slice's basic backup, restore and
  unknown-outcome protections.

## Documentation Rule

When a product decision becomes implementation-relevant, update one of these:

1. This file, if it changes product direction or backlog.
2. A focused `apps/firefox-ui-demo/docs/*` doc, if it specifies runtime/UI behavior.
3. A focused `ideas/confirmed/*` doc, if it confirms a technical strategy.

Do not rely on chat history alone for product decisions that affect implementation.
