import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import {
  CLAUDE_API_KEY_ENV_NAMES, CLAUDE_FLAG_SOURCES, CLAUDE_ISOLATION_ENV, CLAUDE_TRANSPORT_MIN_VERSION,
  activeClaudeChildCount, buildClaudeArgs, buildClaudeEnv, checkClaudeVersion, claudeArgFlags,
  compareVersions, createClaudeTransport, createLineFramer, detectApiKeyEnv, isWindowsBatchPath,
  managedMcpConfigPath, parseClaudeVersion, reapClaudeChildren,
} from './claude-engine-transport.mjs'

const EXE = '/Users/test/.local/bin/claude'
const CWD = '/Users/test/project'
const BASE_ENV = Object.freeze({ HOME: '/Users/test', PATH: '/usr/bin:/bin', USER: 'test', LANG: 'ko_KR.UTF-8', TMPDIR: '/tmp/x' })
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e'

function until(predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting'))
      setTimeout(tick, 2)
    }
    tick()
  })
}

// A fake `claude`: stdin lines are parsed into child.written, stdout is ours to write.
function fakeChild({ pid = 4242, exitOnStdinEnd = true, exitOn = ['SIGTERM', 'SIGKILL'], autoInitialize = true } = {}) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.signals = []
  child.written = []
  child.exited = false
  let buffer = ''
  child.stdin.setEncoding('utf8')
  child.stdin.on('data', data => {
    buffer += data
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      child.written.push(message)
      if (autoInitialize && message.type === 'control_request' && message.request.subtype === 'initialize') {
        child.send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { commands: [] } } })
      }
    }
  })
  child.stdin.on('end', () => { child.stdinEnded = true; if (exitOnStdinEnd) child.exit(0, null) })
  child.kill = signal => { child.signals.push(signal); if (exitOn.includes(signal)) child.exit(null, signal); return true }
  child.exit = (code, signal) => {
    if (child.exited) return
    child.exited = true
    child.stdout.end()
    child.stderr.end()
    setImmediate(() => { child.emit('exit', code, signal); setImmediate(() => child.emit('close', code, signal)) })
  }
  child.send = message => child.stdout.write(JSON.stringify(message) + '\n')
  return child
}

function harness({ child = fakeChild(), version = '2.1.300 (Claude Code)', env = BASE_ENV, ...options } = {}) {
  const spawnCalls = []
  const execCalls = []
  const events = { messages: [], notices: [], cancels: [], exits: [], stderr: [] }
  const transport = createClaudeTransport({
    executablePath: EXE, cwd: CWD, env, platform: 'darwin', managedMcpConfig: false,
    spawnImpl: (file, args, opts) => {
      spawnCalls.push({ file, args, opts })
      process.nextTick(() => child.emit('spawn'))
      return child
    },
    execFileImpl: (file, args, opts, callback) => {
      execCalls.push({ file, args, opts })
      process.nextTick(() => callback(null, `${version}\n`, ''))
    },
    onMessage: message => events.messages.push(message),
    onNotice: notice => events.notices.push(notice),
    onControlCancel: (requestId, subtype, reason) => events.cancels.push({ requestId, subtype, reason }),
    onExit: exit => events.exits.push(exit),
    onStderr: line => events.stderr.push(line),
    ...options,
  })
  return { transport, child, spawnCalls, execCalls, events }
}

const lastWritten = child => child.written[child.written.length - 1]

test('default argv: stream-json both ways, stdio control channel, D-S2 isolation', () => {
  const args = buildClaudeArgs()
  assert.deepEqual(args, [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--permission-prompt-tool', 'stdio',
    '--settings', '{"disableAllHooks":true}',
    '--setting-sources=',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--include-partial-messages',
  ])
  for (const banned of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode', '--mcp-config', '--bare', '--safe-mode']) {
    assert.equal(args.includes(banned), false, banned)
  }
})

test('every emitted flag has a recorded source (claude 2.1.300 --help or the SDK for the hidden one)', () => {
  const args = buildClaudeArgs({
    mcpConfig: { mcpServers: { egdesk: { type: 'sdk', name: 'egdesk' } } },
    inherit: { instructions: true, skills: true }, model: 'opus', effort: 'high', permissionMode: 'acceptEdits',
    appendPrompt: '-- persona', sessionId: SESSION, allowedTools: ['mcp__egdesk'], disallowedTools: ['WebFetch'],
    addDirs: ['/Users/test/other'],
  })
  for (const flag of claudeArgFlags(args)) assert.ok(Object.hasOwn(CLAUDE_FLAG_SOURCES, flag), `no source for ${flag}`)
  assert.match(CLAUDE_FLAG_SOURCES['--permission-prompt-tool'], /hidden/)
})

