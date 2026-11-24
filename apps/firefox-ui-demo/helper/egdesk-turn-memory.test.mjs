import test from 'node:test'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, chmod } from 'node:fs/promises'
import { buildWiki } from './egdesk-wiki-reconstruction.mjs'
import { SYNTHETIC_PAGES, mockJudge } from './egdesk-wiki-reconstruction.fixture.mjs'
import { createWikiWriter, deriveTurnPosition, judgeTurnWrite, prepareTurnMemory, recordFromLabels, triageTurn, usableReceipts } from './egdesk-turn-memory.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'

const ASKED = Date.parse('2026-11-24T14:30:00+09:00')
const SCOPE = { allowedScopes: ['dm:this-room'], writeScope: 'dm:this-room' }
const THREAD = 'native-thread-1'
const PG_HELD = ['db/pg-design', 'db/pg-plan', 'db/pg-rollback', 'db/sqlite-schema']
const hash = body => crypto.createHash('sha256').update(body).digest('hex')
const receiptsFor = (wiki, ids, threadKey = THREAD) => ({ usable: true, threadKey, pages: Object.fromEntries(ids.map(id => [id, { revision: wiki.pages.get(id).revision, hash: hash(wiki.pages.get(id).body) }])) })
const FIRST = { kind: 'first', reason: 'no_native_thread' }, MID = { kind: 'mid', reason: 'live_thread' }
const turn = async (message, { position = MID, wiki = buildWiki(SYNTHETIC_PAGES), held = PG_HELD, ontologyWrite = false, budget = {}, client, delivered, skipOnNeed, heldExcerpts } = {}) => {
  const log = []
  const r = await prepareTurnMemory({ message, wiki, client: client ?? mockJudge(log), scope: SCOPE, askedAt: ASKED, position, threadKey: THREAD, ontologyWrite, budget, ...(skipOnNeed === undefined ? {} : { skipOnNeed }), ...(heldExcerpts === undefined ? {} : { heldExcerpts }),
    delivered: delivered ?? (held ? receiptsFor(wiki, held) : null) })
  return { r, log, wiki }
}
const ids = r => r.memory.picks.map(p => p.id)

test('turn position comes from runtime facts: no thread, a fresh thread, no prior turns, a compacted context are all "first"; doubt means first', () => {
  assert.deepEqual(deriveTurnPosition({}), { kind: 'first', reason: 'no_native_thread' })
  assert.equal(deriveTurnPosition({ threadId: 't', startsFreshThread: true, priorCompletedTurns: 3 }).kind, 'first')
  assert.equal(deriveTurnPosition({ threadId: 't', priorCompletedTurns: 0 }).reason, 'no_prior_turns')
  assert.equal(deriveTurnPosition({ threadId: 't', priorCompletedTurns: 2, compacted: true }).reason, 'context_compacted')
  assert.equal(deriveTurnPosition({ threadId: 't', priorCompletedTurns: 2 }).kind, 'mid')
  assert.equal(deriveTurnPosition({ threadId: 't', priorCompletedTurns: 2, resumed: true }).reason, 'resumed_thread_with_history')
  for (const bad of [NaN, -1, 1.5, '2', null]) assert.equal(deriveTurnPosition({ threadId: 't', priorCompletedTurns: bad }).kind, 'first')
  assert.equal(deriveTurnPosition({ threadId: '' }).kind, 'first')
})

test('receipts count only mid-session on the same native thread; a first turn, another thread or a compacted context treats every page as not held', () => {
  const wiki = buildWiki(SYNTHETIC_PAGES), good = receiptsFor(wiki, PG_HELD)
  assert.equal(usableReceipts(good, MID, THREAD).usable, true)
  for (const [d, pos, key] of [[good, FIRST, THREAD], [good, MID, 'other-thread'], [{ ...good, usable: false }, MID, THREAD], [null, MID, THREAD], [good, MID, null]]) {
    const u = usableReceipts(d, pos, key)
    assert.equal(u.usable, false); assert.deepEqual(u.pages, {})
  }
})

