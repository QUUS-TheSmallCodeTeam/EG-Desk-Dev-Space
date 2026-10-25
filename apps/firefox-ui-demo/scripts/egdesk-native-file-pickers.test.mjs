import test from 'node:test'
import assert from 'node:assert/strict'
import { createEGDeskTextFilePickers } from '../overlay/resources/EGDeskNativeFilePickers.sys.mjs'
import { createEGDeskProfileTransfer } from '../overlay/resources/EGDeskProfileTransfer.sys.mjs'
import { createEGDeskBoardExport } from '../overlay/resources/EGDeskBoardExport.sys.mjs'

// All files, pickers, stat/read/write effects, collisions and races are in
// memory. No native UI, filesystem APIs, provider, helper server or sockets.
const encoder = new TextEncoder()
const OPEN = '/private/native-fixture/chosen.md', SAVE = '/private/native-fixture/chosen-output.md'
const text = '\ufeff---\r\nname: reviewer\r\n---\rReview.\n끝😀\r\n'
const readOptions = extra => ({ accept: '.md', encoding: 'utf-8', maxBytes: 56 * 1024, ...extra })
const saveOptions = extra => ({ fileName: 'suggested.md', text, contentType: 'text/markdown; charset=utf-8', beginWrite: () => true, ...extra })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }
function fixture(overrides = {}) {
  const files = new Map([[OPEN, encoder.encode(text)]]), calls = [], writes = []
  const callbacks = {
    pickOpenFile: options => { calls.push(['open', options]); return { path: OPEN, filename: 'chosen.md' } },
    pickSaveFile: options => { calls.push(['save', options]); return { path: SAVE, filename: 'chosen-output.md' } },
    stat: (path, options) => { calls.push(['stat', path, options]); return { type: 'regular', size: files.get(path).byteLength } },
    readBytes: (path, options) => { calls.push(['read', path, options]); return files.get(path).slice(0, options.maxBytes) },
    writeNewFile: (path, bytes, options) => {
      calls.push(['write', path, options])
      // Simulated OS exclusive-create primitive: absence check and reservation
      // form one synchronous operation. Never a precheck then async overwrite.
      if (files.has(path)) throw Object.assign(new Error(`exists: ${path}`), { name: 'NoModificationAllowedError' })
      files.set(path, bytes.slice()); writes.push({ path, bytes: bytes.slice() }); return bytes.byteLength
    },
  }
  const injected = Object.fromEntries(Object.entries(callbacks).map(([key, normal]) => [key,
    (...args) => overrides[key] ? overrides[key](...args, { files, calls, writes, normal }) : normal(...args)]))
  return { files, calls, writes, callbacks: injected, pickers: createEGDeskTextFilePickers(injected) }
}
const assertFailure = async (promise, code) => assert.rejects(promise, error => {
  assert.equal(error.code, code)
  assert.doesNotMatch(String(error), /native-fixture|\/private\/|sensitive-native-error/)
  assert.equal(Object.hasOwn(error, 'path'), false); assert.equal(Object.hasOwn(error, 'cause'), false)
  return true
})

test('factory requires five injected functions, is inert, and does not redefine the existing native picker factory', () => {
  assert.throws(() => createEGDeskTextFilePickers(), TypeError)
  const h = fixture()
  for (const name of Object.keys(h.callbacks)) assert.throws(() => createEGDeskTextFilePickers({ ...h.callbacks, [name]: null }), TypeError)
  assert.deepEqual(Object.keys(h.pickers).sort(), ['readText', 'saveText'])
  assert.ok(Object.isFrozen(h.pickers)); assert.equal(h.calls.length, 0)
})

test('read stat precedes bounded bytes; BOM, all line endings and Unicode survive exactly', async () => {
  const h = fixture(), result = await h.pickers.readText(readOptions())
  assert.deepEqual(result, { text, filename: 'chosen.md' }); assert.ok(Object.isFrozen(result))
  assert.deepEqual(h.calls.map(call => call[0]), ['open', 'stat', 'read'])
  assert.equal(h.calls[2][2].maxBytes, 57345)
  assert.deepEqual(Object.keys(result).sort(), ['filename', 'text'])
  assert.equal(h.writes.length, 0); assert.doesNotMatch(JSON.stringify(result), /native-fixture/)
})

