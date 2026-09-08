<a id="rws-0031"></a>
# RWS-0031 — ERP 매뉴얼 지식의 live A/B 평가와 결손 보강

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-07-30~2026-08-02`
- **business_owner**: Taehwatrans ERP 지식 운영
- **source_owner**: 공식 가이드 파생 corpus와 live tenant A/B 기록
- **action_authority**: Browser Worker는 읽기 전용, 업무 transaction과 개인정보 저장 금지

## 요약

공식 매뉴얼 지식 제공 여부가 live ERP 탐색의 속도·정확성·근거·안전에 미치는 영향을
평가했다. 초기 소표본 결론을 철회하고 대규모 A/B, 결손 보강·재색인·영향 재시험으로
확대했다. 실제 주문·회계 transaction과 현재 tenant 권한은 확인되지 않았다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0031-SR-01` | Codex user thread | `PROJECT-RESTRICTED` | `019fa654-2417-7991-8a0c-1d8f505461b0`, turns 6–14 | 2026-07-30~2026-08-02 | `RWS-0031-C01`–`RWS-0031-C06` | `RESOLVED` |

### Claims

- [OBSERVED] `RWS-0031-C01`: 최초 소수 화면 파일럿을 전체 효과처럼 해석한 문제가 있었다.
- [VERIFIED-AS-OF] `RWS-0031-C02`: 사용자 지적 뒤 대규모 제공/비제공 A/B로 범위가 확대됐다.
- [VERIFIED-AS-OF] `RWS-0031-C03`: 매뉴얼 보조는 exact path와 업무 의미·근거 품질을 개선했다.
- [VERIFIED-AS-OF] `RWS-0031-C04`: blind 조건은 일부 단순 경로에서 더 빨랐지만 추정·미답이 증가했다.
- [VERIFIED-AS-OF] `RWS-0031-C05`: 결손→보강→재색인→영향 재시험과 retrieval 회귀가 실행됐다.
- [UNKNOWN] `RWS-0031-C06`: 실제 transaction 완료, 현재 tenant 권한·최신 매뉴얼과 장기 성능은 확인되지 않았다.

## 실제 업무 흐름

1. 공식 가이드 파생 지식 corpus를 준비했다.
2. 소수 live 화면에서 제공/비제공 조건을 비교했다.
3. 표본 부족 지적 뒤 대규모 과제로 확대했다.
4. stale Browser를 폐기하고 정확한 업무 profile에서 재실행했다.
5. 결손 finding을 보강·재색인하고 영향 과제를 재시험했다.
6. 안전·개인정보·write 0 경계를 확인했다.

## 증거 경계

| 확인됨 | 확인되지 않음 |
|---|---|
| 당시 A/B·보강·재시험 | 현재 tenant·manual revision |
| navigation·근거 품질 차이 | 실제 transaction 성공 |
| read-only·privacy boundary | 장기 반복 성능 |

## EG-Desk 목표 시나리오

```text
knowledge revision·tenant profile freeze → paired A/B task
→ speed·path·meaning·evidence·safety judge
→ coverage gap → corpus patch·reindex → impacted rerun
→ current tenant·transaction UNKNOWN 분리
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 후보 기법 | paired isolated Workers + independent A/B judge |
| trigger | 외부 매뉴얼 지식의 실제 UI 효용을 평가할 때 |
| 위험 | 소표본·stale profile·provider 지식을 tenant 권한으로 오인 |
| acceptance | paired tasks, same profile/revision, impact rerun |

## Candidate product implications

- 외부 지식 제공 여부를 같은 task·profile·revision에서 비교한다.
- 결손 finding을 corpus patch와 영향 회귀에 연결한다.
- 공식 매뉴얼 존재와 tenant 권한·실행 성공을 분리한다.

## 정본 연결 후보

- [Atlas BROWSER-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-browser-01)
- [Atlas AGENT-02](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-agent-02)
- [Contract parallel Agents](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-parallel-agents)

## 열린 질문

- paired A/B의 profile·tenant·source revision을 어떻게 동결하는가?
- 결손 보강의 영향 범위를 어떤 dependency graph로 계산하는가?
- live transaction 없이 UI 업무성공을 어디까지 평가할 수 있는가?

## Privacy

ERP 값, 직원·고객·거래정보, profile·계정 식별자와 매뉴얼 원문은 복제하지 않았다.
평가 조건·집계와 permission-safe SourceRef만 남겼다.
