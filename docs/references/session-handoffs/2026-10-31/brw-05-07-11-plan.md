# BRW-05 + BRW-07 + BRW-11 구현 계획 (세션 brw-05-07-11, 2026-10-31 03:58 KST)

## 문서 리뷰 결과 (코드 기준, ledger 본문은 일부 stale)
- navigate 카탈로그 노출은 BRW-06에서 이미 됨: `BROWSER_INTERACTION_TOOL_NAMES`에 `egdesk_browser_navigate` 포함, provider·codex-chat-runtime 둘 다 그 공유 목록을 쓴다(provider.test L71·L279가 이미 navigate 통과를 확인). ledger L929-937의 "188-191/96-99에서 걸러짐"은 옛 상태.
- BRW-05 잔여 = D-B1 허용 사이트 규칙. 순수 모듈 `helper/egdesk-browser-url-policy.mjs`(evaluateNavigation·addAllowedSite, 배치 1-X)가 있으나 B 서비스는 아직 `sameSiteNavigation`만 쓴다. actor(Child, BRW-09 소유)는 same-site를 하드코딩 → 허용 사이트 이동은 actor 대신 parent(uc.js) 경로(`chrome-load-uri`)로 보낸다.
- BRW-11: UI의 selection token이 1회용(`usedRunId`)이라 매 턴 재허락. helper prepare는 "요청마다 명시적 UI selection"을 요구하므로 **UI가 대화 단위 standing grant에서 턴마다 토큰을 재발급**하면 helper 변경 없이 D-B3 수명이 된다.
- BRW-07: 도구 인자가 모두 `cardId`를 받으므로 "카드 전환" = 다른 bound card를 지명. 새 도구: open_card/close_card/history + list_cards(read) + request_site(허용 사이트 요청).

## 건드릴 파일·함수
- `helper/egdesk-browser-tool-runtime.mjs`: BROWSER_TOOL_SPECS 끝에 5개 spec 추가(list_cards·request_site·open_card·close_card·history), BROWSER_READ/INTERACTION_TOOL_NAMES 갱신, validateArgs 분기, binding.navigationPolicy(bind/observe 응답의 `navigationPolicy` 채택), navigate 검사를 `evaluateNavigation`으로, executeDispatch에 새 도구 처리, guard.navigationScope `same-site|allowed-site`.
- `helper/codex-browser-tool-provider.mjs`: prepare의 interact 1카드 제한 → 명시 선택 ≤4, SUCCESS_STATUSES·PUBLIC_INPUT_ROUTES 추가, dispatch 후 card-opened/closed로 run.browserBinding.cards 갱신 + 이벤트, publicBrowserErrorDetail에 navigation {host, reason}.
- `helper/codex-tool-errors.mjs`: BROWSER_CODES에 2개 코드 추가(소유 밖, 배선 1-2줄 — 보고에 명시).
- `overlay/resources/EGDeskBrowserGrant.sys.mjs`(신규, 순수): grant 수명 규칙(D-B3)·사이트 판정(D-B1)·policy 직렬화. 테스트 `scripts/egdesk-browser-grant.test.mjs`.
- `overlay/JS/eg-desk-surface.uc.js`: (a) 상단 import 1줄, (b) 브라우저 도구 transport 구역(`browserToolThreadGrants`·`browserToolThreadSites`, registerBrowserToolSelection·browserToolSelectedSources 재발급, revoke 경로, bind/observe 응답에 navigationPolicy, 새 request kind allow-site/open-card/close-card/history, navigate allowed-site parent 경로), (c) spawnBrowserCard 안: toolNavigateChrome·toolHistory·toolAskSite·agentNavigationGuard(commit layer, onLocationChange)·메뉴 '조작 허용 해제'·agent-opened 표시.
- `overlay/CSS/eg-desk-surface.uc.css`: Browser agent 규칙 옆에 site-ask 패널·agent-opened 라벨.
- 테스트: `helper/egdesk-browser-tool-runtime.test.mjs`, `helper/codex-browser-tool-provider.test.mjs`(L71 기대 수정 + 추가), 신규 grant 테스트.
- 문서: `docs/BROWSER_AGENT_OBSERVATION_RUNTIME.md` Tools·Wiring Status.

## 범위 밖
- Child/Parent actor 수정 없음. transport 모듈 수정 없음. ledger/TODO 수정 없음. D-B10/D-B11 미구현.
- Settings·Chat·Popup capture·Canvas·Board 구역 수정 없음(단, 브라우저 도구 transport 함수들은 파일상 Settings 마커 뒤(L14985~)에 있으나 과제가 grep으로 지정한 내 영역).

## 가정
- 유휴 만료 30분(D-B3에 수치 없음). Stop도 standing grant를 끝낸다(보수적). observe 선택은 기존대로 1회용.
