// L8 u2 (D7): where the person turns a Browser Card into something an Agent may observe or operate in a conversation, as DATA, read from the overlay (overlay/JS/eg-desk-surface.uc.js) and pinned by
// helper/egdesk-browser-grant-path.test.mjs against that file, so a change of the screen shows up here. The words are the screen's own (nothing new for the person).
//
//   operate (interact): the Browser CARD's own menu, not the attach window. Card toolbar "⋯" (data-testid browser-menu, menu 'Browser 더보기') -> "Chat 조작 허용".
//        Needs: a conversation open and active (state.codex.activeThreadId), a loaded page (not blank), the Card's tool binding current. Result: a notice '이 대화의 조작 대상으로 허용됨' and a
//        chip in the conversation card 'Browser · 이번 Chat 조작 허용 · 미전송'. The grant stands for the conversation (BRW-11: a fresh one-time token per turn without a new pick) until
//        "조작 허용 해제" in the same menu, a different page/account/container, or the Browser UI stream resetting (then it falls back to read-only).
//   read (observe): the same menu -> "Chat에 읽기 첨부" (or the attach window '+ 첨부': a checked Browser Card is attached read-only, chip 'Browser · 미전송'). An existing operate grant on that Card becomes read-only.
//   The attach window never grants operation: it only shows '이번 Chat 조작 허용 중' for a Card already granted by the menu.
// Engines: Codex conversations carry the grant to the run (executionPolicy browserBounded + the Card as a selected source). A CLAUDE conversation does too when the bridge lists the capability 'claude-browser'
// (EGDESK_CLAUDE_HARNESS=on and EGDESK_PAGE_TOOLS=on: u4, owner direction U19, see overlay/resources/EGDeskClaudeBrowserSend.sys.mjs); without it a CLAUDE conversation is refused on send by the screen
// ('현재 Claude 연결에서는 선택한 자료를 사용할 수 없어 보내지 않았습니다. 자료를 제외한 뒤 다시 보내세요.') whenever an attached Browser source is granted to operate, and Claude gets no live Browser
// source at all (Claude reads immutable captures only): the runtime side of a bounded Claude Browser run exists (egdesk-claude-bounded.mjs), the screen side is not enabled.
export const BROWSER_GRANT_PATHS = Object.freeze({
  interact: Object.freeze({ where: 'Browser 카드 툴바 ⋯ 메뉴', testid: 'browser-menu', menuLabel: 'Browser 더보기', item: 'Chat 조작 허용', notice: '이 대화의 조작 대상으로 허용됨', chip: '이번 Chat 조작 허용', needs: ['active_conversation', 'loaded_page', 'card_binding_current'], engines: Object.freeze(['codex', 'claude (capability claude-browser)']) }),
  observe: Object.freeze({ where: 'Browser 카드 툴바 ⋯ 메뉴, 또는 대화 카드의 + 첨부 창', item: 'Chat에 읽기 첨부', notice: '이번 Chat 읽기 자료로 선택됨' }),
  revoke: Object.freeze({ where: 'Browser 카드 툴바 ⋯ 메뉴', testid: 'browser-grant-revoke', item: '조작 허용 해제', notice: '이 대화의 조작 허용을 끝냄' }),
  claudeRefusal: Object.freeze({ code: 'CLAUDE_CONTEXT_UNSUPPORTED', text: '현재 Claude 연결에서는 선택한 자료를 사용할 수 없어 보내지 않았습니다. 자료를 제외한 뒤 다시 보내세요.' }),
})

/** The closed hint a page tool gives when the Card is not granted the way it needs (the engine words it for the person; the labels are the screen's own). */
export function grantHint(code) {
  if (code === 'PAGE_NO_INTERACT_GRANT') return Object.freeze({ needs: 'person_grant', how: 'browser_card_menu', item: BROWSER_GRANT_PATHS.interact.item })
  if (code === 'PAGE_NO_CARD') return Object.freeze({ needs: 'person_grant', how: 'attach_browser_card', item: BROWSER_GRANT_PATHS.interact.item })
  return null
}
