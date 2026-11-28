import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { openWorkflowStore } from './egdesk-workflow-store.mjs'
import { createActJournal } from './egdesk-browser-procedure-journal.mjs'
import { createProcedureService } from './egdesk-browser-procedure-service.mjs'
import { createProcedureHttp } from './egdesk-browser-procedure-http.mjs'

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'egd-proc-'))
  const store = openWorkflowStore({ directory: path.join(root, 'store') })
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  let clock = 1000
  const journal = createActJournal()
  const service = createProcedureService({ store, journal, now: () => ++clock })
  return { store, journal, service, root }
}
const fill = (label, text, runId = 'r1') => ({ at: 1, runId, tool: 'egdesk_browser_fill', expectedTarget: { ref: 'e1', role: 'textbox', label, href: '', value: '', tag: 'input' }, text,
  postcondition: { kind: 'target-value', value: text }, pageUrl: 'http://127.0.0.1:8770/form', pageTitle: '폼', displaySafe: true })
const raw = () => ({ name: '배송', start: { url: 'http://127.0.0.1:8770/form' }, params: [{ name: '받는 분', default: '하늘', sensitive: false }],
  steps: [{ id: 's1', op: 'fill', target: { label: '받는 분' }, value: { param: '받는 분' } }] })

test('service: save, get, list, update keeps createdAt, remove', async t => {
  const { service } = await setup(t)
  const saved = service.save({ ...raw(), id: 'proc-ffffffffffff', createdAt: 5 })
  assert.equal(saved.ok, true)
  const { procedure } = saved
  assert.match(procedure.id, /^proc-[0-9a-f]{16}$/)
  assert.notEqual(procedure.id, 'proc-ffffffffffff', 'a new id')
  assert.deepEqual(service.get(procedure.id), procedure)
  assert.equal(service.get('proc-000000000000'), null)
  const second = service.save({ ...raw(), name: '두번째' }).procedure
  assert.deepEqual(service.list().map(s => s.name), ['두번째', '배송'])
  const changed = { ...raw(), name: '바뀜', params: [{ name: '받는 분', default: '이하늘', sensitive: false }], createdAt: 1, id: 'proc-aaaaaaaaaaaa' }
  const updated = service.update(procedure.id, changed)
  assert.deepEqual([updated.ok, updated.procedure.id, updated.procedure.createdAt, updated.procedure.updatedAt > procedure.updatedAt, updated.procedure.params[0].default],
    [true, procedure.id, procedure.createdAt, true, '이하늘'])
  assert.deepEqual(service.list().map(s => s.name), ['바뀜', '두번째'])
  assert.equal(service.update('proc-000000000000', raw()).notFound, true)
  assert.equal(service.update(procedure.id, { ...raw(), steps: [] }).ok, false)
  assert.equal(service.get(procedure.id).name, '바뀜', 'a refused update changes nothing')
  assert.equal(service.save({ name: '' }).ok, false)
  assert.equal(service.remove(second.id), true)
  assert.equal(service.remove(second.id), false)
  assert.equal(service.list().length, 1)
})

test('service: captureDraft takes the last run of that card and thread; saveCaptured saves it', async t => {
  const { service, journal } = await setup(t)
  assert.equal(service.captureDraft({ clientThreadId: 't', cardId: 'c' }), null)
  assert.deepEqual(service.saveCaptured({ clientThreadId: 't', cardId: 'c' }), { ok: false, empty: true })
  journal.record('t', 'c', fill('옛날', 'a', 'old'))
  journal.record('t', 'c', fill('받는 분', '하늘', 'new'))
  journal.record('t', 'c', fill('받는 분', '이하늘', 'new'))
  journal.record('other', 'c', fill('남의', 'z', 'x'))
  const draft = service.captureDraft({ clientThreadId: 't', cardId: 'c', name: '내 절차' })
  assert.deepEqual([draft.name, draft.params, draft.source, draft.steps.length], ['내 절차', [{ name: '받는 분', default: '이하늘', sensitive: false }], { clientThreadId: 't', cardId: 'c' }, 1])
  const saved = service.saveCaptured({ clientThreadId: 't', cardId: 'c' })
  assert.equal(saved.ok, true)
  assert.equal(service.list()[0].stepCount, 1)
})

