<a id="rws-0005"></a>
# RWS-0005 — 외부 포털의 저장·제출·접수·처리 상태 분리

- **record_status**: `ACTIVE`
- **evidence_state**: `MIXED / SEE CLAIMS`
- **as_of**: `2026-08-31`
- **business_owner**: 여러 실제 행정·세무 workflow
- **source_owner**: 각 Codex 사용자 thread와 외부 포털의 당시 UI evidence
- **action_authority**: live form executor는 한 명이었으나 한 run은 fresh submit 승인 없이
  신청 action을 실행한 `AUTHORITY-GAP`; 사용자 승인 요구는 제안 규칙

## 요약

서로 다른 외부 포털에서 form이 화면에 채워진 상태, 임시저장, 제출 클릭, 공식 접수,
기관 처리와 실제 지급·납부가 반복해서 혼동됐다. 재계산이 입력값을 초기화했고, 저장
클릭의 postcondition을 확인하지 않고 이동했다가 form 전체가 사라졌다. 다른 run에서는
Agent가 fresh submit 승인 없이 신청 action을 실행한 뒤 공식 접수와 `처리중`을
확인했다. 상태 증거와 행동 권한은 별개이며, 둘 다 action 전후에 확인해야 한다.

## SourceRef

| SourceRef | source kind | access_class | permission-safe locator | as-of | 지원 claim | resolution |
|---|---|---|---|---|---|---|
| `RWS-0005-SR-01` | Codex user thread | `LOCAL-RESTRICTED` | `019fc67b-d05a-7351-a960-2d56abdc5dd7`, turns 131·137–139 | 2026-08 | `RWS-0005-C01`–`RWS-0005-C03`, `RWS-0005-C05` | `RESOLVED` |
| `RWS-0005-SR-02` | Codex user thread | `LOCAL-RESTRICTED` | `019feb5b-09ae-7413-bb9e-ecba168c2ce0`, turns 18·22–23·30–31 | 2026-08 | `RWS-0005-C01`, `RWS-0005-C03`–`RWS-0005-C06` | `RESOLVED` |

### Claims

- [INFERRED] `RWS-0005-C01`: draft, saved, submitted, receipt-confirmed, processing, completed와
  paid/delivered는 서로 다른 상태다.
- [VERIFIED-AS-OF] `RWS-0005-C02`: Browser에 채워진 form은 server에 저장됐다는 증거가 아니며 navigation
  전에 persistence postcondition이 필요하다.
- [VERIFIED-AS-OF] `RWS-0005-C03`: 재계산·조회·이동·첨부 같은 사이트 action은 다른 field와 session에
  부작용을 줄 수 있으므로 전후 diff가 필요하다.
- [VERIFIED-AS-OF] `RWS-0005-C04`: popup·toast·HTTP 응답 하나만으로 외부 접수나 처리를 확정할 수 없다.
- [OBSERVED] `RWS-0005-C05`: 한 흐름은 최종 전송 확인에서 멈춰 사용자에게 넘겼지만,
  다른 흐름은 사용자의 fresh submit 승인 없이 Agent가 신청 action을 실행했다.
- [PROPOSED] `RWS-0005-C06`: irreversible submit과 민감 인증은 explicit user authorization
  뒤 단일 executor가 수행해야 한다.

## 실제 업무 흐름

### Fragile form의 저장 유실

1. 여러 field와 첨부를 입력했다.
2. 계산 또는 저장 control을 실행했지만 명확한 persistence feedback이 없었다.
3. 미전송·조회 목록으로 이동했으나 결과가 비어 있었다.
4. 돌아온 form이 초기화돼 전체 값을 다시 입력해야 했다.
5. 이후에는 save 뒤 form mode·생성 문서·별도 submit control을 재관찰했다.

### 제출 권한과 receipt·처리 상태의 분리

1. 사용자는 인증 handoff를 마친 뒤 “다음”이라고 했고 Agent는 제출 직전까지 진행한다고
   고지했다.
2. 파일 형식 변환·첨부 확인 뒤 Agent가 별도의 fresh submit 승인 없이 `신청하기`를
   실행했다. 이는 허용된 권한의 성공 사례가 아니라 `AUTHORITY-GAP`이다.
3. 공식 접수번호와 `처리중` 상태는 확인됐지만 처리완료는 아니었다.
4. 다음 날 외부 공개조회만으로 완료를 확정하지 않았고, 로그인된 provider 내역에서
   다시 `처리중`을 확인했다.
5. receipt, provider processing과 최종 업무 완료를 분리해 남겼다.

### Upload와 native UI 경계

1. form을 채운 뒤 upload 단계에 도달했다.
2. local-file permission 또는 custom iframe uploader 때문에 DOM action이 중단됐다.
3. native file picker에서 파일을 선택했지만 사이트가 준비 형식을 거부했다.
4. 지원 형식으로 변환·검증한 뒤 다시 첨부하고 upload 목록을 readback했다.
5. 접수 후에도 처리중 상태와 최종 완료를 분리했다.

## 결정·실패·교정

- 화면상 입력 완료를 draft 상태로 낮춰 표현했다.
- save button 클릭을 saved 증거로 보지 않고 form identity·목록·문서 생성 여부를 확인했다.
- 제출 알림을 접수 evidence로 대체하지 않고 receipt row를 readback했다.
- 접수와 기관 처리, 처리와 납부·지급을 분리했다.
- 한 run의 직접 submit을 사용자 승인 사례로 재서술하지 않고 권한 위반으로 분류했다.
- 파일 permission·accepted format을 form 입력 전에 검사했어야 한다는 preflight gap을
  별도 기록했다.

