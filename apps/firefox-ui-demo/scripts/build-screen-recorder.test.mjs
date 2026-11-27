import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// egdesk-screen-recorder (temporary name, L44): the build script and the tool's argument/permission-free behaviour. A real swiftc build happens once (macOS only).
const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, 'build-screen-recorder.sh')
const source = path.join(here, '..', 'helper-native', 'screen-recorder', 'main.swift')

test('the build script uses swiftc with the four frameworks and writes under git-ignored .tmp/bin by default', () => {
  const text = readFileSync(script, 'utf8')
  assert.match(text, /swiftc -O/); for (const fw of ['ScreenCaptureKit', 'AVFoundation', 'CoreMedia', 'CoreVideo']) assert.match(text, new RegExp(`-framework ${fw}`))
  assert.match(text, /\.tmp\/bin\/egdesk-screen-recorder/)
  let ignored = null
  try { ignored = spawnSync('git', ['check-ignore', '-q', path.join(here, '..', '.tmp', 'bin', 'egdesk-screen-recorder')]) } catch {}
  if (ignored && !ignored.error) assert.equal(ignored.status, 0, '.tmp/bin is ignored by git')   // the gate blocks process spawns: then only the script text is checked
})

test('the source filters by the owning process id and never records the whole display unfiltered', () => {
  const text = readFileSync(source, 'utf8')
  assert.match(text, /owningApplication\?\.processID == pid/); assert.match(text, /SCContentFilter\(display: [a-z]+, including: [a-z]+\)/)
  assert.doesNotMatch(text, /excludingWindows|SCContentFilter\(desktopIndependentWindow/, 'no exclude-style filter: an unknown window must not get in')
})

test('real swiftc build; usage errors exit 2 with a JSON error line; a pid without windows ends with an error, not an empty file', { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/swiftc') }, t => {
  try { execFileSync('/usr/bin/swiftc', ['--version'], { stdio: 'ignore' }) } catch { return t.skip('process spawn is not available here') }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-rec-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bin = path.join(dir, 'egdesk-screen-recorder')
  execFileSync('bash', [script, bin], { stdio: 'pipe', timeout: 110_000 })
  assert.ok(statSync(bin).size > 10_000)
  const usage = spawnSync(bin, ['--pid', 'x'], { encoding: 'utf8' })
  assert.equal(usage.status, 2); assert.equal(JSON.parse(usage.stdout.trim().split('\n').pop()).reason, 'usage')
  const out = path.join(dir, 'x.mp4')
  const one = spawnSync(bin, ['--pid', '1', '--out', out], { encoding: 'utf8', timeout: 20_000 })
  assert.equal(one.status, 2, 'pid <= 1 is a usage error')
  const nowin = spawnSync(bin, ['--pid', String(process.pid), '--out', out], { encoding: 'utf8', timeout: 20_000 })   // node has no window
  assert.equal(nowin.status, 1); assert.match(JSON.parse(nowin.stdout.trim().split('\n').pop()).reason, /^(no-window|screen-recording-permission|no-frames)$/); assert.equal(existsSync(out), false)
})
