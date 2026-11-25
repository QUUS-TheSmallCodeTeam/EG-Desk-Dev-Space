// The registrations of the real-engine check's extensions (API: ./egdesk-real-engine-extensions.mjs). One self-contained section per lane (its imports sit in its section), with an
// untouched line between sections so that two lanes adding a section never touch adjacent lines. Add yours in your slot; do not edit the core of the script format or the check.
import { registerConversationFields, registerExpectKeys, registerFlags, registerTurnFields, registerTurnHooks } from './egdesk-real-engine-extensions.mjs'

// ---- L1: collaboration (two synthetic requesters in one room: `from` on a turn, expect.collab; its hook needs the live runtime and registers as a turn hook) ----
import { COLLAB_DECISION_FLAGS, COLLAB_EXPECT_SCHEMA, COLLAB_FLAGS, COLLAB_FROM, COLLAB_RESTART_KEYS, createCollabTurnHook, validateCollabExpect, validateCollabFrom } from './egdesk-real-engine-collab-hook.mjs'
registerFlags({ reproduced: COLLAB_FLAGS, decisionDependent: COLLAB_DECISION_FLAGS })
registerTurnFields({ from: { schema: { enum: [...COLLAB_FROM] }, validate: (value, { conv, turn, path, bad }) => {
  for (const why of validateCollabFrom(value)) bad(path, why)
  if (conv.flags?.EGDESK_PRESENCE !== 'on') bad(path, 'needs flags.EGDESK_PRESENCE = "on" in this conversation (the requester goes through the presence path)')
  if (turn.action !== undefined || turn.whileRunning !== undefined) bad(path, 'only a plain message turn has a sender')
} } })
// c30: a CONCURRENT run: another room's message (from the owner or the invited member) sent right after this turn's, on the same runtime, while this one works (the core sends it)
registerTurnFields({ alongside: { schema: { type: 'object', additionalProperties: false, required: ['say'], properties: { say: { type: 'string', minLength: 1, maxLength: 4000 }, from: { enum: [...COLLAB_FROM] } } },
  validate: (value, { conv, turn, path, bad }) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return bad(path, 'an object { say, from? }')
    for (const k of Object.keys(value)) if (!['say', 'from'].includes(k)) bad(`${path}.${k}`, 'unknown key')
    if (typeof value.say !== 'string' || !value.say.trim() || value.say.length > 4000) bad(`${path}.say`, 'a string of 1-4000 characters')
    if (value.from !== undefined) for (const why of validateCollabFrom(value.from)) bad(`${path}.from`, why)
    if (conv.flags?.EGDESK_PRESENCE !== 'on') bad(path, 'needs flags.EGDESK_PRESENCE = "on" in this conversation')
    if (turn.action !== undefined || turn.whileRunning !== undefined || turn.approve?.length) bad(path, 'only a plain message turn without approvals has a concurrent run')
    if (value.say === turn.say) bad(`${path}.say`, 'must differ from the turn\'s own say (each run quotes only its own request)')
  } } })
