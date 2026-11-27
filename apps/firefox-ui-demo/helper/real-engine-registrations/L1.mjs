// The real-engine registrations of lane L1 (API: ../egdesk-real-engine-extensions.mjs). Only lane L1 edits this file: a new section goes at the END of it. The fixed import order and the ordering rules are in
// ../egdesk-real-engine-registrations.mjs (c33: one module per lane so that two lanes never touch the same lines).
import { registerExpectKeys, registerFlags, registerTurnFields, registerTurnHooks } from '../egdesk-real-engine-extensions.mjs'

// ---- L1: collaboration (two synthetic requesters in one room: `from` on a turn, expect.collab; its hook needs the live runtime and registers as a turn hook) ----
import { COLLAB_DECISION_FLAGS, COLLAB_EXPECT_SCHEMA, COLLAB_FLAGS, COLLAB_FROM, COLLAB_RESTART_KEYS, createCollabTurnHook, validateCollabExpect, validateCollabFrom } from '../egdesk-real-engine-collab-hook.mjs'
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

// ---- L1 c32: the open-item resolver (flag EGDESK_OPEN_ITEMS; expect.openItems; the hook counts the engine's turn/start and reads the runtime's own record) ----
import { OPEN_EXPECT_SCHEMA, OPEN_FLAG, createOpenItemsHook, validateOpenExpect } from '../egdesk-real-engine-open-items.mjs'
registerFlags({ reproduced: [OPEN_FLAG], decisionDependent: [OPEN_FLAG] })
registerExpectKeys({ openItems: { schema: OPEN_EXPECT_SCHEMA, validate: (value, { conv, turn, path, bad }) => { for (const why of validateOpenExpect(value, conv, turn, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('openItems', conversation => createOpenItemsHook(conversation))
