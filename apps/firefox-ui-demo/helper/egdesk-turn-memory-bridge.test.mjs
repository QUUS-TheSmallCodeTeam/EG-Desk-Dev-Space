import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { chmod, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { openBridgeSettings, TURN_MEMORY_DEFAULT, TURN_MEMORY_MODES } from './egdesk-bridge-settings.mjs'
import { createTurnMemoryConfig } from './egdesk-turn-memory-wiring.mjs'
import { createWikiAdapter, openWikiWrites } from './egdesk-wiki-adapter.mjs'
import { mockJudge, until } from './egdesk-wiki-reconstruction.fixture.mjs'

const quiet = () => {}
const profiles = { runProfile: (p, r) => ({ binding: { profileId: p, revision: r ?? 1, hash: 'h' }, developerInstructions: 'x', toolCeiling: null, model: null }) }
const GRAPH = { snapshots: [], nodes: [{ id: 'a', label: 'PostgreSQL 마이그레이션 배포 계획', body: '12월 첫째 주 전환 배포 예정. 아직 배포 전이다.', timeSlice: 'future' }], edges: [] }
const normalize = text => text.replace(/"(?:clientId|requestId|localMessageId|localRunId)":"[^"]*"/g, '"id":"x"')

test('the production wiring: the bridge builds turnMemory from the bridge setting and opens the adapter lazily', async () => {
  const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.match(source, /const turnMemoryConfig = createTurnMemoryConfig\(\{ settings: bridgeSettings,/)
  assert.match(source, /getAdapter: \(\) => wikiAdapter \?\?= createWikiAdapter\(\{ writes: openWikiWrites\(\{ dataDir: path\.join\(dataDir, 'settings'\) \}\) \}\)/)
  const block = source.slice(source.indexOf('decisionContext: {'), source.indexOf('collect: async ({ body, context, memoryEvidenceFor, speech })'))
  assert.match(block, /turnMemory: turnMemoryConfig,/)
  assert.doesNotMatch(source, /turnMemory\.save\('advisory'\)|turnMemory: 'advisory'/, 'nothing in the bridge turns it on by itself')
  assert.ok(!/wikiAdapter = createWikiAdapter|openWikiWrites\(/.test(source.replace(/getAdapter: \(\) => wikiAdapter \?\?= createWikiAdapter\(\{ writes: openWikiWrites\([^\n]*\n/, '')), 'the adapter and its store are created only inside the lazy getter')
})

test('the setting defaults to off; "off", "advisory" and "on" exist, every one saved explicitly; a file with anything else is treated as damaged', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-tm-settings-')); await chmod(dir, 0o700)
  const dataDir = path.join(dir, 'settings')
  const fresh = openBridgeSettings({ dataDir, log: quiet })
  assert.deepEqual([fresh.turnMemory.mode, fresh.turnMemory.saved, TURN_MEMORY_DEFAULT, TURN_MEMORY_MODES], ['off', false, 'off', ['off', 'advisory', 'on']])
  assert.throws(() => fresh.turnMemory.save('always'), /Invalid bridge setting/, 'not a mode')
  assert.equal(fresh.turnMemory.mode, 'off')
  assert.ok(await fresh.turnMemory.save('advisory'))
  assert.equal(openBridgeSettings({ dataDir, log: quiet }).turnMemory.mode, 'advisory', 'explicitly saved, it survives a restart')
  const file = path.join(dataDir, 'bridge-settings.json')
  await writeFile(file, JSON.stringify({ version: 1, turnMemory: 'on' }), { mode: 0o600 })
  assert.equal(openBridgeSettings({ dataDir, log: quiet }).turnMemory.mode, 'on', 'explicitly written, "on" is read')
  await writeFile(file, JSON.stringify({ version: 1, turnMemory: 'always' }), { mode: 0o600 })
  const damaged = openBridgeSettings({ dataDir, log: quiet })
  assert.equal(damaged.turnMemory.mode, 'off'); assert.ok((await readdir(dataDir)).some(n => n.includes('.corrupt-')))
})

async function rig({ withMemory, settings, getAdapter, decides }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-tm-bridge-')); await chmod(dir, 0o700)
  const store = openChatStore({ dataDir: path.join(dir, 'chat'), ownerScope: 'synthetic' })
  const calibrationLog = openCalibrationLog({ dataDir: path.join(dir, 'settings'), log: quiet })
  const judge = mockJudge()
  const starts = []
  let turns = 0, threads = 0
  const chat = new CodexChatRuntime({ now: () => Date.now(), store, requireStore: true, getOwnerKey: () => 'codex:synthetic:qa', profiles, resolveProjectWorkspace: async () => null,
    request: async (method, p) => {
      if (method === 'thread/start') return { thread: { id: `t${++threads}` }, cwd: '/work', model: 'syn' }
      if (method === 'config/read') return { config: { developer_instructions: null } }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      starts.push(JSON.stringify(p))
      const id = `turn-${++turns}`, timing = { threadId: p.threadId, turnId: id }
      const finish = async () => { const n = (m, q) => chat.handleNotification({ method: m, params: q })
        await n('item/started', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text: '' } })
        await n('item/completed', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text: '네' } })
        await n('turn/completed', { threadId: p.threadId, turn: { id, status: 'completed', items: [] } }) }
      setImmediate(() => setImmediate(finish))
      return { turn: { id, status: 'inProgress', items: [] } } },
    respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null,
    decisionContext: { calibrationLog, mode: () => 'advisory', settingsGeneration: () => 0, configured: () => true, budgetMs: 800,
      client: { model: 'syn', async decide(req) { decides.push(req.questions.map(q => q.name)); return judge.decide(req) } }, collect: async () => [],
      ...(withMemory ? { turnMemory: createTurnMemoryConfig({ settings, getAdapter, ontologyStore: { readGraph: async () => GRAPH } }) } : {}) } })
  chat.setConnection(true)
  const done = async n => { await until(() => store.listMessages('dm-1').messages.filter(m => m.role === 'assistant' && m.status === 'complete').length >= n, `answer ${n} completed`); for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r)) }
  return { chat, store, starts, done, dir, calibrationLog, send: (message, requestId, conversationId) => chat.send({ message, clientThreadId: 'dm-1', requestId, ...(conversationId ? { conversationId } : {}), profileId: 'sol', replyDestination: 'direct' }) }
}

