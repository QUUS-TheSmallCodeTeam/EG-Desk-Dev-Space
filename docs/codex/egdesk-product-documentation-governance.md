# EG-Desk 제품 문서 화자·운영 정본

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

### 0.2 UI/UX ↔ 기술 계약 weave cycle

한 기능 영역을 수정할 때 다음 cycle을 반복한다.

```text
Atlas에서 정확한 사용자 입력·화면 반응을 쓴다
-> Contract에서 필요한 state/data/runtime/authority를 쓴다
-> Contract가 요구하지만 Atlas에서 조작·확인할 수 없는 부분을 Atlas에 되돌린다
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
| `OPEN` | 제품·UI·지속성·권한·복구가 아직 정해지지 않음 | 아니요 |
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
| 이 Codex 작업에서 사용자가 제시한 수정사항, 특히 Agenda와 Desk 복원을 분리하고 Chat/Canvas, Answer Briefing(기존 Playback 명칭), 오케스트레이션, Ontology, 코딩 UX, 협업 및 computer-use를 바로잡은 제품 설계 대화 차례 | 최상위 결정 근거가 되는 제품 입력 |
| [EG-Desk 제품 비전 및 개발 할 일](../../ideas/confirmed/EGDESK_PRODUCT_VISION_AND_DEV_TODO.md), 실패한 Atlas 라운드 이전에 커밋된 `HEAD` 버전 | 이전 제품 기준선; 현재 미커밋 변환은 그 자체만으로 결정 근거가 되지 않음 |
| [EG-Desk 비전 백서](../vision/EG-DESK%20백서%20-%20Vision_v1.md) | 장기 개념 기준선; 이후 사용자 수정사항이 우선함 |
| [apps/firefox-ui-demo/docs](../../apps/firefox-ui-demo/docs/) 아래에 있는 Firefox 제품/런타임 집중 문서의 커밋된 `HEAD` 버전 | 기준선 후보 및 용어 충돌의 증거 |
| [apps/firefox-ui-demo](../../apps/firefox-ui-demo/) 아래의 현재 Firefox 소스 | 구현 관찰에만 사용 |
| [Interaction Contract](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md)의 final-correction 직전 `UNTRACKED` snapshot, SHA-256 `42892ce140f81d2a2b67c548591cfb7ed7eb02e280e46796014d4b12552f5478`, 452 lines; 삭제 전 Atlas snapshot SHA-256 `b577608f81b73bc2b7c8690fd35987a8f283a90dcddc3f45eecb02552bfb64b2` | 동작, 객체 또는 기본값을 정립하는 데 사용하지 않음; 초안 후 부정 감사는 해당 정확한 snapshot의 오염이 다시 나타났는지만 확인할 수 있음 |

제외 이유는 다음과 같다.

- 위 hash로 식별한 Contract·Atlas snapshot은 동일한 이전 PM/Main 라운드에서 만들어져 서로 독립적인 증거가 아니므로 긍정적 동작 근거에서 제외한다. 오직 contamination negative audit에만 사용할 수 있다.
- 현재 미커밋 제품·런타임 문서는 owner 피드백을 유용하게 재서술했을 수 있어도 커밋된 기준선이나 owner decision이 아니므로 제품 의미 승격 근거에서 제외한다.
- 현재 구현은 `RUNTIME-OBSERVATION`으로만 사용할 수 있으며, 보이는 UI나 성공 응답이 지속성·외부 효과·완료를 입증한다고 확장하지 않는다.

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

## 6. stable ID와 explicit anchor 규칙

1. Atlas가 trace ID와 `OBJ-*` 제품 요소, `AFF-*` 비객체 어포던스의 정본 정의를 소유한다. 사용자 확인 원장은 `HUM-*` 질문·결정을 소유한다. Governance는 `Q-*` 세부 조사, approval registry, route, disposition과 유지보수용 `EXC-*`를 소유한다. `EXC-*`는 제품 ID나 제품 anchor가 아니다.
2. Governance는 자체 편집 사건에만 `ATL-ED-0001` 형식의 단조 증가 event ID를 사용한다. event ID는 재사용하거나 다시 번호 매기지 않는다.
3. 제목, 한글 표현, 섹션 위치가 바뀌어도 기존 ID는 바뀌지 않는다. 의미가 갈라지면 새 Atlas ID와 관계를 만들고 Main이 disposition한다.
4. 제거·병합·대체된 ID는 삭제하지 않고 tombstone으로 남긴다. tombstone에는 `status`, `superseded-by` 또는 `merged-into`, 사유, Main disposition event를 기록한다. tombstone ID는 재사용하지 않는다.
5. 네 정본 문서는 자동 생성 heading slug에만 의존하지 않고 명시적 HTML anchor를 둔다. Atlas 패턴은 trace `atlas-<trace-id-lower>`, 제품 요소 `atlas-<obj-id-lower>`, 어포던스 `atlas-<aff-id-lower>`다. Contract는 `tech-*`, 사용자 확인 원장은 `hum-*`와 `gap-*`, Governance는 legacy-compatible question·approval anchor와 `doc-*`를 쓴다. `EXC-*`에는 제품 anchor를 만들지 않는다.
6. 의도적으로 비어 있는 기존 Agenda 질문 번호는 새 질문으로 채우지 않는다. 새 질문은 Main이 Atlas namespace와 충돌 여부를 확인한 뒤 다음 유효 ID를 배정한다.
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
질문 본문·route·work group·status와 기존 링크를 보존하는 호환 anchor를 소유한다.
제품 소유자 결정이 필요한 질문의 정본은 [사용자 확인 원장](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#gap-owner-queue)의 `HUM-*` 목록이다.

### 8.1 PM work groups

| PM work group | 범위 | 질문 수 |
|---|---|---:|
| `P1-LIFECYCLE-RECOVERY` | 실행·세션 복원·기능 저하·재진입 | 9 |
| `P2-AGENDA-LIFECYCLE` | Agenda 생성·열기·저장·충돌·보관·삭제 | 11 |
| `P3-VIEW-CANVAS-DISCOVERY` | view 조작·Canvas 탐색·검색·Library | 12 |
| `P4-CHAT-AI-MEDIA` | Chat·AI request·context·Canvas/Playback media | 12 |
| `P5-ORCHESTRATION-APPROVAL` | 작업 전환과 승인 경계·컨트롤 | 3 |
| `P6-ACCOUNT-BROWSER-EVIDENCE` | 계정·Browser·외부 효과 증거 | 9 |
| `P7-CODE-TERMINAL` | 사람 중심 coding·file·Terminal lifecycle | 9 |
| `P8-ONTOLOGY-COLLAB-CU` | Ontology·협업·computer-use | 10 |
| `P9-DATA-ACCESSIBILITY` | 데이터 수명주기·키보드·접근성 | 7 |
| `P10-AGENT-PROFILE-RUN` | capability/availability UI, 반복 acceptance, 경계별 장애 진단·복구 | 3 |
| **합계** |  | **85** |

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
표시한다. 이 표에 없는 `PM-RESEARCH` 질문은 owner 결정을 가장하지 않고 조사·구현
세부로 남는다. `HUM-*` 결정이 내려지면 Main은 연결된 `Q-*`를 ID별 disposition으로
분해해 반영한다.

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

## 9. owner decision batch 호환 색인 — D1–D10

`D1`–`D9`는 기준 Atlas의 기존 routing ID 집합을, `D10`은 Agent Profile·Run addition의
이력을 보존하는 호환 색인이다. 이 표는 0절과 별개의 두 번째 owner 질문 목록이
아니다. 실제 사용자 검토는 `HUM-*`로만 구성하고, batch는 관련 `Q-*` evidence packet을
준비하거나 과거 이력을 찾을 때만 사용한다.

| batch | exact owner question ID set | status |
|---|---|---|
| `D1` Desk 및 Agenda 객체 모델 | `Q-OBJ-01`–`Q-OBJ-04`, `Q-AG-01`, `Q-AG-02`, `Q-AG-06` | `COMPATIBILITY / OPEN VIA HUM` |
| `D2` 연속성 및 Agenda 수명주기 | `Q-LIFE-04`, `Q-RESTORE-02`, `Q-RESTORE-04`, `Q-RESTORE-05`, `Q-AG-07`, `Q-AG-08`, `Q-AG-11`, `Q-AG-12`, `Q-AG-16` | `COMPATIBILITY / OPEN VIA HUM` |
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
| `EXC-001` — `Workspace` | `REJECTED` product object | 결정 근거 없이 도입된 정의되지 않은 객체이며 Desk·Agenda 관계를 왜곡한다 | owner가 별도 객체 의미와 관계를 명시적으로 결정한 경우에만 새 disposition |
| `EXC-002` — `Host Activity View` canonical name | `REJECTED` canonical term | 이전 라운드에서 지어낸 객체명이다. Desk 외부 관찰은 기능 질문이지 이 이름의 객체가 아니다 | 기능·표면·정본 이름을 owner가 결정한 경우 |
| `EXC-003` — `Await Token` as orchestration | `REJECTED` orchestration model | 파일·사용자 event 대기는 한 dependency condition일 수 있지만 orchestration 자체는 dependency 완료와 후속 작업 시작이다 | condition primitive로만 근거를 붙여 제안 가능 |
| `EXC-004` — restore journal items / keep-discard restore items | `REJECTED` normal-start UI | 정상 실행은 실제 Desk를 복원해야 하며 임의의 복구 journal workflow를 먼저 열지 않는다 | 손상·부분 복구의 구체적 예외 흐름으로 owner 결정이 있을 때만 가능 |
| `EXC-005` — fixed Agenda schema | `REJECTED` inherited assumption | Agenda의 정확한 구성원·필수 필드·저장 범위는 `Q-AG-02`, `Q-AG-08`이 정한다. 직전 Contract snapshot의 objective/members/bindings/workflow/layout 열거는 정본 스키마가 아니다 | 두 질문의 owner disposition 뒤 Atlas·Contract를 함께 갱신할 때만 가능 |
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

## 13. audit checklist

| 검사 | worker draft 상태 | Main final 상태 |
|---|---|---|
| 기준 Atlas SHA-256과 Git `UNTRACKED` 상태 재확인 | `WORKER-PASS` | `PASS` |
| 기준 질문 154개 unique 및 canonical route 72/82 보존 | `WORKER-PASS` | `PASS` |
| addition 후 질문 175개 unique, route 90/85 | `MAIN-DRAFT-PASS` | `PASS` |
| 의도적으로 비어 있는 Agenda 숫자 gap에 새 ID가 없음 | `WORKER-PASS` | `PASS` |
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
| `ATL-ED-0007` | 2026-08-04 | PM / Main | 두 차례 의미 감사의 REVISE 항목을 반영해 Agenda·공유 대화 drift, maintainer contamination, 양방향 Chat–Canvas 복구, local computer-use 관찰, Agent effective Run binding, Task 8상태와 175번째 질문을 정합화 | PM audit 결과, Contract §14, 질문 175, trace 39, action row 144, route 90/85, candidate validator PASS | `REVIEWED / CORRECTED` |
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
| `ATL-ED-0019` | 2026-08-30 | owner input / WM / Main | 하나의 Desk·Canvas와 동일 Canvas의 복수 Saved Agenda projection, view/runtime별 lifecycle과 Canvas representation, Agenda 닫기 시 전용 runtime 종료·Saved Agenda 보존, File view 재진입의 caret·focus·transient selection 제외를 확정했다. 기본 Chat을 Agent/persona 담당자 방으로 정하고, 위치 고정 Canvas Memo의 사용자 본문·작성자별 짧은 답글·필요 시 Agent 방 mention을 시각 표식과 함께 `CANVAS-01`에 통합했다. 같은 Agent 방의 업무 구분과 agent-agent workroom·공유 대화의 정확한 UI는 `OPEN`으로 유지했다 | `HUM-DESK-001`을 `DECIDED`로 전환하고 `Q-OBJ-01`, `Q-OBJ-02`, `Q-AG-06`을 `DECIDED`로 전환; 질문 175개 중 3 `DECIDED` / 172 `OPEN`. 전용 validator: trace 43, action row 157, object 56, tech anchor 28, HUM 18, route 90/85, unresolved local link/fragment 0, `git diff --check` 통과. Atlas SHA `f9cfaf24422e22a21f352c2c521828839bfb99343192c6eb3ab5fc4ebba7fc2d`, Contract SHA `b6aa79f645190214332af72f849e57008cee6123ccd8c893dde853219e8ef920`, 사용자 확인 원장 SHA `225882a228f54b01f9efa32a3911889830a7d0bf8d02fff69deb01041b76f989` | `RECORDED / PASS-ACTUAL / PM-AUDIT-PENDING` |

이력 행은 append-only다. 수정이 필요하면 기존 사건을 덮어쓰지 않고 다음 `ATL-ED-*` 행에서 정정·대체 관계를 남긴다.

## 15. Atlas coverage audit

<a id="doc-coverage-audit"></a>

### 15.1 Map → object → trace → question / approval

아래 Q 배정은 제품 동작을 빠짐없이 찾기 위한 1차 색인이다. 한 Q가 여러 지도 edge에 반복될 수 있지만, 이 열에서는 175개 Q를 정확히 한 번씩 배정한다.

| Map | 시작 → 끝 | 포함 object / 개념 | 연결 trace | 1차 배정 question | approval |
|---|---|---|---|---|---|
| M1 | OS 실행 → Desk 기본 표면 | EG-Desk, Firefox shell, Desk, Canvas, Sidebar, saved Agenda; 별도 Workspace 노드는 없음 | L-01 | Q-LIFE-01, Q-LIFE-02, Q-LIFE-03, Q-LIFE-04, Q-OBJ-02 | — |
| M2 | 실행 중 Desk → 재실행 복원 | 자동 Desk 세션 기록, saved Agenda 지속성, 보이는 표현 상태, view instance, resource/runtime/process; 정상 시작에는 유지·폐기 선택 항목이 없음 | L-02, L-03, SYS-01 | Q-LIFE-05, Q-RESTORE-01, Q-RESTORE-02, Q-RESTORE-03, Q-RESTORE-04, Q-RESTORE-05, Q-RESTORE-06, Q-RESTORE-07, Q-RESTORE-08 | — |
| M3 | resource entry → runtime evidence | resource entry, file/folder picker, locator, availability, authority, neutral view, view instance, resource runtime; Card·Desk Window는 명칭 미결정 | V-01, TOOL-02, BROWSER-03 | Q-VIEW-01, Q-VIEW-02, Q-VIEW-03, Q-VIEW-09, Q-VIEW-11 | — |
| M4 | Browser → Agenda 후보 | Browser, Firefox profile/container/account, content identity, locator, available action, SourceRef, evidence lineage, external-effect status, Agenda | TOOL-01, BROWSER-01, BROWSER-02, BROWSER-03, BROWSER-04 | Q-AUTH-01, Q-AUTH-02, Q-AUTH-03, Q-AUTH-04, Q-AUTH-05, Q-AUTH-07, Q-AUTH-08, Q-BROWSER-01, Q-BROWSER-02, Q-BROWSER-03 | — |
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
| M14 | Desk intent → Agenda lifecycle end | Agenda, saved Agenda, Sidebar row, revision, opened projection, save-as/update, archive/close, delete/recovery | AG-01, AG-02, AG-03, AG-04 | Q-AG-01, Q-AG-02, Q-AG-03, Q-AG-04, Q-AG-05, Q-AG-06, Q-AG-07, Q-AG-08, Q-AG-09, Q-AG-10, Q-AG-11, Q-AG-12, Q-AG-13, Q-AG-14, Q-AG-15, Q-AG-16, Q-AG-17, Q-AG-19, Q-AG-20, Q-OBJ-01, Q-OBJ-04 | — |
| M15 | Canvas viewport → target focus/open | Canvas viewport, view, Card/Desk Window 명칭 후보, geometry/group, search, Library 후보, result focus | V-01, V-02, V-03, DISC-01 | Q-VIEW-04, Q-VIEW-05, Q-VIEW-06, Q-VIEW-07, Q-VIEW-08, Q-VIEW-10, Q-VIEW-12, Q-VIEW-13, Q-DISC-01, Q-DISC-02, Q-DISC-03, Q-LIB-01, Q-OBJ-03, Q-OBJ-05 | — |
| M16 | Agent room entry → reentry / 공유 대화 형식 후보 | Agent/persona 담당자 방, conversation projection, composer, request, Answer projection, workroom·Thread·Agenda-linked conversation 등 미결정 공유 형식 | CHAT-01, AI-01, AI-03 | Q-CHAT-01, Q-CHAT-02, Q-CHAT-03, Q-AI-06, Q-AI-12, Q-AI-13, Q-OBJ-06 | — |
| M17 | Terminal entry → 재진입 분류 | Terminal view, bridge/helper/transport/provider conversation 경계, process identity/liveness, snapshot, reconnect/new process/unavailable | L-02, TERM-01, SYS-01 | Q-TERM-01, Q-TERM-02, Q-TERM-03, Q-TERM-04, Q-TERM-05, Q-AGENT-20 | — |
| M18 | Canvas target·position → annotation 재진입 | visual mark, anchored Canvas Memo, 분리된 작성자·Agent reply, Agent room reference, provenance, acceptance와 persistence | CANVAS-01 | Q-MEDIA-06, Q-MEDIA-13 | — |
| M19 | keyboard entry → 상태·다음 행동 | focus, input owner, keyboard/accessibility path, nonvisual Canvas/Answer Briefing, reduced motion, 반복 가능한 성공·복구 acceptance | UX-01 및 43개 trace 횡단 | Q-UX-01, Q-UX-02, Q-UX-03, Q-UX-04, Q-AGENT-19 | — |

### 15.2 커버리지 결론

- Aspect map: 21개.
- trace: 43/43개가 map과 전수 색인에 포함됨.
- 미결정 question: 175/175개가 coverage matrix의 1차 배정에 포함됨.
- approval gate: 6/6개가 승인 edge와 matrix에 포함됨.
- 확정·일부 결정 필요·runtime-only·비객체 개념은 모두 적어도 하나의 map 또는 object coverage 행에 포함됨.
- 지도 어디에도 별도 Workspace, 일반 대기 Token 또는 고정된 외부 관찰 화면 이름을 제품 객체로 두지 않았고, Chat과 Agent runtime 사이에는 System binding이 유지됨.

<a id="doc-question-registry"></a>

## 16. 세부 UI 연구와 `Q-*` registry

아래 175개 `Q-*`는 기존 anchor를 깨지 않기 위한 상세 설계·조사 색인이다. 정확한
레이블·위치·키보드·재시도 표현과 이전 제품 질문이 섞여 있으므로 제품 소유자가
175개를 차례로 답하는 목록이 아니다. 제품 의미를 바꾸는 질문은 별도
[18개 `HUM-*` 사용자 확인 목록](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#gap-owner-queue)이
정본이며, 관련 Q는 Governance의 전수 매핑을 통해 해당 결정 아래에서 함께 해소한다. 답에 의존하는 범위만
열어 두고 독립적인 로컬 설계·구현·조사·검증은 계속한다.

| 이 절의 Q 묶음 | 상위 사용자 결정 |
|---|---|
| Desk·Agenda 객체와 수명주기 | [HUM-DESK-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-desk-001), [HUM-AGENDA-001](./egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-agenda-001) |
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

| ID | 아직 정해야 할 제품 동작 | 영향받는 흐름 |
|---|---|---|
| <a id="atlas-q-obj-01"></a>`Q-OBJ-01` | **결정됨** — 기본 제품 모델은 하나의 Desk다. 다중 Desk를 Agenda 분리나 메모리 최적화 수단으로 도입하지 않는다. | AG-02, COL-01, DATA-01 |
| <a id="atlas-q-obj-02"></a>`Q-OBJ-02` | **결정됨** — Desk에는 하나의 Canvas가 속한다. 사용자나 Agent의 의미 있는 활성·sleeping·snapshot 작업은 그 Canvas에서 찾을 수 있는 표현을 가진다. | L-01, L-02, V-02, V-03 |
| <a id="atlas-q-obj-03"></a>`Q-OBJ-03` | 활성 화면을 Card, Desk Window, View라고 부르는가, 아니면 각각 별개의 개념인가? Card는 구체적으로 무엇을 의미하는가? | 모든 리소스/뷰 흐름 |
| <a id="atlas-q-obj-04"></a>`Q-OBJ-04` | **확정 경계**: 하나의 Canvas에 여러 Saved Agenda projection을 동시에 열 수 있다. **남은 질문**: Agenda projection의 시각적 경계, 겹침 회피, 활성 Agenda 표시와 여러 Agenda에 걸친 view의 귀속을 어떻게 보여 주는가? | AG-02, AG-03, V-02 |
| <a id="atlas-q-obj-05"></a>`Q-OBJ-05` | Library는 최종적으로 일급 제품 영역인가? 그곳에는 저장된 Agenda, 파일 또는 출력과 구분하여 무엇이 속하는가? | DISC-01, DATA-01 |
| <a id="atlas-q-obj-06"></a>`Q-OBJ-06` | Agent/persona별 담당자 방과 별도로 여러 사람·Agent가 참여하는 공유 작업 대화 capability의 최종 형식은 workroom, 일반 Thread, Agenda-linked conversation 또는 다른 Chat relation 중 무엇인가? 선택한 형식에서 참여자·소유권·지속성·개인정보·Agenda 관계와 생성·열기·공유·재진입 UI는 어떻게 동작하는가? | AI-03, COL-01 |
| <a id="atlas-q-obj-07"></a>`Q-OBJ-07` | 하나의 제품 사용자 요청 아래에서 Run, Task, Agent 기여, 통합 Result, 하나의 논리적 Answer, 매체별 표현, 산출물의 동일성·다중성·사용자 대상 명칭은 각각 무엇인가? Chat과 Canvas가 같은 Answer를 표현한다는 관계는 다시 열지 않는다. | AI-01, AI-04, AI-06 |

### 실행 및 복구

| ID | 아직 정해야 할 제품 동작 | 영향받는 흐름 |
|---|---|---|
| <a id="atlas-q-life-01"></a>`Q-LIFE-01` | 어떤 운영체제 실행 진입점 변형을 문서화하고 테스트하는가? | L-01, L-02 |
| <a id="atlas-q-life-02"></a>`Q-LIFE-02` | 프로세스 시작부터 사용할 수 있는 Desk가 나타나기까지 포커스 및 접근성 알림을 포함하여 무엇이 표시되는가? | L-01 |
| <a id="atlas-q-life-03"></a>`Q-LIFE-03` | 셸 자체를 시작할 수 없을 때 정확히 어떤 UI와 다음 행동이 표시되는가? | L-01 |
| <a id="atlas-q-life-04"></a>`Q-LIFE-04` | 최초 사용/빈 Desk와 저장된 Agenda가 하나도 없는 사이드바에는 무엇이 표시되며, 정확히 어떤 행동이 제공되는가? | L-01 |
| <a id="atlas-q-life-05"></a>`Q-LIFE-05` | 표시되는 운영체제, 창 및 앱 메뉴의 종료 행동 가운데 무엇을 지원하며, 어떤 포커스/확인 동작이 앱 종료와 뷰 닫기를 구분하는가? | L-03 |
| <a id="atlas-q-restore-01"></a>`Q-RESTORE-01` | 제품 우선순위를 암시하지 않으면서 저장된 Agenda의 병렬 로딩과 Desk 복원을 어떻게 표현하는가? | L-02 |
| <a id="atlas-q-restore-02"></a>`Q-RESTORE-02` | 열려 있던 뷰, 위치와 크기, 그룹화, Canvas 이동/확대·축소, 저장되지 않은 편집기 콘텐츠, 채팅 및 일시적 출력 중 어떤 세션 세부 정보가 복원되는가? File view의 active caret·keyboard focus·transient text selection은 복원하지 않으며, scroll·보이는 위치와 명시적으로 고정한 annotation/range만 별도 정책에 따라 복원할 수 있다. | L-02, V-02, V-03 |
| <a id="atlas-q-restore-03"></a>`Q-RESTORE-03` | 누락되었거나, 거부되었거나, 손상되었거나, 오프라인이거나, 부분적으로 복원된 리소스를 정확히 어떤 뷰별 UI와 목록 수준 UI로 처리하는가? | L-02 |
| <a id="atlas-q-restore-04"></a>`Q-RESTORE-04` | Browser가 아닌 각 화면은 실행 중인 런타임과의 연결, 재구성된 뷰, 스냅샷 또는 명시적인 사용 불가 상태 중 무엇으로 복원되어야 하는가? | L-02, TERM-01 |
| <a id="atlas-q-restore-05"></a>`Q-RESTORE-05` | 정상 종료, 앱 충돌, 운영체제 재시작, 강제 종료 및 손상된 세션 기록으로부터의 복구 후에는 무엇이 달라지는가? | L-02 |
| <a id="atlas-q-restore-06"></a>`Q-RESTORE-06` | 저장된 Agenda 목록을 읽을 수 없을 때 정확히 어떤 사이드바 UI, 재시도 행동 및 영향받지 않은 Desk의 동작이 나타나는가? | L-02 |
| <a id="atlas-q-restore-07"></a>`Q-RESTORE-07` | 어떤 이벤트와 트랜잭션 주기로 자동 Desk 세션 기록을 업데이트하고, 쓰기 상태를 어떻게 표시하며, 쓰기 실패 후 정확히 어떤 재시도/진단 행동이 이어지는가? | L-03 |
| <a id="atlas-q-restore-08"></a>`Q-RESTORE-08` | 진행 중인 쓰기를 정상 종료, 충돌 및 강제 종료 시 각각 어떻게 플러시하거나 롤백하는가? 마지막 유효 기록은 어떻게 선택하는가? 그리고 유효하지 않은 기록 후에는 정확히 어떤 복구 행동이 이어지는가? | L-03 |

### Agenda 수명 주기

| ID | 아직 정해야 할 제품 동작 | 영향받는 흐름 |
|---|---|---|
| <a id="atlas-q-ag-01"></a>`Q-AG-01` | 새 Agenda는 빈 상태, 현재 Desk에서 명시적으로 선택한 항목 또는 별도로 정의된 범위 중 어디에서 시작하는가? 사용자가 구성원 포함 여부를 확인하기 전에 어떤 컨텍스트를 미리 채울 수 있는가? | AG-01 |
| <a id="atlas-q-ag-02"></a>`Q-AG-02` | 어떤 필드와 리소스/컨텍스트/실행 환경 구성원이 Agenda를 이루며, 그중 무엇이 필수인가? | AG-01 |
| <a id="atlas-q-ag-03"></a>`Q-AG-03` | 저장된 Agenda 행의 정확한 상호작용, 키보드 동작, 컨텍스트 메뉴 및 선택과 활성화의 구분 | AG-02 |
| <a id="atlas-q-ag-04"></a>`Q-AG-04` | 활성화된 Agenda 행과 해당 Canvas 영역에 대한 Pending/open/partial/success 피드백 | AG-02 |
| <a id="atlas-q-ag-05"></a>`Q-AG-05` | 누락되었거나, 접근이 권한상 허용되지 않았거나, 현재 기준 또는 대상과 불일치하거나, 부분적으로만 사용 가능한 Agenda 구성원을 위한 정확한 UI | AG-02 |
| <a id="atlas-q-ag-06"></a>`Q-AG-06` | **결정됨** — 저장된 Agenda를 열면 기존 내용을 교체하거나 새 Desk를 만들지 않고 하나의 Canvas에 Agenda projection을 추가하거나 이미 열린 projection에 포커스한다. 정확한 초기 위치·겹침 회피·포커스 피드백은 `Q-AG-04`와 `Q-OBJ-04`가 다룬다. | AG-02 |
| <a id="atlas-q-ag-07"></a>`Q-AG-07` | Agenda 객체의 동일성, 대상 리비전 및 현재 Desk와의 관계 측면에서 최초 저장, 새 항목으로 저장 및 업데이트가 각각 무엇을 의미하는가? | AG-03 |
| <a id="atlas-q-ag-08"></a>`Q-AG-08` | 어떤 뷰, 리소스, 컨텍스트, 레이아웃, 출력 및 실행/워크플로 상태가 저장된 Agenda 리비전에 속하는가? | AG-03 |
| <a id="atlas-q-ag-09"></a>`Q-AG-09` | 저장된 Agenda 행의 정확한 행동 메뉴 트리거, 이름 변경 편집기, 유효성 검사, 확정/취소 컨트롤 및 포커스 복귀 | AG-04 |
| <a id="atlas-q-ag-10"></a>`Q-AG-10` | 정확한 생성 화면, 초기 포커스, 필드/구성원 유효성 검사, 취소 시 복귀, 성공 피드백 및 초안을 보존하는 영속화 실패 UI | AG-01 |
| <a id="atlas-q-ag-11"></a>`Q-AG-11` | **확정 경계**: Agenda 닫기는 Canvas projection을 제거하고 그 Agenda만 소유한 runtime을 종료하며 Saved Agenda는 Sidebar에 보존한다. **남은 질문**: 보관의 별도 의미, 공유 runtime의 소유권 표시, 정확한 다시 열기·보관 해제 상호작용은 무엇인가? | AG-04 |
| <a id="atlas-q-ag-12"></a>`Q-AG-12` | 삭제 확인 범위, 보존 기간, 참조, 복구 가능성, 복구 컨트롤 및 영구 삭제 경계 | AG-04 |
| <a id="atlas-q-ag-13"></a>`Q-AG-13` | 정확한 Agenda 생성 진입 화면, 표시되는 레이블/아이콘, 클릭 및 키보드 제스처, 그리고 생성 화면으로 들어갈 때의 포커스 전환 | AG-01 |
| <a id="atlas-q-ag-14"></a>`Q-AG-14` | 정확한 저장/새 항목으로 저장/업데이트 진입 컨트롤, 대상 선택, 레이블, 확인, 성공 피드백, 포커스 복귀 및 사용 불가 상태 | AG-03 |
| <a id="atlas-q-ag-15"></a>`Q-AG-15` | 저장됨/변경 있음 상태를 구분하는 정확한 표시와 다시 저장, 나가기, 현재 변경 사항 폐기, 취소 및 화면 이탈 방지 상호작용 | AG-03 |
| <a id="atlas-q-ag-16"></a>`Q-AG-16` | Agenda 리비전/충돌 의미 체계: 덮어쓰기와 새 리비전의 구분, 기준 리비전이 최신이 아님을 감지하는 방식, 병합 가능 여부, 이력 보존 및 정본으로 인정되는 결과 | AG-03 |
| <a id="atlas-q-ag-17"></a>`Q-AG-17` | 정확한 최신이 아닌 리비전/충돌 표시, 비교/병합/덮어쓰기/새 항목으로 저장/취소 컨트롤, 영속화 실패, 재시도 및 초안 보존 | AG-03 |
| <a id="atlas-q-ag-19"></a>`Q-AG-19` | 정확한 보관, 닫기, 다시 열기 및 보관 해제 진입점/행동, 영향 미리보기, 성공/실패, 실행 취소, 키보드 경로 및 포커스 복귀 | AG-04 |
| <a id="atlas-q-ag-20"></a>`Q-AG-20` | 정확한 삭제 진입점, 범위/영구성 확인, 취소/실패/재시도, 복구 진입점/행동, 사용 불가 상태, 키보드 경로 및 포커스 복귀 | AG-04 |

### 뷰, Canvas 및 탐색

| ID | 아직 정해야 할 제품 동작 | 영향받는 흐름 |
|---|---|---|
| <a id="atlas-q-view-01"></a>`Q-VIEW-01` | 리소스를 여는 최종 방식: 사이드바, Library, 파일 선택기, 끌어다 놓기, 명령 팔레트, Chat 링크, Canvas 행동 또는 기타 진입점 | V-01 |
| <a id="atlas-q-view-02"></a>`Q-VIEW-02` | 열기 피드백, 초기 배치/크기/포커스, 중복 리소스 동작 및 키보드 경로 | V-01 |
| <a id="atlas-q-view-03"></a>`Q-VIEW-03` | 정확한 사용 불가/미지원/권한 거부 UI 및 다음 행동 | V-01 |
| <a id="atlas-q-view-04"></a>`Q-VIEW-04` | 이동/크기 조정/포커스를 위한 포인터, 트랙패드, 터치 및 키보드 상호작용, 선택과 포커스의 구분, 스냅/충돌/경계 | V-02 |
| <a id="atlas-q-view-05"></a>`Q-VIEW-05` | 임시 그룹화와 Agenda 구성원 포함의 의미 차이, 그룹화의 지속 여부 및 중첩 그룹 허용 여부 | V-02 |
| <a id="atlas-q-view-06"></a>`Q-VIEW-06` | 최대화와 전체 화면의 구분, 유지되는 UI 외곽 요소/헤드업 표시 영역, 종료 동작 및 프레젠테이션 상태의 복원 여부 | V-02 |
| <a id="atlas-q-view-07"></a>`Q-VIEW-07` | **확정 경계**: Canvas viewport 밖 이동은 닫기나 suspend가 아니며 lifecycle은 view/runtime별로 판단한다. Agenda 닫기는 그 Agenda만 소유한 runtime을 종료한다. **남은 질문**: 단일 뷰 닫기, Agenda에서 뷰 제거, 공유 runtime 분리와 기반 resource/process 종료를 어떤 컨트롤로 구분하는가? | V-02, TERM-01 |
| <a id="atlas-q-view-08"></a>`Q-VIEW-08` | Canvas 탐색 제스처, 미니맵 역할, 경계, 이동/확대·축소 지속성, 키보드 대안 및 모션 감소 동작 | V-03 |
| <a id="atlas-q-view-09"></a>`Q-VIEW-09` | 각 리소스 유형에서 어떤 컨트롤이 네이티브이고 어떤 컨트롤이 맞춤 조정된 것인지, 입력을 누가 소유하는지, 어떤 화면상 확인 증거가 성공을 입증하는지, 그리고 어떤 리소스별 흐름이 실패/복구를 정의하는가? | V-01 |
| <a id="atlas-q-view-10"></a>`Q-VIEW-10` | 정확한 다중 선택, 그룹화, 그룹 해제, 그룹 들어가기/나오기, 키보드/포커스, 사용 불가, 실패 및 실행 취소 상호작용 | L-03, V-02 |
| <a id="atlas-q-view-11"></a>`Q-VIEW-11` | 승인된 모든 리소스 진입 화면의 정확한 컨트롤/레이블, 대상 선택, 클릭/키보드/드롭 제스처, 열기와 포커스 행동의 구분, 중복 처리, 대기/오류 상태 및 포커스 복귀 | V-01 |
| <a id="atlas-q-view-12"></a>`Q-VIEW-12` | 정확한 최대화, 전체 화면, 복원 및 이스케이프 컨트롤, 포인터/키보드 경로, 유지되는 복귀 어포던스, 포커스, 사용 불가 상태 및 실패 복구 | V-02 |
| <a id="atlas-q-view-13"></a>`Q-VIEW-13` | 정확한 뷰 닫기 컨트롤, 저장되지 않았거나 실행 중인 리소스의 확인, 취소/강제 선택, 닫기 실패, 키보드 경로 및 성공 또는 취소 후 포커스가 이동할 위치 | V-02 |
| <a id="atlas-q-disc-01"></a>`Q-DISC-01` | 전역 검색, Canvas 찾기, Agenda 검색, Library 검색 및 명령 팔레트 가운데 무엇이 서로 구별되는 화면인가? | V-03, DISC-01 |
| <a id="atlas-q-disc-02"></a>`Q-DISC-02` | 정확한 검색어 입력, 필터/범위/지우기 컨트롤, 진행 상태, 결과 유형/순위, 결과 없음/최신 상태가 아닌 결과 상태, 결과 포커스/열기 동작 및 개인정보 보호 경계 | V-03, DISC-01 |
| <a id="atlas-q-disc-03"></a>`Q-DISC-03` | 승인된 각 검색 화면의 정확한 진입 위치, 레이블/아이콘, 단축키, 클릭/키보드 행동, 초기 포커스, 범위 표시기, 닫기 및 포커스 복귀 동작 | V-03 |
| <a id="atlas-q-lib-01"></a>`Q-LIB-01` | Library가 승인되는 경우 정확한 진입 화면, 레이블/아이콘, 클릭/키보드 행동, 초기 포커스, 사용 불가 상태, 닫기 및 복귀 동작 | DISC-01 |

### 인공지능 요청, 대화 및 답변 미디어

| ID | 아직 정해야 할 제품 동작 | 영향받는 흐름 |
|---|---|---|
| <a id="atlas-q-chat-01"></a>`Q-CHAT-01` | **확정 경계**: 사람에게 보이는 기본 Chat 관계는 Agent/persona별 담당자 방이다. **남은 질문**: 같은 Agent 방 안에서 여러 업무를 어떻게 구분·재진입하고, Agent끼리 위임한 대화·진행 상태를 별도 workroom/supervision 화면 및 공유 대화와 어떻게 연결하는가? | CHAT-01, AI-03 |
| <a id="atlas-q-chat-02"></a>`Q-CHAT-02` | Dock의 정확한 Chat 아이콘·레이블과 Canvas에 열리는 Agent 방의 header·avatar·이름·message bubble 작성자, Agent 방 전환·설정 진입, message timeline, 요청 컨텍스트 영역, 작성기, 보내기, 활동 표시, Canvas 상태 연결, 중지, 키보드·포커스·빈 상태·이용 불가·재진입 동작 | CHAT-01 |
| <a id="atlas-q-chat-03"></a>`Q-CHAT-03` | Chat 기록, 초안 텍스트, 첨부 파일, 컨텍스트 참조, 작업/결과 상태 및 스크롤/포커스 상태 중 무엇이 닫기와 재시작 후에도 지속되는가? | CHAT-01, AI-05 |
| <a id="atlas-q-ai-01"></a>`Q-AI-01` | 어떤 제품 화면에서 Agent 요청을 시작할 수 있으며, 각 화면은 어떤 초안/첨부 파일/컨텍스트 대상 유형을 지원하는가? | CHAT-01, AI-01, CODE-01 |
| <a id="atlas-q-ai-02"></a>`Q-AI-02` | 정확한 보내기/실행/중지 컨트롤, 키보드 동작, 중복 제출 처리 및 요청 수락 피드백 | CHAT-01, AI-01 |
| <a id="atlas-q-ai-03"></a>`Q-AI-03` | 선택한 컨텍스트를 미리 보거나 수정해야 할 때 기본적으로 어떤 컨텍스트 사실이 표시되며, 어떤 민감한 범위 변경에 새로운 권한 결정이 필요한가? | AI-01, AI-02 |
| <a id="atlas-q-ai-04"></a>`Q-AI-04` | 제품 Task의 정본 상태 `queued`, `waiting-on-dependency`, `ready`, `running`, `approval-required`, `completed`, `failed`, `cancelled` 각각을 어떤 레이블·표시기·원인·시간과 다음 컨트롤로 보여 주는가? Chat의 `Agent 작업 중` `[ · · · ]` 애니메이션과 접근성 텍스트는 model/tool/Reader lifecycle을 어떻게 요약하는가? 클릭 시 Snapshot View에서 direct tool의 완전한 명명 결과 또는 Smart Read의 `[원본 캡처] [이 Agent에게 전달된 내용] [변환 관계]`를 어떻게 구분하며, `[현재 열기]`로 별도 Live View를 열고 `[비교]`로 역사적·현재 상태를 나란히 놓는 정확한 viewer·레이블·키보드·포커스·권한 거부 UI는 무엇인가? Snapshot View와 Live View가 별도 identity로 공존하고, direct 결과 뒤의 무표시 생략과 Smart Read lineage 은폐를 허용하지 않는 경계는 다시 열지 않는다. snapshot을 어느 기간·범위로 보존하고 secret·redaction·삭제 정책 때문에 열 수 없을 때 어떤 상태와 manifest/hash를 남기는가? 사용자 중지·재시도·timeout이 어느 Task 전이를 만들고, `partial`은 Task 상태가 아닌 여러 Task의 Result 종합 상태로 어디에 표시하며, Run 수명주기와 어떻게 구분하는가? | AI-01, READ-01, READ-02, AI-06 |
| <a id="atlas-q-ai-05"></a>`Q-AI-05` | 실행 시작 후 컨텍스트 수정 방식: 계속, 재시작, 포크 또는 새 요청 중 무엇이며, 어떤 출력이 유지되는가? | AI-02 |
| <a id="atlas-q-ai-06"></a>`Q-AI-06` | Agent 담당자 방과 공유 workroom/Thread의 생성·참여자·Agenda 관계·지속성·개인정보·작업 권한 및 이전 대화·Memo reference·컨텍스트가 전송될 수 있는 범위 | AI-03 |
| <a id="atlas-q-ai-07"></a>`Q-AI-07` | 어떤 Agent/제공자/프로필 선택지가 사용자에게 표시되며, 그중 하나를 선택할 때 어떤 기능/구성 정보가 반드시 보여야 하는가? | AI-01, AI-03, AI-06 |
| <a id="atlas-q-ai-08"></a>`Q-AI-08` | Agent 경로 지정 선택은 작업, 대화, Agenda 또는 앱 범위별로 어떻게 지속되며, 사용자는 언제 자동 경로 지정을 검사하거나 재정의할 수 있는가? | AI-01, AI-03, AI-06 |
| <a id="atlas-q-ai-09"></a>`Q-AI-09` | 각 Agent 또는 오케스트레이션하는 Agent가 어떤 작업 위임 권한을 받고 다른 Agent에게 넘길 수 있으며, 그 권한을 승인 없이 확장해서는 안 되는가? | AI-01, AI-03, AI-06, AUTH-01 |
| <a id="atlas-q-ai-10"></a>`Q-AI-10` | 승인된 모든 요청 진입 화면의 정확한 포커스/입력/편집/첨부 파일/컨텍스트 대상/취소 컨트롤, 키보드 경로, 초안 유효성 검사, 실패 상태 및 포커스 복귀 | AI-01, AI-04, CANVAS-01, CU-01 |
| <a id="atlas-q-ai-11"></a>`Q-AI-11` | Chat 작성기 위 요청 컨텍스트 영역의 context item 형태와 `[× 제거]`, item click 검사, `[이 요청에서 포함/제외]`, `[대상 추가]`, Agenda 연결, 권한 축소, 선택 이유, 유효성 검사, `[적용] [취소]`, `[Esc]`, 키보드 순서와 작성기 포커스 복귀의 정확한 UI | AI-02 |
| <a id="atlas-q-ai-12"></a>`Q-AI-12` | 정확한 Agent 방 전환과 공유 workroom/Thread 생성·열기·선택, 참여자·위임 관계 표시, 작성기, 보내기/위임, 중지/재시도, 키보드/포커스, 실패 및 재진입 컨트롤 | AI-03 |
| <a id="atlas-q-ai-13"></a>`Q-AI-13` | 정확한 컨텍스트 공유 진입점, 출처/대상/콘텐츠/참여자 선택, 미리보기, 확인/취소, 중복/개인정보 보호 경고, 실행 취소, 실패 및 포커스 복귀 | AI-03 |
| <a id="atlas-q-media-01"></a>`Q-MEDIA-01` | Agent가 답변 의미와 산출물 유형에 맞는 매체 구성을 제안하고 System이 지원·권한·렌더 상태를 검증한다는 전제에서, 어떤 Agent Observation Snapshot과 고정된 파생 산출물을 Answer의 비교·근거·표·원자료 report set로 선별하며 제품 사용자는 언제 이를 재정의할 수 있는가? 원자료는 도구 호출 당시의 읽기 전용 Snapshot View로 열리고, 파생 표·요약·차트는 해당 snapshot에서 원 source/runtime revision으로 이동할 수 있어야 한다는 경계는 다시 열지 않는다. Answer Briefing의 역사적 snapshot·고정 산출물과 제품 사용자가 다루는 현재 Live View가 같은 Canvas에 공존한다는 전제에서, raw tool trace 전체와 숨은 추론을 복사하지 않으면서도 selection·summary·visualization이 provenance를 끊지 않는 정확한 표시·편집·복구 규칙은 무엇인가? | AI-04 |
| <a id="atlas-q-media-02"></a>`Q-MEDIA-02` | 지속되는 도메인 객체를 새로 만들지 않는 탐색 어포던스로 Chat에서 Canvas target을 열거나 포커스하고 Canvas에서 원 Answer·Chat 위치로 돌아가는 정확한 컨트롤은 무엇인가? target이 누락·최신 아님·권한 거부인 경우, Chat 또는 Canvas 한쪽의 렌더 실패, 재시도·다시 연결·원위치 포커스 복귀와 재진입은 각각 어떻게 동작하는가? | AI-04 |
| <a id="atlas-q-media-03"></a>`Q-MEDIA-03` | 화면 간 편집, 출처, 정본 결과 위치, 동기화 및 삭제 동작 | AI-04 |
| <a id="atlas-q-media-04"></a>`Q-MEDIA-04` | 정본 제품명을 `Answer Briefing / 답변 브리핑`과 진입 레이블 `브리핑 보기`로 확정할 것인가? 이 기능은 제품 사용자에게 필요한 계획·증거·분석·결정·산출물을 시간·공간적으로 보여 주고 숨은 chain-of-thought를 노출하지 않는다는 전제에서, 하나의 Answer에 속한 Canvas projection의 어떤 산출물·visible target이 Briefing Step이 될 수 있고 Briefing Step 묶음·설명 순서·Focus Scope를 누가 작성·편집하며 무엇을 참조할 수 있는가? | AI-05 |
| <a id="atlas-q-media-05"></a>`Q-MEDIA-05` | Briefing Step 또는 Briefing Step이 가리키는 visible target에 다음 Chat으로 보낼 댓글을 붙일 수 있다는 전제에서, 정확히 어떤 대상에 누가 작성·읽기·편집·삭제·공유할 수 있으며 댓글을 Canvas drawing primitive와 어떻게 구별하는가? | AI-05 |
| <a id="atlas-q-media-06"></a>`Q-MEDIA-06` | **확정 경계**: Canvas annotation에는 도형형 시각 표식과 위치 고정형 Canvas Memo가 있다. Memo는 사용자 본문과 작성자별 짧은 답글을 분리하고 자동으로 긴 Chat으로 승격하지 않는다. **남은 질문**: 두 유형의 대상 모델, 수락 상태, 지속성, 출처, 원본 영향, target 누락과 Agent 방 mention 연결을 어떻게 표현하는가? 이것들은 Briefing Comment와 별개다. | CANVAS-01 |
| <a id="atlas-q-media-07"></a>`Q-MEDIA-07` | 정확한 “다음 Chat에 포함” 컨트롤, 첨부 파일 미리보기/유효성 검사, 최신 대상과 맞지 않거나 누락된 Briefing Step에 대한 피드백, 제거/다시 연결, 전달/전송 실패 및 재시도 동작 | AI-05 |
| <a id="atlas-q-media-08"></a>`Q-MEDIA-08` | 어떤 Briefing Comment와 Chat 초안/첨부 파일이 닫기나 재시작 후에도 지속되며, 해당 Answer Briefing 대상이 변경되거나 사라졌을 때 어떤 재진입 상태가 나타나는가? | AI-05, CHAT-01 |
| <a id="atlas-q-media-09"></a>`Q-MEDIA-09` | 정확한 Answer Briefing 진입점, Briefing Step 순서·목록, 이전·다음·직접 이동·전체 보기·종료 컨트롤, Focus Scope·카메라·포커스 동작, 키보드 경로 및 움직임 감소 프레젠테이션은 무엇인가? 자동 진행은 별도 owner 결정 없이는 전제하지 않는다. | AI-05 |
| <a id="atlas-q-media-10"></a>`Q-MEDIA-10` | Answer Briefing 지속성, 편집/버전 권한, 삭제, 공유, 동시 보기/편집 및 기반 답변/산출물과의 관계 | AI-05 |
| <a id="atlas-q-media-11"></a>`Q-MEDIA-11` | 정확한 Briefing Comment 생성/열기/편집/삭제/취소 컨트롤, 초안 유효성 검사, 저장/실패/실행 취소 상태, 키보드 경로, 포커스 복귀 및 편집 중 대상 유실 시 동작 | AI-05 |
| <a id="atlas-q-media-12"></a>`Q-MEDIA-12` | 연결된 Canvas 표현의 정확한 편집/삭제/동기화 컨트롤, Chat 영향 미리보기, 충돌/실패/재시도/실행 취소, 키보드 경로 및 포커스 복귀 | AI-04 |
| <a id="atlas-q-media-13"></a>`Q-MEDIA-13` | 정확한 Canvas 도형/주석 도구와 Memo UI: 대상 선택, 그리기·작성·이동·편집·레이블 변경·답글·수락·기각·삭제, Agent 방 mention 생성, 영속화, 실패·실행 취소, 키보드 경로, 포커스와 재진입 | CANVAS-01 |

### Agent Profile·Run 모델

| ID | 아직 정해야 할 제품 동작 | 영향받는 흐름 |
|---|---|---|
| <a id="atlas-q-agent-01"></a>`Q-AGENT-01` | 제품 사용자가 볼 수 있는 Agent, 표시 정체성, Agent Profile, Agent 실행체, Run, Task의 관계와 각각의 안정된 동일성은 무엇이며, Agent 선택·검사·자동 경로 지정 결과를 여는 정확한 UI와 필수 요약 정보는 무엇인가? | AGENT-01–AGENT-03, AI-01, AI-03, AI-06 |
| <a id="atlas-q-agent-02"></a>`Q-AGENT-02` | Profile은 앱·제품 사용자·Desk·Agenda·대화·조직 중 어느 범위가 소유·공유·상속하며, 생성·복제·편집·검토·활성·새 Chat 기본값 지정·대체·사용 중단·보관·롤백·삭제·이동·내보내기가 어떤 UI·권한·버전 전이로 동작하는가? 제품이 즉시 사용할 수 있는 기본 제공 Agent/Profile을 포함하는가, 설정 예시만 제공하는가, 전혀 제공하지 않는가? | AGENT-01, AGENT-03, DATA-01, COL-01 |
| <a id="atlas-q-agent-03"></a>`Q-AGENT-03` | provider·model·정확한 version의 선택·pinning·자동 routing·fallback·교체를 누가 결정하며, 비용·privacy·출력 특성·기능 차이와 변경 확인·승인 경계를 어느 UI에 표시하는가? | AGENT-01–AGENT-03, AI-01 |
| <a id="atlas-q-agent-04"></a>`Q-AGENT-04` | Profile에 선언된 capability, 현재 연결된 tool·provider의 availability, 한 Run에서 활성화된 기능을 어떤 표시와 상태로 구분하며, 기능 저하·비가용 때 대체·대기·재검사·실패·자동 복구 UI가 어떻게 동작하는가? | AGENT-01–AGENT-03, AI-06, CODE-01, CU-01 |
| <a id="atlas-q-agent-05"></a>`Q-AGENT-05` | Profile 권한 상한, Task 위임, account/resource authority, System policy, 승인, sandbox·network 제약이 한 Run에서 어떤 우선순위와 교집합으로 유효 권한을 만드는가? 행동별 검토 대상과 진입점, 대상·계정·예상 효과 미리보기, `허용`·`거부`·`취소`, 실행·검토 실패, 재시도, 원 대상 포커스 복귀와 재진입은 정확히 어떻게 동작하는가? | AGENT-01, AGENT-02, AUTH-01, TOOL-01, COL-01 |
| <a id="atlas-q-agent-06"></a>`Q-AGENT-06` | thread/task, 명시적 선택, Agenda, 임시 그룹·레이아웃, visible/focused resource, 최근 관련 상태, 계정·권한·실행 범위로 만든 context revision을 어디서 검사·수정·제외하고, 민감 범위·포함 이유와 변경 뒤 continue·restart·fork 의미를 어떻게 표시하는가? | AGENT-01–AGENT-03, AI-02, CHAT-01 |
| <a id="atlas-q-agent-07"></a>`Q-AGENT-07` | 대화·Agenda·Profile·제품 사용자·조직 Memory의 읽기/쓰기 범위, 자동 기록 조건, 검사·편집·삭제·내보내기·만료·이전·공유·동기화 경계는 무엇인가? 각 Run snapshot에는 실제 사용한 Memory ID·revision·scope와 포함 이유를 어떻게 남기고, 최신 아님·삭제됨·권한 거부 상태를 어떻게 표시하는가? | AGENT-01, AGENT-02, AI-02, CHAT-01, DATA-01 |
| <a id="atlas-q-agent-08"></a>`Q-AGENT-08` | credential handle을 생성·선택·검사·교체·만료·철회하는 정확한 UI와 secret 비노출 방식은 무엇이며, provider/account/resource 불일치와 새 외부 권한 승인 경계를 어떻게 복구하는가? | AGENT-01, AGENT-02, AUTH-01, TOOL-01 |
| <a id="atlas-q-agent-09"></a>`Q-AGENT-09` | Ontology binding의 scope·version을 선택·검사·교체하는 규칙과 누락·구버전·충돌 때 대기·거부·fallback·제품 사용자 개입 동작은 무엇인가? | AGENT-01–AGENT-03, ONT-01, ONT-02 |
| <a id="atlas-q-agent-10"></a>`Q-AGENT-10` | 시간·토큰·비용·네트워크·파일시스템·sandbox·동시성 제한을 누가 어느 범위에서 설정·조정하며, Run 중 상한 상태·초과 행동·확대 승인 경계를 어디에 표시하는가? | AGENT-01–AGENT-03, AI-06, CODE-01 |
| <a id="atlas-q-agent-11"></a>`Q-AGENT-11` | Runtime health, Run configuration snapshot, model/tool/context/Ontology/권한 결정, handoff, 비용, 출력·증거와 version을 사용자가 어느 수준으로 검사하고 무엇을 얼마나 보존·내보내기·삭제할 수 있는가? | AGENT-01–AGENT-03, AI-03, ONT-01, DATA-01 |
| <a id="atlas-q-agent-12"></a>`Q-AGENT-12` | Chat·Canvas에서 Agent/Profile/Run/Task/context/Result의 관계와 상태를 각각 어떤 표현으로 보여 주고, 중복된 긴 본문 없이 어떤 컨트롤로 상세 정보·증거·원 실행을 여는가? | AGENT-01–AGENT-03, AI-03–AI-05, CANVAS-01 |
| <a id="atlas-q-agent-13"></a>`Q-AGENT-13` | 제품 사용자 요청, 선택한 conversation context, Profile instructions·personality, 제품 System policy와 provider policy·guardrail은 어떤 우선순위로 effective instruction을 만들며, 각 항목 중 무엇을 원문·요약·version·hash로 누구에게 보여 주고 누가 편집할 수 있는가? 충돌·무효화·노출 제한은 어느 UI에서 어떻게 설명하는가? | AGENT-01, AGENT-02, AUTH-01 |
| <a id="atlas-q-agent-14"></a>`Q-AGENT-14` | Run, execution attempt, resume, retry, fork, checkpoint, 새 요청, cancel, timeout, expiry의 최종 객체 관계와 상태 전이는 무엇인가? 전환 진입점, 차이·보존·외부 효과 미리보기, `확정`·`취소`, 실패·재시도, 원 Run 포커스 복귀·재진입과 기존 메시지·출력·증거 보존을 정확히 어떻게 보장하는가? | AGENT-01–AGENT-03, AI-02, AI-06 |
| <a id="atlas-q-agent-15"></a>`Q-AGENT-15` | 상위 Run·Task가 하위 Agent·Task에 위임할 수 있는 scope, child configuration/context snapshot, dependency 상태, 결과 귀속과 권한 비확대 규칙은 무엇인가? | AGENT-02, AI-06, AI-07 |
| <a id="atlas-q-agent-16"></a>`Q-AGENT-16` | Profile·provider·model·tool·Ontology·credential·권한 상태가 실행 중 바뀌었을 때 현재 Run을 계속·중지·재검증·같은 Run의 새 attempt·새 Run fork 중 어디로 전환하는가? 변경 알림과 전환 확인·취소 UI, 차이 미리보기, 실패·재시도, 원 Run 포커스 복귀와 재진입은 어떻게 동작하는가? | AGENT-01–AGENT-03, SYS-01 |
| <a id="atlas-q-agent-17"></a>`Q-AGENT-17` | relation map의 제품 의미·version·검사·편집·거버넌스는 무엇이며, 이를 특정 module/framework/runtime topology를 강제하는 설계도로 오해하지 않게 어떤 관점별 UI와 문서 표현을 사용하는가? | AI-02, AI-06, ONT-01, ONT-02 |
| <a id="atlas-q-agent-18"></a>`Q-AGENT-18` | 모든 Agent 제어 활동을 Desk에서 어디까지 보이게 투영하며, contributor·status·scope·evidence·integration result의 위치·밀도·보존과 raw agent chatter 제외를 어떻게 처리하는가? | AGENT-02, AI-03, AI-06, AI-07, CODE-01, TERM-01, CU-01 |
| <a id="atlas-q-agent-19"></a>`Q-AGENT-19` | 핵심 성공·복구 흐름의 반복 가능한 acceptance 시나리오, 반복 횟수, 허용 편차, 장애 주입, evidence 묶음, last checked, version 변화 뒤 회귀·재검증 규칙은 무엇인가? | 모든 trace, 특히 L-01–L-03, AI-01, AI-06, TERM-01, CU-01, SYS-01 |
| <a id="atlas-q-agent-20"></a>`Q-AGENT-20` | bridge/helper/transport/provider conversation/process/view별 health를 어느 UI에서 구분하며, 원인 미확정·last checked·영향 범위를 어떻게 표시하는가? 경계별 `다시 검사`·`재연결`·`새 실행`·`snapshot 열기`·`대체`·`중지` 컨트롤, 확정·취소, 실패·재시도·포커스 복귀와 복구 후 검증 화면 재진입은 정확히 어떻게 동작하는가? | SYS-01, L-02, V-01, TERM-01, CU-01 |

### 오케스트레이션 및 승인

| ID | 아직 정해야 할 제품 동작 | 영향받는 흐름 |
|---|---|---|
| <a id="atlas-q-orch-01"></a>`Q-ORCH-01` | 작업/종속성 표현, 가시성, 소유권, 비용/진행 정보 및 사용자의 순서 변경/재할당 권한 | AI-06 |
| <a id="atlas-q-orch-02"></a>`Q-ORCH-02` | 어떤 종속성 실패가 어떤 하위 작업을 차단하는지, 독립적인 성공을 어떻게 보존하는지, 그리고 부분 결과가 언제 최종 종합에 들어갈 수 있는지 | AI-06 |
| <a id="atlas-q-orch-03"></a>`Q-ORCH-03` | 일괄로 묶인 승인 필요 결정은 어느 검토 시점에, 기존 또는 새로운 어떤 제품 화면에서 제시되는가? 대기열 객체는 전제하지 않는다 | AI-07, AUTH-01 |
| <a id="atlas-q-orch-04"></a>`Q-ORCH-04` | 각 작업 상태에서 어떤 취소, 재시도, 시간 초과, 재할당 및 대체 경로 전환을 허용하며, 이러한 전환이 실행 중이거나 종속되었거나 완료된 작업에 어떤 영향을 주는가? | AI-06 |
| <a id="atlas-q-orch-05"></a>`Q-ORCH-05` | 요청된 행동 중 어떤 것이 새로운 외부 인프라, 자격 증명, 외부 데이터, 비용, 배포 또는 실질적으로 더 넓은 권한에 대한 확인된 승인 경계를 넘는가? 도메인 사례를 `A-INFRA-*`와 `A-AUTH-*` 중 하나에 어떻게 한 번만 매핑하는가? 그리고 어떤 경계선 사례, 철회 또는 만료 규칙이 적용되는가? | AI-07, AUTH-01, BROWSER-02, BROWSER-04 |
| <a id="atlas-q-orch-06"></a>`Q-ORCH-06` | 정확한 승인/거부/보류 컨트롤, 결정 패키지 레이아웃, 영향받는 작업 탐색, 포커스/키보드 동작, 확인 및 오류/재시도 피드백 | AI-07, AUTH-01 |
| <a id="atlas-q-orch-07"></a>`Q-ORCH-07` | 외부 인프라·credential·비용·배포·민감 데이터·새 권한의 최종 승인권은 제품 소유자에게 있다는 전제에서, 어떤 범위를 누구에게 위임할 수 있고 승인·위임은 얼마나 지속되며 어떻게 철회·감사·알림 처리하는가? | AI-07, AUTH-01 |
| <a id="atlas-q-orch-08"></a>`Q-ORCH-08` | 정확한 작업 선택 및 취소/재시도/재할당/대체 경로 진입점, 영향 미리보기, 확인/취소, 대기/실패, 키보드 경로 및 포커스 복귀 | AI-06 |
### 계정, 출처, 파일, 코딩 및 Terminal

| ID | 아직 정해야 할 제품 동작 | 영향받는 흐름 |
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
| <a id="atlas-q-term-02"></a>`Q-TERM-02` | Terminal view 닫기, transport 분리, process 종료, 고정/백그라운드, read-only final-output snapshot이 서로 다른 행동이라는 전제에서 각 컨트롤·확인·결과와 process 종료 뒤 snapshot 보존 범위는 무엇인가? | TERM-01 |
| <a id="atlas-q-term-03"></a>`Q-TERM-03` | 통신 연결 재수립, 검증된 동일 세션 재연결, 새 프로세스 재실행, 스냅샷 전용 복원, 프로세스/세션 동일성 확인 실패 및 재진입 UI | TERM-01, L-02 |
| <a id="atlas-q-term-04"></a>`Q-TERM-04` | 정확한 선택적 Terminal 진입/열기 컨트롤, 새 세션 시작 대 기존 세션 연결 선택, 현재 작업 디렉터리/세션 표시, 대기/실패, 키보드 경로, 초기 포커스 및 복귀 동작 | TERM-01 |
| <a id="atlas-q-term-05"></a>`Q-TERM-05` | 정확한 닫기/분리/종료/고정/백그라운드/스냅샷 컨트롤, 영향 미리보기, 확인/취소, 포그라운드 프로세스 상태, 실패, 키보드 경로 및 포커스 복귀 | TERM-01 |

### Ontology, 협업 및 computer-use

| ID | 아직 정해야 할 제품 동작 | 영향받는 흐름 |
|---|---|---|
| <a id="atlas-q-ont-01"></a>`Q-ONT-01` | 검사 뷰가 어떤 Ontology 계층, 시간/증거 관계, 개념/제약 및 선택된 사이클/실행 관계를 노출할지 | ONT-01 |
| <a id="atlas-q-ont-02"></a>`Q-ONT-02` | Agent 사이클에 대해 어떤 Ontology 버전/출처 추적/증거 연결이 보이는지, 어디에 나타나는지, 알 수 없거나 최신 상태가 아닌 연결을 어떻게 나타내는지 | ONT-01, ONT-02 |
| <a id="atlas-q-ont-03"></a>`Q-ONT-03` | 최종 사용자 또는 Agent가 Ontology를 제안/편집할 수 있는지와 검증, 검토 권한, 승격, 충돌, 롤백 및 감사에 관한 거버넌스 의미론 | ONT-01, ONT-02 |
| <a id="atlas-q-ont-04"></a>`Q-ONT-04` | 정확한 Ontology 뷰 진입부, 실행/사이클 선택기, 계층/시간/증거 필터, 출처 추적/버전 검사기, 사용 불가/최신 상태 아님 표시, 키보드/포커스 및 재진입 컨트롤 | ONT-01, ONT-02 |
| <a id="atlas-q-ont-05"></a>`Q-ONT-05` | 편집이 허용되는 경우, 정확한 제안/편집/검증/검토/승인/거부/승격/롤백 컨트롤, 충돌/실패/감사 표시, 키보드 경로 및 포커스 복귀 | ONT-01, ONT-02 |
| <a id="atlas-q-col-01"></a>`Q-COL-01` | Desk, Agenda, 선택된 뷰, Thread, 산출물 또는 그 조합 중 무엇을 공유할 수 있는지와 권한이 있는 어떤 역할이 공유를 시작할 수 있는지 | COL-01 |
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

| ID | 아직 정해야 할 제품 동작 | 영향받는 흐름 |
|---|---|---|
| <a id="atlas-q-data-01"></a>`Q-DATA-01` | 설정 정보 아키텍처 및 범위: 앱, Desk, Agenda, 계정/프로필, Agent, 협업자, 기기 | DATA-01 |
| <a id="atlas-q-data-02"></a>`Q-DATA-02` | 로컬 내보내기/백업 콘텐츠, 형식, 목적지, 자격 증명 제외, 암호화, 보존 및 검증 | DATA-01 |
| <a id="atlas-q-data-03"></a>`Q-DATA-03` | 가져오기/복원 미리보기, 병합/덮어쓰기, 충돌, 롤백, 버전 호환성 및 성공적인 복원의 증거 | DATA-01 |
| <a id="atlas-q-data-04"></a>`Q-DATA-04` | 로컬 기록, 감사 로그, 캐시, 생성된 산출물, 자격 증명 및 사용자 데이터의 보존/삭제/초기화 동작 | DATA-01, 모든 Agent 흐름 |
| <a id="atlas-q-data-05"></a>`Q-DATA-05` | 동기화가 승인되는 경우, 동기화할 객체/상태, 오프라인 편집, 충돌 소유권, 기기 제거, 암호화, 마이그레이션, 내보내기 및 삭제 | DATA-01, COL-01 |
| <a id="atlas-q-data-06"></a>`Q-DATA-06` | 정확한 설정 진입 화면, 레이블/아이콘, 클릭 및 키보드 행동, 초기 포커스, 범위 탐색 및 닫기/복귀 동작 | DATA-01 |
| <a id="atlas-q-data-07"></a>`Q-DATA-07` | 정확한 로컬 내보내기/백업 진입 컨트롤, 목적지 상호작용, 진행, 취소, 성공 접수 증거 및 실패 재시도 행동 | DATA-01 |
| <a id="atlas-q-data-08"></a>`Q-DATA-08` | 정확한 가져오기/복원 진입 컨트롤, 미리보기 탐색, 확인/취소, 충돌 해결, 롤백, 성공 증거 및 실패 재시도 행동 | DATA-01 |
| <a id="atlas-q-data-09"></a>`Q-DATA-09` | 정확한 원격 백업/동기화 요청 진입부, 승인 패키지 표시, 취소/연기 행동 및 승인 전 상태 | DATA-01 |
| <a id="atlas-q-ux-01"></a>`Q-UX-01` | 목표 접근성 기준선 및 지원되는 키보드, 화면 읽기 프로그램, 대비, 확대/축소, 언어 및 입력 모드 | 전체 |
| <a id="atlas-q-ux-02"></a>`Q-UX-02` | 사이드바, Canvas 뷰, 메뉴, 대화 상자, Chat 및 항목 닫기/제거에 대한 예측 가능한 포커스 이동 | 전체 |
| <a id="atlas-q-ux-03"></a>`Q-UX-03` | 비시각적 Canvas/Answer Briefing 표현 및 움직임 감소 대안 | V-03, AI-05, ONT-01 |
| <a id="atlas-q-ux-04"></a>`Q-UX-04` | 핵심 화면 키보드 순회 및 활성화 맵, 셸/리소스 뷰 전반의 단축키 소유권, 포커스 복구, 비활성/실행 가능 상태에 대한 접근성 안내, 오류/상태에 대한 접근성 안내 및 발견 가능성 | UX-01, 모든 흐름 |

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

- 43개 상세 흐름과 157개 행동 행이 시작 상태, UI 행동, 보이는 반응, System·Agent 처리, 상태 변화, 실패·복구·재진입과 완료 증거를 추적한다.
- 56개 제품·시스템 개념 항목이 화면에서 보이는 의미, System 책임, Agent 관계와 수명주기를 연결한다.
- 175개 질문 ID는 결정 이력을 포함해 제품 의미와 정확한 UI 행동을 추적한다. 현재
  `Q-OBJ-01`, `Q-OBJ-02`, `Q-AG-06` 3개는 `DECIDED`, 나머지 172개는 `OPEN`이다.
- 외부 인프라·자격 증명·비용·배포·민감 데이터·원격 동기화에 관한 6개 승인 게이트는 제품 결정 및 실행 성공과 분리되어 있다.
- 모든 trace 행은 제품 사용자 UI 행동, 보이는 반응, System 처리, Agent 처리, 상태 변화, 실패 후 다음 UI를 분리한다.
- 저장된 Agenda, 자동 Desk 세션, 표시 상태, 리소스/runtime, Agent Run, 권한, 제품 내부의 출처·증거, 원격 상태를 하나의 저장 단위나 동일성으로 합치지 않는다.
- `Workspace`, 정본 제품명으로서의 `Host Activity View`, 오케스트레이션 자체로서의 `Await Token`, 정상 시작의 복구 저널 항목은 제품 객체가 아니다.
- bridge/helper/transport/provider conversation/process/view 장애는 관찰된 경계까지만 말하고, 확인되지 않은 원인은 마지막 확인 상태와 함께 `원인 미확정`으로 남긴다.
- acceptance에는 일회성 성공 화면뿐 아니라 같은 범위에서 반복 가능한 성공과 실패 뒤 복구 확인이 포함된다.
- 제품 상태가 ‘결정됨’이라는 사실과 현재 구현·테스트·배포 완료 여부는 서로 다른 축이다.

완료 증거는 클릭, spinner, 화면 렌더링, Agent 보고, 파일 생성 시도 또는 `200 OK`와 구분한다. 각 흐름은 대상 revision·외부 receipt·독립 관찰·권한 상태 등 해당 결과를 실제로 입증하는 증거와 실패 후 다음 UI를 요구한다.
