#!/usr/bin/env node
// L2 c21: the all-on journey's conversation steps that need no Firefox, as conversation scripts for lane L5's real-engine check
// (scripts/egdesk-real-engine-check.mjs; Main runs it against the official Codex with the person's login and --decisions). This file BUILDS the two
// committed script files from the journey's own synthetic world, so the stored pages and the sentences cannot drift from it:
//   scripts/real-engine/scripts/real-engine-journey-memory-v1.json   one conversation: s1 first turn, s2 follow-up, s3b recall, s9 status remark
//   scripts/real-engine/scripts/real-engine-journey-nudges-v1.json   three conversations, one long command each: s4+s4n status nudge, s4c change nudge, s12 stop
// Usage: node scripts/egdesk-real-engine-journey-scripts.mjs [--write]   (default: compare the committed files with what this builds; exit 1 on a difference)
//
// What carries over from the journey and what cannot (the real engine is the Agent here, so nothing is scripted on that side):
//   pages attached / not attached, no re-sends   -> expect.memory (L7's hook), judged on what the product sent the engine
//   the command is not interrupted by a status nudge, a change is steered, a stop interrupts, nothing is posted for a change, one reply, no
//   repeated wait note, the Agent posts no answer for stopped work   -> expect.engine (this lane's journey hook) and turnStatus
//   posted answers name the right facts   -> answerIncludes / answerExcludes on the last posted message
// What the journey judges that the real-engine check cannot: Decision probabilities per question (the check records them in decisions[], it does not
// judge them: the engine-side effect is the consequence by code: an interrupt only follows a "stop" read of the message), what the person sees on a
// Board, the browser card, work placement, and the wiki writes (s9's pending reading).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SYNTHETIC_PAGES } from '../helper/egdesk-wiki-reconstruction.fixture.mjs'
import { SAYS } from './egdesk-all-on-live-measure.mjs'
import { MEMORY_LINK_TYPES } from '../helper/egdesk-real-engine-memory.mjs'
import { validateEngineScript } from '../helper/egdesk-real-engine-script.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const SCRIPTS_DIR = path.join(here, 'real-engine', 'scripts')
export const MEMORY_SET = 'real-engine-journey-memory-v1', NUDGES_SET = 'real-engine-journey-nudges-v1'

// ---- the journey's synthetic world: the A사 quote pages and the PostgreSQL migration pages (scripts/egdesk-all-on.support.mjs GRAPH) ----
const JOURNEY_PAGES = SYNTHETIC_PAGES.filter(p => /^(quote\/a-|db\/pg-|db\/sqlite)/.test(p.id) && !p.scope)
const STATUS = { done: 'done', plan: 'plan' } // the memory seeding knows these two; "reported by someone else" has no status of its own (the page says so in its words)
/** The pages as the memory seeding takes them (helper/egdesk-real-engine-memory.mjs): the same ids, titles, bodies, times and statuses; links of the kinds it knows. */
export function journeyMemoryPages() {
  const ids = new Set(JOURNEY_PAGES.map(p => p.id))
  return JOURNEY_PAGES.map(p => ({ id: p.id, title: p.title, body: p.body, time: p.time.slice, ...(STATUS[p.status] ? { status: STATUS[p.status] } : {}),
    ...(p.links?.some(l => MEMORY_LINK_TYPES.includes(l.type) && ids.has(l.to)) ? { links: p.links.filter(l => MEMORY_LINK_TYPES.includes(l.type) && ids.has(l.to)).map(l => ({ to: l.to, type: l.type })) } : {}) }))
}
const PAGE_IDS = JOURNEY_PAGES.map(p => p.id)
export const QUOTE_IDS = PAGE_IDS.filter(id => id.startsWith('quote/')), DB_IDS = PAGE_IDS.filter(id => id.startsWith('db/'))

// ---- the journey's flags, as the real-engine check takes them (names and values only; the product defaults stay off) ----
const MEMORY_FLAGS = { EGDESK_DRAFT_CHECK: 'on', EGDESK_CONTEXT_RELEVANCE: 'action', EGDESK_TURN_MEMORY_PRUNE_HELD: 'on', EGDESK_TURN_MEMORY_KEEP_LATE: 'on' }
const NUDGE_FLAGS = { EGDESK_INRUN_MESSAGES: 'on', EGDESK_CONVERSATION_FLOW: 'on', EGDESK_DRAFT_CHECK: 'on', EGDESK_CONTEXT_RELEVANCE: 'action', EGDESK_TURN_MEMORY_PRUNE_HELD: 'on', EGDESK_TURN_MEMORY_KEEP_LATE: 'on' }
const run = command => `다음 명령을 실행하고, 끝나면 결과를 알려 줘: ${command}`

function memoryConversation() {
  return { id: 'journey-memory', flags: MEMORY_FLAGS, memory: { mode: 'on', pages: journeyMemoryPages() }, turns: [
    // s1: the quote question: the request and v1 pages are attached, none of the database pages, the answer names the v1 price
    { say: SAYS.quote, expect: { memory: { attached: ['quote/a-request', 'quote/a-v1'], notAttached: DB_IDS }, posted: true, answerIncludes: ['12,800'], noNativeTools: true, turnStatus: 'completed' } },
    // s2: the follow-up: nothing is sent twice, still no database page, the facts are kept
    { say: SAYS.tidy, expect: { memory: { noResends: true, notAttached: DB_IDS }, posted: true, answerIncludes: ['12,800'], noNativeTools: true, turnStatus: 'completed' } },
    // s3b: a genuine recall: the design page is fetched, no quote page, and the answer is about what was asked (not the other matter)
    { say: SAYS.recall, expect: { memory: { attached: ['db/pg-design'], notAttached: QUOTE_IDS, noResends: true }, posted: true, answerIncludes: ['PostgreSQL'], answerExcludes: ['A사', '12,800'], noNativeTools: true, turnStatus: 'completed' } },
    // s9: a status remark about the migration: its deployment plan is brought (soft in the journey), nothing already delivered is sent again, no quote page
    { say: SAYS.deployed, expect: { memory: { attached: ['db/pg-plan'], notAttached: QUOTE_IDS, noResends: true }, posted: true, noNativeTools: true, turnStatus: 'completed' } },
  ] }
}

