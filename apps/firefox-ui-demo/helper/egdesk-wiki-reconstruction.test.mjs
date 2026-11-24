import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, LINK_TYPES, RECORD_STATUSES, buildWiki, reconstructMemory } from './egdesk-wiki-reconstruction.mjs'
import { SCENARIOS, SYNTHETIC_PAGES, mockJudge } from './egdesk-wiki-reconstruction.fixture.mjs'

const ASKED = Date.parse('2026-11-24T14:30:00+09:00')
const wiki = () => buildWiki(SYNTHETIC_PAGES)
const run = async (message, opts = {}) => {
  const log = []
  const r = await reconstructMemory({ message, wiki: opts.wiki ?? wiki(), client: opts.client ?? mockJudge(log), askedAt: ASKED, scope: { allowedScopes: ['dm:this-room'] }, ...opts.extra })
  return { r, log }
}
const ids = r => r.picks.map(p => p.id)

test('buildWiki: typed links are validated by code; bad types, missing targets, self links and duplicates are dropped and counted', () => {
  const page = (id, links, extra = {}) => ({ id, title: id, body: `body ${id}`, revision: '1', time: { slice: 'past' }, provenance: { kind: 'own_record' }, status: 'done', links, ...extra })
  const w = buildWiki([page('a', [{ type: 'same_task', to: 'b' }, { type: 'same_task', to: 'b' }, { type: 'made_up', to: 'b' }, { type: 'refers_to', to: 'a' }, { type: 'refers_to', to: 'ghost' }, 'x']),
    page('b', []), page('bad id!', []), { id: 'c', title: 'c', body: '', revision: '1', provenance: { kind: 'own_record' } }, page('d', [], { provenance: { kind: 'invented' } })])
  assert.deepEqual([...w.pages.keys()], ['a', 'b'])
  assert.deepEqual(w.links('a'), [{ type: 'same_task', to: 'b' }])
  assert.deepEqual(w.backlinks('b'), [{ type: 'same_task', from: 'a' }])
  assert.equal(w.warnings.droppedPages, 3); assert.equal(w.warnings.droppedLinks, 5)
  assert.deepEqual(Object.keys(LINK_TYPES), ['same_task', 'follows_from', 'decided_in', 'supersedes', 'refers_to'])
})

test('supersession counts only from a settled page: a plan that supersedes does not make the old record superseded', () => {
  const w = wiki()
  assert.deepEqual(w.supersededBy('quote/a-v1'), [], 'a-v2-plan is still a plan')
  const page = (id, extra) => ({ id, title: id, body: `b ${id}`, revision: '1', time: { slice: 'past' }, provenance: { kind: 'own_record' }, status: 'done', links: [], ...extra })
  const done = buildWiki([page('old'), page('new', { links: [{ type: 'supersedes', to: 'old' }] })])
  assert.deepEqual(done.supersededBy('old'), ['new'])
})

test('the judge reads page CONTENT, not only titles: bodies are in the request and decide the pick', async () => {
  const w = buildWiki([
    { id: 'p1', title: '메모 가', body: '비밀번호 재설정 절차는 세 단계다.', revision: '1', time: { slice: 'present' }, provenance: { kind: 'document' }, status: 'done' },
    { id: 'p2', title: '메모 나', body: '회식 장소는 아직 정하지 않았다.', revision: '1', time: { slice: 'present' }, provenance: { kind: 'document' }, status: 'done' }])
  const seen = []
  const client = { async decide(req) { seen.push(req); const text = req.input.map(m => m.content).join('\n')
    return { answers: Object.fromEntries(req.questions.map(q => [q.name, { type: 'predicate', probability: q.name === 'pg_0' && /비밀번호/.test(text) ? 0.95 : 0.02 }])), usage: { inputTokens: 10 } } } }
  const { r } = await run('비밀번호 어떻게 바꾸지', { wiki: w, client })
  assert.deepEqual(ids(r), ['p1'])
  assert.match(JSON.stringify(seen[0].input), /세 단계다/, 'the body text itself reached the judge')
  assert.match(r.packet, /세 단계다/)
})

