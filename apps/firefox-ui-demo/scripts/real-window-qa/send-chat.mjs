// Type a message into the visible chat card composer and press send. Usage: node send-chat.mjs "<text>"
import net from 'node:net'
import { lock as egdLock } from './mlock.mjs'
await egdLock()
const text = process.argv[2] || ''
const sock = net.connect(2828, '127.0.0.1'); let buf = Buffer.alloc(0); let id = 0; const w = new Map(); let hello = false
sock.on('data', d => { buf = Buffer.concat([buf, d]); for (;;) { const i = buf.indexOf(':'); if (i < 0) return; const n = parseInt(buf.slice(0, i).toString(), 10); if (buf.length < i + 1 + n) return; const m = JSON.parse(buf.slice(i + 1, i + 1 + n).toString()); buf = buf.slice(i + 1 + n); if (!Array.isArray(m)) { hello = true; w.get('h')?.(); continue } const f = w.get(m[1]); if (f) { w.delete(m[1]); f(m) } } })
const send = (name, p = {}) => new Promise(r => { const mid = ++id; w.set(mid, r); const s = JSON.stringify([0, mid, name, p]); sock.write(`${Buffer.byteLength(s)}:${s}`) })
const newSession = async caps => { for (let i = 0; i < 120; i++) { const r = await send('WebDriver:NewSession', caps); const err = Array.isArray(r) ? r[2] : r && r.error; if (!err || !/Maximum number of active sessions|session not created/.test(JSON.stringify(err))) return r; await new Promise(res => setTimeout(res, 150 + Math.random() * 100)) } return send('WebDriver:NewSession', caps) }
await new Promise(r => hello ? r() : w.set('h', r))
await newSession({ capabilities: { alwaysMatch: { 'moz:accessibilityChecks': false } } }); await send('Marionette:SetContext', { value: 'chrome' })
const r = await send('WebDriver:ExecuteScript', { sandbox: 'system', args: [text], script: `
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const card = [...document.querySelectorAll('.egd-chat-card')].find(c => c.getBoundingClientRect().width > 100);
  if (!card) return { ok: false, why: 'no chat card' };
  const ta = card.querySelector('textarea');
  if (!ta) return { ok: false, why: 'no textarea' };
  ta.focus(); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value').set; setter.call(ta, arguments[0]);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  const btns = [...card.querySelectorAll('button')].filter(b => /보내기|전송|send/i.test((b.getAttribute('aria-label') || b.title || b.textContent || '')));
  const sendBtn = btns[btns.length - 1];
  if (!sendBtn) return { ok: false, why: 'no send button', labels: [...card.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent.trim()).slice(-8) };
  if (sendBtn.disabled) return { ok: false, why: 'send disabled' };
  sendBtn.click(); return { ok: true };` })
console.log(JSON.stringify(r[2] ? { error: String(r[2].message || r[2].error).slice(0, 200) } : (r[3]?.value ?? r[3])))
await send('WebDriver:DeleteSession'); sock.end(); process.exit(0)
