import { guardBridgeRequest, readJsonBody, sendJson } from './codex-bridge-http.mjs'
import { procedureFlagOn } from './egdesk-browser-procedure.mjs'

// Round g (L59): /v1/procedures routes, loopback only. Flag off: 404 {status:'off'}.
//   GET /v1/procedures -> { procedures: [summary] }     GET /v1/procedures/:id -> { procedure }
//   POST /v1/procedures {procedure} or the procedure itself -> 201 { procedure }     PUT /v1/procedures/:id -> { procedure }
//   DELETE /v1/procedures/:id -> { status: 'deleted' }  POST /v1/procedures/capture {clientThreadId, cardId, name?} -> { draft } (409 {status:'empty'} when the last run has no act)
export const PROCEDURE_HTTP = Object.freeze({ base: '/v1/procedures', bodyBytes: 1024 * 1024 + 4096 })
const ID = /^proc-[0-9a-f]{12,32}$/

export function createProcedureHttp({ service, enabled = () => procedureFlagOn(), port = 39218 } = {}) {
  async function handle(req, res, url) {
    const base = PROCEDURE_HTTP.base
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false
    const reply = (code, body) => { if (!res.destroyed && !res.writableEnded) sendJson(res, code, body); return true }
    if (!enabled()) return reply(404, { status: 'off' })
    if (!guardBridgeRequest(req, port)) return reply(403, { status: 'refused', reason: 'loopback-required' })
    const svc = typeof service === 'function' ? service() : service
    if (!svc) return reply(503, { status: 'unavailable' })
    const sub = url.pathname.slice(base.length).replace(/^\/|\/$/g, '')
    const allow = methods => { res.setHeader('Allow', methods); return reply(405, { status: 'refused', reason: 'method' }) }
    const body = async () => {
      try { return await readJsonBody(req, { maxBytes: PROCEDURE_HTTP.bodyBytes }) } catch (error) { reply(error?.httpStatus === 413 ? 413 : error?.httpStatus === 415 ? 415 : 400, { status: 'invalid' }); return null }
    }
    const result = (parsed, okCode) => parsed.notFound ? reply(404, { status: 'not-found' })
      : parsed.ok ? reply(okCode, { procedure: parsed.procedure }) : reply(400, { status: 'invalid', errors: parsed.errors })
    if (sub === '') {
      if (req.method === 'GET') return reply(200, { procedures: svc.list() })
      if (req.method !== 'POST') return allow('GET, POST')
      const data = await body(); if (!data) return true
      return result(svc.save(data.procedure && typeof data.procedure === 'object' ? data.procedure : data), 201)
    }
    if (sub === 'capture') {
      if (req.method !== 'POST') return allow('POST')
      const data = await body(); if (!data) return true
      if (typeof data.clientThreadId !== 'string' || typeof data.cardId !== 'string' || !data.clientThreadId || !data.cardId) return reply(400, { status: 'invalid', reason: 'thread-and-card' })
      if (data.name !== undefined && typeof data.name !== 'string') return reply(400, { status: 'invalid', reason: 'name' })
      const draft = svc.captureDraft({ clientThreadId: data.clientThreadId, cardId: data.cardId, name: data.name ?? null })
      return draft ? reply(200, { draft }) : reply(409, { status: 'empty' })
    }
    if (!ID.test(sub)) return reply(404, { status: 'not-found' })
    if (req.method === 'GET') { const procedure = svc.get(sub); return procedure ? reply(200, { procedure }) : reply(404, { status: 'not-found' }) }
    if (req.method === 'PUT') {
      const data = await body(); if (!data) return true
      return result(svc.update(sub, data.procedure && typeof data.procedure === 'object' ? data.procedure : data), 200)
    }
    if (req.method === 'DELETE') return svc.remove(sub) ? reply(200, { status: 'deleted' }) : reply(404, { status: 'not-found' })
    return allow('GET, PUT, DELETE')
  }
  return { handle }
}
