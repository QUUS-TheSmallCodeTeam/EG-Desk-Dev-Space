# EG-Desk 제품 문서 화자·운영 정본

**문서 목차**: [읽는 목적별 안내](../README.md#docs-start)

<a id="doc-governance-top"></a>

**수신자**: Main, PM, WM, 문서 유지보수자와 문서 작성·검증을 수행하는 AI Agent  
**문서 밖 경계**: 이 Governance의 문장은 EG-Desk 제품 화면, 제품 사용자, System 또는 Agent Runtime의 발화가 아니다.  
**제품 사용자 매뉴얼**: [EG-Desk 가상 사용설명서와 제품 상호작용 Atlas](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-manual-start)  
**기술 계약**: [EG-Desk 기술 구현·상호작용·오케스트레이션 계약](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-contract-top)  
**제품 소유자 질문**: [EG-Desk 설계 Gap 및 사용자 확인 원장](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#gap-owner-queue)

이 문서는 제품을 설명하는 표면이 아니라 제품 문서가 서로 다른 화자와 권한을 유지하도록
작성·이동·검증하는 운영 정본이다. AI가 기억해야 할 편집 원칙, 문서 간 weave 순서,
source precedence, ID·provenance·route·audit 규칙은 여기에만 둔다.

## 0. 화자와 문서 weave

### 0.1 receiving situation

| 정본 | 화자 | 수신자 | 소유하는 내용 | 들어가면 안 되는 내용 |
|---|---|---|---|---|
| Atlas | 제품 행동을 서술하는 중립 매뉴얼·상호작용 명세 | 제품을 이해하려는 사람과 구현자 | 화면, 제품 사용자 입력, 보이는 반응, System·Agent 처리, 제품 요소·관계·불변조건 | AI에게 주는 작성 지시, provenance·routing·audit, 독자의 사고 방식 해설 |
| 기술 Contract | 구현이 만족해야 할 규범적 기술 계약 | 구현자와 검증자 | state·data·identity·runtime·storage·authority·recovery 보장 | PM·WM·Main 업무 절차, 문서 작성법, source routing |
| 사용자 확인 원장 | 제품 소유자에게 필요한 결정 질문 | 제품 소유자 | 질문, 결정 이유, 영향, 계속 가능한 작업, 상태 | PM/AI 운영 절차, 175개 세부 조사 registry, audit history |
| 제품 문서 화자·운영 정본 | 문서 유지보수 규칙 | Main·PM·WM·문서 Agent | weave, source precedence, route, stable ID, provenance, audit, validator | 제품 내부 화면·객체·행동을 새로 정의하는 문장 |

Atlas에 남길 수 있는 메타정보는 사람이 실제 내용을 찾기 위한 짧은 목차·범례·링크뿐이다.
“독자는 이렇게 이해해야 한다”, “앞으로 반드시 이렇게 작성한다”, “Agent는 이를 기억한다”처럼
문서 생산자의 의도를 말하는 문장은 이 Governance로 이동한다. 제품 의미가 포함된 문장을 이동할
때에는 수신 문서의 화자에 맞게 다시 써야 하며, 운영 문장을 제품 발화처럼 복사하지 않는다.

비정본 설계에는 [ECS/CAP와 니즈 후보](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-review)와
[사용 흐름·UI 추천안](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-proposals-top)이 있다.
전자는 의미 수준의 상황을, 후자는 그 상황에서 파생한 후보 control·입력·화면 반응과
기술 연결을 소유한다. 구체 UI를 후자에 적었다는 이유만으로 Atlas의 확정 UI가 되지 않는다.
후보를 발전시키라는 요청과 각 정책 기본값을 승인하는 결정은 구별해 기록한다.

백서는 기업의 업무 담당자·의사결정자·파트너에게 제품의 문제의식, 이용 경험, 핵심 원리,
도입 가치와 한계를 설명하는 대외 문서다. 저장소 경로·개발 전환 주석·Agent 편집 지시·
검토 메모·미결정 라벨을 백서 안에 넣지 않는다. 변경 과정과 문체 조사 기록은 이 Governance
또는 일회성 검토 대화에 둔다. 백서에는 서술을 뒷받침하는 출처·참고문헌만 남기며,
설계 방향을 실제 출시·제공·검증 성과로 바꾸어 말하지 않는다.

### 독서 입구와 중복 관리

[docs/README](../README.md#docs-start)를 공통 독서 입구로 사용한다. 현재 설계 검토의
출발점은 UX 추천안이고, 시나리오는 필요한 배경, Atlas·Contract는 제품 기준,
사용자 확인 원장은 결정 확인, RWS·Governance는 근거와 유지보수 경로다.

- 추천·대안·손실의 상세 내용은 UX 추천안에 둔다. 원장에서는 비교할 절로 연결한다.
- 제품 질문·결정·현재 상태는 사용자 확인 원장에서 유지한다. 다른 문서는 현재 상태를
  별도 복제하지 않고 해당 HUM으로 연결한다. Q의 세부 조사·route와 과거 감사 상태는 이 Governance에 남는다.
- 시나리오의 니즈 점검에는 날짜가 있는 상황·공백·원 후보와 고유 검토 범위를 보존한다.
  이 기록의 후보 문구를 최신 추천안이나 별도 승인 대기 목록으로 다시 관리하지 않는다.
- 정본의 제품 동작과 기술 보장은 유지하며 원장에 결정한 내용이 반영될 때 함께 갱신한다.
  문서 수준의 제안/정본 구분은 개별 정책의 승인 상태와 다르다.
- 이동·병합 없이 가능한 정리는 기존 파일·앵커를 유지한다. 파일 수 감소를 위해 고유
  근거·상황·질문·흐름을 삭제하거나 별도의 정리 보고서를 추가하지 않는다.

### 0.2 UI/UX ↔ 기술 계약 weave cycle

새 기능은 사용 상황과 판단 흐름을 먼저 정하고, 그 흐름에 필요한 기술·UX를 왕복한 뒤
구체 UI와 Atlas 사용 절차로 전개한다. 기존 UI를 정정하는 경우에는 해당 trace부터
시작할 수 있다.

```text
사용 상황·목표·행위자·정보·상태 전환을 확인한다
-> 필요한 state/data/runtime/authority와 UX를 왕복한다
-> 확정한 흐름에서 UI control·layout·입력·feedback을 구체화한다
-> Atlas의 사용자 조작·화면 반응과 Contract의 기술 보장을 서로 연결한다
-> 둘 중 하나를 확정하려면 제품 의미 선택이 필요한 경우 HUM-*로 분리한다
-> HUM 답 없이도 가능한 작업과 실제 차단 범위를 기록한다
-> link·anchor·semantic drift 검사를 실행한다
```

### 0.3 상호작용 trace 작성 계약

각 trace는 다음 경계를 순서대로 분리한다.

```text
행위자의 의도와 시작 상태
-> 정확한 제품 사용자 UI 행동과 입력 소유자
-> 즉시 보이는 또는 접근 가능한 반응
-> 영속 상태와 일시 상태의 전이
-> System/runtime 처리
-> 실제 Agent inference 또는 tool 활동; 없으면 없음
-> dependency·recovery·approval 동작
-> 제품 사용자가 확인할 수 있는 완료 증거
```

내부 hydration, rendering, scheduling, permission 검사, persistence와 transport는
System/runtime 처리다. Agent turn 전후에 일어났다는 이유만으로 Agent가 직접 수행했다고
쓰지 않는다. 예시는 coverage probe이며 예시에 등장했다는 이유만으로 제품 요구사항으로
승격하지 않는다.

사용 시뮬레이션의 입력은 일반적인 가상 persona만으로 구성하지 않는다. WM이 관련 ECS·CAP와
실대화 기반 RWS를 좁혀 연결하고, 시뮬레이션 역할은 해당 사례의 실제 목적·환경·중단/교정
지점을 직접 읽은 뒤 현재 UX 경로를 따른다. UX 문서 안에 사례 링크가 있다는 사실은 그 원문을
읽었다는 증거가 아니다. 검토 반환에는 실제 읽은 파일·절/행과 `관찰된 사례 사실 / 새 제품에서
가정한 행동 / 발견한 설계 공백`을 구별해 남긴다. 근거가 없는 삭제·복구·소유권 같은 확장 분기는
실제 사건으로 꾸미지 않고 가정 기반 검토로 표시한다. 모든 검토자에게 전체 대화를 전달할
필요는 없으며, 다음 판단을 바꿀 관련 사례와 최신 사용자 결정만 준다.

`보인다`는 문장은 상태명 나열만으로 충족되지 않는다. 시작 화면에서의 위치·인접 요소·
기본 노출/펼침·가림·본문과 작성기의 면적·포커스 복귀를 설명하고 필요한 배치도를 붙인다.
클릭 수는 명시한 출발 상태에서 진입·선택·확정·복귀를 나누어 계산하며, OS/provider 조작·입력·
스크롤 비용을 숨기지 않는다. 여러 Board·동시 활동·긴 이름·좁은 화면으로 밀도를 높여 문서상
사용 흐름을 재검토한다. 실제 조작감·가독성·도달 시간은 개발 중 실제 화면에서 확인하되,
그 검증이 아직이라는 이유로 문서에서 찾을 수 있는 배치·경로 공백을 그대로 남기지 않는다.

### 0.4 외부 기술 조사와 구현 route

```text
PM: 제품 vision·사용자 결과·acceptance와 조사 필요성 framing
-> WM: 현재 source·dependency·local reference mapping
-> research: 최신 공식 문서·활성 reference implementation 비교
-> reuse 분류: dependency / protocol / pattern / code port / inspiration
-> license·security·maturity·integration cost·lock-in 검사
-> 구현 역할: 제품 계약 안에서 방법 선택
-> integration: 범위가 제한된 contribution 병합과 conflict 관리
-> 독립 review: 동작과 evidence 검증
```

조사가 부족한 기술 선택은 research pending으로 남긴다. 구현 편의를 제품 요구로 승격하거나
자체 framework를 조사 없이 기본값으로 만들지 않는다.

<a id="gap-maintenance-appendix"></a>

## 1. 목적과 비제품 문서 경계

이 문서는 제품 문서의 유지보수·검증 메타데이터만 소유한다.

- 출처와 provenance 분류, 스냅샷 해시 및 Git 상태
- trace·질문·승인 ID의 route, 배치, maturity, disposition 및 tombstone
- 사용자 확인 원장의 owner decision과 PM question packet의 운영 상태
- clean-room 오염 감사, 외부 참고자료 재사용 증거, 문서 간 drift
- Documentation Governance 변경 이벤트 `ATL-ED-*`

Governance는 제품 객체, 화면, 행동, 복구, 권한 또는 완료 조건을 새로 정의하지 않는다.
사용자 행동 본문은 Atlas, 기술 본문은 Contract, 제품 소유자 질문은 사용자 확인 원장에
둔다. Governance는 결정·변경 이력과 문서 운영 상태를 보존하지만 어느 제품 정본의
대체 문서도 런타임 증거도 아니다.

문서 간 탐색 링크는 다음 위치에 둔다.

- `BACKLINK-ATLAS-RESOLVED`: Atlas 상단의 사용자 확인 원장·Governance 링크
- `BACKLINK-CONTRACT-RESOLVED`: Contract 상단의 사용자 확인 원장·Governance 링크
- `BACKLINK-GAP-RESOLVED`: 사용자 확인 원장 하단의 Governance 호환 링크

링크가 존재한다는 사실은 제품 의미·구현·실행 상태의 증거가 아니다.
`.tmp/codex-swarm/atlas-redesign/`의 candidate 사본은 정본에 설치될 내용을
검사하기 위한 staging artifact이므로 링크도 정본 위치 기준 상대 경로를 유지한다.
링크 resolve 판정은 candidate staging 위치가 아니라 네 정본 파일의 실제
위치에서 수행한다.

## 2. 권한과 역할

| 역할 | 할 수 있는 일 | 할 수 없는 일 |
|---|---|---|
| 제품 owner | 제품 의미와 권한 경계에 대한 결정을 내리고 필요한 외부 승인을 부여·거부·보류한다 | 실행 성공을 승인 사실만으로 확정하지 않는다 |
| Main | owner decision을 Atlas·Contract·사용자 확인 원장에 반영하고, 최종 disposition·question packet routing·승인 묶음·문서 쓰기·Git을 단독 소유한다 | 근거 없는 제품 의미를 owner decision으로 승격하지 않는다 |
| PM | evidence-backed proposal, 선택지·trade-off, 질문 packet 및 승인 후보 package를 준비한다 | owner decision, final disposition, Git, 실행 성공 판정을 소유하지 않는다 |
| researcher / worker | bounded primary evidence와 재현 가능한 관찰만 수집하고 provenance를 붙인다 | 제품 방향을 승인하거나 질문 route·최종 문구·disposition을 확정하지 않는다 |
| WM | 경로 선택, 로컬 reference 위치, freshness, current-vs-reference 분류 및 drift 경고만 제공한다 | 제품 의미, PM 제안, owner decision, 승인 또는 Git을 소유하지 않는다 |

권한이 충돌하면 Main이 증거를 분리해 owner에게 필요한 결정만 route한다. 응답이 없으면 해당 질문과 종속 설계만 `OPEN`으로 대기하고, 무관한 로컬 조사·설계·검증은 계속한다.

## 3. 최초 범례

### 3.1 정본 provenance labels

Atlas의 기존 축약 표식은 이 Governance에서 다음 정본 label로 전환한다. 특히 기존 `[USER]` 표식은 `OWNER-DECISION`으로만 해석하며, 문서 작성자나 제품 사용자의 추정을 owner 결정으로 오인하지 않는다.

| label | 의미 | 제품 의미를 단독 확정할 수 있는가 |
|---|---|---|
| `OWNER-DECISION` | 제품 owner가 명시적으로 내린 최신 결정 또는 수정 | 예 |
| `COMMITTED-BASELINE` | owner 결정과 충돌하지 않는, 실패 라운드 이전의 커밋된 제품 기준선 | 후보만 가능; 최신 owner 결정이 우선 |
| `RUNTIME-OBSERVATION` | 현재 코드·실행 화면·로그에서 관찰한 구현 상태 | 아니요; 관찰한 시점의 상태만 입증 |
| `PRIMARY-REFERENCE` | 공식 문서, 표준, 원저자 자료 또는 유지되는 직접 참조 구현 | 아니요; proposal의 근거만 제공 |
| `PM-PROPOSAL` | 출처·fit·trade-off가 명시된 PM 권고안 | 아니요; Main의 결정 route가 필요 |
| `OPEN` | 원장에서는 남은 제품 정책 선택; Q의 초기 표기는 이력이며 현재 위임 설계 상태는 §8.3에서 별도로 판정 | 아니요 |
| `APPROVAL` | 외부 인프라·데이터 이동·credential·비용·배포·새 실행 권한 gate | 승인된 범위만 허용; 성공 증거와 별도 |
| `REJECTED` | 명시적으로 무효이거나 정의되지 않은 가정 | 아니요; 제품 사실로 재도입 금지 |

증거 우선순위는 다음과 같다.

```text
최신 OWNER-DECISION
> 양립 가능한 COMMITTED-BASELINE
> RUNTIME-OBSERVATION
> PRIMARY-REFERENCE
> PM-PROPOSAL
```

`OPEN`, `APPROVAL`, `REJECTED`는 증거 서열이 아니라 각각 미결 상태, 권한 gate, 배제 disposition이다. 더 최근의 owner 결정이 이전 결정을 바꾸면 Main은 이전 결정의 이벤트를 삭제하지 않고 superseded 관계를 기록한다.

### 3.2 route migration

Atlas의 legacy label `USER-PRODUCT`가 붙은 기존 72개 항목은 ID 집합, 제품 의미, 결정 권한 또는 배치 경계를 바꾸지 않고 이 Governance에서 `OWNER-PRODUCT`로 이름만 바꾼다. `PM-RESEARCH`는 그대로 유지한다. 이 Governance의 최종 candidate route는 기존 72/82에 Agent 질문 17/3과 로컬 computer-use 관찰 질문 1/0을 더한 `OWNER-PRODUCT 90 / PM-RESEARCH 85`다.

## 4. clean-room source boundary

아래 여섯 행은 기준 Atlas의 clean-room source boundary를 의미 변경 없이 유지하되, 예정 정본 경로에서 작동하도록 상대 링크만 전치했다.

| 출처 | 이 Atlas에서의 용도 |
|---|---|
| 이 Codex 작업에서 사용자가 제시한 수정사항, 특히 Board와 Desk 복원을 분리하고 Chat/Canvas, Answer Briefing(기존 Playback 명칭), 오케스트레이션, Ontology, 코딩 UX, 협업 및 computer-use를 바로잡은 제품 설계 대화 차례 | 최상위 결정 근거가 되는 제품 입력 |
| [EG-Desk 제품 비전 및 개발 할 일](../../ideas/confirmed/EGDESK_PRODUCT_VISION_AND_DEV_TODO.md), 실패한 Atlas 라운드 이전에 커밋된 `HEAD` 버전 | 이전 제품 기준선; 현재 미커밋 변환은 그 자체만으로 결정 근거가 되지 않음 |
| 구 EG-Desk Vision v1 백서 — 2026-09-06 작업 트리에서 삭제; 삭제 직전 원문은 Git blob `8248b68b8ef9469285e562d6f82fef79b8cd4c0a` | 당시 장기 개념 기준선; 이후 사용자 수정사항이 우선하며 Production v8로 과거 근거를 바꾸지 않음 |
| [apps/firefox-ui-demo/docs](../../apps/firefox-ui-demo/docs/) 아래에 있는 Firefox 제품/런타임 집중 문서의 커밋된 `HEAD` 버전 | 기준선 후보 및 용어 충돌의 증거 |
| [apps/firefox-ui-demo](../../apps/firefox-ui-demo/) 아래의 현재 Firefox 소스 | 구현 관찰에만 사용 |
| [Interaction Contract](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md)의 final-correction 직전 `UNTRACKED` snapshot, SHA-256 `42892ce140f81d2a2b67c548591cfb7ed7eb02e280e46796014d4b12552f5478`, 452 lines; 삭제 전 Atlas snapshot SHA-256 `b577608f81b73bc2b7c8690fd35987a8f283a90dcddc3f45eecb02552bfb64b2` | 동작, 객체 또는 기본값을 정립하는 데 사용하지 않음; 초안 후 부정 감사는 해당 정확한 snapshot의 오염이 다시 나타났는지만 확인할 수 있음 |

제외 이유는 다음과 같다.

- 위 hash로 식별한 Contract·Atlas snapshot은 동일한 이전 PM/Main 라운드에서 만들어져 서로 독립적인 증거가 아니므로 긍정적 동작 근거에서 제외한다. 오직 contamination negative audit에만 사용할 수 있다.
- 현재 미커밋 제품·런타임 문서는 owner 피드백을 유용하게 재서술했을 수 있어도 커밋된 기준선이나 owner decision이 아니므로 제품 의미 승격 근거에서 제외한다.
- 현재 구현은 `RUNTIME-OBSERVATION`으로만 사용할 수 있으며, 보이는 UI나 성공 응답이 지속성·외부 효과·완료를 입증한다고 확장하지 않는다.

**2026-10-29 태화 AX 후속 근거 범위**: 로컬 PM `01a1853a-53e9-76c3-ad90-e275395a7dd9`의 2·4차 응답은 Main이 전달한 제한적 자료에 대한 `PM-PROPOSAL`이다. 영업 백업은 고유 ID 130개 중 실제 대화 차례가 확인된 17개 표본으로 한정한다. Main이 전달한 AX 운영 12:26 v12는 문서 기록이며 현재 운영·직원별 권한의 live 검증이 아니다. 관련 문서 ID는 `atlas-org-use`·`tech-org-execution`·`org-delivery-priority`다. 이 출처나 ID 관계는 제품 정책 승인·구현·운영 검증의 증거가 아니다.

## 5. 현재 source snapshot과 candidate delta

### 5.1 기준 Atlas snapshot

| 항목 | 값 |
|---|---|
| source 상태 | Git `UNTRACKED` (`??`); 커밋된 기준선 아님 |
| SHA-256 | `b577608f81b73bc2b7c8690fd35987a8f283a90dcddc3f45eecb02552bfb64b2` |
| trace | 35 |
| interaction/action rows | 123 |
| question | 154 (`OWNER-PRODUCT` 72, `PM-RESEARCH` 82) |
| approval | 6 |
| owner decision batch | `D1`–`D9` |

### 5.2 현재 Atlas rewrite delta

| 항목 | 기존 | addition | candidate 합계 |
|---|---:|---:|---:|
| trace | 35 | 4 | 39 |
| interaction/action rows | 123 | 21 | 144 |
| question | 154 | 21 | 175 |
| `OWNER-PRODUCT` | 72 | 18 | 90 |
| `PM-RESEARCH` | 82 | 3 | 85 |
| approval | 6 | 0 | 6 |
| owner decision batch | 9 | 1 (`D10`) | 10 |

현재 Atlas rewrite는 네 흐름과 스물한 질문을 `OPEN` coverage로 포함한다. 문서에 포함됐다는 사실은 해당 미결정 제품 의미가 owner에 의해 확정됐거나 구현·검증·커밋됐다는 뜻이 아니다.

### 5.3 PM PASS final fingerprint

| artifact | SHA-256 | lines | 검증 상태 |
|---|---|---:|---|
| Atlas final | `142e1f890bbe1ed3144f0f0aba59c2388fd227170f46037b2a5003d8a94270e5` | 2756 | PM final `PASS`; candidate·actual validator `PASS` |
| Interaction Contract | `d05d7976b047b95cbad6e717bb34fdfe0fc27f58de1a30e44c77c21f8587a6e3` | 497 | Agent effective binding 정합화; actual link audit `PASS` |

원장 자체 hash는 원장 안에 기록하지 않는다. 자체 hash를 본문에 넣으면 기록할
때마다 값이 바뀌는 순환 참조가 되기 때문이다. 최종 Git·파일 audit에서는 원장
hash를 외부 검증 출력으로만 계산한다.

### 5.4 2026-08-05 manual-first / Answer Briefing revision

| artifact | SHA-256 | lines | 검증 상태 |
|---|---|---:|---|
| Manual-first Atlas | `cfc338a9684998199d3d722f6a7e44ab18ae4ea87516983af25cb74a56d0c6eb` | 2912 | 첫 화면 ASCII·입력 문법·11단계 첫 한 바퀴·39개 상세 trace; candidate·actual validator `PASS`; PM 재감사 `PASS` |
| Interaction Contract | `ec8fea2f2ce7ddd9ccd403b69765218d4d4e6edc250caaf41697107c8f315a2b` | 517 | §4·§8 Answer Briefing 정합화; Run replay 의미 제거; PM 재감사 `PASS` |

이 revision은 stable `OBJ-038`–`OBJ-040`, `AI-05`, `Q-MEDIA-*`와 기존
explicit anchor를 유지했다. `Q-MEDIA-04`는 `Answer Briefing / 답변 브리핑`과
`브리핑 보기`를 1순위로 제안하되 owner가 정본 라벨을 확정할 때까지 `OPEN`이다.
행동 의미는 이름 결정과 무관하게 `Agent=공개 가능한 target set·Briefing
Order·Focus Scope·Step Explanation 제안`, `System=대상 검증·사용자 입력에 따른
화면 전환`, `제품 사용자=이전·다음·직접 이동·전체 보기·종료 및 의견 작성`으로
고정한다.

### 5.5 2026-08-06 Agent observation fidelity revision

| artifact | SHA-256 | lines | 검증 상태 |
|---|---|---:|---|
| Observation-fidelity Atlas | `bd053ad4109950a2868f754db75af4f7059367ba9a55d56be076384c5efffe87` | 3054 | 첫 한 바퀴, `AI-01`, `AI-04`, `OBJ-052`, `M5-F`, 불변조건 32–33 정합화; 21개 aspect map; candidate·actual validator `PASS` |
| Interaction Contract | `fafcd24d1edf4b3b1c6fbe8449c404557ca12a52810d14fbcd9647428942339f` | 640 | §4.1에서 mutable resource, Tool Result Snapshot, inference별 Agent Input Snapshot, Canvas projection, runtime handoff evidence와 provider 비관찰 경계를 분리 |

이 revision은 logical locator·resource/session binding을 콘텐츠 동일성 증거로 쓰지
않는다. 완료 활동의 기본 Canvas 대상은 `[Agent에게 전달된 버전]`이며, raw tool
result, 현재 상태와 차이는 별도 행동으로 연다. snapshot이 없거나 provider가 정확한
payload를 공개하지 않으면 현재 내용을 역사적 입력으로 재구성하지 않는다. 입력
후보를 준비·저장한 사실만으로 전달됐다고 표시하지 않고 같은 inference attempt와
payload integrity reference의 runtime handoff가 확인된 경우에만 `전달됨`을 쓴다. 정확한
보존 기간·대용량·binary·secret·권한 철회 정책은 `Q-AI-04`에서 계속 추적한다.

### 5.6 2026-08-06 Snapshot/Live viewer simplification

| artifact | SHA-256 | lines | 검증 상태 |
|---|---|---:|---|
| Snapshot/Live Atlas | `f56e20605c67e5ee1b9ebca321379c62483e2cb43247bd5d8efd2abb50ad7d76` | 3058 | 첫 한 바퀴, `AI-01`, `AI-04`, `OBJ-024`, `OBJ-052`, `M5-F`, 불변조건 32–33 정정; 21개 aspect map; candidate·actual validator `PASS` |
| Interaction Contract | `741187bf12ff08661746e36412e6a036c9234e8b8b4e9e381152917dd6034c04` | 625 | §4.1을 정상 도구 결과와 Agent Observation Snapshot의 일대일 계약 및 Snapshot View/Live View 두 사용자 표면으로 단순화 |

이 revision은 5.5와 `ATL-ED-0012`의 과도한 4계층 설명을 의미상 대체하되 해당 이력은
삭제하지 않는다. 정상 경로에서 도구가 성공적으로 반환한 전체 결과가 곧 불변
`Agent Observation Snapshot`이며 Agent도 같은 전체 결과를 받는다. File read가
40–80행을 반환했다면 snapshot과 Agent 입력 모두 40–80행을 포함하고, 무표시
생략·요약·부분 선택은 허용하지 않는다. 사용자 표면은 도구 호출 당시 내용을 보여 주는
읽기 전용 `Snapshot View`와 현재 resource/runtime를 다루는 `Live View`로 구분한다.
같은 renderer 구현을 재사용할 수 있지만 두 view는 별도 identity로 같은 Canvas에
공존한다. Answer Briefing은 snapshot과 고정된 파생 산출물을 사용하고, 제품 사용자가
직접 다루는 live Browser·File·Terminal은 이를 덮어쓰지 않는다. provider 내부
tokenization·attention과 runtime handoff 세부는 이 제품 상호작용 계약의 설명 범위에서
제거했다. 정확한 보존 기간·대용량·binary·secret·권한 철회 정책은 `Q-AI-04`에서 계속
추적한다.

### 5.7 2026-08-08 UI/UX ↔ 기술 계약 weave revision

5.6의 “모든 정상 도구 결과와 Agent 입력은 일대일” 규칙은 **direct named tool
result에만 적용**되고, Smart Read에는 적용되지 않는다. 이번 revision이 5.6의 현재
제품 의미를 supersede한다. Smart Read는 immutable raw/source capture, Reader Context
Packet과 요청 담당 Agent에게 실제 전달된 payload를 분리해 coverage·transformation lineage를
보존한다. Snapshot View와 Live View라는 두 사용자 표면은 유지하되 Snapshot 안에서
payload role을 검사할 수 있다.

동시에 Atlas는 UI 행동 정본, Contract는 기술 정본으로 역할을 분리했고 `READ-01`–
`READ-03`, `ENGINE-01`, `OBJ-054`–`OBJ-056`을 추가했다. 제품 소유자가 답해야 하는
의미 선택은 [사용자 확인 원장의 18개 `HUM-*`](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#gap-owner-queue)로 승격했으며, 기존 175개 `Q-*`는 상세 UI 연구와
stable-link 호환 색인으로 유지한다.

### 5.8 2026-09-13 최초 사용·기본 Codex·작업/생각 공간 반영

최신 사용자 결정에 따라 Atlas·Contract·UX·원장의 첫 사용·대화·활동 의미를 정정했다.
최초 Browser 집중 시작, 온라인 Desk 진입, 사용자 정의 Agent 없이 기본 Codex 사용,
선택적 Agent의 personality·생각 공간, 실제 작업 대상의 표시와 과거 기록 패널을 구분한다.
5.5–5.7의 관찰 동일성은 유지하되 완료된 관찰의 기본 Canvas 진입·매 이력 Canvas node
요구는 새 기록 패널 경계로 대체한다. 명시적인 보고/Briefing 근거는 Canvas에 둘 수 있다.

Agenda는 일할 준비가 된 자료·도구·대화·배치·연결의 구성으로 설명한다. 명칭 후보는
[UX 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#agenda-name-candidates)에
두며 선택·일괄 개명을 하지 않았다. 단일 로그인 뒤 Browser 프로필 자동 준비와 별도 온라인
회원 identity는 후보·질문으로 남겼다. 독립 EG-Desk 배포 목표와 선택적 Firefox fork를 구별한다.

이번 요청은 문서 반영에 한정된다. 시뮬레이션, 앱·프로필 실행, 전체 Q 독립 재검토,
코드 수정, commit/push를 수행한 것으로 기록하지 않는다. 앞선 TRI-02와 9/10 역할 기록은
당시 범위로 보존하며 새 문서를 검증한 결과로 소급하지 않는다. [현재 재검토 상태](#design-closure-status).

<a id="doc-board-naming-20260926"></a>

### 5.9 2026-09-26 Board 표시명 적용

**제품 소유자 결정**: “최종 결정: 임시로 agenda -> board로 바꾸자. 그냥 보드 판때기가 더 직관적인것 같아. 문서들 싹 다 고쳐줘.” 현재 제품 표기는 영문 단수 `Board`, 복수 `Boards`, 한글 `보드`다. `임시`는 이 표시명이 향후 다시 바뀔 수 있다는 뜻이지 지금의 명칭 선택이 `OPEN`이라는 뜻이 아니다. 2026-09-13의 명칭 후보·미선정 상태와 `ATL-ED-0029`의 `NAMING-OPEN`은 당시 상태로 보존하고, 현행 적용 기준만 이 절에서 대체한다.

**유지되는 제품 의미**: Board는 한 Desk의 한 Canvas 안에서 자료·도구·대화·그룹·배치·참조 연결을 갖춘 업무 구성이다. Canvas 자체, Kanban형 메모판, 별도 Desk·Workspace 또는 새로운 객체가 아니다. `Saved Board`의 명시적 구성 저장과 자동 Desk session 복원, live runtime 수명은 여전히 별개다. 명칭 결정은 HUM-AGENDA-001의 저장·복구, HUM-SURFACE-001의 공유 실행, HUM-CONV-001의 공개·귀속, HUM-ORCH-001의 예약 정책을 닫지 않는다. 원장의 해당 주제 상태는 계속 `OPEN`이다.

**문서·호환 범위**: 현재 설명·화면 라벨·도표는 Board/Boards·보드로 전치한다. `AG-*`, `Q-AG-*`, `HUM-AGENDA-001`, 기존 문서 경로·외부 URL, `agendaId` 등 실제 wire/storage 식별자와 원본 인용은 유지한다. 기존 `agenda` fragment는 호환 anchor로 남기고 새 `board` fragment를 같은 절에 병기한다. 이 변경은 문서 표기에만 적용하며 저장 스키마 마이그레이션이나 코드·런타임 변경을 뜻하지 않는다. 기존 감사 지문과 과거 PASS는 당시 본문에 대한 기록이다. 이번 변경의 링크·의미 재검토는 별도 검증으로 판정한다.

## 6. stable ID와 explicit anchor 규칙

1. Atlas가 trace ID와 `OBJ-*` 제품 요소, `AFF-*` 비객체 어포던스의 정본 정의를 소유한다. 사용자 확인 원장은 `HUM-*` 질문·결정을 소유한다. Governance는 `Q-*` 세부 조사, approval registry, route, disposition과 유지보수용 `EXC-*`를 소유한다. `EXC-*`는 제품 ID나 제품 anchor가 아니다.
2. Governance는 자체 편집 사건에만 `ATL-ED-0001` 형식의 단조 증가 event ID를 사용한다. event ID는 재사용하거나 다시 번호 매기지 않는다.
3. 제목, 한글 표현, 섹션 위치가 바뀌어도 기존 ID는 바뀌지 않는다. 의미가 갈라지면 새 Atlas ID와 관계를 만들고 Main이 disposition한다.
4. 제거·병합·대체된 ID는 삭제하지 않고 tombstone으로 남긴다. tombstone에는 `status`, `superseded-by` 또는 `merged-into`, 사유, Main disposition event를 기록한다. tombstone ID는 재사용하지 않는다.
5. 네 정본 문서는 자동 생성 heading slug에만 의존하지 않고 명시적 HTML anchor를 둔다. Atlas 패턴은 trace `atlas-<trace-id-lower>`, 제품 요소 `atlas-<obj-id-lower>`, 어포던스 `atlas-<aff-id-lower>`다. Contract는 `tech-*`, 사용자 확인 원장은 `hum-*`와 `gap-*`, Governance는 legacy-compatible question·approval anchor와 `doc-*`를 쓴다. `EXC-*`에는 제품 anchor를 만들지 않는다. 표시명 전환에서는 기존 `agenda` fragment를 호환 별칭으로 유지하고 같은 대상에 새 `board` fragment를 병기한다. 안정 ID는 이름에 맞춰 재부여하지 않는다.
6. 의도적으로 비어 있는 기존 Board 질문 번호는 새 질문으로 채우지 않는다. 새 질문은 Main이 Atlas namespace와 충돌 여부를 확인한 뒤 다음 유효 ID를 배정한다.
7. 네 정본에는 raw prompt, 비공개 chain-of-thought, credential·token·session secret, 개인 데이터, 절대 로컬 경로를 넣지 않는다. 근거는 repo-relative path, 공개 URL, commit, hash, bounded evidence summary로 남긴다.

## 7. trace registry — 43

제품 행동 본문은 의도적으로 생략한다. `maturity`와 `provenance`만 유지한다.

<!-- TRACE-REGISTRY:START -->
| trace ID | maturity | provenance |
|---|---|---|
| `L-01` | `PARTIAL` | `OWNER-DECISION + COMMITTED-BASELINE` |
| `L-02` | `PARTIAL` | `OWNER-DECISION` |
| `L-03` | `PARTIAL` | `OWNER-DECISION` |
| `AG-01` | `PARTIAL` | `OWNER-DECISION + COMMITTED-BASELINE` |
| `AG-02` | `PARTIAL` | `OWNER-DECISION` |
| `AG-03` | `PARTIAL` | `OWNER-DECISION` |
| `AG-04` | `PARTIAL` | `OWNER-DECISION + COMMITTED-BASELINE + RUNTIME-OBSERVATION` |
| `V-01` | `PARTIAL` | `COMMITTED-BASELINE + OPEN` |
| `V-02` | `PARTIAL` | `COMMITTED-BASELINE + RUNTIME-OBSERVATION` |
| `V-03` | `BASELINE-CANDIDATE` | `COMMITTED-BASELINE + RUNTIME-OBSERVATION` |
| `DISC-01` | `BASELINE-CANDIDATE` | `COMMITTED-BASELINE + OPEN` |
| `TOOL-01` | `PARTIAL` | `OWNER-DECISION` |
| `BROWSER-01` | `PARTIAL` | `OWNER-DECISION + COMMITTED-BASELINE` |
| `BROWSER-02` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `BROWSER-03` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `BROWSER-04` | `PARTIAL` | `OWNER-DECISION` |
| `TOOL-02` | `PARTIAL` | `OWNER-DECISION` |
| `CHAT-01` | `PARTIAL` | `OWNER-DECISION + COMMITTED-BASELINE` |
| `AI-01` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `AI-02` | `PARTIAL` | `OWNER-DECISION` |
| `READ-01` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `READ-02` | `PARTIAL` | `OWNER-DECISION` |
| `READ-03` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `ENGINE-01` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `AI-03` | `BASELINE-CANDIDATE` | `COMMITTED-BASELINE + OWNER-DECISION + OPEN` |
| `AI-04` | `PARTIAL` | `OWNER-DECISION` |
| `AI-05` | `PARTIAL` | `OWNER-DECISION` |
| `CANVAS-01` | `PARTIAL` | `OWNER-DECISION + COMMITTED-BASELINE + RUNTIME-OBSERVATION` |
| `AI-06` | `PARTIAL` | `OWNER-DECISION` |
| `AI-07` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `AUTH-01` | `PARTIAL` | `OWNER-DECISION` |
| `CODE-01` | `PARTIAL` | `OWNER-DECISION` |
| `TERM-01` | `PARTIAL` | `OWNER-DECISION` |
| `ONT-01` | `PARTIAL` | `OWNER-DECISION` |
| `ONT-02` | `PARTIAL` | `OWNER-DECISION` |
| `COL-01` | `PARTIAL` | `OWNER-DECISION + APPROVAL` |
| `CU-01` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `DATA-01` | `PARTIAL` | `OWNER-DECISION + APPROVAL` |
| `UX-01` | `PARTIAL` | `OPEN` |
| `AGENT-01` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `AGENT-02` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `AGENT-03` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `SYS-01` | `PARTIAL` | `OWNER-DECISION + OPEN` |
<!-- TRACE-REGISTRY:END -->

## 8. question routing registry — 175

각 `Q-*` ID는 이 registry에 정확히 한 번만 나타난다. 이 운영 정본이 세부 UI
초기 질문 본문·route·work group·결정 이력과 기존 링크를 보존하는 호환 anchor를 소유한다.
현재 설계 처리·검토 상태는 [§8.3](#design-closure-status)가 정본이다.
제품 소유자 결정이 필요한 질문의 정본은 [사용자 확인 원장](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#gap-owner-queue)의 `HUM-*` 목록이다.

### 8.1 PM work groups

| PM work group | 범위 | 질문 수 |
|---|---|---:|
| `P1-LIFECYCLE-RECOVERY` | 실행·세션 복원·기능 저하·재진입 | 9 |
| `P2-AGENDA-LIFECYCLE` | Board 생성·열기·저장·충돌·보관·삭제 | 11 |
| `P3-VIEW-CANVAS-DISCOVERY` | view 조작·Canvas 탐색·검색·Library | 12 |
| `P4-CHAT-AI-MEDIA` | Chat·AI request·context·Canvas/Answer Briefing media | 12 |
| `P5-ORCHESTRATION-APPROVAL` | 작업 전환과 승인 경계·컨트롤 | 3 |
| `P6-ACCOUNT-BROWSER-EVIDENCE` | 계정·Browser·외부 효과 증거 | 9 |
| `P7-CODE-TERMINAL` | 사람 중심 coding·file·Terminal lifecycle | 9 |
| `P8-ONTOLOGY-COLLAB-CU` | Ontology·협업·computer-use | 10 |
| `P9-DATA-ACCESSIBILITY` | 데이터 수명주기·키보드·접근성 | 7 |
| `P10-AGENT-PROFILE-RUN` | capability/availability UI, 반복 acceptance, 경계별 장애 진단·복구 | 3 |
| **합계** |  | **85** |

<a id="pm-work-disposition"></a>
### 8.2 초기 PM 조사·설계 분류와 검토 이력 (2026-09-08)

아래 표는 최초 PM 질문 85개를 10개 work group으로 나눴던 작업 범위다.
초기의 `OPEN`과 미래형 작업 설명을 현재 미완성 설계의 집계로 사용하지 않는다.
각 Q의 상세 조작·처리·인수 절차와 독립 검토는 [§8.3](#design-closure-status)에서 확인한다.
정책에 의존하는 값만 HUM에 남으며 설계안 준비를 owner 결정이나 runtime 검증으로 해석하지 않는다.

후속 사용 시뮬레이션에서는 [Library·그룹](../references/design-synthesis/egdesk-ux-realization-proposals.md#library-groups),
[실행 설정](../references/design-synthesis/egdesk-ux-realization-proposals.md#execution-settings)·[정책 충돌](../references/design-synthesis/egdesk-ux-realization-proposals.md#policy-conflicts),
[동시 변경](../references/design-synthesis/egdesk-ux-realization-proposals.md#collaboration-changes)·[소유권 이전](../references/design-synthesis/egdesk-ux-realization-proposals.md#desk-ownership),
[Saved Board 삭제·복구](../references/design-synthesis/egdesk-ux-realization-proposals.md#agenda-delete-recover),
[범위별 초기화](../references/design-synthesis/egdesk-ux-realization-proposals.md#data-reset)를 기존 9개 흐름·7개 정책절 안에서 보완했다.
역할별 조작·보이는 결과·실패/취소/복귀를 문서로 대조한 것이며, 실제 입력·기술 동작 검증은
기존 12개 검증 계획의 해당 행에 연결했다. 세부 추천을 확정 정책으로 승격하거나 아래 Q의
담당·상태를 변경하지 않는다. 추천·대안 본문은 UX에만 유지한다.

<a id="doc-scenario-walkthrough-inputs"></a>

<a id="doc-sim-improvement-loop"></a>
**2026-09-10 이후 적용 — 사용자·제품 Agent·System의 상호작용에서 설계 개선까지:** 리허설의 운영 목표는 기존 UI로 목적을 달성할 수 있는지뿐 아니라, 사용자의 불필요한 조작·탐색·학습 부담, 제품 Agent의 맥락·도구 사용상 막힘, System의 전달·상태 처리 공백을 찾아 대안을 비교하는 것이다. 사용자 역할이 우회해 완료했거나 불편 flag를 기록한 것만으로 Main의 개선 검토를 끝내지 않는다. 이 절은 이후 운영 규칙이며 아래 과거 회차의 수행 방식·완료 근거로 소급하지 않는다.

**사용자 승인 확인 — 2026-09-10:** 사용자는 이 방식을 문서에 반영하고 이후 시뮬레이션에서 개선까지 반복적으로 발굴·축적하는 기본 절차로 삼는 데 동의했다. 아래 반복은 이후 시뮬 작업의 기본 운영 방식이다. 이 승인은 메시지 입력칸의 6·8줄 같은 개별 실험값이나 모든 개선 후보의 일괄 채택을 뜻하지 않는다.

<a id="doc-sim-three-perspectives"></a>
**연계 역할 확장 — 2026-09-10:** 사용자는 사람의 1인칭 행동뿐 아니라 EG-Desk 속 Agent와 System의 상호작용까지 연결하도록 요청했다. 이전 P0·FP·CP 회차에서 Agent 답변을 가상 결과로 제공한 것은 제품 Agent가 독립적으로 도구를 선택한 리허설과 다르다. 이전 수행 범위는 그대로 두고 이후 관련 회차에 아래 경계를 적용한다.

| 역할 | 전달받을 정보 | 선택·처리할 일 | Main이 대신하지 않을 일 |
|---|---|---|---|
| 제품 사용자 | 현재 보이는 UI, 자신의 목적·입력·이전 관찰 | 클릭·입력·제스처·화면 확인·사용감과 다음 행동 | 숨은 System 상태나 Agent 내부 자료를 미리 알려주지 않음 |
| EG-Desk 속 Agent | 그 요청에 실제로 전달할 맥락·첨부 참조, Profile의 해당 설정, 허용 도구 설명·권한, 전달된 관찰 결과 | 정보가 충분한지 판단하고 자료 읽기·조회·작업·보고 요청을 고름. 필요한 복구·질문도 자기 입력 근거에서 선택 | 모범 답변·원문 전체·다른 역할의 숨은 상태를 먼저 주거나 Agent 답변·도구 선택을 Main이 작성하지 않음 |
| System 모형 | 요청과 tool event, 고정한 자원 등록부·권한·revision·화면 상태, 문서 규칙·명시한 외생 사건 | 맥락 구성, 대상·권한·상태 확인, 모형 도구 결과, 기록·UI 투영, 응답 전달 | 인격체처럼 느끼거나 의미 판단을 만들어내지 않음. Agent의 계산·주장을 몰래 고쳐 성공 결과로 반환하지 않음 |

여기서 제품 Agent는 시뮬을 운영하는 Main·PM·WM·Designer와 다른 **실험 대상 역할**이다. System 모형은 Main의 명시적 상태 처리나 필요한 별도 역할로 운영할 수 있으며, 항상 세 개의 모델을 실행할 필요는 없다. Agent가 관여하지 않는 단순 Canvas 탐색 등은 그 역할을 `비관여`로 명시한다. Agent 작업이 결과에 영향을 주는 회차에서는 준비된 Rio 답변을 전달하는 것만으로 Agent 관점까지 검토했다고 처리하지 않는다.

연결은 `사용자 행동 → System의 실제 전달 맥락 → 제품 Agent의 요청 → System의 결과·오류 → 제품 Agent의 응답/산출물 요청 → System의 UI 반영 → 사용자 후속 행동`으로 추적한다. 각 역할은 자기에게 전달된 정보만 소비한다. Main은 사건 순서·요청/응답의 연결·전후 상태와 각 수신자가 받은 내용을 기록한다. private 추론 전체나 provider 내부 토큰 주의를 관찰했다고 주장하지 않는다.

실험 전에 초기 UI·자료·권한·도구 봉투·응답 및 interleaving 조건을 고정한다. 제품의 실제 API가 아직 없으면 **문서 실험용 relay**라고 표시하며 새 API 이름·영속 객체·실제 구현 계약으로 승격하지 않는다. 자료 본문은 Agent가 읽기 요청을 한 뒤에만 전달한다. Agent가 반환한 사용자 설명·산출물 내용은 그 응답 그대로 사용하고 System은 명시된 표시·참조 검사만 적용한다. 확인된 semantic 오류는 별도 finding 또는 실제 후속 사용자 질문으로 다루며 숨겨서 고치지 않는다.

사용자가 다른 View를 여는 동안 이전 요청의 도구 응답이 돌아오는 경우처럼, UI와 Agent 작업 사이의 사건 순서도 포함한다. 잘못된 참조·권한 철회 등을 의도적으로 넣는 통제 검사는 **주입한 시험 조건**으로 구분하고, 스스로 발견한 제품 결함으로 보고하지 않는다. 실제 코드·브라우저·외부 서비스의 동작 증거와 문서 모형의 결과는 분리한다.

첫 연결 예시와 확인 범위는 [TRI-01 — A 요약 중 사용자가 B를 여는 사례](../references/design-synthesis/egdesk-user-action-rehearsal-log.md#three-perspective-rehearsal)에 있다. 사용자·제품 Agent의 독립 행동과 System의 전후 상태를 같은 사건 기록으로 연결했고, 게시 relay의 사람용 문장·항목별 근거 분리 후보를 Agent→System 범위에서 재검사했다. 기준 사용자 리허설, 후보의 전달·표시 모델 검사, 아직 하지 않은 후보 사용자 재리허설을 구분한다.

사용자 역할은 현재 보이는 화면에서 한 동작씩 행동하고 결과·사용감을 말한다. 자연스러운 기대나 바라는 동작은 표현할 수 있지만, 보이지 않는 컨트롤이나 성공 응답을 만들어내지 않는다. **이 맹검 경계는 사용자 역할에 적용한다. Main/Designer의 개선 탐색까지 금지하는 규칙이 아니다.** Main은 중요한 마찰이 발견되면 다음을 연결한다.

1. **사용자 목적을 다시 잡는다.** 예를 들어 `Pan 버튼을 어떻게 쓰게 할까`가 아니라 `옆 자료를 보려는 사람이 왜 별도 모드·키 조합을 배워야 하나`를 검토한다. 권한·데이터 보존·제품 의도는 제약으로 유지하되, 현재 문서의 버튼·모드·고정 크기는 개선 가능한 가설로 취급한다. 명시적인 사용자 결정과 충돌하는 대안은 그 충돌을 표시한다.
2. **브레인스토밍과 외부 probe를 진행한다.** Main 또는 필요한 Designer가 대안을 구상한다. WM이 알고 있는 관련 참고자료를 우선 재사용하고 부족하면 공식 제품 도움말·공식 컴포넌트 문서·원 저장소·실제 화면을 확인한다. 무엇이 확인된 동작이고 무엇이 EG-Desk용 차용 가설인지 적는다. 유명 제품의 이름만으로 레퍼런스를 대신하거나, 다른 표면의 동작을 같은 UI라고 취급하지 않는다.
3. **비교할 만큼의 후보를 만든다.** 기존안과 대안을 같은 목표·자료량·화면 크기·초안·권한·입력 조건에서 비교한다. 작은 수정에는 간단한 전후 비교, 상충하는 해법에는 복수 후보를 사용한다. 고정 Agent 수나 불필요한 조사량을 요구하지 않는다. 후보를 잘 보이게 하려고 업무 내용·주변 View·기존 제약을 제거하지 않는다.
4. **후보를 다시 각 당사자의 관점에서 밟는다.** 사용자 역할에는 선택한 후보의 현재 화면만, 제품 Agent에는 실제 전달할 요청·도구·관찰만 준다. `개선안`, 정답, 기대 장점, 다른 후보의 실패를 알려주지 않는다. 필요한 경우 새 맥락을 사용한다. 클릭·키·포인터·입력·도구 요청·System 전후 상태·화면 반응을 사건별로 연결한다. 비교용 화면 값과 정상 응답 조건은 시작 전에 준비하고, 실제 렌더링으로 확인하지 않은 배치·행수는 가정으로 표시한다.
5. **부담이 옮겨갔는지까지 비교한다.** 사용자에게는 조작·용어 학습·재탐색·문안 확인·가림·복귀·좁은 화면의 부담을, 제품 Agent에는 대상·범위 식별·도구 발견·불필요한 재조회·오류 복구·판단에 필요한 맥락을, System에는 요청/응답 대응·권한·revision·표시 일치와 동시 상태 변화를 확인한다. 사람의 클릭을 줄이는 대신 Agent가 추측하게 만들거나, Agent의 호출을 줄이는 대신 필요한 맥락을 누락시키지 않는다. 사용자 역할의 발언, Agent의 실제 요청·응답, 모형이 정의한 결과, 설계자의 해석을 분리한다. 한 역할의 완료 선언만으로 전체 연결을 통과시키지 않는다.
6. **Main이 다음 처리를 소유한다.** 현재 위임 안에서 해결할 설계는 비교 결과를 근거로 다음 수정·검토로 이어간다. 의도·권한·공개 범위·비용·인프라 등 실제 사용자 선택이 필요한 것만 기존 원장에 모으며 독립 작업은 계속한다. 채택·기각·판단 보류·추가 검증 각각에 이유를 남긴다. 중요한 마찰은 대안 검토 결과 또는 검토하지 않은 구체적인 이유가 있어야 하며, 단순 flag 목록이나 사용자에게 해결책을 요구하는 상태로 종료하지 않는다.

**개선의 축적과 문서 반영:** 회차마다 실제 사례와 남은 공백에서 범위를 고르고, 이미 찾은 문제는 기존 finding에 근거를 보강한다. 결과에는 문제가 드러난 장면·동작, 대안과 참고자료, 줄어든·남은·새 부담, 선택 이유, 적용할 문서 위치와 남은 검증을 연결한다. 유효한 개선을 찾지 못한 경우도 그 이유를 남기며, 발견 건수를 채우려고 기능이나 불편을 억지로 만들지 않는다.

현재 위임 안에서 채택한 개선은 Main이 UI 문서에 반영하고, 제품 의미·상태 처리의 변경이 있으면 필요한 Atlas·기술 계약도 함께 맞춘다. 의미 판단이 필요하면 PM과 대조한다. 미결 정책은 기존 사용자 확인 원장으로 분리하고, 그 답을 기다리지 않아도 되는 다른 개선은 이어간다. 반영한 변경은 관련 장면을 다시 밟아 검토하며, 문서 반영·재리허설·실제 구현 검증의 상태를 각각 남긴다. 같은 사례의 성공만 반복해 수를 늘리지 않고 좁은 화면·긴 입력·다른 상태 전환 등 남은 조건으로 범위를 넓힌다.

Pan의 클릭 활성 방식처럼 사용자가 이미 제시한 해법은 **사용자 제안**으로 추적한다. 이후 같은 생각을 떠올렸다고 독립 발견으로 기록하지 않는다. 재사용할 운영 규칙은 이 절에, 일회성 후보·화면 조건·행동 교환은 [리허설 기록의 후속 probe](../references/design-synthesis/egdesk-user-action-rehearsal-log.md#composer-improvement-probe)에 둔다. 실제 사용성·기술 동작은 별도 구현 단계에서 검증한다.

**연결 재리허설의 모형 품질 — 2026-09-10 후속:** [이번 기록](../references/design-synthesis/egdesk-user-action-simulation-2026-09-10.md#simulation-top)에서 드러난 모형 준비·표현 오류는 제품 결함과 별도 기록한다. 다음 회차에는 아래를 적용한다.

- 시작 전에 모든 열린 View의 전체 rect·가림·본문, 사용자 보유 정보, 자료/권한/입력 focus, 외생 응답·시점과 허용 도구를 고정한다. 원문은 System 모형에만 준비하고 Agent에게는 읽기 요청 뒤 전달한다. 시험용 비밀번호는 실제 값이 아닌 합성값으로 준비하고 Agent·Chat·공개 기록에는 전달하지 않는다.
- 모형의 ID·조건문·`FIXTURE`·`D/S` 같은 진단 표기를 제품 화면의 문장으로 복사하지 않는다. 메타 표식만 지워 불완전한 문장을 만드는 것도 피한다. 역할이 보는 화면은 해당 사람의 이름·기기·행동·허용 조건으로 전치한다.
- 참가자마다 열린 상세·카메라·focus를 유지한다. 관측 역할을 바꾸는 것은 시험 진행자의 관점 전환이지 제품이 상대 화면을 닫거나 카메라를 옮기는 사건이 아니다.
- `Type`이 다른 필드로의 이동을 포함했다면 물리 클릭 수를 확정하지 않는다. 포커스 이동·타이핑을 분리한 재검사를 사용한다. 정상 텍스트 입력·OS 파일 선택기의 구체 모형은 준비할 수 있으며 이를 빠뜨린 것은 제품의 새 정책 질문이 아니다.
- 보이지 않는 진입점을 찾지 못해 질문·대기를 반복하면 그 지점에서 개선 탐색으로 전환한다. 같은 화면을 반복 반환한 뒤 우회 성공으로 끝내지 않는다. 제품 공백, 자료 준비 부족, relay 오류를 구별하고 수정된 조건은 새 회차로 표시한다.
- 사용자 목적의 달성과 추가 통제 검사를 나눈다. 숨은 검사 조건을 충족하지 않았다는 이유로 사용자 화면에 ‘미완료’ 안내를 만들어 넣지 않는다. 원래 목적 뒤의 추가 gesture·fault injection은 별도 검사다.
- trace 배정/정적 대조, 실제 사용자 행동 교환, 제품 Agent의 독립 도구 선택, 통제된 System 조건, 실제 구현 실행의 집계를 구별한다. 등록 항목 수나 링크 검사만으로 시뮬레이션 완결·시각 품질을 판정하지 않는다.

운영 참고: [OpenAI의 평가 과정](https://developers.openai.com/api/docs/guides/evaluation-best-practices)은 목표·사례·기준을 정해 실행을 비교하고 반복하며 사람의 피드백으로 평가를 보정하는 원칙을 설명한다. 여기서는 그 반복 원칙만 참고하며, 현재 Codex-native 역할 작업을 별도 Evals 서비스·SDK·API 키 방식으로 전환하지 않는다.

**2026-09-09–10 행동 리허설 REDO — 이번 기록 종료, 미도달·공백 있음**: [사용자 행동 리허설 결과](../references/design-synthesis/egdesk-user-action-rehearsal-log.md#results)에 8개 여정·9개 회차의 사용자 동작과 문서 모형의 화면 응답을 기록했다. 목표 도달과 사용감·추가 조작·우회 후에도 남은 마찰을 별도로 보존했다. 문서 공백과 Main의 모형 준비 부족을 구분하며, 43개 trace의 모든 분기 완주·실제 시각 품질·실행 검증으로 주장하지 않는다. 아래 과거 검토와 §8의 정합성 판정도 이번 사용성의 PASS 근거가 아니다. 초기 파일럿의 사용감은 사용자 지적 뒤 받은 회고이며 최초 기록으로 소급하지 않는다. 제품 동작·HUM 선택·구현 상태는 이 기록만으로 변경하지 않았다.

**2026-09-08 사용자 역할 검토의 사례 입력**: 첫 정제 검토에는 현재 UX·확정 경계를 전달했지만
RWS 원문을 직접 읽도록 지정하지 않았다. 사용자 지적 뒤 아래 사례와 관련 ECS 본문을 두 역할에
나누어 직접 읽도록 지정했다. 후속의 원문 읽기를 이전 검토의 근거로 소급하지 않는다.
이 표는 재검토의 입력·적용 범위이며 전체 32개 사례를 모두 시뮬레이션했다는 뜻이 아니다.

| 입력 사례 | 기록된 마찰·판단의 전이 | 연결할 UX·가정 경계 |
|---|---|---|
| [RWS-0006 독립 재현](../references/real-work-scenarios/cases/rws-0006-blind-reproduction-context-isolation.md) | 정답을 제외한 원천 재현, 근거·기간 예외 누락, 결과값과 재현 성공의 구별 | Chat·Memo·읽기·근거·정책 조정. 실제 급여 계산 기능을 요구하는 것이 아니며 Memo/Smart Read UI는 가정 |
| [RWS-0007 실행면 혼선](../references/real-work-scenarios/cases/rws-0007-browser-surface-identity-lease.md)의 SR-01 | 다른 탭에서 작업하면 Agent가 연 드롭다운이 사라진다는 사용자 보고. 역할 검토 A가 지정 원 대화 turn 73–74를 추가 대조 | 조작면 identity·관찰·입력 방식·돌아오기. 합본의 잘못된 profile·stale transport·page/shell 사건을 SR-01 단독 관측으로 옮기지 않으며 focus 원인·해결 성공도 미확정 |
| [RWS-0018 공유본과 시안](../references/real-work-scenarios/cases/rws-0018-shared-ax-dashboard-canonical.md) | 공유본 조기 변경 뒤 복구, 분리한 시안의 시각 검토와 수용된 내용 적용 | 결과·비교·live 재사용·변경 수락. 동시 편집 undo·Board 휴지통의 실제 성공을 뜻하지 않음 |
| [RWS-0010 다중 PC 인계](../references/real-work-scenarios/cases/rws-0010-cross-device-release-handoff.md) | 새 PC의 준비와 release 권한 차이, 오래된 branch와 현재 상태 재확인 | 최초 사용·Board 재개·PC/계정·소유 권한. 실제 Canvas 초대나 live process 이전 사례가 아님 |
| [RWS-0026 지식·역할 권한](../references/real-work-scenarios/cases/rws-0026-taehwa-knowledge-authority-and-acl.md) | 공통·역할 전용·실행 기록 구분, 계정별 read/write와 승격 권한 검사 | 적용 기준·조직 후보·공유 관리. 현재 ACL이나 전체 activation/rollback 동작의 증거로 재사용하지 않음 |
| [RWS-0029 범위 한정 변경·pause](../references/real-work-scenarios/cases/rws-0029-exact-id-bounded-mail-mutation-and-pause.md) | 동일 message ID 범위 확인, 자동화 pause와 데이터 변경 분리 | 정확한 선택 범위·중지·삭제/초기화 확인. formal revert는 실행되지 않았으므로 복구 성공 사례로 쓰지 않음 |

원문 읽기 확인은 파일·SR/claim·관련 흐름의 반환으로 확인한다. PC 양도·통합 초기화·소유권
복구와 30 Board·활동 3개의 혼잡 상황은 이 사례의 실제 사건이 아니라 `HYPOTHETICAL-COVERAGE`다.
사례별 상세 provenance를 제품 매뉴얼 본문에 끼워 넣지 않고, 필요한 사용자 행동·화면으로 전이한다.
후속 역할 A는 RWS-0006·0007·0018 전문과 ECS-02·03·06, 역할 B는 RWS-0010·0026·0029 전문과
ECS-01·04·05·07의 읽기 범위를 반환했다. 두 역할의 8개 finding을 전이·수정하고 수정 범위를
재검토했다. 독립 검토 요청은 Reader의 읽기 책임을 업무 판단으로 바꾸지 않도록 별도 검토 Task로
전개했다. RWS-0007은 합본 사건의 단일 출처 오귀속을 피하도록 SR-01의 사용자 보고로 좁혔다.

| work group / 포함 Q | 당시 확정 근거·준비된 흐름 | 최초 분할한 설계·검사 범위 | 정책에 의존하는 부분 |
|---|---|---|---|
| P1 — `Q-LIFE-01`, `Q-LIFE-02`, `Q-LIFE-03`, `Q-LIFE-05`, `Q-RESTORE-01`, `Q-RESTORE-03`, `Q-RESTORE-06`, `Q-RESTORE-07`, `Q-RESTORE-08` | [실제 Desk와 독립 Board 목록 복원](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-l-02), [첫 사용 흐름](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-first-use) | OS별 실행·종료·shell 실패 진입, 기록 주기·flush·손상 기록에서 마지막 유효 상태 선택. 한 resource 실패가 나머지 Desk를 막지 않는지 확인 | 저장·종료의 미저장 자료 기본 범위만 HUM-AGENDA·EXPORT |
| P2 — `Q-AG-03`, `Q-AG-04`, `Q-AG-05`, `Q-AG-09`, `Q-AG-10`, `Q-AG-13`, `Q-AG-14`, `Q-AG-15`, `Q-AG-17`, `Q-AG-19`, `Q-AG-20` | [Board 저장·닫기](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-agenda) | 목록·이름 변경·저장 진입, 동시 수정·닫기 중 늦은 결과·종료 실패·취소·원 위치 복귀를 구체화하고 검사 | 저장 기본값·공유 instance·예약·삭제/복구만 HUM-AGENDA·SURFACE·ORCH |
| P3 — `Q-VIEW-02`, `Q-VIEW-03`, `Q-VIEW-04`, `Q-VIEW-08`, `Q-VIEW-09`, `Q-VIEW-10`, `Q-VIEW-11`, `Q-VIEW-12`, `Q-VIEW-13`, `Q-DISC-02`, `Q-DISC-03`, `Q-LIB-01` | [조작면 관찰·복귀](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-surface), [입력 비간섭 계약](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-collaboration-computer-use) | 탐색·선택·실제 resize 구분, resource별 native/adapter 입력 경로, 잠든 view 복귀, Library·검색·grouping UI 비교 | 공유 자원의 동일성·저장 범위는 HUM-SURFACE; 단순 레이블·배치는 결정 대기 아님 |
| P4 — `Q-CHAT-02`, `Q-AI-02`, `Q-AI-10`, `Q-AI-11`, `Q-AI-12`, `Q-AI-13`, `Q-MEDIA-02`, `Q-MEDIA-07`, `Q-MEDIA-09`, `Q-MEDIA-11`, `Q-MEDIA-12`, `Q-MEDIA-13` | [담당자 방](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-chat), [Memo](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-memo), [답변·근거](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-answer) | 조합 입력·중복 제출·stale target·전송 실패·늦은 Worker 결과·초안 보존·원 Chat 복귀를 검사 | 공유 대화 관계·기여 공개 깊이·Memo 알림·편집 보존은 HUM-CONV·ANSWER·BRIEF·SNAPSHOT |
| P5 — `Q-ORCH-05`, `Q-ORCH-06`, `Q-ORCH-08` | [기존 위임과 결정 경계](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-policy-options), [의존 작업](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-dependency-orchestration) | 실제 gate에 한 번만 연결되는 요청·취소·만료·재진입, 독립 작업 유지와 부분 결과 보존을 검사 | 새 권한·기간·재위임 정책만 관련 HUM. 일반 분할·검토·복구는 대기 아님 |
| P6 — `Q-AUTH-02`, `Q-AUTH-03`, `Q-AUTH-05`, `Q-AUTH-06`, `Q-AUTH-07`, `Q-AUTH-08`, `Q-BROWSER-01`, `Q-BROWSER-02`, `Q-BROWSER-03` | [identity 분리](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-engine-profile), [첫 연결](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-first-use) | 실제 adapter의 OAuth/popup·다운로드·계정 식별·취소 뒤 callback, 접수 증거·중복 방지 범위를 확인 | 기본 계정 적용·사전 위임·공동 비용은 HUM-ENGINE·COLLAB |
| P7 — `Q-CODE-02`, `Q-CODE-05`, `Q-CODE-06`, `Q-CODE-07`, `Q-CODE-08`, `Q-CODE-09`, `Q-TERM-03`, `Q-TERM-04`, `Q-TERM-05` | [파일 중심 작업](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-reading), [Terminal 동일성](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-terminal-runtime) | 여러 root·PC의 파일 귀속, 명령·revision·검증 결과 연결, 동일 process 재연결·새 실행·snapshot과 닫기/종료를 검사 | 첫 파일 형식·편집 수준의 지원 약속만 HUM-CODE |
| P8 — `Q-ONT-04`, `Q-ONT-05`, `Q-COL-07`, `Q-COL-08`, `Q-COL-09`, `Q-COL-10`, `Q-CU-05`, `Q-CU-06`, `Q-CU-07`, `Q-CU-08` | [기억·규칙](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-knowledge), [다중 PC·협업](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-portable) | 읽기 전용 검사, 초대 전달·참여 확인·권한 회수, stream·입력 소유권, 오프라인·재접속·원격 결과 대조를 mock과 실제 adapter 단계로 나눠 검사 | 조직 규칙 편집·승격, 공유·제어 기본값은 HUM-GOV·COLLAB. 실제 서버·전송은 HUM-REMOTE |
| P9 — `Q-DATA-06`, `Q-DATA-07`, `Q-DATA-08`, `Q-DATA-09`, `Q-UX-02`, `Q-UX-03`, `Q-UX-04` | [반출입](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-portable), [동등 입력 계약](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-accessibility) | 제외 자료·손상 bundle·설정 복구 표시, focus·키보드·모션 감소·비공간·드래그 없는 포인터 경로·IME 검사 | 반출 포함·암호화·import 충돌은 HUM-EXPORT. 접근성 출시 지원 약속만 HUM-A11Y |
| P10 — `Q-AGENT-04`, `Q-AGENT-19`, `Q-AGENT-20` | [실패 경계](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries), [9흐름 기술 연결](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-tech-weave) | capability·availability·permission의 실제 probe, 사건 순서·중복·연결 손실·부분 완료별 인수 증거와 회귀 범위를 구체화. 성능 상한은 실제 환경·측정에 근거 | 기존 동작을 검증하는 방법·반복 조건은 사용자에게 결정받지 않음 |

<!-- QUESTION-ROUTING-REGISTRY:START -->
| question ID | route | decision batch / PM work group | status | legacy-compatible Q anchor |
|---|---|---|---|---|
| `Q-OBJ-01` | `OWNER-PRODUCT` | `D1` | `DECIDED` | `atlas-q-obj-01` |
| `Q-OBJ-02` | `OWNER-PRODUCT` | `D1` | `DECIDED` | `atlas-q-obj-02` |
| `Q-OBJ-03` | `OWNER-PRODUCT` | `D1` | `OPEN` | `atlas-q-obj-03` |
| `Q-OBJ-04` | `OWNER-PRODUCT` | `D1` | `OPEN` | `atlas-q-obj-04` |
| `Q-OBJ-05` | `OWNER-PRODUCT` | `D3` | `OPEN` | `atlas-q-obj-05` |
| `Q-OBJ-06` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-obj-06` |
| `Q-OBJ-07` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-obj-07` |
| `Q-LIFE-01` | `PM-RESEARCH` | `P1-LIFECYCLE-RECOVERY` | `OPEN` | `atlas-q-life-01` |
| `Q-LIFE-02` | `PM-RESEARCH` | `P1-LIFECYCLE-RECOVERY` | `OPEN` | `atlas-q-life-02` |
| `Q-LIFE-03` | `PM-RESEARCH` | `P1-LIFECYCLE-RECOVERY` | `OPEN` | `atlas-q-life-03` |
| `Q-LIFE-04` | `OWNER-PRODUCT` | `D2` | `OPEN` | `atlas-q-life-04` |
| `Q-LIFE-05` | `PM-RESEARCH` | `P1-LIFECYCLE-RECOVERY` | `OPEN` | `atlas-q-life-05` |
| `Q-RESTORE-01` | `PM-RESEARCH` | `P1-LIFECYCLE-RECOVERY` | `OPEN` | `atlas-q-restore-01` |
| `Q-RESTORE-02` | `OWNER-PRODUCT` | `D2` | `OPEN` | `atlas-q-restore-02` |
| `Q-RESTORE-03` | `PM-RESEARCH` | `P1-LIFECYCLE-RECOVERY` | `OPEN` | `atlas-q-restore-03` |
| `Q-RESTORE-04` | `OWNER-PRODUCT` | `D2` | `OPEN` | `atlas-q-restore-04` |
| `Q-RESTORE-05` | `OWNER-PRODUCT` | `D2` | `OPEN` | `atlas-q-restore-05` |
| `Q-RESTORE-06` | `PM-RESEARCH` | `P1-LIFECYCLE-RECOVERY` | `OPEN` | `atlas-q-restore-06` |
| `Q-RESTORE-07` | `PM-RESEARCH` | `P1-LIFECYCLE-RECOVERY` | `OPEN` | `atlas-q-restore-07` |
| `Q-RESTORE-08` | `PM-RESEARCH` | `P1-LIFECYCLE-RECOVERY` | `OPEN` | `atlas-q-restore-08` |
| `Q-AG-01` | `OWNER-PRODUCT` | `D1` | `OPEN` | `atlas-q-ag-01` |
| `Q-AG-02` | `OWNER-PRODUCT` | `D1` | `OPEN` | `atlas-q-ag-02` |
| `Q-AG-03` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-03` |
| `Q-AG-04` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-04` |
| `Q-AG-05` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-05` |
| `Q-AG-06` | `OWNER-PRODUCT` | `D1` | `DECIDED` | `atlas-q-ag-06` |
| `Q-AG-07` | `OWNER-PRODUCT` | `D2` | `OPEN` | `atlas-q-ag-07` |
| `Q-AG-08` | `OWNER-PRODUCT` | `D2` | `OPEN` | `atlas-q-ag-08` |
| `Q-AG-09` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-09` |
| `Q-AG-10` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-10` |
| `Q-AG-11` | `OWNER-PRODUCT` | `D2` | `OPEN` | `atlas-q-ag-11` |
| `Q-AG-12` | `OWNER-PRODUCT` | `D2` | `OPEN` | `atlas-q-ag-12` |
| `Q-AG-13` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-13` |
| `Q-AG-14` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-14` |
| `Q-AG-15` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-15` |
| `Q-AG-16` | `OWNER-PRODUCT` | `D2` | `OPEN` | `atlas-q-ag-16` |
| `Q-AG-17` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-17` |
| `Q-AG-19` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-19` |
| `Q-AG-20` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-20` |
| `Q-VIEW-01` | `OWNER-PRODUCT` | `D3` | `OPEN` | `atlas-q-view-01` |
| `Q-VIEW-02` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-view-02` |
| `Q-VIEW-03` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-view-03` |
| `Q-VIEW-04` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-view-04` |
| `Q-VIEW-05` | `OWNER-PRODUCT` | `D3` | `OPEN` | `atlas-q-view-05` |
| `Q-VIEW-06` | `OWNER-PRODUCT` | `D3` | `OPEN` | `atlas-q-view-06` |
| `Q-VIEW-07` | `OWNER-PRODUCT` | `D3` | `OPEN` | `atlas-q-view-07` |
| `Q-VIEW-08` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-view-08` |
| `Q-VIEW-09` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-view-09` |
| `Q-VIEW-10` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-view-10` |
| `Q-VIEW-11` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-view-11` |
| `Q-VIEW-12` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-view-12` |
| `Q-VIEW-13` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-view-13` |
| `Q-DISC-01` | `OWNER-PRODUCT` | `D3` | `OPEN` | `atlas-q-disc-01` |
| `Q-DISC-02` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-disc-02` |
| `Q-DISC-03` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-disc-03` |
| `Q-LIB-01` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-lib-01` |
| `Q-CHAT-01` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-chat-01` |
| `Q-CHAT-02` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-chat-02` |
| `Q-CHAT-03` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-chat-03` |
| `Q-AI-01` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-ai-01` |
| `Q-AI-02` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-ai-02` |
| `Q-AI-03` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-ai-03` |
| `Q-AI-04` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-ai-04` |
| `Q-AI-05` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-ai-05` |
| `Q-AI-06` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-ai-06` |
| `Q-AI-07` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-ai-07` |
| `Q-AI-08` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-ai-08` |
| `Q-AI-09` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-ai-09` |
| `Q-AI-10` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-ai-10` |
| `Q-AI-11` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-ai-11` |
| `Q-AI-12` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-ai-12` |
| `Q-AI-13` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-ai-13` |
| `Q-MEDIA-01` | `OWNER-PRODUCT` | `D5` | `OPEN` | `atlas-q-media-01` |
| `Q-MEDIA-02` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-media-02` |
| `Q-MEDIA-03` | `OWNER-PRODUCT` | `D5` | `OPEN` | `atlas-q-media-03` |
| `Q-MEDIA-04` | `OWNER-PRODUCT` | `D5` | `OPEN` | `atlas-q-media-04` |
| `Q-MEDIA-05` | `OWNER-PRODUCT` | `D5` | `OPEN` | `atlas-q-media-05` |
| `Q-MEDIA-06` | `OWNER-PRODUCT` | `D5` | `OPEN` | `atlas-q-media-06` |
| `Q-MEDIA-07` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-media-07` |
| `Q-MEDIA-08` | `OWNER-PRODUCT` | `D5` | `OPEN` | `atlas-q-media-08` |
| `Q-MEDIA-09` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-media-09` |
| `Q-MEDIA-10` | `OWNER-PRODUCT` | `D5` | `OPEN` | `atlas-q-media-10` |
| `Q-MEDIA-11` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-media-11` |
| `Q-MEDIA-12` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-media-12` |
| `Q-MEDIA-13` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-media-13` |
| `Q-ORCH-01` | `OWNER-PRODUCT` | `D6` | `OPEN` | `atlas-q-orch-01` |
| `Q-ORCH-02` | `OWNER-PRODUCT` | `D6` | `OPEN` | `atlas-q-orch-02` |
| `Q-ORCH-03` | `OWNER-PRODUCT` | `D6` | `OPEN` | `atlas-q-orch-03` |
| `Q-ORCH-04` | `OWNER-PRODUCT` | `D6` | `OPEN` | `atlas-q-orch-04` |
| `Q-ORCH-05` | `PM-RESEARCH` | `P5-ORCHESTRATION-APPROVAL` | `OPEN` | `atlas-q-orch-05` |
| `Q-ORCH-06` | `PM-RESEARCH` | `P5-ORCHESTRATION-APPROVAL` | `OPEN` | `atlas-q-orch-06` |
| `Q-ORCH-07` | `OWNER-PRODUCT` | `D6` | `OPEN` | `atlas-q-orch-07` |
| `Q-ORCH-08` | `PM-RESEARCH` | `P5-ORCHESTRATION-APPROVAL` | `OPEN` | `atlas-q-orch-08` |
| `Q-AUTH-01` | `OWNER-PRODUCT` | `D3` | `OPEN` | `atlas-q-auth-01` |
| `Q-AUTH-02` | `PM-RESEARCH` | `P6-ACCOUNT-BROWSER-EVIDENCE` | `OPEN` | `atlas-q-auth-02` |
| `Q-AUTH-03` | `PM-RESEARCH` | `P6-ACCOUNT-BROWSER-EVIDENCE` | `OPEN` | `atlas-q-auth-03` |
| `Q-AUTH-04` | `OWNER-PRODUCT` | `D3` | `OPEN` | `atlas-q-auth-04` |
| `Q-AUTH-05` | `PM-RESEARCH` | `P6-ACCOUNT-BROWSER-EVIDENCE` | `OPEN` | `atlas-q-auth-05` |
| `Q-AUTH-06` | `PM-RESEARCH` | `P6-ACCOUNT-BROWSER-EVIDENCE` | `OPEN` | `atlas-q-auth-06` |
| `Q-AUTH-07` | `PM-RESEARCH` | `P6-ACCOUNT-BROWSER-EVIDENCE` | `OPEN` | `atlas-q-auth-07` |
| `Q-AUTH-08` | `PM-RESEARCH` | `P6-ACCOUNT-BROWSER-EVIDENCE` | `OPEN` | `atlas-q-auth-08` |
| `Q-BROWSER-01` | `PM-RESEARCH` | `P6-ACCOUNT-BROWSER-EVIDENCE` | `OPEN` | `atlas-q-browser-01` |
| `Q-BROWSER-02` | `PM-RESEARCH` | `P6-ACCOUNT-BROWSER-EVIDENCE` | `OPEN` | `atlas-q-browser-02` |
| `Q-BROWSER-03` | `PM-RESEARCH` | `P6-ACCOUNT-BROWSER-EVIDENCE` | `OPEN` | `atlas-q-browser-03` |
| `Q-CODE-01` | `OWNER-PRODUCT` | `D7` | `OPEN` | `atlas-q-code-01` |
| `Q-CODE-02` | `PM-RESEARCH` | `P7-CODE-TERMINAL` | `OPEN` | `atlas-q-code-02` |
| `Q-CODE-03` | `OWNER-PRODUCT` | `D7` | `OPEN` | `atlas-q-code-03` |
| `Q-CODE-04` | `OWNER-PRODUCT` | `D7` | `OPEN` | `atlas-q-code-04` |
| `Q-CODE-05` | `PM-RESEARCH` | `P7-CODE-TERMINAL` | `OPEN` | `atlas-q-code-05` |
| `Q-CODE-06` | `PM-RESEARCH` | `P7-CODE-TERMINAL` | `OPEN` | `atlas-q-code-06` |
| `Q-CODE-07` | `PM-RESEARCH` | `P7-CODE-TERMINAL` | `OPEN` | `atlas-q-code-07` |
| `Q-CODE-08` | `PM-RESEARCH` | `P7-CODE-TERMINAL` | `OPEN` | `atlas-q-code-08` |
| `Q-CODE-09` | `PM-RESEARCH` | `P7-CODE-TERMINAL` | `OPEN` | `atlas-q-code-09` |
| `Q-TERM-01` | `OWNER-PRODUCT` | `D3` | `OPEN` | `atlas-q-term-01` |
| `Q-TERM-02` | `OWNER-PRODUCT` | `D3` | `OPEN` | `atlas-q-term-02` |
| `Q-TERM-03` | `PM-RESEARCH` | `P7-CODE-TERMINAL` | `OPEN` | `atlas-q-term-03` |
| `Q-TERM-04` | `PM-RESEARCH` | `P7-CODE-TERMINAL` | `OPEN` | `atlas-q-term-04` |
| `Q-TERM-05` | `PM-RESEARCH` | `P7-CODE-TERMINAL` | `OPEN` | `atlas-q-term-05` |
| `Q-ONT-01` | `OWNER-PRODUCT` | `D6` | `OPEN` | `atlas-q-ont-01` |
| `Q-ONT-02` | `OWNER-PRODUCT` | `D6` | `OPEN` | `atlas-q-ont-02` |
| `Q-ONT-03` | `OWNER-PRODUCT` | `D6` | `OPEN` | `atlas-q-ont-03` |
| `Q-ONT-04` | `PM-RESEARCH` | `P8-ONTOLOGY-COLLAB-CU` | `OPEN` | `atlas-q-ont-04` |
| `Q-ONT-05` | `PM-RESEARCH` | `P8-ONTOLOGY-COLLAB-CU` | `OPEN` | `atlas-q-ont-05` |
| `Q-COL-01` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-col-01` |
| `Q-COL-02` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-col-02` |
| `Q-COL-03` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-col-03` |
| `Q-COL-04` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-col-04` |
| `Q-COL-05` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-col-05` |
| `Q-COL-06` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-col-06` |
| `Q-COL-07` | `PM-RESEARCH` | `P8-ONTOLOGY-COLLAB-CU` | `OPEN` | `atlas-q-col-07` |
| `Q-COL-08` | `PM-RESEARCH` | `P8-ONTOLOGY-COLLAB-CU` | `OPEN` | `atlas-q-col-08` |
| `Q-COL-09` | `PM-RESEARCH` | `P8-ONTOLOGY-COLLAB-CU` | `OPEN` | `atlas-q-col-09` |
| `Q-COL-10` | `PM-RESEARCH` | `P8-ONTOLOGY-COLLAB-CU` | `OPEN` | `atlas-q-col-10` |
| `Q-CU-01` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-cu-01` |
| `Q-CU-02` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-cu-02` |
| `Q-CU-03` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-cu-03` |
| `Q-CU-04` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-cu-04` |
| `Q-CU-05` | `PM-RESEARCH` | `P8-ONTOLOGY-COLLAB-CU` | `OPEN` | `atlas-q-cu-05` |
| `Q-CU-06` | `PM-RESEARCH` | `P8-ONTOLOGY-COLLAB-CU` | `OPEN` | `atlas-q-cu-06` |
| `Q-CU-07` | `PM-RESEARCH` | `P8-ONTOLOGY-COLLAB-CU` | `OPEN` | `atlas-q-cu-07` |
| `Q-CU-08` | `PM-RESEARCH` | `P8-ONTOLOGY-COLLAB-CU` | `OPEN` | `atlas-q-cu-08` |
| `Q-CU-09` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-cu-09` |
| `Q-DATA-01` | `OWNER-PRODUCT` | `D9` | `OPEN` | `atlas-q-data-01` |
| `Q-DATA-02` | `OWNER-PRODUCT` | `D9` | `OPEN` | `atlas-q-data-02` |
| `Q-DATA-03` | `OWNER-PRODUCT` | `D9` | `OPEN` | `atlas-q-data-03` |
| `Q-DATA-04` | `OWNER-PRODUCT` | `D9` | `OPEN` | `atlas-q-data-04` |
| `Q-DATA-05` | `OWNER-PRODUCT` | `D9` | `OPEN` | `atlas-q-data-05` |
| `Q-DATA-06` | `PM-RESEARCH` | `P9-DATA-ACCESSIBILITY` | `OPEN` | `atlas-q-data-06` |
| `Q-DATA-07` | `PM-RESEARCH` | `P9-DATA-ACCESSIBILITY` | `OPEN` | `atlas-q-data-07` |
| `Q-DATA-08` | `PM-RESEARCH` | `P9-DATA-ACCESSIBILITY` | `OPEN` | `atlas-q-data-08` |
| `Q-DATA-09` | `PM-RESEARCH` | `P9-DATA-ACCESSIBILITY` | `OPEN` | `atlas-q-data-09` |
| `Q-UX-01` | `OWNER-PRODUCT` | `D9` | `OPEN` | `atlas-q-ux-01` |
| `Q-UX-02` | `PM-RESEARCH` | `P9-DATA-ACCESSIBILITY` | `OPEN` | `atlas-q-ux-02` |
| `Q-UX-03` | `PM-RESEARCH` | `P9-DATA-ACCESSIBILITY` | `OPEN` | `atlas-q-ux-03` |
| `Q-UX-04` | `PM-RESEARCH` | `P9-DATA-ACCESSIBILITY` | `OPEN` | `atlas-q-ux-04` |
| `Q-AGENT-01` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-01` |
| `Q-AGENT-02` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-02` |
| `Q-AGENT-03` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-03` |
| `Q-AGENT-04` | `PM-RESEARCH` | `P10-AGENT-PROFILE-RUN` | `OPEN` | `atlas-q-agent-04` |
| `Q-AGENT-05` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-05` |
| `Q-AGENT-06` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-06` |
| `Q-AGENT-07` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-07` |
| `Q-AGENT-08` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-08` |
| `Q-AGENT-09` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-09` |
| `Q-AGENT-10` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-10` |
| `Q-AGENT-11` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-11` |
| `Q-AGENT-12` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-12` |
| `Q-AGENT-13` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-13` |
| `Q-AGENT-14` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-14` |
| `Q-AGENT-15` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-15` |
| `Q-AGENT-16` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-16` |
| `Q-AGENT-17` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-17` |
| `Q-AGENT-18` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-18` |
| `Q-AGENT-19` | `PM-RESEARCH` | `P10-AGENT-PROFILE-RUN` | `OPEN` | `atlas-q-agent-19` |
| `Q-AGENT-20` | `PM-RESEARCH` | `P10-AGENT-PROFILE-RUN` | `OPEN` | `atlas-q-agent-20` |
<!-- QUESTION-ROUTING-REGISTRY:END -->

<!-- OWNER-Q-HUM-MAP:START -->

### 8.2 `OWNER-PRODUCT` Q → `HUM` 전수 매핑

아래 표는 기존 90개 owner-routed `Q-*`를 제품 소유자가 읽을 정본 `HUM-*` 질문에
전수 귀속한다. 한 `Q-*`가 둘 이상의 제품 결정 경계를 가로지르면 모든 관련 `HUM-*`를
표시한다. 이 표는 원래의 owner route를 보존하며 현재의 남은 제품 선택을 추가하지 않는다.
`PM-RESEARCH`를 포함한 175개 Q의 위임 설계와 정책 의존성은 §8.3에서 별도로 확인한다.
`HUM-*` 결정이 내려지면 연결된 상세 설계의 해당 조건부 분기를 선택해 반영한다.

| owner-routed Q | canonical HUM decision |
|---|---|
| `Q-OBJ-01` | [HUM-DESK-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-desk-001) |
| `Q-OBJ-02` | [HUM-DESK-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-desk-001) |
| `Q-OBJ-03` | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) |
| `Q-OBJ-04` | [HUM-DESK-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-desk-001), [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) |
| `Q-OBJ-05` | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) |
| `Q-OBJ-06` | [HUM-CONV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-conv-001) |
| `Q-OBJ-07` | [HUM-ANSWER-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-answer-001) |
| `Q-LIFE-04` | [HUM-DESK-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-desk-001) |
| `Q-RESTORE-02` | [HUM-DESK-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-desk-001) |
| `Q-RESTORE-04` | [HUM-DESK-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-desk-001), [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) |
| `Q-RESTORE-05` | [HUM-DESK-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-desk-001) |
| `Q-AG-01` | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) |
| `Q-AG-02` | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) |
| `Q-AG-06` | [HUM-DESK-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-desk-001), [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) |
| `Q-AG-07` | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) |
| `Q-AG-08` | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) |
| `Q-AG-11` | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) |
| `Q-AG-12` | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) |
| `Q-AG-16` | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) |
| `Q-VIEW-01` | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) |
| `Q-VIEW-05` | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) |
| `Q-VIEW-06` | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) |
| `Q-VIEW-07` | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) |
| `Q-DISC-01` | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) |
| `Q-CHAT-01` | [HUM-CONV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-conv-001) |
| `Q-CHAT-03` | [HUM-CONV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-conv-001) |
| `Q-AI-01` | [HUM-READ-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-read-001), [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) |
| `Q-AI-03` | [HUM-READ-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-read-001), [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) |
| `Q-AI-04` | [HUM-READ-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-read-001), [HUM-SNAPSHOT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001), [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) |
| `Q-AI-05` | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) |
| `Q-AI-06` | [HUM-CONV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-conv-001) |
| `Q-AI-07` | [HUM-ENGINE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-engine-001), [HUM-AGENT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agent-001), [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) |
| `Q-AI-08` | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) |
| `Q-AI-09` | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001), [HUM-ORCH-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001) |
| `Q-MEDIA-01` | [HUM-ANSWER-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-answer-001) |
| `Q-MEDIA-03` | [HUM-ANSWER-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-answer-001) |
| `Q-MEDIA-04` | [HUM-BRIEF-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-brief-001) |
| `Q-MEDIA-05` | [HUM-BRIEF-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-brief-001) |
| `Q-MEDIA-06` | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001), [HUM-BRIEF-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-brief-001) |
| `Q-MEDIA-08` | [HUM-BRIEF-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-brief-001) |
| `Q-MEDIA-10` | [HUM-BRIEF-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-brief-001) |
| `Q-ORCH-01` | [HUM-ORCH-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001) |
| `Q-ORCH-02` | [HUM-ORCH-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001) |
| `Q-ORCH-03` | [HUM-ORCH-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001) |
| `Q-ORCH-04` | [HUM-ORCH-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001) |
| `Q-ORCH-07` | [HUM-ORCH-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001) |
| `Q-AUTH-01` | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001), [HUM-ENGINE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-engine-001) |
| `Q-AUTH-04` | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001), [HUM-SNAPSHOT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001) |
| `Q-CODE-01` | [HUM-CODE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-code-001) |
| `Q-CODE-03` | [HUM-CODE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-code-001) |
| `Q-CODE-04` | [HUM-CODE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-code-001) |
| `Q-TERM-01` | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001), [HUM-CODE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-code-001) |
| `Q-TERM-02` | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001), [HUM-CODE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-code-001) |
| `Q-ONT-01` | [HUM-GOV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-gov-001) |
| `Q-ONT-02` | [HUM-GOV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-gov-001) |
| `Q-ONT-03` | [HUM-GOV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-gov-001) |
| `Q-COL-01` | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) |
| `Q-COL-02` | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) |
| `Q-COL-03` | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) |
| `Q-COL-04` | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) |
| `Q-COL-05` | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) |
| `Q-COL-06` | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) |
| `Q-CU-01` | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) |
| `Q-CU-02` | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) |
| `Q-CU-03` | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) |
| `Q-CU-04` | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001), [HUM-REMOTE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-remote-001) |
| `Q-CU-09` | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) |
| `Q-DATA-01` | [HUM-EXPORT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-export-001) |
| `Q-DATA-02` | [HUM-EXPORT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-export-001) |
| `Q-DATA-03` | [HUM-EXPORT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-export-001) |
| `Q-DATA-04` | [HUM-SNAPSHOT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001), [HUM-EXPORT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-export-001) |
| `Q-DATA-05` | [HUM-EXPORT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-export-001), [HUM-REMOTE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-remote-001) |
| `Q-UX-01` | [HUM-A11Y-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-a11y-001) |
| `Q-AGENT-01` | [HUM-AGENT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agent-001), [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) |
| `Q-AGENT-02` | [HUM-AGENT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agent-001) |
| `Q-AGENT-03` | [HUM-ENGINE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-engine-001), [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) |
| `Q-AGENT-05` | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001), [HUM-ORCH-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001) |
| `Q-AGENT-06` | [HUM-READ-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-read-001), [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) |
| `Q-AGENT-07` | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001), [HUM-EXPORT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-export-001) |
| `Q-AGENT-08` | [HUM-ENGINE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-engine-001), [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) |
| `Q-AGENT-09` | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001), [HUM-GOV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-gov-001) |
| `Q-AGENT-10` | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) |
| `Q-AGENT-11` | [HUM-SNAPSHOT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001), [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001), [HUM-EXPORT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-export-001) |
| `Q-AGENT-12` | [HUM-ANSWER-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-answer-001), [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) |
| `Q-AGENT-13` | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) |
| `Q-AGENT-14` | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) |
| `Q-AGENT-15` | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001), [HUM-ORCH-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001) |
| `Q-AGENT-16` | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) |
| `Q-AGENT-17` | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) |
| `Q-AGENT-18` | [HUM-SNAPSHOT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001), [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001), [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) |

<!-- OWNER-Q-HUM-MAP:END -->


Registry 합계는 `175 = OWNER-PRODUCT 90 + PM-RESEARCH 85`다. 모든 행의 초기 상태는 `OPEN`이며, proposal 제출이나 owner 응답이 생기기 전까지 임의로 닫지 않는다. 다만 `OWNER-PRODUCT` 행은 별도 사용자 질문 목록이 아니라 위 전수 매핑을 통해 0절의 `HUM-*` 아래에서만 사용자에게 제시한다.

<a id="design-closure-status"></a>

### 8.3 위임 설계의 완결 상태

2026-09-08 검토에서는 175/175개 Q의 하위 요구에 상세 조작·기술 처리·조건별 인수 절차를 연결하고 `REVIEWED-CLOSED`로 판정했다. 당시 초기 독립 감사 70건과 교차 검토의 추가 배치 충돌 1건을 수정한 뒤 해당 재검토의 잔여 결함을 0건으로 기록했다. 이는 당시 설계에 대한 이력이며 이후 발견한 공백이나 변경된 설계까지 닫힌 것으로 만들지 않는다.

2026-09-10의 Chat/Canvas 입력 결정에 따라 `Q-VIEW-04`·`Q-VIEW-08`의 현행 상태를 `SPECIFIED`로 갱신하고 변경된 부분의 독립 재검토를 남겼다. 나머지 행의 기존 검토 기록은 보존하되, [행동 리허설에서 드러난 다른 공백](../references/design-synthesis/egdesk-user-action-rehearsal-log.md#frictions)을 이 표만으로 해소됐다고 보지 않는다. 새 규칙의 재리허설·Firefox 구현 검증도 미실행이다.

기존 175개 Q와 원래 route는 보존한다. 앞선 registry의 `OPEN/DECIDED`는 초기 결정 이력이며 아래 설계 완결 집계와 다르다. `SPECIFIED`는 상세 본문·조건부 분기·시험 방법을 작성한 상태, `REVIEWED-CLOSED`는 독립 검토에서 그 Q의 세부 질문을 모두 대조한 상태다. 실제 구현 시험은 `PLANNED-NOT-RUN`으로 남긴다. 사용자 선택은 HUM 원장의 OPEN 15개 주제를 따르며 기술·UI 설계 완료로 자동 승인하지 않는다. DESK의 기존 결정과 READ의 설계 해소를 새 승인으로 계산하지 않는다.

<a id="owner-chat-canvas-input-20260910"></a>
**사용자 결정 — 2026-09-10, Chat/Canvas 입력:** 사용자는 Chat을 클릭하면 시각적으로 구별되는 콘텐츠 활성 상태가 되고, 빈 Canvas 클릭으로 그 상태를 해제한 뒤에는 포인터가 Chat 위에 있어도 Canvas pan이 가능해야 한다고 지정했다. 별도 Pan 버튼은 이 기본 두 손가락 흐름의 필수 절차가 아니다. 이 결정은 위치만으로 콘텐츠 입력을 무조건 귀속시키던 조건을 해당 흐름에서 대체한다. 정확한 색·굵기, 모든 renderer의 다른 gesture·modifier, Agent 입력 lease의 전면 변경까지 승인한 것은 아니다.

정본은 [Atlas V-03](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-v-03), [UI의 클릭 활성·해제](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-canvas-input), [기술 입력 경계](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view)에 연결했다. [P0의 당시 행동·응답](../references/design-synthesis/egdesk-user-action-rehearsal-log.md#pilot)은 역사로 유지하며 새 규칙을 통과한 실행으로 소급하지 않는다. 이 변경은 `REV-A` 이후의 재검토 대상이다.

같은 피드백에서 사용자는 Memo의 담당자·수신자 설계 공백을 찾아낸 것을 원하는 시뮬레이션 성과라고 확인했다. 이는 구체 해결안의 승인이 아니다. 두 줄 작성기에 관한 발언은 설명 요청으로 남기며 입력칸 확대 방식이나 전송 키를 변경하는 승인으로 처리하지 않는다.

**2026-09-13 문서 반영 상태**: 첫 사용·기본 Codex·업무 구성·활동 기록의 변경과 직접
연결된 Q-OBJ-01/04/06, Q-LIFE-01/02/04, Q-CHAT-01, Q-AI-04, Q-MEDIA-01,
Q-AGENT-01/02/18을 `SPECIFIED`로 되돌렸다. 기존 REV 기록과 지문은 당시 이력으로 유지한다.
Q-AGENT-02의 기본 사용 부분은 HUM-AGENT-001의 결정으로 대체했지만 소유·공유·편집
수명주기 전체를 승인하거나 검토 완료 처리하지 않았다. 후속 시뮬레이션·전체 독립 검토는 미실행이다.
현재 기본 행동은 L-01의 연결 경로 추가로 162행이다. 기존 검사기의 160행 고정 조건은
이전 기준선이며 이번 문서 전용 작업에서 코드나 검토 지문을 바꿔 통과시키지 않는다.

**2026-09-26 명칭 적용 후 검토 경계**: Board 표기와 화면 라벨 전치는 [§5.9](#doc-board-naming-20260926)의 현재 결정에 따른다. `HUM-AGENDA-001`의 저장·복구 및 연결된 공유·예약 정책은 여전히 `OPEN`이다. 앞선 `REV-*`와 지문은 당시 본문에 대한 증거로 남기고, 이번 문구 변경을 독립 재검토나 구현 시험 완료로 소급하지 않는다.

`OPEN-RESEARCH` 또는 해소되지 않은 조작·프로토콜은 설계 미결이다. 구현 재량으로 두는 방법도 선택 기준·adapter 경계·fallback·관찰할 인수 조건이 있어야 한다. 입력 원문의 존재나 링크 검사만으로 의미 검토를 대체하지 않는다.

[설계 완결 검사](../../scripts/validate-design-closure.mjs)는 175개 Q의 답·검토 범위, 32개 사례 읽기 기록, 작성/검토 역할 분리와 문서 링크를 확인한다. 기본 실행은 미결 설계·미완료 검토가 하나라도 있으면 실패한다. `--allow-incomplete`는 작업 중 구조 검사만 허용하며 완료 판정은 아니다. 이 검사는 기록의 구조를 확인할 뿐 본문의 의미 판단이나 실제 제품 실행을 대신하지 않는다.

<!-- DESIGN-CLOSURE-REGISTRY:START -->
| Q ID | design_status | UX 상세 | 기술 상세 | 정책 연결·독립 승인 아님 | research_status | 구현 검증 | 독립 검토 |
|---|---|---|---|---|---|---|---|
| `Q-OBJ-01` | `SPECIFIED` | [shell](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-shell) | [shell](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | [REV-A](#design-review-a) |
| `Q-OBJ-02` | `REVIEWED-CLOSED` | [shell](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-shell) · [view](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-view) | [shell](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) · [view](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | [REV-A](#design-review-a) |
| `Q-OBJ-03` | `REVIEWED-CLOSED` | [shell](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-shell) | [shell](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | [REV-A](#design-review-a) |
| `Q-OBJ-04` | `SPECIFIED` | [board](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda) | [board](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [REV-A](#design-review-a) |
| `Q-OBJ-05` | `REVIEWED-CLOSED` | [discovery](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-discovery) | [discovery](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-discovery) | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-discovery) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-discovery) | [REV-A](#design-review-a) |
| `Q-OBJ-06` | `SPECIFIED` | [chat-entry](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-entry) · [context-share](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-share) | [context-share](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | [HUM-CONV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-conv-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | [REV-B](#design-review-b) |
| `Q-OBJ-07` | `REVIEWED-CLOSED` | [answer-revisions](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-answer-revisions) | [answer-revisions](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-answer-revisions) | [HUM-ANSWER-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-answer-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-answer-revisions) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-answer-revisions) | [REV-B](#design-review-b) |
| `Q-LIFE-01` | `SPECIFIED` | [shell](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-shell) | [shell](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | [REV-A](#design-review-a) |
| `Q-LIFE-02` | `SPECIFIED` | [shell](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-shell) | [shell](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | [REV-A](#design-review-a) |
| `Q-LIFE-03` | `REVIEWED-CLOSED` | [shell](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-shell) | [shell](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | [REV-A](#design-review-a) |
| `Q-LIFE-04` | `SPECIFIED` | [shell](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-shell) | [shell](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | [REV-A](#design-review-a) |
| `Q-LIFE-05` | `REVIEWED-CLOSED` | [shell](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-shell) · [board-lifecycle](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda-lifecycle) | [shell](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) · [board-lifecycle](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda-lifecycle) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-shell) | [REV-A](#design-review-a) |
| `Q-RESTORE-01` | `REVIEWED-CLOSED` | [restore](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-restore) | [restore](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | [REV-A](#design-review-a) |
| `Q-RESTORE-02` | `REVIEWED-CLOSED` | [restore](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-restore) · [view](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-view) | [restore](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) · [view](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) · [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | [REV-A](#design-review-a) |
| `Q-RESTORE-03` | `REVIEWED-CLOSED` | [restore](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-restore) | [restore](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | [REV-A](#design-review-a) |
| `Q-RESTORE-04` | `REVIEWED-CLOSED` | [restore](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-restore) | [restore](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | [REV-A](#design-review-a) |
| `Q-RESTORE-05` | `REVIEWED-CLOSED` | [restore](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-restore) | [restore](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | [REV-A](#design-review-a) |
| `Q-RESTORE-06` | `REVIEWED-CLOSED` | [restore](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-restore) | [restore](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | [REV-A](#design-review-a) |
| `Q-RESTORE-07` | `REVIEWED-CLOSED` | [restore](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-restore) | [restore](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | [REV-A](#design-review-a) |
| `Q-RESTORE-08` | `REVIEWED-CLOSED` | [restore](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-restore) | [restore](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | [REV-A](#design-review-a) |
| `Q-AG-01` | `REVIEWED-CLOSED` | [board](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda) | [board](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [REV-A](#design-review-a) |
| `Q-AG-02` | `REVIEWED-CLOSED` | [board](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda) | [board](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [REV-A](#design-review-a) |
| `Q-AG-03` | `REVIEWED-CLOSED` | [board](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda) | [board](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [REV-A](#design-review-a) |
| `Q-AG-04` | `REVIEWED-CLOSED` | [board](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda) | [board](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [REV-A](#design-review-a) |
| `Q-AG-05` | `REVIEWED-CLOSED` | [restore](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-restore) · [board](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda) | [restore](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) · [board](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | [REV-A](#design-review-a) |
| `Q-AG-06` | `REVIEWED-CLOSED` | [board](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda) | [board](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [REV-A](#design-review-a) |
| `Q-AG-07` | `REVIEWED-CLOSED` | [board](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda) | [board](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [REV-A](#design-review-a) |
| `Q-AG-08` | `REVIEWED-CLOSED` | [board](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda) | [board](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [REV-A](#design-review-a) |
| `Q-AG-09` | `REVIEWED-CLOSED` | [board](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda) | [board](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [REV-A](#design-review-a) |
| `Q-AG-10` | `REVIEWED-CLOSED` | [board](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda) | [board](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [REV-A](#design-review-a) |
| `Q-AG-11` | `REVIEWED-CLOSED` | [board-lifecycle](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda-lifecycle) | [board-lifecycle](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda-lifecycle) | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) · [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda-lifecycle) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda-lifecycle) | [REV-A](#design-review-a) |
| `Q-AG-12` | `REVIEWED-CLOSED` | [board-lifecycle](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda-lifecycle) | [board-lifecycle](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda-lifecycle) | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda-lifecycle) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda-lifecycle) | [REV-A](#design-review-a) |
| `Q-AG-13` | `REVIEWED-CLOSED` | [board](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda) | [board](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [REV-A](#design-review-a) |
| `Q-AG-14` | `REVIEWED-CLOSED` | [board](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda) | [board](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [REV-A](#design-review-a) |
| `Q-AG-15` | `REVIEWED-CLOSED` | [board](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda) | [board](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [REV-A](#design-review-a) |
| `Q-AG-16` | `REVIEWED-CLOSED` | [board](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda) | [board](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [REV-A](#design-review-a) |
| `Q-AG-17` | `REVIEWED-CLOSED` | [board](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda) | [board](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [REV-A](#design-review-a) |
| `Q-AG-19` | `REVIEWED-CLOSED` | [board-lifecycle](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda-lifecycle) | [board-lifecycle](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda-lifecycle) | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) · [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda-lifecycle) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda-lifecycle) | [REV-A](#design-review-a) |
| `Q-AG-20` | `REVIEWED-CLOSED` | [board-lifecycle](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda-lifecycle) | [board-lifecycle](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda-lifecycle) | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda-lifecycle) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda-lifecycle) | [REV-A](#design-review-a) |
| `Q-VIEW-01` | `REVIEWED-CLOSED` | [discovery](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-discovery) | [discovery](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-discovery) | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-discovery) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-discovery) | [REV-A](#design-review-a) |
| `Q-VIEW-02` | `REVIEWED-CLOSED` | [board](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda) · [view](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-view) | [board](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) · [view](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda) | [REV-A](#design-review-a) |
| `Q-VIEW-03` | `REVIEWED-CLOSED` | [restore](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-restore) · [view](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-view) | [restore](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) · [view](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-restore) | [REV-A](#design-review-a) |
| `Q-VIEW-04` | `SPECIFIED` | [view](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-view) | [view](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | 추가 제품 선택 없음 · [입력 결정](#owner-chat-canvas-input-20260910) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | 변경 전 [REV-A](#design-review-a); [변경 후 재검토 대기](#owner-chat-canvas-input-20260910) |
| `Q-VIEW-05` | `REVIEWED-CLOSED` | [view](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-view) | [view](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | [REV-A](#design-review-a) |
| `Q-VIEW-06` | `REVIEWED-CLOSED` | [view](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-view) | [view](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | [REV-A](#design-review-a) |
| `Q-VIEW-07` | `REVIEWED-CLOSED` | [board-lifecycle](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda-lifecycle) · [view](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-view) | [board-lifecycle](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda-lifecycle) · [view](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda-lifecycle) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda-lifecycle) | [REV-A](#design-review-a) |
| `Q-VIEW-08` | `SPECIFIED` | [view](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-view) · [discovery](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-discovery) | [view](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) · [discovery](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-discovery) | 추가 제품 선택 없음 · [입력 결정](#owner-chat-canvas-input-20260910) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | 변경 전 [REV-A](#design-review-a); [변경 후 재검토 대기](#owner-chat-canvas-input-20260910) |
| `Q-VIEW-09` | `REVIEWED-CLOSED` | [view](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-view) | [view](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | [REV-A](#design-review-a) |
| `Q-VIEW-10` | `REVIEWED-CLOSED` | [view](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-view) | [view](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | [REV-A](#design-review-a) |
| `Q-VIEW-11` | `REVIEWED-CLOSED` | [view](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-view) · [discovery](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-discovery) | [view](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) · [discovery](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-discovery) | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | [REV-A](#design-review-a) |
| `Q-VIEW-12` | `REVIEWED-CLOSED` | [view](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-view) | [view](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view) | [REV-A](#design-review-a) |
| `Q-VIEW-13` | `REVIEWED-CLOSED` | [board-lifecycle](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda-lifecycle) | [board-lifecycle](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda-lifecycle) | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda-lifecycle) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agenda-lifecycle) | [REV-A](#design-review-a) |
| `Q-DISC-01` | `REVIEWED-CLOSED` | [discovery](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-discovery) | [discovery](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-discovery) | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-discovery) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-discovery) | [REV-A](#design-review-a) |
| `Q-DISC-02` | `REVIEWED-CLOSED` | [discovery](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-discovery) | [discovery](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-discovery) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-discovery) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-discovery) | [REV-A](#design-review-a) |
| `Q-DISC-03` | `REVIEWED-CLOSED` | [discovery](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-discovery) | [discovery](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-discovery) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-discovery) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-discovery) | [REV-A](#design-review-a) |
| `Q-LIB-01` | `REVIEWED-CLOSED` | [discovery](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-discovery) | [discovery](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-discovery) | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-discovery) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-discovery) | [REV-A](#design-review-a) |
| `Q-CHAT-01` | `SPECIFIED` | [chat-entry](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-entry) · [context-share](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-share) | [chat-request](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) · [context-share](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | [HUM-CONV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-conv-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | [REV-B](#design-review-b) |
| `Q-CHAT-02` | `REVIEWED-CLOSED` | [chat-entry](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-entry) | [chat-request](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | [REV-B](#design-review-b) |
| `Q-CHAT-03` | `REVIEWED-CLOSED` | [chat-entry](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-entry) | [chat-request](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | [HUM-CONV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-conv-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | [REV-B](#design-review-b) |
| `Q-AI-01` | `REVIEWED-CLOSED` | [chat-entry](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-entry) | [chat-request](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) · [context-share](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | [REV-B](#design-review-b) |
| `Q-AI-02` | `REVIEWED-CLOSED` | [chat-entry](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-entry) | [chat-request](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | [REV-B](#design-review-b) |
| `Q-AI-03` | `REVIEWED-CLOSED` | [context-share](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-share) | [context-share](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | [REV-B](#design-review-b) |
| `Q-AI-04` | `SPECIFIED` | [reader-observation](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-reader-observation) | [chat-request](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) · [reader-observation](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-reader-observation) | [HUM-SNAPSHOT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001) · [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | [REV-B](#design-review-b) |
| `Q-AI-05` | `REVIEWED-CLOSED` | [context-share](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-share) | [chat-request](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) · [context-share](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | [REV-B](#design-review-b) |
| `Q-AI-06` | `REVIEWED-CLOSED` | [context-share](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-share) | [context-share](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | [HUM-CONV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-conv-001) · [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | [REV-B](#design-review-b) |
| `Q-AI-07` | `REVIEWED-CLOSED` | [chat-entry](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-entry) · [context-share](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-share) | [chat-request](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) · [context-share](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | [HUM-ENGINE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-engine-001) · [HUM-AGENT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agent-001) · [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | [REV-B](#design-review-b) |
| `Q-AI-08` | `REVIEWED-CLOSED` | [context-share](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-share) | [chat-request](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) · [context-share](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) · [HUM-ENGINE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-engine-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | [REV-B](#design-review-b) |
| `Q-AI-09` | `REVIEWED-CLOSED` | [context-share](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-share) | [context-share](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) · [HUM-ORCH-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | [REV-B](#design-review-b) |
| `Q-AI-10` | `REVIEWED-CLOSED` | [chat-entry](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-entry) | [chat-request](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | [REV-B](#design-review-b) |
| `Q-AI-11` | `REVIEWED-CLOSED` | [context-share](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-share) | [context-share](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | [REV-B](#design-review-b) |
| `Q-AI-12` | `REVIEWED-CLOSED` | [chat-entry](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-entry) · [context-share](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-share) | [chat-request](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) · [context-share](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | [HUM-CONV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-conv-001) · [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | [REV-B](#design-review-b) |
| `Q-AI-13` | `REVIEWED-CLOSED` | [context-share](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-share) | [context-share](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-share) | [REV-B](#design-review-b) |
| `Q-MEDIA-01` | `SPECIFIED` | [reader-observation](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-reader-observation) · [answer-revisions](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-answer-revisions) | [reader-observation](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-reader-observation) · [answer-revisions](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-answer-revisions) | [HUM-ANSWER-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-answer-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-reader-observation) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-reader-observation) | [REV-B](#design-review-b) |
| `Q-MEDIA-02` | `REVIEWED-CLOSED` | [reader-observation](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-reader-observation) · [answer-revisions](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-answer-revisions) | [chat-request](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) · [answer-revisions](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-answer-revisions) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | [REV-B](#design-review-b) |
| `Q-MEDIA-03` | `REVIEWED-CLOSED` | [answer-revisions](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-answer-revisions) | [answer-revisions](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-answer-revisions) | [HUM-ANSWER-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-answer-001) · [HUM-SNAPSHOT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-answer-revisions) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-answer-revisions) | [REV-B](#design-review-b) |
| `Q-MEDIA-04` | `REVIEWED-CLOSED` | [briefing-comment](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-briefing-comment) | [briefing-comment](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-briefing-comment) | [HUM-BRIEF-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-brief-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-briefing-comment) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-briefing-comment) | [REV-B](#design-review-b) |
| `Q-MEDIA-05` | `REVIEWED-CLOSED` | [briefing-comment](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-briefing-comment) | [briefing-comment](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-briefing-comment) · [canvas-annotation](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-canvas-annotation) | [HUM-BRIEF-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-brief-001) · [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-briefing-comment) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-briefing-comment) | [REV-B](#design-review-b) |
| `Q-MEDIA-06` | `REVIEWED-CLOSED` | [canvas-annotation](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-canvas-annotation) | [canvas-annotation](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-canvas-annotation) | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) · [HUM-BRIEF-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-brief-001) · [HUM-CONV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-conv-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-canvas-annotation) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-canvas-annotation) | [REV-B](#design-review-b) |
| `Q-MEDIA-07` | `REVIEWED-CLOSED` | [briefing-comment](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-briefing-comment) | [chat-request](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) · [briefing-comment](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-briefing-comment) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | [REV-B](#design-review-b) |
| `Q-MEDIA-08` | `REVIEWED-CLOSED` | [chat-entry](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-entry) · [briefing-comment](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-briefing-comment) | [chat-request](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) · [briefing-comment](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-briefing-comment) | [HUM-BRIEF-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-brief-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-chat-request) | [REV-B](#design-review-b) |
| `Q-MEDIA-09` | `REVIEWED-CLOSED` | [briefing-comment](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-briefing-comment) | [briefing-comment](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-briefing-comment) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-briefing-comment) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-briefing-comment) | [REV-B](#design-review-b) |
| `Q-MEDIA-10` | `REVIEWED-CLOSED` | [briefing-comment](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-briefing-comment) | [answer-revisions](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-answer-revisions) · [briefing-comment](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-briefing-comment) | [HUM-BRIEF-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-brief-001) · [HUM-SNAPSHOT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001) · [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-answer-revisions) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-answer-revisions) | [REV-B](#design-review-b) |
| `Q-MEDIA-11` | `REVIEWED-CLOSED` | [briefing-comment](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-briefing-comment) | [briefing-comment](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-briefing-comment) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-briefing-comment) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-briefing-comment) | [REV-B](#design-review-b) |
| `Q-MEDIA-12` | `REVIEWED-CLOSED` | [answer-revisions](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-answer-revisions) | [answer-revisions](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-answer-revisions) | [HUM-ANSWER-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-answer-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-answer-revisions) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-answer-revisions) | [REV-B](#design-review-b) |
| `Q-MEDIA-13` | `REVIEWED-CLOSED` | [canvas-annotation](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-canvas-annotation) | [canvas-annotation](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-canvas-annotation) | [HUM-CONV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-conv-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-canvas-annotation) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-canvas-annotation) | [REV-B](#design-review-b) |
| `Q-AGENT-01` | `SPECIFIED` | [agent-profile](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agent-profile) · [run-control](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control) | [agent-profile](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agent-profile) · [run-orchestration](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | [HUM-AGENT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agent-001) · [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agent-profile) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agent-profile) | [REV-C](#design-review-c) |
| `Q-AGENT-02` | `SPECIFIED` | [agent-profile](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agent-profile) | [agent-profile](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agent-profile) · [account-binding](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | [HUM-AGENT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agent-001) · [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agent-profile) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agent-profile) | [REV-C](#design-review-c) |
| `Q-AGENT-03` | `REVIEWED-CLOSED` | [agent-profile](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agent-profile) · [identity](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-identity) | [agent-profile](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agent-profile) · [run-orchestration](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) · [account-binding](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | [HUM-ENGINE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-engine-001) · [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agent-profile) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agent-profile) | [REV-C](#design-review-c) |
| `Q-AGENT-04` | `REVIEWED-CLOSED` | [agent-profile](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agent-profile) | [agent-profile](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agent-profile) · [run-orchestration](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agent-profile) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agent-profile) | [REV-C](#design-review-c) |
| `Q-AGENT-05` | `REVIEWED-CLOSED` | [approval](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-approval) | [approval-receipts](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) · [context-budget](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) · [HUM-ORCH-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | [REV-C](#design-review-c) |
| `Q-AGENT-06` | `REVIEWED-CLOSED` | [context-policy](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-policy) | [context-budget](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) · [run-orchestration](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) | [REV-C](#design-review-c) |
| `Q-AGENT-07` | `REVIEWED-CLOSED` | [context-policy](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-policy) · [identity](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-identity) | [context-budget](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) · [account-binding](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) · [HUM-EXPORT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-export-001) · [HUM-SNAPSHOT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) | [REV-C](#design-review-c) |
| `Q-AGENT-08` | `REVIEWED-CLOSED` | [identity](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-identity) | [account-binding](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) · [approval-receipts](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | [HUM-ENGINE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-engine-001) · [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | [REV-C](#design-review-c) |
| `Q-AGENT-09` | `REVIEWED-CLOSED` | [context-policy](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-policy) · [agent-profile](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agent-profile) | [context-budget](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) · [agent-profile](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agent-profile) | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) · [HUM-GOV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-gov-001) · [HUM-AGENT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agent-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) | [REV-C](#design-review-c) |
| `Q-AGENT-10` | `REVIEWED-CLOSED` | [agent-profile](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agent-profile) · [run-control](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control) | [context-budget](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) · [run-orchestration](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) · [approval-receipts](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) | [REV-C](#design-review-c) |
| `Q-AGENT-11` | `REVIEWED-CLOSED` | [run-control](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control) · [identity](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-identity) | [context-budget](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) · [run-orchestration](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) · [account-binding](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | [HUM-SNAPSHOT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001) · [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) · [HUM-EXPORT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-export-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) | [REV-C](#design-review-c) |
| `Q-AGENT-12` | `REVIEWED-CLOSED` | [agent-profile](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agent-profile) · [run-control](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control) | [agent-profile](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agent-profile) · [run-orchestration](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | [HUM-ANSWER-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-answer-001) · [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agent-profile) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agent-profile) | [REV-C](#design-review-c) |
| `Q-AGENT-13` | `REVIEWED-CLOSED` | [context-policy](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-policy) | [context-budget](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) · [approval-receipts](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) | [REV-C](#design-review-c) |
| `Q-AGENT-14` | `REVIEWED-CLOSED` | [run-control](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control) | [run-orchestration](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) · [approval-receipts](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | [REV-C](#design-review-c) |
| `Q-AGENT-15` | `REVIEWED-CLOSED` | [run-control](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control) | [run-orchestration](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) · [context-budget](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) · [approval-receipts](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) · [HUM-ORCH-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | [REV-C](#design-review-c) |
| `Q-AGENT-16` | `REVIEWED-CLOSED` | [agent-profile](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agent-profile) · [run-control](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control) | [run-orchestration](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) · [context-budget](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) · [approval-receipts](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | [REV-C](#design-review-c) |
| `Q-AGENT-17` | `REVIEWED-CLOSED` | [context-policy](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-policy) | [context-budget](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) | [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) · [HUM-GOV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-gov-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) | [REV-C](#design-review-c) |
| `Q-AGENT-18` | `SPECIFIED` | [run-control](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control) | [run-orchestration](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) · [context-budget](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) | [HUM-SNAPSHOT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001) · [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) · [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) · [HUM-CONV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-conv-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | [REV-C](#design-review-c) |
| `Q-AGENT-19` | `REVIEWED-CLOSED` | [agent-profile](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agent-profile) · [context-policy](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-context-policy) · [run-control](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control) · [approval](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-approval) · [identity](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-identity) · [browser](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-browser) | [agent-profile](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agent-profile) · [context-budget](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-context-budget) · [run-orchestration](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) · [approval-receipts](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) · [account-binding](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) · [browser-operations](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-browser-operations) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agent-profile) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-agent-profile) | [REV-C](#design-review-c) |
| `Q-AGENT-20` | `REVIEWED-CLOSED` | [run-control](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control) | [run-orchestration](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) · [browser-operations](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-browser-operations) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | [REV-C](#design-review-c) |
| `Q-ORCH-01` | `REVIEWED-CLOSED` | [run-control](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control) | [run-orchestration](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | [HUM-ORCH-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | [REV-C](#design-review-c) |
| `Q-ORCH-02` | `REVIEWED-CLOSED` | [run-control](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control) | [run-orchestration](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | [HUM-ORCH-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | [REV-C](#design-review-c) |
| `Q-ORCH-03` | `REVIEWED-CLOSED` | [approval](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-approval) | [approval-receipts](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) · [run-orchestration](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | [HUM-ORCH-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | [REV-C](#design-review-c) |
| `Q-ORCH-04` | `REVIEWED-CLOSED` | [run-control](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control) | [run-orchestration](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) · [approval-receipts](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | [HUM-ORCH-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | [REV-C](#design-review-c) |
| `Q-ORCH-05` | `REVIEWED-CLOSED` | [approval](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-approval) | [approval-receipts](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) · [account-binding](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | [REV-C](#design-review-c) |
| `Q-ORCH-06` | `REVIEWED-CLOSED` | [approval](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-approval) · [browser](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-browser) | [approval-receipts](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) · [browser-operations](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-browser-operations) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | [REV-C](#design-review-c) |
| `Q-ORCH-07` | `REVIEWED-CLOSED` | [approval](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-approval) · [identity](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-identity) | [approval-receipts](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) · [account-binding](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | [HUM-ORCH-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001) · [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001) · [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | [REV-C](#design-review-c) |
| `Q-ORCH-08` | `REVIEWED-CLOSED` | [run-control](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control) · [browser](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-browser) | [run-orchestration](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) · [browser-operations](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-browser-operations) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-run-orchestration) | [REV-C](#design-review-c) |
| `Q-AUTH-01` | `REVIEWED-CLOSED` | [identity](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-identity) | [account-binding](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) · [browser-operations](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-browser-operations) | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) · [HUM-ENGINE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-engine-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | [REV-C](#design-review-c) |
| `Q-AUTH-02` | `REVIEWED-CLOSED` | [identity](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-identity) | [account-binding](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | [REV-C](#design-review-c) |
| `Q-AUTH-03` | `REVIEWED-CLOSED` | [identity](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-identity) | [account-binding](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) · [approval-receipts](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | [REV-C](#design-review-c) |
| `Q-AUTH-04` | `REVIEWED-CLOSED` | [identity](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-identity) | [account-binding](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) · [HUM-SNAPSHOT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | [REV-C](#design-review-c) |
| `Q-AUTH-05` | `REVIEWED-CLOSED` | [browser](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-browser) | [browser-operations](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-browser-operations) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-browser-operations) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-browser-operations) | [REV-C](#design-review-c) |
| `Q-AUTH-06` | `REVIEWED-CLOSED` | [approval](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-approval) | [approval-receipts](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) · [browser-operations](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-browser-operations) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | [REV-C](#design-review-c) |
| `Q-AUTH-07` | `REVIEWED-CLOSED` | [identity](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-identity) · [browser](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-browser) | [account-binding](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) · [browser-operations](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-browser-operations) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | [REV-C](#design-review-c) |
| `Q-AUTH-08` | `REVIEWED-CLOSED` | [identity](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-identity) | [account-binding](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) · [browser-operations](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-browser-operations) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | [REV-C](#design-review-c) |
| `Q-BROWSER-01` | `REVIEWED-CLOSED` | [browser](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-browser) | [browser-operations](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-browser-operations) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-browser-operations) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-browser-operations) | [REV-C](#design-review-c) |
| `Q-BROWSER-02` | `REVIEWED-CLOSED` | [browser](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-browser) | [browser-operations](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-browser-operations) · [account-binding](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-account-binding) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-browser-operations) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-browser-operations) | [REV-C](#design-review-c) |
| `Q-BROWSER-03` | `REVIEWED-CLOSED` | [approval](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-approval) · [browser](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-browser) | [approval-receipts](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) · [browser-operations](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-browser-operations) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-approval-receipts) | [REV-C](#design-review-c) |
| `Q-CODE-01` | `REVIEWED-CLOSED` | [files](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-files) | [files](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-files) | [HUM-CODE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-code-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-files) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-files) | [REV-D](#design-review-d) |
| `Q-CODE-02` | `REVIEWED-CLOSED` | [files](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-files) · [input](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-input) | [files](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-files) · [input](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-files) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-files) | [REV-D](#design-review-d) |
| `Q-CODE-03` | `REVIEWED-CLOSED` | [changes](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-changes) | [changes](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-changes) | [HUM-CODE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-code-001) · [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-changes) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-changes) | [REV-D](#design-review-d) |
| `Q-CODE-04` | `REVIEWED-CLOSED` | [changes](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-changes) | [changes](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-changes) | [HUM-CODE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-code-001) · [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-changes) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-changes) | [REV-D](#design-review-d) |
| `Q-CODE-05` | `REVIEWED-CLOSED` | [files](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-files) · [input](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-input) | [files](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-files) · [input](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-files) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-files) | [REV-D](#design-review-d) |
| `Q-CODE-06` | `REVIEWED-CLOSED` | [files](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-files) · [input](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-input) | [files](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-files) · [input](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-files) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-files) | [REV-D](#design-review-d) |
| `Q-CODE-07` | `REVIEWED-CLOSED` | [files](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-files) · [input](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-input) | [files](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-files) · [input](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-files) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-files) | [REV-D](#design-review-d) |
| `Q-CODE-08` | `REVIEWED-CLOSED` | [changes](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-changes) | [changes](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-changes) | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-changes) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-changes) | [REV-D](#design-review-d) |
| `Q-CODE-09` | `REVIEWED-CLOSED` | [changes](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-changes) | [changes](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-changes) | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-changes) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-changes) | [REV-D](#design-review-d) |
| `Q-TERM-01` | `REVIEWED-CLOSED` | [terminal](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-terminal) | [terminal](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-terminal) · [input](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) · [HUM-CODE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-code-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-terminal) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-terminal) | [REV-D](#design-review-d) |
| `Q-TERM-02` | `REVIEWED-CLOSED` | [terminal](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-terminal) | [terminal](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-terminal) | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) · [HUM-CODE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-code-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-terminal) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-terminal) | [REV-D](#design-review-d) |
| `Q-TERM-03` | `REVIEWED-CLOSED` | [terminal](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-terminal) | [terminal](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-terminal) · [input](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-terminal) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-terminal) | [REV-D](#design-review-d) |
| `Q-TERM-04` | `REVIEWED-CLOSED` | [terminal](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-terminal) | [terminal](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-terminal) · [input](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-terminal) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-terminal) | [REV-D](#design-review-d) |
| `Q-TERM-05` | `REVIEWED-CLOSED` | [terminal](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-terminal) | [terminal](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-terminal) · [input](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-terminal) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-terminal) | [REV-D](#design-review-d) |
| `Q-ONT-01` | `REVIEWED-CLOSED` | [e24-ontology-inspect](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-ontology-inspect) | [e24-ontology-resolution](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-ontology-resolution) | [HUM-GOV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-gov-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-ontology-resolution) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-ontology-resolution) | [REV-E](#design-review-e) |
| `Q-ONT-02` | `REVIEWED-CLOSED` | [e24-ontology-inspect](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-ontology-inspect) | [e24-ontology-resolution](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-ontology-resolution) | [HUM-GOV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-gov-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-ontology-resolution) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-ontology-resolution) | [REV-E](#design-review-e) |
| `Q-ONT-03` | `REVIEWED-CLOSED` | [e24-ontology-governance](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-ontology-governance) | [e24-ontology-resolution](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-ontology-resolution) | [HUM-GOV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-gov-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-ontology-resolution) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-ontology-resolution) | [REV-E](#design-review-e) |
| `Q-ONT-04` | `REVIEWED-CLOSED` | [e24-ontology-inspect](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-ontology-inspect) | [e24-ontology-resolution](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-ontology-resolution) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-ontology-resolution) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-ontology-resolution) | [REV-E](#design-review-e) |
| `Q-ONT-05` | `REVIEWED-CLOSED` | [e24-ontology-governance](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-ontology-governance) | [e24-ontology-resolution](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-ontology-resolution) | [HUM-GOV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-gov-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-ontology-resolution) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-ontology-resolution) | [REV-E](#design-review-e) |
| `Q-COL-01` | `REVIEWED-CLOSED` | [e24-collaboration-invite](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-collaboration-invite) | [e24-collaboration-authority](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) · [e24-remote-transport](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-remote-transport) | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | [REV-E](#design-review-e) |
| `Q-COL-02` | `REVIEWED-CLOSED` | [e24-collaboration-invite](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-collaboration-invite) | [e24-collaboration-authority](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) · [e24-remote-transport](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-remote-transport) | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | [REV-E](#design-review-e) |
| `Q-COL-03` | `REVIEWED-CLOSED` | [e24-collaboration-manage](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-collaboration-manage) · [e24-computer-use-observe](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-computer-use-observe) | [e24-collaboration-authority](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) · [e24-remote-transport](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-remote-transport) | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | [REV-E](#design-review-e) |
| `Q-COL-04` | `REVIEWED-CLOSED` | [e24-collaboration-invite](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-collaboration-invite) · [e24-collaboration-manage](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-collaboration-manage) | [e24-collaboration-authority](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | [REV-E](#design-review-e) |
| `Q-COL-05` | `REVIEWED-CLOSED` | [e24-collaboration-manage](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-collaboration-manage) | [e24-collaboration-authority](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | [REV-E](#design-review-e) |
| `Q-COL-06` | `REVIEWED-CLOSED` | [e24-collaboration-manage](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-collaboration-manage) | [e24-collaboration-authority](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | [REV-E](#design-review-e) |
| `Q-COL-07` | `REVIEWED-CLOSED` | [e24-collaboration-invite](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-collaboration-invite) | [e24-collaboration-authority](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) · [e24-remote-transport](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-remote-transport) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | [REV-E](#design-review-e) |
| `Q-COL-08` | `REVIEWED-CLOSED` | [e24-collaboration-invite](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-collaboration-invite) | [e24-collaboration-authority](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) · [e24-remote-transport](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-remote-transport) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | [REV-E](#design-review-e) |
| `Q-COL-09` | `REVIEWED-CLOSED` | [e24-collaboration-manage](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-collaboration-manage) | [e24-collaboration-authority](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) · [e24-remote-transport](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-remote-transport) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | [REV-E](#design-review-e) |
| `Q-COL-10` | `REVIEWED-CLOSED` | [e24-collaboration-manage](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-collaboration-manage) | [e24-collaboration-authority](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | [REV-E](#design-review-e) |
| `Q-CU-01` | `REVIEWED-CLOSED` | [e24-computer-use-control](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-computer-use-control) | [e24-computer-use](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-computer-use) | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-computer-use) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-computer-use) | [REV-E](#design-review-e) |
| `Q-CU-02` | `REVIEWED-CLOSED` | [e24-computer-use-control](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-computer-use-control) | [e24-collaboration-authority](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) · [e24-computer-use](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-computer-use) | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-collaboration-authority) | [REV-E](#design-review-e) |
| `Q-CU-03` | `REVIEWED-CLOSED` | [e24-computer-use-control](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-computer-use-control) | [e24-remote-transport](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-remote-transport) · [e24-computer-use](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-computer-use) | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-remote-transport) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-remote-transport) | [REV-E](#design-review-e) |
| `Q-CU-04` | `REVIEWED-CLOSED` | [e24-computer-use-observe](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-computer-use-observe) | [e24-remote-transport](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-remote-transport) · [e24-computer-use](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-computer-use) | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) · [HUM-REMOTE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-remote-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-remote-transport) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-remote-transport) | [REV-E](#design-review-e) |
| `Q-CU-05` | `REVIEWED-CLOSED` | [e24-computer-use-control](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-computer-use-control) | [e24-computer-use](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-computer-use) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-computer-use) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-computer-use) | [REV-E](#design-review-e) |
| `Q-CU-06` | `REVIEWED-CLOSED` | [e24-computer-use-control](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-computer-use-control) | [e24-remote-transport](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-remote-transport) · [e24-computer-use](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-computer-use) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-remote-transport) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-remote-transport) | [REV-E](#design-review-e) |
| `Q-CU-07` | `REVIEWED-CLOSED` | [e24-computer-use-observe](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-computer-use-observe) | [e24-remote-transport](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-remote-transport) · [e24-computer-use](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-computer-use) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-remote-transport) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-remote-transport) | [REV-E](#design-review-e) |
| `Q-CU-08` | `REVIEWED-CLOSED` | [e24-computer-use-observe](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-computer-use-observe) | [e24-computer-use](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-computer-use) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-computer-use) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-computer-use) | [REV-E](#design-review-e) |
| `Q-CU-09` | `REVIEWED-CLOSED` | [e24-computer-use-control](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-computer-use-control) · [e24-computer-use-observe](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-computer-use-observe) | [e24-computer-use](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-computer-use) | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-computer-use) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-computer-use) | [REV-E](#design-review-e) |
| `Q-DATA-01` | `REVIEWED-CLOSED` | [reset](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-reset) | [storage](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-storage) | [HUM-EXPORT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-export-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-storage) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-storage) | [REV-D](#design-review-d) |
| `Q-DATA-02` | `REVIEWED-CLOSED` | [portable](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-portable) | [storage](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-storage) · [portable](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-portable) | [HUM-EXPORT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-export-001) · [HUM-SNAPSHOT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-storage) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-storage) | [REV-D](#design-review-d) |
| `Q-DATA-03` | `REVIEWED-CLOSED` | [portable](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-portable) | [portable](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-portable) | [HUM-EXPORT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-export-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-portable) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-portable) | [REV-D](#design-review-d) |
| `Q-DATA-04` | `REVIEWED-CLOSED` | [reset](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-reset) | [storage](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-storage) | [HUM-SNAPSHOT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001) · [HUM-EXPORT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-export-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-storage) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-storage) | [REV-D](#design-review-d) |
| `Q-DATA-05` | `REVIEWED-CLOSED` | [portable](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-portable) | [portable](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-portable) | [HUM-EXPORT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-export-001) · [HUM-REMOTE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-remote-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-portable) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-portable) | [REV-D](#design-review-d) |
| `Q-DATA-06` | `REVIEWED-CLOSED` | [reset](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-reset) · [input](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-input) | [storage](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-storage) · [input](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-storage) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-storage) | [REV-D](#design-review-d) |
| `Q-DATA-07` | `REVIEWED-CLOSED` | [portable](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-portable) | [portable](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-portable) · [input](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-portable) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-portable) | [REV-D](#design-review-d) |
| `Q-DATA-08` | `REVIEWED-CLOSED` | [portable](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-portable) | [portable](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-portable) · [input](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-portable) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-portable) | [REV-D](#design-review-d) |
| `Q-DATA-09` | `REVIEWED-CLOSED` | [portable](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-portable) | [portable](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-portable) · [input](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-portable) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-portable) | [REV-D](#design-review-d) |
| `Q-UX-01` | `REVIEWED-CLOSED` | [input](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-input) | [input](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | [HUM-A11Y-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-a11y-001) | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | [REV-D](#design-review-d) |
| `Q-UX-02` | `REVIEWED-CLOSED` | [input](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-input) | [input](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | [REV-D](#design-review-d) |
| `Q-UX-03` | `REVIEWED-CLOSED` | [input](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-input) | [input](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | [REV-D](#design-review-d) |
| `Q-UX-04` | `REVIEWED-CLOSED` | [input](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-input) | [input](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | 추가 제품 선택 없음 | `SUFFICIENT-FOR-DESIGN` [근거·방법](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | `PLANNED-NOT-RUN` [인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input) | [REV-D](#design-review-d) |
<!-- DESIGN-CLOSURE-REGISTRY:END -->

<a id="design-source-reads"></a>

**실제 사례 읽기:** 아래는 설계자가 각 사례 전문의 SourceRef·실제 업무·실패/교정·증거 경계·열린 질문을 읽고 반환한 범위다. 현재 실제 업무나 제품 구현을 재검증한 뜻이 아니다. 보조 재사용은 중복 집계하지 않는다.

<!-- DESIGN-SOURCE-READS:START -->
| 사례 | 원문 | 읽기 상태 | 읽은 역할·구간 | 전이·한계 |
|---|---|---|---|---|
| `RWS-0001` | [RWS-0001](../references/real-work-scenarios/cases/rws-0001-git-checkpoint-push-evidence.md#rws-0001) | `READ-EVIDENCE` | 설계 D · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0002` | [RWS-0002](../references/real-work-scenarios/cases/rws-0002-worktree-integration-ownership.md#rws-0002) | `READ-EVIDENCE` | 설계 C · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0003` | [RWS-0003](../references/real-work-scenarios/cases/rws-0003-bounded-map-reduce-semantic-audit.md#rws-0003) | `READ-EVIDENCE` | 설계 B · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0004` | [RWS-0004](../references/real-work-scenarios/cases/rws-0004-consensus-illusion-clean-room-escape.md#rws-0004) | `READ-EVIDENCE` | 설계 B · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0005` | [RWS-0005](../references/real-work-scenarios/cases/rws-0005-external-portal-state-machine.md#rws-0005) | `READ-EVIDENCE` | 설계 C · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0006` | [RWS-0006](../references/real-work-scenarios/cases/rws-0006-blind-reproduction-context-isolation.md#rws-0006) | `READ-EVIDENCE` | 설계 B · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0007` | [RWS-0007](../references/real-work-scenarios/cases/rws-0007-browser-surface-identity-lease.md#rws-0007) | `READ-EVIDENCE` | 설계 A · 전문과 관련 ECS | SR-01은 사용자 dropdown 보고; 합본의 다른 사고 전체를 귀속하지 않음 |
| `RWS-0008` | [RWS-0008](../references/real-work-scenarios/cases/rws-0008-cross-layer-environment-recovery.md#rws-0008) | `READ-EVIDENCE` | 설계 A · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0009` | [RWS-0009](../references/real-work-scenarios/cases/rws-0009-read-only-scope-lock.md#rws-0009) | `READ-EVIDENCE` | 설계 C · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0010` | [RWS-0010](../references/real-work-scenarios/cases/rws-0010-cross-device-release-handoff.md#rws-0010) | `READ-EVIDENCE` | 설계 A · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0011` | [RWS-0011](../references/real-work-scenarios/cases/rws-0011-codex-project-pm-profile-activation.md#rws-0011) | `READ-EVIDENCE` | 설계 C · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0012` | [RWS-0012](../references/real-work-scenarios/cases/rws-0012-product-document-receiving-situation-weave.md#rws-0012) | `READ-EVIDENCE` | 설계 B · 전문과 관련 ECS | 화자·결정 출처의 경계로 사용; 별도 새 제품 기능을 만들지 않음 |
| `RWS-0013` | [RWS-0013](../references/real-work-scenarios/cases/rws-0013-owner-decision-to-canonical.md#rws-0013) | `READ-EVIDENCE` | 설계 B · 전문과 관련 ECS | 화자·결정 출처의 경계로 사용; 별도 새 제품 기능을 만들지 않음 |
| `RWS-0014` | [RWS-0014](../references/real-work-scenarios/cases/rws-0014-recurring-support-monitor-recovery.md#rws-0014) | `READ-EVIDENCE` | 설계 A · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0015` | [RWS-0015](../references/real-work-scenarios/cases/rws-0015-uncertain-eligibility-evidence-application.md#rws-0015) | `READ-EVIDENCE` | 설계 C · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0016` | [RWS-0016](../references/real-work-scenarios/cases/rws-0016-employee-separation-control-ledger.md#rws-0016) | `READ-EVIDENCE` | 설계 C · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0017` | [RWS-0017](../references/real-work-scenarios/cases/rws-0017-finance-source-ledger-reconciliation.md#rws-0017) | `READ-EVIDENCE` | 설계 D · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0018` | [RWS-0018](../references/real-work-scenarios/cases/rws-0018-shared-ax-dashboard-canonical.md#rws-0018) | `READ-EVIDENCE` | 설계 D · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0019` | [RWS-0019](../references/real-work-scenarios/cases/rws-0019-canonical-workbook-minimal-repair.md#rws-0019) | `READ-EVIDENCE` | 설계 D · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0020` | [RWS-0020](../references/real-work-scenarios/cases/rws-0020-vat-reconciliation-state-mismatch.md#rws-0020) | `READ-EVIDENCE` | 설계 C · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0021` | [RWS-0021](../references/real-work-scenarios/cases/rws-0021-benefit-audit-to-calendar.md#rws-0021) | `READ-EVIDENCE` | 설계 A · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0022` | [RWS-0022](../references/real-work-scenarios/cases/rws-0022-executive-deck-render-review-loop.md#rws-0022) | `READ-EVIDENCE` | 설계 B · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0023` | [RWS-0023](../references/real-work-scenarios/cases/rws-0023-main-domain-hosting-dns-ssl-cutover.md#rws-0023) | `READ-EVIDENCE` | 설계 A · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0024` | [RWS-0024](../references/real-work-scenarios/cases/rws-0024-measurement-confidence-correction-and-resend.md#rws-0024) | `READ-EVIDENCE` | 설계 B · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0025` | [RWS-0025](../references/real-work-scenarios/cases/rws-0025-rd-evidence-bounded-consultation-request.md#rws-0025) | `READ-EVIDENCE` | 설계 C · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0026` | [RWS-0026](../references/real-work-scenarios/cases/rws-0026-taehwa-knowledge-authority-and-acl.md#rws-0026) | `READ-EVIDENCE` | 설계 E · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0027` | [RWS-0027](../references/real-work-scenarios/cases/rws-0027-taehwa-ontology-semantic-migration-audit.md#rws-0027) | `READ-EVIDENCE` | 설계 E · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0028` | [RWS-0028](../references/real-work-scenarios/cases/rws-0028-grammar-on-document-authority-reset.md#rws-0028) | `READ-EVIDENCE` | 설계 E · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0029` | [RWS-0029](../references/real-work-scenarios/cases/rws-0029-exact-id-bounded-mail-mutation-and-pause.md#rws-0029) | `READ-EVIDENCE` | 설계 D · 전문과 관련 ECS | formal revert 미실행; pause·데이터 변경·복구 성공 구별 |
| `RWS-0030` | [RWS-0030](../references/real-work-scenarios/cases/rws-0030-business-scenario-lab.md#rws-0030) | `READ-EVIDENCE` | 설계 C · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0031` | [RWS-0031](../references/real-work-scenarios/cases/rws-0031-erp-manual-live-ab-evaluation.md#rws-0031) | `READ-EVIDENCE` | 설계 E · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
| `RWS-0032` | [RWS-0032](../references/real-work-scenarios/cases/rws-0032-platform-pipeline-repository-boundary-migration.md#rws-0032) | `READ-EVIDENCE` | 설계 D · 전문과 관련 ECS | 사례의 권한·대상·기록·완료 경계를 해당 설계에 전이; 원문·목표 시나리오·현재 상태를 구별 |
<!-- DESIGN-SOURCE-READS:END -->

<a id="design-review-a"></a>
<a id="design-review-b"></a>
<a id="design-review-c"></a>
<a id="design-review-d"></a>
<a id="design-review-e"></a>

<!-- DESIGN-REVIEWS:START -->
| 검토 ID | 상태 | 작성 역할 | 독립 검토 역할 | 질문·읽기 범위 | 발견·처리 |
|---|---|---|---|---|---|
| `REV-A` | `PASS` | `01a07f82-5f97-7443-bb28-9cd61ea0f824` · `01a08093-5c40-7b92-8099-c53915f0825b` | `01a08098-f24d-72c3-a552-680883cef639` | `Q-OBJ-01`, `Q-OBJ-02`, `Q-OBJ-03`, `Q-OBJ-04`, `Q-OBJ-05`, `Q-LIFE-01`, `Q-LIFE-02`, `Q-LIFE-03`, `Q-LIFE-04`, `Q-LIFE-05`, `Q-RESTORE-01`, `Q-RESTORE-02`, `Q-RESTORE-03`, `Q-RESTORE-04`, `Q-RESTORE-05`, `Q-RESTORE-06`, `Q-RESTORE-07`, `Q-RESTORE-08`, `Q-AG-01`, `Q-AG-02`, `Q-AG-03`, `Q-AG-04`, `Q-AG-05`, `Q-AG-06`, `Q-AG-07`, `Q-AG-08`, `Q-AG-09`, `Q-AG-10`, `Q-AG-11`, `Q-AG-12`, `Q-AG-13`, `Q-AG-14`, `Q-AG-15`, `Q-AG-16`, `Q-AG-17`, `Q-AG-19`, `Q-AG-20`, `Q-VIEW-01`, `Q-VIEW-02`, `Q-VIEW-03`, `Q-VIEW-04`, `Q-VIEW-05`, `Q-VIEW-06`, `Q-VIEW-07`, `Q-VIEW-08`, `Q-VIEW-09`, `Q-VIEW-10`, `Q-VIEW-11`, `Q-VIEW-12`, `Q-VIEW-13`, `Q-DISC-01`, `Q-DISC-02`, `Q-DISC-03`, `Q-LIB-01` | 초기 16건 수정 및 잔여 경로 재검토; 제공된 Q의 하위 항목 전수 대조 PASS·잔여 0. Main 통합, 실제 구현 미실행 |
| `REV-B` | `PASS` | `01a07f82-601e-7eb0-bad9-c0e3a450348a` · `01a08093-5cbf-7661-b500-d4ef941ef6b8` | `01a08098-f1c2-7440-82f8-c7dc608bf2d0` | `Q-OBJ-06`, `Q-OBJ-07`, `Q-CHAT-01`, `Q-CHAT-02`, `Q-CHAT-03`, `Q-AI-01`, `Q-AI-02`, `Q-AI-03`, `Q-AI-04`, `Q-AI-05`, `Q-AI-06`, `Q-AI-07`, `Q-AI-08`, `Q-AI-09`, `Q-AI-10`, `Q-AI-11`, `Q-AI-12`, `Q-AI-13`, `Q-MEDIA-01`, `Q-MEDIA-02`, `Q-MEDIA-03`, `Q-MEDIA-04`, `Q-MEDIA-05`, `Q-MEDIA-06`, `Q-MEDIA-07`, `Q-MEDIA-08`, `Q-MEDIA-09`, `Q-MEDIA-10`, `Q-MEDIA-11`, `Q-MEDIA-12`, `Q-MEDIA-13` | 초기 15건 수정 및 잔여 경로 재검토; 제공된 Q의 하위 항목 전수 대조 PASS·잔여 0. Main 통합, 실제 구현 미실행 |
| `REV-C` | `PASS` | `01a07f82-608d-7a43-bd82-285df7611894` | `01a08093-5d28-7792-ab7d-0baeb690b283` | `Q-AGENT-01`, `Q-AGENT-02`, `Q-AGENT-03`, `Q-AGENT-04`, `Q-AGENT-05`, `Q-AGENT-06`, `Q-AGENT-07`, `Q-AGENT-08`, `Q-AGENT-09`, `Q-AGENT-10`, `Q-AGENT-11`, `Q-AGENT-12`, `Q-AGENT-13`, `Q-AGENT-14`, `Q-AGENT-15`, `Q-AGENT-16`, `Q-AGENT-17`, `Q-AGENT-18`, `Q-AGENT-19`, `Q-AGENT-20`, `Q-ORCH-01`, `Q-ORCH-02`, `Q-ORCH-03`, `Q-ORCH-04`, `Q-ORCH-05`, `Q-ORCH-06`, `Q-ORCH-07`, `Q-ORCH-08`, `Q-AUTH-01`, `Q-AUTH-02`, `Q-AUTH-03`, `Q-AUTH-04`, `Q-AUTH-05`, `Q-AUTH-06`, `Q-AUTH-07`, `Q-AUTH-08`, `Q-BROWSER-01`, `Q-BROWSER-02`, `Q-BROWSER-03` | 초기 14건 수정 및 잔여 경로 재검토; 제공된 Q의 하위 항목 전수 대조 PASS·잔여 0. Main 통합, 실제 구현 미실행 |
| `REV-D` | `PASS` | `01a07f82-60fa-7f81-a2fd-1abea66d4c12` · `01a08098-f1c2-7440-82f8-c7dc608bf2d0` | `01a08093-5cbf-7661-b500-d4ef941ef6b8` | `Q-CODE-01`, `Q-CODE-02`, `Q-CODE-03`, `Q-CODE-04`, `Q-CODE-05`, `Q-CODE-06`, `Q-CODE-07`, `Q-CODE-08`, `Q-CODE-09`, `Q-TERM-01`, `Q-TERM-02`, `Q-TERM-03`, `Q-TERM-04`, `Q-TERM-05`, `Q-DATA-01`, `Q-DATA-02`, `Q-DATA-03`, `Q-DATA-04`, `Q-DATA-05`, `Q-DATA-06`, `Q-DATA-07`, `Q-DATA-08`, `Q-DATA-09`, `Q-UX-01`, `Q-UX-02`, `Q-UX-03`, `Q-UX-04` | 초기 14건 수정 및 잔여 경로 재검토; 제공된 Q의 하위 항목 전수 대조 PASS·잔여 0. Main 통합, 실제 구현 미실행 |
| `REV-E` | `PASS` | `01a07f83-6798-7f72-b823-6cace5a7e809` · `01a08098-f24d-72c3-a552-680883cef639` | `01a08093-5c40-7b92-8099-c53915f0825b` | `Q-ONT-01`, `Q-ONT-02`, `Q-ONT-03`, `Q-ONT-04`, `Q-ONT-05`, `Q-COL-01`, `Q-COL-02`, `Q-COL-03`, `Q-COL-04`, `Q-COL-05`, `Q-COL-06`, `Q-COL-07`, `Q-COL-08`, `Q-COL-09`, `Q-COL-10`, `Q-CU-01`, `Q-CU-02`, `Q-CU-03`, `Q-CU-04`, `Q-CU-05`, `Q-CU-06`, `Q-CU-07`, `Q-CU-08`, `Q-CU-09` | 초기 11건 수정·교차 검토의 추가 배치 충돌 1건 수정 및 잔여 경로 재검토; 제공된 Q의 하위 항목 전수 대조 PASS·잔여 0. Main 통합, 실제 구현 미실행 |
<!-- DESIGN-REVIEWS:END -->

통합 전사 검토는 `01a08098-f24d-72c3-a552-680883cef639`가 Atlas의 6건을 대조·재확인했다. 이어 `01a08100-5b9e-7d51-ac41-69737d1a6b6a`가 46개 조작 셀과 Main의 실행 시도 비교·원 Chat 복귀·전송 전 설정 명세를 확인하고 잔여 3건 수선 뒤 PASS를 반환했다. 이는 신규 정책 승인이나 제품 실행 결과가 아니다.

아래 지문은 최종 확인된 본문을 식별한다. 본문이 바뀌면 완결 검사는 재검토 필요로 표시하며, 변경 범위를 다시 대조한 뒤에만 지문과 검토 기록을 갱신한다. 질문에 대한 실제 사용자 결정은 원장에 별도로 기록한다.

<!-- DESIGN-REVIEW-FINGERPRINTS:START -->
| 문서 | 최종 검토 본문 | SHA-256 |
|---|---|---|
| `ATLAS` | [사용설명서](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md) | `b4f5aa20dd562c591c1981bb0a94181972f765109bcd4fd5190acb328cec1c6f` |
| `UX` | [화면 상세](../references/design-synthesis/egdesk-ux-realization-proposals.md) | `888547f37cc8b4278678fdbd5731a0c26c2897a79d4b9419c2b96024c41cba6a` |
| `CONTRACT` | [기술 상세](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md) | `cebceb1f2b263a8de7a2c8f66201ffada5bf356cd33209b66bf8b85f3004d86e` |
<!-- DESIGN-REVIEW-FINGERPRINTS:END -->

## 9. owner decision batch 호환 색인 — D1–D10

`D1`–`D9`는 기준 Atlas의 기존 routing ID 집합을, `D10`은 Agent Profile·Run addition의
이력을 보존하는 호환 색인이다. 이 표는 0절과 별개의 두 번째 owner 질문 목록이
아니다. 실제 사용자 검토는 `HUM-*`로만 구성하고, batch는 관련 `Q-*` evidence packet을
준비하거나 과거 이력을 찾을 때만 사용한다.

| batch | exact owner question ID set | status |
|---|---|---|
| `D1` Desk 및 Board 객체 모델 | `Q-OBJ-01`–`Q-OBJ-04`, `Q-AG-01`, `Q-AG-02`, `Q-AG-06` | `COMPATIBILITY / OPEN VIA HUM` |
| `D2` 연속성 및 Board 수명주기 | `Q-LIFE-04`, `Q-RESTORE-02`, `Q-RESTORE-04`, `Q-RESTORE-05`, `Q-AG-07`, `Q-AG-08`, `Q-AG-11`, `Q-AG-12`, `Q-AG-16` | `COMPATIBILITY / OPEN VIA HUM` |
| `D3` 리소스, 탐색, 출처 및 Terminal | `Q-OBJ-05`, `Q-VIEW-01`, `Q-VIEW-05`–`Q-VIEW-07`, `Q-DISC-01`, `Q-AUTH-01`, `Q-AUTH-04`, `Q-TERM-01`, `Q-TERM-02` | `COMPATIBILITY / OPEN VIA HUM` |
| `D4` 인공지능 요청 및 대화 모델 | `Q-OBJ-06`, `Q-OBJ-07`, `Q-CHAT-01`, `Q-CHAT-03`, `Q-AI-01`, `Q-AI-03`–`Q-AI-09` | `COMPATIBILITY / OPEN VIA HUM` |
| `D5` Canvas 답변 미디어 및 Answer Briefing | `Q-MEDIA-01`, `Q-MEDIA-03`–`Q-MEDIA-06`, `Q-MEDIA-08`, `Q-MEDIA-10` | `COMPATIBILITY / OPEN VIA HUM` |
| `D6` 오케스트레이션 및 Ontology | `Q-ORCH-01`–`Q-ORCH-04`, `Q-ORCH-07`, `Q-ONT-01`–`Q-ONT-03` | `COMPATIBILITY / OPEN VIA HUM` |
| `D7` 사람 대상 코딩 | `Q-CODE-01`, `Q-CODE-03`, `Q-CODE-04` | `COMPATIBILITY / OPEN VIA HUM` |
| `D8` 협업 및 computer-use | `Q-COL-01`–`Q-COL-06`, `Q-CU-01`–`Q-CU-04`, `Q-CU-09` | `COMPATIBILITY / OPEN VIA HUM` |
| `D9` 데이터 및 접근성 | `Q-DATA-01`–`Q-DATA-05`, `Q-UX-01` | `COMPATIBILITY / OPEN VIA HUM` |
| `D10` Agent Profile·Run 모델 | `Q-AGENT-01`–`Q-AGENT-03`, `Q-AGENT-05`–`Q-AGENT-18` | `COMPATIBILITY / OPEN VIA HUM`; 준비 조사 `Q-AGENT-04`, `Q-AGENT-19`, `Q-AGENT-20` |

운영 규칙:

- PM은 각 `HUM-*`와 관련 batch/PM work group의 evidence-backed 선택지를 하나의 일관된 question packet으로 준비한다.
- Main만 `HUM-*` packet을 owner에게 route하고 응답을 연결된 각 `Q-*` ID에 반영한다. D batch를 별도 질문 묶음으로 중복 제시하지 않는다.
- owner가 즉시 응답하지 않아도 batch 전체나 독립 작업 전체를 멈추지 않는다. 결정에 실제로 종속된 설계·구현 분기만 대기한다.
- PM 제안이 준비되지 않았거나 owner가 침묵한 상태는 거부가 아니라 `OPEN`이다.

## 10. approval registry — exact 6 IDs

모든 승인 package는 PM이 근거·선택지·영향을 준비하고 Main이 최종 package, route, disposition을 소유하며 제품 owner가 승인·거부·보류한다. Registry에 있다는 사실은 승인 요청이 실제 제시되었거나 승인되었거나 실행되었다는 뜻이 아니다.

| approval ID | gate 정의 | decision package 필수 항목 | package ownership | status |
|---|---|---|---|---|
| `A-INFRA-01` | 원격 협업용 신원 체계, 서버, 네트워크, 데이터베이스 또는 동기화 provision | 선택지, provider/self-host 비교, 데이터 흐름, 역할, 보안, 비용, migration, 삭제 | PM 준비 → Main 최종 소유·route → owner 결정 | `APPROVAL / OPEN` |
| `A-INFRA-02` | Desk 외부 computer-use의 streaming·저장·원격 제어 권한 | 관찰·제어 범위, 동의, 개인정보, 보존, 전송, 격리, emergency stop | PM 준비 → Main 최종 소유·route → owner 결정 | `APPROVAL / OPEN` |
| `A-INFRA-03` | 다중 기기 sync 또는 원격 backup 활성화 | 데이터 세트, 충돌·offline 모델, identity, encryption, provider, 비용, migration, export/delete | PM 준비 → Main 최종 소유·route → owner 결정 | `APPROVAL / OPEN` |
| `A-AUTH-01` | 새 credential, 외부 계정, OAuth scope, API key 또는 provider identity 생성·연결·권한 부여 | 계정·provider, scope, 저장, 만료·철회, 데이터 접근, 대안, 종속 작업 | PM 준비 → Main 최종 소유·route → owner 결정 | `APPROVAL / OPEN` |
| `A-AUTH-02` | 구매, provision, 배포, 게시, domain 등록 또는 유료 외부 서비스 활성화 | provider·선택지, 반복·일회 비용, 배포 대상, 보안, rollback, 소유권, migration, 종속 작업 | PM 준비 → Main 최종 소유·route → owner 결정 | `APPROVAL / DEFINITION-ONLY`; gate 정의 유지 |
| `A-AUTH-03` | 민감 데이터 외부 전송 또는 위임 범위 밖의 실질적으로 새로운 외부 효과 | 데이터·효과·수신자, 목적, 최소화, 보존, 가역성, 완료 증거, 종속 작업 | PM 준비 → Main 최종 소유·route → owner 결정 | `APPROVAL / OPEN` |

`APPROVAL`은 실행 권한의 disposition일 뿐 실행 성공이 아니다. 승인 후에도 provider receipt, 외부 상태, 배포 대상 또는 독립 검증 등 해당 행동에 맞는 별도 완료 증거가 있어야 한다. 실패·알 수 없음·미실행은 승인 기록과 별도로 유지한다.

## 11. rejected / contamination ledger

| 항목 | disposition | 제외·제한 이유 | 재도입 조건 |
|---|---|---|---|
| `EXC-001` — `Workspace` | `REJECTED` product object | 결정 근거 없이 도입된 정의되지 않은 객체이며 Desk·Board 관계를 왜곡한다 | owner가 별도 객체 의미와 관계를 명시적으로 결정한 경우에만 새 disposition |
| `EXC-002` — `Host Activity View` canonical name | `REJECTED` canonical term | 이전 라운드에서 지어낸 객체명이다. Desk 외부 관찰은 기능 질문이지 이 이름의 객체가 아니다 | 기능·표면·정본 이름을 owner가 결정한 경우 |
| `EXC-003` — `Await Token` as orchestration | `REJECTED` orchestration model | 파일·사용자 event 대기는 한 dependency condition일 수 있지만 orchestration 자체는 dependency 완료와 후속 작업 시작이다 | condition primitive로만 근거를 붙여 제안 가능 |
| `EXC-004` — restore journal items / keep-discard restore items | `REJECTED` normal-start UI | 정상 실행은 실제 Desk를 복원해야 하며 임의의 복구 journal workflow를 먼저 열지 않는다 | 손상·부분 복구의 구체적 예외 흐름으로 owner 결정이 있을 때만 가능 |
| `EXC-005` — fixed Board schema | `REJECTED` inherited assumption | Board의 정확한 구성원·필수 필드·저장 범위는 `Q-AG-02`, `Q-AG-08`이 정한다. 직전 Contract snapshot의 objective/members/bindings/workflow/layout 열거는 정본 스키마가 아니다 | 두 질문의 owner disposition 뒤 Atlas·Contract를 함께 갱신할 때만 가능 |
| `EXC-006` — fixed `Agenda Thread` object | `REJECTED` inherited object | 필요한 것은 shared work conversation capability이며 최종 객체 형식·명칭은 `Q-OBJ-06`이 정한다 | `Q-OBJ-06` owner disposition이 해당 객체와 이름을 명시할 때만 가능 |
| `EXC-007` — `Main` as product participant or integration role | `REJECTED` situated-role transfer | Codex 문서 유지보수 역할인 Main을 EG-Desk 사용자·Agent·System 역할이나 공유 대화 참가자로 전사할 수 없다 | 제품 owner가 별도 제품 역할을 다른 정본 이름·권한으로 결정할 때만 가능 |
| result chip | `NON-OBJECT / AFF-001` | Chat–Canvas 탐색 affordance 후보일 수 있으나 지속되는 domain object나 결과 동일성은 아니다 | `AFF-001` UI affordance proposal로만 조사·제안 가능 |
| approval queue object | `NON-ASSUMPTION` | Main의 내부 승인 묶음 운영을 제품 사용자용 queue 객체로 전사하면 situated boundary를 위반한다 | `Q-ORCH-03` 계열 owner decision이 제품 표면과 객체성을 명시할 때만 가능 |

Negative audit은 위 용어가 문자열로 나타났는지만 보지 않고, 같은 가정이 다른 이름으로 제품 의미에 재도입되었는지도 검사한다.

## 12. external-reference reuse governance

원칙은 “이미 검증된 바퀴를 다시 만들지 않되, reference가 제품 의미를 결정하게 두지 않는다”이다. 기술 방식은 승인된 제품 결과와 risk boundary를 바꾸지 않는 범위에서 구현자가 유연하게 선택할 수 있다.

| 단계 | 책임 | 필수 산출물 |
|---|---|---|
| framing | PM | 해결할 제품 질문, 비교 기준, 필요한 primary evidence, 금지된 의미 도약 |
| local source map | WM | 현재 source와 local `references/` 위치, freshness, version drift, current-vs-reference 분류 |
| bounded research | researcher / worker | 공식 문서·표준·원저자 자료·활성 reference implementation의 한정된 evidence packet |
| product fit | PM | reuse 후보별 fit·trade-off·보존할 제품 경계·proposal; reference는 owner decision을 대신하지 않음 |
| routing | Main | PM packet을 owner decision, implementation, approval 또는 rejection 경로로 최종 route |
| technical method | implementation agent | 승인된 결과·권한·보안 경계 안에서 재사용·adapter·직접 구현 방법을 선택하고 검증 |

각 외부 reference record에는 최소한 다음을 남긴다.

- 정확한 이름, primary URL 또는 재현 가능한 local locator
- 조사 시점의 version·release·활동성 및 freshness
- license와 재배포·수정·상업 사용 조건
- 알려진 security posture, 취약점·권한·데이터 흐름
- Firefox shell 및 EG-Desk 제품 경계에 대한 fit
- 재사용 방식: direct, adapted, concept-only 또는 rejected
- 채택하지 않은 경우 rejection evidence와 이유

Reference가 널리 쓰인다는 사실, 현재 구현에 이미 있다는 사실, 화면이 유사하다는 사실은 제품 객체·명칭·행동을 확정하지 않는다.

### 12.1 공식 primary-reference matrix

**확인일**: 2026-08-04  
**공통 provenance**: `PRIMARY-REFERENCE`  
**공통 adoption status**: `RESEARCH-PATTERN`

아래 자료는 조사 패턴과 제약을 제공할 뿐 제품 결정을 내리지 않는다. `PRIMARY-REFERENCE`에서 관찰한 SDK·protocol의 타입, enum, 우선순위, session 또는 orchestration 방식은 `OWNER-DECISION` 없이 EG-Desk 제품 객체·scope·권한 규칙으로 승격할 수 없다.

| 공식 source | 확인된 research pattern | version / license / security record | EG-Desk fit와 금지된 전사 | related question IDs | provenance / adoption |
|---|---|---|---|---|---|
| [OpenAI Codex App Server](https://developers.openai.com/codex/app-server) | Rich client를 위한 인증·대화·승인·stream event protocol을 제공한다. ChatGPT managed browser login은 `authUrl`과 local callback을 사용하고, 완료 뒤 `account/updated`/`account/read`에서 auth mode·account·`planType`을 확인할 수 있으며 rate-limit read도 제공한다. | 2026-08-08 확인한 rolling 공식 문서. WebSocket listener는 공식 문서상 experimental/unsupported이므로 transport 선택은 구현 시 재검증한다. App Server source는 공식 open-source repository가 연결되어 있으나 이 문서 수정에서 code를 복사하지 않았다. | Codex Engine adapter 기준선으로 적합하다. 그러나 App Server의 현재 account 상태를 EG-Desk 다중 계정 registry, EG-Desk login identity 또는 Browser account로 전사하지 않는다. 계정별 runtime/config/credential 격리는 EG-Desk 선택 기준선이며 공식 protocol 자체의 다중-account 기능 주장으로 쓰지 않는다. | `HUM-ENGINE-001`, `Q-AUTH-03`, `Q-AGENT-04`, `Q-AGENT-08` | `PRIMARY-REFERENCE / SELECTED-BASELINE` |
| [OpenAI Agents SDK — Agents](https://openai.github.io/openai-agents-python/agents/) | SDK의 `Agent`는 LLM에 `name`, `instructions`, `model`, `tools`와 선택적 `handoffs`, `guardrails` 등을 결합한 재사용 가능한 정의다. tool을 노출해도 실제 사용은 별도 실행 동작이다. | Rolling docs URL로 page version은 고정되지 않음. 문서 패턴만 조사하며 code를 가져오지 않아 license에 의존하지 않는다. Guardrail은 입력·출력 검사 패턴이지 제품 권한의 대체물이 아니다. | 필드 분해는 Profile 후보 비교에 쓸 수 있지만 SDK `Agent`를 EG-Desk의 최종 제품 Agent 객체로 그대로 승격하지 않는다. | `Q-AGENT-01`, `Q-AGENT-03`–`Q-AGENT-06`, `Q-AGENT-10`, `Q-AI-07`–`Q-AI-09` | `PRIMARY-REFERENCE / RESEARCH-PATTERN` |
| [OpenAI Agents SDK — Running agents / RunConfig](https://openai.github.io/openai-agents-python/running_agents/) | 재사용 Agent definition과 한 run에 적용되는 `RunConfig` override를 구분한다. RunConfig는 model/provider/settings, guardrail·handoff 입력, tracing과 tool 실행 동작을 run 수준에서 바꿀 수 있어 effective configuration snapshot을 별도로 설계할 근거가 된다. | Rolling docs URL로 page version은 고정되지 않음. 문서 패턴만 조사하며 code를 가져오지 않는다. Trace는 민감한 LLM/tool input·output을 포함할 수 있어 별도 보안·보존 통제가 필요하다. | SDK override precedence는 구현 사례일 뿐 EG-Desk의 Profile·request·권한·Ontology scope 우선순위로 복제하지 않는다. 실제 유효 snapshot과 권한 교집합은 owner decision을 따른다. | `Q-AGENT-04`–`Q-AGENT-06`, `Q-AGENT-08`, `Q-AGENT-11`, `Q-AGENT-12`, `Q-AGENT-14`, `Q-AI-04`, `Q-AI-05`, `Q-AI-08` | `PRIMARY-REFERENCE / RESEARCH-PATTERN` |
| [MCP Specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28), [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) | Base protocol은 stateless·self-contained request와 per-request capability negotiation을 사용한다. `tools/list` 결과는 request에 제시된 authorization에 따라 달라질 수 있고, authorization은 매 HTTP request에서 검증된다. | Version은 `2026-07-28`로 고정. Protocol research만 하며 구현 code를 가져오지 않아 code license에 의존하지 않는다. Explicit consent, least privilege, token audience·expiry·scope validation과 401/403 경계를 보안 근거로 유지한다. | MCP는 integration protocol이지 Agent/Profile/Run 제품 모델이 아니다. Tool exposure 또는 list 포함은 권한 부여, 호출, 외부 효과나 성공 증거가 아니다. | `Q-AGENT-01`, `Q-AGENT-05`, `Q-AGENT-06`, `Q-AGENT-12`, `Q-AGENT-14`, `Q-AI-09`, `Q-AUTH-01`–`Q-AUTH-03` | `PRIMARY-REFERENCE / RESEARCH-PATTERN` |
| [OpenAI API — MCP and Connectors](https://developers.openai.com/api/docs/guides/tools-connectors-mcp) | MCP/connector request는 credential 값 또는 관리되는 credential binding/reference와 request-level authorization·tool approval를 결합해야 한다. Authorization value는 Response에 보존·노출되지 않으며 필요한 request에 다시 제공해야 한다. | Rolling API docs로 page version은 고정되지 않음. 예제 code는 가져오지 않는다. OAuth client registration은 application 책임이며 prompt injection, trusted server 선택, sensitive action approval이 명시적 보안 경계다. | Connector가 configured 상태라는 사실은 credential이 연결·유효하거나 request가 authorized·실행·성공했다는 뜻이 아니다. EG-Desk는 binding, authorization, approval, execution evidence를 분리한다. | `Q-AGENT-05`, `Q-AGENT-06`, `Q-AGENT-08`, `Q-AGENT-11`, `Q-AGENT-14`, `Q-AI-09`, `Q-AUTH-03`, `Q-AUTH-06` | `PRIMARY-REFERENCE / RESEARCH-PATTERN` |
| [Anthropic Agent SDK — Permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions) | Tool request는 hooks, deny, ask, permission mode, allow, callback 순서로 평가되는 패턴을 제공한다. Session은 prompt·tool call/result·response를 담은 conversation history이며 filesystem snapshot은 아니다; resume/fork와 file checkpoint는 별개다. | Rolling docs이며 일부 MCP user-interaction annotation은 Claude Code `v2.1.199+` 조건이 명시된다. 문서 패턴만 조사하며 code를 가져오지 않는다. Bypass/allow/deny·ask와 session 보존은 security·privacy 검토 대상이다. | Provider-specific permission mode, enum, evaluation order, continue/resume/fork semantics를 EG-Desk 제품 의미로 복제하지 않는다. 대화 지속성은 파일·Desk·runtime 복원 증거가 아니다. | `Q-AGENT-05`, `Q-AGENT-07`, `Q-AGENT-08`, `Q-AGENT-11`, `Q-AGENT-14`, `Q-AGENT-16`, `Q-AI-04`, `Q-AI-05`, `Q-AI-09`, `Q-AUTH-01` | `PRIMARY-REFERENCE / RESEARCH-PATTERN` |
| [OpenAI Agents SDK — handoff/context](https://openai.github.io/openai-agents-python/agents/), [Run tracing](https://openai.github.io/openai-agents-python/running_agents/) | Manager-as-tool은 중앙 Agent가 대화를 유지하며 specialist를 tool로 호출하는 방식이고, handoff는 specialist가 대화를 넘겨받는 별도 방식이다. Run context는 dependency/state 전달 수단이고 tracing은 run·tool·handoff 관찰 메타데이터다. | Rolling docs로 page version은 고정되지 않음. 문서 패턴만 조사하며 code를 가져오지 않는다. Context와 trace에는 민감 정보가 들어갈 수 있어 최소화·접근·보존 통제가 필요하다. | `handoff != manager-as-tool`; `trace != audit != evidence`. Trace 존재나 handoff 완료는 권한 판단, 독립 감사, 제품 결과 또는 외부 효과 성공을 인증하지 않는다. | `Q-AGENT-01`, `Q-AGENT-06`, `Q-AGENT-11`, `Q-AGENT-12`, `Q-AGENT-15`, `Q-AGENT-18`, `Q-AI-06`, `Q-AI-09`, `Q-AUTH-04` | `PRIMARY-REFERENCE / RESEARCH-PATTERN` |
| [W3C PROV-DM](https://www.w3.org/TR/prov-dm/) | provenance를 고정된 측면을 가진 entity, entity를 사용·생성하는 activity와 entity 사이 derivation으로 분리한다. 변하는 source 상태, 특정 시점의 Agent Observation Snapshot, 파생 Answer/Canvas 항목을 서로 다른 identity로 기록하는 참고가 된다. | 2013-04-30 W3C Recommendation, 2026-08-06 확인. 표준 개념만 조사하며 schema나 code를 가져오지 않는다. provenance 기록 자체의 접근·민감도·보존은 별도 정책이 필요하다. | Agent Observation Snapshot → Answer/Canvas derivation과 도구 호출 당시 source revision을 설명하는 concept-only pattern이다. W3C 타입·용어·전체 데이터 모델을 EG-Desk 정본 객체나 저장 schema로 복제하지 않는다. | `Q-AI-04`, `Q-MEDIA-01`, `Q-AGENT-18` | `PRIMARY-REFERENCE / CONCEPT-ONLY` |
| [Git Objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects) | 콘텐츠로 식별되는 object store와 동일 콘텐츠 재사용은 immutable snapshot integrity와 중복 제거의 참고 패턴을 제공한다. | 2026-08-06 확인한 rolling Git 공식 문서. 설명·개념만 조사하며 code를 가져오지 않는다. hash algorithm과 collision/security 요구는 실제 저장 설계에서 별도 결정한다. | snapshot ID·무결성·dedup을 위한 concept-only pattern이다. EG-Desk가 Git repository, Git object format 또는 특정 hash algorithm을 사용해야 한다는 뜻이 아니다. | `Q-AI-04`, `Q-DATA-01`, `Q-AGENT-18` | `PRIMARY-REFERENCE / CONCEPT-ONLY` |
| [Prezi Present — topic and subtopic path](https://support.prezi.com/hc/en-us/articles/360044277273-Setting-a-path-for-topics-and-subtopics-in-Prezi-Present), [structuring a presentation](https://support.prezi.com/hc/en-us/articles/360003498513-Structuring-in-Prezi-Present) | Canvas의 Frame·Topic을 Timeline 순서로 배열하고, step 사이에서 Overview로 돌아가거나 다음 target으로 직접 zoom하는 presentation path 패턴을 제공한다. | 2026-08-05 확인한 rolling 공식 도움말. 개념·상호작용 명칭만 조사하며 code/assets를 가져오지 않는다. 모션은 비시각적·reduced-motion 대안을 대신하지 않는다. | `Frame`, `Timeline`, `Path`는 Focus Scope·순서·viewport 전환을 설명하는 참고 패턴이다. Prezi 객체·명칭·저장 모델을 EG-Desk 제품 객체로 복제하지 않고, Agent Run 재생 근거로도 사용하지 않는다. | `Q-MEDIA-04`, `Q-MEDIA-09`, `Q-UX-03` | `PRIMARY-REFERENCE / CONCEPT-ONLY` |
| [Miro — Presentation mode](https://help.miro.com/hc/en-us/articles/34307373858450-Presentation-mode), [Frames](https://help.miro.com/hc/en-us/articles/360018261813-Frames) | Canvas Frame을 집중된 presentation mode에서 이전·다음 화살표로 이동하고, 공개 범위를 단계별로 조절하는 사용자 주도 탐색 패턴을 제공한다. | 2026-08-05 확인한 rolling 공식 도움말. 개념만 조사하며 code/assets를 가져오지 않는다. | `Presentation mode + Frames`는 브리핑 진입·Focus Scope·이전/다음 컨트롤의 참고다. Miro의 frame=slide 모델이나 협업 권한을 EG-Desk의 Answer Briefing 계약으로 그대로 전사하지 않는다. | `Q-MEDIA-04`, `Q-MEDIA-09`, `Q-MEDIA-10` | `PRIMARY-REFERENCE / CONCEPT-ONLY` |

### 12.2 국문 백서 문체·구성 참고 (2026-09-06)

백서 재작성에 사용한 설명 방식의 참고이며 제품의 실적·제공 상태·정책을 확정하는 근거가 아니다.
검토 코멘트와 아래 참고 방식은 백서 본문으로 전사하지 않는다.

| 참고 원문 | 확인 범위와 활용 | 전사하지 않은 내용 |
|---|---|---|
| [삼성SDS ChatGPT 기술 분석 백서 1부](https://www.samsungsds.com/kr/insights/chatgpt_whitepaper1.html), [2부](https://www.samsungsds.com/kr/insights/chatgpt_whitepaper2.html) | 공식 국문 본문의 개념 설명→원리→활용→한계 순서와 용어의 첫 설명을 참고 | 2023년 모델 성능·가격·시장 수치·당시 전망은 현재 EG-Desk 사실로 사용하지 않음 |
| [네이버클라우드 보안 모범 사례](https://www.ncloud.com/api/support/download/5/120) | 2021년 PDF의 목차·서론·책임 공유 설명, 실제 5–6쪽 지면 확인. 책임 주체와 적용 범위를 풀어 설명하는 방식을 참고 | 인증·보안 역량·고객 실적을 EG-Desk의 보장으로 전환하지 않음 |
| [카카오 코로나 백서 2 공식 국문 연재](https://brunch.co.kr/@kakao-it/418/) | 2022년 ‘이용자와 정부가 하나 된 디지털 방역’ 본문. 이용자의 상황→서비스가 연결한 경험→근거의 전개를 참고 | 사례·성과 수치·표현·도판을 복제하지 않음. PDF 전체를 완독했다고 주장하지 않음 |

본문의 실질 인용은 NIA 「공공부문 초거대 AI 도입·활용 가이드라인」(2024, 26–28쪽)의
업무·목표·단계적 도입 관점과 네이버클라우드 백서(2021, 6쪽)의 책임 공유 개념으로 한정했다.
기존 출처 불명·시점 혼합 통계, 보편적 원샷 성공·무흔적 보장과 과거 출시 일정은 재사용하지 않았다.
기존 파일명을 유지하고, 유입 앵커는 읽히는 개발 주석 없이 본문 탐색 앵커로 보존한다.

### 12.3 입력·다중 PC 복구의 한정된 근거 (2026-09-08)

아래 확인은 기존 입력·관찰·권한·완료 증거 계약을 구체화하기 위한 `PRIMARY-REFERENCE /
RESEARCH-PATTERN`이다. 제품 기본값의 owner 승인을 대신하지 않는다. 문서 패턴만
참고했으며 소스 코드·표준 원문을 복제하거나 의존성을 채택·재배포하지 않았다.

| primary source / 확인 범위 | 적용한 판단 | 적용 한계·연결 |
|---|---|---|
| [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/), [Dragging Movements 해설](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html); WCAG 2.2 기준과 해당 해설 확인 | 제품이 만든 드래그 기능에 클릭·탭 대안과 키보드 경로를 각각 점검한다. focus·상태 안내와 비공간 경로를 같은 사용 흐름에서 확인한다 | 웹 콘텐츠 기준의 적용 패턴이다. Firefox shell·native 앱 전체의 준수나 특정 보조기술 지원을 입증하지 않는다. Contract §16, UX-01, Q-UX-02–04 |
| [MDN KeyboardEvent.isComposing](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/isComposing); rolling 문서, 조합 세션의 의미 확인 | 입력기의 조합 확정과 Chat 전송을 분리해 검사한다 | event 지원 설명만으로 한국어 IME·OS별 실제 이벤트 순서를 검증한 것은 아니다. Contract §16, UX 공통 입력, Q-AI-02 |
| [RFC 9110 §9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods)·[§13.1.1 If-Match](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match), [Amazon Builders’ Library: Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/); 재시도·외부 효과·조건부 쓰기 의미 확인 | 응답 유실과 미실행을 구별하고 접수 증거·동일 요청·서비스 측 중복 방지를 대조한다. 동시 변경은 사용자가 본 버전과 현재 버전의 조건을 비교해 타인의 수정을 조용히 덮지 않는 패턴을 참고한다 | HTTP·API의 보장을 GUI 입력이나 로컬 요청 ID에 자동 적용하지 않는다. 조건부 쓰기 자체는 의미 충돌 해결·자동 병합이나 권한 부여가 아니다. AWS 서비스·특정 오케스트레이션·CRDT를 채택한 것이 아니다. Contract §12–13, Q-AGENT-20, Q-AUTH-06, Q-COL-05·10 |

## 13. audit checklist

| 검사 | worker draft 상태 | Main final 상태 |
|---|---|---|
| 기준 Atlas SHA-256과 Git `UNTRACKED` 상태 재확인 | `WORKER-PASS` | `PASS` |
| 기준 질문 154개 unique 및 canonical route 72/82 보존 | `WORKER-PASS` | `PASS` |
| addition 후 질문 175개 unique, route 90/85 | `MAIN-DRAFT-PASS` | `PASS` |
| 의도적으로 비어 있는 Board 숫자 gap에 새 ID가 없음 | `WORKER-PASS` | `PASS` |
| trace registry 43개 unique: 기존 39 + Smart Read/Engine 4 | `MAIN-WEAVE` | `PASS-ACTUAL` |
| approval registry exact 6개 및 definition-only gate 유지 | `WORKER-PASS` | `PASS` |
| `D1`–`D9` 기존 owner ID set 보존 및 `D10` 17개 | `MAIN-DRAFT-PASS` | `PASS` |
| `Q-*`/trace action body를 원장에 복제하지 않고 `HUM-*`만 정본 질문으로 소유 | `MAIN-WEAVE` | `PASS-ACTUAL` |
| raw prompt·CoT·credential·절대 로컬 경로 없음 | `WORKER-PASS` | `PASS` |
| explicit Atlas·Contract·HUM anchors가 실제 문서에 존재하고 모두 resolve | `MAIN-WEAVE` | `PASS-ACTUAL`; unresolved local link/fragment 0 |
| Atlas flow → Contract 기술 anchor와 Contract → Atlas 대표 flow가 양방향 resolve | `MAIN-WEAVE` | `PASS-ACTUAL`; 43 trace 모두 기술 링크 보유, 28개 기술 anchor 모두 Atlas에서 참조 |
| 모든 `HUM-*` 정의가 사용자 확인 원장에 유일하게 존재하고 독립 작업·차단 범위를 기록 | `MAIN-WEAVE` | `PASS-ACTUAL`; 정의 18개 unique, owner-routed Q 90개 전수 매핑, 누락·추가·중복·미정의 0 |
| raw capture와 Agent 전달 payload를 보편적으로 동일시하는 문장 0개 | `MAIN-WEAVE` | `PASS-ACTUAL`; direct bounded read와 Smart Read를 분리해 검사 |
| 제품 runtime에 Codex 문서 역할 `Main` 또는 문서용 approval queue가 제품 객체·행위자로 누출되지 않음 | `MAIN-WEAVE` | `PASS-PM / PASS-ACTUAL`; 부정 경계 문장만 유지, runtime 누출 0 |
| 여러 Run·Task·Agent contribution·Result에서 논리적 Answer revision을 만들고 Agent/integration 제안·System 검증·사용자 override 권한을 분리 | `MAIN-WEAVE` | `PASS-PM / PASS-ACTUAL`; Atlas·Contract·HUM-ANSWER 정합 |
| 기술 Contract 본문이 한국어 독자용 정본이며 기술 식별자·API명만 원형을 보존 | `MAIN-WEAVE` | `PASS-ACTUAL`; 장문 영문 설명 0, 명시 anchor와 의미 보존 |
| contamination negative audit와 external-reference evidence 완결 | `WORKER-EDITORIAL-PASS` | `PASS-PM` |
| final target rewrite 후 hash·line/row count·Git diff 재검증 | `MAIN-WEAVE` | `PASS-PM / PASS-ACTUAL`; 네 정본 voice split·routing 갱신 후 전용 validator, 분할 PM 의미 감사와 `git diff --check` 통과 |

## 14. event history

| event ID | 일자 | actor | 사건 | provenance / evidence | status |
|---|---|---|---|---|---|
| `ATL-ED-0001` | 2026-08-04 | worker | 기준 Atlas snapshot, clean-room boundary 및 기존 inventory 등록 | source SHA-256, Git state, Atlas/프로젝트 context | `RECORDED` |
| `ATL-ED-0002` | 2026-08-04 | worker | provenance·route migration과 154개 기존 질문 routing metadata 초안 등록 | 기준 Atlas question registry와 `D1`–`D9` | `DRAFT-RECORDED` |
| `ATL-ED-0003` | 2026-08-04 | worker | Agent Profile·Run trace 3개, 질문 14개, `D10` candidate 등록 | Agent addition fragment | `DRAFT-RECORDED` |
| `ATL-ED-0004` | 2026-08-04 | worker | 공식 primary-reference 6행 matrix와 제품 의미 전사 금지 경계 등록 | OpenAI Agents SDK/API, MCP 2026-07-28, Anthropic Agent SDK 공식 문서 | `DRAFT-RECORDED` |
| `ATL-ED-0005` | 2026-08-04 | worker | draft mechanical·editorial audit와 row count 기록 | 499 lines; 질문 168, trace 38, approval 6, source boundary 6, reference matrix 6 | `RECORDED` |
| `ATL-ED-0006` | 2026-08-04 | Main | 객체 모델이 드러낸 추가 질문 6개와 누락된 경계 장애 trace를 축약하지 않고 candidate에 정식 편입 | 질문 174, trace 39, action row 140, route 89/85 | `DRAFT-RECORDED` |
| `ATL-ED-0007` | 2026-08-04 | PM / Main | 두 차례 의미 감사의 REVISE 항목을 반영해 Board·공유 대화 drift, maintainer contamination, 양방향 Chat–Canvas 복구, local computer-use 관찰, Agent effective Run binding, Task 8상태와 175번째 질문을 정합화 | PM audit 결과, Contract §14, 질문 175, trace 39, action row 144, route 90/85, candidate validator PASS | `REVIEWED / CORRECTED` |
| `ATL-ED-0008` | 2026-08-04 | Main | Atlas와 원장을 정본 경로에 설치하고 Contract §14·세 문서 역링크·explicit anchors를 반영 | Atlas·ledger candidate와 actual byte equality, PM final `PASS` | `RECORDED` |
| `ATL-ED-0009` | 2026-08-04 | Main | final ID·route·anchor·contamination·link·Git scope audit 완료 | trace 39, action row 144, question 175, route 90/85, approval 6, anchor 274, map 20, unresolved link 0, Atlas SHA `142e1f890bbe1ed3144f0f0aba59c2388fd227170f46037b2a5003d8a94270e5`, Contract SHA `d05d7976b047b95cbad6e717bb34fdfe0fc27f58de1a30e44c77c21f8587a6e3`; 세 정본 파일 `UNTRACKED`, staging 없음 | `PASS` |
| `ATL-ED-0010` | 2026-08-05 | owner input / PM / WM / Main | Atlas를 같은 정본 경로에서 manual-first 구조로 재배열하고, ASCII 화면 관계·입력 표기법·첫 실행부터 재실행까지 11단계 한 바퀴를 추가했으며 기존 ID·질문·승인 집합을 보존 | owner의 사용설명서 우선 요구, WM route advice, Prezi·Miro 공식 reference pattern, Atlas section 0–1 | `RECORDED` |
| `ATL-ED-0011` | 2026-08-05 | PM / Main | legacy `Playback`을 Answer Briefing 후보명으로 바로잡고 Agent/System/제품 사용자 책임, Briefing Step·Focus Scope·Comment, 수동 화면 전환과 one-Answer projection을 정합화 | Contract §4·§8, Atlas `OBJ-038`–`OBJ-040`, `AI-05`, `Q-MEDIA-04`·`Q-MEDIA-09`; PM P1 5건 수정 후 재감사 `PASS`; actual validator `PASS` | `REVIEWED / PASS` |
| `ATL-ED-0012` | 2026-08-06 | owner input / PM / WM / Main | logical binding만으로 나중의 Canvas 내용을 재구성하던 공백을 수정해 mutable source, Tool Result Snapshot, inference별 Agent Input Snapshot, versioned Canvas projection을 분리하고 완료 활동의 기본 historical view·현재 상태·diff·runtime handoff evidence·provider 비관찰 경계를 정합화 | owner fidelity 피드백, PM 의미 감사와 final `PASS`, WM source plan, W3C PROV-DM·Git Objects 공식 reference pattern, Contract §4.1, Atlas `M5-F`·`AI-01`·`AI-04`·`OBJ-052`·불변조건 32–33; actual validator `PASS` | `REVIEWED / PASS` |
| `ATL-ED-0013` | 2026-08-06 | owner input / Main | 도구가 40–80행을 반환했는데 Agent가 40–58행만 받는다는 잘못된 예를 폐기하고 정상 도구 결과와 Agent Observation Snapshot의 일대일 계약, Canvas의 Snapshot View/Live View 공존, Answer Briefing의 역사적 snapshot 사용으로 단순화했다. provider 내부 동작 설명은 제품 문서에서 제거했다 | owner 정정, Contract §4.1, Atlas `M5-F`·`AI-01`·`AI-04`·`OBJ-024`·`OBJ-052`·불변조건 32–33; candidate·actual validator `PASS` | `CORRECTED / SUPERSEDES ATL-ED-0012 SEMANTICS` |
| `ATL-ED-0014` | 2026-08-08 | owner input / PM / WM / Main | Atlas를 사용자의 클릭·타이핑·키보드·보이는 반응을 추적하는 UI/UX 정본으로, Contract를 구현 원리·기술 기준선의 정본으로 분리하고 서로의 섹션을 양방향 연결했다. Smart Read·Reader Session·별도 AI Engine 계정·snapshot 보존·SQLite/CAS·단일 `.egdesk` 반출입 흐름을 교차 설계했으며, owner만 답할 수 있는 gap은 12개 `HUM-*` 질문으로 이 원장 앞부분에 분리했다 | 실제 validator: trace 43, action row 157, object 56, tech anchor 28, HUM 12, unresolved local link/fragment 0. `ATL-ED-0013`의 보편적 일대일 의미는 direct bounded read에만 한정하고 Smart Read의 raw capture → Reader packet → Main context lineage로 대체 | `REVIEWED / PASS-ACTUAL / SUPERSEDES ATL-ED-0013 UNIVERSALITY` |
| `ATL-ED-0015` | 2026-08-08 | Main | 기술 Contract의 기존 영문 제목·설명·상태 전이 본문을 한국어 독자용으로 전환했다. API·protocol·schema·제품 식별자는 원형을 유지하고 anchor·상호 참조·기술 의미는 바꾸지 않았다 | Contract 전체 장문 영문 설명 검사 0, actual validator 재실행으로 28개 기술 anchor 및 문서 fragment 보존 확인 | `LOCALIZED / PASS-ACTUAL` |
| `ATL-ED-0016` | 2026-08-08 | PM / Main | UI/UX↔기술 weave 최종 의미 감사에서 발견된 제품 runtime의 `Main` 용어, 90개 owner 쟁점과 18개 `HUM-*`의 전수 연결, 다중 기여에서 논리적 Answer를 만드는 권한 경계를 정합화했다. `ATL-ED-0014`의 `12개 HUM`과 `Main context` 표현은 각각 18개 정본 질문과 요청 담당 Agent context로 대체한다 | actual validator: trace 43, action row 157, object 56, tech anchor 28, HUM 18, OWNER-PRODUCT Q→HUM 90/90, unresolved local link/fragment 0, runtime `Main`·recovery queue 누출 0; Atlas SHA `d8145f03fe20f6948d004f2b8950f1df2c68a2d819aea14b6bff3c255463c4dd`, Contract SHA `722c5195aa7bad41616cf9750c046dbe61c8318f29efb5135166856dae6677a3`; PM 최종 재감사 `PASS`, P0/P1 0 | `REVIEWED / PASS-ACTUAL / SUPERSEDES ATL-ED-0014 COUNTS AND RUNTIME ROLE` |
| `ATL-ED-0017` | 2026-08-09 | owner input / WM / Main | 제품 문서 안의 AI·편집자·독자 사고 지시를 수신 상황에 맞게 분리했다. Atlas는 사용자 매뉴얼·UI 행동, Contract는 기술 보장, 사용자 확인 원장은 18개 owner 결정만 소유하고, weave·source·provenance·routing·ID·감사·검증은 이 운영 정본으로 이동했다. PM profile·project context·WM file map·routing policy·docs index도 네 정본 경계로 갱신했다 | 전용 validator: trace 43, action row 157, object 56, Q anchor/route 175, owner route 90, PM route 85, HUM 18, approval 6, tech anchor 28, 누락·중복·깨진 local link/fragment·금지 화자 누출 0; Atlas SHA `b8290005b7ea9fc529d3b496062de4b832b6344c9e629586995e833e11565cc6`, Contract SHA `c07fc102108220dc8fd685bbb362ed9aec5cc83551f354f8372e6ef7d51d39a8`, 사용자 확인 원장 SHA `e12bd6c942da5d2f32dd1e7c00ff90073d374460b95e80fa678f7a973fc24624`; `git diff --check` 통과 | `PASS-ACTUAL / PM-AUDIT-PENDING` |
| `ATL-ED-0018` | 2026-08-09 | PM / Main | 분할 의미 감사에서 `Q-*` 본문을 Governance로 옮긴 뒤에도 Contract와 registry 도입부가 “Atlas 질문”이라고 가리키던 정본 소유권 모순 1건을 발견했다. Governance가 175개 `Q-*`의 본문·route·status·호환 anchor를 소유하도록 명시하고, Contract §1·§5·§14에서 제품 의미 `HUM-*`와 세부 UI `Q-*`를 각각 올바른 정본으로 연결했다 | 사람용 표면 PM 감사: Atlas 2,973행·사용자 확인 원장 194행 완독, `PASS`, P0/P1 0. 기술·운영 PM 감사: 최초 `REVISE` P1 1건 수정 후 focused 재감사 `PASS`, P0/P1 0. 전용 validator·fragment·`git diff --check` 재통과; Atlas SHA `b8290005b7ea9fc529d3b496062de4b832b6344c9e629586995e833e11565cc6`, Contract SHA `c16ed47260a2971c1472e10f09844cac6f19354c2162cebf192e04d6b3dac2b4`, 사용자 확인 원장 SHA `e12bd6c942da5d2f32dd1e7c00ff90073d374460b95e80fa678f7a973fc24624` | `REVIEWED / PASS-PM / PASS-ACTUAL / SUPERSEDES ATL-ED-0017 PM-AUDIT-PENDING` |
| `ATL-ED-0019` | 2026-08-30 | owner input / WM / Main | 하나의 Desk·Canvas와 동일 Canvas의 복수 Saved Board projection, view/runtime별 lifecycle과 Canvas representation, Board 닫기 시 전용 runtime 종료·Saved Board 보존, File view 재진입의 caret·focus·transient selection 제외를 확정했다. 기본 Chat을 Agent/persona 담당자 방으로 정하고, 위치 고정 Canvas Memo의 사용자 본문·작성자별 짧은 답글·필요 시 Agent 방 mention을 시각 표식과 함께 `CANVAS-01`에 통합했다. 같은 Agent 방의 업무 구분과 agent-agent workroom·공유 대화의 정확한 UI는 `OPEN`으로 유지했다 | `HUM-DESK-001`을 `DECIDED`로 전환하고 `Q-OBJ-01`, `Q-OBJ-02`, `Q-AG-06`을 `DECIDED`로 전환; 질문 175개 중 3 `DECIDED` / 172 `OPEN`. 전용 validator: trace 43, action row 157, object 56, tech anchor 28, HUM 18, route 90/85, unresolved local link/fragment 0, `git diff --check` 통과. Atlas SHA `f9cfaf24422e22a21f352c2c521828839bfb99343192c6eb3ab5fc4ebba7fc2d`, Contract SHA `b6aa79f645190214332af72f849e57008cee6123ccd8c893dde853219e8ef920`, 사용자 확인 원장 SHA `225882a228f54b01f9efa32a3911889830a7d0bf8d02fff69deb01041b76f989` | `RECORDED / PASS-ACTUAL / PM-AUDIT-PENDING` |
| `ATL-ED-0020` | 2026-09-06 | owner input / WM / PM / Main | 대화 요구를 네 정본·ECS/CAP와 대조했다. 최초 Ontology 조회와 같은 Run의 호출별 조정, 비율 유지 집중 보기·입력 비간섭을 정본까지 반영했다. 기존 가시성·불변 원문·권한 경계를 종료 확인, 교체 원문 coverage, Snapshot 비실행·접근 제한과 연결했고, 인증과 quota 제한을 구별했다. 일반 분할·검토·복구의 상시 사람 승인과 고정 Critic·배포 경로는 synthesis에서 정정했다. 기능 결합 후보 18개와 정상 이용 보완 분기 6개는 synthesis §10에 두고 기존 HUM으로 연결했다 | 현재 대화 `019f8d42-4886-7041-8421-c5e343d465e0`의 사용자 발언과 turn 78·85–98·132·134, 현행 정본 교차검토. WM routing, 분리된 PM/의미 검토; ECS 7·CAP 13·RWS 32와 정본 trace 43·HUM 18·Q 175의 링크·ID·표 구조 검사 PASS. 후보는 owner 결정이나 구현 완료로 승격하지 않음 | `CORRECTED / CANDIDATES-OPEN / STATIC-CHECKED` |
| `ATL-ED-0021` | 2026-09-06 | owner request / WM / PM / Main | 기존 후보 18개를 별도 비정본 UX 추천안의 9개 흐름으로 전개했다. 조작·입력·즉시 반응·System/Agent·취소·복귀와 기술 연결을 작성하고, 정책 추천안·대안·손실을 7개 독립 선택 가능한 묶음으로 정리했다. 기존 확정 의미와 구현 재량은 재질문하지 않으며, HUM 정의·상태를 임의로 폐기하거나 신규 UI를 Atlas에 승격하지 않았다 | owner의 후속 진행 요청, WM의 sibling 문서 경로 권고, PM 정책 초안과 분할 흐름 검토. Slack·Figma·Miro·Mozilla·VS Code 공식 패턴을 한정 적용. 신규 문서 후보 18·흐름 9·정책 묶음 7, 링크·anchor·표 검사 PASS; 정본 ID·route 검증 PASS. 상세 교환 열람과 답장 대상, 비교표 편집 대상의 구분은 리뷰 후 보완 | `UX-PROPOSED / POLICY-OPEN / STATIC-CHECKED` |
| `ATL-ED-0022` | 2026-09-06 | owner request / WM / PM / Main | 기존 README를 목적별 단일 독서 입구로 재배치하고 여섯 본문에 복귀 링크를 연결했다. 제품 질문·결정 상태는 HUM, 추천·대안은 UX 문서로 집중하고 HUM의 중복 기본안 설명을 링크로 치환했다. 시나리오 §10의 원 상황·공백·고유 검토 범위는 날짜가 있는 배경 기록으로 보존했다. 파일 추가·이동·병합 없이 구현 참고·백서·운영 자료를 기본 독서 경로 뒤로 정리했다 | WM의 README 유입·기존 slug 점검과 PM의 고유 질문 보존 검토. 기존 README anchor 10, needs 18, flow 9, policy 7과 정본 ID·route 보존, local link·표·diff 검사 PASS. 제품 정책·HUM 상태 변경 없음 | `ORGANIZED / CONTENT-PRESERVED / STATIC-CHECKED` |
| `ATL-ED-0023` | 2026-09-06 | owner request / WM / Main | 사용자 확인에 따라 구 Production v7·Vision v1·영문 백서를 작업 트리에서 삭제하고 Production v8만 현행 EG-Desk 백서로 유지했다. 현재 목차·소스 색인은 v8로 연결하고, 과거 ADR·조사·clean-room 근거는 당시 인용과 삭제 전 Git 원문 식별자를 보존했다. legacy WM 스냅샷은 과거 범위 표시를 유지한다 | 삭제 전 세 파일은 각각 HEAD의 Git blob과 일치. 원문 식별자는 ADR-002 References와 본 source boundary에 보존. v8 본문 변경 없음, 정본·링크·diff 검사 PASS; Git 이력 복구 가능 | `WHITEPAPERS-CONSOLIDATED / HISTORY-PRESERVED` |
| `ATL-ED-0024` | 2026-09-06 | owner request / WM / PM / Main | 국문 백서 3종의 설명 방식을 참고해 같은 Production v8 파일을 대외 독자용 10절로 재작성했다. 개발 전환 주석·저장소 경로·편집 지시·출처 미확인 통계·포괄적 성공/보안 보장·과거 출시 일정을 제거했다. 업무 경험·실행 원리·근거·Ontology·데이터 통제·도입 지원·협업·성과 조건을 설명하고 미결정 UI 기본값을 승격하지 않았다. 문체 조사와 검토 기록은 백서 밖 이 Governance에 보존했다 | §12.2 참고 범위, NIA·네이버클라우드 본문 출처 2개 원문 확인. PM 제품 정합성 PASS, 국문 편집 검토 5개 개선 후 PASS. 백서 목차·각주·표·유입 앵커·문서 링크 검사 및 diff check PASS. README와 현재 절 참조 갱신; 신규 백서 파일 없음 | `REWRITTEN / READER-VOICE-REVIEWED / STATIC-CHECKED` |
| `ATL-ED-0025` | 2026-09-08 | owner request / WM / PM / Main | 다중 PC·Canvas 기반 Board 방향을 Atlas·Contract·project context에 명시하고, live 실행과 파일 반출입을 분리했다. 실행 위치·연결 미확인·종료 요청/확인·늦은 결과·부분 완료·입력 복귀를 9개 UX 흐름과 정본에 연결했다. HUM의 중복 기술 질문을 좁히되 Library·그룹·구성 변경 권한·협업 충돌·소유권 이전의 고유 선택은 보존했다. PM 질문 85개를 §8.2의 10묶음으로 전수 분류하고 17개 Q 본문에서 확정 원칙과 남은 설계·검증을 구별했다 | 현재 작업 `01a07eba-ac3d-77c0-98ae-d13a39f9b949`의 다중 PC 방향과 문서 정제 진행 요청. §12.3 primary reference, WM 전수 route 확인, UX authoring 및 독립 의미 검토의 7개 교정 후 확인 범위 PASS. UX flow 9·policy 7·검증 계획 12, 정본 trace 43·HUM 18·Q 175·PM 85 전수 연결과 표·anchor·local link 검사 PASS. 실제 runtime·네트워크·접근성 준수 검증은 미실시; Q 상태 3 DECIDED / 172 OPEN과 정책 PROPOSED 유지 | `REFINED / POLICY-OPEN / STATIC-CHECKED / REVIEWED` |
| `ATL-ED-0026` | 2026-09-08 | owner request / WM / PM / user-role review / Main | 인계된 5범위의 추천·대안·조작·실패/취소/복귀를 UX·원장·Governance 3개 안에서 보완했다. Library·그룹·실행 소유, 설정 우선순위·사전 위임·실제 적용, 동시 변경·소유권 이전과 유효 복구 위임, Saved Board 자체 삭제·복구, 설정/연결/Profile/기록 초기화를 구별했다. 사용자 지적에 따라 배치도·기본/상세 노출·진입 클릭·혼잡 조건과 실대화 기반 역할 시뮬레이션을 추가했다 | 원 작업의 인계를 받은 `019f8d42-4886-7041-8421-c5e343d465e0`에서 진행. 처음의 UX-only 검토와 이후 6개 RWS·관련 ECS 직접 읽기를 구별했다. 역할 A/B의 8개 finding 반영·재검토, 삭제/초기화 5개 교정 재검토 PASS; PM의 기존 복구 위임 유효성 공백도 보완. UX 9흐름·9배치 노트·7정책·12검증 계획, 정본 43 trace·18 HUM·175 Q·PM 85 연결, ECS/CAP/RWS·link/anchor/table·diff 검사. 기존 시나리오 원본·백서·앱 코드 변경 없음. 실제 제품 실행 없이 문서상 사용 경로를 검토했으며 정책·Q 상태와 기존 승인 범위를 유지 | `REFINED / POLICY-OPEN / SCENARIO-WALKTHROUGH / STATIC-CHECKED` |
| `ATL-ED-0027` | 2026-09-08 | owner request / WM / 분할 설계 / 교차 검토 / Main | 사용자 결정만 남기라는 요청에 따라 175개 Q의 모든 하위 요구를 30개 화면 상세와 28개 구현 상세에 연결했다. 선택 전에도 각 정책 분기의 클릭·입력·보이는 배치·취소·복귀·처리·실패·인수 절차를 작성했다. 32개 RWS 전문 읽기와 관련 ECS를 분담하고 원사건·가정 UI·미실행 시험을 구분했다. 원장의 위임 설계 질문을 정리해 DESK 기존 결정, READ 설계 해소, OPEN 16개 정책 주제를 구별했다 | 초기 독립 감사 70건, 교차 검토의 추가 배치 충돌 1건, Atlas 전사 검토 6건을 각 수정·재검토했다. A54/B31/C39/D27/E24 전수 PASS. 132개 문장 정합화와 46개 추가 조작 전사를 거쳐, 후속 3건을 수정·재확인했다. 실행 시도 비교·원 Chat 답변 복귀·전송 전 설정 적용을 명시하고 최종 확인 PASS. 옛 Q-only 조작을 명시적 경로로 옮기고 Live/Snapshot·방/Profile·같은 Run·직접/제안 편집·저장 상태를 정합화했다. 43 trace·157 기본 행동·56 객체·28 tech anchor·18 HUM·175 Q·route 90/85·6 승인 gate·7 ECS·13 CAP·32 RWS 보존. 정본·사례·상호 링크·표·anchor·설계 완결·diff 검사 통과. 실제 제품 실행·runtime·네트워크·접근성 준수 시험 없음; 앱 코드·사례 원본·백서 변경 없음 | `DESIGN-REVIEWED / OWNER-POLICY-OPEN / IMPLEMENTATION-NOT-RUN / STATIC-CHECKED` |
| `ATL-ED-0028` | 2026-09-10 | owner input / WM source plan / Main | Chat 클릭의 콘텐츠 활성, 빈 Canvas 클릭의 해제, 비활성 Chat 위 두 손가락 Canvas pan, 시각 상태 구별을 Atlas·UX·Contract·원장에 반영했다. Pan 버튼을 기본 흐름의 필수 단계에서 분리하고 무조건적 위치 기반 입력 귀속을 해당 흐름에서 교정했다. 보조 드래그·키보드·Agent 입력권·다른 HUM 선택과 P0 원기록은 보존했다 | [사용자 결정과 범위](#owner-chat-canvas-input-20260910). 메모 사례의 긍정은 발견 성과로, 작성기 발언은 설명 요청으로 구분했다. Q-VIEW-04/08은 새 입력 규칙의 독립 재검토 대기로 전환. 새 규칙 재리허설·Firefox 실행·시각 시안 검증·Git commit/push는 하지 않음 | `OWNER-DECIDED / SPECIFIED / RE-REVIEW-PENDING / IMPLEMENTATION-NOT-RUN` |

| `ATL-ED-0029` | 2026-09-13 | owner feedback / WM route / PM delta review / Main | 최초 Browser 시작·기본 Codex·선택적 Agent, 실제 작업과 생각 기록의 표시, 산출물 문맥 경계, Agenda의 업무 구성 의미를 기존 문서에 반영. 명칭과 단일 로그인/프로필 자동 준비는 미결 후보로 보존 | 이 작업의 9/12–13 사용자 피드백과 문서 반영만 진행하라는 요청. 원격 f777e67·5d4537f를 fast-forward하여 TRI-02 기록 보존. HUM-AGENT 기본 사용은 결정, OPEN 정책 주제는 15개. 변경된 Q와 문서 지문은 재검토 대기. 시뮬레이션·앱 코드 변경·새 실행·commit/push 없음 | `DOC-REFLECTED / NAMING-OPEN / REVIEW-PENDING / SIMULATION-NOT-RUN` |

이력 행은 append-only다. 수정이 필요하면 기존 사건을 덮어쓰지 않고 다음 `ATL-ED-*` 행에서 정정·대체 관계를 남긴다.

## 15. Atlas coverage audit

<a id="doc-coverage-audit"></a>

### 15.1 Map → object → trace → question / approval

아래 Q 배정은 제품 동작을 빠짐없이 찾기 위한 1차 색인이다. 한 Q가 여러 지도 edge에 반복될 수 있지만, 이 열에서는 175개 Q를 정확히 한 번씩 배정한다.

| Map | 시작 → 끝 | 포함 object / 개념 | 연결 trace | 1차 배정 question | approval |
|---|---|---|---|---|---|
| M1 | OS 실행 → Desk 기본 표면 | EG-Desk, Firefox shell, Desk, Canvas, Sidebar, Saved Board; 별도 Workspace 노드는 없음 | L-01 | Q-LIFE-01, Q-LIFE-02, Q-LIFE-03, Q-LIFE-04, Q-OBJ-02 | — |
| M2 | 실행 중 Desk → 재실행 복원 | 자동 Desk 세션 기록, Saved Board 지속성, 보이는 표현 상태, view instance, resource/runtime/process; 정상 시작에는 유지·폐기 선택 항목이 없음 | L-02, L-03, SYS-01 | Q-LIFE-05, Q-RESTORE-01, Q-RESTORE-02, Q-RESTORE-03, Q-RESTORE-04, Q-RESTORE-05, Q-RESTORE-06, Q-RESTORE-07, Q-RESTORE-08 | — |
| M3 | resource entry → runtime evidence | resource entry, file/folder picker, locator, availability, authority, neutral view, view instance, resource runtime; Card는 compact 표현, Desk Window는 기존 별칭 | V-01, TOOL-02, BROWSER-03 | Q-VIEW-01, Q-VIEW-02, Q-VIEW-03, Q-VIEW-09, Q-VIEW-11 | — |
| M4 | Browser → Board 후보 | Browser, Firefox profile/container/account, content identity, locator, available action, SourceRef, evidence lineage, external-effect status, Board | TOOL-01, BROWSER-01, BROWSER-02, BROWSER-03, BROWSER-04 | Q-AUTH-01, Q-AUTH-02, Q-AUTH-03, Q-AUTH-04, Q-AUTH-05, Q-AUTH-07, Q-AUTH-08, Q-BROWSER-01, Q-BROWSER-02, Q-BROWSER-03 | — |
| M5 | Chat request → Desk projections | Chat, request, System context binding, context admission, Reader Session, Run binding, Agent runtime, Task/Result, Chat projection, Canvas projection | CHAT-01, AI-01, AI-02, READ-01, READ-02, READ-03 | Q-AI-01, Q-AI-02, Q-AI-03, Q-AI-04, Q-AI-05, Q-AI-10, Q-AI-11, Q-OBJ-07, Q-AGENT-18 | — |
| M5-F | tool observation → Snapshot/Live Canvas | raw/source capture, direct result 또는 Reader Context Packet, Agent-delivered payload, Snapshot View, current source, Live View, diff | AI-01, READ-01, READ-02, READ-03, AI-04 | — | — |
| M6 | Profile/request/context 등 → Run | Agent 표시 정체성, Profile revision, Engine Profile와 실제 account/plan, personality/instruction/policy, requested/resolved model, tool capability·availability, credential binding, authority, approval, context·memory, Ontology version, budget/sandbox, immutable Run configuration, audit lineage | AGENT-01, AGENT-02, AGENT-03, ENGINE-01, AI-01, AI-02, AI-06, AUTH-01, ONT-02 | Q-AI-07, Q-AI-08, Q-AI-09, Q-AGENT-01, Q-AGENT-02, Q-AGENT-03, Q-AGENT-04, Q-AGENT-05, Q-AGENT-06, Q-AGENT-07, Q-AGENT-08, Q-AGENT-09, Q-AGENT-10, Q-AGENT-11, Q-AGENT-12, Q-AGENT-13, Q-AGENT-14, Q-AGENT-15, Q-AGENT-16, Q-AGENT-17 | A-AUTH-01, A-AUTH-02, A-AUTH-03, A-INFRA-01, A-INFRA-02, A-INFRA-03 |
| M7 | Answer → 다음 Chat | Answer, Chat projection, Canvas projection, Answer Briefing, Briefing Step, Focus Scope, Briefing Comment; 결과 칩은 비객체 어포던스 후보 | AI-04, AI-05, CHAT-01 | Q-MEDIA-01, Q-MEDIA-02, Q-MEDIA-03, Q-MEDIA-04, Q-MEDIA-05, Q-MEDIA-07, Q-MEDIA-08, Q-MEDIA-09, Q-MEDIA-10, Q-MEDIA-11, Q-MEDIA-12 | — |
| M8 | request → 종속 task 시작·종합 | Run/Task/Result/Answer, task graph, parallel Agent, dependency state, evidence; 별도 일반 Token 객체는 없음 | AI-06 | Q-ORCH-01, Q-ORCH-02, Q-ORCH-04, Q-ORCH-08 | — |
| M9 | 외부 경계 → 결정·실행·검증 | approval decision record, affected/independent branch, provider execution status, independent success evidence | AI-07, AUTH-01, BROWSER-02, BROWSER-04 | Q-ORCH-03, Q-ORCH-05, Q-ORCH-06, Q-ORCH-07, Q-AUTH-06 | A-AUTH-01, A-AUTH-02, A-AUTH-03, A-INFRA-01, A-INFRA-02, A-INFRA-03 |
| M10 | project → 검증 결과 | project, folder, file, tree/search, editor/viewer, working change, diff, review decision, saved revision, Result, optional Terminal | TOOL-02, CODE-01, TERM-01 | Q-CODE-01, Q-CODE-02, Q-CODE-03, Q-CODE-04, Q-CODE-05, Q-CODE-06, Q-CODE-07, Q-CODE-08, Q-CODE-09 | — |
| M11 | managed Ontology → evidence·inspection | Ontology, managed version, Agent cycle, transition, evidence, Ontology view projection, governance action | ONT-01, ONT-02 | Q-ONT-01, Q-ONT-02, Q-ONT-03, Q-ONT-04, Q-ONT-05 | — |
| M12-L | local computer-use → 관찰·검증 | local request, target app/window, input ownership, Desk-visible observation, pause/stop, independent result verification | CU-01 | Q-CU-01, Q-CU-02, Q-CU-03, Q-CU-05, Q-CU-06, Q-CU-08, Q-CU-09 | — |
| M12-R | shared Desk → 선택적 원격 관찰 | shared Desk, collaborator, identity, permission, action availability, shared resource, optional remote observation/control | COL-01, CU-01 | Q-COL-01, Q-COL-02, Q-COL-03, Q-COL-04, Q-COL-05, Q-COL-06, Q-COL-07, Q-COL-08, Q-COL-09, Q-COL-10, Q-CU-04, Q-CU-07 | A-INFRA-01, A-INFRA-02 |
| M13 | local settings → local/remote evidence | settings, local data/state, export artifact, restore, remote sync, remote backup, provider status, result evidence | DATA-01 | Q-DATA-01, Q-DATA-02, Q-DATA-03, Q-DATA-04, Q-DATA-05, Q-DATA-06, Q-DATA-07, Q-DATA-08, Q-DATA-09 | A-INFRA-03 |
| M14 | Desk intent → Board lifecycle end | Board, Saved Board, Sidebar row, revision, opened projection, save-as/update, archive/close, delete/recovery | AG-01, AG-02, AG-03, AG-04 | Q-AG-01, Q-AG-02, Q-AG-03, Q-AG-04, Q-AG-05, Q-AG-06, Q-AG-07, Q-AG-08, Q-AG-09, Q-AG-10, Q-AG-11, Q-AG-12, Q-AG-13, Q-AG-14, Q-AG-15, Q-AG-16, Q-AG-17, Q-AG-19, Q-AG-20, Q-OBJ-01, Q-OBJ-04 | — |
| M15 | Canvas viewport → target focus/open | Canvas viewport, view, Card/Desk Window 명칭 후보, geometry/group, search, Library 후보, result focus | V-01, V-02, V-03, DISC-01 | Q-VIEW-04, Q-VIEW-05, Q-VIEW-06, Q-VIEW-07, Q-VIEW-08, Q-VIEW-10, Q-VIEW-12, Q-VIEW-13, Q-DISC-01, Q-DISC-02, Q-DISC-03, Q-LIB-01, Q-OBJ-03, Q-OBJ-05 | — |
| M16 | Agent room entry → reentry / 공유 대화 형식 후보 | Agent/persona 담당자 방, conversation projection, composer, request, Answer projection, 업무별 공유 대화·참여·전달 범위 | CHAT-01, AI-01, AI-03 | Q-CHAT-01, Q-CHAT-02, Q-CHAT-03, Q-AI-06, Q-AI-12, Q-AI-13, Q-OBJ-06 | — |
| M17 | Terminal entry → 재진입 분류 | Terminal view, bridge/helper/transport/provider conversation 경계, process identity/liveness, snapshot, reconnect/new process/unavailable | L-02, TERM-01, SYS-01 | Q-TERM-01, Q-TERM-02, Q-TERM-03, Q-TERM-04, Q-TERM-05, Q-AGENT-20 | — |
| M18 | Canvas target·position → annotation 재진입 | visual mark, anchored Canvas Memo, 분리된 작성자·Agent reply, Agent room reference, provenance, acceptance와 persistence | CANVAS-01 | Q-MEDIA-06, Q-MEDIA-13 | — |
| M19 | keyboard entry → 상태·다음 행동 | focus, input owner, keyboard/accessibility path, nonvisual Canvas/Answer Briefing, reduced motion, 반복 가능한 성공·복구 acceptance | UX-01 및 43개 trace 횡단 | Q-UX-01, Q-UX-02, Q-UX-03, Q-UX-04, Q-AGENT-19 | — |

### 15.2 커버리지 결론

- Aspect map: 21개.
- trace: 43/43개가 map과 전수 색인에 포함됨.
- 전체 question: 결정 여부와 무관하게 175/175개가 coverage matrix의 1차 배정에 포함됨.
- approval gate: 6/6개가 승인 edge와 matrix에 포함됨.
- 확정·일부 결정 필요·runtime-only·비객체 개념은 모두 적어도 하나의 map 또는 object coverage 행에 포함됨.
- 지도 어디에도 별도 Workspace, 일반 대기 Token 또는 고정된 외부 관찰 화면 이름을 제품 객체로 두지 않았고, Chat과 Agent runtime 사이에는 System binding이 유지됨.

<a id="doc-question-registry"></a>

## 16. 세부 UI 연구와 `Q-*` registry

아래 175개 `Q-*`는 처음 제기한 질문의 본문과 연결을 보존한 색인이다. 질문 안의
‘남은 설계·검증’·‘미정’·‘정해야 할’은 당시의 표현이며 현재 상태가 아니다.
현재의 답·상세 조작·기술 방법·검토 결과는 [설계 점검표](#design-closure-status)가 정본이다.
제품 소유자가 175개를 다시 답할 필요는 없다. 남은 제품 선택은
[사용자 확인 목록의 OPEN 15개 주제](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#gap-owner-queue)에만 있다.
18개 HUM 앵커 중 Desk·기본 Codex 사용은 결정 이력, Smart Read는 위임 설계로 해소한 이력이다.

| 이 절의 Q 묶음 | 상위 사용자 결정 |
|---|---|
| Desk·Board 객체와 수명주기 | [HUM-DESK-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-desk-001), [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) |
| Desk 화면·리소스 탐색·Terminal | [HUM-SURFACE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001) |
| Chat·DM·공유 대화 | [HUM-CONV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-conv-001) |
| 요청·Result·논리적 Answer·매체 표현 | [HUM-ANSWER-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-answer-001) |
| Answer Briefing | [HUM-BRIEF-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-brief-001) |
| Smart Read·Snapshot | [HUM-READ-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-read-001), [HUM-SNAPSHOT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-snapshot-001) |
| Agent·Profile·Run·AI Engine | [HUM-AGENT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agent-001), [HUM-RUN-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001), [HUM-ENGINE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-engine-001) |
| Task graph·dependency·approval·integration | [HUM-ORCH-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001) |
| 사람 대상 코딩 | [HUM-CODE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-code-001) |
| 내보내기·보존 | [HUM-EXPORT-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-export-001) |
| Ontology governance | [HUM-GOV-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-gov-001) |
| 협업·computer-use·원격 인프라 | [HUM-COLLAB-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001), [HUM-REMOTE-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-remote-001) |
| 접근성 기준선 | [HUM-A11Y-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-a11y-001) |

### 객체 및 화면 모델

| ID | 최초 점검 질문 — 현재 답·상태는 §8.3 | 영향받는 흐름 |
|---|---|---|
| <a id="atlas-q-obj-01"></a>`Q-OBJ-01` | **결정됨** — 기본 제품 모델은 하나의 Desk다. 다중 Desk를 Board 분리나 메모리 최적화 수단으로 도입하지 않는다. | AG-02, COL-01, DATA-01 |
| <a id="atlas-q-obj-02"></a>`Q-OBJ-02` | **결정됨** — Desk에는 하나의 Canvas가 속한다. 사용자나 Agent의 의미 있는 활성·sleeping·snapshot 작업은 그 Canvas에서 찾을 수 있는 표현을 가진다. | L-01, L-02, V-02, V-03 |
| <a id="atlas-q-obj-03"></a>`Q-OBJ-03` | 활성 화면을 Card, Desk Window, View라고 부르는가, 아니면 각각 별개의 개념인가? Card는 구체적으로 무엇을 의미하는가? | 모든 리소스/뷰 흐름 |
| <a id="atlas-q-obj-04"></a>`Q-OBJ-04` | **확정 경계**: 하나의 Canvas에 여러 Saved Board projection을 동시에 열 수 있다. **남은 질문**: Board projection의 시각적 경계, 겹침 회피, 활성 Board 표시와 여러 Board에 걸친 view의 귀속을 어떻게 보여 주는가? | AG-02, AG-03, V-02 |
| <a id="atlas-q-obj-05"></a>`Q-OBJ-05` | Library는 최종적으로 일급 제품 영역인가? 그곳에는 저장된 Board, 파일 또는 출력과 구분하여 무엇이 속하는가? | DISC-01, DATA-01 |
| <a id="atlas-q-obj-06"></a>`Q-OBJ-06` | Agent/persona별 담당자 방과 별도로 여러 사람·Agent가 참여하는 공유 작업 대화 capability의 최종 형식은 workroom, 일반 Thread, Board-linked conversation 또는 다른 Chat relation 중 무엇인가? 선택한 형식에서 참여자·소유권·지속성·개인정보·Board 관계와 생성·열기·공유·재진입 UI는 어떻게 동작하는가? | AI-03, COL-01 |
| <a id="atlas-q-obj-07"></a>`Q-OBJ-07` | 하나의 제품 사용자 요청 아래에서 Run, Task, Agent 기여, 통합 Result, 하나의 논리적 Answer, 매체별 표현, 산출물의 동일성·다중성·사용자 대상 명칭은 각각 무엇인가? Chat과 Canvas가 같은 Answer를 표현한다는 관계는 다시 열지 않는다. | AI-01, AI-04, AI-06 |

### 실행 및 복구

| ID | 최초 점검 질문 — 현재 답·상태는 §8.3 | 영향받는 흐름 |
|---|---|---|
| <a id="atlas-q-life-01"></a>`Q-LIFE-01` | 어떤 운영체제 실행 진입점 변형을 문서화하고 테스트하는가? | L-01, L-02 |
| <a id="atlas-q-life-02"></a>`Q-LIFE-02` | 프로세스 시작부터 사용할 수 있는 Desk가 나타나기까지 포커스 및 접근성 알림을 포함하여 무엇이 표시되는가? | L-01 |
| <a id="atlas-q-life-03"></a>`Q-LIFE-03` | 셸 자체를 시작할 수 없을 때 정확히 어떤 UI와 다음 행동이 표시되는가? | L-01 |
| <a id="atlas-q-life-04"></a>`Q-LIFE-04` | 최초 사용/빈 Desk와 저장된 Board가 하나도 없는 사이드바에는 무엇이 표시되며, 정확히 어떤 행동이 제공되는가? | L-01 |
| <a id="atlas-q-life-05"></a>`Q-LIFE-05` | 표시되는 운영체제, 창 및 앱 메뉴의 종료 행동 가운데 무엇을 지원하며, 어떤 포커스/확인 동작이 앱 종료와 뷰 닫기를 구분하는가? | L-03 |
| <a id="atlas-q-restore-01"></a>`Q-RESTORE-01` | **확정 경계**: 실제 Desk를 먼저 사용할 수 있고 Board 목록은 독립적으로 로드된다. **남은 설계·검증**: 한쪽 지연·실패 표시, 재시도와 이미 사용 중인 view 보존. 두 로딩의 완료 순서를 다시 결정받지 않는다. | L-02 |
| <a id="atlas-q-restore-02"></a>`Q-RESTORE-02` | 열려 있던 뷰, 위치와 크기, 그룹화, Canvas 이동/확대·축소, 저장되지 않은 편집기 콘텐츠, 채팅 및 일시적 출력 중 어떤 세션 세부 정보가 복원되는가? File view의 active caret·keyboard focus·transient text selection은 복원하지 않으며, scroll·보이는 위치와 명시적으로 고정한 annotation/range만 별도 정책에 따라 복원할 수 있다. | L-02, V-02, V-03 |
| <a id="atlas-q-restore-03"></a>`Q-RESTORE-03` | 누락되었거나, 거부되었거나, 손상되었거나, 오프라인이거나, 부분적으로 복원된 리소스를 정확히 어떤 뷰별 UI와 목록 수준 UI로 처리하는가? | L-02 |
| <a id="atlas-q-restore-04"></a>`Q-RESTORE-04` | Browser가 아닌 각 화면은 실행 중인 런타임과의 연결, 재구성된 뷰, 스냅샷 또는 명시적인 사용 불가 상태 중 무엇으로 복원되어야 하는가? | L-02, TERM-01 |
| <a id="atlas-q-restore-05"></a>`Q-RESTORE-05` | 정상 종료, 앱 충돌, 운영체제 재시작, 강제 종료 및 손상된 세션 기록으로부터의 복구 후에는 무엇이 달라지는가? | L-02 |
| <a id="atlas-q-restore-06"></a>`Q-RESTORE-06` | 저장된 Board 목록을 읽을 수 없을 때 정확히 어떤 사이드바 UI, 재시도 행동 및 영향받지 않은 Desk의 동작이 나타나는가? | L-02 |
| <a id="atlas-q-restore-07"></a>`Q-RESTORE-07` | 어떤 이벤트와 트랜잭션 주기로 자동 Desk 세션 기록을 업데이트하고, 쓰기 상태를 어떻게 표시하며, 쓰기 실패 후 정확히 어떤 재시도/진단 행동이 이어지는가? | L-03 |
| <a id="atlas-q-restore-08"></a>`Q-RESTORE-08` | 진행 중인 쓰기를 정상 종료, 충돌 및 강제 종료 시 각각 어떻게 플러시하거나 롤백하는가? 마지막 유효 기록은 어떻게 선택하는가? 그리고 유효하지 않은 기록 후에는 정확히 어떤 복구 행동이 이어지는가? | L-03 |

### Board 수명 주기

| ID | 최초 점검 질문 — 현재 답·상태는 §8.3 | 영향받는 흐름 |
|---|---|---|
| <a id="atlas-q-ag-01"></a>`Q-AG-01` | 새 Board는 빈 상태, 현재 Desk에서 명시적으로 선택한 항목 또는 별도로 정의된 범위 중 어디에서 시작하는가? 사용자가 구성원 포함 여부를 확인하기 전에 어떤 컨텍스트를 미리 채울 수 있는가? | AG-01 |
| <a id="atlas-q-ag-02"></a>`Q-AG-02` | 어떤 필드와 리소스/컨텍스트/실행 환경 구성원이 Board를 이루며, 그중 무엇이 필수인가? | AG-01 |
| <a id="atlas-q-ag-03"></a>`Q-AG-03` | 저장된 Board 행의 정확한 상호작용, 키보드 동작, 컨텍스트 메뉴 및 선택과 활성화의 구분 | AG-02 |
| <a id="atlas-q-ag-04"></a>`Q-AG-04` | 활성화된 Board 행과 해당 Canvas 영역에 대한 Pending/open/partial/success 피드백 | AG-02 |
| <a id="atlas-q-ag-05"></a>`Q-AG-05` | 누락되었거나, 접근이 권한상 허용되지 않았거나, 현재 기준 또는 대상과 불일치하거나, 부분적으로만 사용 가능한 Board 구성원을 위한 정확한 UI | AG-02 |
| <a id="atlas-q-ag-06"></a>`Q-AG-06` | **결정됨** — 저장된 Board를 열면 기존 내용을 교체하거나 새 Desk를 만들지 않고 하나의 Canvas에 Board projection을 추가하거나 이미 열린 projection에 포커스한다. 정확한 초기 위치·겹침 회피·포커스 피드백은 `Q-AG-04`와 `Q-OBJ-04`가 다룬다. | AG-02 |
| <a id="atlas-q-ag-07"></a>`Q-AG-07` | Board 객체의 동일성, 대상 리비전 및 현재 Desk와의 관계 측면에서 최초 저장, 새 항목으로 저장 및 업데이트가 각각 무엇을 의미하는가? | AG-03 |
| <a id="atlas-q-ag-08"></a>`Q-AG-08` | 어떤 뷰, 리소스, 컨텍스트, 레이아웃, 출력 및 실행/워크플로 상태가 저장된 Board 리비전에 속하는가? | AG-03 |
| <a id="atlas-q-ag-09"></a>`Q-AG-09` | 저장된 Board 행의 정확한 행동 메뉴 트리거, 이름 변경 편집기, 유효성 검사, 확정/취소 컨트롤 및 포커스 복귀 | AG-04 |
| <a id="atlas-q-ag-10"></a>`Q-AG-10` | 정확한 생성 화면, 초기 포커스, 필드/구성원 유효성 검사, 취소 시 복귀, 성공 피드백 및 초안을 보존하는 영속화 실패 UI | AG-01 |
| <a id="atlas-q-ag-11"></a>`Q-AG-11` | **확정 경계**: Board 닫기는 Canvas projection을 제거하고 그 Board만 소유한 runtime을 종료하며 Saved Board는 Sidebar에 보존한다. **남은 질문**: 보관의 별도 의미, 공유 runtime의 소유권 표시, 정확한 다시 열기·보관 해제 상호작용은 무엇인가? | AG-04 |
| <a id="atlas-q-ag-12"></a>`Q-AG-12` | **비교안 준비**: [Saved Board 삭제·복구](../references/design-synthesis/egdesk-ux-realization-proposals.md#agenda-delete-recover)에 저장본·전용/공유 실행·참조·휴지통·영구 삭제 영향을 구분했다. **남은 선택**: HUM-AGENDA-001의 보관 기한·복구 범위이며 예약 삭제로 대신하지 않는다. | AG-04 |
| <a id="atlas-q-ag-13"></a>`Q-AG-13` | 정확한 Board 생성 진입 화면, 표시되는 레이블/아이콘, 클릭 및 키보드 제스처, 그리고 생성 화면으로 들어갈 때의 포커스 전환 | AG-01 |
| <a id="atlas-q-ag-14"></a>`Q-AG-14` | **설계안 준비**: UX Board 흐름의 저장 범위 미리보기·업데이트·다른 이름 저장·취소·복귀. **남은 설계·검증**: 동시 revision 변경·저장 실패·사용 불가 사유. 기본 저장 범위만 HUM-AGENDA-001에 종속된다. | AG-03 |
| <a id="atlas-q-ag-15"></a>`Q-AG-15` | 저장됨/변경 있음 상태를 구분하는 정확한 표시와 다시 저장, 나가기, 현재 변경 사항 폐기, 취소 및 화면 이탈 방지 상호작용 | AG-03 |
| <a id="atlas-q-ag-16"></a>`Q-AG-16` | Board 리비전/충돌 의미 체계: 덮어쓰기와 새 리비전의 구분, 기준 리비전이 최신이 아님을 감지하는 방식, 병합 가능 여부, 이력 보존 및 정본으로 인정되는 결과 | AG-03 |
| <a id="atlas-q-ag-17"></a>`Q-AG-17` | 정확한 최신이 아닌 리비전/충돌 표시, 비교/병합/덮어쓰기/새 항목으로 저장/취소 컨트롤, 영속화 실패, 재시도 및 초안 보존 | AG-03 |
| <a id="atlas-q-ag-19"></a>`Q-AG-19` | **확정 경계**: 닫기는 전용 실행 종료 확인까지 상태를 보존하고 Saved Board를 삭제하지 않는다. **남은 설계·검증**: 영향 미리보기·원격 미확인·종료 실패·재열기·키보드 복귀. 보관·예약·복구 기본값만 연결된 HUM에 종속된다. | AG-04 |
| <a id="atlas-q-ag-20"></a>`Q-AG-20` | **설계안 준비**: [삭제·복구 분기](../references/design-synthesis/egdesk-ux-realization-proposals.md#agenda-delete-recover)의 Sidebar 진입·범위 확인·삭제 중단·복구·목록 복귀. **남은 검증**: 동시 저장·종료 미확인·이동 실패·영구 삭제 일부 실패·권한 철회·키보드 경로. | AG-04 |

### 뷰, Canvas 및 탐색

| ID | 최초 점검 질문 — 현재 답·상태는 §8.3 | 영향받는 흐름 |
|---|---|---|
| <a id="atlas-q-view-01"></a>`Q-VIEW-01` | 리소스를 여는 최종 방식: 사이드바, Library, 파일 선택기, 끌어다 놓기, 명령 팔레트, Chat 링크, Canvas 행동 또는 기타 진입점 | V-01 |
| <a id="atlas-q-view-02"></a>`Q-VIEW-02` | 열기 피드백, 초기 배치/크기/포커스, 중복 리소스 동작 및 키보드 경로 | V-01 |
| <a id="atlas-q-view-03"></a>`Q-VIEW-03` | 정확한 사용 불가/미지원/권한 거부 UI 및 다음 행동 | V-01 |
| <a id="atlas-q-view-04"></a>`Q-VIEW-04` | **확정 경계**: 카메라 이동·배치 선택·콘텐츠 활성·키보드 focus와 실제 view resize는 다르다. Chat 클릭의 활성 표시와 빈 Canvas 클릭의 활성 해제를 [사용자 결정](#owner-chat-canvas-input-20260910)으로 반영했다. **남은 설계·검증**: 새 입력 전환의 독립 재검토, 포인터·트랙패드·키보드·드래그 없는 대안, 스냅·충돌·경계와 resize 후 재관찰. | V-02 |
| <a id="atlas-q-view-05"></a>`Q-VIEW-05` | 임시 그룹화와 Board 구성원 포함의 의미 차이, 그룹화의 지속 여부 및 중첩 그룹 허용 여부 | V-02 |
| <a id="atlas-q-view-06"></a>`Q-VIEW-06` | **확정 경계**: 탭/view bar 더블클릭은 기존 비율을 유지한 집중 보기다. **남은 질문**: Browser 내부 viewport·responsive layout 변경 여부, Canvas zoom·resize·page zoom과의 구분, 다른 전체 화면 모드와의 관계, 유지되는 UI와 원 시점 복귀 | V-02 |
| <a id="atlas-q-view-07"></a>`Q-VIEW-07` | **확정 경계**: Canvas viewport 밖 이동은 닫기나 suspend가 아니며 lifecycle은 view/runtime별로 판단한다. Board 닫기는 그 Board만 소유한 runtime을 종료한다. **남은 질문**: 단일 뷰 닫기, Board에서 뷰 제거, 공유 runtime 분리와 기반 resource/process 종료를 어떤 컨트롤로 구분하는가? | V-02, TERM-01 |
| <a id="atlas-q-view-08"></a>`Q-VIEW-08` | **확정 경계**: pan·zoom은 Agent 실행 대상을 바꾸지 않는다. 빈 Canvas 클릭 뒤에는 hover로 Chat을 재활성화하지 않고 그 위에서도 두 손가락 pan을 수행하며 별도 Pan 버튼을 필수로 요구하지 않는다. **남은 설계·검증**: [새 입력 결정](#owner-chat-canvas-input-20260910)의 독립 재검토와 미니맵·경계·복귀 위치·모션 감소·비공간 대안. 저장되는 시점 범위는 Board/session 정책에 연결한다. | V-03 |
| <a id="atlas-q-view-09"></a>`Q-VIEW-09` | 각 리소스 유형에서 어떤 컨트롤이 네이티브이고 어떤 컨트롤이 맞춤 조정된 것인지, 입력을 누가 소유하는지, 어떤 화면상 확인 증거가 성공을 입증하는지, 그리고 어떤 리소스별 흐름이 실패/복구를 정의하는가? | V-01 |
| <a id="atlas-q-view-10"></a>`Q-VIEW-10` | 정확한 다중 선택, 그룹화, 그룹 해제, 그룹 들어가기/나오기, 키보드/포커스, 사용 불가, 실패 및 실행 취소 상호작용 | L-03, V-02 |
| <a id="atlas-q-view-11"></a>`Q-VIEW-11` | 승인된 모든 리소스 진입 화면의 정확한 컨트롤/레이블, 대상 선택, 클릭/키보드/드롭 제스처, 열기와 포커스 행동의 구분, 중복 처리, 대기/오류 상태 및 포커스 복귀 | V-01 |
| <a id="atlas-q-view-12"></a>`Q-VIEW-12` | **설계안 준비**: 비율 유지 집중 보기와 원 위치 복귀. **남은 설계·검증**: OS 전체 화면과의 구분, Esc 우선순위·대상 닫힘·실패·focus 복귀. 확대만으로 내부 layout이나 실행 대상을 바꾸지 않는다. | V-02 |
| <a id="atlas-q-view-13"></a>`Q-VIEW-13` | 정확한 뷰 닫기 컨트롤, 저장되지 않았거나 실행 중인 리소스의 확인, 취소/강제 선택, 닫기 실패, 키보드 경로 및 성공 또는 취소 후 포커스가 이동할 위치 | V-02 |
| <a id="atlas-q-disc-01"></a>`Q-DISC-01` | 전역 검색, Canvas 찾기, Board 검색, Library 검색 및 명령 팔레트 가운데 무엇이 서로 구별되는 화면인가? | V-03, DISC-01 |
| <a id="atlas-q-disc-02"></a>`Q-DISC-02` | 정확한 검색어 입력, 필터/범위/지우기 컨트롤, 진행 상태, 결과 유형/순위, 결과 없음/최신 상태가 아닌 결과 상태, 결과 포커스/열기 동작 및 개인정보 보호 경계 | V-03, DISC-01 |
| <a id="atlas-q-disc-03"></a>`Q-DISC-03` | 승인된 각 검색 화면의 정확한 진입 위치, 레이블/아이콘, 단축키, 클릭/키보드 행동, 초기 포커스, 범위 표시기, 닫기 및 포커스 복귀 동작 | V-03 |
| <a id="atlas-q-lib-01"></a>`Q-LIB-01` | Library가 승인되는 경우 정확한 진입 화면, 레이블/아이콘, 클릭/키보드 행동, 초기 포커스, 사용 불가 상태, 닫기 및 복귀 동작 | DISC-01 |

### 인공지능 요청, 대화 및 답변 미디어

| ID | 최초 점검 질문 — 현재 답·상태는 §8.3 | 영향받는 흐름 |
|---|---|---|
| <a id="atlas-q-chat-01"></a>`Q-CHAT-01` | **확정 경계**: 사람에게 보이는 기본 Chat 관계는 Agent/persona별 담당자 방이다. **남은 질문**: 같은 Agent 방 안에서 여러 업무를 어떻게 구분·재진입하고, Agent끼리 위임한 대화·진행 상태를 별도 workroom/supervision 화면 및 공유 대화와 어떻게 연결하는가? | CHAT-01, AI-03 |
| <a id="atlas-q-chat-02"></a>`Q-CHAT-02` | Dock의 정확한 Chat 아이콘·레이블과 Canvas에 열리는 Agent 방의 header·avatar·이름·message bubble 작성자, Agent 방 전환·설정 진입, message timeline, 요청 컨텍스트 영역, 작성기, 보내기, 활동 표시, Canvas 상태 연결, 중지, 키보드·포커스·빈 상태·이용 불가·재진입 동작 | CHAT-01 |
| <a id="atlas-q-chat-03"></a>`Q-CHAT-03` | Chat 기록, 초안 텍스트, 첨부 파일, 컨텍스트 참조, 작업/결과 상태 및 스크롤/포커스 상태 중 무엇이 닫기와 재시작 후에도 지속되는가? | CHAT-01, AI-05 |
| <a id="atlas-q-ai-01"></a>`Q-AI-01` | 어떤 제품 화면에서 Agent 요청을 시작할 수 있으며, 각 화면은 어떤 초안/첨부 파일/컨텍스트 대상 유형을 지원하는가? | CHAT-01, AI-01, CODE-01 |
| <a id="atlas-q-ai-02"></a>`Q-AI-02` | **설계안 준비**: UX 공통 입력의 전송·줄바꿈·중지와 담당 업무 표시. **남은 설계·검증**: IME 조합 확정, 연속 입력·중복 제출·수락 전 실패·늦은 수락, 요청과 초안 보존. 중지 요청을 종료 확인으로 표시하지 않는다. | CHAT-01, AI-01 |
| <a id="atlas-q-ai-03"></a>`Q-AI-03` | 선택한 컨텍스트를 미리 보거나 수정해야 할 때 기본적으로 어떤 컨텍스트 사실이 표시되며, 어떤 민감한 범위 변경에 새로운 권한 결정이 필요한가? | AI-01, AI-02 |
| <a id="atlas-q-ai-04"></a>`Q-AI-04` | 제품 Task의 정본 상태 `queued`, `waiting-on-dependency`, `ready`, `running`, `approval-required`, `completed`, `failed`, `cancelled` 각각을 어떤 레이블·표시기·원인·시간과 다음 컨트롤로 보여 주는가? Chat의 `Agent 작업 중` `[ · · · ]` 애니메이션과 접근성 텍스트는 model/tool/Reader lifecycle을 어떻게 요약하는가? 클릭 시 Snapshot View에서 direct tool의 완전한 명명 결과 또는 Smart Read의 `[원본 캡처] [이 Agent에게 전달된 내용] [변환 관계]`를 어떻게 구분하며, `[현재 열기]`로 별도 Live View를 열고 `[비교]`로 역사적·현재 상태를 나란히 놓는 정확한 viewer·레이블·키보드·포커스·권한 거부 UI는 무엇인가? Snapshot View와 Live View가 별도 identity로 공존하고, direct 결과 뒤의 무표시 생략과 Smart Read lineage 은폐를 허용하지 않는 경계는 다시 열지 않는다. snapshot을 어느 기간·범위로 보존하고 secret·redaction·삭제 정책 때문에 열 수 없을 때 어떤 상태와 manifest/hash를 남기는가? 사용자 중지·재시도·timeout이 어느 Task 전이를 만들고, `partial`은 Task 상태가 아닌 여러 Task의 Result 종합 상태로 어디에 표시하며, Run 수명주기와 어떻게 구분하는가? | AI-01, READ-01, READ-02, AI-06 |
| <a id="atlas-q-ai-05"></a>`Q-AI-05` | **확정 경계**: 사용자 조정·도구 관찰·관련 자료 변화는 같은 Run의 가능한 가장 이른 다음 모델 호출에 반영하며 과거 입력은 보존한다. 일반적인 조정에는 재시작·새 attempt·fork가 필요하지 않다. **남은 질문**: 조정 수신과 실제 반영 상태, 여러 동시 업무 중 적용 대상, 앞으로의 context 제외와 과거 전달 기록의 차이를 어떤 UI로 표현하는가? | AI-02 |
| <a id="atlas-q-ai-06"></a>`Q-AI-06` | Agent 담당자 방과 공유 workroom/Thread의 생성·참여자·Board 관계·지속성·개인정보·작업 권한 및 이전 대화·Memo reference·컨텍스트가 전송될 수 있는 범위 | AI-03 |
| <a id="atlas-q-ai-07"></a>`Q-AI-07` | 어떤 Agent/제공자/프로필 선택지가 사용자에게 표시되며, 그중 하나를 선택할 때 어떤 기능/구성 정보가 반드시 보여야 하는가? | AI-01, AI-03, AI-06 |
| <a id="atlas-q-ai-08"></a>`Q-AI-08` | Agent 경로 지정 선택은 작업, 대화, Board 또는 앱 범위별로 어떻게 지속되며, 사용자는 언제 자동 경로 지정을 검사하거나 재정의할 수 있는가? | AI-01, AI-03, AI-06 |
| <a id="atlas-q-ai-09"></a>`Q-AI-09` | 각 Agent 또는 오케스트레이션하는 Agent가 어떤 작업 위임 권한을 받고 다른 Agent에게 넘길 수 있으며, 그 권한을 승인 없이 확장해서는 안 되는가? | AI-01, AI-03, AI-06, AUTH-01 |
| <a id="atlas-q-ai-10"></a>`Q-AI-10` | 승인된 모든 요청 진입 화면의 정확한 포커스/입력/편집/첨부 파일/컨텍스트 대상/취소 컨트롤, 키보드 경로, 초안 유효성 검사, 실패 상태 및 포커스 복귀 | AI-01, AI-04, CANVAS-01, CU-01 |
| <a id="atlas-q-ai-11"></a>`Q-AI-11` | Chat 작성기 위 요청 컨텍스트 영역의 context item 형태와 `[× 제거]`, item click 검사, `[이 요청에서 포함/제외]`, `[대상 추가]`, Board 연결, 권한 축소, 선택 이유, 유효성 검사, `[적용] [취소]`, `[Esc]`, 키보드 순서와 작성기 포커스 복귀의 정확한 UI | AI-02 |
| <a id="atlas-q-ai-12"></a>`Q-AI-12` | 정확한 Agent 방 전환과 공유 workroom/Thread 생성·열기·선택, 참여자·위임 관계 표시, 작성기, 보내기/위임, 중지/재시도, 키보드/포커스, 실패 및 재진입 컨트롤 | AI-03 |
| <a id="atlas-q-ai-13"></a>`Q-AI-13` | 정확한 컨텍스트 공유 진입점, 출처/대상/콘텐츠/참여자 선택, 미리보기, 확인/취소, 중복/개인정보 보호 경고, 실행 취소, 실패 및 포커스 복귀 | AI-03 |
| <a id="atlas-q-media-01"></a>`Q-MEDIA-01` | Agent가 답변 의미와 산출물 유형에 맞는 매체 구성을 제안하고 System이 지원·권한·렌더 상태를 검증한다는 전제에서, 어떤 Agent Observation Snapshot과 고정된 파생 산출물을 Answer의 비교·근거·표·원자료 report set로 선별하며 제품 사용자는 언제 이를 재정의할 수 있는가? 원자료는 도구 호출 당시의 읽기 전용 Snapshot View로 열리고, 파생 표·요약·차트는 해당 snapshot에서 원 source/runtime revision으로 이동할 수 있어야 한다는 경계는 다시 열지 않는다. Answer Briefing의 역사적 snapshot·고정 산출물과 제품 사용자가 다루는 현재 Live View가 같은 Canvas에 공존한다는 전제에서, raw tool trace 전체와 숨은 추론을 복사하지 않으면서도 selection·summary·visualization이 provenance를 끊지 않는 정확한 표시·편집·복구 규칙은 무엇인가? | AI-04 |
| <a id="atlas-q-media-02"></a>`Q-MEDIA-02` | **확정 경계**: Chat–Canvas 이동은 같은 Answer의 탐색이며 새 도메인 객체·Run을 만들지 않는다. **남은 설계·검증**: 누락·stale·권한 거부·한쪽 렌더 실패에서 원문 연결·초안·원 Chat 위치를 보존하는 표시와 복귀. | AI-04 |
| <a id="atlas-q-media-03"></a>`Q-MEDIA-03` | 화면 간 편집, 출처, 정본 결과 위치, 동기화 및 삭제 동작 | AI-04 |
| <a id="atlas-q-media-04"></a>`Q-MEDIA-04` | 정본 제품명을 `Answer Briefing / 답변 브리핑`과 진입 레이블 `브리핑 보기`로 확정할 것인가? 이 기능은 제품 사용자에게 필요한 계획·증거·분석·결정·산출물을 시간·공간적으로 보여 주고 숨은 chain-of-thought를 노출하지 않는다는 전제에서, 하나의 Answer에 속한 Canvas projection의 어떤 산출물·visible target이 Briefing Step이 될 수 있고 Briefing Step 묶음·설명 순서·Focus Scope를 누가 작성·편집하며 무엇을 참조할 수 있는가? | AI-05 |
| <a id="atlas-q-media-05"></a>`Q-MEDIA-05` | Briefing Step 또는 Briefing Step이 가리키는 visible target에 다음 Chat으로 보낼 댓글을 붙일 수 있다는 전제에서, 정확히 어떤 대상에 누가 작성·읽기·편집·삭제·공유할 수 있으며 댓글을 Canvas drawing primitive와 어떻게 구별하는가? | AI-05 |
| <a id="atlas-q-media-06"></a>`Q-MEDIA-06` | **확정 경계**: Canvas annotation에는 도형형 시각 표식과 위치 고정형 Canvas Memo가 있다. Memo는 사용자 본문과 작성자별 짧은 답글을 분리하고 자동으로 긴 Chat으로 승격하지 않는다. **남은 질문**: 두 유형의 대상 모델, 수락 상태, 지속성, 출처, 원본 영향, target 누락과 Agent 방 mention 연결을 어떻게 표현하는가? 이것들은 Briefing Comment와 별개다. | CANVAS-01 |
| <a id="atlas-q-media-07"></a>`Q-MEDIA-07` | 정확한 “다음 Chat에 포함” 컨트롤, 첨부 파일 미리보기/유효성 검사, 최신 대상과 맞지 않거나 누락된 Briefing Step에 대한 피드백, 제거/다시 연결, 전달/전송 실패 및 재시도 동작 | AI-05 |
| <a id="atlas-q-media-08"></a>`Q-MEDIA-08` | 어떤 Briefing Comment와 Chat 초안/첨부 파일이 닫기나 재시작 후에도 지속되며, 해당 Answer Briefing 대상이 변경되거나 사라졌을 때 어떤 재진입 상태가 나타나는가? | AI-05, CHAT-01 |
| <a id="atlas-q-media-09"></a>`Q-MEDIA-09` | **확정 경계**: 이전·다음·직접 이동·전체 보기는 수동 탐색이며 새 실행이 아니다. **남은 설계·검증**: 단계 목록·원 위치 복귀·target 누락·권한 거부·키보드·모션 감소. 자동 진행은 전제하지 않으며 편집 권한은 HUM-BRIEF-001에 연결한다. | AI-05 |
| <a id="atlas-q-media-10"></a>`Q-MEDIA-10` | Answer Briefing 지속성, 편집/버전 권한, 삭제, 공유, 동시 보기/편집 및 기반 답변/산출물과의 관계 | AI-05 |
| <a id="atlas-q-media-11"></a>`Q-MEDIA-11` | 정확한 Briefing Comment 생성/열기/편집/삭제/취소 컨트롤, 초안 유효성 검사, 저장/실패/실행 취소 상태, 키보드 경로, 포커스 복귀 및 편집 중 대상 유실 시 동작 | AI-05 |
| <a id="atlas-q-media-12"></a>`Q-MEDIA-12` | 연결된 Canvas 표현의 정확한 편집/삭제/동기화 컨트롤, Chat 영향 미리보기, 충돌/실패/재시도/실행 취소, 키보드 경로 및 포커스 복귀 | AI-04 |
| <a id="atlas-q-media-13"></a>`Q-MEDIA-13` | 정확한 Canvas 도형/주석 도구와 Memo UI: 대상 선택, 그리기·작성·이동·편집·레이블 변경·답글·수락·기각·삭제, Agent 방 mention 생성, 영속화, 실패·실행 취소, 키보드 경로, 포커스와 재진입 | CANVAS-01 |

### Agent Profile·Run 모델

Q-AGENT-02의 아래 문장은 최초 질문 이력이다. 기본 사용 방식은
[기본 Codex·선택적 Agent 결정](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agent-001)으로
대체됐으며, Profile의 소유·공유·상속·편집 수명주기는 연결된 HUM-RUN/ENGINE 정책을 따른다.

| ID | 최초 점검 질문 — 현재 답·상태는 §8.3 | 영향받는 흐름 |
|---|---|---|
| <a id="atlas-q-agent-01"></a>`Q-AGENT-01` | 제품 사용자가 볼 수 있는 Agent, 표시 정체성, Agent Profile, Agent 실행체, Run, Task의 관계와 각각의 안정된 동일성은 무엇이며, Agent 선택·검사·자동 경로 지정 결과를 여는 정확한 UI와 필수 요약 정보는 무엇인가? | AGENT-01–AGENT-03, AI-01, AI-03, AI-06 |
| <a id="atlas-q-agent-02"></a>`Q-AGENT-02` | Profile은 앱·제품 사용자·Desk·Board·대화·조직 중 어느 범위가 소유·공유·상속하며, 생성·복제·편집·검토·활성·새 Chat 기본값 지정·대체·사용 중단·보관·롤백·삭제·이동·내보내기가 어떤 UI·권한·버전 전이로 동작하는가? 제품이 즉시 사용할 수 있는 기본 제공 Agent/Profile을 포함하는가, 설정 예시만 제공하는가, 전혀 제공하지 않는가? | AGENT-01, AGENT-03, DATA-01, COL-01 |
| <a id="atlas-q-agent-03"></a>`Q-AGENT-03` | provider·model·정확한 version의 선택·pinning·자동 routing·fallback·교체를 누가 결정하며, 비용·privacy·출력 특성·기능 차이와 변경 확인·승인 경계를 어느 UI에 표시하는가? | AGENT-01–AGENT-03, AI-01 |
| <a id="atlas-q-agent-04"></a>`Q-AGENT-04` | Profile에 선언된 capability, 현재 연결된 tool·provider의 availability, 한 Run에서 활성화된 기능을 어떤 표시와 상태로 구분하며, 기능 저하·비가용 때 대체·대기·재검사·실패·자동 복구 UI가 어떻게 동작하는가? | AGENT-01–AGENT-03, AI-06, CODE-01, CU-01 |
| <a id="atlas-q-agent-05"></a>`Q-AGENT-05` | Profile 권한 상한, Task 위임, account/resource authority, System policy, 승인, sandbox·network 제약이 한 Run에서 어떤 우선순위와 교집합으로 유효 권한을 만드는가? 행동별 검토 대상과 진입점, 대상·계정·예상 효과 미리보기, `허용`·`거부`·`취소`, 실행·검토 실패, 재시도, 원 대상 포커스 복귀와 재진입은 정확히 어떻게 동작하는가? | AGENT-01, AGENT-02, AUTH-01, TOOL-01, COL-01 |
| <a id="atlas-q-agent-06"></a>`Q-AGENT-06` | thread/task, 명시적 선택, Board, 임시 그룹·레이아웃, visible/focused resource, 최근 관련 상태, 계정·권한·실행 범위로 만든 context revision을 어디서 검사·수정·제외하고, 민감 범위·포함 이유와 변경 뒤 continue·restart·fork 의미를 어떻게 표시하는가? | AGENT-01–AGENT-03, AI-02, CHAT-01 |
| <a id="atlas-q-agent-07"></a>`Q-AGENT-07` | 대화·Board·Profile·제품 사용자·조직 Memory의 읽기/쓰기 범위, 자동 기록 조건, 검사·편집·삭제·내보내기·만료·이전·공유·동기화 경계는 무엇인가? 각 Run snapshot에는 실제 사용한 Memory ID·revision·scope와 포함 이유를 어떻게 남기고, 최신 아님·삭제됨·권한 거부 상태를 어떻게 표시하는가? | AGENT-01, AGENT-02, AI-02, CHAT-01, DATA-01 |
| <a id="atlas-q-agent-08"></a>`Q-AGENT-08` | credential handle을 생성·선택·검사·교체·만료·철회하는 정확한 UI와 secret 비노출 방식은 무엇이며, provider/account/resource 불일치와 새 외부 권한 승인 경계를 어떻게 복구하는가? | AGENT-01, AGENT-02, AUTH-01, TOOL-01 |
| <a id="atlas-q-agent-09"></a>`Q-AGENT-09` | **확정 경계**: 첫 호출 전 System이 적용 정책에서 active Ontology와 필요한 내용을 resolve·retrieve하며 사용자가 revision을 입력하지 않는다. 관련 변화는 같은 Run의 다음 호출에 반영하고 특정 DB·상시 watcher는 전제하지 않는다. **남은 질문**: 조직 지식 없는 최초 사용, 정책 우선순위·선택 범위·충돌 해소·검사 UI와 실제 읽기 실패의 대체 경로는 무엇인가? | AGENT-01–AGENT-03, ONT-01, ONT-02 |
| <a id="atlas-q-agent-10"></a>`Q-AGENT-10` | 시간·토큰·비용·네트워크·파일시스템·sandbox·동시성 제한을 누가 어느 범위에서 설정·조정하며, Run 중 상한 상태·초과 행동·확대 승인 경계를 어디에 표시하는가? | AGENT-01–AGENT-03, AI-06, CODE-01 |
| <a id="atlas-q-agent-11"></a>`Q-AGENT-11` | Runtime health, Run configuration snapshot, model/tool/context/Ontology/권한 결정, handoff, 비용, 출력·증거와 version을 사용자가 어느 수준으로 검사하고 무엇을 얼마나 보존·내보내기·삭제할 수 있는가? | AGENT-01–AGENT-03, AI-03, ONT-01, DATA-01 |
| <a id="atlas-q-agent-12"></a>`Q-AGENT-12` | Chat·Canvas에서 Agent/Profile/Run/Task/context/Result의 관계와 상태를 각각 어떤 표현으로 보여 주고, 중복된 긴 본문 없이 어떤 컨트롤로 상세 정보·증거·원 실행을 여는가? | AGENT-01–AGENT-03, AI-03–AI-05, CANVAS-01 |
| <a id="atlas-q-agent-13"></a>`Q-AGENT-13` | 제품 사용자 요청, 선택한 conversation context, Profile instructions·personality, 제품 System policy와 provider policy·guardrail은 어떤 우선순위로 effective instruction을 만들며, 각 항목 중 무엇을 원문·요약·version·hash로 누구에게 보여 주고 누가 편집할 수 있는가? 충돌·무효화·노출 제한은 어느 UI에서 어떻게 설명하는가? | AGENT-01, AGENT-02, AUTH-01 |
| <a id="atlas-q-agent-14"></a>`Q-AGENT-14` | Run, execution attempt, resume, retry, fork, checkpoint, 새 요청, cancel, timeout, expiry의 최종 객체 관계와 상태 전이는 무엇인가? 전환 진입점, 차이·보존·외부 효과 미리보기, `확정`·`취소`, 실패·재시도, 원 Run 포커스 복귀·재진입과 기존 메시지·출력·증거 보존을 정확히 어떻게 보장하는가? | AGENT-01–AGENT-03, AI-02, AI-06 |
| <a id="atlas-q-agent-15"></a>`Q-AGENT-15` | 상위 Run·Task가 하위 Agent·Task에 위임할 수 있는 scope, child configuration/context snapshot, dependency 상태, 결과 귀속과 권한 비확대 규칙은 무엇인가? | AGENT-02, AI-06, AI-07 |
| <a id="atlas-q-agent-16"></a>`Q-AGENT-16` | **확정 경계**: 일반적인 context·Ontology 관찰 갱신은 같은 Run의 다음 호출에서 처리한다. **남은 질문**: Engine·Profile·실행 상한의 명시적 변경, 실제 execution retry, 권한 철회·승인 대상 변경·동시 쓰기 충돌 때의 전환·차이·실패·재진입 UI와 정책은 무엇인가? | AGENT-01–AGENT-03, SYS-01 |
| <a id="atlas-q-agent-17"></a>`Q-AGENT-17` | relation map의 제품 의미·version·검사·편집·거버넌스는 무엇이며, 이를 특정 module/framework/runtime topology를 강제하는 설계도로 오해하지 않게 어떤 관점별 UI와 문서 표현을 사용하는가? | AI-02, AI-06, ONT-01, ONT-02 |
| <a id="atlas-q-agent-18"></a>`Q-AGENT-18` | 모든 Agent 제어 활동을 Desk에서 어디까지 보이게 투영하며, contributor·status·scope·evidence·integration result의 위치·밀도·보존과 raw agent chatter 제외를 어떻게 처리하는가? | AGENT-02, AI-03, AI-06, AI-07, CODE-01, TERM-01, CU-01 |
| <a id="atlas-q-agent-19"></a>`Q-AGENT-19` | **검증 설계**: Contract 인수 증거와 UX §4.3을 기준으로 정상·취소·부분 완료·연결 단절·재접속·중복/늦은 사건의 순서를 바꾸어 검사한다. 실행 환경·version·입력·예상 결과·실제 증거·확인 시점을 기록한다. **남은 측정**: 실제 구현별 반복 범위·시간/용량 분포·회귀 대상. 수치나 구현 성공을 사용자 답변으로 대신하지 않는다. | 모든 trace, 특히 L-01–L-03, AI-01, AI-06, TERM-01, CU-01, SYS-01 |
| <a id="atlas-q-agent-20"></a>`Q-AGENT-20` | **확정 경계**: 실행 위치·실패 boundary·마지막 관찰을 구분하고 원격 단절·중지 요청·종료 확인을 합치지 않는다. **남은 설계·검증**: 실제 health probe와 다시 검사·재연결·새 실행·snapshot·중지 경로, 부분 복구·늦은 결과·원 작업 복귀. | SYS-01, L-02, V-01, TERM-01, CU-01 |

### 오케스트레이션 및 승인

| ID | 최초 점검 질문 — 현재 답·상태는 §8.3 | 영향받는 흐름 |
|---|---|---|
| <a id="atlas-q-orch-01"></a>`Q-ORCH-01` | 작업/종속성 표현, 가시성, 소유권, 비용/진행 정보 및 사용자의 순서 변경/재할당 권한 | AI-06 |
| <a id="atlas-q-orch-02"></a>`Q-ORCH-02` | 어떤 종속성 실패가 어떤 하위 작업을 차단하는지, 독립적인 성공을 어떻게 보존하는지, 그리고 부분 결과가 언제 최종 종합에 들어갈 수 있는지 | AI-06 |
| <a id="atlas-q-orch-03"></a>`Q-ORCH-03` | 일괄로 묶인 승인 필요 결정은 어느 검토 시점에, 기존 또는 새로운 어떤 제품 화면에서 제시되는가? 대기열 객체는 전제하지 않는다 | AI-07, AUTH-01 |
| <a id="atlas-q-orch-04"></a>`Q-ORCH-04` | 각 작업 상태에서 어떤 취소, 재시도, 시간 초과, 재할당 및 대체 경로 전환을 허용하며, 이러한 전환이 실행 중이거나 종속되었거나 완료된 작업에 어떤 영향을 주는가? | AI-06 |
| <a id="atlas-q-orch-05"></a>`Q-ORCH-05` | **확정 경계**: 기존 위임 안의 일반 분할·검토·복구는 계속한다. **남은 설계·검증**: 새 인프라·credential·전송·비용·배포·권한 확대를 해당 gate에 한 번만 연결하고, 철회·만료가 걸린 행동만 차단하는 사례와 복귀 경로. 새 위임 정책만 HUM에 남긴다. | AI-07, AUTH-01, BROWSER-02, BROWSER-04 |
| <a id="atlas-q-orch-06"></a>`Q-ORCH-06` | 정확한 승인/거부/보류 컨트롤, 결정 패키지 레이아웃, 영향받는 작업 탐색, 포커스/키보드 동작, 확인 및 오류/재시도 피드백 | AI-07, AUTH-01 |
| <a id="atlas-q-orch-07"></a>`Q-ORCH-07` | 외부 인프라·credential·비용·배포·민감 데이터·새 권한의 최종 승인권은 제품 소유자에게 있다는 전제에서, 어떤 범위를 누구에게 위임할 수 있고 승인·위임은 얼마나 지속되며 어떻게 철회·감사·알림 처리하는가? | AI-07, AUTH-01 |
| <a id="atlas-q-orch-08"></a>`Q-ORCH-08` | 정확한 작업 선택 및 취소/재시도/재할당/대체 경로 진입점, 영향 미리보기, 확인/취소, 대기/실패, 키보드 경로 및 포커스 복귀 | AI-06 |
### 계정, 출처, 파일, 코딩 및 Terminal

| ID | 최초 점검 질문 — 현재 답·상태는 §8.3 | 영향받는 흐름 |
|---|---|---|
| <a id="atlas-q-auth-01"></a>`Q-AUTH-01` | 계정, Firefox 프로필/컨테이너, 리소스 동일성 및 사용 가능한 행동을 어떻게 표시하고 전환할지 | TOOL-01 |
| <a id="atlas-q-auth-02"></a>`Q-AUTH-02` | 복잡함이나 잘못된 출처 분할 없이, 동일 콘텐츠에 적용되는 서로 다른 권한·가능 행동 컨텍스트를 구별하는 정확한 UI | TOOL-01 |
| <a id="atlas-q-auth-03"></a>`Q-AUTH-03` | 정확한 Browser 로그인, 계정 전환, 권한 및 OAuth 진입/복귀 컨트롤, 요청 범위 표시, 팝업/취소/거부/만료/계정 불일치 복구, 인증 상태 증거 | TOOL-01, BROWSER-02 |
| <a id="atlas-q-auth-04"></a>`Q-AUTH-04` | 정본 리소스/콘텐츠 중복 제거, 출처 추적, 행동 감사에 기록되는 신원 및 기존 항목으로 포커스 이동 대 새 항목 열기 동작 | TOOL-01 |
| <a id="atlas-q-auth-05"></a>`Q-AUTH-05` | 정확한 Browser 열기 진입 화면, 보이는 레이블/아이콘, 클릭 및 키보드 행동, 초기 URL 동작, 포커스/중복 열기 피드백 | TOOL-01 |
| <a id="atlas-q-auth-06"></a>`Q-AUTH-06` | 승인 후 어떤 제공자 네이티브 또는 EG-Desk 후속 컨트롤이 외부 행동을 시작하는지, 인계/진행을 어떻게 표시하는지, 어떤 접수 증거/재시도가 성공 또는 실패를 증명하는가? | AUTH-01 |
| <a id="atlas-q-auth-07"></a>`Q-AUTH-07` | 정확한 계정/프로필별 권한·가능 행동 검사기 및 전환기 진입부, 레이블, 현재/대상 표시, 확인, 로딩/실패, 키보드 경로 및 포커스 복귀 | TOOL-01 |
| <a id="atlas-q-auth-08"></a>`Q-AUTH-08` | 정확한 동일 콘텐츠 재사용, 중복 미리보기, 기존 항목으로 포커스 이동/새 항목 열기 컨트롤, 출처 추적/권한·가능 행동 컨텍스트 표시, 실패, 키보드 경로 및 포커스 복귀 | TOOL-01 |
| <a id="atlas-q-browser-01"></a>`Q-BROWSER-01` | 정확한 주소/링크/뒤로/앞으로/새로고침/중지/새 뷰 컨트롤, 키보드/포커스 동작, URL/기록 표시, 로딩/리디렉션/팝업 상태, 탐색 실패, 재시도 및 재진입 | BROWSER-01 |
| <a id="atlas-q-browser-02"></a>`Q-BROWSER-02` | 정확한 다운로드 대상/목적지/진행/취소/재개/재시도/열기/위치 표시 컨트롤, 중복/안전하지 않음/차단됨/실패 상태, 파일 완료 증거 및 재진입 | BROWSER-03 |
| <a id="atlas-q-browser-03"></a>`Q-BROWSER-03` | 정확한 외부 효과 검토/확인/제출/취소 컨트롤, 행위자/대상/페이로드 표시, 대기 중/알 수 없음/중복 위험 상태, 제공자 접수 증거, 독립 검증, 안전한 재시도 및 재진입 | BROWSER-04 |
| <a id="atlas-q-code-01"></a>`Q-CODE-01` | 프로젝트/폴더/다중 루트 모델, 파일 트리/검색의 역할, 편집기 대 뷰어 통합 및 열 수 있는 대상 유형 | TOOL-02, CODE-01 |
| <a id="atlas-q-code-02"></a>`Q-CODE-02` | 파일 권한, 이동됨/삭제됨/외부 변경, 읽기 전용, 저장되지 않음, 저장 실패 및 충돌 UI | TOOL-02 |
| <a id="atlas-q-code-03"></a>`Q-CODE-03` | 빌드/테스트/검사/검토 결과 모델, 리비전 연결, 증거 범위 및 완료에 필요한 검증 | TOOL-02, CODE-01 |
| <a id="atlas-q-code-04"></a>`Q-CODE-04` | 파일 저장과 독립적인, 사람 및 Agent 편집에 대한 변경 비교 검토와 수락/거부/되돌리기/부분 수락/계속의 의미론 | CODE-01 |
| <a id="atlas-q-code-05"></a>`Q-CODE-05` | 정확한 저장/모두 저장 컨트롤 및 키보드 경로, 변경됨 및 저장 중 상태, 성공 접수 증거, 다른 이름으로 저장 동작, 권한/디스크/충돌 실패, 재시도 및 저장되지 않은 데이터 보존 | TOOL-02, CODE-01 |
| <a id="atlas-q-code-06"></a>`Q-CODE-06` | 편집기에 직접 입력, 선택, 실행 취소/다시 실행, 변경 상태, 취소/되돌리기 경계, 외부 변경 감지 및 충돌 해결 동작 | TOOL-02, CODE-01 |
| <a id="atlas-q-code-07"></a>`Q-CODE-07` | 정확한 파일/폴더/프로젝트 선택기, 트리/최근 항목/다중 루트 선택, 드래그/드롭, 권한 프롬프트, 대기/오류, 키보드 경로, 중복/열기 동작 및 포커스 복귀 | TOOL-02, CODE-01 |
| <a id="atlas-q-code-08"></a>`Q-CODE-08` | 정확한 빌드/테스트/검사/검토 컨트롤, 대상/명령/리비전 미리보기, 실행/취소/재시도, 결과 탐색/필터, 실패 상태, 키보드 경로 및 포커스 복귀 | CODE-01 |
| <a id="atlas-q-code-09"></a>`Q-CODE-09` | 정확한 변경 비교 진입부/패널, 파일 및 변경 묶음 탐색, 현재안 대 제안안 비교, 수락/거부/되돌리기/부분 수락/계속 컨트롤, 파괴적 범위 미리보기, 취소/실행 취소, 최신 상태가 아니거나 충돌하는 변경 비교 처리, 적용 실패/재시도, 키보드 경로, 포커스 복귀 및 재진입 | CODE-01 |
| <a id="atlas-q-term-01"></a>`Q-TERM-01` | Terminal이 사람들에게 언제 보이며, 이를 주된 코딩 UX로 만들지 않고 어떻게 여는지 | TERM-01 |
| <a id="atlas-q-term-02"></a>`Q-TERM-02` | Terminal view 닫기, transport 분리, process 종료와 final-output snapshot은 서로 다르다. 유지되는 실행은 다른 Canvas 표현에서 찾을 수 있고 Board 닫기는 단독 소유 runtime 종료 규칙을 따른다는 전제에서, 각 제어·결과·보존 범위는 무엇인가? | TERM-01 |
| <a id="atlas-q-term-03"></a>`Q-TERM-03` | **확정 경계**: transport 복구·동일 process 재연결·새 process·출력 snapshot을 구분한다. **남은 설계·검증**: PC/process 식별과 생존 증거, 동일성 확인 실패·재진입·이전 출력 보존. 대화·파일 복원만으로 live session 복구를 주장하지 않는다. | TERM-01, L-02 |
| <a id="atlas-q-term-04"></a>`Q-TERM-04` | 정확한 선택적 Terminal 진입/열기 컨트롤, 새 세션 시작 대 기존 세션 연결 선택, 현재 작업 디렉터리/세션 표시, 대기/실패, 키보드 경로, 초기 포커스 및 복귀 동작 | TERM-01 |
| <a id="atlas-q-term-05"></a>`Q-TERM-05` | **확정 경계**: view 닫기와 process 종료는 다르며 실행을 유지하면 다른 Canvas 표현에 소유·상태가 남는다. **남은 설계·검증**: 닫기·분리·종료·고정·snapshot의 영향과 취소, 원격 종료 미확인·실패·키보드 복귀. | TERM-01 |

### Ontology, 협업 및 computer-use

| ID | 최초 점검 질문 — 현재 답·상태는 §8.3 | 영향받는 흐름 |
|---|---|---|
| <a id="atlas-q-ont-01"></a>`Q-ONT-01` | 검사 뷰가 어떤 Ontology 계층, 시간/증거 관계, 개념/제약 및 선택된 사이클/실행 관계를 노출할지 | ONT-01 |
| <a id="atlas-q-ont-02"></a>`Q-ONT-02` | Agent 사이클에 대해 어떤 Ontology 버전/출처 추적/증거 연결이 보이는지, 어디에 나타나는지, 알 수 없거나 최신 상태가 아닌 연결을 어떻게 나타내는지 | ONT-01, ONT-02 |
| <a id="atlas-q-ont-03"></a>`Q-ONT-03` | 최종 사용자 또는 Agent가 Ontology를 제안/편집할 수 있는지와 검증, 검토 권한, 승격, 충돌, 롤백 및 감사에 관한 거버넌스 의미론 | ONT-01, ONT-02 |
| <a id="atlas-q-ont-04"></a>`Q-ONT-04` | 정확한 Ontology 뷰 진입부, 실행/사이클 선택기, 계층/시간/증거 필터, 출처 추적/버전 검사기, 사용 불가/최신 상태 아님 표시, 키보드/포커스 및 재진입 컨트롤 | ONT-01, ONT-02 |
| <a id="atlas-q-ont-05"></a>`Q-ONT-05` | 편집이 허용되는 경우, 정확한 제안/편집/검증/검토/승인/거부/승격/롤백 컨트롤, 충돌/실패/감사 표시, 키보드 경로 및 포커스 복귀 | ONT-01, ONT-02 |
| <a id="atlas-q-col-01"></a>`Q-COL-01` | Desk, Board, 선택된 뷰, Thread, 산출물 또는 그 조합 중 무엇을 공유할 수 있는지와 권한이 있는 어떤 역할이 공유를 시작할 수 있는지 | COL-01 |
| <a id="atlas-q-col-02"></a>`Q-COL-02` | 협업자의 참가/수락 흐름, 신원, 기기/세션 범위 및 최초 도착 위치/포커스 | COL-01 |
| <a id="atlas-q-col-03"></a>`Q-COL-03` | 접속 상태, 커서/포커스, Agent 활동, 알림 및 비공개 상태 대 공유 상태 | COL-01 |
| <a id="atlas-q-col-04"></a>`Q-COL-04` | 역할, 부여/거부/철회/만료, 관찰 권한 대 편집/제어 권한 및 재진입 | COL-01 |
| <a id="atlas-q-col-05"></a>`Q-COL-05` | 동시 편집/충돌/병합/실행 취소/기록 모델 및 행동 귀속 | COL-01 |
| <a id="atlas-q-col-06"></a>`Q-COL-06` | Desk에 소유자, 관리자 또는 다른 거버넌스 역할이 있는지, 그 권한이 어떻게 생성, 이전, 복구되며 임시 공유 권한과 어떻게 구별되는지 | COL-01 |
| <a id="atlas-q-col-07"></a>`Q-COL-07` | 정확한 초대 전송 및 수신자 수락/참가 행동, 수신자 검증, 전달 완료/대기 중 상태를 보여주는 접수 증거, 수신자를 찾을 수 없음/전송/참가 실패, 만료, 취소, 재전송, 키보드/포커스 및 수신자 재진입 컨트롤 | COL-01 |
| <a id="atlas-q-col-08"></a>`Q-COL-08` | 정확한 공유/초대 진입부, 수신자/범위/역할/기간 선택, 접근 불가 영역 미리보기, 초안 저장/취소, 검증, 키보드 경로 및 포커스 복귀 | COL-01 |
| <a id="atlas-q-col-09"></a>`Q-COL-09` | 정확한 기존 권한 부여의 역할/기간 변경 및 철회 컨트롤, 영향 미리보기, 확인/취소, 실패/재시도, 알림, 키보드 경로 및 포커스 복귀 | COL-01 |
| <a id="atlas-q-col-10"></a>`Q-COL-10` | 정확한 공유 리소스 충돌 알림, 행위자/변경 비교, 병합/유지/되돌리기/실행 취소/기록 컨트롤, 대기/실패, 키보드 경로 및 포커스 복귀 | COL-01 |
| <a id="atlas-q-cu-01"></a>`Q-CU-01` | 어떤 computer-use 실행 모드를 제공하는지와 제어를 시작하기 전에 어떤 대상/범위/관찰/입력 소유권 사실을 검토해야 하는지 | CU-01 |
| <a id="atlas-q-cu-02"></a>`Q-CU-02` | 어떤 시작/일시 중지/인계/재개/중지 소유권 전환을 허용하는지와 현재 사람/Agent/제어자 없음 상태를 어떻게 나타내는지 | CU-01 |
| <a id="atlas-q-cu-03"></a>`Q-CU-03` | 물리적 입력 충돌 정책, 긴급 중지, 시간 초과, 더 이상 유효하지 않은 제어권의 해제 및 제어권 반환 | CU-01 |
| <a id="atlas-q-cu-04"></a>`Q-CU-04` | 협업자가 관찰할 수 있는 Desk 외부 픽셀, 앱/창 식별 정보, 포인터/행동 기록, 입력 또는 결과가 무엇인지와 동의/개인정보 보호가 어떻게 작동하는지 | CU-01 |
| <a id="atlas-q-cu-05"></a>`Q-CU-05` | 정확한 computer-use 범위 검토 진입부, 대상/모드/관찰/입력 소유자 미리보기, 편집/확인/취소, 검증/실패, 키보드 경로 및 포커스 복귀 | CU-01 |
| <a id="atlas-q-cu-06"></a>`Q-CU-06` | 정확한 시작/일시 중지/인계/재개/중지/긴급 중지/철회 컨트롤, 제어 소유자 표시기, 확인, 시간 초과/실패, 키보드 경로 및 포커스 복귀 | CU-01 |
| <a id="atlas-q-cu-07"></a>`Q-CU-07` | 정확한 협업자 관찰 진입/닫기, 동의 및 개인정보 보호 범위 표시, 앱/창/행동 상태 표시, 사용 불가/스트림 실패, 키보드 경로 및 재진입 | CU-01 |
| <a id="atlas-q-cu-08"></a>`Q-CU-08` | 정확한 computer-use 결과 검증 진입부와 화면, 요청된 내용 대 관찰된 내용 비교, 독립 증거 출처/시간 표시, 검사/새로고침/재시도 컨트롤, 검증됨/불일치/알 수 없음 상태, 증거가 누락되었거나 최신 상태가 아니거나 권한 거부로 접근할 수 없는 경우의 처리, 키보드 경로, 포커스 복귀 및 재진입 | CU-01 |
| <a id="atlas-q-cu-09"></a>`Q-CU-09` | 로컬 제품 사용자가 Desk 안에서 computer-use 관찰을 여닫는 정확한 진입·닫기 UI는 무엇인가? 대상 앱·창, 현재 제어자, 행동·포커스·타임라인, privacy masking, `일시 중지`·`중지`, stream 실패·재시도, 원 Task 포커스 복귀와 재진입을 어떻게 표시하는가? | CU-01 |

### 데이터 및 범분야 UX

| ID | 최초 점검 질문 — 현재 답·상태는 §8.3 | 영향받는 흐름 |
|---|---|---|
| <a id="atlas-q-data-01"></a>`Q-DATA-01` | **비교안 준비**: [초기화 범주](../references/design-synthesis/egdesk-ux-realization-proposals.md#data-reset)를 앱 환경설정·계정 연결·Agent/Engine Profile 정의·업무 기록으로 나누고 PC 로컬과 공유 원본을 구별했다. **남은 선택**: HUM-EXPORT-001의 저장·초기화 범위; Desk·Board·협업자·기기의 실제 설정 연결은 검증한다. | DATA-01 |
| <a id="atlas-q-data-02"></a>`Q-DATA-02` | 로컬 내보내기/백업 콘텐츠, 형식, 목적지, 자격 증명 제외, 암호화, 보존 및 검증 | DATA-01 |
| <a id="atlas-q-data-03"></a>`Q-DATA-03` | 가져오기/복원 미리보기, 병합/덮어쓰기, 충돌, 롤백, 버전 호환성 및 성공적인 복원의 증거 | DATA-01 |
| <a id="atlas-q-data-04"></a>`Q-DATA-04` | **비교안 준비**: [선택 범위 초기화](../references/design-synthesis/egdesk-ux-realization-proposals.md#data-reset)에 기록·로그·캐시·산출물·인증 정보의 삭제/보존 구분, 재동기화·외부 철회·부분 실패를 연결했다. **남은 선택·검증**: HUM-EXPORT-001의 복구·백업 정책, 참조별 실제 정리·새 입력 제외·최소 처리 기록·종료 미확인 상태를 대조한다. | DATA-01, 모든 Agent 흐름 |
| <a id="atlas-q-data-05"></a>`Q-DATA-05` | 동기화가 승인되는 경우, 동기화할 객체/상태, 오프라인 편집, 충돌 소유권, 기기 제거, 암호화, 마이그레이션, 내보내기 및 삭제 | DATA-01, COL-01 |
| <a id="atlas-q-data-06"></a>`Q-DATA-06` | **설계안 준비**: [설정·초기화 흐름](../references/design-synthesis/egdesk-ux-realization-proposals.md#data-reset)의 진입·범위 선택·미리보기·백업·적용·처리 내역·복귀. **남은 검증**: 초기 focus·탭 순서·레이블·미지원 사유·취소와 부분 적용 뒤 복귀를 실제 화면에서 확인한다. | DATA-01 |
| <a id="atlas-q-data-07"></a>`Q-DATA-07` | 정확한 로컬 내보내기/백업 진입 컨트롤, 목적지 상호작용, 진행, 취소, 성공 접수 증거 및 실패 재시도 행동 | DATA-01 |
| <a id="atlas-q-data-08"></a>`Q-DATA-08` | 정확한 가져오기/복원 진입 컨트롤, 미리보기 탐색, 확인/취소, 충돌 해결, 롤백, 성공 증거 및 실패 재시도 행동 | DATA-01 |
| <a id="atlas-q-data-09"></a>`Q-DATA-09` | 정확한 원격 백업/동기화 요청 진입부, 승인 패키지 표시, 취소/연기 행동 및 승인 전 상태 | DATA-01 |
| <a id="atlas-q-ux-01"></a>`Q-UX-01` | 목표 접근성 기준선 및 지원되는 키보드, 화면 읽기 프로그램, 대비, 확대/축소, 언어 및 입력 모드 | 전체 |
| <a id="atlas-q-ux-02"></a>`Q-UX-02` | **확정 경계**: 상세·메뉴·대화상자 종료는 시작한 control로 돌아가며 대상이 사라졌으면 같은 업무의 유효 진입점으로 복귀한다. **남은 검증**: Sidebar·Canvas·Chat·native 경계에서 focus 소유권·초안·삭제된 target·재진입 검사. | 전체 |
| <a id="atlas-q-ux-03"></a>`Q-UX-03` | **확정 경계**: 비공간·모션 감소 경로에서도 같은 대상·단계·결과에 도달하며 Agent 실행과 카메라를 분리한다. **남은 검증**: Canvas·Briefing·Ontology의 의미 동등성과 상태 안내. 준수 수준·지원 조합의 약속만 HUM-A11Y-001에 남긴다. | V-03, AI-05, ONT-01 |
| <a id="atlas-q-ux-04"></a>`Q-UX-04` | **확정 경계**: 핵심 행동에는 키보드·이름·상태·복귀 경로가 필요하다. **남은 설계·검증**: shell/resource 단축키 충돌·Esc 우선순위·조합 입력·비활성 사유·상태 갱신, 드래그 없는 포인터 대안을 실제 입력별로 확인한다. | UX-01, 모든 흐름 |

<a id="doc-approval-registry"></a>

## 17. 외부 권한·인프라 승인 gate registry

승인은 해당 범위의 실행 권한일 뿐 실행 성공의 증거가 아니다. System의 오케스트레이션 통합 기능은 관련 항목을 유용한 검토 시점에 묶어 제품 사용자에게 제시하고, 관련 없는 로컬 작업은 계속 진행한다.

### 승인 후보

| ID | 다음 작업 전에 필요한 승인 | 필요한 결정 패키지 | 계속되는 독립 작업 |
|---|---|---|---|
| <a id="atlas-a-infra-01"></a>`A-INFRA-01` | 원격 협업용 신원 체계, 서버, 네트워크, 데이터베이스 또는 동기화 프로비저닝 | 선택지, 제공자/자체 호스팅 비교, 데이터 흐름, 역할, 보안, 비용, 마이그레이션, 삭제 | 로컬 단일 사용자 모델, 협업 UI 흐름, 권한 스키마, 조사 |
| <a id="atlas-a-infra-02"></a>`A-INFRA-02` | Desk 외부 computer-use 활동을 스트리밍하거나 저장하거나 원격 제어 권한을 부여하는 작업 | 관찰/제어 범위, 동의, 개인정보 보호, 보존, 전송, 격리, 긴급 중지 | 로컬 API/접근성/격리 모드 조사 및 UI 모델링 |
| <a id="atlas-a-infra-03"></a>`A-INFRA-03` | 다중 기기 동기화 또는 원격 백업 활성화 | 정확한 데이터 세트, 충돌/오프라인 모델, 신원, 암호화, 제공자, 비용, 마이그레이션, 내보내기/삭제 | 로컬 지속성, 검증된 로컬 백업/복원 설계 |
| <a id="atlas-a-auth-01"></a>`A-AUTH-01` | 새로운 자격 증명, 외부 계정, OAuth 범위, API 키 또는 제공자 측 신원을 생성·연결하거나 권한을 부여하는 작업 | 계정/제공자, 요청 범위, 저장, 만료/철회, 데이터 접근, 대안, 종속 작업 | 로컬 모델링, 모의 UI, 조사 및 사용 권한이 이미 부여된 자격 증명을 사용하는 작업 |
| <a id="atlas-a-auth-02"></a>`A-AUTH-02` | 구매, 프로비저닝, 배포, 게시, 도메인 등록 또는 유료 외부 서비스 활성화 | 제공자/선택지, 반복 및 일회성 비용, 배포 대상, 보안, 롤백, 소유권, 마이그레이션, 종속 작업 | 로컬 빌드/테스트, 배포 패키지 준비 및 무료 조사 |
| <a id="atlas-a-auth-03"></a>`A-AUTH-03` | 민감한 데이터를 외부로 전송하거나 위임된 범위 밖에서 실질적으로 새로운 외부 효과를 수행 | 정확한 데이터/효과/수신자, 목적, 최소화, 보존, 가역성, 완료 증거, 종속 작업 | 민감 정보가 가려진 데이터의 처리 또는 로컬 처리 및 관련 없는 권한상 허용된 분기 |

## 18. Atlas acceptance와 현재 완전성

이 Atlas는 현재 구현이 아래 기능을 이미 제공한다고 주장하지 않는다. 제품 의미와 검증해야 할 행동을 정의하며, 실제 구현 상태·테스트·배포 증거는 별도로 확인해야 한다.

- 43개 상세 흐름과 현재 162개 기본 행동 행이 시작 상태, UI 행동, 보이는 반응, System·Agent 처리, 상태 변화, 실패·복구·재진입과 완료 증거를 추적한다. 이 행수는 독립 사용자 리허설의 수행 횟수가 아니다.
- 56개 제품·시스템 개념 항목이 화면에서 보이는 의미, System 책임, Agent 관계와 수명주기를 연결한다.
- 175개 질문 ID는 최초 질문·결정 이력을 보존한다. 초기 3 `DECIDED` / 172 `OPEN`과 2026-09-08의 175 `REVIEWED-CLOSED`는 당시 집계다. 현재 설계·재검토는 [§8.3](#design-closure-status), 실제 역할 행동과 개선 후 재확인은 [후속 재리허설](../references/design-synthesis/egdesk-user-action-simulation-2026-09-10.md#simulation-top)에서 구분한다. 제품 선택은 기존 원장의 OPEN 15개 주제로 관리한다.
- 외부 인프라·자격 증명·비용·배포·민감 데이터·원격 동기화에 관한 6개 승인 게이트는 제품 결정 및 실행 성공과 분리되어 있다.
- 모든 trace 행은 제품 사용자 UI 행동, 보이는 반응, System 처리, Agent 처리, 상태 변화, 실패 후 다음 UI를 분리한다.
- 저장된 Board, 자동 Desk 세션, 표시 상태, 리소스/runtime, Agent Run, 권한, 제품 내부의 출처·증거, 원격 상태를 하나의 저장 단위나 동일성으로 합치지 않는다.
- `Workspace`, 정본 제품명으로서의 `Host Activity View`, 오케스트레이션 자체로서의 `Await Token`, 정상 시작의 복구 저널 항목은 제품 객체가 아니다.
- bridge/helper/transport/provider conversation/process/view 장애는 관찰된 경계까지만 말하고, 확인되지 않은 원인은 마지막 확인 상태와 함께 `원인 미확정`으로 남긴다.
- acceptance에는 일회성 성공 화면뿐 아니라 같은 범위에서 반복 가능한 성공과 실패 뒤 복구 확인이 포함된다.
- 제품 상태가 ‘결정됨’이라는 사실과 현재 구현·테스트·배포 완료 여부는 서로 다른 축이다.

완료 증거는 클릭, spinner, 화면 렌더링, Agent 보고, 파일 생성 시도 또는 `200 OK`와 구분한다. 각 흐름은 대상 revision·외부 receipt·독립 관찰·권한 상태 등 해당 결과를 실제로 입증하는 증거와 실패 후 다음 UI를 요구한다.
