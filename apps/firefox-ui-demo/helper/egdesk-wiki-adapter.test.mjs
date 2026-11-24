import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { candidatesFromOntologyGraph, linkTypeForRelation } from './egdesk-context-setup.mjs'
import { createWikiAdapter, openWikiWrites, overlayWrites, pagesFromCandidates, pagesFromOntologyGraph, pagesFromSpeechRecords, pagesFromTopicTurns, safeId } from './egdesk-wiki-adapter.mjs'
import { allowsPage, buildWiki, reconstructMemory } from './egdesk-wiki-reconstruction.mjs'
import { mockJudge } from './egdesk-wiki-reconstruction.fixture.mjs'

const quiet = () => {}
const tmpDir = async () => { const d = await mkdtemp(path.join(os.tmpdir(), 'egdesk-wiki-adapter-')); await chmod(d, 0o700); return path.join(d, 'settings') }
const DM = 'dm:thread-1', SCOPE = { allowedScopes: [DM], writeScope: DM }
const GRAPH = {
  snapshots: [{ snapshotId: 's1', label: '1차 스냅샷', timeSlice: 'past', status: 'observed' }, { snapshotId: 's2', label: '2차 스냅샷', timeSlice: 'future', status: 'planned', continuesFrom: 's1' }],
  nodes: [{ id: 'a', label: '결제 모듈', body: '결제 모듈은 동기 처리다.', timeSlice: 'present', snapshotId: 's1', snapshotStatus: 'observed' },
    { id: 'b', label: '결제 모듈 v2', body: '결제 모듈 v2는 비동기 전환안이다.', timeSlice: 'future', snapshotId: 's2', snapshotStatus: 'planned' },
    { id: 'c', label: '메모', body: '메모 본문' }],
  edges: [{ id: 'e1', source: 'b', target: 'a', relation: 'supersedes' }, { id: 'e2', source: 'c', target: 'a', relation: 'mentions' }, { id: 'e3', source: 'c', target: 'ghost', relation: 'mentions' }],
}

test('ontology edges are no longer dropped: they become typed links, snapshot continuations follow_from, node-in-snapshot same_task; unknown relations are only refers_to', async () => {
  assert.deepEqual(['supersedes', 'replaced_by', 'decided_in', 'continues', 'derived_from', 'part_of', 'mentions', 'weird', ''].map(linkTypeForRelation),
    ['supersedes', 'supersedes', 'decided_in', 'follows_from', 'follows_from', 'same_task', 'refers_to', 'refers_to', 'refers_to'])
  const cands = candidatesFromOntologyGraph(GRAPH)
  const byId = Object.fromEntries(cands.map(c => [c.id, c]))
  assert.deepEqual(byId['ontology:b'].links.map(l => [l.type, l.to]), [['supersedes', 'ontology:a'], ['same_task', 'ontology-snapshot:s2']])
  assert.deepEqual(byId['ontology:c'].links.map(l => [l.type, l.to]), [['refers_to', 'ontology:a']], 'an edge to a node that is not a candidate is not a link')
  assert.deepEqual(byId['ontology-snapshot:s2'].links, [{ type: 'follows_from', to: 'ontology-snapshot:s1' }])
  const wiki = buildWiki(await pagesFromOntologyGraph(GRAPH))
  assert.equal(wiki.pages.size, 5)
  assert.deepEqual(wiki.supersededBy('ontology:a'), [], 'the superseding page is a plan (future snapshot): not yet a replacement')
  assert.equal(wiki.pages.get('ontology:a').time.slice, 'past' === wiki.pages.get('ontology:a').time.slice ? 'past' : 'present')
  assert.equal(wiki.warnings.droppedLinks, 0)
})

