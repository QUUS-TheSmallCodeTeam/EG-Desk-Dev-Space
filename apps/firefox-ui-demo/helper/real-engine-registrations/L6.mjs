// The real-engine registrations of lane L6 (API: ../egdesk-real-engine-extensions.mjs). Only lane L6 edits this file: a new section goes at the END of it. The fixed import order and the ordering rules are in
// ../egdesk-real-engine-registrations.mjs (c33: one module per lane so that two lanes never touch the same lines).
import { registerTurnFields, registerTurnHooks } from '../egdesk-real-engine-extensions.mjs'

// ---- L6 c28: the planted-draft mode of the rewrite tool: a turn's `plant` replaces the draft the check reads (registered AFTER the rewrite hook: attach order) ----
import { PLANT_SCHEMA, createPlantedHook, validatePlant } from '../egdesk-real-engine-planted.mjs'
registerTurnFields({ plant: { schema: PLANT_SCHEMA, validate: (value, { conv, turn, path, bad }) => { for (const why of validatePlant(value, conv, turn, path)) bad(why.split(': ')[0], why.split(': ').slice(1).join(': ')) } } })
registerTurnHooks('planted', () => createPlantedHook())
