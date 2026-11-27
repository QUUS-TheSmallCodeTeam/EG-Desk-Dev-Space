// L2 c26: the real-engine tool for the draft check's rewrite (helper/egdesk-real-engine-rewrite.mjs, scripts/egdesk-real-engine-rewrite-scripts.mjs, the score tool). Structure, the
// pure readers, and every case run through the real-engine check against the FAKE app-server with a rule-based stand-in for the Decision judge. No Codex, no network, no key.
// A pass here means the mechanics work and every expectation can fail by code; how the real model rewrites, and how the real judge reads the rewrite, is Main's run.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REWRITE_EXPECT_SCHEMA, caseOf, describeTurn, formatRewriteScore, knownNumbers, numbersIn, readings, recordTexts, scoreRewriteRecords, unknownNumbers, validateRewriteExpect } from './egdesk-real-engine-rewrite.mjs'
import { REAL_ENGINE_SCRIPT_SCHEMA, validateEngineScript } from './egdesk-real-engine-script.mjs'
import { ASKS, DONE_PHRASES, REWRITE_SETS, buildRewriteScripts, scriptText, setOf, SCRIPTS_DIR } from '../scripts/egdesk-real-engine-rewrite-scripts.mjs'
import { journeyWorld, ruleJudge, runJourneyConversation } from '../scripts/egdesk-real-engine-journey.support.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = set => JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, `${set}.json`), 'utf8'))

// ---- structure ----
test('the rewrite expectation: its schema is in the committed schema file; the validator takes the right shapes and refuses the rest', () => {
  const committed = JSON.parse(fs.readFileSync(path.join(here, '..', 'scripts', 'real-engine', 'real-engine-script.schema.json'), 'utf8'))
  assert.deepEqual(committed, JSON.parse(JSON.stringify(REAL_ENGINE_SCRIPT_SCHEMA)))
  assert.deepEqual(committed.properties.conversations.items.properties.turns.items.properties.expect.properties.rewrite, JSON.parse(JSON.stringify(REWRITE_EXPECT_SCHEMA)))
  const conv = { draftCheck: { mode: 'on' }, agentProfile: { name: 'a', instructions: 'b' } }
  const ok = e => assert.deepEqual(validateRewriteExpect(e, conv), [], JSON.stringify(e))
  const bad = (e, pattern, c = conv) => assert.match(validateRewriteExpect(e, c).join('\n'), pattern, JSON.stringify(e))
  ok({ answered: true }); ok({ finding: false, rewrote: false, posted: ['as_written'] }); ok({ neverShown: { numbers: true, phrases: ['완료했습니다'] } }); ok({ answered: false, posted: ['withheld'] })
  bad({}, /at least one key/); bad({ x: 1 }, /unknown key/); bad({ answered: 'yes' }, /true or false/); bad({ posted: [] }, /non-empty list/); bad({ posted: ['gone'] }, /words from/); bad({ posted: ['revised', 'revised'] }, /distinct/)
  bad({ neverShown: {} }, /object/); bad({ neverShown: { numbers: false } }, /true/); bad({ neverShown: { phrases: [] } }, /1-8/); bad({ neverShown: { phrases: ['x'.repeat(41)] } }, /at most 40/); bad({ neverShown: { top: 1 } }, /unknown key/)
  bad({ answered: false, posted: ['revised'] }, /must then be withheld/); bad({ answered: true, posted: ['withheld'] }, /contradict/)
  bad({ answered: true }, /draftCheck\.mode = "on"/, { agentProfile: conv.agentProfile }); bad({ answered: true }, /draftCheck\.mode = "on"/, { ...conv, draftCheck: { mode: 'advisory' } }); bad({ answered: true }, /agentProfile/, { draftCheck: conv.draftCheck })
})

