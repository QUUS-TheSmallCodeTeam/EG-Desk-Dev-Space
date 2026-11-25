// L8 u6 (U19): the real-window failure of u5: the turn was accepted, then the Claude process was closed ("The Claude process ended before the turn finished (CLAUDE_BOUNDED_UNVERIFIED)") because the init
// check of a bounded Claude process found something in a REAL CLI's system/init. The replay init here has the real shape (EndConversation in the tools, skills / plugins / agents listed by name).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CLAUDE_BOUNDED_RELAXED_TOOLS, claudeBoundedInitDiagnosis, claudeBoundedInitViolation, claudeBoundedThreadOverrides } from './egdesk-claude-bounded.mjs'
import { REAL_INIT_LISTS, world } from './egdesk-claude-browser-world.fixture.mjs'

const here = path.dirname(new URL(import.meta.url).pathname)
const read = file => fs.readFileSync(path.join(here, file), 'utf8')
const egd = ['mcp__egdesk__egdesk_card_read', 'mcp__egdesk__egdesk_browser_observe']
const init = (over = {}) => ({ type: 'system', subtype: 'init', tools: egd, mcp_servers: [{ name: 'egdesk', status: 'connected' }], permissionMode: 'dontAsk', skills: [], plugins: [], agents: [], ...over })

test('the diagnosis names the kind and counts the entries, never a name; the violation keeps answering with the kind alone', () => {
  assert.equal(claudeBoundedInitDiagnosis(init()), null)
  assert.deepEqual(claudeBoundedInitDiagnosis(init({ tools: ['Bash', 'Read', ...egd] })), { kind: 'builtin-tools', count: 2 })
  assert.deepEqual(claudeBoundedInitDiagnosis(init({ tools: undefined })), { kind: 'builtin-tools', count: 0 })
  assert.deepEqual(claudeBoundedInitDiagnosis(init({ mcp_servers: [{ name: 'egdesk' }, { name: 'a' }, { name: 'b' }] })), { kind: 'external-mcp', count: 2 })
  assert.deepEqual(claudeBoundedInitDiagnosis(init({ permissionMode: 'default' })), { kind: 'permission-mode', count: 1 })
  assert.deepEqual(claudeBoundedInitDiagnosis(init({ ...REAL_INIT_LISTS })), { kind: 'extensions', count: 9 })
  assert.equal(claudeBoundedInitViolation(init({ ...REAL_INIT_LISTS })), 'extensions')
  assert.equal(claudeBoundedInitViolation(init()), null)
  for (const value of Object.values(claudeBoundedInitDiagnosis(init({ ...REAL_INIT_LISTS })))) assert.ok(typeof value === 'number' || /^[a-z-]+$/.test(value))
})

test('strict (the capability off) stays exactly as it was: EndConversation, ToolSearch and any list are violations', () => {
  assert.deepEqual(claudeBoundedInitDiagnosis(init({ tools: ['EndConversation', ...egd] })), { kind: 'builtin-tools', count: 1 })
  assert.deepEqual(claudeBoundedInitDiagnosis(init({ tools: ['ToolSearch', ...egd] })), { kind: 'builtin-tools', count: 1 })
  assert.deepEqual(claudeBoundedInitDiagnosis(init({ skills: ['x'] })), { kind: 'extensions', count: 1 })
  assert.deepEqual(claudeBoundedInitDiagnosis(init({ agents: ['general-purpose'] }), { relaxed: false }), { kind: 'extensions', count: 1 })
})

test('relaxed (the Claude browser capability live): only the two documented tools and the lists are let through; everything that could RUN stays a violation', () => {
  assert.deepEqual([...CLAUDE_BOUNDED_RELAXED_TOOLS], ['EndConversation', 'ToolSearch'])
  const relaxed = { relaxed: true }
  assert.equal(claudeBoundedInitDiagnosis(init({ tools: ['EndConversation', 'ToolSearch', ...egd], ...REAL_INIT_LISTS }), relaxed), null)
  for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'Skill', 'Agent', 'Task', 'Workflow', 'SendToProjectContext', 'mcp__other__x', 'endconversation']) {
    assert.deepEqual(claudeBoundedInitDiagnosis(init({ tools: ['EndConversation', tool, ...egd] }), relaxed), { kind: 'builtin-tools', count: 1 }, tool)
  }
  assert.deepEqual(claudeBoundedInitDiagnosis(init({ mcp_servers: [{ name: 'egdesk' }, { name: 'plugin:x' }], ...REAL_INIT_LISTS }), relaxed), { kind: 'external-mcp', count: 1 }, 'a plugin that brings an MCP server is still caught')
  assert.deepEqual(claudeBoundedInitDiagnosis(init({ permissionMode: 'acceptEdits', ...REAL_INIT_LISTS }), relaxed), { kind: 'permission-mode', count: 1 })
  assert.deepEqual(claudeBoundedThreadOverrides('browserBounded'), { egdeskBoundedPolicy: 'browserBounded' })
  assert.deepEqual(claudeBoundedThreadOverrides('browserBounded', { relaxed: true }), { egdeskBoundedPolicy: 'browserBounded', egdeskBoundedRelaxed: true })
})

