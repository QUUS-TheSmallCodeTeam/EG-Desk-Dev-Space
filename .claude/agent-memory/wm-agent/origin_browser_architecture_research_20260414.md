---
name: Browser Architecture Research 문서 생성
description: 2026-04-14 Session Lead 직접 작성. ADR 아닌 research doc, Open Questions 상태. ADR-007 결정 입력용
type: project
---

`ideas/brainstorming/BROWSER_ARCHITECTURE_RESEARCH.md` (396줄) — Session Lead가 유저 지시 "session lead가 적어"로 직접 작성한 브라우저 엔티티 아키텍처 조사 리포트.

**Why**: Browser entity를 Canvas 위에 올리는 방법을 결정하기 전, 렌더링 경로(Option A Electron+WebContentsView+OSR vs Option B Chromium/Firefox fork)와 full browser capability gap(OAuth, Chrome 프로필 import, Extensions MV2/MV3, DRM) 조사가 필요했다. POC 2026-04-13 naver.com OSR 30fps 결과 포함. ADR이 아니라 "근거 문서" — 결정은 ADR-007에서 (향후).

**How to apply**:
- 이 파일은 `ideas/brainstorming/` 에 놓임 (Open Questions, pre-decision). `.claude/docs/decisions/`가 아님 — WM 제안했으나 유저가 "brainstorm이 맞다"고 택함
- 본 문서가 citation하는 Open Questions 7개 (포지셔닝/DRM 필요성/확장 생태계 의존도/팀 규모 등)가 ADR-007 작성 시 Options Considered 축으로 연결될 것
- 기존 PRD 4개 (ideas/confirmed/BROWSER_*)와 직교 — PRD는 "무엇을 만드나"(기능), 이 문서는 "어떻게/어디까지"(렌더링 경로/한계). 중복 아님
- Blocker: ADR-006 Canvas Entity Foundation (entity-agnostic infra)
- 인접: ideas/brainstorming/BROWSER_UI_LIBRARIES_RESEARCH.md (UI 라이브러리 조사, 390줄) — v35 업데이트에서 함께 등록
- Vision 링크: docs/vision/ontology-bridge.md §2.3 "책상(Desk) = Canvas + WebContentsView"

**Pattern observation**: ADR이 아닌 "pre-decision research" 포맷이 `ideas/brainstorming/`에 축적되는 관행 확인 (ELECTRON_MAIN_PROCESS_OBSERVABILITY.md, BROWSER_UI_LIBRARIES_RESEARCH.md와 같은 축). 향후 비슷한 조사 리포트는 이 경로로 라우팅 권장.
