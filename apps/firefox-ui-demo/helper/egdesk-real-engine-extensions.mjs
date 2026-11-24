// c25: the extension API of the real-engine check. Other lanes add their script keys and their per-turn record fields HERE (by registering), never by editing the core lines of
// egdesk-real-engine-script.mjs / egdesk-real-engine-check.mjs (which is what made every merge conflict). This module imports no lane module; the registrations are in
// helper/egdesk-real-engine-registrations.mjs, one self-contained section per lane.
//
//   registerExpectKeys({ <key>: { schema, validate?(value, ctx), check?(value, record) → [{ check, ok, detail }] } })
//       a turn's `expect.<key>`: its JSON schema, its validator (ctx = { conv, turn, path, bad(path, message) }) and its check against the turn record (checkTurnExpectations)
//   registerConversationFields({ <field>: { schema, validate?(value, ctx) } })     a conversation's own field (ctx = { conv, path, bad })
//   registerTurnHooks(name, create(conversation) → hook)
//       a per-conversation object that follows every scripted turn. All members optional:
//         observe(method, params)       every engine request the runtime makes        observeCommand(command, child)   the product's own tool started a command process
//         beginTurn(ctx)                a scripted turn starts                        inRun(ctx)    the message typed into the working run was sent
//         finishTurn(ctx) → { record?, expectations?, nextExpectations? }   the turn is over; `record` goes to the turn record under `name`, expectations join the turn's
//       ctx = { state() → { store, clientThreadId }, expect, nextExpect, latencyMs, steerContract, text }.  `hook` (any other member) is reachable as turnHooks.get(name)
const expectKeys = new Map(), conversationFields = new Map(), turnHooks = new Map()

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
export function registerTurnHooks(name, create) {
  if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(String(name))) throw new TypeError(`registerTurnHooks: bad name ${name}`)
  if (turnHooks.has(name)) throw new Error(`registerTurnHooks: ${name} is already registered`)
  if (typeof create !== 'function') throw new TypeError('registerTurnHooks: create must be a function')
  turnHooks.set(name, create)
}

export const registeredExpectKeys = () => [...expectKeys.keys()]
export const registeredConversationFields = () => [...conversationFields.keys()]
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
