import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { REVIEW_BUNDLE_FORMAT as FORMAT, loadEGDeskPortableDependencies } from './egdesk-portable-bundle.mjs'
import { secretReason } from './egdesk-portable-extras.mjs'
import {
  MAX_PASSPHRASE_CHARS, REVIEW_FILE_PREFIX, classifyingEnvelope, createExportSink, ensureExportDirectory,
  homeRelativePath, mapExportError, mapReadError, portableExportLocation,
  portableExportPassphrase, portableSourceBytes,
} from './egdesk-portable-service.mjs'

// Uses the existing .egdesk ZIP and optional encrypted envelope, but not the
// Desk/Board graph format. Review has no store, source IDs, paths, or imports.
const VERSION = 1
const NAMES = ['manifest.json', 'events.jsonl', 'transcript.md']
export const REVIEW_MAX_BUNDLE_BYTES = 256 * 1024
export const REVIEW_TEXT_BYTES = Object.freeze({ recipient: 256, question: 2048, excerpt: 8192, expectedReply: 2048, answer: 8192 })
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const SHA256 = /^[a-f0-9]{64}$/
const requestKeys = ['recipient', 'question', 'excerpt', 'expectedReply']
const correlationKeys = ['requestId', 'requestDigest']
const fail = (code, message, httpStatus = 400) => { throw Object.assign(new Error(message), { code, httpStatus }) }
const invalid = () => fail('PORTABLE_REVIEW_INPUT', 'Invalid review fields, text, or correlation values')
const invalidFile = () => fail('PORTABLE_REVIEW_FILE_INVALID', 'The file is damaged or is not an EG-Desk review handoff')
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const cancelled = signal => { if (signal?.aborted) fail('PORTABLE_REVIEW_CANCELLED', 'The review operation was cancelled', 409) }

function text(value, key) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > REVIEW_TEXT_BYTES[key]) invalid()
  value = value.replace(/\r\n?/g, '\n').normalize('NFC')
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value.replace(/[\t\n]/g, ''))) invalid()
  value = value.trim()
  if ((!value && key !== 'excerpt') || Buffer.byteLength(value) > REVIEW_TEXT_BYTES[key] || (key === 'recipient' && /[\t\n\u2028\u2029]/u.test(value))) invalid()
  if (secretReason('review.txt', value)) fail('PORTABLE_REVIEW_SECRET_LIKE', `Remove apparent credentials from the review ${key}`)
  return value
}

function reviewValue(source, onDisk) {
  if (source?.kind === 'request') {
    if (!exact(source, ['kind', ...requestKeys, ...(onDisk ? correlationKeys : [])])) invalid()
    const disclosed = Object.fromEntries(requestKeys.map(key => [key, text(source[key], key)]))
    const requestId = onDisk ? source.requestId : randomUUID()
    // Correlation, not authentication. Domain separation fixes the v1 digest
    // definition; JSON keys here are emitted in one fixed order.
    const requestDigest = createHash('sha256').update(JSON.stringify({ format: FORMAT, version: VERSION, kind: 'request', ...disclosed })).digest('hex')
    if (typeof requestId !== 'string' || !UUID_V4.test(requestId) || (onDisk && source.requestDigest !== requestDigest)) invalid()
    return { kind: 'request', requestId, requestDigest, ...disclosed }
  }
  if (source?.kind !== 'reply' || !exact(source, ['kind', ...correlationKeys, 'answer'])) invalid()
  const { requestId, requestDigest } = source
  if (typeof requestId !== 'string' || !UUID_V4.test(requestId) || typeof requestDigest !== 'string' || !SHA256.test(requestDigest)) invalid()
  return { kind: 'reply', requestId, requestDigest, answer: text(source.answer, 'answer') }
}
const manifest = review => Buffer.from(JSON.stringify({ format: FORMAT, version: VERSION, review }))
function zip(codec, review, signal) {
  return codec.encode(NAMES.map((name, index) => {
    const bytes = index === 0 ? manifest(review) : Buffer.alloc(0)
    return { name, size: bytes.length, open: () => Readable.from([bytes]) }
  }), { signal, canonical: true })
}
async function collect(stream, signal) {
  let size = 0
  const parts = []
  for await (const chunk of stream) {
    cancelled(signal)
    size += chunk.length
    if (size > REVIEW_MAX_BUNDLE_BYTES) fail('PORTABLE_FILE_TOO_LARGE', 'The review file exceeds the size limit', 413)
    parts.push(chunk)
  }
  return Buffer.concat(parts, size)
}
async function readReview(codec, bytes, signal) {
  let index = 0
  let review
  await codec.read(bytes, async entry => {
    if (entry.name !== NAMES[index++] || (entry.name !== NAMES[0] && entry.size !== 0)) invalidFile()
    const content = await collect(entry.bytes(), signal)
    if (entry.name !== NAMES[0]) return
    const decoded = JSON.parse(content.toString('utf8'))
    if (!exact(decoded, ['format', 'version', 'review']) || decoded.format !== FORMAT || decoded.version !== VERSION) invalidFile()
    review = reviewValue(decoded.review, true)
    // Equality also rejects noncanonical text, duplicate JSON keys and non-UTF-8.
    if (!manifest(review).equals(content)) invalidFile()
  }, { signal, budget: { maxEntries: 3, maxUncompressedBytes: REVIEW_MAX_BUNDLE_BYTES, maxRatio: 100 } })
  // Decline hidden archive data too: no extra entries, ZIP comments, local
  // records, padding or incidental metadata beyond the fixed encoder profile.
  if (!review || !(await collect(zip(codec, review, signal), signal)).equals(bytes)) invalidFile()
  return review
}

