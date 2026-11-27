// c25 (Main's check-6 on the person's real install): --persisted-with-cleanup refused to start because "the binary's generated schema has no thread/delete", although the
// official 0.171 schema HAS it. The schema was never the problem: the binary's fingerprint was. The ChatGPT desktop app's launcher (bin/codex, a 328-byte /bin/sh script that
// execs ../CodexCLI.app/Contents/MacOS/codex) was refused as "Unrecognized Codex launcher", which closed thread/delete and (c23) turn/steer on exactly that install.
// These tests use the launcher's real text, the real 0.171 schema files (scripts/real-engine/fixtures) and a fake CLI that answers --version and writes them; nothing runs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprintNativeExecutable, verifyThreadDeleteSchema, verifyTurnSteerSchema } from './codex-native-schema-probe.mjs'
import { inspectNativeCapabilities } from './egdesk-native-capabilities.mjs'
import { DECISION_KEY_ENV, assertCleanupGuaranteed, parseArgs } from './egdesk-real-engine-check.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = name => fs.readFileSync(path.join(here, '..', 'scripts', 'real-engine', 'fixtures', `${name}-0.171.0-alpha.13.json`), 'utf8')
// the launcher exactly as shipped in ChatGPT.app (Contents/Resources/codex-cli/bin/codex)
const LAUNCHER = `#!/bin/sh
set -eu
entry="$0"
while [ -L "$entry" ]; do
  parent=$(CDPATH= cd -P -- "$(dirname -- "$entry")" && pwd)
  entry=$(readlink "$entry")
  case "$entry" in /*) ;; *) entry="$parent/$entry" ;; esac
done
bin_dir=$(CDPATH= cd -P -- "$(dirname -- "$entry")" && pwd)
exec "$bin_dir/../CodexCLI.app/Contents/MacOS/codex" "$@"
`
function install(t, { launcher = LAUNCHER, native = 'native codex v1' } = {}) {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-launcher-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const cli = path.join(base, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli')
  fs.mkdirSync(path.join(cli, 'bin'), { recursive: true }); fs.mkdirSync(path.join(cli, 'CodexCLI.app', 'Contents', 'MacOS'), { recursive: true })
  const wrapper = path.join(cli, 'bin', 'codex'), nativePath = path.join(cli, 'CodexCLI.app', 'Contents', 'MacOS', 'codex')
  fs.writeFileSync(wrapper, launcher, { mode: 0o755 }); if (native !== null) fs.writeFileSync(nativePath, native, { mode: 0o755 })
  return { base, wrapper, nativePath }
}
const union = (...methods) => JSON.stringify({ oneOf: methods.map(method => ({ properties: { method: { enum: [method] } } })) })
/** The CLI of that install, as a fake run: --version answers the banner, generate-json-schema writes the schema files of 0.171.0-alpha.13 into --out.
 * L4 a1: 0.171.0-alpha.13 is a pinned contract version now, so thread/delete and steer come from its ONE full probe: the fake writes the real files that
 * probe reads (fixtures/native-schema-0.171.0-alpha.13) as the real binary does; ClientRequest and the delete/steer files stay the test's own. */
function fakeCli({ version = '0.171.0-alpha.13', withDelete = true, withSteer = true } = {}) {
  const calls = []
  const run = (file, args) => {
    calls.push([file, args])
    if (args[0] === '--version') return { status: 0, stdout: `codex-cli ${version}\n` }
    if (args[0] === 'app-server' && args[1] === 'generate-json-schema') {
      const out = args[args.indexOf('--out') + 1]
      fs.cpSync(path.join(here, '..', 'scripts', 'real-engine', 'fixtures', 'native-schema-0.171.0-alpha.13'), out, { recursive: true })
      fs.mkdirSync(path.join(out, 'v2'), { recursive: true })
      fs.writeFileSync(path.join(out, 'ClientRequest.json'), union('thread/start', ...(withDelete ? ['thread/delete'] : []), ...(withSteer ? ['turn/steer'] : [])))
      for (const name of ['ThreadDeleteParams', 'ThreadDeleteResponse', 'TurnSteerParams', 'TurnSteerResponse']) fs.writeFileSync(path.join(out, 'v2', `${name}.json`), fixture(name))
      return { status: 0, stdout: '' }
    }
    return { status: 1, stdout: '' }
  }
  return { run, calls }
}
const HEX = /^[a-f0-9]{64}$/

test('the real 0.171 schema files pass the product\'s thread/delete and turn/steer verifiers', () => {
  const union2 = JSON.parse(union('thread/delete', 'turn/steer'))
  assert.equal(verifyThreadDeleteSchema(union2, JSON.parse(fixture('ThreadDeleteParams')), JSON.parse(fixture('ThreadDeleteResponse'))), true)
  assert.equal(verifyTurnSteerSchema(union2, JSON.parse(fixture('TurnSteerParams')), JSON.parse(fixture('TurnSteerResponse'))), true)
})

test('the ChatGPT.app launcher is fingerprinted with the native binary it execs; a changed binary or launcher changes it; anything else stays unrecognized', t => {
  const a = install(t)
  const first = fingerprintNativeExecutable(a.wrapper)
  assert.match(first, HEX); assert.equal(fingerprintNativeExecutable(a.wrapper), first, 'stable')
  fs.writeFileSync(a.nativePath, 'native codex v2'); assert.notEqual(fingerprintNativeExecutable(a.wrapper), first, 'a replaced native binary changes it')
  const b = install(t, { launcher: `${LAUNCHER}# a comment line\n` })
  assert.throws(() => fingerprintNativeExecutable(b.wrapper), /Unrecognized Codex launcher/, 'a script that is not exactly the launcher is not accepted (a comment line is a different script)')
  const c = install(t, { launcher: LAUNCHER.replace('exec "$bin_dir/../CodexCLI.app/Contents/MacOS/codex" "$@"', 'exec "$bin_dir/../CodexCLI.app/Contents/MacOS/codex" "$@"\nrm -rf "$HOME"') })
  assert.throws(() => fingerprintNativeExecutable(c.wrapper), /Unrecognized Codex launcher/)
  const d = install(t, { launcher: '#!/bin/sh\nexec /tmp/other-codex "$@"\n' })
  assert.throws(() => fingerprintNativeExecutable(d.wrapper), /Unrecognized Codex launcher/)
  const e = install(t, { native: null })
  assert.throws(() => fingerprintNativeExecutable(e.wrapper), 'a launcher whose native binary is missing is not fingerprinted')
  // reached through a symlink, the launcher resolves to the same physical install
  const link = path.join(a.base, 'link-codex'); fs.symlinkSync(a.wrapper, link)
  assert.equal(fingerprintNativeExecutable(a.wrapper), fingerprintNativeExecutable(a.wrapper))
  fs.writeFileSync(a.nativePath, 'native codex v1')
  assert.equal(fingerprintNativeExecutable(a.wrapper), first, 'back to the first bytes: the first fingerprint')
})

test('inspectNativeCapabilities on that install reads thread/delete and the steer contract from the binary\'s own schema (real fingerprint, real schema files, fake CLI)', t => {
  const a = install(t), cli = fakeCli()
  const native = inspectNativeCapabilities({ executable: a.wrapper, env: {}, cwd: a.base, run: cli.run })
  assert.equal(native.version, '0.171.0-alpha.13')
  assert.equal(native.threadDelete, true, 'thread/delete is in the binary\'s schema: the launcher no longer hides it')
  assert.match(native.steerContract, HEX)
  assert.ok(cli.calls.every(([file]) => file === a.wrapper), 'only the given binary was asked')
  // the previous behaviour, kept for what is not the launcher: no capability from a script nobody recognises
  const other = install(t, { launcher: '#!/bin/sh\nprintf "codex-cli 0.171.0-alpha.13\\n"\n' })
  const closed = inspectNativeCapabilities({ executable: other.wrapper, env: {}, cwd: other.base, run: fakeCli().run })
  assert.equal(closed.threadDelete, false); assert.equal(closed.steerContract, null)
  // a schema without thread/delete does not grant it, with the launcher recognised
  const noDelete = inspectNativeCapabilities({ executable: a.wrapper, env: {}, cwd: a.base, run: fakeCli({ withDelete: false }).run })
  assert.equal(noDelete.threadDelete, false); assert.match(noDelete.steerContract, HEX)
})

test('--persisted-with-cleanup starts on that install: the guarantee reads thread/delete through the launcher; an install without it is still refused', t => {
  const a = install(t)
  const options = (extra = {}) => ({ ...parseArgs(['--codex-bin', a.wrapper, '--person-home', '--script', 'x.json', '--out', path.join(a.base, 'out'), '--persisted-with-cleanup'], {}), ...extra })
  assert.doesNotThrow(() => assertCleanupGuaranteed(options(), { run: fakeCli().run }, { PATH: '/usr/bin', HOME: a.base }))
  assert.throws(() => assertCleanupGuaranteed(options(), { run: fakeCli({ withDelete: false }).run }, { PATH: '/usr/bin' }), { code: 'cleanup_not_guaranteed' })
  const other = install(t, { launcher: '#!/bin/sh\nexec /tmp/x "$@"\n' })
  assert.throws(() => assertCleanupGuaranteed({ ...options(), codexBin: other.wrapper }, { run: fakeCli().run }, {}), { code: 'cleanup_not_guaranteed' })
  void DECISION_KEY_ENV
})
