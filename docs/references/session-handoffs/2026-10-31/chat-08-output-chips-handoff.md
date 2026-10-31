# CHAT-08 hand-over (worktree chat-08-output-chips-ceb480, 2026-10-31)

브랜치 claude/chat-08-output-chips-ceb480 (7a5a031 위), 커밋 2개: 6f4b4fb(ChatState) → 69d205c(uc.js·CSS). push 안 함. ideas/confirmed·docs/codex 수정 없음.

## 화면에서 보이는 것
- Agent가 `egdesk_publish_output`으로 결과를 게시하면 그 답변 아래 결과 줄 맨 앞에 칩 하나: `[결과] 제목 · 버전 n` (testid `chat-output`, data-output-id/-output-key/-version). 자동 열기 없음, Chat 본문 중복 없음 (D-K4).
- 같은 outputKey로 다시 게시 → 새 칩이 아니라 그 칩이 `버전 2`로 바뀜. 다른 key → 칩 하나 더.
- 칩 클릭 → 칩에 '여는 중' → 브리지 `GET /context/outputs/:id?engineId&engineProfileId&clientThreadId&conversationId` → CHAT-04 결과 카드(`spawnResultCard`)로 Canvas에 열림. 제목·본문(markdown)·출처 줄(`출처 · {방} 대화 · {Agent}의 답변 · 게시한 결과 · 버전 n · 시각`)·'채팅에서 보기'(게시한 답변으로 복귀).
- 같은 key는 열린 카드를 포커스. 버전 2 칩을 누르면 열린 카드가 새 버전으로 다시 그려짐(제목·본문·출처 줄).
- 못 열면(구버전 브리지 404, 네트워크 실패, 본문 불일치) 칩에 '열 수 없음'만 남고 토스트 없음. 다음 클릭/렌더에서 다시 시도. Claude 방은 칩을 아예 안 그림(브리지가 claude에 publish 라우트를 막아 둠).
- Desk·Board 저장: 카드 기록 `source`에 outputId/outputKey/outputVersion이 함께 저장·복원(셋이 함께만 유효, 깨지면 일반 답변 카드로 복원). 채팅 기록(로컬 히스토리 run.context.outputs, legacy Desk 레코드의 message.outputs)에서도 칩이 되살아남.

## 파일
- `overlay/resources/EGDeskChatState.sys.mjs`: `publishedOutputRecord`/`upsertPublishedOutput`/`publishedOutputs`(key별 최신+versions), reducer `'output.published'`, `mergeChatSnapshot`(`incoming.context.outputs`·`incoming.outputs`), `projectRunMessages`(`last.outputs`), `projectLocalRunRelations`(outputs도 최종 답변에 결합), `legacyPublicChatSnapshot`(message/run/context.outputs), `restoreResultCardRecord`(source.outputId/outputKey/outputVersion), `publishedOutputCardRecord`, `resultCardKey`(`{room}/output/{key}`), `resultCardSourceView`.
- `overlay/JS/eg-desk-surface.uc.js`: `buildCodexOutputChips`·`openPublishedOutputChip`(buildCodexResultChips 옆), `spawnResultCard`(열린 카드 재그리기 `_renderResultRecord`, 본문은 내부 render 클로저), 메시지 렌더 블록은 3줄(outputChips 생성·resultRow 조건·prepend), 브리지 `openPublishedOutput`(toggleAnswerFold 옆).
- `overlay/CSS/eg-desk-surface.uc.css`: `.egd-codex-result-chip-output`, `.egd-codex-result-kind`, `.egd-codex-result-version`, `.egd-codex-result-state`, data-state opening/unavailable. 토큰만 사용.
- helper 변경 없음: `codex-chat-runtime.mjs snapshot()`이 run을 통째로 copy해 보내므로 `context.outputs`가 이미 overlay에 도달(grep으로 확인). 로컬 체크포인트도 `copy(run)`.