test('mid-session never reconstructs: the judge gets the MID-CONVERSATION rules, held pages by header only, and the packet repeats none of them', async () => {
  const { r, log } = await turn('PostgreSQL 마이그레이션 배포 끝났어')
  assert.equal(r.position.kind, 'mid'); assert.equal(r.memory.receipts.mode, 'next')
  // The triage request shows each held page's start (<= 200 chars, the default that makes "already covered" judgeable); the fetch requests never do.
  const wire = log.filter(l => !l.questions.includes('tn_courtesy')).map(l => l.input).join('\n')
  assert.ok(log.filter(l => !l.questions.includes('tn_courtesy')).every(l => l.next), 'every fetch request is a next-judgment request')
  assert.match(wire, /MID-CONVERSATION/); assert.match(log.map(l => l.input).join('\n'), /Held in the answering model's context/)
  const heldBodies = PG_HELD.map(id => SYNTHETIC_PAGES.find(p => p.id === id).body)
  // Held pages are shown to the judge by their start (<= 200 chars) so it can tell what is covered, but they are never OPTIONS and never in the packet.
  const optionTitles = [...wire.matchAll(/^P\d+ \| .* \| (.+)$/gm)].map(m => m[1])
  for (const id of PG_HELD) { const page = SYNTHETIC_PAGES.find(p => p.id === id); assert.ok(!optionTitles.includes(page.title), `held page ${id} is not an option`) }
  for (const body of heldBodies) assert.ok(!r.packet.includes(body), 'a held page is not re-sent to the answering model')
  assert.deepEqual(ids(r).sort(), ['db/pg-followup', 'db/pg-health'])
  assert.deepEqual(r.memory.receipts.skippedDelivered.sort(), [...PG_HELD].sort())
  assert.match(r.packet, /Pages you already hold from earlier in this conversation are not repeated/)
})

test('the same message as a first turn reconstructs from the wiki: first-turn rules, nothing held, the plan page arrives with its content', async () => {
  const { r, log } = await turn('PostgreSQL 마이그레이션 배포 끝났어', { position: FIRST, held: null })
  assert.equal(r.memory.receipts.mode, 'first')
  assert.ok(!log.some(l => l.next))
  assert.ok(ids(r).includes('db/pg-plan') && ids(r).includes('db/pg-design'))
  assert.match(r.packet, /pages chosen by a judge that read their contents/)
  assert.match(r.packet, /\[page id=db\/pg-plan time=planned [^\]]*status-recorded=plan/)
})

test('mid-session options are the runtime candidates minus what the live context holds: held pages never appear among the options', async () => {
  const { log } = await turn('지난주 A사 견적 건 어디까지 됐지?', { held: ['quote/a-request', 'quote/a-v1'] })
  const scan = log.find(l => l.questions.some(q => q.startsWith('pg_')))
  const optionTitles = scan.input.split('\n').filter(x => /^P\d+ \|/.test(x))
  assert.ok(optionTitles.length >= 20)
  assert.ok(!optionTitles.some(x => /A사 견적 요청 접수|A사 견적서 v1 발송/.test(x)))
  assert.ok(optionTitles.some(x => /A사 견적서 v2 수정 계획/.test(x)))
  assert.match(scan.input, /- A사 견적 요청 접수 \|/); assert.match(scan.input, /- A사 견적서 v1 발송 \|/, 'held pages are listed by title and status only')
})

test('mid-session links-first: only the link neighbours of what is held are scanned first; the rest is reported, widened only when nothing was found', async () => {
  const wiki = buildWiki(SYNTHETIC_PAGES)
  const { r, log } = await turn('PostgreSQL 마이그레이션 배포 끝났어', { wiki, budget: { linksFirst: true } })
  const scan = log.find(l => l.questions.some(q => q.startsWith('pg_')))
  assert.ok(scan.questions.filter(q => q.startsWith('pg_')).length <= 6)
  assert.deepEqual(ids(r).sort(), ['db/pg-followup', 'db/pg-health'])
  assert.ok(r.memory.receipts.unscanned.length > 15); assert.equal(r.memory.receipts.linksFirst.widened, undefined)
  // nothing near: the judge finds nothing among neighbours, so the rest is scanned once
  const none = { async decide(req) { const names = req.questions.map(q => q.name)
    return { answers: Object.fromEntries(names.map(n => [n, n.startsWith('tn_need') ? { type: 'predicate', probability: 0.9 } : n.startsWith('pg_') ? { type: 'predicate', probability: 0.02 } : { type: 'predicate', probability: 0.02 }])), usage: { inputTokens: 1 } } } }
  const widened = await turn('회식 장소 정해졌어?', { wiki: buildWiki(SYNTHETIC_PAGES), client: none, budget: { linksFirst: true, maxCatalogChars: 900 } })
  assert.equal(widened.r.memory.receipts.linksFirst.widened, true)
})

test('small talk mid-session: one tiny call, nothing fetched, nothing sent to the answering model, no write judgment', async () => {
  const { r, log } = await turn('고마워', { ontologyWrite: true })
  assert.equal(log.length, 1); assert.deepEqual(log[0].questions, ['tn_courtesy', 'tn_need', 'tn_recall', 'tn_record'])
  assert.equal(r.memory.status, 'skipped'); assert.equal(r.packet, null); assert.equal(r.judgeWrite, null); assert.equal(r.writeSkipped, 'not_worth_recording')
  assert.ok(!/연결 풀 응답|단가 12,800원|12월 첫째 주에|흐름: 1\)/.test(log[0].input.replace(/Held in[\s\S]*?\n\nStored pages/, 'Stored pages')), 'the triage request carries titles of other pages, never their content')
})

