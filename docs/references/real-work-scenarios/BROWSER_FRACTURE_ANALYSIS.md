# Browser 자동화 단절 횡단 분석

- **analysis_status**: `EVIDENCE-SYNTHESIS`
- **as_of**: `2026-08-31`
- **source_scope**: 여러 프로젝트의 실제 Browser·portal·rich-editor 작업 8건
- **implementation_status**: `PROPOSED-REQUIREMENTS / NOT-IMPLEMENTED-EVIDENCE`

이 문서는 Browser 작업이 “중간에 끊겼다”는 결과만 모으지 않는다. 실제 tool-call
흐름에서 마지막으로 확인된 정상 상태와 최초 단절을 찾고, 원인을 증거가 닿는 계층까지만
분류한다. 사이트별 임시 우회가 아니라 EG-Desk가 재사용할 Browser action 계약을 찾는
것이 목적이다.

## 분석 단위

```text
observe
  -> locate
  -> action
  -> navigation / popup / upload / auth
  -> wait
  -> reobserve
```

각 사례는 다음을 분리했다.

- 사용자 의도
- action 전 마지막 정상 상태
- 실제 tool-call sequence
- 최초 break symptom
- evidence-backed fault layer
- retry·복구와 tool-event 비용
- 관찰된 원인과 추론한 원인
- 기존 자동화가 더 잘할 수 있었던 부분
- EG-Desk 대안과 여전히 풀리지 않는 경계

## SourceRef 범위

| 사례 | permission-safe SourceRef | 분석 대상 |
|---|---|---|
| BF-01 | `019e3d77-e828-7061-a3b4-0ae1ab6b14d8`, T122–124 | 잘못된 Firefox instance·stale transport |
| BF-02 | 같은 thread, T124 | page renderer와 privileged shell renderer 혼동 |
| BF-03 | `019e8589-a380-7223-8012-981f495b37b4`, T18–24·T36–44 | Sheets row semantics·clipboard·focus·undo |
| BF-04 | `019fc67b-d05a-7351-a960-2d56abdc5dd7`, T131·T137–139 | 행정 form의 재계산·저장 의미 |
| BF-05 | `019feb5b-09ae-7413-bb9e-ecba168c2ce0`, T18·T22–23·T30–31 | 권한·native picker·형식 거부·receipt |
| BF-06 | `019e8589-a380-7223-8012-981f495b37b4`, T63·T72·T115·T118 | image-based secure keyboard |
| BF-07 | `01a0127f-7cc4-7033-810a-92fc3e00a3e6`, T19–20·T35–39 | 잘못된 profile·extension permission restart |
| BF-08 | `01a00ef1-78f4-7703-930c-58c7feeddc64`, T10·T18–19·T25·T27·T31 | Browser·DB·Git·배포 revision 불일치 |

SourceRef는 개인 form 값, 계정 식별자, screenshot, credential과 첨부 원문을 포함하지
않는다. 본 분석의 tool-event 수는 해당 역사적 turn의 복구 비용을 보여 주는 지표이며
동일 작업의 보편적 실행시간을 뜻하지 않는다.

## Fracture matrix

