import { NativeReaderClient } from './egdesk-native-reader.mjs'

// One native Reader per Agent-profile account (L1 c24; owner decision: a profile room's big reads use the ROOM's account, U11).
// Smart reads of a large source run as read-only child threads of an app-server. The shared reader runs them on the shared app-server with the default
// account (its quota, its availability). With the room-account flag a room on an Agent profile reads on THAT profile's own app-server, as that account:
// its own request/respond routes, its own owner key, its own children and sessions. Off (the default), forProfile answers undefined and nothing changes.
//   forProfile(id) -> undefined  (flag off, or not a profile slot: the caller uses the shared reader, as before)
//                  -> the profile's reader (created on first use; a profile that is not ready fails its reads with the closed ACCOUNT_CHANGED / offline codes,
//                     it never falls back to the shared account)
//   handleNotification(id, message) / handleServerRequest(id, message) -> true when that profile's reader owns the thread (so the bridge does not forward it)
//   all() -> the readers created so far
export function createProfileReaders({ enabled = () => false, isProfileSlot, request, respond, ownerKey, makeClient = options => new NativeReaderClient(options) } = {}) {
  if (typeof isProfileSlot !== 'function' || typeof request !== 'function' || typeof respond !== 'function' || typeof ownerKey !== 'function') throw new TypeError('isProfileSlot, request, respond and ownerKey are required')
  const clients = new Map()
  const on = () => { try { return enabled() === true } catch { return false } }
  return Object.freeze({
    forProfile(id) {
      if (!on() || !isProfileSlot(id)) return undefined
      let client = clients.get(id)
      if (!client) {
        client = makeClient({ request: (method, params) => request(id, method, params), respond: (rpcId, result, error) => respond(id, rpcId, result, error), getOwnerKey: () => ownerKey(id) })
        clients.set(id, client)
        while (clients.size > 16) clients.delete(clients.keys().next().value)
      }
      return client
    },
    handleNotification(id, message) { try { return clients.get(id)?.handleNotification?.(message) === true } catch { return false } },
    handleServerRequest(id, message) { try { return clients.get(id)?.handleServerRequest?.(message) === true } catch { return false } },
    all: () => [...clients.values()],
  })
}
