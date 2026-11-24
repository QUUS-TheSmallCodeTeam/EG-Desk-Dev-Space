import { createHmac, randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { guardBridgeRequest, readJsonBody, sendJson } from './codex-bridge-http.mjs'
import { createDecisionClient, DECISIONS_ENDPOINT, DECISION_MODEL, FOREGROUND_DECISION_TIMEOUT_MS } from './egdesk-decision-client.mjs'
import { DEFAULT_DECISION_THRESHOLDS } from './egdesk-decision-questions.mjs'
import { normalizeBoardPresentationScene, prepareBoardPresentation, readBoardPresentation } from './egdesk-board-presentation-plan.mjs'
import { canvasCheckCalibrationEntry, prepareCanvasDesignCheck, readCanvasDesignCheck } from './egdesk-canvas-design-check.mjs'
import { briefingCheckCalibrationEntry, briefingReuseCalibrationEntry, placementCalibrationEntry, prepareBriefingCheck, prepareBriefingPlacement, prepareBriefingReuse, readBriefingCheck, readBriefingPlacement, readBriefingReuse } from './egdesk-briefing-flow.mjs'
import { attachBoardVisual, MAX_BOARD_VISUAL_IMAGE_CHARS, validateBoardVisual } from './egdesk-board-visual-packet.mjs'

const ROOT = '/decision/board-presentation'
const ACTIONS = new Map(['prepare', 'run', 'cancel'].map(action => [`${ROOT}/${action}`, action]))
// Canvas design check (the Decision model as a system-level judge over runtime-enumerated items): same authority, budget, ticket and deadline rules.
// Typed judges (the Decision model answers closed questions about items the runtime enumerated): canvas layout check, Answer Briefing placement
// (chat bubble or board) and Answer Briefing flow check. Each has its own closed DTO, reader and content-free calibration entry.
const JUDGES = Object.freeze({
  '/decision/canvas-check': { prepare: prepareCanvasDesignCheck, read: readCanvasDesignCheck, entry: canvasCheckCalibrationEntry },
  '/decision/briefing-placement': { prepare: prepareBriefingPlacement, read: readBriefingPlacement, entry: placementCalibrationEntry },
  '/decision/briefing-check': { prepare: prepareBriefingCheck, read: readBriefingCheck, entry: briefingCheckCalibrationEntry },
  '/decision/briefing-reuse': { prepare: prepareBriefingReuse, read: readBriefingReuse, entry: briefingReuseCalibrationEntry },
})
const JUDGE_ROUTES = new Map(Object.entries(JUDGES).flatMap(([root, judge]) => ['prepare', 'run', 'cancel'].map(action => [`${root}/${action}`, { action, judge }])))
const CHECK_MAX_BODY_BYTES = 16384
const KINDS = new Set(['업무 전표', '메모', '자료', '상태표'])
const MODES = new Set(['advisory', 'on'])
const TTL_MS = 60_000
const MAX_PENDING = 32
const MAX_BODY_BYTES = 4096
const MAX_VISUAL_PREPARE_BYTES = MAX_BODY_BYTES + MAX_BOARD_VISUAL_IMAGE_CHARS
const MAX_PACKET_BYTES = MAX_BOARD_VISUAL_IMAGE_CHARS + 8192
const MAX_RETAINED_PACKET_BYTES = 8 * 1024 * 1024
const MANUAL = Object.freeze({ status: 'manual' })
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const ticketValid = ticket => typeof ticket === 'string' && /^[a-f0-9]{48}$/.test(ticket)

// Count original request bytes (including whitespace, duplicate fields, escapes,
// etc.), not a reserialized DTO. Reserve the extra room only for the image.
async function readPrepareBody(req) {
  let bytes = 0
  const chunks = []
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length
    if (bytes > MAX_VISUAL_PREPARE_BYTES) {
      req.resume()
      return { bytes, body: null }
    }
    chunks.push(chunk)
  }
  try { return { bytes, body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))) } }
  catch { return { bytes, body: null } }
}

