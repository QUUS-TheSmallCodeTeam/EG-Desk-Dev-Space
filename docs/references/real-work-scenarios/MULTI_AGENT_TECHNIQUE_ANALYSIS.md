# Multi-agent 기법의 실업무 적용 분석

- **analysis_status**: `EVIDENCE-SYNTHESIS`
- **as_of**: `2026-08-31`
- **implementation_status**: `PROPOSED-POLICY / NOT-RUNTIME-PROOF`

이 문서는 Agent 수를 늘리는 것을 기본 해법으로 삼지 않는다. 실제 기록에서 context
isolation, fresh-context escape, role simulation, manager-worker, critic/judge, map/reduce와
handoff가 효율을 높인 경우와 오히려 실패를 키운 경우를 비교한다.

## 근거 사례

- [RWS-0002 Worktree·Integration 책임](./cases/rws-0002-worktree-integration-ownership.md#rws-0002)
- [RWS-0003 장문 map/reduce·독립 감사](./cases/rws-0003-bounded-map-reduce-semantic-audit.md#rws-0003)
- [RWS-0004 합의 착시·clean-room escape](./cases/rws-0004-consensus-illusion-clean-room-escape.md#rws-0004)
- [RWS-0006 blind context isolation](./cases/rws-0006-blind-reproduction-context-isolation.md#rws-0006)
- Grammar-ON, KUUS, Taehwatrans packet의 cross-project technique audit
- EG-Desk 부모 thread와 직접 child lineage의 2026-08-31 snapshot

부모 lineage snapshot에는 기존 작업의 직접 자식 74개가 있었고, 구조적 parent ID 없이
별도 fresh session으로 실행된 PM도 확인됐다. 같은 child thread가 여러 parent turn에서
재사용됐으므로 `child thread ID = 하나의 업무`로 볼 수 없다.

## 기법별 적용 계약

### Context isolation

| 항목 | 판단 |
|---|---|
| 해결하려는 문제 | 민감 자료 과공유, 정답 누설, 업무·역할·권한 혼합, 서로 다른 revision 오염 |
| trigger | PII·credential·서로 다른 domain authority가 등장하거나 blind reproduction이 필요할 때 |
| 유효 사례 | 급여 blind 재현, worker별 번역 section, read-only file mapper, parser worker와 single UI writer 분리 |
| 기대 효과 | 최소 공개, hidden assumption 발견, write 충돌과 정답 누설 감소 |
| 비용 | 자료를 다시 요청하고 packet을 만들며 결과를 merge하는 token·latency |
| 위험 | 중요한 예외·owner 결정 손실, 같은 원격 시스템 의미 충돌, privacy surface 확대 |
| acceptance | input revision·coverage·비공개 범주·write boundary·unknown stop·parent verification |

단순히 새 thread를 만드는 것은 context isolation이 아니다. 같은 dirty worktree, 같은 원격
DB, 같은 Browser tab을 공유하면 파일이나 대화만 분리되고 실제 자원은 격리되지 않는다.

### Fresh-context escape

| 항목 | 판단 |
|---|---|
| 해결하려는 문제 | stale cache·session, 반복된 잘못된 framing, compaction 누적, 과거 결론 anchoring |
| trigger | 같은 의미 교정이 두 번 이상 반복, 정의되지 않은 객체 발견, 기존 tab/client 2회 timeout, 24시간 이상 중단 또는 큰 revision drift |
| 유효 사례 | 새 agent type 활성화를 fresh session에서 검증, `Workspace` 오염 뒤 clean-room 재작성, stale Browser transport에서 fresh client, 장기 branch 재개 전 fetch·inventory |
| 기대 효과 | cache·전제·세션 고착 탈출, 최신 기준선 재구성 |
| 비용 | 이전 결정·권한·미완료 상태를 handoff packet으로 다시 읽는 비용 |
| 위험 | 유효한 과거 결정·local-only 상태 유실, provenance graph 단절, 중복 실행 |
| acceptance | allowed/excluded source manifest, last verified state, pending action, authority와 idempotency readback |

fresh context는 오류를 잊는 기능이 아니라, frozen fact packet으로 문제를 다시 구성하는
기능이어야 한다.

### Role simulation

| 항목 | 판단 |
|---|---|
| 해결하려는 문제 | 제품 사용자·PM·구현자·시각·보안 관점의 질문과 반례 부족 |
| trigger | frozen candidate가 있고 실제 사용자를 바로 만날 수 없으며 관점별 누락 질문이 필요할 때 |
| 유효 사례 | 청중별 deck critique, 제품 사용자 test lens, 문서 독자별 situated-speech 감사 |
| 기대 효과 | blind spot·질문·acceptance criterion 증가 |
| 비용 | 추가 critique 라운드와 finding disposition |
| 위험 | persona 취향을 실제 사용자 증거로 오인, 전문가·승인 권한 가장, 같은 framing 합의 착시 |
| acceptance | 모든 finding을 실제 source·UI 관찰·사용자 readback에 연결하고 `SIMULATED / NO AUTHORITY` 표시 |

Role simulation은 evidence나 권한이 아니다. 제품 소유자의 의미가 핵심이면 여러 PM의
투표보다 실제 사용자 readback이 우선한다.

### Manager-worker

| 항목 | 판단 |
|---|---|
| 해결하려는 문제 | 독립 write set·source group·domain task의 큰 작업량 |
| trigger | 결과 schema가 고정되고 세 개 이상의 독립 partition과 명확한 acceptance가 있을 때 |
| 유효 사례 | 장문 section translation, 대규모 archive inventory, 파일 mapper, bounded worktree edit |
| 기대 효과 | 병렬 처리와 실패 범위 격리 |
| 비용 | dispatch·handoff·merge·중복 제거와 slot scheduling |
| 위험 | worker가 같은 정본·live UI·원격 DB를 동시에 변경, manager의 정답 누설·결과 과신 |
| acceptance | disjoint ownership, source packet revision, artifact manifest, 단일 integration owner, 독립 검증 |

Worker가 산출물을 직접 정본화하지 않고 단일 integration owner가 writer·integrator를
유지하는 패턴이 가장 안정적이었다.

### Independent critic / judge

| 항목 | 판단 |
|---|---|
| 해결하려는 문제 | writer 자체 검사의 의미 오류, 과도한 완료, local·production 혼합 |
| trigger | candidate revision이 동결됐고 외부 효과·문서 정본·계산 결과를 완료로 승격하기 전 |
| 유효 사례 | 번역 의미 감사, 급여 ERP 후행 비교, deployment/receipt auditor, 문서 voice audit |
| 기대 효과 | 자기검증 편향·증거 승격 오류 발견 |
| 비용 | source 재읽기와 한 차례 추가 검증 |
| 위험 | mutable candidate를 보면 verdict stale, 같은 source framing이면 독립성 없음, critic이 수정·승인 권한을 확대 |
| acceptance | candidate hash, 독립 source packet, finding disposition, 완료 범위·child lifecycle 공개 |

Validator PASS와 critic PASS도 다른 상태다. 기계 검사는 ID·링크·구조를 검증할 수 있지만
제품 의미나 실제 사용자 타당성을 대신하지 않는다.

### Parallel map/reduce

| 항목 | 판단 |
|---|---|
| 해결하려는 문제 | 대량 문서·URL·독립 자료가 한 context에 들어가지 않는 문제 |
| trigger | 독립 source가 5개 이상이고 immutable snapshot과 공통 output schema가 있을 때 |
| 유효 사례 | 7구간 번역, 99-log thread inventory, 기관별 공고 mapper, 문서 archive 분류 |
| 기대 효과 | coverage와 처리속도 향상, 구간별 재시도 |
| 비용 | slot limit, duplicate source, reducer와 경계 overlap 처리 |
| 위험 | source 시각·revision 불일치, 개인정보가 여러 context로 복제, 같은 결과를 중복 사례화 |
| acceptance | frozen corpus manifest, 모든 source 정확히 한 번, overlap disposition, reducer dedupe |

Corpus를 실행 중 계속 확장하면 map/reduce가 끝나지 않는다. 한 wave를 동결·통합한 뒤 다음
wave를 시작해야 한다.

### Explicit handoff

| 항목 | 판단 |
|---|---|
| 해결하려는 문제 | 다른 사람·기기·계정·OS native UI·외부 권한이 필요한 경계 |
| trigger | secret·OTP·인증서·최종 submit·결제·다른 PC 증거·권한 부족 |
| 유효 사례 | secure login, portal submit, 다른 PC release, OAuth 증거 회수 |
| 기대 효과 | 실제 authority 보존, 민감값 미수집, 중복 외부 효과 방지 |
| 비용 | 사용자 중단·재개와 context packet 구성 |
| 위험 | 출발·도착 상태 불일치, 대상 device/account 혼동, 민감정보 과전달 |
| acceptance | 대상·시간·scope·금지행위·남은 action·resume condition·receipt를 명시 |

## 추가 Agent 금지 조건

- 하나의 authenticated Browser tab, secure modal, Excel workbook 또는 undo stack을 조작할 때
- DB publication, 외부 submit, 결제, 메일 send, merge·deploy처럼 중복 write가 치명적일 때
- exact ID 한 묶음을 label·delete·restore하는 작업
- 단일 설정 block 제거, smoke test, 간단 조회처럼 coordination 비용이 더 클 때
- source owner·business owner·action authority가 미확정일 때
- role simulation 결과를 실제 사용자·전문가 승인으로 사용할 위험이 있을 때

이 경우 단일 executor를 두고 필요하면 action 뒤 read-only auditor만 붙인다.

## Supervision capability 후보가 보존해야 할 최소 필드

```text
work_id
parent_episode_id
dispatch_id
child_thread_id + child_turn_id
agent_profile_revision
source_packet_revision
allowed / excluded context
privacy class
write set / live-surface lease
action authority
expected artifact
acceptance evidence
attempt / retry lineage
artifact revision
child lifecycle
remaining risk
parent disposition
```

child가 이전 turn에서 완료 artifact를 냈지만 마지막 후속 turn이 `started`라면 둘을 함께
표시한다. fresh-session child가 structural parent graph 밖에 있어도 integration dispatch
record로 원 업무와 연결한다.

## Supervision capability·Agent Room·Canvas의 후보 관계

- Agent Room은 사람과 담당 Agent의 관계·협의 표면이다.
- 별도 supervision capability가 채택된다면 위임·dependency·attempt·artifact·evidence·
  권한을 검사하는 projection을 제공한다.
- Canvas는 Task, live/snapshot resource, candidate와 result를 공간적으로 보여준다.
- Agent Room의 진행 표시와 message는 Canvas와 채택된 supervision 상태를 reference한다.
- raw chain-of-thought나 전체 child transcript는 기본 노출하지 않는다.

## 수용 기준 후보

1. 모든 child가 exact source packet과 write boundary를 가진다.
2. 동일 source·work item의 중복 dispatch를 탐지한다.
3. candidate revision이 바뀌면 기존 critic verdict를 stale 처리한다.
4. role simulation 결과에 권한 0과 evidence class를 표시한다.
5. context isolation test는 정답 비공개·coverage·unknown stop을 검증한다.
6. fresh-context resume는 last verified state와 pending action을 readback한다.
7. live UI·외부 write는 단일 executor lease를 강제한다.
8. 사용자 대상 통합 보고에 child lifecycle·감사 범위·미완료 위험이 포함된다.
9. wave별 corpus manifest와 overlap disposition이 닫힌 뒤 다음 wave를 시작한다.
10. 추가 Agent의 시간·token·오류 감소 효과를 단일 Agent 기준선과 비교한다.
