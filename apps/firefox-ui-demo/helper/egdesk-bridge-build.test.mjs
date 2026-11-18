import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import {
  BRIDGE_ENTRY, OVERLAY_BUILD_HEADER, OVERLAY_BUILD_QUERY, bridgeBuildState, bridgeSourceFiles,
  computeBridgeBuildHash, expectedOverlayBuild, localModuleReferences, startBridgeBuild,
} from './egdesk-bridge-build.mjs'

const root = path.resolve('/virtual-egdesk/helper')
const entry = path.join(root, 'codex-bridge-server.mjs')
function virtualHelper(files) {
  const reads = []
  const readFile = file => {
    reads.push(file)
    const name = path.relative(root, file).split(path.sep).join('/')
    if (!Object.hasOwn(files, name)) throw Object.assign(new Error(`missing ${name}`), { code: 'ENOENT' })
    return files[name]
  }
  return { entry, readFile, reads }
}
const helper = {
  'codex-bridge-server.mjs': "import { a } from './a.mjs'\nimport './side.mjs'\nimport { createServer } from 'node:http'\nimport pty from 'node-pty'\nconst late = await import('./late.mjs')\n",
  'a.mjs': "export { b } from './nested/b.mjs'\nexport const a = 1\n",
  'nested/b.mjs': "import { a } from '../a.mjs'\nconst worker = new URL('../worker.mjs', import.meta.url)\nexport const b = 2\n",
  'side.mjs': "import '../outside.mjs'\nimport './gone.mjs'\n",
  'late.mjs': 'export default 3\n',
  'worker.mjs': 'process.exit(0)\n',
  'unused.mjs': 'export const unused = true\n',
}

test('the build is the entry import graph inside helper: static, re-export, dynamic and worker modules only', () => {
  assert.deepEqual(localModuleReferences(helper['codex-bridge-server.mjs']).sort(), ['./a.mjs', './late.mjs', './side.mjs'])
  const files = bridgeSourceFiles(virtualHelper(helper)).map(file => file.name)
  assert.deepEqual(files, ['a.mjs', 'codex-bridge-server.mjs', 'late.mjs', 'nested/b.mjs', 'side.mjs', 'worker.mjs'])
  assert.ok(!files.includes('unused.mjs') && !files.some(name => name.includes('outside') || name.includes('gone')))
})

test('buildHash is deterministic, ignores line endings and unloaded files, and changes with any loaded byte', () => {
  const first = computeBridgeBuildHash(virtualHelper(helper))
  assert.match(first, /^[a-f0-9]{64}$/)
  assert.equal(computeBridgeBuildHash(virtualHelper({ ...helper })), first)
  const crlf = Object.fromEntries(Object.entries(helper).map(([name, text]) => [name, text.replace(/\n/g, '\r\n')]))
  assert.equal(computeBridgeBuildHash(virtualHelper(crlf)), first)
  assert.equal(computeBridgeBuildHash(virtualHelper({ ...helper, 'unused.mjs': 'changed' })), first)
  for (const name of ['codex-bridge-server.mjs', 'nested/b.mjs', 'worker.mjs', 'late.mjs']) {
    assert.notEqual(computeBridgeBuildHash(virtualHelper({ ...helper, [name]: helper[name] + ' ' })), first, name)
  }
  // Moving the same bytes to another module name is another build.
  assert.notEqual(computeBridgeBuildHash(virtualHelper({ ...helper, 'late.mjs': helper['worker.mjs'], 'worker.mjs': helper['late.mjs'] })), first)
  const looped = virtualHelper(helper)
  computeBridgeBuildHash(looped)
  assert.equal(looped.reads.filter(file => file.endsWith(`${path.sep}a.mjs`)).length, 1, 'a module imported twice is read once')
})

test('the real bridge build covers its helper modules, not tests or modules it never loads', () => {
  const names = bridgeSourceFiles().map(file => file.name)
  for (const name of ['codex-bridge-server.mjs', 'codex-bridge-http.mjs', 'egdesk-bridge-build.mjs', 'codex-chat-runtime.mjs', 'terminal-pty-worker.mjs']) assert.ok(names.includes(name), name)
  assert.ok(!names.some(name => name.endsWith('.test.mjs') || name.startsWith('../') || name.startsWith('node_modules/')))
  // The workflow runtime loads the task graph modules; the portable routes (RT-03) load the bundle library.
  for (const name of ['egdesk-workflow-runtime.mjs', 'egdesk-event-bus.mjs', 'egdesk-task-store.mjs']) assert.ok(names.includes(name), name)
  for (const name of ['egdesk-portable-http.mjs', 'egdesk-portable-service.mjs', 'egdesk-portable-bundle.mjs', 'egdesk-portable-review.mjs']) assert.ok(names.includes(name), name)
  for (const name of ['egdesk-board-agent-ask.mjs', 'egdesk-board-agent-ask-http.mjs', 'egdesk-board-agent-context.mjs', 'egdesk-board-agent-draft.mjs']) assert.ok(names.includes(name), name)
  assert.equal(computeBridgeBuildHash(), computeBridgeBuildHash())
  assert.equal(BRIDGE_ENTRY, fileURLToPath(new URL('./codex-bridge-server.mjs', import.meta.url)))
})

