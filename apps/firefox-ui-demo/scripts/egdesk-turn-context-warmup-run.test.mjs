// L6 c17: the shared last-send stamp and the point-by-point warm-up runner. Mock fetch only; nothing leaves the process.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DECISIONS_ENDPOINT } from '../helper/egdesk-decision-client.mjs'
import { main as runnerMain } from '../helper/egdesk-decision-real-runner.mjs'
import { SEND_STAMP_FILE, readSendStamp, sendStampPath, stampingFetch, writeSendStamp } from '../helper/egdesk-decision-send-stamp.mjs'
import { MIN_IDLE_MS, POINT_ORDER, WARMUP_POINTS, main, pointGate, pointPlanFile } from './egdesk-turn-context-warmup-run.mjs'

const KEY = 'sk-proj-' + 'k'.repeat(48)
const home = () => mkdtempSync(path.join(tmpdir(), 'egdesk-warmup-run-'))
const capture = () => { const out = [], err = []; return { out, err, print: l => out.push(l), printError: l => err.push(l) } }
function mockNetwork(log = []) {
  return async (url, init) => {
    const body = JSON.parse(Buffer.from(init.body).toString('utf8'))
    log.push({ url, questions: body.questions.length, auth: init.headers.authorization })
    return { status: 200, headers: { get: n => (n === 'openai-processing-ms' ? '210' : null) },
      json: async () => ({ model: 'gpt-6-luna', usage: { input_tokens: 900, output_tokens: 0 }, answers: body.questions.map(q => ({ name: q.name, type: q.type, ...(q.type === 'predicate' ? { probability: 0.1 } : {}) })) }) }
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
