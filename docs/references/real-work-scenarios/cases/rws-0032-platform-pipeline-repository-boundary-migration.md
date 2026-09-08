<a id="rws-0032"></a>
# RWS-0032 — Platform·Pipeline repository 경계 이관

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-08-19`
- **business_owner**: Grammar-ON 제품 운영
- **source_owner**: 저장소 구조·build boundary·Git 당시 evidence
- **action_authority**: Git 구조변경·push는 승인, Production 배포 권한·완료는 없음

## 요약

사용자 runtime 경로를 고정한 채 Platform 운영도구와 로컬 Pipeline 도구의 repository
소유 경계를 이동했다. 선택된 build-boundary·경로검사와 commit·push는 확인됐지만 기존
syntax failure와 잔여 자산 혼합이 남았고 provider가 Production 배포를 차단했다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0032-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `01a0152c-b8ad-7ab1-ae0a-5f764d93ed9d`, turns 19–24, 27–30, 38–46 | 2026-08-19 | `RWS-0032-C01`–`RWS-0032-C06` | `RESOLVED` |

### Claims

- [OBSERVED] `RWS-0032-C01`: runtime·콘텐츠 생산도구·운영 산출물이 한 저장소 입력면에 혼재했다.
- [VERIFIED-AS-OF] `RWS-0032-C02`: runtime 경로 고정, 외부 구조만 변경, 로직·DB·배포 미실행이 범위로 정해졌다.
- [VERIFIED-AS-OF] `RWS-0032-C03`: Platform과 로컬 Pipeline 도구가 별도 소유영역으로 이동했다.
- [VERIFIED-AS-OF] `RWS-0032-C04`: 선택된 build-boundary·경로검사가 통과하고 변경이 commit·push됐다.
- [OBSERVED] `RWS-0032-C05`: 기존 syntax failure와 공개 자산·설정·데이터의 잔여 혼합이 남았다.
- [UNKNOWN] `RWS-0032-C06`: Production 배포·서비스 연속성과 현재 repository 구조는 확인되지 않았다.

## 실제 업무 흐름

1. runtime·Platform·Pipeline과 배포 경계를 inventory했다.
2. 내부 로직 변경까지 포함하던 계획을 구조 이관으로 축소했다.
3. 사용자 runtime 경로를 고정했다.
4. 명백한 Platform·Pipeline 파일과 참조를 단계적으로 이동했다.
5. 제한된 build-boundary·경로검사 후 commit·push했다.
6. 기존 syntax failure·잔여 혼합과 Production 차단을 미완료로 남겼다.

## 증거 경계

| 확인됨 | 확인되지 않음 |
|---|---|
| repository 구조 이관 | Production 배포·가용성 |
| 제한된 검사·commit·push | 전체 syntax clean |
| runtime 경로 고정 계획 | 현재 repository·서비스 연속성 |

## EG-Desk 목표 시나리오

```text
runtime/deploy boundary inventory → non-goal·fixed path 동결
→ ownership별 move plan → bounded rename·reference update
→ selected checks·commit·push → residual failures·deployment UNKNOWN 표시
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 후보 기법 | ownership mapper + disjoint move workers + single integrator |
| trigger | 실행 중 서비스 저장소의 대규모 구조 경계를 바꿀 때 |
| 위험 | 구조 이동을 Production 안전으로 과장 |
| acceptance | move manifest, fixed paths, bounded checks, Git revision |

## Candidate product implications

- repository migration과 service deployment를 별도 상태로 둔다.
- 이동 전 non-goal·fixed runtime path·residual failure를 동결한다.
- 기존 실패와 새 회귀를 구분해 보여준다.

## 정본 연결 후보

- [Atlas CODE-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-code-01)
- [Contract parallel Agents](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-parallel-agents)
- [Contract failure boundaries](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries)

## 열린 질문

- 기존 failure와 migration regression을 어떻게 분리하는가?
- fixed runtime path가 실제 배포에서 유지됐는지 누가 검증하는가?
- 잔여 혼합 자산의 후속 migration owner는 누구인가?

## Privacy

절대경로, 기기명, 배포 계정·프로젝트와 내부 파일 전문은 복제하지 않았다. 구조·검사·
Git·미완료 상태만 기록했다.
