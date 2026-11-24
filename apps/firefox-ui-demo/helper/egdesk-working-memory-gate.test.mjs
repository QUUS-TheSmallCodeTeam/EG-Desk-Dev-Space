import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync, readdirSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEgressGate, modelDataPermissions } from './egdesk-decision-egress.mjs'
import { normalizeEntry } from './egdesk-decision-calibration-log.mjs'
import { estimateTokens } from './egdesk-smart-read.mjs'
import { WM_LIMITS, anchorLines, applyActions, buildGateRequest, classifyContextBlocks, collapseContextBlocks, createSpillStore, enumerateBlockOptions, enumerateRoleOptions,
  gateToolOutput, gateToolResponse, goalTerms, normalizeOutput, omittedLine, ruleAction, splitBlocks } from './egdesk-working-memory-gate.mjs'
import { articleDump, buildLog, grepOutput, headingPolicy, mockDecisions, pageDump, sensiblePolicy, shortResult } from './egdesk-working-memory-gate.fixture.mjs'

const allow = (extra = {}) => createEgressGate(modelDataPermissions({ browserGranted: true, runActive: true, topicConsent: true, ...extra }))
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'egdesk-wm-'))
const recorder = () => { const entries = []; return { entries, record: entry => { entries.push(entry); return 'id' } } }
const pointer = text => [...text.matchAll(/Re-read: egdesk_read_source (\{.*?\})\]/g)].map(m => JSON.parse(m[1]))

test('splitBlocks covers every line exactly once and never exceeds the block budget', () => {
  for (const fixture of [buildLog(), grepOutput(), shortResult()]) {
    const lines = normalizeOutput(fixture.text).split('\n')
    const blocks = splitBlocks(fixture.text, { kind: fixture.kind })
    assert.ok(blocks.length >= 1 && blocks.length <= WM_LIMITS.maxBlocks, `${fixture.kind}: ${blocks.length} blocks`)
    assert.equal(blocks[0].startLine, 1); assert.equal(blocks.at(-1).endLine, lines.length)
    blocks.forEach((block, i) => { if (i) assert.equal(block.startLine, blocks[i - 1].endLine + 1); assert.equal(block.lineCount, block.endLine - block.startLine + 1) })
  }
  assert.equal(normalizeOutput('a\r\nb\rc\u001b[31m!\u001b[0m'), 'a\nb\nc!', 'ANSI and carriage returns are normalised before line numbers are assigned')
})

test('anchors: header, summary lines, final edited paths, goal terms and real error lines; "0 errors" is not an error; search hits are not errors', () => {
  const log = buildLog(), lines = log.text.split('\n')
  const anchors = anchorLines(lines, { kind: log.kind, paths: log.paths, goal: log.goal })
  for (const must of log.mustKeep) assert.ok(anchors.has(lines.indexOf(must)), must)
  assert.ok(anchors.has(0), 'the first line (the command) stays')
  const plain = ['$ run', ...Array.from({ length: 30 }, (_, i) => `note ${'abcdefghij'[i % 10].repeat(i + 3)}`), '0 errors, failed: 0', ...Array.from({ length: 30 }, (_, i) => `more ${'klmnopqrst'[i % 10].repeat(i + 3)}`), 'a', 'b', 'c']
  assert.equal(anchorLines(plain, { kind: 'terminal' }).has(31), false, 'a zero count is not an error line')
  assert.ok(anchors.size < 30, `only a handful of the 300 lines are anchors (${anchors.size})`)
  const grep = grepOutput(), g = grep.text.split('\n')
  const hits = anchorLines(g, { kind: 'search', goal: grep.goal })
  for (const must of grep.mustKeep) assert.ok(hits.has(g.indexOf(must)))
  assert.ok(hits.size <= 2 + WM_LIMITS.headKeep + WM_LIMITS.tailKeep, 'in search output only goal terms, rare-shaped lines and the edges are anchors')
  // Outliers of a repetitive output are anchors by shape alone, with no goal and no error word.
  const noisy = [...Array.from({ length: 80 }, (_, i) => `GET /health 200 ${i} ms`), 'disk quota reached on volume data7', ...Array.from({ length: 80 }, (_, i) => `GET /health 200 ${i + 80} ms`)]
  assert.ok(anchorLines(noisy, { kind: 'page' }).has(80), 'the one line that does not repeat is kept')
  const prose = Array.from({ length: 120 }, (_, i) => `sentence ${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${'zyxwvutsrq'[i % 10]} unique-${'q'.repeat(i % 7)}${i % 2 ? 'x' : 'yy'}${'k'.repeat(i % 11)}`)
  assert.ok(anchorLines(prose, { kind: 'page' }).size <= WM_LIMITS.headKeep + WM_LIMITS.tailKeep, 'non-repetitive text gets no outlier anchors')
  assert.deepEqual(goalTerms('`addTax` 고쳐 줘: src/checkout/payment.ts 의 applyRegionalTax 와 tax_rate'), ['addTax', 'src/checkout/payment.ts', 'applyRegionalTax', 'tax_rate'])
})

