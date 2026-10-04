<a id="rws-0013"></a>
# RWS-0013 — 제품 소유자 교정의 결정·OPEN 분리와 정본 승격

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-08-24~30`
- **business_owner**: EG-Desk 제품 소유자
- **source_owner**: 제품 논의 parent와 정본 대조 children
- **action_authority**: 제품 의미 결정은 owner, 문서 반영은 Main, PM 제안은 승인권 없음

## 요약

모호한 UI 문구와 assistant 제안이 owner 결정처럼 읽히는 문제를 교정했다. 명시적 owner
결정, 확정된 경계 안의 OPEN remainder와 PM 제안을 분리한 뒤 확정된 부분만 정본에
반영했다. 문서 반영은 runtime 구현 증거가 아니다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0013-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `019f8d42-4886-7041-8421-c5e343d465e0`, turn 83 | 2026-08 | `RWS-0013-C01` | `RESOLVED` |
| `RWS-0013-SR-02` | Codex user thread | `LOCAL-RESTRICTED` | 같은 thread, turns 84–87 | 2026-08 | `RWS-0013-C02`, `RWS-0013-C03` | `RESOLVED` |
| `RWS-0013-SR-03` | Codex user thread | `LOCAL-RESTRICTED` | 같은 thread, turn 88 | 2026-08 | `RWS-0013-C03`, `RWS-0013-C04` | `RESOLVED` |
| `RWS-0013-SR-04` | Codex user thread | `LOCAL-RESTRICTED` | 같은 thread, turns 97–98 | 2026-08 | `RWS-0013-C04`–`RWS-0013-C06` | `RESOLVED` |
| `RWS-0013-SR-05` | Codex audit children | `LOCAL-RESTRICTED` | `01a03771-8647-7382-9e2a-e23df227ba8e` T1–2; `01a0412c-c481-7181-b2a8-3ae00a4f9580` T1–2; `01a051e0-b1b6-7132-a39d-ddc85acf0a51` T1–2 | 2026-08 | `RWS-0013-C04`, `RWS-0013-C05` | `RESOLVED` |

### Claims

- [OBSERVED] `RWS-0013-C01`: 모호한 `Current Desk` 표현이 다중 Desk를 확정한 것처럼 읽혔다.
- [VERIFIED-AS-OF] `RWS-0013-C02`: 하나의 Desk·Canvas와 복수 Saved Board의 경계가 owner 결정으로 분리됐다.
- [VERIFIED-AS-OF] `RWS-0013-C03`: Board 종료·Chat·Memo 등은 확정 경계와 남은 OPEN 질문으로 나뉘었다.
- [OBSERVED] `RWS-0013-C04`: workroom과 정확한 UI 등 assistant·PM 제안은 owner decision으로 승격되지 않았다.
- [VERIFIED-AS-OF] `RWS-0013-C05`: 정본 대조가 완전 반영·부분 반영·미반영·OPEN을 구분했다.
- [UNKNOWN] `RWS-0013-C06`: 문서에 반영된 제품 동작의 runtime 구현은 증명되지 않았다.

## 실제 업무 흐름

1. owner가 모호한 객체·상태 표현의 의미를 질문했다.
2. assistant 대안과 owner 수용·교정을 구분했다.
3. 확정 경계와 그 안에 남은 UI·권한 질문을 분리했다.
4. PM·WM 대조가 각 결정을 반영 상태별로 분류했다.
5. owner 승인 뒤 확정된 부분만 문서 화자에 맞춰 반영했다.
6. OPEN remainder와 runtime 미구현 상태를 그대로 남겼다.

## 증거 경계

| 상태 | 의미 |
|---|---|
| `OWNER-DECISION` | 사용자 명시 교정·수용 |
| `CONFIRMED-BOUNDARY / OPEN-REMAINDER` | 의미 경계는 확정, 세부 UI·권한은 미결정 |
| `PM-PROPOSAL / OPEN` | 질문·대안일 뿐 제품 사실 아님 |

## EG-Desk 목표 시나리오

```text
모호성 제기 → 관련 proposal·owner statement·정본 revision 표시
→ owner decision / confirmed boundary / open remainder 분류
→ impact audit → owner readback → 승인된 의미만 canonical 적용
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 후보 기법 | owner-statement extractor + independent canonical auditor |
| trigger | proposal과 decision이 같은 대화에 섞일 때 |
| 위험 | 다수 PM 합의를 owner 결정으로 오인 |
| acceptance | 결정별 source turn, owner readback, OPEN 보존 |

## Candidate product implications

- proposal·owner decision·OPEN remainder를 같은 상태로 표시하지 않는다.
- 정본 반영과 runtime 구현을 별도 completion state로 둔다.
- owner 교정이 들어오면 영향받는 candidate와 audit verdict를 stale 처리한다.

## 정본 연결 후보

- [Atlas 제품 불변조건](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-manual-start)
- [제품 소유자 HUM 원장](../../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#gap-owner-queue)
- [Documentation Governance](../../../codex/egdesk-product-documentation-governance.md#doc-governance-top)

## 열린 질문

- owner statement의 수정·철회·부분결정을 어떤 UI로 표시하는가?
- OPEN remainder가 바뀌면 기존 Answer와 설계안을 어디까지 stale 처리하는가?
- 문서 승격 이후 runtime 구현 상태를 어떻게 연결하는가?

## Privacy

raw annotation 전문과 임시 child 결과는 복제하지 않았다. 제품 결정의 permission-safe
요약과 정확한 turn locator만 남겼다.
