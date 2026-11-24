// L6 c17: the shared last-send stamp and the point-by-point warm-up runner. Mock fetch only; nothing leaves the process.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DECISIONS_ENDPOINT } from '../helper/egdesk-decision-client.mjs'
import { main as runnerMain } from '../helper/egdesk-decision-real-runner.mjs'
import { SEND_STAMP_FILE, readSendStamp, sendStampPath, stampingFetch, writeSendStamp } from '../helper/egdesk-decision-send-stamp.mjs'
import { KINDS, MIN_IDLE_MS, POINT_ORDER, SIZE_KIND, WARMUP_POINTS, main, pointGate, pointPlanFile } from './egdesk-turn-context-warmup-run.mjs'

const KEY = 'sk-proj-' + 'k'.repeat(48)
const home = () => mkdtempSync(path.join(tmpdir(), 'egdesk-warmup-run-'))
const capture = () => { const out = [], err = []; return { out, err, print: l => out.push(l), printError: l => err.push(l) } }
function mockNetwork(log = [], tokens = 900) {
  return async (url, init) => {
    const body = JSON.parse(Buffer.from(init.body).toString('utf8'))
    log.push({ url, questions: body.questions.length, auth: init.headers.authorization })
    return { status: 200, headers: { get: n => (n === 'openai-processing-ms' ? '210' : null) },
      json: async () => ({ model: 'gpt-6-luna', usage: { input_tokens: tokens, output_tokens: 0 }, answers: body.questions.map(q => ({ name: q.name, type: q.type, ...(q.type === 'predicate' ? { probability: 0.1 } : {}) })) }) }
  }
}
const transportOf = fetch => () => ({ fetch, warm: () => false, close: () => {} })

