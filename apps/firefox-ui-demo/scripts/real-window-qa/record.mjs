// Screen recording control (temporary name): node record.mjs start [--fps N] [--scale S] [label...] | stop | status
// Defaults: 4 frames/s at scale 0.5 (light). A fast scroll or flicker needs more: --fps 10 --scale 0.75.
// Bridge HTTP only (127.0.0.1:39218), no Marionette. The bridge needs EGDESK_SCREEN_RECORDING=on (default off).
// start prints the recording id and file; stop waits for the window to finish and for the bridge to re-read the file, then prints the check.
const [, , cmd, ...rest] = process.argv
const base = `http://127.0.0.1:${process.env.EGDESK_BRIDGE_PORT || 39218}/v1/recording`
const call = async (method, sub, body) => {
  const response = await fetch(base + sub, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(40_000) })
  const text = await response.text()
  let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { http: response.status, ...json }
}
let out
if (cmd === 'start') {
  const body = {}, words = []
  for (let i = 0; i < rest.length; i++) { if (rest[i] === '--fps') body.fps = Number(rest[++i]); else if (rest[i] === '--scale') body.scale = Number(rest[++i]); else words.push(rest[i]) }
  if (words.length) body.label = words.join(' ')
  out = await call('POST', '/start', body)
}
else if (cmd === 'stop') out = await call('POST', '/stop')
else if (cmd === 'status') out = await call('GET', '')
else { console.error('usage: node record.mjs start [--fps N] [--scale S] [label] | stop | status'); process.exit(2) }
console.log(JSON.stringify(out, null, 1))
process.exit(out.http === 200 ? 0 : 1)
