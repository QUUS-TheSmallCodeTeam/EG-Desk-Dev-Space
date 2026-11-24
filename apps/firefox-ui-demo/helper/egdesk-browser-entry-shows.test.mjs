import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { createBrowserTaskStore, createDirectBrowserEntry, entryQuestions, readBrowserEntry } from './egdesk-browser-task.mjs'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'

// L8 c21: the settings entry (real, browser-live-settings-v2, 2026-11-25): the request predicate 0.90, the card predicate 0.19, so the
// entry did not enter. The body (rebuilt byte for byte by product code, sha256 6b1eb94e...) quoted the card by title and host only.
const MSG = '마케팅 알림 꺼줘'
const SHOWS = ['알림 설정', '마케팅 정보 알림: 켜짐', '보안 알림: 켜짐', '약관 안내']
function world({ allow = true, observe = 'ok', cards = [{ cardId: 'card', permission: 'interact' }], titles = { card: '알림 설정 | 계정' }, hosts = { card: 'account.example.test' }, answer = null } = {}) {
  const bodies = [], observed = []
  const client = createDecisionClient({ getApiKey: async () => 'egd-synthetic-not-a-key-0008', fetchImpl: async (_u, init) => {
    bodies.push(init.body); const wire = JSON.parse(init.body)
    return { ok: true, text: async () => JSON.stringify({ answers: (answer ?? (() => wire.questions.map(q => ({ name: q.name, type: 'predicate', probability: 0.02 }))))(wire) }) } } })
  const provider = { directEntryEnabled: () => true,
    reflexScope: (_run, _call, cardId) => ({ client, isDecisionCurrent: () => true,
      callTool: async (name, args) => { observed.push([name, args.cardId, cardId]); if (observe === 'throw') throw new Error('gone'); return { observationId: 'o', snapshot: { text: SHOWS } } } }),
    runDirectTask: async () => ({ outcome: 'escalated', reason: 'human_step', steps: [], state: null }) }
  const entry = createDirectBrowserEntry({ provider, store: createBrowserTaskStore(), cardTextInEntry: () => allow })
  const say = message => entry.handle({ run: { runId: 'r', browserBinding: { cards } }, conversationKey: 'dm', message, hosts, titles })
  return { say, bodies, observed }
}
const sha = text => createHash('sha256').update(text).digest('hex')

test('off (the default, or the run may not receive page text): the entry body is the real one, byte for byte, and no card is observed', async () => {
  const w = world({ allow: false })
  await w.say(MSG)
  assert.equal(sha(w.bodies[0]).slice(0, 12), '6b1eb94ef39b')
  assert.deepEqual(w.observed, [])
})

test('on: one observation per card (a read, no Decision request); the card predicate quotes its first three lines, each on its own', async () => {
  const w = world()
  await w.say(MSG)
  assert.deepEqual(w.observed, [['egdesk_browser_observe', 'card', 'card']])
  assert.equal(w.bodies.length, 1, 'still one Decision request for the entry')
  const card = JSON.parse(w.bodies[0]).questions.find(q => q.name === 'browser_entry_card_0')
  assert.equal(card.instructions, 'Does this request need to be done on this open page: "알림 설정 | 계정" at "account.example.test", which now shows "알림 설정" / "마케팅 정보 알림: 켜짐" / "보안 알림: 켜짐"?')
  assert.doesNotMatch(card.instructions, /약관 안내/, 'at most three lines')
  assert.ok(Buffer.byteLength(w.bodies[0]) - 631 < 200, 'a small addition to the 631-byte body')
})

test('the combination as designed: the real 0.90 / 0.19 is "the card is not the place" (not entered); a card decided yes on the page it shows enters', () => {
  const cards = [{ cardId: 'card', host: 'account.example.test', title: '알림 설정 | 계정' }]
  const P = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { type: 'predicate', probability: v }]))
  assert.equal(readBrowserEntry(P({ browser_entry: 0.90, browser_entry_card_0: 0.19 }), cards).kind, 'not_browser', 'one card decided no: the one-card rule does not apply')
  assert.equal(readBrowserEntry(P({ browser_entry: 0.90, browser_entry_card_0: 0.40 }), cards).cardId, 'card', 'an undecided card with a decided web task: the one granted card')
  assert.equal(readBrowserEntry(P({ browser_entry: 0.90, browser_entry_card_0: 0.90 }), cards).cardId, 'card')
})

test('skipped when code named the card (no card question is asked); a card that cannot be observed is quoted by title and host alone; lines are bounded', async () => {
  const named = world({ titles: { card: '마케팅 알림 | 계정' } })
  await named.say('마케팅 알림 꺼줘')
  assert.deepEqual([named.observed, JSON.parse(named.bodies[0]).questions.map(q => q.name)], [[], ['browser_entry']])
  const gone = world({ observe: 'throw' })
  await gone.say(MSG)
  assert.equal(JSON.parse(gone.bodies[0]).questions[1].instructions, 'Does this request need to be done on this open page: "알림 설정 | 계정" at "account.example.test"?')
  const long = entryQuestions([{ cardId: 'c', host: 'a.example.test', title: 'T', shows: ['가'.repeat(200), 'x"y'] }])[1].instructions
  assert.ok(long.includes(`"${'가'.repeat(59)}…"`) || long.length < 200)
  assert.match(long, /"x'y"/, 'a quote inside a line cannot close the quoted line')
})

test('two cards, each quoting its own lines: the grouped request passes the grouping lint (each question carries its own page)', async () => {
  const w = world({ cards: [{ cardId: 'card', permission: 'interact' }, { cardId: 'card2', permission: 'interact' }], titles: { card: '알림 설정 | 계정', card2: '받은 편지함 | 메일' }, hosts: { card: 'account.example.test', card2: 'mail.example.test' } })
  await w.say(MSG)
  assert.equal(w.observed.length, 2)
  const body = JSON.parse(w.bodies[0])
  assert.equal(lintGroupedRequest(body).ok, true)
})
