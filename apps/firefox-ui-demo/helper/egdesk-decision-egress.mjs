import { DecisionError } from './egdesk-decision-client.mjs'

// One rule for everything that leaves for the Decision model: it is a model like the others, so it follows the SAME
// data-sharing permissions as the subjective models of this run, and nothing more.
//   - There is no Decision-specific consent, switch or allow-list here. A permission exists only because the run's own
//     model permissions already say the subjective model may receive that class of data.
//   - A kind that is not allowed for the models is not sent to Decisions either: the guarded client refuses BEFORE any key
//     lookup or request (zero requests), with the closed code `evidence_unavailable`, and every feature already falls back
//     on a DecisionError exactly as it does for an outage.
//   - An unknown kind is refused.
// `mode` (off / advisory / on) and the saved key stay what they were: they decide whether Decisions is used at all.
export const EGRESS_KINDS = Object.freeze({
  terminal_output: Object.freeze({ data: 'terminal', governedBy: 'Agent tool ceiling: terminal (none = no terminal output reaches any model)' }),
  command_output: Object.freeze({ data: Object.freeze(['terminal', 'run']), governedBy: 'Output of commands this run\'s own engine executed, which the run\'s model already receives: Agent tool ceiling terminal (none = the Agent runs no commands) and a live run. A Terminal card\'s output is NOT this kind' }),
  terminal_command: Object.freeze({ data: 'terminal', governedBy: 'Agent tool ceiling: terminal (none = the Agent runs no commands, so none are scored)' }),
  page_text: Object.freeze({ data: 'browser', governedBy: 'Agent tool ceiling: browser (none = no page text) and this run\'s selected Browser Card grant' }),
  browser_task_record: Object.freeze({ data: 'browser', governedBy: 'Agent tool ceiling: browser and this run\'s selected Browser Card grant (records of the Browser task)' }),
  canvas_text: Object.freeze({ data: 'canvas', governedBy: 'Per-card maySend (host-computed: may this card go to a model) for step texts and card labels' }),
  run_facts: Object.freeze({ data: 'run', governedBy: 'This run\'s own state as numbers and closed labels only (heartbeat elapsed times, the current phase, step counts, whether the Agent asked a question); never text of the run, the person or a model' }),
  run_text: Object.freeze({ data: 'run', governedBy: 'This run\'s own conversation text, which its model already receives or wrote: the person\'s request, the Agent\'s notes to itself, the names of the tools it runs and the messages already posted in this run (bounded quotes for the heartbeat\'s message questions)' }),
  draft_text: Object.freeze({ data: 'run', governedBy: 'The run\'s own evidence: catalog items only by the kinds the model itself received; tool outputs stay content-free references' }),
  memory_page: Object.freeze({ data: 'memory', governedBy: 'Memory scope of this DM/Agent (allowsPage: the page\'s own guard plus the scope the answering model may read)' }),
  speech_history: Object.freeze({ data: 'speech', governedBy: 'Per-DM speech reuse consent (the same consent that lets the answering model see past utterances)' }),
  previous_reply: Object.freeze({ data: 'thread', governedBy: 'The assistant message right before this turn, which the answering model holds in its own native thread (same thread, completed turns, not compacted; Codex only, where compaction is reported). A bounded excerpt, quoted as data (L7 c22)' }),
  topic_history: Object.freeze({ data: 'topic', governedBy: 'Per-DM topic memory consent (the same consent that lets the answering model see past turns)' }),
  // L1 c20: the words the person typed into the Desk's search field, before anything was sent. No structure lets ANY model see them (the
  // field promises to search this device first), and Decisions gets no permission of its own, so this kind is refused by every gate: its
  // class is not a model data class. It opens only if the owner decides a permission that covers all models (owner decision pending).
  hud_text: Object.freeze({ data: 'hud', governedBy: 'No model permission covers typed search-field text yet: refused everywhere (owner decision pending)' }),
  // L7 c37 (prefetch): the relative paths, sizes and dates of the files of the folder the run's engine works in: the engine reads that folder itself, so the decision model may read its listing.
  // Never file text (that goes to the engine only; u5: the draft check may read the text of a prefetched file the ENGINE was given, as evidence kind 'file', class 'files', behind EGDESK_DRAFT_CHECK_FILES). Open only when the run has a bound working folder the engine may read (workspaceRead).
  workspace_names: Object.freeze({ data: 'files', governedBy: 'The run\'s own working folder, which its engine reads: only the listing (path, size, date), only for a run with a bound folder' }),
  // U1 B1 (EG-Desk's own computer tools): pixels of a Mac window and the labels read from it. They go to the run's engine model only; no model
  // permission covers the decision model, so this kind is refused by every gate (owner decision pending, same as hud_text).
  screen_capture: Object.freeze({ data: 'screen', governedBy: 'No model permission covers a screen image yet: the pixels of a window the Agent looked at go to the run\'s engine model only, never to the decision model (owner decision pending)' }),
  // u5 (observe first): the names of the open apps that EG-Desk's own list_apps returned (never an app the provider denies), asked of the decision model to pick the one the person means. The run's engine model
  // receives the same list as the result of its own list_apps call, so this is the run's own data (PROPOSAL until the owner confirms: window titles, elements and pixels are NOT covered, see screen_capture).
  app_names: Object.freeze({ data: 'run', governedBy: 'The names of the apps EG-Desk\'s own list_apps returned for this run (denied apps are never listed), which the run\'s engine model receives in the same tool result; never a window title, an element or a picture' }),
  board_excerpt: Object.freeze({ data: 'board', governedBy: 'This Board ask itself: the owner chose and confirmed a run that sends the approved public excerpts to the drafting model. An extract-only ask sends them to no model, so not to Decisions either' }),
})
// Requests that carry NO data of any class: one fixed body each, byte for byte (c18, the idle warm-up). They are not in EGRESS_KINDS because a
// kind is a class of the run's data that a model permission opens; these have nothing to open. The gate lets exactly this body through
// (guardContentFree) and refuses anything else under the name, so the name cannot be used to send data.
export const CONTENT_FREE_REQUESTS = Object.freeze({
  warmup: Object.freeze({
    input: 'EG-Desk warm-up',
    questions: Object.freeze([Object.freeze({ type: 'predicate', name: 'warmup_check', instructions: 'Is the input a warm-up message?' })]),
    governedBy: 'No data: a fixed message that names no person, run, page or text (the same shape as the key check). Sent only after a long idle, only when the Decisions mode is not off and a key is saved (egdesk-decision-warmup.mjs)',
  }),
})
const sameContentFree = (name, request) => {
  const fixed = Object.hasOwn(CONTENT_FREE_REQUESTS, name) ? CONTENT_FREE_REQUESTS[name] : null
  if (!fixed || !request || typeof request !== 'object') return false
  const extra = Object.keys(request).filter(key => !['input', 'questions', 'timeoutMs', 'signal'].includes(key))
  return extra.length === 0 && request.input === fixed.input && JSON.stringify(request.questions) === JSON.stringify(fixed.questions)
}
const DATA_CLASSES = Object.freeze(['terminal', 'browser', 'canvas', 'run', 'memory', 'speech', 'topic', 'board', 'thread', 'files', 'screen'])
// Evidence kinds a draft-check catalog may carry, and the data class that already lets a model see them.
// Items of the decision context packet were already admitted for this run's answering model, so they count as the run's own data.
// run_state: what the run is doing now, from the runtime's own facts (the heartbeat's material a message was composed from).
const EVIDENCE_CLASS = Object.freeze({ source: 'run', document: 'run', conversation: 'run', timeline: 'run', board: 'run', run_state: 'run', memory: 'memory', terminal: 'terminal', browser: 'browser', file: 'files' })

