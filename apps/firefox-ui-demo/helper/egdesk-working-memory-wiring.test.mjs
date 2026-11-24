import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { publicText } from './codex-chat-values.mjs'
import { boundedCallToolResult, callToolResultFromResponse } from './egdesk-claude-mcp.mjs'
import { MAX_SPILLS_PER_RUN } from './egdesk-context-runtime.mjs'
import { TOOL_OUTPUT_LIMITS, hashContent } from './egdesk-context-store.mjs'
import { createEgressGate, modelDataPermissions } from './egdesk-decision-egress.mjs'
import { estimateTokens } from './egdesk-smart-read.mjs'
import { normalizeOutput } from './egdesk-working-memory-gate.mjs'
import { articleDump, buildLog, grepOutput, headingPolicy, mockDecisions, pageDump, shortResult } from './egdesk-working-memory-gate.fixture.mjs'
import { SPILL_EXPIRED_MESSAGE, classifyPublicToolError } from './codex-tool-errors.mjs'
import { enumerateLogBlocks, pickRelevantBlocks } from './egdesk-terminal-judge.mjs'
import { WM_JUDGE_MIN_TOKENS, commandOutputHandoff, gateRuntimeToolResult, omissionCounts, toolResultConsumer, workingMemoryActivity } from './egdesk-working-memory-wiring.mjs'
import { OWNER, pointersIn, standInProvider, textOf, wiringHarness } from './egdesk-working-memory-wiring.fixture.mjs'

const harness = async (t, options) => { const h = await wiringHarness(options); t.after(h.cleanup); return h }
const spillFiles = async h => { try { return (await readdir(path.join(await h.store.directory(OWNER, 'tool-outputs')))).length } catch { return 0 } }
const packetOf = reply => JSON.parse(textOf(reply))
// What the store serves for a spilled line: the same line with the store's own credential masking (it never changes the line count).
const stored = text => publicText(normalizeOutput(text), Infinity).split('\n')

test('default (no flag): every tool result reaches the engine byte-identical and nothing is stored or recorded', async t => {
  const log = buildLog(), page = pageDump()
  const h = await harness(t, { outputs: { egdesk_terminal_read: log.text, egdesk_page_read: page.response } })
  const { run } = await h.start()
  assert.equal(textOf(await h.tool(run, 'egdesk_terminal_read')), log.text)
  assert.equal((await h.tool(run, 'egdesk_page_read')).result, page.response, 'the very object the provider returned is what is delivered')
  assert.equal(await spillFiles(h), 0); assert.deepEqual(h.records, [])
  const off = await harness(t, { flag: 'off', outputs: { egdesk_terminal_read: log.text } })
  assert.equal(textOf(await off.tool((await off.start()).run, 'egdesk_terminal_read')), log.text, 'a flag set to off is the same as no flag')
})

test('advisory: the result is unchanged; one content-free record says what the code rules would have done', async t => {
  const log = buildLog()
  const h = await harness(t, { flag: 'advisory', outputs: { egdesk_terminal_read: log.text, egdesk_plain_tool: log.text, egdesk_search_read: shortResult().text } })
  const { run } = await h.start()
  assert.equal(textOf(await h.tool(run, 'egdesk_terminal_read')), log.text)
  assert.equal(await spillFiles(h), 0, 'advisory writes no spill')
  assert.equal(h.records.length, 1)
  const [entry] = h.records
  assert.deepEqual([entry.feature, entry.mode, entry.attached, entry.judgments.length], ['working_memory', 'advisory', false, 0])
  assert.deepEqual([entry.wm.kind, entry.wm.by, entry.wm.spill, entry.wm.linesBefore, entry.wm.tokensBefore], ['build', 'rules', true, 300, estimateTokens(log.text)])
  assert.ok(entry.wm.tokensAfter < entry.wm.tokensBefore * 0.1 && entry.wm.omittedBlocks >= 1)
  assert.equal(JSON.stringify(entry).includes('payment'), false, 'no output text in the record')
  assert.equal(h.chat.runs.get(`${run.conversationId}/${run.runId}`).activities.some(activity => activity.id.startsWith('working-memory:')), false, 'advisory changed nothing, so the record shows nothing')
  assert.equal(textOf(await h.tool(run, 'egdesk_plain_tool')), log.text, 'an undeclared tool is not a consumer')
  await h.tool(run, 'egdesk_search_read')
  assert.equal(h.records.length, 1, 'neither an undeclared tool nor a small result is recorded')
})

