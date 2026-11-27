// L9 real-window check: same-address navigate after an in-page move must load the address.
import net from 'node:net'
import { lock as egdLock } from './mlock.mjs'
await egdLock()
const cardId = process.argv[2]
const sock = net.connect(2828, '127.0.0.1'); let buf = Buffer.alloc(0); let id = 0; const w = new Map(); let hello = false
sock.on('data', d => { buf = Buffer.concat([buf, d]); for (;;) { const i = buf.indexOf(':'); if (i < 0) return; const n = parseInt(buf.slice(0, i).toString(), 10); if (buf.length < i + 1 + n) return; const m = JSON.parse(buf.slice(i + 1, i + 1 + n).toString()); buf = buf.slice(i + 1 + n); if (!Array.isArray(m)) { hello = true; w.get('h')?.(); continue } const f = w.get(m[1]); if (f) { w.delete(m[1]); f(m) } } })
const send = (name, p = {}) => new Promise(r => { const mid = ++id; w.set(mid, r); const s = JSON.stringify([0, mid, name, p]); sock.write(`${Buffer.byteLength(s)}:${s}`) })
const newSession = async caps => { for (let i = 0; i < 120; i++) { const r = await send('WebDriver:NewSession', caps); const err = Array.isArray(r) ? r[2] : r && r.error; if (!err || !/Maximum number of active sessions|session not created/.test(JSON.stringify(err))) return r; await new Promise(res => setTimeout(res, 150 + Math.random() * 100)) } return send('WebDriver:NewSession', caps) }
await new Promise(r => hello ? r() : w.set('h', r))
await newSession({ capabilities: { alwaysMatch: { 'moz:accessibilityChecks': false } } }); await send('Marionette:SetContext', { value: 'chrome' })
const r = await send('WebDriver:ExecuteAsyncScript', { sandbox: 'system', args: [cardId], script: `const [cardId, done] = arguments; (async () => {
  const c = document.getElementById(cardId)._browserControls, b = () => c.toolBrowser();
  const wait = async (p, ms = 10000) => { const t = Date.now(); while (!p() && Date.now() - t < ms) await new Promise(r => setTimeout(r, 100)); return p(); };
  const DDG = 'https://duckduckgo.com/'; const ctx0 = b().browsingContext.originAttributes.userContextId; const out = {};
  c.navigate(DDG); out.home1 = await wait(() => b().currentURI.spec === DDG);
  b().fixupAndLoadURIString('https://duckduckgo.com/?q=eg-desk&ia=web', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
  out.inPage = await wait(() => b().currentURI.spec.includes('q=eg-desk')); out.srcStill = b().getAttribute('src') === DDG;
  c.navigate(DDG); out.sameAddressLoads = await wait(() => b().currentURI.spec === DDG); out.container = b().browsingContext.originAttributes.userContextId === ctx0;
  done(out) })().catch(e => done({ error: String(e).slice(0, 200) }))` })
console.log(JSON.stringify(r[2] ? { error: String(r[2].message || r[2].error).slice(0, 200) } : (r[3]?.value ?? r[3])))
await send('WebDriver:DeleteSession'); sock.end(); process.exit(0)
