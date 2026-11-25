// c30: the probe on a fake app-server that models the hypothesis (a server starts at thread/start unless its own entry is enabled=false; mcpServerStatus/list without a thread starts
// every configured server). The real engine decides whether that hypothesis is true: that is what Main's run measures. Nothing here starts a binary.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { ASK_PROMPT, PROBE_ARMS, parseProbeArgs, planProbe, readAsk, runProbe } from './egdesk-pure-engine-probe.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const SERVERS = ['notes', 'docs', 'repo-db'], SECRET = 'SECRET-MARKER-7c1d'
function fakeEngine({ lazy = false } = {}) {
  const spawns = []
  const spawn = (bin, argv, options) => {
    const stdin = new PassThrough(), stdout = new PassThrough(), child = new EventEmitter(), requests = []
    Object.assign(child, { pid: 5000 + spawns.length, stdin, stdout, stderr: new PassThrough() }); spawns.push({ bin, argv, options, requests })
    const started = new Set(), send = m => stdout.write(`${JSON.stringify(m)}\n`)
    const note = (name, status) => send({ method: 'mcpServer/startupStatus/updated', params: { name, status } })
    const startAll = names => { for (const name of names) if (!started.has(name)) { started.add(name); note(name, 'starting'); note(name, 'ready') } }
    let buffer = ''
    stdin.on('data', chunk => { buffer += chunk; let at; while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line.trim()) handle(JSON.parse(line)) } })
    const reply = (id, result) => send({ id, result })
    function handle(m) {
      if (m.method === 'initialized' || m.id === undefined) return
      requests.push(m.method)
      const p = m.params ?? {}
      if (m.method === 'initialize') return reply(m.id, { userAgent: 'fake/0.171', codexHome: '/home/synthetic/.codex' })
      if (m.method === 'config/read') return reply(m.id, { config: {}, layers: [{ name: { type: 'user' }, version: 'v', config: { mcp_servers: Object.fromEntries(SERVERS.map(n => [n, { command: SECRET }])), plugins: { 'tools@market': { enabled: true } } } }] })
      if (m.method === 'skills/list') return reply(m.id, { data: [{ cwd: p.cwds?.[0] ?? '/', errors: [], skills: [{ name: 'mine', scope: 'user' }, { name: 'bundled', scope: 'system' }] }] })
      if (m.method === 'mcpServerStatus/list') {
        if (!p.threadId) { startAll(SERVERS); return reply(m.id, { data: SERVERS.map(name => ({ name, tools: { t: {} }, resources: [], resourceTemplates: [] })), nextCursor: null }) }
        const off = threads.get(p.threadId)?.off ?? new Set()
        return reply(m.id, { data: SERVERS.filter(n => !off.has(n)).map(name => ({ name, tools: {}, resources: [], resourceTemplates: [] })), nextCursor: null })
      }
      if (m.method === 'thread/start') {
        const off = new Set(Object.entries(p.config?.mcp_servers ?? {}).filter(([, v]) => v.enabled === false).map(([k]) => k))
        const id = `thr-${threads.size + 1}`; threads.set(id, { off, config: p.config ?? {} })
        if (!lazy) startAll(SERVERS.filter(n => !off.has(n)))
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
    const threads = new Map()
    return child
  }
  return { spawn, spawns }
}
const world = t => { const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-probe-')); t.after(() => fs.rmSync(base, { recursive: true, force: true })); return base }
const options = (out, extra = {}) => ({ mode: 'run', codexBin: '/fake/codex', home: { kind: 'person', dir: null }, out, arms: [...PROBE_ARMS], ask: false, names: false, model: null, effort: null, appServerConfig: [], ...extra })
const deps = fake => ({ spawn: fake.spawn, killGroup: async () => ({}), env: { PATH: '/usr/bin', HOME: '/home/synthetic' }, settleMs: 5, threadSettleMs: 20, readbackSettleMs: 5, askTimeoutMs: 3000, buildLaunch: () => ({ args: ['app-server', '--listen', 'stdio://'] }) })

test('the probe shows where the person\'s servers start: baseline at thread/start, current already while the inventory is read, names and candidates never', async t => {
  const out = world(t), fake = fakeEngine()
  const result = await runProbe(options(out), deps(fake)), by = Object.fromEntries(result.summary.map(r => [r.arm, r]))
  const rec = Object.fromEntries(result.records.map(r => [r.arm, r]))
  assert.equal(result.records.every(r => r.ok), true, JSON.stringify(result.records.map(r => r.error)))
  assert.deepEqual([rec.baseline.phases.loader.events.starting, rec.baseline.phases.thread.events.starting], [0, 3], 'a plain thread starts every configured server')
  assert.deepEqual([rec.current.phases.loader.events.starting, rec.current.phases.thread.events.starting], [3, 0], 'the c23 inventory starts them BEFORE the thread, the per-name entries then keep the thread clear')
  assert.deepEqual([rec.names.phases.loader.events.starting, rec.names.phases.thread.events.starting, rec.names.phases.readback.events.starting], [0, 0, 0]); assert.equal(by.names.startupEvents, 0); assert.equal(by.candidates.startupEvents, 0)
  assert.equal(by.baseline.startupEvents, 6); assert.equal(by.current.startupEvents, 6); assert.equal(by.names.servers, 0)
  assert.equal(by.names.mcpWithTools, 0); assert.equal(by.baseline.hooks, 1); assert.equal(by.names.hooks, 0); assert.equal(by.names.featuresNotOff, 0); assert.ok(by.baseline.featuresNotOff > 0)
  assert.deepEqual(by.names.instructionSources, { total: 1, outside: 1 }, 'project documents are gone, the person\'s global file is still there: reported, not hidden')
  assert.deepEqual(by.baseline.instructionSources, { total: 2, outside: 1 })
  assert.equal(rec.names.report.mcpServers, 3); assert.equal(rec.names.mcp, 'disabled_by_name'); assert.deepEqual(by.names.skills, { user: 1, system: 1 }, 'skills/list is global: what the engine reports, not what the thread is told')
  // no server is started to read names: the names arm's process never saw mcpServerStatus/list before the thread existed
  const namesRequests = fake.spawns[2].requests; assert.equal(namesRequests.indexOf('mcpServerStatus/list') > namesRequests.indexOf('thread/start'), true)
  assert.equal(fake.spawns.length, 4, 'one fresh process per arm'); assert.ok(fake.spawns.every(s => s.argv.includes('app-server') && !s.argv.includes('--listen')))
  const text = fs.readFileSync(path.join(out, 'pure-engine-probe.json'), 'utf8')
  for (const forbidden of [SECRET, ...SERVERS, 'tools@market']) assert.equal(text.includes(forbidden), false, `${forbidden} is not recorded`)
})

test('--names records the server names that started (only then); --ask records what the model says it was told, as counts, and never its text', async t => {
  const out = world(t), fake = fakeEngine()
  const result = await runProbe(options(out, { arms: ['baseline', 'names'], names: true, ask: true }), deps(fake))
  assert.deepEqual(result.records[0].phases.thread.serverNames, [...SERVERS].sort()); assert.equal(result.records[1].phases.thread.serverNames.length, 0)
  assert.deepEqual(result.records[0].ask, { skillsNamed: 2, agentsMd: 'yes', serversOrPluginsNamed: 0, lines: 3 }); assert.deepEqual(result.records[1].ask, { skillsNamed: 0, agentsMd: 'yes', serversOrPluginsNamed: 0, lines: 3 })
  assert.equal(JSON.stringify(result).includes('mine, bundled'), false, 'the model\'s text is dropped')
  assert.ok(fake.spawns.every(s => s.requests.filter(m => m === 'turn/start').length === 1))
  const quiet = await runProbe(options(world(t), { arms: ['names'] }), deps(fakeEngine())); assert.equal(quiet.records[0].ask, undefined); assert.equal(quiet.records[0].phases.thread.serverNames, undefined)
})

test('readAsk, planProbe and the arguments: counts only, a plan that says what runs, absolute paths and known arms only', () => {
  assert.deepEqual(readAsk('mine, other\nNO\nnotes'), { skillsNamed: 2, agentsMd: 'no', serversOrPluginsNamed: 1, lines: 3 }); assert.deepEqual(readAsk('Skills: NONE\nAGENTS.md: YES\nPlugins: NONE'), { skillsNamed: 0, agentsMd: 'yes', serversOrPluginsNamed: 0, lines: 3 })
  assert.deepEqual(readAsk(''), { skillsNamed: null, agentsMd: 'unparsed', serversOrPluginsNamed: null, lines: 0 }); assert.match(ASK_PROMPT, /without using any tool/)
  const plan = planProbe(options('/o', { arms: ['names', 'current'], ask: true })); assert.deepEqual([plan.processes, plan.modelCalls], [2, 2]); assert.equal(planProbe(options('/o')).modelCalls, 0)
  assert.deepEqual(parseProbeArgs(['--codex-bin', '/a/codex', '--out', '/o']).problems, []); const bad = parseProbeArgs(['--codex-bin', 'codex', '--out', 'o', '--arms', 'x', '--nope']).problems.join('\n')
  for (const part of ['absolute path', 'unknown arm x', 'unknown option --nope']) assert.match(bad, new RegExp(part))
  assert.equal(parseProbeArgs(['--codex-bin', '/a/codex', '--out', '/o', '--codex-home', '/h', '--arms', 'names,candidates', '--ask', '--names', '--run']).options.mode, 'run')
})
