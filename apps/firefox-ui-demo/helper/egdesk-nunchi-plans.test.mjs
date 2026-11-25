import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NUNCHI_CONTROLS, NUNCHI_CHUNK, PRIOR_CLASSES, buildNunchiEvalPlans, loadExamples, nunchiAgreement, priorClassOf, readPriorLabels, readWire, NUNCHI_MERGED_CONTROLS, buildNunchiMergedPlans, nunchiMergedReport, NUNCHI_FRESH_CONTROLS, buildNunchiFreshPlans } from './egdesk-nunchi-plans.mjs'
import { createOwnerExclusions } from './egdesk-scenario-exclusion.mjs'
import { loadPlan } from './egdesk-decision-real-runner.mjs'
import { nunchiRequest } from './egdesk-nunchi.mjs'
import { TYPE_NAMES } from './egdesk-conversation-examples.mjs'
import { choiceAnswer } from './egdesk-wiki-reconstruction.fixture.mjs'

// Synthetic examples and a synthetic exclusion rule: no real conversation, no real excluded name appears in a test.
const FORBIDDEN = 'zz-forbidden-project'
const example = (id, user, prev = '이전 답변입니다. 계속할까요?', extra = {}) => ({ schema: 'egdesk.conversation-example/1', id, area: 'egdesk', privacy: 'owner-approved', at: '2026-11-20T01:00:00Z', source: { kind: 'codex', file: 'rollout-x.jsonl', line: 3 }, prev: { text: prev }, user: { text: user }, next: null, ...extra })
const scores = types => Object.fromEntries(types.map(t => [t, 0.95]))
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-nunchi-plan-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir }

test('the owner\'s exclusion is applied to the example, its folder and file and every text it holds, before anything is built; counted, never named; examples without a previous message are not used', t => {
  const dir = tmp(t), file = path.join(dir, 'examples.jsonl')
  fs.writeFileSync(file, [example('a1', '아니 그게 아니라 화요일이야'), example('a2', `${FORBIDDEN} 폴더 얘기야`), example('a3', '좋아', `${FORBIDDEN} 작업을 끝냈습니다`), example('a4', '응', '확인', { source: { kind: 'codex', file: 'x', line: 1, cwd: `/work/${FORBIDDEN}/app` } }), example('a5', '혼잣말', ''), example('a6', '고마워', '완료했습니다', { next: { text: `다음은 ${FORBIDDEN}` } }), '{ broken'].map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n'))
  const exclusions = createOwnerExclusions({ excludeCwdPrefixes: [`/work/${FORBIDDEN}`], excludeTerms: [FORBIDDEN] })
  const { examples, counts } = loadExamples([file], { exclusions })
  assert.deepEqual(examples.map(e => e.id), ['a1']); assert.deepEqual(counts, { read: 6, excludedByOwner: 4, noPrevious: 1, unreadable: 1 })
  assert.throws(() => loadExamples([file], {}), /exclusions are required/)
  // a plan built from them never holds the term, anywhere
  const chunks = buildNunchiEvalPlans({ examples, labels: new Map([['a1', scores(['correction'])]]) })
  const all = chunks.flatMap(c => [JSON.stringify(c.plan), JSON.stringify(c.preregistration), ...c.files.map(f => f.bytes.toString('utf8'))]).join('\n')
  assert.ok(!all.includes(FORBIDDEN))
})

test('the controls come first with hard checks at the product\'s bar; the real examples follow, recordOnly, in a deterministic stratified order; every chunk\'s ceiling is at most 12,000', async t => {
  const classes = PRIOR_CLASSES.flatMap(c => [0, 1, 2].map(i => ({ c, id: `${c.id}-${i}` })))
  const examples = classes.map(({ c, id }) => example(id, `턴 ${id}`)), labels = new Map(classes.map(({ c, id }) => [id, scores(c.labels)]))
  const chunks = buildNunchiEvalPlans({ examples, labels, perClass: 2 }), again = buildNunchiEvalPlans({ examples, labels, perClass: 2 })
  assert.deepEqual(chunks.map(c => c.plan.requests.map(r => r.sha256)), again.map(c => c.plan.requests.map(r => r.sha256)), 'deterministic')
  const ids = chunks.flatMap(c => c.plan.requests.map(r => r.id))
  assert.deepEqual(ids.slice(0, NUNCHI_CONTROLS.length), NUNCHI_CONTROLS.map(c => c.id), 'the controls first'); assert.equal(ids.length, NUNCHI_CONTROLS.length + PRIOR_CLASSES.length * 2)
  assert.deepEqual(ids.slice(NUNCHI_CONTROLS.length, NUNCHI_CONTROLS.length + PRIOR_CLASSES.length), PRIOR_CLASSES.map(c => `ex-${c.id}-0`), 'a round over the prior classes')
  for (const c of chunks) { assert.ok(c.plan.tokenCeiling <= NUNCHI_CHUNK.tokenCeiling); assert.ok(c.estInputTokens * 1.1 <= c.plan.tokenCeiling + 1000)
    for (const r of c.plan.requests) assert.ok(r.id.startsWith('control-') ? r.expect.some(e => e.severity === 'hard') && !r.recordOnly : r.recordOnly === true && r.expect.length === 0, r.id) }
  assert.match(chunks[0].plan.passRule, /synthetic controls/); assert.match(chunks[1].plan.passRule, /Record only/)
  assert.deepEqual(Object.keys(chunks[0].plan.productBars), ['*choice']); assert.deepEqual([chunks[0].plan.productBars['*choice'].minConfidence, chunks[0].plan.productBars['*choice'].minMargin], [0.85, 0.2])
  // loads in the generic runner (its product-bar lint accepts every hard check)
  const dir = tmp(t); fs.mkdirSync(path.join(dir, 'requests'))
  for (const { file, bytes } of chunks[0].files) fs.writeFileSync(path.join(dir, file), bytes)
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(chunks[0].plan)); assert.equal(loadPlan(path.join(dir, 'plan.json')).requests.length, chunks[0].plan.requests.length)
  // the body of a request is the product's own request for that turn
  const body = JSON.parse(chunks[0].files.find(f => f.file === 'requests/control-language.json').bytes), mine = nunchiRequest({ message: '야 한글로 보고해', previousReply: NUNCHI_CONTROLS[0].prev })
  assert.deepEqual([body.input, body.questions], [mine.input, mine.questions])
  assert.ok(JSON.stringify(chunks.flatMap(c => c.preregistration)).includes('control-language') && !JSON.stringify(chunks.flatMap(c => c.preregistration)).includes('턴 '), 'the preregistration holds ids and classes, not the turns of the person')
})