const ALL_IDS = PAGE_IDS
const nudge = (id, command, expectFirst, message, afterMs, expectMessage) => ({ id, flags: NUDGE_FLAGS, folder: { 'README.md': 'scratch folder for the real-engine check\n' }, memory: { mode: 'on', pages: journeyMemoryPages() }, turns: [
  // the long command is an action request: no stored page is attached for it (s4.no-page-for-the-action), and the command runs through EG-Desk's own tool
  { say: run(command), expect: { toolCalls: ['egdesk_run_command'], commandsRan: [command], memory: { notAttached: ALL_IDS }, noNativeTools: true, ...expectFirst } },
  { say: message, whileRunning: { afterMs }, expect: expectMessage },
] })
function nudgeConversations() {
  const status = 'sleep 20 && echo tests-passed-40', change = 'sleep 25 && echo build-A-finished', stop = 'sleep 40 && echo never-printed'
  return [
    // s4 + s4n: the person asks why it stopped, 12 s in (after the wait note's 10 s). The command is not interrupted or steered, it finishes and its result is
    // posted; one short reply is posted for the question; the wait note is not repeated (window: at most the wait note and the reply)
    nudge('journey-status', status, { posted: true, answerIncludes: ['tests-passed-40'], turnStatus: 'completed', engine: { steers: 0, interrupts: 0, flowMessages: { min: 1, max: 2 } } },
      SAYS.nudge, 12000, { posted: true, noNativeTools: true, engine: { steers: 0, interrupts: 0, flowMessages: { equals: 1 } } }),
    // s4c: the person changes the task, 12 s in. The message is steered into the working turn with only the person's words; nothing is posted for it; the command
    // is not interrupted
    nudge('journey-change', change, { posted: true, turnStatus: 'completed', engine: { interrupts: 0 } },
      SAYS.change, 12000, { posted: true, noNativeTools: true, engine: { steers: 1, interrupts: 0, steerCarries: true, flowMessages: { max: 0 } } }),
    // s12: the person says stop, 12 s into a 40 s command. The engine gets one interrupt of the working turn and no steer, the turn ends interrupted well before the
    // command would have (30 s), and the Agent posts no answer for the stopped work (only the wait note may be posted)
    nudge('journey-stop', stop, { turnStatus: 'interrupted', engine: { interrupts: 1, steers: 0, agentMessages: { equals: 0 }, flowMessages: { max: 1 }, maxLatencyMs: 30000 } },
      SAYS.stop, 12000, { noNativeTools: true, engine: { interrupts: 1, steers: 0, flowMessages: { max: 0 } } }),
  ]
}

const DESCRIPTIONS = {
  [MEMORY_SET]: 'The all-on journey\'s memory steps (L2 c21) with the journey\'s own synthetic pages seeded: s1 the A사 quote question, s2 the follow-up, s3b the PostgreSQL design recall, s9 the "deployment finished" remark. Needs --decisions with a key (the Decision model picks and reads the pages). Expectations are code checks on what the product sent the engine (memory.attached / notAttached / noResends) and on the posted answer (answerIncludes / answerExcludes). s9\'s attached page is soft in the journey; here every expectation counts.',
  [NUDGES_SET]: 'The all-on journey\'s in-run message steps (L2 c21), one long command per conversation, the journey\'s pages seeded so that no page may be attached for an action request: journey-status (s4 + s4n: "why did it stop" 12 s in; the command is not interrupted, finishes, one short reply), journey-change (s4c: a change is steered into the working turn; needs the steer contract of the binary: on 0.171 the product recognizes it only for 0.162.1, so there the expectation fails with steerContract false in its detail), journey-stop (s12: the stop interrupts the turn once, the turn ends interrupted well before the command would have, the Agent posts no answer). Needs --decisions with a key: EGDESK_INRUN_MESSAGES, EGDESK_CONVERSATION_FLOW and EGDESK_DRAFT_CHECK=on.',
}

/** buildJourneyScripts() → { [set]: script } (validated). */
export function buildJourneyScripts() {
  const scripts = {
    [MEMORY_SET]: { set: MEMORY_SET, description: DESCRIPTIONS[MEMORY_SET], conversations: [memoryConversation()] },
    [NUDGES_SET]: { set: NUDGES_SET, description: DESCRIPTIONS[NUDGES_SET], conversations: nudgeConversations() },
  }
  for (const script of Object.values(scripts)) { const verdict = validateEngineScript(script); if (!verdict.ok) throw new Error(`${script.set}: ${verdict.errors.join('; ')}`) }
  return scripts
}
export const scriptText = script => `${JSON.stringify(script, null, 2)}\n`

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const write = process.argv.includes('--write'), built = buildJourneyScripts()
  let differs = 0
  for (const [set, script] of Object.entries(built)) {
    const file = path.join(SCRIPTS_DIR, `${set}.json`), text = scriptText(script)
    if (write) { fs.writeFileSync(file, text); console.log(`wrote ${file}`); continue }
    const same = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text
    console.log(`${set}: ${same ? 'matches' : 'DIFFERS'}`); if (!same) differs++
  }
  process.exit(differs ? 1 : 0)
}
