#!/usr/bin/env node
// L1 c34: live QA driver for "Claude login inside EG-Desk" (bridge flag EGDESK_TERMINAL_OPEN_URL=on). COMPLIANCE FIRST (Anthropic's Claude Code terms): the person completes every
// sign-in step themselves. This driver therefore
//   - touches NOTHING on claude.com / claude.ai / platform.claude.com or any other page: no click, no typing, no account choice, no screenshot of them, and it does not read a card's address,
//     page text or the code (it only learns THAT a second Browser Card appeared, from EG-Desk's own card list),
//   - takes screenshots of EG-Desk's OWN elements only (the Claude row of account settings, the terminal card's title bar), never the whole window, and only when no Browser Card overlaps them,
//   - stops right after the login button was pressed and prints "waiting for the person" (the sign-in page loads by itself in the card the feature opened; the driver does not look at it),
//   - after the person says done (`--resume-after-signin`) reads ONLY the result of the bridge's own POST /engines/claude/refresh (words, never the account label). It does not connect to Firefox then.
// Operationally: it drives the OWNER'S RUNNING EG-Desk through the repo's existing Marionette / firefox-devtools-mcp route (the one scripts/verify-firefox-mcp-*.mjs use:
// --connectExisting, privileged chrome context). It never launches, restarts or kills Firefox (only its own MCP child ends), never closes a window or tab, never remounts the overlay.
// The only write actions: the settings opener and account tab clicks, and the D-S1 login button (all EG-Desk controls).
//   node scripts/egdesk-claude-login-live-qa.mjs --out <dir> [--marionette-port 2828] [--bridge http://127.0.0.1:39218]
//   node scripts/egdesk-claude-login-live-qa.mjs --resume-after-signin [--timeout-min 10] [--bridge ...]
//   node scripts/egdesk-claude-login-live-qa.mjs --dry-run            # prints the plan, connects to nothing
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const TESTIDS = Object.freeze({ login: 'settings-claude-login', result: 'settings-claude-result', claudeRow: 'settings-claude', account: 'settings-account' })

/** The words of the Claude row of POST /engines/claude/refresh: no label, no account. */
export function signedInWords(answer) {
  const row = answer?.engine
  if (!row || typeof row !== 'object') return { known: false, signedIn: false }
  const status = [row.authStatus, row.auth?.status, row.status].find(v => typeof v === 'string') ?? null
  return { known: status !== null, status: status && /^[A-Za-z_ -]{1,24}$/.test(status) ? status : 'unknown', signedIn: status === 'signedIn' }
}
export function parseArgs(argv) {
  const out = { out: null, resume: false, dryRun: false, port: '2828', bridge: 'http://127.0.0.1:39218', timeoutMin: 10 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') out.out = argv[++i]
    else if (a === '--resume-after-signin') out.resume = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--marionette-port') out.port = String(argv[++i])
    else if (a === '--bridge') out.bridge = String(argv[++i])
    else if (a === '--timeout-min') out.timeoutMin = Number(argv[++i])
    else throw new Error(`unknown argument ${a}`)
  }
  if (!/^\d{2,5}$/.test(out.port)) throw new Error('--marionette-port must be a port number')
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(out.bridge)) throw new Error('--bridge must be a loopback http address')
  if (!Number.isFinite(out.timeoutMin) || out.timeoutMin <= 0 || out.timeoutMin > 60) throw new Error('--timeout-min must be 1..60')
  if (!out.resume && !out.dryRun && !out.out) throw new Error('--out <dir> is required (screenshots of EG-Desk\'s own elements go there)')
  return out
}
export const PLAN = Object.freeze([
  'connect to the running Firefox through Marionette (connect only; Firefox is never launched or killed)',
  'open account settings -> Claude section (clicks only on EG-Desk settings controls)',
  'screenshot 01: the Claude row element of account settings (not the whole window)',
  `press the D-S1 login button [data-testid="${TESTIDS.login}"] (the one write action)`,
  'wait for the Terminal card and for a second Browser Card to exist (EG-Desk\'s own card list; no address, page text or page screenshot is read)',
  'screenshot 02: the terminal card title bar element only, and only if no Browser Card overlaps it',
  'STOP: "waiting for the person" (nothing on claude.com is touched, read or captured)',
  '--resume-after-signin: after the person says done, read only POST /engines/claude/refresh until the Claude row is signed in (words only)',
])

