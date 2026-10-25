import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createEGDeskProfileTransferView } from '../overlay/resources/EGDeskProfileTransferView.sys.mjs'
import { createEGDeskProfileTransfer } from '../overlay/resources/EGDeskProfileTransfer.sys.mjs'
import { importAgentFile, exportAgentFile } from '../helper/egdesk-profile-file.mjs'
import { profileHash } from '../helper/egdesk-profile-store.mjs'

// Small RunResult-style DOM fixture. Production listeners and the actual flow
// run here; no native picker, server, filesystem write, browser or provider.
class Node {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map()
    this.listeners = new Map(); this.parentNode = null; this.className = ''; this.ownText = ''; this.disabled = false
  }
  set textContent(value) { this.replaceChildren(); this.ownText = String(value) }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join('') }
  set innerHTML(_) { assert.fail('HTML must never be parsed') }
  get isConnected() { return this.tagName === 'ROOT' || this.parentNode?.isConnected === true }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  contains(node) { return this === node || this.children.some(child => child.contains(node)) }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this)
    this.parentNode = null
  }
  append(...nodes) {
    for (const node of nodes) { assert.ok(node instanceof Node); node.remove(); node.parentNode = this; this.children.push(node) }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null
    this.children = []; this.ownText = ''; this.append(...nodes)
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(listener)
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener) }
  fire() { return Promise.all([...(this.listeners.get('click') || [])].map(listener => listener({ currentTarget: this }))) }
  click() { return this.disabled ? Promise.resolve([]) : this.fire() }
}
const walk = node => [node, ...node.children.flatMap(walk)]
const find = (node, selector) => walk(node).find(item => item.getAttribute('data-testid') === selector)
const byClass = (node, name) => walk(node).filter(item => item.className.split(' ').includes(name))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const source = () => ({ filename: 'reviewer.MD', text: [
  '---', 'name: reviewer', 'description: Reviews diffs.', 'tools: Read, Grep, MagicTool',
  'color: orange', 'api_key: sk-do-not-display', 'permissionMode: bypassPermissions', '---', 'Review the diff.\r\n',
].join('\r\n') })
const previewPacket = input => ({ dryRun: true, ...importAgentFile(input.text, { filename: input.filename }) })
function draftPacket(input) {
  const { body, preview } = importAgentFile(input.text, { filename: input.filename })
  const id = 'prof-imported', hash = profileHash(body)
  return { id, revision: 1, hash, unchanged: false, preview,
    profile: { id, lifecycle: 'draft', activeRevision: null, active: null, reviewRequired: true, headRevision: 1, hasDraft: true,
      head: { profileId: id, revision: 1, hash, body } } }
}
const exportBody = { name: '리오', role: '회의 준비', instructions: 'Be precise.',
  model: { engine: 'codex', modelId: 'gpt-6-astra', effort: 'max' } }
const target = () => ({ profileId: 'prof-visible', revision: 7, hash: profileHash(exportBody) })
const IMPORT = 'settings-agent-import', CONFIRM = 'settings-agent-import-confirm', CANCEL = 'transfer-cancel'
const MD = 'settings-agent-export-md', TOML = 'settings-agent-export-toml'

