# EG-Desk 설계 Gap 및 사용자 확인 원장

> 이 문서의 앞부분은 제품 소유자가 답해야 하는 설계 gap의 정본이다. 뒷부분은 Main,
> PM, WM과 문서 유지보수자가 provenance·route·ID·drift를 관리하는 유지보수 부록이다.
> 제품 사용법은 Atlas, 기술 원리는 Contract에서 읽으며 이 원장은 둘을 다시 설명하지 않는다.

**문서 상태**: `ACTIVE / OPEN QUESTIONS`  
**정본 경로**: `docs/codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md`  
**최근 weave 검토일**: 2026-08-08  
**사용자 매뉴얼 정본**: [EG-Desk 가상 사용설명서와 제품 상호작용 Atlas](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-manual-start)  
**기술 구현 정본**: [EG-Desk 기술 구현·상호작용·오케스트레이션 계약](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-contract-top)

<a id="gap-owner-queue"></a>

## 0. 제품 소유자 확인 목록

이 목록은 문서 작성 Agent가 즉시 답을 요구해 전체 시스템을 멈추는 runtime UI가 아니다.
Main은 같은 결정에 속한 질문을 모아 유용한 검토 시점에 제시한다. 해당 답에 직접
의존하는 설계만 `OPEN`으로 남고, 표의 `계속 가능한 작업`은 그대로 진행한다.

`HUM-*`는 제품 의미·기본 수명주기·권한처럼 제품 소유자만 결정할 항목이다.
Atlas의 `Q-*`는 정확한 레이블·위치·키보드·재시도 표현처럼 PM 조사나 구현 검증으로
결정할 수 있는 세부 항목을 포함한다. `Q-*`가 많다는 사실이 곧 사용자 질문 175개를
뜻하지 않는다.

| 상태 | 의미 |
|---|---|
| `OPEN` | 선택지가 남았으며 어느 쪽도 확정 동작처럼 쓰지 않는다 |
| `PROPOSED` | PM이 외부 레퍼런스·trade-off와 함께 기본안을 제시했으나 owner 결정 전이다 |
| `DECIDED` | 사용자 결정 출처와 반영된 Atlas/Contract anchor가 있다 |
| `SUPERSEDED` | 더 최신 결정이 있으며 이전 결정 이력을 삭제하지 않는다 |

### 0.1 현재 확인이 필요한 제품 결정

<a id="hum-desk-001"></a>
#### HUM-DESK-001 — Desk 수와 Agenda 열기 결과

- **질문**: EG-Desk가 한 번에 여러 독립 Desk를 가질 수 있는가? Saved Agenda 행을 열 때 현재 Desk의 자동 복원 뷰를 `교체`, `현재 Desk에 합성`, 또는 `별도 Desk로 열기` 중 무엇으로 처리하는가?
- **왜 사용자 결정인가**: navigation·저장·복원 객체 수명주기가 달라진다.
- **영향**: [Atlas AG-02](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ag-02), [Contract §1](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-desk-lifecycle)
- **계속 가능한 작업**: 단일 Desk의 복원, Sidebar Agenda 목록, 열기 전 미리보기.
- **상태**: `OPEN`

<a id="hum-agenda-001"></a>
#### HUM-AGENDA-001 — Agenda 저장 내용과 revision 수명주기

- **질문**: Agenda에 기본으로 저장되는 범위를 무엇으로 하고, `업데이트`, `다른 이름으로 저장`, revision 충돌, 삭제·복구를 사용자가 어떤 의미로 이해해야 하는가?
- **왜 사용자 결정인가**: 자동 Desk 세션과 명시적 저장의 경계를 바꾼다.
- **영향**: [Atlas AG-01–04](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ag-01), [Contract §1](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-desk-lifecycle)
- **계속 가능한 작업**: 저장 범위 미리보기, revision 기술 모델, undo 가능한 prototype.
- **상태**: `OPEN`

<a id="hum-surface-001"></a>
#### HUM-SURFACE-001 — Desk·Canvas·View·Library·Terminal의 사람용 화면 모델

- **질문**: Desk당 Canvas와 view의 수·이름·관계, Library·project/folder·search의 진입 구조, view 열기·grouping·최대화·닫기와 resource/runtime 종료의 구분, Terminal을 선택적 expert 표면으로 여는 방식을 어떤 하나의 사람용 UI model로 확정할 것인가?
- **왜 사용자 결정인가**: 단순한 레이블을 넘어 사용자가 리소스를 찾고 화면을 조직하고 닫을 때 무엇이 남는지 이해하는 전체 mental model을 바꾼다.
- **영향**: [Atlas V-01–03](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-v-01), [DISC-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-disc-01), [CODE-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-code-01), [TERM-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-term-01), [Contract §6–7](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-coding-surface)
- **계속 가능한 작업**: view/resource/runtime identity 분리, Canvas 배치, 파일 tree·viewer, Terminal의 선택적 진입과 process 분리.
- **상태**: `OPEN`

<a id="hum-conv-001"></a>
#### HUM-CONV-001 — Chat, Agent DM, 공유 대화와 Agenda 관계

- **질문**: 일반 Chat, 개인 Agent DM, 여러 사람·Agent가 참여하는 공유 대화를 어떤 객체 관계로 제공하며, Agenda와 기본적으로 연결되는 범위는 무엇인가?
- **왜 사용자 결정인가**: 개인정보, 공유 범위, 재진입 위치와 협업 mental model을 바꾼다.
- **영향**: [Atlas AI-03](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-03), [Contract §5](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-multi-agent-chat)
- **계속 가능한 작업**: 단일 Chat, 메시지 event 저장, 선택적 context 공유 모델.
- **상태**: `OPEN`

<a id="hum-answer-001"></a>
#### HUM-ANSWER-001 — 요청·Result·논리적 Answer·Chat/Canvas 표현의 관계

- **질문**: 한 사용자 요청 아래 Run·Task·여러 Agent contribution·중간 Result·artifact와 사용자 대상 논리적 Answer revision을 어떤 동일성·수명주기로 구분할 것인가? 요청 담당 Agent 또는 integration 기능의 매체 구성 제안, System 검증, 제품 사용자의 Chat/Canvas 구성 override 범위는 어디까지인가?
- **왜 사용자 결정인가**: 무엇이 최종 답변이고 무엇이 기여·산출물·표현인지, 수정·삭제·공유·재진입 시 어떤 결과를 정본으로 보는지가 달라진다.
- **영향**: [Atlas AI-04](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-04), [Contract §4](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-answer-projection), [§11](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-parallel-agents)
- **계속 가능한 작업**: 하나의 논리적 Answer revision이 여러 기여·Result·artifact를 종합하고 Chat/Canvas가 같은 Answer를 매체별로 표현하는 계약.
- **상태**: `OPEN`; **현재 기본안**: Agent/integration 제안 → System 지원·권한·provenance 검증 → 사용자 탐색·재요청·허용된 override.

<a id="hum-brief-001"></a>
#### HUM-BRIEF-001 — 답변 브리핑 명칭과 편집·지속·공유 권한

- **질문**: 제품명 `Answer Briefing / 답변 브리핑`, 진입 레이블 `[브리핑 보기]`를 확정하는가? 사용자가 단계 순서·focus scope·설명을 편집·저장·공유할 수 있는 범위는 어디까지인가?
- **왜 사용자 결정인가**: 단순 presentation과 재사용 가능한 산출물 사이의 수명주기를 결정한다.
- **영향**: [Atlas AI-05](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-05), [Contract §8](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-answer-briefing)
- **계속 가능한 작업**: 사용자 입력으로 이전/다음/전체 보기, 단계 이동이 새 Run이 아니라는 계약.
- **상태**: `OPEN`; **현재 기본안**: `Answer Briefing / 답변 브리핑`.

<a id="hum-read-001"></a>
#### HUM-READ-001 — Smart Read 가시성과 사용자 개입 시점

- **질문**: 직접 읽기와 Reader Session 전환을 기본 화면에 어느 정도 보여 주고, 사용자가 `읽기 방향 수정`, `원문 coverage 검사`, `요청 담당 Agent에 직접 전달`을 언제 재정의할 수 있는가? 자동 recovery가 끝난 뒤 비밀번호·권한·대체 원본이 필요할 때 어떤 묶음으로 요청할 것인가?
- **왜 사용자 결정인가**: 단순한 Chat 경험과 고급 검사·제어 사이의 기본 복잡도를 바꾼다.
- **영향**: [Atlas READ-01–03](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-read-01), [Contract §2.1–2.4](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-smart-read)
- **계속 가능한 작업**: automatic admission, resumable Reader, source coverage와 recovery 기술 구현.
- **상태**: `OPEN`; **현재 기본안**: Chat에는 짧은 상태만, 클릭 시 Canvas 세부정보.

<a id="hum-snapshot-001"></a>
#### HUM-SNAPSHOT-001 — Snapshot 기본 표시·보존·redaction

- **질문**: raw/source capture와 Agent-delivered payload가 다를 때 무엇을 기본 탭으로 열고, snapshot 보존 기간·사용자 고정·redaction·원 권한 철회 후 열람·삭제·내보내기를 어떻게 정할 것인가?
- **왜 사용자 결정인가**: 투명성, 개인정보, 로컬 저장량과 과거 답변 재현성의 trade-off다.
- **영향**: [Atlas M5-F](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-m5-f), [Contract §4.1](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-observation-fidelity), [§15](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-storage-export)
- **계속 가능한 작업**: manifest payload role, immutable object, Snapshot/Live 분리.
- **상태**: `OPEN`

<a id="hum-engine-001"></a>
#### HUM-ENGINE-001 — AI Engine 계정 기본 선택 범위

- **질문**: AI Engine Profile의 기본값을 앱·Desk·Chat·요청 중 어느 범위에 저장하고, 계정 전환·로그아웃·quota 소진 시 진행 중 Run과 새 Run을 어떻게 구분할 것인가?
- **왜 사용자 결정인가**: 사용 편의와 잘못된 계정 quota 사용 위험의 균형을 정한다.
- **영향**: [Atlas ENGINE-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-engine-01), [Contract §14.1](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-engine-profile)
- **계속 가능한 작업**: identity plane 분리, Engine Profile별 credential/runtime 격리, Run의 `engineProfileId` 고정.
- **상태**: `OPEN`; **현재 기본안**: Chat 기본값 + 요청별 override, active Run 불변.

<a id="hum-agent-001"></a>
#### HUM-AGENT-001 — 즉시 사용 가능한 기본 Agent/Profile

- **질문**: 최초 설치에 안전한 기본 Agent/Profile을 제공할 것인가, 아니면 Chat 안에서 설정을 완료해야만 전송할 수 있게 할 것인가?
- **왜 사용자 결정인가**: 최초 사용 난이도와 제품이 기본으로 부여하는 Agent 행동 범위·책임 기대가 달라진다.
- **영향**: [Atlas 최초 설정](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-manual-start), [AGENT-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-agent-01)
- **계속 가능한 작업**: Profile 설정·선택 UI와 사용 불가 사유 표시.
- **상태**: `OPEN`

<a id="hum-run-001"></a>
#### HUM-RUN-001 — Agent·Profile·Run·Task·Memory와 실행 수명주기

- **질문**: Agent identity와 Profile의 소유·version·공유 범위, Run/Task/attempt/retry/resume/fork 관계, effective instruction·Memory·model/tool·credential·Ontology·권한·budget의 우선순위와 사용자가 검사·수정·보존·내보낼 범위를 어떻게 확정할 것인가?
- **왜 사용자 결정인가**: 사용자가 누구에게 무엇을 위임했고 어떤 설정·기억·권한으로 실행됐는지 이해하고 통제하는 제품 책임 모델을 정한다.
- **영향**: [Atlas AGENT-01–03](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-agent-01), [AI-01–02](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-01), [Contract §14](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-agent-run-binding)
- **계속 가능한 작업**: Run별 immutable effective configuration, 권한 비확대, active Run 불변, versioned relation과 안전한 inspect summary.
- **상태**: `OPEN`

<a id="hum-orch-001"></a>
#### HUM-ORCH-001 — Task graph·dependency·approval·integration의 사용자 통제

- **질문**: 제품 사용자가 Task graph·선행 조건·담당 Agent·partial Result를 어느 수준으로 보고 순서 변경·재할당·취소·재시도할 수 있으며, `approval-required` 결정을 어느 기존 화면에서 언제 검토하고 integration result를 어떻게 수락·수정할 것인가?
- **왜 사용자 결정인가**: 자동 실행의 자율성, 사용자 통제 시점, 승인으로 멈추는 범위와 여러 기여를 최종 결과로 묶는 책임이 달라진다.
- **영향**: [Atlas AI-06–07](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-06), [Contract §9](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-dependency-orchestration), [§11](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-parallel-agents)
- **계속 가능한 작업**: dependency checkpoint, 정본 Task 상태, 실패 분기만 차단, 독립 성공 보존, 승인 없는 권한 확대 금지.
- **상태**: `OPEN`; **현재 기본안**: 새 queue 객체 없이 관련 Chat/Task/Canvas 상태에서 검토.

<a id="hum-code-001"></a>
#### HUM-CODE-001 — 사람 대상 코딩 UX와 검증 완료 기준

- **질문**: project/folder·다중 root·file tree/search·editor/viewer·diff·변경 수락·build/test/review result를 어떤 기본 화면 조합으로 제공하고, 어떤 검증 evidence가 사용자에게 코딩 작업 완료를 뜻하는가? Terminal은 언제 선택적으로 노출하는가?
- **왜 사용자 결정인가**: AI의 내부 실행 수단과 사람이 이해·검토·수정하는 주 coding experience의 우선순위를 정한다.
- **영향**: [Atlas CODE-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-code-01), [TERM-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-term-01), [Contract §6–7](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-coding-surface)
- **계속 가능한 작업**: folder/file tree·viewer/editor·diff·test evidence surface, Terminal을 Agent substrate와 optional expert view로 분리.
- **상태**: `OPEN`

