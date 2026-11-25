// c30: what the person's own Codex setup does to an EG-Desk thread, measured on the REAL engine with and without the override sets (Main runs it; it never runs a Codex binary here).
// One fresh app-server process per arm; no model call unless --ask (one tiny turn per arm, counts only). Arms:
//   baseline   a plain ephemeral thread/start: what a client that sets nothing gets
//   current    the c23 isolation: names from mcpServerStatus/list (which STARTS every configured server) + the feature and skills switches
//   names      the c30 set from config/read + skills/list (nothing is started to read names): plugins default off, per-name MCP/plugin/skill entries, project_doc_max_bytes 0, switches
//   candidates names + the UnderDevelopment feature switches (skip_host_skill_discovery, mcp_lazy_stdio_startup)
//   process    the names set as PROCESS-level -c arguments (the inventory is read first by a short-lived process, which starts nothing): the engine's GLOBAL listings answer under it
// Phase `global` (after the thread phases): mcpServerStatus/list and skills/list WITHOUT a thread, i.e. what the engine's global config says; skills/list takes no thread, so it never shows what a thread's
// own `config` does (c31: Main's 88 user skills under names were this global list, not what the thread was told; --ask measures that). Every phase also samples the app-server's child processes
// (count and executable names only): the startupStatus notifications are only sent for thread sessions, a server started by the inventory read (mcpServerStatus/list) shows here, not there.
// Per arm and PHASE (loader = computing the overrides, thread = thread/start + 3 s, readback = the read-back calls + 1.5 s): MCP startup events counted by status and distinct server,
// plus (readback) servers listed / with tools, features not off, hooks, instruction sources (total, outside the engine folder), skills the engine reports per scope; with --ask the
// model's own report of what it was told (skills named, AGENTS.md yes/no, servers or plugins named) as COUNTS. Names of the person's servers are never recorded unless --names;
// no config value is ever read out of the config/read answer (only table keys, in egdesk-pure-engine-config.mjs).
import fs from 'node:fs'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { AppServerRpc } from './codex-app-server-rpc.mjs'
import { buildCodexAppServerLaunch } from './egdesk-native-capabilities.mjs'
import { loadOwnToolsIsolation, readOwnToolsIsolation } from './egdesk-own-tools-isolation.mjs'
import { configOverrideArgs, pureEngineOverrides, readPureInventory } from './egdesk-pure-engine-config.mjs'
import { listNativeMcpServers } from './codex-chat-execution-policy.mjs'
import { execFileSync } from 'node:child_process'
import { pureEngineThreadOverrides } from './egdesk-command-executor.mjs'
import { mergeCeilingOverrides } from './codex-chat-tool-ceiling.mjs'
import { appServerArgs, childEnv, createGroupKiller } from './egdesk-real-engine-check.mjs'

