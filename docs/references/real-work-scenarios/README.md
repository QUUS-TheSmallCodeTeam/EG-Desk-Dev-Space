# EG-Desk 실업무 시나리오 사례집

이 사례집은 실제 대화와 작업에서 관찰된 목표, 행동, 인계, 오류, 정정과 완료 증거를
제품 설계에 재사용할 수 있는 형태로 정리한다. 가상 사용자를 먼저 만들지 않고
EG-Desk 개발, 다른 프로젝트의 실제 업무, 조사와 운영 기록에서 반복되는 작업
episode를 찾는다.

이 사례집은 제품 정본이 아니다. 사례에서 발견한 제품 함의는 후보이며, 제품 동작은
[사용자 매뉴얼 Atlas](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md),
기술 보장은
[기술 Contract](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md),
제품 소유자 결정은
[HUM 원장](../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md), 세부 질문과
문서 운영은
[Documentation Governance](../../codex/egdesk-product-documentation-governance.md)가 각각
소유한다.

원문을 직접 인용한 부분에 남은 `Agenda` 표기는 현재 제품 용어인 `Board`를 가리킨다.

## 사례집이 보존하는 것

각 사례는 다음을 분리해 기록한다.

- 당시 사용자가 달성하려 한 실제 목표와 시작 상태
- 사람, Agent, System, 외부 서비스와 각자의 권한
- 사용된 Browser, 파일, Chat, Terminal, Canvas, 포털과 산출물
- 관찰된 시간순 작업 흐름
- 잘못된 가정, 실패, 사용자 교정과 복구
- 당시 확인된 증거와 확인되지 않은 주장
- 같은 일을 EG-Desk에서 지원할 때의 목표 시나리오
- 제품 정본에 연결할 후보 함의와 아직 남은 질문

대화 thread 하나가 사례 하나라는 뜻은 아니다. 한 thread는 여러 업무 episode를
포함할 수 있고, 하나의 업무가 여러 thread·파일·commit·Agent 실행에 걸쳐 이어질 수도
있다. 사례 경계는 저장 위치가 아니라 목표, 책임자, 권한과 완료 조건이 바뀌는 지점에서
나눈다.

## 증거 언어

| 상태 | 뜻 |
|---|---|
| `OBSERVED` | 사용자 또는 참여자가 당시 화면·행동·불편을 직접 보고했다 |
| `VERIFIED-AS-OF` | 명시된 시점의 도구 출력·파일·외부 확인으로 범위가 검증됐다 |
| `INFERRED` | 관찰된 사실에서 가능한 원인이나 제품 함의를 추론했다 |
| `PROPOSED` | 향후 EG-Desk가 제공할 목표 흐름이나 해결책이다 |
| `UNKNOWN` | 원인·현재 상태·완료 여부를 확인할 증거가 없다 |
| `MIXED` | 사례 안의 claim들이 서로 다른 상태이므로 claim별 표기를 봐야 한다 |

`대화에서 완료라고 말함`, `파일이 생성됨`, `커밋됨`, `원격에 푸시됨`, `제출됨`,
`외부 시스템에서 접수됨`, `현재도 유효함`은 서로 다른 주장이다. 사례는 당시 확인
범위를 넘어서 현재 상태나 외부 성공을 확정하지 않는다.

## 사례와 SourceRef

- 사례 ID: `RWS-0001`
- 파일명: `rws-0001-<short-slug>.md`
- 사례 anchor: `rws-0001`
- 사례 claim: `RWS-0001-C01`
- 사례 내부 SourceRef: `RWS-0001-SR-01`

각 claim은 `- [VERIFIED-AS-OF] \`RWS-0001-C01\`: ...`처럼 ID 앞에 증거 상태를
반드시 붙인다. 사례 상단의 `evidence_state: MIXED`는 사례 전체가 검증됐다는 뜻이
아니라 claim별 상태가 섞여 있다는 뜻이다. `record_status`는 사례 성숙도,
`evidence_state`는 근거 종류, `as_of`는 출처 freshness를 나타내며 서로 대체하지 않는다.