test('EG-Desk MCP only: sdk servers pass, anything else is refused; managed-mcp.json drops --strict-mcp-config', () => {
  const args = buildClaudeArgs({ mcpConfig: { mcpServers: { egdesk: { type: 'sdk', name: 'egdesk', instance: {} } } } })
  const json = args[args.indexOf('--mcp-config') + 1]
  assert.deepEqual(JSON.parse(json), { mcpServers: { egdesk: { type: 'sdk', name: 'egdesk' } } })
  assert.ok(args.includes('--strict-mcp-config'))
  assert.throws(() => buildClaudeArgs({ mcpConfig: { mcpServers: { files: { type: 'stdio', command: 'npx' } } } }), { code: 'CLAUDE_OPTION_INVALID' })
  assert.throws(() => buildClaudeArgs({ mcpConfig: { mcpServers: { egdesk: { type: 'http', url: 'http://127.0.0.1:1' } } } }), { code: 'CLAUDE_OPTION_INVALID' })
  assert.equal(buildClaudeArgs({ managedMcpConfig: true }).includes('--strict-mcp-config'), false)
  assert.equal(managedMcpConfigPath('darwin'), '/Library/Application Support/ClaudeCode/managed-mcp.json')
})

test('CLAUDE.md and skills stay off unless the option turns them on', () => {
  const off = buildClaudeArgs()
  assert.ok(off.includes('--setting-sources='))
  assert.ok(off.includes('--disable-slash-commands'))
  const instructions = buildClaudeArgs({ inherit: { instructions: true } })
  assert.ok(instructions.includes('--setting-sources=user,project,local'))
  assert.ok(instructions.includes('--disable-slash-commands'))
  const skills = buildClaudeArgs({ inherit: { skills: true } })
  assert.ok(skills.includes('--setting-sources=user,project'))
  assert.equal(skills.includes('--disable-slash-commands'), false)
  // hooks stay off in every combination
  for (const args of [off, instructions, skills]) assert.equal(args[args.indexOf('--settings') + 1], '{"disableAllHooks":true}')
})

test('option values cannot smuggle flags', () => {
  assert.throws(() => buildClaudeArgs({ model: '--dangerously-skip-permissions' }), { code: 'CLAUDE_OPTION_INVALID' })
  assert.throws(() => buildClaudeArgs({ permissionMode: 'bypassPermissions' }), { code: 'CLAUDE_OPTION_INVALID' })
  assert.throws(() => buildClaudeArgs({ effort: 'ultra' }), { code: 'CLAUDE_OPTION_INVALID' })
  assert.throws(() => buildClaudeArgs({ sessionId: '--resume' }), { code: 'CLAUDE_OPTION_INVALID' })
  assert.throws(() => buildClaudeArgs({ sessionId: SESSION, resume: SESSION }), { code: 'CLAUDE_OPTION_INVALID' })
  assert.throws(() => buildClaudeArgs({ allowedTools: ['Bash,Edit'] }), { code: 'CLAUDE_OPTION_INVALID' })
  assert.throws(() => buildClaudeArgs({ allowedTools: ['-x'] }), { code: 'CLAUDE_OPTION_INVALID' })
  assert.throws(() => buildClaudeArgs({ addDirs: ['relative/dir'] }), { code: 'CLAUDE_OPTION_INVALID' })
  const args = buildClaudeArgs({ appendPrompt: '--strict-mcp-config off', sessionId: SESSION, model: 'claude-opus-4-1[1m]' })
  assert.ok(args.includes('--append-system-prompt=--strict-mcp-config off'))
  assert.ok(args.includes(`--session-id=${SESSION}`))
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'claude-opus-4-1[1m]'])
})

