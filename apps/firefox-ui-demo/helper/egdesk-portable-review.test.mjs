import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { createEGDeskPortableBundle, loadEGDeskPortableDependencies, REVIEW_BUNDLE_FORMAT } from './egdesk-portable-bundle.mjs'
import { createPortableHttpHandler } from './egdesk-portable-http.mjs'
import { createPortableReviewService, REVIEW_MAX_BUNDLE_BYTES } from './egdesk-portable-review.mjs'
import { createPortableService } from './egdesk-portable-service.mjs'

const deps = await loadEGDeskPortableDependencies().catch(() => null)
const needsBundle = { skip: !deps && 'portable ZIP/envelope dependencies are not installed' }
const REQUEST = { kind: 'request', recipient: 'Reviewer B', question: 'Which plan is clearer?', excerpt: 'Option A\nOption B', expectedReply: 'Pick one and say why.' }
const PASSPHRASE = 'synthetic-file-key'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const bundle = bytes => ({ bundle: bytes.toString('base64') })
async function readManifest(bytes) {
  let manifest
  await deps.codec.read(bytes, async entry => {
    const content = await collect(entry.bytes())
    if (entry.name === 'manifest.json') manifest = JSON.parse(content)
  })
  return manifest
}
async function collect(stream) { const parts = []; for await (const part of stream) parts.push(part); return Buffer.concat(parts) }

function request(method, route, body, headers) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method, url: route,
    headers: { host: '127.0.0.1:39218', 'content-type': 'application/json', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  })
}
async function call(handler, route, body, { method = 'POST', headers, cancel = false } = {}) {
  const req = request(method, route, body, headers)
  const res = new EventEmitter()
  const response = {}
  res.writeHead = (status, headers) => { Object.assign(response, { status, headers }) }
  res.end = text => { response.data = JSON.parse(text) }
  if (cancel) req.once('end', () => { res.destroyed = true; res.emit('close') })
  assert.equal(await handler(req, res, new URL(route, 'http://127.0.0.1:39218')), true)
  return response
}
function install(t, name) {
  const root = createPrivateQaTempDirectory(`egdesk-review-${name}-`)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'exports')
  const location = () => ({ directory })
  const storeTouched = () => assert.fail('Review must not resolve the normal local stores')
  const handler = createPortableHttpHandler({ location, home: root, dependencies: deps,
    desk: storeTouched, chat: storeTouched, profiles: storeTouched, attachments: storeTouched, fileDrafts: storeTouched })
  return { root, directory, handler, location,
    export: (body, options) => call(handler, '/v1/portable/review/export', body, options),
    inspect: (body, options) => call(handler, '/v1/portable/review/inspect', body, options),
    read: filename => readFileSync(path.join(directory, filename)),
  }
}

