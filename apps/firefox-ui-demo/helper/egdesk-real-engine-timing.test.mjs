// L2 c31: the shared U13 timing measure: the pure readers on synthetic records, the compare, the CLI, and the check's new timing fields on the fake app-server.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareRuns, enginePhases, formatCompare, formatSummary, formatTable, recordTimings, summarize, turnTiming, unionMs } from './egdesk-real-engine-timing.mjs'
import { main } from '../scripts/egdesk-real-engine-timing.mjs'
import { MEMORY_FAKE, commandFake, fastScript, journeyWorld, runJourneyConversation } from '../scripts/egdesk-real-engine-journey.support.mjs'

const here = path.dirname(fileURLToPath(import.meta.url)), app = path.join(here, '..')
const load = set => JSON.parse(fs.readFileSync(path.join(app, 'scripts', 'real-engine', 'scripts', `${set}.json`), 'utf8'))

// a turn the way the check records it from c31 on: two tool rounds then the final text; a Decision call before the first round, two overlapping ones after
const timed = (over = {}) => ({ index: 1, say: 'q', posted: ['A사는 12,800원입니다.'], expectations: [{ check: 'posted', ok: true }], ok: true,
  subTurns: [{ status: 'completed', latencyMs: 9000, firstEventMs: 700, toolCalls: [{ tool: 'a' }, { tool: 'b' }],
    decisions: [{ names: ['answer_type'], atMs: 100, ms: 400 }, { names: ['pg_0'], atMs: 600, ms: 800 }, { names: ['sup_0'], atMs: 1000, ms: 500 }],
    timing: { sendMs: 20, engineStartMs: 1000, doneMs: 9000,
      events: [{ event: 'run.started', atMs: 30 }, { event: 'activity.completed', atMs: 40, kind: 'decisionContext' }, { event: 'activity.completed', atMs: 2600, kind: 'commandExecution' }, { event: 'message.completed', atMs: 8800 }],
      items: [{ id: 'i1', type: 'dynamicToolCall', startMs: 2500, endMs: 2700 }, { id: 'i3', type: 'agentMessage', startMs: 8000, endMs: 8700 }],
      tools: [{ id: 1, tool: 'a', startMs: 2500, endMs: 2700 }, { id: 2, tool: 'b', startMs: 5200, endMs: 5400 }] } }], ...over })

test('unionMs: overlapping calls count once, a gap does not', () => {
  assert.equal(unionMs([{ start: 0, ms: 100 }, { start: 50, ms: 100 }, { start: 400, ms: 10 }]), 160)
  assert.equal(unionMs([]), 0); assert.equal(unionMs([{ start: null, ms: 5 }, { start: 1, ms: undefined }]), 0)
})

test('engine rounds: a round ends with a tool call or the final text and runs from the previous round\'s end; tools are their own ms; a native item is not counted twice', () => {
  const t = timed().subTurns[0].timing, p = enginePhases(t, 9000)
  assert.deepEqual(p.roundMs, [1500, 2500, 3300]); assert.deepEqual([p.rounds, p.ms, p.tools, p.engineStartMs], [3, 7300, { count: 2, ms: 400 }, 1000]) // 1000 (the engine was asked)->2500, 2700->5200, 5400->8700: the layers before 1000 are not engine time; assert.equal(p.finalTextMs, 8700)
  // a native command item that overlaps a recorded tool call is the same call; one that does not is another tool
  const withNative = { ...t, items: [...t.items, { id: 'n1', type: 'commandExecution', startMs: 2550, endMs: 2650 }, { id: 'n2', type: 'commandExecution', startMs: 6000, endMs: 6500 }] }
  assert.deepEqual(enginePhases(withNative, 9000).tools, { count: 3, ms: 900 })
  assert.deepEqual(enginePhases({ tools: [], items: [] }, 100), { rounds: 0, ms: 0, roundMs: [], engineStartMs: null, tools: { count: 0, ms: 0 }, finalTextMs: null, turnMs: 100 })
})