test('default bridge: nothing extra is sent, nothing is built or opened, and the native input is unchanged; explicitly enabled it only records', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-tm-run-')); await chmod(dir, 0o700)
  const settings = openBridgeSettings({ dataDir: path.join(dir, 'settings'), log: quiet })
  let adapterBuilds = 0, adapter = null // memoized the way the bridge does (wikiAdapter ??= ...)
  const getAdapter = () => adapter ??= (adapterBuilds++, createWikiAdapter({ writes: openWikiWrites({ dataDir: path.join(dir, 'settings'), log: quiet }) }))
  const baseline = await rig({ withMemory: false, decides: [] })
  await baseline.send('PostgreSQL 마이그레이션 배포 끝났어', 'r1'); await baseline.done(1)

  const decides = []
  const off = await rig({ withMemory: true, settings, getAdapter, decides })
  await off.send('PostgreSQL 마이그레이션 배포 끝났어', 'r1'); await off.done(1); await off.chat.turnMemoryIdle()
  assert.deepEqual(decides, [], 'the default bridge makes no extra Decisions request')
  assert.equal(adapterBuilds, 0, 'the adapter and its store are never created while the setting is off')
  assert.equal(normalize(off.starts[0]), normalize(baseline.starts[0]), 'the native input is byte-identical to a bridge without the feature')
  assert.equal(off.calibrationLog.entries().length, 0)
  assert.ok(!(await readdir(path.join(dir, 'settings'))).some(n => n.includes('wiki')))

  await settings.turnMemory.save('advisory')
  const on = await rig({ withMemory: true, settings, getAdapter, decides })
  await on.send('PostgreSQL 마이그레이션 배포 끝났어', 'r1'); await on.done(1); await on.chat.turnMemoryIdle()
  assert.ok(decides.length >= 2, 'enabled: the memory loop ran in the background')
  assert.equal(adapterBuilds, 1)
  assert.equal(normalize(on.starts[0]), normalize(baseline.starts[0]), 'enabled advisory still changes nothing the answering model receives')
  assert.ok(!on.starts[0].includes('egdesk_decision_context'))
  const entries = on.calibrationLog.entries().filter(e => e.feature === 'turn_memory')
  assert.equal(entries.length, 1); assert.equal(entries[0].attached, false)
  assert.equal(entries[0].candidates, 1, 'the wiki was built from the ontology graph through the adapter')
  assert.ok(!(await readdir(path.join(dir, 'settings'))).some(n => n === 'egdesk-wiki-writes.json'), 'advisory writes no pages')
  for (const r of [baseline, off, on]) r.store.close()
})

