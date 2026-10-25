import test from 'node:test'
import assert from 'node:assert/strict'
import { createEGDeskProfileTransfer, profileTransferFilename, PROFILE_IMPORT_MAX_BYTES, PROFILE_EXPORT_FORMATS } from '../overlay/resources/EGDeskProfileTransfer.sys.mjs'
import { exportAgentFile, importAgentFile } from '../helper/egdesk-profile-file.mjs'
import { profileHash } from '../helper/egdesk-profile-store.mjs'

// Real parser/export DTOs, but no server, socket, picker, file, or live store.
const source = () => ({ filename: 'reviewer.MD', text: [
  '---', 'name: reviewer', 'description: Reviews diffs.', 'tools: Read, Grep, MagicTool',
  'color: orange', 'api_key: sk-do-not-echo-this', 'permissionMode: bypassPermissions', '---', 'Review the diff.\r\n',
].join('\r\n') })
const previewPacket = input => ({ dryRun: true, ...importAgentFile(input.text, { filename: input.filename }) })
function draftPacket(input, id = 'prof-imported') {
  const parsed = importAgentFile(input.text, { filename: input.filename }), hash = profileHash(parsed.body)
  return { id, revision: 1, hash, unchanged: false, preview: parsed.preview,
    profile: { id, lifecycle: 'draft', activeRevision: null, active: null, reviewRequired: true, headRevision: 1, hasDraft: true,
      head: { profileId: id, revision: 1, hash, body: parsed.body } } }
}
const target = (extra = {}) => ({ profileId: 'prof-visible', revision: 7, format: 'md', ...extra })
function exportPacket(projection = target(), extra = {}) {
  const body = { name: '리오', role: '회의 준비', instructions: 'Be precise.', model: { engine: 'codex', modelId: 'gpt-6-astra', effort: 'max' } }
  return { profileId: projection.profileId, revision: projection.revision, hash: profileHash(body), ...exportAgentFile(body, projection.format), ...extra }
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const settle = async () => { for (let index = 0; index < 16; index++) await Promise.resolve() }
function fixture({ request, readText, saveText, onState } = {}) {
  const requests = [], reads = [], saves = [], writes = [], drafts = [], states = []
  const flow = createEGDeskProfileTransfer({
    request: async (path, options) => {
      requests.push({ path, options })
      if (request) return request(path, options, { drafts })
      if (path === '/profiles/import') {
        if (options.body.dryRun === true) return previewPacket(options.body)
        const packet = draftPacket(options.body, `prof-created-${drafts.length + 1}`)
        drafts.push(packet); return packet
      }
      const url = new URL(path, 'https://fixture.invalid')
      return exportPacket(target({ profileId: url.pathname.split('/')[2], revision: Number(url.searchParams.get('revision')), format: url.searchParams.get('format') }))
    },
    readText: async options => { reads.push(options); return readText ? readText(options) : source() },
    saveText: async options => {
      saves.push(options)
      if (saveText) return saveText(options, writes)
      // Simulates the host receiving explicit picker confirmation.
      if (!options.beginWrite()) return { cancelled: true }
      writes.push({ fileName: options.fileName, text: options.text }); return { saved: true }
    },
    onState: state => { states.push(state); onState?.(state) },
  })
  return { flow, actions: flow.bind(), requests, reads, saves, writes, drafts, states }
}

test('factory is inert, requires injected adapters, and exposes frozen binding-scoped actions', () => {
  assert.throws(() => createEGDeskProfileTransfer(), TypeError)
  const h = fixture()
  assert.deepEqual(PROFILE_EXPORT_FORMATS, ['md', 'codex-toml'])
  assert.equal(PROFILE_IMPORT_MAX_BYTES, 57344)
  assert.equal(h.flow.snapshot().status, 'idle')
  assert.ok(Object.isFrozen(h.actions)); assert.ok(Object.isFrozen(h.flow.snapshot()))
  assert.deepEqual([h.requests.length, h.reads.length, h.saves.length, h.states.length], [0, 0, 0, 0])
})

test('picked MD previews only, preserving unsupported-field and metadata-adjustment warnings', async () => {
  const h = fixture(), state = await h.actions.importFile(), expected = previewPacket(source())
  assert.equal(state.status, 'preview'); assert.equal(state.canConfirm, true)
  assert.deepEqual(state.source, source()); assert.deepEqual(state.body, expected.body); assert.deepEqual(state.preview, expected.preview)
  assert.deepEqual(state.preview.unknownFields, ['api_key', 'permissionMode'])
  assert.deepEqual(state.preview.unmappedTools, ['MagicTool'])
  assert.ok(state.preview.adjusted.some(item => item.field === 'color' && item.reason === 'not-in-palette'))
  assert.ok(state.preview.adjusted.some(item => item.field === 'toolCeiling' && item.reason === 'narrowed-by-tool-list'))
  assert.ok(!JSON.stringify(state.preview).includes('sk-do-not-echo-this'))
  assert.deepEqual(h.requests[0].options.body, { ...source(), dryRun: true })
  assert.deepEqual(Object.keys(h.requests[0].options).sort(), ['body', 'method', 'signal'])
  assert.equal(h.requests[0].options.method, 'POST'); assert.equal(h.requests[0].path, '/profiles/import')
  assert.deepEqual([h.drafts.length, h.saves.length, h.writes.length], [0, 0, 0])
  assert.deepEqual(h.states.map(value => value.status), ['reading', 'previewing', 'preview'])
  assert.deepEqual([h.reads[0].accept, h.reads[0].encoding, h.reads[0].maxBytes], ['.md', 'utf-8', 57344])
  assert.ok(Object.isFrozen(state.preview.adjusted)); assert.ok(Object.isFrozen(state.body)); assert.ok(Object.isFrozen(state.source))
})

test('explicit confirmation sends the EXACT original source once and creates only a review-required draft', async () => {
  const h = fixture(), input = source(), preview = await h.actions.previewImport(input)
  input.text = 'different'; input.filename = 'changed.md'
  const first = h.actions.confirmImport(preview.confirmation)
  assert.equal(h.actions.confirmImport(preview.confirmation), first)
  const result = await first
  assert.equal(result.status, 'imported'); assert.equal(result.canConfirm, false)
  assert.deepEqual(h.requests.map(call => call.options.body), [{ ...source(), dryRun: true }, { ...source(), dryRun: false }])
  assert.deepEqual(result.draft, { profileId: 'prof-created-1', revision: 1, hash: result.hash, lifecycle: 'draft', activeRevision: null, reviewRequired: true })
  assert.deepEqual(result.preview, preview.preview)
  assert.equal((await h.actions.confirmImport(preview.confirmation)), result)
  assert.equal((await h.actions.previewImport(source())).status, 'imported', 'a replay of the same source reuses the receipt')
  assert.equal(h.drafts.length, 1); assert.equal(h.requests.length, 2)
  assert.deepEqual([h.reads.length, h.saves.length, h.writes.length], [0, 0, 0])
  assert.ok(h.requests.every(call => call.path === '/profiles/import'), 'no create/activate/room-assignment endpoints')
})

test('cancel at the ready preview revokes confirmation and creates nothing', async () => {
  const h = fixture(), preview = await h.actions.previewImport(source())
  assert.equal(h.actions.cancel().status, 'cancelled')
  assert.equal((await h.actions.confirmImport(preview.confirmation)).code, 'PROFILE_IMPORT_CONFIRMATION_STALE')
  assert.equal(h.requests.length, 1); assert.equal(h.drafts.length, 0)
})

test('only the current opaque preview confirmation can create a draft', async () => {
  const h = fixture(), first = await h.actions.previewImport(source())
  for (const token of [undefined, true, { ...first.confirmation }]) {
    assert.equal((await h.actions.confirmImport(token)).status, 'ignored')
  }
  const next = { ...source(), text: source().text.replace('reviewer', 'writer') }
  const second = await h.actions.previewImport(next)
  assert.equal((await h.actions.confirmImport(first.confirmation)).status, 'ignored')
  assert.equal(h.flow.snapshot(), second)
  const other = fixture(), foreign = await other.actions.previewImport(next)
  assert.equal((await h.actions.confirmImport(foreign.confirmation)).status, 'ignored')
  assert.equal((await h.actions.confirmImport(second.confirmation)).status, 'imported')
  assert.equal(h.drafts.length, 1); assert.equal(h.drafts[0].profile.head.body.name, 'writer')
})

test('MD import bounds are UTF-8 bytes, with exact-boundary acceptance and no truncation', async () => {
  // Unknown front-matter values count towards the file size even though omitted.
  const prefix = '---\nname: A\nunsupported: ', suffix = '\n---\nReview.'
  const text = prefix + 'a'.repeat(PROFILE_IMPORT_MAX_BYTES - Buffer.byteLength(prefix + suffix)) + suffix
  const h = fixture(), state = await h.actions.previewImport({ text, filename: 'boundary.md' })
  assert.equal(Buffer.byteLength(text), PROFILE_IMPORT_MAX_BYTES); assert.equal(state.status, 'preview')
  assert.equal(h.requests[0].options.body.text, text)
  for (const tooLarge of [text + 'a', '가'.repeat(20000), '😀'.repeat(15000)]) {
    const h = fixture(), result = await h.actions.previewImport({ text: tooLarge, filename: 'large.md' })
    assert.equal(result.code, 'PROFILE_IMPORT_TOO_LARGE'); assert.equal(result.source.text, tooLarge)
    assert.equal(result.recoverable, true); assert.equal(h.requests.length, 0)
  }
})

test('TOML/non-MD, empty, path-like, and ill-formed Unicode inputs never reach the backend', async () => {
  for (const input of [
    { ...source(), filename: 'agent.toml' }, { ...source(), filename: 'agent.ToMl ' }, { ...source(), filename: 'agent.txt' },
    { ...source(), filename: '../agent.md' }, { ...source(), filename: 'C:\\agent.md' }, { ...source(), filename: 'a\0.md' },
    { ...source(), filename: 'a'.repeat(253) + '.md' }, { ...source(), text: '' }, { ...source(), text: ' \n' },
    { ...source(), text: 'bad\ud800text' }, { ...source(), text: 'bad\udc00text' },
    { ...source(), filename: 'bad\ud800.md' }, null,
  ]) {
    const h = fixture(), state = await h.actions.previewImport(input)
    assert.equal(state.status, 'failed', JSON.stringify(input)); assert.equal(state.canConfirm, false)
    assert.equal(h.requests.length, 0); assert.equal(h.drafts.length, 0)
  }
  const h = fixture()
  assert.equal((await h.actions.previewImport({ text: source().text })).source.filename, 'agent.md')
})

test('preview errors retain the input, may be explicitly retried, and never create drafts', async () => {
  let failures = 1
  const h = fixture({ request: (path, options) => {
    if (failures--) throw Object.assign(new Error('offline'), { code: 'OFFLINE' })
    return previewPacket(options.body)
  } })
  const failed = await h.actions.previewImport(source())
  assert.equal(failed.status, 'failed'); assert.equal(failed.code, 'OFFLINE'); assert.equal(failed.recoverable, true)
  assert.deepEqual(failed.source, source()); assert.equal(failed.canConfirm, false)
  assert.equal((await h.actions.previewImport(failed.source)).status, 'preview')
  assert.equal(h.requests.length, 2); assert.equal(h.drafts.length, 0)
})

test('read failures retain earlier input, and picker cancellation performs no request or creation', async () => {
  const h = fixture({ readText: () => { throw new Error('UTF-8 decoding failed') } })
  await h.actions.previewImport(source())
  const failed = await h.actions.importFile()
  assert.equal(failed.status, 'failed'); assert.deepEqual(failed.source, source())
  assert.equal(failed.canConfirm, false); assert.equal(h.requests.length, 1)
  const cancelled = fixture({ readText: () => ({ cancelled: true }) })
  assert.equal((await cancelled.actions.importFile()).status, 'cancelled')
  assert.deepEqual([cancelled.requests.length, cancelled.drafts.length, cancelled.writes.length], [0, 0, 0])
})

test('malformed preview DTOs cannot become confirmable', async () => {
  const mutations = [p => { p.dryRun = false }, p => { p.format = 'toml' }, p => { p.preview.reviewRequired = false },
    p => { p.preview.unknownFields = null }, p => { p.preview.unknownFieldCount = 0 }, p => { p.preview.adjusted = [null] },
    p => { p.body = null }, p => { p.flavor = 'unrecognized' }, p => { p.preview.instructionsChars++ },
    p => { p.preview.role = 'different' }, p => { p.preview.model = { engine: 'other' } }, p => { p.preview.toolCeiling = null }]
  for (const mutate of mutations) {
    const packet = previewPacket(source()); mutate(packet)
    const h = fixture({ request: () => packet }), result = await h.actions.previewImport(source())
    assert.equal(result.code, 'PROFILE_IMPORT_RESPONSE_INVALID'); assert.equal(result.canConfirm, false)
    assert.deepEqual(result.source, source()); assert.equal(h.drafts.length, 0)
  }
})

test('preview DTO and caller mutation cannot change the confirmed original or its review', async () => {
  const packet = previewPacket(source())
  const h = fixture({ request: (path, options) => options.body.dryRun ? packet : draftPacket(options.body) })
  const preview = await h.actions.previewImport(source())
  packet.body.name = 'mutated'; packet.preview.unknownFields.length = 0; packet.preview.adjusted.length = 0
  assert.equal(preview.body.name, 'reviewer'); assert.equal(preview.preview.unknownFields.length, 2)
  assert.throws(() => { preview.source.text = 'mutated' }, TypeError)
  assert.equal((await h.actions.confirmImport(preview.confirmation)).status, 'imported')
})

test('externally edited EG-Desk metadata warnings are kept through preview and creation', async () => {
  const own = exportAgentFile({ name: '리오', personality: { traits: ['calm'], speechNotes: 'Keep calm.' }, instructions: 'Original.' })
  const input = { filename: own.filename, text: own.text.replace('# 사용자 지침', '# Modified instructions') }
  const h = fixture(), preview = await h.actions.previewImport(input)
  assert.ok(preview.preview.adjusted.some(item => item.field === 'instructions' && item.reason === 'edited-outside-egdesk'))
  const receipt = await h.actions.confirmImport(preview.confirmation)
  assert.deepEqual(receipt.preview.adjusted, preview.preview.adjusted)
})

test('duplicate import/preview clicks join the in-flight operation without retargeting', async () => {
  const read = deferred(), response = deferred(), h = fixture({ readText: () => read.promise, request: () => response.promise })
  const first = h.actions.importFile()
  assert.equal(h.actions.importFile(), first)
  assert.equal(h.actions.previewImport({ text: 'other', filename: 'other.md' }), first)
  read.resolve(source()); await settle()
  assert.equal(h.actions.importFile(), first); assert.equal(h.reads.length, 1); assert.equal(h.requests.length, 1)
  response.resolve(previewPacket(source())); assert.equal((await first).source.text, source().text)
})

test('explicit, definite commit rejection is recoverable but never automatically retried', async () => {
  let rejected = true
  const h = fixture({ request: (path, options, { drafts }) => {
    if (options.body.dryRun) return previewPacket(options.body)
    if (rejected) { rejected = false; throw Object.assign(new Error('limit'), { code: 'PROFILE_LIMIT', httpStatus: 409 }) }
    const packet = draftPacket(options.body); drafts.push(packet); return packet
  } })
  const preview = await h.actions.previewImport(source()), failed = await h.actions.confirmImport(preview.confirmation)
  assert.equal(failed.status, 'failed'); assert.equal(failed.recoverable, true); assert.equal(failed.canConfirm, true)
  assert.deepEqual(failed.source, source()); assert.deepEqual(failed.preview, preview.preview)
  await settle(); assert.equal(h.requests.length, 2); assert.equal(h.drafts.length, 0)
  assert.equal((await h.actions.confirmImport(failed.confirmation)).status, 'imported')
  assert.equal(h.requests.length, 3); assert.equal(h.drafts.length, 1)
})

test('lost, timed-out and 5xx commit receipts stay unknown and cannot be blindly replayed', async () => {
  for (const error of [new Error('lost reply'), { code: 'PROFILE_ERROR', httpStatus: 500 }, { code: 'TIMEOUT', httpStatus: 408 }, { name: 'AbortError' }]) {
    const h = fixture({ request: (path, options, { drafts }) => {
      if (options.body.dryRun) return previewPacket(options.body)
      drafts.push(draftPacket(options.body)); throw error
    } })
    const preview = await h.actions.previewImport(source()), result = await h.actions.confirmImport(preview.confirmation)
    assert.equal(result.status, 'unknown'); assert.equal(result.code, 'PROFILE_IMPORT_RECEIPT_UNCONFIRMED')
    assert.equal(result.canConfirm, false); assert.equal(result.recoverable, false)
    assert.equal((await h.actions.confirmImport(preview.confirmation)).status, 'unknown')
    assert.equal((await h.actions.previewImport(source())).status, 'unknown')
    assert.equal(h.requests.length, 2); assert.equal(h.drafts.length, 1)
  }
})

test('invalid, activated, mismatched-body or changed-warning commit receipts never claim success', async () => {
  const mutations = [p => { p.id = '../invalid' }, p => { p.revision = 2 }, p => { p.hash = 'bad' }, p => { p.unchanged = true },
    p => { p.profile.lifecycle = 'active' }, p => { p.profile.activeRevision = 1 }, p => { p.profile.reviewRequired = false },
    p => { p.profile.head.body.name = 'different' }, p => { p.preview.adjusted = [] }, p => { p.profile.head.hash = 'a'.repeat(64) },
    p => { p.id = p.profile.id = p.profile.head.profileId = 123 }]
  for (const mutate of mutations) {
    const h = fixture({ request: (path, options) => {
      if (options.body.dryRun) return previewPacket(options.body)
      const packet = draftPacket(options.body); mutate(packet); return packet
    } })
    const preview = await h.actions.previewImport(source()), result = await h.actions.confirmImport(preview.confirmation)
    assert.equal(result.status, 'unknown'); assert.equal(result.draft, null)
    await h.actions.confirmImport(preview.confirmation); assert.equal(h.requests.length, 2)
  }
})

test('cancelling during a commit does not claim zero creations and ignores its eventual receipt', async () => {
  const receipt = deferred()
  const h = fixture({ request: (path, options) => options.body.dryRun ? previewPacket(options.body) : receipt.promise })
  const preview = await h.actions.previewImport(source()), pending = h.actions.confirmImport(preview.confirmation)
  assert.equal(h.actions.cancel().status, 'unknown'); assert.equal((await pending).status, 'unknown')
  assert.equal(h.requests[1].options.signal.aborted, true)
  const count = h.states.length
  receipt.resolve(draftPacket(source())); await settle()
  assert.equal(h.states.length, count); assert.equal(h.flow.snapshot().status, 'unknown')
  assert.equal((await h.actions.previewImport(source())).status, 'unknown'); assert.equal(h.requests.length, 2)
})

test('closing a completed/unknown transfer preserves its receipt, including after repeated cancel clicks', async () => {
  for (const unknown of [false, true]) {
    const h = fixture({ request: (path, options) => {
      if (options.body.dryRun) return previewPacket(options.body)
      if (unknown) throw new Error('lost receipt')
      return draftPacket(options.body)
    } })
    const preview = await h.actions.previewImport(source()), result = await h.actions.confirmImport(preview.confirmation)
    assert.equal(h.actions.cancel(), result); assert.equal(h.actions.cancel(), result)
    assert.equal(result.status, unknown ? 'unknown' : 'imported')
    assert.equal((await h.actions.previewImport(source())).status, result.status); assert.equal(h.requests.length, 2)
  }
  for (const unknown of [false, true]) {
    const h = fixture({ saveText: options => { options.beginWrite(); if (unknown) throw new Error('lost receipt'); return { saved: true } } })
    const result = await h.actions.exportProfile(target())
    assert.equal(h.actions.cancel(), result); assert.equal(h.actions.cancel(), result)
    assert.equal(result.status, unknown ? 'unknown' : 'saved')
  }
})

test('safe filenames preserve format while removing paths, controls, reserved devices, and excess bytes', () => {
  assert.equal(profileTransferFilename('회의 자료.md'), '회의 자료.md')
  assert.equal(profileTransferFilename('agent.MD.toml.MD', 'codex-toml'), 'agent.toml')
  assert.equal(profileTransferFilename('CON.md'), 'agent-CON.md')
  assert.equal(profileTransferFilename('NUL.txt', 'codex-toml'), 'agent-NUL.txt.toml')
  assert.equal(profileTransferFilename('LPT¹.md'), 'agent-LPT¹.md')
  assert.equal(profileTransferFilename(' ... '), 'agent.md')
  assert.throws(() => profileTransferFilename('agent', 'json'), TypeError)
  for (const filename of ['../../unsafe\\name:*?<>|"\n.md', '\u202eevil.md', '\u009ffile.md', '\ud800bad.md', '😀'.repeat(1000), '가'.repeat(1000)]) {
    for (const format of PROFILE_EXPORT_FORMATS) {
      const name = profileTransferFilename(filename, format)
      assert.ok(name.endsWith(format === 'md' ? '.md' : '.toml'))
      assert.doesNotMatch(name, /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/)
      assert.doesNotMatch(name, /[\uD800-\uDFFF]/u); assert.ok(!name.startsWith('.'))
      assert.ok(Buffer.byteLength(name) <= 200)
    }
  }
})

for (const format of PROFILE_EXPORT_FORMATS) test(`export ${format} pins the clicked profile and revision and writes only after picker confirmation`, async () => {
  const response = deferred(), packet = exportPacket(target({ format }), { omitted: ['avatarImage'] })
  const h = fixture({ request: () => response.promise }), clicked = target({ format, hash: packet.hash })
  const pending = h.actions.exportProfile(clicked)
  clicked.profileId = 'another'; clicked.revision = 99; clicked.format = 'codex-toml'; clicked.hash = 'b'.repeat(64)
  assert.equal(h.requests[0].path, `/profiles/prof-visible/export?format=${format}&revision=7`)
  assert.deepEqual(Object.keys(h.requests[0].options).sort(), ['method', 'signal']); assert.equal(h.requests[0].options.method, 'GET')
  response.resolve(packet)
  const result = await pending
  assert.equal(result.status, 'saved'); assert.deepEqual([result.profileId, result.revision, result.format], ['prof-visible', 7, format])
  assert.deepEqual(result.omitted, ['avatarImage']); assert.equal(h.saves[0].contentType, packet.mediaType)
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].text, packet.text)
  assert.deepEqual(h.states.map(s => s.status), ['fetching', 'saving', 'saved']); assert.equal(h.drafts.length, 0)
})

