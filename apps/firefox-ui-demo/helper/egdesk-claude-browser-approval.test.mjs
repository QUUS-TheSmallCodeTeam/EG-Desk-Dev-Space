// L8 u8 (U19): D24. A press that needs the person's yes (page tools, the own-tools approval ledger) was refused needs_person; the person said "네"; the engine's next call was refused again
// ("처리되지 않음"). REPLAY over the real runtime (decision-first and open items on, as in the all-on window), the real ledger, Claude adapter and page tools; the decision model is scripted, Claude and the page fake.
import test from 'node:test'
import assert from 'node:assert/strict'
import { GATE_HOOK_PAGE_REPLY_PREDICATES, GATE_HOOK_REPLY_PREDICATES, createGateHookBroker } from './egdesk-gate-hook-broker.mjs'
import { GOOGLE_HOST, GOOGLE_PAGES, callTool, world } from './egdesk-claude-browser-world.fixture.mjs'

const YES = { reply_runs_command: 0.97, reply_declines_command: 0.02 }, NO = { reply_runs_command: 0.02, reply_declines_command: 0.97 }
const google = (t, predicates = YES, over = {}) => world(t, { host: GOOGLE_HOST, pages: GOOGLE_PAGES, start: '/', hold: true, init: 'real', decisions: { predicates, openItems: true, settles: 0.95 }, ...over })
const PRESS = { ref: 'fav', expectText: '즐겨찾기에 추가됨' }
const askFirst = async w => {
  const first = await w.browserSend('즐겨찾기에 담아줘'); await w.drain()
  const asked = await callTool(w, 'egdesk_card_press', PRESS)
  w.transports.at(-1).finish(); await w.settled(first)
  return { first, asked }
}

test('D24: a press that needs the person is refused needs_person (the ledger holds the question); the person\'s "네" approves it; the engine\'s same call then goes through ONCE, no shell command is run, and it is asked again the next time', async t => {
  const w = google(t)
  const { first, asked } = await askFirst(w)
  assert.deepEqual([asked.status, asked.kind, asked.retry], ['needs_person', 'press', 'same_command_after_yes'])
  assert.equal(w.pw.state.cur.path, '/')
  const reply = await w.browserSend('네', { conversationId: first.conversationId }); assert.equal(reply.accepted, true); await w.drain()
  assert.match(JSON.stringify(w.transports.at(-1).sent), /oi1 approval: settled by this message, state=approved/)
  const again = await callTool(w, 'egdesk_card_press', PRESS)
  assert.deepEqual([again.status, again.via], ['pressed', 'approved'], JSON.stringify(again))
  assert.equal(w.pw.state.cur.path, '/fav', 'the control was pressed')
  assert.deepEqual(w.ran, [], 'no shell command was run for a page press')
  w.pw.state.cur = { ...w.pw.state.cur, path: '/' }; await callTool(w, 'egdesk_card_read', { mode: 'structure' })
  assert.equal((await callTool(w, 'egdesk_card_press', PRESS)).status, 'needs_person', 'one approval, one press')
  w.transports.at(-1).finish(); await w.settled(reply)
})

test('D24, the engine may word the expected text differently on its retry: what the person approved is pressing this control on this site', async t => {
  const w = google(t)
  const { first } = await askFirst(w)
  const reply = await w.browserSend('네', { conversationId: first.conversationId }); await w.drain()
  const again = await callTool(w, 'egdesk_card_press', { ref: 'fav', expectText: '추가됨' })
  assert.deepEqual([again.status, again.via], ['pressed', 'approved'], JSON.stringify(again))
  w.transports.at(-1).finish(); await w.settled(reply)
})

