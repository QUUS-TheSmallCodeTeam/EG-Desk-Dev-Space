import { createHash } from 'node:crypto'
import path from 'node:path'
import { publicText } from './codex-chat-values.mjs'
import { DECISION_CREDENTIAL_FILE } from './egdesk-decision-credential.mjs'

// RT-03 opt-in extras for the .egdesk bundle: attachments (context captures)
// and File drafts (managed working copies). Both are OFF unless the export
// request turns them on (D-R3). Each entry is one JSON payload carrying its
// bytes (base64) and their sha256; the root payload carries a manifest of what
// was included and what was left out and why. Import re-validates every entry
// (plain file name only, hash, size, manifest match) before anything is
// written, writes attachments as new capture copies and drafts as new
// disconnected drafts, and never touches an original file.
//
// Provider contracts (all optional; missing = unavailable):
//   attachments: { exportList({scope, boardIds, threadIds, draftIds}) → [{name, mime, size?, read() → bytes}],
//                  importCopy({name, mime, bytes, sha256}) → {id} }
//   fileDrafts:  { exportList({scope, boardIds, threadIds, draftIds}) → [{id?, name, text}],
//                  importDraft({name, text, sha256}) → {draftId} }
// threadIds/draftIds: arrays of what the exported Board's cards refer to, or
// null for a Desk export (everything this machine keeps).
export const PORTABLE_EXTRA_LIMITS = Object.freeze({
  maxAttachments: 200,
  maxAttachmentBytes: 8 * 1024 * 1024,
  maxAttachmentsTotalBytes: 24 * 1024 * 1024,
  maxFileDrafts: 200,
  maxFileDraftBytes: 1024 * 1024,
  maxFileDraftsTotalBytes: 8 * 1024 * 1024,
})
export const EXTRA_KIND = Object.freeze({ attachment: 'egdesk.portable.attachment', fileDraft: 'egdesk.portable.fileDraft' })
export const OMIT_REASONS = Object.freeze(['secret', 'too-large', 'limit', 'unreadable', 'unsafe-name'])
const MAX_NAME_CHARS = 255
const MAX_MIME_CHARS = 128
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}(?:;\s?charset=[a-z0-9_-]{1,32})?$/i
const SHA256 = /^[0-9a-f]{64}$/
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/

// File names that hold credentials. These never leave the machine even when
// the user asked for attachments or drafts: bridge settings, the decision
// credential key file, env files, private keys, keychains and token stores.
const SECRET_NAMES = [
  /^\.env(?:\..*)?$/i, /^\.?netrc$/i, /^\.npmrc$/i, /^\.pypirc$/i, /^\.git-credentials$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i, /\.(?:pem|key|p12|pfx|jks|keystore|keychain(?:-db)?|kdbx|ppk|asc|gpg)$/i,
  /^bridge-settings\.json/i, new RegExp(`^${DECISION_CREDENTIAL_FILE.replace(/[.]/g, '\\.')}`, 'i'),
  /^auth\.json$/i, /^credentials(?:\.[a-z]+)?$/i, /^(?:client[_-]?)?secrets?(?:\.[a-z]+)?$/i,
  /^(?:access[_-]?|refresh[_-]?|api[_-]?)?tokens?(?:\.(?:json|txt|ya?ml|env))?$/i, /^cookies(?:\.sqlite)?$/i, /^logins\.json$/i, /^key[34]\.db$/i,
]
const TEXT_MIME = /^(?:text\/|application\/(?:json|xml|javascript|x-yaml|yaml|toml))/i

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
function fail(code, message, httpStatus = 400, extra = {}) {
  throw Object.assign(new Error(message), { code, httpStatus }, extra)
}
const unsafeEntry = reason => fail('PORTABLE_ENTRY_UNSAFE', 'The file holds an attachment or draft with an unsafe name or content; nothing was imported', 400, { reason })

