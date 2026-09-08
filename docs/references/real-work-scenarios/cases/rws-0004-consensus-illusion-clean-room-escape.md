<a id="rws-0004"></a>
# RWS-0004 — 다중 PM 합의 착시와 clean-room context escape

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-08-04`
- **business_owner**: EG-Desk 제품 설계
- **source_owner**: 해당 Codex 부모 thread와 PM·WM·critic child lineage
- **action_authority**: 제품 의미는 실제 제품 소유자, 정본 편집·통합은 Main이 소유

## 요약

PM이 많은 유스케이스와 높은 감사 점수를 만들었지만, Main이 임의로 사용한
`Workspace`라는 정의되지 않은 용어가 PM 문서와 감사 기준 전체로 전파됐다. 동일한
전제와 mutable candidate를 읽은 여러 PM·critic은 이를 제거하지 못하고 높은 점수로
합의했다. 사용자가 용어의 근거를 직접 질문한 뒤 완료 판정을 철회했고, 허용 source와
제외 source를 고정한 clean-room 재작성으로 전환했다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0004-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `019f8d42-4886-7041-8421-c5e343d465e0`, turns 22–41 | 2026-07-28~2026-08-04 | `RWS-0004-C01`–`RWS-0004-C05` | `RESOLVED` |

### Claims

- [INFERRED] `RWS-0004-C01`: 많은 사례와 높은 문서 점수는 fundamental UI 상세도나 제품 의미의
  정확성을 자동으로 증명하지 않는다.
- [INFERRED] `RWS-0004-C02`: 같은 오염된 source와 framing을 공유한 여러 PM·critic은 독립적이지
  않으며 합의 착시를 만들 수 있다.
- [VERIFIED-AS-OF] `RWS-0004-C03`: 정의되지 않은 일반 용어가 Main의 표현에서 PM 문서와 감사 기준으로
  전파될 수 있다.
- [INFERRED] `RWS-0004-C04`: 제품 소유자의 교정이 기존 premise를 무효화하면 fresh source packet과
  clean-room 재작성으로 context escape해야 한다.
- [INFERRED] `RWS-0004-C05`: role simulation은 질문·반례·coverage를 만들 수 있지만 제품 사용자
  결정이나 실제 도메인 증거를 대신하지 않는다.
- [PROPOSED] `RWS-0004-C06`: candidate가 감사 중 계속 바뀌면 critic verdict가 stale해지므로 감사 전
  revision을 동결해야 한다.

## 실제 업무 흐름

1. 신규 PM에게 가능한 많은 EG-Desk 사용자 사례를 요청했다.
2. PM은 상세 여정·추가 사례·실패 사례를 대량 생성했다.
3. 사용자가 Agenda·Desk·SourceRef·Terminal·Chat/Canvas·Playback·Await·Ontology 등에서
   근본적인 의미 오독을 지적했다.
4. 사례 수를 늘리는 대신 사용자의 UI 행동과 상태 전이를 추적하는 Atlas로 전환했다.
5. PM 편집과 여러 독립 감사가 반복됐고 구조 count와 높은 점수가 보고됐다.
6. 저장된 Agenda 열기 선택지에 Main이 사용한 `새 Workspace`가 제품 객체처럼 남았다.
7. 사용자가 Workspace의 실제 기능·Desk와의 관계·근거를 연속 질문했다.
8. 기록을 추적한 결과 최초 제품 모델에는 Workspace가 없고 Main의 표현이 PM 문서로
   전파된 사실을 확인했다.
9. 이전 완료 판정과 해당 권장안을 철회했다.
10. 기존 Atlas와 같은 라운드의 Contract를 reference-only로 강등하고, 제품 소유자 결정과
    이전 독립 기준선만 허용한 source manifest로 clean-room 재작성을 시작했다.
11. 서로 다른 PM이 기초 초안·반대 감사·질문 전수성을 검토하고 Main이 단일 정본을 썼다.
12. 모든 미결정을 제품 소유자·PM 조사·승인 경계로 숨김없이 라우팅하는 것을 문서 완료
    기준으로 바꿨다.

## 결정·실패·교정

- “많은 유스케이스”를 제품 요구사항 생성 방식으로 쓰던 접근을 폐기했다.
- PM 자체 평가와 동일 source를 보는 다수 critic의 고득점을 완료 증거로 인정하지 않았다.
- `Workspace`를 Desk의 동의어·하위 객체·별도 객체 어느 것으로도 확정하지 않고 제거했다.
- 이전 문서끼리 서로를 근거로 삼는 순환을 끊기 위해 clean-room source boundary를 만들었다.
- 제품 의미 질문과 세부 UI 조사, 외부 권한 승인 질문을 분리했다.
- PM이 제품 소유자의 결정을 대신하지 못하도록 권위 경계를 명시했다.

## 증거 경계

| 주장 | 당시 증거 | 이 사례가 주장하지 않는 것 |
|---|---|---|
| PM 사례·감사 생성 | child 결과와 parent 보고 | 사례가 제품 사실임 |
| 높은 점수 | critic scoring 결과 | 오염되지 않은 독립성·실제 사용자 타당성 |
| Workspace 전파 | parent 메시지와 문서·child 결과의 시간순 대조 | PM의 숨은 사고 원인 |
| clean-room 재작성 | source boundary와 반복 초안·감사 | 현재 제품 구현 완료 |
| 질문 전수성 | 당시 Q·approval registry 검사 | 모든 질문이 답변됨 |

## EG-Desk 목표 시나리오

```text
사용자 교정 또는 정의되지 않은 객체 감지
  -> System: 영향받는 candidate·Agent·결정 lineage 표시
  -> 현재 작업을 잠정 상태로 내리고 완료 claim 철회
  -> allowed source / excluded source manifest 동결
  -> fresh PM·critic에게 서로 다른 source-grounded packet 제공
  -> 초안은 정본이 아닌 isolated artifact로 반환
  -> integration 기능: 공통점보다 근거·반례·미결정 차이를 disposition
  -> candidate revision 동결
  -> independent audit
  -> 사용자 readback
  -> 승인된 의미만 정본에 반영
