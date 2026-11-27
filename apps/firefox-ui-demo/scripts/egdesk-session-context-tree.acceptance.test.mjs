// Executable *design* example, not imported by the application. Synthetic,
// in-memory data only. Topic choices and required-turn links are supplied by
// the fixture, not inferred by this test or learned from an actual transcript.
import test from 'node:test'
import assert from 'node:assert/strict'

const thread = 'fixture-session'
function pair(n, topic, user, final, requires = []) { return { n, thread, topic, user, final, requires } }
function fixture() {
  return {
    topics: [
      { id: 'reader', parent: null, start: 31 }, { id: 'colour', parent: 'reader', start: 52 },
      { id: 'device', parent: 'reader', start: 70 }, { id: 'scope', parent: 'device', start: 72 },
    ],
    past: [
      pair(31, 'reader', '자료를 다시 찾는 시간을 줄이자.', '문서 리더가 목표다.'),
      pair(43, 'reader', '본문은 절 단위로 봐.', '절 단위를 사용한다.'),
      pair(52, 'colour', '표지 색은 별도로 정하자.', '별개 디자인 논의다.'),
      pair(70, 'device', '먼저 장비 감지를 고쳐.', '감지 절차를 확인했다.'),
      pair(71, 'device', '장비 감지 결과는?', '재현 결과를 확인했다.', [70]),
      pair(72, 'scope', '검사 범위를 바꾸자.', '변경할 범위를 물었다.', [71]),
      pair(73, 'scope', '지정한 계정만 검사하는 거지?', '한 계정만 검사하는 것으로 이해했다.', [72]),
      pair(74, 'scope', '맞아. 그렇게 고쳐.', '그 조건을 적용했다고 보고했다.', [73]),
    ],
    current: { n: 75, thread, user: '이제 리더 흐름으로 돌아가 설명해줘.' },
    allowed: new Set([31, 43, 52, 70, 71, 72, 73, 74, 75]),
  }
}

// The host owns local IDs. No prior transcript mutation, title generation,
// model call, filesystem/network lookup or fallback to other sessions.
function assemble(f, choice, required = []) {
  const gap = () => ({ state: 'unresolved', selected: [], topics: [], edges: [] })
  if (choice.kind === 'abstain') return gap()
  if (!['existing', 'split', 'separate'].includes(choice.kind)) return gap()
  const topics = new Map(f.topics.map(t => [t.id, t]))
  const { n, thread: scope } = f.current
  if (choice.kind !== 'separate' && !topics.has(choice.topic)) return gap()
  const topic = choice.kind === 'existing' ? choice.topic : `topic:${scope}:${n}`
  if (choice.kind !== 'existing') {
    if (topics.has(topic)) return gap()
    topics.set(topic, { id: topic, start: n, parent: choice.kind === 'split' ? choice.topic : null })
  }
  const turns = new Map(f.past.map(row => [row.n, row]))
  if (turns.has(n)) return gap()
  turns.set(n, { ...f.current, topic, requires: required })
  const selected = new Set(), usedTopics = new Set(), edges = new Set()
  function visit(id) {
    if (!f.allowed.has(id)) return false
    const row = turns.get(id), t = row && topics.get(row.topic)
    if (!row || row.thread !== scope || !t) return false
    if (selected.has(id)) return true
    const origin = turns.get(t.start)
    if (!origin || origin.topic !== t.id) return false
    // At a new topic's start keep its parent's origin. In an existing topic
    // retain its own origin. Confirmed turn-level requirements add the missing
    // question/decision/return path; siblings and mere proximity add nothing.
    const parent = t.parent === null ? null : topics.get(t.parent)
    if (t.parent !== null && (!parent || !(parent.start < t.start))) return false
    const deps = new Set(row.requires)
    if (id !== t.start) deps.add(t.start)
    else if (parent) deps.add(parent.start)
    for (const dep of deps) {
      if (!(dep < id) || !visit(dep)) return false
      edges.add(`${id}:${dep}`)
    }
    usedTopics.add(t.id); selected.add(id)
    return true
  }
  if (!visit(n)) return gap() // never send a half-supported flow as complete
  const ordered = [...selected].sort((a, b) => a - b).map(k => turns.get(k))
  return { state: 'ready', assigned: topic,
    selected: ordered.map(({ n, user, final }) => final === undefined ? { n, user } : { n, user, final }),
    topics: [...usedTopics].map(id => topics.get(id)).sort((a, b) => a.start - b.start)
      .map(t => ({ id: t.id, parent: t.parent, members: ordered.filter(row => row.topic === t.id).map(row => row.n) })),
    edges: [...edges].sort(),
  }
}
function judgeDocuments(f, choice, required, judge) {
  const flow = assemble(f, choice, required)
  return { flow, documents: flow.state === 'ready' ? judge(flow.selected) : null }
}
const returnToReader = { kind: 'existing', topic: 'reader' }

