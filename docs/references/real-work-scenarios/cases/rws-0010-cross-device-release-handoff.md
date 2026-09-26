<a id="rws-0010"></a>
# RWS-0010 — 권한이 다른 기기 사이의 작업 재개와 release handoff

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-08-27`
- **business_owner**: Grammar-ON 제품 운영과 cross-device release
- **source_owner**: 각 device의 Git·로컬 환경·외부 provider 당시 상태
- **action_authority**: 작업 device는 branch·PR, release device/account는 merge·Production을 소유

## 요약

신규 작업 PC에서 저장소·DB·로컬 앱을 준비했지만 배포 권한과 migration 정합성이 없었고,
다른 권한 계정·PC가 최종 merge와 Production release를 맡았다. feature branch와 Draft PR은
handoff 수단으로 유효했지만 며칠 뒤 branch가 main보다 크게 뒤처지고 새로운 작업 branch가
생기면서 과거 대화만으로 재개할 수 없었다. cross-device handoff에는 device·account·branch·
working tree·외부 receipt·남은 권한 행동을 함께 전달해야 한다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0010-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `01a00ef1-78f4-7703-930c-58c7feeddc64`, turns 1–5 | 2026-08-17 | `RWS-0010-C01`–`RWS-0010-C04` | `RESOLVED` |
| `RWS-0010-SR-02` | Codex user thread | `LOCAL-RESTRICTED` | `01a0152c-b8ad-7ab1-ae0a-5f764d93ed9d`, turns 31–37·55–73·75–76 | 2026-08-19~27 | `RWS-0010-C01`–`RWS-0010-C06` | `RESOLVED` |

### Claims

- [VERIFIED-AS-OF] `RWS-0010-C01`: device, Codex identity, Git account, deployment account와 business role은
  별도 authority다.
- [VERIFIED-AS-OF] `RWS-0010-C02`: branch가 원격에 존재하거나 pull됐다는 사실은 working tree clean,
  merged, deployed 또는 current-state verified를 뜻하지 않는다.
- [PROPOSED] `RWS-0010-C03`: 권한이 다른 PC 간 handoff는 자유문장보다 frozen revision·검증·남은
  action과 owner를 가진 packet이 필요하다.
- [VERIFIED-AS-OF] `RWS-0010-C04`: local setup success와 migration·RLS·deployment readiness는 다른 상태다.
- [INFERRED] `RWS-0010-C05`: 장기 중단 뒤에는 이전 계획보다 최신 branch·PR·external state를 먼저
  다시 inventory해야 한다.
- [VERIFIED-AS-OF] `RWS-0010-C06`: release persona나 Agent가 실제 merge·deploy account authority를 대신할
  수 없다.
- [PROPOSED] `RWS-0010-C07`: Canvas 초대는 선택한 shared projection을 제공할 뿐 초대받은 device에
  원 device의 credential·local-only state·전체 Desk 권한을 복제하지 않는다.

`RWS-0010-C07`은 원 thread에서 실행된 Canvas 협업의 증거가 아니라 cross-device 균열에서
도출한 제안이며 SourceRef의 `RESOLVED` 범위에 포함하지 않는다.

## 실제 업무 흐름

1. 비어 있는 신규 PC 작업공간에서 pull 대신 clone으로 시작했다.
2. 저장소·로컬 build·원격 DB 연결을 각각 확인했다.
3. deployment 접근권 부재와 migration ledger 불일치를 확인해 원격 쓰기를 중단했다.
4. 작업 PC는 feature branch·commit·PR을 만들 수 있지만 Production 배포는 다른 계정이
   소유함을 확인했다.
5. 처음에는 모든 자동 배포를 끄는 안을 검토했으나 feature Preview만 억제하고 main의
   Production 자동 배포는 유지하는 방향으로 교정했다.
6. release 계정이 PR을 merge commit으로 병합하고 branch 자동 삭제를 확인했다.
7. 아직 구현하지 않을 계획과 다른 PC 작업은 별도 branch·Draft PR로 전달했다.
8. 며칠 뒤 fetch했을 때 이전 branch는 main보다 크게 뒤처졌고 고유 commit과 새로운
   V2 branch가 함께 존재했다.
9. 이전 대화의 “이어서 하면 됨”을 그대로 실행하지 않고 branch·PR·working tree·권한과
   마지막 external state를 다시 분류했다.

## 결정·실패·교정

- 신규 PC 준비와 release readiness를 합치지 않았다.
- 작업 전달을 위해 미완료 코드를 main에 넣는 대신 remote branch·Draft PR을 사용했다.
- merge·Production authority를 실제 release account에 남겼다.
- 오래된 branch를 과거 대화만으로 계속하지 않고 divergence를 재확인했다.
- 다른 PC의 completion claim을 현재 device의 local state·external receipt로 확장하지 않았다.

## 증거 경계

| 상태 | 당시 증거 | 다음 상태가 아닌 이유 |
|---|---|---|
| local ready | clone·build·로컬 response | remote DB·deployment 권한 없음 |
| branch pushed | remote branch·SHA | PR 승인·merge 아님 |
| PR merged | merge commit·branch deletion | Production READY·alias·smoke 아님 |
| deployment pending/blocked | provider status | 완료 아님 |
| device synced | fetch/pull·branch equality | dirty file·local-only runtime·외부 상태 부재 아님 |
| handoff delivered | branch/PR·설명 | 상대 device가 실제 재개·완료함을 증명하지 않음 |

## Browser tool-call fracture

| 흐름 | 단절 | fault layer | 개선 |
|---|---|---|---|
| provider UI → profile/account 확인 → deployment status | 작업 account는 Git 쓰기 가능, deployment author gate 차단 | identity·authority | device/account/role envelope와 release handoff |
| 설정 read → branch condition → provider event | client-side setting보다 author gate가 먼저 실행 | provider ordering | capability preflight와 실제 receipt timeline |
| 장기 중단 → 기존 branch resume | branch가 main보다 크게 stale | revision·time | resume 전 fetch·PR·external state inventory |

## Cross-device context·handoff

### Device Context Envelope

```text
human / organization
device identity and online state
Codex account / engine profile
source account / connector account
local project root / worktree / branch
working tree + ignored/local-only state
Browser profile / session
Run / Task / artifact revision
last external receipt
action authority and remaining approvals
```

### Handoff Packet

```text
handoff_id + idempotency_key
from_device / intended recipient or role
business goal and frozen context revision
completed claims + exact evidence
pending actions + blocked reason
shared artifacts / excluded local state
branch / PR / DB / deployment revisions
required authority and user decision
resume preconditions + conflict policy
expiry / stale condition
```

### Canvas 초대 후보 흐름

1. Desk owner가 특정 Board 또는 Workroom/Task를 선택한다.
2. System이 포함할 View·artifact·message·evidence와 제외될 private/local-only 상태를
   preview한다.
3. collaborator의 role, 관찰·comment·edit·Agent delegation·control 권한을 각각 정한다.
4. 초대받은 device에는 선택한 shared projection만 나타난다.
5. 원 device의 Browser credential, private Agent Room, ignored file, raw desktop와 process는
   자동 공유되지 않는다.
6. remote device가 offline이거나 revision이 stale하면 current claim을 만들지 않는다.
7. collaborator action은 actor·device·revision에 귀속되고 conflict가 있으면 자동 merge보다
   owner review로 간다.
8. remote observation과 remote control·computer-use는 별도 동의·input ownership을 요구한다.

## EG-Desk 목표 시나리오

```text
제품 사용자: 다른 기기 또는 collaborator에게 작업 재개 요청
  -> System: Device Context Envelope와 shared-scope preview
  -> 사용자: 대상·권한·제외 범위 승인
  -> System: Handoff Packet과 Canvas projection 생성
  -> 도착 device: local·remote·external state preflight
  -> conflict/stale/duplicate action 검사
  -> 권한 있는 실행자: pending action만 수행
  -> integration 기능: result·receipt·remaining risk 종합
  -> shared Canvas에 actor·device·revision별 상태 갱신
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 관찰된 문제 | device와 account가 다른데 역할·권한·state를 대화로만 전달 |
| 후보 기법 | device-scoped context isolation, explicit handoff, fresh resume auditor, single release executor |
| trigger | 다른 PC·host·account가 다음 mutation을 수행하거나 24시간 이상 중단·큰 divergence가 있을 때 |
| 기대 효과 | stale 계획·중복 실행·권한 오인 감소, 재개 가능성 향상 |
| 비용·위험 | packet 작성·재검증 비용, local-only 누락, 민감정보 과전달, 동시 write conflict |
| acceptance | branch/PR/device/external inventory, excluded-state list, authority readback, receipt·current revision |
| 증거 상태 | branch/PR handoff와 release account 분리는 실제 사용; Canvas 초대 통합은 제안 |

