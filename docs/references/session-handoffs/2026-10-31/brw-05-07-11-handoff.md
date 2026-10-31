# BRW-05 + BRW-07 + BRW-11 hand-over (세션 brw-05-07-11, 2026-10-31 11:35 KST)

브랜치 `claude/brw-05-07-11-browser-tools-8c6387`, 커밋 5개 (push 안 함):
- c874a44 Add conversation-scoped browser grant and site rules module — `overlay/resources/EGDeskBrowserGrant.sys.mjs`(순수 규칙: D-B1 사이트 판정·D-B3 grant 수명·D-B2 기록), `scripts/egdesk-browser-grant.test.mjs`, `helper/codex-tool-errors.mjs`에 코드 2개 추가(소유 밖, 1줄).
- 7ac4105 Add allowed-site navigation and multi-card browser tools to the helper — runtime: 도구 5개 append(list_cards·request_site·open_card·close_card·history), navigate를 `evaluateNavigation`(url-policy)로, binding.navigationPolicy(UI 응답에서 채택). provider: interact 카드 ≤4, card-opened/closed로 run.browserBinding.cards 갱신+이벤트, navigation {reason, host} 노출.
- 3c37118 Wire conversation grants, allowed sites and agent-opened cards into the Browser Card — uc.js: `browserToolThreadGrants`/`browserToolThreadSites`, 턴마다 토큰 재발급(`browserToolRefreshSelection`), bind/observe 응답에 navigationPolicy, request kind allow-site/open-card/close-card/history(`browserToolCardRequest`), allowed-site navigate는 chrome 경로(`toolNavigateChrome`), commit layer(onLocationChange → about:blank), 사이트 허락 패널(`toolAskSite`), 메뉴 '조작 허용 해제', agent-opened 표시. CSS 2블록. 하네스 테스트 2개 파일에 grant 구간 공급 + BRW-11 테스트 1개.
- 633bbea Document … — `docs/BROWSER_AGENT_OBSERVATION_RUNTIME.md` Tools 표·새 절·Wiring Status.
- (마지막) Guard link and redirect landings … — actor 경로 navigate/click/press 뒤 착지도 commit 검사, 미사용 재발급 토큰 정리.

## 병합 시 주의
- Child/Parent actor(BRW-09 소유) 미수정. `helper/codex-chat-runtime.mjs` 미수정(공유 도구 목록으로 자동 반영). `codex-tool-errors.mjs` 1줄만.
- uc.js 변경은 모두 브라우저 도구 transport 함수들(L14985~15900대)과 spawnBrowserCard 내부(toolAct 뒤·_browserControls·onLocationChange·showBrowserMenu)와 상단 import 1줄. Settings/Chat/Popup/Canvas/Board 구역 미접촉.
- 하네스(`scripts/egdesk-browser-tool-transport.test.mjs`, `scripts/egdesk-surface-state.test.mjs`)는 uc.js를 텍스트 구간으로 자르므로, 다른 세션이 같은 구간 앵커 문자열(`const browserToolActionLeases = new Map();`, `const browserToolFixtureAuthorizationByCard = new Map();`, `function registerBrowserToolSelection(`, `card._browserControls = {`)을 바꾸면 깨짐.
- 미검증: 실제 Firefox 실행(스폰 카드의 toolBinding 준비 시점, documentURI vs location.href 비교, about:blank 대체 흐름, 55초 허락 패널). 하네스가 open-card/close-card/history/allow-site UI 핸들러는 직접 돌리지 않음(helper 쪽만 테스트).

## 가정
- 유휴 만료 30분(D-B3에 수치 없음). Stop도 standing grant 종료(보수적). observe 선택은 기존대로 1회용. 카드 4개/Run 상한. 허용 사이트 요청 대기 55초(transport 60초 상한 안).
