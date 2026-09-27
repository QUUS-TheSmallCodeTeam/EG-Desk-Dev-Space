import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const FORMAT = 'egdesk'
const VERSION = { major: 1, minor: 0 }
const SHA = /^[a-f0-9]{64}$/
const MAGIC = Buffer.from('EGDESK-E1\n')
const CHUNK = 1024 * 1024
const MAX_HEADER = 16 * 1024
const MAX_ENCRYPTED_ZIP_MEMORY = 64 * 1024 * 1024
const MAX_MANIFEST = 8 * 1024 * 1024
const MAX_EVENTS = 32 * 1024 * 1024
const MAX_TRANSCRIPT = 8 * 1024 * 1024
const DEFAULT_BUDGET = Object.freeze({ maxEntries: 100_000, maxUncompressedBytes: 10 * 1024 ** 3, maxRatio: 100 })
const ROOT_TYPES = new Set(['board', 'chat', 'source'])
const NODE_TYPES = new Set(['board', 'chat', 'source', 'snapshot', 'canvas', 'answer', 'artifact'])
const EVENT_KINDS = new Set(['message', 'state', 'relation', 'decision', 'source-snapshot'])
const OBJECT_ROLES = new Set(['body', 'attachment', 'preview', 'source', 'transcript'])
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const asBuffer = value => Buffer.isBuffer(value) ? value : Buffer.from(value)

