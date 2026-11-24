// c25: the extension API of the real-engine check. Other lanes add their script keys and their per-turn record fields HERE (by registering), never by editing the core lines of
// egdesk-real-engine-script.mjs / egdesk-real-engine-check.mjs (which is what made every merge conflict). This module imports no lane module; the registrations are in
// helper/egdesk-real-engine-registrations.mjs, one self-contained section per lane.
//
//   registerExpectKeys({ <key>: { schema, validate?(value, ctx), check?(value, record) → [{ check, ok, detail }] } })
//       a turn's `expect.<key>`: its JSON schema, its validator (ctx = { conv, turn, path, bad(path, message) }) and its check against the turn record (checkTurnExpectations)
//   registerConversationFields({ <field>: { schema, validate?(value, ctx) } })     a conversation's own field (ctx = { conv, path, bad })
//   registerFlags({ reproduced: [EGDESK_…], decisionDependent: [EGDESK_…] })       product flags this composition reproduces for a lane's feature (the check's BRIDGE_COMPOSITION.flags) and
//       the ones that need the Decision model (its preflight refuses them without --decisions) (c27)
//   registerTurnFields({ <field>: { schema, validate?(value, ctx) } })           a scripted turn's own field, beside say / approve / expect (ctx = { conv, turn, path, bad }) (c27)
//   registerTurnHooks(name, create(conversation) → hook)
//       a per-conversation object that follows every scripted turn. All members optional:
//         observe(method, params)       every engine request the runtime makes        observeCommand(command, child)   the product's own tool started a command process
//         beginTurn(ctx)                a scripted turn starts                        inRun(ctx)    the message typed into the working run was sent
//         finishTurn(ctx) → { record?, expectations?, nextExpectations? }   the turn is over; `record` goes to the turn record under `name`, expectations join the turn's
//       and, from c27 (the hooks that need the live runtime, and may wait on it):
//         flowOptions({ FLAG, conversation }) → keys added to the conversation flow's options (what the bridge adds to conversationFlow for a feature of its own)
//         attach(deps)                  once, when the runtime is composed: deps = { chat, contexts, client, store, FLAG, conversation, fetchImpl, key, calibrationLog, requestLog }
//         beforeSend(ctx)               async, before a scripted message turn is sent (ctx.turn, ctx.index; ctx.state() also names conversationId)
//         afterTurn(ctx) → { record?, expectations? }   async, after the turn's answer is posted (ctx = { run, say, answer, turnIndex, expect, state }); merged like finishTurn
//         dispose()                     when the conversation ends (errors are ignored: it only releases timers and the like)
//       and, around a restart action (c29: the bridge and the engine stopped and started again between two turns; every hook is made anew, so memory of the old bridge is gone):
//         beforeRestart(ctx) → carried  the old hook, just before the engine goes (ctx.state()); what it returns is handed to its successor
//         afterRestart(ctx) → { record?, expectations? }   the new hook, once the new runtime is composed and the room resumed (ctx = { carried, expect (the restart turn's), state }); it
//                                       becomes the restart turn's record (under the hook's name) and expectations
//       ctx = { state() → { store, clientThreadId, conversationId }, expect, nextExpect, latencyMs, steerContract, text }.  `hook` (any other member) is reachable as turnHooks.get(name)
const expectKeys = new Map(), conversationFields = new Map(), turnFields = new Map(), turnHooks = new Map()

function register(map, defs, what) {
  for (const [key, def] of Object.entries(defs ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key)) throw new TypeError(`${what}: bad name ${key}`)
    if (map.has(key)) throw new Error(`${what}: ${key} is already registered`)
    if (def === null || typeof def !== 'object' || def.schema === null || typeof def.schema !== 'object') throw new TypeError(`${what}: ${key} needs a schema`)
    for (const f of ['validate', 'check']) if (def[f] !== undefined && typeof def[f] !== 'function') throw new TypeError(`${what}: ${key}.${f} must be a function`)
    map.set(key, Object.freeze({ ...def }))
  }
}
export const registerExpectKeys = defs => register(expectKeys, defs, 'registerExpectKeys')
export const registerConversationFields = defs => register(conversationFields, defs, 'registerConversationFields')
export const registerTurnFields = defs => register(turnFields, defs, 'registerTurnFields')
const flagNames = { reproduced: [], decisionDependent: [] }
export function registerFlags({ reproduced = [], decisionDependent = [] } = {}) {
  for (const [kind, list] of [['reproduced', reproduced], ['decisionDependent', decisionDependent]]) {
    if (!Array.isArray(list)) throw new TypeError(`registerFlags: ${kind} must be a list`)
    for (const flag of list) {
      if (!/^EGDESK_[A-Z0-9_]{1,48}$/.test(String(flag))) throw new TypeError(`registerFlags: bad flag name ${flag}`)
      if (flagNames[kind].includes(flag)) throw new Error(`registerFlags: ${flag} is already registered`)
    }
  }
  flagNames.reproduced.push(...reproduced); flagNames.decisionDependent.push(...decisionDependent)
}
export const registeredFlags = () => [...flagNames.reproduced]
export const registeredDecisionFlags = () => [...flagNames.decisionDependent]
export function registerTurnHooks(name, create) {
  if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(String(name))) throw new TypeError(`registerTurnHooks: bad name ${name}`)
  if (turnHooks.has(name)) throw new Error(`registerTurnHooks: ${name} is already registered`)
  if (typeof create !== 'function') throw new TypeError('registerTurnHooks: create must be a function')
  turnHooks.set(name, create)
}

