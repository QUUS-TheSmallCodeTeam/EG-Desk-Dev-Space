# 실행 결과 카드 (CODE-06) — 사용자가 입력한 명령의 결과

기준: 2026-10-31, 브랜치 `claude/code-06-run-result-surface-d13e97`.

## 사용자가 보는 것

- Terminal 카드에서 직접 입력한 테스트 명령(`node --test`, jest, vitest, `cargo test`)이 끝나면
  Terminal 위에 **명령 결과** 패널이 열리고, 헤더 오른쪽에 `2 통과 · 1 실패` 같은 칩이 남는다.
  칩을 누르면 패널을 접거나 다시 편다.
- 패널은 기존 결과 카드(통과/실패/건너뜀 수, 소요 시간, 실패 항목의 이름·`파일:줄`·첫 메시지 줄, 출력 끝부분)와 같은 모양이다.
- 실패 항목의 `파일:줄`을 누르면 선택한 Board의 프로젝트 File이 IDE 진입과 같은 경로로 열리거나 재사용되고, 그 줄로 이동한다.
  연결된 프로젝트 폴더 밖 경로는 열지 않고 안내만 한다.
- 요약을 읽을 수 없는 출력(종료 코드도 없음)은 `요약 없음 · 원문 보기`로 떨어지고 출력 끝부분이 펼쳐진 채 보인다.
- EG-Desk가 명령을 대신 실행하는 경로는 없다(D-X6). 사용자가 셸에 입력한 명령의 출력만 읽는다.

## 흐름

```
Terminal 입력(/terminal/write) ─┐
PTY 출력(appendOutput) ────────┼→ helper/egdesk-terminal-run-watch.mjs
                               │     Enter마다 출력 창(window)을 새로 시작, 러너 요약 종료 줄을 감지
                               │     (helper/egdesk-run-result-parse.mjs runSummaryEnd)
/terminal/read 응답 ←──────────┘   다음 read에 runResult 1건 (protocolVersion 1, command, counts, failures, output ≤ 64 KiB)
terminal.html(egdesk-terminal-init.js) → postMessage 'terminal-run-result'
EGDeskSurfaceTerminal.mjs → EGDeskRunResult.summarizeRunResult(output) → renderRunResultCard
실패 클릭 → EGDeskSurfaceFileCard.openBoardProjectFileAt → openBoardProjectFile() → FileView.openAt({path, relativePath, line})
```

- node --test는 요약(`duration_ms`) 뒤에 실패 상세를 찍으므로, 감지한 실행은 요약 줄이 아니라 **다음 read 또는 다음 Enter**에 읽어낸다.
- RT-06 버스의 `terminal.exit`를 구독해 종료한 세션의 창을 버린다. 세션 창 64 KiB, 세션 64개, 대기 결과 4건 한도.
- 입력에서 기억하는 것은 Enter로 확정된 한 줄(명령 라벨)뿐이다. 이스케이프 시퀀스(화살표·붙여넣기)는 읽지 않는다.

## 한계 (검증 범위)

- 모든 확인은 `node --test` 단건 시험이다. 실제 Firefox 창·실제 셸 왕복은 미검증.
- Terminal의 현재 폴더(`cd` 뒤)는 알 수 없어 상대 경로는 Board 프로젝트 폴더 기준으로 찾는다. 다른 폴더에서 실행한 결과는 파일을 찾지 못할 수 있다(안내만).
- `cargo test`는 바이너리마다 `test result:` 줄이 나와 한 명령에서 여러 결과가 올 수 있다(마지막 read가 합산 창을 받음).
- Chat의 짧은 요약 칩(Terminal 결과를 Chat에 투영)은 미구현 — CHAT-08 영역(`EGDeskChatRunResult.sys.mjs`)과 함께 정할 것.

## 시험

```
node --test apps/firefox-ui-demo/helper/egdesk-run-result-parse.test.mjs
node --test apps/firefox-ui-demo/helper/egdesk-terminal-run-watch.test.mjs
node --test apps/firefox-ui-demo/scripts/egdesk-surface-modules.test.mjs
node --test apps/firefox-ui-demo/scripts/egdesk-chat-run-result.test.mjs
node --test apps/firefox-ui-demo/scripts/egdesk-diff-run-result.test.mjs
```