test('BEFORE: a real-shaped init under the strict check ends the process and the run says why, in closed words and a count', async t => {
  const w = world(t, { pageTools: false, codexReady: true, init: 'real' })
  assert.equal(w.chat.claudeBrowserLive(), false)
  const sent = await w.browserSend('이 페이지 제목 알려줘'); assert.equal(sent.accepted, true)
  const run = await w.settled(sent)
  assert.equal(run.status, 'failed')
  assert.equal(run.error.code, 'TURN_FAILED', 'the run record keeps its code; the closed reason is in the message')
  assert.equal(run.error.message, 'The Claude process ended before the turn finished (CLAUDE_BOUNDED_UNVERIFIED:builtin-tools=1)')
})

test('AFTER: the same real-shaped init (EndConversation in the tools; skills, plugins and agents listed) with the capability live: the process is verified and the turn completes, bounded, with no tool but EG-Desk\'s', async t => {
  const w = world(t, { init: 'real' })
  assert.equal(w.chat.claudeBrowserLive(), true)
  const sent = await w.browserSend('이 페이지 제목 알려줘')
  const run = await w.settled(sent)
  assert.equal(run.status, 'completed', JSON.stringify(run.error))
  const [transport] = w.transports
  assert.deepEqual([transport.options.bounded, transport.options.tools, transport.options.permissionMode, transport.options.allowedTools], [true, [], 'dontAsk', ['mcp__egdesk']])
  // the second turn of the conversation reuses the same discipline
  const again = await w.browserSend('다시 읽어줘', { conversationId: sent.conversationId })
  assert.equal((await w.settled(again)).status, 'completed')
})

test('AFTER, what could run is still stopped under the capability: a real-shaped init that also lists a shell tool or a Skill tool ends the process (closed words)', async t => {
  for (const [extra, expected] of [[['Bash'], 'builtin-tools=1'], [['Skill', 'Agent'], 'builtin-tools=2']]) {
    const w = world(t, { init: 'real', extraTools: extra })
    const run = await w.settled(await w.browserSend('이 페이지 제목 알려줘'))
    assert.equal(run.status, 'failed'); assert.equal(run.error.message, `The Claude process ended before the turn finished (CLAUDE_BOUNDED_UNVERIFIED:${expected})`)
  }
})

test('BEFORE, lists only: a strict check finds the extensions (the kind the real window may have hit), counted', async t => {
  const w = world(t, { pageTools: false, codexReady: true, init: 'lists' })
  const run = await w.settled(await w.browserSend('이 페이지 제목 알려줘'))
  assert.equal(run.error.message, 'The Claude process ended before the turn finished (CLAUDE_BOUNDED_UNVERIFIED:extensions=9)')
})

test('the plumbing: the runtime hands the relaxed mark only with the capability, the adapter keeps it per process, a new process is spawned when it changes', () => {
  const runtime = read('codex-chat-runtime.mjs'), adapter = read('claude-engine-adapter.mjs')
  assert.equal((runtime.match(/claudeBoundedThreadOverrides\((policy|boundPolicy), \{ relaxed: this\.claudeBrowserLive\(\) \}\)/g) || []).length, 2)
  assert.ok(adapter.includes('spec.boundedRelaxed = p.egdeskBoundedRelaxed === true'))
  assert.ok(adapter.includes('relaxed: proc.boundedRelaxed === true'))
  assert.ok(adapter.includes('flags.boundedRelaxed !== (spec.boundedRelaxed === true)'))
  assert.ok(adapter.includes("proc.gateDetail = `${violation.kind}=${violation.count}`"))
})
