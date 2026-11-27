import net from 'node:net'
import { lock as egdLock } from './mlock.mjs'
await egdLock()
const [, , xs, ys] = process.argv; const x = Number(xs), y = Number(ys)
const sock = net.connect(2828, '127.0.0.1'); let buf = Buffer.alloc(0); let id = 0; const w = new Map(); let hello = false
sock.on('data', d => { buf = Buffer.concat([buf, d]); for (;;) { const i = buf.indexOf(':'); if (i < 0) return; const n = parseInt(buf.slice(0, i).toString(), 10); if (buf.length < i + 1 + n) return; const m = JSON.parse(buf.slice(i + 1, i + 1 + n).toString()); buf = buf.slice(i + 1 + n); if (!Array.isArray(m)) { hello = true; w.get('h')?.(); continue } const f = w.get(m[1]); if (f) { w.delete(m[1]); f(m) } } })
const send = (name, p = {}) => new Promise(r => { const mid = ++id; w.set(mid, r); const s = JSON.stringify([0, mid, name, p]); sock.write(`${Buffer.byteLength(s)}:${s}`) })
const newSession = async caps => { for (let i = 0; i < 120; i++) { const r = await send('WebDriver:NewSession', caps); const err = Array.isArray(r) ? r[2] : r && r.error; if (!err || !/Maximum number of active sessions|session not created/.test(JSON.stringify(err))) return r; await new Promise(res => setTimeout(res, 150 + Math.random() * 100)) } return send('WebDriver:NewSession', caps) }
await new Promise(r => hello ? r() : w.set('h', r)); await newSession({ capabilities: {} }); await send('Marionette:SetContext', { value: 'chrome' })
const r = await send('WebDriver:PerformActions', { actions: [{ type: 'pointer', id: 'm', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport' }, { type: 'pause', duration: 300 }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] })
console.log(r[2] ? 'error ' + JSON.stringify(r[2]).slice(0, 200) : 'clicked ' + x + ',' + y); await send('WebDriver:ReleaseActions'); await send('WebDriver:DeleteSession'); sock.end(); process.exit(0)
