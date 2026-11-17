// CTX-03 자료 추천 settings (D-R2) on the screen side: the Settings section,
// the tray's '추천 안 함' entry and the signals the resolver receives.
// No bridge, network or Firefox: the helper resolver is called directly.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as Settings from '../overlay/resources/EGDeskContextSuggestSettings.sys.mjs'
import * as Surface from '../overlay/resources/EGDeskSurfaceState.sys.mjs'
import { CONTEXT_SUGGEST_DEFAULT, normalizeContextSuggest, resolveContext, validateResolverRequest } from '../helper/egdesk-context-resolver.mjs'

class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map(); this.listeners = new Map(); this.className = ''; this.ownText = '' }
  set innerHTML(_) { throw new Error('textContent only') }
  set textContent(value) { this.children = []; this.ownText = String(value) }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join('') }
  setAttribute(key, value) { this.attributes.set(key, String(value)) }
  getAttribute(key) { return this.attributes.has(key) ? this.attributes.get(key) : null }
  append(...nodes) { for (const node of nodes) { assert.ok(node instanceof Node); this.children.push(node) } }
  addEventListener(type, callback) { this.listeners.set(type, callback) }
  fire(type, event = {}) { return this.listeners.get(type)?.(event) }
  all(predicate, out = []) { for (const child of this.children) { if (predicate(child)) out.push(child); child.all(predicate, out) } return out }
  byTestid(id) { return this.all(node => node.getAttribute('data-testid') === id) }
  byClass(name) { return this.all(node => node.className.split(' ').includes(name)) }
}
const document = { createElement: tag => new Node(tag) }

test('the inferred D-R2 default matches the helper: always suggest, empty never-suggest list', () => {
  assert.equal(Settings.CONTEXT_SUGGEST_DEFAULT_MODE, CONTEXT_SUGGEST_DEFAULT.mode)
  assert.deepEqual(Settings.CONTEXT_SUGGEST_MODES, ['always', 'firstMessage', 'off'])
  assert.deepEqual(Settings.modeChoices(undefined).map(choice => [choice.id, choice.label, choice.selected]),
    [['always', '항상 추천 (기본)', true], ['firstMessage', '첫 메시지에서만', false], ['off', '추천 끄기', false]])
})

test('entries from typed text and from suggestion cards use the helper accepted shapes', () => {
  assert.deepEqual(Settings.neverSuggestEntryFromInput(' Bank.Example.com '), { entry: { kind: 'site', host: 'bank.example.com' } })
  assert.deepEqual(Settings.neverSuggestEntryFromInput('https://www.bank.example.com/login?x=1'), { entry: { kind: 'site', host: 'bank.example.com' } })
  assert.deepEqual(Settings.neverSuggestEntryFromInput('/Users/me/private/'), { entry: { kind: 'folder', path: '/Users/me/private' } })
  for (const bad of ['', 'not a host', 'http://', 'a\u0000b', 'bank.example.com/path']) assert.deepEqual(Settings.neverSuggestEntryFromInput(bad), { error: 'invalid' }, bad)
  assert.deepEqual(Settings.neverSuggestEntryForSource({ kind: 'browser', url: 'https://mail.example.org/inbox' }), { kind: 'site', host: 'mail.example.org' })
  assert.equal(Settings.neverSuggestEntryForSource({ kind: 'browser', url: 'about:blank' }), null)
  assert.deepEqual(Settings.neverSuggestEntryForSource({ kind: 'file', folderPath: '/work/secret' }), { kind: 'folder', path: '/work/secret' })
  assert.equal(Settings.neverSuggestEntryForSource({ kind: 'file', folderPath: 'relative' }), null)
  assert.equal(Settings.neverSuggestEntryForSource({ kind: 'board-element' }), null)
  // Every produced entry is accepted by the helper normalizer unchanged.
  const entries = [Settings.neverSuggestEntryFromInput('bank.example.com').entry, Settings.neverSuggestEntryFromInput('/Users/me/private').entry]
  assert.deepEqual(normalizeContextSuggest({ mode: 'always', neverSuggest: entries }).neverSuggest, entries)
  assert.equal(Settings.neverSuggestActionLabel(entries[0]), 'bank.example.com 추천 안 함')
  assert.equal(Settings.neverSuggestActionLabel(entries[1]), '이 폴더 추천 안 함')
})

