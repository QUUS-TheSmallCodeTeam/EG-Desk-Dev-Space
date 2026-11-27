import test from 'node:test'
import assert from 'node:assert/strict'
import { OPEN_ITEM_BARS, OPEN_ITEM_LIMITS, OPEN_ITEMS_KEY, buildRegistry, openItemsContext, referentQuestions, registerOpenItemProvider, registeredOpenItemProviders, resolveOpenItem } from './egdesk-open-items.mjs'
import { EGRESS_SITES } from './egdesk-decision-egress.mjs'

// The resolver's own rules, with a scripted Decision model (answers by question name): registry by code, one quoted item per question, the combination by code.
const src = (id, rows) => ({ id, items: () => rows })
const row = (id, kind, summary, extra = {}) => ({ id, kind, summary, ...extra })
const client = (by, calls = []) => ({ async decide(request) { calls.push(request); return { answers: Object.fromEntries(request.questions.map(q => [q.name, { type: 'predicate', probability: by[q.name] ?? 0.02 }])), usage: { inputTokens: 1 } } } })
const items = () => buildRegistry([src('approval', [row('a:1', 'approval', 'A command waits: git push --force origin main')]), src('question', [row('q:1', 'question', 'The run asked the person: 어느 폴더로 할까요?')]), src('memory', [row('m:1', 'memory', 'EG-Desk waits for a confirmation.')])], {})

test('the registry: ids by order, kinds closed, summaries bounded, limit, a failing provider contributes nothing', () => {
  const reg = items()
  assert.deepEqual(reg.map(i => [i.id, i.provider, i.kind, i.itemId]), [['oi1', 'approval', 'approval', 'a:1'], ['oi2', 'question', 'question', 'q:1'], ['oi3', 'memory', 'memory', 'm:1']])
  const messy = buildRegistry([src('x', [row('1', 'nonsense', 'a'), row('2', 'run', ''), { kind: 'run', summary: 'no id' }, row('3', 'run', 'ok '.repeat(400))]), { id: 'boom', items: () => { throw new Error('x') } }], {})
  assert.deepEqual(messy.map(i => [i.id, i.kind]), [['oi1', 'run']]); assert.ok(messy[0].summary.length <= OPEN_ITEM_LIMITS.summaryChars)
  assert.equal(buildRegistry([src('x', Array.from({ length: 9 }, (_, i) => row(String(i), 'run', `r${i}`)))], {}).length, OPEN_ITEM_LIMITS.items)
  assert.deepEqual(buildRegistry([], {}), [])
})

test('questions: one per item, each quoting the message and only its own item', () => {
  const qs = referentQuestions(items(), '그냥 해')
  assert.deepEqual(qs.map(q => q.name), ['oi_ref_1', 'oi_ref_2', 'oi_ref_3']); assert.ok(qs.every(q => q.type === 'predicate' && q.instructions.includes('그냥 해')))
  assert.ok(qs[0].instructions.includes('git push --force') && !qs[0].instructions.includes('폴더') && !qs[0].instructions.includes('confirmation'))
  assert.ok(qs[1].instructions.includes('어느 폴더로') && !qs[1].instructions.includes('git push'))
})

test('the verdict: exactly one item clearly referred to settles it; everything else settles nothing', async () => {
  const run = async (by, message = '그냥 해', list = items()) => { const calls = []; const v = await resolveOpenItem({ message, items: list, client: client(by, calls) }); return { v, calls } }
  const { v, calls } = await run({ oi_ref_1: 0.97 })
  assert.deepEqual([v.status, v.item.id, v.p, v.calls], ['settled', 'oi1', 0.97, 1]); assert.equal(calls.length, 1); assert.equal(calls[0].questions.length, 3)
  const none = async (by, reason, message) => { const { v } = await run(by, message); assert.deepEqual([v.status, v.reason], ['none', reason], JSON.stringify(by)) }
  await none({}, 'no_item_referred'); await none({ oi_ref_1: OPEN_ITEM_BARS.ref - 0.01 }, 'no_item_referred'); await none({ oi_ref_1: 0.97, oi_ref_2: 0.97 }, 'several_items')
  await none({ oi_ref_1: 0.97, oi_ref_3: OPEN_ITEM_BARS.unsure }, 'several_items'); assert.equal((await run({ oi_ref_1: 0.97, oi_ref_3: 0.49 })).v.status, 'settled')
  await none({ oi_ref_1: 0.97 }, 'message_unsuited', ''); await none({ oi_ref_1: 0.97 }, 'message_unsuited', 'ㅇ'.repeat(OPEN_ITEM_LIMITS.messageChars + 1))
  assert.deepEqual((await resolveOpenItem({ message: 'x', items: [], client: client({}) })), { status: 'none', reason: 'no_items', calls: 0 })
  const failing = await resolveOpenItem({ message: '응', items: items(), client: { async decide() { throw Object.assign(new Error('x'), { code: 'timeout' }) } } })
  assert.deepEqual([failing.status, failing.reason, failing.calls], ['none', 'timeout', 1])
  const silent = await resolveOpenItem({ message: '응', items: items(), client: { async decide() { return { answers: { oi_ref_1: { type: 'predicate', probability: 0.97 } } } } } })
  assert.deepEqual([silent.status, silent.reason], ['none', 'unanswered'], 'an item without an answer is never taken as a "no"')
})

test('the providers\' own questions ride in the same request and their answers come back', async () => {
  const calls = []
  const v = await resolveOpenItem({ message: '계속해', items: items(), client: client({ oi_ref_2: 0.96, open_browser_continue: 0.9 }, calls), extraQuestions: [{ type: 'predicate', name: 'open_browser_continue', instructions: 'x' }] })
  assert.equal(calls.length, 1); assert.equal(calls[0].questions.length, 4); assert.equal(v.answers.open_browser_continue.probability, 0.9)
})

test('the engine context: closed words, only the settled item is named as settled, none when nothing is open', () => {
  const reg = items()
  const text = openItemsContext(reg, { status: 'settled', item: reg[0] }, { oi1: 'approved' })
  assert.match(text, /oi1 approval: settled by this message, state=approved/); assert.match(text, /oi2 question: still open/); assert.match(text, /settles oi1 only/)
  assert.match(openItemsContext(reg, { status: 'none', reason: 'no_item_referred' }), /settles none of them/)
  assert.equal(openItemsContext([], { status: 'none' }), null); assert.equal(OPEN_ITEMS_KEY, 'egdesk_open_items')
  assert.ok(!/git push|폴더/.test(text), 'the engine block carries ids and kinds, not the items\' text')
})

test('providers register once by a closed name, and the module declares its egress classes', () => {
  assert.throws(() => registerOpenItemProvider({ id: 'Bad Name', items: () => [] })); assert.throws(() => registerOpenItemProvider({ id: 'ok', items: 5 }))
  const undo = registerOpenItemProvider({ id: 'tmp_one', items: () => [] }); assert.ok(registeredOpenItemProviders().some(p => p.id === 'tmp_one')); undo(); assert.ok(!registeredOpenItemProviders().some(p => p.id === 'tmp_one'))
  assert.deepEqual(EGRESS_SITES['egdesk-open-items.mjs'], ['run_text', 'terminal_command'])
})
