import test from 'node:test'
import assert from 'node:assert/strict'
import { readSurfaceSource } from './egdesk-surface-source.mjs'

// L9 a2: a Browser Card's own move (address Enter, home, its back/forward, the Library, an Agent's navigate) loads the
// address even when it is the value the <browser>'s src attribute already holds: the page may have moved on inside
// since (a DuckDuckGo search leaves src at https://duckduckgo.com/ while the page is the results page). Gecko starts a
// <browser>'s frame loader only for a changed src (XULFrameElement::AfterSetAttr -> LoadSrc -> nsFrameLoader::LoadFrame):
// Element::SetAttr stops a same-value set at OnAttrSetButNotChanged, which loads nothing for a XUL frame (an HTML frame
// loads there), and removing src loads nothing for a XUL frame (an HTML frame loads about:blank). The fake does the same.
const source = readSurfaceSource()
const between = (start, end) => {
  const first = source.indexOf(start)
  const last = source.indexOf(end, first)
  assert(first >= 0 && last > first, `Browser Card source boundary missing: ${start}`)
  return source.slice(first, last)
}
const historySource = between('    const readNativeHistoryFlags = () => {', '    const readBrowserTitle = () => {')
const syncSource = between('    const syncBrowserStateFromBrowser = (options = {}) => {', '    const loadBrowserUri = (url) => {')
const navigationSource = between('    const loadBrowserUri = (url) => {', '    const reloadBrowser = () => {')
const CONTAINER = 5
const DDG = 'https://duckduckgo.com/'
const RESULTS = 'https://duckduckgo.com/?ia=web&origin=funnel_home_website&t=h_&q=eg-desk'

function geckoBrowser(localName) {
  const attributes = new Map()
  const loads = []
  const calls = { remove: 0 }
  const browser = {
    localName,
    currentURI: { spec: 'about:blank' },
    browsingContext: { id: 41, originAttributes: { userContextId: CONTAINER, privateBrowsingId: 0 } },
    canGoBack: false,
    canGoForward: false,
    getAttribute: name => (attributes.has(name) ? attributes.get(name) : null),
    setAttribute(name, value) {
      const text = String(value)
      const unchanged = attributes.get(name) === text
      attributes.set(name, text)
      if (name === 'src' && (!unchanged || localName === 'iframe')) startFrameLoader()
    },
    removeAttribute(name) {
      calls.remove += 1
      attributes.delete(name)
      if (name === 'src' && localName === 'iframe') startFrameLoader()
    },
    get src() { return attributes.get('src') ?? '' },
    set src(value) { this.setAttribute('src', value) },
    loadURI: () => assert.fail('a move uses the src frame loader, not webNavigation.loadURI'),
    fixupAndLoadURIString: () => assert.fail('a move uses the src frame loader, not a fixup load'),
    reload: () => assert.fail('a move to an address is not a reload'),
    goBack: () => assert.fail('the Card moves in its own history first'),
    goForward: () => assert.fail('the Card moves in its own history first'),
  }
  // nsFrameLoader::GetURL reads src (empty: about:blank); the load runs in this <browser>'s own browsing context.
  function startFrameLoader() {
    const url = attributes.get('src') || 'about:blank'
    loads.push({ url, userContextId: browser.browsingContext.originAttributes.userContextId })
    browser.currentURI = { spec: url }
  }
  // The page's own navigation (a search, a link): the document moves, src stays.
  const pageMovesTo = url => { browser.currentURI = { spec: url } }
  return { browser, loads, calls, pageMovesTo }
}

