// L6 a1 (D25): every refusal before any input reached the helper as one code, BROWSER_OBSERVATION_STALE, and the Card's or the page actor's own words were
// dropped, so the real window could not tell a page that changed from a rule that always refuses (the Card's site rule) or a fact that keeps moving (16:17,
// httpbin form: every fill refused 18-21 ms after a fresh observation). The refusal now carries WHICH observed fact moved, in one closed word (staleBy), from
// the page actor and the Card through the helper to the tool result and the 'browser.tool.failed' record. Words only, never page content.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { BROWSER_STALE_REASONS, staleReasonOf } from './egdesk-browser-tool-runtime.mjs'
import { callTool, world } from './egdesk-claude-browser-world.fixture.mjs'

const actorSource = fs.readFileSync(new URL('../overlay/resources/EGDeskBrowserAgentRuntimeChild.sys.mjs', import.meta.url), 'utf8')
const surfaceSource = fs.readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')

test('staleBy: the Card\'s and the page actor\'s refusal words map to one closed word; anything else is other', () => {
  const cases = [
    ['Browser observation is stale [revision]; observe the current page again', 'revision'],
    ['Browser observation is stale [viewport]; observe the current page again', 'viewport'],
    ['Browser observation is stale [focus]; observe the current page again', 'focus'],
    ['Browser observation is stale [url]; observe the current page again', 'url'],
    ['Browser observation is stale [document]; observe the current page again', 'document'],
    ['Browser observation is stale [identity]; the document changed', 'identity'],
    ['Browser observation is stale [scroll]; the scroll position changed', 'scroll'],
    ['Browser navigation is outside the allowed sites [outside-site]', 'site-rule'],
    ['Browser frame is stale; observe the current page again', 'frame'],
    ['Browser target changed; observe again', 'target'],
    ['Browser target is unavailable; observe again', 'target'],
    ['Browser run binding is missing or changed', 'binding'],
    ['Browser Card, profile or account context changed', 'binding'],
    ['Browser request belongs to a different Card generation', 'card-generation'],
    ['Browser Card is already being operated', 'card-busy'],
    ['Browser action budget expired before dispatch', 'budget'],
    ['The user is operating this Browser Card directly; Agent requests are refused until the user allows control again from the Card', 'user-hold'],
    ['Browser observation is stale [made-up-word]; observe again', 'other'],
    ['Browser observation is stale; observe the current page again', 'other'],
    [undefined, 'other'], [{ toString: () => 'stale [revision]' }, 'other'],
  ]
  for (const [text, word] of cases) assert.equal(staleReasonOf(text), word, String(text))
  for (const word of new Set(cases.map(([, w]) => w))) assert.ok(BROWSER_STALE_REASONS.includes(word), word)
})

test('staleBy: every bracket word the page actor and the Card can write is a known word (no drift between the overlay and the helper)', () => {
  const written = new Set()
  for (const source of [actorSource, surfaceSource]) for (const match of source.matchAll(/stale \[([a-z-]+)\]/g)) written.add(match[1])
  // the guards' computed word (`stale [${moved}]`): every literal it can take
  for (const [source, anchor] of [[actorSource, 'const moved = guard.documentId'], [surfaceSource, "const moved = (Object.hasOwn(guard, 'innerWindowId')"]]) {
    const at = source.indexOf(anchor)
    assert.ok(at > 0, anchor)
    for (const match of source.slice(at, source.indexOf('if (moved)', at)).matchAll(/\? ["']([a-z-]+)["']/g)) written.add(match[1])
  }
  assert.deepEqual([...written].filter(word => !BROWSER_STALE_REASONS.includes(word)), [])
  for (const word of ['document', 'viewport', 'revision', 'focus', 'url', 'identity', 'scroll']) assert.ok(written.has(word), word)
})

test('staleBy end to end: a fill the Card refuses as not sent carries the word to the page tool\'s result and to the browser.tool.failed record', async t => {
  const w = world(t, { hold: true })
  const sent = await w.browserSend('상품 검색에 우산 넣어줘'); await w.drain()
  const send = w.pw.transport.sendToUi
  w.pw.transport.sendToUi = async request => (request.kind === 'act' && request.action.type === 'fill'
    ? { requestId: request.requestId, status: 'rejected', error: 'Browser observation is stale [viewport]; observe the current page again', dispatchPhase: 'not-dispatched', timing: {} }
    : send(request))
  await callTool(w, 'egdesk_card_read', { mode: 'structure' })
  const typed = await callTool(w, 'egdesk_card_type', { ref: 'q', text: '우산' })
  assert.deepEqual([typed.status, typed.code, typed.staleBy], ['not_done', 'BROWSER_OBSERVATION_STALE', 'viewport'], JSON.stringify(typed))
  await w.drain()
  const failed = w.events.filter(event => event?.event === 'browser.tool.failed' || event?.type === 'browser.tool.failed' || JSON.stringify(event).includes('"browser.tool.failed"'))
  assert.ok(JSON.stringify(failed).includes('"staleBy":"viewport"'), 'the record names it too')
  // the helper's own copy: an observation that is not the latest one is refused before anything is sent to the Card (named 'observation' in the record)
  const sentToCard = w.pw.state.acts.length
  const own = await callTool(w, 'egdesk_browser_fill', { cardId: 'card', observationId: 'not-the-latest', expectedRevision: 1, ref: 'q', text: '우산',
    expectedTarget: { ref: 'q', role: 'textbox', label: '상품 검색', href: '', value: '', tag: 'input' }, postcondition: { kind: 'target-value', value: '우산' } })
  assert.equal(own.error?.code, 'BROWSER_OBSERVATION_STALE', JSON.stringify(own))
  await w.drain()
  assert.ok(JSON.stringify(w.events).includes('"staleBy":"observation"'), 'the record says the helper refused it itself')
  assert.equal(w.pw.state.acts.length, sentToCard, 'nothing reached the Card')
  w.transports.at(-1).finish(); await w.settled(sent)
})
