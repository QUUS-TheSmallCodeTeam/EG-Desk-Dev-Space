# CHAT-01 — 채팅 프로필(Agent) 선택 영속화 복원 연결 (worktree chat-01-agent-persist-901f75)

작성 2026-10-31. 브랜치 `claude/chat-01-agent-persist-901f75` (7a5a031 위), 커밋 4개, push 없음. 원장·docs 수정 없음.

## 사용자가 보는 변화
- 어떤 방에서 Agent를 골라 대화한 뒤 브라우저를 재시작하거나 Board를 복원해도, Desk pref가 없어도 그 방이 같은 Agent로 돌아온다(대화 저장소 v3 `thread.agent`에서 복원).
- 보내기 없이 ⋯ 메뉴에서 Agent만 바꿔도(또는 '기본 Codex'로 되돌려도) 저장소에 바로 기록된다 → 재시작 뒤 되살아나는 '옛 Agent' 없음.
- 저장소의 Agent가 카탈로그에 없음·보관·중지면 그대로 '찾을 수 없는 Agent' placeholder + 보내기 차단. 다른 Agent로 바꿔치기 없음.

## 규칙 (코드 주석에도 있음)
- **pref 우선**: 화면 thread가 `profileEnabled === true`면 pref 선택 유지. store agent는 `profileEnabled`가 true가 아닐 때만 채움(`EGDeskChatState.restoredRoomAgentFields`).
- **`thread.agent` 필드**: 서버 전용 agent를 떼지 않고 **명시 필드**로 둠 — 항상 snapshot(서버) 값으로 덮어씀(pref 사본은 교체). 옛 브리지(필드 없음)면 방의 것 그대로. pref에도 같이 저장되지만 복원 동작은 `profileEnabled/agentProfileId`만 본다.
- **revision**: 복원에 적용 안 함, `thread.agent.revision`으로 보존·전달만. ⋯ 메뉴 쓰기는 보내기와 같은 값(카탈로그 activeRevision, 없으면 null)을 보냄.
- **`POST /chat/rooms/agent`**: `CHAT_ACTIONS`에 들어가되 `LOCAL_WRITES`로 엔진 계정 확인(ensureAuth) 면제 — 로그아웃 상태 선택도 기록, 오프라인 QA 프로브도 기록 가능. 보낸 적 없는 방은 404(화면은 조용히 넘김, 첫 보내기가 기록).

## 커밋
- `66d4162` ChatState `roomAgentRecord`·`restoredRoomAgentFields` + hydrate 연결, uc.js `ensureLocalHistoryThread`에 store agent 전달, surface-state 시험 2개.
- `c34e2d9` verify-chat-history-restart: `assertRoomAgent`(양쪽 라우트 thread.agent 형태) + 체크포인트 `roomAgent` + 재시작 뒤 동일 단언.
- `47f7c4f` 라우트·runtime `setRoomAgent`·uc.js `setThreadAgentProfile` 서버 쓰기 + http/runtime/surface-state 시험.
- `7fb5089` verify-chat-history-restart seed 단계에서 `POST /chat/rooms/agent`로 QA Agent 기록 후 양쪽 라우트 단언.

## 검증 (고정 Node v24.22.1, 단건)
- egdesk-surface-state 948/947 pass/1 skipped(기존)/0 fail · egdesk-chat-presentation 9/9 · egdesk-surface-modules 13/13 · egdesk-thread-routing 9/9 · egdesk-chat-store 26/26 · codex-chat-runtime 196/196 · codex-bridge-http 36/36 · `node --check` uc.js/verify/runtime/http 통과.
- **미실행**: Firefox 실화면, verify-chat-history-restart(재시작 프로브), 전체 glob.

## 병합 시 주의
- uc.js 수정 2곳만: `ensureLocalHistoryThread`(L11216 근처, 옵션 2줄+storeAgent 1줄) · `setThreadAgentProfile`(L12791 근처, fetchJson POST 블록). 다른 세션 영역(AGENT-05 L245-370·L9245-9410, CHAT-03 메시지 루프) 미접촉.
- surface-state 시험이 `setThreadAgentProfile` 블록을 `cycleThreadAgentProfile` 앞까지 잘라 컴파일 → 그 블록에 새 식별자를 넣으면 keys도 함께.
- Board 저장 record(chat card)에 thread binding 추가는 범위 밖(원장 '빠진 것' 3번째 항목) — 미착수.
