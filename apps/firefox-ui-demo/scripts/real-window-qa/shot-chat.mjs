// Element screenshot of the chat card only (no settings panel, no other cards). Scrolls the message list so the text $3 (default '브라우저 작업') is near the top.
// Usage: node shot-chat.mjs <out.png> [anchorText]
import net from 'node:net'; import fs from 'node:fs'
import { lock as egdLock } from './mlock.mjs'
await egdLock()
const [, , out, anchor = '브라우저 작업'] = process.argv
const sock = net.connect(2828, '127.0.0.1'); let buf = Buffer.alloc(0); let id = 0; const w = new Map(); let hello = false
sock.on('data', d => { buf = Buffer.concat([buf, d]); for (;;) { const i = buf.indexOf(':'); if (i < 0) return; const n = parseInt(buf.slice(0, i).toString(), 10); if (buf.length < i + 1 + n) return; const m = JSON.parse(buf.slice(i + 1, i + 1 + n).toString()); buf = buf.slice(i + 1 + n); if (!Array.isArray(m)) { hello = true; w.get('h')?.(); continue } const f = w.get(m[1]); if (f) { w.delete(m[1]); f(m) } } })
const send = (name, p = {}) => new Promise(r => { const mid = ++id; w.set(mid, r); const s = JSON.stringify([0, mid, name, p]); sock.write(`${Buffer.byteLength(s)}:${s}`) })
const newSession = async caps => { for (let i = 0; i < 120; i++) { const r = await send('WebDriver:NewSession', caps); const err = Array.isArray(r) ? r[2] : r && r.error; if (!err || !/Maximum number of active sessions|session not created/.test(JSON.stringify(err))) return r; await new Promise(res => setTimeout(res, 150 + Math.random() * 100)) } return send('WebDriver:NewSession', caps) }
await new Promise(r => hello ? r() : w.set('h', r))
await newSession({ capabilities: { alwaysMatch: { 'moz:accessibilityChecks': false } } }); await send('Marionette:SetContext', { value: 'chrome' })
const s = await send('WebDriver:ExecuteScript', { sandbox: 'system', args: [anchor], script: `const card = document.querySelector('.egd-chat-card'); if (!card) return 'no chat card';
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT); let hit = null; while (walker.nextNode()) { if (walker.currentNode.nodeValue.includes(arguments[0])) hit = walker.currentNode.parentElement }
  if (!hit) return 'anchor not found';
  let sc = hit.parentElement; while (sc && sc !== card && !(sc.scrollHeight > sc.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
  if (sc && sc !== card) { const top = hit.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 70; sc.scrollTop = Math.max(0, top) }
  return 'scrolled' ` })
const f = await send('WebDriver:FindElement', { using: 'css selector', value: '.egd-chat-card' })
const el = f[3]?.value; const ref = el && (el['element-6066-11e4-a52e-4f735466cecf'] || el.ELEMENT || Object.values(el)[0])
const r = await send('WebDriver:TakeScreenshot', { id: ref, full: false, hash: false })
if (r[2]) console.log('shot error', JSON.stringify(r[2]).slice(0, 200)); else { fs.writeFileSync(out, Buffer.from(r[3].value, 'base64')); console.log(JSON.stringify({ scroll: s[3]?.value ?? s[2], saved: out })) }
await send('WebDriver:DeleteSession'); sock.end(); process.exit(0)