test('triage that is undecided or failed still fetches: only a decided "no" skips; a failure never invents a write', async () => {
  const dead = { async decide() { throw Object.assign(new Error('x'), { code: 'timeout' }) } }
  const t = await triageTurn({ message: '배포 끝났어', client: dead })
  assert.equal(t.status, 'fallback'); assert.equal(t.need.state, 'unknown'); assert.equal(t.record.state, 'unknown')
  const judge = mockJudge(), unsure = { async decide(req) { const r = await judge.decide(req); if (req.questions.some(q => q.name === 'tn_need')) r.answers.tn_need = { type: 'predicate', probability: 0.5 }; return r } }
  const { r } = await turn('PostgreSQL 마이그레이션 배포 끝났어', { client: unsure })
  assert.equal(r.triage.need.state, 'unknown'); assert.notEqual(r.memory.status, 'skipped')
  const failed = await prepareTurnMemory({ message: '배포 끝났어', wiki: buildWiki(SYNTHETIC_PAGES), client: dead, scope: SCOPE, position: MID, threadKey: THREAD, ontologyWrite: true, delivered: receiptsFor(buildWiki(SYNTHETIC_PAGES), PG_HELD) })
  assert.equal(failed.judgeWrite, null)
})

test('write judgment off by default: no record question, no judge thunk; first turn runs no triage then', async () => {
  const { r, log } = await turn('PostgreSQL 마이그레이션 배포 끝났어', { position: FIRST, held: null })
  assert.equal(r.triage, null); assert.equal(r.judgeWrite, null); assert.equal(r.writeSkipped, 'flag_off')
  assert.ok(!log.some(l => l.questions.includes('tn_record')))
})

test('"배포 끝났어" is a status-change PROPOSAL for the plan page (isolated axes give time and provenance); the proposal carries no text and nothing is stored by the judge', async () => {
  const wiki = buildWiki(SYNTHETIC_PAGES), before = JSON.stringify([...wiki.pages.values()].map(p => [p.id, p.status, p.revision, p.statusReadings]))
  const { r, log } = await turn('PostgreSQL 마이그레이션 배포 끝났어', { wiki, ontologyWrite: true })
  assert.equal(typeof r.judgeWrite, 'function')
  const { proposal, receipt } = await r.judgeWrite()
  assert.deepEqual(proposal, { op: 'update_status', pageId: 'db/pg-plan', baseRevision: '1', proposedStatus: 'done', time: { slice: 'past' }, provenance: { kind: 'utterance', by: 'user' }, spokenAt: '2026-11-24T05:30:00.000Z' })
  assert.ok(!JSON.stringify(proposal).includes('PostgreSQL'), 'no message text in a proposal')
  assert.equal(receipt.labels.time, 'past_unspecified'); assert.equal(receipt.labels.source, 'unknown', 'a label under its bar is not installed and not guessed')
  const write = log.at(-1)
  assert.ok(write.questions.some(q => q.startsWith('speech_time_0')) && !write.questions.some(q => q.startsWith('speechp_')), 'isolated AXES, not predicates')
  assert.match(write.input, /Candidate pages:/)
  assert.equal(JSON.stringify([...wiki.pages.values()].map(p => [p.id, p.status, p.revision, p.statusReadings])), before)
})

test('options are runtime-enumerated: existing candidate pages, "new" and "none"; thanks, questions and unclear targets are not recorded', async () => {
  const wiki = buildWiki(SYNTHETIC_PAGES)
  const cands = ['db/pg-plan', 'db/pg-health'].map(id => wiki.pages.get(id))
  const judge = mockJudge(), q = async (message, client = judge) => (await judgeTurnWrite({ message, candidates: cands, client, askedAt: ASKED })).proposal
  assert.deepEqual(await q('고마워'), { op: 'none', reason: 'not_recorded' })
  assert.equal((await q('지난주 A사 견적 건 어디까지 됐지?')).reason, 'not_recorded')
  const low = { async decide(req) { const r = await judge.decide(req); r.answers.tw_target = { type: 'choice', choice: 'P1', confidence: 0.3, probabilities: [{ value: 'P1', probability: 0.4 }, { value: 'new', probability: 0.35 }, { value: 'none', probability: 0.15 }, { value: 'P2', probability: 0.05 }, { value: 'unsure', probability: 0.05 }] }; return r } }
  assert.equal((await q('PostgreSQL 마이그레이션 배포 끝났어', low)).reason, 'target_undecided')
  const names = []; await judgeTurnWrite({ message: 'x 했어', candidates: cands, client: { async decide(req) { names.push(req.questions.find(x => x.name === 'tw_target').choices.map(c => c.value)); return { answers: {} } } }, askedAt: ASKED })
  assert.deepEqual(names[0], ['P1', 'P2', 'new', 'none', 'unsure'])
  const newFact = await q('거래처 D사가 어제 단가를 올렸다고 들었어.')
  assert.equal(newFact.op, 'new_page'); assert.equal(newFact.provenance.kind, 'reported_by_other'); assert.equal(newFact.provenance.basis, 'attributed_report'); assert.equal(newFact.time.slice, 'past')
  assert.equal(recordFromLabels({ form: 'question' }).recordable, false)
  assert.deepEqual([recordFromLabels({ form: 'plan', time: 'future_anchored' }).slice, recordFromLabels({ form: 'conditional' }).slice, recordFromLabels({ form: 'assertion', time: 'at_utterance' }).slice, recordFromLabels({ form: 'unknown', time: 'past_anchored' }).slice], ['planned', 'hypothetical', 'present', 'unknown'])
})

