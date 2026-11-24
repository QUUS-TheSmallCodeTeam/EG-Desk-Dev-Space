import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createEgressGate, modelDataPermissions } from './egdesk-decision-egress.mjs'
import { secretReason } from './egdesk-portable-extras.mjs'
import { REVIEW_TEXT_BYTES } from './egdesk-portable-review.mjs'

const PREFIX = 'BOARD_AGENT_ASK_'
const CODE = /^egask1-[a-f0-9]{32}$/
const CODE_IN_TEXT = /egask1-[a-f0-9]{32}/i
const SHA = /^[a-f0-9]{64}$/
const VERSION = /^[a-f0-9-]{36}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const CODE_TTL = 7 * 24 * 60 * 60 * 1000
const TICKET_TTL = 120_000
const MAX_PENDING = 64
const MAX_RUNNING = 4
const MAX_SELECTED = 6 // six reviewed excerpts at ≤1,500 UTF-8 bytes each
const TONES = ['plain', 'warm', 'concise', 'formal', 'playful']
const BOARD_ASK_TOOL_CEILING = Object.freeze({ browser: 'none', files: 'none', terminal: 'none', network: 'off', mcp: 'none' })
const invalid = () => fail('INPUT', 'Invalid Board Agent ask fields')
const stale = () => fail('STALE', 'Approval is no longer current; review again', 409)
const unavailable = () => fail('UNAVAILABLE', 'Board Agent ask is unavailable', 503)
export class BoardAskError extends Error {
  constructor(code, message, status) { super(message); this.code = PREFIX + code; this.httpStatus = status }
}
const fail = (code, message, status = 400) => { throw new BoardAskError(code, message, status) }
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const codeDigest = (boardId, version, code) => digest(['egdesk-board-ask-v1', boardId, version, code])
const safeEquals = (a, b) => typeof a === 'string' && typeof b === 'string' && SHA.test(a) && SHA.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
const txt = (value, max, { empty = false, sanitize = true } = {}) => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max || (!empty && !value.trim()) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value.replace(/[\t\n]/g, ''))) invalid()
  if (sanitize && (secretReason('board-ask.txt', value) || CODE_IN_TEXT.test(value))) fail('SECRET_LIKE', 'Remove apparent credentials or question codes from text')
  return value
}
const shape = (value, allowed, required = allowed) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalid()
}
const reqKeys = ['kind', 'requestId', 'requestDigest', 'recipient', 'question', 'excerpt', 'expectedReply', 'askCode']
function inspectedRequest(request) {
  shape(request, reqKeys, reqKeys.slice(0, -1))
  if (request.kind !== 'request' || typeof request.requestId !== 'string' || !UUID.test(request.requestId) || typeof request.requestDigest !== 'string' || !SHA.test(request.requestDigest)) invalid()
  if (typeof request.askCode !== 'string' || request.askCode.length !== 39 || !CODE.test(request.askCode)) fail('CODE_REQUIRED', 'This request does not carry a valid question code; reply manually', 409)
  for (const key of ['recipient', 'question', 'excerpt', 'expectedReply']) txt(request[key], REVIEW_TEXT_BYTES[key], { empty: key === 'excerpt' })
  if (/[\t\n\u2028\u2029]/u.test(request.recipient)) invalid()
  return Object.fromEntries(reqKeys.map(key => [key, request[key]]))
}
const pin = profile => profile?.lifecycle === 'active' && profile.active && profile.activeRevision === profile.active.revision ? profile.active : null
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b)
// An explicit model route is a subscription binding, even if its model name happens
// to match the API model. Never quietly change its payer, account or provider.
const compatibleDraft = active => !!active && active.body.model == null
const knownStore = new Set(['BOARD_NOT_FOUND', 'BOARD_NOT_ACTIVE', 'INVALID_BOARD_ID', 'INVALID_PROFILE_ID', 'BOARD_AGENT_ASK_POLICY_CONFLICT', 'BOARD_AGENT_ASK_LIFECYCLE_CONFLICT'])
const validateExcerpts = excerpts => {
  if (!Array.isArray(excerpts) || excerpts.length > 8) invalid()
  return excerpts.map(excerpt => txt(excerpt, 1500))
}