test('runtime options: a small or mostly-anchor block can only be injected; spill is offered only when a store exists', () => {
  const log = buildLog()
  const without = enumerateBlockOptions(log.text, { kind: log.kind, paths: log.paths, goal: log.goal, canSpill: false })
  assert.ok(without.blocks.every(b => !b.options.includes('spill_scratch')))
  const withStore = enumerateBlockOptions(log.text, { kind: log.kind, paths: log.paths, goal: log.goal, canSpill: true })
  assert.ok(withStore.blocks.some(b => b.options.length === 3) && withStore.blocks.some(b => b.options.length === 1))
  for (const b of withStore.blocks) if (b.lineCount <= WM_LIMITS.smallBlockLines) assert.deepEqual(b.options, ['inject_full'])
  assert.equal(ruleAction({ options: ['inject_full'], repeatRatio: 1, anchorCount: 0 }), 'inject_full')
  assert.equal(ruleAction({ options: ['inject_full', 'collapse_template', 'spill_scratch'], repeatRatio: 0.9, anchorCount: 0 }, 'build'), 'spill_scratch')
  assert.equal(ruleAction({ options: ['inject_full', 'collapse_template'], repeatRatio: 0.9, anchorCount: 3 }, 'build'), 'collapse_template', 'progress lines collapse when there is no store')
  assert.equal(ruleAction({ options: ['inject_full', 'collapse_template'], repeatRatio: 0.9, anchorCount: 0 }, 'search'), 'inject_full', 'search hits are content: never dropped without a store')
  assert.equal(ruleAction({ options: ['inject_full', 'collapse_template', 'spill_scratch'], repeatRatio: 0.1, anchorCount: 0 }, 'page'), 'inject_full', 'a rule cannot tell whether prose matters')
})

test('templates are fixed strings built from runtime numbers only', () => {
  assert.equal(omittedLine({ action: 'collapse_template', count: 320, startLine: 5, endLine: 324, label: 'build log', exitCode: 0 }), '[System: 320 lines of build log omitted (lines 5-324). Exit code: 0.]')
  assert.equal(omittedLine({ action: 'spill_scratch', count: 3, startLine: 2, endLine: 4, label: 'search results', spillId: '11111111-1111-4111-8111-111111111111' }),
    '[System: 3 lines of search results spilled (lines 2-4). Re-read: egdesk_read_source {"snapshotId":"11111111-1111-4111-8111-111111111111","intent":"re-read spilled tool output","range":{"startLine":2,"endLine":4}}]')
  const lines = ['a', 'b', 'KEEP', 'd', 'e']
  const text = applyActions({ lines, anchors: new Set([2]), blocks: [{ id: 'b1', startLine: 1, endLine: 5 }], actions: { b1: 'collapse_template' }, kind: 'terminal' })
  assert.equal(text, '[System: 2 lines of command output omitted (lines 1-2).]\nKEEP\n[System: 2 lines of command output omitted (lines 4-5).]', 'an anchor inside a collapsed block stays verbatim')
  assert.equal(applyActions({ lines, anchors: new Set(), blocks: [{ id: 'b1', startLine: 1, endLine: 5 }], actions: { b1: 'spill_scratch' }, kind: 'terminal', spillId: null }), lines.join('\n'),
    'a spill without a stored file injects the block; nothing is silently dropped')
})