test('write path is off by default, then checks permission, revision and idempotency; a status change is a pending reading kept apart from the status', async () => {
  const wiki = buildWiki(SYNTHETIC_PAGES)
  const proposal = { op: 'update_status', pageId: 'db/pg-plan', baseRevision: '1', proposedStatus: 'done', time: { slice: 'past' }, provenance: { kind: 'utterance', by: 'user' }, spokenAt: '2026-11-24T05:30:00.000Z' }
  const opts = { message: 'PostgreSQL 마이그레이션 배포 끝났어', scope: SCOPE, operationId: 'op-1' }
  assert.deepEqual(createWikiWriter(wiki).apply(proposal, opts), { status: 'disabled' })
  assert.equal(wiki.pages.get('db/pg-plan').statusReadings.length, 0)
  assert.equal(createWikiWriter(wiki, { enabled: true }).apply(proposal, opts).status, 'denied', 'no host write permission means no write')
  const writer = createWikiWriter(wiki, { enabled: true, canWrite: () => true })
  assert.equal(writer.apply({ ...proposal, baseRevision: '0' }, opts).status, 'conflict')
  const stored = writer.apply(proposal, opts)
  assert.deepEqual([stored.status, stored.revision], ['recorded_pending', '2'])
  const page = wiki.pages.get('db/pg-plan')
  assert.equal(page.status, 'plan', 'the stored status is untouched until the host policy accepts'); assert.deepEqual(page.statusReadings, [{ status: 'done', state: 'pending', basis: null, spokenAt: '2026-11-24T05:30:00.000Z' }])
  assert.deepEqual(writer.apply(proposal, opts), { ...stored, replay: true }, 'same operation, same input: the same receipt')
  assert.equal(writer.apply(proposal, { ...opts, message: 'another text' }).status, 'conflict', 'same operationId with different input is a conflict')
  assert.equal(writer.apply({ ...proposal, baseRevision: '1' }, { ...opts, operationId: 'op-2' }).status, 'conflict', 'the judge saw revision 1, the page is now 2')
  const ignoring = buildWiki(SYNTHETIC_PAGES), w2 = createWikiWriter(ignoring, { enabled: true, canWrite: () => true, acceptStatus: () => true })
  assert.equal(w2.apply(proposal, opts).status, 'recorded_pending', 'a policy callback can no longer promote a reading')
  assert.equal(ignoring.pages.get('db/pg-plan').status, 'plan')
})

test('proposals are re-validated, never trusted: unknown ops, vocabulary outside the closed sets, missing pages, missing operation id or text', () => {
  const wiki = buildWiki(SYNTHETIC_PAGES), writer = createWikiWriter(wiki, { enabled: true, canWrite: () => true })
  const ok = { op: 'new_page', time: { slice: 'past' }, status: 'done', provenance: { kind: 'utterance', by: 'user' }, links: [], spokenAt: '2026-11-24T05:30:00.000Z' }
  const o = { message: '새 사실이야', scope: SCOPE, operationId: 'x' }
  for (const bad of [null, 'x', { op: 'delete_everything' }, { ...ok, time: { slice: 'someday' } }, { ...ok, provenance: { kind: 'own_record' } }, { ...ok, provenance: { kind: 'utterance', basis: 'rumor' } },
    { op: 'update_status', pageId: 'ghost', baseRevision: '1', proposedStatus: 'done', time: { slice: 'past' }, provenance: { kind: 'utterance' } },
    { op: 'update_status', pageId: 'db/pg-plan', baseRevision: '1', proposedStatus: 'superseded', time: { slice: 'past' }, provenance: { kind: 'utterance' } }]) {
    assert.equal(writer.apply(bad, o).status, 'invalid', JSON.stringify(bad))
  }
  assert.equal(writer.apply(ok, { ...o, operationId: null }).status, 'invalid')
  assert.equal(writer.apply(ok, { ...o, message: '' }).status, 'invalid'); assert.equal(writer.apply(ok, { ...o, message: 'x'.repeat(2001) }).status, 'invalid')
  assert.deepEqual(writer.apply({ op: 'none' }, o), { status: 'noop' })
})