test('turnTiming: first visible skips the runtime\'s own bookkeeping rows; the final answer is the last posted message; Decision wall counts overlaps once; the outcome word', () => {
  const t = turnTiming(timed({ rewrite: { posted: 'revised' } }))
  assert.deepEqual([t.hasTiming, t.turnMs, t.firstVisibleMs, t.firstMessageMs, t.finalAnswerMs, t.posted, t.outcome], [true, 9000, 2600, 8800, 8800, 1, 'revised'])
  assert.deepEqual({ count: t.decisions.count, sumMs: t.decisions.sumMs, wallMs: t.decisions.wallMs }, { count: 3, sumMs: 1700, wallMs: 1300 }); assert.deepEqual([t.engine.rounds, t.engine.derived, t.tools.count, t.tools.ms], [3, false, 2, 400])
  assert.deepEqual(t.layers, { ms: 1000, calls: 2, sumMs: 1200, wallMs: 1200, engineStarted: true }, 'the memory and action layers: the two Decision calls that began before the engine was asked'); assert.deepEqual([t.engine.startMs, t.engine.firstEventMs], [1000, 700])
  assert.deepEqual(t.answerNumbers, ['12800원']); assert.equal(t.expectations.posted, true)
  assert.equal(turnTiming(timed({ posted: [], draftCheck: { rows: [{}] } })).outcome, 'withheld'); assert.equal(turnTiming(timed({ posted: [] })).outcome, 'none'); assert.equal(turnTiming(timed()).outcome, 'posted')
  assert.equal(turnTiming(timed({ posted: [] })).finalAnswerMs, 8800, 'the last message event, even if the check lists no text')
  assert.equal(turnTiming({ index: 2, subTurns: [{ whileRunning: true }] }), null, 'a message typed into the run has no window of its own'); assert.equal(turnTiming({}), null)
})

test('an older record (no timing): what it can say is derived and marked, the rest is null (never guessed)', () => {
  const old = { index: 1, say: 'q', posted: ['x'], subTurns: [{ status: 'completed', latencyMs: 12000, toolCalls: [{}, {}, {}], decisions: [{ names: ['a'], ms: 300 }, { names: ['b'], ms: 200 }] }] }
  const t = turnTiming(old)
  assert.deepEqual([t.hasTiming, t.turnMs, t.firstVisibleMs, t.finalAnswerMs, t.decisions.wallMs, t.decisions.sumMs, t.decisions.count], [false, 12000, null, 12000, null, 500, 2])
  assert.deepEqual(t.engine, { rounds: 4, ms: null, roundMs: [], finalTextMs: null, startMs: null, firstEventMs: null, derived: true }); assert.deepEqual(t.tools, { count: 3, ms: null })
  assert.match(formatTable([{ key: 'k', ...t }]), /rounds derived/)
})

test('the two layers: a decision-first turn (no engine turn) is all layers; an older record has no layers; summaries carry the layers and the engine\'s first event', () => {
  const local = timed(); local.subTurns[0].timing = { ...local.subTurns[0].timing, engineStartMs: null, tools: [], items: [] }
  const t = turnTiming(local)
  assert.deepEqual(t.layers, { ms: 9000, calls: 3, sumMs: 1700, wallMs: 1300, engineStarted: false }); assert.deepEqual([t.engine.rounds, t.engine.startMs], [0, null])
  assert.deepEqual(turnTiming({ index: 1, posted: [], subTurns: [{ latencyMs: 1000, decisions: [] }] }).layers, { ms: null, calls: null, sumMs: null, wallMs: null, engineStarted: null })
  const s = summarize(recordTimings([{ set: 's', id: 'a', turns: [timed(), { ...timed(), index: 2 }] }]))
  assert.deepEqual([s.layersMs.median, s.layerCalls.median, s.engineFirstEventMs.median], [1000, 2, 700]); assert.match(formatSummary(s), /layers \(memory and action, before the engine starts\) n=2 median 1\.0s/)
})