test('invalid or unfixed export targets cannot fetch the current active/head by accident', async () => {
  for (const input of [undefined, {}, target({ profileId: '../a' }), target({ profileId: 'A' }), target({ profileId: 'a'.repeat(81) }),
    target({ revision: undefined }), target({ revision: null }), target({ revision: '7' }), target({ revision: 0 }),
    target({ revision: 1.5 }), target({ revision: 1000000000 }), target({ format: 'toml' }), target({ hash: 'bad' }),
    target({ format: null }), target({ hash: {} }), target({ revision: {} }), target({ format: {} })]) {
    const h = fixture(), result = await h.actions.exportProfile(input)
    assert.equal(result.code, 'PROFILE_EXPORT_INPUT'); assert.equal(h.requests.length, 0); assert.equal(h.saves.length, 0)
    if (input && typeof input === 'object') assert.ok(!Object.isFrozen(input))
    for (const value of Object.values(input ?? {})) if (value && typeof value === 'object') assert.ok(!Object.isFrozen(value))
  }
})

test('identity, revision, format, hash, media-type and malformed export DTO checks precede the picker', async () => {
  const good = exportPacket(), input = target({ hash: good.hash })
  for (const extra of [{ profileId: 'prof-other' }, { revision: 8 }, { revision: '7' }, { format: 'codex-toml' }, { hash: 'a'.repeat(64) },
    { hash: 'invalid' }, { mediaType: 'text/html' }, { filename: '' }, { text: null }, { text: '\ud800' }, { omitted: null }, { omitted: [1] }]) {
    const h = fixture({ request: () => ({ ...good, ...extra }) }), result = await h.actions.exportProfile(input)
    assert.equal(result.code, 'PROFILE_EXPORT_RESPONSE_INVALID', JSON.stringify(extra))
    assert.equal(result.status, 'failed'); assert.equal(h.saves.length, 0); assert.equal(h.writes.length, 0)
  }
})

