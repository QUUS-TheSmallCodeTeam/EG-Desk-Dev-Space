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
// Version 2 adds optional fields only (confidence, options, margin, noPick, outcome.next/keptN/removedN, feature board_reply, fallback timeout_unsent).
// Version 1 files still load. A file from a newer version is left untouched and nothing is written over it.
export const CALIBRATION_VERSION = 2
const OLDEST_READABLE = 1
export const MAX_ENTRIES = 100
export const MAX_BYTES = 192 * 1024
export const RETENTION_DAYS = 30
const MAX_JUDGMENTS = 64

// answer_briefing: the Answer Briefing judgments (placement, reuse, flow check, skeleton predicates), recorded apart from the Board arrangement (lane L2 finding A4).
const FEATURES = new Set(['turn_context', 'dm_chooser', 'board_arrangement', 'answer_briefing', 'board_reply', 'browser_reflex', 'terminal_state', 'terminal_gate', 'draft_check', 'turn_memory', 'conversation_flow', 'working_memory'])
const MODES = new Set(['advisory', 'on'])
const QUESTIONS = new Set(['answer_type', 'time_intent', 'relevance', 'speech_axis', 'speech_predicate', 'recall', 'topic_route', 'choice', 'next_step', 'page_state', 'goal_met', 'terminal_state', 'terminal_risk', 'log_block', 'claim_support', 'claim_present', 'term_internal', 'triage_courtesy', 'triage_need', 'triage_recall', 'triage_record', 'write_target', 'write_about', 'wm_block', 'wm_role',
  // the heartbeat's yes/no message questions (egdesk-conversation-flow.mjs FLOW_PREDICATES)
  'beat_note', 'beat_ask', 'beat_stalled', 'beat_pointer', 'beat_told',
  // the command gate's yes/no content predicates (egdesk-terminal-command-gate.mjs RISK_PREDICATES)
  'risk_unrestorable', 'risk_outside', 'risk_personal_files'])
