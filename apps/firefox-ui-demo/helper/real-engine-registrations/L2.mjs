// The real-engine registrations of lane L2 (API: ../egdesk-real-engine-extensions.mjs). Only lane L2 edits this file: a new section goes at the END of it. The fixed import order and the ordering rules are in
// ../egdesk-real-engine-registrations.mjs (c33: one module per lane so that two lanes never touch the same lines).
import { registerExpectKeys, registerTurnHooks } from '../egdesk-real-engine-extensions.mjs'

// ---- L2: journey (what reached the engine for a message typed into a working run) ----
import { ENGINE_EXPECT_SCHEMA, createJourneyHook, messageCounts, validateEngineExpect } from '../egdesk-real-engine-journey.mjs'
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

// ---- L2 c26: the draft check's rewrite (what the real model's rewrite does after a finding) ----
import { REWRITE_EXPECT_SCHEMA, createRewriteHook, validateRewriteExpect } from '../egdesk-real-engine-rewrite.mjs'
registerExpectKeys({ rewrite: { schema: REWRITE_EXPECT_SCHEMA, validate: (value, { conv, turn, path, bad }) => {
  for (const why of validateRewriteExpect(value, conv, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': '))
  if (turn.whileRunning !== undefined || turn.action !== undefined) bad(path, 'not checked on a whileRunning or action turn')
} } })
registerTurnHooks('rewrite', conversation => createRewriteHook(conversation))

// ---- L2 c32: timing expectations (layers before the engine starts, engine rounds, first visible, final answer) ----
import { TIMING_EXPECT_SCHEMA, createTimingHook, validateTimingExpect } from '../egdesk-real-engine-timing-expect.mjs'
registerExpectKeys({ timing: { schema: TIMING_EXPECT_SCHEMA, validate: (value, { turn, path, bad }) => { for (const why of validateTimingExpect(value, turn, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('timing', () => createTimingHook())
