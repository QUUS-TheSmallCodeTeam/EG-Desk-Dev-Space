import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectNativeCapabilities } from './egdesk-native-capabilities.mjs'
import { AppServerRpc } from './codex-app-server-rpc.mjs'

test('version proof uses the exact executable later selected for app-server, not an SDK fallback', () => {
  const executable = '/configured/native/codex'
  const proof = inspectNativeCapabilities({ executable, run: (program, args) => { assert.equal(program, executable); assert.deepEqual(args, ['--version']); return { status: 0, stdout: 'codex-cli 0.157.1\n' } } })
  assert.equal(proof.schemaMatch, true)
  assert.equal(proof.dynamicTools, true)
  assert.equal(proof.executable, executable)
  const old = inspectNativeCapabilities({ executable, run: () => ({ status: 0, stdout: 'codex-cli 0.130.0\n' }) })
  assert.equal(old.schemaMatch, false)
  assert.equal(old.dynamicTools, false)
})

test('dynamic tool transport explicitly opts into experimental API before native requests', async () => {
  const frames = []
  const rpc = new AppServerRpc({ experimentalApi: true, send: text => frames.push(JSON.parse(text)) })
  const init = rpc.initialize()
  assert.equal(frames[0].params.capabilities.experimentalApi, true)
  rpc.receive(JSON.stringify({ id: frames[0].id, result: {} }))
  await init
  assert.equal(frames[1].method, 'initialized')
  rpc.close()
})