// ---- the chrome-side scripts (strings run through evaluate_privileged_script) ----
const helpers = `
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, timeout) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = fn(); if (v) return v; await wait(150); } return null; };
  const q = s => document.querySelector(s);
  const cards = () => [...document.querySelectorAll('.egd-canvas-card')].map(c => ({ id: c.id, kind: c.classList.contains('egd-terminal-card') ? 'terminal' : c.classList.contains('egd-browser-card') ? 'browser' : 'other' }));
`
const shotBody = `
  const overlapsBrowser = r => [...document.querySelectorAll('.egd-browser-card')].some(c => { const b = c.getBoundingClientRect(); return !(b.right <= r.left || b.left >= r.right || b.bottom <= r.top || b.top >= r.bottom); });
  const shot = el => {
    if (!el) return { ok: false, why: 'element missing' };
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return { ok: false, why: 'element not visible' };
    if (overlapsBrowser(r)) return { ok: false, why: 'a Browser Card overlaps this element: not captured' };
    const canvas = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
    canvas.width = Math.ceil(r.width); canvas.height = Math.ceil(r.height);
    canvas.getContext('2d').drawWindow(window, r.left + window.scrollX, r.top + window.scrollY, r.width, r.height, 'rgb(30,30,30)');
    return { ok: true, dataUrl: canvas.toDataURL('image/jpeg', 0.85) };
  };
`
export const scripts = {
  state: `(() => { ${helpers} return { hasLogin: !!q('[data-testid="${TESTIDS.login}"]'), cards: cards(),
    testids: [...document.querySelectorAll('[data-testid*="settings"]')].map(e => e.getAttribute('data-testid')).slice(0, 40),
    railLabels: [...document.querySelectorAll('#egd-desk-rail button, #egd-dock button')].map(b => (b.getAttribute('aria-label') || b.title || b.getAttribute('data-testid') || '').trim()).filter(Boolean).slice(0, 30) }; })()`,
  openSettings: `(async () => { ${helpers}
    if (q('[data-testid="${TESTIDS.login}"]')) return { opened: true, already: true };
    const opener = [...document.querySelectorAll('#egd-desk-rail button, #egd-dock button, #egd-hud button')].find(b => /설정|settings/i.test(b.getAttribute('aria-label') || b.title || ''));
    if (!opener) return { opened: false, why: 'no settings control found in the rail, dock or hud' };
    opener.click();
    const tab = await waitFor(() => q('[data-testid="${TESTIDS.account}"]'), 5000);
    if (tab && typeof tab.click === 'function') tab.click();
    const login = await waitFor(() => q('[data-testid="${TESTIDS.login}"]'), 8000);
    return { opened: !!login, why: login ? null : 'the Claude login button did not appear (maybe already signed in, or the Claude row is not shown)' };
  })()`,
  shotClaudeRow: `(() => { ${helpers} ${shotBody} return shot(q('[data-testid="${TESTIDS.claudeRow}"]')); })()`,
  press: `(async () => { ${helpers}
    const before = cards(); const button = q('[data-testid="${TESTIDS.login}"]');
    if (!button) return { pressed: false, why: 'login button missing' };
    if (button.disabled) return { pressed: false, why: 'login button disabled (busy or not signed out)' };
    button.click();
    const terminal = await waitFor(() => cards().find(c => c.kind === 'terminal' && !before.some(b => b.id === c.id)), 20000);
    const result = await waitFor(() => { const r = q('[data-testid="${TESTIDS.result}"]'); return r && r.getAttribute('data-phase') ? r.getAttribute('data-phase') : null; }, 20000);
    const browser = await waitFor(() => cards().find(c => c.kind === 'browser' && !before.some(b => b.id === c.id)), 90000);
    return { pressed: true, terminalCardId: terminal ? terminal.id : null, resultPhase: result, browserCard: !!browser };
  })()`,
  shotTerminalBar: id => `(() => { ${helpers} ${shotBody} const card = document.getElementById(${JSON.stringify(id)}); return shot(card && card.querySelector('.egd-desk-window-titlebar')); })()`,
}

