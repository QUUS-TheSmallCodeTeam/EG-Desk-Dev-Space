<a id="rws-0027"></a>
# RWS-0027 — Taehwa ontology 이관의 의미 보존 재감사

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-08-10~13`
- **business_owner**: Taehwatrans ontology 운영
- **source_owner**: archived ontology migration session과 당시 artifact
- **action_authority**: 구조 이관은 통합 owner, 의미 판정은 업무 owner와 독립 auditor

## 요약

구형 ontology의 파일 hash·이관표·링크 검사를 통과한 뒤 의미 보존까지 완료했다고
과장했다. 원문 대조에서 판단조건·안전규칙 결손을 찾고 배치 차이와 실제 의미 누락을
분리해 재감사했다. 현재 Drive revision과 제한계정 가시성은 재확인되지 않았다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0027-SR-01` | archived Codex user thread | `ARCHIVED-SESSION-RESTRICTED` | `019fd492-0a36-7df0-aa3e-fbdbddaa8561`, turns 78–90, 93–117, 125, 128–132 | 2026-08 | `RWS-0027-C01`–`RWS-0027-C06` | `RESOLVED` |

### Claims

- [VERIFIED-AS-OF] `RWS-0027-C01`: 이관 대상 원본 146개가 hash와 함께 보존됐다.
- [OBSERVED] `RWS-0027-C02`: 구조·hash·링크 PASS가 의미 보존 완료로 과장됐다.
- [VERIFIED-AS-OF] `RWS-0027-C03`: 활성·통합·보관 상태와 의미 보존 여부가 별도 판정됐다.
- [VERIFIED-AS-OF] `RWS-0027-C04`: semantic 재감사가 구조검사에서 놓친 결손을 찾아 수정했다.
- [VERIFIED-AS-OF] `RWS-0027-C05`: ontology 관리·시험 기록이 실제 부서 업무 이력과 분리됐다.
- [UNKNOWN] `RWS-0027-C06`: 제한계정 가시성·Windows Hook·현재 Drive revision은 확인되지 않았다.

## 실제 업무 흐름

1. 원본 manifest·hash와 백업을 만들었다.
2. 새 구조로 파일을 이동하고 링크·경로 검사를 통과했다.
3. 의미 보존까지 완료됐다고 보고했다.
4. 원문 대조에서 판단조건·안전규칙 누락을 발견했다.
5. 배치 차이·의도적 폐기와 실제 의미 결손을 재분류했다.
6. 결손 보충과 업무 이력 provenance를 검증했다.

## 증거 경계

| 확인됨 | 확인되지 않음 |
|---|---|
| 원본 hash·이관·링크 | 현재 Drive revision |
| 당시 semantic diff·수정 | 제한계정 실제 가시성 |
| 업무 이력 분리 | Windows Hook 실행 |

## EG-Desk 목표 시나리오

```text
source manifest·hash → structural migration → link/path audit
→ semantic unit diff → active/archive/drop disposition
→ 업무 owner readback → provenance·current-access 별도 확인
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 후보 기법 | structural mapper + source-isolated semantic auditor |
| trigger | ontology·casebook을 새 schema로 이동할 때 |
| 위험 | 파일 수·hash PASS를 의미 보존으로 확대 |
| acceptance | source unit coverage, semantic finding disposition |

## Candidate product implications

- structural migration과 semantic migration을 별도 gate로 둔다.
- active·archive·dropped와 missing을 같은 상태로 취급하지 않는다.
- 시스템 관리작업과 실제 업무 이력의 provenance를 분리한다.

## 정본 연결 후보

- [Atlas ONT-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ont-01)
- [Contract storage](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-storage-export)
- [Contract failure boundaries](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries)

## 열린 질문

- semantic unit coverage를 어떤 manifest로 증명하는가?
- intentional drop과 accidental omission을 누가 판정하는가?
- archived session SourceRef의 장기 접근권한을 어떻게 관리하는가?

## Privacy

원문 업무자료, 계정·직원·고객정보와 Drive 경로는 복제하지 않았다. archived access class,
구조·의미 finding과 완료 경계만 기록했다.
