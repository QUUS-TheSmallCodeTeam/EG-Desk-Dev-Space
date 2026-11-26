// L6 a1 (D25): the Card's OWN rule for a conversation's allowed sites, for replay tests. The code is the overlay's
// (eg-desk-surface.uc.js: browserToolThreadSiteSet, browserToolNavigationPolicy, browserToolNavigationAllowed), run in a
// window-like global (a vm context) while EGDeskBrowserGrant.sys.mjs stays in this one: in Firefox the overlay runs in the
// browser window and the module in the global ChromeUtils.importESModule gives it, so the window's Set is another global's.
// A replay that keeps both in one global cannot see what only happens across that boundary.
import fs from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import * as BrowserGrant from '../overlay/resources/EGDeskBrowserGrant.sys.mjs'

const SURFACE = new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url)
const START = '  // BRW-11 (D-B3): the standing interaction grant a Card holds for one'
const END = '  // The grant if it still holds against the live Card (D-B3), else nothing;'

// Services.eTLD.getBaseDomainFromHost for test hosts: the last two labels ('google' is a public suffix: about.google is its own site).
export const twoLabelSite = host => String(host).split('.').slice(-2).join('.')

/** cardSiteRule({ siteForHost }) -> { browserToolThreadSiteSet, browserToolNavigationPolicy, browserToolNavigationAllowed } as the overlay has them */
export function cardSiteRule({ siteForHost = twoLabelSite } = {}) {
  const source = fs.readFileSync(SURFACE, 'utf8')
  const a = source.indexOf(START), b = source.indexOf(END, a)
  if (a < 0 || b <= a) throw new Error('the overlay\'s site rule section was not found')
  const context = createContext({ BrowserGrant, servicesRef: () => ({ eTLD: { getBaseDomainFromHost: siteForHost } }) })
  return runInContext(`${source.slice(a, b)}\n;({ browserToolThreadSiteSet, browserToolNavigationPolicy, browserToolNavigationAllowed })`, context)
}
