# CHAT-03 구현 계획 (chat-03-dm-to-board-thread 세션, 2026-10-31 03:58 KST)

## 발견
- helper 쪽 D-M3는 이미 2d9672e에 있음: `POST /chat/share` → `codex-chat-runtime.mjs shareMessages()`,
  store 이벤트 `messages.shared.in`(받는 쪽, link+messages 복사본) / `messages.shared.out`(보내는 쪽, link+localMessageIds),
  받는 쪽 다음 turn에 `<egdesk-shared-messages>` 블록 첨부(`pendingShares` → additionalContext) + `messages.shared.attached`.
- 화면(uc.js)·state(ChatState)·CSS는 전부 없음. 선택 모드 없음(messageMenu는 fork 전용).
- 공백: `shareMessages`는 `to` 대화가 store에 없으면 404 → 새 Board Thread로는 못 보냄.

## 계획
1. 신규 순수 모듈 `overlay/resources/EGDeskThreadRouting.sys.mjs` + `scripts/egdesk-thread-routing.test.mjs`
   - 선택 메시지 → localMessageIds 해석, share 요청 본문, `messages.shared.*` 이벤트 → thread.routing 모델,
     share 응답 즉시 반영, 복사본 블록 배치(localSeq 기준), @태그 파싱(사용자/Agent, runtime boardMentions와 같은 규칙), 멘션 배지.
2. ChatState: `reduceChatEvent`에서 live 메시지에 `localMessageId` 전달(1줄).
3. runtime `shareMessages`: 받는 쪽 대화가 없으면 생성(1-2줄, 소유 영역 밖 배선 → 보고).
4. uc.js: state `messageSelect`/`boardMove`, 메시지 메뉴 항목 + 선택 바, Board Thread 선택 패널, bridge
   `moveMessagesToBoardThread`/`openSharedOrigin`/`returnToDm`, 복사본 블록·'원래 대화 보기', DM '스레드로 보냄' 칩,
   헤더 [DM으로 돌아오기], @태그 칩 + 방 목록 '@' 배지. 히스토리 로드 시 routing 병합(1줄).
5. CSS 규칙 (.egd-codex-thread-unread 옆 / message-menu 옆).
6. 단건 테스트: `node --test scripts/egdesk-thread-routing.test.mjs` (+ runtime 변경 시 `helper/codex-chat-runtime.test.mjs`).
