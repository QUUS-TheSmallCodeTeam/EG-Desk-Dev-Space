// L2 c21: what a scripted turn may say about the ENGINE side of a message typed into a working run, for lane L5's real-engine check
// (helper/egdesk-real-engine-check.mjs), in its own module like L7's memory hook. L5 owns the check; the check calls this module at the
// registration points marked "journey hook" and nothing else of it changes.
//
// A turn may carry   "expect": { "engine": { "steers": 1, "interrupts": 0, "steerCarries": true, "flowMessages": { "max": 0 }, "maxLatencyMs": 20000 } }
// checked by code on what the check saw the product send to the engine (every request it made) and on the messages the chat store holds:
//   steers         exactly this many turn/steer requests in the window (the product steers a person's in-run message into the working turn)
//   interrupts     exactly this many turn/interrupt requests in the window (the product stops the working turn when the person says stop)
//   steerCarries   (whileRunning turn only) the first steer carries exactly the person's words as its one text input, and a client message id
//   flowMessages   the system's own short messages (the heartbeat's wait notes and replies; the store's "egdesk-flow:" messages) posted in the window:
//                  { equals?, max?, min? }
//   agentMessages  the Agent's own messages posted in the window (every assistant message that is not one of the system's): { equals?, max?, min? }
//   commandStopped (scripted turn, not whileRunning) the command EG-Desk's own tool started in the window was stopped by EG-Desk: every command of the window had
//                  ended by the end of it and the last one ended by a signal (not by finishing). The turn ending "interrupted" is the engine's doing; this is the command process.
//   maxLatencyMs   (scripted turn, not whileRunning) the whole window ended within this many ms: a command that was to run longer was cut short
// Windows are the check's own: on a scripted turn the whole window (the turn and the message typed into it); on a whileRunning turn only what
// happened after that message was sent. Nothing here asks a model whether a turn went well.
export const ENGINE_EXPECT_KEYS = Object.freeze(['steers', 'interrupts', 'steerCarries', 'flowMessages', 'agentMessages', 'maxLatencyMs', 'commandStopped'])
export const ENGINE_LIMITS = Object.freeze({ requests: 5, messages: 20, latencyMs: 3_600_000 })
const count = { type: 'integer', minimum: 0, maximum: ENGINE_LIMITS.requests }
const bounds = { type: 'object', additionalProperties: false, minProperties: 1, properties: { equals: { type: 'integer', minimum: 0, maximum: ENGINE_LIMITS.messages }, max: { type: 'integer', minimum: 0, maximum: ENGINE_LIMITS.messages }, min: { type: 'integer', minimum: 0, maximum: ENGINE_LIMITS.messages } } }
export const ENGINE_EXPECT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, minProperties: 1, properties: {
  steers: count, interrupts: count, steerCarries: { const: true }, flowMessages: bounds, agentMessages: bounds, commandStopped: { const: true },
  maxLatencyMs: { type: 'integer', minimum: 1000, maximum: ENGINE_LIMITS.latencyMs } } })
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const FLOW_PREFIX = 'egdesk-flow:'

