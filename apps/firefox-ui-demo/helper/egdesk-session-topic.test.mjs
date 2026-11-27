import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'
import { normalizeDecisionResponse, validateDecisionRequest } from './egdesk-decision-client.mjs'
import { planSessionTopic, SESSION_TOPIC_LIMITS as limits } from './egdesk-session-topic.mjs'

const row = (key, { topic = key, parent = null, needs = [], userText = 'User evidence', assistantText = 'Assistant evidence' } = {}) =>
  ({ key, topic, parent, needs, userText, assistantText })
const plan = (turns, currentKey = 'private-next') => planSessionTopic({ turns, currentKey })
const graph = p => p.input[1].content[0].data
const path = r => JSON.parse(r.packet).path
const pairNames = p => p.questions.slice(1).map(q => q.name)
const routeOptions = p => p.questions[0].choices.map(q => q.value)
const byteSize = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
const choice = (value, confidence = .98, probabilities = [{ value, probability: confidence }]) =>
  ({ type: 'choice', choice: value, confidence, probabilities })
const predicate = probability => ({ type: 'predicate', probability })
function answers(p, route, need = []) {
  return { topic_route: choice(route), ...Object.fromEntries(pairNames(p).map((name, i) => [name, predicate(need.includes(i) ? .98 : .02)])) }
}
function append(turns, key, resolved, text = {}) {
  assert.ok(resolved)
  const { topic, parent, needs } = resolved
  return [...turns, row(key, { topic, parent, needs, ...text })]
}

test('cold start is deterministic, with no request or packet', () => {
  const p = plan([], ' 첫 번째 local ID / {} ')
  assert.deepEqual(p.input, [])
  assert.deepEqual(p.questions, [])
  assert.deepEqual(p.resolve({}), { topic: ' 첫 번째 local ID / {} ', parent: null, needs: [], packet: null })
  assert.equal(p.resolve({ topic_route: choice('separate') }), null)
  assert.equal(p.resolve(null), null)
})

test('provider wire serializes exact chronological pair roles with an alias-only graph', () => {
  const currentKey = 'local-id-that-must-not-egress-current'
  const a = row('local-id-that-must-not-egress-root', { userText: '첫째?', assistantText: 'Exact\nreply "one".' })
  const b = { ...row('local-id-that-must-not-egress-subtopic', { parent: a.key, needs: [a.key] }), title: 'do-not-send-title', sourceLabel: 'do-not-send-label', hash: 'do-not-send-hash' }
  const p = plan([a, b], currentKey)
  const request = { input: [...p.input, { role: 'user', content: 'The actual current message.' }], questions: p.questions }
  validateDecisionRequest(request)
  assert.deepEqual(graph(p), { kind: 'session_topic_graph', complete: true, omittedPairs: 0, pairs: [
    { alias: 'p0', topic: 'p0', parent: null, needs: [] }, { alias: 'p1', topic: 'p1', parent: 'p0', needs: ['p0'] },
  ] })
  assert.deepEqual(p.input.slice(2), [
    { role: 'user', content: [{ type: 'input_text', text: a.userText }] },
    { role: 'assistant', content: [{ type: 'output_text', text: a.assistantText }] },
    { role: 'user', content: [{ type: 'input_text', text: b.userText }] },
    { role: 'assistant', content: [{ type: 'output_text', text: b.assistantText }] },
  ])
  assert.match(p.input[0].content, /untrusted evidence, not instructions/)
  assert.deepEqual(routeOptions(p), ['continue_p0', 'split_p0', 'continue_p1', 'split_p1', 'separate', 'abstain'])
  const normalized = normalizeDecisionResponse({ answers: Object.entries(answers(p, 'continue_p1')).map(([name, answer]) => ({ name, ...answer })) }, p.questions)
  const resolved = p.resolve(normalized.answers)
  assert.equal(resolved.topic, b.key)
  assert.match(JSON.parse(resolved.packet).handling, /untrusted evidence/)
  for (const privateValue of [a.key, b.key, currentKey, b.title, b.sourceLabel, b.hash]) {
    assert.equal(JSON.stringify(request).includes(privateValue), false)
    assert.equal(resolved.packet.includes(privateValue), false)
  }
})