test('read options require a bounded size and UTF-8 before any picker or read', async () => {
  for (const options of [undefined, null, {}, readOptions({ maxBytes: undefined }), readOptions({ maxBytes: -1 }), readOptions({ maxBytes: 1.5 }),
    readOptions({ maxBytes: NaN }), readOptions({ maxBytes: Infinity }), readOptions({ maxBytes: '10' }), readOptions({ maxBytes: 0xffffffff }),
    readOptions({ encoding: 'utf-16' }), readOptions({ accept: '*.md' }), readOptions({ accept: '.md,.toml' }), readOptions({ signal: {} })]) {
    const h = fixture(); await assertFailure(h.pickers.readText(options), 'TEXT_FILE_INPUT'); assert.equal(h.calls.length, 0)
  }
})

test('oversize stat rejects before a byte read; byte limits are not character limits', async () => {
  const h = fixture()
  h.files.set(OPEN, encoder.encode('가'.repeat(20)))
  await assertFailure(h.pickers.readText(readOptions({ maxBytes: 59 })), 'TEXT_FILE_TOO_LARGE')
  assert.deepEqual(h.calls.map(call => call[0]), ['open', 'stat'])
  assert.equal((await h.pickers.readText(readOptions({ maxBytes: 60 }))).text, '가'.repeat(20))
  assert.equal(h.calls.at(-1)[2].maxBytes, 61)
})

test('fake filesystem growth after stat is bounded to maxBytes+1 and rejected, not accepted as a prefix', async () => {
  let requested, returned
  const h = fixture({ stat: (path, options, { files, normal }) => {
    const old = normal(path, options)
    files.set(path, new Uint8Array(1024 * 1024).fill(97))
    return old
  }, readBytes: (path, options, { normal }) => {
    requested = options.maxBytes
    const bytes = normal(path, options); returned = bytes.byteLength; return bytes
  } })
  await assertFailure(h.pickers.readText(readOptions({ maxBytes: 128 })), 'TEXT_FILE_TOO_LARGE')
  assert.deepEqual([requested, returned], [129, 129])
  assert.equal(h.calls.filter(call => call[0] === 'read').length, 1)
})

test('actual byte count is rechecked even when an injected reader violates its cap', async () => {
  const h = fixture({ stat: () => ({ type: 'regular', size: 1 }), readBytes: () => new Uint8Array(201) })
  await assertFailure(h.pickers.readText(readOptions({ maxBytes: 200 })), 'TEXT_FILE_TOO_LARGE')
})

test('empty and exact-boundary files pass without trimming or silent truncation', async () => {
  for (const content of ['', 'abc', ' 가\r\n']) {
    const h = fixture(), bytes = encoder.encode(content); h.files.set(OPEN, bytes)
    assert.equal((await h.pickers.readText(readOptions({ maxBytes: bytes.byteLength }))).text, content)
    assert.equal(h.calls.at(-1)[2].maxBytes, bytes.byteLength + 1)
  }
})

test('only regular files with finite valid stat sizes can be read', async () => {
  for (const info of [{ type: 'directory', size: 1 }, { type: 'other', size: 1 }, null, { size: 1 },
    { type: 'regular', size: -1 }, { type: 'regular', size: 1.5 }, { type: 'regular', size: '1' }, { type: 'regular', size: NaN }]) {
    let reads = 0
    const h = fixture({ stat: () => info, readBytes: () => { reads++; return new Uint8Array() } })
    await assertFailure(h.pickers.readText(readOptions()), info?.type === 'regular' ? 'TEXT_FILE_READ_FAILED' : 'TEXT_FILE_NOT_REGULAR')
    assert.equal(reads, 0)
  }
})

