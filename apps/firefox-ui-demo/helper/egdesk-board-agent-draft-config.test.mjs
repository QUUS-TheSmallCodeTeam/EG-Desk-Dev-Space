import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { BOARD_AGENT_DRAFT_CONFIG_FILE, createBoardAgentDraftConfigReader } from './egdesk-board-agent-draft-config.mjs'
import { createBoardAgentDraftTransport } from './egdesk-board-agent-draft.mjs'

const key = 'fixture-only-board-bearer-01'
const nextKey = 'fixture-only-board-bearer-02'
const model = 'gpt-4.1-mini-2025-04-14'
const nextModel = 'gpt-4.1-nano-2025-04-14'
const body = extra => JSON.stringify({ version: 1, provider: 'openai', apiKey: key, model, ...extra })
const off = { configured: false, model: null }
const stale = { code: 'BOARD_AGENT_DRAFT_STALE' }
const posix = { skip: process.platform === 'win32' }

function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-board-draft-config-')))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const dataDir = path.join(base, 'app')
  const settings = path.join(dataDir, 'settings')
  const file = path.join(settings, BOARD_AGENT_DRAFT_CONFIG_FILE)
  const write = (value = body(), mode = 0o600) => {
    fs.mkdirSync(settings, { recursive: true, mode: 0o700 })
    const tmp = file + '.pending'
    fs.writeFileSync(tmp, value, { mode, flag: 'wx' })
    fs.chmodSync(tmp, mode)
    fs.renameSync(tmp, file)
  }
  return { base, dataDir, settings, file, write }
}

const input = ({ model, bindingId }) => ({ model, bindingId, question: 'What was decided?', excerpts: ['Approved text.'],
  replyStyle: 'plain', isCurrent: () => true })
const answer = model => Response.json({ object: 'response', status: 'completed', model,
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Approved.' }] }] })

test('cold helper process never provisions from inherited or command-line auth and creates no config', t => {
  const f = fixture(t)
  const configModule = new URL('./egdesk-board-agent-draft-config.mjs', import.meta.url)
  const transportModule = new URL('./egdesk-board-agent-draft.mjs', import.meta.url)
  const source = `import { createBoardAgentDraftConfigReader } from ${JSON.stringify(configModule.href)};
    import { createBoardAgentDraftTransport } from ${JSON.stringify(transportModule.href)};
    let decisionReads = 0;
    const readConfig = createBoardAgentDraftConfigReader({dataDir: process.argv[1], getDecisionApiKey() { decisionReads++; return null; }});
    const draft = createBoardAgentDraftTransport({ readConfig, fetchImpl() { throw new Error('must not dispatch'); } });
    process.stdout.write(JSON.stringify({ status: draft.status(), decisionReads }));`
  const coldStart = (env, args = []) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, '--', f.dataDir, ...args], {
      env, encoding: 'utf8', timeout: 10_000,
    })
    assert.equal(result.status, 0, result.error?.message)
    assert.equal(result.stderr, '')
    assert.equal(result.stdout.includes(key), false)
    assert.equal(result.stdout.includes(f.file), false)
    return JSON.parse(result.stdout)
  }
  assert.deepEqual(coldStart({ EGDESK_BOARD_AGENT_DRAFT_API_KEY: key, EGDESK_BOARD_AGENT_DRAFT_MODEL: model,
    OPENAI_API_KEY: nextKey, CODEX_API_KEY: nextKey, CODEX_HOME: f.base }, ['--api-key', key, '--model', model]),
  { status: off, decisionReads: 0 })
  assert.equal(fs.existsSync(f.dataDir), false)
  if (process.platform !== 'win32') {
    f.write()
    const { status, decisionReads } = coldStart({})
    assert.equal(status.configured, true)
    assert.equal(status.model, model)
    assert.equal(decisionReads, 1)
  }
})