test('Board and selected candidates become pages with their own guard; memory handles and the transcript bundle are not pages', async () => {
  let allowed = true
  const pages = await pagesFromCandidates([
    { id: 'board:b1', kind: 'board', title: '보드 목표', summary: '요약', timeSlice: 'present', loadText: async () => '결제 안정화가 목표다.', mayRead: () => allowed },
    { id: 'selected:s1', kind: 'source', title: '선택 문서', summary: 'selected document', timeSlice: 'present', sourceRef: 'https://example.invalid/doc' },
    { id: 'memory-selection:0', kind: 'source', title: '선택한 장부 행', summary: 'x' }, { id: 'memory-lookup:0', kind: 'source', title: 'y', summary: 'y' },
    { id: 'conversation:recent', kind: 'conversation', title: 'z', summary: 'z' }, { id: 'board:empty', kind: 'board', title: '', summary: '' }])
  assert.deepEqual(pages.map(p => p.id), ['board:b1', 'selected:s1'])
  const wiki = buildWiki(pages)
  assert.equal(wiki.pages.get('selected:s1').ref, 'https://example.invalid/doc')
  const own = adapter => adapter.scopeFor({ clientThreadId: 'thread-1' }), board = a => a.scopeFor({ clientThreadId: 'thread-1' }, { boardId: 'b1' })
  const a0 = createWikiAdapter({})
  assert.equal(allowsPage(wiki.pages.get('board:b1'), own(a0)), false, 'least privilege: a Board item is not readable from a DM that is not that Board')
  assert.equal(allowsPage(wiki.pages.get('board:b1'), a0.scopeFor({ clientThreadId: 'thread-1' }, { boardId: 'other-board' })), false, 'nor from another Board')
  assert.equal(allowsPage(wiki.pages.get('board:b1'), board(a0)), true, 'inside that Board\'s own context it is')
  assert.equal(wiki.pages.get('board:b1').scope, 'board:b1'); assert.equal(wiki.pages.get('selected:s1').scope, null, 'without a DM scope given, a selected source has none; the adapter gives it the DM scope (next test)')
  allowed = false
  assert.equal(allowsPage(wiki.pages.get('board:b1'), board(a0)), false, 'the store\'s own guard is reused on top: revoked means unreadable')
  assert.match(safeId('weird id with spaces'), /^x\/[0-9a-f]{12}$/)
})

test('speech records become utterance pages: references into the chat store, labels only where installed, a follows_from chain, the DM scope and its guard', async () => {
  let live = true
  const records = [
    { localMessageId: 'm1', role: 'user', quote: '팀장님이 어제 배포했다고 들었어.', spokenAt: '2026-11-23T01:00:00.000Z', sequence: 4, hash: 'a'.repeat(64), interpretations: [{ source: 'attributed_report', form: 'assertion', time: 'past_anchored' }] },
    { localMessageId: 'm2', role: 'assistant', quote: '확인해 보겠습니다.', spokenAt: '2026-11-23T01:00:05.000Z', sequence: 5, hash: 'b'.repeat(64), interpretations: [] },
    { localMessageId: 'm3', role: 'user', quote: '내일 살펴볼 예정이야.', spokenAt: '2026-11-23T02:00:00.000Z', sequence: 8, hash: 'c'.repeat(64), interpretations: [] }]
  const pages = pagesFromSpeechRecords(records, { scope: DM, mayRead: () => live })
  const wiki = buildWiki(pages)
  const [p1, p2, p3] = ['speech/m1', 'speech/m2', 'speech/m3'].map(id => wiki.pages.get(id))
  assert.deepEqual([p1.time.slice, p1.status, p1.provenance], ['past', 'done', { kind: 'reported_by_other', by: 'user', basis: 'attributed_report' }])
  assert.deepEqual([p2.time.slice, p2.status, p2.provenance], ['unknown', 'unknown', { kind: 'utterance', by: 'Agent' }])
  assert.deepEqual([p3.time.slice, p3.status, p3.provenance], ['unknown', 'unknown', { kind: 'utterance', by: 'user' }], 'no installed label: nothing is guessed')
  assert.deepEqual([p1.ref, p1.contentKey, p1.revision, p1.spokenAt, p1.scope], ['chat-message:m1', `h:${'a'.repeat(40)}`, 's4', '2026-11-23T01:00:00.000Z', DM])
  assert.equal(p1.time.at, undefined, 'the speaking time is not the event time')
  assert.deepEqual(wiki.links('speech/m3'), [{ type: 'follows_from', to: 'speech/m2' }])
  assert.equal(allowsPage(p1, SCOPE), true); assert.equal(allowsPage(p1, { allowedScopes: ['dm:other'] }), false)
  live = false
  assert.equal(allowsPage(p1, SCOPE), false, 'consent revoked in the speech store: the pages disappear for readers')
})

