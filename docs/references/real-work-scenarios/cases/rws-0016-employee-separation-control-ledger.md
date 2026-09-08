<a id="rws-0016"></a>
# RWS-0016 — 퇴사·보험·지급 상태의 통제 원장

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-08-31`
- **business_owner**: KUUS 인사·급여·사회보험
- **source_owner**: 고용 종료 관련 form·보험 결과·내부 원장 당시 evidence
- **action_authority**: 기관별 신고는 승인된 executor, 실제 지급·후속 세무 완료는 별도 권한

## 요약

한 직원의 종료 업무에서 실제 근무일·이직일·보험 상실일, 기관 처리와 금전 지급이
뒤섞였다. 보험별 처리 readback과 form 복구는 확인됐지만 일부 최종 처리는 사용자
진술뿐이고 실제 임금·퇴직금·환급·후속 신고·납부는 닫히지 않았다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0016-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `019fc67b-d05a-7351-a960-2d56abdc5dd7`, turns 1–31, 34–103, 107–139 | 2026-08 | `RWS-0016-C01`–`RWS-0016-C05` | `RESOLVED` |
| `RWS-0016-SR-02` | later planning·control thread | `LOCAL-RESTRICTED` | `01a05609-0a94-7842-a71c-d709bb1cd85c`, turns 1–4 | 2026-08-31 | `RWS-0016-C05`, `RWS-0016-C06` | `RESOLVED` |

### Claims

- [VERIFIED-AS-OF] `RWS-0016-C01`: 실제 근무일, 이직일과 보험 상실일이 서로 다른 상태로 분리됐다.
- [VERIFIED-AS-OF] `RWS-0016-C02`: 보험별 자격상실 처리와 별도 정산 오류가 구분됐다.
- [VERIFIED-AS-OF] `RWS-0016-C03`: 비직관적 저장·전송 흐름으로 유실된 고용 form이 복구됐다.
- [OBSERVED] `RWS-0016-C04`: 한 최종 처리 상태는 사용자 진술뿐이며 공식 receipt가 없다.
- [VERIFIED-AS-OF] `RWS-0016-C05`: 내부 원장과 대조해 과도한 미지급 설명이 철회됐다.
- [UNKNOWN] `RWS-0016-C06`: 후속 계획·통제 자료는 남았지만 실제 임금·퇴직금·환급 송금과 신고·납부 완료는 확인되지 않았다.

## 실제 업무 흐름

1. 사실관계와 퇴사 분류를 교정했다.
2. 근무일·이직일·보험 상실일을 별도 필드로 정리했다.
3. 기관별 자격상실 결과를 상세 readback했다.
4. 저장·전송 구조를 오해해 유실된 form을 복구했다.
5. 사용자 진술과 공식 receipt가 있는 상태를 구분했다.
6. 내부 원장으로 지급 설명을 교정하고 남은 금전·세무 항목을 OPEN으로 유지했다.

## 증거 경계

| 확인됨 | 미완료·UNKNOWN |
|---|---|
| 보험별 처리 readback | 실제 지급·이체 |
| form 복구·일부 신고 | 일부 공식 접수 receipt |
| 내부 원장 대사 | 후속 세무 신고·납부 |

## EG-Desk 목표 시나리오

```text
separation Task → 날짜·기관·금전 의무 ledger 생성
→ 기관별 form·approval·receipt → 처리 결과 readback
→ 지급·환급·세무 의무를 별도 상태로 추적
→ 모든 owner·evidence가 닫힐 때만 closeout 가능
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 후보 기법 | 기관별 read-only mapper + 단일 closeout integrator |
| trigger | 여러 기관·날짜·금전 의무가 한 사건에 연결될 때 |
| 위험 | 한 기관 완료를 전체 closeout으로 확대 |
| acceptance | 의무별 owner·receipt·current state |

## Candidate product implications

- 사건 하나 아래 날짜·기관·지급·세무 상태를 독립적으로 관리한다.
- 사용자 진술, portal readback과 실제 금전 receipt를 구분한다.
- 모든 하위 의무가 닫히지 않으면 `완료` 대신 남은 항목을 보여준다.

## 정본 연결 후보

- [Atlas DATA-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-data-01)
- [Contract identity](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-resource-identity)
- [Contract failure boundaries](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries)

## 열린 질문

- 여러 기관 상태를 하나의 사건에 어떤 identity로 연결하는가?
- 사용자 진술만 있는 완료 상태를 어떻게 재확인하도록 표시하는가?
- 금전·세무 의무의 장기 OPEN 상태를 누가 소유하는가?

## Privacy

직원 식별정보, 연락처, 급여·보험·세금 값과 form 원문은 복제하지 않았다. 날짜·기관·
receipt 유형과 permission-safe SourceRef만 남겼다.
