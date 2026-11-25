// c30/c31: the probe on a fake app-server that models what the real probe run showed (Main's pure-engine-probe-1): a server starts at thread/start unless its own entry is enabled=false (with
// startupStatus notifications, thread sessions only); mcpServerStatus/list WITHOUT a thread starts every configured server SILENTLY (no notification: only the child process shows it);
// skills/list and the thread-less server list answer from the engine's GLOBAL config, which a thread's own `config` does not change but process-level -c arguments do. Nothing starts a binary.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { ASK_PROMPT, PROBE_ARMS, PROBE_PHASES, parseProbeArgs, planProbe, readAsk, runProbe, sampleChildren } from './egdesk-pure-engine-probe.mjs'
import { configOverrideArgs, pureEngineOverrides } from './egdesk-pure-engine-config.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const SERVERS = ['notes', 'docs', 'repo-db'], SECRET = 'SECRET-MARKER-7c1d'
const argsOff = argv => { // what process-level -c arguments switch off (the shapes configOverrideArgs writes)
  const kv = argv.flatMap((a, i) => (argv[i - 1] === '-c' ? [a] : []))
  const servers = new Set(kv.map(x => x.match(/^mcp_servers\.(?:"([^"]+)"|([\w-]+))\.enabled=false$/)).filter(Boolean).map(m => m[1] ?? m[2]))
  return { servers, pluginsOff: kv.includes('plugins._default.enabled=false'), skills: new Set([...kv.filter(x => x.startsWith('skills.config=')).join(' ').matchAll(/name = "([^"]+)", enabled = false/g)].map(m => m[1])) }
}
function fakeEngine() {
  const spawns = []
  const spawn = (bin, argv, options) => {
    const stdin = new PassThrough(), stdout = new PassThrough(), child = new EventEmitter(), requests = [], running = new Set(), off = argsOff(argv)
    Object.assign(child, { pid: 5000 + spawns.length, stdin, stdout, stderr: new PassThrough() }); spawns.push({ bin, argv, options, requests, running, pid: child.pid })
    const send = m => stdout.write(`${JSON.stringify(m)}\n`), note = (name, status) => send({ method: 'mcpServer/startupStatus/updated', params: { name, status } })
    const startSilently = names => { for (const n of names) running.add(n) } // the inventory read: no notification
    const startSession = names => { for (const n of names) if (!running.has(n)) { running.add(n); note(n, 'starting'); note(n, 'ready') } }
    const threads = new Map(); let buffer = ''
    stdin.on('data', chunk => { buffer += chunk; let at; while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line.trim()) handle(JSON.parse(line)) } })
    const reply = (id, result) => send({ id, result })
    const configured = () => SERVERS.filter(n => !off.servers.has(n))
    function handle(m) {
      if (m.method === 'initialized' || m.id === undefined) return
      requests.push(m.method); const p = m.params ?? {}
      if (m.method === 'initialize') return reply(m.id, { userAgent: 'fake/0.171', codexHome: '/home/synthetic/.codex' })
      if (m.method === 'config/read') return reply(m.id, { config: {}, layers: [{ name: { type: 'user' }, version: 'v', config: { mcp_servers: Object.fromEntries(SERVERS.map(n => [n, { command: SECRET }])), plugins: { 'tools@market': { enabled: true } }, skills: { config: [] } } }] })
      if (m.method === 'skills/list') return reply(m.id, { data: [{ cwd: p.cwds?.[0] ?? '/', errors: [], skills: [
        { name: 'mine', scope: 'user', enabled: !off.skills.has('mine') }, ...(off.pluginsOff ? [] : [{ name: 'plugged', scope: 'user', pluginId: 'tools@market', enabled: true }]), { name: 'bundled', scope: 'system', enabled: true }] }] })
      if (m.method === 'mcpServerStatus/list') {
        if (!p.threadId) { startSilently(configured()); return reply(m.id, { data: configured().map(name => ({ name, tools: { t: {} }, resources: [], resourceTemplates: [] })), nextCursor: null }) }
        const t = threads.get(p.threadId)?.off ?? new Set()
        return reply(m.id, { data: configured().filter(n => !t.has(n)).map(name => ({ name, tools: {}, resources: [], resourceTemplates: [] })), nextCursor: null })
      }
      if (m.method === 'thread/start') {
        const t = new Set(Object.entries(p.config?.mcp_servers ?? {}).filter(([, v]) => v.enabled === false).map(([k]) => k)), id = `thr-${threads.size + 1}`; threads.set(id, { off: t, config: p.config ?? {} })
        startSession(configured().filter(n => !t.has(n)))
        return reply(m.id, { thread: { id, ephemeral: true }, model: 'fake', instructionSources: p.config?.project_doc_max_bytes === 0 ? ['/home/synthetic/.codex/AGENTS.md'] : ['/home/synthetic/.codex/AGENTS.md', `${p.cwd}/AGENTS.md`] })
      }
      if (m.method === 'experimentalFeature/list') return reply(m.id, { data: [{ name: 'apps', enabled: !(threads.get(p.threadId)?.config.features?.apps === false) }, { name: 'hooks', enabled: !(threads.get(p.threadId)?.config.features?.hooks === false) }], nextCursor: null })
      if (m.method === 'hooks/list') return reply(m.id, { data: [{ cwd: '/', hooks: threads.get(p.threadId)?.config.features?.hooks === false ? [] : [{ key: 'h' }], warnings: [], errors: [] }] })
      if (m.method === 'turn/start') {
        reply(m.id, { turn: { id: 't1', status: 'inProgress', items: [] } })
        const reported = threads.get(p.threadId)?.config.skills?.include_instructions === false ? 'NONE' : 'mine, bundled'
        setImmediate(() => { send({ method: 'item/completed', params: { threadId: p.threadId, item: { type: 'agentMessage', phase: 'final_answer', text: `${reported}\nYES\nNONE` } } }); send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: 't1', status: 'completed' } } }) })
        return
      }
      reply(m.id, {})
    }
    return child
  }
  return { spawn, spawns, children: pid => { const s = spawns.find(x => x.pid === pid); return { total: s ? s.running.size : null, byName: { node: s ? s.running.size : 0 } } } }
}
const world = t => { const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-probe-')); t.after(() => fs.rmSync(base, { recursive: true, force: true })); return base }
const options = (out, extra = {}) => ({ mode: 'run', codexBin: '/fake/codex', home: { kind: 'person', dir: null }, out, arms: [...PROBE_ARMS], ask: false, names: false, model: null, effort: null, appServerConfig: [], ...extra })
const deps = fake => ({ spawn: fake.spawn, killGroup: async () => ({}), env: { PATH: '/usr/bin', HOME: '/home/synthetic' }, settleMs: 5, threadSettleMs: 20, readbackSettleMs: 5, askTimeoutMs: 3000, children: fake.children, buildLaunch: () => ({ args: ['app-server', '--listen', 'stdio://'] }) })

test('the probe separates what a thread session does from what the inventory read does: events are thread-only, the child processes show the silent starts, the global listings answer from the global config', async t => {
  const out = world(t), fake = fakeEngine()
  const result = await runProbe(options(out), deps(fake)), by = Object.fromEntries(result.summary.map(r => [r.arm, r])), rec = Object.fromEntries(result.records.map(r => [r.arm, r]))
  assert.equal(result.records.every(r => r.ok), true, JSON.stringify(result.records.map(r => r.error))); assert.deepEqual(PROBE_PHASES, ['loader', 'thread', 'readback', 'global'])
  // events: baseline starts its servers at thread start; every other arm shows none (notifications exist only for thread sessions)
  assert.deepEqual([rec.baseline.phases.loader.events.starting, rec.baseline.phases.thread.events.starting], [0, 3])
  for (const arm of ['current', 'names', 'candidates', 'process']) assert.equal(by[arm].startupEvents, 0, arm)
  // children: the c23 inventory read starts the servers SILENTLY (0 events, 3 child processes after the loader, 1.4 s in the real run); names and process start nothing to learn names
  assert.deepEqual([rec.current.phases.loader.children.total, rec.current.phases.thread.children.total], [3, 3], 'the person\'s servers are running before the thread exists')
  assert.deepEqual([rec.names.phases.loader.children.total, rec.names.phases.thread.children.total, rec.names.phases.readback.children.total], [0, 0, 0]); assert.equal(rec.candidates.phases.thread.children.total, 0)
  assert.equal(rec.baseline.phases.thread.children.total, 3)
  // global listings: a thread's own config does not change them (names still lists 3 servers and the plugin's skill; the thread-less list even starts them: child processes in `global`) ...
  assert.deepEqual([by.names.global.servers, by.names.global.withTools, by.names.skills], [3, 3, { user: 2, system: 1 }]); assert.equal(rec.names.phases.global.children.total, 3, 'listing the global servers starts them')
  assert.deepEqual([by.baseline.global.servers, by.baseline.skills], [3, { user: 2, system: 1 }])
  // ... process-level -c arguments do: no server, the plugin's skills gone, the user's own skill listed as disabled, nothing started
  assert.deepEqual([by.process.global.servers, by.process.skills, by.process.global.skillsDisabled], [0, { system: 1 }, 1]); assert.equal(rec.process.phases.global.children.total, 0)
  assert.equal(rec.process.report.processArgs > 10, true); assert.deepEqual([rec.process.report.mcpServers, rec.process.report.plugins, rec.process.report.skills], [3, 1, 1])
  // thread read-back, as before
  assert.equal(by.baseline.hooks, 1); assert.equal(by.names.hooks, 0); assert.equal(by.names.featuresNotOff, 0); assert.ok(by.baseline.featuresNotOff > 0); assert.deepEqual(by.names.instructionSources, { total: 1, outside: 1 }); assert.deepEqual(by.baseline.instructionSources, { total: 2, outside: 1 })
  assert.equal(rec.current.mcp, 'disabled_by_name'); assert.equal(rec.names.mcp, 'disabled_by_name')
  // the process arm read the names with a short-lived process first, which asked nothing that starts a server
  const prepass = fake.spawns.find(s => s.argv.every(a => a !== '-c')); const preRequests = fake.spawns.slice(0, 5).filter(s => !s.argv.includes('-c')).map(s => s.requests)
  assert.ok(preRequests.some(r => r.includes('config/read') && !r.includes('mcpServerStatus/list') && !r.includes('thread/start')), 'a pre-pass that only reads names'); void prepass
  assert.equal(fake.spawns.length, 6, 'one process per arm and one short pre-pass for the process arm'); assert.ok(fake.spawns.every(s => s.argv.includes('app-server') && !s.argv.includes('--listen')))
  const text = fs.readFileSync(path.join(out, 'pure-engine-probe.json'), 'utf8')
  for (const forbidden of [SECRET, ...SERVERS, 'tools@market']) assert.equal(text.includes(forbidden), false, `${forbidden} is not recorded`)
  assert.equal(fake.spawns.some(s => s.argv.join(' ').includes(SECRET)), false, 'no config value reaches an argument')
})

test('--names records the server names that started (only then); --ask records what the model says it was told, as counts, and never its text', async t => {
  const out = world(t), fake = fakeEngine()
  const result = await runProbe(options(out, { arms: ['baseline', 'names'], names: true, ask: true }), deps(fake))
  assert.deepEqual(result.records[0].phases.thread.serverNames, [...SERVERS].sort()); assert.equal(result.records[1].phases.thread.serverNames.length, 0)
  assert.deepEqual(result.records[0].ask, { skillsNamed: 2, agentsMd: 'yes', serversOrPluginsNamed: 0, lines: 3 }); assert.deepEqual(result.records[1].ask, { skillsNamed: 0, agentsMd: 'yes', serversOrPluginsNamed: 0, lines: 3 })
  assert.equal(JSON.stringify(result).includes('mine, bundled'), false, 'the model\'s text is dropped')
  assert.ok(fake.spawns.every(s => s.requests.filter(m => m === 'turn/start').length <= 1))
  const quiet = await runProbe(options(world(t), { arms: ['names'] }), deps(fakeEngine())); assert.equal(quiet.records[0].ask, undefined); assert.equal(quiet.records[0].phases.thread.serverNames, undefined)
})

test('configOverrideArgs: every leaf is a `path=TOML value` argument, odd keys quoted, arrays inline; only our keys and names; the process sampler reads executable base names and counts only', () => {
  const { config } = pureEngineOverrides({ mcpServers: ['my-notes', 'docs.site'], plugins: ['tools@market'], skills: [{ name: 'mine', scope: 'user' }] })
  const kv = configOverrideArgs(config)
  for (const expected of ['features.apps=false', 'features.code_mode.enabled=false', 'plugins._default.enabled=false', 'plugins."tools@market".enabled=false', 'mcp_servers.my-notes.enabled=false', 'mcp_servers."docs.site".enabled=false', 'project_doc_max_bytes=0', 'skills.config=[{ name = "mine", enabled = false }]', 'skills.bundled.enabled=false', 'memories.use_memories=false']) assert.ok(kv.includes(expected), expected)
  assert.ok(kv.every(x => /^[\w."@-]+=/.test(x))); assert.deepEqual(configOverrideArgs({ b: [], c: 'x"y' }), ['b=[]', 'c="x\\"y"'])
  const ps = 'PID PPID COMM\n10 1 /usr/bin/codex\n11 10 /opt/node/bin/node\n12 11 /usr/bin/python3\n13 1 /bin/zsh\n14 10 /bin/sh\n'
  const rows = sampleChildren(10, { run: () => ps.split('\n').slice(1).join('\n') }); assert.deepEqual(rows, { total: 3, byName: { node: 1, python3: 1, sh: 1 } }); assert.deepEqual(sampleChildren(10, { run: () => { throw new Error('no ps') } }), { total: null, byName: {} })
})

test('readAsk, planProbe and the arguments: counts only, a plan that says what runs, absolute paths and known arms only', () => {
  assert.deepEqual(readAsk('mine, other\nNO\nnotes'), { skillsNamed: 2, agentsMd: 'no', serversOrPluginsNamed: 1, lines: 3 }); assert.deepEqual(readAsk('Skills: NONE\nAGENTS.md: YES\nPlugins: NONE'), { skillsNamed: 0, agentsMd: 'yes', serversOrPluginsNamed: 0, lines: 3 })
  assert.deepEqual(readAsk(''), { skillsNamed: null, agentsMd: 'unparsed', serversOrPluginsNamed: null, lines: 0 }); assert.match(ASK_PROMPT, /without using any tool/)
  const plan = planProbe(options('/o', { arms: ['names', 'current'], ask: true })); assert.deepEqual([plan.processes, plan.modelCalls], [2, 2]); assert.equal(planProbe(options('/o')).modelCalls, 0); assert.equal(planProbe(options('/o', { arms: ['process'] })).processes, 2, 'the process arm adds a short pre-pass')
  assert.deepEqual(parseProbeArgs(['--codex-bin', '/a/codex', '--out', '/o']).problems, []); const bad = parseProbeArgs(['--codex-bin', 'codex', '--out', 'o', '--arms', 'x', '--nope']).problems.join('\n')
  for (const part of ['absolute path', 'unknown arm x', 'unknown option --nope']) assert.match(bad, new RegExp(part))
  assert.equal(parseProbeArgs(['--codex-bin', '/a/codex', '--out', '/o', '--codex-home', '/h', '--arms', 'names,process', '--ask', '--names', '--run']).options.mode, 'run')
})
