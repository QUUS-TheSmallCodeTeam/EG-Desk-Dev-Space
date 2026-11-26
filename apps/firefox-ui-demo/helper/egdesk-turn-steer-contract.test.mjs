// c23: a plain message may be steered into a working turn when THIS binary's generated schema says turn/steer has the shape EG-Desk sends,
// with no version pin (Main's smoke-3 proved turn/steer { threadId, expectedTurnId, input } -> { turnId } on the official 0.171.0-alpha.13).
// The schema files are the real ones of that build (scripts/real-engine/fixtures); the ClientRequest union is a minimal stand-in (the real one is 340 KB).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { optionalTurnSteerFingerprint, verifyBoardPeerSchema, verifyTurnSteerSchema } from './codex-native-schema-probe.mjs'
import { capabilitiesOf, inspectNativeCapabilities } from './egdesk-native-capabilities.mjs'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = name => JSON.parse(fs.readFileSync(path.join(here, '..', 'scripts', 'real-engine', 'fixtures', `${name}-0.171.0-alpha.13.json`), 'utf8'))
const union = (...methods) => ({ oneOf: methods.map(method => ({ properties: { method: { enum: [method] } } })) })
const HEX = /^[a-f0-9]{64}$/

test('the real 0.171 turn/steer schema passes the plain-steer check, and so does the board peer shape that the version pin withheld', () => {
  const params = fixture('TurnSteerParams'), response = fixture('TurnSteerResponse')
  assert.equal(verifyTurnSteerSchema(union('turn/start', 'turn/steer'), params, response), true)
  assert.equal(verifyBoardPeerSchema(params, response), true, 'the schema was never the obstacle; the pin was')
})

test('the plain-steer check refuses a shape EG-Desk does not send', () => {
  const ok = () => ({ request: union('turn/steer'), params: structuredClone(fixture('TurnSteerParams')), response: structuredClone(fixture('TurnSteerResponse')) })
  const verdict = m => { const x = ok(); m(x); return verifyTurnSteerSchema(x.request, x.params, x.response) }
  assert.equal(verdict(() => {}), true)
  assert.equal(verdict(x => { x.request = union('turn/start') }), false, 'turn/steer is not in the request union')
  assert.equal(verdict(x => { x.params.required.push('turnTrigger') }), false, 'a new required field the client does not send')
  assert.equal(verdict(x => { x.params.required = ['threadId', 'input'] }), false, 'expectedTurnId is not required: the turn is not pinned')
  assert.equal(verdict(x => { x.params.properties.expectedTurnId = { type: 'integer' } }), false)
  assert.equal(verdict(x => { x.params.properties.threadId = { type: 'object' } }), false)
  assert.equal(verdict(x => { x.params.properties.input = { type: 'string' } }), false)
  assert.equal(verdict(x => { x.params.definitions.UserInput.oneOf = x.params.definitions.UserInput.oneOf.filter(v => v.properties.type.enum[0] !== 'text') }), false, 'no text input')
  assert.equal(verdict(x => { x.params.definitions.UserInput.oneOf.find(v => v.properties.type.enum[0] === 'text').required.push('mime') }), false)
  assert.equal(verdict(x => { x.response.required = [] }), false)
  assert.equal(verdict(x => { x.response.properties.turnId = { type: 'integer' } }), false)
  assert.equal(verdict(x => { x.params.title = 'Other' }), false)
  assert.equal(verdict(x => { x.params.properties.clientUserMessageId = { type: 'object' } }), false)
  assert.equal(verdict(x => { delete x.params.properties.clientUserMessageId }), true, 'an optional field may be absent')
})

