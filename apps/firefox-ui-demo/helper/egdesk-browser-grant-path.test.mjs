// L8 u2 (D7): the grant paths are what the screen's code says (a static check of the overlay), the Claude gate is pinned, and the tools tell the engine where the person grants.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BROWSER_GRANT_PATHS, grantHint } from './egdesk-browser-grant-path.mjs'
import { claudeContextSendErrorText } from '../overlay/resources/EGDeskChatState.sys.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const surface = fs.readFileSync(path.join(here, '..', 'overlay', 'JS', 'eg-desk-surface.uc.js'), 'utf8')
const P = BROWSER_GRANT_PATHS

test('operating is granted in the Browser card\'s own menu: toolbar menu button, "Chat 조작 허용" -> interact; read-only via "Chat에 읽기 첨부"; revoke in the same menu', () => {
  assert.ok(surface.includes(`data: { testid: '${P.interact.testid}' }`) && surface.includes(`'aria-label': '${P.interact.menuLabel}'`), 'the card toolbar menu button and its menu')
  assert.ok(surface.includes(`'${P.interact.item}'`) && surface.includes(`'다시 조작 허용'`))
  assert.ok(surface.includes("selectBrowserForChat('interact')") && surface.includes("selectBrowserForChat('observe')"))
  assert.ok(surface.includes(`item('${P.observe.item}'`) && surface.includes(`item('${P.revoke.item}'`) && surface.includes(`testid: '${P.revoke.testid}'`))
  assert.ok(surface.includes(`'${P.interact.notice}'`) && surface.includes(`'${P.observe.notice}'`) && surface.includes(`'${P.revoke.notice}'`))
  // the order in the menu: read attach, operate, then the revoke (only with a standing grant)
  const at = text => surface.indexOf(text, surface.indexOf('const items = [\n        item(\'복제\''))
  assert.ok(at(`item('${P.observe.item}'`) < at('interactItem,') && at('interactItem,') < at('...(revokeItem ? [revokeItem] : [])'))
  // the chip after the grant
  assert.ok(surface.includes("source.browserToolPermission === 'interact' ? ' · 이번 Chat 조작 허용' : ''} · 미전송"))
})

test('the attach window never grants operation: it registers a Browser pick as observe only and only shows "이번 Chat 조작 허용 중" for a Card the menu already granted; interact is registered only by the menu and by a Card the Agent opened', () => {
  assert.ok(surface.includes("registerBrowserToolSelection(threadId, source, 'observe')"), 'the attach window pick is read-only')
  assert.ok(surface.includes("existingPermission === 'interact' ? el('small', {}, '이번 Chat 조작 허용 중') : null"))
  const sites = [...surface.matchAll(/(?<!function )registerBrowserToolSelection\(([A-Za-z]+), source, ([^)]+)\)/g)].map(m => m[2])
  assert.deepEqual(sites.sort(), ["'interact'", "'observe'", 'permission'].sort(), 'three call sites: the attach window (observe), the Agent-opened Card (interact), the menu (the permission it was given)')
  assert.ok(surface.includes("registerBrowserToolSelection(threadId, source, permission)") && surface.includes("registerBrowserToolSelection(localThreadId, source, 'interact')"))
})

test('a Claude conversation cannot carry the grant on this screen: the send is refused when a Browser source is granted to operate and Claude gets no live Browser source; the text is the screen\'s own', () => {
  assert.ok(surface.includes("engineId === 'claude' && (state.contextSuggest?.byThread?.[activeThread.id]?.picked?.length\n            || activeThread.inputSources?.some(input => input.browserToolPermission === 'interact'))"))
  assert.ok(surface.includes("const selectedBrowserSources = engineId === 'claude' ? [] : browserToolSelectedSources(activeThread.id, selectedInputs);"))
  assert.equal(claudeContextSendErrorText(P.claudeRefusal.code), P.claudeRefusal.text)
  assert.deepEqual(P.interact.engines, ['codex'])
})

test('the tools say where the person grants: no Card -> attach one and use the Card menu\'s "Chat 조작 허용"; a Card granted only to observe -> the same menu item; no hint for other refusals', async () => {
  assert.deepEqual(grantHint('PAGE_NO_INTERACT_GRANT'), { needs: 'person_grant', how: 'browser_card_menu', item: 'Chat 조작 허용' })
  assert.deepEqual(grantHint('PAGE_NO_CARD'), { needs: 'person_grant', how: 'attach_browser_card', item: 'Chat 조작 허용' })
  assert.equal(grantHint('PAGE_REF_UNKNOWN'), null)
  const { createPageToolsProvider, PAGE_TOOL_NAMES, PAGE_TOOL_SPECS } = await import('./egdesk-page-tools.mjs')
  const page = createPageToolsProvider({ mode: () => 'on', browser: { dispatch: async () => ({ success: true, contentItems: [{ type: 'inputText', text: '{}' }] }) } })
  const call = async (run, tool, args) => JSON.parse((await page.dispatch(run, { tool, callId: `${tool}-${Math.random()}`, arguments: args })).contentItems[0].text)
  const observeOnly = { runId: 'a', answerId: 'a', browserBinding: { cards: [{ cardId: 'card', permission: 'observe' }] } }
  for (const tool of [PAGE_TOOL_NAMES.press, PAGE_TOOL_NAMES.type, PAGE_TOOL_NAMES.open]) {
    const out = await call(observeOnly, tool, { ref: 'x', text: 'y', url: 'https://a.example.test/' })
    assert.deepEqual([out.status, out.code, out.grant], ['refused', 'PAGE_NO_INTERACT_GRANT', { needs: 'person_grant', how: 'browser_card_menu', item: 'Chat 조작 허용' }], tool)
  }
  const none = await call({ runId: 'b', answerId: 'b', browserBinding: { cards: [] } }, PAGE_TOOL_NAMES.read, {})
  assert.deepEqual([none.code, none.grant.how], ['PAGE_NO_CARD', 'attach_browser_card'])
  assert.equal((await call({ runId: 'c', answerId: 'c', browserBinding: { cards: [{ cardId: 'a', permission: 'interact' }, { cardId: 'b', permission: 'interact' }] } }, PAGE_TOOL_NAMES.read, {})).grant, undefined, 'two Cards: a different refusal, no grant hint')
  for (const name of [PAGE_TOOL_NAMES.press, PAGE_TOOL_NAMES.type, PAGE_TOOL_NAMES.open]) assert.ok(PAGE_TOOL_SPECS.find(spec => spec.name === name).description.includes('Chat 조작 허용'), `${name}: the spec names the menu item`)
})