/**
 * modelDataPermissions({ toolCeiling, browserGranted, canvasMaySend, memoryScope, speechConsent, topicConsent, runActive, boardExcerptsToModel })
 * Derived ONLY from the structures that already govern the subjective models:
 *   toolCeiling: the run's effective Agent tool ceiling (codex-chat-tool-ceiling.mjs) or null for none
 *   browserGranted: the run has a selected Browser Card grant (run.browserBinding.cards)
 *   canvasMaySend: at least one selected canvas card the host marked maySend
 *   memoryScope: the memory scope object the answering model's packet is built with, or null
 *   speechConsent / topicConsent: per-DM consent states for reusing past utterances / turns
 *   runActive: there is a run whose answer text and evidence the model owns
 *   boardExcerptsToModel: this Board ask sends the owner-approved excerpts to a model (the drafting model of a confirmed draft run)
 *   threadReply: the answering model holds the previous assistant message in its own live native thread (mid-session, not compacted)
 */
export function modelDataPermissions({ toolCeiling = null, browserGranted = false, canvasMaySend = false, memoryScope = null, speechConsent = false, topicConsent = false, runActive = false, boardExcerptsToModel = false, workspaceRead = false, threadReply = false } = {}) {
  const ceiling = toolCeiling && typeof toolCeiling === 'object' ? toolCeiling : null
  return Object.freeze({
    terminal: ceiling ? ceiling.terminal !== 'none' : true,
    browser: browserGranted === true && (ceiling ? ceiling.browser !== 'none' : true),
    canvas: canvasMaySend === true,
    run: runActive === true,
    memory: memoryScope !== null && typeof memoryScope === 'object',
    speech: speechConsent === true,
    topic: topicConsent === true,
    board: boardExcerptsToModel === true,
    thread: threadReply === true,
    files: workspaceRead === true,
  })
}

