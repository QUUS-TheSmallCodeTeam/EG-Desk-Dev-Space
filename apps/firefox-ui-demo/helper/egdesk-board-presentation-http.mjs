import { createHmac, randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { guardBridgeRequest, readJsonBody, sendJson } from './codex-bridge-http.mjs'
import { createDecisionClient, DECISIONS_ENDPOINT, DECISION_MODEL } from './egdesk-decision-client.mjs'
import { normalizeBoardPresentationScene, prepareBoardPresentation, readBoardPresentation } from './egdesk-board-presentation-plan.mjs'
import { attachBoardVisual, MAX_BOARD_VISUAL_IMAGE_CHARS, validateBoardVisual } from './egdesk-board-visual-packet.mjs'

const ROOT = '/decision/board-presentation'
const ACTIONS = new Map(['prepare', 'run', 'cancel'].map(action => [`${ROOT}/${action}`, action]))
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
  fetchImpl, now = () => performance.now() } = {}) {
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
    const { prepared, outbound, expiresAt, packetBytes } = entry
    const matches = state => state.mode === prepared.mode && state.binding === prepared.binding
    if (!matches(authority())) return MANUAL

    const controller = new AbortController()
    const abort = () => controller.abort()
    active = { ticket, abort, packetBytes }
    res.once('close', abort)
    const timer = setTimeout(abort, Math.max(1, expiresAt - now()))
    timer.unref()
    let authorized = false
    try {
      const { answers } = await client.decide({ ...outbound, signal: controller.signal,
        authorizeDispatch(recipient) {
          if (authorized || recipient !== prepared.binding || controller.signal.aborted || res.destroyed || now() >= expiresAt) return false
          authorized = matches(authority())
          return authorized
        },
      })
      // Usage was already recorded by the client: do not reject a valid answer
      // merely because this very call reached the cap. Revocation still wins.
      if (!authorized || controller.signal.aborted || res.destroyed || now() >= expiresAt) return MANUAL
      const current = authority({ checkBudget: false })
      if (!matches(current)) return MANUAL
      const result = readBoardPresentation(prepared, answers, current.binding)
      if (result.status === 'preview') return { status: 'preview', preview: result.preview }
      if (result.status === 'advisory-only') return { status: 'advisory-only', suggestion: result.suggestion }
      return MANUAL
    } catch {
      // Do not echo provider errors, details, answers, or credentials. No retry.
      return MANUAL
    } finally {
      clearTimeout(timer)
      res.off('close', abort)
      active = null
    }
  }

  const handle = async (req, res, url) => {
    const action = ACTIONS.get(url.pathname)
    if (!action) return false
    const reply = (code, body) => { if (!res.destroyed && !res.writableEnded) sendJson(res, code, body); return true }
    if (!guardBridgeRequest(req, port)) return reply(403, { status: 'manual', reason: 'loopback-required' })
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return reply(405, { status: 'manual', reason: 'post-required' })
    }
    // Reject bodyless/simple requests before reading; query parameters are not a DTO.
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return reply(415, { status: 'manual', reason: 'json-required' })
    if (url.search) return reply(400, { status: 'manual', reason: 'invalid-request' })
    const limit = action === 'prepare' ? MAX_VISUAL_PREPARE_BYTES : MAX_BODY_BYTES
    if (Number(req.headers['content-length']) > limit) return reply(413, { status: 'manual', reason: 'invalid-request' })
    let body, bytes = 0
    try {
      if (action === 'prepare') ({ body, bytes } = await readPrepareBody(req))
      else body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES })
    } catch (error) { return reply(error?.httpStatus === 413 ? 413 : 400, { status: 'manual', reason: 'invalid-request' }) }
    if (res.destroyed || res.writableEnded) return true
    try {
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

  handle.invalidate = () => {
    bindingKey = randomBytes(32)
    for (const ticket of pending.keys()) discard(ticket)
    active?.abort()
  }
  return handle
}
