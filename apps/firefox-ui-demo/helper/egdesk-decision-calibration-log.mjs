import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import path from 'node:path'
import { isOwnedAndPrivate } from './egdesk-private-files.mjs'

// Content-free local record for calibrating Decision thresholds later (canon §5.3:
// collect in advisory mode first, then fix the thresholds from labels).
// - It stores numbers and closed-vocabulary words only: probabilities, the threshold that was
//   applied, what that threshold would have done, and a coarse label for what happened next.
//   There is no field for message text, page text, item ids/titles, keys, URLs or model output;
//   record() rebuilds each entry from a whitelist, so a careless caller cannot add one.
// - Own file, mode 0600, in the private settings directory beside the key and the usage tally.
//   It is a settings-directory file, not part of any .egdesk export.
// - Bounded: at most MAX_ENTRIES entries, MAX_BYTES bytes and RETENTION_DAYS days; the oldest go first.
// - Time is a UTC day only. No clock time, so entries cannot be matched to a message by timing.
// - Recording never throws and never changes what a feature does.

export const CALIBRATION_FILE = 'egdesk-decision-calibration.json'
export const CALIBRATION_VERSION = 1
export const MAX_ENTRIES = 100
export const MAX_BYTES = 192 * 1024
export const RETENTION_DAYS = 30
const MAX_JUDGMENTS = 64

const FEATURES = new Set(['turn_context', 'dm_chooser', 'board_arrangement', 'browser_reflex'])
const MODES = new Set(['advisory', 'on'])
const QUESTIONS = new Set(['answer_type', 'time_intent', 'relevance', 'speech_axis', 'speech_predicate', 'recall', 'topic_route', 'choice', 'next_step', 'page_state', 'goal_met'])
const WOULD = new Set(['accept', 'reject', 'attach', 'skip', 'unknown', 'routed', 'none', 'act', 'hold'])
const FORCED = new Set(['mentioned', 'mandatory'])
const KINDS = new Set(['board', 'source', 'conversation', 'timeline', 'document'])
const SLICES = new Set(['past', 'present', 'planned', 'hypothetical', 'unknown'])
const AXES = new Set(['source', 'form', 'time'])
const PREDS = new Set(['relay', 'own_observation', 'inference', 'record', 'plan', 'conditional', 'question', 'before', 'after', 'at_utterance', 'ongoing', 'anchor_stated'])
// Schema vocabulary only. A value outside it is dropped, never stored as text.
const VOCAB = new Set(['answer', 'browse', 'timeline_update', 'action_only', 'present', 'past', 'planned', 'what_if', 'cross_time', 'not_time_specific',
  'self_reported_observation', 'attributed_report', 'inference', 'record_based', 'unspecified', 'unknown', 'assertion', 'plan', 'conditional', 'question',
  'past_anchored', 'past_unspecified', 'at_utterance', 'ongoing_no_end', 'future_anchored', 'future_unspecified'])
const RUN = new Set(['completed', 'failed', 'interrupted', 'cancelled'])
const FALLBACK = new Set(['timeout', 'unreachable', 'bad_response', 'no_credit', 'rate_limited', 'budget_exceeded', 'spend_limit_reached', 'invalid_key',
  'not_configured', 'server_error', 'model_unavailable', 'evidence_unavailable', 'mode_changed', 'no_candidates'])

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const prob = value => (Number.isFinite(value) && value >= 0 && value <= 1 ? Math.round(value * 1000) / 1000 : null)
const word = (set, value) => (typeof value === 'string' && set.has(value) ? value : null)
const count = (value, max) => (Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : null)
const errorCode = error => (typeof error?.code === 'string' && error.code) || error?.name || 'Error'
const defaultLog = message => { try { process.stderr.write(`[egdesk-decision] ${message}\n`) } catch {} }
const dayOf = ms => new Date(ms).toISOString().slice(0, 10)
const put = (out, key, value) => { if (value !== null && value !== undefined) out[key] = value }

function judgment(raw) {
  if (!record(raw)) return null
  const q = word(QUESTIONS, raw.q)
  const would = word(WOULD, raw.would)
  if (!q || !would) return null
  const out = { q, would }
  put(out, 'top', prob(raw.top)); put(out, 'second', prob(raw.second)); put(out, 'p', prob(raw.p)); put(out, 'threshold', prob(raw.threshold))
  put(out, 'minMargin', prob(raw.minMargin)); put(out, 'value', word(VOCAB, raw.value)); put(out, 'axis', word(AXES, raw.axis)); put(out, 'pred', word(PREDS, raw.pred))
  put(out, 'forced', word(FORCED, raw.forced)); put(out, 'kind', word(KINDS, raw.kind)); put(out, 'slice', word(SLICES, raw.slice))
  put(out, 'seg', count(raw.seg, 5))
  return out
}

/** Whitelist rebuild. Returns null for anything that is not a recognisable entry. */
export function normalizeEntry(raw, now = Date.now()) {
  if (!record(raw)) return null
  const feature = word(FEATURES, raw.feature), mode = word(MODES, raw.mode)
  if (!feature || !mode) return null
  const entry = { feature, mode, day: dayOf(now) }
  const list = Array.isArray(raw.judgments) ? raw.judgments.slice(0, MAX_JUDGMENTS).map(judgment).filter(Boolean) : []
  entry.judgments = list
  put(entry, 'candidates', count(raw.candidates, 1000)); put(entry, 'judgedTotal', count(raw.judgedTotal, 1000))
  put(entry, 'fallback', word(FALLBACK, raw.fallback)); put(entry, 'attached', typeof raw.attached === 'boolean' ? raw.attached : null)
  return entry
}

