# EG-Desk 가상 사용설명서와 제품 상호작용 Atlas

**문서 목차**: [읽는 목적별 안내](../../docs/README.md#docs-start)

**문서 역할**: EG-Desk를 켠 뒤 사용자가 실제로 보는 화면, 누르는 UI, 입력하는 값, 즉시 보이는 반응과 다음 행동을 정의하는 사용자 매뉴얼·UI 행동 정본  
**기술 구현 정본**: [EG-Desk 기술 구현·상호작용·오케스트레이션 계약](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-contract-top)  
**설계 gap·사용자 질문 정본**: [EG-Desk 설계 Gap 및 사용자 확인 원장](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#gap-owner-queue)
**관련 문서 운영 원칙**: [EG-Desk 제품 문서 화자·운영 정본](../../docs/codex/egdesk-product-documentation-governance.md#doc-governance-top)

| 찾는 내용 | 바로 가기 | 관련 정본 |
|---|---|---|
| EG-Desk 화면과 조작 | [0절 화면 구조](#atlas-manual-start), [1절 사용 흐름](#1-가상-사용설명서-실행부터-재진입까지) | Atlas |
| 제품 요소·관계·불변조건 | 2–6절 | Atlas |
| 정확한 화면·메뉴·키보드·실패 후 복귀 | [화면·조작 상세](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-design-details) | 아래 흐름과 연결된 위임 설계 기준선; 정책 차이는 각 조건부 분기 |
| 상태가 성립하는 기술 원리 | 각 흐름의 `기술 참조` | [기술 계약 빠른 이동](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-ui-trace-map) |
| 제품 소유자 결정이 필요한 항목 | 흐름의 `HUM-*` | [사용자 확인 목록](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#gap-owner-queue) |
| 세부 `Q-*`, 승인 gate와 coverage | 흐름의 ID | [제품 문서 화자·운영 정본](../../docs/codex/egdesk-product-documentation-governance.md#doc-question-registry) |

<a id="atlas-manual-start"></a>

## 0. EG-Desk 화면 구조와 조작 표기

### 0.1 한 화면 mental model

아래 ASCII는 픽셀 위치나 최종 스타일을 정하는 wireframe이 아니다. `어떤 화면이
어떤 제품 표면 안에 존재하고`, `Agent 실행체가 어디에 보이며 어디에 실제로
존재하지 않는지`를 먼저 이해하기 위한 관계 배치다.

```text
 +--------------------------------------------------------------------------+
 | EG-Desk / Firefox shell                                                  |
 | +----------------+-----------------------------------------------------+ |
 | | Sidebar        | Desk / Canvas                                       | |
 | |                | +-------------------------------------------------+ | |
 | | Saved Agendas  | | Canvas                                          | | |
 | | - Agenda A     | |                                                 | | |
 | | - Agenda B     | |  +-------------+   +-------------------------+ | | |
 | |                | |  | Browser     |   | Chat                    | | | |
 | |                | |  | View        |   | View                    | | | |
 | |                | |  +-------------+   +-------------------------+ | | |
 | |                | |                                                 | | |
 | |                | |  +-------------+   +-------------------------+ | | |
 | |                | |  | File/View   |   | Result / Artifact       | | | |
 | |                | |  +-------------+   +-------------------------+ | | |
 | |                | |                                                 | | |
 | |                | |  [Agent activity: status / scope / evidence]   | | |
 | |                | +-------------------------------------------------+ | |
 | +----------------+-----------------------------------------------------+ |
 +--------------------------------------------------------------------------+

Outside the visible nesting above:
Agent Runtime --request/tool intent--> System --validated UI/state change--> Desk
```

- **Desk**는 사용자가 지금 일하는 표면이다.
- **Canvas**는 View, artifact, 주석과 단계별 설명을 공간적으로 배치·탐색하는 영역이다.
- 기본 제품 모델에는 하나의 Desk와 그 Desk에 속한 하나의 Canvas가 있다. 여러
  Saved Agenda를 같은 Canvas에 서로 독립된 projection으로 동시에 열 수 있으며,
  Agenda를 연다고 기존 내용을 교체하거나 새 Desk를 만들지 않는다.
- 하나의 Desk·Canvas는 물리 PC 한 대를 뜻하지 않는다. 같은 Agenda에서 여러 PC의
  자료와 실행을 연결할 수 있으며, 폴더는 그중 하나의 자료 위치다. 각 작업에서는
  실행하는 PC·대상·계정·마지막 확인 상태를 구별할 수 있다.
- **Chat, Browser, File/View**는 Canvas 위에 놓일 수 있는 제품 요소다. Chat이
  특정 Agent/persona와 관계를 이어 가는 방으로 보일 수 있지만, Agent 실행체가
  Chat 안에 살거나 대화 기록 전체가 모델 context라는 뜻은 아니다.
- **Saved Agenda**는 Sidebar에서 다시 열 수 있는 사용자가 저장한 작업 결합이다.
  앱을 다시 켰을 때 Canvas에 이전 뷰가 자동 복원되는 것과 별개다.
- **Agent activity**는 실행체 자체가 아니라 System이 Desk에 투영한 상태·범위·증거다.
  Agent Runtime은 위임과 권한을 받은 뒤 System을 통해서만 Desk 요소에 행동한다.
- 사용자나 Agent의 의미 있는 활성 작업, sleeping 상태, historical snapshot은
  Canvas에서 찾을 수 있는 표현을 가진다. Canvas viewport 밖으로 pan됐다는 사실만으로
  닫히거나 suspend되지는 않으며, 무거운 renderer만 필요에 따라 분리될 수 있다.

### 0.2 사용설명서의 입력 표기법

1절의 각 행은 아래 단위를 섞지 않고 기록한다.

| 표기 | 뜻 | 함께 확인되는 정보 |
|---|---|---|
| `Click [레이블]` | 포인터로 버튼·행·탭·대상을 한 번 활성화 | 정확한 레이블, 대상, 활성화 직후 보이는 반응, 포커스 복귀 |
| `Double-click [대상]` | 더블클릭이 별도 의미를 가질 때만 사용 | 단일 클릭과의 차이, 오작동·취소 경로 |
| `Type "문자열"` | 현재 입력 소유자가 있는 필드에 문자를 입력 | 입력 필드, 초안 상태, 전송 전 Agent 미시작 여부 |
| `Press [키]` | `Enter`, `Esc`, 화살표, `Tab` 등의 키 입력 | 포인터 경로와 같은 결과인지, 포커스가 어디로 가는지 |
| `Shortcut [조합]` | `⌘`·`Ctrl`·`Shift` 조합 | OS 차이, 충돌 우선순위, 재정의 가능 여부 |
| `Drag [A → B]` | 뷰·항목·순서를 끌어 이동 | 드롭 가능 영역, 미리보기, 취소·되돌리기, 저장 범위 |
| `Scroll / Pan / Zoom` | Canvas 또는 콘텐츠의 viewport를 바꿈 | 객체 위치 변경과 구분, 현재 focus 보존, 모션 감소 경로 |
| `Observe` | 사용자가 입력하지 않고 상태를 확인 | 누가 상태를 바꿨는지, 마지막 확인 시각, 성공으로 오인하지 않을 조건 |
| `Automatic — System` | 제품 사용자 입력 없이 System이 처리 | Agent가 직접 읽거나 실행한 것으로 기록하지 않음 |

`cmd`는 두 뜻을 구분한다. `⌘K`처럼 쓰면 macOS **Command 키 조합**이고,
Terminal 코드 블록 안의 `git status`처럼 쓰면 **셸 명령**이다. 사람용 기본 사용법은
버튼·메뉴·파일·편집기 경로이며 셸 명령이 있는 경우에도 동등한 사람용 UI 경로를
먼저 적는다.

`Q-ID`는 세부 항목의 식별자다. 화면·메뉴·키보드·복구 경로는 각 흐름의 상세 조작에 연결된다. 정책에 따라 달라지는 동작은 조건부 기준선이며, 연결된 사용자 선택의 승인을 뜻하지 않는다.

### 0.3 EG-Desk 정상 실행 직후

정상 실행은 랜딩 페이지나 복구 선택 화면에서 시작하지 않는다.

```text
User action                    Visible result                    Processing owner
----------------------------  --------------------------------  -------------------------
Click EG-Desk app icon        Actual Desk appears               System starts shell
or launch from OS keyboard    Canvas begins restoring views     System hydrates Desk state
                              Saved Agenda rows appear Sidebar  System loads Agenda metadata
                              No AI response starts             Agent: none
```

자동 Desk 복원은 브라우저 탭 복원처럼 이전에 열려 있던 view와 배치를 다시 보여
주는 연속성 기능이다. 저장된 Agenda는 사용자가 명시적으로 저장한 작업 결합이므로
Sidebar에 나타나더라도 자동으로 열리지 않는다. 어느 쪽이 먼저 화면에 그려지는지는
중요도 순서가 아니며, 각각 독립적으로 준비되는 화면 상태다.

### 0.4 최초 설정과 Chat 화면

Dock의 Chat 아이콘을 클릭하면 먼저 **Agent/persona별 담당자 방인 Chat view가
Canvas에 열린다**. 사용할 수 있는 Agent Profile이 있으면 최근 사용했거나 사용자가
고른 Agent의 avatar·이름이 상대 정체성으로 header와 message bubble에 나타난다.
Agent가 아직 설정되지 않았다는 이유로 Chat 바깥의 별도 마법사로 보내지는 않는다.
사용할 수 있는 Profile이 없으면 같은 Chat view 안에 `[Agent 설정]` 행동을 보여 주며
작성기와 `[전송]`을 사용할 수 없는 이유를 함께 표시한다.

제품에 기본 제공 Agent/Profile을 포함할지는 아직 `Q-AGENT-02`의 결정 사항이다.
기본 Agent/Profile의 제공 여부는 `Q-AGENT-02`가 정한다. 유효한 기본 Profile이
있으면 설정 단계를 건너뛰고 header에 그 Profile이 선택되어 나타난다. 없으면 다음
추천 경로가 나타난다.

```text
Desk / Canvas
+-----------------------------------------------------------------------+
| Agent room                                                            |
| [Agent 방 목록]   [avatar] Agent 이름 · 상태                          |
|-----------------------------------------------------------------------|
| message timeline                                                      |
|   사용자 메시지                                                       |
|   [ ·  ·  · ]  <- 실행 중 Agent 활동 표시                            |
|-----------------------------------------------------------------------|
| 요청 컨텍스트                                                        |
| [현재 Browser · https://…] [× 제거]                                  |
|-----------------------------------------------------------------------|
| [메시지를 입력하세요…                                      ] [전송] |
+-----------------------------------------------------------------------+

EG-Desk Dock: [Browser] [파일] [Chat]    상단: [설정]    [명령]: Terminal 열기
```

Chat header의 `[방 목록]`에서 담당자 방과 공유 대화를 찾는다. 같은 방의 `[활동 N건]`은 업무 목록을, `[업무별 보기]`는 대화 필터를 연다. 업무마다 새 방을 만들지 않는다. 공유 대화는 `[방 목록] → [공유 대화] → [새 대화]`에서 만들며 공개 범위를 따로 확인한다. `[⋯] → [담당자 설정]`은 같은 본문에서 열고 작성기를 유지한다. 상세: [담당자 방](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-entry), [공유 대화](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-share). 관련: `Q-CHAT-01`, `Q-OBJ-06`, `Q-AI-12`, `Q-AI-13`.

최초 Agent 설정은 같은 Chat의 설정·Profile 관리에서 진행한다. 기본 제공 여부와 편집 권한은 선택된 정책을 따른다. 관련: `Q-DATA-06`, `Q-AGENT-01`, `Q-AGENT-02`.

```text
Click [방 목록] -> Click [Profile 관리] -> Click [새 Profile]
-> Type 표시 이름
-> Select provider / model policy와 [AI Engine Profile]
-> 필요한 경우 AI Engine 계정 연결
-> Select tool 후보와 기본 실행 제한
-> Click [초안 저장] -> Click [차이 보기] -> Click [활성화]
-> 적용 범위를 확인해 [새 Chat 기본값] 설정
-> Click [대화로 돌아가기]
```

Agent Profile은 성격·지침·provider/model 선택 규칙·tool 후보·제약을 묶지만 실제
계정 권한을 만들지는 않는다. `AI Engine Profile`은 사용할 구독/API 계정과 engine
runtime을 가리키는 별도 설정이다. EG-Desk 로그인, AI Engine 구독 계정, Browser와
메일 등 연결 서비스 계정은 서로 다를 수 있다. 외부 계정이나 credential을 새로
연결하는 단계는 제품 사용자의 명시적 행동과 `A-AUTH-01` 경계를 거친다. Profile이
저장된 뒤에도 각 Run은 선택된 Engine Profile, 현재 가용성·작업 위임·리소스 권한·
승인·실행 제한을 다시 결합한다. 기술 원리:
[Engine Profile과 identity plane](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-engine-profile).

**요청 담당 Agent**는 현재 사용자 요청과 사용자 대상 Answer를 책임지는
Run-level 실행 역할이며, 별도 영속 제품 객체나 대화 참가자 이름이 아니다.
여러 Agent가 기여하는 요청에서는 integration 기능이
이 역할을 이어받아 하나의 논리적 Answer를 구성할 수 있다.

`[ · · · ]`는 공개 가능한 활동의 진입점이며 숨은 사고 과정이 아니다. 실행 중인 상호작용 Browser·Terminal은 그 작업의 동일 Live View로, 완료된 읽기·명령은 해당 호출의 불변 Snapshot으로 이동한다. Live가 없거나 연결을 확인하지 못하면 논리 작업 node에 준비·미확인 상태를 남기며 관찰을 위해 새 실행을 만들지 않는다.

`[당시 관찰]`과 `[현재 조작면]`으로 두 시점을 고르고 `[비교]`로 함께 본다. 직접 읽기는 명명 결과 전체를, Smart Read는 `[원본 캡처] [이 Agent에게 전달된 내용] [변환 관계]`와 coverage를 구분한다. Snapshot에서 `[현재 열기]`를 누르면 검증된 기존 Live를 우선 찾되 Snapshot identity는 유지한다. 현재 내용을 과거 관찰로 대체하거나 일회성 명령을 지속 Terminal로 가장하지 않는다. 상세: [활동과 관찰](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-reader-observation), [실행 상태 계약](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration).

### 0.5 Answer Briefing — 기존 `Playback` 명칭을 대체하는 제품 개념

**Answer Briefing / 답변 브리핑**은 `[브리핑 보기]`로 시작한다. 한 Answer의 고정된 Canvas 산출물을 설명 순서와 집중 범위에 따라 살펴보는 사용자 주도 프레젠테이션이며 실행 기록 재생이 아니다. 생성·편집·공유·삭제는 각각의 정책과 권한을 따른다.

```text
 +------------------------------ Canvas ------------------------------------+
 | dimmed context: [Browser] [Source notes]                                 |
 |                                                                          |
 |       +---------------- focus scope: step 2 of 5 ----------------+        |
 |       | [Chart A]  [Evidence 3]  [Decision note]                 |        |
 |       | "이 단계에서는 비용 차이와 그 근거만 설명합니다."       |        |
 |       +----------------------------------------------------------+        |
 |                                                                          |
 | [Step list]   [< Previous] [Overview] [Next >] [Comment] [Exit]          |
 +---------------------------------------------------------------------------+
```

| 행위자 | Answer Briefing에서 하는 일 |
|---|---|
| **Agent 실행체** | 사용자 요청과 공개할 Answer를 바탕으로 산출물 target set, Briefing Order, 각 Briefing Step의 focus scope와 짧은 설명을 제안한다. |
| **System** | 대상·권한·최신 상태를 검증하고, 현재 step의 viewport·zoom·강조·가림·포커스를 적용하며 이전·다음·전체 보기·종료와 접근성 대안을 구동한다. |
| **제품 사용자** | `브리핑 보기`를 시작하고 버튼 또는 키보드로 Briefing Step을 이동하며, 필요하면 현재 step이나 보이는 target에 의견을 남겨 다음 Chat 요청에 포함한다. |

한 Briefing Step의 핵심 데이터는 `순서`, `target set`, `focus scope`, `viewport`, `강조/가림`,
`사용자에게 보이는 설명`, `이전·다음 관계`, `대상 누락·권한 거부 시 대안`이다.
제품 사용자가 `다음`을 누르는 것은 System의 화면 전환이며 Agent 실행을 시작하지 않는다. 다음 Chat에 의견을 포함하는 것은 초안 작성이고, 실제 전송 뒤에만 해당 업무의 후속 실행이 접수된다.

기존 명칭 `Playback`은 녹화된 Run·동영상·과거 실행의 재생으로 오해되므로 정본명으로 쓰지
않는다. `Trace`는 실행·증거·출처를 추적하는 기록에, `Follow-up`은 사용자가 다음
Chat에서 보내는 후속 요청에 남겨 둔다.

### 0.6 기능별 화면 경로

| 장 | 시작 장면 | 끝 장면 | 대표 흐름 |
|---|---|---|---|
| **1.1 처음부터 다시 켤 때까지 한 바퀴** | 새 로컬 설치 | 요청·브리핑·Agenda 저장 뒤 재실행 복원을 구분함 | 핵심 흐름 연결 경로 |
| **1.2 실행과 Desk 연속성** | EG-Desk가 닫혀 있음 | 실제 Desk가 보이고 복원 상태를 구분함 | `L-01`–`L-03` |
| **1.3 Agenda로 작업 보관·재개** | 현재 Desk 또는 저장된 Agenda 행 | 의도한 작업 결합을 저장·열기·갱신함 | `AG-01`–`AG-04` |
| **1.4 Canvas·Browser·파일 사용** | 실제 Desk | 리소스를 열고 배치·탐색·검증함 | `V-*`, `DISC-*`, `TOOL-*`, `BROWSER-*` |
| **1.5 Chat·Agent·Smart Read·Answer Briefing** | Chat 입력 또는 기존 Answer | 계정·읽기 범위·Agent 활동을 확인하고 Chat과 Canvas 답으로 이어감 | `CHAT-*`, `AGENT-*`, `ENGINE-*`, `READ-*`, `AI-*`, `AUTH-*` |
| **1.6 사람 중심 코딩과 Terminal** | 프로젝트·폴더 또는 선택적 Terminal | 변경과 검증 결과를 사람이 확인함 | `CODE-*`, `TERM-*` |
| **1.7 Ontology가 관리하는 실행** | 관리 모델 또는 기록된 Run | 제약·근거·전이를 검사하거나 실행함 | `ONT-*` |
| **1.8 협업·computer-use·데이터·접근성** | 로컬 Desk | 공유·관찰·저장·접근성 경계를 확인함 | `COL-*`, `CU-*`, `DATA-*`, `UX-*` |

각 상세 흐름은 `상황/시작 상태 → 제품 사용자 UI 입력 → 즉시 보이는 반응 →
System 처리 → Agent 처리 → 상태 변화 → 실패 후 다음 UI 입력 → 완료 증거` 순서로
표시된다.

## 1. 가상 사용설명서 — 실행부터 재진입까지

각 행은 `상황/시작 상태 → 정확한 제품 사용자 입력 → 보이는 반응 → System 처리 → Agent 처리 → 상태 변화 → 실패 후 다음 입력 → 완료 증거`를 시간순으로 분리한다. `없음 — 자동`은 System의 자동 처리다. `Q-*`는 상세 항목을, 연결된 사용자 선택은 남은 정책 차이를 식별한다.

### 1.1 처음 켠 순간부터 다시 켤 때까지 한 바퀴

다음은 화면·입력·System·Agent·저장 경계를 연결한 최초 사용 예다. 대괄호 레이블과 키 조합은 상세 조작의 기준선이며, 정책에 따라 달라지는 단계는 해당 조건에서만 적용된다. `Q-*`는 관련 상세 항목이다.

**상황**: 새 로컬 설치이고 저장된 Agenda와 자동 Desk 세션 기록이 없다. 사용할 수
있는 기본 Agent Profile도 아직 없다고 가정한다. 사용자는 Agent를 한 번 설정하고,
웹 자료를 열어 요약·비교를 요청하고, 실행 중 도구 활동과 최종 Answer Briefing을
검토한 뒤 현재 작업을 Agenda로 저장하고 EG-Desk를 다시 실행한다. 유효한 기본
Agent Profile이 이미 있으면 3–5번 설정 단계만 건너뛴다.

| # | 제품 사용자 입력과 포커스 | 즉시 보이는 화면 | System 처리 | Agent 처리 | 다음 단계·경계 |
|---:|---|---|---|---|---|
| 1 | Dock/Applications에서 `Click [EG-Desk]`, 또는 `Press [⌘ Space]` → `Type "EG-Desk"` → `Press [Return]`을 사용한다. 최종 OS 진입 계약은 `Q-LIFE-01`이다. | Firefox shell의 실제 Desk가 첫 화면으로 열리고 EG-Desk 창이 입력 포커스를 받는다. | shell·Desk·Canvas를 시작하고 최초 로컬 상태를 확인한다. | 없음 | 랜딩·복구 마법사·Agenda 선택 화면을 먼저 열지 않는다. 시작 실패 시 추천 기본안 `[다시 시도] [진단 정보] [종료]`; `Q-LIFE-03`. |
| 2 | `Observe` — 별도 입력 없이 초기 Desk를 확인한다. | Sidebar에는 빈 Saved Agenda 상태와 추천 기본안 `[새 Agenda] [가져오기]`, Canvas에는 추천 기본안 `[Browser 열기] [파일 열기] [Chat 열기]`, Dock에는 리소스·Chat·설정 진입 아이콘이 보인다. 초기 포커스는 Canvas의 첫 행동 또는 결정된 접근성 시작점이다. | 저장된 Agenda와 복원할 Desk 세션이 없는 최초 화면을 투영한다. | 없음 | 제품 사용자는 Canvas 또는 Dock에서 다음 행동을 직접 선택한다. 상세: `L-01`, `Q-LIFE-02`, `Q-LIFE-04`. |
| 3 | Dock `[Chat]`을 열고 같은 Chat의 `[Agent 설정]` 또는 `[방 목록] → [Profile 관리] → [새 Profile]`로 들어간다. | 같은 본문에 Profile 초안과 표시 이름·지침·모델 정책·도구·제한 필드가 보이고 작성기를 유지한다. | 기존 정의와 가용성을 읽어 비활성 초안을 만든다. | 없음 | 기본 제공 여부는 연결된 정책을 따른다. 초안 생성은 Run 시작이 아니다. 관련: `Q-AGENT-02`, `Q-DATA-06`. |
| 4 | 표시 이름을 `Type`하고 provider/model policy를 선택한다. `[AI Engine Profile]`에서 사용할 구독/API 계정을 고른다. 새 계정이 필요하면 `Click [AI Engine 계정 연결]` 후 전용 인증 탭의 provider 화면에서 의도한 계정을 선택·완료한다. | 원래 설정 화면은 연결 중 상태를 유지하고, 전용 인증 탭이 열린다. 완료 뒤 설정 화면으로 포커스가 돌아오며 Engine Profile에는 확인된 계정 식별 정보, auth mode, plan/quota 상태가 보인다. 일반 Browser·메일 계정과 다른 identity임을 구분한다. | 비밀값을 Profile 본문에 넣지 않고 Engine Profile별 credential store에 보관한다. callback 완료 알림만 믿지 않고 실제 active account·plan을 다시 확인한다. | 없음 | 새 외부 계정 연결은 `A-AUTH-01`. 계정 선택 기본 범위와 전환 영향은 [HUM-ENGINE-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-engine-001). 상세: `ENGINE-01`, `AGENT-01`. |
| 5 | `[초안 저장] → [차이 보기] → [활성화]` 후 `[새 Chat 기본값]`의 적용 범위를 확인하고 `[대화로 돌아가기]`를 누른다. | 저장된 초안·활성 revision·기본값 적용 결과가 구분되어 보인다. | 검증된 revision을 활성화하고 확인한 기본값만 저장한다. | 없음 | 초안 저장만으로 선택 가능한 Profile이 되지 않는다. 이후 요청마다 가용성·권한·승인을 다시 확인한다. 상세: `AGENT-01`, `AGENT-02`. |
| 6 | `Click [Browser 열기]` → 주소 필드에 `Type "https://…"` → `Press [Return]`을 사용한다. 포인터 없는 진입과 최종 레이블은 `Q-VIEW-01`, `Q-BROWSER-01`에서 확정한다. | Canvas에 Browser view가 열리고 입력한 URL의 페이지가 view 안에 나타난다. | view 인스턴스, URL locator, Browser 계정·프로필의 권한·가능 행동 컨텍스트와 페이지 콘텐츠를 분리해 유지한다. | 사용자가 Browser 열기·탐색을 위임하지 않은 이 예에서는 없음. | 현재 Browser view가 Chat 요청의 context 후보가 될 수 있다. 상세: `V-01`, `BROWSER-01`, `TOOL-01`. |
| 7 | Dock `[Chat]`으로 담당자 방을 열고 `[새 업무]`를 누른다. | header의 `[방 목록]`·담당자 이름, 대화, 활동, 업무 대상, 컨텍스트, 작성기·`[전송]`이 구분된다. 작성기에 포커스가 간다. | 기존 방 identity를 유지하고 새 업무 초안과 허용된 컨텍스트 후보만 준비한다. | 없음 | Browser를 열었다는 이유만으로 본문을 자동 수집하지 않는다. 사용할 Profile이 없으면 같은 Chat에서 설정 행동과 전송 제한 사유를 보인다. 상세: `CHAT-01`, `AGENT-01`. |
| 8 | context item이 잘못 포함되었으면 제품 사용자가 해당 행의 `Click [× 제거]`를 한다. 포함 범위를 바꾸려면 `Click [현재 Browser · https://…]` → context 검사 화면에서 항목별 `Click [이 요청에서 포함/제외]` → `Click [적용]` 한다. | 제거한 item은 요청 컨텍스트 영역에서 사라지고, 수정한 item은 포함 상태·선택 이유·적용 범위가 갱신된다. 작성기 포커스는 유지되거나 `[Esc]` 후 작성기로 돌아간다. | draft context revision만 다시 계산하고 아직 Agent에게 전달하지 않는다. | 없음 — 전송 전에는 시작하지 않는다. | **제거·수정의 행위자는 제품 사용자**이고 System은 draft만 갱신한다. 상세: `AI-02`, `Q-AI-11`. |
| 9 | 작성기에 `Type "이 자료의 핵심과 근거를 비교해줘"` → 추천 기본안 `Click [전송]` 한다. 키보드 전송은 `Q-AI-02`에서 정한 조합을 사용한다. | 사용자의 메시지가 timeline에 붙고 그 아래에 접근성 레이블 `Agent 작업 중`을 가진 애니메이션 `[ · · · ]` 활동 표시가 나타난다. `[중지]`는 실행 중 표시와 함께 접근 가능하다. | 요청·draft context·Profile·권한·도구 가용성·Ontology·제한을 검증해 Run snapshot을 고정하고 모델/도구 lifecycle event를 수집하기 시작한다. | 고정된 위임 범위에서만 응답 생성과 도구 행동을 시작한다. | 활동 표시는 raw reasoning이나 chain-of-thought가 아니라 공개 가능한 실행 상태의 진입점이다. 상세: `AI-01`, `AGENT-02`, `OBJ-052`. |
| 10 | `Observe` — Chat의 `[ · · · ]` 애니메이션과 짧은 상태 변화를 본다. | Agent가 응답을 준비하거나 도구를 사용하는 동안 같은 활동 표시가 이어진다. 큰 첨부가 Reader로 전환되면 짧은 상태 `자료 읽는 중 · 전체 검토` 또는 `자료 읽는 중 · 지정 범위`와 source 수가 보이지만 내부 subagent 토론은 노출하지 않는다. | System은 호출 전에 요청 담당 Agent의 context admission을 계산한다. 직접 read이면 완전한 명명 결과를 그 Agent에 전달한다. Smart Read이면 immutable source를 Reader Session에 결합하고 coverage가 있는 Context Packet만 그 Agent에 전달한다. raw capture, packet, 전달 대상과 변환 관계를 각각 보존한다. | 요청 담당 Agent는 비교·판단·최종 답변을 계속 소유한다. Reader는 file-read 내부에서 원문을 검토하고 source-anchored packet을 반환한다. | 직접 read와 Smart Read를 같은 것으로 표시하지 않는다. 상세: `READ-01`, `READ-02`; 기술: [Smart Read](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-smart-read). |
| 11 | 실행 중 `[ · · · ]`를 누르고, 여러 활동이면 대상 행을 고른다. | 실행 중 상호작용 Browser·Terminal은 동일 Live로, 완료된 읽기·명령은 Snapshot으로 이동한다. `[당시 관찰] [현재 조작면] [비교]`와 읽기의 raw·packet·coverage를 구분한다. | 활동 identity와 현재 연결을 검증해 기존 표현을 연다. Live 미확인은 논리 node에 표시하고 과거 내용은 불변 manifest로 연다. | 기존 Run을 계속하며 관찰 열기만으로 도구를 재실행하지 않는다. | Snapshot과 Live는 별도 identity다. 상세: [활동과 관찰](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-reader-observation). |
| 12 | `Observe` — 최종 메시지와 Canvas 결과를 확인한다. | Chat에는 대화적으로 완결된 최종 메시지가, Canvas에는 비교·근거·표·원자료 등 매체에 맞는 report set가 나타난다. 원자료·Context Packet은 `[스냅샷]`, 가공 항목은 `[파생됨]`과 출처 동작으로 표시되며 제품 사용자의 `[라이브]` 뷰와 공존할 수 있다. | 각 report item을 `Agent가 실제 받은 payload/Context Packet → raw capture/source revision` lineage에 연결한다. Answer Briefing은 고정된 payload와 파생 산출물을 target으로 삼아 Live 변경으로 과거 답변을 덮어쓰지 않는다. | 최종 Answer와 함께 근거 snapshot 후보, Canvas 구성과 필요한 Briefing 구성을 제안한다. | report set는 raw trace 전체 복사본일 필요는 없지만 선별·가공 때문에 실제 입력과 source의 provenance가 끊겨서는 안 된다. 상세: `AI-04`, `OBJ-052`. |
| 13 | 추천 기본안 `Click [브리핑 보기]` → `[다음]` 또는 `Press [→]` → 필요 시 `[전체 보기]`를 사용한다. | `1 / N`, Briefing Step 제목·설명, 집중 target set와 Focus Scope가 보이고 범위 밖 맥락은 정책에 따라 약화·숨김된다. | 각 target·권한·최신 상태를 검증하고 사용자의 입력마다 viewport·zoom·강조·가림·포커스를 전환한다. | briefing set·순서·Focus Scope를 제안했더라도 단계 이동 중에는 다시 실행되지 않는다. | `다음`은 System 화면 전환이지 Run 재생이나 새 Run이 아니다. 상세: `AI-05`, `OBJ-038`. |
| 14 | `[의견]`에서 `이 근거를 먼저 설명해줘`를 입력해 `[저장]`한 뒤 `[다음 Chat에 포함]`을 누른다. | 저장된 댓글·단계·대상 revision이 Chat 초안에 붙는다. 기존 업무 초안과 다르면 별도 답장 초안이 열린다. | 권한과 참조를 검증하고 같은 댓글의 첨부를 중복 생성하지 않는다. | 없음 — 첨부만으로 실행하지 않는다. | 실제 전송 뒤 해당 업무의 후속 실행으로 이어진다. 상세: `AI-05`, `Q-MEDIA-05`, `Q-MEDIA-07`. |
| 15 | 추천 기본안 `Click [현재 작업을 Agenda로 저장]` → 제목 필드에 `Type "자료 비교"` → `Click [저장]` 한다. | 저장 범위 미리보기, 유효성 검사, 저장 중·성공 상태와 Sidebar의 새 Saved Agenda 행이 보인다. | 제품 사용자가 확정한 범위만 Agenda revision으로 저장한다. 자동 Desk 세션과는 별개다. | 없음 | 이 첫 한 바퀴는 정상 저장 경로만 추적하며 실패·복구 UI는 `AG-01`, `AG-03`에서 별도로 다룬다. |
| 16 | 앱 메뉴에서 `Click [EG-Desk 종료]` 또는 추천 기본안 `Press [⌘ Q]`를 사용한다. 최종 종료 계약은 `Q-LIFE-05`다. | 연속성 기록이 필요한 경우 그 진행 상태가 보인 뒤 창이 닫힌다. | 열어 둔 view·배치의 마지막 검증 상태를 자동 Desk 세션 기록에 반영한다. Saved Agenda를 암묵적으로 수정하지 않는다. | 없음 | 종료 실패·강제 종료·크래시 경로는 `L-03`에서 별도로 다룬다. |
| 17 | 1번과 같은 방식으로 EG-Desk를 다시 실행한다. | 실제 Desk가 먼저 나타나고, 이전 Browser·Chat·Canvas view는 자동 Desk 세션에서 복원된다. `자료 비교` Agenda 행은 Sidebar에 나타나지만 자동으로 열리지 않는다. | 자동 Desk 세션과 Saved Agenda 메타데이터를 독립적으로 하이드레이션한다. | 없음 | Browser URL/view 복원과 Terminal process 생존·재부착은 같은 의미가 아니다. 상세: `L-02`. |

**이 흐름의 기술 계약**: 숨겨진 Canvas 영역에 모든 도구 UI를 미리 렌더링하지 않는다.
사용자가 보게 되는 것은 과거 snapshot과 현재 live view의 구분, raw capture와 실제 Agent
전달 payload의 관계, 그리고 Answer에 쓰인 근거 lineage다. 저장·lazy rendering·content
addressing의 세부 원리는 이 매뉴얼에서 중복 설명하지 않고
[관찰 보존 계약](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-observation-fidelity)과
[로컬 저장 계약](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-storage-export)을 따른다.

**한 바퀴의 완료 증거**: 사용자는 실제 Desk에서 Agent를 설정하고 리소스를 열며,
Chat 화면에서 요청 컨텍스트를 직접 고친 뒤 요청을 전송한다. 실행 중 활동 표시를
통해 도구 호출 당시의 `[스냅샷]`을 열고, 필요하면 별도 `[라이브]` 뷰와 차이를
구분해 본다. 선별된 report set와 각 항목의 snapshot provenance가 연결된 하나의
Answer를 Chat·Canvas와 Answer Briefing으로 검토하며 현재 작업용 live view도 함께 다룬다. 그 뒤 명시적으로 Agenda를
저장하고, 재실행 시 자동 Desk 복원과 Sidebar의 Saved Agenda가 서로 다른 경로로
돌아오는 것을 구분할 수 있다.

### 1.2 실행과 Desk 연속성

<a id="atlas-l-01"></a>
#### L-01. 최초 로컬 실행

**상세 조작**: [shell](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-shell)

**기술 참조**: [Desk 수명주기](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-desk-lifecycle)

**제품 전제**: 실제 Desk는 최초의 제품 화면이다  
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름<br>
**시작 상태**: 새 로컬 설치/프로필에는 자동 Desk 세션 기록도 저장된
Agenda도 없다. 가져오기/마이그레이션은 별도의
`DATA-01` 경로이다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | macOS Dock의 EG-Desk 아이콘을 클릭하거나 응용프로그램의 아이콘을 더블클릭한다. 검색으로 열려면 `⌘ Space` → `EG-Desk` 입력 → `Return`을 누른다. | Firefox shell의 실제 Desk와 Canvas가 첫 화면으로 나타나고 EG-Desk 창이 입력 포커스를 받는다; 초기 포커스·비시각적 안내는 `Q-LIFE-02`, `Q-LIFE-04`에서 확정한다 | System이 Firefox 셸 런타임을 시작한다. | 없음 | 새로운 활성 Desk 세션이 시작됨 | 시작 실패 시 추천 기본안 `[다시 시도] [진단 정보] [종료]`를 보여 주고 실패 원인을 확정하지 않은 채 활성화한 OS 진입점 또는 첫 오류 행동으로 포커스를 돌린다; 최종 계약은 `Q-LIFE-03` |
| 2 | 없음 — 자동 | Sidebar에 빈 Saved Agenda 상태와 추천 기본안 `[새 Agenda] [가져오기]`가 표시된다; 최종 레이블·키보드 순서는 `Q-LIFE-04`에서 확정한다 | System은 저장된 Agenda가 없음을 확인한다. | 없음 | Agenda가 존재하지 않음 | `Tab`으로 빈 상태 행동을 순회하고 `Enter`로 선택하는 것을 접근성 기본안으로 하며, 생성·가져오기·도움말과 포커스 복귀의 최종 행동은 `Q-LIFE-04`에서 확정한다 |
| 3 | 없음 — 자동 | Canvas에 추천 기본안 `[Browser 열기] [파일 열기] [Chat 열기]`가 표시되고, 결정된 첫 행동 또는 Canvas 자체에 초기 포커스가 있음을 식별할 수 있다; 최종 콘텐츠·순서는 `Q-LIFE-04`에서 확정한다 | System은 이전 Desk 세션이 없음을 확인하고 초기 화면을 구성한다 | 없음 | Agenda가 생성되지 않음 | 제품 사용자는 추천 기본 행동 중 하나를 클릭하거나 키보드로 선택해 `V-01` 또는 `CHAT-01`로 이어 간다; 빈 화면만 남는 경로는 허용하지 않으며 최종 제어는 `Q-LIFE-04`에서 확정한다 |

**완료 증거**: 실제 Desk를 사용할 수 있고 초기 포커스와 다음 행동을 식별할 수 있으며, 복구 마법사나 자동 Agenda 마운트가 나타나지 않는다.

<a id="atlas-l-02"></a>
#### L-02. 일반 실행과 자동 Desk 복원

**상세 조작**: [restore](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-restore) · [view](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-view)

**기술 참조**: [Desk·Agenda·runtime 분리](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-desk-lifecycle), [Terminal runtime](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-terminal-runtime)

**제품 전제**: 저장된 Agenda와 자동 Desk 복원은 서로 독립적이다  
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름<br>
**시작 상태**: 이전 Desk 세션과 0개 이상의 저장된 Agenda가 서로 독립적으로 존재할 수 있다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Dock/Applications에서 `[EG-Desk]`를 클릭하거나 OS 검색에서 EG-Desk를 고르고 Enter를 누른다. | 실제 Desk가 나타난다; 정확한 로딩/순서 피드백은 `Q-RESTORE-01`에 정의되어 있으며, 저장된 Agenda가 Desk 연속성보다 더 중요하다는 인상을 주어서는 안 된다 | System은 완료 순서를 제품 우선순위로 사용하지 않고 두 개의 독립적인 상태 평면을 읽는다. | 없음 | 영속적 변경 없음 | 정확한 동시 처리/로딩 표현: `Q-RESTORE-01` |
| 2 | 없음 — 자동 | 열려 있던 뷰가 Browser 세션 탭처럼 돌아온다; 복원 범위는 `Q-RESTORE-02`에 정의되어 있다. File view는 이전 scroll·보이는 위치를 복원할 수 있지만 active caret·keyboard focus·transient text selection을 복원하지 않는다 | System이 Desk 세션 기록에서 뷰 인스턴스를 재구성하고 File view의 일시 입력 상태를 제거한다. | 없음 | 활성 뷰/세션 상태가 재구성되며, 저장된 Agenda 상태는 변경되지 않음 | 뷰 복원 실패와 다음 컨트롤: `Q-RESTORE-03`; 명시적으로 고정한 annotation/range는 별도 저장 정책을 따른다 |
| 3 | 없음 — 자동 | 저장된 Agenda 행이 열리지 않은 채 Sidebar에 나타난다 | System이 저장된 Agenda 메타데이터를 투영한다. | 없음 | 저장된 Agenda 상태가 변경되지 않음 | Agenda 목록 읽기 실패와 다음 컨트롤: `Q-RESTORE-06` |
| 4 | 없음 — 자동 | Browser 뷰는 이전 URL/세션 상태를 재구성한다; Terminal 뷰는 프로세스 신원이 검증되지 않으면 재연결되었다고 주장하지 않는다 | System은 각 리소스를 해당 수명주기에 따라 복원한다. | 없음 | Browser, Terminal, 파일 및 Chat 런타임은 서로 다를 수 있음 | Terminal 및 그 밖의 Browser 외 리소스 연속성: `Q-RESTORE-04` |

정상 종료는 마지막 기록 완료를 기다린다. 충돌·강제 종료·OS 재시작은 마지막 유효 commit을 사용하고 손실 가능 구간을 표시한다. 손상 기록은 보존하며 `[유효한 보존본으로 복원] [빈 Desk에서 계속] [진단 정보]`를 제공한다. 관련: `Q-RESTORE-05`.

**완료 증거**: 이전에 열려 있던 뷰와 저장된 Agenda 행을 각각의 독립적인
상태 경로를 통해 사용할 수 있다; 실패한 각 리소스는 Desk 전체를 막는 대신
자체적인 다음 행동과 함께 실패 상태가 가시적으로 유지된다.

<a id="atlas-l-03"></a>
#### L-03. 런타임 및 종료 경계에서 Desk 연속성 기록

**상세 조작**: [restore](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-restore)

**기술 참조**: [Desk 수명주기](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-desk-lifecycle), [장애 경계](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries)

**제품 전제**: 확정된 View·소유 변경은 기록하고 연속적인 배치·스크롤 변경은 묶어 기록한다. 정상 종료는 기록 완료를 기다리며 충돌 뒤에는 마지막 유효 기록으로 복원한다. 기록 실패는 미기록 범위와 함께 표시한다.<br>
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: Desk가 실행 중이고 자동 Desk 세션 기록이
없거나 마지막으로 검증된 상태를 담고 있다; 저장된 Agenda의 영속성은 별개이다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Dock `[Browser]`·`[파일]`·`[Chat]`으로 열고 View bar의 `[×]`, 드래그, 크기 handle 또는 `[⋯] → [이동]·[크기]·[그룹으로 묶기]`를 사용한다. | 일반적인 뷰 피드백이 나타난다; 연속성 저장 상태를 표시할지는 `Q-RESTORE-07`에 정의되어 있다 | System은 `Q-RESTORE-07`의 주기와 트랜잭션 경계에서 결정된 세션 필드를 기록한다. | 없음 | 자동 Desk 세션 기록이 변경되며, 저장된 Agenda는 변경되지 않음 | 쓰기 실패를 연속성 기록 성공으로 보고할 수 없다 |
| 2 | 앱 메뉴 `[EG-Desk 종료]`, macOS `⌘Q`, Windows/Linux `Alt+F4` 또는 마지막 Desk 창의 닫기를 사용한다. OS 충돌·전원 종료에는 별도 입력이 없다. | 정상 종료, 쓰기 대기, 크래시 및 강제 종료 피드백은 `Q-RESTORE-05`와 `Q-RESTORE-08`에서 정의한다 | System은 결정된 경계에 따라 연속성 기록을 플러시하거나 복구한다. | 없음 | 마지막으로 검증된 기록이 다음 시작의 입력이 됨 | 손상되거나 불완전한 기록을 처리할 때도 사용 가능한 Desk 경로를 보존해야 한다 |
| 3 | OS의 EG-Desk 아이콘이나 검색 결과로 다시 실행한다. | L-02는 마지막으로 검증된 기록만 사용하며, 화면별 질문을 통해 기능이 저하된 복구를 식별한다 | System은 재구성 전에 검증한다 | 없음 | 검증된 상태에서 새로운 활성 세션이 시작됨 | 사용자는 영향받지 않은 뷰와 구체적인 복구 행동을 통해 계속할 수 있다 |

**완료 증거**: 재진입 후 마지막으로 검증된 자동
Desk 세션 상태가 재현되거나 기능 저하 경계가 식별되며,
저장된 Agenda가 묵시적으로 생성되거나 다시 작성되지 않는다.

### 1.3 Agenda로 작업 보관·재개

<a id="atlas-ag-01"></a>
#### AG-01. Agenda 생성 및 최초 저장

**상세 조작**: [agenda](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda)

**기술 참조**: [Saved Agenda와 자동 Desk 세션](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-desk-lifecycle)

**제품 전제**: Agenda는 재사용 가능한 작업/실행 결합이다  
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: 사용 가능한 Desk가 존재하고 사용자는 새로 저장되는
Agenda를 생성하려 한다; 이 상태에 도달했다는 이유만으로 영속적인 Agenda가 생성되지는 않는다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Sidebar의 `[+ 새 Agenda]`를 누른다. 선택한 화면으로 시작하려면 다중 선택 후 `[Agenda로 저장]`을 누른다. | 생성 화면과 포커스 동작: `Q-AG-10`; 현재 Desk 선택 항목에서 시작할지 빈 범위에서 시작할지는 `Q-AG-01`을 따른다 | System은 결정된 초기 범위만으로 임시 Agenda 입력을 연다. | 없음 | 아직 영속적인 Agenda 없음 | 취소 및 돌아가기 동작: `Q-AG-10` |
| 2 | 이름을 입력하고 `[빈 Agenda]`·`[선택한 화면]`·`[항목 추가]`로 구성 목록의 포함 체크를 조정한다. | 포함되는 작업/실행 결합, 제외된 항목, 유효성 검사 및 포커스 상태가 `Q-AG-10`에 따라 보인다 | System은 결정된 필수 필드만 검증한다. | 없음 | 임시 초안 | 유효성 검사 실패 상태에서도 편집할 수 있다; 정확한 피드백: `Q-AG-10` |
| 3 | `[저장]`을 누른다. 입력 오류가 있으면 표시된 필드를 고치며 `[취소]`는 생성 전 초안으로 돌아간다. | 저장된 Agenda 행이 Sidebar에 나타난다; 성공 피드백: `Q-AG-10` | System은 Agenda를 영속화하고 목록을 새로 고친다. | 없음 | 새로운 영속적 Agenda; Desk 세션은 별도로 유지됨 | 영속화 실패 시 초안이 보존된다; 재시도/취소 UI: `Q-AG-10` |

**완료 증거**: 다시 열 수 있는 저장된 Agenda가 현재의
자동 Desk 세션 기록과 독립적으로 존재한다.

<a id="atlas-ag-02"></a>
#### AG-02. 저장된 Agenda 열기

**상세 조작**: [agenda](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda) · [restore](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-restore)

**기술 참조**: [Saved Agenda와 자동 Desk 세션](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-desk-lifecycle), [HUM-DESK-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-desk-001)

**제품 전제**: 저장된 Agenda를 클릭하는 것은 사용자 행동이다. 하나의 Desk·Canvas에
여러 Agenda projection을 동시에 열 수 있으며 기존 Canvas 내용을 교체하거나 새 Desk를 만들지 않는다.
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: 유효한 저장된 Agenda 행이 하나 이상 Sidebar에 보인다;
현재 Desk에는 자동으로 복원된 작업이나 새 작업이 독립적으로 포함되어 있을 수 있다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Sidebar의 저장한 Agenda 행을 클릭하거나, 방향키로 해당 행에 포커스를 둔 뒤 `Enter`를 누른다. | 클릭한 행의 대기/선택 피드백: `Q-AG-04` | System이 선택한 Agenda와 이미 열린 projection 여부를 읽는다. | 없음 | 영속적 Agenda가 변경되지 않음 | 누락되거나 손상된 Agenda의 피드백과 다음 행동: `Q-AG-05` |
| 2 | 없음 — 행 활성화 후 자동 | 같은 Canvas에 해당 Agenda의 영역과 구성 view가 나타나거나, 이미 열려 있으면 그 영역이 식별되어 포커스된다. 기존 자동 복원 view와 다른 Agenda projection은 그대로 남는다 | System은 새 Desk를 만들지 않고 Agenda projection을 같은 Canvas에 추가하거나 기존 projection을 재사용한다 | 없음 | 열린 Agenda projection 집합과 Canvas focus가 변경될 수 있음 | 초기 위치·겹침 회피·활성 표시: `Q-OBJ-04`, `Q-AG-04`; Workspace는 생성되지 않음 |
| 3 | 없음 — 자동 | 사용 가능한 리소스가 나타난다; 사용할 수 없는 리소스에는 `Q-AG-05`에서 정의한 조치 가능한 경계가 표시된다 | System은 허용된 view/runtime를 각자의 수명주기로 재구성하고 Agenda projection에 연결한다. | 없음 | 현재 뷰/런타임이 변경되며, 저장된 Agenda 리비전은 다시 작성되지 않음 | 부분 열기 완료 피드백: `Q-AG-04` |

**완료 증거**: 선택한 Agenda의 projection이 같은 Canvas에서 식별되고, 기존 Desk
상태와 다른 열린 Agenda projection은 교체되지 않으며, 사용할 수 없는 구성원은
해당 projection 안에서 조치 가능한 상태로 보인다.

<a id="atlas-ag-03"></a>
#### AG-03. 현재 작업에서 Agenda 저장 또는 업데이트

**상세 조작**: [agenda](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda)

**기술 참조**: [Desk·Agenda 수명주기](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-desk-lifecycle), [로컬 저장](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-storage-export)

**제품 전제**: 저장된 Agenda 영속성과 자동 Desk 영속성은 계속 분리된다  
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: Desk에 새 Agenda나 기존 Agenda의 대상이 될 수 있는 작업이
포함되어 있고, 대상/범위는 아직 저장 확정되지 않았다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Agenda bar `[저장]`에서 포함 범위를 확인하고 `[업데이트]` 또는 `[다른 이름으로 저장]`을 선택한다. | 선택한 동작은 `Q-AG-07`을 따르고, 제안된 영속성 범위는 `Q-AG-08`에 따라 보인다 | System은 해당 범위에 따라 어떤 뷰, 바인딩, 레이아웃, 산출물 및 워크플로 상태가 대상이 되는지만 판단한다. | 없음 | 대기 중인 Agenda 작업; Desk 세션은 변경되지 않음 | 모호한 대상/범위는 `Q-AG-14`를 통해 계속 편집할 수 있다 |
| 2 | `[저장]`을 누른다. 충돌이면 `[기준/최신/내 변경]`에서 값을 고르고 `[병합 저장]`, `[새 Agenda로 저장]` 또는 `[취소]`를 누른다. | 저장/업데이트 피드백과 대상 리비전이 `Q-AG-14`와 `Q-AG-17`에 따라 나타난다 | System은 결정된 Agenda 범위만 영속화한다 | 없음 | 영속적 Agenda가 변경되며, 자동 Desk 세션은 계속 다른 기록으로 유지됨 | 리비전/충돌 의미론: `Q-AG-16`; 정확한 충돌/취소/재시도 UI: `Q-AG-17` |
| 3 | 저장 뒤 Dock에서 자료를 열거나 View bar를 드래그하고, `[⋯] → [크기]`에서 크기를 변경한다. | 나중에 발생한, 저장되지 않은 Agenda 관련 변경은 `Q-AG-15`에 따라 저장된 리비전과 구분된다 | System은 자동 Desk 세션 기록을 별도로 계속한다 | 없음 | 이후 세션 변경이 Agenda를 묵시적으로 업데이트하지 않음 | 정확한 다시 저장/나가기/보호 행동: `Q-AG-15` |

**완료 증거**: 저장된 리비전을 다시 열 수 있으며, 해당 Agenda에
저장되지 않은 이후의 자동 Desk 세션 변경과 가시적으로 구분된다.

<a id="atlas-ag-04"></a>
#### AG-04. Agenda 이름 변경, 보관/닫기, 삭제 및 복구

**상세 조작**: [agenda](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda) · [input](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-input) · [agenda-lifecycle](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda-lifecycle)

**기술 참조**: [Desk·Agenda 수명주기](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-desk-lifecycle), [로컬 저장](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-storage-export)

**제품 전제**: Agenda 닫기는 전용 runtime의 종료를 확인한 뒤 projection을 제거하며 Saved Agenda를 보존한다. 이름 변경·보관·삭제·복구 경로는 상세 조작을 따르고, 휴지통 여부·보존 기간·복구 이력 범위는 연결된 사용자 선택에 따른다.
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: 영속적인 저장된 Agenda 행이 존재한다. 해당 Agenda projection은
현재 Canvas에 열려 있을 수도 있고 Sidebar에만 저장된 상태일 수도 있다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | 저장한 Agenda 행의 `[⋯]`를 클릭하거나, 해당 행에 포커스를 두고 `Shift+F10`을 누른다. | 사용 가능한 수명주기 행동과 사용할 수 없는 이유: `Q-AG-09` | System이 Agenda를 식별한다. | 없음 | 변경 없음 | 메뉴 닫기/포커스 복귀: `Q-UX-02` |
| 2 | 행의 `[⋯] → [이름 변경]` 또는 F2를 누르고 이름을 입력한 뒤 `[확인]`·Enter 또는 `[취소]`·Esc를 사용한다. | 인라인 편집기 또는 대화상자, 유효성 검사 및 저장된 이름 피드백은 `Q-AG-09`에서 정의한다 | System은 Agenda 메타데이터만 업데이트한다. | 없음 | Agenda의 동일성은 유지되며, 제목은 변경될 수 있음 | 실패 시 이전 제목과 편집 가능한 입력이 유지된다 |
| 3 | 행 메뉴의 `[Agenda 닫기]`, `[보관함으로 이동]` 또는 `[열기/영역으로 이동]`을 선택한다. 보관은 목록 분류만 바꾼다. | 전용·공유 runtime의 영향을 확인할 수 있다. 닫는 동안에는 종료 진행 상태가 남고, 종료가 확인되면 해당 Agenda 영역이 사라지며 Saved Agenda 행은 Sidebar에 남는다 | 전용 runtime의 새 행동·자동 재개를 막고 종료한다. 종료 확인 후 projection을 제거하고 다른 Agenda나 view가 소유하는 shared runtime은 그 표현과 함께 유지한다. 보관은 별도 정책을 따른다 | 전용 작업에 더 이상 새 행동을 요청하지 않는다 | 전용 runtime 종료가 확인돼야 닫힘이 된다. 종료 실패·상태 불명은 표시를 유지한다 | 이미 외부에 접수된 행동이 닫기로 취소되지는 않는다. 정확한 영향·실패·포커스·다시 열기 UI는 `Q-AG-11`, `Q-AG-19` |
| 4 | `[저장한 Agenda 삭제]`에서 대상·실행 영향을 보고 정책에 따른 `[휴지통으로 이동]` 또는 `[영구 삭제]`를 누르거나 `[취소]`한다. | 범위, 유지되는 기반 리소스, 참조 및 영구성이 명시된다 | System은 확인 성공 후 결정된 Agenda 기록만 삭제한다 | 없음 | 영속적 Agenda가 제거될 수 있음 | 취소/실패/복구 경로: `Q-AG-20` |
| 5 | 복구 가능한 항목은 `[휴지통] → 항목 → [복구]`로 되돌린 뒤 별도로 `[복구한 Agenda 열기]`를 누른다. | 복원된 행과 완료 피드백이 나타난다 | System은 유지된 Agenda 기록을 복원한다. | 없음 | 영속적 상태가 복원됨 | 복구를 지원하지 않는 경우 삭제 전에 파괴 작업의 영구성을 명시한다 |

**완료 증거**: Saved Agenda, 열린 projection, 유지되는 runtime과 복구 가능성이 선택한 행동을 반영한다. 부분 실패는 완료·남음·미확인을 나누어 표시하고 미완료 대상만 재시도한다. 이미 저장·종료·삭제된 항목이 취소로 되돌아왔다고 표시하지 않는다.

### 1.4 Canvas·Browser·파일 사용

<a id="atlas-v-01"></a>
#### V-01. Desk 뷰로 리소스 열기

**상세 조작**: [agenda](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda) · [view](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-view) · [discovery](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-discovery) · [restore](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-restore) · [shell](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-shell)

**기술 참조**: [Resource·View·Authority](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-resource-identity)
**사용자 결정 참조**: [HUM-SURFACE-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001)

**제품 전제**: 활성 화면의 공통 명칭은 View(뷰)다. Card는 간결한 표현 형식이고 Desk Window는 이전 명칭이며 별도 저장·실행 객체가 아니다.<br>
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: 사용 가능한 Desk가 존재하고 사용자는 승인된 하나의
리소스 진입 화면에 도달했다; 이 행동으로 새 뷰나 런타임이 아직 생성되지 않았다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Dock의 Browser·파일·Chat, 상단 `[자료]`·`[찾기]`, Canvas 파일 드롭 또는 Chat의 자료 링크로 대상을 고른다. | 대상과 의도한 열기/포커스 행동이 `Q-VIEW-02`와 `Q-VIEW-11`에 따라 보인다 | System은 리소스 locator와 접근 context를 해석한다. | 제품 사용자가 리소스 열기를 위임한 경우에만 그 요청을 제출하며, 그 외에는 없음. | 리소스 변경 없음 | 누락/미지원/권한 없음 피드백: `Q-VIEW-03` |
| 2 | 결과의 이름·`[열기]`를 누른다. 중복 안내에서는 `[기존으로 이동]` 또는 `[새 View 열기]`를 고른다. | Browser View·File View·Chat View처럼 유형이 표시된 View가 열리거나 기존 View로 이동한다. | identity·권한·mode를 확인해 기존 View를 재사용하거나 허용된 새 View를 연결한다. | 없음 | 활성 View·자동 세션만 변경되며 Saved Agenda는 변경되지 않는다. | 별도 View가 원본 사본·독립 runtime을 뜻하지 않는다. 관련: `Q-OBJ-03`, `Q-VIEW-02`, `Q-VIEW-11`. |
| 3 | Browser의 주소/탐색 bar, File의 편집·`[저장]`, Terminal의 `[입력 시작]` 등 해당 유형의 컨트롤을 사용한다. | 해당 리소스 흐름에서 정의한 네이티브 또는 조정된 리소스 피드백이 나타난다 | System은 입력을 해당 리소스 또는 runtime 소유자에게 전달한다. | 제품 사용자가 이 행동을 위임한 경우에만 수행하며, 그 외에는 없음. | 런타임/리소스는 해당 도구에 따라 변경될 수 있음 | 저장/외부 효과 증거는 리소스별 흐름에 속한다 |

**완료 증거**: 의도한 리소스가 올바른 위치와 올바른 권한·가능 행동 컨텍스트를 갖춘 상태로 보이며,
모든 변경이나 외부 효과에는 `Q-VIEW-09`에서 요구하는
리소스별 증빙이 있다.

<a id="atlas-v-02"></a>
#### V-02. 뷰 이동, 크기 조절, 그룹화, 포커스, 최대화 및 닫기

**상세 조작**: [view](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-view) · [agenda-lifecycle](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda-lifecycle)

**기술 참조**: [기술 계층 지도](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-layer-map), [관찰·renderer 수명주기](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-observation-fidelity)

**제품 전제**: View bar·메뉴·숫자 입력·키보드로 이동·크기·그룹·집중 보기·닫기를 조작한다. 그룹의 세션·Agenda 보존 여부는 연결된 사용자 선택에 따른다.<br>
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: 하나 이상의 활성 뷰가 Canvas에 있으며, 현재의
뷰, 리소스/런타임, 자동 세션 및 Agenda 상태를 서로 구분할 수 있다.

Canvas viewport 밖으로 pan된 뷰는 닫힘이나 sleep 상태가 아니다. 각 view/runtime의
lifecycle은 가시성만으로 결정하지 않으며, 무거운 renderer를 분리하는 경우에도
Canvas에는 해당 view를 다시 찾고 상태를 식별할 수 있는 가벼운 표현이 남는다.

View bar 더블클릭 또는 `[⋯] → [집중 보기]`는 기존 비율을 유지해 카메라만 맞춘다. Browser 내부 viewport와 저장된 크기는 바꾸지 않는다. `[집중 보기 종료]` 또는 셸 bar의 Esc는 이전 시점으로 돌아간다. 실제 resize·페이지 zoom·OS 전체 화면은 별도 동작이며 Canvas 탐색은 Agent의 작업 대상을 바꾸지 않는다. 관련: `Q-VIEW-06`, `Q-VIEW-12`.

| 작업 | 제품 사용자 UI 행동 | 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 / 다음 행동 |
| --- | --- | --- | --- | --- | --- | --- |
| 이동 | View bar를 드래그하거나 `[⋯] → [이동]`에서 좌표·이동 버튼을 사용하고 `[적용]`한다. | 뷰가 포인터를 따라가고 최종 Canvas 위치에 자리 잡는다 | System이 활성 뷰/세션 지오메트리를 업데이트한다. | 없음 | Agenda는 명시적으로 저장/업데이트한 경우에만 변경됨 | 충돌, 스냅, Canvas 밖, 키보드 대안: `Q-VIEW-04` |
| 크기 조절 | 가장자리 handle을 드래그하거나 `[⋯] → [크기]`에서 폭·높이를 입력해 `[적용]`한다. | 크기 미리보기와 최종 경계가 나타난다 | System이 활성 뷰/세션 지오메트리를 업데이트한다. | 없음 | Agenda는 변경되지 않음 | 최소/최대/종횡비 동작: `Q-VIEW-04` |
| 그룹화 | Shift+View bar 클릭 또는 `[화면 목록]` 체크박스로 선택한 뒤 `[그룹으로 묶기]`·`[그룹 해제]`·`[상위 그룹]`을 사용한다. | 중첩 그룹과 내부 목록이 보인다. 해제해도 자식의 Canvas 절대 위치는 유지된다. | 그룹 순환을 막고 배치 관계만 변경한다. | 없음 | 세션 복원·Agenda 저장에 그룹을 포함할지는 각각의 보존 정책을 따른다. 소속·권한·실행 소유는 바뀌지 않는다. | 실패에는 `[다시 기록]`, 자기 배치 변경에는 `[배치 실행 취소]`를 제공한다. 관련: `Q-VIEW-05`, `Q-VIEW-10`. |
| 포커스 | View bar를 클릭하거나 F6로 셸에 나온 뒤 `[화면 목록]`에서 방향키로 대상을 고르고 Enter를 누른다. | 키보드 포커스, 콘텐츠 활성, 배치용 선택과 입력권 표시가 서로 구분된다 | System이 해당 control에 포커스를 전달하고 기존 입력권을 확인한다. | 없음 | 대상 control의 포커스가 변경됨 | Chat 콘텐츠 클릭·Canvas 클릭에 따른 활성 전환은 [V-03](#atlas-v-03), Browser/편집기/Terminal 단축키 소유권은 `Q-VIEW-04` |
| 집중 보기·최대화 | View bar를 더블클릭하거나 `[⋯] → [집중 보기]`를 누른다. `[집중 보기 종료]` 또는 셸 bar의 Esc로 돌아간다. | 대상이 기존 비율을 유지하며 확대된다. 원래 시점으로 돌아갈 수 있고, 다른 전체 화면 모드와의 관계는 `Q-VIEW-06`을 따른다 | System은 기존 프레젠테이션 지오메트리를 보존하고 집중 보기의 확대를 적용한다 | 없음 | 프레젠테이션 상태가 변경되며 저장된 지오메트리는 복구 가능함 | Browser 내부 viewport·layout 영향과 유지되는 UI는 `Q-VIEW-06`; 복귀·키보드 경로는 `Q-VIEW-12` |
| 닫기 | bar의 `[× View 닫기]`를 누른다. 미저장 내용이 있으면 원본 저장·허용된 초안 보존·저장하지 않기·취소 중 표시된 행동을 고른다. | renderer가 닫혀도 살아 있는 작업은 같은 View identity·위치의 접힌 node에 소유자·상태·`[다시 열기] [실행 종료…]`를 남긴다. | 미저장 처리와 안전한 detach를 확인하고 표현 상태를 기록한다. | 없음 | 원본·Saved Agenda·실행을 자동 삭제하거나 종료하지 않는다. | 닫기 실패는 기존 표시와 사유를 유지한다. 관련: `Q-VIEW-07`, `Q-VIEW-13`. |

**완료 증거**: 최종 뷰 지오메트리, 그룹화, 포커스, 최대화 또는
닫힘 상태가 보이며, Agenda 구성 관계나 기반 리소스를
묵시적으로 변경하지 않은 채 자동 세션 기록과 일치한다.

<a id="atlas-v-03"></a>
#### V-03. Canvas 탐색 및 열려 있는 항목 찾기

**상세 조작**: [view](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-view) · [discovery](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-discovery) · [input](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-input)

**기술 참조**: [기술 계층 지도](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-layer-map), [접근성](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-accessibility)

**제품 전제**: `[화면 목록]`, 상단 `[찾기]`, 기본 접힘 `[미니맵]`, `[전체 보기] [돌아가기]`로 viewport 밖 대상을 찾는다. 탐색은 카메라·포커스만 바꾸고 소속·권한·실행 대상을 변경하지 않는다.<br>
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: Canvas는 열려 있는 뷰가 0개 이상인 상태에서 사용할 수 있다; 현재
뷰포트, 콘텐츠 활성, 키보드 포커스 및 배치 선택은 구별된다. 아래 1–4는 열린 Chat과 Canvas 사이를 오가는 예다. Chat이 없는 빈 Canvas에서는 바로 두 손가락으로 탐색할 수 있다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Chat 본문 또는 작성기를 클릭한다. | Chat 프레임·헤더에서 콘텐츠 활성 상태가 구별된다. 작성기를 클릭했다면 입력 커서가 나타난다. | 해당 Chat의 콘텐츠 활성 상태를 반영한다. | 없음 | 사람의 조작 대상이 Chat 콘텐츠가 된다. | 배치용 선택·hover·Agent 제어 표시와 구별한다. |
| 2 | 활성 Chat 위에서 두 손가락으로 스크롤한다. | 대화 또는 작성기 내부가 스크롤되고 Canvas는 움직이지 않는다. | 활성 Chat에 스크롤을 전달한다. | 없음 | Chat 내부 scroll 위치만 변경된다. | 끝까지 스크롤해도 Canvas pan으로 넘어가지 않는다. |
| 3 | 빈 Canvas를 클릭한다. | Chat 콘텐츠 활성 표시가 풀리고 기존 대화·초안·배치는 남는다. | 콘텐츠 활성을 해제하고 Canvas 탐색 상태로 전환한다. | 없음 | 클릭 자체는 카메라를 이동하지 않는다. | 별도 Pan 버튼을 누를 필요가 없다. |
| 4 | 포인터를 비활성 Chat 위로 옮긴 뒤 두 손가락으로 민다. | Chat은 비활성인 채 Canvas 화면이 이동한다. Chat 내부의 대화 위치는 유지된다. | hover로 재활성화하지 않고 Canvas camera에 pan을 적용한다. | 없음 | 뷰포트만 바뀌며 객체 배치·Browser viewport·실행 대상은 유지된다. | 다시 Chat을 조작하려면 본문 또는 작성기를 클릭한다. 경계·모션 감소·키보드 대안은 `Q-VIEW-08`, `Q-UX-03`. |
| 5 | 상단 `[찾기]`·`[명령]`, Sidebar `[Agenda 찾기]` 또는 `[화면 목록]`을 열고 검색어를 입력한다. | 쿼리, 범위, 진행 상황 및 결과 목록이 `Q-DISC-02`에 따라 나타난다 | System은 결정된 로컬 index와 화면을 검색한다. | 의미 기반 검색을 명시적으로 요청한 경우에만 검색을 보조하며, 그 외에는 없음. | 임시 쿼리 | 유효하지 않음/결과 없음 상태에서도 구체적인 편집/닫기 행동이 유지된다 |
| 6 | 결과 이름을 클릭하거나 방향키로 선택한 뒤 Enter를 누른다. `[상세]`는 열기 없이 출처·권한을 검사한다. | Canvas가 `Q-DISC-02`에 따라 대상으로 이동하거나 대상을 연다 | System은 결과를 기존 뷰, 저장된 Agenda, Library 항목 또는 리소스로 해석한다 | 없음 | 뷰포트/포커스 또는 활성 뷰 상태가 변경됨 | 현재 기준/대상과 불일치하는 결과의 피드백과 다음 행동: `Q-DISC-02` |

pinch 또는 `[+]`·`[−]`는 Canvas 배율을 바꾼다. 보조 드래그는 빈 Canvas의 `⌘/Ctrl+드래그`, 키보드는 보조 `[Pan]` 도구와 Canvas 배경 포커스에서 방향키를 사용한다. 미니맵은 `[미니맵]` → 지점 클릭으로 이동한다. 이 보조 경로들은 위의 두 손가락 pan을 시작하기 위한 필수 단계가 아니다. [입력 활성·탐색 상세](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-canvas-input).

**완료 증거**: 이름이 지정된 대상이 포커스되거나 열리고 계속
키보드로 접근할 수 있다; 현재 기준/상태와 불일치하거나 누락된 대상이 있어도 쿼리는 편집 가능한 상태로 유지되며
다음 행동은 `Q-DISC-02`에서 정의한다.

<a id="atlas-disc-01"></a>
#### DISC-01. Library 및 재사용 가능 리소스 탐색

**상세 조작**: [discovery](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-discovery)

**기술 참조**: [Resource identity](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-resource-identity), [로컬 index](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-storage-export)

**제품 전제**: Library는 명시적으로 선별한 참조 목록이다. 자료·Agenda·결과·Snapshot 제공형, 자료만 제공형, 독립 큐레이션 미제공형의 상세 경로가 있으며 어느 범위를 제공할지는 연결된 사용자 선택에 따른다.<br>
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: Library 제공 정책이면 Sidebar `[Library]`에서 시작한다. 미제공 정책이면 `[찾기]` 또는 참고용 Saved Agenda를 사용하며 숨은 수집 목록을 만들지 않는다. 관련: `Q-OBJ-05`.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | 재사용 등록을 제공하는 정책이면 Sidebar `[Library]`를 누른다. 제공하지 않으면 `[찾기]`나 참고용 Saved Agenda를 연다. | Library 범위, 현재 위치 및 검색 가능한 범주가 `Q-OBJ-05`와 `Q-LIB-01`에 따라 나타난다 | System은 결정된 로컬 카탈로그만 불러온다. | 없음 | 열람 상태 | `Q-OBJ-05`가 결정되기 전까지 `Q-LIB-01`은 Library UI를 생성하지 않는다 |
| 2 | 검색어를 입력하고 `[범위]`·유형·PC·상태 필터를 고른다. `[지우기]`는 검색어만 지운다. | 일치하는 리소스, 저장된 Agenda 또는 산출물이 유형/출처별로 구분된다 | System은 결정된 index를 조회한다. | 의미 기반 검색을 별도로 요청한 경우에만 검색을 보조하며, 그 외에는 없음. | 임시 쿼리 | 결과 없음, 최신 상태가 아닌 결과, 접근이 거부된 결과 및 오프라인 결과에도 편집/닫기 행동이 유지된다 |
| 3 | 항목의 `[열기]`, `[현재 Agenda에 참조 추가]` 또는 Saved Agenda의 `[Agenda 열기]`를 누른다. | 열기는 대상 View·Agenda로 이동하고 참조 추가는 Library 목록에 `추가됨`을 표시한다. | 대상 identity·권한과 고정된 추가 대상 Agenda를 검증한다. | 없음 | 열기·참조 추가·등록 상태를 각각 변경한다. | 허용 유형의 자료 메뉴 `[Library에 추가] → [등록]`은 참조만 등록한다. `[Library에서 제거]`는 등록만 해제하고 원본은 유지한다. 관련: `Q-OBJ-05`. |

**완료 증거**: Library가 승인된 경우 선택한 카탈로그 항목이
출처가 보이는 상태로 식별된 리소스를 열거나 포커스한다; 그 결정 전에는
Library 객체나 영속성 효과가 있다고 주장하지 않는다.

<a id="atlas-tool-01"></a>
#### TOOL-01. Browser, 프로필/계정 권한·가능 행동 및 출처 식별성

**상세 조작**: [identity](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-identity) · [browser](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-browser)

**기술 참조**: [Source·Resource·Authority](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-resource-identity), [Identity planes](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-engine-profile)

**제품 전제**: Firefox 기반 Browser는 핵심이며, 콘텐츠 동일성·locator·보이는 view와 계정/프로필별 권한·가능 행동 컨텍스트를 서로 분리한다  
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: Desk를 사용할 수 있고 Firefox
프로필/컨테이너/계정별 권한·가능 행동 컨텍스트가 0개 이상 이미 존재할 수 있다; 콘텐츠 동일성과
행동 권한은 하나의 식별 체계로 통합되지 않았다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Dock `[Browser]`를 누르고 주소를 입력한다. 다른 계정이 필요하면 bar `[계정·권한]`을 연다. | URL/콘텐츠 식별성과 활성 권한·가능 행동 컨텍스트가 `Q-AUTH-02`에 따라 서로 구분되어 표시된다 | System은 Browser 컨텍스트와 사용 가능한 행동을 바인딩한다. | 없음 | Browser 런타임/보기 상태 | 로그인/권한/계정 상태가 누락되면 `Q-AUTH-03`의 복구 행동이 노출된다 |
| 2 | `[계정·권한] → [다른 컨텍스트로 열기]`에서 PC·profile/container·사이트 계정을 확인하고 `[이 컨텍스트로 열기]`를 누른다. | 선택된 권한·가능 행동 컨텍스트와 변경되거나 변경되지 않은 사용 가능한 행동이 `Q-AUTH-02` 및 `Q-AUTH-07`에 따라 나타난다 | System은 Browser 컨텍스트를 변경하거나 유지한다. | 없음 | 권한·가능 행동/보기 상태가 변경된다; 콘텐츠 출처가 암묵적으로 분리되지 않는다 | 인증/권한 복구는 별도의 `BROWSER-02` 경로이다 |
| 3 | `[같은 자료가 열려 있음]`에서 `[기존으로 이동]`·`[새 View 열기]`를 선택하고 `[출처]`에서 내용과 행동 권한을 구분해 본다. | 중복 미리보기, 선택한 보기 행동, 동일 콘텐츠 관계 및 권한·가능 행동 컨텍스트 차이가 보인다 | System은 출처/콘텐츠/리소스/권한/보기를 각각 별도로 기록한다 | 없음 | 증거와 행동 감사는 서로 구분된 상태로 유지된다 | 실패 및 포커스 복귀: `Q-AUTH-08` |

**완료 증거**: 콘텐츠 동일성/출처 식별성과 계정/프로필 행동 권한이
각각 별도로 보인다; 권한·가능 행동 컨텍스트 전환 자체가 탐색, 인증, 다운로드 또는
외부 효과의 성공을 나타내지는 않는다.

<a id="atlas-browser-01"></a>
#### BROWSER-01. 페이지 탐색, 새로고침, 복구 및 재진입

**상세 조작**: [browser](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-browser)

**기술 참조**: [Resource·View·runtime identity](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-resource-identity), [장애 경계](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries)

**제품 전제**: Firefox 기반 페이지 탐색은 핵심이다  
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: Browser 보기와 명시적인 권한·가능 행동 컨텍스트가 존재한다;
대상 URL은 비어 있거나, 현재 URL이거나, 입력 또는 붙여넣기되었거나, 링크에서 활성화되었을 수 있다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Browser 주소 입력란을 클릭하거나 `⌘/Ctrl+L`을 누르고, URL을 입력·붙여넣은 뒤 `Enter` 또는 `[이동]`을 누른다. | 입력한 URL, 로딩 상태, 최종 URL, 페이지 제목 및 보안/오류 상태가 나타난다 | Firefox가 바인딩된 컨텍스트에서 주소를 해석하고 로드한다. | 없음 | Browser 기록/런타임/세션 상태가 변경된다 | 잘못된 URL, 오프라인, 인증서 오류, 차단, HTTP 오류 또는 렌더링 실패가 발생하면 편집/재시도/뒤로 행동이 노출된다 |
| 2 | 페이지 링크나 Browser bar의 `[뒤로]`·`[앞으로]`·`[새로고침]`·`[로딩 중지]`를 누른다. 주소 변경은 주소 입력 후 Enter로 시작한다. | 페이지 성공을 섣불리 나타내지 않으면서 요청된 기록/로딩 전환이 보인다 | Firefox가 선택된 탐색 행동을 수행한다. | 없음 | 기록/런타임 상태가 변경된다 | 리디렉션·팝업·새 View는 연결된 Browser 상세의 탐색 경로를 따른다. 관련: `Q-BROWSER-01` |
| 3 | 앱이 닫혔으면 OS Dock의 EG-Desk 아이콘을 클릭해 다시 연다. 복원된 Browser View를 선택하거나 `[최근 Browser ▾]` → 해당 Browser 행을 클릭한다. | 복원된 URL/기록, 로딩, 오프라인 또는 사용 불가 상태가 나타난다 | System은 보기를 재구성한다; Firefox는 결정된 탐색/세션 상태만 복원한다. | 없음 | 활성 Browser 상태가 재구성된다 | 재진입이 인증된 상태 또는 완료된 외부 상태를 의미하는 경우는 없다 |

**완료 증거**: 보이는 최종 URL, 바인딩된 권한·가능 행동 컨텍스트,
Firefox 로딩/오류 상태 및 사용 가능한 페이지가 서로 일치한다; 복구와 재진입이
인증 또는 외부 효과를 암묵적으로 성공했다고 나타내지는 않는다.

<a id="atlas-browser-02"></a>
#### BROWSER-02. Browser 인증 또는 권한 복구

**상세 조작**: [approval](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-approval)

**기술 참조**: [Identity·Authority](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-resource-identity), [Engine/Browser identity 분리](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-engine-profile)

**제품 전제**: 계정·권한과 콘텐츠 동일성은 분리된다. Browser의 `[계정·권한]`에서 연결 복구를 시작하고 provider 인증 뒤 실제 계정·허용 범위를 다시 확인한다. AI Engine 계정은 별도로 유지한다.<br>
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: Browser 리소스에 로그인, 권한 갱신 또는
계정 수정이 필요하며, 현재 권한·가능 행동 컨텍스트가 보인다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Browser bar `[계정·권한]`에서 해당 서비스의 `[다시 연결]`·`[의도한 계정으로 다시 로그인]` 또는 `[인증 화면 다시 열기]`를 누른다. | 제공자, 계정, 요청된 범위, 목적지/복귀 대상 및 취소 행동이 보인다 | System은 provider 고유 또는 Firefox 인증 흐름을 연다. | 이미 위임된 인증 보조 작업이 이 흐름을 요청한 경우에만 관여하며, 그 외에는 없음. | 인증 전환 대기 중 | Agent가 요청한 새 자격 증명/범위는 `Q-ORCH-05` 및 `A-AUTH-01`에 따라 분류된다 |
| 2 | provider가 표시하는 계정 선택·로그인·범위 허용을 직접 완료하거나 그 인증 화면을 취소한다. 비밀번호·보안키는 provider/OS 화면에만 입력한다. | 제공자의 성공/취소/오류와 그 결과인 EG-Desk 권한·가능 행동 컨텍스트가 각각 별도로 나타난다 | Firefox/제공자는 명시적으로 완료된 세션 또는 권한 부여만 설정한다 | 없음 | Browser의 권한·가능 행동 상태가 변경될 수 있다 | 비밀번호/토큰 처리, 거부된 범위, 팝업 소실, 시간 초과 및 계정 불일치 시 복구 행동이 유지된다 |
| 3 | `[연결 결과 확인]` 또는 `[계정·권한]`으로 실제 계정·범위를 확인하고 `[원 업무로 돌아가기]`를 누른다. | 보호된 리소스가 지정된 권한·가능 행동 컨텍스트에서 로드되거나 계속 거부된다 | System은 그 결과로 접근 가능한 행동 집합을 검증한다. | 없음 | 접근에 성공한 경우에만 리소스/런타임 상태가 변경된다 | 로그인 성공은 요청된 다른 외부 행동이 성공했다는 증거가 아니다 |

**완료 증거**: 실제 로그인/권한 상태와 사용 가능한
행동이 지정된 권한·가능 행동 컨텍스트에 대해 보인다; 취소, 만료 또는
거부가 인증 성공으로 표시되지 않는다.

<a id="atlas-browser-03"></a>
#### BROWSER-03. 파일을 다운로드하여 EG-Desk로 전달

**상세 조작**: [browser](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-browser) · [files](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-files) · [input](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-input)

**기술 참조**: [Resource identity](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-resource-identity), [immutable object 저장](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-storage-export)

**제품 전제**: 다운로드 링크·진행 표시·완료 표시는 각각 로컬에서 사용할 수 있는 파일과 같지 않으며, 최종 확정된 대상과 무결성·가독성 증거를 별도로 확인한다  
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: Browser 페이지에 다운로드 대상이 노출되고 활성
권한·가능 행동 컨텍스트를 알고 있다; 아직 로컬 산출물은 존재하지 않는다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | 페이지의 실제 다운로드 링크를 누르고 Browser `[다운로드 N]`에서 제안 파일명·소스·계정·목적지를 확인한다. | 소스 URL, 알려진 경우 제안된 이름/유형/크기, 대상 위치 상호작용 및 진행/취소 상태가 나타난다 | Firefox는 자체 검사를 마친 후에만 다운로드를 시작한다. | 제품 사용자가 이 다운로드를 정확히 위임한 경우에만 실행을 요청하며, 그 외에는 없음. | 다운로드/런타임 상태; 아직 검증된 파일은 없음 | 차단, 거부, 중복, 안전하지 않음, 중단 및 대상 위치 실패는 서로 구분된 상태로 유지된다 |
| 2 | 필요하면 OS 목적지를 고르고 진행 행의 `[일시정지]`·`[취소]`·지원되는 `[재개]` 또는 `[처음부터 다시 받기]`를 누른다. | 대기 중, 취소됨, 실패 또는 다운로드 완료 상태가 보인다 | Firefox는 로컬 산출물을 쓰고 최종 확정한다; System은 사용 가능한 파일 증거만 기록한다 | 없음 | 로컬 파일 상태가 변경될 수 있다 | 완료 UI만으로는 콘텐츠를 읽을 수 있음이 입증되지 않는다 |
| 3 | 완료 행의 `[Desk에서 열기]` 또는 `[위치 표시]`를 누른다. | 정확한 로컬 대상이 `TOOL-02`를 통해 열리거나 해당 위치와 실패가 표시된다 | System은 최종 확정된 파일 대상을 식별하고 적절한 보기를 연다. | 없음 | 파일/보기/세션 상태가 변경된다 | 누락/격리/손상/미지원 파일은 `Q-BROWSER-02` 및 `Q-CODE-02`를 따른다 |

**완료 증거**: 최종 확정된 로컬 경로, 사용 가능한 크기/해시 또는 기타
무결성 증거, 읽을 수 있는 파일 상태 및 열린 대상이 서로 일치한다; 페이지 UI 또는
다운로드 시작 이벤트만으로는 충분하지 않다.

<a id="atlas-browser-04"></a>
#### BROWSER-04. Browser 외부 효과 수행 및 검증

**상세 조작**: [approval](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-approval) · [browser](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-browser)

**기술 참조**: [Authority·evidence 분리](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-resource-identity), [협업·외부 경계](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-collaboration-computer-use)

**제품 전제**: 승인과 실행 성공은 서로 분리된다; 위임된 범위
내의 일반적인 효과에는 새로운 승인이 필요하지 않다  
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: Browser 행동이 제출, 전송, 게시, 구매,
변경 또는 그 밖의 방식으로 외부 상태에 영향을 줄 수 있다; 실행 전에 대상, 행위자/컨텍스트 및 현재
위임된 권한을 검사할 수 있다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Chat에 요청을 입력해 `[전송]`한다. 새 승인이 필요한 경우에만 해당 업무의 `[조치 필요 N건]`을 열어 계정·대상·내용·효과를 검토한다. 유효한 기존 위임 안이면 추가 클릭 없이 진행한다. | 기존 위임으로 진행 중인 행동과 추가 승인 대기 행동이 구분된다. 검토를 연 경우 대상·계정·범위·가역성이 보인다. | 현재 위임·계정·권한·요청 범위를 검사한다. 유효한 위임이면 별도 승인 항목 없이 실행 경로로 보내고, 새 권한이 필요하면 해당 행동만 대기시킨다. | 위임된 범위 안에서만 준비하거나 행동한다 | 허용된 실행 준비·진행 또는 추가 승인 대기; 요청만으로 외부 성공 상태가 되지 않는다. | 새로운 인프라, 자격 증명, 외부 데이터/비용/배포 또는 더 넓은 권한은 `Q-ORCH-05`를 통해 경로가 정해진다 |
| 2 | 추가 승인이 필요한 행동만 선택해 상세의 `[선택 N건 허용]`, `[거부] → [거부 확정]` 또는 `[보류]`한다. 기존 위임의 자동 실행은 추가 입력이 없다. 직접 제출이 필요한 경우만 `[사이트에서 계속]`에서 사이트의 해당 제출 버튼을 누른다. | 결정 저장·실행 요청·제공자 접수·처리 결과가 구분된다. 거부·보류하면 해당 행동은 실행하지 않는다. | 확정된 범위의 권한·일회 dispatch 조건을 검사한 뒤 실행하며 중복 효과를 만들지 않는다. | 이미 위임됐거나 이번에 허용된 범위에서만 도구 행동을 요청한다. | 외부 상태가 변경될 수 있다 | 시간 초과, 팝업 소실, 중복 제출 위험 및 모호한 결과는 무분별한 재시도를 차단한다 |
| 3 | `[접수 다시 조회]`·`[처리 상태 보기]`로 결과를 확인한다. 미접수 또는 안전한 멱등 재시도가 확인된 경우에만 `[같은 행동 재시도]`를 누른다. | 제공자 확인증과 독립적으로 검사 가능한 외부 상태가 구분되어 표시된다 | System은 관찰된 증거를 기록한다. | 권한상 허용된 수단을 통해 검증할 수 있다 | 증거/감사 상태가 변경된다 | 재시도에는 `Q-BROWSER-03`의 멱등성/중복 위험 처리가 필요하다 |

**완료 증거**: 의도한 대상 및 행위자가 제공자 확인증
또는 독립적으로 검증된 외부 상태와 일치한다; 승인, 클릭, 스피너 또는 `200`
응답만으로는 의도한 효과에 대한 충분한 증거가 되지 않는다.

<a id="atlas-tool-02"></a>
#### TOOL-02. 파일 또는 폴더 열기 및 작업

**상세 조작**: [files](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-files) · [input](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-input) · [changes](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-changes)

**기술 참조**: [Coding surface](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-coding-surface), [Resource identity](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-resource-identity)

**제품 전제**: 사람에게는 프로젝트·폴더·파일 탐색과 편집기·뷰어·변경 비교가 주된 코딩 경험이며, Terminal을 필수 사용자 UI로 가정하지 않는다  
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: Desk를 사용할 수 있으며 로컬 또는 허용된 외부
파일/폴더 대상을 승인된 진입 상호작용에 제시할 수 있다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Dock `[파일]`로 OS 파일을 고르거나 `[파일▾] → [폴더 연결]`·`[여러 위치·프로젝트]`, 트리 행, 최근 항목 또는 파일 드롭을 사용한다. | 선택된 경로/리소스, 프로젝트 관계 및 권한 상태가 나타난다 | System은 접근 가능 여부를 확인하고 적절한 뷰어/편집기를 연다. | 없음 | 활성 뷰/세션 상태 | 누락, 이동됨, 미지원 또는 거부된 파일 피드백: `Q-CODE-02` 및 `Q-CODE-07` |
| 2 | 편집기 본문에 직접 입력하거나 `[요청]`·`[선택 내용으로 요청]`으로 작성기를 열어 Agent 변경 요청을 전송한다. | 저장되지 않은 상태와 변경된 범위가 보인다 | System/편집기는 사람의 편집을 적용한다. | 위임된 범위 내에서만 편집할 수 있다 | 파일 콘텐츠가 변경될 수 있다; Agenda는 명시적으로 업데이트해야만 변경된다 | 충돌, 읽기 전용, 외부 변경, 실행 취소/다시 실행 및 미저장 변경 상태 동작: `Q-CODE-02` 및 `Q-CODE-06` |
| 3 | `[저장]` 또는 `⌘/Ctrl+S`로 저장한다. `[변경 N]`에서 비교하고 `[검사] → 검사 유형 → [실행]`으로 같은 revision의 결과를 확인한다. | 저장 확인증, 변경 비교에서 선택한 파일/변경 묶음, 결과 대상/리비전 및 검증 상태가 각각 별도로 나타난다 | System은 저장에 성공한 경우에만 영속화하고 동일한 리비전에 대한 검증 증거를 계산하거나 로드한다 | 없음 | 저장에 성공한 경우에만 파일 변경이 영구 반영된다; 검토 및 결과 보기 상태는 서로 분리된 상태로 유지된다 | 저장 실패: `Q-CODE-05`; 기준보다 뒤처졌거나 충돌하는 변경 비교 상태, 적용 실패 및 변경 비교 재진입: `Q-CODE-09`; 결과 실행/실패/탐색/재진입: `Q-CODE-08`; 보이는 편집기 상태만으로는 저장 증거가 되지 않는다 |

**완료 증거**: 파일 시스템 리비전, 보이는 편집기 상태, 변경 비교
및 검증 결과가 동일한 대상 리비전을 식별한다; 실패한 저장은
저장되지 않은 상태로 남으며 조치할 수 있다.

### 1.5 Chat·Agent·Smart Read·Answer Briefing

<a id="atlas-chat-01"></a>
#### CHAT-01. Agent 담당자 방 열기, 계속하기, 복구하기 및 재진입하기

**상세 조작**: [chat-entry](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-entry) · [context-share](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-share) · [agent-profile](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agent-profile)

**기술 참조**: [Context assembly](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-context-assembly), [Chat·Canvas Answer](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-answer-projection)

**제품 전제**: 기본 Chat은 안정적인 Agent identity에 연결된 담당자 방이다. Profile revision은 별도 실행 설정이며 교체해도 방·기억·업무를 합치지 않는다. 공유 대화는 별도 identity·참여자·공유 범위를 갖고 원본 방 전체를 자동 공유하지 않는다.
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: Chat에 접근할 수 있고 기존 대화가 전혀 없거나 하나 이상 존재할 수 있다.
Chat이나 대화를 열었다는 이유만으로 Agent 작업이 시작되지는 않는다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | EG-Desk Dock의 `[Chat]`을 클릭한다. 다른 담당자는 Chat의 `[방 목록]` → `[담당자]` 탭 → 이름·avatar로 구별되는 방 행을 클릭한다. | Canvas에 최근 사용한 Agent 방 또는 선택 화면이 열리고, 방 안에는 상대 Agent의 avatar·이름, message timeline, 요청 컨텍스트 영역, 작성기와 `[전송]`이 구분되어 보인다. 사용할 수 있는 Agent Profile이 없으면 같은 view에 `[Agent 설정]`과 작성기 비활성 사유가 나타난다 | System은 선택한 Agent 관계와 권한 있는 대화 projection을 불러온다. | 없음 | Chat view와 Agent 방 선택/초안 표시만 | Chat을 열어도 Run은 시작되지 않는다. 기본 제공 Agent/Profile 여부는 `Q-AGENT-02`; 같은 Agent 방의 업무 구분·정확한 레이아웃·포커스·재진입은 `Q-CHAT-01`–`Q-CHAT-03` |
| 2 | Chat 작성기를 클릭해 요청을 입력한 뒤 `[전송]`을 클릭하거나, 한글 조합을 끝낸 뒤 별도로 `⌘/Ctrl+Enter`를 누른다. | 작성기 클릭 때 Chat 콘텐츠 활성 표시와 입력 커서가 나타난다. 전송 뒤 제출된 메시지와 범위가 한정된 컨텍스트/작업 상태가 보인다 | System은 메시지를 기록하고 작업 컨텍스트를 결합한다. | 결합된 후에만 응답한다 | 대화 및 작업 상태가 변경된다 | 전송 실패 시 `Q-CHAT-02`에 따라 초안/메시지를 복구 가능한 상태로 유지한다 |
| 3 | 같은 대화의 작성기에 후속 내용을 입력한다. 필요하면 컨텍스트 항목을 클릭해 포함 여부·범위를 수정하고 `[적용]`한다. 작성기의 `[전송]`을 클릭한다. | 후속 내용이 이전 대화 및 자체 컨텍스트 개정과 관련되어 있음이 명확히 보인다 | System은 권한이 부여된 이전 컨텍스트와 새로 선택한 항목만 결합한다. | 그 범위 안에서 응답한다 | 새 메시지/작업 상태 | 이전 대화가 Desk 전체에 대한 접근 권한을 의미하지는 않는다 |
| 4 | 활동 옆 `[이 업무 중지]`, 실패의 `[실패 부분 재시도]`, 미수락 요청의 `[초안으로 복구]`·`[상태 다시 확인]`을 해당 상태에 맞게 사용한다. | 중지됨, 실패, 재시도 중, 중복 및 완료 상태가 서로 구분된 채 유지된다 | System은 선택한 전환을 기록한다. | 결정된 작업 범위만 중지하거나 다시 실행한다 | 작업 상태가 변경되며 이전 메시지는 유지된다 | 재시도는 외부 효과를 암묵적으로 중복 발생시키지 않는다 |
| 5 | OS Dock의 EG-Desk 아이콘을 클릭해 다시 열고, EG-Desk Dock의 `[Chat]` → `[방 목록]` → 이전 대화 행을 클릭한다. | 복원된 기록, 초안, 첨부 항목 및 작업/결과 상태가 `Q-CHAT-03`을 따른다 | System은 대화 projection을 재구성한다. | 새 메시지가 전송되기 전까지 없음. | 이전 Chat의 대화·초안 표시 상태가 복원된다 | 누락된 초안/첨부 항목/작업 대상에는 제거/재시도/새 메시지 행동이 제공된다 |

**완료 증거**: 상대 Agent 정체성이 보이는 담당자 방을 열고 범위가 한정된 후속
내용으로 계속하며, 상태의 모호함 없이 중지하거나 재시도하고, 다시 시작한 후
`Q-CHAT-03`의 지속성 경계를 확인할 수 있는 상태로 같은 관계에 재진입할 수 있다.

<a id="atlas-agent-01"></a>
#### AGENT-01. Agent Profile을 검사하고 다음 실행에 사용할 revision 선택

**상세 조작**: [agent-profile](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agent-profile) · [run-control](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control) · [reset](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-reset) · [input](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-input) · [identity](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-identity)

**기술 참조**: [Agent Profile·Run binding](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-agent-run-binding), [Engine Profile](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-engine-profile)
**사용자 결정 참조**: [HUM-AGENT-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agent-001), [HUM-RUN-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001), [HUM-ENGINE-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-engine-001)

**제품 전제**: Chat에 보이는 Agent 이름·상태와 실제 실행 구성은 연결되지만 같은 것은 아니다. Profile을 열어 보거나 편집하는 것만으로 Run이 시작되거나 권한이 넓어지지 않는다.  
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름<br>
**시작 상태**: EG-Desk에 0개 이상의 Agent Profile revision이 존재할 수 있다. 기본 제공 또는 예시 Profile을 최종 제품 카탈로그로 취급할지는 `Q-AGENT-02`가 정한다. Profile이 0개여도 Dock의 Chat은 열리지만, 같은 Chat view 안에 `[Agent 설정]`과 작성기·전송을 사용할 수 없는 이유가 보인다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
|---:|---|---|---|---|---|---|
| 1 | Chat header의 `[⋯]` → `[담당자 설정]`을 클릭한다. Profile 관리는 `[방 목록]` → `[Profile 관리]`를 클릭한다. | 선택한 Agent의 표시 정체성, Profile revision, 적용 범위, model/provider, tool capability, memory/context 정책, 권한 상한, 현재 가용성 상태가 서로 구분되어 나타난다. Profile이 없으면 `[새 Agent Profile]`이 첫 행동으로 보인다 | System은 저장된 Profile과 현재 가용성·권한 정보를 읽어 투영한다 | 없음 | 검사 화면과 포커스만 변경된다 | 원문 system instruction이나 비밀 credential 값을 반드시 노출한다고 가정하지 않는다. 표시 범위는 `Q-AGENT-08`, `Q-AGENT-12`, `Q-AGENT-13` |
| 2 | `[새 Agent Profile]`, 선택·복제·편집 중 하나로 Profile 초안을 열고 표시 이름, 허용된 personality/instruction, provider/model policy, tool 후보와 실행 제한을 수정하거나 `[취소]`한다. 외부 계정 또는 credential이 필요하면 별도의 `[계정 또는 API credential 연결]`을 제품 사용자가 실행한다 | 변경 전 revision과 초안, 각 필드의 출처·적용 범위, provider/model/tool 가용성, credential 연결 상태, 유효성 검사, `[저장] [취소]` 가능 여부가 보인다 | System은 `Q-AGENT-02`, `Q-AGENT-03`, `Q-AGENT-05`, `Q-AGENT-07`, `Q-AGENT-09`, `Q-AGENT-10`, `Q-AGENT-13`의 범위와 우선순위 규칙으로 초안을 검증한다 | 없음 | 아직 저장된 Profile이나 Run은 변경되지 않는다 | Personality, instruction, model, tool capability는 권한을 확대하지 않는다. 외부 계정·credential 연결은 `A-AUTH-01` |
| 3 | Profile 편집의 `[초안 저장]` 후 `[차이 보기]`·`[활성화]`를 사용한다. 저장과 활성화는 별도 결과로 확인한다. | 저장된 새 revision, 이전 revision과의 차이, 다음 Run에 적용되는 범위, 진행 중 Run에 미치는 영향이 표시된다 | System은 검증된 새 revision을 원자적으로 저장하고 이전 revision을 보존한다 | 없음 | Profile revision이 하나 추가되거나 명시된 메타데이터만 변경된다 | 진행 중 Run을 조용히 변경하지 않는다. 활성 Run 영향과 rollback은 `Q-AGENT-14`, `Q-AGENT-16` |
| 4 | 작성 중인 업무의 `[업무 ⋯]` → `[실행 설정]` → `[Agent 경로]`에서 `[추가]`·`[변경]`으로 Agent/Profile revision을 선택하고 `[저장]` → `[이번 업무에 적용]`을 클릭한다. 자동 경로는 `[자동 선택 내역]`에서 확인하고 필요하면 `[이번 업무에 고정]`을 클릭한다. 전송 전에는 초안 설정만 바뀐다. | 다음 요청에 선택된 표시 정체성, Profile revision, 경로 지정 범위와 fallback 정책이 보인다 | System은 선택을 정해진 앱/제품 사용자/Desk/Agenda/대화/요청 범위에만 기록한다 | 없음 | 다음 Run의 입력 설정만 바뀐다 | 정확한 소유·지속 범위는 `Q-AGENT-01`, `Q-AGENT-02`; provider/model fallback은 `Q-AGENT-03`, `Q-AGENT-04` |
| 5 | Profile 행 `[⋯]`에서 `[사용 중단]`·`[보관]`·`[이전 revision으로 적용]`·`[삭제]`·`[내보내기]`를 선택하고 대상·영향을 확인하거나 취소한다. | 영향받는 기본값, 과거 Run 참조, 공유 범위, 복구 가능성, migration 결과가 실행 전에 보인다 | System은 `Q-AGENT-02`의 수명주기 규칙과 데이터 경계를 검증한 뒤 확정된 행동만 적용한다 | 없음 | 성공한 경우에만 Profile lifecycle 상태가 바뀐다 | 과거 Run의 configuration snapshot과 감사 연결은 보존한다. 원격 공유/동기화는 `A-INFRA-01` 또는 `A-INFRA-03` |

**완료 증거**: 제품 사용자는 어떤 Agent 표시가 어떤 Profile revision과 연결되는지, 다음 Run에 무엇이 적용되는지, 무엇이 단지 가용 capability이고 무엇이 실제 권한인지 구분할 수 있다. 저장/선택 실패 시 이전 revision과 요청 초안은 그대로 남고 재시도 또는 취소할 수 있다.

<a id="atlas-agent-02"></a>
#### AGENT-02. 요청마다 유효한 Run configuration을 결합하고 도구 행동을 검증

**상세 조작**: [agent-profile](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agent-profile) · [run-control](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control) · [context-share](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-share) · [context-policy](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-policy) · [identity](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-identity)

**기술 참조**: [Effective Run binding](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-agent-run-binding), [Identity planes](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-engine-profile)

**제품 전제**: 한 Run의 유효 구성은 Profile 한 개로 결정되지 않는다. System은 실제 제품 사용자 요청·위임, 대화 context, Profile revision의 instructions·personality, System·provider policy, 실제 사용 Memory revision, 현재 tool/model 가용성, 계정·리소스 권한, credential binding, 승인, Ontology version, budget·sandbox를 결합한다. 첫 호출 뒤에도 새 자료와 사용자 조정은 같은 Run의 다음 모델 호출에 반영되며, 이전 호출이 받은 내용은 이력으로 남는다.
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름<br>
**시작 상태**: 전송 가능한 요청 초안과 선택되거나 자동 지정된 Agent Profile revision이 있지만, 아직 유효한 Run configuration snapshot은 없다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
|---:|---|---|---|---|---|---|
| 1 | 작성기의 `[전송]` 또는 조합이 끝난 뒤 별도 `⌘/Ctrl+Enter`를 누른다. | 수락된 요청과 결합 중인 Agent/Profile, context, effective instruction, Memory, model/tool 가용성, 권한 또는 승인 대기 상태가 `Q-AGENT-12`, `Q-AGENT-18`에서 정한 수준으로 보인다 | System은 요청과 시작 조건을 기록하고, 적용되는 조직·Desk·Agent 정책에서 현재 Ontology 참조와 필요한 내용을 조회해 첫 호출의 입력을 검증한다 | 첫 호출 입력의 유효 결합이 완료되기 전에는 없음 | Run 후보와 첫 호출 configuration snapshot 후보가 생긴다 | 사용자가 Ontology revision 번호를 직접 입력할 필요는 없다. 필수 model/tool/Profile이 유효하지 않으면 `Q-AGENT-04`, `Q-AGENT-20`의 수정·대체·대기·중지 UI로 이동한다 |
| 2 | 필요하면 `[업무 ⋯]` → `[입력·적용 기준]` → `[자료]`에서 포함 체크를 줄이고 `[적용]`을 클릭한다. 허용된 실행 구성 변경은 `[업무 ⋯]` → `[실행 설정]`에서 선택하고 `[이번 업무에 적용]`을 클릭한다. | 제품 사용자 요청, 대화 context, Profile instructions·personality, System policy의 적용 순서, 실제 포함 Memory revision과 포함 이유, 활성 tool, 실제 권한, approval gate, Ontology version, budget가 서로 다른 항목으로 표시된다 | System은 결정된 우선순위와 교집합을 다시 계산해 불변 configuration snapshot을 생성한다 | 없음 | 유효한 Run configuration revision이 생성된다 | `capability ∩ 현재 가용성 ∩ 작업 위임 ∩ 계정·리소스 권한 ∩ 유효 승인 ∩ 실행 제약` 밖의 행동은 활성화되지 않는다 |
| 3 | 없음 — System 자동 실행 개시(유효한 결합이 준비된 경우). 추가 지시는 같은 Chat 작성기에 입력 후 `[전송]`, 중지는 `[이 업무 중지]`를 클릭한다. | Run 상태와 적용 중인 요청·구성이 보이고, 추가 지시가 수신됐는지 다음 호출에 반영됐는지 구분된다. 정확한 표시는 `Q-AGENT-18`을 따른다 | System은 Run을 예약한다. 도구 결과·사용자 조정·새 관찰을 다음 모델 호출의 context revision에 포함하고 호출별 실제 입력을 기록한다 | Agent는 해당 호출이 받은 자료와 제약을 사용해 같은 Run의 계획·후속 행동을 조정한다 | Run을 유지하며 호출별 context revision이 추가된다 | 일반적인 자료 변화에는 중지나 새 attempt를 요구하지 않는다. Profile, prompt, personality는 권한을 넓히지 못한다 |
| 4 | 별도 검토가 필요한 행동만 `[조치 필요 N건]`에서 선택해 대상·계정·효과를 확인하고 상세의 `[선택 N건 허용]`, `[거부]` → `[거부 확정]` 또는 행동 상세의 `[이 행동 취소]` → `[취소 확정]`을 클릭한다. 기존 유효한 위임 안의 일반 행동: 없음 — System 자동 진행. | 대상 리소스, 정확한 행동, 입력 소유자, credential/account context, 예상 외부 효과, 승인 필요 사유와 선택 결과가 보인다 | System은 각 tool 요청 시점에 snapshot과 현재 권한·가용성·철회 상태를 다시 검증하고 credential은 비밀값이 아닌 관리되는 binding으로 전달한다 | Agent는 허용된 tool 요청만 제출하고 거부·취소 결과를 다음 계획에 반영한다 | 허용된 행동만 실행 상태가 되고, 거부·취소는 감사 가능한 상태로 남는다 | 검토 화면 열기 실패, 실행 실패, 재시도, 원 대상 포커스 복귀와 재진입은 `Q-AGENT-05`; 새 credential·외부 범위·비용·배포·민감 데이터 전송은 `A-AUTH-01`–`A-AUTH-03` |
| 5 | `[진행 N건] → 업무 행`에서 실행 상세와 결과·근거를 연다. | 실제 구성·호출별 입력·권한 결정·handoff·출력·독립 증거를 구분한다. | 검증된 실행 상태와 Result 완전성을 별도로 투영한다. | 결과와 evidence candidate를 제출하되 자기 성공을 인증하지 않는다. | Run은 `binding/running/waiting/stopping/stopped/completed/failed`, Result.completeness는 `none/partial/complete`다. | 부분 결과만으로 Run을 완료 처리하지 않는다. 관련: `Q-AGENT-11`, `Q-AGENT-12`, `Q-AGENT-18`. |

**완료 증거**: Run 결과에서 실제 사용된 configuration snapshot을 식별할 수 있고, 각 tool 행동이 capability·가용성·권한·승인 검사를 통과했는지 추적할 수 있다. Profile의 선언값과 유효 권한, 승인과 실행 성공은 합쳐지지 않는다.

<a id="atlas-agent-03"></a>
#### AGENT-03. model·tool·Profile 변경 뒤 Run 재시도·재개·분기

**상세 조작**: [agent-profile](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agent-profile) · [run-control](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control) · [reader-observation](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-reader-observation)

**기술 참조**: [호출별 기록과 Run 조정](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-agent-run-binding), [장애 경계](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries)

**제품 전제**: 자료·모델·Profile·실행 PC 조정은 지원되는 적용 경계에서 같은 Run의 context/config revision으로 반영한다. 실제 실패 재시도만 attempt를 늘리고 의도적 분기만 새 Run을 만든다. 계정 principal 전환에 새 Run이 필요한 경우에도 같은 업무·방·최초 요청·Task lineage를 이어가며 새 메시지 작성을 요구하지 않는다.
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름<br>
**시작 상태**: Run이 진행 중이거나 waiting/failed/stopped 상태이고, 기존 구성으로 실행할 수 없거나 사용자가 Engine·Profile·업무 분기를 바꾸려 한다. 일반적인 context·Ontology 관찰 갱신만 있는 경우는 `AI-02`의 같은 Run 조정으로 이어진다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
|---:|---|---|---|---|---|---|
| 1 | Chat의 `[진행 N건]` → 실패·변경 대상 업무 행을 클릭해 상세를 연다. | 어떤 구성 요소가 언제 바뀌었는지, 기존 snapshot으로 재개 가능한지, fallback·retry·fork·stop 선택지가 기존 결과에 어떤 영향을 주는지 보인다 | System은 기존 Run snapshot과 현재 가용 상태를 비교한다 | 없음 | 검사 상태만 변경된다 | fallback을 선택하지 않았는데 model/provider를 조용히 바꾸지 않는다 |
| 2 | 해당 업무의 `[실패 부분 재시도]`·`[이어가기]`·`[실행 설정]`·`[분기해서 시작]`·`[새 업무]`·`[중지]` 중 의도한 행동을 누른다. 일반 조정은 같은 작성기에 전송한다. | 적용할 설정·재사용 기여·남은 작업·외부 효과 차이와 확정·취소가 보인다. | 현재 revision·권한·writer·미확인 외부 효과를 검사한다. | 확정된 실행 전환 전에는 없음. | 일반 설정은 같은 Run, 실패 재시도는 해당 Task의 새 attempt, 완료·취소 작업의 계속은 연결된 새 Task다. 의도적 분기는 새 Run이다. | 계정 전환의 adapter 예외에서도 업무 lineage를 유지한다. 관련: `Q-AGENT-14`, `Q-AGENT-16`. |
| 3 | 전환 상세의 현재/요청 설정·재사용 자료·외부 효과를 보고 해당 `[적용]`·`[이어가기]`·`[확정]` 또는 `[취소]`를 누른다. | 기존 Run과 새/재개 Run의 연결, 적용된 Profile/model/tool/context/Ontology/권한 차이, 실행·취소 결과와 포커스 목적지가 보인다 | System은 확정된 전환만 기록하고 유효한 Run을 예약하며, 취소되면 기존 Run과 선택 상태를 바꾸지 않는다 | Agent는 새 snapshot에 결합된 뒤에만 재개하거나 새로 시작한다 | 성공한 경우에만 Run 상태와 lineage가 변경된다 | 진행 중 Profile 편집은 기존 Run에 소급 적용되지 않는다. 실패 후 같은 확인 화면 또는 원 Run으로 돌아가는 규칙은 `Q-AGENT-14`, `Q-AGENT-16` |
| 4 | 업무 상세의 `[실행 이력]`에서 같은 Task의 시도 두 개를 체크하고 `[선택 2개 비교]`를 누른다. 재시도는 `[재시도]` → 실패 Task 체크 → `[차이·외부 효과]` → `[실패 작업 다시 실행]`, 중지는 해당 Task의 `[중지]`를 클릭한다. | 시도별 출력·비용·증거·실패·configuration 차이와 현재 정본 결과가 구분되어 보인다 | System은 lineage와 독립 성공을 보존하고 결정된 정본/부분 결과 규칙만 적용한다 | Agent는 자신에게 바인딩된 시도의 결과만 생성한다 | 결과 선택·작업 상태가 변경될 수 있다 | 다른 구성으로 성공했다는 사실이 이전 시도의 기록을 덮어쓰지 않는다 |

**완료 증거**: 모든 resume/retry/fork는 어느 configuration snapshot에서 실행되었는지와 이전 Run과의 관계가 분명하다. 가용성 변화, 취소 또는 실패 후에도 이미 생성된 메시지·산출물·증거는 정해진 보존 규칙에 따라 남으며 외부 효과가 중복됐다고 숨기지 않는다.

<a id="atlas-sys-01"></a>
#### SYS-01. runtime 경계 장애를 관찰된 범위까지만 진단하고 복구

**상세 조작**: [run-control](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control) · [restore](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-restore) · [view](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-view) · [reader-observation](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-reader-observation) · [terminal](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-terminal)

**기술 참조**: [Runtime failure boundaries](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries), [Reader recovery](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-read-recovery)

**제품 전제**: bridge, helper, transport, provider conversation, process, view는 서로 다른 실패 경계다. 하나가 실패했다는 관찰만으로 다른 경계의 원인을 단정하지 않는다.  
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름<br>
**시작 상태**: 제품 사용자가 사용 중인 view 또는 Agent Run에서 연결 끊김, 응답 없음, process 종료, provider 오류, 투영 실패 중 하나가 관찰되었지만 전체 원인은 아직 확인되지 않았다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
|---:|---|---|---|---|---|---|
| 1 | 복원 문제는 상단 `화면 복원 … · 조치 N건`, 실행 문제는 Chat의 `[진행 N건]` → 해당 업무 행을 클릭한다. View의 권한 오류는 `[접근 정보]`, 연결 불일치는 `[연결 비교]`, 보존 자료 손상은 `[진단 정보]`를 클릭한다. | 각 경계의 마지막 확인 상태와 시간, 실제로 관찰된 실패, 영향받는 기능, 계속 사용 가능한 기능이 구분되어 보인다. 원인이 확인되지 않았으면 `원인 미확정`으로 표시된다 | System은 bridge/helper/transport/provider conversation/process/view의 상태를 서로 독립적으로 조회하고 관찰 증거만 기록한다 | 진단 요청이 별도로 위임되지 않았다면 없음 | 검사 상태만 바뀌며 영향받지 않은 Run·view·결과는 유지된다 | 세부정보를 열 수 없음, 재검사, 원 표시 포커스 복귀와 재진입은 `Q-AGENT-20`; spinner 정지만으로 인접 경계 원인을 단정하지 않는다 |
| 2 | 실패 상세의 `[다시 검사]`·`[재연결]`·`[새 실행]`·`[당시 자료]`·`[허용된 다른 조합]`·`[중지 요청]` 중 표시된 복구 행동을 선택한다. | 선택한 행동이 어느 경계만 변경하는지와 기존 출력·세션 동일성·외부 효과 중복 위험, 확정·취소 결과가 실행 전에 보인다 | System은 현재 동일성과 권한을 다시 검증한 뒤 선택한 경계만 재구성·재연결·재실행한다 | 진단/복구가 위임된 경우에도 Agent는 허용된 도구 행동만 요청하며 System 상태를 추측으로 덮어쓰지 않는다 | 성공한 경우에만 선택한 경계의 상태가 변경된다 | 실패·재시도·원 오류 포커스 복귀·복구 화면 재진입은 `Q-AGENT-20`; 동일 process 증거가 없으면 새 실행 또는 snapshot으로 표시한다 |
| 3 | 복구한 업무의 Task 결과 또는 관찰 View 하단에서 `[결과 확인]`을 클릭한다. | 반복 가능한 성공 또는 여전히 실패/부분 복구/원인 미확정인 상태와 다음 행동, 원 대상 복귀 컨트롤이 표시된다 | System은 마지막 검증 상태와 복구 시도를 기록하고 독립적인 성공 증거가 있는 경계만 복구됨으로 전환한다 | Agent는 재개된 configuration/context에 결합된 경우에만 계속한다 | 검증된 경계만 recovered가 되고 나머지는 기존 상태를 유지한다 | 검증 화면 실패·새로고침·재시도·원 view/Run 포커스 복귀·재진입은 `Q-AGENT-20`; 한 번의 렌더링만으로 전체 복구를 주장하지 않는다 |

**완료 증거**: 어떤 경계가 실패했고 어떤 경계가 정상인지, 마지막 확인 시점과 복구 행동, 동일 process/새 process/snapshot 여부를 확인할 수 있다. 원인이 확인되지 않으면 그대로 남으며, 영향을 받지 않은 작업과 산출물은 보존된다.

여러 PC 중 하나와 연결이 끊기면 해당 작업의 마지막 확인 상태·시점·이미 받은 결과는
남는다. `중지`를 요청해도 종료 확인을 받기 전까지 그 작업은 종료 확인 대기 상태로
보이며, 다른 PC에서 진행 중인 독립 작업은 계속 확인하고 조정할 수 있다. 연결이
돌아오면 동일 실행과 결과를 대조한다. 아직 결과를 받지 못했다는 이유로 같은 발송·
제출·파일 변경을 다른 PC에서 다시 실행하지 않는다.

부분 완료에서는 검증된 산출물과 아직 필요한 작업이 함께 보인다. 복구 상세를 닫으면
시작한 작업으로 돌아오며, 다른 업무의 초안·선택 대상은 바뀌지 않는다. 이미 허용된
범위의 자동 재검사·연결 복구는 상세 화면을 열거나 별도 승인을 누를 때까지 기다리지 않는다.

<a id="atlas-ai-01"></a>
#### AI-01. 인공지능 요청 제출하기

**상세 조작**: [chat-entry](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-entry) · [context-share](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-share) · [reader-observation](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-reader-observation)

**기술 참조**: [Context admission](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-smart-read), [Run binding](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-agent-run-binding), [관찰 보존](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-observation-fidelity)

**제품 전제**: 담당자 방 `[새 업무]`, 자료 `[Agent에게 요청]`, 결과 `[후속 질문]` 등은 대상이 명시된 공통 작성기를 연다. 초안 작성은 실행이 아니며 `[전송]` 또는 조합 종료 뒤 별도 `⌘/Ctrl+Enter`로 접수한다.<br>
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: 승인된 요청 입력 표면에 포커스가 있거나 접근할 수 있다.
사용자가 요청을 제출하거나 위임하기 전에는 Agent 작업이 존재하지 않는다.

Agent/제공자 표시 방식, 경로 지정의 지속/재정의 및 위임 권한은 각각
`Q-AI-07`, `Q-AI-08`, `Q-AI-09`의 적용을 받는다. System은 위임된 제품 및
권한 계약의 범위 안에서만 내부적으로 경로를 지정할 수 있다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | 담당자 방 `[새 업무]`, 자료의 `[Agent에게 요청]`, 결과의 `[후속 질문]` 등으로 공통 작성기를 열고 질문·첨부·대상을 편집한다. | 초안 텍스트와 선택한 대상/컨텍스트 힌트가 보인다 | System은 초안만 유지한다 | 없음 | 요청 초안과 포커스만 변경되며 Run은 아직 없음 | 정확한 입력 및 포커스 동작: `Q-AI-10` |
| 2 | 작성기의 `[전송]`을 클릭하거나, 작성기에 포커스를 두고 한글 조합을 끝낸 뒤 별도로 `⌘/Ctrl+Enter`를 누른다. | 수락된 요청과 범위가 한정된 컨텍스트 상태가 `Q-AI-03`에 따라 나타난다 | System은 권한이 부여된 작업 범위와 컨텍스트 스냅샷을 확정한다 | Agent는 범위가 한정된 컨텍스트를 사용할 수 있게 된 후에만 시작한다 | 수락된 요청, 고정된 context revision과 Run/Task 후보가 생성됨 | 범위가 승인 대상 영역으로 확장되는 경우에만 별도의 승인이 필요하다 |
| 3 | `[ · · · ]`로 활동을 열거나 `[이 업무 중지]`를 누른다. 여러 활동이면 목록에서 대상을 고른다. | 실행 중 상호작용 Browser·Terminal은 동일 Live, 완료된 읽기·명령은 Snapshot을 연다. Live 미확인은 논리 node에 남긴다. `[당시 관찰] [현재 조작면] [비교]`로 시점을 구별한다. | 활동·호출·resource identity를 검증한다. direct 결과·raw capture·Reader packet·실제 전달 내용을 별도 manifest로 연결하고 관찰 열기로 재실행하지 않는다. | 요청 담당 Agent는 업무 판단을 유지하고 Reader는 읽기만 수행한다. | Run 실행 상태, Task의 정본 여덟 상태, Result.completeness를 분리한다. | 숨은 추론을 노출하거나 현재 내용을 과거로 대체하지 않는다. 관련: `Q-AI-02`, `Q-AI-04`, `READ-01`–`READ-03`. |

**완료 증거**: 수락된 요청, 범위가 한정된 컨텍스트 개정, Agent 작업 상태 및
최종 결과/실패/중지 상태가 서로 연결된다. 직접 호출의 명명된 결과 또는 Smart
Read의 raw capture·Context Packet·실제 Agent 전달 payload가 각자의 역할과 무결성
참조로 남고, 현재 resource가 바뀌어도 `Q-AI-04`의 Snapshot View에서 역사적 관찰과
전달 관계를 다시 열 수 있다.

<a id="atlas-ai-02"></a>
#### AI-02. 요청의 컨텍스트 검사 또는 수정하기

**상세 조작**: [context-share](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-share) · [chat-entry](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-entry) · [run-control](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control)

**기술 참조**: [Context assembly](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-context-assembly), [Reader Session](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-reader-session)

**제품 전제**: System은 thread/task, 명시적 선택, 관련 Agenda, 일시적 그룹·배치, visible/focused resource, 최근 관련 상태, 계정·권한·실행 범위를 결합한다. 공간적 근접성은 관련성 후보일 뿐 사실이나 증거가 아니며, 이것이 Desk 전체 수집을 의미하지는 않는다  
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: 요청 초안 또는 수락된 작업에는 System이 결합한 컨텍스트 후보가
있으며, 정확히 어떤 입력이 포함되고 제외되었는지 여전히 검사할 수 있다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Chat의 자료 이름 또는 `[자료 N개 보기]`로 전체 이름·범위·포함 이유를 읽는다. 포함을 바꾸려면 `[포함 범위 편집]`, 초안에서 바로 빼려면 `[× 제거]`를 누른다. | 열람에는 읽기 전용 정보와 `[닫기]`가 보인다. 편집을 열었을 때만 포함/제외·대상 추가·`[적용] [취소]`가 나타난다. 직접 제거 뒤에는 `[되돌리기]`가 남는다. | 열람은 제한된 projection만 공개하고 변경하지 않는다. 명시적 제거·적용에만 초안 context revision을 갱신한다. | 없음 | 이름 확인과 초안 변경은 별개다. | 열람 닫기·Esc는 원 작성기에, 편집 취소는 이전 포함 상태에 돌아간다. 접근 불가 항목을 암묵적으로 추가하지 않는다. |
| 2 | 제품 사용자가 context item별 `[이 요청에서 포함/제외]`를 바꾸거나 `[대상 추가]`, Agenda 연결 변경, 권한 축소를 실행한 뒤 `Click [적용]` 또는 `Click [취소]` 한다 | `[적용]`하면 요청 컨텍스트 영역의 item·선택 이유·범위가 갱신된다. 실행 중이면 조정 수신·반영 상태를 확인할 수 있고, `[취소]`하면 편집 전 draft와 작성기 포커스가 유지된다 | System은 범위를 다시 검증한다. 실행 중 변경은 같은 Run의 다음 모델 호출에 연결하고 이미 전달된 입력은 이력으로 보존한다 | 다음 호출에서 새 범위를 사용해 후속 행동을 조정한다 | 같은 Run 안에 새 context revision이 추가된다 | 제외는 과거 전달 취소가 아니다. 앞으로의 사용을 제한하고 권한·진행 중 행동 충돌이 있으면 해당 행동만 재검증한다. 세부 표시는 `Q-AI-05` |
| 3 | 진행 중인 업무에 연결된 Chat 작성기에 추가 지시를 입력하고 `[전송]`을 클릭한다. | 추가 메시지와 그 업무에 대한 조정 수신 여부가 나타나고, 반영 후에는 어떤 지시를 적용했는지 확인할 수 있다 | System은 가능한 가장 이른 다음 모델 호출에 조정을 넣는다. 이미 진행 중인 모델 호출이 새 메시지를 받았다고 표시하지 않는다 | 같은 Run의 다음 호출에서 새 지시를 반영해 계획·행동을 조정한다 | 새 Run이나 attempt 없이 호출별 입력과 결과 연결이 추가된다 | 의도적인 새 업무·분기와 실제 재시도는 별도 행동이다. 정확한 수신·반영 표시는 `Q-AI-05`, `Q-AGENT-18` |

**완료 증거**: 결과 작업/답변에서 Agent가 사용한 정확한 컨텍스트 개정을
검사할 수 있으며, 여기에는 어떤 Agenda, 일시적 레이아웃/그룹, 보이는 리소스
및 명시적 선택이 기여했는지가 포함된다.

<a id="atlas-read-01"></a>
#### READ-01. 큰 첨부를 요청 담당 Agent가 직접 읽거나 Reader Session으로 전환하기

**상세 조작**: [chat-entry](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-entry)

**기술 참조**: [Context admission과 Smart Read](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-smart-read), [Reader Session](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-reader-session)  
**관련 정책**: [계정·비용 위임 범위](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-engine-001)<br>
**제품 전제**: 첨부 자료는 가능한 경우 요청 담당 Agent가 직접 읽고, context overflow가 예상될 때는 그 Agent의 업무를 넘기지 않은 채 도구 계층 Reader가 원문 전체 coverage를 보존해 읽는다.  
**명세 상태**: 핵심 읽기·소유권 계약 확정; 읽기 상세·개입·복구 경로 있음. 기본/상세 표시와 사용자 입력은 읽기 상세 경로를 따름<br>
**시작 상태**: Chat 작성기에 포커스가 있고, 제품 사용자는 하나 이상의 파일·이미지·PDF·표를 첨부해 전체 내용을 검토시키려 한다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
|---:|---|---|---|---|---|---|
| 1 | 작성기의 추천 기본안 `Click [첨부]` → 파일 선택기에서 대상을 선택 → `Click [열기]` 한다. 이어서 `Type "전부 읽고 핵심을 요약해줘"` 한다. | 작성기 위 context 영역에 파일별 이름·형식·크기·현재 revision과 `[× 제거]`가 보인다. 아직 `읽음`이나 `Agent에게 전달됨`으로 표시되지 않는다. | 선택 시점의 source identity와 접근 가능성을 검사해 요청 초안에만 결합한다. | 없음 — 전송 전에는 읽기나 요약을 시작하지 않는다. | 요청 초안만 변경된다. | 첨부 제거·교체·실패는 `Q-AI-10`, context 검사는 `AI-02`를 따른다. |
| 2 | 추천 기본안 `Click [전송]` 한다. | 사용자 메시지와 `[ · · · ]`가 나타나고, 접근성 텍스트에 추천 기본안 `자료 읽는 중 · 전체 검토 · 3개 source`처럼 읽기 범위가 보인다. 내부 Reader 수나 대화는 노출하지 않는다. | 첨부 수·형식·예상 token/vision 비용·요청 담당 Agent의 남은 context와 답변 여유를 함께 계산한다. 직접 전달이 안전하면 그 Agent의 input을 만들고, 그렇지 않으면 source snapshot에 결합된 Reader Session을 시작한다. | 요청 담당 Agent는 최종 업무를 계속 소유한다. Reader가 선택되면 원문 전체 coverage를 검사해 source-anchored Context Packet을 그 Agent에게 반환한다. | 직접 read 또는 Reader mode, source snapshot, read intent와 context revision이 기록된다. | mode 선택은 파일 크기 하나만으로 결정하지 않는다. 어떤 mode였는지는 세부정보에서 확인할 수 있다. |
| 3 | 필요하면 `[ · · · ]`에서 읽기 활동을 고르고 `[읽기 상세]`를 누른다. | Canvas의 읽기 상태에는 `직접 읽기` 또는 `Reader Session`, 전체 검토/지정 범위, source별 coverage, packet revision과 `[원문 스냅샷 열기]`가 보인다. | 공개 가능한 manifest와 coverage를 Snapshot View에 projection한다. | 클릭 때문에 다시 읽지 않고 현재 작업을 계속한다. | 화면 projection만 바뀐다. | Reader를 일반 업무 담당자로 표시하지 않는다. 기본/상세 표시와 개입은 읽기 상세 경로를 따르며 일반 읽기·분할·재호출에 별도 승인이 없다. |
| 4 | `Observe` — 최종 답변을 확인한다. | Chat 답변과 Canvas 근거에서 어떤 source가 직접 입력 또는 Context Packet으로 쓰였는지 확인할 수 있다. | 최종 Answer를 요청 담당 Agent에게 실제 전달된 input revision과 source snapshot lineage에 연결한다. | 요청 담당 Agent가 원 요청의 요약·판단·답변을 생성한다. | Run과 Reader Session 결과가 완료 또는 명시적 오류 상태가 된다. | Reader를 사용했다는 사실만으로 전체 검토 완료라 하지 않고 모든 assigned coverage가 성공해야 한다. |

**완료 증거**: 요청 담당 Agent가 직접 받은 payload 또는 Reader Context Packet, 전체 source
coverage, 원본 snapshot, 최종 Answer가 한 lineage로 연결되며 어느 계층에서도 명명된
결과가 말없이 잘렸다고 표시되지 않는다.

<a id="atlas-read-02"></a>
#### READ-02. 구체적인 조건으로 여러 자료를 찾고 큰 검색 결과를 Reader로 전환하기

**기술 참조**: [Smart Read의 요청 범위와 admission](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-smart-read)  
**제품 전제**: 사용자가 지정한 검색·조합 의도는 그대로 보존하고, 결과량이 요청 담당 Agent의 context에 과도할 때만 file-read 내부 Reader로 전환하며 최종 비교·판단은 요청 담당 Agent가 소유한다.  
**명세 상태**: 핵심 targeted-read 계약 확정; 상태·읽기 상세·원문 탐색 설계 있음. 기본/상세 표시와 사용자 입력은 읽기 상세 경로를 따름<br>
**시작 상태**: 서로 비교할 자료가 첨부되어 있고 사용자는 파일 전체 요약이 아니라 찾을 조건과 최종 조합 방식을 구체적으로 적을 수 있다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
|---:|---|---|---|---|---|---|
| 1 | 작성기에 `Type "A 문서에서 X 조건과 관련된 부분을 찾고, B 문서의 Y 기준과 합쳐 표로 만들어줘"` → `Click [전송]` 한다. | 메시지 아래 활동 표시에 추천 기본안 `지정 범위 찾는 중`과 source 수가 나타난다. | 사용자 조건을 read intent로 보존하고 targeted retrieval을 실행한다. raw hit set을 요청 담당 Agent의 transcript에 넣기 전에 예상 크기와 context 여유를 평가한다. | 요청 담당 Agent는 비교·표 설계·최종 답변을 소유한다. | query와 source snapshot revision이 고정된다. | 키워드 일치만으로 사용자가 지정한 의미 조건을 대체하지 않는다. |
| 2 | `Observe`한다. | hit가 작으면 관련 원문 조각이 context 근거로, 크면 `Reader가 검색 결과 검토 중` 상태가 보인다. | 작은 hit set은 완전한 명명 결과로 요청 담당 Agent에 전달한다. 큰 hit set은 Reader Session으로 보내 모든 hit를 검토한 Context Packet만 admission한다. | Reader가 사용된 경우 검색 업무 전체를 넘겨받지 않고 hit set 읽기만 수행한다. | direct-hit 또는 Reader-hit mode와 packet revision이 기록된다. | 내부 `smart_query`의 raw hit가 요청 담당 Agent에 직접 보이지 않아도 Snapshot lineage에서 존재와 coverage를 확인할 수 있다. |
| 3 | 답변의 source 항목 또는 `[읽기 상세]`를 `Click`한다. | 조건별 선택 span, 제외 이유, source revision, raw hit 수, 요청 담당 Agent에 전달된 packet과 `[원문에서 열기]`가 보인다. | 선택 span을 immutable source 위치와 연결한다. | 없음 — 검사를 열었다고 재검색하지 않는다. | inspection projection만 열린다. | 누락 의심 시 같은 Reader Session을 수정해 재호출하는 `READ-03`으로 이어진다. |

**완료 증거**: 사용자 조건, raw targeted hit manifest, 요청 담당 Agent에 실제 전달된 payload,
선택 span과 최종 비교 결과가 추적되며, 검색 결과가 많다는 이유로 뒷부분을 무표시로
버리지 않는다.

<a id="atlas-read-03"></a>
#### READ-03. 같은 Reader Session에 읽기 방향을 다시 지시하고 판독 오류를 복구하기

**기술 참조**: [Reader 재호출](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-reader-session), [Reader 내부 분할](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-reader-orchestration), [판독 recovery](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-read-recovery)  
**관련 정책**: [계정·비용 위임 범위](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-engine-001)<br>
**제품 전제**: 같은 Reader Session을 원문 snapshot에 다시 연결해 읽기 방향을 수정할 수 있고, 기술적 판독 오류는 bounded recovery를 먼저 수행한 뒤 사용자만 제공할 수 있는 입력이 필요할 때만 질문한다.  
**명세 상태**: 재호출·coverage·recovery 계약 확정; 방향 수정·원본 교체·권한 복구 경로 있음. 기본/상세 표시와 사용자 입력은 읽기 상세 경로를 따름<br>
**시작 상태**: Reader Context Packet이 이미 존재하지만 요청 담당 Agent가 다른 관점의 재검토가 필요하다고 판단했거나, 일부 source에 실제 판독 오류가 있다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
|---:|---|---|---|---|---|---|
| 1 | 일반적으로는 없음 — 요청 담당 Agent가 현재 업무에 필요한 추가 읽기를 요청한다. 사용자가 직접 바꾸려면 읽기 세부정보에서 추천 기본안 `Click [읽기 방향 수정]` → `Type "표현보다 계약 조건을 우선해 다시 봐줘"` → `Click [적용]` 한다. | 기존 Reader Session ID와 packet revision, 새 read intent, `원문에서 다시 검토` 상태가 보인다. | 같은 immutable source snapshot과 shape index에 새 intent를 결합한다. | Reader는 이전 요약만 재요약하지 않고 원문으로 재진입해 새 packet revision을 만든다. 요청 담당 Agent는 새 packet을 받아 기존 판단을 유지·수정한다. | 새 packet이 이전 packet을 덮어쓰지 않고 `refines` 또는 `supersedes` 관계로 추가된다. | `[읽기 상세] → [읽기 방향 수정] → [적용]`이 사용자 경로다. 자동 재호출에 매번 확인을 요구하지 않는다. 새 계정·비용·권한 확대만 기존 승인 경계로 연결한다. |
| 2 | 판독 오류가 표시되기 전에는 없음 — System recovery가 자동 진행된다. | source별로 `다른 parser로 재시도`, `OCR 중`, `권한 다시 확인`처럼 공개 가능한 상태와 성공한 coverage가 유지된다. | 기존 parser 재시도, 대체 parser/encoding/OCR, source revision·권한 재검증을 bounded하게 수행한다. context overflow는 Reader 분할로 처리하며 판독 불가로 표시하지 않는다. | 읽을 수 있는 partition을 계속 처리하되 실패한 source가 필요한 결론은 확정하지 않는다. | 해당 source 의존 branch만 blocked일 수 있고 독립 작업은 계속된다. | 전체 coverage가 아니면 `전체 검토 완료`를 표시하지 않는다. |
| 3 | 비밀번호·로그인·권한·대체 원본이 실제로 필요할 때 Chat 활동 표시 또는 Canvas 읽기 세부정보의 해당 source 행에서 `Click [검토]` → `Click [비밀번호 입력]`, `[권한 연결]`, `[파일 교체]` 또는 `[건너뛰고 범위 축소]` → `Click [계속]` 한다. | 해당 source에 `사용자 조치 필요`, 필요한 행동, 영향받는 결론, 계속 진행 중인 독립 작업과 민감정보 취급 경계가 보인다. 파일을 교체했으면 새 원본과 이전 판독 결과의 구분도 보인다. | 입력을 필요한 branch에 적용한다. 같은 원문은 기존 Reader를 재개하고, 교체 원문은 새 snapshot·coverage로 연결해 과거 packet을 보존한다. | 복구·교체된 source를 읽어 새 packet을 반환하고 요청 담당 Agent는 같은 업무의 다음 호출에 반영한다. | blocked branch가 ready/running으로 전환되거나 명시적으로 scope-reduced가 된다. | 교체 파일을 기존 hash의 원문으로 바꾸지 않는다. 외부 업로드·유료 OCR·새 credential은 해당 Task의 권한 흐름을 따르며 독립 Task는 계속한다. |

**완료 증거**: 같은 Reader Session의 source snapshot, intent와 packet revision 이력,
자동 recovery 시도, 사용자 조치, 최종 coverage가 보이며 읽지 못한 source가 남으면
전체 검토 완료가 성립하지 않는다.

<a id="atlas-engine-01"></a>
#### ENGINE-01. EG-Desk 로그인과 다른 AI Engine 구독 계정을 연결·선택하기

**기술 참조**: [Identity planes와 Engine Profile](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-engine-profile)  
**사용자 결정 참조**: [HUM-ENGINE-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-engine-001)  
**제품 전제**: EG-Desk identity, AI Engine 구독 account, Browser·연결 service account는 별도이며 Run은 실제 사용할 Engine Profile을 고정한다.  
**명세 상태**: identity 분리·Run binding·격리 login 기준선 확정; 연결·전환·복구 설계 있음. 기본 적용 범위는 연결된 사용자 선택에 따름<br>
**시작 상태**: 제품 사용자는 EG-Desk identity A로 사용 중이며, Codex 사용량은 다른 ChatGPT account B에서 쓰고 싶다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
|---:|---|---|---|---|---|---|
| 1 | 설정 또는 Chat header에서 추천 기본안 `Click [AI Engine]` → `Click [계정 추가]` → provider `Codex · ChatGPT 구독`을 선택한다. | 원래 화면에는 연결 대상 Engine Profile과 `인증 대기`가 보이고 전용 인증 탭/컨테이너가 열린다. | 해당 Engine Profile의 격리된 App Server login을 시작하고 반환된 auth URL을 전용 컨텍스트에 연다. | 없음 | pending login과 원래 포커스 복귀 지점이 기록된다. | 일반 Browser의 account A cookie를 말없이 재사용하지 않고 계정 선택을 제공한다. |
| 2 | 전용 인증 화면에서 account B를 선택하고 provider가 요구하는 로그인을 완료한다. | provider 성공 화면 뒤 인증 탭이 닫히거나 완료 상태로 남고, 원래 설정/Chat control에 포커스가 돌아온다. Engine Profile에는 B의 식별 정보·인증 상태와 plan/quota의 확인 가능한 상태가 구분되어 나타난다. | callback 알림 뒤 active account/auth mode/plan을 다시 읽어 B와 일치하는지 검증한다. token은 credential store에만 둔다. | 없음 | 인증이 검증되면 Engine Profile B가 connected가 된다. 사용량 제한은 별도 availability 상태다. | 취소·callback 손실·계정 불일치는 인증 복구 대상으로 표시한다. quota 초과만으로 로그아웃 처리하지 않으며 재설정 시각·대기·허용된 대체 경로는 확인 가능한 범위와 기존 정책에 따라 제공한다. |
| 3 | `Click [이 Chat에서 사용]` 또는 요청별 Engine 선택기에서 B를 선택하고 메시지를 전송한다. | Chat header와 실행 상태에 Engine Profile B가 보인다. 기존 Run은 원래 Engine identity를 유지한다. | 새 Run snapshot에 `engineProfileId=B`를 고정하고 B runtime의 실제 account 상태를 확인한다. | 선택된 engine에서만 새 Run을 시작한다. | 새 Run만 B quota/account에 결합된다. | 기본 적용 범위와 진행 중 Run 전환 의미는 `HUM-ENGINE-001`; 다른 Browser/메일 계정은 바뀌지 않는다. |

**완료 증거**: EG-Desk identity A, Engine Profile B, Browser·연결 서비스 계정이
구분되어 보이고, 새 Run이 실제 B의 engine runtime·plan/quota에 결합되며 token이
Chat·SQLite·snapshot·export에 노출되지 않는다.

<a id="atlas-ai-03"></a>
#### AI-03. Agent 담당자 방과 다중 Agent 공유 작업 대화

**상세 조작**: [chat-entry](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-entry) · [context-share](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-share)

**기술 참조**: [Shared multi-Agent conversation](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-multi-agent-chat), [Parallel Agents](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-parallel-agents)

**제품 전제**: 담당자 방과 공유 대화는 별도 대화 관계다. 공유 대화는 고유 identity·참여자·공유 소유 범위를 가지며 Agenda는 0개 이상의 탐색 참조로 연결된다. 별도 workroom이나 Task별 Thread는 필요하지 않다. 선택 공개형·업무 공개형의 기본 정책은 연결된 사용자 선택에 따른다.
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: Agent 담당자 방 하나 이상을 사용할 수 있다. 공유 작업 대화 개념은
`Q-OBJ-06`에서 승인된 범위까지만 사용할 수 있으며, 원본 방 기록, 대상, 참여자 및
작업 권한은 암묵적으로 공유되지 않는다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | 담당자 방에서 요청을 전송한다. 공유 대화는 `[방 목록] → [공유 대화] → [새 대화]`에서 제목·참여자·공유 범위·선택 Agenda를 입력해 `[만들기]`하거나 기존 행을 연다. | 담당자 identity 또는 공유 대화의 참여자·공개 범위·Agenda 참조가 보인다. | 대화 identity와 허용 범위를 기록한다. 생성·열기만으로 실행하지 않는다. | 명시적인 Agent 요청이 접수된 경우에만 응답한다. | 대화 상태와 Agent 실행 상태를 분리한다. | 일반 공유 메시지 전송은 Agent 호출이 아니다. 관련: `Q-OBJ-06`, `Q-AI-12`. |
| 2 | 메시지·기여·Memo의 `[⋯] → [공유 대화에 연결]`에서 대상 대화·참여자·공유할 본문·첨부를 고른다. | 공유할 정확한 메시지, 컨텍스트 및 참여자가 미리 표시된다 | System은 `Q-OBJ-06`에 따라 결정된 링크 또는 사본만 준비한다. | 없음 | 대화/컨텍스트 관계가 보류 중이다 | 취소, 중복, 개인정보 보호 및 실행 취소: `Q-AI-13` |
| 3 | 공개·제외 범위를 확인하고 `[공유]` 또는 `[취소]`를 누른다. | 선택된 공유 작업 화면에는 수락된 컨텍스트와 참여자만 표시되거나, 취소 후 변경되지 않은 상태로 돌아간다 | System은 성공한 경우에만 관계를 저장한다. | 없음 | 대화/컨텍스트 관계가 변경될 수 있다 | 컨텍스트 공유만으로는 새 작업에 권한을 부여하지 않는다 |
| 4 | 공유 대화의 `[Agent에게 요청]`에서 담당자를 고른 뒤 열린 작성기에 요청과 자료를 입력·편집하고 최종 `[위임]`을 누른다. 일반 사람 간 대화는 일반 작성기의 `[전송]`으로 보낸다. | 작성 중에는 수신자·대상 업무·첨부와 아직 실행하지 않은 초안이 보인다. 위임 접수 뒤에만 해당 요청의 작업 상태가 나타난다. | 담당자 선택은 초안만 연결한다. 최종 위임의 권한·대상·입력을 확인한 뒤 작업을 예약하고 Chat과 Canvas 상태를 연결한다. | 위임 요청이 접수된 뒤 허용된 업무를 수행한다. | 초안·일반 메시지·Agent 실행을 구별한다. | 취소는 초안을 보존한 채 일반 대화로 돌아간다. 완료 후 개별 기여와 종합 결과는 [대화 상세](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-share)에서 구분한다. |

**완료 증거**: 제품 사용자가 raw Agent chatter 전체를 읽지 않아도 기여자·상태·증거·통합 결과를 구분할 수 있고, 원본 Agent 방 전체를 암묵적으로 복사하지 않고도 대화 식별 정보,
참여자, 전송된 컨텍스트, 위임된 작업 경계, 개별 기여 및 종합된 결과의
출처를 확인할 수 있는 상태로 유지된다.

<a id="atlas-ai-04"></a>
#### AI-04. Chat과 Canvas를 통해 표현되는 하나의 답변

**상세 조작**: [reader-observation](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-reader-observation) · [answer-revisions](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-answer-revisions) · [chat-entry](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-entry)

**기술 참조**: [One Answer across Chat and Canvas](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-answer-projection), [Observation fidelity](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-observation-fidelity)
**사용자 결정 참조**: [HUM-ANSWER-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-answer-001), [HUM-SNAPSHOT-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001)

**제품 전제**: 여러 Run·Task·Agent contribution·Result·artifact가 있어도 사용자에게 응답하는 시점에는 하나의 논리적 Answer revision으로 통합하고, Chat과 Canvas는 이를 매체에 맞게 표현한다.  
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: Agent 작업이 논리적 답변을 생성할 수 있거나 이미 생성했다. Chat과 Canvas는 같은 긴 본문을 중복 복사하지 않고 매체에 맞는 표현을 맡으며, Chat을 단순 알림으로 축소하지 않는다.
실행 중 기록된 tool activity/result 중 일부는 비교·근거·표·원자료 등 Answer를
설명하는 Canvas report set의 재료가 될 수 있지만 raw tool trace 전체를 복사하지 않는다.
선별되거나 가공된 모든 항목은 해당 판단 단계에 실제 전달된 payload 또는 Context
Packet에서 immutable raw/source capture와 원 source/runtime revision으로 이어지는
provenance를 보존한다.
Answer Briefing은 snapshot과 고정된 파생 산출물을 사용하며 제품 사용자의 현재
Browser·File·Terminal Live View는 같은 Canvas에 별도로 공존할 수 있다.
Canvas에는 설명에 필요한 비교·근거·원자료·차트가 선별된 report set로 연결된다. 개인 표시·순서와 지속 구성 변경은 구분하며 수정 허용 여부는 연결된 사용자 선택에 따른다. 상세: [답변과 표현](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-answer-revisions). 관련: `Q-MEDIA-01`.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | 공통 작성기에서 대상·첨부를 확인한 뒤 `[전송]`한다. | Chat에는 대화적으로 완결된 Answer가 나타난다. `Q-MEDIA-01`의 규칙이 Canvas를 요구하면 Answer에 실제로 쓰인 비교·근거·표·원자료가 선별된 report set로 배치된다. 원자료는 읽기 전용 `[스냅샷]`으로 열리고, 가공된 항목에는 `[파생됨]`과 원 snapshot으로 이동하는 컨트롤이 보인다. 제품 사용자가 직접 다루는 `[라이브]` Browser·File·Terminal view도 같은 Canvas에 별도로 남을 수 있다 | System은 각 report item을 `Agent-delivered payload/Context Packet → raw/source capture → 원 source/runtime revision`과 검증해 Chat·Canvas 표현을 하나의 Answer 및 출처 관계에 연결한다. | 일관된 Answer와 근거로 사용할 관찰 snapshot 후보·Canvas 구성을 제안한다 | 하나의 답변에 하나 이상의 매체별 표현이 있을 수 있다 | report set는 raw tool trace 복사본이나 숨은 추론 기록이 아니지만, 선별·요약·시각화가 역사적 snapshot을 현재 resource로 대체해서는 안 된다. 선택·표현 규칙: `Q-MEDIA-01` |
| 2 | Chat Answer의 결과 링크를 클릭해 선택한 답변 revision의 Canvas 대상을 연다. | 성공하면 Canvas가 관련 target을 열거나 포커스한다. 누락·최신 아님·권한 거부이면 Chat 안에 그 상태와 가능한 다음 컨트롤이 보인다 | System은 Answer·target ID와 현재 권한을 해석한다. | 없음 | 성공한 경우에만 보기/포커스가 변경된다 | 실패하면 Chat 답변을 유지하고 `다시 열기`, `연결 다시 찾기`, 허용되는 경우 `권한 요청`을 제공하며 포커스는 활성화한 어포던스로 돌아간다; 정확한 동작은 `Q-MEDIA-02` |
| 3 | Canvas Answer View bar의 `[Chat 답변으로]`를 클릭한다. 직접 연 결과에 여러 대화 연결이 있으면 표시된 접근 가능한 답변 행을 고른다. | 성공하면 원 대화의 Answer 위치가 열리고 포커스된다. 대화·메시지가 누락·최신 아님·권한 거부이면 Canvas 안에 상태와 다음 컨트롤이 보인다 | System은 Answer·conversation·message 관계와 현재 권한을 해석한다. | 없음 | 성공한 경우에만 보기/포커스가 변경된다 | 실패하면 Canvas 표현을 유지하고 `[연결 다시 확인]` 또는 허용된 `[권한 요청]`을 제공한다. 후보 선택 취소·실패는 `[Chat 답변으로]` 버튼으로 포커스를 돌린다. 관련: `Q-MEDIA-02` |
| 4 | Chat의 렌더 오류 표시에서 `[다시 표시]`를 클릭한다. 원문으로 읽으려면 `[읽기 쉬운 원문]`을 클릭한다. | 연결된 Canvas와 Run·Result는 유지되고, Chat만 실패·재시도 중·복구됨 중 하나로 보인다 | System은 Chat projection만 다시 구성하고 Answer·Canvas·Result를 삭제하지 않는다. | 없음 | 성공한 경우 Chat projection만 복구된다 | 실패가 계속되면 Canvas에서 원 Answer 연결과 다시 시도·재진입 컨트롤을 유지하고, 포커스는 오류 표시에 돌아간다 |
| 5 | Canvas의 렌더 오류 표시에서 `[다시 표시]`를 클릭한다. 원문으로 읽으려면 `[읽기 쉬운 원문]`을 클릭한다. | Chat의 완결된 답변과 Run·Result는 유지되고, Canvas만 실패·재시도 중·복구됨 중 하나로 보인다 | System은 Canvas projection만 다시 렌더링하고 Answer·Chat·Result를 삭제하지 않는다. | 없음 | 성공한 경우 Canvas projection만 복구된다 | 실패가 계속되면 Chat에서 대상 상태와 다시 시도·다시 연결 컨트롤을 유지하고, 포커스는 오류 표시에 돌아간다 |
| 6 | 답변의 `[후속 질문]`으로 작성기를 열고 대상 revision을 확인해 입력한 뒤 `[전송]`한다. | 후속 내용과 대상 업무·답변 revision이 보인다. | 같은 업무의 요청을 기존 Run에 연결하고 완료 후에는 새 실행 구간·Task를 기록한다. | 전송된 범위 안에서 응답한다. | 이전 Task·Result를 보존하며 후속 실행이 접수된다. 새 목적이나 의도적 분기는 별도 행동이다. | 누락·최신 아님 참조는 제거·재연결할 수 있다. 관련: `Q-AI-10`, `Q-AI-02`. |
| 7 | 개인 표시는 `[답변 ⋯] → [이 View 표시] → 항목·순서 선택 → [이 View에 적용]`으로 바꾼다. 지속 편집이 허용되면 `[수정본 만들기] → [구성 편집] → [수정본 저장]`을 사용한다. 주석 전용은 `[의견 남기기]`·`[새 설명 요청]`, 삭제 권한이 있으면 별도 `[답변 삭제…]`를 사용한다. | 개인 표시 변경과 지속 수정본·삭제의 대상·영향이 각각 보인다. | 개인 표시는 해당 View 설정만, 수정본 저장은 새 Answer revision만 바꾼다. 삭제는 확인한 범위의 별도 권한을 검사한다. | 없음 | 개인 View 설정, 새 수정본 또는 확인한 삭제 범위만 변경된다. 개인 표시는 report set·공유 기본값·Agent context를 바꾸지 않는다. | 충돌, 동기화 실패, 재시도, 실행 취소 및 포커스 복귀: `Q-MEDIA-12` |

**완료 증거**: Chat과 선택된 모든 Canvas 표현은 같은 논리적 답변/출처를
가리키며, 각 report item에서 그 판단에 실제로 전달된 payload와 원 source snapshot까지
도달할 수 있다. Snapshot View와 현재 작업용 Live View는 서로를 덮어쓰지 않고
같은 Canvas에 공존한다. 한 표현이 실패해도 다른 표현은 재시도 또는 열기 행동과 함께
사용할 수 있는 상태로 남는다.

<a id="atlas-ai-05"></a>
#### AI-05. 다음 Chat에서 사용되는 Answer Briefing 및 Briefing Comment

**상세 조작**: [briefing-comment](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-briefing-comment) · [input](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-input) · [chat-entry](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-entry)

**기술 참조**: [Answer Briefing](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-answer-briefing), [HUM-BRIEF-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-brief-001)

**제품 전제**: `Answer Briefing / 답변 브리핑`은 Agent가 한 Answer의 공개 가능한 Canvas 산출물 set, Briefing Order, 각 Briefing Step의 Focus Scope와 설명을 제안하고, System이 대상·권한·최신 상태를 검증해 제품 사용자의 이전·다음·전체 보기·종료 입력에 따라 화면을 전환하는 사용자 주도 프레젠테이션이다. Briefing Comment를 다음 Chat으로 전달할 수 있지만 숨은 chain-of-thought를 노출하거나 자동 fork하지 않는다  
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: Answer에 연결된 게시 Briefing이 있으면 `[브리핑 보기]`로 연다. 없으면 `[새 설명 요청]`을 사용하고, 지속 편집 정책·작성 권한이 있으면 `[⋯] → [브리핑 만들기]`로 초안을 만든다. Live·숨은 추론은 단계 대상이 아니다. 관련: `Q-MEDIA-04`.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Answer의 `[브리핑 보기]`를 클릭한다. | `1 / N`, Step 제목·설명, 현재 Focus Scope, 집중 target과 추천 기본 컨트롤 `[이전] [전체 보기] [다음] [의견] [종료]`가 나타난다; 모션 감소·비시각적 대안은 `Q-UX-03`을 따른다 | System은 결정된 카메라/포커스/Briefing Step 투영만 구동한다. | 없음 | Answer Briefing 프레젠테이션 상태 | 누락된 대상/아티팩트 피드백 및 다음 행동: `Q-MEDIA-04`와 `Q-MEDIA-09` |
| 2 | `[이전]`·`[다음]`·`[전체 보기]`를 클릭하거나 `[단계 목록]` → 단계 행을 클릭한다. `←`·`→`는 브리핑 탐색 영역에 포커스가 있을 때만 누른다. | 선택한 Briefing Step 번호·제목·설명과 Focus Scope가 보이고, 범위 밖 target은 결정된 정책에 따라 약화되거나 숨겨지며 `[전체 보기]`로 전체 맥락을 복원할 수 있다 | System은 프레젠테이션 상태를 변경한다 | 없음 | 자동 분기/포크 없음 | 순서/컨트롤 동작: `Q-MEDIA-09`; 지속성/편집/협업: `Q-MEDIA-10` |
| 3 | 현재 단계 또는 선택한 visible target에서 `[의견]`을 클릭하고, 대상·revision·공개 범위를 확인한 뒤 의견을 입력해 `[저장]` 또는 `[취소]`를 클릭한다. | 댓글 대상, 초안, 편집 상태, 검증/실패 및 포커스가 `Q-MEDIA-11`에 따라 보인다 | System은 명시적 행동을 통해서만 댓글을 결합하거나 변경한다. | 없음 | 댓글 권한/가시성은 `Q-MEDIA-05`를 따르고, 지속성은 `Q-MEDIA-08`을 따른다 | 정확한 실패/실행 취소/포커스/키보드 동작: `Q-MEDIA-11` |
| 4 | 추천 기본안 `Click [다음 Chat에 포함]`을 활성화한다; 전송 자체는 아직 수행하지 않는다 | Chat 작성기에 검증된 Briefing Step·Briefing Comment 참조가 첨부되고, 대상이 최신 상태와 맞지 않거나 누락되면 전송 전에 그 상태와 `[제거]`·`[다시 연결]`이 보인다 | System은 Briefing Step·Briefing Comment 참조를 검증하고 Chat 초안에 연결한다. | 제품 사용자가 해당 메시지를 전송하기 전까지 없음. | Agent는 사용자가 해당 메시지를 전송할 때만 시작한다 | 전달/전송 실패, 제거, 다시 연결 및 재시도: `Q-MEDIA-07` |
| 5 | OS Dock의 EG-Desk 아이콘을 클릭해 다시 열고, EG-Desk Dock의 `[Chat]` → `[방 목록]` → 관련 대화 행을 클릭한다. 브리핑은 해당 Answer의 `[브리핑 보기]` → 표시된 `[N단계 이어보기]` 또는 `[처음부터]`를 클릭한다. | 유지된 댓글, 대상 연결, Chat 초안 및 최신 대상과 맞지 않는 상태가 `Q-MEDIA-08`에 따라 나타난다 | System은 지속되도록 결정된 댓글/초안 상태만 복원하고 대상을 다시 검증한다. | 없음 | 활성 표시 상태가 재구성된다 | 대상 또는 초안이 누락되면 결정된 제거/다시 연결/새 초안 행동을 제공한다 |

**완료 증거**: 사용자는 결정된 Briefing Step을 이동하고, 검증된 Briefing Comment를 Chat 초안에 첨부하고, 최신 대상과 맞지 않는 첨부 항목을 복구하거나 제거하며, 전송 후
다음 요청이 바로 그 Briefing Step과 댓글을 참조하는지 확인할 수 있다.

<a id="atlas-canvas-01"></a>
#### CANVAS-01. Canvas 주석: 시각 표식과 위치 메모

**상세 조작**: [canvas-annotation](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-canvas-annotation)

**기술 참조**: [Answer projection](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-answer-projection), [로컬 event·object 저장](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-storage-export)

**제품 전제**: Canvas annotation에는 도형·화살표·레이블 같은 **시각 표식**과,
대상 또는 위치에 고정되는 짧은 **Canvas Memo**가 있다. Memo는 사용자 본문과
작성자별 Agent 답글을 분리하며 자동으로 긴 Chat으로 승격되지 않는다. 둘 다
Briefing Comment 및 원본 콘텐츠와 구분한다.
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: Canvas의 빈 위치 또는 주석을 남길 자료가 보인다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | `[주석 도구]`에서 사각형·타원·선·화살표·자유선·레이블·Memo를 고른다. 위치와 내용을 입력해 `[추가]` 또는 `[저장]`한다. 응답은 담당자가 표시된 `[Rio에게 묻기]` 또는 미지정 상태의 `[Agent에게 묻기…]`로 요청한다. | 저장 중 표시 뒤 성공하면 저장된 표식의 위치·대상·작성자 또는 Memo의 본문·작성자·고정 위치가 보인다. 실패는 입력과 초안을 유지한다. | 유형·대상 또는 Canvas 좌표·작성자·본문/geometry를 검증해 저장 revision을 만든다. 미확인 응답은 같은 저장 요청을 조회한다. | 명시 질문 또는 유효한 담당 범위 위임이 있을 때만 해당 응답 정책 안에서 짧은 답글을 만든다. | 성공은 저장됨, 실패는 미저장 초안, 응답 유실은 저장 확인 중이다. | Agent가 만든 표시·답글은 원본 콘텐츠나 수락된 사실이 아니다. 정확한 도구·trigger: `Q-MEDIA-06`, `Q-MEDIA-13` |
| 2 | 표식·Memo `[⋯]`의 이동·크기·레이블·본문 편집·삭제를 사용한다. 제안 모드일 때만 `[수락]`·`[기각]`을 누르고, 답글은 작성자별로 읽는다. | 표식의 상태와 대상 결합, Memo 본문과 Agent 답글의 작성자 구분이 보인다 | System은 명시적인 제품 사용자 행동만 원본 annotation에 적용하고 Agent 답글을 사용자 본문과 별도 message로 유지한다 | 짧은 답만으로 오해할 위험이 있거나 정보가 부족하면 관련 Agent 담당자 방에 Memo reference가 붙은 메시지·mention을 만들 수 있다 | annotation 상태 또는 별도 Agent 방 mention이 변경된다 | Agent는 사용자 Memo 본문을 고쳐 쓰거나 Canvas focus를 빼앗지 않는다. Memo 안에서 긴 대화를 자동으로 시작하지 않는다 |
| 3 | 이후 편집으로 미저장 내용이 있을 때만 `[저장]`하고, 추가 중인 새 표식이 있을 때만 `[추가]`한다. 방에 연결된 Memo는 `[대화에서 보기]`로 연다. 이미 저장한 항목을 다시 생성하지 않는다. | 저장된 annotation·작성자·대상 참조가 보이고 방에서도 Memo 본문과 답글을 구분한다. | 저장된 annotation과 제안을 보존하며 임시 pointer·selection은 복원하지 않는다. | 응답은 명시 질문 또는 유효한 담당 범위 위임에서만 시작한다. 방 열기 자체는 실행이 아니다. | 저장·표현·대화 참조만 변경되며 같은 업무의 후속 실행은 그 Run lineage를 유지한다. | 실패 시 초안을 유지하고 `[다시 연결]`·재시도·자기 변경 되돌리기를 제공한다. 관련: `Q-MEDIA-06`, `Q-MEDIA-13`. |

**완료 증거**: annotation의 유형·대상·작성자·지속 상태가 보인다. 위임된 편집 범위의 표식은 검사 뒤 직접 저장하고 제안 모드에서만 수락·기각을 구분한다. Memo의 사용자 본문과 Agent 답글은 분리되며 삭제·방 연결이 원본 콘텐츠나 본문을 암묵적으로 바꾸지 않는다.

<a id="atlas-ai-06"></a>
#### AI-06. 병렬 Agent 및 의존성에 의해 구동되는 후속 작업 시작

**상세 조작**: [run-control](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control) · [browser](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-browser)

**기술 참조**: [Dependency orchestration](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-dependency-orchestration), [Parallel Agents](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-parallel-agents)
**사용자 결정 참조**: [HUM-ORCH-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001), [HUM-RUN-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001)

**제품 전제**: 의존성 완료, 증거 및 승인이 후속 작업 시작을 구동한다  
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: 범위가 한정된 요청을 의미론적으로 분해할 수 있지만, System이
그래프, 권한, 컨텍스트 및 활성 Ontology 결합을 기록하기 전에는 어떤 작업 또는
의존성 전환도 유효하지 않다.

제품 Task의 정본 상태는 queued/waiting-on-dependency/ready/running/approval-required/completed/failed/cancelled의 여덟 가지다. 제출 전 draft는 Task 상태가 아니고 partial은 여러 Task의 Result 종합 상태이며, 일반 waiting은 원인에 따라 waiting-on-dependency 또는 approval-required로 표시한다. 제공자별 내부 enum은 이 제품 상태를 대신하지 않는다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | 담당자 방에서 업무를 작성해 `[전송]`하거나 공유 대화의 `[Agent에게 요청]`으로 위임한다. | 제안된 작업, 의존성, 담당자 및 현재 상태가 `Q-ORCH-01`에 따라 보인다 | System은 활성 Ontology 버전을 결합하고, 제안된 의존성 그래프를 검증하고, 기록하고, 준비된 작업을 예약한다 | 오케스트레이션 Agent는 범위가 한정된 요청 안에서 의미론적 분해를 수행할 수 있다. 그런 다음 독립 Agent들이 병렬로 작업한다 | 검증된 Task graph가 생성되고 독립 Task는 ready에서 queued 또는 running으로 전환될 수 있음 | 정확한 분해 가시성 및 사용자 제어: `Q-ORCH-01` |
| 2 | 없음 — 선행 조건이 충족되면 자동 실행된다 | 후속 작업이 대기 상태에서 준비/실행 상태로 변경되며, 이를 촉발한 증거가 보인다 | System은 checkpoint된 의존성 상태·증거·권한·활성 Ontology에 비추어 전환을 검증한 다음 디스패치한다. `waiting-on-dependency` 또는 `approval-required` 동안 LLM stream을 계속 열어 두지 않는다 | 후속 Agent가 시작한다 | 해당 종속 Task만 waiting-on-dependency에서 ready로, scheduler 수락 뒤 queued 또는 running으로 전환됨 | 파일 이벤트는 하나의 조건일 수 있으나, 오케스트레이션 모델 자체는 아니다 |
| 3 | `[진행 N건] → Task 행`에서 `[중지]`·`[재시도]`·`[담당 변경]`·`[다른 경로]`를 선택하고 해당 변경 범위만 확인한다. | 실패, 차단, 독립 작업 성공 및 부분 결과 상태가 서로 구분된 채 유지된다 | System은 의존 작업만 차단하고 완료된 결과를 보존한다 | Agent들은 실패한 의존성을 우회하지 않는다 | 선택한 Task와 종속 분기의 상태만 변경되고 완료된 Result는 보존됨 | 정확한 확인/실패/포커스 및 작업 선택 동작: `Q-ORCH-08` |

**완료 증거**: 독립 작업은 동시에 실행되고, 각 후속 작업은 기록된 선행 조건이
충족된 후에만 시작되며, 실패/부분 성공의 영향은 `Q-ORCH-02`와 일치하고 실행을
단일 상태로 합치지 않는다.

<a id="atlas-ai-07"></a>
#### AI-07. 독립 작업을 중단하지 않고 승인이 필요한 결정 일괄 처리하기

**상세 조작**: [approval](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-approval) · [browser](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-browser) · [identity](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-identity)

**기술 참조**: [Dependency·approval orchestration](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-dependency-orchestration)

**제품 전제**: 해당 업무의 `[조치 필요 N건]`에서 행동별 대상·계정·payload·기간·비용을 검토하고 선택한 행동만 허용·거부·보류한다. 승인 의존 분기만 대기하며 독립 작업은 계속된다. 관련: `Q-ORCH-03`, `Q-ORCH-06`.<br>
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: 권한상 허용된 하나 이상의 분기가 실행 중이거나 계획되어 있고,
적어도 하나의 의존 분기가 승인이 필요할 수 있는 경계에 도달했다. 관련 없는
분기는 계속 실행할 수 있다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | 없음 — System 자동 경계 식별·기존 위임 검사 후 조치가 필요한 행동만 `[조치 필요 N건]`에 표시한다. | 처리 대기 중인 결정 기록에는 선택지, 영향, 비용/데이터/보안 함의 및 의존 작업이 포함된다. 해당 UI는 `Q-ORCH-03`이다 | System은 Agent가 보고한 경계를 기록하고 중복된 항목을 같은 검토 묶음으로 정리한다. | Agent는 위임 범위 밖의 경계를 보고한다. 오케스트레이션 역할은 중복 후보를 제안할 수 있으나 승인하지 않는다. | 의존 분기는 대기하고, 관련 없는 권한상 허용된 작업은 계속된다 | 제품은 즉각적인 답변을 요구해서는 안 된다 |
| 2 | 해당 업무의 `[조치 필요 N건]`에서 행동을 선택하고 정확한 상세의 `[선택 N건 허용]`, `[거부] → [거부 확정]` 또는 `[보류]`를 누른다. 요약의 `[선택 항목 검토]`는 아직 결정하지 않는다. | 계정·대상·payload·기간·비용·영향과 최종 결정 여부가 보인다. | 검토 범위와 현재 권한을 재확인한 뒤 최종 결정만 기록한다. | 없음 | 허용·거부·보류를 별도 상태로 기록하며 검토 닫기는 상태를 바꾸지 않는다. | 침묵·보류·닫기는 승인이 아니다. 변경된 범위는 새로 검토하고, 실패에는 같은 선택·초안과 복귀 경로를 남긴다. |
| 3 | 허용되는 경우 결정 후 자동 실행되므로 없음 | 승인된 의존 작업은 준비 상태가 되고, 거부된 작업은 종료되거나 명시적 대안을 제공한다 | System은 권한상 허용된 분기만 재개한다. | Agent들은 기록된 결정에 따라 진행하거나 중지한다. | Agent들은 그에 따라 진행하거나 중지한다 | 승인은 외부 프로비저닝 또는 효과가 성공했다는 증거가 아니다 |

**완료 증거**: 승인이 필요한 각 분기에는 중복 제거된 감사 가능한 결정 기록이
하나씩 있다. 관련 없는 작업은 계속되며, 기록된 사용자 결정 후 영향받는 분기만
재개되거나 종료된다.

<a id="atlas-auth-01"></a>
#### AUTH-01. 새로운 외부 권한 또는 중대한 외부 효과 승인하기

**상세 조작**: [approval](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-approval) · [identity](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-identity)

**기술 참조**: [Identity·authority 분리](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-resource-identity), [Collaboration·external boundary](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-collaboration-computer-use)

**제품 전제**: 일반적인 위임 작업은 자율적으로 계속된다. 새로운 외부
인프라, 자격 증명, 외부 데이터 전송, 유료 프로비저닝, 배포 및 실질적으로 더
넓은 실행 권한에는 명시적인 사용자 승인이 필요하다  
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: 범위가 한정된 작업에서 아직 위임에 포함되지 않은 새로운 외부
인프라, 요청된 자격 증명, 외부 데이터 흐름/효과, 비용, 배포 또는 더 넓은
권한을 식별했다. 해당 효과는 아직 발생하지 않았다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | 없음 — System 자동 권한·외부 효과 경계 확인 후 기존 유효 권한 밖의 행동만 `[조치 필요 N건]`에 표시한다. | 처리 대기 중인 결정에는 `Q-ORCH-03`에 따라 정확한 계정/제공자/효과, 데이터 범위, 비용, 보안 함의, 가역성 및 의존 작업이 표시된다 | System은 보고된 경계를 기록하며 승인 전에는 새로운 외부 행동을 디스패치하지 않는다. | Agent는 새로운 외부 권한 또는 효과 경계를 보고한다. | 의존 작업이 대기한다 | 기존의 권한상 허용된 로컬 작업은 계속된다 |
| 2 | 업무의 `[조치 필요]`에서 실제 계정·대상·전송 내용·기간·비용을 확인하고 선택 행동만 허용·거부·보류한다. | 정확히 권한이 부여된 범위, 결정 행위자, 만료 및 철회 규칙이 `Q-ORCH-07`에 따라 보인다 | System은 결정을 검증하고 기록한다 | 없음 | 권한 기록이 변경된다 | 도메인 인프라에는 `A-INFRA-01`–`A-INFRA-03`을 사용하고, 그 외 사례에는 중복 승인 없이 `A-AUTH-01`–`A-AUTH-03`을 사용한다 |
| 3 | Agent 실행 경로는 별도 클릭 없이 진행 상태를 본다. 사용자 입력이 필요한 경로만 `[사이트에서 계속]`에서 provider 컨트롤을 직접 사용한다. | 프로비저닝/행동 상태는 승인 상태와 구분된 채 유지된다 | System은 권한이 부여된 효과만 디스패치한다. | Agent/도구는 위임된 경우 이를 수행한다 | 실행이 성공한 경우에만 외부 상태가 변경될 수 있다 | 완료에는 제공자/외부 증거가 필요하다. 실패 시 승인 결과와 실행 결과는 서로 구분된 채 유지된다 |

**완료 증거**: 권한 부여 기록은 정확히 승인된 범위를 명시하며, 제공자 또는
외부 시스템에서 나온 별도의 확인증은 권한이 부여된 행동이 실제로 성공했는지를 입증한다.

### 1.6 사람 중심 코딩과 Terminal

<a id="atlas-code-01"></a>
#### CODE-01. 사람 중심 코딩 흐름

**상세 조작**: [files](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-files) · [input](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-input) · [changes](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-changes)

**기술 참조**: [Coding surface와 technical research](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-coding-surface), [Terminal runtime](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-terminal-runtime)
**사용자 결정 참조**: [HUM-CODE-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-code-001), [HUM-SURFACE-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001)

**제품 전제**: 프로젝트/폴더/파일/편집기/뷰어/변경 비교/결과 우선; Terminal은 선택 사항  
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: 사람 중심 코딩 화면에서 프로젝트/폴더 대상을 사용할 수 있다;
Agent 편집도 저장/검사 성공도 전제하지 않는다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | `[파일▾] → [폴더 연결]` 또는 `[자료]`에서 허용된 root를 열고 트리 행을 클릭한다. | 파일 트리/검색과 편집기/뷰어에 선택한 대상이 표시된다 | System은 프로젝트/파일 메타데이터를 불러온다. | 없음 | 활성 프로젝트/파일 뷰 | 프로젝트/다중 루트의 의미: `Q-CODE-01`; 정확한 열기/실패/포커스 동작: `Q-CODE-07` |
| 2 | 편집기에 입력하거나 File의 `[요청]`으로 변경 의도를 작성해 전송한다. | 사용자가 한 편집 또는 Agent가 제안/적용한 변경이 편집기와 변경 비교에 보인다 | System은 파일 변경 사항을 기록한다. | 범위 내에서만 편집한다 | 작업 파일이 변경된다 | Agent 메커니즘을 사용자 UI에 강제로 끼워 넣지 않는다 |
| 3 | `[검사] → [빌드/테스트/검사/검토] → [실행]`에서 PC·명령·대상 revision을 확인한다. | 결과가 정확한 리비전 및 명령/검사와 연결되어 표시된다 | System은 검증 실행을 시작하거나 권한상 허용된 Agent 실행을 중개하고 결과를 대상 revision에 연결한다. | 위임된 경우 Agent는 허용된 빌드·테스트·검사를 실행할 수 있다. | 결과/증거 상태 | 취소/재시도/실패/결과 탐색: `Q-CODE-08`; 녹색 상태는 그 상태가 포괄하는 검사만 증명한다 |
| 4 | File의 `[변경 N]`을 클릭해 변경 묶음을 고른다. 미적용 제안은 `[수락]`·`[선택 N개 수락]`·`[거부]`, 적용된 변경은 `[되돌리기]`, 편집기 복귀는 `[계속]`을 클릭한다. 저장은 별도로 현재 편집 모드의 `[저장]`·`[사본 저장]`·`[원본 저장]`·`[작업사본 저장]`을 클릭한다. | 선택한 파일/변경 단위, 제안된 내용과 현재 내용, 선택한 리뷰의 효과, 수락된 편집 상태, 저장됨/저장 안 됨 상태, 남은 문제가 각각 따로 보인다 | System은 선택한 리뷰 행동만 적용하고 저장 행동이 성공한 후에만 영구 반영한다 | 없음 | 작업 중 또는 영구 파일 상태가 변경된다 | 키보드/포커스, 파괴적 범위 미리보기, 취소/실행 취소, 최신 상태가 아니거나 충돌하는 변경 비교, 적용 실패, 재시도, 재진입: `Q-CODE-09`; 저장 실패: `Q-CODE-05` |

**완료 증거**: 사용자에게 보이는 파일 트리/편집기, 수락된 변경 비교,
저장된 리비전, 빌드/테스트/검사 결과가 서로 일치한다; 선택적인 Terminal 활동은
주된 코딩 UI가 아니라 보조 증거다.

<a id="atlas-term-01"></a>
#### TERM-01. Terminal 뷰, 프로세스, 연결, 재실행

**상세 조작**: [terminal](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-terminal)

**기술 참조**: [Runtime·Terminal session semantics](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-terminal-runtime), [장애 경계](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries)

**제품 전제**: Terminal view, transport, process, recovery record의 수명 주기는 서로 다르다. 분리 가능한 view를 닫아도 process를 조용히 종료하지 않으며, 종료된 process의 최종 출력은 결정된 보존 범위 안에서 read-only snapshot으로 남는다  
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: Desk를 사용할 수 있다; Terminal 뷰, 전송 연결,
프로세스 식별 정보, 프로세스 생존 상태는 각각 없거나 서로 독립적으로 존재할 수 있다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | File `[⋯] → [Terminal]` 또는 Canvas 실행 node `[출력 보기]`를 누른다. 기존 세션은 `[연결]`, 새 세션은 `[새 세션] → [시작]`을 선택한다. | 결정된 수준으로 프로세스/세션 식별 정보와 현재 작업 디렉터리가 나타난다 | System은 명시된 의미 체계에 따라 새로 만들거나 연결한다 | 없음 | 뷰와 프로세스/세션은 신규일 수도, 기존 것일 수도 있다 | 열기/실패/포커스 동작: `Q-TERM-04`; 새 프로세스를 “재연결”이라고 부르지 않는다 |
| 2 | `[뷰 닫기]`, `[⋯] → [연결 분리]`·`[고정]`, `[출력 Snapshot]` 또는 `[프로세스 종료] → [종료]`를 사용하고 각각의 남는 실행·자료를 확인한다. | 행동 전에 보이는 뷰와 기반 프로세스에 미치는 영향이 명확히 제시된다 | System은 선택한 view/transport/process/snapshot 행동만 수행하고 view 닫기를 process 종료로 바꾸지 않는다 | 없음 | 뷰, 연결, 프로세스 상태가 서로 독립적으로 변경된다 | 확인/실패/포커스: `Q-TERM-05`; 포그라운드 작업은 알리지 않고 재실행되지 않는다 |
| 3 | 동일 실행이 확인되면 세션 행 → `[연결]`을 클릭한다. 새 shell이 필요하면 `[새 세션]` → `[시작]`, 과거 출력만 보려면 해당 활동의 `[당시 관찰]`을 클릭한다. 이전 명령은 자동 재실행하지 않는다. | 동일 세션 식별 정보, 새 프로세스 식별 정보 또는 스냅샷 전용 상태가 명확히 제시된다 | System은 연결 전에 프로세스/세션의 동일성을 검증한다 | 없음 | 런타임 연속성 상태 | 실패하면 실행 가능한 선택지를 남긴다; 거짓 연결 상태를 표시하지 않는다 |

**완료 증거**: 뷰 존재 여부, 전송 연결, 프로세스 식별 정보,
프로세스 생존 상태가 각각 별도로 보고된다; 재진입은 검증된
재연결, 새 프로세스, 스냅샷 전용 또는 사용 불가로 표시된다.

### 1.7 Ontology가 관리하는 실행

<a id="atlas-ont-01"></a>
#### ONT-01. Ontology가 관리하는 Agent 사이클 검사

**상세 조작**: [e24-ontology-inspect](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-ontology-inspect) · [e24-ontology-governance](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-ontology-governance)

**기술 참조**: [Ontology runtime과 view](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-ontology-runtime), [HUM-GOV-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-gov-001)

**제품 전제**: Ontology가 사이클을 관장하고, UI는 이를 시각화/검사한다  
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: 관리되는 Ontology 버전과 기록된 Agent 사이클 0개 이상이
존재한다; 뷰를 열면 검사 권한만 부여되며 편집 권한은 부여되지 않는다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | `[업무 메뉴 ⋯] → [적용 기준] → [Ontology 검사]`에서 실행과 호출/사이클을 고른다. 업무 없이 검사할 때는 `[설정] → [지식 관리] → [Ontology 검사]`를 사용한다. | 관련 개념, 관계, 제약, 증거, 사이클 상태가 시각화된다 | System은 관리되는 Ontology와 선택한 실행을 투영한다. | 없음 | 검사 상태만 변경된다 | 정확한 사용 불가/포커스/필터/재진입 UI: `Q-ONT-04`; UI 자체가 Ontology가 되는 것은 아니다 |
| 2 | `[출처·버전]`·`[당시 근거 열기]`·`[현재 원본 확인]`과 계층·시간·관계 필터로 선택 범위를 검사한다. | 활성 모델 버전과 실행의 관계가 `Q-ONT-02`에 따라 보인다 | System은 버전/증거 메타데이터를 불러온다 | 없음 | 모델 변경 없음 | 알 수 없거나 최신 상태가 아닌 연결 관계는 `Q-ONT-04`를 통해 계속 보인다 |
| 3 | 변경 허용 시 `[변경 제안]`을 눌러 바로 열린 편집기에 후보 문장을 입력하고 `[초안 저장]` 또는 `[검증]`을 누른다. 기존 후보는 `[후보 편집]`으로 연다. 검토 정책에 따라 `[검토 요청]`, 권한자의 `[승격]`·`[적용 범위] → [활성화]`, 이력의 `[이전 버전으로 적용]`을 별도로 사용한다. | 대상·기준 revision·문장이 표시되고 저장 뒤 `비활성 초안 저장됨`이 보인다. 검증은 구조·의미·권한·영향별 통과·문제·미검증과 오류 필드 이동을 제공한다. | 초안 필수값·원문 참조·revision·권한을 검사하고 각 검사 결과를 해당 후보에 연결한다. 검토 전달·승격·활성화는 별도로 처리한다. | 유효한 원문으로 의미 검사를 요청한 경우에만 분석 결과와 근거를 반환한다. 편집기 열기·초안 저장에는 관여하지 않는다. | 비활성 후보 보존과 활성 운영 모델의 변경은 별개다. 미정 예외를 없음으로 바꾸지 않는다. | 원문 연결·현재본 비교·초안 보존과 실패/충돌의 다음 행동은 [후보 필수값·검사](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-knowledge-draft-validation)를 따른다. |

**완료 증거**: 선택한 사이클, 활성 Ontology 버전,
출처/증거 바인딩, 최신 상태가 아니거나 알 수 없는 모든 관계를 검사할 수 있으며,
일반적인 보기 동작은 모델을 변경하지 않는다.

<a id="atlas-ont-02"></a>
#### ONT-02. 관리되는 Ontology 아래에서 Agent 사이클 실행

**상세 조작**: [context-share](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-share) · [reader-observation](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-reader-observation) · [chat-entry](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-entry) · [e24-ontology-inspect](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-ontology-inspect) · [e24-ontology-governance](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-ontology-governance)

**기술 참조**: [Ontology runtime](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-ontology-runtime), [Run binding](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-agent-run-binding)

**제품 전제**: Ontology가 Agent 컨텍스트, 제약, 행동, 증거,
사이클 진행을 관장한다  
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: Chat에 최초 업무 요청을 작성할 수 있고 적용할 조직 지식에 접근할 수 있다. 이 흐름은 첫 모델 호출 전에 시작하며, 이미 진행 중인 업무의 교정과 구분한다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | 담당자 방 `[새 업무]`의 작성기에 최초 업무 요청과 자료를 넣고 `[전송]`한다. | 전송된 요청과 적용 기준을 준비하는 상태가 보인다. 사용자는 Ontology revision 번호를 입력하지 않는다. | 적용되는 조직·Desk·Agent 정책에서 현재 Ontology와 필요한 내용을 조회하고 첫 호출의 컨텍스트·권한·전환 조건을 결합한다. | 첫 호출의 입력 결합이 성공한 뒤 요청한 업무를 시작한다. | 첫 호출에 실제 사용한 Ontology 참조·범위와 입력 revision이 기록된다. | 필수 내용 조회 실패는 의존 행동만 막는다. 현재 업무 교정은 다음 행, 조직 후보 작성·편집은 ONT-01의 별도 명시 경로다. |
| 2 | 없음 — System 자동으로 허용된 다음 호출에 변경을 반영하며 진행한다. 추가 지시는 같은 Chat 작성기에 입력 후 `[전송]`, 중지는 `[이 업무 중지]`를 클릭한다. | 작업 상태와 추가 지시의 수신·반영 여부를 확인할 수 있다 | System은 새 도구 관찰·사용자 조정·관련 Ontology 변경을 다음 호출에 포함하고 호출별 binding과 전환 증거를 보존한다 | Agent는 같은 Run의 다음 호출에서 새 내용을 해석해 계획·행동을 조정한다 | Run을 유지하며 context와 Ontology 사용 이력이 추가됨 | 자료 갱신만으로 멈추지 않는다. 권한·승인 대상·동시 쓰기 충돌은 해당 행동만 재검증한다 |
| 3 | 결과의 `[근거]`, Ontology의 `[출처·버전]`·`[검증 결과]` 또는 연결된 자료의 `[현재 원본 확인]`을 연다. | 바인딩된 모델 버전, 수락된 증거, 작업 상태, 모든 거부가 `Q-ONT-02`에 따라 서로 연관되어 표시된다 | System은 기록된 사이클 상태를 투영한다 | Agent는 출력/증거를 제공할 뿐, 거버넌스상의 진실을 제공하지 않는다 | 검사 projection과 포커스만 변경되며 Ontology binding과 Run 상태는 바뀌지 않음 | 재정의, 제안, 승격, 롤백은 각각 별도로 `Q-ONT-03`과 `Q-ONT-05`를 따른다 |

**완료 증거**: 기록된 각 작업 전환은 바인딩된
Ontology 버전, 검증된 전환, 수락된 증거, Agent 출력,
모든 거부된 전환을 식별하며 Agent 출력을 거버넌스상의 진실로 취급하지 않는다.

### 1.8 협업·computer-use·데이터·접근성

<a id="atlas-col-01"></a>
#### COL-01. 다른 사람이 Desk에 참여해 작업

**상세 조작**: [e24-collaboration-manage](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-collaboration-manage) · [e24-collaboration-invite](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-collaboration-invite) · [e24-computer-use-observe](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-computer-use-observe) · [view](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-view)

**기술 참조**: [Multi-user Desk](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-collaboration-computer-use)
**사용자 결정 참조**: [HUM-COLLAB-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001), [HUM-REMOTE-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-remote-001)

**제품 전제**: 최종 비즈니스 범위에는 다중 사용자 협업이 포함된다. 참가자와 실행 PC는 별개의 축이며, 같은 사람이 여러 PC의 자원을 연결하거나 여러 사람이 허용된 작업을 함께 볼 수 있다. 참여만으로 다른 PC의 모든 자료·계정·제어 권한을 얻지는 않는다.

**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름<br>
**승인 게이트**: `A-INFRA-01`
**시작 상태**: 허용된 공유 범위의 Desk가 있다. 단일·공동 소유, 관리·이전·복구 위임의 조건별 경로가 있으며 적용 정책은 연결된 사용자 선택에 따른다. 협업자는 묵시적 권한을 얻지 않으며 실제 초대 전에는 필요한 원격 인프라가 승인·가동되어야 한다. 관련: `Q-COL-06`.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | 권한 있는 공유 개시자가 Agenda의 `[⋯]` → `[공유]`를 클릭해 수신자·공유 범위·권한·기간을 선택한다. 전송하지 않고 돌아가려면 `[취소]`를 클릭한다. | 사람, 역할, 공유되는 Desk/Agenda/뷰/데이터, 기간, 접근 거부 영역이 `Q-COL-01`과 `Q-COL-08`에 따라 보인다 | System은 승인된 신원 체계/네트워크 인프라를 통해 초대 초안만 준비한다 | 없음 | 초대 초안; 아직 권한 부여 없음 | 인프라 게이트: `A-INFRA-01`; 역할 권한: `Q-COL-06`; 정확한 초안 UI: `Q-COL-08` |
| 2 | 권한 있는 공유 개시자가 `[미리보기]`에서 수신자·범위·권한·기간을 확인한 뒤 `[보내기]`를 클릭한다. | 수신자, 전달 채널, 대기/전송됨/전달 상태, 만료, 취소/재전송 행동이 보인다 | System은 승인된 인프라를 통해 전달을 시도하고 이용 가능한 전달 증거만 기록한다 | 없음 | 초대 전달 상태; 접근 권한은 아직 증명되지 않는다 | 수신자를 찾을 수 없음, 전송 실패, 만료된 링크, 재전송, 취소: `Q-COL-07` |
| 3 | 초대받은 사람이 `[초대 내용 보기]`에서 신원·범위·역할·기간을 확인한다. 계정이 다를 때만 `[다른 계정으로 참여]`로 전환한다. 올바른 계정이 확인되면 같은 계정으로 시작한 경우에도 `[수락하고 참여]`를 클릭한다. | 초대받은 사람에게는 권한상 허용된 화면만 보인다; 공유하는 쪽에는 `Q-COL-03`에 따라 참여 상태가 보인다 | System은 승인된 인프라를 통해 인증, 권한 부여, 동기화를 수행한다 | 없음 | 수락이 성공한 경우에만 협업 권한과 공유 세션 상태가 생긴다 | 실패, 만료, 권한 회수, 재진입: `Q-COL-02`, `Q-COL-04`, `Q-COL-07` |
| 4 | 허용된 공유 View의 bar·가장자리 핸들을 드래그해 위치·크기를 바꾸고, 편집 권한이 있으면 내용 입력란을 클릭해 입력한다. 충돌 시 `[변경 비교]`에서 `[현재본 유지]`·`[내 초안 보존]` 또는 변경 선택 → `[선택 변경 적용]`을 클릭한다. 수락 권한이 없으면 `[수락 요청]`을 클릭한다. | 행위자, 포커스/제어 소유권, 변경 사항, 충돌이 `Q-COL-05`와 `Q-COL-10`에 따라 표현된다 | System은 결정된 동시성/충돌 모델을 적용한다 | 없음 | 리소스 행동이나 해결이 성공한 경우에만 공유 데이터/세션이 변경된다 | 비공개 상태가 유출되지 않는다; 정확한 충돌/병합/실행 취소 UI: `Q-COL-10` |
| 5 | 권한 있는 관리자가 `[설정]` → `[공유 관리]` → 참여자 → `[권한 변경]`에서 역할·기간을 고르고 `[영향 확인]` → `[적용]`을 클릭한다. 회수는 같은 참여자의 `[회수]` → 영향 확인 → `[확정]`을 클릭한다. | 정책 적용과 각 측의 전달·적용 확인 상태, 가능한 행동 또는 실패가 구분되어 보인다. 오프라인 상대의 적용 여부는 미확인으로 남는다 | System은 `Q-COL-04`와 `Q-COL-06`에 따라 허용된 변경을 적용하고 도달 가능한 경계에서 후속 행동을 차단한다. 각 측의 전달·적용 증거를 별도로 기록한다 | 없음 | 정책 변경과 원격 적용 확인 상태를 별도로 갱신한다 | 정확한 확인/실패/포커스 복귀: `Q-COL-09`; 관찰 권한과 제어 권한은 계속 분리된다 |

**완료 증거**: 초대 준비, 전달, 수락, 실제 접근은 각각 증거가 있는
별도의 상태다; 양측 모두 행위자 귀속과 함께 권한상 허용된 동일한 공유 범위를 보며,
회수되었거나 만료된 권한은 이를 검증하는 제어 경계에서 새로운 행동을 차단한다.
연결이 끊긴 상대의 적용 여부와 이미 전송한 행동의 결과는 별도로 확인하며, 전달된
과거 사본이 즉시 회수됐다고 표시하지 않는다. 비공개 Desk·계정 상태는 노출하지 않는다.

<a id="atlas-cu-01"></a>
#### CU-01. 물리적 입력 충돌 없는 Desk 외부 computer-use

**상세 조작**: [e24-computer-use-control](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-computer-use-control) · [e24-computer-use-observe](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-computer-use-observe)

**기술 참조**: [Desk-external computer-use](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-collaboration-computer-use), [관찰 보존](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-observation-fidelity)

**제품 전제**: `[업무 메뉴 ⋯] → [컴퓨터 사용 범위]`에서 대상 PC·입력 방식·관찰·권한을 확인한다. 관찰 View에서 제어자·상태·중지를 확인하고 입력 인계와 결과 검증을 분리한다. 캡처·기록·원격 범위는 연결된 정책과 승인에 따른다.<br>
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름<br>
**승인 게이트**: 원격 관찰/제어 인프라에만 `A-INFRA-02`
**시작 상태**: 권한상 허용된 작업이 Desk 네이티브 뷰 밖에서의 행동을 필요로 한다;
사람이 물리적 입력 권한을 유지하며 아직 어떤 Agent나 협업자도 제어권을 갖지 않는다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | 요청을 전송하고 `[업무 메뉴 ⋯] → [컴퓨터 사용 범위]`에서 PC·대상·입력 방식·관찰·권한을 확인해 `[이 범위에서 시작]` 또는 `[취소]`한다. | 대상 PC·앱·입력 방식·관찰 범위와 `입력권 확인 중`이 보인다. 검사와 입력권 확보 후 `Agent 입력 중`, 실패·경합이면 `시작 불가`와 이유가 보인다. | 요청한 범위·대상·권한·관찰·중지 경로·입력 lease를 검사하고 모두 유효할 때만 입력을 허용한다. | 입력권이 확인된 뒤에만 같은 범위의 행동을 시작한다. | 시작 요청 → 검증 대기 → 입력권 확보·실행 또는 시작 불가. 취소는 미발송 시작 요청만 취소한다. | 일반적인 `Host Activity View` 객체를 전제하지 않는다; 검증/실패: `Q-CU-05` |
| 2 | 시작된 관찰 View에서 `[일시 중지]`, `[직접 입력]`, `[Agent에게 돌려주기]`, `[중지]`를 선택한다. 긴급 차단은 `[모든 Agent 입력 긴급 중지]`를 누른다. 앞 단계의 시작을 다시 누르지 않는다. | 현재 입력 담당자, 양보·입력권 회수·중지 요청·종료 확인 상태가 구별된다. | 일시 중지는 다음 입력을 차단하고 lease를 해제한다. 직접 입력은 Agent 양보 뒤 인계하며, 돌려주기는 현재 대상과 변경을 재검사한다. | Agent는 확인된 범위와 제어권을 가진 동안에만 computer-use 행동을 수행한다. | 입력 담당자·lease·실행 상태가 해당 조작에 따라 바뀐다. 중지 요청을 종료 확인으로 간주하지 않는다. | 물리적 입력 발생, 긴급 중지, 제어권 반환: `Q-CU-03`; 정확한 컨트롤: `Q-CU-06` |
| 3 | 로컬 실행 중 Chat의 `[활동 N개]` → 해당 행의 `[관찰]`을 클릭한다. 필요하면 관찰 View의 `[일시 중지]`·`[중지]`·`[관찰 닫기]`를 클릭한다. | 대상 앱·창, 현재 제어자, 실행 중 행동, 포커스와 타임라인, privacy masking 상태가 Desk 안에 보인다 | System은 로컬 관찰 projection을 갱신하고, 일시 중지·중지 시 입력 소유권과 실행 상태를 함께 전환한다. | 허용된 범위와 제어권이 유지될 때만 다음 행동을 요청한다 | 로컬 관찰의 열림·닫힘 또는 제어 상태만 명시적으로 바뀐다 | 관찰 stream 실패, 재시도, 원 Task 포커스 복귀와 재진입은 `Q-CU-09`; 이 로컬 관찰 자체에는 원격 인프라 승인이 필요하지 않다 |
| 4 | 허용된 관찰의 `[관찰 열기]`·`[관찰 닫기]`를 사용한다. 송신 중단은 별도 `[관찰 공유 끝내기]`이며 기록 중이면 지속 표시와 `[기록 중지]`를 확인한다. | 승인된 Desk 외부 시각/행동 데이터만 표시된다 | System은 결정된 개인정보 보호 범위만 스트리밍/저장한다 | 없음 | 원격 관찰 상태 | 인프라/개인정보 보호 게이트: `A-INFRA-02`; 동의/실패/재진입 UI: `Q-CU-07` |
| 5 | 관찰 View 하단 또는 Task 결과의 `[결과 확인]`을 클릭해 요청·실제 관찰·판정을 비교하고, 필요한 `[근거 검사]`·`[현재 상태 새로고침]`·`[검증 재시도]`를 클릭한다. | 요청된 결과, 관찰된 대상 상태, 독립적인 증거 출처/시간, 검증됨/불일치/알 수 없음 상태가 입력/행동 로그와 분리되어 보인다 | System은 입력 재생과 독립적으로 결과 증거를 확보하거나 새로 고친다. | 관찰 내용을 보고할 수 있지만 성공을 스스로 인증할 수 없다 | 요청 범위나 제어 소유자를 암묵적으로 변경하지 않은 채 검증 상태가 변경된다 | 누락된 증거, 최신 상태가 아닌 증거 또는 권한 부족으로 접근할 수 없는 증거, 불일치, 알 수 없는 결과, 재시도, 재진입에는 `Q-CU-08`을 사용한다; 재생된 입력 시퀀스는 결코 완료 증거가 아니다 |
| 6 | 필요하면 관찰 View의 `[중지]` 또는 컴퓨터 사용 범위의 `[제어 회수]`를 클릭한다. 긴급 시 `[모든 Agent 입력 긴급 중지]`를 클릭하거나 해당 PC에 표시된 검증된 긴급키를 누른다. 완료가 확인된 경우: 없음 — System 자동 상태 반영. | 최종 행동 확인 기록, 검증 상태, 해제된 제어권이 보인다 | System은 소유권을 해제하고 허용된 행동 증거와 결과 증거를 각각 별도로 보존한다 | 없음 | 제어권은 사람/제어자 없음 상태로 돌아간다; 작업은 결정된 검증 규칙 아래에서만 완료된다 | 실패하거나 알 수 없는 검증은 `Q-CU-08`을 통해 계속 조치할 수 있다; 중지와 긴급 중지는 작업을 성공으로 거짓 표시하지 않는다 |

**완료 증거**: 결정된 정책 아래에서 사람과 Agent의 입력은 절대 겹치지 않고,
제어 소유권은 계속 보이며, 긴급 중지는 제어권을 해제하고,
작업 결과는 입력 재생과 별도로 검증된다.

<a id="atlas-data-01"></a>
#### DATA-01. 설정, 로컬 영구 저장, 내보내기, 백업, 동기화

**상세 조작**: [reset](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-reset) · [portable](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-portable)

**기술 참조**: [로컬 저장과 immutable object](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-storage-export), [`.egdesk` bundle](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-portable-bundle)  
**사용자 결정 참조**: [HUM-EXPORT-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-export-001), [HUM-SNAPSHOT-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001)  
**제품 전제**: 로컬 기능은 진행할 수 있다; 동기화/다중 기기 인프라에는 승인이 필요하다  
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름<br>
**승인 게이트**: 원격 백업/동기화에만 `A-INFRA-03`
**시작 상태**: 로컬 EG-Desk 상태가 존재한다; 로컬에서 사용할 수 있다는 사실로부터 원격 백업, 동기화 계정,
제공자 또는 복원 성공을 추론하지 않는다.

| # | 제품 사용자 UI 행동 | 즉시 보이는 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | 앱 `[설정] → [데이터와 초기화]`를 열고 대상 PC·저장 범주를 고른다. | 앱, Desk, Agenda, 계정/프로필, Agent 또는 기기 등 각 설정의 범위가 `Q-DATA-01`에 따라 보인다 | System은 로컬 설정을 읽는다. | 없음 | 명시적인 행동 전에는 변경 없음 | 초기화/기본값 동작: `Q-DATA-01`과 `Q-DATA-04` |
| 2 | Agenda의 `[⋯]` → `[내보내기]`에서 포함·제외 항목과 암호화 설정을 확인·조정한다. 암호화 켬이면 암호·확인을 입력하고, 끔이 허용된 경우 평문 노출을 확인한다. `[목적지 선택]` → OS 저장 위치 선택 → `[내보내기 시작]`을 클릭한다. | `.egdesk` 한 파일에 포함할 root, 연결 object 수·예상 크기, 제외되는 token·cookie·기기 전용 경로·비공개 scope, 암호화 상태가 먼저 보인다. 진행 중에는 취소 가능 범위와 현재 검증 단계가 나타난다. | 선택 root의 closed reference graph를 만들고 manifest·event·사람이 읽는 transcript·필요 payload를 staging한 뒤 모든 hash를 검증하고 한 파일로 원자적으로 게시한다. | 없음 | 검증된 로컬 `.egdesk` bundle이 생성될 수 있다. | 파일이 생긴 사실만으로 import 성공을 주장하지 않는다. 기본 포함·암호화는 `HUM-EXPORT-001`. |
| 3 | 가져올 PC의 EG-Desk에서 `[파일▾]` → `[가져오기]` → `.egdesk` 파일을 선택하고, 암호화 파일이면 암호를 입력한다. 미리보기에서 허용된 `[새 사본]`·`[병합]`·`[현재 구성 교체]` 중 방식을 고른다. 충돌이 있으면 `[현재 유지]`·`[가져온 내용 사용]`·`[둘 다 보존]` 중 선택한 뒤 `[가져오기 실행]`을 클릭한다. | format/version/hash/필수 object 검증, Chat·Canvas·Snapshot·Agenda 미리보기, 충돌과 credential 제외 상태가 보인다. 적용 전에는 현재 Desk가 바뀌지 않는다. | 격리된 staging 범위에서 bundle을 검증하고 충돌 선택을 적용한다. 성공 후 대표 Chat·Canvas·Snapshot·Agenda reference를 실제로 다시 열어 연결 무결성을 검사한다. | 없음 | 검증이 끝난 경우에만 로컬 영구 상태에 새 root/revision이 추가된다. | parse 성공만 완료가 아니다. 실패하면 원 상태를 유지하고 어느 object가 실패했는지·재시도/파일 교체를 보여 준다. |
| 4 | `[설정] → [기기·원격 연결]` 또는 데이터 설정의 `[원격 백업·동기화]`에서 대상 데이터·환경·비용·보존을 확인하고 `[승인 요청]` 또는 `[나중에]`를 누른다. | 승인 안건에 `Q-DATA-05`의 데이터 흐름, 신원, 보안, 비용, 제공자, 마이그레이션 영향이 표시된다 | 승인 없이 외부 프로비저닝은 이루어지지 않는다 | 없음 | 실행 전에는 원격 상태 없음 | 인프라 게이트: `A-INFRA-03` |

`[설정] → [데이터와 초기화]`에서 선택 범위의 보존·삭제·초기화 영향을 확인한다. 동기화와 백업은 `[기기·원격 연결]`에서 독립 설정하며 기록 제거·복구 기간·보호 백업·동기화 범위는 연결된 사용자 선택에 따른다. 관련: `Q-DATA-04`, `Q-DATA-05`.

**완료 증거**: 로컬 내보내기는 하나의 `.egdesk` 파일, manifest/object hash 검증,
credential 제외 내역을 가진다. 가져오기는 구문 분석 성공이 아니라 대표 Chat·Canvas·
Snapshot·Agenda가 같은 lineage로 다시 열리는 상태를 증명한다. 승인과 성공적인 실행
증거가 생기기 전에는 원격 데이터나 인프라가 존재하지 않는다.

<a id="atlas-ux-01"></a>
#### UX-01. 포인터 없이도, 움직임에만 의존하는 단서 없이도 EG-Desk 핵심 흐름 사용

**상세 조작**: [input](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-input)

**기술 참조**: [Accessibility와 동등 입력 경로](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-accessibility), [HUM-A11Y-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-a11y-001)

**제품 전제**: 키보드·IME·포커스 복귀·목록·동등 편집 경로는 모든 정책에서 유지한다. 최종 지원 OS·보조기술·언어·적합성 약속은 연결된 사용자 선택이며 실제 통과 증거와 구분한다.<br>
**명세 상태**: 상세 조작·기술 설계 있음; 남은 정책은 연결된 사용자 선택에 따름
**시작 상태**: 모든 핵심 흐름은 정상적인 제품 상태로 진입할 수 있다;
포인터 존재, 움직임에 대한 내성, 색상 인지 또는 시각적 Canvas 접근을
유일한 입력이나 피드백 채널로 전제할 수 없다.

| # | 제품 사용자 UI 행동 | 즉시 보이는/비시각적 반응 | System 처리 | Agent 처리 | 상태 변화 | 경계 및 다음 UI 행동 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | F6 또는 해당 resource의 `[도구모음으로 이동]`으로 셸에 나온 뒤 Tab·Shift+Tab·방향키로 Sidebar·Canvas 목록·View bar·Chat을 탐색한다. | 포커스 위치, 선택한 항목, 입력 소유자, 사용 가능한 행동을 프로그래밍 방식과 시각적으로 식별할 수 있다 | System은 행동을 실행하지 않고 포커스를 이동한다. | 없음 | 포커스만 변경된다 | 포커스된 객체를 닫거나 제거하면 `Q-UX-02`와 `Q-UX-04`에 따라 포커스가 복귀한다 |
| 2 | 포커스한 버튼은 Enter/Space, 메뉴·목록은 방향키와 Enter로 실행한다. IME 조합 확정 키는 상위 실행에 재사용하지 않는다. | 포인터 사용자에게 제공되는 것과 동일한 성공/오류/대기 상태가 `Q-UX-01`과 `Q-UX-04`에 따라 안내된다 | System은 포인터 경로와 동일한 제품 행동을 실행한다. | 해당 행동이 Agent 요청 전송일 때만 결합된 범위 안에서 관여한다. | 포인터 실행과 동일한 상태 전환 | 비활성화 사유, 단축키 소유권, 안내, 다음 행동: `Q-UX-04` |
| 3 | `[목록으로 보기]`, Briefing `[단계 목록]`, Ontology 관계표를 사용하고 모션 감소를 켜 같은 대상·상태·행동에 도달한다. | 공간 관계, 현재 단계/대상, 이동 결과에 움직임에 의존하지 않거나 비시각적인 표현이 있다 | System은 이동/확대·축소 애니메이션을 요구하지 않고 프레젠테이션을 업데이트한다. | 없음 | 프레젠테이션 상태 | 핵심 의미가 위치, 색상 또는 움직임에만 존재하지 않는다 |

**완료 증거**: 모든 핵심 흐름은 결정된 키보드/접근성 경로로 계속 조작할 수 있고,
포커스와 상태 변경이 안내되며, Canvas 또는 Answer Briefing의 의미를 색상, 위치 또는
움직임만으로 제공하지 않는다.

드래그로 옮기거나 크기를 바꾸는 항목은 클릭·탭으로도 해당 행동을 선택할 수 있으며,
키보드로 같은 결과에 도달하는 경로를 제공한다. 상세 화면에서 돌아오면 시작한
control로 복귀하고, 그 control이 사라졌으면 같은 업무의 접근 가능한 진입점으로 돌아온다.
한글 등 입력기의 조합을 확정하는 키는 Chat 메시지 전송을 함께 실행하지 않는다.
Agent의 진행·오류 알림은 사용자가 입력 중인 곳의 focus를 옮기지 않는다.

## 2. 화면·개념 관계 지도

### 2.1 관계도 표기

- 각 지도는 시작 상태와 끝 상태가 분명한 하나의 aspect만 다룬다.
- 실선 화살표(→)는 현재 확정된 관계 또는 전환이다.
- 점선 화살표(⇢)의 Q-ID는 상세 조작이나 정책 분기로 이어지는 관계를 식별한다. 점선 자체가 설계 부재나 정책 승인을 뜻하지 않는다.
- 굵은 화살표(⇒)는 외부 인프라·자격 증명·비용·배포·데이터 이동·확장 권한의 승인 게이트이며, 반드시 A-ID를 붙인다.
- 기능 선언, 현재 가용성, 위임된 권한, 승인 기록, 실행 상태, 성공 증거는 서로 다른 노드나 상태로 유지한다.
- Chat은 입력 및 답변 투영 화면이다. System이 요청·컨텍스트·권한을 Run에 결합한 뒤 Agent runtime을 시작하며, Chat이 Agent runtime을 담지 않는다.
- 저장된 Agenda, 자동 Desk 세션 기록, 보이는 view, 리소스 runtime/process는 서로 독립적인 상태 평면이다.
- 활성 화면은 View(뷰)로 부른다. Card는 간결한 View·결과 표현 형식이며 Desk Window는 이전 화면 명칭이다. 이 이름들은 별도의 리소스·실행 수명을 만들지 않는다.
- 금지된 제품 객체는 지도 노드로 만들지 않는다.

### 2.2 시작점과 끝점이 분명한 관계도

### M1. EG-Desk 실행 → Desk / Canvas / Sidebar

시작은 운영체제의 실행 행동이고, 끝은 사용할 수 있는 실제 Desk와 그 두 기본 표면이다.

~~~mermaid
flowchart LR
  m1_start["시작: 운영체제 실행 진입점"]
  m1_shell["EG-Desk Firefox 셸"]
  m1_desk["Desk"]
  m1_canvas["Canvas"]
  m1_canvas_rule["Canvas 소속·개수 규칙"]
  m1_sidebar["Sidebar"]
  m1_end["끝: 저장된 Agenda 목록 또는 빈 상태"]

  m1_start -. "Q-LIFE-01 · Q-LIFE-02 · Q-LIFE-03" .-> m1_shell
  m1_shell --> m1_desk
  m1_desk --> m1_canvas
  m1_canvas -. "Q-OBJ-02" .-> m1_canvas_rule
  m1_desk --> m1_sidebar
  m1_sidebar -. "Q-LIFE-04" .-> m1_end
~~~

### M2. 종료 → 자동 Desk 세션 → 재실행 복원

자동 Desk 세션과 저장된 Agenda는 나란히 읽히는 독립 평면이다. 둘 사이에는 생성·갱신 edge가 없다.

~~~mermaid
flowchart LR
  m2_start["시작: 실행 중인 Desk"]
  m2_change["View·배치·스크롤 변경"]
  m2_session["자동 Desk 세션 기록"]
  m2_exit["종료·충돌·강제 종료 경계"]
  m2_restart["재실행"]
  m2_validate["마지막 유효 기록 검증"]
  m2_desk["끝 A: Desk와 view 인스턴스 복원"]
  m2_agenda["저장된 Agenda 지속성"]
  m2_sidebar["끝 B: Sidebar의 저장된 Agenda 행"]

  m2_start --> m2_change
  m2_change -. "Q-RESTORE-07" .-> m2_session
  m2_start -. "Q-LIFE-05 · Q-RESTORE-05 · Q-RESTORE-08" .-> m2_exit
  m2_exit --> m2_restart
  m2_session --> m2_validate
  m2_restart --> m2_validate
  m2_validate -. "Q-RESTORE-02 · Q-RESTORE-03 · Q-RESTORE-04 · Q-RESTORE-05" .-> m2_desk
  m2_agenda --> m2_sidebar
  m2_restart -. "Q-RESTORE-01 · Q-RESTORE-06" .-> m2_sidebar
~~~

### M3. Resource entry / file picker → view → resource runtime

리소스가 존재하는지, 현재 접근 가능한지, 사용자가 그 리소스에 행동할 권한이 있는지는 별도 검사다.

~~~mermaid
flowchart LR
  m3_start["시작: 리소스 진입 표면"]
  m3_picker["파일·폴더 선택기 / drop"]
  m3_locator["리소스 locator"]
  m3_available["현재 가용성"]
  m3_authority["접근·행동 권한"]
  m3_view["View 인스턴스"]
  m3_runtime["리소스 runtime"]
  m3_end["끝: 리소스별 결과·실패 증거"]

  m3_start -. "Q-CODE-07" .-> m3_picker
  m3_start -. "Q-VIEW-01 · Q-VIEW-11" .-> m3_locator
  m3_picker --> m3_locator
  m3_locator --> m3_available
  m3_locator --> m3_authority
  m3_available -. "Q-VIEW-03" .-> m3_view
  m3_authority -. "Q-VIEW-03 · Q-VIEW-09" .-> m3_view
  m3_view --> m3_runtime
  m3_runtime -. "Q-VIEW-09 · Q-CODE-02" .-> m3_end
~~~

### M4. Browser content / locator / account authority / evidence → Agenda

콘텐츠 동일성, 위치, 계정 권한, 가능한 행동, 외부 효과 상태, 검증 증거를 하나의 식별자로 합치지 않는다.

~~~mermaid
flowchart LR
  m4_start["시작: Browser view"]
  m4_content["콘텐츠 동일성"]
  m4_locator["URL·리소스 locator"]
  m4_authority["계정·프로필 권한"]
  m4_actions["현재 가능한 행동"]
  m4_lineage["SourceRef·증거 계보"]
  m4_effect["위임 범위 안 외부 효과 실행 상태"]
  m4_verify["독립 외부 검증"]
  m4_end["끝: Agenda 구성 후보"]

  m4_start --> m4_content
  m4_start --> m4_locator
  m4_start --> m4_authority
  m4_authority --> m4_actions
  m4_content --> m4_lineage
  m4_locator --> m4_lineage
  m4_actions -. "Q-BROWSER-03" .-> m4_effect
  m4_effect --> m4_verify
  m4_verify --> m4_lineage
  m4_lineage -. "Q-AG-02 · Q-AG-08 · Q-AG-14" .-> m4_end
~~~

### M5. Chat request → System binding → Agent runtime → Desk surfaces

Chat과 Agent runtime 사이에는 반드시 System의 컨텍스트·권한·Run 결합이 있다.

~~~mermaid
flowchart LR
  m5_start["시작: Chat 입력 표면"]
  m5_request["사용자 요청"]
  m5_context["System 컨텍스트 결합"]
  m5_permission["System 권한 결합"]
  m5_binding["Run binding"]
  m5_agent["Agent runtime"]
  m5_state["System task·result 상태"]
  m5_chat["끝 A: Chat 투영"]
  m5_canvas["끝 B: Canvas·기타 Desk 투영"]

  m5_start -. "Q-AI-01 · Q-AI-02 · Q-AI-10" .-> m5_request
  m5_request --> m5_context
  m5_request --> m5_permission
  m5_context -. "Q-AI-03 · Q-AI-11" .-> m5_binding
  m5_permission --> m5_binding
  m5_binding --> m5_agent
  m5_agent --> m5_state
  m5_state --> m5_chat
  m5_state -. "Q-MEDIA-01" .-> m5_canvas
~~~

<a id="atlas-m5-f"></a>
### M5-F. Tool observation → Snapshot/Live Canvas

같은 path·URL·session binding은 같은 시점의 내용을 뜻하지 않는다. 정상 경로에서는
명명된 direct tool 결과 뒤에서 반환값을 말없이 자르지 않는다. Smart Read에서는
immutable raw/source capture와 Reader가 만든 Context Packet, 실제 Agent 전달 payload가
다를 수 있으며 그 관계를 Snapshot manifest에 보존한다. Canvas는 이 역사적 기록과
현재 resource를 서로 다른 view로 보여 주며 현재 상태가 과거 관찰을 덮어쓰지 않는다.

~~~mermaid
flowchart LR
  m5f_source_then["관찰 시점 source/runtime"]
  m5f_capture["불변 raw capture / 명명된 결과"]
  m5f_mode["direct 전달 또는 Reader 변환"]
  m5f_agent["Agent에게 실제 전달된 payload"]
  m5f_historical["Canvas: Snapshot View<br/>capture·payload·lineage"]
  m5f_source_now["현재 source/runtime"]
  m5f_current["Canvas: 상호작용 가능한 Live View"]
  m5f_diff["명시적 차이 비교"]

  m5f_source_then --> m5f_capture
  m5f_capture --> m5f_mode
  m5f_mode --> m5f_agent
  m5f_capture --> m5f_historical
  m5f_agent --> m5f_historical
  m5f_source_now --> m5f_current
  m5f_historical --> m5f_diff
  m5f_current --> m5f_diff
~~~

Direct File read가 40–80행을 명명된 결과로 반환했다면 같은 40–80행이 snapshot과
해당 Agent input에 존재한다. Smart Read라면 전체 source snapshot과 더 작은 Context
Packet이 함께 보존되고 packet의 coverage·변환 이유가 나타난다. Snapshot View와 Live
View는 같은 renderer를 재사용할 수 있지만 별도 view identity로 Canvas에 공존한다.
Live View의 편집·새로고침이나 report set 재배치는 과거 snapshot을 바꾸지 않는다.
현재 상태를 다음 Agent에 전달하려면 새 context revision 또는 도구 호출로 새 관찰을 만든다.
기술 상세: [Smart Read](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-smart-read),
[관찰 보존](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-observation-fidelity).

### M6. Agent Profile revision 등 → Run binding

Agent의 기능 선언과 지금 실행 가능한지는 다르며, 위임 권한과 추가 승인도 다르다.

~~~mermaid
flowchart LR
  m6_profile["Agent Profile revision<br/>기능 선언·구성"]
  m6_request["request"]
  m6_context["context revision"]
  m6_available["현재 availability"]
  m6_authority["위임된 authority"]
  m6_approval["해당 시 승인 기록"]
  m6_ontology["활성 Ontology version"]
  m6_binding["Run binding"]
  m6_end["끝: Agent runtime 시작"]

  m6_profile -. "Q-AI-07 · Q-AI-08 · Q-AGENT-01~03 · Q-AGENT-13" .-> m6_binding
  m6_request -. "Q-AI-01 · Q-AGENT-13" .-> m6_binding
  m6_context -. "Q-AI-03 · Q-AGENT-06 · Q-AGENT-07" .-> m6_binding
  m6_available -. "Q-AGENT-04" .-> m6_binding
  m6_authority -. "Q-AI-09 · Q-AGENT-05" .-> m6_binding
  m6_approval ==>|"A-AUTH-01 · A-AUTH-02 · A-AUTH-03<br/>A-INFRA-01 · A-INFRA-02 · A-INFRA-03"| m6_binding
  m6_ontology -. "Q-ONT-02 · Q-AGENT-09" .-> m6_binding
  m6_binding --> m6_end
~~~

### M7. 하나의 Answer → Chat / Canvas → Answer Briefing / Briefing Comment → 다음 Chat

Answer는 하나이고 표현은 복수일 수 있다. 결과 칩은 도메인 객체가 아니라 탐색 어포던스 후보일 뿐이다.

~~~mermaid
flowchart LR
  m7_start["시작: 하나의 논리적 Answer"]
  m7_chat["Chat projection"]
  m7_nav["탐색 어포던스<br/>결과 칩은 비객체 후보"]
  m7_canvas["Canvas projection"]
  m7_playback["Answer Briefing"]
  m7_stage["Briefing Step<br/>target set · Focus Scope · explanation"]
  m7_comment["Briefing Comment"]
  m7_draft["다음 Chat 초안"]
  m7_end["끝: 다음 Chat 요청"]

  m7_start --> m7_chat
  m7_start -. "Q-MEDIA-01" .-> m7_canvas
  m7_chat -. "Q-MEDIA-02" .-> m7_nav
  m7_nav --> m7_canvas
  m7_canvas -. "Q-MEDIA-02" .-> m7_nav
  m7_nav --> m7_chat
  m7_canvas -. "Q-MEDIA-04 · Q-MEDIA-09" .-> m7_playback
  m7_playback -. "Q-MEDIA-04 · Q-MEDIA-09" .-> m7_stage
  m7_stage -. "Q-MEDIA-05 · Q-MEDIA-11" .-> m7_comment
  m7_comment -. "Q-MEDIA-07 · Q-MEDIA-08" .-> m7_draft
  m7_draft -. "Q-AI-02" .-> m7_end
~~~

### M8. Task graph → parallel Agents → evidence dependency → dependent start

파일 이벤트는 종속 조건의 한 종류일 수 있지만, 그것 자체가 오케스트레이션 모델은 아니다.

~~~mermaid
flowchart LR
  m8_start["시작: 범위가 한정된 request"]
  m8_graph["task·dependency graph"]
  m8_ready["ready 독립 task"]
  m8_agents["parallel Agents"]
  m8_evidence["수락된 result·evidence"]
  m8_gate["evidence dependency gate"]
  m8_dependent["종속 task 시작"]
  m8_end["끝: Result 종합 / Answer 후보"]

  m8_start -. "Q-ORCH-01" .-> m8_graph
  m8_graph --> m8_ready
  m8_ready --> m8_agents
  m8_agents --> m8_evidence
  m8_evidence -. "Q-ORCH-02" .-> m8_gate
  m8_gate --> m8_dependent
  m8_dependent --> m8_end
  m8_evidence --> m8_end
~~~

### M9. Approval boundary → batched review, independent branches continue

승인은 실행 허가이고 성공 증거가 아니다. 거부·보류·철회도 승인과 다른 결정 상태다.

~~~mermaid
flowchart LR
  m9_start["시작: 실행 중인 task graph"]
  m9_boundary["새 외부 경계 감지"]
  m9_packet["중복 제거된 검토 패킷"]
  m9_independent["끝 A: 독립 분기 계속"]
  m9_review["일괄 검토 표면"]
  m9_decision["감사 가능한 승인·거부·보류 기록"]
  m9_branch["영향 분기 재개·종료·대기"]
  m9_execute["승인 시 provider 실행 상태"]
  m9_end["끝 B: 별도 외부 성공 증거"]

  m9_start --> m9_boundary
  m9_boundary --> m9_packet
  m9_boundary --> m9_independent
  m9_packet -. "Q-ORCH-03 · Q-ORCH-06" .-> m9_review
  m9_review ==>|"A-INFRA-01 · A-INFRA-02 · A-INFRA-03<br/>A-AUTH-01 · A-AUTH-02 · A-AUTH-03"| m9_decision
  m9_decision --> m9_branch
  m9_branch -. "Q-AUTH-06 · 승인된 경우만" .-> m9_execute
  m9_execute --> m9_end
~~~

### M10. Human-first coding

프로젝트·파일·편집기·변경 비교·결과가 주 경로다. Terminal은 선택적인 보조 경로다.

~~~mermaid
flowchart LR
  m10_start["시작: 프로젝트·폴더"]
  m10_tree["파일 트리·검색"]
  m10_editor["편집기·뷰어"]
  m10_changes["working changes"]
  m10_diff["변경사항 비교"]
  m10_review["사람의 수락·거부·부분 수락"]
  m10_saved["저장된 파일 revision"]
  m10_end["끝: build·test·검사 결과"]
  m10_terminal["선택적 Terminal"]

  m10_start -. "Q-CODE-01 · Q-CODE-07" .-> m10_tree
  m10_tree --> m10_editor
  m10_editor -. "Q-CODE-06" .-> m10_changes
  m10_changes -. "Q-CODE-09" .-> m10_diff
  m10_diff -. "Q-CODE-04 · Q-CODE-09" .-> m10_review
  m10_review -. "Q-CODE-05" .-> m10_saved
  m10_saved -. "Q-CODE-03 · Q-CODE-08" .-> m10_end
  m10_start -. "Q-TERM-01 · Q-TERM-04" .-> m10_terminal
  m10_terminal --> m10_end
~~~

### M11. Managed Ontology → Agent cycle → evidence

Ontology view는 관리 모델과 기록된 실행의 projection일 뿐, 그 UI 자체가 Ontology는 아니다.

~~~mermaid
flowchart LR
  m11_start["시작: managed Ontology version"]
  m11_binding["System Run binding"]
  m11_cycle["Agent cycle"]
  m11_transition["검증된 상태 전환"]
  m11_evidence["수락된 evidence"]
  m11_projection["검사 projection"]
  m11_view["끝 A: Ontology view<br/>검사 전용"]
  m11_govern["끝 B: 제안·검토·승격·롤백"]

  m11_start --> m11_binding
  m11_binding --> m11_cycle
  m11_cycle --> m11_transition
  m11_transition --> m11_evidence
  m11_start --> m11_projection
  m11_evidence --> m11_projection
  m11_projection --> m11_view
  m11_view -. "Q-ONT-03 · Q-ONT-05" .-> m11_govern
  m11_govern -. "Q-ONT-03 · Q-ONT-05" .-> m11_start
~~~

### M12-L. Local computer-use → Desk-visible observation → independent verification

로컬 제품 사용자는 서버·협업 인프라 없이도 Desk 안에서 Desk 밖 행동의 대상,
현재 제어자, 포커스, 행동 진행과 결과 검증을 볼 수 있어야 한다.

~~~mermaid
flowchart LR
  m12l_start["시작: local computer-use 요청"]
  m12l_scope["대상·앱/창·범위 검토"]
  m12l_owner["사람·Agent 입력 소유자"]
  m12l_action["Desk 밖 행동"]
  m12l_observe["Desk-visible local observation"]
  m12l_control["pause·stop·긴급 중지"]
  m12l_verify["독립 결과 검증"]
  m12l_end["끝: 제어권 해제·검증 상태"]

  m12l_start -. "Q-CU-01 · Q-CU-05" .-> m12l_scope
  m12l_scope -. "Q-CU-02 · Q-CU-03 · Q-CU-06" .-> m12l_owner
  m12l_owner --> m12l_action
  m12l_action -. "Q-CU-09" .-> m12l_observe
  m12l_observe --> m12l_control
  m12l_control --> m12l_verify
  m12l_verify -. "Q-CU-08" .-> m12l_end
~~~

### M12-R. Shared Desk → collaborator permission → optional remote observation

원격 협업은 신원·권한·현재 가능한 행동과 원격 관찰·제어 승인을 분리한다.

~~~mermaid
flowchart LR
  m12r_start["시작: 공유할 Desk 범위"]
  m12r_invite["초대 초안·전달"]
  m12r_collab["collaborator 신원·수락"]
  m12r_permission["permission grant"]
  m12r_available["현재 가능한 행동"]
  m12r_shared["공유 리소스 행동"]
  m12r_remote["선택적 원격 관찰·제어"]
  m12r_end["끝: 귀속·전달·결과 증거"]

  m12r_start -. "Q-COL-01 · Q-COL-08" .-> m12r_invite
  m12r_invite ==>|"A-INFRA-01"| m12r_collab
  m12r_collab -. "Q-COL-02 · Q-COL-07" .-> m12r_permission
  m12r_permission --> m12r_available
  m12r_available --> m12r_shared
  m12r_shared ==>|"Q-CU-04 · Q-CU-07 · A-INFRA-02"| m12r_remote
  m12r_remote --> m12r_end
~~~

### M13. Local settings / export / restore vs remote sync / backup

로컬 산출물 생성, 복원 결과, 원격 승인, provider 실행, 원격 성공 증거를 각각 구분한다.

~~~mermaid
flowchart LR
  m13_start["시작: local settings"]
  m13_state["local EG-Desk data·state"]
  m13_export["local export·backup artifact"]
  m13_export_check["artifact 검증"]
  m13_restore["restore·import 실행"]
  m13_restore_evidence["끝 A: 복원 결과 증거"]
  m13_remote_request["remote sync·backup 요청"]
  m13_remote_execute["provider 실행 상태"]
  m13_remote_evidence["끝 B: 원격 결과 증거"]

  m13_start --> m13_state
  m13_state -. "Q-DATA-02 · Q-DATA-07" .-> m13_export
  m13_export --> m13_export_check
  m13_export_check -. "Q-DATA-03 · Q-DATA-08" .-> m13_restore
  m13_restore --> m13_restore_evidence
  m13_state -. "Q-DATA-05 · Q-DATA-09" .-> m13_remote_request
  m13_remote_request ==>|"A-INFRA-03"| m13_remote_execute
  m13_remote_execute --> m13_remote_evidence
~~~

### M14. Agenda 생성·열기·갱신·수명주기

Agenda의 의도적 영속화만 저장된 Agenda를 만든다. 단순 view 열기나 자동 세션 기록은 이 map에 쓰기 edge를 갖지 않는다.

~~~mermaid
flowchart LR
  m14_start["시작: Desk의 작업 의도·명시적 선택"]
  m14_draft["Agenda draft"]
  m14_saved["saved Agenda revision"]
  m14_row["Sidebar Agenda row"]
  m14_open["열린 Agenda projection"]
  m14_update["다른 이름으로 저장 / 업데이트"]
  m14_archive["archive·close 상태"]
  m14_delete["delete 확인·제거"]
  m14_end["끝: 복구됨 또는 영구 부재"]

  m14_start -. "Q-AG-01 · Q-AG-13" .-> m14_draft
  m14_draft -. "Q-AG-02 · Q-AG-10" .-> m14_saved
  m14_saved --> m14_row
  m14_row -. "Q-AG-03 · Q-AG-04 · Q-AG-05 · Q-AG-06" .-> m14_open
  m14_open -. "Q-AG-07 · Q-AG-08 · Q-AG-14 · Q-AG-15 · Q-AG-16 · Q-AG-17" .-> m14_update
  m14_update --> m14_saved
  m14_row -. "Q-AG-09 · Q-AG-11 · Q-AG-19" .-> m14_archive
  m14_archive -. "Q-AG-19" .-> m14_row
  m14_row -. "Q-AG-12 · Q-AG-20" .-> m14_delete
  m14_delete -. "Q-AG-12 · Q-AG-20" .-> m14_end
~~~

### M15. Canvas view 배치·탐색·Library 후보

공간 조작, 검색, Library 후보, 대상 열기/포커스는 서로 다른 상호작용이다.

~~~mermaid
flowchart LR
  m15_start["시작: Canvas viewport"]
  m15_view["active view"]
  m15_geometry["이동·크기·포커스"]
  m15_lifecycle["그룹·최대화·닫기"]
  m15_session["자동 세션 geometry"]
  m15_search["검색 표면"]
  m15_results["검색 결과"]
  m15_library["Library 후보"]
  m15_end["끝: 대상 focus·open"]

  m15_start --> m15_view
  m15_view -. "Q-VIEW-04" .-> m15_geometry
  m15_geometry -. "Q-VIEW-05 · Q-VIEW-06 · Q-VIEW-07 · Q-VIEW-10 · Q-VIEW-12 · Q-VIEW-13" .-> m15_lifecycle
  m15_lifecycle --> m15_session
  m15_start -. "Q-VIEW-08 · Q-DISC-01 · Q-DISC-03" .-> m15_search
  m15_search -. "Q-DISC-02" .-> m15_results
  m15_library -. "Q-OBJ-05 · Q-LIB-01" .-> m15_results
  m15_results -. "Q-DISC-02" .-> m15_end
  m15_end --> m15_view
~~~

### M16. Agent 담당자 방 / 대화 재진입 / 공유 작업 대화 후보

Agent 담당자 방을 여는 것과 Agent task를 시작하는 것은 다르며, 방의 일부 컨텍스트를
공유 작업 대화로 옮길 때는 명시적 공유 관계가 필요하다.

~~~mermaid
flowchart LR
  m16_start["시작: Chat entry"]
  m16_conversation["Agent room projection"]
  m16_draft["composer draft"]
  m16_request["submitted request"]
  m16_binding["System Run binding"]
  m16_agent["Agent work"]
  m16_answer["Answer projection"]
  m16_reentry["끝 A: persisted·re-entered conversation"]
  m16_thread["끝 B: 공유 대화<br/>참여자·공개 범위·선택 Agenda 참조"]

  m16_start -. "Q-CHAT-01 · Q-CHAT-02" .-> m16_conversation
  m16_conversation --> m16_draft
  m16_draft -. "Q-AI-02 · Q-AI-10" .-> m16_request
  m16_request --> m16_binding
  m16_binding --> m16_agent
  m16_agent --> m16_answer
  m16_answer -. "Q-CHAT-03" .-> m16_reentry
  m16_conversation -. "Q-OBJ-06 · Q-AI-06 · Q-AI-13" .-> m16_thread
  m16_thread -. "Q-AI-12 · Agent에게 요청·위임" .-> m16_request
~~~

### M17. Optional Terminal lifecycle

Terminal view, transport 연결, process 동일성·생존, 재진입 분류를 합치지 않는다.

~~~mermaid
flowchart LR
  m17_start["시작: optional Terminal entry"]
  m17_view["Terminal view"]
  m17_transport["transport connection"]
  m17_process["process identity·liveness"]
  m17_action["close·detach·terminate·background·snapshot"]
  m17_end["끝: verified reconnect / new process / snapshot / unavailable"]

  m17_start -. "Q-TERM-01 · Q-TERM-04" .-> m17_view
  m17_view --> m17_transport
  m17_transport --> m17_process
  m17_process -. "Q-TERM-02 · Q-TERM-05" .-> m17_action
  m17_action -. "Q-TERM-03 · Q-RESTORE-04" .-> m17_end
~~~

### M18. Canvas annotation: 시각 표식과 위치 메모

시각 표식과 Canvas Memo는 원본 콘텐츠나 Briefing Comment가 아니다. Memo의 사용자 본문,
Agent의 짧은 답글과 필요한 경우 생성되는 Agent 방 reference도 서로 구분된다.

~~~mermaid
flowchart LR
  m18_start["시작: Canvas target"]
  m18_input["draw / Memo 작성 / Agent request"]
  m18_draft["visual mark 또는 anchored Memo"]
  m18_provenance["작성자·Agent provenance"]
  m18_accept["표식 직접 저장 / 제안의 수락·기각 / Memo 답글"]
  m18_persist["persistence scope"]
  m18_end["끝: 재진입 / Agent room reference / target-missing"]

  m18_start -. "Q-MEDIA-13" .-> m18_input
  m18_input --> m18_draft
  m18_draft --> m18_provenance
  m18_draft -. "Q-MEDIA-13" .-> m18_accept
  m18_provenance --> m18_accept
  m18_accept -. "Q-MEDIA-06 · Q-MEDIA-13" .-> m18_persist
  m18_persist -. "Q-MEDIA-06 · Q-MEDIA-13" .-> m18_end
~~~

### M19. Keyboard / focus / nonvisual and reduced-motion path

접근성은 별도 성공 경로가 아니라 모든 핵심 행동과 같은 상태 전환을 실행하는 동등 경로다.

~~~mermaid
flowchart LR
  m19_start["시작: keyboard navigation map"]
  m19_focus["현재 focus target"]
  m19_owner["input owner"]
  m19_control["control activation"]
  m19_system["동일 System action"]
  m19_alt["비시각·reduced-motion projection"]
  m19_end["끝: 상태 피드백과 다음 행동"]

  m19_start -. "Q-UX-04" .-> m19_focus
  m19_focus -. "Q-UX-02" .-> m19_owner
  m19_owner -. "Q-UX-01 · Q-UX-04" .-> m19_control
  m19_control --> m19_system
  m19_system --> m19_end
  m19_system -. "Q-UX-03" .-> m19_alt
  m19_alt --> m19_end
~~~

## 3. 제품 행위자와 책임

### 3.1 제품 안의 행위자

| 행위자 | 제품에서 하는 일 | 하지 않는 일 |
|---|---|---|
| **제품 사용자** | Desk에서 보고, 입력하고, 요청하고, 범위를 수정하고, 결과와 증거를 검토하며, 필요한 외부 권한 확대를 승인·거부·보류한다. | 모든 내부 실행마다 승인하지 않는다. 화면에 보인 상태만으로 저장·전송·완료를 추정할 책임을 지지 않는다. |
| **System** | Firefox 셸을 시작하고, Desk와 저장 상태를 하이드레이션하며, 컨텍스트를 결합하고, 권한과 정책을 강제하고, Agent를 스케줄링하며, 화면 투영·지속성·복구·감사를 관리한다. | 추론하는 Agent로 가장하지 않는다. 로딩, 복원, 렌더링, 상태 전환 또는 권한 확인을 Agent 작업으로 기록하지 않는다. |
| **Agent 실행체** | 특정 Run에 결합된 프로필, 컨텍스트 리비전, 위임, 실제 계정·리소스 권한, 승인 및 실행 제한 안에서 추론하고 도구를 사용하며 결과와 증거를 반환한다. | Profile만으로 권한을 얻지 않는다. Desk 전체를 암묵적으로 읽지 않으며, 자신의 출력으로 실행 성공이나 외부 사실을 스스로 인증하지 않는다. |

제품 사용자는 사람을 뜻한다. 협업 참가자도 제품 사용자가 될 수 있지만, 공유된
범위와 역할 안에서만 행동한다. Agent 실행체는 사람이나 System의 별칭이 아니며,
한 Run에서 실제로 동작하는 실행 행위자다.

## 4. 제품 요소 참고 사전

이 절의 ID namespace는 의미가 다르다.

- `OBJ-*`: System이 동일성·상태·관계를 구분해 다루는 제품 요소다. 화면에
  독립 객체로 보이는지 여부는 각 카드가 설명한다.
- `AFF-*`: 다른 제품 요소로 이동하거나 행동을 시작시키는 비객체 UI
  어포던스다. 독립 저장·권한·수명주기를 갖지 않는다.

### 4.1 제품 셸, 작업면과 지속성

<a id="atlas-obj-001"></a>
#### OBJ-001 — EG-Desk

- **ID**: `OBJ-001`
- **제품 상태**: `확정`
- **무엇인가 / 아닌가**: Firefox 셸 위에서 Desk, Browser, Canvas, Chat과 Agent 작업을 연결하는 제품이다. 폴더 관리자, 단일 브라우저 프로필 또는 Chat 래퍼가 아니다.
- **제품 사용자가 보는·하는 것**: 앱을 실행하면 실제 Desk에서 작업을 시작하고, 리소스를 열고, 대화하고, 결과와 증거를 검토한다.
- **System 책임**: 셸 시작, 상태 하이드레이션, 입력·포커스 전달, 지속성, 복구, 권한 강제와 화면 투영을 담당한다.
- **Agent 관계**: Agent는 EG-Desk 안에서 Run 단위로 호출되지만 제품 셸 자체가 Agent는 아니다.
- **수명주기·복구**: 실행, 사용 가능, 기능 저하, 종료와 재진입을 구분하며, 셸 실패가 저장된 Agenda나 로컬 데이터를 삭제하지 않는다.
- **관련 trace / question**: `L-01`–`L-03`, `UX-01`; `Q-LIFE-01`–`Q-LIFE-05`, `Q-UX-01`–`Q-UX-04`.

<a id="atlas-obj-002"></a>
#### OBJ-002 — Desk

- **ID**: `OBJ-002`
- **제품 상태**: `확정`
- **무엇인가 / 아닌가**: 현재 실행 중인 하나의 작업 표면이다. Agenda, 프로젝트, Browser 프로필, 폴더, `Workspace` 또는 여러 작업을 나누기 위한 복수 인스턴스가 아니다.
- **제품 사용자가 보는·하는 것**: Canvas와 Sidebar를 통해 열린 뷰를 배치·탐색하고 현재 작업을 계속한다.
- **System 책임**: 실제 Desk를 첫 화면으로 만들고 하나의 Canvas를 제공하며, 자동 세션에서 표현 상태를 복원하고 리소스별 기능 저하를 격리한다.
- **Agent 관계**: Agent는 명시적으로 결합된 Desk 컨텍스트만 사용한다. Desk 전체가 기본 컨텍스트나 권한이 되지 않는다.
- **수명주기·복구**: 실행 중 활성 상태와 자동 복구 상태를 가지며 저장된 Agenda 수명주기와 분리된다. 여러 Saved Agenda를 같은 Canvas에 열어도 Desk가 추가되지 않는다.
- **관련 trace / question**: `L-01`–`L-03`, `AG-02`, `V-01`–`V-03`; `Q-OBJ-01`, `Q-AG-06`, `Q-RESTORE-01`–`Q-RESTORE-08`.

<a id="atlas-obj-003"></a>
#### OBJ-003 — Canvas

- **ID**: `OBJ-003`
- **제품 상태**: `상세 설계 기준선` — Desk당 하나의 Canvas와 표현 복원이 정의되어 있다. 그룹의 세션·Agenda 보존 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 하나의 Desk에 하나씩 속하며 뷰, 여러 Agenda projection, 시각 표현, 주석과 Answer Briefing을 공간적으로 다루는 작업 영역이다. Answer 자체, Ontology 모델 또는 단순 이미지 배경이 아니다.
- **제품 사용자가 보는·하는 것**: 뷰를 이동·크기 조절·그룹화하고, 패닝·확대·축소하며, 결과와 주석을 탐색한다.
- **System 책임**: 지오메트리, 뷰포트, 포커스, 선택, Agenda·view projection과 접근 가능한 대체 표현을 관리한다. 의미 있는 활성·sleeping·snapshot 작업마다 다시 찾을 수 있는 표현을 유지한다.
- **Agent 관계**: Agent는 요청받은 Canvas 표현이나 시각 주석을 제안할 수 있지만 포커스·하이드레이션·렌더링은 System 작업이다.
- **수명주기·복구**: Canvas·View·runtime 수명은 별개다. viewport 밖 이동은 종료·sleep이 아니며 renderer를 분리해도 다시 찾을 표현은 남는다. 카메라는 기기별로 복원하고 Agenda에는 선택한 구성·배치를 저장한다. 그룹 보존과 당시 자료 포함은 각각의 정책을 따른다.
- **관련 trace / question**: `V-02`, `V-03`, `AI-04`, `AI-05`, `CANVAS-01`; `Q-OBJ-02`, `Q-VIEW-04`–`Q-VIEW-08`, `Q-MEDIA-01`–`Q-MEDIA-13`.

<a id="atlas-obj-004"></a>
#### OBJ-004 — Sidebar

- **ID**: `OBJ-004`
- **제품 상태**: `상세 설계 기준선` — Saved Agenda 목록·찾기·보관함·휴지통과 좁은 창의 서랍 경로가 있다. Library 제공 여부는 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 저장된 Agenda 목록을 제공하는 Desk의 영역이다. 모든 리소스의 정본 카탈로그나 `Workspace` 트리가 아니다.
- **제품 사용자가 보는·하는 것**: 저장된 Agenda 행을 찾고 열며, 허용된 수명주기 행동에 진입한다.
- **System 책임**: Agenda 메타데이터를 Agent 없이 불러오고, 읽기 실패를 Desk 전체 실패와 분리해 표시한다.
- **Agent 관계**: Sidebar를 표시하거나 Agenda 행을 선택하는 일은 Agent 작업을 시작하지 않는다.
- **수명주기·복구**: 앱 재진입 시 저장된 Agenda 행을 열지 않은 상태로 다시 보여 준다. 목록 실패에는 재시도와 계속 가능한 Desk 경로가 필요하다.
- **관련 trace / question**: `L-01`, `L-02`, `AG-02`, `AG-04`; `Q-LIFE-04`, `Q-RESTORE-06`, `Q-AG-03`, `Q-AG-04`, `Q-AG-09`, `Q-AG-19`, `Q-AG-20`.

<a id="atlas-obj-005"></a>
#### OBJ-005 — Agenda

- **ID**: `OBJ-005`
- **제품 상태**: `상세 설계 기준선` — 명시적 구성 저장·다중 projection·revision·충돌 경로가 있다. 당시 자료 포함·이력 복구·실행 유지 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 이름과 명시적으로 선택한 자료·대화 범위·Memo·결과·annotation·실행 환경 참조를 저장하는 재사용 가능한 작업 결합이다. 빈 구성도 가능하며 당시 원문 사본 포함은 정책과 권한을 따른다. credential·살아 있는 process·임의 명령은 저장 payload가 아니다. 폴더·Chat방·자동 복구 기록과 다르다. 관련: `Q-AG-02`, `Q-AG-08`.
- **제품 사용자가 보는·하는 것**: Agenda를 생성하고 범위를 확인해 저장하며, 열고, 업데이트하고, 이름 변경·보관·삭제·복구한다.
- **System 책임**: 이름·선택 집합·revision·권한을 검증하고 명시적 저장으로만 구성 revision을 만든다. 열기는 같은 Canvas의 기존 projection을 찾거나 새 projection을 추가하며 실행을 자동 재개하지 않는다. 관련: `Q-AG-02`, `Q-AG-08`.
- **Agent 관계**: Agenda는 Agent 컨텍스트의 한 입력이 될 수 있지만 Agent를 자동 실행하거나 계정·리소스 권한을 부여하지 않는다.
- **수명주기·복구**: 업데이트는 같은 ID의 새 revision, 다른 이름 저장은 새 ID다. 닫기는 전용 실행의 종료 확인 뒤 projection을 제거하고 저장본을 유지한다. 보관은 목록 분류만 바꾼다. 삭제·복구는 선택된 보존 정책을 따르며 권한·예약·실행을 자동 복원하지 않는다.
- **관련 trace / question**: `AG-01`–`AG-04`; `Q-OBJ-04`, `Q-AG-01`–`Q-AG-17`, `Q-AG-19`, `Q-AG-20`.

<a id="atlas-obj-006"></a>
#### OBJ-006 — 저장된 Agenda

- **ID**: `OBJ-006`
- **제품 상태**: `상세 설계 기준선` — Agenda의 저장 상태이며 독립 객체 유형이 아니다. 보관·삭제·revision 경로가 있고 보존·복구 범위는 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 사용자가 의도적으로 영속화해 Sidebar에 나열되는 Agenda다. Agenda와 별개의 새 객체 유형이나 자동 Desk 세션의 별칭이 아니다.
- **제품 사용자가 보는·하는 것**: 행을 열고, 저장된 범위와 이후 미저장 변경을 구분하며, 수명주기 행동을 수행한다.
- **System 책임**: 메타데이터와 리비전을 보존하고, 명시적 열기 전에는 Desk에 자동 마운트하지 않는다.
- **Agent 관계**: 행이 보이거나 선택되었다는 사실만으로 Agent가 시작되거나 그 내용을 읽을 수 없다.
- **수명주기·복구**: 최초 저장, 업데이트 또는 새 항목 저장을 구별하고, 재시작 후 목록을 독립적으로 복구한다.
- **관련 trace / question**: `L-02`, `AG-01`–`AG-04`; `Q-AG-03`–`Q-AG-17`, `Q-AG-19`, `Q-AG-20`.

<a id="atlas-obj-007"></a>
#### OBJ-007 — 자동 Desk 세션 기록

- **ID**: `OBJ-007`
- **제품 상태**: `런타임 내부`
- **무엇인가 / 아닌가**: 열어 둔 뷰와 결정된 표현 상태를 다음 실행에 재구성하기 위한 로컬 연속성 기록이다. Agenda, 사용자 저장, 정본 작업 리비전 또는 정상 시작용 복구 목록이 아니다.
- **제품 사용자가 보는·하는 것**: 보통 기록 자체를 조작하지 않고, 재실행 후 복원된 Desk와 리소스별 실패 상태를 본다.
- **System 책임**: 캡처 주기와 트랜잭션 경계에서 검증 가능한 기록을 쓰고, 재시작 전에 유효성을 검사한다.
- **Agent 관계**: 캡처, 플러시, 검증과 복원에 Agent가 관여하지 않는다.
- **수명주기·복구**: 생성·갱신·플러시·검증·대체·폐기될 수 있다. 마지막 유효 기록만 복원 입력이 되며 손상은 저장된 Agenda에 전파되지 않는다.
- **관련 trace / question**: `L-02`, `L-03`; `Q-RESTORE-01`–`Q-RESTORE-08`.

<a id="atlas-obj-008"></a>
#### OBJ-008 — view / 뷰 인스턴스

- **ID**: `OBJ-008`
- **제품 상태**: `화면 설계 기준선` — 이동 가능한 활성 화면의 공통 명칭은 View(뷰)다.
- **무엇인가 / 아닌가**: 리소스를 한 위치와 권한 컨텍스트에서 마운트해 보여 주는 하나의 표현 인스턴스다. 기반 리소스, 런타임, 프로세스 또는 Agenda 구성원 자체가 아니다.
- **제품 사용자가 보는·하는 것**: 열고, 포커스하고, 이동·크기 조절·그룹화·최대화·닫기를 수행한다.
- **System 책임**: 인스턴스를 생성·재사용·포커스하고 리소스 런타임과 연결하며 지오메트리와 입력 소유권을 관리한다. viewport 가시성과 별도로 view·runtime lifecycle을 판단하고 무거운 renderer를 분리할 때도 다시 찾을 수 있는 Canvas 표현을 남긴다.
- **Agent 관계**: 사용자가 Agent 요청을 하지 않는 한 뷰 조작에 Agent가 관여하지 않는다.
- **수명주기·복구**: 생성, 활성, sleeping, snapshot, renderer 분리, 최대화, 닫힘, 재구성, 사용 불가 상태가 가능하다. viewport 밖 이동은 상태 전이가 아니며 닫기와 기반 런타임 종료도 별도다. File view 재진입에서는 scroll·보이는 위치를 복원할 수 있지만 active caret·keyboard focus·transient selection은 복원하지 않는다.
- **관련 trace / question**: `V-01`–`V-03`, `L-02`, `L-03`; `Q-OBJ-03`, `Q-VIEW-01`–`Q-VIEW-13`.

<a id="atlas-obj-009"></a>
#### OBJ-009 — Card

- **ID**: `OBJ-009`
- **제품 상태**: `표현 형식 기준선` — 간결한 View·결과 표현이며 별도 제품 객체 수명을 만들지 않는다.
- **무엇인가 / 아닌가**: View나 결과·스냅샷을 간결하게 표시하는 표현 형식이다. 접힌 View에만 한정하지 않으며 별도의 리소스·저장·실행 identity나 Agenda를 뜻하지 않는다.
- **제품 사용자가 보는·하는 것**: 작은 표현을 열어 연결된 View·결과를 확인하고 원 위치로 돌아온다.
- **System 책임**: 이름과 무관하게 뷰 인스턴스·리소스·런타임의 식별을 분리한다.
- **Agent 관계**: Agent는 위임된 답변 구성에서 간결한 표현을 제안하며 System이 실제 View·Answer·산출물에 연결한다.
- **수명주기·복구**: 표현을 접고 펴는 것과 기반 View·결과·runtime의 수명은 구분한다. 실제 연결 대상의 보존·권한·종료 상태를 따른다.
- **관련 trace / question**: `V-01`, `V-02`, `AI-04`; `Q-OBJ-03`, `Q-VIEW-02`, `Q-MEDIA-01`, `Q-MEDIA-02`.

<a id="atlas-obj-010"></a>
#### OBJ-010 — Desk Window

- **ID**: `OBJ-010`
- **제품 상태**: `이전 명칭` — 현재 화면 명칭은 View(뷰)다.
- **무엇인가 / 아닌가**: 이동·크기 조절 가능한 View를 가리키던 이전 명칭이다. 별도 실행 객체, 운영체제 창 또는 Desk 자체를 뜻하지 않는다.
- **제품 사용자가 보는·하는 것**: View로 열고 이동·크기 조절·집중 보기·닫기를 사용한다.
- **System 책임**: 창 이름과 관계없이 표현 인스턴스와 기반 런타임의 상태를 따로 관리한다.
- **Agent 관계**: Agent는 위임된 결과 표현을 제안할 수 있지만 View의 생성·포커스는 System 책임이다.
- **수명주기·복구**: 뷰 수명주기를 따르되 운영체제 창과의 일대일 관계를 전제하지 않는다.
- **관련 trace / question**: `V-01`, `V-02`, `ONT-01`; `Q-OBJ-03`, `Q-VIEW-04`–`Q-VIEW-07`.

### 4.2 리소스, 출처, 증거와 Browser 권한

<a id="atlas-obj-011"></a>
#### OBJ-011 — Resource

- **ID**: `OBJ-011`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: URL, 파일, 폴더, Browser 컨텍스트, 대화, 프로세스, 서비스 또는 산출물처럼 열거나 참조하거나 실행에 연결할 수 있는 대상이다. 뷰 인스턴스, source, evidence 또는 권한과 동일하지 않다.
- **제품 사용자가 보는·하는 것**: 대상과 유형, 위치, 현재 접근 가능성을 확인하고 적절한 뷰로 열거나 포커스한다.
- **System 책임**: 로케이터, 콘텐츠 리비전, 권한 컨텍스트, 중복 관계와 런타임 연결을 각각 관리한다.
- **Agent 관계**: Agent는 Run 컨텍스트에 명시적으로 포함되고 권한상 허용된 Resource만 사용할 수 있다.
- **수명주기·복구**: 존재, 이동, 변경, 오프라인, 권한 거부, 누락, 복구 상태를 가질 수 있으며 뷰 복원과 독립적이다.
- **관련 trace / question**: `V-01`–`V-03`, `TOOL-01`, `TOOL-02`; `Q-VIEW-01`–`Q-VIEW-03`, `Q-VIEW-09`, `Q-AUTH-04`.

<a id="atlas-obj-012"></a>
#### OBJ-012 — runtime / process / transport

- **ID**: `OBJ-012`
- **제품 상태**: `런타임 내부`
- **무엇인가 / 아닌가**: Resource를 실제로 작동시키는 bridge, helper, transport, provider conversation, process와 이를 보여 주는 view의 개별 상태다. 이 계층들은 서로의 별칭이 아니며 저장된 Agenda가 아니다.
- **제품 사용자가 보는·하는 것**: 필요한 경우 연결됨, 재구성됨, 새로 실행됨, 스냅샷 전용, 사용 불가 같은 정직한 상태와 마지막 확인 시각, 다음 행동을 본다.
- **System 책임**: 각 계층의 식별자와 health를 따로 검증하고 연결·재연결·재실행·종료를 구분한다. 장애 원인은 증거가 생기기 전까지 미확정으로 두고 관찰 사실, 후보 원인과 `last checked`를 분리한다.
- **Agent 관계**: Agent가 도구를 사용하는 동안 이 계층을 사용할 수 있지만, 수명주기 소유자는 System과 해당 리소스 런타임이다.
- **수명주기·복구**: 각 계층은 독립적으로 살아 있거나 끊길 수 있다. transport 복구는 동일 process나 provider conversation 복구의 증거가 아니며, view 재구성이나 새 process를 재연결이라고 부르지 않는다.
- **관련 trace / question**: `L-02`, `V-01`, `BROWSER-01`, `TERM-01`; `Q-RESTORE-04`, `Q-VIEW-07`, `Q-TERM-02`, `Q-TERM-03`.

<a id="atlas-obj-013"></a>
#### OBJ-013 — source

- **ID**: `OBJ-013`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 콘텐츠나 주장, 리소스가 어디에서 왔는지 설명하는 원천과 그 리비전·위치다. source의 존재만으로 주장이 참이거나 작업이 성공했다는 뜻은 아니다.
- **제품 사용자가 보는·하는 것**: 출처, 계정·프로필 컨텍스트와 콘텐츠 리비전을 구분해 확인하고 원천으로 이동한다.
- **System 책임**: 정본 리소스 식별, 로케이터, 리비전, 계보와 중복 관계를 보존한다.
- **Agent 관계**: Agent는 source를 인용·요약할 수 있으나 source 자체를 외부 효과의 완료 증거로 승격하지 않는다.
- **수명주기·복구**: 이동·변경·오프라인·접근 거부·최신 아님을 기록하며, 기존 결과와의 연결을 잃지 않는다.
- **관련 trace / question**: `TOOL-01`, `BROWSER-03`, `BROWSER-04`, `ONT-01`; `Q-AUTH-04`, `Q-AUTH-08`, `Q-ONT-02`.

<a id="atlas-obj-014"></a>
#### OBJ-014 — evidence

- **ID**: `OBJ-014`
- **제품 상태**: `확정`
- **무엇인가 / 아닌가**: 특정 대상, 행위자, 시점, 리비전과 주장 범위에 대해 관찰되거나 수신된 근거다. 클릭, 입력 재생, 스피너, `200` 응답 또는 Agent의 자기 보고만으로 완료 증거가 되지 않는다.
- **제품 사용자가 보는·하는 것**: 어떤 주장을 어디까지 뒷받침하는지, 출처와 시간, 최신성, 불일치·알 수 없음 상태를 검사한다.
- **System 책임**: evidence를 작업·결과·Ontology 전이와 연결하고, 증거가 지지하는 범위를 넘는 성공 상태를 만들지 않는다.
- **Agent 관계**: Agent는 증거를 수집·해석·제시할 수 있지만 자신의 출력만으로 증거를 승인하거나 외부 성공을 인증하지 않는다.
- **수명주기·복구**: 수집, 검증, 최신 아님, 반박, 접근 불가, 보존·삭제 상태를 가지며 원 주장과의 연결을 유지한다. acceptance evidence는 같은 전제의 반복 성공과 실패 뒤 복구를 다시 실행할 수 있어야 한다.
- **관련 trace / question**: `BROWSER-03`, `BROWSER-04`, `AI-06`, `ONT-01`, `ONT-02`, `CU-01`; `Q-BROWSER-02`, `Q-BROWSER-03`, `Q-ONT-02`, `Q-CU-08`.

<a id="atlas-obj-015"></a>
#### OBJ-015 — SourceRef

- **ID**: `OBJ-015`
- **제품 상태**: `런타임 내부`
- **무엇인가 / 아닌가**: source나 Resource를 가리키기 위한 현재의 참조 프리미티브다. 최종 제품 객체, 정본 전역 ID 또는 권한 모델로 간주하지 않는다.
- **제품 사용자가 보는·하는 것**: SourceRef 원형 자체보다 이해 가능한 출처, 위치, 리비전과 권한 컨텍스트를 본다.
- **System 책임**: 내부 참조를 해석하고 중복·이동·리비전 변화에도 안전한 제품 표현으로 투영한다.
- **Agent 관계**: Agent는 컨텍스트에서 참조를 받을 수 있지만 참조가 가리키지 않은 주변 데이터까지 읽을 수 없다.
- **수명주기·복구**: 생성·해결·최신 아님·누락·재연결 상태가 가능하며, 해결 실패를 새 source 생성으로 숨기지 않는다.
- **관련 trace / question**: `TOOL-01`, `V-01`; `Q-AUTH-04`, `Q-AUTH-08`, `Q-VIEW-03`.

<a id="atlas-obj-016"></a>
#### OBJ-016 — Browser

- **ID**: `OBJ-016`
- **제품 상태**: `확정`
- **무엇인가 / 아닌가**: Firefox 기반의 일급 작업 화면으로, 페이지 탐색과 계정·프로필별 행동을 Desk 안에서 수행한다. 단순 미리보기나 모든 계정을 합친 하나의 권한 주체가 아니다.
- **제품 사용자가 보는·하는 것**: URL과 페이지 상태를 확인하고 탐색·새로고침·중지·인증·다운로드·외부 효과를 수행하거나 Agent에게 위임한다.
- **System 책임**: Firefox 컨텍스트, 탐색 상태, 팝업·인증 복귀, 다운로드와 외부 효과 상태를 정확히 연결한다.
- **Agent 관계**: Agent는 명시된 Browser 컨텍스트와 위임 범위에서만 관찰·행동하며, DOM이나 화면 변화 뒤 결과를 다시 검증한다.
- **수명주기·복구**: 뷰, URL 기록, 인증 상태, 프로필·계정과 런타임이 서로 다른 범위로 복구될 수 있다.
- **관련 trace / question**: `TOOL-01`, `BROWSER-01`–`BROWSER-04`; `Q-AUTH-01`–`Q-AUTH-08`, `Q-BROWSER-01`–`Q-BROWSER-03`.

<a id="atlas-obj-017"></a>
#### OBJ-017 — Browser account/profile authority context

- **ID**: `OBJ-017`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 특정 Firefox 프로필·컨테이너·계정에서 현재 인증되고 허용된 행동의 범위다. 콘텐츠 동일성, Agent Profile, capability 또는 approval과 같지 않다.
- **제품 사용자가 보는·하는 것**: 현재와 대상 계정·프로필, 사용 가능한 행동과 전환 영향을 확인하고 인증·권한 복구에 진입한다.
- **System 책임**: 세션과 계정 신원을 검증하고 실제 가능한 행동을 계산하며, 전환이 콘텐츠 출처나 성공 상태를 바꾼 것처럼 표시하지 않는다.
- **Agent 관계**: Agent는 이 authority context가 허용하는 범위보다 넓게 행동할 수 없다. Profile이나 작업 위임은 부족한 계정 권한을 만들어 내지 못한다.
- **수명주기·복구**: 미인증, 인증 중, 유효, 만료, 거부, 계정 불일치, 철회 상태를 구분한다. 로그인 성공은 후속 외부 효과 성공이 아니다.
- **관련 trace / question**: `TOOL-01`, `BROWSER-02`, `AUTH-01`; `Q-AUTH-01`–`Q-AUTH-03`, `Q-AUTH-07`, `Q-ORCH-05`, `Q-ORCH-07`.

### 4.3 사람 중심 파일·코딩 화면

<a id="atlas-obj-018"></a>
#### OBJ-018 — project / folder view

- **ID**: `OBJ-018`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 사람이 작업 대상의 파일 구조와 범위를 탐색하는 프로젝트·폴더 화면이다. Agenda, Desk, `Workspace` 또는 권한을 자동 부여하는 경계가 아니다.
- **제품 사용자가 보는·하는 것**: `[파일▾] → [폴더 연결]`과 `[루트 추가]`로 허용된 위치를 연결하고 트리·검색에서 파일을 찾는다. 여러 PC·폴더를 포함할 수 있으며 각 root의 위치·권한을 구분한다.
- **System 책임**: 경로, 프로젝트 관계, 실제 파일 권한, 이동·삭제·외부 변경 상태를 읽어 투영한다.
- **Agent 관계**: Agent는 작업 위임과 실제 파일 권한이 겹치는 선택된 범위에서만 탐색·편집한다.
- **수명주기·복구**: 열림, 최근 대상, 누락, 이동, 읽기 전용, 권한 거부 상태를 가지며 뷰 복원과 파일 존재를 구분한다.
- **관련 trace / question**: `TOOL-02`, `CODE-01`; `Q-CODE-01`, `Q-CODE-02`, `Q-CODE-07`.

<a id="atlas-obj-019"></a>
#### OBJ-019 — file

- **ID**: `OBJ-019`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 로컬 또는 허용된 외부 저장소에 있는 콘텐츠 리소스와 특정 리비전이다. 편집기 버퍼, 뷰, 저장 성공 표시 또는 Agenda 자체가 아니다.
- **제품 사용자가 보는·하는 것**: 파일을 열고 읽거나 편집하며, 미저장·저장 중·저장됨·충돌 상태를 확인한다.
- **System 책임**: 파일 시스템 리비전, 권한, 외부 변경과 편집기 상태를 대조하고 성공한 저장만 영속 상태로 기록한다.
- **Agent 관계**: Agent 편집은 제안 또는 작업 파일 변경일 수 있으며, 사용자 검토·저장·검증 의미와 분리된다.
- **수명주기·복구**: 존재, 수정됨, 저장 중, 저장됨, 충돌, 이동, 삭제, 복구 불가 상태를 구분하고 미저장 내용을 실패 뒤 보존한다.
- **관련 trace / question**: `TOOL-02`, `CODE-01`, `BROWSER-03`; `Q-CODE-02`, `Q-CODE-05`, `Q-CODE-06`.

<a id="atlas-obj-020"></a>
#### OBJ-020 — editor / viewer

- **ID**: `OBJ-020`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 파일이나 지원 리소스를 사람이 읽고 편집하는 주된 코딩 화면이다. Terminal, 파일 자체 또는 저장 완료 증거가 아니다.
- **제품 사용자가 보는·하는 것**: 선택·입력·실행 취소·다시 실행하고, 읽기 전용·미지원·충돌·미저장 상태를 확인한다.
- **System 책임**: 뷰어와 편집 가능 모드를 구분하고 버퍼, 파일 리비전, 저장과 외부 변경을 동기화한다.
- **Agent 관계**: Agent 변경을 표시할 수 있지만 Agent의 내부 실행 UI를 사람용 편집 경험에 강제로 노출하지 않는다.
- **수명주기·복구**: 뷰 인스턴스와 편집 버퍼, 기반 파일은 각각 복구 범위가 다르며 누락된 파일에는 명시적 다음 행동이 필요하다.
- **관련 trace / question**: `TOOL-02`, `CODE-01`; `Q-CODE-01`, `Q-CODE-02`, `Q-CODE-05`, `Q-CODE-06`.

<a id="atlas-obj-021"></a>
#### OBJ-021 — change comparison

- **ID**: `OBJ-021`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 현재안과 제안안 또는 기준 리비전 사이의 변경을 검토하는 사람용 비교 화면이다. 파일 저장, Agent 승인 또는 실행 취소 그 자체가 아니다.
- **제품 사용자가 보는·하는 것**: 파일·변경 묶음을 탐색하고 수락·거부·되돌리기·부분 수락·계속의 효과를 검토한다.
- **System 책임**: 정확한 기준과 대상 리비전을 고정하고, 최신 아님·충돌·적용 실패를 표시하며 선택한 변경만 적용한다.
- **Agent 관계**: Agent가 만든 변경도 같은 비교·귀속·증거 경계를 따른다. Agent는 자신의 변경을 스스로 최종 승인하지 않는다.
- **수명주기·복구**: 제안됨, 일부 적용, 적용됨, 기각, 최신 아님, 충돌 상태를 보존하고 재진입 시 같은 기준을 식별한다.
- **관련 trace / question**: `CODE-01`, `TOOL-02`; `Q-CODE-04`, `Q-CODE-09`.

<a id="atlas-obj-022"></a>
#### OBJ-022 — coding result

- **ID**: `OBJ-022`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 특정 대상·리비전·명령에 연결된 빌드, 테스트, 검사 또는 리뷰 결과다. 프로젝트 전체의 품질 보증이나 저장 성공을 자동으로 의미하지 않는다.
- **제품 사용자가 보는·하는 것**: 실행 대상과 범위를 확인하고 시작·취소·재시도하며 결과를 탐색·필터링한다.
- **System 책임**: 명령, 리비전, 실행 환경, 상태, 로그·증거 범위를 연결하고 녹색 표시가 증명하는 범위를 제한한다.
- **Agent 관계**: Agent가 검증을 실행·요약할 수 있지만 결과의 대상과 원 증거를 보존해야 한다.
- **수명주기·복구**: 대기, 실행 중, 중지, 실패, 부분, 완료, 최신 아님 상태가 가능하며 같은 리비전이 아니면 재사용을 경고한다.
- **관련 trace / question**: `CODE-01`; `Q-CODE-03`, `Q-CODE-08`.

<a id="atlas-obj-023"></a>
#### OBJ-023 — file picker

- **ID**: `OBJ-023`
- **제품 상태**: `상세 설계 기준선` — OS 선택·취소·권한·포커스 복귀를 가진 일시적 진입 UI다.
- **무엇인가 / 아닌가**: 파일·폴더·프로젝트 대상을 선택해 여는 일시적 UI다. 영속 카탈로그, 프로젝트 객체, Agenda, Library 또는 `Workspace`가 아니다.
- **제품 사용자가 보는·하는 것**: 위치와 대상을 탐색하고 선택·취소하며 필요한 권한 요청과 열기 결과를 확인한다.
- **System 책임**: 운영체제 또는 제품 선택기에서 반환된 대상을 검증하고, 취소와 권한 거부를 변경 없음으로 처리한다.
- **Agent 관계**: 사용자가 명시적으로 위임하지 않는 한 Agent가 선택기를 대신 조작하거나 주변 파일을 수집하지 않는다.
- **수명주기·복구**: 열림, 선택 중, 승인 대기, 취소, 실패, 완료 후 닫힘의 일시적 상태만 가지며 독립 복구 객체가 아니다.
- **관련 trace / question**: `TOOL-02`, `CODE-01`, `V-01`; `Q-CODE-07`, `Q-VIEW-01`, `Q-VIEW-11`.

### 4.4 대화, Agent와 실행 결과

<a id="atlas-obj-024"></a>
#### OBJ-024 — Chat

- **ID**: `OBJ-024`
- **제품 상태**: `상세 설계 기준선` — 담당자 방 안의 업무 목록·필터와 별도 공유 대화 경로가 있다. 기본 공개 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 특정 Agent/persona와 관계를 이어 가며 대화 입력과 Answer의 대화적으로 완결된 투영을 제공하는 화면이다. Agent Runtime, 전체 컨텍스트 저장소, Profile 설정 화면, 단순 완료 알림 또는 Canvas의 긴 본문 복제본이 아니다.
- **제품 사용자가 보는·하는 것**: Dock `[Chat]`에서 담당자·실제 작성자·업무 대상·컨텍스트·작성기를 구분한다. `[활동 N건]`에서 업무를 고르고 컨텍스트 항목으로 포함 범위를 고친다. 활동 열기는 실행 중 Browser·Terminal의 동일 Live 또는 완료된 읽기·명령의 Snapshot으로 이동한다. `[당시 관찰] [현재 조작면] [비교]`로 시점을 구분한다.
- **System 책임**: Agent 관계, 대화 투영과 초안, 메시지, Answer·Result·Task 연결을 불러오고 요청 전송 시에만 컨텍스트를 결합한다. 사용할 수 있는 Agent Profile이 없으면 같은 Chat view에서 설정 행동과 작성기 비활성 사유를 표시하며 Chat을 여는 행동 자체를 Agent Run으로 만들지 않는다. Chat의 상태 표시는 Canvas 정본을 복제하지 않고 reference한다.
- **Agent 관계**: Agent는 전송 뒤 Run 안에서 응답한다. Chat 표시만으로 Agent가 존재하거나 계속 실행 중이라고 추정하지 않는다.
- **수명주기·복구**: 대화·초안·첨부 참조·포함 설정·업무 연결·결과와 메시지 기준 스크롤을 복원한다. 첨부 byte는 허용된 보존본만 복원하고 없으면 다시 연결한다. IME 조합·일시 선택·입력 포커스는 복원하지 않으며 Chat 닫기는 실행 중지가 아니다.
- **관련 trace / question**: `CHAT-01`, `AI-01`–`AI-05`; `Q-CHAT-01`–`Q-CHAT-03`, `Q-AI-01`–`Q-AI-05`, `Q-MEDIA-01`–`Q-MEDIA-03`.

<a id="atlas-obj-025"></a>
#### OBJ-025 — Thread

- **ID**: `OBJ-025`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 여러 메시지를 엮는 대화 패턴을 가리키는 용어다. 현재 화면 경로는 담당자 방과 공유 대화이며, 모든 Chat·Run·Agenda 또는 Task마다 별도 Thread 객체를 만들지 않는다.
- **제품 사용자가 보는·하는 것**: `[방 목록]`에서 담당자 방·공유 대화를 열고 업무·참여자·공개 범위를 확인한다. 일반 공유 메시지의 `[전송]`과 `[Agent에게 요청]`을 구분한다.
- **System 책임**: 대화 식별자, 참여자, 개인정보 보호, Agenda 관계와 지속성을 명시적으로 관리한다.
- **Agent 관계**: Agent가 Thread에 참여할 수 있으나 참여 자체가 새 작업 권한이나 전체 대화 공유를 의미하지 않는다.
- **수명주기·복구**: 연결된 대화의 기록·초안·참조·재진입을 따르며 독립 Thread 수명주기를 추가하지 않는다. 화면 닫기·대화 기록 제거·Run 중지는 별도 행동이다.
- **관련 trace / question**: `AI-03`, `COL-01`; `Q-OBJ-06`, `Q-CHAT-01`, `Q-AI-06`, `Q-AI-12`, `Q-AI-13`.

<a id="atlas-obj-026"></a>
#### OBJ-026 — Agent room

- **ID**: `OBJ-026`
- **제품 상태**: `상세 설계 기준선` — 안정적인 담당자 identity, 같은 방의 여러 업무, 초안·기록 재진입이 정의되어 있다.
- **무엇인가 / 아닌가**: 안정적인 Agent ID와 지속적인 담당자 관계로 대화하는 기본 Chat 패턴이다. Profile은 별도 설정 참조이며 교체·재사용해도 방 identity를 합치지 않는다. Runtime·영구 모델 context·권한 원천이 아니다.
- **제품 사용자가 보는·하는 것**: 담당자 이름과 업무 대상을 확인해 요청한다. 메시지·기여·Memo의 `[⋯] → [공유 대화에 연결]`에서 대상 대화·참여자·본문·첨부 범위를 확인해 공유한다. 관련: `Q-OBJ-06`.
- **System 책임**: Agent identity·Profile revision·대화·업무 binding을 분리한다. `[활동 N건]`과 `[업무별 보기]`로 같은 방의 업무를 구분하며 방 전체를 모델 입력이나 공유 대화에 자동 복사하지 않는다. 관련: `Q-CHAT-01`.
- **Agent 관계**: 선택한 Profile을 사용하는 Run이 전송 뒤 생성될 수 있다. Profile 선택만으로 Agent가 실행되지는 않는다.
- **수명주기·복구**: 방·대화·업무 연결·초안을 다시 열 수 있다. Profile 중단·보관은 새 사용을 제한하지만 방·과거 Run을 삭제하지 않는다. Agenda 참조 변경·화면 닫기·업무 기록 삭제는 각각 별도다.
- **관련 trace / question**: `AI-03`, `CHAT-01`; `Q-OBJ-06`, `Q-AI-06`–`Q-AI-08`, `Q-AI-12`, `Q-AI-13`, `Q-AGENT-01`.

<a id="atlas-obj-027"></a>
#### OBJ-027 — 공유 작업 대화 capability

- **ID**: `OBJ-027`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 고유 conversation identity·참여자·공유 범위를 가진 `공유 대화`다. Agenda는 0개 이상의 탐색 참조이며 추가해도 소유·참여·실행 권한이 늘지 않는다. 개인 방의 자동 합본이나 별도 workroom·Task별 Thread가 아니다. 관련: `Q-OBJ-06`.
- **제품 사용자가 보는·하는 것**: `[방 목록] → [공유 대화]`에서 열거나 생성한다. 일반 `[전송]`은 사람 간 메시지이며 Agent 실행은 `[Agent에게 요청] → 담당자 → [위임]`으로 시작한다.
- **System 책임**: 공유된 메시지·컨텍스트와 작업 경계를 명시적으로 저장하고, DM이나 비공개 상태를 자동 유입하지 않는다.
- **Agent 관계**: 여러 Agent가 각자의 Run과 위임 범위에서 기여하며, 종합 결과와 개별 출처를 구분한다.
- **수명주기·복구**: 닫아도 목록에서 다시 연다. 선택 공개형은 확인한 revision만, 업무 공개형은 정한 시작 지점 이후 허용 사건을 연결한다. `[이후 공유 종료]`는 향후 공개만, `[공유 연결 철회]`는 기존 접근도 회수하며 외부 사본 회수는 보장하지 않는다.
- **관련 trace / question**: `AI-03`, `AI-06`, `COL-01`; `Q-OBJ-06`, `Q-AI-06`–`Q-AI-09`, `Q-AI-12`, `Q-AI-13`.

<a id="atlas-obj-028"></a>
#### OBJ-028 — Agent

- **ID**: `OBJ-028`
- **제품 상태**: `확정`
- **무엇인가 / 아닌가**: 한정된 Run 컨텍스트와 권한 안에서 추론하고 도구를 사용하는 실행 행위자다. Agent Profile, Chat의 표시 정체성, System 또는 사람과 동일하지 않다.
- **제품 사용자가 보는·하는 것**: 요청 대상과 contributor, 진행·대기·결과·실패, 사용한 범위, evidence와 integration result를 Desk에서 검사한다. raw Agent chatter나 숨은 추론을 읽을 필요는 없다.
- **System 책임**: Run을 생성하고 정확한 Profile 버전·컨텍스트·권한·제한을 바인딩해 Agent를 시작·중지·감사하며, 모든 Agent 제어 활동을 찾을 수 있는 Desk projection으로 집계한다.
- **Agent 관계**: 자신 또는 위임받은 하위 Agent에게 허용된 Task만 수행하며 권한을 스스로 확대하지 않는다.
- **수명주기·복구**: Agent 실행은 Run과 함께 시작·대기·중지·완료된다. 대화 재진입만으로 동일 실행체가 복구됐다고 주장하지 않는다.
- **관련 trace / question**: `AI-01`–`AI-07`, `AUTH-01`, `ONT-02`; `Q-AI-04`, `Q-AI-07`–`Q-AI-09`, `Q-ORCH-01`–`Q-ORCH-08`.

<a id="atlas-obj-029"></a>
#### OBJ-029 — Agent Runtime

- **ID**: `OBJ-029`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: Profile을 해석하고 제공자·모델·도구·컨텍스트·제한을 Run에 결합해 실제 Agent 실행을 구동하는 계층이다. Chat 내용, Profile 문서 또는 권한 원천이 아니다.
- **제품 사용자가 보는·하는 것**: 직접 내부 세션을 조작하기보다 준비됨·기능 저하·사용 불가와 Run 상태, 선택된 Profile·모델의 안전한 요약, 마지막 확인 시각을 본다.
- **System 책임**: 런타임을 초기화하고 현재 가용성을 계산하며 Run snapshot을 만들고 도구 호출·상태·감사를 Desk projection에 연결한다. bridge/helper/transport/provider conversation/process/view 장애 원인은 증거 전까지 미확정으로 둔다.
- **Agent 관계**: Agent는 Runtime 안에서 실행되며 Runtime이 정한 경계 밖의 도구·컨텍스트·네트워크를 사용할 수 없다.
- **수명주기·복구**: 준비 전, 준비됨, 기능 저하, 사용 불가, 중지 상태를 구분한다. 재시작 뒤 같은 제공자 세션 복구는 검증된 경우에만 표시한다.
- **관련 trace / question**: `AI-01`, `AI-06`, `AI-07`, `ONT-02`; `Q-AI-04`, `Q-AI-07`, `Q-AGENT-03`–`Q-AGENT-05`, `Q-AGENT-11`, `Q-AGENT-14`.

<a id="atlas-obj-030"></a>
#### OBJ-030 — Agent Profile

- **ID**: `OBJ-030`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: Agent의 성격, 지침, 정책, 제공자·모델 선택 규칙, 도구·위임 상한과 기본 실행 제약을 버전으로 묶은 설정이다. 실행체, 대화 내용, 자격 증명 또는 권한 부여가 아니다.
- **제품 사용자가 보는·하는 것**: 식별 가능한 Profile과 안전한 기능·제약 요약을 선택·검사하고, 편집이 허용되면 새 버전으로 제안·활성화한다.
- **System 책임**: 버전과 해시를 관리하고, 실제 가용성과 권한을 별도로 계산하며, Run 생성 시 선택된 버전을 고정한다.
- **Agent 관계**: Agent는 Profile을 실행 컨텍스트로 받지만 Profile의 상한을 실제 권한으로 해석하지 않는다.
- **수명주기·복구**: `[초안 저장]`과 `[활성화]`를 분리한다. 사용 중단·보관은 새 사용을 막고 기존 binding을 유지한다. 재활성화·복구는 기본값을 자동 복원하지 않는다. `[이전 revision으로 적용]`은 새 revision을 만들며 삭제 뒤 과거 payload 보존은 선택된 정책을 따른다.
- **관련 trace / question**: `AI-01`, `AI-03`, `AI-06`; `Q-AI-07`–`Q-AI-09`, `Q-AGENT-01`–`Q-AGENT-05`, `Q-AGENT-13`.

<a id="atlas-obj-031"></a>
#### OBJ-031 — Run

- **ID**: `OBJ-031`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 사용자 요청이나 위임을 실제 실행으로 만든 감사 가능한 실행 단위다. Chat 메시지, Agent Profile, Task 하나 또는 Answer와 반드시 일대일인 것은 아니다.
- **제품 사용자가 보는·하는 것**: Run의 범위, 상태, 컨텍스트 리비전, 담당 Agent, 제한, 결과와 다음 행동을 검사하고 중지·재시도·포크할 수 있다.
- **System 책임**: immutable snapshot과 상태 전이를 기록하고 Task·도구 호출·승인·Result·evidence를 연결한다.
- **Agent 관계**: Agent 실행체는 특정 Run 또는 그 하위 Task에 바인딩된다.
- **수명주기·복구**: Run 상태는 `binding/running/waiting/stopping/stopped/completed/failed`다. `partial`은 Result.completeness에만 기록한다. 일반 조정·대기 해소는 같은 Run·attempt를 유지하고 실패 재실행만 attempt를 늘린다. 완료·중지 뒤 명시적 계속은 같은 Run의 새 실행 구간이며 의도적 분기는 새 Run이다. 상세: [중앙 전이 계약](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration).
- **관련 trace / question**: `AI-01`, `AI-02`, `AI-06`, `AI-07`; `Q-OBJ-07`, `Q-AI-04`, `Q-AI-05`, `Q-ORCH-04`, `Q-AGENT-11`, `Q-AGENT-14`, `Q-AGENT-15`.

<a id="atlas-obj-032"></a>
#### OBJ-032 — Task

- **ID**: `OBJ-032`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: Run 안에서 책임자, 입력, 선행 조건, 완료 조건과 산출 범위를 가진 실행 가능한 작업 단위다. 사용자 요청 전체, Agent 정체성 또는 단순 대기 이벤트가 아니다.
- **제품 사용자가 보는·하는 것**: 제안된 분해, 담당자, 의존성, 상태와 비용·진행 정보를 제품이 정한 수준에서 보고 취소·재시도·재할당한다.
- **System 책임**: Task 그래프를 검증·예약하고 선행 조건, 권한과 Ontology 전이를 확인해 준비된 Task만 디스패치한다.
- **Agent 관계**: Agent는 배정된 Task 범위 안에서 기여하며 다른 Task의 권한이나 성공을 상속하지 않는다.
- **수명주기·복구**: Task는 `queued/waiting-on-dependency/ready/running/approval-required/completed/failed/cancelled`의 여덟 상태다. 실패 재시도는 같은 Task의 새 attempt, 완료·취소 후 재작업은 연결된 새 Task다. 중지 확인 전에는 기존 실행 상태와 stopRequested를 유지하며 부분 완전성은 Result에 기록한다. 상세: [중앙 전이 계약](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration).
- **관련 trace / question**: `AI-06`, `AI-07`; `Q-OBJ-07`, `Q-ORCH-01`, `Q-ORCH-02`, `Q-ORCH-04`, `Q-ORCH-08`, `Q-AGENT-15`.

<a id="atlas-obj-033"></a>
#### OBJ-033 — dependency state / Await condition

- **ID**: `OBJ-033`
- **제품 상태**: `런타임 내부`
- **무엇인가 / 아닌가**: 증거, 승인, 파일 도착, 로그인·사용자 행동 또는 선행 Task 완료 같은 조건이 충족됐는지 나타내는 스케줄러 상태다. 오케스트레이션 전체나 독립적인 `Await Token` 제품 객체가 아니다.
- **제품 사용자가 보는·하는 것**: 필요한 경우 무엇을 기다리는지, 누가 행동할 수 있는지, 어떤 분기만 차단되는지와 취소·대체 경로를 본다.
- **System 책임**: 조건을 검증하고 충족 evidence를 기록한 뒤 권한상 허용된 후속 Task만 자동 시작한다. Task가 `waiting-on-dependency`에 들어갈 때 scheduler checkpoint를 남기고 LLM stream을 열린 채 보존하지 않는다.
- **Agent 관계**: Agent는 조건을 보고할 수 있지만 임의로 충족 상태를 선언하거나 차단된 의존성을 우회하지 않는다.
- **수명주기·복구**: 내부 조건은 미충족, 충족, 만료, 철회, 실패, 대체됨으로 기록될 수 있다. 그 조건 때문에 멈춘 Task는 `waiting-on-dependency`, 승인 때문에 멈춘 Task는 `approval-required`로 투영한다. 재개는 checkpoint에서 조건과 권한을 다시 검증한 새 디스패치이며 장시간 열린 model stream의 연장이 아니다.
- **관련 trace / question**: `AI-06`, `AI-07`, `AUTH-01`; `Q-ORCH-01`–`Q-ORCH-05`, `Q-ORCH-07`, `Q-ORCH-08`.

<a id="atlas-obj-034"></a>
#### OBJ-034 — context revision

- **ID**: `OBJ-034`
- **제품 상태**: `런타임 내부` — 사용자에게 검사 가능한 요약 투영이 필요하다.
- **무엇인가 / 아닌가**: Run 또는 실행 시도에 포함·제외된 thread/task, 명시적 선택, 관련 Agenda, 임시 group/layout, visible/focused Resource, 최근 관련 상태, account/authority/execution scope와 각 리비전을 고정한 버전이다. Desk 전체 복사, 메모리 전체, 권한 부여 또는 공간 근접성에 의한 사실 추론이 아니다.
- **제품 사용자가 보는·하는 것**: `[업무 ⋯] → [입력·적용 기준]`에서 포함·제외 이유와 권한·실행 범위를 확인한다. 실행 전·중 범위를 조정하고 `[적용 내역]`에서 실제 반영된 호출 revision을 검사한다.
- **System 책임**: 승인된 source 집합에서 의미·명시 선택·권한으로 최소 snapshot을 결합하고 민감 범위를 제외하며 변경 시 새 리비전을 만든다. Canvas에서 가까운 배치를 관련 사실이나 evidence로 승격하지 않는다.
- **Agent 관계**: Agent는 호출별로 실제 전달된 context revision을 사용한다. 일반 수정은 같은 Run의 가능한 가장 이른 다음 호출에 반영하며 과거 입력을 바꾸거나 재시작·포크를 요구하지 않는다.
- **수명주기·복구**: 초안, 확정, 대체됨, 최신 아님 상태를 가지며 과거 Run과의 연결은 불변으로 남는다.
- **관련 trace / question**: `AI-01`, `AI-02`, `CHAT-01`; `Q-AI-03`, `Q-AI-05`, `Q-AI-11`, `Q-AGENT-06`.

<a id="atlas-obj-035"></a>
#### OBJ-035 — Answer

- **ID**: `OBJ-035`
- **제품 상태**: `상세 설계 기준선` — 하나의 Answer revision과 매체별 투영·개인 표시·수정본·삭제 경로가 있다. 지속 편집 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 사용자 요청에 대한 의미론적 응답으로, Chat과 하나 이상의 Canvas 표현을 연결할 수 있다. Chat 버블, Canvas 객체, Result나 artifact 하나와 반드시 같지 않으며 같은 긴 본문을 두 매체에 복제한 묶음도 아니다.
- **제품 사용자가 보는·하는 것**: Chat에서 완결된 대화 설명을 읽고, 연결된 Canvas의 공간·시각·상호작용 표현과 artifact·evidence로 이동해 후속 요청을 한다. Chat이 알림 한 줄로 축소되어서는 안 된다.
- **System 책임**: 매체별 역할을 지키는 투영과 출처·Result 관계를 하나의 Answer ID에 연결하고, 긴 본문 중복을 피하며 한 투영 실패를 격리한다.
- **Agent 관계**: Agent는 일관된 Answer를 생성하며 매체별 렌더링·포커스·지속성은 System이 관리한다.
- **수명주기·복구**: Chat·Canvas는 선택한 같은 Answer revision을 연다. 과거 메시지는 당시 revision에 고정하고 새 수정본 저장만으로 대표를 바꾸지 않는다. 개인 숨기기·지속 구성 편집·revision/전체 삭제를 구분하며 한 표현 실패는 다른 표현을 삭제하지 않는다.
- **관련 trace / question**: `AI-04`, `AI-05`; `Q-OBJ-07`, `Q-MEDIA-01`–`Q-MEDIA-03`, `Q-MEDIA-12`.

<a id="atlas-obj-036"></a>
#### OBJ-036 — Result

- **ID**: `OBJ-036`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: Run이나 Task가 끝나며 남긴 상태, 출력, evidence와 후속 가능 행동의 구조화된 결과다. Answer, artifact, 성공 표시 또는 Agent 자기 보고와 같지 않다.
- **제품 사용자가 보는·하는 것**: Run·Task 실행 상태와 `결과 범위: 부분·완료 2/실패 1`을 별도로 본다. 산출물·증거·미해결 조건을 확인하며 부분 결과를 업무 완료로 오인하지 않는다.
- **System 책임**: 정확한 Run·Task·context revision·대상 리비전과 연결하고 완료 기준을 충족한 범위만 성공으로 표시한다.
- **Agent 관계**: Agent는 출력과 근거를 제출하지만 Result 상태는 System의 검증된 전이와 외부 evidence를 따른다.
- **수명주기·복구**: 완전성은 `none/partial/complete`이며 실행 상태·효과 미확인·최신성은 별도다. 완전성 변경만으로 Run 전이·새 attempt·후속 실행이 생기지 않고 이전 Result는 보존한다.
- **관련 trace / question**: `AI-01`, `AI-04`, `AI-06`, `CODE-01`; `Q-OBJ-07`, `Q-AI-04`, `Q-ORCH-02`, `Q-CODE-03`.

<a id="atlas-obj-037"></a>
#### OBJ-037 — artifact

- **ID**: `OBJ-037`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 파일, 문서, 이미지, 데이터, 실행 가능한 패키지 또는 지속되는 Canvas 표현처럼 Run이 만들거나 수정한 산출 리소스다. Answer 전체, Result 상태, evidence 또는 결과 칩이 아니다.
- **제품 사용자가 보는·하는 것**: artifact를 열고 출처, 생성 Run, 리비전, 저장 위치와 검증 상태를 확인한다.
- **System 책임**: artifact의 저장 성공, 로케이터, 리비전, 권한, Answer·Result·source 관계를 기록한다.
- **Agent 관계**: Agent가 artifact를 생성·수정할 수 있으나 생성됐다는 사실만으로 정확성·저장·전달 성공을 보장하지 않는다.
- **수명주기·복구**: 초안, 생성 중, 영속화됨, 실패, 변경됨, 최신 아님, 삭제 상태가 가능하며 로컬·원격 수명주기를 구분한다.
- **관련 trace / question**: `AI-04`, `CODE-01`, `DATA-01`; `Q-OBJ-07`, `Q-MEDIA-03`, `Q-CODE-03`, `Q-DATA-02`–`Q-DATA-04`.

<a id="atlas-aff-001"></a>
#### AFF-001 — result navigation affordance (`result chip` 후보)

- **ID**: `AFF-001`
- **제품 상태**: `상세 설계 기준선` — Answer·결과·산출물 사이를 이동하는 비객체 탐색 어포던스다.
- **무엇인가 / 아닌가**: Chat과 Canvas, Result 또는 artifact 사이를 이동시키는 컴팩트한 링크·표시 후보다. 지속되는 도메인 객체, Result 자체 또는 Card의 확정된 동의어가 아니다.
- **제품 사용자가 보는·하는 것**: 레이블과 대상 상태를 확인하고 활성화해 Chat에서 Canvas 대상으로 이동하거나 Canvas에서 원 Answer·Chat 위치로 돌아간다.
- **System 책임**: 양방향 대상 ID와 권한을 해석하고 누락·최신 아님·권한 거부·각 투영의 독립 렌더 실패를 표시하며, 재시도·다시 연결·원위치 복귀 뒤에도 어포던스 자체에 독립 수명주기를 만들지 않는다.
- **Agent 관계**: Agent가 연결 대상을 제안할 수 있으나 칩 렌더링과 탐색은 System 책임이다.
- **수명주기·복구**: 원 메시지·Answer와 함께 나타나고 대상이 사라지면 조치 가능한 비활성 상태가 된다.
- **관련 trace / question**: `AI-04`; `Q-MEDIA-02`, `Q-MEDIA-03`, `Q-MEDIA-12`.

### 4.5 Answer Briefing, 시각 주석, Terminal과 Ontology

<a id="atlas-obj-038"></a>
#### OBJ-038 — Answer Briefing

- **ID**: `OBJ-038`
- **제품 상태**: `상세 설계 기준선` — 이름은 답변 브리핑, 진입은 `[브리핑 보기]`다. 탐색·CRUD·권한 경로가 있으며 사용자 지속 편집 정책은 연결된 선택에 따른다. 관련: `Q-MEDIA-04`.
- **무엇인가 / 아닌가**: Agent가 한 Answer의 공개 가능한 target set, Briefing Order, 각 Briefing Step의 Focus Scope와 짧은 설명을 제안하고 사용자가 이전·다음·전체 보기·종료로 따라가는 Canvas 브리핑이다. 동영상 파일, Run 재생 로그, raw Agent chatter, hidden chain-of-thought 또는 내부 scratchpad의 재생이 아니다.
- **제품 사용자가 보는·하는 것**: `[브리핑 보기]`에서 `[단계 목록] [이전] [전체 보기] [다음] [의견] [종료]`를 사용한다. 화살표는 탐색 영역에서만 작동한다. 지속 편집이 허용되면 `[⋯] → [브리핑 편집] → [새 버전 저장]`을 사용한다.
- **System 책임**: target·권한·최신 상태를 검증하고 현재 Briefing Step의 viewport·zoom·강조·가림·포커스를 적용하며, 이전·다음·직접 이동·전체 보기·종료와 움직임 감소·비시각적 대안을 구동한다.
- **Agent 관계**: Agent가 공개 가능한 산출물 set, 설명 순서, Focus Scope와 Step Explanation을 제안할 수 있으나, 제품 사용자의 단계 이동에 따른 화면 전환은 System 작업이며 새 Agent Run을 시작하지 않는다.
- **수명주기·복구**: Briefing은 기반 Answer와 고정 target의 revision을 가진다. 생성·편집·공유·삭제 권한은 별도로 검사한다. 초안·마지막 단계를 보존하고 재진입 시 이어보기·처음부터를 제공한다. 새 게시본이 읽던 단계·기존 공유 링크를 바꾸지 않으며 Briefing 삭제가 Answer·artifact·댓글 본문을 자동 삭제하지 않는다.
- **관련 trace / question**: `AI-05`; `Q-MEDIA-04`, `Q-MEDIA-09`, `Q-MEDIA-10`, `Q-UX-03`.

<a id="atlas-obj-039"></a>
#### OBJ-039 — Briefing Step

- **ID**: `OBJ-039`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: Answer Briefing에서 한 번의 이전·다음 이동으로 도착하는 설명 단위다. `순서`, `target set`, `Focus Scope`, `viewport`, `강조/가림`, `Step Explanation`, 인접 Step 관계와 실패 대안을 가진다. 독립 artifact, Answer, Task 또는 Agent 실행 단계가 아니다.
- **제품 사용자가 보는·하는 것**: 현재 Step 번호·제목·집중 대상·설명을 식별하고 이전·다음·직접 이동·전체 보기를 수행한다.
- **System 책임**: 순서, target set, Focus Scope, viewport·포커스와 누락·최신 아님·권한 거부 상태를 관리한다.
- **Agent 관계**: Agent는 Briefing Step 구성을 제안할 수 있지만 유효한 대상·공개 범위·권한·지속성은 System이 검증한다.
- **수명주기·복구**: Step은 순번과 다른 안정 ID를 갖는다. 허용된 편집은 새 Briefing revision에 기록하고 과거 단계·댓글 연결을 유지한다. 현재 구성에서 빠진 단계는 이전 버전의 단계이며 실제 참조 revision·target이 삭제된 경우에만 orphan이다.
- **관련 trace / question**: `AI-05`; `Q-MEDIA-04`, `Q-MEDIA-08`–`Q-MEDIA-11`.

<a id="atlas-obj-040"></a>
#### OBJ-040 — Briefing Comment

- **ID**: `OBJ-040`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 특정 Briefing Step 또는 그 Step이 보여 주는 허용된 target에 붙고 다음 Chat 입력에 포함할 수 있는 단계 의견이다. Canvas 도형, 시각 주석 또는 이미 전송된 Chat 메시지가 아니다.
- **제품 사용자가 보는·하는 것**: 대상을 확인해 댓글을 생성·편집·삭제하고, 검증된 첨부로 다음 Chat 초안에 넣거나 제거·재연결한다.
- **System 책임**: 대상, 작성자, 권한, 초안, 지속성과 Chat 첨부 관계를 검증한다.
- **Agent 관계**: 댓글을 다음 메시지로 실제 전송하기 전에는 Agent가 시작되거나 내용을 사용하지 않는다.
- **수명주기·복구**: 댓글·편집 초안·첨부 참조는 닫기·재시작 뒤 보존한다. `[취소]`는 저장본을 바꾸지 않고 초안을 남기며 `[초안 폐기]`는 별도다. 저장·삭제 미확인은 상태를 조회하고 충돌은 내 초안을 유지한다. Chat 초안에는 commentId당 한 첨부만 두며 새 revision 교체는 명시적으로 선택한다.
- **관련 trace / question**: `AI-05`; `Q-MEDIA-05`, `Q-MEDIA-07`, `Q-MEDIA-08`, `Q-MEDIA-11`.

<a id="atlas-obj-041"></a>
#### OBJ-041 — Canvas annotation

- **ID**: `OBJ-041`
- **제품 상태**: `상세 설계 기준선` — 표식 도구·Memo 편집·저장·재진입 경로가 있다. Memo 응답 시작·방 연락·재촉 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: Canvas 대상이나 위치에 고정되는 두 종류의 주석이다. **시각 표식**은 도형·화살표·레이블 같은 편집 가능한 geometry이고, **Canvas Memo**는 사용자 본문과 작성자별 짧은 Agent 답글이 분리된 위치 대화다. 어느 쪽도 원본 콘텐츠 변경, 수락된 사실 또는 Briefing Comment가 아니다.
- **제품 사용자가 보는·하는 것**: `[주석 도구]`에서 표식·Memo를 만들고 이동·크기·본문·레이블·삭제를 조작한다. 위임 범위의 표식은 직접 저장되며 제안 모드에서만 `[수락] [기각]`을 사용한다. Memo 본문과 작성자별 답글을 구분한다.
- **System 책임**: 좌표·target·작성자·직접 적용/제안 모드·저장 revision을 관리한다. 제안에만 수락·기각을 기록하고 Memo 본문·답글·방 reference를 분리하며 원본을 암묵적으로 수정하지 않는다.
- **Agent 관계**: Agent가 표식 사양이나 짧은 Memo 답글을 만들 수 있다. 짧은 답으로 오해할 위험이 있거나 정보가 부족하면 관련 Agent 방에 Memo reference가 붙은 message·mention을 만들 수 있지만 사용자 본문을 고치거나 Canvas focus를 빼앗지 않는다.
- **수명주기·복구**: 저장된 표식·Memo·Agent 제안은 재시작 뒤 유지하고 임시 pointer·selection은 복원하지 않는다. 대상 유실은 마지막 위치와 `[당시 대상] [다시 연결] [삭제]`로 처리한다. 늦은 답글은 기반 Memo revision을 표시하며 Memo를 긴 Chat으로 자동 전환하지 않는다.
- **관련 trace / question**: `CANVAS-01`; `Q-MEDIA-06`, `Q-MEDIA-13`.

<a id="atlas-obj-042"></a>
#### OBJ-042 — Terminal

- **ID**: `OBJ-042`
- **제품 상태**: `상세 설계 기준선` — 선택적 전문가 화면이며 View·transport·process·Snapshot의 독립 조작·복구 경로가 있다.
- **무엇인가 / 아닌가**: 셸·PTY·프로세스와 상호작용하는 선택적 뷰 및 런타임이다. 사람 중심 코딩 UI의 기본 화면이나 뷰 복원만으로 살아나는 동일 프로세스가 아니다.
- **제품 사용자가 보는·하는 것**: 필요할 때 열고 작업 디렉터리·세션 신원을 확인하며, view close, transport detach, process termination, 백그라운드, snapshot, 재연결 또는 새 실행의 영향을 구분한다.
- **System 책임**: 뷰, transport, 세션 ID와 process 생존을 각각 검증하고 선택한 효과만 수행한다. view close만으로 process를 조용히 종료하지 않으며 종료가 필요하면 별도 의미·확인을 적용한다.
- **Agent 관계**: Agent가 실행 기반으로 사용할 수 있지만 사람에게 raw terminal을 주된 작업 UI로 강요하지 않는다.
- **수명주기·복구**: view 닫힘, transport 분리, process 생존·종료, snapshot 전용, 새 세션, 사용 불가를 독립적으로 구분한다.
- **관련 trace / question**: `TERM-01`, `L-02`; `Q-TERM-01`–`Q-TERM-05`, `Q-RESTORE-04`, `Q-VIEW-07`.

<a id="atlas-obj-043"></a>
#### OBJ-043 — Ontology model

- **ID**: `OBJ-043`
- **제품 상태**: `확정`
- **무엇인가 / 아닌가**: Agent 컨텍스트, 개념·관계, 제약, 허용 행동, evidence와 사이클 전이를 관장하는 버전 있는 System 모델이다. 그래프 화면, Agent 출력 또는 사용자가 직접 움직이는 Canvas 객체가 아니다.
- **제품 사용자가 보는·하는 것**: 허용된 경우 현재 버전, 출처, 제약, 사이클과 evidence 연결을 검사하고 변경은 별도 거버넌스 경로로 제안한다.
- **System 책임**: 활성 버전을 바인딩하고 전이를 검증하며 제안·검토·승격·롤백·감사를 분리한다.
- **Agent 관계**: Agent는 바인딩된 Ontology 안에서 행동하고 변경을 제안할 수 있지만 유효하지 않은 전이를 스스로 승격하지 않는다.
- **수명주기·복구**: 초안·검증·활성·대체·롤백·보관 버전을 구분하고 각 Run의 바인딩은 과거 그대로 남긴다.
- **관련 trace / question**: `ONT-01`, `ONT-02`, `AI-06`; `Q-ONT-01`–`Q-ONT-05`.

<a id="atlas-obj-044"></a>
#### OBJ-044 — Ontology view

- **ID**: `OBJ-044`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 관리되는 Ontology와 선택한 Agent 사이클을 시각화·검사하는 화면이다. Ontology 자체나 기본 수동 관리 워크플로가 아니다.
- **제품 사용자가 보는·하는 것**: 실행을 선택하고 계층·시간·evidence·버전 관계를 필터링해 최신 아님·알 수 없음까지 검사한다.
- **System 책임**: 관리 모델과 기록된 Run을 읽기 투영하고 보통의 보기 행동을 모델 변경으로 변환하지 않는다.
- **Agent 관계**: 뷰를 여는 데 Agent가 필요하지 않으며 Agent 출력은 거버넌스상의 진실이 아니다.
- **수명주기·복구**: 검사 상태와 필터·포커스는 표현 상태다. 모델 변경은 별도 제안·검증·승격 수명주기를 따른다.
- **관련 trace / question**: `ONT-01`, `ONT-02`; `Q-ONT-01`, `Q-ONT-02`, `Q-ONT-04`, `Q-ONT-05`.

<a id="atlas-obj-045"></a>
#### OBJ-045 — Library

- **ID**: `OBJ-045`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 사용자가 선별한 참조를 찾는 조건부 Library다. 자료·Agenda·결과·Snapshot, 자료만, 미제공의 세 정책 분기가 있으며 파일 원본·출력 저장소나 모든 Sidebar 항목의 자동 합본이 아니다.
- **제품 사용자가 보는·하는 것**: 제공 정책이면 Sidebar `[Library]`에서 검색·필터·열기·현재 Agenda 참조 추가를 사용한다. 허용 유형의 자료 메뉴 `[Library에 추가] → [등록]`으로 등록하고 `[Library에서 제거]`로 참조만 해제한다. 미제공이면 전체 검색·참고용 Saved Agenda를 사용한다.
- **System 책임**: 승인된 로컬 인덱스와 항목 유형·출처·최신성·접근 상태를 투영한다.
- **Agent 관계**: 명시적 의미 검색 요청이 없으면 Library 탐색은 System 검색이며 Agent 작업이 아니다.
- **수명주기·복구**: 등록·제거는 원본과 별개다. 실패 시 입력을 유지하고 `[등록 다시 시도]`를 제공한다. 취소는 원 목록·시점으로, 열기는 대상 View·Agenda로 이동한다. 미제공 정책에는 등록 상태가 없으며 원격 동기화는 별도 승인 범위를 따른다.
- **관련 trace / question**: `DISC-01`, `V-03`; `Q-OBJ-05`, `Q-DISC-01`–`Q-DISC-03`, `Q-LIB-01`.

### 4.6 협업, Desk 외부 활동과 데이터

<a id="atlas-obj-046"></a>
#### OBJ-046 — collaboration participant

- **ID**: `OBJ-046`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 승인된 신원으로 공유 범위에 참여하는 사람과 그 역할·세션이다. 모든 조직 구성원, Agent 또는 초대 수신자와 자동으로 같지 않다.
- **제품 사용자가 보는·하는 것**: 초대를 수락하고 권한상 허용된 범위에서 관찰·편집·제어하며 참가자, 역할과 행동 귀속을 확인한다.
- **System 책임**: 신원, 초대 전달, 수락, 역할, 기간, 철회, 접속 상태와 행동 귀속을 검증한다.
- **Agent 관계**: Agent 활동은 별도로 귀속되며, Agent가 참가자의 비공개 범위나 역할을 상속하지 않는다.
- **수명주기·복구**: 초대됨, 전달 대기, 수락, 참가, 만료, 철회, 재참가 상태를 구분한다. 초대 전송은 실제 접근 증거가 아니다.
- **관련 trace / question**: `COL-01`; `Q-COL-01`–`Q-COL-10`, 승인 `A-INFRA-01`.

<a id="atlas-obj-047"></a>
#### OBJ-047 — shared scope

- **ID**: `OBJ-047`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 협업자에게 명시적으로 공개된 Desk·Agenda·선택 View·공유 대화·artifact와 허용 행동의 집합이다. Desk 전체·계정·OS 제어권을 자동 공유하지 않는다.
- **제품 사용자가 보는·하는 것**: 공유 대상, 제외 영역, 역할, 기간과 관찰·편집·제어 차이를 미리 보고 초대·변경·철회한다.
- **System 책임**: 최소 범위를 강제하고 비공개 상태를 필터링하며 충돌·병합과 권한 변경을 감사한다.
- **Agent 관계**: 공유된 상태라도 Agent 작업 위임과 account/resource authority가 별도로 필요하다.
- **수명주기·복구**: 초대·수락·실제 접근과 정책 변경·기기별 적용 확인을 분리한다. 오프라인 상대의 적용은 미확인으로 남긴다. 충돌은 기준·현재·내 변경을 비교하고 순차 편집 또는 병행 초안 정책에 따라 인계·병합한다. 소유·복구·이전 권한은 연결된 사용자 선택을 따른다.
- **관련 trace / question**: `COL-01`, `DATA-01`; `Q-COL-01`, `Q-COL-03`–`Q-COL-06`, `Q-COL-08`–`Q-COL-10`.

<a id="atlas-obj-048"></a>
#### OBJ-048 — external computer-use activity observation

- **ID**: `OBJ-048`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: Agent가 Desk 네이티브 뷰 밖의 앱·화면에서 수행하는 활동의 대상, 관찰 범위, 입력 소유권, 행동과 결과 evidence를 사용자가 검사하는 기능이다. `Host Activity View`라는 확정 객체나 입력 재생 로그만을 뜻하지 않는다.
- **제품 사용자가 보는·하는 것**: 대상·모드·관찰 경계·현재 제어자를 확인하고 시작·일시 중지·인계·재개·중지·긴급 중지하며 결과를 독립 검증한다.
- **System 책임**: 비충돌 입력 소유권, 개인정보 보호, 동의, 범위 제한, 제어권 회수와 evidence 분리를 강제한다.
- **Agent 관계**: Agent는 승인된 모드와 범위에서만 행동하고 자신의 활동 로그만으로 결과 성공을 인증하지 않는다.
- **수명주기·복구**: 검토 전, 준비, 제어 중, 일시 중지, 인계, 중지, 검증됨·불일치·알 수 없음 상태를 구분한다.
- **관련 trace / question**: `CU-01`; `Q-CU-01`–`Q-CU-09`. 원격 streaming·저장·제어에만 승인 `A-INFRA-02`.

<a id="atlas-obj-049"></a>
#### OBJ-049 — local data

- **ID**: `OBJ-049`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 로컬 설정, 저장된 Agenda, 자동 Desk 세션, 대화, Profile, Run 감사, artifact, 인덱스·캐시 등 제품이 기기에서 보존하는 결정된 데이터다. 원격 백업, 동기화 계정 또는 자격 증명 원문 전체가 아니다.
- **제품 사용자가 보는·하는 것**: 범위별 설정, 보존·삭제·초기화와 내보내기·백업·가져오기·복원 내용을 미리 보고 실행한다.
- **System 책임**: 데이터 범위와 민감도를 구분하고, 자격 증명을 기본 내보내기에서 제외하며, 백업 생성과 실제 복원 성공을 따로 검증한다.
- **Agent 관계**: Agent는 위임된 로컬 데이터만 처리하며 데이터 보존 정책이나 삭제 권한을 Profile로 획득하지 않는다.
- **수명주기·복구**: 생성, 변경, 보존, 백업, 복원, 마이그레이션, 삭제, 초기화 상태와 객체별 보존 기간을 구분한다.
- **관련 trace / question**: `DATA-01`, 모든 지속성 흐름; `Q-DATA-01`–`Q-DATA-04`, `Q-DATA-06`–`Q-DATA-08`.

<a id="atlas-obj-050"></a>
#### OBJ-050 — sync

- **ID**: `OBJ-050`
- **제품 상태**: `상세 설계 기준선` — 남은 정책은 연결된 사용자 선택에 따른다.
- **무엇인가 / 아닌가**: 승인된 데이터 집합을 원격 저장소나 다른 기기와 일치시키는 선택적 기능이다. 로컬 저장, 백업 파일 생성, 협업 또는 기본 제공 인프라와 같지 않다.
- **제품 사용자가 보는·하는 것**: 동기화할 객체, 계정·기기, 암호화, 오프라인·충돌·삭제 영향을 검토하고 별도 승인을 거쳐 활성화·중지한다.
- **System 책임**: 승인 전 원격 프로비저닝을 하지 않고, 전송·충돌·재시도·기기 제거와 삭제를 감사한다.
- **Agent 관계**: Agent가 동기화를 제안하거나 준비할 수 있으나 인프라 승인과 실제 account authority 없이 활성화하지 않는다.
- **수명주기·복구**: 미구성, 승인 대기, 활성, 오프라인, 충돌, 기능 저하, 중지, 기기 제거 상태를 구분한다.
- **관련 trace / question**: `DATA-01`, `COL-01`; `Q-DATA-05`, `Q-DATA-09`, 승인 `A-INFRA-03`.

### 4.7 관계, Agent 활동 투영과 acceptance

<a id="atlas-obj-051"></a>
#### OBJ-051 — relation map

- **ID**: `OBJ-051`
- **제품 상태**: `확정`
- **무엇인가 / 아닌가**: Desk, Agenda, Resource, thread/task, Agent, Run, Answer, Result와 evidence 사이의 제품 의미 관계를 표현하는 모델이다. 특정 module, framework, class, database schema, service 배치, process 그래프 또는 Runtime topology가 아니다.
- **제품 사용자가 보는·하는 것**: 제품 객체가 왜 연결됐고 어떤 범위·리비전·권한에서 유효한지 검사하며, 허용된 경우 관계 변경을 별도 거버넌스 경로로 제안한다.
- **System 책임**: 제품 의미 ID와 관계를 구현 위치에서 분리하고, 구현체를 교체하거나 topology를 재배치해도 의미·버전·evidence 연결을 보존한다.
- **Agent 관계**: Agent는 relation map을 context와 제약으로 사용할 수 있지만 공간 근접성이나 코드 의존 그래프를 제품 사실 관계로 자동 승격하지 않는다.
- **수명주기·복구**: 관계 모델은 버전과 출처를 가지며 재구현 뒤에도 이전 Run의 binding을 재현할 수 있어야 한다. 구현 topology 변경만으로 새 제품 관계 버전을 만들지 않는다.
- **관련 trace / question**: `AI-02`, `AI-06`, `ONT-01`, `ONT-02`; `Q-OBJ-07`, `Q-ONT-01`–`Q-ONT-03`, `Q-AGENT-17`.

<a id="atlas-obj-052"></a>
#### OBJ-052 — Agent activity projection

- **ID**: `OBJ-052`
- **제품 상태**: `확정`
- **무엇인가 / 아닌가**: Agent가 제어하는 Task·tool·Browser·Terminal·file·computer-use 활동과 그 판단에 실제로 전달된 관찰을 Desk에서 검사할 수 있게 만드는 projection이다. 불변 raw/source capture, direct tool result 또는 Reader Context Packet, Agent-delivered payload, 읽기 전용 **Snapshot View**, 현재 resource/runtime의 **Live View**를 구분한다. raw Agent chatter, hidden chain-of-thought, 항상 렌더링되는 숨은 Desktop이 아니다.
- **제품 사용자가 보는·하는 것**: `[ · · · ]`에서 활동을 고른다. 실행 중 상호작용 Browser·Terminal은 동일 Live, 완료된 읽기·명령은 Snapshot으로 열린다. `[당시 관찰] [현재 조작면] [비교]`로 시점을 구분하고 raw·실제 전달 packet·변환 관계를 검사한다. Live 미확인은 node에 표시하며 관찰을 위해 새 세션을 만들지 않는다.
- **System 책임**: 모든 의미 있는 Agent 활동이 active, sleeping 또는 historical snapshot 어느 상태이든 Canvas에서 찾을 수 있는 projection을 유지한다. model/tool/Reader lifecycle에서 call/session identity, source revision, capture time, payload role, coverage, content hash와 transformation lineage를 수집한다. direct File read가 40–80행을 명명된 결과로 반환하면 그 전체가 해당 Agent input과 일치해야 한다. Smart Read에서는 전체 source/raw hit와 더 작은 Context Packet을 모두 보존하고 실제 전달 범위를 표시한다. 현재 path·URL·session으로 과거를 재구성하지 않으며 Snapshot View와 Live View를 별도 identity로 관리한다. renderer mount 전략은 기술 계약의 구현 재량이다.
- **Agent 관계**: 요청 담당 Agent는 실제로 전달된 direct result 또는 Reader Context Packet을 판단에 사용한다. Reader는 file-read 내부에서만 source-anchored packet을 만든다. 어떤 항목이 report set에 들어갈지는 System 계약과 제품 사용자 재정의를 따르며, report item은 `Agent-delivered payload → raw/source capture → source/runtime revision` provenance를 유지한다.
- **수명주기·복구**: Agent Observation Snapshot, Snapshot View node/renderer, Live View와 Browser·PTY 같은 상호작용 session은 서로 다른 수명주기를 가진다. Canvas viewport 밖이라는 이유만으로 활동을 종료하지 않는다. offscreen renderer는 unmount할 수 있고 live session은 종료될 수 있지만 가벼운 상태 node나 snapshot이 활동의 위치·상태를 계속 나타내며 보존된 snapshot 동일성과 출처 관계는 바뀌지 않는다. 동일 콘텐츠는 저장 계층에서 중복 제거·chunk·압축할 수 있지만 논리적 전체 내용은 유지한다. 정확한 보존 기간·암호화·redaction 정책 때문에 snapshot이 제거되는 경우, UI는 `snapshot 없음`을 명시하고 현재 resource를 역사적 관찰처럼 대체하지 않는다.
- **관련 trace / question**: `AI-01`, `AI-03`, `AI-04`, `AI-06`, `AI-07`, `CODE-01`, `TERM-01`, `CU-01`; `Q-AI-04`, `Q-MEDIA-01`, `Q-ORCH-01`, `Q-CU-08`, `Q-AGENT-12`, `Q-AGENT-18`.

<a id="atlas-obj-053"></a>
#### OBJ-053 — acceptance evidence

- **ID**: `OBJ-053`
- **제품 상태**: `확정`
- **무엇인가 / 아닌가**: 명시된 시작 상태와 버전에서 같은 성공 경로를 반복하고, 장애·중단 뒤 결정된 복구 경로로 재진입할 수 있음을 입증하는 수용 근거다. 한 번의 화면, 단일 로그, 일회성 happy path 또는 Agent의 완료 선언이 아니다.
- **제품 사용자가 보는·하는 것**: 시나리오, 전제, 실행 버전, 반복 결과, 복구 주입점, 기대·관찰 상태, evidence와 `last checked`를 검토한다.
- **System 책임**: 성공과 복구 시나리오를 재실행 가능하게 연결하고 반복 간 상태 누수·비결정성·회귀를 기록하며 오래된 evidence를 현재 acceptance로 표시하지 않는다.
- **Agent 관계**: Agent는 실행·검증·요약을 도울 수 있지만 독립 evidence 없이 자신의 결과를 최종 수용으로 승인하지 않는다.
- **수명주기·복구**: 후보, 반복 검증됨, 기능 저하, 회귀, 최신 아님 상태를 가지며 제품·Runtime·provider·tool 버전 변화 뒤 필요한 범위를 다시 검증한다.
- **관련 trace / question**: 모든 trace, 특히 `L-01`–`L-03`, `AI-01`, `AI-06`, `TERM-01`, `CU-01`; `Q-LIFE-03`, `Q-RESTORE-03`–`Q-RESTORE-08`, `Q-AI-04`, `Q-CU-08`, `Q-AGENT-19`.

<a id="atlas-obj-054"></a>
#### OBJ-054 — Reader Session

- **ID**: `OBJ-054`
- **제품 상태**: `확정된 시스템 개념, 기본 UI 노출은 일부 결정 필요`
- **무엇인가 / 아닌가**: 큰 자료나 큰 targeted hit를 요청 담당 Agent의 context에 무리하게 넣지 않고 원문 coverage를 유지해 읽는, 재개 가능한 file-read 내부 실행이다. 요청 담당 Agent의 비교·판단·최종 답변을 넘겨받는 일반 Worker나 별도 대화 참여자가 아니다.
- **제품 사용자가 보는·하는 것**: 기본 Chat에서는 `자료 읽는 중` 정도의 짧은 상태를 보고, 필요할 때 읽기 세부정보에서 source·전체/지정 범위·coverage·packet revision을 검사하거나 읽기 방향을 수정한다.
- **System 책임**: source snapshot·shape index·read intent·coverage·packet lineage와 recovery 상태를 보존한다. 한 Reader context보다 큰 자료는 모든 partition이 배정되도록 내부 조율한다.
- **Agent 관계**: 요청 담당 Agent가 같은 Session을 재호출할 수 있고 Reader는 항상 원문 snapshot으로 재진입한다.
- **관련 trace / decision**: `READ-01`–`READ-03`; `HUM-READ-001`.

<a id="atlas-obj-055"></a>
#### OBJ-055 — Context Packet

- **ID**: `OBJ-055`
- **제품 상태**: `확정된 시스템 개념`
- **무엇인가 / 아닌가**: Reader가 원문 또는 targeted hit를 검토해 요청 담당 Agent에게 반환하는 source-anchored read 결과 revision이다. 원문을 모두 담아야 하는 파일 사본도, 출처 없는 요약도 아니다.
- **제품 사용자가 보는·하는 것**: Snapshot에서 packet의 read intent, coverage, 선택 span과 원문 이동 동작을 검사할 수 있다.
- **System 책임**: packet이 요청 담당 Agent의 실제 input에 들어간 revision과 raw/source capture의 변환 관계를 기록한다.
- **Agent 관계**: 요청 담당 Agent는 packet을 현재 업무 판단에 쓰고, 만족하지 않으면 같은 Reader Session에 새 intent를 보내 다른 revision을 받는다.
- **관련 trace / decision**: `READ-01`–`READ-03`, `AI-04`; `HUM-READ-001`, `HUM-SNAPSHOT-001`.

<a id="atlas-obj-056"></a>
#### OBJ-056 — AI Engine Profile

- **ID**: `OBJ-056`
- **제품 상태**: `확정된 identity 경계, 기본 적용 범위는 일부 결정 필요`
- **무엇인가 / 아닌가**: AI provider의 실제 계정·auth mode·plan/quota와 격리된 engine runtime/credential binding을 선택하는 설정이다. Agent의 personality·instructions를 담는 Agent Profile, EG-Desk 로그인, Browser 계정과 다르다.
- **제품 사용자가 보는·하는 것**: 전용 인증 화면에서 의도한 구독 계정을 연결하고 Chat 또는 요청의 Engine 선택기에서 고른다.
- **System 책임**: 계정별 runtime/credential을 격리하고 callback 뒤 실제 account·plan을 확인하며 새 Run에 `engineProfileId`를 고정한다. token은 Chat·snapshot·export에 넣지 않는다.
- **Agent 관계**: 새 Run은 선택된 Engine Profile에서 시작하며 활성 Run은 기본값 변경으로 다른 계정에 이동하지 않는다.
- **관련 trace / decision**: `ENGINE-01`, `AGENT-01`–`AGENT-03`; `HUM-ENGINE-001`.

## 5. Agent / Profile / Run 참고 모델

### 5.1 네 계층의 경계

| 계층 | 정의 | 고정 경계 |
|---|---|---|
| **Agent Profile** | 성격, 지침, 정책, 제공자·모델 선택 규칙, 도구·위임 상한과 기본 제한의 버전 있는 설정 | 권한이나 자격 증명을 부여하지 않으며, Profile 변경은 과거 Run을 바꾸지 않는다. |
| **AI Engine Profile** | 실제 provider account·auth mode·plan/quota와 격리된 engine runtime/credential binding | EG-Desk 로그인·Browser 계정·Agent personality와 다르며, secret은 Profile 본문이나 Chat에 들어가지 않는다. |
| **Agent Runtime** | Profile을 해석하고 현재 제공자·모델·도구 가용성, 컨텍스트, 권한, 승인, Ontology와 실행 제한을 결합하는 실행 계층 | Chat에 들어 있지 않으며, 준비됨이나 tool availability가 permission을 뜻하지 않는다. |
| **Run** | 사용자 요청이나 위임을 실제 실행으로 만든 감사 가능한 단위 | 실행 시점의 snapshot을 가지며, Agent와 도구는 그 경계 안에서만 행동한다. |

Chat은 이 네 계층의 일부 상태를 사람이 읽을 수 있게 투영할 수 있다. 예를 들어
Agent 이름, Agent Profile, AI Engine account/plan 요약, Run 상태, 컨텍스트 요약,
Result와 Canvas 링크를 보여 줄 수 있다. 그러나 Chat 메시지 기록이 Profile 정의,
Runtime 세션, 전체 컨텍스트, 메모리, 자격 증명 또는 Run 감사 원장을 포함한다고
보지 않는다.

기본 제공·예시 Profile을 제품에 둘지, 둔다면 어떤 이름·역할·편집 가능 범위를
가질지는 `Q-AI-07`, `Q-AGENT-01`, `Q-AGENT-02`가 정한다. 개발용 실행 설정의
현재 이름을 제품 사용자용 분류나 고정 제품 명칭으로 전사하지 않는다.

### 5.2 Agent Profile 정의

Agent Profile은 다음 필드를 버전으로 구분한다. `[방 목록] → [Profile 관리]`에서 정의를, `[업무 ⋯] → [실행 설정]`에서 현재 적용을 확인한다. 공개·편집 범위는 권한과 연결된 정책을 따르며 필드를 하나의 자유 형식 prompt로 합치지 않는다.

| 필드 | 제품 의미 | 경계 |
|---|---|---|
| **identity** | 안정적인 Profile ID, 표시 이름, 설명, 소유·관리 범위 | Chat 대화 ID나 Agent 실행 ID가 아니다. |
| **personality** | 말투, 협업 방식, 설명 깊이, 기본 상호작용 성향 | 정책, 사실, 권한 또는 성공 기준을 바꾸지 않는다. |
| **instructions** | 역할별 작업 방식, 우선순위, 산출 형식과 검증 습관 | 상위 System 정책, 사용자 위임, 실제 권한과 승인을 덮어쓰지 않는다. |
| **policy / system prompt binding** | 제품·제공자 정책과 런타임 지침 묶음의 버전 또는 해시 | 원문 전체를 Chat에 노출한다고 가정하지 않는다. Profile에는 안전한 요약과 식별 정보가 필요하다. |
| **provider / model policy** | 선호 provider, model 계열, 정확한 version 선택 규칙과 허용된 fallback 체인 | 현재 availability와 다르며 fallback이 도구·데이터·네트워크·권한을 넓히지 않는다. |
| **tools / capability ceiling** | 사용할 수 있다고 선언한 도구 종류, 작업 유형과 최대 위임 범위 | 실제 tool availability, account/resource authority 또는 approval이 아니다. |
| **context defaults** | 명시적 선택, Agenda, 대화, 보이는 Resource 중 어떤 후보를 우선 검토할지 | Desk 전체 자동 수집 규칙이 아니며 Run마다 검사·축소할 수 있어야 한다. |
| **memory policy** | 허용된 메모리 종류, 범위, 기록 조건, 보존·삭제 기본값 | 메모리 내용 자체나 권한이 아니다. 정확한 범위는 `Q-AGENT-07`이 정한다. |
| **credential-handle policy** | 어떤 종류의 불투명 credential handle을 요청할 수 있는지 | secret 값, 계정 소유권 또는 사용 승인이 아니다. |
| **Ontology binding policy** | 기본 Ontology 선택 규칙, 요구 버전·제약·evidence 스키마 | System이 첫 호출 전 실제 내용을 조회하고, 호출마다 사용한 binding을 별도로 기록한다. |
| **budget / sandbox / network / time defaults** | 비용·토큰·단계·시간 상한, 격리 수준, 네트워크 후보 범위 | 실제 Run 제한을 자동 확정하거나 외부 접근을 허용하지 않는다. |
| **delegation ceiling** | 하위 Agent나 Task에 위임 가능한 최대 범위와 금지 범위 | 사용자의 현재 Task 위임보다 넓게 사용할 수 없다. |
| **audit metadata** | 작성자, 버전, 변경 이유, 활성 시점, 대체·폐기 관계 | Profile 정의의 변경 이력이 실제 Run 성공을 증명하지 않는다. |

`[업무 ⋯] → [입력·적용 기준] → [규칙]`에서 강제 제한·이번 지시·수정 가능한 기본값과 적용·제외 이유를 확인한다. 조직 잠금 정책은 `조직에서 고정`으로 표시한다. Profile은 강제 제한·사용자 위임·실제 권한·승인 경계를 우회하지 못한다. 관련: `Q-AGENT-02`, `Q-AGENT-13`.

### 5.3 capability, availability, permission, approval, success

| 상태 | 답하는 질문 | 대표 근거 |
|---|---|---|
| **capability** | 이 Profile·도구·모델 조합은 원칙적으로 이 유형의 일을 할 수 있는가? | Profile 선언, tool schema, provider·model 특성 |
| **current availability** | 이 Run을 시작하는 지금 provider, model, tool, service, process와 network가 실제로 준비됐는가? | Runtime health, version resolution, 연결·서비스 상태 |
| **permission** | 이 행위자가 이 Resource와 account context에서 이 행동을 수행할 권한이 있는가? | Task delegation, OS·파일 권한, Browser account/profile authority, 공유 역할, System policy |
| **approval** | 기존 권한 범위를 넓히거나 새로운 외부 효과를 수행하도록 권한 있는 사람이 명시적으로 허용했는가? | 범위·행위자·기간·철회 조건이 있는 승인 기록 |
| **success** | 의도한 결과가 정확한 대상과 범위에서 실제로 발생했는가? | Result 검증, 제공자 확인증, 독립 external evidence |

실행 가능 범위는 개념적으로 다음 교집합 안에만 존재한다.

`current availability ∩ Profile ceiling ∩ Task delegation ∩ account/resource authority ∩ System policy ∩ 필요한 active approval`

이 식에서 Profile ceiling과 capability는 최대 후보를 제한할 뿐 authority를 더하지
않는다. 승인 대상이 아닌 기존 로컬 작업에는 별도 approval이 필요하지 않지만,
나머지 경계는 그대로 적용된다. 실행 뒤에는 별도의 success evidence가 필요하다.

### 5.4 provider, model, version과 fallback

Profile은 선호 정책을 가질 수 있지만 Run은 실제로 해소된 값을 기록한다.

- 요청한 provider·model과 실제 사용한 provider·model·version을 구분한다.
- model 별칭만 저장하지 않고 실행 시 해소된 식별자와 가능한 경우 버전·배포 정보를
  Run snapshot에 남긴다.
- fallback은 원 provider·model이 현재 unavailable일 때만 허용된 정책 안에서
  선택한다. 이유와 전환 시점을 감사하고 사용자에게 필요한 수준으로 알린다.
- fallback은 Profile ceiling, Task delegation, account/resource authority, sandbox,
  network, 데이터 전송 범위나 approval을 넓히지 않는다.
- privacy, 데이터 위치, 비용, 출력 특성 또는 도구 사용 가능성이 실질적으로 달라지면
  자동 전환 가능 여부와 사용자 확인 시점을 `Q-AGENT-03`에서 결정한다.
- 어떤 모델도 준비되지 않았으면 가용성·연결 health와 Run의 대기·실패 원인을 별도로 표시한다. `[연결 다시 검사] [허용된 다른 조합] [대기] [업무 중지]`를 제공하며 다른 모델을 사용한 것처럼 가장하지 않는다.

### 5.5 tools, context, memory, credentials와 Ontology

#### Tools와 현재 가용성

Profile의 tool 목록은 허용 후보의 상한이다. Agent Runtime은 Run을 시작할 때 실제
설치·연결·버전·인증·sandbox·network 상태를 확인해 current availability를 만든다.
도구가 빠졌거나 기능이 저하되면 대체 경로, 대기 또는 실패를 명시하고 사용하지 않은
도구의 결과를 주장하지 않는다. 도구가 준비됐다는 사실은 그 도구로 특정 계정이나
Resource에 행동할 permission이 있다는 뜻이 아니다.

#### Context와 context revision

System은 각 모델 호출 전에 다음 후보와 새 사용자 조정·도구 관찰을 검토해 필요한 context revision을 만든다.

- 현재 thread와 실행할 task의 범위·요구·선행 상태;
- 사용자가 명시적으로 선택하거나 첨부한 대상;
- 관련 Agenda의 허용된 구성원;
- 임시 Desk group/layout 가운데 요청 의미에 직접 관련된 관계;
- visible 또는 focused Resource 가운데 요청에 필요한 대상;
- 최근 상태 중 task와 직접 관련되고 최신성이 확인된 상태;
- source, evidence, 대상 리비전과 account/authority/execution scope;
- 활성 Ontology가 요구하는 제약과 evidence 스키마.

각 포함 항목에는 식별자, 리비전, 포함 이유와 권한 범위가 필요하다. 민감하거나
권한이 없는 후보는 암묵적으로 포함하지 않는다. 사용자가 실행 전 범위를 줄이거나
수정할 수 있어야 하며, 실행 뒤에는 결과가 사용한 정확한 context revision을
검사할 수 있어야 한다. 실행 중 새 자료·사용자 조정은 과거 snapshot을 보존하면서
같은 Run의 다음 모델 호출에 반영된다. 반영 상태·범위 검사 UI는 `Q-AI-05`와
`Q-AGENT-06`을 따른다. 일반적인 조정에 재시작·포크가 필요하지는 않다.

Canvas의 공간 근접성은 포함 후보를 사람이 검토할 단서가 될 수는 있지만 그
자체로 관련 사실, source 관계 또는 evidence가 아니다. System은 가까이 놓인
Resource를 자동으로 진실 관계에 연결하거나 권한 범위에 추가하지 않는다.

#### Memory

Memory는 대화 임시·Agenda·선택 Agent·개인·조직 범위를 구분하며 사람 또는 관리 범위가 소유한다. Profile은 기억 본문을 소유하지 않는다. `[입력·적용 기준] → [기억]`에서 편집·재사용 중지·삭제·만료·이동·공유·내보내기를 다룬다. 명시 저장형과 사전 동의 범위의 자동 축적형은 연결된 사용자 선택을 따른다. 관련: `Q-AGENT-07`, `Q-DATA-04`.

Chat 기록은 곧 Memory가 아니며, Memory는 account/resource authority가 아니다.
Memory를 context revision에 포함하려면 출처, 범위, 최신성, 포함 이유와 권한을
다른 Resource와 같이 검증한다. Profile 변경이나 Agent 교체가 기존 Memory의
소유권을 자동 이전하지 않는다.

#### Credential handle

Credential handle은 System의 안전한 자격 증명 저장소나 provider 세션을 가리키는
불투명 참조다. secret 원문을 Profile, Chat, context revision, artifact, 기본
내보내기 또는 일반 audit event에 넣지 않는다. Runtime은 실제 도구 경계에서만
handle을 해소하고 대상 provider, account identity, scope, 만료·철회와 현재
permission을 확인한다.

Profile이 handle 종류를 허용하거나 Run이 handle을 참조해도 권한이 생기지는
않는다. 새 자격 증명 생성·연결, OAuth 범위 확대 또는 provider 신원 추가는
필요한 approval을 거친다. 정확한 검사·교체·만료 UI는 `Q-AGENT-08`과
기존 `Q-AUTH-03`, `Q-ORCH-05`가 정한다.

#### Ontology binding

System은 첫 모델 호출 전에 적용되는 조직·Desk·Agent 정책에서 활성 Ontology를 찾고
필요한 내용을 읽어 입력에 결합한다. 사용자가 version 번호를 직접 입력하지 않아도 된다.
각 호출이 사용한 참조·범위·선택 이유·제약·evidence 요구사항은 당시 기록으로 남는다.
새로운 관련 내용이 관찰되면 같은 Run의 다음 호출에 반영하며 과거 기록을 바꾸지 않는다.
Agent Profile은 선택 정책을 제공하며 실제 binding 검증과 입력 결합은 System 책임이다.

Ontology가 제공하는 relation map은 제품 객체의 의미와 관계를 나타낸다. 특정
module, framework, class, service, process 배치 또는 Runtime topology는 가능한
구현 중 하나일 뿐이며 relation map이 이를 강제하지 않는다. 구현 topology를
바꾸더라도 제품 의미, Run binding과 evidence 연결은 보존되어야 한다.

필수 Ontology를 읽지 못하거나 권한·실행 조건과 충돌하면 영향받는 범위와 필요한
조치를 표시한다. 새 version을 발견한 것만으로 업무를 멈추지는 않는다. Ontology view는 binding을
검사하는 투영일 뿐 binding이나 모델을 직접 변경하지 않는다. 선택·대체 정책은
`Q-ONT-02`와 `Q-AGENT-09`가 정한다.

### 5.6 budget, sandbox, network와 time

Run 제한은 Profile 기본값을 그대로 복사하는 것이 아니라 실제 Task와 권한에 맞춰
System이 확정해 snapshot에 기록한다.

- **budget**: 토큰, 비용, 도구 호출, 실행 단계, 저장·전송량 등 적용되는 상한과
  현재 사용량을 구분한다.
- **sandbox**: 파일·프로세스·앱·기기 범위와 읽기·쓰기·실행 격리를 명시한다.
- **network**: 오프라인, 허용 목적지, provider 전용, 일반 외부 네트워크 등
  실제 허용 범위를 기록한다.
- **time**: 시작 시각, 시간 제한, deadline, 승인·dependency 만료와 중지 시각을
  구분한다.

상한 도달은 성공이 아니다. `[실행 설정 → 제한]`은 현재값·요청값·상위 상한·집행 상태를 분리한다. 명시된 hard ceiling은 중앙 전이에 따라 후속 dispatch 차단·중지 요청·종료 확인으로 처리하고 독립 결과를 보존한다. 부분 완전성은 Task 상태가 아니라 Result에 기록한다. 권한·비용·전송 범위 확대는 별도 승인 대상이다. 관련: `Q-AGENT-10`.

### 5.7 Run snapshot

Run snapshot은 시작 조건과 각 모델 호출에 실제 사용된 사실을 추적하는 기록이다.
한 사용자 요청 안에서도 모델 호출과 도구 사용은 반복되며, 다음 호출에는 새 context
revision이 사용될 수 있다. 최소 필드는 다음과 같다.

| 필드 | 기록할 내용 |
|---|---|
| **run identity** | Run ID, 생성 시각, 부모 Run과 시도·포크 관계 |
| **request binding** | 제품 사용자가 전송하거나 상위 Task가 위임한 요청 ID·revision·입력 범위와 생성 행위자 |
| **effective instruction binding** | 해당 Run에 실제 적용된 제품 사용자 요청, 대화 context, Profile instructions·personality, System·provider policy의 revision·hash·해소된 우선순위 |
| **task graph** | Task ID, 담당 Agent, 선행 조건, 완료 조건과 `queued`·`waiting-on-dependency`·`ready`·`running`·`approval-required`·`completed`·`failed`·`cancelled` 상태 |
| **profile binding** | Profile ID, version, hash, 활성 시점 |
| **engine binding** | AI Engine Profile ID, 격리된 runtime/config revision, 검증된 account·auth mode·plan/quota 상태; token 제외 |
| **runtime resolution** | Runtime version, adapter, 현재 health와 기능 저하 사유 |
| **provider/model resolution** | 요청값, 실제 provider·model·version, fallback 사건과 이유 |
| **context binding** | 모델 호출별 context revision ID, direct payload 또는 Reader Session·Context Packet revision, coverage, 포함 Resource·source·evidence 리비전, 사용자 조정 반영 여부와 제외 이유 |
| **memory binding** | 실제 포함된 Memory ID·revision·scope, 포함 이유와 제외·최신 아님 판단; 비밀 원문은 별도 정책 적용 |
| **authority binding** | Browser account/profile, 파일·폴더, 공유 역할 등 실제 account/resource authority |
| **approval binding** | 필요한 승인 ID, 범위, 결정 행위자, 시각, 만료·철회 상태 |
| **tool resolution** | 허용 후보, 실제 current availability, 선택된 tool version과 호출 범위 |
| **credential handles** | 사용한 불투명 handle ID와 대상·scope·만료 메타데이터; secret 제외 |
| **Ontology binding** | 모델 호출마다 실제 조회·전달한 Ontology 참조·범위·정책·시각, 제약, 허용 전이와 evidence 요구사항 |
| **execution limits** | budget, sandbox, network, time와 변경 이력 |
| **state transitions** | Run 상태와 Task의 정본 여덟 상태를 구분한 전이, 행위자, 원인과 시각 |
| **outputs** | Answer, Result, artifact, projection과 개별 Agent 기여의 ID |
| **completion evidence** | 완료 주장, 이를 지지하는 evidence, 불일치·알 수 없음과 남은 위험 |

과거 호출 snapshot은 수정하지 않는다. 자료·모델·Profile·PC 조정은 같은 Run의 다음 context/config revision에 연결한다. 실패 재실행만 attempt를 늘리고 의도적 분기만 새 Run을 만든다. 계정 전환에 새 Run이 필요한 adapter에서도 같은 업무·최초 요청·방·Task lineage를 유지하고 credential·승인을 다시 검증한다. 관련: `Q-OBJ-07`, `Q-AGENT-14`.

### 5.8 Chat·Canvas 투영과 system prompt 가시성

Chat과 Canvas는 Run의 사람이 읽을 수 있는 projection이다. 제품은 다음을 안전한
수준으로 보여 줄 수 있어야 한다.

- 어떤 Agent·Profile 버전이 어떤 요청을 처리하는지;
- Run·Task의 현재 상태와 기다리는 조건, 중지·재시도 등 가능한 다음 행동;
- 사용한 context revision의 범위 요약과 수정·검사 진입점;
- 실제 provider·model 또는 fallback 사실 중 사용자 판단에 필요한 정보;
- Result, Answer, artifact, evidence와 Canvas 표현 사이의 연결;
- 권한·승인·실행 성공이 서로 다른 상태라는 표시.

모든 Agent 제어 활동에는 이 정보를 찾을 수 있는 Desk-visible projection이
필요하다. 여러 Agent가 기여하면 raw Agent chatter나 provider conversation을
그대로 노출하지 않고 contributor, status, scope, evidence, 개별 기여와
integration result를 구조화해 보여 준다. 해당 projection의 정확한 위치와 밀도는
`Q-AGENT-18`이 정한다.

반대로 Chat에 Runtime 세션, 전체 tool trace, Memory 원문, credential secret, 내부
정책 원문 또는 raw system prompt 전체가 들어 있다고 가정하지 않는다. 사용자는
유효한 제약과 실행 이유를 이해할 수 있어야 하지만, 안전한 요약·버전·해시·정책
출처와 원문 공개 범위는 다를 수 있다. 정확한 Profile 상세 보기와 지침 가시성은
`Q-AGENT-12`와 `Q-AGENT-13`이 정한다.

Answer는 Chat과 Canvas에 매체별로 투영된다. 같은 긴 본문을 양쪽에 복제하지
않는다. Chat은 대화 설명과 후속 입력을 완결되게 유지하므로 단순 완료 알림이나
Canvas 링크 한 줄로 축소할 수 없다. Canvas는 공간·시각·상호작용·artifact
표현을 담당한다. 연결된 projection 하나가 실패해도 Answer·다른
projection·Result는 조치 가능한 상태로 남아야 한다.

Answer Briefing도 사용자에게 전달하기로 한 Briefing Step, artifact, source, evidence와 설명만
투영한다. hidden chain-of-thought, 비공개 scratchpad, 내부 추론 토큰이나 raw
Agent chatter를 프레젠테이션 콘텐츠로 사용하지 않는다.

### 5.9 감사, 버전, 수명주기와 복구

#### 감사와 버전

- Profile, 정책·지침 묶음, Runtime adapter, provider·model, tool, Ontology,
  context revision과 approval을 각각 버전 또는 안정적인 식별자로 기록한다.
- 각 상태 전이와 외부 효과에는 요청자, 실행 Agent·도구, 대상, account context,
  시각, 결과와 evidence를 연결한다.
- fallback, 재시도, 중지, 권한 거부, 승인·철회, 기능 저하와 독립 검증 실패를
  성공 경로와 같은 수준으로 감사한다.
- bridge, helper, transport, provider conversation, process, view 장애는 각 계층의
  관찰 상태와 `last checked`를 남기고, 증거가 없는 근본 원인은 `unknown`으로
  유지한다. 한 계층의 실패를 인접 계층의 원인으로 자동 귀속하지 않는다.
- audit은 credential secret이나 raw system prompt 전체를 기본 기록하지 않는다.
  무엇을 보존·내보내기·삭제할지는 `Q-DATA-04`와 `Q-AGENT-11`이 정한다.

#### 제안 수명주기

| 대상 | 수명주기 원칙 | 상세 조작·정책 경계 |
|---|---|---|
| **Profile** | 편집은 새 초안 revision, 활성화는 이후 기본 사용 변경이다. 진행 중 Run은 별도 적용 요청 없이 바꾸지 않는다. 중단·보관해도 과거 binding은 유지한다. | `[Profile 관리]`의 초안 저장·활성화·중단·보관·복구 경로가 있다. 소유·편집 권한은 연결된 정책을 따른다. 관련: `Q-AGENT-02`. |
| **AI Engine Profile** | 계정별 runtime·credential을 격리한다. 기본값 변경은 활성 Run을 옮기지 않는다. 명시 계정 전환은 같은 업무를 유지하며 adapter가 요구할 때 연결된 새 Run을 만든다. | 연결·전환·복구 경로가 있다. 기본 적용 범위는 `HUM-ENGINE-001`을 따른다. |
| **Reader Session** | immutable source snapshot·read intent·coverage·Context Packet revision을 보존하고 같은 source로 재호출한다. | `[읽기 상세]`에서 원문·packet·coverage를 보고 `[읽기 방향 수정]`으로 재호출한다. 일반 제어는 별도 사용자 결정이 아니며 계정·비용·권한 확대만 기존 승인 경계를 따른다. |
| **Agent Runtime** | 초기화·가용성·연결·process 상태를 독립 재검사하고 실행 상태와 분리한다. | `[상태 미확인]`에서 PC·process·Engine·도구·View의 마지막 확인과 `[다시 검사] [재연결] [당시 자료]`를 제공한다. 관련: `Q-AGENT-04`, `Q-AGENT-11`. |
| **Run** | 상태는 `binding/running/waiting/stopping/stopped/completed/failed`다. 일반 조정·대기 해소는 같은 Run을 유지하고 완료·중지 뒤 명시적 계속은 새 실행 구간을 기록한다. | 실패 재시도·계속·의도적 분기는 중앙 전이를 따르며 `partial`은 Result.completeness다. 조정은 수신·반영 대기·반영 확인으로 표시한다. 관련: `Q-AI-04`, `Q-AGENT-14`, `Q-AI-05`. |
| **Task** | 정본 여덟 상태를 유지하고 독립 성공을 보존한다. 실패 재실행은 같은 Task의 새 attempt, 완료·취소 후 재작업은 연결된 새 Task다. | 업무 상세에서 재시도·중지·담당 변경·다른 경로를 선택한다. timeout·거부·만료·늦은 결과는 중앙 전이를 따른다. 관련: `Q-ORCH-01`–`Q-ORCH-04`, `Q-ORCH-08`. |

#### Scheduler checkpoint와 waiting

Task가 승인, 사람 행동, 파일 도착, 로그인 또는 다른 외부 조건을 기다리면
System은 실행 범위, context revision, 완료된 기여, 남은 조건과 재개 규칙을
checkpoint로 기록한다. `approval-required`나 `waiting-on-dependency` 상태 동안 LLM stream을
열린 채 유지하지 않는다. 조건이 충족되면 권한·Ontology·가용성·최신 상태를 다시
검증하고 checkpoint의 업무를 다음 호출로 이어 간다. 실제 실행 실패를 다시 시도하는
경우에만 retry attempt를 기록하며, 대기 조건이 풀린 것만으로 새 attempt를 만들지 않는다.
취소되면 `cancelled`를 기록하고 자동 재개하지 않는다.

#### 장애 진단

bridge, helper, transport, provider conversation, process와 view는 각각 독립적인
health와 식별자를 가진다. 진단 projection은 관찰된 실패, 영향 범위, 가능한 원인,
원인 확정 여부, 마지막 검사 시각과 다음 검사를 분리한다. Runtime이나 Agent는
최근 성공 기록 또는 인접 계층의 오류만으로 현재 원인을 단정하지 않는다. 정확한
진단 UI와 자동 재검사 정책은 `Q-AGENT-20`이 정한다.

#### 재진입과 복구

앱 재시작 뒤 System은 먼저 Chat·Canvas·Run 상태 projection을 로컬 기록에서
재구성한다. 그다음 provider 세션, tool service, process, credential handle,
account authority와 dependency condition을 각각 다시 검증한다. 화면이 돌아왔다는
이유만으로 동일 Runtime 세션이나 Agent 실행이 재개됐다고 표시하지 않는다.

재연결은 동일 실행·권한·checkpoint·외부 효과 journal을 대조한다. 대기 해소는 같은 attempt를 이어가고 실패 재실행만 새 attempt다. 완료·중지 뒤에는 명시적 계속이 필요하며 취소 Task를 자동 부활시키지 않는다. 효과가 미확인이면 접수·현재 상태를 먼저 조회한다. 관련: `Q-AGENT-14`, `Q-AI-04`, `Q-ORCH-04`, `Q-TERM-03`.

#### Acceptance

수용은 같은 전제·버전·입력의 반복 성공과 실패·중단·재시작 뒤 복구 evidence로 확인한다. [Contract §17](./EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration)에 정상·실패·취소·승인·단절·후속 실행의 여섯 순서 fixture와 각 30회 검사 계획이 있다. 이는 미실행 인수 명세이며 통과·성능 실측이 아니다. 관련: `Q-AGENT-19`.

## 6. 구현이 어기면 안 되는 제품 불변조건

1. **Firefox 방향**: EG-Desk의 제품 방향은 Firefox 셸과 Firefox 기반 Browser다.
   다른 셸이나 범용 웹앱을 기본 제품으로 간주하지 않는다.
2. **실제 Desk가 첫 화면**: 최초 실행과 일반 실행 모두 실제 작업 가능한 Desk로
   들어간다. 랜딩 페이지, 프로젝트 선택기, 복구 마법사 또는 유지/폐기 목록이
   정상 시작의 선행 화면이 되어서는 안 된다. 기본 제품 모델은 하나의 Desk와
   그 Desk에 속한 하나의 Canvas이며, 여러 Saved Agenda는 같은 Canvas에 projection으로
   동시에 열 수 있다. Agenda 열기가 기존 내용을 교체하거나 새 Desk를 만들지 않는다.
3. **저장된 Agenda와 자동 Desk 복원은 별개**: 저장된 Agenda는 사용자가
   의도적으로 보관한 작업 결합이고, 자동 Desk 세션은 열어 둔 상태의 로컬
   연속성 기록이다. 어느 한쪽을 읽거나 쓰는 일이 다른 쪽을 생성·갱신하지 않는다.
   Agenda 닫기는 Canvas projection과 그 Agenda만 소유한 runtime을 종료하지만
   Saved Agenda를 삭제하거나 보관하지 않는다.
4. **표현과 기반 실행은 별개**: 보이는 뷰, 리소스, 런타임, 프로세스, 전송 연결은
   서로 다른 상태다. Canvas viewport 밖 이동은 닫기·sleep·suspend가 아니며 lifecycle은
   view/runtime별로 판단한다. 뷰 복원은 동일 프로세스나 세션 재연결을 증명하지 않는다.
   File view 재진입은 active caret·keyboard focus·transient selection을 복원하지 않는다.
5. **System 하이드레이션은 Agent 작업이 아니다**: 시작, 저장 상태 읽기,
   컨텍스트 결합, 권한 확인, 스케줄링, 렌더링, 포커스, 복구는 System 책임이다.
   사용자 요청이나 위임이 결합된 뒤에만 Agent 작업이 시작된다.
6. **Chat은 Agent 관계 표면이지 실행체가 아니다**: 사람에게 보이는 기본 Chat은
   Agent/persona별 담당자 방으로 대화 입력과 답변 표현을 보여 주지만 Agent Runtime,
   전체 컨텍스트, 메모리, 자격 증명 또는 도구 세션을 담는 컨테이너가 아니다.
   Chat 뷰를 닫아도 Run이 남는 경우에는 다른 Canvas 표현에서 그 실행을 찾을 수 있어야 한다.
   Agenda 닫기는 3번의 종료 규칙을 따른다.
7. **하나의 Answer, 여러 투영**: 하나의 논리적 Answer는 Chat의 대화형 표현과
   Canvas의 공간·시각·상호작용·산출물 표현을 함께 가질 수 있다. 어느 투영도
   다른 투영을 복제하거나 대체할 의무가 없고, 하나의 실패가 Answer 전체를
   자동으로 소거하지 않는다.
8. **다섯 상태를 합치지 않는다**: capability, current availability, permission,
   approval, success는 서로 다르다. 할 수 있는 기능이 있어도 지금 사용할 수
   없을 수 있고, 사용 가능해도 권한이 없을 수 있으며, 승인되어도 실행이
   실패할 수 있다.
9. **Profile은 권한을 부여하지 않는다**: Agent Profile은 행동의 상한, 성격,
   지침, 제공자·모델 정책과 도구 후보를 기술할 뿐이다. 실제 실행 범위는 작업
   위임, 계정·리소스 권한, System 정책과 필요한 승인까지 모두 충족해야 한다.
10. **로컬 자율성과 외부 승인 묶음**: 이미 위임되고 권한상 허용된 로컬 작업은
    독립적으로 계속된다. 새로운 인프라, 자격 증명, 비용, 배포, 민감 데이터
    전송 또는 실질적으로 넓은 외부 권한은 관련 분기만 대기시키고 유용한 시점에
    묶어서 승인받는다.
11. **승인은 성공이 아니다**: 승인, 클릭, 스피너, 도구 호출, HTTP 응답 또는
    생성된 파일 하나만으로 의도한 외부 효과나 최종 결과의 성공을 선언하지 않는다.
12. **사람 중심 코딩 UI**: 프로젝트·폴더, 파일 트리와 검색, 편집기·뷰어,
    변경사항 비교, 빌드·테스트·검사·리뷰 결과가 주된 사람용 코딩 경험이다.
    Terminal은 Agent 실행 기반이자 선택적 전문가·디버그 화면이다.
13. **Ontology 모델과 뷰는 별개**: Ontology는 컨텍스트, 관계, 제약, 행동,
    증거와 사이클을 관장하는 System 모델이다. Ontology 뷰는 그 모델을
    시각화·검사하며, 보통의 보기 조작만으로 운영 모델을 바꾸지 않는다.
14. **외부 효과에는 외부 증거가 필요하다**: 전송, 게시, 구매, 권한 변경,
    다운로드, computer-use 결과 등 외부 상태 주장은 대상·행위자·시점·범위를
    확인할 수 있는 제공자 확인증 또는 독립 검증을 필요로 한다.
15. **식별 계층을 합치지 않는다**: 콘텐츠 동일성, source/evidence, 리소스
    로케이터, Browser 계정·프로필 권한, 보이는 뷰 인스턴스는 별개의 식별자다.
16. **Workspace는 없다**: `Workspace`를 Desk, Agenda, 프로젝트, 폴더 또는
    공유 범위를 포괄하는 제품 노드로 도입하지 않는다. 필요한 관계는 각각의
    승인된 객체로 직접 설명한다.
17. **파일 선택기는 진입 UI다**: 파일·폴더 선택기는 대상을 고르는 일시적
    화면이며 프로젝트, Library, Agenda 또는 영속 객체가 아니다.
18. **외부 computer-use는 비충돌이어야 한다**: 사람과 Agent가 같은 물리 입력
    채널을 경쟁하지 않도록 입력을 격리하거나 해당 채널의 소유권을 인계한다.
    다른 격리 실행면의 Agent 작업이 사용자 카메라·입력 focus를 빼앗지 않는다.
    관찰 화면이나 입력 재생은 결과 성공의
    증거가 아니며, 긴급 중지는 성공 상태를 만들지 않는다.
19. **로컬 우선, 동기화는 별도**: 로컬 저장·내보내기·백업·복원 설계는 원격
    계정이나 서버 없이 진행할 수 있다. 원격 백업·다중 기기 동기화는 데이터,
    신원, 암호화, 충돌, 비용과 삭제 정책을 정한 별도 승인 대상이다.
20. **과거 입력은 보존하고 현재 업무는 조정한다**: 첫 모델 호출 전 적용 정책으로
    필요한 Ontology와 자료를 조회·결합하고, 각 호출이 실제 사용한 Profile·모델·
    context·도구·권한·승인·Ontology·제한을 기록한다. 새 관찰과 사용자 조정은 같은
    Run의 다음 호출에 반영하며, 일반적인 변화에 중지·새 attempt·fork를 요구하지 않는다.
    이후 변경이 과거 호출의 실제 입력을 바꾸지는 않는다.
21. **원문 system prompt 노출을 가정하지 않는다**: 제품은 사용자에게 필요한
    정체성, 유효한 지침 요약, 제한, 버전과 실행 이유를 보여 줄 수 있어야 하지만,
    내부 정책이나 원문 system prompt 전체를 Chat에 노출한다고 전제하지 않는다.
22. **핵심 의미는 포인터·색·움직임에만 의존하지 않는다**: 최종 컨트롤에는
    키보드와 접근성 경로가 필요하고, Canvas·Answer Briefing에는 비시각적 또는 움직임을
    줄인 동등 경로가 필요하다.
23. **relation map은 제품 의미다**: 객체와 행위자 사이의 제품 관계를 설명하는
    relation map은 특정 module, framework, class, service, process 배치나 Runtime
    topology를 강제하지 않는다. 구현을 바꿔도 제품 관계 의미는 보존되어야 한다.
24. **context snapshot은 의미와 권한으로 선택한다**: snapshot 후보는
    thread/task, 명시적 선택, 관련 Agenda, 임시 group/layout, visible/focused
    Resource, 최근 관련 상태, account/authority/execution scope다. Canvas에서
    가깝게 놓였다는 공간 근접성만으로 관련 사실이나 evidence를 만들지 않는다.
25. **Chat과 Canvas는 보완하며 중복하지 않는다**: 한 Answer의 두 projection에
    같은 긴 본문을 복제하지 않는다. Chat은 대화적으로 완결된 설명과 후속 입력을
    유지해야 하며 단순 완료 알림이나 Canvas 링크 한 줄로 축소하지 않는다.
26. **Answer Briefing은 hidden chain-of-thought를 노출하지 않는다**: Answer Briefing은
    사용자에게 전달하기로 한 Briefing Step, artifact, source, evidence와 설명만 보여 준다.
    내부 추론 토큰, 비공개 scratchpad 또는 숨은 모델 사고 과정을 재생하지 않는다.
27. **실행 상태와 결과 완전성을 분리한다**: Task는 `queued/waiting-on-dependency/ready/running/approval-required/completed/failed/cancelled`, Run은 `binding/running/waiting/stopping/stopped/completed/failed`를 사용한다. `partial`은 Run·Task 상태가 아니라 Result.completeness다. 조건 대기는 checkpoint를 기록하고 LLM stream을 유지하지 않으며, 중지 요청만으로 종료 확인 상태를 만들지 않는다.
28. **Terminal 효과를 분리한다**: Terminal view close, transport detach, process
    termination, snapshot은 서로 다른 행동이다. view close는 별도 확인·정책 없이
    process를 조용히 종료하지 않는다.
29. **모든 의미 있는 작업 상태는 Canvas에서 찾을 수 있다**: 사용자나 Agent가
    제어하는 Task, tool, Browser, Terminal, file, computer-use 활동은 active,
    sleeping 또는 historical snapshot 상태일 때도 Canvas에서 찾을 수 있는 projection을
    가져야 한다. 무거운 renderer는 분리할 수 있지만 숨은 registry에서만 실행해서는
    안 된다. raw Agent chatter나 chain-of-thought 대신 contributor, status, scope,
    evidence와 integration result를 표현한다.
30. **장애 원인은 증거 전까지 미확정이다**: bridge, helper, transport, provider
    conversation, process, view 중 하나가 실패해도 인접 계층을 원인으로 단정하지
    않는다. 관찰 상태, 가능한 원인과 `last checked` 시각을 분리해 기록한다.
31. **반복 가능한 성공과 복구가 acceptance다**: 한 번의 정상 화면이나 일회성
    happy path가 아니라 같은 전제에서 재실행 가능한 성공과, 실패 주입 또는 실제
    장애 뒤 재진입 가능한 복구가 evidence와 함께 검증되어야 수용 기준을 충족한다.
32. **명명된 반환 경계와 실제 Agent 전달 범위를 말없이 바꾸지 않는다**: direct
    File read가 40–80행을 명명된 결과로 반환했다면 그 전체가 snapshot과 해당 Agent
    input에 존재한다. Smart Read에서는 raw/source capture와 Reader Context Packet이
    다를 수 있으나 둘의 coverage·변환·실제 전달 대상을 보존한다. 어느 경우에도
    명명된 결과 뒤의 무표시 truncation이나 요약을 원본 결과로 재표시하지 않는다.
33. **과거 Snapshot View와 현재 Live View를 합치지 않는다**: Snapshot View는 도구
    호출 당시의 `Agent Observation Snapshot`을 읽기 전용으로 보여 주고, Live View는
    현재 resource/runtime를 상호작용 가능하게 보여 준다. 같은 renderer 구현을 재사용할
    수 있지만 둘은 별도 view identity로 Canvas에 공존한다. live resource의 변경,
    snapshot renderer의 unmount, Answer report set의 재배치는 과거 snapshot을 바꾸지
    않는다. 현재 상태를 다음 Agent 요청에 쓰려면 새 context revision이나 도구 호출을
    통해 새로운 관찰을 만든다.
34. **Reader는 요청 담당 Agent의 업무를 인계받지 않는다**: Reader Session은 context overflow를
    막기 위한 file-read 내부 실행이다. 비교·판단·최종 답변은 요청 담당 Agent가 소유하고,
    Reader는 immutable source에서 coverage가 있는 Context Packet만 반환한다.
35. **큰 자료와 판독 오류를 섞지 않는다**: context보다 큰 자료는 admission·분할·
    recursive compaction으로 읽는다. 암호화·손상·권한·형식·OCR 문제처럼 실제로
    읽지 못한 source가 남으면 전체 검토 완료를 표시하지 않는다.
36. **identity plane을 합치지 않는다**: EG-Desk 사용자, AI Engine 구독 계정,
    연결 서비스 계정, Browser profile/container와 OS resource identity는 서로 다른
    권한과 감사 경계다. 새 Run은 실제 선택한 `engineProfileId`에 고정된다.
37. **대화 DB와 portable export를 같은 것으로 보지 않는다**: SQLite는 로컬
    query/index 기준선이고, `.egdesk`는 manifest·event·필요 object가 닫힌 graph를
    이루는 이동 형식이다. token·cookie·기기 전용 절대경로는 기본 내보내기에서 제외한다.
## 7. 기능별 사용 흐름 색인

| # | Trace | 시작 → 완료 경계 | 주 map |
|---:|---|---|---|
| 1 | L-01 최초 로컬 실행 | 새 로컬 설치/프로필 → 사용할 수 있는 실제 Desk | M1 |
| 2 | L-02 일반 실행과 자동 Desk 복원 | 이전 세션·독립 saved Agenda → 복원된 view와 Sidebar 행 | M2, M17 |
| 3 | L-03 런타임 및 종료 경계에서 Desk 연속성 기록 | 실행 중 Desk → 마지막 유효 기록 기반 재진입 | M2 |
| 4 | AG-01 Agenda 생성 및 최초 저장 | 사용할 수 있는 Desk → 독립 saved Agenda | M14 |
| 5 | AG-02 저장된 Agenda 열기 | Sidebar의 유효 Agenda 행 → 결정된 Desk 관계 안의 Agenda projection | M14, M2 |
| 6 | AG-03 현재 작업에서 Agenda 저장 또는 업데이트 | 커밋 전 작업 범위 → 구분 가능한 saved revision | M14, M2 |
| 7 | AG-04 Agenda 이름 변경, 보관/닫기, 삭제 및 복구 | saved Agenda 행 → 선택한 수명주기 상태 | M14 |
| 8 | V-01 Desk 뷰로 리소스 열기 | 승인된 resource entry → 올바른 locator·권한의 view/runtime | M3, M15 |
| 9 | V-02 뷰 이동, 크기 조절, 그룹화, 포커스, 최대화 및 닫기 | Canvas의 active view → 일치하는 표현·세션 상태 | M15, M2 |
| 10 | V-03 Canvas 탐색 및 열려 있는 항목 찾기 | Canvas viewport → 이름 붙은 target focus/open | M15, M19 |
| 11 | DISC-01 Library 및 재사용 가능 리소스 탐색 | 승인된 경우의 Library 진입 → 출처가 보이는 target focus/open | M15 |
| 12 | TOOL-01 Browser, 프로필/계정 권한·가능 행동 및 출처 식별성 | Desk의 Browser entry → 분리된 콘텐츠·권한·행동·증거 상태 | M4 |
| 13 | BROWSER-01 페이지 탐색, 새로고침, 복구 및 재진입 | Browser view와 명시적 권한 컨텍스트 → 일치하는 URL·loading/error 상태 | M4 |
| 14 | BROWSER-02 Browser 인증 또는 권한 복구 | 인증·권한 복구 필요 상태 → 실제 권한과 가능한 행동 | M4, M9 |
| 15 | BROWSER-03 파일을 다운로드하여 EG-Desk로 전달 | Browser download target → 검증된 local file과 열린 target | M4, M3 |
| 16 | BROWSER-04 Browser 외부 효과 수행 및 검증 | 외부 효과 가능 상태 → provider 또는 독립 외부 증거 | M4, M9 |
| 17 | TOOL-02 파일 또는 폴더 열기 및 작업 | 파일/폴더 target → 같은 revision의 저장·diff·검증 결과 | M3, M10 |
| 18 | CHAT-01 Agent 담당자 방 열기, 계속하기, 복구하기 및 재진입하기 | Agent 방 접근 상태 → 지속성 경계가 드러난 같은 관계 재진입 | M16, M5, M7 |
| 19 | AI-01 인공지능 요청 제출하기 | request input surface → 연결된 request·context·task 상태 | M5, M5-F, M6, M16 |
| 20 | AI-02 요청의 컨텍스트 검사 또는 수정하기 | context 후보 → 검사 가능한 bound context revision | M5, M6 |
| 21 | READ-01 큰 첨부를 요청 담당 Agent가 직접 읽거나 Reader Session으로 전환하기 | attached sources → admission된 direct payload 또는 full-coverage Reader packet | M5, M5-F |
| 22 | READ-02 구체적인 조건으로 여러 자료를 찾고 큰 검색 결과를 Reader로 전환하기 | targeted request → complete hit manifest와 admission된 비교 context | M5, M5-F |
| 23 | READ-03 같은 Reader Session에 읽기 방향을 다시 지시하고 판독 오류를 복구하기 | 기존 packet 또는 판독 오류 → source-anchored revision 또는 명시적 blocked scope | M5, M5-F |
| 24 | ENGINE-01 EG-Desk 로그인과 다른 AI Engine 구독 계정을 연결·선택하기 | EG-Desk identity A → 검증된 Engine Profile B와 B에 고정된 새 Run | M6, M4 |
| 25 | AI-03 Agent 담당자 방과 다중 Agent 공유 작업 대화 | Agent 관계·승인된 공유 대화 범위 → 귀속 가능한 공유 컨텍스트·기여 | M16 |
| 26 | AI-04 Chat과 Canvas를 통해 표현되는 하나의 답변 | 논리적 Answer → 연결된 Chat/Canvas projection | M7, M5-F |
| 27 | AI-05 다음 Chat에서 사용되는 Answer Briefing 및 Briefing Comment | Answer Briefing 적합 대상 → 검증된 Briefing Step·Comment를 참조하는 다음 request | M7 |
| 28 | CANVAS-01 Canvas 주석: 시각 표식과 위치 메모 | Canvas target·position → 작성자·유형·persistence가 보이는 annotation | M18 |
| 29 | AI-06 병렬 Agent 및 의존성에 의해 구동되는 후속 작업 시작 | bounded request → evidence 조건 뒤의 dependent start | M8, M6 |
| 30 | AI-07 독립 작업을 중단하지 않고 승인이 필요한 결정 일괄 처리하기 | 실행 중 graph의 외부 경계 → 영향 분기만 결정에 따라 전환 | M9 |
| 31 | AUTH-01 새로운 외부 권한 또는 중대한 외부 효과 승인하기 | 위임 밖 외부 경계 → 별도 권한 기록과 별도 실행 증거 | M9, M6 |
| 32 | CODE-01 사람 중심 코딩 흐름 | project/folder → 검토된 diff·saved revision·검증 결과 | M10 |
| 33 | TERM-01 Terminal 뷰, 프로세스, 연결, 재실행 | optional Terminal entry → 검증된 reconnect/new/snapshot/unavailable | M17, M10 |
| 34 | ONT-01 Ontology가 관리하는 Agent 사이클 검사 | managed version·recorded cycle → projection-only inspection | M11 |
| 35 | ONT-02 관리되는 Ontology 아래에서 Agent 사이클 실행 | 권한상 허용된 request → bound version·transition·evidence | M11, M6 |
| 36 | COL-01 다른 사람이 Desk에 참여해 작업 | 공유 가능 Desk → 분리된 초대·수락·권한·행동 상태 | M12-R |
| 37 | CU-01 물리적 입력 충돌 없는 Desk 외부 computer-use | external action 필요 상태 → 해제된 input ownership과 독립 결과 증거 | M12-L, M12-R |
| 38 | DATA-01 설정, 로컬 영구 저장, 내보내기, 백업, 동기화 | local state → 검증된 `.egdesk` 결과 또는 승인 뒤의 remote 결과 | M13 |
| 39 | UX-01 포인터 없이도, 움직임에만 의존하는 단서 없이도 EG-Desk 핵심 흐름 사용 | keyboard/nonvisual entry → 동일 상태 전환과 조치 가능한 피드백 | M19, 전체 map |
| 40 | AGENT-01 Agent Profile을 검사하고 다음 실행에 사용할 revision 선택 | Profile 검사·편집 시작 → 다음 Run에 적용할 revision과 권한 경계 확인 | M6 |
| 41 | AGENT-02 요청마다 유효한 Run configuration 결합 및 도구 행동 검증 | 요청·Profile 후보 → 고정된 effective configuration과 검증된 행동·증거 | M5, M6, M9 |
| 42 | AGENT-03 model·tool·Profile 변경 뒤 Run 재시도·재개·분기 | 구성 불일치·비가용 상태 → lineage가 분명한 retry/resume/fork/stop | M6, M8 |
| 43 | SYS-01 runtime 경계 장애를 관찰된 범위까지만 진단하고 복구 | 경계 하나의 관찰된 장애 → 마지막 확인 상태와 반복 가능한 경계별 복구 | M2, M17 |