## 테스트 (고정 Node v24.22.1, 단건)
- scripts/egdesk-surface-state.test.mjs 952 (951 pass, 1 skipped, 0 fail) — 새 시험 7건(reducer/스냅샷·로컬·legacy/카드 기록/칩/클릭/카드 재그리기/브리지 읽기)
- scripts/egdesk-chat-presentation.test.mjs 9/9 · egdesk-surface-modules 13/13 · egdesk-design-tokens 37/37 · egdesk-chat-run-result 30/30
- helper/codex-chat-runtime.test.mjs 195/195 · helper/egdesk-context-core.test.mjs 107/107
- `node --check overlay/JS/eg-desk-surface.uc.js` ok
- 기존 시험 기대값 변경 1건: `spawnResultCard(` 호출 수 4→5 (칩 경로 = 브리지 openPublishedOutput이 추가된 설계 변경; 렌더·이벤트·run 종료에서는 여전히 호출 없음을 regex로 고정).

## 병합 시 주의
- 메시지 렌더 블록 `messageStack` 줄은 손대지 않음(surface-state regex 고정). `resultRow` 줄만 바뀜.
- `spawnResultCard`는 선언 1 + 호출 4가 됨 → 다른 브랜치가 같은 단언을 갖고 있으면 충돌.
- `egdesk-chat-presentation.test.mjs`가 자르는 블록(renderThreadSection·bridgeNotice)에는 새 심볼 없음 → keys 수정 불필요.

## 안 한 것 / 가정
- 실제 Firefox 창 미검증(메모리 제약). `GET /context/outputs` 목록 라우트(버전 목록)는 화면에서 아직 안 씀(칩이 versions를 들고 있어 불필요).
- D-K3 미결: 카드 기록에 본문 사본(≤20,000자)을 저장하는 CHAT-04 방식을 그대로 따름(채택 지도 '기본값으로 진행 가능'). 브리지 blob과 중복 저장이지만 브리지 없이도 Board 복원 가능. 'reference only'로 결정되면 `publishedOutputCardRecord`의 text를 비우고 복원 때 읽도록 바꾸면 됨(코드 주석에 남김).
- 칩의 '버전 1'도 항상 표시(브리프 '제목 + 버전 n' 그대로).

## 실화면 검증 항목
1. 긴 결과 게시 → 답변 아래 `[결과] 제목 · 버전 1` 칩, Canvas는 그대로.
2. 칩 클릭 → 결과 카드 열림, 출처 줄 '게시한 결과 · 버전 1', 마크다운 렌더.
3. 같은 outputKey 재게시 → 칩 `버전 2`, 클릭 시 열린 카드가 새 본문으로 바뀜.
4. 브리지 끈 채 클릭 → 칩에 '열 수 없음', 토스트 없음; 브리지 켜고 재클릭 → 열림.
5. Desk 저장 후 재시작 → 카드·칩 복원, '채팅에서 보기' 동작.

## ledger 갱신 제안 (main 세션이 PM에게)
- 상태표 CHAT-08 행: `일부` → `완료(실화면 미검증)`.
- 상세 진행: "진행(2026-10-31): `6f4b4fb`·`69d205c` 화면 연결(S3). 답변 아래 `[결과] 제목 · 버전 n` 칩(자동 열기 없음, 같은 key 재게시는 버전 2), 칩 → GET /context/outputs/:id → CHAT-04 결과 카드(같은 key는 열린 카드 포커스·새 버전 재그리기, '채팅에서 보기'), 못 열면 칩에 '열 수 없음'(토스트 없음), Claude 방 칩 없음, Desk·Board·로컬 기록 복원. surface-state 952(951 pass·1 skip), 나머지 단건 시험 fail 0."
- 상세 남은 것: "실제 Firefox 창 미검증. D-K3(카드 본문 사본 저장 vs 참조만) 미결 — 지금은 CHAT-04와 같은 사본 저장."
