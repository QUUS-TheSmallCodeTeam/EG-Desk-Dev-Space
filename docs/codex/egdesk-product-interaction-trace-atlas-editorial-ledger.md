# EG-Desk 설계 Gap 및 사용자 확인 원장

**문서 목차**: [읽는 목적별 안내](../README.md#docs-start) · **대안 비교**: [정책 추천안](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-policy-options)

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

질문·결정·현재 상태는 이 원장에 있다. 추천·대안·영향은
[UI 추천안의 정책 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-policy-options),
질문이 나온 상황은 [니즈 점검 기록](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-review)에서 확인한다.
정책 비교의 7묶음은 읽기 위한 분류이며, 이 원장의 질문을 대체하거나 일괄 승인하지 않는다.

아래 `질문`은 남은 제품 선택을 뜻한다. 확정된 방향, 그 방향을 구현할 데이터 구조,
버튼 배치·입력·일반 복구 방법까지 다시 결정받지는 않는다. 7묶음을 한꺼번에 답할
필요는 없으며, 접근성의 출시 지원 약속과 실제 원격 인프라 승인은 구체적인 지원표·
구성·비용을 비교할 수 있을 때 검토한다.

| 상태 | 의미 |
|---|---|
| `OPEN` | 선택지가 남았으며 어느 쪽도 확정 동작처럼 쓰지 않는다 |
| `PROPOSED` | 근거와 trade-off가 있는 기본안이 있으나 제품 소유자 결정 전이다 |
| `DECIDED` | 제품 소유자의 결정 출처와 반영된 Atlas·Contract 위치가 있다 |
| `SUPERSEDED` | 더 최신 결정이 있으며 이전 결정 이력을 삭제하지 않는다 |

### 0.1 결정된 경계와 남은 제품 선택

<a id="hum-desk-001"></a>
#### HUM-DESK-001 — Desk 수와 Agenda 열기 결과

- **질문**: EG-Desk가 한 번에 여러 독립 Desk를 가질 수 있는가? Saved Agenda 행을 열 때 현재 Desk의 자동 복원 뷰를 `교체`, `현재 Desk에 합성`, 또는 `별도 Desk로 열기` 중 무엇으로 처리하는가?
- **결정**: 기본 제품 모델은 **하나의 Desk와 그 Desk에 속한 하나의 Canvas**다. 여러 Saved Agenda는 Sidebar에서 선택해 같은 Canvas에 서로 독립된 projection으로 동시에 열 수 있다. Agenda를 연다고 기존 Canvas 내용을 교체하거나 별도 Desk를 만들지 않는다. 다중 Desk는 메모리 최적화 수단으로 도입하지 않는다. 이 화면 관계는 물리 PC 한 대의 제한이 아니다. Canvas 기반 Agenda는 여러 PC의 자료·실행 자원을 연결하며 폴더 하나로 한정되지 않는다.
- **결정 출처**: 제품 소유자 대화 결정, 2026-08-25–2026-08-30; 다중 PC·Canvas 기반 Agenda 방향 재확인, 2026-09-08.
- **왜 사용자 결정인가**: navigation·저장·복원 객체 수명주기가 달라진다.
- **영향**: [Atlas AG-02](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ag-02), [Contract §1](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-desk-lifecycle)
- **계속 가능한 작업**: Agenda projection의 정확한 초기 위치·겹침 회피·활성 표시와 이미 열린 Agenda 재선택 동작은 세부 UI 질문으로 계속 설계한다.
- **상태**: `DECIDED`

<a id="hum-agenda-001"></a>
#### HUM-AGENDA-001 — Agenda 저장 내용과 revision 수명주기

- **추천·대안**: [Agenda 저장·공유 실행·닫기 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-agenda), [저장된 Agenda 삭제·복구 흐름](../references/design-synthesis/egdesk-ux-realization-proposals.md#agenda-delete-recover)
- **질문**: Agenda에 기본으로 저장되는 범위를 무엇으로 하고, `업데이트`, `다른 이름으로 저장`, revision 충돌, 삭제·복구를 사용자가 어떤 의미로 이해해야 하는가?
- **삭제에서 남은 선택**: Saved Agenda 자체를 휴지통에 보존할지, 보관 기한과 복구 범위를 어디까지 둘지다. 닫을 때의 예약 pause/삭제와는 독립된 선택이며, 저장본 복구가 과거 권한·실행·예약의 자동 복원을 뜻하지 않는다.
- **관련 후보**: [저장 시점·현재 원본·동일 resource 재사용](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-agenda-save). 미저장 편집이 있는 Agenda를 닫을 때 무엇을 복구 기록에 남길지도 함께 정한다.
- **왜 사용자 결정인가**: 자동 Desk 세션과 명시적 저장의 경계를 바꾼다.
- **영향**: [Atlas AG-01–04](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ag-01), [Contract §1](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-desk-lifecycle)
- **계속 가능한 작업**: 저장 범위 미리보기, revision 기술 모델, undo 가능한 prototype.
- **상태**: `OPEN`

<a id="hum-surface-001"></a>
#### HUM-SURFACE-001 — Desk·Canvas·View·Library·Terminal의 사람용 화면 모델

- **추천·대안**: [조작면 관찰·집중 보기](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-surface), [Agenda와 실행 소유권](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-agenda), [Library·그룹·live 재사용](../references/design-synthesis/egdesk-ux-realization-proposals.md#library-groups)
- **질문**: 여러 Agenda가 같은 자료·실행을 참조할 때 동일한 live instance를 기본으로 재사용할 것인가, 독립된 작업 사본을 만들 것인가? 공유 실행의 소유와 보관 범위는 [Agenda 정책](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-agenda)에서 함께 선택한다.
- **같은 범위에서 남은 선택**: Library를 독립적인 재사용 영역으로 제공할지와 포함 대상, 임시 그룹의 지속·중첩·Agenda 구성원 관계는 남은 제품 선택이다. 명칭·진입점·조작 배치는 계속 설계한다.
- **관련 후보**: [shared runtime 닫기](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-shared-lifecycle), [Canvas 밀도·보존](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-canvas-density), [집중 보기·zoom·resize](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-view-transform), [업로드·OS 승인 설명](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-native-ui).
- **확정된 부분**: Desk당 Canvas는 하나다. 사용자나 Agent의 의미 있는 활성 작업, sleeping 상태, historical snapshot은 Canvas에서 찾을 수 있는 표현을 가져야 한다. Canvas viewport 밖이라는 이유만으로 자동 종료하지 않으며, lifecycle은 Agenda 단위가 아니라 각 view와 그 runtime 단위로 판단한다. 무거운 renderer는 분리할 수 있지만 Canvas에는 가벼운 node·상태·snapshot 중 알맞은 표현이 남는다. Agenda를 닫으면 그 projection과 해당 Agenda만 소유한 runtime은 종료하고 Saved Agenda는 보존한다. File view 재진입에서는 scroll·보이는 위치를 복원할 수 있지만 active caret, keyboard focus, transient text selection은 복원하지 않는다.
- **왜 사용자 결정인가**: 단순한 레이블을 넘어 사용자가 리소스를 찾고 화면을 조직하고 닫을 때 무엇이 남는지 이해하는 전체 mental model을 바꾼다.
- **영향**: [Atlas V-01–03](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-v-01), [DISC-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-disc-01), [CODE-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-code-01), [TERM-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-term-01), [Contract §4.1](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-observation-fidelity), [§6–7](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-coding-surface)
- **계속 가능한 작업**: 활성 view의 최종 명칭, Library·file tree·search 진입 구조, 개별 view 닫기와 공유 runtime의 세부 UI, renderer별 sleep 기준과 Terminal의 선택적 진입을 계속 설계한다.
- **상태**: `OPEN`

<a id="hum-conv-001"></a>
#### HUM-CONV-001 — Agent 담당자 방, 공유 대화와 Agenda 관계

- **추천·대안**: [담당자 방·업무 귀속·Memo 응답 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-chat)
- **질문**: 작성기에 연결한 업무를 다음 지시에서도 기본으로 유지할 것인가? 담당자 방·공유 대화와 Agenda를 기본으로 연결·공개할 범위, Memo 응답·후속 연락의 기본 조건은 어디까지인가?
- **관련 후보**: [추가 지시의 업무 대상](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-conversation-target), [실제 참여자·위임 대화](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-participants), [Memo의 먼저 말 걸기·중복·종료](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-memo-initiation).
- **확정된 부분**: 사람에게 보이는 기본 Chat 관계는 **Agent/persona별 담당자 방**이다. Agent Profile은 방의 상대 정체성이지만 실제 Run이나 모델 context와 동일하지 않다. Canvas Memo는 위치에 고정된 짧은 메모와 작성자별 짧은 답글을 제공하며, Agent가 사용자의 메모 본문을 고쳐 쓰거나 자동으로 긴 대화로 승격하지 않는다. 짧은 답만으로 오해할 위험이 있거나 정보가 부족하면 Agent는 메모 참조를 포함한 메시지·mention을 관련 Agent 방에 먼저 만들 수 있지만 사용자의 Canvas focus를 빼앗지 않는다.
- **왜 사용자 결정인가**: 개인정보, 공유 범위, 재진입 위치와 협업 mental model을 바꾼다.
- **영향**: [Atlas CHAT-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-chat-01), [AI-03](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-03), [CANVAS-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-canvas-01), [Contract §4](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-answer-projection), [§5](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-multi-agent-chat)
- **계속 가능한 작업**: 같은 Agent 방 안에서 여러 업무를 구분하는 방식, Agent끼리 위임한 대화와 진행 상태를 보여 주는 workroom/supervision 화면, 공유 대화의 객체·참여자·Agenda 관계와 정확한 시각 디자인은 계속 설계한다. Chat 안의 업무 상태는 말로만 복제하지 않고 Canvas의 정본 상태를 가리키는 가벼운 표현으로 제공하되 정확한 형태는 미결정이다.
- **상태**: `OPEN`

<a id="hum-answer-001"></a>
#### HUM-ANSWER-001 — 요청·Result·논리적 Answer·Chat/Canvas 표현의 관계

- **추천·대안**: [근거·결과 편집·설명 갱신 흐름](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-answer)
- **질문**: Agent가 구성한 답변의 Chat·Canvas 표현을 사용자가 어디까지 재구성·편집할 수 있는가? 설명 편집은 `HUM-BRIEF-001`, 보존·공유 범위는 `HUM-SNAPSHOT-001`·`HUM-EXPORT-001`의 같은 선택에 연결한다.
- **확정된 부분**: 요청·Run·Task·기여·Result·artifact·Answer는 같은 객체가 아니다. 하나의 논리적 Answer를 Chat과 Canvas에서 매체에 맞게 표현하며, 화면 탐색만으로 새 분석을 실행하지 않는다. 이 동일성과 귀속을 보장하는 구조는 기술 계약에 따라 구체화한다.
- **관련 후보**: [활동 관찰과 과거 근거](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-activity-navigation), [결과 편집·주석·Briefing revision](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-briefing-edit).
- **왜 사용자 결정인가**: 무엇이 최종 답변이고 무엇이 기여·산출물·표현인지, 수정·삭제·공유·재진입 시 어떤 결과를 정본으로 보는지가 달라진다.
- **영향**: [Atlas AI-04](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-04), [Contract §4](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-answer-projection), [§11](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-parallel-agents)
- **계속 가능한 작업**: 하나의 논리적 Answer revision이 여러 기여·Result·artifact를 종합하고 Chat/Canvas가 같은 Answer를 매체별로 표현하는 계약.
- **상태**: `OPEN`

<a id="hum-brief-001"></a>
#### HUM-BRIEF-001 — 답변 브리핑 명칭과 편집·지속·공유 권한

- **추천·대안**: [Briefing 편집·보존 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-retention)
- **질문**: 답변 브리핑을 읽기 전용 설명으로 제공할 것인가, 사용자가 단계 순서·대상·설명을 편집해 재사용할 수 있게 할 것인가? 저장·공유는 근거 보존·반출 정책의 같은 범위를 따른다.
- **왜 사용자 결정인가**: 단순 presentation과 재사용 가능한 산출물 사이의 수명주기를 결정한다.
- **영향**: [Atlas AI-05](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-05), [Contract §8](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-answer-briefing)
- **계속 가능한 작업**: 사용자 입력으로 이전/다음/전체 보기, 단계 이동이 새 Run이 아니라는 계약, 진입 레이블과 편집·원본 복귀 UI 비교. 명칭·control 비교를 별도 승인 질문으로 늘리지 않는다.
- **상태**: `OPEN`

<a id="hum-read-001"></a>
#### HUM-READ-001 — Smart Read 가시성과 사용자 개입 시점

- **추천·대안**: [자료 읽기·상세 확인·범위 조정](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-reading)
- **질문**: 기본 읽기 화면에서 범위·판독 상태와 Reader 상세를 어느 깊이까지 먼저 보여 줄 것인가? 전체 읽기 예산의 기본값은 첫 사용·실행 계정 정책과 함께 선택한다.
- **확정된 부분**: 읽기 범위 조정, 원문 coverage 검사, 자동 admission·Reader 전환과 허용된 복구는 설계·검증을 계속한다. 실제로 필요한 비밀번호·권한·대체 원본만 해당 작업과 연결해 요청하며 일반 읽기를 매번 승인받지 않는다.
- **왜 사용자 결정인가**: 단순한 Chat 경험과 고급 검사·제어 사이의 기본 복잡도를 바꾼다.
- **영향**: [Atlas READ-01–03](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-read-01), [Contract §2.1–2.4](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-smart-read)
- **계속 가능한 작업**: automatic admission, resumable Reader, source coverage와 recovery 기술 구현.
- **상태**: `OPEN`

<a id="hum-snapshot-001"></a>
#### HUM-SNAPSHOT-001 — Snapshot 기본 표시·보존·redaction

- **추천·대안**: [근거 보존·삭제·철회 정책 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-retention)
- **질문**: Snapshot 보존을 참조·사용자 고정 중심으로 할 것인가, 기간 중심으로 할 것인가? 원 권한 철회 뒤 과거 사본의 열람·삭제와 가림 처리 범위는 어디까지인가? 내보내기는 `HUM-EXPORT-001`에서 같은 정책으로 결정한다.
- **관련 후보**: [진행 중 활동의 Live/Snapshot 기본값](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-activity-navigation), [원본·Reader packet·파생 요약의 삭제·공유 철회](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-retention).
- **왜 사용자 결정인가**: 투명성, 개인정보, 로컬 저장량과 과거 답변 재현성의 trade-off다.
- **영향**: [Atlas M5-F](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-m5-f), [Contract §4.1](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-observation-fidelity), [§15](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-storage-export)
- **계속 가능한 작업**: manifest payload role, immutable object, Snapshot/Live 분리, 원문·실제 전달 내용의 기본 표시와 대체 경로 비교. 어떤 표시를 택해도 당시 자료와 현재 자료의 의미를 합치지 않는다.
- **상태**: `OPEN`

<a id="hum-engine-001"></a>
#### HUM-ENGINE-001 — AI Engine 계정 기본 선택 범위

- **추천·대안**: [첫 사용·실행 계정 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-first-use), [실행 설정·사전 위임·적용 시점](../references/design-synthesis/egdesk-ux-realization-proposals.md#execution-settings), [협업 계정 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-collaboration)
- **질문**: AI Engine 계정 기본값을 앱·Desk·Chat·요청 중 어느 범위에 적용할 것인가? 계정 전환·공동 실행 예산을 미리 위임할 범위는 어디까지인가? 협업자의 계정·비용 선택은 `HUM-COLLAB-001`에서 같은 값으로 사용한다.
- **확정된 부분**: 실제 계정과 Run의 binding은 보존한다. 로그아웃·quota 소진을 이유로 진행 중 Run을 다른 계정으로 조용히 옮기지 않으며, 인증·권한·사용 한도 부족은 서로 다른 상태로 복구한다.
- **관련 후보**: [Reader·Worker 전체 예산과 quota 소진](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-reader-budget), [협업자가 사용할 실행 계정·quota](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-collaboration-authority).
- **왜 사용자 결정인가**: 사용 편의와 잘못된 계정 quota 사용 위험의 균형을 정한다.
- **영향**: [Atlas ENGINE-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-engine-01), [Contract §14.1](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-engine-profile)
- **계속 가능한 작업**: identity plane 분리, Engine Profile별 credential/runtime 격리, Run의 `engineProfileId` 고정.
- **상태**: `OPEN`

<a id="hum-agent-001"></a>
#### HUM-AGENT-001 — 즉시 사용 가능한 기본 Agent/Profile

- **추천·대안**: [첫 사용·기본 Agent 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-first-use)
- **질문**: 최초 설치에 안전한 기본 Agent/Profile을 제공할 것인가, 아니면 Chat 안에서 설정을 완료해야만 전송할 수 있게 할 것인가?
- **관련 후보**: [Engine·Agent·조직 지식 없는 최초 사용](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-first-use). 조직 지식 미설정과 실제 읽기 실패는 다른 상태로 다룬다.
- **왜 사용자 결정인가**: 최초 사용 난이도와 제품이 기본으로 부여하는 Agent 행동 범위·책임 기대가 달라진다.
- **영향**: [Atlas 최초 설정](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-manual-start), [AGENT-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-agent-01)
- **계속 가능한 작업**: Profile 설정·선택 UI와 사용 불가 사유 표시.
- **상태**: `OPEN`

<a id="hum-run-001"></a>
#### HUM-RUN-001 — Agent·Profile·Run·Task·Memory와 실행 수명주기

- **추천·대안**: [지속 기억·조직 규칙 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-memory), [강제 제한·기본값·이번 지시](../references/design-synthesis/egdesk-ux-realization-proposals.md#policy-conflicts), [실행 설정·전환 시점](../references/design-synthesis/egdesk-ux-realization-proposals.md#execution-settings), [업무 귀속·조정 전달 흐름](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-chat)
- **질문**: 개인·Agent 기억을 명시적으로 저장할 것인가, 사전 동의한 범위에서 자동 축적할 것인가? Profile·기억의 공유 범위와 기본 검사 깊이는 어디까지인가? 조직 규칙 승격은 `HUM-GOV-001`, 계정·예산은 `HUM-ENGINE-001`의 같은 선택에 따른다.
- **같은 범위에서 남은 선택**: 허용된 범위에서 사용자 지시·Profile·조직 정책이 충돌할 때의 적용 우선순위와 편집 권한, model·Profile·실행 상한 변경을 사전 위임할 범위와 적용 시점. 계정·비용은 `HUM-ENGINE-001`과 함께 결정한다. 같은 Run의 다음 호출 조정과 권한 비확대 원칙을 다시 결정하지 않는다.
- **확정된 부분**: 첫 모델 호출 전에 System이 적용되는 조직·Desk·Agent 정책에서 현재 Ontology와 필요한 자료를 조회·결합한다. 사용자에게 revision 번호 입력을 요구하지 않는다. 새 도구 관찰·사용자 조정·관련 Ontology 변화는 같은 Run의 가능한 가장 이른 다음 모델 호출에 반영한다. 이전 호출의 실제 입력은 보존하며, 일반적인 조정에는 일시 중지·새 attempt·fork를 요구하지 않는다. 실행 권한·승인 대상·동시 쓰기 조건이 깨진 행동만 재검증한다.
- **왜 사용자 결정인가**: 사용자가 누구에게 무엇을 위임했고 어떤 설정·기억·권한으로 실행됐는지 이해하고 통제하는 제품 책임 모델을 정한다.
- **영향**: [Atlas AGENT-01–03](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-agent-01), [AI-01–02](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-01), [Contract §14](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-agent-run-binding)
- **계속 가능한 작업**: Run 출발 조건과 호출별 실제 입력의 이력 보존, 다음 호출의 조정 수신·반영 상태, 권한 비확대와 안전한 inspect summary. Engine·Profile·실행 상한의 명시적 전환, retry·fork의 세부 수명주기는 계속 설계한다.
- **상태**: `OPEN`

<a id="hum-orch-001"></a>
#### HUM-ORCH-001 — Task graph·dependency·approval·integration의 사용자 통제

- **추천·대안**: [예약·닫기 정책 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-agenda), [업무별 중지·기여 통합 흐름](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-chat)
- **질문**: 담당 Agent의 위임 교환·세부 Task·부분 결과를 기본 화면에서 어느 깊이까지 공개할 것인가? Agenda 닫기 뒤 미래 예약·반복 작업의 보존·중지 기본값은 Agenda 정책에서 함께 선택한다.
- **관련 후보**: [Agenda 닫기와 미래 예약·의존 작업](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-recurring-close), [현재 조정의 업무 대상](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-conversation-target). 기존 위임 안의 일반 분할·검토·복구마다 사람 승인을 요구하지 않는다.
- **왜 사용자 결정인가**: 자동 실행의 자율성, 사용자 통제 시점, 승인으로 멈추는 범위와 여러 기여를 최종 결과로 묶는 책임이 달라진다.
- **영향**: [Atlas AI-06–07](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-06), [Contract §9](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-dependency-orchestration), [§11](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-parallel-agents)
- **계속 가능한 작업**: dependency checkpoint, 정본 Task 상태, 실패 분기만 차단, 독립 성공 보존, 승인 없는 권한 확대 금지. 지시 대상·취소·재할당·부분 결과 검사와 실제 승인 요청의 위치·복귀 흐름은 기존 권한 안에서 구체화한다.
- **상태**: `OPEN`

<a id="hum-code-001"></a>
#### HUM-CODE-001 — 사람 대상 코딩 UX와 검증 완료 기준

- **추천·대안**: [파일 형식별 출시 지원 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-files)
- **질문**: 첫 지원에서 어떤 파일 형식까지 보기·AI 판독·직접 편집을 약속할 것인가? Office 원본의 풍부한 내장 편집을 첫 지원의 필수로 둘 것인가, 외부 편집 연결부터 제공할 것인가? 이 선택으로 최종 내장 편집을 영구 제외하지 않는다.
- **관련 후보**: [파일 형식별 보기·판독·편집·Snapshot 지원](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-file-support). 일반 문서·표·이미지의 지원 범위도 함께 정하며 모든 형식 편집을 전제하지 않는다.
- **왜 사용자 결정인가**: AI의 내부 실행 수단과 사람이 이해·검토·수정하는 주 coding experience의 우선순위를 정한다.
- **영향**: [Atlas CODE-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-code-01), [TERM-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-term-01), [Contract §6–7](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-coding-surface)
- **계속 가능한 작업**: 여러 PC·folder의 file tree·검색·viewer/editor·diff·test evidence 구성, Terminal을 Agent substrate와 optional expert view로 분리, 변경 수락·충돌·실패·원 파일 복귀와 검증 결과 표시. 화면 배치와 검사 방법을 제품 소유자에게 설계하도록 요구하지 않는다.
- **상태**: `OPEN`

<a id="hum-export-001"></a>
#### HUM-EXPORT-001 — 로컬 데이터·`.egdesk` 기본 포함 범위와 보호

- **추천·대안**: [반출입·보호 정책 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-retention), [새 기기의 자원 연결 흐름](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-portable), [설정·연결·기록 초기화 흐름](../references/design-synthesis/egdesk-ux-realization-proposals.md#data-reset)
- **질문**: 앱·Desk·Agenda·account/profile·Agent 설정의 로컬 저장 범위와 보존·삭제·초기화 정책을 어떻게 나누고, 한 파일 내보내기에 Chat, Canvas layout, Agenda, Snapshot raw capture, Agent-delivered packet, artifact 중 무엇을 기본 포함할 것인가? 암호화를 기본/선택으로 둘지와 가져오기 충돌의 `새 사본`, `병합`, `건너뜀` 의미도 함께 확정하는가?
- **초기화에서 남은 선택**: 앱 환경설정, 계정 연결·로컬 인증 정보, Agent·Engine Profile 정의, 업무 기록을 어떤 범주로 고르게 하고 기록 복구·백업 기본값을 무엇으로 둘 것인가? 이 PC 정리와 공유 원본 삭제를 구별하며 provider 연결 철회·외부 파일 삭제를 같은 효과로 묶지 않는다.
- **관련 후보**: [새 기기의 파일·계정·실행 재연결](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-portability), [참조는 있지만 전송 권한이 없는 원본·파생물](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-retention). 참조된 비공개 원본이 자동 포함되지는 않으며, 제외 참조를 설명할지 해당 내보내기를 막을지는 남은 선택이다.
- **왜 사용자 결정인가**: 이동 편의, 파일 크기, 개인정보와 복원 충실도를 바꾼다.
- **영향**: [Atlas DATA-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-data-01), [Contract §15.1](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-portable-bundle)
- **계속 가능한 작업**: credential 제외, hash 검증, portable manifest/event/object prototype.
- **상태**: `OPEN`

<a id="hum-gov-001"></a>
#### HUM-GOV-001 — Ontology 사용자 편집 권한

- **추천·대안**: [기억·조직 규칙·검토 권한 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-memory)
- **질문**: 최종 제품 사용자가 Ontology를 직접 편집·승격할 수 있는가, 제안만 할 수 있는가, 읽기 전용으로 검사만 하는가?
- **관련 후보**: [현재 업무 조정·개인 기억·조직 규칙의 경계](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-knowledge-memory). 의미 수락·승격·활성화의 책임 구분 자체는 별개 인원을 요구하지 않는다. 조직별 사람 검토 범위와 단계별 확인·위임 정책은 남은 선택이다.
- **왜 사용자 결정인가**: Agent cycle을 제약하는 운영 model을 누가 바꿀 수 있는지와 검증·승격 책임을 정한다.
- **영향**: [Atlas ONT-01–02](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ont-01), [Contract §10](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-ontology-runtime)
- **계속 가능한 작업**: 읽기 전용 검사, version·evidence binding, Agent cycle 제약.
- **상태**: `OPEN`

<a id="hum-a11y-001"></a>
#### HUM-A11Y-001 — 최종 접근성 기준선

- **질문**: 목표로 삼을 WCAG/플랫폼 접근성 수준, 지원 화면 읽기·키보드·확대·언어 범위를 어디까지 확정할 것인가?
- **왜 사용자 결정인가**: 출시 시장·지원 약속·acceptance 범위와 검증 비용을 함께 바꾸는 제품 기준선이다.
- **영향**: [Atlas UX-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ux-01), [Contract §16](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-accessibility)
- **확정된 부분**: 키보드·focus 복귀, 이름·상태 안내, 움직임 감소와 비공간 대안은 모든 핵심 흐름에 필요하다. 이 동등 조작 경로를 제공할지 다시 결정하지 않는다.
- **계속 가능한 작업**: 기본 keyboard/focus, accessible name/state, reduced motion, 비공간 대안, 드래그 없는 포인터 대안과 입력기 조합 검사. 특정 WCAG 수준·운영체제·보조기술의 지원 약속은 실제 지원표와 검증 범위를 비교할 때 확정한다.
- **상태**: `OPEN`

<a id="hum-collab-001"></a>
#### HUM-COLLAB-001 — 공유 범위·역할·동시 작업·computer-use 제어권

- **추천·대안**: [협업자의 접근·실행·비용 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-collaboration), [동시 변경·되돌리기](../references/design-synthesis/egdesk-ux-realization-proposals.md#collaboration-changes), [Desk 소유·관리 이전·복구](../references/design-synthesis/egdesk-ux-realization-proposals.md#desk-ownership)
- **질문**: 초대한 사람에게 기본으로 공개할 자료와 허용할 행동은 어디까지인가? 관찰·대화·Agent 실행·업무 계정·PC 제어를 누가 어느 범위와 기간으로 위임할 수 있게 할 것인가? 실행 계정과 비용 기본값은 `HUM-ENGINE-001`과 한 번만 선택한다.
- **같은 범위에서 남은 선택**: 동시 변경이 충돌하면 누구의 변경을 어떻게 보존·수락·되돌릴 수 있게 할 것인가? Desk 소유·관리 권한의 이전·복구는 누가 할 수 있는가? 충돌 알고리즘과 컨트롤 배치는 이 선택을 만족하도록 설계한다.
- **확정된 부분**: 다중 PC·다중 사용자 방향과 관찰·제어 권한의 분리는 유지한다. 참가자 추가나 PC 연결은 모든 파일·계정에 대한 접근권 부여가 아니다. 실제 실행 위치·행위자·계정·결과 귀속을 보존하고, 연결 끊김을 종료 확인으로 처리하지 않는다.
- **관련 후보**: [협업자별 보기·실행·계정·quota·이어받기](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-collaboration-authority). 개인 자료를 참고한 파생 요약의 공유 범위도 포함한다.
- **왜 사용자 결정인가**: 최종 비즈니스 목표인 다중 사용자 협업의 소유권·개인정보·동시 행동 충돌·통제 책임을 정한다.
- **영향**: [Atlas COL-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-col-01), [CU-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-cu-01), [Contract §12](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-collaboration-computer-use)
- **계속 가능한 작업**: 로컬 role/permission schema, 사람과 Agent input ownership 분리, Desk-visible 관찰, mock collaboration UI.
- **상태**: `OPEN`; 실제 원격 전송·identity·server provision은 `HUM-REMOTE-001`과 별도 승인 대상.

<a id="hum-remote-001"></a>
#### HUM-REMOTE-001 — 원격 협업·관찰·동기화 인프라

- **질문**: 원격 협업, Desk 밖 computer-use 관찰, 다중 기기 sync를 실제로 열 때 provider/자체 서버, identity, 비용, 전송 데이터, 보존·삭제 정책을 무엇으로 승인할 것인가?
- **왜 사용자 결정인가**: 외부 인프라·데이터 전송·비용·새 권한 경계다.
- **영향**: [Atlas COL-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-col-01), [CU-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-cu-01), [DATA-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-data-01)
- **계속 가능한 작업**: 로컬 기능, 여러 PC의 자원·실행 위치·권한 모델, 연결 끊김·재접속·중복 실행 방지를 포함한 mock UI와 provider 비교 조사. 실제 원격 인프라 승인을 제품 설계 전체의 선행조건으로 두지 않는다.
- **상태**: `OPEN / OWNER-APPROVAL-REQUIRED`

<a id="gap-maintenance-appendix"></a>

내부 문서 운영 기록은
[EG-Desk 제품 문서 화자·운영 정본](./egdesk-product-documentation-governance.md#doc-governance-top)에서 관리한다.
