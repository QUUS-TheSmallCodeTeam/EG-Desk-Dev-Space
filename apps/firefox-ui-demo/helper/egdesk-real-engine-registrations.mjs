// The registrations of the real-engine check's extensions (API: ./egdesk-real-engine-extensions.mjs). One self-contained section per lane (its imports sit in its section), with an
// untouched line between sections so that two lanes adding a section never touch adjacent lines. Add yours in your slot; do not edit the core of the script format or the check.
import { registerConversationFields, registerExpectKeys, registerTurnHooks } from './egdesk-real-engine-extensions.mjs'

// ---- slot L1 ----

// ---- L7: memory (seeded pages and expect.memory) ----
import { MEMORY_EXPECT_SCHEMA, MEMORY_SCHEMA, createMemoryHook, validateMemory, validateMemoryExpect } from './egdesk-real-engine-memory.mjs'
registerConversationFields({ memory: { schema: MEMORY_SCHEMA, validate: (value, { path, bad }) => { for (const why of validateMemory(value, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerExpectKeys({ memory: { schema: MEMORY_EXPECT_SCHEMA, validate: (value, { conv, turn, path, bad }) => {
  for (const why of validateMemoryExpect(value, conv.memory, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': '))
  if (turn.whileRunning !== undefined) bad(path, 'not checked on a whileRunning turn (the memory window is the scripted turn)')
} } })
registerTurnHooks('memory', conversation => {
  const hook = createMemoryHook(conversation.memory)
  return { hook, observe: (method, params) => hook.observe(method, params), beginTurn: () => hook.beginTurn(), finishTurn: ctx => hook.finishTurn(ctx.expect?.memory) }
})

// ---- L2: journey (what reached the engine for a message typed into a working run) ----
import { ENGINE_EXPECT_SCHEMA, createJourneyHook, messageCounts, validateEngineExpect } from './egdesk-real-engine-journey.mjs'
registerExpectKeys({ engine: { schema: ENGINE_EXPECT_SCHEMA, validate: (value, { turn, path, bad }) => { for (const why of validateEngineExpect(value, { whileRunning: turn.whileRunning !== undefined }, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('journey', () => {
  const hook = createJourneyHook()
  const counts = ctx => () => { const s = ctx.state(); return messageCounts(s.store, s.clientThreadId) } // the system's own and the Agent's own messages the store holds
  return {
    hook,
    observe: (method, params) => hook.observe(method, params), observeCommand: (command, child) => hook.observeCommand(command, child),
    beginTurn: ctx => hook.beginTurn({ counts: counts(ctx) }), inRun: ctx => hook.markInRun({ text: ctx.text, counts: counts(ctx) }),
    finishTurn: ctx => hook.finishTurn({ expect: ctx.expect, nextExpect: ctx.nextExpect, latencyMs: ctx.latencyMs, counts: counts(ctx), steerContract: ctx.steerContract }),
  }
})

// ---- slot L3 ----

// ---- L4: briefing (the briefing flow; its hook itself is registered in egdesk-real-engine-hooks.mjs) ----
import { BRIEFING_EXPECT_SCHEMA, checkBriefingExpect, validateBriefingExpect } from './egdesk-real-engine-briefing-hook.mjs'
registerExpectKeys({ briefing: { schema: BRIEFING_EXPECT_SCHEMA,
  validate: (value, { conv, path, bad }) => {
    for (const why of validateBriefingExpect(value)) bad(path, why)
    if (conv.flags?.EGDESK_BRIEFING_FLOW !== 'on') bad(path, 'needs flags.EGDESK_BRIEFING_FLOW = "on" in this conversation')
  },
  check: (value, record) => checkBriefingExpect(value, record.hooks?.briefing ?? null) } })

// ---- slot L6 ----

// ---- slot L8 ----