test('the wiring passes its internal flags to the runtime only when the bridge sets them (absent means off)', async () => {
  const { createTurnMemoryConfig } = await import('./egdesk-turn-memory-wiring.mjs')
  const base = { settings: { turnMemory: { mode: 'on' } }, getAdapter: () => ({}) }
  const plain = createTurnMemoryConfig(base)
  assert.deepEqual(['onePacket', 'writeTarget', 'confirmInConversation'].map(k => Object.hasOwn(plain, k)), [false, false, false])
  // the write target is 'about' unless 'choice' is asked for (to compare); 'about' is the default, so it is not passed
  const all = createTurnMemoryConfig({ ...base, onePacket: true, writeTarget: 'choice', confirmInConversation: true })
  assert.deepEqual([all.onePacket, all.writeTarget, all.confirmInConversation], [true, 'choice', true])
  assert.equal(Object.hasOwn(createTurnMemoryConfig({ ...base, writeTarget: 'about' }), 'writeTarget'), false)
  const odd = createTurnMemoryConfig({ ...base, onePacket: 'yes', writeTarget: 'anything', confirmInConversation: 1 })
  assert.deepEqual(['onePacket', 'writeTarget', 'confirmInConversation'].map(k => Object.hasOwn(odd, k)), [false, false, false], 'only the exact values switch anything on')
})

// ---- A3: the bridge passes the internal turn-memory options from its developer flags ----
test('the bridge builds its turn-memory config with the options of its developer flags; unset or any other value leaves the defaults', async () => {
  const { TURN_MEMORY_FLAGS, turnMemoryFlagsFromEnv } = await import('./egdesk-turn-memory-wiring.mjs')
  assert.deepEqual(TURN_MEMORY_FLAGS, { onePacket: 'EGDESK_TURN_MEMORY_ONE_PACKET', writeTarget: 'EGDESK_TURN_MEMORY_WRITE_TARGET', confirmInConversation: 'EGDESK_TURN_MEMORY_CONFIRM',
    pruneHeld: 'EGDESK_TURN_MEMORY_PRUNE_HELD', keepLate: 'EGDESK_TURN_MEMORY_KEEP_LATE', speechDesign: 'EGDESK_TURN_MEMORY_SPEECH_DESIGN', splitWording: 'EGDESK_TURN_MEMORY_SPLIT_WORDING', previousReply: 'EGDESK_TURN_MEMORY_PREVIOUS_REPLY' })
  assert.deepEqual(turnMemoryFlagsFromEnv({}), {})
  assert.deepEqual(turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_ONE_PACKET: 'on', EGDESK_TURN_MEMORY_WRITE_TARGET: 'choice', EGDESK_TURN_MEMORY_CONFIRM: 'on' }), { onePacket: true, writeTarget: 'choice', confirmInConversation: true })
  assert.deepEqual(turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_PRUNE_HELD: 'on', EGDESK_TURN_MEMORY_KEEP_LATE: 'on' }), { pruneHeld: true, keepLate: true })
  assert.deepEqual(turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_PRUNE_HELD: '1', EGDESK_TURN_MEMORY_KEEP_LATE: 'true' }), {})
  assert.deepEqual(turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_SPEECH_DESIGN: 'split' }), { speechDesign: 'split-isolated' })
  assert.deepEqual(turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_SPEECH_DESIGN: 'hybrid' }), { speechDesign: 'hybrid-two-step' }, 'Main c24: the two-request shape')
  assert.deepEqual(turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_SPLIT_WORDING: 'v2' }), { splitWording: 'v2' })
  assert.deepEqual(turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_SPLIT_WORDING: 'v1' }), {})
  assert.deepEqual(turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_PREVIOUS_REPLY: 'on' }), { previousReply: true })
  assert.deepEqual(turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_PREVIOUS_REPLY: '1' }), {})
  assert.deepEqual(turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_SPEECH_DESIGN: 'split-isolated' }), {}, 'only the exact value')
  assert.deepEqual(turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_ONE_PACKET: '1', EGDESK_TURN_MEMORY_WRITE_TARGET: 'about', EGDESK_TURN_MEMORY_CONFIRM: 'yes' }), {}, 'only the exact values; "about" is already the default')
  assert.deepEqual([turnMemoryFlagsFromEnv(null), turnMemoryFlagsFromEnv({ EGDESK_TURN_MEMORY_ONE_PACKET: true })], [{}, {}])
  // the bridge itself: exactly one turn-memory config, built with the flags of its own environment
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.equal([...source.matchAll(/createTurnMemoryConfig\(/g)].length, 1)
  assert.match(source, /const turnMemoryConfig = createTurnMemoryConfig\(\{ settings: bridgeSettings, ontologyStore: ensureOntologyStore, deskStore, \.\.\.turnMemoryFlagsFromEnv\(process\.env\),/)
  assert.match(source, /import \{[^}]*\bturnMemoryFlagsFromEnv\b[^}]*\} from '\.\/egdesk-turn-memory-wiring\.mjs'/)
})