test('fatal UTF-8 decoding refuses invalid, overlong, surrogate and incomplete sequences', async () => {
  for (const bytes of [[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82], [0xf4, 0x90, 0x80, 0x80]]) {
    const h = fixture(); h.files.set(OPEN, new Uint8Array(bytes))
    await assertFailure(h.pickers.readText(readOptions()), 'TEXT_FILE_UTF8')
  }
})

test('readBytes must return Uint8Array and only the view window is decoded', async () => {
  for (const bytes of [null, [], 'text', new ArrayBuffer(2), new Uint16Array(2), new DataView(new ArrayBuffer(2)), { byteLength: 1 }]) {
    const h = fixture({ readBytes: () => bytes }); await assertFailure(h.pickers.readText(readOptions()), 'TEXT_FILE_READ_FAILED')
  }
  const raw = new Uint8Array([0xff, 65, 66, 0xff])
  const h = fixture({ readBytes: () => raw.subarray(1, 3) })
  assert.equal((await h.pickers.readText(readOptions())).text, 'AB')
})

test('markup remains literal text and is never interpreted or executed', async () => {
  const h = fixture(), markup = '<script>globalThis.__egdeskNativePickerExecuted = true</script>\r\n<img onerror="throw 1">'
  h.files.set(OPEN, encoder.encode(markup))
  assert.equal((await h.pickers.readText(readOptions())).text, markup)
  assert.equal(globalThis.__egdeskNativePickerExecuted, undefined)
})

test('only the chosen leaf name is returned; wrong formats and malformed/private targets are rejected', async () => {
  for (const picked of [null, undefined, OPEN, { path: OPEN }, { path: OPEN, filename: 'suggested.md' },
    { path: '/private/native-fixture/file.toml', filename: 'file.toml' }, { path: 'relative.md', filename: 'relative.md' },
    { path: 'file:///private/a.md', filename: 'a.md' }, { path: '/private/a\0.md', filename: 'a\0.md' },
    { path: '/private/a.md', filename: '../a.md' }, { path: '/private/..', filename: '..' }]) {
    const h = fixture({ pickOpenFile: () => picked })
    await assertFailure(h.pickers.readText(readOptions()), picked?.filename === 'file.toml' ? 'TEXT_FILE_FORMAT' : 'TEXT_FILE_SELECTION_INVALID')
    assert.equal(h.calls.length, 0)
  }
  for (const path of ['C:\\fixture\\chosen.MD', '\\\\server\\share\\chosen.MD']) {
    const h = fixture({ pickOpenFile: () => ({ path, filename: 'chosen.MD' }), stat: () => ({ type: 'regular', size: 1 }), readBytes: () => new Uint8Array([65]) })
    assert.deepEqual(await h.pickers.readText(readOptions()), { text: 'A', filename: 'chosen.MD' })
  }
})

test('mutable selection cannot retarget a read while stat is pending', async () => {
  const checked = deferred(), picked = { path: OPEN, filename: 'chosen.md' }, readPaths = []
  const h = fixture({ pickOpenFile: () => picked, stat: () => checked.promise,
    readBytes: (path, options, { normal }) => { readPaths.push(path); return normal(path, options) } })
  const pending = h.pickers.readText(readOptions()); await settle()
  picked.path = '/private/native-fixture/other.md'; picked.filename = 'other.md'
  checked.resolve({ type: 'regular', size: encoder.encode(text).byteLength })
  const result = await pending
  assert.equal(result.filename, 'chosen.md'); assert.deepEqual(readPaths, [OPEN])
})

test('pre-abort and explicit picker cancellation perform no stat, read, write or gate call', async () => {
  const abort = new AbortController(); abort.abort()
  const h = fixture()
  assert.deepEqual(await h.pickers.readText(readOptions({ signal: abort.signal })), { cancelled: true })
  assert.deepEqual(await h.pickers.saveText(saveOptions({ signal: abort.signal })), { cancelled: true })
  assert.equal(h.calls.length, 0)
  const cancelled = fixture({ pickOpenFile: () => ({ cancelled: true }), pickSaveFile: () => ({ cancelled: true }) })
  assert.deepEqual(await cancelled.pickers.readText(readOptions()), { cancelled: true })
  assert.deepEqual(await cancelled.pickers.saveText(saveOptions({ beginWrite: () => assert.fail('gate on cancel') })), { cancelled: true })
  assert.equal(cancelled.calls.length, 0); assert.equal(cancelled.writes.length, 0)
})