export const PROBE_ARMS = Object.freeze(['baseline', 'current', 'names', 'candidates', 'process'])
export const PROBE_PHASES = Object.freeze(['loader', 'thread', 'readback', 'global'])
export const PROBE_LIMITS = Object.freeze({ threadSettleMs: 3000, readbackSettleMs: 1500, askTimeoutMs: 90_000, requestTimeoutMs: 60_000 })
export const ASK_PROMPT = 'Answer only from what you were told in this session, without using any tool. Line 1: the exact names of the skills you were told about, comma separated, or NONE. Line 2: AGENTS.md instructions received: YES or NO. Line 3: the names of any MCP servers or plugins you were told about, comma separated, or NONE.'
/** The app-server's descendants by `ps` (executable base names and a count; never arguments): where a configured MCP server runs as a child process it shows here. */
export function sampleChildren(pid, { run = execFileSync } = {}) {
  try {
    const rows = String(run('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 3000 })).split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean).map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), name: path.basename(m[3]) }))
    const kids = new Set([pid]), found = []
    for (let round = 0; round < 8; round++) for (const r of rows) if (kids.has(r.ppid) && !kids.has(r.pid)) { kids.add(r.pid); found.push(r) }
    const byName = {}; for (const r of found) byName[r.name] = (byName[r.name] ?? 0) + 1
    return { total: found.length, byName }
  } catch { return { total: null, byName: {} } }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const clip = (v, n) => String(v ?? '').slice(0, n)

/** The model's three-line answer as counts (the text itself is dropped here). */
export function readAsk(text) {
  const lines = String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean)
  const count = line => { const t = String(line ?? '').replace(/^[^:：]*[:：]\s*/, ''); return !t || /^none\b/i.test(t) ? 0 : t.split(',').map(x => x.trim()).filter(Boolean).length }
  const yn = String(lines[1] ?? '').match(/\b(YES|NO)\b/i)
  return { skillsNamed: lines.length ? count(lines[0]) : null, agentsMd: yn ? yn[1].toLowerCase() : 'unparsed', serversOrPluginsNamed: lines.length > 2 ? count(lines[2]) : null, lines: lines.length }
}

export function planProbe(options) {
  return { arms: options.arms, ask: options.ask === true, names: options.names === true, processes: options.arms.length + (options.arms.includes('process') ? 1 : 0), modelCalls: options.ask ? options.arms.length : 0, phases: PROBE_PHASES,
    rules: ['one fresh app-server per arm', 'ephemeral threads only (never saved)', 'no model call without --ask', 'config values are never read out: table keys only', options.names ? 'server names recorded (--names)' : 'server names are NOT recorded'] }
}

/** One short-lived app-server that only reads names (config/read, skills/list): nothing is started to learn them. */
async function readInventoryOnce(options, deps, folder) {
  const spawn = deps.spawn ?? nodeSpawn, killGroup = deps.killGroup ?? createGroupKiller(), env = deps.env ?? process.env
  const child = spawn(options.codexBin, appServerArgs(options, deps.buildLaunch ?? buildCodexAppServerLaunch), { cwd: options.out, env: childEnv(options, env), shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  const rpc = new AppServerRpc({ send: payload => child.stdin.write(`${payload}\n`), experimentalApi: true, timeoutMs: PROBE_LIMITS.requestTimeoutMs, onNotification: () => {}, onRequest: () => {} })
  child.on('close', () => { try { rpc.close(Object.assign(new Error('the Codex app-server exited'), { code: 'engine_exited' })) } catch { /* closed */ } }); child.on('error', () => {}); child.stderr?.on('data', () => {})
  child.stdout?.on('data', chunk => { buffer += chunk; let at; while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line.trim()) { try { rpc.receive(line) } catch { /* not json */ } } } })
  try { await rpc.initialize(); return await readPureInventory((method, params) => rpc.request(method, params), folder) } finally { try { rpc.close() } catch { /* closed */ } await killGroup(child) }
}

async function runArm(arm, options, deps) {
  const spawn = deps.spawn ?? nodeSpawn, killGroup = deps.killGroup ?? createGroupKiller(), env = deps.env ?? process.env
  const folder = path.join(options.out, 'engine-folder', arm); fs.mkdirSync(folder, { recursive: true })
  const rec = { arm, ok: false, phases: Object.fromEntries(PROBE_PHASES.map(p => [p, { events: { starting: 0, ready: 0, failed: 0, other: 0 }, servers: 0 }])), startedMs: {}, error: null }
  const seen = Object.fromEntries(PROBE_PHASES.map(p => [p, new Set()]))
  let phase = 'loader', buffer = '', init = null
  let argOptions = options
  if (arm === 'process') {
    // the names come from a short-lived process that only reads files (config/read, skills/list): nothing is started to learn them
    const inv = await readInventoryOnce(options, deps, folder)
    const kv = configOverrideArgs(pureEngineOverrides(inv, { tier: 'names' }).config)
    argOptions = { ...options, appServerConfig: [...(options.appServerConfig ?? []), ...kv] }
    rec.report = { tier: 'names', processArgs: kv.length, mcpServers: inv.mcpServers?.length ?? null, plugins: inv.plugins?.length ?? null, skills: inv.skills?.length ?? null }
  }
  const child = spawn(options.codexBin, appServerArgs(argOptions, deps.buildLaunch ?? buildCodexAppServerLaunch), { cwd: options.out, env: childEnv(options, env), shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const texts = []
  const rpc = new AppServerRpc({ send: payload => child.stdin.write(`${payload}\n`), experimentalApi: true, timeoutMs: PROBE_LIMITS.requestTimeoutMs, onRequest: () => {},
    onNotification: m => {
      const p = m.params ?? {}
      if (m.method === 'mcpServer/startupStatus/updated') {
        const k = ['starting', 'ready', 'failed'].includes(p.status) ? p.status : 'other'; rec.phases[phase].events[k]++
        if (typeof p.name === 'string') seen[phase].add(p.name)
      } else if (m.method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.phase === 'final_answer') texts.push(String(p.item.text ?? ''))
      else if (m.method === 'turn/completed') rec._turnDone = p.turn?.status ?? 'completed'
    } })
  child.on('close', () => { try { rpc.close(Object.assign(new Error('the Codex app-server exited'), { code: 'engine_exited' })) } catch { /* closed */ } })
  child.on('error', () => {})
  child.stderr?.on('data', () => {})
  child.stdout?.on('data', chunk => { buffer += chunk; let at; while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (!line.trim()) continue; try { const m = JSON.parse(line); if (m.id === 1 && m.result) init = m.result; rpc.receive(line) } catch { /* not json */ } } })
  const request = (method, params) => rpc.request(method, params)
  const sample = p => { rec.phases[p].children = (deps.children ?? sampleChildren)(child.pid) }
  try {
    await rpc.initialize()
    // loader: computing the overrides (the c23 inventory starts servers here; the pure set does not)
    let overrides = {}, loaderMs = null
    if (arm === 'process') overrides = mergeCeilingOverrides({}, pureEngineThreadOverrides())
    else if (arm !== 'baseline') {
      const t = performance.now()
      const iso = await loadOwnToolsIsolation(request, folder, arm === 'current' ? {} : { pure: arm })
      loaderMs = Math.round(performance.now() - t); rec.mcp = iso.mcp; rec.report = iso.pure ?? null
      overrides = mergeCeilingOverrides(mergeCeilingOverrides({}, pureEngineThreadOverrides()), iso.overrides)
    }
    rec.startedMs.loader = loaderMs
    await sleep(deps.settleMs ?? 500)
    sample('loader')
    phase = 'thread'
    const t1 = performance.now()
    const started = await request('thread/start', { ephemeral: true, cwd: folder, ...overrides, ...(options.model ? { model: options.model } : {}) })
    rec.startedMs.thread = Math.round(performance.now() - t1)
    const threadId = started?.thread?.id
    await sleep(deps.threadSettleMs ?? PROBE_LIMITS.threadSettleMs)
    sample('thread')
    phase = 'readback'
    rec.readback = await readOwnToolsIsolation(request, { threadId, startResult: started, folders: [folder] })
    await sleep(deps.readbackSettleMs ?? PROBE_LIMITS.readbackSettleMs)
    sample('readback')
    // global listings (no thread): what the engine's global config says; started servers of the inventory read show in this phase's events and children
    phase = 'global'
    rec.global = {}
    try { const servers = await listNativeMcpServers(request, null, { detail: 'toolsAndAuthOnly' }); rec.global.servers = servers.length; rec.global.withTools = servers.filter(x => Object.keys(x.tools).length > 0).length } catch { rec.global.servers = 'unreadable' }
    try { const sk = await request('skills/list', { cwds: [folder], forceReload: false }); const by = {}; let off = 0; for (const e of sk?.data ?? []) for (const x of e.skills ?? []) { if (x.enabled === false) { off++; continue } const k = typeof x.scope === 'string' ? x.scope : 'unknown'; by[k] = (by[k] ?? 0) + 1 }; rec.skillsListed = by; rec.global.skillsDisabled = off } catch { rec.skillsListed = 'unreadable' }
    await sleep(deps.readbackSettleMs ?? PROBE_LIMITS.readbackSettleMs)
    sample('global')
    if (options.ask && threadId) {
      const turn = await request('turn/start', { threadId, input: [{ type: 'text', text: ASK_PROMPT, text_elements: [] }], ...(options.effort ? { effort: options.effort } : {}) })
      void turn
      const end = performance.now() + (deps.askTimeoutMs ?? PROBE_LIMITS.askTimeoutMs)
      while (!rec._turnDone && performance.now() < end) await sleep(25)
      rec.ask = rec._turnDone ? readAsk(texts.join('\n')) : { timeout: true }
    }
    for (const p of PROBE_PHASES) { rec.phases[p].servers = seen[p].size; if (options.names) rec.phases[p].serverNames = [...seen[p]].sort().slice(0, 50) }
    rec.initialize = { codexHome: typeof init?.codexHome === 'string' ? 'reported' : 'unreported' }
    rec.ok = true
  } catch (error) { rec.error = clip(error?.code ?? error?.message ?? 'error', 120) }
  finally { delete rec._turnDone; try { rpc.close() } catch { /* closed */ } await killGroup(child) }
  return rec
}

export async function runProbe(options, deps = {}) {
  fs.mkdirSync(options.out, { recursive: true })
  const records = []
  for (const arm of options.arms) records.push(await runArm(arm, options, deps))
  const startupTotal = r => PROBE_PHASES.reduce((n, p) => n + r.phases[p].events.starting + r.phases[p].events.ready + r.phases[p].events.failed + r.phases[p].events.other, 0)
  const summary = records.map(r => ({ arm: r.arm, ok: r.ok, startupEvents: startupTotal(r), servers: Math.max(...PROBE_PHASES.map(p => r.phases[p].servers)), byPhase: Object.fromEntries(PROBE_PHASES.map(p => [p, r.phases[p].servers])),
    mcpWithTools: r.readback?.mcpServersWithTools ?? null, featuresNotOff: Array.isArray(r.readback?.featuresNotOff) ? r.readback.featuresNotOff.length : r.readback?.featuresNotOff ?? null, hooks: r.readback?.hooks ?? null,
    instructionSources: r.readback?.instructionSources ?? null, skills: r.skillsListed ?? null, global: r.global ?? null, children: Object.fromEntries(PROBE_PHASES.map(p => [p, r.phases[p].children?.total ?? null])), ask: r.ask ?? null, error: r.error }))
  const out = { arms: options.arms, records, summary }
  fs.writeFileSync(path.join(options.out, 'pure-engine-probe.json'), `${JSON.stringify(out, null, 2)}\n`)
  return out
}

export function parseProbeArgs(argv, env = {}) {
  const o = { mode: 'dry', codexBin: null, home: { kind: 'person', dir: null }, out: null, arms: [...PROBE_ARMS], ask: false, names: false, model: null, effort: null, appServerConfig: [] }, problems = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i]
    if (a === '--run') o.mode = 'run'
    else if (a === '--codex-bin') o.codexBin = next()
    else if (a === '--person-home') o.home = { kind: 'person', dir: null }
    else if (a === '--codex-home') o.home = { kind: 'dir', dir: next() }
    else if (a === '--out') o.out = next()
    else if (a === '--arms') o.arms = String(next() ?? '').split(',').filter(Boolean)
    else if (a === '--ask') o.ask = true
    else if (a === '--names') o.names = true
    else if (a === '--model') o.model = next()
    else if (a === '--effort') o.effort = next()
    else problems.push(`unknown option ${a}`)
  }
  if (!o.codexBin || !path.isAbsolute(o.codexBin)) problems.push('--codex-bin must be an absolute path')
  if (!o.out || !path.isAbsolute(o.out)) problems.push('--out must be an absolute path')
  if (o.home.kind === 'dir' && !path.isAbsolute(o.home.dir ?? '')) problems.push('--codex-home must be an absolute path')
  for (const arm of o.arms) if (!PROBE_ARMS.includes(arm)) problems.push(`unknown arm ${arm}`)
  if (!o.arms.length) problems.push('--arms needs at least one arm')
  void env
  return { options: o, problems }
}
