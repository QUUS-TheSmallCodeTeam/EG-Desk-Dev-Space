# Multi-device Context·Handoff·Canvas 초대 분석

- **analysis_status**: `EVIDENCE-SYNTHESIS`
- **as_of**: `2026-08-31`
- **source_scope**: 교차 프로젝트 9개 원사례
- **implementation_status**: `PROPOSED-DESIGN / NO-REMOTE-COLLAB-RUNTIME-PROOF`

관찰된 균열에서 도출한 **후보 설계 결론**은 다음과 같다. 제품 정본 승인을 받은
불변조건이 아니다.

> EG-Desk는 기기 전체를 동기화하거나 넘기지 않는다. 업무, 정본 revision, 행위 권한,
> 선택된 공유 projection과 외부 receipt만 명시적으로 인계한다. Browser session,
> local file, process, credential과 unsaved input은 device-local 상태로 남긴다.

## Evidence cases

| ID | permission-safe SourceRef | 확인된 multi-device 균열 |
|---|---|---|
| MD-01 | `01a00ef1-78f4-7703-930c-58c7feeddc64`, T24–31 | 다른 PC의 “완료”와 branch·DB·Browser 상태 불일치 |
| MD-02 | `01a0152c-b8ad-7ab1-ae0a-5f764d93ed9d`, T1·T3·T28–35·T54–76 | branch·PR은 공유됐지만 worktree·권한·runtime은 인계되지 않음 |
| MD-03 | `019e5c69-a6a5-7ba2-a8ad-45f96f83303b`, T1·T3·T78·T80–86 | Drive 공통 지식층과 상시 실행기기의 local runtime 경계 |
| MD-04 | `01a03329-0a24-7543-9c75-fa0d1882579a`, T6–7 | Excel lock을 피했지만 durable pending handoff가 없어 재개 누락 |
| MD-05 | `019fc14c-2683-7de2-91ca-8be5c2138026`, T20–22 | Browser profile 표시명·로그인 account·tab 혼동 |
| MD-06 | `019fe76b-f5ed-7e20-851c-8bec9b97f44e`, T8–9 | 같은 mail object의 server·migration·client timestamp 차이 |
| MD-07 | `01a03330-f3d9-7ef2-aca5-5327a6494aae`, T2·T7·T10–17·T28–31 | 중앙 account event 하나가 여러 PC에 다른 증상으로 나타남 |
| MD-08 | `01a0254a-06c0-7e23-95c2-8f2167d42324`, T1 | Git source가 같아도 Firefox·bridge·process readiness는 device-local |
| MD-09 | `019f8d42-4886-7041-8421-c5e343d465e0`, T1–13 | 공유 canonical 설정과 local-only dependency·profile·port 분리 |

실제 EG-Desk collaborator 초대나 remote-control 실행은 발견되지 않았다. 아래 초대·제어
모델은 관찰된 균열에서 도출한 제안이며 현재 구현 증거가 아니다.

## 반복 fracture

| fracture | 실제로 반복된 현상 | EG-Desk 표시 후보 |
|---|---|---|
| Identity | 사람·device·Browser profile·account·workspace·Task 혼동 | 각각 별도 identity와 verified-at |
| Revision | unmerged branch, stale branch, workbook hash, DB·deployment revision 차이 | base/current revision과 stale reason |
| Authority | push 가능하지만 merge·deploy 불가, 자료 보임과 edit/approve 권한 다름 | observe·propose·edit·execute·approve·reconcile 분리 |
| Observation | server와 Outlook·Chrome·로컬 mount가 서로 다른 상태·시각을 표시 | observation source·time·surface |
| Lifecycle | source는 공유돼도 process·port·profile·unsaved input은 local | device-local badge와 readiness receipt |
| Concurrency | 두 Run이 같은 worktree·workbook을 겹쳐 사용 | resource claim·single writer lease |
| Completion | branch·push·DB·Browser·deployment를 하나로 보고 | 단계별 provider·business receipt |
| Privacy | Drive root·Desk·Chat 전체를 공유할 위험 | allow-list projection과 local-only exclusion |

## Device Context Envelope 후보

