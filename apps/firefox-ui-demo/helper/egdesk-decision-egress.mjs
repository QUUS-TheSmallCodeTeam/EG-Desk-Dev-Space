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
  placement_facts: Object.freeze({ data: 'run', governedBy: 'Where a live run\'s work surface could go, as closed words only (option kinds, distance and direction classes, whose view, member aliases, task state); never card titles, text, ids or coordinates' }),
  run_facts: Object.freeze({ data: 'run', governedBy: 'This run\'s own state as numbers and closed labels only (heartbeat elapsed times, the current phase, step counts, whether the Agent asked a question); never text of the run, the person or a model' }),
  draft_text: Object.freeze({ data: 'run', governedBy: 'The run\'s own evidence: catalog items only by the kinds the model itself received; tool outputs stay content-free references' }),
  memory_page: Object.freeze({ data: 'memory', governedBy: 'Memory scope of this DM/Agent (allowsPage: the page\'s own guard plus the scope the answering model may read)' }),
  speech_history: Object.freeze({ data: 'speech', governedBy: 'Per-DM speech reuse consent (the same consent that lets the answering model see past utterances)' }),
  topic_history: Object.freeze({ data: 'topic', governedBy: 'Per-DM topic memory consent (the same consent that lets the answering model see past turns)' }),
  board_excerpt: Object.freeze({ data: 'board', governedBy: 'This Board ask itself: the owner chose and confirmed a run that sends the approved public excerpts to the drafting model. An extract-only ask sends them to no model, so not to Decisions either' }),
})
const DATA_CLASSES = Object.freeze(['terminal', 'browser', 'canvas', 'run', 'memory', 'speech', 'topic', 'board'])
// Evidence kinds a draft-check catalog may carry, and the data class that already lets a model see them.
// Items of the decision context packet were already admitted for this run's answering model, so they count as the run's own data.
const EVIDENCE_CLASS = Object.freeze({ source: 'run', document: 'run', conversation: 'run', timeline: 'run', board: 'run', memory: 'memory', terminal: 'terminal', browser: 'browser' })

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
 */
export function modelDataPermissions({ toolCeiling = null, browserGranted = false, canvasMaySend = false, memoryScope = null, speechConsent = false, topicConsent = false, runActive = false, boardExcerptsToModel = false } = {}) {
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
  'codex-chat-runtime.mjs': ['speech_history', 'topic_history', 'memory_page', 'draft_text', 'run_facts', 'page_text', 'browser_task_record', 'terminal_command'],
  'egdesk-board-presentation-http.mjs': ['canvas_text', 'board_arrangement: explicit owner confirm, coarse descriptors only',
    'briefing_judgments: /decision/briefing-placement (counts only), -reuse and -check (card labels, short summaries, step texts) are each asked of the gate with canvas_text by runBriefingFlow before they are sent',
    'briefing_skeleton: /decision/briefing-skeleton (the request of the run as draft_text, the turn\'s memory materials as memory_page, card labels as canvas_text) asked of the gate by runSkeletonFlow before anything is sent; without draft_text nothing is asked, without memory_page there are no materials, without canvas_text no existing card is listed'],
  'egdesk-board-agent-context.mjs': ['board_excerpt'],
  'egdesk-chat-choice.mjs': ['dm_chooser: the user\'s own typed question and options, confirmed in the panel'],
  'egdesk-browser-reflex.mjs': ['page_text'],
  'egdesk-browser-task.mjs': ['page_text'],
  'egdesk-context-setup.mjs': ['speech_history', 'topic_history', 'memory_page'],
  'egdesk-conversation-flow.mjs': ['run_facts'],
  'egdesk-work-placement.mjs': ['placement_facts'],
  'egdesk-draft-check.mjs': ['draft_text'],
  'egdesk-heartbeat-judge.mjs': ['run_facts', 'plus the kinds a heartbeat question declares, each checked by the run\'s gate before it is sent'],
  'egdesk-terminal-command-gate.mjs': ['terminal_command'],
  'egdesk-terminal-judge.mjs': ['terminal_output', 'command_output'],
  'egdesk-memory-live-runner.mjs': ['memory_page: measurement tool; the public synthetic wiki only, through guardClient'],
  'egdesk-turn-memory.mjs': ['memory_page', 'topic_history'],
  'egdesk-wiki-reconstruction.mjs': ['memory_page'],
  // Prototype, not wired into the runtime: block previews of a tool output the run's model is about to receive (by output kind), and older session blocks.
  'egdesk-working-memory-gate.mjs': ['terminal_output', 'page_text', 'topic_history'],
})