test('export DTO is snapshotted before waiting for a picker and unsafe names never become paths', async () => {
  const wait = deferred(), packet = exportPacket(target(), { filename: '../../CON.md', omitted: ['avatarImage'] })
  const originalText = packet.text
  const h = fixture({ request: () => packet, saveText: async (options, writes) => {
    await wait.promise
    if (!options.beginWrite()) return { cancelled: true }
    writes.push({ text: options.text, fileName: options.fileName }); return { saved: true }
  } })
  const pending = h.actions.exportProfile(target()); await settle()
  packet.text = 'mutated'; packet.filename = '/tmp/unsafe'; packet.omitted.length = 0
  wait.resolve()
  const result = await pending
  assert.equal(result.status, 'saved'); assert.equal(h.writes[0].text, originalText)
  assert.doesNotMatch(h.writes[0].fileName, /[/\\]/); assert.deepEqual(result.omitted, ['avatarImage'])
})

test('picker cancellation produces zero writes; errors before a write never claim saved', async () => {
  const cancelled = fixture({ saveText: () => ({ cancelled: true }) })
  assert.equal((await cancelled.actions.exportProfile(target())).status, 'cancelled')
  assert.equal(cancelled.writes.length, 0)
  const failed = fixture({ saveText: () => { throw new Error('picker unavailable') } })
  assert.equal((await failed.actions.exportProfile(target())).status, 'failed')
  assert.equal(failed.writes.length, 0); await settle(); assert.equal(failed.saves.length, 1)
})