test('on, run with read access: a 300-line build log keeps its anchors and the model re-reads the spilled lines through egdesk_read_source', async t => {
  const log = buildLog(), original = stored(log.text)
  const h = await harness(t, { flag: 'on', outputs: { egdesk_terminal_read: log.text } })
  const { run, attached, live } = await h.start()
  const reply = await h.tool(run, 'egdesk_terminal_read')
  const gated = textOf(reply)
  assert.equal(reply.result.success, true)
  for (const must of log.mustKeep) assert.ok(gated.split('\n').includes(must), must)
  assert.ok(estimateTokens(gated) < estimateTokens(log.text) * 0.1, `${estimateTokens(log.text)} → ${estimateTokens(gated)}`)
  const pointers = pointersIn(gated)
  assert.ok(pointers.length >= 1)
  // The mock engine uses the pointer exactly as written.
  for (const args of pointers) {
    const read = await h.tool(run, 'egdesk_read_source', args)
    assert.equal(read.result.success, true, textOf(read))
    const packet = packetOf(read)
    assert.equal(packet.content.text, original.slice(args.range.startLine - 1, args.range.endLine).join('\n'), 'the read tool returns exactly the spilled lines')
    assert.deepEqual([packet.mode, packet.coverage.scope, packet.coverage.captureScope.type, packet.coverage.complete], ['direct', 'line-range', 'tool-output', true])
    // The re-read is an ordinary receipt-hashed context read: what was delivered is what the store vouches for.
    const inspected = await h.store.inspect(OWNER, args.snapshotId, { packetId: packet.packetId })
    assert.equal(inspected.delivered.hash, hashContent(textOf(read)))
    await h.reportUsage(run)
  }
  // A later range and a literal query both work, as the pointer line says.
  const later = await h.tool(run, 'egdesk_read_source', { snapshotId: pointers[0].snapshotId, intent: 're-read spilled tool output', range: { startLine: 100, endLine: 110 } })
  assert.equal(packetOf(later).content.text, original.slice(99, 110).join('\n'))
  await h.reportUsage(run)
  const found = await h.tool(run, 'egdesk_read_source', { snapshotId: pointers[0].snapshotId, intent: 'find a module', query: 'mod_77.ts' })
  assert.ok(packetOf(found).content.text.includes('src/modules/mod_77.ts'))
  // The spill is a source of this run for the read tool only: not an attachment the person sees, not in the model's source list.
  assert.deepEqual(live.context.captures.map(capture => capture.sourceId), [attached.sourceId])
  const listed = JSON.parse(textOf(await h.tool(run, 'egdesk_list_context')))
  assert.deepEqual(listed.captures.map(capture => capture.sourceId), [attached.sourceId])
  const manifest = await h.store.getCapture(OWNER, pointers[0].snapshotId)
  assert.deepEqual([manifest.kind, manifest.captureScope, manifest.truncated, manifest.capture.coverage.provenance], ['tool-output', { type: 'tool-output', locator: 'egdesk_terminal_read' }, false, 'egdesk-tool-result'])
  assert.equal(h.records.at(0).attached, true)
  // One content-free activity row for the answer: counts only (copy pending approval).
  const rows = live.activities.filter(activity => activity.id.startsWith('working-memory:'))
  assert.equal(rows.length, 1)
  assert.deepEqual([rows[0].kind, rows[0].status, rows[0].sourceRefs], ['decisionContext', 'completed', []])
  assert.deepEqual(rows[0].detail, { workingMemory: { results: 1, linesOmitted: omissionCounts(gated).linesOmitted, spilledResults: 1 } })
  assert.equal(rows[0].title, `도구 결과 정리 · 1건 · ${omissionCounts(gated).linesOmitted}줄 생략 · 다시 읽기 가능 1건`)
  assert.ok(omissionCounts(gated).linesOmitted > 250)
  assert.equal(/payment|egdesk_terminal_read|mod_/.test(JSON.stringify(rows[0])), false, 'no tool name and no output text in the row')
  assert.ok(h.events.some(event => event.event === 'activity.completed' && event.details?.id === rows[0].id))
  // A second changed result updates the same row instead of adding another.
  await h.tool(run, 'egdesk_terminal_read')
  const again = live.activities.filter(activity => activity.id.startsWith('working-memory:'))
  assert.deepEqual([again.length, again[0].detail.workingMemory.results, again[0].detail.workingMemory.spilledResults], [1, 2, 2])
})

