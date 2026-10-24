연결 계약(어댑터 작업자, 1-C·1-E 끝난 뒤):
```
exe = resolveClaudeExecutable(env)            // 1-E claude-engine-auth
st  = await engineStatus.refresh()            // 1-E: { version:'2.1.300', auth }
broker = createClaudePermissionBroker({ threadId }); mcp = createEgdeskClaudeMcp({ threadId, tools }); tr = createClaudeTranslator({ threadId })  // 1-C
t = createClaudeTransport({
  executablePath: exe, cwd, version: st.version, sessionId: <UUID> | resume: <UUID>,
  model, effort, appendPrompt: <Agent 말투>, mcpConfig: egdeskMcpConfig(), allowedTools: [egdeskAllowedToolsRule()],
  apiKeyEnvPolicy: confirmed ? 'strip' : 'stop',
  controlHandlers: {
    can_use_tool: (request, { requestId }) => { const r = broker.request({ kind:'canUseTool', requestId, subtype:'can_use_tool', request }, { turnId, cwd }); if (r.write) return r; if (r.serverRequest) runtime.handleServerRequest(r.serverRequest) },
    mcp_message:  (request, { requestId }) => { const r = mcp.handle({ kind:'mcpMessage', requestId, request }, { turnId }); if (r.write) return r; if (r.serverRequest) runtime.handleServerRequest(r.serverRequest) },
  },
  onControlCancel: (id, subtype) => subtype === 'can_use_tool' ? broker.cancel(id) : mcp.cancel(id),
  onMessage: msg => tr.translate(msg).forEach(n => runtime.handleNotification(n)),
  onNotice, onExit: () => { broker.abortAll(); mcp.abortAll() },
})
await t.start()
// runtime 답장: w = broker.respond(rpcId, result, err) || mcp.respond(...); if (w) t.respondControl(w.write.response.request_id, w)
// 사용자 메시지: t.sendUserMessage(text|blocks). 중지: tr.markInterruptRequested(); await t.interrupt()
// 닫기: await t.close()
```
- 오류 코드별 화면 처리:
  - CLAUDE_API_KEY_DETECTED → 확인 카드를 띄우고, 확인하면 `'strip'`으로 새 transport를 만듭니다. transport는 한 번만 start할 수 있습니다.
  - CLAUDE_VERSION_UNSUPPORTED/UNKNOWN, CLAUDE_NOT_FOUND → 안내 문구를 띄웁니다.
  - onNotice fatal(CLAUDE_CAPABILITIES_MISSING·CLAUDE_CAPABILITY_MISSING·CLAUDE_VERSION_UNSUPPORTED) → 이 claude 버전으로는 진행할 수 없다고 알립니다.
  - info().init.billsApiKey가 true → '종량 과금' 배지를 붙입니다(SUB-15).
- 맞춰야 할 것:
  - 1-E의 CLAUDE_VERSION_POLICY.minimum은 '2.1.111'(표시용)이고 transport가 실제로 실행을 막는 하한은 '2.1.205'입니다. registry 표시와 맞춰야 합니다.
  - 두 모듈 모두 `parseClaudeVersion`을 내보내므로 같이 import할 때는 별칭을 써야 합니다.
- 격리 때문에 달라지는 동작:
  - ~/.claude/settings.json의 permissions·model·env가 적용되지 않습니다. 도구 승인 질문이 더 자주 오고, 모델은 transport의 model 옵션으로 넘겨야 합니다(AGENT-08).
  - inherit.instructions를 켜면 user settings.json의 env(API 키 포함)가 다시 들어올 수 있습니다(claude-agent-acp acp-agent.ts:11452). 이 경우 init.billsApiKey로 감지합니다.
- 2-E 첫 단계로 실제 claude 2.1.300에서 한 번 확인할 것: stdio 왕복, `--setting-sources=` 수락 여부와 CLAUDE.md 제외, 키체인 로그인 공유, init.capabilities 목록. 문서 7장의 '확인 필요' 행과 같습니다.
- 이 단계 앞에 전달된 대표님 질문("맥 컴퓨터 유스는 러스트로는 안되나 보지?")은 이 작업과 다른 주제라 여기서는 답하지 않았습니다. Main이 따로 답해야 합니다.
- WM file-map에 새 파일 2개를 등록해야 합니다.