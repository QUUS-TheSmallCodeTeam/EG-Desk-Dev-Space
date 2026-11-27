// One Marionette client at a time across processes: a directory lock, released on exit; stale after 30 s or when its owner is gone.
import fs from 'node:fs'
const LOCK = '/tmp/egd-marionette.lock'
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
export async function lock() {
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(LOCK); fs.writeFileSync(`${LOCK}/pid`, String(process.pid)); break } catch {
      try { const st = fs.statSync(LOCK); const pid = Number(fs.readFileSync(`${LOCK}/pid`, 'utf8')); if (Date.now() - st.mtimeMs > 30000 || (pid && !alive(pid))) fs.rmSync(LOCK, { recursive: true, force: true }) } catch {}
      await new Promise(r => setTimeout(r, 40 + Math.random() * 60))
    }
  }
  const release = () => { try { if (Number(fs.readFileSync(`${LOCK}/pid`, 'utf8')) === process.pid) fs.rmSync(LOCK, { recursive: true, force: true }) } catch {} }
  process.on('exit', release); for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(130) })
}