test('child env is an allowlist: login shared, keys and CLAUDECODE never copied, isolation env forced', () => {
  const parent = {
    ...BASE_ENV, CLAUDE_CONFIG_DIR: '/Users/test/.claude', CLAUDECODE: '1', ANTHROPIC_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'y',
    GITHUB_TOKEN: 'z', AWS_SECRET_ACCESS_KEY: 'w', CLAUDE_CODE_USE_BEDROCK: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'true', HTTPS_PROXY: 'http://proxy:8080',
  }
  const env = buildClaudeEnv(parent, { platform: 'darwin', cwd: CWD, extraEnv: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '1000' } })
  assert.equal(env.HOME, '/Users/test')
  assert.equal(env.CLAUDE_CONFIG_DIR, '/Users/test/.claude')
  assert.equal(env.HTTPS_PROXY, 'http://proxy:8080')
  assert.equal(env.PWD, CWD)
  assert.equal(env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '1000')
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'CLAUDE_CODE_USE_BEDROCK']) {
    assert.equal(Object.hasOwn(env, name), false, name)
  }
  for (const [name, value] of Object.entries(CLAUDE_ISOLATION_ENV)) assert.equal(env[name], value)
  assert.throws(() => buildClaudeEnv(parent, { inheritEnvNames: ['ANTHROPIC_API_KEY'] }), { code: 'CLAUDE_OPTION_INVALID' })
  assert.throws(() => buildClaudeEnv(parent, { extraEnv: { ANTHROPIC_API_KEY: 'k' } }), { code: 'CLAUDE_OPTION_INVALID' })
  assert.equal(buildClaudeEnv({ ...parent, CLAUDE_CODE_OAUTH_TOKEN: 't' }, { inheritEnvNames: ['CLAUDE_CODE_OAUTH_TOKEN'] }).CLAUDE_CODE_OAUTH_TOKEN, 't')
  const windows = buildClaudeEnv({ Path: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows', anthropic_api_key: 'x' }, { platform: 'win32' })
  assert.equal(windows.Path, 'C:\\Windows')
  assert.equal(windows.SYSTEMROOT, 'C:\\Windows')
  assert.equal(Object.keys(windows).some(key => key.toUpperCase() === 'ANTHROPIC_API_KEY'), false)
})

test('API key detection looks at names only, never at values', () => {
  const env = new Proxy({ ...BASE_ENV, ANTHROPIC_API_KEY: 'never-read', ANTHROPIC_AUTH_TOKEN: '' }, {
    get(target, key) {
      if (CLAUDE_API_KEY_ENV_NAMES.includes(key)) throw new Error(`value of ${String(key)} was read`)
      return target[key]
    },
  })
  assert.deepEqual(detectApiKeyEnv(env, { platform: 'darwin' }), ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
  assert.deepEqual(detectApiKeyEnv(BASE_ENV, { platform: 'darwin' }), [])
  assert.deepEqual(detectApiKeyEnv({ Anthropic_Api_Key: 'x' }, { platform: 'win32' }), ['ANTHROPIC_API_KEY'])
  // building the child env does not read them either
  assert.doesNotThrow(() => buildClaudeEnv(env, { platform: 'darwin' }))
})

test('start stops with CLAUDE_API_KEY_DETECTED before probing or spawning; strip runs without the key', async () => {
  const stopped = harness({ env: { ...BASE_ENV, ANTHROPIC_API_KEY: 'sk-ant-VALUE-123' } })
  await assert.rejects(stopped.transport.start(), error => {
    assert.equal(error.code, 'CLAUDE_API_KEY_DETECTED')
    assert.deepEqual(error.detected, ['ANTHROPIC_API_KEY'])
    assert.equal(JSON.stringify({ ...error, message: error.message }).includes('VALUE-123'), false) // names only, no value
    return true
  })
  assert.equal(stopped.execCalls.length, 0)
  assert.equal(stopped.spawnCalls.length, 0)
  assert.equal(stopped.transport.state(), 'exited')

  const stripped = harness({ env: { ...BASE_ENV, ANTHROPIC_API_KEY: 'x' }, apiKeyEnvPolicy: 'strip' })
  await stripped.transport.start()
  assert.equal(Object.hasOwn(stripped.spawnCalls[0].opts.env, 'ANTHROPIC_API_KEY'), false)
  await stripped.transport.close()
  assert.throws(() => createClaudeTransport({ executablePath: EXE, apiKeyEnvPolicy: 'inherit' }), { code: 'CLAUDE_OPTION_INVALID' })
})

test('version gate: parse, compare, refuse old or unreadable versions before spawn', async () => {
  assert.equal(parseClaudeVersion('2.1.300 (Claude Code)\n'), '2.1.300')
  assert.equal(parseClaudeVersion('claude'), null)
  assert.equal(compareVersions('2.1.205', '2.1.300'), -1)
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1)
  assert.deepEqual(checkClaudeVersion('2.1.205', CLAUDE_TRANSPORT_MIN_VERSION), { ok: true, version: '2.1.205', minVersion: '2.1.205' })

  const old = harness({ version: '2.1.204 (Claude Code)' })
  await assert.rejects(old.transport.start(), { code: 'CLAUDE_VERSION_UNSUPPORTED' })
  assert.equal(old.spawnCalls.length, 0)
  assert.deepEqual(old.execCalls[0].args, ['--version'])
  assert.equal(old.execCalls[0].opts.shell, false)
  assert.equal(old.execCalls[0].file, EXE)

  const garbage = harness({ version: 'not a version' })
  await assert.rejects(garbage.transport.start(), { code: 'CLAUDE_VERSION_UNKNOWN' })
  assert.equal(garbage.spawnCalls.length, 0)

  // a version already probed by claude-engine-auth skips the probe
  const given = harness({ version: 'ignored' })
  const preset = createClaudeTransport({
    executablePath: EXE, env: BASE_ENV, platform: 'darwin', managedMcpConfig: false, version: '2.1.300 (Claude Code)',
    spawnImpl: (...args) => { given.spawnCalls.push(args); process.nextTick(() => given.child.emit('spawn')); return given.child },
    execFileImpl: () => assert.fail('must not probe'),
  })
  const started = await preset.start()
  assert.equal(started.version, '2.1.300')
  await preset.close()
})

