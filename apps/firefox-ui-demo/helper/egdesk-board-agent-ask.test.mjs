import assert from 'node:assert/strict'
import { once } from 'node:events'
import { rmSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { createBoardAgentAskService } from './egdesk-board-agent-ask.mjs'
import { createBoardAgentAskHttpHandler } from './egdesk-board-agent-ask-http.mjs'
import { openDeskStore } from './egdesk-desk-store.mjs'

const BOARD = 'agenda-a', OTHER = 'agenda-b'
const question = 'What did the Board decide about delivery?'
const approved = ['The Board decided delivery will be Friday.', 'The other office is closed.']
const PROFILE = 'profile-a'
const BOARD_BODY = { version: 1, agenda: { id: BOARD, title: 'Board' }, cards: [], shapes: [], marker: 'private Board text' }
const request = askCode => ({ kind: 'request', requestId: '8878a7f3-df6b-4383-af12-6ae38ad4fe2e', requestDigest: 'f'.repeat(64),
  question, recipient: 'request recipient', excerpt: 'requester attachment', expectedReply: 'private requester guidance', ...(askCode ? { askCode } : {}) })
const hasCode = code => error => error.code === `BOARD_AGENT_ASK_${code}`
function fixture(t, { selectContext, transport, decisionStatus, excerpts = approved } = {}) {
  const dir = createPrivateQaTempDirectory('egdesk-board-ask-')
  const stores = []
  const open = () => { const desk = openDeskStore({ dataDir: dir, ownerScope: 'test' }); stores.push(desk); return desk }
  const desk = open(), clock = { now: Date.UTC(2026, 10, 15) }, calls = []
  const profile = { lifecycle: 'active', activeRevision: 1, active: { revision: 1, hash: 'a'.repeat(64),
    body: { name: 'private profile name', personality: { tone: 'warm', speechNotes: 'private instructions' } } } }
  desk.saveBoard(BOARD, { body: BOARD_BODY, expectedRevision: null })
  desk.saveBoard(OTHER, { body: { ...BOARD_BODY, agenda: { id: OTHER, title: 'Other' } }, expectedRevision: null })
  const deps = { desk, profiles: { get: id => id === PROFILE ? profile : null }, decisionStatus,
    draft: transport, draftPreview: () => 'fixed instructions', now: () => clock.now,
    selectContext: selectContext ?? (async (input, opts) => { calls.push({ input, opts }); assert.equal(opts.isCurrent(input.scope), true); return { selectedIds: ['x1', 'forged'], outcome: 'local' } }) }
  const service = createBoardAgentAskService(deps)
  t.after(() => { service.close(); for (const db of stores) db.close(); rmSync(dir, { recursive: true, force: true }) })
  const save = (fields = {}) => service.policy({ boardId: BOARD, action: 'save', expectedVersion: null, profileId: PROFILE, excerpts, publicInstructions: 'Only answer briefly.', ...fields })
  const issue = expectedVersion => service.policy({ boardId: BOARD, action: 'issue', expectedVersion })
  const prepare = (code, fields = {}) => service.prepare({ boardId: BOARD, request: request(code), mode: 'extract', decisionEgress: false, ...fields })
  const run = (preview, options) => service.run({ ticket: preview.ticket, confirm: true }, options)
  return { desk, file: path.join(dir, `desk-${desk.ownerScopeHash}.sqlite`), deps, open, clock, calls, profile, service, save, issue, prepare, run }
}

test('policy is private durable CAS state, not in Board/read/search/replay; one-use code persists', async t => {
  const f = fixture(t)
  const { policy } = f.save()
  assert.throws(f.save, hasCode('POLICY_CONFLICT'))
  assert.throws(() => f.service.policy({ boardId: BOARD, action: 'revoke' }), hasCode('POLICY_CONFLICT'))
  const { askCode, expiresAt } = f.issue(policy.version)
  assert.match(askCode, /^egask1-[0-9a-f]{32}$/)
  assert.equal(expiresAt - f.clock.now, 7 * 86400000)
  assert.equal(f.service.policy({ boardId: BOARD, action: 'get' }).askCode, undefined)
  assert.ok(!JSON.stringify([f.desk.board(BOARD), f.desk.boardRevision(BOARD, 1), f.desk.current(), f.desk.listBoards(), f.desk.searchBoards({query: 'Friday'}).results]).includes('Friday'))
  assert.throws(() => f.prepare(), hasCode('CODE_REQUIRED'))
  assert.throws(() => f.prepare(askCode + '\n'), hasCode('CODE_REQUIRED'))
  assert.throws(() => f.prepare(askCode, { boardId: OTHER }), hasCode('CODE_INVALID'))
  const first = f.prepare(askCode), parallel = f.prepare(askCode)
  assert.equal(f.calls.length, 0)
  assert.deepEqual(first.excerpts, approved)
  assert.equal(first.question, question)
  assert.ok(!JSON.stringify(first).includes(askCode))
  const running = f.run(first)
  await assert.rejects(f.run(first), hasCode('STALE'))
  await assert.rejects(f.run(parallel), hasCode('STALE'))
  assert.deepEqual(await running, { mode: 'extract', answer: approved[0], source: 'local', omittedCount: 0 })
  const disk = f.open().boardAgentAskPolicy(BOARD)
  assert.equal(disk.codeUsed, true)
  assert.equal(disk.version, policy.version)
  assert.equal(disk.excerpts[0], approved[0])
  assert.ok(!JSON.stringify(disk).includes(askCode))
  assert.throws(() => f.prepare(askCode), hasCode('CODE_INVALID'))
  assert.equal(f.calls.length, 1)
  assert.ok(!/private|recipient|requester/i.test(JSON.stringify(f.calls[0].input)))
})

test('stale Board/profile, reissue, cancel and expiry never dispatch; reapproval is explicit', async t => {
  const f = fixture(t)
  const { policy } = f.save()
  let { askCode } = f.issue(policy.version)
  let preview = f.prepare(askCode)
  f.desk.saveBoard(BOARD, { body: { ...BOARD_BODY, marker: 'changed' }, expectedRevision: 1 })
  await assert.rejects(f.run(preview), hasCode('STALE'))
  preview = f.prepare(askCode)
  f.profile.active.hash = '2'.repeat(64)
  await assert.rejects(f.run(preview), hasCode('STALE'))
  assert.equal(f.service.policy({ boardId: BOARD, action: 'get' }).policy.stale, true)
  f.profile.active.hash = 'a'.repeat(64)
  preview = f.prepare(askCode)
  const old = askCode
  ;({ askCode } = f.issue(policy.version))
  await assert.rejects(f.run(preview), hasCode('STALE'))
  assert.throws(() => f.prepare(old), hasCode('CODE_INVALID'))
  preview = f.prepare(askCode)
  f.service.cancel({ ticket: preview.ticket })
  await assert.rejects(f.run(preview), hasCode('STALE'))
  preview = f.prepare(askCode)
  f.clock.now = preview.expiresAt
  await assert.rejects(f.run(preview), hasCode('STALE'))
  assert.equal(f.calls.length, 0)
  assert.ok((await f.run(f.prepare(askCode))).answer)
})

test('physical removal cascades policy even when a Board is recreated with same ID and body', async t => {
  const f = fixture(t)
  const { policy } = f.save()
  const { askCode } = f.issue(policy.version)
  const preview = f.prepare(askCode)
  const raw = new DatabaseSync(f.file, { enableForeignKeyConstraints: true })
  // The entrypoint has no purge endpoint. Emulate a future proper physical purge.
  raw.exec(`BEGIN; DROP TRIGGER board_revisions_kept; DELETE FROM board_revisions WHERE board_id='${BOARD}'; DELETE FROM boards WHERE board_id='${BOARD}'; COMMIT;`)
  raw.close()
  f.desk.saveBoard(BOARD, { body: BOARD_BODY, expectedRevision: null })
  await assert.rejects(f.run(preview), hasCode('STALE'))
  assert.equal(f.service.policy({ boardId: BOARD, action: 'get' }).policy, null)
  assert.throws(() => f.prepare(askCode), hasCode('CODE_INVALID'))
})

test('invalid inputs do not persist and empty selector evidence is never invented', async t => {
  const f = fixture(t, { selectContext: async () => ({ selectedIds: [], outcome: 'empty' }) })
  const pattern = 'egask1-' + 'a'.repeat(32)
  assert.throws(() => f.save({ excerpts: ['한'.repeat(501)] }), hasCode('INPUT'))
  assert.throws(() => f.save({ excerpts: ['   '] }), hasCode('INPUT'))
  assert.throws(() => f.save({ excerpts: [pattern] }), hasCode('SECRET_LIKE'))
  assert.throws(() => f.save({ publicInstructions: `Do not disclose ${pattern}` }), hasCode('SECRET_LIKE'))
  assert.throws(() => f.save({ boardId: 'missing-board' }), error => error.code === 'BOARD_NOT_FOUND')
  const { policy } = f.save({ excerpts: [] })
  const { askCode } = f.issue(policy.version)
  assert.throws(() => f.prepare(askCode, { request: { ...request(askCode), question: pattern } }), hasCode('SECRET_LIKE'))
  assert.throws(() => f.prepare(askCode, { mode: 'draft' }), hasCode('DRAFT_OFF'))
  assert.equal((await f.run(f.prepare(askCode))).answer, '')
})

test('one-shot draft uses the displayed scope only; revocation/disconnect discard a late result', async t => {
  let finish, args
  const transport = { status: () => ({ configured: true, model: 'exact-model', bindingId: 'binding' }),
    draft: input => { args = input; return new Promise(resolve => { finish = resolve }) } }
  const f = fixture(t, { transport })
  const { policy } = f.save()
  for (const revoke of [false, true]) {
    const controller = new AbortController()
    const { askCode } = f.issue(policy.version)
    const preview = f.prepare(askCode, { mode: 'draft' })
    assert.equal(preview.model, 'exact-model')
    const result = f.run(preview, { signal: controller.signal })
    await Promise.resolve()
    const { signal, isCurrent, ...payload } = args
    assert.deepEqual(preview.excerpts, approved, 'owner reviews the full list the selection may draw from')
    assert.deepEqual(payload, { question: preview.question, excerpts: [approved[0]], publicInstructions: preview.publicInstructions,
      replyStyle: preview.replyStyle, model: preview.model, bindingId: 'binding' })
    assert.equal(isCurrent(), true)
    if (revoke) f.service.policy({ boardId: BOARD, action: 'revoke', expectedVersion: policy.version })
    else controller.abort()
    assert.equal(signal.aborted, true)
    finish({ answer: 'do not deliver' })
    await assert.rejects(result, hasCode('STALE'))
  }
})

test('real loopback HTTP checks origin, content type, bounds and dispatches four routes', async t => {
  const f = fixture(t)
  let handle
  const server = createServer(async (req, res) => { if (!(await handle(req, res, new URL(req.url, 'http://localhost')))) { res.statusCode = 404; res.end() } })
  server.listen(0, '127.0.0.1')
  t.after(() => new Promise(resolve => server.close(resolve)))
  await once(server, 'listening')
  const { port } = server.address()
  handle = createBoardAgentAskHttpHandler({ service: f.service, port })
  const send = (action, value, headers) => fetch(`http://127.0.0.1:${port}/v1/board-agent-ask/${action}`, {
    method: 'POST', body: JSON.stringify(value), headers: { 'content-type': 'application/json', ...headers } })
  const body = { boardId: BOARD, action: 'get' }
  assert.equal((await send('policy', body, { origin: 'http://localhost:1234' })).status, 403)
  assert.equal((await send('policy', body, { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await send('run', { ticket: 'x'.repeat(1024), confirm: true })).status, 413)
  assert.deepEqual(await (await send('policy', body)).json(), { policy: null, availability: { decision: false, draft: false, model: null } })
  const { policy } = f.save(), { askCode } = f.issue(policy.version)
  const prepare = () => send('prepare', { boardId: BOARD, request: request(askCode), mode: 'extract', decisionEgress: false }).then(res => res.json())
  const first = await prepare()
  assert.equal((await send('cancel', { ticket: first.ticket })).status, 200)
  assert.equal((await send('run', { ticket: first.ticket, confirm: true })).status, 409)
  const second = await prepare()
  const res = await send('run', { ticket: second.ticket, confirm: true })
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.equal((await res.json()).answer, approved[0])
})

test('production wiring isolates the draft credential before constructing launch env and mounts all four actions', () => {
  const source = readFileSync(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.ok(source.indexOf('delete process.env.EGDESK_BOARD_AGENT_DRAFT_API_KEY') < source.indexOf('const appServerLaunch'))
  assert.match(source, /createBoardAgentAskService\(\{[\s\S]*?selectContext: selectBoardAgentContext/)
  assert.match(source, /if \(await handleBoardAgentAskHttp\(req, res, url\)\) return/)
  assert.match(source, /boardAgentAsk\.available\(\) \? \['boardAgentAsk'\]/)
})