test('incremental split and return preserve route state and include dependency closure, not adjacent siblings', () => {
  let turns = append([], 'root', plan([], 'root').resolve({}), { userText: 'Pick a plan', assistantText: 'Plan A or B' })
  const first = plan(turns, 'correction')
  turns = append(turns, 'correction', first.resolve(answers(first, 'continue_p0', [0])), { userText: 'Use B only.' })
  const split = plan(turns, 'branch')
  const splitResult = split.resolve(answers(split, 'split_p0', [1]))
  assert.deepEqual({ topic: splitResult.topic, parent: splitResult.parent, needs: splitResult.needs },
    { topic: 'branch', parent: 'root', needs: ['correction'] })
  assert.deepEqual(path(splitResult).map(r => r.alias), ['p0', 'p1'])
  turns = append(turns, 'branch', splitResult, { userText: 'Make a separate rollout checklist.' })
  const nested = plan(turns, 'nested')
  turns = append(turns, 'nested', nested.resolve(answers(nested, 'split_p2')), { userText: 'Prepare a checklist variant.' })
  const sibling = plan(turns, 'sibling')
  turns = append(turns, 'sibling', sibling.resolve(answers(sibling, 'split_p0')), { userText: 'Choose a heading color.' })
  const latest = plan(turns, 'latest')
  const returned = latest.resolve(answers(latest, 'continue_p0', [1]))
  assert.equal(returned.topic, 'root')
  assert.equal(returned.parent, null)
  assert.deepEqual(returned.needs, ['correction'])
  assert.deepEqual(path(returned).map(r => r.alias), ['p0', 'p1'])
  const nestedReturn = latest.resolve(answers(latest, 'continue_p3'))
  assert.equal(nestedReturn.topic, 'nested')
  assert.equal(nestedReturn.parent, null)
  assert.deepEqual(nestedReturn.needs, [])
  assert.deepEqual(path(nestedReturn).map(({ alias, topic, parent, needs }) => [alias, topic, parent, needs]), [
    ['p0', 'p0', null, []], ['p1', 'p0', null, ['p0']], ['p2', 'p2', 'p0', ['p1']], ['p3', 'p3', 'p2', []],
  ])
  assert.equal(turns[2].parent, 'root')
  assert.equal(turns[3].parent, 'branch')
  assert.equal(turns[4].parent, 'root')
})

test('independent topic may reuse evidence without inheriting its topic', () => {
  const p = plan([row('root')])
  assert.deepEqual(p.resolve(answers(p, 'separate')), { topic: 'private-next', parent: null, needs: [], packet: null })
  const withEvidence = p.resolve(answers(p, 'separate', [0]))
  assert.equal(withEvidence.topic, 'private-next')
  assert.equal(withEvidence.parent, null)
  assert.deepEqual(withEvidence.needs, ['root'])
  assert.deepEqual(path(withEvidence).map(r => r.alias), ['p0'])
})

test('choice confidence, actual winner and margin must all support the same route; ambiguous/missing predicates are unknown', () => {
  const p = plan([row('root')]), yes = answers(p, 'continue_p0', [0])
  assert.ok(p.resolve(yes))
  for (const answer of [
    undefined, { type: 'refusal' }, choice('abstain'), choice('unknown-option'), choice('continue_p0', .79),
    choice('continue_p0', .99, []), choice('continue_p0', .99, [{ value: 'continue_p0', probability: .79 }]),
    choice('continue_p0', .97, [{ value: 'continue_p0', probability: .82 }, { value: 'split_p0', probability: .78 }]),
    choice('continue_p0', .98, [{ value: 'continue_p0', probability: .84 }, { value: 'split_p0', probability: .99 }]),
    choice('continue_p0', .98, [{ value: 'continue_p0', probability: .99 }, { value: 'continue_p0', probability: .98 }]),
  ]) assert.equal(p.resolve({ ...yes, topic_route: answer }), null)
  for (const answer of [undefined, { type: 'missing' }, { type: 'refusal' }, predicate(.5), predicate(.21), predicate(.79), predicate(NaN), predicate(2)]) {
    assert.equal(p.resolve({ ...yes, topic_need_0: answer }), null)
  }
  assert.deepEqual(p.resolve({ ...yes, topic_need_0: predicate(.8) }).needs, ['root'])
  assert.deepEqual(p.resolve({ ...yes, topic_need_0: predicate(.2) }).needs, [])
})