function fixture(options = {}) {
  const root = new Node('root'), document = { createElement: tag => new Node(tag) }
  const view = createEGDeskProfileTransferView({ document })
  const calls = { requests: [], reads: [], saves: [], writes: [], drafts: [], confirmations: [] }
  let exportTarget = options.exportTarget === undefined ? target() : options.exportTarget, actions
  const flow = createEGDeskProfileTransfer({
    request: async (path, init) => {
      calls.requests.push({ path, init })
      if (options.request) return options.request(path, init, calls)
      if (path === '/profiles/import') {
        if (init.body.dryRun) return previewPacket(init.body)
        const packet = draftPacket(init.body); calls.drafts.push(packet); return packet
      }
      const url = new URL(path, 'https://fixture.invalid')
      return { profileId: url.pathname.split('/')[2], revision: Number(url.searchParams.get('revision')),
        hash: profileHash(exportBody), ...exportAgentFile(exportBody, url.searchParams.get('format')), omitted: ['avatarImage', 'fixture-only'] }
    },
    readText: async init => { calls.reads.push(init); return options.readText ? options.readText(init) : source() },
    saveText: async init => {
      calls.saves.push(init)
      if (options.saveText) return options.saveText(init, calls)
      if (!init.beginWrite()) return { cancelled: true }
      calls.writes.push(init.text); return { saved: true }
    },
    onState: state => view.update({ state, actions, exportTarget }),
  })
  const bind = () => {
    const actual = flow.bind()
    actions = Object.freeze({ ...actual, confirmImport: value => {
      calls.confirmations.push(value); return actual.confirmImport(value)
    } })
  }
  bind()
  const update = () => view.update({ state: flow.snapshot(), actions, exportTarget })
  root.append(view.element); update()
  return { root, view, flow, calls, update, get actions() { return actions }, get exportTarget() { return exportTarget },
    node: selector => find(view.element, selector), click: selector => find(view.element, selector).click(),
    select(value) { exportTarget = value; update() },
    rebind(value = exportTarget) { flow.invalidate(); bind(); exportTarget = value; update() } }
}

test('factory/update are inert; only injected document and the three-member API are needed', () => {
  assert.throws(() => createEGDeskProfileTransferView(), TypeError)
  const h = fixture()
  assert.deepEqual(Object.keys(h.view).sort(), ['dispose', 'element', 'update'])
  assert.ok(Object.isFrozen(h.view))
  h.update(); h.update()
  assert.deepEqual(Object.values(h.calls).map(items => items.length), [0, 0, 0, 0, 0, 0])
  assert.equal(h.node(IMPORT).textContent, 'Markdown 파일 선택')
  assert.equal(h.node(CONFIRM), undefined)
  assert.equal(h.node('transfer-status').getAttribute('role'), 'status')
  assert.equal(h.node('transfer-status').getAttribute('aria-live'), 'polite')
  assert.match(h.node('transfer-export-target').textContent, /prof-visible · 저장 버전 7/)
})

test('explicit MD click previews without creation and displays actual imported body, not selected export profile', async () => {
  const h = fixture(), expected = previewPacket(source())
  await h.click(IMPORT)
  assert.equal(h.flow.snapshot().status, 'preview')
  assert.equal(h.calls.reads.length, 1)
  assert.deepEqual([h.calls.reads[0].accept, h.calls.reads[0].encoding, h.calls.reads[0].maxBytes], ['.md', 'utf-8', 57344])
  assert.equal(h.calls.requests.length, 1); assert.equal(h.calls.requests[0].init.body.dryRun, true)
  assert.deepEqual([h.calls.drafts.length, h.calls.saves.length], [0, 0])
  assert.match(h.node('import-preview').textContent, /reviewer/)
  assert.match(h.node('import-preview').textContent, /Reviews diffs\./)
  assert.equal(h.node('import-preview').textContent.includes('리오'), false)
  assert.equal(h.node('import-instructions').textContent, expected.body.instructions)
  assert.equal(h.node(CONFIRM).textContent, '초안 가져오기'); assert.equal(h.node(CONFIRM).disabled, false)
  assert.match(h.node('import-preview').textContent, /자동 활성화하거나 대화방에 배정하지 않습니다/)
  assert.equal(h.view.element.textContent.includes('sk-do-not-display'), false, 'raw unsupported values are not disclosed')
})

