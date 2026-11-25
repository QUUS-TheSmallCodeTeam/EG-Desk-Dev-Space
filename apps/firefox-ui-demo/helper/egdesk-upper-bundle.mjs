// '위' bundle (L3, round u1): the developer flags of the conversation path ('위' = everything up to the conversation: chat harness, tool calls, browser and computer control, Desk, Board,
// cards) that judge a turn, switched on together by ONE setting. Name is provisional (proposal, pending approval): EGDESK_UPPER=on. Default off: nothing here runs and no flag changes unless it is set.
//
//   - A flag the person (developer) sets explicitly keeps its value, including 'off': the bundle only fills what is unset. So any single flag can still be overridden.
//   - The bundle sets developer flags only. It does NOT turn the Decision model on: that is the person's setting (account settings: mode 끔 / 기록만 / 사용, and a saved key).
//     With the mode 끔 nothing here calls the Decision model (U9); see modeGatedClient below, which makes that true for every turn-judgment feature at one place.
//   - No text the person sees is added by the bundle or by any flag in it.
//
// The order of a turn (U13 "끼릭끼릭 탁탁"): memory and action layers settle first (turn context, record write first, the open item the reply settles, a command the person asked for), then
// the engine speaks ONCE, then the answer is checked before it is posted. markStage / stagesOf record that order per run (state only).

/** role: 'surface' = a window feature the bridge answers for (the bridge announces it in chatCapabilities). 'prerequisite' = a flag another flag needs in order to do anything; 'turn' = a turn-judgment flag; 'tool' = tools the conversation engine may call; 'dormant' = a safe-direction setting that only matters when its feature is on.
 *  lands: the flag's code is on another lane's branch that is not merged yet (the value is set anyway and is inert until it merges). */
export const UPPER_BUNDLE = Object.freeze([
  Object.freeze({ flag: 'EGDESK_OWN_TOOLS', value: 'on', role: 'prerequisite', lane: 'L5', why: 'EG-Desk runs the engine\'s commands and file edits itself; decision-first (commands, approvals) acts only on a run that has these tools (Codex)' }),
  Object.freeze({ flag: 'EGDESK_TERMINAL_GATE', value: 'on', role: 'prerequisite', lane: 'L5', why: 'the command gate and the ledger of a waiting question; decision-first approvals read the reply to that question' }),
  Object.freeze({ flag: 'EGDESK_DECISION_FIRST', value: 'on', role: 'turn', lane: 'L3', why: 'action layer first: a request to run something is picked from options code built, and run by EG-Desk, before the engine speaks' }),
  Object.freeze({ flag: 'EGDESK_DECISION_FIRST_APPROVALS', value: 'on', role: 'turn', lane: 'L3', requires: ['EGDESK_DECISION_FIRST'], why: 'the reply to a waiting approval question is settled by the Decision model and code acts at once' }),
  Object.freeze({ flag: 'EGDESK_OPEN_ITEMS', value: 'on', role: 'turn', lane: 'L1', why: 'the open item a short reply ("응", "그거", "~빼고") refers to is resolved before the engine speaks' }),
  Object.freeze({ flag: 'EGDESK_PROPOSAL_REGISTRY', value: 'on', role: 'turn', lane: 'L3', why: 'the answer\'s own proposals and questions to the person are registered as items the resolver can settle' }),
  Object.freeze({ flag: 'EGDESK_TURN_MEMORY_WRITE_FIRST', value: 'on', role: 'turn', lane: 'L7', why: 'memory layer first: the record write judgment runs at the start of the turn and the engine is handed the settled state' }),
  Object.freeze({ flag: 'EGDESK_TURN_MEMORY_PREFETCH', value: 'files', role: 'turn', lane: 'L7', why: 'the working folder\'s text files are context candidates, read by code when the Decision model picks them' }),
  Object.freeze({ flag: 'EGDESK_TERMINAL_OPEN_URL', value: 'on', role: 'prerequisite', lane: 'L8', why: 'an address a program in a Terminal card asks the system to open opens in an EG-Desk Browser Card; the page tools\' AI-service sign-in opacity relies on it' }),
  Object.freeze({ flag: 'EGDESK_PAGE_TOOLS', value: 'on', role: 'tool', lane: 'L8', requires: ['EGDESK_OWN_TOOLS', 'EGDESK_TERMINAL_OPEN_URL'], lands: 'lane/u1-browser-tools', why: 'the browser as EG-Desk tools for Claude and Codex (egdesk_card_*), offered only in a run bound to a Card the person granted; code decides what needs approval, the approval ledger of the own tools carries it; no Decision model is involved' }),
  Object.freeze({ flag: 'EGDESK_HUD_ROUTING', value: 'advisory', role: 'surface', lane: 'L1', why: 'the Desk search field asks where typed text should go: the bridge answers /decision/hud-routing and tells the window (chatCapabilities hud-routing-advisory); the typed text is its own egress kind (hud_text) that every gate refuses today, so nothing leaves until the owner decides D1, and the window\'s code rules (an address, an exact name) work; cards are never moved' }),
  Object.freeze({ flag: 'EGDESK_DRAFT_CHECK', value: 'on', role: 'turn', lane: 'L6', why: 'the answer is checked before it is posted (held answer mode)' }),
  Object.freeze({ flag: 'EGDESK_FLOW_NOTE_WORDING', value: 'waiting', role: 'dormant', lane: 'L3', why: 'the concrete progress-note question; only matters when EGDESK_CONVERSATION_FLOW is on (not part of the bundle)' }),
  Object.freeze({ flag: 'EGDESK_FLOW_STALLED_COPY', value: 'none', role: 'dormant', lane: 'L3', why: 'no fixed sentence is posted when the engine stalls (owner option (다)); only matters when EGDESK_CONVERSATION_FLOW is on' }),
])

