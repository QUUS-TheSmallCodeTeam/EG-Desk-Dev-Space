import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SIGNIN_HOSTS, credentialBearingUrl, errorPageOriginalUrl, loopbackCredentialUrl, restorableBrowserUri, scrubBrowserRecord, signinPageUrl } from '../overlay/resources/EGDeskSurfaceState.sys.mjs'
import { AUTH_OPAQUE_HOSTS } from '../helper/egdesk-auth-opaque.mjs'

// c36: a Browser Card left from an earlier CLI login must not keep (or restore) a sign-in whose CLI is gone, and an authorization code must not stay in an address bar, a history or a saved session.
const CB = 'http://localhost:50430/callback?code=SECRET-CODE&state=SECRET-STATE'
const NETERROR = `about:neterror?e=connectionFailure&u=${encodeURIComponent(CB)}&c=UTF-8&d=Firefox%20can%E2%80%99t%20connect`
const SIGN_IN = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=s'
const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')

test('a loopback callback with a code, state or token is a credential; ordinary local pages and other hosts are not', () => {
  for (const url of [CB, 'http://127.0.0.1:8080/cb?code=c', 'http://[::1]:1/x?state=s', 'https://localhost/cb#access_token=t', 'http://localhost:3000/?Code=x', 'http://localhost:9/cb?id_token=t&x=1']) assert.equal(loopbackCredentialUrl(url), true, url)
  for (const url of ['http://localhost:3000/', 'http://localhost:3000/?q=code', 'https://example.test/cb?code=c', 'http://localhost.evil.example/cb?code=c', 'file:///cb?code=c', 'about:blank', '', null, 'not a url']) assert.equal(loopbackCredentialUrl(url), false, String(url))
})

test('Firefox\'s error page for a failed callback keeps the address in u=: that address counts, so the card is blanked on the error page too', () => {
  assert.equal(errorPageOriginalUrl(NETERROR), CB); assert.equal(credentialBearingUrl(NETERROR), true); assert.equal(credentialBearingUrl(CB), true)
  assert.equal(credentialBearingUrl('about:neterror?e=dnsNotFound&u=https%3A//example.test/'), false); assert.equal(errorPageOriginalUrl('https://example.test/?u=x'), null); assert.equal(errorPageOriginalUrl('about:blank'), null)
  assert.equal(credentialBearingUrl('about:certerror?u=' + encodeURIComponent('http://127.0.0.1:1/cb?code=c')), true)
})

test('restore: an address with a loopback credential restores blank always; an old sign-in page restores blank when the bridge says the flag is on; everything else is untouched', () => {
  assert.equal(restorableBrowserUri(CB), 'about:blank'); assert.equal(restorableBrowserUri(NETERROR), 'about:blank')
  assert.equal(restorableBrowserUri(SIGN_IN, { guard: true }), 'about:blank'); assert.equal(restorableBrowserUri('https://platform.claude.com/oauth/code/callback?code=c', { guard: true }), 'about:blank')
  assert.equal(restorableBrowserUri(SIGN_IN), SIGN_IN, 'guard off: as before')
  for (const url of ['https://duckduckgo.com/', 'https://claude.ai/chat/123', 'https://example.test/oauth/authorize', 'http://localhost:3000/app']) assert.equal(restorableBrowserUri(url, { guard: true }), url, url)
  assert.equal(signinPageUrl(SIGN_IN), true); assert.equal(signinPageUrl('https://claude.ai/chat/1'), false); assert.equal(signinPageUrl('https://auth.openai.com/log-in'), true)
})

test('a saved session snapshot is scrubbed card by card: the stale cards come back blank (address, home, history, title), the person\'s own cards are the same objects', () => {
  const stale = { id: 'b1', type: 'browser', geometry: { x: 1, y: 2, width: 3, height: 4 }, sourceRef: { kind: 'browser', uri: CB }, runtimeState: { uri: CB, title: 'localhost', history: [SIGN_IN, CB], homeUrl: 'https://duckduckgo.com' } }
  const fine = { id: 'b2', type: 'browser', sourceRef: { kind: 'browser', uri: 'https://duckduckgo.com/' }, runtimeState: { uri: 'https://duckduckgo.com/', title: 'DuckDuckGo', history: ['https://duckduckgo.com/'] } }
  const terminal = { id: 't1', type: 'terminal', runtimeState: {} }
  const cleaned = scrubBrowserRecord(stale)
  assert.equal(cleaned.runtimeState.uri, 'about:blank'); assert.equal(cleaned.sourceRef.uri, 'about:blank'); assert.deepEqual(cleaned.runtimeState.history, [SIGN_IN, 'about:blank']); assert.equal(cleaned.runtimeState.title, ''); assert.equal(cleaned.runtimeState.homeUrl, 'https://duckduckgo.com')
  assert.ok(!JSON.stringify(cleaned).includes('SECRET'), 'no code, no state anywhere in the saved record'); assert.equal(stale.runtimeState.uri, CB, 'the input is not mutated')
  const guarded = scrubBrowserRecord(stale, { guard: true }); assert.deepEqual(guarded.runtimeState.history, ['about:blank', 'about:blank'])
  assert.equal(scrubBrowserRecord(fine), fine); assert.equal(scrubBrowserRecord(terminal), terminal); assert.equal(scrubBrowserRecord(null), null)
  const snapshot = [stale, fine, terminal].map(record => scrubBrowserRecord(record, { guard: true }))
  assert.deepEqual(snapshot.map(r => r.runtimeState?.uri ?? null), ['about:blank', 'https://duckduckgo.com/', null])
})