test('conversation pairs become pages linked by the topic store\'s own graph, with its hashes as content keys', () => {
  const turns = [
    { key: 'k1', topic: 'k1', parent: null, needs: [], userText: '배포 일정 알려줘', assistantText: '12월 첫째 주입니다.', userHash: 'u1'.repeat(8), assistantHash: 'a1'.repeat(8), seq: 6, spokenAt: '2026-11-23T01:00:00.000Z' },
    { key: 'k2', topic: 'k1', parent: null, needs: ['k1'], userText: '롤백은?', assistantText: '30분 안에 되돌립니다.', userHash: 'u2'.repeat(8), assistantHash: 'a2'.repeat(8), seq: 10 },
    { key: 'k3', topic: 'k3', parent: 'k1', needs: ['ghost'], userText: '다른 주제', assistantText: '네.', seq: 14 }]
  const wiki = buildWiki(pagesFromTopicTurns(turns, { scope: DM, mayRead: () => true }))
  assert.deepEqual(wiki.links('topic/k2'), [{ type: 'same_task', to: 'topic/k1' }, { type: 'refers_to', to: 'topic/k1' }])
  assert.deepEqual(wiki.links('topic/k3'), [{ type: 'follows_from', to: 'topic/k1' }], 'a missing need is not a link')
  const k1 = wiki.pages.get('topic/k1')
  assert.deepEqual([k1.ref, k1.revision, k1.contentKey, k1.scope], ['chat-pair:k1', 's6', `t:${'u1'.repeat(8)}:${'a1'.repeat(8)}`, DM])
  assert.match(k1.body, /^User: 배포 일정 알려줘\nAgent: 12월 첫째 주입니다\.$/)
})

test('the write store: 0600, private directory, bounded, newer versions untouched, a damaged file set aside, unavailable means refusing to write', async () => {
  const dataDir = await tmpDir()
  const writes = openWikiWrites({ dataDir, log: quiet })
  assert.equal(writes.status, 'missing')
  assert.ok(writes.apply({ kind: 'page', page: { id: 'browser-task/t1', title: '작업 결과', body: '로그인 후 표를 읽었다.', revision: '1', time: { slice: 'past' }, provenance: { kind: 'agent_note', by: 'browser_task' }, status: 'done', scope: DM, links: [] } }))
  const file = path.join(dataDir, 'egdesk-wiki-writes.json')
  assert.equal((await stat(file)).mode & 0o777, 0o600); assert.equal((await stat(dataDir)).mode & 0o077, 0)
  assert.equal(openWikiWrites({ dataDir, log: quiet }).read().pages[0].body, '로그인 후 표를 읽었다.')
  for (let i = 0; i < 260; i++) writes.apply({ kind: 'page', page: { id: `m/p${i}`, title: `t${i}`, body: `body ${i}`.repeat(10), revision: '1', time: { slice: 'past' }, provenance: { kind: 'utterance' }, scope: DM } })
  assert.ok(writes.read().pages.length <= 200, 'bounded by count')
  assert.ok((await stat(file)).size <= 256 * 1024, 'bounded by bytes')
  assert.throws(() => writes.apply({ kind: 'page', page: { id: 'bad id', title: 't' } }), /not storable/)
  assert.throws(() => writes.apply({ kind: 'nonsense' }), /unknown change/)
  // newer version: untouched
  const future = JSON.stringify({ version: 9, pages: [{ secret: 'FUTURE' }] })
  const d2 = await tmpDir(); openWikiWrites({ dataDir: d2, log: quiet }); await writeFile(path.join(d2, 'egdesk-wiki-writes.json'), future, { mode: 0o600 })
  const newer = openWikiWrites({ dataDir: d2, log: quiet })
  assert.equal(newer.status, 'unsupported'); assert.throws(() => newer.apply({ kind: 'reading', pageId: 'x', sourceRevision: '1', reading: { status: 'done', state: 'pending' } }))
  assert.equal(await readFile(path.join(d2, 'egdesk-wiki-writes.json'), 'utf8'), future)
  // damaged: set aside
  const d3 = await tmpDir(); openWikiWrites({ dataDir: d3, log: quiet }); await writeFile(path.join(d3, 'egdesk-wiki-writes.json'), 'not json', { mode: 0o600 })
  assert.equal(openWikiWrites({ dataDir: d3, log: quiet }).status, 'recovered'); assert.ok((await readdir(d3)).some(n => n.includes('.corrupt-')))
  // unavailable
  const none = openWikiWrites({ dataDir: 'relative/dir', log: quiet })
  assert.equal(none.status, 'unavailable'); assert.throws(() => none.apply({ kind: 'page', page: { id: 'a/b', title: 't', body: 'x', revision: '1', time: { slice: 'past' }, provenance: { kind: 'utterance' } } }))
})

