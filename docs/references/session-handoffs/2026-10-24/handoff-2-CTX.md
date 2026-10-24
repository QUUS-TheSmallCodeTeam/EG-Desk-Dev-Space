1) bridge 1줄(2-M 또는 2-E, codex-bridge-server.mjs). `workflow = await openWorkflowRuntime({...})` 바로 뒤에 넣습니다:
   `contexts.attachServices({ bus: workflow.bus, settings: bridgeSettings.contextSuggest, boards: deskStore })`
   선택 사항: 경로로 캡처한 파일까지 맞추려면 :169를 `onRootRegistered: root => { workflow?.watchRoot(root); contexts.noteRoot(root) }`로 바꿉니다.
2) egdesk-file-service.mjs 소유자: resolveCaptureSource 반환값에 `location: { rootId: resource.rootId, relativePath: toPosix(resource.relativePath) }`를 추가해 주세요. draft.fileId의 resource 기준이며, 형식은 file.changed와 같아야 합니다. 그러면 File 창 작업사본도 '바뀜'이 됩니다. store 쪽은 이미 받습니다.
3) S10(화면):
   - 신호: Browser 자원에 `site: new URL(uri).hostname`, 목록 폴더 안의 파일에 `userExcluded: true`(폴더 목록은 GET /context/suggest-settings), `firstMessage`(방에 메시지가 없을 때), `query`(지금 쓰는 말, 저장하지 않음)를 넣습니다.
   - 응답의 suggest.omittedByUser로 숨긴 수를 보여줄 수 있습니다.
   - EGDeskChatState에서 CONTEXT_KIND_LABEL에 'board', CONTEXT_REASON_TEXT에 'matchingBoard'를 추가합니다. Board 제목은 boardTitleFor로 가져옵니다. Board 후보를 고르면 kind 'board' 캡처(sourceRef.viewId = boardId)로 붙입니다. prepare는 고른 ref를 uiId나 viewId로 맞춥니다.
   - 칩 '바뀜': 방을 열 때와 workflow.event(topic file.changed / browser.navigated) 프레임을 받을 때 GET /context/sources?conversationId=를 다시 읽습니다. 응답 항목 {state, reason, changedAt, announcedAt}. 알린 회차에는 chat 이벤트 'context.sources.changed'가 옵니다.
   - 설정 UI는 GET/POST /context/suggest-settings {mode, neverSuggest}입니다.
4) codex-chat-runtime.mjs 소유자에게: 작업 중 :399 정규식에 U+2028·U+2029 글자가 그대로 들어가 문법 오류가 났고, 제가 Main에 알렸습니다. 지금은 고쳐져 있습니다.
5) 전체 helper 시험에서 egdesk-host-agent.test.mjs(2-CH 소유)가 11분 동안 끝나지 않아 제 시험 프로세스를 멈췄습니다. 그 파일의 시험 2개가 실패로 남았습니다.