<a id="hum-export-001"></a>
#### HUM-EXPORT-001 — 로컬 데이터·`.egdesk` 기본 포함 범위와 보호

- **질문**: 앱·Desk·Agenda·account/profile·Agent 설정의 로컬 저장 범위와 보존·삭제·초기화 정책을 어떻게 나누고, 한 파일 내보내기에 Chat, Canvas layout, Agenda, Snapshot raw capture, Agent-delivered packet, artifact 중 무엇을 기본 포함할 것인가? 암호화를 기본/선택으로 둘지와 가져오기 충돌의 `새 사본`, `병합`, `건너뜀` 의미도 함께 확정하는가?
- **왜 사용자 결정인가**: 이동 편의, 파일 크기, 개인정보와 복원 충실도를 바꾼다.
- **영향**: [Atlas DATA-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-data-01), [Contract §15.1](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-portable-bundle)
- **계속 가능한 작업**: credential 제외, hash 검증, portable manifest/event/object prototype.
- **상태**: `OPEN`; **현재 기본안**: 선택한 root의 closed graph를 한 `.egdesk` 파일로 내보냄.

<a id="hum-gov-001"></a>
#### HUM-GOV-001 — Ontology 사용자 편집 권한

- **질문**: 최종 제품 사용자가 Ontology를 직접 편집·승격할 수 있는가, 제안만 할 수 있는가, 읽기 전용으로 검사만 하는가?
- **왜 사용자 결정인가**: Agent cycle을 제약하는 운영 model을 누가 바꿀 수 있는지와 검증·승격 책임을 정한다.
- **영향**: [Atlas ONT-01–02](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ont-01), [Contract §10](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-ontology-runtime)
- **계속 가능한 작업**: 읽기 전용 검사, version·evidence binding, Agent cycle 제약.
- **상태**: `OPEN`

<a id="hum-a11y-001"></a>
#### HUM-A11Y-001 — 최종 접근성 기준선

- **질문**: 목표로 삼을 WCAG/플랫폼 접근성 수준, 지원 화면 읽기·키보드·확대·언어 범위를 어디까지 확정할 것인가?
- **왜 사용자 결정인가**: 출시 시장·지원 약속·acceptance 범위와 검증 비용을 함께 바꾸는 제품 기준선이다.
- **영향**: [Atlas UX-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ux-01), [Contract §16](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-accessibility)
- **계속 가능한 작업**: 기본 keyboard/focus, accessible name/state, reduced motion, 비공간 대안.
- **상태**: `OPEN`

<a id="hum-collab-001"></a>
#### HUM-COLLAB-001 — 공유 범위·역할·동시 작업·computer-use 제어권

- **질문**: Desk·Agenda·view·conversation·artifact 중 무엇을 누구와 공유하고 owner/admin/collaborator/observer 역할, 초대·수락·철회·만료, 동시 편집·conflict·귀속을 어떻게 정의할 것인가? computer-use에서는 관찰, 사람/Agent control lease, handoff, emergency stop, collaborator control을 어떤 별도 권한으로 둘 것인가?
- **왜 사용자 결정인가**: 최종 비즈니스 목표인 다중 사용자 협업의 소유권·개인정보·동시 행동 충돌·통제 책임을 정한다.
- **영향**: [Atlas COL-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-col-01), [CU-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-cu-01), [Contract §12](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-collaboration-computer-use)
- **계속 가능한 작업**: 로컬 role/permission schema, 사람과 Agent input ownership 분리, Desk-visible 관찰, mock collaboration UI.
- **상태**: `OPEN`; 실제 원격 전송·identity·server provision은 `HUM-REMOTE-001`과 별도 승인 대상.

<a id="hum-remote-001"></a>
#### HUM-REMOTE-001 — 원격 협업·관찰·동기화 인프라

- **질문**: 원격 협업, Desk 밖 computer-use 관찰, 다중 기기 sync를 실제로 열 때 provider/자체 서버, identity, 비용, 전송 데이터, 보존·삭제 정책을 무엇으로 승인할 것인가?
- **왜 사용자 결정인가**: 외부 인프라·데이터 전송·비용·새 권한 경계다.
- **영향**: [Atlas COL-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-col-01), [CU-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-cu-01), [DATA-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-data-01)
- **계속 가능한 작업**: 로컬 단일 사용자 기능, 권한 schema, mock UI와 provider 비교 조사.
- **상태**: `OPEN / OWNER-APPROVAL-REQUIRED`

### 0.2 weave 규칙

한 기능 영역을 수정할 때 다음 cycle을 반복한다.

```text
Atlas에서 정확한 사용자 입력·화면 반응을 쓴다
-> Contract에서 필요한 state/data/runtime/authority를 쓴다
-> Contract가 요구하지만 Atlas에서 조작·확인할 수 없는 부분을 Atlas에 되돌린다
-> 둘 중 하나를 확정하려면 제품 의미 선택이 필요한 경우 HUM-*로 분리한다
-> HUM 답 없이도 가능한 작업과 실제 차단 범위를 기록한다
-> link·anchor·semantic drift 검사를 실행한다
```

<a id="gap-maintenance-appendix"></a>

## 1. 목적과 비제품 문서 경계

이 절부터는 유지보수 부록이다. 앞의 `HUM-*` 본문 외에는 다음 메타데이터만 소유한다.

- 출처와 provenance 분류, 스냅샷 해시 및 Git 상태
- trace·질문·승인 ID의 route, 배치, maturity, disposition 및 tombstone
- Main이 반영할 owner decision, `HUM-*`와 PM question packet의 운영 상태
- clean-room 오염 감사, 외부 참고자료 재사용 증거, 문서 간 drift
- 원장 자체 변경 이벤트 `ATL-ED-*`

이 원장은 `HUM-*` 질문과 decision history를 제외하고 제품 객체, 화면, 행동, 복구,
권한 또는 완료 조건을 새로 정의하지 않는다. 사용자 행동 본문은 Atlas, 기술 본문은
Contract에 둔다. 이 원장은 어느 쪽의 대체 문서도 런타임 증거도 아니다.

문서 간 탐색 링크는 다음 위치에 둔다.

- `BACKLINK-ATLAS-RESOLVED`: Atlas 상단의 `설계 gap·사용자 질문 정본` 링크
- `BACKLINK-CONTRACT-RESOLVED`: Contract 상단의 `설계 gap·사용자 질문 정본` 링크

링크가 존재한다는 사실은 제품 의미·구현·실행 상태의 증거가 아니다.
`.tmp/codex-swarm/atlas-redesign/`의 candidate 사본은 정본에 설치될 내용을
검사하기 위한 staging artifact이므로 링크도 정본 위치 기준 상대 경로를 유지한다.
링크 resolve 판정은 candidate staging 위치가 아니라 위 정본 세 파일의 실제
위치에서 수행한다.

## 2. 권한과 역할

| 역할 | 할 수 있는 일 | 할 수 없는 일 |
|---|---|---|
| 제품 owner | 제품 의미와 권한 경계에 대한 결정을 내리고 필요한 외부 승인을 부여·거부·보류한다 | 실행 성공을 승인 사실만으로 확정하지 않는다 |
| Main | owner decision을 Atlas/Contract/원장에 반영하고, 최종 disposition·question packet routing·승인 묶음·문서 쓰기·Git을 단독 소유한다 | 근거 없는 제품 의미를 owner decision으로 승격하지 않는다 |
| PM | evidence-backed proposal, 선택지·trade-off, 질문 packet 및 승인 후보 package를 준비한다 | owner decision, final disposition, Git, 실행 성공 판정을 소유하지 않는다 |
| researcher / worker | bounded primary evidence와 재현 가능한 관찰만 수집하고 provenance를 붙인다 | 제품 방향을 승인하거나 질문 route·최종 문구·disposition을 확정하지 않는다 |
| WM | 경로 선택, 로컬 reference 위치, freshness, current-vs-reference 분류 및 drift 경고만 제공한다 | 제품 의미, PM 제안, owner decision, 승인 또는 Git을 소유하지 않는다 |

권한이 충돌하면 Main이 증거를 분리해 owner에게 필요한 결정만 route한다. 응답이 없으면 해당 질문과 종속 설계만 `OPEN`으로 대기하고, 무관한 로컬 조사·설계·검증은 계속한다.

## 3. 최초 범례

### 3.1 정본 provenance labels

Atlas의 기존 축약 표식은 이 원장에서 다음 정본 label로 전환한다. 특히 기존 `[USER]` 표식은 `OWNER-DECISION`으로만 해석하며, 문서 작성자나 제품 사용자의 추정을 owner 결정으로 오인하지 않는다.

| label | 의미 | 제품 의미를 단독 확정할 수 있는가 |
|---|---|---|
| `OWNER-DECISION` | 제품 owner가 명시적으로 내린 최신 결정 또는 수정 | 예 |
| `COMMITTED-BASELINE` | owner 결정과 충돌하지 않는, 실패 라운드 이전의 커밋된 제품 기준선 | 후보만 가능; 최신 owner 결정이 우선 |
| `RUNTIME-OBSERVATION` | 현재 코드·실행 화면·로그에서 관찰한 구현 상태 | 아니요; 관찰한 시점의 상태만 입증 |
| `PRIMARY-REFERENCE` | 공식 문서, 표준, 원저자 자료 또는 유지되는 직접 참조 구현 | 아니요; proposal의 근거만 제공 |
| `PM-PROPOSAL` | 출처·fit·trade-off가 명시된 PM 권고안 | 아니요; Main의 결정 route가 필요 |
| `OPEN` | 제품·UI·지속성·권한·복구가 아직 정해지지 않음 | 아니요 |
| `APPROVAL` | 외부 인프라·데이터 이동·credential·비용·배포·새 실행 권한 gate | 승인된 범위만 허용; 성공 증거와 별도 |
| `REJECTED` | 명시적으로 무효이거나 정의되지 않은 가정 | 아니요; 제품 사실로 재도입 금지 |

증거 우선순위는 다음과 같다.

```text
최신 OWNER-DECISION
> 양립 가능한 COMMITTED-BASELINE
> RUNTIME-OBSERVATION
> PRIMARY-REFERENCE
> PM-PROPOSAL
```

`OPEN`, `APPROVAL`, `REJECTED`는 증거 서열이 아니라 각각 미결 상태, 권한 gate, 배제 disposition이다. 더 최근의 owner 결정이 이전 결정을 바꾸면 Main은 이전 결정의 이벤트를 삭제하지 않고 superseded 관계를 기록한다.

### 3.2 route migration

Atlas의 legacy label `USER-PRODUCT`가 붙은 기존 72개 항목은 ID 집합, 제품 의미, 결정 권한 또는 배치 경계를 바꾸지 않고 이 원장에서 `OWNER-PRODUCT`로 이름만 바꾼다. `PM-RESEARCH`는 그대로 유지한다. 이 원장의 최종 candidate route는 기존 72/82에 Agent 질문 17/3과 로컬 computer-use 관찰 질문 1/0을 더한 `OWNER-PRODUCT 90 / PM-RESEARCH 85`다.

## 4. clean-room source boundary

아래 여섯 행은 기준 Atlas의 clean-room source boundary를 의미 변경 없이 유지하되, 예정 정본 경로에서 작동하도록 상대 링크만 전치했다.

| 출처 | 이 Atlas에서의 용도 |
|---|---|
| 이 Codex 작업에서 사용자가 제시한 수정사항, 특히 Agenda와 Desk 복원을 분리하고 Chat/Canvas, Answer Briefing(기존 Playback 명칭), 오케스트레이션, Ontology, 코딩 UX, 협업 및 computer-use를 바로잡은 제품 설계 대화 차례 | 최상위 결정 근거가 되는 제품 입력 |
| [EG-Desk 제품 비전 및 개발 할 일](../../ideas/confirmed/EGDESK_PRODUCT_VISION_AND_DEV_TODO.md), 실패한 Atlas 라운드 이전에 커밋된 `HEAD` 버전 | 이전 제품 기준선; 현재 미커밋 변환은 그 자체만으로 결정 근거가 되지 않음 |
| [EG-Desk 비전 백서](../vision/EG-DESK%20백서%20-%20Vision_v1.md) | 장기 개념 기준선; 이후 사용자 수정사항이 우선함 |
| [apps/firefox-ui-demo/docs](../../apps/firefox-ui-demo/docs/) 아래에 있는 Firefox 제품/런타임 집중 문서의 커밋된 `HEAD` 버전 | 기준선 후보 및 용어 충돌의 증거 |
| [apps/firefox-ui-demo](../../apps/firefox-ui-demo/) 아래의 현재 Firefox 소스 | 구현 관찰에만 사용 |
| [Interaction Contract](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md)의 final-correction 직전 `UNTRACKED` snapshot, SHA-256 `42892ce140f81d2a2b67c548591cfb7ed7eb02e280e46796014d4b12552f5478`, 452 lines; 삭제 전 Atlas snapshot SHA-256 `b577608f81b73bc2b7c8690fd35987a8f283a90dcddc3f45eecb02552bfb64b2` | 동작, 객체 또는 기본값을 정립하는 데 사용하지 않음; 초안 후 부정 감사는 해당 정확한 snapshot의 오염이 다시 나타났는지만 확인할 수 있음 |

제외 이유는 다음과 같다.

