import { guardBridgeRequest, readJsonBody, sendJson } from './codex-bridge-http.mjs'
import { validDecisionApiKey } from './egdesk-decision-credential.mjs'

// Local routes for the decision model key (Settings → 결정 모델 · OpenAI Decisions).
//   GET    /decision/status      → { configured, store, keyHint, savedAt, model, budget }
//   POST   /decision/credential  { apiKey } → verifies with one tiny request, then saves
//   DELETE /decision/credential  → removes the saved key
//   GET    /decision/mode        → { mode, saved, persisted, modes }
//   POST   /decision/mode        { mode: 'off'|'advisory'|'on' } → saves the choice
// status also carries mode (null when no mode setting is wired).
// Same loopback/Origin guard as the other bridge routes. The key is accepted
// only in a POST body, is never echoed, and no response or log contains it.
// A key the provider authenticated but that has no usable balance (no_credit)
// or is momentarily rate limited is saved and reported, so the person can
// claim credits later without typing it again.

const SAVE_ON = new Set(['verified', 'no_credit', 'rate_limited'])
const BODY_LIMIT = 4096
const ROUTES = new Set(['/decision/status', '/decision/credential', '/decision/mode'])

// mode: the bridge-settings adapter { mode, saved, persisted, save(mode) } (optional).
export function createDecisionHttpHandler({ store, verifyKey, budget = null, model = null, mode = null, modes = ['off', 'advisory', 'on'], port = 39218 } = {}) {
  if (!store || typeof verifyKey !== 'function') throw new TypeError('store and verifyKey are required')
  const modeStatus = () => (mode ? { mode: mode.mode, saved: mode.saved, persisted: mode.persisted, modes: [...modes] } : null)
  const status = () => ({ configured: store.getApiKey() !== null, store: store.status, keyHint: store.hint(), savedAt: store.savedAt(),
    model, budget: budget ? budget.snapshot() : null, mode: mode ? mode.mode : null })
  return async (req, res, url) => {
    if (!ROUTES.has(url.pathname)) return false
    if (!guardBridgeRequest(req, port)) { sendJson(res, 403, { error: 'Trusted loopback origin is required', code: 'DECISION_LOOPBACK_REQUIRED' }); return true }
    try {
      if (url.pathname === '/decision/mode') {
        if (!mode) { sendJson(res, 404, { error: 'Not found' }); return true }
        if (req.method === 'GET') { sendJson(res, 200, modeStatus()); return true }
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'Use GET or POST for the decision mode', code: 'METHOD_NOT_ALLOWED' }); return true }
        const body = await readJsonBody(req, { maxBytes: BODY_LIMIT })
        if (!modes.includes(body?.mode)) { sendJson(res, 400, { error: 'mode must be off, advisory or on', code: 'DECISION_MODE_INVALID' }); return true }
        if (mode.save(body.mode) !== true) sendJson(res, 500, { error: 'The decision mode could not be saved', code: 'DECISION_MODE_NOT_SAVED', ...modeStatus() })
        else sendJson(res, 200, modeStatus())
        return true
      }
      if (url.pathname === '/decision/status') {
        if (req.method !== 'GET') sendJson(res, 405, { error: 'Use GET for the decision model status', code: 'METHOD_NOT_ALLOWED' })
        else sendJson(res, 200, status())
        return true
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req, { maxBytes: BODY_LIMIT })
        if (!validDecisionApiKey(body.apiKey)) { sendJson(res, 400, { error: 'This does not look like an API key', code: 'DECISION_KEY_INVALID' }); return true }
        if (!store.writable) { sendJson(res, 409, { error: 'The key cannot be saved on this computer', code: 'DECISION_STORE_UNAVAILABLE', store: store.status }); return true }
        const verified = await verifyKey(body.apiKey)
        if (!SAVE_ON.has(verified?.status)) {
          sendJson(res, 422, { error: 'The provider did not accept this key', code: 'DECISION_KEY_REJECTED', verification: verified?.status || 'unreachable' })
          return true
        }
        if (!store.save(body.apiKey)) { sendJson(res, 500, { error: 'The key could not be saved', code: 'DECISION_STORE_FAILED' }); return true }
        sendJson(res, 200, { ...status(), verification: verified.status })
        return true
      }
      if (req.method === 'DELETE') {
        if (store.clear()) sendJson(res, 200, status())
        else sendJson(res, 500, { error: 'The key could not be removed', code: 'DECISION_STORE_FAILED' })
        return true
      }
      sendJson(res, 405, { error: 'Use POST or DELETE for the decision credential', code: 'METHOD_NOT_ALLOWED' })
      return true
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'DECISION_BAD_REQUEST'
      sendJson(res, Number.isSafeInteger(error?.httpStatus) ? error.httpStatus : 400, { error: 'The request could not be read', code })
      return true
    }
  }
}