test('executable must be an absolute non-batch path; spawn is shell-less with the built argv and env', async () => {
  await assert.rejects(createClaudeTransport({ executablePath: 'claude', env: BASE_ENV, platform: 'darwin' }).start(), { code: 'CLAUDE_EXECUTABLE_INVALID' })
  await assert.rejects(createClaudeTransport({ executablePath: 'C:\\npm\\claude.cmd', env: {}, platform: 'win32' }).start(), { code: 'CLAUDE_EXECUTABLE_BATCH_REFUSED' })
  assert.equal(isWindowsBatchPath('C:\\tools\\claude.cmd'), true)
  assert.equal(isWindowsBatchPath('C:\\tools\\claude.CMD. '), true)
  assert.equal(isWindowsBatchPath('C:\\x\\claude.cmd:stream'), true)
  assert.equal(isWindowsBatchPath('C:\\Users\\me\\.local\\bin\\claude.exe'), false)

  const { transport, spawnCalls } = harness({ model: 'sonnet' })
  await transport.start()
  const [call] = spawnCalls
  assert.equal(call.file, EXE)
  assert.equal(call.opts.shell, false)
  assert.equal(call.opts.cwd, CWD)
  assert.deepEqual(call.opts.stdio, ['pipe', 'pipe', 'pipe'])
  assert.equal(call.opts.detached, false) // fake spawn: no process-group kill
  assert.deepEqual(call.args, buildClaudeArgs({ model: 'sonnet' }))
  assert.equal(call.opts.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false')
  await transport.close()
})

test('a missing executable rejects CLAUDE_NOT_FOUND and leaves nothing running', async () => {
  const child = fakeChild()
  const transport = createClaudeTransport({
    executablePath: EXE, env: BASE_ENV, platform: 'darwin', managedMcpConfig: false, version: '2.1.300',
    spawnImpl: () => { process.nextTick(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))); return child },
  })
  await assert.rejects(transport.start(), { code: 'CLAUDE_NOT_FOUND' })
  assert.equal(transport.state(), 'exited')
  assert.deepEqual(await transport.close(), { code: null, signal: null, forced: null })
})

test('start sends initialize (hooks null) and resolves with its response; managed MCP config is noticed', async () => {
  const { transport, child, events } = harness({ managedMcpConfig: null, existsImpl: file => file === managedMcpConfigPath('darwin') })
  const started = await transport.start()
  const init = child.written[0]
  assert.equal(init.type, 'control_request')
  assert.match(init.request_id, /^req_1_[0-9a-f]{8}$/)
  assert.deepEqual(init.request, { hooks: null, subtype: 'initialize' })
  assert.deepEqual(started.initialize, { commands: [] })
  assert.equal(started.managedMcpConfig, true)
  assert.ok(events.notices.some(n => n.code === 'CLAUDE_MANAGED_MCP_CONFIG' && n.fatal === false))
  await transport.close()
})