test('scope and permission: a page outside the allowed scope, or whose guard says no, never appears in any request or the packet', async () => {
  const log = []
  const w = wiki()
  w.pages.get('misc/dinner').mayRead = () => false
  const { r } = await run('지난주 A사 견적 건 어디까지 됐지?', { wiki: w, client: mockJudge(log) })
  const all = log.map(l => l.input).join('\n') + (r.packet ?? '')
  assert.ok(!/원가는 단가의 71%/.test(all) && !/A사 내부 원가/.test(all), 'private-scope page content and title never left')
  assert.ok(!/회식/.test(all), 'guard denied')
  assert.equal(r.receipts.withheld, 2)
  const allowed = await run('A사 내부 원가는?', { extra: { scope: { allowedScopes: ['dm:other-room'] } } })
  assert.match(JSON.stringify(allowed.log.map(l => l.input)), /71%/, 'the owner room of that scope may read it')
})

test('links are the options: the judge cannot open a page the code did not offer, and an unknown answer name is ignored', async () => {
  const log = []
  const client = { async decide(req) { log.push(req)
    const answers = {}
    for (const q of req.questions) answers[q.name] = q.type === 'predicate' ? { type: 'predicate', probability: q.name === 'pg_1' ? 0.95 : 0.02 } : { type: 'choice', choice: 'unknown', confidence: 1, probabilities: [{ value: 'unknown', probability: 1 }] }
    answers.op_P99 = { type: 'predicate', probability: 1 }; answers.pg_999 = { type: 'predicate', probability: 1 }
    return { answers, usage: { inputTokens: 1 } } } }
  const { r } = await run('배포 계획 알려줘', { client })
  assert.equal(ids(r).length, 1)
  assert.ok(wiki().pages.has(ids(r)[0]))
})

test('three scenarios: reconstructed packet carries content, time, provenance, recorded status, status read and links', async () => {
  const a = await run(SCENARIOS[0].message)
  assert.deepEqual(ids(a.r).sort(), ['quote/a-decision', 'quote/a-meeting', 'quote/a-request', 'quote/a-v1', 'quote/a-v2-plan'])
  assert.match(a.r.packet, /\[page id=quote\/a-meeting time=past@2026-11-14 provenance=reported_by_other:팀장 status-recorded=reported_by_other status-read=reported_by_other/)
  assert.match(a.r.packet, /quote\/a-v2-plan supersedes quote\/a-v1/)
  assert.doesNotMatch(a.r.packet, /superseded-by=/, 'the v2 plan has not replaced v1')
  assert.ok(!/원가/.test(a.r.packet))
  const b = await run(SCENARIOS[1].message)
  assert.ok(ids(b.r).includes('db/pg-plan') && ids(b.r).includes('db/sqlite-schema'))
  assert.match(b.r.packet, /\[page id=db\/pg-plan time=planned [^\]]*status-recorded=plan status-read=plan/, 'a completion report does not turn the recorded plan into done')
  const c = await run(SCENARIOS[2].message)
  assert.ok(['jev/flow-note', 'jev/utt-user', 'jev/utt-agent', 'jev/draft'].every(id => ids(c.r).includes(id)))
  assert.match(c.r.packet, /provenance=utterance:사용자[^\]]*/)
})

test('status reading is advisory and fallible: low confidence or unknown shows no reading; stored metadata and the wiki are never changed', async () => {
  const w = wiki()
  const before = JSON.stringify([...w.pages.values()].map(p => [p.id, p.status, p.revision, p.body]))
  const judge = mockJudge()
  const client = { async decide(req) { const r = await judge.decide(req)
    for (const q of req.questions) if (q.name.startsWith('st_')) r.answers[q.name] = { type: 'choice', choice: 'done', confidence: 0.4, probabilities: [{ value: 'done', probability: 0.4 }, { value: 'plan', probability: 0.35 }] }
    return r } }
  const { r } = await run(SCENARIOS[1].message, { wiki: w, client })
  assert.ok(r.picks.length > 0 && r.picks.every(p => p.statusRead === undefined))
  assert.doesNotMatch(r.packet, /status-read=/)
  assert.equal(JSON.stringify([...w.pages.values()].map(p => [p.id, p.status, p.revision, p.body])), before)
  assert.ok(Object.keys(RECORD_STATUSES).includes('unknown'), 'an explicit unknown option exists, so a poor fit is not forced into a class')
})

test('stateless calls: every request carries the message, the clock and an explicit state block, and re-shows picked pages with fresh aliases', async () => {
  const { log } = await run(SCENARIOS[0].message)
  assert.ok(log.length >= 2)
  for (const l of log) { assert.match(l.input, /Question clock: 2026-11-24T05:30:00.000Z/); assert.match(l.input, /State: round=/); assert.match(l.input, /지난주 A사 견적 건/) }
  assert.match(log[1].input, /Picked pages:\nP1 \|/)
  assert.match(log[1].input, /Linked pages you may open:/)
})