test('the CLI prints the same hash an installed overlay should send', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./egdesk-bridge-build.mjs', import.meta.url))], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, computeBridgeBuildHash() + '\n')
})

test('the overlay build comes from X-EGDesk-Overlay-Build, else the overlayBuild query; anything else is not sent', () => {
  const hash = 'a'.repeat(64), other = 'b'.repeat(64)
  assert.equal(OVERLAY_BUILD_HEADER, 'x-egdesk-overlay-build')
  assert.equal(OVERLAY_BUILD_QUERY, 'overlayBuild')
  assert.equal(expectedOverlayBuild({ [OVERLAY_BUILD_HEADER]: ` ${hash.toUpperCase()} ` }), hash)
  assert.equal(expectedOverlayBuild({}, new URLSearchParams({ overlayBuild: other })), other)
  assert.equal(expectedOverlayBuild({ [OVERLAY_BUILD_HEADER]: hash }, new URLSearchParams({ overlayBuild: other })), hash)
  for (const value of [undefined, '', 'abc', 'g'.repeat(64), `${hash}, ${hash}`, ['x'], 42]) {
    assert.equal(expectedOverlayBuild({ [OVERLAY_BUILD_HEADER]: value }), null, String(value))
  }
  assert.equal(expectedOverlayBuild(undefined, null), null)
})

test('sourceMismatch is true only when the overlay build and the running build are both known and differ', () => {
  const build = { buildHash: 'a'.repeat(64), startedAt: 1_700_000_000_000 }
  assert.deepEqual(bridgeBuildState(build, 'b'.repeat(64)), { buildHash: build.buildHash, startedAt: build.startedAt, sourceMismatch: true })
  assert.equal(bridgeBuildState(build, build.buildHash).sourceMismatch, false)
  assert.equal(bridgeBuildState(build, null).sourceMismatch, false)
  assert.equal(bridgeBuildState({ buildHash: null, startedAt: 1 }, 'b'.repeat(64)).sourceMismatch, false)
  assert.deepEqual(Object.keys(bridgeBuildState(build)), ['buildHash', 'startedAt', 'sourceMismatch'])
})

test('the build is read once at start; a failed or malformed read leaves buildHash null without stopping the bridge', () => {
  let calls = 0
  const build = startBridgeBuild({ now: () => 42, compute: () => { calls += 1; return 'c'.repeat(64) } })
  assert.deepEqual({ ...build }, { buildHash: 'c'.repeat(64), startedAt: 42 })
  assert.equal(calls, 1)
  assert.ok(Object.isFrozen(build))
  assert.deepEqual({ ...startBridgeBuild({ now: () => 7, compute: () => { throw new Error('EACCES /secret/path') } }) }, { buildHash: null, startedAt: 7 })
  assert.equal(startBridgeBuild({ compute: () => 'not-a-hash' }).buildHash, null)
})

test('the macOS launcher writes the expected build marker after copying overlay resources, and only warns on failure', () => {
  const script = fs.readFileSync(new URL('../scripts/run-firefox-mcp-target.sh', import.meta.url), 'utf8')
  const start = script.indexOf('BUILD_MARKER=')
  const end = script.indexOf('\nfi\n', start)
  assert.ok(start > script.indexOf('cp -R "$REPO_ROOT"/overlay/resources/. "$PROFILE/chrome/resources/"'), 'after the resources copy')
  assert.ok(end > start && end < script.indexOf('rm -rf "$PROFILE/startupCache"') && end < script.indexOf('run-codex-bridge.sh'), 'before the bridge starts')
  const block = script.slice(start, end + 3)
  assert.match(block, /node "\$REPO_ROOT\/helper\/egdesk-bridge-build\.mjs"/)
  const profile = createPrivateQaTempDirectory('egdesk-launcher-marker-')
  try {
    const resources = path.join(profile, 'chrome', 'resources')
    fs.mkdirSync(resources, { recursive: true })
    const marker = path.join(resources, 'egdesk-bridge-build.json')
    const run = repoRoot => spawnSync('bash', ['-c', `set -euo pipefail\n${block}`], {
      encoding: 'utf8', env: { ...process.env, PROFILE: profile, REPO_ROOT: repoRoot },
    })
    const ok = run(fileURLToPath(new URL('..', import.meta.url)))
    assert.equal(ok.status, 0, ok.stderr)
    assert.equal(ok.stderr, '')
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { buildHash: computeBridgeBuildHash() })
    assert.deepEqual(fs.readdirSync(resources), ['egdesk-bridge-build.json'], 'no temporary file is left')
    // Without helper source the launch continues, warns and drops the stale marker.
    const failed = run(profile)
    assert.equal(failed.status, 0)
    assert.match(failed.stderr, /\[warn\] bridge build hash unavailable/)
    assert.equal(fs.existsSync(marker), false)
  } finally { fs.rmSync(profile, { recursive: true, force: true }) }
})
