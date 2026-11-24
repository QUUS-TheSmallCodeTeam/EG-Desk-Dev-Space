// The Decision model follows the SAME data-sharing permissions as the other models of the run (no separate consent).
// For every egress kind: allowed -> the request is sent and carries the data; disallowed -> 0 requests carry it and the feature
// falls back as before. Real decision client with a mock fetch ("model") so the request count is what actually left.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { createEgressGate, EGRESS_KINDS, EGRESS_SITES, modelDataPermissions } from './egdesk-decision-egress.mjs'
import { assessCommand } from './egdesk-terminal-command-gate.mjs'
import { judgeTerminalState } from './egdesk-terminal-judge.mjs'
import { checkDraft } from './egdesk-draft-check.mjs'
import { createOutcomeToOntology } from './egdesk-browser-task-memory.mjs'
import { decideBrowserEntry } from './egdesk-browser-task.mjs'
import { reconstructMemory } from './egdesk-wiki-reconstruction.mjs'
import { buildWiki } from './egdesk-wiki-reconstruction.mjs'
import { SYNTHETIC_PAGES, mockJudge } from './egdesk-wiki-reconstruction.fixture.mjs'

const KEY = 'egd-synthetic-not-a-key-0005'
const CEILING_NONE = { browser: 'none', files: 'read', terminal: 'none', network: 'off', mcp: 'none' }
const OPEN = { browser: 'interact', files: 'write', terminal: 'ask', network: 'on', mcp: 'all' }

function modelAnswer(q) {
  if (q.type === 'choice') { const top = q.choices[0].value; return { name: q.name, type: 'choice', choice: top, confidence: 0.95, probabilities: q.choices.map((c, i) => ({ value: c.value, probability: i ? 0.05 / Math.max(1, q.choices.length - 1) : 0.95 })) } }
  if (q.type === 'score') return { name: q.name, type: 'score', score: 0.5, confidence: 0.95, probabilities: q.levels.map((_, i) => ({ value: String(i), probability: i === 0 ? 0.9 : 0.025 })) }
  return { name: q.name, type: 'predicate', probability: 0.2 }
}
function provider() {
  const requests = []
  const client = createDecisionClient({ getApiKey: () => KEY, recipientForKey: () => 'a'.repeat(64),
    fetchImpl: async (url, init) => { const body = JSON.parse(init.body); requests.push(init.body); return Response.json({ answers: body.questions.map(modelAnswer), usage: { input_tokens: 10 } }) } })
  return { client, requests, carrying: needle => requests.filter(body => body.includes(needle)).length }
}
const gate = options => createEgressGate(modelDataPermissions({ runActive: true, ...options }))

test('permissions come only from the structures that govern the models; unknown kinds and missing classes are refused', () => {
  assert.equal(modelDataPermissions({ toolCeiling: CEILING_NONE, browserGranted: true }).terminal, false)
  assert.equal(modelDataPermissions({ toolCeiling: CEILING_NONE, browserGranted: true }).browser, false)
  assert.equal(modelDataPermissions({ toolCeiling: OPEN, browserGranted: true }).browser, true)
  assert.equal(modelDataPermissions({ toolCeiling: OPEN, browserGranted: false }).browser, false, 'no Card grant, no page text')
  assert.equal(modelDataPermissions({ toolCeiling: null }).terminal, true, 'no ceiling: the models may see terminal output, so may Decisions')
  const closed = createEgressGate({})
  for (const kind of Object.keys(EGRESS_KINDS)) assert.equal(closed.allows(kind), false, `${kind} is closed unless a model permission opens it`)
  assert.equal(closed.allows('anything_else'), false)
  assert.equal(createEgressGate(null).allows('terminal_output'), false)
  // nothing here can be opened for Decisions alone: the only inputs are model-permission structures
  assert.deepEqual(Object.keys(modelDataPermissions({})).sort(), ['browser', 'canvas', 'memory', 'run', 'speech', 'terminal', 'topic'])
})