- 위 hash로 식별한 Contract·Atlas snapshot은 동일한 이전 PM/Main 라운드에서 만들어져 서로 독립적인 증거가 아니므로 긍정적 동작 근거에서 제외한다. 오직 contamination negative audit에만 사용할 수 있다.
- 현재 미커밋 제품·런타임 문서는 owner 피드백을 유용하게 재서술했을 수 있어도 커밋된 기준선이나 owner decision이 아니므로 제품 의미 승격 근거에서 제외한다.
- 현재 구현은 `RUNTIME-OBSERVATION`으로만 사용할 수 있으며, 보이는 UI나 성공 응답이 지속성·외부 효과·완료를 입증한다고 확장하지 않는다.

## 5. 현재 source snapshot과 candidate delta

### 5.1 기준 Atlas snapshot

| 항목 | 값 |
|---|---|
| source 상태 | Git `UNTRACKED` (`??`); 커밋된 기준선 아님 |
| SHA-256 | `b577608f81b73bc2b7c8690fd35987a8f283a90dcddc3f45eecb02552bfb64b2` |
| trace | 35 |
| interaction/action rows | 123 |
| question | 154 (`OWNER-PRODUCT` 72, `PM-RESEARCH` 82) |
| approval | 6 |
| owner decision batch | `D1`–`D9` |

### 5.2 현재 Atlas rewrite delta

| 항목 | 기존 | addition | candidate 합계 |
|---|---:|---:|---:|
| trace | 35 | 4 | 39 |
| interaction/action rows | 123 | 21 | 144 |
| question | 154 | 21 | 175 |
| `OWNER-PRODUCT` | 72 | 18 | 90 |
| `PM-RESEARCH` | 82 | 3 | 85 |
| approval | 6 | 0 | 6 |
| owner decision batch | 9 | 1 (`D10`) | 10 |

현재 Atlas rewrite는 네 흐름과 스물한 질문을 `OPEN` coverage로 포함한다. 문서에 포함됐다는 사실은 해당 미결정 제품 의미가 owner에 의해 확정됐거나 구현·검증·커밋됐다는 뜻이 아니다.

### 5.3 PM PASS final fingerprint

| artifact | SHA-256 | lines | 검증 상태 |
|---|---|---:|---|
| Atlas final | `142e1f890bbe1ed3144f0f0aba59c2388fd227170f46037b2a5003d8a94270e5` | 2756 | PM final `PASS`; candidate·actual validator `PASS` |
| Interaction Contract | `d05d7976b047b95cbad6e717bb34fdfe0fc27f58de1a30e44c77c21f8587a6e3` | 497 | Agent effective binding 정합화; actual link audit `PASS` |

원장 자체 hash는 원장 안에 기록하지 않는다. 자체 hash를 본문에 넣으면 기록할
때마다 값이 바뀌는 순환 참조가 되기 때문이다. 최종 Git·파일 audit에서는 원장
hash를 외부 검증 출력으로만 계산한다.

### 5.4 2026-08-05 manual-first / Answer Briefing revision

| artifact | SHA-256 | lines | 검증 상태 |
|---|---|---:|---|
| Manual-first Atlas | `cfc338a9684998199d3d722f6a7e44ab18ae4ea87516983af25cb74a56d0c6eb` | 2912 | 첫 화면 ASCII·입력 문법·11단계 첫 한 바퀴·39개 상세 trace; candidate·actual validator `PASS`; PM 재감사 `PASS` |
| Interaction Contract | `ec8fea2f2ce7ddd9ccd403b69765218d4d4e6edc250caaf41697107c8f315a2b` | 517 | §4·§8 Answer Briefing 정합화; Run replay 의미 제거; PM 재감사 `PASS` |

이 revision은 stable `OBJ-038`–`OBJ-040`, `AI-05`, `Q-MEDIA-*`와 기존
explicit anchor를 유지했다. `Q-MEDIA-04`는 `Answer Briefing / 답변 브리핑`과
`브리핑 보기`를 1순위로 제안하되 owner가 정본 라벨을 확정할 때까지 `OPEN`이다.
행동 의미는 이름 결정과 무관하게 `Agent=공개 가능한 target set·Briefing
Order·Focus Scope·Step Explanation 제안`, `System=대상 검증·사용자 입력에 따른
화면 전환`, `제품 사용자=이전·다음·직접 이동·전체 보기·종료 및 의견 작성`으로
고정한다.

### 5.5 2026-08-06 Agent observation fidelity revision

| artifact | SHA-256 | lines | 검증 상태 |
|---|---|---:|---|
| Observation-fidelity Atlas | `bd053ad4109950a2868f754db75af4f7059367ba9a55d56be076384c5efffe87` | 3054 | 첫 한 바퀴, `AI-01`, `AI-04`, `OBJ-052`, `M5-F`, 불변조건 32–33 정합화; 21개 aspect map; candidate·actual validator `PASS` |
| Interaction Contract | `fafcd24d1edf4b3b1c6fbe8449c404557ca12a52810d14fbcd9647428942339f` | 640 | §4.1에서 mutable resource, Tool Result Snapshot, inference별 Agent Input Snapshot, Canvas projection, runtime handoff evidence와 provider 비관찰 경계를 분리 |

이 revision은 logical locator·resource/session binding을 콘텐츠 동일성 증거로 쓰지
않는다. 완료 활동의 기본 Canvas 대상은 `[Agent에게 전달된 버전]`이며, raw tool
result, 현재 상태와 차이는 별도 행동으로 연다. snapshot이 없거나 provider가 정확한
payload를 공개하지 않으면 현재 내용을 역사적 입력으로 재구성하지 않는다. 입력
후보를 준비·저장한 사실만으로 전달됐다고 표시하지 않고 같은 inference attempt와
payload integrity reference의 runtime handoff가 확인된 경우에만 `전달됨`을 쓴다. 정확한
보존 기간·대용량·binary·secret·권한 철회 정책은 `Q-AI-04`에서 계속 추적한다.

### 5.6 2026-08-06 Snapshot/Live viewer simplification

| artifact | SHA-256 | lines | 검증 상태 |
|---|---|---:|---|
| Snapshot/Live Atlas | `f56e20605c67e5ee1b9ebca321379c62483e2cb43247bd5d8efd2abb50ad7d76` | 3058 | 첫 한 바퀴, `AI-01`, `AI-04`, `OBJ-024`, `OBJ-052`, `M5-F`, 불변조건 32–33 정정; 21개 aspect map; candidate·actual validator `PASS` |
| Interaction Contract | `741187bf12ff08661746e36412e6a036c9234e8b8b4e9e381152917dd6034c04` | 625 | §4.1을 정상 도구 결과와 Agent Observation Snapshot의 일대일 계약 및 Snapshot View/Live View 두 사용자 표면으로 단순화 |

이 revision은 5.5와 `ATL-ED-0012`의 과도한 4계층 설명을 의미상 대체하되 해당 이력은
삭제하지 않는다. 정상 경로에서 도구가 성공적으로 반환한 전체 결과가 곧 불변
`Agent Observation Snapshot`이며 Agent도 같은 전체 결과를 받는다. File read가
40–80행을 반환했다면 snapshot과 Agent 입력 모두 40–80행을 포함하고, 무표시
생략·요약·부분 선택은 허용하지 않는다. 사용자 표면은 도구 호출 당시 내용을 보여 주는
읽기 전용 `Snapshot View`와 현재 resource/runtime를 다루는 `Live View`로 구분한다.
같은 renderer 구현을 재사용할 수 있지만 두 view는 별도 identity로 같은 Canvas에
공존한다. Answer Briefing은 snapshot과 고정된 파생 산출물을 사용하고, 제품 사용자가
직접 다루는 live Browser·File·Terminal은 이를 덮어쓰지 않는다. provider 내부
tokenization·attention과 runtime handoff 세부는 이 제품 상호작용 계약의 설명 범위에서
제거했다. 정확한 보존 기간·대용량·binary·secret·권한 철회 정책은 `Q-AI-04`에서 계속
추적한다.

### 5.7 2026-08-08 UI/UX ↔ 기술 계약 weave revision

5.6의 “모든 정상 도구 결과와 Agent 입력은 일대일” 규칙은 **direct named tool
result에만 적용**되고, Smart Read에는 적용되지 않는다. 이번 revision이 5.6의 현재
제품 의미를 supersede한다. Smart Read는 immutable raw/source capture, Reader Context
Packet과 요청 담당 Agent에게 실제 전달된 payload를 분리해 coverage·transformation lineage를
보존한다. Snapshot View와 Live View라는 두 사용자 표면은 유지하되 Snapshot 안에서
payload role을 검사할 수 있다.

동시에 Atlas는 UI 행동 정본, Contract는 기술 정본으로 역할을 분리했고 `READ-01`–
`READ-03`, `ENGINE-01`, `OBJ-054`–`OBJ-056`을 추가했다. 제품 소유자가 답해야 하는
의미 선택은 0절의 18개 `HUM-*`로 승격했으며, 기존 175개 `Q-*`는 상세 UI 연구와
stable-link 호환 색인으로 유지한다.

## 6. stable ID와 explicit anchor 규칙

1. Atlas가 trace ID, `Q-*`, approval ID와 `OBJ-*` 제품 요소, `AFF-*` 비객체 어포던스의 namespace와 정본 정의를 소유한다. 이 원장은 제품 소유자 질문·결정용 `HUM-*` namespace와 그 disposition을 소유한다. 유지보수용 `EXC-*`는 contamination exclusion ID이며 제품 ID나 제품 anchor가 아니다.
2. 이 원장은 자체 편집 사건에만 `ATL-ED-0001` 형식의 단조 증가 event ID를 사용한다. event ID는 재사용하거나 다시 번호 매기지 않는다.
3. 제목, 한글 표현, 섹션 위치가 바뀌어도 기존 ID는 바뀌지 않는다. 의미가 갈라지면 새 Atlas ID와 관계를 만들고 Main이 disposition한다.
4. 제거·병합·대체된 ID는 삭제하지 않고 tombstone으로 남긴다. tombstone에는 `status`, `superseded-by` 또는 `merged-into`, 사유, Main disposition event를 기록한다. tombstone ID는 재사용하지 않는다.
5. 세 정본 문서는 자동 생성 heading slug에만 의존하지 않고 명시적 HTML anchor를 둔다. Atlas 패턴은 trace `atlas-<trace-id-lower>`, question `atlas-<question-id-lower>`, approval `atlas-<approval-id-lower>`, 제품 요소 `atlas-<obj-id-lower>`, 어포던스 `atlas-<aff-id-lower>`다. Contract는 `tech-*`, 이 원장은 `hum-*`와 `gap-*`를 쓴다. `EXC-*`에는 제품 anchor를 만들지 않는다.
6. 의도적으로 비어 있는 기존 Agenda 질문 번호는 새 질문으로 채우지 않는다. 새 질문은 Main이 Atlas namespace와 충돌 여부를 확인한 뒤 다음 유효 ID를 배정한다.
7. 원장과 Atlas에는 raw prompt, 비공개 chain-of-thought, credential·token·session secret, 개인 데이터, 절대 로컬 경로를 넣지 않는다. 근거는 repo-relative path, 공개 URL, commit, hash, bounded evidence summary로 남긴다.

## 7. trace registry — 43

제품 행동 본문은 의도적으로 생략한다. `maturity`와 `provenance`만 유지한다.

<!-- TRACE-REGISTRY:START -->
| trace ID | maturity | provenance |
|---|---|---|
| `L-01` | `PARTIAL` | `OWNER-DECISION + COMMITTED-BASELINE` |
| `L-02` | `PARTIAL` | `OWNER-DECISION` |
| `L-03` | `PARTIAL` | `OWNER-DECISION` |
| `AG-01` | `PARTIAL` | `OWNER-DECISION + COMMITTED-BASELINE` |
| `AG-02` | `PARTIAL` | `OWNER-DECISION` |
| `AG-03` | `PARTIAL` | `OWNER-DECISION` |
| `AG-04` | `BASELINE-CANDIDATE` | `COMMITTED-BASELINE + RUNTIME-OBSERVATION` |
| `V-01` | `PARTIAL` | `COMMITTED-BASELINE + OPEN` |
| `V-02` | `PARTIAL` | `COMMITTED-BASELINE + RUNTIME-OBSERVATION` |
| `V-03` | `BASELINE-CANDIDATE` | `COMMITTED-BASELINE + RUNTIME-OBSERVATION` |
| `DISC-01` | `BASELINE-CANDIDATE` | `COMMITTED-BASELINE + OPEN` |
| `TOOL-01` | `PARTIAL` | `OWNER-DECISION` |
| `BROWSER-01` | `PARTIAL` | `OWNER-DECISION + COMMITTED-BASELINE` |
| `BROWSER-02` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `BROWSER-03` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `BROWSER-04` | `PARTIAL` | `OWNER-DECISION` |
| `TOOL-02` | `PARTIAL` | `OWNER-DECISION` |
| `CHAT-01` | `PARTIAL` | `OWNER-DECISION + COMMITTED-BASELINE` |
| `AI-01` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `AI-02` | `PARTIAL` | `OWNER-DECISION` |
| `READ-01` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `READ-02` | `PARTIAL` | `OWNER-DECISION` |
| `READ-03` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `ENGINE-01` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `AI-03` | `BASELINE-CANDIDATE` | `COMMITTED-BASELINE + OWNER-DECISION + OPEN` |
| `AI-04` | `PARTIAL` | `OWNER-DECISION` |
| `AI-05` | `PARTIAL` | `OWNER-DECISION` |
| `CANVAS-01` | `BASELINE-CANDIDATE` | `COMMITTED-BASELINE + RUNTIME-OBSERVATION` |
| `AI-06` | `PARTIAL` | `OWNER-DECISION` |
| `AI-07` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `AUTH-01` | `PARTIAL` | `OWNER-DECISION` |
| `CODE-01` | `PARTIAL` | `OWNER-DECISION` |
| `TERM-01` | `PARTIAL` | `OWNER-DECISION` |
| `ONT-01` | `PARTIAL` | `OWNER-DECISION` |
| `ONT-02` | `PARTIAL` | `OWNER-DECISION` |
| `COL-01` | `PARTIAL` | `OWNER-DECISION + APPROVAL` |
| `CU-01` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `DATA-01` | `PARTIAL` | `OWNER-DECISION + APPROVAL` |
| `UX-01` | `PARTIAL` | `OPEN` |
| `AGENT-01` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `AGENT-02` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `AGENT-03` | `PARTIAL` | `OWNER-DECISION + OPEN` |
| `SYS-01` | `PARTIAL` | `OWNER-DECISION + OPEN` |
<!-- TRACE-REGISTRY:END -->