for (const stage of ['open', 'stat', 'read', 'save']) test(`abort during ${stage} promptly cancels and discards late success/rejection`, async () => {
  for (const reject of [false, true]) {
    const late = deferred(), abort = new AbortController()
    const key = { open: 'pickOpenFile', stat: 'stat', read: 'readBytes', save: 'pickSaveFile' }[stage]
    const h = fixture({ [key]: () => late.promise })
    const pending = stage === 'save' ? h.pickers.saveText(saveOptions({ signal: abort.signal, beginWrite: () => assert.fail('late gate') }))
      : h.pickers.readText(readOptions({ signal: abort.signal }))
    await settle(); abort.abort()
    assert.deepEqual(await pending, { cancelled: true })
    const count = h.calls.length
    if (reject) late.reject(new Error(`sensitive-native-error ${OPEN}`))
    else late.resolve(stage === 'read' ? encoder.encode(text) : stage === 'stat' ? { type: 'regular', size: 1 } : { path: SAVE, filename: 'chosen-output.md' })
    await settle(); assert.equal(h.calls.length, count); assert.equal(h.writes.length, 0)
  }
})

test('save captures exact selected target and original text, with no await or existence check after the gate', async () => {
  const pick = deferred(), order = [], selection = { path: SAVE, filename: 'chosen-output.md' }
  const input = saveOptions({ beginWrite: () => {
    order.push('gate'); selection.path = '/private/native-fixture/retarget.md'; selection.filename = 'retarget.md'
    queueMicrotask(() => order.push('microtask')); return true
  } })
  const h = fixture({ pickSaveFile: (options, { calls }) => { calls.push(['save', options]); return pick.promise },
    writeNewFile: (path, bytes, options, { normal }) => { order.push('write'); return normal(path, bytes, options) } })
  const pending = h.pickers.saveText(input)
  input.text = 'mutated'; input.fileName = 'changed.md'; input.contentType = 'text/html'; input.beginWrite = () => false
  pick.resolve(selection)
  assert.deepEqual(await pending, { saved: true }); assert.deepEqual(order.slice(0, 2), ['gate', 'write'])
  assert.equal(h.writes[0].path, SAVE); assert.deepEqual(h.writes[0].bytes, encoder.encode(text))
  assert.deepEqual(h.calls.map(call => call[0]), ['save', 'write'])
  assert.deepEqual(Object.keys(h.calls[0][1]).sort(), ['contentType', 'fileName', 'signal'])
  assert.equal(h.calls[0][1].fileName, 'suggested.md'); assert.ok(Object.isFrozen(h.calls[0][1]))
})

test('invalid save inputs are rejected before opening a picker', async () => {
  for (const options of [null, undefined, {}, saveOptions({ fileName: '../target.md' }), saveOptions({ text: 123 }),
    saveOptions({ text: '\ud800' }), saveOptions({ contentType: '' }), saveOptions({ contentType: 'text/plain\nother' }), saveOptions({ beginWrite: null })]) {
    const h = fixture(); await assertFailure(h.pickers.saveText(options), 'TEXT_FILE_INPUT'); assert.equal(h.calls.length, 0)
  }
})

test('a false gate certifies zero writes; invalid/throwing gates cannot claim saved', async () => {
  const h = fixture(); assert.deepEqual(await h.pickers.saveText(saveOptions({ beginWrite: () => false })), { cancelled: true })
  assert.equal(h.writes.length, 0)
  for (const beginWrite of [() => undefined, () => 'yes', () => Promise.resolve(true), () => { throw new Error(`gate ${SAVE}`) }]) {
    const h = fixture(); await assertFailure(h.pickers.saveText(saveOptions({ beginWrite })), 'TEXT_FILE_WRITE_GATE')
    assert.equal(h.writes.length, 0)
  }
})

