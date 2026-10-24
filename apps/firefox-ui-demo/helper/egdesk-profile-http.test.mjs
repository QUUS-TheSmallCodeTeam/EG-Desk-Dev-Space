import test from 'node:test'
import assert from 'node:assert/strict'
import { realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { crc32, deflateSync } from 'node:zlib'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { exportAgentMarkdown } from './egdesk-profile-file.mjs'
import { AVATAR_PALETTE, TOOL_CEILING_PRESETS, openProfileStore, profileHash } from './egdesk-profile-store.mjs'
import { createProfileHttpHandler, handleProfileHttp } from './egdesk-profile-http.mjs'

function fixture(t) {
  const dataDir = createPrivateQaTempDirectory('egdesk-profile-http-test-')
  const stores = []
  t.after(() => {
    for (const store of stores) store.close()
    assert.equal(realpathSync.native(dataDir), dataDir)
    rmSync(dataDir, { recursive: true, force: true })
  })
  const open = (ownerHash = 'local-desktop-v1') => { const store = openProfileStore({ dataDir, ownerHash }); stores.push(store); return store }
  return { open }
}
function fakeRequest(method, url, body, headers = {}) {
  const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(raw)
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:39218', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}
async function call(options, method, url, body, headers) {
  const req = fakeRequest(method, url, body, headers)
  const sent = []
  const handled = await handleProfileHttp(req, new URL(url, 'http://127.0.0.1:39218'), { send: (status, data) => sent.push({ status, data }), ...options })
  assert.ok(sent.length <= 1)
  return { handled, status: sent[0]?.status, data: sent[0]?.data }
}
const body = (extra = {}) => ({ name: '리오', role: '회의 준비 담당', personality: { tone: 'warm' }, ...extra })

test('profile routes create, edit, activate, inspect and retire a profile', async t => {
  const { open } = fixture(t)
  const store = open()
  const api = (...args) => call({ store }, ...args)

  const created = await api('POST', '/profiles', { body: body() })
  assert.equal(created.status, 201)
  const id = created.data.id
  assert.equal(created.data.revision, 1)
  assert.equal((await api('GET', '/profiles')).data.profiles[0].name, '리오')
  const fetched = await api('GET', `/profiles/${id}`)
  assert.deepEqual([fetched.status, fetched.data.lifecycle, fetched.data.head.body.personality.tone], [200, 'draft', 'warm'])

  const edited = await api('PUT', `/profiles/${id}/draft`, { body: body({ role: '일정 담당' }), expectedRevision: 1 })
  assert.deepEqual([edited.status, edited.data.revision], [200, 2])
  const stale = await api('PUT', `/profiles/${id}/draft`, { body: body({ role: '다른 창' }), expectedRevision: 1 })
  assert.deepEqual([stale.status, stale.data.code, stale.data.headRevision, stale.data.activeRevision], [409, 'PROFILE_REVISION_CONFLICT', 2, null])
  assert.equal(typeof stale.data.error, 'string')

  const activated = await api('POST', `/profiles/${id}/activate`, { revision: 2, expectedActiveRevision: null })
  assert.deepEqual([activated.status, activated.data.lifecycle, activated.data.activeRevision], [200, 'active', 2])
  const staleActive = await api('POST', `/profiles/${id}/activate`, { revision: 1, expectedActiveRevision: null })
  assert.deepEqual([staleActive.status, staleActive.data.code, staleActive.data.activeRevision], [409, 'PROFILE_REVISION_CONFLICT', 2])

  const revisions = await api('GET', `/profiles/${id}/revisions`)
  assert.deepEqual(revisions.data.revisions.map(item => item.revision), [2, 1])
  assert.equal(revisions.data.revisions[0].body, undefined, 'summaries do not repeat bodies')
  assert.equal((await api('GET', `/profiles/${id}/revisions/1`)).data.body.role, '회의 준비 담당')
  const diff = await api('GET', `/profiles/${id}/diff?from=1&to=2`)
  assert.deepEqual(diff.data, { profileId: id, from: 1, to: 2, changes: [{ field: 'role', before: '회의 준비 담당', after: '일정 담당' }] })

  assert.equal((await api('POST', `/profiles/${id}/lifecycle`, { action: 'archive' })).data.lifecycle, 'archived')
  assert.deepEqual((await api('GET', '/profiles')).data.profiles, [])
  assert.equal((await api('GET', '/profiles?includeArchived=true')).data.profiles.length, 1)
  const locked = await api('PUT', `/profiles/${id}/draft`, { body: body(), expectedRevision: 2 })
  assert.deepEqual([locked.status, locked.data.code, locked.data.lifecycle], [409, 'PROFILE_LIFECYCLE_CONFLICT', 'archived'])
  assert.equal((await api('POST', `/profiles/${id}/lifecycle`, { action: 'delete' })).data.lifecycle, 'deleted')
  assert.equal((await api('GET', `/profiles/${id}`)).data.lifecycle, 'deleted')
  assert.equal((await api('GET', `/profiles/${id}/revisions`)).data.revisions.length, 2)
})

test('profile routes reject untrusted callers, bad bodies and unknown paths with {code, error}', async t => {
  const { open } = fixture(t)
  const store = open()
  const api = (...args) => call({ store }, ...args)
  const { data: { id } } = await api('POST', '/profiles', { body: body() })
  const cases = [
    [['POST', '/profiles', { body: body() }, { origin: 'https://example.com' }], 403, 'PROFILE_LOOPBACK_REQUIRED'],
    [['POST', '/profiles', { body: body() }, { 'sec-fetch-site': 'cross-site' }], 403, 'PROFILE_LOOPBACK_REQUIRED'],
    [['POST', '/profiles', { body: body() }, { host: 'evil.test:39218' }], 403, 'PROFILE_LOOPBACK_REQUIRED'],
    [['POST', '/profiles', JSON.stringify({ body: body() }), { 'content-type': 'text/plain' }], 415, 'CONTENT_TYPE'],
    [['POST', '/profiles', { body: body({ instructions: 'x'.repeat(70000) }) }], 413, 'BODY_TOO_LARGE'],
    [['POST', '/profiles', '{"body":'], 400, 'INVALID_JSON'],
    [['POST', '/profiles'], 400, 'PROFILE_HTTP_INPUT'],
    [['POST', '/profiles', { body: body(), owner: 'x' }], 400, 'PROFILE_HTTP_INPUT'],
    [['POST', '/profiles', { body: { name: 'A', systemPrompt: 'x' } }], 400, 'INVALID_PROFILE'],
    [['POST', '/profiles', { body: { name: '' } }], 400, 'INVALID_PROFILE'],
    [['PUT', `/profiles/${id}/draft`, { body: body() }], 400, 'PROFILE_HTTP_INPUT'],
    [['PUT', `/profiles/${id}/draft`, { body: body(), expectedRevision: '1' }], 400, 'INVALID_PROFILE_REVISION'],
    [['POST', `/profiles/${id}/activate`, { revision: 1 }], 400, 'PROFILE_HTTP_INPUT'],
    [['POST', `/profiles/${id}/lifecycle`, { action: 'purge' }], 400, 'INVALID_PROFILE_ACTION'],
    [['GET', `/profiles/${id}/diff?from=1`], 400, 'PROFILE_HTTP_INPUT'],
    [['GET', `/profiles/${id}/diff?from=0&to=1`], 400, 'PROFILE_HTTP_INPUT'],
    [['GET', `/profiles/${id}/diff?from=1&to=1&x=1`], 400, 'PROFILE_HTTP_INPUT'],
    [['GET', `/profiles/${id}/diff?from=1&to=4`], 404, 'PROFILE_REVISION_NOT_FOUND'],
    [['GET', '/profiles?includeArchived=yes'], 400, 'PROFILE_HTTP_INPUT'],
    [['GET', '/profiles?owner=x'], 400, 'PROFILE_HTTP_INPUT'],
    [['GET', `/profiles/${id}?x=1`], 400, 'PROFILE_HTTP_INPUT'],
    [['GET', '/profiles/prof-missing'], 404, 'PROFILE_NOT_FOUND'],
    [['GET', '/profiles/Bad.Id'], 404, 'PROFILE_ROUTE_NOT_FOUND'],
    [['GET', `/profiles/${id}/revisions/0`], 404, 'PROFILE_ROUTE_NOT_FOUND'],
    [['GET', `/profiles/${id}/revisions/7`], 404, 'PROFILE_REVISION_NOT_FOUND'],
    [['DELETE', `/profiles/${id}`], 404, 'PROFILE_ROUTE_NOT_FOUND'],
    [['POST', `/profiles/${id}/draft`, { body: body(), expectedRevision: 1 }], 404, 'PROFILE_ROUTE_NOT_FOUND'],
  ]
  for (const [args, status, code] of cases) {
    const result = await api(...args)
    assert.equal(result.handled, true, `${args[0]} ${args[1]}`)
    assert.deepEqual([result.status, result.data.code], [status, code], `${args[0]} ${args[1]} → ${JSON.stringify(result.data)}`)
    assert.equal(typeof result.data.error, 'string')
  }
  assert.equal(store.revisions(id).revisions.length, 1, 'no rejected request wrote a revision')
  assert.equal(store.list().profiles.length, 1)
  for (const pathname of ['/profilesx', '/profile', '/chat/send']) assert.equal((await api('GET', pathname)).handled, false)
})

test('auth, unavailable storage and owner switches are resolved before any write', async t => {
  const { open } = fixture(t)
  const ownerA = open('owner-a'), ownerB = open('owner-b')
  const denied = await call({ store: ownerA, ensureAuth: async () => { throw Object.assign(new Error('Codex ChatGPT login is required'), { code: 'LOGIN_REQUIRED', httpStatus: 401 }) } }, 'POST', '/profiles', { body: body() })
  assert.deepEqual([denied.status, denied.data.code], [401, 'LOGIN_REQUIRED'])
  assert.equal(ownerA.list().profiles.length, 0)
  const offline = await call({ store: () => null }, 'GET', '/profiles')
  assert.deepEqual([offline.status, offline.data.code], [503, 'PROFILE_STORE_UNAVAILABLE'])
  let current = ownerA
  const switched = await call({ store: () => current, ensureAuth: async () => { current = ownerB } }, 'POST', '/profiles', { body: body() })
  assert.equal(switched.status, 201)
  assert.equal(ownerA.list().profiles.length, 0)
  assert.equal(ownerB.get(switched.data.id).lifecycle, 'draft')
  const failing = await call({ store: { list() { throw new Error('SQLITE_IOERR secret=abc') } } }, 'GET', '/profiles')
  assert.deepEqual(failing.data, { code: 'PROFILE_ERROR', error: 'Profile request could not be completed' })
})

test('createProfileHttpHandler mounts like the other bridge handlers', async t => {
  const { open } = fixture(t)
  const handler = createProfileHttpHandler({ store: open() })
  const res = {
    status: null, headers: {}, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(value) { this.body = JSON.parse(value) },
  }
  const req = fakeRequest('POST', '/profiles', { body: body() })
  assert.equal(await handler(req, res, new URL(req.url, 'http://127.0.0.1:39218')), true)
  assert.equal(res.status, 201)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.match(res.headers['Content-Type'], /^application\/json/)
  assert.equal(res.body.profile.head.body.name, '리오')
  const other = fakeRequest('GET', '/chat/state')
  assert.equal(await handler(other, res, new URL(other.url, 'http://127.0.0.1:39218')), false)
})

test('POST /profiles/:id/duplicate makes a new draft and leaves the original unchanged', async t => {
  const { open } = fixture(t)
  const store = open()
  store.seedTemplates()
  const api = (...args) => call({ store }, ...args)
  const fromExample = await api('POST', '/profiles/review-verifier/duplicate')
  assert.equal(fromExample.status, 201)
  assert.match(fromExample.data.id, /^prof-/)
  assert.deepEqual([fromExample.data.revision, fromExample.data.profile.lifecycle, fromExample.data.profile.head.body.name], [1, 'draft', 'Review and Verification Agent 사본'])
  assert.deepEqual(fromExample.data.profile.source.map(item => [item.kind, item.origin, item.profileId, item.revision]), [['duplicate', 'template', 'review-verifier', 1]])
  assert.equal((await api('GET', '/profiles/review-verifier')).data.headRevision, 1)
  const listed = (await api('GET', '/profiles')).data.profiles.find(item => item.id === fromExample.data.id)
  assert.deepEqual([listed.latestSource.profileId, listed.reviewRequired], ['review-verifier', false])

  const { data: { id } } = await api('POST', '/profiles', { body: body() })
  await api('PUT', `/profiles/${id}/draft`, { body: body({ role: '일정 담당' }), expectedRevision: 1 })
  const chosen = await api('POST', `/profiles/${id}/duplicate`, { revision: 1, name: '리오 B' })
  assert.deepEqual([chosen.status, chosen.data.profile.head.body.name, chosen.data.profile.head.body.role], [201, '리오 B', '회의 준비 담당'])
  const latest = await api('POST', `/profiles/${id}/duplicate`, {})
  assert.deepEqual([latest.data.profile.head.body.name, latest.data.profile.head.body.role], ['리오 사본', '일정 담당'])

  await api('POST', `/profiles/${chosen.data.id}/lifecycle`, { action: 'delete' })
  const cases = [
    [['POST', `/profiles/${id}/duplicate`, { revision: '1' }], 400, 'INVALID_PROFILE_REVISION'],
    [['POST', `/profiles/${id}/duplicate`, { revision: 9 }], 404, 'PROFILE_REVISION_NOT_FOUND'],
    [['POST', `/profiles/${id}/duplicate`, { name: '' }], 400, 'INVALID_PROFILE'],
    [['POST', `/profiles/${id}/duplicate`, { owner: 'x' }], 400, 'PROFILE_HTTP_INPUT'],
    [['POST', `/profiles/${id}/duplicate`, { name: '리오' }, { origin: 'https://example.com' }], 403, 'PROFILE_LOOPBACK_REQUIRED'],
    [['POST', `/profiles/${chosen.data.id}/duplicate`], 409, 'PROFILE_LIFECYCLE_CONFLICT'],
    [['POST', '/profiles/prof-missing/duplicate'], 404, 'PROFILE_NOT_FOUND'],
    [['GET', `/profiles/${id}/duplicate`], 404, 'PROFILE_ROUTE_NOT_FOUND'],
  ]
  const count = store.list({ includeArchived: true }).profiles.length
  for (const [args, status, code] of cases) {
    const result = await api(...args)
    assert.deepEqual([result.status, result.data.code], [status, code], `${args[0]} ${args[1]} → ${JSON.stringify(result.data)}`)
  }
  assert.equal(store.list({ includeArchived: true }).profiles.length, count, 'no refused copy was written')
  assert.equal((await api('POST', `/profiles/${chosen.data.id}/duplicate`)).data.lifecycle, 'deleted')
})

// ---- 2-P: presets, Agent files, avatar photos ----
function pngChunk(type, data) {
  const head = Buffer.alloc(4), crc = Buffer.alloc(4), payload = Buffer.concat([Buffer.from(type, 'latin1'), data])
  head.writeUInt32BE(data.length)
  crc.writeUInt32BE(crc32(payload))
  return Buffer.concat([head, payload, crc])
}
function png(extra = []) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', header), ...extra, pngChunk('IDAT', deflateSync(Buffer.from([0, 10, 20, 30]))), pngChunk('IEND', Buffer.alloc(0))])
}

test('GET /profiles/tool-presets lists the starting ranges and POST /profiles takes one only for a new Agent', async t => {
  const { open } = fixture(t)
  const store = open()
  const api = (...args) => call({ store }, ...args)
  const presets = await api('GET', '/profiles/tool-presets')
  assert.equal(presets.status, 200)
  assert.equal(presets.data.defaultPreset, 'open')
  assert.deepEqual(presets.data.presets.map(item => [item.id, item.label]), [['read-only', '읽기만'], ['research', '리서치'], ['writing', '문서 작업'], ['coding', '코딩'], ['open', '제한 없음']])
  const plain = await api('POST', '/profiles', { body: body() })
  assert.equal(plain.data.profile.head.body.toolCeiling, undefined)
  const coding = await api('POST', '/profiles', { body: body(), toolPreset: 'coding' })
  assert.deepEqual([coding.status, coding.data.profile.head.body.toolCeiling], [201, TOOL_CEILING_PRESETS.find(item => item.id === 'coding').toolCeiling])
  for (const [args, status, code] of [
    [['POST', '/profiles', { body: body(), toolPreset: 'root' }], 400, 'INVALID_PROFILE'],
    [['POST', '/profiles', { toolPreset: 'coding' }], 400, 'PROFILE_HTTP_INPUT'],
    [['GET', '/profiles/tool-presets?x=1'], 400, 'PROFILE_HTTP_INPUT'],
    [['POST', '/profiles/tool-presets', {}], 404, 'PROFILE_ROUTE_NOT_FOUND'],
  ]) {
    const result = await api(...args)
    assert.deepEqual([result.status, result.data.code], [status, code], `${args[0]} ${args[1]}`)
  }
  assert.equal(store.list().profiles.length, 2)
})

test('POST /profiles/import previews without writing, then makes a draft that waits for review', async t => {
  const { open } = fixture(t)
  const store = open()
  const api = (...args) => call({ store }, ...args)
  const text = ['---', 'name: code-reviewer', 'description: Reviews diffs before merge.', 'tools: Read, Grep, Glob', 'api_key: sk-never-kept', '---', 'Review the diff.'].join('\n')
  const dry = await api('POST', '/profiles/import', { text, filename: 'code-reviewer.md', dryRun: true })
  assert.equal(dry.status, 200)
  assert.deepEqual([dry.data.dryRun, dry.data.format, dry.data.flavor, dry.data.body.name], [true, 'md', 'claude-code', 'code-reviewer'])
  assert.deepEqual(dry.data.preview.toolCeiling, { browser: 'none', files: 'read', terminal: 'none', network: 'off', mcp: 'none' })
  assert.deepEqual(dry.data.preview.unknownFields, ['api_key'])
  assert.ok(!JSON.stringify(dry.data).includes('sk-never-kept'))
  assert.equal(store.list({ includeArchived: true }).profiles.length, 0, 'a preview writes nothing')

  const made = await api('POST', '/profiles/import', { text })
  assert.equal(made.status, 201)
  assert.deepEqual([made.data.profile.lifecycle, made.data.profile.activeRevision, made.data.profile.reviewRequired], ['draft', null, true])
  assert.deepEqual(made.data.profile.source.map(({ at, ...rest }) => rest), [{ kind: 'import', format: 'md', flavor: 'claude-code', name: 'code-reviewer' }])
  assert.deepEqual(made.data.preview, dry.data.preview)
  assert.equal(made.data.profile.head.body.instructions, 'Review the diff.')

  // An EG-Desk file comes back as the same body, still as a new draft.
  const own = { name: '리오', role: '회의 준비 담당', personality: { tone: 'warm' }, toolCeiling: { browser: 'observe', files: 'read', terminal: 'none', network: 'on', mcp: 'none' } }
  const mine = await api('POST', '/profiles/import', { text: exportAgentMarkdown(own).text })
  assert.deepEqual([mine.status, mine.data.hash, mine.data.profile.source[0].flavor, mine.data.profile.reviewRequired], [201, profileHash(own), 'egdesk', true])

  const before = store.list({ includeArchived: true }).profiles.length
  for (const [payload, status, code] of [
    [{ text: 'name = "x"', filename: 'x.toml' }, 400, 'AGENT_FILE_FORMAT'],
    [{ text: '# no front matter' }, 400, 'AGENT_FILE_FORMAT'],
    [{ text: `---\nname: A\n---\n${'가'.repeat(8001)}` }, 400, 'AGENT_FILE_TOO_LONG'],
    [{ text, dryRun: 'yes' }, 400, 'PROFILE_HTTP_INPUT'],
    [{ text, owner: 'x' }, 400, 'PROFILE_HTTP_INPUT'],
    [{ filename: 'a.md' }, 400, 'PROFILE_HTTP_INPUT'],
    [{ text: 'x'.repeat(140 * 1024) }, 413, 'BODY_TOO_LARGE'],
  ]) {
    const result = await api('POST', '/profiles/import', payload)
    assert.deepEqual([result.status, result.data.code], [status, code], JSON.stringify(result.data))
    assert.equal(typeof result.data.error, 'string')
  }
  assert.equal(store.list({ includeArchived: true }).profiles.length, before, 'no refused file made a draft')
})

test('GET /profiles/:id/export writes the active or a chosen revision as .md or Codex .toml', async t => {
  const { open } = fixture(t)
  const store = open()
  store.seedTemplates()
  const api = (...args) => call({ store }, ...args)
  const { data: { id } } = await api('POST', '/profiles', { body: body() })
  await api('PUT', `/profiles/${id}/draft`, { body: body({ role: '일정 담당' }), expectedRevision: 1 })
  await api('POST', `/profiles/${id}/activate`, { revision: 1, expectedActiveRevision: null })
  const md = await api('GET', `/profiles/${id}/export`)
  assert.deepEqual([md.status, md.data.profileId, md.data.revision, md.data.format, md.data.filename, md.data.omitted], [200, id, 1, 'md', '리오.md', []])
  assert.match(md.data.text, /^---\nname: '리오'\ndescription: '회의 준비 담당'\n/)
  const chosen = await api('GET', `/profiles/${id}/export?format=codex-toml&revision=2`)
  assert.deepEqual([chosen.data.revision, chosen.data.format, chosen.data.filename, chosen.data.mediaType], [2, 'codex-toml', '리오.toml', 'application/toml; charset=utf-8'])
  assert.match(chosen.data.text, /^description = "일정 담당"$/m)
  assert.equal((await api('GET', '/profiles/review-verifier/export')).data.filename, 'review-and-verification-agent.md')
  await api('POST', `/profiles/${id}/lifecycle`, { action: 'delete' })
  for (const [url, status, code] of [
    [`/profiles/${id}/export`, 409, 'PROFILE_LIFECYCLE_CONFLICT'],
    ['/profiles/review-verifier/export?format=docx', 400, 'PROFILE_HTTP_INPUT'],
    ['/profiles/review-verifier/export?revision=0', 400, 'PROFILE_HTTP_INPUT'],
    ['/profiles/review-verifier/export?revision=5', 404, 'PROFILE_REVISION_NOT_FOUND'],
    ['/profiles/review-verifier/export?x=1', 400, 'PROFILE_HTTP_INPUT'],
    ['/profiles/prof-missing/export', 404, 'PROFILE_NOT_FOUND'],
  ]) {
    const result = await api('GET', url)
    assert.deepEqual([result.status, result.data.code], [status, code], url)
  }
})

test('avatar photos upload as plain base64, come back cleaned, and stay out of exported files', async t => {
  const { open } = fixture(t)
  const store = open()
  const api = (...args) => call({ store }, ...args)
  const original = png([pngChunk('tEXt', Buffer.from('Location\0home address'))])
  const put = await api('POST', '/profiles/avatar-images', { mediaType: 'image/png', imageBase64: original.toString('base64') })
  assert.equal(put.status, 201)
  assert.match(put.data.assetId, /^img-[0-9a-f]{64}$/)
  assert.deepEqual([put.data.width, put.data.height, put.data.unchanged], [1, 1, false])
  const again = await api('POST', '/profiles/avatar-images', { mediaType: 'image/png', imageBase64: original.toString('base64') })
  assert.deepEqual([again.status, again.data.assetId, again.data.unchanged], [200, put.data.assetId, true])
  const got = await api('GET', `/profiles/avatar-images/${put.data.assetId}`)
  assert.equal(got.status, 200)
  const bytes = Buffer.from(got.data.imageBase64, 'base64')
  assert.deepEqual([got.data.mediaType, got.data.byteSize, bytes.length], ['image/png', bytes.length, bytes.length])
  assert.ok(!bytes.includes('home address'))

  const photo = { kind: 'image', value: '리', color: AVATAR_PALETTE[0], assetId: put.data.assetId }
  const created = await api('POST', '/profiles', { body: body({ avatar: photo }) })
  assert.deepEqual([created.status, created.data.profile.head.body.avatar], [201, photo])
  const exported = await api('GET', `/profiles/${created.data.id}/export`)
  assert.deepEqual(exported.data.omitted, ['avatarImage'])
  assert.ok(!exported.data.text.includes(put.data.assetId))

  for (const [method, url, payload, status, code] of [
    ['POST', '/profiles/avatar-images', { mediaType: 'image/gif', imageBase64: 'R0lGODlh' }, 400, 'INVALID_PROFILE_IMAGE'],
    ['POST', '/profiles/avatar-images', { mediaType: 'image/jpeg', imageBase64: original.toString('base64') }, 400, 'INVALID_PROFILE_IMAGE'],
    ['POST', '/profiles/avatar-images', { mediaType: 'image/png', imageBase64: `data:image/png;base64,${original.toString('base64')}` }, 400, 'INVALID_PROFILE_IMAGE'],
    ['POST', '/profiles/avatar-images', { mediaType: 'image/png' }, 400, 'PROFILE_HTTP_INPUT'],
    ['POST', '/profiles/avatar-images', { mediaType: 'image/png', imageBase64: 'A'.repeat(800 * 1024) }, 413, 'BODY_TOO_LARGE'],
    ['POST', '/profiles/avatar-images', { mediaType: 'image/png', imageBase64: 'A'.repeat(720 * 1024) }, 413, 'PROFILE_IMAGE_TOO_LARGE'],
    ['GET', `/profiles/avatar-images/img-${'0'.repeat(64)}`, undefined, 404, 'PROFILE_ASSET_NOT_FOUND'],
    ['GET', '/profiles/avatar-images/img-xyz', undefined, 404, 'PROFILE_ROUTE_NOT_FOUND'],
    ['GET', '/profiles/avatar-images', undefined, 404, 'PROFILE_NOT_FOUND'],
    ['POST', '/profiles', { body: body({ avatar: { ...photo, assetId: `img-${'1'.repeat(64)}` } }) }, 400, 'PROFILE_ASSET_NOT_FOUND'],
  ]) {
    const result = await api(method, url, payload)
    assert.deepEqual([result.status, result.data.code], [status, code], `${method} ${url}`)
  }
  const crossSite = await api('POST', '/profiles/avatar-images', { mediaType: 'image/png', imageBase64: original.toString('base64') }, { origin: 'https://example.com' })
  assert.deepEqual([crossSite.status, crossSite.data.code], [403, 'PROFILE_LOOPBACK_REQUIRED'])
})