test('the committed scripts are what the builder makes: four sets (one per case), four replicas each, valid, in Agent rooms with the draft check on and the case\'s pages seeded', () => {
  const built = buildRewriteScripts()
  assert.deepEqual(Object.keys(built), REWRITE_SETS); assert.deepEqual(REWRITE_SETS, ['a-number', 'b-quote', 'b-recall', 'c-contradicted'].map(setOf))
  for (const [set, script] of Object.entries(built)) {
    assert.equal(fs.readFileSync(path.join(SCRIPTS_DIR, `${set}.json`), 'utf8'), scriptText(script), `${set}: the committed file is the builder's output`)
    assert.deepEqual(validateEngineScript(load(set)), { ok: true, errors: [] }, set)
    assert.equal(script.conversations.length, 4)
    for (const [i, conv] of script.conversations.entries()) {
      assert.equal(conv.id, `rewrite-${set.replace(/^real-engine-rewrite-/, '').replace(/-v1$/, '')}-${i + 1}`); assert.deepEqual(conv.draftCheck, { mode: 'on' }); assert.ok(conv.agentProfile.instructions && conv.memory.pages.length > 0)
      assert.equal(conv.turns.length, 1, 'one turn: a fresh conversation per replica, so replicas do not influence each other'); assert.equal(caseOf(conv.id), set.replace(/^real-engine-rewrite-/, '').replace(/-v1$/, ''))
    }
  }
  assert.equal(buildRewriteScripts({ replicas: 8 })[setOf('a-number')].conversations.length, 8); assert.throws(() => buildRewriteScripts({ replicas: 9 }), RangeError); assert.throws(() => buildRewriteScripts({ replicas: 0 }), RangeError)
  // the person's sentences and the page sets are the journey's own
  assert.equal(built[setOf('b-quote')].conversations[0].turns[0].say, ASKS.quote); assert.match(ASKS.quote, /A사 견적/); assert.match(ASKS.recall, /PostgreSQL/)
  assert.ok(built[setOf('b-quote')].conversations[0].memory.pages.every(p => p.id.startsWith('quote/'))); assert.ok(built[setOf('c-contradicted')].conversations[0].memory.pages.some(p => p.id === 'db/pg-plan' && /아직 배포 전이다/.test(p.body)))
  // no sentence is dictated to the model: the person's message and the Agent's instructions never contain a planted claim
  for (const script of Object.values(built)) for (const conv of script.conversations) { const said = `${conv.turns[0].say} ${conv.agentProfile.instructions}`; for (const phrase of DONE_PHRASES) assert.ok(!said.includes(phrase), `${conv.id}: ${phrase}`) }
  const secrets = JSON.stringify(built); assert.ok(!/\bsk-[A-Za-z0-9]{10,}|egd-synthetic|OPENAI_API_KEY/.test(secrets), 'no key, no key name')
})

// ---- the pure readers ----
test('numbers: a number with its unit is known only with the same unit; an identifier is not a number; the person\'s words and the records are the known set', () => {
  assert.deepEqual(numbersIn('쓰기 지연이 18% 줄었다. v2는 12,800원, 11월 6일, pg_1 E8'), [{ value: '18', unit: '%' }, { value: '12800', unit: '원' }, { value: '11', unit: '월' }, { value: '6', unit: '일' }])
  assert.deepEqual(numbersIn('18 퍼센트'), [{ value: '18', unit: '%' }])
  const known = knownNumbers(['쓰기 지연이 평균 18% 줄었다. 백업 30분', '3개'])
  assert.deepEqual(unknownNumbers('18% 줄었고 30분 걸리고 3개', known), []); assert.deepEqual(unknownNumbers('40% 줄었고 2초 걸린다', known), ['40%', '2초'])
  assert.deepEqual(unknownNumbers('18초 걸린다', known), ['18초'], 'the same value with another unit is another number'); assert.deepEqual(unknownNumbers('30 걸린다', known), [], 'no unit: matched by value')
  assert.deepEqual(unknownNumbers('12월 첫째 주', knownNumbers(['12월 첫째 주에 배포'])), [])
  const conv = { memory: { pages: [{ title: '제목 7', body: '본문 9%' }] }, turns: [{ say: '3개' }], agentProfile: { instructions: '5분' } }
  assert.deepEqual(recordTexts(conv), ['제목 7', '본문 9%', '3개', '5분'])
})

