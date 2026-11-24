// L6 cycle 17: one shared "last Decisions send" stamp for every measurement runner that sends (analysis tooling; product code never reads it).
// A latency probe that needs N minutes without Decisions traffic from this machine reads it (scripts/egdesk-turn-context-warmup-run.mjs).
//
// Where: $EGDESK_DECISION_SEND_STAMP when set (an absolute path), else <HOME>/.egdesk-decision-last-send.json (HOME of the runner process; Main
// runs every runner with the same HOME). The file is owner-only (0600), written atomically (temporary file + rename), never through a symlink.
// What: times and the runner's name and pid only. Never a key, a body, a header or an answer.
//   { version: 1, startedAt, endedAt | null, runner, pid }   startedAt: just before a request leaves; endedAt: when its response (or error) came back
// A request whose start stamp cannot be written is not sent (the wrapped fetch rejects before calling the network).
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DECISIONS_ENDPOINT } from './egdesk-decision-client.mjs'

export const SEND_STAMP_FILE = '.egdesk-decision-last-send.json'

/** The stamp path for a runner's environment. */
export function sendStampPath(env = process.env) {
  const given = env?.EGDESK_DECISION_SEND_STAMP
  if (typeof given === 'string' && given) {
    if (!path.isAbsolute(given)) throw new Error('EGDESK_DECISION_SEND_STAMP must be an absolute path')
    return given
  }
  const home = typeof env?.HOME === 'string' && env.HOME ? env.HOME : os.homedir()
  return path.join(home, SEND_STAMP_FILE)
}

const notLink = file => { try { if (lstatSync(file).isSymbolicLink()) throw new Error(`the send stamp ${file} is a symbolic link`) } catch (error) { if (error?.code !== 'ENOENT') throw error } }

/** -> { startedAt, endedAt, runner, pid, lastAt } | null (no stamp yet). lastAt: the later of the two times, in ms. Throws on an unreadable stamp. */
export function readSendStamp(file) {
  notLink(file)
  let text
  try { text = readFileSync(file, 'utf8') } catch (error) { if (error?.code === 'ENOENT') return null; throw error }
  const raw = JSON.parse(text)
  const ms = v => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null)
  const started = ms(raw?.startedAt), ended = ms(raw?.endedAt)
  if (raw?.version !== 1 || started === null) throw new Error(`the send stamp ${file} is not a version-1 stamp`)
  return { startedAt: raw.startedAt, endedAt: raw.endedAt ?? null, runner: String(raw.runner ?? ''), pid: Number(raw.pid) || null, lastAt: Math.max(started, ended ?? started) }
}

/** Writes the stamp atomically, 0600. */
export function writeSendStamp(file, { startedAt, endedAt = null, runner, pid = process.pid }) {
  notLink(file)
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, startedAt, endedAt, runner: String(runner), pid }) + '\n', { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

/**
 * Wraps a fetch: every POST to the official Decisions endpoint first writes the start stamp (if that fails, the request is not sent: the
 * promise rejects with an Error named SendStampError), then calls the network, then writes the end stamp (best effort: a failure here keeps
 * the start stamp, which is earlier, so an idle check reads LESS idle time, never more). Other URLs pass through untouched.
 */
// onForeign(stamp): called when, at the end of a request, the stamp on disk is not the one this request wrote (another runner sent meanwhile).
export function stampingFetch(fetchImpl, { file, runner, now = () => new Date(), onForeign = null }) {
  if (typeof fetchImpl !== 'function') throw new TypeError('stampingFetch needs a fetch')
  if (typeof file !== 'string' || !file) throw new TypeError('stampingFetch needs a stamp path')
  return async (url, init) => {
    if (String(url) !== DECISIONS_ENDPOINT) return fetchImpl(url, init)
    const startedAt = now().toISOString()
    try { writeSendStamp(file, { startedAt, runner }) } catch (error) {
      throw Object.assign(new Error(`the Decisions send stamp could not be written (${error?.message || 'error'}); nothing was sent`), { name: 'SendStampError' })
    }
    try { return await fetchImpl(url, init) } finally {
      if (typeof onForeign === 'function') { try { const s = readSendStamp(file); if (!s || s.startedAt !== startedAt || s.runner !== String(runner) || s.pid !== process.pid) onForeign(s) } catch { onForeign(null) } }
      try { writeSendStamp(file, { startedAt, endedAt: now().toISOString(), runner }) } catch { /* the start stamp stays */ }
    }
  }
}