test('off = unchanged and zero requests; a short result is never touched in any mode', async () => {
  const log = buildLog(), mock = mockDecisions(sensiblePolicy)
  const off = await gateToolOutput({ ...log, mode: 'off', enabled: true, client: mock.client, egress: allow() })
  assert.deepEqual([off.text === log.text, off.touched, off.reason, off.requests], [true, false, 'mode_off', 0])
  const short = shortResult()
  for (const mode of ['advisory', 'on']) {
    const result = await gateToolOutput({ ...short, mode, enabled: true, rules: true, client: mock.client, egress: allow(), spill: createSpillStore({ dir: tmp() }) })
    assert.deepEqual([result.text === short.text, result.touched, result.reason, result.requests], [true, false, 'below_threshold', 0])
  }
  assert.equal(mock.calls.length, 0)
})

test('advisory records what it WOULD do and changes nothing; on without the flag behaves the same', async () => {
  const log = buildLog()
  for (const [mode, reason] of [['advisory', 'advisory'], ['on', 'flag_off']]) {
    const mock = mockDecisions(sensiblePolicy), calibration = recorder(), dir = tmp()
    const result = await gateToolOutput({ ...log, mode, client: mock.client, egress: allow(), spill: createSpillStore({ dir }), calibration })
    assert.equal(result.text, log.text); assert.equal(result.touched, false); assert.equal(result.reason, reason); assert.equal(result.requests, 1)
    assert.ok(result.shadow.tokensAfter < result.tokensBefore * 0.3, 'the shadow plan shows the saving it would have made')
    assert.ok(result.shadow.plan.some(row => row.action !== 'inject_full' && row.by === 'decision'))
    assert.deepEqual(readdirSync(dir), [], 'nothing is written to the scratch directory when nothing is applied')
    assert.equal(calibration.entries.length, 1)
    const stored = normalizeEntry(calibration.entries[0])
    assert.equal(stored.feature, 'working_memory'); assert.equal(stored.mode, mode)
    assert.ok(stored.judgments.length >= 1 && stored.judgments.every(j => j.q === 'wm_block' && j.would === 'act' && ['collapse_template', 'spill_scratch', 'inject_full'].includes(j.value) && j.options >= 2))
    assert.equal(JSON.stringify(stored).includes('payment'), false, 'the calibration record carries no output text')
  }
})