const WOULD = new Set(['accept', 'reject', 'attach', 'skip', 'unknown', 'routed', 'none', 'act', 'hold', 'fetch'])
// Turn memory (advisory): where in the session the turn was, what the fetch did, and how long each stage took.
// Draft check (advisory): what the check would have done to the posted answer, and what it would fall back to without a revision.
const CHECKS = new Set(['would_pass', 'would_revise', 'would_trim', 'would_ask'])
// Heartbeat (conversation flow): what was chosen at an asked beat, who wrote a posted message, and the beat's facts as
// whole seconds and small counts. Durations only, never a clock time.
const FLOW_KINDS = new Set(['none', 'explain_wait', 'ask_missing', 'milestone', 'stalled', 'pointer'])
const POSTED = new Set(['none', 'model', 'fallback'])
const BEAT_PHASES = new Set(['thinking', 'tool_running', 'waiting_user', 'objective_step', 'idle'])
// Who proposed a question at a heartbeat (code names of features, never content). A new provider adds its name here.
const BEAT_PROVIDERS = new Set(['message', 'placement', 'attention', 'presence', 'browser_task', 'terminal_loop'])
const seconds = value => (Number.isFinite(value) && value >= 0 ? Math.min(3600, Math.round(value / 1000)) : null)
function beat(raw) {
  if (!record(raw)) return null
  const out = {}
  put(out, 'n', count(raw.n, 9999)); put(out, 'phase', word(BEAT_PHASES, raw.phase))
  put(out, 'sinceUserS', seconds(raw.sinceUserMs)); put(out, 'sincePostedS', seconds(raw.sincePostedMs)); put(out, 'sinceEngineS', seconds(raw.sinceEngineMs))
  put(out, 'stepsDone', count(raw.stepsDone, 999)); put(out, 'stepsRunning', count(raw.stepsRunning, 99)); put(out, 'decisionMs', ms(raw.decisionMs))
  return Object.keys(out).length ? out : null
}
const POSITIONS = new Set(['first', 'mid'])
const WM_OUTPUT_KINDS = new Set(['build', 'terminal', 'search', 'page', 'subagent', 'tool'])
const WM_BY = new Set(['rules', 'decision', 'none'])
const MEMORY = new Set(['ran', 'skipped', 'partial', 'fallback', 'empty'])
const ms = value => (Number.isFinite(value) && value >= 0 ? Math.min(120000, Math.round(value / 10) * 10) : null)
function timing(raw) {
  if (!record(raw)) return null
  const out = {}
  for (const key of ['prepMs', 'triageMs', 'fetchMs', 'writeMs', 'totalMs']) put(out, key, ms(raw[key]))
  put(out, 'calls', count(raw.calls, 50)); put(out, 'withinBudget', typeof raw.withinBudget === 'boolean' ? raw.withinBudget : null)
  return Object.keys(out).length ? out : null
}
// Terminal (advisory first): the judged state, where it came from, what the system would do, and for a command what the rules and the score said.
// Closed words, booleans and one rounded number only: never a command, a path or output text.
const TERMINAL_STATES = new Set(['running_output', 'waiting_yn_input', 'waiting_password', 'stuck_in_pager', 'completed_ok', 'completed_error', 'need_user_context', 'cannot_proceed'])
const TERMINAL_SOURCES = new Set(['runtime', 'rule', 'decision', 'fallback'])
const TERMINAL_WOULD = new Set(['wait', 'hand_yes_no', 'hand_secret', 'quit_pager', 'hand_close_pager', 'report', 'repair', 'hand_subjective'])
const TERMINAL_CHECKS = new Set(['read', 'exit', 'beat', 'quiet'])
// Where the judged output came from: a Terminal card (the person's own shell) or a command the run's engine executed.
const TERMINAL_STREAMS = new Set(['card', 'engine'])
const GATE_REASONS = new Set(['unresolved_target', 'protected_target', 'outside_cwd', 'tracked_files', 'dirty_worktree', 'remote_irreversible', 'privileged', 'remote_script',
  'discards_history', 'deletes_untracked', 'publishes', 'container_data', 'database_destructive', 'risk_score', 'risk_unsure', 'risk_unrestorable', 'risk_outside', 'risk_personal_files'])