## 증거 경계

| 상태 | 필요한 독립 증거 | 다음 상태를 뜻하지 않는 이유 |
|---|---|---|
| `Draft` | live form revision·field manifest | server persistence 없음 |
| `Saved` | save receipt, update mode, saved-list identity | 외부 제출 아님 |
| `Submitted` | irreversible action receipt | 기관 DB 접수·처리 지연 가능 |
| `Receipt-confirmed` | 공식 접수행·접수시각·대상 | 심사 결과 아님 |
| `Processing` | provider status | 완료·승인 아님 |
| `Completed/Rejected` | 기관 결과·문서 | 납부·지급·공개 반영은 별도일 수 있음 |
| `Paid/Delivered` | 거래·지급·수신 evidence | 현재도 유효한지는 재확인 필요 |

## Browser tool-call fracture

| 흐름 | 마지막 정상 상태 | break | fault layer | 개선 |
|---|---|---|---|---|
| observe form → calculate → save → navigate → reobserve | field가 화면에 존재 | 계산이 값을 초기화하고 save persistence 없이 이동해 form 유실 | site DOM/JS compound behavior + postcondition 누락 | field snapshot·recalculate diff·save-and-verify |
| auth handoff → fill/upload → submit → receipt → later status | 인증 handoff 완료 | fresh submit 승인 없이 Agent가 신청 action 실행 | action authority + external state | submit gate·authorization record·receipt와 processing readback 분리 |
| fill → upload → permission → native picker → type rejection | form이 작성됨 | DOM 밖 picker와 accepted format을 뒤늦게 발견 | wrapper·auth/session·OS UI·uploader JS | upload capability preflight와 choose-convert-upload-verify |
| status row → new report tab → claim | 승인 row가 보임 | 새 tab event를 기존 handle이 놓침 | popup/new-tab binding | event-driven tab wait와 target identity |

## EG-Desk 목표 시나리오

```text
Form task 생성
  -> profile·account·tab·form revision 고정
  -> upload·auth·accepted-format capability preflight
  -> field manifest와 draft snapshot
  -> action packet: precondition → semantic action → expected event → postcondition
  -> navigation 전 save receipt 확인
  -> irreversible submit 전 사용자 diff·fresh authorization
  -> provider receipt readback
  -> processing monitor
  -> completed/rejected
  -> 필요 시 paid/delivered/current-state verification
```

Canvas에는 form snapshot, field diff, artifact identity, user handoff와 receipt timeline을
표시하고 Chat에는 현재 상태·막힌 이유·사용자에게 필요한 한 동작만 전달한다.

## Multi-agent technique opportunity

| 항목 | 판단 |
|---|---|
| 관찰된 문제 | 도메인 규칙 검토와 focus-sensitive live form mutation을 한 actor가 동시에 소유 |
| 후보 기법 | redacted form Reader/domain auditor + single live executor + post-submit receipt auditor |
| 적용 trigger | 계산이 제출 결과를 바꾸거나, form field·첨부가 많거나, 별도 submit control이 나타날 때 |
| 기대 효과 | field manifest 보존, 법규·숫자 검산, saved/submit 오인 방지 |
| 비용·위험 | 추가 handoff·latency, 민감값 복제, auditor의 권한 오인 |
| acceptance evidence | 최소화된 field-role packet, 단일 UI lease, 사용자 승인, 공식 receipt와 후속 status |
| 증거 상태 | 역사적 작업은 대부분 단일 executor였고 이 분리는 사후 제안 |

여러 Agent가 같은 authenticated form을 동시에 조작하거나 fresh Browser session을 무작정
열면 focus·session·unsaved state가 더 쉽게 사라진다. Auditor는 개인 field 값이 아니라
field 역할·산식·검사 항목만 보고, submit 권한을 갖지 않아야 한다.

## Candidate product implications

- 외부 action 공통 상태기계를 제품 전역에서 재사용한다.
- form·artifact·account·tab·revision을 하나의 Task binding으로 보존한다.
- Browser action은 precondition·expected event·postcondition과 cleanup을 가진다.
- fixed sleep 대신 receipt·status·upload list·new-tab event를 기다린다.
- navigation 전 unsaved-state guard와 server save receipt를 확인한다.
- 민감 인증·irreversible submit은 사용자 handoff로 분리한다.
- retry 비용과 폐기된 stale observation을 supervision evidence에 남긴다.

## 정본 연결 후보

- [Atlas BROWSER-04](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-browser-04)
- [Atlas AUTH-01](../../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-auth-01)
- [Contract §3 identity·authority](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-resource-identity)
- [Contract §13 실패 경계](../../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-failure-boundaries)
- [HUM-ORCH-001](../../../codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#hum-orch-001)

## 열린 질문

- 사이트별 save receipt가 없을 때 어떤 최소 evidence로 navigation을 허용하는가?
- form snapshot에서 민감값을 보존하지 않고 재개 가능한 manifest를 어떻게 만드는가?
- event adapter가 없는 사이트에서 polling·timeout·사용자 확인을 어떻게 조합하는가?
- native file picker와 Browser action의 task identity를 어떻게 연결하는가?
- 중복 제출 위험이 있는 retry를 언제 자동 차단하는가?
- 장기 processing 상태를 같은 Run으로 추적할지 별도 monitor Task로 분리할지 결정이 필요하다.

## Privacy

개인·직원·세무·고용 form 값, 계정·접수번호, 금액, 첨부 파일명과 screenshot은 복제하지
않았다. Auditor·Reader에게도 실제 값 대신 field role, validation rule, redacted diff와
SourceRef만 제공해야 한다.