test('confirmation passes the original opaque object, exact original input and creates one draft only', async () => {
  const h = fixture()
  await h.click(IMPORT)
  const original = h.flow.snapshot().confirmation, oldButton = h.node(CONFIRM)
  await Promise.all([oldButton.click(), oldButton.fire(), oldButton.click()])
  assert.equal(h.calls.confirmations.length, 1)
  assert.equal(h.calls.confirmations[0], original)
  assert.deepEqual(h.calls.requests.map(call => call.init.body), [{ ...source(), dryRun: true }, { ...source(), dryRun: false }])
  assert.equal(h.calls.drafts.length, 1); assert.equal(h.flow.snapshot().status, 'imported')
  assert.equal(h.node(CONFIRM).disabled, true)
  await h.node(CONFIRM).fire()
  assert.equal(h.calls.drafts.length, 1)
  assert.ok(h.calls.requests.every(call => call.path === '/profiles/import'), 'no activation or room assignment')
  assert.match(h.node('transfer-status').textContent, /초안을 가져왔습니다/)
})

test('all unsupported fields, total count, unmapped tools and adjusted metadata reasons remain visible', async () => {
  const h = fixture()
  await h.click(IMPORT)
  const state = h.flow.snapshot()
  for (const field of state.preview.unknownFields) assert.ok(h.node('import-unknown-fields').textContent.includes(field))
  for (const tool of state.preview.unmappedTools) assert.ok(h.node('import-unmapped-tools').textContent.includes(tool))
  for (const adjustment of state.preview.adjusted) {
    assert.ok(h.node('import-adjusted').textContent.includes(adjustment.field))
    assert.ok(h.node('import-adjusted').textContent.includes(adjustment.reason))
  }
  h.view.update({ state: { ...state, preview: { ...state.preview, unknownFieldCount: 57 } }, actions: h.actions, exportTarget: target() })
  assert.match(h.node('import-unknown-fields').textContent, /전체 57개 · 이름 표시 2개/)
})

test('full long instructions, exact line breaks and malicious values remain readable text under inherited bounded layout', async () => {
  const h = fixture()
  await h.click(IMPORT)
  const attack = '<img src=x onerror="throw 1"><script>globalThis.pwned=true</script>&amp;'
  const instructions = `${attack}\r\n${'한 줄\n'.repeat(6000)}THE LAST LINE\rEND`
  const state = h.flow.snapshot()
  h.view.update({ state: { ...state, body: { ...state.body, name: attack, role: attack, instructions }, message: attack,
    preview: { ...state.preview, unknownFields: [attack], unknownFieldCount: 7, unmappedTools: [attack], adjusted: [{ field: attack, reason: attack }] } },
  actions: h.actions, exportTarget: target() })
  assert.equal(h.node('import-instructions').textContent, instructions)
  assert.equal(h.node('import-instructions').getAttribute('tabindex'), '0')
  assert.ok(h.node('import-instructions').className.includes('egd-settings-instructions'))
  assert.ok(h.view.element.textContent.includes(attack))
  assert.equal(walk(h.view.element).some(node => ['IMG', 'SCRIPT', 'IFRAME', 'A'].includes(node.tagName)), false)
  for (const node of walk(h.view.element)) {
    assert.equal(node.attributes.has('onclick'), false); assert.equal(node.attributes.has('src'), false)
  }
  const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8')
  assert.match(css, /\.egd-settings-instructions\s*\{[^}]*max-height:\s*160px;[^}]*overflow:\s*auto;[^}]*white-space:\s*pre-wrap;/)
})

test('required Settings classes, semantic detail rows and stable selector aliases are reused without inline styling', async () => {
  const h = fixture()
  await h.click(IMPORT)
  for (const suffix of ['section', 'section-head', 'section-title', 'detail-actions', 'btn', 'btn-primary', 'detail-list', 'detail-row', 'instructions', 'notice', 'callout', 'plain-list']) {
    assert.ok(byClass(h.view.element, `egd-settings-${suffix}`).length, suffix)
  }
  for (const selector of [IMPORT, MD, TOML, CONFIRM, 'transfer-status', CANCEL, 'import-preview', 'import-instructions']) {
    const node = h.node(selector)
    assert.ok(node, selector); assert.equal(node.getAttribute('data-action'), selector)
  }
  for (const node of walk(h.view.element)) {
    assert.equal(node.attributes.has('style'), false)
    if (node.tagName === 'BUTTON') assert.equal(node.type, 'button')
  }
  for (const node of byClass(h.view.element, 'egd-settings-detail-row')) assert.deepEqual(node.children.map(child => child.tagName), ['DT', 'DD'])
})