test('guarded client: refuses before any request, with the closed code every feature already falls back on', async () => {
  const p = provider()
  const refused = gate({ toolCeiling: CEILING_NONE, browserGranted: true }).guardClient(p.client, ['page_text'])
  await assert.rejects(refused.decide({ input: 'x', questions: [{ type: 'predicate', name: 'q', instructions: 'x' }] }), e => e.code === 'evidence_unavailable')
  assert.equal(p.requests.length, 0)
  const allowed = gate({ toolCeiling: OPEN, browserGranted: true }).guardClient(p.client, ['page_text'])
  await allowed.decide({ input: 'x', questions: [{ type: 'predicate', name: 'q', instructions: 'x' }] })
  assert.equal(p.requests.length, 1)
})

const TAIL = 'Build failed in module zeta-synthetic-marker\n# fail 1\n'
test('terminal_output: allowed -> sent; tool ceiling terminal none -> not sent, falls back on the exit code', async () => {
  const p = provider()
  const sent = await judgeTerminalState({ tail: TAIL, alive: false, exitCode: 1, mode: 'on', client: p.client, egress: gate({ toolCeiling: OPEN }) })
  assert.equal(p.carrying('zeta-synthetic-marker'), 1); assert.equal(sent.requests, 1)
  const q = provider()
  const refused = await judgeTerminalState({ tail: TAIL, alive: false, exitCode: 1, mode: 'on', client: q.client, egress: gate({ toolCeiling: CEILING_NONE }) })
  assert.equal(q.requests.length, 0); assert.equal(refused.source, 'fallback'); assert.equal(refused.state, 'completed_error')
})

test('terminal_command: allowed -> scored; terminal none -> floor only, not sent', async () => {
  const inspect = () => ({ exists: true, kind: 'dir', trackedFiles: 0, ignored: true })
  const p = provider()
  const sent = await assessCommand({ command: 'rm -rf node_modules', cwd: '/work/app', intent: 'zeta-synthetic-intent', mode: 'on', client: p.client, inspect, egress: gate({ toolCeiling: OPEN }) })
  assert.equal(p.carrying('zeta-synthetic-intent'), 1); assert.equal(sent.source, 'decision')
  const q = provider()
  const refused = await assessCommand({ command: 'rm -rf node_modules', cwd: '/work/app', intent: 'zeta-synthetic-intent', mode: 'on', client: q.client, inspect, egress: gate({ toolCeiling: CEILING_NONE }) })
  assert.equal(q.requests.length, 0); assert.equal(refused.source, 'fallback'); assert.equal(refused.approval, false)
})

test('draft_text: allowed -> the sentences and permitted catalog items are sent; no run -> nothing; evidence is filtered by kind', async () => {
  const draft = 'The zeta-synthetic-draft shipment left on 3 November.'
  const evidence = [{ id: 'a', kind: 'source', text: 'Shipment ledger alpha-synthetic-source: left on 3 November.' },
    { id: 'b', kind: 'terminal', text: 'Console output beta-synthetic-terminal: left on 3 November.' }, { id: 'c', kind: 'tool', opaque: true }]
  const p = provider()
  const sent = await checkDraft({ draft, evidence, mode: 'advisory', client: p.client, egress: gate({ toolCeiling: CEILING_NONE }) })
  assert.ok(p.carrying('zeta-synthetic-draft') >= 1, 'the sentences were sent')
  assert.equal(p.carrying('alpha-synthetic-source') >= 1, true, 'a source item the model also received is sent')
  assert.equal(p.carrying('beta-synthetic-terminal'), 0, 'terminal output is not sent when the models may not receive it')
  assert.notEqual(sent.outcome, undefined)
  const q = provider()
  const refused = await checkDraft({ draft, evidence, mode: 'advisory', client: q.client, egress: createEgressGate(modelDataPermissions({ runActive: false })) })
  assert.equal(q.requests.length, 0); assert.equal(refused.outcome, 'unchecked'); assert.equal(refused.text, draft)
})

