// The real-engine registrations of lane L5 (API: ../egdesk-real-engine-extensions.mjs). Only lane L5 edits this file: a new section goes at the END of it. The fixed import order and the ordering rules are in
// ../egdesk-real-engine-registrations.mjs (c33: one module per lane so that two lanes never touch the same lines).
import { registerConversationFields, registerExpectKeys, registerFlags, registerTurnHooks } from '../egdesk-real-engine-extensions.mjs'

// ---- L5: deletion through the product's route (seeded memory writes, expect.deleted) ----
import { DELETED_EXPECT_SCHEMA, SEEDED_WRITES_SCHEMA, checkDeleted, validateDeletedExpect, validateSeededWrites } from '../egdesk-real-engine-delete.mjs'
registerConversationFields({ seededWrites: { schema: SEEDED_WRITES_SCHEMA, validate: (value, { path, bad }) => { for (const why of validateSeededWrites(value, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerExpectKeys({ deleted: { schema: DELETED_EXPECT_SCHEMA, validate: (value, { conv, turn, path, bad }) => { for (const why of validateDeletedExpect(value, conv, turn, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) },
  check: (value, record) => checkDeleted(value, record) } })

// ---- L5: a coding task on own tools (expect.coding: the fix lands in the right file, the arbiter's reading of the re-run, the draft check's evidence, nothing outside) ----
import { CODING_EXPECT_SCHEMA, createCodingHook, validateCodingExpect } from '../egdesk-real-engine-coding.mjs'
registerExpectKeys({ coding: { schema: CODING_EXPECT_SCHEMA, validate: (value, { conv, turn, path, bad }) => { for (const why of validateCodingExpect(value, conv, turn, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('coding', conversation => createCodingHook(conversation))

// ---- L5: a prepared git merge conflict (conversation.gitScenario, expect.git: the arbiter's reading from git status, the answer, nothing committed or force-resolved) ----
import { GIT_EXPECT_SCHEMA, GIT_SCENARIO_SCHEMA, GIT_SCENARIOS, createGitSceneHook, validateGitExpect } from '../egdesk-real-engine-gitscene.mjs'
registerConversationFields({ gitScenario: { schema: GIT_SCENARIO_SCHEMA, validate: (value, { path, bad }) => { if (!GIT_SCENARIOS.includes(value)) bad(path, `one of ${GIT_SCENARIOS.join(', ')}`) } } })
registerExpectKeys({ git: { schema: GIT_EXPECT_SCHEMA, validate: (value, { conv, turn, path, bad }) => { for (const why of validateGitExpect(value, conv, turn, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('gitScene', conversation => createGitSceneHook(conversation))

// ---- L5: the decision-first command path (flag EGDESK_DECISION_FIRST in a conversation, expect.decisionFirst: fast or engine, engine turns, why) ----
import { DF_EXPECT_SCHEMA, createDecisionFirstHook, validateDecisionFirstExpect } from '../egdesk-real-engine-decision-first.mjs'
registerFlags({ reproduced: ['EGDESK_DECISION_FIRST'], decisionDependent: ['EGDESK_DECISION_FIRST'] })
registerExpectKeys({ decisionFirst: { schema: DF_EXPECT_SCHEMA, validate: (value, { conv, turn, path, bad }) => { for (const why of validateDecisionFirstExpect(value, conv, turn, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('decisionFirst', () => createDecisionFirstHook())

// ---- L5: the first-event watchdog (flag EGDESK_ENGINE_STALL_FIRST_EVENT_MS in a conversation; expect.engineStall; firstEventMs is in every turn record) ----
import { STALL_EXPECT_SCHEMA, createStallHook, validateStallExpect } from '../egdesk-real-engine-stall.mjs'
registerFlags({ reproduced: ['EGDESK_ENGINE_STALL_FIRST_EVENT_MS'] })
registerExpectKeys({ engineStall: { schema: STALL_EXPECT_SCHEMA, validate: (value, { conv, turn, path, bad }) => { for (const why of validateStallExpect(value, conv, turn, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('engineStall', () => createStallHook())
