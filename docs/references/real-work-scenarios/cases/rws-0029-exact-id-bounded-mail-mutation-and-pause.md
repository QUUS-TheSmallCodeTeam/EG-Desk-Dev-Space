<a id="rws-0029"></a>
# RWS-0029 — exact-ID 제한 메일 mutation과 자동화 pause

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-08-30`
- **business_owner**: Taehwatrans 메일 운영
- **source_owner**: 고정 message ID 집합·label mutation·automation 상태 기록
- **action_authority**: 사용자가 message-level 범위와 허용 label·수량·일정을 승인

## 요약

정확히 고정한 message ID 집합에만 label mutation을 적용하고 단계별로 재검증했다.
revert 검토 전에 automation만 pause했으며 메일은 바꾸지 않았다. formal revert는 실행되지
않았고 후속 readback에서 대상 label이 없는 상태가 관찰됐으나 원인은 확정되지 않았다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0029-SR-01` | Codex user thread | `PROJECT-RESTRICTED` | `019fe76b-f5ed-7e20-851c-8bec9b97f44e`, turns 1–2, 4–5, 7–9 | 2026-08 | `RWS-0029-C01`–`RWS-0029-C06` | `RESOLVED` |

### Claims

- [VERIFIED-AS-OF] `RWS-0029-C01`: 고정된 message ID 집합만 처리되고 thread 전체로 확장되지 않았다.
- [VERIFIED-AS-OF] `RWS-0029-C02`: 원본 label 제거 전 새 label과 기존 읽음 상태 유지가 같은 ID 집합에서 재검증됐다.
- [VERIFIED-AS-OF] `RWS-0029-C03`: revert 검토 전 automation만 pause됐고 그 과정에서 메일은 변경되지 않았다.
- [OBSERVED] `RWS-0029-C04`: formal revert는 실행되지 않았고 후속 readback에서 두 대상 label 부재가 관찰됐다.
- [UNKNOWN] `RWS-0029-C05`: label 부재 원인과 다른 PC Outlook의 MAPI·동기화 상태는 확정되지 않았다.
- [UNKNOWN] `RWS-0029-C06`: 2026-08-30 이후 현재 automation 설정과 다른 PC 상태는 재검증되지 않았다.

## 실제 업무 흐름

1. 사용자가 message-level 범위·최대 수량·허용 label 변경을 승인했다.
2. exact ID 집합을 동결하고 사전 상태를 확인했다.
3. 새 label을 적용하고 기존 읽음 상태가 유지됐는지 같은 ID로 검증했다.
4. 원본 label 제거 전 중간 상태를 다시 확인했다.
5. revert 검토 시 automation만 먼저 pause했다.
6. formal revert 미실행과 후속 label 상태의 원인 UNKNOWN을 남겼다.

## 증거 경계

| 확인됨 | 확인되지 않음 |
|---|---|
| bounded ID mutation | formal revert |
| 단계별 label readback | 후속 label 부재 원인 |
| automation PAUSED | 다른 PC Outlook 상태 |

## EG-Desk 목표 시나리오

```text
exact target ID freeze → before snapshot → bounded mutation
→ per-stage ID readback → automation pause와 data revert 분리
→ revert 전 current account·label·ID 재검증·새 승인
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 후보 기법 | ID-set auditor + 단일 mutation executor + revert reviewer |
| trigger | 다수 외부 객체를 가역적으로 변경할 때 |
| 위험 | thread 확장·중복 mutation·pause를 revert로 오인 |
| acceptance | frozen IDs, before/after counts, pause/revert receipts |

## Candidate product implications

- 외부 bulk action은 exact target set과 idempotency key를 가진다.
- automation pause와 외부 데이터 revert를 별도 상태로 둔다.
- 이후 drift가 발견되면 원인을 확정하지 않고 current readback부터 다시 수행한다.

## 정본 연결 후보

- [Atlas DATA-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-data-01)
- [Contract identity](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-resource-identity)
- [Contract failure boundaries](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries)

## 열린 질문

- exact ID 집합을 장기 보존하면서 개인정보를 최소화하는 방법은 무엇인가?
- pause·resume·revert의 authority와 UI를 어떻게 분리하는가?
- 외부 drift가 생기면 어떤 범위부터 재검증하는가?

## Privacy

원시 message ID·제목·계정 식별자와 본문은 복제하지 않았다. target 집합의 크기·상태와
permission-safe SourceRef만 보존한다.