/** validateEngineExpect(expect, { whileRunning }, where) → ['<where>: <reason>'] (empty when valid). */
export function validateEngineExpect(expect, { whileRunning = false } = {}, where = '$.expect.engine') {
  const errors = [], bad = (at, why) => { if (errors.length < 20) errors.push(`${at}: ${why}`) }
  if (!isObject(expect)) return [`${where}: an object`]
  if (!Object.keys(expect).length) bad(where, 'at least one key')
  for (const k of Object.keys(expect)) if (!ENGINE_EXPECT_KEYS.includes(k)) bad(`${where}.${k}`, 'unknown key')
  for (const k of ['steers', 'interrupts']) if (expect[k] !== undefined && !(Number.isInteger(expect[k]) && expect[k] >= 0 && expect[k] <= ENGINE_LIMITS.requests)) bad(`${where}.${k}`, `an integer 0-${ENGINE_LIMITS.requests}`)
  if (expect.steerCarries !== undefined && expect.steerCarries !== true) bad(`${where}.steerCarries`, 'true')
  if (expect.steerCarries === true && !whileRunning) bad(`${where}.steerCarries`, 'only on a whileRunning turn (the person\'s words are that turn\'s say)')
  if (expect.steerCarries === true && expect.steers === 0) bad(where, 'steerCarries and steers 0 contradict')
  if (expect.commandStopped !== undefined && expect.commandStopped !== true) bad(`${where}.commandStopped`, 'true')
  if (expect.commandStopped === true && whileRunning) bad(`${where}.commandStopped`, 'not on a whileRunning turn (state it on the turn that is running)')
  if (expect.maxLatencyMs !== undefined) {
    if (!(Number.isInteger(expect.maxLatencyMs) && expect.maxLatencyMs >= 1000 && expect.maxLatencyMs <= ENGINE_LIMITS.latencyMs)) bad(`${where}.maxLatencyMs`, `an integer 1000-${ENGINE_LIMITS.latencyMs}`)
    if (whileRunning) bad(`${where}.maxLatencyMs`, 'not on a whileRunning turn (state it on the turn that is running)')
  }
  for (const name of ['flowMessages', 'agentMessages']) {
    if (expect[name] === undefined) continue
    const f = expect[name]
    if (!isObject(f) || !Object.keys(f).length) bad(`${where}.${name}`, 'an object { equals?, max?, min? }')
    else {
      for (const k of Object.keys(f)) { if (!['equals', 'max', 'min'].includes(k)) bad(`${where}.${name}.${k}`, 'unknown key'); else if (!(Number.isInteger(f[k]) && f[k] >= 0 && f[k] <= ENGINE_LIMITS.messages)) bad(`${where}.${name}.${k}`, `an integer 0-${ENGINE_LIMITS.messages}`) }
      if (f.equals !== undefined && (f.max !== undefined || f.min !== undefined)) bad(`${where}.${name}`, 'equals excludes max and min')
      if (f.min !== undefined && f.max !== undefined && f.min > f.max) bad(`${where}.${name}`, 'min is above max')
    }
  }
  return errors
}

/**
 * createJourneyHook() → the object the check calls. Inert when no turn asks for anything (it only counts requests).
 *   observe(method, params)                     every engine request the runtime makes
 *   beginTurn({ counts })                       a scripted turn starts; counts() is { flows, agents }: the system's own and the Agent's own messages the store holds now
 *   markInRun({ text, counts })                 the message typed into the working run was sent (the whileRunning window opens here)
 *   finishTurn({ expect, nextExpect, latencyMs, counts, steerContract }) → { record, expectations, nextExpectations }
 */