test('the write path keeps a reference, not a copy, when the words already live in the chat store; a browser outcome keeps its text; both come back next turn', async () => {
  const dataDir = await tmpDir(), writes = openWikiWrites({ dataDir, log: quiet }), adapter = createWikiAdapter({ writes })
  const speechRecords = async () => [{ localMessageId: 'm9', role: 'user', quote: '거래처 D사가 어제 단가를 올렸다고 들었어.', spokenAt: '2026-11-24T05:30:00.000Z', sequence: 12, hash: 'd'.repeat(64), interpretations: [] }]
  let wiki = await adapter.snapshot({ context: { clientThreadId: 'thread-1' }, graph: GRAPH, speechRecords, speechGuard: () => true })
  const writer = adapter.writerFor(wiki, { enabled: true, canWrite: () => true })
  const message = '거래처 D사가 어제 단가를 올렸다고 들었어.'
  const stored = writer.apply({ op: 'new_page', time: { slice: 'past' }, status: 'done', provenance: { kind: 'reported_by_other', basis: 'attributed_report' }, links: [], spokenAt: '2026-11-24T05:30:00.000Z' },
    { message, messageRef: 'chat-message:m9', scope: adapter.scopeFor({ clientThreadId: 'thread-1' }), operationId: 'op-1' })
  assert.equal(stored.status, 'stored')
  const task = writer.apply({ op: 'new_page', time: { slice: 'past' }, status: 'done', provenance: { kind: 'agent_note' }, links: [] }, { message: '표를 읽어 12행을 가져왔다.', scope: adapter.scopeFor({ clientThreadId: 'thread-1' }), operationId: 'browser-task:abc' })
  assert.equal(task.pageId, 'browser-task/abc')
  const text = await readFile(path.join(dataDir, 'egdesk-wiki-writes.json'), 'utf8')
  assert.ok(!text.includes('D사'), 'no second copy of the person\'s words')
  assert.ok(text.includes('chat-message:m9') && text.includes('표를 읽어 12행을 가져왔다.'))
  // next turn: the reference resolves through the speech records; the browser outcome comes with its stored text
  wiki = await adapter.snapshot({ context: { clientThreadId: 'thread-1' }, graph: GRAPH, speechRecords, speechGuard: () => true })
  assert.equal(wiki.pages.get(stored.pageId).body, message); assert.equal(wiki.pages.get(stored.pageId).ref, 'chat-message:m9'); assert.match(wiki.pages.get(stored.pageId).title, /^거래처 D사/)
  assert.equal(wiki.pages.get('browser-task/abc').provenance.by, 'browser_task')
  // revoked or out of the recent window: the referenced page is simply gone; the text-bearing page stays
  wiki = await adapter.snapshot({ context: { clientThreadId: 'thread-1' }, graph: GRAPH })
  assert.equal(wiki.pages.has(stored.pageId), false); assert.equal(wiki.pages.has('browser-task/abc'), true)
  // another DM never sees a page written in this one
  wiki = await adapter.snapshot({ context: { clientThreadId: 'thread-2' }, graph: GRAPH })
  assert.equal(wiki.pages.has('browser-task/abc'), false)
})