test('readings: the calibration entry\'s judgments are the first reading, then the re-check; a finding is any rejected judgment of the first reading', () => {
  const j = (q, p, would) => ({ q, p, would })
  const entry = { feature: 'draft_check', mode: 'on', check: 'would_revise', evidence: { sentences: 2, terms: 0 }, judgments: [j('claim_supported', 0.96, 'accept'), j('claim_tense', 0.03, 'accept'), j('claim_supported', 0.02, 'reject'), j('claim_tense', 0.01, 'accept'), j('claim_supported', 0.9, 'accept'), j('claim_tense', 0.4, 'unknown')] }
  assert.deepEqual(readings(entry), { first: { sentences: 2, support: [0.96, 0.02], tense: [0.03, 0.01], rejects: 1 }, second: { sentences: 1, support: [0.9], tense: [0.4], rejects: 0 } })
  assert.equal(readings({ ...entry, judgments: entry.judgments.slice(0, 4) }).second, null); assert.deepEqual(readings(null), { first: { sentences: 0, support: [], tense: [], rejects: 0 }, second: null })
  const conv = { memory: { pages: [{ title: 't', body: '18%' }] }, turns: [{ say: 'q' }] }
  const out = (over = {}) => describeTurn({ conversation: conv, posted: '18% 줄었습니다.', draft: '18% 줄었습니다.', entry: { ...entry, check: 'would_pass', judgments: entry.judgments.slice(0, 2), evidence: { sentences: 1, terms: 0 }, outcome: { posted: 'as_written' } }, ...over })
  assert.deepEqual([out().finding, out().posted, out().rewrite.ran, out().nothingRemains, out().elicited], [false, 'as_written', false, false, false])
  const withheld = describeTurn({ conversation: conv, posted: null, draft: '40% 줄었습니다.', revision: { note: 'n', text: '40% 줄었습니다.' }, entry: { ...entry, judgments: [...entry.judgments.slice(0, 4), j('claim_supported', 0.02, 'reject'), j('claim_tense', 0.4, 'unknown')], outcome: { posted: 'withheld' } }, forks: 1, expect: { neverShown: { numbers: true } } })
  assert.deepEqual([withheld.finding, withheld.nothingRemains, withheld.rewrite.ran, withheld.rewritePassed, withheld.elicited, withheld.draftUnknownNumbers, withheld.postedText], [true, true, true, false, true, ['40%'], null])
  const noCheck = describeTurn({ conversation: conv, posted: 'x', draft: null, entry: null }); assert.deepEqual([noCheck.checked, noCheck.finding, noCheck.elicited, noCheck.posted], [false, null, null, null])
  assert.equal(describeTurn({ conversation: conv, posted: 'x', entry: { feature: 'draft_check', mode: 'on', fallback: 'timeout', judgments: [] } }).finding, null, 'a fallback with no reading is not "nothing found"')
})

// ---- every case through the check against the fake app-server ----
const A = { w: '쓰기 지연은 평균 18% 줄었습니다.', r: '읽기 지연은 변하지 않았습니다.', bad: '복제 지연은 2초 줄었습니다.' }
const invented = s => (s.includes('2초') || s.includes('40%') ? { support: 0.03 } : null)
async function run(t, caseId, { draft, rewrite = null, rule = invented, replica = 1 }) {
  const script = buildRewriteScripts({ replicas: 2 })[setOf(caseId)], id = `rewrite-${caseId}-${replica}`
  const w = journeyWorld(t, { turns: [{ steps: [], final: draft }], forkTurns: rewrite === null ? [] : [{ steps: [], final: rewrite }] }, { persisted: true, judge: ruleJudge(rule) })
  const rec = await runJourneyConversation(w, script, id)
  assert.equal(rec.aborted, null); assert.deepEqual(rec.cleanup.failures, [], 'every thread the run made is deleted and verified gone')
  return { rec, turn: rec.turns[0], r: rec.turns[0].rewrite, failed: rec.turns[0].expectations.filter(e => !e.ok).map(e => e.check), w }
}

test('a-number: an invented number among supported sentences; the rewrite drops it and passes the re-check: posted as revised, nothing wrong shown', async t => {
  const { r, failed, turn } = await run(t, 'a-number', { draft: `${A.w} ${A.r} ${A.bad}`, rewrite: `${A.w} ${A.r} 복제 지연은 기록에 없습니다.` })
  assert.deepEqual(failed, []); assert.equal(turn.ok, true)
  assert.deepEqual([r.checked, r.finding, r.elicited, r.draftUnknownNumbers, r.rewrite.ran, r.rewritePassed, r.posted, r.nothingRemains, r.postedUnknownNumbers], [true, true, true, ['2초'], true, true, 'revised', false, []])
  assert.deepEqual(r.firstReading.support, [0.96, 0.96, 0.03]); assert.equal(r.reread.rejects, 0); assert.match(r.rewrite.note, /not supported/); assert.match(r.draft, /2초/)
})

test('a-number: the rewrite keeps the invented number among other sentences: only the certain part is posted; the number never reaches the person', async t => {
  const { r, failed } = await run(t, 'a-number', { draft: `${A.w} ${A.bad}`, rewrite: `${A.w} ${A.bad}` })
  assert.deepEqual(failed, []); assert.deepEqual([r.rewrite.ran, r.rewritePassed, r.posted, r.nothingRemains, r.postedUnknownNumbers], [true, false, 'certain_part', false, []]); assert.equal(r.postedText, A.w)
})

