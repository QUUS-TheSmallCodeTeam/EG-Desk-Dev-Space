import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createSeedGuard, seedFingerprints, seedRefusal } from './egdesk-scenario-seed-guard.mjs'
import { maskSecrets, secretsIn } from './egdesk-secret-mask.mjs'
import { createGuardedFetch } from './egdesk-memory-live-runner.mjs'
import { main as realRunnerMain } from './egdesk-decision-real-runner.mjs'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'

// SYNTHETIC scenario material (the guard's view of a conversation example: its turns' text).
const material = (id, privacy, texts) => ({ id, variant: 'example', privacy, prints: seedFingerprints({ title: '', pages: [], facts: [], turns: texts.map(text => ({ text })) }) })
const LOCAL = '합성 대화: 이 문장은 로컬에만 두는 예시의 사람 턴이다, 실측에 보내면 안 된다.'
const APPROVED = '합성 대화: 승인된 예시의 사람 턴, 마스킹된 채 실측에 쓸 수 있다.'
const bodyWith = text => JSON.stringify({ model: DECISION_MODEL, input: [{ role: 'developer', content: 'Judge.' }, { role: 'user', content: `The person's turn:\n"""\n${text}\n"""` }],
  questions: [{ type: 'predicate', name: 'conv_praise', instructions: 'Does the person praise the assistant?' }] })

test('masking: credentials, tokens, keys, emails, phone numbers, account ids and query-string URLs; names stay', () => {
  const text = '태화트랜스 담당 kim@example.co.kr, 010-2345-6789, sk-proj-abcdefghijklmnop1234, https://x.example/a?token=1, account_id: AB12CD34, Bearer: xyz'
  assert.equal(maskSecrets(text), '태화트랜스 담당 [email], [phone], [key], [url], [account], [token]')
  assert.deepEqual(secretsIn(maskSecrets(text)), [])
})

test('guard: local-only material is refused; approved material passes unless a secret is left; declarations are checked', () => {
  const guard = createSeedGuard([material('a', 'owner-approved', [APPROVED]), material('l', 'local-only', [LOCAL])])
  assert.match(guard.check(bodyWith(`앞부분 ${LOCAL}`)), /local-only scenario seed l/)
  assert.equal(guard.check(bodyWith(APPROVED)), null)
  assert.match(guard.check(bodyWith(`${APPROVED} lee@example.com`)), /still holds \[email\]/)
  assert.equal(guard.check(bodyWith('전혀 다른 합성 문장입니다.')), null)
  assert.match(guard.check(bodyWith('x'), [{ id: 'l', privacy: 'local-only' }]), /only owner-approved/)
  assert.match(guard.check(bodyWith('x'), [{ id: 'l', privacy: 'owner-approved' }]), /the manifest says local-only/)
  assert.match(seedRefusal(bodyWith('x'), { declared: [{ id: 'z' }], guard: null }), /privacy none/)
})

test('runners: the plan runner refuses local-only material at load (dry run too); the live runner\'s fetch refuses it before the network', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-seed-guard-')); t.after(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.EGDESK_SCENARIO_SEEDS })
  const seeds = path.join(dir, 'seeds'); mkdirSync(seeds)
  const l = material('l', 'local-only', [LOCAL])
  writeFileSync(path.join(seeds, 'manifest.json'), JSON.stringify({ seeds: [{ id: 'l', variant: 'example', privacy: 'local-only' }] }))
  writeFileSync(path.join(seeds, 'fingerprints.json'), JSON.stringify({ 'l|example': l.prints }))
  process.env.EGDESK_SCENARIO_SEEDS = seeds
  const body = bodyWith(LOCAL)
  writeFileSync(path.join(dir, 'r1.json'), body)
  writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ set: 'seed-guard', tokenCeiling: 1000, passRule: 'x', requests: [{ id: 'r1', file: 'r1.json', sha256: createHash('sha256').update(body).digest('hex'), estInputTokens: 100,
    expect: [{ name: 'conv_praise', kind: 'predicate', min: 0.8, severity: 'hard' }] }] }))
  const errors = []
  const code = await realRunnerMain([path.join(dir, 'plan.json')], { env: {}, print() {}, printError: line => errors.push(line), fetchImpl: async () => { throw new Error('no network in tests') } })
  assert.equal(code, 2); assert.match(errors.join('\n'), /r1: built from the local-only scenario seed l/)
  const state = { sent: 0, tokens: 0, requests: [], turn: 1 }
  const guarded = createGuardedFetch(state, { fetchImpl: async () => { throw new Error('reached the network') }, ceiling: 100000, maxRequests: 10 })
  await assert.rejects(guarded('https://api.openai.com/v1/decisions', { body }), error => error.name === 'MeasurementStopped' && /scenario_seed/.test(error.message))
  assert.equal(state.sent, 0)
})
