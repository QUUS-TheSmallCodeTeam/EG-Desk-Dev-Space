<a id="rws-0011"></a>
# RWS-0011 — Codex 프로젝트 PM 프로필의 세션 활성화

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-07-28`
- **business_owner**: EG-Desk 개발 Agent 운영
- **source_owner**: Codex 프로젝트 프로필과 관련 parent·child thread
- **action_authority**: Main이 프로필 작성·검증·활성화를 소유하고 PM은 자문만 수행

## 요약

프로젝트 전용 PM 프로필을 작성했지만 이미 열린 세션은 새 Agent 유형을 발견하지
못했다. fresh session에서 프로필 발견과 실제 자문 호출을 따로 확인했다. 이는 EG-Desk
제품 runtime 구현이 아니라 Codex 프로젝트 운영 프로필의 활성화 사례다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0011-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `019f8d42-4886-7041-8421-c5e343d465e0`, turns 20–21 | 2026-07-28 | `RWS-0011-C01`–`RWS-0011-C04` | `RESOLVED` |
| `RWS-0011-SR-02` | Codex WM child | `LOCAL-RESTRICTED` | `019fa6d7-abb8-7270-b179-ab5037e30098`, turns 1–2 | 2026-07-28 | `RWS-0011-C01`, `RWS-0011-C02` | `RESOLVED` |
| `RWS-0011-SR-03` | Codex child threads | `LOCAL-RESTRICTED` | `019fa6e1-71b5-7f73-84ae-39865308099f`, `019fa6eb-c7d7-7db3-ab13-8071c9c00696`, `019fa6f1-7612-7572-bcd1-ff26abba9034`; each turn 1 | 2026-07-28 | `RWS-0011-C02`–`RWS-0011-C05` | `RESOLVED` |

### Claims

- [VERIFIED-AS-OF] `RWS-0011-C01`: 프로젝트 전용 PM 프로필과 역할·라우팅 계약이 생성되고 정적으로 검증됐다.
- [VERIFIED-AS-OF] `RWS-0011-C02`: 기존 세션의 미발견과 fresh session의 프로필 발견이 분리 확인됐다.
- [VERIFIED-AS-OF] `RWS-0011-C03`: fresh child에서 실제 PM 자문 호출과 결과 반환이 확인됐다.
- [OBSERVED] `RWS-0011-C04`: 프로필 파일 존재, session discovery와 실제 호출은 서로 다른 완료 단계였다.
- [UNKNOWN] `RWS-0011-C05`: 현재 새 세션에서의 재활성화와 EG-Desk 제품 Agent runtime 구현은 증명되지 않았다.

## 실제 업무 흐름

1. 프로젝트 역할·권한·라우팅을 PM 프로필로 작성했다.
2. 정적 형식 검사는 통과했지만 현재 세션은 새 Agent 유형을 발견하지 못했다.
3. 기존 세션 재시도 대신 fresh session을 만들었다.
4. fresh child가 새 PM 유형을 발견하고 실제 자문 결과를 반환했다.
5. Codex 프로젝트 프로필 활성화와 제품 기능 구현을 별도 완료 상태로 남겼다.

## 증거 경계

| 확인됨 | 확인되지 않음 |
|---|---|
| 프로필 파일·정적 형식 | 현재 모든 세션의 discovery |
| fresh session 호출·결과 | EG-Desk 제품 runtime 구현 |
| PM의 자문 역할 | 제품 결정권·Git 권한 |

## EG-Desk 목표 시나리오

```text
프로젝트 역할 정의 → profile revision 검증 → session generation 확인
→ fresh discovery probe → bounded task 호출 → 결과·권한 readback
→ profile-ready와 product-runtime-ready를 별도 표시
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 후보 기법 | fresh-session capability probe + 단일 profile owner |
| trigger | 프로필은 존재하지만 현재 session에서 유형을 찾지 못할 때 |
| 위험 | 파일 존재를 실제 activation으로 오인 |
| acceptance | profile revision, session generation, 실제 bounded call 결과 |

## Candidate product implications

- Agent 설정 존재·세션 발견·실제 호출·결과 전달을 별도 상태로 표시한다.
- 자문 Agent에게 제품 승인권이나 Git write 권한을 암묵적으로 주지 않는다.
- stale session은 반복 재시도보다 fresh capability probe로 진단한다.

## 정본 연결 후보

- [Atlas AGENT-02](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-agent-02)
- [기술 Contract](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-contract-top)
- [Documentation Governance](../../../codex/egdesk-product-documentation-governance.md#doc-governance-top)

## 열린 질문

- profile revision과 session generation을 UI에서 어떻게 연결하는가?
- active profile의 재검증 주기와 stale 조건은 무엇인가?
- 제품 Agent 설정과 개발 도구용 Agent 프로필을 어떻게 구분하는가?

## Privacy

raw profile prompt, 절대경로와 장문 child 출력은 복제하지 않았다. SourceRef와 역할·상태
경계만 보존한다.
