import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { ImmutableContextStore } from './egdesk-context-store.mjs'
import { MemoryEvidenceStore } from './egdesk-memory-evidence.mjs'
import { createMemoryEvidenceHttpHandler } from './egdesk-memory-http.mjs'

// No TCP socket, accounts, engine or server import. The two stores use only a fresh temp directory.
const PORT = 41917, ROUTE = { clientThreadId: 'dm-fx', conversationId: 'conv-fx', expectedProfileId: 'agent-fx' }
const SCOPE = { ownerKey: 'fixture-original-owner', clientThreadId: ROUTE.clientThreadId, agentId: ROUTE.expectedProfileId }
const P = (m, a = 2, b = a) => ({ sourceId: m.sourceId, revision: m.revision, startLine: a, endLine: b })
const ID = () => `memrow:${randomUUID()}`, GENERIC = { code: 'MEMORY_EVIDENCE_UNAVAILABLE', error: 'Memory evidence unavailable' }
function denied(r, status) { assert.equal(r.owned, true); assert.equal(r.status, status); assert.deepEqual(r.body, GENERIC); assert.equal(r.headers['Cache-Control'], 'no-store') }
async function request(handler, action, body, options = {}) {
  const raw = options.raw ?? JSON.stringify(body), req = Readable.from([Buffer.from(raw)])
  req.method = options.method ?? 'POST'; req.url = options.path ?? `/memory-evidence/${action}`
  req.socket = { remoteAddress: options.remote ?? '127.0.0.1' }
  req.headers = { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json; charset=utf-8', ...options.headers }
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = JSON.parse(body) } }
  res.owned = await handler(req, res, new URL(req.url, `http://localhost:${PORT}`)); return res
}
async function world(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'memory-http-fx-')), captures = new ImmutableContextStore({ dataDir: dir, allowedRoots: [dir] })
  const store = new MemoryEvidenceStore({ dataDir: dir, captures }); t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })
  const w = { scope: { ...SCOPE }, current: true, auth: true, authCalls: [], resolved: [], seen: [], list: [], captures, store, dir, mode: 'advisory' }
  w.evidence = { list: s => { assert.deepEqual(s, w.scope); return w.list }, bind: (s, b) => store.bind(s, b), read: (s, id) => store.read(s, id), isActive: (s, id) => store.isActive(s, id), revoke: (s, id) => store.revoke(s, id) }
  w.handler = createMemoryEvidenceHttpHandler({ port: PORT, captures, getEvidence: () => w.evidence, getMode: () => w.mode,
    ensureAuth: async (...args) => { w.authCalls.push(args); if (!w.auth) throw new Error('/private/fixture-auth') },
    resolveDm: async r => { w.resolved.push(r); return { scope: w.scope, assertCurrent() { if (!w.current) throw Error('fixture owner changed') },
      validateCapture: async m => { w.seen.push(m.sourceId); if (m.engine?.engineId === 'denied') throw Error('private attachment'); await w.validate?.(m) } } },
  })
  w.req = (a, fields = {}, options) => request(w.handler, a, { ...ROUTE, ...fields }, options)
  w.cap = (text, name = '매출 장부', { owner = SCOPE.ownerKey, dm = SCOPE.clientThreadId, clipped = false, engine } = {}) => captures.capture(owner, dm, { id: 'ui-fx', label: name, kind: 'browser', sourceRef: { url: 'https://fixture.invalid/private', viewId: 'private-view' }, content: { text, truncated: clipped } }, { engine })
  w.spec = async () => {
    const ledger = P(await w.cap('row-neighbor\r\nledger 7\r\nnext-neighbor')), source = P(await w.cap('source-neighbor\nposted 7\npassword=fixture-secret\nend-neighbor', '원본'), 2, 3)
    return { ledger, sources: [{ relation: 'posted', ...source }], consent: true, label: '등록한 근거', terms: [] }
  }
  return w
}

