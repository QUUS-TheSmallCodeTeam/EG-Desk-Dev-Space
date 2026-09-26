<a id="rws-0008"></a>
# RWS-0008 — 다른 PC의 작업을 Git·DB·Browser·배포 층별로 복구

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-08-19`
- **business_owner**: Grammar-ON 제품 운영
- **source_owner**: 제품 저장소·원격 DB·Browser 관찰·배포 provider의 당시 상태
- **action_authority**: 제품 소유자가 DB 공개를 승인하고, 배포는 별도 권한 계정이 소유

## 요약

다른 PC에서 전체 교재 공개와 성능개선이 처리됐다고 생각했지만 실제 상태는 branch,
원격 DB publication, alias·query code, 로컬 Browser와 Production deployment에 나뉘어
있었다. 목록은 보여도 일부 교재는 0문항이었고, 로컬에서는 빨라졌어도 Production은
이전 revision이거나 배포가 차단됐다. 업무를 하나의 “완료”로 복원하지 않고 각 층의
evidence를 대조한 뒤 누락된 층만 이어서 처리했다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0008-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `01a00ef1-78f4-7703-930c-58c7feeddc64`, turns 6–22 | 2026-08-17 | `RWS-0008-C01`–`RWS-0008-C04` | `RESOLVED` |
| `RWS-0008-SR-02` | Codex user thread | `LOCAL-RESTRICTED` | 같은 thread, turns 24–33 | 2026-08-18~19 | `RWS-0008-C01`–`RWS-0008-C06` | `RESOLVED` |

### Claims

- [VERIFIED-AS-OF] `RWS-0008-C01`: 다른 PC의 완료 진술은 Git·DB·Browser·deployment 각 층의 현재 상태를
  자동 증명하지 않는다.
- [VERIFIED-AS-OF] `RWS-0008-C02`: 콘텐츠 목록 노출과 실제 콘텐츠 사용 가능은 별도 assertion이다.
- [VERIFIED-AS-OF] `RWS-0008-C03`: 로컬 Browser 성능개선은 Production deployment·사용자 환경 개선과 다르다.
- [PROPOSED] `RWS-0008-C04`: Browser observation에는 URL·환경·app revision·DB state·deployment
  revision을 함께 연결해야 한다.
- [VERIFIED-AS-OF] `RWS-0008-C05`: 제품 소유자의 공개 승인과 자동 품질 gate 통과는 다른 evidence다.
- [INFERRED] `RWS-0008-C06`: cross-device resume는 이전 결과를 재실행하기보다 누락된 층을 찾아야 한다.

## 실제 업무 흐름

1. 학생 화면의 긴 대기를 재현하고 JSON 처리보다 큰 단일 DB query가 원인임을 측정했다.
2. 제품 정책을 과거 이력 보존에서 current-only 구조로 바꾼 뒤 DB와 query를 수정했다.
3. 로컬 측정에서 큰 개선을 확인하고 처음에는 넓은 완료 표현을 사용했다.
4. 사용자가 Production 여부를 다시 물어 로컬·DB·Git·deployment를 분리해 정정했다.
5. 다른 PC에서 전체 교재 공개를 끝냈다고 생각한 후 실제 `main`, branch, DB와 Browser를
   대조했다.
6. 교재 목록 변경은 branch에 있었지만 원격 DB publication과 일부 alias·query는 없었다.
7. 학생 화면에서 목록은 보이지만 여러 교재가 0문항인 상태를 확인했다.
8. 제품 소유자의 전량 공개 결정을 별도 기록한 뒤 branch·DB·query 층을 순서대로 보완했다.
9. Browser에서 alias·대량 조회 문제를 추가로 발견해 수정했다.
10. 로컬 교재 매트릭스와 정적 DB key 대조는 통과했지만 Production deployment 권한은
    별도 계정에 있어 최종 운영 상태는 미검증으로 남겼다.

## 결정·실패·교정

- local improvement를 Production 완료로 말한 표현을 철회했다.
- “다른 PC에서 했다”를 하나의 evidence로 보지 않고 branch·DB·UI를 각각 확인했다.
- 목록에 나타난다는 사실을 실제 문항을 열 수 있다는 증거로 보지 않았다.
- 자동 품질검수 미완료와 제품 소유자의 공개 결정을 별도 필드로 유지했다.
- 배포 권한 부재를 PC 문제나 코드 문제로 오인하지 않고 account authority로 분리했다.

## 증거 경계

| 층 | 당시 확인 | 남은 한계 |
|---|---|---|
| Git | branch·main·commit 관계와 push | 실제 Production revision과 일치 미확인 |
| DB | current publication 수량·key 대조 | 이후 변경과 현재 상태 미확인 |
| local Browser | 지연 재현·개선·교재 open | Production·실사용자 경험 아님 |
| Product policy | 제품 소유자의 전량 공개 결정 | 자동 quality approval과 다름 |
| Deployment | 권한 gate와 blocked 상태 | 실제 READY SHA·alias·smoke 없음 |

## Browser tool-call fracture

| 흐름 | 마지막 정상 상태 | break | fault layer | recovery |
|---|---|---|---|---|
| login → unit navigation → network wait → reobserve | dashboard·일부 unit 정상 | 큰 query가 지연 뒤 실패 | backend query·Browser wait | 작은 batch와 backend trace로 원인 분리 |
| catalog list → textbook open → count | 목록은 보임 | 일부 page가 0문항 | DB publication·alias·query revision | layer별 key·publication·mapping 보완 |
| local measurement → completion report | local production mode 개선 | 실제 deployment는 old/blocked | environment·revision·authority | URL·app SHA·DB·deployment envelope로 정정 |

## Cross-device context·handoff

| 필드 | 당시 문제 | EG-Desk 후보 |
|---|---|---|
| source device | 다른 PC에서 작업했다는 진술만 존재 | device ID보다 branch·artifact·DB receipt를 handoff에 포함 |
| Git state | 작업 commit이 branch에만 있음 | base·head·ahead/behind·merge 상태 readback |
| DB state | code 목록과 publication이 불일치 | migration/publication revision과 actor 기록 |
| Browser state | 이 PC의 local 화면만 관찰 | device·profile·URL·app revision별 projection |
| deployment authority | 작업 PC 계정에 Production 권한 없음 | release owner와 필요한 handoff action 분리 |

Handoff packet은 이전 PC의 “완료” 문장이 아니라 last verified artifact, branch, DB receipt,
미확정 층, 실행 권한과 idempotency 정보를 전달해야 한다.

## EG-Desk 목표 시나리오

```text
다른 device 업무를 재개
  -> Device Context Envelope·handoff packet 확인
  -> Git·DB·Browser·deployment state를 병렬 read-only 조회
  -> 이미 확인된 층과 누락·stale 층 분리
  -> 사용자에게 변경·공개·배포 authority 확인
  -> 단일 write owner가 누락 층만 변경
  -> local Browser acceptance
  -> deployment owner handoff
  -> Production revision·UI·receipt readback
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 관찰된 문제 | 한 Agent가 DB·code·Browser·deployment를 모두 판단해 local 완료를 확대함 |
| 후보 기법 | layer별 read-only mapper + single write owner + fresh environment auditor |
| trigger | 둘 이상의 device 또는 DB·code·deployment 세 층 이상이 관련될 때 |
| 기대 효과 | 누락 층 발견, stale claim 제거, self-verification bias 감소 |
| 비용·위험 | revision merge 비용, DB·계정 정보 확산, 서로 다른 snapshot 비교 오류 |
| acceptance | frozen evidence envelope, mapper별 source revision, integration disposition, Production readback |
| 증거 상태 | 당시 Browser·DB·Git 대조는 실제 사용; 완전한 multi-agent 분리는 사후 제안 |

