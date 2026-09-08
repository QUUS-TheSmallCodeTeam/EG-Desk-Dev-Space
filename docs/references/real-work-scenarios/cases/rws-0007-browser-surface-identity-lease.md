<a id="rws-0007"></a>
# RWS-0007 — Browser Surface·profile·focus·revision identity 단절

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-08-31`
- **business_owner**: 여러 Browser 기반 실제 workflow
- **source_owner**: 각 Codex thread와 당시 Browser/tool evidence
- **action_authority**: live Browser surface는 단일 executor, 민감·비가역 행동은 사용자 승인

## 요약

Browser 자동화의 반복 실패는 locator 하나가 틀린 문제만이 아니었다. 다른 Firefox
profile, page와 privileged shell renderer 혼동, 다른 tab·session, 사용자 pan·focus 변화,
virtual grid·native picker·secure keyboard와 오래된 observation revision이 action 사이에
섞였다. 같은 URL이나 화면 제목만으로는 action identity가 충분하지 않다는 점은
확인됐고, 모든 관찰과 mutation에 surface envelope와 single-writer lease를 결합하는
것은 이 사례에서 도출한 제품 제안이다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0007-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `019f8d42-4886-7041-8421-c5e343d465e0`, turns 71–79 | 2026-08 | `RWS-0007-C01`–`RWS-0007-C05` | `RESOLVED` |
| `RWS-0007-SR-02` | Codex user thread | `LOCAL-RESTRICTED` | `019e3d77-e828-7061-a3b4-0ae1ab6b14d8`, turns 122–124 | 2026-05 | `RWS-0007-C01`, `RWS-0007-C02`, `RWS-0007-C06` | `RESOLVED` |
| `RWS-0007-SR-03` | Codex user thread | `LOCAL-RESTRICTED` | `019e8589-a380-7223-8012-981f495b37b4`, turns 18–24·36–44·63·72 | 2026-06 | `RWS-0007-C03`–`RWS-0007-C05` | `RESOLVED` |
| `RWS-0007-SR-04` | Codex user thread | `LOCAL-RESTRICTED` | `019fc67b-d05a-7351-a960-2d56abdc5dd7`, turns 131·137–139 | 2026-08 | `RWS-0007-C03`–`RWS-0007-C05` | `RESOLVED` |
| `RWS-0007-SR-05` | Codex user thread | `LOCAL-RESTRICTED` | `019feb5b-09ae-7413-bb9e-ecba168c2ce0`, turns 18·22–23·30–31 | 2026-08 | `RWS-0007-C03`–`RWS-0007-C05` | `RESOLVED` |
| `RWS-0007-SR-06` | Codex user thread | `LOCAL-RESTRICTED` | `01a0127f-7cc4-7033-810a-92fc3e00a3e6`, turns 19–20·35–39 | 2026-08 | `RWS-0007-C01`, `RWS-0007-C04`–`RWS-0007-C06` | `RESOLVED` |

### Claims

- [VERIFIED-AS-OF] `RWS-0007-C01`: profile·account·tab·renderer가 다른 action은 같은 URL이어도 같은
  실행면이 아니다.
- [PROPOSED] `RWS-0007-C02`: page renderer와 Firefox privileged shell renderer는 별도 capability와
  locator namespace를 가져야 한다.
- [INFERRED] `RWS-0007-C03`: Desk pan은 Surface-local target을 바꾸지 않지만 content·viewport·modal
  generation 변화는 observation을 stale하게 만든다.
- [INFERRED] `RWS-0007-C04`: 같은 focus·undo·secure modal을 여러 actor가 조작하면 action sequence와
  복구 증거가 갈라진다.
- [INFERRED] `RWS-0007-C05`: semantic control이 없을 때 좌표는 현재 frame revision에만 유효하다.
- [PROPOSED] `RWS-0007-C06`: profile·extension·config 변경 뒤 기존 automation handle은 명시적으로
  무효화·재결합해야 한다.

## 실제 업무 흐름

1. EG-Desk overlay가 없는 생성 profile에 자동화가 연결돼 잘못된 Firefox instance를
   조작하려 했다.
2. profile·실행 인자를 고친 뒤에도 앱 tool transport가 이전 server handle을 가리켜 첫
   호출에 닫혔다. fresh direct client에서 실제 profile·overlay를 다시 확인했다.
3. 일반 page context로 EG-Desk shell을 검사하자 viewport가 `0×0`이었고 privileged
   browser-chrome surface로 전환한 뒤에만 실제 dock state change를 확인했다.
4. Canvas 밖 Browser를 조작할 때 Desk camera와 Surface 좌표를 분리했지만, 같은 tab의
   content나 responsive viewport가 바뀌면 재관찰해야 함을 정리했다.
5. Sheets에서는 protected row와 data row, export index와 live grid row를 혼동했고,
   shortcut·menu·focus가 다른 paste 결과를 만들었다.
6. portal의 popup·custom uploader·native picker가 DOM 밖에서 focus와 session을 바꿨다.
7. secure image keyboard는 semantic input을 막았고 현재 frame에서 좌표를 다시 산출해야
   했다. 비밀값은 사용자 handoff가 더 안전한 경계였다.
8. profile permission 변경이 live tab에 반영되지 않아 restart·reconnect 뒤에야 upload가
   가능해진 사례도 있었다.

## 결정·실패·교정

- `offscreen = snapshot/unload`라는 성급한 가정을 철회했다.
- 웹사이트 HTML을 임의 변경해 focus 문제를 해결하는 안을 기본 경로로 쓰지 않았다.
- semantic action을 우선하고 accessibility·Surface-local visual input·user handoff 순으로
  fallback한다.
- absolute screen coordinate 대신 Surface-local target과 observation revision을 사용한다.
- profile/config generation이 바뀌면 기존 tool handle을 계속 쓰지 않는다.
- secure input은 자동화 가능성을 과장하지 않고 기본 user handoff를 허용한다.

## 증거 경계

| 주장 | 역사적 증거 | 한계 |
|---|---|---|
| 잘못된 profile·stale transport | process·profile·overlay·direct-client 대조 | 최초 server exit 원인 전체는 미격리 |
| page/shell renderer 분리 | `0×0` page와 privileged action state delta | Firefox revision별 API 안정성 미검증 |
| Sheets focus·row fracture | wrong row, paste·undo·menu readback | undo 단절의 단일 원인은 추론 포함 |
| portal popup·picker | permission·dialog·native picker·upload list 관찰 | 모든 portal에 같은 원인 적용 불가 |
| secure keyboard | semantic 입력 실패, partial masked 입력과 same-frame pixel 시도 | 전체 인증 성공·randomized layout·lockout 해결은 확인되지 않음 |

## Browser tool-call fracture

| 흐름 | 마지막 정상 상태 | break | fault layer | recovery |
|---|---|---|---|---|
| process/config observe → connect → overlay probe | Firefox process·port alive | tool transport는 이전 server handle에 연결 | wrapper·profile·generation | stale instance 종료, fresh client로 rebind |
| page observe → click/screenshot → shell inspect | 일반 page 자동화 가능 | shell viewport `0×0` | renderer mismatch | privileged surface routing |
| Sheet observe → row locate → insert/paste → save/readback | top anchor intact | hidden/protected row·focus·undo drift | virtual grid·focus·coordinates | semantic packet, menu paste, cleanup manifest |
| form/popup → native picker → reobserve | form populated | session·permission·format·picker context 전환 | auth·OS UI·uploader JS | checkpoint, restart-safe binding, upload preflight |
| secure input → partial masked value → pixel retry | correct auth item selected | DOM input interception·image keyboard | security JS·renderer | user handoff 또는 same-frame bounded input |

## EG-Desk 목표 시나리오

```text
System: target resource와 surface capability 분류
  -> observation envelope 생성
  -> live-surface lease 획득
  -> semantic locator와 precondition 검사
  -> action
  -> expected event wait
  -> mandatory reobserve
  -> state delta·receipt·cleanup 기록
  -> lease 해제 또는 명시적 handoff
