const MARKER = /^[A-Za-z0-9_-]{20,80}$/
const PATH = /^\/egdesk-qa\/[A-Za-z0-9_-]{20,80}\/?$/

// A fixture is available only in a deliberately opted-in local bridge process.
// The URL is an exact, non-redirecting test target, not a general origin grant.
export function fixtureBrowserQaFromEnv(env = process.env) {
  if (env.EGDESK_BROWSER_FIXTURE_QA !== '1') return null
  const rawUrl = env.EGDESK_BROWSER_FIXTURE_QA_URL
  const marker = env.EGDESK_BROWSER_FIXTURE_QA_MARKER
  let url
  try { url = new URL(rawUrl) } catch { return null }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.port || Number(url.port) < 1024 || Number(url.port) > 65535 ||
      url.username || url.password || url.search || url.hash || !PATH.test(url.pathname) ||
      rawUrl !== url.href || typeof marker !== 'string' || !MARKER.test(marker)) return null
  return Object.freeze({ url: url.href, marker })
}

export function fixtureSnapshotMatches(snapshot, fixture) {
  return Boolean(fixture && snapshot?.url === fixture.url && Array.isArray(snapshot.text) &&
    snapshot.text.some(text => text === fixture.marker))
}