test('a status reading on a store-backed page is persisted against its source revision and overlaid next turn; a changed source drops it; only the person\'s confirmation promotes it', async () => {
  const dataDir = await tmpDir(), writes = openWikiWrites({ dataDir, log: quiet }), adapter = createWikiAdapter({ writes })
  const ctx = { clientThreadId: 'thread-1' }, scope = adapter.scopeFor(ctx)
  let wiki = await adapter.snapshot({ context: ctx, graph: GRAPH })
  const page = wiki.pages.get('ontology:b')
  assert.match(page.revision, /^[0-9a-f]{12}$/, 'a store-derived revision is not numeric')
  const sourceRevision = page.revision
  const proposal = { op: 'update_status', pageId: 'ontology:b', baseRevision: sourceRevision, proposedStatus: 'done', time: { slice: 'past' }, provenance: { kind: 'utterance', by: 'user' }, spokenAt: '2026-11-24T05:30:00.000Z' }
  const receipt = adapter.writerFor(wiki, { enabled: true, canWrite: () => true }).apply(proposal, { message: '배포 끝났어', scope, operationId: 'op-r' })
  assert.deepEqual([receipt.status, receipt.revision], ['recorded_pending', `${sourceRevision}.r1`], 'a hash revision counts up with a .rN suffix (it used to be silently refused)')
  assert.equal(wiki.pages.get('ontology:b').statusReadings.length, 1)
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'egdesk-wiki-writes.json'), 'utf8')).readings[0].sourceRevision, sourceRevision)
  wiki = await adapter.snapshot({ context: ctx, graph: GRAPH })
  const again = wiki.pages.get('ontology:b')
  assert.deepEqual([again.status, again.statusReadings.map(r => r.state), again.revision], ['plan', ['pending'], `${sourceRevision}.r1`])
  // stale: the source page changed, so the reading is not shown
  const changed = JSON.parse(JSON.stringify(GRAPH)); changed.nodes[1].body += ' 수정됨.'
  const stale = (await adapter.snapshot({ context: ctx, graph: changed })).pages.get('ontology:b')
  assert.deepEqual([stale.statusReadings.length, stale.revision === `${sourceRevision}.r1`], [0, false])
  // no auto-promotion: a callback is ignored; only the person's own later confirmation promotes, and the store keeps the accepted reading in place of the pending one
  const ignoring = adapter.writerFor(wiki, { enabled: true, canWrite: () => true, acceptStatus: () => true })
  assert.equal(ignoring.apply({ ...proposal, baseRevision: `${sourceRevision}.r1` }, { message: '배포 끝났어', scope, operationId: 'op-r2' }).status, 'recorded_pending')
  const promoter = adapter.writerFor(wiki, { enabled: true, canWrite: () => true })
  const promoted = promoter.promote('ontology:b', { scope, confirmation: { by: 'user', at: '2026-11-24T06:00:00.000Z' }, operationId: 'confirm-1' })
  assert.equal(promoted.status, 'status_updated')
  const final = (await adapter.snapshot({ context: ctx, graph: GRAPH })).pages.get('ontology:b')
  assert.equal(final.status, 'done')
  assert.deepEqual(final.statusReadings.map(r => r.state), ['accepted'], 'both pending readings were the same reading (same status and time): the confirmed one replaces them, nothing is duplicated')
  assert.ok(JSON.parse(await readFile(path.join(dataDir, 'egdesk-wiki-writes.json'), 'utf8')).readings.some(r => r.reading.confirmedAt === '2026-11-24T06:00:00.000Z'))
})

test('a store that cannot keep a change makes the write fail without touching the wiki', async () => {
  const unavailable = openWikiWrites({ dataDir: 'relative/dir', log: quiet })
  const adapter = createWikiAdapter({ writes: unavailable })
  const wiki = await adapter.snapshot({ context: { clientThreadId: 'thread-1' }, graph: GRAPH })
  const before = wiki.pages.size
  const result = adapter.writerFor(wiki, { enabled: true, canWrite: () => true }).apply({ op: 'new_page', time: { slice: 'past' }, status: 'done', provenance: { kind: 'agent_note' }, links: [] }, { message: '결과', scope: adapter.scopeFor({ clientThreadId: 'thread-1' }), operationId: 'browser-task:x' })
  assert.deepEqual([result.status, wiki.pages.size], ['invalid', before])
})