export class PortableBundleError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'PortableBundleError'
    this.code = code
    this.details = details
  }
}
const fail = (code, message, details) => { throw new PortableBundleError(code, message, details) }
const checkAbort = signal => { if (signal?.aborted) fail('CANCELLED', 'Bundle operation was cancelled') }
const exactKeys = (value, required, optional = []) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_SCHEMA', 'Expected an object')
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail('INVALID_SCHEMA', `Unexpected field: ${key}`)
  for (const key of required) if (!Object.hasOwn(value, key)) fail('INVALID_SCHEMA', `Missing field: ${key}`)
}
const safeText = (value, max = 512) => {
  if (typeof value !== 'string' || value.length > max || /\0|(?:^|[\s("'])(?:\/[^\s]|~\/|[A-Za-z]:[\\/]|file:\/\/|\\\\[^\s])/i.test(value)) fail('UNSAFE_METADATA', 'Metadata contains a machine path or invalid text')
  return value
}
const safeId = value => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) fail('INVALID_ID', 'Invalid portable ID')
  return value
}
const safeHash = value => { if (!SHA.test(value)) fail('INVALID_HASH', 'Invalid SHA-256 object name'); return value }
const safeAlias = value => {
  if (value == null) return null
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) fail('UNSAFE_METADATA', 'Portable root alias is invalid')
  return value
}
const safeEntryName = name => {
  if (typeof name !== 'string' || name !== name.normalize('NFC') || name.includes('\\') || name.startsWith('/') || name.includes('..') || name.includes('\0') || /^[A-Za-z]:/.test(name)) fail('UNSAFE_ENTRY', 'Archive entry path is not permitted')
  if (name === 'manifest.json' || name === 'events.jsonl' || name === 'transcript.md' || /^objects\/[a-f0-9]{64}$/.test(name)) return name
  fail('UNSAFE_ENTRY', `Archive entry is not allowlisted: ${name}`)
}
const nonnegativeSafe = value => { if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_SIZE', 'Size must be a non-negative safe integer'); return value }
const readableOf = source => source instanceof Readable ? source : Readable.from(source)

async function consumeAndHash(source, expectedHash, expectedSize, signal) {
  const digest = createHash('sha256')
  let size = 0
  for await (const part of readableOf(source)) {
    checkAbort(signal)
    const bytes = asBuffer(part)
    size += bytes.length
    if (!Number.isSafeInteger(size) || size > expectedSize) fail('OBJECT_SIZE', 'Object exceeded declared length')
    digest.update(bytes)
  }
  if (size !== expectedSize || digest.digest('hex') !== expectedHash) fail('OBJECT_HASH', 'Object bytes did not match manifest')
}

function verifiedReadable(open, expectedHash, expectedSize, signal) {
  return Readable.from((async function* () {
    const digest = createHash('sha256')
    let size = 0
    for await (const part of readableOf(await open())) {
      checkAbort(signal)
      const bytes = asBuffer(part)
      size += bytes.length
      if (!Number.isSafeInteger(size) || size > expectedSize) fail('OBJECT_SIZE', 'Object exceeded declared length')
      digest.update(bytes)
      yield bytes
    }
    if (size !== expectedSize || digest.digest('hex') !== expectedHash) fail('OBJECT_HASH', 'Object bytes did not match manifest')
  })())
}

/** ZIP64 stream encoder and sequential, no-extraction reader using vetted yazl/yauzl. */
export function createEGDeskZipCodec({ yazl, yauzl }) {
  const ZipFile = yazl?.ZipFile || yazl?.default?.ZipFile
  const reader = yauzl?.fromBufferPromise ? yauzl : yauzl?.default
  if (!ZipFile || !reader?.fromBufferPromise || !reader?.openPromise) fail('CODEC_UNAVAILABLE', 'yazl and yauzl 3.x are required')

  function encode(entries, { signal } = {}) {
    if (!Array.isArray(entries) || entries.length < 3 || entries.length > DEFAULT_BUDGET.maxEntries) fail('ARCHIVE_BUDGET', 'Invalid archive entry count')
    const seen = new Set()
    let expanded = 0
    for (const entry of entries) {
      checkAbort(signal)
      const name = safeEntryName(entry.name)
      if (seen.has(name)) fail('DUPLICATE_ENTRY', 'Duplicate archive entry')
      seen.add(name)
      expanded += nonnegativeSafe(entry.size)
      if (!Number.isSafeInteger(expanded) || expanded > DEFAULT_BUDGET.maxUncompressedBytes) fail('ARCHIVE_BUDGET', 'Expanded archive exceeds policy')
      if (typeof entry.open !== 'function') fail('INVALID_READER', 'Entry stream provider is required')
    }
    if (!['manifest.json', 'events.jsonl', 'transcript.md'].every(name => seen.has(name))) fail('MISSING_ENTRY', 'Required archive entry is missing')
    const zip = new ZipFile()
    const output = zip.outputStream
    const activeStreams = new Set()
    const stop = cause => {
      for (const stream of activeStreams) stream.destroy()
      activeStreams.clear()
      if (!output.destroyed) output.destroy(cause)
    }
    // yazl emits lazy-provider and length failures on ZipFile, while supplied
    // streams emit their own failures. Both must reject the returned stream.
    zip.on('error', stop)
    const onAbort = () => stop(new PortableBundleError('CANCELLED', 'Bundle operation was cancelled'))
    signal?.addEventListener('abort', onAbort, { once: true })
    output.once('close', () => { signal?.removeEventListener('abort', onAbort); stop() })
    for (const entry of entries) {
      zip.addReadStreamLazy(entry.name, { size: entry.size, compress: false, mode: 0o100600, mtime: new Date('1980-01-01T00:00:00Z'), forceZip64Format: true }, callback => {
        Promise.resolve().then(() => entry.open()).then(source => {
          const stream = readableOf(source)
          stream.on('error', stop)
          if (output.destroyed) { stream.destroy(); return }
          activeStreams.add(stream)
          stream.once('close', () => activeStreams.delete(stream))
          callback(null, stream)
        }).catch(cause => { stop(cause); callback(cause) })
      })
    }
    zip.end({ forceZip64Format: true })
    return output
  }

  async function read(source, onEntry, { signal, budget = DEFAULT_BUDGET } = {}) {
    if (typeof onEntry !== 'function') fail('INVALID_READER', 'Sequential entry handler is required')
    const options = { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, decodeStrings: true, autoClose: false }
    const zip = Buffer.isBuffer(source) ? await reader.fromBufferPromise(source, options) : await reader.openPromise(source, options)
    const seen = new Set()
    let count = 0
    let expanded = 0
    try {
      if (zip.entryCount > budget.maxEntries) fail('ARCHIVE_BUDGET', 'Archive has too many entries')
      for await (const entry of zip.eachEntry()) {
        checkAbort(signal)
        count++
        if (count > budget.maxEntries) fail('ARCHIVE_BUDGET', 'Archive has too many entries')
        const name = safeEntryName(entry.fileName)
        if (seen.has(name)) fail('DUPLICATE_ENTRY', 'Duplicate or normalized-duplicate entry')
        seen.add(name)
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff
        const fileType = mode & 0o170000
        if (fileType && fileType !== 0o100000) fail('UNSAFE_ENTRY_TYPE', 'Links, directories, and special files are rejected')
        if (entry.isEncrypted?.()) fail('UNSUPPORTED_ZIP_ENCRYPTION', 'ZIP-level encryption is not accepted')
        if (![0, 8].includes(entry.compressionMethod)) fail('UNSAFE_COMPRESSION', 'Unsupported compression method')
        const size = nonnegativeSafe(entry.uncompressedSize)
        const compressed = nonnegativeSafe(entry.compressedSize)
        if (size > 0 && (compressed === 0 || size / compressed > budget.maxRatio)) fail('ARCHIVE_RATIO', 'Compression ratio exceeded policy')
        expanded += size
        if (!Number.isSafeInteger(expanded) || expanded > budget.maxUncompressedBytes) fail('ARCHIVE_BUDGET', 'Expanded archive exceeded policy')
        let consumed = false
        let completed = false
        await onEntry({ name, size, compressedSize: compressed, async *bytes() {
          if (consumed) fail('ENTRY_CONSUMED', 'Archive entry can only be read once')
          consumed = true
          const stream = await zip.openReadStreamPromise(entry)
          let actual = 0
          for await (const part of stream) {
            checkAbort(signal)
            const bytes = asBuffer(part)
            actual += bytes.length
            if (!Number.isSafeInteger(actual) || actual > size) fail('ARCHIVE_SIZE', 'Entry exceeded declared length')
            yield bytes
          }
          if (actual !== size) fail('ARCHIVE_SIZE', 'Entry ended before declared length')
          completed = true
        } })
        if (!consumed || !completed) fail('ENTRY_NOT_READ', 'Every allowlisted entry must be fully consumed')
      }
      if (!['manifest.json', 'events.jsonl', 'transcript.md'].every(name => seen.has(name))) fail('MISSING_ENTRY', 'Required archive entry is missing')
      return { count, expanded }
    } finally { zip.close() }
  }
  return { encode, read }
}

class ByteReader {
  constructor(source) { this.iterator = readableOf(source)[Symbol.asyncIterator](); this.pending = Buffer.alloc(0); this.done = false }
  async take(size, allowEof = false) {
    if (!Number.isInteger(size) || size < 0 || size > CHUNK + MAX_HEADER + 64) fail('ENVELOPE_SIZE', 'Invalid encrypted frame length')
    const parts = []
    let collected = 0
    while (collected < size) {
      if (!this.pending.length) {
        const next = await this.iterator.next()
        if (next.done) { this.done = true; if (allowEof && collected === 0) return null; fail('TRUNCATED_ENVELOPE', 'Encrypted bundle ended early') }
        this.pending = asBuffer(next.value)
        if (!this.pending.length) continue
      }
      const take = Math.min(size - collected, this.pending.length)
      parts.push(this.pending.subarray(0, take))
      this.pending = this.pending.subarray(take)
      collected += take
    }
    return Buffer.concat(parts, size)
  }
  async exhausted() { return (await this.take(1, true)) === null }
}

const frame = ciphertext => {
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32BE(ciphertext.length)
  return [length, asBuffer(ciphertext)]
}

/** Streaming Argon2id v1.3 + XChaCha20-Poly1305 secretstream envelope. */
export function createEGDeskEncryptedEnvelope({ sodium }) {
  if (!sodium?.crypto_pwhash || !sodium?.crypto_secretstream_xchacha20poly1305_init_push) fail('CRYPTO_UNAVAILABLE', 'libsodium-wrappers-sumo is required')
  const derive = (password, salt, opslimit, memlimit) => {
    if (typeof password !== 'string' || password.length < 1) fail('PASSWORD_REQUIRED', 'A non-empty password is required')
    return sodium.crypto_pwhash(sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES, password, salt, opslimit, memlimit, sodium.crypto_pwhash_ALG_ARGON2ID13)
  }
  function encrypt(source, password, { signal } = {}) {
    return Readable.from((async function* () {
      const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES)
      const key = derive(password, salt, 3, 64 * 1024 * 1024)
      let state
      try {
        const initialized = sodium.crypto_secretstream_xchacha20poly1305_init_push(key)
        state = initialized.state
        const header = { version: 1, kdf: 'argon2id13', opslimit: 3, memlimit: 64 * 1024 * 1024, salt: Buffer.from(salt).toString('base64'), streamHeader: Buffer.from(initialized.header).toString('base64'), chunkSize: CHUNK }
        const headerBytes = Buffer.from(JSON.stringify(header))
        if (headerBytes.length > MAX_HEADER) fail('ENVELOPE_HEADER', 'Envelope header exceeded policy')
        const headerLength = Buffer.alloc(4)
        headerLength.writeUInt32BE(headerBytes.length)
        yield MAGIC; yield headerLength; yield headerBytes
        let pending = Buffer.alloc(0)
        for await (const part of readableOf(source)) {
          checkAbort(signal)
          let bytes = asBuffer(part)
          while (bytes.length) {
            const take = Math.min(CHUNK - pending.length, bytes.length)
            pending = Buffer.concat([pending, bytes.subarray(0, take)])
            bytes = bytes.subarray(take)
            if (pending.length === CHUNK) {
              const cipher = sodium.crypto_secretstream_xchacha20poly1305_push(state, pending, headerBytes, sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE)
              yield* frame(cipher)
              pending = Buffer.alloc(0)
            }
          }
        }
        const final = sodium.crypto_secretstream_xchacha20poly1305_push(state, pending, headerBytes, sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL)
        yield* frame(final)
      } finally { sodium.memzero(key); if (state instanceof Uint8Array) sodium.memzero(state) }
    })())
  }
  function decrypt(source, password, { signal } = {}) {
    return Readable.from((async function* () {
      const input = new ByteReader(source)
      if (!(await input.take(MAGIC.length)).equals(MAGIC)) fail('ENVELOPE_MAGIC', 'Not an EG-Desk encrypted bundle')
      const headerLength = (await input.take(4)).readUInt32BE(0)
      if (headerLength < 1 || headerLength > MAX_HEADER) fail('ENVELOPE_HEADER', 'Envelope header length is unsafe')
      const headerBytes = await input.take(headerLength)
      let header
      try { header = JSON.parse(headerBytes.toString('utf8')) } catch { fail('ENVELOPE_HEADER', 'Envelope header is invalid') }
      exactKeys(header, ['version', 'kdf', 'opslimit', 'memlimit', 'salt', 'streamHeader', 'chunkSize'])
      if (header.version !== 1 || header.kdf !== 'argon2id13' || header.chunkSize !== CHUNK || !Number.isInteger(header.opslimit) || header.opslimit < 3 || header.opslimit > 6 || !Number.isInteger(header.memlimit) || header.memlimit < 64 * 1024 * 1024 || header.memlimit > 256 * 1024 * 1024) fail('ENVELOPE_POLICY', 'Unsupported or excessive KDF parameters')
      const salt = Buffer.from(header.salt, 'base64')
      const streamHeader = Buffer.from(header.streamHeader, 'base64')
      if (salt.length !== sodium.crypto_pwhash_SALTBYTES || streamHeader.length !== sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES) fail('ENVELOPE_HEADER', 'Envelope salt or stream header has invalid length')
      const key = derive(password, salt, header.opslimit, header.memlimit)
      let state
      try {
        state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(streamHeader, key)
        let finalSeen = false
        while (!finalSeen) {
          checkAbort(signal)
          const lengthBytes = await input.take(4)
          const length = lengthBytes.readUInt32BE(0)
          if (length < sodium.crypto_secretstream_xchacha20poly1305_ABYTES || length > CHUNK + sodium.crypto_secretstream_xchacha20poly1305_ABYTES) fail('ENVELOPE_SIZE', 'Encrypted chunk length is unsafe')
          const cipher = await input.take(length)
          const opened = sodium.crypto_secretstream_xchacha20poly1305_pull(state, cipher, headerBytes)
          if (!opened) fail('AUTH_FAILED', 'Encrypted bundle authentication failed')
          if (opened.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL) finalSeen = true
          else if (opened.tag !== sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE) fail('ENVELOPE_TAG', 'Unexpected encrypted stream tag')
          if (opened.message.length) yield asBuffer(opened.message)
        }
        if (!(await input.exhausted())) fail('ENVELOPE_TRAILING', 'Bytes follow the authenticated FINAL tag')
      } finally { sodium.memzero(key); if (state instanceof Uint8Array) sodium.memzero(state) }
    })())
  }
  return { encrypt, decrypt, isEncryptedPrefix: prefix => asBuffer(prefix).subarray(0, MAGIC.length).equals(MAGIC), maxMemoryZipBytes: MAX_ENCRYPTED_ZIP_MEMORY }
}

export async function loadEGDeskPortableDependencies() {
  const [yazl, yauzl, sodiumModule] = await Promise.all([import('yazl'), import('yauzl'), import('libsodium-wrappers-sumo')])
  const sodium = sodiumModule.default || sodiumModule
  await sodium.ready
  return { codec: createEGDeskZipCodec({ yazl, yauzl }), envelope: createEGDeskEncryptedEnvelope({ sodium }) }
}

function portableNode(source, selectedRootIds) {
  if (!source || typeof source !== 'object' || !selectedRootIds.has(source.scopeRootId)) return null
  exactKeys(source, ['id', 'type', 'scopeRootId', 'title', 'refs', 'objects'], ['summary', 'rootAlias'])
  const id = safeId(source.id)
  const type = source.type
  if (!NODE_TYPES.has(type)) fail('UNSUPPORTED_NODE', 'Node type is not portable')
  const scopeRootId = safeId(source.scopeRootId)
  if (!Array.isArray(source.refs) || !Array.isArray(source.objects)) fail('INVALID_SCHEMA', 'Node references must be arrays')
  const refs = [...new Set(source.refs.map(safeId))]
  const objects = source.objects.map(ref => {
    exactKeys(ref, ['sha256', 'role'])
    if (!OBJECT_ROLES.has(ref.role)) fail('UNSUPPORTED_OBJECT_ROLE', 'Object role is not portable')
    return { sha256: safeHash(ref.sha256), role: ref.role }
  })
  return { id, type, scopeRootId, title: safeText(source.title), summary: safeText(source.summary || '', 2000), rootAlias: safeAlias(source.rootAlias), refs, objects }
}

function portableEvent(source, nodeIds) {
  exactKeys(source, ['id', 'ownerId', 'kind', 'at'], ['objectHash'])
  const id = safeId(source.id)
  const ownerId = safeId(source.ownerId)
  if (!nodeIds.has(ownerId)) fail('PRIVATE_EVENT', 'Event owner is outside the selected graph')
  if (!EVENT_KINDS.has(source.kind)) fail('UNSUPPORTED_EVENT', 'Event kind is not portable')
  if (!Number.isSafeInteger(source.at) || source.at < 0) fail('INVALID_SCHEMA', 'Event time is invalid')
  return { id, ownerId, kind: source.kind, at: source.at, ...(source.objectHash ? { objectHash: safeHash(source.objectHash) } : {}) }
}

function canonicalManifest({ roots, nodes, objects, eventsSha256, transcriptSha256, excludedCount }) {
  const content = { format: FORMAT, version: VERSION, roots, nodes, objects, eventsSha256, transcriptSha256, excludedCount }
  return { ...content, contentSha256: sha256(Buffer.from(JSON.stringify(content))) }
}

function validateManifest(manifest) {
  exactKeys(manifest, ['format', 'version', 'roots', 'nodes', 'objects', 'eventsSha256', 'transcriptSha256', 'excludedCount', 'contentSha256'])
  exactKeys(manifest.version, ['major', 'minor'])
  if (manifest.format !== FORMAT || manifest.version.major !== 1 || !Number.isInteger(manifest.version.minor) || manifest.version.minor < 0) fail('UNSUPPORTED_VERSION', 'Unsupported .egdesk bundle version')
  if (!Array.isArray(manifest.roots) || !manifest.roots.length || !Array.isArray(manifest.nodes) || !Array.isArray(manifest.objects)) fail('INVALID_SCHEMA', 'Bundle graph is missing')
  if (!Number.isSafeInteger(manifest.excludedCount) || manifest.excludedCount < 0) fail('INVALID_SCHEMA', 'Excluded count is invalid')
  safeHash(manifest.eventsSha256); safeHash(manifest.transcriptSha256); safeHash(manifest.contentSha256)
  const { contentSha256, ...content } = manifest
  if (sha256(Buffer.from(JSON.stringify(content))) !== contentSha256) fail('MANIFEST_HASH', 'Manifest content hash is invalid')
  const roots = new Set(manifest.roots.map(safeId))
  if (roots.size !== manifest.roots.length) fail('DUPLICATE_ID', 'Duplicate root ID')
  const nodeIds = new Set()
  for (const node of manifest.nodes) {
    exactKeys(node, ['id', 'type', 'scopeRootId', 'title', 'summary', 'rootAlias', 'refs', 'objects'])
    safeId(node.id); safeId(node.scopeRootId); safeText(node.title); safeText(node.summary, 2000); safeAlias(node.rootAlias)
    if (!NODE_TYPES.has(node.type) || !roots.has(node.scopeRootId)) fail('INVALID_GRAPH', 'Node type or scope is invalid')
    if (nodeIds.has(node.id)) fail('DUPLICATE_ID', 'Duplicate node ID')
    nodeIds.add(node.id)
    if (!Array.isArray(node.refs) || !Array.isArray(node.objects)) fail('INVALID_GRAPH', 'Node reference list is invalid')
    for (const id of node.refs) safeId(id)
    for (const ref of node.objects) { exactKeys(ref, ['sha256', 'role']); safeHash(ref.sha256); if (!OBJECT_ROLES.has(ref.role)) fail('INVALID_GRAPH', 'Object role is invalid') }
  }
  for (const root of roots) {
    const node = manifest.nodes.find(item => item.id === root)
    if (!node || !ROOT_TYPES.has(node.type) || node.scopeRootId !== root) fail('INVALID_GRAPH', 'Selected root is absent or not portable')
  }
  for (const node of manifest.nodes) for (const ref of node.refs) if (!nodeIds.has(ref)) fail('INVALID_GRAPH', 'Reference graph is not closed')
  const objectHashes = new Set()
  let total = 0
  for (const object of manifest.objects) {
    exactKeys(object, ['sha256', 'size'])
    safeHash(object.sha256); nonnegativeSafe(object.size)
    if (objectHashes.has(object.sha256)) fail('DUPLICATE_HASH', 'Duplicate object hash')
    objectHashes.add(object.sha256)
    total += object.size
    if (!Number.isSafeInteger(total) || total > DEFAULT_BUDGET.maxUncompressedBytes) fail('ARCHIVE_BUDGET', 'Object total exceeds policy')
  }
  for (const node of manifest.nodes) for (const ref of node.objects) if (!objectHashes.has(ref.sha256)) fail('MISSING_OBJECT', 'Referenced object is missing')
  if (manifest.objects.length + 3 > DEFAULT_BUDGET.maxEntries) fail('ARCHIVE_BUDGET', 'Entry count exceeds policy')
  return { nodeIds, objectHashes, roots }
}

async function collectBounded(source, max, signal) {
  const parts = []
  let size = 0
  for await (const part of source) {
    checkAbort(signal)
    const bytes = asBuffer(part)
    size += bytes.length
    if (!Number.isSafeInteger(size) || size > max) fail('MEMORY_BUDGET', 'Input exceeds bounded in-memory validation limit', { limit: max })
    parts.push(bytes)
  }
  return Buffer.concat(parts, size)
}

function boundedReadable(source, maximum, signal) {
  return Readable.from((async function* () {
    let size = 0
    for await (const part of source) {
      checkAbort(signal)
      const bytes = asBuffer(part)
      size += bytes.length
      if (!Number.isSafeInteger(size) || size > maximum) fail('MEMORY_BUDGET', 'Encrypted bundle would exceed this importer\'s ZIP size limit', { limit: maximum })
      yield bytes
    }
  })())
}

function parseCanonicalJson(bytes, max) {
  if (bytes.length > max) fail('ARCHIVE_BUDGET', 'Metadata entry is too large')
  const raw = bytes.toString('utf8')
  let value
  try { value = JSON.parse(raw) } catch { fail('INVALID_JSON', 'Bundle metadata is not valid JSON') }
  if (JSON.stringify(value) !== raw) fail('NONCANONICAL_JSON', 'Bundle metadata must use canonical compact JSON')
  return value
}

function parseEvents(bytes, nodeIds, objectHashes) {
  if (bytes.length > MAX_EVENTS) fail('ARCHIVE_BUDGET', 'Event log is too large')
  const text = bytes.toString('utf8')
  const lines = text ? text.split('\n') : []
  if (lines.length && lines.at(-1) === '') lines.pop()
  if (lines.length > 100_000) fail('ARCHIVE_BUDGET', 'Event count exceeds policy')
  const events = []
  const ids = new Set()
  for (const line of lines) {
    const event = portableEvent(parseCanonicalJson(Buffer.from(line), MAX_EVENTS), nodeIds)
    if (ids.has(event.id)) fail('DUPLICATE_ID', 'Duplicate event ID')
    ids.add(event.id)
    if (event.objectHash && !objectHashes.has(event.objectHash)) fail('MISSING_OBJECT', 'Event object is missing')
    events.push(event)
  }
  return events
}

/**
 * Backend contract:
 * objectProvider.openExportSnapshot(rootIds) -> pinned snapshot with
 * getNode(id), listEvents(nodeIds), getObjectMeta(hash), openObject(hash), close().
 * importStore.beginStage() -> encryptedStaging stage with putObject({sha256,
 * size,stream}), commitCopy({roots,nodes,events,lineage}), abort().
 * importStore.reopenRepresentative(rootIds) verifies committed references.
 * sink: {stagingProtection:'encrypted', atomicPublish:true, writable,
 * publish({sha256,size,encrypted}), abort()}.
 */
export function createEGDeskPortableBundle({ objectProvider, importStore, codec, envelope, makeId = randomUUID } = {}) {
  if (!objectProvider?.openExportSnapshot || !importStore?.beginStage || !importStore?.reopenRepresentative || !codec?.encode || !codec?.read) fail('ADAPTER_REQUIRED', 'Portable bundle adapters are incomplete')
  const plans = new Map()
  const imports = new Map()

  async function planExport({ rootIds, signal } = {}) {
    if (!Array.isArray(rootIds) || !rootIds.length || rootIds.length > 100 || new Set(rootIds).size !== rootIds.length) fail('INVALID_ROOT_SELECTION', 'Select 1–100 distinct Board, Chat, or Source roots')
    rootIds.forEach(safeId)
    const selected = new Set(rootIds)
    const snapshot = await objectProvider.openExportSnapshot(rootIds)
    if (!snapshot || !['getNode', 'listEvents', 'getObjectMeta', 'openObject', 'close'].every(key => typeof snapshot[key] === 'function')) fail('ADAPTER_REQUIRED', 'Export snapshot must be pinned and readable')
    try {
      const queue = [...rootIds]
      const seen = new Set()
      const nodes = []
      let excludedCount = 0
      while (queue.length) {
        checkAbort(signal)
        const id = safeId(queue.shift())
        if (seen.has(id)) continue
        seen.add(id)
        if (seen.size > 100_000) fail('ARCHIVE_BUDGET', 'Reference graph exceeds policy')
        const source = await snapshot.getNode(id)
        if (!source) fail('MISSING_NODE', 'Selected graph contains a missing reference')
        const node = portableNode(source, selected)
        if (!node) { excludedCount++; continue }
        if (selected.has(id) && (!ROOT_TYPES.has(node.type) || node.scopeRootId !== id)) fail('INVALID_ROOT_SELECTION', 'Selected root has the wrong type or scope')
        nodes.push(node)
        queue.push(...node.refs)
      }
      const included = new Set(nodes.map(node => node.id))
      for (const node of nodes) node.refs = node.refs.filter(id => included.has(id))
      nodes.sort((a, b) => a.id.localeCompare(b.id))
      const hashSet = new Set(nodes.flatMap(node => node.objects.map(ref => ref.sha256)))
      const events = []
      const eventIds = new Set()
      for await (const source of await snapshot.listEvents([...included])) {
        checkAbort(signal)
        const event = portableEvent(source, included)
        if (eventIds.has(event.id)) fail('DUPLICATE_ID', 'Duplicate event ID')
        eventIds.add(event.id)
        events.push(event)
        if (event.objectHash) hashSet.add(event.objectHash)
        if (events.length > 100_000) fail('ARCHIVE_BUDGET', 'Event count exceeds policy')
      }
      const eventsBytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''))
      if (eventsBytes.length > MAX_EVENTS) fail('ARCHIVE_BUDGET', 'Event log exceeds policy')
      const transcriptBytes = Buffer.from(`# EG-Desk export\n\n${nodes.map(node => `- ${node.type}: ${node.title.replace(/[\r\n]/g, ' ')}`).join('\n')}\n`)
      if (transcriptBytes.length > MAX_TRANSCRIPT) fail('ARCHIVE_BUDGET', 'Transcript exceeds policy')
      const objects = []
      let total = 0
      for (const objectHash of [...hashSet].sort()) {
        checkAbort(signal)
        const meta = await snapshot.getObjectMeta(objectHash)
        if (!meta || meta.portableApproved !== true || !selected.has(meta.scopeRootId)) fail('OBJECT_NOT_APPROVED', 'Object is private, unselected, or not approved for export')
        const size = nonnegativeSafe(meta.size)
        total += size
        if (!Number.isSafeInteger(total) || total > DEFAULT_BUDGET.maxUncompressedBytes || objects.length + 4 > DEFAULT_BUDGET.maxEntries) fail('ARCHIVE_BUDGET', 'Selected objects exceed archive policy')
        await consumeAndHash(await snapshot.openObject(objectHash), objectHash, size, signal)
        objects.push({ sha256: objectHash, size })
      }
      const manifest = canonicalManifest({ roots: rootIds, nodes, objects, eventsSha256: sha256(eventsBytes), transcriptSha256: sha256(transcriptBytes), excludedCount })
      const manifestBytes = Buffer.from(JSON.stringify(manifest))
      if (manifestBytes.length > MAX_MANIFEST) fail('ARCHIVE_BUDGET', 'Manifest exceeds policy')
      const planId = makeId()
      plans.set(planId, { snapshot, manifest, manifestBytes, eventsBytes, transcriptBytes, objects })
      return { planId, rootIds, nodeCount: nodes.length, eventCount: events.length, objectCount: objects.length, objectBytes: total, excludedCount, credentialPolicy: 'schema-excluded; payload approval required', encryptedAvailable: !!envelope, encryptedZipByteLimit: envelope?.maxMemoryZipBytes || null }
    } catch (error) { await snapshot.close(); throw error }
  }

  async function cancelExport({ planId }) {
    const plan = plans.get(planId)
    if (!plan) return false
    plans.delete(planId)
    await plan.snapshot.close()
    return true
  }

  async function exportPlan({ planId, sink, password, signal } = {}) {
    const plan = plans.get(planId)
    if (!plan) fail('UNKNOWN_PLAN', 'Export plan is unavailable')
    if (!sink || sink.atomicPublish !== true || sink.stagingProtection !== 'encrypted' || !sink.writable || typeof sink.publish !== 'function' || typeof sink.abort !== 'function') fail('UNSAFE_SINK', 'Export requires an atomic sink with protected staging')
    const encrypted = password != null
    if (encrypted && !envelope) fail('CRYPTO_UNAVAILABLE', 'Encryption was requested but is not available')
    const entries = [
      { name: 'manifest.json', size: plan.manifestBytes.length, open: () => Readable.from([plan.manifestBytes]) },
      { name: 'events.jsonl', size: plan.eventsBytes.length, open: () => Readable.from([plan.eventsBytes]) },
      { name: 'transcript.md', size: plan.transcriptBytes.length, open: () => Readable.from([plan.transcriptBytes]) },
      ...plan.objects.map(object => ({ name: `objects/${object.sha256}`, size: object.size, open: () => verifiedReadable(() => plan.snapshot.openObject(object.sha256), object.sha256, object.size, signal) })),
    ]
    const digest = createHash('sha256')
    let size = 0
    const counter = new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length
      if (!Number.isSafeInteger(size)) return callback(new PortableBundleError('ARCHIVE_BUDGET', 'Output size overflow'))
      digest.update(chunk)
      callback(null, chunk)
    } })
    try {
      // The encrypted reader uses bounded RAM because yauzl requires random
      // access. Match that same ceiling before publishing any encrypted output;
      // the streaming guard below includes ZIP64 headers and central directory.
      if (encrypted && entries.reduce((sum, entry) => sum + entry.size, 0) > envelope.maxMemoryZipBytes) fail('MEMORY_BUDGET', 'Encrypted bundle exceeds this importer\'s ZIP size limit', { limit: envelope.maxMemoryZipBytes })
      const zip = codec.encode(entries, { signal })
      const output = encrypted ? envelope.encrypt(boundedReadable(zip, envelope.maxMemoryZipBytes, signal), password, { signal }) : zip
      await pipeline(output, counter, sink.writable, { signal })
      const sha256Output = digest.digest('hex')
      const published = await sink.publish({ sha256: sha256Output, size, encrypted })
      return { status: 'published', ...published, sha256: sha256Output, size, encrypted, manifestHash: plan.manifest.contentSha256 }
    } catch (error) { await sink.abort().catch(() => {}); throw error }
    finally { await cancelExport({ planId }) }
  }

  async function inspectImport({ source, password, signal } = {}) {
    if (!(Buffer.isBuffer(source) || typeof source === 'string')) fail('INVALID_SOURCE', 'Trusted picker must supply a bundle file or bounded buffer')
    let prefix
    if (Buffer.isBuffer(source)) prefix = source.subarray(0, MAGIC.length)
    else {
      const file = await fs.open(source, 'r')
      try { const bytes = Buffer.alloc(MAGIC.length); await file.read(bytes, 0, bytes.length, 0); prefix = bytes }
      finally { await file.close() }
    }
    const encrypted = prefix.equals(MAGIC)
    if (encrypted && !envelope) fail('CRYPTO_UNAVAILABLE', 'Encrypted bundle support is unavailable')
    let archive = source
    if (encrypted) {
      const input = Buffer.isBuffer(source) ? Readable.from([source]) : createReadStream(source)
      archive = await collectBounded(envelope.decrypt(input, password, { signal }), envelope.maxMemoryZipBytes, signal)
    }
    let manifest = null
    let events = null
    let stage = null
    let nextEntry = 0
    const expectedNames = ['manifest.json', 'events.jsonl', 'transcript.md']
    try {
      await codec.read(archive, async entry => {
        checkAbort(signal)
        if (entry.name !== expectedNames[nextEntry]) fail('UNEXPECTED_ENTRY', 'Archive entry order or name does not match manifest')
        nextEntry++
        if (entry.name === 'manifest.json') {
          const bytes = await collectBounded(entry.bytes(), MAX_MANIFEST, signal)
          manifest = parseCanonicalJson(bytes, MAX_MANIFEST)
          validateManifest(manifest)
          for (const object of manifest.objects) expectedNames.push(`objects/${object.sha256}`)
        } else if (entry.name === 'events.jsonl') {
          const bytes = await collectBounded(entry.bytes(), MAX_EVENTS, signal)
          if (sha256(bytes) !== manifest.eventsSha256) fail('EVENT_HASH', 'Event log hash is invalid')
          const graph = validateManifest(manifest)
          events = parseEvents(bytes, graph.nodeIds, graph.objectHashes)
          const usedHashes = new Set(manifest.nodes.flatMap(node => node.objects.map(ref => ref.sha256)))
          for (const event of events) if (event.objectHash) usedHashes.add(event.objectHash)
          if (usedHashes.size !== graph.objectHashes.size) fail('PRIVATE_OBJECT', 'Bundle contains objects outside the selected reference graph')
        } else if (entry.name === 'transcript.md') {
          const bytes = await collectBounded(entry.bytes(), MAX_TRANSCRIPT, signal)
          if (sha256(bytes) !== manifest.transcriptSha256) fail('TRANSCRIPT_HASH', 'Transcript hash is invalid')
          stage = await importStore.beginStage({ encryptedStaging: true, manifest })
          if (!stage || stage.encryptedStaging !== true || typeof stage.putObject !== 'function' || typeof stage.commitCopy !== 'function' || typeof stage.abort !== 'function') fail('UNSAFE_STAGE', 'Import requires encrypted, transactional staging')
        } else {
          const object = manifest.objects[nextEntry - 4]
          if (!object || entry.size !== object.size) fail('OBJECT_SIZE', 'Object entry size differs from manifest')
          let verified = false
          const stream = Readable.from((async function* () {
            const digest = createHash('sha256')
            let size = 0
            for await (const part of entry.bytes()) {
              checkAbort(signal)
              const bytes = asBuffer(part)
              size += bytes.length
              if (size > object.size) fail('OBJECT_SIZE', 'Object exceeds manifest size')
              digest.update(bytes)
              yield bytes
            }
            if (size !== object.size || digest.digest('hex') !== object.sha256) fail('OBJECT_HASH', 'Object hash is invalid')
            verified = true
          })())
          await stage.putObject({ sha256: object.sha256, size: object.size, stream })
          if (!verified) fail('OBJECT_NOT_CONSUMED', 'Staging did not consume and validate the complete object')
        }
      }, { signal })
      if (nextEntry !== expectedNames.length) fail('MISSING_ENTRY', 'Bundle is missing an object')
      if (!stage) fail('UNSAFE_STAGE', 'Import staging was not created')
      const importId = makeId()
      imports.set(importId, { stage, manifest, events })
      return { importId, mode: 'new-copy', encrypted, rootCount: manifest.roots.length, nodeCount: manifest.nodes.length, eventCount: events.length, objectCount: manifest.objects.length, objectBytes: manifest.objects.reduce((sum, object) => sum + object.size, 0), credentialPolicy: 'not restored', nativeBindings: 'not restored', executableState: 'not replayed' }
    } catch (error) { await stage?.abort().catch(() => {}); throw error }
  }

  async function cancelImport({ importId }) {
    const pending = imports.get(importId)
    if (!pending) return false
    imports.delete(importId)
    await pending.stage.abort()
    return true
  }

  async function applyNewCopy({ importId }) {
    const pending = imports.get(importId)
    if (!pending) fail('UNKNOWN_IMPORT', 'Validated import preview is unavailable')
    imports.delete(importId)
    const { manifest, events, stage } = pending
    const nodeMap = new Map(manifest.nodes.map(node => [node.id, makeId()]))
    const eventMap = new Map(events.map(event => [event.id, makeId()]))
    const roots = manifest.roots.map(id => nodeMap.get(id))
    const nodes = manifest.nodes.map(node => ({ ...node, id: nodeMap.get(node.id), scopeRootId: nodeMap.get(node.scopeRootId), refs: node.refs.map(id => nodeMap.get(id)) }))
    const copiedEvents = events.map(event => ({ ...event, id: eventMap.get(event.id), ownerId: nodeMap.get(event.ownerId) }))
    let committed = false
    try {
      const receipt = await stage.commitCopy({ roots, nodes, events: copiedEvents, lineage: { sourceManifestHash: manifest.contentSha256, sourceRoots: manifest.roots } })
      committed = true
      try {
        const reopened = await importStore.reopenRepresentative(roots)
        if (reopened !== true && reopened?.ok !== true) fail('REOPEN_FAILED', 'Committed references could not be reopened')
        return { status: 'imported-and-reopened', rootIds: roots, receipt }
      } catch (error) { return { status: 'committed-reopen-unverified', rootIds: roots, receipt, reason: error.code || 'REOPEN_FAILED' } }
    } finally { if (!committed) await stage.abort().catch(() => {}) }
  }

  return { planExport, exportPlan, cancelExport, inspectImport, applyNewCopy, cancelImport }
}