test('framing: split chunks, split UTF-8, CRLF, blank and non-JSON lines; invalid JSON is a notice', async () => {
  const { transport, child, events } = harness()
  await transport.start()
  const line = Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '안녕 🙂' }] } }) + '\r\n')
  const cut = line.indexOf(Buffer.from('🙂')) + 2 // inside the 4-byte emoji
  child.stdout.write(line.subarray(0, 5))
  child.stdout.write(line.subarray(5, cut))
  child.stdout.write(line.subarray(cut))
  child.stdout.write('\n[SandboxDebug] not json\n{"type":"result"')
  child.stdout.write(',"subtype":"success"}\n{broken\n')
  await until(() => events.messages.length === 2 && transport.stats().invalidJson === 1)
  assert.equal(events.messages[0].message.content[0].text, '안녕 🙂')
  assert.equal(events.messages[1].type, 'result')
  const stats = transport.stats()
  assert.equal(stats.nonJson, 1)
  assert.equal(stats.blank, 1)
  assert.ok(events.notices.some(n => n.code === 'CLAUDE_STREAM_INVALID_JSON' && n.fatal === false))
  await transport.close()
})

test('line framer drops an oversized line once and keeps going', () => {
  const lines = []
  const prefixes = []
  const framer = createLineFramer({ maxLineChars: 10, onLine: l => lines.push(l), onOversized: p => prefixes.push(p) })
  framer.push('short\n0123456789ABC')
  framer.push('DEF\nok\ntail')
  assert.deepEqual(lines, ['short', 'ok'])
  assert.deepEqual(prefixes, ['0123456789ABC'])
  assert.equal(framer.flush(), 'tail')
})

test('an oversized control_request is answered with an error so the CLI does not wait forever', async () => {
  const { transport, child, events } = harness({ limits: { maxLineChars: 200 } })
  await transport.start()
  child.stdout.write(`{"type":"control_request","request_id":"big-1","request":{"subtype":"can_use_tool","input":{"content":"${'x'.repeat(400)}"}}}\n`)
  child.send({ type: 'assistant', message: { content: [] } })
  await until(() => events.messages.length === 1 && child.written.length === 2)
  assert.deepEqual(lastWritten(child), { type: 'control_response', response: { subtype: 'error', request_id: 'big-1', error: 'Request too large for EG-Desk' } })
  assert.ok(events.notices.some(n => n.code === 'CLAUDE_LINE_TOO_LONG'))
  await transport.close()
})

