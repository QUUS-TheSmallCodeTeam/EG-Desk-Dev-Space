<a id="rws-0030"></a>
# RWS-0030 — 업무지식 Agent의 versioned Scenario Lab

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-08-13~20`
- **business_owner**: Taehwatrans 업무지식 평가
- **source_owner**: archived Scenario Lab session과 평가 artifact
- **action_authority**: 평가 Worker는 공식 장부·메일·ERP write 금지, 통합 판정은 평가 owner

## 요약

Agent가 ontology 문서를 따르는지보다 실제 결과·근거·안전 경계를 충족하는지 평가하도록
기준을 바꿨다. 서로 다른 file revision을 비교한 false failure를 철회하고 v2 50개를
중단·재개점과 함께 전수 통합했다. v3는 확장됐지만 확인된 실행은 일부뿐이다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0030-SR-01` | archived Codex user thread | `ARCHIVED-SESSION-RESTRICTED` | `019fd492-0a36-7df0-aa3e-fbdbddaa8561`, turns 118–123, 134–147, 154–164 | 2026-08 | `RWS-0030-C01`–`RWS-0030-C06` | `RESOLVED` |

### Claims

- [VERIFIED-AS-OF] `RWS-0030-C01`: 과정 준수보다 실제 결과·근거·안전 경계를 평가하도록 기준이 교정됐다.
- [VERIFIED-AS-OF] `RWS-0030-C02`: 서로 다른 file revision 비교로 생긴 false failure가 발견돼 철회됐다.
- [VERIFIED-AS-OF] `RWS-0030-C03`: v2 50개 scenario가 중단·재개점을 분리해 전수 통합됐다.
- [VERIFIED-AS-OF] `RWS-0030-C04`: Worker가 공식 장부·메일·ERP를 변경하지 않았다는 write boundary가 확인됐다.
- [OBSERVED] `RWS-0030-C05`: 초기 privacy·authority failure가 실제 평가 finding으로 남았다.
- [UNKNOWN] `RWS-0030-C06`: 확장된 v3의 전수 실행과 현재 ontology 상태는 확인되지 않았다.

## 실제 업무 흐름

1. 과거 scenario와 평가 기준선을 복원했다.
2. 문서 준수 중심 평가를 결과·근거·안전 중심으로 바꿨다.
3. 초기 실행에서 stale revision 비교로 false failure가 발생했다.
4. source revision을 고정하고 판정을 철회·재실행했다.
5. v2 50개 실행을 중단·재개점과 함께 통합했다.
6. v3는 설계·부분 실행 상태로 남기고 전수 완료를 주장하지 않았다.

## 증거 경계

| 확인됨 | 확인되지 않음 |
|---|---|
| v2 50/50 실행·통합 | v3 전수 실행 |
| source revision 오류 교정 | 현재 ontology·업무 상태 |
| write boundary·finding | EG-Desk 제품 평가 runtime |

## EG-Desk 목표 시나리오

```text
evaluation version·source snapshot freeze → scenario dispatch
→ result/evidence/safety judge → stale baseline 탐지
→ verdict retract·rerun → interrupted/resumed lineage 통합
→ version별 complete·partial 상태 표시
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 후보 기법 | isolated Worker + frozen judge + version integrator |
| trigger | 업무지식 Agent를 반복 회귀 평가할 때 |
| 위험 | stale source와 incomplete wave를 완료로 합침 |
| acceptance | version, source hash, scenario count, verdict disposition |

## Candidate product implications

- 평가 version과 source snapshot을 필수 binding으로 둔다.
- 중단·재개·부분 실행과 전수 완료를 분리한다.
- 과정 준수보다 업무 결과·근거·권한·privacy를 평가한다.

## 정본 연결 후보

- [Atlas AGENT-02](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-agent-02)
- [Atlas AI-06](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-06)
- [Contract parallel Agents](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-parallel-agents)

## 열린 질문

- evaluation source snapshot과 실제 업무 최신성을 어떻게 연결하는가?
- privacy failure를 재현하지 않고 회귀하는 방법은 무엇인가?
- partial wave의 사용자-facing 진행 상태는 무엇인가?

## Privacy

직원·고객·메일·급여·ERP 값과 scenario 원문은 복제하지 않았다. version·집계 판정·
write boundary와 permission-safe SourceRef만 남겼다.