```

supervision projection 후보는 Agent 수나 평균 점수보다 각 Agent가 받은 source packet,
candidate hash, independence 조건, finding과 완료 lifecycle을 보여준다.

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 관찰된 문제 | 여러 PM·critic이 같은 잘못된 premise를 공유해 오류를 강화함 |
| 유효 기법 | clean-room context escape, source-isolated critics, adversarial review, user readback |
| 적용 trigger | 사용자가 의미를 부정하거나, 정의되지 않은 객체·순환 근거·score 편차가 발견될 때 |
| 기대 효과 | anchoring 탈출, 권위 원천 복원, 누락 질문과 반례 표면화 |
| 비용·위험 | 높은 token·통합 비용, context packet이 너무 작으면 과거 결정 손실, role output의 권위 오인 |
| acceptance evidence | source manifests, owner-decision 연결, candidate freeze, finding disposition, banned concept 0 |
| 증거 상태 | clean-room PM·adversarial audit가 실제 사용됨; 더 엄격한 independence 표시는 제안 |

PM을 단순히 더 많이 부르거나 동일 fork context로 투표시키는 것은 비추천이다. 오염된
source의 다수결은 사실을 만들지 못한다. 제품 소유자의 의미가 핵심이면 Agent 추가보다
짧은 readback과 권위 있는 source boundary가 먼저다.

## Candidate product implications

- 모든 Agent dispatch에는 `source packet revision`, 허용·제외 source와 권위 수준이 필요하다.
- 제품 객체·용어는 owner 결정, 정본 정의 또는 명시적 `OPEN`에 연결돼야 한다.
- candidate가 바뀌면 기존 audit verdict를 자동 stale 처리해야 한다.
- critic의 독립성은 Agent 수가 아니라 source packet·fork context·candidate hash로 설명해야 한다.
- PM·사용자·감사자 role simulation은 질문 생성 권한만 가지며 제품 승인권을 갖지 않는다.
- 사용자 대상 통합 보고에는 child 결과뿐 아니라 lifecycle, 감사 범위와 미완료 상태가
  포함돼야 한다.

## 정본 연결 후보

- [Atlas의 제품 불변조건](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-manual-start)
- [기술 Contract](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-contract-top)
- [제품 소유자 HUM 원장](../../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#gap-owner-queue)
- [Documentation Governance](../../../codex/egdesk-product-documentation-governance.md#doc-governance-top)

## 열린 질문

- critic independence를 어느 필드와 검사로 증명할 것인가?
- 제품 소유자 교정이 들어오면 이미 파생된 문서·Task·Answer를 어디까지 stale 처리하는가?
- clean-room packet에서 과거의 유효한 owner 결정을 빠뜨리지 않는 coverage 검사는 무엇인가?
- child가 이전 완료 artifact를 가졌지만 마지막 후속 turn이 진행 중이면 어떤 상태로 표시하는가?
- 역할 시뮬레이션의 질문과 실제 사용자 발언을 UI에서 어떻게 구분하는가?

## Privacy

PM·worker의 raw transcript, 내부 reasoning, 임시 파일과 절대경로는 복제하지 않았다. fresh
critic에게는 검토에 필요한 source와 candidate만 전달하고, 다른 업무의 대화·계정·민감
자료를 기본 context로 포함하지 않는다.