// Content-free calibration entry (canon 5.3) for the Board reply screening (feature 'board_reply', question 'relevance').
// Numbers and closed words only: no excerpt/question text, ids, names or keys.
function screeningEntry(mode, observed, attached) {
  if (!observed || (mode !== 'advisory' && mode !== 'on')) return null
  const judgments = observed.probabilities.map(p => ({ q: 'relevance', p, threshold: observed.bar, kind: 'board', would: p >= observed.bar ? 'attach' : 'skip' }))
    .sort((a, b) => b.p - a.p)
  return { feature: 'board_reply', mode, judgments, candidates: observed.candidates, judgedTotal: judgments.length,
    ...(observed.failure ? { fallback: observed.failure } : {}), attached }
}

export function createBoardAgentAskService({ desk, profiles, selectContext, decisionStatus, draft, draftPreview, calibrationLog = null, now = Date.now } = {}) {
  const pending = new Map(), running = new Map()
  let closed = false
  const available = () => !closed && !!(desk && profiles && selectContext)
  const checkAvailable = () => { if (!available()) unavailable() }
  function abortBoard(boardId) {
    for (const [ticket, entry] of pending) if (entry.boardId === boardId) pending.delete(ticket)
    for (const entry of running.values()) if (entry.boardId === boardId) entry.controller.abort()
  }
  const readDecision = () => {
    const status = decisionStatus?.()
    return status && ['on', 'advisory'].includes(status.mode) && status.model && status.bindingId && status.client ? status : null
  }
  const readDraft = active => {
    const status = draft?.status()
    return compatibleDraft(active) && status?.configured && status.model && status.bindingId ? status : null
  }
  // The Decision model follows the same data permission as the other models of this ask (no separate choice):
  // the approved excerpts may be screened by Decisions only when this ask sends them to the drafting model.
  // A Board ask gives its model no tools, no Browser Card, no canvas, memory or chat history: only the excerpt class can open.
  const egressFor = (mode, draftStatus) => createEgressGate(modelDataPermissions({ toolCeiling: BOARD_ASK_TOOL_CEILING, boardExcerptsToModel: mode === 'draft' && !!draftStatus }))
  const readScreening = (mode, draftStatus) => egressFor(mode, draftStatus).allows('board_excerpt') ? readDecision() : null
  const profileFor = id => pin(profiles.get(id))
  const sameProfile = (active, policy) => active?.revision === policy.profileRevision && active?.hash === policy.profileHash
  function describe(boardId) {
    const policy = desk.boardAgentAskPolicy(boardId)
    const active = policy && profileFor(policy.profileId)
    const current = !!policy && sameProfile(active, policy)
    const draftStatus = current ? readDraft(active) : null
    const decision = readDecision()
    const codeActive = current && !!policy.codeDigest && !policy.codeUsed && policy.codeExpiresAt > now()
    return {
      policy: policy ? { version: policy.version, profileId: policy.profileId, profileName: policy.profileName,
        profileRevision: policy.profileRevision, excerpts: policy.excerpts, publicInstructions: policy.publicInstructions,
        stale: !current, codeActive, codeExpiresAt: codeActive ? policy.codeExpiresAt : null } : null,
      availability: { decision: !!decision, draft: current && !!draftStatus, model: (current && draftStatus?.model) || null },
    }
  }
  function policy(input) {
    checkAvailable()
    shape(input, ['boardId', 'action', 'expectedVersion', 'profileId', 'excerpts', 'publicInstructions'], ['boardId', 'action'])
    const { boardId, action, expectedVersion = null } = input
    if (expectedVersion !== null && (typeof expectedVersion !== 'string' || !VERSION.test(expectedVersion))) invalid()
    if (action !== 'save' && ['profileId', 'excerpts', 'publicInstructions'].some(key => Object.hasOwn(input, key))) invalid()
    if (action === 'get') return describe(boardId)
    const existing = desk.boardAgentAskPolicy(boardId)
    if (!['save', 'revoke', 'issue'].includes(action)) invalid()
    if ((existing?.version ?? null) !== expectedVersion) fail('POLICY_CONFLICT', 'Board ask policy changed; reload before editing', 409)
    if (action === 'issue') {
      if (!existing || !sameProfile(profileFor(existing.profileId), existing)) fail('POLICY_REQUIRED', 'Save a current Board ask policy before issuing a code', 409)
      const askCode = 'egask1-' + randomBytes(16).toString('hex')
      const expiresAt = now() + CODE_TTL
      const version = randomUUID()
      desk.issueBoardAgentAskCode(boardId, expectedVersion, version, codeDigest(boardId, version, askCode), expiresAt)
      abortBoard(boardId)
      const updated = describe(boardId)
      // A different bridge process could have changed the policy after commit.
      if (updated.policy?.version !== version) fail('POLICY_CONFLICT', 'Board ask policy changed; reload before editing', 409)
      return { ...updated, askCode, expiresAt }
    }
    let next = null
    if (action === 'save') {
      const id = txt(input.profileId, 200)
      const active = profileFor(id)
      if (!active) fail('PROFILE_NOT_ACTIVE', 'Choose an active local Agent profile', 409)
      next = { profileId: id, profileName: active.body.name, profileRevision: active.revision, profileHash: active.hash,
        excerpts: validateExcerpts(input.excerpts), publicInstructions: txt(input.publicInstructions ?? '', 1200, { empty: true }) }
    }
    desk.writeBoardAgentAskPolicy(boardId, expectedVersion, next)
    abortBoard(boardId)
    return describe(boardId)
  }
  function lifecycle(input) {
    if (closed || !desk) unavailable()
    shape(input, ['boardId', 'action', 'expectedVersion'], ['boardId', 'action'])
    const { boardId, action, expectedVersion = null } = input
    if (!['get', 'trash', 'purge', 'restore'].includes(action) ||
        (expectedVersion !== null && (typeof expectedVersion !== 'string' || !VERSION.test(expectedVersion))) ||
        (action === 'get' && Object.hasOwn(input, 'expectedVersion'))) invalid()
    const result = desk.boardAgentAskLifecycle(boardId, action, expectedVersion)
    if (action !== 'get' && result.lifecycle !== 'active') abortBoard(boardId)
    return result
  }
  function prepare(input, { signal } = {}) {
    checkAvailable()
    shape(input, ['boardId', 'request', 'mode'])
    const { boardId, mode } = input
    if (!['extract', 'draft'].includes(mode)) invalid()
    if (signal?.aborted) stale()
    const request = inspectedRequest(input.request)
    const board = desk.boardAgentAskIdentity(boardId)
    const policy = desk.boardAgentAskPolicy(boardId)
    if (!policy || !policy.codeDigest || policy.codeUsed || policy.codeExpiresAt <= now() || !safeEquals(policy.codeDigest, codeDigest(boardId, policy.version, request.askCode))) {
      fail('CODE_INVALID', 'This question code is expired, used, or not valid for this Board; reply manually', 409)
    }
    const active = profileFor(policy.profileId)
    if (!sameProfile(active, policy)) fail('PROFILE_STALE', 'The pinned profile changed; save a current policy', 409)
    const f = mode === 'draft' ? readDraft(active) : null
    if (mode === 'draft' && !f) fail('DRAFT_OFF', 'The dedicated draft service is off or conflicts with this pinned profile', 409)
    // Screening is not chosen here: it applies exactly when the saved Decisions mode/key are usable and the gate allows the excerpts.
    const d = readScreening(mode, f)
    const excerpts = validateExcerpts(policy.excerpts)
    const replyStyle = TONES.includes(active.body.personality?.tone) ? active.body.personality.tone : 'plain'
    const publicInstructions = mode === 'draft' ? txt(policy.publicInstructions, 1200, { empty: true }) : ''
    const { question, requestId, requestDigest } = request
    // Expired entries are cheap to sweep; never evict a still-confirmable preview.
    for (const [key, item] of pending) if (item.expiresAt <= now()) pending.delete(key)
    if (pending.size >= MAX_PENDING) fail('BUSY', 'Too many Board ask previews; cancel one or wait', 429)
    const ticket = randomBytes(32).toString('hex')
    const expiresAt = Math.min(now() + TICKET_TTL, policy.codeExpiresAt)
    const entry = { boardId, board, mode, expiresAt, version: policy.version, codeDigest: policy.codeDigest,
      profileId: policy.profileId, profileHash: active.hash, profileRevision: active.revision, question, requestId, requestDigest,
      excerpts, publicInstructions, replyStyle, decisionMode: d?.mode, decisionModel: d?.model, decisionBinding: d?.bindingId,
      draftModel: f?.model, draftBinding: f?.bindingId }
    pending.set(ticket, entry)
    return { ticket, expiresAt, mode, profileName: policy.profileName, profileRevision: active.revision,
      model: f?.model ?? d?.model ?? null, question, excerpts, replyStyle, publicInstructions,
      provider: f || d ? 'openai' : null, payer: f ? 'Host’s dedicated OpenAI Responses API key' : d ? 'Host’s Decision API key' : null,
      decisionModel: d?.model ?? null, decisionMode: d?.mode ?? null, draftModel: f?.model ?? null,
      decisionPayer: d ? 'Host’s Decision API key' : null, draftPayer: f ? 'Host’s dedicated OpenAI Responses API key' : null,
      draftInstructions: f ? draftPreview?.(replyStyle, publicInstructions) ?? null : null }
  }
  function isCurrent(item, consumed) {
    if (closed || item.controller?.signal.aborted || now() >= item.expiresAt) return false
    try {
      if (!sameValue(desk.boardAgentAskIdentity(item.boardId), item.board)) return false
      const policy = desk.boardAgentAskPolicy(item.boardId)
      if (policy?.version !== item.version || policy.codeDigest !== item.codeDigest || policy.codeUsed !== consumed || now() >= policy.codeExpiresAt) return false
      const active = profileFor(item.profileId)
      if (active?.revision !== item.profileRevision || active.hash !== item.profileHash) return false
      const f = item.mode === 'draft' ? readDraft(active) : null
      // A Decisions setting that changed after the preview (on, off, another key) makes the approval stale.
      const d = readScreening(item.mode, f)
      return item.decisionMode === d?.mode && item.decisionModel === d?.model && item.decisionBinding === d?.bindingId && item.draftModel === f?.model && item.draftBinding === f?.bindingId
    } catch { return false }
  }
  async function run(input, { signal } = {}) {
    checkAvailable()
    shape(input, ['ticket', 'confirm'])
    const { ticket } = input
    if (typeof ticket !== 'string' || !SHA.test(ticket) || input.confirm !== true) invalid()
    const item = pending.get(ticket)
    pending.delete(ticket) // No entry can reenter the async dispatch path.
    if (!item || signal?.aborted || !isCurrent(item, false)) stale()
    if (running.size >= MAX_RUNNING) fail('BUSY', 'Too many Board ask runs; prepare again later', 429)
    if (!desk.consumeBoardAgentAskCode(item.boardId, item.version, item.codeDigest, now())) stale()
    item.controller = new AbortController()
    const abort = () => item.controller.abort()
    const timer = setTimeout(abort, Math.max(1, item.expiresAt - now())); timer.unref?.()
    signal?.addEventListener('abort', abort, { once: true })
    running.set(ticket, item)
    const scope = Object.freeze({ invocationId: randomBytes(16).toString('hex'), boardId: item.boardId,
      grantId: item.requestId, policyRevision: item.version, expiresAt: item.expiresAt, question: item.question,
      allowedSlices: Object.freeze(item.excerpts.map((text, index) => Object.freeze({ id: `x${index + 1}`, text }))) })
    const current = () => running.get(ticket) === item && isCurrent(item, true)
    const check = setInterval(() => { if (!current()) abort() }, 100); check.unref?.()
    let calibrationId = null, finalRun = 'cancelled'
    try {
      if (!current()) stale()
      const egress = egressFor(item.mode, item.draftBinding)
      const decision = egress.allows('board_excerpt') ? readDecision() : null
      let observed = null
      const selected = await selectContext({ question: item.question, scope },
        { mode: decision?.mode ?? 'off', client: decision?.client ? egress.guardClient(decision.client, ['board_excerpt']) : null, egress, now, signal: item.controller.signal,
          isCurrent: offered => offered === scope && current(), observe: report => { observed = report } })
      if (!current()) stale()
      // Tell the owner what the Decisions screening actually did. The excerpt set is unchanged by this label.
      const screening = !decision ? null : selected?.outcome === 'decision' ? 'decision'
        : selected?.outcome === 'local' && decision?.mode === 'advisory' ? 'advisory'
        : selected?.outcome === 'local' || selected?.outcome === 'local_fallback' ? 'fallback' : null
      const allowed = new Map(scope.allowedSlices.map(slice => [slice.id, slice.text]))
      const evidence = [...new Set(selected?.selectedIds ?? [])].filter(id => allowed.has(id)).slice(0, MAX_SELECTED).map(id => allowed.get(id))
      try { // Recording only: never throws, never changes the selection.
        const entry = calibrationLog ? screeningEntry(decision?.mode, observed, decision?.mode === 'on' && screening === 'decision' && evidence.length > 0) : null
        calibrationId = entry ? calibrationLog.record(entry) : null
      } catch { calibrationId = null }
      if (item.mode === 'extract' || evidence.length === 0) {
        const parts = []
        let bytes = 0
        for (const text of evidence) {
          const size = Buffer.byteLength(text) + (parts.length ? 2 : 0)
          if (bytes + size <= REVIEW_TEXT_BYTES.answer) { parts.push(text); bytes += size }
        }
        finalRun = 'completed'
        return { mode: item.mode, answer: parts.join('\n\n'), source: selected?.outcome === 'decision' ? 'decision' : 'local', omittedCount: evidence.length - parts.length,
          ...(screening ? { screening } : {}) }
      }
      // The preview authorizes an upper bound. Local or Decisions ranking can
      // narrow it; unselected evidence is never sent to the drafting provider.
      const result = await draft.draft({ question: item.question, excerpts: evidence, publicInstructions: item.publicInstructions,
        replyStyle: item.replyStyle, model: item.draftModel, bindingId: item.draftBinding, signal: item.controller.signal, isCurrent: current })
      if (!current()) stale()
      const answer = result?.answer ?? ''
      finalRun = 'completed'
      return { mode: item.mode, answer: txt(answer, REVIEW_TEXT_BYTES.answer, { empty: true }), source: 'draft', ...(screening ? { screening } : {}) }
    } catch (error) {
      if (!current()) stale()
      finalRun = 'failed'
      if (error instanceof BoardAskError) throw error
      fail('RUN_FAILED', 'The Board Agent ask could not finish; review manually', 502)
    } finally {
      try { if (calibrationId) calibrationLog.complete(calibrationId, { run: finalRun }) } catch { /* ignore */ }
      clearTimeout(timer)
      clearInterval(check)
      signal?.removeEventListener('abort', abort)
      running.delete(ticket)
    }
  }
  function cancel(input) {
    shape(input, ['ticket'])
    if (typeof input.ticket !== 'string' || !SHA.test(input.ticket)) invalid()
    pending.delete(input.ticket)
    running.get(input.ticket)?.controller.abort()
    return { cancelled: true }
  }
  return { available, policy, lifecycle, prepare, run, cancel, close() { closed = true; pending.clear(); for (const item of running.values()) item.controller.abort() } }
}

export function boardAskPublicError(error) {
  if (error instanceof BoardAskError || knownStore.has(error?.code)) return { status: error.httpStatus, code: error.code, error: error.message }
  return { status: 500, code: PREFIX + 'FAILED', error: 'Board Agent ask could not be completed' }
}
