<a id="rws-0018"></a>
# RWS-0018 — 공유 AX 대시보드의 정본·시안·수용 전환

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-07~08`
- **business_owner**: Taehwatrans AX 운영
- **source_owner**: 공유 spreadsheet와 디자인·검증 작업 기록
- **action_authority**: 공유 정본 반영은 사용자 승인, 시안 제작은 격리 사본에서 수행

## 요약

발표자료를 지속 운영용 공유 대시보드로 전환하는 과정에서 시안을 정본에 너무 일찍
적용하고 계층·시간축·서식을 잘못 설계했다. 공유본을 복구한 뒤 별도 시안에서 반복
검증하고 사용자 수용 후 같은 canonical object에 반영했다. 현재 revision과 실제 조직
운영 채택은 미확인이다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0018-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `019f7ffc-1a2d-7243-b898-f9007f321067`, turns 5–13, 98–107, 109–155 | 2026-07~08 | `RWS-0018-C01`–`RWS-0018-C06` | `RESOLVED` |

### Claims

- [VERIFIED-AS-OF] `RWS-0018-C01`: 발표자료를 지속 운영하는 공유 spreadsheet 대시보드로 전환했다.
- [VERIFIED-AS-OF] `RWS-0018-C02`: 공유 object 하나를 canonical로 고정하고 동일 file identity를 유지했다.
- [OBSERVED] `RWS-0018-C03`: 시안을 공유본에 조기 적용하고 계층·시간축·서식을 오설계했다.
- [VERIFIED-AS-OF] `RWS-0018-C04`: 공유본 복구 뒤 별도 시안에서 Excel·Sheets 렌더를 반복 검증했다.
- [VERIFIED-AS-OF] `RWS-0018-C05`: 사용자 수용 후 선택된 시안만 canonical object에 반영됐다.
- [UNKNOWN] `RWS-0018-C06`: 현재 revision과 실제 조직 운영 채택은 확인되지 않았다.

## 실제 업무 흐름

1. 일회성 발표자료와 지속 운영 대시보드의 목적을 구분했다.
2. 공유본 하나를 canonical object로 지정했다.
3. 미완성 시안을 공유본에 직접 적용해 구조 오류가 발생했다.
4. 정본을 복구하고 시안을 별도 사본으로 분리했다.
5. 여러 renderer에서 계층·시간축·서식을 검토했다.
6. 사용자 수용 뒤 선택된 변경만 공유 정본에 반영했다.

## 증거 경계

| 확인됨 | 확인되지 않음 |
|---|---|
| canonical object identity | 현재 revision |
| 시안 분리·렌더 검증 | 조직 전체 사용 |
| 당시 사용자 수용·반영 | 후속 drift·편집 충돌 |

## EG-Desk 목표 시나리오

```text
shared artifact 지정 → canonical lease 확인 → isolated design copy
→ renderer별 preview·review → 사용자 선택 → bounded canonical apply
→ revision·adoption UNKNOWN 분리
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 후보 기법 | 시안별 격리 designer + 단일 canonical integrator |
| trigger | 공유본 디자인과 데이터 구조를 함께 바꿀 때 |
| 위험 | 미완성 시안을 공유 정본에 조기 적용 |
| acceptance | object ID, preview revision, owner selection, reopen |

## Candidate product implications

- canonical artifact와 design candidate를 별도 object state로 둔다.
- renderer별 preview와 실제 공유본 반영을 구분한다.
- 사용자 수용과 조직 채택을 같은 완료 상태로 보지 않는다.

## 정본 연결 후보

- [Atlas DATA-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-data-01)
- [Atlas AI-04](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-04)
- [Contract identity](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-resource-identity)

## 열린 질문

- 공유 정본의 단일 writer lease를 어떻게 표시하는가?
- 시안 비교와 owner 선택을 Canvas에서 어떻게 수행하는가?
- 조직 채택·사용 상태는 누가 확인하는가?

## Privacy

실제 dashboard 내용, 직원·프로젝트 정보, 파일 주소와 screenshot은 복제하지 않았다.
canonical identity와 변경·검증 흐름만 기록했다.