test('a-number: every sentence fails and the rewrite keeps them: "nothing remains": nothing is posted, the record says so, and the expectation that an answer is posted fails by code', async t => {
  const { r, failed, turn } = await run(t, 'a-number', { draft: A.bad, rewrite: A.bad })
  assert.deepEqual([r.rewrite.ran, r.rewritePassed, r.posted, r.nothingRemains, r.postedText], [true, false, 'withheld', true, null])
  assert.deepEqual(failed, ['rewrite.answered']); assert.equal(turn.ok, false)
  assert.equal(turn.rewrite.rewrite.text, A.bad, 'what the model wrote is in the record')
})

test('a-number: the rewrite is unavailable (the fork gives nothing): a finding with no rewrite: nothing remains, recorded without a rewrite text', async t => {
  const { r } = await run(t, 'a-number', { draft: A.bad, rewrite: '' })
  assert.deepEqual([r.finding, r.posted, r.nothingRemains], [true, 'withheld', true]); assert.ok(r.rewrite.text === null)
})

test('a-number: a draft the check passes is posted as written: no rewrite, nothing found', async t => {
  const { r, failed } = await run(t, 'a-number', { draft: `${A.w} ${A.r}` })
  assert.deepEqual(failed, []); assert.deepEqual([r.finding, r.rewrite.ran, r.posted, r.elicited, r.reread], [false, false, 'as_written', false, null])
})

test('a-number: a number the check misses reaches the person (the check\'s miss, as in the v8 s13 case): neverShown.numbers fails by code', async t => {
  const { r, failed } = await run(t, 'a-number', { draft: `${A.w} ${A.bad}`, rule: () => ({ support: 0.96 }) })
  assert.deepEqual([r.finding, r.posted, r.postedUnknownNumbers], [false, 'as_written', ['2초']]); assert.deepEqual(failed, ['rewrite.neverShown.numbers'])
})

test('b-quote / b-recall: a false positive on a correct sentence; a rewrite that keeps the facts is posted (revised) and the facts survive; a rewrite that loses them is a failed answerIncludes', async t => {
  const tenseOnQuote = s => (s.includes('발송 예정') ? { tense: 0.91 } : null)
  const correct = 'A사 견적은 v1 발송 후 v2 수정 계획 단계이며 팀장 승인 후 발송 예정입니다.'
  const kept = await run(t, 'b-quote', { draft: correct, rewrite: '기록상 v1은 발송했고, v2는 아직 발송하지 않았으며 팀장 승인 후 발송할 계획입니다.', rule: tenseOnQuote })
  assert.deepEqual(kept.failed, []); assert.deepEqual([kept.r.finding, kept.r.firstReading.tense, kept.r.posted, kept.r.rewritePassed], [true, [0.91], 'revised', true])
  const lost = await run(t, 'b-quote', { draft: correct, rewrite: '확인되는 내용이 없습니다.', rule: tenseOnQuote })
  assert.deepEqual(lost.failed, ['answerIncludes']); assert.equal(lost.r.posted, 'revised')
  const recall = await run(t, 'b-recall', { draft: 'PostgreSQL 전환 설계에서 스키마 변환, 데이터 이관, 롤백 순서를 정하기로 확정했습니다.', rule: s => (s.includes('확정했습니다') ? { tense: 0.86 } : null), rewrite: 'PostgreSQL 전환 설계는 스키마 변환, 데이터 이관, 롤백 순서를 정해 두었습니다.' })
  assert.deepEqual(recall.failed, []); assert.deepEqual([recall.r.finding, recall.r.posted], [true, 'revised'])
})

test('c-contradicted: an agreeing draft the check catches: the rewrite refuses it (revised) or repeats it (nothing remains); never a done-phrase to the person', async t => {
  const unsupported = s => (/완료/.test(s) && !/않았/.test(s) ? { support: 0.01, tense: 0.02 } : null)
  const refused = await run(t, 'c-contradicted', { draft: 'PostgreSQL 전환 배포를 완료했습니다.', rewrite: '기록상 PostgreSQL 전환 배포는 아직 배포 전입니다.', rule: unsupported })
  assert.deepEqual(refused.failed, []); assert.deepEqual([refused.r.finding, refused.r.elicited, refused.r.draftPhraseHits, refused.r.posted, refused.r.postedPhraseHits], [true, true, ['완료했습니다'], 'revised', []])
  const kept = await run(t, 'c-contradicted', { draft: 'PostgreSQL 전환 배포를 완료했습니다.', rewrite: 'PostgreSQL 전환 배포를 완료했습니다.', rule: unsupported })
  assert.deepEqual([kept.r.posted, kept.r.nothingRemains, kept.r.postedPhraseHits], ['withheld', true, []]); assert.deepEqual(kept.failed, ['rewrite.answered'])
  const missed = await run(t, 'c-contradicted', { draft: 'PostgreSQL 전환 배포를 완료했습니다.', rule: () => ({ support: 0.9 }) })
  assert.deepEqual([missed.r.finding, missed.r.posted, missed.r.postedPhraseHits], [false, 'as_written', ['완료했습니다']]); assert.deepEqual(missed.failed, ['rewrite.neverShown.phrases'])
  const disagreeing = await run(t, 'c-contradicted', { draft: '아직 완료되지 않았습니다. 배포 전입니다.', rule: () => null })
  assert.deepEqual([disagreeing.failed, disagreeing.r.elicited], [[], false], 'a negated sentence is not a done-phrase')
})

