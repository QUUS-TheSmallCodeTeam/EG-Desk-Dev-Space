// Analysis only (lane L6 cycle 13). The bar at which the PRODUCT acts on each Decision question family, as a table the evidence tables
// read. Every value comes from the product module that acts on it (imported here, never retyped), so a changed bar changes the table.
// A family is matched by the measurement set it was asked in and its question name with digit runs as "#".
// Predicate rows: the product acts on "yes" at p >= yesAt and on "no" at p <= noAt; a family that acts one way or the other has noAt just
// under yesAt (no undecided zone). Choice rows: the product accepts at confidence >= c and margin >= m (m null: no margin rule).
import { BOARD_AGENT_IN_EFFECT_BAR, BOARD_AGENT_RELEVANCE_BAR } from './egdesk-board-agent-context.mjs'
import { SKELETON_BARS } from './egdesk-briefing-skeleton.mjs'
import { DEFAULT_DECISION_THRESHOLDS as T } from './egdesk-decision-questions.mjs'
import { DRAFT_CHECK_THRESHOLDS } from './egdesk-draft-check.mjs'
import { BEAT_PREDICATE_YES } from './egdesk-heartbeat-judge.mjs'
import { CONFIRM_BARS } from './egdesk-record-confirmation.mjs'
import { SPEECH_PREDICATE_BARS, SPEECH_SPLIT_BARS, SPEECH_THRESHOLDS } from './egdesk-speech-grounding.mjs'
import { RISK_PREDICATE_NO } from './egdesk-terminal-command-gate.mjs'
import { NO as TERNARY_NO, YES as TERNARY_YES } from './egdesk-wiki-reconstruction.mjs'
import { PLACEMENT_PREDICATE_YES } from './egdesk-work-placement.mjs'

const EPS = 1e-6
const single = (bar, src) => ({ yesAt: bar, noAt: bar - EPS, src }) // acts on yes at >= bar, on no below it
const onlyNo = (bar, src) => ({ yesAt: bar + EPS, noAt: bar, src }) // acts on no at <= bar, on yes above it
const three = (yes, no, src) => ({ yesAt: yes, noAt: no, src })
const choice = (c, m, src, extra = {}) => ({ c, m, src, ...extra })
const WM_SPILL_BAR = 0.2 // egdesk-working-memory-gate.mjs predicateAction / gateToolOutput: a block is spilled at p <= .2 (not exported)

