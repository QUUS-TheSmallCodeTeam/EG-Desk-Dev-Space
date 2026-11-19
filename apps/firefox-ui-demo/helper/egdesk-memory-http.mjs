import { guardBridgeRequest, sendJson } from './codex-bridge-http.mjs'
import { publicText } from './codex-chat-values.mjs'

const ROOT = '/memory-evidence', ROUTE = ['clientThreadId', 'conversationId', 'expectedProfileId']
const ACTIONS = new Map(Object.entries({ state: [], preview: ['pin'], bind: ['ledger', 'sources', 'label', 'terms', 'consent'], read: ['id'], revoke: ['id'], 'speech-enable': ['consent'], 'speech-disable': [], 'topic-enable': ['consent'], 'topic-disable': [] }))
const PIN = ['sourceId', 'revision', 'startLine', 'endLine']
const RELATIONS = new Set(['counted', 'posted', 'recorded', 'copied', 'derived', 'scheduled', 'coverage'])
const MAX_BODY = 8192, MAX_LIST = 32, MAX_LINES = 32, MAX_TEXT = 4000, MAX_BLOB = 2 * 1024 * 1024
const PUBLIC_ERROR = Object.freeze({ code: 'MEMORY_EVIDENCE_UNAVAILABLE', error: 'Memory evidence unavailable' })
class Problem extends Error { constructor(status) { super(); this.status = status } }
const need = (ok, status = 404) => { if (!ok) throw new Problem(status) }
const exact = (v, keys, optional = []) => v && typeof v === 'object' && !Array.isArray(v) && keys.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => keys.includes(k) || optional.includes(k))
const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && v === v.trim() && v.isWellFormed() && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(v)
const label = (v, max) => str(v, max) && /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._()-]*$/u.test(v) && publicText(v) === v
const uuid = v => typeof v === 'string' && v.length === 36 && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(v)
const hash = v => typeof v === 'string' && v.length === 64 && /^[\da-f]{64}$/.test(v)
const handle = v => typeof v === 'string' && v.startsWith('memrow:') && uuid(v.slice(7))
const positive = n => Number.isSafeInteger(n) && n > 0
function pin(v, { source = false, ledger = false, trace = false } = {}) {
  return exact(v, [...PIN, ...(source ? ['relation'] : []), ...(trace ? ['text'] : [])]) && uuid(v.sourceId) && hash(v.revision) && positive(v.startLine) && positive(v.endLine) && v.endLine >= v.startLine && v.endLine - v.startLine < MAX_LINES && (!ledger || v.startLine === v.endLine) && (!source || RELATIONS.has(v.relation)) && (!trace || (typeof v.text === 'string' && v.text.length <= MAX_TEXT))
}
// JSON.parse alone silently accepts duplicate keys, including conflicting consent or routing fields.
async function bodyObject(req) {
  const chunks = []; let size = 0
  for await (const chunk of req) { const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += b.length; need(size <= MAX_BODY, 413); chunks.push(b) }
  try {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), body = JSON.parse(raw)
    // Syntax has already been checked. Tokenize strings atomically, so braces and colons inside strings are not structural.
    const stack = []
    for (const m of raw.matchAll(/"(?:[^"\\]|\\[\s\S])*"(\s*:)?|[{}\[\]]/g)) {
      if (m[1]) {
        const keys = stack.at(-1), key = JSON.parse(m[0].slice(0, -m[1].length)); need(!keys.has(key), 400); keys.add(key)
      } else if (m[0] === '{') stack.push(new Set())
      else if (m[0] === '[') stack.push(null)
      else if (m[0] === '}' || m[0] === ']') stack.pop()
    }
    return body
  } catch { throw new Problem(400) }
}
function validate(action, b) {
  need(exact(b, [...ROUTE, ...ACTIONS.get(action)], action === 'bind' ? ['expiresAt'] : []), 400)
  need(str(b.clientThreadId, 512) && str(b.conversationId, 512) && str(b.expectedProfileId, 80) && /^[a-z0-9][a-z0-9-]*$/.test(b.expectedProfileId), 400)
  if (action === 'read' || action === 'revoke') need(handle(b.id), 400)
  if (action === 'preview') need(pin(b.pin), 400)
  if (action === 'speech-enable' || action === 'topic-enable') need(b.consent === true, 400)
  if (action === 'bind') {
    need(b.consent === true && label(b.label, 80) && Array.isArray(b.terms) && b.terms.length <= 8 && b.terms.every(t => label(t, 48)) && new Set(b.terms.map(t => t.normalize('NFKC').toLowerCase())).size === b.terms.length, 400)
    need(pin(b.ledger, { ledger: true }) && Array.isArray(b.sources) && b.sources.length >= 1 && b.sources.length <= 6 && b.sources.every(p => pin(p, { source: true })), 400)
    need(!Object.hasOwn(b, 'expiresAt') || positive(b.expiresAt), 400)
  }
}
function live(dm, route) {
  need(exact(dm?.scope, ['ownerKey', 'clientThreadId', 'agentId']) && typeof dm.assertCurrent === 'function' && (dm.validateCapture === undefined || typeof dm.validateCapture === 'function'))
  const scope = Object.freeze({ ...dm.scope }) // This immutable authority also owns a compensating revoke.
  need(str(scope.ownerKey, 2048) && scope.clientThreadId === route.clientThreadId && scope.agentId === route.expectedProfileId)
  const current = () => {
    const ok = dm.assertCurrent()
    need((ok === undefined || ok === true) && Object.keys(scope).every(k => dm.scope[k] === scope[k]))
  }
  const after = value => { current(); return value }
  current()
  return { scope, current, after, validate: async m => { current(); if (dm.validateCapture) need(after(await dm.validateCapture(m)) !== false) } }
}
function topicRecipient(dm, ctx) {
  ctx.current()
  let recipient
  try { recipient = dm.topicRecipient?.() } catch { /* Unavailable is not an enable authority. */ }
  ctx.current()
  return hash(recipient) ? recipient : null
}
const topicMatches = (grant, route, recipient) => Boolean(grant?.generation && recipient && grant.recipient === recipient && grant.conversationId === route.conversationId)
function publicTopicState(evidence, dm, ctx, route) {
  const { scope, after } = ctx, recipient = topicRecipient(dm, ctx)
  const allowed = after(evidence.topicConsentState(scope))
  const grant = allowed === true ? after(evidence.topicState(scope)) : null
  const topicAllowed = allowed === false ? false : grant?.generation && hash(grant.recipient) && str(grant.conversationId, 512) ? true : null
  const result = { topicSupported: recipient !== null, topicAllowed }
  if (topicAllowed === true) {
    if (recipient) result.topicCurrent = topicMatches(grant, route, recipient)
    if (grant.conversationId === route.conversationId && Array.isArray(grant.turns) && grant.turns.length <= 96) {
      result.topicStored = grant.turns.length
      if (result.topicCurrent && typeof dm.topicAdjacent === 'function') {
        const contiguous = after(dm.topicAdjacent(grant.turns.at(-1)?.assistant?.seq ?? grant.startSeq))
        if (contiguous === false) result.topicPaused = true
      }
    }
  }
  return result
}
function eligible(m, scope, p) {
  const bytes = n => Number.isSafeInteger(n) && n >= 0 && n <= MAX_BLOB
  return m?.version === 1 && uuid(m.sourceId) && m.sourceId === p.sourceId && m.snapshotId === p.sourceId && m.clientThreadId === scope.clientThreadId && hash(m.hash) && m.revision === p.revision && m.hash === p.revision && m.payloads?.source?.hash === m.hash && hash(m.payloads?.projection?.hash) && bytes(m.payloads.source.byteLength) && bytes(m.payloads.projection.byteLength) && m.shape?.readable === true && positive(m.shape.lineCount) && bytes(m.shape.charCount) && m.shape.byteLength === m.payloads.projection.byteLength && m.truncated === false && m.capture?.coverage?.complete === true
}
// Never use readDelivery/raw bytes, the original file, source titles, or a nearby revision as a substitute.
async function projection(captures, ctx, p) {
  const { scope, current, after } = ctx
  current()
  const m = after(await captures.getCapture(scope.ownerKey, p.sourceId))
  need(eligible(m, scope, p) && (!p.endLine || p.endLine <= m.shape.lineCount))
  after(await ctx.validate(m))
  const checked = after(await captures.readProjection(scope.ownerKey, p.sourceId)), n = checked?.manifest
  need(eligible(n, scope, p) && n.payloads.projection.hash === m.payloads.projection.hash && n.shape.lineCount === m.shape.lineCount && typeof checked.text === 'string' && checked.text.length === n.shape.charCount)
  after(await ctx.validate(n))
  return checked
}
function lines(text, p) {
  let pos = 0
  for (let n = 1; n < p.startLine; n++) { pos = text.indexOf('\n', pos) + 1; need(pos > 0) }
  const out = []; let size = 0
  for (let n = p.startLine; n <= p.endLine; n++) {
    const nl = text.indexOf('\n', pos); need(nl >= 0 || n === p.endLine)
    const end = nl < 0 ? text.length : nl - Number(nl > pos && text[nl - 1] === '\r')
    size += end - pos + Number(n !== p.startLine); need(size <= MAX_TEXT)
    const line = text.slice(pos, end)
    need(line.isWellFormed() && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/u.test(line))
    out.push(line); pos = nl + 1
  }
  const value = out.join('\n'); need(value.trim()); return value
}
async function listCaptures(captures, ctx) {
  const { scope, after, current } = ctx
  const raw = after(await captures.listRecords(scope.ownerKey, 'sources', m => { current(); return m.id === m.sourceId && eligible(m, scope, m) }))
  need(Array.isArray(raw) && raw.length <= 2000) // ImmutableContextStore's own hard index bound.
  const result = [], seen = new Set(); let budget = 16 * 1024 * 1024
  for (const r of raw.sort((a, b) => b.storedAt - a.storedAt || a.sourceId.localeCompare(b.sourceId)).slice(0, MAX_LIST)) {
    current(); need(r.id === r.sourceId && eligible(r, scope, r) && !seen.has(r.sourceId)); seen.add(r.sourceId)
    const bytes = r.payloads.source.byteLength + r.payloads.projection.byteLength
    if (bytes > budget) continue
    budget -= bytes
    try {
      const { manifest: m } = after(await projection(captures, ctx, r))
      // Only explicitly captured, path-free label metadata. Never return a URL, path, locator, or a content-derived excerpt.
      result.push({ sourceId: m.sourceId, revision: m.revision, label: label(m.label, 80) ? m.label : `캡처 ${m.sourceId.slice(0, 8)}`, lineCount: m.shape.lineCount })
    } catch { current() } // Omit corrupt, missing or unauthorized entries, but never swallow loss of the DM.
  }
  return result
}
async function readTrace(evidence, captures, ctx, id) {
  const { after, scope } = ctx, trace = after(await evidence.read(scope, id))
  need(exact(trace, ['version', 'ledger', 'sources']) && trace.version === 1 && pin(trace.ledger, { ledger: true, trace: true }) && Array.isArray(trace.sources) && trace.sources.length >= 1 && trace.sources.length <= 6 && trace.sources.every(p => pin(p, { source: true, trace: true })))
  need(JSON.stringify(trace).length <= MAX_TEXT)
  for (const p of [trace.ledger, ...trace.sources]) {
    const checked = after(await projection(captures, ctx, p)); need(lines(checked.text, p) === p.text)
  }
  return trace
}

