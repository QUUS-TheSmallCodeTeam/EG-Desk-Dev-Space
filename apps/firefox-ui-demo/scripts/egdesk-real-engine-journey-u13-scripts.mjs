#!/usr/bin/env node
// L2 c32: journey v10 for the real-engine check = the layer-first (U13, "끼릭끼릭 탁탁") flags that are MERGED, each as an -off / -on pair of conversations so that the timing measure compares them:
//   node scripts/egdesk-real-engine-timing.mjs compare <off records> <on records> --normalize '-off|-on'
// Builds scripts/real-engine/scripts/real-engine-journey-u13-v10.json from the committed scripts of the lanes that own the flags (their scenarios, folders and expectations are reused as they are;
// only the conversation ids and the timing expectations are this file's):
//   prefetch-notes-{off,on}, prefetch-code-{off,on}   L7  EGDESK_TURN_MEMORY_PREFETCH=files    a question about ONE named file: with the flag the file text is already in the engine's turn context (no tool round)
//   tests-{off,on}                                     L3/L5 EGDESK_DECISION_FIRST=on           "테스트 돌려줘": since L3's action-first change the decision model picks the command, EG-Desk runs it, and the engine is asked ONCE with the result (no tool round)
//   tests-card-{off,on}                                L3/L5 EGDESK_DECISION_FIRST=card         the same request on the card-only path: a healthy run ends locally, no engine turn (the -off side is the same engine-path conversation again so that --pairs pairs it)
// Timing expectations (expect.timing, helper/egdesk-real-engine-timing-expect.mjs) are bounds from measured numbers, and say which:
//   layersMaxMs 3,000 on every turn that starts the engine (not tests-on and tests-card-on: there the layers include the command's run, or are the whole turn): the memory and action layers (Decision calls before the engine is asked) took 0.7-2.3 s in the 18 real journey steps of v9 and V1 (c41, c47), maximum 2.3 s, +30%;
//   prefetch -on: at most 1 engine round (the file is in the context, so the engine answers in one round; the -off conversations show how many rounds the same question takes);
//   tests -on (action-first): the engine is asked once and calls no tool: at most 1 engine round; no layers bound (the layers then include the command's own run);
//   tests-card -on: the engine is not started (a healthy run ends locally) and the whole turn is within 8,000 ms [estimate: one choice question about 0.5 s, the runner, the arbiter's read; the first
//   real run replaces it with a measured number].
// PLACEHOLDERS (not in the script until their flags merge; each says what to add): approvals fast (L3 c32, EGDESK_DECISION_FIRST_APPROVALS=on: pair real-engine-approval-words-v1 / approvals-fast-v1),
// L1's open items, L7's memory-first flags. Needs --decisions; a script holds at most 8 conversations and this one has them all: the placeholders go into a second set (real-engine-journey-u13-v11) when their flags merge.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PREFETCH_SCENARIOS, buildPrefetchScript } from '../helper/egdesk-prefetch-real-engine-scripts.mjs'
import { validateEngineScript } from '../helper/egdesk-real-engine-script.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const SCRIPTS_DIR = path.join(here, 'real-engine', 'scripts')
export const U13_SET = 'real-engine-journey-u13-v10'
export const LAYERS_BOUND_MS = 3000, TESTS_ON_TURN_MS = 8000
export const PLACEHOLDERS = Object.freeze([
  { flag: 'EGDESK_DECISION_FIRST_APPROVALS', owner: 'L3', source: 'lane/c32-approvals-fast (not merged)', add: 'a pair from real-engine-approval-words-v1 (off) and real-engine-approvals-fast-v1 (on): ids approval-off / approval-on' },
  { flag: 'L1 open items', owner: 'L1', source: 'not merged', add: 'its pair, ids open-off / open-on' },
  { flag: 'L7 memory-first flags', owner: 'L7', source: 'not merged', add: 'journey-memory-v2 as memory-off and memory-on with the flag, the same four turns' },
])