## 8. question routing registry — 175

각 `Q-*` ID는 이 registry에 정확히 한 번만 나타난다. 되돌리기 쉬운 세부 UI 질문
본문은 Atlas가 소유하고 여기에는 route·work group·status·Atlas anchor만 둔다.
제품 소유자 결정이 필요한 질문의 정본은 이 문서 0절의 `HUM-*` queue다.

### 8.1 PM work groups

| PM work group | 범위 | 질문 수 |
|---|---|---:|
| `P1-LIFECYCLE-RECOVERY` | 실행·세션 복원·기능 저하·재진입 | 9 |
| `P2-AGENDA-LIFECYCLE` | Agenda 생성·열기·저장·충돌·보관·삭제 | 11 |
| `P3-VIEW-CANVAS-DISCOVERY` | view 조작·Canvas 탐색·검색·Library | 12 |
| `P4-CHAT-AI-MEDIA` | Chat·AI request·context·Canvas/Playback media | 12 |
| `P5-ORCHESTRATION-APPROVAL` | 작업 전환과 승인 경계·컨트롤 | 3 |
| `P6-ACCOUNT-BROWSER-EVIDENCE` | 계정·Browser·외부 효과 증거 | 9 |
| `P7-CODE-TERMINAL` | 사람 중심 coding·file·Terminal lifecycle | 9 |
| `P8-ONTOLOGY-COLLAB-CU` | Ontology·협업·computer-use | 10 |
| `P9-DATA-ACCESSIBILITY` | 데이터 수명주기·키보드·접근성 | 7 |
| `P10-AGENT-PROFILE-RUN` | capability/availability UI, 반복 acceptance, 경계별 장애 진단·복구 | 3 |
| **합계** |  | **85** |