export function createPortableReviewService({ location = () => portableExportLocation(), home = os.homedir(), dependencies } = {}) {
  let loading
  let active = false
  const load = () => {
    loading ??= (dependencies ? Promise.resolve(dependencies) : loadEGDeskPortableDependencies()).catch(() => {
      loading = null
      fail('PORTABLE_UNAVAILABLE', 'Portable review handoff is unavailable', 503)
    })
    return loading
  }
  async function exclusive(action, signal) {
    cancelled(signal)
    if (active) fail('PORTABLE_BUSY', 'Another review operation is running', 409)
    active = true
    try { return await action() } finally { active = false }
  }
  function checkedPassphrase(passphrase) {
    if (passphrase == null || passphrase === '') return null
    if (typeof passphrase !== 'string') invalid()
    return passphrase
  }
  return {
    async supported() {
      try {
        const { codec, envelope } = await load()
        return Boolean(location().directory && codec?.encode && codec?.read && envelope?.encrypt && envelope?.decrypt && envelope?.isEncryptedPrefix)
      } catch { return false }
    },
    exportReview({ review: input, passphrase } = {}, { signal } = {}) {
      return exclusive(async () => {
        const review = reviewValue(input, false)
        const secret = portableExportPassphrase(checkedPassphrase(passphrase))
        const { codec, envelope } = await load()
        let sink
        try {
          const archive = zip(codec, review, signal)
          const output = secret ? envelope.encrypt(archive, secret, { signal }) : archive
          // Prepare only bounded bytes in memory before touching the file system.
          const bytes = await collect(output, signal)
          cancelled(signal)
          const where = location()
          await ensureExportDirectory(where.directory)
          cancelled(signal)
          sink = await createExportSink(where.directory, `${REVIEW_FILE_PREFIX}${randomUUID()}.egdesk`)
          await pipeline(Readable.from([bytes]), sink.writable, { signal })
          cancelled(signal)
          const { fileName } = await sink.publish()
          return { review, fileName, displayPath: homeRelativePath(path.join(where.directory, fileName), home), fileRef: { exportFile: fileName }, encrypted: secret !== null }
        } catch (error) {
          await sink?.abort().catch(() => {})
          cancelled(signal)
          throw mapExportError(error)
        }
      }, signal)
    },
    inspectReview({ fileRef, bundle, passphrase } = {}, { signal } = {}) {
      return exclusive(async () => {
        const secret = checkedPassphrase(passphrase)
        if (secret !== null && secret.length > MAX_PASSPHRASE_CHARS) invalid()
        if ((fileRef === undefined) === (bundle === undefined) || (fileRef !== undefined && !exact(fileRef, ['exportFile']))) invalid()
        const source = await portableSourceBytes({ fileRef, bundle }, location, REVIEW_MAX_BUNDLE_BYTES)
        const { codec, envelope } = await load()
        cancelled(signal)
        const encrypted = envelope.isEncryptedPrefix(source)
        // Shared envelope does not expose an inner format or anything about the
        // sender. The file kind cannot be known until the passphrase is supplied.
        if (encrypted && !secret) return { encrypted: true, locked: true }
        let bytes = source
        if (encrypted) {
          try { bytes = await collect(classifyingEnvelope(envelope).decrypt(Readable.from([source]), secret, { signal }), signal) }
          catch (error) { cancelled(signal); throw mapReadError(error) }
        }
        try { return { review: await readReview(codec, bytes, signal), encrypted, locked: false } }
        catch (error) {
          cancelled(signal)
          if (error?.code === 'PORTABLE_FILE_TOO_LARGE') fail('PORTABLE_FILE_TOO_LARGE', 'The review file exceeds the size limit', 413)
          invalidFile()
        }
      }, signal)
    },
  }
}