for (const [selector, format] of [[MD, 'md'], [TOML, 'codex-toml']]) {
  test(`${format} export uses the exact visible saved revision and displays every omitted field`, async () => {
    const selected = target(), h = fixture({ exportTarget: selected })
    const button = h.node(selector)
    selected.profileId = 'prof-mutated'; selected.revision = 99; selected.hash = '0'.repeat(64)
    await button.click()
    assert.equal(h.calls.requests.length, 1)
    assert.equal(h.calls.requests[0].path, `/profiles/prof-visible/export?format=${format}&revision=7`)
    assert.equal(h.calls.requests[0].init.method, 'GET')
    assert.equal(h.calls.writes.length, 1); assert.equal(h.flow.snapshot().status, 'saved')
    assert.equal(h.calls.saves[0].contentType, format === 'md' ? 'text/markdown; charset=utf-8' : 'application/toml; charset=utf-8')
    for (const omitted of ['avatarImage', 'fixture-only']) assert.ok(h.node('transfer-omitted').textContent.includes(omitted))
    assert.match(h.view.element.textContent, /이번 내보내기prof-visible · 버전 7/)
  })
}

test('a hash mismatch cannot reach saveText; invalid/missing export targets leave both format buttons inert', async () => {
  const h = fixture({ exportTarget: { ...target(), hash: '0'.repeat(64) } })
  await h.click(MD)
  assert.equal(h.flow.snapshot().code, 'PROFILE_EXPORT_RESPONSE_INVALID'); assert.equal(h.calls.saves.length, 0)
  for (const value of [null, { profileId: 'prof-a' }, { ...target(), revision: 0 }, { ...target(), revision: 1.5 },
    { ...target(), revision: 1000000000 }, { ...target(), profileId: '../a' }, { ...target(), hash: 'wrong' }]) {
    h.select(value)
    assert.equal(h.node(MD).disabled, true); assert.equal(h.node(TOML).disabled, true)
    await h.node(MD).fire(); await h.node(TOML).fire()
  }
  assert.equal(h.calls.requests.length, 1)
  assert.equal(h.node(IMPORT).disabled, false, 'import does not require an export selection')
})

test('cancel at preview revokes confirmation with zero creations; stale confirm nodes are inert', async () => {
  const h = fixture()
  await h.click(IMPORT)
  const oldConfirm = h.node(CONFIRM)
  await h.click(CANCEL)
  await oldConfirm.fire()
  assert.equal(h.flow.snapshot().status, 'cancelled')
  assert.equal(h.calls.requests.length, 1); assert.equal(h.calls.drafts.length, 0)
  assert.match(h.node('transfer-status').textContent, /초안을 만들지 않았습니다/)
  assert.equal(h.node(CONFIRM).disabled, true); assert.equal(h.node(CANCEL), undefined)
})

test('read-picker cancellation causes zero requests; save-picker cancellation causes zero writes', async () => {
  const reader = fixture({ readText: () => ({ cancelled: true }) })
  await reader.click(IMPORT)
  assert.equal(reader.calls.requests.length, 0); assert.equal(reader.flow.snapshot().status, 'cancelled')
  const writer = fixture({ saveText: () => ({ cancelled: true }) })
  await writer.click(MD)
  assert.equal(writer.calls.requests.length, 1); assert.equal(writer.calls.writes.length, 0)
  assert.equal(writer.flow.snapshot().status, 'cancelled')
  assert.match(writer.node('transfer-status').textContent, /파일을 쓰지 않았습니다/)
})