<!-- QUESTION-ROUTING-REGISTRY:START -->
| question ID | route | decision batch / PM work group | status | Atlas anchor |
|---|---|---|---|---|
| `Q-OBJ-01` | `OWNER-PRODUCT` | `D1` | `OPEN` | `atlas-q-obj-01` |
| `Q-OBJ-02` | `OWNER-PRODUCT` | `D1` | `OPEN` | `atlas-q-obj-02` |
| `Q-OBJ-03` | `OWNER-PRODUCT` | `D1` | `OPEN` | `atlas-q-obj-03` |
| `Q-OBJ-04` | `OWNER-PRODUCT` | `D1` | `OPEN` | `atlas-q-obj-04` |
| `Q-OBJ-05` | `OWNER-PRODUCT` | `D3` | `OPEN` | `atlas-q-obj-05` |
| `Q-OBJ-06` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-obj-06` |
| `Q-OBJ-07` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-obj-07` |
| `Q-LIFE-01` | `PM-RESEARCH` | `P1-LIFECYCLE-RECOVERY` | `OPEN` | `atlas-q-life-01` |
| `Q-LIFE-02` | `PM-RESEARCH` | `P1-LIFECYCLE-RECOVERY` | `OPEN` | `atlas-q-life-02` |
| `Q-LIFE-03` | `PM-RESEARCH` | `P1-LIFECYCLE-RECOVERY` | `OPEN` | `atlas-q-life-03` |
| `Q-LIFE-04` | `OWNER-PRODUCT` | `D2` | `OPEN` | `atlas-q-life-04` |
| `Q-LIFE-05` | `PM-RESEARCH` | `P1-LIFECYCLE-RECOVERY` | `OPEN` | `atlas-q-life-05` |
| `Q-RESTORE-01` | `PM-RESEARCH` | `P1-LIFECYCLE-RECOVERY` | `OPEN` | `atlas-q-restore-01` |
| `Q-RESTORE-02` | `OWNER-PRODUCT` | `D2` | `OPEN` | `atlas-q-restore-02` |
| `Q-RESTORE-03` | `PM-RESEARCH` | `P1-LIFECYCLE-RECOVERY` | `OPEN` | `atlas-q-restore-03` |
| `Q-RESTORE-04` | `OWNER-PRODUCT` | `D2` | `OPEN` | `atlas-q-restore-04` |
| `Q-RESTORE-05` | `OWNER-PRODUCT` | `D2` | `OPEN` | `atlas-q-restore-05` |
| `Q-RESTORE-06` | `PM-RESEARCH` | `P1-LIFECYCLE-RECOVERY` | `OPEN` | `atlas-q-restore-06` |
| `Q-RESTORE-07` | `PM-RESEARCH` | `P1-LIFECYCLE-RECOVERY` | `OPEN` | `atlas-q-restore-07` |
| `Q-RESTORE-08` | `PM-RESEARCH` | `P1-LIFECYCLE-RECOVERY` | `OPEN` | `atlas-q-restore-08` |
| `Q-AG-01` | `OWNER-PRODUCT` | `D1` | `OPEN` | `atlas-q-ag-01` |
| `Q-AG-02` | `OWNER-PRODUCT` | `D1` | `OPEN` | `atlas-q-ag-02` |
| `Q-AG-03` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-03` |
| `Q-AG-04` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-04` |
| `Q-AG-05` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-05` |
| `Q-AG-06` | `OWNER-PRODUCT` | `D1` | `OPEN` | `atlas-q-ag-06` |
| `Q-AG-07` | `OWNER-PRODUCT` | `D2` | `OPEN` | `atlas-q-ag-07` |
| `Q-AG-08` | `OWNER-PRODUCT` | `D2` | `OPEN` | `atlas-q-ag-08` |
| `Q-AG-09` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-09` |
| `Q-AG-10` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-10` |
| `Q-AG-11` | `OWNER-PRODUCT` | `D2` | `OPEN` | `atlas-q-ag-11` |
| `Q-AG-12` | `OWNER-PRODUCT` | `D2` | `OPEN` | `atlas-q-ag-12` |
| `Q-AG-13` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-13` |
| `Q-AG-14` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-14` |
| `Q-AG-15` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-15` |
| `Q-AG-16` | `OWNER-PRODUCT` | `D2` | `OPEN` | `atlas-q-ag-16` |
| `Q-AG-17` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-17` |
| `Q-AG-19` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-19` |
| `Q-AG-20` | `PM-RESEARCH` | `P2-AGENDA-LIFECYCLE` | `OPEN` | `atlas-q-ag-20` |
| `Q-VIEW-01` | `OWNER-PRODUCT` | `D3` | `OPEN` | `atlas-q-view-01` |
| `Q-VIEW-02` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-view-02` |
| `Q-VIEW-03` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-view-03` |
| `Q-VIEW-04` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-view-04` |
| `Q-VIEW-05` | `OWNER-PRODUCT` | `D3` | `OPEN` | `atlas-q-view-05` |
| `Q-VIEW-06` | `OWNER-PRODUCT` | `D3` | `OPEN` | `atlas-q-view-06` |
| `Q-VIEW-07` | `OWNER-PRODUCT` | `D3` | `OPEN` | `atlas-q-view-07` |
| `Q-VIEW-08` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-view-08` |
| `Q-VIEW-09` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-view-09` |
| `Q-VIEW-10` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-view-10` |
| `Q-VIEW-11` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-view-11` |
| `Q-VIEW-12` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-view-12` |
| `Q-VIEW-13` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-view-13` |
| `Q-DISC-01` | `OWNER-PRODUCT` | `D3` | `OPEN` | `atlas-q-disc-01` |
| `Q-DISC-02` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-disc-02` |
| `Q-DISC-03` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-disc-03` |
| `Q-LIB-01` | `PM-RESEARCH` | `P3-VIEW-CANVAS-DISCOVERY` | `OPEN` | `atlas-q-lib-01` |
| `Q-CHAT-01` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-chat-01` |
| `Q-CHAT-02` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-chat-02` |
| `Q-CHAT-03` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-chat-03` |
| `Q-AI-01` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-ai-01` |
| `Q-AI-02` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-ai-02` |
| `Q-AI-03` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-ai-03` |
| `Q-AI-04` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-ai-04` |
| `Q-AI-05` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-ai-05` |
| `Q-AI-06` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-ai-06` |
| `Q-AI-07` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-ai-07` |
| `Q-AI-08` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-ai-08` |
| `Q-AI-09` | `OWNER-PRODUCT` | `D4` | `OPEN` | `atlas-q-ai-09` |
| `Q-AI-10` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-ai-10` |
| `Q-AI-11` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-ai-11` |
| `Q-AI-12` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-ai-12` |
| `Q-AI-13` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-ai-13` |
| `Q-MEDIA-01` | `OWNER-PRODUCT` | `D5` | `OPEN` | `atlas-q-media-01` |
| `Q-MEDIA-02` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-media-02` |
| `Q-MEDIA-03` | `OWNER-PRODUCT` | `D5` | `OPEN` | `atlas-q-media-03` |
| `Q-MEDIA-04` | `OWNER-PRODUCT` | `D5` | `OPEN` | `atlas-q-media-04` |
| `Q-MEDIA-05` | `OWNER-PRODUCT` | `D5` | `OPEN` | `atlas-q-media-05` |
| `Q-MEDIA-06` | `OWNER-PRODUCT` | `D5` | `OPEN` | `atlas-q-media-06` |
| `Q-MEDIA-07` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-media-07` |
| `Q-MEDIA-08` | `OWNER-PRODUCT` | `D5` | `OPEN` | `atlas-q-media-08` |
| `Q-MEDIA-09` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-media-09` |
| `Q-MEDIA-10` | `OWNER-PRODUCT` | `D5` | `OPEN` | `atlas-q-media-10` |
| `Q-MEDIA-11` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-media-11` |
| `Q-MEDIA-12` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-media-12` |
| `Q-MEDIA-13` | `PM-RESEARCH` | `P4-CHAT-AI-MEDIA` | `OPEN` | `atlas-q-media-13` |
| `Q-ORCH-01` | `OWNER-PRODUCT` | `D6` | `OPEN` | `atlas-q-orch-01` |
| `Q-ORCH-02` | `OWNER-PRODUCT` | `D6` | `OPEN` | `atlas-q-orch-02` |
| `Q-ORCH-03` | `OWNER-PRODUCT` | `D6` | `OPEN` | `atlas-q-orch-03` |
| `Q-ORCH-04` | `OWNER-PRODUCT` | `D6` | `OPEN` | `atlas-q-orch-04` |
| `Q-ORCH-05` | `PM-RESEARCH` | `P5-ORCHESTRATION-APPROVAL` | `OPEN` | `atlas-q-orch-05` |
| `Q-ORCH-06` | `PM-RESEARCH` | `P5-ORCHESTRATION-APPROVAL` | `OPEN` | `atlas-q-orch-06` |
| `Q-ORCH-07` | `OWNER-PRODUCT` | `D6` | `OPEN` | `atlas-q-orch-07` |
| `Q-ORCH-08` | `PM-RESEARCH` | `P5-ORCHESTRATION-APPROVAL` | `OPEN` | `atlas-q-orch-08` |
| `Q-AUTH-01` | `OWNER-PRODUCT` | `D3` | `OPEN` | `atlas-q-auth-01` |
| `Q-AUTH-02` | `PM-RESEARCH` | `P6-ACCOUNT-BROWSER-EVIDENCE` | `OPEN` | `atlas-q-auth-02` |
| `Q-AUTH-03` | `PM-RESEARCH` | `P6-ACCOUNT-BROWSER-EVIDENCE` | `OPEN` | `atlas-q-auth-03` |
| `Q-AUTH-04` | `OWNER-PRODUCT` | `D3` | `OPEN` | `atlas-q-auth-04` |
| `Q-AUTH-05` | `PM-RESEARCH` | `P6-ACCOUNT-BROWSER-EVIDENCE` | `OPEN` | `atlas-q-auth-05` |
| `Q-AUTH-06` | `PM-RESEARCH` | `P6-ACCOUNT-BROWSER-EVIDENCE` | `OPEN` | `atlas-q-auth-06` |
| `Q-AUTH-07` | `PM-RESEARCH` | `P6-ACCOUNT-BROWSER-EVIDENCE` | `OPEN` | `atlas-q-auth-07` |
| `Q-AUTH-08` | `PM-RESEARCH` | `P6-ACCOUNT-BROWSER-EVIDENCE` | `OPEN` | `atlas-q-auth-08` |
| `Q-BROWSER-01` | `PM-RESEARCH` | `P6-ACCOUNT-BROWSER-EVIDENCE` | `OPEN` | `atlas-q-browser-01` |
| `Q-BROWSER-02` | `PM-RESEARCH` | `P6-ACCOUNT-BROWSER-EVIDENCE` | `OPEN` | `atlas-q-browser-02` |
| `Q-BROWSER-03` | `PM-RESEARCH` | `P6-ACCOUNT-BROWSER-EVIDENCE` | `OPEN` | `atlas-q-browser-03` |
| `Q-CODE-01` | `OWNER-PRODUCT` | `D7` | `OPEN` | `atlas-q-code-01` |
| `Q-CODE-02` | `PM-RESEARCH` | `P7-CODE-TERMINAL` | `OPEN` | `atlas-q-code-02` |
| `Q-CODE-03` | `OWNER-PRODUCT` | `D7` | `OPEN` | `atlas-q-code-03` |
| `Q-CODE-04` | `OWNER-PRODUCT` | `D7` | `OPEN` | `atlas-q-code-04` |
| `Q-CODE-05` | `PM-RESEARCH` | `P7-CODE-TERMINAL` | `OPEN` | `atlas-q-code-05` |
| `Q-CODE-06` | `PM-RESEARCH` | `P7-CODE-TERMINAL` | `OPEN` | `atlas-q-code-06` |
| `Q-CODE-07` | `PM-RESEARCH` | `P7-CODE-TERMINAL` | `OPEN` | `atlas-q-code-07` |
| `Q-CODE-08` | `PM-RESEARCH` | `P7-CODE-TERMINAL` | `OPEN` | `atlas-q-code-08` |
| `Q-CODE-09` | `PM-RESEARCH` | `P7-CODE-TERMINAL` | `OPEN` | `atlas-q-code-09` |
| `Q-TERM-01` | `OWNER-PRODUCT` | `D3` | `OPEN` | `atlas-q-term-01` |
| `Q-TERM-02` | `OWNER-PRODUCT` | `D3` | `OPEN` | `atlas-q-term-02` |
| `Q-TERM-03` | `PM-RESEARCH` | `P7-CODE-TERMINAL` | `OPEN` | `atlas-q-term-03` |
| `Q-TERM-04` | `PM-RESEARCH` | `P7-CODE-TERMINAL` | `OPEN` | `atlas-q-term-04` |
| `Q-TERM-05` | `PM-RESEARCH` | `P7-CODE-TERMINAL` | `OPEN` | `atlas-q-term-05` |
| `Q-ONT-01` | `OWNER-PRODUCT` | `D6` | `OPEN` | `atlas-q-ont-01` |
| `Q-ONT-02` | `OWNER-PRODUCT` | `D6` | `OPEN` | `atlas-q-ont-02` |
| `Q-ONT-03` | `OWNER-PRODUCT` | `D6` | `OPEN` | `atlas-q-ont-03` |
| `Q-ONT-04` | `PM-RESEARCH` | `P8-ONTOLOGY-COLLAB-CU` | `OPEN` | `atlas-q-ont-04` |
| `Q-ONT-05` | `PM-RESEARCH` | `P8-ONTOLOGY-COLLAB-CU` | `OPEN` | `atlas-q-ont-05` |
| `Q-COL-01` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-col-01` |
| `Q-COL-02` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-col-02` |
| `Q-COL-03` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-col-03` |
| `Q-COL-04` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-col-04` |
| `Q-COL-05` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-col-05` |
| `Q-COL-06` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-col-06` |
| `Q-COL-07` | `PM-RESEARCH` | `P8-ONTOLOGY-COLLAB-CU` | `OPEN` | `atlas-q-col-07` |
| `Q-COL-08` | `PM-RESEARCH` | `P8-ONTOLOGY-COLLAB-CU` | `OPEN` | `atlas-q-col-08` |
| `Q-COL-09` | `PM-RESEARCH` | `P8-ONTOLOGY-COLLAB-CU` | `OPEN` | `atlas-q-col-09` |
| `Q-COL-10` | `PM-RESEARCH` | `P8-ONTOLOGY-COLLAB-CU` | `OPEN` | `atlas-q-col-10` |
| `Q-CU-01` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-cu-01` |
| `Q-CU-02` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-cu-02` |
| `Q-CU-03` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-cu-03` |
| `Q-CU-04` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-cu-04` |
| `Q-CU-05` | `PM-RESEARCH` | `P8-ONTOLOGY-COLLAB-CU` | `OPEN` | `atlas-q-cu-05` |
| `Q-CU-06` | `PM-RESEARCH` | `P8-ONTOLOGY-COLLAB-CU` | `OPEN` | `atlas-q-cu-06` |
| `Q-CU-07` | `PM-RESEARCH` | `P8-ONTOLOGY-COLLAB-CU` | `OPEN` | `atlas-q-cu-07` |
| `Q-CU-08` | `PM-RESEARCH` | `P8-ONTOLOGY-COLLAB-CU` | `OPEN` | `atlas-q-cu-08` |
| `Q-CU-09` | `OWNER-PRODUCT` | `D8` | `OPEN` | `atlas-q-cu-09` |
| `Q-DATA-01` | `OWNER-PRODUCT` | `D9` | `OPEN` | `atlas-q-data-01` |
| `Q-DATA-02` | `OWNER-PRODUCT` | `D9` | `OPEN` | `atlas-q-data-02` |
| `Q-DATA-03` | `OWNER-PRODUCT` | `D9` | `OPEN` | `atlas-q-data-03` |
| `Q-DATA-04` | `OWNER-PRODUCT` | `D9` | `OPEN` | `atlas-q-data-04` |
| `Q-DATA-05` | `OWNER-PRODUCT` | `D9` | `OPEN` | `atlas-q-data-05` |
| `Q-DATA-06` | `PM-RESEARCH` | `P9-DATA-ACCESSIBILITY` | `OPEN` | `atlas-q-data-06` |
| `Q-DATA-07` | `PM-RESEARCH` | `P9-DATA-ACCESSIBILITY` | `OPEN` | `atlas-q-data-07` |
| `Q-DATA-08` | `PM-RESEARCH` | `P9-DATA-ACCESSIBILITY` | `OPEN` | `atlas-q-data-08` |
| `Q-DATA-09` | `PM-RESEARCH` | `P9-DATA-ACCESSIBILITY` | `OPEN` | `atlas-q-data-09` |
| `Q-UX-01` | `OWNER-PRODUCT` | `D9` | `OPEN` | `atlas-q-ux-01` |
| `Q-UX-02` | `PM-RESEARCH` | `P9-DATA-ACCESSIBILITY` | `OPEN` | `atlas-q-ux-02` |
| `Q-UX-03` | `PM-RESEARCH` | `P9-DATA-ACCESSIBILITY` | `OPEN` | `atlas-q-ux-03` |
| `Q-UX-04` | `PM-RESEARCH` | `P9-DATA-ACCESSIBILITY` | `OPEN` | `atlas-q-ux-04` |
| `Q-AGENT-01` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-01` |
| `Q-AGENT-02` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-02` |
| `Q-AGENT-03` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-03` |
| `Q-AGENT-04` | `PM-RESEARCH` | `P10-AGENT-PROFILE-RUN` | `OPEN` | `atlas-q-agent-04` |
| `Q-AGENT-05` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-05` |
| `Q-AGENT-06` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-06` |
| `Q-AGENT-07` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-07` |
| `Q-AGENT-08` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-08` |
| `Q-AGENT-09` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-09` |
| `Q-AGENT-10` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-10` |
| `Q-AGENT-11` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-11` |
| `Q-AGENT-12` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-12` |
| `Q-AGENT-13` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-13` |
| `Q-AGENT-14` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-14` |
| `Q-AGENT-15` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-15` |
| `Q-AGENT-16` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-16` |
| `Q-AGENT-17` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-17` |
| `Q-AGENT-18` | `OWNER-PRODUCT` | `D10` | `OPEN` | `atlas-q-agent-18` |
| `Q-AGENT-19` | `PM-RESEARCH` | `P10-AGENT-PROFILE-RUN` | `OPEN` | `atlas-q-agent-19` |
| `Q-AGENT-20` | `PM-RESEARCH` | `P10-AGENT-PROFILE-RUN` | `OPEN` | `atlas-q-agent-20` |
<!-- QUESTION-ROUTING-REGISTRY:END -->

<!-- OWNER-Q-HUM-MAP:START -->

### 8.1 `OWNER-PRODUCT` Q → `HUM` 전수 매핑

아래 표는 기존 90개 owner-routed `Q-*`를 제품 소유자가 읽을 정본 `HUM-*` 질문에
전수 귀속한다. 한 `Q-*`가 둘 이상의 제품 결정 경계를 가로지르면 모든 관련 `HUM-*`를
표시한다. 이 표에 없는 `PM-RESEARCH` 질문은 owner 결정을 가장하지 않고 조사·구현
세부로 남는다. `HUM-*` 결정이 내려지면 Main은 연결된 `Q-*`를 ID별 disposition으로
분해해 반영한다.

| owner-routed Q | canonical HUM decision |
|---|---|
| `Q-OBJ-01` | [HUM-DESK-001](#hum-desk-001) |
| `Q-OBJ-02` | [HUM-DESK-001](#hum-desk-001) |
| `Q-OBJ-03` | [HUM-SURFACE-001](#hum-surface-001) |
| `Q-OBJ-04` | [HUM-DESK-001](#hum-desk-001), [HUM-AGENDA-001](#hum-agenda-001) |
| `Q-OBJ-05` | [HUM-SURFACE-001](#hum-surface-001) |
| `Q-OBJ-06` | [HUM-CONV-001](#hum-conv-001) |
| `Q-OBJ-07` | [HUM-ANSWER-001](#hum-answer-001) |
| `Q-LIFE-04` | [HUM-DESK-001](#hum-desk-001) |
| `Q-RESTORE-02` | [HUM-DESK-001](#hum-desk-001) |
| `Q-RESTORE-04` | [HUM-DESK-001](#hum-desk-001), [HUM-SURFACE-001](#hum-surface-001) |
| `Q-RESTORE-05` | [HUM-DESK-001](#hum-desk-001) |
| `Q-AG-01` | [HUM-AGENDA-001](#hum-agenda-001) |
| `Q-AG-02` | [HUM-AGENDA-001](#hum-agenda-001) |
| `Q-AG-06` | [HUM-DESK-001](#hum-desk-001), [HUM-AGENDA-001](#hum-agenda-001) |
| `Q-AG-07` | [HUM-AGENDA-001](#hum-agenda-001) |
| `Q-AG-08` | [HUM-AGENDA-001](#hum-agenda-001) |
| `Q-AG-11` | [HUM-AGENDA-001](#hum-agenda-001) |
| `Q-AG-12` | [HUM-AGENDA-001](#hum-agenda-001) |
| `Q-AG-16` | [HUM-AGENDA-001](#hum-agenda-001) |
| `Q-VIEW-01` | [HUM-SURFACE-001](#hum-surface-001) |
| `Q-VIEW-05` | [HUM-SURFACE-001](#hum-surface-001) |
| `Q-VIEW-06` | [HUM-SURFACE-001](#hum-surface-001) |
| `Q-VIEW-07` | [HUM-SURFACE-001](#hum-surface-001) |
| `Q-DISC-01` | [HUM-SURFACE-001](#hum-surface-001) |
| `Q-CHAT-01` | [HUM-CONV-001](#hum-conv-001) |
| `Q-CHAT-03` | [HUM-CONV-001](#hum-conv-001) |
| `Q-AI-01` | [HUM-READ-001](#hum-read-001), [HUM-RUN-001](#hum-run-001) |
| `Q-AI-03` | [HUM-READ-001](#hum-read-001), [HUM-RUN-001](#hum-run-001) |
| `Q-AI-04` | [HUM-READ-001](#hum-read-001), [HUM-SNAPSHOT-001](#hum-snapshot-001), [HUM-RUN-001](#hum-run-001) |
| `Q-AI-05` | [HUM-RUN-001](#hum-run-001) |
| `Q-AI-06` | [HUM-CONV-001](#hum-conv-001) |
| `Q-AI-07` | [HUM-ENGINE-001](#hum-engine-001), [HUM-AGENT-001](#hum-agent-001), [HUM-RUN-001](#hum-run-001) |
| `Q-AI-08` | [HUM-RUN-001](#hum-run-001) |
| `Q-AI-09` | [HUM-RUN-001](#hum-run-001), [HUM-ORCH-001](#hum-orch-001) |
| `Q-MEDIA-01` | [HUM-ANSWER-001](#hum-answer-001) |
| `Q-MEDIA-03` | [HUM-ANSWER-001](#hum-answer-001) |
| `Q-MEDIA-04` | [HUM-BRIEF-001](#hum-brief-001) |
| `Q-MEDIA-05` | [HUM-BRIEF-001](#hum-brief-001) |
| `Q-MEDIA-06` | [HUM-SURFACE-001](#hum-surface-001), [HUM-BRIEF-001](#hum-brief-001) |
| `Q-MEDIA-08` | [HUM-BRIEF-001](#hum-brief-001) |
| `Q-MEDIA-10` | [HUM-BRIEF-001](#hum-brief-001) |
| `Q-ORCH-01` | [HUM-ORCH-001](#hum-orch-001) |
| `Q-ORCH-02` | [HUM-ORCH-001](#hum-orch-001) |
| `Q-ORCH-03` | [HUM-ORCH-001](#hum-orch-001) |
| `Q-ORCH-04` | [HUM-ORCH-001](#hum-orch-001) |
| `Q-ORCH-07` | [HUM-ORCH-001](#hum-orch-001) |
| `Q-AUTH-01` | [HUM-SURFACE-001](#hum-surface-001), [HUM-ENGINE-001](#hum-engine-001) |
| `Q-AUTH-04` | [HUM-SURFACE-001](#hum-surface-001), [HUM-SNAPSHOT-001](#hum-snapshot-001) |
| `Q-CODE-01` | [HUM-CODE-001](#hum-code-001) |
| `Q-CODE-03` | [HUM-CODE-001](#hum-code-001) |
| `Q-CODE-04` | [HUM-CODE-001](#hum-code-001) |
| `Q-TERM-01` | [HUM-SURFACE-001](#hum-surface-001), [HUM-CODE-001](#hum-code-001) |
| `Q-TERM-02` | [HUM-SURFACE-001](#hum-surface-001), [HUM-CODE-001](#hum-code-001) |
| `Q-ONT-01` | [HUM-GOV-001](#hum-gov-001) |
| `Q-ONT-02` | [HUM-GOV-001](#hum-gov-001) |
| `Q-ONT-03` | [HUM-GOV-001](#hum-gov-001) |
| `Q-COL-01` | [HUM-COLLAB-001](#hum-collab-001) |
| `Q-COL-02` | [HUM-COLLAB-001](#hum-collab-001) |
| `Q-COL-03` | [HUM-COLLAB-001](#hum-collab-001) |
| `Q-COL-04` | [HUM-COLLAB-001](#hum-collab-001) |
| `Q-COL-05` | [HUM-COLLAB-001](#hum-collab-001) |
| `Q-COL-06` | [HUM-COLLAB-001](#hum-collab-001) |
| `Q-CU-01` | [HUM-COLLAB-001](#hum-collab-001) |
| `Q-CU-02` | [HUM-COLLAB-001](#hum-collab-001) |
| `Q-CU-03` | [HUM-COLLAB-001](#hum-collab-001) |
| `Q-CU-04` | [HUM-COLLAB-001](#hum-collab-001), [HUM-REMOTE-001](#hum-remote-001) |
| `Q-CU-09` | [HUM-COLLAB-001](#hum-collab-001) |
| `Q-DATA-01` | [HUM-EXPORT-001](#hum-export-001) |
| `Q-DATA-02` | [HUM-EXPORT-001](#hum-export-001) |
| `Q-DATA-03` | [HUM-EXPORT-001](#hum-export-001) |
| `Q-DATA-04` | [HUM-SNAPSHOT-001](#hum-snapshot-001), [HUM-EXPORT-001](#hum-export-001) |
| `Q-DATA-05` | [HUM-EXPORT-001](#hum-export-001), [HUM-REMOTE-001](#hum-remote-001) |
| `Q-UX-01` | [HUM-A11Y-001](#hum-a11y-001) |
| `Q-AGENT-01` | [HUM-AGENT-001](#hum-agent-001), [HUM-RUN-001](#hum-run-001) |
| `Q-AGENT-02` | [HUM-AGENT-001](#hum-agent-001) |
| `Q-AGENT-03` | [HUM-ENGINE-001](#hum-engine-001), [HUM-RUN-001](#hum-run-001) |
| `Q-AGENT-05` | [HUM-RUN-001](#hum-run-001), [HUM-ORCH-001](#hum-orch-001) |
| `Q-AGENT-06` | [HUM-READ-001](#hum-read-001), [HUM-RUN-001](#hum-run-001) |
| `Q-AGENT-07` | [HUM-RUN-001](#hum-run-001), [HUM-EXPORT-001](#hum-export-001) |
| `Q-AGENT-08` | [HUM-ENGINE-001](#hum-engine-001), [HUM-RUN-001](#hum-run-001) |
| `Q-AGENT-09` | [HUM-RUN-001](#hum-run-001), [HUM-GOV-001](#hum-gov-001) |
| `Q-AGENT-10` | [HUM-RUN-001](#hum-run-001) |
| `Q-AGENT-11` | [HUM-SNAPSHOT-001](#hum-snapshot-001), [HUM-RUN-001](#hum-run-001), [HUM-EXPORT-001](#hum-export-001) |
| `Q-AGENT-12` | [HUM-ANSWER-001](#hum-answer-001), [HUM-RUN-001](#hum-run-001) |
| `Q-AGENT-13` | [HUM-RUN-001](#hum-run-001) |
| `Q-AGENT-14` | [HUM-RUN-001](#hum-run-001) |
| `Q-AGENT-15` | [HUM-RUN-001](#hum-run-001), [HUM-ORCH-001](#hum-orch-001) |
| `Q-AGENT-16` | [HUM-RUN-001](#hum-run-001) |
| `Q-AGENT-17` | [HUM-RUN-001](#hum-run-001) |
| `Q-AGENT-18` | [HUM-SNAPSHOT-001](#hum-snapshot-001), [HUM-RUN-001](#hum-run-001), [HUM-COLLAB-001](#hum-collab-001) |

<!-- OWNER-Q-HUM-MAP:END -->


Registry 합계는 `175 = OWNER-PRODUCT 90 + PM-RESEARCH 85`다. 모든 행의 초기 상태는 `OPEN`이며, proposal 제출이나 owner 응답이 생기기 전까지 임의로 닫지 않는다. 다만 `OWNER-PRODUCT` 행은 별도 사용자 질문 목록이 아니라 위 전수 매핑을 통해 0절의 `HUM-*` 아래에서만 사용자에게 제시한다.

## 9. owner decision batch 호환 색인 — D1–D10

`D1`–`D9`는 기준 Atlas의 기존 routing ID 집합을, `D10`은 Agent Profile·Run addition의
이력을 보존하는 호환 색인이다. 이 표는 0절과 별개의 두 번째 owner 질문 목록이
아니다. 실제 사용자 검토는 `HUM-*`로만 구성하고, batch는 관련 `Q-*` evidence packet을
준비하거나 과거 이력을 찾을 때만 사용한다.

| batch | exact owner question ID set | status |
|---|---|---|
| `D1` Desk 및 Agenda 객체 모델 | `Q-OBJ-01`–`Q-OBJ-04`, `Q-AG-01`, `Q-AG-02`, `Q-AG-06` | `COMPATIBILITY / OPEN VIA HUM` |
| `D2` 연속성 및 Agenda 수명주기 | `Q-LIFE-04`, `Q-RESTORE-02`, `Q-RESTORE-04`, `Q-RESTORE-05`, `Q-AG-07`, `Q-AG-08`, `Q-AG-11`, `Q-AG-12`, `Q-AG-16` | `COMPATIBILITY / OPEN VIA HUM` |
| `D3` 리소스, 탐색, 출처 및 Terminal | `Q-OBJ-05`, `Q-VIEW-01`, `Q-VIEW-05`–`Q-VIEW-07`, `Q-DISC-01`, `Q-AUTH-01`, `Q-AUTH-04`, `Q-TERM-01`, `Q-TERM-02` | `COMPATIBILITY / OPEN VIA HUM` |
| `D4` 인공지능 요청 및 대화 모델 | `Q-OBJ-06`, `Q-OBJ-07`, `Q-CHAT-01`, `Q-CHAT-03`, `Q-AI-01`, `Q-AI-03`–`Q-AI-09` | `COMPATIBILITY / OPEN VIA HUM` |
| `D5` Canvas 답변 미디어 및 Answer Briefing | `Q-MEDIA-01`, `Q-MEDIA-03`–`Q-MEDIA-06`, `Q-MEDIA-08`, `Q-MEDIA-10` | `COMPATIBILITY / OPEN VIA HUM` |
| `D6` 오케스트레이션 및 Ontology | `Q-ORCH-01`–`Q-ORCH-04`, `Q-ORCH-07`, `Q-ONT-01`–`Q-ONT-03` | `COMPATIBILITY / OPEN VIA HUM` |
| `D7` 사람 대상 코딩 | `Q-CODE-01`, `Q-CODE-03`, `Q-CODE-04` | `COMPATIBILITY / OPEN VIA HUM` |
| `D8` 협업 및 computer-use | `Q-COL-01`–`Q-COL-06`, `Q-CU-01`–`Q-CU-04`, `Q-CU-09` | `COMPATIBILITY / OPEN VIA HUM` |
| `D9` 데이터 및 접근성 | `Q-DATA-01`–`Q-DATA-05`, `Q-UX-01` | `COMPATIBILITY / OPEN VIA HUM` |
| `D10` Agent Profile·Run 모델 | `Q-AGENT-01`–`Q-AGENT-03`, `Q-AGENT-05`–`Q-AGENT-18` | `COMPATIBILITY / OPEN VIA HUM`; 준비 조사 `Q-AGENT-04`, `Q-AGENT-19`, `Q-AGENT-20` |

운영 규칙:

- PM은 각 `HUM-*`와 관련 batch/PM work group의 evidence-backed 선택지를 하나의 일관된 question packet으로 준비한다.
- Main만 `HUM-*` packet을 owner에게 route하고 응답을 연결된 각 `Q-*` ID에 반영한다. D batch를 별도 질문 묶음으로 중복 제시하지 않는다.
- owner가 즉시 응답하지 않아도 batch 전체나 독립 작업 전체를 멈추지 않는다. 결정에 실제로 종속된 설계·구현 분기만 대기한다.
- PM 제안이 준비되지 않았거나 owner가 침묵한 상태는 거부가 아니라 `OPEN`이다.

## 10. approval registry — exact 6 IDs

모든 승인 package는 PM이 근거·선택지·영향을 준비하고 Main이 최종 package, route, disposition을 소유하며 제품 owner가 승인·거부·보류한다. Registry에 있다는 사실은 승인 요청이 실제 제시되었거나 승인되었거나 실행되었다는 뜻이 아니다.

| approval ID | gate 정의 | decision package 필수 항목 | package ownership | status |
|---|---|---|---|---|
| `A-INFRA-01` | 원격 협업용 신원 체계, 서버, 네트워크, 데이터베이스 또는 동기화 provision | 선택지, provider/self-host 비교, 데이터 흐름, 역할, 보안, 비용, migration, 삭제 | PM 준비 → Main 최종 소유·route → owner 결정 | `APPROVAL / OPEN` |
| `A-INFRA-02` | Desk 외부 computer-use의 streaming·저장·원격 제어 권한 | 관찰·제어 범위, 동의, 개인정보, 보존, 전송, 격리, emergency stop | PM 준비 → Main 최종 소유·route → owner 결정 | `APPROVAL / OPEN` |
| `A-INFRA-03` | 다중 기기 sync 또는 원격 backup 활성화 | 데이터 세트, 충돌·offline 모델, identity, encryption, provider, 비용, migration, export/delete | PM 준비 → Main 최종 소유·route → owner 결정 | `APPROVAL / OPEN` |
| `A-AUTH-01` | 새 credential, 외부 계정, OAuth scope, API key 또는 provider identity 생성·연결·권한 부여 | 계정·provider, scope, 저장, 만료·철회, 데이터 접근, 대안, 종속 작업 | PM 준비 → Main 최종 소유·route → owner 결정 | `APPROVAL / OPEN` |
| `A-AUTH-02` | 구매, provision, 배포, 게시, domain 등록 또는 유료 외부 서비스 활성화 | provider·선택지, 반복·일회 비용, 배포 대상, 보안, rollback, 소유권, migration, 종속 작업 | PM 준비 → Main 최종 소유·route → owner 결정 | `APPROVAL / DEFINITION-ONLY`; gate 정의 유지 |
| `A-AUTH-03` | 민감 데이터 외부 전송 또는 위임 범위 밖의 실질적으로 새로운 외부 효과 | 데이터·효과·수신자, 목적, 최소화, 보존, 가역성, 완료 증거, 종속 작업 | PM 준비 → Main 최종 소유·route → owner 결정 | `APPROVAL / OPEN` |

`APPROVAL`은 실행 권한의 disposition일 뿐 실행 성공이 아니다. 승인 후에도 provider receipt, 외부 상태, 배포 대상 또는 독립 검증 등 해당 행동에 맞는 별도 완료 증거가 있어야 한다. 실패·알 수 없음·미실행은 승인 기록과 별도로 유지한다.

## 11. rejected / contamination ledger

| 항목 | disposition | 제외·제한 이유 | 재도입 조건 |
|---|---|---|---|
| `EXC-001` — `Workspace` | `REJECTED` product object | 결정 근거 없이 도입된 정의되지 않은 객체이며 Desk·Agenda 관계를 왜곡한다 | owner가 별도 객체 의미와 관계를 명시적으로 결정한 경우에만 새 disposition |
| `EXC-002` — `Host Activity View` canonical name | `REJECTED` canonical term | 이전 라운드에서 지어낸 객체명이다. Desk 외부 관찰은 기능 질문이지 이 이름의 객체가 아니다 | 기능·표면·정본 이름을 owner가 결정한 경우 |
| `EXC-003` — `Await Token` as orchestration | `REJECTED` orchestration model | 파일·사용자 event 대기는 한 dependency condition일 수 있지만 orchestration 자체는 dependency 완료와 후속 작업 시작이다 | condition primitive로만 근거를 붙여 제안 가능 |
| `EXC-004` — restore journal items / keep-discard restore items | `REJECTED` normal-start UI | 정상 실행은 실제 Desk를 복원해야 하며 임의의 복구 journal workflow를 먼저 열지 않는다 | 손상·부분 복구의 구체적 예외 흐름으로 owner 결정이 있을 때만 가능 |
| `EXC-005` — fixed Agenda schema | `REJECTED` inherited assumption | Agenda의 정확한 구성원·필수 필드·저장 범위는 `Q-AG-02`, `Q-AG-08`이 정한다. 직전 Contract snapshot의 objective/members/bindings/workflow/layout 열거는 정본 스키마가 아니다 | 두 질문의 owner disposition 뒤 Atlas·Contract를 함께 갱신할 때만 가능 |
| `EXC-006` — fixed `Agenda Thread` object | `REJECTED` inherited object | 필요한 것은 shared work conversation capability이며 최종 객체 형식·명칭은 `Q-OBJ-06`이 정한다 | `Q-OBJ-06` owner disposition이 해당 객체와 이름을 명시할 때만 가능 |
| `EXC-007` — `Main` as product participant or integration role | `REJECTED` situated-role transfer | Codex 문서 유지보수 역할인 Main을 EG-Desk 사용자·Agent·System 역할이나 공유 대화 참가자로 전사할 수 없다 | 제품 owner가 별도 제품 역할을 다른 정본 이름·권한으로 결정할 때만 가능 |
| result chip | `NON-OBJECT / AFF-001` | Chat–Canvas 탐색 affordance 후보일 수 있으나 지속되는 domain object나 결과 동일성은 아니다 | `AFF-001` UI affordance proposal로만 조사·제안 가능 |
| approval queue object | `NON-ASSUMPTION` | Main의 내부 승인 묶음 운영을 제품 사용자용 queue 객체로 전사하면 situated boundary를 위반한다 | `Q-ORCH-03` 계열 owner decision이 제품 표면과 객체성을 명시할 때만 가능 |

Negative audit은 위 용어가 문자열로 나타났는지만 보지 않고, 같은 가정이 다른 이름으로 제품 의미에 재도입되었는지도 검사한다.

## 12. external-reference reuse governance

원칙은 “이미 검증된 바퀴를 다시 만들지 않되, reference가 제품 의미를 결정하게 두지 않는다”이다. 기술 방식은 승인된 제품 결과와 risk boundary를 바꾸지 않는 범위에서 구현자가 유연하게 선택할 수 있다.

| 단계 | 책임 | 필수 산출물 |
|---|---|---|
| framing | PM | 해결할 제품 질문, 비교 기준, 필요한 primary evidence, 금지된 의미 도약 |
| local source map | WM | 현재 source와 local `references/` 위치, freshness, version drift, current-vs-reference 분류 |
| bounded research | researcher / worker | 공식 문서·표준·원저자 자료·활성 reference implementation의 한정된 evidence packet |
| product fit | PM | reuse 후보별 fit·trade-off·보존할 제품 경계·proposal; reference는 owner decision을 대신하지 않음 |
| routing | Main | PM packet을 owner decision, implementation, approval 또는 rejection 경로로 최종 route |
| technical method | implementation agent | 승인된 결과·권한·보안 경계 안에서 재사용·adapter·직접 구현 방법을 선택하고 검증 |

각 외부 reference record에는 최소한 다음을 남긴다.

- 정확한 이름, primary URL 또는 재현 가능한 local locator
- 조사 시점의 version·release·활동성 및 freshness
- license와 재배포·수정·상업 사용 조건
- 알려진 security posture, 취약점·권한·데이터 흐름
- Firefox shell 및 EG-Desk 제품 경계에 대한 fit
- 재사용 방식: direct, adapted, concept-only 또는 rejected
- 채택하지 않은 경우 rejection evidence와 이유

Reference가 널리 쓰인다는 사실, 현재 구현에 이미 있다는 사실, 화면이 유사하다는 사실은 제품 객체·명칭·행동을 확정하지 않는다.

### 12.1 공식 primary-reference matrix

**확인일**: 2026-08-04  
**공통 provenance**: `PRIMARY-REFERENCE`  
**공통 adoption status**: `RESEARCH-PATTERN`

아래 자료는 조사 패턴과 제약을 제공할 뿐 제품 결정을 내리지 않는다. `PRIMARY-REFERENCE`에서 관찰한 SDK·protocol의 타입, enum, 우선순위, session 또는 orchestration 방식은 `OWNER-DECISION` 없이 EG-Desk 제품 객체·scope·권한 규칙으로 승격할 수 없다.

| 공식 source | 확인된 research pattern | version / license / security record | EG-Desk fit와 금지된 전사 | related question IDs | provenance / adoption |
|---|---|---|---|---|---|
| [OpenAI Codex App Server](https://developers.openai.com/codex/app-server) | Rich client를 위한 인증·대화·승인·stream event protocol을 제공한다. ChatGPT managed browser login은 `authUrl`과 local callback을 사용하고, 완료 뒤 `account/updated`/`account/read`에서 auth mode·account·`planType`을 확인할 수 있으며 rate-limit read도 제공한다. | 2026-08-08 확인한 rolling 공식 문서. WebSocket listener는 공식 문서상 experimental/unsupported이므로 transport 선택은 구현 시 재검증한다. App Server source는 공식 open-source repository가 연결되어 있으나 이 문서 수정에서 code를 복사하지 않았다. | Codex Engine adapter 기준선으로 적합하다. 그러나 App Server의 현재 account 상태를 EG-Desk 다중 계정 registry, EG-Desk login identity 또는 Browser account로 전사하지 않는다. 계정별 runtime/config/credential 격리는 EG-Desk 선택 기준선이며 공식 protocol 자체의 다중-account 기능 주장으로 쓰지 않는다. | `HUM-ENGINE-001`, `Q-AUTH-03`, `Q-AGENT-04`, `Q-AGENT-08` | `PRIMARY-REFERENCE / SELECTED-BASELINE` |
| [OpenAI Agents SDK — Agents](https://openai.github.io/openai-agents-python/agents/) | SDK의 `Agent`는 LLM에 `name`, `instructions`, `model`, `tools`와 선택적 `handoffs`, `guardrails` 등을 결합한 재사용 가능한 정의다. tool을 노출해도 실제 사용은 별도 실행 동작이다. | Rolling docs URL로 page version은 고정되지 않음. 문서 패턴만 조사하며 code를 가져오지 않아 license에 의존하지 않는다. Guardrail은 입력·출력 검사 패턴이지 제품 권한의 대체물이 아니다. | 필드 분해는 Profile 후보 비교에 쓸 수 있지만 SDK `Agent`를 EG-Desk의 최종 제품 Agent 객체로 그대로 승격하지 않는다. | `Q-AGENT-01`, `Q-AGENT-03`–`Q-AGENT-06`, `Q-AGENT-10`, `Q-AI-07`–`Q-AI-09` | `PRIMARY-REFERENCE / RESEARCH-PATTERN` |
| [OpenAI Agents SDK — Running agents / RunConfig](https://openai.github.io/openai-agents-python/running_agents/) | 재사용 Agent definition과 한 run에 적용되는 `RunConfig` override를 구분한다. RunConfig는 model/provider/settings, guardrail·handoff 입력, tracing과 tool 실행 동작을 run 수준에서 바꿀 수 있어 effective configuration snapshot을 별도로 설계할 근거가 된다. | Rolling docs URL로 page version은 고정되지 않음. 문서 패턴만 조사하며 code를 가져오지 않는다. Trace는 민감한 LLM/tool input·output을 포함할 수 있어 별도 보안·보존 통제가 필요하다. | SDK override precedence는 구현 사례일 뿐 EG-Desk의 Profile·request·권한·Ontology scope 우선순위로 복제하지 않는다. 실제 유효 snapshot과 권한 교집합은 owner decision을 따른다. | `Q-AGENT-04`–`Q-AGENT-06`, `Q-AGENT-08`, `Q-AGENT-11`, `Q-AGENT-12`, `Q-AGENT-14`, `Q-AI-04`, `Q-AI-05`, `Q-AI-08` | `PRIMARY-REFERENCE / RESEARCH-PATTERN` |
| [MCP Specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28), [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) | Base protocol은 stateless·self-contained request와 per-request capability negotiation을 사용한다. `tools/list` 결과는 request에 제시된 authorization에 따라 달라질 수 있고, authorization은 매 HTTP request에서 검증된다. | Version은 `2026-07-28`로 고정. Protocol research만 하며 구현 code를 가져오지 않아 code license에 의존하지 않는다. Explicit consent, least privilege, token audience·expiry·scope validation과 401/403 경계를 보안 근거로 유지한다. | MCP는 integration protocol이지 Agent/Profile/Run 제품 모델이 아니다. Tool exposure 또는 list 포함은 권한 부여, 호출, 외부 효과나 성공 증거가 아니다. | `Q-AGENT-01`, `Q-AGENT-05`, `Q-AGENT-06`, `Q-AGENT-12`, `Q-AGENT-14`, `Q-AI-09`, `Q-AUTH-01`–`Q-AUTH-03` | `PRIMARY-REFERENCE / RESEARCH-PATTERN` |
| [OpenAI API — MCP and Connectors](https://developers.openai.com/api/docs/guides/tools-connectors-mcp) | MCP/connector request는 credential 값 또는 관리되는 credential binding/reference와 request-level authorization·tool approval를 결합해야 한다. Authorization value는 Response에 보존·노출되지 않으며 필요한 request에 다시 제공해야 한다. | Rolling API docs로 page version은 고정되지 않음. 예제 code는 가져오지 않는다. OAuth client registration은 application 책임이며 prompt injection, trusted server 선택, sensitive action approval이 명시적 보안 경계다. | Connector가 configured 상태라는 사실은 credential이 연결·유효하거나 request가 authorized·실행·성공했다는 뜻이 아니다. EG-Desk는 binding, authorization, approval, execution evidence를 분리한다. | `Q-AGENT-05`, `Q-AGENT-06`, `Q-AGENT-08`, `Q-AGENT-11`, `Q-AGENT-14`, `Q-AI-09`, `Q-AUTH-03`, `Q-AUTH-06` | `PRIMARY-REFERENCE / RESEARCH-PATTERN` |
| [Anthropic Agent SDK — Permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions) | Tool request는 hooks, deny, ask, permission mode, allow, callback 순서로 평가되는 패턴을 제공한다. Session은 prompt·tool call/result·response를 담은 conversation history이며 filesystem snapshot은 아니다; resume/fork와 file checkpoint는 별개다. | Rolling docs이며 일부 MCP user-interaction annotation은 Claude Code `v2.1.199+` 조건이 명시된다. 문서 패턴만 조사하며 code를 가져오지 않는다. Bypass/allow/deny·ask와 session 보존은 security·privacy 검토 대상이다. | Provider-specific permission mode, enum, evaluation order, continue/resume/fork semantics를 EG-Desk 제품 의미로 복제하지 않는다. 대화 지속성은 파일·Desk·runtime 복원 증거가 아니다. | `Q-AGENT-05`, `Q-AGENT-07`, `Q-AGENT-08`, `Q-AGENT-11`, `Q-AGENT-14`, `Q-AGENT-16`, `Q-AI-04`, `Q-AI-05`, `Q-AI-09`, `Q-AUTH-01` | `PRIMARY-REFERENCE / RESEARCH-PATTERN` |
| [OpenAI Agents SDK — handoff/context](https://openai.github.io/openai-agents-python/agents/), [Run tracing](https://openai.github.io/openai-agents-python/running_agents/) | Manager-as-tool은 중앙 Agent가 대화를 유지하며 specialist를 tool로 호출하는 방식이고, handoff는 specialist가 대화를 넘겨받는 별도 방식이다. Run context는 dependency/state 전달 수단이고 tracing은 run·tool·handoff 관찰 메타데이터다. | Rolling docs로 page version은 고정되지 않음. 문서 패턴만 조사하며 code를 가져오지 않는다. Context와 trace에는 민감 정보가 들어갈 수 있어 최소화·접근·보존 통제가 필요하다. | `handoff != manager-as-tool`; `trace != audit != evidence`. Trace 존재나 handoff 완료는 권한 판단, 독립 감사, 제품 결과 또는 외부 효과 성공을 인증하지 않는다. | `Q-AGENT-01`, `Q-AGENT-06`, `Q-AGENT-11`, `Q-AGENT-12`, `Q-AGENT-15`, `Q-AGENT-18`, `Q-AI-06`, `Q-AI-09`, `Q-AUTH-04` | `PRIMARY-REFERENCE / RESEARCH-PATTERN` |
| [W3C PROV-DM](https://www.w3.org/TR/prov-dm/) | provenance를 고정된 측면을 가진 entity, entity를 사용·생성하는 activity와 entity 사이 derivation으로 분리한다. 변하는 source 상태, 특정 시점의 Agent Observation Snapshot, 파생 Answer/Canvas 항목을 서로 다른 identity로 기록하는 참고가 된다. | 2013-04-30 W3C Recommendation, 2026-08-06 확인. 표준 개념만 조사하며 schema나 code를 가져오지 않는다. provenance 기록 자체의 접근·민감도·보존은 별도 정책이 필요하다. | Agent Observation Snapshot → Answer/Canvas derivation과 도구 호출 당시 source revision을 설명하는 concept-only pattern이다. W3C 타입·용어·전체 데이터 모델을 EG-Desk 정본 객체나 저장 schema로 복제하지 않는다. | `Q-AI-04`, `Q-MEDIA-01`, `Q-AGENT-18` | `PRIMARY-REFERENCE / CONCEPT-ONLY` |
| [Git Objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects) | 콘텐츠로 식별되는 object store와 동일 콘텐츠 재사용은 immutable snapshot integrity와 중복 제거의 참고 패턴을 제공한다. | 2026-08-06 확인한 rolling Git 공식 문서. 설명·개념만 조사하며 code를 가져오지 않는다. hash algorithm과 collision/security 요구는 실제 저장 설계에서 별도 결정한다. | snapshot ID·무결성·dedup을 위한 concept-only pattern이다. EG-Desk가 Git repository, Git object format 또는 특정 hash algorithm을 사용해야 한다는 뜻이 아니다. | `Q-AI-04`, `Q-DATA-01`, `Q-AGENT-18` | `PRIMARY-REFERENCE / CONCEPT-ONLY` |
| [Prezi Present — topic and subtopic path](https://support.prezi.com/hc/en-us/articles/360044277273-Setting-a-path-for-topics-and-subtopics-in-Prezi-Present), [structuring a presentation](https://support.prezi.com/hc/en-us/articles/360003498513-Structuring-in-Prezi-Present) | Canvas의 Frame·Topic을 Timeline 순서로 배열하고, step 사이에서 Overview로 돌아가거나 다음 target으로 직접 zoom하는 presentation path 패턴을 제공한다. | 2026-08-05 확인한 rolling 공식 도움말. 개념·상호작용 명칭만 조사하며 code/assets를 가져오지 않는다. 모션은 비시각적·reduced-motion 대안을 대신하지 않는다. | `Frame`, `Timeline`, `Path`는 Focus Scope·순서·viewport 전환을 설명하는 참고 패턴이다. Prezi 객체·명칭·저장 모델을 EG-Desk 제품 객체로 복제하지 않고, Agent Run 재생 근거로도 사용하지 않는다. | `Q-MEDIA-04`, `Q-MEDIA-09`, `Q-UX-03` | `PRIMARY-REFERENCE / CONCEPT-ONLY` |
| [Miro — Presentation mode](https://help.miro.com/hc/en-us/articles/34307373858450-Presentation-mode), [Frames](https://help.miro.com/hc/en-us/articles/360018261813-Frames) | Canvas Frame을 집중된 presentation mode에서 이전·다음 화살표로 이동하고, 공개 범위를 단계별로 조절하는 사용자 주도 탐색 패턴을 제공한다. | 2026-08-05 확인한 rolling 공식 도움말. 개념만 조사하며 code/assets를 가져오지 않는다. | `Presentation mode + Frames`는 브리핑 진입·Focus Scope·이전/다음 컨트롤의 참고다. Miro의 frame=slide 모델이나 협업 권한을 EG-Desk의 Answer Briefing 계약으로 그대로 전사하지 않는다. | `Q-MEDIA-04`, `Q-MEDIA-09`, `Q-MEDIA-10` | `PRIMARY-REFERENCE / CONCEPT-ONLY` |

## 13. audit checklist

| 검사 | worker draft 상태 | Main final 상태 |
|---|---|---|
| 기준 Atlas SHA-256과 Git `UNTRACKED` 상태 재확인 | `WORKER-PASS` | `PASS` |
| 기준 질문 154개 unique 및 canonical route 72/82 보존 | `WORKER-PASS` | `PASS` |
| addition 후 질문 175개 unique, route 90/85 | `MAIN-DRAFT-PASS` | `PASS` |
| 의도적으로 비어 있는 Agenda 숫자 gap에 새 ID가 없음 | `WORKER-PASS` | `PASS` |
| trace registry 43개 unique: 기존 39 + Smart Read/Engine 4 | `MAIN-WEAVE` | `PASS-ACTUAL` |
| approval registry exact 6개 및 definition-only gate 유지 | `WORKER-PASS` | `PASS` |
| `D1`–`D9` 기존 owner ID set 보존 및 `D10` 17개 | `MAIN-DRAFT-PASS` | `PASS` |
| `Q-*`/trace action body를 원장에 복제하지 않고 `HUM-*`만 정본 질문으로 소유 | `MAIN-WEAVE` | `PASS-ACTUAL` |
| raw prompt·CoT·credential·절대 로컬 경로 없음 | `WORKER-PASS` | `PASS` |
| explicit Atlas·Contract·HUM anchors가 실제 문서에 존재하고 모두 resolve | `MAIN-WEAVE` | `PASS-ACTUAL`; unresolved local link/fragment 0 |
| Atlas flow → Contract 기술 anchor와 Contract → Atlas 대표 flow가 양방향 resolve | `MAIN-WEAVE` | `PASS-ACTUAL`; 43 trace 모두 기술 링크 보유, 28개 기술 anchor 모두 Atlas에서 참조 |
| 모든 `HUM-*` 참조가 이 원장에 유일하게 존재하고 독립 작업·차단 범위를 기록 | `MAIN-WEAVE` | `PASS-ACTUAL`; 정의 18개 unique, owner-routed Q 90개 전수 매핑, 누락·추가·중복·미정의 0 |
| raw capture와 Agent 전달 payload를 보편적으로 동일시하는 문장 0개 | `MAIN-WEAVE` | `PASS-ACTUAL`; direct bounded read와 Smart Read를 분리해 검사 |
| 제품 runtime에 Codex 문서 역할 `Main` 또는 문서용 approval queue가 제품 객체·행위자로 누출되지 않음 | `MAIN-WEAVE` | `PASS-PM / PASS-ACTUAL`; 부정 경계 문장만 유지, runtime 누출 0 |
| 여러 Run·Task·Agent contribution·Result에서 논리적 Answer revision을 만들고 Agent/integration 제안·System 검증·사용자 override 권한을 분리 | `MAIN-WEAVE` | `PASS-PM / PASS-ACTUAL`; Atlas·Contract·HUM-ANSWER 정합 |
| 기술 Contract 본문이 한국어 독자용 정본이며 기술 식별자·API명만 원형을 보존 | `MAIN-WEAVE` | `PASS-ACTUAL`; 장문 영문 설명 0, 명시 anchor와 의미 보존 |
| contamination negative audit와 external-reference evidence 완결 | `WORKER-EDITORIAL-PASS` | `PASS-PM` |
| final target rewrite 후 hash·line/row count·Git diff 재검증 | `NOT-APPLICABLE-DRAFT` | `PASS-ACTUAL`; 세 정본과 `project-context.md`의 정본 역할 선언만 task scope, 정본 3개 `UNTRACKED`, staging 없음 |

## 14. event history

| event ID | 일자 | actor | 사건 | provenance / evidence | status |
|---|---|---|---|---|---|
| `ATL-ED-0001` | 2026-08-04 | worker | 기준 Atlas snapshot, clean-room boundary 및 기존 inventory 등록 | source SHA-256, Git state, Atlas/프로젝트 context | `RECORDED` |
| `ATL-ED-0002` | 2026-08-04 | worker | provenance·route migration과 154개 기존 질문 routing metadata 초안 등록 | 기준 Atlas question registry와 `D1`–`D9` | `DRAFT-RECORDED` |
| `ATL-ED-0003` | 2026-08-04 | worker | Agent Profile·Run trace 3개, 질문 14개, `D10` candidate 등록 | Agent addition fragment | `DRAFT-RECORDED` |
| `ATL-ED-0004` | 2026-08-04 | worker | 공식 primary-reference 6행 matrix와 제품 의미 전사 금지 경계 등록 | OpenAI Agents SDK/API, MCP 2026-07-28, Anthropic Agent SDK 공식 문서 | `DRAFT-RECORDED` |
| `ATL-ED-0005` | 2026-08-04 | worker | draft mechanical·editorial audit와 row count 기록 | 499 lines; 질문 168, trace 38, approval 6, source boundary 6, reference matrix 6 | `RECORDED` |
| `ATL-ED-0006` | 2026-08-04 | Main | 객체 모델이 드러낸 추가 질문 6개와 누락된 경계 장애 trace를 축약하지 않고 candidate에 정식 편입 | 질문 174, trace 39, action row 140, route 89/85 | `DRAFT-RECORDED` |
| `ATL-ED-0007` | 2026-08-04 | PM / Main | 두 차례 의미 감사의 REVISE 항목을 반영해 Agenda·공유 대화 drift, maintainer contamination, 양방향 Chat–Canvas 복구, local computer-use 관찰, Agent effective Run binding, Task 8상태와 175번째 질문을 정합화 | PM audit 결과, Contract §14, 질문 175, trace 39, action row 144, route 90/85, candidate validator PASS | `REVIEWED / CORRECTED` |
| `ATL-ED-0008` | 2026-08-04 | Main | Atlas와 원장을 정본 경로에 설치하고 Contract §14·세 문서 역링크·explicit anchors를 반영 | Atlas·ledger candidate와 actual byte equality, PM final `PASS` | `RECORDED` |
| `ATL-ED-0009` | 2026-08-04 | Main | final ID·route·anchor·contamination·link·Git scope audit 완료 | trace 39, action row 144, question 175, route 90/85, approval 6, anchor 274, map 20, unresolved link 0, Atlas SHA `142e1f890bbe1ed3144f0f0aba59c2388fd227170f46037b2a5003d8a94270e5`, Contract SHA `d05d7976b047b95cbad6e717bb34fdfe0fc27f58de1a30e44c77c21f8587a6e3`; 세 정본 파일 `UNTRACKED`, staging 없음 | `PASS` |
| `ATL-ED-0010` | 2026-08-05 | owner input / PM / WM / Main | Atlas를 같은 정본 경로에서 manual-first 구조로 재배열하고, ASCII 화면 관계·입력 표기법·첫 실행부터 재실행까지 11단계 한 바퀴를 추가했으며 기존 ID·질문·승인 집합을 보존 | owner의 사용설명서 우선 요구, WM route advice, Prezi·Miro 공식 reference pattern, Atlas section 0–1 | `RECORDED` |
| `ATL-ED-0011` | 2026-08-05 | PM / Main | legacy `Playback`을 Answer Briefing 후보명으로 바로잡고 Agent/System/제품 사용자 책임, Briefing Step·Focus Scope·Comment, 수동 화면 전환과 one-Answer projection을 정합화 | Contract §4·§8, Atlas `OBJ-038`–`OBJ-040`, `AI-05`, `Q-MEDIA-04`·`Q-MEDIA-09`; PM P1 5건 수정 후 재감사 `PASS`; actual validator `PASS` | `REVIEWED / PASS` |
| `ATL-ED-0012` | 2026-08-06 | owner input / PM / WM / Main | logical binding만으로 나중의 Canvas 내용을 재구성하던 공백을 수정해 mutable source, Tool Result Snapshot, inference별 Agent Input Snapshot, versioned Canvas projection을 분리하고 완료 활동의 기본 historical view·현재 상태·diff·runtime handoff evidence·provider 비관찰 경계를 정합화 | owner fidelity 피드백, PM 의미 감사와 final `PASS`, WM source plan, W3C PROV-DM·Git Objects 공식 reference pattern, Contract §4.1, Atlas `M5-F`·`AI-01`·`AI-04`·`OBJ-052`·불변조건 32–33; actual validator `PASS` | `REVIEWED / PASS` |
| `ATL-ED-0013` | 2026-08-06 | owner input / Main | 도구가 40–80행을 반환했는데 Agent가 40–58행만 받는다는 잘못된 예를 폐기하고 정상 도구 결과와 Agent Observation Snapshot의 일대일 계약, Canvas의 Snapshot View/Live View 공존, Answer Briefing의 역사적 snapshot 사용으로 단순화했다. provider 내부 동작 설명은 제품 문서에서 제거했다 | owner 정정, Contract §4.1, Atlas `M5-F`·`AI-01`·`AI-04`·`OBJ-024`·`OBJ-052`·불변조건 32–33; candidate·actual validator `PASS` | `CORRECTED / SUPERSEDES ATL-ED-0012 SEMANTICS` |
| `ATL-ED-0014` | 2026-08-08 | owner input / PM / WM / Main | Atlas를 사용자의 클릭·타이핑·키보드·보이는 반응을 추적하는 UI/UX 정본으로, Contract를 구현 원리·기술 기준선의 정본으로 분리하고 서로의 섹션을 양방향 연결했다. Smart Read·Reader Session·별도 AI Engine 계정·snapshot 보존·SQLite/CAS·단일 `.egdesk` 반출입 흐름을 교차 설계했으며, owner만 답할 수 있는 gap은 12개 `HUM-*` 질문으로 이 원장 앞부분에 분리했다 | 실제 validator: trace 43, action row 157, object 56, tech anchor 28, HUM 12, unresolved local link/fragment 0. `ATL-ED-0013`의 보편적 일대일 의미는 direct bounded read에만 한정하고 Smart Read의 raw capture → Reader packet → Main context lineage로 대체 | `REVIEWED / PASS-ACTUAL / SUPERSEDES ATL-ED-0013 UNIVERSALITY` |
| `ATL-ED-0015` | 2026-08-08 | Main | 기술 Contract의 기존 영문 제목·설명·상태 전이 본문을 한국어 독자용으로 전환했다. API·protocol·schema·제품 식별자는 원형을 유지하고 anchor·상호 참조·기술 의미는 바꾸지 않았다 | Contract 전체 장문 영문 설명 검사 0, actual validator 재실행으로 28개 기술 anchor 및 문서 fragment 보존 확인 | `LOCALIZED / PASS-ACTUAL` |
| `ATL-ED-0016` | 2026-08-08 | PM / Main | UI/UX↔기술 weave 최종 의미 감사에서 발견된 제품 runtime의 `Main` 용어, 90개 owner 쟁점과 18개 `HUM-*`의 전수 연결, 다중 기여에서 논리적 Answer를 만드는 권한 경계를 정합화했다. `ATL-ED-0014`의 `12개 HUM`과 `Main context` 표현은 각각 18개 정본 질문과 요청 담당 Agent context로 대체한다 | actual validator: trace 43, action row 157, object 56, tech anchor 28, HUM 18, OWNER-PRODUCT Q→HUM 90/90, unresolved local link/fragment 0, runtime `Main`·recovery queue 누출 0; Atlas SHA `d8145f03fe20f6948d004f2b8950f1df2c68a2d819aea14b6bff3c255463c4dd`, Contract SHA `722c5195aa7bad41616cf9750c046dbe61c8318f29efb5135166856dae6677a3`; PM 최종 재감사 `PASS`, P0/P1 0 | `REVIEWED / PASS-ACTUAL / SUPERSEDES ATL-ED-0014 COUNTS AND RUNTIME ROLE` |

이력 행은 append-only다. 수정이 필요하면 기존 사건을 덮어쓰지 않고 다음 `ATL-ED-*` 행에서 정정·대체 관계를 남긴다.
