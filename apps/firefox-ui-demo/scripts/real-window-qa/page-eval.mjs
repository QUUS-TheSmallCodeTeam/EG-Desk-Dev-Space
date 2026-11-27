// QA only, read-only: evaluate one expression in a Card's page (top document) through a one-shot frame script and print its JSON result.
// Usage: node page-eval.mjs <cardId> '<expression using document/window/location>'
import net from 'node:net'
import { lock as egdLock } from './mlock.mjs'
await egdLock()
const cardId = process.argv[2]
// data: frame scripts are decoded as Latin-1: send every non-ASCII character as a \uXXXX escape (valid in strings and regex literals)
const expr = String(process.argv[3] ?? 'null').replace(/[\u0080-\uffff]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
const frameScript = topic => `(function (topic) { let out; try { const document = content.document, window = content, location = content.location; out = { value: JSON.parse(JSON.stringify((${expr}))) } } catch (e) { out = { error: String(e).slice(0, 200) } } sendAsyncMessage(topic, out) })(${JSON.stringify(topic)})`
const sock = net.connect(2828, '127.0.0.1'); let buf = Buffer.alloc(0); let id = 0; const w = new Map(); let hello = false
sock.on('data', d => { buf = Buffer.concat([buf, d]); for (;;) { const i = buf.indexOf(':'); if (i < 0) return; const n = parseInt(buf.slice(0, i).toString(), 10); if (buf.length < i + 1 + n) return; const m = JSON.parse(buf.slice(i + 1, i + 1 + n).toString()); buf = buf.slice(i + 1 + n); if (!Array.isArray(m)) { hello = true; w.get('h')?.(); continue } const f = w.get(m[1]); if (f) { w.delete(m[1]); f(m) } } })
const send = (name, p = {}) => new Promise(r => { const mid = ++id; w.set(mid, r); const s = JSON.stringify([0, mid, name, p]); sock.write(`${Buffer.byteLength(s)}:${s}`) })
const newSession = async caps => { for (let i = 0; i < 120; i++) { const r = await send('WebDriver:NewSession', caps); const err = Array.isArray(r) ? r[2] : r && r.error; if (!err || !/Maximum number of active sessions|session not created/.test(JSON.stringify(err))) return r; await new Promise(res => setTimeout(res, 150 + Math.random() * 100)) } return send('WebDriver:NewSession', caps) }
await new Promise(r => hello ? r() : w.set('h', r))
await newSession({ capabilities: { alwaysMatch: { 'moz:accessibilityChecks': false } } }); await send('Marionette:SetContext', { value: 'chrome' })
const topic = 'egdqa-eval-' + Math.random().toString(36).slice(2)
const r = await send('WebDriver:ExecuteAsyncScript', { sandbox: 'system', args: [cardId, topic, 'data:,' + encodeURIComponent(frameScript(topic))], scriptTimeout: 8000, script: `const [cardId, topic, url, done] = arguments;
  const mm = document.getElementById(cardId)._browserControls.toolBrowser().messageManager;
  const t = setTimeout(() => { try { mm.removeMessageListener(topic, on) } catch {} done({ error: 'timeout' }) }, 6000);
  function on(msg) { clearTimeout(t); mm.removeMessageListener(topic, on); done(msg.data) }
  mm.addMessageListener(topic, on); mm.loadFrameScript(url, false);` })
console.log(JSON.stringify(r[2] ? { error: String(r[2].message || r[2].error).slice(0, 200) } : (r[3]?.value ?? r[3])))
await send('WebDriver:DeleteSession'); sock.end(); process.exit(0)
