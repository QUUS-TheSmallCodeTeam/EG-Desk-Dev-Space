import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { PLAN, parseArgs, scripts, signedInWords } from './egdesk-claude-login-live-qa.mjs'

// The live QA driver's own rules (it needs a running EG-Desk, so only what can be checked without one). Compliance: the person signs in themselves; the driver neither touches nor reads nor
// captures any sign-in page, and never the whole window.
const path = fileURLToPath(new URL('./egdesk-claude-login-live-qa.mjs', import.meta.url))
const source = readFileSync(path, 'utf8')
const bodies = Object.values(scripts).map(s => (typeof s === 'function' ? s('terminal-card-1') : s))

test('the chrome-side scripts parse and read nothing of any page: no address, no page text, no input value, no cookie, no file', () => {
  for (const body of bodies) assert.doesNotThrow(() => new vm.Script(`(${body})`))
  const all = bodies.join('\n')
  assert.ok(!/\.search\b|\.href\b|\.hash\b|\.value\b|innerText|textContent|contentDocument|contentWindow|outerHTML|innerHTML|cookie|localStorage|IOUtils|fetch\(|XMLHttpRequest|_sourceRef|new URL|input\[/.test(all), 'only EG-Desk\'s own controls and card list')
  assert.ok(!/claude\.(com|ai)|anthropic|platform\.|oauth|authorize|callback/i.test(all), 'no sign-in address or page is named')
})

test('the only clicks are the settings opener, the account tab and the login button; nothing is closed, removed or remounted', () => {
  const all = bodies.join('\n')
  assert.deepEqual([...all.matchAll(/(\w+)\.click\(\)/g)].map(m => m[1]).sort(), ['button', 'opener', 'tab'])
  assert.ok(!/\.remove\(|\.close\(|requestClose|removeChild|loadSubScript|__egdesk|\.type\(|dispatchEvent|\.focus\(|sendKeys/.test(all))
})

test('screenshots are of EG-Desk\'s own elements only: never the whole window, never with a Browser Card over them, never saved when skipped', () => {
  assert.ok(!/screenshot_page|take_screenshot|screenshot_/.test(source.replace(/\/\/.*$/gm, '')), 'the whole-window screenshot tool is not used')
  const shot = bodies.find(b => b.includes('shotClaudeRow') || b.includes('drawWindow')); assert.ok(shot.includes('overlapsBrowser(r)') && shot.includes('not captured'))
  assert.ok(bodies.filter(b => b.includes('drawWindow')).every(b => b.includes('overlapsBrowser')))
  assert.match(bodies.find(b => b.includes('terminal-card-1')), /egd-desk-window-titlebar/, 'the terminal card is captured by its title bar, not its content (the line with the address)')
  assert.ok(!/egd-terminal-body|\.xterm|iframe/.test(bodies.join('\n')), 'no terminal content')
})

test('the driver never launches or kills Firefox, connects to the running one, and the resume step does not connect at all', () => {
  assert.ok(!/\bpkill\b|killall|SIGKILL|launch\(|run-firefox|spawn\('(firefox|open)|execFile|exec\(/.test(source.replace(/^\/\/.*$/gm, '').replace("proc.kill('SIGTERM')", '')), 'only its own MCP child ends')
  assert.match(source, /--connectExisting/)
  const resume = source.slice(source.indexOf('async function resumeRun'), source.indexOf('if (process.argv[1]'))
  assert.ok(!/connect\(|mcp|run\(/.test(resume) && /\/engines\/claude\/refresh/.test(resume), 'resume reads the bridge refresh only')
})

test('the refresh row is reduced to words: no label, no account', () => {
  assert.deepEqual(signedInWords({ engine: { authStatus: 'signedIn', label: 'Claude Max', account: 'me@example.com' } }), { known: true, status: 'signedIn', signedIn: true })
  assert.deepEqual(signedInWords({ engine: { authStatus: 'signedOut' } }), { known: true, status: 'signedOut', signedIn: false })
  assert.equal(signedInWords({ engine: { authStatus: 'me@example.com!' } }).status, 'unknown'); assert.deepEqual(signedInWords(null), { known: false, signedIn: false })
  assert.ok(!JSON.stringify(signedInWords({ engine: { authStatus: 'signedIn', account: 'me@example.com' } })).includes('example'))
})

test('arguments: an output folder for the start, loopback only for the bridge, bounded wait', () => {
  assert.throws(() => parseArgs([]), /--out/); assert.equal(parseArgs(['--out', '/tmp/x']).port, '2828'); assert.equal(parseArgs(['--resume-after-signin']).resume, true)
  assert.throws(() => parseArgs(['--out', '/tmp/x', '--bridge', 'http://evil.example:39218']), /loopback/); assert.throws(() => parseArgs(['--out', '/tmp/x', '--marionette-port', 'x']), /port/)
  assert.throws(() => parseArgs(['--resume-after-signin', '--timeout-min', '0']), /timeout/); assert.throws(() => parseArgs(['--nope']), /unknown/)
})

test('--dry-run prints the plan and connects to nothing', () => {
  const out = execFileSync(process.execPath, [path, '--dry-run'], { encoding: 'utf8', timeout: 10000 })
  assert.equal(out.trim().split('\n').length, PLAN.length); assert.match(out, /never launched or killed/); assert.match(out, /nothing on claude\.com is touched/)
})
