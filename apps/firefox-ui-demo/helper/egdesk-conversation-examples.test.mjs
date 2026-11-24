import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { main as examplesMain } from '../scripts/egdesk-conversation-examples.mjs'
import { main as runnerMain } from './egdesk-decision-real-runner.mjs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTROL_EXAMPLES, INTERACTION_TYPES, TYPE_NAMES, areaOf, buildLabelPlan, dedupe, examplesOf, labelRequest, readLabels, scenariosOf, streamTurns, tagsOf } from './egdesk-conversation-examples.mjs'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'

// SYNTHETIC conversation logs in the three record formats (no real conversation text is committed).
const codexLines = [
  { type: 'session_meta', payload: { cwd: '/work/EG-Desk-Dev-Space', id: 's1' } },
  { type: 'response_item', timestamp: '2026-11-01T01:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context><cwd>/work</cwd></environment_context>' }, { type: 'input_text', text: '보드 정리 기능 만들어줘' }] } },
  { type: 'response_item', timestamp: '2026-11-01T01:00:01Z', payload: { type: 'reasoning', summary: [] } },
  { type: 'response_item', timestamp: '2026-11-01T01:00:02Z', payload: { type: 'function_call_output', output: 'secret tool output sk-abcdefghijklmnopqrstu' } },
  { type: 'response_item', timestamp: '2026-11-01T01:01:00Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '정리 기능을 c17 브랜치에 넣었습니다. 진행할까요?\n<oai-mem-citation>\n<citation_entries>x</citation_entries>\n</oai-mem-citation>' }] } },
  { type: 'response_item', timestamp: '2026-11-01T01:02:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '아니 그거 c17이 아니라 c18이야. 키는 sk-proj-abcdefghijklmnop1234 이고 메일은 a@b.co' }] } },
  { type: 'response_item', timestamp: '2026-11-01T01:03:00Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'c18로 옮기겠습니다. 계속할까요?' }] } },
  { type: 'event_msg', timestamp: '2026-11-01T01:03:30Z', payload: { type: 'agent_message', author: '/root/x', content: [{ type: 'input_text', text: '에이전트끼리의 말' }] } },
  { type: 'response_item', timestamp: '2026-11-01T01:04:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '왜 또 물어? 그냥 진행해' }] } },
]
const claudeLines = [
  { type: 'user', cwd: '/work/Taehwa_backup', timestamp: '2026-11-02T01:00:00Z', message: { content: '온톨로지 후보 정리해줘' } },
  { type: 'assistant', cwd: '/work/Taehwa_backup', timestamp: '2026-11-02T01:01:00Z', message: { content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: '후보 3건을 정리했습니다. A안과 B안 중 고르시면 됩니다.' }] } },
  { type: 'user', cwd: '/work/Taehwa_backup', timestamp: '2026-11-02T01:01:30Z', message: { content: [{ type: 'tool_result', content: 'x' }, { type: 'text', text: 'tool says hi' }] } },
  { type: 'user', isMeta: true, cwd: '/work/Taehwa_backup', timestamp: '2026-11-02T01:01:40Z', message: { content: 'meta' } },
  { type: 'user', cwd: '/work/Taehwa_backup', timestamp: '2026-11-02T01:02:00Z', message: { content: 'a안 안보여. 무슨 대체 문구?' } },
  { type: 'assistant', cwd: '/work/Taehwa_backup', timestamp: '2026-11-02T01:03:00Z', message: { content: [{ type: 'text', text: '다시 보여 드리겠습니다.' }] } },
  { type: 'user', cwd: '/work/Taehwa_backup', timestamp: '2026-11-02T01:04:00Z', message: { content: '그래' } },
]
const asideLines = [{ role: 'user', at: 1794748578563, text: '오늘 저녁 메뉴 추천해줘' }, { role: 'assistant', at: 1794748579140, text: '비빔밥 어떠세요?' }, { role: 'user', at: 1794748591643, text: '좋네' }]
const files = t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-conv-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const put = (name, rows) => { const f = path.join(dir, name); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); return f }
  return { dir, codex: put('codex/2026/11/01/rollout-x.jsonl', codexLines), claude: put('claude/-work-Taehwa-backup/a.jsonl', claudeLines), aside: put('aside.jsonl', asideLines) }
}
const read = async (file, kind) => { const out = []; for await (const t of streamTurns(file, kind)) out.push(t); return out }

