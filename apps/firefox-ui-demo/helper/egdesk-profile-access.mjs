import { createAccountAccessTracker } from './codex-bridge-http.mjs'
import { publicAccessFailure } from './codex-auth-state.mjs'
import { publicAuthIdentityKey } from './codex-auth-state.mjs'

// L1 c25 (U11, flag EGDESK_ROOM_ACCOUNT=on): the last auth/quota/permission rejection of a turn on an Agent profile's own app-server, kept PER PROFILE as
// status data ({kind, cause, at}; no new copy). The shared tracker (SUB-14) sees only the shared server's notifications and requests and writes the default
// account's `accessFailure`; a profile's rejection was invisible, and could never have been put there (another account never inherits a failure). Here each
// profile gets its own tracker over its own auth snapshot: the failure is stored with that account's identity, a different account signed in on the profile
// does not inherit it, a completed turn clears it, and it never touches the default account's failure or another profile's.
//   authOf(id)  -> the profile server's normalized auth ({isLoggedIn, accountEmail, ...}) or null when it has no resident, signed-in server
//   notify(id, message)                     a profile server's notification (error, turn/completed, turn/started, account/login/completed)
//   request(id, method, dispatch)           a profile RPC: turn/start rejections are recorded under the requesting identity; every other method passes through
//   failureOf(id) -> { kind, cause, at } | null   only while the profile is signed in as the account the failure was recorded for
export function createProfileAccessFailures({ authOf, enabled = () => true, now = Date.now, limit = 16 } = {}) {
  if (typeof authOf !== 'function') throw new TypeError('authOf is required')
  const failures = new Map(), trackers = new Map()
  const on = () => { try { return enabled() === true } catch { return false } }
  const safeAuth = id => { try { return authOf(id) ?? null } catch { return null } }
  function trackerFor(id) {
    let tracker = trackers.get(id)
    if (!tracker) {
      tracker = createAccountAccessTracker({
        auth: () => ({ ...(safeAuth(id) ?? {}), accessFailure: failures.get(id) ?? null }),
        update: patch => { if (patch.accessFailure) failures.set(id, patch.accessFailure); else failures.delete(id) },
        now,
      })
      trackers.set(id, tracker)
      while (trackers.size > limit) { const oldest = trackers.keys().next().value; trackers.delete(oldest); failures.delete(oldest) }
    }
    return tracker
  }
  return Object.freeze({
    notify(id, message) { if (!on() || typeof id !== 'string' || !id) return false; try { return trackerFor(id).notify(message) } catch { return false } },
    request(id, method, dispatch) {
      if (!on() || method !== 'turn/start' || typeof id !== 'string' || !id) return dispatch()
      const identity = (() => { const auth = safeAuth(id); return auth?.isLoggedIn === true ? publicAuthIdentityKey(auth) : null })()
      return trackerFor(id).request(method, dispatch, () => { const auth = safeAuth(id); return auth?.isLoggedIn === true && publicAuthIdentityKey(auth) === identity })
    },
    failureOf(id) {
      if (!on() || typeof id !== 'string') return null
      const auth = safeAuth(id), failure = publicAccessFailure(failures.get(id))
      if (!failure || auth?.isLoggedIn !== true || failure.identity !== publicAuthIdentityKey(auth)) return null
      return { kind: failure.kind, cause: failure.cause, at: failure.at }
    },
  })
}