// No sockets or accounts: each fake bridge uses a private synthetic local install.
test('two signed-out installs manually hand off a request and reply without touching other stores', needsBundle, async t => {
  const a = install(t, 'a'), b = install(t, 'b')
  const fixture = 'Synthetic private source text; never reviewed'
  writeFileSync(path.join(a.root, 'synthetic-local-source.txt'), fixture)
  assert.equal(await a.handler.supportsReviewHandoff(), true)
  assert.equal(await createPortableHttpHandler({ location: a.location, dependencies: {} }).supportsReviewHandoff(), false)
  assert.equal(existsSync(a.directory), false)
  const sent = await a.export({ review: { ...REQUEST, recipient: '  Reviewer B ', excerpt: 'Option A\r\nOption B\n' } })
  assert.equal(sent.status, 201)
  assert.equal(sent.headers['Cache-Control'], 'no-store')
  const { review, fileName, displayPath, fileRef, encrypted } = sent.data
  assert.deepEqual(Object.keys(sent.data).sort(), ['displayPath', 'encrypted', 'fileName', 'fileRef', 'review'])
  assert.match(review.requestId, /^[a-f0-9-]{36}$/)
  const { requestId, requestDigest, ...disclosed } = review
  assert.deepEqual(disclosed, REQUEST)
  assert.equal(displayPath, `~/exports/${fileName}`)
  assert.equal(encrypted, false)
  assert.match(fileName, /^EG-Desk-Review-[a-f0-9-]+\.egdesk$/)
  assert.deepEqual(fileRef, { exportFile: fileName })
  const file = a.read(fileName)
  assert.equal(file.includes(fixture), false)
  let i = 0
  let requestNonce
  await deps.codec.read(file, async entry => {
    const bytes = await collect(entry.bytes())
    assert.equal(entry.name, ['manifest.json', 'events.jsonl', 'transcript.md'][i++])
    if (entry.name === 'manifest.json') {
      const manifest = JSON.parse(bytes)
      requestNonce = manifest.requestNonce
      assert.match(requestNonce, /^[a-f0-9]{64}$/)
      assert.deepEqual(manifest, { format: REVIEW_BUNDLE_FORMAT, version: 2, review, requestNonce })
    } else assert.equal(bytes.length, 0)
  })
  assert.equal(requestDigest, sha(Buffer.from(JSON.stringify({ format: REVIEW_BUNDLE_FORMAT, version: 2, kind: 'request', requestId, requestNonce, ...disclosed }))))
  assert.deepEqual((await a.inspect({ fileRef })).data, { review, encrypted: false, locked: false })
  assert.deepEqual((await b.inspect(bundle(file))).data, { review, encrypted: false, locked: false })
  assert.deepEqual(readdirSync(b.root), [])
  const answer = { kind: 'reply', requestId, requestDigest, answer: 'Option B. The scope is shorter.' }
  const reply = (await b.export({ review: answer, passphrase: PASSPHRASE })).data
  assert.equal(reply.encrypted, true)
  assert.deepEqual(reply.review, answer)
  const replyBytes = b.read(reply.fileName)
  for (const value of [...Object.values(REQUEST), answer.answer, requestId, requestDigest, PASSPHRASE]) assert.equal(replyBytes.includes(value), false)
  assert.deepEqual((await a.inspect(bundle(replyBytes))).data, { encrypted: true, locked: true })
  const wrong = await a.inspect({ ...bundle(replyBytes), passphrase: 'incorrect-synthetic-key' })
  assert.equal(wrong.data.code, 'PORTABLE_PASSPHRASE_INVALID')
  const inspected = await a.inspect({ ...bundle(replyBytes), passphrase: PASSPHRASE })
  assert.equal(inspected.headers['Cache-Control'], 'no-store')
  assert.deepEqual(inspected.data, { review: answer, encrypted: true, locked: false })
  assert.deepEqual(readdirSync(a.directory), [fileName]); assert.deepEqual(readdirSync(b.directory), [reply.fileName])
  assert.equal(readFileSync(path.join(a.root, 'synthetic-local-source.txt'), 'utf8'), fixture)
  const repeated = (await a.export({ review: REQUEST })).data
  assert.notEqual(repeated.fileName, fileName)
  assert.notEqual(repeated.review.requestId, requestId)
  assert.notEqual(repeated.review.requestDigest, requestDigest)
  const repeatedManifest = await readManifest(a.read(repeated.fileName))
  assert.match(repeatedManifest.requestNonce, /^[a-f0-9]{64}$/)
  assert.notEqual(repeatedManifest.requestNonce, requestNonce)
  // A plaintext reply to an encrypted request must not expose its text or nonce.
  const confidential = (await a.export({ review: REQUEST, passphrase: PASSPHRASE })).data
  const confidentialBytes = a.read(confidential.fileName)
  const confidentialArchive = await readManifest(await collect(deps.envelope.decrypt(Readable.from([confidentialBytes]), PASSPHRASE)))
  assert.equal(confidentialBytes.includes(confidentialArchive.requestNonce), false)
  assert.deepEqual((await b.inspect({ ...bundle(confidentialBytes), passphrase: PASSPHRASE })).data, { review: confidential.review, encrypted: true, locked: false })
  const approved = { ...answer, requestId: confidential.review.requestId, requestDigest: confidential.review.requestDigest }
  const plainReply = (await b.export({ review: approved })).data
  assert.deepEqual(plainReply.review, approved)
  assert.deepEqual(await readManifest(b.read(plainReply.fileName)), { format: REVIEW_BUNDLE_FORMAT, version: 2, review: approved })
  for (const value of [REQUEST.recipient, REQUEST.question, REQUEST.excerpt, REQUEST.expectedReply, confidentialArchive.requestNonce]) {
    assert.equal(b.read(plainReply.fileName).includes(value), false)
    assert.equal(JSON.stringify(plainReply).includes(value), false)
  }
  assert.deepEqual(a.read(fileName), file)
})

