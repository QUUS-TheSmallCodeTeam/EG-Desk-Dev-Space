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
// c27: v2 of both (v1 stays as committed): what changed in the product since c21 is in the comments above each v2 builder and in reports/l2-c27.md
export const MEMORY_SET_V2 = 'real-engine-journey-memory-v2', NUDGES_SET_V2 = 'real-engine-journey-nudges-v2'
// c28: nudges-v3 = v2 with two expectations corrected after the real run check-20nj (v2 stays as it was run; reports/l2-c28.md has the records)
export const NUDGES_SET_V3 = 'real-engine-journey-nudges-v3'

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
    // s9: a status remark about the migration: nothing already delivered is sent again and no quote page is. The journey's soft "the deployment plan is brought"
    // is not expressed: it accepts a page held since s3b (packetOrHeld), and the memory expectation names only pages with a body in THIS turn
    { say: SAYS.deployed, expect: { memory: { notAttached: QUOTE_IDS, noResends: true }, posted: true, noNativeTools: true, turnStatus: 'completed' } },
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
    // command would have (30 s), the command PROCESS is stopped by EG-Desk (commandStopped: it ended by a signal; the turn ending is the engine's doing), and the
    // Agent posts no answer for the stopped work (only the wait note may be posted)
    nudge('journey-stop', stop, { turnStatus: 'interrupted', engine: { interrupts: 1, steers: 0, agentMessages: { equals: 0 }, flowMessages: { max: 1 }, commandStopped: true, maxLatencyMs: 30000 } },
      SAYS.stop, 12000, { noNativeTools: true, engine: { interrupts: 1, steers: 0, flowMessages: { max: 0 } } }),
  ]
}

// ---- v2 (c27): the same journey steps with what the product gained since c21 ----
// memory-v2: the conversation is an Agent-profile DIRECT room with the draft check ON (the room the product's check judges: in v1 the check never ran, draftCheck.rows was empty), so the
//   four answers are read by the real check and the posting outcome (as_written / revised / certain_part / withheld) is in each turn's record (expect.rewrite, c23 label + c26 hook);
//   the person must get an answer each time (answered), and no number outside the records reaches the person. L7's candidate defaults are ON as the owner will see them: one packet
//   (no page body twice: noDuplicates), selection held, and the split engine context (maxKeyBytes 4000, c31/c33). Needs --decisions and --persisted-with-cleanup (a direct room is not one-time).
const MEMORY_FLAGS_V2 = { EGDESK_CONTEXT_RELEVANCE: 'action', EGDESK_TURN_MEMORY_PRUNE_HELD: 'on', EGDESK_TURN_MEMORY_KEEP_LATE: 'on', EGDESK_TURN_MEMORY_ONE_PACKET: 'on', EGDESK_TURN_MEMORY_SELECTION_HELD: 'on',
  EGDESK_TURN_MEMORY_ENGINE_CONTEXT: 'split', EGDESK_TURN_MEMORY_ENGINE_BYTES: '4000' }
const JOURNEY_AGENT = { name: '견적 담당', role: '견적과 전환 작업 확인', tone: 'concise', expertise: ['견적', '데이터베이스'],
  instructions: '사람이 묻는 내용을 기록에 근거해 한국어로 짧게 답한다. 이미 끝난 단계와 앞으로 할 단계를 구분해서 말하고, 기록에 없는 것은 말하지 않는다.' }
const answered = { rewrite: { answered: true, neverShown: { numbers: true } } }
function memoryConversationV2() {
  const base = memoryConversation().turns, keep = { noDuplicates: true, maxKeyBytes: 4000 }
  return { id: 'journey-memory', agentProfile: structuredClone(JOURNEY_AGENT), draftCheck: { mode: 'on' }, flags: MEMORY_FLAGS_V2, memory: { mode: 'on', pages: journeyMemoryPages() },
    turns: base.map(t => ({ say: t.say, expect: { ...t.expect, memory: { ...t.expect.memory, ...keep }, ...answered } })) }
}

// nudges-v2: the same three conversations after L5 c25-c27 and L3 c26. The binary's steer contract is recognised on 0.171 now (the change IS steered on the real install: a record whose
// engine.nativeContract.steerContract is false would make journey-change fail on its steer count, and says why); EG-Desk stops the command itself and gives the next turn the stopped-command
// fact (cancelRun, stopSettled): journey-stop gets a third turn asking what happened to the command, which must not claim its output or say it cannot tell; the status nudge must
// post BOTH the reply and the final answer (postedMin 2, as L3 c26 made why-stopped require: a final answer alone no longer passes). A message typed into the run is not an answer to be
// read by the draft check; the flags are as in v1.
const STOPPED_ASK = '방금 그 명령은 끝까지 실행된 거야, 아니면 중간에 멈춘 거야?'
function nudgeConversationsV2() {
  const [status, change, stop] = nudgeConversations()
  status.turns[1].expect = { ...status.turns[1].expect, postedMin: 2 }
  stop.turns.push({ say: STOPPED_ASK, expect: { posted: true, answerExcludes: ['never-printed', '확인할 수 없', '확인되지 않', '알 수 없'], noNativeTools: true, turnStatus: 'completed' } })
  return [status, change, stop]
}