test('list editing refuses duplicates and the 64-entry cap; folder and site matching', () => {
  const site = { kind: 'site', host: 'example.com' }
  assert.deepEqual(Settings.withNeverSuggest([], site), { neverSuggest: [site] })
  assert.deepEqual(Settings.withNeverSuggest([site], { ...site }), { error: 'duplicate' })
  const full = Array.from({ length: 64 }, (_, index) => ({ kind: 'site', host: `h${index}.example.com` }))
  assert.deepEqual(Settings.withNeverSuggest(full, site), { error: 'full' })
  assert.deepEqual(Settings.withoutNeverSuggest([site, { kind: 'folder', path: '/a' }], site), { neverSuggest: [{ kind: 'folder', path: '/a' }] })
  assert.equal(Settings.siteExcluded('mail.example.com', [site]), true)
  assert.equal(Settings.siteExcluded('badexample.com', [site]), false)
  assert.equal(Settings.folderExcluded('/work/secret/sub', [{ kind: 'folder', path: '/work/secret' }]), true)
  assert.equal(Settings.folderExcluded('/work/secret', [{ kind: 'folder', path: '/work/secret/' }]), true)
  assert.equal(Settings.folderExcluded('/work/secretive', [{ kind: 'folder', path: '/work/secret' }]), false)
  assert.equal(Settings.normalizeSuggestSettings({ mode: 'sometimes', neverSuggest: [] }), null)
  assert.deepEqual(Settings.normalizeSuggestSettings({ mode: 'off', neverSuggest: [site, { kind: 'folder', path: 'rel' }], persisted: true }),
    { mode: 'off', neverSuggest: [site], persisted: true })
})

test('the Settings section shows the mode and the list, and reports each change through the host', async () => {
  const calls = []
  const value = Settings.normalizeSuggestSettings({ mode: 'always', neverSuggest: [{ kind: 'site', host: 'bank.example.com' }, { kind: 'folder', path: '/private' }], persisted: true })
  const section = Settings.renderContextSuggestSettings({ document, view: { status: 'ready', value },
    onMode: async mode => calls.push(['mode', mode]), onRemove: async entry => calls.push(['remove', entry]), onAdd: async entry => calls.push(['add', entry]) })
  assert.equal(section.getAttribute('data-testid'), 'settings-context-suggest')
  assert.match(section.textContent, /자료 추천/)
  const always = section.byTestid('settings-context-suggest-mode-always')[0]
  const off = section.byTestid('settings-context-suggest-mode-off')[0]
  assert.equal(always.getAttribute('aria-checked'), 'true')
  await always.fire('click')
  await off.fire('click')
  const rows = section.byClass('egd-settings-context-suggest-entry')
  assert.deepEqual(rows.map(row => row.byClass('egd-settings-context-suggest-entry-label')[0].textContent), ['사이트 · bank.example.com', '폴더 · /private'])
  await rows[1].byClass('egd-settings-context-suggest-remove')[0].fire('click')
  const input = section.byTestid('settings-context-suggest-input')[0]
  const add = section.byTestid('settings-context-suggest-add')[0]
  input.value = 'bank.example.com'; await add.fire('click')
  const status = section.byTestid('settings-context-suggest-status')[0]
  assert.equal(status.textContent, '이미 목록에 있습니다.')
  input.value = 'not valid'; await add.fire('click')
  assert.match(status.textContent, /사이트 이름/)
  input.value = 'news.example.net'
  await input.fire('keydown', { key: 'Enter', isComposing: true })
  await input.fire('keydown', { key: 'Enter', preventDefault() {} })
  assert.deepEqual(calls, [['mode', 'off'], ['remove', { kind: 'folder', path: '/private' }], ['add', { kind: 'site', host: 'news.example.net' }]],
    'the selected mode is not resent, invalid and duplicate input never reaches the host, and IME composition does not submit')
  for (const [status, text] of [['loading', /불러오는 중/], ['error', /불러오지 못했습니다/], ['unsupported', /지원하지 않습니다/]]) {
    const node = Settings.renderContextSuggestSettings({ document, view: { status } })
    assert.match(node.textContent, text)
    assert.equal(node.byTestid('settings-context-suggest-mode').length, 0)
  }
  const empty = Settings.renderContextSuggestSettings({ document, view: { status: 'ready', value: Settings.normalizeSuggestSettings({ mode: 'off', neverSuggest: [] }), message: Settings.CONTEXT_SUGGEST_SETTINGS_TEXT.notPersisted } })
  assert.match(empty.textContent, /없음 · /)
  assert.match(empty.textContent, /이번 실행에만 적용/)
})