const GATE_METHODS = new Set(['predicates', 'score'])
const GATE_ENGINES = new Set(['codex', 'claude'])
const flagOf = value => (typeof value === 'boolean' ? value : null)
function terminalFields(raw) {
  if (!record(raw)) return null
  const out = {}
  put(out, 'state', word(TERMINAL_STATES, raw.state)); put(out, 'source', word(TERMINAL_SOURCES, raw.source)); put(out, 'would', word(TERMINAL_WOULD, raw.would))
  put(out, 'check', word(TERMINAL_CHECKS, raw.check)); put(out, 'acted', flagOf(raw.acted)); put(out, 'agentOwned', flagOf(raw.agentOwned))
  put(out, 'stream', word(TERMINAL_STREAMS, raw.stream)); put(out, 'engine', word(GATE_ENGINES, raw.engine))
  // Which runtime-enumerated log blocks would be highlighted: their ordinal numbers only (1..12), never their text.
  const picked = Array.isArray(raw.picked) ? [...new Set(raw.picked.filter(n => Number.isSafeInteger(n) && n >= 1 && n <= 12))].slice(0, 12) : []
  if (picked.length) out.picked = picked
  return Object.keys(out).length ? out : null
}
function gateFields(raw) {
  if (!record(raw)) return null
  const out = {}
  put(out, 'rule', flagOf(raw.rule)); put(out, 'would', flagOf(raw.would)); put(out, 'scored', flagOf(raw.scored)); put(out, 'gitFacts', flagOf(raw.gitFacts)); put(out, 'sessionWithheld', flagOf(raw.sessionWithheld))
  const reasons = Array.isArray(raw.reasons) ? [...new Set(raw.reasons.filter(reason => typeof reason === 'string' && GATE_REASONS.has(reason)))].slice(0, 6) : []
  if (reasons.length) out.reasons = reasons
  put(out, 'score', Number.isFinite(raw.score) && raw.score >= 0 && raw.score <= 4 ? Math.round(raw.score * 10) / 10 : null)
  put(out, 'engine', word(GATE_ENGINES, raw.engine)); put(out, 'method', word(GATE_METHODS, raw.method))
  return Object.keys(out).length ? out : null
}
const FORCED = new Set(['mentioned', 'mandatory'])
const KINDS = new Set(['board', 'source', 'conversation', 'timeline', 'document'])
const SLICES = new Set(['past', 'present', 'planned', 'hypothetical', 'unknown'])
const AXES = new Set(['source', 'form', 'time'])
const PREDS = new Set(['relay', 'own_observation', 'inference', 'record', 'plan', 'conditional', 'question', 'before', 'after', 'at_utterance', 'ongoing', 'anchor_stated'])
// Schema vocabulary only. A value outside it is dropped, never stored as text.
const VOCAB = new Set(['answer', 'browse', 'timeline_update', 'action_only', 'present', 'past', 'planned', 'what_if', 'cross_time', 'not_time_specific',
  'self_reported_observation', 'attributed_report', 'inference', 'record_based', 'unspecified', 'unknown', 'assertion', 'plan', 'conditional', 'question',
  'past_anchored', 'past_unspecified', 'at_utterance', 'ongoing_no_end', 'future_anchored', 'future_unspecified',
  'supported', 'contradicted', 'not_mentioned', 'insufficient',
  // Working-memory gate: what the runtime would do with a tool-output block, and the role of an older session block.
  'inject_full', 'collapse_template', 'spill_scratch', 'user_goal', 'current_active_task', 'stale_intermediate_log', 'error_trace_resolved', 'critical_fact'])
const RUN = new Set(['completed', 'failed', 'interrupted', 'cancelled'])
const FALLBACK = new Set(['timeout', 'unreachable', 'bad_response', 'no_credit', 'rate_limited', 'budget_exceeded', 'spend_limit_reached', 'invalid_key',
  'not_configured', 'server_error', 'model_unavailable', 'evidence_unavailable', 'mode_changed', 'no_candidates', 'timeout_unsent'])
