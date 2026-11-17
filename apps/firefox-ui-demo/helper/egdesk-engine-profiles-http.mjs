import { guardBridgeRequest, readJsonBody, sendJson } from './codex-bridge-http.mjs'
import { publicText } from './codex-chat-values.mjs'

// SUB-11 Settings routes for Engine Profiles (loopback only):
//   GET    /settings/engine-profiles                      → { profiles, persisted }
//   POST   /settings/engine-profiles {engine, label}      → { profile, login, profiles }
//   POST   /settings/engine-profiles/active {engine, id}  → { profiles }   (refused while busy)
//   GET    /settings/engine-profiles/login-command?id=&method=  → { line, env, profileId, engine }
//   DELETE /settings/engine-profiles?id=                  → { profiles }
// Answers never carry a login folder path except in the login line itself,
// which the person runs in a Terminal card (the official CLI login).
const ROUTE = '/settings/engine-profiles'

export function createEngineProfilesHttpHandler({ profiles, busy = () => false, inUse = () => false, onChange = () => {}, port = 39218 } = {}) {
  const store = () => (typeof profiles === 'function' ? profiles() : profiles)
  const list = () => ({ profiles: store().list(), persisted: store().writable === true })
  const changed = () => { try { onChange() } catch {} }
  return async (req, res, url) => {
    if (url.pathname !== ROUTE && !url.pathname.startsWith(`${ROUTE}/`)) return false
    if (!guardBridgeRequest(req, port)) {
      sendJson(res, 403, { code: 'SETTINGS_LOOPBACK_REQUIRED', error: 'Untrusted settings request origin' })
      return true
    }
    try {
      if (url.pathname === ROUTE && req.method === 'GET') { sendJson(res, 200, list()); return true }
      if (url.pathname === ROUTE && req.method === 'POST') {
        const body = await readJsonBody(req, { maxBytes: 2048 })
        const profile = store().add({ engine: body.engine, label: body.label })
        changed()
        const login = store().loginCommand(profile.id)
        sendJson(res, 200, { profile, login: { line: login.line, env: login.env }, ...list() })
        return true
      }
      if (url.pathname === ROUTE && req.method === 'DELETE') {
        store().remove(url.searchParams.get('id'), { inUse })
        changed()
        sendJson(res, 200, list())
        return true
      }
      if (url.pathname === `${ROUTE}/active` && req.method === 'POST') {
        const body = await readJsonBody(req, { maxBytes: 1024 })
        store().setActive(body.engine, body.id, { busy })
        changed()
        sendJson(res, 200, list())
        return true
      }
      if (url.pathname === `${ROUTE}/login-command` && req.method === 'GET') {
        const login = store().loginCommand(url.searchParams.get('id'), url.searchParams.get('method') ?? undefined)
        sendJson(res, 200, { profileId: login.profileId, engine: login.engine, env: login.env, line: login.line })
        return true
      }
      sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', error: 'Unsupported engine profile request' })
    } catch (error) {
      sendJson(res, error.httpStatus || 500, { code: typeof error.code === 'string' ? error.code : 'SETTINGS_ERROR', error: publicText(error.message, 300) })
    }
    return true
  }
}