function browserCard({ startUrl = DDG, homeUrl = DDG, localName = 'browser' } = {}) {
  const gecko = geckoBrowser(localName)
  gecko.browser.setAttribute('src', startUrl) // spawnBrowserCard: the Card's first address
  const browserState = { uri: startUrl, title: '', loading: false, canGoBack: false, canGoForward: false,
    security: 'secure', homeUrl, history: [startUrl], historyIndex: 0 }
  const notices = []
  const urlInput = { value: startUrl }
  const controls = new Function('xulBrowser', 'browserState', 'card', 'urlInput', 'agentProjection', 'TAG', 'console',
    'window', 'normalizeBrowserNavigationUri', 'browserSecurityKind', 'browserDisplayHost', 'browserVisibleAddress',
    'bindCardSourceRef', 'sourceForBrowser', 'setBrowserLoading', 'markAgendaDirty', 'syncBrowserChrome',
    'getBrowserStateSnapshot', 'reportBrowserLocation', 'readArrivedBrowserUri', 'readBrowserTitle',
    'browserIdentity', 'browserIdentityUsable', 'browserIdentityModule', 'boardNotice',
    `let agentNavigationGuard = null;\n${historySource}\n${syncSource}\n${navigationSource}\n` +
    'return { navigate: navigateBrowser, home: () => navigateBrowser(browserState.homeUrl), back: goBrowserBack, ' +
    'forward: goBrowserForward, sync: () => syncBrowserStateFromBrowser({ markDirtyOnLocationChange: true }), loadBrowserUri }')(
    gecko.browser, browserState, { id: 'browser-a', dataset: {} }, urlInput, { invalidate() {} }, '[test]',
    { error: (...args) => assert.fail(`browser navigation failed: ${args.join(' ')}`) }, { setTimeout: () => 0 },
    url => String(url || ''), () => 'secure', url => String(url), url => String(url || ''),
    () => {}, () => ({}), loading => { browserState.loading = !!loading }, () => {},
    () => { urlInput.value = browserState.uri },
    () => ({ uri: browserState.uri, historyIndex: browserState.historyIndex, historyLength: browserState.history.length }),
    () => {}, () => gecko.browser.currentURI.spec, () => '',
    { userContextId: CONTAINER }, () => true,
    () => ({ browserUserContextId: browser => browser.browsingContext.originAttributes.userContextId }),
    message => notices.push(message))
  return { ...gecko, browserState, controls, notices, urlInput }
}

const agree = (card, url, message) => {
  assert.equal(card.browser.currentURI.spec, url, `${message}: the page is there`)
  assert.equal(card.browserState.uri, url, `${message}: the Card says so`)
  assert.equal(card.urlInput.value, url, `${message}: the address field says so`)
}

test('the results page goes back to the first page when the address is typed again; another string is as before', () => {
  const card = browserCard({ startUrl: 'about:blank' })
  card.controls.navigate(DDG)
  agree(card, DDG, 'first move')
  card.pageMovesTo(RESULTS)
  card.controls.sync()
  agree(card, RESULTS, 'the search')
  assert.equal(card.browser.getAttribute('src'), DDG, 'src stays where the Card sent it')

  const before = card.loads.length
  const snapshot = card.controls.navigate(DDG)
  assert.ok(snapshot, 'the move is reported as made')
  assert.deepEqual(card.loads.slice(before), [{ url: DDG, userContextId: CONTAINER }], 'one load, the same frame loader, the Card\'s container')
  agree(card, DDG, 'the same address again')
  assert.equal(card.browser.getAttribute('src'), DDG)
  assert.deepEqual(card.browserState.history, ['about:blank', DDG, RESULTS, DDG], 'recorded as a move, like any other address')
  assert.equal(card.browserState.historyIndex, 3)
  card.controls.sync()
  agree(card, DDG, 'the page settles')

  const removed = card.calls.remove
  card.pageMovesTo(RESULTS)
  card.controls.sync()
  card.controls.navigate('https://duckduckgo.com/?t=h_')
  agree(card, 'https://duckduckgo.com/?t=h_', 'another string')
  assert.equal(card.calls.remove, removed, 'a changed value is set as before')
  assert.equal(card.loads.length, before + 2)
})

test('home goes home when home is the address the Card was opened with', () => {
  const card = browserCard({ startUrl: DDG, homeUrl: DDG })
  card.pageMovesTo(RESULTS)
  card.controls.sync()
  const before = card.loads.length
  card.controls.home()
  assert.deepEqual(card.loads.slice(before), [{ url: DDG, userContextId: CONTAINER }])
  agree(card, DDG, 'home')
})