test('a new page stores the person\'s own words verbatim with time slice, provenance and speaking time; event time stays unknown; links only to readable pages', async () => {
  const wiki = buildWiki(SYNTHETIC_PAGES), writer = createWikiWriter(wiki, { enabled: true, canWrite: ({ op }) => op === 'new_page' })
  const message = '거래처 D사가 어제 단가를 올렸다고 들었어.'
  const { proposal } = await judgeTurnWrite({ message, candidates: ['quote/a-v1'].map(id => wiki.pages.get(id)), client: mockJudge(), askedAt: ASKED })
  const withPrivate = { ...proposal, links: [...proposal.links, { type: 'same_task', to: 'quote/a-cost' }, { type: 'same_task', to: 'ghost' }] }
  const receipt = writer.apply(withPrivate, { message, scope: { allowedScopes: [], writeScope: 'dm:this-room' }, operationId: 'op-new' })
  assert.equal(receipt.status, 'stored')
  const page = wiki.pages.get(receipt.pageId)
  assert.equal(page.body, message); assert.deepEqual(page.time, { slice: 'past' }); assert.equal(page.time.at, undefined, 'the event time is not the speaking time and is not invented')
  assert.equal(page.spokenAt, '2026-11-24T05:30:00.000Z'); assert.equal(page.scope, 'dm:this-room')
  assert.deepEqual(page.provenance, { kind: 'reported_by_other', by: 'user', basis: 'attributed_report' })
  assert.ok(!wiki.links(page.id).some(l => l.to === 'quote/a-cost' || l.to === 'ghost'), 'no link to a page this scope cannot read, or to a page that does not exist')
})

test('a stored change bumps the revision, so a held page that changed is a new fragment and is sent again', async () => {
  const wiki = buildWiki(SYNTHETIC_PAGES), receipts = receiptsFor(wiki, PG_HELD)
  createWikiWriter(wiki, { enabled: true, canWrite: () => true }).apply({ op: 'update_status', pageId: 'db/pg-plan', baseRevision: '1', proposedStatus: 'done', time: { slice: 'past' }, provenance: { kind: 'utterance', by: 'user' } }, { message: 'x', scope: SCOPE, operationId: 'op' })
  const { r } = await turn('PostgreSQL 마이그레이션 배포 끝났어', { wiki, delivered: receipts })
  assert.ok(!r.memory.receipts.skippedDelivered.includes('db/pg-plan'), 'the changed page is no longer treated as held')
  assert.match(r.packet ?? '', /status-reported-pending=done/)
})

test('permission filtering happens before the write judge sees anything: a page outside the scope is never a candidate', async () => {
  const log = []
  const { r } = await turn('PostgreSQL 마이그레이션 배포 끝났어', { ontologyWrite: true, client: mockJudge(log) })
  await r.judgeWrite()
  assert.ok(!log.map(l => l.input).join('\n').includes('원가는 단가의 71%'))
})

// ---- real runtime state: first turn -> mid-session -> resumed -> compacted ----
test('CodexChatRuntime.turnPosition derives the position from the real thread, store and engine state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-turnpos-')); await chmod(dir, 0o700)
  const profiles = { runProfile: (p, r) => ({ binding: { profileId: p, revision: r ?? 1, hash: 'h' }, developerInstructions: 'x', toolCeiling: null, model: null }) }
  const store = openChatStore({ dataDir: path.join(dir, 'chat'), ownerScope: 'synthetic' })
  let turns = 0, threads = 0
  const chat = new CodexChatRuntime({ now: () => Date.now(), store, requireStore: true, getOwnerKey: () => 'codex:synthetic:qa', profiles, resolveProjectWorkspace: async () => null,
    request: async (method, p) => {
      if (method === 'thread/start') return { thread: { id: `t${++threads}` }, cwd: '/work', model: 'syn' }
      if (method === 'thread/resume') return { thread: { id: p.threadId, turns: [] }, cwd: '/work' }
      if (method === 'config/read') return { config: { developer_instructions: null } }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      const id = `turn-${++turns}`, timing = { threadId: p.threadId, turnId: id }
      setTimeout(async () => { const n = (m, q) => chat.handleNotification({ method: m, params: q })
        await n('item/started', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text: '' } })
        await n('item/completed', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text: '네' } })
        await n('turn/completed', { threadId: p.threadId, turn: { id, status: 'completed', items: [] } }) }, 5)
      return { turn: { id, status: 'inProgress', items: [] } } },
    respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null })
  chat.setConnection(true)
  const seen = []
  const original = chat.prepareDecisionContext.bind(chat)
  chat.prepareDecisionContext = async (body, context) => { seen.push(chat.turnPosition(context)); return original(body, context) }
  const done = async n => { for (let i = 0; i < 200; i++) { await new Promise(r => setTimeout(r, 20)); if (store.listMessages('dm-1').messages.filter(m => m.role === 'assistant' && m.status === 'complete').length >= n) break } await new Promise(r => setTimeout(r, 30)) }
  const first = await chat.send({ message: '첫 질문', clientThreadId: 'dm-1', requestId: 'r1', profileId: 'sol', replyDestination: 'direct' })
  await done(1)
  const send = (message, requestId) => chat.send({ message, clientThreadId: 'dm-1', requestId, conversationId: first.conversationId, profileId: 'sol', replyDestination: 'direct' })
  await send('둘째 질문', 'r2'); await done(2)
  chat.loadedThreads.delete(first.conversationId) // as after a bridge restart: the thread is resumed with its history
  await send('셋째 질문', 'r3'); await done(3)
  chat.markContextCompacted(first.conversationId)
  await send('넷째 질문', 'r4'); await done(4)
  store.close()
  assert.deepEqual(seen.map(p => `${p.kind}/${p.reason}`), ['first/no_native_thread', 'mid/live_thread', 'mid/resumed_thread_with_history', 'first/context_compacted'])
  assert.deepEqual(chat.turnPosition(null), { kind: 'first', reason: 'no_native_thread' })
})