function normalizePrepare(body) {
  const hasVisual = body != null && Object.hasOwn(body, 'visual')
  if (!exactKeys(body, hasVisual ? ['cue', 'items', 'wide', 'tall', 'visual'] : ['cue', 'items', 'wide', 'tall']) || typeof body.cue !== 'string' ||
      typeof body.wide !== 'boolean' || typeof body.tall !== 'boolean' ||
      !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 12) return null
  // The returned canonical cue, not the raw request, is the required review surface.
  const cue = body.cue.normalize('NFC').trim()
  if (!cue || cue.length > 280 || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(cue)) return null
  const items = []
  const hasScene = body.items.some(item => item != null && Object.hasOwn(item, 'scene'))
  const itemKeys = hasScene ? ['kind', 'focus', 'movable', 'scene'] : ['kind', 'focus', 'movable']
  let focusCount = 0
  for (const item of body.items) {
    if (!exactKeys(item, itemKeys) || !KINDS.has(item.kind) ||
        typeof item.focus !== 'boolean' || typeof item.movable !== 'boolean' ||
        (item.focus && ++focusCount > 1)) return null
    const scene = hasScene ? normalizeBoardPresentationScene(item.scene) : null
    if (hasScene && !scene) return null
    items.push({ kind: item.kind, focus: item.focus, movable: item.movable, ...(scene ? { scene } : {}) })
  }
  const visual = hasVisual ? validateBoardVisual(body.visual) : null
  if (hasVisual && !visual) return null
  return { cue, items, wide: body.wide, tall: body.tall, hasScene, visual }
}

/**
 * Local Board layout choice only. This route has no Board/store handle, no write
 * operation and no reasoning client. The trusted chrome caller must offer only
 * shareable descriptors and show the canonical preview before a fresh click.
 * Optional visual candidates must be feasible in current chrome state. PNG
 * validation bounds the wire only; it cannot establish pixel-release authority.
 * `credentials` is the isolated Decisions store (not Codex/Claude/env auth).
 * `budget` is the existing shared Decisions budget. `invalidate()` must be called
 * synchronously on successful key/mode changes to revoke pending and active work.
 * `fetchImpl` and `now` support offline fixtures; production uses fixed defaults.
 */
