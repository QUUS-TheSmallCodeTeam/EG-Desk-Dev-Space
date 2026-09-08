<a id="rws-0021"></a>
# RWS-0021 — 사회보험 지원월 감사에서 로컬 일정 산출까지

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-05-19`
- **business_owner**: KUUS 사회보험 운영
- **source_owner**: 월별 PDF와 로컬 Calendar 당시 evidence
- **action_authority**: 사용자가 지정 Calendar와 두 일정 생성을 승인, cloud sync 권한은 미확인

## 요약

월별 PDF를 보험별 지원월·누락월로 집계하고 원인 단정을 철회했다. 향후 지원이 계속된다는
가정 아래 예상 종료월을 계산해 사용자가 지정한 로컬 Calendar에 두 일정을 만들고
readback했다. 기관 원인·향후 지속과 cloud 동기화는 확인되지 않았다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0021-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `019e3faf-315c-7951-bfd9-223e86187d3c`, turns 2–4, 5–7, 8–9, 10–14 | 2026-05-19 | `RWS-0021-C01`–`RWS-0021-C06` | `RESOLVED` |

### Claims

- [VERIFIED-AS-OF] `RWS-0021-C01`: 보유 PDF 범위와 보험별 지원월·누락월이 분리 집계됐다.
- [VERIFIED-AS-OF] `RWS-0021-C02`: 대표자 가입상태를 지연 원인으로 단정한 설명이 철회됐다.
- [INFERRED] `RWS-0021-C03`: 체납·신청시점 가설은 기관 결정자료가 없는 한 확정할 수 없다.
- [INFERRED] `RWS-0021-C04`: 예상 종료월은 이후 지원 지속을 가정한 계산이다.
- [VERIFIED-AS-OF] `RWS-0021-C05`: 사용자 승인 뒤 로컬 Calendar 일정 두 건이 생성·readback됐다.
- [UNKNOWN] `RWS-0021-C06`: cloud Calendar 동기화와 실제 지원 종료일은 확인되지 않았다.

## 실제 업무 흐름

1. 보유 PDF의 월 범위와 누락을 inventory했다.
2. 보험별 지원월을 따로 집계했다.
3. 원인 단정을 사용자 반박 뒤 철회했다.
4. 가정이 포함된 예상 종료월을 계산했다.
5. 사용자가 Calendar와 일정 생성을 명시 승인했다.
6. 로컬 일정 생성·readback과 cloud sync UNKNOWN을 분리했다.

## 증거 경계

| 확인됨 | 추론·UNKNOWN |
|---|---|
| PDF 범위·월 집계 | 기관의 개별 원인 |
| 로컬 일정 생성 | 향후 지원 지속 |
| Calendar readback | cloud 동기화 |

## EG-Desk 목표 시나리오

```text
document set inventory → 관찰 패턴·원인 가설 분리
→ assumption이 붙은 날짜 계산 → calendar target·authority 승인
→ local event create·readback → cloud delivery 별도 상태
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 후보 기법 | document mapper + assumption auditor + calendar executor |
| trigger | 여러 월 문서에서 불확실한 일정을 계산할 때 |
| 위험 | 상관관계를 기관 원인으로 단정 |
| acceptance | source months, assumptions, local event receipt |

## Candidate product implications

- 문서에서 관찰한 패턴과 원인 가설을 분리한다.
- 계산된 일정에는 가정과 재확인 조건을 붙인다.
- local event 생성과 cloud sync를 별도 delivery state로 둔다.

## 정본 연결 후보

- [Atlas DATA-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-data-01)
- [Contract storage](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-storage-export)
- [Contract failure boundaries](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries)

## 열린 질문

- 가정이 바뀌면 기존 Calendar event를 어떻게 stale 처리하는가?
- local·cloud Calendar delivery를 어떤 UI로 구분하는가?
- 기관 결정자료가 도착하면 원인 가설을 어떻게 갱신하는가?

## Privacy

보험·지원 내역 원문, 계정·Calendar 이름과 로컬 경로는 복제하지 않았다. 월 범위·가정·
delivery state만 보존한다.