export const PRODUCT_BARS = Object.freeze([
  [/^board-reply-screening-v\d+$|^contamination-v1$/, /^c#$/, single(BOARD_AGENT_RELEVANCE_BAR, 'egdesk-board-agent-context.mjs BOARD_AGENT_RELEVANCE_BAR: an excerpt is selected iff p >= bar')],
  [/^board-reply-screening-v\d+$|^l1-remeasure-c13$/, /^c#_now$/, single(BOARD_AGENT_IN_EFFECT_BAR, 'egdesk-board-agent-context.mjs BOARD_AGENT_IN_EFFECT_BAR: in effect iff p >= bar')],
  [/^l4-briefing-skeleton$/, /^mismatch_P#$/, single(SKELETON_BARS.yes, 'c14 design (retired): SKELETON_BARS.mismatch was .7, the same value as today\'s yes bar')],
  [/^l4-briefing|^l2-all-on-s3/, /^(covers|onboard_F#)$/, onlyNo(SKELETON_BARS.no, 'egdesk-briefing-skeleton.mjs coverage: only isNo (<= no) reworks the board or marks a fact missing')],
  [/^l4-briefing|^l2-all-on-s3/, /^(one_sentence|before_P#_P#)$/, onlyNo(SKELETON_BARS.no, 'egdesk-briefing-skeleton.mjs decidePlace / orderItems: isNo (<= no) is the only "no"')],
  [/^l4-briefing|^l2-all-on-s3|^contamination-v1$/, /.*/, single(SKELETON_BARS.yes, 'egdesk-briefing-skeleton.mjs isYes (>= yes); anything else is the other branch (fill check: "anything in between is not support")')],
  [/^heartbeat-c1[5-9]$/, /^message__/, single(BEAT_PREDICATE_YES, 'egdesk-heartbeat-judge.mjs BEAT_PREDICATE_YES: speaks iff p >= bar')],
  [/^heartbeat-c1[7-9]$|^draft-overcorrection-v\d+$/, /^sup_#$/, onlyNo(1 - DRAFT_CHECK_THRESHOLDS.finding, 'egdesk-draft-check.mjs: unsupported (a finding) iff p <= 1 - finding')],
  [/^heartbeat-c1[7-9]$|^draft-overcorrection-v\d+$/, /^(tense_#|present_#)$/, single(DRAFT_CHECK_THRESHOLDS.finding, 'egdesk-draft-check.mjs: a finding iff p >= finding')],
  [/^heartbeat-c1[7-9]$/, /^claim_#$/, choice(T.choice, T.margin, 'egdesk-draft-check.mjs readChoice thresholds.choice / margin')],
  [/^command-risk-v2$/, /^risk_/, onlyNo(RISK_PREDICATE_NO, 'egdesk-terminal-command-gate.mjs RISK_PREDICATE_NO: no approval iff p <= bar; otherwise approval')],
  [/^command-judgments-v1$/, /^log_b#$/, single(T.relevant, 'egdesk-terminal-judge.mjs readPredicate(th.relevant): attached iff p >= relevant')],
  [/^command-judgments-v1$/, /^terminal_state$/, choice(T.choice, T.margin, 'egdesk-terminal-judge.mjs readChoice th.choice / th.margin')],
  [/^browser-task-v1$/, /^goal_met$/, single(T.done, 'egdesk-browser-reflex.mjs readPredicate(thresholds.done)')],
  [/^browser-task-v1$/, /^page_state$/, choice(T.pageState, null, 'egdesk-browser-reflex.mjs readChoice(thresholds.pageState), no margin rule')],
  [/^browser-task-v1$/, /^(browser_entry|next_step|task_resume)$/, choice(T.choice, T.margin, 'egdesk-browser-task.mjs / egdesk-browser-reflex.mjs thresholds.choice / margin')],
  [/^work-placement-predicates-v\d+$|^l1-remeasure-c13$|^contamination-v1$/, /^(same_matter_R#|owner_action)$/, single(PLACEMENT_PREDICATE_YES, 'egdesk-work-placement.mjs PLACEMENT_PREDICATE_YES: yes iff p >= bar')],
  [/^record-confirmation-predicates-v1$/, /.*/, three(CONFIRM_BARS.yes, CONFIRM_BARS.no, 'egdesk-record-confirmation.mjs CONFIRM_BARS (between: keep pending)')],
  [/^working-memory-judge-v1$/, /.*/, onlyNo(WM_SPILL_BAR, 'egdesk-working-memory-gate.mjs predicateAction: spilled iff p <= .2; kept otherwise')],
  [/^write-target-about-v1$|^mid-scan-previous-reply-v1$/, /^(tw_about_#|tn_record|tn_courtesy|pg_#)$/, three(TERNARY_YES, TERNARY_NO, 'egdesk-wiki-reconstruction.mjs ternary YES / NO (between: undecided / a second look)')],
  [/^write-target-about-v1$|^utterance-threshold-v1\//, /^speech_/, choice(SPEECH_THRESHOLDS.confidence, SPEECH_THRESHOLDS.margin, 'egdesk-speech-grounding.mjs SPEECH_THRESHOLDS; pick() never installs unknown', { neverAccepts: ['unknown'] })],
  [/^write-target-about-v1$|^utterance-threshold-v1\//, /^tw_status$/, choice(T.choice, T.margin, 'egdesk-turn-memory.mjs judgeWriteAbout readChoice .75 / .2')],
  [/^(heartbeat-c14|l4-work-placement)$/, /.*/, choice(T.choice, T.margin, 'retired c14 designs: DEFAULT_DECISION_THRESHOLDS choice / margin (assumed)')],
  [/^l4-briefing-skeleton$/, /^(place|part_P#|next)$/, choice(T.choice, T.margin, 'retired c14 skeleton: choice .75 / margin .2')],
  [/^action-relevance-v\d+$/, /^rel_#$/, single(T.relevant, 'egdesk-context-setup.mjs (via egdesk-decision-questions.mjs relevant): a candidate is attached iff p >= relevant (L7 c20 action wording)')],
  [/^split-wording-v\d+$/, /^speechs_/, three(SPEECH_SPLIT_BARS.yes, SPEECH_SPLIT_BARS.no, 'egdesk-speech-grounding.mjs SPEECH_SPLIT_BARS (split wording v2, the two-step hybrid second request, L7 c22)')],
  [/^memory-action-v2$/, /^(tn_need|tn_action)$/, three(TERNARY_YES, TERNARY_NO, 'egdesk-turn-memory.mjs prepareTurnMemory: a decided tn_action yes fetches no stored page; a decided need no may skip (ternary YES / NO, L7 c22)')],
  [/^axis-hybrid-v\d+$/, /^speechs_/, three(SPEECH_SPLIT_BARS.yes, SPEECH_SPLIT_BARS.no, 'egdesk-speech-grounding.mjs SPEECH_SPLIT_BARS (hybrid-isolated: read only where the axes question does not install, L7 c21)')],
  [/^axis-hybrid-v\d+$/, /^speech_/, choice(SPEECH_THRESHOLDS.confidence, SPEECH_THRESHOLDS.margin, 'egdesk-speech-grounding.mjs SPEECH_THRESHOLDS (hybrid-isolated axes question); pick() never installs unknown', { neverAccepts: ['unknown'] })],
  [/^memory-action-v\d+$/, /^(tn_need|pg_#)$/, three(TERNARY_YES, TERNARY_NO, 'egdesk-wiki-reconstruction.mjs ternary YES / NO: triageSkipsFetch acts on a decided need no; the scan picks a decided yes (L7 c21 action rules)')],
  [/^axis-split-v\d+/, /^speechs_/, three(SPEECH_SPLIT_BARS.yes, SPEECH_SPLIT_BARS.no, 'egdesk-speech-grounding.mjs SPEECH_SPLIT_BARS (split-isolated design, L7 c20): yes >= yes, no <= no, between undecided')],
  // legacy (c8-era, 11/22-11/24) families
  [/-11(22|23|24)$/, /^speechp_/, three(SPEECH_PREDICATE_BARS.yes, SPEECH_PREDICATE_BARS.no, 'egdesk-speech-grounding.mjs SPEECH_PREDICATE_BARS')],
  [/-11(22|23|24)$/, /^(tn_|tw_link|tw_about|pg_|op_)/, three(TERNARY_YES, TERNARY_NO, 'egdesk-wiki-reconstruction.mjs ternary YES / NO')],
  [/-11(22|23|24)$/, /^rel_#$/, single(T.relevant, 'egdesk-decision-questions.mjs relevant: attached iff p >= relevant')],
  [/-11(22|23|24)$/, /^speech_/, choice(SPEECH_THRESHOLDS.confidence, SPEECH_THRESHOLDS.margin, 'egdesk-speech-grounding.mjs SPEECH_THRESHOLDS; pick() never installs unknown', { neverAccepts: ['unknown'] })],
  [/-11(22|23|24)$/, /.*/, choice(T.choice, T.margin, 'DEFAULT_DECISION_THRESHOLDS choice / margin')],
].map(([set, family, bar]) => Object.freeze({ set, family, bar: Object.freeze(bar) })))

export const FALLBACK_BARS = Object.freeze({ predicate: three(TERNARY_YES, TERNARY_NO, 'FALLBACK: the general predicate guide (no product bar found for this family)'), choice: choice(T.choice, T.margin, 'FALLBACK: DEFAULT_DECISION_THRESHOLDS') })
export const familyName = name => String(name).replace(/\d+/g, '#')

/** barFor({ set, q, kind }) -> { yesAt, noAt, src } | { c, m, src } | null; with fallback: true when no family row matched. */
export function barFor({ set, q, kind }, { fallback = true } = {}) {
  const fam = familyName(q)
  const row = PRODUCT_BARS.find(r => r.set.test(String(set)) && r.family.test(fam) && (kind === 'predicate' ? r.bar.yesAt !== undefined : kind === 'choice' ? r.bar.c !== undefined : false))
  if (row) return row.bar
  return fallback && (kind === 'predicate' || kind === 'choice') ? { ...FALLBACK_BARS[kind], fallback: true } : null
}

/** Whether a HARD check holds at the product bar. A wrong-install check (whenAccepted) holds unless the product installs a wrong value. */
export function productHolds(row) {
  const v = productVerdict(row)
  return row.whenAccepted ? v !== 'decided-wrong' && v !== 'not-answered' : v === 'decided-correct'
}

/** productVerdict(row) -> 'decided-correct' | 'decided-wrong' | 'undecided' | 'not-answered' | row.verdict (score and band rows keep theirs). */
export function productVerdict(row) {
  if (row.verdict === 'not-answered' || row.kind === 'score') return row.verdict
  const b = barFor(row)
  if (!b) return row.verdict
  if (row.kind === 'predicate') {
    if (row.expect !== 'yes' && row.expect !== 'no') return row.verdict
    if (!Number.isFinite(row.p)) return 'not-answered'
    const yes = row.p >= b.yesAt, no = row.p <= b.noAt
    if (!yes && !no) return 'undecided'
    return (row.expect === 'yes') === yes ? 'decided-correct' : 'decided-wrong'
  }
  const accepted = Number.isFinite(row.confidence) && row.confidence >= b.c && (b.m === null || (Number.isFinite(row.margin) && row.margin >= b.m - 1e-9)) && !(b.neverAccepts || []).includes(row.choice)
  return !accepted ? 'undecided' : (row.expected || []).includes(row.choice) ? 'decided-correct' : 'decided-wrong'
}
