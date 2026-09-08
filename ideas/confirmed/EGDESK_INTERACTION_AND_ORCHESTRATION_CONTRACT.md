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
남을 수 있다. Agenda 닫기의 종료 범위는 [§1](#tech-desk-lifecycle)을 따른다.
화면이 보인다는 사실만으로 외부 행동 성공·영구 저장·Agent 전달이 증명되지는 않는다.

<a id="tech-stack-baseline"></a>

### 0.3 기술 stack 기준선

| 영역 | 현재 상태 | 계약 |
|---|---|---|
| 제품 shell | `SELECTED-BASELINE` | Firefox 기반 EG-Desk 전환을 기준으로 한다. Firefox 내부 결합 방식과 UI 모듈 구조는 `IMPLEMENTATION-DISCRETION`이다. |
| UI 구성 | `IMPLEMENTATION-DISCRETION` | HTML/CSS/JS, Web Components, 상태 관리 라이브러리 등은 여러 Agent가 독립 수정·검증하기 쉬운 경계를 근거로 선택한다. 거대 단일 파일이나 특정 프레임워크는 계약 제약이 아니다. |
| Agent engine boundary | `FIXED-PRINCIPLE` | 제품은 engine adapter 경계를 가지며 Run은 사용한 engine/profile/version을 고정한다. Codex용 현재 기준선은 rich-client 인증·대화·승인·stream event를 제공하는 [Codex App Server](https://developers.openai.com/codex/app-server)다. |
| Codex 인증 | `SELECTED-BASELINE` | 구독 quota를 쓰는 Engine Profile은 ChatGPT managed browser login을 기본으로 한다. API key는 별도 profile이다. App Server의 active account·`planType`·rate-limit 상태를 검증하고 Run에 profile ID를 고정한다. |
| Engine Profile 격리 | `SELECTED-BASELINE` | 서로 다른 AI 계정은 App Server process/config/credential store를 profile별로 격리한다. EG-Desk 로그인, AI 구독 계정, 웹 리소스 계정은 같은 identity로 합치지 않는다. |
| 로컬 구조화 데이터 | `SELECTED-BASELINE` | SQLite가 conversation event, 관계, 상태 전이, manifest, 인덱스와 작은 텍스트를 관리한다. ORM·query builder·migration 도구는 `IMPLEMENTATION-DISCRETION`이다. |
| snapshot payload | `FIXED-PRINCIPLE` + `SELECTED-BASELINE` | 불변 byte payload는 content-addressed object store에 저장하고 SQLite는 hash·manifest·lineage를 가리킨다. 텍스트와 binary 모두 같은 무결성 규칙을 쓴다. |
| 로컬 내보내기 | `SELECTED-BASELINE` | 사람이 옮길 수 있는 단일 `.egdesk` bundle을 제공한다. manifest, JSONL event, 읽기 쉬운 Markdown, 필요한 object payload를 포함하고 token·cookie·기기 절대경로는 제외한다. container 세부 형식은 `IMPLEMENTATION-DISCRETION`이다. |
| helper/bridge/runtime 언어 | `IMPLEMENTATION-DISCRETION` | Rust, JavaScript 또는 다른 선택은 session 동일성, cancellation, stream backpressure, crash recovery를 측정해 결정한다. 언어 선택만으로 연결 지속성을 주장하지 않는다. |
| 다중 PC의 업무 실행 | `FIXED-PRINCIPLE` | 하나의 Canvas 기반 Agenda가 여러 PC의 자료·실행 자원을 연결할 수 있다. 화면을 보는 PC와 실행하는 PC를 구별하며 실제 실행 위치·계정·권한·결과를 연결한다. 단일 PC 또는 폴더 하나를 Agenda의 경계로 고정하지 않는다. |
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
| 실행·Desk 복원·Agenda | [§1 저장 수명주기](#tech-desk-lifecycle) | [L-01–L-03](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-l-01), [AG-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ag-01) |
| 요청 context·큰 파일 읽기 | [§2 context 조립](#tech-context-assembly), [§2.1 Smart Read](#tech-smart-read), [§2.2 Reader Session](#tech-reader-session), [§2.3 내부 분할](#tech-reader-orchestration), [§2.4 recovery](#tech-read-recovery) | [READ-01–03](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-read-01), [AI-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-01) |
| 출처·계정·권한 | [§3 identity 분리](#tech-resource-identity), [§14.1 Engine Profile](#tech-engine-profile) | [TOOL-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-tool-01), [BROWSER-02](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-browser-02) |
| Chat·활동 표시·Snapshot/Live | [§4 Answer projection](#tech-answer-projection), [§4.1 관찰 보존](#tech-observation-fidelity) | [CHAT-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-chat-01), [AI-04](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-04) |
| 다중 Agent·의존성·승인 | [§5 공유 대화](#tech-multi-agent-chat), [§9 의존성](#tech-dependency-orchestration), [§11 병렬 output](#tech-parallel-agents) | [AI-03](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-03), [AI-06](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-06), [AI-07](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-07) |
| 사람 중심 코딩·Terminal | [§6 코딩 표면](#tech-coding-surface), [§7 Terminal](#tech-terminal-runtime) | [CODE-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-code-01), [TERM-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-term-01) |
| 답변 브리핑 | [§8](#tech-answer-briefing) | [AI-05](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-05) |
| Ontology | [§10](#tech-ontology-runtime) | [ONT-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ont-01), [ONT-02](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ont-02) |
| 협업·computer-use | [§12](#tech-collaboration-computer-use) | [COL-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-col-01), [CU-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-cu-01) |
| 실패·복구 | [§13](#tech-failure-boundaries) | [SYS-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-sys-01) |
| Profile·Run binding | [§14](#tech-agent-run-binding) | [AGENT-01–03](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-agent-01) |
| 로컬 저장·내보내기·동기화 | [§15 로컬 저장](#tech-storage-export), [§15.1 `.egdesk`](#tech-portable-bundle) | [DATA-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-data-01) |
| 접근성·동등 control | [§16](#tech-accessibility) | [UX-01](./EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ux-01) |

<a id="tech-desk-lifecycle"></a>

## 1. 저장된 Agenda와 자동 Desk session 복원

저장된 Agenda, 자동 Desk session 복원, live runtime 연속성은 서로 다른
수명주기를 가진다.

```text
저장된 Agenda
  사용자가 명시적으로 저장하고 다시 열 수 있는 재사용 가능한 작업 결합
  자동으로 mount되지 않은 채 Sidebar의 Agenda 영역에 목록으로 표시
  정확한 구성원·필수 field·저장 범위는 HUM-AGENDA-001·Q-AG-02·Q-AG-08에서 미결정
  Agenda 열기는 시작 전제조건이 아니라 사용자 행동

자동 Desk session
  Desk에 열어 둔 상태를 보존하는 로컬 기록
  열린 view·위치·크기·grouping과 그 밖에 결정된 session 세부
  사용자가 Agenda를 한 번도 저장하지 않았어도 존재 가능

live view/runtime 상태
  mount된 Browser·File·Chat·Terminal view
  그 아래 browser context·process·app·connection이 아직 존재하는지 여부
```

기본 topology는 하나의 Desk와 그 Desk에 속한 하나의 Canvas다.

```text
EG-Desk app session
  -> Desk [1]
     -> Canvas [1]
        -> Agenda projection [0..n]
        -> Agenda에 속하지 않은 자동 복원 view [0..n]
```

여러 Saved Agenda는 같은 Canvas에 동시에 열 수 있다. Agenda를 연다는 이유로 기존
Canvas projection을 교체하거나 새 Desk를 만들지 않는다. 이미 열린 Agenda는 그
projection을 재사용해 focus하고, 닫혀 있으면 새 projection을 같은 Canvas에 만든다.
정확한 초기 위치·겹침 회피·활성 표시만 세부 UI 결정으로 남는다. 다중 Desk는
Agenda 분리나 메모리 최적화 수단이 아니다.

위 topology는 사용자가 보는 작업 공간의 관계이며 물리 PC 한 대의 제한이 아니다.
Agenda는 여러 PC에 있는 자료와 실행 자원을 연결할 수 있고 폴더는 그중 하나의 자원이다.
같은 Canvas에서 본다는 이유만으로 PC별 파일 경로·업무 계정·실행 권한·live session을
공유하거나 복제하지 않는다. 실행 위치와 연속성은 [§12](#tech-collaboration-computer-use)를 따른다.

Agenda의 제품 의미는 [HUM-AGENDA-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001),
연결된 세부 항목은 [Q-AG-02](../../docs/codex/egdesk-product-documentation-governance.md#atlas-q-ag-02)와
[Q-AG-08](../../docs/codex/egdesk-product-documentation-governance.md#atlas-q-ag-08)에서 추적한다.

자동 Desk session을 영속화해도 저장된 Agenda가 생성되거나 갱신되지 않는다. 데이터
모델은 두 수명주기를 분리해야 한다. 다만 정상 시작에 recovery wizard, 항목별 출처
badge 또는 눈에 보이는 “Agenda revision 대 recovery journal” 검사 단계가 필요한 것은
아니다.

예상 재실행 흐름은 다음과 같다.

```text
운영체제의 app 진입점에서 EG-Desk 실행
-> 실제 Desk를 첫 제품 표면으로 표시
-> 완료 순서를 강제하지 않는 두 독립 projection 시작
   자동 Desk session
     -> 브라우저 tab/session restore처럼 이전 Desk session에 열어 둔 view 재구성
   저장된 Agenda 영역
     -> Agenda를 mount하지 않고 Sidebar Agenda 목록 채우기
-> 각 하위 resource를 자체 수명주기에 따라 복원
-> 필수 복원 확인 절차 없이 사용자가 계속 작업할 수 있게 함
```

내부 시작 작업의 완료 순서는 제품 우선순위를 뜻하지 않는다. 목록에 나타났다는
이유만으로 저장된 Agenda를 mount해서는 안 된다. 이미 복원된 Desk에서 Agenda를
클릭하면 같은 Canvas에 Agenda projection을 추가하거나 이미 열린 projection을 focus한다.
자동 복원 view와 다른 Agenda projection은 교체하지 않는다.

Agenda 닫기는 단순히 UI만 숨기는 background 전환이 아니다. System은 다음 순서를
하나의 수명주기 전이로 처리한다.

```text
Agenda close
  -> 닫을 Agenda projection과 영향받는 runtime ownership을 먼저 식별
  -> 도달 가능한 제어 경계에서 해당 Agenda만 소유한 runtime의 새 행동·자동 재개를 막고 종료 요청
  -> 종료 확인까지 해당 작업의 Canvas 표현과 종료 진행 상태 유지
  -> 종료가 확인된 Agenda projection 제거
  -> 다른 Canvas projection이 소유·표현하는 shared runtime은 유지
  -> Saved Agenda와 저장된 revision은 유지
```

사용자 또는 Agent의 의미 있는 작업을 Canvas에서 지운 채 hidden registry에서만 계속
실행하는 `close-but-background` 상태는 만들지 않는다. background 실행이 유지되려면
다른 Canvas projection이 그 작업의 소유·상태를 계속 표현해야 한다.
종료 실패나 완료 여부를 확인할 수 없는 작업을 이미 닫혔다고 표시하지 않는다.
원격 제어 경계에 도달하지 못하면 종료 요청과 마지막 확인 상태를 보존한다.
이미 외부로 dispatch한 요청은 접수·완료 여부가 미확인인 경우까지 포함해 로컬 Agenda
닫기로 취소됐다고 간주하지 않는다. 요청과 마지막 확인 상태를 기록한다. shared runtime의 소유 범위와 재개·예약 실행의
세부 종료 의미는 [HUM-SURFACE-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001),
[HUM-ORCH-001](../../docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001)에 남는다.

Browser view 재구성과 Terminal 연속성은 다르다. Browser view는 이전 URL과 사용할
수 있는 browser-session 상태에서 재구성할 수 있다. Terminal은 같은 process 또는
session identity가 검증된 경우에만 재연결됐다고 표현할 수 있다. 새 process 시작은
reconnect가 아니라 revive/relaunch이고, live process 없이 출력만 복원하면 snapshot이다.

Agenda 열기, 복원된 view 닫기, Desk view를 Agenda에 연결하기, Agenda 갱신하기의
정확한 control에는 실제 영역·component·label·gesture와 보이는 상태 전이가
필요하다. 아직 결정되지 않은 control은 포괄적인 “유지”, “폐기”, “저장” 단계로
간주하지 않고 연결된 `Q-*` 상태를 유지한다.

<a id="tech-context-assembly"></a>

## 2. Context 조립

Agent Run은 명시적으로 선택된 Agenda만 사용해서도, Desk 전체를 말없이 주입해서도
안 된다.

context resolver는 다음을 조합한다.

```text
명시적으로 선택한 대화·Task·사용자 선택 항목
가장 잘 맞는 저장된 Agenda
일시적인 Desk grouping과 공간 layout
현재 보이거나 focus된 resource
최근의 관련 상호작용 상태
account·permission·execution scope
```

context resolver는 System service다. 허용된 제품·runtime 상태를 읽고 범위가 제한된
context snapshot을 만든다. 첫 모델 호출 전에는 현재 정책과 자료를 결합하고, 이후
모델 호출 전에는 관련 도구 결과·사용자 조정·새 관찰을 다음 context revision에 포함한다. 이 과정을
Agent가 암묵적인 API 호출로 Desk·Agenda store·layout·account registry를 직접 읽는
것처럼 서술하지 않는다.

공간 grouping·거리·focus·layout은 relevance signal이지 그 자체로 영속 사실이나
증거가 아니다. Run은 어떤 signal과 resource를 선택했는지 기록하여 사용자가
context를 검사하거나 수정할 수 있게 한다.

Agent 담당자 방은 비공개 관계로 남을 수 있다. 작업이 공유 작업 context에 속하면
선택한 메시지·Canvas Memo reference와 그 context만 아직 결정되지 않은 workroom·
Thread·Agenda 관계가 채택한 공유 대화 형태에 연결하거나 옮길 수 있다. 담당자 방
전체 history를 하나의 모델 context나 공유 범위로 취급하지 않는다.

<a id="tech-smart-read"></a>

### 2.1 Context admission과 Smart Read

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

사용자가 메시지를 전송하면 Agent가 다음 중간 또는 최종 대화 메시지를 보낼 때까지
Chat에 애니메이션 ellipsis와 접근 가능한 `Agent 작업 중` label을 표시한다. 이 표시는
navigation affordance이지 영속 domain object도, 숨은 chain-of-thought 표시도 아니다.

사용자가 이 표시를 선택하면 Canvas는 현재 공개 가능한 Agent 활동에 focus한다.
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

Canvas가 제공하는 content mode는 두 가지다.

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

두 mode가 같은 viewer 구현을 재사용할 수는 있지만 view identity는 서로 다르고 같은
Canvas에 공존할 수 있다. `현재 열기`는 Live View를 만들거나 focus하고, `비교`는
의미 있는 비교가 가능할 때 둘을 함께 보여 준다. Answer Briefing은 Snapshot View와
고정 artifact revision을 대상으로 하며, 사람이 직접 다루는 Browser/File view는
Live View로 남는다.

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

Canvas 배치, viewer rendering, 상호작용 가능한 runtime session은 서로 다른
수명주기다. 사용자 또는 Agent의 의미 있는 active·sleeping·historical-snapshot 작업에는
observation·provenance와 선택적인 resource/session reference를 가진, Canvas에서 다시
찾을 수 있는 node가 항상 있어야 한다. 숨은 registry에만 작업을 남겨서는 안 된다.

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

사람에게 보이는 기본 Chat 관계는 Agent/persona별 담당자 방이다. 방의 상대 정체성은
Agent Profile이 제공하지만, 방 history·Profile revision·실제 Agent Runtime·Run과 모델
context는 서로 다른 identity와 수명주기를 가진다. 같은 담당자에게 여러 업무를 맡길 때
history를 어떤 section·filter·업무 reference로 구분할지는 미결정 UI다.

EG-Desk에는 이 기본 관계와 별도로 group chat 또는 thread와 비슷한 상호작용 형태를
가지되 명시적인 EG-Desk context의 지배를 받는 작업 범위 공유 대화 기능이 필요하다.
최종 제품에서 이를 workroom, 일반 Thread, Agenda 연결 대화 또는 다른 Chat relation 중
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
process를 계속 돌리지 않는다. Agenda 전체를 닫을 때는 §1의 ownership 규칙에 따라 그
Agenda만 소유한 process를 종료하고, 다른 projection이 함께 소유한 process만 유지한다.
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

### 12.1 여러 PC의 작업을 같은 Agenda에서 다루기

화면을 보는 PC, 작업을 실행하는 PC, 자료가 있는 위치와 실제 업무 계정을 구별한다.
각 Task·도구 실행과 결과는 실제 실행 위치에 결합되어야 하며, 동일한 파일명이나 경로
문자열만으로 다른 PC의 자료를 같은 자원으로 대체하지 않는다. 참가자를 초대하거나
PC를 연결했다는 사실만으로 그 PC의 모든 파일·프로그램·계정을 사용할 권한이 생기지 않는다.

- 같은 Agenda의 작업이 여러 PC에서 진행되어도 각 작업의 대상·실행 위치·마지막 확인
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
  다른 작업으로 전환된 실행을 자동 재활성화하지 않는다.
- `.egdesk` 가져오기는 허용된 자료·맥락의 반입이다. 원격 PC 연결, 실행 권한 부여,
  살아 있는 process의 재연결 또는 작업 재실행을 대신하지 않는다.

기기 발견·연결 방식, 실행 배치 알고리즘과 통신 프로토콜은 구현 재량이다. 자동 배치가
기존 위임·계정·비용·자료 이동 범위를 넘으면 그 종속 행동만 해당 권한 결정에 따른다.

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

Agent Profile은 재사용 가능하고 version이 있는 configuration이다. display identity·
personality·instructions·provider/model policy·candidate tool과 capability ceiling·
context와 memory policy·credential-handle policy·Ontology policy·execution limit·
delegation ceiling을 기술할 수 있다. Profile은 실행 중인 Agent, Chat conversation,
account credential 또는 resource authority grant가 아니다.

System은 Run의 시작 조건과 각 모델 호출에 실제 전달한 구성을 기록한다. 과거 기록은
불변이지만 진행 중인 업무의 context는 새 관찰과 사용자 조정을 반영한다.

```text
Run identity와 출발 조건
  최초 요청 또는 parent-Task delegation, 선택한 Profile·Engine,
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
| EG-Desk product identity | local owner, 향후 collaborator | Desk·Agenda·local sharing scope |
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

browser 기반 login 경로는 다음과 같다.

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
object store에 둘 수 있다. reference 기반 retention은 Saved Agenda·Answer Briefing·
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
Canvas·Snapshot·Agenda reference를 다시 여는 것으로 완료를 증명한다. 원격 backup 또는
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