test('the prior class of a real example comes from the earlier labelling at its bar: a reaction label wins over a "points back" one, and a turn that only points back or switches topic is no reaction', () => {
  assert.equal(priorClassOf(scores(['correction', 'referential'])).id, 'correction'); assert.equal(priorClassOf(scores(['referential'])).id, 'no_reaction'); assert.equal(priorClassOf(scores(['check_earlier'])).id, 'no_reaction')
  assert.equal(priorClassOf({ correction: 0.5 }), null, 'under the bar'); assert.equal(priorClassOf(null), null); assert.equal(priorClassOf(scores(['reask'])), null, 'a label with no class stays out')
  assert.equal(priorClassOf({ referential: 0.95, praise: 0.95 }).id, 'praise'); assert.equal(priorClassOf({ referential: 0.95, interruption: 0.95 }), null, 'a stop request is neither a reaction class nor no reaction')
  assert.ok(PRIOR_CLASSES.every(c => c.labels.every(l => TYPE_NAMES.includes(l)) && c.allow.length >= 1))
  const file = path.join(os.tmpdir(), `labels-${process.pid}-plan-results.json`)
  fs.writeFileSync(file, JSON.stringify({ results: { 'ex-abc': { answers: [{ name: 'conv_correction', probability: 0.9 }, { name: 'conv_praise', probability: 0.01 }, { name: 'other', probability: 1 }] }, 'control-x': { answers: [{ name: 'conv_praise', probability: 1 }] } } }))
  assert.deepEqual([...readPriorLabels([file])], [['abc', { correction: 0.9, praise: 0.01 }]]); fs.rmSync(file); assert.equal(readPriorLabels(['/nonexistent/x']).size, 0)
})

