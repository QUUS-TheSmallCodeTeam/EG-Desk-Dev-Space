<a id="rws-0009"></a>
# RWS-0009 — Read-only scope lock과 schema·security 증거 경계

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-08-18`
- **business_owner**: Grammar-ON 제품 운영
- **source_owner**: 원격 schema metadata·migration ledger·코드 참조
- **action_authority**: 사용자가 schema-only read-only 감사를 승인; 변경·삭제 권한은 미부여

## 요약

운영 DB의 dead table 후보를 검토하면서 앱·배포·제품 품질 조사로 범위가 넓어지려는 것을
사용자가 schema-only로 제한했다. 0행 테이블을 바로 삭제 대상으로 보지 않고 migration,
FK, code reference와 subsystem 상태를 대조했다. 오히려 광범위 grant, 관리자급 함수와
끊긴 FK가 더 높은 위험 후보로 나타났다. Read-only는 외부 write를 막지만 민감 schema와
행 접근의 privacy·권위·현재성 위험까지 제거하지는 않는다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0009-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `01a0152b-af0b-7d20-b33b-9038dfb06c98`, turn 1 | 2026-08-18 | `RWS-0009-C01`–`RWS-0009-C06` | `RESOLVED` |

### Claims

- [VERIFIED-AS-OF] `RWS-0009-C01`: 사용자가 지정한 schema-only read-only 범위는 앱·배포 조사와 mutation을
  포함하지 않는다.
- [INFERRED] `RWS-0009-C02`: 0행은 dead table의 충분조건이 아니며 migration·FK·code use·운영 상태를
  함께 봐야 한다.
- [VERIFIED-AS-OF] `RWS-0009-C03`: RLS, grants, privileged function과 broken integrity는 row count와 별도
  위험축이다.
- [VERIFIED-AS-OF] `RWS-0009-C04`: query escaping·tool error는 schema 사실이나 대상 DB 실패 증거가 아니다.
- [PROPOSED] `RWS-0009-C05`: read-only Agent도 필요한 metadata 범위와 privacy ceiling을 가져야 한다.
- [PROPOSED] `RWS-0009-C06`: finding은 삭제·권한회수 결정을 자동 실행하지 않고 별도 승인으로 넘긴다.

## 실제 업무 흐름

1. 에이전트가 앱·배포까지 포함한 넓은 품질검토를 제안했다.
2. 사용자가 schema와 migration·table·RLS·grant만 보도록 범위를 축소했다.
3. 첫 원격 SQL 묶음은 escaping 문제로 실패했다.
4. 이를 DB 상태로 해석하지 않고 단일행·작은 query로 다시 실행했다.
5. table·constraint·function·grant·row count를 inventory했다.
6. 빈 테이블을 FK·migration·코드 참조와 대조해 강한 후보와 미가동 subsystem을 구분했다.
7. 익명·일반 로그인 역할에서 접근 가능한 관리자급 function과 광범위 grant를 별도 finding으로
   분리했다.
8. canonical FK와 연결이 끊긴 record를 integrity finding으로 남겼다.
9. 어느 finding도 자동 삭제·권한회수·migration으로 이어가지 않았다.

## 결정·실패·교정

- schema review를 앱·배포·제품 성능 조사로 확대하지 않았다.
- query transport 오류를 “DB가 고장남”으로 표현하지 않았다.
- empty table 분류를 자동화하지 않고 evidence matrix로 좁혔다.
- high-risk grant·function은 독립 재현과 owner 승격 전까지 후보로 유지했다.
- dirty worktree의 다른 사용자 변경을 건드리지 않았다.

## 증거 경계

| 주장 | 당시 증거 | 이 사례가 주장하지 않는 것 |
|---|---|---|
| schema inventory | 원격 metadata·migration read | 현재 production schema가 동일함 |
| dead 후보 | 0행+code/FK/migration 대조 | 안전한 삭제 가능 |
| 권한 위험 후보 | grant·function·RLS metadata | 실제 exploit·영향 규모 |
| integrity finding | constraint·NULL 연결 상태 | 자동 repair 정답 |
| read-only | mutation tool·SQL 미실행 | 민감정보 노출 위험 0 |

## EG-Desk 목표 시나리오

```text
제품 사용자: schema-only read-only scope 승인
  -> System: 대상 DB·snapshot·privacy ceiling 고정
  -> schema auditor: table/FK/index/RLS/grant/function inventory
  -> 후보 분류: empty / inactive / dead-candidate / permission-risk / integrity-risk
  -> independent high-risk critic: frozen metadata만 재현
  -> integration 기능: finding·반례·unknown 정리
  -> 사용자: 변경 여부 별도 결정
  -> mutation은 새 Task·승인·rollback plan으로 시작
```

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 관찰된 문제 | 한 auditor의 dead·security 판독 오류 가능성과 민감 schema 범위 |
| 후보 기법 | 단일 schema auditor + high-risk finding만 재현하는 read-only security critic |
| trigger | privileged function, broad grant, deletion candidate, RLS/grant 불일치 발견 시 |
| 기대 효과 | false positive 감소, remediation 우선순위 검증 |
| 비용·위험 | metadata 재조회·token, schema·역할정보 확산, 실제 행 열람 위험 |
| acceptance | target snapshot, write 0, finding별 독립 metadata·code caller 재현, owner disposition |
| 증거 상태 | fresh schema-only session은 실제 사용; 별도 security critic은 사후 제안 |

여러 auditor가 동일 table을 각자 다른 dead 기준으로 분류하면 오히려 disposition이
불안정해진다. 전체 inventory는 한 schema로 만들고 고위험 finding만 독립 재현하는 것이
적합하다. 보안전문가 role-play도 실제 penetration evidence가 아니다.

## Candidate product implications

- Run에 read/write mode, 대상 snapshot과 scope ceiling을 표시한다.
- table·function·grant·constraint finding type을 분리한다.
- zero-row와 dead status를 합치지 않는다.
- tool/query error를 domain finding과 분리한다.
- read-only result도 privacy class와 current-state freshness를 가진다.
- finding 승격과 mutation Task 사이에 owner approval·rollback·recheck가 필요하다.

## 정본 연결 후보

- [Atlas AGENT-02](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-agent-02)
- [Contract §14 Run binding](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-agent-run-binding)
- [HUM-RUN-001](../../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-run-001)

## 열린 질문

- read-only privacy ceiling과 metadata/row access 범위를 어떤 UI로 정하는가?
- 삭제 후보와 보안 finding의 독립 재현 기준은 무엇인가?
- schema snapshot이 live DB와 drift할 때 verdict를 어떻게 stale 처리하는가?
- high-risk critic에게 code caller·grant 정보를 얼마나 전달하는가?
- finding에서 migration 제안으로 승격할 owner·approval 경계는 무엇인가?

## Privacy

table·function·role·column 이름, row 값, 연결정보, 사용자·학생 정보와 로컬 경로는 복제하지
않았다. 사례에는 finding 유형과 검증 흐름만 보존하며, critic도 최소 metadata와 code
reference만 받아야 한다.