test('on, run WITHOUT read access: no pointer is offered because none would work; process output still collapses, content is never dropped', async t => {
  const log = buildLog(), grep = grepOutput()
  const h = await harness(t, { flag: 'on', outputs: { egdesk_terminal_read: log.text, egdesk_search_read: grep.text } })
  const { run } = await h.start({ withContext: false })
  assert.equal(h.contexts.canSpill(h.chat.runs.get(`${run.conversationId}/${run.runId}`)), false)
  const gated = textOf(await h.tool(run, 'egdesk_terminal_read'))
  assert.equal(gated.includes('Re-read:'), false)
  assert.match(gated, /\[System: \d+ lines of build log omitted \(lines \d+-\d+\)\.\]/)
  for (const must of log.mustKeep) assert.ok(gated.split('\n').includes(must), must)
  assert.equal(textOf(await h.tool(run, 'egdesk_search_read')), grep.text, 'search hits are content: without a way to re-read them they stay')
  assert.equal(await spillFiles(h), 0)
})

test('browser-style JSON result: only the page text array changes; ids stay; the image item is carried over; the spilled segments read back', async t => {
  const page = pageDump(), before = JSON.parse(page.response.contentItems[0].text)
  const image = { type: 'inputImage', imageUrl: 'data:image/png;base64,AAAA' }
  const h = await harness(t, { flag: 'on', outputs: { egdesk_page_read: { success: true, contentItems: [page.response.contentItems[0], image] } } })
  const { run } = await h.start()
  const reply = await h.tool(run, 'egdesk_page_read')
  assert.equal(reply.result.contentItems[1], image)
  const after = JSON.parse(textOf(reply))
  assert.deepEqual({ ...after, snapshot: { ...after.snapshot, text: null } }, { ...before, snapshot: { ...before.snapshot, text: null } })
  for (const must of page.mustKeep) assert.ok(after.snapshot.text.includes(must), must)
  assert.ok(after.snapshot.text.length < 40)
  const [args] = pointersIn(after.snapshot.text.join('\n'))
  const packet = packetOf(await h.tool(run, 'egdesk_read_source', args))
  assert.equal(packet.content.text, before.snapshot.text.slice(args.range.startLine - 1, args.range.endLine).join('\n'))
  // The real Browser provider declares exactly this field for its page-reading tools.
  const { createCodexBrowserToolProvider } = await import('./codex-browser-tool-provider.mjs')
  const browser = createCodexBrowserToolProvider({ transport: { hasClient: () => false }, getOwnerKey: () => OWNER, service: {} })
  assert.deepEqual(toolResultConsumer({ provider: browser, tool: 'egdesk_browser_observe' }), { kind: 'page', jsonTextArray: ['snapshot', 'text'] })
  assert.equal(toolResultConsumer({ provider: browser, tool: 'egdesk_browser_click' }), null)
})

test('receipt-hashed context reads are never gated, even when large and the flag is on', async t => {
  const big = Array.from({ length: 150 }, (_, i) => `[${i}/150] 컴파일 src/modules/mod_${i}.ts (${i} ms)`).join('\n')
  const h = await harness(t, { flag: 'on' })
  const attached = await h.capture(big, 'big')
  const run = await h.chat.send({ message: 'read it', requestId: 'req-big', clientThreadId: 'ui', cwd: h.cwd, contextSnapshotIds: [attached.sourceId], contextCapabilities: { read: true } })
  await h.reportUsage(run)
  const reply = await h.tool(run, 'egdesk_read_source', { snapshotId: attached.sourceId, intent: 'Read the attached log' })
  const packet = packetOf(reply)
  assert.equal(packet.content.text, big, 'the packet text is the whole source, untouched')
  assert.equal((await h.store.inspect(OWNER, attached.sourceId, { packetId: packet.packetId })).delivered.hash, hashContent(textOf(reply)))
  assert.deepEqual(h.records, []); assert.equal(await spillFiles(h), 0)
  assert.equal(h.chat.workingMemoryGate(h.contexts, run, { tool: 'egdesk_read_source' }, reply.result), null, 'the runtime never enters the gate for the context provider')
  assert.equal((await gateRuntimeToolResult({ response: reply.result, flag: 'on', provider: h.contexts, contexts: h.contexts, tool: 'egdesk_read_source' })).reason, 'receipt_hashed')
})