test('guard every owned path including unknown; only canonical POST, JSON, bounded and strictly shaped input before auth', async t => {
  const w = await world(t), sid = { sourceId: randomUUID(), revision: 'a'.repeat(64), startLine: 1, endLine: 1 }
  for (const a of ['state', 'preview', 'bind', 'read', 'revoke', 'unknown']) {
    for (const opts of [{ headers: { host: 'other.test:41917' } }, { headers: { origin: 'https://other.test' } }, { headers: { 'sec-fetch-site': 'same-site' } }, { remote: '192.0.2.1' }]) denied(await w.req(a, {}, opts), 403)
  }
  for (const [status, a, fields, opt] of [
    [404, 'unknown'], [405, 'state', {}, { method: 'GET' }], [405, 'bind', {}, { method: 'OPTIONS' }],
    [400, 'state', {}, { path: '/memory-evidence/state?ownerKey=FIXTURE' }], [400, 'state', {}, { path: '/memory-evidence/state?' }],
    [400, 'state', {}, { path: '/memory-evidence/../memory-evidence/state' }], [415, 'state', {}, { headers: { 'content-type': 'text/plain' } }],
    [415, 'state', {}, { headers: { 'content-encoding': 'gzip' } }], [413, 'bind', {}, { raw: 'x'.repeat(8193) }], [413, 'state', {}, { headers: { 'content-length': '999999' } }],
    [400, 'state', {}, { raw: JSON.stringify(ROUTE).replace('{', '{"expectedProfile\\u0049d":"earlier-profile",') }],
    [400, 'state', {}, { raw: Buffer.concat([Buffer.from('{"clientThreadId":"dm'), Buffer.from([255]), Buffer.from('","conversationId":"x","expectedProfileId":"a"}')]) }],
    [400, 'state', {}, { raw: '{' }], [400, 'state', {}, { raw: '[]' }], [400, 'state', { authority: { ownerKey: 'x' } }],
    [400, 'state', { engineId: 'codex' }], [400, 'state', { expectedProfileId: undefined }], [400, 'state', { conversationId: '\u202eabc' }],
    [400, 'preview', { pin: { ...sid, path: '/private/file' } }], [400, 'preview', { pin: { ...sid, endLine: 33 } }], [400, 'read', { id: 'BAD' }],
    [400, 'revoke', { id: ID(), ownerKey: 'x' }], [400, 'bind', { ledger: sid, sources: [{ ...sid, relation: 'posted', label: 'authority' }], label: 'Manual', terms: [], consent: true }],
  ]) denied(await w.req(a, fields, opt), status)
  assert.deepEqual(w.authCalls, []); assert.deepEqual(w.resolved, [])
  assert.equal((await w.req('', {}, { path: '/context/captures' })).owned, false)
})

test('state lists verified current DM manifests only; complete, verified blobs, no paths/text, no authority; metadata bounded', async t => {
  const w = await world(t), ok = await w.cap('sentinel-neighbor\nx'), hiddenTitle = await w.cap('text', '/absolute/private/fx')
  await w.cap('foreign-owner-text', 'otherowner', { owner: 'other-owner' }); await w.cap('foreign thread', 'foreign', { dm: 'other-dm' })
  await w.cap('clipped', 'Clipped', { clipped: true }); await w.cap('disallowed', 'rejected', { engine: { engineId: 'denied' } })
  const broken = await w.cap('broken blob'); await rm(path.join(await w.captures.directory(SCOPE.ownerKey, 'blobs'), broken.hash))
  const binary = path.join(w.dir, 'fixture.bin'); await writeFile(binary, Buffer.from([255, 0])); await w.captures.capture(SCOPE.ownerKey, SCOPE.clientThreadId, { kind: 'file', label: 'binary', sourceRef: { path: binary } })
  w.list = Array.from({ length: 35 }, (_, n) => ({ id: ID(), label: `근거 ${n}`, automatic: true, terms: ['private-term'] }))
  const r = await w.req('state'); assert.equal(r.status, 200); assert.equal(r.headers['Cache-Control'], 'no-store'); assert.equal(r.body.decisionMode, 'advisory'); assert.equal(r.body.rows.length, 32)
  assert.deepEqual(r.body.captures.map(x => x.sourceId).sort(), [ok.sourceId, hiddenTitle.sourceId].sort())
  assert.deepEqual(r.body.captures.find(x => x.sourceId === ok.sourceId), { sourceId: ok.sourceId, revision: ok.revision, label: '매출 장부', lineCount: 2 })
  assert.deepEqual(Object.keys(r.body.rows[0]).sort(), ['automatic', 'id', 'label']); assert.doesNotMatch(JSON.stringify(r.body), /private|absolute|sentinel|broken blob|clipped|foreign/i)
  assert.deepEqual(w.authCalls, [[{ clientThreadId: ROUTE.clientThreadId, conversationId: ROUTE.conversationId }]]); assert.deepEqual(w.resolved, [ROUTE])
  w.mode = { private: true }; assert.equal((await w.req('state')).body.decisionMode, 'off')
})