test('invalid and cancelled operations and untrusted origins perform no writes', needsBundle, async t => {
  const a = install(t, 'no-write')
  for (const review of [
    { ...REQUEST, board: { hidden: 'X' } }, { ...REQUEST, excerpt: { text: 'secret' } },
    { ...REQUEST, excerpt: '나'.repeat(2731) }, { ...REQUEST, question: '\u202Etext' }, { ...REQUEST, recipient: 'two\nrows' },
    { ...REQUEST, expectedReply: '' }, { ...REQUEST, question: '\uD800' },
    { kind: 'reply', requestId: 'not-a-uuid', requestDigest: 'a'.repeat(64), answer: 'Yes' },
    { kind: 'reply', requestId: 'b4b5a680-ce82-414d-b1b9-042d3ef10191', requestDigest: 'A'.repeat(64), answer: 'Yes' },
    { ...REQUEST, requestId: 'b4b5a680-ce82-414d-b1b9-042d3ef10191' },
  ]) assert.equal((await a.export({ review })).data.code, 'PORTABLE_REVIEW_INPUT')
  assert.equal((await a.export({ review: { ...REQUEST, excerpt: 'password: synthetic-private-value' } })).data.code, 'PORTABLE_REVIEW_SECRET_LIKE')
  assert.equal((await a.export({ review: REQUEST, passphrase: 'short' })).data.code, 'PORTABLE_PASSPHRASE_TOO_SHORT')
  assert.equal((await a.export({ review: REQUEST, passphrase: 'z'.repeat(1025) })).data.code, 'PORTABLE_PASSPHRASE_TOO_SHORT')
  assert.equal((await a.export({ review: REQUEST, hidden: null })).data.code, 'PORTABLE_HTTP_INPUT')
  assert.equal((await a.export({ review: REQUEST }, { headers: { origin: 'https://example.invalid' } })).status, 403)
  assert.equal((await a.export({ review: REQUEST }, { method: 'GET' })).status, 405)
  assert.equal((await a.inspect({ fileRef: { exportFile: '../outside.egdesk' } })).status, 400)
  assert.equal((await a.inspect(bundle(Buffer.alloc(REVIEW_MAX_BUNDLE_BYTES + 1)))).status, 413)
  assert.equal((await a.inspect({ bundle: 'a'.repeat(REVIEW_MAX_BUNDLE_BYTES * 2) })).data.code, 'BODY_TOO_LARGE')
  assert.equal((await a.inspect(bundle(Buffer.from('not a file')))).data.code, 'PORTABLE_REVIEW_FILE_INVALID')
  const service = createPortableReviewService({ location: a.location, dependencies: deps })
  await assert.rejects(service.exportReview({ review: REQUEST }, { signal: AbortSignal.abort() }), { code: 'PORTABLE_REVIEW_CANCELLED' })
  await a.export({ review: REQUEST }, { cancel: true })
  assert.deepEqual(readdirSync(a.root), [])
  const optional = await a.export({ review: { ...REQUEST, excerpt: ' ' } })
  assert.equal(optional.data.review.excerpt, '')
})

test('only omission opts into plaintext at the HTTP and direct service boundaries', needsBundle, async t => {
  const a = install(t, 'passphrase-presence')
  const service = createPortableReviewService({ location: a.location, dependencies: deps })
  for (const passphrase of ['', null, 0, false, {}, []]) {
    const response = await a.export({ review: REQUEST, passphrase })
    assert.equal(response.status, 400)
    assert.equal(response.data.code, 'PORTABLE_HTTP_INPUT')
    await assert.rejects(service.exportReview({ review: REQUEST, passphrase }), { code: 'PORTABLE_HTTP_INPUT' })
  }
  await assert.rejects(service.exportReview({ review: REQUEST, passphrase: undefined }), { code: 'PORTABLE_HTTP_INPUT' })
  assert.equal(existsSync(a.directory), false)
  assert.equal((await service.exportReview({ review: REQUEST })).encrypted, false)
  assert.equal((await a.export({ review: REQUEST })).data.encrypted, false)
})

test('the generic export listing hides only generated review names and collision variants', needsBundle, async t => {
  const a = install(t, 'listing')
  const { fileName } = (await a.export({ review: REQUEST })).data
  const copyName = suffix => fileName.replace(/\.egdesk$/, suffix + '.egdesk')
  const ordinaryNames = ['EG-Desk-Review-Notes-20261024-153012.egdesk', 'EG-Desk-Board-Review-20261024-153012.egdesk', copyName(' (1)'), copyName(' (100)'), copyName('-20261024-153012')]
  for (const name of [...ordinaryNames, copyName(' (2)'), copyName(' (99)')]) writeFileSync(path.join(a.directory, name), 'Synthetic fixture')
  const ordinary = createPortableService({ location: a.location, dependencies: deps })
  assert.deepEqual((await ordinary.listExports()).files.map(file => file.fileName).sort(), ordinaryNames.sort())
})

