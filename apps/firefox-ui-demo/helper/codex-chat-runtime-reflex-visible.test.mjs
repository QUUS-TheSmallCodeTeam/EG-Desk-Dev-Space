import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { BROWSER_TOOL_SPECS, BROWSER_INTERACTION_TOOL_NAMES } from './egdesk-browser-tool-runtime.mjs'
import { BROWSER_REFLEX_TOOL_NAME, BROWSER_REFLEX_TOOL_SPEC } from './egdesk-browser-reflex.mjs'
import { verifiedManifestOwners } from './codex-native-tool-manifest.mjs'

function harness() {
  const state = { on: false }
  const provider = { providerId: 'egdesk-browser', specs: () => state.on ? [...BROWSER_TOOL_SPECS, BROWSER_REFLEX_TOOL_SPEC] : BROWSER_TOOL_SPECS }
  const chat = new CodexChatRuntime({ request: async () => ({}), respond: () => {}, toolProviders: [provider] })
  return { state, chat }
}
const names = catalog => catalog.specs.map(spec => spec.name)
const cases = [[null, {}], ['readOnlyQa', {}], ['browserBounded', {}], ['browserBounded', { browserInteraction: true }], ['fixtureBrowserQa', {}],
  ['browserBounded', { browserInteraction: true, toolCeiling: { browser: 'observe' } }], [null, { forManifest: true }]]

test('mode off: no catalog or policy offers the reflex', () => {
  const { chat } = harness()
  for (const [policy, options] of cases) {
    const catalog = chat.collectToolSpecs(policy, options)
    assert.equal(names(catalog).includes(BROWSER_REFLEX_TOOL_NAME), false)
  }
  assert.equal(BROWSER_INTERACTION_TOOL_NAMES.includes(BROWSER_REFLEX_TOOL_NAME), false, 'shared constant unchanged')
})

test('mode on: reflex is visible exactly where interaction tools are, and recorded-off manifests still verify', () => {
  const { state, chat } = harness()
  const off = cases.map(([policy, options]) => JSON.stringify(chat.collectToolSpecs(policy, options).manifest))
  const recordedOff = chat.collectToolSpecs(null, { forManifest: true }).manifest
  state.on = true
  for (const [index, [policy, options]] of cases.entries()) {
    const catalog = chat.collectToolSpecs(policy, options)
    const interaction = names(catalog).includes('egdesk_browser_navigate')
    assert.equal(names(catalog).includes(BROWSER_REFLEX_TOOL_NAME), interaction, `${policy} ${JSON.stringify(options)}`)
    const withoutReflex = JSON.stringify(catalog.manifest.filter(entry => entry.key !== `::${BROWSER_REFLEX_TOOL_NAME}` && !entry.key.endsWith(BROWSER_REFLEX_TOOL_NAME)))
    assert.equal(withoutReflex, off[index], 'other entries unchanged')
  }
  assert.ok(names(chat.collectToolSpecs('browserBounded', { browserInteraction: true })).includes(BROWSER_REFLEX_TOOL_NAME))
  assert.equal(names(chat.collectToolSpecs('readOnlyQa')).includes(BROWSER_REFLEX_TOOL_NAME), false)
  assert.equal(names(chat.collectToolSpecs('fixtureBrowserQa')).includes(BROWSER_REFLEX_TOOL_NAME), false)
  const current = chat.collectToolSpecs(null, { forManifest: true })
  const verified = verifiedManifestOwners(recordedOff, current.manifest, current.owners)
  assert.equal(verified.status, 'verified')
  assert.equal([...verified.owners.keys()].some(key => key.endsWith(BROWSER_REFLEX_TOOL_NAME)), false, 'an old thread is not granted the new tool')
})
