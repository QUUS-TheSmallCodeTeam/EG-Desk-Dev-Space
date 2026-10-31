# CNV-06 Canvas Memo — hand-over note (session cnv-06-canvas-memo, 2026-10-31)

Branch `claude/cnv-06-canvas-memo-f3e067` (main `claude/vision-gap-20261024` merged in at a61b70f, no conflicts).

## What a user now gets
- Dock [메모] → a note card on the selected card's top-right (or the middle of the visible Canvas). Folded 240×160, [펼치기] → 320×280. No resize handles.
- The note pins to the card under it (ratio) and follows that card (MutationObserver on `#egd-canvas-layer`). Drag the note elsewhere → re-pinned (`moveMemo`). Card closed → '대상 없음' badge, note stays at its last point.
- Body textarea = the user's text (saved on input, 400ms). Saving never calls an Agent.
- Expanded: reply thread by author (user '나' / Agent avatar+name), a reply box, and Agent `<select>` + question + [<Agent>에게 묻기]. The ask goes into that Agent's own DM room (created if missing) through the normal `sendMessage()`; only an accepted request is recorded (`asks[].requestId/threadId`).
- Answer (D-K5): `syncProtocolRun` → `attachMemoRepliesFromRun(run)` → reply joins the memo once; memo expands. Chat message gets a '메모 #N 답글로 붙음' chip (D-K4).
- Desk/Board save & restore: card type 'memo', runtimeState = MemoRecord (`mountBoardMember`, `restoreCardFromState`).

## Where
- `overlay/resources/EGDeskMemoState.sys.mjs`: MEMO_FRAME, expanded, memoFrame/setMemoExpanded, asks.requestId/threadId, memoAskDraft target line, findPendingMemoAsk, memoReplyFromRun, memoAuthorName. (size/baseHeight/resizeMemo/memoDisplayHeight removed — no saved data existed.)
- `scripts/egdesk-annotation-memo.test.mjs`: 18 tests.
- uc.js: block 'Canvas Memo (CNV-06)' right before '// ============ Settings Canvas Card'. One-line hooks: MemoState import, DOCK_LEFT 'memo' + handler, `note` icon, cardKindForPersistence/runtimeStateForCard 'memo', mountBoardMember/restoreCardFromState 'memo', syncProtocolRun → attachMemoRepliesFromRun, chat chips row (3 lines: memoChipForAnswer), identity/minimap icon maps.
- CSS: `.egd-memo-*` after `.egd-result-card-files-title`.
- Docs: `docs/AI_CANVAS_ANNOTATION_LAYER.md` memo section.

## Not done / risks
- Firefox not launched: no real-screen check. Unknown: whether global Desk key handlers (Delete, ⌘W) interfere while typing in the memo textarea; whether `select` dropdown inside a Desk window behaves.
- Memo→card `links` are not drawn. '수정 전 메모에 대한 답' marker not shown. No reminder (재촉) notices.
- Board reopen with reassigned card ids: `anchor.cardId` inside runtimeState is not remapped by the restore path (only bindings are) → memo shows '대상 없음'.
- Chip appears on the next Chat render after the reply joins (no forced emit).
- memoId origin is not stored server-side; the user message text carries '[메모 #N · memo-id]' which is the de-facto trace. No helper changes.