test('a re-read serves the store projection: same line numbers, credentials masked exactly as for any other stored source', async t => {
  const lines = ['$ deploy --verbose', ...Array.from({ length: 200 }, (_, i) => `[${i}/200] uploaded part ${i}`), 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345" https://deploy.example/hook',
    ...Array.from({ length: 200 }, (_, i) => `[${i + 200}/400] verified part ${i}`), 'done']
  const h = await harness(t, { flag: 'on', outputs: { egdesk_terminal_read: lines.join('\n') } })
  const { run } = await h.start()
  const gated = textOf(await h.tool(run, 'egdesk_terminal_read'))
  const [args] = pointersIn(gated)
  const all = await h.store.readProjection(OWNER, args.snapshotId)
  assert.equal(all.text.split('\n').length, lines.length, 'masking never moves a line')
  assert.equal(all.text.includes('abcdefghijklmnopqrstuvwxyz012345'), false)
  assert.deepEqual(all.manifest.transformations.map(step => step.type), ['credential-redaction'])
  const read = packetOf(await h.tool(run, 'egdesk_read_source', { snapshotId: args.snapshotId, intent: 're-read spilled tool output', range: { startLine: 200, endLine: 204 } }))
  assert.equal(read.content.text, stored(lines.join('\n')).slice(199, 204).join('\n'))
  assert.match(read.content.text, /Authorization: \[REDACTED\]/)
})

test('a spill belongs to its run: another conversation cannot read it, a screen cannot create one, and a run spills at most its bound', async t => {
  const log = buildLog()
  const h = await harness(t, { flag: 'on', outputs: { egdesk_terminal_read: log.text } })
  const first = await h.start()
  const [args] = pointersIn(textOf(await h.tool(first.run, 'egdesk_terminal_read')))
  const other = await h.start({ clientThreadId: 'ui-2' })
  assert.notEqual(other.run.conversationId, first.run.conversationId)
  const denied = await h.tool(other.run, 'egdesk_read_source', args)
  assert.deepEqual([denied.result.success, JSON.parse(textOf(denied)).error.code], [false, 'CONTEXT_FORBIDDEN'])
  await assert.rejects(h.contexts.capture({ clientThreadId: 'ui', attachments: [{ id: 'x', kind: 'tool-output', label: 'forged', captureScope: { type: 'tool-output' }, content: { text: 'x', truncated: false } }] }), error => error.code === 'INVALID_CAPTURE')
  await assert.rejects(h.store.bindToolOutput(OWNER, other.live, args.snapshotId, { read: true }, null), error => error.code === 'CONTEXT_FORBIDDEN')
  for (let i = 1; i < MAX_SPILLS_PER_RUN; i++) assert.ok(pointersIn(textOf(await h.tool(first.run, 'egdesk_terminal_read'))).length >= 1)
  assert.equal(h.contexts.canSpill(first.live), false)
  const ninth = textOf(await h.tool(first.run, 'egdesk_terminal_read'))
  assert.equal(ninth.includes('Re-read:'), false, 'beyond the bound the spill option no longer exists; the log collapses without a pointer')
  for (const must of log.mustKeep) assert.ok(ninth.split('\n').includes(must))
  assert.equal(await spillFiles(h), MAX_SPILLS_PER_RUN)
})