// layers: false for a conversation whose turn ends without the engine (its "layers" are then the whole turn, bounded by answerMaxMs instead)
const withTiming = (conv, extra, { layers = true } = {}) => ({ ...conv, turns: conv.turns.map(t => ({ ...t, expect: { ...t.expect, timing: { ...(layers ? { layersMaxMs: LAYERS_BOUND_MS } : {}), ...extra } } })) })
const loadSet = name => JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, `${name}.json`), 'utf8'))

export function buildU13Script() {
  const prefetch = buildPrefetchScript().conversations
  const pick = id => { const c = prefetch.find(x => x.id === id); if (!c) throw new Error(`prefetch conversation ${id} is gone`); return c }
  const df = loadSet('real-engine-decision-first-v1').conversations, dfOff = df.find(c => c.id === 'engine-path'), dfOn = df.find(c => c.id === 'action-first'), dfCard = df.find(c => c.id === 'card-only')
  if (!dfOff || !dfOn || !dfCard) throw new Error('the decision-first script changed: engine-path / action-first / card-only are gone')
  const conversations = [
    withTiming({ ...pick('notes-off'), id: 'prefetch-notes-off' }, {}), withTiming({ ...pick('notes-on'), id: 'prefetch-notes-on' }, { maxEngineRounds: 1 }),
    withTiming({ ...pick('code-off'), id: 'prefetch-code-off' }, {}), withTiming({ ...pick('code-on'), id: 'prefetch-code-on' }, { maxEngineRounds: 1 }),
    withTiming({ ...dfOff, id: 'tests-off' }, {}), withTiming({ ...dfOn, id: 'tests-on' }, { engineStarted: true, maxEngineRounds: 1 }, { layers: false }),
    withTiming({ ...dfOff, id: 'tests-card-off' }, {}), withTiming({ ...dfCard, id: 'tests-card-on' }, { engineStarted: false, answerMaxMs: TESTS_ON_TURN_MS }, { layers: false }),
  ]
  const script = { set: U13_SET, description: DESCRIPTION, conversations }
  const verdict = validateEngineScript(script)
  if (!verdict.ok) throw new Error(`${U13_SET}: ${verdict.errors.join('; ')}`)
  return script
}
const DESCRIPTION = 'Journey v10 for the real-engine check (L2 c32): the merged layer-first (U13) flags as -off / -on pairs for the timing measure (scripts/egdesk-real-engine-timing.mjs compare <off> <on> --normalize "-off|-on"). prefetch-notes and prefetch-code (L7, EGDESK_TURN_MEMORY_PREFETCH=files: the named file is in the engine\'s turn context, no tool round) and tests (L3/L5, EGDESK_DECISION_FIRST=on: the decision model picks the command, EG-Desk runs it, the engine is asked once with the result; tests-card: EGDESK_DECISION_FIRST=card, a healthy run ends without an engine turn). The lanes\' own scenarios and expectations are kept; added: expect.timing bounds from measured numbers (layers before the engine starts at most 3,000 ms; prefetch-on at most one engine round; tests-on (action-first) the engine asked once, at most one round; tests-card-on no engine turn and the whole turn within 8,000 ms, an estimate until the first real run). Not in yet (flags not merged): approvals fast (L3), L1 open items, L7 memory-first. Needs --decisions.'
export const scriptText = script => `${JSON.stringify(script, null, 2)}\n`

export { PREFETCH_SCENARIOS }
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const write = process.argv.includes('--write'), script = buildU13Script(), file = path.join(SCRIPTS_DIR, `${U13_SET}.json`), text = scriptText(script)
  if (write) { fs.writeFileSync(file, text); console.log(`wrote ${file} (${script.conversations.length} conversations)`); process.exit(0) }
  const same = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text
  console.log(`${U13_SET}: ${same ? 'matches' : 'DIFFERS'}`); process.exit(same ? 0 : 1)
}