```yaml
schema: egdesk.device-context/v1
envelope_id: opaque
captured_at: timestamp
valid_until: timestamp
evidence:
  basis: tool_record | user_report | imported_record | synthesis | simulation
  verification: verified_as_of | observed_only | unverified | stale | inaccessible
  source_ref: opaque | null

device:
  ref: collaboration_scope_pseudonym
  class: desktop | laptop | server | mobile
  online_state: online | offline | unknown
  last_seen_at: timestamp

actor:
  person_ref: opaque
  session_ref: opaque
  presence: active | away | disconnected

workspace:
  project_ref: logical
  workspace_ref: opaque
  sync_backend: git | drive | provider | none
  base_revision: opaque
  current_revision: opaque
  dirty_state: clean | modified | unknown
  stale_reason: null | base_advanced | sync_pending | local_changes

browser:
  profile_ref: opaque_local_ref
  account_capability: authenticated | reauth_required | unknown
  tenant_ref: opaque
  selected_surface_ref: opaque
  observation: none | snapshot | live
  control: none | available | active

runtime:
  capabilities: [browser_shell, terminal, editor, local_server]
  state: stopped | starting | ready | degraded | unknown
  local_only: true
  readiness_receipt_ref: opaque

projections:
  - resource_ref: logical
    revision: opaque
    disclosure: summary | redacted_snapshot | live_view
    freshness: current | stale | unknown

authority:
  observe: [projection_ref]
  propose: [resource_ref]
  edit: [resource_ref]
  execute: [action_class]
  approve: [action_class]
  reconcile: [provider_ref]

privacy:
  excluded: [credentials, raw_local_paths, raw_desktop, private_chat, process_list, unsaved_input]
```

`device.ref`는 전역 hardware ID가 아니라 collaboration scope 안의 가명이다. local path와
account identity를 그대로 공유하지 않고 대상 device가 해석할 logical resource와
capability만 투영한다.

## Handoff Packet 후보

```yaml
schema: egdesk.handoff/v1
packet_id: opaque
work_id: opaque
agenda_ref: opaque
status: draft | offered | accepted | active | superseded | closed
from: {actor_ref, device_envelope_ref}
to: {participant_ref, accepted_device_envelope_ref}

goal:
  statement: concise
  completion_contract: [receipt_requirement]
  non_goals: [statement]

base:
  source_revisions: [{resource_ref, revision}]
  external_state_observed_at: timestamp

shared_projections:
  - {projection_ref, revision, redaction_policy, granted_capabilities}

local_only_dependencies:
  - {class: browser_auth | unsaved_file | runtime | credential,
     owner_device_ref, disclosure: presence_only, required_action}

authority:
  work_owner_ref: opaque
  run_owner_ref: opaque
  action_approver_refs: [opaque]
  receipt_reconciler_ref: opaque
  prohibited_actions: [action_class]

input_ownership:
  surface_ref: opaque
  mode: observe_only | control_requested | control_granted
  holder_ref: null | opaque
  lease_ref: null | opaque

pending_actions:
  - action_intent_id: opaque
    idempotency_key: opaque
    target_refs: [opaque]
    expected_revisions: [opaque]
    state: proposed | authorized | dispatched | uncertain
    retry_policy: query_before_replay

conflict_policy:
  strategy: abort | manual_merge | exclusive_writer | owner_decides
  stale_packet_action: rebase_and_reoffer

offline_policy:
  allow_local_draft: true
  allow_external_write: false
  reconnect_checks: [refresh_envelope, invalidate_leases, compare_revisions, reconcile_receipts]

resume_guard:
  first_step: inspect_exact_targets_and_receipts
  never_replay_from_ui_memory: true
```

## Canvas·Agenda 초대 후보 흐름

1. owner가 device나 Desk 전체가 아니라 특정 Agenda와 projection을 선택한다.
2. System은 공유될 View·artifact·message·evidence와 남을 local-only 상태를 preview한다.
3. participant별 `observe`, `comment`, `propose`, `edit`, `Agent delegation`, `control` 권한을
   각각 설정한다.
4. 수신자는 자신의 Device Context Envelope로 초대를 수락한다.
5. 첫 action 전 account capability, revision, resource claim과 receipt를 다시 확인한다.
6. shared Canvas에는 actor·device·revision별 activity와 evidence만 투영한다.
7. raw desktop·전체 Browser profile·private Chat·credential·process list·unsaved input은
   자동 공유하지 않는다.
8. remote observation과 remote control은 별도 동의·lease·emergency revoke를 요구한다.

