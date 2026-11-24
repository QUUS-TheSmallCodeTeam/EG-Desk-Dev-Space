import { CODEX_ENGINE_PROFILE_ID } from './codex-engine-adapter.mjs'

// Readiness of the slot that will run a turn (L1 c23; owner rule U11: profile, subscription account, folder and screen combine independently).
// A Codex turn runs on ONE app-server: the shared one (the default account) or the owned one of an Agent profile's account. Whether a native tool
// provider may offer its tools, and whether bounded (QA) execution may start, is that app-server's own state and its own binary's probe:
//   shared slot   the shared binary's probe (schemaMatch, qaReadOnly) and the shared app-server being up
//   profile slot  that profile's own probe (profiles.capabilities(id)), which is false unless its server is running and signed in
// Neither server being down changes the other's answer. `shared()` -> { schemaMatch, qaReadOnly, ready } (read fresh on every call);
// `profiles.capabilities(id)` -> { dynamicTools, qaReadOnly, ... } (egdesk-native-capabilities capabilitiesOf, per binary).
export const isProfileSlot = id => typeof id === 'string' && id !== '' && id !== CODEX_ENGINE_PROFILE_ID

export function createSlotReadiness({ shared, profiles } = {}) {
  if (typeof shared !== 'function' || typeof profiles?.capabilities !== 'function') throw new TypeError('shared() and profiles.capabilities() are required')
  const sharedNow = () => { try { const s = shared(); return s && typeof s === 'object' ? s : {} } catch { return {} } }
  const profileNow = id => { try { return profiles.capabilities(id) ?? {} } catch { return {} } }
  return Object.freeze({
    /** route: { engineId, engineProfileId } (what the runtime hands every tool provider) -> may the provider offer its native tools? */
    schemaReady(route) {
      const id = route?.engineProfileId
      return isProfileSlot(id) ? profileNow(id).dynamicTools === true : sharedNow().schemaMatch === true && sharedNow().ready === true
    },
    /** slot: the engine profile id the turn runs on (undefined / the default = the shared slot) -> may bounded (QA) execution start? */
    qaReady(slot) {
      return isProfileSlot(slot) ? profileNow(slot).qaReadOnly === true : sharedNow().qaReadOnly === true && sharedNow().ready === true
    },
  })
}