// Why a choice produced no pick although the model answered (closed; never free text).
const NO_PICK = new Set(['abstain', 'unclear', 'low_confidence'])
// The user's next explicit action after the decision, per feature. A label from another feature's vocabulary is dropped.
export const NEXT_LABELS = Object.freeze({
  dm_chooser: Object.freeze(['asked_why', 'asked_agent', 'edited', 'retried', 'closed', 'sent_ordinary']),
  board_arrangement: Object.freeze(['applied', 'undone', 'rejected', 'kept_own', 'timed_out']),
})
const MAX_SMALL = 99

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
// Rounding must not move a number across the bar that was applied to it (0.7999999999999999 against 0.8 must stay below).
const sideRound = (value, bar, digits) => {
  const scale = 10 ** digits
  let r = Math.round(value * scale) / scale
  const barOk = Number.isFinite(bar) && bar >= 0 && bar <= 1
  if (barOk && value < bar && r >= bar) r = Math.round((bar - 1 / scale) * scale) / scale
  if (barOk && value >= bar && r < bar) r = Math.round(bar * scale) / scale
  return r
}
const probVs = (value, bar, digits) => (Number.isFinite(value) && value >= 0 && value <= 1 ? sideRound(value, bar, digits) : null)
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
  put(out, 'top', probVs(raw.top, raw.threshold, 3)); put(out, 'second', prob(raw.second)); put(out, 'p', probVs(raw.p, raw.threshold, 3)); put(out, 'threshold', prob(raw.threshold))
  put(out, 'minMargin', prob(raw.minMargin)); put(out, 'value', word(VOCAB, raw.value)); put(out, 'axis', word(AXES, raw.axis)); put(out, 'pred', word(PREDS, raw.pred))
  put(out, 'forced', word(FORCED, raw.forced)); put(out, 'kind', word(KINDS, raw.kind)); put(out, 'slice', word(SLICES, raw.slice))
  put(out, 'seg', count(raw.seg, 5))
  // Chance-corrected confidence as the API reports it, the number of allowed values N it was corrected against, and the winner's margin.
  // Four decimals so a replay of the product's bar agrees with the product at the boundary.
  put(out, 'confidence', probVs(raw.confidence, raw.threshold, 4)); put(out, 'margin', probVs(raw.margin, raw.minMargin, 4))
  put(out, 'options', Number.isSafeInteger(raw.options) && raw.options >= 2 && raw.options <= 255 ? raw.options : null)
  put(out, 'noPick', word(NO_PICK, raw.noPick)); put(out, 'provider', word(BEAT_PROVIDERS, raw.provider))
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
  put(entry, 'check', word(CHECKS, raw.check)); put(entry, 'ifUnrevised', word(CHECKS, raw.ifUnrevised))
  if (record(raw.evidence)) {
    const counts = {}
    for (const key of ['items', 'opaque', 'sentences', 'terms']) put(counts, key, count(raw.evidence[key], 99))
    if (Object.keys(counts).length) entry.evidence = counts
  }
  put(entry, 'flow', word(FLOW_KINDS, raw.flow)); put(entry, 'posted', word(POSTED, raw.posted)); put(entry, 'beat', beat(raw.beat)); put(entry, 'questions', count(raw.questions, 16))
  // Working-memory gate: sizes only (blocks, lines, estimated tokens before and after), the output kind and who chose. Never text.
  if (feature === 'working_memory' && record(raw.wm)) {
    const wm = {}
    for (const key of ['blocks', 'omittedBlocks']) put(wm, key, count(raw.wm[key], 99))
    for (const key of ['linesBefore', 'linesAfter', 'tokensBefore', 'tokensAfter']) put(wm, key, count(raw.wm[key], 10_000_000))
    put(wm, 'kind', word(WM_OUTPUT_KINDS, raw.wm.kind)); put(wm, 'by', word(WM_BY, raw.wm.by)); put(wm, 'spill', typeof raw.wm.spill === 'boolean' ? raw.wm.spill : null)
    put(wm, 'overLimit', raw.wm.overLimit === true ? true : null)
    if (Object.keys(wm).length) entry.wm = wm
  }
  put(entry, 'position', word(POSITIONS, raw.position)); put(entry, 'memory', word(MEMORY, raw.memory)); put(entry, 'timing', timing(raw.timing))
  put(entry, 'fallback', word(FALLBACK, raw.fallback)); put(entry, 'attached', typeof raw.attached === 'boolean' ? raw.attached : null)
  if (feature === 'terminal_state') put(entry, 'terminal', terminalFields(raw.terminal))
  if (feature === 'terminal_gate') put(entry, 'gate', gateFields(raw.gate))
  return entry
}