| ID | 마지막 정상 상태 | 최초 단절 | fault layer | 복구·비용 | EG-Desk 개선 후보 |
|---|---|---|---|---|---|
| BF-01 | 의도한 Firefox process와 control port가 살아 있음 | app tool transport는 이전 launch server를 계속 가리키고 첫 호출에 종료 | wrapper·profile·generation·transport | stale instance 종료, 올바른 profile 재실행, fresh direct client; 약 321 tool event/19분의 진단 turn | profile·process·startup args·generation을 session identity에 고정하고 stale handle 무효화 |
| BF-02 | 일반 페이지 자동화 자체는 동작 | EG-Desk shell을 page context로 열자 viewport가 `0×0` | renderer·surface mismatch | privileged browser-chrome surface로 재라우팅 | page와 shell action namespace 분리, renderer identity·state delta 필수 |
| BF-03 | Sheet가 online이고 기존 top anchor가 보존됨 | 보호/필터 row를 data row로 오인하고 paste·undo가 단일 transaction처럼 작동하지 않음 | virtualized UI·focus·wrapper·coordinate | OS clipboard+Sheet menu와 cleanup packet; 관련 T18–21의 성공·실패 호출을 합쳐 145 tool event | protected-row map·document revision 동결, semantic insert-and-paste, postflight readback |
| BF-04 | form field가 화면에 채워짐 | 재계산이 값을 초기화하고 save 뒤 persistence 증거 없이 이동해 form 유실 | site DOM/JS compound behavior·postcondition 누락 | 전체 재입력, update mode·별도 submit 확인; 선택 turn 133 tool event | field manifest snapshot, recalculate diff, save-and-verify, saved/submitted 분리 |
| BF-05 | form이 채워졌지만 upload capability 미확인 | local-file permission 차단, session 유실, native picker 진입, 준비 파일 형식 거부 | wrapper·auth·OS native UI·uploader JS·receipt | 재로그인·재입력·변환·업로드·재검증; 관련 turn 합계 480 tool event | upload preflight, choose-convert-upload-verify, picker binding, form checkpoint |
| BF-06 | 올바른 인증서가 선택되고 secret field가 비어 있음 | DOM 입력이 차단되고 부분 masked 값만 입력, image keyboard 일부가 viewport 밖 | security JS·auth·pixel renderer | 현재 frame 좌표 재산출·bounded pixel action | 기본 user handoff, secret isolation, frame revision·focus lease, lockout stop |
| BF-07 | form scope는 선택됐고 attachment·submit 전 | 잘못된 profile, permission 변경이 live tab에 반영되지 않음 | profile/auth·extension capability·stale tab | restart·reconnect 뒤 upload 성공; 약 99 tool event/40분 | profile capability preflight, safe form checkpoint, restart-safe binding |
| BF-08 | 학생 dashboard와 일부 콘텐츠가 정상 | oversized query, publication·alias·branch·배포가 서로 다른 revision이라 0건 화면과 local-only 개선이 혼재 | data query·environment/revision·deployment authority | batching·publication·mapping 수정과 local audit; 주요 복구 turn 329 tool event | profile·URL·app SHA·DB state·deployment state를 observation envelope에 고정 |

## 확인된 fault family

| family | 실제 관찰 |
|---|---|
| Surface·renderer identity | page와 privileged shell, native picker와 DOM uploader, virtual grid와 export row가 다름 |
| Profile·account·session identity | 잘못된 browser profile, stale extension context, session expiry, generated safe profile |
| Site DOM/JS semantics | 재계산이 form을 초기화, save와 submit 분리, custom allowlist, secure keyboard |
| Focus·navigation | shortcut paste 실패, menu·tab focus 변화, stale tab handle, undo continuity 유실 |
| Automation wrapper | closed transport, file permission, binding 변수·kernel reset, capability 노출 실패 |
| Stale revision·environment | local 결과를 production으로 확대, unmerged branch, DB publication mismatch |
| Timeout·session loss | logout, browser restart, stale handle, callback·new-tab 대기 실패 |
| External receipt | saved·submitted·processing·completed·publicly reflected가 각각 다른 상태 |
| Recovery amplification | 작은 precondition 누락 하나가 수십·수백 번의 재호출과 전체 재입력으로 확대 |

## P0 제안

### 1. Surface identity envelope

모든 관찰과 action에 다음 identity를 결합한다.

```text
browser instance
security principal / profile
tab + frame
renderer / surface kind
URL + site session
document or form generation
app / Git / deployment revision
snapshot or live
last observation revision
```

action 시점에 envelope가 다르면 mutation 전에 fail-closed해야 한다.

### 2. Single-writer UI lease

읽기·자료 준비·검산 Agent는 병렬화할 수 있지만 live Browser surface를 변경하는 actor는
한 명만 둔다. lease에는 owner, surface generation, 시작·만료·handoff 상태가 필요하다.
같은 tab·focus·undo stack·secure modal을 여러 Agent가 동시에 조작하면 안 된다.

### 3. Semantic·atomic compound action

반복적으로 깨진 행동을 의미 작업으로 묶는다.

```text
precondition snapshot
semantic locator
bounded action steps
expected event
postcondition readback
cleanup or rollback packet
```