test('abort inside/after a granted gate throws, never returns a false cancelled receipt', async () => {
  for (const throws of [false, true]) {
    const abort = new AbortController(), h = fixture()
    await assertFailure(h.pickers.saveText(saveOptions({ signal: abort.signal, beginWrite: () => {
      abort.abort(); if (throws) throw new Error('gate exception'); return true
    } })), throws ? 'TEXT_FILE_WRITE_GATE' : 'TEXT_FILE_WRITE_UNCONFIRMED')
    assert.equal(h.writes.length, 0)
  }
})

test('existing files and files created in the picker-to-write race are never overwritten', async () => {
  for (const race of [false, true]) {
    const h = fixture(), original = encoder.encode('user-owned contents')
    if (!race) h.files.set(SAVE, original)
    await assertFailure(h.pickers.saveText(saveOptions({ beginWrite: () => {
      if (race) h.files.set(SAVE, original)
      return true
    } })), 'TEXT_FILE_EXISTS')
    assert.deepEqual(h.files.get(SAVE), original); assert.equal(h.writes.length, 0)
    assert.deepEqual(h.calls.map(call => call[0]), ['save', 'write'], 'no unsafe precheck-and-overwrite path')
  }
})

test('native returnReplace glue rejects EEXIST before beginWrite instead of claiming user cancellation', async () => {
  let gates = 0
  const h = fixture({ pickSaveFile: () => Promise.reject(Object.assign(new Error('existing target'), { code: 'EEXIST' })) })
  await assert.rejects(h.pickers.saveText(saveOptions({ beginWrite: () => { gates++; return true } })), error => {
    assert.equal(error.code, 'TEXT_FILE_EXISTS'); assert.match(error.message, /다른 이름/)
    assert.doesNotMatch(String(error), /native-fixture|\/private\//)
    return true
  })
  assert.equal(gates, 0); assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0)
})