/** True for a plain file name: no folders, no traversal, not absolute, no control characters. */
export function isSafeEntryName(name) {
  if (typeof name !== 'string' || !name || name.length > MAX_NAME_CHARS) return false
  if (name !== name.normalize('NFC') || name.trim() !== name) return false
  if (/[\u0000-\u001f\u007f/\\:]/.test(name) || name === '.' || name === '..' || name.startsWith('..')) return false
  if (path.posix.isAbsolute(name) || path.win32.isAbsolute(name) || /^~/.test(name)) return false
  return path.posix.basename(name) === name && path.win32.basename(name) === name
}
/** 'secret' when the name or text looks like a credential, else null. */
export function secretReason(name, text = null) {
  if (SECRET_NAMES.some(pattern => pattern.test(name))) return 'secret'
  if (typeof text === 'string' && publicText(text, Number.MAX_SAFE_INTEGER) !== text) return 'secret'
  return null
}
/** Portable text projections are UTF-8 without NUL; MIME is only metadata. */
export function decodeAttachmentText(bytes) {
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return null }
  return text.includes('\0') ? null : text
}
function attachmentSecretReason(name, mime, bytes) {
  // Also retain the original scan for declared text whose UTF-8 is imperfect.
  const text = decodeAttachmentText(bytes) ?? (TEXT_MIME.test(mime) ? bytes.toString('utf8') : null)
  return secretReason(name, text)
}
const displayName = name => typeof name === 'string' && isSafeEntryName(name) ? name : null

async function readAttachment(item) {
  const bytes = typeof item.read === 'function' ? await item.read() : item.bytes
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new Error('unreadable')
  return Buffer.from(bytes)
}

/**
 * Export side. Returns {entries: [{type, title, payload}], manifest} where
 * manifest = {attachments, fileDrafts}: null when not requested, else
 * {included: [{name, bytes, sha256}], omitted: [{name, reason}]}.
 * Provider failures for one entry omit that entry ('unreadable'); a missing
 * provider for a requested kind fails the export (nothing is written).
 */
export async function collectPortableExtras({ attachments, fileDrafts, include, scope, boardIds, threadIds = null, draftIds = null, limits = PORTABLE_EXTRA_LIMITS }) {
  const entries = []
  const request = { scope, boardIds: [...boardIds], threadIds: threadIds && [...threadIds], draftIds: draftIds && [...draftIds] }
  const manifest = { attachments: null, fileDrafts: null }
  if (include.attachments) {
    if (!attachments?.exportList) fail('PORTABLE_ATTACHMENT_STORE_UNAVAILABLE', 'Attachment storage is unavailable', 503)
    const listed = await attachments.exportList(request)
    const section = { included: [], omitted: [] }
    let total = 0
    for (const item of Array.isArray(listed) ? listed : []) {
      const name = displayName(item?.name)
      const omit = reason => section.omitted.push({ name, reason })
      if (!name) { omit('unsafe-name'); continue }
      if (secretReason(name)) { omit('secret'); continue }
      if (section.included.length >= limits.maxAttachments) { omit('limit'); continue }
      if (Number.isSafeInteger(item.size) && item.size > limits.maxAttachmentBytes) { omit('too-large'); continue }
      let bytes
      try { bytes = await readAttachment(item) } catch { omit('unreadable'); continue }
      if (bytes.length > limits.maxAttachmentBytes) { omit('too-large'); continue }
      if (total + bytes.length > limits.maxAttachmentsTotalBytes) { omit('limit'); continue }
      const mime = typeof item.mime === 'string' && MIME.test(item.mime) ? item.mime : 'application/octet-stream'
      if (attachmentSecretReason(name, mime, bytes)) { omit('secret'); continue }
      total += bytes.length
      const hash = sha256(bytes)
      section.included.push({ name, bytes: bytes.length, sha256: hash })
      entries.push({ type: 'attachment', title: name, payload: { kind: EXTRA_KIND.attachment, v: 1, name, mime, bytes: bytes.length, sha256: hash, data: bytes.toString('base64') } })
    }
    manifest.attachments = section
  }
  if (include.fileDrafts) {
    if (!fileDrafts?.exportList) fail('PORTABLE_DRAFT_STORE_UNAVAILABLE', 'File draft storage is unavailable', 503)
    const listed = await fileDrafts.exportList(request)
    const section = { included: [], omitted: [] }
    let total = 0
    for (const item of Array.isArray(listed) ? listed : []) {
      const name = displayName(item?.name)
      const omit = reason => section.omitted.push({ name, reason })
      if (!name) { omit('unsafe-name'); continue }
      if (typeof item.text !== 'string' || item.text.includes('\0') || !item.text.isWellFormed()) { omit('unreadable'); continue }
      if (secretReason(name, item.text)) { omit('secret'); continue }
      if (section.included.length >= limits.maxFileDrafts) { omit('limit'); continue }
      const bytes = Buffer.from(item.text, 'utf8')
      if (bytes.length > limits.maxFileDraftBytes) { omit('too-large'); continue }
      if (total + bytes.length > limits.maxFileDraftsTotalBytes) { omit('limit'); continue }
      total += bytes.length
      const hash = sha256(bytes)
      section.included.push({ name, bytes: bytes.length, sha256: hash })
      // sourceId lets Board File cards follow the draft to its new ID on import.
      const sourceId = typeof item.id === 'string' && SOURCE_ID.test(item.id) ? item.id : null
      entries.push({ type: 'fileDraft', title: name, payload: { kind: EXTRA_KIND.fileDraft, v: 1, name, sourceId, bytes: bytes.length, sha256: hash, text: item.text } })
    }
    manifest.fileDrafts = section
  }
  return { entries, manifest }
}

