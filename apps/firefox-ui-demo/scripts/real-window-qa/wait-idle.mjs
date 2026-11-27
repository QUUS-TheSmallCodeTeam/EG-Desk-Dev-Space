// Wait until no chat run is in progress (bridge /v1/state chat.runs) and the chat card shows no stop button, for 4 s in a row (max $2 s).
import { execFileSync } from 'node:child_process'; import path from 'node:path'; import { fileURLToPath } from 'node:url'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const max = Number(process.argv[2] || 150) * 1000, t0 = Date.now(); let quiet = 0
const runsBusy = async () => { try { const j = await (await fetch('http://127.0.0.1:39218/v1/state')).json(); return (j?.chat?.runs || []).some(r => !/^(completed|failed|cancelled|interrupted|error|stopped)$/i.test(String(r?.status || ''))) } catch { return true } }
const uiBusy = () => { try { return execFileSync(process.env.NODE || process.execPath, [path.join(HERE, 'mn.mjs'), 'exec', 'const c=document.querySelector(".egd-chat-card"); const t=(c.innerText||"").slice(-700); const stop=[...c.querySelectorAll("button")].some(b=>/^(응답 |작업 )?(중지|멈추기)$|^Stop/.test((b.getAttribute("aria-label")||b.textContent||"").trim())); return (stop||/Agent 작업 중|보내는 중|생각 중|답변 중/.test(t))?"busy":"idle"', '50'], { cwd: HERE, encoding: 'utf8', timeout: 20000 }).includes('busy') } catch { return true } }
while (Date.now() - t0 < max) { const busy = (await runsBusy()) || uiBusy(); quiet = busy ? 0 : quiet + 1; if (quiet >= 4) break; await new Promise(r => setTimeout(r, 1000)) }
console.log(`idle after ${Math.round((Date.now() - t0) / 1000)}s${quiet >= 4 ? '' : ' (TIMEOUT)'}`)