test('duplicate import clicks while picker is pending are guarded, cancellation ignores the late source', async () => {
  const picker = deferred(), h = fixture({ readText: () => picker.promise }), oldImport = h.node(IMPORT)
  const pending = oldImport.click()
  await oldImport.fire(); await h.node(IMPORT).fire(); await h.node(MD).fire()
  assert.equal(h.calls.reads.length, 1); assert.equal(h.calls.requests.length, 0)
  assert.equal(h.view.element.getAttribute('aria-busy'), 'true')
  await h.click(CANCEL)
  picker.resolve(source()); await pending; await settle()
  assert.equal(h.calls.requests.length, 0); assert.equal(h.flow.snapshot().status, 'cancelled')
})

test('duplicate confirmation clicks while POST is pending dispatch once; interruption after dispatch stays unknown', async () => {
  const commit = deferred(), h = fixture({ request: (path, init) => init.body.dryRun ? previewPacket(init.body) : commit.promise })
  await h.click(IMPORT)
  const confirm = h.node(CONFIRM), pending = confirm.click()
  await confirm.fire(); await h.node(CONFIRM).fire(); await h.node(IMPORT).fire()
  assert.equal(h.calls.confirmations.length, 1); assert.equal(h.calls.requests.length, 2)
  await h.click(CANCEL)
  assert.equal(h.flow.snapshot().status, 'unknown')
  assert.match(h.view.element.textContent, /Agent 목록에서 결과를 확인/)
  assert.equal(h.node(IMPORT).disabled, true); assert.equal(h.node(CONFIRM).disabled, true)
  commit.resolve(draftPacket(source())); await pending; await settle()
  assert.equal(h.flow.snapshot().status, 'unknown'); assert.equal(h.calls.requests.length, 2)
  assert.equal(h.node(CANCEL), undefined, 'unknown is not presented as a cancellable no-op')
})

test('post-write failure remains unknown, preserves omitted warnings and never retries', async () => {
  const h = fixture({ saveText: init => {
    assert.equal(init.beginWrite(), true)
    throw Object.assign(new Error('/private/picked/path partial'), { code: 'EEXIST' })
  } })
  await h.click(TOML)
  assert.equal(h.flow.snapshot().status, 'unknown')
  assert.match(h.view.element.textContent, /일부 또는 전부 저장되었을 수 있습니다/)
  assert.equal(h.view.element.textContent.includes('/private/picked/path'), false)
  assert.ok(h.node('transfer-omitted').textContent.includes('avatarImage'))
  for (const selector of [IMPORT, MD, TOML]) { assert.equal(h.node(selector).disabled, true); await h.node(selector).fire() }
  assert.equal(h.calls.saves.length, 1)
})

test('known-existing target failure clearly asks for another name, without claiming cancel or save', async () => {
  const h = fixture({ saveText: () => { throw Object.assign(new Error('safe'), { code: 'TEXT_FILE_EXISTS' }) } })
  await h.click(MD)
  assert.equal(h.flow.snapshot().status, 'failed'); assert.equal(h.calls.writes.length, 0)
  assert.equal(h.node('transfer-status').getAttribute('data-code'), 'TEXT_FILE_EXISTS')
  assert.match(h.view.element.textContent, /기존 파일은 덮어쓰지 않습니다.*다른 이름이나 위치/)
  assert.equal(h.view.element.textContent.includes('저장했습니다'), false)
  assert.equal(h.node(MD).disabled, false, 'another deliberate picker attempt is possible')
})

test('recoverable preview errors keep source in the flow without rendering secret raw input', async () => {
  const h = fixture({ request: () => { throw new Error('/private/error-path') } })
  await h.click(IMPORT)
  assert.equal(h.flow.snapshot().status, 'failed'); assert.equal(h.flow.snapshot().recoverable, true)
  assert.deepEqual(h.flow.snapshot().source, source())
  assert.match(h.view.element.textContent, /선택한 원문을 유지했습니다: reviewer.MD/)
  assert.equal(h.view.element.textContent.includes('sk-do-not-display'), false)
  assert.equal(h.view.element.textContent.includes('/private/error-path'), false)
  assert.equal(h.node(CONFIRM), undefined); assert.equal(h.node(IMPORT).disabled, false)
  assert.equal(h.calls.requests.length, 1, 'no automatic retry')
})