test('the agreement report: per prior class how often the installed kind is in the allowed set, disagreements by id (no text), unread under the bar, controls listed', () => {
  const want = { nk_kind: 'correction', nk_about: 'language', nk_strength: 'clear', nk_direction: 'not_applicable', nk_language: 'korean' }
  const q = nunchiRequest({ message: 'x' }).questions, answerOf = (w, top = 0.95) => q.map(question => ({ name: question.name, ...choiceAnswer(question, w[question.name], top) }))
  const pre = [{ id: 'control-language', control: true, turn: 'x', expect: [] },
    { id: 'ex-1', priorClass: 'correction', allow: ['correction', 'instruction_change', 'complaint'] }, { id: 'ex-2', priorClass: 'correction', allow: ['correction', 'instruction_change', 'complaint'] },
    { id: 'ex-3', priorClass: 'approval', allow: ['short_approval'] }, { id: 'ex-4', priorClass: 'praise', allow: ['praise'] }, { id: 'ex-5', priorClass: 'praise', allow: ['praise'] }]
  const results = { results: { 'control-language': { answers: answerOf(want), elapsedMs: 230 }, 'ex-1': { answers: answerOf(want) }, 'ex-2': { answers: answerOf({ ...want, nk_kind: 'praise' }) }, 'ex-3': { answers: answerOf(want, 0.5) }, 'ex-4': { answers: answerOf({ ...want, nk_kind: 'praise' }) } } }
  const r = nunchiAgreement(results, pre)
  assert.deepEqual(r.byClass, { correction: { n: 2, agree: 1, disagree: 1, unread: 0, not_sent: 0 }, approval: { n: 1, agree: 0, disagree: 0, unread: 1, not_sent: 0 }, praise: { n: 2, agree: 1, disagree: 0, unread: 0, not_sent: 1 } })
  assert.deepEqual([r.totals.agreementWhereRead, r.totals.readRate, r.totals.unread, r.totals.notSent], [0.667, 0.6, 1, 1])
  assert.match(r.text, /- ex-2 prior correction -> kind praise/); assert.match(r.text, /- control-language: kind correction, change true \(0\.\d+\), about language, strength clear, forceful true, direction not_applicable, language korean \(230 ms\)/); assert.ok(!r.text.includes('x'.repeat(5)))
  assert.deepEqual(nunchiAgreement({}, pre).totals, { examples: 5, agree: 0, disagree: 0, unread: 0, notSent: 5, agreementWhereRead: null, readRate: 0 })
})

test('u2: the report reads the runner\'s wire answers the way the product does (options in question order, sorted by the client first), and a split between neighbouring kinds counts as a change', () => {
  const q = nunchiRequest({ message: 'x' }).questions
  const row = (name, dist) => { const top = Object.entries(dist).sort((a, b) => b[1] - a[1])[0]; const n = q.find(x => x.name === name).choices.length
    return { type: 'choice', name, choice: top[0], confidence: (top[1] - 1 / n) / (1 - 1 / n), probabilities: q.find(x => x.name === name).choices.map(c => ({ value: c.value, probability: dist[c.value] ?? 0 })) } }
  // the real answers of the control "야 한글로 보고해": correction .78 / instruction_change .14 (option order: praise first)
  const wire = [row('nk_kind', { correction: 0.78, instruction_change: 0.14, praise: 0.01, complaint: 0.01, none: 0.06 }), row('nk_about', { language: 0.98, length: 0.02 }), row('nk_strength', { clear: 0.96, mild: 0.03, strong: 0.01 }), row('nk_direction', { not_applicable: 0.9, keep: 0.1 }), row('nk_language', { korean: 0.98, none: 0.02 })]
  const pre = [{ id: 'ex-1', priorClass: 'instruction_change', allow: ['instruction_change', 'correction'] }, { id: 'ex-2', priorClass: 'approval', allow: ['short_approval'] }]
  const r = nunchiAgreement({ results: { 'ex-1': { answers: wire }, 'ex-2': { answers: wire } } }, pre)
  assert.deepEqual(r.rows.map(x => [x.id, x.state, x.kind]), [['ex-1', 'agree', 'change'], ['ex-2', 'disagree', 'change']], 'the merged reading is what is compared')
  assert.equal(readWire(wire).about, 'language'); assert.equal(readWire([]).change, null); assert.equal(readWire('garbage').kind, null)
})

test('u2: the validation plan of the merged reading is twelve NEW synthetic turns in two chunks (six that ask for a change, six that do not), recordOnly, built by the product\'s request function, loadable by the runner', () => {
  const chunks = buildNunchiMergedPlans()
  assert.deepEqual(chunks.map(c => c.plan.requests.length), [6, 6]); assert.ok(chunks.every(c => c.plan.tokenCeiling <= NUNCHI_CHUNK.tokenCeiling && c.plan.requests.every(r => r.recordOnly === true && r.expect.length === 0)))
  assert.equal(NUNCHI_MERGED_CONTROLS.filter(c => c.expect.change === true).length, 6); assert.equal(NUNCHI_MERGED_CONTROLS.filter(c => c.expect.change === false).length, 6)
  const earlier = new Set(NUNCHI_CONTROLS.map(c => c.user)); assert.ok(NUNCHI_MERGED_CONTROLS.every(c => !earlier.has(c.user)), 'none of the turns of the first set: the rule was tuned on those')
  const body = JSON.parse(chunks[0].files.find(f => f.file === 'requests/m-language-ask.json').bytes), mine = nunchiRequest({ message: '한국어로 말해줘', previousReply: NUNCHI_MERGED_CONTROLS[0].prev })
  assert.deepEqual([body.input, body.questions], [mine.input, mine.questions])
  assert.ok(chunks.every(c => c.preregistration.every(p => p.merged === true && ['hard', 'soft'].includes(p.expect.severity))))
})