test('control routing: can_use_tool, hook_callback, mcp_message ({write}), throw, unsupported', async () => {
  const seen = []
  const { transport, child } = harness({
    controlHandlers: {
      can_use_tool: (request, ctx) => { seen.push({ request, ctx }); return { response: { behavior: 'allow', updatedInput: request.input } } },
      hook_callback: () => ({ response: { continue: true } }),
      mcp_message: (request, { requestId }) => ({ write: { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { mcp_response: { jsonrpc: '2.0', id: request.message.id, result: {} } } } } }),
      elicitation: () => { throw new Error('Authorization: Bearer abc.def') },
    },
  })
  await transport.start()
  child.send({ type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' } })
  await until(() => child.written.length === 2)
  assert.deepEqual(lastWritten(child), { type: 'control_response', response: { subtype: 'success', request_id: 'p1', response: { behavior: 'allow', updatedInput: { command: 'ls' } } } })
  assert.equal(seen[0].ctx.requestId, 'p1')
  assert.equal(seen[0].ctx.subtype, 'can_use_tool')
  assert.equal(seen[0].ctx.signal.aborted, false)

  child.send({ type: 'control_request', request_id: 'h1', request: { subtype: 'hook_callback', callback_id: 'x', input: {} } })
  await until(() => child.written.length === 3)
  assert.deepEqual(lastWritten(child).response, { subtype: 'success', request_id: 'h1', response: { continue: true } })

  child.send({ type: 'control_request', request_id: 'm1', request: { subtype: 'mcp_message', server_name: 'egdesk', message: { jsonrpc: '2.0', id: 7, method: 'ping' } } })
  await until(() => child.written.length === 4)
  assert.deepEqual(lastWritten(child).response.response, { mcp_response: { jsonrpc: '2.0', id: 7, result: {} } })

  child.send({ type: 'control_request', request_id: 'e1', request: { subtype: 'elicitation' } })
  await until(() => child.written.length === 5)
  assert.equal(lastWritten(child).response.subtype, 'error')
  assert.equal(lastWritten(child).response.error.includes('abc.def'), false) // redacted

  child.send({ type: 'control_request', request_id: 'u1', request: { subtype: 'rewind_files' } })
  await until(() => child.written.length === 6)
  assert.deepEqual(lastWritten(child).response, { subtype: 'error', request_id: 'u1', error: 'Unsupported control request subtype: rewind_files' })
  assert.equal(transport.stats().unsupportedControl, 1)
  await transport.close()
})

test('deferred answers go through respondControl; control_cancel_request aborts and drops a late answer', async () => {
  const signals = new Map()
  const { transport, child, events } = harness({
    controlHandlers: { can_use_tool: (request, { requestId, signal }) => { signals.set(requestId, signal); return { serverRequest: { id: `rpc-${requestId}` } } } },
  })
  await transport.start()
  child.send({ type: 'control_request', request_id: 'a1', request: { subtype: 'can_use_tool', tool_name: 'Edit', input: {} } })
  child.send({ type: 'control_request', request_id: 'a2', request: { subtype: 'can_use_tool', tool_name: 'Write', input: {} } })
  await until(() => signals.size === 2)
  assert.equal(child.written.length, 1) // only initialize so far
  assert.equal(transport.info().pendingIncoming, 2)

  assert.equal(transport.respondControl('a1', { response: { behavior: 'deny', message: 'no' } }), true)
  await until(() => child.written.length === 2)
  assert.deepEqual(lastWritten(child).response, { subtype: 'success', request_id: 'a1', response: { behavior: 'deny', message: 'no' } })
  assert.throws(() => transport.respondControl('a2', { write: { type: 'control_response', response: { request_id: 'other' } } }), TypeError)

  child.send({ type: 'control_cancel_request', request_id: 'a2' })
  await until(() => events.cancels.length === 1)
  assert.deepEqual(events.cancels[0], { requestId: 'a2', subtype: 'can_use_tool', reason: 'cancelled' })
  assert.equal(signals.get('a2').aborted, true)
  assert.equal(transport.respondControl('a2', { response: { behavior: 'allow', updatedInput: {} } }), false)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(child.written.length, 2)
  assert.equal(transport.stats().lateResponses, 1)

  child.send({ type: 'control_request', request_id: 'a1', request: { subtype: 'can_use_tool', tool_name: 'Edit', input: {} } })
  child.send({ type: 'control_request', request_id: 'a1', request: { subtype: 'can_use_tool', tool_name: 'Edit', input: {} } })
  await until(() => transport.stats().duplicateControl === 1)
  await transport.close()
})

test('user messages and interrupt use the SDK line shapes; control errors and timeouts reject', async () => {
  const { transport, child } = harness()
  assert.throws(() => transport.sendUserMessage('hi'), { code: 'CLAUDE_TRANSPORT_STATE' })
  await transport.start()
  transport.sendUserMessage('안녕')
  await until(() => child.written.length === 2)
  assert.deepEqual(lastWritten(child), { type: 'user', session_id: '', message: { role: 'user', content: '안녕' }, parent_tool_use_id: null })
  transport.sendUserMessage([{ type: 'text', text: 'see image' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }])
  await until(() => child.written.length === 3)
  assert.equal(lastWritten(child).message.content.length, 2)
  assert.throws(() => transport.sendUserMessage(''), { code: 'CLAUDE_OPTION_INVALID' })

  const interrupted = transport.interrupt()
  await until(() => child.written.length === 4)
  const interruptLine = lastWritten(child)
  assert.deepEqual(interruptLine.request, { subtype: 'interrupt' })
  child.send({ type: 'control_response', response: { subtype: 'success', request_id: interruptLine.request_id, response: {} } })
  assert.deepEqual(await interrupted, {})

  const failing = transport.setModel('sonnet')
  await until(() => child.written.length === 5)
  child.send({ type: 'control_response', response: { subtype: 'error', request_id: lastWritten(child).request_id, error: 'unknown model' } })
  await assert.rejects(failing, { code: 'CLAUDE_CONTROL_ERROR', message: 'unknown model' })

  await assert.rejects(transport.request('mcp_status', {}, { timeoutMs: 20 }), { code: 'CLAUDE_CONTROL_TIMEOUT' })
  await assert.rejects(transport.request('rewind_files'), { code: 'CLAUDE_OPTION_INVALID' })
  await assert.rejects(transport.setPermissionMode('bypassPermissions'), { code: 'CLAUDE_OPTION_INVALID' })
  await transport.close()
})

test('init gate: capabilities present → delivered; missing list or capability → fatal notice and stop', async () => {
  const ok = harness({ requiredCapabilities: ['interrupt_receipt_v1'] })
  await ok.transport.start()
  ok.child.send({ type: 'system', subtype: 'init', claude_code_version: '2.1.300', apiKeySource: 'none', capabilities: ['interrupt_receipt_v1', 'msg_lifecycle_v1'] })
  await until(() => ok.events.messages.length === 1)
  assert.deepEqual(ok.transport.info().init, { version: '2.1.300', capabilities: ['interrupt_receipt_v1', 'msg_lifecycle_v1'], billsApiKey: false })
  await ok.transport.close()

  const missing = harness()
  await missing.transport.start()
  missing.child.send({ type: 'system', subtype: 'init', claude_code_version: '2.1.300', apiKeySource: 'none' })
  await until(() => missing.events.exits.length === 1)
  assert.ok(missing.events.notices.some(n => n.code === 'CLAUDE_CAPABILITIES_MISSING' && n.fatal === true))
  assert.equal(missing.events.messages.length, 0)
  assert.equal(missing.child.stdinEnded, true)
  assert.equal(missing.events.exits[0].reason, 'gate')

  const lacking = harness({ requiredCapabilities: ['interrupt_receipt_v1'], child: fakeChild({ exitOnStdinEnd: false, exitOn: [] }) })
  await lacking.transport.start()
  lacking.child.send({ type: 'system', subtype: 'init', claude_code_version: '2.1.300', apiKeySource: 'ANTHROPIC_API_KEY', capabilities: [] })
  await until(() => lacking.child.signals.length === 1)
  lacking.child.send({ type: 'assistant', message: { content: [{ type: 'text', text: 'after the gate' }] } })
  await until(() => lacking.transport.stats().droppedAfterGate === 1)
  lacking.child.exit(null, 'SIGTERM')
  await until(() => lacking.events.exits.length === 1)
  assert.equal(lacking.events.messages.length, 0)
  const notice = lacking.events.notices.find(n => n.code === 'CLAUDE_CAPABILITY_MISSING')
  assert.deepEqual(notice.missing, ['interrupt_receipt_v1'])
  assert.deepEqual(lacking.child.signals, ['SIGTERM']) // graceMs 0: terminated at once
  assert.equal(lacking.transport.info().init.billsApiKey, true)

  const drifted = harness()
  await drifted.transport.start()
  drifted.child.send({ type: 'system', subtype: 'init', claude_code_version: '2.0.1', capabilities: [] })
  await until(() => drifted.events.exits.length === 1)
  assert.ok(drifted.events.notices.some(n => n.code === 'CLAUDE_VERSION_UNSUPPORTED' && n.fatal))
})

test('close: stdin first, then SIGTERM, then SIGKILL; pending work is rejected or cancelled; onExit once', async () => {
  const graceful = harness()
  await graceful.transport.start()
  assert.equal(activeClaudeChildCount() >= 1, true)
  const result = await graceful.transport.close()
  assert.deepEqual(result, { code: 0, signal: null, forced: null })
  assert.equal(graceful.child.stdinEnded, true)
  assert.deepEqual(graceful.child.signals, [])
  assert.equal(graceful.events.exits.length, 1)
  assert.equal(graceful.events.exits[0].reason, 'closed')
  assert.equal(graceful.transport.state(), 'exited')

  const stubborn = harness({ child: fakeChild({ exitOnStdinEnd: false, exitOn: ['SIGKILL'] }), controlHandlers: { can_use_tool: () => undefined } })
  await stubborn.transport.start()
  stubborn.child.send({ type: 'control_request', request_id: 'w1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } })
  await until(() => stubborn.transport.info().pendingIncoming === 1)
  const pendingInterrupt = stubborn.transport.interrupt()
  const closing = stubborn.transport.close({ graceMs: 10, termMs: 10, killMs: 50 })
  await assert.rejects(pendingInterrupt, { code: 'CLAUDE_TRANSPORT_CLOSED' })
  const forced = await closing
  assert.equal(forced.forced, 'kill')
  assert.equal(forced.signal, 'SIGKILL')
  assert.deepEqual(stubborn.child.signals, ['SIGTERM', 'SIGKILL'])
  assert.deepEqual(stubborn.events.cancels, [{ requestId: 'w1', subtype: 'can_use_tool', reason: 'exit' }])
  assert.equal(stubborn.events.exits.length, 1)
  assert.equal(await stubborn.transport.close(), forced) // same promise
  assert.throws(() => stubborn.transport.sendUserMessage('late'), { code: 'CLAUDE_TRANSPORT_STATE' })
})

test('a crash rejects pending requests and reports reason exited; stderr is redacted and line-framed', async () => {
  const { transport, child, events } = harness()
  await transport.start()
  child.stderr.write('warn: Authorization: Bearer sk-ant-abc123\npartial')
  child.stderr.write(' line\n')
  const pending = transport.request('mcp_status')
  await until(() => child.written.length === 2)
  child.exit(1, null)
  await assert.rejects(pending, { code: 'CLAUDE_TRANSPORT_CLOSED' })
  await until(() => events.exits.length === 1)
  assert.deepEqual(events.exits[0], { code: 1, signal: null, reason: 'exited' })
  assert.equal(events.stderr.length, 2)
  assert.equal(events.stderr[0].includes('sk-ant-abc123'), false)
  assert.equal(events.stderr[1], 'partial line')
  assert.equal(transport.state(), 'exited')
})

test('orphan reaping signals every live child', async () => {
  const one = harness({ child: fakeChild({ pid: 5001, exitOn: [] }) })
  const two = harness({ child: fakeChild({ pid: 5002, exitOn: [] }) })
  await one.transport.start()
  await two.transport.start()
  const before = activeClaudeChildCount()
  assert.ok(before >= 2)
  assert.equal(reapClaudeChildren('SIGTERM'), before)
  assert.deepEqual(one.child.signals, ['SIGTERM'])
  assert.deepEqual(two.child.signals, ['SIGTERM'])
  assert.equal(activeClaudeChildCount(), 0)
  one.child.exit(null, 'SIGTERM')
  two.child.exit(null, 'SIGTERM')
  await until(() => one.transport.state() === 'exited' && two.transport.state() === 'exited')
})

// A real child (a node script standing in for `claude`, no Claude involved):
// the process group is signalled, so a Bash-tool-like grandchild goes too.
test('real spawn: version probe, initialize, and a SIGTERM-ignoring CLI is killed with its grandchild', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-claude-transport-'))
  const script = path.join(dir, 'fake-claude')
  await writeFile(script, `#!${process.execPath}
import { spawn } from 'node:child_process'
if (process.argv.includes('--version')) { console.log('2.1.300 (Claude Code)'); process.exit(0) }
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'debug', grand: grand.pid, args: process.argv.slice(2), keys: Object.keys(process.env) }) + '\\n')
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', data => {
  buffer += data
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, index))
    buffer = buffer.slice(index + 1)
    if (message.type === 'control_request') process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { ok: message.request.subtype } } }) + '\\n')
  }
})
`)
  await chmod(script, 0o755)
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  const messages = []
  const transport = createClaudeTransport({
    executablePath: script, cwd: dir, env: { ...BASE_ENV, PATH: process.env.PATH || '/usr/bin:/bin', ANTHROPIC_AUTH_TOKEN_UNRELATED: '1' },
    platform: process.platform, managedMcpConfig: false, onMessage: message => messages.push(message),
  })
  try {
    const started = await transport.start()
    assert.equal(started.version, '2.1.300')
    assert.deepEqual(started.initialize, { ok: 'initialize' })
    await until(() => messages.some(m => m.subtype === 'debug'))
    const debug = messages.find(m => m.subtype === 'debug')
    assert.deepEqual(debug.args, buildClaudeArgs())
    assert.equal(debug.keys.includes('ANTHROPIC_AUTH_TOKEN_UNRELATED'), false)
    assert.equal(alive(debug.grand), true)
    const result = await transport.close({ graceMs: 100, termMs: 200, killMs: 1000 })
    assert.equal(result.forced, 'kill')
    assert.equal(alive(started.pid), false)
    await until(() => !alive(debug.grand))
  } finally {
    await transport.close({ graceMs: 0, termMs: 0, killMs: 500 })
    await rm(dir, { recursive: true, force: true })
  }
})

test('a second start is refused', async () => {
  const { transport } = harness()
  await transport.start()
  await assert.rejects(transport.start(), { code: 'CLAUDE_TRANSPORT_STATE' })
  await transport.close()
})