ID와 anchor는 재사용하거나 재번호하지 않는다. 제목은 더 명확한 표현으로 바꿀 수
있다. 사례가 대체되거나 철회되면
[INDEX](./INDEX.md)에 `SUPERSEDED` 또는 `WITHDRAWN` 상태와 후속 ID를 남긴다.

SourceRef에는 원문을 복제하지 않고 다음 정보만 둔다.

- source kind와 permission-safe locator
- SourceRef별 `access_class`
- thread ID와 정확한 turn 범위 또는 안정적인 산출물 식별자
- 관찰·검토 시점과 알려진 revision/hash
- 접근 등급과 현재 resolution 상태
- 해당 SourceRef가 뒷받침하는 claim ID

`archive_owner`, `source_owner`, `business_owner`, `action_authority`는 서로 다르게 기록할
수 있다. 자료를 읽을 수 있다는 사실이 해당 계정이나 외부 시스템에서 행동할 권한을
뜻하지 않는다.

## 개별 사례의 기본 구조

1. 사례 요약과 상태
2. SourceRef와 지원 claim
3. 실제 목표·시작 상태
4. 참여자·책임·권한
5. 사용된 화면·리소스·산출물
6. 실제 시간순 흐름
7. 결정·반전·실패·교정
8. 증거 경계와 현재 상태 한계
9. 정규화된 EG-Desk 목표 시나리오
10. Browser tool-call fracture 분석 — Browser가 실제로 포함된 경우
11. cross-device context·handoff 분석 — 여러 기기·PC가 포함된 경우
12. multi-agent technique opportunity 분석
13. candidate product implications
14. Atlas·Contract·HUM·Q 연결 후보
15. 열린 질문과 coverage gap
16. privacy·redaction 기록

Browser 자동화가 포함된 사례는 `관찰 → locator → action → navigation/popup → wait →
재관찰` 순서에서 마지막으로 정상 확인된 상태와 최초 단절을 기록한다. 단절 원인은
site DOM/JS, tab·focus, renderer, 자동화 wrapper, 인증·권한, OS native UI, stale
revision, timeout/session과 외부 receipt 중 증거가 닿는 계층까지만 말한다. EG-Desk
대안은 semantic action, atomic compound action, Surface-local 좌표·revision 전제,
Agent 격리 renderer/focus, event-driven wait와 사용자 handoff를 비교하되 모든 사이트를
자동화할 수 있다고 주장하지 않는다.

Multi-agent 기법은 사례마다 다음 표로 평가할 수 있다.

| 항목 | 기록 내용 |
|---|---|
| 관찰된 문제 | 실제로 발생한 context 오염·권한 혼합·반복 오류·누락·병목 |
| 후보 기법 | context isolation, fresh-context escape, role simulation, manager-worker, specialist routing, critic/judge, adversarial review, map/reduce, handoff |
| 적용 trigger | 어떤 관찰 상태에서 기법을 시작하는가 |
| 기대 효과 | 누락·오염·latency·재작업 중 무엇을 줄이는가 |
| 비용·위험 | token·시간·중복·context loss·권한·privacy·합의 오류 |
| acceptance evidence | 실제 개선을 무엇으로 검증하는가 |
| 증거 상태 | 당시 실제 사용, 당시 제안, 사후 counterfactual 중 무엇인가 |

여기서 `context escape`는 현재 대화가 포화·stale·잘못된 framing에 고정됐을 때 fresh
session, fork, clean-room Agent 또는 재개 가능한 Reader로 문제를 다시 구성하는 분석
용어다. EG-Desk의 확정 제품 객체 이름이 아니다. Role simulation도 사용자나 전문가의
실제 증거를 대신하지 않으며 persona에 승인·권한을 부여하지 않는다. 단순 작업은 Agent를
늘릴수록 handoff와 중복 비용이 커질 수 있으므로 비적용 근거도 함께 남긴다.

## 제품 정본으로의 승격

```text
실제 SourceRef
  -> RWS 사례와 evidence-qualified claim
  -> 여러 사례에서 반복되는 pattern 후보
  -> PM의 제품 적합성·반례 검토
  -> Main의 기존 Atlas/Contract/HUM/Q 연결 판단
  -> 필요한 경우 제품 소유자 결정
  -> 승인된 변경만 제품 정본에 반영
```