test('preview only delivers selected sanitized projected lines, denies substitutes, foreign scopes and unavailable or invalid lines', async t => {
  const w = await world(t), m = await w.cap('neighbor BEFORE\r\nposted 7\r\npassword=fx-private\r\nneighbor AFTER'), p = P(m, 2, 3)
  const x = await w.req('preview', { pin: p }); assert.equal(x.status, 200); assert.deepEqual(x.body, { text: 'posted 7\npassword=[REDACTED]' })
  const peers = await Promise.all([w.cap('different\ntext', 'same-label', { owner: 'other' }), w.cap('different\ntext', 'same-label', { dm: 'other' }), w.cap('clipped\ntext', 'clipped', { clipped: true }), w.cap('denied\ntext', 'denied', { engine: { engineId: 'denied' } })])
  for (const bad of [...peers.map(m => P(m)), { ...p, revision: 'f'.repeat(64) }, { ...p, sourceId: randomUUID() }, P(m, 6), P(await w.cap('x\n' + 'a'.repeat(4001))), P(await w.cap('x\ny\u0000z')), P(await w.cap('x\n   '))]) denied(await w.req('preview', { pin: bad }), 404)
  w.scope.agentId = 'wrong-agent'; denied(await w.req('preview', { pin: p }), 404)
})

test('manual HTTP bind/read/revoke uses real immutable captures and real scoped grant store without engine/account/native access', async t => {
  const w = await world(t), spec = await w.spec(), r = await w.req('bind', spec); assert.equal(r.status, 200); const { id } = r.body
  assert.match(id, /^memrow:/); const expected = { trace: { version: 1, ledger: { ...spec.ledger, text: 'ledger 7' }, sources: [{ ...spec.sources[0], text: 'posted 7\npassword=[REDACTED]' }] } }
  assert.deepEqual((await w.req('read', { id })).body, expected)
  w.scope.ownerKey = 'wrong-owner'; denied(await w.req('read', { id }), 404); denied(await w.req('revoke', { id }), 404)
  w.scope.ownerKey = SCOPE.ownerKey; assert.deepEqual((await w.req('revoke', { id })).body, { revoked: true }); denied(await w.req('read', { id }), 404); denied(await w.req('revoke', { id }), 404)
})