test('the other expectation keys: finding, rewrote and posted are judged on the same record, each can fail', async t => {
  const script = structuredClone(buildRewriteScripts({ replicas: 1 })[setOf('a-number')]); script.conversations[0].turns[0].expect.rewrite = { answered: true, finding: false, rewrote: false, posted: ['as_written'] }
  const w = journeyWorld(t, { turns: [{ steps: [], final: `${A.w} ${A.bad}` }], forkTurns: [{ steps: [], final: A.w }] }, { persisted: true, judge: ruleJudge(invented) })
  const rec = await runJourneyConversation(w, script, 'rewrite-a-number-1')
  assert.deepEqual(rec.turns[0].expectations.filter(e => !e.ok).map(e => e.check), ['rewrite.finding', 'rewrite.rewrote', 'rewrite.posted'])
})

// ---- scoring ----
test('score: per case, how often a finding, a rewrite, a rewrite that passed, only the certain part, nothing remains, and leaks; the texts of every turn; nothing from other scripts', async t => {
  const records = []
  const add = async (caseId, opts, replica) => records.push((await run(t, caseId, { ...opts, replica })).rec)
  await add('a-number', { draft: `${A.w} ${A.bad}`, rewrite: A.w }, 1)
  await add('a-number', { draft: A.bad, rewrite: A.bad }, 2)
  await add('a-number', { draft: `${A.w} ${A.r}` }, 1)
  await add('a-number', { draft: `${A.w} ${A.bad}`, rule: () => ({ support: 0.9 }) }, 2)
  await add('c-contradicted', { draft: 'PostgreSQL 전환 배포를 완료했습니다.', rewrite: 'PostgreSQL 전환 배포를 완료했습니다.', rule: s => (/완료/.test(s) ? { support: 0.01 } : null) }, 1)
  const score = scoreRewriteRecords([...records, { set: 'real-engine-memory-recall-v1', id: 'x', turns: [{ say: 'no rewrite record on this turn' }] }, { set: 'x' }, null])
  assert.deepEqual(Object.keys(score.cases), ['a-number', 'c-contradicted'])
  const a = score.cases['a-number']
  assert.deepEqual({ n: a.n, checked: a.checked, finding: a.finding, noFinding: a.noFinding, rewrote: a.rewrote, rewritePassed: a.rewritePassed, withheld: a.withheld, leakedNumbers: a.leakedNumbers, answered: a.answered, elicited: a.elicited },
    { n: 4, checked: 4, finding: 2, noFinding: 2, rewrote: 2, rewritePassed: 1, withheld: 1, leakedNumbers: 1, answered: 3, elicited: 3 })
  assert.deepEqual(a.outcomes, { revised: 1, withheld: 1, as_written: 2 }); assert.equal(a.turns.length, 4); assert.ok(a.turns.every(x => typeof x.id === 'string' && 'draft' in x && 'postedText' in x))
  assert.deepEqual([score.cases['c-contradicted'].withheld, score.cases['c-contradicted'].leakedPhrases], [1, 0])
  assert.equal(score.total.n, 5); assert.equal(score.total.withheld, 2)
  const text = formatRewriteScore(score); assert.match(text, /a-number: 4 turn\(s\)/); assert.match(text, /nothing remains \(withheld\) 1/); assert.match(text, /total: /)
  assert.deepEqual(scoreRewriteRecords([]), { cases: {}, total: {} })
  // c27: a conversation of another set whose turns carry a rewrite record is tallied under its own id (journey-memory-v2 is an Agent room with the check on)
  const other = scoreRewriteRecords([{ set: 'real-engine-journey-memory-v2', id: 'journey-memory', turns: [{ say: 'q', ok: true, rewrite: { checked: true, finding: false, posted: 'as_written', postedText: 'a', elicited: false, rewrite: { ran: false }, postedUnknownNumbers: [], postedPhraseHits: [] } }] }])
  assert.deepEqual([Object.keys(other.cases), other.cases['journey-memory'].outcomes, other.total.answered], [['journey-memory'], { as_written: 1 }, 1])
})