test('definite recoverable commit rejection retains full preview and permits only another explicit confirmation', async () => {
  const h = fixture({ request: (path, init) => {
    if (init.body.dryRun) return previewPacket(init.body)
    throw Object.assign(new Error('definite'), { code: 'PROFILE_REJECTED', httpStatus: 422 })
  } })
  await h.click(IMPORT)
  const token = h.flow.snapshot().confirmation, instructions = h.node('import-instructions').textContent
  await h.click(CONFIRM)
  assert.equal(h.flow.snapshot().status, 'failed'); assert.equal(h.node(CONFIRM).disabled, false)
  assert.equal(h.node('import-instructions').textContent, instructions)
  assert.equal(h.calls.requests.length, 2)
  await h.click(CONFIRM)
  assert.equal(h.calls.requests.length, 3); assert.ok(h.calls.confirmations.every(value => value === token))
})

test('each update retires previous DOM listeners, including old nodes reattached inside the current root', async () => {
  const h = fixture(), old = h.node(MD), listener = [...old.listeners.get('click')][0]
  h.select({ ...target(), revision: 8 })
  h.view.element.append(old)
  await old.fire(); await listener()
  assert.equal(h.calls.requests.length, 0)
  await h.click(MD)
  assert.match(h.calls.requests[0].path, /revision=8$/)
})

test('detached root or detached button cannot call any action, even through a captured listener', async () => {
  const h = fixture(), old = h.node(IMPORT), listener = [...old.listeners.get('click')][0]
  h.view.element.remove()
  await old.fire(); await listener()
  assert.equal(h.calls.reads.length, 0)
  h.root.append(h.view.element)
  old.remove(); h.root.append(old)
  await old.fire(); await listener()
  assert.equal(h.calls.reads.length, 0, 'connected elsewhere is not owned by the view')
})

test('invalidate/rebind fences old actions, old confirmations, late async callbacks and older binding updates', async () => {
  const picker = deferred(), h = fixture({ readText: () => picker.promise })
  const oldState = h.flow.snapshot(), oldActions = h.actions, oldButton = h.node(IMPORT)
  const pending = oldButton.click()
  h.rebind({ ...target(), profileId: 'prof-next', revision: 4 })
  const newText = h.view.element.textContent
  h.view.update({ state: oldState, actions: oldActions, exportTarget: target() })
  assert.equal(h.view.element.textContent, newText)
  await oldButton.fire(); await oldActions.importFile()
  picker.resolve(source()); await pending; await settle()
  assert.equal(h.calls.reads.length, 1); assert.equal(h.calls.requests.length, 0)
  assert.equal(h.node('import-preview'), undefined)
  assert.match(h.node('transfer-export-target').textContent, /prof-next · 저장 버전 4/)
  await h.click(MD)
  assert.match(h.calls.requests[0].path, /^\/profiles\/prof-next\/export.*revision=4$/)
})

test('state/actions binding mismatch and disposed/stale flow states cannot dispatch', async () => {
  for (const status of ['idle', 'disposed', 'stale']) {
    const h = fixture(), state = { ...h.flow.snapshot(), status }
    h.view.update({ state, actions: status === 'idle' ? { ...h.actions, binding: 999 } : h.actions, exportTarget: target() })
    for (const selector of [IMPORT, MD, TOML]) { assert.equal(h.node(selector).disabled, true); await h.node(selector).fire() }
    assert.equal(h.calls.requests.length, 0); assert.equal(h.calls.reads.length, 0)
  }
})