예시는 `insertRowsAndPaste`, `calculateWithDiff`, `saveAndVerify`,
`attachAndReadback`이다. 인증·native picker·기관의 비동기 처리까지 하나의 원자로
가장하지 않는다.

### 4. Event-driven wait와 mandatory reobserve

고정 sleep이나 클릭 성공만으로 완료하지 않는다. navigation, popup/new tab, upload list,
save revision, receipt row, auth completion, session expiration 등의 event 또는 semantic
state transition을 기다린 뒤 반드시 재관찰한다.

### 5. External-effect state machine

```text
Draft
→ Validated
→ Saved
→ Approval pending
→ Submitted
→ Provider accepted / receipt captured
→ Processing
→ Completed / Rejected
→ Paid / Delivered / Publicly reflected
→ Current-state verified
```

뒤 상태의 독립 증거 없이 앞 단계에서 승격하지 않는다.

### 6. Explicit user handoff

secret, OTP, 인증서·보안키보드, 결제, irreversible submit, CAPTCHA·hardware/mobile approval와
불명확한 secure UI는 사용자에게 넘긴다. handoff는 대상 행동, 영향, 현재 snapshot,
사용자가 해야 할 한 동작과 정확한 resume 조건을 보여준다.

## P1 제안

- Snapshot/Live binding과 revision badge
- form·editor의 task-local checkpoint와 navigation guard
- upload permission·accepted format·native picker ownership preflight
- 의미적 locator가 없을 때만 사용하는 Surface-local 좌표와 frame revision
- save·receipt·new-tab·auth event adapter
- rich editor의 value·style·selection·undo revision 보존
- frozen evidence envelope를 읽는 독립 read-only judge

## P2 제안

- semantic checkpoint를 보존하는 trace recorder와 resumable Reader
- 반복 빈도가 높고 version detection·fail-closed test가 있는 사이트별 adapter
- retry budget, lockout 위험과 recovery cost를 표시하는 automation health

## Multi-agent 적용 경계

| 상황 | 권장 | 비추천 |
|---|---|---|
| 대량 자료·여러 독립 source | 격리된 read-only Mapper와 단일 reducer | 동일 source를 여러 Agent가 각자 정본화 |
| 민감 form 규칙·계산 | redacted manifest를 보는 auditor | 개인 값을 여러 Agent context에 복제 |
| live Browser mutation | 단일 executor + 필요 시 read-only judge | 같은 tab을 여러 Agent가 클릭·입력 |
| profile·transport stale | fresh client/context escape | 여러 Agent가 동시에 Browser 재실행 |
| upload artifact 준비 | 별도 artifact specialist 뒤 한 UI owner | form 작성 중 parallel conversion·upload |
| secure auth | 사용자 handoff 또는 단일 isolated actor | role-play, geometry worker 다수, secret 공유 |

Role simulation은 사용자 관점 질문과 반례를 만들 수 있지만 실제 사용자·기관·도메인
전문가의 증거나 승인 권한이 아니다.

## 수용 기준 후보

1. profile·surface·revision mismatch action은 mutation 전에 거부된다.
2. 모든 Browser mutation은 precondition과 postcondition을 같은 action record에 남긴다.
3. fixed delay 없이 기대 event 또는 state transition을 식별한다.
4. live UI writer가 하나임을 lease record로 증명한다.
5. form navigation 전 saved checkpoint 또는 명시적 유실 경고가 있다.
6. upload 전 permission·형식·artifact identity를 검사한다.
7. saved·submitted·processing·completed를 각각 독립 evidence로 전이한다.
8. retry 뒤 recovery cost와 폐기된 stale observation을 추적한다.
9. 민감값은 Snapshot·Agent context·casebook에 저장되지 않는다.
10. user handoff 뒤 같은 task·surface revision으로 재개하거나 mismatch를 명시한다.

## 한계

이 분석은 모든 Browser를 완전 자동화할 수 있다는 근거가 아니다. randomized secure
keyboard, CAPTCHA, hardware·mobile approval, 접근할 수 없는 native dialog, 사이트 JS
변경, server-side validation, 권한 부재와 지연된 외부 receipt는 사람 개입이 필요하거나
끝까지 검증 불가능할 수 있다.
