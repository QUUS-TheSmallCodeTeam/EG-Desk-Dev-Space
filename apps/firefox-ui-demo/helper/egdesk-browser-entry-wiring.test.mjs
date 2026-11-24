import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createWikiAdapter, openWikiWrites } from './egdesk-wiki-adapter.mjs'
import { createBrowserEntryConfig } from './egdesk-browser-entry-wiring.mjs'
import { outcomeCandidate, parseOutcomeText } from './egdesk-browser-task-memory.mjs'
import { prepareTurnMemory } from './egdesk-turn-memory.mjs'
import { mockJudge } from './egdesk-wiki-reconstruction.fixture.mjs'

// L8/C10: the hook and sink the bridge installs, against L7's adapter and persistent write path, including the MID-SESSION cases.
const ctx = { clientThreadId: 'dm-1' }
const GOAL = '거래처 포털에서 이번 달 세금계산서 내려받아줘'
const candidate = taskId => outcomeCandidate({ taskId, goal: GOAL, host: 'portal.example.test', now: Date.parse('2026-10-19T09:00:00Z'), outcome: { status: 'done' },
  trail: [{ op: 'open', label: '사업자 987-65-43210', from: '/invoices', to: '/biz/2' }, { op: 'open', label: '다운로드', from: '/biz/2', to: '/download/*' }],
  resolved: [{ asked: 'choice_needed', chose: '사업자 987-65-43210', at: '/invoices' }] })
const setup = flag => {
  const dir = mkdtempSync(path.join(tmpdir(), 'egdesk-c10w-')); chmodSync(dir, 0o700)
  const adapter = createWikiAdapter({ writes: openWikiWrites({ dataDir: dir }) })
  const log = [], judge = mockJudge(log)
  const config = createBrowserEntryConfig({ flag: () => flag, getAdapter: () => adapter, wiki: ({ context }) => adapter.snapshot({ context }) })
  return { dir, adapter, log, judge, config }
}
async function writeOutcome(x, taskId) {
  const memory = await x.config.memory({ body: { message: GOAL }, context: ctx, client: x.judge, askedAt: Date.parse('2026-10-19T09:00:00Z') })
  return x.config.outcomeSink(candidate(taskId), { memoryPages: memory.pages, memory })
}

test('W1 mode() is off unless the flag says advisory or on', () => {
  for (const [flag, expected] of [[undefined, 'off'], ['', 'off'], ['yes', 'off'], ['advisory', 'advisory'], ['on', 'on']]) assert.equal(setup(flag).config.mode(), expected)
  assert.equal(createBrowserEntryConfig({ flag: () => { throw new Error('x') }, getAdapter: () => null }).mode(), 'off')
})

test('W2 the outcome is written through the persistent path: agent_note body kept, scoped to the DM, never a message reference, never a status change', async () => {
  const x = setup('on')
  const result = await writeOutcome(x, 'bt_0123456789ab')
  assert.equal(result.status, 'stored')
  const stored = JSON.parse(readFileSync(path.join(x.dir, 'egdesk-wiki-writes.json'), 'utf8')).pages
  assert.equal(stored.length, 1)
  assert.deepEqual([stored[0].id, stored[0].provenance, stored[0].scope, stored[0].ref], ['browser-task/bt_0123456789ab', { kind: 'agent_note', by: 'browser_task' }, 'dm:dm-1', undefined])
  assert.deepEqual(parseOutcomeText(stored[0].body).resolved, [{ asked: 'choice_needed', chose: '사업자 987-65-43210', at: '/invoices' }])
  // a later snapshot (a new adapter over the same file) sees the page; another DM does not
  const again = createWikiAdapter({ writes: openWikiWrites({ dataDir: x.dir }) })
  assert.ok((await again.snapshot({ context: ctx })).pages.has('browser-task/bt_0123456789ab'))
  assert.equal((await again.snapshot({ context: { clientThreadId: 'dm-2' } })).pages.has('browser-task/bt_0123456789ab'), false)
})