test('two concurrent save attempts at one target have exactly one exclusive-create winner', async () => {
  const h = fixture()
  const result = await Promise.allSettled([h.pickers.saveText(saveOptions({ text: 'first' })), h.pickers.saveText(saveOptions({ text: 'second' }))])
  assert.equal(result.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(result.find(item => item.status === 'rejected').reason.code, 'TEXT_FILE_EXISTS')
  assert.equal(h.writes.length, 1); assert.equal(new TextDecoder().decode(h.files.get(SAVE)), 'first')
})

test('only an exact full-byte-count receipt is success, including a newly created empty file', async () => {
  for (const receipt of [undefined, null, {}, { saved: true }, -1, '1', NaN, 1]) {
    const h = fixture({ writeNewFile: () => receipt })
    await assertFailure(h.pickers.saveText(saveOptions()), 'TEXT_FILE_WRITE_UNCONFIRMED')
  }
  const h = fixture(); assert.deepEqual(await h.pickers.saveText(saveOptions({ text: '' })), { saved: true })
  assert.equal(h.files.get(SAVE).byteLength, 0)
})

test('partial-write failure leaves a new file untouched: no rollback, removal, replacement or retry', async () => {
  let calls = 0
  const h = fixture({ writeNewFile: (path, bytes, options, { files }) => {
    calls++; files.set(path, bytes.slice(0, 3)); throw new Error(`sensitive-native-error partial ${path}`)
  } })
  await assertFailure(h.pickers.saveText(saveOptions()), 'TEXT_FILE_WRITE_FAILED')
  assert.deepEqual(h.files.get(SAVE), encoder.encode(text).slice(0, 3)); await settle(); assert.equal(calls, 1)
})

test('abort while a write is pending never reports cancellation even if the native receipt succeeds', async () => {
  const written = deferred(), abort = new AbortController()
  const h = fixture({ writeNewFile: () => written.promise }), pending = h.pickers.saveText(saveOptions({ signal: abort.signal }))
  await settle(); abort.abort(); written.resolve(encoder.encode(text).byteLength)
  await assertFailure(pending, 'TEXT_FILE_WRITE_UNCONFIRMED')
})

test('native callback errors never leak selected paths, causes, or native metadata', async () => {
  for (const name of ['pickOpenFile', 'pickSaveFile', 'stat', 'readBytes', 'writeNewFile']) {
    const h = fixture({ [name]: () => { throw Object.assign(new Error(`sensitive-native-error ${OPEN} ${SAVE}`), { path: SAVE, details: { path: OPEN } }) } })
    const saving = name === 'pickSaveFile' || name === 'writeNewFile'
    await assertFailure(saving ? h.pickers.saveText(saveOptions()) : h.pickers.readText(readOptions()),
      name.startsWith('pick') ? 'TEXT_FILE_PICK_FAILED' : saving ? 'TEXT_FILE_WRITE_FAILED' : 'TEXT_FILE_READ_FAILED')
  }
})

const profilePacket = () => ({ profileId: 'prof-a', revision: 1, hash: 'a'.repeat(64), format: 'md', filename: 'agent.md',
  mediaType: 'text/markdown; charset=utf-8', text: '---\nname: A\n---\nReview.\n', omitted: ['avatarImage'] })
const boardPacket = () => ({ canvas: { nodes: [], edges: [] }, report: { nodes: 0, edges: 0, omitted: [] } })
for (const workflow of ['profile', 'board']) test(`${workflow} workflow distinguishes known-existing failure, post-gate uncertainty and user cancellation`, async () => {
  for (const mode of ['cancel', 'known-existing', 'collision', 'partial', 'saved']) {
    let gates = 0
    const h = fixture({ ...(mode === 'cancel' ? { pickSaveFile: () => ({ cancelled: true }) } : {}),
      ...(mode === 'known-existing' ? { pickSaveFile: () => { throw Object.assign(new Error('existing target'), { code: 'EEXIST' }) } } : {}),
      writeNewFile: (path, bytes, options, { normal, files }) => {
        gates++
        if (mode === 'collision') files.set(path, encoder.encode('other writer'))
        if (mode === 'partial') { files.set(path, bytes.slice(0, 2)); throw new Error(`failed ${path}`) }
        return normal(path, bytes, options)
      } })
    const states = []
    const flow = workflow === 'profile' ? createEGDeskProfileTransfer({ request: () => profilePacket(), ...h.pickers, onState: s => states.push(s) })
      : createEGDeskBoardExport({ request: () => boardPacket(), saveText: h.pickers.saveText, onState: s => states.push(s) })
    const result = workflow === 'profile' ? await flow.bind().exportProfile({ profileId: 'prof-a', revision: 1, format: 'md' })
      : await flow.exportBoard({ boardId: 'board-a', title: 'Board', hasStoredBoard: true })
    assert.equal(result.status, mode === 'cancel' ? 'cancelled' : mode === 'known-existing' ? 'failed' : mode === 'saved' ? 'saved' : 'unknown')
    if (mode === 'known-existing' && workflow === 'profile') assert.equal(result.code, 'TEXT_FILE_EXISTS')
    assert.equal(gates, ['cancel', 'known-existing'].includes(mode) ? 0 : 1); assert.doesNotMatch(JSON.stringify(states), /native-fixture|\/private\//)
  }
})

for (const workflow of ['profile', 'board']) test(`${workflow} invalidation while the native picker waits fences late target and zero writes`, async () => {
  const late = deferred(), h = fixture({ pickSaveFile: () => late.promise })
  const flow = workflow === 'profile' ? createEGDeskProfileTransfer({ request: () => profilePacket(), ...h.pickers })
    : createEGDeskBoardExport({ request: () => boardPacket(), saveText: h.pickers.saveText })
  const pending = workflow === 'profile' ? flow.bind().exportProfile({ profileId: 'prof-a', revision: 1 })
    : flow.exportBoard({ boardId: 'board-a', title: 'Board', hasStoredBoard: true })
  await settle(); flow.invalidate(); assert.equal((await pending).status, 'stale')
  late.resolve({ path: SAVE, filename: 'chosen-output.md' }); await settle()
  assert.equal(h.writes.length, 0); assert.equal(h.flow, undefined); assert.equal(flow.snapshot().status, 'idle')
})
