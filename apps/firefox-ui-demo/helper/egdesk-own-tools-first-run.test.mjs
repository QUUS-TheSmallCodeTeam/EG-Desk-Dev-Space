// c20: the first-run checklist prints steps and checks preconditions; it runs nothing and never touches ~/.codex.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { firstRunChecks, firstRunPaths, firstRunSteps, formatFirstRun, FIRST_RUN_SOURCES } from './egdesk-own-tools-first-run.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

function fakeHome(t) {
  const home = fs.realpathSync(createPrivateQaTempDirectory('egdesk-first-run-test-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}
const byId = result => Object.fromEntries(result.checks.map(c => [c.id, c]))

test('a fresh machine: every step is still to do, and ~/.codex is never looked at', t => {
  const home = fakeHome(t)
  fs.mkdirSync(path.join(home, '.codex')); fs.writeFileSync(path.join(home, '.codex', 'auth.json'), 'secret')
  const seen = []
  const spy = { statSync: p => { seen.push(p); return fs.statSync(p) }, readdirSync: p => { seen.push(p); return fs.readdirSync(p) }, accessSync: (p, m) => { seen.push(p); return fs.accessSync(p, m) } }
  const result = firstRunChecks({ env: {}, home, platform: 'darwin', fsImpl: spy, nodeVersion: '26.5.0' })
  const c = byId(result)
  assert.equal(result.dataDir, path.join(home, 'Library', 'Application Support', 'EG-Desk'))
  assert.deepEqual(['install_dir', 'codex_bin', 'codex_home', 'signed_in'].map(id => c[id].ok), [false, false, false, false])
  assert.match(c.codex_home.detail, /CODEX_HOME not set/)
  assert.ok(seen.every(p => !p.startsWith(path.join(home, '.codex'))), 'nothing under ~/.codex was touched')
})

test('after the person\'s steps: an owned install, its own home, signed in, an empty engine folder', t => {
  const home = fakeHome(t)
  const dataDir = path.join(home, 'egdesk-data')
  const p = firstRunPaths(dataDir)
  const bin = path.join(p.install, '0.172.0', 'codex')
  fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
  fs.mkdirSync(p.home, { recursive: true }); fs.writeFileSync(path.join(p.home, 'auth.json'), '{}')
  fs.mkdirSync(p.engineFolder, { recursive: true })
  const ok = byId(firstRunChecks({ env: { EGDESK_DATA_DIR: dataDir, EGDESK_CODEX_BIN: bin, CODEX_HOME: p.home, EGDESK_OWN_TOOLS: 'shadow' }, home, nodeVersion: '26.5.0' }))
  assert.ok(Object.values(ok).every(check => check.ok), JSON.stringify(ok))
  assert.match(ok.flags.detail, /EGDESK_OWN_TOOLS=shadow/)
  // the person's own ~/.codex as CODEX_HOME, a binary elsewhere, a stray file in the engine folder: each is flagged
  fs.writeFileSync(path.join(p.engineFolder, 'stray'), 'x')
  const bad = byId(firstRunChecks({ env: { EGDESK_DATA_DIR: dataDir, EGDESK_CODEX_BIN: '/usr/local/bin/codex', CODEX_HOME: path.join(home, '.codex') }, home, nodeVersion: '26.5.0' }))
  assert.deepEqual([bad.codex_bin.ok, bad.codex_home.ok, bad.engine_folder.ok], [false, false, false])
  assert.match(bad.codex_home.detail, /the person's own home/)
})

test('the steps: shadow, then a throwaway folder, then the real folder; official sources cited; rollback last; the script only prints', () => {
  const steps = firstRunSteps(firstRunPaths('/data'))
  assert.deepEqual(steps.map(s => s.step), [0, 1, 2, 3, 4, 5, 6, 7])
  const text = JSON.stringify(steps)
  assert.ok(text.indexOf('EGDESK_OWN_TOOLS=shadow') < text.indexOf('EGDESK_OWN_TOOLS=on'))
  assert.ok(text.indexOf('throwaway') < text.indexOf('The real folder'))
  for (const url of Object.values(FIRST_RUN_SOURCES)) assert.ok(text.includes(url) || text.includes(url.split('#')[0]), url)
  assert.match(text, /Never copy ~\/\.codex\/auth\.json/)
  assert.match(steps.at(-1).title, /Roll back/)
  const printed = formatFirstRun({ checks: [{ id: 'node', ok: true, detail: 'node 26' }], paths: firstRunPaths('/data') })
  assert.match(printed, /prints only; runs nothing/)
  const script = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'egdesk-own-tools-first-run.mjs'), 'utf8')
  assert.doesNotMatch(script, /child_process|spawn|exec|fetch\(|https?:\/\//, 'the script runs nothing and fetches nothing')
  const helper = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'egdesk-own-tools-first-run.mjs'), 'utf8')
  assert.doesNotMatch(helper, /child_process|spawnSync|execSync|fetch\(|readFileSync|writeFileSync|mkdirSync/, 'checks are existence-only')
})