test('save receipts require the one-shot beginWrite gate and failures after writing remain unknown', async () => {
  for (const receipt of [{ saved: true }, { saved: true, cancelled: true }, {}, null, { cancelled: true }]) {
    for (const begin of [false, true]) {
      const h = fixture({ saveText: options => {
        if (begin) { assert.equal(options.beginWrite(), true); assert.equal(options.beginWrite(), false) }
        return receipt
      } })
      const result = await h.actions.exportProfile(target())
      const expected = begin && receipt?.saved === true && receipt.cancelled !== true ? 'saved'
        : !begin && receipt?.cancelled === true && receipt.saved !== true ? 'cancelled'
          : begin || receipt?.saved === true ? 'unknown' : 'failed'
      assert.equal(result.status, expected, JSON.stringify({ begin, receipt }))
    }
  }
  const h = fixture({ saveText: options => { options.beginWrite(); throw new Error('disk failure') } })
  assert.equal((await h.actions.exportProfile(target())).status, 'unknown')
  await settle(); assert.equal(h.saves.length, 1)
})

test('duplicate export clicks share one request, picker and write', async () => {
  const response = deferred(), saved = deferred()
  const h = fixture({ request: () => response.promise, saveText: options => { assert.equal(options.beginWrite(), true); return saved.promise } })
  const pending = h.actions.exportProfile(target())
  assert.equal(h.actions.exportProfile(target({ profileId: 'other', revision: 9 })), pending)
  response.resolve(exportPacket()); await settle()
  assert.equal(h.actions.exportProfile(target()), pending); assert.equal(h.saves.length, 1); assert.equal(h.requests.length, 1)
  saved.resolve({ saved: true }); assert.equal((await pending).status, 'saved')
})

