// L4 a1: the real-engine QA isolation check, offline (nothing is started here): its arguments, its probe commands and how a record is judged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { appServerArgs, childEnv, classify, execRecord, parseArgs, plan, probePlan, turnPrompt } from './codex-qa-isolation-check.mjs'

const BIN = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'

test('arguments: DRY by default, a home is required, paths are absolute', () => {
  const o = parseArgs(['--codex-bin', BIN, '--person-home', '--out', '/tmp/out'])
  assert.deepEqual([o.run, o.skipTurn, o.home, o.turnTimeoutMs], [false, false, { kind: 'person', dir: null }, 180_000])
  assert.equal(parseArgs(['--codex-bin', BIN, '--codex-home', '/h', '--out', '/tmp/out', '--run', '--skip-turn']).home.dir, '/h')
  for (const bad of [[], ['--codex-bin', 'codex', '--person-home', '--out', '/o'], ['--codex-bin', BIN, '--out', '/o'], ['--codex-bin', BIN, '--person-home', '--codex-home', '/h', '--out', '/o'],
    ['--codex-bin', BIN, '--person-home', '--out', 'rel'], ['--codex-bin', BIN, '--person-home', '--out', '/o', '--turn-timeout-ms', '5'], ['--codex-bin', BIN, '--person-home', '--out', '/o', '--bogus']]) {
    assert.throws(() => parseArgs(bad), { code: 'usage' }, bad.join(' '))
  }
  assert.match(plan(o), /DRY: nothing is started/)
  assert.match(plan(o), /CODEX_HOME unset/)
})

test('the app-server is the product launch with effort low and memories off, in a small environment', () => {
  const args = appServerArgs()
  assert.equal(args[0], 'app-server')
  assert.ok(args.includes('features.memories=false'))
  assert.ok(args.includes('model_reasoning_effort="low"'))
  assert.ok(!args.includes('--listen'))
  const env = childEnv({ home: { kind: 'person' } }, { PATH: '/bin', HOME: '/u', OPENAI_API_KEY: 'k', CODEX_HOME: '/x', TMPDIR: '/t' })
  assert.deepEqual(env, { PATH: '/bin', HOME: '/u', TMPDIR: '/t' })
  assert.equal(childEnv({ home: { kind: 'dir', dir: '/h' } }, {}).CODEX_HOME, '/h')
})

test('the probe commands write under one temp folder only, and the turn prompt names the same three commands', () => {
  const p = probePlan('/tmp/egdesk-qa-isolation-x', 'n0')
  assert.equal(p.inside, '/tmp/egdesk-qa-isolation-x/inside')
  assert.ok(p.insideFile.startsWith(`${p.inside}/`) && !p.outsideFile.startsWith(`${p.inside}/`) && p.outsideFile.startsWith('/tmp/egdesk-qa-isolation-x/'))
  assert.deepEqual(p.policies.readOnly, { type: 'readOnly', networkAccess: false })
  assert.deepEqual(p.policies.writeControl.writableRoots, [p.inside])
  const prompt = turnPrompt(p)
  for (const file of [p.insideFile, p.outsideFile]) assert.ok(prompt.includes(file))
  assert.ok(prompt.includes('https://example.com'))
})

const ok = (name, policy, exitCode, extra = {}) => execRecord(name, policy, { exitCode, stdout: extra.stdout ?? '', stderr: extra.stderr ?? '' }, extra.file)
const RO = { type: 'readOnly', networkAccess: false }, WW = { type: 'workspaceWrite', networkAccess: false }, WN = { type: 'workspaceWrite', networkAccess: true }
const good = () => ({
  proofs: { nativeThread: 'native-thread-verified', externalMcpCatalog: 'empty', inspectedMcpServers: 10, nativeComputerFeatures: 'off', ephemeral: true },
  sandbox: [ok('read', RO, 0, { stdout: '. ..' }), ok('writeInside', RO, 1, { stderr: 'Operation not permitted', file: false }), ok('writeOutside', RO, 1, { stderr: 'Operation not permitted', file: false }),
    ok('network', RO, 6, { stdout: '000' }), ok('writeControl', WW, 0, { file: true }), ok('networkControl', WN, 0, { stdout: '200' })],
  turn: { status: 'completed', commands: [{ command: "curl ... https://example.com", exitCode: 6, output: '000' }], approvalsAsked: [], filesAfter: { inside: false, outside: false } },
})

test('verdicts: the measured 0.171 record passes; a write, a request, an approval or a broken proof fails; a missing control is inconclusive', () => {
  const pass = classify(good())
  assert.equal(pass.verdict, 'pass')
  assert.ok(pass.reasons.some(r => /did not try the writes/.test(r)))
  const mutate = fn => { const r = good(); fn(r); return classify(r) }
  assert.equal(mutate(r => { r.sandbox[1] = ok('writeInside', RO, 0, { file: true }) }).verdict, 'fail')
  assert.equal(mutate(r => { r.sandbox[2] = ok('writeOutside', RO, 1, { file: true }) }).verdict, 'fail')
  assert.equal(mutate(r => { r.sandbox[3] = ok('network', RO, 0, { stdout: '200' }) }).verdict, 'fail')
  assert.equal(mutate(r => { r.turn.approvalsAsked = ['item/commandExecution/requestApproval'] }).verdict, 'fail')
  assert.equal(mutate(r => { r.turn.filesAfter.outside = true }).verdict, 'fail')
  assert.equal(mutate(r => { r.turn.commands = [{ command: 'curl https://example.com', exitCode: 0, output: '200' }] }).verdict, 'fail')
  assert.equal(mutate(r => { r.proofs = { error: 'QA_POLICY_UNVERIFIED: no' } }).verdict, 'fail')
  assert.equal(mutate(r => { r.proofs.externalMcpCatalog = undefined; r.proofs.mcpError = 'QA_TOOL_ISOLATION_UNVERIFIED: x' }).verdict, 'fail')
  assert.equal(mutate(r => { r.proofs.ephemeral = false }).verdict, 'fail')
  assert.equal(mutate(r => { r.sandbox[4] = ok('writeControl', WW, 1, { file: false }) }).verdict, 'inconclusive')
  assert.equal(mutate(r => { r.sandbox[0] = ok('read', RO, 1) }).verdict, 'inconclusive')
  assert.equal(mutate(r => { r.turn.status = 'timeout' }).verdict, 'inconclusive')
  assert.equal(mutate(r => { r.turn.commands = [] }).verdict, 'inconclusive')
  const offline = mutate(r => { r.sandbox[5] = ok('networkControl', WN, 6, { stdout: '000' }) })
  assert.equal(offline.verdict, 'pass')
  assert.ok(offline.reasons.some(r => /network control/.test(r)))
  assert.equal(mutate(r => { r.turn = { skipped: true } }).verdict, 'pass')
})
