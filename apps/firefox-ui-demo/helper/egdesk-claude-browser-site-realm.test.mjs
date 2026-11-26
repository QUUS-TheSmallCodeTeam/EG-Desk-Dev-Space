// L6 a1 (D25): the move right after a site is allowed, replayed with the Card's OWN site rule running in a window-like global (cardSites 'window'): the overlay's code
// keeps the conversation's sites in a Set made in the window, and EGDeskBrowserGrant.sys.mjs, in another global, used to read that Set as no sites at all. In the real
// window that refused every allowed-site move in the Card ("outside the allowed sites", not sent: the helper reports BROWSER_OBSERVATION_STALE, twice, also for a site
// allowed earlier), blanked a link the engine clicked itself, and sent the helper a policy without the site. Both ways a move is asked for are replayed here: the
// conversation engine's page tool, and a decision-model step (the Browser provider's own dispatch for the same run, as the objective loop's steps go).
import test from 'node:test'
import assert from 'node:assert/strict'
import { GOOGLE_HOST, GOOGLE_PAGES, callTool, world } from './egdesk-claude-browser-world.fixture.mjs'

const ABOUT = 'https://about.google/?fg=1&utm_source=hp'
const google = (t, siteAnswer, over = {}) => world(t, { host: GOOGLE_HOST, pages: GOOGLE_PAGES, start: '/', hold: true, init: 'real', siteAnswer, realTransport: true, cardSites: 'window', ...over })
const start = async w => { const sent = await w.browserSend('Google 정보 눌러줘'); await w.drain(); return sent }
const moves = w => w.pw.state.acts.filter(act => act.type === 'navigate').map(act => ({ path: act.path, refused: act.rejected === true }))
const parse = response => JSON.parse(response?.contentItems?.[0]?.text ?? 'null')

test('D25, the conversation engine\'s page tool: allowed on the Card, the link is followed ONCE by the allowed-site route; pressed again later, it goes at once, no second question', async t => {
  const w = google(t, 'allowed')
  const sent = await start(w)
  await callTool(w, 'egdesk_card_read', { mode: 'structure' })
  const first = await callTool(w, 'egdesk_card_press', { ref: 'about' })
  assert.deepEqual([first.status, first.via, first.code], ['pressed', 'site', undefined], JSON.stringify(first))
  assert.deepEqual(moves(w), [{ path: `offsite:${ABOUT}`, refused: false }], 'one move, not refused by the Card\'s site rule')
  // the same conversation presses it again (22:01:54 in the real window: allowed at once, then refused twice): allowed at once, and it goes
  w.pw.go('/')
  await callTool(w, 'egdesk_card_read', { mode: 'structure' })
  const again = await callTool(w, 'egdesk_card_press', { ref: 'about' })
  assert.deepEqual([again.status, again.via], ['pressed', 'site'], JSON.stringify(again))
  assert.deepEqual(w.siteQuestions, ['about.google'], 'asked once')
  assert.deepEqual(moves(w).map(move => move.refused), [false, false])
  assert.deepEqual(w.receiveErrors, [])
  w.transports.at(-1).finish(); await w.settled(sent)
})

test('D25, the helper\'s copy of the policy follows the Card: the site is in the policy the Card sends back, so no card-vouched hold is needed', async t => {
  const w = google(t, 'allowed')
  const sent = await start(w)
  const asked = await callTool(w, 'egdesk_browser_request_site', { cardId: 'card', site: 'about.google' })
  assert.deepEqual([asked.status, asked.site, asked.policySync, asked.pendingBy], ['site-allowed', 'about.google', undefined, undefined], JSON.stringify(asked))
  w.transports.at(-1).finish(); await w.settled(sent)
})

test('D25, a decision-model step (the Browser provider\'s own dispatch for the same run): right after the site is allowed, observe then move goes through the Card\'s rule the first time', async t => {
  const w = google(t, 'allowed')
  const sent = await start(w)
  const run = w.runOf(sent)
  const step = async (tool, args, n) => parse(await w.browser.dispatch(run, { tool, arguments: { cardId: 'card', ...args }, callId: `direct-task.reflex-${n}-l6a1`, namespace: null }))
  assert.equal((await step('egdesk_browser_request_site', { site: 'about.google' }, 1)).status, 'site-allowed')
  const seen = await step('egdesk_browser_observe', {}, 2)
  assert.equal(seen.status, 'observed')
  const moved = await step('egdesk_browser_navigate', { observationId: seen.observationId, expectedRevision: seen.snapshot.revision, url: ABOUT, postcondition: { kind: 'url', value: ABOUT } }, 3)
  assert.equal(moved.error, undefined, JSON.stringify(moved))
  assert.equal(moved.navigationScope, 'allowed-site', 'sent by the allowed-site route (EG-Desk chrome loads it)')
  assert.deepEqual(moves(w), [{ path: `offsite:${ABOUT}`, refused: false }])
  w.transports.at(-1).finish(); await w.settled(sent)
})

test('D25, still closed: a site the person refused is not reached, nothing moves', async t => {
  const w = google(t, 'refused')
  const sent = await start(w)
  await callTool(w, 'egdesk_card_read', { mode: 'structure' })
  const out = await callTool(w, 'egdesk_card_press', { ref: 'about' })
  assert.deepEqual([out.status, out.code, out.site], ['not_done', 'BROWSER_NAVIGATE_OUT_OF_SCOPE', 'site-refused'], JSON.stringify(out))
  assert.deepEqual(moves(w), [])
  w.transports.at(-1).finish(); await w.settled(sent)
})