test('cancel during an unresponsive read resolves promptly and late file data cannot preview', async () => {
  const read = deferred(), h = fixture({ readText: () => read.promise }), pending = h.actions.importFile()
  assert.equal(h.actions.cancel().status, 'cancelled'); assert.equal((await pending).status, 'cancelled')
  assert.equal(h.reads[0].signal.aborted, true)
  read.resolve(source()); await settle(); assert.equal(h.requests.length, 0); assert.equal(h.drafts.length, 0)
})

for (const operation of ['preview', 'export']) test(`cancel during ${operation} fetch prevents late callbacks and writes`, async () => {
  const response = deferred(), h = fixture({ request: () => response.promise })
  const pending = operation === 'preview' ? h.actions.previewImport(source()) : h.actions.exportProfile(target())
  assert.equal(h.actions.cancel().status, 'cancelled'); assert.equal((await pending).status, 'cancelled')
  const count = h.states.length
  response.resolve(operation === 'preview' ? previewPacket(source()) : exportPacket()); await settle()
  assert.equal(h.states.length, count); assert.equal(h.requests[0].options.signal.aborted, true)
  assert.equal(h.saves.length, 0); assert.equal(h.drafts.length, 0)
})

test('cancel at the picker fences a late write; cancelling after beginWrite cannot claim zero writes', async () => {
  for (const begin of [false, true]) {
    const wait = deferred()
    const h = fixture({ saveText: options => { if (begin) assert.equal(options.beginWrite(), true); return wait.promise } })
    const pending = h.actions.exportProfile(target()); await settle()
    assert.equal(h.actions.cancel().status, begin ? 'unknown' : 'cancelled')
    assert.equal((await pending).status, begin ? 'unknown' : 'cancelled')
    assert.equal(h.saves[0].beginWrite(), false); assert.equal(h.saves[0].signal.aborted, true)
    const count = h.states.length
    wait.resolve({ saved: true }); await settle(); assert.equal(h.states.length, count)
  }
})