test('bind requires consent and bounded typed selections; sends exact auto discovery and never retries rejection as a manual grant', async t => {
  const w = await world(t), spec = await w.spec(), id = ID(), calls = [], grant = { ...spec, terms: ['재고', 'ledger'], expiresAt: Date.now() + 10000 }
  w.evidence.bind = async (scope, b) => { calls.push(b); assert.deepEqual(scope, SCOPE); return id }
  for (const patch of [{ consent: false }, { consent: undefined }, { terms: ['same', 'SAME'] }, { terms: Array(9).fill('key') }, { label: '/private/path' }, { sources: [{ ...spec.sources[0], relation: 'verified' }] }, { ledger: { ...spec.ledger, ownerKey: 'other' } }, { expiresAt: '1' }, { automatic: true }]) denied(await w.req('bind', { ...grant, ...patch }), 400)
  for (const patch of [{ ledger: { ...spec.ledger, revision: 'a'.repeat(64) } }, { sources: [{ ...spec.sources[0], sourceId: randomUUID() }] }]) denied(await w.req('bind', { ...grant, ...patch }), 404)
  assert.deepEqual(calls, []); assert.deepEqual((await w.req('bind', grant)).body, { id })
  assert.deepEqual(calls, [{ ledger: spec.ledger, sources: spec.sources, discovery: { label: grant.label, terms: grant.terms }, expiresAt: grant.expiresAt }]); assert.ok(w.seen.includes(spec.sources[0].sourceId))
  w.evidence.bind = async (_, b) => { calls.push(b); throw Error('tie-private-hint') }; denied(await w.req('bind', grant), 404); assert.equal(calls.length, 2)
})

test('stale scope at async capture/list/read validation never releases data or proceeds to bind; concurrent revocation after trace read is honored', async t => {
  const w = await world(t), spec = await w.spec(), { id } = (await w.req('bind', spec)).body
  for (const action of ['preview', 'state', 'bind', 'read']) {
    w.current = true; w.validate = async () => { await Promise.resolve(); w.current = false }
    denied(await w.req(action, action === 'preview' ? { pin: spec.ledger } : action === 'read' ? { id } : action === 'bind' ? spec : {}), 404)
  }
  w.current = true; w.validate = async () => { w.store.revoke(SCOPE, id) }; denied(await w.req('read', { id }), 404)
  w.validate = null; w.evidence.list = async () => { w.current = false; return [] }; denied(await w.req('state'), 404)
})

for (const change of ['scope', 'auth']) test(`compensating revoke uses *original* scope after ${change} loss immediately following actual durable bind`, async t => {
  const w = await world(t), spec = await w.spec(); let fresh, rolledBack
  w.evidence.bind = async (s, b) => { fresh = await w.store.bind(s, b); if (change === 'scope') { w.scope.ownerKey = 'wrong-new-owner'; w.current = false } else w.auth = false; return fresh }
  w.evidence.revoke = (s, id) => { rolledBack = { s, id }; return w.store.revoke(s, id) }
  denied(await w.req('bind', spec), 404); assert.deepEqual(rolledBack, { s: SCOPE, id: fresh }); assert.equal(w.store.isActive(SCOPE, fresh), false)
})

test('speech consent is separate, authenticated, prospective and never returns the generation or changes global decision mode', async t => {
  const w=await world(t); for (const k of ['speechGrant','speechConsentState','clearSpeech','enableSpeech','disableSpeech']) w.evidence[k]=w.store[k].bind(w.store)
  assert.equal((await w.req('state')).body.speechAllowed,false)
  denied(await w.req('speech-enable',{consent:true}),409); w.mode='on'
  for (const b of [{},{consent:false},{consent:1},{consent:true,ownerKey:'another-owner'},{consent:true,includeHistory:true}]) denied(await w.req('speech-enable',b),400)
  w.auth=false; denied(await w.req('speech-enable',{consent:true}),404); w.auth=true
  const on=await w.req('speech-enable',{consent:true}); assert.equal(on.status,200); assert.deepEqual(on.body,{speechAllowed:true}); assert.equal((await w.req('state')).body.speechAllowed,true)
  const gen=w.store.speechGrant(w.scope);assert.ok(gen);assert.doesNotMatch(JSON.stringify((await w.req('state')).body),new RegExp(gen));
  w.mode='off'; const off=await w.req('speech-disable');assert.equal(off.status,200);assert.deepEqual(off.body,{speechAllowed:false});assert.equal(w.store.speechGrant(w.scope),null);assert.equal(w.mode,'off');
  w.evidence.speechConsentState=()=>null; w.evidence.clearSpeech=()=>false; assert.equal((await w.req('state')).body.speechAllowed,null); denied(await w.req('speech-disable'),404);
})
