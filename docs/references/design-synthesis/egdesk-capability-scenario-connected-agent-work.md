# EG-Desk 기술 Capability 시나리오 — 연결된 Agent 업무

**문서 목차**: [읽는 목적별 안내](../../README.md#docs-start) · **구체 화면 검토**: [사용 흐름·UI 추천안](./egdesk-ux-realization-proposals.md#ux-proposals-top)

- **document_authority**: `NON-CANONICAL REFERENCE`
- **synthesis_status**: `DESIGN-SYNTHESIS / PM-PROPOSAL`
- **implementation_status**: `NOT-VERIFIED`
- **evidence_base**: 32개 RWS, Browser·Multi-agent·Multi-device 횡단 분석
- **excluded_scope**: 특정 포털·ERP의 메뉴, 필드, 법규 절차와 사이트별 adapter

이 문서는 실제 업무 대화를 제품 기능으로 바로 승격하지 않는다. 사용 상황, UX 상태 전환,
기술 환경, Agent 설정, connection과 복구 계약을 주어로 삼고 여러 실제 업무 사례를 설명
근거로 사용한다. 구체 UI는 이 시나리오에서 파생하되 이 문서가 먼저 확정하지 않는다.
`ECS-*`와 `CAP-*`는 이 문서의 탐색 ID이며 EG-Desk 제품 객체가 아니다.

제품 동작은 [사용자 매뉴얼 Atlas](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md),
기술 보장은 [기술 Contract](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md),
제품 질문·결정의 현재 상태는 [사용자 확인 원장](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md),
세부 조사·문서 운영은 [Documentation Governance](../../codex/egdesk-product-documentation-governance.md)에 있다.
이 문서는 이들을 덮어쓰지 않는다.

현재 요구의 반영 상태와 기능 결합의 미결정 후보는
[§10 니즈 충돌과 미확정 요구 후보](#needs-review)에 정리되어 있다.
각 후보를 단계별 조작·화면 반응·추천 기본값으로 전개한
[연결된 사용 흐름과 UI 추천안](./egdesk-ux-realization-proposals.md#ux-proposals-top)이 이어진다.

## 1. 문서 층과 읽는 방향

```text
실제 업무 evidence: RWS-0001~0032
              ↓
사용 상황 시나리오: ECS-01~07
              ↕
횡단 기술 보장: CAP-01~13
              ↓
UX flow: 정보·판단·feedback·회복
              ↓
UI design: component·layout·label·interaction·accessibility
              ↓
Atlas/manual 후보 / Contract requirement 후보
              ↓
향후 구현·runtime 검증

특정 포털·ERP 메뉴/필드 harness는 이후 별도 층
```

| 층 | 역할 | 이 문서에서의 위치 |
|---|---|---|
| RWS | 실제로 관찰된 업무·실패·교정·증거 | [실업무 evidence corpus](../real-work-scenarios/README.md) |
| ECS | 개발의 주축이 되는 사람의 상황·목표·판단·상태 흐름 | §4 |
| CAP | 여러 ECS를 가로지르는 기술 경계와 설정·connection·복구·완료 계약 | §5 |
| UX·UI | ECS에서 파생한 구체 조작·화면 반응과 추천·대안 | [9개 사용 흐름](./egdesk-ux-realization-proposals.md#ux-proposals-top) |
| Domain harness | 특정 서비스의 메뉴·필드·사이트 규칙 | 현재 비목표 |

RWS의 업무명은 시나리오의 주어가 아니다. 예를 들어 세무·고용·메일 사례는
`외부 효과 승인·receipt·현재 상태` capability를 설명하는 서로 다른 evidence다.

## 2. 전체 기술 연결 지도

```text
사용자
  │
  ├─ Agent Profile ── personality / role / instructions / tool ceiling
  │        │
  │        └─ AI Engine Profile ── account / plan / preferred model / quota
  │                    │
  │                    └─ Run Identity / Policy Envelope
  │                         ├─ Ontology Resolver / Resolution Receipt
  │                         ├─ Turn Context Revision / Reader Session
  │                         ├─ Task graph / Worker / Critic
  │                         ├─ Browser·File·Terminal·Connector binding
  │                         ├─ authority / approval / control lease
  │                         └─ checkpoint / event ledger / evidence / receipt
  │
  ├─ Chat ── 담당 Agent와의 관계·요청·설명·경량 진행 상태 ↔ Canvas 대상
  ├─ Canvas ── Live·Snapshot·artifact·Task·evidence
  ├─ Ontology 운영 ── candidate / semantic diff / ACL probe / promotion / rollback
  └─ Answer Briefing ── 사용자가 제어하는 결과 focus 순서
```

### 분리해야 하는 상태

- Browser profile·로그인 account·Agent Profile·AI Engine account는 다른 identity다.
- Profile 저장·세션 발견·실제 Run 활성화는 다른 완료 상태다.
- connection이 healthy하다는 사실은 외부 action이 접수됐다는 증거가 아니다.
- View focus와 live-surface input lease는 다른 상태다.
- 파일 변경·정본 적용·commit·push·deploy·current verification은 다른 상태다.
- Agent contribution·integration PASS·owner acceptance·provider receipt·business completion은
  다른 완료 상태다.

## 3. Agent 설정과 실행 binding

### 사용자가 설정하고 version을 관리하는 값

| 설정 묶음 | 최소 필드 | 경계 |
|---|---|---|
| Agent Profile | `profile_id`, 이름, owner scope, role, purpose, non-goals, personality, instructions revision, preferred model·fallback policy, tool ceiling, context·memory·Ontology policy, delegation ceiling | Profile 전체는 업무 기본값일 뿐 account/resource permission이나 approval을 만들지 않는다 |
| AI Engine Profile | provider, opaque account ref, auth mode, plan·quota summary, isolated runtime revision, credential handle, default scope | 로그인 계정과 앱 사용자 계정은 다를 수 있다; model 선택 정책은 Agent Profile에 둔다 |
| Connection 설정 | service, account·tenant·Browser profile ref, tool version, declared capability, action별 permission ceiling, expiry·revocation | 설치·선언 capability는 현재 availability가 아니다 |
| System 관찰 상태 | Engine health, verified-at, available model set, Connection current availability, last capability probe | 사용자가 저장하는 설정이 아니라 시점이 있는 관찰값이다 |

실행 검사에는 안전한 지침 요약, revision, hash와 적용 순서를 제공하며 credential 원문은
노출하지 않는다. role·personality·instructions·model policy·tool ceiling을
포함한 어떤 Profile 문구도 실제 account/resource authority를 확대하지 못한다.

### Run 요청부터 첫 Agent turn까지

사용자가 Ontology revision 번호를 직접 입력해야 새 Run이 시작되는 구조로 가정하지 않는다.
사용자가 새 요청을 보내면 System은 첫 model call 전에 조직·Desk·선택한 Agent의 정책을 따라
현재 사용할 Ontology와 업무 context를 resolve한다. 여기서 `사용했다`는 말은 이 초기화가
끝나 실제 model call에 전달됐다는 사후 표현이다.

| 순서 | System이 하는 일 | Agent 상태 | 남기는 기록 |
|---:|---|---|---|
| 1 | 새 업무인지 이전 업무 계속인지와 선택한 Agent·Board·자료를 포함해 Run request를 만든다 | 아직 호출되지 않음 | 원 요청, requester, Run ID, 새 업무/계속 의도 |
| 2 | 계속 업무라면 이전 checkpoint·미완료 단계·결과·evidence를 찾고 현재 접근 가능성을 다시 확인한다 | 아직 호출되지 않음 | resume source, 이전 Run·Task ref, current availability |
| 3 | Agent Profile, AI Engine account, 실제 model·tool availability와 authority를 resolve한다 | 아직 호출되지 않음 | resolved configuration과 관찰 시각 |
| 4 | 조직·Agent의 Ontology binding policy에서 active ref를 찾고, 이번 요청에 필요한 부분을 retrieve한다 | 아직 호출되지 않음 | active ref, retrieved units, source revision, coverage·unknown |
| 5 | 요청, 복원된 업무 상태, 선택 자료, Ontology context와 도구 상태를 첫 `Turn Context Revision`으로 조립한다 | 아직 호출되지 않음 | 첫 model call에 실제 전달한 application payload의 manifest |
| 6 | 첫 model call을 실행한다 | 이 시점부터 업무를 해석·계획·도구 사용 | model response와 후속 action intent |

`active Ontology ref`는 특정 database 제품을 전제하지 않는 논리적 참조다. 구현에 따라
Git commit, content-addressed manifest, object snapshot, 파일 집합의 hash, graph revision 또는
database version일 수 있다. System은 승인된 active ref를 찾아 무결성·접근권한을 확인할 뿐,
지식을 임의로 작성하거나 의미를 자동 확정하지 않는다. 사용자가 과거 revision을 재현하거나
candidate를 평가하는 경우에만 명시적으로 기본 binding을 바꾼다.

`변화를 안다`는 것도 항상 켜진 database watcher가 지식의 의미를 감시한다는 뜻이 아니다.
사용자 추가 지시, Agent의 tool read 결과, collaborator event, source adapter가 돌려준 ETag·hash,
다음 action 전 revalidation 중 하나가 새 상태를 관찰하면 System이 그 관찰을 구조화해 다음
turn에 연결한다. 어떤 저장 기술을 사용할지는 후속 기술 설계에서 결정한다.

### 출발 기록과 turn별 조정

Run은 시작 상태에 얼어붙지 않는다. 출발 당시 실제 조건은 이력으로 보존하되, Agent가
도구 결과·사용자 교정·다른 참여자의 변경·새 Ontology 근거를 발견하면 다음 turn의 context가
달라질 수 있다.

여기서 `turn`은 Chat bubble 하나만 뜻하지 않는다. 한 번의 사용자 요청 안에서도
`model call → tool action → tool result → 다음 model call`이 여러 번 반복될 수 있으며,
각 model call 직전에 새 Context Revision을 조립한다. 실행 중 도착한 사용자 조정도 가능한
가장 이른 다음 model call에 포함한다.

| 상태 묶음 | 역할 | 변경 방식 |
|---|---|---|
| Run Identity | Run ID, parent·fork 관계와 최초 요청을 식별 | 같은 업무 lineage에서 유지; 과거 기록은 덮어쓰지 않음 |
| Run Policy Envelope | 시작 시 적용한 Agent·Engine policy, authority ceiling, budget·sandbox·delegation 제한 | routine observation으로 재생성하지 않으며 명시적 policy 변경은 새 사건으로 연결 |
| Ontology Resolution Receipt[n] | 어떤 organization·Agent policy가 어느 active ref와 unit을 resolve했고 권한·무결성을 언제 확인했는지 증명 | first call 전에 필수; 이후 freshness가 달라지면 새 receipt 추가 |
| Turn Context Revision[n] | 해당 model/tool turn이 실제로 받은 대화·조정·도구 관찰·관련 Ontology unit·source revision | model call마다 필요한 범위로 다시 조립하고 이전 revision은 보존 |
| Working state | 현재 계획, 완료·미완료 단계, child Task, 임시 가설 | Agent와 사용자의 정상적인 업무 진행에 따라 갱신 |
| Live resource observation | 파일·Browser·외부 서비스·권한의 현재 관찰 | action 직전 또는 필요 시 재조회 |
| Action Safety Gate | exact action·account·target·authority·write lease·idempotency 확인 | 안전 경계가 깨진 해당 action·Task branch만 차단 |
| Attempt·fork | 실패한 model/tool execution의 실제 재시도 또는 의도적 분기 | 일상적인 context 조정에는 만들지 않음 |

일반적인 조정은 다음 Run이나 새 attempt를 기다리지 않는다.

```text
Agent tool 결과·사용자 추가 지시·타 참여자 변경이 도착
→ 출처·시각·대상을 작업 사건 이력에 추가
→ Context resolver가 다음 turn에 필요한 변경분을 포함
→ Agent가 같은 Run의 다음 turn에서 계획과 행동을 조정
```

관련 작업을 자동으로 일시 중지하는 것은 기본 동작이 아니다. 다음처럼 그대로 실행하면
외부 피해나 동시 쓰기 충돌이 생길 수 있는 안전 경계에서만 해당 action을 막고 재확인한다.

- 송금·제출·발송·삭제처럼 되돌리기 어려운 외부 effect의 target·payload가 달라짐
- account·authority·approval·secret handoff가 바뀜
- 같은 resource에 다른 actor가 동시에 쓰고 있어 single-writer 조건이 깨짐
- 사용자가 회수한 input lease로 Agent가 계속 물리 입력하려 함

### 작업 사건 이력

작업 사건 이력은 Chat transcript의 다른 이름이 아니다. Chat은 사람과 Agent가 주고받은
메시지이고, 작업 사건 이력은 System이 복구·협업·중복 실행 방지·근거 연결에 사용하는
구조화된 사건 원장이다. 과거 사건을 수정하는 대신 정정·회수·대체 사건을 뒤에 추가한다는
구현 성질을 `append-only`라고 부른다.

| 사건 종류 | 최소 필드 |
|---|---|
| Context adjustment·observation | actor·source·observed-at, 이전/새 revision, 변경 요약, 다음 turn 포함 여부, 영향받은 action |
| Approval | approval·action-intent ID, exact targets, requester·approver, account, diff·payload, impact, prohibited action, decision·decided-at, validity·expiry, revocation, idempotency link, required receipt |
| Handoff | packet ID, from/to actor·device, base/current source revision, external-state observed-at, shared/excluded state, local-only dependency, authority matrix, pending action, offline·conflict policy, resume guard, acceptance receipt |
| External effect | action intent, executor, target·account, dispatched-at, provider receipt, current-state check, unknown·contradiction |
| Completion evidence | claim, stage, artifact revision, method, actor·account·device, observed-at, receipt, freshness, contradiction, unknowns, remaining risk |

현재 상태는 원장을 model context에 통째로 넣어 얻지 않는다. System이 관련 사건과 현재
관찰만 골라 다음 Turn Context Revision에 넣으며, Agent는 그 범위에서 업무를 이어간다.

## 4. 연결된 업무 이야기 7개

이 층은 사용 상황과 UX 상태 전환을 정한다. button·menu·panel 같은 component, 화면 배치,
정확한 레이블, pointer·keyboard 조작은 아직 정하지 않는다. 구체 UI를 먼저 적으면 사용자의
판단 흐름보다 현재 떠올린 component에 설계가 끌려갈 수 있기 때문이다.

```text
ECS: 상황·목표·판단·상태 전환
 → UX flow: 정보 우선순위·feedback·오류 회복
 → UI design: component·layout·label·motion·pointer·keyboard·focus
 → 사용자 매뉴얼: 확정 UI를 기준으로 실제 클릭·타이핑 순서
```

아래 `사용자 판단·행동`은 의미 수준의 행동이다. 예를 들어 `재개 방식을 선택한다`는 UX는
필요하지만 그것이 button인지 menu인지 command인지 아직 결정하지 않는다.

이 열의 판단마다 사용자 응답을 기다리는 것은 아니다. 기존 위임·정책 안의 조회, 읽기
라우팅, 작업 분할·검토와 안전한 복구는 Agent·System이 진행한다. 사용자는 필요할 때
살펴보고 조정할 수 있다. 추가 제품 결정이나 실제 권한·비용·전송 범위의 확대가 필요한
분기에서만 사람의 결정을 기다린다. Worker·Critic·Integrator는 필요한 책임을 설명하며
작업마다 별도 Agent를 하나씩 생성하도록 강제하는 고정 조직도가 아니다.

### ECS-01 — 새 기기나 새 세션에서 전날 업무를 재개한다

- **업무 이야기**: 사용자가 전날 검토하던 자료와 담당 Agent를 다시 열어 이어서 일한다.
- **주 capability**: CAP-01, CAP-06, CAP-09, CAP-10
- **비목표**: 특정 서비스 로그인 메뉴나 파일 경로

| # | 사용 상황·필요 | 사용자에게 필요한 정보 | 사용자 판단·행동 | System 책임 | Agent 책임 | 상태 전환·증거 | 예외·회복 |
|---:|---|---|---|---|---|---|---|
| 1 | EG-Desk를 새 UI/runtime 세션에서 연다 | 이전 Desk에 열려 있던 View와 각각의 복원 가능 상태 | 이어갈 업무를 찾는다 | Desk session 기록을 복원하되 Agent를 아직 호출하지 않는다 | 없음 | view restored/degraded와 확인 시각 | 복원 불가 View는 위치와 identity를 잃지 않은 대체 상태로 남음 |
| 2 | 저장된 Board와 실제 진행 중이던 업무를 구분한다 | Board에 저장된 범위, 당시 열려 있던 임시 배치, Task·Run checkpoint | 이어갈 Task를 선택한다 | 선택한 Task의 이전 Run·checkpoint·결과·미완료 단계를 조회한다 | 없음 | resume source와 이전 실행 lineage | 과거 Chat만 보고 진행 단계를 추측하지 않음 |
| 3 | 이전 작업 당시와 현재 환경을 비교한다 | 업무에 영향을 주는 account·tool·resource 차이; 과거 binding과 snapshot은 상세 검사 가능 | 필요한 차이만 검토하고 방향을 조정할 수 있다 | 현재 상태를 재확인한다. 호환 가능한 갱신은 자동 반영하고 선택이 필요한 차이만 제시한다 | 없음 | previous/current comparison | 정상 재진입에 모든 revision 비교·확인 절차를 요구하지 않음 |
| 4 | 현재 세션에서 이어갈 조건을 정한다 | 사용할 Agent, 현재 가능한 Engine·tool, 기본 Ontology policy와 권한 차이 | 재개 범위와 필요한 변경을 확정한다 | 선택을 continuation request에 기록하고 첫 model call 전 binding을 resolve한다 | 없음 | continuation request·resolved configuration | account·authority 불일치는 해당 행동 범위만 제한 |
| 5 | 필요한 과거 맥락을 복원한다 | 완료·미완료 단계, 결과·evidence, 원 source와 현재 source의 차이 | 추가로 포함하거나 제외할 맥락을 조정한다 | 관련 checkpoint·사건·자료만 Context Packet으로 조립한다 | 아직 호출되지 않음 | coverage·unknown·source revisions | 전체 과거 Chat을 무조건 주입하지 않음 |
| 6 | 이어지는 첫 turn을 시작한다 | 복원 범위와 현재 실행 조건 | 업무를 계속하도록 요청한다 | 현재 active Ontology를 resolve하고 다음 Turn Context Revision을 만든다 | 전달된 이전 상태와 현재 관찰을 구분해 다음 단계를 수행한다 | same Task·Run lineage의 continuation turn | first model call 전 resolve 실패 시 실행하지 않고 부족한 조건을 알림 |
| 7 | 재개 후 새로운 사실이 도착한다 | 무엇이 언제 누구에 의해 바뀌었고 현재 계획에 어떤 관련이 있는지 | 필요하면 방향을 추가로 조정한다 | 변경 사건을 기록하고 다음 turn context에 관련 부분을 포함한다 | 같은 Run의 다음 turn에서 계획을 자연스럽게 조정한다 | context adjustment lineage | 안전 경계가 깨지지 않으면 pause·새 attempt를 만들지 않음 |

### ECS-02 — 자료 묶음을 담당 Agent에게 검토 요청한다

- **업무 이야기**: 사용자가 여러 자료를 선택해 담당 Agent에게 비교·검토를 요청한다.
- **주 capability**: CAP-01, CAP-02, CAP-08
- **비목표**: 특정 문서 형식의 domain parser 세부사항

| # | 사용 상황·필요 | 사용자에게 필요한 정보 | 사용자 판단·행동 | System 책임 | Agent 책임 | 상태 전환·증거 | 예외·회복 |
|---:|---|---|---|---|---|---|---|
| 1 | 담당 Agent에게 새 검토 업무를 맡긴다 | Agent identity, 역할·범위와 현재 사용 가능한 Engine·tool | 담당자를 선택한다 | 관계 대화만 열고 아직 Run을 만들지 않는다 | 없음 | selected Agent Profile | Profile이 stale하면 실행 전 차이를 알림 |
| 2 | 검토할 자료 범위를 정한다 | source별 identity·권한·Live/Snapshot·예상 크기 | 자료를 포함·제외하고 검토 의도를 설명한다 | 최소 context 후보와 Reader 필요성을 계산한다 | 없음 | selected source set·read intent | 권한 없는 source는 이유와 함께 제외 |
| 3 | 요청을 보낸다 | 최종 요청, 선택 자료, 새 업무 여부 | 요청 내용을 확정한다 | Run request를 만들고 Agent·Engine·active Ontology를 resolve한 뒤 첫 Turn Context Revision을 조립한다 | 아직 호출되지 않음 | request·resolved binding·actual first payload | resolve되지 않은 필수 조건은 first model call 전에 알림 |
| 4 | 자료를 판독한다 | direct read/Reader 사용 여부, coverage와 읽기 오류 | 필요한 경우 판독 방향이나 범위를 보정한다 | context budget과 Reader Session을 관리하고 실제 전달 범위를 기록한다 | 전달받은 자료를 해석하되 최종 비교·판단의 소유권을 유지한다 | source snapshot·coverage·Context Packet | 단일 source 오류는 가능한 다른 분석을 불필요하게 막지 않음 |
| 5 | Agent가 도구를 사용하며 중간 사실을 발견한다 | 어떤 resource를 관찰했고 새 사실이 기존 계획을 어떻게 바꾸는지 | 추가 지시·교정을 같은 업무에 보낸다 | 새 관찰과 사용자 조정을 다음 Turn Context Revision에 포함한다 | 같은 Run의 다음 turn에서 검색·계획·설명을 조정한다 | context adjustment·tool observation | routine adjustment에는 pause·새 attempt 없음 |
| 6 | 사용자가 실행 자체를 멈추고 싶다 | 멈출 action, 보존될 결과와 이미 발생한 외부 effect | 중지를 명시한다 | 새 tool action을 막고 현재 evidence와 working state를 보존한다 | 더 이상 action을 요청하지 않는다 | stopping→stopped | 재개 시 현재 상태를 다시 resolve |
| 7 | 결과를 검토한다 | 대화형 설명, Canvas 결과, source·Snapshot·현재 상태의 관계 | 근거를 탐색하고 필요한 후속 질문을 정한다 | 같은 Answer revision과 provenance를 연결한다 | 매체에 맞는 Answer·evidence 구성을 제안한다 | Answer revision·remaining unknown | 한 projection 실패 시 다른 결과는 유지 |

### ECS-03 — Agent가 live surface를 조작하고 사용자가 지켜본다

- **업무 이야기**: Agent가 Browser나 외부 앱에서 반복 입력을 수행하고 사용자는 다른 일을 한다.
- **주 capability**: CAP-05, CAP-06
- **비목표**: 사이트별 selector와 메뉴 순서

| # | 사용 상황·필요 | 사용자에게 필요한 정보 | 사용자 판단·행동 | System 책임 | Agent 책임 | 상태 전환·증거 | 예외·회복 |
|---:|---|---|---|---|---|---|---|
| 1 | Agent가 조작할 live surface가 있다 | instance·account·tab/frame·renderer·observation revision | 대상과 계정이 맞는지 확인한다 | surface identity와 현재 semantic capability를 resolve한다 | 아직 입력하지 않음 | surface envelope | 잘못된 profile·target이면 입력 불가 |
| 2 | 조작 방식이 여러 개다 | 격리/API/semantic action/물리 입력의 차이와 사용자 업무에 미치는 영향 | 허용할 실행 방식을 결정한다 | 물리 입력이 필요한 범위와 cursor·focus 점유 여부를 설명한다 | 선택된 방식 안에서 계획한다 | selected execution mode | 가능한 비간섭 방식이 있으면 우선 제시 |
| 3 | Agent에게 입력을 맡긴다 | controller, 대상·범위·만료와 중지 가능성 | live input을 위임한다 | single-writer input lease를 부여한다 | 위임된 target·시간·action 범위 안에서만 입력한다 | active lease owner | 기존 lease와 충돌하면 시작하지 않음 |
| 4 | Agent가 한 단위 행동을 수행한다 | 예상 action과 실제 화면 변화 | 필요할 때만 관찰한다 | action 뒤 event를 기다리고 target을 재관찰한다 | 관찰 결과를 같은 Run의 다음 turn에 반영한다 | before/after observation | stale handle이면 재관찰 후 계획 조정; 바로 새 attempt를 만들지 않음 |
| 5 | 사용자가 같은 surface에 물리 입력한다 | 사용자 입력이 Agent action과 충돌하는지 | 직접 작업하거나 제어를 계속 맡길지 결정한다 | 동일 target의 human input을 감지하면 Agent의 추가 물리 입력만 양보시킨다 | 이미 얻은 관찰을 보존하고 대기·재계획한다 | lease yielded/reclaimed | 다른 surface의 사용자 작업은 불필요하게 중단시키지 않음 |
| 6 | 보안 입력이나 OS 승인이 필요하다 | Agent가 처리할 수 없는 secret·권한 단계와 이후 재개 조건 | 사용자가 해당 단계만 직접 완료하거나 거부한다 | secret을 Agent context에 넣지 않고 완료 뒤 account·target을 재검증한다 | 안전한 다음 단계부터 이어간다 | handoff·reverified target | 닫기·거부를 승인으로 간주하지 않음 |
| 7 | 사용자가 전체 Agent 입력을 즉시 멈추고 싶다 | 현재 입력 주체와 이미 발생한 외부 effect | 긴급 중지를 명시한다 | 모든 Agent input lease를 즉시 회수한다 | 추가 입력을 중단한다 | stop receipt | 이미 발생한 외부 effect의 rollback은 별도 판단 |

### ECS-04 — 작업 중 새 권한이나 외부 효과가 필요해진다

- **업무 이야기**: Agent가 외부 전송·공개·업로드 직전까지 준비하고 사용자 결정을 기다린다.
- **주 capability**: CAP-05, CAP-07
- **비목표**: 특정 기관의 신청 form

| # | 사용 상황·필요 | 사용자에게 필요한 정보 | 사용자 판단·행동 | System 책임 | Agent 책임 | 상태 전환·증거 | 예외·회복 |
|---:|---|---|---|---|---|---|---|
| 1 | Agent가 외부 전송·제출·공개·삭제 직전까지 준비했다 | exact target·account·payload diff·가역성·비용과 아직 실행되지 않았다는 상태 | 승인 범위를 검토한다 | 해당 action branch만 approval-required로 두고 다른 독립 작업은 계속시킨다 | 승인 전 외부 effect를 발생시키지 않는다 | validated draft | 준비 완료를 실행 완료로 표시하지 않음 |
| 2 | 기존 authority와 새 승인을 구분해야 한다 | provider/OS/resource permission과 이번 action approval의 차이 | 부족한 권한을 직접 연결할지, 기존 권한 안에서만 결정할지 판단한다 | account/resource authority와 action approval을 별도 검증한다 | 자신에게 없는 권한을 Profile 문구로 확대하지 않는다 | authority state·pending decision | 새 permission 뒤 다음 action 전 현재 account·target 재확인 |
| 3 | 사용자가 action을 허용하거나 거부한다 | 대상·payload·유효기간·회수 가능성 | 한 번·범위 내 허용 또는 거부를 명시한다 | exact action intent와 decision을 기록하며 새 resource authority를 만들지 않는다 | 허용된 범위만 executor에게 넘긴다 | authorized/denied | 화면을 닫거나 무응답인 상태는 승인 아님 |
| 4 | 승인 뒤에도 대상 상태가 바뀔 수 있다 | 승인 당시와 실행 직전 target·payload·account 차이 | 변경됐으면 새 범위를 다시 판단한다 | irreversible action 직전 safety gate에서 precondition을 재검증한다 | routine context 변화에는 적응하되 승인 범위를 넘는 action은 요청하지 않는다 | gate passed/blocked | mismatch인 해당 action만 멈추고 같은 Run의 다른 업무는 계속 |
| 5 | 외부 action이 실행된다 | dispatched·provider accepted·processing의 구분 | 자동 진행을 관찰한다 | idempotency와 exact target으로 실행하고 provider receipt를 저장한다 | receipt를 업무 완료로 과장하지 않는다 | action intent·provider receipt | timeout·unknown이면 query-before-replay |
| 6 | 현재 업무 상태를 확인한다 | provider receipt와 현재 처리·업무 반영 상태 | 필요 시 현재 상태를 다시 확인한다 | provider를 재조회하고 receipt와 current state를 비교한다 | 차이와 남은 위험을 설명한다 | current-state evidence | 불일치면 이전 완료 verdict를 stale 처리 |

### ECS-05 — 연결 또는 Agent 실행이 끊긴 뒤 다시 들어온다

- **업무 이야기**: 작업 중 연결이 끊겼지만 이미 만든 결과는 보존하고 실패한 경계만 복구한다.
- **주 capability**: CAP-06, CAP-09, CAP-11
- **비목표**: 모든 장애의 자동 원인 확정

| # | 사용 상황·필요 | 사용자에게 필요한 정보 | 사용자 판단·행동 | System 책임 | Agent 책임 | 상태 전환·증거 | 예외·회복 |
|---:|---|---|---|---|---|---|---|
| 1 | 연결·runtime·provider 중 하나에서 오류가 드러난다 | 마지막 정상 관찰, 최초 단절, 영향받은 action·Task와 보존된 결과 | 복구 상세를 확인한다 | view/runtime/transport/process/provider 경계를 각각 probe한다 | 관찰되지 않은 root cause를 단정하지 않는다 | last checked·affected scope | 무한 spinner 대신 확인된 경계와 unknown 표시 |
| 2 | 가능한 복구 경로가 여러 개다 | 같은 process/session 재연결, 새 실행, snapshot-only, 중지의 의미 차이 | 원하는 복구 결과를 선택한다 | identity와 보존 가능한 상태를 확인한다 | 선택된 범위에서 계획을 조정한다 | same/new/degraded identity | 동일성 확인 불가 상태를 같은 세션이라고 표시하지 않음 |
| 3 | 단절 직전 외부 action이 있었을 수 있다 | last action intent와 provider receipt·현재 상태 | 조회 결과를 확인하고 필요할 때만 후속 선택에 개입한다 | 허용된 read-only query-before-replay를 자동 수행한다 | unknown 상태에서 같은 action을 임의 재실행하지 않는다 | duplicated/not found/unknown | unknown이면 해당 action만 보류 |
| 4 | checkpoint에서 업무를 이어간다 | 보존 artifact, 최신 Turn Context Revision, pending action·safety state와 이후 source/Ontology 변화 | 현재 변화까지 포함해 계속하도록 한다 | checkpoint와 사건 이력을 복원하고 다음 turn context를 새로 조립한다 | 같은 Run의 다음 turn에서 자연스럽게 계획을 조정한다 | resumed context lineage | routine 변화에는 새 attempt를 만들지 않음 |
| 5 | 실제 실패한 execution을 다시 시도해야 한다 | 실패한 model/tool execution, 동일 target 여부와 retry 영향 | 재시도·분기·중지를 결정한다 | 실제 retry에만 새 attempt lineage를 만든다 | 이전 실패와 새 실행을 구분한다 | new attempt only when retried | 성공한 sibling 결과와 과거 evidence 보존 |
| 6 | 복구 결과를 검토한다 | recovered/degraded/unknown과 남은 영향 범위 | 업무를 계속하거나 별도 조사를 요청한다 | recovery receipt와 현재 상태를 연결한다 | 확정 가능한 범위만 설명한다 | recovery outcome | 미확정 원인은 그대로 유지 |

### ECS-06 — 여러 Agent가 나눠 일하고 사용자가 결과를 검토한다

- **업무 이야기**: Reader Session이 Context Packet을 공급하고, Worker·Critic·Integrator가 역할을 나눠 하나의 결과를 만든다.
- **주 capability**: CAP-03, CAP-04, CAP-08, CAP-12, CAP-13
- **비목표**: Agent 수가 많을수록 좋다는 가정

| # | 사용 상황·필요 | 사용자에게 필요한 정보 | 사용자 판단·행동 | System 책임 | Agent 책임 | 상태 전환·증거 | 예외·회복 |
|---:|---|---|---|---|---|---|---|
| 1 | 하나의 요청 안에 독립·종속 작업이 섞여 있다 | 담당 Agent가 제안한 Task 경계, dependency와 단일 writer가 필요한 영역 | 자동 진행을 확인하거나 필요하면 경계를 조정한다 | Agent가 제안한 task graph와 resource ownership을 기록·검증한다 | 담당 Agent가 작업을 분할하고 기존 위임 범위 안에서 진행한다 | proposed graph→authorized dispatch | 긴밀한 작업을 억지로 병렬화하지 않으며 일반 분할마다 승인을 요구하지 않음 |
| 2 | 여러 Agent가 업무를 시작한다 | 각 Task의 owner·dependency·source·write set·완료 조건 | 진행 범위와 위임 상태를 확인한다 | child lifecycle·lease·checkpoint를 관리한다 | Worker는 받은 context와 resource 범위만 사용한다 | exact dispatch | Agent 관계 대화와 Task 감독 상태를 혼동하지 않음 |
| 3 | 독립 Task가 병렬로 진행된다 | 진행·blocked·checkpoint·artifact revision과 새 조정사항의 반영 여부 | 필요하면 같은 parent 업무에 추가 지시를 준다 | 관련 child의 다음 turn context만 갱신한다 | 각 Worker가 자기 다음 turn에서 조정한다 | contribution-ready | slot 부족은 순차 wave로 전환 |
| 4 | 후보 결과에 독립 검토가 필요하다 | candidate revision, 검토 source·제외 context와 finding | 검토 진행을 확인하거나 남은 제품 판단에 답할 수 있다 | 적용 중인 검토 정책과 finding disposition을 보존한다 | 검토자는 finding을 반환하고 담당 Agent가 위임 범위의 수정·재검토를 처리한다 | review result·disposition | 모든 업무에 별도 Critic을 강제하지 않으며 검토 대상 변경 시 영향받은 판단을 재확인 |
| 5 | 일부 Task만 실패하거나 방향이 틀렸다 | 실패 원인, 영향받은 dependency와 보존 가능한 sibling 결과 | 필요한 경우 해당 branch를 중지하거나 방향을 조정한다 | 재시도·재할당 범위와 기존 결과 연결을 검증한다 | 담당 Agent가 기존 위임·예산 안에서 해당 branch의 복구를 계획한다 | preserved siblings·new dispatch | 범위 확대가 필요한 결정만 사용자에게 요청 |
| 6 | Integrator가 하나의 결과를 만든다 | contribution별 source·revision, unresolved finding과 remaining risk | 통합 결과와 근거를 검토한다 | 하나의 Answer revision과 provenance를 연결한다 | contribution을 대화 설명과 Canvas 산출물로 구성한다 | integration-verified | 완료 계약을 충족하지 못한 부분은 UNKNOWN으로 유지 |
| 7 | 사용자가 결과를 단계적으로 이해하고 싶다 | 설명 단계의 순서, 현재 단계와 연결된 Canvas 대상 | 안내된 설명 흐름을 시작한다 | 기존 Answer에 presentation state만 만든다 | 새 분석을 시작하지 않고 확정된 Answer를 설명한다 | same Answer·presentation active | 시작 자체는 새 Run이 아님 |
| 8 | 설명의 앞뒤 단계나 특정 단계로 이동한다 | 현재 위치, 전체 단계 목록, 각 대상의 available/stale 상태 | 다음·이전·특정 단계·전체 맥락으로 이동한다 | 선택된 단계의 target과 overview를 resolve한다 | 없음 | selected step·same Answer | stale target이면 당시 Snapshot·원 source·설명을 대안으로 제공 |
| 9 | 사용자가 특정 단계에 의견을 남긴다 | 의견이 연결될 Answer·step·target revision | 의견을 작성하고 다음 요청에 포함할지 결정한다 | reference를 검증해 draft 상태로 보존한다 | 실제 후속 요청 전에는 실행하지 않는다 | comment draft·validated reference | target이 사라졌으면 재연결·제외 선택을 제공 |
| 10 | 단계 설명을 끝낸다 | 원 Answer와 사용자가 보던 업무 맥락 | 설명 흐름을 종료하고 원 업무로 돌아간다 | presentation state만 닫고 Answer·Canvas 결과를 유지한다 | 없음 | presentation closed | 구체 focus target·keyboard 방식은 후속 UI 명세에서 결정 |

### ECS-07 — 태화트랜스 사례로 조직 Ontology를 운영한다

- **업무 이야기**: 태화트랜스 Ontology 운영자가 업무 Run에서 생긴 지식 후보를 검토해
  공통·역할 전용·실행기록을 구분하고, 검증된 후보만 새 Ontology revision으로 활성화한다.
- **주 capability**: CAP-03, CAP-04, CAP-10, CAP-12, CAP-13
- **비목표**: 태화트랜스의 현재 폴더명을 EG-Desk 제품 schema로 고정하거나, 업무 결과를
  검토 없이 자동 승격하는 것
- **근거**: [RWS-0026](../real-work-scenarios/cases/rws-0026-taehwa-knowledge-authority-and-acl.md),
  [RWS-0027](../real-work-scenarios/cases/rws-0027-taehwa-ontology-semantic-migration-audit.md)

아래 흐름은 조직 지식의 관리·승격 권한을 가진 운영자의 검토 상황이다. 일반 업무를
수행하는 모든 사용자에게 이 절차를 요구하지 않는다. 업무 Owner와 governance Owner는
책임의 구분이며 반드시 별개의 두 사람을 요구하는 결정은 아니다. 검토 깊이·자동화·
승격 권한의 최종 정책은 `HUM-GOV-001`에 남아 있다.

| # | 사용 상황·필요 | 사용자에게 필요한 정보 | 사용자 판단·행동 | System 책임 | Agent 책임 | 상태 전환·증거 | 예외·회복 |
|---:|---|---|---|---|---|---|---|
| 1 | 업무 Agent가 같은 Run의 여러 turn에서 새 규칙·모순·누락을 발견했다 | 해당 turn이 실제 사용한 Ontology Resolution Receipt, source·tool observation과 제안 이유 | 업무 조정으로만 사용할지 재사용 지식 후보로 검토할지 결정한다 | runtime observation과 Ontology candidate를 분리해 기록한다 | 새 사실은 즉시 다음 turn에 반영하되 자동 승격하지 않는다 | context adjustment·optional candidate | 후보가 아니어도 현재 업무 적응은 계속 가능 |
| 2 | 운영자가 미검토 후보를 검토한다 | 제안 Agent, 원 Run·turn·source snapshot, 당시 Ontology ref와 현재 active ref | 검토할 후보를 선택한다 | candidate와 생성 당시 evidence를 현재 Live 원본과 구분해 resolve한다 | 없음 | candidate provenance | source 접근권한이 없으면 제한 이유와 검토 불가 범위 표시 |
| 3 | 현재 조직 지식과 의미를 비교한다 | candidate와 active rule의 text·semantic unit 차이, 추가·변경·삭제와 영향 가능 범위 | 검토가 필요한 의미 차이를 판단한다 | structural diff와 비교 자료를 제공하고 의미 검토 결과를 출처에 연결한다 | 원문을 비교해 의미 차이·영향을 분석하고 검토 가능한 finding을 만든다 | structural·semantic finding | hash·link PASS를 의미 보존 PASS로 확대하지 않음 |
| 4 | 지식의 수명·권한 범위를 정한다 | 공통 지식, 역할 전용 지식, 일회성 실행기록, 폐기의 차이 | 적절한 class와 업무 Owner를 정한다 | 분류를 candidate metadata에 기록하며 active ref·ACL은 바꾸지 않는다 | 분류 근거를 제안할 수 있다 | proposed class·owner | 민감 원자료의 공통 승격은 privacy·authority 경계에서 차단 |
| 5 | 독립 의미 검토가 필요하다 | Critic이 받을 source, 제외 context, 검토 질문과 완료 조건 | 검토 범위를 승인·조정한다 | source-isolated Critic과 frozen candidate를 결합한다 | Critic은 제안 Agent의 결론을 전제로 삼지 않고 검토한다 | review dispatch·candidate hash | 검토 중 candidate 변경 시 verdict stale |
| 6 | 검토 finding을 처리한다 | 의미 누락·충돌·의도적 폐기와 원 evidence | finding을 수용·반려하거나 수정을 요청한다 | disposition과 candidate lineage를 보존한다 | 수정안을 만들 수 있으나 owner decision을 대신하지 않는다 | finding disposition | sibling finding과 원 evidence 유지 |
| 7 | 역할·계정별 실제 권한을 확인한다 | 공통 read, 역할 runtime read/write, governance promote capability와 검사 시각 | 현재 권한으로 검토·승격 가능한지 판단한다 | 폴더 visibility가 아니라 실제 account·role capability를 probe한다 | 권한 결과를 해석하되 권한을 생성하지 않는다 | allowed/denied·verified-at | account·mount mismatch이면 승격 action만 차단 |
| 8 | 변경의 영향을 확인한다 | 관련 Agent Profile·업무 유형·Ontology unit과 현재 진행 중 Run | 검증 범위와 우선순위를 정한다 | dependency와 known/unknown 영향 집합을 계산한다 | 영향 가설과 필요한 검증을 제안한다 | affected/unknown set | 확인 불가 대상을 영향 없음으로 간주하지 않음 |
| 9 | candidate를 격리 검증한다 | 사용할 과거 시나리오·source snapshot·기대 판정과 candidate binding | 검증 계획을 확정한다 | candidate를 evaluation Run에만 resolve하고 production active ref는 유지한다 | Worker·Critic이 baseline/candidate 결과를 만든다 | test suite·candidate receipt | production Agent의 현재 업무는 중단하지 않음 |
| 10 | 회귀 결과를 검토한다 | 개선·퇴행·UNKNOWN과 실패 scenario의 source·turn evidence | 검증이 충분한지, 수정·추가 검토가 필요한지 판단한다 | 동일 test revision의 결과를 연결한다 | 결과를 설명하되 작은 표본을 PASS로 과장하지 않는다 | evaluation result | 미판독 source·불충분 표본은 UNKNOWN |
| 11 | 업무 Owner에게 의미 판정을 요청한다 | exact candidate diff, 영향 범위, evidence, 미해결 finding과 공유 제외 범위 | 전달 범위를 확인한다 | credential·역할 비공개 자료를 제외한 review packet을 만든다 | reviewer용 요약을 만들 수 있다 | prepared→delivered | 전달은 접근·수락·승인이 아님 |
| 12 | 업무 Owner가 의미를 판정한다 | 판단 대상 candidate revision과 검토 evidence | 수락·수정 요청·반려와 이유를 남긴다 | owner readback을 작업 사건 이력에 추가한다 | 없음 | owner decision | candidate 변경 시 이전 decision stale |
| 13 | governance Owner가 승격을 결정한다 | owner decision, Critic verdict, 권한 probe, 회귀 결과와 남은 위험 | 승격·보류·반려를 결정한다 | 승인되면 immutable Ontology revision과 promotion receipt를 만든다 | 자기 후보를 스스로 승인하지 않는다 | approved revision·receipt | 의미 승인과 활성화 시점을 분리 |
| 14 | 승인된 revision을 active 정책에 반영한다 | 현재·승인 revision, 적용 조직·역할·overlay 정책과 호환성 영향 | 활성화 시점과 범위를 결정한다 | active pointer event를 기록한다 | 없음 | activation event | 과거 turn의 당시 binding과 evidence를 소급 변경하지 않음 |
| 15 | 진행 중 Run이 새 active ref와 만난다 | 현재 turn이 사용한 receipt와 다음 turn에서 resolve될 새 revision의 compatible/conflict 차이 | 필요한 경우 사용자 조정을 더한다 | compatible 변화는 다음 turn의 새 Ontology Resolution Receipt에 반영한다 | 같은 Run의 다음 turn에서 자연스럽게 조정한다 | new receipt·Turn Context Revision | authority·target·concurrent write 충돌일 때만 해당 action safety-block |
| 16 | 활성화 뒤 퇴행이 확인된다 | 영향받은 새 turn·업무, 이전/현재 revision과 rollback 영향 | rollback 여부와 범위를 결정한다 | revision을 삭제하지 않고 새 active pointer와 rollback receipt를 기록한다 | 이후 turn에서 rollback된 active ref를 사용한다 | rolled-back·history preserved | 과거 Run·turn의 실제 binding은 유지 |

#### 부서 간 납기 질문: 담당자·기기·권한은 일대일이 아니다

다음은 기존 사례에서 얻은 경계를 설명하는 예시이며, 특정 직원의 권한표나 현장 배포 기록이 아니다. 영업 담당자는 고객 메일에서 **품목과 필요한 날짜**만 골라 생산 부서에 확인을 요청한다. 생산 담당자가 다른 PC에서 자기 업무 계정으로 확인해 가능한 날짜를 회신한다. 영업 쪽이 자기 Board에 회신을 반영하고, 실제 고객 발송은 발송 권한이 있는 사람이 따로 한다. 두 부서가 같은 PC나 AI 실행 계정을 쓸 수도 있지만 어느 경우에도 그 계정명이 실제 답한 사람을 증명하지 않는다. 서비스 프로세스가 가동된 PC와 사람이 업무 자료에 로그인한 세션도 같다고 가정하지 않는다.

현재 로컬 예시에서 오가는 것은 [선택한 발췌·질문·회신 파일](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-local-share)이다. 파일을 받은 사람은 영업 직원의 DM이나 메일함을 얻지 않는다. 미래의 실시간 초대에서도 확인된 사람에게 **그 Board에서 Agent에 질문할 권한**을 주는 것과 Agent 설정을 복사하거나 소유자의 사용량·도구를 쓰게 하는 것은 별개의 결정이다.

#### 태화트랜스 사례에서 일반화한 운영 경계

- 공통 개념·규칙, 역할 전용 evidence/runtime, 일회성 실행기록과 미완성 산출물은 서로 다른
  lifecycle과 권한을 가진다.
- 폴더가 보인다는 사실은 읽기·쓰기·승격 permission의 증거가 아니다.
- 파일 수·hash·link 검사가 통과해도 판단조건과 안전규칙의 의미 보존은 별도로 검증한다.
- 업무 실행 결과는 provenance가 있는 candidate가 될 수 있지만 자동으로 Ontology가 되지 않는다.
- 업무 Owner의 의미 판정과 governance Owner의 승격 권한을 분리한다.
- 태화트랜스의 과거 논리 영역명은 evidence이며, 현재 조직 상태나 EG-Desk의 고정 schema로
  주장하지 않는다.

## 5. 기술 capability 13개

모든 capability는 `PM-PROPOSAL`이며 구현 증거가 아니다. 관련 RWS는 요구사항과 실패
경계의 evidence다.

### CAP-01 — Agent 설정·Engine·권한을 Run과 turn에 결합

- **기술 목표**: Agent 표시 정체성, Profile revision, AI Engine account, model·tool
  availability와 authority의 교집합을 기록하되 Run의 이후 context 조정을 막지 않는다.
- **주 설정**: role·personality·instructions revision·model policy·tool ceiling·context·memory·
  Ontology·budget·sandbox·delegation ceiling.
- **connection**: `organization policy + Agent Profile → active Ontology resolver → Engine·tool·authority probe → Turn Context Revision 1 → first model call`.
- **필요한 UX 행위**: 사용자는 Agent 역할·Engine·connection을 설정하고 실제 resolve 결과를
  확인한 뒤 작은 검증 업무를 시작할 수 있어야 한다. 정확한 component·label은 후속 UI 설계가 정한다.
- **System/Agent 경계**: System이 first call 전에 actual Engine·model·tool·authority와 Ontology를
  resolve하고, 이후 call마다 필요한 context revision을 조립한다. Agent Profile의
  role·personality·instructions는 authority를 만들지 않는다.
- **fracture/recovery**: 인증 상태, quota 제한과 tool unavailable을 구별하고 기존 정책이
  허용하는 복구·fallback은 자동 진행한다. 재인증·계정 전환·새 권한·비용 선택이 필요한
  범위만 사용자에게 제시한다. 필수 first-call 조건이 아직 없으면 `preflight unresolved`다.
- **완료 증거**: 저장된 설정뿐 아니라 first model call이 참조한 resolved configuration,
  Ontology Resolution Receipt와 Turn Context Revision.
- **evidence**: `RWS-0009`, `RWS-0011`; 보조 `RWS-0026`, `RWS-0030`, `RWS-0031`.
- **정본 후보 연결**: [Atlas AGENT-01](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-agent-01),
  [ENGINE-01](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-engine-01),
  [Contract Run binding](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-agent-run-binding).
- **coverage**: Codex 프로젝트 운영 Profile evidence만 존재한다. EG-Desk 제품 Agent runtime과
  Engine account/model end-to-end는 `NOT-VERIFIED / HYPOTHETICAL-COVERAGE`다.

### CAP-02 — 최소 Context와 Reader Session

- **기술 목표**: Desk 전체가 아니라 각 turn에 필요한 context만 admission하고 큰 자료는
  coverage를 보존한 Reader Session으로 판독한다. Context Packet은 Run 전체를 얼리는 입력이 아니다.
- **주 설정**: context budget, answer reserve, allow/exclude source, privacy class, Reader budget,
  partition·overlap, unknown stop.
- **connection**: `previous turn + user adjustment + tool observation + source/Ontology change → resolver → direct read | Reader → next Turn Context Revision`.
- **필요한 UX 행위**: 사용자는 source를 포함·제외하고 read intent를 설명하며, 판독 coverage와
  오류를 확인해 같은 Run에 방향 수정·범위 축소·source 교체를 보낼 수 있어야 한다.
- **System/Agent 경계**: System이 admission·budget·coverage를 관리하고 Reader Session은
  필요한 Context Packet만 공급한다. owner Agent는 다음 turn에서 새 관찰·교정을 반영하며
  최종 비교·판단·Answer를 소유한다.
- **fracture/recovery**: overflow는 Reader 전환으로 처리한다. parser·OCR·권한 오류는 허용된
  자동 복구를 먼저 시도하고 여전히 읽지 못한 source의 의존 분기만 차단한다. 미판독 범위를
  남긴 전체 검토를 완료로 표시하지 않는다. source 변화는 기록하고 Agent가 판단의 근거와
  영향받는 범위를 대조해 필요한 부분만 재검토하며 같은 Run을 계속한다.
- **완료 증거**: source snapshot, partition manifest, coverage, 각 turn에 전달된 packet과 Answer lineage.
- **evidence**: `RWS-0003`, `RWS-0006`; 보조 `RWS-0009`, `RWS-0025`, `RWS-0027`, `RWS-0031`.
- **정본 후보 연결**: [Atlas AI-02](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-02),
  [READ-01](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-read-01),
  [Contract Context](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-context-assembly),
  [Smart Read](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-smart-read).
- **coverage**: 분할·context isolation은 강함, Smart Read UI는 `NOT-VERIFIED`.

### CAP-03 — Multi-Agent dependency·integration 감독

- **기술 목표**: independent Task를 병렬 실행하되 write/resource ownership, dependency,
  critic과 단일 integration result를 보존한다.
- **주 설정**: source packet, allowed context, write set·lease, expected artifact, budget,
  completion contract, integration order.
- **connection**: `담당 Agent → 필요한 Worker·dependency → 필요한 검토 → 통합 Answer`.
- **필요한 UX 행위**: 사용자는 Task·dependency·owner·write set과 진행 evidence를 확인하고,
  실패 branch만 재시도·재할당·중지한 뒤 통합 결과를 검토할 수 있어야 한다.
- **System/Agent 경계**: Agent가 작업 분할·검토 방법을 판단하고 System이 Task graph·
  checkpoint·lease를 관리한다. 별도 Worker·Critic을 사용하는 경우 위임 범위와 검토 독립성을
  보존한다. 통합 책임자는 뒤늦게 도착한 contribution의 실제 입력 revision과 최신 사용자
  지시를 대조해 채택·부분 재작업을 판단한다. 관련 없는 sibling 결과는 유지한다.
- **fracture/recovery**: slot 부족은 wave, child 실패는 종속 분기만 block, 충돌은 실행 전 차단.
- **완료 증거**: dispatch·artifact·finding·parent disposition과 하나의 integration revision.
- **evidence**: `RWS-0002`, `RWS-0003`, `RWS-0030`; 보조 `RWS-0006`, `RWS-0031`, `RWS-0032`.
- **정본 후보 연결**: [Atlas AI-03](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-03),
  [AI-06](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-06),
  [Contract dependency](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-dependency-orchestration),
  [parallel Agents](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-parallel-agents).

### CAP-04 — 사용자 교정과 clean-room context escape

- **기술 목표**: 관찰·추론·제안·owner decision을 분리하고 잘못된 premise의 파생물을 stale 처리한다.
- **주 설정**: allowed/excluded source, source-isolated analyst, adversarial critic, simulation authority 0.
- **connection**: `owner correction → 작업 사건 이력 → stale impact → next Turn Context Revision → optional clean-room child → readback → canonical`.
- **필요한 UX 행위**: 사용자는 근거·결정 lineage와 교정 영향 범위를 확인하고, 같은 업무에
  교정을 전달하며 필요한 경우 독립 분석과 정본 반영 여부를 결정할 수 있어야 한다.
- **System/Agent 경계**: System이 provenance·stale graph와 다음 turn context를 관리한다.
  parent Agent는 같은 Run에서 교정을 반영하고, 필요할 때만 source-isolated child가 fresh analysis를
  수행한다. 위임 범위의 분석·검토·수정 판단은 담당 Agent가 수행할 수 있다. 새 제품 의미,
  공통 지식 승격과 권한 확대처럼 사람에게 남긴 결정만 해당 owner에게 전달한다.
- **fracture/recovery**: 같은 framing의 다수결과 mutable-candidate audit를 완료로 인정하지 않는다.
- **완료 증거**: 같은 Run lineage에서 이전 판단이 stale 처리되고 교정 context를 사용한 다음
  Answer, source manifest, owner readback, canonical revision과 OPEN remainder.
- **evidence**: `RWS-0004`, `RWS-0013`; 보조 `RWS-0012`, `RWS-0024`, `RWS-0027`, `RWS-0028`.
- **정본 후보 연결**: [Atlas AGENT-03](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-agent-03),
  [AI-04](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-04),
  [Contract Run binding](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-agent-run-binding).

### CAP-05 — Live surface identity·focus·control lease

- **기술 목표**: Browser·외부 앱의 instance, account, tab/frame, renderer, observation revision과
  single-writer input ownership을 결합한다.
- **주 설정**: 단일 executor, allowed surface/action, secret 비보존, handoff trigger, retry budget.
- **connection**: `surface preflight → lease → semantic action → event wait → reobserve`.
- **필요한 UX 행위**: 사용자는 surface identity와 실행 방식을 확인하고 한정된 input control을
  위임·회수·긴급 중지하며, secret 단계만 직접 처리한 뒤 이어갈 수 있어야 한다.
- **System/Agent 경계**: System이 surface binding·focus·lease·secret isolation을 관리한다.
  Agent는 부여된 target·시간·action 범위 안에서만 입력한다.
- **fracture/recovery**: stale handle은 재관찰해 같은 Run의 다음 turn에서 조정한다. profile·authority
  mismatch, secure input과 input lease 충돌처럼 안전 경계가 깨진 action만 fail-closed 후 rebind/handoff한다.
- **완료 증거**: envelope revision, lease owner, before/after readback, secret 미보존.
- **evidence**: `RWS-0007`; 보조 `RWS-0005`, `RWS-0015`, `RWS-0017`, `RWS-0025`, `RWS-0029`, `RWS-0031`.
- **정본 후보 연결**: [Atlas BROWSER-02](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-browser-02),
  [BROWSER-04](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-browser-04),
  [CU-01](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-cu-01),
  [Contract identity](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-resource-identity).

### CAP-06 — Connection·runtime 경계 복구

- **기술 목표**: shell, bridge, helper, transport, process, provider conversation과 view health를
  독립적으로 판정한다.
- **주 설정**: diagnostic read-only 권한, capability probe, fallback ceiling, last-checked policy.
- **connection**: `error → boundary probes → identity recheck → reconnect | relaunch | snapshot-only`.
- **필요한 UX 행위**: 사용자는 오류의 영향 범위와 경계별 상태를 확인하고 재연결·새 실행·
  snapshot-only·중지를 선택한 뒤 원 업무 맥락에서 결과를 확인할 수 있어야 한다.
- **System/Agent 경계**: System이 health·identity를 판정한다. Agent는 diagnostic evidence를
  제안하지만 인접 계층 실패를 root cause로 확정하지 않는다.
- **fracture/recovery**: 인접 계층 실패를 원인으로 단정하지 않고 보존된 결과와 해당 경계만 복구한다.
- **완료 증거**: same/new process, probe result, recovery receipt와 미확정 원인.
- **evidence**: `RWS-0008`, `RWS-0023`; 보조 `RWS-0007`, `RWS-0010`, `RWS-0014`, `RWS-0032`.
- **정본 후보 연결**: [Atlas SYS-01](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-sys-01),
  [TERM-01](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-term-01),
  [Contract failure](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries).

### CAP-07 — External effect approval·receipt·current state

- **기술 목표**: exact target, authorization, idempotency, dispatch, provider receipt, processing,
  business reconciliation과 current verification을 분리한다.
- **주 설정**: single executor, exact target set, query-before-replay, approval expiry, receipt auditor.
- **connection**: `validated draft → approval → executor → receipt → current query → reconciler`.
- **필요한 UX 행위**: 사용자는 exact target·account·payload·expiry를 확인해 action 범위를
  승인·거부하고, 이후 receipt와 현재 처리 상태를 별도로 확인할 수 있어야 한다.
- **System/Agent 경계**: System이 existing authority·approval·idempotency를 검증한다. Agent는
  위임 범위에서 실행하며 provider 후속 상태를 스스로 확정하지 못한다.
- **fracture/recovery**: timeout·불확실 결과·후속 불일치 때 자동 replay하지 않는다.
- **완료 증거**: target/account, approval, provider receipt와 독립 current-state evidence.
- **evidence**: `RWS-0005`, `RWS-0015`, `RWS-0016`, `RWS-0020`, `RWS-0025`, `RWS-0029`.
- **정본 후보 연결**: [Atlas BROWSER-04](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-browser-04),
  [AUTH-01](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-auth-01),
  [Contract failure](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries).

### CAP-08 — Answer·Snapshot·Live·provenance

- **기술 목표**: 여러 contribution을 한 Answer revision으로 통합하고 Chat·Canvas·Snapshot·Live의
  identity와 provenance를 보존한다.
- **주 설정**: Answer integrator, evidence-selection, confidence, optional visualizer, raw reasoning 비노출.
- **connection**: `results/snapshots → Answer → Chat + Canvas report set ↔ Live/diff`.
- **필요한 UX 행위**: 사용자는 Agent 활동·결과에서 당시 Snapshot과 현재 Live를 오가며 차이를
  확인하고, 원 대화로 돌아오거나 같은 Answer를 단계적으로 설명받을 수 있어야 한다.
- **System/Agent 경계**: Agent가 Answer·매체 구성을 제안하고 System이 source binding·권한·
  renderer를 검증한다. 사용자가 탐색과 후속 요청을 소유한다.
- **fracture/recovery**: 한 projection 실패 시 다른 쪽을 유지한다. source 변화는 당시 Answer를
  보존하면서 현재 판단에 관련되는지 확인하고, 재분석·새 답변이 실제로 생성됐을 때만 새 Answer revision을 만든다.
- **완료 증거**: same Answer ID와 `delivered payload → snapshot → source revision` lineage.
- **evidence**: `RWS-0024`; 보조 `RWS-0008`, `RWS-0016`, `RWS-0022`, `RWS-0027`.
- **정본 후보 연결**: [Atlas AI-04](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-04),
  [AI-05](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-05),
  [Contract Answer projection](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-answer-projection),
  [Answer Briefing](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-answer-briefing).

<a id="cap-09--deskagendarun-checkpoint-재개"></a>
### CAP-09 — Desk·Board·Run checkpoint 재개

- **기술 목표**: 자동 Desk session, Saved Board, view/runtime/process와 Run checkpoint를 다른
  lifecycle로 복원한다. checkpoint는 Run 전체 context 사본이 아니라 Run policy, 최신 turn pointer,
  작업 사건 이력과 pending safety/action 상태를 가리킨다.
- **주 설정**: persistence scope, checkpoint policy, runtime owner, external-effect replay 금지.
- **connection**: `session + Board + checkpoint + event ledger → live validation + active Ontology resolve → next Turn Context Revision → resume | new | snapshot-only`.
- **필요한 UX 행위**: 사용자는 Desk 복원과 Saved Board, 이전 Task의 완료·미완료 상태를 구분하고
  현재 환경으로 계속할지 새 업무·snapshot-only로 열지 결정할 수 있어야 한다.
- **System/Agent 경계**: System이 persistence·resource/runtime과 현재 active Ontology를 resolve한
  뒤 다음 turn context를 만든다. Agent는 같은 Run의 다음 turn에서 변화에 적응한다.
- **fracture/recovery**: crash·lock·process loss·stale resource를 degraded 상태로 정확히 표시한다.
- **완료 증거**: Desk 복원과 Board 목록 분리, checkpoint source, new Ontology Resolution Receipt,
  Turn Context Revision과 runtime mode.
- **evidence**: 보조 `RWS-0010`, `RWS-0012`, `RWS-0014`, `RWS-0019`, `RWS-0021`, `RWS-0029`, `RWS-0030`.
- **정본 후보 연결**: [Atlas L-02](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-l-02),
  [AG-02](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ag-02),
  [Contract storage](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-storage-export).
- **coverage**: 통합 runtime 재개는 `HYPOTHETICAL-COVERAGE`.

### CAP-10 — Cross-device·collaborator handoff

- **기술 목표**: 기기·Desk 전체가 아니라 선택한 Board·View·artifact·evidence와 권한을 전달한다.
- **주 설정**: receiver Profile, shared/excluded state, local-only dependency, authority, expiry,
  offline·conflict policy, credential 복제 금지.
- **connection**: `source device → handoff packet → recipient preflight → shared projection → receipt`.
- **필요한 UX 행위**: 보내는 사람은 공유·제외 범위와 권한·만료를 검토해 전달하고, 수신자는
  실제 접근성과 current state를 확인한 뒤 수락·실행·회수할 수 있어야 한다.
- **System/Agent 경계**: System이 identity·permission·revision·conflict를 처리하고 Agent는
  전달된 범위만 실행한다. remote observation과 control은 별도 grant다.
- **fracture/recovery**: stale/diverged/offline·account mismatch·duplicate effect는 reoffer·rebase·receipt query.
- **완료 증거**: prepared/delivered/accepted/accessible을 분리하고 actor·device·revision 귀속.
- **evidence**: `RWS-0010`; 보조 `RWS-0008`, `RWS-0019`, `RWS-0023`, `RWS-0029`.
- **정본 후보 연결**: [Atlas COL-01](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-col-01),
  [CU-01](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-cu-01),
  [Contract identity](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-resource-identity),
  [storage](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-storage-export).
- **coverage**: 실제 collaborator 초대·원격 control runtime은 `NOT-VERIFIED`.

### CAP-11 — Repeating work·missed run·catch-up

- **기술 목표**: schedule, source freshness, checkpoint, missed-run과 catch-up을 독립 상태로 관리한다.
- **주 설정**: recurrence, source scope, mode, catch-up ceiling, destination, expiry, dedupe window, cost cap.
- **connection**: `schedule → source health → Run → output/delivery receipt → next due`; missed 시 catch-up.
- **필요한 UX 행위**: 사용자는 반복 업무를 pause·resume하고 last/next Run과 missed 상태를
  확인하며 catch-up·건너뛰기를 결정한 뒤 output·delivery evidence를 검토할 수 있어야 한다.
- **System/Agent 경계**: System이 schedule·checkpoint·dedupe·authority freshness를 관리한다.
  Agent는 해당 Run의 업무만 수행하고 외부 효과는 CAP-07 approval을 따른다.
- **fracture/recovery**: stale source·expired auth·duplicate catch-up·undelivered report를 분리한다.
- **완료 증거**: Run ID, freshness, output revision, delivery receipt와 next due.
- **evidence**: `RWS-0014`, `RWS-0021`; 보조 `RWS-0020`, `RWS-0024`, `RWS-0029`.
- **정본 후보 연결**: [Atlas AI-06](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-06),
  [SYS-01](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-sys-01),
  [Contract dependency](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-dependency-orchestration),
  [Run binding](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-agent-run-binding).

### CAP-12 — Knowledge·Ontology binding·promotion·evaluation

- **기술 목표**: common·role-private·runtime·candidate 지식과 versioned Ontology binding을 분리한다.
- **주 설정**: organization active policy, role Profile의 selection·overlay policy,
  knowledge/Ontology revision, read/write/promotion ceiling, privacy, eval suite.
- **connection**: `organization + Agent policy → active resolver → Ontology Resolution Receipt → Turn Context Revision`; 운영은 `runtime observation → optional candidate → review/owner → active pointer event → regression/rollback`.
- **필요한 UX 행위**: 사용자는 candidate provenance·semantic diff·지식 범위·실제 권한·회귀 결과를
  검토하고 owner readback, 승격·활성화·rollback을 서로 다른 결정으로 다룰 수 있어야 한다.
- **System/Agent 경계**: System이 active ref resolve, ACL·binding·version·promotion을 강제한다.
  Agent는 현재 업무에 새 사실을 즉시 반영하고 후보·평가를 만들 수 있지만 스스로 common
  knowledge로 승격하지 못한다.
- **fracture/recovery**: compatible active revision 변화는 같은 Run의 다음 turn에 반영한다.
  visibility/permission 오인, authority·target mismatch, concurrent write, semantic omission과
  small-sample false conclusion은 해당 action을 safety-block하거나 verdict를 stale 처리한다.
- **완료 증거**: capability probe, turn별 Ontology Resolution Receipt, provenance, promotion·activation·
  rollback receipt와 동일 version 회귀.
- **evidence**: `RWS-0026`, `RWS-0027`, `RWS-0028`, `RWS-0031`; 보조 `RWS-0006`, `RWS-0030`.
- **정본 후보 연결**: [Atlas ONT-01](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ont-01),
  [ONT-02](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ont-02),
  [AGENT-02](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-agent-02),
  [Contract Run binding](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-agent-run-binding).

### CAP-13 — Candidate에서 canonical·remote·deployment까지

- **기술 목표**: canonical identity, isolated candidate, review, single-writer apply, save·Git·deploy·current
  verification을 분리한다.
- **주 설정**: bounded creator, read-only critics, canonical integrator, release executor authority.
- **connection**: `원본 → 필요 시 candidate·검토 → 위임 또는 승인 범위의 적용 → 결과 확인`.
  render·test·독립 Critic·사람 선택·Git·배포는 해당 업무가 요구할 때 연결되는 단계다.
- **필요한 UX 행위**: 사용자는 candidate의 diff·render·finding을 확인해 전체·부분 수락을 결정하고,
  정본 적용·save·reopen·remote·deployment·current verification을 각각 확인할 수 있어야 한다.
- **System/Agent 경계**: System이 lock·revision·diff·receipt를 관리한다. Agent는 위임 범위에서
  candidate·QA·적용을 진행하고, 사용자는 필요한 경우 결과를 선택·조정한다. 수락 대기가
  필요한 변경만 owner에게 전달하며, 같은 정본에 대한 write를 조율한다. release authority는 별도다.
- **fracture/recovery**: lock·stale hash·candidate 조기 적용·reviewer PASS 뒤 owner 거부·push≠deploy.
- **완료 증거**: canonical revision, accepted diff, reopen/hash/render, remote receipt와 deployment/current evidence.
- **evidence**: `RWS-0001`, `RWS-0012`, `RWS-0017`, `RWS-0018`, `RWS-0019`, `RWS-0022`, `RWS-0032`.
- **정본 후보 연결**: [Atlas TOOL-02](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-tool-02),
  [CODE-01](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-code-01),
  [DATA-01](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-data-01),
  [Contract storage](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-storage-export),
  [failure boundaries](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries).

## 6. 32개 RWS의 주 capability 배정

각 RWS는 처음 깨진 핵심 불변조건을 기준으로 하나의 CAP에만 주 배정한다. 다른 CAP에서의
참조는 보조 evidence이며 coverage 수에 다시 더하지 않는다.

| CAP | 주 evidence RWS |
|---|---|
| CAP-01 | `RWS-0009`, `RWS-0011` |
| CAP-02 | `RWS-0006` |
| CAP-03 | `RWS-0002`, `RWS-0003`, `RWS-0030` |
| CAP-04 | `RWS-0004`, `RWS-0013` |
| CAP-05 | `RWS-0007` |
| CAP-06 | `RWS-0008`, `RWS-0023` |
| CAP-07 | `RWS-0005`, `RWS-0015`, `RWS-0016`, `RWS-0020`, `RWS-0025`, `RWS-0029` |
| CAP-08 | `RWS-0024` |
| CAP-09 | 직접 통합 evidence 없음; 관련 RWS의 부분 증거만 존재 |
| CAP-10 | `RWS-0010` |
| CAP-11 | `RWS-0014`, `RWS-0021` |
| CAP-12 | `RWS-0026`, `RWS-0027`, `RWS-0028`, `RWS-0031` |
| CAP-13 | `RWS-0001`, `RWS-0012`, `RWS-0017`, `RWS-0018`, `RWS-0019`, `RWS-0022`, `RWS-0032` |

주 evidence 32개는 [RWS INDEX](../real-work-scenarios/INDEX.md)의 exact SourceRef와 claim
상태에서 확인한다.

## 7. capability 사이의 중복 방지 규칙

- Browser profile과 Agent Profile을 합치지 않는다. CAP-01은 Run 설정, CAP-05는 live surface다.
- View와 runtime을 합치지 않는다. CAP-05는 조작면, CAP-06은 process·transport health다.
- Connection과 외부 action을 합치지 않는다. CAP-06 healthy는 CAP-07 receipt가 아니다.
- 파일 편집과 정본 승격을 합치지 않는다. CAP-03 contribution과 CAP-13 canonical apply는 다르다.
- receipt와 provenance를 합치지 않는다. CAP-07은 외부 상태, CAP-08은 관찰 lineage다.
- Canvas는 실제 상태를 복제하지 않는다. ECS와 CAP의 상태를 찾아보고 통제하는 projection이다.
- Agent Room은 사람–담당 Agent 관계를 제공한다. Task·dependency·evidence 감독 정보는
  같은 Chat의 경량 표현과 연결된 Canvas에서 확인할 수 있으며 별도 업무 화면으로 강제 분리하지 않는다.

## 8. 실제 근거가 아직 부족한 분기

다음은 새 capability를 만들지 않고 기존 CAP의 `HYPOTHETICAL-COVERAGE`로 유지한다.

1. CAP-01: AI Engine 로그인, account·plan·quota 확인, model resolution·fallback의 실제 end-to-end.
2. CAP-02: Smart Read 자동 전환, budget meter와 coverage 수정 UI.
3. CAP-06: 장기 PTY detach·same process reconnect·relaunch·snapshot-only 구분.
4. CAP-09: Desk·Board·Run·여러 runtime이 함께 복원되는 실제 통합 사례.
5. CAP-10: 실제 collaborator 초대, offline conflict와 remote control revoke.
6. CAP-11: subscription expiry, wake·escalation과 중복 catch-up.
7. ECS 전반: Chat·Canvas·supervision·Answer Briefing의 실제 통합 UI runtime.
8. ECS-07: 실제 조직 Ontology의 candidate→semantic·ACL·regression 검증→activation→rollback end-to-end runtime.

## 9. 관련 evidence와 기술 분석

- [32개 실업무 RWS](../real-work-scenarios/INDEX.md)
- [Browser 자동화 단절 분석](../real-work-scenarios/BROWSER_FRACTURE_ANALYSIS.md)
- [Multi-agent 기법 분석](../real-work-scenarios/MULTI_AGENT_TECHNIQUE_ANALYSIS.md)
- [Multi-device Context·Handoff 분석](../real-work-scenarios/MULTI_DEVICE_HANDOFF_ANALYSIS.md)

ECS·CAP의 구체 설계안은 제품 정본 승인 전까지 `PROPOSED`다.

<a id="needs-review"></a>

## 10. 니즈 충돌과 미확정 요구 후보

아래는 2026-09-06 니즈 대조에서 찾은 상황·공백과 후보의 출발 기록이다.
현재의 추천·대안은 [사용 흐름·UI 추천안](./egdesk-ux-realization-proposals.md#ux-proposals-top),
결정 여부와 남은 질문은 [사용자 확인 원장](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#gap-owner-queue)에서 확인한다.
각 후보의 검토 범위는 그 배경을 보존하며 별도의 최신 질문 목록으로 사용하지 않는다.

18개 전부에 지금 답해야 작업이 진행된다는 뜻은 아니다. context·revision 연결,
입력 비간섭, renderer·adapter 방법과 구체 UI 후보는 조사·설계를 계속할 수 있다.
사용자에게 남는 선택은 저장·닫기의 의미, 기본 Agent, 기억·보존·공유 정책처럼 제품의
기본 기대를 바꾸는 부분이다. 그 선택도 상황·대안·영향을 구체화해 기존 HUM에서 확인한다.

### 10.1 대화에서 제시된 요구의 현재 위치

| 요구 묶음 | 현재 반영과 남은 범위 |
|---|---|
| Firefox 기반, 한 Desk·Canvas, 여러 Board | Contract §0–1과 Atlas L/AG에 반영. 저장·공유 runtime·예약 작업을 함께 닫는 상세 의미는 후보 5–7 |
| Board 저장과 지난 화면 복원 분리 | 정상 시작은 이전 화면 복원이며 저장 목록은 독립. 모든 revision을 먼저 확인하는 절차가 되지 않도록 ECS-01을 정정 |
| 화면 밖 카드의 메모리와 렌더링 | view/runtime/renderer 분리와 Canvas 표현 유지 반영. 형식별 보존 품질·실제 화면 확대·탐색은 후보 8–9·15 |
| 사용자와 Agent의 비간섭 입력 | 격리 실행·계정·제어권 경계 반영. 탭 내부 focus·좌표 관찰 시점·OS UI 동시 설명은 후보 9–10 |
| 담당 Agent 중심 Chat, 업무 상태와 Canvas 연결 | 기본 관계와 경량 진행 상태 반영. 동시 업무·위임 대화·수정 지시 대상은 후보 1–2 |
| 짧은 Canvas Memo, 작성자별 답글과 먼저 말 걸기 | Atlas CANVAS-01·Contract §4에 반영. 누가 언제 응답하고 멈추는지는 후보 3 |
| 활동 표시에서 실행 표면을 보고 결과를 Briefing으로 설명 | Snapshot/Live·한 Answer·수동 단계 이동·주석 반영. 진행 중 관찰과 과거 근거, 화면 복귀·편집은 후보 4·16 |
| Agent가 실제로 받은 자료와 나중 Canvas 표시의 일치 | 원본·전달 packet·변환 연결 반영. 원문 교체를 새 snapshot/coverage로 연결하도록 정정. 공유·삭제·보존은 후보 11–12 |
| smart admission, read 전용 Reader, 동일 session 재질문 | Contract §2·Atlas READ에 반영. 자동 복구 선행과 의미 영향 판단을 CAP-02에 복원. 실행 계정 예산·adapter 연결은 후보 13 |
| 위임·의존 작업 자동 진행, 관련 분기만 승인 대기 | Contract §9·11에 반영. 시나리오의 일반 분할·검토마다 사람 답을 기다리는 해석과 고정 Critic 경로를 정정. 통제 지점은 후보 1·7·13 |
| Engine 구독 계정과 업무 로그인 계정 분리 | Contract §14.1·Atlas ENGINE에 반영. 인증 성공과 quota 제한을 구별하도록 정정. 최초 설정·전환·공동 사용은 후보 13–14·18 |
| Ontology가 사이클을 지원하고 새 관찰에 적응 | 첫 호출 전 정책 기반 조회, 같은 Run의 다음 호출 조정을 정본까지 정정. 개인 최초 사용과 조직 운영 권한은 후보 14·17 |
| 사람에게는 파일·편집·변경 비교, AI는 필요한 도구 사용 | Contract §6–7과 Atlas CODE/TERM에 반영. 일반 문서·표·이미지의 지원 범위는 후보 15 |
| 로컬 내보내기와 최종 다중 기기·협업 | 단일 bundle·credential 제외·원격 인프라 승인 경계 반영. 자료 이동과 실행 재개의 차이는 후보 12·18 |
| 외부 reference 활용과 유연한 Agent 개발 방식 | Contract 구현 재량·Governance 조사 경로에 반영. 고정 worker/critic 조직과 모든 업무의 Git·배포 필수 경로는 synthesis에서 제거 |
| 상황→UX→UI, 사용설명서·기술·문서운영 화자 분리 | 정본 역할은 유지하고 Governance의 새 기능 설계 순서를 정정. 아래 후보에서 파생되는 정상 이용 분기는 10.3에 별도 정리 |

### 10.2 기능을 함께 사용할 때 필요한 후보

<a id="needs-conversation-target"></a>
#### 1. 같은 담당자 방에서 동시 업무와 추가 지시의 대상을 구분

- **상황**: 같은 Agent에게 자료 비교와 코드 수정을 동시에 맡긴 뒤 “이쪽은 그만하고 기준을 바꿔줘”라고 보낸다.
- **공백**: 담당자 identity만으로는 어떤 업무·자식 작업·자료에 적용할지 정해지지 않는다. Canvas에서 지금 보고 있는 대상이 대화 중인 업무와 다를 수도 있다.
- **후보**: 작성 중인 메시지가 이어갈 업무와 포함 자료를 검사·수정할 수 있게 하고, 기존 업무 조정과 새 업무를 구분한다. 모호한 경우에만 대상을 확인한다. 뒤늦은 child 결과도 실제 입력 revision을 최신 지시와 대조해 통합한다.
- **검토 범위·연결**: 최근 업무·선택 대상·명시적 지정 중 기본값, 한 메시지를 여러 업무에 적용하는 방식. 연결: CAP-02/03/04, [HUM-CONV-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-conv-001), [HUM-RUN-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001).

<a id="needs-participants"></a>
#### 2. 담당 Agent의 인격체와 실제 작업 참여자를 함께 이해

- **상황**: 담당 Agent가 여러 Worker를 사용하고 같은 Profile의 실행체 두 개가 동시에 다른 자료를 다룬다.
- **공백**: 모두 같은 avatar·이름이면 누가 한 말을 누가 책임지는지 흐려지고, 실행체마다 새 채팅방을 만들면 담당자 중심 UX가 무너진다.
- **후보**: 담당자는 관계의 중심으로 유지하며 메시지·기여에 실제 작성자와 대상 업무를 연결한다. 사용자에게 필요한 위임 대화·질문·결론과 자세한 진행 근거를 단계적으로 열 수 있게 한다.
- **검토 범위·연결**: agent-agent 대화를 어느 깊이까지 직접 읽고 참여할지, 공유 대화의 참가·답변 책임. 모든 raw conversation을 공개하거나 전부 숨기는 양극단은 기본값으로 확정하지 않는다. 연결: CAP-03/08, [HUM-CONV-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-conv-001).

<a id="needs-memo-initiation"></a>
#### 3. 메모에서 먼저 말 거는 Agent의 시작·종료 규칙

- **상황**: 메모에 짧게 답하면 오해가 생기거나 질문이 부족해 Agent가 담당자 방에서 설명을 이어야 한다.
- **공백**: 메모를 누가 맡는지, 같은 문제로 여러 Agent가 중복 연락하는지, 답이 없어도 다시 말하는지가 정해지지 않았다.
- **후보**: 원 메모·작성자·revision을 유지한 참조 메시지로 이어지고, 같은 쟁점의 중복 연락과 Agent끼리 반복 반응하는 순환을 제한한다. 사용자가 읽기·무시·후속 요청 중 원하는 행동을 할 수 있게 한다.
- **검토 범위·연결**: 자동 응답의 시작 조건, 한 번 알림 이후 재접촉·묶음·음소거 기본값. focus를 빼앗지 않는 원칙은 유지한다. 연결: CAP-03/08, [HUM-CONV-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-conv-001).

<a id="needs-activity-navigation"></a>
#### 4. 현재 활동 관찰과 당시 근거 확인을 구분하고 돌아오기

- **상황**: 활동 표시를 통해 Agent가 쓰는 Browser를 보고 싶다가, 방금 읽은 원문과 최종 결과의 근거도 확인한다. 동시에 다른 Worker가 Terminal을 사용한다.
- **공백**: “현재 활동”이 live 조작면인지 마지막 observation인지, 활동이 여러 개일 때 어디로 이동하는지 아직 하나의 UX로 닫히지 않았다.
- **후보**: 진행 중 대상·마지막 관찰 시점·전달된 자료를 구분하고 원하는 활동을 따라간다. 탐색 후에는 원래 Chat 위치·작성 중 초안·Canvas 시점으로 돌아올 수 있게 한다.
- **검토 범위·연결**: 활동 진입의 기본 Live/Snapshot, 자동 follow 허용 여부와 사용자가 다른 곳으로 pan했을 때의 종료. 연결: CAP-05/08, [HUM-SNAPSHOT-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001), [HUM-CONV-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-conv-001).

<a id="needs-agenda-save"></a>
#### 5. Board가 저장하는 작업의 범위

- **상황**: Browser·파일·메모·Chat을 배치해 Board로 저장하고 다음날 원본이 바뀐 상태에서 다시 연다.
- **공백**: 배치·구성원·원본 참조·일부 snapshot·대화·진행 중 작업 중 무엇을 저장하는지 미정이다. 저장된 구성과 지금 열린 동일 resource의 재사용도 연결돼야 한다.
- **후보**: 저장될 범위와 원본 참조/당시 내용의 차이를 확인하고, 기존 Board 갱신·새 사본·현재 열린 상태를 구분한다. 자동 Desk 복원과의 독립성은 유지한다.
- **검토 범위·연결**: 기본 포함 범위, 저장 시점과 현재 원본의 관계, 이미 열린 Board·동일 resource의 재사용 규칙. 연결: CAP-09, [HUM-AGENDA-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001).

<a id="needs-shared-lifecycle"></a>
#### 6. 두 Board가 같은 자원을 쓰는 동안 하나를 닫기

- **상황**: 두 Board가 같은 파일·Browser session·Terminal 또는 한 Agent의 작업을 함께 참조한다.
- **공백**: 화면에 연결했다는 사실과 실행을 소유한다는 사실이 아직 충분히 구별되지 않는다. 참조가 하나 남았다는 이유만으로 의도치 않은 작업이 계속되면 닫기의 의미가 바뀐다.
- **후보**: 닫을 작업과 다른 Board에서 계속할 작업을 식별하고 남는 실행은 그 소유 Canvas 표현에서 찾게 한다. 단독 소유 작업은 종료가 확인될 때까지 종료 상태를 보여 준다.
- **검토 범위·연결**: 동일 resource의 공유 session/독립 instance 기본값, 마지막 실행 소유자를 닫을 때의 처리, 닫기 후 되돌리기의 범위. 연결: CAP-05/09, [HUM-SURFACE-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001).

<a id="needs-recurring-close"></a>
#### 7. Board 닫기와 예약·의존 작업의 관계

- **상황**: 내일 다시 실행될 업무 또는 다른 Agent의 결과를 기다리는 업무가 있는 Board를 닫는다.
- **공백**: 지금 실행을 끝내는 것과 미래 예약을 취소하는 것이 같아야 하는지 미정이다. 닫힌 Board에서 다음날 몰래 재개되면 사용자의 닫기 기대와 충돌한다.
- **후보**: 현재 실행·대기 조건·미래 예약을 구별해 종료 영향을 알리고, 닫기 뒤에는 정해진 정책 없이 자동 재개하지 않게 한다. 반복 실행을 계속하려면 Canvas에서 찾을 수 있는 소유 표현이 필요하다.
- **검토 범위·연결**: 예약도 함께 중지할지, Board에 계속 남기는 반복 업무 표현을 별도로 둘지, 다시 열 때 자동 재개할지. 연결: CAP-09/11, [HUM-ORCH-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001).

<a id="needs-canvas-density"></a>
#### 8. Canvas 표현의 수와 원문·메모리 보존량을 따로 관리

- **상황**: 30개 Board와 수백 개 읽기 결과·Snapshot이 쌓이고 일부 Browser에는 미완성 form이 있다.
- **공백**: 모든 활동의 추적 가능성이 모든 과거 관찰마다 무거운 카드를 영구 전개한다는 뜻으로 읽힐 수 있다. Browser의 살아 있는 DOM, 가벼운 preview와 재로딩 가능한 상태도 다르다.
- **후보**: 실행 중 작업은 찾아갈 수 있게 유지하고, 활동·근거를 묶어 펼치는 밀도와 실제 renderer·runtime·보존 데이터의 수명을 따로 설계한다. 폴더 확장·scroll 등 가벼운 상태는 유지할 수 있으며 화면 재진입마다 전체를 새로 읽을 필요는 없다.
- **검토 범위·연결**: 닫힌 과거 기록의 재진입 방식, sleep 기준·저장 상한, 미완성 일반 form의 stale 상태를 어느 정도 보존할지. 비밀 필드를 임의 저장하는 결론은 포함하지 않는다. 연결: CAP-06/08/09, [HUM-SURFACE-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001), [HUM-SNAPSHOT-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001).

<a id="needs-view-transform"></a>
#### 9. Canvas pan·zoom·집중 보기와 웹페이지 크기 변경

- **상황**: Agent가 화면을 관찰한 뒤 사용자가 pan하거나 탭을 확대·resize하고, 그 후 클릭 명령이 도착한다.
- **공백**: 더블클릭 집중 보기의 비율 유지 의도는 정본에 복원했지만, 화면상의 위치·배율 변화와 Browser 내부 viewport·responsive layout 변화의 연결은 미정이다.
- **후보**: Canvas 카메라, view 지오메트리, Browser 내부 viewport·page zoom을 각각 다룬다. 대상 내부 좌표와 관찰 revision을 연결하고 단순 pan과 실제 내용·layout 변화를 구분한다. 다른 탭 작업이 Agent 쪽 dropdown·focus를 깨지 않도록 요구를 명시한다.
- **검토 범위·연결**: 집중 보기에서 내부 viewport까지 바꾸는지, zoom·resize·복귀 동작의 최종 사용자 경험. Agent 전용 focus·렌더링 방법은 Firefox 경계에서 조사·검증할 기술 선택이다. 연결: CAP-05/06, [HUM-SURFACE-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001).

<a id="needs-native-ui"></a>
#### 10. 업로드·OS 권한 단계에서 설명과 조작을 함께 제공

- **상황**: 사용자는 탭 A를 쓰고 Agent는 탭 B에 파일을 올리다가 사이트 picker나 OS 권한 승인이 필요해진다.
- **공백**: 일반 파일 전달, custom drop, 파일시스템 API, OS modal이 같은 업로드 흐름으로 묶여 있다. 설명을 읽으려고 원 작업을 잃는 경우도 있다.
- **후보**: 지원되는 범위에서 사용자 pointer·focus를 점유하지 않는 전달을 사용한다. 사람이 처리할 단계는 요청 이유·대상·이후 진행을 관련 Chat과 연결하고 완료 뒤 원 업무로 복귀한다. 격리 실행 화면도 Canvas에서 관찰한다.
- **검토 범위·연결**: OS modal과 Chat을 함께 볼 수 없는 플랫폼에서의 대체 배치·알림, 관찰할 app/window 범위. 특정 사이트 HTML 수정이나 모든 UI의 무조건 자동화를 전제하지 않는다. 연결: CAP-05/07, [HUM-COLLAB-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001), [HUM-SURFACE-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001).

<a id="needs-retention"></a>
#### 11. Snapshot을 유지하면서 삭제·공유 철회를 설명

- **상황**: 과거 답변이 파일 snapshot에 의존하는데 원문 접근권한을 회수하거나 해당 자료를 지우고 싶다.
- **공백**: 불변성은 byte를 덮어쓰지 않는 성질이다. 영구 보존 여부, 삭제 범위와 타인에게 공유한 파생 요약의 권한은 별도 정책이 필요하다.
- **후보**: 무엇이 그 자료를 참조하는지와 삭제 뒤 열리지 않게 되는 근거·Briefing을 보여 준다. 원본·preview·Reader packet·파생 결과·export의 포함 관계를 따라 범위를 판단한다.
- **검토 범위·연결**: 기본 보존 기간과 고정, 원 권한 철회 후 로컬 과거 열람, 삭제와 감사를 위해 남기는 정보, 이미 전달된 사본의 한계. 연결: CAP-08/10, [HUM-SNAPSHOT-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001).

<a id="needs-portability"></a>
#### 12. 한 파일로 옮긴 자료를 새 기기의 자원에 다시 연결

- **상황**: Chat·Board·snapshot을 한 파일로 넘겼지만 수신 기기에는 같은 파일 경로·브라우저 로그인·PTY가 없다.
- **공백**: 파일 transfer의 성공과 실제 작업 재개의 조건이 다르다. snapshot은 열려도 live 원본이 없거나 연결 계정이 다를 수 있다.
- **후보**: 이동 가능한 자료는 바로 열고, 누락된 live 자원은 필요한 것만 새 위치·계정에 연결한다. 같은 파일 이름만으로 원본을 단정하지 않고 과거 snapshot과 새 live 참조를 유지한다. import가 Agent 실행·외부 행동을 자동 시작하지 않도록 흐름을 구분한다.
- **검토 범위·연결**: 기본 포함·암호화·충돌 처리와 수신 후 재개 기본값. 연결: CAP-09/10, [HUM-EXPORT-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-export-001).

<a id="needs-reader-budget"></a>
#### 13. Smart Read와 병렬 작업이 쓰는 구독량·예산을 함께 관리

- **상황**: 큰 자료가 Reader와 하위 Reader로 나뉘고, 동시에 여러 업무가 같은 Engine 계정으로 진행된다.
- **공백**: 한 모델의 context overflow는 피했어도 child 전체의 사용량·대기 시간·취소 범위가 parent와 연결되지 않으면 비용과 속도를 예상하기 어렵다.
- **후보**: parent·Reader·Worker가 공유하는 실행 한도와 진행량을 관리하고, 같은 snapshot·intent의 결과 재사용, 단계적 읽기, 범위 조정·취소를 지원한다. 토큰 추정치를 구독 quota 잔량으로 단정하지 않는다.
- **검토 범위·연결**: 자동으로 사용할 기본 한도·우선순위, quota 소진 시 대기/다른 계정 선택. admission과 실제 전달 기록을 어느 App Server·도구 경계에서 집행·관찰할지는 별도 adapter 설계 검증이 필요하다. 연결: CAP-01/02/03, [HUM-READ-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-read-001), [HUM-ENGINE-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-engine-001).

<a id="needs-first-use"></a>
#### 14. 계정·Agent·조직 지식이 없는 최초 사용

- **상황**: 앱을 처음 열었고 저장 Board, 선택 Agent, Engine 인증과 조직 Ontology가 아직 없다.
- **공백**: Desk는 바로 열려야 하지만 어떤 최소 설정 뒤에 첫 요청을 보낼 수 있는지, 조직 지식 없는 개인 사용이 무엇을 기본으로 삼는지가 미정이다.
- **후보**: 기본 Desk 이용을 유지하면서 필요한 Engine 인증과 Agent 선택을 이어 주고, 첫 요청에 적용할 최소 정책을 제공한다. 지원되지 않는 tool이나 사용할 수 없는 quota는 인증 실패와 구분한다.
- **검토 범위·연결**: 기본 Agent 제공 여부·이름·초기 역할·기억 범위, 기본 Ontology와 조직 지식 연결의 관계. 연결: CAP-01/12, [HUM-AGENT-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agent-001), [HUM-RUN-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001).

<a id="needs-file-support"></a>
#### 15. 파일 형식마다 보기·AI 판독·편집·Snapshot 지원을 구분

- **상황**: 코드 외에도 PDF, 문서, spreadsheet, 이미지, HTML을 같은 Desk에서 열어 검토한다.
- **공백**: 현재 File 흐름은 코딩 중심이다. 파일이 열린다는 말만으로 시각적 보기, 내용 판독, 원본 편집과 정확한 과거 재현을 모두 약속할 수 없다.
- **후보**: 형식별로 열기·판독·편집·주석·snapshot·외부 앱 연결의 지원표를 만들고, 지원 수준이 다를 때 가능한 경로를 보여 준다. 렌더링/추출 라이브러리는 외부 reference 비교로 선택한다.
- **검토 범위·연결**: 첫 출시의 형식·편집 범위와 미지원 형식의 기본 fallback. 연결: CAP-02/08/13, [HUM-CODE-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-code-001), [HUM-SURFACE-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001).

<a id="needs-briefing-edit"></a>
#### 16. 결과를 고친 뒤 Chat·Briefing·주석이 가리키는 버전

- **상황**: 사람이 Canvas의 결과 표를 고치거나 Agent가 후속 답변을 만들었는데 이전 Briefing 단계와 메모가 남아 있다.
- **공백**: live 편집, 원 Answer, 새 Answer, 사용자가 남긴 의견의 대상이 섞이면 과거 설명이 최신 표를 설명한 것처럼 보일 수 있다.
- **후보**: 원본 결과와 수정된 산출물의 연결을 유지하고, Briefing은 설명한 결과 revision에 남긴다. 새 설명을 만들거나 주석을 최신 대상으로 옮길 때 무엇이 바뀌었는지 알 수 있게 한다.
- **검토 범위·연결**: 사용자 편집의 정본 수락·자동 갱신 범위, briefing 수정·저장·공유 권한과 명칭. 연결: CAP-08/13, [HUM-ANSWER-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-answer-001), [HUM-BRIEF-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-brief-001).

<a id="needs-knowledge-memory"></a>
#### 17. 업무 중 알게 된 사실·Agent 기억·조직 규칙의 경계

- **상황**: 한 업무에서 사용자가 오류를 고쳐 줬다. 다음 요청에도 기억할지, 다른 Agent에게도 적용할지, 조직 Ontology를 바꿀지 결정해야 한다.
- **공백**: 같은 Run의 즉시 조정은 정해졌지만 재사용 memory와 조직 지식 승격은 별도다. 태화트랜스의 관리·검토 역할을 모든 개인 업무에 강제할 필요도 없다.
- **후보**: 현재 업무의 조정은 바로 사용하고, 재사용 후보는 출처·범위와 함께 남긴다. 조직 정책의 승격·검토는 권한 있는 운영 흐름으로 제공하며 의미 비교는 Agent, 기록·접근·적용은 System이 맡는다.
- **검토 범위·연결**: 자동 기억 범위·개인/Agent/조직 소유권·수정/망각, 누가 조직 규칙을 승격하는지. 의미 수락·승격·활성화의 책임 구분 자체는 별개 인원을 요구하지 않는다. 조직별로 사람이 검토할 범위와 단계별 확인·위임 정책은 `HUM-GOV-001`에서 결정한다. 연결: CAP-04/12, [HUM-GOV-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-gov-001), [HUM-RUN-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001).

<a id="needs-collaboration-authority"></a>
#### 18. 협업자의 관찰·실행 계정·비용·원격 제어를 구분

- **상황**: 다른 사람이 내 Desk에 참여해 Agent와 대화하고, 내 기기에서 실행되는 Browser나 외부 앱을 관찰한다.
- **공백**: Desk를 함께 본다고 내 Engine quota·업무 계정·비공개 대화까지 사용할 수 있는지는 정해지지 않았다. 각 사람이 보는 Canvas 카메라와 발표 따라보기, 실행을 이어받는 주체도 구별돼야 한다.
- **후보**: 관찰·대화·위임·리소스 실행·computer-use 제어 권한과 실행 귀속을 구분한다. 참여자는 허용된 자료만 받고, 서로 다른 기기가 같은 외부 행동을 중복 실행하지 않도록 이어받는 주체를 확인한다.
- **검토 범위·연결**: 누구의 계정·quota로 실행할지, 독립 보기/따라보기 기본값, 개인 맥락이 섞인 요약의 공유 범위·철회. 로컬 모델·mock 설계는 가능하며 실제 원격 전송·서버는 별도 승인 대상이다. 연결: CAP-01/05/10, [HUM-COLLAB-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001), [HUM-REMOTE-001](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-remote-001).

### 10.3 시나리오에서 다음으로 전개할 정상 이용 분기

기존 7개 ECS는 기술 연결을 설명하는 주 사례다. 제품의 모든 정상 이용 흐름을 이미
완결했다는 의미는 아니다. 아래 분기는 기존 ECS/CAP와 매뉴얼을 연결해 더 구체화할 필요가 있다.

2026-09-06 후속 설계에서는 이 분기를 [9개 구체 흐름](./egdesk-ux-realization-proposals.md#ux-proposals-top)으로
전개했다. [후보 18개 대응표](./egdesk-ux-realization-proposals.md#2-후보-18개를-어디서-확인하는가)에서
각 흐름과 남은 제품 선택을 확인할 수 있다. 구체 UI 제안은 그 문서에 있으며 기존 ECS의
의미 수준 흐름과 분리된다.

| 연결할 분기 | 현재 출발점 | 다음 설계에서 확인할 결과 |
|---|---|---|
| AI를 호출하지 않고 Desk를 정리·저장·닫고 다시 열기 | ECS-01, CAP-09, Atlas AG/V | 저장과 자동 복원의 차이, shared runtime과 예약의 종료 의미 |
| 처음 Agent·Engine을 연결해 첫 요청 보내기 | ECS-02, CAP-01, Atlas 최초 설정/ENGINE | 기본 Agent·정책, 사용 불가와 quota·인증 상태의 구분 |
| 같은 Agent의 동시 업무를 조정하고 위임 대화에 참여 | ECS-02/06, CAP-03/04 | 메시지 적용 대상, 늦은 기여의 통합, Chat에서의 감독 정보 |
| 메모→짧은 답글→필요할 때 담당자 방에서 후속 대화 | ECS-02/06, CAP-08, Atlas CANVAS | 담당·알림·중복·원 위치·원문 revision 연결 |
| live 관찰→당시 snapshot→Briefing→원 작업으로 복귀 | ECS-03/06, CAP-05/08 | 기본 view mode, 사용자 카메라·초안 보존, 주석·수정본 관계 |
| 파일 bundle을 다른 기기에서 열거나 collaborator 초대 | ECS-01, CAP-10, Atlas DATA/COL | 자료 열람과 live 자원 연결·실행 권한·실제 재개의 구분 |

이 분기를 바탕으로 정보·판단·상태·복귀 흐름을 먼저 확정하고, 그 다음 구체 화면과
입력 방법을 만든다. 카드 모양이나 채팅방 탭 수를 이 목록만으로 먼저 확정하지 않는다.