test('readers keep only the person\'s typed turns and the assistant\'s messages (no injected context, tool output, reasoning or agent messages)', async t => {
  const f = files(t)
  const codex = await read(f.codex, 'codex')
  assert.deepEqual(codex.map(x => [x.role, x.text, x.cwd]), [['user', '보드 정리 기능 만들어줘', '/work/EG-Desk-Dev-Space'], ['assistant', '정리 기능을 c17 브랜치에 넣었습니다. 진행할까요?', '/work/EG-Desk-Dev-Space'],
    ['user', '아니 그거 c17이 아니라 c18이야. 키는 sk-proj-abcdefghijklmnop1234 이고 메일은 a@b.co', '/work/EG-Desk-Dev-Space'], ['assistant', 'c18로 옮기겠습니다. 계속할까요?', '/work/EG-Desk-Dev-Space'], ['user', '왜 또 물어? 그냥 진행해', '/work/EG-Desk-Dev-Space']])
  assert.ok(!JSON.stringify(codex).includes('tool output') && !JSON.stringify(codex).includes('에이전트끼리'))
  const claude = await read(f.claude, 'claude')
  assert.deepEqual(claude.map(x => [x.role, x.text]), [['user', '온톨로지 후보 정리해줘'], ['assistant', '후보 3건을 정리했습니다. A안과 B안 중 고르시면 됩니다.'], ['user', 'a안 안보여. 무슨 대체 문구?'], ['assistant', '다시 보여 드리겠습니다.'], ['user', '그래']])
  assert.equal(claude[0].line, 1); assert.equal(claude[2].line, 5)
  assert.ok(!JSON.stringify(claude).includes('tool says hi'), 'a tool result record is never a turn')
})

test('examples: area by cwd first, then mentions; secrets masked always; the turn before and after bounded; heuristic tags are candidates only', async t => {
  const f = files(t)
  const ex = examplesOf(await read(f.codex, 'codex'), { source: 'codex', file: '~/codex/rollout-x.jsonl' })
  assert.equal(ex.length, 3); assert.ok(ex.every(e => e.area === 'egdesk' && e.privacy === 'owner-approved'))
  const fix = ex[1]
  assert.equal(fix.user.text, '아니 그거 c17이 아니라 c18이야. 키는 [key] 이고 메일은 [email]')
  assert.equal(fix.prev.text, '정리 기능을 c17 브랜치에 넣었습니다. 진행할까요?'); assert.equal(fix.next.text, 'c18로 옮기겠습니다. 계속할까요?')
  assert.deepEqual([fix.source.line, fix.at], [6, '2026-11-01T01:02:00Z'])
  assert.ok(fix.tags.includes('correction'))
  assert.ok(ex[2].tags.includes('pushback'))
  const tw = examplesOf(await read(f.claude, 'claude'), { source: 'claude', file: 'c.jsonl', project: '-work-Taehwa-backup' })
  assert.ok(tw.every(e => e.area === 'taehwa'))
  assert.ok(tw.find(e => e.user.text.startsWith('a안')).tags.includes('reask'))
  assert.deepEqual(tw.find(e => e.user.text === '그래').tags, ['approval', 'ambiguous'])
  const other = examplesOf(await read(f.aside, 'aside'), { source: 'aside', file: 'a.jsonl' })
  assert.deepEqual([other.length, other.dropped.no_area], [0, 2], 'a turn of neither area is dropped')
  assert.equal(areaOf({ cwd: '/x/주 쿠스', text: '태화 온톨로지 후보' }), 'taehwa'); assert.equal(areaOf({ cwd: '/x/EG-Desk-Dev-Space', text: '태화' }), 'egdesk', 'the cwd comes first')
  assert.deepEqual(tagsOf('고마워요'), ['praise'])
  assert.equal(dedupe([...ex, ...ex.map(e => ({ ...e, id: `${e.id}x`, at: '2026-12-01' }))]).length, 3)
})