test('screen signals carry only a userExcluded boolean (no site, URL or path), and the helper leaves listed sources out', () => {
  const neverSuggest = [{ kind: 'site', host: 'bank.example.com' }, { kind: 'folder', path: '/work/secret' }]
  const rect = { left: 0, top: 0, width: 600, height: 500 }, boardId = 'board-1'
  const views = [
    Settings.markSuggestSignal({ ref: 'bank', kind: 'browser', rect, boardId }, { url: 'https://www.bank.example.com/account', neverSuggest }),
    Settings.markSuggestSignal({ ref: 'docs', kind: 'browser', rect: { ...rect, left: 620 }, boardId }, { url: 'https://docs.example.org/page', neverSuggest }),
    Settings.markSuggestSignal({ ref: 'secret', kind: 'file', rect: { ...rect, top: 520 }, boardId }, { folderPath: '/work/secret/app', neverSuggest }),
    Settings.markSuggestSignal({ ref: 'open', kind: 'file', rect: { ...rect, left: 620, top: 520 }, boardId }, { folderPath: '/work/open', neverSuggest }),
  ]
  assert.deepEqual(views.map(view => [view.site ?? null, view.userExcluded === true]), [[null, true], [null, false], [null, true], [null, false]])
  const signals = { ...Surface.contextResolverSignals({ views, activeBoardId: boardId, viewport: { width: 1400, height: 1100 }, scopes: ['p'] }), firstMessage: true }
  const text = JSON.stringify(signals)
  for (const leaked of ['https://', 'bank.example', 'docs.example', '/account', '/work/secret', '/work/open']) assert.equal(text.includes(leaked), false, leaked)
  validateResolverRequest(signals)
  const resolved = resolveContext(signals, { suggest: { mode: 'always', neverSuggest } })
  assert.deepEqual(resolved.candidates.map(candidate => candidate.ref).sort(), ['docs', 'open'])
  // firstMessage mode: suggestions only before the room's first message.
  assert.ok(resolveContext(signals, { suggest: { mode: 'firstMessage', neverSuggest: [] } }).candidates.length > 0)
  assert.equal(resolveContext({ ...signals, firstMessage: false }, { suggest: { mode: 'firstMessage', neverSuggest: [] } }).candidates.length, 0)
  // A site handed to the signal builder is never forwarded.
  const odd = Surface.contextResolverSignals({ views: [{ ref: 'x', kind: 'browser', rect, site: 'x.example.com', userExcluded: 'yes' }], viewport: { width: 1400, height: 1100 } })
  assert.equal(odd.visible[0].site, undefined)
  assert.equal(odd.visible[0].userExcluded, undefined)
  // Subdomains of a listed site are excluded too, like the helper's rule.
  assert.equal(Settings.markSuggestSignal({ kind: 'browser' }, { url: 'https://login.bank.example.com/', neverSuggest }).userExcluded, true)
})
