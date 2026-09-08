<a id="rws-0028"></a>
# RWS-0028 — Grammar-ON 문서·Skill 권위층 재설정

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-08-18~19`
- **business_owner**: Grammar-ON 제품 문서
- **source_owner**: README·현재 문서·archive·Skill·Git 기록
- **action_authority**: 제품 의미는 owner, 문서·Git 반영은 승인된 Codex 작업

## 요약

README가 옛 제품을 설명하고 절차 Skill과 과거 문서가 현재 제품 사실을 대신했다.
owner 교정으로 README를 제품 목적에 한정하고 current·archive·decision·operations와
Skill을 분리했다. 일부 원격 반영은 확인됐지만 후속 문서·Skill의 현재 revision과 제품
runtime은 증명되지 않았다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0028-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `01a0152c-b8ad-7ab1-ae0a-5f764d93ed9d`, turns 1–15, 47–54 | 2026-08 | `RWS-0028-C01`–`RWS-0028-C06` | `RESOLVED` |

### Claims

- [OBSERVED] `RWS-0028-C01`: 레거시 README·과거 문서·Skill이 현재 제품 사실과 혼재했다.
- [VERIFIED-AS-OF] `RWS-0028-C02`: README가 현재 Platform·Content Pipeline 중심 방향으로 교정됐다.
- [VERIFIED-AS-OF] `RWS-0028-C03`: 구현·DB 세부사항은 미확정 상태로 README에서 제외됐다.
- [VERIFIED-AS-OF] `RWS-0028-C04`: 과거 문서 117개가 보존되고 현행 문서 정본 지도가 생성됐다.
- [VERIFIED-AS-OF] `RWS-0028-C05`: Skill이 제품 정본이 아닌 절차·검토 체크리스트로 강등됐다.
- [UNKNOWN] `RWS-0028-C06`: 후속 docs·Skill 원격 revision과 앱·DB·배포 상태는 확인되지 않았다.

## 실제 업무 흐름

1. 진입 README와 현재 제품 목표의 불일치를 발견했다.
2. 초기 개정안이 미정 구현구조를 과도하게 확정했다.
3. owner 교정에 따라 README를 제품 목적과 경계로 축소했다.
4. 과거 문서를 원문 보존 archive로 이동했다.
5. current·decision·operations 문서 지도를 만들었다.
6. Skill을 절차 router로 강등하고 링크·형식·잔존 reference를 검사했다.

## 증거 경계

| 확인됨 | 확인되지 않음 |
|---|---|
| README 교정·일부 원격 일치 | 현재 전체 docs 원격 revision |
| 117개 문서 archive | 앱·DB·Production 동작 |
| Skill 역할·형식 검사 | 후속 runbook 완성 |

## EG-Desk 목표 시나리오

```text
entry document authority audit → owner direction readback
→ current/archive/decision/operations 분리 → legacy preserve
→ Skill을 procedure-only로 제한 → link·reference·Git state 검증
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 후보 기법 | legacy mapper + current-authority auditor + link validator |
| trigger | README·archive·Skill이 서로 제품 정본을 주장할 때 |
| 위험 | stale Skill을 제품 사실로 사용 |
| acceptance | owner direction, preserved archive, authority map |

## Candidate product implications

- 제품 결정·현재 문서·역사 기록·절차 Skill을 다른 권위층으로 둔다.
- README는 미정 구현을 앞서 확정하지 않는다.
- Skill은 source discovery와 검토 절차를 제공하되 제품 사실은 현재 정본에서 읽는다.

## 정본 연결 후보

- [Atlas 시작점](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-manual-start)
- [기술 Contract](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-contract-top)
- [Documentation Governance](../../../codex/egdesk-product-documentation-governance.md#doc-governance-top)

## 열린 질문

- stale 문서·Skill을 자동으로 감지하는 기준은 무엇인가?
- archive 보존과 현재 정본 검색 우선순위를 어떻게 표현하는가?
- Git 원격 반영과 제품 runtime 상태를 어떻게 분리하는가?

## Privacy

학생·Production 데이터, 로컬 경로와 raw 문서 원문은 복제하지 않았다. 문서 권위·보존·
검증 상태만 기록했다.