/** The gate for one run's permissions. Anything not in the table, or whose class is false, is refused. */
export function createEgressGate(permissions) {
  const perms = permissions && typeof permissions === 'object' ? permissions : {}
  const allows = kind => {
    const entry = Object.hasOwn(EGRESS_KINDS, kind) ? EGRESS_KINDS[kind] : null
    if (!entry) return false
    // A kind may need more than one class (all of them).
    const classes = Array.isArray(entry.data) ? entry.data : [entry.data]
    return classes.length > 0 && classes.every(name => DATA_CLASSES.includes(name) && perms[name] === true)
  }
  const refuse = () => new DecisionError('evidence_unavailable', 'This kind of data is not allowed for models in this run, so it is not sent to the decision model either')
  return Object.freeze({
    allows,
    require(kind) { if (!allows(kind)) throw refuse() },
    /** A client whose decide() refuses before any key lookup or request when a declared kind is not allowed. */
    guardClient(client, kinds) {
      const list = Array.isArray(kinds) ? kinds : [kinds]
      return Object.freeze({ ...(client && typeof client === 'object' ? client : {}),
        async decide(request) { for (const kind of list) if (!allows(kind)) throw refuse(); return client.decide(request) } })
    },
    /** A client whose decide() sends only the fixed content-free request registered under `name` (CONTENT_FREE_REQUESTS); anything else is refused before any key lookup. */
    guardContentFree(client, name) {
      return Object.freeze({ ...(client && typeof client === 'object' ? client : {}),
        async decide(request) { if (!sameContentFree(name, request)) throw refuse(); return client.decide(request) } })
    },
    /** Evidence items for a draft-check catalog: keep an item only when the class its kind belongs to is allowed; opaque references stay. */
    filterEvidence(items) {
      return (Array.isArray(items) ? items : []).filter(item => item?.opaque === true || (Object.hasOwn(EVIDENCE_CLASS, item?.kind) && perms[EVIDENCE_CLASS[item.kind]] === true))
    },
    /** A memory scope that can only narrow: the original rule AND the memory class. */
    memoryScope(scope) {
      return { allows: page => perms.memory === true && (typeof scope?.allows === 'function' ? scope.allows(page) === true : Array.isArray(scope?.allowedScopes) && scope.allowedScopes.includes(page?.scope)) }
    },
  })
}