async function makeZip(content, { events = '', extra = false } = {}) {
  return collect(deps.codec.encode([
    ['manifest.json', content], ['events.jsonl', events], ['transcript.md', ''],
    ...(extra ? [[`objects/${'a'.repeat(64)}`, 'not approved']] : []),
  ].map(([name, value]) => ({ name, size: Buffer.byteLength(value), open: () => Readable.from([Buffer.from(value)]) })), { canonical: true }))
}
async function genericBoardBundle() {
  const payload = Buffer.from('{"kind":"egdesk.portable.root","v":1,"scope":"board"}')
  const digest = sha(payload)
  const graph = createEGDeskPortableBundle({ ...deps, objectProvider: { openExportSnapshot: async () => ({
    getNode: async () => ({ id: 'board', type: 'board', scopeRootId: 'board', title: 'Synthetic Board', refs: [], objects: [{ role: 'body', sha256: digest }] }),
    listEvents: async () => [], getObjectMeta: async () => ({ size: payload.length, portableApproved: true, scopeRootId: 'board' }),
    openObject: () => Readable.from([payload]), close: async () => {},
  }) }, importStore: { reopenRepresentative: async () => false, beginStage: async () => assert.fail('export does not stage imports') } })
  const plan = await graph.planExport({ rootIds: ['board'] })
  const { PassThrough } = await import('node:stream')
  const writable = new PassThrough()
  const output = collect(writable)
  await graph.exportPlan({ planId: plan.planId, sink: { writable, atomicPublish: true, stagingProtection: 'encrypted', abort: async () => {}, publish: async () => ({}) } })
  return output
}

test('reject opposite formats and hidden file data without imports or writes', needsBundle, async t => {
  const a = install(t, 'reject'), b = install(t, 'reject-peer')
  const output = (await a.export({ review: REQUEST })).data
  const valid = a.read(output.fileName)
  const ordinary = createPortableService({ location: a.location, dependencies: deps })
  assert.deepEqual((await ordinary.listExports()).files, [])
  await assert.rejects(ordinary.inspectBundle({ fileRef: output.fileRef }), { code: 'PORTABLE_REVIEW_HANDOFF' })
  await assert.rejects(ordinary.importBundle(bundle(valid)), { code: 'PORTABLE_REVIEW_HANDOFF' })
  const board = await genericBoardBundle()
  const boardManifest = await (async () => {
    let out
    await deps.codec.read(board, async entry => { const data = await collect(entry.bytes()); if (entry.name === 'manifest.json') out = JSON.parse(data) })
    return out
  })()
  const manifest = await readManifest(valid)
  const { review, requestNonce } = manifest
  const content = JSON.stringify(manifest)
  const { requestId, requestDigest, ...disclosed } = review
  const legacyDigest = sha(Buffer.from(JSON.stringify({ format: REVIEW_BUNDLE_FORMAT, version: 1, ...disclosed })))
  const mutated = await Promise.all([
    makeZip(JSON.stringify({ ...boardManifest, review })),
    makeZip(JSON.stringify({ ...manifest, identity: 'hidden' })),
    makeZip(JSON.stringify({ ...manifest, review: { ...review, account: 'hidden' } })),
    makeZip(content.replace('"version":2', '"version":99,"version":2')),
    makeZip(content.replace(requestDigest, 'f'.repeat(64))),
    makeZip(content.replace(requestNonce, 'f'.repeat(64))),
    makeZip(JSON.stringify({ ...manifest, review: { ...review, question: 'Altered after export?' } })),
    makeZip(JSON.stringify({ ...manifest, review: { ...review, requestId: 'b4b5a680-ce82-414d-b1b9-042d3ef10191' } })),
    makeZip(JSON.stringify({ format: REVIEW_BUNDLE_FORMAT, version: 2, review })),
    makeZip(JSON.stringify({ format: REVIEW_BUNDLE_FORMAT, version: 1, review: { ...review, requestDigest: legacyDigest } })),
    makeZip(JSON.stringify({ ...manifest, review: { kind: 'reply', requestId, requestDigest, answer: 'Fixture reply' } })),
    makeZip(content, { events: 'hidden' }),
    makeZip(content, { extra: true }),
  ])
  // Legal ZIP comment carrying unapproved data, deliberately outside the JSON.
  const comment = Buffer.concat([valid, Buffer.from('hide')]); comment.writeUInt16LE(4, valid.length - 2)
  for (const file of [board, ...mutated, comment]) {
    const out = await b.inspect(bundle(file))
    assert.equal(out.data.code, 'PORTABLE_REVIEW_FILE_INVALID')
    assert.equal(Object.hasOwn(out.data, 'review'), false)
  }
  const lockedBoard = await collect(deps.envelope.encrypt(Readable.from([board]), PASSPHRASE))
  assert.deepEqual((await b.inspect(bundle(lockedBoard))).data, { encrypted: true, locked: true })
  assert.equal((await b.inspect({ ...bundle(lockedBoard), passphrase: PASSPHRASE })).data.code, 'PORTABLE_REVIEW_FILE_INVALID')
  assert.deepEqual(readdirSync(b.root), [])
  assert.deepEqual(readdirSync(a.directory), [output.fileName])
})