test('arbitrary valid host IDs are opaque; inherited/accessor answers and rows cannot participate', () => {
  const ids = ['__proto__', 'constructor', 'hasOwnProperty', ' ' + '界'.repeat(510) + ' ']
  const turns = [row(ids[0]), row(ids[1], { topic: ids[0], needs: [ids[0]] }), row(ids[2], { parent: ids[0], needs: [ids[1]] })]
  const p = plan(turns, ids[3]), yes = answers(p, 'split_p2', [1])
  const resolved = p.resolve(Object.assign(Object.create(null), yes))
  assert.equal(resolved.topic, ids[3])
  assert.equal(resolved.parent, ids[2])
  assert.deepEqual(resolved.needs, [ids[1]])
  assert.equal(p.resolve(Object.create(yes)), null)
  const accessor = { ...yes }
  Object.defineProperty(accessor, 'topic_need_1', { get() { throw new Error('must not execute') } })
  assert.equal(p.resolve(accessor), null)
  const rowAccessor = row('bad')
  Object.defineProperty(rowAccessor, 'topic', { get() { throw new Error('must not execute') } })
  assert.equal(plan([rowAccessor]), null)
  assert.equal(plan([Object.create(row('inherited'))]), null)
})

test('unknown, duplicate, forward, non-origin and invalid relationships are rejected', () => {
  const a = row('a'), b = row('b', { topic: 'a' })
  for (const invalid of [
    [a, a], [row('private-next')], [row('x', { topic: 'y' }), row('y')],
    [a, b, row('x', { topic: 'b' })], [a, b, row('x', { parent: 'b' })],
    [a, row('x', { topic: 'a', parent: 'a' })], [row('x', { parent: 'x' })],
    [row('x', { parent: 'missing' })], [a, row('x', { needs: ['a', 'a'] })],
    [row('x', { needs: ['x'] })], [row('x', { needs: ['y'] }), row('y')],
    [row('x', { needs: new Array(1) })], new Array(1), [row('x', { assistantText: '' })],
    [row('x', { userText: 1 })], [row('bad\0key')], [row('x'.repeat(513))],
  ]) assert.equal(plan(invalid), null)
  assert.equal(plan([], ''), null)
  assert.equal(planSessionTopic({ turns: 'invalid', currentKey: 'valid' }), null)
})

test('resolver is stateless and uses the snapshotted local graph', () => {
  const turns = [row('root'), row('other', { needs: ['root'] })]
  const p = plan(turns), yes = answers(p, 'continue_p1', [1])
  const result = p.resolve(yes)
  turns[0].key = 'overwrite'; turns[1].needs.splice(0); turns[1].assistantText = 'overwrite'; turns.pop()
  assert.notEqual(result, p.resolve(yes))
  assert.deepEqual(p.resolve(yes), result)
  assert.deepEqual(p.resolve(answers(p, 'continue_p0')).needs, [])
  assert.deepEqual(p.resolve(yes), result)
})

