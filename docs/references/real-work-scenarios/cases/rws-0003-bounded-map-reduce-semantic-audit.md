<a id="rws-0003"></a>
# RWS-0003 — 장문 번역의 bounded map/reduce와 독립 의미 감사

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-08-04`
- **business_owner**: EG-Desk 제품 문서
- **source_owner**: 해당 Codex 부모 thread와 연결된 worker·auditor child threads
- **action_authority**: Worker는 격리된 임시 산출물만 작성하고 Main이 정본 통합을 소유

## 요약

1천 줄이 넘는 Atlas를 한국어 정본으로 바꾸면서 context 한계로 후반 내용이 생략되거나
축약될 위험을 줄이기 위해 의미 구간별 worker와 독립 auditor를 사용했다. Worker의 자체
구조 검사는 통과했지만 별도 감사가 권한·정체성·최신성·상태 토큰의 의미 오역을 찾아냈고,
수정·재감사 뒤 Main이 정본을 조립했다. 이 사례는 multi-agent가 유효하려면 단순 분할이
아니라 write isolation, 공통 schema, frozen input과 독립 judge가 필요함을 보여준다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0003-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `019f8d42-4886-7041-8421-c5e343d465e0`, turns 42–43 | 2026-08-04 | `RWS-0003-C01`–`RWS-0003-C04` | `RESOLVED` |
| `RWS-0003-SR-02` | Codex child lineage | `LOCAL-RESTRICTED` | workers `019fcab4-22cc-7b11-96a9-a4fbf0d51ebd`, `019fcab4-236e-76c1-8f12-145b6025f401`, `019fcab4-258d-7f73-b9f5-c08cd6e0271f`, `019fcab4-244d-7d33-b190-991242e4a774`, `019fcab4-24ce-7502-8487-24274a11862f`, `019fcab4-224f-77d1-842a-11a153592508`, `019fcab9-a1ee-70c1-833e-6fa82a4165e7`; auditors `019fcac0-4f8a-7592-8306-c246576e3802`, `019fcac0-51e0-7ad3-babf-dc6d97c022f1`, `019fcac6-dbfc-73a1-894d-6d3cdb19004c`, `019fcac0-50f1-7a70-adcd-1a4d713b97fb`, `019fcac0-4f25-7ff3-9ba3-2662dbc9e3d5`, `019fcac0-5023-72b0-a912-d00480abd35b`, `019fcac0-53ad-7363-bb28-fc9893ef3b7a`; each turn 1 | 2026-08-04 | `RWS-0003-C02`–`RWS-0003-C05` | `RESOLVED` |

### Claims

- [INFERRED] `RWS-0003-C01`: 긴 문서를 의미 단위로 분할하면 각 worker가 담당 범위를 완독·작성할
  가능성이 높아진다.
- [INFERRED] `RWS-0003-C02`: Worker 자체 구조 검사는 의미 보존 증거가 아니며 독립 원문 대조가
  실제 오역을 발견했다.
- [VERIFIED-AS-OF] `RWS-0003-C03`: Worker는 정본이 아니라 격리된 임시 산출물만 수정하고 Main이 최종
  조립·검증을 소유했다.
- [VERIFIED-AS-OF] `RWS-0003-C04`: 동시 실행 슬롯 한도를 넘은 호출은 거부됐고 작업을 파동으로 나눠야 했다.
- [INFERRED] `RWS-0003-C05`: 독립 감사 없이 Agent 수만 늘리면 용어·경계 불일치와 잘못된 확신이
  증가할 수 있다.

## 실제 업무 흐름

1. 사용자 검토 정본 자체를 한국어화하되 별도 축약판을 만들지 않기로 했다.
2. 문서를 서로 겹치지 않는 7개 의미 구간으로 나눴다.
3. 각 worker는 자기 구간과 임시 파일만 소유하고 정본을 수정하지 않았다.
4. 처음 7개 동시 호출은 실행 슬롯 한도로 거부되어 6개와 후속 1개 파동으로 나눴다.
5. worker 자체 검사는 표·ID·링크·행 수 같은 구조 보존을 확인했다.
6. 별도 auditor가 각 번역을 원문과 대조해 권한 강도, identity, stale, stage,
   capability 등의 의미 변화와 상태 토큰 손실을 발견했다.
7. Main이 finding을 통합해 수정하고 같은 auditor가 해당 구간을 재검증했다.
8. 모든 구간이 독립 검사를 통과한 뒤 Main이 전체 문서를 조립했다.
9. 최종 구조·ID·표·질문·링크를 다시 전수 확인하고 정본에 적용했다.

## 결정·실패·교정

- “여러 worker가 구조를 보존했다”는 사실을 번역 완료로 인정하지 않았다.
- 번역 worker와 의미 auditor를 같은 역할로 두지 않았다.
- 제품 고유 용어와 상태 토큰은 임의로 현지화하지 않고 공통 용어 경계를 사용했다.
- 실행 슬롯 한도를 실패로 끝내지 않고 wave scheduling으로 전환했다.
- worker 산출물을 바로 정본에 합치지 않고 finding disposition 뒤 Main이 단일 통합했다.

## 증거 경계

| 주장 | 당시 증거 | 이 사례가 주장하지 않는 것 |
|---|---|---|
| 구간별 번역 생성 | child 임시 산출물과 범위 | 의미가 정확함 |
| 구조 보존 | ID·표·링크·행 count | 권한·조건·정체성 의미 보존 |
| 의미 감사 통과 | 원문 대조 finding과 재검증 | 현재 파일이 이후에도 동일함 |
| 정본 조립 | Main의 전체 구조 검사 | 제품 기능 구현·런타임 검증 |

## EG-Desk 목표 시나리오

```text
integration 기능: source revision과 의미 경계 동결
  -> shared terminology·status-token contract 작성
  -> 문서를 비중첩 section packet으로 분할
  -> wave scheduler가 허용 슬롯만큼 Worker 실행
  -> Worker: 자기 packet 완독·임시 artifact 작성·coverage 보고
  -> integration 기능: 모든 packet 수신·누락 검사
  -> independent auditor: frozen source와 artifact를 의미 대조
  -> finding별 수정·재감사
  -> 권한 있는 정본 편집 기능: 단일 조립·전수 구조 검사
  -> 사용자: 변경 범위·남은 위험 확인
