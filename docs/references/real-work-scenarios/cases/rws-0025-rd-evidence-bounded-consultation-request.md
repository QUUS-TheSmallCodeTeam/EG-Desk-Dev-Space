<a id="rws-0025"></a>
# RWS-0025 — R&D 증거 경계와 제한공개 상담 신청

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-08`
- **business_owner**: Taehwatrans R&D
- **source_owner**: imported R&D archive와 live 상담 신청 기록
- **action_authority**: 자료 업로드·최종 제출은 사용자 승인, 전문가 배정·기술 결정은 외부

## 요약

파생 archive를 확정 기술 근거처럼 사용하던 접근을 교정하고 PCB 문제를 실제 netlist와
반복시험이 필요한 미해결 문제로 재분류했다. 조직 제한자료를 manager-only 범위로
업로드하고 사용자 승인 뒤 상담 신청 receipt를 확인했다. 상담·기술 해결은 완료되지 않았다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0025-SR-01` | Codex user thread with imported evidence | `PROJECT-RESTRICTED` | `01a0127f-7cc4-7033-810a-92fc3e00a3e6`, turns 3–17, 19–39 | 2026-08 | `RWS-0025-C01`–`RWS-0025-C06` | `RESOLVED` |

### Claims

- [VERIFIED-AS-OF] `RWS-0025-C01`: raw archive와 readable derivative의 첨부·도구 증거 차이가 확인됐다.
- [VERIFIED-AS-OF] `RWS-0025-C02`: 성급한 확정 해법이 철회되고 netlist·반복시험이 필요한 미해결 문제로 재분류됐다.
- [VERIFIED-AS-OF] `RWS-0025-C03`: 상담 자료는 조직 제한 범위에 맞게 최소화됐다.
- [VERIFIED-AS-OF] `RWS-0025-C04`: 업로드와 최종 제출은 각각 사용자 확인 뒤 실행됐다.
- [VERIFIED-AS-OF] `RWS-0025-C05`: manager-only 상담 신청의 제출 완료 화면과 receipt가 readback됐다.
- [UNKNOWN] `RWS-0025-C06`: 매니저 연락·전문가 배정·상담·기술 해결·설계·양산 승인은 확인되지 않았다.

## 실제 업무 흐름

1. imported raw와 readable derivative의 증거 차이를 확인했다.
2. 기존 해법 문서를 미해결 조사 문제로 되돌렸다.
3. 필요한 실측·netlist·반복시험을 명시했다.
4. 외부 공개 범위를 manager-only로 제한했다.
5. 업로드와 제출을 각각 사용자에게 확인받았다.
6. 신청 receipt만 완료로 남기고 상담·해결은 UNKNOWN으로 유지했다.

## 증거 경계

| 확인됨 | 확인되지 않음 |
|---|---|
| archive evidence grade | 기술 정답 |
| 제한공개 신청 제출 | 전문가 배정·상담 |
| submit receipt | 설계·시험·양산 승인 |

## EG-Desk 목표 시나리오

```text
R&D source grade 분류 → fact/hypothesis/test gap
→ disclosure scope preview → artifact redaction → upload approval
→ submit approval·receipt → 상담·기술결과 별도 Task
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 후보 기법 | evidence auditor + domain hypothesis critic + 단일 submitter |
| trigger | imported archive를 외부 전문가에게 전달할 때 |
| 위험 | 파생본을 원자료로, 신청을 해결로 오인 |
| acceptance | access class, disclosure scope, fresh approval, receipt |

## Candidate product implications

- raw·derivative·hypothesis·test evidence를 별도 등급으로 둔다.
- 외부 공유 전 scope·redaction·authority를 preview한다.
- 상담 신청과 상담·해결·설계승인을 분리한다.

## 정본 연결 후보

- [Atlas DATA-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-data-01)
- [Atlas AUTH-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-auth-01)
- [Contract failure boundaries](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries)

## 열린 질문

- 조직 제한자료의 projection·redaction을 누가 승인하는가?
- 상담 진행상태와 기술 evidence를 어떤 Task로 연결하는가?
- 파생 archive가 불완전할 때 추가 원자료 요청을 어떻게 표시하는가?

## Privacy

회로 원본, Gerber·BOM·부품값과 첨부 전문은 복제하지 않았다. 조직 제한 access class,
evidence grade와 제출 상태만 보존한다.
