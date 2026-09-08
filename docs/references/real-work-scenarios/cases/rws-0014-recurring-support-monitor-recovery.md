<a id="rws-0014"></a>
# RWS-0014 — 지원사업 반복 모니터의 누락 복구

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-08-31`
- **business_owner**: KUUS 사업지원 운영
- **source_owner**: 지원사업 조사·원장·보고 자동화 기록
- **action_authority**: 반복 조사는 허용됐고 메일 접근은 일회성 출처 발굴로 제한

## 요약

여러 자격 주체의 지원사업을 조사·기록·보고하는 반복 모니터가 예정 실행을 놓쳤다.
수동 catch-up으로 원장과 보고를 복구하고, 잘못 확장된 반복 메일 감시를 철회했다.
최근 실행은 확인됐지만 현재 활성 설정과 다음 실행 성공은 아직 알 수 없다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0014-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `019fc14c-2683-7de2-91ca-8be5c2138026`, turns 4–15, 18–32, 74 | 2026-08-31 | `RWS-0014-C01`–`RWS-0014-C06` | `RESOLVED` |

### Claims

- [VERIFIED-AS-OF] `RWS-0014-C01`: 여러 자격 주체를 대상으로 반복 조사·원장·보고 자동화가 생성됐다.
- [VERIFIED-AS-OF] `RWS-0014-C02`: 예정 실행 누락 뒤 수동 catch-up으로 원장과 보고가 갱신됐다.
- [VERIFIED-AS-OF] `RWS-0014-C03`: 반복 메일 감시로 확장된 범위가 철회되고 일회성 출처 발굴만 유지됐다.
- [VERIFIED-AS-OF] `RWS-0014-C04`: 수신자 피드백에 따라 목록형 보고서를 다시 만들고 인쇄·여백까지 검증했다.
- [VERIFIED-AS-OF] `RWS-0014-C05`: T74의 최근 monitor 실행은 완료 상태였다.
- [UNKNOWN] `RWS-0014-C06`: 현재 활성 설정, 다음 예정 실행과 이후 출처의 지속적 정상성은 확인되지 않았다.

## 실제 업무 흐름

1. 자격 주체·출처·보고 형식을 가진 반복 모니터를 만들었다.
2. 예정 실행이 누락된 사실을 발견했다.
3. 수동 catch-up으로 조사와 원장·보고를 복구했다.
4. 메일 상시 감시라는 과도한 범위를 철회했다.
5. 수신자 피드백으로 보고 구조를 고치고 렌더를 확인했다.
6. 최근 실행 완료만 확인하고 현재 설정·다음 실행은 UNKNOWN으로 남겼다.

## 증거 경계

| 확인됨 | 확인되지 않음 |
|---|---|
| 누락 run·catch-up | 다음 실행 성공 |
| 원장·보고 갱신 | 모든 출처의 현재 유효성 |
| 최근 실행 완료 | 현재 설정·장기 무중단 운영 |

## EG-Desk 목표 시나리오

```text
schedule due → source health 검사 → missed-run 감지
→ catch-up proposal → 중복·범위 검사 → 원장·보고 갱신
→ recent receipt·next due·unknown risk 표시
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 후보 기법 | source별 read-only mapper + 단일 monitor owner |
| trigger | 여러 자격 주체·출처를 정기 비교할 때 |
| 위험 | 일회성 접근을 반복 권한으로 확대 |
| acceptance | run ID, source freshness, catch-up receipt, next due |

## Candidate product implications

- missed, caught-up, latest-success와 next-unknown을 분리한다.
- 출처 접근 권한의 반복 범위와 일회성 범위를 명시한다.
- 보고서 생성뿐 아니라 실제 수신자 가독성·렌더 검사를 보존한다.

## 정본 연결 후보

- [Atlas AI-06](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-06)
- [Contract dependency orchestration](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-dependency-orchestration)
- [HUM-ORCH-001](../../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001)

## 열린 질문

- missed run의 자동 catch-up 승인 기준은 무엇인가?
- source freshness와 eligibility rule drift를 어떻게 감지하는가?
- 반복 모니터의 접근권한 만료를 어떻게 표시하는가?

## Privacy

계정명, 메일 제목, 개인별 자격정보와 원문 보고서는 복제하지 않았다. monitor 상태와
permission-safe SourceRef만 남겼다.
