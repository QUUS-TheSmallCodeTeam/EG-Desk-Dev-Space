<a id="rws-0026"></a>
# RWS-0026 — Taehwa 공통·역할 지식의 권위와 ACL 검증

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-05-13~28`
- **business_owner**: Taehwatrans 지식 운영
- **source_owner**: 공통 ontology·role runtime·Drive 구조 당시 evidence
- **action_authority**: 업무 계정은 역할 runtime, governance 관리자는 공통 승격을 소유

## 요약

자체 wiki 관행을 공식 구조처럼 설명하고 visibility를 permission으로 오인했다. 공통 concept,
role-private evidence/runtime과 실행기록을 분리하고 계정별 mount와 write 권한을 실제로
대조했다. 승격 흐름은 설치됐지만 현재 ACL·mount와 이후 후보 상태는 재검증되지 않았다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0026-SR-01` | Codex user thread | `PROJECT-RESTRICTED` | `019e1b99-fa11-7292-874f-8d765dd621ff`, turns 66–85, 89–100 | 2026-05-13 | `RWS-0026-C01`–`RWS-0026-C04` | `RESOLVED` |
| `RWS-0026-SR-02` | Codex user thread | `PROJECT-RESTRICTED` | `019e5c69-a6a5-7ba2-a8ad-45f96f83303b`, turns 1–40, 62–90, 102–108 | 2026-05-25~28 | `RWS-0026-C02`–`RWS-0026-C06` | `RESOLVED` |

### Claims

- [VERIFIED-AS-OF] `RWS-0026-C01`: 자체 convention을 공식 표준처럼 설명한 주장이 철회됐다.
- [VERIFIED-AS-OF] `RWS-0026-C02`: 공통 concept와 role-private evidence/runtime이 분리됐다.
- [VERIFIED-AS-OF] `RWS-0026-C03`: 제한 역할은 공통 ontology read-only, 역할 runtime write 가능으로 확인됐다.
- [VERIFIED-AS-OF] `RWS-0026-C04`: 업무 계정과 governance 관리자의 authority가 구분됐다.
- [VERIFIED-AS-OF] `RWS-0026-C05`: role observation→candidate→review→common 승격 흐름이 설치됐다.
- [UNKNOWN] `RWS-0026-C06`: 현재 ACL·mount·persistent Agent와 이후 승격 후보 상태는 재검증되지 않았다.

## 실제 업무 흐름

1. 초기 wiki 구조의 권위 근거를 재검토했다.
2. 공통·역할별 지식과 실행기록의 저장 위치를 분리했다.
3. 폴더 visibility와 ACL permission을 구분했다.
4. 역할별 mount와 read/write probe를 실행했다.
5. 업무 계정과 governance authority를 분리했다.
6. 후보 승격 flow를 만들고 current 상태는 UNKNOWN으로 남겼다.

## 증거 경계

| 확인됨 | 확인되지 않음 |
|---|---|
| 당시 mount visibility·write probe | 현재 ACL·mount |
| 역할·governance 권한 분리 | 모든 후보 승격 완료 |
| promotion flow 설치 | persistent Agent 운영 |

## EG-Desk 목표 시나리오

```text
knowledge class·owner 지정 → account/role capability probe
→ common read / role-private write / governance promote 분리
→ observation candidate → review → accepted common revision
→ ACL·freshness receipt 유지
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 후보 기법 | role-scoped reader + governance promotion reviewer |
| trigger | 공통 지식과 역할 원자료를 여러 Agent가 사용할 때 |
| 위험 | visibility를 permission으로 오인, private evidence 승격 |
| acceptance | account/role, read/write probe, promotion receipt |

## Candidate product implications

- account·role·Agent profile과 governance authority를 분리한다.
- common·role-private·runtime·candidate 지식을 별도 projection으로 둔다.
- 권한은 폴더 보임이 아니라 실제 capability probe로 확인한다.

## 정본 연결 후보

- [Atlas ONT-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ont-01)
- [Atlas AUTH-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-auth-01)
- [Contract identity](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-resource-identity)

## 열린 질문

- promotion 후보의 reviewer·승인·회수 UI는 무엇인가?
- ACL drift와 stale mount를 어떻게 감지하는가?
- 역할 Agent가 공통 지식에 제안만 남기는 경계는 무엇인가?

## Privacy

계정·직원·고객·Drive 원자료와 mount 경로는 복제하지 않았다. 역할·권한·승격 상태만
permission-safe하게 기록했다.