사례 수가 많다는 이유만으로 기능을 확정하지 않는다. 반대로 실제 기록이 없는 위험한
권한·실패·동시성 경계는 `HYPOTHETICAL-COVERAGE`로 명시해 보충할 수 있다. 실제 사례와
가상 coverage 사례는 같은 증거 수준으로 취급하지 않는다.

여러 기기·PC가 포함된 사례는 사람·조직, device, account/profile, local workspace·file
revision, Browser session, Run/Task, local-only state와 마지막 외부 receipt를 분리한다.
한 기기의 `완료`나 동기화 표시는 다른 기기의 작업트리·열린 문서·실행 중 process·외부
상태를 자동 증명하지 않는다. Handoff에는 출발·도착 device, frozen context revision,
전달·제외 대상, 남은 행동, 권한, idempotency key와 재확인 조건을 둔다.

`PROPOSED`: Canvas 초대는 전체 device나 Desk를 암묵적으로 공유하지 않고, 선택된
Board, View, Workroom, artifact와 evidence만 shared projection으로 만드는 후보
규칙이다. local-only 파일·credential·비공개 Chat·raw desktop·process 상태·입력 제어는
각각 별도 동의·권한 후보로 남긴다. 원격 관찰과 원격 제어, collaborator 편집과 Agent
실행 권한을 서로 다른 상태로 분리하는 것 역시 제품 정본 승격 전 제안이다.

## 개인정보와 저장 경계

저장소에는 raw transcript, 이메일 본문, 고객·직원·학생의 실명, 계정 식별자,
credential·token·인증서 비밀번호, 금융·세무 식별값, Browser session, screenshot,
attachment 원문과 민감한 절대경로를 복제하지 않는다. 원자료는 기존 접근통제 위치에
남기고 사례에는 제한된 요약과 SourceRef만 둔다.

원자료가 삭제·이동·권한 철회·형식 오류로 확인되지 않으면 `INACCESSIBLE`, `MISSING`,
`STALE` 중 알맞은 상태를 남긴다. 현재 내용을 과거 증거로 대신하거나 새 출처를 만들어
누락을 숨기지 않는다.

## 전체 corpus와 읽는 순서

[INDEX](./INDEX.md)는 발견된 전체 thread corpus, 분석 상태, 사례 registry와 coverage
gap을 관리한다. 처음 읽을 때는 각 사례의 `[VERIFIED-AS-OF]`·`[OBSERVED]` claim을
업무 영역별로 보고, 이어서 `[INFERRED]`·`[PROPOSED]` pattern과 `OPEN` gap을 확인한다.

Browser 작업의 횡단 단절·복구 패턴과 우선순위는
[Browser 자동화 단절 분석](./BROWSER_FRACTURE_ANALYSIS.md)에서 별도로 확인한다.
실제 성공·실패 사례에 기반한 Agent 기법의 trigger·비용·금지조건은
[Multi-agent 기법 분석](./MULTI_AGENT_TECHNIQUE_ANALYSIS.md)에서 확인한다.
여러 기기·계정·runtime 사이의 재개와 선택적 Canvas 초대 후보는
[Multi-device Context·Handoff 분석](./MULTI_DEVICE_HANDOFF_ANALYSIS.md)에서 확인한다.

## wave 동결과 검증

첫 wave 10개 사례의 동결 revision은
[첫 wave manifest](./MANIFEST.wave-1.sha256)에 보존한다. 현재 32개 사례와 세 횡단
분석의 파일 revision은 [현재 manifest](./MANIFEST.sha256)에 기록한다. manifest는 파일
내용 변경을 탐지하기 위한 것이며, 원자료의 현재 유효성이나 제품 정본 승인을 뜻하지
않는다.

`scripts/validate-real-work-scenarios.mjs`는 사례 ID·anchor·필수 절·SourceRef와 claim의
고유성·연속 번호·INDEX registry·101개 packet disposition·로컬 문서 링크·금지된 민감
locator와 현재 manifest hash를 검사한다. 기계 검증을 통과한 뒤에도 독립 검토자가 근거
범위, 화자, 중복, 반례와 제품 정본 경계를 다시 검토한다.