test('budget: scan batches, call count, picks and packet size are bounded and what was left out is reported, never silent', async () => {
  const small = await run('지난주 A사 견적 건 어디까지 됐지?', { extra: { budget: { maxCatalogChars: 600, maxScanCalls: 1 } } })
  assert.ok(small.r.receipts.unscanned.length > 0)
  assert.equal(small.log[0].questions.length + small.r.receipts.unscanned.length + small.r.receipts.withheld, 31)
  const one = await run(SCENARIOS[0].message, { extra: { budget: { maxCalls: 1 } } })
  assert.equal(one.r.calls, 1); assert.ok(one.r.picks.length > 0); assert.ok(one.r.picks.every(p => p.via === 'scan' && p.statusRead === undefined))
  const few = await run(SCENARIOS[0].message, { extra: { budget: { maxPicks: 2 } } })
  assert.ok(few.r.picks.length <= 2); assert.ok(few.r.receipts.truncated.some(t => t.reason === 'pick_limit'))
  const tight = await run(SCENARIOS[0].message, { extra: { budget: { maxPacketChars: 300, pageChars: 60 } } })
  assert.ok(tight.r.receipts.truncated.some(t => t.reason === 'page_chars' || t.reason === 'packet_chars'))
  assert.ok(DEFAULTS.maxCalls >= 3)
})

test('failure: no answer in the first round is a fallback; a failing later round keeps the picks so far as partial', async () => {
  const dead = await run('A사 견적', { client: { async decide() { throw Object.assign(new Error('x'), { code: 'timeout' }) } } })
  assert.equal(dead.r.status, 'fallback'); assert.equal(dead.r.reason, 'timeout'); assert.equal(dead.r.packet, null)
  const judge = mockJudge(); let n = 0
  const flaky = await run(SCENARIOS[0].message, { client: { async decide(req) { if (++n === 2) throw Object.assign(new Error('x'), { code: 'rate_limited' }); return judge.decide(req) } } })
  assert.equal(flaky.r.status, 'ready'); assert.equal(flaky.r.partial, true); assert.equal(flaky.r.reason, 'rate_limited'); assert.ok(flaky.r.picks.length > 0)
})

test('delivered-fragment receipts: unchanged pages the thread already holds are excluded before judging and never re-sent; changed or compacted ones are', async () => {
  const first = await run(SCENARIOS[0].message)
  const commit = first.r.nextDelivered()
  const again = await run(SCENARIOS[0].message, { extra: { delivered: commit } })
  const sentBodies = again.log.map(l => l.input).join('\n') + (again.r.packet ?? '')
  assert.ok(!/단가 12,800원으로 견적서 v1을/.test(sentBodies), 'a delivered, unchanged page is not sent to the judge or the model again')
  assert.deepEqual(again.r.receipts.skippedDelivered.sort(), ids(first.r).sort())
  // a changed body is a new fragment
  const w2 = wiki(); w2.pages.get('quote/a-v1').body += ' 11월 20일 A사가 회신했다.'
  const changed = await run(SCENARIOS[0].message, { wiki: w2, extra: { delivered: commit } })
  assert.ok(ids(changed.r).includes('quote/a-v1')); assert.match(changed.r.packet, /11월 20일 A사가 회신했다/)
  // after a compaction the thread may have lost them: everything is eligible again
  const compacted = await run(SCENARIOS[0].message, { extra: { delivered: { ...commit, usable: false } } })
  assert.deepEqual(ids(compacted.r).sort(), ids(first.r).sort())
  // the receipt is a pure value: nothing is committed until the host says the turn really started
  assert.deepEqual(first.r.nextDelivered(), commit)
  assert.equal(await Promise.resolve(JSON.stringify(commit.pages['quote/a-v1']).includes('hash')), true)
  assert.ok(!JSON.stringify(commit).includes('발송했다'), 'receipts hold revisions and hashes, never text')
})

test('packet rules keep the epistemic boundaries: planned is not current, relayed is not independent, readings are not proof; no date is computed', async () => {
  const { r } = await run(SCENARIOS[0].message)
  assert.match(r.packet, /planned or hypothetical page is not a current fact/)
  assert.match(r.packet, /reported_by_other is attribution/)
  assert.match(r.packet, /not proof and not permission to change any record/)
  assert.match(r.packet, /judge, do not compute dates/)
  assert.ok(!/2026-11-1[0-9] 이전|지난주는/.test(r.packet))
})