test('summarize: medians and 90th percentiles over the turns that have the number', () => {
  const rows = recordTimings([{ set: 's', id: 'a', turns: [timed({ index: 1 }), { ...timed({ index: 2 }), subTurns: [{ ...timed().subTurns[0], latencyMs: 3000 }] }] }, { set: 's', id: 'b', turns: [{ index: 1, posted: [], subTurns: [{ latencyMs: 20000, decisions: [] }] }] }])
  const s = summarize(rows)
  assert.deepEqual([s.turns, s.withTiming, s.withAnswer, s.turnMs.median, s.turnMs.p90, s.firstVisibleMs.n, s.decisionCalls.median], [3, 2, 2, 9000, 20000, 2, 3])
  assert.match(formatSummary(s), /turns 3 \(with c31 timing 2/)
})

test('compare: matched by set, conversation and turn; seconds saved are off minus on; changed answer facts are named; unmatched turns are listed', () => {
  const off = [{ set: 's', id: 'c', turns: [timed({ index: 1 }), timed({ index: 2 }), timed({ index: 3 })] }]
  const faster = (extra = {}) => ({ ...timed(), ...extra, subTurns: [{ ...timed().subTurns[0], latencyMs: 4000, decisions: timed().subTurns[0].decisions.slice(0, 1), toolCalls: [{ tool: 'a' }], timing: { ...timed().subTurns[0].timing, tools: [timed().subTurns[0].timing.tools[0]], events: [{ event: 'message.completed', atMs: 3500 }], items: [{ id: 'i3', type: 'agentMessage', startMs: 3000, endMs: 3400 }] } }] })
  const on = [{ set: 's', id: 'c', turns: [{ ...faster(), index: 1 }, { ...faster({ posted: ['A사는 11,900원입니다.'], expectations: [{ check: 'posted', ok: false }] }), index: 2 }, { ...faster({ rewrite: { posted: 'withheld' }, posted: [] }), index: 9 }] }]
  const c = compareRuns(off, on)
  assert.equal(c.turns.length, 2); assert.deepEqual(c.unmatched.map(u => [u.key, u.side]).sort(), [['s/c#3', 'off only'], ['s/c#9', 'on only']])
  const [one, two] = c.turns
  assert.deepEqual(one.savedMs, { turn: 5000, layers: 0, firstVisible: -900, finalAnswer: 5300, decisionsWall: 900, engine: 5100, tools: 200 }, JSON.stringify(one.savedMs))
  assert.deepEqual(one.decisions, { off: 3, on: 1 }); assert.deepEqual(one.rounds, { off: 3, on: 2 }); assert.deepEqual(one.factChanges, [])
  assert.deepEqual(two.factChanges, ['numbers only with the flag on: 11900원', 'numbers only with the flag off: 12800원', 'expectation posted: true -> false'])
  assert.deepEqual([c.summary.matched, c.summary.answeredBoth, c.summary.faster, c.summary.slower, c.summary.savedSeconds.turn, c.summary.decisionCalls, c.summary.turnsWithChangedFacts], [2, 2, 2, 0, 10, { off: 6, on: 2 }, 1])
  const text = formatCompare(c); assert.match(text, /CHANGED: numbers only with the flag on: 11900원/); assert.match(text, /s\/c#3: off only/); assert.match(text, /seconds saved over the answered turns: turn 10/)
})

test('compare with --normalize: an -off and an -on copy of a script match turn by turn', () => {
  const c = compareRuns([{ set: 'real-engine-fast-off-v1', id: 'fast-off', turns: [timed()] }], [{ set: 'real-engine-fast-on-v1', id: 'fast-on', turns: [timed()] }], { normalize: /-off|-on/g })
  assert.deepEqual([c.turns.length, c.unmatched.length, c.turns[0].key], [1, 0, 'real-engine-fast-v1/fast#1'])
  assert.equal(compareRuns([{ set: 'a-off', id: 'x', turns: [timed()] }], [{ set: 'a-on', id: 'x', turns: [timed()] }]).unmatched.length, 2, 'without it they do not match')
})

test('the CLI (in process): table with per-script summaries, compare, --set, --normalize, usage; it reads a records folder and writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-timing-'))
  try {
    const put = (side, rec) => { const d = path.join(dir, side, rec.set); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `${rec.id}.json`), JSON.stringify(rec)) }
    put('off', { set: 'real-engine-x-v1', id: 'c', turns: [timed()] }); put('on', { set: 'real-engine-x-v1', id: 'c', turns: [{ ...timed(), subTurns: [{ ...timed().subTurns[0], latencyMs: 6000 }] }] }); fs.writeFileSync(path.join(dir, 'off', 'noise.json'), '{"a":1}')
    const run = (...a) => { const out = [], err = []; const code = main(a, { print: l => out.push(l), printError: l => err.push(l) }); return { code, out: out.join('\n'), err: err.join('\n') } }
    const table = run('table', path.join(dir, 'off')); assert.equal(table.code, 0); assert.match(table.out, /ALL\n/); assert.match(table.out, /real-engine-x-v1\nturns 1/)
    assert.equal(JSON.parse(run('table', path.join(dir, 'off'), '--json').out).rows.length, 1); assert.equal(run('table', path.join(dir, 'off'), '--set', 'nope').code, 1)
    const cmp = run('compare', path.join(dir, 'off'), path.join(dir, 'on')); assert.equal(cmp.code, 0); assert.match(cmp.out, /seconds saved over the answered turns: turn 3/)
    put('on', { set: 'real-engine-x-on-v1', id: 'c-on', turns: [timed()] }); put('off', { set: 'real-engine-x-off-v1', id: 'c-off', turns: [timed()] })
    const n = run('compare', path.join(dir, 'off'), path.join(dir, 'on'), '--normalize', '-off|-on', '--set', 'real-engine-x-o'); assert.equal(n.code, 0, n.err); assert.match(n.out, /real-engine-x-v1\/c#1/)
    assert.equal(run('compare', path.join(dir, 'off')).code, 2); assert.equal(run().code, 2); assert.match(run().err, /usage/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ---- the check's new fields, on the fake app-server ----
const monotone = rows => rows.every((r, i) => i === 0 || r.atMs >= rows[i - 1].atMs)
test('the check records timing per scripted turn: events, engine items, own tool calls and each Decision call\'s start, all offsets from the turn start; the measure reads them', async t => {
  const w = journeyWorld(t, commandFake({ command: 'sleep 20 && echo tests-passed-40', final: 'tests-passed-40' }))
  const rec = await runJourneyConversation(w, fastScript(load('real-engine-journey-nudges-v3')), 'journey-status')
  assert.equal(rec.aborted, null, rec.abortDetail)
  const sub = rec.turns[0].subTurns[0], timing = sub.timing
  assert.ok(timing && Number.isInteger(timing.sendMs) && timing.doneMs >= sub.latencyMs - 5, JSON.stringify(Object.keys(timing ?? {})))
  assert.ok(monotone(timing.events) && timing.events.every(e => e.atMs >= 0 && e.atMs <= timing.doneMs), JSON.stringify(timing.events))
  assert.deepEqual(timing.events.map(e => e.event).filter(e => e === 'run.started'), ['run.started']); assert.ok(timing.events.some(e => e.event === 'message.completed'))
  assert.ok(timing.events.filter(e => e.event.startsWith('activity.')).every(e => typeof e.kind === 'string'))
  assert.equal(timing.tools.length, 1); assert.equal(timing.tools[0].tool, 'egdesk_run_command'); assert.ok(timing.tools[0].endMs > timing.tools[0].startMs, 'the command ran about as long as its sleep in this fake')
  assert.ok(timing.items.length > 0 && timing.items.every(i => i.type)); assert.ok(sub.decisions.length > 0 && sub.decisions.every(d => Number.isInteger(d.atMs) && d.atMs >= 0 && d.atMs <= timing.doneMs))
  const row = turnTiming(rec.turns[0])
  assert.equal(row.hasTiming, true); assert.ok(row.firstVisibleMs !== null && row.firstVisibleMs <= row.finalAnswerMs, JSON.stringify(row)); assert.ok(row.finalAnswerMs <= row.turnMs + 50)
  assert.ok(Number.isInteger(timing.engineStartMs) && timing.engineStartMs >= 0 && timing.engineStartMs <= timing.tools[0].startMs, 'the engine was asked before its first tool call'); assert.ok(row.layers.engineStarted && row.layers.ms === timing.engineStartMs)
  assert.ok(row.layers.calls >= 1 && row.layers.calls <= row.decisions.count, 'the memory and action layers\' Decision calls came before the engine start'); assert.ok(Number.isFinite(row.engine.firstEventMs) || row.engine.firstEventMs === null)
  assert.deepEqual([row.tools.count, row.engine.derived, row.decisions.count > 0], [1, false, true]); assert.ok(row.tools.ms >= 1000, 'the command is mostly the tool time'); assert.ok(row.engine.rounds >= 2)
  // no key and no text beyond what the record already held
  assert.doesNotMatch(JSON.stringify(timing), /egd-synthetic|sk-synthetic|tests-passed/)
})

test('the same fake script twice gives a compare with matching turns and no changed facts (the measure is stable on identical runs)', async t => {
  const run = async () => runJourneyConversation(journeyWorld(t, MEMORY_FAKE, { persisted: true }), load('real-engine-journey-memory-v2'), 'journey-memory')
  const a = await run(), b = await run(), c = compareRuns([a], [b])
  assert.equal(c.turns.length, 4); assert.deepEqual(c.unmatched, []); assert.equal(c.summary.turnsWithChangedFacts, 0, JSON.stringify(c.turns.map(x => x.factChanges)))
  assert.deepEqual(c.turns.map(x => x.outcome), Array(4).fill({ off: 'as_written', on: 'as_written' }))
})