다른 device에서 실행하는 Agent를 늘려도 shared remote DB·deployment는 자동 격리되지 않는다.
동일 external write는 하나의 executor만 소유하고 다른 Agent는 read-only mapper·auditor로
제한한다.

## Candidate product implications

- Device Context Envelope와 Handoff Packet을 first-class supervision capability 후보로 둔다.
- collaborator 초대 scope와 device runtime scope를 분리한다.
- branch/PR/file/DB/Browser/external receipt의 revision을 한 timeline에 연결한다.
- offline·stale·local-only·unknown 상태를 숨기지 않는다.
- remote observation, edit, Agent delegation, remote control 권한을 각각 관리한다.
- cross-device action에는 idempotency key와 conflict policy가 필요하다.
- 초대받은 사람의 활동과 Agent 활동을 명확히 귀속한다.

## 정본 연결 후보

- [Atlas COL-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-col-01)
- [Atlas DATA-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-data-01)
- [Contract §12 collaboration](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-collaboration-computer-use)
- [Contract §15 local storage·sync](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-storage-export)
- [HUM-COLLAB-001](../../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-collab-001)
- [HUM-REMOTE-001](../../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-remote-001)

## 열린 질문

- device identity와 사용자 identity를 어떤 안정적 ID·복구 절차로 연결하는가?
- Canvas 초대의 기본 shared scope와 private exclusion UI는 무엇인가?
- local-only file·unsaved form·running process를 handoff할 수 없는 상태로 어떻게 표현하는가?
- 두 device가 같은 Task를 실행했을 때 idempotency와 외부 효과 충돌을 어떻게 해결하는가?
- remote control·computer-use 화면을 shared Canvas에서 어떻게 동의·중지·감사하는가?
- device offline·분실·권한 철회 뒤 shared artifact와 credential을 어떻게 처리하는가?

## Privacy

device 이름, 사용자·계정 식별자, branch·URL·DB 값, 로컬 경로, credential, 실제 문서·화면은
복제하지 않았다. `PROPOSED`: Canvas 초대는 permission-safe projection만 공유하고
local-only state와 private conversation을 기본 제외하는 후보 규칙이다.
