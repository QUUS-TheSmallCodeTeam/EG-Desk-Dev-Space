// The real-engine registrations of lane L4 (API: ../egdesk-real-engine-extensions.mjs). Only lane L4 edits this file: a new section goes at the END of it. The fixed import order and the ordering rules are in
// ../egdesk-real-engine-registrations.mjs (c33: one module per lane so that two lanes never touch the same lines).
import { registerExpectKeys } from '../egdesk-real-engine-extensions.mjs'

// ---- L4: briefing (the briefing flow; its hook itself is registered in egdesk-real-engine-hooks.mjs) ----
import { BRIEFING_EXPECT_SCHEMA, checkBriefingExpect, validateBriefingExpect } from '../egdesk-real-engine-briefing-hook.mjs'
registerExpectKeys({ briefing: { schema: BRIEFING_EXPECT_SCHEMA,
  validate: (value, { conv, path, bad }) => {
    for (const why of validateBriefingExpect(value)) bad(path, why)
    if (conv.flags?.EGDESK_BRIEFING_FLOW !== 'on') bad(path, 'needs flags.EGDESK_BRIEFING_FLOW = "on" in this conversation')
  },
  check: (value, record) => checkBriefingExpect(value, record.hooks?.briefing ?? null) } })
