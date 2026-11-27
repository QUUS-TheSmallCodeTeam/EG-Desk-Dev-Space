// Minimal Marionette client: node mn.mjs exec '<chrome js returning JSON-able>' | shot <file.png> | contentexec '<js>'
import net from 'node:net'; import fs from 'node:fs'
import { lock as egdLock } from './mlock.mjs'
await egdLock()
const [, , cmd, arg, arg2] = process.argv
const sock = net.connect(2828, '127.0.0.1'); let buf = Buffer.alloc(0); let id = 0; const waiters = new Map(); let hello = null
sock.on('data', d => { buf = Buffer.concat([buf, d]); for (;;) { const i = buf.indexOf(':'); if (i < 0) return; const n = parseInt(buf.slice(0, i).toString(), 10); if (buf.length < i + 1 + n) return; const msg = JSON.parse(buf.slice(i + 1, i + 1 + n).toString()); buf = buf.slice(i + 1 + n); if (!Array.isArray(msg)) { hello = msg; waiters.get('hello')?.(msg); continue } const [, mid, err, res] = msg; const w = waiters.get(mid); if (w) { waiters.delete(mid); w(err ? { error: err } : { result: res }) } } })
const send = (name, params = {}) => new Promise(r => { const mid = ++id; waiters.set(mid, r); const s = JSON.stringify([0, mid, name, params]); sock.write(`${Buffer.byteLength(s)}:${s}`) })
const newSession = async caps => { for (let i = 0; i < 120; i++) { const r = await send('WebDriver:NewSession', caps); const err = Array.isArray(r) ? r[2] : r && r.error; if (!err || !/Maximum number of active sessions|session not created/.test(JSON.stringify(err))) return r; await new Promise(res => setTimeout(res, 150 + Math.random() * 100)) } return send('WebDriver:NewSession', caps) }
await new Promise(r => hello ? r() : waiters.set('hello', r))
const ns = await newSession({ capabilities: { alwaysMatch: { 'moz:accessibilityChecks': false } } }); if (ns.error) { console.log('session error', JSON.stringify(ns.error).slice(0, 300)); process.exit(1) }
await send('Marionette:SetContext', { value: cmd === 'contentexec' ? 'content' : 'chrome' })
let out
if (cmd === 'exec' || cmd === 'contentexec') { const r = await send('WebDriver:ExecuteScript', { script: arg, args: [], sandbox: cmd === 'exec' ? 'system' : null }); out = r.error ? { error: r.error.message || r.error } : r.result.value }
else if (cmd === 'shot') { const r = await send('WebDriver:TakeScreenshot', { full: false, hash: false }); if (r.error) out = { error: r.error }; else { fs.writeFileSync(arg, Buffer.from(r.result.value, 'base64')); out = { saved: arg } } }
else if (cmd === 'windows') { out = (await send('WebDriver:GetChromeWindowHandles')).result }
console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 0).slice(0, arg2 ? Number(arg2) : 4000))
await send('WebDriver:DeleteSession'); sock.end(); process.exit(0)
