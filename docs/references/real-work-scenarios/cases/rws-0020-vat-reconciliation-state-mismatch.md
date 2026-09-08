<a id="rws-0020"></a>
# RWS-0020 — VAT 대사·연장 승인과 후속 상태 불일치

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-07-25~2026-08-29`
- **business_owner**: KUUS 법인 세무
- **source_owner**: 신고서·원거래·연장신청·공식 상태 당시 evidence
- **action_authority**: 작성·첨부와 승인 readback은 확인, 실제 제출 actor·회차 납부는 별도

## 요약

큰 납부액의 원인을 잘못 해석했다가 취소거래로 교정하고 복수 신고서와 환급·이월을
대사해 연장신청을 작성했다. 승인 UI는 확인됐지만 후속 공식 화면에서 신고세액과 승인
연장금액이 불일치했다. 실제 제출 actor, 회차 납부와 후속 세액조정은 닫히지 않았다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0020-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `019f9913-3caa-7873-991d-07ee30711183`, turns 1–12, 13–24, 25–48, 49–52 | 2026-07-25~28 | `RWS-0020-C01`–`RWS-0020-C05` | `RESOLVED` |
| `RWS-0020-SR-02` | Codex user thread | `LOCAL-RESTRICTED` | `01a04d18-5d20-7da1-a3d5-a0f6828aee39`, turn 7 | 2026-08-29 | `RWS-0020-C05`, `RWS-0020-C06` | `RESOLVED` |

### Claims

- [VERIFIED-AS-OF] `RWS-0020-C01`: 카드 공제 오류라는 초기 해석이 원거래 취소로 교정됐다.
- [VERIFIED-AS-OF] `RWS-0020-C02`: 원거래·수정거래·복수 신고서·환급·이월 관계가 당시 범위에서 대사됐다.
- [VERIFIED-AS-OF] `RWS-0020-C03`: 저장 전 이동으로 초기화된 신청서가 동일 근거로 복구됐다.
- [VERIFIED-AS-OF] `RWS-0020-C04`: 개인자금을 법인 가용자금처럼 넣은 오류가 작성본에서 제거됐다.
- [OBSERVED] `RWS-0020-C05`: 승인 UI는 확인됐지만 후속 공식 화면에서 신고세액과 연장금액 불일치가 나타났다.
- [UNKNOWN] `RWS-0020-C06`: 실제 제출 actor·회차 납부·후속 세액조정 반영은 확인되지 않았다.

## 실제 업무 흐름

1. 신고서·거래·환급 내역을 모아 납부액 원인을 재검토했다.
2. 잘못된 공제 오류 가설을 취소거래로 교정했다.
3. 연장신청을 작성하며 법인·개인 자금 경계를 바로잡았다.
4. 저장 전 이동으로 유실된 신청서를 복구했다.
5. 승인 상태와 회차별 승인서를 readback했다.
6. 후속 공식 화면의 금액 불일치를 발견하고 납부·조정 완료를 철회했다.

## 증거 경계

| 상태 | 증거 | 한계 |
|---|---|---|
| 신고·거래 대사 | 당시 문서·거래 비교 | 후속 불일치 존재 |
| 연장 승인 | 공식 승인 UI | 실제 회차 납부 아님 |
| 신청 작성 | form·첨부 상태 | 제출 actor·receipt 불명 |

## EG-Desk 목표 시나리오

```text
tax period·transaction lineage 고정 → 신고/연장/승인 상태 분리
→ amount consistency 검사 → 신청 authority·receipt 확인
→ 회차 납부·후속 조정 별도 monitor → 불일치 시 verdict stale
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 후보 기법 | 기간별 read-only reconciler + 단일 portal executor |
| trigger | 복수 신고서·수정거래·환급·연장안이 연결될 때 |
| 위험 | 승인 금액을 최종 세액·납부로 오인 |
| acceptance | period lineage, authority, approval, payment receipt |

## Candidate product implications

- 신고·연장신청·승인·회차 납부·세액조정을 별도 상태로 둔다.
- 후속 공식 수치가 다르면 기존 대사 verdict를 stale 처리한다.
- 법인·개인 자금과 제출 authority를 명시적으로 분리한다.

## 정본 연결 후보

- [Atlas BROWSER-04](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-browser-04)
- [Contract identity](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-resource-identity)
- [Contract failure boundaries](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries)

## 열린 질문

- 기간별 세액·연장금액 불일치를 어떤 상태로 보존하는가?
- 실제 제출 actor가 불명확하면 approval을 어떻게 낮춰 표시하는가?
- 장기 납부 monitor와 원 Run을 어떻게 연결하는가?

## Privacy

법인·개인 식별정보, 세무 수치, 계좌·접수·승인 번호와 form 원문은 복제하지 않았다.
상태 전이와 불일치만 보존한다.