test('the first real run answered "needs stored material" with 1.0 for "고마워": a decided courtesy yes now skips the fetch whatever tn_need says', async () => {
  const judge = mockJudge()
  let calls = 0
  const real = { async decide(req) { calls++; const r = await judge.decide(req); if (req.questions.some(q => q.name === 'tn_need')) { r.answers.tn_need = { type: 'predicate', probability: 1 }; r.answers.tn_courtesy = { type: 'predicate', probability: 1 } } return r } }
  const { r } = await turn('고마워', { client: real, ontologyWrite: true })
  assert.equal(r.triage.need.state, 'yes'); assert.equal(r.triage.courtesy.state, 'yes')
  assert.equal(r.memory.status, 'skipped'); assert.equal(calls, 1, 'only the triage call, no fetch')
  // an undecided courtesy answer does not skip: the fetch is only skipped on a decided answer
  const undecided = { async decide(req) { const r2 = await judge.decide(req); if (req.questions.some(q => q.name === 'tn_courtesy')) r2.answers.tn_courtesy = { type: 'predicate', probability: 0.5 }; return r2 } }
  const second = await turn('PostgreSQL 마이그레이션 배포 끝났어', { client: undecided })
  assert.notEqual(second.r.memory.status, 'skipped')
})

test('triage wording: courtesy is a plain social-act question with no mention of stored material; need no longer says "need none"', async () => {
  let qs
  await triageTurn({ message: '고마워', heldTitles: ['A'], client: { async decide(req) { qs = req.questions; return { answers: {} } } } })
  const by = Object.fromEntries(qs.map(q => [q.name, q.instructions]))
  assert.deepEqual(Object.keys(by), ['tn_courtesy', 'tn_need', 'tn_record'], 'without a stored-page list there is no recall question and the need wording stays the old one')
  assert.doesNotMatch(by.tn_courtesy, /stored|held|notes|documents/)
  assert.doesNotMatch(by.tn_need, /need none/)
})

test('a report whose context is already held skips the fetch but is still judged for recording against the held pages', async () => {
  const judge = mockJudge()
  const heldCovers = { async decide(req) { const r = await judge.decide(req); if (req.questions.some(q => q.name === 'tn_need')) r.answers.tn_need = { type: 'predicate', probability: 0 }; return r } }
  const { r } = await turn('PostgreSQL 마이그레이션 배포 끝났어', { client: heldCovers, ontologyWrite: true, skipOnNeed: true })
  assert.equal(r.memory.status, 'skipped'); assert.equal(r.packet, null)
  assert.equal(typeof r.judgeWrite, 'function')
  const { proposal } = await r.judgeWrite()
  assert.equal(proposal.op, 'update_status'); assert.equal(proposal.pageId, 'db/pg-plan', 'the held plan page is a candidate even though nothing was fetched')
})

test('real T4/T6 data: with titles only a decided need "no" does not skip (the wrong skip); with the held content shown (the default) need "no" skips, need "yes" fetches', async () => {
  const judge = mockJudge()
  const answering = (need, recall = 0) => ({ async decide(req) { const r = await judge.decide(req); if (req.questions.some(q => q.name === 'tn_need')) { r.answers.tn_courtesy = { type: 'predicate', probability: 0 }; r.answers.tn_need = { type: 'predicate', probability: need }; r.answers.tn_recall = { type: 'predicate', probability: recall }; r.answers.tn_record = { type: 'predicate', probability: 0 } } return r } })
  const held = ['db/pg-plan', 'db/pg-health', 'db/pg-followup']
  const titlesOnly = await turn('그럼 롤백 조건은?', { client: answering(0.02), held, heldExcerpts: false })
  assert.equal(titlesOnly.r.triage.need.state, 'no'); assert.notEqual(titlesOnly.r.memory.status, 'skipped', 'titles alone are not enough to skip on need')
  const noSkip = await turn('그럼 롤백 조건은?', { client: answering(0.02), held, skipOnNeed: false })
  assert.notEqual(noSkip.r.memory.status, 'skipped', 'opting out leaves only courtesy skipping')
  const covered = await turn('그럼 롤백 조건은?', { client: answering(0), held: [...held, 'db/pg-rollback'] })
  assert.equal(covered.r.memory.status, 'skipped', 'T6: the rollback page is held and shown, so "no" is right and the fetch is skipped')
  const notHeld = await turn('그럼 롤백 조건은?', { client: answering(1), held })
  assert.notEqual(notHeld.r.memory.status, 'skipped', 'T4x: rollback not held, need yes, fetch runs')
})