test('W3 mid-session: the browser consumer still gets the prior record when the subjective model already holds it, and when triage says "no need"', async () => {
  const x = setup('on')
  await writeOutcome(x, 'bt_0123456789ab')
  const wiki = await x.adapter.snapshot({ context: ctx })
  const scope = x.adapter.scopeFor(ctx)
  const page = wiki.pages.get('browser-task/bt_0123456789ab')
  const crypto = await import('node:crypto')
  const heldReceipts = { usable: true, threadKey: 'native-1', pages: { [page.id]: { revision: page.revision, hash: crypto.createHash('sha256').update(page.body).digest('hex') } } }
  const MID = { kind: 'mid', reason: 'live_thread' }
  // 1. Contrast: the general mid-session fetch for the ANSWERING model skips what it holds, so a browser loop fed from it would miss the record.
  const midHeld = await prepareTurnMemory({ message: GOAL, wiki, client: x.judge, scope, position: MID, delivered: heldReceipts, threadKey: 'native-1' })
  assert.equal(midHeld.memory.picks.some(p => p.id === page.id), false, 'held by the subjective model, so not re-sent to it')
  // 2. Contrast: a wrong "no need" (with recall also decided "no" and the full list shown) skips the fetch entirely.
  const noNeed = { async decide(request) { const names = request.questions.map(q => q.name)
    if (names.includes('tn_need')) return { answers: { tn_need: { type: 'predicate', probability: 0.02 }, tn_recall: { type: 'predicate', probability: 0.02 }, tn_courtesy: { type: 'predicate', probability: 0.02 }, tn_record: { type: 'predicate', probability: 0.02 } }, usage: { inputTokens: 1 }, latencyMs: 1 }
    return x.judge.decide(request) } }
  const skipped = await prepareTurnMemory({ message: GOAL, wiki, client: noNeed, scope, position: MID, delivered: heldReceipts, threadKey: 'native-1', skipOnNeed: true })
  assert.equal(skipped.memory.status, 'skipped')
  // 3. The hook ignores both: it reconstructs for a consumer that holds nothing, whatever the turn position or receipts.
  const got = await x.config.memory({ body: { message: GOAL }, context: ctx, client: noNeed, position: MID, delivered: heldReceipts })
  assert.ok(got.pages.some(p => p.id === page.id), 'the browser task still gets the prior record')
  assert.match(got.packet, /사업자 987-65-43210/)
  assert.equal(got.scope.writeScope, 'dm:dm-1')
})

test('W4 no client or no wiki: memory() returns null and the sink reports unavailable (nothing written)', async () => {
  const x = setup('on')
  assert.equal(await x.config.memory({ body: { message: GOAL }, context: ctx, client: null }), null)
  assert.deepEqual(await x.config.outcomeSink(candidate('bt_0123456789ab'), { memoryPages: [], memory: null }), { status: 'unavailable' })
  assert.equal(x.adapter.snapshot && (await x.adapter.snapshot({ context: ctx })).pages.size, 0)
})

test('W5 a stuck outcome is written under its own page; secrets in a candidate never reach the file', async () => {
  const x = setup('on')
  const memory = await x.config.memory({ body: { message: GOAL }, context: ctx, client: x.judge })
  const stuck = outcomeCandidate({ taskId: 'bt_aaaaaaaaaaaa', goal: GOAL, host: 'portal.example.test', outcome: { status: 'stuck', code: 'two_factor_required' },
    trail: [{ op: 'open', label: '로그인', from: '/login?session=SECRETSESSION', to: '/otp?token=SECRETTOKEN#frag' }], resolved: [], secret: 'SECRETVALUE' })
  const result = await x.config.outcomeSink(stuck, { memoryPages: memory.pages, memory })
  assert.equal(result.status, 'stored'); assert.match(result.pageId, /-stuck$/)
  assert.doesNotMatch(readFileSync(path.join(x.dir, 'egdesk-wiki-writes.json'), 'utf8'), /SECRET|frag/)
})

test('W6 production wiring: the bridge installs the config from the developer flag only, shares the lazy adapter, and sets no mode itself', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.match(source, /const browserEntryConfig = createBrowserEntryConfig\(\{ flag: \(\) => process\.env\.EGDESK_BROWSER_ENTRY, getAdapter: \(\) => turnMemoryConfig\.getAdapter\(\),/)
  assert.match(source.slice(source.indexOf('decisionContext: {')), /browserEntry: browserEntryConfig,/)
  assert.doesNotMatch(source, /EGDESK_BROWSER_ENTRY\s*=\s*['"]|process\.env\.EGDESK_BROWSER_ENTRY\s*=/, 'nothing in the bridge turns it on')
  assert.equal((source.match(/createWikiAdapter\(/g) || []).length, 1, 'one adapter, one write store')
})