function normalizeOutcome(raw, feature = null) {
  if (!record(raw)) return null
  const out = {}
  put(out, 'run', word(RUN, raw.run)); put(out, 'toolActivities', count(raw.toolActivities, 1000))
  const next = typeof raw.next === 'string' && NEXT_LABELS[feature]?.includes(raw.next) ? raw.next : null
  put(out, 'next', next)
  // Board reply screening: how many of the Agent's excerpts the owner kept or removed. Small integers only.
  if (feature === 'board_reply') { put(out, 'keptN', count(raw.keptN, MAX_SMALL)); put(out, 'removedN', count(raw.removedN, MAX_SMALL)) }
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
  if (record(data) && Number.isSafeInteger(data.version) && data.version > CALIBRATION_VERSION) return { unsupported: true }
  if (!record(data) || !Number.isSafeInteger(data.version) || data.version < OLDEST_READABLE || !Array.isArray(data.entries)) throw new Error('not a calibration log')
  const keep = []
  for (const row of data.entries) {
    const entry = normalizeEntry(row, Date.parse(`${row?.day}T00:00:00Z`))
    if (entry && row.day === entry.day) { const outcome = normalizeOutcome(row.outcome, entry.feature); keep.push(outcome ? { ...entry, outcome } : entry) }
  }
  return { entries: keep }
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
      if (read.missing) { status = 'missing'; writable = true } else {
        const parsed = parseFile(read.text, now())
        if (parsed.unsupported) { status = 'unsupported'; say(`${CALIBRATION_FILE} is from a newer EG-Desk; it is left as is`) }
        else { entries = parsed.entries; status = 'saved'; writable = true }
      }
    } catch (error) {
      const aside = `${CALIBRATION_FILE}.corrupt-${now()}-${randomBytes(4).toString('hex')}`
      try { renameSync(file, path.join(dir, aside)); status = 'recovered'; writable = true; say(`${CALIBRATION_FILE} was not a valid log; kept it as ${aside}`) }
      catch (moveError) { status = 'unavailable'; say(`${CALIBRATION_FILE} could not be read (${errorCode(error)}/${errorCode(moveError)})`) }
    }
  }
  // Opaque, process-local handles. Nothing that identifies a record is ever written to the file.
  const handles = new WeakMap()

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
        const handle = Object.freeze({})
        handles.set(handle, entry)
        entries.push(entry); save()
        return handle
      } catch { return null }
    },
    // The label arrives after the turn ends. An entry that was already pruned is simply not completed.
    // Labels merge: a field that is already set is not overwritten, so the first explicit next action wins.
    complete(handle, outcome) {
      try {
        const entry = handle !== null && typeof handle === 'object' ? handles.get(handle) : undefined
        if (!entry || !entries.includes(entry)) return false
        const clean = normalizeOutcome(outcome, entry.feature)
        if (!clean) return false
        const merged = { ...(entry.outcome || {}) }
        let changed = false
        for (const [key, value] of Object.entries(clean)) if (!Object.hasOwn(merged, key)) { merged[key] = value; changed = true }
        if (!changed) return false
        entry.outcome = merged
        return save()
      } catch { return false }
    },
  })
}

/** Attach a label later, from anywhere that holds the handle record() returned. Never throws; false when there is nothing to label. */
export function attachLabel(log, handle, outcome) {
  try { return typeof log?.complete === 'function' && handle ? log.complete(handle, outcome) === true : false } catch { return false }
}

/** The API's choice confidence is the chance-corrected top probability: (top - 1/N) / (1 - 1/N). */
export function chanceCorrected(top, options) {
  return Number.isFinite(top) && Number.isSafeInteger(options) && options >= 2 ? (top - 1 / options) / (1 - 1 / options) : null
}

/**
 * Replay the product's bar from one recorded choice judgment: 'accept' | 'reject' | null (not enough recorded numbers).
 * The bar is the recorded confidence >= threshold and winner margin >= minMargin; the DM chooser also requires the top
 * probability itself to clear the bar. Rounding keeps every number on the side of the bar it was on, so the replay
 * agrees with the product exactly at the boundary.
 */
export function replayGate(feature, j) {
  if (!record(j)) return null
  const margin = Number.isFinite(j.margin) ? j.margin : Number.isFinite(j.top) && Number.isFinite(j.second) ? j.top - j.second : null
  if (![j.confidence, j.threshold, j.minMargin, margin].every(Number.isFinite)) return null
  let ok = j.confidence >= j.threshold && margin >= j.minMargin
  if (feature === 'dm_chooser') ok = ok && Number.isFinite(j.top) && j.top >= j.threshold
  return ok ? 'accept' : 'reject'
}
