// Fresh read-only observation of a Card through the product's own path: toolObserve(toolBinding(), opts). Saves to a file; prints only shape (no page text).
import net from 'node:net'; import fs from 'node:fs'
import { lock as egdLock } from './mlock.mjs'
await egdLock()
const [, , cardId, out] = process.argv
const sock = net.connect(2828, '127.0.0.1'); let buf = Buffer.alloc(0); let id = 0; const w = new Map(); let hello = false
sock.on('data', d => { buf = Buffer.concat([buf, d]); for (;;) { const i = buf.indexOf(':'); if (i < 0) return; const n = parseInt(buf.slice(0, i).toString(), 10); if (buf.length < i + 1 + n) return; const m = JSON.parse(buf.slice(i + 1, i + 1 + n).toString()); buf = buf.slice(i + 1 + n); if (!Array.isArray(m)) { hello = true; w.get('h')?.(); continue } const f = w.get(m[1]); if (f) { w.delete(m[1]); f(m) } } })
const send = (name, p = {}) => new Promise(r => { const mid = ++id; w.set(mid, r); const s = JSON.stringify([0, mid, name, p]); sock.write(`${Buffer.byteLength(s)}:${s}`) })
const newSession = async caps => { for (let i = 0; i < 120; i++) { const r = await send('WebDriver:NewSession', caps); const err = Array.isArray(r) ? r[2] : r && r.error; if (!err || !/Maximum number of active sessions|session not created/.test(JSON.stringify(err))) return r; await new Promise(res => setTimeout(res, 150 + Math.random() * 100)) } return send('WebDriver:NewSession', caps) }
await new Promise(r => hello ? r() : w.set('h', r))
await newSession({ capabilities: { alwaysMatch: { 'moz:accessibilityChecks': false } } }); await send('Marionette:SetContext', { value: 'chrome' })
const r = await send('WebDriver:ExecuteAsyncScript', { sandbox: 'system', args: [cardId], script: `const [cardId, done] = arguments; const bc = document.getElementById(cardId)._browserControls;
  Promise.resolve().then(() => bc.toolObserve(bc.toolBinding(), { textLimit: 80, elementLimit: 80 })).then(s => done(JSON.parse(JSON.stringify(s)))).catch(e => done({ error: String(e).slice(0, 200) }))` })
const v = r[2] ? { error: String(r[2].message || r[2].error).slice(0, 200) } : (r[3]?.value ?? r[3])
fs.writeFileSync(out, JSON.stringify(v)); const s = v.snapshot || v; const els = s.interactiveElements || []
let path = ''; try { const u = new URL(s.url); path = u.host + u.pathname + (u.search ? '?…' : '') } catch {}
console.log(JSON.stringify({ topKeys: Object.keys(v).slice(0, 14), page: path, elements: els.length, error: v.error }))
await send('WebDriver:DeleteSession'); sock.end(); process.exit(0)