test('dispose is idempotent, revokes captured listeners and does not take ownership of flow cancellation', async () => {
  const h = fixture(), old = h.node(IMPORT), listener = [...old.listeners.get('click')][0]
  h.view.dispose(); h.view.dispose(); h.update()
  h.view.element.append(old)
  await old.fire(); await listener()
  assert.equal(h.calls.reads.length, 0)
  assert.equal(h.view.element.getAttribute('data-state'), 'disposed')
  assert.equal(h.flow.snapshot().status, 'idle', 'host retains flow teardown ownership')
})

test('late action promise results do not render receipts; local rejection is contained and cannot change a newer view', async () => {
  const h = fixture(), old = deferred(), state = h.flow.snapshot()
  let count = 0
  h.view.update({ state, actions: { ...h.actions, importFile: () => { count++; return old.promise } }, exportTarget: target() })
  const button = h.node(IMPORT), pending = button.click()
  await button.fire(); assert.equal(count, 1)
  h.update()
  const currentText = h.view.element.textContent
  old.reject(new Error('/private/late-error'))
  await pending
  assert.equal(h.view.element.textContent, currentText)
  const receipt = { status: 'imported', message: 'fake-success' }
  h.view.update({ state, actions: { ...h.actions, importFile: () => Promise.resolve(receipt) }, exportTarget: target() })
  await h.click(IMPORT)
  assert.equal(h.view.element.textContent.includes('fake-success'), false)
})

test('throwing or rejecting action callback cannot leak an error or unlock duplicate calls', async () => {
  for (const callback of [() => { throw new Error('/private/throw') }, () => Promise.reject(new Error('/private/reject'))]) {
    const h = fixture()
    h.view.update({ state: h.flow.snapshot(), actions: { ...h.actions, importFile: callback }, exportTarget: target() })
    const button = h.node(IMPORT)
    await button.click(); await button.fire()
    assert.match(h.node('transfer-status').textContent, /결과를 확인하지 못했습니다/)
    assert.equal(h.view.element.textContent.includes('/private/'), false)
    assert.equal(button.disabled, true)
  }
})