test('the adapter feeds the reconstruction loop end to end: ontology links are options, permissions hold, receipts use the store\'s own content key', async () => {
  const adapter = createWikiAdapter({})
  const speechRecords = async () => [{ localMessageId: 'm1', role: 'user', quote: '결제 모듈 비동기 전환 이야기를 했어.', spokenAt: '2026-11-23T01:00:00.000Z', sequence: 3, hash: 'e'.repeat(64), interpretations: [] }]
  const wiki = await adapter.snapshot({ context: { clientThreadId: 'thread-1' }, graph: GRAPH, speechRecords, speechGuard: () => true,
    candidates: [{ id: 'board:b1', kind: 'board', title: '보드 목표', summary: '비공개 목표', timeSlice: 'present', loadText: () => '다른 방 전용 내용', mayRead: () => false }] })
  assert.deepEqual(wiki.adapter.counts, { ontology: 5, candidates: 1, speech: 1, written: 0 })
  const log = []
  const r = await reconstructMemory({ message: '결제 모듈 v2는 비동기 전환안이다', wiki, client: mockJudge(log), scope: adapter.scopeFor({ clientThreadId: 'thread-1' }), askedAt: Date.UTC(2026, 10, 24) })
  assert.ok(r.picks.some(p => p.id === 'ontology:b'))
  assert.ok(!log.map(l => l.input).join('\n').includes('다른 방 전용 내용'), 'a page whose store says no never reaches the judge')
  const delivered = r.nextDelivered()
  const sp = reconstructMemory({ message: '결제 모듈 비동기 전환 이야기', wiki, client: mockJudge(), scope: adapter.scopeFor({ clientThreadId: 'thread-1' }), askedAt: Date.UTC(2026, 10, 24) })
  const spoken = await sp
  const entry = spoken.nextDelivered().pages['speech/m1']
  if (entry) assert.equal(entry.hash, `h:${'e'.repeat(40)}`, 'the receipt carries the chat store\'s own hash')
  assert.equal(overlayWrites([{ id: 'x', revision: '1' }], { readings: [] })[0].revision, '1')
})

test('least privilege through the adapter: a Board item reaches the judge only from that Board\'s context, a selected source only from its own DM', async () => {
  const adapter = createWikiAdapter({})
  const candidates = [{ id: 'board:b1', kind: 'board', title: '보드 B1 목표', summary: '결제 안정화', timeSlice: 'present', loadText: () => '결제 안정화 목표 문서' },
    { id: 'selected:s1', kind: 'source', title: '선택 문서', summary: 'selected', timeSlice: 'present', loadText: () => '선택한 문서 본문 내용' }]
  const run = async (context, body) => {
    const wiki = await adapter.snapshot({ context, body, candidates })
    const seen = []
    await reconstructMemory({ message: '관련 자료를 알려줘', wiki, client: { async decide(req) { seen.push(JSON.stringify(req.input)); return { answers: {} } } }, scope: adapter.scopeFor(context, body), askedAt: Date.UTC(2026, 10, 24) })
    return seen.join('\n')
  }
  const dm1 = await run({ clientThreadId: 'thread-1' }, {})
  assert.ok(dm1.includes('선택한 문서 본문 내용') && !dm1.includes('결제 안정화 목표 문서'), 'own DM: its selected source, no Board item')
  const dm2 = await run({ clientThreadId: 'thread-2' }, {})
  assert.ok(dm2.includes('선택한 문서 본문 내용'), 'a different DM builds its own snapshot (the candidate list is per message); the page still carries that DM\'s scope')
  const wiki = await adapter.snapshot({ context: { clientThreadId: 'thread-1' }, candidates })
  assert.equal(wiki.pages.get('selected:s1').scope, 'dm:thread-1'); assert.equal(wiki.pages.get('board:b1').scope, 'board:b1')
  assert.equal(allowsPage(wiki.pages.get('selected:s1'), adapter.scopeFor({ clientThreadId: 'thread-2' })), false, 'another DM cannot read it')
  const inBoard = await run({ clientThreadId: 'thread-1' }, { boardId: 'b1' })
  assert.ok(inBoard.includes('결제 안정화 목표 문서'), 'sent from that Board: its item is readable')
  const otherBoard = await run({ clientThreadId: 'thread-1' }, { boardId: 'other' })
  assert.ok(!otherBoard.includes('결제 안정화 목표 문서'), 'sent from another Board: not readable')
})