for (const stage of ['read', 'preview', 'commit', 'fetch', 'picker']) test(`account/view rebinding at ${stage} isolates new state and revokes all old actions`, async () => {
  const late = deferred()
  const h = fixture({
    readText: () => stage === 'read' ? late.promise : source(),
    request: (path, options) => {
      if (path === '/profiles/import') {
        if (options.body.dryRun) return stage === 'preview' ? late.promise : previewPacket(options.body)
        return late.promise
      }
      return stage === 'fetch' ? late.promise : exportPacket()
    },
    saveText: () => late.promise,
  })
  let pending, confirmation
  if (stage === 'commit') {
    const preview = await h.actions.previewImport(source()); confirmation = preview.confirmation
    pending = h.actions.confirmImport(confirmation)
  } else pending = ['fetch', 'picker'].includes(stage) ? h.actions.exportProfile(target()) : h.actions.importFile()
  await settle()
  h.flow.invalidate()
  const newActions = h.flow.bind(), idle = h.flow.snapshot()
  assert.notEqual(newActions.binding, h.actions.binding); assert.equal(idle.status, 'idle'); assert.equal(idle.source, null)
  assert.equal((await pending).status, stage === 'commit' ? 'unknown' : 'stale')
  const count = h.states.length, calls = h.requests.length
  for (const oldCall of [() => h.actions.previewImport(source()), () => h.actions.importFile(), () => h.actions.confirmImport(confirmation),
    () => h.actions.exportProfile(target()), () => h.actions.cancel()]) assert.equal((await oldCall()).status, 'stale')
  assert.equal(h.requests.length, calls); assert.equal(h.states.length, count)
  if (stage === 'picker') assert.equal(h.saves[0].beginWrite(), false)
  late.resolve(stage === 'read' ? source() : stage === 'commit' ? draftPacket(source()) : stage === 'picker' ? { saved: true }
    : stage === 'fetch' ? exportPacket() : previewPacket(source()))
  await settle()
  assert.equal(h.states.length, count); assert.equal(h.flow.snapshot(), idle)
})