registerExpectKeys({ collab: { schema: COLLAB_EXPECT_SCHEMA, validate: (value, { conv, turn, path, bad }) => {
  for (const why of validateCollabExpect(value)) bad(path, why)
  if (conv.flags?.EGDESK_PRESENCE !== 'on') bad(path, 'needs flags.EGDESK_PRESENCE = "on" in this conversation')
  const restartTurn = turn.action === 'restart', prev = conv.turns[conv.turns.indexOf(turn) - 1]
  if (restartTurn) { for (const k of Object.keys(value)) if (!COLLAB_RESTART_KEYS.includes(k)) bad(`${path}.${k}`, 'a restart turn takes only roomKept and receiptsClosed') }
  else {
    for (const k of COLLAB_RESTART_KEYS) if (value[k] !== undefined) bad(`${path}.${k}`, 'belongs to a restart turn')
    if (value.twoRuns !== undefined && turn.alongside === undefined) bad(`${path}.twoRuns`, 'needs the turn\'s alongside (two runs at the same time)')
    if (value.twoRuns !== undefined) for (const flag of ['EGDESK_WORK_PLACEMENT', 'EGDESK_CONVERSATION_FLOW']) if (conv.flags?.[flag] !== 'on') bad(`${path}.twoRuns`, `needs flags.${flag} = "on" in this conversation`)
    if (value.continuity !== undefined && prev?.action !== 'restart') bad(`${path}.continuity`, 'belongs to the message turn right after a restart')
    if (turn.whileRunning !== undefined || turn.action !== undefined) bad(path, 'not checked on a whileRunning or action turn')
  }
  if (value.attention !== undefined) {
    for (const flag of ['EGDESK_WORK_PLACEMENT', 'EGDESK_CONVERSATION_FLOW']) if (conv.flags?.[flag] !== 'on') bad(`${path}.attention`, `needs flags.${flag} = "on" in this conversation (the scene is judged at the room's live heartbeat)`)
    if (['raised', 'posted'].includes(value.attention.pointer) && !(conv.draftCheck?.mode === 'on' || conv.flags?.EGDESK_DRAFT_CHECK === 'on')) bad(`${path}.attention.pointer`, 'a pointer message needs the draft check on in this conversation')
  }
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

// ---- L7 c34: recording (the memory write path: pending readings, their confirmation; expect.recording) ----
import { RECORDING_EXPECT_SCHEMA, createRecordingHook, validateRecordingExpect, validateSpeechConsent } from './egdesk-real-engine-recording.mjs'
registerConversationFields({ speechConsent: { schema: { type: 'boolean' }, validate: (value, { conv, path, bad }) => { for (const why of validateSpeechConsent(value, conv, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerExpectKeys({ recording: { schema: RECORDING_EXPECT_SCHEMA, validate: (value, { conv, turn, path, bad }) => {
  for (const why of validateRecordingExpect(value, conv, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': '))
  if (turn.whileRunning !== undefined || turn.action !== undefined) bad(path, 'not checked on a whileRunning or action turn')
} } })
registerTurnHooks('recording', conversation => createRecordingHook(conversation))

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

// ---- L6 c28: the planted-draft mode of the rewrite tool: a turn's `plant` replaces the draft the check reads (registered AFTER the rewrite hook: attach order) ----
import { PLANT_SCHEMA, createPlantedHook, validatePlant } from './egdesk-real-engine-planted.mjs'
registerTurnFields({ plant: { schema: PLANT_SCHEMA, validate: (value, { conv, turn, path, bad }) => { for (const why of validatePlant(value, conv, turn, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('planted', () => createPlantedHook())


// ---- L3 c32: decision-first approvals (flag EGDESK_DECISION_FIRST_APPROVALS, with EGDESK_DECISION_FIRST: the reply to the engine's question is settled by the Decision and code at once; the reasons approval_* are in the decisionFirst expectation) ----
registerFlags({ reproduced: ['EGDESK_DECISION_FIRST_APPROVALS'], decisionDependent: ['EGDESK_DECISION_FIRST_APPROVALS'] })
// ---- L3 c33: the answer's open proposals as defined items (flag EGDESK_PROPOSAL_REGISTRY; state only, no copy)
registerFlags({ reproduced: ['EGDESK_PROPOSAL_REGISTRY'], decisionDependent: ['EGDESK_PROPOSAL_REGISTRY'] })
import { PROPOSALS_EXPECT_SCHEMA, createProposalsHook, validateProposalsExpect } from './egdesk-real-engine-proposals-hook.mjs'
registerExpectKeys({ proposals: { schema: PROPOSALS_EXPECT_SCHEMA, validate: (value, { conv, path, bad }) => { for (const why of validateProposalsExpect(value, { conv }, path)) bad(path, why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('proposals', () => createProposalsHook())

// ---- L3: the heartbeat's own messages (expect.flow: notes, firstNoteMs, statedSecondsTrue, noResult) ----
import { FLOW_EXPECT_SCHEMA, createFlowHook, validateFlowExpect } from './egdesk-real-engine-flow.mjs'
registerExpectKeys({ flow: { schema: FLOW_EXPECT_SCHEMA, validate: (value, { conv, turn, path, bad }) => { for (const why of validateFlowExpect(value, { conv, turn }, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('flow', () => {
  const hook = createFlowHook()
  return { hook, beginTurn: ctx => hook.beginTurn(ctx), finishTurn: ctx => hook.finishTurn(ctx) }
})

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
// L8 c34: the whole browser loop (the product's entry judged by the real Decision model, the steps on fixture pages, the note into the same turn, the real reply)
import { BROWSER_LOOP_EXPECT_SCHEMA, BROWSER_LOOP_FLAG, BROWSER_LOOP_SCHEMA, createBrowserLoopHook, validateBrowserLoop, validateBrowserLoopExpect } from './egdesk-real-engine-browser-loop-hook.mjs'
registerFlags({ decisionDependent: [BROWSER_LOOP_FLAG] })
registerTurnFields({ browserLoop: { schema: BROWSER_LOOP_SCHEMA, validate: (value, { conv, turn, path, bad }) => {
  for (const why of validateBrowserLoop(value, conv, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': '))
  if (turn.action !== undefined || turn.whileRunning !== undefined || turn.browserTask !== undefined) bad(path, 'only a plain message turn, and not together with browserTask')
} } })
registerExpectKeys({ browserLoop: { schema: BROWSER_LOOP_EXPECT_SCHEMA, validate: (value, { turn, path, bad }) => { for (const why of validateBrowserLoopExpect(value, turn, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('browserLoop', () => createBrowserLoopHook())

// ---- L5: deletion through the product's route (seeded memory writes, expect.deleted) ----
import { DELETED_EXPECT_SCHEMA, SEEDED_WRITES_SCHEMA, checkDeleted, validateDeletedExpect, validateSeededWrites } from './egdesk-real-engine-delete.mjs'
registerConversationFields({ seededWrites: { schema: SEEDED_WRITES_SCHEMA, validate: (value, { path, bad }) => { for (const why of validateSeededWrites(value, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerExpectKeys({ deleted: { schema: DELETED_EXPECT_SCHEMA, validate: (value, { conv, turn, path, bad }) => { for (const why of validateDeletedExpect(value, conv, turn, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) },
  check: (value, record) => checkDeleted(value, record) } })

// ---- L5: a coding task on own tools (expect.coding: the fix lands in the right file, the arbiter's reading of the re-run, the draft check's evidence, nothing outside) ----
import { CODING_EXPECT_SCHEMA, createCodingHook, validateCodingExpect } from './egdesk-real-engine-coding.mjs'
registerExpectKeys({ coding: { schema: CODING_EXPECT_SCHEMA, validate: (value, { conv, turn, path, bad }) => { for (const why of validateCodingExpect(value, conv, turn, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('coding', conversation => createCodingHook(conversation))

// ---- L5: a prepared git merge conflict (conversation.gitScenario, expect.git: the arbiter's reading from git status, the answer, nothing committed or force-resolved) ----
import { GIT_EXPECT_SCHEMA, GIT_SCENARIO_SCHEMA, GIT_SCENARIOS, createGitSceneHook, validateGitExpect } from './egdesk-real-engine-gitscene.mjs'
registerConversationFields({ gitScenario: { schema: GIT_SCENARIO_SCHEMA, validate: (value, { path, bad }) => { if (!GIT_SCENARIOS.includes(value)) bad(path, `one of ${GIT_SCENARIOS.join(', ')}`) } } })
registerExpectKeys({ git: { schema: GIT_EXPECT_SCHEMA, validate: (value, { conv, turn, path, bad }) => { for (const why of validateGitExpect(value, conv, turn, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('gitScene', conversation => createGitSceneHook(conversation))

// ---- L5: the decision-first command path (flag EGDESK_DECISION_FIRST in a conversation, expect.decisionFirst: fast or engine, engine turns, why) ----
import { DF_EXPECT_SCHEMA, createDecisionFirstHook, validateDecisionFirstExpect } from './egdesk-real-engine-decision-first.mjs'
registerFlags({ reproduced: ['EGDESK_DECISION_FIRST'], decisionDependent: ['EGDESK_DECISION_FIRST'] })
registerExpectKeys({ decisionFirst: { schema: DF_EXPECT_SCHEMA, validate: (value, { conv, turn, path, bad }) => { for (const why of validateDecisionFirstExpect(value, conv, turn, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('decisionFirst', () => createDecisionFirstHook())

// ---- L5: the first-event watchdog (flag EGDESK_ENGINE_STALL_FIRST_EVENT_MS in a conversation; expect.engineStall; firstEventMs is in every turn record) ----
import { STALL_EXPECT_SCHEMA, createStallHook, validateStallExpect } from './egdesk-real-engine-stall.mjs'
registerFlags({ reproduced: ['EGDESK_ENGINE_STALL_FIRST_EVENT_MS'] })
registerExpectKeys({ engineStall: { schema: STALL_EXPECT_SCHEMA, validate: (value, { conv, turn, path, bad }) => { for (const why of validateStallExpect(value, conv, turn, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('engineStall', () => createStallHook())