| 표면 | 공유 후보 | 자동 공유 금지 |
|---|---|---|
| Canvas | 선택 결과, redacted snapshot, 상태·receipt | 전체 desktop·숨은 창·local file tree |
| Agenda | 목표·제약·선택 Context·기준 revision·미해결 질문 | 전체 Chat history·관련 없는 project context |
| View | 특정 문서 범위·tab semantic state·안전한 renderer | 전체 Browser profile·다른 tab·raw process |
| supervision capability 후보 | participant·handoff·진행·evidence·receipt | private Agent Room·숨은 tool chatter |
| Agent Room | 사용자가 선택해 옮긴 요약·결정 | 방 전체 자동 복제 |

## 원격 관찰·제어 상태

```text
none
→ observe_snapshot
→ observe_live
→ control_requested
→ control_granted
→ control_active
→ control_revoked
```

기본은 관찰이다. control은 특정 View에만 한 actor가 시간 제한 lease로 소유한다. local
사용자 입력이 발생하면 숨은 경쟁입력으로 처리하지 않고 conflict를 표시하고 pause한다.
Emergency revoke는 local owner에게 남긴다.

## 대상별 conflict·offline 정책

| 대상 | 정책 후보 |
|---|---|
| Git·text | `base_sha`와 hunk claim; diverged면 자동 main merge 금지 |
| Google 문서·시트 | provider revision과 range precondition |
| Excel·binary | single writer lease; file open이면 대기, 강제종료 금지 |
| Browser form | one input owner; submit 전후 semantic snapshot |
| runtime·process | 병합하지 않고 대상 device에서 멱등 재시작·readiness receipt |

offline device는 마지막 projection을 `offline / last observed`로만 표시한다. 이전 input
lease는 복귀 즉시 무효화하며 외부 mutation은 기본 queue하지 않는다. local draft만
보존하고 reconnect 뒤 revision·receipt를 다시 비교한다.

## 외부 action·idempotency

모든 action에는 `action_intent_id`, exact target과 idempotency key가 필요하다. resume 시
UI 기억으로 다시 클릭하지 않고 먼저 receipt와 현재 target state를 조회한다.

```text
PROPOSED
→ AUTHORIZED
→ DISPATCHED
→ PROVIDER_ACCEPTED
→ PROVIDER_STATE_OBSERVED
→ BUSINESS_RECONCILED
```

Git push, provider READY, 실제 Production alias·사용자 경로 확인은 서로 다른 단계다.

## Multi-agent opportunity

- Shape Scanner: 전체 이력에서 관련 source만 찾는 read-only Agent
- Device Probe: device별 동일 schema envelope 생성
- Revision Reconciler: Git·Drive·workbook·external object revision 비교
- Identity Auditor: profile·account·tenant·workspace·Task 일치 확인
- Privacy Projector: 초대 전 projection redaction·local-only 경계 감사
- Receipt Reconciler: 불확실한 외부 action만 추적
- Single Writer/Executor: 실제 edit·merge·DB mutation·submit 수행
- Independent Validator: 보임·저장·접수·Production을 분리 검증

병렬화는 탐색·비교·검증에만 사용한다. 동일 mutable target, Browser input, external submit은
단일 executor가 소유한다.

## 수용 기준 후보

1. 초대 전 shared·excluded projection preview가 있다.
2. device·person·account·workspace·Task identity를 분리한다.
3. 모든 shared projection에 source device·revision·freshness가 있다.
4. local-only dependency는 presence만 알리고 secret·path를 공개하지 않는다.
5. stale handoff는 첫 action 전에 rebase/reoffer된다.
6. 동일 external action은 receipt query 뒤에만 retry한다.
7. offline device의 외부 write queue는 기본 비활성이다.
8. binary·Browser·external mutation은 single writer lease를 가진다.
9. collaborator와 Agent action을 actor·device·revision에 귀속한다.
10. remote control은 명시적 grant·expiry·local emergency revoke를 가진다.

## 증거 한계

- 실제 EG-Desk collaborator 초대나 remote control 실행은 발견되지 않았다.
- Drive 기반 상시 Windows Agent는 설계·문서층만 있었고 목표기기 실행은 미검증이다.
- 다른 PC Outlook의 local 속성은 직접 읽지 못했다.
- 중앙 OAuth 사건의 최초 행위자·원인은 미확정이다.
- 일부 원작업은 raw local session이 아닌 backup-derived evidence다.
- 이 보고서는 현재 Git·Drive·Browser·runtime의 live 상태를 검증하지 않는다.