/** Flags that look like turn judgment but are NOT in the bundle, with the reason (a proposal for the owner, not a decision). */
export const NOT_IN_BUNDLE = Object.freeze({
  EGDESK_CONVERSATION_FLOW: 'posts model-written intermediate messages to the person: an owner decision of its own (open decision P2 is the fixed stalled sentence; with the bundle its copy is none)',
  EGDESK_INRUN_MESSAGES: 'changes how a message typed while a run works is handled (L2); part of the conversation-flow decision',
  EGDESK_TURN_MEMORY_ONE_PACKET: 'engine input reduction, owner decision open (C2)', EGDESK_TURN_MEMORY_PRUNE_HELD: 'engine input reduction, owner decision open (C2)', EGDESK_TURN_MEMORY_KEEP_LATE: 'engine input reduction, owner decision open (C2)',
  EGDESK_TURN_MEMORY_ENGINE_CONTEXT: 'split of over-limit context entries, owner decision open (C2)', EGDESK_CONTEXT_RELEVANCE: 'action rule set not cleared for default (open decision C2)',
  EGDESK_BROWSER_OPEN_ITEMS: 'browser task items for the resolver (L8); no bundle owner yet', EGDESK_BROWSER_ENTRY: 'browser entry judgment (L8); needs its own settings re-measure',
  EGDESK_WORKING_MEMORY: 'tool-result shortening whose activity-row wording awaits approval', EGDESK_COMMAND_JUDGE: 'advisory record of terminal state, no turn effect',
  EGDESK_CHAT_CHOICE: 'the hidden [보기 추천] feature (owner decision U4)',
})

const unset = value => value === undefined || value === null || value === ''

/**
 * Pure: the bundle's values for a flag object (a conversation's flags, an env) when EGDESK_UPPER is 'on'. Returns { on, flags, applied, kept }:
 * flags is a NEW object (the input is not changed), applied the names the bundle filled, kept the names whose explicit value stayed.
 */
export function upperBundleFlags(flags = {}) {
  const base = flags && typeof flags === 'object' ? flags : {}
  if (base.EGDESK_UPPER !== 'on') return { on: false, flags: { ...base }, applied: [], kept: [] }
  const out = { ...base }, applied = [], kept = []
  for (const row of UPPER_BUNDLE) {
    if (unset(base[row.flag])) { out[row.flag] = row.value; applied.push(row.flag) } else kept.push(row.flag)
  }
  return { on: true, flags: out, applied, kept }
}

/** Sets the bundle's values into `env` (the process environment, at bridge start, before anything reads a flag). Explicit values stay. Returns what upperBundleFlags returns (without flags). */
export function applyUpperBundle(env) {
  const { on, flags, applied, kept } = upperBundleFlags(env)
  if (on) for (const name of applied) env[name] = flags[name]
  return { on, applied, kept }
}

/** One line for the log: names only (never a value of anything but the bundle's own flags). */
export const describeUpperBundle = ({ on, applied, kept }) => (on ? `EGDESK_UPPER=on: ${applied.length} flags set, ${kept.length} kept (explicitly set)` : 'EGDESK_UPPER off')

/**
 * U9 at one place: a Decision client for every turn-judgment feature that refuses to send while the person's mode is 'off' (or no key is saved), whatever flag is on. 'advisory' and 'on' pass:
 * advisory still sends (records only) as before. Everything else of the client (model, verifyKey, ...) is the client's own, so the settings screen's key check keeps working with the mode off.
 */
export function modeGatedClient(client, { mode, configured }) {
  const refuse = code => Object.assign(new Error(`The Decision model is not used: ${code}`), { code })
  return Object.create(client, { decide: { enumerable: true, value: async request => {
    let current = 'off', saved = false
    try { current = mode() } catch { current = 'off' }
    try { saved = configured() === true } catch { saved = false }
    if (current !== 'on' && current !== 'advisory') throw refuse('decision_mode_off')
    if (!saved) throw refuse('decision_not_configured')
    return client.decide(request)
  } } })
}

/** Stage marks of a turn, state only: the order memory/action -> engine -> check, per run. */
export const TURN_STAGES = Object.freeze(['memory', 'action', 'engine', 'check'])
export function markStage(marks, run, stage, now = Date.now) {
  if (!run || !TURN_STAGES.includes(stage)) return false
  const list = marks.get(run) ?? []
  if (list.some(row => row.stage === stage)) return false // each stage once per run: the first mark is the one that counts
  list.push({ stage, at: now() }); marks.set(run, list); return true
}
export const stagesOf = (marks, run) => (marks.get(run) ?? []).map(row => ({ ...row }))

/**
 * The chatCapabilities word the bridge announces for the Desk search field's routing (lane L1's window reads it: HUD_ROUTING_CAPABILITIES in EGDeskHudRouting.sys.mjs): 'hud-routing-advisory'
 * or 'hud-routing-on' while EGDESK_HUD_ROUTING says so (set by the person or by the bundle), none otherwise. The window's own pref egdesk.hudRouting still wins when the person set it.
 */
export const HUD_ROUTING_CAPABILITIES = Object.freeze({ advisory: 'hud-routing-advisory', on: 'hud-routing-on' })
export const hudRoutingCapability = env => HUD_ROUTING_CAPABILITIES[env?.EGDESK_HUD_ROUTING] ?? null
