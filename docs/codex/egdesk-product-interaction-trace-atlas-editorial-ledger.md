# EG-Desk 설계 Gap 및 사용자 확인 원장

**문서 목차**: [읽는 목적별 안내](../README.md#docs-start) · **대안 비교**: [정책 추천안](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-policy-options)

**문서 역할**: 제품 소유자만 결정할 수 있는 미확정 제품 의미·기본 동작·권한 경계를 질문 단위로 제시한다.
**사용자 매뉴얼**: [EG-Desk 가상 사용설명서와 제품 상호작용 Atlas](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-manual-start)
**기술 계약**: [EG-Desk 기술 구현·상호작용·오케스트레이션 계약](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-contract-top)
**관련 운영 문서**: [EG-Desk 제품 문서 화자·운영 정본](./egdesk-product-documentation-governance.md#doc-governance-top)

<a id="gap-owner-queue"></a>

## 0. 제품 소유자 확인 목록

현재 선택이 남은 정책 주제는 `OPEN`인 16개다. 하나의 주제 안에서도 각 선택은 독립적이다.
HUM-DESK-001은 이미 결정됐고 HUM-READ-001은 별도 사용자 선택 없이 설계로 해소했다.
두 항목의 앵커·이력은 기존 문서 연결을 위해 남긴다.
결정되지 않은 항목은 연결된 범위만 `OPEN`으로 남으며, 각 항목의 `계속 가능한 작업`에서
이미 작성한 조건별 흐름과 구현·검사 경로를 확인할 수 있다.

`HUM-*`는 제품 의미·기본 수명주기·권한처럼 제품 소유자만 결정할 항목이다.
세부 레이블·위치·키보드·재시도·복귀와 처리 방법은 작성된 상세 설계에 연결되어 있다.
기존 175개 질문의 설계·검토 근거는 [설계 점검표](./egdesk-product-documentation-governance.md#design-closure-status)에서 확인한다.

질문·결정·현재 상태는 이 원장에 있다. 추천·대안·영향은
[UI 추천안의 정책 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-policy-options),
질문이 나온 상황은 [니즈 점검 기록](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-review)에서 확인한다.
정책 비교의 7묶음은 읽기 위한 분류이며, 이 원장의 질문을 대체하거나 일괄 승인하지 않는다.

아래 `질문`은 남은 제품 선택을 뜻한다. 확정된 방향, 그 방향을 구현할 데이터 구조,
버튼 배치·입력·일반 복구 방법까지 다시 결정받지는 않는다. 7묶음을 한꺼번에 답할
필요는 없다. 접근성은 아래 지원 조합을 비교해 선택하고, 실제 원격 인프라 집행은
선택한 구성의 공급자·데이터·비용이 명시된 별도 승인에서 확인한다.

| 상태 | 의미 |
|---|---|
| `OPEN` | 선택지가 남았으며 어느 쪽도 확정 동작처럼 쓰지 않는다 |
| `PROPOSED` | 근거와 trade-off가 있는 기본안이 있으나 제품 소유자 결정 전이다 |
| `DECIDED` | 제품 소유자의 결정 출처와 반영된 Atlas·Contract 위치가 있다 |
| `RESOLVED-BY-DESIGN` | 별도 제품 선택 없이 위임된 설계로 해소하며 새 제품 승인을 뜻하지 않는다 |
| `SUPERSEDED` | 더 최신 결정이 있으며 이전 결정 이력을 삭제하지 않는다 |

### 0.1 결정된 경계와 남은 제품 선택

<a id="hum-desk-001"></a>
#### HUM-DESK-001 — Desk 수와 Agenda 열기 결과

- **질문**: 추가로 남은 제품 선택은 없다. 하나의 Desk·Canvas와 여러 Agenda·PC의 관계는 아래 결정을 유지한다.
- **결정**: 기본 제품 모델은 **하나의 Desk와 그 Desk에 속한 하나의 Canvas**다. 여러 Saved Agenda는 Sidebar에서 선택해 같은 Canvas에 서로 독립된 projection으로 동시에 열 수 있다. Agenda를 연다고 기존 Canvas 내용을 교체하거나 별도 Desk를 만들지 않는다. 다중 Desk는 메모리 최적화 수단으로 도입하지 않는다. 이 화면 관계는 물리 PC 한 대의 제한이 아니다. Canvas 기반 Agenda는 여러 PC의 자료·실행 자원을 연결하며 폴더 하나로 한정되지 않는다.
- **결정 출처**: 제품 소유자 대화 결정, 2026-08-25–2026-08-30; 다중 PC·Canvas 기반 Agenda 방향 재확인, 2026-09-08.
- **왜 사용자 결정인가**: navigation·저장·복원 객체 수명주기가 달라진다.
- **영향**: [Atlas AG-02](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ag-02), [Contract §1](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-desk-lifecycle)
- **계속 가능한 작업**: [Agenda 배치·중복 열기·겹침 회피](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda)의 설계를 바탕으로 Agenda 열기·기존 화면 복귀를 구현하고 검사할 수 있다.
- **상태**: `DECIDED`

<a id="hum-agenda-001"></a>
#### HUM-AGENDA-001 — Agenda 저장 내용과 revision 수명주기

- **추천·대안**: [Agenda 저장·공유 실행·닫기 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-agenda), [저장된 Agenda 삭제·복구 흐름](../references/design-synthesis/egdesk-ux-realization-proposals.md#agenda-delete-recover)
- **질문**: 기본 저장 내용, 닫은 뒤 미저장 편집의 복구 범위, 이전 저장 구성으로 되돌리기, 삭제된 Saved Agenda의 복구 가능 범위·기한을 각각 무엇으로 할 것인가? 저장본·편집 초안·휴지통은 독립된 선택이다.
- **삭제에서 남은 선택**: Saved Agenda 자체를 휴지통에 보존할지, 보관 기한과 복구 범위를 어디까지 둘지다. 닫을 때의 예약 pause/삭제와는 독립된 선택이며, 저장본 복구가 과거 권한·실행·예약의 자동 복원을 뜻하지 않는다.
- **관련 후보**: [저장 시점·현재 원본·동일 resource 재사용](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-agenda-save). 미저장 편집이 있는 Agenda를 닫을 때 무엇을 복구 기록에 남길지도 함께 정한다.
- **왜 사용자 결정인가**: 자동 Desk 세션과 명시적 저장의 경계를 바꾼다.
- **영향**: [Atlas AG-01–04](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ag-01), [Contract §1](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-desk-lifecycle)
- **계속 가능한 작업**: [저장 범위·리비전·삭제·복구의 조건별 경로](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agenda-lifecycle)의 설계를 바탕으로 선택할 보존 정책별 구현과 복구 검사를 진행할 수 있다.
- **상태**: `OPEN`

<a id="hum-surface-001"></a>
#### HUM-SURFACE-001 — Desk·Canvas·View·Library·Terminal의 사람용 화면 모델

- **추천·대안**: [조작면 관찰·집중 보기](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-surface), [Agenda와 실행 소유권](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-agenda), [Library·그룹·live 재사용](../references/design-synthesis/egdesk-ux-realization-proposals.md#library-groups)
- **질문**: 같은 live 자원을 기본 재사용할지 독립 사본·세션으로 열지, 여러 Agenda가 같은 실행의 유지를 명시적으로 함께 맡을 수 있게 할지, 선별 재사용 등록을 제공할지와 제공한다면 어떤 대상을 포함할지, 그룹 배치를 재시작·Agenda 저장에 어디까지 남길지 각각 선택한다.
- **설계와 구분**: Library의 패널 형태·명칭, 중첩 그룹 표현, 검색·여닫기 컨트롤은 위임된 설계다. 선별 재사용 대상과 그룹 지속 범위만 위 질문에서 선택한다.
- **관련 후보**: [shared runtime 닫기](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-shared-lifecycle), [Canvas 밀도·보존](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-canvas-density), [집중 보기·zoom·resize](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-view-transform), [업로드·OS 승인 설명](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-native-ui).
- **확정된 부분**: Desk당 Canvas는 하나다. 사용자나 Agent의 의미 있는 활성 작업, sleeping 상태, historical snapshot은 Canvas에서 찾을 수 있는 표현을 가져야 한다. Canvas viewport 밖이라는 이유만으로 자동 종료하지 않으며, lifecycle은 Agenda 단위가 아니라 각 view와 그 runtime 단위로 판단한다. 무거운 renderer는 분리할 수 있지만 Canvas에는 가벼운 node·상태·snapshot 중 알맞은 표현이 남는다. Agenda를 닫으면 그 projection과 해당 Agenda만 소유한 runtime은 종료하고 Saved Agenda는 보존한다. File view 재진입에서는 scroll·보이는 위치를 복원할 수 있지만 active caret, keyboard focus, transient text selection은 복원하지 않는다.
- **추가 확정 — 2026-09-10, Chat/Canvas 입력**: Chat을 클릭해 콘텐츠를 활성화하고 활성 상태를 시각적으로 구별한다. 활성 Chat 위의 두 손가락 입력은 콘텐츠 scroll이다. 빈 Canvas를 클릭하면 콘텐츠 활성이 풀리고, 이후 비활성 Chat 위에서도 두 손가락으로 Canvas를 이동할 수 있다. hover는 재활성화가 아니며 별도 Pan 버튼은 이 기본 흐름의 필수 절차가 아니다. 출처와 대체 범위는 [사용자 결정 기록](./egdesk-product-documentation-governance.md#owner-chat-canvas-input-20260910)에 남긴다. 활성 표시의 구체 색·두께, 다른 입력 방식의 전면 개편·Agent 입력권 변경을 이 결정에 포함하지 않는다.
- **왜 사용자 결정인가**: 단순한 레이블을 넘어 사용자가 리소스를 찾고 화면을 조직하고 닫을 때 무엇이 남는지 이해하는 전체 mental model을 바꾼다.
- **영향**: [Atlas V-01–03](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-v-01), [DISC-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-disc-01), [CODE-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-code-01), [TERM-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-term-01), [Contract §4.1](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-observation-fidelity), [§6–7](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-coding-surface)
- **입력 교정 연결**: [Atlas V-03](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-v-03) · [Chat 활성·Canvas 탐색 UI](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-canvas-input) · [입력 기술 계약](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-view). 새 규칙의 독립 재검토·구현 시험은 아직 수행하지 않았다.
- **계속 가능한 작업**: [View·그룹·Library·검색·종료·메모리 관리](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-view)의 설계를 바탕으로 선택할 재사용·지속 정책별 구현과 화면 검사를 진행할 수 있다.
- **상태**: `OPEN`

<a id="hum-conv-001"></a>
#### HUM-CONV-001 — Agent 담당자 방, 공유 대화와 Agenda 관계

- **추천·대안**: [담당자 방·업무 귀속·Memo 응답 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-chat)
- **질문**: Agenda 참여자에게 기본 공개할 업무 메시지·기여 범위는 어디까지인가? Memo는 명시 질문에만 응답하는가, 담당 범위에 연결된 메모에도 응답하는가? 필요한 후속 연락과 미응답 재촉의 기본값은 무엇인가? 대화의 화면상 펼침 깊이는 공개 권한과 별개다.
- **관련 후보**: [추가 지시의 업무 대상](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-conversation-target), [실제 참여자·위임 대화](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-participants), [Memo의 먼저 말 걸기·중복·종료](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-memo-initiation).
- **확정된 부분**: 사람에게 보이는 기본 Chat 관계는 **Agent/persona별 담당자 방**이다. Agent Profile은 방의 상대 정체성이지만 실제 Run이나 모델 context와 동일하지 않다. Canvas Memo는 위치에 고정된 짧은 메모와 작성자별 짧은 답글을 제공하며, Agent가 사용자의 메모 본문을 고쳐 쓰거나 자동으로 긴 대화로 승격하지 않는다. 짧은 답만으로 오해할 위험이 있거나 정보가 부족하면 Agent는 메모 참조를 포함한 메시지·mention을 관련 Agent 방에 먼저 만들 수 있지만 사용자의 Canvas focus를 빼앗지 않는다.
- **왜 사용자 결정인가**: 개인정보, 공유 범위, 재진입 위치와 협업 mental model을 바꾼다.
- **영향**: [Atlas CHAT-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-chat-01), [AI-03](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-03), [CANVAS-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-canvas-01), [Contract §4](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-answer-projection), [§5](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-multi-agent-chat)
- **계속 가능한 작업**: [담당자 방·여러 업무·공유 대화·Memo 응답](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-chat-entry)의 설계를 바탕으로 선택할 공개·응답 정책별 구현과 대화 귀속 검사를 진행할 수 있다.
- **상태**: `OPEN`

<a id="hum-answer-001"></a>
#### HUM-ANSWER-001 — 요청·Result·논리적 Answer·Chat/Canvas 표현의 관계

- **추천·대안**: [근거·결과 편집·설명 갱신 흐름](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-answer)
- **질문**: 사용자가 답변의 내용·구성을 원 Agent 답변과 구별되는 지속 수정본으로 남길 수 있게 할 것인가, 주석과 새 설명 요청만 허용할 것인가? 수정 후 설명 갱신은 명시 요청형인가 자동형인가? Briefing 편집과 파일 원본 편집은 해당 항목에서 별도로 선택한다.
- **확정된 부분**: 요청·Run·Task·기여·Result·artifact·Answer는 같은 객체가 아니다. 하나의 논리적 Answer를 Chat과 Canvas에서 매체에 맞게 표현하며, 화면 탐색만으로 새 분석을 실행하지 않는다. 이 동일성과 귀속을 보장하는 구조는 기술 계약에 따라 구체화한다.
- **관련 후보**: [활동 관찰과 과거 근거](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-activity-navigation), [결과 편집·주석·Briefing revision](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-briefing-edit).
- **왜 사용자 결정인가**: 무엇이 최종 답변이고 무엇이 기여·산출물·표현인지, 수정·삭제·공유·재진입 시 어떤 결과를 정본으로 보는지가 달라진다.
- **영향**: [Atlas AI-04](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-04), [Contract §4](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-answer-projection), [§11](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-parallel-agents)
- **계속 가능한 작업**: [답변 수정본·대표본·화면 표현·삭제](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-answer-revisions)의 설계를 바탕으로 읽기 전용/편집 허용 정책별 구현과 버전 검사를 진행할 수 있다.
- **상태**: `OPEN`

<a id="hum-brief-001"></a>
#### HUM-BRIEF-001 — 답변 브리핑의 편집·지속·공유 권한

- **추천·대안**: [Briefing 편집·보존 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-retention)
- **질문**: 답변 브리핑을 읽기 전용 설명으로 제공할 것인가, 사용자가 단계 순서·대상·설명을 지속 편집해 재사용할 수 있게 할 것인가? 저장·공유는 Snapshot·반출·협업의 같은 선택을 따른다.
- **왜 사용자 결정인가**: 단순 presentation과 재사용 가능한 산출물 사이의 수명주기를 결정한다.
- **영향**: [Atlas AI-05](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-05), [Contract §8](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-answer-briefing)
- **계속 가능한 작업**: [단계 이동·편집·댓글·원본 복귀](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-briefing-comment)의 설계를 바탕으로 선택할 편집 정책별 구현과 주석·재진입 검사를 진행할 수 있다.
- **상태**: `OPEN`

<a id="hum-read-001"></a>
#### HUM-READ-001 — Smart Read 가시성과 사용자 개입 시점

- **추천·대안**: [자료 읽기·상세 확인·범위 조정](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-reading)
- **질문**: 별도 사용자 결정은 남기지 않는다. 기본/상세 표시, Reader 배분·동시성·추정과 개입 컨트롤은 위임된 설계다. 새 계정·추가 비용·권한 밖 사용을 사전 위임할 범위만 HUM-ENGINE-001의 같은 선택을 따른다.
- **확정된 부분**: 읽기 범위 조정, 원문 coverage 검사, 자동 admission·Reader 전환과 허용된 복구의 경로가 상세 설계에 있다. 실제로 필요한 비밀번호·권한·대체 원본만 해당 작업과 연결해 요청하며 일반 읽기를 매번 승인받지 않는다.
- **왜 사용자 결정인가**: 이 항목 자체는 사용자 결정이 아니라 설계 책임으로 해소한다. 계정·비용·권한 정책만 연결된 항목의 결정을 따른다.
- **영향**: [Atlas READ-01–03](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-read-01), [Contract §2.1–2.4](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-smart-read)
- **계속 가능한 작업**: [자동 읽기 배분·Reader 재호출·실제 입력·오류 복구](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-reader-observation)의 설계를 바탕으로 허용된 범위의 읽기 구현과 입력·누락·복구 검사를 진행할 수 있다.
- **상태**: `RESOLVED-BY-DESIGN` — 제품 기본값을 새로 승인한 뜻이 아니며 표시·읽기 제어의 상세 설계를 연결한다.

<a id="hum-snapshot-001"></a>
#### HUM-SNAPSHOT-001 — Snapshot 보존·가림·삭제 연동

- **추천·대안**: [근거 보존·삭제·철회 정책 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-retention)
- **질문**: 보존을 참조·사용자 고정 중심으로 할지 기간 중심으로 할지, 권한 철회 뒤 허용된 개인 과거 사본을 어디까지 열람할지, 원문 삭제를 packet·파생물에 어디까지 연동할지, 원문·packet·파생물 중 어디까지 가림을 적용할지와 가림 처리 전 사본을 보존할지 각각 선택한다. 출처·조직의 강제 조건을 이 선택으로 완화할 수는 없다.
- **관련 후보**: [진행 중 활동의 Live/Snapshot 기본값](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-activity-navigation), [원본·Reader packet·파생 요약의 삭제·공유 철회](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-retention).
- **왜 사용자 결정인가**: 투명성, 개인정보, 로컬 저장량과 과거 답변 재현성의 trade-off다.
- **영향**: [Atlas M5-F](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-m5-f), [Contract §4.1](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-observation-fidelity), [§15](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-storage-export)
- **계속 가능한 작업**: [과거 원문·실제 전달 자료·Live·가림·삭제](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-reader-observation)의 설계를 바탕으로 선택할 보존·가림 정책별 구현과 파생 사본 검사를 진행할 수 있다.
- **상태**: `OPEN`

<a id="hum-engine-001"></a>
#### HUM-ENGINE-001 — AI Engine 계정 기본 선택 범위

- **추천·대안**: [첫 사용·실행 계정 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-first-use), [실행 설정·사전 위임·적용 시점](../references/design-synthesis/egdesk-ux-realization-proposals.md#execution-settings), [협업 계정 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-collaboration)
- **질문**: 기본 AI 계정을 앱·Desk·방·이번 요청 중 어디에 기억할 것인가? 후속 실행의 계정 선택을 명시한 대상·기간·한도 안에서 미리 위임할 수 있는가, 전환마다 직접 선택하는가? 협업의 각자/공동 Engine 비용 귀속은 HUM-COLLAB-001과 한 번만 선택한다.
- **확정된 부분**: 실제 계정과 Run의 binding은 보존한다. 로그아웃·quota 소진을 이유로 진행 중 Run을 다른 계정으로 조용히 옮기지 않으며, 인증·권한·사용 한도 부족은 서로 다른 상태로 복구한다.
- **관련 후보**: [Reader·Worker 전체 예산과 quota 소진](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-reader-budget), [협업자가 사용할 실행 계정·quota](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-collaboration-authority).
- **왜 사용자 결정인가**: 사용 편의와 잘못된 계정 quota 사용 위험의 균형을 정한다.
- **영향**: [Atlas ENGINE-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-engine-01), [Contract §14.1](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-engine-profile)
- **계속 가능한 작업**: [계정별 연결·선택·갱신·교체·실제 적용](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-identity)의 설계를 바탕으로 선택할 기본 범위·위임 정책별 구현과 계정 격리 검사를 진행할 수 있다.
- **상태**: `OPEN`

<a id="hum-agent-001"></a>
#### HUM-AGENT-001 — 즉시 사용 가능한 기본 Agent/Profile

- **추천·대안**: [첫 사용·기본 Agent 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-first-use)
- **질문**: 처음부터 제한된 기본 Agent/Profile로 요청할 수 있게 할 것인가, 사용자가 Profile 설정을 마친 뒤에만 첫 요청을 보낼 수 있게 할 것인가?
- **관련 후보**: [Engine·Agent·조직 지식 없는 최초 사용](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-first-use). 조직 지식 미설정과 실제 읽기 실패는 다른 상태로 다룬다.
- **왜 사용자 결정인가**: 최초 사용 난이도와 제품이 기본으로 부여하는 Agent 행동 범위·책임 기대가 달라진다.
- **영향**: [Atlas 최초 설정](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-manual-start), [AGENT-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-agent-01)
- **계속 가능한 작업**: [Profile 생성·활성화·중단·대체·기본값](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-agent-profile)의 설계를 바탕으로 기본 제공/직접 설정 정책별 첫 요청 구현과 검사를 진행할 수 있다.
- **상태**: `OPEN`

<a id="hum-run-001"></a>
#### HUM-RUN-001 — Agent·Profile·Run·Task·Memory와 실행 수명주기

- **추천·대안**: [지속 기억·조직 규칙 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-memory), [강제 제한·기본값·이번 지시](../references/design-synthesis/egdesk-ux-realization-proposals.md#policy-conflicts), [실행 설정·전환 시점](../references/design-synthesis/egdesk-ux-realization-proposals.md#execution-settings), [업무 귀속·조정 전달 흐름](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-chat)
- **질문**: 기억을 명시 저장할지 사전 동의 범위에서 자동 축적할지, 개인/선택 Agent의 재사용 범위와 Profile 공유 기본값은 무엇인지, 지속 Profile·Desk·조직 설정의 편집을 설정 소유자만 할지 변경 유형별 수임자에게 허용할지 선택한다. 허용된 기본 정책 간 우선순위와 범위 내 Profile·모델 자동 조정의 위임도 별도 선택이다.
- **설계와 구분**: 이미 정한 같은 Run 조정, 실제 적용 시점 표시, 구성 병합·검사·미지원 전환의 복구는 위임된 설계다. 기술 인터페이스가 허용하는 시점과 실제 적용 증거를 제공하며, 반영 시점 자체를 재승인받지 않는다.
- **확정된 부분**: 첫 모델 호출 전에 System이 적용되는 조직·Desk·Agent 정책에서 현재 Ontology와 필요한 자료를 조회·결합한다. 사용자에게 revision 번호 입력을 요구하지 않는다. 새 도구 관찰·사용자 조정·관련 Ontology 변화는 같은 Run의 가능한 가장 이른 다음 모델 호출에 반영한다. 이전 호출의 실제 입력은 보존하며, 일반적인 조정에는 일시 중지·새 attempt·fork를 요구하지 않는다. 실행 권한·승인 대상·동시 쓰기 조건이 깨진 행동만 재검증한다.
- **왜 사용자 결정인가**: 사용자가 누구에게 무엇을 위임했고 어떤 설정·기억·권한으로 실행됐는지 이해하고 통제하는 제품 책임 모델을 정한다.
- **영향**: [Atlas AGENT-01–03](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-agent-01), [AI-01–02](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-01), [Contract §14](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-agent-run-binding)
- **계속 가능한 작업**: [지시·기억·모델·실행 조정·재시도·계속](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-run-control)의 설계를 바탕으로 선택할 기억·위임 정책별 구현과 상태 전이 검사를 진행할 수 있다.
- **상태**: `OPEN`

<a id="hum-orch-001"></a>
#### HUM-ORCH-001 — Task graph·dependency·approval·integration의 사용자 통제

- **추천·대안**: [예약·닫기 정책 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-agenda), [업무별 중지·기여 통합 흐름](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-chat)
- **질문**: Agenda를 닫은 뒤 미래 예약을 일시정지 상태로 보존할 것인가, 함께 삭제할 것인가? 다른 열린 Agenda에서 계속 유지할 실행의 소유 범위는 HUM-SURFACE-001의 같은 선택이다. Task·교환의 화면상 표시 깊이는 별도 사용자 결정으로 남기지 않는다.
- **관련 후보**: [Agenda 닫기와 미래 예약·의존 작업](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-recurring-close), [현재 조정의 업무 대상](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-conversation-target). 기존 위임 안의 일반 분할·검토·복구마다 사람 승인을 요구하지 않는다.
- **왜 사용자 결정인가**: 자동 실행의 자율성, 사용자 통제 시점, 승인으로 멈추는 범위와 여러 기여를 최종 결과로 묶는 책임이 달라진다.
- **영향**: [Atlas AI-06–07](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-06), [Contract §9](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-dependency-orchestration), [§11](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-parallel-agents)
- **계속 가능한 작업**: [의존 작업·기여·실패·중지·승인과 복귀](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-approval)의 설계를 바탕으로 선택할 예약 정책별 구현과 독립 작업·중복 실행 검사를 진행할 수 있다.
- **상태**: `OPEN`

<a id="hum-code-001"></a>
#### HUM-CODE-001 — 사람 대상 코딩 UX와 검증 완료 기준

- **추천·대안**: [파일 형식별 출시 지원 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-files)
- **질문**: 각 파일 형식의 보기·AI 판독·직접 편집·Snapshot에서 첫 지원으로 약속할 결과는 무엇인가? 최종 편집 경험에서 외부 앱 연결로 충족 가능한 형식과 Desk 안에서 편집이 완결되어야 하는 형식은 무엇인가? 첫 지원 순서와 최종 기능 범위는 별개다.
- **관련 후보**: [파일 형식별 보기·판독·편집·Snapshot 지원](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-file-support). 일반 문서·표·이미지의 지원 범위도 함께 정하며 모든 형식 편집을 전제하지 않는다.
- **왜 사용자 결정인가**: AI의 내부 실행 수단과 사람이 이해·검토·수정하는 주 coding experience의 우선순위를 정한다.
- **영향**: [Atlas CODE-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-code-01), [TERM-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-term-01), [Contract §6–7](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-coding-surface)
- **계속 가능한 작업**: [다중 PC 파일·형식별 편집·변경 검토·Terminal](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-files)의 설계를 바탕으로 선택할 지원 형식별 구현과 보존·편집·검증 검사를 진행할 수 있다.
- **상태**: `OPEN`

<a id="hum-export-001"></a>
#### HUM-EXPORT-001 — 로컬 데이터·`.egdesk` 기본 포함 범위와 보호

- **추천·대안**: [반출입·보호 정책 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-retention), [새 기기의 자원 연결 흐름](../references/design-synthesis/egdesk-ux-realization-proposals.md#flow-portable), [설정·연결·기록 초기화 흐름](../references/design-synthesis/egdesk-ux-realization-proposals.md#data-reset)
- **질문**: 기존 복원·근거 기록 외에 추가 오프라인 원문과 종료 후 일반 form 값을 어디까지 보관할지, bundle에 어떤 항목을 기본 포함할지, 부분 묶음·암호화·가져오기 기본값을 각각 선택한다. 기록 초기화의 영구 삭제/기한부 복구와 초기화 전 선택 백업/자동 보호 사본도 독립적으로 선택한다. 로컬 저장·보존·삭제·초기화·반출을 한 정책으로 묶지 않는다.
- **초기화에서 남은 선택**: 앱 환경설정·계정 연결·Profile 정의·업무 기록을 각각 독립적으로 초기화할 수 있게 할지와 삭제되는 범위, 기록 복구·백업 기본값을 선택한다. 범주명·선택 UI는 위임된 설계다. 이 PC 정리와 공유 원본 삭제를 구별하며 provider 연결 철회·외부 파일 삭제를 같은 효과로 묶지 않는다.
- **관련 후보**: [새 기기의 파일·계정·실행 재연결](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-portability), [참조는 있지만 전송 권한이 없는 원본·파생물](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-retention). 참조된 비공개 원본이 자동 포함되지는 않으며, 제외 참조를 설명할지 해당 내보내기를 막을지는 남은 선택이다.
- **왜 사용자 결정인가**: 이동 편의, 파일 크기, 개인정보와 복원 충실도를 바꾼다.
- **영향**: [Atlas DATA-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-data-01), [Contract §15.1](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-portable-bundle)
- **계속 가능한 작업**: [로컬 저장·독립 초기화·반출입·키·재연결](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-portable)의 설계를 바탕으로 선택할 보관·초기화·묶음 정책별 구현과 복원 검사를 진행할 수 있다.
- **상태**: `OPEN`

<a id="hum-gov-001"></a>
#### HUM-GOV-001 — Ontology 사용자 편집 권한

- **추천·대안**: [기억·조직 규칙·검토 권한 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-memory)
- **질문**: 권한 있는 사용자의 직접 편집·활성화, 일반 사용자의 허용된 후보 제안, 읽기 전용 검사를 각각 어디까지 제공할 것인가? 사람이 실제 판단해야 할 변경 유형과 사전 위임할 범위는 무엇인가?
- **관련 후보**: [현재 업무 조정·개인 기억·조직 규칙의 경계](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-knowledge-memory). 의미 수락·승격·활성화의 책임 구분 자체는 별개 인원을 요구하지 않는다. 조직별 사람 검토 범위와 단계별 확인·위임 정책은 남은 선택이다.
- **왜 사용자 결정인가**: Agent cycle을 제약하는 운영 model을 누가 바꿀 수 있는지와 검증·승격 책임을 정한다.
- **영향**: [Atlas ONT-01–02](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ont-01), [Contract §10](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-ontology-runtime)
- **계속 가능한 작업**: [Ontology 조회·후보·직접 편집·활성화·권한](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-ontology-governance)의 설계를 바탕으로 선택할 편집·위임 정책별 구현과 적용 근거 검사를 진행할 수 있다.
- **상태**: `OPEN`

<a id="hum-a11y-001"></a>
#### HUM-A11Y-001 — 최종 접근성 기준선

- **지원 비교**: [OS·보조기술·언어·확대 조합](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-input), [편집 가능한 대체 화면과 인수 절차](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-input)

- **질문**: EG-Desk 자체 화면의 목표 접근성 수준과 출시 OS·보조기술·언어·확대 조합 중 어디까지 지원을 약속할 것인가? 기본 키보드·포커스 복귀·이름/상태·모션 감소·비공간 대안은 선택 대상이 아니다.
- **왜 사용자 결정인가**: 출시 시장·지원 약속·acceptance 범위와 검증 비용을 함께 바꾸는 제품 기준선이다.
- **영향**: [Atlas UX-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ux-01), [Contract §16](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-accessibility)
- **확정된 부분**: 키보드·focus 복귀, 이름·상태 안내, 움직임 감소와 비공간 대안은 모든 핵심 흐름에 필요하다. 이 동등 조작 경로를 제공할지 다시 결정하지 않는다.
- **계속 가능한 작업**: [동등 조작·지원 조합](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-input)의 설계를 바탕으로 키보드·입력기·초점 복귀·비공간 대안을 구현하고 검사할 수 있다. 지원 약속은 위 비교표의 조합을 선택해 정한다.
- **상태**: `OPEN`

<a id="hum-collab-001"></a>
#### HUM-COLLAB-001 — 공유 범위·역할·동시 작업·computer-use 제어권

- **추천·대안**: [협업자의 접근·실행·비용 비교](../references/design-synthesis/egdesk-ux-realization-proposals.md#decision-collaboration), [동시 변경·되돌리기](../references/design-synthesis/egdesk-ux-realization-proposals.md#collaboration-changes), [Desk 소유·관리 이전·복구](../references/design-synthesis/egdesk-ux-realization-proposals.md#desk-ownership)
- **질문**: 초대의 기본 권한을 관찰만으로 할지 대화 참여까지로 할지, 위임을 해당 업무까지로 할지 회수 전까지로 할지, 타인 변경의 수락·역변경을 누가 할지 각각 선택한다. 관찰·대화·Agent 실행·업무 계정 사용·PC 제어의 위임 가능 주체와 범위도 각각 선택한다. 단일/공동 소유, 소유권 이전 주체, 복구 위임 유무와 이전 후 기존 복구 위임의 존속도 독립된 선택이다. Engine 비용 기본값은 HUM-ENGINE-001과 공유한다.
- **같은 범위에서 남은 선택**: 동시 변경이 충돌하면 누구의 변경을 어떻게 보존·수락·되돌릴 수 있게 할 것인가? Desk 소유·관리 권한의 이전·복구는 누가 할 수 있는가? 충돌 알고리즘과 컨트롤 배치는 이 선택을 만족하도록 설계한다.
- **확정된 부분**: 다중 PC·다중 사용자 방향과 관찰·제어 권한의 분리는 유지한다. 참가자 추가나 PC 연결은 모든 파일·계정에 대한 접근권 부여가 아니다. 실제 실행 위치·행위자·계정·결과 귀속을 보존하고, 연결 끊김을 종료 확인으로 처리하지 않는다.
- **관련 후보**: [협업자별 보기·실행·계정·quota·이어받기](../references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-collaboration-authority). 개인 자료를 참고한 파생 요약의 공유 범위도 포함한다.
- **왜 사용자 결정인가**: 최종 비즈니스 목표인 다중 사용자 협업의 소유권·개인정보·동시 행동 충돌·통제 책임을 정한다.
- **영향**: [Atlas COL-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-col-01), [CU-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-cu-01), [Contract §12](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-collaboration-computer-use)
- **계속 가능한 작업**: [초대·역할·동시 변경·소유권 이전·PC 제어](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-collaboration-manage)의 설계를 바탕으로 선택할 권한 정책별 로컬 모의 구현과 경합·철회 검사를 진행할 수 있다.
- **상태**: `OPEN`; 실제 원격 전송·identity·server provision은 `HUM-REMOTE-001`과 별도 승인 대상.

<a id="hum-remote-001"></a>
#### HUM-REMOTE-001 — 원격 협업·관찰·동기화 인프라

- **구성 비교**: [전송·녹화·동기화·백업의 독립 선택](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-computer-use-observe), [전송 구조·공급 방식·승인 범위](../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#impl-e24-remote-transport)

- **질문**: 원격 협업의 전송 대상, Desk 밖 관찰의 화면 범위·실시간/기록 보관, 기기 간 동기화 대상과 원격 백업 제공 범위를 각각 선택한다. 실제 공급자·호스팅·비용·데이터 이전의 집행 승인은 구성과 비용이 명시된 기존 승인 절차에서 별도로 받으며, 이 정책 선택을 포괄 비용 승인으로 취급하지 않는다.
- **왜 사용자 결정인가**: 외부 인프라·데이터 전송·비용·새 권한 경계다.
- **영향**: [Atlas COL-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-col-01), [CU-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-cu-01), [DATA-01](../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-data-01)
- **계속 가능한 작업**: [관찰·녹화·동기화·백업의 독립 구성](../references/design-synthesis/egdesk-ux-realization-proposals.md#ux-detail-e24-computer-use-observe)의 설계를 바탕으로 로컬 모의 구현·연결 계약 검사와 선택한 구성의 집행 승인 준비를 진행할 수 있다.
- **상태**: `OPEN / OWNER-APPROVAL-REQUIRED`

<a id="gap-maintenance-appendix"></a>

내부 문서 운영 기록은
[EG-Desk 제품 문서 화자·운영 정본](./egdesk-product-documentation-governance.md#doc-governance-top)에서 관리한다.
