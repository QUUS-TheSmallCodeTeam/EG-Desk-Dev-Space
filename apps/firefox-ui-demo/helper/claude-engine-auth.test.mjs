import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  CLAUDE_AUTH_METHODS, CLAUDE_AUTH_STATUSES, CLAUDE_LOGIN_METHODS, CLAUDE_PROBE_TIMEOUT_MS, CLAUDE_STATUS_MAX_AGE_MS, CLAUDE_VERSION_POLICY,
  claudeAuthFromCliStatus, claudeLoginTerminalCommand, claudeProbeEnvironment, createClaudeEngineStatus, parseClaudeVersion, probeClaudeEngine,
  resolveClaudeExecutable, runBounded,
} from './claude-engine-auth.mjs'
import { CLAUDE_TRANSPORT_MIN_VERSION } from './claude-engine-transport.mjs'
import { engineVersionStatus } from './egdesk-native-capabilities.mjs'

// Shape of `claude auth status --json` (Claude Code 2.1.300): absent fields
// are omitted, and the logged-out case exits 1 while printing valid JSON.
const cli = fields => JSON.stringify({ analyticsDisabled: false, configDirectory: '/Users/me/.claude', projectsDirectory: '/Users/me/.claude/projects', ...fields })

test('auth status JSON maps to signed in, signed out or unknown with an allow-list of public fields', () => {
  assert.deepEqual(CLAUDE_AUTH_STATUSES, ['signedIn', 'signedOut', 'unknown'])
  assert.deepEqual(CLAUDE_AUTH_METHODS, ['claudeai', 'apiKey', 'gateway', 'external'])
  assert.deepEqual(claudeAuthFromCliStatus(cli({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' })), { status: 'signedOut', method: null, label: null, account: null, planType: null })
  const max = claudeAuthFromCliStatus(cli({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'owner@example.com', orgId: 'org-PRIVATE', orgName: 'Owner Org', subscriptionType: 'max' }))
  assert.deepEqual(max, { status: 'signedIn', method: 'claudeai', label: 'Claude Max', account: 'owner@example.com', planType: 'max' })
  assert.equal(/\/Users\/me|PRIVATE|Owner Org|analytics/.test(JSON.stringify(max)), false, 'paths, org IDs and other fields are dropped')
  // A newer CLI already says "Claude Max": one "Claude" only.
  assert.equal(claudeAuthFromCliStatus(cli({ loggedIn: true, subscriptionType: 'Claude Max' })).label, 'Claude Max')
  assert.equal(claudeAuthFromCliStatus(cli({ loggedIn: true, subscriptionType: 'pro' })).label, 'Claude Pro')
  // An API key pays for the turn even beside a subscription login.
  assert.deepEqual(claudeAuthFromCliStatus(cli({ loggedIn: true, apiKeySource: 'ANTHROPIC_API_KEY', subscriptionType: 'max', email: 'owner@example.com' })),
    { status: 'signedIn', method: 'apiKey', label: 'Anthropic API key', account: null, planType: null })
  assert.equal(claudeAuthFromCliStatus(cli({ loggedIn: false, apiKeySource: 'apiKeyHelper' })).method, 'apiKey')
  // External backends decide before the logged-out shortcut (loggedIn tracks claude.ai only).
  assert.deepEqual(claudeAuthFromCliStatus(cli({ loggedIn: false, apiProvider: 'bedrock' })), { status: 'signedIn', method: 'external', label: 'AWS Bedrock', account: null, planType: null })
  assert.equal(claudeAuthFromCliStatus(cli({ loggedIn: false, apiProvider: 'vertex' })).label, 'Google Vertex AI')
  assert.equal(claudeAuthFromCliStatus(cli({ loggedIn: false, apiProvider: 'gateway' })).method, 'gateway')
  for (const apiProvider of ['constructor', '__proto__', 'someNewCloud']) assert.equal(claudeAuthFromCliStatus(cli({ loggedIn: false, apiProvider })).label, 'External cloud provider', apiProvider)
  // loggedIn: true is never shown as signed out, even without a plan.
  assert.deepEqual(claudeAuthFromCliStatus(cli({ loggedIn: true, email: 'owner@example.com' })), { status: 'signedIn', method: null, label: 'Claude', account: 'owner@example.com', planType: null })
  assert.equal(claudeAuthFromCliStatus(cli({ loggedIn: true, subscriptionType: 'max', email: 'not an email' })).account, null)
  assert.equal(claudeAuthFromCliStatus(cli({ loggedIn: true, subscriptionType: '<b>max</b>' })).planType, null)
})

test('anything but the expected JSON object is unknown, never guessed', () => {
  for (const stdout of [undefined, null, 42, '', 'Not logged in', '[]', 'null', '"loggedIn"', '{"loggedIn":"true"}', '{"email":"owner@example.com"}', '{', `{"loggedIn":true,"pad":"${'x'.repeat(70000)}"}`]) {
    assert.equal(claudeAuthFromCliStatus(stdout), null, String(stdout).slice(0, 30))
  }
})

test('version is read from the CLI banner only, and the range marks every installed Claude as not verified yet, below the run gate as unsupported', () => {
  assert.equal(parseClaudeVersion('2.1.300 (Claude Code)\n'), '2.1.300')
  assert.equal(parseClaudeVersion('2.1.300\n'), '2.1.300')
  assert.equal(parseClaudeVersion('2.2.0-beta.1 (Claude Code)\nextra line'), '2.2.0-beta.1')
  for (const stdout of ['', 'claude 2.1.300', '2.1 (Claude Code)', '/Users/me/.local/bin/claude', 'v2.1.300', null, 7]) assert.equal(parseClaudeVersion(stdout), null, String(stdout))
  // 2-E: the display minimum is the transport's run gate, so the row and the run agree.
  assert.deepEqual(CLAUDE_VERSION_POLICY, { verified: [], minimum: CLAUDE_TRANSPORT_MIN_VERSION })
  assert.equal(CLAUDE_TRANSPORT_MIN_VERSION, '2.1.205')
  assert.equal(engineVersionStatus('2.1.300', CLAUDE_VERSION_POLICY), 'untested')
  assert.equal(engineVersionStatus('2.1.205', CLAUDE_VERSION_POLICY), 'untested')
  assert.equal(engineVersionStatus('2.1.204', CLAUDE_VERSION_POLICY), 'unsupported')
  assert.equal(engineVersionStatus('2.1.111', CLAUDE_VERSION_POLICY), 'unsupported')
})

// D-S1 login button: a Terminal card runs the CLI's own login; EG-Desk sees no credential.
test('the login button contract is the official `claude auth login` line, subscription by default and Console for the API key profile', () => {
  assert.deepEqual(claudeLoginTerminalCommand(), {
    method: 'claudeai', billing: 'subscription', argv: ['claude', 'auth', 'login', '--claudeai'], line: 'claude auth login --claudeai',
    credentialStore: 'claude-cli', afterward: { method: 'POST', route: '/engines/claude/refresh' },
  })
  assert.equal(claudeLoginTerminalCommand(null).method, 'claudeai')
  const consoleLogin = claudeLoginTerminalCommand('console')
  assert.deepEqual([consoleLogin.line, consoleLogin.billing], ['claude auth login --console', 'apiKey'])
  assert.deepEqual(Object.keys(CLAUDE_LOGIN_METHODS), ['claudeai', 'console'])
  for (const bad of ['apiKey', '--sso', 'claudeai; rm -rf ~', 7, {}]) {
    assert.throws(() => claudeLoginTerminalCommand(bad), error => error.code === 'CLAUDE_LOGIN_METHOD_INVALID' && error.httpStatus === 400)
  }
  // No path, token or email can appear: the line is built from fixed words only.
  assert.equal(/\/|token|@/.test(JSON.stringify([claudeLoginTerminalCommand(), consoleLogin]).replaceAll('/engines/claude/refresh', '')), false)
})

test('probe environment only turns off the auto-updater; HOME and CLAUDE_CONFIG_DIR pass through', () => {
  const env = { HOME: '/Users/me', CLAUDE_CONFIG_DIR: '/Users/me/.claude-work', PATH: '/bin' }
  const launched = claudeProbeEnvironment(env)
  assert.deepEqual(launched, { ...env, DISABLE_AUTOUPDATER: '1' })
  assert.equal(env.DISABLE_AUTOUPDATER, undefined, 'the input is not changed')
})

test('executable lookup: override, then PATH, then well-known install locations; null when none', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-claude-resolver-'))
  try {
    const executable = path.join(dir, 'claude')
    await writeFile(executable, 'fixture', { mode: 0o700 })
    const canonical = await realpath(executable)
    const none = () => false
    assert.equal(resolveClaudeExecutable({ PATH: dir }, { platform: 'darwin', home: '/nonexistent-home' }), canonical)
    assert.equal(resolveClaudeExecutable({ EGDESK_CLAUDE_BIN: executable, PATH: '' }, { platform: 'darwin', home: '/nonexistent-home' }), canonical)
    assert.equal(resolveClaudeExecutable({ EGDESK_CLAUDE_BIN: 'relative/claude', PATH: dir }, { platform: 'darwin' }), null, 'a relative override is refused, not searched')
    assert.equal(resolveClaudeExecutable({ EGDESK_CLAUDE_BIN: path.join(dir, 'missing'), PATH: dir }, { platform: 'darwin' }), null)
    // Well-known locations, checked without touching the real home.
    const seen = []
    const isExecutable = candidate => { seen.push(candidate); return candidate === '/home/fake/.local/bin/claude' }
    assert.equal(resolveClaudeExecutable({ PATH: '/usr/empty' }, { platform: 'darwin', home: '/home/fake', isExecutable, realpath: value => value }), '/home/fake/.local/bin/claude')
    assert.deepEqual(seen, ['/usr/empty/claude', '/home/fake/.local/bin/claude'])
    seen.length = 0
    assert.equal(resolveClaudeExecutable({ PATH: '' }, { platform: 'darwin', home: '/home/fake', isExecutable: candidate => { seen.push(candidate); return false }, realpath: value => value }), null)
    assert.deepEqual(seen, ['/home/fake/.local/bin/claude', '/home/fake/.claude/local/claude', '/home/fake/.claude/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude'])
    assert.equal(resolveClaudeExecutable({ Path: 'C:\\Tools' }, { platform: 'win32', home: 'C:\\Users\\me', isExecutable: candidate => candidate.endsWith('claude.exe') && candidate.startsWith('C:\\Tools'), realpath: value => value }), path.join('C:\\Tools', 'claude.exe'))
    assert.equal(resolveClaudeExecutable({ PATH: dir }, { platform: 'darwin', isExecutable: none }), null)
    assert.equal(resolveClaudeExecutable({ PATH: dir }, { platform: 'darwin', isExecutable: () => { throw new Error('/private') } }), null)
  } finally {
    assert.equal(path.dirname(dir), os.tmpdir())
    await rm(dir, { recursive: true })
  }
})

test('bounded runner reads stdout of a non-zero exit, kills on timeout or oversized output, and never rejects', async () => {
  const node = process.execPath
  const loggedOut = await runBounded(node, ['-e', 'process.stdout.write(JSON.stringify({loggedIn:false})); process.exitCode = 1'], { timeoutMs: 5000 })
  assert.deepEqual(loggedOut, { status: 1, stdout: '{"loggedIn":false}', timedOut: false })
  const hung = await runBounded(node, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 150 })
  assert.deepEqual(hung, { status: null, stdout: '', timedOut: true })
  const flood = await runBounded(node, ['-e', 'process.stdout.write("x".repeat(9000))'], { timeoutMs: 5000, maxBytes: 1024 })
  assert.deepEqual([flood.status, flood.stdout], [null, ''])
  assert.deepEqual(await runBounded(path.join(os.tmpdir(), 'egdesk-no-such-claude'), ['--version'], { timeoutMs: 1000 }), { status: null, stdout: '', timedOut: false })
  assert.deepEqual(await runBounded('claude', [], { spawnImpl: () => { throw new Error('spawn refused') } }), { status: null, stdout: '', timedOut: false })
  // No shell, stdin closed, stderr discarded.
  let options = null
  await runBounded('claude', ['--version'], { spawnImpl: (file, args, opts) => { options = opts; throw new Error('stop') } })
  assert.deepEqual([options.shell, options.stdio], [false, ['ignore', 'pipe', 'ignore']])
  assert.equal(CLAUDE_PROBE_TIMEOUT_MS, 5000)
})

test('one probe runs only --version and auth status --json, in a neutral folder with the auto-updater off', async () => {
  const calls = []
  const answers = { '--version': { status: 0, stdout: '2.1.300 (Claude Code)\n' }, auth: { status: 1, stdout: cli({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }) } }
  const run = async (file, args, options) => { calls.push({ file, args, cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs }); return answers[args[0]] }
  const snapshot = await probeClaudeEngine({ env: { HOME: '/Users/me', PATH: '/bin' }, cwd: '/tmp/neutral', resolve: () => '/opt/claude/2.1.300', run, now: () => 77 })
  assert.deepEqual(snapshot, { installed: true, version: '2.1.300', versionStatus: 'untested', auth: { status: 'signedOut', method: null, label: null, account: null, planType: null }, checkedAt: 77 })
  assert.deepEqual(calls.map(call => [call.file, call.args, call.cwd, call.env.DISABLE_AUTOUPDATER, call.env.HOME, call.timeoutMs]), [
    ['/opt/claude/2.1.300', ['--version'], '/tmp/neutral', '1', '/Users/me', 5000],
    ['/opt/claude/2.1.300', ['auth', 'status', '--json'], '/tmp/neutral', '1', '/Users/me', 5000],
  ])
  assert.equal(JSON.stringify(snapshot).includes('/opt/claude'), false, 'the executable path never leaves the helper')
  // Not installed: nothing runs.
  const none = await probeClaudeEngine({ resolve: () => null, run: () => assert.fail('nothing runs'), now: () => 5 })
  assert.deepEqual(none, { installed: false, version: null, versionStatus: null, auth: null, checkedAt: 5 })
  assert.equal((await probeClaudeEngine({ resolve: () => { throw new Error('/private') }, run: () => assert.fail('nothing runs') })).installed, false)
  // A broken CLI: installed, version and login unknown.
  const broken = await probeClaudeEngine({ resolve: () => '/opt/claude', run: async args => { throw new Error('crash') } })
  assert.deepEqual([broken.installed, broken.version, broken.versionStatus, broken.auth.status], [true, null, null, 'unknown'])
  const timedOut = await probeClaudeEngine({ resolve: () => '/opt/claude', run: async () => ({ status: null, stdout: '', timedOut: true }) })
  assert.deepEqual([timedOut.version, timedOut.auth], [null, { status: 'unknown', method: null, label: null, account: null, planType: null }])
})

test('status holder joins a running check, skips fresh ones, and announces only public changes', async () => {
  let clock = 1_000_000, probes = 0, release = null
  const results = []
  const probe = () => { probes++; return new Promise(resolve => { release = () => resolve(results.shift()) }) }
  const changes = []
  const status = createClaudeEngineStatus({ probe, now: () => clock, onChange: snapshot => changes.push(snapshot) })
  assert.deepEqual(status.snapshot(), { installed: null, version: null, versionStatus: null, auth: null, checkedAt: null })
  const signedIn = { installed: true, version: '2.1.300', versionStatus: 'untested', auth: { status: 'signedIn', method: 'claudeai', label: 'Claude Max', account: 'owner@example.com', planType: 'max' }, checkedAt: clock }
  results.push(signedIn)
  const first = status.refresh(), joined = status.refresh({ force: true })
  assert.equal(probes, 1, 'a running check is joined')
  release()
  assert.deepEqual(await first, signedIn)
  assert.deepEqual(await joined, signedIn)
  assert.equal(changes.length, 1)
  // Automatic checks skip a fresh result; 'check again' re-checks after 2 s.
  clock += 1000
  await status.refresh()
  await status.refresh({ force: true })
  assert.equal(probes, 1)
  clock += CLAUDE_STATUS_MAX_AGE_MS
  results.push({ ...signedIn, checkedAt: clock })
  const same = status.refresh()
  release()
  await same
  assert.deepEqual([probes, changes.length], [2, 1], 'an unchanged result is not announced')
  clock += 2500
  results.push({ ...signedIn, auth: { status: 'signedOut', method: null, label: null, account: null, planType: null }, checkedAt: clock })
  const forced = status.refresh({ force: true })
  release()
  await forced
  assert.deepEqual([probes, changes.length, changes[1].auth.status], [3, 2, 'signedOut'])
  // The snapshot is a copy.
  status.snapshot().auth.status = 'tampered'
  assert.equal(status.snapshot().auth.status, 'signedOut')
})

test('a Claude profile switch drops the old login immediately and never joins an old probe', async () => {
  let id = 'claude-default', clock = 1000
  const pending = [], published = []
  const status = createClaudeEngineStatus({ getProfileId: () => id, now: () => clock,
    probe: slot => new Promise(resolve => pending.push({ slot, resolve })), onChange: next => published.push(next.auth?.account) })
  const result = account => ({ installed: true, version: '2.1.300', versionStatus: 'untested', checkedAt: clock,
    auth: account ? { status: 'signedIn', account } : { status: 'signedOut' } })
  const first = status.refresh()
  pending[0].resolve(result('shared@example.test')); await first
  id = 'claude-bbbb'
  assert.equal(status.snapshot().auth, null, 'the shared account is not displayed or ready for B even inside the minimum interval')
  const checkingB = status.refresh({ force: true })
  id = 'claude-default'; const checkingA = status.refresh()
  id = 'claude-bbbb'; const latestB = status.refresh()
  assert.deepEqual(pending.map(p => p.slot), ['claude-default', 'claude-bbbb', 'claude-default', 'claude-bbbb'])
  pending[3].resolve(result(null)); await latestB
  pending[2].resolve(result('shared@example.test')); await checkingA
  pending[1].resolve(result('stale-b@example.test')); await checkingB
  assert.equal(status.snapshot().auth.status, 'signedOut'); assert.deepEqual(published, ['shared@example.test', undefined])
  clock += 2500; const signedIn = status.refresh({ force: true }); pending[4].resolve(result('owned@example.test')); await signedIn
  assert.equal(status.snapshot().auth.account, 'owned@example.test')
});

test('a failing probe or listener never breaks the holder', async () => {
  let clock = 10
  const status = createClaudeEngineStatus({ probe: async () => { throw new Error('/private/path') }, now: () => clock, onChange: () => { throw new Error('listener') } })
  const snapshot = await status.refresh()
  assert.deepEqual(snapshot, { installed: null, version: null, versionStatus: null, auth: null, checkedAt: 10 })
  clock += CLAUDE_STATUS_MAX_AGE_MS + 1
  const ok = createClaudeEngineStatus({ probe: async () => ({ installed: false, version: null, versionStatus: null, auth: null, checkedAt: clock }), now: () => clock, onChange: () => { throw new Error('listener') } })
  assert.equal((await ok.refresh()).installed, false)
})

test('the module reads no credentials: no Keychain call, no credential file, only the two CLI commands', async () => {
  const source = await readFile(new URL('./claude-engine-auth.mjs', import.meta.url), 'utf8')
  const code = source.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
  for (const forbidden of ['find-generic-password', 'security ', '.credentials', 'readFile', 'Keychain', 'HOME:', 'CLAUDE_CODE_OAUTH_TOKEN', 'console.']) {
    assert.equal(code.includes(forbidden), false, forbidden)
  }
  assert.deepEqual(code.match(/run\(executable, \[[^\]]*\]/g), ["run(executable, ['--version']", "run(executable, ['auth', 'status', '--json']"])
})
