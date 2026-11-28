// L8 u1: the bridge's wiring of the page tools: off by default, one provider with the flag, the Browser provider read lazily, the approval ledger passed through.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PAGE_TOOLS_FLAG, createPageToolsWiring } from './egdesk-page-tools-wiring.mjs'
import { PAGE_TOOLS_PROVIDER_ID, PAGE_TOOL_NAMES } from './egdesk-page-tools.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

test('without the flag nothing is wired (default off); only the exact value "on" turns it on', () => {
  assert.equal(PAGE_TOOLS_FLAG, 'EGDESK_PAGE_TOOLS')
  for (const value of [undefined, '', '1', 'true', 'ON', 'shadow']) assert.equal(createPageToolsWiring({ env: { [PAGE_TOOLS_FLAG]: value }, getChat: () => null }), null, String(value))
  assert.throws(() => createPageToolsWiring({ env: { [PAGE_TOOLS_FLAG]: 'on' } }), TypeError)
})

test('with the flag: one provider that offers the four tools; the Browser provider is read from the runtime when a call comes, the ledger is the one it was given', async () => {
  const seen = []
  const chat = { browserToolProvider: () => ({ dispatch: async (run, event) => { seen.push(event.tool); return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ snapshot: { url: 'https://a.example.test/x', text: ['hello'], interactiveElements: [], revision: 1 }, observationId: 'o1' }) }] } } }) }
  const wiring = createPageToolsWiring({ env: { [PAGE_TOOLS_FLAG]: 'on' }, getChat: () => chat, ledger: { check: async () => ({ decision: 'allow' }) } })
  assert.equal(wiring.toolProviders.length, 1); assert.equal(wiring.toolProviders[0].providerId, PAGE_TOOLS_PROVIDER_ID)
  assert.deepEqual(wiring.toolProviders[0].specs().map(s => s.name), Object.values(PAGE_TOOL_NAMES).sort((a, b) => [PAGE_TOOL_NAMES.read, PAGE_TOOL_NAMES.press, PAGE_TOOL_NAMES.type, PAGE_TOOL_NAMES.open].indexOf(a) - [PAGE_TOOL_NAMES.read, PAGE_TOOL_NAMES.press, PAGE_TOOL_NAMES.type, PAGE_TOOL_NAMES.open].indexOf(b)))
  const out = await wiring.toolProviders[0].dispatch({ runId: 'r', answerId: 'r', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }, { tool: PAGE_TOOL_NAMES.read, callId: 'w1', arguments: {} })
  assert.equal(JSON.parse(out.contentItems[0].text).lines[0], 'hello'); assert.deepEqual(seen, ['egdesk_browser_observe'])
  const noProvider = createPageToolsWiring({ env: { [PAGE_TOOLS_FLAG]: 'on' }, getChat: () => ({}) })
  const failed = await noProvider.toolProviders[0].dispatch({ runId: 'r', answerId: 'r', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }, { tool: PAGE_TOOL_NAMES.read, callId: 'w2', arguments: {} })
  assert.ok(JSON.parse(failed.contentItems[0].text).error || JSON.parse(failed.contentItems[0].text).status === 'refused', 'no Browser provider: a closed refusal, not a crash')
})

test('the bridge passes the provider only through the wiring: the registration is one extra concat, the ledger comes from the own tools (when on), and the flag is not read in the bridge', () => {
  const bridge = fs.readFileSync(path.join(here, 'codex-bridge-server.mjs'), 'utf8')
  assert.ok(bridge.includes("import { createPageToolsWiring } from './egdesk-page-tools-wiring.mjs'"))
  assert.ok(bridge.includes('createPageToolsWiring({ env: process.env, getChat: () => chat, ledger: ownToolsWiring?.ledger ?? null, procedures })'), 'round g: the procedure service getter is the one added argument')
  assert.ok(bridge.includes('toolProviders: [browserProvider, planProvider, annotationProvider].concat(ownToolsWiring ? ownToolsWiring.toolProviders : []),'), 'the existing provider list is untouched')
  assert.ok(bridge.includes('for (const provider of pageToolsWiring ? pageToolsWiring.toolProviders : []) chat.registerToolProvider(provider)'))
  assert.ok(!bridge.includes('EGDESK_PAGE_TOOLS'))
})