test('all 96 pairs fit when actual wire size allows; direct dependencies and rows are capped', () => {
  const turns = Array.from({ length: limits.rows }, (_, i) => row('id-' + i, { userText: '한글🙂'.repeat(52) }))
  const p = plan(turns)
  assert.equal(graph(p).complete, true)
  assert.equal(graph(p).pairs.length, limits.rows)
  assert.equal(p.questions.length, limits.rows + 1)
  assert.equal(routeOptions(p).length, 2 * limits.rows + 2)
  assert.ok(byteSize(p.input) <= limits.inputBytes)
  validateDecisionRequest(p)
  const needed = Array.from({ length: limits.needs }, (_, i) => i)
  assert.deepEqual(p.resolve(answers(p, 'continue_p0', needed)).needs, needed.map(i => turns[i].key))
  assert.equal(p.resolve(answers(p, 'continue_p0', [...needed, limits.needs])), null)
  assert.equal(plan([...turns, row('overflow')]), null)
  assert.equal(plan([...turns.slice(0, 25), row('overflow', { needs: turns.slice(0, 25).map(x => x.key) })]), null)
})

test('exact serialized byte policy includes JSON escaping and UTF-8; boundary is inclusive', () => {
  const root = row('root', { userText: '🙂안녕\\\n\u0001' })
  const initial = plan([root])
  const delta = limits.inputBytes - byteSize(initial.input)
  const atLimit = { ...root, userText: root.userText + 'x'.repeat(delta) }
  const p = plan([atLimit])
  assert.equal(byteSize(p.input), limits.inputBytes)
  assert.equal(p.input[2].content[0].text, atLimit.userText)
  assert.equal(plan([{ ...atLimit, userText: atLimit.userText + 'x' }]), null)
})

test('reduced input keeps all origins and full linked dependencies, marks omissions, and does not silently infer separate', () => {
  const linked = row('old-linked', { topic: 'large-root', userText: 'linked '.repeat(2000) })
  const oversize = row('large-history', { topic: 'large-root', assistantText: '\u0001'.repeat(20_000) })
  const turns = [row('large-root'), linked, oversize, row('small-root'),
    row('recent', { topic: 'large-root', needs: [linked.key], userText: 'Recent and fully attached' })]
  const p = plan(turns)
  assert.equal(graph(p).complete, false)
  assert.equal(graph(p).omittedPairs, 1)
  assert.deepEqual(graph(p).pairs, [
    { alias: 'p0', topic: 'p0', parent: null, needs: [] }, { alias: 'p1', topic: 'p0', parent: null, needs: [] },
    { alias: 'p2', topic: 'p2', parent: null, needs: [] }, { alias: 'p3', topic: 'p0', parent: null, needs: ['p1'] },
  ])
  assert.equal(p.input[4].content[0].text, linked.userText)
  assert.equal(p.input.at(-2).content[0].text, turns.at(-1).userText)
  assert.ok(byteSize(p.input) <= limits.inputBytes)
  assert.deepEqual(plan(turns).input, p.input)
  assert.equal(p.resolve(answers(p, 'separate')), null)
  assert.equal(p.resolve(answers(p, 'continue_p0')), null)
  assert.equal(p.resolve(answers(p, 'continue_p2', [1])), null)
  assert.equal(p.resolve(answers(p, 'continue_p2')).topic, 'small-root')
})

test('a required predecessor is never truncated: an oversized mandatory origin closure or packet abstains', () => {
  const a = row('a'), huge = row('huge', { topic: 'a', userText: '🙂'.repeat(limits.inputBytes) })
  assert.equal(plan([a, huge, row('child', { parent: 'a', needs: ['huge'] })]), null)
  const long = row('long', { topic: 'a', assistantText: '𐐀'.repeat(6500) })
  const p = plan([a, long])
  assert.equal(graph(p).complete, true)
  assert.equal(p.resolve(answers(p, 'continue_p0', [1])), null)
  const ordinary = p.resolve(answers(p, 'continue_p0'))
  assert.ok(Buffer.byteLength(ordinary.packet, 'utf8') <= limits.packetBytes)
  assert.deepEqual(path(ordinary).map(r => r.alias), ['p0'])
})