test('the sign-in host list of the overlay is the helper\'s list', () => { assert.deepEqual([...SIGNIN_HOSTS], [...AUTH_OPAQUE_HOSTS]) })

test('wiring in the surface: sign-in cards are never saved, saves and restores go through the scrub, a location change or error page on a credential address blanks the card, the capability turns the guard on', () => {
  assert.match(surface, /if \(card\._signinSessionId\) return null;/)
  assert.match(surface, /typeof SurfaceState !== 'undefined' && SurfaceState\.scrubBrowserRecord \? SurfaceState\.scrubBrowserRecord\(record, \{ guard: typeof signinGuardOn === 'function' && signinGuardOn\(\) \}\) : record/)
  assert.match(surface, /const savedUri = record\.runtimeState\?\.uri \|\| record\.sourceRef\?\.uri;[\s\S]{0,200}SurfaceState\.restorableBrowserUri\(savedUri, \{ guard: typeof signinGuardOn === 'function' && signinGuardOn\(\) \}\)/)
  assert.match(surface, /const savedUri = runtime\.uri \|\| cardState\.sourceRef\?\.uri \|\| 'https:\/\/duckduckgo\.com';[\s\S]{0,200}SurfaceState\.restorableBrowserUri\(savedUri, \{ guard: typeof signinGuardOn === 'function' && signinGuardOn\(\) \}\)/)
  const listener = surface.slice(surface.indexOf('const scrubCredentialPage = (spec) => {'), surface.indexOf('card._browserLocationListener = browserLocationListener'))
  assert.match(listener, /credentialBearingUrl\(spec\)/); assert.match(listener, /purgeHistory\(sh\.count\)/); assert.match(listener, /navigateBrowser\('about:blank', \{ replaceHistory: true/)
  assert.match(listener, /if \(card\._signinSessionId \|\| signinGuardOn\(\)\) scrubCredentialPage\(location\?\.spec \|\| ''\)/)
  assert.match(surface, /state\.codex\.chatCapabilities\.includes\('terminal-open-url'\)/)
  assert.match(readFileSync(new URL('../helper/codex-bridge-server.mjs', import.meta.url), 'utf8'), /process\.env\.EGDESK_TERMINAL_OPEN_URL === 'on' \? \['terminal-open-url'\] : \[\]/)
})

test('c36 wiring: the login flow\'s timings and the engine watch are on only with the capability, the watch clears a signed-in state and shows the ended error', () => {
  const login = surface.slice(surface.indexOf('let loginCard = null;'), surface.indexOf('let loginCard = null;') + 3600)
  assert.match(login, /const progress = typeof signinGuardOn === 'function' && signinGuardOn\(\) \? \{ timeoutMs: AccountSettingsView\.CLAUDE_LOGIN_WATCH\.terminalReadyMs, signinCardMs: AccountSettingsView\.CLAUDE_LOGIN_WATCH\.signinCardMs \} : \{\};/)
  assert.match(login, /openTerminal: \(\) => \(loginCard = spawnTerminalCard\(/)
  assert.match(login, /if \(loginCard && outcome\.phase === 'started' && typeof signinGuardOn === 'function' && signinGuardOn\(\)\) \{/)
  assert.match(login, /api\.refreshClaudeEngine \? api\.refreshClaudeEngine\(\) : api\.refreshAuthStatus\?\.\(\)/)
  assert.match(login, /\.status === 'signedIn'/); assert.match(login, /sessionEnded: \(\) => loginCard\._sessionEnded === true \|\| loginCard\.isConnected === false/)
  assert.match(login, /if \(result === 'signedIn'\) claudeAction = null;/); assert.match(login, /result === 'ended'\) claudeAction = \{ action: 'login', phase: 'error', text: AccountSettingsView\.CLAUDE_LOGIN_ENDED_TEXT \}/)
  const terminal = readFileSync(new URL('../overlay/resources/surface/EGDeskSurfaceTerminal.mjs', import.meta.url), 'utf8')
  assert.match(terminal, /card\._linkedSigninCount = \(\) => linkedCards\.size/)
  assert.match(terminal, /ev\.data\?\.type === 'terminal-exit-confirmed' \|\| \(ev\.data\?\.type === 'terminal-disconnected' && everConnected\)\) card\._sessionEnded = true/)
})
