import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// L1 c34 (owner: "Claude login must happen INSIDE EG-Desk, it is the browser"): URLs that a program in a Terminal card asks the system to open (the Claude CLI's
// `claude auth login` opens its sign-in page that way) open in an EG-Desk Browser card on the same Desk instead of the system's default browser.
// Default off: bridge flag EGDESK_TERMINAL_OPEN_URL=on. With the flag off the terminal's environment is byte-for-byte what it was.
//
// How: each terminal session of a flagged bridge starts with BROWSER=<opener>, a PATH that begins with a directory holding `open` and `xdg-open` shims, and three
// variables naming this one session (endpoint, session id, a random per-session token). The opener posts ONLY the URL to POST /terminal/open-url. The bridge keeps the
// URL in memory until the terminal card's own read takes it (read() returns it once as `openUrls`), and the card opens a Browser Card with it. A shim called with anything
// but an http(s) URL (`open .`, `open file.txt`) runs the system's own `open`; if the post fails the opener runs the system's own opener too: nothing is lost.
//
// What EG-Desk does NOT do (the rule of claude-engine-auth.mjs stays): it never reads, stores or relays the sign-in CODE or any token. The URL is the sign-in page's address
// (OAuth parameters in it are public ones: client id, redirect, PKCE challenge, state). The page that shows the code is only DISPLAYED in a Browser Card; the person copies the
// code into the terminal themselves. The bridge neither fetches those pages nor reads the card's page text for this (no page_text is sent anywhere by this feature).
// The URL is never logged. HOME and the credential files are untouched (only BROWSER, PATH and the three EGDESK_OPEN_URL_* variables are added).
export const OPEN_URL_FLAG = 'EGDESK_TERMINAL_OPEN_URL'
export const OPEN_URL_LIMITS = Object.freeze({ urlChars: 2048, perSession: 4, ttlMs: 60_000, sessions: 32 })

/** The URL a card may open: absolute http(s), no credentials, no whitespace or control characters, bounded. Returns the normalized href or null. */
export function normalizeOpenUrl(value) {
  if (typeof value !== 'string' || !value || value.length > OPEN_URL_LIMITS.urlChars || /[\u0000-\u0020\u007f]/.test(value)) return null
  let url
  try { url = new URL(value) } catch { return null }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) return null
  return url.href
}

const sha = text => createHash('sha256').update(String(text)).digest()
const same = (a, b) => timingSafeEqual(sha(a), sha(b))

// The one script. Arguments: whatever the caller passes to a browser or to `open`: the first http(s) argument is the URL. Anything else, or any failure, runs the system's opener.
export const OPENER_SCRIPT = `#!/bin/sh
# EG-Desk terminal opener (flag EGDESK_TERMINAL_OPEN_URL): posts an http(s) URL to this EG-Desk's bridge; otherwise the system's own opener runs.
url=""
for arg in "$@"; do
  case "$arg" in http://*|https://*) url="$arg"; break ;; esac
done
if [ -n "$url" ] && [ -n "$EGDESK_OPEN_URL_ENDPOINT" ] && [ -n "$EGDESK_OPEN_URL_SESSION" ] && [ -n "$EGDESK_OPEN_URL_TOKEN" ]; then
  case "$url" in
    *'"'*|*\\\\*|*' '*) ;;
    *) /usr/bin/curl -fsS -m 3 -o /dev/null -X POST -H 'Content-Type: application/json' \\
         --data "{\\"sessionId\\":\\"$EGDESK_OPEN_URL_SESSION\\",\\"token\\":\\"$EGDESK_OPEN_URL_TOKEN\\",\\"url\\":\\"$url\\"}" "$EGDESK_OPEN_URL_ENDPOINT" >/dev/null 2>&1 && exit 0 ;;
  esac
fi
if [ -n "$EGDESK_REAL_OPEN" ]; then exec "$EGDESK_REAL_OPEN" "$@"; fi # tests only: a stand-in for the system opener
if [ "$(uname)" = "Darwin" ]; then exec /usr/bin/open "$@"; fi
exec /usr/bin/xdg-open "$@"
`

/**
 * createTerminalOpenUrl({ dir, port, now, newToken, write })
 *   install() -> writes the opener and the shims under dir (idempotent), returns the paths
 *   envFor(sessionId) -> the environment additions of one terminal session (and registers its token)
 *   accept({ sessionId, token, url }) -> { ok: true } or throws { code, httpStatus }
 *   take(sessionId) -> the URLs waiting for that session's card, once
 *   forget(sessionId)
 */
export function createTerminalOpenUrl({ dir, port, now = Date.now, newToken = () => randomBytes(24).toString('hex'), write = true, basePath = process.env.PATH ?? '' } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new TypeError('createTerminalOpenUrl needs an absolute directory')
  const opener = path.join(dir, 'egdesk-open-url'), shims = path.join(dir, 'bin')
  const sessions = new Map() // id -> { token, urls: [{ url, at }] }
  const fail = (code, httpStatus, message) => Object.assign(new Error(message), { code, httpStatus })
  const install = () => {
    if (write) {
      mkdirSync(shims, { recursive: true, mode: 0o700 })
      writeFileSync(opener, OPENER_SCRIPT, { mode: 0o700 }); chmodSync(opener, 0o700)
      for (const name of ['open', 'xdg-open']) { const file = path.join(shims, name); writeFileSync(file, `#!/bin/sh\nexec "${opener}" "$@"\n`, { mode: 0o700 }); chmodSync(file, 0o700) }
    }
    return { opener, shims }
  }
  const prune = () => {
    for (const [id, entry] of sessions) entry.urls = entry.urls.filter(item => now() - item.at <= OPEN_URL_LIMITS.ttlMs)
    while (sessions.size > OPEN_URL_LIMITS.sessions) sessions.delete(sessions.keys().next().value)
  }
  return {
    install,
    envFor(sessionId) {
      const token = newToken()
      sessions.set(sessionId, { token, urls: [] }); prune()
      return { BROWSER: opener, PATH: `${shims}${path.delimiter}${basePath}`, EGDESK_OPEN_URL_ENDPOINT: `http://127.0.0.1:${typeof port === 'function' ? port() : port}/terminal/open-url`,
        EGDESK_OPEN_URL_SESSION: sessionId, EGDESK_OPEN_URL_TOKEN: token }
    },
    accept({ sessionId, token, url } = {}) {
      const entry = typeof sessionId === 'string' ? sessions.get(sessionId) : null
      if (!entry || typeof token !== 'string' || !same(token, entry.token)) throw fail('OPEN_URL_REFUSED', 403, 'This terminal session cannot open a card')
      const href = normalizeOpenUrl(url)
      if (!href) throw fail('OPEN_URL_INVALID', 400, 'Only an http(s) address can be opened')
      prune()
      if (entry.urls.some(item => item.url === href)) return { ok: true, duplicate: true }
      if (entry.urls.length >= OPEN_URL_LIMITS.perSession) throw fail('OPEN_URL_BUSY', 429, 'Too many addresses are waiting')
      entry.urls.push({ url: href, at: now() })
      return { ok: true }
    },
    take(sessionId) {
      const entry = sessions.get(sessionId)
      if (!entry || !entry.urls.length) return []
      prune()
      const urls = entry.urls.map(item => item.url); entry.urls = []
      return urls
    },
    forget(sessionId) { sessions.delete(sessionId) },
    size: () => sessions.size,
  }
}
