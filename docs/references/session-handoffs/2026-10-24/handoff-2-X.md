화면 연결 작업자(S3/S10)
- Board 열기: service.openProject({boardId, roomId}) → view.openProject(result.project)를 부른다. status가 'reconnect-required'이면 pickers.chooseProjectFolder({boardId, roomId?, title?})로 다시 고르게 한다. Chat 머리에는 project.title을 쓴다.
- runCheck({projectId, rootId, script}) 연결:
  - run = TerminalState.createTerminalScriptRun({ write: d => writeQueue.enqueue(d), command: script.command, cwd: project.displayPath, shell: 'posix'|'powershell' })를 만든다.
  - 터미널 출력은 run.onData(chunk)로 넘긴다.
  - return await run.start()로 끝내면 결과 카드가 저절로 나온다.
- 승인 카드에는 ChangeReview.renderApprovalChanges({document, item, onDecision})를 붙인다. 적용 뒤에는 view.showChangeReview(changes)를 부른다(/chat/run-changes 행 또는 egdesk-file-change 모양).
- 활동·결과의 파일 링크는 view.openAt({path, line})로 연다.

2-E(bridge)
- 회차 시작 때 adapter.resolveProjectWorkspace(...).absolutePath를 Codex turn/start의 cwd와 allowedRoots로 쓴다. 그러려면 file-mount에 이 메서드를 넘겨 주는 한 줄이 필요하다.
- D-X4를 켤 때: createEGDeskGitCheckpoint({enabled:true})로 회차 시작과 끝에 capture → diff → fileChangesFromGitPatch → mergeTurnChanges({engine, checkpoint, root}) 순서로 잇는다.

1-R/2-R(runtime)
- Claude 결과는 fileChangeFromClaudeToolResult, Codex 결과는 fileChangeFromCodex로 같은 모양을 만든다.

Main 개발자
- 아래 commit_message를 쓰면 된다. 이번에 새로 만든 파일 4개는 git에 아직 추가되지 않은 상태다.