test('labelling: one turn per request, one predicate per type, grouping lint clean; labels at .8, a missing answer unknown', () => {
  const e = { id: 'e1', prev: { text: '진행할까요?' }, user: { text: '그래' } }
  const body = labelRequest(e, DECISION_MODEL)
  assert.deepEqual(body.questions.map(q => q.name), TYPE_NAMES.map(n => `conv_${n}`))
  assert.ok(lintGroupedRequest(body).ok)
  assert.match(body.input[1].content, /The end of the assistant message before the turn:\n"""\n진행할까요\?\n"""\n\nThe person's turn:\n"""\n그래\n"""/)
  const labels = readLabels([{ name: 'conv_approval', probability: 0.93 }, { name: 'conv_correction', probability: 0.1 }, { name: 'conv_praise', probability: 0.5 }])
  assert.deepEqual([labels.approval, labels.correction, labels.praise, labels.reask], ['yes', 'no', 'unknown', 'unknown'])
  const scenarios = scenariosOf({ id: 'e1', area: 'egdesk', privacy: 'owner-approved', source: { kind: 'codex', file: 'f', line: 3 }, at: 'x', prev: e.prev, user: e.user, next: null, tags: ['approval', 'ambiguous'] })
  assert.deepEqual(scenarios.map(s => [s.feature, s.types, s.labelledBy]), [['confirmation_reading', ['approval', 'ambiguous'], 'heuristic']])
  assert.ok(scenarios[0].expectations.every(x => x.status === 'proposed'))
  assert.deepEqual(scenariosOf({ ...scenarios[0], id: 'e1', prev: e.prev, user: e.user, tags: [] }, labels).map(s => [s.feature, s.labelledBy]), [['confirmation_reading', 'decision_model']])
})

test('plan chunks: within the token budget, the synthetic controls with hard expectations in the first chunk, the candidates record-only', () => {
  const ex = Array.from({ length: 9 }, (_, i) => ({ id: `e${i}`, area: i % 2 ? 'taehwa' : 'egdesk', privacy: 'owner-approved', at: `2026-11-0${i + 1}`, prev: { text: '진행할까요?' }, user: { text: `그래 ${i}` }, tags: ['approval'], source: { kind: 'codex', file: 'f', line: i } }))
  const chunks = buildLabelPlan(ex, { model: DECISION_MODEL, chunkTokens: 12_000, sha: text => createHash('sha256').update(text).digest('hex') })
  assert.ok(chunks.length >= 2)
  for (const c of chunks) { assert.ok(c.plan.tokenCeiling <= 12_000); assert.ok(c.plan.requests.reduce((n, r) => n + r.estInputTokens, 0) <= 12_000 / 1.25); assert.deepEqual(c.plan.seeds, [{ id: 'conversation-examples', privacy: 'owner-approved' }]) }
  assert.deepEqual(chunks[0].plan.requests.slice(0, 2).map(r => [r.id, r.expect.length > 0]), [['control-correction', true], ['control-praise', true]])
  assert.ok(chunks.slice(1).every(c => c.plan.requests.every(r => r.recordOnly === true && !r.id.startsWith('control'))))
  assert.equal(CONTROL_EXAMPLES.length, 2)
  assert.deepEqual(chunks.flatMap(c => c.plan.requests).filter(r => r.id.startsWith('ex-')).map(r => r.id).sort(), ex.map(e => `ex-${e.id}`).sort(), 'every candidate once')
})

test('CLI: output outside the repository only, 0600 files; a second run reports nothing new; the first chunk passes the real runner\'s dry run', async t => {
  const f = files(t)
  const app = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const run = async out => { const lines = [], errors = []; const code = await examplesMain(['--out', out, '--codex', path.join(f.dir, 'codex'), '--claude', path.join(f.dir, 'claude'), '--pinned', path.join(f.dir, 'none'), '--aside', f.aside],
    { print: l => lines.push(l), printError: l => errors.push(l), home: f.dir }); if (code !== 0) throw new Error(errors.join('\n')); return JSON.parse(lines.at(-1)) }
  await assert.rejects(run(path.join(app, 'tmp-out')), /inside the repository/)
  const out = path.join(f.dir, 'out')
  const first = await run(out)
  // The Aside export is this EG-Desk session (its project names the area); the Codex file by its cwd, the Claude one by its folder.
  assert.deepEqual([first.examples, first.perArea, first.dropped.no_area], [8, { egdesk: 5, taehwa: 3 }, 0])
  assert.equal(statSync(path.join(out, 'examples', 'egdesk.jsonl')).mode & 0o777, 0o600)
  assert.ok(!readFileSync(path.join(out, 'examples', 'egdesk.jsonl'), 'utf8').includes('sk-proj'))
  assert.deepEqual((await run(out)).changes, { new: 0, changed: 0, unchanged: 8, kept: 0 })
  const before = process.env.EGDESK_SCENARIO_SEEDS; process.env.EGDESK_SCENARIO_SEEDS = out; t.after(() => { if (before === undefined) delete process.env.EGDESK_SCENARIO_SEEDS; else process.env.EGDESK_SCENARIO_SEEDS = before })
  const printed = [], refused = []
  const code = await runnerMain([path.join(out, 'plans', 'chunk-001', 'plan.json')], { env: {}, print: l => printed.push(l), printError: l => refused.push(l), fetchImpl: async () => { throw new Error('no network') } })
  assert.equal(code, 0, refused.join('\n')); assert.match(printed.join('\n'), /"mode":"dry_run"/)
})

test('the stratified sample (c20): the controls in every chunk, labelled examples left out, each chunk within its estimate cap and a 12k ceiling', () => {
  const ex = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, area: i % 2 ? 'taehwa' : 'egdesk', privacy: 'owner-approved', at: `2026-11-${String(i + 1).padStart(2, '0')}`, prev: { text: '진행할까요?' }, user: { text: `그래 ${i}` },
    tags: [TYPE_NAMES[i % TYPE_NAMES.length]], source: { kind: 'codex', file: 'f', line: i } }))
  const chunks = buildLabelPlan(ex, { model: DECISION_MODEL, chunkTokens: 12_000, estimateCap: 11_500, controlsEvery: true, maxChunks: 3, exclude: ['s0', 's1'], sha: text => createHash('sha256').update(text).digest('hex') })
  assert.equal(chunks.length, 3)
  for (const c of chunks) {
    assert.deepEqual(c.plan.requests.slice(0, 2).map(r => r.id), ['control-correction', 'control-praise'])
    assert.ok(c.plan.requests.reduce((n, r) => n + r.estInputTokens, 0) <= 11_500 && c.plan.tokenCeiling <= 12_000)
  }
  const ids = chunks.flatMap(c => c.plan.requests.map(r => r.id))
  assert.ok(!ids.includes('ex-s0') && !ids.includes('ex-s1'), 'already labelled')
  assert.equal(new Set(ids.filter(id => id.startsWith('ex-'))).size, ids.filter(id => id.startsWith('ex-')).length, 'each candidate once')
})

test('c22: the referential and re-ask questions ask what they mean (one condition each), and a subset request carries only those questions', () => {
  assert.match(INTERACTION_TYPES.referential.q, /only by pointing at it .* A turn that names what it is about is not\./)
  assert.match(INTERACTION_TYPES.reask.q, /could not understand or could not see something the assistant said or showed, and ask for it to be explained or shown again\?$/)
  const body = labelRequest({ id: 'x', prev: { text: '진행할까요?' }, user: { text: '방금 그 내용 정리해줘' } }, DECISION_MODEL, { types: ['referential', 'reask'] })
  assert.deepEqual(body.questions.map(q => q.name), ['conv_referential', 'conv_reask'])
})