test('bounded retention: the oldest spills go first, shared bytes survive, an expired pointer fails cleanly and a restore tolerates it', async t => {
  let clock = 1_000_000
  const log = buildLog()
  const h = await harness(t, { flag: 'on', outputs: { egdesk_terminal_read: log.text }, now: () => clock })
  const { run, attached, live } = await h.start()
  const [args] = pointersIn(textOf(await h.tool(run, 'egdesk_terminal_read')))
  // The same bytes also exist as an ordinary attachment: pruning the spill must not take them away.
  const twin = await h.capture(normalizeOutput(log.text), 'twin')
  clock += TOOL_OUTPUT_LIMITS.maxAgeMs + 1
  assert.deepEqual(await h.store.pruneToolOutputs(OWNER), [args.snapshotId])
  assert.equal((await h.store.readProjection(OWNER, twin.sourceId)).text, stored(log.text).join('\n'))
  assert.equal(await spillFiles(h), 0)
  const expired = await h.tool(run, 'egdesk_read_source', args)
  // The model is told, with a closed code and a fixed sentence, that the kept copy is gone. Not a crash, not stale text, no content.
  const gone = { code: 'SPILL_EXPIRED', message: SPILL_EXPIRED_MESSAGE }
  assert.deepEqual([expired.result.success, JSON.parse(textOf(expired)).error], [false, gone])
  assert.deepEqual(JSON.parse(textOf(await h.tool(run, 'egdesk_read_source', args))).error, gone, 'and again on a second try')
  assert.equal(h.events.filter(event => event.event === 'context.read.failed').at(-1).details.code, 'SPILL_EXPIRED')
  // After a bridge restart the run restores with the sources the person sent; the expired pointer still answers "expired".
  h.contexts.bindings.clear()
  await h.contexts.restoreRun(live)
  assert.deepEqual(live.context.captures.map(capture => capture.sourceId), [attached.sourceId])
  assert.deepEqual(JSON.parse(textOf(await h.tool(run, 'egdesk_read_source', args))).error, gone)
  // "Expired" is only ever said about this run's own spills: any other id stays the ordinary refusal.
  const stranger = await h.tool(run, 'egdesk_read_source', { ...args, snapshotId: '11111111-1111-4111-8111-111111111111' })
  assert.equal(JSON.parse(textOf(stranger)).error.code, 'CONTEXT_FORBIDDEN')
  assert.deepEqual(classifyPublicToolError({ code: 'SPILL_EXPIRED', message: 'private path /Users/x' }, { context: true }), gone, 'the public text is fixed whatever the internal error said')
  assert.equal(classifyPublicToolError({ code: 'SPILL_EXPIRED' }).code, 'TOOL_PROVIDER_FAILED', 'only the context provider can say it')
  // A spill that still exists is readable again after a restore, and still not shown as an attachment.
  const [fresh] = pointersIn(textOf(await h.tool(run, 'egdesk_terminal_read')))
  h.contexts.bindings.clear()
  await h.contexts.restoreRun(live)
  assert.deepEqual(live.context.captures.map(capture => capture.sourceId), [attached.sourceId])
  await h.reportUsage(run)
  assert.equal((await h.tool(run, 'egdesk_read_source', fresh)).result.success, true)
  // Count bound.
  const small = { ...TOOL_OUTPUT_LIMITS, maxCount: 2 }
  const ids = []
  for (let i = 0; i < 3; i++) { clock += 10; ids.push((await h.store.captureToolOutput(OWNER, live, { text: `line ${i}\nmore ${i}`, tool: 'egdesk_terminal_read' }, { limits: small })).sourceId) }
  await assert.rejects(h.store.getCapture(OWNER, ids[0]), error => error.code === 'CONTEXT_NOT_FOUND')
  assert.equal((await h.store.getCapture(OWNER, ids[2])).kind, 'tool-output')
  await assert.rejects(h.store.captureToolOutput(OWNER, live, { text: 'x'.repeat(TOOL_OUTPUT_LIMITS.maxBytes + 1), tool: 'egdesk_terminal_read' }), error => error.code === 'CAPTURE_LIMIT')
})