test('return to the parent: restore the confirmed decision chain BEFORE document relevance, not every child', () => {
  const f = fixture(), original = structuredClone(f); let calls = 0
  const { flow, documents } = judgeDocuments(f, returnToReader, [43, 74], rows => {
    calls++
    assert.deepEqual(rows.map(r => r.n), [31, 43, 70, 71, 72, 73, 74, 75])
    assert.equal(rows.find(r => r.n === 74).user, '맞아. 그렇게 고쳐.')
    assert.equal(rows.find(r => r.n === 73).final, '한 계정만 검사하는 것으로 이해했다.')
    assert.deepEqual(rows.at(-1), { n: 75, user: f.current.user }) // not-yet-written answer is absent
    return ['fixture document: permitted scan scope'] // canned judge, not a model accuracy score
  })
  assert.equal(calls, 1); assert.equal(documents.length, 1); assert.equal(flow.assigned, 'reader')
  assert.deepEqual(flow.topics, [{ id: 'reader', parent: null, members: [31,43,75] },
    { id: 'device', parent: 'reader', members: [70,71] }, { id: 'scope', parent: 'device', members: [72,73,74] }])
  assert.deepEqual(flow.edges, ['43:31','70:31','71:70','72:70','72:71','73:72','74:72','74:73','75:31','75:43','75:74'])
  assert.deepEqual(f, original) // including the omitted sibling and the unchanged transcript
})

test('return to an older subtopic; unrelated later sibling or descendant is not needed just by date', () => {
  const f = fixture(); f.current.user = '장비 감지 확인으로 돌아가자.'
  const r = assemble(f, { kind: 'existing', topic: 'device' }, [71])
  assert.equal(r.assigned, 'device'); assert.deepEqual(r.selected.map(x => x.n), [31,70,71,75])
  assert.deepEqual(r.topics.find(x => x.id === 'device').members, [70,71,75])
})

test('a split keeps its parent; a separate root inherits nothing; abstaining never manufactures a topic', () => {
  const f = fixture(), key = `topic:${thread}:75`
  const split = assemble(f, { kind: 'split', topic: 'reader' }); assert.equal(split.assigned, key)
  assert.deepEqual(split.topics, [{ id: 'reader', parent: null, members: [31] }, { id: key, parent: 'reader', members: [75] }])
  assert.deepEqual(assemble(f, { kind: 'separate' }).topics, [{ id: key, parent: null, members: [75] }])
  assert.deepEqual(assemble(f, { kind: 'abstain' }).topics, [])
  assert.equal(assemble(f, { kind: 'existing', topic: 'not-catalogued' }).state, 'unresolved')
})

for (const [reason, change] of [
  ['withheld', f => { f.allowed.delete(73); Object.defineProperty(f.past.find(t => t.n === 73), 'user', { get: () => assert.fail('withheld body read') }) }],
  ['wrong thread', f => { f.past.find(t => t.n === 73).thread = 'other-session' }],
  ['missing turn', f => { f.past = f.past.filter(t => t.n !== 73) }],
  ['cyclic dependency', f => { f.past.find(t => t.n === 73).requires.push(74) }],
  ['cyclic topic tree', f => { f.topics[0].parent = 'scope' }],
]) test(`required predecessor ${reason}: no packet, no document judgment`, () => {
  const f = fixture(); change(f)
  const r = judgeDocuments(f, returnToReader, [43,74], () => assert.fail('premature judgment'))
  assert.equal(r.flow.state, 'unresolved'); assert.deepEqual(r.flow.selected, []); assert.equal(r.documents, null)
})