export function createJourneyHook() {
  let window = null
  const zero = { flows: 0, agents: 0 }
  const fresh = counts => ({ requests: [], commands: [], start: counts?.() ?? zero, mark: null })
  return {
    observe(method, params) {
      if (!window || (method !== 'turn/steer' && method !== 'turn/interrupt')) return
      window.requests.push({ method, threadId: params?.threadId ?? null, turnId: params?.expectedTurnId ?? params?.turnId ?? null, clientUserMessageId: typeof params?.clientUserMessageId === 'string' ? params.clientUserMessageId : null,
        texts: Array.isArray(params?.input) ? params.input.map(i => (i?.type === 'text' ? i.text : null)) : null, at: window.requests.length })
    },
    /** The product's own tool started a command process (the check's spawn): remember how it ends. */
    observeCommand(command, child) {
      if (!window || !child || typeof child.on !== 'function') return
      const entry = { command: String(command ?? '').slice(0, 200), closed: false, code: null, signal: null }
      window.commands.push(entry)
      child.on('close', (code, signal) => { entry.closed = true; entry.code = Number.isInteger(code) ? code : null; entry.signal = typeof signal === 'string' ? signal : null })
    },
    beginTurn({ counts } = {}) { window = fresh(counts) },
    markInRun({ text, counts } = {}) { if (window) window.mark = { text: String(text ?? ''), requestsBefore: window.requests.length, at: counts?.() ?? zero } },
    finishTurn({ expect, nextExpect, latencyMs = null, counts, steerContract = null } = {}) {
      const w = window ?? fresh(counts), now = counts?.() ?? zero
      const steers = w.requests.filter(r => r.method === 'turn/steer'), interrupts = w.requests.filter(r => r.method === 'turn/interrupt')
      const record = { steers: steers.map(s => ({ turnId: s.turnId, texts: s.texts, clientUserMessageId: s.clientUserMessageId })), interrupts: interrupts.map(i => ({ turnId: i.turnId })), flowMessages: now.flows - w.start.flows, agentMessages: now.agents - w.start.agents, commands: w.commands.map(c => ({ command: c.command, closed: c.closed, signal: c.signal })), steerContract }
      const judge = (e, { from, text }) => {
        const out = [], put = (check, ok, detail) => out.push({ check, ok: ok === true, detail })
        const rs = w.requests.slice(from?.requests ?? 0), s = rs.filter(r => r.method === 'turn/steer'), i = rs.filter(r => r.method === 'turn/interrupt')
        const flows = now.flows - (from?.at ?? w.start).flows, agents = now.agents - (from?.at ?? w.start).agents
        if (e.steers !== undefined) put('engine.steers', s.length === e.steers, { wanted: e.steers, seen: s.length, steerContract })
        if (e.interrupts !== undefined) put('engine.interrupts', i.length === e.interrupts, { wanted: e.interrupts, seen: i.length })
        if (e.steerCarries) { const first = s[0]; put('engine.steerCarries', !!first && first.texts?.length === 1 && first.texts[0] === text && typeof first.clientUserMessageId === 'string', { texts: first?.texts ?? null, steerContract }) }
        const within = (f, n) => (f.equals === undefined || n === f.equals) && (f.max === undefined || n <= f.max) && (f.min === undefined || n >= f.min)
        if (e.flowMessages) put('engine.flowMessages', within(e.flowMessages, flows), { seen: flows })
        if (e.agentMessages) put('engine.agentMessages', within(e.agentMessages, agents), { seen: agents })
        if (e.commandStopped) put('engine.commandStopped', w.commands.length > 0 && w.commands.every(c => c.closed) && w.commands.at(-1).signal !== null, { commands: w.commands.map(c => ({ command: c.command, closed: c.closed, code: c.code, signal: c.signal })) })
        if (e.maxLatencyMs !== undefined) put('engine.maxLatencyMs', Number.isFinite(latencyMs) && latencyMs <= e.maxLatencyMs, { wanted: e.maxLatencyMs, latencyMs })
        return out
      }
      const expectations = expect?.engine ? judge(expect.engine, { from: null, text: null }) : []
      const nextExpectations = nextExpect?.engine && w.mark ? judge(nextExpect.engine, { from: { requests: w.mark.requestsBefore, at: w.mark.at }, text: w.mark.text }) : []
      window = null
      return { record: steers.length || interrupts.length || now.flows !== w.start.flows || w.commands.some(c => c.signal !== null || !c.closed) ? record : null, expectations, nextExpectations }
    },
  }
}

/** { flows, agents } the conversation's store holds: the system's own messages (the heartbeat's wait notes and replies) and the Agent's own. */
export function messageCounts(store, clientThreadId) {
  try {
    const assistant = store.listMessages(clientThreadId, { limit: 500 }).messages.filter(m => m.role === 'assistant')
    const flows = assistant.filter(m => typeof m.messageId === 'string' && m.messageId.startsWith(FLOW_PREFIX)).length
    return { flows, agents: assistant.length - flows }
  } catch { return { flows: 0, agents: 0 } }
}