test('the Card\'s back to its first address loads it; forward and later steps load as before', () => {
  const card = browserCard({ startUrl: DDG })
  card.pageMovesTo(RESULTS)
  card.controls.sync()
  assert.deepEqual(card.browserState.history, [DDG, RESULTS])
  card.controls.back()
  agree(card, DDG, 'back to the first address')
  assert.equal(card.browserState.historyIndex, 0)
  card.controls.forward()
  agree(card, RESULTS, 'forward again')
  const next = `${RESULTS}&s=10`
  card.pageMovesTo(next)
  card.controls.sync()
  card.controls.back()
  agree(card, RESULTS, 'back to the address src holds, later in the history')
  assert.deepEqual(card.loads.map(load => load.url), [DDG, DDG, RESULTS, RESULTS])
  assert.ok(card.loads.every(load => load.userContextId === CONTAINER))

  // The forward branch takes the same load: a forward entry that src already holds is loaded too.
  card.browserState.history = [RESULTS, next]
  card.browserState.historyIndex = 0
  card.browser.setAttribute('src', next)
  card.pageMovesTo(RESULTS)
  card.controls.forward()
  agree(card, next, 'forward to the address src holds')
})

test('a Card blanked by its guard or a credential scrub is blank even when src was about:blank', () => {
  const card = browserCard({ startUrl: 'about:blank' })
  card.pageMovesTo('https://outside.example/')
  assert.equal(card.controls.loadBrowserUri('about:blank'), true)
  assert.equal(card.browser.currentURI.spec, 'about:blank', 'the guard\'s loadBrowserUri(\'about:blank\')')
  card.pageMovesTo('http://localhost:50430/callback?code=c')
  card.controls.sync()
  card.controls.navigate('about:blank', { replaceHistory: true, markDirty: true })
  agree(card, 'about:blank', 'the scrub\'s navigateBrowser(\'about:blank\')')
})

test('an unconfirmed container still loads nothing, and src is not touched', () => {
  const card = browserCard({ startUrl: DDG })
  card.pageMovesTo(RESULTS)
  card.controls.sync()
  card.browser.browsingContext.originAttributes.userContextId = 0
  const before = card.loads.length
  assert.equal(card.controls.navigate(DDG), null)
  assert.equal(card.loads.length, before)
  assert.equal(card.browser.getAttribute('src'), DDG)
  assert.equal(card.calls.remove, 0)
  assert.equal(card.notices.length, 1)
})

test('an HTML iframe fallback keeps its own same-value load and never loads about:blank in between', () => {
  const card = browserCard({ startUrl: DDG, localName: 'iframe' })
  card.pageMovesTo(RESULTS)
  card.controls.sync()
  const before = card.loads.length
  card.controls.navigate(DDG)
  assert.equal(card.calls.remove, 0)
  assert.ok(card.loads.length > before)
  assert.ok(card.loads.slice(before).every(load => load.url === DDG))
  agree(card, DDG, 'iframe')
})

test('every explicit move reaches this load; Card creation and the sign-in Card keep their plain src set', () => {
  const controls = between('    card._browserControls = {', '      menu: showBrowserMenu,')
  for (const entry of ['navigate: navigateBrowser,', 'back: goBrowserBack,', 'forward: goBrowserForward,',
    'home: () => navigateBrowser(browserState.homeUrl),']) assert.ok(controls.includes(entry), entry)
  const enter = between("    urlInput.addEventListener('keydown', (ev) => {", "    urlInput.addEventListener('focus', () => {")
  assert.match(enter, /navigateBrowser\(url\);/)
  const moves = between('    const navigateBrowser = (rawUrl, navOptions = {}) => {', '    const reloadBrowser = () => {')
  assert.equal(moves.split('loadBrowserUri(url);').length - 1, 3, 'address, back and forward')
  assert.equal(source.split("removeAttribute('src')").length - 1, 1, 'only loadBrowserUri clears src')
  assert.match(source, /if \(!options\.deferInitialLoad\) xulBrowser\.setAttribute\('src', normalizedUrl\);/)
  assert.match(source, /existing\._xulBrowser\?\.setAttribute\('src', url\);/)
})
