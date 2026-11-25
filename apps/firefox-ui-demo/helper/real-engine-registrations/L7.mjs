// The real-engine registrations of lane L7 (API: ../egdesk-real-engine-extensions.mjs). Only lane L7 edits this file: a new section goes at the END of it. The fixed import order and the ordering rules are in
// ../egdesk-real-engine-registrations.mjs (c33: one module per lane so that two lanes never touch the same lines).
import { registerConversationFields, registerExpectKeys, registerTurnHooks } from '../egdesk-real-engine-extensions.mjs'

// ---- L7: memory (seeded pages and expect.memory) ----
import { MEMORY_EXPECT_SCHEMA, MEMORY_SCHEMA, createMemoryHook, validateMemory, validateMemoryExpect } from '../egdesk-real-engine-memory.mjs'
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
import { RECORDING_EXPECT_SCHEMA, createRecordingHook, validateRecordingExpect, validateSpeechConsent } from '../egdesk-real-engine-recording.mjs'
registerConversationFields({ speechConsent: { schema: { type: 'boolean' }, validate: (value, { conv, path, bad }) => { for (const why of validateSpeechConsent(value, conv, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerExpectKeys({ recording: { schema: RECORDING_EXPECT_SCHEMA, validate: (value, { conv, turn, path, bad }) => {
  for (const why of validateRecordingExpect(value, conv, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': '))
  if (turn.whileRunning !== undefined || turn.action !== undefined) bad(path, 'not checked on a whileRunning or action turn')
} } })
registerTurnHooks('recording', conversation => createRecordingHook(conversation))
