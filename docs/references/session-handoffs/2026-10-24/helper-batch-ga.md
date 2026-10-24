[화면(surface·actor) 작업자용 계약 — 이름과 타입은 그대로 쓴다]

A. helper → 화면 요청 (bind/observe/act/cancel 모두)
- seq: 양의 안전 정수. run(바인딩)마다 1부터 시작해, 실제로 넘긴 요청마다 1씩 오른다. 화면은 받기만 하고, 영수증 대응에 쓸 수 있다.
- sentAtMs: number. helper의 performance.timeOrigin+performance.now() epoch ms이고 소수가 있을 수 있다.
- deadlineMs: 기존 그대로 Date.now 기준 정수.
- act의 guard.innerWindowId, guard.browsingContextId: observe 응답 snapshot의 최상위 키 `innerWindowId`(this.manager.innerWindowId), `browsingContextId`(browsingContext.id)를 helper가 값 그대로 복사한다. 키가 snapshot에 있을 때만 들어간다. Parent authorizeAct에서 windowGlobal.innerWindowId와 비교하는 일은 화면 쪽 몫이다.

B. 화면 → helper act 거절: { requestId, status:'rejected', error, dispatchPhase, timing? }
- dispatchPhase:'not-dispatched'는 아래 경우에만 쓴다.
  - lease가 승인되지 않음. surface fail()의 activityLease?.authorized !== true인 경우로, hold·stop·cancel·크기 초과·fingerprint·preflight·authorizeAct 거부를 포함한다.
  - actor가 actorPerformCalls 불변을 확인함. 예: 승인 뒤 assertGuard 실패, deadline-expired-after-approval.
  - 이때 timing에 performEnterMs·performExitMs·firstEventAtMs를 넣지 않는다(또는 null). 횟수를 넣는다면 Before·After 둘 다 같은 정수로 넣는다.
- 'dispatched': perform에 들어갔다(횟수 증가).
- 'unknown': 확신할 수 없는 모든 경우. 예: 승인 뒤 sendQuery 거절인데 횟수를 모름.
- helper 동작:
  - not-dispatched → 관찰만 소모, 잠금 없음, 모델에 BROWSER_OBSERVATION_STALE.
  - dispatched·unknown·필드 없음·형식 이상·반박됨 → 잠금, BROWSER_ACTION_UNVERIFIED(기존과 같음).

C. 화면 → helper 응답 최상위 timing (선택, 모든 kind). 키별로 선택이다.
- receivedAtMs: surface가 browserToolDispatch에서 요청을 받은 시각.
- authorizedAtMs: authorizeAct가 authorized=true를 돌려준 시각.
- performEnterMs / performExitMs: actor perform() 직전과 직후.
- firstEventAtMs: actor가 이 동작의 첫 DOM 이벤트를 보내거나 관찰한 시각.
- 위 시각은 모두 그 전역의 performance.timeOrigin+performance.now()로 찍은 finite number, 0 이상이다.
- performCallsBefore / performCallsAfter: actorPerformCalls 전후 값, 0 이상 안전 정수.
- helper는 이 7개 키 중 형식이 맞는 것만 보존한다.

D. helper 출력
- 관찰·대기·동작 결과에 timing:{seq, sentAtMs, responseAtMs, ...C}가 붙는다.
- 카드가 잠겨 있으면 관찰·대기 결과에 uncertainAction:{action, timing:{seq, sentAtMs, timedOutAtMs 또는 responseAtMs, ...C}}가 붙는다.
- 프로세스 안의 오류 객체에는 error.timing과 error.dispatchPhase가 붙는다. 공개 경계에서는 빠진다.
- transport timeout 오류에는 seq, sentAtMs, timedOutAtMs가 붙는다.

[Main 개발자 · live verify 담당 참고]
- 화면이 not-dispatched를 보내기 시작하면, 스크립트들이 stale-DOM·resize·옛 문서 동작에 대해 BROWSER_ACTION_UNVERIFIED를 기대하는 곳(scripts/verify-firefox-mcp-native-tool-flow.mjs:2255-2259, :2920, :3147, :3399, .test.mjs:1023-1026)은 BROWSER_OBSERVATION_STALE(uiActRequests 1)로 바뀔 수 있다.
- 따로 본 것: surface의 요청 크기 상한(fingerprint.length > 24000, surface:13957 부근)이 helper의 fill 상한(JSON 40000)보다 작다. 줄바꿈이 많은 긴 fill은 화면에서 '크기 초과'로 거절될 수 있다. 이 거절은 보내기 전에 일어나므로 not-dispatched로 표시하는 게 맞다.
- 도구 inputSchema와 설명 문구(BROWSER_TOOL_SPECS)는 바꾸지 않았으므로 manifest hash는 그대로다.
- 커밋 대상은 helper 4개 파일이다.