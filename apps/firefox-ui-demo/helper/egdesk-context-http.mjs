import { guardBridgeRequest, readJsonBody, sendJson } from './codex-bridge-http.mjs'
import { publicText } from './codex-chat-values.mjs'
import { hashContent } from './egdesk-context-store.mjs'
import { validateResolverSignals } from './egdesk-context-resolver.mjs'

const RESOLVE_MAX_BYTES = 64 * 1024

export function createContextHttpHandler(context, ensureAuth, { port = 39218 } = {}) {
  return async (req, res, url) => {
    if (!url.pathname.startsWith('/context/')) return false
    try {
      if (url.pathname === '/context/resolve') {
        // CTX-03 suggestions: loopback/Origin guarded, bounded and validated
        // before any account lookup. Suggest-only — nothing is captured here.
        if (!guardBridgeRequest(req, port)) { sendJson(res, 403, { error: 'Trusted loopback origin is required', code: 'CONTEXT_LOOPBACK_REQUIRED' }); return true }
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'Use POST for context suggestions', code: 'METHOD_NOT_ALLOWED' }); return true }
        const signals = await readJsonBody(req, { maxBytes: RESOLVE_MAX_BYTES })
        validateResolverSignals(signals)
        await ensureAuth()
        const { resolutionId, policy, resolvedAt, signalsDigest, board, candidates } = context.resolve(signals)
        sendJson(res, 200, { resolutionId, policy, resolvedAt, signalsDigest, board, candidates })
        return true
      }
      await ensureAuth()
      if (req.method === 'POST' && url.pathname === '/context/captures') {
        sendJson(res, 201, await context.capture(await readJsonBody(req, { maxBytes: 2 * 1024 * 1024 })))
        return true
      }
      const match = url.pathname.match(/^\/context\/(captures|packets|briefings)\/([\da-f-]{36})$/i)
      if (req.method !== 'GET' || !match) { sendJson(res, 404, { error: 'Unknown context endpoint' }); return true }
      const owner = context.owner(), epoch = context.runtime?.epoch
      if (match[1] === 'captures') {
        const options = {}
        for (const key of ['startLine', 'endLine']) if (url.searchParams.has(key)) options[key] = Number(url.searchParams.get(key))
        if (url.searchParams.has('packetId')) options.packetId = url.searchParams.get('packetId')
        const value = await context.store.inspect(owner, match[2], options)
        if (context.owner() !== owner || context.runtime?.epoch !== epoch) throw Object.assign(new Error('Account or connection changed during inspection'), { code: 'ACCOUNT_CHANGED', httpStatus: 403 })
        sendJson(res, 200, value)
      } else {
        const { ownerScope, ...record } = await context.store.getRecord(owner, match[1], match[2])
        if (match[1] === 'packets' && hashContent(record.deliveryText) !== record.deliveryHash) throw Object.assign(new Error('Packet integrity check failed'), { code: 'PACKET_CORRUPT', httpStatus: 409 })
        const receipts = match[1] === 'packets' ? await context.store.listRecords(owner, 'deliveries', receipt => receipt.packetId === match[2]) : []
        // CTX-04: the run's resolver record answers '왜 이것이 붙었나' (null when
        // the run used explicit attachments only).
        const run = record.binding || {}
        const resolver = match[1] === 'packets' && record.binding ? (await context.store.listRecords(owner, 'bindings', binding => binding.resolver && binding.conversationId === run.conversationId && binding.runId === run.runId && binding.answerId === run.answerId))[0]?.resolver ?? null : null
        if (context.owner() !== owner || context.runtime?.epoch !== epoch) throw Object.assign(new Error('Account or connection changed during inspection'), { code: 'ACCOUNT_CHANGED', httpStatus: 403 })
        sendJson(res, 200, match[1] === 'packets' ? { ...record, deliveryStatus: receipts.length ? 'sent-to-app-server' : 'prepared', resolver } : record)
      }
    } catch (error) { sendJson(res, error.httpStatus || 500, { error: publicText(error.message, 2000), code: error.code || 'CONTEXT_ERROR' }) }
    return true
  }
}