test('u2: the merged report reads the answers like the product: change true or false exactly (undecided is a miss), the named about / direction / language, forceful for a change; hard and soft counted apart', () => {
  const q = nunchiRequest({ message: 'x' }).questions
  const row = (name, dist) => { const top = Object.entries(dist).sort((a, b) => b[1] - a[1])[0]; const n = q.find(x => x.name === name).choices.length
    return { type: 'choice', name, choice: top[0], confidence: (top[1] - 1 / n) / (1 - 1 / n), probabilities: q.find(x => x.name === name).choices.map(c => ({ value: c.value, probability: dist[c.value] ?? 0 })) } }
  const asks = (about, extra = {}) => [row('nk_kind', { correction: 0.7, instruction_change: 0.2, none: 0.1 }), row('nk_about', { [about]: 0.97, other: 0.03 }), row('nk_strength', { clear: 0.95, mild: 0.05 }), row('nk_direction', { less: 0.97, none: 0 }), row('nk_language', { korean: 0.97, none: 0.03 }), ...Object.values(extra)]
  const no = [row('nk_kind', { none: 0.97, praise: 0.03 }), row('nk_about', { no_particular: 0.98 }), row('nk_strength', { mild: 0.95, clear: 0.05 }), row('nk_direction', { not_applicable: 1 }), row('nk_language', { none: 1 })]
  const pre = [{ id: 'm-language-ask', merged: true, expect: { change: true, about: 'language', language: 'korean', severity: 'hard' } }, { id: 'm-length-standing', merged: true, expect: { change: true, about: 'length', direction: 'less', severity: 'hard' } },
    { id: 'm-remark', merged: true, expect: { change: false, severity: 'hard' } }, { id: 'm-table-format', merged: true, expect: { change: true, about: 'format', severity: 'soft' } }, { id: 'm-ok', merged: true, expect: { change: false, severity: 'hard' } }]
  const r = nunchiMergedReport({ results: { 'm-language-ask': { answers: asks('language') }, 'm-length-standing': { answers: asks('language') }, 'm-remark': { answers: no }, 'm-table-format': { answers: asks('format') } } }, pre)
  assert.deepEqual(r.rows.map(x => [x.id, x.pass]), [['m-language-ask', true], ['m-length-standing', false], ['m-remark', true], ['m-table-format', true], ['m-ok', false]])
  assert.match(r.rows[1].misses.join(' '), /about language, wanted length/); assert.equal(r.rows[4].state, 'not_sent'); assert.deepEqual([r.hard, r.soft], [{ passed: 2, total: 4 }, { passed: 1, total: 1 }])
  const undecided = nunchiMergedReport({ results: { 'm-remark': { answers: [row('nk_kind', { correction: 0.45, none: 0.4, complaint: 0.15 }), ...no.slice(1)] } } }, [pre[2]])
  assert.equal(undecided.rows[0].pass, false); assert.match(undecided.rows[0].misses[0], /change null/)
  assert.match(r.text, /hard: 2\/4; soft: 1\/1/)
})

test('u3: the second fresh set has sixteen turns nobody tuned on, none of them with an assistant message before it (the Claude path), two chunks of eight, the real-window sentence among them, the ceiling of each at most 12,000', () => {
  const chunks = buildNunchiFreshPlans()
  assert.deepEqual(chunks.map(c => c.plan.requests.length), [8, 8]); assert.ok(chunks.every(c => c.plan.tokenCeiling <= NUNCHI_CHUNK.tokenCeiling && c.plan.requests.every(r => r.recordOnly === true)))
  assert.equal(NUNCHI_FRESH_CONTROLS.filter(c => c.expect.change === true).length, 8); assert.equal(NUNCHI_FRESH_CONTROLS.filter(c => c.expect.change === false).length, 8)
  const earlier = new Set([...NUNCHI_CONTROLS, ...NUNCHI_MERGED_CONTROLS].map(c => c.user))
  assert.deepEqual(NUNCHI_FRESH_CONTROLS.filter(c => earlier.has(c.user)).map(c => c.id), ['f-too-long-from-now'].filter(id => earlier.has('너무 길어. 앞으로는 짧게 말해')), 'only the real-window sentence repeats an earlier turn (there it had an assistant message before it; here it has none)')
  for (const c of chunks) for (const f of c.files) assert.ok(JSON.parse(f.bytes).input[1].content.includes('There is no assistant message before the turn'), f.file)
  assert.deepEqual(chunks.flatMap(c => c.plan.requests.map(r => r.id)), NUNCHI_FRESH_CONTROLS.map(c => c.id)); assert.ok(chunks.every(c => c.plan.set.startsWith('nunchi-merge-v2-')))
})