function validSection(section, limitCount) {
  if (section === null) return true
  if (!plain(section) || Object.keys(section).length !== 2 || !Array.isArray(section.included) || !Array.isArray(section.omitted)) return false
  if (section.included.length > limitCount || section.omitted.length > 10_000) return false
  return section.included.every(item => plain(item) && Object.keys(item).length === 3 && isSafeEntryName(item.name)
      && Number.isSafeInteger(item.bytes) && item.bytes >= 0 && SHA256.test(item.sha256))
    && section.omitted.every(item => plain(item) && Object.keys(item).length === 2
      && (item.name === null || isSafeEntryName(item.name)) && OMIT_REASONS.includes(item.reason))
}
/** Validates the root's extras manifest shape against include; throws PORTABLE_FILE_DAMAGED-style via damaged(). */
export function validateExtrasManifest(manifest, include, damaged, limits = PORTABLE_EXTRA_LIMITS) {
  if (!plain(manifest) || Object.keys(manifest).length !== 2 || !Object.hasOwn(manifest, 'attachments') || !Object.hasOwn(manifest, 'fileDrafts')) damaged('INVALID_CONTENT')
  if ((manifest.attachments !== null) !== include.attachments || (manifest.fileDrafts !== null) !== include.fileDrafts) damaged('MANIFEST_MISMATCH')
  if (!validSection(manifest.attachments, limits.maxAttachments) || !validSection(manifest.fileDrafts, limits.maxFileDrafts)) damaged('INVALID_CONTENT')
  for (const section of [manifest.attachments, manifest.fileDrafts]) {
    for (const item of section?.included ?? []) if (secretReason(item.name)) unsafeEntry('SECRET_ENTRY')
  }
}

/**
 * Import side: one entry payload → {name, mime?, bytes(Buffer)|text, sha256}.
 * Rejects (whole import) unsafe names, credential-like content, wrong hashes or sizes.
 */
