S1(화면 연결, eg-desk-surface.uc.js)에 넘기는 계약:
1. act 요청의 새 필드
   - callId(≤160), budgetMs(1..60000, 모든 요청 종류에 붙음).
   - browserToolAct가 actor options에 넘길 것: callId, 그리고 budgetMs에서 이미 쓴 시간을 뺀 값. 계산은 budgetMs - (browserToolClock() - sentAtMs) - BROWSER_TOOL_REPLY_MARGIN_MS이고, 0 이하면 not-dispatched로 거절한다.
   - settleMs:150은 이제 쓰이지 않는다. 지우거나 settle:{maxMs}(낮추기만 됨)로 바꾼다.
2. 새 요청 종류 'reconcile'
   - 요청: {kind:'reconcile', callId, actRequestId?, actSeq?, guard:{documentId, innerWindowId?, browsingContextId?}, budgetMs:3000, binding, …공통 필드}
   - 처리: run binding을 observe처럼 검사한다. lease는 만들지 않고, browserToolCardLeases(조작 중 잠금)에 막히면 안 된다.
   - 현재 windowGlobal의 innerWindowId가 guard와 다르면 actor에게 묻지 않고 {status:'reconciled', reconcile:{version:1, callId, entered:'unknown', reason:'other-document'}}로 답한다.
   - 같으면 actor.sendQuery('reconcile', {callId, requestId: actRequestId, documentId: guard.documentId})의 답을 {requestId, status:'reconciled', reconcile:<답>, timing:{receivedAtMs}}로 돌려준다.
3. 대화상자: act·reconcile 응답에 dialog:{type:'alert'|'confirm'|'prompt'|'beforeunload'}를 넣는다(메시지 글자는 넣지 않음). 예: xul browser의 DOMWillOpenModalDialog나 tab-modal prompt 이벤트. helper는 이 응답을 결과 미확정·잠금으로 처리한다.
4. obscuredBy: actor 거절에 obscuredBy(구조 설명) 필드가 생겼다. browserToolAct의 browserToolActor와 fail()의 rejected 응답에 그대로 실어 준다. 지금은 helper가 고정 메시지 'obscured by …; observe again'에서 읽어 동작한다.
5. hop 기록: actor timing에 actorReceivedAtMs가 생겼다. BROWSER_TOOL_TIMING_MS 허용 목록에 추가하면 helper 영수증까지 간다(helper는 이미 받음).
6. wait_text는 kind 'observe'와 options.wait {for:'text'|'text-gone', text, timeoutMs}로 오므로 화면 변경은 필요 없다. 다만 recordAgentToolActivity나 활동 줄에 wait.text를 기록하지 않는지 확인한다.
7. snapshot 새 키 scrollContainers와 role clickable·scrollable은 표시용으로만 참고한다.

2-R/1-R(codex-chat-runtime.mjs·codex-chat-tool-ceiling.mjs)에 넘길 것:
- runtime :40의 BROWSER_INTERACTION_TOOLS 사본을 BROWSER_INTERACTION_TOOL_NAMES import로 바꾼다.
- collectToolSpecs(:483-486)와 도구 호출 판정(:1999-2003)에서 observe 자리를 BROWSER_READ_TOOL_NAMES로 넓힌다.
- :1349 readOnlyNames와 ceiling :13 BROWSER_OBSERVE_TOOLS에 egdesk_browser_wait_text를 넣는다.

QA(native-tool-flow 소유자)에 넘길 것:
- verify-firefox-mcp-native-tool-flow.mjs:3397 기대 목록에 'egdesk_browser_wait_text'를 추가한다. interact는 끝에 붙이고, observe는 [observe, wait_text]다.
- browserBehaviorFixtureHtml(scenario, marker)로 6개 시나리오를 같은 /egdesk-qa/<marker> 경로에서 서빙하면 실제 Firefox 확인이 가능하다. 시나리오마다 기대값 문장을 BROWSER_BEHAVIOR_SCENARIOS[].expect에 적어 두었다.

Main(커밋)에 넘길 것:
- 1-R이 import할 목록 export는 runtime :79-85다. 단독 커밋을 원하면 그 블록만 먼저 넣으면 된다. 목록에 wait_text 이름이 들어 있으므로 함께 커밋하는 편이 깔끔하다.