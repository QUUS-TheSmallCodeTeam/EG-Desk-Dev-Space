# EG-Desk 설계 Gap 및 사용자 확인 원장

**문서 역할**: 제품 소유자만 결정할 수 있는 미확정 제품 의미·기본 동작·권한 경계를 질문 단위로 제시한다.
**사용자 매뉴얼**: [EG-Desk 가상 사용설명서와 제품 상호작용 Atlas](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-manual-start)
**기술 계약**: [EG-Desk 기술 구현·상호작용·오케스트레이션 계약](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-contract-top)
**관련 운영 문서**: [EG-Desk 제품 문서 화자·운영 정본](./egdesk-product-documentation-governance.md#doc-governance-top)

<a id="gap-owner-queue"></a>

## 0. 제품 소유자 확인 목록

이 목록에는 제품 의미와 사용자 경험을 바꾸기 때문에 제품 소유자의 결정이 필요한 항목만 있다.
결정되지 않은 항목은 연결된 범위만 `OPEN`으로 남으며, 각 항목의 `계속 가능한 작업`은
해당 결정을 기다리지 않고 진행할 수 있다.

`HUM-*`는 제품 의미·기본 수명주기·권한처럼 제품 소유자만 결정할 항목이다.
세부 레이블·위치·키보드·재시도 표현처럼 조사와 구현 검증으로 좁힐 수 있는 항목은
[제품 문서 화자·운영 정본의 `Q-*` 색인](./egdesk-product-documentation-governance.md#doc-question-registry)에서 관리한다.

| 상태 | 의미 |
|---|---|
| `OPEN` | 선택지가 남았으며 어느 쪽도 확정 동작처럼 쓰지 않는다 |
| `PROPOSED` | 근거와 trade-off가 있는 기본안이 있으나 제품 소유자 결정 전이다 |
| `DECIDED` | 제품 소유자의 결정 출처와 반영된 Atlas·Contract 위치가 있다 |
| `SUPERSEDED` | 더 최신 결정이 있으며 이전 결정 이력을 삭제하지 않는다 |

### 0.1 현재 확인이 필요한 제품 결정

<a id="hum-desk-001"></a>
#### HUM-DESK-001 — Desk 수와 Agenda 열기 결과

- **질문**: EG-Desk가 한 번에 여러 독립 Desk를 가질 수 있는가? Saved Agenda 행을 열 때 현재 Desk의 자동 복원 뷰를 `교체`, `현재 Desk에 합성`, 또는 `별도 Desk로 열기` 중 무엇으로 처리하는가?
- **결정**: 기본 제품 모델은 **하나의 Desk와 그 Desk에 속한 하나의 Canvas**다. 여러 Saved Agenda는 Sidebar에서 선택해 같은 Canvas에 서로 독립된 projection으로 동시에 열 수 있다. Agenda를 연다고 기존 Canvas 내용을 교체하거나 별도 Desk를 만들지 않는다. 다중 Desk는 메모리 최적화 수단으로 도입하지 않는다.
- **결정 출처**: 제품 소유자 대화 결정, 2026-08-25–2026-08-30.
- **왜 사용자 결정인가**: navigation·저장·복원 객체 수명주기가 달라진다.
- **영향**: [Atlas AG-02](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ag-02), [Contract §1](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-desk-lifecycle)
- **계속 가능한 작업**: Agenda projection의 정확한 초기 위치·겹침 회피·활성 표시와 이미 열린 Agenda 재선택 동작은 세부 UI 질문으로 계속 설계한다.
- **상태**: `DECIDED`

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
- **확정된 부분**: Desk당 Canvas는 하나다. 사용자나 Agent의 의미 있는 활성 작업, sleeping 상태, historical snapshot은 Canvas에서 찾을 수 있는 표현을 가져야 한다. Canvas viewport 밖이라는 이유만으로 자동 종료하지 않으며, lifecycle은 Agenda 단위가 아니라 각 view와 그 runtime 단위로 판단한다. 무거운 renderer는 분리할 수 있지만 Canvas에는 가벼운 node·상태·snapshot 중 알맞은 표현이 남는다. Agenda를 닫으면 그 projection과 해당 Agenda만 소유한 runtime은 종료하고 Saved Agenda는 보존한다. File view 재진입에서는 scroll·보이는 위치를 복원할 수 있지만 active caret, keyboard focus, transient text selection은 복원하지 않는다.
- **왜 사용자 결정인가**: 단순한 레이블을 넘어 사용자가 리소스를 찾고 화면을 조직하고 닫을 때 무엇이 남는지 이해하는 전체 mental model을 바꾼다.
- **영향**: [Atlas V-01–03](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-v-01), [DISC-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-disc-01), [CODE-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-code-01), [TERM-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-term-01), [Contract §4.1](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-observation-fidelity), [§6–7](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-coding-surface)
- **계속 가능한 작업**: 활성 view의 최종 명칭, Library·file tree·search 진입 구조, 개별 view 닫기와 공유 runtime의 세부 UI, renderer별 sleep 기준과 Terminal의 선택적 진입을 계속 설계한다.
- **상태**: `OPEN`

<a id="hum-conv-001"></a>
#### HUM-CONV-001 — Agent 담당자 방, 공유 대화와 Agenda 관계

- **질문**: Agent/persona별 담당자 방 안에서 여러 업무·기록을 어떻게 구분하고, 여러 사람·Agent가 참여하는 공유 workroom·대화를 어떤 객체 관계로 제공하며, Agenda와 기본적으로 연결되는 범위는 무엇인가?
- **확정된 부분**: 사람에게 보이는 기본 Chat 관계는 **Agent/persona별 담당자 방**이다. Agent Profile은 방의 상대 정체성이지만 실제 Run이나 모델 context와 동일하지 않다. Canvas Memo는 위치에 고정된 짧은 메모와 작성자별 짧은 답글을 제공하며, Agent가 사용자의 메모 본문을 고쳐 쓰거나 자동으로 긴 대화로 승격하지 않는다. 짧은 답만으로 오해할 위험이 있거나 정보가 부족하면 Agent는 메모 참조를 포함한 메시지·mention을 관련 Agent 방에 먼저 만들 수 있지만 사용자의 Canvas focus를 빼앗지 않는다.
- **왜 사용자 결정인가**: 개인정보, 공유 범위, 재진입 위치와 협업 mental model을 바꾼다.
- **영향**: [Atlas CHAT-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-chat-01), [AI-03](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-03), [CANVAS-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-canvas-01), [Contract §4](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-answer-projection), [§5](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-multi-agent-chat)
- **계속 가능한 작업**: 같은 Agent 방 안에서 여러 업무를 구분하는 방식, Agent끼리 위임한 대화와 진행 상태를 보여 주는 workroom/supervision 화면, 공유 대화의 객체·참여자·Agenda 관계와 정확한 시각 디자인은 계속 설계한다. Chat 안의 업무 상태는 말로만 복제하지 않고 Canvas의 정본 상태를 가리키는 가벼운 표현으로 제공하되 정확한 형태는 미결정이다.
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

<a id="gap-maintenance-appendix"></a>

내부 문서 운영 기록은
[EG-Desk 제품 문서 화자·운영 정본](./egdesk-product-documentation-governance.md#doc-governance-top)에서 관리한다.
