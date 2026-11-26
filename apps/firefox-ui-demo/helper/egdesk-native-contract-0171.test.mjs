// L4 a1 (2026-11-26): the ChatGPT.app Codex CLI 0.171.0-alpha.13 joins the exact context and QA contract sets. The real generated schema of that build
// (scripts/real-engine/fixtures/native-schema-0.171.0-alpha.13, the 13 files the probe reads, copied verbatim from `codex app-server
// generate-json-schema --experimental`) passes both shape checks; the version banner alone still opens nothing, neighbouring builds stay shut, and the
// board peer contract stays pinned to 0.162.1. Effective isolation on the real engine: scripts/real-engine/codex-qa-isolation-check.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CODEX_CHAT_VERSION_POLICY, capabilitiesOf, engineVersionStatus, inspectNativeCapabilities } from './egdesk-native-capabilities.mjs'
import { verifyNativeSchemaDirectory } from './codex-native-schema-probe.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(here, '..', 'scripts', 'real-engine', 'fixtures', 'native-schema-0.171.0-alpha.13')
// verifyNativeSchemaDirectory's digest of those 13 files, as the live probe of the installed build computed it on 2026-11-26
const SCHEMA_FP_0171 = '6ba03933635e66338310b1795765593766a127d8e1d458c49f42fc688f9a0bf7'
const HEX = /^[a-f0-9]{64}$/
const FULL = { contextContract: true, qaContract: true, schemaFingerprint: 'a'.repeat(64), boardPeerSchemaFingerprint: 'e'.repeat(64), turnSteerSchemaFingerprint: 'f'.repeat(64), threadDeleteSchemaFingerprint: 'd'.repeat(64) }
const inspect = (version, extra = {}) => inspectNativeCapabilities({ executable: '/selected/native', env: {}, cwd: '/', run: () => ({ status: 0, stdout: `codex-cli ${version}\n` }),
  probe: () => FULL, fingerprint: () => 'b'.repeat(64), deleteProbe: () => null, steerProbe: () => null, ...extra })

test('the real 0.171.0-alpha.13 generated schema passes the context and QA shape checks, and a missing required field closes them', async () => {
  const proof = verifyNativeSchemaDirectory(FIXTURE)
  assert.deepEqual([proof?.contextContract, proof?.qaContract, proof?.schemaFingerprint], [true, true, SCHEMA_FP_0171])
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-schema-0171-'))
  try {
    await cp(FIXTURE, dir, { recursive: true })
    const file = path.join(dir, 'DynamicToolCallParams.json'), damaged = JSON.parse(await readFile(file, 'utf8'))
    delete damaged.properties.callId
    await writeFile(file, JSON.stringify(damaged))
    assert.equal(verifyNativeSchemaDirectory(dir)?.contextContract, false)
    await cp(FIXTURE, dir, { recursive: true, force: true })
    const start = path.join(dir, 'v2', 'ThreadStartResponse.json'), noReadOnly = JSON.parse(await readFile(start, 'utf8'))
    noReadOnly.definitions.SandboxPolicy.oneOf = noReadOnly.definitions.SandboxPolicy.oneOf.filter(item => item.title !== 'ReadOnlySandboxPolicy')
    await writeFile(start, JSON.stringify(noReadOnly))
    assert.deepEqual([verifyNativeSchemaDirectory(dir)?.contextContract, verifyNativeSchemaDirectory(dir)?.qaContract], [true, false], 'no read-only policy in the response: no QA')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('0.171.0-alpha.13 opens context and QA only with the probe and fingerprint of the selected executable; neighbours stay shut; the board peer stays pinned', () => {
  const native = inspect('0.171.0-alpha.13')
  assert.deepEqual([native.versionStatus, native.schemaMatch, native.dynamicTools, native.readerReadOnly, native.qaReadOnly], ['supported', true, true, true, true])
  assert.match(native.contractFingerprint, HEX)
  assert.equal(native.boardPeerContract, null, 'the board peer contract stays the source-checked 0.162.1 one')
  assert.match(native.steerContract, HEX, 'a pinned version reads steer from its one probe')
  assert.equal(native.threadDelete, true)
  const caps = capabilitiesOf(native)
  assert.deepEqual([caps.dynamicTools, caps.qaReadOnly, caps.ephemeral, caps.steer, caps.turnSteer, caps.threadDelete], [true, true, true, true, false, true])
  for (const version of ['0.171.0-alpha.12', '0.171.0-alpha.14', '0.171.0', '0.172.0', '0.171.0-alpha.13.1']) {
    const other = inspect(version)
    assert.deepEqual([other.schemaMatch, other.qaReadOnly], [false, false], version)
  }
  assert.deepEqual([inspect('0.171.0-alpha.13', { probe: () => null }).schemaMatch, inspect('0.171.0-alpha.13', { probe: () => null }).qaReadOnly], [false, false])
  assert.deepEqual([inspect('0.171.0-alpha.13', { fingerprint: () => 'bad' }).schemaMatch, inspect('0.171.0-alpha.13', { fingerprint: () => 'bad' }).qaReadOnly], [false, false])
  assert.deepEqual([inspect('0.171.0-alpha.13', { probe: () => ({ ...FULL, qaContract: false }) }).schemaMatch, inspect('0.171.0-alpha.13', { probe: () => ({ ...FULL, qaContract: false }) }).qaReadOnly], [true, false])
  assert.deepEqual([inspect('0.171.0-alpha.13', { probe: () => ({ ...FULL, contextContract: false }) }).schemaMatch, inspect('0.171.0-alpha.13', { probe: () => ({ ...FULL, contextContract: false }) }).qaReadOnly], [false, false])
  assert.equal(engineVersionStatus('0.171.0-alpha.13', CODEX_CHAT_VERSION_POLICY), 'supported')
  assert.equal(engineVersionStatus('0.171.0-alpha.14', CODEX_CHAT_VERSION_POLICY), 'untested')
})
