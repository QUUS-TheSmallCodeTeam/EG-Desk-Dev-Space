# EG-Desk 기술 구현·상호작용·오케스트레이션 계약

**문서 목차**: [읽는 목적별 안내](../../docs/README.md#docs-start)

<a id="tech-contract-top"></a>

**English name**: EG-Desk Interaction and Orchestration Contract  
**Date**: 2026-09-08

**문서 역할**: UI에서 약속한 동작을 실제 상태·데이터·런타임·권한·오케스트레이션으로 성립시키는 기술 계약
**사용자 매뉴얼 정본**: [EG-Desk 가상 사용설명서와 제품 상호작용 Atlas](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-manual-start)
**설계 gap·사용자 질문 정본**: [EG-Desk 설계 Gap 및 사용자 확인 원장](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#gap-owner-queue)
**관련 문서 운영 원칙**: [EG-Desk 제품 문서 화자·운영 정본](../../docs/codex/egdesk-product-documentation-governance.md#doc-governance-top)
**현재 구현 상태**: 이 문서와 별도다. 계약에 적혔다는 사실은 구현·테스트·배포 완료의 증거가 아니다.

최종 EG-Desk 기능은 이 계약에 정의된 기술적 사실을 보장해야 한다.
특정 프레임워크·모듈명·클래스 구조·프로세스 개수는 제품 의미나 검증 결과가
요구하지 않는 한 고정하지 않는다. 반대로 데이터 동일성, 권한 격리,
과거 관찰 보존, 사용자 승인 경계처럼 구현 선택으로 바뀌면 제품 의미가 달라지는
사항은 기술 불변조건으로 고정한다.

<a id="tech-status-model"></a>

## 0. 기술 계약 범위, 구현 상태 및 양방향 탐색

### 0.1 결정 상태 범례

| 상태 | 의미 | 적용 방식 |
|---|---|---|
| `FIXED-PRINCIPLE` | 제품 의미를 지키기 위해 구현과 무관하게 유지해야 하는 원칙 | 만족하는 구현을 선택하되 원칙을 약화하지 않는다 |
| `SELECTED-BASELINE` | 현재 제품 방향에 가장 맞는 기본 기술 선택 | 더 나은 근거가 있으면 호환성·migration을 제시하고 변경 제안 가능 |
| `IMPLEMENTATION-DISCRETION` | 성능·유지보수성·병렬 개발 효율에 맞춰 유연하게 정할 영역 | 외부 레퍼런스와 측정 결과를 사용해 선택하고 결과만 계약에 맞춘다 |
| `OWNER-APPROVAL-REQUIRED` | 서버, 원격 전송, 비용, 새 credential/권한처럼 제품 소유자 승인이 필요한 경계 | 로컬 설계·mock·비교 조사는 계속하되 실제 프로비저닝·전송은 대기한다 |
| `OPEN-GAP` | UI와 기술 계약을 함께 만족시키는 제품 결정을 아직 내리지 못한 상태 | 임의 확정하지 않고 [설계 Gap 원장](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#gap-owner-queue)에 질문·영향·선택지를 기록한다 |

기술명은 그 자체로 제품 결정이 아니다. 예를 들어 SQLite는 현재 로컬 인덱스
기준선이지만, 과거 snapshot이 바뀌지 않아야 한다는 불변조건이 더 상위다.
별도 상태가 붙지 않은 본문 요구사항은 `FIXED-PRINCIPLE`로 읽는다. 문장이
“may”, “candidate”, “exact UI remains open”이라고 명시한 부분만 각각 구현 재량,
후보 또는 연결된 `HUM-*`/`Q-*` 미결정으로 읽는다.

§17의 방법·수치·interface 이름은 `SELECTED-BASELINE`인 위임 설계 기준선이다.
그 절에 연결된 인수 조건을 만족하는 동등 구현으로 바꿀 수 있으며 특정 module·언어·
process 배치를 불변조건으로 만들지 않는다. 권한·입력 충실도·수명·완료 의미는 그대로 유지한다.

<a id="tech-layer-map"></a>

### 0.2 기술 계층 지도

```text
제품 사용자 입력
  -> Firefox 기반 EG-Desk shell / Desk / Canvas / Chat / resource views
  -> interaction controller와 state projection
  -> context admission, permission, task graph, evidence services
  -> Agent engine adapter / tool runtime / resource runtime
  -> local metadata index + immutable object payload store

선택적 외부 경계
  -> provider account / website account / remote collaborator / sync service
  -> 별도 identity·authority·approval·receipt 검증
```

UI view, live resource, Agent Run, snapshot, 저장 record는 서로 같은 객체가 아니다.
개별 화면을 닫은 뒤에도 다른 Canvas 표현이 소유하는 runtime과 보존된 snapshot은
남을 수 있다. Board 닫기의 종료 범위는 [§1](#tech-desk-lifecycle)을 따른다.
화면이 보인다는 사실만으로 외부 행동 성공·영구 저장·Agent 전달이 증명되지는 않는다.

<a id="tech-stack-baseline"></a>

### 0.3 기술 stack 기준선

| 영역 | 현재 상태 | 계약 |
|---|---|---|
| 제품 shell | `SELECTED-BASELINE` | Firefox 기반 EG-Desk 전환을 기준으로 한다. Firefox 내부 결합 방식과 UI 모듈 구조는 `IMPLEMENTATION-DISCRETION`이다. |
| UI 구성 | `IMPLEMENTATION-DISCRETION` | HTML/CSS/JS, Web Components, 상태 관리 라이브러리 등은 여러 Agent가 독립 수정·검증하기 쉬운 경계를 근거로 선택한다. 거대 단일 파일이나 특정 프레임워크는 계약 제약이 아니다. |
| Agent engine boundary | `FIXED-PRINCIPLE` | 제품은 engine adapter 경계를 가지며 Run은 사용한 engine/profile/version을 고정한다. Codex용 현재 기준선은 rich-client 인증·대화·승인·stream event를 제공하는 [Codex App Server](https://developers.openai.com/codex/app-server)다. |
| Agent 사용 모드 분리 | `FIXED-PRINCIPLE` | 2026-11-25 owner 확인(3회 정정). EG-Desk '위'(사용자와의 대화까지: 채팅 하네스, 도구 호출, 브라우저 조작, 컴퓨터 조작, Desk·Board·카드)와 EG-Desk '아래'(EG-Desk Ontology가 적용된 Agent 엔티티가 셋업된 상태)를 분리하고 두 방식의 기억을 섞지 않는다. 상세는 [사용 모드 분리](#tech-usage-modes)다. |
| Codex 인증 | `SELECTED-BASELINE` | 구독 quota를 쓰는 Engine Profile은 ChatGPT managed browser login을 기본으로 한다. API key는 별도 profile이다. App Server의 active account·`planType`·rate-limit 상태를 검증하고 Run에 profile ID를 고정한다. |
| Engine Profile 격리 | `SELECTED-BASELINE` | 서로 다른 AI 계정은 App Server process/config/credential store를 profile별로 격리한다. EG-Desk 로그인, AI 구독 계정, 웹 리소스 계정은 같은 identity로 합치지 않는다. |
| 로컬 구조화 데이터 | `SELECTED-BASELINE` | SQLite가 conversation event, 관계, 상태 전이, manifest, 인덱스와 작은 텍스트를 관리한다. ORM·query builder·migration 도구는 `IMPLEMENTATION-DISCRETION`이다. |
| snapshot payload | `FIXED-PRINCIPLE` + `SELECTED-BASELINE` | 불변 byte payload는 content-addressed object store에 저장하고 SQLite는 hash·manifest·lineage를 가리킨다. 텍스트와 binary 모두 같은 무결성 규칙을 쓴다. |
| 로컬 내보내기 | `SELECTED-BASELINE` | 사람이 옮길 수 있는 단일 `.egdesk` bundle을 제공한다. manifest, JSONL event, 읽기 쉬운 Markdown, 필요한 object payload를 포함하고 token·cookie·기기 절대경로는 제외한다. container 세부 형식은 `IMPLEMENTATION-DISCRETION`이다. |
| helper/bridge/runtime 언어 | `IMPLEMENTATION-DISCRETION` | Rust, JavaScript 또는 다른 선택은 session 동일성, cancellation, stream backpressure, crash recovery를 측정해 결정한다. 언어 선택만으로 연결 지속성을 주장하지 않는다. |
| 다중 PC의 업무 실행 | `FIXED-PRINCIPLE` | 하나의 Canvas 기반 Board가 여러 PC의 자료·실행 자원을 연결할 수 있다. 화면을 보는 PC와 실행하는 PC를 구별하며 실제 실행 위치·계정·권한·결과를 연결한다. 단일 PC 또는 폴더 하나를 Board의 경계로 고정하지 않는다. |
| 동기화·원격 협업의 실제 인프라 | `OWNER-APPROVAL-REQUIRED` | 다중 PC 제품 방향과 별도로 서버, 원격 저장, 외부 전송, 비용 발생의 실제 구성을 승인받는다. 자원·권한·연결 끊김·충돌·복구 설계와 로컬 검증은 계속할 수 있다. |
| 검증 도구 | `IMPLEMENTATION-DISCRETION` | unit·integration·UI/runtime 검증을 조합하되 Atlas의 정확한 입력과 완료 증거를 재현해야 한다. |

App Server 관련 세부사항은 변동 가능한 외부 인터페이스다. 구현 시 공식 문서를
다시 확인하고, `account/login/completed`만으로 끝내지 말고 `account/updated` 또는
`account/read`에서 실제 auth mode·계정·plan을 확인한다. 브라우저 callback은 공식
프로토콜이 제공하지만, EG-Desk의 account-container 격리와 focus 복귀 UX는 제품이
별도로 구현·검증한다.

<a id="tech-ui-trace-map"></a>

### 0.4 Atlas ↔ 기술 계약 빠른 이동

| 사용자 매뉴얼에서 시작 | 기술 계약 | 되돌아갈 대표 trace |
|---|---|---|
| 실행·Desk 복원·Board | [§1 저장 수명주기](#tech-desk-lifecycle) | [L-01–L-03](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-l-01), [AG-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ag-01) |
| 요청 context·큰 파일 읽기 | [§2 context 조립](#tech-context-assembly), [§2.1 Smart Read](#tech-smart-read), [§2.2 Reader Session](#tech-reader-session), [§2.3 내부 분할](#tech-reader-orchestration), [§2.4 recovery](#tech-read-recovery) | [READ-01–03](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-read-01), [AI-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-01) |
| 출처·계정·권한 | [§3 identity 분리](#tech-resource-identity), [§14.1 Engine Profile](#tech-engine-profile) | [TOOL-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-tool-01), [BROWSER-02](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-browser-02) |
| Chat·활동 표시·Snapshot/Live | [§4 Answer projection](#tech-answer-projection), [§4.1 관찰 보존](#tech-observation-fidelity) | [CHAT-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-chat-01), [AI-04](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-04) |
| 다중 Agent·의존성·승인 | [§5 공유 대화](#tech-multi-agent-chat), [§9 의존성](#tech-dependency-orchestration), [§11 병렬 output](#tech-parallel-agents) | [AI-03](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-03), [AI-06](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-06), [AI-07](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-07) |
| 사람 중심 코딩·Terminal | [§6 코딩 표면](#tech-coding-surface), [§7 Terminal](#tech-terminal-runtime) | [CODE-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-code-01), [TERM-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-term-01) |
| 답변 브리핑 | [§8](#tech-answer-briefing) | [AI-05](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-05) |
| Ontology | [§10](#tech-ontology-runtime) | [ONT-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ont-01), [ONT-02](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ont-02) |
| 협업·computer-use | [§12](#tech-collaboration-computer-use) | [COL-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-col-01), [CU-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-cu-01) |
| 조직의 Board 공유·여러 PC 실행 | [§12.2 조직 실행 경계](#tech-org-execution) | [조직 사용](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-org-use), [조직 전달 우선순위](./EGDESK_VISION_GAP_LEDGER.md#org-delivery-priority) |
| 실패·복구 | [§13](#tech-failure-boundaries) | [SYS-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-sys-01) |
| Profile·Run binding | [§14](#tech-agent-run-binding) | [AGENT-01–03](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-agent-01) |
| 로컬 저장·내보내기·동기화 | [§15 로컬 저장](#tech-storage-export), [§15.1 `.egdesk`](#tech-portable-bundle) | [DATA-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-data-01) |
| 접근성·동등 control | [§16](#tech-accessibility) | [UX-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ux-01) |

<a id="tech-desk-lifecycle"></a>

## 1. 저장된 Board와 자동 Desk session 복원

저장된 Board, 자동 Desk session 복원, live runtime 연속성은 서로 다른
수명주기를 가진다.

Board는 특정 업무를 진행할 수 있게 자료·도구·대화·배치·참조 연결을 갖춘 구성이다.
저장 payload는 그 구성을 재구성할 참조와 배치를 보존한다. 이름만 붙인 자료 목록으로
축소하지 않으며, Canvas 전체나 Kanban형 메모판으로도 취급하지 않는다. runtime
프로세스 자체나 현재 권한을 복사한 것으로도 취급하지 않는다.

<a id="tech-first-use"></a>
### 1.0 최초 Browser 진입과 기본 Codex

최종 제품은 Firefox/Gecko 기반의 독립 EG-Desk 배포를 목표로 한다. 현재 Firefox에 UI를
주입하는 POC는 검증 단계이며 사용자 매뉴얼의 영구 설치 전제가 아니다. Firefox 바이너리
번들과 자체 UI의 배포, 필요시 소스 fork·Gecko patch를 구별한다. fork의 필수화는 하지 않는다.
[배포 경로](./FIREFOX_SHELL_ROADMAP.md).

**화면 연결**: [최초 시작](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-first-use),
[첫 사용 상세](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#flow-first-use).

앱 준비, Browser 안의 선택적 첫 사용 안내, 기존 세션 복원, EG-Desk 프로필 준비,
Codex 인증은 각각 식별한다.
최초 실행에는 이미 있는 Desk·Canvas의 동일 live Browser View를 카메라로 화면에
맞춰 보여 준다. 별도 앱 시작 관문은 없다. `[Desk 시작]`은 이미 열린 Desk의 주변을 드러내는 선택 조작이지 웹 사용을 위한 필수 단계가 아니다. Browser 안의 주소
입력을 돕는 시작 페이지는 이 View의 콘텐츠로 허용한다. 주소 탐색은 바로 가능하며 주변
Canvas·Sidebar·Dock만 집중 표시 동안 가린다. Desk를 보여 주기 위해 Engine 인증이나
새 Browser·EG-Desk 프로필 생성을 강제하지 않는다. 초기 프로필 연결과 구독 Codex 호출은
인터넷을 전제로 하되 Desk 표시와 별개로 다룬다. Codex 호출처럼 실제 연결이 필요한
기능에서만 해당 계정·가용성을 확인한다. 네트워크 장애를 로컬 저장물 삭제나 강제 새
프로필 생성의 근거로 쓰지 않는다.

일반 Canvas 줌아웃 입력은 Browser 집중·주소 입력 상태에서도 사용할 수 있어야 하며,
Browser의 page zoom이 아닌 같은 Desk의 camera transform만 바꿔 주변 Canvas를 점차
드러낸다. 첫 사용에는 이전 일반 시점이 없어도 기본 Canvas 시점으로 축소할 수 있고,
저장된 일반 시점이 있으면 복귀·재방문에 활용할 수 있다. Browser에 다시 집중해도 View
identity·URL·세션·Browser logical viewport·page zoom을 유지한다. 카메라 fit은 View의
logical rectangle에 맞추며 Browser renderer나 내부 viewport의 실제 resize를 일으키지
않는다. 인증 화면이 별도로 열렸다면 완료·취소·늦은 응답은 해당 연결 요청 ID에만 결합하고
다른 프로필이나 현재 Desk 시점을 바꾸지 못한다. 최초 사용 여부를 저장된 Board 유무만으로
추론하지 않는다.

기본 Codex는 사용자 정의 Agent Profile 없이 실행할 수 있다. Engine 인증·실행 계정·
모델·도구 가용성·위임·승인·입력 기록은 필수지만, personality·담당자 정체성·Agent 생각
버블을 만드는 것은 첫 요청 조건이 아니다. 사용자 생성 Agent를 선택하면 해당 Profile과
생각 공간이 추가된다. 기본 Codex 실행을 `Profile 없음` 오류로 막거나, 이를 피하려고
숨은 사용자 인격체를 자동 생성하지 않는다. [실행 binding](#tech-agent-run-binding).

Codex 로그인 뒤 기기 내 Browser 프로필을 자동 준비하는 방식은 연결 후보이며,
EG-Desk 온라인 회원 인증이 자동 성립한다는 뜻은 아니다. 채택 여부와 첫 Browser 자료의
귀속은 [HUM-ENGINE-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-engine-001)에 둔다.
실제 서버·identity 공급자 도입은 별도 승인 경계를 유지한다.

### 1.1 저장·화면·실행의 독립 수명

```text
저장된 Board
  사용자가 명시적으로 저장하고 다시 열 수 있는 재사용 가능한 작업 결합
  자동으로 mount되지 않은 채 Sidebar의 Board 영역에 목록으로 표시
  정확한 구성원·필수 field·저장 범위는 HUM-AGENDA-001·Q-AG-02·Q-AG-08에서 미결정
  Board 열기는 시작 전제조건이 아니라 사용자 행동

자동 Desk session
  Desk에 열어 둔 상태를 보존하는 로컬 기록
  열린 view·위치·크기·grouping과 그 밖에 결정된 session 세부
  사용자가 Board를 한 번도 저장하지 않았어도 존재 가능

live view/runtime 상태
  mount된 Browser·File·Chat·Terminal view
  그 아래 browser context·process·app·connection이 아직 존재하는지 여부
```

기본 topology는 하나의 Desk와 그 Desk에 속한 하나의 Canvas다.

```text
EG-Desk app session
  -> Desk [1]
     -> Canvas [1]
        -> Board projection [0..n]
        -> Board에 속하지 않은 자동 복원 view [0..n]
```

여러 Saved Board는 같은 Canvas에 동시에 열 수 있다. Board를 연다는 이유로 기존
Canvas projection을 교체하거나 새 Desk를 만들지 않는다. 이미 열린 Board는 그
projection을 재사용해 focus하고, 닫혀 있으면 새 projection을 같은 Canvas에 만든다.
정확한 초기 위치·겹침 회피·활성 표시만 세부 UI 결정으로 남는다. 다중 Desk는
Board 분리나 메모리 최적화 수단이 아니다.

위 topology는 사용자가 보는 작업 공간의 관계이며 물리 PC 한 대의 제한이 아니다.
Board는 여러 PC에 있는 자료와 실행 자원을 연결할 수 있고 폴더는 그중 하나의 자원이다.
같은 Canvas에서 본다는 이유만으로 PC별 파일 경로·업무 계정·실행 권한·live session을
공유하거나 복제하지 않는다. 실행 위치와 연속성은 [§12](#tech-collaboration-computer-use)를 따른다.

Board의 제품 의미는 [HUM-AGENDA-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001),
연결된 세부 항목은 [Q-AG-02](../../docs/codex/egdesk-product-documentation-governance.md#atlas-q-ag-02)와
[Q-AG-08](../../docs/codex/egdesk-product-documentation-governance.md#atlas-q-ag-08)에서 추적한다.

자동 Desk session을 영속화해도 저장된 Board가 생성되거나 갱신되지 않는다. 데이터
모델은 두 수명주기를 분리해야 한다. 다만 정상 시작에 recovery wizard, 항목별 출처
badge 또는 눈에 보이는 “Board revision 대 recovery journal” 검사 단계가 필요한 것은
아니다.

예상 재실행 흐름은 다음과 같다.

```text
운영체제의 app 진입점에서 EG-Desk 실행
-> 이전 Desk의 집중/Canvas 표시 상태를 복원 (최초 온보딩과 구별)
-> 완료 순서를 강제하지 않는 두 독립 projection 시작
   자동 Desk session
     -> 브라우저 tab/session restore처럼 이전 Desk session에 열어 둔 view 재구성
   저장된 Board 영역
     -> Board를 mount하지 않고 Sidebar Board 목록 채우기
-> 각 하위 resource를 자체 수명주기에 따라 복원
-> 필수 복원 확인 절차 없이 사용자가 계속 작업할 수 있게 함
```

내부 시작 작업의 완료 순서는 제품 우선순위를 뜻하지 않는다. 목록에 나타났다는
이유만으로 저장된 Board를 mount해서는 안 된다. 이미 복원된 Desk에서 Board를
클릭하면 같은 Canvas에 Board projection을 추가하거나 이미 열린 projection을 focus한다.
자동 복원 view와 다른 Board projection은 교체하지 않는다.

Board 닫기는 단순히 UI만 숨기는 background 전환이 아니다. System은 다음 순서를
하나의 수명주기 전이로 처리한다.

```text
Board close
  -> 닫을 Board projection과 영향받는 runtime ownership을 먼저 식별
  -> 도달 가능한 제어 경계에서 해당 Board만 소유한 runtime의 새 행동·자동 재개를 막고 종료 요청
  -> 종료 확인까지 해당 작업의 Canvas 표현과 종료 진행 상태 유지
  -> 종료가 확인된 Board projection 제거
  -> 다른 Canvas projection이 소유·표현하는 shared runtime은 유지
  -> Saved Board와 저장된 revision은 유지
```

사용자 또는 Agent의 의미 있는 작업을 Canvas에서 지운 채 hidden registry에서만 계속
실행하는 `close-but-background` 상태는 만들지 않는다. background 실행이 유지되려면
다른 Canvas projection이 그 작업의 소유·상태를 계속 표현해야 한다.
종료 실패나 완료 여부를 확인할 수 없는 작업을 이미 닫혔다고 표시하지 않는다.
원격 제어 경계에 도달하지 못하면 종료 요청과 마지막 확인 상태를 보존한다.
이미 외부로 dispatch한 요청은 접수·완료 여부가 미확인인 경우까지 포함해 로컬 Board
닫기로 취소됐다고 간주하지 않는다. 요청과 마지막 확인 상태를 기록한다. shared runtime의 소유 범위와 재개·예약 실행의
세부 종료 의미는 [HUM-SURFACE-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001),
[HUM-ORCH-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001)에 남는다.

Browser view 재구성과 Terminal 연속성은 다르다. Browser view는 이전 URL과 사용할
수 있는 browser-session 상태에서 재구성할 수 있다. Terminal은 같은 process 또는
session identity가 검증된 경우에만 재연결됐다고 표현할 수 있다. 새 process 시작은
reconnect가 아니라 revive/relaunch이고, live process 없이 출력만 복원하면 snapshot이다.

Board 열기, 복원된 view 닫기, Desk view를 Board에 연결하기, Board 갱신하기의
정확한 control에는 실제 영역·component·label·gesture와 보이는 상태 전이가
필요하다. 아직 결정되지 않은 control은 포괄적인 “유지”, “폐기”, “저장” 단계로
간주하지 않고 연결된 `Q-*` 상태를 유지한다.

<a id="tech-context-assembly"></a>

## 2. Context 조립

기본 Codex와 사용자 생성 Agent의 Run은 명시적으로 선택된 Board만 사용해서도, Desk 전체를 말없이 주입해서도
안 된다.

context resolver는 다음을 조합한다.

```text
명시적으로 선택한 대화·Task·사용자 선택 항목
가장 잘 맞는 저장된 Board
일시적인 Desk grouping과 공간 layout
현재 보이거나 focus된 resource
최근의 관련 상호작용 상태
account·permission·execution scope
```

context resolver는 System service다. 허용된 제품·runtime 상태를 읽고 범위가 제한된
context snapshot을 만든다. 첫 모델 호출 전에는 현재 정책과 자료를 결합하고, 이후
모델 호출 전에는 관련 도구 결과·사용자 조정·새 관찰을 다음 context revision에 포함한다. 이 과정을
Agent가 암묵적인 API 호출로 Desk·Board store·layout·account registry를 직접 읽는
것처럼 서술하지 않는다.

공간 grouping·거리·focus·layout은 relevance signal이지 그 자체로 영속 사실이나
증거가 아니다. Run은 어떤 signal과 resource를 선택했는지 기록하여 사용자가
context를 검사하거나 수정할 수 있게 한다.

Agent 담당자 방은 비공개 관계로 남을 수 있다. 작업이 공유 작업 context에 속하면
선택한 메시지·Canvas Memo reference와 그 context만 아직 결정되지 않은 workroom·
Thread·Board 관계가 채택한 공유 대화 형태에 연결하거나 옮길 수 있다. 담당자 방
전체 history를 하나의 모델 context나 공유 범위로 취급하지 않는다.

<a id="tech-output-situation"></a>
### 2.0 작업 지시·생각 공간·산출물의 문맥 경계

작업 제약, 참고자료, 내부 작업 메모·공개 가능한 계획/판단 요약, 사용자 설명,
고객에게 전달할 산출물 본문은 역할을 구분해 결합한다. 읽기 권한이 있거나 같은 기록
패널에서 보인다는 사실만으로 모든 내용을 산출물 작성 입력이나 공유 범위에 넣지 않는다.

산출물 쓰기·게시 요청에서는 화자, 독자/수신자, 목적, 출력 위치, 포함할 내용·출처 범위와
적용할 제약을 식별할 수 있어야 한다. 사용자 지시를 그대로 본문으로 옮기는 대신 해당
출력 상황의 제약으로 적용한다. 내부 수정 메모나 작업 계획은 별도 설명 요청·공개 범위가
없는 한 고객용 본문에 자동 포함하지 않는다. 구체 필드명·구현 모듈은 이 경계를 만족하는
범위에서 선택한다. [사용자 화면의 구분](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-output-situation).

출력 경로는 본문과 작업 기록의 자동 혼합을 막고, 전달 대상과 내용의 일치 여부를 검사할
근거를 남긴다. UI 패널 분리나 자동 검사만으로 모든 문장·판단의 정확성을 보장하지 않는다.
요청·읽기 근거·산출물·사용자 교정의 연결은 사후 개선의 자료가 되지만, 보존했다는 이유로
새 장기 기억·학습·외부 전송을 자동 실행하지 않는다. 기억·공유 정책은 기존 HUM을 따른다.

<a id="tech-smart-read"></a>

### 2.1 Context admission과 Smart Read

Smart Read는 읽기·편집·전달 방법이고 immutable source는 당시 원문을 바뀌지 않는 자료로
보존하는 원칙이다. 서로 같은 기능이 아니며, 보존 위치가 Canvas인지 생각 공간인지와도
독립적이다. 같은 원문을 다른 관점으로 다시 읽을 때는 원문 참조를 유지하고 새 전달 결과를
만든다. 최신 원문을 읽는 경우에는 새 원문 revision을 연결하며 과거 답변 근거를 덮지 않는다.

**지원 UI trace**: [READ-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-read-01), [READ-02](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-read-02), [AI-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-01)

큰 파일을 다루는 Reader는 요청 담당 Agent의 비교·판단·최종 답변 업무를 넘겨받는 일반
subagent가 아니다. 여기서 **요청 담당 Agent**는 현재 사용자 요청과 사용자 대상
Answer를 책임지는 Run-level 역할을 뜻한다. 별도 영속 제품 객체가 아니며,
여러 Agent가 기여하면 integration 기능이 이 책임을
이어받을 수 있다. Reader는 기존 file-read가 요청 담당 Agent의 context를 넘칠 때도 원문을 지능적으로
읽을 수 있게 하는 **도구 계층의 read session**이다.

처리 순서는 다음과 같다.

```text
요청 담당 Agent가 file-read / smart-read / smart-query 호출
-> System이 요청 의도, 첨부 수·형식·크기, 예상 반환량,
   요청 담당 Agent의 남은 context와 이미 예약된 답변 공간을 함께 계산
-> 현재 요청 담당 Agent에 직접 넣을지 Reader Session으로 보낼지 결정
-> Reader가 필요하다고 결정된 뒤에만 대상 모델/session 설정을 보고
   한 Reader가 원문 전체를 받을 수 있는지 또는 내부 분할이 필요한지 결정
-> admission을 통과한 Context Packet만 요청 담당 Agent의 Run transcript에 추가
```

첫 판단을 `파일 byte 수 < 남은 token 수` 같은 단일 비교로 구현하지 않는다.
텍스트·이미지·PDF·표의 해석 비용, 여러 첨부 간 참조, 예상 search hit 수, 현재
대화의 필수 보존 구간, tool-call overhead와 답변 여유를 함께 고려한다. 이 정책의
구체적인 estimator·threshold·모델은 `IMPLEMENTATION-DISCRETION`이지만, 결정 이유와
선택한 read mode는 Run 기록에 남아야 한다.

요청 범위와 요청 담당 Agent의 context admission은 서로 다른 축이다.

| 요청 형태 | 읽기 범위 | 요청 담당 Agent로 들어가는 값 |
|---|---|---|
| “이 파일을 읽고 요약해줘”처럼 전체 검토가 필요한 요청 | 원문 전체 coverage | 직접 읽기가 안전하면 원문/도구 결과, 아니면 Reader가 원문 전체를 검토해 만든 Context Packet |
| “A 파일의 X와 B 파일의 Y를 합쳐줘”처럼 목표가 구체적인 요청 | 조건에 맞는 targeted retrieval을 먼저 수행 | hit가 작으면 검증 가능한 원문 조각, 크면 전체 hit set을 Reader가 검토한 Context Packet |
| 명시적인 `raw_search` 또는 direct bounded read | 호출 계약이 정한 전체 결과 | 결과가 요청 담당 Agent로 반환되며 잘림이 있다면 도구 계약 자체가 범위와 continuation을 표시 |
| 내부 `smart_read` / `smart_query` | System과 Reader pipeline의 내부 원시 결과 | 원시 hit를 요청 담당 Agent에 쏟지 않고 admission을 통과한 packet; 원시 결과와 packet lineage는 보존 |

검색 키워드로 중요하지 않아 보이는 부분을 몰래 버리거나, 요청 담당 Agent가 일반 업무를
Reader에게 양도했다고 표현하지 않는다. targeted retrieval은 사용자가 지정한
관점에 따른 읽기 전략이며, 최종 비교와 판단은 요청 담당 Agent가 계속 소유한다.

<a id="tech-reader-session"></a>

### 2.2 Reader Session과 재호출

**지원 UI trace**: [READ-03](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-read-03)

Reader Session은 다음을 함께 고정한다.

- 읽은 source snapshot 또는 immutable object hash;
- 형식·section·page·row·symbol 등 source shape index;
- 적용한 read intent와 query;
- 원문 coverage와 각 claim의 source span;
- 요청 담당 Agent에 반환한 Context Packet revision;
- 읽기 실패가 아니라 아직 진행 중인 partition과 continuation state.

요청 담당 Agent가 결과에 만족하지 않거나 현재 업무에 특수한 관점이 필요하면 같은 Reader
Session을 다시 호출해 read intent를 수정할 수 있다. Reader는 이전 요약만 다시
요약하지 않고 고정된 원문 snapshot과 index로 재진입해 새 Context Packet revision을
만든다. 이전 packet은 덮어쓰지 않고 `supersedes` 또는 `refines` 관계로 남긴다.

파일 교체나 최신 원문 재조회는 read intent만 바꾸는 경우와 구별한다. 새 byte에는
새 snapshot과 coverage를 연결하고 이전 원문·packet을 보존한다. 논리적 Reader Session을
유지하거나 연결된 후속 session을 만드는 방법은 구현 재량이지만, 다른 원문의 coverage를
그대로 승계하거나 기존 hash 뒤의 내용을 교체해서는 안 된다.

Context Packet에는 최소한 `source snapshot`, `read intent`, `coverage`, `selected
spans`, `summary/structure`, `omission policy`, `lineage`, `reader session/revision`이
있다. 원문의 모든 byte를 요청 담당 Agent에게 다시 넣지 않아도, 요청 담당 Agent와 사용자가 어떤 범위를
어떤 이유로 읽었는지 추적하고 필요한 부분을 원문 snapshot에서 다시 열 수 있어야
한다.

<a id="tech-reader-orchestration"></a>

### 2.3 한 Reader context보다 큰 단일 자료

**지원 UI trace**: [READ-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-read-01), [READ-03](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-read-03)

하나의 원문 자체가 새 Reader Session의 context보다 크면 오케스트레이션 대상은
여전히 **file-read 하나**다. System은 section/page/row/symbol처럼 의미가 끊기지 않는
단위로 전 범위를 배정하고, 필요한 소량 overlap을 두며, 모든 partition 결과를
상위 Reader가 재귀적으로 통합한다. 어떤 partition도 키워드 점수만으로 미배정하지
않는다.

```text
one immutable source snapshot
  -> complete partition manifest
  -> bounded Reader children, each with assigned coverage
  -> coverage-checked intermediate packets
  -> recursive compaction when needed
  -> 요청 담당 Agent가 받는 하나의 재개 가능한 Reader Session 결과
```

별도 “Coverage Agent”를 제품 역할로 만들 필요는 없다. coverage는 manifest와
orchestrator가 계산하는 검증 상태다. 모든 partition이 성공하지 않으면 `full review
complete`를 성립시키지 않는다.

<a id="tech-read-recovery"></a>

### 2.4 판독 실패와 recovery

**지원 UI trace**: [READ-03](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-read-03), [SYS-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-sys-01)

context overflow, 예상 반환량 초과, 한 Reader에 들어가지 않는 크기는 판독 불가가
아니다. System이 범위 축소, continuation, Reader 전환 또는 내부 분할을 자동으로
시도한다. 실제 오류 상태는 암호화·손상·권한 상실·지원되지 않는 형식·판독 불가능한
스캔처럼 원본을 기술적으로 읽지 못한 경우다.

자동 recovery는 안전하고 bounded한 순서로 진행한다: 기존 parser 재시도 → 대체
parser/encoding/OCR → 권한·source revision 재검증 → 가능한 partition만 보존. 복구가
끝나지 않으면 해당 source에 의존한 Task branch만 blocked로 두고 독립 작업은 계속한다.
비밀번호, 로그인, 권한 승인, 더 나은 원본, 유료 OCR/외부 업로드가 필요할 때만
영향받은 source·Task에 `사용자 조치 필요` 상태와 가능한 다음 행동을 Chat/Canvas에
투영한다. 사용자 조치 요청은 영향받은 Run·Task와 연결되는 상태이며, 별도 영속
`approval queue` 제품 객체를 요구하지 않는다. 정확한 묶음·레이블·노출 시점은
[HUM-READ-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-read-001)에
남기되, 새 credential·외부 전송·비용은 해당 Run의 `approval-required` 권한 흐름을
통과하고 독립 Task는 계속한다.

<a id="tech-resource-identity"></a>

## 3. Source·Content·Resource·View·Authority의 구분

EG-Desk는 다음 차원을 서로 구분해 보존해야 한다.

| 차원 | 의미 |
|---|---|
| source/evidence reference | 주장이나 결과가 어디에서 왔는지 |
| content identity | 관찰한 byte 또는 의미 내용이 같은 revision인지 |
| resource identity/locator | 대상으로 삼은 URL·파일·대화·database row·runtime resource |
| access/execution context | account·browser profile·permission·가능한 action |
| view/runtime instance | 현재 보여 주는 특정 Desk Window·browser context·terminal attachment·app session |

`SourceRef`는 기존 EG-Desk reference primitive이지만, 다섯 차원을 의미상 하나로
만들어서는 안 된다. 최종 schema는 별도 record를 조합하거나 연결할 수 있다.

두 account가 같은 주장을 뒷받침하는, 검증상 동일한 content를 보여 줄 수 있다.
이때 content evidence는 동등하게 취급할 수 있다. 그러나 숨은 데이터·미래 상태·
가능한 action·audit identity·permission은 여전히 다를 수 있다. 따라서 read/evidence
재사용은 content 또는 canonical resource를 기준으로 중복 제거할 수 있지만, action은
항상 실제 execution context에서 권한을 확인하고 기록해야 한다.

<a id="tech-answer-projection"></a>

## 4. Chat과 Canvas에 걸친 하나의 Answer

Chat과 Canvas는 서로 다른 두 답을 놓고 경쟁하는 곳이 아니라 하나의 Answer를
각 매체에 맞게 투영하는 두 표면이다.

```text
하나의 사용자 요청
  -> 1개 이상의 Run·Task·Agent contribution·중간 Result·artifact 가능
  -> 사용자에게 응답하는 시점마다 하나의 논리적 Answer revision으로 통합
     -> Chat projection: 대화형 설명·결론·결정·다음 행동
     -> Canvas projection: 공간형·시각형·상호작용형 또는 artifact 중심 표현
     -> 공유 provenance·source binding·Run identity·navigation
```

요청 담당 Agent 또는 integration 기능은 Answer 내용과 매체 구성을 제안한다. System은
지원 가능성·권한·provenance·render 상태를 검증하고, 제품 사용자는 정해진 UI에서
연결된 표현을 열거나 focus하고 구성을 재요청·재정의할 수 있다. 정확한 기본 구성과
override 범위는
[HUM-ANSWER-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-answer-001)에
남긴다. 같은 긴 본문을 두 표면에 그대로 붙여 넣지 않으며, 대화가 가장 명확한 답인
상황에서 Chat을 단순 알림으로 축소하지 않는다.

result chip은 연결된 결과·view·Answer Briefing을 focus하거나 여는 간결한 Chat UI
affordance다. chip 자체는 영속 product-domain object가 아니다. 연결된 artifact·Run·
message·view는 영속 객체일 수 있다.

Chat 안에는 작업 상태를 말로만 전달하지 않도록 contributor·Task 상태·의존성·결과를
가볍게 요약한 projection을 둘 수 있다. 이 표현은 자체 상태 기계를 갖거나 Canvas
상태를 복제하지 않고, 안정적인 reference로 Canvas의 정본 Task·Result·Agent activity
projection을 연다. 정확한 capsule·peek·inline 배치와 정보 밀도는 UI 결정으로 남는다.

Canvas annotation은 두 의미를 구분한다.

```text
visual mark
  target 또는 Canvas geometry + author/provenance + accept/reject + persistence

Canvas Memo
  target 또는 Canvas position + 사용자 본문 revision
  + 작성자 identity가 분리된 짧은 Agent reply
  + 선택적인 Agent-room message reference
```

Agent reply가 사용자 Memo 본문을 수정해서는 안 된다. 짧은 답으로 오해할 위험이
있거나 정보가 부족하면 Agent는 관련 담당자 방에 Memo의 stable reference를 포함한
message·mention을 만들 수 있다. 이 행동은 Canvas focus를 바꾸거나 Memo 안에서 긴
대화를 자동 시작하지 않는다. Agent 방에서 후속 요청을 실제 전송할 때는 원 Memo
revision과 anchor를 새 context 후보로 검증한다. 정확한 작성·mention·편집·삭제 UI와
지속 범위는 `Q-MEDIA-06`, `Q-MEDIA-13`에서 남는다.

일부 rendering 실패가 Answer 전체를 지워서는 안 된다. Canvas rendering이 실패하면
Chat은 Answer를 유지하고 다시 rendering할 수 있게 한다. Chat rendering이 실패하면
연결된 Canvas output과 Run record를 복구할 수 있어야 한다.

<a id="tech-observation-fidelity"></a>

### 4.1 실시간 Agent 활동, 관찰 충실도와 Answer materialization

사용자 생성 Agent가 응답을 준비하는 동안 Chat에는 작은 ellipsis 생각 버블과 접근 가능한
`Agent 작업 중` label을 표시한다. 기본 Codex는 일반 대화의 진행·기록 진입점을 사용한다.
도구 호출마다 대화 메시지나 Canvas 카드를 자동 추가하지 않는다. 생각 버블은 숨은
chain-of-thought나 별도 실행체가 아니라 공개 가능한 기록의 진입점이다.

사용자가 생각 버블을 선택하면 해당 Agent·업무의 기록 패널을 연다. 기본 Codex의 기록도
동일한 저장·권한 경계를 따른다. 기록 열기만으로 Canvas 카메라·입력권·대화 스크롤을 바꾸지
않고 새 모델 호출을 만들지 않는다. `[현재 작업 화면]` 등 명시적 대상 이동만 Canvas를
focus한다. 현재 작업 대상에는 실제 resource·operation에 연결한 Agent 배지·윤곽을 표시하되
사용자의 콘텐츠 활성 표시와 구별한다. 과거 원문을 읽는 동안 현재 Live가 같은 내용인 것처럼
표시하지 않는다. 대상 없는 계산·메모에 가짜 Browser·Terminal을 생성하지 않는다.

resource 또는 session binding만으로는 충분하지 않다. 연결된 파일·페이지·terminal·
API response·desktop은 Agent가 사용한 뒤 바뀔 수 있다. 따라서 EG-Desk는 과거
관찰과 현재 live state를 분리한다.

```text
tool-call 당시의 source 또는 runtime
  -> 불변 raw capture 또는 정확한 named tool result
  -> 선택적인 명시적 transformation / Reader Context Packet
  -> 불변 Agent-delivered projection
  -> 읽기 전용 Snapshot View

현재 시점의 같은 source 또는 runtime
  -> 상호작용 가능한 Live View

Snapshot View + Live View
  -> 지원되는 경우 명시적 비교
```

**Agent Observation Snapshot**은 둘 이상의 payload role을 보존할 수 있는 manifest다.

```text
raw/source capture
  이름이 지정된 capture 경계에서 생성된 정확한 byte·text range·screenshot·DOM·
  command output·search-hit set 또는 다른 결과

agent_input / delivered projection
  EG-Desk가 해당 Agent Runtime에 넘긴 정확한 application payload

preview / semantic extract
  선택적인 renderer 친화형 또는 검색 가능 표현
```

직접 범위를 지정한 file-read에서는 보통 일대일 경로를 따른다. named tool이 40–80행을
반환했다면 그 이름 붙은 결과 전체를 전달하고 두 integrity reference가 일치한다.
그 반환값을 선언한 **뒤에** EG-Desk가 말없이 잘라내거나 요약하거나 더 작은 subset을
선택해서는 안 된다.

Smart Read는 이름이 붙는 경계가 다르다. 전체 파일 raw capture나 큰 search-hit set은
내부 Reader pipeline에 속할 수 있고, 요청 담당 Agent는 context admission을 통과한 Reader Context
Packet을 받는다. Snapshot은 두 payload role과 명시적인 transformation/coverage
lineage를 함께 보존한다. 요청 담당 Agent가 raw capture 전체를 받았다고 주장해서도
안 되고, 그 Agent의 context에는 packet만 들어갔다는 이유로 raw capture를 버려서도
안 된다. 자세한
내용은
[§2.1 Context admission과 Smart Read](#tech-smart-read).

tool은 범위를 제한해 호출할 수도 있고 명시적으로 summary를 만들 수도 있다. 이 경우
그 bounded range 또는 summary가 이름 붙은 operation의 완전한 결과다. 이후에 손실이
있는 transformation을 더 적용하면 보이는 relation과 coverage record를 가진 새 파생
관찰을 만든다. 변환된 content를 원래 결과라고 다시 label하지 않는다.

raw capture·transformation·Agent-delivery metadata는 상태와 audit에서 분리해 둔다.
그렇다고 최상위 viewer를 세 종류로 만들 필요는 없다. UI는 여전히 Snapshot View와
Live View 두 종류이며, 둘이 다를 때 Snapshot View 안에서 `[원본 캡처]`,
`[이 Agent에게 전달된 내용]`, `[변환 관계]`를 보여 줄 수 있다.

기록 패널과 필요한 Canvas 보고 표현은 다음 두 content mode를 재사용할 수 있다.

- **Snapshot View**는 읽기 전용이며 과거 observation manifest에 고정된다. capture
  시각, Run/tool/Reader identity, source revision, payload role, coverage와 명확한
  `Snapshot` label을 보여 준다. raw capture와 delivered projection이 다르면 보존·열람이
  허용된 범위에서 각각을 구분한다. 삭제·redaction·접근 제한이 있으면 허용되는 상태
  정보를 표시하고 다른 payload를 원본인 것처럼 대신 제시하지 않는다. payload 간 차이와
  전달 lineage를 말없이 숨기지 않는다.
  저장된 HTML·링크·스크립트가 포함돼 있어도 Snapshot을 여는 행위가 현재 사이트에
  로그인·전송·수정하는 행동을 실행하지 않는다. 과거 내용을 그리는 경로와 현재 Live
  resource로 이동해 행동하는 경로를 분리한다.
- **Live View**는 현재 파일·Browser·Terminal 또는 다른 resource를 열거나 focus하고,
  필요한 경우 현재 account·session·revision 상태를 보여 준다. 사용자가 명시적으로
  열며 Snapshot View를 대체하지 않는다.

두 mode가 viewer 구현을 재사용해도 identity는 서로 다르다. 과거 읽기·명령의 Snapshot은
기본적으로 기록 패널에서 열고, 실제 작업 대상은 Canvas에 유지한다. 사용자가 현재 원본으로
이동하거나 보고에 선별한 근거를 펼친 경우에만 해당 Canvas 표현을 만들거나 재사용한다.
의미 있는 비교에서는 두 시점을 함께 제공하되 전체 도구 이력을 Canvas로 복사하지 않는다.
Answer Briefing은 선별한 Snapshot과 고정 artifact revision을 대상으로 하며 현재 Live로
과거 설명을 덮어쓰지 않는다. 패널을 닫아도 승인된 보존 기록과 실제 작업은 별도 수명으로 남는다.

같은 불변조건을 유지하면서 tool별 mapping은 다음처럼 달라진다.

```text
file read
  -> 이름 붙은 반환값 전체의 Snapshot View
  -> 선택적인 Live File View와 revision diff

smart read / smart query
  -> 불변 source/raw capture, 정확한 Agent-delivered Context Packet,
     둘 사이 coverage/transformation relation을 함께 담은 Snapshot View
  -> 선택적인 Live source view

browser 또는 computer-use 관찰
  -> 반환된 screenshot·DOM·accessibility tree·추출 content의 Snapshot View
  -> 선택적인 Live Browser 또는 현재 desktop 관찰

지속 PTY command
  -> command와 순서가 보존된 stdout/stderr의 Snapshot View
  -> 현재 검증된 session의 선택적인 Live Terminal

일회성 command·search·API call
  -> 해당 경계에서 전달된 이름 붙은 전체 결과의 Snapshot View
```

Snapshot은 사진이라는 뜻이나 Canvas 객체 종류가 아니라 시점을 고정한 자료다.

| 대상 | 보존 가능한 원형·표현 | 재현 경계 |
|---|---|---|
| 텍스트·코드·검색/API 결과 | 원문 bytes·범위·구조화된 반환 데이터 | 전체 원문, 선택 범위, 파생 요약과 실제 전달값을 구별 |
| PDF·Office·이미지 | 당시 파일 bytes와 필요한 페이지/추출 표현 | 추출 결과만으로 원본 전체를 보존했다고 하지 않음 |
| Browser | 전달된 screenshot·DOM/접근성 구조·텍스트 및 필요 리소스 | HTML만으로 모든 렌더링·JS 실행 상태를 복원할 수 있다고 하지 않음 |
| Terminal·TUI | 순서 있는 출력, 문자 셀·색/속성·크기·buffer/mode·화면 checkpoint | TUI가 반드시 PNG인 것은 아님. 실제 이미지가 전달됐다면 그 이미지를 유지 |
| Computer-use | 실제 관찰 이미지·필요 구간 기록 | 사후 재렌더링 이미지를 당시 관찰 이미지로 대체하지 않음 |

TUI의 기록 재생은 읽기 전용 표시이며 명령·입력·clipboard 동작 재실행이 아니다.
문자 화면의 직렬화는 [xterm.js의 serialize 계열](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize)처럼
기존 기술을 검토할 수 있으나 지원 모드·그래픽 확장·완전성은 별도로 검증한다. 이 예시는
새 저장 stack 확정이 아니다. manifest는 payload 형식과 원문/전달/preview 역할을 식별하고,
모든 자료를 JSON 문자열이나 screenshot 한 형식으로 강제하지 않는다.

Canvas 배치, viewer rendering, 상호작용 가능한 runtime session은 서로 다른 수명주기다.
실제 active·sleeping 작업 대상과 유지 중인 runtime은 Canvas에서 찾을 수 있는 표현을 가진다.
종료된 읽기·관찰 기록은 허용된 생각/작업 기록에서 재탐색 가능하면 되며, 기록 하나마다
독립 Canvas node를 요구하지 않는다. 기록 패널로 옮겼다는 이유로 계속 실행 중인 작업까지
Canvas에서 지우는 `close-but-background` 상태를 만들지 않는다.

```text
Canvas projection state
  active               renderer와 runtime이 사용 가능
  sleeping             상태가 명시되고 wake 조건을 가짐
  snapshot-only        live runtime 없이 역사적 observation만 보존

renderer attachment
  mounted              현재 그릴 수 있음
  detached             무거운 renderer만 제거, Canvas node·상태·binding은 유지

runtime lifecycle
  live / suspended / ended / unavailable
```

이 세 축은 독립적이다. Canvas viewport 밖으로 pan됐다는 사실은 `sleeping`, `detached`,
`suspended` 또는 `ended` 전이가 아니다. 메모리 압력과 resource policy에 따라 무거운
Browser·Terminal·editor·File Viewer renderer는 detach하고 화면에 들어올 때 다시 mount할
수 있지만, 사용자는 그 사이에도 node의 위치·상태·snapshot을 찾을 수 있어야 한다.
불변 snapshot을 보존하려고 완전히 rendering된 숨은 Desktop을 계속 유지할 필요는 없다.
content-addressed·chunked·compressed storage는 불변 identity와 lineage를 검사 가능하게
유지하면서 같은 snapshot data를 중복 제거할 수 있다. 승인된 지속 Browser 또는 PTY
session은 offscreen renderer보다 오래 남을 수 있지만, 과거 snapshot을 대체하지 않고
그 옆에 존재하는 live resource다.

tool 활동과 결과도 최종 Answer의 후보 재료다. Agent는 비교·evidence·table·source
material·artifact를 뒷받침할 observation snapshot을 제안할 수 있다. System은 Canvas
report set을 만들기 전에 정확한 snapshot과 source revision을 검증한다. 파생 table·
summary·chart에는 파생됨을 표시하고 다음 chain을 보존한다.

```text
Answer/report item
  -> Agent-delivered payload 또는 Reader Context Packet
  -> observation snapshot의 raw/source capture
  -> tool-call 당시 source 또는 runtime revision
```

report set은 전체 tool trace의 복사본이 아니지만, 선별 과정에서 provenance chain을
끊거나 과거 snapshot 자리에 Live View content를 대신 넣어서는 안 된다.

<a id="tech-multi-agent-chat"></a>

## 5. 여러 Agent가 참여하는 공유 대화 context

기본 Codex 대화와 사용자 생성 Agent의 담당자 방을 구분한다. 선택적 담당자 방은 상대 Agent에 연결되고 이름·성격·설정은 해당 Profile 버전에서 온다. 그 Agent에 귀속된 경험과 방의 history·Profile revision·실제 Agent Runtime·Run과 모델
context는 서로 다른 identity와 수명주기를 가진다. 같은 담당자에게 여러 업무를 맡길 때
history를 어떤 section·filter·업무 reference로 구분할지는 미결정 UI다.

EG-Desk에는 이 기본 관계와 별도로 group chat 또는 thread와 비슷한 상호작용 형태를
가지되 명시적인 EG-Desk context의 지배를 받는 작업 범위 공유 대화 기능이 필요하다.
최종 제품에서 이를 workroom, 일반 Thread, Board 연결 대화 또는 다른 Chat relation 중
무엇으로 표현할지는 이 계약이 고정할 객체가 아니라 미결정 object/UI 결정이다.

선택된 형태는 권한이 허용할 때 다음을 표현할 수 있어야 한다.

- 사용자와 권한을 받은 collaborator
- 여러 Agent identity와 각자의 범위가 제한된 contribution
- 메시지·단계 comment·결과 link·Run/Task 상태
- 같은 작업 context에 대한 병렬 contribution
- 내부 integration 역할을 제품 참가자로 만들지 않으면서 제한된 contribution을
  종합하는 integration result

Agent 담당자 방에서 공유 대화로 옮긴다고 방 전체 history가 자동 공개되지는 않는다.
System은 공유 작업에 필요한, 사용자가 선택하거나 정책상 명시된 메시지·Memo reference·
context만 연결하거나 복사한다. Agent끼리 위임한 대화와 진행 상태를 사용자에게 보여
주는 workroom/supervision 화면도 담당자 방의 raw 내부 대화를 그대로 노출하지 않고
contributor·범위·Task 상태·evidence·integration result를 Canvas 정본과 연결해야 한다.
정확한 대화 관계는 [HUM-CONV-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-conv-001),
생성·열기·공유·재진입 UI는 [Q-AI-12](../../docs/codex/egdesk-product-documentation-governance.md#atlas-q-ai-12)와
관련 `Q-COL-*` 세부 항목에서 미결정으로 남는다.

<a id="tech-room-speech"></a>
### 5.1 같은 Agent의 채널과 공개 발언 전달

Agent의 연속성과 채널의 기밀성은 함께 유지한다. 발화마다 소유 계정·Agent·채널·대화·실행을 식별한다. 화면에서 현재 선택한 방, 프로필 표시명, 다른 계정에서 우연히 같은 턴 번호가 나온 것은 답변 목적지가 아니다. 모델에는 누구로서 어디에 누구에게 말하는지와 공개 가능한 입력만 제공한다. 작업 메모·도구 출력·불확실한 항목을 공개 발언으로 재분류하지 않는다. 활동 기록은 해당 발언자와 실행에 붙고 다른 방에서 대신 열리지 않는다.

Board의 구성원, 이번 요청 대상, 각 대상에게 허용된 자료를 따로 계산한다. 지원되는 Board 멤버 경로에서 명시한 Agent가 담당자보다 우선한다. 지목이 없으면 설정된 담당자만, 담당 Agent도 없으면 그 방의 일반 엔진 경로다. 모호한 지목·미지원 경로는 부분 전송이나 일반 대화로 대체하지 않는다. 접수 일부/미확인인 전송은 전체 재시도하지 않는다.

한 번에 두 Agent를 명시한 지원 경로는 대상별 인증과 시작 접수를 순서대로 확인하되 앞 Agent의 답변 완료를 기다리지 않는다. 두 턴의 추론은 겹칠 수 있고 발언 순번은 강제하지 않는다. 이미 공개가 확인된 최종 발언만, 같은 발송 묶음에 속하고 아직 실행 중인 상대의 **원래 턴**에 외부 인용으로 넣을 수 있다. 그 인용은 사용자 명령이나 권한이 아니다. 수신자가 승인·응답 대기이거나 대상이 바뀌거나 끝난 경우, 재시작·불명확한 응답 때에는 새 호출·중단·재전송으로 메우지 않는다. 이 경로의 접수는 모델이 읽거나 반영했다는 증명이 아니다. 상대 발표 뒤 보낸 것과 발표 전에 보내고 확인만 늦게 온 것을 구별하며 이전 답을 고치지 않는다. 이 계약은 모든 엔진의 상시 그룹 토론이나 직원 초대를 선언하지 않는다. [사용자 조작](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-local-board)

<a id="tech-coding-surface"></a>

## 6. 사람 중심 코딩 표면

Terminal access는 Agent execution substrate이자 선택적인 expert/debug 표면이다.
필수적인 주 코딩 UX가 아니다.

사람 사용자를 위한 코딩 경험은 다음을 보여 줄 수 있어야 한다.

```text
project/folder
file tree와 search
editor 또는 적합한 file viewer
diff와 제안된 변경
run·build·test·review 결과
```

Agent는 이 view 뒤에서 shell·PTY·language server·build tool과 다른 adapter를 사용할
수 있다.

File view의 재진입 상태는 사용자가 다시 입력할 위치와 단순 관찰 위치를 구분한다.
System은 resource locator·revision, scroll/visible range와 명시적으로 고정한
annotation/range를 복원할 수 있지만 active caret, keyboard focus, transient text
selection 또는 깜빡이는 cursor 위치는 복원하지 않는다. renderer가 다시 mount될 때
이 일시 입력 상태를 새 focus처럼 재생해서는 안 된다.

<a id="tech-terminal-runtime"></a>

## 7. Runtime과 Terminal session 의미

programming language가 session의 지속성을 결정하지 않는다. Rust·Node.js·다른
helper 모두 durable runtime과 non-durable runtime 어느 쪽이든 host할 수 있다.

제품 모델은 다음을 구분한다.

```text
runtime/process owner
transport connection
보이는 client/view attachment
영속 recovery record
```

detachable로 정의된 runtime은 일시적인 UI 또는 transport disconnect 때문에 종료되면
안 된다. UI는 최소한 다음 상태를 구분한다.

```text
연결됨
분리됨/background
transport 재연결 중
검증된 동일 process/session에 다시 연결됨
새 process/session으로 revive 또는 relaunch됨
live process 없이 output snapshot만 복원됨
종료됨
유실 또는 상태 불명
```

process reconnection과 process revive는 서로 다른 주장이다. EG-Desk가 이전 content를
복원한 새 process를 실행했을 뿐이라면 살아 있는 동일 process에 재연결됐다고 보고하지
않는다.

detachable runtime의 보이는 Desk Window를 닫거나 분리해도 process를 말없이 죽여서는
안 된다. process termination은 실행 전 대상과 영향이 보이는 별도의 파괴적 action이다.
다만 process를 유지한다면 Canvas에는 그 process의 소유자·상태·재연결 행동을 나타내는
다른 projection이 반드시 남아야 한다. 보이는 Terminal만 제거한 채 hidden registry에서
process를 계속 돌리지 않는다. Board 전체를 닫을 때는 §1의 ownership 규칙에 따라 그
Board만 소유한 process를 종료하고, 다른 projection이 함께 소유한 process만 유지한다.
revive/relaunch가 새 shell·working directory·environment·이전 output snapshot을
복원할 수는 있지만, 이전의 임의 foreground command를 자동 재실행해서는 안 된다.
선언된 idempotent Task 재개는 Terminal view 복원이 아니라 scheduler policy에 속한다.

사용자가 process를 명시적으로 종료한 뒤의 기본 evidence 보존 상태는 exit/termination
status와 시각을 가진 읽기 전용 final-output snapshot이다. 그 snapshot 닫기는 별도의
view action이다.

현재 helper 구현은 ownership과 lifetime을 더 좁게 제한할 수 있다. 이는 측정할 구현
사실이지 영구적인 제품 요구사항이 아니다.

<a id="tech-answer-briefing"></a>

## 8. Canvas Answer Briefing과 Briefing Comment

임시 정본명 **Answer Briefing**은 하나의 논리적 Answer를 Canvas에 투영하는 선택적이고
사용자 제어형 기능이다. Agent Run 재생, 녹화, video, provider trace, 내부 reasoning
history가 아니다. 정확한 제품명과 UI label은 owner 결정으로 남지만 아래 동작은
그 결정과 무관하게 유지한다.

Agent는 Answer에 속하는 사용자용 material로 briefing을 제안할 수 있다.

```text
answer briefing
  순서가 있는 briefing step

briefing step
  Canvas output·artifact·source·evidence의 target set
  focus scope와 target range
  viewport·camera position·zoom
  visibility·dimming·emphasis state
  짧은 사용자용 step 설명
  previous·next·overview·direct-navigation relation
  target이 없거나 stale하거나 권한이 없을 때의 fallback
```

System은 참조된 모든 target의 존재, 현재 permission, freshness state를 검증한다. 그런
다음 선택한 Briefing Step의 focus scope를 적용하고 사용자의 이전·다음·전체 보기·
step 직접 이동·종료 control을 처리한다. step 변경은 System의 presentation transition이며
새 Agent Run을 시작하지 않는다.

한 단계의 여러 근거를 동시에 읽을 크기로 담기 어려우면, System은 준비된 근거의
원래 위치와 상대 배치를 유지한 전체 축소 개요를 우선 표시한다. 개요 표시 자체는
기존 카드의 저장된 위치·크기를 변경하거나 별도의 프레젠테이션용 사본을 만들지 않는다.

사용자는 Briefing Step에서 멈춘 뒤 해당 step 또는 허용된 visible target에 고정된
Briefing Comment를 남기고, 검증된 reference와 comment를 다음 Chat draft에 넣을 수 있다.
사용자가 그 Chat message를 실제 전송한 뒤에만 새 Agent turn이 시작될 수 있다.

Answer Briefing은 주된 목적이 branching이나 decision-tree인 engine이 아니다. 일반
Task branching은 다른 곳에 존재할 수 있지만 Briefing Comment가 자동으로 Run을
fork하지 않는다.

Answer Briefing은 Answer를 위해 선별한 사용자용 plan·evidence·action·중간 artifact·
decision·result만 보여 준다. 숨은 chain-of-thought·비공개 scratchpad·raw Agent chatter·
내부 reasoning token은 노출하지 않는다.

<a id="tech-dependency-orchestration"></a>

## 9. Agent dependency orchestration과 Await

Await의 주 계약은 dependency-aware orchestration이다.

```text
upstream Agent Task
  -> 완료 상태와 evidence 생성
  -> dependency gate가 필수 조건과 approval 평가
  -> downstream Task가 ready 상태로 전이
  -> scheduler가 자동 시작
```

최소 Task 상태는 다음과 같다.

```text
queued
waiting-on-dependency
ready
running
approval-required
completed
failed
cancelled
```

UI는 어떤 upstream result 또는 approval이 Task를 막고 있는지 보여 준다. 부분 실패·
retry·cancel·timeout·대체 경로 policy는 명시적으로 유지한다. 파일 도착, OAuth 완료,
사용자 action, browser event, terminal exit가 dependency gate를 충족할 수는 있지만
그 예시 하나가 Await 자체를 정의하지는 않는다.

System scheduler는 기다리는 동안 LLM response stream을 계속 열어 두는 대신 dependency
state를 checkpoint한다.

<a id="tech-ontology-runtime"></a>

## 10. Ontology runtime과 Ontology View

Ontology는 context 선택, entity와 relation, time/layer state, constraint, action,
evidence, result promotion을 포함해 Agent cycle을 조직하는 System model이다.

현재 Ontology Desk Window는 그 model을 시각화하고 함께 설계·검사하는 표면이다. 최종
사용자나 Agent가 ontology를 수동으로 관리하는 일을 주 workflow로 삼아야 한다는
증거가 아니다.

```text
관리되는 ontology/runtime model
  -> Agent cycle을 제약하고 정보 제공
  -> 검증된 structured state change를 수신
  -> Ontology Desk Window로 projection
```

향후 사용자 편집 기능은 proposed change·validation·approval/promotion·active version·
rollback을 구분해야 한다. 직접 visual edit로 운영 ontology를 말없이 다시 써서는 안 된다.

<a id="tech-parallel-agents"></a>

## 11. 병렬 Agent와 여러 Output

report·deck·evidence note 동시 제작은 병렬 Agent 작업의 예시일 뿐, Agent 하나가 항상
artifact 세 개를 만들어야 한다는 요구가 아니다.

재사용 가능한 핵심 기능은 다음과 같다.

```text
하나의 parent intent와 shared context
-> 여러 Agent에게 범위가 제한된 sibling Task 배정
-> 독립적인 progress와 evidence
-> dependency-aware integration
-> integration 기능이 conflict를 해결하고 하나의 일관된 result 생성
```

sibling Task가 실패해도 이미 성공한 output은 남는다. 사용자는 raw Agent-to-Agent
chatter를 읽지 않아도 contributor·status·evidence·integration result를 볼 수 있다.

<a id="tech-local-capacity-advice"></a>
### 실행 호스트의 관측과 로컬 추가 배정

**로컬 생산자와 소비자:** 브리지의 동일 호스트 CPU 카운터가 상단 셸 진단과 로컬 접수 정책에 쓰인다. 두 소비자는 독립적이다. 셸이 닫혀 있어도 정책은 동작한다. 메모리(캐시 포함), 디스크 공간·전송량, 네트워크 전송량은 진단이며 이 정책의 입력이 아니다. HTTP 요청·카드의 주장·원격 측정값·모델 잔여량을 로컬 신호로 받지 않는다. 원시 텔레메트리는 모델이나 동료에게 보내지 않는다.

**베타 기본값:** 브리지가 1초마다 집계 CPU 시간을 살피며 단조 시계 기준 신선도는 3초 미만이다. 유효한 연속 창(각 0.5~2.5초) 두 번이 95% 이상이면 추가 시작을 보류하고, 두 번이 85% 이하면 해제한다. 같은 캐시 표본을 두 창으로 세지 않는다. 신호를 읽을 수 없거나 오래됐거나 호스트·범위가 다르면 기존 한도를 그대로 사용한다. 이미 시작한 작업을 중단하지 않고, 압박만으로 유휴 실행기의 첫 작업까지 막지 않는다. 기존 권한·의존성·승인·고정 동시성 상한이 우선한다.

**소비 범위:** 로컬 Workflow는 대기 사유 `local-host-pressure`를 표시하고 완료·여유·표본 만료 때 다시 검사한다. 로컬 Codex Board는 같은 방에서 이미 시작·접수 중인 자리를 계산한다. 보류된 수신자는 자동 재전송 큐에 넣지 않는다. 사용자에게 시작되지 않은 수신자만 다시 지정하도록 알린다. 워크플로와 Board가 공용 서버 전체의 단일 슬롯을 공유하거나 엔진 내부 하위 Agent·다른 컴퓨터의 배정을 제어하지 않는다. 기준 시험: 같은 권한과 요청에서 신선한 10%와 지속 99%를 대조하고, 미측정·오래됨·기존 상한·중복 요청을 별도로 검사한다.

<a id="tech-collaboration-computer-use"></a>

## 12. 다중 사용자 Desk와 Desk 외부 Computer Use

Agent가 제어하는 모든 활동은 Desk 안에서 관찰할 수 있는 projection을 가져야 한다.

Browser·File·Terminal과 외부 앱에 대한 Agent 행동은 사용자의 Canvas 카메라와 입력
focus를 빼앗지 않아야 한다. 사용자가 다른 view로 이동하거나 pan·zoom했다고 Agent의
위임 대상이 바뀌지는 않는다. 사용자 요청으로 활동 관찰이나 Briefing을 여는 카메라
이동은 별도 탐색 행동이다. 같은 대상의 내용·layout 변경은 새 관찰과 실행 조건을
검사하며, 단순 카메라 변화만으로 업무를 재시작하지 않는다.

Browser·Terminal·File과 다른 native Desk Window 활동은 기존 view를 통해 관찰할 수
있다. Agent가 Desk 밖 host application에서 행동하면 EG-Desk에는 다음을 보여 줄 수
있는 Desk-visible host activity view가 필요하다.

- 선택된 application/window 또는 격리된 execution surface
- 현재 controller와 control lease
- 사람 사용자의 입력과 구분되는 Agent pointer/focus/action 표시
- action timeline·pause/stop·completion evidence
- privacy·capture boundary

관찰만으로 입력 충돌이 방지되지는 않는다. Agent action은 사용자의 global pointer를
빼앗지 않는 application API 또는 accessibility action을 우선해야 한다. 실제로
pointer/keyboard control이 필요한 작업은 사용자가 active desktop을 명시적으로
넘기지 않는 한 isolated desktop·virtual display·VM 또는 동등한 execution surface에서
실행해야 한다.

이 view를 원격 collaborator와 공유하려면 identity·authorization·streaming/sync와
server/network infrastructure가 필요하다. 그 외부 인프라 선택은 명시적 사용자 승인
대상이다.

인프라가 승인·설정된 뒤 collaborator는 선택한 Desk 외부 활동 중 permission filter를
통과한 projection을 관찰할 수 있다. 정본명·object boundary·placement·Desk Window 여부는
미결정 제품 질문으로 남는다. 공유 projection에는 선택한 Desk 외부 app/window, Agent
pointer 또는 focus 표시, action timeline, completion evidence가 들어갈 수 있고 제외된
비공개 영역은 나타나지 않는다. 관찰 권한이 control 권한을 주지는 않는다. active
desktop handoff는 owner가 통제하고 collaborator control에는 별도의 명시적 grant가
필요하다. 따라서 collaborator control request에는 owner의 grant/reject 결정, 범위가
정해진 input method와 expiry, 독립적인 revoke/expiry transition이 있다. collaborator
control을 revoke하면 observation grant까지 따로 revoke하지 않는 한 그 참가자는
observer-only 상태로 돌아간다.

### 12.1 여러 PC의 작업을 같은 Board에서 다루기

화면을 보는 PC, 작업을 실행하는 PC, 자료가 있는 위치와 실제 업무 계정을 구별한다.
각 Task·도구 실행과 결과는 실제 실행 위치에 결합되어야 하며, 동일한 파일명이나 경로
문자열만으로 다른 PC의 자료를 같은 자원으로 대체하지 않는다. 참가자를 초대하거나
PC를 연결했다는 사실만으로 그 PC의 모든 파일·프로그램·계정을 사용할 권한이 생기지 않는다.

- 같은 Board의 작업이 여러 PC에서 진행되어도 각 작업의 대상·실행 위치·마지막 확인
  상태·산출물은 Canvas의 해당 작업에서 찾을 수 있어야 한다. 사용자의 카메라 이동은
  작업 배치나 실행 PC를 바꾸지 않는다.
- 통신 단절은 원격 process 종료나 외부 행동 취소의 증거가 아니다. 마지막 관찰과
  확인 시점을 보존하고 현재 상태를 확인하지 못한 범위만 표시한다. 영향받지 않은
  작업은 기존 위임 범위에서 계속할 수 있다.
- 다른 PC로 실행을 넘길 때에는 대상 PC의 실제 자원·계정·권한·기능을 재검증하고
  이전 실행의 상태와 이미 발생한 외부 효과를 대조한다. 확인되지 않은 같은 쓰기
  작업을 새 PC에서 중복 시작하지 않는다. 원격 session 자체를 옮겼는지, 저장된
  작업 맥락을 사용해 새 실행을 시작했는지는 별도 기록으로 구분한다.
- 연결이 돌아오면 기존 실행의 동일성과 현재 권한을 검증해 재연결 상태를 갱신한다.
  완료·종료 상태는 각각 해당 증거를 확인한 경우에만 갱신하며, 뒤늦게 도착한 결과만으로 취소되거나
  다른 작업으로 전환된 실행을 자동 재활성화하지 않는다. 이미 발생한 외부 효과를 가리키는
  늦은 증거는 별도로 보존·대조하며 [§12.2](#tech-org-execution)를 따른다.
- `.egdesk` 가져오기는 허용된 자료·맥락의 반입이다. 원격 PC 연결, 실행 권한 부여,
  살아 있는 process의 재연결 또는 작업 재실행을 대신하지 않는다.

기기 발견·연결 방식, 실행 배치 알고리즘과 통신 프로토콜은 구현 재량이다. 자동 배치가
기존 위임·계정·비용·자료 이동 범위를 넘으면 그 종속 행동만 해당 권한 결정에 따른다.

<a id="tech-org-execution"></a>

### 12.2 조직의 Board 공유와 여러 PC 실행

**상태:** 일반 제품을 위한 계약·검증 조건이다. 어떤 OS나 PC에서 호스팅·공유·실행이
현재 구현 또는 운영 검증되었다는 뜻이 아니다. [조직 사용 trace](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-org-use)와
[개발 우선순위](./EGDESK_VISION_GAP_LEDGER.md#org-delivery-priority)를 함께 본다.
이 절은 [Context·공유](#impl-context-share), [계정 binding](#impl-account-binding),
[승인·외부 효과](#impl-approval-receipts), [기기 grant](#impl-e24-collaboration-authority),
[원격 연결·복구](#impl-e24-remote-transport)를 대체하지 않고 조직 실행에 함께 적용한다.

**사용 범위와 배치.** 사람은 하나의 Desk/Canvas 안에서 여러 Board를 사용한다.
회사·부서는 Board와 자료에 적용할 접근 범위·정책이지 새 Desk, Canvas 또는 workspace를
만드는 지시가 아니다. 같은 PC에 작업 조정·저장·실행 역할을 함께 둘 수 있고, 등록된
다른 PC를 실행기로 연결할 수도 있다. 실행기 추가는 전체 공유 호스트의 자동 승계를 뜻하지 않는다.

지원 OS·자원·설치·기기 승인·통신·실행 준비가 확인된 PC는 호스트나 실행기 후보가
될 수 있다. 같은 회사 Wi-Fi 접속, 장비 이름 또는 IP만으로 신뢰하거나 역할을 자동
부여하지 않는다. 기기 등록·철회와 보호된 연결은 역할별로 확인한다. OS/브라우저별
연결기, TPM 또는 다른 기기 인증수단은 해당 환경과 필요한 보증 수준에 따라 선택·검증한다.
TPM이나 Native Messaging을 모든 플랫폼의 필수 조건으로 만들지 않으며, 키 서명 확인과
하드웨어 출처 attestation도 구분한다. 새 인프라·클라우드·SSO·계정 도입이나 외부
전송은 이 설계만으로 승인되지 않는다.

<a id="tech-org-setup"></a>

**로드맵 A: 기존 EG-Desk에 내장하는 조직 연결·설정.** 개설자는 조직이 관리하는 기존 AWS 환경이나 온프레미스 호스트를 선택한다. EG-Desk에 내장된 툴킷이 승인된 호스트에서 제품의 협업 서비스를 준비·구성하고 접속 가능 여부를 점검한다. 고객에게 제3자 협업 서버나 VPN 제품을 따로 설치하게 하거나, 그 설치를 스크립트로 대신하는 것이 목표가 아니다. 개설자는 조직을 만들고 첫 관리자로서 다른 사람을 초대한다. 초대받은 사람은 자기 EG-Desk에서 조직을 확인하고 가입하며, 그 뒤에 허가된 Board를 연다. 조직 가입, Board 접근, 특정 기기의 화면 보기, 입력 제어는 서로 다른 권한이다. 조직의 ‘마스터’는 멤버십과 권한 기록의 기준점이지 모든 화면 데이터가 지나야 하는 물리 장비라는 뜻은 아니다. 새 클라우드 자원의 구매·과금·외부 공개를 자동으로 승인하지 않는다.

**원격 경로는 결정하지 않았다.** 조직이 사람·기기를 인증하는 방법, 두 기기가 세션 연결 정보를 주고받는 방법, 실제 화면이 흐르는 경로를 구분한다. 조직 서비스에 최신 권한을 조회하도록 설계하면 그 조회에는 도달성이 필요하다. 그렇다고 두 기기의 마스터 상시 접속이나 영상의 마스터 경유가 기술적 필수는 아니다. 허용된 직접 연결, 제품에 내장한 조직 중계, 조직 정책상 중계 전용은 비교할 설계안이다. 다른 망에서 직결이 실패할 수 있다는 사실은 어느 안의 자동 승인도 아니다. 어떤 경로에서도 권한을 확인·회수할 수 있어야 하고, 승인되지 않은 외부 중계나 제한된 경로로 바꾸지 않는다. 기존 [원격 전송 계약](#impl-e24-remote-transport)과 [인프라·비용 결정](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-remote-001)을 따른다.

<a id="tech-org-workspace-data"></a>

**공유 작업공간의 데이터 범위(계약).** 공유 작업공간은 같은 화면을 전송하는 기능이 아니라, 권한에 따라 같은 업무 상태를 각자의 Desk에 나타내는 기능이다. 다음 범주는 서로 다른 권한과 수명을 가진다.

1. **신원·권한·영수증:** 조직 멤버십과 Board 참여·카드별 허가(부여·철회)는 구분한다. 초대·수락, 권한 변경, 실행 결과의 영수증은 각 사건의 결과만 증명한다. 조직 가입은 Board 접근이나 기기 관찰·제어를 부여하지 않고, Board 접근도 모든 카드·영수증의 일괄 공개를 뜻하지 않는다.
2. **지속되는 Board 업무 상태:** 저장된 카드와 명시적으로 적용한 공용 위치·크기, 자료 간 관계, 파일 참조와 버전이 있는 자료, 보낸 회신, 지원되는 앱의 업무 상태를 해당 범위에서 다룬다. 파일 참조나 관계가 원본 열람권을 주지는 않는다. 각 구성원에게 현재 권한으로 허용된 상태만 따로 구성해 보내고, 다시 열거나 재연결할 때 최신 권한과 버전으로 다시 조회한다. 권한이 철회된 항목이나 보이지 않는 자료의 관계는 다시 나타내지 않는다. 개인 카드 배치·카메라, 미전송 초안과 사이트 쿠키는 공용 상태에 넣지 않는다.
3. **선택적 일시 신호(설계 후보):** 접속 표시나 커서는 권한 범위 안에서 일시적으로 보낼 수 있다. 저장되는 Board 상태나 업무 완료 증거가 아니며 없어도 공동 작업은 가능하다.
4. **선택적 라이브 미디어와 별도 제어(설계):** 선택한 화면 픽셀은 명시적 동의와 별도 보기 권한이 필요한 선택 데이터다. 오디오는 별도 동의가 필요한 미래 데이터 예시이며 현재 제공을 뜻하지 않는다. 원격 키·클릭은 미디어가 아니라 대상 기기에서 효력을 내는 별도 권한의 명령·입력 사건이다. 영상이나 음성을 받는 것만으로 제어할 수 없고, 입력 허가가 재생·녹화·보관을 승인하지도 않는다.

이 구분은 [원격 전송 경로](#impl-e24-remote-transport) 선택이나 [헤드리스 Linux](#tech-headless-linux-track) 로드맵과 독립적이다. 모든 미디어 전송, 두 단말의 조직 마스터 접속, 전체 화면 스트리밍 서비스가 Board 공유의 선행 조건은 아니다. 직접 연결과 조직 중계 중 어느 쪽도 기본값으로 결정하지 않는다. [사용자 예시](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-org-workspace-data) 참조.

<a id="tech-org-work-state-sharing"></a>

**공유의 세 층과 업무 분기(목표 계약).** 첫째, **Board 자료**는 카드에 담긴 파일·텍스트 등의 참조 또는 특정 시점·버전의 스냅샷이다. 최신 원본 참조는 볼 때마다 현재 접근권을 확인하고, 스냅샷은 당시 자료를 가리키며 새 원본과 자동 연동되지 않는다. 둘째, **Board 상태**는 권위 원장의 공용 배치·업무 진행·상태 사건과, 그 원장을 각 수신자의 권한에 따라 자기 기기에서 다시 그린 화면을 구분한다. 공동 상태를 실시간 갱신하더라도 같은 픽셀을 보내는 것이 아니다. 발표자 화면 위치 따라가기는 선택적이고 공용 배치를 바꾸지 않는다. 셋째, **라이브 웹사이트 세션**은 호스트에서 실제로 로그인된 사이트가 실행되는 별도 층이다. 대상과 범위를 확인해 동의한 보기와 별도 허가된 제어만 제공하며 쿠키·로그인 세션을 복제하지 않는다. Board 안에서도 객체·카드마다 이 범위를 다르게 조합할 수 있다. 이는 제품의 기본 모드나 [전송 경로](#impl-e24-remote-transport), [배포 환경](#tech-headless-linux-track)을 정하는 문장이 아니다.

- **각자 진행:** 날짜·버전이 표시된 패키지에서 분기하면 그 시점의 자료를 바탕으로 별도 업무를 시작하며 원본 변경이 자동 반영되지 않는다. 반면 계속 같은 원본 원장을 참조하는 경우에는 현재 접근권으로 최신 자료를 다시 읽되, 사람마다 별개의 비공개 업무 ID와 진행 상태를 유지한다. 참조 권한 회수로 최신 원본을 더 이상 열 수 없더라도 이미 명시적으로 전달된 사본을 원격 삭제했다고 보지 않는다.
- **공동 진행:** 참여자는 하나의 공용 업무 ID를 공유한다. 상태 변경은 현재 권한(grant), 대상 자료·앱 버전과 기준 사건 리비전을 확인한 뒤 원장에 기록한다. 승인된 새 리비전을 각 클라이언트가 권한에 맞게 다시 그린다. 오래된 화면·단절 상태는 최신으로 표시하지 않으며, 재접속 시 권한·리비전을 다시 확인한다. 충돌한 입력을 그대로 재적용하거나 회수된 대상을 다시 열지 않는다.
- **게시와 외부 효과:** 개인 초안·결과는 명시적으로 게시한 부분만 공유한다. 필요한 경우 합의한 단계의 중간 결과만 게시할 수 있지만, 이를 독립된 필수 모드로 정하지 않는다. 공유 참여·방식 전환은 기존 초안의 업로드나 결과 병합을 뜻하지 않는다. 공용 결과·영수증을 읽거나 다른 클라이언트가 상태를 다시 그려도 ERP 제출 같은 외부 행동을 재생하지 않는다. 접수 여부가 불명확하면 원천 결과를 먼저 확인하고 자동으로 재시도하지 않는다.

**양쪽 표시 기준:** 보내는 쪽과 받는 쪽은 무엇(대상·시점/버전), 어떻게(고정 사본·최신 참조·공동 상태·허용된 사이트 세션), 어디까지 갱신되는지(나만의 진행·게시한 부분·공용 상태, 최신/단절/회수)를 구별할 수 있어야 한다. 두 검수 흐름의 [사용자 인수 예시](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-org-inspection-sharing) 참조.

<a id="tech-headless-linux-track"></a>

**로드맵 B: 헤드리스 Linux에서 실행하는 EG-Desk.** 모니터나 그래픽 로그인 없는 AWS 인스턴스·사내 Linux 호스트에 EG-Desk 자체를 배포·기동·재기동·점검할 수 있게 하는 독립 배포 목표다. 단순히 Firefox를 headless 모드로 띄우는 시험이 아니다. 조직 협업 툴킷의 출시 전제도 아니며, Linux에서 기동됐다는 사실만으로 조직 초대·영상 중계가 구현됐다고 보지 않는다. 두 로드맵은 함께 사용할 수 있지만 완료 판정은 각각 한다. [사용 흐름](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-org-use) · [분리된 인수 조건](./EGDESK_VISION_GAP_LEDGER.md#org-delivery-priority).

**공유 설정과 일회 위임.** 설정 사본의 검토·활성화는 별도 Agent를 만드는 일이다. 계정 자격, 기기에 묶인 실행 계정 식별자, 원 Agent의 이력·DM은 전달하지 않는다. 파일로 검토를 요청할 때는 공개 질문·발췌와 원 요청/회신의 대응만 공유한다. 원래 Board에 회신을 반영하는 행위는 별도다. 한 번의 Board Agent 질문 권한은 열람이나 직원 신원 증명이 아니다. 소유자가 유효한 Board·Agent 버전·공개 범위를 확인하고 실행해야 하며 외부 선별·생성·비용 승인도 대체하지 못한다. 사람 초대·Board 권한 수락·철회와 기기 제어권은 각각 별도 경계다. [현재 사용자 경로](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-local-share)

<a id="tech-board-cross-agent"></a>

**기존 Board 초대와 공동 개설을 분리한다(제안).** 전자는 기존 Board의 신원·배치가 유지된다. 후자는 양측이 수락한 목적·참여·공개 범위에 대해 공용 Board 하나를 만든다. 각각 새 사본을 만들거나 두 개인 Desk를 합치지 않는다. 개인 원본·선택한 버전, 공용 Board 안의 카드와 위치, 실제 실행 호스트는 서로 다른 식별과 권한을 유지한다. 같은 이름·주소만으로 두 로그인 환경을 하나로 합치지 않는다. Board 열기·기여·다른 참가자 추가·원본 편집·Agent 호출·보드 폐쇄는 서로 다른 행동이다. 공동 개설이 자동 공동 관리자 지정이나 양측 자료의 권리 이전을 뜻하지 않는다. [구성·철회·운영 기준](../../apps/firefox-ui-demo/docs/BOARD_COLLABORATION_AND_CROSS_AGENT_DESIGN.md#joint-board-formation)

**같은 Board에서 카드와 동료 Agent를 사용할 때 (목표, 미구현).** 공유 단위를 한 가지 ‘세션’으로 합치지 않는다. (1) Board가 소유한 배치·공개 자료와 그 변경, (2) 참가자별 시점과 따라보기, (3) 로그인된 브라우저에서 정확한 카드·사이트 계정으로 수행하는 작업, (4) 그 카드에 그려진 화면의 시청과 (5) 입력 조작을 구별한다. 초대 수락은 명시한 범위만 연다. 각자 사이트를 여는 경로와 한 호스트 페이지를 함께 보는 경로는 URL이 같아도 다르다. 호스트 작업은 세션을 수신 기기로 복사하지 않고 허용 필드로 제한하거나 담당자가 검토한 결과만 반환할 수도 있다. ‘읽기/초안’도 실제 페이지 열기·입력으로 읽음 처리·자동 저장이 발생하면 외부 쓰기다. 미승인 효과를 막지 못하면 효과 없는 사본이나 검증된 읽기 경로만 쓰고, 없으면 시작하지 않는다. Board 변경은 재동기화하지만 제3자 사이트의 키 입력·저장 클릭은 복제하거나 재생하지 않는다. 같은 카드의 입력 주체는 한 번에 하나이며 다른 카드의 같은 외부 기록은 별도 충돌 검사가 필요하다.

동료 Agent에게 부탁하는 권한은 위 다섯 범위와 독립적이다. 양방향 요청은 각각 **요청자·Board·Agent 소유자와 버전·Agent 실행 위치와 Engine 처리 계정·비용 부담 주체·업무를 수행할 카드/PC/사이트 계정·허용 자료/행동·결과 수신자·유효 기간**에 결합한다. Agent 소유자에게 요청자 자료를 자동 공개하거나, 요청자에게 소유자의 화면·비공개 DM/기억·로그인을 주지 않는다. 처리처와 실제로 열람 가능한 범위를 지킬 수 없으면 보내지 않는다. 재위임은 새 수신자에 대한 별도 판단이다. 입력권 회수·호스트 단절·계정 전환·외부 저장 결과 미확인은 다른 사람/Agent의 비슷한 계정으로 대체하거나 재실행할 이유가 아니다. [상태 변화·위임 조합·미실행 인수 사례](../../apps/firefox-ui-demo/docs/BOARD_COLLABORATION_AND_CROSS_AGENT_DESIGN.md#collab-layers) · [기존 신원·동시성·회수](#impl-e24-collaboration-authority) · [원격 연결·복구](#impl-e24-remote-transport)

<a id="tech-board-entry-doors"></a>

**진입 경로와 실제 첫 화면(설계).** 수신자에게 보낼 초대 미리보기, 권한 있는 사람의 수락, 첫 화면 접근 성공을 분리한다. 상세 설계의 ‘수락하고 참여’ 한 클릭은 수락과 첫 열기를 요청할 수 있지만, 열기 응답만 실패한 경우 수락이나 개설을 재실행하지 않는다. 현재 접근 가능한 기기·계정·리소스인지 열기 직전에 확인하고 요청한 사람의 해당 Canvas에서만 대상 제목으로 이동한다. 같은 Board를 다시 열면 새 복제본이나 다른 사람의 뷰포트를 만들지 않는다. 공동 개설의 제안자 화면은 상대의 수락만으로 이동하지 않는다. 받은 초대 목록에서 열기와 달리, 기존 Board 목록에 공용 행을 두는 것은 **이번 배치 제안**이다. 행·보드 제목·재진입은 현재의 Board 전체 접근권에 묶고, 단일 카드 권한만으로 비공개 부모·누락 카드 수·제목을 표시하지 않는다. 회수·만료 뒤 옛 바로가기나 첫 열기 재시도가 권한을 되살리지 않는다. 시각 시안에서 개인 작업물의 좌표·앞뒤 순서와 카메라를 따로 보관한다. 화면 크기 변경이나 단순 포커스 변경으로 배치가 덮어써지지 않는다. 그 기기에서 전표를 끌어 오는 것과 공동 배치를 수정·전송하는 작업도 구분한다. 배송 요청서와 파일·검색 목록은 공개 범위를 확인한 경우에만 구성한다. 사람이 입력한 상태 초안과 수신자를 확인한 회신은 별도 동작이다. [사용자 경로](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-board-entry-doors) · [기존 초대와 재진입](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-collaboration-invite)

<a id="tech-shipping-handoff"></a>

**세 번째 참가자로의 업무 인계(설계, 격리 모형만 검증).** 초대 수락·자료의 지정 공개·업무 인수·Agent 사용·결과 수신·회신을 별개로 기록한다. 멤버십만으로 자료나 그 파생 요약·알림을 내보내지 않으며, 한 수량과 차이를 조합해 제한된 수량을 복원하는 경우도 막는다. 업무 제공자와 계정·Agent 소유자는 같을 필요가 없다. 업무 범위 안에서 실제로 승인된 입력 필드와 결과 수신자만 사용한다. 권한 회수 뒤에 같은 사람·운송 참조가 다시 허용돼도 구 요청의 결과 공개 권한은 되살리지 않는다. 원본 제공자 이탈이 독립된 업무까지 취소하지 않으며, 이미 승인·발송된 배송 회신 보존과 실시간 원본 접근은 구별한다. [세 갈래로 조작하는 로컬 모형](../../sketches/board-collaboration-rehearsal/README.md) · [사용자 흐름](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-third-person-shipping)

**신원과 실행 경계.** 요청 계정과 실제 담당자, 요청 PC와 실행 PC, Agent 실행체,
Engine 계정, 업무 서비스·사이트 계정, OS 사용자를 구분해 각 행동에 결합한다.
공유 Engine 또는 업무 계정은 해당 서비스 정책과 실제 격리가 허용하는 범위에서 사용할 수
있으며 직원마다 새 provider 구독·계정을 만들도록 강제하지 않는다. 공유 신원만으로
개인을 확인할 수 없다면 담당자를 확정하지 않고, 개인 확인이 필수인 행위는 확인 전 보류한다.
기기 등록이나 직원 표시 설정은 그 사람의 물리적 현장 존재를 증명하지 않으므로 인증된
주체와 자기 신고한 담당자 표시를 구분한다.
접속됨과 실행 준비됨은 다르다. 백그라운드 API 읽기와 로그인된 앱·실제 OS 화면 제어는
서로 다른 capability이며 각각 필요한 세션·자료 연결·도구·자원을 검사한다. 해당 조건이
준비되지 않으면 이유를 표시하고 그 작업만 대기한다.

직원이 평소 쓰는 PC를 호스트로 등록해도 global focus·마우스·키보드 사용이나 전면 화면
인계를 승인한 것은 아니다. 백그라운드에서 가능한 작업은 승인된 범위에서 수행하고,
실제 전면 인계가 필요한 작업은 [§12](#tech-collaboration-computer-use)의 명시적 인계
전까지 대기하며 사용자에게 요청한다. 공용 호스트의 동시 작업 수·CPU·메모리와 Engine
사용에 제품이 설정할 수 있는 실행 상한을 둔다. provider가 정한 quota는 별도로 확인해
함께 적용한다. 실제 준비·허용 범위를 넘으면 대기하거나 이유를 표시하며 임의의 고정
수치를 제품 기본값으로 확정하지 않는다.

호스트의 Engine·업무 서비스 credential은 보호된 호스트 측 저장소와 범위 제한된 handle로
사용하며 참여 client에 복제하거나 일반 이벤트에 싣지 않는다. handle은 계정·사용 범위·
세대에 결합하고 교체·철회 시 새 행동에 이전 권한을 재사용하지 않는다. credential은
업무 데이터 백업·bundle에서 제외한다. 별도 승인된 보호 백업으로 인증정보를 복원하는 경로가 있더라도
복원만으로 사용을 재개하지 않고 해당 서비스의 재인증·권한 확인·회수/교체 정책을 적용한다.

허용 범위는 기존 grant·위임·계정·resource·행동 제한을 함께 검사한다. 원자료를 실제로
읽기 직전, 도구 사용·외부 행위 직전, 결과를 각 수신자에게 제공하기 직전에 해당 행동의
권한 유효성을 다시 확인한다. 매 행동마다 외부 서버 왕복을 요구하지는 않는다. 정책이
허용하면 발급자·대상·행동·기기/세션 범위, 유효기간과 허용된 최신성·철회 정보를
검증한 로컬 grant/lease 또는 캐시를 사용할 수 있다. 이전 검색 결과·Agent memory·공유
초대만으로 읽기 권한을 대신하지 않는다. 해당 행동에 최신 확인이 필수인데 확인할 수 없으면
그 행동만 보류하고 다른 허용 작업은 계속한다. 연결되지 않은 기기에 철회가 즉시 반영되거나
이미 받은 사본을 회수할 수 있다고 보장하지 않으며 허용된 오프라인 보존은 별도 정책에 따른다.

사용자에게 보이지 않는 파일·브라우저·사이트 계정을 Engine의 native shell, 직접 네트워크,
다른 플러그인이나 공유 OS 세션으로 우회할 수 있다면 화면의 제한은 실행 권한 격리가 아니다.
기존 실행 경계에서 OS·자료원 권한과 허용 도구를 함께 집행하고 통제할 수 없는 경로는
비활성화한다. 그 경계가 확인되지 않은 계정·세션 조합은 해당 공유 실행을 허용하지 않는다.
접근 권한이 넓은 연결 계정의 권한을 요청자나 다른 부서의 권한으로 간주하지 않는다.

원본을 직접 볼 수 없는 사람에게 대리 분석 결과를 제공하려면 원본 소유 범위에서 그
위임을 허용하고 실행자가 필요한 최소 자료만 읽어야 한다. 공개는 수신자별 허용 필드·범위를
집행하는 공유 결과 계약 또는 정책상 권한 있는 담당자의 검토·승인으로 통제하며, 요약이나
LLM 검사만으로 권한 집행을 보장하지 않는다. 원문·인용·파일명·존재 등 허용되지 않은 정보가
요약을 통해 드러나지 않게 하며, 결과 열람 권한은 원본 열람·수정 권한을 자동으로 부여하지 않는다.

**대상과 정정.** 읽기·승인·수정·전달은 실제 자료원과 제공된 안정 ID 또는 검증된 locator,
그때 확인한 revision, 행위·내용·수신 범위를 기록한다. 같은 이름이나 내용 hash만으로
다른 PC·계정의 원본을 같은 권한 대상으로 취급하지 않는다. 대상이나 원본이 바뀌면 이번
행동에 영향을 주는 변경과 현재 권한·승인 범위를 다시 검사한다. 원본 전체 revision의
변경은 재검사 신호이지 이전 승인의 자동 무효 조건이 아니다. 승인된 대상·payload·수신자·
권한 범위가 달라졌으면 이전 승인을 재사용하지 않는다. 조건부 저장이 충돌하면 현재본의
다른 변경을 보존하며 재검증한다. 관련 없는 필드 변경만으로 모든 작업을 중단하거나
재승인을 요구하지 않으며, Agent는 변경을 문맥에 반영해 다음 턴을 계속하고 영향받지 않은
허용 작업도 이어간다. 결과의 근거가 정정되거나 새 사실로 기존 판단이 달라지면 기존 기록을
조용히 덮지 않고, 보존 정책과 현재 열람 권한 안에서 이전 판단·정정 내용·확인 시점을 연결한다.

**첫 공유 단계의 장애와 복구.** 호스트가 정지하면 그 호스트가 맡은 공유 조정·새 원격
실행은 이용할 수 없으며, 마지막 확인 시각과 실행·외부 효과의 미확인 상태를 구분한다.
단절이나 lease 만료만으로 원격 process 종료 또는 외부 행위 취소를 주장하지 않는다.
재연결·재시도는 기존 operation/attempt·현재 권한·실행 상태·외부 receipt를 먼저 대조한다.
결과가 불명확한 외부 쓰기는 확인 없이 다시 보내지 않는다.

이전 실행기의 늦은 결과는 현재 실행 상태를 덮거나 후속 dispatch·새 외부 효과를 승인하지
않는다. 동시에 수신한, 이미 발생했을 수 있는 외부 효과의 주장·receipt는 원래 시도와
출처에 연결해 보존 정책 안에서 별도 증거로 남긴다. 출처를 확인하지 못한 주장은 그 상태를
표시하며 사실로 확정하지 않는다. 증거 자체를 성공 확정으로 취급하지 않고 원천 서비스의 상태나
허용된 독립 확인과 대조한다. 확인할 수 없으면 `결과 확인 필요`로 남기며, 단순 폐기나
자동 재실행으로 중복을 만들지 않는다. 현재 권한이 없는 사람에게 그 증거를 공개하지 않는다.

초기 추천 기준은 기존 [로컬 SQLite·불변 객체](#impl-storage)와 단일 writer를 유지한다.
이 기준을 만족하는 구체 구현·배치는 선택 사항이며 신규 인프라 도입을 확정하지 않는다.
여러 PC는 호스트의 권한 검사된 서비스로 접근하며 network-mounted SQLite 파일을 직접
공동 사용해 다중 PC 서비스를 만든 것으로 간주하지 않는다. 백업은 일관된 DB와 필요한
객체를 함께 보존하고 별도 복원 검증을 거친다. 다른 PC로 이전할 때 이전 writer의 중지
또는 격리를 확인하고, 새 기기 승인과 현재 권한·계정 재확인을 거치며 오래된 grant·
lease·실행을 부활시키지 않는다. 이전 writer의 배제를 확인하지 못하면 새 writer를 열지
않는다. 자동 호스트 승계는 후순위이며 첫 공유 단계의 전제가 아니다.

일반 사용자는 자기 작업에 필요한 실행 PC·진행·대기·승인 대상·확인 필요 상태를 본다.
기기 등록·연결 관리와 진단은 권한 있는 관리 표면에 두며 모든 client에 관리 HUD를
항상 노출하지 않는다.

**미실행 인수 조건:** 같은 Wi-Fi의 미등록 기기와 철회된 기기는 접근·dispatch 0; 공유
계정에서 담당자 미확인 시 개인 승인 필수 행위 0; 금지된 원문을 shell·브라우저·캐시와
대리 결과로 우회 노출 0(정의된 시험의 인수 기준이며 임의 자유형 생성 전체의 무누출 보증은 아님).
호스트 등록만으로 전면 입력 인계 0; API 읽기와 화면 제어의
준비 상태 독립 확인; 한도 초과 dispatch와 client credential 복제 0. 유효한 로컬 grant/lease의
허용 행동은 불필요한 외부 왕복 없이 진행하고, 필수 최신 확인이 불가능한 행동만 보류한다.
승인 대상·payload·수신자·권한 범위 변경 후 옛 승인 재사용 0; 무관한 원본 변경만으로
작업 전체 중단·재승인 0; 정정 전후 기록의 무단 덮어쓰기 0. 첫 공유 단계에서 호스트
정지, 전송 직후 단절, 늦은 외부 receipt와 재연결을 시험해 미확인 효과의 중복 재전송 0,
보존 대상인 늦은 증거의 폐기 0, 현재 상태 오염 0을 확인한다. 복원 시험에서는 DB·객체
정합성, 인증정보 재인증·회수, 새 기기 재승인과 옛 권한·실행 비부활을 확인한다.
같은 공용 Engine 계정을 쓰는 직원 A/B의 요청 PC와 권한이 다른 시험에서 각 행동의 직원·
요청 PC·실행 PC 귀속, 상대방 자료 접근 차단과 A의 권한·허용되지 않은 이전 Agent memory의
B 전이 차단, 각자 허용된 자료 작업의 정상 실행을 함께 확인한다.

**기술 참고:** 같은 LAN이라는 이유만으로 신뢰를 부여하지 않는 원칙은 [NIST SP 800-207](https://csrc.nist.gov/pubs/sp/800/207/final)을, SQLite 파일을 네트워크에서 직접 공유할 때의 제약과 대안은 [SQLite 공식 안내](https://www.sqlite.org/useovernet.html)를 따른다.

<a id="tech-failure-boundaries"></a>

## 13. Runtime 실패 표현

Bridge·helper·transport·provider conversation·terminal process·visible view는 서로
다른 failure boundary다.

UI와 Agent는 해당 boundary의 실패를 실제 관찰했을 때만 그 boundary가 실패했다고
표현할 수 있다. 그 밖에는 `원인 불명`과 마지막 확인 상태를 보고한다. Helper/bridge
recovery는 resilience 요구사항이자 acceptance test이지 대표 사용자 workflow가 아니다.

UI는 다음 관찰 상태를 구별해 표시한다. 구체 레이블·배치는 구현 재량이다.

| 관찰된 상황 | 보존·표시할 상태와 다음 처리 |
|---|---|
| 원격 PC 또는 transport 응답이 없음 | 마지막 확인 시점·실행 위치·이미 받은 결과를 유지한다. 해당 작업은 상태 미확인으로 두며 실패·종료·취소를 추정하지 않는다. |
| 중지를 요청했지만 확인이 없음 | 중지 요청과 종료 확인을 분리한다. 도달 가능한 경계에서는 새 행동·자동 재개를 차단하되, 이미 전송한 외부 요청의 결과는 별도로 대조한다. |
| 재접속 뒤 기존 완료 증거를 받음 | 같은 실행·대상·계정의 증거인지 확인하고 기존 작업에 연결한다. 화면에 결과가 없었다는 이유로 같은 행동을 재전송하지 않는다. |
| 일부 Task만 완료되고 다른 Task는 실패·대기 | 독립적으로 검증된 결과는 보존한다. 전체 요청을 완료로 표시하지 않고 아직 필요한 부분과 계속 가능한 행동을 구분한다. |
| 계정 만료·권한 회수·quota 소진 | 인증·권한·사용 한도의 원인을 구별한다. 기존 Run을 다른 계정으로 조용히 옮기지 않고 해당 원인을 해결하는 범위만 대기한다. |
| 조정·취소 뒤 이전 Worker 결과가 늦게 도착함 | 결과와 당시 입력의 귀속은 보존한다. 현재 요청에 유효한 부분만 통합하고, 폐기된 지시나 회수된 권한으로 새 행동을 이어가지 않는다. |

읽기·연결 복구처럼 기존 위임 범위에서 안전하게 다시 할 수 있는 작업은 계속 처리한다.
쓰기·발송·제출의 결과가 미확인이라면 접수 증거 또는 해당 서비스의 중복 방지 보장을
대조한 뒤 재시도한다. 로컬 요청 ID를 붙였다는 사실만으로 외부 서비스의 중복 실행이
막혔다고 보장하지 않는다.

<a id="tech-agent-run-binding"></a>

## 14. Agent Profile·Runtime·Effective Run Binding

기본 Codex와 사용자 생성 Agent를 구별한다. 기본 Codex는 유효한 Engine 연결과 기본 실행
구성이 있으면 사용자 정의 Agent Profile 없이 Run을 시작한다. 이 경우에도 실제 지침·모델·
도구·정책·위임·권한·입력·출력의 연결을 보존한다. 선택적 personality와 생각 버블은 기본
Codex 실행의 필수 조건이 아니다. Agent를 생성하거나 선택했을 때만 해당 Profile revision을
추가 결합한다. 아래 Profile 관련 조작은 그 선택적 구성에 적용한다.

Agent Profile은 재사용 가능하고 version이 있는 configuration이다. display identity·
personality·instructions·provider/model policy·candidate tool과 capability ceiling·
context와 memory policy·credential-handle policy·Ontology policy·execution limit·
delegation ceiling을 기술할 수 있다. Profile은 실행 중인 Agent, Chat conversation,
account credential 또는 resource authority grant가 아니다.

System은 Run의 시작 조건과 각 모델 호출에 실제 전달한 구성을 기록한다. 과거 기록은
불변이지만 진행 중인 업무의 context는 새 관찰과 사용자 조정을 반영한다.

```text
Run identity와 출발 조건
  최초 요청 또는 parent-Task delegation, Engine과 선택한 경우의 Agent Profile,
  instructions·policy, budget·sandbox·network·time·delegation 상한

모델 호출별 실제 입력과 구성
  해당 호출의 요청·사용자 조정·대화·도구 관찰
  실제 전달한 context revision과 Memory·source revision 및 포함 이유
  실제 provider·model·tool·adapter version과 현재 availability
  실제 account/resource authority, credential handle, approval 상태
  그 호출에 resolve·retrieve한 Ontology의 참조·범위·출처

작업 사건 이력
  요청 조정, 관찰, 구성 변경, 위임, 승인, 도구 실행과 결과 연결
```

effective action set은 declared capability, current availability, Task delegation,
실제 account/resource authority, 유효 approval, execution limit의 교집합이다.
capability·availability·permission·approval·execution·success는 서로 다른 상태로 남는다.

새 Run에서는 사용자가 Ontology revision 번호를 입력하지 않아도 System이 첫 모델 호출
전에 조직·Desk·Agent에 적용되는 정책에서 active 참조를 resolve하고 필요한 내용을
retrieve한다. 어떤 참조·부분을 어떤 정책으로 읽어 실제 전달했는지 남긴다. 이 참조는
특정 DB 제품이나 상시 watcher를 전제하지 않으며, 파일·manifest·Git·graph·DB 등 선택한
저장 방식으로 해소할 수 있다. 조직 지식이 연결되지 않은 최초 사용의 기본 구성은
[HUM-AGENT-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agent-001)에 남는다.

한 사용자 요청 안에서도 `모델 호출 → 도구 결과 → 다음 모델 호출`은 반복된다. 사용자
추가 지시, Agent의 도구 관찰, 협업자 변경 또는 source adapter의 관찰이 도착하면
System은 관련 변경을 가능한 가장 이른 다음 호출의 context revision에 포함한다.
Agent가 그 내용을 해석해 같은 Run에서 계획·후속 행동을 조정한다. 자료나 Ontology가
바뀌었다는 이유만으로 Run을 일시 중지하거나 새 attempt·fork를 만들지 않는다.

Profile 편집과 기본 Engine 변경은 이미 실행한 호출에 소급 적용되지 않는다. 실행 계정,
정책 상한이나 model 전환은 허용된 변경·fallback 정책과 실제 전환 기록을 따른다.
권한 철회, 승인한 대상·payload 변경, 같은 대상의 동시 쓰기 충돌처럼 실행 조건이 깨진
행동만 재검증·차단한다. 실행 account를 조용히 바꾸거나 과거 snapshot을 덮어쓰지는 않는다.
attempt는 실제 실패한 실행을 재시도할 때, fork는 의도적으로 업무를 분기할 때 사용한다.
나머지 수명주기·구성 변경 선택은 [HUM-RUN-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001)과
[Q-AGENT-14](../../docs/codex/egdesk-product-documentation-governance.md#atlas-q-agent-14)에 남는다.

Chat과 Canvas는 이 binding의 안전한 summary를 projection할
수 있지만 Chat record가 Runtime이나 전체 snapshot인 것은 아니다. secret value·숨은
chain-of-thought·제한 없는 raw system prompt는 필수 제품 disclosure가 아니다.

정확한 object name·ownership scope·editable field·precedence UI·inspection control·
recovery control·사용자에게 보이는 detail은 [HUM-RUN-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001)의
제품 의미와 [Q-AGENT-01](../../docs/codex/egdesk-product-documentation-governance.md#atlas-q-agent-01)–[Q-AGENT-14](../../docs/codex/egdesk-product-documentation-governance.md#atlas-q-agent-14)의
관련 세부 항목에서 미결정으로 남는다. 그 미결정 세부가
위의 binding·non-escalation·과거 기록 보존과 같은 Run 내 조정 경계를 다시 열지는 않는다.

<a id="tech-engine-profile"></a>

### 14.1 Identity plane·Engine Profile·브라우저 로그인

**지원 UI trace**: [ENGINE-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-engine-01), [AGENT-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-agent-01), [BROWSER-02](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-browser-02)

EG-Desk는 최소한 다음 identity plane을 서로 분리한다.

| identity plane | 예시 | 부여하는 범위 |
|---|---|---|
| EG-Desk product identity | local owner, 향후 collaborator | Desk·Board·local sharing scope |
| AI Engine identity | ChatGPT/Codex 구독 account, API project, 다른 provider account | model access·plan/quota·engine-side history와 policy |
| connected-service identity | email·Drive·GitHub·database·MCP service | 해당 service의 data와 action |
| Browser authority context | Firefox profile/container, 로그인된 website account | page별 visibility와 browser action |
| operating-system/resource identity | local user·filesystem permission·keychain | local file·process·credential access |

EG-Desk에 account A로 로그인했다고 Codex가 account B의 구독량을 사용하지는 않는다.
B는 선택한 Engine Profile 안에서 인증되어야 한다. Run은 `engineProfileId`를 고정하며,
나중에 기본값을 바꿔도 active Run이 다른 account 또는 quota bucket으로 이동하지 않는다.

Codex 기준선에서는 독립적으로 선택할 각 구독 account가 격리된 App Server
runtime/config/credential store를 사용한다. 이는 선택한 격리 전략이지 App Server
자체가 EG-Desk multi-account registry를 제공한다는 주장이 아니다. adapter는 login
뒤와 첫 사용 전에 현재 account와 plan을 검증한다. token과 cookie는 OS keychain 또는
engine credential store에 두며 SQLite conversation row·snapshot payload·log·Answer
Briefing·export에 넣지 않는다.

**구독 연결 사용자의 비용 경로.** 의미 판정에는 별도로 허용된 Decisions API 자격을 쓰고, 생성 요청(공개 답변·요약·초안·백그라운드 교훈 포함)은 선택한 구독 계정에서 구독 인증과 가용 사용량을 확인해야 한다. API 키가 존재하거나 모델 이름이 같다는 이유로 생성 API·다른 비용 주체를 대체 경로로 쓰지 않는다. 구독 인증 또는 한도 확인이 안 되면 그 생성만 보류한다. 판정 키·크레딧·시간 예산의 실패는 선택 근거가 없는 상태로 처리할 수 있지만 구독 한도를 새로 부여하지 않는다. 구독 경로와 명시적인 별도 API 사용자는 같은 모드로 취급하지 않는다. [판정·생성 경계](../../apps/firefox-ui-demo/docs/DECISION_MODEL_CONTEXT_SETUP.md#billing-boundary)

**로컬 기능판의 설정·재개 경계.** 앱의 계정 목록과 Agent 버전은 실행 프로필의 참조를 보관한다. 전용 Codex는 해당 `CODEX_HOME`와 별도 엔진 연결, Claude는 선택 프로필의 `CLAUDE_CONFIG_DIR`와 공식 CLI 인증을 사용한다. 둘을 같은 자격증명 저장소라고 가정하지 않는다. 기존 대화 재개는 단순 화면 복원이 아니다. 원래 엔진·계정 소유자·대화 귀속을 다시 확인하고, 바뀌었거나 확인되지 않으면 그 기록을 다른 사용자나 새 세션으로 조용히 재개하지 않는다. 설정 파일을 가져와도 기기 전용 계정 참조는 옮기지 않는다. [현재 계정 선택·로그인](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-local-accounts)

아래는 **목표**인 browser 기반 login 경로다. 현재 별도 로그인 카드가 열린 것만으로 전용 쿠키 컨테이너나 EG-Desk가 제어하는 CLI 로그인 브라우저가 검증된 것은 아니다.

```text
Click [AI Engine 계정 연결]
-> System이 선택한 Engine Profile에 대해 account/login/start 시작
-> 반환된 authUrl을 전용 auth tab/container에서 열기
-> 사용자가 의도한 account를 선택하고 provider UI 완료
-> account/login/completed 수신
-> account/updated 또는 account/read의 account + auth mode + plan 검증
-> policy에 따라 auth tab 닫기/유지
-> 시작한 EG-Desk control로 focus 복귀
```

EG-Desk가 Firefox 기반이라는 이유로 전용 auth context가 관련 없는 일반 Browser
session을 말없이 재사용해서는 안 된다. 명시적인 account chooser 또는 격리된 cookie
container를 보여 줄 수 있다. cancel·callback loss·account mismatch·quota exhaustion·
logout·token refresh failure·기본 Engine Profile 전환은 복구 가능한 상태다. 정확한
label·기본 scope(app/Desk/Chat/request)·전환 확인은
[사용자 결정 목록](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-engine-001)에
연결한다.

<a id="tech-usage-modes"></a>
**사용 모드 분리 (2026-11-25 owner 확인, 같은 날 정정).** 사용자 경험을 위해 다음 두 사용 방식을 서로 분리한다. 기준은 '위'(사용자와의 대화까지)와 '아래'(Ontology가 적용된 Agent 엔티티)다. 표시명·선택 UI·전환 문구는 확정하지 않았다.

- **(가) EG-Desk '위' (가칭, 승인 대기):** 사용자와의 '대화'까지의 모든 것이다. 채팅 하네스, 도구 호출, 브라우저 조작, 컴퓨터 조작을 모두 포함하며 Desk·Board·카드(브라우저·터미널·파일) 같은 작업 표면 위에서 돈다. Codex·Claude는 대화 상대(엔진)로 쓰이거나 카드 안에서 자기 하네스로 돈다. Ontology가 적용된 Agent 엔티티는 없으며, 기억은 그 대화(대화 내역)와 엔진 자신의 것에 머문다. 앱을 EG-Desk 밖에서 따로 쓰는 것과는 다르다.
- **(나) EG-Desk '아래' (가칭, 승인 대기):** EG-Desk의 Ontology가 적용된 Agent 엔티티가 셋업된 상태다. Agent(인격체)와 Ontology가 하네스가 되고, 엔진은 그 Agent의 순수 모델로 쓰인다. 기억은 Agent와 Ontology가 소유하며 Board·대화를 넘나든다. Agent와의 대화도 '위'의 장치(채팅 하네스·도구 호출 등)를 함께 쓴다(해석, owner 확인 전).
- 두 모드의 기억은 섞지 않는다. '위'의 대화 내역이나 엔진 자체 기억을 '아래'의 Agent·Ontology 기준 기록으로 읽어 들이거나 승격하지 않는다.
- (나) 모드의 완성도는 Agent와 Ontology 기능의 완성도에 달려 있으며, 이 계약의 위 'Agent engine boundary'·Engine Profile 격리 및 아래 Memory 소유 규칙과 함께 읽는다.
- 위 Claude의 `~/.claude` 상속 등 기존에 결정한 엔진 앱 설정 처리는 (가) '위' 사용에 대한 결정으로 읽는다(해석, owner 확인 전). 이를 (나) '아래'에 적용할지는 이 기록에서 정하지 않는다.
- 정정 기록(2026-11-25): 같은 날 처음 기록은 (가)를 "Codex·Claude를 그 앱 그대로 쓴다"로 적었으나, owner가 "그 앱 그대로 쓰는건 아님. eg-desk '위'에 돌아가는거랑 '안'에 돌아가는거임"이라고 정정했다.
- 정정 기록 2(2026-11-26): owner가 "그 '위' 라는거는 채팅 하네스도 있는데? '안'은 에이전트 엔티티가 생기고 난 부터임."이라고 정정했다. '위'에 채팅 하네스가 포함되고, '안'은 Agent 엔티티 생성부터다.
- 정정 기록 3(2026-11-26): owner가 "'위' -> 사용자와의 '대화' 까지. 툴 콜링, 브라우저 컨트롤, 컴퓨터 유스 다 포함. '아래' -> 이지데스크의 '온톨로지' 가 적용된 '에이전트' 엔티티가 셋업된 상태."라고 정리했다. 이에 따라 '안'을 '아래'로 바꿨다.

<a id="tech-storage-export"></a>

## 15. 로컬 데이터·불변 객체·대화 event·내보내기

**지원 UI trace**: [DATA-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-data-01), [AI-04](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-04)

로컬 persistence 기준선은 query 가능한 state와 불변 payload byte를 분리한다.

```text
SQLite
  manifest·object hash·relation·event·state transition·index·
  작은 검색용 text·retention reference

content-addressed object store
  불변 text 또는 binary payload byte
  raw capture·agent_input·preview/semantic·artifact payload

renderer
  사용자에게 보이는 view가 필요할 때만 materialize
```

SQLite는 서로 무관한 JSON/HTML 파일을 훑는 방식보다 transactional relation·부분 query·
event ordering·migration·full-text index를 더 안정적으로 제공하므로 로컬 기준선으로
선택했다. SQLite 자체가 portable 제품 format인 것은 아니며 WAL 또는 외부 object가
있을 때 database 파일만으로는 완전한 backup이 아니다.

object identity는 live source path가 아니라 payload byte의 hash다. 파일이 바뀌면 새
object hash를 만들고 이전 payload는 과거 snapshot으로 남는다. storage write는 임시
object에 쓴 뒤 length/hash를 검증하고 atomic하게 publish한다. 기존 hash path를 다른
byte로 덮어쓰지 않는다. text와 binary는 같은 immutability rule을 따른다. content type·
encoding·logical role·lineage는 hash algorithm이 아니라 manifest에 속한다.

snapshot 하나는 필수 JSON blob 하나가 아니라 manifest와 하나 이상의 불변 payload
role로 구성된다. 작은 manifest와 선택한 text는 SQLite에, 큰 native/binary body는
object store에 둘 수 있다. reference 기반 retention은 Saved Board·Answer Briefing·
pinned snapshot·active Run object를 유지한다. 참조되지 않는 object는 사용자에게 보이는
retention policy와 garbage collection 대상이 된다. redaction은 derived payload를 만들며
같은 hash 뒤의 original object를 변경하지 않는다.

conversation history는 순서가 있는 event model이다. message·tool call·Reader packet·
Run/Task transition·Canvas relation·decision·export/import event는 SQLite에서 query할
수 있고, 큰 message attachment와 artifact는 object reference로 둔다. derived summary는
재열기를 빠르게 할 수 있지만 요약 대상인 canonical event나 불변 payload를 대체하지 않는다.

<a id="tech-portable-bundle"></a>

### 15.1 이동 가능한 단일 `.egdesk` bundle

**지원 UI trace**: [DATA-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-data-01)

현재 로컬 기능판은 저장한 Board/Desk의 선택 내용을 미리 보고 새 사본으로 가져온다. 기기 전용 로그인·원본 파일 연결·실행 중인 프로세스·제어권은 복구하지 않는다. 자동 Desk 복구 기록은 화면 상태의 보존이고 기존 대화나 외부 효과를 되돌리지 않는다. 아래의 대상 병합과 조직 백업·복원은 이 기능만으로 제공됐다고 간주하지 않는다. [현재 열기·복구 절차](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-local-recovery)

제품은 전송 가능한 단일 `.egdesk` 파일을 제공한다. 선택한 logical content는 다음과 같다.

```text
manifest.json              format version·root·object list·hash
events.jsonl               이동 가능한 순서형 conversation/state event
README.md 또는 transcript.md 사람이 읽을 수 있는 summary/transcript
objects/<hash>             필요한 불변 payload byte
```

ZIP/ZIP64는 후보 container이지 domain invariant가 아니다. Export는 먼저 사용자가
선택한 root에서 닫힌 reference graph를 만들고, 포함·제외 항목을 보여 주고, 모든 hash를
검증한 뒤 bundle을 atomic하게 publish한다. token·cookie·keychain entry·machine 전용
absolute path·transient cache·선택하지 않은 private scope는 제외한다. 선택적 encryption은
암호화되지 않은 임시 사본을 영속 결과로 남기지 않으면서 payload 전체를 보호해야 한다.

Import는 parse 성공만으로 data를 연결하지 않는다. format version·manifest·hash·필수
object·permission을 검증하고, 생성하거나 merge할 정확한 root를 보여 주고, identity/
revision collision을 preview하고, transactional staging scope에 적용한 뒤 대표 Chat·
Canvas·Snapshot·Board reference를 다시 여는 것으로 완료를 증명한다. 원격 backup 또는
sync는 별도의 owner-approval boundary로 남는다.

최종 포함 기본값·encryption UX·conflict policy·retention 선택은 다음에서 추적한다.
[HUM-EXPORT-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-export-001)
and
[HUM-SNAPSHOT-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001).

<a id="tech-accessibility"></a>

## 16. 접근성과 동등한 control path

**지원 UI trace**: [UX-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ux-01)

Atlas의 이름 붙은 모든 action에는 검사 가능한 focus target, 적용 가능한 경우 keyboard와
동등한 activation, accessible name/state, 결정적인 focus return, Canvas만으로 표현한
의미에 대한 reduced-motion 또는 non-spatial 대안이 필요하다. Snapshot payload role·
Agent activity·input ownership·approval state·failure cause를 색·움직임·위치만으로
전달해서는 안 된다. 다음 입력·복귀 동작도 같은 행동의 일부다.

| 상황 | 보장할 동작 |
|---|---|
| 상세 보기·메뉴·대화상자에서 돌아옴 | 시작한 control이 존재하고 접근 가능하면 그곳으로 복귀한다. 사라졌으면 같은 업무의 유효한 상위 진입점으로 이동한다. 다른 업무의 초안이나 실행 대상으로 바꾸지 않는다. |
| Chat에서 한글 등 입력기 조합을 확정함 | 조합 확정 키를 메시지 전송으로 중복 처리하지 않는다. 조합·일반 입력·전송의 순서를 실제 플랫폼에서 검사한다. |
| Canvas 항목 이동·정렬·크기 변경 | 제품이 제공하는 드래그 기능에는 적용 가능한 클릭·탭 대안과 키보드 경로를 둔다. 키보드 대안의 존재만으로 드래그 없는 포인터 대안을 대신하지 않는다. |
| Agent 활동·대기·오류가 갱신됨 | 사용자 focus를 옮기지 않고 상태와 다음 행동을 전달한다. 의미 없는 반복 알림을 억제하며 상태를 다시 조회할 수 있게 한다. |
| 따라보기·확대 애니메이션을 줄임 | 같은 대상·진행 단계·결과에 도달할 수 있어야 한다. 모션을 끄거나 직접 탐색했다고 Agent 작업이 중지되지는 않는다. |

정확한 conformance target은
[HUM-A11Y-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-a11y-001)에
남지만 기본 keyboard/focus semantics 구현은 그 결정을 기다리지 않는다.

## 인수 증거

UI가 존재하는 것만으로 기능 완료가 성립하지 않는다. acceptance에는
다음 증거가 필요하다.

- 완전한 interaction trace
- 모든 blocking transition에서 보이는 state feedback
- 기록된 context와 authority boundary
- 반복 가능한 성공 검사와 관련 recovery 검사
- 사용자가 검사할 수 있는 artifact·state·action receipt
- 현재 runtime evidence와 제안된 behavior의 명확한 구분

<a id="implementation-design-details"></a>

## 17. 구현 상세와 조건별 인수 절차

다음은 기존 기술 경계를 구현하는 선택 기준선이다. 새로운 제품 권한을 부여하거나 이미 실행된 구현을 뜻하지 않는다. 버전·측정·호환성 결과로 동등한 구현을 선택할 수 있지만 입력·저장·권한·완료의 의미는 유지한다. 정책 선택에 종속된 값은 해당 조건 아래에서 동작한다.

### 17.A 셸·Board·탐색

<a id="impl-shell"></a>
#### 셸 준비와 독립 복구 경계

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-shell)

실행기는 Firefox renderer·bridge와 별도 수명을 가진다. 입력은 실행 의도, 선택된 설치/profile 참조, launch ID다. 로컬 IPC 준비 응답은 launch nonce·프로세스 세대·profile 식별·셸 준비 단계를 포함한다. 포트 응답이나 프로세스 존재만으로 준비 완료를 판정하지 않는다. 동일 실행 의도는 기존 인스턴스로 전달하며 timeout 뒤 중복 Firefox를 생성하지 않는다.

실행기 오류 UI는 macOS NSAlert, Windows TaskDialogIndirect를 사용한다. Linux GUI 복구 의존성이 없거나 실패하면 `Terminal=true`인 독립 복구 진입점으로 같은 상태·행동을 제공한다. OS 오류와 사용자 취소는 시작 성공이 아니다. [Apple NSAlert](https://developer.apple.com/documentation/appkit/nsalert), [Windows TaskDialogIndirect](https://learn.microsoft.com/en-us/windows/win32/api/commctrl/nf-commctrl-taskdialogindirect), [Desktop Entry 규약](https://specifications.freedesktop.org/desktop-entry/latest/recognized-keys.html).

셸 준비·Board 목록·Engine 연결은 독립 상태다. 종료는 로컬 새 dispatch 차단 → 확정 입력 기록 → 로컬 전용 runtime 종료 확인 → 최종 세션 commit → 셸 종료 순으로 수행한다. 정상 종료도 열린 Board 구성 자체를 삭제하지 않는다. 원격 runtime은 별도 소유·상태를 유지한다. 강제 종료·전원 손실에는 종료 handler 실행을 전제로 하지 않는다.

최초 준비의 표시 목표는 기존 Desk·Canvas 위 live Browser View의 화면 맞춤 집중 보기이며,
재방문은 마지막 집중/일반 Desk 카메라 상태 복원이다. 앱 상단 바는 창 위쪽 가장자리에
붙이되 기존 창 이동 영역과 주소·입력 컨트롤을 유지한다. 빈 Canvas 드래그를 새 창 이동
모드로 만들지 않는다. `frame-visible`만으로 프로필·Codex 연결까지 완료됐다고 하지 않는다.
사용자 생성 Agent가 없는 경우는 셸·기본 Codex 오류가 아니며 [최초 사용 계약](#tech-first-use)에 따라 분기한다.

**인수 절차:** 각 OS 진입, 반복 실행, 파일 연결 실행에 대해 실행 파일 누락·잘못된 준비 nonce·10초 지연·bridge 실패를 주입한다. 셸 없는 상태에서 복구 행동을 실행할 수 있고, 정상 경로는 Desk 하나이며 Engine 실패 중 파일 열기가 가능해야 한다. 종료 중 쓰기 지연·process 종료 거부를 주입해 취소/강제 종료의 대상·미기록 범위를 대조한다. 실패 fallback은 독립 복구 진입점이며 사용자 profile·credential을 지우지 않는다.

<a id="impl-resource-monitor"></a>
##### 셸 자원 관측과 표시의 경계

**화면 연결**: [자원 사용량 표시](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-resource-monitor)

CPU·RAM·디스크·네트워크의 지속적인 관측은 System의 로컬 수집 책임이며 Agent의 추론·도구
호출을 매 갱신마다 시작하지 않는다. 수집과 화면 갱신을 분리하고, 표시를 위해 원본 콘텐츠나
네트워크 통신 본문을 수집하지 않는다. 상시 관측은 장기 이력 저장·외부 전송·원격 기기 수집
권한을 부여하지 않는다.

각 샘플은 측정 호스트·범위(시스템 전체/EG-Desk와 포함 프로세스)·단위·측정 구간·확인 시각·
유효 상태를 구별한다. 시스템 전체 값과 앱 값을 합하거나 다른 PC의 값을 로컬 값처럼 쓰지 않는다.
CPU 비율의 코어 정규화 기준과 RAM 비율의 기준 용량을 명시한다.
디스크는 대상 볼륨의 사용/전체 공간과 읽기·쓰기 전송률을 별개로 취급하고,
네트워크는 대상 인터페이스와 송수신 전송률을 구별한다. 용량이나 대역폭의 분모가 확인되지
않으면 퍼센트 또는 원형 채움으로 임의 변환하지 않는다.

권한 부족·수집 실패·절전 후 오래된 샘플을 `0`이나 최신 측정값으로 대체하지 않는다.
누적 카운터 초기화·재시작·인터페이스 변경을 검출해 음수 전송률이나 잘못된 구간 계산을 막는다.
관측 자체가 작업을 방해하지 않도록 수집 중복·UI 갱신 비용·메모리 사용을 제한하고,
앱 종료 시 소유한 수집 작업을 종료한다. 정확한 수집 스택·갱신 간격·경고 임계값·이력 보존은
미정이며, 구현 및 설계 검토에서 별도로 정한다.

**미실행 인수 조건:** 정상·미측정·지연·권한 거부·절전 복귀에서 대상·단위·최신성이
일치하는지, 수치 갱신 중 Chat 입력과 Canvas pan·zoom이 유지되는지, 집중 보기·좁은 창에서도
지표에 접근 가능한지 확인한다. 수집 비용과 사용하지 않는 구독의 해제를 함께 검증한다.

##### 인계가 확인된 recorder의 종료 예외

정상 종료의 로컬 runtime 종료 대상에서 제외할 수 있는 recorder는 독립 host 인계의 source·mask·구간 저장·Canvas 소유·중지 endpoint를 확인하고 host ACK를 받은 경우뿐이다. 앱 내부 MediaRecorder는 종료 대상에서 제외하지 않는다. 인계 실패·미확인은 앱을 유지하거나 기록을 종료하는 경로로 돌아간다. Board 닫기는 detached recorder도 기존 소유 규칙에 따라 종료한다.

##### 10초 이전 준비 상태

준비 단계는 `launching/frame-visible/interactive/unknown/failed`로 구분한다. 단계 변경과 접근성 상태 안내는 동일 launch ID에 결합하고 반복 실행은 기존 준비 요청에 합친다. 취소한 launch의 늦은 ready 응답은 화면 활성화에 사용하지 않는다.

**미실행 인수 조건:** 0–10초 지연·반복 실행·취소 후 ready에서 빈 무표시 창, 중복 Desk, 반복 포커스 인계가 없는지 검사한다.

##### macOS·Windows 비GUI 복구 진입

복구 도구는 Firefox·bridge·AppKit/TaskDialog 오류 UI에 의존하지 않는다. macOS는 stdin/stdout 기반 독립 실행 파일과 실행 가능한 launcher script, Windows는 `/SUBSYSTEM:CONSOLE` 실행 파일을 기준선으로 한다. 기존 설치·profile 참조, launch nonce·세대를 재검증하고 credential·profile을 삭제하지 않는다. 문자 실행 기반은 [Apple Terminal](https://support.apple.com/en-ke/guide/terminal/apdb66b5242-0d18-49fc-9c47-a2498b7c91d5/mac), [Windows Console subsystem](https://learn.microsoft.com/en-us/cpp/build/reference/subsystem-specify-subsystem?view=msvc-170)을 따른다.

복구 메뉴의 표시와 입력 처리는 같은 정의 `1=status, 2=diagnostics, 3=restart-same-install, 0=exit`에서 생성한다. 비GUI 복구의 OS별 매핑을 달리하지 않는다.

**미실행 인수 조건:** Firefox·GUI 오류 모듈 사용 불가에서 진단·동일 설치 재시도·종료를 수행하고, `0`은 종료만, `3`은 검증된 동일 설치 재시작만 요청하는지 대조한다. 재시작 중복·다른 profile 연결·OS 차단 우회는 0건이어야 한다.

##### 부분 종료 취소와 숨은 runtime 방지

앱 종료는 `prepare→flush→stop-owned→commit-session→quit`와 단일 quit operation을 사용한다. 새 로컬 dispatch를 먼저 차단하고 종료 전 열린 구성 및 대상 집합을 고정한다. 취소는 미발송 종료 요청만 제거한다. 이미 발송한 요청은 조회로 판정하며, 미발송·권한 유효 대상만 다시 dispatch 가능하게 한다. 진행 중 commit 결과도 확인한 뒤 종료 취소를 완료한다. 강제 종료는 명시한 로컬 범위만 처리하며 마지막 유효 세션을 남긴다.

앱 종료 후 녹화 계속은 기존 recorder 호스트 인계 계약의 유효 소유자·지속 실행·Canvas 표시 인계 receipt가 있는 대상만 예외다. 인계 불가이면 기록 중지 후 종료하거나 종료를 취소한다. 이 예외를 일반 runtime의 background 유지로 확대하지 않으며, Board 닫기는 여전히 전용 recorder를 종료한다.

**미실행 인수 조건:** 부분 저장·부분 종료·응답 유실·취소·강제 종료에서 숨은 실행과 자동 부활이 없고, recorder 인계 실패가 계속 기록 허용으로 바뀌지 않아야 한다.

<a id="impl-restore"></a>
#### 자동 세션의 commit과 복구

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-restore)

로컬 저장은 SQLite 단일 writer, WAL, `synchronous=FULL`을 사용한다. WAL-reset 수정이 포함된 3.51.3 이상 또는 공식 수정 backport를 기준으로 한다. WAL DB를 네트워크 공유 파일로 동시 사용하지 않는다. [SQLite WAL](https://www.sqlite.org/wal.html).

세션 generation은 `sessionId, deviceId, seq, parentSeq, schemaVersion, stateHash, eventCursor, viewStates, draftRefs`를 가진다. 자료 URI·runtime ID·권한 참조와 payload hash를 구분한다. 외부 파일의 누락은 View의 degraded 상태이지 세션 구조 전체의 무효가 아니다.

View 열기·닫기 확정·그룹 변경·소유 변경은 즉시 commit 대상으로 한다. pan·scroll·드래그 중간 값은 300ms idle 또는 최대 2초에 합치며 pointer-up에서 최종값을 기록한다. 허용된 편집 초안은 조합 완료 후 300ms idle, 계속 입력할 때 최대 1초마다 기록 대상으로 만든다. 이 시간은 정상 writer의 전송 목표이며 디스크 장애 중 보존 보장이 아니다.

불변 payload 임시 기록 → 길이/hash 확인 → publish → `BEGIN IMMEDIATE` → event·참조·materialized state·generation head 갱신 → COMMIT으로 처리한다. 실패 시 rollback하며 기존 head를 유지한다. orphan payload는 참조되지 않은 상태로 남고 성공 기록으로 노출하지 않는다. lock 충돌은 250/1000/3000ms의 제한된 재시도 후 사용자 재시도로 전환한다. [SQLite transaction](https://www.sqlite.org/lang_transaction.html).

정상 종료는 편집기 flush와 진행 중 DB commit을 기다린다. Firefox `requestTabStateFlush()`는 수집 완료와 장시간 대기 가능성을 가진다. 이를 EG-Desk DB의 원자적 commit이나 모든 Browser form의 디스크 보존으로 오인하지 않는다. 검증된 native 상태를 얻지 못하면 해당 Browser는 URL 기반 재구성으로 기록한다. [Firefox Session Store](https://firefox-source-docs.mozilla.org/toolkit/components/sessionstore/utils.html).

복구는 commit된 generation 중 schema·hash·내부 참조가 유효한 최대 seq를 사용한다. 정상 종료 표지가 없어도 유효 commit을 버리지 않는다. 별도 정상 DB 보존본은 online backup API로 만들고 무결성 확인 뒤 최근 두 보존본을 교대 유지한다. 변경이 있으면 60초 간격과 정상 종료에 시도하며 backup 실패를 원 DB 손상으로 표시하지 않는다. DB 전체 손상 시 원 DB/WAL을 보존하고 마지막 유효 보존본을 새 복구 저장소로 연다. 없으면 빈 Desk로 진행한다. [SQLite Backup API](https://www.sqlite.org/backup.html).

복원 요청은 `restoreEpoch`와 View version을 가진다. 사용자 변경 이후 도착한 결과는 해당 View를 덮지 않으며 닫기 tombstone을 존중한다. Browser는 허용된 native 상태/URL, 파일은 원본 revision+초안, Chat은 기존 event 참조, Terminal은 검증된 process 또는 출력 Snapshot으로 복원한다. 재연결 자체는 모델 호출이 아니다.

**인수 절차:** payload publish 전후·DB COMMIT 전후·backup 중에 강제 종료를 주입한다. 마지막 유효 generation 또는 명시된 보존본만 복원되고 부분 구성 혼합이 없어야 한다. 목록 읽기를 지연시킨 동안 새 View를 열고 기존 View를 닫아 늦은 복원이 되돌리지 않는지 확인한다. 파일 누락·권한 철회·DB 손상·미저장 보존 두 정책을 각각 대조한다. fallback에서도 Saved Board와 손상 증거는 유지한다.

정상 DB 보존본은 online backup API로 만들고 무결성 확인 뒤 최근 두 사본을 교대 유지한다. 변경이 있으면 60초 간격과 정상 종료에 시도한다. 이 사본은 **제품이 관리하는 제한된 crash-recovery 저장물**이며, 사용자 초기화의 선택형 자동 보호 백업을 켜거나 대신하지 않는다. 두 기능의 목적·수명·상태·포함 범위를 분리한다. 사본 생성 실패를 원 DB 손상으로 표시하지 않는다.

명시적 삭제·초기화는 대상 기록과 payload를 포함하는 관리형 사본까지 처리 집합에 넣는다. 삭제 범위·정책·삭제 epoch를 먼저 기록하고, 관련 사본의 신규 생성·복구 활성화를 차단한다. 사본에서는 대상 기록을 제외해 재작성하거나 정책이 허용한 정리를 수행한다. 암호화된 사본의 키 교체를 사용하는 경우에는 대상 데이터가 없는 사본으로 재작성하고 이전 사본을 해독할 키의 폐기까지 확인한다. 키 이름 변경·새 키 발급·만료일 설정만으로 삭제 완료를 판정하지 않는다.

복구 과정은 최신 삭제 tombstone과 삭제 epoch를 오래된 사본 값으로 되돌리지 않는다. 사본을 활성화하기 전에 이후 삭제를 적용하고, 최신 삭제 상태를 확인할 수 없으면 해당 기록의 복원을 차단한다. DB 전체 손상 시에도 이 검사를 통과한 보존본만 복구 저장소로 연다. 통과하는 사본이 없으면 빈 Desk로 진행하며 삭제 대상 데이터를 자동 재활성화하지 않는다.

복구 가능한 대상 데이터가 사본에 남거나 키 폐기·정리 결과가 미확인이면 `deletionPending`을 유지한다. 보존 제한이나 사용자에게 명시된 보관 정책 때문에 즉시 정리할 수 없는 경우에는 대상·이유·기한을 표시하며 숨은 보존 예외를 만들지 않는다. **인수 절차:** 삭제 직후·사본 재작성 중·키 폐기 전후에 충돌을 주입하고 각 관리형 사본으로 복구를 시도한다. 삭제한 기록이 재등장하지 않고, 남은 사본이 있는 동안 완료 표시가 나오지 않아야 한다. 사용자가 선택적으로 만든 보호 백업은 별도 정책·영향 목록으로 대조한다.

<a id="impl-agenda"></a>
<a id="impl-board"></a>
#### 저장 구성, 충돌과 정본 revision

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda)

Board는 `agendaId, title, metadataVersion, headRevision`과 불변 구성 revision을 가진다. 구성 revision에는 포함 목록·resource/context 참조·선택 배치·허용 payload·checkpoint 참조·parent revision을 기록한다. 이름 변경은 metadataVersion만 갱신한다. 저장 범위에 없는 파일 내용·credential·runtime을 복제하지 않는다.
제품 표시명 Board와 기존 `agendaId` 등 wire·storage 식별자는 다른 층위다. 표시명 변경만으로 저장 스키마나 기존 데이터의 identity를 바꾸지 않는다.

업데이트 요청은 `operationId, agendaId, expectedHead, draftHash, includedMemberIds`다. 하나의 transaction에서 expectedHead를 비교하고 새 revision과 head를 함께 기록한다. 같은 operationId 재요청은 같은 결과를 반환한다. 불일치는 충돌이며 저장 성공으로 처리하지 않는다.

확인된 저장 manifest의 같은 범위를 갱신하는 빠른 저장도 동일한 expectedHead·권한·원자성 검사를 사용한다. 구성원·보존 모드·공개/권한 범위가 달라지면 이전 manifest 확인을 재사용하지 않고 범위 미리보기로 전환한다. 빠른 저장은 일반 정책 기본값을 새로 결정하거나 저장 범위 밖의 변경을 포함하는 기능이 아니다.

저장 확인은 요청의 draftHash·클라이언트 편집 revision에 연결한다. 확인이 도착하기 전에 생긴 새 배치·구성 변경은 현재 초안에 남겨 `저장됨 · 이후 변경 있음`으로 표시한다. 오래된 ACK가 현재 dirty 상태 전체를 지우거나 새 geometry를 되돌리지 않는다.

3-way 비교는 기준·최신·초안을 사용한다. 서로 다른 필드의 변경과 겹치지 않는 구성원 추가는 병합 미리보기를 만들 수 있다. 같은 필드, 삭제/수정 충돌, 배치 부모의 충돌은 명시적 해결이 필요하다. 파일 본문·업무 의미를 이 저장 알고리즘으로 자동 병합하지 않는다. ‘덮어쓰기’도 최신 head의 후속 revision이며 기존 내용을 조용히 수정하지 않는다.

저장 이력 정책이 최신만이면 과거 구성 복구는 제공하지 않되, 다른 Answer/Snapshot이 참조하는 불변 payload까지 삭제하지 않는다. 이력 복구는 과거 head로 시간을 되감는 대신 선택 구성을 새 revision으로 발행한다.

다른 PC에 정본 authority가 있으면 동일 expectedHead protocol과 operation receipt를 사용한다. offline 초안은 `로컬 보관·업데이트 미전달`이며 정본 성공이 아니다. 실제 원격 transport·identity·비용의 승인과 무관하게 동일 protocol의 로컬 다중 client 검사는 가능하다.

**인수 절차:** 두 client가 r7에서 서로 다른 필드와 같은 필드를 각각 변경하고 저장한다. 비충돌 병합 미리보기, 충돌별 값 선택, 비교 도중 r9 도착, 응답 유실 후 동일 operationId 재시도를 검사한다. 초안 보존·단일 성공 revision·범위 밖 변경 0건이 acceptance다. 한글 80자/81자·조합 Enter·동명이름·쓰기 실패·최신만/전체 이력 복구도 확인한다. fallback은 원 초안과 새 Board 저장이며 강제 덮어쓰기가 아니다.

##### 생성 재시도와 projection identity

최초 전송 전에 `createOperationId, newAgendaId, initialRevisionId, draftHash, sourceProjectionId?`를 로컬 outbox에 기록한다. 생성 revision·head·operation 결과를 원자적으로 저장하며 같은 operation 재요청은 같은 ID와 결과를 반환한다. 같은 operation의 다른 hash는 거부한다. 응답 유실은 operation 조회 후 재시도한다. 로컬 의도 기록 실패 시 외부 전송하지 않고 메모리 초안을 유지하며 `아직 기록되지 않음`을 표시한다. 영속화되지 않은 초안의 앱 재시작 복구는 약속하지 않는다.

**미실행 인수 조건:** 생성·다른 이름 저장의 응답 유실과 반복 클릭에서 Board/projection 중복 0건, 원 A의 identity·변경 상태 유지 여부를 검사한다.

##### 구성원 유효성과 직렬화

검증 결과는 `memberId, kind, resourceId/viewId, sourceRevision/range, mode, availability, accessEpoch`에 결합한다. commit 직전에 선택 집합·권한·draft version을 재검사한다. 동일 View 중복만 합치며 같은 Resource의 다른 View는 합치지 않는다. credential·살아 있는 process·임의 실행 명령은 직렬화하지 않는다. 원문 포함 권한을 확인하지 못하면 원문을 기록하지 않는다.

**미실행 인수 조건:** 이름 경계값·IME·선택 후 권한 철회·offline·중복 View에서 잘못된 포함·조용한 누락·권한 확대가 없는지 검사한다.

<a id="impl-agenda-lifecycle"></a>
<a id="impl-board-lifecycle"></a>
#### 소유권에 따른 닫기와 삭제

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda-lifecycle)

자료 참조 집합과 runtime 유지 소유 집합을 분리한다. 단일 소유 정책은 소유자 수 1을, 공동 유지 정책은 명시적으로 승인된 소유 집합을 집행한다. 살아 있는 runtime을 유지하는 소유자는 Canvas에서 찾을 수 있는 표현을 가져야 한다.

닫기 입력은 `operationId, targetProjection, expectedOwnershipVersion, runtimeTargets`다. 의도 기록 → 소유/권한 재확인 → 새 행동 차단 → 대상별 종료 요청 → receipt 기록 → projection 제거로 처리한다. 외부 process 종료와 SQLite commit을 하나의 분산 transaction으로 주장하지 않는다. 소유가 바뀌면 종료 대상을 다시 계산하고 새 소유자의 실행을 끊지 않는다.

Codex는 기존 구독 인증 Engine Profile의 app-server 연결을 사용한다. 새 연결마다 `initialize → initialized` 후 메서드를 호출한다. 이력 표시는 `thread/read`, 실행 연결은 검증된 thread에 대한 `thread/resume`, 실제 사용자 재개는 `turn/start`로 구분한다. 정상 steering 때문에 fork나 interrupt를 호출하지 않는다. `turn/interrupt`의 `{}`는 요청 접수이며 `turn/completed`의 interrupted 상태와 별도 tool/process 종료 증거를 확인한다. 다른 작업까지 멈추기 위해 account 전체 app-server를 종료하지 않는다. [공식 App Server 계약](https://learn.chatgpt.com/docs/app-server).

통신 단절은 종료 확인이 아니다. 재접속하면 동일 기기·process 세대·thread·계정·operation을 대조한다. 외부 효과가 미확인이면 현재 상태/receipt를 조회하기 전 재발송하지 않는다. 성공한 독립 작업과 늦은 결과는 보존하되 중지된 작업의 새 행동을 만들지 않는다.

삭제는 확인한 Board revision과 소유 version에 결합한다. 종료 미확인은 삭제 대기다. 휴지통 이동은 복구 정책·만료·구성 참조를 원자적으로 기록한다. 복구는 현재 권한을 다시 검사한다. 영구 삭제는 선택 참조 제거와 미참조 payload 정리의 결과를 따로 기록하며 공유 참조·원본 파일·방·credential은 제외한다. 처리 중 권한 철회는 미실행 단계만 중지한다.

**인수 절차:** 공동 소유/단일 소유 각각에서 A 닫기, B 참조 유지, 소유 이전 경합, 원격 종료 응답 유실을 재현한다. 전용 종료 확인 전 Canvas 표현이 남고 공유 실행이 유지되어야 한다. 이어 동시 저장·휴지통 이동 실패·복구 실패·권한 철회·영구 삭제 일부 실패를 주입한다. 실패 대상만 재시도하며 이미 종료/삭제한 항목을 복구됐다고 표시하지 않아야 한다. 재열기 후 모델 호출·예약 재개·catch-up 자동 실행은 0건이어야 한다.

##### Board 구성 변경과 파일 편집을 분리한다

닫기 의도에 `projectionId, configDraftVersion, baseAgendaRevision, fileBufferVersions, 선택한 처리, operationId`를 고정한다. 선택 검증→선택한 파일 저장/초안 처리→그 결과 revision에 결합된 Board 저장→전용 실행 종료 확인→projection 제거 순서다. 각 완료 receipt를 보존하고 재시도는 미완료 단계만 수행한다. 앱 종료의 자동 세션 기록은 이 명시적 Board 닫기와 다르며 Saved Board를 갱신하지 않는다.

**미실행 인수 조건:** 네 변경 조합에 저장 실패·충돌·취소를 주입하여 구성과 파일의 상호 폐기 0건, 저장 확인 전 projection 제거 0건을 검사한다.

##### 휴지통 밖 삭제 처리 내역

삭제 operation은 목록 분류와 독립적으로 영속화한다. 기간 만료는 선택된 정책에 따라 같은 상태 기계를 시작하며 새 승인이나 새 보관 기한을 만들지 않는다. 완료는 종료·참조 처리·삭제 대상 payload 및 관리형 복구 사본 처리 결과에 따른다. 적법하게 공유 유지되는 자료는 삭제 범위 밖으로 구별한다. 최신 삭제 epoch를 확인하지 못하는 보존본은 복구에 사용하지 않는다.

**미실행 인수 조건:** 세 삭제 정책의 부분 실패·재시작·권한 철회에서 처리 재진입 가능, 실패 항목만 재시도, 삭제 데이터 재등장 0건을 검사한다.

##### 공동 유지 책임 해제

`runtimeId, ownerProjectionId, expectedOwnershipVersion, operationId`로 조건부 변경한다. 다른 소유자가 남으면 owner set만 갱신한다. 마지막 소유자는 종료 receipt 또는 권한이 검증된 다른 열린 projection의 인수 receipt 전에 제거하지 않는다. 동시 해제로 마지막 소유자가 되는 경우 영향이 달라졌음을 표시하고 기존 비종료 선택으로 실행을 끝내지 않는다. 소유 해제는 접근 권한·Run 귀속·실행 권한의 이전이 아니다. 요청 중단으로 이미 종료한 실행을 되살리지 않는다.

**미실행 인수 조건:** A/B 공동 유지, 마지막 소유자, 동시 해제, 원격 ACK 유실, 권한 철회에서 소유 없는 활성 runtime·숨은 실행·자동 재시작 0건을 검사한다.

<a id="impl-view"></a>
#### 좌표, 배치와 입력 소유

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-view)

Camera transform, View logical rectangle, Browser viewport, page zoom, OS 창 모드를 독립 상태로 저장한다. 좌표 변환은 실제 표시 중인 matrix의 역변환을 사용하며 애니메이션의 목표 matrix를 대신 쓰지 않는다. 최초 Browser 집중도 이미 존재하는 live Browser View에 대한 camera fit이며 집중 배율은 `min(가용폭/View폭, 가용높이/View높이)`다. 일반 Canvas 줌아웃은 같은 camera transform을 연속적으로 축소해 주변 View를 드러낸다. 최초에는 기본 Canvas 시점을 사용하고, 저장된 일반 시점은 있을 때만 복귀 기준으로 쓴다. 집중·줌아웃 왕복에서 View logical rectangle·Browser logical viewport·URL·세션·page zoom·renderer identity를 유지하고, 실제 Browser resize만 별도 경로로 처리한다. 집중 보기에서 logical rectangle이나 Browser width/height를 쓰지 않는다.

미니맵·화면 목록은 같은 권한 필터를 거친 View registry를 사용한다. 제목·유형·PC·계정 구분자와 겹친 대상 목록은 해당 수신자가 볼 수 있는 항목만 투영한다. 지도 선택은 View ID와 현재 geometry를 다시 해소한 뒤 camera를 이동하고 복귀 시점을 기록한다. resource ID만으로 다른 세션을 선택하거나 runtime을 재개하지 않는다. 대상이 사라졌으면 지도·목록을 유지하고 현재 상태 확인을 제공한다. 작은 hit 영역의 대안은 같은 대상 목록이며 비공개 항목의 개수·이름을 노출하지 않는다.

드래그는 기존 shell handle에서 Pointer Capture로 시작하고 종료/취소 때 해제한다. 상단 바를 창 위쪽 가장자리에 붙여도 기존 창 이동·입력 소유 경계를 유지하며, 빈 Canvas 드래그를 창 이동이나 새 pan 모드로 바꾸지 않는다. 콘텐츠가 소유한 드래그·편집 입력을 Canvas 이동으로 바꾸지 않는다. 다만 Canvas 탐색 상태의 비활성 Chat 위 두 손가락 스크롤은 아래의 콘텐츠 활성 경계에 따라 Canvas가 처리한다. 실제 resize 전 해당 surface의 새 입력을 차단하고, 크기 변경 후 ResizeObserver·Browser 관찰에서 viewport와 document generation을 갱신한 뒤 stale action을 재검증한다. pan만으로 logical target을 바꾸지 않는다. [Pointer Capture](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture), [ResizeObserver](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver).

##### Chat 콘텐츠 활성과 두 손가락 탐색의 입력 경계

사람의 콘텐츠 활성 상태, pointer hit-test 위치, 배치 선택, 키보드 focus, Agent의 입력 lease를 구별한다. Chat 본문·작성기 클릭은 해당 Chat을 콘텐츠 활성 대상으로 만들고 같은 상태로 시각 표시를 갱신한다. 작성기 클릭은 기존 입력칸 동작과 함께 처리하며 별도 활성화 버튼이나 두 번째 클릭을 요구하지 않는다.

활성 Chat 위의 두 손가락 스크롤은 Chat 내부에 전달하고 camera에 같은 입력을 중복 적용하지 않는다. Chat 내부의 scroll 끝에서도 Canvas로 이어서 전달하지 않는다. 빈 Canvas 클릭은 Chat 콘텐츠 활성을 해제하지만 click 자체로 camera·View geometry·대화·초안을 변경하지 않는다. 이후 비활성 Chat 위 hover는 콘텐츠 활성이나 입력권을 만들지 않는다. 이 상태의 modifier 없는 두 손가락 스크롤은 Canvas camera만 이동하고 Chat의 내부 scroll은 유지한다. 별도 Pan 도구 상태를 이 경로의 선행조건으로 검사하지 않는다.

이 전환은 사람의 로컬 UI 입력 분배다. Agent의 작업 target·입력 lease, 다른 참가자의 상태, Browser viewport, Board 소속이나 runtime 생애를 덮어쓰지 않는다. native 입력·보안 확인·콘텐츠별 modifier·zoom·기존 키보드 대안은 별도의 입력 계약을 유지한다. 이벤트 수신·전달의 구현 방식은 이 상태 보장을 만족하는 Firefox shell/renderer 경계에서 선택한다.

콘텐츠 활성의 변경은 남아 있는 wheel 묶음의 이전 소유자를 무효화한다. 해제 직후 같은 포인터에서 들어온 다음 입력을 시간 간격만으로 이전 Chat에 보내지 않는다. 시각 표시와 입력 라우팅은 같은 상태 revision을 사용한다. 반복 입력에서 초안·Chat scroll·다른 surface lease는 독립 상태로 유지한다.

**미실행 인수 조건:** Chat 클릭 → 활성 표시와 작성기 커서 → Chat 위 내부 scroll → 빈 Canvas 클릭 → 활성 해제 → 포인터를 같은 Chat 위로 이동 → Canvas pan → Chat 재클릭의 각 상태를 확인한다. Canvas 탐색 단계의 Pan 버튼·보조키 요구 0, hover 재활성화 0, 한 입력의 Chat/Canvas 중복 적용 0, scroll 끝의 뜻하지 않은 camera 이동 0을 검사한다. 대화·초안·View geometry·Browser viewport·Agent target/lease가 보존되는지 대조한다. 시각 활성 표시와 실제 입력 대상의 불일치도 실패다. 이 조건은 새 규칙의 검증 계획이며 P0 재리허설이나 실제 Firefox 시험을 통과했다는 기록이 아니다.

focus token은 surface·View·control role·목록 위치를 가리킨다. 닫힌 DOM element 자체를 복원하지 않는다. IME 조합 여부와 composition lifecycle을 함께 추적하고 조합 확정 키를 저장·검색 결과 실행에 재사용하지 않는다. 콘텐츠의 Escape·찾기·편집기 undo는 콘텐츠 소유다. [IME 상태](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/isComposing), [W3C focus 복귀](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

그룹은 부모 관계의 비순환 배치 그래프이며 권한·실행 경계가 아니다. ungroup은 world position을 보존한다. undo는 해당 변경의 대상 version이 유지될 때만 역연산하고 다른 사용자의 후속 배치를 덮지 않는다. 드래그 외에도 이동/크기 숫자 입력을 동일 command로 처리한다. [W3C 드래그 없는 포인터 경로](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html).

기존 Firefox shell의 DOM/CSS 경로를 확장한다. InfiniteCanvas의 camera 개념과 xyflow의 node·minimap 패턴은 참고만 하며 dependency/code port로 채택하지 않는다. 라이선스·현재 renderer 적합성을 확인하지 않은 코드 이식은 포함하지 않는다.

**인수 절차:** 동일 Browser를 pan·zoom·집중 보기 왕복한 전후의 내부 viewport, page zoom, target ID를 대조한다. 실제 960→1280px resize에서는 responsive 변화와 observation revision 증가를 확인하고 이전 좌표 행동을 차단한다. 한글 입력 중 다른 surface 탐색, native modal 취소, 사이트 전체 화면, 대상 닫힘, 모션 감소, 키보드·숫자 입력·그룹 중첩/해제를 검사한다. 변환된 live renderer가 이를 만족하지 못하면 집중 진입을 되돌리고 원 크기 View·명시적 resize 경로를 유지한다. Snapshot을 Live처럼 대신 보여 주지 않는다.

Canvas geometry와 renderer attachment는 `viewId`에 결합하고 Board 소속은 별도 membership 관계로 유지한다. 동일 View가 여러 Board에 속해도 물리적 위치·크기·renderer attachment는 한 벌이다. Board를 추가로 열 때 기존 View의 geometry를 저장된 좌표로 덮거나 renderer를 새 영역으로 재부모화하지 않는다. 새 View 생성에만 해당 projection의 저장 위치를 적용한다. 서로 다른 `viewId`가 같은 `resourceId`를 참조하는 경우에는 별도 geometry를 유지하며, resource 일치만으로 View나 runtime을 병합하지 않는다.

보조 드래그 pan은 셸 Canvas의 빈 영역 또는 명시적 Pan 도구에서 시작한 ⌘/Ctrl 드래그로 처리한다. 해당 드래그 시작 조건이 충족된 뒤 Pointer Capture를 획득하고 종료·취소 때 해제한다. 이 보조 경로의 조건을 앞서 정의한 비활성 Chat 위 두 손가락 pan에 추가하지 않는다. Space 기본 pan 경로를 추가하지 않는다. 콘텐츠가 소유한 드래그·텍스트 선택·편집·modifier 입력은 해당 콘텐츠 소유로 남긴다. **인수 절차:** 같은 View를 포함하는 다른 Board를 연 전후의 위치·크기·attachment identity를 비교하고, 같은 Resource의 별도 View 두 개는 각각 유지되는지 확인한다. 사이트 안의 ⌘/Ctrl 드래그·텍스트 선택·편집 입력이 Canvas pan으로 전환되지 않아야 한다.

##### View별 최소 rect 검사

허용 rect는 공통 최솟값만으로 결정하지 않고 View 유형별 최소값을 적용한다. Chat의 최소는 **320×420**이다. `[크기]` 숫자 입력·핸들 드래그·저장 구성 복원은 모두 같은 validator를 사용하며 320×240 Chat을 허용하지 않는다.

사용자 숫자 입력 오류는 값과 초안을 유지하고 `Chat 최소 높이 420px`를 표시한다. 작은 과거 저장 rect를 복원할 때는 최소 rect로 표시하되 원 기록을 조용히 덮지 않는다. 검토 배치의 임시 rect와 NORMAL 저장 rect를 구분한다. 다른 Browser의 viewport나 실행 대상은 변경하지 않는다.

##### 공유 배치의 복원·폐기는 현재 version을 존중한다

geometry와 그룹 관계에 단조 증가 version 및 변경 operation/actor를 기록한다. 구성 폐기의 geometry 역변경은 해당 초안의 마지막 배치 operation version이 현재값과 일치할 때만 적용한다. 불일치는 현재 배치를 유지하고 처리 결과에 기록한다. 기존 View는 저장된 다른 부모 그룹으로 재귀속하지 않는다. 저장 그룹은 신규 View에만 구성하며, 기존 View는 탐색 참조로 남긴다. 과거 저장 revision은 수정하지 않는다.

**미실행 인수 조건:** A 수정→B의 후속 이동/그룹화→A 폐기·재열기에서 B의 후속 배치, 단일 부모 관계, renderer attachment가 유지되는지 검사한다.

##### resize의 무변경·거부·응답 유실

`resizeId, viewId, expectedGeometryVersion, requestedSize, observationGeneration, leaseEpoch`를 사용한다. 유효성 검사와 동일 크기 판정은 입력 차단 전에 수행한다. 실제 변경 때만 surface-local fence를 설치하며 기존 lease를 연장하지 않는다.

거부 시 이전 크기를 확인한 뒤 fence를 해제한다. ACK 유실은 재발송 전에 실제 크기·문서 generation을 조회한다. 요청 크기이면 적용 receipt, 이전 크기이면 무변경 종료, 제3의 크기이면 현재값 보존·충돌로 처리한다. 조회도 실패하면 조작 불가 상태를 유지한다. 성공·실패 후 입력은 현재 권한·소유자·lease 유효성을 다시 확인한 경우에만 허용한다. 만료·철회된 lease를 복원하거나 차단 중 키 입력을 뒤늦게 재생하지 않는다.

**미실행 인수 조건:** 동일 크기, 거부, ACK 유실, 제3자 resize, 권한 철회와 사용자 입력 개입에서 영구 대기·오래된 입력 재생·lease 부활이 없는지 검사한다.

##### 유형별 최소 크기

드래그·숫자 입력·복원은 같은 유형별 validator를 사용한다. 과거 기록이 현재 최소값보다 작으면 지원 최소값으로 재구성하고 보정 사실을 표시하되 과거 revision은 바꾸지 않는다. 카메라 확대·축소는 실제 resize 검증과 분리한다.

**미실행 인수 조건:** Chat 320×419 거부·320×420 허용, 경계값 복원, 숫자/드래그 결과 일치와 작성기 보존을 검사한다.

##### 제거 대상과 활성 Board를 고정한다

제외 입력은 `projectionId, viewId, expectedMembershipVersion, operationId`다. 해당 membership만 변경하고 Saved Board 갱신은 명시적 저장 때 수행한다. geometry·runtime ownership·다른 membership은 유지한다. 마지막 소속을 제거해도 살아 있는 runtime의 View/node는 Board 밖 Canvas에 남고 `실행 유지: A`처럼 실제 소유자를 표시한다.

**미실행 인수 조건:** A/B 공유 View에서 B 제외 도중 카메라·활성 선택을 바꾸어도 A 제외·runtime 종료·View 복제가 발생하지 않아야 한다.

##### 상대 좌표·배치 충돌·정리 범위

신규 world rectangle은 `projectionOrigin + savedLocalRect`로 계산한다. 제목·여백·신규 객체를 포함한 전체 bounding box를 사용한다. 시작점은 보이는 Canvas 왼쪽 위 16px 지점을 world 좌표로 변환한 위치다. 24px 격자의 Manhattan 거리 순, 동률은 위→왼쪽 순으로 후보를 검사한다. 기존 View·그룹·다른 projection의 점유 사각형을 24px 확장하여 충돌을 검사한다.

한 UI 처리 단위에서 64후보, 총 4096후보 후에도 실패하면 전체 점유영역 오른쪽 끝+24px 위치를 검사한다. 유효한 배치를 얻지 못하면 무변경 실패다. commit은 Canvas layout version을 비교한다. 정리는 선택 순서의 최상위 객체에 같은 알고리즘을 적용하며 미선택 객체와 이미 배치한 선택 객체를 장애물로 사용한다. 세 번의 version 경합 후 사용자 재시도로 전환한다.

**미실행 인수 조건:** 30 Board·200 View·공유 View·음수 좌표에서 결정적 배치, 신규 겹침 회피, 미선택 geometry 불변을 검사한다.

##### Canvas 배치 실행 취소

명령은 변경 전 값·write-set·적용 후 geometry/group version을 보존한다. 모든 대상의 현재 version이 일치할 때만 역변경을 원자적으로 적용하고 새 version/event를 만든다. 하나라도 불일치하면 전체 undo를 거부한다. 닫힌 View·runtime을 재생성하거나 파일 저장·카메라 이동을 되돌리지 않는다.

**미실행 인수 조건:** 그룹/해제/정리 후 타인 변경·대상 닫힘에서 부분 덮어쓰기와 runtime 부활 0건을 검사한다.

##### Pan 위치·zoom 경계·스냅 해제

확대 기준점의 world 좌표를 `M⁻¹(p)`로 고정한 채 새 camera translation을 계산한다. 음수 좌표 pan을 허용하고 비유한 값은 이전 카메라를 유지하며 거부한다. 전체 보기는 같은 zoom 범위에서 맞추며 전부 담을 수 없으면 그 사실과 미니맵·화면 목록을 제공한다. 탐색은 활성 Board·실행 대상·Browser viewport를 바꾸지 않는다.

**미실행 인수 조건:** 배율 끝값·서로 다른 pivot·스냅 해제·모션 감소·사이트 modifier 입력에서 좌표 오귀속과 Space pan이 없는지 검사한다. 같은 포인터 위치에서도 Chat 콘텐츠 활성/해제 상태에 따라 내부 scroll과 Canvas pan이 구별되고, 어느 경로도 Browser viewport·Agent 실행 대상을 바꾸지 않는지 앞의 입력 전환 인수 조건과 함께 검사한다.

<a id="impl-discovery"></a>
#### 범위 검색, 열기 resolver와 큐레이션

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-discovery)

검색 입력은 `query, scope, filters, requestGeneration, accessContext`다. 결과는 stable ID·유형·source revision·접근 상태·명시적 action을 가진다. 동일 resolver가 Dock·파일 선택·드롭·Chat 링크·검색·Library를 처리한다. action은 focus-existing, open-view, open-agenda, add-reference로 구분한다.

로컬 FTS5를 사용하되 제목·허용된 기존 검색 텍스트만 index한다. NFC 정규화된 3자 이상 부분 검색에는 trigram을, 1–2자에는 범위가 제한된 parameterized 제목 검색을 사용한다. 한국어 형태소 분석을 제공한다고 주장하지 않는다. 입력은 SQL/명령으로 평가하지 않는다. [SQLite FTS5](https://www.sqlite.org/fts5.html).

권한 필터는 snippet·개수 생성 전에 적용하고 열기 직전에 다시 확인한다. 과거 계정으로 수집한 snippet을 현재 권한이 없는 사용자에게 표시하지 않는다. 늦은 검색 응답은 requestGeneration이 다르면 폐기한다. 검색 취소·재입력은 View·자료를 변경하지 않는다.

index 실패 시 canonical metadata의 제목 검색으로 fallback한다. `[색인 다시 만들기]`는 파생 index만 재구성하며 자료·대화·Snapshot을 삭제하지 않는다. 명령 팔레트는 권한·focus 범위를 가진 명시적 command 목록이며 사이트 입력에서 전역 단축키를 강제 포획하지 않는다.

Library 정책은 허용된 등록 대상 유형 집합으로 집행한다. 집합이 비어 있으면 Library UI·등록 쓰기가 없으며 일반 resource index와 Saved Board 검색은 계속 제공한다. 등록은 참조 생성이지 원문 캡처·실행 소유 추가가 아니다.

**인수 절차:** 한글 1·2·3자, 조합 중 Enter, 긴 동명이름 30개, Canvas View 200개, 권한 철회, offline 대상, 검색 응답 역전을 검사한다. 정확한 범위·action·focus 복귀가 유지되고 권한 밖 제목/snippet 노출과 원치 않은 모델·웹 요청은 0건이어야 한다. Library의 전체 유형/자료만/없음 분기에서 등록 메뉴·저장 결과를 대조한다. index 실패에도 제목 검색과 원 작업 복귀가 가능해야 한다.

##### 검색 실행과 취소의 복귀를 나눈다

탐색 종료에 `closeReason=cancel|executed`, `navigationId`, `originReturnToken`, `destinationId`를 기록한다. `executed`는 목적지 또는 그 loading node 생성과 포커스 인계가 확정된 뒤 한 번만 적용하며 cancel 복귀 handler를 실행하지 않는다. 늦은 callback은 요청 generation으로 폐기한다. 결과 렌더 실패는 확보된 목적지 node의 실패 상태이지 자동 원 위치 복귀가 아니다.

**미실행 인수 조건:** 클릭·Enter·Esc·대상 삭제·늦은 응답에서 목적지 이동의 즉시 취소, 이중 복귀, 취소에 의한 신규 View 생성이 없는지 검사한다.

### 17.B 대화·읽기·답변

<a id="impl-chat-request"></a>

#### 요청 접수·입력·재진입 계약

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-entry)

공통 입력은 native textarea와 버튼을 사용하고 UI 구성 프레임워크는 제한하지 않는다. `compositionstart/end`, `KeyboardEvent.isComposing`, 해당 물리 키의 keyup까지 유지하는 전송 억제 표식으로 조합 확정과 전송을 분리한다. 전송 handlers는 현재 입력 소유자가 Chat일 때만 실행한다. 대화상자의 초기 focus·Esc·호출자 복귀는 APG 패턴을 적용한다. [IME 근거](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/isComposing), [focus 근거](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

입력 계약은 `draftId/revision, requestId, conversationId, targetRunId?, actor, text, attachmentRefs, contextRevision, returnToken`이다. SQLite transaction으로 요청 event와 outbox를 함께 기록한 뒤 Engine adapter에 전달한다. `(requestId, revision)`은 고유하며 응답은 이 키에 귀속한다. 초안 저장 확인 전 성공 표시를 내지 않는다.

작성기의 2–6줄 높이는 표시 상태이며 draft revision·수신자·대상 업무를 바꾸지 않는다. 늘어난 높이는 같은 View의 본문 예산에서 차감하고 고정 행동과 검토 내용의 최소 표시 영역을 남긴다. 첨부 이름 확인은 read-only projection이고 포함 범위 편집만 context revision을 바꾼다. 다른 View·업무를 관찰하는 행위는 초안의 targetRunId를 재지정하지 않는다. 명시적 대상 변경 시에만 새 binding을 만들며 원 초안과 returnToken을 보존한다. returnToken은 유효한 원 Chat·메시지 위치·Canvas 시점으로 해소하고 File caret이나 만료된 입력 lease를 복원하지 않는다.

공유 대화의 일반 메시지와 Agent 위임 요청은 서로 다른 request kind다. 담당자 선택·요청 작성은 draft만 변경하고 최종 위임 접수 뒤에만 Run/Task를 예약한다. 같은 입력칸이라도 모드·수신자·대상 revision을 전송 시점에 검사하며 일반 메시지 저장을 Agent 실행으로 해석하지 않는다.

Agent 요청 초안의 수신자는 선택 전 null일 수 있으며 문안 편집을 막지 않는다. 최종 위임 시에만 수신자·자료·권한·유효 설정을 필수 검증한다. 선택 전 타이핑이나 후보 목록 열기로 실제 수신자를 추정·dispatch하지 않는다.

Codex 연결은 구독 인증된 App Server adapter를 재사용한다. JSON-RPC stdio, `initialize → initialized`, `turn/start`, 활성 turn의 `turn/steer(expectedTurnId)`, `turn/interrupt`를 사용한다. 인증은 managed ChatGPT login 후 `account/read`로 확인한다. 일반 유료 API SDK로 대체하지 않는다. [App Server 공식 계약](https://developers.openai.com/codex/app-server).

Engine adapter는 product Run과 engine thread/turn/item ID를 따로 연결한다. `turn/steer` 응답은 수락 증거이지 per-inference 적용 증거가 아니다. `inputIds/contextRevision/payloadHash/inferenceRef`를 결합한 소비·전달 receipt가 있을 때만 반영 확인으로 승격한다. 관찰 기능이 없는 adapter는 `수락됨·반영 시점 확인 불가`를 반환한다. 일반 조정을 위해 interrupt/fork하지 않는다. turn 종료 경합은 상태 조회 후 같은 product Run의 다음 허용 turn에 연결한다.

응답 유실은 재전송 전에 `thread/read`와 저장된 item/turn binding을 대조한다. 수락을 식별하지 못하면 unknown을 유지한다. 취소 intent는 늦은 수락에도 적용하되 중복 실행을 만들지 않는다.

인수 절차: 한글 조합 확정, 전송키 연타, 수락 지연, 수락 직후 연결 단절, 다음 초안 입력, 재시작을 순서대로 주입한다. 요청당 dispatch 1건, 조합 확정 전송 0건, 다음 초안 손실 0건이어야 한다. 식별 불가능한 수락은 보존된 요청과 상태 확인 UI로 fallback한다.

##### 검토 배치·확정 범위 결합

`enterReviewLayout/exitReviewLayout`은 viewId를 유지하고 이전 rect·view state·returnToken을 저장한다. 승인 확정은 선택 집합·payload·수신자·권한·비용의 `reviewedScopeHash`를 현재 값과 비교한다. 달라졌으면 바뀐 범위만 다시 표시하고 기존 확정을 적용하지 않는다. 이 hash는 검토 화면의 범위 결합이지 사람이 모든 문장을 이해했다는 증거가 아니다.

브리핑 요청은 Answer ID/revision·보고 item 집합·허용 sourceRefs·실행 설정을 고정한 별도 요청이다. 동일한 진행 중 요청은 중복 dispatch하지 않는다. Agent가 만든 단계·대상·Focus Scope·설명은 참조 유효성·권한·형식을 검사한 뒤 게시한다. System이 단계 설명을 생성하거나 공개 범위를 넓히지 않는다. 생성 요청·준비 상태·게시 receipt·보기는 별도 상태이며, 보기·단계 이동은 요청 outbox를 생성하지 않는다. 기존 Answer나 과거 증거는 브리핑 준비·실패로 수정되지 않는다.

미실행 인수조건: 두 NORMAL 크기, 두 검토 배치, 긴 승인 값에서 합계 치수·동시 가시성·초안 보존·복귀 일치·scope 변경 후 옛 승인 사용 0을 검사한다.

<a id="impl-context-share"></a>

#### Context·권한·공유 relation 계약

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-share)

resolver 입력은 명시 선택, 업무 binding, 허용된 Board·layout signal, 현재 정책과 source descriptor다. 출력 item은 `sourceRef, revision/hash, range, payloadRole, include/exclude, reason, authorityRef, recipientScope`를 갖는다. relevance 판단과 권한 판단은 다른 필드다.

위임 가능한 행동은 Profile ceiling ∩ 현재 capability ∩ Task 위임 ∩ resource authority ∩ 승인 ∩ 실행 상한의 교집합이다. child에게 이 집합보다 큰 grant를 발급하지 않는다. 공유 대화 참여·Agent mention은 Engine 사용권·업무 계정·OS 권한을 부여하지 않는다.

공유 relation은 `conversationId, participants, scopeRef, agendaRefs, messageRefs, contributionRefs`로 저장한다. 개인 방 history와 engine thread를 그대로 공유하지 않는다. 공유 operation은 `operationId, baseRevision, selectedRefs, recipients, grantRevision`을 포함한다. 수신자별 권한 검사 후 허용된 본문/참조만 materialize한다. 전송 전 grant가 바뀌면 재검사하며 실패 초안은 보존한다.

독립 검토는 명시적인 별도 Task와 새 engine context로 구성할 수 있다. 허용 입력 manifest를 고정하고 제외 자료는 대화·memory·요약·tool 검색 경로 모두에서 차단한다. engine history가 상속되는 환경에서는 독립성을 확인했다고 표시하지 않는다. 원문 읽기만 요청한 Reader에 업무 판단 권한을 넘기지 않는다.

셸 controller는 `open/focus`, `captureReturn/restoreReturn`, `focusGroup` 의미 계약을 제공한다. returnToken에는 View·message/step·scroll·Canvas 시점·draft ID를 담고 runtime 재시작 권한은 담지 않는다. Engine adapter는 binding·capability·수락/적용/중지 receipt를, 자료 서비스는 source identity·range·허용 payload·보존 상태를 제공한다.

인수 절차: 두 업무·두 참가자 중 한 사람만 원천 접근권을 가진 fixture에서 포함 변경, 공유, 권한 철회, 독립 검토를 수행한다. 다른 업무 변경·비공개 본문 유출·제외 정답 유입은 각각 0건이어야 한다. 경합은 공유 보류와 원 초안 복귀로 처리하며 독립 업무는 계속한다.

##### 독립 입력 manifest의 집행

제안된 EG-Desk 내부 계약은 `prepareIsolatedTask(manifest, isolationPolicy)`와 `startIsolatedTask(preparedToken)`이다. 공개 Engine API 자체의 기능명으로 주장하지 않는다.

| 필수 capability | 집행 방법 |
|---|---|
| 새 실행 context | 기존 engine history의 resume/fork 없이 새 context 생성; 부모 대화·요약 자동 상속 금지 |
| 기억·환경 입력 제한 | 자동 memory 주입 차단; 허용된 지침·원천만 제공하는 격리 입력 root 사용 |
| 도구 접근 제한 | source manifest의 positive allowlist로 읽기 gateway 집행; 통제되지 않는 native tool·shell·network 경로 비활성 |
| 전달 증거 | 실제 입력 경계의 manifest/hash·context ID·Engine/도구 구성 version과 receipt 결합 |

네 capability와 해당 구성의 conformance 근거가 모두 유효해야 준비 token을 발급한다. 시작 직전에 manifest·권한 epoch·도구 구성을 다시 대조한다. 하나라도 미지원·미확인이면 **독립 Task dispatch는 0건**이다. 실행 중 보장이 깨지면 해당 Task의 다음 입력·도구 행동을 차단한다. 입력 root는 읽기 전용이며 결과 작성은 지정된 임시 산출물 범위만 허용한다.

독립 Task는 기존 product Run에 연결할 수 있으며 일반 조정에 새 Run·fork를 강제하지 않는다. 보장 범위는 이번 실행의 입력·도구 경계이지 모델 학습 지식의 부재가 아니다.

미실행 인수조건: 제외 정답을 history·memory·요약·도구 경로에 각각 배치하여 유입 0을 검사한다. 미지원 adapter에서는 시작 0, 초안 보존이어야 한다. 기간 예외 근거를 제거한 RWS-0006형 fixture는 숫자가 일치해도 `확인 필요`이며 일반규칙 대체·전체 재현 성공을 허용하지 않는다. coverage 계산은 System, 업무 판정은 담당 Agent가 맡는다.

##### 경로 설정과 상속

경로 record는 `scopeType/scopeId, agentRef/profileRef, revision, author, delegationRef`다. CRUD는 expected revision과 operationId로 기록한다. 우선순위는 명시 요청→업무 binding→방→routing Board→앱이다. 미설정은 상속하지만 설정된 Agent의 이용 불가는 조용히 건너뛰지 않는다. 사전 위임 목록 안의 대체만 허용하고, 그 밖에는 `[허용된 다른 담당 선택] [설정 유지·대기]`를 제공한다. Engine 계정 기본값은 별도 record다.

각 범위의 저장·해제·재시작·충돌, Agent 이용 불가에서 적용 출처 일치·기존 업무 오변경 0·방 identity 변경 0을 검사한다.

##### 지속 공개 cursor와 grant

지속 binding은 `bindingId, conversationId, ownerScopeRef, mode, workRef, initialRefs, startCursor, endCursor, status, participantEpoch`를 가진다. workRef는 request/Task와 포함할 하위 범위를 명시한다. 수신자별 `grantId/epoch, joinCursor, scanCursor, deliveryStates/ackCursor`를 기록한다.

coordinator의 durable 사건 순서를 사용한다. 각 사건은 업무 범위·수신자의 현 grant·payload lineage·가림 조건을 검사한 뒤 materialize한다. 중복 키는 `bindingId+eventId+recipientId+payloadRevision`이다. 제외 사건도 내부 처리 결과를 기록하되 비공개 이름·존재·개수를 수신자에게 노출하지 않는다.

종료/철회는 binding epoch를 올리고 미전달 항목을 취소한다. 재접속은 cursor와 현 epoch를 대조하며 옛 queue·grant를 부활시키지 않는다. 실패·미확인은 `[공유 상태 확인]`, 유효 binding의 정확한 미전달 집합만 `[다시 시도]`한다. 일반 메시지 저장·공유 delivery event에는 Engine outbox를 만들지 않는다.

미실행 인수조건: 초기 참조, 이후 사건, 권한 변경, 새 참가자, 종료 중 전송, 재접속을 교차하여 범위 밖 공개·중복 전달·과거 자동 backfill·철회 부활·공유만으로 Engine 호출이 각각 0이어야 한다. 실제 원격 연결이 승인·설정되지 않았으면 원격 delivery만 대기하며 로컬 대화와 독립 업무는 유지한다.

<a id="impl-reader-observation"></a>

#### Reader admission·coverage·Snapshot 계약

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-reader-observation)

텍스트 admission 비용은 대상 모델·입력 경로에 대해 검증된 tokenizer를 우선 사용할 수 있다. tokenizer를 사용할 수 없는 경로는 **검증된 UTF-8 기반 보수적 상한을 텍스트에 한해** 사용할 수 있다. 이 상한은 실제 전달 텍스트의 인코딩 길이와 해당 경로에서 검증한 직렬화·특수 토큰·고정 overhead를 포함하며 적용 조건과 estimator version을 기록한다. 임의 파일 byte 수를 곧바로 token 수로 간주하지 않는다. 어느 방법이든 필수 대화·답변 reserve·tool overhead·동시 예약량·첨부 간 참조와 함께 평가한다. 이미지·PDF 페이지·기타 비텍스트 비용에는 텍스트 상한을 적용하지 않고 해당 modality의 검증된 비용 모델을 사용한다. 상한의 적용 조건이나 비용을 확인할 수 없으면 parent transcript에 넣기 전에 bounded read 또는 Reader로 전환하고 그 변환·coverage를 기록한다.

전체 읽기는 `sourceHash + shapeIndex + complete partition manifest`를 기준으로 비중첩 core range와 별도 overlap range를 배정한다. 성공 coverage는 core의 합집합으로 계산한다. 슬롯 부족은 queued wave로 처리한다. 재질문은 같은 sourceHash에서 새 intent·packet revision을 만들며 이전 요약만 재요약하지 않는다. 키워드 기반 targeted 읽기는 검색 hit 전체 manifest를 별도로 고정한다.

Reader 결과는 선택 span·coverage·누락 이유·변환·오류를 반환한다. business verdict는 parent가 작성한다. 복구는 같은 parser 1회 재시도 → 허용된 대체 parser/encoding → 허용된 OCR 순으로 상한 안에서 수행한다. 손상·암호·권한·미지원과 context overflow를 구분한다.

파서 선택은 파일 서비스가 제공하는 adapter descriptor에 결합한다. MinerU의 `discarded_blocks`·backend/version, GROBID의 페이지·구조 좌표는 추출 결과를 원문에 연결하는 연구 대안이다. 자동 제거된 각주 등을 전체 판독으로 숨기지 않는다. 좌표의 페이지 시작값·단위·CropBox를 정규화한다. [MinerU 출력 계약](https://opendatalab.github.io/MinerU/reference/output_files/), [GROBID 좌표 계약](https://grobid.readthedocs.io/en/latest/Coordinates-in-PDF/).

observation manifest는 named operation, raw/delivered/preview role별 hash·length, source revision, tool/Reader identity, coverage와 transformation을 보존한다. EG-Desk 통제 tool gateway는 반환 직전 명명 결과 전체와 전달 payload를 기록한다. 직접 결과의 무표시 잘림은 오류다. opaque provider 결과는 관찰 가능한 경계만 기록한다.

Snapshot renderer는 script·network·현재 로그인 행동을 실행하지 않는다. Live는 별도 view identity다. 삭제·가림은 원 hash 덮어쓰기가 아니라 tombstone·파생 object·정책 event다. 저장소의 실제 정리 결과를 받기 전 `삭제됨`을 표시하지 않는다.

Task 상태는 scheduler의 정본 event로 투영한다. 중지 확인 뒤 cancelled, 실행 실패 확인 뒤 failed로 전이한다. 실제 failed Task의 재시도는 실패 attempt를 보존하고 새 attempt를 생성한다. completed/cancelled Task와 그 terminal attempt는 수정하지 않는다. 명시적 continue는 `continuesTaskId`로 원 Task를 가리키는 후속 Task와 실행 binding을 생성하며 기존 request·conversation·source·result 관계를 유지한다. Engine의 새 turn이나 필요한 후속 실행 binding은 새 사용자 요청·새 담당자 방과 동일하지 않다. continue 시 현재 권한·의존성·외부 효과 receipt를 다시 검사하고, 확인되지 않은 외부 행동은 자동 반복하지 않는다. 늦은 packet이나 재접속 event만으로 continue를 생성해서는 안 된다.

인수 절차: 41행 direct 결과, 분할 원문 중 1개 누락, OCR 실패, 원문 교체, 권한 철회, 중지 뒤 packet 도착을 주입한다. 정확한 payload hash, 미판독 표시, 새 원문 coverage 초기화, 취소 후 후속 실행 0건을 확인한다. 복구 불가는 원문 보기·대체 자료·명시적 범위 축소로 fallback한다.

활동 resolver는 Agent/기본 Codex 모드, 업무·행동·권한과 `activityKind, taskStatus,
liveBinding, observationRef, lastConfirmedAt`을 함께 확인한다. 기본 열기는 기록 패널을
반환하며 과거 관찰은 정확한 observationRef로 해소한다. 명시적인 현재 작업 화면 이동만
검증된 viewId·runtime identity를 반환한다. renderer가 detached이면 같은 View에 다시
부착하되 실행을 재시작하지 않는다. 유지 중인 runtime의 Live 부재는 기존 Canvas 작업 표현에
남기고, 종료된 과거 관찰마다 Canvas node를 새로 만들지 않는다. 패널 열기와 Canvas 이동은
별도 사용자 행동으로 기록한다.

##### 역할별 가림의 원자적 접근 제한

가림 operation은 `operationId, selectedRefs, mandatoryRefs, policyRevision, authorityEpoch, role별 처리상태`를 저장한다. 새 제한 epoch를 적용하여 대상의 기존 일반 열람·재첨부를 먼저 차단하고, 가림본을 불변 저장한 뒤 검증된 표현만 공개한다. 상태는 `가림 적용됨 / 제한 유지·처리 실패 / 결과 미확인`이며 원본 정리 상태는 별도다. `[상태 확인] [미완료 항목 재시도]`는 같은 operation의 미완료 대상만 처리한다. 실패 때문에 무가림 원본을 다시 노출하지 않는다.

미실행 인수조건: 같은 지정 비밀이 raw·packet·preview·Answer·index·replica에 존재하는 fixture에서 중간 저장 실패를 주입한다. 제한 후 무권한 노출 0, 과거 전달 hash 변경 0, 미완료 사본의 삭제 완료 오표시 0이어야 한다.

<a id="impl-answer-revisions"></a>

#### Answer identity·매체·수정본 계약

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-answer-revisions)

`request → runs/tasks → contributions/results/artifacts → answerId/revision → projections` 관계를 사용한다. Answer revision은 여러 Result·artifact를 참조할 수 있고 artifact는 여러 답변에서 재사용할 수 있다. Result의 aggregate completeness와 Task status는 다른 필드다.

Agent는 `reportItems, explanation, selectedEvidence, selectionReason`을 제안한다. System은 target existence·권한·payload lineage·renderer capability를 검증한다. `sourceChanged`는 revision 비교 결과이며 의미 영향 판단과 구분한다. renderer retry는 저장된 Answer revision을 다시 그릴 뿐 모델을 호출하지 않는다.

사용자 수정은 `author, baseAnswerRevision, changedFields, sourceRefs`를 가진 새 revision이다. annotation-only 정책은 이 mutation을 거부하되 댓글·개인 view state는 허용한다. 설명 갱신 요청은 저장된 수정본 hash에 결합하고 자동형도 같은 revision 요청을 중복 생성하지 않는다.

저장은 짧은 SQLite transaction과 `baseRevision` 비교로 처리한다. 충돌하면 최신 값과 사용자 초안을 함께 반환한다. 겹치지 않는 변경만 허용된 정책으로 병합하고 같은 필드 충돌은 덮어쓰지 않는다. SQLite의 단일 동시 writer 제약을 고려해 IO·렌더·모델 호출을 transaction 밖에서 수행한다. [SQLite transaction 계약](https://www.sqlite.org/lang_transaction.html).

인수 절차: Chat/Canvas에서 같은 답변을 열고 사본 저장, 동시 수정, source 변경, 한쪽 renderer 실패를 발생시킨다. answerId 유지, 서로 다른 작성자 revision 보존, 과거 payload 불변, 탐색/렌더 retry의 모델 호출 0건이 합격 조건이다. 실패 시 원답변·사용자 초안·읽기 쉬운 표현을 유지한다.

##### 답변 삭제와 잔존 참조

삭제는 `operationId, answerId, frozenRevisionIds, expectedHead, authorityEpoch, deleteSet, retainedRefs`에 결합한다. 대상의 새 게시·재첨부를 차단하고 참조 제거와 payload 정리를 항목별로 기록한다. 대표 revision을 삭제하면 대표 참조를 비우며 다른 판단을 자동 대표로 채택하지 않는다.

Chat 전달 event는 유지하되 삭제된 Answer payload에 의존하는 표현·cache는 `삭제된 답변`으로 바꾼다. 독립적으로 보존되는 메시지 사본·provider 전달분은 남는 사본으로 명시한다. 공유 artifact는 다른 유효 참조 때문에 유지할 수 있으며 `참조 해제·공유 사본 유지`로 표시한다. 댓글은 허용된 본문과 원 연결 기록을 남기고, Briefing은 영향을 받은 target을 유실 상태로 표시한다. 강제 개인정보 조건은 가림·삭제 연동 규칙을 따른다.

`삭제됨 / 보존됨 / 정리 대기 / 실패 / 미확인`을 구분하고 같은 operation으로 상태 확인·미완료 재시도를 수행한다. 삭제는 Run 중지가 아니다. 늦은 게시 event는 삭제된 Answer를 부활시키지 않고 기여 기록으로 보존한다. 복구가 허용되면 현재 권한으로 새 revision을 만들며 물리 삭제된 byte의 복구를 약속하지 않는다.

미실행 인수조건: revision 단독/전체 삭제, 다른 Answer의 artifact 재사용, 동시 새 revision, 열린 두 표현, 부분 정리 실패에서 범위 밖 삭제·자동 부활 0이어야 한다.

##### 개인 표시의 독립 상태

`personalViewPreferences`는 `actorId/viewId/answerRevision`에 결합하고 Answer mutation과 분리한다. 주석 전용 검사는 본문·report item 집합·설명 순서·사용자 대표 변경 모두에 적용한다. 개인 표시·renderer retry는 모델 호출을 만들지 않는다. 양 정책에서 개인 숨기기 이후 Answer hash·공유 표현 무변경을 검사한다.

##### 게시·대표·선택 참조

`agentHead`, `representativeRef`, `representativeMode=followAgent|pinned`, View별 `selectedRevision`을 분리한다. 초기 대표는 Agent 게시본을 따른다. 실제 새 Agent 답변은 agentHead를 갱신하며 followAgent일 때만 대표도 갱신한다. 사용자 수정본 저장은 이를 변경하지 않는다. 명시 대표 선택은 pinned, `[새 Agent 답변 따르기]`는 followAgent로 전환한다. 주석 전용으로 정책이 바뀌어도 기존 수정본의 작성자·이력은 유지한다.

대표 변경은 expected revision 비교와 한 transaction으로 기록한다. 실패·충돌은 초안과 기존 대표를 유지하고 `[상태 확인] [차이 다시 보기]`를 제공한다. 렌더 재시도는 선택 revision만 다시 그린다. 인수조건은 과거 Chat 무변경, 저장만으로 대표 변경 0, 양 표현의 명시 선택 일치, 타인 초안 유실 0이다.

##### 원 대화 복귀 binding

Canvas Answer projection의 탐색 기록은 `originConversationId, originMessageId, answerId, answerRevision, originViewId, returnPosition, navigationGeneration`을 가진다. 복귀는 현재 ACL을 검사한 동일 참조만 열며 새 대표 revision이나 다른 방을 자동 선택하지 않는다. 출발 참조가 없으면 접근 가능한 명시적 Answer-message 연결만 후보로 조회한다. 권한 상실·누락·오래된 navigationGeneration에서는 원 Canvas를 보존하고 늦은 focus commit을 취소한다.

미실행 인수: Chat 답변→Canvas→복귀에서 동일 방·메시지·revision·초안·스크롤을 확인한다. 연결 0/1/복수, 권한 철회, 메시지 삭제, 조회 중 다른 탐색을 교차하여 비공개 후보 노출·잘못된 답변 복귀·새 모델 호출이 각각 0이어야 한다.

<a id="impl-briefing-comment"></a>

#### Briefing·Step·Comment 계약

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-briefing-comment)

Briefing은 `briefingId, revision, answerRevision, author, orderedGroups/steps`를 갖는다. Step은 안정적인 ID, 고정 targetRefs, selector, 설명, focus scope, fallback을 갖는다. 순서 숫자를 identity로 사용하지 않는다.

read-only 정책은 그룹·단계·전체 순서·설명·target·Focus Scope의 사용자 mutation을 거부한다. edit 정책은 reorder/add/delete/relink를 revision event로 저장한다. Comment는 `commentId, author, bodyRevision, briefingRevision, stepId, targetRef?, visibility`로 별도 보존한다. 현재 구성에서 Step을 빼도 과거 revision의 Comment는 그 단계에 남는다. 실제 참조 revision이나 target이 삭제된 경우에만 orphan으로 표시한다. 동시 시청은 각자 presentation cursor를 유지한다.

`다음 Chat에 포함`은 comment revision과 target manifest를 공통 draft에 원자적으로 연결한다. 첨부 dedupe key는 draftId+commentId이며 선택 revision은 별도 값으로 고정한다. 전송 때 권한·target 상태를 다시 검사한다. target이 없어도 허용된 댓글 본문만 전달하는 분기를 명시적으로 선택할 수 있다.

탐색은 셸 controller의 focusGroup·returnToken을 사용한다. 저장된 presentation state는 engine 실행 상태를 변경하지 않는다. 숨은 reasoning item은 Briefing material allowlist에 들어가지 않는다.

인수 절차: 8단계에서 3단계 댓글 작성 → 순서 변경 → 대상 삭제 → 동시 편집 → 종료·재진입 → 첨부 두 번을 수행한다. 댓글의 원 step ID·revision 유지, 첨부 1개, 원 초안 복귀, 탐색 모델 호출 0건이 합격 조건이다. 실패는 orphan 댓글과 편집 초안을 보존하고 전체 목록·재연결로 fallback한다.

##### 브리핑 수명과 과거 단계

Briefing은 Answer의 소유 범위를 참조하되 생성·편집·공유·삭제 capability를 각각 검사한다. 공유는 고정 revision manifest를 사용하며 원천 권한·Engine 사용권을 추가하지 않는다. 제한된 제목·내용·존재 정보는 수신자별로 가리고, 필수 공개 조건을 충족하지 못하면 해당 공유만 막는다.

단계 제거는 새 Briefing revision의 구성 변경이다. 과거 revision에 남은 단계·댓글은 유효하며 `이전 버전의 단계`로 표시한다. 실제 참조 revision 또는 target이 삭제됐을 때만 orphan이다. Briefing 자체 삭제는 Answer 삭제의 frozen-ID·상태 확인 절차를 재사용하되 기반 Answer·artifact·댓글 본문을 자동 삭제하지 않는다. 열린 표현은 삭제 상태로 전환하고 `[Answer로 돌아가기]`를 제공한다.

##### 단계별 조건부 편집

읽기 전용 정책은 Step뿐 아니라 묶음, 전체 순서, 설명, target, Focus Scope의 사용자 mutation을 모두 거부한다. 댓글 권한과 수명주기 삭제 권한은 별도로 검사한다.

편집 입력은 `operationId, briefingId, baseRevision, changesByStableId`다. 단계 이동은 순번 덮어쓰기가 아니라 `stepId/fromGroup/toGroup/afterStepId`로 기록한다. 서로 다른 단계의 비충돌 변경만 병합한다. 같은 단계 이동, 같은 삽입 위치의 순서 충돌, 삭제/편집 충돌은 `[최신본 유지] [내 초안 보존] [다시 배치·편집]`로 해결한다. 저장 직전에 ID 중복·유실·그룹 순환과 최신 revision을 다시 검사한다.

`[내 버전으로 보존]`은 같은 Briefing의 분기 revision을 저장하며 게시 head를 바꾸지 않는다. 성공한 게시만 head를 변경한다. 응답 유실은 operation 상태 조회 후 재시도한다.

미실행 인수조건: 두 편집자가 같은 8단계에서 이동/삭제/설명 편집을 교차 수행한다. head 갱신은 조건부 단일 성공, 무시된 변경은 초안 보존, 단계 중복·조용한 유실 0, 댓글의 원 step/revision 변경 0이어야 한다.

##### 댓글 mutation과 실패

댓글 mutation은 `operationId, commentId, expectedBodyRevision, targetManifest, authorityEpoch`로 처리한다. 생성 ID는 재시도에도 유지한다. 저장·삭제 응답 유실은 같은 operation을 조회한다. 자기 변경 undo와 삭제 복구는 현재 권한·보존 상태를 검사한 새 event이며 타인의 이후 변경을 없애지 않는다. 물리 삭제·강제 가림으로 복구 불가능하면 이유를 표시한다.

`commentId`의 변경 이력은 닫기·재진입 후에도 자기 mutation을 선택할 수 있게 한다. 역변경에는 `undoOfOperationId`와 현재 expectedBodyRevision을 기록하고 동일 undo operation의 중복 commit을 막는다. **미실행 인수 조건:** v1 저장→v2 수정 저장→닫기·재진입→자기 수정 되돌리기에서 새 revision의 본문을 대조한다. 타인 후속 변경은 보존하고 경합은 비교로 복귀하며 응답 유실·재시도에도 중복 event는 0건이어야 한다.

미실행 인수조건: 저장 중 추가 입력, 응답 유실, 삭제/수정 경합, 대상 유실, 재시작에서 중복 댓글 0·허용된 초안 유실 0·권한 우회 복구 0이어야 한다.

##### 댓글 identity별 첨부

미전송 초안의 첨부 고유 키는 `draftId + commentId`다. 첨부 값은 선택한 `bodyRevision, briefingRevision, stepId, targetManifestHash`를 고정한다. 같은 revision을 다시 포함하면 기존 첨부를 연다. 새 revision이면 `v1이 이미 첨부됨`과 `[기존 유지] [v2로 교체]`를 제공한다. 교체는 해당 초안의 첨부 한 개만 원자적으로 갱신한다.

전송 접수 시 고정한 요청 payload는 이후 댓글 수정·첨부 교체로 바꾸지 않는다. 해당 요청에 추가할 변경은 다음 초안에서 처리한다. 재진입·전송 시 권한과 target 상태를 재검사하며 `[참조 제거]`는 댓글 자체를 삭제하지 않는다.

미실행 인수조건: v1 포함→수정→v2 교체→재시작→동일 operation 재시도에서도 첨부는 1개다. 다른 commentId는 별도 첨부이고 이미 전송한 v1 hash는 유지해야 한다.

##### 오류 단계 탐색

resolver는 `briefingRevision/stepId/authorityEpoch`로 결과와 fallback을 반환한다. 댓글 가능 여부는 별도 검사한다. 위 다섯 오류/변경 상태에서 탐색 모델 호출 0·Live 재실행 0·비공개 노출 0·복귀 대상 보존을 검사한다.

<a id="impl-canvas-annotation"></a>

#### Annotation geometry·작성자·알림 계약

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-canvas-annotation)

visual mark, Canvas Memo, Briefing Comment는 서로 다른 type을 갖는다. 공통 target은 Canvas world 좌표 또는 `sourceHash + source-relative selector`다. zoom·pan은 저장 geometry를 바꾸지 않는다.

도형은 허용된 SVG primitive와 수치 좌표로 표현하며 script·foreignObject·외부 resource는 허용하지 않는다. 텍스트 target은 위치 selector와 허용된 짧은 quote/prefix/suffix를 사용할 수 있다. 민감 원문의 quote 복제가 허용되지 않으면 위치 selector만 사용한다. 새 revision의 다중 일치는 자동 재연결하지 않고 후보를 반환한다. 이는 W3C 모델의 selector 패턴을 차용하는 것이며 전체 표준 구현 선언은 아니다. [Web Annotation selector 근거](https://www.w3.org/TR/annotation-model/#selectors).

Memo body revision과 reply event의 author는 분리한다. Agent reply에는 basedOnMemoRevision과 sourceRefs를 붙인다. 응답 trigger는 명시 질문 또는 유효한 assigned-scope grant다. 알림 dedupe는 `memoId + issueId + recipient`로 하며 답글·렌더·재접속을 새 쟁점으로 간주하지 않는다. 재촉은 만료·취소 가능한 별도 예약으로 처리한다.

명시 질문의 초안에는 Memo ID/revision, 기존 업무가 있다면 그 업무 ID, 실제 수신 Agent ID, 담당 연결 revision을 결합한다. 유효한 담당자가 있으면 그 이름을 표시하고 재선택을 요구하지 않는다. 담당 연결이 없으면 명시적으로 고르며 공간적 근접성·최근 방을 수신자 근거로 쓰지 않는다. 전송 시 담당·권한이 바뀌었으면 초안을 유지한 채 차이를 반환한다. 다른 업무의 초안은 덮지 않는다.

아직 기존 업무가 없는 질문 초안은 `새 업무 요청` 관계로 표시하고 수락 때 새 Task를 연결한다. 기존 업무 선택은 그 Task ID·담당·현재 권한을 검증한다. 초안 단계에서 존재하지 않는 Task ID를 기존 업무처럼 만들거나 최근 Task로 대신 채우지 않는다. 연결 변경 뒤에는 새 수신자·업무에 대한 명시적 재확인과 전송이 필요하며 취소는 원 초안을 보존한다.

인수 절차: 50%/200% zoom에서 표식 이동, 메모 수정 중 늦은 답글, 대상 삭제, 동일 알림 재전달, 재시작을 수행한다. source-relative 위치 유지, 사용자 본문 무변경, 알림 1건, 마지막 위치와 초안 복원이 합격 조건이다. selector를 해소하지 못하면 마지막 위치의 경고 node와 수동 재연결을 사용한다.

표식 mutation은 `author, targetRef, baseRevision, grantRef, applicationMode`를 포함한다. `applicationMode=direct`는 위임된 report 편집 범위 안에서 검증·저장되며 사람의 approval event를 생성하지 않는다. `applicationMode=proposal`은 적용 전 후보를 보존하고 권한 있는 행위자의 수락 또는 기각을 기록한다. 제안 수락으로 기존 위임 밖의 다른 자료·계정·행동까지 허용하지 않는다. 두 모드 모두 작성자와 근거를 보존하며 저장·채택을 사실 검증 상태와 분리한다.

### 17.C Agent·실행·계정

<a id="impl-agent-profile"></a>
#### Profile revision과 Engine adapter — §14 확장

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agent-profile)

아래 record·생성·활성화 규칙은 사용자가 선택한 Agent Profile에 적용한다. 기본 Codex는
유효한 Engine과 기본 실행 설정으로 동작하며 Profile record 생성·활성화를 요구하지 않는다.

Profile record는 안정 ID, owner, visibility, activeRevision을 가진다. revision은 내용 hash·작성자·부모 revision·검사 결과를 가진 불변 record다. 활성화·대체·보관은 pointer와 lifecycle event를 원자적으로 변경한다. `expectedRevision`이 다른 쓰기는 충돌로 반환하며 초안을 보존한다. 참조 중 revision 삭제는 tombstone과 별도 payload 보존 정책을 적용한다. import는 새 비활성 ID로 만들고 credential·실행 권한을 가져오지 않는다.

초안 저장 검사와 활성화 검사는 분리한다. 저장에는 비어 있지 않은 표시 이름·유효한 필드 형식·쓰기 권한·기준 revision이 필요하다. 나머지 지침·계정·모델·도구·제한의 미설정은 명시적 unresolved 값으로 보존한다. 미설정을 무제한·자동 선택·도구 없음으로 바꾸지 않는다. 상속으로 해소되는 값은 그 출처 revision을 표시한다. 활성화는 실제 유효 설정과 정책·가용성을 해소한 경우에만 가능하며 초안 저장으로 Run·시험 호출을 생성하지 않는다. 저장 receipt 유실은 같은 operation ID의 결과 조회를 먼저 사용한다.

Chat의 비활성 초안 재진입은 저장된 Profile ID/revision에 연결한다. 활성 수신자 목록과 설정 중 초안 목록을 구별하되 두 목록의 권한 필터는 동일하게 적용한다. 저장 후 복귀가 초안을 숨기거나 새 ID를 만드는 경로가 되어서는 안 된다. 초안 행의 열람·이어서 설정은 Run을 생성하지 않는다.

설정 존재, adapter discovery, bounded 호출 성공, 결과 전달은 서로 다른 검사 결과다. 자동 routing의 입력은 사용자 override, Profile 후보, 실제 availability, modality·privacy·예산·authority 조건이다. System이 후보를 필터링하고 우선순위 또는 위임된 모델 제안으로 선택하되 실제 결정·이유·대체 전후 값을 기록한다.

adapter manifest는 `engineVersion/schemaHash/capabilities/toolCatalogHash/configHash`를 고정한다. `model/list`의 식별자·modality·지원 옵션을 사용하며 숨은 세부 모델 버전이나 context window를 만들어내지 않는다. 실험적 dynamic tool 기능은 명시적으로 분리한다. 기본 연결은 로컬 stdio JSONL과 initialize handshake이며 App Server WebSocket의 실험적 지원 상태를 운영용 안정성으로 승격하지 않는다. [공식 App Server](https://learn.chatgpt.com/docs/app-server#protocol), [모델 목록](https://learn.chatgpt.com/docs/app-server#models).

인수 절차: 저장 성공/발견 실패/호출 실패/전달 실패를 각각 주입한다. revision과 네 상태가 일치하고 과거 Run 변경이 없어야 한다. 활성화 충돌·공유 철회·참조 중 삭제·내보내기/재가져오기를 검사한다. 미지원 schema에서는 해당 기능만 비활성화하고 기존 revision 검사·초안·수동 설정을 유지한다.

##### Profile lifecycle·pin의 원자 적용

Profile lifecycle은 `draft/active/disabled/archived/deleted`이며 discovery·호출 성공과 별개다. 기본값은 `bindingId,targetId,profileId,revision,status,revisionCounter`로 관리한다. 사용 중단·보관·삭제 transaction은 lifecycle과 관련 기본값의 `unavailable(reason)`을 함께 기록한다. 기본값을 다른 Profile로 치환하지 않는다.

대체는 frozen binding ID 집합과 편집 권한을 검사하여 적용한다. 이동은 ID를 유지하지만 ACL epoch를 변경하고 기존 참조의 접근권을 재평가한다. 활성화·복원은 최신 검사와 `expectedRevision`을 요구한다. 재활성화가 과거 기본값·공유 grant를 부활시키지 않는다. Agent ID·room ID·Memory 소유는 Profile 변경 transaction 밖이다.

모델 선택 순서는 **강제 제한 → 유효 pin → 명시 모델 요청 → 위임된 fallback 순서**다. pin과 요청이 충돌하면 해소 전 dispatch하지 않는다. exact pin은 공개·검증된 revision이 있어야 성립한다. fallback은 필수 output contract hash·modality·전송 범위·비용 제한을 만족해야 한다. 후보가 없으면 availability 대기이며 pin을 조용히 해제하지 않는다.

인수: 유일 기본값 중단 후 잘못된 모델 호출 0건, 선택 집합 밖 대체 0건, 재활성화 후 기본값 자동 복원 0건. pinned 모델 제거·계약 불일치 후보 추가 시 fallback 0건; 명시적 pin 해제 후 허용 후보만 선택해야 한다.

##### 요청 초안의 설정 적용

미전송 요청의 실행 설정은 draft request ID와 draftConfigRevision에만 기록한다. `이번 업무에 적용`으로 Run·provider turn·도구 실행을 생성하지 않는다. 전송 수락 때 최신 정책·권한·가용성과 초안 revision을 다시 대조해 첫 Run binding을 만든다. 이미 진행 중인 명시 대상의 설정 변경은 기존 Run 조정 계약을 따른다.

미실행 인수: 새 업무 초안의 설정 변경·취소·전송, 다른 진행 중 업무와 동시 편집을 교차한다. 전송 전 모델/도구 호출, 다른 업무 설정 변경, 취소한 초안 설정의 늦은 적용은 0이어야 한다.

<a id="impl-context-budget"></a>
#### 실행 한도·모델 용량·Reader 복구

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-policy)

System resolver는 첫 호출 및 이후 호출 직전에 적용 정책과 관련 source revision을 읽는다. 저장 매체별 `resolve/read/compareRevision` 인터페이스를 사용하며 상시 watcher를 요구하지 않는다. 각 포함 항목에 `sourceId/revision/scope/reason/authorityRevision`을 기록한다. Memory는 동일 검사 뒤 포함하며 자동 기록 동의와 읽기 권한을 별도 검사한다. 외부 내용은 지시 권한을 갖지 않는다. 모델은 해석·계획·판단을 담당하고 System이 구조 검사·권한 교집합·저장·coverage를 담당한다.

**운영 조정값과 중단 권한을 분리한다.** 128,000토큰·30분은 장시간 실행 인수 fixture이며 제품의 암묵적 Run 종료 한도가 아니다. soft watchdog은 관측 사용량·경과 시간·진행 정체를 표시하고 checkpoint를 남길 수 있지만, 그 신호만으로 실행·예약·사용자 목표를 중단하거나 완료 처리하지 않는다.

hard ceiling은 제품 소유자 정책 또는 사용자가 명시한 제한에만 존재하며 `value/unit/scope/origin/authorizedBy/effectiveAt`을 기록한다. 미설정 값은 `null`이며 fixture 수치로 채우지 않는다. 상한 도달에 따른 대기·중지·재개는 중앙 Run 수명주기를 따른다. 계정 전환으로 연결된 새 Run이 생겨도 같은 업무에 설정한 총예산·사용량 원장을 초기화하지 않는다.

Reader 포함 동시 추론 2개, 직접 반환·packet 목표 4,096토큰, Reader chunk 목표 4,096토큰은 초기 조정값으로 유지한다. 실제 허용량은 호출별 admission 결과로 낮출 수 있다. 이 숫자는 전체 읽기 범위나 장기 업무 수명의 제한이 아니다.

**모델 용량은 authoritative export로 확인한다.** adapter는 실제 선택된 모델의 runtime metadata에서 `ModelCapacityV1`을 내보낸다. record에는 Engine build·모델 식별자·모델 선택 revision·metadata 출처/hash·fallback 여부·설정 override·resolved/usable context window·확인 시각을 포함한다. `model/list`에 없는 window를 추정해서 채우지 않으며 사용자 설정값만으로 실제 모델 용량이 입증됐다고 보지 않는다.

계측 참조 commit `d6489472f3c15e87d2d7763a5fde033545c530f8`의 `ModelInfo`에는 `context_window`, `max_context_window`, `effective_context_window_percent`, `resolved_context_window()`, `usable_context_window()`가 있다. export는 이 해소 결과와 원천을 함께 전달하며 fallback metadata를 authoritative 값으로 승격하지 않는다. 이 참조 commit은 설치된 Engine 버전의 확인을 대신하지 않는다. [고정 revision의 모델 metadata](https://github.com/openai/codex/blob/d6489472f3c15e87d2d7763a5fde033545c530f8/codex-rs/protocol/src/openai_models.rs#L398).

엄격 admission은 다음 조건을 사용한다.

`A = max(0, min(4096, floor(.8L), Wusable − Hbound − O − S))`

여기서 `L`은 검증된 tool-output 한도, `Wusable`은 authoritative export의 사용 가능 window, `Hbound`는 해당 호출의 기존 입력·직렬화 비용 상계, `O=min(4096,floor(Wusable/4))`는 답변 여유, `S=max(1024,ceil(.15×Wusable))`는 추가 안전 여유의 초기값이다. 전달 후보의 검증된 비용 상계가 `A` 이하여야 한다. 필요한 용량·비용 상계를 확인하지 못하면 `ENGINE_CAPACITY_UNKNOWN`으로 엄격 dispatch를 막는다. **8,192 같은 추정 window로 guard 통과를 만들지 않는다.** UI에는 `[용량 정보 다시 확인] [지원되는 동일 구독 Engine 설정] [자료 직접 열기]`를 제공하며 독립 업무는 계속한다.

크기 초과는 파일 판독 실패가 아니다. chunk를 줄이고 문단·행·셀·텍스트 구간·페이지 내부 영역으로 더 작게 분할한다. 기존 Reader의 대화 누적이 원인이면 동일한 불변 source와 미완료 coverage를 가진 fresh Reader를 사용한다. packet 통합도 한 번에 들어가지 않으면 계층적으로 나눈다. 512토큰을 일반 읽기의 종료 하한으로 사용하지 않는다.

최소 Reader 지시와 가장 작은 유효 입력 단위조차 수용하지 못하면 `ENGINE_CONTEXT_CONFIGURATION_ERROR`로 분리한다. 해당 파일은 `coverage pending`이며 미판독 완료·손상 파일로 분류하지 않는다. 동일 입력·동일 설정의 무진전 재호출은 반복하지 않고 용량·설정을 재해소한다. 실제 실패 실행의 attempt와 재시도는 중앙 Run 수명주기에만 기록한다. quota 소진은 별도 계정 한도 상태이며 유료 API로 자동 전환하지 않는다.

#### 버전 고정 계측과 전달 증거

엄격 관찰의 계측 계약 버전은 제안된 `egdesk-input-receipt/v1`이다. 지원 여부는 다음 묶음으로 판정한다.

`upstreamCommit + engineBinaryHash + patchHash + protocolSchemaHash + instrumentationVersion + transportMode + conformanceEvidenceHash`

같은 함수 이름이 존재하거나 App Server 연결이 성공했다는 사실만으로 지원을 활성화하지 않는다. 묶음이 바뀌거나 필수 증거가 없으면 해당 엄격 관찰 capability를 비활성화한다. 이 계측은 stock App Server의 공개 API나 이미 구현된 기능이라는 뜻이 아니다.

참조 원천은 위의 고정 commit이며 관찰 경계를 다음과 같이 구분한다.

| 경계 | 계측 위치와 보장 범위 |
|---|---|
| `raw_capture` | EG-Desk gateway가 명명한 source 범위에서 직접 획득한 byte. 이 경계 밖의 원본 전체를 주장하지 않음 |
| `engine_history_pre/post` | `ContextManager::record_items_with_metadata`의 `truncate_function_output_payload` 호출 전후. native handler가 그보다 먼저 잘랐다면 pre 값도 전체 원문이 아님 |
| `outbound_request` | HTTP는 `prepare_response_items_for_request` 이후 실제 요청 전달 지점. WebSocket은 최종 `ws_request`를 만든 뒤 `stream_request` 직전 |
| `logical_input_lineage` | WebSocket delta에는 `previous_response_id`와 앞선 요청·응답 연결을 보존. 실제 wire delta와 재구성한 논리 입력을 별도 표시 |
| `native_event_output` | 관찰된 item/event 출력. 위 계측과 연결되기 전에는 모델 입력이나 원본 전체로 표시하지 않음 |

[출력 잘림 경계](https://github.com/openai/codex/blob/d6489472f3c15e87d2d7763a5fde033545c530f8/codex-rs/core/src/context_manager/history.rs#L349), [요청 준비·전송 경계](https://github.com/openai/codex/blob/d6489472f3c15e87d2d7763a5fde033545c530f8/codex-rs/core/src/client.rs#L1609).

compaction 요청도 별도 입력 변환·전송 계측 대상으로 포함한다. 연결 준비용 `generate=false`를 추론 호출로 집계하지 않는다. application payload의 원문·파생본·전송 hash와 request lineage를 연결하되 secret·인증 header·숨은 추론을 사용자 Snapshot에 복제하지 않는다. outbound 기록은 명명한 전송 경계의 증거이며 원격 모델 내부의 실제 처리 전체를 관찰했다는 주장이 아니다.

중개 읽기는 반환 범위·continuation을 명명 전에 확정한다. 뒤에서 잘림이 발생하면 같은 결과를 온전히 전달했다고 표시하지 않고 해당 엄격 dispatch를 차단한 뒤 명시적 bounded result 또는 Reader packet으로 재구성한다. native event를 수신하는 방식으로 모든 native tool의 원시 출력을 가로챌 수 있다고 가정하지 않는다. 중개·차단·계측이 검증되지 않은 경로는 보호된 읽기의 우회 경로가 될 수 없다.

EG-Desk read/tool gateway가 원문을 불변 저장한 뒤 named bounded result 또는 Reader packet을 반환한다. 직접 반환의 범위·continuation은 결과를 명명하기 전에 정한다. 반환 후 잘라놓고 같은 결과라고 기록하지 않는다. MCP의 도구별 `output_token_limit`과 직렬화 여유를 adapter 설정에 고정한다. 다른 MCP·앱·shell·web 도구는 각각 별도 allowlist와 집행 경로가 필요하며 sandbox network 설정 하나가 이들을 통제한다고 가정하지 않는다. [MCP 제한](https://learn.chatgpt.com/docs/extend/mcp), [설정 참조](https://learn.chatgpt.com/docs/config-file/config-reference).

명시적 전체 업무 한도가 있으면 관측 사용량과 미정산 예약량을 그 한도에 함께 계산한다. 한도가 없으면 사용량·예약은 관측값으로 유지하며 임의 한도를 만들어 작업을 종료하지 않는다. 부모·Reader·Worker는 같은 업무 사용량 원장을 공유한다. provider 출력·내부 재시도 비용을 제한할 수 없는 경로는 엄격 총량 보장을 표시하지 않는다. 승인 대기에는 추론 slot을 점유하지 않는다.

##### 제한별 설정·집행 계약

공통 `LimitEnvelope`는 종류·단위·scope·값·상한 출처·변경 주체·epoch·집행 adapter를 가진다. 자식은 parent 한도를 분배받거나 좁힐 수 있지만 넓히지 못한다. 범위 확대 권한과 실제 자원 접근권은 별도다.

| 제한 | 단위·소유/변경 범위 | 실제 집행·미지원 처리 | 경계값 oracle |
|---|---|---|---|
| 시간 | `deadlineAt` UTC, 호출별 `timeoutMs`; 설정 소유자/해당 수임자 | scheduler가 시작 전 deadline 검사, executor가 monotonic timeout 집행. 종료 미확인은 중지 요청 상태 유지 | deadline 직전 허용/도달 후 새 dispatch 0; watchdog만으로 종료 0 |
| 토큰 | 업무 전체 관측+예약 token; parent 원장 공유 | 호출 전 예약, 실제 usage 정산. 출력·재시도 상계 미검증이면 엄격 총량 모드 시작 불가 | 예약 포함 B 이하만 입장, B 초과 0; unknown을 0으로 계산 금지 |
| 비용 | 통화별 금액·유료 작업 상한; 비용 권한자 | 견적/상계 예약 후 dispatch. 가격 불명은 엄격 유료 작업 차단. 구독 사용량을 금액으로 환산하지 않음 | 잔액 2에 상계 2 허용, 3 거부 |
| 네트워크 | protocol·host·port·전송 범위; 조직/Desk 상한 안 Task subset | command는 활성 sandbox proxy, Browser·MCP·커넥터는 각 gateway에서 목적지·redirect·행동·전송 자료 검사 | 허용 host의 다른 port·redirect 밖 목적지 거부 |
| 파일 접근 | 읽기/쓰기/실행별 root·제외 경로; 자원 권한자 | 최종 경로와 열린 directory/file handle 기준 검사, symlink·상위 탈출 차단. native command는 OS sandbox 병행 | `/allow` 허용이 `/allow2`·외부 symlink를 허용하지 않음 |
| sandbox | 자료 읽기/선택 경로 수정/명시적 광역 권한; 정책 소유자 | 지원되는 OS 격리를 생성하고 실제 정책 hash 확인. 지원 불가면 제한 동작을 실행하지 않음 | 설정 성공이 아닌 실제 금지 read/write/network 실패 확인 |
| 동시성 | parent 업무·Engine pool의 활성 추론 수; 범위 내 scheduler 조정 | SQLite reservation으로 child·Reader 포함 원자 slot 획득. 2→1 축소는 새 입장 차단 후 drain, 목표 취소 없음 | 동시 두 입장 경쟁에서 초과 slot 0 |

Engine 서비스 통신, sandbox command, Browser, MCP, 커넥터의 제한을 합쳐 하나의 네트워크 보장으로 표시하지 않는다. command proxy의 domain rule은 proxy가 실제 활성일 때만 집행된다. [공식 집행 범위](https://learn.chatgpt.com/docs/permissions#what-the-network-proxy-does-not-control).

모든 실행 경로는 `operationId,target,authorityEpoch,limitEpoch`를 gateway에 제출한다. 미중개 native 도구는 제공 tool catalog에서 제외하고 해당 sandbox도 제한한다. `thread/shellCommand`, `process/spawn`처럼 sandbox 밖 경로를 제한 업무의 우회 실행에 사용하지 않는다. 특정 경로에서 정책을 집행할 수 없으면 그 capability만 unavailable로 표시한다. [App Server 실행 경계](https://learn.chatgpt.com/docs/app-server#api-overview).

<a id="tech-membrain"></a>
##### MemBrain: 기억 후보를 고르는 것과 원본을 검증하는 것

- **시간·대상·근거:** 질문을 기준으로 삼을 시각·기간과, 원본의 관찰·발언·접수·효력 기간을 분리한다. 시간은 재사용할 주장 단위에서 해석한다. 날짜 없는 과거, 기한 없는 현재, 시기 미정인 미래, 시점 미상은 별도다. 대상이 물리적인가 디지털·가상인가, 실제 사건인가 계획·가정인가, 내용이 관측 보고·전언·복사·계산·추론 중 무엇인가는 독립 축이다. 무엇을 어디까지 확인했는지, 근거끼리 일치하는지·충돌하는지·모르는지는 그 출처와 별도로 보존한다. 원문 일치가 사건의 실제 발생이나 계획의 이행을 증명하지 않는다.
- **제안과 권한:** 호스트가 허용된 후보를 구성하고 고정된 원문·보기에서 Decision Model이 선택·분류하거나 보류한다. 자유 서술, 새로운 가정의 전개, 여러 기록에 걸친 교훈은 생성형 모델이 제안할 수 있지만 직접 쓰지는 않는다. 문맥 선별, 외부 처리, 실제 자료 사용·저장 권한은 별개다. 누락·충돌·철회·미확인 상태는 더 넓은 원문 접근으로 대체하지 않는다.
- **원본과 조각:** 파일은 원본 ID·리비전·줄 범위, 발언은 발화자·대화·순번·해당 원문 범위와 시점에 귀속한다. 하나의 발언에 전언과 자기 계획이 섞이면 나누고 불확실한 축은 남긴다. 일반 Agent DM의 파일 행 동의와 향후 발언 재사용 동의는 독립이다. 이 기억 입력 경로는 같은 소유자·Agent·DM에서 해당 동의 이후에 접수된 사용자 메시지와 완료된 Agent 발언만 대상으로 한다. 현재 메시지와 달리 이전 발언 본문은 선별 모델의 후보 목록에 나열하지 않는다. 요청 당시뿐 아니라 읽기·전달 직전에 재검사한다. 철회는 이 근거 경로의 조회·새 전달을 막지만 원본 캡처나 이미 전달한 원문·네이티브 대화를 삭제하지 않는다. 네이티브 이력 재개는 별도 경계다. 철회 뒤 재허용은 새 세대이며 옛 발언 참조를 되살리지 않는다. 판정 모드를 끄는 것만으로 동의 세대를 지우지 않는다.
- **현재 관리 경로:** 인증된 로컬 브리지는 허용한 작업과 크기로 제한한 JSON `POST`만 받는다. 클라이언트의 방·프로필 ID는 조회 단서이지 권한이 아니다. 호스트가 실제 실행의 계정·Agent·DM 귀속을 재검사한다. 파일 등록과 발언 허용은 각각 명시적 동의를 요구한다. 원본 ID·버전·해시와 범위가 일치하고, 잘리지 않은 읽기 가능한 해당 방의 캡처만 채택한다.
- **범용 입력 목표:** 제안은 근거·주장 유형·적용 조건·대상 범위를 갖는다. 같은 입력의 재시도와 실제 새 리비전을 구별하고, 정정·충돌·보완은 원본을 바꾸지 않고 연결한다. 복사된 보고는 독립 관측으로 세지 않는다. 등록 영수증은 기록 성공이지 진실 판정이 아니다. 장기 보존·다른 채널 공유에는 별도 권한이 필요하다. 이 범용 계약을 현행 파일 행 등록이 모두 구현한다는 뜻은 아니다.

[DM 사용과 철회](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-local-memory) · [파일·기억 조각의 현재 입력과 제안 규격](../../apps/firefox-ui-demo/docs/DECISION_MODEL_CONTEXT_SETUP.md#memory-intake)

**정정 주석 (2026-11-25, owner 확인).** 위 MemBrain 항목의 '같은 소유자·Agent·DM' 한정과 DM 단위 동의·철회는 현행 로컬 구현의 범위를 서술한 것이며 기억의 목표 모델이 아니다. 기억 주체는 Agent이고 Board·대화는 출처(provenance)라는 목표 모델은 아래 [Memory 소유](#tech-memory-agent-owner)를 따른다. 위 문장은 현행 구현 기술로 보존한다.

<a id="tech-decision-boundary"></a>
##### Decision Model 책임 경계 (턴 처리 순서, 2026-11-25 owner 확인)

한 턴에서 Decision Model은 대화 아래에 있는, 이미 정의된 층(기억·행동 등)의 상태를 먼저 확정하고, 대화를 만드는 엔진은 그렇게 확정된 상태 위에서 말한다.

```text
정의된 하위 층 확정 (Decision Model + System): 기억 층(관련 기록·상태·충돌·확인 대기), 행동 층(대기 중 승인·실행 중 Run·브라우저 단계·명령 후보)
-> 대화 층 (엔진): 확정된 상태 위에서 실제로 글을 써야 하는 응답
```

- 이 순서는 책임 경계이며 Decision Model이 응답 글을 쓴다는 뜻이 아니다. 하위 층의 확정 결과를 엔진이 뒤집거나, 엔진 응답이 끝난 뒤에야 같은 턴의 기억·행동 상태를 정하지 않는다.
- 이 소절은 턴 처리 순서만 정한다. Decision Model이 맡는 판정 종류의 범위, 전송·비용 한도, 기본 활성 여부는 이 소절에서 정하지 않는다.
- 현행 구현이 이 순서와 다른 곳은 [Vision Gap 원장](./EGDESK_VISION_GAP_LEDGER.md#decision-memory-gap-20261125)에 날짜 행으로 둔다.


<a id="tech-temporal-evidence"></a>
##### 그때의 일을 물으면 그때의 기록을 조회한다 (설계·일반 DM 미연결)

시간 분류는 단지 ‘과거’라는 꼬리표를 답에 붙이는 일이 아니다. 도구나 자료를 고르기 전에 인용된 원 발언, 그 발언이 관찰한 사건·시간 범위·계정·세션을 묶고 **어떤 질문을 증명할지** 정한다. 과거 보고 문구는 무엇이 보고됐는지, 당시의 서비스 사용량 관찰은 어느 범위에서 몇 %였는지, 당시 실행별 적용 기록은 어떤 모드가 실제로 쓰였는지에 각각 답한다. 현재 설정·가동 목록 또는 요청 당시 희망 설정만으로 과거 실제 적용이나 사용량의 원인을 확정하지 않는다. 특정 세션 확인과 기간 전체의 부재 증명은 요구하는 기록 범위가 다르다. 접근이 허용되지 않았거나 누락된 기록이 있으면 범위를 밝히고 보류한다. 기록 조회는 현재 해도 되지만, 그 대상은 질문이 가리킨 시점에 고정한다.

조회 진행, 답변과 근거는 그 일을 요청한 대화·메시지·실행에 연결한다. 다른 질문 아래 이전 작업 상태를 표시하거나 진행 문구를 조회 완료 증거로 삼지 않는다. [문맥 조립](#tech-context-assembly) · [방 발언과 실행별 활동](#tech-room-speech) · [현재 같은 DM의 범위](#tech-session-topic-tree) · [가상 인수 예와 자료 선택](../../apps/firefox-ui-demo/docs/DECISION_MODEL_CONTEXT_SETUP.md#time-selects-evidence)

<a id="tech-session-topic-tree"></a>
##### 같은 스레드의 토픽 소속과 필요한 대화 경로 (Codex 일반 DM 로컬 구현)

**소속은 한 곳, 근거는 여러 곳이다.** ‘이제 원래 출고 계획으로 돌아가자’는 기존 토픽으로의 복귀일 수 있다. 반면 방금 다른 토픽에서 범위를 정정했다면 그 정정 턴도 근거에 포함한다. 부모가 같다는 사유만으로 모든 형제를 붙이지 않는다. 새 발언의 소속과 직접 필요한 선행 턴만 판정한다. 호스트는 이미 검증·저장한 선행 관계를 따라 상위 목적·하위 결정·정정의 원문을 시간순으로 조립한다. Task 실행 의존성, 사실 확인, 장기 기억 승격과는 다르다.

- **동의와 수신자:** 대상은 계정·Agent·로컬 및 native 방이 확인된 기존 Codex 일반 DM이다. `사용(on)`·키 설정은 필요조건일 뿐이며 DM 안에서 외부 주제 판단과 그 목적의 참조 보존을 **별도로** 허용해야 한다. 기존 최근 12발언 또는 파일 허용을 확대하지 않는다. 허용 전·다른 방·다른 엔진으로 소급/이월하지 않는다.
- **최종 답변 게시:** 위 수신자가 확인된 일반 Codex DM의 새 실행에서 일치하는 로컬 주제 기억 동의를 별도로 확인한다. 외부 판단 호출의 성공 여부와 무관하다. 동의 없음이 확인되면 일반 Chat 그대로이며, 적격 DM에서 동의 기록 자체가 판독 불가하면 보수적으로 최종 답변을 보류한다. 이때 전송 권한을 새로 주지 않는다. 네이티브 실행 상태와 답변 게시 상태를 분리한다. 확인된 최종 원문(최대 8항목, 합계 32 Ki UTF-16 코드 단위, 최대 120초)을 공개 스트림·저장·주제 기억에 넣기 전에 한정된 제품 서술과 대조한다. 철회 뒤 자동 복구·동의 없는 사용·내부 식별자의 공식 설정 오인만 좁게 다루며 자유서술 전체의 검증·교정이 아니다. 보류·거부된 초안 대신 호스트의 안내를 사용한다. 재시작은 공개된 로컬 기록만 복원하고, 불명확한 원문/귀속은 열지 않는다. 과거 답변 소급 검사·네이티브 엔진의 원문 삭제는 아니다.
- **기록:** 계정 소유자/Agent/방으로 분리한 비공개 저장소에서 동의 세대·외부 수신자·native 방·리비전에 묶는다. 한 행은 `key, topic, parent, needs, userRef, assistantRef`(구현 필드 `user, assistant`)다. 토픽은 첫 행의 키, 부모는 새 하위 토픽 생성 시에만, 필요 연결은 존재하는 과거 행의 키만 허용한다. 같은 요청의 확정 사용자 원문과 유일한 실시간 최종 답변·성공 종료를 검증한 뒤 한 행만 추가한다. 이미 확정된 행을 고치거나 전문을 복사하지 않는다.
- **전송:** 전체 그래프를 새로 분류하는 대신, 허용된 앞선 쌍의 원문과 별칭 관계표, 현재 질문을 한 번에 본다. 호스트가 실제 송신 키 및 계정·세대를 확인하고, 판정된 선행 경로만 같은 구독 Agent의 답변 입력에 추가한다. 파일 원문을 읽을 권한은 따로 있어야 한다. 원문/해시/동의 식별자는 공개 메시지·진행 기록에 쓰지 않는다. 화면·native 스레드에는 원래 대화가 그대로 남는다.
- **보류:** 동률·불명·누락·권한 변화·불완전한 경로는 새 토픽으로 추정하지 않는다. 세대당 최대 96쌍이며 오래된 턴을 몰래 제거해 공간을 만들지 않는다. 실패해도 일반 채팅을 보존한다. 철회 후 새 세대는 빈 인덱스이며 이미 보낸 내용은 회수되지 않는다. Claude/Board, 장기 승격, 토픽별 문서 탐색·후속 판정은 이 범위 밖이다.

[원안과의 대응](../../apps/firefox-ui-demo/docs/DECISION_MODEL_CONTEXT_SETUP.md#session-topic-tree) · [전송 형식·예산·실제 DM 시험](../../apps/firefox-ui-demo/docs/DECISION_MODEL_CONTEXT_SETUP.md#membrain-turn-wire) · [허용·철회 사용법](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-local-topic-tree)

##### Memory·instruction 검증 record

Memory는 `id,revision,owner,scope,conditions,sourceRefs,judgmentKind,reuseState,validUntil,consentRef,authorityEpoch`를 가진다. 모델은 후보 내용과 의미를 제안하고 System은 기록 권한·동의 조건·참조를 검사한다. Profile의 정책 변경은 Memory 본문·소유권 변경이 아니다.

<a id="tech-memory-agent-owner"></a>
**Memory 소유: Agent 중심 (2026-11-25 owner 확인).** 위 record의 `owner`는 기본적으로 Agent(인격체)다. Agent는 Board와 대화를 넘나들며 일하고, Memory와 그 Agent의 대화 내역은 Agent에 속한다. Board와 대화는 Agent가 일한 장소이며 `sourceRefs`가 가리키는 출처(provenance)이지 기억의 경계가 아니다. 소유가 조직인지 개인인지는 Agent별로 설정할 수 있는 속성이다. 위 `scope`의 현행 값(DM·Board 단위)과 MemBrain의 DM 한정은 현행 구현 기술이며, 이 소유 모델의 구체 필드와 설정 UI는 확정하지 않았다. 조직·개인 소유에 따른 열람·이동 권한은 위 인수 조건과 기존 Agent 소유·권한 규칙을 따른다.

이동은 대상 새 ID 생성과 원 ID의 `moved` tombstone을 한 transaction으로 적용한다. 대상 저장 실패 시 원본은 active로 남는다. 삭제·만료·이동 tombstone과 `reuseEpoch`는 오래된 활성 event보다 우선한다. 동기화·import는 tombstone을 확인한 뒤 indexing하며 예전 active record를 다시 admission하지 않는다. 물리 payload 정리는 기존 저장·보관 계약을 따르고, 재사용 금지와 삭제 완료를 혼동하지 않는다.

effective instruction receipt는 항목별 `sourceKind,sourceRef,revision,disclosure,editableBy,precedenceClass,appliedState,winnerRef,reason,affectedActions`를 기록한다. provider가 공개하지 않은 원문·식별자는 생성하지 않는다. 원문 열람과 편집, 편집과 활성화 권한을 별도로 검사한다.

인수: 각 Memory 범위의 무권한 write/이동 0건, 자동 동의 불일치 항목 활성화 0건, 종료한 임시 구간·삭제/만료 기억의 재동기화 admission 0건. Profile 공유만으로 Agent 개인 기억 공개 0건. 정책 충돌 receipt는 실제 적용 입력과 일치해야 한다.

<a id="impl-run-orchestration"></a>
#### Run·Task·복구 전이 — §9·11·13 확장

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control)

Run은 `binding/running/waiting/stopping/stopped/completed/failed`를 사용한다. 연결 미확인은 실행 상태와 별도 health 축이며 timeout·expiry는 원인 필드다. Task의 정본 여덟 상태는 유지한다. attempt는 실제 실패 execution을 다시 수행할 때만 증가한다. checkpoint 재개·일반 조정·설정 적용은 새 attempt가 아니다.

사용자 업무의 최초 request·room·Task lineage와 provider의 thread/turn·실행체 generation을 분리한다. 일반 source·Ontology·모델·Profile·실행 PC 조정은 같은 EG-Desk Run에 configuration/context revision을 추가한다. 조정·새 provider turn·fresh Reader·PC handoff 자체는 실패 attempt나 의도적 fork가 아니다.

활성 provider turn에 추가하는 일반 입력은 `turn/steer`의 `expectedTurnId`로 대상 turn을 확인한다. 모델·cwd·sandbox·output schema override를 steer에 넣지 않는다. 모델·Profile 등 provider turn 단위 설정은 현재 turn이 끝난 뒤 같은 Run의 다음 `turn/start` 또는 adapter가 지원하는 명시적 세션 재결합에서 적용한다. PC handoff는 이전 writer의 중지·lease 해제를 확인한 뒤 같은 Run의 새 실행 binding으로 이어간다. 권한 철회·승인 대상 변경·동시 쓰기 충돌에 걸린 행동만 즉시 fence한다. [steer 제약](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn), [turn 시작](https://learn.chatgpt.com/docs/app-server#start-a-turn).

계정 principal 변경에 새 Run이 필요한 adapter에서는 새 Run에 `continuesRunId`와 동일한 사용자 업무·최초 request·room·Task lineage 참조를 기록한다. System이 허용된 현재 context·완료 기여·미완료 조건·미확인 ActionIntent를 연결하며 새 사용자 prompt를 요구하지 않는다. 이전 실행의 완료 작업·외부 효과를 다시 수행하지 않고 credential·승인은 새 principal에서 재검증한다. 전환은 하나의 업무 안의 계정 변경 사건으로 표시하며 기존 실행 기록을 덮지 않는다.

retry·resume·cancel·timeout·expiry·late result의 상태 전이는 이 중앙 계약만 사용한다. Browser·Terminal·Reader adapter는 관찰·오류·중지 확인·결과 receipt를 반환하며 자체적인 경쟁 Run/attempt 수명주기를 만들지 않는다.

#### 수정된 인수 조건

- 420×600·320×420에서 설정과 승인 경로를 수행한다. 자동 확대 없이 작성기·업무 대상이 유지돼야 한다. 설정 비교의 `[넓게 보기]`는 520×680, 원문·승인 검토는 [별도 검토 치수](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-review-geometry)를 사용하며 각각 명시적 진입과 원 rect 복귀를 검사한다.
- 진행 중 Browser·Terminal 활동은 기존 Live ID로, 완료된 읽기·명령은 Snapshot으로 이동해야 한다. Live 미생성·연결 불명 상태에서 새 실행 생성은 0건이어야 한다.
- 명시적 hard ceiling 없는 목표가 128k토큰·30분 fixture 경계를 넘어도 watchdog만으로 종료·취소되지 않아야 한다. 별도로 설정한 hard ceiling은 기록된 중앙 전이를 따라야 한다.
- 용량 누락·fallback metadata에서는 엄격 admission 통과가 0건이어야 한다. 크기 초과 자료는 더 작은 단위·fresh Reader로 이어지고 미완료 coverage가 남아야 한다.
- 계정 전환 후 같은 업무·room·request·Task lineage와 초안을 유지하고 새 사용자 prompt·완료 작업 재실행은 0건이어야 한다. 일반 모델·Profile·source·PC 조정에서는 Run ID를 유지해야 한다.
- 각 지원 계측 묶음에서 native event, history 전후, compaction, HTTP·WebSocket 전송을 대조한다. 명명되지 않은 잘림과 native event를 전체 모델 입력으로 오표시하는 경우는 0건이어야 한다.

대기 해소는 같은 Run·attempt를 재개한다. 실패 Task 재시도는 같은 Task의 새 attempt다. 완료·취소 Task 재작업은 연결된 새 Task다. 의도적 fork는 새 Run과 선택한 이력 범위를 만들며 외부 효과를 재생하지 않는다. stopped Run의 명시적 계속은 새 실행 구간을 기록하고 취소 Task를 자동 부활시키지 않는다. deadline 만료는 후속 dispatch를 막고 중지를 요청하며 종료 확인을 기다린다.

Task graph는 모델이 제안하고 System이 cycle·authority·write set·증거 조건을 검사한다. edge는 필수 성공/허용된 부분 증거/선택 참고를 구분한다. 필수 edge 실패는 해당 후손만 차단한다. 부분 기여는 source revision·coverage·미해결점을 보존한 채 통합할 수 있으나 필수 완료조건을 충족하지 않으면 Result.completeness는 partial이며 Run 상태는 필수 조건과 중앙 전이에 따른다. 통합의 업무 판단은 담당 모델, 조건 충족 검사는 System 책임이다.

child 권한은 parent 위임·Profile 상한·계정 권한의 교집합이다. child에는 필요한 context snapshot만 전달한다. write lease는 resource·revision·executor generation에 결합한다. 재할당은 기존 lease 종료 확인 후 새 generation에 부여한다. 통합 후보는 하나씩 고정 revision에서 검사하며 실패 후보만 반환한다.

상태 event와 dispatch intent는 SQLite transaction/outbox로 기록한다. 중복 event ID는 무시하고 늦은 event는 실행 generation·취소 fence·입력 revision으로 평가한다. 늦은 성공 evidence는 보존하지만 취소된 후속 실행을 깨우지 않는다.

health는 host nonce 응답, process generation/exit, adapter handshake, bounded `thread/read`, 계정·도구 상태를 독립 조회한다. catalog 응답을 추론 성공으로 취급하지 않는다. 활성 상태는 10초 간격, 30초 무응답이면 `미확인`; 재연결은 1/2/4/8/16/30초와 ±20% jitter로 제한한다. 이는 검사 정책이지 장애 확정 기준이 아니다. process 교체는 새 identity이며, Engine process가 다른 Run도 소유하면 전체 process를 종료하지 않는다.

인수는 정상·취소·부분 완료·단절·재접속·중복·늦은 결과를 바꾼 6개 순서 fixture를 각각 30회 수행한다. 1/2/12 Task와 1/30 Board를 조합하고 동일 revision에 대한 의미 결과·권한·receipt를 비교한다. 초기 목표는 오귀속·중복 외부 실행·독립 결과 유실 0건이다. 시간·용량은 p50/p95/max와 환경·version·확인 시각을 기록하며 아직 측정값은 없다. 실패하면 해당 adapter 기능을 차단하고 checkpoint·Snapshot·독립 작업을 유지한다.

##### 결과 완전성의 별도 축

Run 상태는 `binding/running/waiting/stopping/stopped/completed/failed`다. **`partial`은 Run·Task enum이 아니라 Result.completeness에만 기록한다.** Run 전이는 중앙 전이표의 scheduler event를 사용한다.

부분 Result가 있어도 실행 중인 Run은 running, 조건을 기다리면 waiting, 종료가 확인된 중지는 stopped로 표시한다. 필수 완료조건 미충족을 partial Run으로 우회하거나 작업 완료로 표시하지 않는다. UI는 `실행 상태`와 `결과 범위: 부분·완료 2/실패 1`을 별도 줄로 제공한다. Task의 정본 여덟 상태와 과거 attempt는 유지한다.

인수조건은 running/waiting/stopped/failed Run에서 부분 Result 표시가 가능하고, completeness 갱신만으로 Run 전이·새 attempt·후속 실행이 발생하지 않는 것이다. 상세 전이 정의는 중앙 전이표 한 곳에만 둔다.

##### 중앙 상태·사건 전이

Run execution enum은 `binding/running/waiting/stopping/stopped/completed/failed`다. **`partial`은 여기에 없다.** Result completeness는 `none/partial/complete`, 효과·근거의 미확인은 별도 필드다. 완료·실패·중지 이후 명시적 계속은 같은 Run의 새 execution epoch를 만들며 과거 epoch와 Result를 보존한다.

Task는 기존 여덟 상태를 사용한다. `terminalBlock`은 실패·취소된 필수 선행조건 때문에 자동 진행할 수 없다는 dependency 속성이며 새 Task 상태가 아니다. 취소 Task는 자동 부활하지 않는다. attempt는 실패한 execution을 실제 재dispatch할 때만 증가한다.

| 사건 | Run 전이 | Task·ID·후손·종료 조건 |
|---|---|---|
| 요청 수락 | 없음→binding | 새 Run/Task. 초기 Task는 preflight dependency 대기 |
| preflight 통과 | binding→running | 조건 충족 Task `waiting-on-dependency→ready→queued→running`; dispatch 시 첫 attempt |
| 승인/재연결 등 가역 조건 대기 | runnable이 없으면 waiting | 해당 Task만 approval-required 또는 waiting-on-dependency; 추론 slot 반환 |
| 조건 충족 | waiting→running | 같은 Run·Task·attempt로 ready→queued→running |
| 일반 source/model/Profile/PC 조정 | 같은 Run, 작업 상태 유지 | context/config revision 추가. 필요한 적용 경계만 사용; 새 attempt/fork 없음 |
| 실행 실패 | 독립 실행 있으면 running | 해당 Task failed. 필수 후손은 dependency 대기+terminalBlock; 기여·실패 receipt 보존 |
| failed Run의 `[재시도]` 확정 | failed→binding→running 또는 waiting | 선택한 failed Task만 재준비. 새 attempt는 실제 dispatch 때 생성; 완료 sibling 유지 |
| 필수 Task 취소 | 독립 실행 중이면 running | 미시작 Task는 cancelled. 실행 중이면 cancel fence 후 terminal/중지 확인까지 running+stopRequested; 이후 cancelled. 필수 후손 terminalBlock |
| 필수 행동 승인 거부 | 독립 실행 중이면 running | intent denied. 그 효과가 완료에 필수이고 허용 대안이 없으면 Task cancelled(reason=denied); 후손 terminalBlock |
| 승인 grant 만료 | runnable 없으면 waiting | 미실행 행동 approval-required(reason=expired). 새 유효 승인 전 실행 금지; Task 자동 취소 아님 |
| Await의 명시 deadline 만료 | 독립 실행 중이면 running | 미실행 Task cancelled(reason=condition-expired); 필수 후손 terminalBlock |
| 호출 timeout | 집계에 따름 | 실제 실행 Task failed(reason=timeout); 미확인 효과는 별도 유지 |
| 전체 Run 중지/명시 hard deadline | running/waiting→stopping→stopped | 미시작 Task cancelled, 실행 중 Task는 종료 확인까지 stopRequested. 원격 응답 없음이면 stopping 유지 |
| completed Run에 후속 지시 수락 | completed→binding | 같은 Run·room·업무, 새 Task·execution epoch. 완료 Task와 이전 Result 불변 |
| stopped Run의 명시적 계속 | stopped→binding | 중지 latch를 명시적으로 해제. 필요한 취소 작업은 새 대체 Task로 연결하고 원 cancelled 상태 유지 |
| 의도적 fork | 원 Run 불변, 새 Run binding | 선택 context와 `forkedFrom`만 연결. 승인·lease·외부 효과 재생 금지 |
| 늦은/중복 event | 유효한 최신 상태 유지 | event ID·epoch·attempt·fence 검사. 취소 뒤 결과는 보존하되 후손 dispatch를 깨우지 않음 |

거부된 행동과 다른 대안이 허용된 경우에는 같은 목표의 새 대체 Task를 만들 수 있다. 거부된 동일 효과의 재시도에는 새 명시적 권한이 필요하다. 대체 결과는 `satisfiesCriterionId`로 연결하며 원 취소 Task를 completed로 바꾸지 않는다.

**Parent 집계 우선순위:** 전체 중지 latch → 진행 중 preflight → runnable/실행 Task가 있으면 running → 유효한 가역 대기가 있으면 waiting → 남은 필수 criterion이 terminalBlock이면 failed → 필수 criterion 충족 및 남은 실행 의무가 없으면 completed. 따라서 필수 취소/거부 때문에 미완료인 Run을 `completed + partial`로 숨기지 않는다. 허용된 선택 항목만 빠진 경우에 한해 completed와 Result partial이 함께 존재할 수 있다.

전환은 `operationId,expectedRunRevision,frozenTaskIds`로 조건부 기록한다. checkpoint 재개는 이후의 완료·승인 철회·외부 효과 journal을 먼저 대조한다. 응답 유실은 같은 operation 상태 조회이며 새로운 실행 명령이 아니다.

##### 여섯 순서 fixture — 미실행 인수 명세

공통 fixture는 실제 업무 서비스 대신 상태를 기록하는 provider/model simulator를 사용한다. 입력은 `doc@1={"amount":10}`, 독립 계산 `2+2`; Task graph는 `A=Reader`, `B=독립 계산`, `X=제출(A+승인 필요)`, `J=종합(B+X)`이며 모두 필수다. 기대 최종 내용은 `{amount:10,check:4,receipt:"receipt-1"}`이다.

초기 preflight 뒤 A/B가 실행된 상태를 `(running; r,r,d,d; none)`으로 쓴다. 순서는 Run; A/B/X/J; Result completeness다. 약어는 `r=running,c=completed,d=waiting-on-dependency,a=approval-required,f=failed,x=cancelled`, `d!`는 terminalBlock이다. ready·queued·dispatch 중간 event도 전이표대로 기록한다.

공통 완료 suffix S는 **유효 승인→X ready/queued/running→provider 접수+독립 조회+X 종료→J ready/queued/running→J 완료**다. 기대 vector는 차례로 `(running;c,c,r,d;partial)` → `(running;c,c,c,r;partial)` → `(completed;c,c,c,c;complete)`다.

| fixture | 사건 순서와 단계별 기대 |
|---|---|
| F1 정상 | A 완료→`(running;c,r,a,d;partial)`; B 완료→`(waiting;c,c,a,d;partial)`; S |
| F2 실패·failed Run 재시도 | A 실패→`(running;f,r,d!,d!;none)`; B 완료→`(failed;f,c,d!,d!;partial)`; A 재시도 확정→binding; A attempt 2 dispatch→`(running;r,c,d,d;partial)`; A 완료→waiting/a; S |
| F3 필수 취소·늦은 결과 | A 완료→running/c,r,a,d; X 취소→running/c,r,x,d!; B 완료→failed/c,c,x,d!; 옛 grant·옛 executor 결과 수신→동일 상태. X 실제 dispatch 0, 취소 Task 재시작 0 |
| F4 보류·provider 요청 소멸·만료·거부 | A/B 완료→waiting/c,c,a,d; 보류→불변; provider 요청 p1 cleared→불변; 새 p2에 묶인 승인 만료→a 유지; 재검토에서 거부→failed/c,c,x,d!; 늦은 p1 응답→불변 |
| F5 전송 뒤 단절·재탐색·hard expiry | A/B 완료·승인·X 전송→running/c,c,r,d; 응답 유실→같은 상태+health unknown; reload/back/복원→재전송 0; fixture에 명시한 Run deadline 도달→stopping/c,c,r,x; 재접속·X 종료 확인→stopped/c,c,x,x; 접수 조회는 receipt-1을 보존하되 J 재개 0 |
| F6 completed Run 계속·중복 | F1 완료 후 후속 지시→같은 Run binding, 새 Task K; K running 중 일반 조정→같은 Run·attempt; 옛 J 완료 중복→K 불변; K의 최신 지시 결과 완료→새 epoch completed·새 Result revision, 옛 Result 불변 |

모든 단계에서 비교할 집합은 `dispatch IDs, Task/attempt/epoch, input/source revisions, grant decisions, provider request bindings, stop/exit receipts, effect receipts, contribution dispositions`다. F1/F2/F6은 기대 내용·정확한 후속 시작의 양성 oracle도 검사한다. F3/F4는 X 접수 0, F5는 접수 정확히 1이며 조회·재탐색으로 증가하지 않아야 한다.

각 fixture를 고정 seed 0–29로 30회 수행한다. source·schema·adapter build·시계 사건·입력과 기대 vector를 고정한다. 사건별 실제 증거·확인 시각·시간/용량 분포를 기록한다. 이는 실행 횟수 계획이며 현재 통과·성능 수치가 아니다.

##### 시도 이력 조회·비교

이력 조회는 `runId, taskId, attemptId, eventSequence`와 현재 읽기 권한으로 범위를 제한한다. 두 시도의 비교 manifest는 선택 시점의 config/input/result/receipt 참조와 실제 확인 상태를 고정하며 raw payload를 현재 원본으로 재생성하지 않는다. 결과 부족은 누락/미확인으로 남기고 이후 갱신은 명시적 재조회에서만 적용한다. 비교용 조회는 Run·Task·attempt 상태를 바꾸지 않는다.

미실행 인수: 같은 Task의 실패 시도와 재시도 결과를 선택해 입력·설정·산출물·외부 receipt 차이를 대조한다. 시도 1개·자료 삭제·권한 철회·늦은 결과·재진입을 포함한다. 다른 Task 기록 혼합·과거 자료 덮기·조회로 인한 dispatch/attempt 증가·다른 초안 유실은 0이어야 한다.

<a id="impl-approval-receipts"></a>
#### 유효 권한과 외부 효과 — §9·3 확장

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-approval)

유효 행동은 `capability ∩ availability ∩ Profile ceiling ∩ Task delegation ∩ resource authority ∩ System/provider restrictions ∩ sandbox/network ∩ active approval ∩ execution limits`다. 승인이 불필요한 기존 위임에는 별도 승인 항목을 생성하지 않는다.

ActionIntent는 요청자·실행자·계정·resource revision·payload hash·전송 대상·효과 유형·비용 상한·만료·idempotency 지원 여부를 가진다. gate fingerprint가 같은 요청만 묶되 같은 패키지의 서로 다른 행동은 별도 intent와 결정을 유지한다. 승인 시점과 실행 직전에 authority·payload를 다시 비교한다.

검토 집합·상세 projection의 revision/hash와 최종 결정 이벤트를 결합한다. 정확한 범위를 제시한 상세에서 한 번의 최종 허용으로 authorized를 기록할 수 있으며, 같은 내용을 한 번 더 누르는 UI를 기술적 승인 요건으로 강제하지 않는다. 요약의 검토 진입은 결정이 아니다. 새 intent는 현재 선택에 자동 합류하지 않으며 payload·대상·계정·기간·비용이 바뀌면 새 상세와 결정이 필요하다. 표시됨이나 scroll 끝 도달은 사람이 내용을 이해했다는 증거가 아니다. 별도 확인이 필요한 명시 정책·provider 요구는 유지한다.

제품의 허용·거부·행동 취소만 아래 메서드별 provider 응답으로 변환한다. 검토 닫기·Esc와 보류는 승인 응답을 보내지 않는다. `acceptForSession`이나 session permission grant는 명시된 지속 위임이 있을 때만 사용한다. UI 보류는 승인 응답이 아니며 provider 요청이 끝나도 제품 intent의 대기·만료 관계를 남긴다. [App Server 승인 프로토콜](https://learn.chatgpt.com/docs/app-server#approvals).

gateway는 executor lease와 단일 dispatch 기록을 요구한다. 서비스의 멱등 키를 지원할 때 같은 논리 행동의 재시도에 재사용한다. 지원하지 않으면 read-only receipt 조회가 선행한다. HTTP 성공·로컬 UUID·버튼 클릭만으로 exactly-once를 보장하지 않는다. receipt와 현재 업무 상태가 충돌하면 기존 판단을 stale로 표시하고 증거를 덮지 않는다.

이전 attempt의 늦은 외부 효과 증거도 현재 attempt의 상태 전이·새 행동 권한과 분리해 보존하고 원천 서비스와 대조한다. 확인되지 않은 효과는 [조직 실행의 복구 경계](#tech-org-execution)를 따른다.

인수 절차: 승인 후 계정 교체·payload 수정·scope 철회·만료, 업로드 성공/제출 실패, 전송 직후 연결 유실을 주입한다. gate 재사용은 동일 범위에서만 가능하고 새 범위는 dispatch 0건이어야 한다. 공식 접수와 후속 처리 상태가 별도이며, 미확인 효과의 재전송은 0건이어야 한다. 독립 Task는 계속 진행해야 한다.

##### UI 결정과 provider 응답 분리

제품 결정은 `pending/deferred/authorized/denied/cancelled/expired/revoked`, provider 요청은 `pending/response-sent/resolved/cleared/unknown`으로 별도 기록한다. UI 닫기는 어느 결정 상태도 바꾸지 않는다.

native 요청 키는 `engineProfileId,connectionGeneration,JSON-RPC request id,threadId,turnId,itemId`이며 제공된 `approvalId/elicitationId`도 보존한다. JSON-RPC 응답의 `id`는 받은 요청 ID를 그대로 사용한다.

| native 요청 | 허용 / 거부 / 행동 취소 응답 | 해소·실행 증거 |
|---|---|---|
| `item/commandExecution/requestApproval` | `{decision:"accept"}` / `decline` / `cancel`; 지원 `availableDecisions` 준수 | `serverRequest/resolved`와 `item/completed` 별도. cancel은 provider turn도 interrupt할 수 있음 |
| `item/fileChange/requestApproval` | `{decision:"accept"}` / `decline` / `cancel` | 해소 알림과 실제 file-change 결과·readback 별도 |
| `item/permissions/requestApproval` | `{permissions:허용부분,scope:"turn"}` / `{permissions:{},scope:"turn"}` | 거부/취소 구분은 제품에 기록. 행동 취소 시 해당 실행 중지도 요청; boolean 허용으로 host 제한까지 생겼다고 보지 않음 |
| `mcpServer/elicitation/request` | `{action:"accept",content:검증값}` / `{action:"decline",content:null}` / `{action:"cancel",content:null}` | `serverRequest/resolved`와 후속 tool 결과 별도 |
| `item/tool/requestUserInput` | `{answers:{질문ID:{answers:[받은 선택값]}}}` | 실험적 schema에 맞게 변환. 없는 거부/취소 선택값을 발명하지 않고 gateway 차단·해당 실행 interrupt로 처리 |

응답 형태는 고정 schema로 검증한다. [공식 승인 계약](https://learn.chatgpt.com/docs/app-server#approvals), [응답 타입](https://github.com/openai/codex/blob/d6489472f3c15e87d2d7763a5fde033545c530f8/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L1609), [permission 응답](https://github.com/openai/codex/blob/d6489472f3c15e87d2d7763a5fde033545c530f8/codex-rs/app-server-protocol/src/protocol/v2/permissions.rs#L799).

보류는 응답을 보내지 않고 checkpoint한다. native 요청이 종료되면 제품 intent는 보존하고 새 요청 ID에 재결합한다. 이미 사라진 ID로 응답하지 않는다. 응답 전송 뒤 유실은 outbox·요청 상태·item 결과를 대조하며, `resolved`만으로 허용 적용·실행 성공을 추정하지 않는다. 부작용 결과가 불명이면 재응답/재실행 대신 receipt 조회를 선행한다.

유효 종료는 `min(제품 위임 종료,자원 grant 종료,명시 행동 deadline)`이다. provider session grant가 더 넓거나 오래가면 사용하지 않는다. 기본은 일회 승인/turn subset이며 turn보다 짧은 권한은 gateway에서 매 dispatch 재검사한다. 이를 집행하지 못하는 native 경로에는 grant를 주지 않는다. session 캐시 철회가 불가능하면 해당 세션의 새 실행을 fence하고 격리 세션을 종료·재결합한다. 다른 Run의 process를 함께 종료하지 않는다.

인수: UI 닫기 시 provider 응답 0, 보류 후 cleared를 authorized로 판정 0, 중복 응답·유실 후 효과 재실행 0, 제품 만료 뒤 session 캐시 우회 0이어야 한다.

<a id="impl-account-binding"></a>
#### 계정·credential·콘텐츠 식별 — §14.1·3 확장

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-identity)

Engine Profile별 App Server process/config/credential store를 격리한다. managed ChatGPT login을 사용하고 `account/login/completed` 이후 `account/read`의 실제 auth mode·계정·plan을 확인한다. quota는 별도 조회한다. 사이트·커넥터·OS 신원은 각 표면에서 검증하며 Engine 인증 결과를 복제하지 않는다. [공식 인증 경로](https://learn.chatgpt.com/docs/app-server#auth-endpoints).

login transaction은 `loginId/engineProfileId/expectedIdentity/returnTarget/generation`을 가진다. 취소·세대 변경 뒤 도착한 callback은 현재 선택에 적용하지 않는다. secret은 Engine credential store 또는 OS 보안 저장소에만 두고 handle generation으로 참조한다. 계정 식별자가 공개되지 않았으면 임의 provider ID를 만들지 않는다.

Browser target은 `hostId/browserInstanceId/profileId/containerId/tabId/frameId/documentRevision`을 사용한다. 컨테이너 cookie store와 사이트 계정 확인은 별개다. 다른 container로의 전환은 새 tab/view 생성 후 계정을 확인하며 기존 form은 유지한다. [Firefox container 지정](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/create).

Resource는 provider의 tenant+안정 ID를 우선하고, 없으면 의미 있는 query를 보존한 locator와 관찰 revision을 사용한다. byte hash는 Content identity일 뿐 authority key가 아니다. 동일 content도 모든 SourceRef와 각각의 access context를 유지한다.

보존·반출은 연결된 정책에 따른다. 참조 중심형은 사용·고정 중 payload를 유지하고, 기간형은 만료 시 payload만 정리하되 허용된 최소 lineage를 남긴다. 관리 자료 철회형은 이후 열람·재사용·반출을 막고, 개인 과거 사본 허용형은 기존 적법한 로컬 사본만 당시 자료로 남긴다. 어느 모드도 외부 전달 사본 회수를 보장하지 않는다. 삭제·export에는 선택 ID 집합·제외·성공/실패/미확인을 반환한다.

인수 절차: 제품 A/Engine B/커넥터 C/Browser D/OS E 조합으로 각 신원을 따로 바꾼다. 다른 plane의 묵시 변경·secret export·무권한 중복 존재 노출은 0건이어야 한다. 인증 취소·callback 유실·교체 경쟁·부분 삭제는 같은 초안/대상으로 복귀해야 한다.

##### 서비스 인증 transaction·handle binding

서비스 연결은 Engine 로그인과 별도 `ServiceAuthTransaction`을 사용한다. 필드는 `txnId,kind,serviceId,connectorInstance,expectedSubject/tenant,requestedScopes,resourceIds,authorityGrantId,browserContext,nonce,generation,deadline,returnTarget`이다. 결과 단계는 `auth-observed→identity-verified→scope-verified→resource-verified→bound`다. 앞 단계 성공을 다음 단계 성공으로 대신하지 않는다.

직접 OAuth adapter는 외부 인증 표면, Authorization Code+PKCE, issuer·redirect·state 검증을 사용한다. callback에는 secret을 기록하지 않는다. [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html#section-6), [OAuth 보안 계약](https://www.rfc-editor.org/rfc/rfc9700.html).

App Server 관리 MCP는 `mcpServer/oauth/login{name,threadId,scopes,timeoutSecs}`의 URL과 `mcpServer/oauthLogin/completed{name,threadId,success,error}`를 사용한다. 완료 event에 고유 login ID가 없으므로 동일 runtime/name/thread의 동시 인증을 허용하지 않는다. 성공 알림만으로 계정을 확정하지 않고 서비스 adapter의 identity·scope·Resource probe를 수행한다. [고정 MCP schema](https://github.com/openai/codex/blob/d6489472f3c15e87d2d7763a5fde033545c530f8/codex-rs/app-server-protocol/src/protocol/v2/mcp.rs#L268).

MCP 취소에 Engine용 `account/login/cancel`을 사용하지 않는다. 취소 시 제품 binding generation을 무효화한다. provider grant가 남았는지는 별도 상태다. callback 상관관계가 불명확하면 자동 결합하지 않고, 독립 검증 후 `[검증된 기존 연결 사용]`이라는 명시적 경로만 제공한다.

handle binding은 `handleId,generation,kind,subject,scope,expiresAt,bindingTargets,revision`을 가진다. 선택/교체는 frozen 대상·현재 generation을 조건부 갱신한다. 만료 후 재결합은 동일 subject·요청 scope를 다시 확인하고 새 generation을 기록한다. 서비스 probe가 실제 신원을 제공하지 못하면 `identity unknown`이며 신원 의존 쓰기는 차단한다. 권한 probe를 위한 시험쓰기를 하지 않는다.

동일 콘텐츠 비교는 `Resource ID,SourceRefs,content revision,context ID,action,authorityEpoch,checkedAt`를 보존한다. focus/open 직전에 현재 권한을 재검증하고 변경되면 선택 화면으로 반환한다. 읽기 동등성이 행동 권한이나 출처 이력을 합치지 않는다.

인수: 웹 A·커넥터 B 불일치, 만료/교체 경합, 취소된 늦은 callback, 권한 비교 후 철회, 닫힌 기존 View를 주입한다. 무권한 binding·선택 밖 교체·무검증 쓰기·출처 병합은 0건이어야 한다.

<a id="impl-browser-operations"></a>
#### Firefox 조작 adapter와 입력 인수 — §3·13 확장

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-browser)

Firefox shell adapter는 검증된 tab→browser binding을 해소한 뒤 그 browser의 navigation interface를 호출한다. 현재 선택 탭에 위임하는 전역 호출을 background target 조작에 사용하지 않는다. 새 web tab은 web principal 경로를 사용하고, 뒤로/앞으로/reload/stop은 `nsIWebNavigation`에 연결한다. 모든 탭의 progress listener에서 대상별 URL·로딩·오류를 받는다. [gBrowser 계약](https://firefox-source-docs.mozilla.org/browser/components/tabbrowser/docs/api.html), [navigation interface](https://searchfox.org/firefox-main/source/docshell/base/nsIWebNavigation.idl).

Agent 조작 입력은 target envelope·expected documentRevision·semantic locator·예상 event·postcondition·lease를 가진다. System은 행동 전후 관찰을 연결하고 모델은 그 의미를 해석한다. target revision이 바뀌면 재관찰하며 오래된 좌표를 재사용하지 않는다. human input은 해당 target의 Agent 입력만 양보시킨다. 모든 Agent 입력 중지는 즉시 lease를 회수하지만 이미 발생한 외부 효과를 취소했다고 표시하지 않는다.

download adapter는 Firefox downloads API의 ID·cookieStoreId·진행·canResume·error를 저장한다. `pause/resume/cancel/search/show`를 연결하고 browser 완료 후 파일 존재·size/hash·판독을 별도로 검사한다. native 안전 정책과 원본 출처 metadata를 유지한다. [Downloads API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/downloads), [DownloadItem](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/downloads/DownloadItem), [Firefox 출처 metadata](https://firefox-source-docs.mozilla.org/toolkit/components/downloads/index.html).

미지원 uploader·OS 인증은 정확한 Task와 준비 파일을 연결한 사용자 handoff로 전환한다. 비간섭 입력이 검증되지 않으면 공용 입력 사용을 표시하고 자동 병렬 조작을 허용하지 않는다. Playwright의 브라우저 지원을 현재 제품 Firefox profile의 직접 제어 보장으로 사용하지 않는다.

인수 절차는 두 탭 중 A에서 한글 조합, B에서 탐색·popup·download·upload를 수행하는 fixture다. 취소·reload·resize·계정 변경·단절과 조합 종료 직후 Enter를 포함한다. 잘못된 탭 조작·의도치 않은 전송·승인·focus 탈취는 0건이어야 한다. 탐색 복원은 인증·form 저장을 보장하지 않고, 다운로드 완료와 파일 판독을 따로 증명해야 한다. 실패 시 native 사용자 경로와 원 업무의 초안을 유지한다.

상세/확인 화면은 returnTarget stack으로 복귀하며 modal에만 focus trap을 적용한다. compositionstart/end와 `isComposing`을 함께 사용하고 조합을 종료한 keyup까지 command 실행을 막는다. pointer·keyboard 각각 모든 제어 경로를 재현한다. [W3C 포커스 동작](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), [IME 상태](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/isComposing).

##### 탐색 재전송 gate·기존 파일 재사용

`NavigationIntent`는 `targetContext,historyEntry,method/bodyKnown,linkedActionIntent,authorityEpoch,returnTarget`를 기록한다. UI·단축키·script reload·history traversal·session restore 모두 같은 replay 검사를 통과한다. POST 여부나 미확인 효과를 해소할 수 없으면 네트워크 재요청 전에 차단한다. GET이라는 이유만으로 서비스의 부작용 없음까지 보장하지 않는다.

Firefox 참조 commit `6762e79efb6111d51bb58951c1ebdbac886526e7`의 `nsDocShell::LoadHistoryEntry`는 POST reload에서 `ConfirmRepost`를 호출한다. 제안 adapter는 이 재전송 경계 앞에 intent 검사를 연결하고, 네이티브 확인창 수락 뒤 실제 dispatch 직전에도 epoch·일회 permit을 재검사한다. 이 hook의 집행이 검증되지 않은 빌드에서는 미확인 효과가 있는 대상의 자동 재탐색을 제공하지 않는다. [원천 재전송 경계](https://github.com/mozilla-firefox/firefox/blob/6762e79efb6111d51bb58951c1ebdbac886526e7/docshell/base/nsDocShell.cpp#L11456).

네이티브 취소는 navigation 취소이지 업무 intent 취소가 아니다. `[읽기 전용 접수 조회]`는 저장된 POST history를 재사용하지 않는 서비스의 확인 경로를 사용한다. 미확인 intent와 연결되지 않은 새 재시도 ID로 중복 방지를 우회할 수 없다. 재시도 dispatch permit은 `서비스의 미접수 확정 증거 OR 같은 논리 행동의 유효한 멱등 보장`과 기존 권한·epoch 검사를 모두 만족할 때만 발급한다. 접수 성공 증거 자체는 재시도 permit이 아니며 기존 receipt 추적에만 사용한다.

기존 파일 선택 결과는 `FileReuseResult`이며 `DownloadCompletion`과 다르다. `localResourceId,localHash,originalProvenance,requestedSourceRef,equivalenceStatus,evidenceRef`를 기록한다. 동등성은 같은 immutable source revision의 신뢰 가능한 digest 또는 별도로 검증한 실제 응답 byte 비교로만 확정한다. 이름·크기·로컬 hash 단독으로 확정하지 않는다. 새 다운로드의 취소 확인·부분 파일 처리는 별도 receipt다.

인수: POST 응답 유실 뒤 reload/강제 reload/back/복원/native 재전송 수락을 순서대로 주입해 외부 접수 증가 0을 확인한다. `접수됨·처리 중·멱등성 없음`에서는 재시도 비활성·읽기 전용 상태 조회 가능·추가 접수 0을 확인한다. 같은 이름의 다른 byte·동일 byte지만 출처 불명·비교 불가·선택 직후 파일 교체를 검사한다. 재사용을 새 다운로드 완료로 표시하거나 기존 출처 metadata를 덮어쓰는 경우는 0건이어야 한다.

### 17.D 파일·Terminal·저장·동등 입력

<a id="impl-files"></a>
#### 파일 adapter·형식 지원·조건부 저장

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-files)

다음 기술·수치는 설계 기준선이며 실제 설치·성능·지원 완료의 증거가 아니다. 보존기간·출시 형식·최종 편집 약속은 기술 임곗값과 분리한다.

Firefox privileged shell은 `[파일]`에서 OS 선택기를 직접 열고 파일/다중 파일/폴더/저장 mode·취소 결과를 각각 처리한다. renderer에는 임의 경로 권한 대신 범위 제한 resource handle을 전달한다. 공통 `[자료]`는 동일 resource/root registry를 사용한다. 추가 참조는 authority·runtime ownership을 변경하지 않는다. [Mozilla 선택기](https://searchfox.org/firefox-main/source/widget/nsIFilePicker.idl)

선택 기준선은 텍스트 Monaco ESM, PDF PDF.js worker·페이지/text layer, 구조 추출 Apache Tika, 표 주소·수식·캐시값 SheetJS CE, Office 미리보기 격리 LibreOffice 변환→PDF.js다. OCR은 Tika의 Tesseract 연결 경로를 사용한다. reader/viewer는 허용된 로컬 origin에서 실행하며 임의 script·macro·외부 참조 실행·network를 차단한다. [Monaco](https://github.com/microsoft/monaco-editor), [PDF.js](https://mozilla.github.io/pdf.js/examples/), [Tika](https://tika.apache.org/3.2.2/formats.html), [SheetJS](https://docs.sheetjs.com/docs/csf/sheet/), [LibreOffice](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html)

지원 record는 `format, firstSupportCapabilities, finalEditRequirement, currentAdapterCapabilities, verifiedFixtures`다. 내장 Office 분기는 Collabora editor/WOPI host를 시안 resource에 연결하고 callback은 시안만 저장한다. 정본 적용은 별도 조건부 저장이다. WOPI 계열이라는 이유로 lock 보장이 같다고 가정하지 않는다. 내부 완결 약속을 외부 fallback으로 통과 처리하지 않는다. [공식 통합 예제](https://github.com/CollaboraOnline/collabora-online-sdk-examples/blob/master/webapp/README.md)

parser 출력은 `sourceHash, parserVersion, spanMap, extractedHash, coverage, warnings`다. 셀은 화면 행이 아니라 sheet 식별자·물리 주소·source revision에 연결한다. 수식 추출·캐시값을 재계산 검증으로 표시하지 않는다. 읽기 요청의 admission은 Contract §2를 따르고 Reader는 판독, 요청 담당 Agent는 업무 판단을 소유한다.

이름·metadata를 먼저 색인하고 본문은 열기/검색/읽기 요청에 따라 처리한다. FTS5 unicode61/trigram을 기준으로 짧은 검색어는 범위 제한 scan으로 fallback한다. 초기값은 텍스트 8MiB 또는 100,000행 초과 시 256KiB 읽기 보기, PDF 현재±2페이지 렌더, parser 256MiB/30초 단위다. 초과 시 가능한 형식 분할→512MiB 격리 재시도 1회→외부 변환본 연결로 전환하며 미처리 coverage를 숨기지 않는다. [FTS5](https://www.sqlite.org/fts5.html)

저장 입력은 `resourceId, expectedDiskRevision, bufferRevision, bytes, operationId`다. System은 아래 저장 capability를 먼저 확인한다. managedRevisionStore 또는 검증된 strongConditionalReplace에서만 원본 갱신하며, 그 adapter의 권한·잠금·revision·flush·교체·readback 계약을 사용한다. 저장 중 추가 입력은 다른 버퍼 revision으로 남는다. 모두 저장은 파일별 transaction이다. 앱 lease는 외부 앱 미저장 부재를 증명하지 않는다. 단독 쓰기·조건부 갱신이 불확실한 외부 정본은 텍스트와 binary 모두 관리 작업사본·create-only 반출·명시적 원본 앱 저장 경로로 제한한다.

인수 절차: 한글 조합·저장 중 추가 입력·외부 rename/delete/write·잠금·읽기 전용·공간 부족을 주입한다. 버퍼 보존, 이전 파일 무손상, readback 일치, File-first focus를 확인한다. 보호/필터행 workbook의 세 셀 변경은 주소·서식·수식·기존 오류·재열기를 비교한다. 실패 시 정본 쓰기를 막고 사본·차이·재시도를 유지한다.

##### 내부 Office 편집

편집 세션은 `resourceId, mode, baseRevision, draftId, editorGeneration, leaseEpoch, adapterVersion`을 갖는다. System이 원본에서 편집 draft를 준비하고, Firefox는 editor UI를 연다. **editor 서버가 WOPI host의 CheckFileInfo/GetFile을 호출해 draft를 받고 PutFile로 저장한다.** 브라우저의 저장 알림은 저장 증거가 아니다.

기본 배치는 같은 PC의 WOPI host와 로컬 editor engine이다. 지원 native package 또는 격리된 로컬 VM/container를 사용하며 host↔engine 경로를 loopback/vsock broker로 제한한다. VM 내부 캐시도 관리 저장물에 포함한다. 기존에 승인된 원격 engine은 별도 배치 adapter다. 로컬 engine 준비 실패가 외부 배포·업로드를 자동 승인하지 않는다.

인증 token은 draft·editor 서버·세대·허용 operation·만료에 제한한다. host는 매 요청에서 현재 권한과 세대를 검사한다. iframe origin/source, discovery 목적지, callback 발신 engine을 검증한다. token을 URL 로그·event·bundle에 남기지 않는다.

| 저장 profile | 집행 |
|---|---|
| Collabora timestamp profile | CheckFileInfo와 저장 응답에 revision에 대응하는 LastModifiedTime을 제공한다. PutFile의 `X-COOL-WOPI-Timestamp`를 현재 draft와 비교한다. 불일치는 409/1010이며 timestamp 없는 덮어쓰기는 자동 허용하지 않는다 |
| 표준 WOPI lock profile | 실제 지원되는 Lock/RefreshLock/Unlock과 lock 만료를 구현한다. PutFile의 lock 불일치는 409와 규정된 lock 응답이다. Collabora에도 같은 lock 동작이 있다고 가정하지 않는다 |

각 draft의 저장은 단일 writer queue에서 직렬화한다. `(세션, expectedDraftRevision, bodyHash)`로 중복을 판별하고, 검증한 byte와 새 draft revision·receipt를 함께 commit한 뒤 응답한다. 옛 세대·철회된 lease·서로 다른 writer의 요청은 저장하지 않는다. header 없는 충돌 덮어쓰기는 별도 비교 화면에서 새 draft로 해결한다. 상대 파일 생성은 기본 비활성화하고 다른 이름 저장은 System 경로로 처리한다. [Collabora 저장 profile](https://sdk.collaboraonline.com/24.04/CO-SDK-manual.pdf), [WOPI PutFile](https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/rest/files/putfile)

형식별 record에 `firstCapabilities, finalRequirement, editModel, nativeWriter, preservedFeatures, unsupportedFeatures, fixtureSet`을 둔다. 채택 조건은 요청한 편집·부분 변경·원형 재저장·미변경 구조 보존의 fixture 통과다. 보기/parser 지원만으로 편집을 등록하지 않는다. OOXML/ODF는 Collabora와 구조화 편집 adapter를, 나머지는 동일 조건을 충족하는 native-format adapter를 선택한다. 지원하지 않는 기능은 명명한다.

**미실행 인수 조건:** 정상 입력→PutFile→재열기, 중복·역순 요청, token 만료, 누락 timestamp, engine 중단을 검사한다. 원본 미승격·옛 callback 쓰기 0, 원형 구조 보존과 내부 대체 편집의 실제 변경·반출을 대조한다.

##### 모든 형식의 저장 capability

저장 adapter는 형식과 무관하게 다음 능력을 선언한다.

| 능력 | 정상 저장 |
|---|---|
| `managedRevisionStore` | System만 갱신하는 논리 원본 head를 expected revision과 같은 transaction에서 변경 |
| `strongConditionalReplace` | provider의 강한 revision 조건 또는 대상·경로 변경까지 배제하는 실제 exclusive operation으로 교체 |
| `createOnly` | 기존 목적지를 교체하지 않는 새 파일 생성 |
| `uncoordinatedExternal` | 원본 교체 금지; 관리 작업사본 저장과 명시적 새 파일 반출 제공 |

앱 lease·advisory lock·hash 재검사·일반 rename은 임의의 비협조적 외부 writer에 대한 조건부 저장 보장이 아니다. external adapter의 능력은 backend·OS·filesystem별 계약과 경합 fixture로 등록한다. 능력이 없거나 상실되면 **모든 형식**에 동일한 안전 사본 경로를 적용한다.

외부 변경 알림은 FSEvents/ReadDirectoryChangesW/inotify를 재조회 신호로 사용한다. 활성화·저장·재시도 때 handle identity와 revision을 다시 읽고, 알림 유실 시 주기적 stat 후 변경 의심 대상을 hash한다. 알림은 잠금이 아니다. 원본을 추적할 수 없으면 버퍼를 유지하고 위치 재연결을 제공한다.

**미실행 인수 조건:** 모든 형식에서 검사 직후 외부 write/rename/delete를 주입한다. managed 저장은 정상 성공하고, 조건 없는 external 교체는 0건이며 사용자의 최신 버퍼가 남아야 한다.

##### 저장 모드와 제어 의미

| 편집 모드 | 저장/단축키의 대상 | 별도 수락 |
|---|---|---|
| 관리 원본 직접 편집 | `[저장]`, Cmd/Ctrl+S가 현재 원본 head를 조건부 갱신 | 없음 |
| 제안·시안 | `[사본 저장]`, 같은 키가 draft revision 저장 | 원본에 선택 변경을 넣을 때만 |
| 안전성이 확인된 외부 adapter | `[원본 저장]`, 같은 키가 해당 adapter 저장 | 일반 직접 편집에는 없음 |
| 조건 없는 외부 파일 | `[작업사본 저장]`, 같은 키가 관리 사본 저장; 외부 원본 불변 | 사본 저장에는 없음 |

`수락`은 선택 제안을 작업 버퍼/pending namespace에 적용하며 저장이나 실행 재개가 아니다. `저장` 자체도 검토 승인·사실 검증이 아니다.

저장은 `dirty→saving(r)→saved(r)/failed(r)`이며 저장 중 새 입력은 r+1의 dirty 상태로 남긴다. 확인증은 mode·실제 대상·저장 revision/hash·원본 반영 여부를 표시한다. 모두 저장은 해당 File의 수정 버퍼와 pending operation만 고정하고 대상별 결과를 남긴다.

다른 이름 저장은 새 resource 생성이며 기존 목적지에는 저장 capability를 다시 적용한다. OS 덮어쓰기 확인은 조건부 저장 증거가 아니다. 성공하면 활성 버퍼를 새 resource에 연결하되 원본 disk와 다른 버퍼는 변경하지 않는다.

**미실행 인수 조건:** 네 모드에서 직접 입력→저장, 시안 저장→선택 수락→원본 저장, 저장 중 추가 입력·실패·IME·모두 저장 일부 실패를 검사한다. 일반 직접 저장의 불필요한 수락 0, 사본 저장의 원본 변경 0, 저장 revision 오표시 0이어야 한다.

<a id="impl-changes"></a>
#### 변경 적용과 검사 증거

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-changes)

변경 집합은 `author, baseHash, currentBufferRevision, proposedHash, exactWriteSet, disposition, operationId`를 가진다. System은 3-way 비교와 적용 직전 expected revision 검사를 수행한다. 수락은 undo 가능한 버퍼 transaction, 거부는 미적용 제안 상태, 되돌리기는 최신 버퍼에 대조한 역변경이다. 이미 적용한 사람/Agent 변경을 이중 적용하지 않는다.

검사 입력은 저장본/격리 사본의 닫힌 manifest, argv/cwd, PC·도구/환경·권한·기대 결과다. System이 실행·증거를 연결하며 모델은 요청된 검토·원인 추론만 수행한다. 결과에는 exit·로그 hash·위치·포함/제외·기존/새 실패·취소를 기록한다. 입력 hash 변경은 stale로 처리한다.

필수 검사는 변경 유형에 연결한다. 코드에는 구문/정적 검사·영향 테스트, 경로 이관에는 move manifest·고정 경로·참조/build boundary, 문서/표에는 구조·렌더·지정 범위·업무 불변식을 적용한다. 검사 부재는 `저장 확인·기능 검증 없음`이지 전체 완료가 아니다. Git local/tracking/실제 remote branch SHA와 조회 시각을 구별하고 배포 결과로 확대하지 않는다. [Git 원격 조회](https://git-scm.com/docs/git-ls-remote)

인수 절차: 세 묶음 중 하나 수락→다른 writer 수정→나머지 적용→역변경→저장 실패→재진입을 수행한다. 선택 밖 변경·이중 적용 0과 양쪽 내용 보존을 확인한다. 기존/새 실패 fixture와 검사 후 입력 수정에서 구분·stale 표시를 확인한다. 계산·적용 실패는 원 revision과 원문을 남기며 자동 덮어쓰지 않는다.

##### 검사 baseline과 실패 분류

`CheckSpec`은 argv/cwd, 입력·기준 manifest, 도구/환경 fingerprint, 기대 exit/assertion, 포함/제외, 위치 mapping을 가진다. System이 명세대로 실행·비교하고 Agent의 원인 해석은 별도 필드다.

기존 실패는 동등 환경의 baseline 진단과 tool/rule code·source identity·범위 anchor·발생 수가 대응할 때만 판정한다. 경로 이동은 move manifest로 대응한다. baseline 부재·환경 변경·모호한 대응은 `신규 여부 미확인`이다. 기존 실패가 있다는 이유로 실제 실패 exit를 통과로 바꾸지 않는다.

**미실행 인수 조건:** `새 실패 / 기존 실패 / 분류 불가 / 전체`를 제공하고 baseline revision·환경 차이를 펼칠 수 있게 한다. 기준 검사도 등록된 권한·명령 안에서 수행한다. 기존 syntax failure, 새 회귀, 이동된 동일 오류, 보호 workbook의 세 셀 변경·기존 오류를 검사한다. 선택 검사 성공을 전체 코드·업무 정확성이나 배포 완료로 확대하지 않는다.

##### namespace 변경은 저장까지 pending

`NamespaceOp(create/rename/delete)`는 source handle, 이전/새 경로, expected source/target/parent revision, 의존 operation, 작성자와 operation ID를 가진다.

제안 수락은 `accepted-pending-save`, 직접 요청은 `direct-pending-save`다. 이 단계에서는 filesystem을 변경하지 않는다. 관리 namespace는 준비된 object와 논리 경로/head를 하나의 DB transaction에서 적용한다. 외부 namespace는 저장 capability 계약의 실제 조건부/exclusive capability를 사용하며 여러 filesystem 작업을 하나의 원자 transaction이라고 하지 않는다.

cross-volume은 목적지 create-only→검증→조건부 원본 삭제 순서다. 원본 삭제 능력이 없거나 실패하면 `사본 생성됨·이동 미완료`다. 각 단계 receipt와 현재 상태로 재시도한다. 역변경도 현재 revision/경로 점유를 검사한 새 pending operation이다.

**미실행 인수 조건:** 트리에 `이동 예정/삭제 예정/생성 예정`과 변경 수를 표시한다. `[저장]` 전 취소는 pending만 제거한다. 필요한 의존 항목은 범위를 먼저 보여 준다. 여러 root·경로 재점유·cross-volume·부분 실패·응답 유실에서 대상 밖 변경 0과 원본 보존을 검사한다.

<a id="impl-terminal"></a>
#### PTY 소유·역압력·재연결

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-terminal)

기준선은 독립 supervisor+portable-pty, renderer xterm.js다. gateway·transport·renderer와 PTY master 수명을 분리한다. `readOutput/attach/claimInput/write/resize/detach/terminate`는 별도 operation이다. 선택·복사·관찰에는 write handler를 연결하지 않고 `disableStdin`과 서버 입력권 검사를 함께 적용한다. [portable-pty](https://docs.rs/portable-pty/latest/portable_pty/), [xterm 옵션](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/)

**Firefox 로컬 구현과 구분:** 현재의 유지 기능은 독립 supervisor의 증명이 아니다. 같은 Desk 창의 소유 범위와 브리지 인스턴스에 묶인 로컬 PTY만 8개/각 10분 한도에서 유지한다. 브리지가 확인한 실제 세션에만 수동으로 재접속하며 자동 실행·입력 재생을 하지 않는다. Desk 복원은 배치만 기록한다. 종료 요청 접수, 전송 단절, 사용 불가와 실제 프로세스 exit는 서로 다른 상태다.

`resourceReferences`와 `runtimeOwnerSet`은 별도 관계다. 참조 추가·View 생성·고정·관찰 attach는 owner set을 쓰지 않는다. 공동 유지가 허용된 정책의 명시적 operation만 owner를 추가한다. Board 닫기는 마지막 실제 owner 제거에 따라 종료하며 참조 수로 판단하지 않는다.

실행 identity는 `deviceKeyId, bootId, supervisorEpoch, runtimeId, pid, processStartTime`이다. 인증된 supervisor·새 challenge·출력 sequence를 대조한 뒤에만 same-process를 표시한다. gateway가 죽어도 supervisor가 살아 있으면 재연결; PTY owner가 죽었으면 snapshot-only/unknown이다. 임의 PID를 새 helper에 붙인 것으로 복원을 주장하지 않는다.

출력 정본은 sequence spool이다. 초기 frame 32KiB, renderer 미확인 출력 상한/재개 256/64KiB, spool 기록 queue 4/1MiB다. xterm write callback 뒤 ACK하며 느린/분리된 subscriber는 spool 재생으로 전환한다. renderer 부재만으로 process를 멈추지 않는다. 저장 queue에는 PTY 읽기 역압력을 적용하고 공간 부족은 출력 저장 대기로 표시한다. OSC clipboard·자동 링크 실행은 금지한다. [역압력](https://xtermjs.org/docs/guides/flowcontrol/)

종료는 소유 범위의 process group에 요청하고 exit·마지막 sequence를 기록한다. 5초 미확인은 종료 미확인으로 남기며 강제 종료는 별도 확인이다. 늦은 출력은 중지 세대와 대조하고 새 실행을 만들지 않는다.

Codex Agent는 Engine Profile별 격리 App Server를 사용한다. 로컬 stdio JSONL·`initialize/initialized`, ChatGPT managed login, `account/read`·plan·rate limits를 확인한다. 정상 조정은 `turn/steer`의 expectedTurnId로 전달하고 실제 다음 입력 반영을 별도 기록한다. active turn이 없으면 같은 업무의 다음 호출에 포함하며 forced pause/fork를 만들지 않는다. paid API SDK로 대체하지 않는다. Agent-room 관계와 provider thread·Run·PTY identity도 분리한다. [공식 App Server](https://learn.chatgpt.com/docs/app-server)

인수 절차: 출력 폭주 중 선택/복사→renderer 닫기→gateway 재시작→동일 supervisor 연결→supervisor 종료→PID 재사용→원격 종료 응답 유실을 주입한다. stdin 0, sequence 누락/중복 식별, same/new/snapshot 구분, Canvas 발견 가능성을 확인한다. 다른 Board의 참조만 추가한 경우 원 owner 닫기가 종료를 막지 않아야 한다. 실패 시 입력 차단·읽기 전용 spool·새 세션 경로를 유지한다.

##### process 집합과 detach

`RuntimeProcessSet`은 runtime/boot/controller generation, 실제 OS, containment 종류, 소유 집합, process 식별·시작시각을 기록한다. PTY master와 집합 controller는 renderer/gateway 밖 supervisor가 소유한다.

POSIX는 독립 session과 관리 process group을 생성하고 group별 guardian을 유지한다. 관리 분리 실행은 broker spawn으로 새 group과 소유 관계를 등록한다. Linux의 완전 containment는 전용 cgroup v2와 종료 시 cgroup kill을 사용한다. native session/group만으로 임의 daemon 탈출까지 보장하지 않는다. 그 보장이 필요한 OS-독립 작업은 준비된 로컬 전용 VM containment로 실행하고 실제 guest OS를 표시한다. native OS가 필수이면 조용히 VM으로 바꾸지 않는다.

Windows는 suspended process 생성→Job Object 배정→resume 순서다. breakaway를 허용하지 않고 supervisor가 job handle과 KILL_ON_JOB_CLOSE를 소유한다. 종료는 정상 종료 요청 뒤 필요 시 TerminateJobObject, active process 수와 process exit를 재조회한다. 알림 부재를 종료 증거로 쓰지 않는다. [Job Object 계약](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

View/transport detach는 controller·PTY·process 집합을 종료하지 않는다. 마지막 실제 owner 제거만 종료를 시작한다. 5초 미확인은 `종료 미확인`이며 강제 종료는 별도 행동이다. containment 밖 실행이 확인되거나 범위를 입증하지 못하면 관련 Canvas node와 닫기 대기를 남긴다.

**미실행 인수 조건:** foreground·background·분리 child, supervisor/gateway 유실, Job 배정 실패, 두 owner 중 하나 닫기를 검사한다. 확인된 집합 전체 종료와 다른 owner 실행 보존을 각각 입증한다.

##### 사람 View lease와 관찰 resize

사람 입력 lease는 `viewId, deviceSession, runtimeGeneration, inputEpoch`에 결합하고 Agent 실행 lease와 분리한다. `[입력 시작]` 또는 허용된 인계 완료 전에는 stdin을 전송하지 않는다. Agent에서 사람으로의 인계는 이전 writer의 입력 중단 확인 후 새 epoch를 발급하며 Run 자체를 종료하지 않는다.

View 닫기·detach는 사람 lease를 해제하고 로컬 송신을 즉시 차단한다. host는 현재 epoch를 매 입력에서 검사한다. 현재 입력 lease TTL을 넘긴 요청은 거부한다. 원격 해제 ACK가 없으면 `입력권 해제 미확인`이며 이미 접수된 입력의 취소를 주장하지 않는다.

관찰 renderer의 fit/resize는 로컬 표시만 바꾼다. 실제 PTY 행/열 변경은 현재 제어 lease의 명시적 resize operation만 허용한다. 카메라 이동은 PTY를 바꾸지 않는다.

**미실행 인수 조건:** 입력권 취득→닫기→늦은 입력, Agent 세션 관찰→복사→resize를 검사한다. 옛 epoch stdin과 관찰자 PTY 변경은 0이다.

<a id="impl-storage"></a>
#### SQLite/CAS·독립 보관 정책·초기화

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-reset)

로컬 기준선은 SQLite WAL+SHA-256 CAS다. 같은 권한 영역의 같은 text/binary byte는 dedup하되 raw·실제 전달 packet·preview·artifact의 role/lineage를 합치지 않는다. 서로 다른 권한/암호화 영역에 전역 dedup을 적용해 존재를 노출하지 않는다.

기록은 임시 object→length/hash·flush→CAS publish→SQLite manifest/event/reference transaction 순서다. object 없는 DB 참조를 만들지 않는다. crash orphan은 격리하고 누락 참조는 실패로 표시한다. filesystem 저장 intent journal은 교체 후 DB commit 전 crash에서 실제 hash로 완료/충돌을 판정한다.

WAL은 로컬 디스크에서 사용한다. 초기 checkpoint는 1,000page 또는 WAL 64MiB에서 PASSIVE로 시도하며 장기 reader는 짧은 query로 나눈다. migration은 일관된 backup·object pin→격리 DB 변환→schema/foreign-key/integrity/대표 reference 검사→활성 포인터 전환이다. 실패하면 이전 DB/CAS를 유지한다. DB 파일만 복사해 완전한 backup이라고 하지 않는다. [WAL](https://www.sqlite.org/wal.html), [Backup API](https://www.sqlite.org/backup.html)

초기 운용값은 preview/index cache 512MiB LRU, 비선택 renderer 60초 후 분리다. IME·미보존 버퍼·활성 입력권은 제외하고 Canvas 표현은 남긴다. object 10GiB에서 용량 안내, 여유 공간이 `max(1GiB, volume 5%)` 미만이면 큰 신규 수집을 제한한다. 이는 보존기간이나 제품 지원 상한의 결정이 아니다.

GC는 활성 Run·Saved Board·Answer/Briefing·고정·export/migration·복구/백업 pin을 mark한다. 미참조여도 승인된 보존기한 뒤에만 sweep하고 정책 미정이면 자동 삭제하지 않는다. crash orphan은 최소 24시간 격리 후 재검사한다. 공유 hash의 다른 유효 참조가 남으면 물리 삭제 미완료를 표시한다. 가림은 파생본이며 기존 byte를 바꾸지 않는다. 명시 삭제·원문/packet 연동·권한 철회 후 열람은 해당 정책과 강제 조건을 따른다.

`extraOriginalCapturePolicy, formRestorePolicy, bundleIncludePolicy, resetRecoveryPolicy, resetBackupPolicy`를 독립 저장한다. 추가 원문 수집은 고정 관계 집합·권한 revision에 묶으며 필수 과거 근거와 구별한다.

form은 resource·origin/frame origin·업무 계정·form fingerprint·안정 필드 ID/type·허용값·revision에 연결한다. capture 전 allowlist/비밀 차단, 복원 전 현재값·계정·구조 대조를 수행한다. `autocomplete=off`를 credential 제외 보장으로 사용하지 않는다. 부수효과 없는 적용을 확인하지 못하면 값 복사로 fallback한다. [MDN autocomplete](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/autocomplete)

초기화는 frozen IDs·actionId·revision에 묶고 후속 입력 admission·로컬 인증 사용 차단→종속 실행 중지→기록·색인·Reader cache·참조 정리 순서다. provider 전달분 회수·철회는 별도 상태다. 최소 처리 기록에는 본문 대신 수량·상태·불투명 참조를 남긴다. 복구 scope·백업 scope·검증 확인증·live deletion write-set은 별도이며 자동 백업 실패 시 삭제 commit을 열지 않는다.

인수 절차: CAS/DB 각 경계·migration 전환에 crash를 주입해 참조 무결성·이전 저장소 복귀·중복 event 0을 확인한다. 보관 2×bundle 2 조합에서 권한 밖 수집/반출 0과 정책 간 값 변경 0을 확인한다. 초기화 2×백업 2 조합에 부분 실패·만료·늦은 packet·오프라인 PC를 넣어 credential 복구 0, 새 입력 제외, 자동 백업 실패 시 삭제 0을 확인한다. form의 password/OTP/계정 변경/구조 변경/취소에는 비밀 보관·오적용·복원발 제출 0이어야 한다. 실패 저장소는 보존한 읽기 전용 복구 모드로 연다.

##### CAS 게시와 GC

관리 writer·GC·migration은 동일 `storageGate`와 store generation을 사용한다. 이 잠금은 관리 저장소 참여자 간 조정이며 외부 filesystem 공격까지 막는다는 뜻이 아니다.

1. 등록된 staging에 기록하고 길이/hash를 검증한다.
2. gate 안에서 operation별 pending pin을 durable하게 기록한다.
3. 기존 hash는 byte를 검증해 재사용한다. 신규 hash는 **no-replace** 원자 게시를 사용한다.
4. POSIX는 파일 fsync→게시→대상 부모 디렉터리 fsync를 완료한다. Windows는 FlushFileBuffers와 동일-volume no-replace/write-through 경로를 사용하되 namespace 내구성까지 제공하는 adapter에서만 durable 게시로 인정한다.
5. 게시 증거 뒤 DB transaction에서 manifest·head·event·receipt를 commit하고 pending pin을 유효 참조로 전환한다.

디렉터리 내구성 계약을 제공하지 못하는 backend는 `sqlite-chunk CAS`를 사용한다. 불변 payload를 4MiB 이하 chunk와 hash manifest로 저장하고 참조와 같은 SQLite transaction에서 commit한다. 이때 filesystem 사본은 정본이 아닌 등록된 cache다. 두 backend는 같은 object hash와 export 의미를 갖는다. [Windows 이동 계약](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)

GC는 mark 세대 이후 생성·갱신된 pin을 보호한다. sweep 직전 같은 gate에서 현재 참조·pending pin·read lease·삭제 정책을 재검사한다. 재사용되는 옛 hash도 새 pin을 먼저 얻는다. 삭제 의도→unlink→디렉터리 동기화→receipt 순으로 기록한다. crash orphan은 활성 참조로 노출하지 않는다.

**미실행 인수 조건:** 동일 hash 재사용과 sweep, 게시 각 경계의 crash, fsync 실패, DB commit 실패를 교차한다. committed 참조의 byte 유실·이중 event 0, 이전 head 또는 검증된 새 head만 허용한다.

##### 운영 저장물 삭제와 포렌식 구분

삭제 manifest는 대상 DB 본문·검색 텍스트·FTS·CAS·WAL/임시 DB·관리형 복구 사본·등록 staging을 열거한다. 사용자 보호 백업·공유 참조·외부 원본의 포함 여부는 기존 정책과 명시 범위대로 표시한다.

`fenced → rewriting → cleanupPending → managedEraseComplete`를 사용한다. 먼저 삭제 epoch를 복구 제어 기록에 남기고 대상의 읽기·새 입력·복제·복구를 차단한다. 살아남는 허용 행으로 새 DB를 구성하고 FTS는 해당 행에서 재생성한다. 이전 FTS shadow table과 freelist를 복사하지 않는다. 재작성 중 유효 변경은 cursor 이후 delta로 반영하고, 짧은 gate에서 최종 head를 맞춰 전환한다.

이전 generation의 관리 read handle을 닫고 DB/WAL/임시 파일·무참조 CAS·대상 포함 복구 사본을 정리한다. 암호화 사본은 삭제 대상 없는 새 사본과 새 키로 재작성한 뒤 이전 key와 모든 관리 wrapping을 폐기한다. 공유 키 하나를 지워 무관한 자료까지 삭제하지 않는다.

완료 조건은 **선택 범위의 관리 저장물에서 조회·재입력·복구가 불가능하고, 필요한 재작성·파일/키 정리 receipt가 모두 확인됨**이다. 유효 공유 참조나 보존 예외가 남으면 물리 정리 완료로 표시하지 않는다. 이것은 SSD 잔존 block, OS snapshot, 외부 backup의 포렌식 복구 불가능성 보장이 아니다.

**미실행 인수 조건:** fixture 본문을 DB/WAL/FTS/CAS/각 관리 사본에 넣고 삭제·crash·복구를 수행한다. 남은 사본이 있으면 완료 0, 최신 삭제 epoch를 잃은 복원은 차단한다.

##### 초기화 되돌리기

기한부 복구는 삭제 전에 `RecoveryManifest(resetId, scopeIds, oldHeads, payloadPins, deletionEpoch, postResetVersions, expiresAt, authorityRef, exclusions)`를 만든다. credential·실행권·예약 활성 상태는 복구 내용에서 제외한다. 자동 보호 백업은 별도 manifest와 수명이다.

Undo는 reset ID·현재 삭제 epoch·만료·권한을 transaction에서 확인한다. 이후 별도 삭제가 있거나 만료 판정이 불확실하면 적용하지 않는다. 현재 상태가 post-reset version과 같으면 같은 논리 ID에 **새 복구 revision**을 발행한다. 이후 변경이 있으면 현재 유지/선택 복구/허용된 새 사본으로 해결한다. 삭제 tombstone을 지우지 않고 이를 대상으로 한 명시적 복구 event를 기록한다.

만료와 복구 commit은 같은 gate에서 단일 승자를 갖는다. 적용 전 취소는 무변경, 적용 뒤 중지는 미처리 항목만 대상으로 한다. 항목별 operation receipt로 재시도하며 이후 편집을 덮지 않는다.

**미실행 인수 조건:** 정상 복구, 이후 편집·재삭제, 만료 경합, 일부 실패·응답 유실을 검사한다. credential·예약·실행 자동 활성화와 타인 후속 변경 손실은 0이다.

<a id="impl-portable"></a>
#### 안전한 bundle·transactional import·동기화

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-portable)

컨테이너 기준선은 ZIP64이며 `manifest.json, events.jsonl, transcript/README, objects/<hash>`를 담는다. libarchive 순차 entry API로 허용 항목만 처리하고 경로를 그대로 추출하지 않는다. 절대경로·상위 탈출·link·중복 이름·특수 파일·중첩 자동 실행을 거부한다. 초기 예산은 100,000entry·펼친 크기 10GiB·압축비 100:1이다. 초과 정상 자료는 자원량을 표시한 큰 묶음 검사로 전환하되 staging은 여유 공간 절반 이내이며 안전 검사는 완화하지 않는다. [libarchive](https://github.com/libarchive/libarchive/wiki/Examples)

암호화 기준선은 Argon2id v1.3·무작위 salt·64MiB/3회 KDF와 libsodium secretstream XChaCha20-Poly1305다. 1MiB chunk·인증된 version/KDF header·FINAL tag를 사용한다. import KDF 상한 256MiB/6회, 암호 사용 후 제거, 평문 bundle 선행 디스크 생성 금지를 적용한다. 자동 보호 사본도 준비된 보호 수단·목적지가 없으면 설정/재시도로 돌아간다. [키 도출](https://libsodium.gitbook.io/doc/password_hashing/default_phf), [secretstream](https://libsodium.gitbook.io/doc/secret-key_cryptography/secretstream)

credential 저장소는 export schema 밖이다. Profile은 비밀 아닌 allowlist만, 경로는 portable root 별칭만 보낸다. 원문 속 비밀/민감 경로는 제외·허용된 가림본으로 처리하고 원 byte를 몰래 수정하지 않는다. 검출기 통과를 모든 비밀 부재의 증명으로 표시하지 않는다.

export는 cache 전체가 아니라 root+포함 정책으로 집합을 계산하고 object pin·일관된 event 경계·hash 검사→생성·재검증→atomic publish한다. 보관 권한과 반출 권한을 따로 검사한다.

import는 격리 staging→version/schema/hash/필수 object/권한 검사→conflict plan→transaction→대표 reference 재열기다. 같은 event ID의 다른 내용은 자동 병합하지 않는다. 새 사본은 ID remap/lineage, 병합은 base revision, 교체는 이전 revision을 보존한다. rollback은 import write-set의 현재 revision을 재확인한다. 알 수 없는 major/필수 feature는 무변경 거부하고 선택 metadata는 실행하지 않고 보존한다.

승인된 동기화는 DB 파일이 아니라 event·manifest·암호화 object를 인증된 HTTPS로 전달한다. device/event ID로 중복 제거, base revision·조건부 쓰기로 충돌 검출, 다른 필드는 3-way merge, 같은 필드는 충돌로 남긴다. timestamp만으로 승자를 정하지 않는다. 기기 제거는 grant/키 세대를 갱신한다. credential·실행 명령·focus·임의 Browser 상태는 자동 재생하지 않는다. 정책 선택과 실제 endpoint·신원·비용·전송 집행 승인을 구별한다. [조건부 갱신](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match)

인수 절차: 잘못된 암호·절단·누락 object·경로 탈출·용량 초과·새 major·import 중 crash를 주입한다. 원 Desk 무변경 또는 검증된 transaction만 허용하고 이후 편집을 rollback으로 지우지 않는다. 두 기기의 오프라인 수정·삭제·제거를 재연결해 충돌·재유입 차단·중복 실행 0을 확인한다. 실패 staging은 활성화하지 않고 원 묶음·이전 revision·정확한 재시도 범위를 유지한다.

##### 동기화 envelope와 키 수명

협업 계약의 현재 person/device 인증·grant·transport 위에서 `SyncEnvelopeV1`을 사용한다. envelope는 opaque object ID, scope, event/device sequence, base revision, grant/key epoch, cipher hash와 recipient 집합을 가진다. 원문 hash와 민감 metadata는 암호화 manifest 안에 둔다.

객체마다 무작위 256-bit DEK와 secretstream XChaCha20-Poly1305를 사용하고, DEK는 허용 기기의 X25519 공개키별 sealed envelope로 감싼다. 송신 사건과 권위 manifest는 등록된 signing key로 서명한다. 개인키·token은 보호 저장소에만 둔다. 업무/AI 계정 credential을 envelope에 넣지 않는다. [secretstream](https://libsodium.gitbook.io/doc/secret-key_cryptography/secretstream)

기기 제거는 grant epoch를 먼저 올리고 새 업로드·다운로드·key wrapping을 차단한다. 이후 객체/version은 새 epoch의 DEK를 사용하며 옛 DEK를 재사용하지 않는다. 이미 받은 키와 사본은 회수했다고 주장하지 않는다.

키 복구는 현재 권한이 있는 기존 기기의 재wrapping 또는 사전에 구성한 암호화 recovery envelope만 사용한다. 둘 다 없으면 ciphertext를 보존하고 복호화 불가를 표시한다. 새 키 발급만으로 옛 데이터를 복구했다고 하지 않는다.

오프라인 event는 재연결 후 현재 epoch와 base revision을 검사한다. 비충돌 변경만 병합하고 같은 필드는 기존 공동/소유자 해결 정책을 따른다. 삭제와 경합한 수정은 자동 부활시키지 않는다. migration은 envelope version별 변환·hash 검증·새 manifest commit이며 옛 epoch를 활성화하지 않는다.

**미실행 인수 조건:** `동기화 대기 / 충돌 / 키 확인 필요 / 제거된 기기`와 `[현재 상태 확인] [키 복구] [허용된 로컬 작업 계속]`을 제공한다. 제거·오프라인 수정·키 유실·복원·ACK 유실에서 정상 기기 동기화, 옛 epoch 거부, 중복 commit/실행 0을 검사한다. 미승인 원격 분기만 대기한다.

##### archive 예산과 취소

기본 예산은 100,000 entry·10GiB 전개량·100:1 압축비·10분이다. 큰 묶음은 최대 1,000,000 entry·`min(100GiB, 시작 여유공간/2)`·1000:1·30분까지 명시적으로 조정한다. 두 경로 모두 worker RSS 512MiB, streaming 실제 byte 계수, 정수 overflow 검사와 독립 취소를 적용한다. 이는 검사 attempt 예산이지 Run 종료 한도가 아니다.

경로 탈출·link/특수 파일·정규화 후 중복·자동 중첩 추출 금지는 완화하지 않는다. KDF는 기존 256MiB/6회 상한을 **할당 전** 검사하고 crypto header는 16KiB 이하, chunk는 1MiB로 제한한다. FINAL 및 전체 archive 검증 전에는 활성화하지 않는다. 자기 export가 압축비 한도를 넘으면 해당 entry를 비압축 저장한다.

**미실행 인수 조건:** 초과 시 실제 사용량과 `[분할] [큰 묶음 검사] [취소]`를 표시한다. 확대는 `[큰 묶음 검사]→[검사 시작]` 2클릭이며 자동 승격하지 않는다. 취소는 worker 중지·등록 staging 정리 후 확인한다. 대량 작은 entry·과대 header·절단·취소/게시 경합에서 예산 우회와 부분 활성화 0을 검사한다.

##### 암호화 staging registry

모든 임시 복사본은 생성 전에 `opId, 목적, sourceRefs, 관리 위치, bytes, state, keyRef, lease/pin, cancel/deleteEpoch, deadline`으로 등록한다. import/export 임시물뿐 아니라 외부 편집 사본·editor cache·VM scratch도 포함한다. 원본 bundle과 완성 목적지는 임시물로 등록하지 않는다.

staging은 선택한 최종 bundle의 평문/암호화 정책과 무관하게 암호화한다. 작업 key는 기본 메모리에만 두며 비밀을 event나 일반 DB에 저장하지 않는다. parser에는 bounded 메모리 stream을, 파일 접근이 필요한 editor에는 작업 전용 암호화 scratch volume을 제공한다. 기록 가능한 다른 cache 위치는 차단한다.

`writing→validating→ready→committing→published→cleanup`을 사용한다. 실패·취소는 활성화하지 않고 정리한다. key 소실 시 원본에서 다시 검사하며 숨은 복구 사본을 만들지 않는다. 종료·취소 직후 정리를 시도하고 handle/삭제 실패는 `cleanupPending`으로 다음 시작과 주기적 reaper에서 재시도한다. 활성 attempt도 archive 검사 deadline을 넘겨 무기한 남지 않는다.

publish와 취소 fence는 같은 gate에서 판정한다. publish가 먼저 완료됐으면 완성 파일을 취소로 삭제하지 않는다. 정리기는 검증된 registry 위치만 처리하고 원본·무관한 파일을 확장 탐색해 지우지 않는다.

**미실행 인수 조건:** 암호화/평문 bundle 각각에서 실패·crash·취소·완료를 검사한다. staging의 검색·새 모델 입력·자동 backup 유입 0, 미등록 사본 0, 정리 실패의 가시성을 확인한다.

<a id="impl-input"></a>
#### 입력 소유권·focus·접근성 인수

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-input)

pointer/keyboard는 같은 `actionId, targetId, expectedRevision, originControl, inputOwner`를 사용한다. System은 rendering/focus/persistence/상태 안내를, 모델은 명시 요청의 추론을 수행한다. focus 이동·자료 선택은 실행 요청이 아니다.

Chat/Canvas의 두 손가락 입력은 [콘텐츠 활성 경계](#impl-view)를 따라 분배한다. pointer가 놓인 View, 배치 선택 또는 키보드 focus만으로 콘텐츠 활성·Agent lease를 덮어쓰지 않는다. UI의 활성 표시와 실제 입력 분배는 같은 상태를 사용하고, 이번 사용자 동작을 모델의 추가 판단이나 API 요청으로 바꾸지 않는다.

focus-return stack은 업무/resource identity로 위치를 검증한다. modal의 이름·초기 focus·Tab 순환·취소, tree/grid의 focus/선택 분리를 적용한다. native 취소·늦은 callback은 요청 세대와 대조한다. resource 재마운트에 caret·selection·focus를 전달하지 않는다. [WAI dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), [tree](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/), [grid](https://www.w3.org/WAI/ARIA/apg/patterns/grid/)

IME는 compositionstart/end·isComposing·keydown/keyup 세대를 함께 추적한다. 조합 확정과 동일 키 동작에서는 전송하지 않고 다음 별도 입력을 요구한다. resource 전용 키는 소유 영역에서만 처리하고 비활성 행동은 사유·대체 경로를 제공한다. 진행 안내는 초당 최대 1회로 묶고 오류/입력권 변화는 별도 알리되 focus를 빼앗지 않는다. [IME 상태](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/isComposing)

지원 record는 OS/build/architecture·AT/version/mode·Firefox/renderer version·locale/IME·배율·trace·결과·fallback이다. VoiceOver/NVDA/Orca 공식 지원은 EG-Desk의 통과 증거가 아니다. [VoiceOver](https://support.apple.com/guide/voiceover/welcome/mac), [NVDA](https://download.nvaccess.org/documentation/en/userGuide.html), [Orca](https://help.gnome.org/orca/introduction.html)

초기 시험 계획은 OS 조합당 AT 켬/끔 2×한국어/영어 2×기본/200%/320px reflow 3×핵심 흐름 6=72개 조합 경로다. 이는 실측 시간이나 통과 건수가 아니다. AA 목표는 해당 A/AA 기준·전체 과정·접근성 지원 방식까지 검사하며 일부 수치나 대표 화면만으로 선언하지 않는다. 비웹 shell의 WCAG2ICT는 해석 지침이지 인증 보장이 아니다. [WCAG](https://www.w3.org/TR/WCAG22/#conformance-reqs), [WCAG2ICT](https://www.w3.org/TR/wcag2ict-22/)

인수 절차: Board 30개·자료 20개·활동 3개·경고 2개·긴 이름에서 여섯 흐름을 키보드와 드래그 없는 클릭으로 수행한다. IME 중 저장/전송/Esc, 원 target 삭제, native 취소, Terminal 선택, 확대·모션 감소를 포함한다. 오전송·다른 업무 focus·선택만으로 실행은 0이고 같은 대상·결과에 도달해야 한다. 실패 renderer는 같은 행동의 접근 가능한 대체 표면으로 전환한다. 읽기만 가능한 fallback으로 편집 약속을 통과 처리하지 않는다.

##### 실제 편집 가능한 접근성 대체 표면

기본 renderer와 대체 renderer는 동일 buffer·change-set·save/export action을 사용한다.

| 대상 | 실제 대체 조작 |
|---|---|
| 텍스트/코드 | 이름 붙은 native textarea 또는 행 단위 편집기. 큰 파일은 encoding 경계가 검증된 범위 patch로 편집 |
| CSV·표 | sheet/물리 주소·값·수식 필드를 가진 DOM 표/폼. 정렬된 화면 행을 쓰기 주소로 사용하지 않음 |
| 문서·슬라이드 | 문단·표 셀·shape ID별 DOM 편집 폼. OOXML/ODF는 지정 node만 갱신하고 미변경 package 부분을 보존 |
| diff | hunk별 기준/현재/제안, checkbox, 수락·거부·역변경·충돌 편집 버튼 |
| Terminal | sequence·누락 표시가 있는 선택 가능한 출력 문서, 입력권, 줄 단위 명령 필드·보내기·제어키와 동일 PTY renderer 재연결 |

Terminal 대체 입력은 `runtimeId, processGeneration, inputEpoch, inputSequence, operationId`를 일반 Terminal과 같은 gateway에 전달한다. 한 줄 명령은 검증된 encoding의 byte와 Enter에 해당하는 CR 한 번을 전송하고, 제어키는 선택한 단일 byte(Ctrl+C=0x03, Ctrl+D=0x04, Esc=0x1b)만 전송한다. 이는 키 입력이며 Ctrl+C 수신이나 중지 성공을 미리 단정하지 않는다. 입력 ACK 유실은 같은 sequence를 조회하며 명령을 재발송하지 않는다. 출력은 동일 PTY sequence를 이어 받아 접근 가능한 텍스트 projection으로 만들고 escape 제어열을 실행 가능한 HTML로 취급하지 않는다.

줄 단위 입력 가능 여부와 비밀 입력 보호는 adapter의 확인된 capability·현재 terminal mode에 따른다. 미확인·전체 화면 TUI·보호 입력에는 대체 입력을 차단한다. renderer 재연결은 동일 runtime 세대의 screen checkpoint와 이후 output sequence를 사용하며 새 process를 만들지 않는다. 재연결 실패에도 Canvas에 실행 상태·종료 경로를 남긴다.

**미실행 Terminal 인수 조건:** renderer 실패→동등 조작 화면→입력권 취득→명령 입력→출력 확인을 수행한다. 같은 processGeneration 유지·명령 1회 수신·출력 sequence 연속·다른 업무 입력 0을 대조한다. IME 확정·권한 회수·재접속·ACK 유실·제어키·지원하지 않는 TUI/비밀 입력에서 오발송과 자동 새 shell 생성은 0이어야 한다.

원형 writer가 제공되는 형식은 선택한 저장 모드에 따라 직접 편집→native 저장 또는 제안 편집→부분 수락→native 저장을 수행하고 재열어 확인한다. 원형 writer가 실패하면 편집 가능한 delta와 원본을 `.egdesk`로, 표/문장을 CSV·텍스트로 반출할 수 있다. 이 결과는 `대체 형식 저장·원형 저장 미완료`이며 내부 원형 편집 완료가 아니다.

Monaco의 screen-reader 모드와 이름을 설정한다. 대체 화면은 native form/button을 우선한다. `변경 2/5·시트 A·B7·미수락`처럼 대상·순서·상태를 이름에 연결하고 비활성 사유를 연결한다. 상태는 polite live region, 오류는 중복 억제한 별도 안내를 사용한다. 컨트롤은 reflow하며 자료 자체의 2차원 예외와 구분한다.

**미실행 인수 조건:** 여섯 흐름은 파일 편집/검사, diff, Terminal, 초기화/복구, 반출입/원격 요청, Canvas 목록/Briefing/Ontology다. OS별 72 환경·흐름 조합에서 키보드와 드래그 없는 포인터를 각각 검사한다. 실제 편집·부분 수락·반출 결과가 같아야 하며 대표 경로만으로 AA 준수를 선언하지 않는다.

### 17.E Ontology·협업·외부 조작면

<a id="impl-e24-ontology-resolution"></a>

#### 1. Ontology resolution·semantic 검증·승격

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-ontology-inspect) · [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-ontology-governance)

SQLite 사건·관계 인덱스와 content-addressed 불변 payload를 사용한다. concept·occurrence·relation·constraint·evidence를 정규화하고 JSON Schema 2020-12로 검증한다. provenance는 entity·activity·책임 주체·derivation을 대응시킨다. RDF 서버를 필수화하지 않으며 RDF adapter가 필요할 때 SHACL을 추가한다. 구조 검증은 의미 판정을 대신하지 않는다. [JSON Schema](https://json-schema.org/draft/2020-12), [PROV-DM](https://www.w3.org/TR/prov-dm/), [SHACL](https://www.w3.org/TR/shacl/).

System resolver는 조직·Desk·역할 정책, 현재 권한, 요청 범위, source revision으로 필요한 부분을 선택한다. inspector의 한 단계 표시 제한과 실행에 필수인 dependency closure를 구분한다. 큰 자료는 read-only Reader로 분할하고 필수 관계를 못 읽으면 해당 행동만 차단한다.

호출별 receipt는 run/turn, 정책 revision, 사용 unit/hash, 출처, 선택 이유, 제약, ACL 확인, 제외·불명 범위를 기록한다. 현행 결정·정본·역사·절차 자료의 권위를 구분한다. 새 사실·교정·호환 변경은 같은 Run의 다음 context에 반영하고 과거 payload는 변경하지 않는다.

후보는 stable unit ID·원문 구간을 가진 patch다. 조건·예외·안전·권한·행동·기대 결과별 structural/semantic finding과 disposition을 별도 저장한다. Agent는 의미 분석을 하고 parent 업무의 유효한 위임 또는 업무 책임자가 판단한다. 고정 Worker/Critic 조직이나 별도 사람을 강제하지 않는다.

비활성 초안 저장에는 대상 unit 참조·기준 revision·제안 문장이 필요하다. 조건·예외의 공란은 unresolved이며 기존 조건을 삭제하는 patch가 아니다. 분류·책임자·기간·근거 설명의 미정 상태도 보존할 수 있고 작성자·무기한을 기본값으로 대신 넣지 않는다. 검증 결과는 구조·링크, 의미, 권한·공개, 영향·회귀 각각의 `passed/issues/not-evaluated`와 입력 hash·검사 시각에 결합한다. 원문 접근 실패나 현재본 대조 부재는 그 검사만 not-evaluated로 남긴다. System의 형식 검사를 Agent의 의미 검토로 승격하지 않는다.

후보 편집 진입 자체는 모델 호출이 아니다. 의미 검사는 유효한 원문을 받은 Agent에게 요청하며 그 결과를 수정 없이 근거와 함께 기록한다. 후보가 바뀌면 이전 결과를 stale로 표시한다. 검토 전달에는 저장 revision·수신 권한·공개 범위를 검사하고 미검증 항목도 전달한다. 전달 가능성과 승격·활성화 가능성은 별도 정책·권한 검사다. 활성화는 필요한 분류·책임·범위·기간과 정책상 검증이 해소되기 전 허용하지 않는다.

근거 선택기는 기존 권한 필터된 자료 검색·파일 resolver를 사용한다. 선택 상태와 후보에 연결된 sourceRef는 별개이며 확정 시 후보 ID/revision·원문 ID/hash·범위·권한 epoch를 대조한다. 실패·취소는 기존 binding과 초안을 보존한다. 연결 성공은 그 원문·범위의 읽기 확인이지 의미 검증 성공이 아니다. 현재본 비교 역시 읽기 전용이며 명시적 후보 갱신 없이 baseRevision을 변경하지 않는다. 새 연결·후보 변경 후 의미 결과는 해당 새 입력 hash의 재검증 전까지 유효로 재사용하지 않는다.

원문 연결·본문 편집은 draft revision을 갱신하며 저장된 후보 revision과 별개다. 검증은 요청 시 고정한 draftHash·sourceRefs에 결합한다. 같은 hash를 후보로 저장하면 그 검사와 저장 revision을 연결할 수 있지만, 이후 변경분에는 이전 판정을 적용하지 않는다. 검증 결과의 표시가 dirty 상태나 저장 ACK를 대신하지 않는다. 저장 ACK는 해당 초안 revision에만 적용하고 새 변경·의미 경고·미검증 항목은 유지한다.

내 제안·받은 검토는 기존 candidate/request record를 수신자 권한으로 필터한 projection이다. 목록·검색 count에도 같은 필터를 적용한다. 검토 전달은 candidate revision/hash·수신자·공개할 sourceRefs·미검증 항목을 고정한다. 수신자가 열 때 현재 권한과 대상 revision을 다시 검사하고, 후보가 바뀌면 이전 요청을 현재 후보의 승인으로 쓰지 않는다. 판정은 해당 요청·후보 revision에 연결되며 원 요청 행으로 복귀한다.

직접 권한자의 명시적 행동은 제공 범위∩현재 실제 권한∩governance capability∩정책 조건으로 검사한다. 위임받은 actor에게만 유효한 유형별 grant를 추가 교차한다. 위임은 주체·유형·범위·행동·종료 조건·검증 조건·정책 revision을 가진다. 검증은 후보 hash·기준본·시험·정책 revision에 결합한다. ACL API/dry-run을 우선하며 불가능하면 미검증이다. 업무 원본에 임의 시험쓰기를 하지 않는다.

승격·활성화·롤백은 기준 revision·권한 epoch가 일치할 때 원자적으로 적용한다. 한 확인에서도 의미 수락·revision 생성·활성 참조 변경을 구분한다.

**미실행 oracle:** 12개 의미 단위 중 안전 예외 1개 누락 시 구조 PASS와 별개로 실패; 제한 역할의 활성화 거부; 편집/활성화·유형별 위임 분리; 후보 변경 후 관련 verdict stale; 동시 활성화 단일 성공; 롤백 후 과거 hash 불변. 동일 task·tenant/profile·source revision의 paired 시험에서 경로·의미·근거·안전·시간을 따로 판정하고 ERP write 0·영향 재시험을 확인한다.

##### 직접 권한과 위임 행사

공통 허용 집합은 `제공 범위 ∩ 현재 실제 권한 ∩ governance capability ∩ 정책 조건`이다. 직접 권한자가 명시한 행동은 이 집합으로 검사하며 사전 위임 grant를 요구하지 않는다. 위임받은 actor의 행동에만 유효한 grant의 주체·유형·범위·행동·epoch를 추가 교차한다. System이 직접 사용자 행동을 집행하는 것은 새로운 Agent 위임이 아니다.

사전 위임 없음은 Agent의 자율 조직 변경을 허용하지 않는다는 뜻이다. 직접 권한자의 처리와 기존 Task 위임 안의 읽기·의미 분석·finding 수정·재검토를 금지하지 않는다. 편집 제공 범위, 검토 역할, 유형별 위임은 별도 필드다.

##### 직접 권한과 위임 행사 인수 조건

직접 권한자+사전 위임 없음은 허용, 무권한자는 거부, 위임 actor는 허용 유형만 처리, grant 철회 후 변경 0, 일반 검토와 동일 Run 조정은 계속.

##### 필수 지식 선택과 순회

호출 resolver는 권한 확인된 일관된 ontology/index revision을 고정한다.

| 단계 | 실행 규칙 |
|---|---|
| 시작점 | 현재 조직·Desk·역할의 활성 binding, 요청 action/type에 연결된 필수 제약, 명시 unit ID를 필수 seed로 삼는다. 당시 검사 모드는 해당 호출 receipt의 unit 집합에서 시작한다. |
| 권위 필터 | 등록된 authority manifest의 현재 결정·정본만 운영 사실 후보로 사용한다. archive는 역사 증거, Skill은 절차로 분류한다. 문서 자체의 권위 주장·최신 timestamp만으로 승격하지 않는다. 같은 권위의 미해결 충돌은 해당 행동을 보류한다. |
| 필수 순회 | schema에 지정된 requires/dependsOn/constrainedBy와 연결된 exceptionOf, 필수 evidence 관계를 순회한다. appliesTo는 요청 범위를 검사한다. 일반 relatedTo·배치/포함 관계는 필수 실행 의존성으로 자동 확장하지 않는다. |
| 선택 검색 | 명시 ID 일치→정확 용어 일치→FTS5 BM25 오름차순→stable unit ID 순으로 정렬한다. 검색어·index revision을 기록한다. 권한 필터는 hit/count/snippet 생성 전에 적용한다. |
| 종료 | `(unitId,revision)` 방문 집합으로 순환을 끊고 frontier가 비면 완료한다. 필수 closure는 hop/top-k로 자르지 않는다. 큰 원문은 read-only Reader로 나누며 누락·권한·용량 불명은 해당 의존 행동만 보류한다. 선택 참고자료만 남은 admission 예산에 맞는 정렬 prefix를 사용한다. |

FTS5의 낮은 BM25 값을 우선하는 규칙을 사용한다. [FTS5 ranking](https://www.sqlite.org/fts5.html#the_bm25_function)

receipt에는 seeds·순회 관계·필수/선택 unit·source/hash·권위/권한 revision·selector/index revision·선택/제외 이유·미확인 frontier를 남긴다. 비공개 unit의 이름·존재는 수신 권한 밖으로 내보내지 않는다. 호환 갱신은 같은 Run의 다음 호출에 반영하고 과거 receipt/payload는 유지한다.

재색인은 shadow generation에서 unit manifest와 hash를 대조한 뒤 pointer를 교체한다. 후보 index는 평가 binding에만 연결한다. 원문 의미 단위별 disposition 없는 누락은 의미 보존 완료가 아니다. paired 평가는 동일 task·tenant/profile·source/test revision에서 입력을 격리하고 경로·의미·근거·안전·시간을 따로 판정한다. 미검사 범위는 UNKNOWN이다.

##### 필수 지식 선택과 순회 인수 조건

검색어에 없는 안전 예외도 필수 관계로 포함; 순환 종료; stale Skill의 운영 사실 우선 적용 0; 비공개 count 누출 0; shadow index 누락 시 활성화 0; 과거 v7 유지/다음 호출 v8; A/B의 ERP write 0·영향 재시험.

<a id="impl-e24-collaboration-authority"></a>

**통합 근거(좁은 부분):** [운영자 발급과 카드별 권한을 가진 Firefox Board](../../apps/firefox-ui-demo/docs/JOINT_BOARD_RUNTIME.md). 좌표 변경은 본문 수정·회신 버전과 분리하며, 수신 초대는 승인된 원문 버전과 제공자의 유효 참여에 묶는다. [선택형 배치 설계](../../apps/firefox-ui-demo/docs/DECISION_MODEL_CONTEXT_SETUP.md#board-presentation-choice)는 실행 권한 없는 보기만 돌려준다. [앱 공유 설계](../brainstorming/MINI_APP_ECOSYSTEM.md#npx-sharing)에서 패키지 배포·인스턴스 접근·업무 변경 권한은 별개다.

#### 2. 협업 identity·grant·동시성·소유권

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-collaboration-invite) · [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-collaboration-manage)

person, device/session, Agent 실행체, AI Engine, 업무 서비스, OS principal을 분리한다. grant는 issuer·subject·scope·capability·종료 조건·위임 상한·epoch를 가진다. 읽기·쓰기·재접속마다 현재 권한을 확인한다. 업무 기간 grant, 지속 grant, 인증 세션, 입력 lease, 데이터 보존은 다른 수명이다.

공유 상태 UI의 카메라·focus·열린 상세는 참가자별 표시 상태다. 초대 수락·접근 receipt는 개시자의 같은 요청/자료 상세를 갱신할 뿐 그 표시 상태를 닫거나 수신자의 화면 위치로 옮기지 않는다. 자료에서 재진입한 공유 관리는 resourceRef에 해당하는 허용 grant만 조회한다. 회수 명령은 선택한 grant ID·범위·권한 epoch에 결합하며 다른 자료·사람의 grant에 확장하지 않는다.

초대 nonce는 확인된 수신자에 묶는다. 수락·취소·만료를 원자적으로 처리하고 중복 수락은 같은 결과를 반환한다. 발송·전달·수락·접근 receipt를 분리한다. scope preview와 제외 목록에도 공개 필터를 적용한다.

**내가 설정한 Agent를 다른 사람이 쓸 때.** 특정 Board에서 이 Agent에게 질문할 권한과 Profile을 열람·복제·수정할 권한은 다르다. 질문만 허용해도 상대는 설정 사본을 받을 필요가 없다. Agent의 개인 대화, 메모리, 도구, AI 구독과 업무 서비스 로그인은 따라가지 않는다. 사용 가능한 자료는 먼저 Board 소유자가 공개한 발췌와 이번 요청에 허용한 범위로 좁힌다. Decision Model은 이 집합 안에서만 자료를 고르며 모델의 판단이 권한을 넓히지는 않는다.

로컬 파일 교환에서는 소유자가 Board와 활성 Agent 버전을 지정해 일회용 질문 코드를 발행한다. 이 코드는 암호화한 검토 요청을 제출하기 위한 것이지 직원 신원·Desk 입장·실행 승인이 아니다. 소유자가 요청 파일을 열어도 코드나 비용을 소모하지 않는다. 해당 Board에서 질문·제공할 자료·외부 전송 여부를 다시 보고 한 번 승인한 경우에만 처리한다. 정책 변경·회수·코드 만료 시 이전 승인을 재사용하지 않는다. 로컬 발췌로 충분한 경우 추론 호출은 필요 없다. 외부 선별이나 서술형 초안은 각각의 전송처와 입력 범위를 확인해야 하며, 개인 Chat이나 다른 계정으로 대체하지 않는다. 답변은 소유자가 수정·확인한 뒤 별도로 내보내며, 파일 생성은 전달·수신 확인이 아니다. 실시간으로 직원을 확인하고 직접 호출을 허용하는 경로는 별도 협업 인프라 대상이다.

텍스트·구조화 필드는 3-way merge와 조건부 쓰기를 선택한다. 비충돌은 위임 범위에서 병합하고 겹친 의미는 보존·판단한다. strong ETag/If-Match 불일치는 쓰기를 거부한다. Browser·binary·외부 효과는 단일 writer와 대상 revision을 검사한다. 원자 저장/잠금이 보장되지 않으면 사본·provider 편집기로 전환한다. [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match).

타인 변경 수락·역변경 capability를 따로 검사한다. 역patch는 현재본에 적용하고 타인 후속 변경을 유지한다. 저장 결과 불명은 조회 후 재시도하며 전체 과거본 덮어쓰기로 대체하지 않는다.

이전·복구 transaction은 owner-set revision, 요청 권한·수락/의결, 현재 복구 위임, 기존 grant 처리 집합을 검증한다. 종료형은 지정 grant를 종료하고 유지형은 새 소유자가 명시 수락한 항목만 새 revision에 연결한다. 무효한 계정 권한·옛 복구 위임은 복원하지 않는다.

**미실행 oracle:** 수락/취소 단일 결과; 종료형/지속형 수명 분리; 수락만 가능한 주체의 역변경 거부; 자기 역변경 후 타인 변경 보존; owner 이전/복구 경합; 선택 유지·종료 정확성; 오프라인 옛 grant 비부활; 비공개 이름 누출 0; 두 PC pan과 실행 대상 독립성.

##### 기기·세션별 권한 적용

person key는 `(issuer,subject)`다. grant에는 devicePredicate/sessionPredicate를 추가한다. 수락 기기/세션 한정은 accept transaction에서 검증된 deviceId/sessionId에 한 번 결합한다. 정책 허용 세션은 현재 issuer/audience·인증 유효성·기기 등록/철회 상태를 매번 검사한다. 같은 이메일만으로 다른 principal을 합치지 않는다.

미등록 수신자는 지정 주소의 인증된 소유 증명 후 principal에 결합한다. provider가 보증하지 않는 점·별칭·local-part 변환을 하지 않는다. nonce만 가진 전달받은 사람에게 권한을 열지 않는다.

기기 회수는 해당 device/key epoch와 종속 lease·stream을, 세션 회수는 해당 session을, person grant 회수는 모든 종속 연결을 차단한다. 기존 P2P/SFU 차단과 receipt 분리를 그대로 적용한다. 다른 AI·업무·OS 계정 권한은 이전하거나 함께 회수하지 않는다.

##### 기기·세션별 권한 적용 인수 조건

수락 기기의 재진입 성공, 다른 기기 거부, 허용 기기 정책의 신규 등록 기기 접근, 세션 한정 만료, 단일 기기 회수 후 다른 유효 기기 유지, 전달 링크 오수락 0.

##### 공동 소유·표결·복구

요청은 `operationId, proposalRevision, ownerSetRevision, policyRevision, frozenVoters, candidateOwners, grantDispositionHash`에 결합한다. 의결 조건은 Owner가 선택한 전원 또는 유효 threshold를 평가하며 `1≤threshold≤voterCount`를 검증한다. 수신자의 소유권 수락은 의결과 별도 사실이다.

표는 authenticated principal·현재 device key·요청 hash에 결합하고 voter당 한 현재 표만 유효하다. commit 전 표 변경/요청 취소는 revision을 갱신한다. owner/policy 집합이 바뀌면 이전 표를 새 요청에 전용하지 않는다. 원자 commit에서 현재 revision·의결·수락·grant 처리 집합을 재검사한다. 미지정 만료를 임의 시간으로 채우지 않는다.

복구 위임 없음은 복구 권한을 만들지 않는다. 위임형은 명시된 증명 predicate·확인자 서명·재인증·현재 위임 epoch를 평가한다. 무응답이나 옛 위임은 증거가 아니다. 복구는 Desk 권한만 대상으로 하며 일반 업무는 계속한다.

##### 공동 소유·표결·복구 인수 조건

구성원 수가 다른 fixture, 표 중복/철회, owner 변경, 수락/취소·이전/복구 경합에서 단일 commit; 옛 표·옛 복구 grant 재사용 0; 기존 위임의 선택 유지/종료 정확성.

##### 순차 편집의 대기·인계

순차 lock은 resource와 안정 block/path 집합, actor/device/session, base revision, fencing epoch를 가진다. 중앙 transaction은 겹치는 active lock의 중복 발급을 거부한다. 상태는 `requested→queued→granted→draining→released/expired`다. 동순위 요청은 서버 접수 순서·operation ID로 정렬한다.

모든 저장은 현재 lock epoch와 base revision을 검사한다. 만료·단절 뒤 옛 writer의 저장은 거부한다. 진행 중 쓰기의 결과가 불명이면 조회 전에 다음 writer를 시작하지 않는다. 안정 부분 범위를 표현할 수 없으면 명시적으로 선택한 문서 전체 lock 또는 사본/provider 편집기로 전환하며 부분 잠금 지원을 가장하지 않는다. 새 승인을 모든 병합에 추가하지 않는다.

##### 순차 편집의 대기·인계 인수 조건

두 writer의 겹침 거부, 대기 취소, 저장 직후 단절, 만료 뒤 늦은 저장, 인계 중 원본 변경; 초안 보존·타인 후속 변경 보존·독립 작업 계속.

##### 수락 이후 첫 화면 실패

accept는 invite revision·nonce·수신 principal·device/session predicate를 검증한 transaction에서 grant와 receipt를 함께 생성한다. 같은 operation 재시도는 같은 결과를 반환한다. frontend는 timeout 후 상태를 조회한다. 이미 accepted면 grant를 재생성하지 않고 현재 권한으로 projection만 다시 연다.

미수락·유효 상태에서만 같은 accept를 재시도한다. 만료/철회는 새 초대 요청, identity mismatch는 올바른 인증으로 복귀한다. 송신 재전송은 기존 처리 상태 확인과 옛 nonce 무효화 후 수행한다. 채널 receipt에는 실제 provider ID/상태/시각을 기록하며 지원되지 않는 delivery/read 상태는 UNKNOWN이다.

##### 수락 이후 첫 화면 실패 인수 조건

accept commit 전후 단절, 중복 탭, 늦은 취소, 전달 링크·계정 변경, accepted 후 renderer 실패에서 grant 1개·잘못된 접근 0·재개방 성공·중복 발송 0.

<a id="impl-e24-remote-transport"></a>

#### 3. 원격 protocol·철회·동기화·보존·비용·exit

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-computer-use-observe)

**구조.** Firefox 셸, 로컬 coordinator, PC별 host bridge, 원격 권위 coordinator, 객체 저장, 미디어 adapter를 분리한다. 초기 권위 저장의 추천 기준선은 단일 writer SQLite WAL·불변 객체다. SQLite DB와 접근 프로세스는 해당 호스트에 두고 다른 PC는 권한 검사된 서비스로 접근한다. network-mounted DB 파일의 다중 PC 직접 접근을 공유 서비스로 취급하지 않는다. coordinator 장애 시 임의의 두 번째 writer를 만들지 않는다. 기존 환경 배치 또는 조직 운영형/관리형 adapter는 구현 대안이며 공급자 구매를 전제하지 않는다.

신원·기기 인증은 선택된 배치에서 지원·검증된 방법과 보호 저장소의 device key/token을 사용한다. OAuth를 사용하는 경로는 외부 브라우저 Authorization Code+PKCE와 issuer·subject·audience·nonce를 검증하고, 공개 client refresh token에 rotation 또는 sender constraint를 적용한다. 새 조직 SSO 도입을 모든 배치의 전제로 삼지 않는다. 통신의 추천 기준선은 제어·중지 전용 WSS, 사건 WSS, 객체 HTTPS, 영상 WebRTC, 소실 가능한 커서 DataChannel의 분리다. 동등한 구현은 같은 권한·중지·격리 조건을 검증한다. [RFC 8252](https://www.rfc-editor.org/info/rfc8252/), [RFC 9700](https://www.rfc-editor.org/info/rfc9700/), [RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html).

허용된 직접 경로와 조직이 운영하는 미디어 중계는 서로 다른 전송 선택지다. 직접 경로를 선택한 설계에서는 직결에 실패하면 승인된 중계를 사용할 수 있고, 수신자가 많으면 허용된 분배 기능을 사용할 수 있다. 중계 전용 정책을 선택하면 직결로 대체하지 않는다. [조직 초기 설정](#tech-org-setup)이 어느 정책을 기본값으로 결정하거나 두 단말의 조직 마스터 상시 접속을 요구하는 것은 아니다. 새 전송 주체·지역·비용 범위를 넘는 대체 경로는 쓰지 않는다. 허용된 경로가 없으면 원격 관찰 불가이며 독립 로컬 업무는 계속한다.

명령에는 ID·run/task·target·device generation·observation revision·grant/lease epoch·deadline을 붙인다. 초기 시험값은 heartbeat 2초·host 단조시계 TTL 6초다. 이는 grant 기간 기본값이 아니다. cancel tombstone·epoch·host 입력 차단·진행 중 행동·ACK를 기록한다. 단절·TTL만으로 process 종료나 외부 효과 취소를 입증하지 않는다.

**기존 관찰 연결 철회.** token 만료만 기다리지 않는다. grant epoch 변경 즉시 새 구독/갱신을 거부하고 P2P는 해당 peer 송신·연결을 종료한다. SFU는 해당 참가자/구독 제거와 트랙 차단을 실행한다. 송신자·relay는 구독별 현재 권한과 짧은 관찰 lease를 검증한다. 철회 적용을 확인할 수 없으면 영향받는 미디어 송신을 차단한다. 서버 결정·송신 차단·relay 적용·상대 수신 중단 확인은 별도 receipt다. 이미 전송된 버퍼/사본은 회수했다고 주장하지 않는다. 재연결은 현 epoch로 다시 인증한다. [기존 연결과 token 만료의 차이](https://docs.livekit.io/frontends/reference/tokens-grants/).

재접속은 사건 cursor·권한·실행 동일성·외부 receipt를 대조한다. 취소된 실행을 늦은 결과로 재활성화하지 않는다. 외부 쓰기는 오프라인 queue하지 않는다. PC 인계 전 이전 writer와 외부 효과를 확인하며 임의 provider 전체의 exactly-once를 주장하지 않는다.

**데이터·보존.** 전송 manifest에 scope·revision/hash·수신자·공개 분류·보존 정책을 연결한다. 선택형은 지정 참조 closure, Desk 전체형은 선언한 허용 범주를 투영한다. 동기화는 사건·객체 증분, 백업은 특정 사건 경계의 별도 manifest다. credential·process·미전송 입력은 제외한다.

실시간 버퍼는 비저장 시 폐기한다. 기록·증거는 명시 기간 또는 권한자 삭제 정책을 따른다. 동기화 중지·관찰 철회·context 변경은 과거 payload 삭제 명령이 아니다. 명시 삭제 시 원본·파생물·replica·backup 참조와 잔존/만료 대기를 추적한다. 복원은 새 revision이며 현재 철회 사건을 우선하여 grant·lease·실행을 부활시키지 않는다.

**비용 모델.** 영상 `V=0.45×Mbps×시간(h)` GB, 관찰 전송은 약 `V×평균 수신자 수`, 기록은 `V×기록 비율`이다. relay·재전송·overhead를 계측해 보정한다. 저장은 보존기간·복제·backup, 데이터 전송은 최초 seed+고유 변경+재전송으로 계산한다. 비용은 compute 시간·GB-month·전송 GB·요청/전달 건수·운영 작업의 단가 합이다. 가정 2Mbps·1시간은 기록 0.9GB, 수신자 3명은 약 2.7GB이며 가격·예산 승인이 아니다. 실제 환경·지역·운영 책임·견적이 정의될 때만 구체 집행 승인을 요청한다.

**Exit.** `[설정] → [기기·원격 연결] → 환경 → [연결 종료·데이터 이동]`에서 새 행동 차단→lease/미디어 회수·기록 마감→허용 데이터·사건·hash 반출→목적지 읽기 전용 복원 검증→요청된 정확한 원격 사본 삭제→해당 token/device 연결 해제를 수행한다. 검증 전 원본을 자동 삭제하지 않는다. replica 미확인·backup 만료·남은 유료 자원을 표시하며 연결 종료를 과금 종료로 표시하지 않는다.

**미실행 oracle:** 범위 외 전송 0·전체형 누락 검출; NAT/relay 장애의 무단 fallback 0; 기존 연결 철회 후 새 프레임 차단; ACK 유실 fail-closed; 재접속·늦은 결과 비부활; backup 복원 후 옛 권한 거부; 반출입 hash 일치; 삭제 미확인 사본 잔존 표시.

##### 동기화와 백업의 독립 조합

syncPolicy와 backupPolicy는 별도 revision이다. 동기화는 허용 event/object 증분이며 백업은 독립 root 집합과 일관된 event 경계의 manifest다. 동일 hash의 저장 중복 제거는 두 정책의 권한·보존기간을 합치지 않는다.

백업은 `planned→copying→sealed→verified→available`로 전이한다. hash·필수 object 검증 전 복원 지점을 완료로 표시하지 않는다. 실패·취소는 기존 유효 복원 지점과 원 데이터를 유지한다. 백업 중지는 동기화 중지나 기존 백업 삭제가 아니다. 복원은 새 revision이고 현재 철회 사건을 우선해 grant·lease·실행을 부활시키지 않는다. 새 endpoint·전송 주체·비용 범위를 넘는 실행만 실제 승인에 종속된다.

##### 동기화와 백업의 독립 조합 인수 조건

네 조합 모두에서 정확한 전송/보관 집합 대조; backup-off 생성 0; 한 정책 변경으로 다른 정책 확대 0; 범위 밖 secret/process/미전송 입력 포함 0; 부분 백업의 완료 표시 0; 복원 후 옛 권한·실행 부활 0.

<a id="impl-e24-computer-use"></a>

#### 4. Firefox·OS adapter·capture·녹화·독립 검증

**화면 연결**: [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-computer-use-control) · [사용자 조작](../../docs/references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-computer-use-observe)

Firefox web-content는 로컬 broker 뒤의 BiDi adapter를 사용하고 privileged shell/native OS는 별도 action namespace로 분리한다. Remote Agent에는 자체 인증·암호화가 없으므로 외부 포트로 노출하지 않는다. IPC는 OS principal·호출 capability를 검사한다. [Mozilla 보안 계약](https://firefox-source-docs.mozilla.org/remote/Security.html).

행동 순서는 identity→권한→lease→관찰 revision→전제 검사→입력→event/readback→증거다. semantic→접근성→현재 프레임 좌표 순으로 fallback하되 권한 상승은 fallback이 아니다. 좌표는 frame·scale·viewport·modal generation 변경 시 폐기한다. 감시자는 추가 Agent 입력을 차단하되 대상 업무 앱을 강제 종료하지 않는다.

macOS는 ScreenCaptureKit 선택 창 filter·AX action, Windows는 GraphicsCapturePicker/Windows.Graphics.Capture·지원 UI Automation pattern을 후보 adapter로 사용한다. AX 미지원/응답 실패, Windows UIPI 차단을 구분한다. API 호출이나 가상 디스플레이만으로 독립 OS 포커스를 주장하지 않는다. [Apple filter](https://developer.apple.com/documentation/screencapturekit/sccontentfilter), [AX action](https://developer.apple.com/documentation/applicationservices/1462091-axuielementperformaction), [Windows capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture), [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput).

Linux의 긍정 입력 경로는 아래 RemoteDesktop/EIS·Notify 계약을 따른다. 필수 adapter·격리·중지 조건을 확인하지 못하는 조합에서는 Agent 입력을 차단한다. 지원되는 XDG ScreenCast의 CreateSession→SelectSources→Start→PipeWire 관찰 또는 사용자 직접 인계만 제공한다. RemoteDesktop portal이 존재한다는 사실만으로 입력 지원을 선언하지 않는다. portal/backend·중지·identity가 검증되지 않으면 해당 기능을 비활성화하고 도구 설치·권한 우회를 하지 않는다. 출시 OS·보조기술 지원 약속은 지원 범위 결정/접근성 지원 범위 선택에 연결한다. [ScreenCast](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html), [RemoteDesktop](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html).

capture→scope 검사→mask→encode 순서를 지킨다. 웹 fallback은 사용자 선택 후 실제 surface를 대조한다. 영구 캡처 동의나 임의 범위 확대를 가정하지 않는다. [W3C Screen Capture](https://www.w3.org/TR/screen-capture/).

녹화는 마스킹된 MediaStream을 MediaRecorder·지원 WebM으로 기록하고 형식 지원과 실제 재생을 검사한다. 미지원이면 검증된 native encoder, 없으면 기록만 불가다. 구간별 hash·시간·mask revision·누락을 저장하며 timeslice의 정확한 길이를 보장하지 않는다. 녹화 node·owner·runtime을 먼저 영속화해야 관찰/앱 분리를 허용한다. 분리 후 live 동일성을 재검증하며 hidden-only 실행을 금지한다. [MediaStream Recording—Working Draft](https://www.w3.org/TR/mediastream-recording/).

결과는 파일 재읽기·provider 조회·독립 관찰로 검증한다. 같은 Agent가 수행해도 자기 설명·입력 로그·녹화 존재를 성공 증거로 쓰지 않는다. 기술 성공·접수·현재 업무 반영을 분리하고 업무 의미는 parent의 유효한 판단 범위에 둔다.

**미실행 oracle:** 잘못된 profile/tab/renderer 거부; pan 전후 target 불변·viewport 변경 시 좌표 폐기; IME 확정 전송 0/별도 전송 1; 인계·긴급 중지 후 추가 입력 0; 금지 프레임 전송 0; Linux 미검증 입력 불가·portal 취소 시 권한 없음; 관찰/앱 닫기 중 녹화 node·owner 유지; 소유 표현 불가 시 계속 기록 거부; Board 종료 후 owned recorder 종료 확인; 입력 성공·결과 불일치에서 완료 판정 금지.

##### Linux 입력 지원 경로

host bridge는 portal/backend 버전·AvailableDeviceTypes·실행 session·허용 source와 독립 중지 경로를 확인한다. `RemoteDesktop.CreateSession → SelectDevices(필요한 장치만) → 선택적 ScreenCast.SelectSources → RemoteDesktop.Start`를 수행한다. 성공 응답의 실제 devices/streams를 요청 범위와 대조하고 PipeWire 연결을 연다.

EIS 지원 backend에서는 Start 이후 ConnectToEIS와 libei sender를 사용하며 stream mapping_id와 입력 region을 결합한다. EIS가 지원되지 않고 검증된 Notify adapter가 있는 경우에만, EIS 연결을 성립시키지 않은 session에서 Notify 계열을 사용한다. **한 session에서 혼합 주입하지 않는다.** EIS 연결 후 장애는 session 종료·상태 재확인으로 처리하며 같은 session의 Notify로 전환하지 않는다. 재시작에는 현재 동의·권한과 새 lease가 필요하다. [RemoteDesktop 계약](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)

제어 seat의 독점성은 host/session·device 할당·접근 경로와 교차 seat 입력 시험으로 확인한다. 격리 상실·session 종료·중지 채널 상실은 입력 gate를 닫는다. Wayland portal에서 제공하지 않는 global-human-input listener를 만들었다고 간주하지 않는다.

##### Linux 입력 지원 경로 인수 조건

EIS 정상 입력·Notify 정상 입력 각각 readback 확인; 혼합 주입 0; portal 취소 후 입력 0; 잘못된 region 거부; 다른 seat의 입력 비간섭; 격리 상실 후 추가 업무 입력 0; 격리 없는 환경은 명시적 사람 처리.

##### 입력 출처·감시자·긴급 중지

제품의 모든 입력 adapter는 renderer·coordinator와 별도 프로세스인 host watchdog의 gate를 통과한다. watchdog이 입력을 직접 중개하거나 살아 있는 watchdog 연결을 확인한 injector만 입력한다. watchdog 사망·IPC 단절·lease 만료는 fail-closed다. 원격 heartbeat 2초/TTL 6초는 기존 시험값이며 Owner grant 기간이 아니다.

| OS | 입력 출처와 대상 귀속 | 전역 긴급 중지 |
|---|---|---|
| macOS | session CGEventTap에서 source PID/state/userData, 대상 PID·포커스/창 관찰을 수집한다. 자체 주입은 broker의 미소비 dispatch 표식과 함께 대조한다. 나머지는 사람/외부/불명으로 취급하며 표식만으로 신뢰하지 않는다. | 독립 helper의 session event tap에서 실제 키맵의 Ctrl+Alt+Shift+`.`를 검출한다. modifier·keydown·반복 여부를 검사하고 해당 chord만 처리한다. tap 비활성·권한 상실·secure 입력 경계에서는 물리 입력 gate를 닫는다. |
| Windows | Raw Input의 device 정보와 LL keyboard/mouse hook의 injected flags·dwExtraInfo를 자체 dispatch 기록에 대조한다. 키보드는 foreground window, pointer는 현재 위치/창을 함께 확인한다. 불명은 양보다. | watchdog 전용 message thread가 RegisterHotKey로 Ctrl+Alt+Shift+`.`를 등록하고 WM_HOTKEY를 처리한다. 등록 충돌·실패는 물리 입력 불가다. |
| Linux | EIS/Notify 송신은 자체 command ID로 귀속한다. portal을 통해 사람의 전역 입력 출처를 관찰했다고 기록하지 않는다. 감지 불가 환경은 검증된 Linux 격리 seat 또는 사람 처리만 사용한다. | 독립 helper가 GlobalShortcuts CreateSession→BindShortcuts로 `egdesk-emergency-stop`을 등록하고 Activated를 처리한다. 현재 session의 실제 등록 ID와 trigger_description을 검사·표시한다. 빈 결과·필수 ID 누락·backend 미지원·거부·session 종료·등록 상태 미확인은 해당 자동 입력 모드 불가다. |

macOS event 필드는 출처 단서이지 위조 불가능한 권한 증명이 아니다. Windows hook은 전용 thread에서 즉시 반환하며, timeout에 따른 무통보 제거 가능성 때문에 hook heartbeat만으로 감지 정상 판정을 내리지 않는다. Raw Input 등록·수신 경로와 injector echo를 함께 검사한다. [Apple event 필드](https://developer.apple.com/documentation/coregraphics/cgeventfield), [Raw Input](https://learn.microsoft.com/en-us/windows/win32/inputdev/about-raw-input), [주입 flags](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-kbdllhookstruct), [hook 한계](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc), [RegisterHotKey](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey), [GlobalShortcuts](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html)

Linux helper는 등록 전에 `ShortcutsChanged`를 구독한다. 등록 응답·변경 신호·재접속은 shortcut generation을 갱신하고 입력 gate를 닫은 뒤, Bind 완료된 현재 session의 `ListShortcuts`로 필수 ID·현재 trigger·session 유효성을 다시 확인한다. 이전 generation의 늦은 응답은 쓰지 않는다. 변경 신호를 등록 전체 목록으로 추정하지 않는다. 필수 키가 없거나 해제·미확인이면 준비된 미발송 input을 무효화하고 계속 차단한다. 유효하면 UI의 실제 trigger와 capability generation을 함께 갱신하며 기존 위임 범위에서만 다시 허용한다. 매 input dispatch는 이 generation을 검사한다. Portal 명세의 등록 결과는 빈 부분집합일 수 있고 단축키 정보 변경을 별도 신호로 제공한다. [등록·조회·변경 신호](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html)

**미실행 긴급키 인수 조건:** 빈 Bind 결과, 필수 ID 누락, 등록 중 변경, session이 살아 있는 상태의 키 변경·해제, 오래된 조회 응답, session 종료를 주입한다. 유효 키 변경은 현재 표시와 같고, 불가·미확인 generation의 물리 입력은 0이어야 한다. 같은 session의 Activated만 긴급 중지에 연결하며 다른 session의 신호로 재개하지 않는다.

stop은 epoch 증가→미발송 queue 폐기→추가 업무 입력 차단→자체 눌림 상태의 안전 해제→ACK 순서다. 안전 key/button-up은 별도 cleanup receipt로 기록한다. 이미 OS에 전달한 입력은 취소됐다고 표시하지 않는다. raw 문자·클립보드는 감지 로그에 저장하지 않는다.

##### 입력 출처·감시자·긴급 중지 인수 조건

자체 주입의 잘못된 사람 판정, 외부 주입의 자체 판정, 창 귀속 불명, helper/renderer/coordinator 정지, hook/tap 장애, 다른 앱·IME 중 긴급키를 검사한다. 차단 이후 업무 입력 0, 안전 해제 별도 귀속, 원격 미확인 은폐 0이어야 한다.

##### 마스크 작성과 프레임 집행

mask는 `sourceId, surfaceGeneration, geometryRevision, kind, selector/rectangle, interval, maskRevision`을 가진다. 의미 가림은 현재 DOM/AX/UIA 대상과 frame geometry가 일치할 때 사용한다. 사각 가림은 surface-local 좌표를 현재 frame에 변환하며 경계는 바깥 방향으로 반올림한다. 시간 조건은 capture 단조시계의 `[start,end)`에 결합한다.

처리는 `capture scope 확인 → 필수 secure exclusion → 의미/사각/시간 가림 → 메타데이터 제거 → 표시/encode/기록`이다. 알려진 password·OTP·credential·보안 입력 단계, 원시 key/clipboard는 사용자 마스크로 재허용할 수 없다. 민감 영역을 정확히 특정하지 못하면 해당 surface 전체를 차단한다. OCR이나 selector 성공만으로 비밀 부재를 증명하지 않는다.

popup·resize·source 교체로 generation이 바뀌면 이전 가림을 그대로 재사용하지 않는다. 재해소 전 프레임은 송신·녹화하지 않고 gap을 남긴다. 다중 source는 고정 출력 트랙의 compositor에서 허용 영역만 합성한다. 과거 기록의 가림 변경은 새 파생 revision이며 원 payload를 덮지 않는다.

##### 마스크 작성과 프레임 집행 인수 조건

이동·확대·popup·마스크 만료·selector 다중 일치·계정 전환·처리 지연을 주입한다. 금지 픽셀/메타데이터 전송·기록 0, 오래된 mask 오적용 0, 정상 허용 전환의 반복 승인 0, 취소 후 기존 revision 유지.

##### 앱 종료와 독립 recorder 인계

앱 내 기준선은 지원 확인된 MediaRecorder/WebM이다. 독립 host 기준선은 해당 OS capture adapter와 libavcodec/libavformat의 WebM/VP8 encoder다. build capability·필수 가림·샘플 encode/decode·중지 endpoint를 검증한 조합만 detach 가능하다. 준비된 host가 없으면 계속 기록 기능만 불가다. [FFmpeg codec 계약](https://ffmpeg.org/ffmpeg-codecs.html#libvpx)

인계는 `prepare(handoffId, recordingId, owner, scope, maskRev, boundary) → native host 준비 → 첫 허용 구간 저장/검사 → Canvas node의 host binding 영속화 → host ACK → 기존 MediaRecorder 최종 dataavailable/stop 저장 → 앱 종료`다. ACK에는 host/process generation·source/mask revision·구간 hash·중지 가능 상태를 담는다. 기존 renderer 객체를 이전하거나 생존시켰다고 표시하지 않는다.

구간별 실행체·시각·중복/누락을 보존하며 동일 논리 기록과 Task/Run에 연결한다. host 표시와 Canvas 녹화 node에 중지·재진입을 유지한다. ACK 유실은 같은 handoffId 조회로 복구하며 encoder를 중복 시작하지 않는다. Board 닫기는 그 Board만 소유한 detached recorder도 종료한다.

##### 앱 종료와 독립 recorder 인계 인수 조건

인계 각 단계의 crash/ACK 유실, 실제 Firefox 종료, 새 host 실패, Board 종료를 검사한다. renderer recorder 생존 주장 0, 중복 encoder 0, 구간 손실 은폐 0, 활성 녹화 node·host 중지 경로 유지.