test('old preview/commit responses cannot overwrite a new binding already showing another preview', async () => {
  for (const commit of [false, true]) {
    const old = deferred(); let first = true
    const h = fixture({ request: (path, options) => {
      if (first && (!commit || options.body.dryRun === false)) { first = false; return old.promise }
      return previewPacket(options.body)
    } })
    const pre = commit ? await h.actions.previewImport(source()) : null
    const pending = commit ? h.actions.confirmImport(pre.confirmation) : h.actions.previewImport(source())
    h.flow.invalidate()
    const current = h.flow.bind(), input = { ...source(), text: source().text.replace('reviewer', 'new-agent') }
    const view = await current.previewImport(input), count = h.states.length
    old.resolve(commit ? draftPacket(source()) : previewPacket(source())); await pending; await settle()
    assert.equal(h.flow.snapshot(), view); assert.equal(view.body.name, 'new-agent'); assert.equal(h.states.length, count)
  }
})

test('dispose clears retained source and leaves old or newly requested actions inert', async () => {
  const wait = deferred(), h = fixture({ readText: () => wait.promise }), pending = h.actions.importFile()
  const disposed = h.flow.dispose()
  assert.equal(disposed.status, 'disposed'); assert.equal(disposed.source, null)
  assert.equal((await pending).status, 'stale'); assert.equal(h.flow.dispose(), disposed); assert.equal(h.flow.invalidate(), disposed)
  const count = h.states.length
  assert.equal((await h.actions.importFile()).status, 'disposed')
  assert.equal((await h.flow.bind().exportProfile(target())).status, 'disposed')
  wait.resolve(source()); await settle(); assert.equal(h.states.length, count); assert.equal(h.requests.length, 0)
})

