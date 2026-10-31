# CHAT-03 hand-over (chat-03-dm-to-board-thread, 2026-10-31 11:20 KST)

브랜치 claude/chat-03-dm-to-board-thread-c34176, 커밋 5개 (586e348 위): 7a2cfd4 → 3022a13 → aaaf04d → eeac9e6 → (docs).
push 안 함. ledger/TODO 수정 안 함.

## 동작 (화면)
- Agent DM 버블 ⋯ 메뉴: [Board Thread로 옮기기] / [여러 메시지 골라 옮기기](체크박스 + 로그 위 선택 바, 최대 20).
- 대상 선택: 기존 Board Thread 목록 또는 [새 Board Thread 만들기](DM의 Agent가 Lead).
- Board Thread: 복사본 블록(회차 저장 위치) + [원래 대화 보기] → DM의 그 버블로 이동(revealMessage 재사용).
- DM: 원래 버블 유지 + '스레드로 보냄' 칩(클릭 → 해당 Board Thread).
- Board Thread 헤더 [DM으로 돌아오기] → 가장 최근에 보낸 DM.
- @이름 칩(Board Thread 버블 아래), 방 목록 '@' 배지(안 읽은 Agent 줄이 @나/@사용자/@사람을 부름).

## 병합 시 주의
- 소유 영역 밖 수정 2곳: (1) `helper/codex-chat-runtime.mjs shareMessages` — 받는 쪽 대화가 store에 없으면 createConversation (2줄+주석). (2) `scripts/egdesk-surface-state.test.mjs` — 컴파일 키에 ThreadRouting 추가, branch-menu 테스트의 닫기 버튼 인덱스(메뉴 항목 2개 추가 반영).
- uc.js 메시지 루프의 세 소스 형태(messageStack 줄, appendPlanCards 순서, appendControlNotices→if(working))는 surface-state 테스트가 정규식으로 고정 → 복사본 블록은 '다음 저장 버블 앞' + 끝(trailing)에 끼움. AGENT-05(createCodexMessage L9796~)는 건드리지 않음.
- 새 sys.mjs: `overlay/resources/EGDeskThreadRouting.sys.mjs` (ChatState에서 clientThreadBinding import). 설치/복사 스크립트가 resources/*.sys.mjs를 통째로 복사하는지 확인 필요(QA 격리 매니페스트에는 추가 안 함).
- `/chat/board/send`(D-M2 라우팅)는 화면에 연결 안 함 — 멘션은 표시만. CHAT-10 범위.

## 테스트 (단건)
- node --test scripts/egdesk-thread-routing.test.mjs → 9/9
- node --test scripts/egdesk-chat-presentation.test.mjs → 9/9
- node --test scripts/egdesk-surface-state.test.mjs → 944 (943 pass, 1 skipped, 0 fail)
- node --test helper/codex-chat-runtime.test.mjs → 195/195 (D-M3 테스트에 fresh-room 공유 추가)
- node --test scripts/egdesk-design-tokens.test.mjs → 37/37
- Firefox 실행 검증 없음.
