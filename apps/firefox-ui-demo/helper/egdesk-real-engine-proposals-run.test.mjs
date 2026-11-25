// c36: the shipped real-engine script real-engine-proposal-registry-v1 (terse-yes conversation) run end to end by the check against the FAKE app-server (no Codex binary, no network, no real key):
// the check's own runtime with the registry flag on, the recorded engine answers, a Decision model scripted by the quoted span. The turn record carries proposals (turn.proposals) and the script's
// expect.proposals is JUDGED (c33's hook was never read by the check: check-31pr passed with no proposals expectation at all).
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFakeAppServer } from '../scripts/real-engine/fake-app-server.mjs'
import { DECISION_KEY_ENV, runCheck } from './egdesk-real-engine-check.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = JSON.parse(fs.readFileSync(path.join(here, '..', 'scripts', 'real-engine', 'scripts', 'real-engine-proposal-registry-v1.json'), 'utf8'))
const TERSE = { ...SCRIPT, conversations: SCRIPT.conversations.filter(c => c.id === 'terse-yes') }
const ANSWER_1 = '[notes/todo.md](notes/todo.md)에서 지울 항목은 2개입니다.\n\n- `[x] 견적서 보내기`\n- `[x] 폴더 정리`\n\n파일은 아직 수정하지 않았습니다.' // recorded in check-31pr
const ANSWER_2 = '완료된 두 항목을 삭제했습니다. 미완료 항목인 `일정 확인`은 남겨 두었습니다.' // recorded in check-31pr
const FILE = '- [x] 견적서 보내기\n- [ ] 일정 확인\n- [x] 폴더 정리\n'

function world(t, { yes = true } = {}) {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-proposals-run-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const out = path.join(base, 'out'), codexHome = path.join(base, 'codex-home'); fs.mkdirSync(codexHome)
  const fake = { turns: [
    { steps: [{ toolCall: { tool: 'egdesk_read_file', arguments: { path: 'notes/todo.md' } } }], final: ANSWER_1 },
    { steps: [{ toolCall: { tool: 'egdesk_edit_file', arguments: { path: 'notes/todo.md', mode: 'replace', oldString: FILE, newString: '- [ ] 일정 확인\n' } } }], final: ANSWER_2 }] }
  const decisionBodies = [], stderrLines = []
  const spawn = (bin, argv, options) => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(), child = new EventEmitter()
    Object.assign(child, { pid: 4242, stdin, stdout, stderr, exitCode: null, signalCode: null, kill: () => true })
    runFakeAppServer({ script: fake, log: path.join(base, 'fake-app-server.log'), input: stdin, output: stdout, stderr: { write: line => { stderrLines.push(line); stderr.write(line) } }, env: options.env, exit: code => { child.exitCode = code; child.emit('close', code, null) } })
    return child
  }
  const killGroup = async child => { child.stdin.end(); await new Promise(resolve => { if (child.exitCode != null) return resolve(); child.once('close', resolve); setTimeout(resolve, 500) }); return { signal: 'SIGTERM' } }
  // the Decision model reads the quoted paragraph: it says "waiting" only for a paragraph that says the file was not changed (yes: false = it never says so)
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); decisionBodies.push(body)
    const paragraph = (body.input.map(m => /^The last paragraph of the assistant's answer:\n"""\n([\s\S]*?)\n"""$/.exec(String(m.content))?.[1]).find(Boolean)) ?? ''
    return Response.json({ answers: body.questions.map(q => ({ name: q.name, type: 'predicate', probability: q.name === 'pa' ? (yes ? 0.93 : 0.04) : q.name === 'pw' ? (yes && /수정하지 않았습니다/.test(paragraph) ? 0.93 : 0.04) : 0.04 })), usage: { input_tokens: 20 } })
  }
  const options = { mode: 'run', codexBin: '/fake/codex', home: { kind: 'dir', dir: codexHome }, scripts: [], out, decisions: true, model: null, effort: null, appServerConfig: [], turnTimeoutMs: 8000, json: false }
  const deps = { spawn, runnerSpawn: () => { throw new Error('no command runs here') }, fetchImpl, killGroup, killGroupRunner: () => {}, gitStatus: async () => null, env: { PATH: '/usr/bin:/bin', HOME: path.join(base, 'home'), [DECISION_KEY_ENV]: 'egd-synthetic-not-a-key-0036' } }
  return { options, deps, decisionBodies, stderrLines }
}
const run = w => runCheck(w.options, [{ file: 'real-engine-proposal-registry-v1.json', script: TERSE }], w.deps).then(r => r.records[0])

test('the check judges expect.proposals: the held-back deletion registers a waiting_action with its two items, and nothing is open after "ㅇㅇ"', async t => {
  const w = world(t), rec = await run(w)
  assert.equal(rec.aborted, null)
  const [t1, t2] = rec.turns
  assert.deepEqual(t1.proposals.items.map(i => [i.kind, i.steps]), [['waiting_action', ['[x] 견적서 보내기', '[x] 폴더 정리']]])
  assert.deepEqual(t1.expectations.filter(e => e.check.startsWith('proposals.')).map(e => [e.check, e.ok]), [['proposals.kinds', true], ['proposals.stepsAtLeast', true]], 'the declared expectation was evaluated, not skipped')
  assert.deepEqual(t2.proposals.items, []); assert.deepEqual(t2.expectations.filter(e => e.check.startsWith('proposals.')).map(e => [e.check, e.ok]), [['proposals.none', true]])
  assert.equal(rec.ok, true, JSON.stringify([t1.expectations, t2.expectations].flat().filter(e => !e.ok)))
  assert.equal(w.decisionBodies.filter(b => b.questions.some(q => q.name === 'pw')).length, 2, 'one registration call per answer')
})

test('when the Decision model does not say "waiting" the expectation FAILS and the conversation is not ok (it cannot pass vacuously)', async t => {
  const w = world(t, { yes: false }), rec = await run(w), t1 = rec.turns[0]
  assert.deepEqual(t1.proposals.items, []); assert.equal(t1.expectations.find(e => e.check === 'proposals.kinds').ok, false); assert.equal(rec.ok, false)
})
