<a id="rws-0001"></a>
# RWS-0001 — Git 체크포인트·푸시 검토·원격 확인의 분리

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-08-30`
- **business_owner**: EG-Desk 제품 개발
- **source_owner**: 해당 Codex 사용자 thread
- **action_authority**: 로컬 commit·push는 제품 소유자의 명시적 요청 뒤 Main이 수행

## 요약

세 차례의 실제 Git 작업에서 `로컬 변경`, `staged`, `커밋`, `push 검토`, `원격 반영`,
`로컬·원격 일치`, `ignored local`이 서로 다른 상태임이 반복해서 드러났다. 첫 작업에서는
너무 넓은 체크포인트를 push 전에 다시 분류해 개인·생성 자산을 제외했고, 후속 작업에서는
운영 설정과 제품 문서를 분리 커밋했으며, 마지막 작업에서는 fetch 뒤 divergence를 확인한
후 일반 push와 원격 HEAD를 검증했다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0001-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `019f8d42-4886-7041-8421-c5e343d465e0`, turns 1–6 | 2026-07-23 | `RWS-0001-C01`, `RWS-0001-C02` | `RESOLVED` |
| `RWS-0001-SR-02` | Codex user thread | `LOCAL-RESTRICTED` | 같은 thread, turns 62–63 | 2026-08-08 | `RWS-0001-C01`, `RWS-0001-C03` | `RESOLVED` |
| `RWS-0001-SR-03` | Codex user thread | `LOCAL-RESTRICTED` | 같은 thread, turns 99–103 | 2026-08-30 | `RWS-0001-C01`–`RWS-0001-C04` | `RESOLVED` |

### Claims

- [VERIFIED-AS-OF] `RWS-0001-C01`: 작성됨, 검증됨, staged, committed, pushed와 원격 일치는 별도 상태다.
- [VERIFIED-AS-OF] `RWS-0001-C02`: Git이 추적할 수 있다는 사실만으로 생성·개인·local-only 자산을
  공유 정본에 포함해서는 안 된다.
- [VERIFIED-AS-OF] `RWS-0001-C03`: 운영 설정과 제품 문서는 서로 다른 검토·커밋 단위가 될 수 있다.
- [VERIFIED-AS-OF] `RWS-0001-C04`: untracked가 없다는 사실과 ignored local 자산이 없다는 사실은 다르다.

## 실제 업무 흐름

### 1차 체크포인트와 push 전 재분류

1. 저장소 구조와 변경 규모를 확인했다.
2. 비무시 변경을 로컬 체크포인트로 커밋하고 push는 보류했다.
3. push 검토에서 canonical 설정 외에 생성된 inventory, preview와 개인 자동화 자산이
   함께 들어간 사실을 발견했다.
4. local-only·personal 자산을 추적 대상에서 제외하고 commit을 재작성했다.
5. 제품 소유자가 제외 경계를 확인한 뒤 push했다.
6. 로컬과 원격 HEAD, divergence와 clean 상태를 각각 확인했다.

### 운영 설정과 제품 문서의 분리 커밋

1. PM·WM 라우팅 설정과 Atlas·Contract 문서 변경을 별도 묶음으로 검토했다.
2. 각 묶음을 독립 커밋으로 만들고 로컬 `main`이 원격보다 앞선 상태임을 보고했다.
3. 이 구간에서는 push하지 않았으며, 커밋 완료를 원격 반영으로 표현하지 않았다.

### 문서 Governance 반영과 원격 공개

1. 수정 8개와 신규 문서 1개를 확인했다.
2. 전용 문서 validator와 whitespace 검사를 통과시켰다.
3. 정확한 9개 파일만 stage해 새 commit을 만들었다.
4. push 요청 뒤 먼저 fetch하고 `behind 0 / ahead 3`을 확인했다.
5. force 없이 일반 push를 수행했다.
6. 로컬 HEAD, tracking ref와 실제 원격 branch SHA가 일치하는지 각각 확인했다.
7. clean 상태 뒤에도 ignored local 자산은 별도 tree로 남아 있음을 확인했다.

## 결정·실패·교정

- 첫 커밋은 안전한 로컬 checkpoint였지만 그대로 push할 범위는 아니었다.
- push 전에 자산 의미를 다시 분류해 commit 경계를 바꿨다.
- `커밋할 변경`, `이미 커밋됨`, `push할 커밋`, `원격 반영됨`을 별도로 보고했다.
- remote-tracking ref가 최신인지 확인하기 위해 실제 push 전 fetch를 수행했다.
- `미커밋 파일 없음`이라는 답 뒤 사용자가 ignored 항목을 다시 물어, untracked와 ignored의
  차이를 별도 보고했다.

## 증거 경계

| 주장 | 당시 증거 | 이 사례가 주장하지 않는 것 |
|---|---|---|
| commit 생성 | Git commit ID와 staged diff | 기능이 실제로 동작함 |
| push 완료 | push 결과와 원격 branch SHA | 배포·Production 반영 |
| clean working tree | Git status | ignored local 자산 부재 |
| 자산 제외 | tracked/untracked/ignore 상태 | 모든 secret·privacy 위험 제거 |
| 문서 validator 통과 | ID·링크·표·화자·구조 검사 | 제품 설계의 옳음이나 구현 완료 |

이 SourceRef들은 각 시점의 Git 상태를 검증한다. 2026-08-30 이후의 새로운 변경이나
현재 원격 상태를 계속 보장하지 않는다.

## EG-Desk 목표 시나리오

```text
사용자: 로컬 체크포인트 요청
  -> System: working/staged/untracked/ignored와 remote freshness 표시
  -> 요청 담당 Agent: 로컬 commit 후보와 검토되지 않은 push 범위 분리
  -> 사용자: push 검토 요청
  -> System: canonical/generated/local-only/personal 후보와 근거 표시
  -> integration 기능: 승인된 범위만 commit에 반영
  -> 사용자: push 요청
  -> System: fetch, divergence, 대상 remote와 branch 확인
  -> 권한이 있는 실행 기능: 일반 push
  -> System: local/tracking/remote SHA와 남은 local-only 상태 검증