test('Claude over-limit: with the flag on an oversized result becomes anchors and fixed lines under the limit instead of an error', async () => {
  const lines = ['$ collect', ...Array.from({ length: 1800 }, (_, i) => `[${i}/1800] fetched record ${i} from shard ${i % 7} in ${i % 90} ms`), 'error: shard 3 returned 2 malformed rows', 'done: 1800 records']
  const response = { success: true, contentItems: [{ type: 'inputText', text: lines.join('\n') }] }
  const provider = standInProvider({}, { declare: false }) // not a declared consumer: only the over-limit rule applies
  assert.equal(boundedCallToolResult(callToolResultFromResponse(response)).limited, true, 'today this result is replaced by an error')
  for (const flag of ['off', 'advisory']) {
    const kept = await gateRuntimeToolResult({ response, flag, provider, tool: 'egdesk_plain_tool', engineId: 'claude' })
    assert.equal(kept.response, response, `${flag}: unchanged, so today's error still applies downstream`)
  }
  const codex = await gateRuntimeToolResult({ response, flag: 'on', provider, tool: 'egdesk_plain_tool', engineId: 'codex' })
  assert.deepEqual([codex.response === response, codex.reason], [true, 'undeclared'], 'the rule is about the Claude limit only')
  const records = []
  const gated = await gateRuntimeToolResult({ response, flag: 'on', provider, tool: 'egdesk_plain_tool', engineId: 'claude', calibrationLog: { record: raw => records.push(raw) } })
  assert.equal(gated.touched, true)
  const delivered = boundedCallToolResult(callToolResultFromResponse(gated.response))
  assert.equal(delivered.limited, false)
  const text = gated.response.contentItems[0].text.split('\n')
  for (const must of ['$ collect', 'error: shard 3 returned 2 malformed rows', 'done: 1800 records']) assert.ok(text.includes(must), must)
  assert.ok(text.some(line => /^\[System: \d+ lines of tool output omitted/.test(line)))
  assert.equal(records[0].wm.overLimit, true)
  // Structured or still-too-large results are left exactly as they were (today's error).
  const json = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ rows: lines }) }] }
  assert.equal((await gateRuntimeToolResult({ response: json, flag: 'on', provider, tool: 'egdesk_plain_tool', engineId: 'claude' })).response, json)
  const prose = { success: true, contentItems: [{ type: 'inputText', text: Array.from({ length: 12 }, () => articleDump().text).join('\n') }] }
  const still = await gateRuntimeToolResult({ response: prose, flag: 'on', provider, tool: 'egdesk_plain_tool', engineId: 'claude' })
  assert.equal(still.response, prose)
})

test('the Decision judge is advisory only: asked about non-repetitive text the rules left, never awaited, never applied, and only when the run may share that text', async () => {
  const article = articleDump()
  assert.ok(estimateTokens(article.text) >= WM_JUDGE_MIN_TOKENS)
  const response = { success: true, contentItems: [{ type: 'inputText', text: article.text }] }
  const provider = { workingMemory: { egdesk_page_read: { kind: 'page' } } }
  const egress = createEgressGate(modelDataPermissions({ browserGranted: true, runActive: true }))
  for (const flag of ['advisory', 'on']) {
    const mock = mockDecisions(headingPolicy, { latencyMs: 30 }), records = []
    const decision = { mode: () => 'advisory', configured: () => true, client: mock.client }
    const result = await gateRuntimeToolResult({ response, flag, provider, tool: 'egdesk_page_read', goal: article.goal, egress, decision, calibrationLog: { record: raw => records.push(raw) } })
    assert.equal(result.response, response, `${flag}: the code rules leave prose alone and the judge changes nothing`)
    assert.equal(records.filter(entry => entry.judgments.length).length, 0, 'the tool result did not wait for the judge')
    const advised = await result.judge
    assert.deepEqual([mock.calls.length, advised.requests], [1, 1])
    const judged = records.find(entry => entry.judgments.length)
    assert.deepEqual([judged.mode, judged.attached], ['advisory', false])
    assert.ok(advised.shadow.tokensAfter < estimateTokens(article.text) * 0.4)
  }
  const none = mockDecisions(headingPolicy)
  const base = { response, flag: 'advisory', provider, tool: 'egdesk_page_read' }
  for (const [label, extra] of [
    ['Decision mode off', { egress, decision: { mode: () => 'off', configured: () => true, client: none.client } }],
    ['no key', { egress, decision: { mode: () => 'on', configured: () => false, client: none.client } }],
    ['browser text not shareable in this run', { egress: createEgressGate(modelDataPermissions({ runActive: true })), decision: { mode: () => 'on', configured: () => true, client: none.client } }],
  ]) assert.equal((await gateRuntimeToolResult({ ...base, ...extra })).judge, undefined, label)
  const repetitive = await gateRuntimeToolResult({ ...base, response: { success: true, contentItems: [{ type: 'inputText', text: grepOutput().text }] }, provider: { workingMemory: { egdesk_page_read: { kind: 'search' } } },
    egress: createEgressGate(modelDataPermissions({ runActive: true })), decision: { mode: () => 'on', configured: () => true, client: none.client } })
  assert.equal(repetitive.judge, undefined, 'repetitive output is the code rules\' job; the judge is not asked')
  assert.equal(none.calls.length, 0)
})

