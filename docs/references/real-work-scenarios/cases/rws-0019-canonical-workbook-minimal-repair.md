<a id="rws-0019"></a>
# RWS-0019 — 잠긴 정본 workbook의 최소 범위 복구

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-08-25`
- **business_owner**: Taehwatrans 총무회계
- **source_owner**: 공유 Drive의 공식 workbook과 이전 미완료 기록
- **action_authority**: 사용자가 정본 최소수정을 승인, 잠긴 상태에서는 write 금지

## 요약

이전 작업은 workbook 잠금 때문에 마지막 누적표시를 남긴 채 중단됐다. 후속 작업에서
잠금과 시작 hash를 확인하고 세 셀만 기존 형식대로 수정한 뒤 정본 재열기와 기존 오류
비교로 추가 손상이 없음을 검증했다. 이후 현재 revision은 미확인이다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0019-SR-01` | Codex user thread with imported prior evidence | `LOCAL-RESTRICTED` | `01a03329-0a24-7543-9c75-fa0d1882579a`, turns 6–8 | 2026-08-25 | `RWS-0019-C01`–`RWS-0019-C05` | `RESOLVED` |

### Claims

- [OBSERVED] `RWS-0019-C01`: 파일 잠금 뒤 누적표시 반영이 미완료로 남았다.
- [VERIFIED-AS-OF] `RWS-0019-C02`: 사용자 승인 후 잠금 상태와 시작 hash를 preflight했다.
- [VERIFIED-AS-OF] `RWS-0019-C03`: 정본의 세 셀만 기존 형식에 맞춰 수정했다.
- [VERIFIED-AS-OF] `RWS-0019-C04`: 저장 후 정본 재열기와 기존 오류 비교를 수행했다.
- [UNKNOWN] `RWS-0019-C05`: 감사 이후 정본의 현재 revision은 확인되지 않았다.

## 실제 업무 흐름

1. imported 기록에서 잠금 때문에 중단된 pending range를 찾았다.
2. 현재 정본과 target 범위를 다시 확인했다.
3. workbook이 닫혔는지와 시작 hash를 검사했다.
4. 확인된 세 셀만 기존 서식대로 수정했다.
5. 정본을 다시 열어 값·서식과 기존 오류를 비교했다.
6. 이후 변경 가능성은 current UNKNOWN으로 남겼다.

## 증거 경계

| 확인됨 | 확인되지 않음 |
|---|---|
| 지정 범위 최소수정 | workbook 전체 업무 정확성 |
| 저장·재열기·오류 비교 | 이후 현재 revision |
| 잠금 회피 | 다른 사용자의 미저장 상태 |

## EG-Desk 목표 시나리오

```text
pending repair 발견 → canonical ID·expected hash·lock preflight
→ 최소 target range preview → 사용자 승인 → bounded write
→ save·reopen·before/after·existing-error 비교 → receipt 보존
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 후보 기법 | read-only range auditor + 단일 workbook writer |
| trigger | 정본 binary 파일의 deferred repair가 있을 때 |
| 위험 | 강제 종료·전체 rewrite·stale hash |
| acceptance | lock clear, expected hash, exact range, reopen |

## Candidate product implications

- binary 정본에는 expected hash와 single-writer lease가 필요하다.
- deferred 작업은 pending range·resume condition을 durable하게 남긴다.
- 최소수정 뒤 재열기와 기존 오류 비교를 완료 증거로 둔다.

## 정본 연결 후보

- [Atlas CODE-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-code-01)
- [Contract storage](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-storage-export)
- [Contract failure boundaries](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries)

## 열린 질문

- workbook lock과 미저장 사용자 상태를 어떻게 안전하게 감지하는가?
- expected hash가 바뀌면 pending repair를 어떻게 재승인하는가?
- 최소 범위와 전체 구조 검증의 경계는 무엇인가?

## Privacy

직원명, 연차 값, workbook 경로와 실제 셀 내용은 복제하지 않았다. target 규모, hash·lock·
재열기 상태만 보존한다.