function normalizeOutcome(raw) {
  if (!record(raw)) return null
  const out = {}
  put(out, 'run', word(RUN, raw.run)); put(out, 'toolActivities', count(raw.toolActivities, 1000))
  return Object.keys(out).length ? out : null
}

function readPrivateFile(file) {
  let fd
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)) } catch (error) {
    if (error.code === 'ENOENT') return { missing: true }
    throw error
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1 || !isOwnedAndPrivate(file, info, 0o077) || info.size > MAX_BYTES * 2) throw new Error('not a private regular file')
    const buffer = Buffer.alloc(info.size)
    let read = 0
    while (read < buffer.length) { const n = readSync(fd, buffer, read, buffer.length - read, read); if (n === 0) break; read += n }
    return { text: buffer.subarray(0, read).toString('utf8') }
  } finally { closeSync(fd) }
}

function parseFile(text, now) {
  const data = JSON.parse(text)
  if (!record(data) || data.version !== CALIBRATION_VERSION || !Array.isArray(data.entries)) throw new Error('not a calibration log')
  const keep = []
  for (const row of data.entries) {
    const entry = normalizeEntry(row, Date.parse(`${row?.day}T00:00:00Z`))
    if (entry && row.day === entry.day) { const outcome = normalizeOutcome(row.outcome); keep.push(outcome ? { ...entry, outcome } : entry) }
  }
  return keep
}

/**
 * openCalibrationLog({ dataDir, log?, now? }) → { status, record(entry)→id|null, complete(id, outcome)→boolean, entries() }
 * status: 'saved' | 'missing' | 'recovered' | 'unavailable'. A broken or unavailable file only means nothing is kept on disk.
 */
export function openCalibrationLog({ dataDir, log = defaultLog, now = Date.now } = {}) {
  const say = message => { try { log(message) } catch {} }
  let status = 'unavailable', dir = null, file = null, writable = false
  let entries = []
  try {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw Object.assign(new Error('dataDir must be absolute'), { code: 'INVALID_DATA_DIR' })
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dataDir)
    dir = realpathSync.native(dataDir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedAndPrivate(dir, stat, 0o077)) throw Object.assign(new Error('not private'), { code: 'NOT_PRIVATE' })
    file = path.join(dir, CALIBRATION_FILE)
  } catch (error) { say(`decision calibration log unavailable (${errorCode(error)})`); dir = null; file = null }
  if (file) {
    try {
      const read = readPrivateFile(file)
      if (read.missing) { status = 'missing'; writable = true } else { entries = parseFile(read.text, now()); status = 'saved'; writable = true }
    } catch (error) {
      const aside = `${CALIBRATION_FILE}.corrupt-${now()}-${randomBytes(4).toString('hex')}`
      try { renameSync(file, path.join(dir, aside)); status = 'recovered'; writable = true; say(`${CALIBRATION_FILE} was not a valid log; kept it as ${aside}`) }
      catch (moveError) { status = 'unavailable'; say(`${CALIBRATION_FILE} could not be read (${errorCode(error)}/${errorCode(moveError)})`) }
    }
  }
  let sequence = 0
  const ids = new WeakMap()

  function prune() {
    const cutoff = dayOf(now() - RETENTION_DAYS * 86400000)
    entries = entries.filter(e => e.day >= cutoff).slice(-MAX_ENTRIES)
    while (entries.length > 1 && Buffer.byteLength(JSON.stringify({ version: CALIBRATION_VERSION, entries })) > MAX_BYTES) entries.shift()
  }
  function write() {
    const body = `${JSON.stringify({ version: CALIBRATION_VERSION, entries })}\n`
    const tmp = path.join(dir, `${CALIBRATION_FILE}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
    let fd = null
    try {
      fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600)
      const bytes = Buffer.from(body, 'utf8')
      let written = 0
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written)
      fsyncSync(fd); closeSync(fd); fd = null
      renameSync(tmp, file)
    } catch (error) { if (fd !== null) { try { closeSync(fd) } catch {} } try { unlinkSync(tmp) } catch {} throw error }
  }
  function save() {
    prune()
    if (!writable || !file) return false
    try { write(); status = 'saved'; return true } catch (error) { say(`${CALIBRATION_FILE} could not be saved (${errorCode(error)})`); return false }
  }

  return Object.freeze({
    get status() { return status },
    entries: () => entries.map(e => structuredClone(e)),
    record(raw) {
      try {
        const entry = normalizeEntry(raw, now())
        if (!entry) return null
        const id = `c${++sequence}`
        ids.set(entry, id)
        entries.push(entry); save()
        return id
      } catch { return null }
    },
    // The label arrives after the turn ends. An entry that was already pruned is simply not completed.
    complete(id, outcome) {
      try {
        const clean = normalizeOutcome(outcome)
        const entry = entries.find(e => ids.get(e) === id)
        if (!clean || !entry) return false
        entry.outcome = clean
        return save()
      } catch { return false }
    },
  })
}
