// The real-engine registrations of lane L3 (API: ../egdesk-real-engine-extensions.mjs). Only lane L3 edits this file: a new section goes at the END of it. The fixed import order and the ordering rules are in
// ../egdesk-real-engine-registrations.mjs (c33: one module per lane so that two lanes never touch the same lines).
import { registerExpectKeys, registerFlags, registerTurnHooks } from '../egdesk-real-engine-extensions.mjs'

// ---- L3 c32: decision-first approvals (flag EGDESK_DECISION_FIRST_APPROVALS, with EGDESK_DECISION_FIRST: the reply to the engine's question is settled by the Decision and code at once; the reasons approval_* are in the decisionFirst expectation) ----
registerFlags({ reproduced: ['EGDESK_DECISION_FIRST_APPROVALS'], decisionDependent: ['EGDESK_DECISION_FIRST_APPROVALS'] })

// ---- L3 c33: the answer's open proposals as defined items (flag EGDESK_PROPOSAL_REGISTRY; state only, no copy)
registerFlags({ reproduced: ['EGDESK_PROPOSAL_REGISTRY'], decisionDependent: ['EGDESK_PROPOSAL_REGISTRY'] })
// u1: the '위' bundle setting (helper/egdesk-upper-bundle.mjs): fills the conversation path's turn-judgment flags the script did not set
registerFlags({ reproduced: ['EGDESK_UPPER'], decisionDependent: ['EGDESK_UPPER'] })
import { PROPOSALS_EXPECT_SCHEMA, createProposalsHook, validateProposalsExpect } from '../egdesk-real-engine-proposals-hook.mjs'
registerExpectKeys({ proposals: { schema: PROPOSALS_EXPECT_SCHEMA, validate: (value, { conv, path, bad }) => { for (const why of validateProposalsExpect(value, { conv }, path)) bad(path, why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('proposals', conversation => createProposalsHook(conversation))

// u1: the order of a turn (memory/action -> engine -> check) as the runtime marked it; expect.stages { order | includes } (helper/egdesk-real-engine-stages-hook.mjs)
import { STAGES_EXPECT_SCHEMA, createStagesHook, validateStagesExpect } from '../egdesk-real-engine-stages-hook.mjs'
registerExpectKeys({ stages: { schema: STAGES_EXPECT_SCHEMA, validate: (value, { path, bad }) => { for (const why of validateStagesExpect(value, path)) bad(path, why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('stages', () => createStagesHook())

// ---- L3: the heartbeat's own messages (expect.flow: notes, firstNoteMs, statedSecondsTrue, noResult) ----
import { FLOW_EXPECT_SCHEMA, createFlowHook, validateFlowExpect } from '../egdesk-real-engine-flow.mjs'
registerExpectKeys({ flow: { schema: FLOW_EXPECT_SCHEMA, validate: (value, { conv, turn, path, bad }) => { for (const why of validateFlowExpect(value, { conv, turn }, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('flow', () => {
  const hook = createFlowHook()
  return { hook, beginTurn: ctx => hook.beginTurn(ctx), finishTurn: ctx => hook.finishTurn(ctx) }
})
