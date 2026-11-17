import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { createDecisionBudget } from './egdesk-decision-client.mjs'
import { openDecisionCredentialStore } from './egdesk-decision-credential.mjs'
import { createDecisionHttpHandler } from './egdesk-decision-http.mjs'

const KEY = 'sk-proj-TESTKEY-0123456789abcdefWXYZ'

function fakeRequest(method, url, body, headers = {}) {
  const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(raw)
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:39218', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}
function fakeResponse() {
  return { status: null, body: '', writeHead(status) { this.status = status }, end(body) { this.body = body ?? '' } }
}
function fixture(t, verdict = 'verified') {
  const root = createPrivateQaTempDirectory('egdesk-decision-http-test-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = openDecisionCredentialStore({ dataDir: path.join(root, 'data'), log: () => {} })
  const verified = []
  const verifyKey = async key => { verified.push(key); return { status: typeof verdict === 'function' ? verdict(key) : verdict, retryable: false } }
  const handler = createDecisionHttpHandler({ store, verifyKey, model: 'gpt-6-luna', budget: createDecisionBudget({ monthlyInputTokenCap: 1000 }) })
  const call = async (method, url, body, headers) => {
    const res = fakeResponse()
    const handled = await handler(fakeRequest(method, url, body, headers), res, new URL(url, 'http://127.0.0.1:39218'))
    return { handled, status: res.status, raw: res.body, data: res.body ? JSON.parse(res.body) : null }
  }
  return { store, verified, call }
}

test('status, verified save and removal never echo the key', async t => {
  const { store, verified, call } = fixture(t)
  const empty = await call('GET', '/decision/status')
  assert.equal(empty.status, 200)
  assert.equal(empty.data.configured, false)
  assert.equal(empty.data.store, 'missing')
  assert.equal(empty.data.model, 'gpt-6-luna')
  assert.equal(empty.data.budget.cap, 1000)
  const saved = await call('POST', '/decision/credential', { apiKey: KEY })
  assert.equal(saved.status, 200)
  assert.equal(saved.data.configured, true)
  assert.equal(saved.data.keyHint, '…WXYZ')
  assert.equal(saved.data.verification, 'verified')
  assert.ok(!saved.raw.includes(KEY))
  assert.deepEqual(verified, [KEY])
  assert.equal(store.getApiKey(), KEY)
  const removed = await call('DELETE', '/decision/credential')
  assert.equal(removed.status, 200)
  assert.equal(removed.data.configured, false)
  assert.equal(store.getApiKey(), null)
})

test('a rejected key is not saved; an authenticated key without credits is saved and reported', async t => {
  const rejected = fixture(t, 'invalid_key')
  const response = await rejected.call('POST', '/decision/credential', { apiKey: KEY })
  assert.equal(response.status, 422)
  assert.equal(response.data.verification, 'invalid_key')
  assert.equal(rejected.store.getApiKey(), null)
  assert.ok(!response.raw.includes(KEY))
  const noCredit = fixture(t, 'no_credit')
  const kept = await noCredit.call('POST', '/decision/credential', { apiKey: KEY })
  assert.equal(kept.status, 200)
  assert.equal(kept.data.verification, 'no_credit')
  assert.equal(noCredit.store.getApiKey(), KEY)
})

test('bad input, foreign origins and other paths are refused without verification', async t => {
  const { verified, call } = fixture(t)
  assert.equal((await call('POST', '/decision/credential', { apiKey: 'short' })).status, 400)
  assert.equal((await call('POST', '/decision/credential', 'not json', { 'content-type': 'application/json' })).status, 400)
  assert.equal((await call('POST', '/decision/credential', JSON.stringify({ apiKey: KEY }), { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await call('PUT', '/decision/credential', { apiKey: KEY })).status, 405)
  assert.equal((await call('POST', '/decision/status', { apiKey: KEY })).status, 405)
  const foreign = await call('POST', '/decision/credential', { apiKey: KEY }, { origin: 'https://evil.example' })
  assert.equal(foreign.status, 403)
  assert.equal((await call('GET', '/decision/other')).handled, false)
  assert.deepEqual(verified, [])
})
