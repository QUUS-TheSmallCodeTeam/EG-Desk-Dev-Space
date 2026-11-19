import test from 'node:test'
import assert from 'node:assert/strict'
import { collectDecisionCandidates } from './egdesk-decision-candidates.mjs'
import { DECISION_CONTEXT_KEY, evidenceForSpeaker, prepareTurnContext } from './egdesk-context-setup.mjs'

const handle = 'memrow:2d817f04-fb38-4dbc-8409-cf9f9ff69f22'
const item = { id: handle, kind: 'memory-evidence', label: 'CLIENT_LABEL', url: 'https://example.invalid/CLIENT_URL' }
const client = { decide: async ({ questions }) => ({ model: 'synthetic', latencyMs: 1, usage: {}, answers: Object.fromEntries(questions.map(q => {
  const value = q.name === 'time_intent' ? 'present' : 'answer'
  return [q.name, q.type === 'choice' ? { type: 'choice', choice: value, confidence: 1, probabilities: [{ value, probability: 1 }] } : { type: 'predicate', probability: 0.02 }]
})) }) }
const assemble = (candidates, options) => prepareTurnContext({ message: '지금 몇 개야?', candidates, client, ...options })
const collect = async (body, memoryEvidenceFor) => (await collectDecisionCandidates({ body, memoryEvidenceFor })).candidates
const entry = access => collect({ selectedSources: [item] }, () => access)
const publicPart = r => JSON.stringify([r.receipt, r.selected, r.extraContext])

test('reserved selections never become ordinary attachments or expose a supplied caption or URL', async () => {
  assert.deepEqual(await collect({ selectedSources: [item, { ...item, id: 'memrow:bad' }, { ...item, id: 'ordinary' }], attachments: [item] }), [])
  const seen = []; const ok = { mayRead: () => true, loadText: () => '{"v":1}' }
  const cs = await collect({ selectedSources: [item, item], attachments: [item] }, ref => { seen.push(ref); return ok })
  assert.deepEqual(seen, [handle]); assert.equal(cs.length, 1)
  assert.doesNotMatch(publicPart(await assemble(cs)), /memrow:|CLIENT_LABEL|CLIENT_URL/)
})

test('a guarded read that fails, is withdrawn mid-load or cannot fit is omitted whole, not replaced with a misleading summary', async () => {
  for (const read of [async () => null, async () => { throw Error('private failure detail') }, async () => '   ']) {
    const r = await assemble(await entry({ mayRead: () => true, loadText: read }))
    assert.equal(r.status, 'empty'); assert.doesNotMatch(publicPart(r), /private failure|연결한 원본 기록/)
  }
  let active = true
  const late = await assemble(await entry({ mayRead: () => active, loadText: () => { active = false; return 'WITHDRAWN' } }))
  assert.equal(late.status, 'empty')
  for (const budget of [{ itemChars: 10 }, { maxChars: 30 }]) {
    const r = await assemble(await entry({ mayRead: () => true, loadText: () => '{"full":"PRIVATE_DETAIL"}' }), budget)
    assert.equal(r.status, 'empty'); assert.doesNotMatch(publicPart(r), /PRIVATE_DETAIL|truncated|연결한 원본/)
  }
})

test('final check covers every guarded attachment, even a grant that disappears during a later async read', async () => {
  let first = true, second = true
  const a = (await entry({ mayRead: () => first, loadText: () => '{"v":"A"}' }))[0]
  const b = { ...a, id: 'memory-selection:1', mayRead: () => second, loadText: () => { first = false; return '{"v":"B"}' } }
  const r = await assemble([a, b]); assert.equal(r.status, 'ready'); assert.match(r.extraContext[DECISION_CONTEXT_KEY], /"v":"B"/)
  assert.equal(r.mayDispatch(), false); assert.doesNotMatch(JSON.stringify(r.receipt), /mayDispatch|memrow:|"v"/)
})

test('the reference clock belongs to the question, not the source or the ranking model', async () => {
  const c = await entry({ mayRead: () => true, loadText: () => '{"record":"unchanged source"}' })
  const old = await assemble(c, { askedAt: Date.UTC(2026,10,19,1) }), later = await assemble(c, { askedAt: Date.UTC(2026,10,20,1) })
  assert.match(old.extraContext[DECISION_CONTEXT_KEY], /Question asked at 2026-11-19T01:00:00.000Z/)
  assert.match(later.extraContext[DECISION_CONTEXT_KEY], /Question asked at 2026-11-20T01:00:00.000Z/)
  assert.equal(old.receipt.catalogHash, later.receipt.catalogHash); assert.deepEqual(old.selected,later.selected)
  assert.match(old.extraContext[DECISION_CONTEXT_KEY], /no date.*unknown even as to/)
  const ordinary = await assemble([{ id: 'plain', title: 'plain', summary: 'ok', mandatory: true }], { askedAt: Date.UTC(2026,10,19,1) })
  assert.doesNotMatch(ordinary.extraContext[DECISION_CONTEXT_KEY], /Question asked at/)
})