// ---- MCP client (the same protocol as scripts/verify-firefox-mcp-*.mjs; connectExisting only) ----
function startMcp({ port }) {
  const proc = spawn('npx', ['-y', process.env.EGDESK_FIREFOX_MCP_PACKAGE || '@mozilla/firefox-devtools-mcp-moz@latest', '--connectExisting', '--marionettePort', String(port), '--enablePrivilegedContext', '--enableScript'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let nextId = 1, buffer = ''
  const pending = new Map()
  proc.stdout.on('data', chunk => {
    buffer += chunk.toString(); let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1)
      if (!line.startsWith('{')) continue
      let message; try { message = JSON.parse(line) } catch { continue }
      const p = message.id && pending.get(message.id)
      if (p) { pending.delete(message.id); message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result) }
    }
  })
  proc.on('exit', () => { for (const p of pending.values()) p.reject(new Error('MCP server exited')); pending.clear() })
  const request = (method, params = {}, timeoutMs = 60000) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)) }, timeoutMs)
    pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v) }, reject: e => { clearTimeout(timer); reject(e) } })
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const text = r => (r?.content || []).map(i => i.text || '').join('\n')
  const json = t => { const s = String(t || '').trim(); if (s.startsWith('Error:')) throw new Error(s); const f = s.match(/```json\s*\n([\s\S]*?)\n```/); return JSON.parse(f ? f[1] : s.startsWith('Result:') ? s.slice(7).trim() : s) }
  const tool = (name, args = {}, timeoutMs = 60000) => request('tools/call', { name, arguments: args }, timeoutMs)
  return { proc, request, tool, text, json, notify: (method, params = {}) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n') }
}

async function connect(opts) {
  const mcp = startMcp({ port: opts.port })
  await mcp.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'egdesk-claude-login-live-qa', version: '0.2.0' } })
  mcp.notify('notifications/initialized')
  const contexts = mcp.text(await mcp.tool('list_privileged_contexts'))
  const match = contexts.match(/\s([0-9a-f-]{36}): chrome:\/\/browser\/content\/browser\.xhtml/)
  if (!match) throw new Error(`Firefox chrome context not found. Is EG-Desk running with Marionette on ${opts.port}?\n${contexts}`)
  await mcp.tool('select_privileged_context', { contextId: match[1] })
  const run = async (name, arg, timeoutMs = 120000) => { const body = typeof scripts[name] === 'function' ? scripts[name](arg) : scripts[name]; return mcp.json(mcp.text(await mcp.tool('evaluate_privileged_script', { function: `() => (\n${body}\n)` }, timeoutMs))) }
  return { run, close: () => { try { mcp.proc.stdin.end() } catch {} setTimeout(() => mcp.proc.kill('SIGTERM'), 500) } }
}

const save = (dir, name, shot) => {
  if (!shot?.ok || typeof shot.dataUrl !== 'string' || !shot.dataUrl.startsWith('data:image/jpeg;base64,')) { console.log(`screenshot ${name}: skipped (${shot?.why ?? 'unavailable'})`); return }
  const file = path.join(dir, name); writeFileSync(file, Buffer.from(shot.dataUrl.slice('data:image/jpeg;base64,'.length), 'base64')); console.log(`screenshot: ${file}`)
}

async function startRun(opts) {
  mkdirSync(opts.out, { recursive: true })
  const { run, close } = await connect(opts)
  try {
    const open = await run('openSettings')
    if (!open.opened) { const s = await run('state'); console.log(JSON.stringify({ step: 'open-settings', ...open, seen: { testids: s.testids, railLabels: s.railLabels } }, null, 2)); process.exitCode = 3; return }
    save(opts.out, '01-claude-row-before-login.jpg', await run('shotClaudeRow'))
    const press = await run('press')
    console.log(JSON.stringify({ step: 'login-pressed', ...press }, null, 2))
    if (press.terminalCardId) save(opts.out, '02-terminal-title-bar.jpg', await run('shotTerminalBar', press.terminalCardId))
    if (!press.pressed || !press.terminalCardId || !press.browserCard) { console.log('CHECK FAILED: the terminal card and a second Browser Card did not both appear (see the checklist, step 3).'); process.exitCode = 2; return }
    console.log('waiting for the person: they sign in inside the Browser Card, copy the code into the terminal card themselves, then say done. Then run with --resume-after-signin.')
  } finally { close() }
}

async function resumeRun(opts) {
  const deadline = Date.now() + opts.timeoutMin * 60_000
  let last = null
  while (Date.now() < deadline) {
    const res = await fetch(`${opts.bridge}/engines/claude/refresh`, { method: 'POST' }).then(r => r.json()).catch(() => null)
    const words = signedInWords(res)
    if (JSON.stringify(words) !== JSON.stringify(last)) { console.log(`claude row: ${JSON.stringify(words)}`); last = words }
    if (words.signedIn) { console.log('SIGNED IN: the Claude row shows signed in after the refresh'); return }
    await new Promise(r => setTimeout(r, 3000))
  }
  console.log('TIMEOUT: the Claude row did not become signed in'); process.exitCode = 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts
  try { opts = parseArgs(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exit(64) }
  if (opts.dryRun) { PLAN.forEach((line, i) => console.log(`${i + 1}. ${line}`)); process.exit(0) }
  ;(opts.resume ? resumeRun(opts) : startRun(opts)).catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })
}