/** Bridge mount: if (await handleMemory(req, res, url)) return. No provider/server import. */
export function createMemoryEvidenceHttpHandler({ port = 39218, ensureAuth, resolveDm, captures, getEvidence, getMode = () => 'off' } = {}) {
  return async (req, res, url) => {
    const raw = typeof req.url === 'string' ? req.url : '', path = url?.pathname ?? raw.split(/[?#]/, 1)[0]
    const ours = s => s === ROOT || s.startsWith(ROOT + '/')
    if (!ours(path) && !ours(raw.split(/[?#]/, 1)[0])) return false
    let fresh
    try {
      need(guardBridgeRequest(req, port), 403)
      need(raw === path && !url?.search && !url?.hash, 400)
      const action = path.slice(ROOT.length + 1)
      need(ACTIONS.has(action) && path === `${ROOT}/${action}`)
      need(req.method === 'POST', 405)
      need(/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(req.headers['content-type'] || '') && !req.headers['content-encoding'], 415)
      const len = req.headers['content-length']
      if (len !== undefined) need(/^\d+$/.test(len) && Number(len) <= MAX_BODY, 413)
      const b = await bodyObject(req)
      validate(action, b)
      const route = { clientThreadId: b.clientThreadId, conversationId: b.conversationId }
      need(await ensureAuth({ ...route }) !== false)
      const dmRoute = { ...route, expectedProfileId: b.expectedProfileId }, resolved = await resolveDm({ ...dmRoute })
      const ctx = live(resolved, dmRoute)
      const { scope, current, after } = ctx
      const evidence = action === 'preview' ? null : after(await getEvidence())
      let result
      if (action === 'state') {
        const items = after(await listCaptures(captures, ctx)), mode = after(await getMode())
        const rows = after(await evidence.list(scope)); need(Array.isArray(rows))
        const ids = new Set()
        result = { captures: items, rows: rows.slice(0, MAX_LIST).map(row => {
          need(handle(row?.id) && label(row.label, 80) && typeof row.automatic === 'boolean' && !ids.has(row.id)); ids.add(row.id)
          return { id: row.id, label: row.label, automatic: row.automatic }
        }), decisionMode: ['off', 'advisory', 'on'].includes(mode) ? mode : 'off' }
        if (typeof evidence.speechConsentState === 'function') result.speechAllowed = after(evidence.speechConsentState(scope))
        if (typeof evidence.topicConsentState === 'function') Object.assign(result, publicTopicState(evidence, resolved, ctx, route))
        const recent = resolved.recentEvidence?.()
        // Never invent an association from the displayed quantity or a row label.
        if (recent && ids.has(recent.id) && evidence.isActive(scope, recent.id) === true) result.recentId = recent.id
      } else if (action === 'speech-enable' || action === 'speech-disable') {
        // No awaiting between the final identity check, synchronous consent update and response.
        need(after(await ensureAuth({ ...route })) !== false)
        if (action === 'speech-enable') need(after(await getMode()) === 'on', 409)
        current()
        if (action === 'speech-enable') {
          const prev = evidence.speechGrant(scope), generation = prev || evidence.enableSpeech(scope); need(generation && evidence.speechGrant(scope) === generation)
          if (!prev) fresh = { cancel: () => evidence.disableSpeech(scope, generation) }
          result = { speechAllowed: true }
        } else {
          need(evidence.clearSpeech(scope) === true && evidence.speechConsentState(scope) === false); result = { speechAllowed: false }
        }
      } else if (action === 'topic-enable' || action === 'topic-disable') {
        // No await between the final DM check, the synchronous store change and the response.
        need(after(await ensureAuth({ ...route })) !== false)
        if (action === 'topic-enable') {
          need(after(await getMode()) === 'on', 409)
          const recipient = topicRecipient(resolved, ctx); need(recipient, 409)
          const allowed = after(evidence.topicConsentState(scope)), prev = after(evidence.topicState(scope))
          // Never overwrite a different destination/conversation or an unreadable grant.
          need((allowed === false && prev === null) || (allowed === true && topicMatches(prev, route, recipient)), 409)
          let generation = prev?.generation
          if (!prev) {
            const startSeq = after(resolved.topicStartSeq?.()); need(positive(startSeq), 409)
            generation = evidence.enableTopic(scope, b.conversationId, recipient, startSeq); need(generation)
            fresh = { cancel: () => evidence.disableTopic(scope, generation) }
          }
          const grant = after(evidence.topicState(scope))
          need(topicMatches(grant, route, recipient) && grant.generation === generation && after(evidence.topicConsentState(scope)) === true)
          need(topicRecipient(resolved, ctx) === recipient, 409)
          result = { topicAllowed: true }
        } else {
          current()
          need(evidence.clearTopic(scope) === true && after(evidence.topicConsentState(scope)) === false && after(evidence.topicState(scope)) === null)
          result = { topicAllowed: false }
        }
      } else if (action === 'preview') {
        result = { text: lines(after(await projection(captures, ctx, b.pin)).text, b.pin) }
      } else if (action === 'bind') {
        for (const p of [b.ledger, ...b.sources]) lines(after(await projection(captures, ctx, p)).text, p)
        current()
        const spec = { ledger: b.ledger, sources: b.sources, ...(b.terms.length ? { discovery: { label: b.label, terms: b.terms } } : {}), ...(Object.hasOwn(b, 'expiresAt') ? { expiresAt: b.expiresAt } : {}) }
        const id = await evidence.bind(scope, spec)
        fresh = { evidence, scope, id }; current(); need(handle(id))
        need(after(await ensureAuth({ ...route })) !== false)
        result = { id }
      } else if (action === 'read') {
        result = { trace: after(await readTrace(evidence, captures, ctx, b.id)) }
        // Rechecking provenance above yielded after the store's own final grant lookup.
        need(evidence.isActive(scope, b.id) === true)
      } else {
        need(after(await evidence.revoke(scope, b.id)) === true); result = { revoked: true }
      }
      current(); sendJson(res, 200, result); fresh = null
    } catch (e) {
      if (fresh) { try { if (fresh.cancel) fresh.cancel(); else await fresh.evidence.revoke(fresh.scope, fresh.id) } catch { /* No disclosure or retry with a different owner. */ } }
      sendJson(res, e instanceof Problem ? e.status : 404, PUBLIC_ERROR)
    }
    return true
  }
}