```

Envelope에는 Browser instance, security principal/profile, tab/frame, renderer, URL·session,
document/form generation, app revision, Snapshot/Live와 last observation revision을 포함한다.

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 관찰된 문제 | 자료 준비·규칙 검토·live UI mutation이 한 context에 섞임 |
| 후보 기법 | read-only Reader/mapper + single UI executor + frozen postcondition judge |
| trigger | 독립 자료 준비가 크거나 action 뒤 material readback이 필요할 때 |
| 기대 효과 | 민감값 최소화, locator 계획과 focus-sensitive mutation 분리, 독립 receipt 확인 |
| 비용·위험 | stale plan, handoff latency, profile·session 정보 과공유, judge의 권한 확대 |
| acceptance | one active lease, exact envelope revision, redacted packet, postcondition readback |
| 증거 상태 | fresh client escape는 실제 사용; 완전한 lease/runtime 계약은 제안 |

동일 authenticated tab, secure modal, undo stack을 여러 Agent가 동시에 조작하는 것은
비추천이다. Role-playing 사용자는 focus·사용성 반례를 만들 수 있지만 실제 동시 사용자
행동이나 기관 권한의 증거가 아니다.

## Candidate product implications

- Browser action마다 surface identity envelope와 observation revision을 표시한다.
- live Browser writer lease를 한 actor에게만 부여한다.
- shell/page/native action namespace와 capability preflight를 분리한다.
- semantic locator 실패 이유를 count·visibility·scope·generation으로 구조화한다.
- 좌표 fallback은 frame·viewport·scale·modal generation 변화 시 만료한다.
- config·profile 변경 뒤 stale handles를 자동 폐기하고 resume packet을 만든다.
- secure auth와 irreversible action에는 명시적 user handoff를 둔다.

## 정본 연결 후보

- [Atlas V-02](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-v-02)
- [Atlas TOOL-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-tool-01)
- [Atlas BROWSER-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-browser-01)
- [Contract §3 identity](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-resource-identity)
- [Contract §4.1 Snapshot/Live](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-observation-fidelity)
- [HUM-SURFACE-001](../../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-surface-001)

## 열린 질문

- Browser live surface writer lease의 정확한 UI와 timeout·handoff 의미는 무엇인가?
- Firefox shell/page/native surface의 capability negotiation을 어떤 protocol로 구현하는가?
- user focus와 Agent logical focus를 어느 범위까지 독립시킬 수 있는가?
- stale action의 retry budget과 동일 외부효과 중복 방지 key는 무엇인가?
- secure keyboard·CAPTCHA·hardware approval의 자동 중지 기준은 무엇인가?

## Privacy

개인 form 값, 계정·profile 내부 식별자, 비밀번호·masked 길이, 금융·고용·세무 정보,
screenshot과 로컬 경로는 복제하지 않았다. Reader와 judge는 redacted metadata만 받고 live
Browser session·secret·submit 권한은 단일 executor 또는 실제 사용자에게 남긴다.