test('onState reentrancy can cancel before side effects; callback exceptions do not change receipts', async () => {
  for (const phase of ['reading', 'previewing', 'committing', 'fetching', 'saving']) {
    let actions
    const h = fixture({ onState: state => { if (state.status === phase) actions.cancel() } }); actions = h.actions
    let result
    if (phase === 'committing') {
      const preview = await actions.previewImport(source()); result = await actions.confirmImport(preview.confirmation)
    } else result = ['fetching', 'saving'].includes(phase) ? await actions.exportProfile(target()) : await actions.importFile()
    assert.equal(result.status, 'cancelled'); assert.equal(h.drafts.length, 0); assert.equal(h.writes.length, 0)
    if (phase === 'reading') assert.equal(h.reads.length, 0)
    if (phase === 'previewing' || phase === 'fetching') assert.equal(h.requests.length, 0)
    if (phase === 'committing') assert.equal(h.requests.length, 1)
    if (phase === 'saving') assert.equal(h.saves.length, 0)
  }
  const h = fixture({ onState: () => { throw new Error('render failed') } })
  const preview = await h.actions.previewImport(source())
  assert.equal((await h.actions.confirmImport(preview.confirmation)).status, 'imported')
  assert.equal((await h.actions.exportProfile(target())).status, 'saved')
  assert.equal(h.drafts.length, 1); assert.equal(h.writes.length, 1)
})