```

supervision projection 후보는 worker 수보다 각 packet의 source range, coverage,
artifact revision, 감사 상태와 finding disposition을 중심으로 표시한다.

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 관찰된 문제 | 단일 context에서 장문 전체를 번역·재검토하면 후반 생략과 자기검증 편향 위험 |
| 사용 기법 | context isolation, manager-worker, parallel map/reduce, independent judge, explicit handoff |
| 적용 trigger | 구조·의미 보존이 필요한 장문을 한 context에서 완독·생성·검토하기 어려울 때 |
| 기대 효과 | 구간별 완독, 병렬 처리, 오류 범위 격리, 독립 의미 검증 |
| 비용·위험 | 높은 token·latency·통합 비용, 경계 문맥 손실, 용어 불일치, 임시 복제물 privacy |
| acceptance evidence | frozen source, 구간 coverage, 구조 count, 독립 P0/P1 0, 조립본 전수 대조 |
| 증거 상태 | 실제 사용됨 |

문서가 작거나 section 의존성이 강하면 분할하지 않는 편이 낫다. 여러 Agent가 같은 정본을
동시에 수정하거나 worker끼리 서로의 결과를 감사하면 isolation과 독립성이 사라진다.

## Candidate product implications

- Task에는 `source range`, `context packet revision`, `write boundary`, `expected artifact`,
  `coverage`와 `acceptance evidence`가 필요하다.
- wave scheduler는 슬롯 한도와 dependency를 보이고 완료 packet부터 통합할 수 있어야 한다.
- Worker 자체 검사와 independent audit를 별도 상태로 표시해야 한다.
- 감사 시작 전에 source와 candidate artifact revision을 동결해야 한다.
- integration 기능은 packet 누락·경계 중복·용어 drift와 finding disposition을 종합한다.
- translation, 대형 file-read, archive inventory 등 map/reduce 패턴을 공유하되 업무 판단
  권한까지 worker에게 넘기지 않는다.

## 정본 연결 후보

- [Atlas AI-06](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-06)
- [Contract §9 dependency orchestration](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-dependency-orchestration)
- [Contract §11 parallel Agents](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-parallel-agents)
- [HUM-ORCH-001](../../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001)

## 열린 질문

- section 경계의 문맥 overlap과 중복 번역을 어떤 규칙으로 조정하는가?
- auditor 독립성을 source packet·fork context·model·prompt·candidate hash 중 무엇으로 증명하는가?
- 중단된 child가 이전 완료 artifact를 가진 경우 supervision 화면은 어떤 상태로 표시하는가?
- privacy-sensitive 원문을 여러 worker에게 전달하지 않고 map/reduce하려면 어떤 local Reader가 필요한가?
- token·latency 비용이 단일 Agent보다 커지는 임계값을 어떻게 측정하는가?

## Privacy

원문 전체, 임시 파일 경로, worker identity와 raw finding 전문은 복제하지 않았다. 민감한
원문이라면 packet에는 필요한 section과 redaction policy만 포함하고, worker artifact도
원자료와 같은 접근 등급·보존 기간을 적용해야 한다.