test('page_text: allowed -> the Card list is sent; ceiling browser none or no Card grant -> 0 requests and the usual fallback', async () => {
  const cards = [{ cardId: 'card-1', host: 'zeta-synthetic-host.example' }]
  const p = provider()
  await decideBrowserEntry({ message: 'open the portal', cards, client: gate({ toolCeiling: OPEN, browserGranted: true }).guardClient(p.client, ['page_text']) })
  assert.equal(p.carrying('zeta-synthetic-host'), 1)
  for (const options of [{ toolCeiling: CEILING_NONE, browserGranted: true }, { toolCeiling: OPEN, browserGranted: false }]) {
    const q = provider()
    await assert.rejects(decideBrowserEntry({ message: 'open the portal', cards, client: gate(options).guardClient(q.client, ['page_text']) }), e => e.code === 'evidence_unavailable')
    assert.equal(q.requests.length, 0)
  }
})

test('browser_task_record + memory_page: allowed -> the record is judged; no Card grant -> not sent, status unavailable', async () => {
  const wiki = buildWiki(SYNTHETIC_PAGES), log = []
  const writer = { apply: () => ({ status: 'written' }) }
  const candidate = { text: '포털에서 세금계산서를 내려받았다. zeta-synthetic-record', taskId: 't1', outcome: { status: 'done' } }
  const memoryPages = [...wiki.pages.values()].filter(page => !page.scope).slice(0, 2)
  const run = options => createOutcomeToOntology({ wiki, client: mockJudge(log), writer, scope: { allowedScopes: [] }, enabled: true, egress: gate({ memoryScope: {}, ...options }) })
    .write(candidate, { memoryPages })
  const before = log.length
  const refused = await run({ toolCeiling: OPEN, browserGranted: false })
  assert.deepEqual(refused, { status: 'unavailable', reason: 'egress' }); assert.equal(log.length, before, 'no request')
  const allowed = await run({ toolCeiling: OPEN, browserGranted: true })
  assert.notEqual(allowed.reason, 'egress'); assert.ok(log.length > before, 'the record was judged')
})

test('memory_page: a page outside the scope is never in a request; no memory permission -> no request', async () => {
  const wiki = buildWiki(SYNTHETIC_PAGES), log = []
  const base = { allowedScopes: ['dm:this-room'] }
  const allowedGate = gate({ memoryScope: base })
  await reconstructMemory({ message: 'A사 견적 어떻게 됐지?', wiki, client: allowedGate.guardClient(mockJudge(log), ['memory_page']), scope: allowedGate.memoryScope(base) })
  assert.ok(log.length >= 1)
  assert.equal(log.filter(entry => entry.input.includes('내부 원가는 단가의 71%')).length, 0, 'a page scoped to another room is not sent')
  const closed = gate({}) // no memory permission
  const logs = []
  const result = await reconstructMemory({ message: 'A사 견적 어떻게 됐지?', wiki, client: closed.guardClient(mockJudge(logs), ['memory_page']), scope: closed.memoryScope(base) })
  assert.equal(logs.length, 0); assert.equal(result.status, 'fallback')
})

test('speech_history / topic_history follow the per-DM consents that already govern the answering model', () => {
  assert.equal(gate({}).allows('speech_history'), false); assert.equal(gate({ speechConsent: true }).allows('speech_history'), true)
  assert.equal(gate({ speechConsent: true }).allows('topic_history'), false); assert.equal(gate({ topicConsent: true }).allows('topic_history'), true)
})

test('registry: every file that sends a Decision request is listed with the kinds it may declare (a new call site must be registered)', () => {
  const dir = path.dirname(new URL(import.meta.url).pathname)
  const sending = fs.readdirSync(dir).filter(f => f.endsWith('.mjs') && !/\.test\.|\.fixture\.|egdesk-decision-client\.mjs|egdesk-decision-egress\.mjs/.test(f))
    .filter(f => /\.decide\(|\bdecide\.call\(/.test(fs.readFileSync(path.join(dir, f), 'utf8')))
  const listed = Object.keys(EGRESS_SITES)
  const unregistered = sending.filter(f => !listed.includes(f))
  // chat chooser and Board arrangement are user-confirmed single requests of the typed/selected content; they live in the runtime/board files above.
  assert.deepEqual(unregistered, [], `register these Decision call sites in EGRESS_SITES: ${unregistered.join(', ')}`)
  for (const f of listed) assert.ok(fs.existsSync(path.join(dir, f)), `${f} exists`)
})