test('the fingerprint reads the three files, changes with them, and is null when one is missing or off shape', t => {
  const dir = fs.realpathSync(createPrivateQaTempDirectory('egdesk-steer-fp-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'v2'))
  const write = (request = union('turn/steer'), params = fixture('TurnSteerParams'), response = fixture('TurnSteerResponse')) => {
    fs.writeFileSync(path.join(dir, 'ClientRequest.json'), JSON.stringify(request)); fs.writeFileSync(path.join(dir, 'v2', 'TurnSteerParams.json'), JSON.stringify(params)); fs.writeFileSync(path.join(dir, 'v2', 'TurnSteerResponse.json'), JSON.stringify(response))
  }
  write(); const first = optionalTurnSteerFingerprint(dir); assert.match(first, HEX)
  write(union('turn/steer', 'turn/start')); assert.notEqual(optionalTurnSteerFingerprint(dir), first)
  write(union('turn/start')); assert.equal(optionalTurnSteerFingerprint(dir), null)
  fs.rmSync(path.join(dir, 'v2', 'TurnSteerResponse.json')); assert.equal(optionalTurnSteerFingerprint(dir), null)
})

const FP = 'a'.repeat(64), BIN = 'b'.repeat(64)
const inspect = (version, extra = {}) => inspectNativeCapabilities({ executable: '/fake/codex', env: {}, cwd: '/', run: () => ({ status: 0, stdout: `codex-cli ${version}\n` }),
  probe: () => null, deleteProbe: () => null, steerProbe: () => FP, fingerprint: () => BIN, ...extra })

test('the capability of a binary: steer from its own schema for any identified version; nothing else is granted by it', () => {
  // a build EG-Desk does not pin (0.171.0-alpha.13 itself is pinned since L4 a1 and reads steer from its one probe, like 0.162.1 below)
  const native = inspect('0.171.0-alpha.14')
  assert.match(native.steerContract, HEX)
  assert.equal(native.boardPeerContract, null); assert.equal(native.schemaMatch, false); assert.equal(native.dynamicTools, false)
  // it names the binary, its version and its schema: a different build gets a different proof
  assert.notEqual(inspect('0.172.0').steerContract, native.steerContract)
  assert.notEqual(inspect('0.171.0-alpha.14', { fingerprint: () => 'c'.repeat(64) }).steerContract, native.steerContract)
  assert.notEqual(inspect('0.171.0-alpha.14', { steerProbe: () => 'd'.repeat(64) }).steerContract, native.steerContract)
  // no capability: schema without it, an unreadable version, a binary that cannot be fingerprinted, a probe that throws
  assert.equal(inspect('0.171.0-alpha.14', { steerProbe: () => null }).steerContract, null)
  assert.equal(inspect('0.171.0-alpha.14', { run: () => ({ status: 1, stdout: '' }) }).steerContract, null)
  assert.equal(inspect('0.171.0-alpha.14', { fingerprint: () => { throw new Error('unreadable') } }).steerContract, null)
  assert.equal(inspect('0.171.0-alpha.14', { steerProbe: () => { throw new Error('probe failed') } }).steerContract, null)
  assert.equal(inspect('0.171.0-alpha.14', { steerProbe: () => 'not-a-hash' }).steerContract, null)
  // a pinned version reads it from its one probe (no second generation)
  let probes = 0
  const pinned = inspect('0.162.1', { probe: () => { probes++; return { contextContract: true, qaContract: false, schemaFingerprint: FP, boardPeerSchemaFingerprint: 'e'.repeat(64), turnSteerSchemaFingerprint: 'f'.repeat(64) } }, steerProbe: () => { throw new Error('a second generation') } })
  assert.equal(probes, 1); assert.match(pinned.steerContract, HEX); assert.match(pinned.boardPeerContract, HEX); assert.notEqual(pinned.steerContract, pinned.boardPeerContract)
  const caps = capabilitiesOf(native)
  assert.equal(caps.steer, true); assert.equal(caps.steerContract, native.steerContract); assert.equal(caps.turnSteer, false, 'turnSteer is still the board peer contract')
  assert.equal(capabilitiesOf(inspect('0.171.0-alpha.14', { steerProbe: () => null })).steer, false)
})

test('the adapter: a plain steer takes the steer proof; additional context takes only the board peer proof; any other proof is refused', async () => {
  const sent = []
  const request = async (method, params) => { sent.push([method, params]); return { turnId: params.expectedTurnId } }
  const STEER = 'd'.repeat(64), PEER = 'e'.repeat(64)
  const adapter = createCodexEngineAdapter({ request, respond: () => {}, getSteerContract: () => STEER, getBoardPeerContract: () => PEER })
  const plain = { threadId: 't', expectedTurnId: 'u', input: [{ type: 'text', text: 'x', text_elements: [] }] }
  assert.equal(adapter.steerContract(), STEER)
  assert.deepEqual(await adapter.steerTurn(plain, undefined, STEER), { turnId: 'u' })
  assert.deepEqual(await adapter.steerTurn(plain, undefined, PEER), { turnId: 'u' }, 'the board peer contract still covers a plain steer')
  assert.throws(() => adapter.steerTurn({ ...plain, additionalContext: { k: { kind: 'untrusted', value: 'v' } } }, undefined, STEER), { code: 'BOARD_PEER_UNSUPPORTED' })
  assert.deepEqual(await adapter.steerTurn({ ...plain, additionalContext: { k: { kind: 'untrusted', value: 'v' } } }, undefined, PEER), { turnId: 'u' })
  assert.throws(() => adapter.steerTurn(plain, undefined, 'f'.repeat(64)), { code: 'BOARD_PEER_UNSUPPORTED' })
  assert.throws(() => adapter.steerTurn(plain, undefined, null), { code: 'BOARD_PEER_UNSUPPORTED' })
  assert.equal(sent.length, 3)
  // no contract on this binary: no proof, refused
  const none = createCodexEngineAdapter({ request, respond: () => {} })
  assert.equal(none.steerContract(), null)
  assert.throws(() => none.steerTurn(plain, undefined, STEER), { code: 'BOARD_PEER_UNSUPPORTED' })
  // a malformed proof from the bridge is no proof
  assert.equal(createCodexEngineAdapter({ request, respond: () => {}, getSteerContract: () => 'short' }).steerContract(), null)
})