test('identical quantity and time do not erase what is measured, copied, planned or inferred; a hash is proof of text, not the physical world', () => {
  const make = relation => evidenceForSpeaker({version:1,ledger:{text:'장부 재고 30개'},sources:[{text:'재고 30개',relation}]})
  const traces = ['counted','recorded','derived','copied','scheduled'].map(make)
  assert.deepEqual(traces.map(t => t.sources[0].knowledgeKind), ['reported-observation','record-assertion','calculation-or-inference','same-origin-copy','plan-not-completion'])
  for (const t of traces) assert.deepEqual(t.verification, { confirmed:'source-revision-and-lines', independentlyObservedPhysicalState:false })
  assert.equal(make('unknown'), null)
})

test('speech store: private consent generation, bounded exact references, CAS, tamper rejection and migration', async t => {
  const { createHash, randomUUID } = await import('node:crypto'), { DatabaseSync } = await import('node:sqlite')
  const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path'), { tmpdir } = await import('node:os')
  const { MemoryEvidenceStore } = await import('./egdesk-memory-evidence.mjs')
  const root = mkdtempSync(join(tmpdir(), 'speech-store-')), handles = []
  t.after(() => { for (const h of handles) h.close(); rmSync(root, { recursive: true, force: true }) })
  const captures = { getCapture: assert.fail, readProjection: assert.fail }
  const make = dataDir => { const s = new MemoryEvidenceStore({ dataDir, captures }); handles.push(s); return s }
  const scope = { ownerKey: 'PRIVATE_SCOPE_OWNER', agentId: 'PRIVATE_SCOPE_AGENT', clientThreadId: 'PRIVATE_SCOPE_DM' }
  const hash = x => createHash('sha256').update(x).digest('hex'), file = dir => join(dir, 'memory-evidence', 'grants.sqlite')
  const dir = join(root, 'fresh'), a = make(dir), b = make(dir), other = randomUUID()
  const span = { start: 0, end: 3, source: 'attributed_report', form: 'conditional', time: 'past_unspecified' }
  const ref = seq => ({ localMessageId: `msg-${hash(`synthetic-id:${seq}`).slice(0, 32)}`, role: seq % 2 ? 'user' : 'assistant', seq,
    spokenAt: Date.UTC(2026, 10, 19) - seq, offsetMinutes: seq % 2 ? -840 : 840, hash: hash(`SYNTHETIC_UNSAVED_QUOTE ${seq}`), interpretations: seq % 2 ? [] : [span] })
  assert.equal(a.speechGrant(scope), null); assert.deepEqual(a.recentSpeech(scope, other), [])
  assert.equal(a.rememberSpeech(scope, other, ref(1)), false); assert.equal(a.disableSpeech(scope, other), false)
  assert.equal(a.enableSpeech({ ...scope, agentId: '' }), null); assert.equal(a.enableSpeech({ ...scope, extra: true }), null)
  assert.equal(existsSync(dir), false)
  const gen = a.enableSpeech(scope); assert.match(gen, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(b.speechGrant(scope), gen); assert.equal(b.enableSpeech(scope), gen)
  for (const key of Object.keys(scope)) {
    const away = { ...scope, [key]: 'another' }, g2 = b.enableSpeech(away)
    assert.ok(g2 && g2 !== gen); assert.equal(b.rememberSpeech(away, gen, ref(1)), false)
    assert.deepEqual(b.recentSpeech(away, gen), []); assert.equal(b.disableSpeech(away, gen), false)
    assert.equal(b.disableSpeech(away, g2), true)
  }
  const d = ref(31), hole = Array(1), extra = Object.assign([], { quote: 'raw text' })
  for (const invalid of [null, { ...d, text: 'raw' }, { ...d, localMessageId: 'native-or-raw-text' }, { ...d, role: 'agent' },
    { ...d, seq: 0 }, { ...d, seq: 1.2 }, { ...d, spokenAt: -1 }, { ...d, spokenAt: 8640000000000001 }, { ...d, hash: 'A'.repeat(64) },
    { ...d, offsetMinutes: 841 }, { ...d, offsetMinutes: -841 }, { ...d, offsetMinutes: 0.5 },
    ...[null, hole, extra, Array(7).fill(span), [{ ...span, quote: 'raw' }], [{ ...span, start: -1 }], [{ ...span, start: 3 }], [{ ...span, end: 20001 }],
      [{ ...span, source: 'heard' }], [{ ...span, form: 'fact' }], [{ ...span, time: 'yesterday' }], [span, span]].map(interpretations => ({ ...d, interpretations }))]) {
    assert.equal(a.rememberSpeech(scope, gen, invalid), false)
  }
  assert.deepEqual(a.recentSpeech(scope, gen), [])
  for (const seq of [2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13]) assert.equal(a.rememberSpeech(scope, gen, ref(seq)), true)
  const expected = Array.from({ length: 12 }, (_, n) => ref(n + 3))
  assert.deepEqual(b.recentSpeech(scope, gen), expected); assert.equal(b.rememberSpeech(scope, gen, ref(14)), true)
  for (const changed of [{ ...ref(14), hash: d.hash }, { ...ref(14), seq: 19 }, { ...ref(14), localMessageId: d.localMessageId }]) assert.equal(b.rememberSpeech(scope, gen, changed), false)
  assert.deepEqual(make(dir).recentSpeech(scope, gen), expected); assert.deepEqual(a.list(scope), [])
  for (const value of [...Object.values(scope), 'SYNTHETIC_UNSAVED_QUOTE']) assert.equal(readFileSync(file(dir)).includes(value), false)
  assert.equal(b.disableSpeech(scope, other), false); assert.equal(b.disableSpeech(scope, gen), true); assert.equal(a.disableSpeech(scope, gen), false)
  const next = a.enableSpeech(scope); assert.ok(next && next !== gen); assert.equal(b.disableSpeech(scope, gen), false)
  assert.equal(b.rememberSpeech(scope, gen, d), false); assert.deepEqual(b.recentSpeech(scope, gen), []); assert.deepEqual(b.recentSpeech(scope, next), [])
  assert.equal(a.rememberSpeech(scope, next, d), true)
  const edit = new DatabaseSync(file(dir)); try { edit.prepare('UPDATE speech_grants SET refs=replace(refs,?,?) WHERE generation=?').run(d.hash, ref(15).hash, next) } finally { edit.close() }
  assert.equal(a.speechGrant(scope), null); assert.equal(a.enableSpeech(scope), null); assert.deepEqual(a.recentSpeech(scope, next), [])
  assert.equal(a.rememberSpeech(scope, next, ref(15)), false); assert.equal(a.disableSpeech(scope, next), true)
  const clean = new DatabaseSync(file(dir), { readOnly: true }); try { assert.equal(clean.prepare('SELECT count(*) AS n FROM speech_grants').get().n, 0) } finally { clean.close() }
  // Seed v1/v2 independently. Existing grants (and a v2 turn link) never become speech consent; a collision cannot partially upgrade v1.
  for (const [version, conflict] of [[1, false], [2, false], [1, true]]) {
    const base = join(root, `${version}-${conflict}`), dest = file(base), legacyId = `memrow:${randomUUID()}`
    const key = hash(JSON.stringify([scope.ownerKey, scope.agentId, scope.clientThreadId]))
    mkdirSync(join(base, 'memory-evidence'), { recursive: true, mode: 0o700 }); writeFileSync(dest, '', { mode: 0o600 })
    const db = new DatabaseSync(dest)
    try {
      db.exec(`CREATE TABLE grants(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,expires_at INTEGER,pins TEXT NOT NULL) STRICT;
        CREATE TABLE revoked(id TEXT PRIMARY KEY REFERENCES grants(id)) STRICT; PRAGMA application_id=0x4d455647; PRAGMA user_version=${version};`)
      db.prepare('INSERT INTO grants VALUES(?,?,NULL,?)').run(legacyId, key, '{}')
      if (version === 2) {
        db.exec(`ALTER TABLE grants ADD COLUMN discovery_label TEXT; ALTER TABLE grants ADD COLUMN discovery_terms TEXT;
          CREATE INDEX grants_by_scope ON grants(scope_key); CREATE INDEX discoverable_by_scope ON grants(scope_key) WHERE discovery_terms IS NOT NULL;
          CREATE TABLE turn_inputs(scope_key TEXT NOT NULL,run_key TEXT NOT NULL,id TEXT NOT NULL REFERENCES grants(id),PRIMARY KEY(scope_key,run_key,id)) WITHOUT ROWID, STRICT;`)
        db.prepare('INSERT INTO turn_inputs VALUES(?,?,?)').run(key, hash('old-run'), legacyId)
      }
      if (conflict) db.exec('CREATE TABLE speech_grants(unexpected TEXT) STRICT')
    } finally { db.close() }
    const s = make(base); assert.equal(s.speechGrant(scope), null); assert.deepEqual(s.recentSpeech(scope, other), [])
    assert.equal(s.isActive(scope, legacyId), !conflict)
    if (version === 2) assert.equal(s.forTurn(scope, 'old-run').id, legacyId)
    if (conflict) assert.equal(s.enableSpeech(scope), null)
    const raw = new DatabaseSync(dest, { readOnly: true }); try {
      assert.equal(raw.prepare('PRAGMA user_version').get().user_version, conflict ? 1 : 3)
      assert.equal(raw.prepare('SELECT id FROM grants').get().id, legacyId)
      if (conflict) assert.equal(raw.prepare('PRAGMA table_info(grants)').all().length, 4)
      else assert.equal(raw.prepare('SELECT count(*) AS n FROM speech_grants').get().n, 0)
    } finally { raw.close() }
  }
})
