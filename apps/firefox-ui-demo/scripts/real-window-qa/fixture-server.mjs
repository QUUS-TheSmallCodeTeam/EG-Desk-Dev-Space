// QA tooling: serve data: URL fixtures as ordinary http pages (EG-Desk's execution policy rejects data: pages with QA_POLICY_UNVERIFIED).
// rewriteFixtureUrls(case, id, {dir, port}) decodes every data:text/html URL of a case (url, then, also.url) into <dir>/<id>[-n].html (UTF-8 bytes) and returns a copy whose urls are http://127.0.0.1:<port>/<file>. Non-data urls and cases without data: urls are returned untouched.
// startFixtureServer({dir, port}) serves <dir> on 127.0.0.1; if the port already answers with our marker it is reused (returns {reused:true}); stop() closes only a server this process started.
import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path'; import { spawn } from 'node:child_process'; import { fileURLToPath } from 'node:url'
export const DEFAULT_PORT = 8770, MARKER = 'egd-qa-fixture-server'
export const fixturePort = () => Number(process.env.EGDESK_QA_FIXTURE_PORT) || DEFAULT_PORT
export const isDataUrl = u => typeof u === 'string' && /^data:/i.test(u)
export function decodeDataUrl(u) {
  const i = u.indexOf(','); if (i < 0) throw new Error('bad data: url'); const meta = u.slice(5, i), body = u.slice(i + 1)
  const buf = /;base64$/i.test(meta) ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8'); return { meta, buf }
}
export function rewriteFixtureUrls(c, id, { dir, port = fixturePort() }) {
  const files = []; let n = 0; const safe = String(id).replace(/[^\w.-]/g, '_')
  const conv = u => { if (!isDataUrl(u)) return u; const { buf } = decodeDataUrl(u); const name = `${safe}${n++ === 0 ? '' : '-' + n}.html`; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), buf); files.push(name); return `http://127.0.0.1:${port}/${name}` }
  const out = { ...c }; if (c.url !== undefined) out.url = conv(c.url); if (c.then !== undefined) out.then = conv(c.then); if (c.also) out.also = { ...c.also, url: conv(c.also.url) }
  return { c: out, files }
}
const probe = port => new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/__ping', timeout: 1500 }, m => { let b = ''; m.on('data', d => b += d); m.on('end', () => res(b.trim() === MARKER)) }); r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false) }) })
export async function startFixtureServer({ dir, port = fixturePort() }) {
  if (await probe(port)) return { reused: true, port, stop: async () => {} }
  const root = path.resolve(dir); fs.mkdirSync(root, { recursive: true })
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0])
    if (p === '/__ping') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(MARKER) }
    const f = path.resolve(root, '.' + p); if (!f.startsWith(root + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found') }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(fs.readFileSync(f))
  })
  await new Promise((ok, bad) => { srv.once('error', bad); srv.listen(port, '127.0.0.1', ok) })
  return { reused: false, port, stop: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()) }) }
}
// run-case.mjs blocks its event loop in execFileSync, so the server must be a separate process: spawn this file in serve mode (reuse a running one).
export async function spawnFixtureServer({ dir, port = fixturePort(), node = process.execPath }) {
  if (await probe(port)) return { reused: true, port, stop: async () => {} }
  const child = spawn(node, [fileURLToPath(import.meta.url), 'serve', dir, String(port)], { stdio: 'ignore' })
  for (let i = 0; i < 50; i++) { if (await probe(port)) return { reused: false, port, stop: async () => { try { child.kill() } catch {} } }; await new Promise(r => setTimeout(r, 100)) }
  try { child.kill() } catch {}; throw new Error('fixture server did not start on ' + port)
}
if (process.argv[2] === 'serve' && import.meta.url === new URL(process.argv[1], 'file://').href) { const s = await startFixtureServer({ dir: process.argv[3], port: Number(process.argv[4]) }); if (s.reused) process.exit(0) }
