<a id="rws-0002"></a>
# RWS-0002 — Worktree 병렬 수정과 단일 Integration 검증 책임

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-07-28`
- **business_owner**: EG-Desk 제품 개발
- **source_owner**: 해당 Codex 사용자 thread
- **action_authority**: Main이 작업 분할·통합·최종 Git과 Firefox 검증을 소유

## 요약

Firefox 기반 EG-Desk 개발을 병렬화하려다 `worktree가 merge conflict를 막는가`,
`각 worktree에 node_modules가 필요한가`, `어디에서 build·test하는가`가 반복해서
혼동됐다. 이 대화에서 채택한 운영안은 Worker가 서로 다른 변경을 격리해 작성하고
무의존성 검사를 수행하며, Integration worktree가 완료 branch를 하나씩 병합해
의존성·공유 Firefox runtime·최종 검증을 소유하는 구조다. 해당 turn 범위는 운영안
합의까지를 증명하며 실제 병렬 Worker 실행과 통합 성공까지는 증명하지 않는다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0002-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `019f8d42-4886-7041-8421-c5e343d465e0`, turns 7–14 | 2026-07-28 | `RWS-0002-C01`–`RWS-0002-C04` | `RESOLVED` |

### Claims

- [VERIFIED-AS-OF] `RWS-0002-C01`: Git worktree는 작업 폴더·staging 충돌을 줄이지만 의미·merge 충돌을
  자동으로 제거하지 않는다.
- [OBSERVED] `RWS-0002-C02`: 현재 운영안에서 Worker는 node_modules를 복사·설치하지 않고
  무의존성 검사를 수행한다.
- [OBSERVED] `RWS-0002-C03`: Integration worktree가 의존성, 공유 Firefox profile·port와 전체
  build·typecheck·UI 검증을 소유한다.
- [OBSERVED] `RWS-0002-C04`: 완료 branch는 한꺼번에 합치지 않고 하나씩 통합·smoke-test하며,
  실패는 원 담당자에게 되돌린다.

## 실제 업무 흐름

1. clean하고 원격과 일치하는 기준점에서 worktree 사용 가능성을 확인했다.
2. worktree마다 Node.js 자체를 새로 설치하는 것과 node_modules를 별도 설치하는 것을
   구분했다.
3. 사용자는 worktree가 논리적 merge conflict를 막는다는 해석을 제기했고, Main이
   파일·staging 격리와 의미 충돌을 분리해 정정했다.
4. 이후 단계는 실행 기록이 아니라 합의된 운영안이다. Worker 범위를 코드 수정, diff와
   dependency-free 문법·셸·JSON 검사로 좁히기로 했다.
5. 완료 branch는 Integration worktree에 하나씩 병합하고 매번 smoke test하기로 했다.
6. 실패하면 다음 branch를 합치지 않고 해당 Worker에게 범위와 증거를 돌려주기로 했다.
7. Main 에이전트와 `main` branch를 구분하고, 검증된 결과만 최종 branch와 원격에
   반영하는 책임 모델로 합의했다.

## 결정·실패·교정

- “worktree면 논리 충돌이 사라진다”는 가정은 철회됐다.
- 각 Worker에서 build할 수 있다는 일반 가능성과, 공유 Firefox 자원 때문에 한 곳에서
  통합 검증한다는 현재 운영 정책을 분리했다.
- `Main` 역할과 Git `main` branch를 같은 개념처럼 쓰던 표현을 교정했다.
- 모든 병렬 작업 완료 뒤 일괄 merge하는 대신 완료 순서대로 통합·검증한다.

## 증거 경계

| 주장 | 당시 증거 | 이 사례가 주장하지 않는 것 |
|---|---|---|
| 병렬 작업 시작 가능 | clean 기준점·원격 일치·기존 worktree 수 확인 | 실제 병렬 Worker 실행 성공 |
| 공유 자원 충돌 위험 | 단일 profile·고정 port·공용 파일 구조 관찰 | 충돌을 실제 재현함 |
| 운영모델 합의 | 사용자와 Main의 반복 교정·확인 | 자동 scheduler·integration queue 구현 |
| 무의존성 검사 | 수행 가능한 검사 종류를 정의 | 전체 build·Firefox 기능 통과 |

## EG-Desk 목표 시나리오

```text
integration 기능: 깨끗한 기준점과 공유 runtime 확인
  -> Task별 파일·생성물·외부 자원 owner 배정
  -> Worker worktree 생성
  -> Worker: bounded edit + dependency-free checks + commit + risk report
  -> Integration queue: 완료 branch 하나 선택
  -> merge + build/typecheck + Firefox smoke
     ├─ pass: 다음 branch
     └─ fail: 원 Worker에게 evidence와 함께 반환
  -> 전체 검증된 revision만 main/remote 후보