같은 DB를 여러 writer가 동시에 변경하거나 한 Browser session을 병렬 조작하는 것은
비추천이다. static key·publication 대조만 immutable snapshot에서 map/reduce할 수 있다.

## Candidate product implications

- Device Context Envelope와 layer별 evidence matrix가 필요하다.
- `listed`, `openable`, `query-success`, `deployed`, `production-verified`를 분리한다.
- 다른 device handoff는 자유문장이 아니라 branch·artifact·DB·deployment receipt를 포함한다.
- 제품 소유자 승인과 자동 quality gate를 분리한다.
- local test와 Production evidence를 하나의 Answer에서 명확히 구분한다.
- cross-device retry는 idempotency key와 write owner를 확인한 뒤 시작한다.

## 정본 연결 후보

- [Atlas BROWSER-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-browser-01)
- [Atlas CODE-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-code-01)
- [Contract §3 identity](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-resource-identity)
- [Contract §13 failure boundary](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries)
- [HUM-CODE-001](../../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-code-001)

## 열린 질문

- device handoff packet의 최소 revision·receipt 집합은 무엇인가?
- DB·Git·deployment가 서로 다른 시점이면 어느 snapshot을 기준으로 비교하는가?
- remote device가 offline일 때 local-only 변경 존재를 어떻게 표시하는가?
- Canvas 초대 시 어느 device·Board·View evidence를 공유하고 무엇을 숨기는가?
- 배포 권한 없는 device에서 완료 조건을 어디까지 인정하는가?

## Privacy

학생·계정·콘텐츠 원문, DB key, 배포 URL·계정, device 이름, 경로와 screenshot은 복제하지
않았다. `PROPOSED`: shared Canvas에는 선택된 Board·artifact·evidence만 projection하고
device의 credential·private Chat·local-only 파일과 raw desktop은 기본 제외하는 후보
규칙을 둔다.
