<a id="rws-0015"></a>
# RWS-0015 — 불완전한 자격사유 아래 증빙·신청 분리

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-08`
- **business_owner**: KUUS 대표자 행정지원
- **source_owner**: 공식 안내·신청 form·접수목록 당시 evidence
- **action_authority**: 첨부와 최종 전송은 각각 사용자 승인, 심사·지급 권한은 외부 기관

## 요약

불완전한 공식 사유를 특정 재산 항목 탓으로 단정했다가 철회했다. 가림처리 증빙 제출과
본 신청을 별도 receipt로 관리했고, 첫 전송 실패 뒤 저장본에서 복구해 공식 접수행을
확인했다. 접수는 자격 인정·심사 완료·지급을 뜻하지 않는다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0015-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `01a04388-6fc2-7891-833b-414713c25bf3`, turns 4–14, 20–31, 32–54 | 2026-08 | `RWS-0015-C01`–`RWS-0015-C06` | `RESOLVED` |

### Claims

- [VERIFIED-AS-OF] `RWS-0015-C01`: 단순 사업자 지위만으로 부적격이라는 해석이 공식 자료로 교정됐다.
- [INFERRED] `RWS-0015-C02`: 특정 재산 항목은 공식 판정이 아니라 가능한 원인 가설로만 남았다.
- [VERIFIED-AS-OF] `RWS-0015-C03`: 가림처리 증빙 접수와 본 신청 접수가 별도 상태로 확인됐다.
- [VERIFIED-AS-OF] `RWS-0015-C04`: 첫 전송은 접수목록 부재로 실패 판정되고 저장본에서 복구됐다.
- [VERIFIED-AS-OF] `RWS-0015-C05`: 사용자 확인 뒤 두 번째 전송의 공식 접수행이 readback됐다.
- [UNKNOWN] `RWS-0015-C06`: 최종 자격 판정·심사·지급은 확인되지 않았다.

## 실제 업무 흐름

1. 공식 안내와 사전채움 정보를 이용해 eligibility 전제를 확인했다.
2. 특정 원인 단정을 공식 사유 미공개 상태로 낮췄다.
3. 개인정보를 가린 증빙을 별도 승인 후 제출했다.
4. 본 신청의 첫 전송은 저장만 남고 접수행이 없어 실패로 판정했다.
5. 저장본을 복구하고 사용자 확인 뒤 다시 전송했다.
6. 공식 접수행만 완료 증거로 남기고 심사·지급은 UNKNOWN으로 유지했다.

## 증거 경계

| 상태 | 증거 | 다음 상태 아님 |
|---|---|---|
| 증빙 접수 | 첨부 receipt | 본 신청 접수 |
| 신청 접수 | 공식 접수행 | 자격 인정·심사 완료 |
| 원인 가설 | 공식 안내와 관찰 | 기관의 개별 판정사유 |

## EG-Desk 목표 시나리오

```text
eligibility evidence 수집 → verified fact / inferred cause 분리
→ redacted evidence approval·receipt → application approval
→ submit → receipt readback → review/payment UNKNOWN 유지
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 후보 기법 | policy reader + redaction auditor + 단일 form executor |
| trigger | 공식 사유가 불완전하고 민감 증빙이 필요할 때 |
| 위험 | 가설을 기관 판정으로 승격, 중복 제출 |
| acceptance | 별도 evidence receipt, submit approval, official row |

## Candidate product implications

- fact·eligibility inference·기관 판정과 지급 상태를 분리한다.
- 증빙 제출과 본 신청의 approval·receipt를 별도 timeline으로 둔다.
- 실패한 submit 재시도 전에 저장본·중복 접수 여부를 확인한다.

## 정본 연결 후보

- [Atlas BROWSER-04](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-browser-04)
- [Atlas AUTH-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-auth-01)
- [Contract failure boundaries](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries)

## 열린 질문

- 공식 개별 사유가 없을 때 inference를 어떻게 표시하는가?
- 증빙 receipt와 본 신청 receipt를 어떤 UI로 연결하는가?
- 중복 제출 방지와 저장본 복구 조건은 무엇인가?

## Privacy

재산·계좌·접수번호·첨부명과 개인 식별정보는 복제하지 않았다. redaction·승인·receipt
상태만 기록했다.