test('view source has no flow creation, native adapter, network, HTML sink, logging, styling or module-global document', () => {
  const sourceText = readFileSync(new URL('../overlay/resources/EGDeskProfileTransferView.sys.mjs', import.meta.url), 'utf8')
  assert.equal(/\bimport\s|createEGDeskProfileTransfer\(|innerHTML|outerHTML|insertAdjacentHTML|\beval\(|\bfetch\(|XMLHttpRequest|IOUtils|FilePicker|ChromeUtils|console\.|\.style\b|globalThis|window\./.test(sourceText), false)
})

test('rebinding a ready preview retires its token and button before another file can be confirmed', async () => {
  const h = fixture()
  await h.click(IMPORT)
  const old = { state: h.flow.snapshot(), actions: h.actions, button: h.node(CONFIRM) }
  const listener = [...old.button.listeners.get('click')][0]
  h.rebind()
  await h.click(IMPORT)
  const freshToken = h.flow.snapshot().confirmation
  assert.notEqual(freshToken, old.state.confirmation)
  h.view.update({ state: old.state, actions: old.actions, exportTarget: target() })
  await old.button.fire(); await listener()
  assert.equal(h.calls.confirmations.length, 0)
  await h.click(CONFIRM)
  assert.equal(h.calls.confirmations[0], freshToken)
  assert.equal(h.calls.drafts.length, 1)
})

test('cancelling while the save picker is pending prevents its late write gate and keeps cancellation accurate', async () => {
  const picked = deferred()
  const h = fixture({ saveText: async (init, calls) => {
    await picked.promise
    if (!init.beginWrite()) return { cancelled: true }
    calls.writes.push(init.text); return { saved: true }
  } })
  const oldExport = h.node(MD), pending = oldExport.click()
  await settle()
  assert.equal(h.flow.snapshot().status, 'saving')
  await oldExport.fire(); await h.node(TOML).fire()
  assert.equal(h.calls.saves.length, 1)
  await h.click(CANCEL)
  picked.resolve(); await pending; await settle()
  assert.equal(h.calls.writes.length, 0); assert.equal(h.flow.snapshot().status, 'cancelled')
  assert.match(h.node('transfer-status').textContent, /파일을 쓰지 않았습니다/)
})

test('invalidating an export with a late picker cannot write or replace the new selected profile view', async () => {
  const picked = deferred()
  const h = fixture({ saveText: async (init, calls) => {
    await picked.promise
    if (!init.beginWrite()) return { cancelled: true }
    calls.writes.push(init.text); return { saved: true }
  } })
  const pending = h.click(MD)
  await settle()
  h.rebind({ ...target(), profileId: 'prof-after', revision: 12 })
  const nextText = h.view.element.textContent
  picked.resolve(); await pending; await settle()
  assert.equal(h.calls.writes.length, 0); assert.equal(h.view.element.textContent, nextText)
  assert.match(h.node('transfer-export-target').textContent, /prof-after · 저장 버전 12/)
  assert.equal(h.node('transfer-omitted'), undefined)
})

test('unknown import receipt has no successful draft claim or enabled retry, including after a second update', async () => {
  const h = fixture({ request: (path, init) => {
    if (init.body.dryRun) return previewPacket(init.body)
    throw Object.assign(new Error('/private/uncertain'), { httpStatus: 500 })
  } })
  await h.click(IMPORT); await h.click(CONFIRM); h.update()
  assert.equal(h.flow.snapshot().status, 'unknown')
  assert.equal(h.view.element.textContent.includes('초안을 가져왔습니다'), false)
  assert.match(h.view.element.textContent, /초안이 만들어졌을 수 있습니다/)
  assert.equal(h.node(CONFIRM).disabled, true); assert.equal(h.node(IMPORT).disabled, true)
  await h.node(CONFIRM).fire(); await h.node(IMPORT).fire()
  assert.equal(h.calls.requests.length, 2)
})

test('late flow onState after view disposal cannot restore nodes or trigger a callback', async () => {
  const picker = deferred(), h = fixture({ readText: () => picker.promise })
  const pending = h.click(IMPORT)
  h.view.dispose()
  picker.resolve(source()); await pending; await settle()
  assert.equal(h.flow.snapshot().status, 'preview', 'disposing presentation does not secretly cancel its owner flow')
  assert.equal(h.view.element.children.length, 0)
  assert.equal(h.view.element.getAttribute('data-state'), 'disposed')
  assert.equal(h.calls.drafts.length, 0)
})

test('export filenames and omitted warnings are plain text, and an old receipt keeps its original revision label', async () => {
  const h = fixture()
  await h.click(MD)
  const state = h.flow.snapshot(), malicious = '<img src="file:///private/a" onerror="bad()">'
  h.view.update({ state: { ...state, fileName: malicious, omitted: [malicious, 'second omission'] }, actions: h.actions,
    exportTarget: { ...target(), profileId: 'prof-newly-visible', revision: 20 } })
  assert.match(h.node('transfer-export-target').textContent, /prof-newly-visible · 저장 버전 20/)
  assert.match(h.view.element.textContent, /이번 내보내기prof-visible · 버전 7/)
  assert.ok(h.node('transfer-omitted').textContent.includes(malicious))
  assert.ok(h.view.element.textContent.includes(malicious))
  assert.equal(walk(h.view.element).some(node => node.tagName === 'IMG'), false)
})

test('empty warning arrays still disclose the zero count, with no invented warnings or truncated names', async () => {
  const h = fixture({ readText: () => ({ filename: 'plain.md', text: '---\nname: A\n---\nRead everything.' }) })
  await h.click(IMPORT)
  assert.equal(h.node('import-unknown-fields').textContent, '전체 0개 · 이름 표시 0개')
  assert.equal(h.node('import-unmapped-tools').textContent, '없음')
  assert.equal(h.node('import-adjusted').textContent, '없음')
})
