<a id="rws-0017"></a>
# RWS-0017 — 금융 원천의 정본 장부 대사와 복구

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-06~08`
- **business_owner**: KUUS 재무 운영
- **source_owner**: 은행 원천·canonical spreadsheet 당시 evidence
- **action_authority**: 지정 원천과 장부 범위만 수정, 제외 계좌와 정본 승격은 사용자 소유

## 요약

은행 원천을 canonical ledger에 반영하면서 필터행 오인, UI 좌표계 혼합과 근거 없는
시간순 재배치가 발생했다. 오입력 제거와 snapshot 복구 뒤 원천시각·중복·대응이체·잔액
불변식을 기준으로 다시 대사했다. 지정 외 계좌와 현재 장부 revision은 미확인이다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0017-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `019e8589-a380-7223-8012-981f495b37b4`, turns 4–14, 18–25, 34–46, 165–174, 186–190, 251 | 2026-06~08 | `RWS-0017-C01`–`RWS-0017-C06` | `RESOLVED` |

### Claims

- [VERIFIED-AS-OF] `RWS-0017-C01`: 지정 은행 원천을 정본 장부에 대사·반영하는 업무 범위가 고정됐다.
- [OBSERVED] `RWS-0017-C02`: 필터행 오인, 좌표계 혼합과 근거 없는 시간순 재배치가 실제로 실패했다.
- [VERIFIED-AS-OF] `RWS-0017-C03`: 오입력 제거와 snapshot 복구 뒤 원천시각 기반 정렬로 교정됐다.
- [VERIFIED-AS-OF] `RWS-0017-C04`: 중복 제거와 대응이체 병합 뒤 삽입범위·anchor가 readback됐다.
- [VERIFIED-AS-OF] `RWS-0017-C05`: 원천과 장부 잔액 불변식이 범위 내에서 대사됐다.
- [UNKNOWN] `RWS-0017-C06`: 지정 외 계좌와 현재 장부 revision의 완전성은 확인되지 않았다.

## 실제 업무 흐름

1. 대상 계좌·기간·장부 범위를 고정했다.
2. 보호·필터행을 데이터행으로 오인해 오입력이 발생했다.
3. 추가 범위만 제거하고 snapshot으로 기준 상태를 복구했다.
4. 대화 시각이 아닌 원천 거래시각으로 정렬 기준을 바꿨다.
5. 중복·대응이체를 처리하고 범위·anchor·잔액을 readback했다.
6. 제외 계좌와 현재 전체 장부 상태는 완료에서 제외했다.

## 증거 경계

| 확인됨 | 확인되지 않음 |
|---|---|
| 지정 원천·기간 대사 | 모든 계좌 최신화 |
| 오입력 복구 | 현재 canonical revision |
| 범위·anchor·잔액 readback | 전체 재무 정합성 |

## EG-Desk 목표 시나리오

```text
source snapshot 고정 → target ledger revision·protected range 확인
→ normalized transaction packet → dedupe·transfer match
→ bounded write → range·anchor·balance postflight → excluded scope 표시
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 후보 기법 | 은행별 read-only mapper + 단일 ledger writer |
| trigger | 여러 원천의 overlap·대응이체가 존재할 때 |
| 위험 | UI row와 data row 혼동, 중복 write |
| acceptance | source hash, write range, balance invariant |

## Candidate product implications

- 원천 transaction identity와 spreadsheet row identity를 분리한다.
- write 전 protected range와 canonical revision을 확인한다.
- 대사 완료 범위와 명시적 제외 범위를 함께 표시한다.

## 정본 연결 후보

- [Atlas DATA-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-data-01)
- [Contract identity](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-resource-identity)
- [Contract failure boundaries](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries)

## 열린 질문

- source transaction과 ledger row의 안정적 mapping은 무엇인가?
- balance 불변식 실패 시 자동 rollback 범위는 어디까지인가?
- 제외 계좌·기간을 사용자에게 어떻게 명시하는가?

## Privacy

계좌·거래·잔액 값, 시트 주소와 로그인 정보는 복제하지 않았다. 원천 종류, 실패·복구와
검증 상태만 보존한다.
