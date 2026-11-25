// L8 u9 (U19): D25. A link to another site (Google 정보 -> about.google) needs the person's site consent. In the real window the Claude run called egdesk_browser_request_site itself: the Card's
// question stayed unanswered for its whole 55 s (the run's timeline: request at +42.4 s, "unverified" at +96.9 s), nobody saw it. Now the page tool asks the same Card question itself and follows the
// link once when it is allowed. REPLAY over the real runtime, Claude adapter, MCP bridge, Browser and page providers; the Card's question is answered by the test as the person would.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { GOOGLE_HOST, GOOGLE_PAGES, callTool, world } from './egdesk-claude-browser-world.fixture.mjs'

const here = path.dirname(new URL(import.meta.url).pathname)
const surface = fs.readFileSync(path.join(here, '..', 'overlay', 'JS', 'eg-desk-surface.uc.js'), 'utf8')
const google = (t, siteAnswer, over = {}) => world(t, { host: GOOGLE_HOST, pages: GOOGLE_PAGES, start: '/', hold: true, init: 'real', siteAnswer, ...over })
const start = async w => { const sent = await w.browserSend('Google 정보 눌러줘'); await w.drain(); return sent }
const navigations = w => w.pw.state.acts.filter(act => act.type === 'navigate').map(act => act.path)

test('D25: a link to another site: the site question is asked (on the Card, in this run), the person allows, and the link is followed ONCE', async t => {
  const w = google(t, 'allowed')
  const sent = await start(w)
  const read = await callTool(w, 'egdesk_card_read', { mode: 'structure' })
  assert.equal(read.elements.find(e => e.ref === 'about').act, 'approval', 'what the structure says is unchanged')
  const pressed = await callTool(w, 'egdesk_card_press', { ref: 'about' })
  assert.deepEqual([pressed.status, pressed.via], ['pressed', 'site'], JSON.stringify(pressed))
  assert.deepEqual(w.siteQuestions, ['about.google'], 'one question, for the registrable site, never a path')
  assert.deepEqual(navigations(w), ['offsite:https://about.google/?fg=1&utm_source=hp'], 'followed once')
  assert.deepEqual([...w.sites], ['about.google'])
  w.transports.at(-1).finish(); await w.settled(sent)
})

test('D25: refused, or no answer in time: nothing moves, in closed words; the engine is not left to retry the site request in a loop', async t => {
  for (const [answer, expected] of [['refused', 'site-refused'], ['pending', 'site-pending']]) {
    const w = google(t, answer)
    const sent = await start(w)
    await callTool(w, 'egdesk_card_read', { mode: 'structure' })
    const out = await callTool(w, 'egdesk_card_press', { ref: 'about' })
    assert.deepEqual([out.status, out.code, out.site], ['not_done', 'BROWSER_NAVIGATE_OUT_OF_SCOPE', expected], JSON.stringify(out))
    assert.deepEqual(navigations(w), [])
    w.transports.at(-1).finish(); await w.settled(sent)
  }
})

test('D25, unchanged: sign-in is the person\'s (no site question), a same-site link needs nothing, and a link to a payment or other person-only kind is not turned into a site question', async t => {
  const w = google(t, 'allowed')
  const sent = await start(w)
  await callTool(w, 'egdesk_card_read', { mode: 'structure' })
  assert.equal((await callTool(w, 'egdesk_card_press', { ref: 'login' })).status, 'person_step')
  const news = await callTool(w, 'egdesk_card_press', { ref: 'news' })
  assert.deepEqual([news.status, news.via], ['pressed', 'auto'], JSON.stringify(news))
  assert.deepEqual(w.siteQuestions, [])
  w.pw.state.pages['/'].elements.push({ ref: 'pay', role: 'link', tag: 'a', label: '결제하기', href: 'https://pay.example.test/checkout', value: '', disabled: false })
  w.pw.state.cur = { ...w.pw.state.cur, path: '/' }
  await callTool(w, 'egdesk_card_read', { mode: 'structure' })
  assert.equal((await callTool(w, 'egdesk_card_press', { ref: 'pay' })).status, 'person_step')
  assert.deepEqual(w.siteQuestions, []); assert.ok(!navigations(w).some(p => p.includes('pay.example')))
  w.transports.at(-1).finish(); await w.settled(sent)
})

