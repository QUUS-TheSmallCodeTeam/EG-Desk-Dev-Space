// The registrations of the real-engine check's extensions (API: ./egdesk-real-engine-extensions.mjs). One self-contained section per lane (its imports sit in its section), with an
// untouched line between sections so that two lanes adding a section never touch adjacent lines. Add yours in your slot; do not edit the core of the script format or the check.
import { registerConversationFields, registerExpectKeys, registerFlags, registerTurnFields, registerTurnHooks } from './egdesk-real-engine-extensions.mjs'

// ---- L1: collaboration (two synthetic requesters in one room: `from` on a turn, expect.collab; its hook needs the live runtime and registers as a turn hook) ----
import { COLLAB_DECISION_FLAGS, COLLAB_EXPECT_SCHEMA, COLLAB_FLAGS, COLLAB_FROM, createCollabTurnHook, validateCollabExpect, validateCollabFrom } from './egdesk-real-engine-collab-hook.mjs'
registerFlags({ reproduced: COLLAB_FLAGS, decisionDependent: COLLAB_DECISION_FLAGS })
registerTurnFields({ from: { schema: { enum: [...COLLAB_FROM] }, validate: (value, { conv, turn, path, bad }) => {
  for (const why of validateCollabFrom(value)) bad(path, why)
  if (conv.flags?.EGDESK_PRESENCE !== 'on') bad(path, 'needs flags.EGDESK_PRESENCE = "on" in this conversation (the requester goes through the presence path)')
  if (turn.action !== undefined || turn.whileRunning !== undefined) bad(path, 'only a plain message turn has a sender')
} } })
registerExpectKeys({ collab: { schema: COLLAB_EXPECT_SCHEMA, validate: (value, { conv, turn, path, bad }) => {
  for (const why of validateCollabExpect(value)) bad(path, why)
  if (conv.flags?.EGDESK_PRESENCE !== 'on') bad(path, 'needs flags.EGDESK_PRESENCE = "on" in this conversation')
  if (value.attention !== undefined) {
    for (const flag of ['EGDESK_WORK_PLACEMENT', 'EGDESK_CONVERSATION_FLOW']) if (conv.flags?.[flag] !== 'on') bad(`${path}.attention`, `needs flags.${flag} = "on" in this conversation (the scene is judged at the room's live heartbeat)`)
    if (['raised', 'posted'].includes(value.attention.pointer) && !(conv.draftCheck?.mode === 'on' || conv.flags?.EGDESK_DRAFT_CHECK === 'on')) bad(`${path}.attention.pointer`, 'a pointer message needs the draft check on in this conversation')
  }
  if (turn.whileRunning !== undefined || turn.action !== undefined) bad(path, 'not checked on a whileRunning or action turn')
} } })
registerTurnHooks('collab', conversation => createCollabTurnHook(conversation))

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

// ---- L2 c26: the draft check's rewrite (what the real model's rewrite does after a finding) ----
import { REWRITE_EXPECT_SCHEMA, createRewriteHook, validateRewriteExpect } from './egdesk-real-engine-rewrite.mjs'
registerExpectKeys({ rewrite: { schema: REWRITE_EXPECT_SCHEMA, validate: (value, { conv, turn, path, bad }) => {
  for (const why of validateRewriteExpect(value, conv, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': '))
  if (turn.whileRunning !== undefined || turn.action !== undefined) bad(path, 'not checked on a whileRunning or action turn')
} } })
registerTurnHooks('rewrite', conversation => createRewriteHook(conversation))

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

// ---- L8: browser answer (a code-built finished or handed-over browser-task note fed into a turn; expect.browserAnswer checks the REAL answering model's reply by code) ----
import { BROWSER_ANSWER_EXPECT_SCHEMA, BROWSER_TASK_SCHEMA, createBrowserAnswerHook, validateBrowserAnswerExpect, validateBrowserTask } from './egdesk-real-engine-browser-answer-hook.mjs'
registerTurnFields({ browserTask: { schema: BROWSER_TASK_SCHEMA, validate: (value, { turn, path, bad }) => {
  for (const why of validateBrowserTask(value, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': '))
  if (turn.action !== undefined || turn.whileRunning !== undefined) bad(path, 'only a plain message turn carries a task note')
} } })
registerExpectKeys({ browserAnswer: { schema: BROWSER_ANSWER_EXPECT_SCHEMA, validate: (value, { turn, path, bad }) => { for (const why of validateBrowserAnswerExpect(value, turn, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('browserAnswer', () => createBrowserAnswerHook())

// ---- L5: deletion through the product's route (seeded memory writes, expect.deleted) ----
import { DELETED_EXPECT_SCHEMA, SEEDED_WRITES_SCHEMA, checkDeleted, validateDeletedExpect, validateSeededWrites } from './egdesk-real-engine-delete.mjs'
registerConversationFields({ seededWrites: { schema: SEEDED_WRITES_SCHEMA, validate: (value, { path, bad }) => { for (const why of validateSeededWrites(value, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerExpectKeys({ deleted: { schema: DELETED_EXPECT_SCHEMA, validate: (value, { conv, turn, path, bad }) => { for (const why of validateDeletedExpect(value, conv, turn, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) },
  check: (value, record) => checkDeleted(value, record) } })