export const registeredExpectKeys = () => [...expectKeys.keys()]
export const registeredConversationFields = () => [...conversationFields.keys()]
export const registeredTurnFields = () => [...turnFields.keys()]
export const turnFieldSchemas = () => Object.fromEntries([...turnFields].map(([k, d]) => [k, d.schema]))
export const expectKeySchemas = () => Object.fromEntries([...expectKeys].map(([k, d]) => [k, d.schema]))
export const conversationFieldSchemas = () => Object.fromEntries([...conversationFields].map(([k, d]) => [k, d.schema]))
export const registeredTurnHookNames = () => [...turnHooks.keys()]

/** Run the validators of the registered keys present in `value`. `bad(path, message)` is the validator's own collector. */
export function validateRegisteredExpect(expect, { conv, turn, tt, bad }) {
  for (const [key, def] of expectKeys) if (expect?.[key] !== undefined && def.validate) def.validate(expect[key], { conv, turn, path: `${tt}.expect.${key}`, bad })
}
export function validateRegisteredConversation(conv, { at, bad }) {
  for (const [key, def] of conversationFields) if (conv?.[key] !== undefined && def.validate) def.validate(conv[key], { conv, path: `${at}.${key}`, bad })
}
export function validateRegisteredTurn(turn, { conv, tt, bad }) {
  for (const [key, def] of turnFields) if (turn?.[key] !== undefined && def.validate) def.validate(turn[key], { conv, turn, path: `${tt}.${key}`, bad })
}
export function checkRegisteredExpect(expect, record) {
  const out = []
  for (const [key, def] of expectKeys) if (expect?.[key] !== undefined && def.check) out.push(...def.check(expect[key], record))
  return out
}

/** One set of hooks for one conversation of the check. Every member is optional and guarded: a hook that throws is the check's finding, not silently skipped. */
export function createTurnHooks(conversation) {
  const hooks = [...turnHooks].map(([name, create]) => [name, create(conversation) ?? {}])
  const each = (member, ...args) => { for (const [, h] of hooks) h[member]?.(...args) }
  return {
    get: name => hooks.find(([n]) => n === name)?.[1] ?? null,
    observe: (method, params) => each('observe', method, params),
    observeCommand: (command, child) => each('observeCommand', command, child),
    beginTurn: ctx => each('beginTurn', ctx),
    inRun: ctx => each('inRun', ctx),
    // c29: around a restart action
    async beforeRestart(ctx) { const out = {}; for (const [name, h] of hooks) { const v = await h.beforeRestart?.(ctx); if (v !== undefined) out[name] = v } return out },
    async afterRestart(ctx) {
      const records = {}, expectations = []
      for (const [name, h] of hooks) {
        const r = await h.afterRestart?.({ ...ctx, carried: ctx.carried?.[name] })
        if (!r) continue
        if (r.record) records[name] = r.record
        expectations.push(...(r.expectations ?? []))
      }
      return { records, expectations }
    },
    // c27: the hooks that need the live runtime
    flowOptions: ctx => Object.assign({}, ...hooks.map(([, h]) => h.flowOptions?.(ctx) ?? {})),
    attach(deps) { for (const [, h] of hooks) h.attach?.(deps) },
    async beforeSend(ctx) { for (const [, h] of hooks) await h.beforeSend?.(ctx) },
    async afterTurn(ctx) {
      const records = {}, expectations = []
      for (const [name, h] of hooks) {
        const r = await h.afterTurn?.(ctx)
        if (!r) continue
        if (r.record) records[name] = r.record
        expectations.push(...(r.expectations ?? []))
      }
      return { records, expectations }
    },
    dispose() { for (const [, h] of hooks) { try { h.dispose?.() } catch { /* releases timers and the like only */ } } },
    finishTurn(ctx) {
      const records = {}, expectations = [], nextExpectations = []
      for (const [name, h] of hooks) {
        const r = h.finishTurn?.(ctx)
        if (!r) continue
        if (r.record) records[name] = r.record
        expectations.push(...(r.expectations ?? [])); nextExpectations.push(...(r.nextExpectations ?? []))
      }
      return { records, expectations, nextExpectations }
    },
  }
}