test('held pages are shown with their status and the start of their content by default, so "already covered" is judgeable; titles only when switched off', async () => {
  const seen = []
  const capture = { async decide(req) { seen.push(req.input.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n')); return { answers: {} } } }
  await turn('그럼 롤백 조건은?', { client: capture, held: ['db/pg-plan'], heldExcerpts: false })
  assert.ok(!seen[0].includes('아직 배포 전이다') && !seen[0].includes('12월 첫째 주에'), 'titles only when switched off')
  seen.length = 0
  await turn('그럼 롤백 조건은?', { client: capture, held: ['db/pg-plan'] })
  assert.match(seen[0], /- PostgreSQL 마이그레이션 배포 계획 \| status=plan\n  12월 첫째 주에 SQLite에서 PostgreSQL로/)
})

test('no auto-promotion: only the person\'s own later explicit confirmation turns a pending reading into the status', () => {
  const wiki = buildWiki(SYNTHETIC_PAGES), writer = createWikiWriter(wiki, { enabled: true, canWrite: () => true, acceptStatus: () => true })
  const proposal = { op: 'update_status', pageId: 'db/pg-plan', baseRevision: '1', proposedStatus: 'done', time: { slice: 'past' }, provenance: { kind: 'utterance', by: 'user' }, spokenAt: '2026-11-24T05:30:00.000Z' }
  const opts = { message: '배포 끝났어', scope: SCOPE, operationId: 'op-1' }
  assert.equal(writer.apply(proposal, opts).status, 'recorded_pending')
  const page = wiki.pages.get('db/pg-plan')
  const ok = { by: 'user', at: '2026-11-24T06:00:00.000Z' }
  assert.equal(writer.promote('db/pg-plan', { scope: SCOPE, confirmation: ok }).reason, 'operation_id_required')
  for (const bad of [null, {}, { by: 'agent', at: ok.at }, { by: 'policy', at: ok.at }, { by: 'user' }, { by: 'user', at: 'tomorrow' }, 'user', { by: 'USER', at: ok.at }]) {
    assert.equal(writer.promote('db/pg-plan', { scope: SCOPE, confirmation: bad, operationId: 'p-bad' }).reason, 'user_confirmation_required', JSON.stringify(bad))
  }
  assert.equal(writer.promote('db/pg-plan', { scope: SCOPE, confirmation: { by: 'user', at: '2026-11-24T05:29:00.000Z' }, operationId: 'p-early' }).reason, 'confirmation_not_later', 'confirming at or before the reading is not a later confirmation')
  assert.equal(createWikiWriter(wiki, { enabled: true }).promote('db/pg-plan', { scope: SCOPE, confirmation: ok, operationId: 'p-deny' }).status, 'denied')
  assert.equal(createWikiWriter(wiki).promote('db/pg-plan', { scope: SCOPE, confirmation: ok, operationId: 'p-off' }).status, 'disabled')
  assert.equal(page.status, 'plan', 'nothing above changed the status')
  const promoted = writer.promote('db/pg-plan', { scope: SCOPE, confirmation: ok, operationId: 'p-ok' })
  assert.deepEqual([promoted.status, promoted.revision], ['status_updated', '3'])
  assert.deepEqual([page.status, page.statusReadings.map(r => r.state), page.statusReadings[0].confirmedAt], ['done', ['accepted'], ok.at])
  assert.deepEqual(writer.promote('db/pg-plan', { scope: SCOPE, confirmation: ok, operationId: 'p-ok' }), { ...promoted, replay: true })
  assert.equal(writer.promote('db/pg-plan', { scope: SCOPE, confirmation: ok, operationId: 'p-again' }).reason, 'no_pending_reading')
})

test('triage shows the stored pages that are not held, by title only: no bodies, no held pages, no page outside the scope; the list is complete up to 80 titles', async () => {
  const seen = []
  const capture = { async decide(req) { seen.push(req); return { answers: {} } } }
  await turn('아까 jev hook 흐름 다시 정리해줘', { client: capture, held: ['jev/draft', 'jev/utt-user'] })
  const text = seen[0].input.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n')
  const block = text.slice(text.indexOf('Stored pages that are not held (titles only):'))
  assert.match(block, /- jev hook 흐름 메모\(오늘 오전\) \| time=past \| status=done/, 'the page that holds the flow is visible to the judge')
  assert.ok(!block.includes('jev hook 설계 초안') && !block.includes('hook 위치'), 'held pages are not listed again')
  assert.ok(!block.includes('A사 내부 원가'), 'a page outside the scope is not listed')
  assert.ok(!block.includes('흐름: 1) 사용자 입력'), 'titles only, no content')
  assert.deepEqual(seen[0].questions.map(q => q.name), ['tn_courtesy', 'tn_need', 'tn_recall', 'tn_record'])
  assert.match(seen[0].questions[1].instructions, /stored pages that are not held \(listed below, titles only\)/)
})

test('real j-mid ("아까 jev hook 흐름 다시 정리해줘", held draft + utterance): the REAL answers (courtesy 0, need 0.02, record 0, no recall answer) no longer skip; a recall yes or an incomplete list never skips either', async () => {
  const real = JSON.parse(await readFile(new URL('./fixtures/memory-e2e-real-20261124.json', import.meta.url), 'utf8')).requests['j-mid-1-triage']
  const a = Object.fromEntries(real.answers.map(x => [x.name, x]))
  assert.deepEqual([a.tn_courtesy.probability, a.tn_need.probability, a.tn_record.probability], [0, 0.02, 0])
  const judge = mockJudge()
  const replay = extra => ({ async decide(req) { const r = await judge.decide(req); if (req.questions.some(q => q.name === 'tn_need')) { r.answers.tn_courtesy = a.tn_courtesy; r.answers.tn_need = a.tn_need; r.answers.tn_record = a.tn_record; delete r.answers.tn_recall; Object.assign(r.answers, extra) } return r } })
  const held = ['jev/draft', 'jev/utt-user']
  const old = await turn('아까 jev hook 흐름 다시 정리해줘', { client: replay({}), held })
  assert.notEqual(old.r.memory.status, 'skipped', 'what used to be a wrong skip now fetches (recall is undecided)')
  const yes = await turn('아까 jev hook 흐름 다시 정리해줘', { client: replay({ tn_recall: { type: 'predicate', probability: 0.97 } }), held })
  assert.notEqual(yes.r.memory.status, 'skipped')
  const no = await turn('아까 jev hook 흐름 다시 정리해줘', { client: replay({ tn_recall: { type: 'predicate', probability: 0.02 } }), held })
  assert.equal(no.r.memory.status, 'skipped', 'with everything shown, recall no and need no it is the model\'s covered judgment that skips')
  // an incomplete list: more than 80 stored pages that are not held
  const pages = Array.from({ length: 90 }, (_, i) => ({ id: `bulk/p${i}`, title: `문서 ${i}`, body: `내용 ${i}`, revision: '1', time: { slice: 'present' }, provenance: { kind: 'document' }, status: 'done' }))
  const big = buildWiki([...SYNTHETIC_PAGES, ...pages])
  const seen = []
  const wideClient = { async decide(req) { seen.push(req); const r = await replay({ tn_recall: { type: 'predicate', probability: 0.02 } }).decide(req); return r } }
  const wide = await turn('아까 jev hook 흐름 다시 정리해줘', { client: wideClient, held, wiki: big })
  assert.notEqual(wide.r.memory.status, 'skipped', 'the judge did not see every stored page, so "covered" cannot be trusted')
  assert.equal(wide.r.triage.catalog.complete, false); assert.match(JSON.stringify(seen[0].input), /more stored pages are not listed/)
})

test('the fetch shows the start of each held page and asks for what must be decided, verified or done next (real pg-mid: the health-check page scored 0.37, then 0.03 as a second look)', async () => {
  const { log } = await turn('PostgreSQL 마이그레이션 배포 끝났어', { budget: { linksFirst: true } })
  const scan = log.find(l => l.questions.some(q => q.startsWith('pg_')))
  assert.match(scan.input, /the start of each is shown; the rest is not repeated/)
  assert.match(scan.input, /- PostgreSQL 마이그레이션 배포 계획 \| time=planned \| status=plan\n  12월 첫째 주에 SQLite에서 PostgreSQL로/)
  assert.match(scan.input, /decide, verify or do what this message calls for next/)
  assert.match(scan.input, /how success is judged, what is left to do, and what to do if it failed/)
})

test('characterization with the REAL pg-mid scan answers (0.37 / 0.8 / 0.01): an undecided page gets a second look, a second look that answers no closes it; the delivered pages are only the decided ones', async () => {
  const real = JSON.parse(await readFile(new URL('./fixtures/memory-e2e-real-20261124.json', import.meta.url), 'utf8')).requests
  const scan = Object.fromEntries(real['pg-mid-2-scan'].answers.map(x => [x.name, x])), second = Object.fromEntries(real['pg-mid-3-expand'].answers.map(x => [x.name, x]))
  const judge = mockJudge()
  const client = { async decide(req) { const r = await judge.decide(req)
    if (req.questions.some(q => q.name === 'pg_0')) { r.answers.pg_0 = scan.pg_0; r.answers.pg_1 = scan.pg_1; r.answers.pg_2 = scan.pg_2 }
    for (const q of req.questions) if (/^op_P\d+$/.test(q.name)) r.answers[q.name] = second.op_P3
    return r } }
  const { r } = await turn('PostgreSQL 마이그레이션 배포 끝났어', { client, budget: { linksFirst: true }, skipOnNeed: false })
  assert.deepEqual(r.memory.picks.map(p => p.id), ['db/pg-followup'], 'the real answers delivered only the follow-up checklist')
  assert.deepEqual(r.memory.receipts.uncertain.map(u => u.id), ['db/pg-health'], 'the health-check page was undecided and went to a second look')
})
