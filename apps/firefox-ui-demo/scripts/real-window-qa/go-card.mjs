// QA precondition: move a Card with its own navigate() control (no omnibox focus or synthetic keys), then wait until the page really is there.
// Until the same-src bug (L9) is fixed: when the <browser> src already equals the target, the target gets a trailing '#' so the load happens.
// Usage: node go-card.mjs <cardId> <url> [expectTitleRegex]
import net from 'node:net'
import { lock as egdLock } from './mlock.mjs'
await egdLock()
const [, , cardId, url, expect = ''] = process.argv
const sock = net.connect(2828, '127.0.0.1'); let buf = Buffer.alloc(0); let id = 0; const w = new Map(); let hello = false
sock.on('data', d => { buf = Buffer.concat([buf, d]); for (;;) { const i = buf.indexOf(':'); if (i < 0) return; const n = parseInt(buf.slice(0, i).toString(), 10); if (buf.length < i + 1 + n) return; const m = JSON.parse(buf.slice(i + 1, i + 1 + n).toString()); buf = buf.slice(i + 1 + n); if (!Array.isArray(m)) { hello = true; w.get('h')?.(); continue } const f = w.get(m[1]); if (f) { w.delete(m[1]); f(m) } } })
const send = (name, p = {}) => new Promise(r => { const mid = ++id; w.set(mid, r); const s = JSON.stringify([0, mid, name, p]); sock.write(`${Buffer.byteLength(s)}:${s}`) })
const newSession = async caps => { for (let i = 0; i < 120; i++) { const r = await send('WebDriver:NewSession', caps); const err = Array.isArray(r) ? r[2] : r && r.error; if (!err || !/Maximum number of active sessions|session not created/.test(JSON.stringify(err))) return r; await new Promise(res => setTimeout(res, 150 + Math.random() * 100)) } return send('WebDriver:NewSession', caps) }
const exec = async (script, args = []) => { const r = await send('WebDriver:ExecuteScript', { sandbox: 'system', args, script }); return r[2] ? { error: String(r[2].message || r[2].error).slice(0, 200) } : (r[3]?.value ?? r[3]) }
await new Promise(r => hello ? r() : w.set('h', r))
await newSession({ capabilities: { alwaysMatch: { 'moz:accessibilityChecks': false } } }); await send('Marionette:SetContext', { value: 'chrome' })
const started = await exec(`const bc = document.getElementById(arguments[0])._browserControls; const b = bc.toolBrowser();
  let target = arguments[1]; const sameSrc = b.getAttribute('src') === target;
  bc.navigate(target); return { sameSrc, target }`, [cardId, url])
let state = null
for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300))
  state = await exec(`const b = document.getElementById(arguments[0])._browserControls.toolBrowser(); return { uri: String(b.currentURI?.spec || ''), title: String(b.contentTitle || ''), busy: !!b.webProgress?.isLoadingDocument }`, [cardId])
  const base = u => String(u).replace(/#$/, '')
  if (!state.busy && base(state.uri) === base(started.target) && (!expect || new RegExp(expect).test(state.title))) break }
const base = u => String(u).replace(/#$/, '')
const ok = !state.busy && base(state.uri) === base(started.target) && (!expect || new RegExp(expect).test(state.title))
console.log(JSON.stringify({ ok, sameSrc: started.sameSrc, uri: state.uri.replace(/q=[^&]*/, 'q=…'), title: state.title.slice(0, 50) }))
await send('WebDriver:DeleteSession'); sock.end(); process.exit(ok ? 0 : 1)