// nudges-v3 (c28), the two wrong expectations of v2 found by the real run (check-20nj, official 0.171):
//   journey-change: v2 said the engine ran exactly the one command ("commandsRan"). The steer WORKED (steers 1, carrying the person's words, steerContract true on the install) and the real model
//     acted on it: it ran a second command for B ("sleep 25 && echo build-B-finished") and answered about both. What the step guards is that the first command is not interrupted and the
//     steer reaches the model: commandsRanIncludes the first command, engine.interrupts 0, engine.steers 1 (unchanged). Which commands the model then chooses to run is the model's.
//   journey-stop: v3's third turn excluded the word "never-printed". That word is in the COMMAND LINE ("echo never-printed"), so a true answer that quotes the command ("echo never-printed까지 도달하지
//     않아 출력은 없었습니다") failed it. The command now prints a value that its text does not contain ($((3*3*3*3*3*3*3)) = 2187), and the answer must not contain that value (nor say it cannot tell).
const STOP_VALUE = '2187', STOP_COMMAND = 'sleep 40 && echo $((3*3*3*3*3*3*3))'
function nudgeConversationsV3() {
  const [status, change, stop] = nudgeConversationsV2()
  change.turns[0].expect = Object.fromEntries(Object.entries(change.turns[0].expect).map(([k, v]) => (k === 'commandsRan' ? ['commandsRanIncludes', v] : [k, v])))
  const swap = text => (typeof text === 'string' ? text.replace('sleep 40 && echo never-printed', STOP_COMMAND) : text)
  stop.turns[0].say = swap(stop.turns[0].say); stop.turns[0].expect.commandsRan = [STOP_COMMAND]
  stop.turns[2].expect.answerExcludes = [STOP_VALUE, ...stop.turns[2].expect.answerExcludes.filter(w => w !== 'never-printed')]
  return [status, change, stop]
}

const DESCRIPTIONS = {
  [MEMORY_SET]: 'The all-on journey\'s memory steps (L2 c21) with the journey\'s own synthetic pages seeded: s1 the A사 quote question, s2 the follow-up, s3b the PostgreSQL design recall, s9 the "deployment finished" remark. Needs --decisions with a key (the Decision model picks and reads the pages). Expectations are code checks on what the product sent the engine (memory.attached / notAttached / noResends) and on the posted answer (answerIncludes / answerExcludes). s9 asks only that nothing is sent twice and no quote page comes (the journey\'s soft "the plan is brought" accepts a page already held, which expect.memory cannot say).',
  [MEMORY_SET_V2]: 'The all-on journey\'s memory steps, v2 (L2 c27): the same four steps and seeded pages as v1, now in an Agent-profile direct room with the draft check ON (so the real check reads the four answers and the posting outcome is recorded), with L7\'s candidate defaults on (one packet, selection held, split engine context): no page body twice, no key over 4,000 bytes, an answer posted each time, no number outside the records. Needs --decisions and --persisted-with-cleanup.',
  [NUDGES_SET_V2]: 'The all-on journey\'s in-run message steps, v2 (L2 c27): the three conversations of v1 after the steer contract became recognised on 0.171 and the product learned to stop the command itself: the status nudge must post both the reply and the final answer; the stop is followed by a third turn that asks what happened to the command (it must not claim the output, nor say it cannot tell). One long command per conversation as in v1. Needs --decisions.',
  [NUDGES_SET_V3]: 'The all-on journey\'s in-run message steps, v3 (L2 c28): v2 with the two expectations the real run (check-20nj, 0.171) showed to be wrong corrected: journey-change asserts that the first command ran (commandsRanIncludes), not that it was the only one (the model followed the steer and ran a second command for B); journey-stop\'s command prints a value its text does not contain (2187) and the third answer must not contain it (the old word was in the command line, which a true answer may quote). Needs --decisions.',
  [NUDGES_SET]: 'The all-on journey\'s in-run message steps (L2 c21), one long command per conversation, the journey\'s pages seeded so that no page may be attached for an action request: journey-status (s4 + s4n: "why did it stop" 12 s in; the command is not interrupted, finishes, one short reply), journey-change (s4c: a change is steered into the working turn; needs the steer contract of the binary: on 0.171 the product recognizes it only for 0.162.1, so there the expectation fails with steerContract false in its detail), journey-stop (s12: the stop interrupts the turn once, the turn ends interrupted well before the command would have, EG-Desk stops the command process itself (commandStopped: today the own-tools executor passes the command runner no abort signal and has no cancelRun, so the expectation fails on a real engine until it does), the Agent posts no answer). Needs --decisions with a key: EGDESK_INRUN_MESSAGES, EGDESK_CONVERSATION_FLOW and EGDESK_DRAFT_CHECK=on.',
}

/** buildJourneyScripts() → { [set]: script } (validated). */
export function buildJourneyScripts() {
  const scripts = {
    [MEMORY_SET]: { set: MEMORY_SET, description: DESCRIPTIONS[MEMORY_SET], conversations: [memoryConversation()] },
    [NUDGES_SET]: { set: NUDGES_SET, description: DESCRIPTIONS[NUDGES_SET], conversations: nudgeConversations() },
    [MEMORY_SET_V2]: { set: MEMORY_SET_V2, description: DESCRIPTIONS[MEMORY_SET_V2], conversations: [memoryConversationV2()] },
    [NUDGES_SET_V2]: { set: NUDGES_SET_V2, description: DESCRIPTIONS[NUDGES_SET_V2], conversations: nudgeConversationsV2() },
    [NUDGES_SET_V3]: { set: NUDGES_SET_V3, description: DESCRIPTIONS[NUDGES_SET_V3], conversations: nudgeConversationsV3() },
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
