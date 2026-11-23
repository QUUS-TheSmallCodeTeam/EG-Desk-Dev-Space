import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createBoardAgentAskHttpHandler } from './egdesk-board-agent-ask-http.mjs'
import { createBoardAgentAskService } from './egdesk-board-agent-ask.mjs'
import { selectBoardAgentContext } from './egdesk-board-agent-context.mjs'
import { createDecisionBudget, createDecisionClient, DECISIONS_ENDPOINT } from './egdesk-decision-client.mjs'
import { createDecisionHttpHandler } from './egdesk-decision-http.mjs'
import { openDeskStore } from './egdesk-desk-store.mjs'

const BOARD = 'fixture-extract-board'
const PROFILE = 'fixture-extract-agent'
const QUESTION = 'Where is the rehearsal?'
const LOCAL = 'The rehearsal venue has changed.'
const SELECTED = 'Meet in the atrium on Friday.'

// Exercise the actual request handlers without binding a socket.
async function call(handler, method, pathname, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  Object.assign(req, { method, url: pathname, headers: { host: '127.0.0.1:39218', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' } })
  const res = new EventEmitter()
  res.writeHead = status => { res.status = status }
  res.end = data => { res.body = JSON.parse(data) }
  assert.equal(await handler(req, res, new URL(`http://127.0.0.1:39218${pathname}`)), true)
  return { status: res.status, body: res.body }
}

test('quota refresh on next explicit Board extract uses the saved key without polling or retry', async t => {
  // Observe timers from setup onward without mocking Date, the OS clock or a billing date.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const dir = mkdtempSync(path.join(tmpdir(), 'egdesk-board-quota-'))
  const desk = openDeskStore({ dataDir: dir, ownerScope: 'quota-fixture' })
  const board = { version: 1, agenda: { id: BOARD, title: 'Fixture Board' }, cards: [], shapes: [] }
  desk.saveBoard(BOARD, { body: board, expectedRevision: null })
  const boardBefore = JSON.stringify(desk.board(BOARD).head)
  const fixtureCredential = ['not-a-real-provider-credential', randomBytes(18).toString('hex')].join('.')
  let stored = null, saves = 0, clears = 0, modeValue = 'off', quota = 'exhausted'
  const posts = []
  const store = { get status() { return stored ? 'loaded' : 'missing' }, writable: true,
    getApiKey: () => stored, hint: () => null, savedAt: () => stored ? 1 : null,
    save(value) { saves++; stored = value; return true }, clear() { clears++; stored = null; return true },
  }
  const mode = { get mode() { return modeValue }, get saved() { return modeValue }, persisted: true,
    save(value) { modeValue = value; return true },
  }
  const budget = createDecisionBudget()
  const client = createDecisionClient({ getApiKey: () => store.getApiKey(), budget,
    fetchImpl(url, options) {
      const body = JSON.parse(options.body)
      const phase = body.questions.some(q => q.name === 'key_check') ? 'check' : 'extract'
      // Store neither the bearer value nor the request body in test diagnostics.
      const post = { phase, endpointMatched: url === DECISIONS_ENDPOINT, method: options.method,
        sameFixtureCredential: options.headers.authorization === `Bearer ${fixtureCredential}`,
        requestMatched: phase === 'check' ? body.input === 'EG-Desk key check' && body.questions.length === 1 :
          body.input === JSON.stringify({ question: QUESTION, candidates: [{ alias: 'c1', text: LOCAL }, { alias: 'c2', text: SELECTED }] }) &&
          body.questions.length === 2 && body.questions.every((q, i) => q.type === 'predicate' && q.name === `c${i + 1}`),
        providerStatus: quota === 'exhausted' ? 429 : 200,
      }
      posts.push(post)
      if (post.providerStatus === 429) return Response.json({ error: { code: 'insufficient_quota', type: 'insufficient_quota' } }, { status: 429 })
      return Response.json({ model: client.model, usage: { input_tokens: 19, output_tokens: 2, total_tokens: 21 },
        answers: [{ name: 'c1', type: 'predicate', probability: 0.1 }, { name: 'c2', type: 'predicate', probability: 0.98 }] })
    },
  })
  const handleSettings = createDecisionHttpHandler({ store, mode, budget, model: client.model, verifyKey: client.verifyKey })
  const bindingSecret = randomBytes(32)
  const profile = { lifecycle: 'active', activeRevision: 1, active: { revision: 1, hash: 'a'.repeat(64), body: { name: 'Fixture Agent', model: null } } }
  const boardService = createBoardAgentAskService({ desk, profiles: { get: id => id === PROFILE ? profile : null }, selectContext: selectBoardAgentContext,
    decisionStatus: () => {
      const key = store.getApiKey()
      if (!key || mode.mode === 'off') return null
      const bindingId = createHmac('sha256', bindingSecret).update(JSON.stringify([key, store.savedAt(), mode.mode, client.model])).digest('hex')
      return { model: client.model, mode: mode.mode, bindingId, client }
    },
  })
  t.after(() => { boardService.close(); desk.close(); rmSync(dir, { recursive: true, force: true }) })
  const handleBoard = createBoardAgentAskHttpHandler({ service: boardService })
  const ask = (action, body) => call(handleBoard, 'POST', `/v1/board-agent-ask/${action}`, body)
  const policy = (action, fields = {}) => ask('policy', { boardId: BOARD, action, ...fields })
  const settings = (method, action, body) => call(handleSettings, method, `/decision/${action}`, body)
  const credentialKept = () => { assert.equal(store.getApiKey() === fixtureCredential, true); assert.equal(saves, 1); assert.equal(clears, 0) }
  const noBackgroundPost = async expected => {
    t.mock.timers.tick(60_000)
    const status = await settings('GET', 'status')
    assert.equal(status.status, 200)
    assert.equal(status.body.configured, true)
    assert.equal(Object.hasOwn(status.body, 'verification'), false)
    assert.equal((await settings('GET', 'mode')).status, 200)
    assert.equal((await policy('get')).status, 200)
    assert.equal(posts.length, expected)
  }

  // The fixture credential is entered once. No subsequent request writes it.
  const check = await settings('POST', 'credential', { apiKey: fixtureCredential })
  assert.equal(check.status, 200)
  assert.equal(check.body.verification, 'no_credit')
  assert.equal(check.body.configured, true)
  assert.equal(JSON.stringify(check.body).includes(fixtureCredential), false)
  assert.deepEqual(posts.map(p => [p.phase, p.providerStatus]), [['check', 429]])
  credentialKept()
  await noBackgroundPost(1)
  const enabled = await settings('POST', 'mode', { mode: 'on' })
  assert.equal(enabled.status, 200)
  assert.equal(enabled.body.mode, 'on')
  const saved = await policy('save', { profileId: PROFILE, excerpts: [LOCAL, SELECTED] })
  assert.equal(saved.status, 200)
  let policyVersion = saved.body.policy.version

  async function approveExtract(serial, previousPosts) {
    const issued = await policy('issue', { expectedVersion: policyVersion })
    assert.equal(issued.status, 200)
    policyVersion = issued.body.policy.version
    const preview = await ask('prepare', { boardId: BOARD, mode: 'extract', decisionEgress: true,
      request: { kind: 'request', requestId: serial === 1 ? '8878a7f3-df6b-4383-af12-6ae38ad4fe2e' : '8878a7f3-df6b-4383-af12-6ae38ad4fe2f',
        requestDigest: createHash('sha256').update(`synthetic-request-${serial}`).digest('hex'), question: QUESTION,
        recipient: 'Fixture recipient', excerpt: '', expectedReply: 'Human review only', askCode: issued.body.askCode } })
    assert.equal(preview.status, 200)
    assert.equal(preview.body.decisionEgress, true)
    assert.equal(preview.body.mode, 'extract')
    assert.deepEqual(preview.body.excerpts, [LOCAL, SELECTED])
    const run = confirm => ask('run', { ticket: preview.body.ticket, confirm })
    assert.equal((await run(false)).status, 400)
    assert.equal(posts.length, previousPosts)
    const result = await run(true)
    assert.equal(posts.length, previousPosts + 1)
    assert.equal((await run(true)).status, 409)
    assert.equal(posts.length, previousPosts + 1)
    return result
  }

  assert.deepEqual(await approveExtract(1, 1), { status: 200, body: { mode: 'extract', answer: LOCAL, source: 'local', omittedCount: 0 } })
  credentialKept()
  assert.equal(budget.snapshot().inputTokens, 0)
  // Change only the mock provider's quota state. Neither idle time nor reads dispatch.
  quota = 'recovered'
  await noBackgroundPost(2)
  assert.deepEqual(await approveExtract(2, 2), { status: 200, body: { mode: 'extract', answer: SELECTED, source: 'decision', omittedCount: 0 } })
  credentialKept()
  assert.equal(budget.snapshot().inputTokens, 19)
  await noBackgroundPost(3)
  assert.equal(JSON.stringify(desk.board(BOARD).head) === boardBefore, true)
  assert.deepEqual(posts, [['check', 429], ['extract', 429], ['extract', 200]].map(([phase, providerStatus]) => ({
    phase, endpointMatched: true, method: 'POST', sameFixtureCredential: true, requestMatched: true, providerStatus,
  })))
  t.diagnostic('BOARD_QUOTA_TRACE ' + JSON.stringify({ keyVerificationPosts: 1, featurePosts: 2,
    idleStatusPreviewReplayPosts: 0, verification: 'no_credit', exhausted: { provider: 429, source: 'local' },
    recovered: { provider: 200, source: 'decision', countedInputTokens: 19 }, sameSavedKey: true, saves: 1, clears: 0, boardUnchanged: true }))
})
