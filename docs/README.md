# EG-Desk 문서

<a id="docs-start"></a>
<a id="문서-선택-가이드"></a>

## 지금 읽을 문서

현재 진행 중인 제품 설계 검토는 **[연결된 사용 흐름과 UI 추천안](references/design-synthesis/egdesk-ux-realization-proposals.md#flow-first-use)**에서 시작합니다.
9개 흐름에서 조작·입력·화면 반응·취소·복귀를 따라가고, 필요한 부분만 아래 문서로 이동하면 됩니다.

| 읽을 목적 | 문서 | 담긴 내용 |
|---|---|---|
| 사용 흐름과 설계안을 검토 | [사용 흐름·UI 추천안](references/design-synthesis/egdesk-ux-realization-proposals.md#ux-proposals-top) | 9개 구체 흐름과 추천·대안. 남은 정책 제안은 미승인 |
| 사용자처럼 한 동작씩 진행한 기록 확인 | [사용자 행동 리허설](references/design-synthesis/egdesk-user-action-rehearsal-log.md#results) | 8개 여정·9개 회차의 기록. 목표 도달·사용감·미도달·모형 공백을 구분 |
| 선택지의 차이를 비교 | [정책 추천안 7묶음](references/design-synthesis/egdesk-ux-realization-proposals.md#ux-policy-options) | 같은 UI 추천안 문서의 비교 절 |
| 결정된 것과 남은 선택 확인 | [사용자 확인 원장](codex/egdesk-product-interaction-trace-atlas-editorial-ledger.md#gap-owner-queue) | 질문·결정·현재 상태를 관리하는 한 곳 |
| 제품 기준의 사용법 확인 | [사용설명서 Atlas](../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-manual-start) | 제품 행동 정본. 미결정 control은 본문에서 구별 |
| 구현이 보장할 상태·원리 확인 | [기술 계약](../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-ui-trace-map) | 데이터·실행·권한·저장·복구의 기준 |

UI 추천안의 새 기본값은 승인 전까지 제품 기준을 바꾸지 않습니다. 정본에 적힌 설계와
실제 구현·검증 상태도 별개입니다.
현재 업무 구성의 제품 표기는 Board/Boards·보드입니다. Saved Board와 자동 Desk 복원은 별개이며,
Board가 새 Desk나 Canvas 자체를 뜻하지는 않습니다. 저장·공유·실행 수명 정책은 사용자 확인 원장에서 계속 구별합니다.

<a id="설명용-capability-시나리오"></a>

## 배경이 필요할 때

- [시나리오·기술 Capability](references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md): 7개 상황과 13개 기술 연결을 설명하는 설계 배경.
- [니즈 점검 기록](references/design-synthesis/egdesk-capability-scenario-connected-agent-work.md#needs-review): 18개 후보가 나온 상황·공백. 현재 추천안과 결정은 연결된 문서에서 확인.
- [실제 작업 근거 사례집](references/real-work-scenarios/README.md): 32개 사례와 출처. 필요한 근거가 있을 때 참조.

특정 포털·ERP의 메뉴·필드별 자동화 절차는 위 제품 시나리오와 별도 범위입니다.

<a id="현재-기준-문서"></a>

## 개발 기준과 구현 자료

현재 제품·구현 방향은 **Firefox shell**입니다.

- [제품·기술 전략](../ideas/confirmed/FIREFOX_SHELL_STRATEGY.md)
- [개발 로드맵](../ideas/confirmed/FIREFOX_SHELL_ROADMAP.md)
- [제품 비전·개발 할 일](../ideas/confirmed/EGDESK_PRODUCT_VISION_AND_DEV_TODO.md)
- [Firefox 구현 디렉터리](../apps/firefox-ui-demo/)

<details>
<summary>기능별 구현·기존 설계 참고 펼치기</summary>

각 문서의 작성 시점·상태를 확인하며, 제품 의미는 위 Atlas·기술 계약과 연결해 읽습니다.

- [Desk/Board/Card 런타임 모델 — 구 파일명](../apps/firefox-ui-demo/docs/DESK_AGENDA_CARD_RUNTIME_MODEL.md)
- [Chat 디자인 문법](../apps/firefox-ui-demo/docs/CHAT_DESIGN_GRAMMAR_V1.md)
- [AI 캔버스 주석 레이어](../apps/firefox-ui-demo/docs/AI_CANVAS_ANNOTATION_LAYER.md)
- Answer Briefing: [기술 기준](../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#tech-answer-briefing), [제품 개념](../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-obj-038)
- [기존 Run Playback note — historical/superseded](../apps/firefox-ui-demo/docs/CANVAS_RUN_PLAYBACK_MODEL.md)
- [Viewport 레이아웃·인터랙션](../apps/firefox-ui-demo/docs/VIEWPORT_LAYOUT_INTERACTION_MODEL.md)
- [Browser Agent 관찰 런타임](../apps/firefox-ui-demo/docs/BROWSER_AGENT_OBSERVATION_RUNTIME.md)
- [Human-in-the-loop await 모델](../apps/firefox-ui-demo/docs/HUMAN_IN_LOOP_WORKFLOW_AWAIT_MODEL.md)

</details>

<a id="문서-구조"></a>

## 참고·문서 운영

<details>
<summary>백서와 교육 자료 펼치기</summary>

### 백서 (Whitepapers)

| 문서 | 용도 | 현재 기준과의 관계 |
|---|---|---|
| [Production 백서 v8](production/EG-DESK%20백서%20-%20Production_v8_한글.md) | 제품의 이용 경험·핵심 원리·도입·협업 방향을 설명하는 국문 백서 | 2026-09-06 재작성. 제품 방향을 설명하며 구현·출시 완료 증거는 아님 |

EG-Desk 백서는 Production v8 한 개를 유지합니다. 구버전·Vision·영문 백서는 Git 이력에서
확인할 수 있습니다. 현재 제품·기술 판단에는 위 Atlas·기술 계약·Firefox 구현 자료를 사용합니다.

### 교육 자료

기존 11월 29일 교육 세션의 환경 설정·첫 자동화 스크립트·실습 프로젝트 자료는 `edu/`에
별도로 관리됩니다.

</details>

<details>
<summary>문서 위치·유지보수 규칙 펼치기</summary>

[제품 문서 운영 정본](codex/egdesk-product-documentation-governance.md#doc-governance-top)은
Main·PM·WM과 문서 유지보수자의 역할·출처·Q 항목·검증·이력을 다룹니다.
이후 시뮬레이션의 기본 운영과 개선안 검증·본문 반영은 [사용자·제품 Agent·System 연계 리허설과 개선 반복](codex/egdesk-product-documentation-governance.md#doc-sim-improvement-loop)을 따릅니다.

### 폴더 구조

```text
ideas/confirmed/                   제품 사용설명서·기술 계약·전략·로드맵
docs/
├── README.md                      문서 입구
├── references/design-synthesis/   시나리오 배경·구체 UX 추천안
├── references/real-work-scenarios/ 실제 작업 근거 사례집
├── codex/                         사용자 확인 원장·문서 운영 규칙
├── production/                    Production 백서
├── vision/                        비전 관련 참고 자료
└── superpowers/                   세부 스펙·계획
```

### 버전 관리

제품 방향은 Firefox 전략·로드맵을, 제품 동작은 Atlas·기술 계약을, 결정 상태는 사용자
확인 원장을 따릅니다. 미승인 대안 설명은 UI 추천안에 있습니다.

현행 백서는 `Production_v8`이며 후속 수정도 이 문서를 기준으로 합니다. 이전 버전은
Git 이력에 보존하며, 백서 갱신과 실제 제품 동작 검증은 구별합니다.

</details>

<details>
<summary>기존 문의 정보 펼치기</summary>

### 문의

- Production: contact@egdesk.com
- Vision·파트너십: vision@egdesk.com
- 일반 문의: www.egdesk.com

</details>

*목차 정리: 2026년 9월 6일*