test('on + flag: 300-line build log keeps the one real error, the edited path and the summary verbatim; spilled lines can be read back exactly', async () => {
  // A judge that prefers to keep everything reachable: spill instead of collapse.
  const log = buildLog(), mock = mockDecisions((block, values) => (block.anchor_lines > 0 && block.lines <= 12 ? 'inject_full' : values.includes('spill_scratch') ? 'spill_scratch' : 'collapse_template')), dir = tmp(), spill = createSpillStore({ dir })
  const result = await gateToolOutput({ ...log, mode: 'on', enabled: true, client: mock.client, egress: allow(), spill })
  assert.equal(result.touched, true); assert.equal(result.source, 'decision'); assert.equal(result.requests, 1)
  // The same log with a judge that calls progress lines noise: collapsed, nothing stored, no pointer, anchors still there.
  const collapseDir = tmp(), collapsed = await gateToolOutput({ ...log, mode: 'on', enabled: true, client: mockDecisions(sensiblePolicy).client, egress: allow(), spill: createSpillStore({ dir: collapseDir }) })
  assert.deepEqual([collapsed.touched, collapsed.text.includes('Re-read:'), readdirSync(collapseDir).length, collapsed.spillId], [true, false, 0, undefined])
  for (const must of log.mustKeep) assert.ok(collapsed.text.split('\n').includes(must), must)
  for (const must of log.mustKeep) assert.ok(result.text.split('\n').includes(must), must)
  assert.ok(result.tokensAfter < result.tokensBefore * 0.25, `${result.tokensBefore} → ${result.tokensAfter} estimated tokens`)
  assert.match(result.text, /\[System: \d+ lines of build log (?:omitted|spilled) \(lines \d+-\d+\)\. Exit code: 2\./)
  const original = normalizeOutput(log.text).split('\n')
  const pointers = pointer(result.text)
  assert.ok(pointers.length >= 1)
  for (const p of pointers) {
    assert.equal(p.snapshotId, result.spillId)
    const read = spill.read(p.snapshotId, p.range)
    assert.equal(read.text, original.slice(p.range.startLine - 1, p.range.endLine).join('\n'), 'the pointer range returns exactly the lines it replaced')
    assert.equal(read.range.totalLines, original.length)
  }
  // Every line is either still in the context or covered by a template line.
  const covered = new Set()
  for (const m of result.text.matchAll(/\(lines (\d+)-(\d+)\)/g)) for (let n = Number(m[1]); n <= Number(m[2]); n++) covered.add(n)
  const kept = new Set(result.text.split('\n'))
  original.forEach((line, i) => assert.ok(covered.has(i + 1) || kept.has(line), `line ${i + 1} is accounted for`))
  // The request: one choice per open block, option meanings sent once, previews bounded, no full log.
  const request = mock.calls[0]
  assert.ok(request.questions.length <= WM_LIMITS.maxBlocks && request.questions.every(q => q.type === 'choice' && q.choices.every(c => !c.description)))
  const wire = JSON.stringify({ input: request.input, questions: request.questions })
  assert.ok(wire.length < log.text.length / 2, `request ${wire.length} B vs output ${log.text.length} B`)
  assert.equal(request.timeoutMs, 1500)
})

test('2,000-line grep: the two goal hits stay; the rest is one pointer away', async () => {
  const grep = grepOutput(), mock = mockDecisions(sensiblePolicy), spill = createSpillStore({ dir: tmp() })
  const result = await gateToolOutput({ ...grep, mode: 'on', enabled: true, client: mock.client, egress: allow(), spill })
  assert.equal(result.touched, true)
  for (const must of grep.mustKeep) assert.ok(result.text.split('\n').includes(must))
  assert.ok(result.tokensAfter < result.tokensBefore * 0.1)
  const all = pointer(result.text), original = grep.text.split('\n')
  assert.ok(all.length >= 4, 'a long spilled run is cut into ranges one read can serve')
  for (const each of all) {
    assert.ok(each.range.endLine - each.range.startLine < WM_LIMITS.pointerLines)
    assert.equal(spill.read(each.snapshotId, each.range).text, original.slice(each.range.startLine - 1, each.range.endLine).join('\n'), 'every pointer works exactly as written')
  }
  const p = all[0]
  assert.throws(() => spill.read(p.snapshotId, { startLine: 1, endLine: 501 }), { code: 'INVALID_RANGE' }, 'a re-read is bounded like the existing inspector (500 lines)')
  assert.equal(spill.read(p.snapshotId, { startLine: 1, endLine: 1 }).text, grep.text.split('\n')[0])
})

test('browser page dump: only the named text array is gated; ids, refs and every other field stay byte-identical', async () => {
  const page = pageDump(), mock = mockDecisions(sensiblePolicy), spill = createSpillStore({ dir: tmp() })
  const before = JSON.parse(page.response.contentItems[0].text)
  const untouched = await gateToolResponse(page.response, { kind: 'page', goal: page.goal, mode: 'on', enabled: true, client: mock.client, egress: allow(), spill })
  assert.deepEqual([untouched.touched, untouched.reason, untouched.response === page.response], [false, 'structured', true], 'a JSON result is left alone unless one text array is named')
  const result = await gateToolResponse(page.response, { jsonTextArray: ['snapshot', 'text'], kind: 'page', goal: page.goal, mode: 'on', enabled: true, client: mock.client, egress: allow(), spill })
  assert.equal(result.touched, true)
  const after = JSON.parse(result.response.contentItems[0].text)
  assert.deepEqual({ ...after, snapshot: { ...after.snapshot, text: null } }, { ...before, snapshot: { ...before.snapshot, text: null } })
  for (const must of page.mustKeep) assert.ok(after.snapshot.text.includes(must), must)
  assert.ok(after.snapshot.text.length < 60 && after.snapshot.text.some(line => line.startsWith('[System: ')))
  assert.ok(result.tokensAfter < result.tokensBefore * 0.25)
  const failed = { success: false, contentItems: [{ type: 'inputText', text: 'x'.repeat(50000) }] }
  assert.equal((await gateToolResponse(failed, { kind: 'tool', mode: 'on', enabled: true, rules: true })).response, failed, 'a failed result is never rewritten')
})

test('non-repetitive prose: the code rule leaves it alone; only a judgment about meaning can pick the one section the goal needs', async () => {
  const article = articleDump()
  const codeOnly = await gateToolOutput({ ...article, mode: 'on', enabled: true, rules: true, client: null, spill: createSpillStore({ dir: tmp() }) })
  assert.deepEqual([codeOnly.touched, codeOnly.reason, codeOnly.text === article.text], [false, 'nothing_to_omit', true], 'no pattern links the goal to the section, so the rule keeps everything')
  const mock = mockDecisions(headingPolicy), spill = createSpillStore({ dir: tmp() })
  const result = await gateToolOutput({ ...article, mode: 'on', enabled: true, client: mock.client, egress: allow(), spill })
  assert.equal(result.touched, true); assert.equal(result.source, 'decision')
  const kept = result.text.split('\n')
  for (const must of [...article.mustKeep, article.relevantHeading]) assert.ok(kept.includes(must), must)
  assert.ok(result.tokensAfter < result.tokensBefore * 0.35, `${result.tokensBefore} → ${result.tokensAfter}`)
  const seen = mock.calls[0].input.at(-1).content[0].data.blocks.filter(block => block.preview.includes('지연 보상 정책'))
  assert.equal(seen.length, 1); assert.ok(!seen[0].preview.startsWith('## 지연 보상 정책'), 'the heading sits inside a merged block and is still in its outline preview')
  const original = article.text.split('\n')
  const pointers = pointer(result.text)
  assert.ok(pointers.length >= 1)
  for (const p of pointers) assert.equal(spill.read(p.snapshotId, p.range).text, original.slice(p.range.startLine - 1, p.range.endLine).join('\n'))
})

test('egress: text leaves only when the run\'s own model permissions allow that kind; otherwise zero requests and today\'s behaviour', async () => {
  const log = buildLog(), page = pageDump()
  const noTerminal = createEgressGate(modelDataPermissions({ toolCeiling: { terminal: 'none', browser: 'read' }, browserGranted: true, runActive: true }))
  const mock = mockDecisions(sensiblePolicy), calibration = recorder()
  const refused = await gateToolOutput({ ...log, mode: 'on', enabled: true, client: mock.client, egress: noTerminal, spill: createSpillStore({ dir: tmp() }), calibration })
  assert.deepEqual([refused.text === log.text, refused.requests, refused.fallback, mock.calls.length], [true, 0, 'evidence_unavailable', 0])
  const noBrowser = createEgressGate(modelDataPermissions({ runActive: true }))
  const pageResult = await gateToolResponse(page.response, { jsonTextArray: ['snapshot', 'text'], kind: 'page', mode: 'on', enabled: true, client: mock.client, egress: noBrowser })
  assert.deepEqual([pageResult.touched, pageResult.requests, mock.calls.length], [false, 0, 0])
  const sub = await gateToolOutput({ text: log.text, kind: 'subagent', mode: 'on', enabled: true, client: mock.client, egress: allow() })
  assert.deepEqual([sub.touched, sub.requests, sub.fallback], [false, 0, 'evidence_unavailable'], 'a kind with no egress class is never sent')
  const none = await gateToolOutput({ ...log, mode: 'on', enabled: true, client: mock.client, egress: null })
  assert.deepEqual([none.touched, none.requests], [false, 0], 'without the shared gate nothing is sent')
})

test('a Decision failure or an unsure answer is today\'s behaviour (inject); the rules flag is a separate, explicit policy', async () => {
  const log = buildLog()
  for (const code of ['timeout', 'budget_exceeded', 'bad_response']) {
    const mock = mockDecisions(sensiblePolicy, { fail: code }), calibration = recorder()
    const result = await gateToolOutput({ ...log, mode: 'on', enabled: true, client: mock.client, egress: allow(), spill: createSpillStore({ dir: tmp() }), calibration })
    assert.deepEqual([result.text === log.text, result.touched, result.fallback, result.requests], [true, false, code, 1])
    assert.equal(normalizeEntry(calibration.entries[0]).fallback, code)
  }
  const unsure = mockDecisions(sensiblePolicy, { top: 0.5 }), calibration = recorder()
  const held = await gateToolOutput({ ...log, mode: 'on', enabled: true, client: unsure.client, egress: allow(), spill: createSpillStore({ dir: tmp() }), calibration })
  assert.deepEqual([held.text === log.text, held.touched, held.reason], [true, false, 'nothing_to_omit'])
  assert.ok(calibration.entries[0].judgments.every(j => j.would === 'hold' && j.confidence < 0.75))
  const down = mockDecisions(sensiblePolicy, { fail: 'timeout' }), spill = createSpillStore({ dir: tmp() })
  const ruled = await gateToolOutput({ ...log, mode: 'on', enabled: true, rules: true, client: down.client, egress: allow(), spill })
  assert.deepEqual([ruled.touched, ruled.source, ruled.fallback], [true, 'rules', 'timeout'])
  for (const must of log.mustKeep) assert.ok(ruled.text.split('\n').includes(must))
  const codeOnly = await gateToolOutput({ ...log, mode: 'on', enabled: true, rules: true, client: null, spill: createSpillStore({ dir: tmp() }) })
  assert.deepEqual([codeOnly.touched, codeOnly.source, codeOnly.requests], [true, 'rules', 0], 'the deterministic policy needs no model and no egress')
})

test('a model that tries to drop anchors cannot: anchors are kept by code whatever it answers', async () => {
  const log = buildLog()
  const hostile = mockDecisions((block, values) => (values.includes('collapse_template') ? 'collapse_template' : values[0]))
  const result = await gateToolOutput({ ...log, mode: 'on', enabled: true, client: hostile.client, egress: allow() })
  assert.equal(result.touched, true)
  for (const must of log.mustKeep) assert.ok(result.text.split('\n').includes(must), must)
  assert.equal(result.text.includes('Re-read:'), false, 'no store, no pointer')
})

test('spill store: private directory and files, bounded, integrity-checked, no path escape', () => {
  const dir = path.join(tmp(), 'scratch'), store = createSpillStore({ dir, maxFiles: 3, maxBytes: 1000, maxFileBytes: 400 })
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  const first = store.put('one\ntwo\nthree')
  assert.equal(statSync(path.join(dir, `${first.id}.spill`)).mode & 0o777, 0o600)
  assert.equal(statSync(path.join(dir, `${first.id}.json`)).mode & 0o777, 0o600)
  assert.deepEqual(store.read(first.id, { startLine: 2, endLine: 3 }), { text: 'two\nthree', range: { startLine: 2, endLine: 3, totalLines: 3 }, sha256: store.read(first.id).sha256 })
  assert.equal(store.put('x'.repeat(401)), null, 'an output over the per-file limit is not spilled')
  assert.equal(store.put(''), null)
  const ids = [first.id, store.put('b'.repeat(300)).id, store.put('c'.repeat(300)).id, store.put('d'.repeat(300)).id]
  assert.ok(store.list().length <= 3 && store.list().reduce((sum, entry) => sum + entry.bytes, 0) <= 1000, 'count and bytes stay bounded')
  assert.throws(() => store.read(ids[0]), { code: 'SPILL_NOT_FOUND' }, 'the oldest file went first')
  assert.throws(() => store.read('../../etc/passwd'), { code: 'SPILL_NOT_FOUND' })
  assert.throws(() => store.read(ids[3], { startLine: 0, endLine: 1 }), { code: 'INVALID_RANGE' })
  writeFileSync(path.join(dir, `${ids[3]}.spill`), 'tampered')
  assert.throws(() => store.read(ids[3]), { code: 'SPILL_CORRUPT' })
  assert.throws(() => createSpillStore({ dir: 'relative/dir' }), TypeError)
  const real = tmp(), link = path.join(tmp(), 'link'); symlinkSync(real, link)
  assert.throws(() => createSpillStore({ dir: link }), /real directory/)
  const open = path.join(tmp(), 'open'); mkdirSync(open, { mode: 0o755 })
  createSpillStore({ dir: open }); assert.equal(statSync(open).mode & 0o777, 0o700, 'a directory others could enter is closed before use')
})

test('long-session blocks: the runtime fixes the first goal and the current turn; only unclear older blocks are asked; templates replace logs, never user text', async () => {
  const blocks = [
    { id: 'u1', role: 'user', turn: 1, text: '결제 모듈 빌드 오류를 고쳐 줘' },
    { id: 't1', role: 'tool', turn: 1, kind: 'build', exitCode: 2, hasError: true, text: buildLog().text },
    { id: 'a1', role: 'assistant', turn: 1, text: 'addTax 호출의 인자 타입을 고쳤습니다.\nregion 은 숫자 코드로 변환합니다.\n수정 파일: src/checkout/payment.ts\n다시 빌드합니다.\n확인 부탁드립니다.' },
    { id: 't2', role: 'tool', turn: 2, kind: 'search', exitCode: 0, text: grepOutput().text },
    { id: 'u3', role: 'user', turn: 3, text: '이제 테스트도 돌려 줘' },
    { id: 't3', role: 'tool', turn: 3, kind: 'terminal', exitCode: 0, text: shortResult().text },
  ]
  assert.deepEqual(enumerateRoleOptions(blocks[0], { firstUserId: 'u1', latestTurn: 3 }), ['user_goal'])
  assert.deepEqual(enumerateRoleOptions(blocks[5], { firstUserId: 'u1', latestTurn: 3 }), ['current_active_task'])
  assert.ok(enumerateRoleOptions(blocks[1], { firstUserId: 'u1', latestTurn: 3 }).includes('error_trace_resolved'))
  assert.equal(enumerateRoleOptions(blocks[3], { firstUserId: 'u1', latestTurn: 3 }).includes('error_trace_resolved'), false, 'a clean exit cannot be a resolved error trace')
  const judge = mockDecisions((block, values) => ({ t1: 'error_trace_resolved', a1: 'critical_fact', t2: 'stale_intermediate_log' })[block.id] || values[0])
  const calibration = recorder()
  const off = await classifyContextBlocks({ blocks, mode: 'off', client: judge.client, egress: allow() })
  assert.deepEqual([off.requests, off.roles.t1, off.roles.u1], [0, 'current_active_task', 'user_goal'], 'unclassified blocks are never collapsed')
  const advisory = await classifyContextBlocks({ blocks, mode: 'advisory', client: judge.client, egress: allow(), calibration })
  assert.deepEqual([advisory.requests, advisory.roles.t1], [1, 'current_active_task'])
  assert.deepEqual(normalizeEntry(calibration.entries[0]).judgments.map(j => [j.q, j.value]), [['wm_role', 'error_trace_resolved'], ['wm_role', 'critical_fact'], ['wm_role', 'stale_intermediate_log']])
  const refused = await classifyContextBlocks({ blocks, mode: 'on', client: judge.client, egress: allow({ topicConsent: false }) })
  assert.deepEqual([refused.requests, refused.fallback], [0, 'evidence_unavailable'], 'history text follows the per-DM topic consent')
  const on = await classifyContextBlocks({ blocks, mode: 'on', client: judge.client, egress: allow() })
  assert.deepEqual(on.roles, { u1: 'user_goal', t1: 'error_trace_resolved', a1: 'critical_fact', t2: 'stale_intermediate_log', u3: 'current_active_task', t3: 'current_active_task' })
  assert.equal(judge.calls.at(-1).questions.length, 3, 'only the three unclear blocks are asked')
  const collapsed = collapseContextBlocks(blocks, on.roles)
  assert.equal(collapsed[0].text, blocks[0].text); assert.equal(collapsed[4].text, blocks[4].text)
  assert.equal(collapsed[1].text, '[System: error trace of 300 lines omitted; resolved in a later step. Exit code: 2.]\nsrc/checkout/payment.ts:88:17 - error TS2345: Argument of type \'string\' is not assignable to parameter of type \'number\'.')
  assert.equal(collapsed[3].text, '[System: 2000 lines of search results omitted; its result is reflected in a later step. Exit code: 0.]')
  assert.equal(collapsed[2].collapsed, false); assert.equal(collapsed[5].collapsed, false)
  const before = blocks.reduce((sum, b) => sum + estimateTokens(b.text), 0), after = collapsed.reduce((sum, b) => sum + estimateTokens(b.text), 0)
  assert.ok(after < before * 0.02, `${before} → ${after}`)
})

test('request shape: previews are bounded and secret-masked, and the goal is cut to its limit', () => {
  const text = ['$ deploy', ...Array.from({ length: 200 }, (_, i) => `step ${i} token=sk-abcdefghijklmnopqrstuvwxyz0123456789 ${'x'.repeat(300)}`), 'done'].join('\n')
  const { lines, blocks } = enumerateBlockOptions(text, { kind: 'terminal', canSpill: true })
  const { request, asked } = buildGateRequest({ lines, blocks, kind: 'terminal', exitCode: 0, goal: 'g'.repeat(1000) })
  const data = request.input.at(-1).content[0].data
  assert.equal(data.goal.length, WM_LIMITS.goalChars)
  assert.equal(asked.length, request.questions.length)
  for (const block of data.blocks) { assert.ok(block.preview.length <= 1200); assert.equal(block.preview.includes('sk-abcdefghijklmnopqrstuvwxyz'), false) }
})