function call(http, method, url, body, { host = '127.0.0.1:39218', remote = '127.0.0.1', json = true } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
  Object.assign(req, { method, url, headers: { host, ...(body === undefined ? {} : { 'content-type': json ? 'application/json' : 'text/plain' }) }, socket: { remoteAddress: remote } })
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v }, writeHead(s, h) { this.status = s; Object.assign(this.headers, h) }, end(x) { this.body = x ? JSON.parse(x) : null; this.writableEnded = true } }
  return http.handle(req, res, new URL(url, 'http://127.0.0.1:39218')).then(handled => ({ handled, status: res.status, body: res.body, headers: res.headers }))
}

test('http: flag off 404, loopback only, other paths not handled', async t => {
  const { service } = await setup(t)
  let on = false
  const http = createProcedureHttp({ service, enabled: () => on })
  assert.equal((await call(http, 'GET', '/v1/other')).handled, false)
  assert.deepEqual(await call(http, 'GET', '/v1/procedures').then(r => [r.status, r.body]), [404, { status: 'off' }])
  assert.deepEqual(await call(http, 'POST', '/v1/procedures/capture', {}).then(r => [r.status, r.body]), [404, { status: 'off' }])
  on = true
  assert.equal((await call(http, 'GET', '/v1/procedures', undefined, { remote: '10.0.0.5' })).status, 403)
  assert.equal((await call(http, 'GET', '/v1/procedures', undefined, { host: 'evil.test' })).status, 403)
  assert.equal((await call(http, 'GET', '/v1/procedures')).status, 200)
})

test('http: save, list, get, put, delete, capture', async t => {
  const { service, journal } = await setup(t)
  const http = createProcedureHttp({ service, enabled: () => true })
  assert.deepEqual((await call(http, 'GET', '/v1/procedures')).body, { procedures: [] })
  const bad = await call(http, 'POST', '/v1/procedures', { procedure: { name: '' } })
  assert.equal(bad.status, 400); assert.ok(bad.body.errors.length)
  const made = await call(http, 'POST', '/v1/procedures', { procedure: raw() })
  assert.equal(made.status, 201)
  const id = made.body.procedure.id
  assert.equal((await call(http, 'POST', '/v1/procedures', raw())).status, 201, 'the bare procedure works too')
  assert.equal((await call(http, 'GET', '/v1/procedures')).body.procedures.length, 2)
  assert.equal((await call(http, 'GET', `/v1/procedures/${id}`)).body.procedure.name, '배송')
  assert.equal((await call(http, 'GET', '/v1/procedures/proc-000000000000')).status, 404)
  assert.equal((await call(http, 'GET', '/v1/procedures/nope')).status, 404)
  const put = await call(http, 'PUT', `/v1/procedures/${id}`, { procedure: { ...raw(), name: '새 이름' } })
  assert.deepEqual([put.status, put.body.procedure.name], [200, '새 이름'])
  assert.equal((await call(http, 'PUT', `/v1/procedures/${id}`, { procedure: { ...raw(), steps: [] } })).status, 400)
  assert.equal((await call(http, 'PUT', '/v1/procedures/proc-000000000000', raw())).status, 404)
  assert.equal((await call(http, 'POST', '/v1/procedures', 'not json', { json: false })).status, 415)
  assert.equal((await call(http, 'POST', '/v1/procedures', '{bad')).status, 400)
  const wrong = await call(http, 'PATCH', `/v1/procedures/${id}`, {})
  assert.deepEqual([wrong.status, wrong.headers.Allow], [405, 'GET, PUT, DELETE'])
  assert.equal((await call(http, 'POST', '/v1/procedures/capture', { clientThreadId: 't', cardId: 'c' })).status, 409)
  assert.equal((await call(http, 'POST', '/v1/procedures/capture', { clientThreadId: 't' })).status, 400)
  journal.record('t', 'c', fill('받는 분', '하늘'))
  const cap = await call(http, 'POST', '/v1/procedures/capture', { clientThreadId: 't', cardId: 'c', name: '캡처' })
  assert.deepEqual([cap.status, cap.body.draft.name, cap.body.draft.steps.length, 'id' in cap.body.draft], [200, '캡처', 1, false])
  assert.equal((await call(http, 'GET', '/v1/procedures')).body.procedures.length, 2, 'capture saves nothing')
  assert.equal((await call(http, 'DELETE', `/v1/procedures/${id}`)).body.status, 'deleted')
  assert.equal((await call(http, 'DELETE', `/v1/procedures/${id}`)).status, 404)
})