test('send stamp: path from EGDESK_DECISION_SEND_STAMP or HOME; 0600, atomic, never through a symlink; content is times, runner and pid only', () => {
  const h = home()
  try {
    assert.equal(sendStampPath({ HOME: h }), path.join(h, SEND_STAMP_FILE))
    assert.equal(sendStampPath({ HOME: h, EGDESK_DECISION_SEND_STAMP: '/x/stamp.json' }), '/x/stamp.json')
    assert.throws(() => sendStampPath({ EGDESK_DECISION_SEND_STAMP: 'relative.json' }), /absolute/)
    const file = sendStampPath({ HOME: h })
    assert.equal(readSendStamp(file), null)
    writeSendStamp(file, { startedAt: '2026-11-25T00:00:00.000Z', endedAt: '2026-11-25T00:00:01.000Z', runner: 'unit' })
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort(), ['endedAt', 'pid', 'runner', 'startedAt', 'version'])
    assert.equal(readSendStamp(file).lastAt, Date.parse('2026-11-25T00:00:01.000Z'))
    const link = path.join(h, 'link.json'); symlinkSync(file, link)
    assert.throws(() => readSendStamp(link), /symbolic link/); assert.throws(() => writeSendStamp(link, { startedAt: 'x', runner: 'u' }), /symbolic link/)
    writeFileSync(path.join(h, 'bad.json'), '{"version":2}'); assert.throws(() => readSendStamp(path.join(h, 'bad.json')), /version-1/)
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('stampingFetch: a Decisions POST writes the start stamp before the network and the end stamp after; an unwritable stamp sends nothing; other URLs pass through', async () => {
  const h = home(), file = path.join(h, 's.json')
  try {
    const seen = []
    let at = Date.parse('2026-11-25T01:00:00Z')
    const now = () => new Date(at)
    const f = stampingFetch(async url => { seen.push([url, readSendStamp(file)]); at += 500; return { status: 200 } }, { file, runner: 'unit', now })
    await f(DECISIONS_ENDPOINT, {})
    assert.equal(seen[0][1].startedAt, '2026-11-25T01:00:00.000Z'); assert.equal(seen[0][1].endedAt, null, 'the start stamp is on disk before the network is called')
    assert.equal(readSendStamp(file).endedAt, '2026-11-25T01:00:00.500Z')
    await f('https://example.invalid/other', {}); assert.equal(readSendStamp(file).endedAt, '2026-11-25T01:00:00.500Z', 'not a Decisions request: no stamp')
    let called = 0
    const blocked = stampingFetch(async () => { called++ }, { file: path.join(h, 'missing-dir-is-a-file', 'x.json'), runner: 'unit' })
    writeFileSync(path.join(h, 'missing-dir-is-a-file'), '')
    await assert.rejects(blocked(DECISIONS_ENDPOINT, {}), e => e.name === 'SendStampError'); assert.equal(called, 0)
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('the generic runner stamps every real send (HOME of its environment) and never on a dry run', async () => {
  const h = home()
  try {
    const plan = pointPlanFile('A1'), io = capture()
    assert.equal(await runnerMain([plan], { env: { HOME: h, OPENAI_API_KEY: KEY }, fetchImpl: mockNetwork(), ...io }), 0)
    assert.equal(readSendStamp(path.join(h, SEND_STAMP_FILE)), null, 'dry run: no stamp')
    const io2 = capture()
    await runnerMain([plan, '--send'], { env: { HOME: h, OPENAI_API_KEY: KEY }, createTransport: transportOf(mockNetwork()), ...io2 })
    const s = readSendStamp(path.join(h, SEND_STAMP_FILE))
    assert.match(s.runner, /^decision-real-measure turn-context-warmup-v1\/A-rep1$/); assert.ok(s.endedAt)
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('warm-up points: refused without a stamp, before 10 minutes, twice; a point runs through the product transport, stamps, and is appended; --status and --analyze', async () => {
  const h = home(), env = { HOME: h, OPENAI_API_KEY: KEY }, stampFile = path.join(h, SEND_STAMP_FILE), resultsFile = path.join(h, 'turn-context-warmup-results.json')
  try {
    assert.deepEqual(POINT_ORDER, ['A1', 'B1', 'C1', 'A2', 'B2', 'C2']); assert.equal(WARMUP_POINTS.C2, 'C-rep2')
    let clock = Date.parse('2026-11-25T01:00:00Z')
    const now = () => clock, log = [], opts = io => ({ env, now, createTransport: transportOf(mockNetwork(log)), sleep: async ms => { clock += ms }, ...io })
    // no stamp: refused, nothing sent
    let io = capture()
    assert.equal(await main(['--point', 'A1', '--send'], opts(io)), 4); assert.match(JSON.parse(io.out[0]).why, /no last-send stamp/); assert.equal(log.length, 0)
    // --stamp-now, then 9 minutes: refused with the time it may run
    assert.equal(await main(['--stamp-now'], opts(capture())), 0)
    clock += 9 * 60_000
    io = capture(); assert.equal(await main(['--point', 'A1', '--send'], opts(io)), 4)
    assert.match(JSON.parse(io.out[0]).why, /only 540 s since the last Decisions send/); assert.equal(log.length, 0)
    io = capture(); await main(['--status'], opts(io))
    assert.equal(JSON.parse(io.out.join('')).nextMayRunAt, '2026-11-25T01:10:00.000Z')
    // dry run at 10 minutes: allowed, nothing sent
    clock += 60_000
    io = capture(); assert.equal(await main(['--point', 'A1'], opts(io)), 0); assert.equal(JSON.parse(io.out[0]).allowed, true); assert.equal(log.length, 0)
    // the point: sent, appended, stamped
    io = capture(); assert.equal(await main(['--point', 'A1', '--send'], opts(io)), 0)
    assert.equal(log.length, 1); assert.ok(log.every(r => r.url === DECISIONS_ENDPOINT))
    const r1 = JSON.parse(readFileSync(resultsFile, 'utf8'))
    assert.equal(statSync(resultsFile).mode & 0o777, 0o600); assert.ok(!readFileSync(resultsFile, 'utf8').includes(KEY), 'never the key')
    assert.deepEqual(Object.keys(r1.points), ['A1']); assert.equal(r1.points.A1.idleSecondsBefore, 600); assert.ok(Number.isFinite(r1.points.A1.results.measured.elapsedMs))
    assert.match(readSendStamp(stampFile).runner, /^warmup-run A1/)
    // again: refused (done), and B1 refused (the point itself was a send: 10 minutes again)
    io = capture(); assert.equal(await main(['--point', 'A1', '--send'], opts(io)), 4); assert.match(JSON.parse(io.out[0]).why, /already in the results file/)
    io = capture(); assert.equal(await main(['--point', 'B1', '--send'], opts(io)), 4); assert.match(JSON.parse(io.out[0]).why, /since the last Decisions send/)
    // B1 after 10 minutes: two requests, 1 s apart (the plan's wait), appended to the same file
    clock += MIN_IDLE_MS
    io = capture(); assert.equal(await main(['--point', 'B1', '--send'], opts(io)), 0)
    assert.equal(log.length, 3)
    const r2 = JSON.parse(readFileSync(resultsFile, 'utf8')); assert.deepEqual(Object.keys(r2.points), ['A1', 'B1']); assert.equal(r2.points.B1.results.measured.waitedMs, 1000)
    // out of order is allowed but noted
    clock += MIN_IDLE_MS
    io = capture(); assert.equal(await main(['--point', 'A2'], opts(io)), 0); assert.match(JSON.parse(io.out[0]).note, /registered order/)
    io = capture(); await main(['--status'], opts(io))
    const st = JSON.parse(io.out.join('')); assert.deepEqual(st.done.map(d => d.point), ['A1', 'B1']); assert.equal(st.next, 'C1'); assert.equal(st.nextAllowedNow, true)
    io = capture(); await main(['--analyze'], opts(io)); assert.equal(JSON.parse(io.out.join('')).reading, 'incomplete')
    // another runner sends during a point: recorded as interleaved
    clock += MIN_IDLE_MS
    const intruding = async (url, init) => { writeSendStamp(stampFile, { startedAt: new Date(clock).toISOString(), endedAt: new Date(clock).toISOString(), runner: 'decision-real-measure other' }); return mockNetwork(log)(url, init) }
    io = capture(); await main(['--point', 'C1', '--send'], { ...opts(io), createTransport: transportOf(intruding) })
    assert.equal(JSON.parse(readFileSync(resultsFile, 'utf8')).points.C1.interleaved, true)
    // usage errors
    for (const argv of [[], ['--point'], ['--point', 'Z9'], ['--send'], ['--status', '--analyze'], ['--point', 'A1', '--bogus']]) {
      const e = capture(); const code = await main(argv, opts(e)); assert.ok(code === 2 || (argv[1] === 'Z9' && code === 4), argv.join(' '))
    }
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('pointGate: the stamp in the future, and exactly 10 minutes', () => {
  const stamp = { lastAt: Date.parse('2026-11-25T01:00:00Z'), runner: 'x' }, results = { points: {} }
  assert.equal(pointGate('A1', { results, stamp, nowMs: stamp.lastAt - 1 }).ok, false)
  assert.equal(pointGate('A1', { results, stamp, nowMs: stamp.lastAt + MIN_IDLE_MS - 1 }).ok, false)
  assert.equal(pointGate('A1', { results, stamp, nowMs: stamp.lastAt + MIN_IDLE_MS }).ok, true)
})

test('--stamp-now --at: records a known earlier send, never a future one, never earlier than the stamp on disk', async () => {
  const h = home(), env = { HOME: h }, now = () => Date.parse('2026-11-24T16:05:00Z')
  try {
    let io = capture(); assert.equal(await main(['--stamp-now', '--at', '2026-11-25T00:50:00+09:00'], { env, now, ...io }), 0)
    assert.equal(readSendStamp(path.join(h, SEND_STAMP_FILE)).lastAt, Date.parse('2026-11-24T15:50:00Z'))
    io = capture(); assert.equal(await main(['--point', 'A1'], { env, now, ...io }), 0); assert.deepEqual([JSON.parse(io.out[0]).allowed, JSON.parse(io.out[0]).idleSeconds], [true, 900])
    io = capture(); assert.equal(await main(['--stamp-now', '--at', '2026-11-25T00:40:00+09:00'], { env, now, ...io }), 2, 'never moves the stamp back')
    io = capture(); assert.equal(await main(['--stamp-now', '--at', '2026-11-25T02:00:00+09:00'], { env, now, ...io }), 2, 'not in the future')
    io = capture(); assert.equal(await main(['--status', '--at', '2026-11-25T00:40:00+09:00'], { env, now, ...io }), 2)
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('every measurement script that reads --send (outside comments) writes the shared stamp, or delegates to the generic runner that does', async () => {
  const { readdirSync } = await import('node:fs')
  const dir = path.dirname(new URL(import.meta.url).pathname)
  const senders = readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && /measure|warmup-run/.test(f))
    .filter(f => /['"`]--send['"`]/.test(readFileSync(path.join(dir, f), 'utf8').replace(/\/\/.*$/gm, '')))
  assert.ok(senders.length >= 6, `found ${senders.join(', ')}`)
  for (const f of senders) {
    const code = readFileSync(path.join(dir, f), 'utf8')
    const stamps = /egdesk-decision-send-stamp\.mjs/.test(code), delegates = /main\(process\.argv\.slice\(2\)/.test(code) && /egdesk-decision-real-runner\.mjs/.test(code)
    assert.ok(stamps || delegates, `scripts/${f} reads --send but neither stamps nor delegates to the stamping runner`)
  }
  // the generic runner and the point runner themselves
  assert.match(readFileSync(path.join(dir, '..', 'helper', 'egdesk-decision-real-runner.mjs'), 'utf8'), /stampingFetch\(network/)
})

test('--set size: the two body-size points use the same 10-minute rule, their own results file and their own reading', async () => {
  const h = home(), env = { HOME: h, OPENAI_API_KEY: KEY }, stampFile = path.join(h, SEND_STAMP_FILE), resultsFile = path.join(h, 'turn-context-warmup-size-results.json')
  try {
    assert.deepEqual(SIZE_KIND.order, ['S1', 'S2']); assert.equal(KINDS.size, SIZE_KIND); assert.match(pointPlanFile('S1', SIZE_KIND), /turn-context-warmup-size\/S1-small\/plan\.json$/)
    let clock = Date.parse('2026-11-25T03:00:00Z')
    const now = () => clock, log = [], opts = io => ({ env, now, createTransport: transportOf(mockNetwork(log, 200)), sleep: async ms => { clock += ms }, ...io })
    // the six points' names are not size points, and the other way round
    let io = capture(); assert.equal(await main(['--set', 'size', '--point', 'A1'], opts(io)), 4); assert.match(JSON.parse(io.out[0]).why, /unknown point A1 \(one of S1 S2\)/)
    io = capture(); assert.equal(await main(['--point', 'S1'], opts(io)), 4); assert.match(JSON.parse(io.out[0]).why, /unknown point S1/)
    io = capture(); assert.equal(await main(['--set', 'other', '--status'], opts(io)), 2)
    // no stamp: refused; 9 minutes: refused; 10 minutes: allowed, with a note that the six warm-up points are not in
    io = capture(); assert.equal(await main(['--set', 'size', '--point', 'S1', '--send'], opts(io)), 4); assert.equal(log.length, 0)
    await main(['--stamp-now'], opts(capture())); clock += 9 * 60_000
    io = capture(); assert.equal(await main(['--set', 'size', '--point', 'S1', '--send'], opts(io)), 4); assert.equal(log.length, 0)
    clock += 60_000
    io = capture(); assert.equal(await main(['--set', 'size', '--point', 'S1'], opts(io)), 0); const dry = JSON.parse(io.out[0]); assert.equal(dry.allowed, true); assert.match(dry.note2, /only 0 of the 6 warm-up points are in/)
    io = capture(); assert.equal(await main(['--set', 'size', '--point', 'S1', '--send'], opts(io)), 0)
    assert.equal(log.length, 2); assert.ok(log.every(r => r.url === DECISIONS_ENDPOINT))
    const r1 = JSON.parse(readFileSync(resultsFile, 'utf8'))
    assert.equal(r1.set, 'turn-context-warmup-size-v1'); assert.deepEqual(Object.keys(r1.points), ['S1']); assert.equal(r1.points.S1.results.measured.waitedMs, 1000); assert.equal(statSync(resultsFile).mode & 0o777, 0o600)
    assert.match(readSendStamp(stampFile).runner, /^warmup-run S1/)
    // the six-point results file is untouched, and S2 again needs 10 minutes
    assert.throws(() => readFileSync(path.join(h, 'turn-context-warmup-results.json')))
    io = capture(); assert.equal(await main(['--set', 'size', '--point', 'S2', '--send'], opts(io)), 4)
    clock += MIN_IDLE_MS
    io = capture(); assert.equal(await main(['--set', 'size', '--point', 'S2', '--send'], opts(io)), 0)
    io = capture(); await main(['--set', 'size', '--analyze'], opts(io))
    const an = JSON.parse(io.out.join('')); assert.deepEqual(an.points, ['S1', 'S2']); assert.ok(an.reading.length > 0 && an.reading !== 'incomplete')
    io = capture(); await main(['--set', 'size', '--status'], opts(io)); assert.equal(JSON.parse(io.out.join('')).complete, true)
    // a size results file is not a warm-up results file
    io = capture(); assert.equal(await main(['--status', '--results', resultsFile], opts(io)), 2)
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('--set sep: N1 swaps to a new transport for its last request, Y1 sits 10 minutes with an 11-minute socket cap, an interleaved send is flagged, and the reading comes out of the results file', async () => {
  const h = home(), env = { HOME: h, OPENAI_API_KEY: KEY }, stampFile = path.join(h, SEND_STAMP_FILE), resultsFile = path.join(h, 'turn-context-warmup-sep-results.json')
  try {
    assert.deepEqual(KINDS.sep.order, ['N1', 'N2', 'Y1']); assert.match(pointPlanFile('Y1', KINDS.sep), /turn-context-warmup-sep\/Y1\/plan\.json$/)
    let clock = Date.parse('2026-11-25T04:00:00Z')
    const now = () => clock, log = [], made = [], closed = []
    const createTransport = opts => { const t = { id: made.length + 1, opts, sent: 0 }; made.push(t); const net = mockNetwork(log, 200); return { fetch: (url, init) => { t.sent++; return net(url, init) }, warm: () => false, close: () => closed.push(t.id) } }
    const opts = io => ({ env, now, createTransport, sleep: async ms => { clock += ms }, ...io })
    await main(['--stamp-now'], opts(capture())); clock += MIN_IDLE_MS
    // N1: three requests, the last on a new transport (the first is closed at the swap, the second at the end)
    let io = capture(); assert.equal(await main(['--set', 'sep', '--point', 'N1', '--send'], opts(io)), 0)
    assert.equal(log.length, 3); assert.deepEqual(made.map(t => [t.sent, t.opts.idleMs ?? null]), [[2, null], [1, null]]); assert.deepEqual(closed, [1, 2])
    const r1 = JSON.parse(readFileSync(resultsFile, 'utf8')); assert.equal(r1.set, 'turn-context-warmup-sep-v1'); assert.equal(r1.points.N1.results.fresh.freshSocket, true); assert.equal(r1.points.N1.results.same.waitedMs, 1000)
    made.length = 0; closed.length = 0; clock += MIN_IDLE_MS
    // Y1: the 10-minute wait goes through the plan's wait cap, the transport gets the plan's idle cap; nothing swaps
    const before = clock
    io = capture(); assert.equal(await main(['--set', 'sep', '--point', 'Y1', '--send'], opts(io)), 0)
    assert.equal(clock - before, 600000, 'the pause was taken (fake clock)')
    assert.deepEqual(made.map(t => [t.sent, t.opts.idleMs]), [[2, 660000]], 'one transport, 11-minute idle cap, both requests'); assert.deepEqual(closed, [1])
    const r2 = JSON.parse(readFileSync(resultsFile, 'utf8')); assert.equal(r2.points.Y1.results.after.waitedMs, 600000); assert.equal(r2.points.Y1.interleaved, undefined)
    // an interleaved send during the wait is flagged
    const h2 = home(), env2 = { HOME: h2, OPENAI_API_KEY: KEY }, stamp2 = path.join(h2, SEND_STAMP_FILE)
    try {
      let c2 = Date.parse('2026-11-25T05:00:00Z'); const now2 = () => c2
      const sleepIntrudes = async ms => { c2 += ms; writeSendStamp(stamp2, { startedAt: new Date(c2).toISOString(), endedAt: new Date(c2).toISOString(), runner: 'decision-real-measure other' }) }
      await main(['--stamp-now'], { env: env2, now: now2, ...capture() }); c2 += MIN_IDLE_MS
      await main(['--set', 'sep', '--point', 'Y1', '--send'], { env: env2, now: now2, createTransport, sleep: sleepIntrudes, ...capture() })
      assert.equal(JSON.parse(readFileSync(path.join(h2, 'turn-context-warmup-sep-results.json'), 'utf8')).points.Y1.interleaved, true)
    } finally { rmSync(h2, { recursive: true, force: true }) }
    // analysis: N2 is not in yet -> incomplete, with the runs that are
    io = capture(); await main(['--set', 'sep', '--analyze'], opts(io))
    const an = JSON.parse(io.out.join('')); assert.equal(an.reading, 'incomplete'); assert.deepEqual(an.points, ['N1', 'Y1']); assert.ok(an.runs.N1 && an.runs.Y1 && an.runs.N2 === null)
    io = capture(); await main(['--set', 'sep', '--status'], opts(io)); const st = JSON.parse(io.out.join('')); assert.deepEqual([st.next, st.remaining], ['N2', ['N2']])
    // a sep results file is not a warm-up results file
    io = capture(); assert.equal(await main(['--status', '--results', resultsFile], opts(io)), 2)
  } finally { rmSync(h, { recursive: true, force: true }) }
})
