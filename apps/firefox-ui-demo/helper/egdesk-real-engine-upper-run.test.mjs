// u1: the shipped script real-engine-upper-order-v1 run end to end by the check against the FAKE app-server (no Codex binary, no network, no real key): EGDESK_UPPER=on in the conversation fills
// the bundle, the turn runs, and expect.stages is JUDGED from the order the runtime marked. A conversation without the bundle records the same order (the marks are not a feature flag).
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFakeAppServer } from '../scripts/real-engine/fake-app-server.mjs'
import { DECISION_KEY_ENV, runCheck } from './egdesk-real-engine-check.mjs'
import { UPPER_BUNDLE } from './egdesk-upper-bundle.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = JSON.parse(fs.readFileSync(path.join(here, '..', 'scripts', 'real-engine', 'scripts', 'real-engine-upper-order-v1.json'), 'utf8'))

function world(t) {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-upper-run-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const out = path.join(base, 'out'), codexHome = path.join(base, 'codex-home'); fs.mkdirSync(codexHome)
  const fake = { turns: [{ steps: [{ toolCall: { tool: 'egdesk_read_file', arguments: { path: 'notes/todo.md' } } }], final: '남은 항목은 `일정 확인` 하나입니다.' }] }
  const stderrLines = []
  const spawn = (bin, argv, options) => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(), child = new EventEmitter()
    Object.assign(child, { pid: 4243, stdin, stdout, stderr, exitCode: null, signalCode: null, kill: () => true })
    runFakeAppServer({ script: fake, log: path.join(base, 'fake-app-server.log'), input: stdin, output: stdout, stderr: { write: line => { stderrLines.push(line); stderr.write(line) } }, env: options.env, exit: code => { child.exitCode = code; child.emit('close', code, null) } })
    return child
  }
  const killGroup = async child => { child.stdin.end(); await new Promise(resolve => { if (child.exitCode != null) return resolve(); child.once('close', resolve); setTimeout(resolve, 500) }); return { signal: 'SIGTERM' } }
  const fetched = []
  const fetchImpl = async (url, init) => { const body = JSON.parse(init.body); fetched.push(body); return Response.json({ answers: body.questions.map(q => ({ name: q.name, type: 'predicate', probability: 0.03 })), usage: { input_tokens: 20 } }) }
  const options = { mode: 'run', codexBin: '/fake/codex', home: { kind: 'dir', dir: codexHome }, scripts: [], out, decisions: true, model: null, effort: null, appServerConfig: [], turnTimeoutMs: 8000, json: false }
  const deps = { spawn, runnerSpawn: () => { throw new Error('no command runs here') }, fetchImpl, killGroup, killGroupRunner: () => {}, gitStatus: async () => null, env: { PATH: '/usr/bin:/bin', HOME: path.join(base, 'home'), [DECISION_KEY_ENV]: 'egd-synthetic-not-a-key-0u1r' } }
  return { options, deps, fetched }
}
const run = (w, script) => runCheck(w.options, [{ file: 'real-engine-upper-order-v1.json', script }], w.deps).then(r => r.records[0])

test('the check with EGDESK_UPPER=on fills the bundle into the conversation\'s flags and judges expect.stages from the runtime\'s own marks', async t => {
  const w = world(t), rec = await run(w, SCRIPT)
  assert.equal(rec.aborted, null)
  for (const row of UPPER_BUNDLE) assert.equal(rec.flags[row.flag], row.value, `${row.flag} filled by the bundle`)
  assert.equal(rec.flags.EGDESK_UPPER, 'on')
  const [t1] = rec.turns
  assert.deepEqual(t1.stages, { stages: ['memory', 'action', 'engine'], inTimeOrder: true })
  assert.deepEqual(t1.expectations.filter(e => e.check.startsWith('stages.')).map(e => [e.check, e.ok]), [['stages.order', true], ['stages.inTimeOrder', true]], 'the declared expectation was evaluated')
  assert.equal(rec.ok, true, JSON.stringify(t1.expectations.filter(e => !e.ok)))
})

test('a flag the script sets itself keeps its value under the bundle, and a conversation without the bundle records the same order', async t => {
  const own = structuredClone(SCRIPT); own.conversations[0].flags = { EGDESK_UPPER: 'on', EGDESK_DRAFT_CHECK: 'advisory', EGDESK_PROPOSAL_REGISTRY: 'off' }
  const a = await run(world(t), own)
  assert.deepEqual([a.flags.EGDESK_DRAFT_CHECK, a.flags.EGDESK_PROPOSAL_REGISTRY, a.flags.EGDESK_DECISION_FIRST], ['advisory', 'off', 'on'])
  const plain = structuredClone(SCRIPT); delete plain.conversations[0].flags
  const b = await run(world(t), plain)
  assert.equal(b.flags.EGDESK_DECISION_FIRST, undefined); assert.deepEqual(b.turns[0].stages.stages, ['memory', 'action', 'engine'])
})