test('D25, the Claude run\'s own egdesk_browser_request_site still works through the same Card question (an allowed site is then reachable by the engine\'s own navigation)', async t => {
  const w = google(t, 'allowed')
  const sent = await start(w)
  const asked = await callTool(w, 'egdesk_browser_request_site', { cardId: 'card', site: 'about.google' })
  assert.deepEqual([asked.status, asked.site], ['site-allowed', 'about.google']); assert.deepEqual(w.siteQuestions, ['about.google'])
  w.transports.at(-1).finish(); await w.settled(sent)
})

test('D25, the screen: the Card that asks the site question is brought forward and into view first (a Card the Agent opened, or one out of sight, kept the question unseen)', () => {
  const at = surface.indexOf("const answer = await card._browserControls.toolAskSite?.({ site, deadlineMs: request.deadlineMs });")
  assert.ok(at > 0)
  const before = surface.slice(Math.max(0, at - 420), at)
  assert.match(before, /card\.style\.zIndex = String\(\+\+cardZ\); revealOpenCanvasCard\(card, \{ kind: 'browser' \}\)/)
})

test('u10: a site question that does not end allowed says WHY in closed words and numbers: unanswered, or allowed by the person but not held by the run\'s policy (unreflected)', async t => {
  const a = google(t, 'pending', { realTransport: true })
  const sentA = await start(a); await callTool(a, 'egdesk_card_read', { mode: 'structure' })
  const unanswered = await callTool(a, 'egdesk_card_press', { ref: 'about' })
  assert.deepEqual([unanswered.status, unanswered.site, unanswered.pendingBy, Number.isSafeInteger(unanswered.waitedMs)], ['not_done', 'site-pending', 'unanswered', true], JSON.stringify(unanswered))
  a.transports.at(-1).finish(); await a.settled(sentA)
  const b = google(t, 'allowed', { realTransport: true, siteUnreflected: true })
  const sentB = await start(b); await callTool(b, 'egdesk_card_read', { mode: 'structure' })
  const out = await callTool(b, 'egdesk_card_press', { ref: 'about' })
  assert.deepEqual([out.status, out.code, out.site, out.pendingBy], ['not_done', 'BROWSER_NAVIGATE_OUT_OF_SCOPE', 'site-pending', 'unreflected'], JSON.stringify(out))
  assert.deepEqual(b.receiveErrors, []); assert.deepEqual(navigations(b), [])
  b.transports.at(-1).finish(); await b.settled(sentB)
})

test('u10, through the REAL transport (SSE frames, wire ids, deadlines) with a client that answers like the overlay: the person\'s allow, instant or a moment later, ends allowed and the link is followed once; the next request for the same site is answered at once', async t => {
  for (const delayMs of [0, 300]) {
    const w = google(t, async () => { if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs)); return 'allowed' }, { realTransport: true })
    const sent = await start(w); await callTool(w, 'egdesk_card_read', { mode: 'structure' })
    const first = await callTool(w, 'egdesk_card_press', { ref: 'about' })
    assert.deepEqual([first.status, first.via], ['pressed', 'site'], `${delayMs}: ${JSON.stringify(first)}`)
    const again = await callTool(w, 'egdesk_browser_request_site', { cardId: 'card', site: 'about.google' })
    assert.equal(again.status, 'site-allowed'); assert.deepEqual(w.siteQuestions, ['about.google'], 'asked once; the second answer is immediate')
    assert.deepEqual(w.receiveErrors, []); assert.equal(navigations(w).length, 1)
    w.transports.at(-1).finish(); await w.settled(sent)
  }
})

test('u10, the screen: the site answer carries numbers only (time given, time taken) for the helper to report; nothing else changed in how the question is answered', () => {
  assert.match(surface, /diag: \{ leftMs: askedLeftMs, waitedMs: Math\.max\(0, Math\.round\(Date\.now\(\) - askedAtMs\)\) \}/)
  const at = surface.indexOf("const answer = await card._browserControls.toolAskSite?.({ site, deadlineMs: request.deadlineMs });")
  assert.ok(surface.slice(at, at + 600).includes("if (answer === 'allowed') {"), 'allowed still joins the conversation\'s set exactly as before')
})