```

Canvas의 supervision projection 후보에는 branch보다 업무 owner, 파일 write set,
shared-runtime lock, 검사 수준, 실패 반환과 현재 integration revision을 중심으로 보여준다.

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 관찰된 문제 | 여러 Agent의 파일·runtime·검증 책임이 섞이면 충돌과 중복 검증이 생김 |
| 후보 기법 | manager-worker + filesystem context isolation + sequential integration |
| 적용 trigger | 서로 독립적인 write set이 둘 이상이고 공용 runtime은 하나일 때 |
| 기대 효과 | 수정·staging 격리, 병렬 작성, 실패 책임과 재시도 범위 명확화 |
| 비용·위험 | branch·handoff·merge 비용; 같은 hotspot을 나누면 의미 충돌 증가 |
| acceptance evidence | disjoint write manifest, worker check 결과, merge별 smoke, 최종 revision |
| 증거 상태 | 대화에서 운영안으로 합의됐지만 이 턴 범위의 실제 Worker 실행은 없음 |

파일 write set이 작고 긴밀히 결합됐거나 공용 핵심 파일 하나를 모두 건드려야 한다면
추가 Worker는 비추천이다. 이 경우 한 writer가 수정하고 독립 read-only critic이 frozen
revision을 검토하는 편이 안전하다.

## Candidate product implications

- supervision capability가 채택된다면 `workOwner`, `write set`, `runtime lock`,
  `integration order`, `test level`을 구분해 표시해야 한다.
- Worker의 `완료`와 Integration의 `검증 완료`는 별도 상태다.
- worktree를 충돌 해결 기능으로 표현하지 않아야 한다.
- shared Firefox profile·port와 generated hotspot에는 단일 owner 또는 lock이 필요하다.
- 실패한 branch만 되돌리고 독립적으로 검증된 결과는 보존해야 한다.

## 정본 연결 후보

- [Atlas AI-06](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-06)
- [Contract §9 dependency orchestration](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-dependency-orchestration)
- [Contract §11 parallel Agents](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-parallel-agents)
- [HUM-ORCH-001](../../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001)
- [HUM-CODE-001](../../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-code-001)

## 열린 질문

- 자동 작업 분할은 파일 의존성과 제품 의미 충돌을 어떻게 함께 예측하는가?
- shared runtime lock의 획득·대기·해제·실패 UI는 무엇인가?
- Worker가 수행할 최소 무의존성 검사와 Integration 필수 검사를 어떻게 매핑하는가?
- merge 실패·smoke 실패 뒤 rollback과 원 담당자 재개는 어떤 revision을 사용해야 하는가?
- 여러 worktree가 같은 원격 DB·외부 시스템을 수정할 때 쓰기 권한을 어떻게 직렬화하는가?

## Privacy

로컬 절대경로, profile·port 값, 원격 URL과 개별 생성파일 이름은 사례에 복제하지 않았다.
Worker에게는 해당 업무에 필요한 write set과 검사 정보만 전달하고, 다른 작업의 문서·계정·
runtime 상태를 기본 context로 주입하지 않는다.