/** Every file that sends a Decision request and the kinds it may declare. A new call site must be added here (a test scans the code). */
export const EGRESS_SITES = Object.freeze({
  'codex-chat-runtime.mjs': ['previous_reply', 'speech_history', 'topic_history', 'memory_page', 'draft_text', 'run_facts', 'page_text', 'browser_task_record', 'terminal_command'],
  'egdesk-board-presentation-http.mjs': ['canvas_text', 'board_arrangement: explicit owner confirm, coarse descriptors only',
    'briefing_judgments: /decision/briefing-placement (counts only), -reuse and -check (card labels, short summaries, step texts) are each asked of the gate with canvas_text by runBriefingFlow before they are sent',
    'briefing_skeleton: /decision/briefing-skeleton (the request of the run and, in the place request, the run\'s own answer as draft_text, the turn\'s memory materials as memory_page, card labels as canvas_text) asked of the gate by runSkeletonFlow before anything is sent; without draft_text nothing is asked, without memory_page there are no materials, without canvas_text no existing card is listed'],
  'egdesk-board-agent-context.mjs': ['board_excerpt'],
  'egdesk-observe-first.mjs': ['run_text: the person\'s own message (up to 600 characters) and the fixed description of the observe action', 'app_names: the names and bundle ids of the open apps EG-Desk\'s own list_apps returned (denied apps never), asked once to pick the one the person means; never a window title, an element or a picture'],
  'egdesk-decision-first-commands.mjs': ['run_text: the person\'s own message (up to 600 characters) and EG-Desk\'s fixed descriptions of the options built from the folder; never a script body or a command the person typed'],
  'egdesk-chat-choice.mjs': ['dm_chooser: the user\'s own typed question and options, confirmed in the panel'],
  'egdesk-browser-reflex.mjs': ['page_text'],
  'egdesk-browser-task.mjs': ['page_text'],
  'egdesk-browser-field-text.mjs': ['page_text'], // L8 a1: the field-text choice (the spans of the person's message and the goal, the field's label and the host), through the Browser scope's page_text gate, like the loop's own steps
  'egdesk-entry-placeless-measure.mjs': ['page_text'], // L8 c43: measurement only: the entry request (the message, the open card's title, host and first lines) exactly as the product sends it
  'egdesk-browser-open-item-combined.mjs': ['run_text', 'terminal_command', 'browser_task_record', 'page_text'], // L8 c42: measurement only: the resolver's request for a browser task and another open item, as the runtime sends it
  'egdesk-ordinal-step-measure.mjs': ['page_text', 'browser_task_record'], // L8 c44: measurement only: the objective step request (the goal, the person's reply with the asked list, the page's text) exactly as the product sends it
  'egdesk-browser-open-items.mjs': ['browser_task_record', 'page_text'], // L8 c37: the open task's goal and question, and the message, as yes/no predicates
  'egdesk-real-engine-browser-loop-hook.mjs': ['page_text'], // L8 c34: forwards the product's own browser-entry and step requests of a fixture turn (a logging wrapper; it declares nothing of its own)
  'egdesk-context-setup.mjs': ['speech_history', 'topic_history', 'memory_page'],
  'egdesk-conversation-flow.mjs': ['run_facts'],
  // Work placement (L1 cycle 12): where a surface goes is a code rule; only content predicates are asked. "Same matter?" quotes the run's own
  // request (run_text) and a nearby card's label and excerpt, only for cards the host marked maySend (canvas_text); "does the result need the
  // owner?" quotes the run's own request and answer (run_text). Each is asked of the run's gate (chat runtime placementContextFor) before it is sent.
  'egdesk-work-placement.mjs': ['run_text', 'canvas_text'],
  // the real-engine check's collaboration hook records the work-placement runtime's own Decision requests on the way through (a pass-through under that runtime's gate: the kinds are the placement's)
  'egdesk-real-engine-collab-hook.mjs': ['run_text', 'canvas_text'],
  // L1 c20 Desk HUD routing: the typed text (hud_text: refused until a permission covering all models exists) and maySend card labels
  'egdesk-hud-routing.mjs': ['hud_text', 'canvas_text'],
  'egdesk-draft-check.mjs': ['draft_text'],
  // c32: the open-item resolver quotes the person's message and one open item each (a waiting command: terminal_command; a question or a run: run_text); the runtime passes them through the run's gate first.
  'egdesk-open-items.mjs': ['run_text', 'terminal_command'],
  // c18: the idle warm-up sends the one fixed content-free request (CONTENT_FREE_REQUESTS.warmup) through gate.guardContentFree; no data class.
  'egdesk-decision-call-log.mjs': ['pass-through (u4): recordDecisionCalls hands the request it is given to the client it wraps and notes only closed words and numbers about the call (kind, start and end times, input and cached token counts, outcome); it adds no data, reads no text and declares no kind (the callers\' gates do)'],
  'egdesk-upper-bundle.mjs': ['pass-through: modeGatedClient hands the request it is given to the client it wraps, after the person\'s Decision mode and saved key allowed it; it adds no data and declares no kind (the callers\' gates do)'], // u1
  'egdesk-decision-warmup.mjs': ['content-free: the fixed warm-up request only (CONTENT_FREE_REQUESTS.warmup), no data of any class'],
  'egdesk-heartbeat-judge.mjs': ['run_facts', 'run_text', 'terminal_command', 'plus any other kind a heartbeat question or a provider\'s context declares, each checked by the run\'s gate before it is sent'],
  // Plan builder for the real measurement: the product client with a recording fetch that refuses. Nothing is sent from this file.
  'egdesk-heartbeat-real-plan.mjs': ['run_facts: plan builder; a recording fetch that refuses, nothing is sent'],
  'egdesk-command-risk-plan.mjs': ['terminal_command: plan builder; a capturing fetch that answers locally, nothing is sent (controls are built with the gate\'s own request builder)'],
  'egdesk-terminal-command-gate.mjs': ['terminal_command'],
  // c13 prototype: the person's reply to a command the hook denied (their own message, as the run's model receives it) and that command.
  'egdesk-gate-hook-broker.mjs': ['run_text', 'terminal_command'],
  // c21: the auxiliary yes/no predicates of the condition arbiter on the output tail of a command EG-Desk ran for the run's engine.
  'egdesk-own-tools-wiring.mjs': ['command_output'],
  'egdesk-run-conditions-plan.mjs': ['command_output: plan builder; a capturing fetch that answers locally, nothing is sent'],
  'egdesk-terminal-judge.mjs': ['terminal_output', 'command_output'],
  'egdesk-memory-live-runner.mjs': ['memory_page: measurement tool; the public synthetic wiki only, through guardClient'],
  'egdesk-conversation-scenarios.mjs': ['run_text: scenario tool (L3 c21); rebuilds the beat\'s in-run person questions as the wire body through a recording fetch that never sends; the masked conversation examples are owner-approved and guarded by helper/egdesk-scenario-seed-guard.mjs'],
  // Measurement tool: drives the real runtime, whose own gates ask every kind before each request; synthetic pages in a temporary directory only.
  'egdesk-memory-journey.mjs': ['memory_page', 'speech_history: measurement tool over the real runtime and its own gates; public synthetic data only'],
  'egdesk-turn-memory.mjs': ['memory_page', 'topic_history'],
  // The note (a memory page's title and reported status) and the previous reply of this DM (a past utterance): asked of the run's gate by the runtime before the call.
  'egdesk-record-confirmation.mjs': ['memory_page', 'speech_history'],
  // u1 (nunchi): the person's own turn and the assistant message right before it (bounded tail), the latter only where the run's gate allows the conversation's own messages (previous_reply, asked by the runtime through previousReplyFor).
  'egdesk-nunchi.mjs': ['previous_reply'],
  // c38 (write first): the (record, message) pair of the conflict question: one stored record the run's DM may read; asked of the run's gate by the runtime (the turn memory client) before the call.
  'egdesk-record-settled.mjs': ['memory_page'],
  // c41: a measurement tool that BUILDS the memory-first requests from the recorded turns with a capturing client and a scripted walk; nothing is sent from it (the runner sends, after approval).
  'egdesk-c41-replay.mjs': ['memory_page', 'speech_history: measurement tool; public synthetic records and messages only; builds request bodies, sends nothing'],
  'egdesk-wiki-reconstruction.mjs': ['memory_page'],
  // Block previews of an EG-Desk tool result the run's model is about to receive (by output kind), and older session blocks.
  // Called from egdesk-working-memory-wiring.mjs as an advisory judge only; that file sends nothing itself.
  'egdesk-working-memory-gate.mjs': ['terminal_output', 'page_text', 'topic_history'],
})