```

Chat에는 “commit 완료” 같은 짧은 설명을 두고, Canvas에는 변경 분류, staged manifest,
검증 결과, 원격 상태와 ignored-local 목록을 서로 다른 projection으로 보여준다.

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 관찰된 문제 | 첫 commit의 범위가 너무 넓었고 push 직전에야 local-only 자산을 발견했다 |
| 후보 기법 | `context isolation`된 read-only push reviewer 1명 |
| 적용 trigger | tracked 변경 수가 크거나 generated·personal 후보가 함께 있을 때, push 전 한 번 |
| 기대 효과 | integration owner의 checkpoint 의도와 공유 정본 경계를 독립적으로 대조 |
| 비용·위험 | 추가 diff 읽기와 latency; 경로·파일명이 reviewer context에 복제될 수 있음 |
| acceptance evidence | 전체 staged manifest 분류, 미분류 0, 사용자 승인, push 뒤 remote SHA 일치 |
| 증거 상태 | 당시 독립 subagent reviewer는 사용되지 않았고 Main의 별도 검토로 수행됨 |

짧고 범위가 명확한 commit에는 추가 Agent가 필요하지 않다. 여러 writer나 release Agent가
동시에 Git index·commit·push를 소유하면 중복 push와 staging 충돌 위험만 커진다. 단일
integration owner가 write 권한을 유지하고, 필요한 경우에만 read-only reviewer를 붙인다.

## Candidate product implications

- Git 표면은 `working`, `staged`, `committed`, `ahead/behind`, `pushed`, `deployed`,
  `production-verified`를 합치지 않아야 한다.
- tracked 여부와 별도로 `canonical`, `generated`, `local-only`, `personal`, `sensitive`
  분류가 필요하다.
- push는 외부 효과이므로 대상 remote·branch·divergence와 최종 원격 receipt를 보여야 한다.
- ignored local 자산도 사용자가 요청하면 별도 inventory로 볼 수 있어야 한다.
- commit·push 검토의 정본은 Chat 장문이 아니라 Canvas의 manifest와 evidence projection이다.

## 정본 연결 후보

- [Atlas CODE-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-code-01)
- [Contract §6 사람 중심 코딩 표면](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-coding-surface)
- [Contract §13 실패 경계](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries)
- [HUM-CODE-001](../../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-code-001)

이 링크는 현재 관련 정본 위치를 가리킬 뿐, 해당 정본이 이 사례의 후보 함의를 이미
채택했다는 뜻이 아니다.

## 열린 질문

- push 전 필수 검사와 선택 검사의 최소 기준은 무엇인가?
- generated·local-only·personal 자산 분류를 어느 정도 자동화할 수 있는가?
- secret scanning 결과와 privacy 검토의 보장 범위를 어떻게 표현할 것인가?
- direct `main` push와 branch·PR 흐름을 제품이 언제 구분해 권고할 것인가?
- ignored local 자산의 보존·삭제·이동 권한은 누가 갖는가?

## Privacy

원격 URL, 사용자 홈 경로, 개인 자동화 파일명, 검사 대상 문자열과 raw diff는 복제하지
않았다. 사례는 파일 범주와 상태 전이만 보존한다. SourceRef를 열 권한이 없는 독자는 이
요약만 볼 수 있으며, 원문 접근권이 없는 Agent에게 raw Git history를 자동 전달하지 않는다.
