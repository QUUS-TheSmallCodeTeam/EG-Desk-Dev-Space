import { guardBridgeRequest, readJsonBody, sendJson } from './codex-bridge-http.mjs'
import { publicText } from './codex-chat-values.mjs'
import { hashContent } from './egdesk-context-store.mjs'
import { validateResolverRequest } from './egdesk-context-resolver.mjs'

const RESOLVE_MAX_BYTES = 64 * 1024
const COMMENT_MAX_BYTES = 16 * 1024
const SUGGEST_SETTINGS_MAX_BYTES = 128 * 1024
const ROUTING_KEYS = ['engineId', 'engineProfileId', 'clientThreadId', 'conversationId']

function routing(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ['ownerKey', 'epoch', 'authority'].some(key => Object.hasOwn(value, key))) throw Object.assign(new Error('Only engine and conversation routing hints are accepted; account authority is server-derived'), { code: 'INVALID_CONTEXT_ROUTE', httpStatus: 400 })
  const hints = {}
  for (const key of ROUTING_KEYS) if (value[key] !== undefined) {
    if (typeof value[key] !== 'string' || !value[key] || value[key].length > 512) throw Object.assign(new Error(`Invalid ${key}`), { code: 'INVALID_CONTEXT_ROUTE', httpStatus: 400 })
    hints[key] = value[key]
  }
  if (hints.engineId && !['codex', 'claude'].includes(hints.engineId)) throw Object.assign(new Error('Selected attachments are unsupported for this engine'), { code: 'CONTEXT_ENGINE_UNSUPPORTED', httpStatus: 409 })
  return hints
}

/**
 * Context routes (all under /context/):
 * POST /context/resolve                 CTX-03 suggestions (body: signals + optional query)
 *   -> {resolutionId, policy, resolvedAt, signalsDigest, board, candidates, suggest: {mode, omittedByMode, omittedByUser}}
 * GET|POST /context/suggest-settings    D-R2 {mode: 'always'|'firstMessage'|'off', neverSuggest: [{kind:'site',host}|{kind:'folder',path}]}
 *   POST takes either field; -> {mode, neverSuggest, persisted}. Local setting, no account needed.
 * GET  /context/sources?conversationId= CTX-04 attached sources of a conversation
 *   -> {conversationId, sources: [{sourceId, kind, viewId?, state: 'active'|'stale', reason, changedAt, announcedAt}]}
 * GET  /context/packets/:id             adds resolver and staleSources [{sourceId, reason, changedAt}]
 * plus captures, outputs and briefing comments below.
 */