test('D24, a different control is not covered by the approval (another ref, or another label), and a decline approves nothing', async t => {
  const w = google(t)
  const { first } = await askFirst(w)
  const reply = await w.browserSend('네', { conversationId: first.conversationId }); await w.drain()
  w.pw.state.pages['/'].elements.push({ ref: 'del', role: 'button', tag: 'button', label: '즐겨찾기 삭제', href: '', value: '', disabled: false, view: '/fav' })
  await callTool(w, 'egdesk_card_read', { mode: 'structure' })
  const other = await callTool(w, 'egdesk_card_press', { ref: 'del', expectText: '즐겨찾기에 추가됨' })
  assert.notEqual(other.via, 'approved', JSON.stringify(other)); assert.equal(w.pw.state.cur.path, '/', 'the other control was not pressed')
  w.transports.at(-1).finish(); await w.settled(reply)
  const d = google(t, NO)
  const asked = await askFirst(d)
  const declined = await d.browserSend('아니', { conversationId: asked.first.conversationId }); await d.drain()
  assert.equal((await callTool(d, 'egdesk_card_press', PRESS)).status, 'needs_person')
  assert.equal(d.pw.state.cur.path, '/'); d.transports.at(-1).finish(); await d.settled(declined)
})

test('D24, the reply to a page question is read with the page wording (same predicate names and bars); a shell command question keeps its own wording', async t => {
  const w = google(t)
  const { first } = await askFirst(w)
  const reply = await w.browserSend('네', { conversationId: first.conversationId }); await w.drain()
  const read = w.decisionBodies.find(body => body.questions.some(q => q.name === 'reply_runs_command'))
  assert.ok(read, 'the reply was read')
  assert.match(JSON.stringify(read), /pressing one control on a web page/); assert.match(JSON.stringify(read), /press exactly this control now/)
  assert.deepEqual(GATE_HOOK_PAGE_REPLY_PREDICATES.map(p => p.name), GATE_HOOK_REPLY_PREDICATES.map(p => p.name))
  assert.match(GATE_HOOK_REPLY_PREDICATES[0].instructions, /run exactly this command now/)
  w.transports.at(-1).finish(); await w.settled(reply)
  // a shell command ask is read with the original wording
  const bodies = []
  const broker = createGateHookBroker({ mode: () => 'on' })
  broker.turnStarted({ conversationId: 'c', turnId: 't1' })
  await broker.check({ sessionId: 'c', turnId: 't1', cwd: '/work', command: 'git reset --hard HEAD~1' }); broker.turnEnded({ turnId: 't1' })
  const egress = { allows: () => true }
  await broker.readReply({ conversationId: 'c', reply: '응', client: { decide: async body => { bodies.push(body); return { answers: { reply_runs_command: { type: 'predicate', probability: 0.97 }, reply_declines_command: { type: 'predicate', probability: 0.02 } } } } }, egress })
  assert.match(JSON.stringify(bodies[0]), /one shell command/); assert.match(JSON.stringify(bodies[0]), /run exactly this command now/); assert.equal(bodies[0].questions.length, 2)
})

test('D24, decision-first approvals never run a page question as a shell command: the approval stays in the ledger for the engine\'s turn', async t => {
  const w = google(t, YES, { decisions: { predicates: YES } })
  const ledger = w.wiring.ledger
  ledger.turnStarted({ conversationId: 'c1', turnId: 't1' })
  const denied = await ledger.check({ sessionId: 'c1', turnId: 't1', cwd: '/', command: 'press "즐겨찾기에 추가" on www.google.com', floor: ['page_press_unproven'], identity: 'page:press:www.google.com:abc', own: 'page' })
  assert.equal(denied.decision, 'deny'); ledger.turnEnded({ turnId: 't1' })
  assert.equal(ledger.pendingAsk('c1').own, 'page')
  const diag = (path, reason, extra = {}) => ({ path, reason, option: null, ...extra })
  const out = await w.chat.decisionFirstReply({ cid: 'c1', body: { message: '네' }, context: {}, diag })
  assert.deepEqual([out.diag.reason, out.diag.option, out.entry, w.ran], ['approval_recorded', 'approved', undefined, []])
  ledger.turnStarted({ conversationId: 'c1', turnId: 't2' })
  assert.equal((await ledger.check({ sessionId: 'c1', turnId: 't2', cwd: '/', command: 'press "즐겨찾기에 추가" on www.google.com', floor: ['page_press_unproven'], identity: 'page:press:www.google.com:abc', own: 'page' })).decision, 'allow')
})
