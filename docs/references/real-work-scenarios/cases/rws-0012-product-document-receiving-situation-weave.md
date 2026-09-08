<a id="rws-0012"></a>
# RWS-0012 — 제품 문서의 수신 상황 분리와 정본 weave

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **evidence_scope**: `DOCUMENTATION-ARTIFACT-AND-VALIDATOR-ONLY`
- **as_of**: `2026-08-04~18`
- **business_owner**: EG-Desk 제품 문서
- **source_owner**: Atlas·Contract·HUM 원장·Documentation Governance 작업 기록
- **action_authority**: 제품 의미는 owner, 문서 쓰기·통합은 Main, PM·WM·auditor는 자문·검사

## 요약

제품 독자용 설명과 편집 provenance·AI 운영 지시가 같은 문서 표면에 섞였다. 문서의
화자·독자·권위에 따라 네 정본을 분리하고 stable ID와 양방향 링크로 다시 연결했다.
검증 완료는 문서 artifact에만 해당하며 제품 runtime 구현을 뜻하지 않는다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0012-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `019f8d42-4886-7041-8421-c5e343d465e0`, turns 44–48, 58–59, 60–61, 64–65, 67–69, 80–82 | 2026-08 | `RWS-0012-C01`–`RWS-0012-C06` | `RESOLVED` |
| `RWS-0012-SR-02` | Codex design children | `LOCAL-RESTRICTED` | `019fcb32-30a7-7ba1-a931-f54e3dde7ad3` T1; `019fcb32-3126-7261-8706-d1b23ad170f5` T1; `019fcb5b-b63c-7323-aa9b-c14b0e9310aa` T1 | 2026-08 | `RWS-0012-C01`–`RWS-0012-C03` | `RESOLVED` |
| `RWS-0012-SR-03` | Codex audit children | `LOCAL-RESTRICTED` | `019fcb88-2682-75a3-b37c-d52025039de7` T1–3; `019fe01f-0696-7501-bfe0-6d5cf650369c` T1–2; `019fe07c-23af-7b12-9618-f898b8b1b2ef` T2–4 | 2026-08 | `RWS-0012-C03`–`RWS-0012-C05` | `RESOLVED` |
| `RWS-0012-SR-04` | Codex routing children | `LOCAL-RESTRICTED` | `019fe581-5608-7203-a6e2-c7b004fc3526` T1–2; `019fe5aa-679a-75a1-93c6-1c15c28bd711` T1–2; `019fe5aa-680f-7711-8fb6-5b9c857342cc` T1 | 2026-08 | `RWS-0012-C04`, `RWS-0012-C05` | `RESOLVED` |

### Claims

- [OBSERVED] `RWS-0012-C01`: 제품 설명, provenance, 편집 지시와 내부 역할 언어가 같은 표면에 혼재했다.
- [VERIFIED-AS-OF] `RWS-0012-C02`: Atlas·Contract·HUM 원장·Governance의 화자와 소유권이 분리됐다.
- [VERIFIED-AS-OF] `RWS-0012-C03`: stable ID와 역링크를 유지하며 네 정본이 양방향으로 연결됐다.
- [VERIFIED-AS-OF] `RWS-0012-C04`: 독립 감사가 화자 누출·질문 소유권 모순·의미 drift를 찾아 수정·재감사했다.
- [VERIFIED-AS-OF] `RWS-0012-C05`: 제품 소유자용 최소 독서 경로와 내부 유지보수 경로가 분리됐다.
- [UNKNOWN] `RWS-0012-C06`: 해당 문서 흐름의 제품 runtime·UI 구현은 증명되지 않았다.

## 실제 업무 흐름

1. 제품 문서와 편집 출처 원장이 같은 독자에게 노출되는 문제를 확인했다.
2. 제품 매뉴얼·기술 계약·owner 결정·문서 운영 규칙을 분리했다.
3. 공통 객체·질문·승인 ID를 유지하며 문서 간 역링크를 만들었다.
4. 중단된 weave 작업을 명시적으로 재개해 완료본을 만들었다.
5. PM·WM·독립 auditor가 화자·권위·링크·질문 소유권을 검사했다.
6. 제품 owner가 읽을 최소 경로와 개발자가 사용할 운영 경로를 구분했다.

## 증거 경계

| 문서에서 확인됨 | 제품에서 확인되지 않음 |
|---|---|
| anchor·링크·질문·owner mapping | runtime 동작 |
| 화자·독자·권위 분리 | 최종 UI 수용성 |
| 독립 감사 PASS | 배포·사용자 행동 성공 |

## EG-Desk 목표 시나리오

```text
receiving situation 식별 → 제품/기술/owner/운영 문서로 route
→ stable concept·question ID 유지 → 양방향 link
→ candidate freeze → 독립 화자·권위 audit → 독자별 진입 경로 제공
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 후보 기법 | 역할별 writer + source-isolated authority auditor |
| trigger | 한 문서에 제품 화자와 편집 지시가 함께 나타날 때 |
| 위험 | Agent 역할을 제품 runtime 역할로 전사 |
| acceptance | voice leak 0, unresolved link 0, owner mapping 완결 |

## Candidate product implications

- 제품 문서와 Agent 운영 provenance를 같은 사용자 표면에 섞지 않는다.
- 문서 PASS와 제품 runtime PASS를 별도 상태로 표시한다.
- concept·question·approval의 owner와 receiving situation을 함께 관리한다.

## 정본 연결 후보

- [Atlas 시작점](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-manual-start)
- [기술 Contract](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-contract-top)
- [Documentation Governance](../../../codex/egdesk-product-documentation-governance.md#doc-governance-top)

## 열린 질문

- 독자별 문서 진입 경로를 제품 안에서 어떻게 보여주는가?
- 한 concept의 서로 다른 수신 상황 표현을 어떻게 동기화하는가?
- runtime evidence가 생겼을 때 문서 claim을 어떻게 승격하는가?

## Privacy

임시 후보 경로, raw prompt와 Agent 내부 운영문은 복제하지 않았다. permission-safe
thread·turn과 문서 구조 finding만 남겼다.