export function createContextHttpHandler(context, ensureAuth, { port = 39218 } = {}) {
  return async (req, res, url) => {
    if (!url.pathname.startsWith('/context/')) return false
    try {
      if (url.pathname === '/context/resolve') {
        // CTX-03 suggestions: loopback/Origin guarded, bounded and validated
        // before any account lookup. Suggest-only — nothing is captured here.
        if (!guardBridgeRequest(req, port)) { sendJson(res, 403, { error: 'Trusted loopback origin is required', code: 'CONTEXT_LOOPBACK_REQUIRED' }); return true }
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'Use POST for context suggestions', code: 'METHOD_NOT_ALLOWED' }); return true }
        const body = await readJsonBody(req, { maxBytes: RESOLVE_MAX_BYTES })
        const hints = routing(body)
        const request = Object.fromEntries(Object.entries(body).filter(([key]) => !ROUTING_KEYS.includes(key)))
        validateResolverRequest(request)
        await ensureAuth(hints)
        const authority = context.authority(hints)
        if (authority.engineId !== 'codex') throw Object.assign(new Error('Claude B2 supports explicit selected attachments, not context suggestions'), { code: 'CONTEXT_TOOL_UNSUPPORTED', httpStatus: 409 })
        const { resolutionId, policy, resolvedAt, signalsDigest, board, candidates, suggest } = context.resolve(request, authority)
        sendJson(res, 200, { resolutionId, policy, resolvedAt, signalsDigest, board, candidates, suggest })
        return true
      }
      if (url.pathname === '/context/suggest-settings') {
        // D-R2: the person's own suggestion setting; same guard as /settings/computer-control.
        if (!guardBridgeRequest(req, port)) { sendJson(res, 403, { error: 'Trusted loopback origin is required', code: 'CONTEXT_LOOPBACK_REQUIRED' }); return true }
        if (req.method === 'GET') sendJson(res, 200, context.suggestSnapshot())
        else if (req.method === 'POST') sendJson(res, 200, context.setSuggestSettings(await readJsonBody(req, { maxBytes: SUGGEST_SETTINGS_MAX_BYTES })))
        else sendJson(res, 405, { error: 'Use GET or POST for suggestion settings', code: 'METHOD_NOT_ALLOWED' })
        return true
      }
      // Capture parses bounded client routing before authenticating, so Claude
      // can never fall through to the legacy Codex account or Reader.
      if (req.method === 'POST' && url.pathname === '/context/captures') {
        const body = await readJsonBody(req, { maxBytes: 2 * 1024 * 1024 })
        const hints = routing(body)
        await ensureAuth(hints)
        sendJson(res, 201, await context.capture(body, context.authority(hints)))
        return true
      }
      const hints = routing(Object.fromEntries(url.searchParams))
      await ensureAuth(hints)
      const authority = context.authority(hints)
      if (url.pathname === '/context/capabilities') {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'Use GET for context capabilities', code: 'METHOD_NOT_ALLOWED' }); return true }
        sendJson(res, 200, context.capabilities(authority))
        return true
      }
      if (url.pathname === '/context/sources') {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'Use GET for attached source states', code: 'METHOD_NOT_ALLOWED' }); return true }
        sendJson(res, 200, context.sourceStatus({ conversationId: url.searchParams.get('conversationId') ?? undefined }, authority))
        return true
      }
      if (authority.engineId === 'claude' && !/^\/context\/(captures|packets)\/[^/]+$/.test(url.pathname)) throw Object.assign(new Error('Claude B2 exposes immutable captures and read receipts only'), { code: 'CONTEXT_TOOL_UNSUPPORTED', httpStatus: 409 })
      // CHAT-08: Agent-published Canvas results. The list carries metadata only;
      // one result's markdown (at most 20,000 characters) comes from its own GET.
      if (url.pathname === '/context/outputs') {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'Use GET for published results', code: 'METHOD_NOT_ALLOWED' }); return true }
        const outputKey = url.searchParams.has('outputKey') ? url.searchParams.get('outputKey') : undefined
        sendJson(res, 200, await context.listOutputVersions({ conversationId: url.searchParams.get('conversationId') ?? undefined, outputKey }))
        return true
      }
      const output = url.pathname.match(/^\/context\/outputs\/([\da-f-]{36})$/i)
      if (output) {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'Use GET for a published result', code: 'METHOD_NOT_ALLOWED' }); return true }
        sendJson(res, 200, await context.readOutput(output[1]))
        return true
      }
      // CHAT-05: step comments kept as records (list, add, resolve).
      const comments = url.pathname.match(/^\/context\/briefings\/([\da-f-]{36})\/comments$/i)
      if (comments) {
        if (req.method === 'GET') sendJson(res, 200, await context.listBriefingComments(comments[1]))
        else if (req.method === 'POST') sendJson(res, 201, { comment: await context.addBriefingComment(comments[1], await readJsonBody(req, { maxBytes: COMMENT_MAX_BYTES })) })
        else sendJson(res, 405, { error: 'Use GET or POST for briefing comments', code: 'METHOD_NOT_ALLOWED' })
        return true
      }
      const comment = url.pathname.match(/^\/context\/briefing-comments\/([\da-f-]{36})$/i)
      if (comment) {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'Use POST to change a comment state', code: 'METHOD_NOT_ALLOWED' }); return true }
        sendJson(res, 200, { comment: await context.resolveBriefingComment(comment[1], await readJsonBody(req, { maxBytes: COMMENT_MAX_BYTES })) })
        return true
      }
      const match = url.pathname.match(/^\/context\/(captures|packets|briefings)\/([\da-f-]{36})$/i)
      if (req.method !== 'GET' || !match) { sendJson(res, 404, { error: 'Unknown context endpoint' }); return true }
      const owner = context.owner(authority)
      if (match[1] === 'captures') {
        const options = {}
        for (const key of ['startLine', 'endLine']) if (url.searchParams.has(key)) options[key] = Number(url.searchParams.get(key))
        if (url.searchParams.has('packetId')) options.packetId = url.searchParams.get('packetId')
        const capture = await context.store.getCapture(owner, match[2])
        await context.validateCaptures(authority, [capture], hints)
        const value = await context.store.inspect(owner, match[2], options)
        context.assertAuthority(authority)
        sendJson(res, 200, value)
      } else {
        const { ownerScope, ...record } = await context.store.getRecord(owner, match[1], match[2])
        if (authority.engineId === 'claude') {
          const capture = await context.store.getCapture(owner, record.packet?.sourceId)
          await context.validateCaptures(authority, [capture], hints)
          if (!authority.conversationId || record.binding?.conversationId !== authority.conversationId) throw Object.assign(new Error('Read receipt belongs to another conversation'), { code: 'CONTEXT_THREAD_MISMATCH', httpStatus: 403 })
        }
        if (match[1] === 'packets' && hashContent(record.deliveryText) !== record.deliveryHash) throw Object.assign(new Error('Packet integrity check failed'), { code: 'PACKET_CORRUPT', httpStatus: 409 })
        const receipts = match[1] === 'packets' ? await context.store.listRecords(owner, 'deliveries', receipt => receipt.packetId === match[2]) : []
        // CTX-03: the run's resolver record answers '왜 이것이 붙었나' (null when
        // the run used explicit attachments only). CTX-04: staleSources lists
        // the run's sources whose original changed after capture.
        const run = record.binding || {}
        const runBindings = match[1] === 'packets' && record.binding ? await context.store.listRecords(owner, 'bindings', binding => binding.conversationId === run.conversationId && binding.runId === run.runId && binding.answerId === run.answerId) : []
        const resolver = runBindings.find(binding => binding.resolver)?.resolver ?? null
        const staleSources = match[1] === 'packets' ? context.staleSourcesFor?.(owner, run.conversationId, runBindings.flatMap(binding => binding.sourceIds || [])) ?? [] : []
        context.assertAuthority(authority)
        sendJson(res, 200, match[1] === 'packets' ? { ...record, deliveryStatus: receipts.length ? 'sent-to-app-server' : 'prepared', resolver, staleSources } : record)
      }
    } catch (error) { sendJson(res, error.httpStatus || 500, { error: publicText(error.message, 2000), code: error.code || 'CONTEXT_ERROR' }) }
    return true
  }
}