export function createBoardPresentationHttpHandler({ credentials, getMode, budget, port = 39218,
  fetchImpl, now = () => performance.now(), calibrationLog = null } = {}) {
  if (typeof credentials?.getApiKey !== 'function' || typeof credentials?.savedAt !== 'function' ||
      typeof getMode !== 'function' || typeof budget?.canSpend !== 'function' ||
      typeof budget?.record !== 'function' || typeof now !== 'function') throw new TypeError('Board Decisions dependencies are required')

  // Process-local, Board-scoped identity. The same callback signs the actual
  // credential the Decisions client chose, at the last synchronous dispatch gate.
  let bindingKey = randomBytes(32)
  const recipientForKey = (key, endpoint, model) => {
    const revision = credentials.savedAt()
    if (typeof key !== 'string' || !key.trim() || !Number.isSafeInteger(revision) || revision < 0) return null
    return createHmac('sha256', bindingKey).update(JSON.stringify([
      'egdesk:board-presentation:v1', endpoint, model, revision, key,
    ])).digest('hex')
  }
  const client = createDecisionClient({ getApiKey: () => credentials.getApiKey(), budget, recipientForKey, fetchImpl })
  const pending = new Map()
  let pendingBytes = 0
  let active = null

  function authority({ checkBudget = true } = {}) {
    const mode = getMode()
    if (!MODES.has(mode)) return { mode: 'off', reason: 'mode-off' }
    const binding = recipientForKey(credentials.getApiKey(), DECISIONS_ENDPOINT, DECISION_MODEL)
    if (!binding) return { mode, reason: 'not-configured' }
    if (checkBudget && budget.canSpend() !== true) return { mode, reason: 'budget-exceeded' }
    return { mode, binding }
  }

  // Content-free calibration record (canon 5.3, egdesk-decision-calibration-log.mjs): the two top probabilities, the bar that
  // applied and what it would have done. No option names, slots, cue, ids, geometry or image. Never throws, never changes the reply.
  const FAILURES = new Set(['timeout', 'unreachable', 'bad_response', 'no_credit', 'rate_limited', 'budget_exceeded', 'spend_limit_reached',
    'invalid_key', 'server_error', 'model_unavailable'])
  function calibrate(prepared, answers, result, fallback = null) {
    try {
      if (typeof calibrationLog?.record !== 'function') return
      const a = answers?.board_view, rows = Array.isArray(a?.probabilities) ? a.probabilities : []
      const accepted = result?.status === 'preview' || result?.status === 'advisory-only'
      calibrationLog.record({ feature: 'board_arrangement', mode: prepared.mode, candidates: prepared.options.length,
        ...(fallback ? { fallback, judgments: [] } : {
          attached: prepared.mode === 'on' && result?.status === 'preview',
          judgments: [{ q: 'choice', would: accepted ? 'accept' : 'reject', top: rows[0]?.probability, second: rows[1]?.probability,
            p: a?.confidence, confidence: a?.confidence, options: prepared.options.length,
            margin: Number.isFinite(rows[0]?.probability) && Number.isFinite(rows[1]?.probability) ? rows[0].probability - rows[1].probability : undefined,
            threshold: DEFAULT_DECISION_THRESHOLDS.choice, minMargin: DEFAULT_DECISION_THRESHOLDS.margin }] }) })
    } catch { /* recording must never affect the reply */ }
  }

  function calibrateCheck(judge, prepared, answers, result) {
    try { calibrationLog?.record?.(judge.entry(prepared, answers, result)) } catch { /* recording must never affect the reply */ }
  }
  // What each mode may return from a canvas check. Advisory records the verdict kind and returns no findings; off never reaches here.
  function checkReply(prepared, result) {
    if (result.status === 'manual') return MANUAL
    if (prepared.mode === 'advisory') return { status: 'advisory-only', verdict: result.verdict }
    return result.reply ?? { status: result.status, understandable: result.understandable, findings: result.findings, where: result.where }
  }

  function discard(ticket) {
    const entry = pending.get(ticket)
    if (!entry) return null
    pending.delete(ticket)
    pendingBytes -= entry.packetBytes
    clearTimeout(entry.timer)
    return entry
  }

  async function run(ticket, res) {
    // Consume even if a new authority/budget check denies this valid confirmation.
    // This happens before the first async step, so duplicate runs cannot dispatch.
    const entry = discard(ticket)
    if (!entry || active || res.destroyed || now() >= entry.expiresAt) return MANUAL
    const { prepared, outbound, expiresAt, packetBytes, judge } = entry
    const isCheck = !!judge
    const matches = state => state.mode === prepared.mode && state.binding === prepared.binding
    const gate = authority()
    // Name the one refusal the user can act on (the local monthly cap); every other mismatch stays a plain manual.
    if (!matches(gate)) return gate.mode === prepared.mode && gate.reason === 'budget-exceeded' ? { status: 'manual', reason: 'budget_exceeded' } : MANUAL

    const controller = new AbortController()
    const abort = () => controller.abort()
    active = { ticket, abort, packetBytes }
    res.once('close', abort)
    const timer = setTimeout(abort, Math.max(1, expiresAt - now()))
    timer.unref()
    let authorized = false
    try {
      const { answers } = await client.decide({ ...outbound, signal: controller.signal, timeoutMs: FOREGROUND_DECISION_TIMEOUT_MS,
        authorizeDispatch(recipient) {
          if (authorized || recipient !== prepared.binding || controller.signal.aborted || res.destroyed || now() >= expiresAt) return false
          authorized = matches(authority())
          return authorized
        },
      })
      // Usage was already recorded by the client: do not reject a valid answer
      // merely because this very call reached the cap. Revocation still wins.
      if (!authorized || controller.signal.aborted || res.destroyed || now() >= expiresAt) {
        if (authorized && !controller.signal.aborted && !res.destroyed) calibrate(prepared, null, null, 'timeout')
        return MANUAL
      }
      const current = authority({ checkBudget: false })
      if (!matches(current)) { calibrate(prepared, null, null, 'mode_changed'); return MANUAL }
      if (isCheck) {
        const checked = judge.read(prepared, answers, current.binding)
        calibrateCheck(judge, prepared, answers, checked)
        return checkReply(prepared, checked)
      }
      const result = readBoardPresentation(prepared, answers, current.binding)
      calibrate(prepared, answers, result)
      if (result.status === 'preview') return { status: 'preview', preview: result.preview }
      if (result.status === 'advisory-only') return { status: 'advisory-only', suggestion: result.suggestion }
      return MANUAL
    } catch (error) {
      // Do not echo provider errors, details, answers, or credentials. No retry.
      if (authorized && FAILURES.has(error?.code)) calibrate(prepared, null, null, error.code)
      // A closed reason word only (never provider text): the screen can say what happened, as the DM chooser does.
      const reason = FAILURES.has(error?.code) ? (error.code === 'timeout' && error.dispatched === false ? 'timeout_unsent' : error.code) : null
      return reason ? { status: 'manual', reason } : MANUAL
    } finally {
      clearTimeout(timer)
      res.off('close', abort)
      active = null
    }
  }

  const handle = async (req, res, url) => {
    const route = JUDGE_ROUTES.get(url.pathname)
    const action = ACTIONS.get(url.pathname) ?? route?.action
    if (!action) return false
    const isCheck = !!route
    const reply = (code, body) => { if (!res.destroyed && !res.writableEnded) sendJson(res, code, body); return true }
    if (!guardBridgeRequest(req, port)) return reply(403, { status: 'manual', reason: 'loopback-required' })
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return reply(405, { status: 'manual', reason: 'post-required' })
    }
    // Reject bodyless/simple requests before reading; query parameters are not a DTO.
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return reply(415, { status: 'manual', reason: 'json-required' })
    if (url.search) return reply(400, { status: 'manual', reason: 'invalid-request' })
    const limit = isCheck ? CHECK_MAX_BODY_BYTES : action === 'prepare' ? MAX_VISUAL_PREPARE_BYTES : MAX_BODY_BYTES
    if (Number(req.headers['content-length']) > limit) return reply(413, { status: 'manual', reason: 'invalid-request' })
    let body, bytes = 0
    try {
      if (action === 'prepare' && !isCheck) ({ body, bytes } = await readPrepareBody(req))
      else body = await readJsonBody(req, { maxBytes: isCheck ? CHECK_MAX_BODY_BYTES : MAX_BODY_BYTES })
    } catch (error) { return reply(error?.httpStatus === 413 ? 413 : 400, { status: 'manual', reason: 'invalid-request' }) }
    if (res.destroyed || res.writableEnded) return true
    try {
      if (isCheck && action === 'prepare') {
        const { mode, binding, reason } = authority()
        if (!binding) return reply(200, { status: 'disabled', mode, reason })
        const time = now()
        for (const [token, entry] of pending) if (time >= entry.expiresAt) discard(token)
        if (pending.size >= MAX_PENDING) return reply(200, { status: 'disabled', mode, reason: 'busy' })
        const prepared = route.judge.prepare({ mode, binding, dto: body })
        if (prepared.status !== 'prepared') return reply(400, { status: 'manual', reason: 'invalid-request' })
        const outbound = { model: client.model, ...prepared.packet }
        const packetBytes = Buffer.byteLength(JSON.stringify(outbound))
        if (packetBytes > MAX_PACKET_BYTES || pendingBytes + (active?.packetBytes ?? 0) + packetBytes > MAX_RETAINED_PACKET_BYTES) return reply(200, { status: 'disabled', mode, reason: 'busy' })
        const ticket = randomBytes(24).toString('hex')
        const expiresAt = now() + TTL_MS
        const timer = setTimeout(() => discard(ticket), TTL_MS)
        timer.unref()
        pendingBytes += packetBytes
        pending.set(ticket, { prepared, outbound, packetBytes, timer, expiresAt, judge: route.judge })
        return reply(200, { status: 'prepared', ticket, mode, expiresInMs: TTL_MS, preview: { cue: prepared.dto.purpose ?? '', items: prepared.dto.items ?? [], packet: outbound } })
      }
      if (action === 'prepare') {
        // Reject oversized text, malformed JSON, or non-image padding before PNG work.
        const imageChars = typeof body?.visual?.image === 'string' ? body.visual.image.length : 0
        if (bytes > MAX_VISUAL_PREPARE_BYTES || (bytes > MAX_BODY_BYTES &&
            (imageChars > MAX_BOARD_VISUAL_IMAGE_CHARS || bytes - imageChars > MAX_BODY_BYTES))) {
          return reply(413, { status: 'manual', reason: 'invalid-request' })
        }
        const dto = normalizePrepare(body)
        if (!dto) return reply(bytes > MAX_BODY_BYTES ? 413 : 400, { status: 'manual', reason: 'invalid-request' })
        const { mode, binding, reason } = authority()
        if (!binding) return reply(200, { status: 'disabled', mode, reason })
        const time = now()
        for (const [token, entry] of pending) if (time >= entry.expiresAt) discard(token)
        if (pending.size >= MAX_PENDING) return reply(200, { status: 'disabled', mode, reason: 'busy' })

        const items = dto.items.map((item, i) => ({ slot: String.fromCharCode(65 + i), ...item }))
        let prepared = prepareBoardPresentation({ mode, binding, requestText: dto.cue,
          selection: items.map(item => ({ id: item.slot, approvedKind: item.kind, movable: item.movable,
            renderable: true, canRead: true, maySendDescriptor: true, ...(dto.hasScene ? { scene: item.scene } : {}) })),
          focusId: items.find(item => item.focus)?.slot,
          // Threshold markers for the existing planning contract, never real geometry.
          viewport: { width: dto.wide ? 664 : 0, height: dto.tall ? 200 : 0 },
          // Build the transfer candidate locally; only /run can make this dispatchable.
          authority: { approved: true, revision: binding, reviewedCue: dto.cue },
        })
        if (prepared.status !== 'prepared') return reply(200, { status: 'disabled', mode, reason: 'no-choice' })
        if (dto.visual) prepared = attachBoardVisual(prepared, dto.visual)
        if (!prepared) return reply(200, { status: 'disabled', mode, reason: 'no-choice' })
        // The client uses this fixed model and serializes these exact input/questions.
        // Keep the outbound snapshot with the one-use ticket; /run accepts no replacements.
        const outbound = { model: client.model, ...prepared.packet }
        const packetBytes = Buffer.byteLength(JSON.stringify(outbound))
        if (packetBytes > MAX_PACKET_BYTES || pendingBytes + (active?.packetBytes ?? 0) + packetBytes > MAX_RETAINED_PACKET_BYTES) {
          return reply(200, { status: 'disabled', mode, reason: 'busy' })
        }
        const ticket = randomBytes(24).toString('hex')
        const expiresAt = now() + TTL_MS
        const timer = setTimeout(() => discard(ticket), TTL_MS)
        timer.unref()
        pendingBytes += packetBytes
        pending.set(ticket, { prepared, outbound, packetBytes, timer, expiresAt })
        return reply(200, { status: 'prepared', ticket, mode, expiresInMs: TTL_MS,
          preview: { cue: dto.cue, items, options: prepared.options, wide: dto.wide, tall: dto.tall,
            ...((dto.hasScene || dto.visual) ? { packet: outbound } : {}) } })
      }
      if (action === 'cancel') {
        if (!exactKeys(body, ['ticket']) || !ticketValid(body.ticket)) return reply(400, { status: 'manual', reason: 'invalid-request' })
        discard(body.ticket)
        if (active?.ticket === body.ticket) active.abort()
        return reply(200, { status: 'cancelled' })
      }
      if (!exactKeys(body, ['ticket', 'confirm']) || !ticketValid(body.ticket) || body.confirm !== true) {
        return reply(400, { status: 'manual', reason: 'confirmation-required' })
      }
      return reply(200, await run(body.ticket, res))
    } catch {
      return reply(200, action === 'prepare' ? { status: 'disabled', reason: 'unavailable' } : MANUAL)
    }
  }

  // Public authority epoch; never expose the credential binding or its secret.
  handle.settingsRevision = () => createHmac('sha256', bindingKey).update('egdesk:board-settings:v1').digest('hex')
  handle.invalidate = () => {
    bindingKey = randomBytes(32)
    for (const ticket of pending.keys()) discard(ticket)
    active?.abort()
  }
  return handle
}