export function parseExtraEntry(value, damaged, limits = PORTABLE_EXTRA_LIMITS) {
  if (value.kind === EXTRA_KIND.attachment) {
    const keys = ['kind', 'v', 'name', 'mime', 'bytes', 'sha256', 'data']
    if (!plain(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) damaged('INVALID_CONTENT')
    if (!isSafeEntryName(value.name)) unsafeEntry('UNSAFE_NAME')
    if (secretReason(value.name)) unsafeEntry('SECRET_ENTRY')
    if (typeof value.mime !== 'string' || value.mime.length > MAX_MIME_CHARS || !MIME.test(value.mime)) damaged('INVALID_CONTENT')
    if (!Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > limits.maxAttachmentBytes) unsafeEntry('ENTRY_TOO_LARGE')
    if (typeof value.data !== 'string' || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) damaged('INVALID_CONTENT')
    const bytes = Buffer.from(value.data, 'base64')
    if (bytes.length !== value.bytes || typeof value.sha256 !== 'string' || sha256(bytes) !== value.sha256) unsafeEntry('HASH_MISMATCH')
    if (attachmentSecretReason(value.name, value.mime, bytes)) unsafeEntry('SECRET_ENTRY')
    return { type: 'attachment', name: value.name, mime: value.mime, bytes, sha256: value.sha256 }
  }
  if (value.kind === EXTRA_KIND.fileDraft) {
    const keys = ['kind', 'v', 'name', 'sourceId', 'bytes', 'sha256', 'text']
    if (!plain(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) damaged('INVALID_CONTENT')
    if (!isSafeEntryName(value.name)) unsafeEntry('UNSAFE_NAME')
    if (secretReason(value.name)) unsafeEntry('SECRET_ENTRY')
    if (typeof value.text !== 'string' || value.text.includes('\0') || !value.text.isWellFormed()) damaged('INVALID_CONTENT')
    if (value.sourceId !== null && (typeof value.sourceId !== 'string' || !SOURCE_ID.test(value.sourceId))) damaged('INVALID_CONTENT')
    if (!Number.isSafeInteger(value.bytes) || value.bytes > limits.maxFileDraftBytes) unsafeEntry('ENTRY_TOO_LARGE')
    const bytes = Buffer.from(value.text, 'utf8')
    if (bytes.length !== value.bytes || typeof value.sha256 !== 'string' || sha256(bytes) !== value.sha256) unsafeEntry('HASH_MISMATCH')
    if (secretReason(value.name, value.text)) unsafeEntry('SECRET_ENTRY')
    return { type: 'fileDraft', name: value.name, sourceId: value.sourceId, text: value.text, sha256: value.sha256 }
  }
  return null
}
/** The manifest's included lists must equal the entries actually present (order and hash). */
export function matchExtrasManifest(manifest, attachments, fileDrafts, damaged, limits = PORTABLE_EXTRA_LIMITS) {
  const same = (section, items) => (section?.included ?? []).length === items.length
    && items.every((item, index) => section.included[index].name === item.name && section.included[index].sha256 === item.sha256)
  if (!same(manifest.attachments, attachments) || !same(manifest.fileDrafts, fileDrafts)) damaged('MANIFEST_MISMATCH')
  const total = list => list.reduce((sum, item) => sum + (item.bytes?.length ?? Buffer.byteLength(item.text)), 0)
  if (total(attachments) > limits.maxAttachmentsTotalBytes || total(fileDrafts) > limits.maxFileDraftsTotalBytes) unsafeEntry('ENTRY_TOO_LARGE')
}
/** Count of entries the import will write, plus the exporter's omissions (names and reasons only). */
export function summarizeExtras(model) {
  const omitted = section => (section?.omitted ?? []).length
  return {
    attachments: model.attachments.length, fileDrafts: model.fileDrafts.length,
    omitted: { attachments: omitted(model.extras?.attachments), fileDrafts: omitted(model.extras?.fileDrafts) },
  }
}
/**
 * Writes new copies. Never passes a path, file ID or root to a provider, so an
 * original cannot be targeted. Drafts go first so the caller can point Board
 * File cards at their new IDs (returned map: source draft ID → new draft ID).
 */
export async function writePortableDrafts(model, { fileDrafts }, written) {
  const idMap = new Map()
  for (const item of model.fileDrafts) {
    const created = await fileDrafts.importDraft({ name: item.name, text: item.text, sha256: item.sha256 })
    const draftId = typeof created?.draftId === 'string' ? created.draftId : null
    if (item.sourceId && draftId) idMap.set(item.sourceId, draftId)
    written.fileDrafts.push({ draftId, name: item.name, status: 'draft', original: 'not-connected' })
  }
  return idMap
}
export async function writePortableAttachments(model, { attachments }, written) {
  for (const item of model.attachments) {
    const created = await attachments.importCopy({ name: item.name, mime: item.mime, bytes: Buffer.from(item.bytes), sha256: item.sha256 })
    written.attachments.push({ id: typeof created?.id === 'string' ? created.id : null, name: item.name, bytes: item.bytes.length })
  }
}