test('activity row and omission counts are numbers only', () => {
  assert.deepEqual(omissionCounts('a\n[System: 140 lines of build log omitted (lines 5-144). Exit code: 2.]\nb\n[System: 950 lines of search results spilled (lines 253-1202). Re-read: egdesk_read_source {"snapshotId":"x","intent":"i","range":{"startLine":253,"endLine":286}}]\n[System: fake'),
    { linesOmitted: 1090, collapsedRuns: 1, spilledRuns: 1 })
  assert.deepEqual(workingMemoryActivity({ answerId: 'answer-1', tally: { results: 3, linesOmitted: 2140, spilledResults: 0 } }),
    { id: 'working-memory:answer-1', kind: 'decisionContext', status: 'completed', title: '도구 결과 정리 · 3건 · 2,140줄 생략', detail: { workingMemory: { results: 3, linesOmitted: 2140, spilledResults: 0 } }, sourceRefs: [] })
  assert.equal(workingMemoryActivity({ answerId: 'a', tally: { results: 'x', linesOmitted: -4 } }).title, '도구 결과 정리 · 0건 · 0줄 생략')
})

test('command-output hand-off (not wired anywhere today): anchors and stated omissions instead of raw picked blocks', async () => {
  // A failing test run: three failures far apart in a long log.
  const lines = ['$ node --test']
  for (let i = 1; i <= 400; i++) {
    if (i === 37) lines.push('# Subtest: applies regional tax', 'not ok 37 - applies regional tax', '  ---', "  error: 'Expected values to be strictly equal:'", '  expected: 1100', '  actual: 1000', '  ...')
    else if (i === 212) lines.push('# Subtest: refund keeps currency', 'not ok 212 - refund keeps currency', '  ---', "  error: 'currency mismatch: KRW vs USD'", '  ...')
    else if (i === 388) lines.push('# Subtest: export totals', 'not ok 388 - export totals', '  ---', "  error: 'ENOENT: no such file or directory, open fixtures/totals.csv'", '  ...')
    else lines.push(`# Subtest: case ${i}`, `ok ${i} - case ${i}`, '  ---', `  duration_ms: ${i % 9}.${i % 7}`, '  ...')
  }
  lines.push('1..400', '# tests 400', '# pass 397', '# fail 3')
  const output = lines.join('\n')
  const must = ["  error: 'Expected values to be strictly equal:'", '  expected: 1100', '  actual: 1000', "  error: 'currency mismatch: KRW vs USD'", "  error: 'ENOENT: no such file or directory, open fixtures/totals.csv'", '# fail 3']
  const handoff = await commandOutputHandoff({ output, exitCode: 1 })
  assert.equal(handoff.touched, true)
  for (const line of must) assert.ok(handoff.text.split('\n').includes(line), line)
  assert.ok(handoff.tokensAfter < handoff.tokensBefore * 0.06, `${handoff.tokensBefore} → ${handoff.tokensAfter}`)
  const counts = omissionCounts(handoff.text)
  assert.ok(counts.linesOmitted > 1900 && counts.collapsedRuns >= 3 && counts.spilledRuns === 0, 'every omission is a stated line range; no pointer without a store')
  // The raw picked blocks the judges record today (runtime fallback) on the same output: bounded, but one failure reason is lost and nothing says what was left out.
  const raw = (await pickRelevantBlocks({ blocks: enumerateLogBlocks(output), mode: 'off' })).blocks.map(block => block.text).join('\n\n')
  assert.ok(must.filter(line => raw.split('\n').includes(line)).length < must.length)
  assert.equal(/omitted|spilled/.test(raw), false)
  const small = await commandOutputHandoff({ output: shortResult().text, exitCode: 0 })
  assert.deepEqual([small.touched, small.text], [false, shortResult().text])
})