test('valid config enables the transport without exporting its key or keeping stale approvals across rotations', posix, async t => {
  const f = fixture(t)
  let decisions = nextKey
  const readConfig = createBoardAgentDraftConfigReader({ dataDir: f.dataDir, getDecisionApiKey: () => decisions })
  const sent = []
  const transport = createBoardAgentDraftTransport({ readConfig, fetchImpl(_, options) {
    sent.push(options.headers.authorization)
    return answer(JSON.parse(options.body).model)
  } })
  assert.deepEqual(transport.status(), off)
  f.write()
  const cold = transport.status()
  assert.deepEqual(Object.keys(cold).sort(), ['bindingId', 'configured', 'model'])
  assert.equal(cold.configured, true)
  assert.equal(cold.model, model)
  assert.equal(JSON.stringify(cold).includes(key), false)
  assert.equal(JSON.stringify(cold).includes(f.file), false)
  assert.deepEqual(transport.status(), cold)
  assert.deepEqual(await transport.draft(input(cold)), { answer: 'Approved.' })
  // Replacing the file with the same semantic config does not rotate its binding.
  f.write()
  assert.deepEqual(transport.status(), cold)
  decisions = key
  assert.deepEqual(transport.status(), off)
  await assert.rejects(transport.draft(input(cold)), stale)
  f.write(body({ apiKey: nextKey }))
  const rotated = transport.status()
  assert.equal(rotated.model, model)
  assert.notEqual(rotated.bindingId, cold.bindingId)
  await assert.rejects(transport.draft(input(cold)), stale)
  assert.deepEqual(await transport.draft(input(rotated)), { answer: 'Approved.' })
  f.write(body({ apiKey: nextKey, model: nextModel }))
  const changedModel = transport.status()
  assert.equal(changedModel.model, nextModel)
  assert.notEqual(changedModel.bindingId, rotated.bindingId)
  await assert.rejects(transport.draft(input(rotated)), stale)
  fs.unlinkSync(f.file)
  assert.deepEqual(transport.status(), off)
  await assert.rejects(transport.draft(input(changedModel)), stale)
  f.write(body({ apiKey: nextKey, model: nextModel }))
  assert.notEqual(transport.status().bindingId, changedModel.bindingId)
  assert.deepEqual(sent, [`Bearer ${key}`, `Bearer ${nextKey}`])
})

test('unsafe, malformed and non-dedicated files fail closed, without fallback or mutation', posix, t => {
  const f = fixture(t)
  let decisionReads = 0
  const readConfig = createBoardAgentDraftConfigReader({ dataDir: f.dataDir, getDecisionApiKey() { decisionReads++; return null } })
  for (const text of ['broken', 'null', 'x'.repeat(4097), body({ version: 2 }), body({ provider: 'codex' }),
    body({ model: 'gpt-4.1-mini' }), body({ model: model.toUpperCase() }), body({ model: model + ' ' }),
    body({ apiKey: 'x' }), body({ apiKey: key + '\n' }), body({ endpoint: 'https://example.invalid' }),
    body({ model: undefined }), Buffer.from([0xc0, 0x80])]) {
    f.write(text)
    assert.equal(readConfig(), null)
    assert.deepEqual(fs.readFileSync(f.file), Buffer.from(text))
  }
  f.write(body(), 0o640)
  assert.equal(readConfig(), null)
  f.write(body(), 0o400)
  assert.equal(readConfig(), null)
  f.write()
  assert.equal(decisionReads, 0, 'invalid file must not consult Decisions')
  const onlyFile = createBoardAgentDraftConfigReader({ dataDir: f.dataDir })
  assert.deepEqual(onlyFile(), { apiKey: key, model })
  for (const p of [f.settings, f.dataDir, f.base]) {
    fs.chmodSync(p, 0o777)
    assert.equal(onlyFile(), null)
    fs.chmodSync(p, 0o700)
    assert.ok(onlyFile())
  }
  assert.equal(createBoardAgentDraftConfigReader({ dataDir: f.base + '/./app' })(), null)
  assert.equal(createBoardAgentDraftConfigReader({ dataDir: f.settings + '/../' })(), null)
  assert.equal(createBoardAgentDraftConfigReader({ dataDir: 'relative' })(), null)
  const otherFile = path.join(f.base, 'untrusted.json')
  fs.renameSync(f.file, otherFile)
  fs.symlinkSync(otherFile, f.file)
  assert.equal(onlyFile(), null)
  fs.unlinkSync(f.file)
  fs.linkSync(otherFile, f.file)
  assert.equal(onlyFile(), null)
  fs.unlinkSync(f.file)
  fs.mkdirSync(f.file)
  assert.equal(onlyFile(), null)
  fs.rmdirSync(f.file)
  fs.renameSync(otherFile, f.file)
  const otherSettings = path.join(f.base, 'settings-backup')
  fs.renameSync(f.settings, otherSettings)
  fs.symlinkSync(otherSettings, f.settings)
  assert.equal(onlyFile(), null)
  fs.unlinkSync(f.settings)
  fs.renameSync(otherSettings, f.settings)
  const appAlias = path.join(f.base, 'app-alias')
  fs.symlinkSync(f.dataDir, appAlias)
  assert.equal(createBoardAgentDraftConfigReader({ dataDir: appAlias })(), null)
  const ancestorAlias = path.join(f.base, 'ancestor-alias')
  fs.symlinkSync(f.base, ancestorAlias)
  assert.equal(createBoardAgentDraftConfigReader({ dataDir: path.join(ancestorAlias, 'app') })(), null)
  assert.deepEqual(onlyFile(), { apiKey: key, model })
})

