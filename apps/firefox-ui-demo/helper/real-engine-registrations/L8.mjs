// The real-engine registrations of lane L8 (API: ../egdesk-real-engine-extensions.mjs). Only lane L8 edits this file: a new section goes at the END of it. The fixed import order and the ordering rules are in
// ../egdesk-real-engine-registrations.mjs (c33: one module per lane so that two lanes never touch the same lines).
import { registerExpectKeys, registerFlags, registerTurnFields, registerTurnHooks } from '../egdesk-real-engine-extensions.mjs'

// ---- L8: browser answer (a code-built finished or handed-over browser-task note fed into a turn; expect.browserAnswer checks the REAL answering model's reply by code) ----
import { BROWSER_ANSWER_EXPECT_SCHEMA, BROWSER_TASK_SCHEMA, createBrowserAnswerHook, validateBrowserAnswerExpect, validateBrowserTask } from '../egdesk-real-engine-browser-answer-hook.mjs'
registerTurnFields({ browserTask: { schema: BROWSER_TASK_SCHEMA, validate: (value, { turn, path, bad }) => {
  for (const why of validateBrowserTask(value, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': '))
  if (turn.action !== undefined || turn.whileRunning !== undefined) bad(path, 'only a plain message turn carries a task note')
} } })
registerExpectKeys({ browserAnswer: { schema: BROWSER_ANSWER_EXPECT_SCHEMA, validate: (value, { turn, path, bad }) => { for (const why of validateBrowserAnswerExpect(value, turn, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('browserAnswer', () => createBrowserAnswerHook())
// L8 c34: the whole browser loop (the product's entry judged by the real Decision model, the steps on fixture pages, the note into the same turn, the real reply)
import { BROWSER_LOOP_EXPECT_SCHEMA, BROWSER_LOOP_FLAG, BROWSER_LOOP_SCHEMA, createBrowserLoopHook, validateBrowserLoop, validateBrowserLoopExpect } from '../egdesk-real-engine-browser-loop-hook.mjs'
import { OPEN_ITEMS_FLAG } from '../egdesk-browser-open-items.mjs'
registerFlags({ decisionDependent: [BROWSER_LOOP_FLAG, OPEN_ITEMS_FLAG] }) // c37: OPEN_ITEMS_FLAG = EGDESK_BROWSER_OPEN_ITEMS
registerTurnFields({ browserLoop: { schema: BROWSER_LOOP_SCHEMA, validate: (value, { conv, turn, path, bad }) => {
  for (const why of validateBrowserLoop(value, conv, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': '))
  if (turn.action !== undefined || turn.whileRunning !== undefined || turn.browserTask !== undefined) bad(path, 'only a plain message turn, and not together with browserTask')
} } })
registerExpectKeys({ browserLoop: { schema: BROWSER_LOOP_EXPECT_SCHEMA, validate: (value, { turn, path, bad }) => { for (const why of validateBrowserLoopExpect(value, turn, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('browserLoop', () => createBrowserLoopHook())