test('production binds the dedicated reader only to the Responses transport, not engine launch or Decisions', () => {
  const source = fs.readFileSync(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.match(source, /draft: createBoardAgentDraftTransport\(\{ readConfig: createBoardAgentDraftConfigReader\(\{ dataDir, getDecisionApiKey: \(\) => decisionCredentials\.getApiKey\(\) \}\) \}\)/)
  assert.equal([...source.matchAll(/createBoardAgentDraftConfigReader\(/g)].length, 1)
  const scrub = source.indexOf('test(name)) delete process.env[name]')
  assert.ok(scrub >= 0 && scrub < source.indexOf('const appServerLaunch'))
  assert.doesNotMatch(source, /process\.(?:argv|env)\.[A-Z_]*BOARD_AGENT_DRAFT/)
})

test('Unix shell launchers scrub retired variables even before their first helper subprocess', posix, t => {
  const f = fixture(t)
  const firefox = path.join(f.base, 'firefox')
  fs.writeFileSync(firefox, '#!/bin/sh\nexit 97\n', { mode: 0o700 })
  // The real entry reaches our first helper, which checks its own inherited
  // environment and fails on purpose. No browser, bridge, port or config is used.
  const probe = `#!/bin/sh\nif [ "\${EGDESK_BOARD_AGENT_DRAFT_API_KEY+set}" ] || [ "\${EGDESK_BOARD_AGENT_DRAFT_MODEL+set}" ]; then exit 98; fi\nprintf '%s\\n' 'scrubbed child' >&2\nexit 99\n`
  for (const name of ['node', 'uname']) fs.writeFileSync(path.join(f.base, name), probe, { mode: 0o700 })
  for (const launcher of ['run-firefox-mcp-target.sh', 'run-codex-bridge.sh']) {
    const script = new URL(`../scripts/${launcher}`, import.meta.url)
    const result = spawnSync('/bin/bash', [fileURLToPath(script)], {
      env: { PATH: `${f.base}${path.delimiter}/usr/bin${path.delimiter}/bin`, HOME: f.base,
        EGDESK_FIREFOX_PROFILE: f.base, EGDESK_FIREFOX_BIN: firefox,
        EGDESK_BOARD_AGENT_DRAFT_API_KEY: key, EGDESK_BOARD_AGENT_DRAFT_MODEL: model },
      encoding: 'utf8', timeout: 10_000,
    })
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr.includes('scrubbed child'), true, launcher)
    assert.equal(`${result.stdout}${result.stderr}`.includes(key), false, launcher)
  }
})
