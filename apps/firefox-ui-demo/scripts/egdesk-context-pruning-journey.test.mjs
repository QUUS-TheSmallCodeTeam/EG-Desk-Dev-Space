// s2.no-repeat of the real all-on v3 run (int/c14 26c5b9f, 2026-11-25): the follow-up "방금 그 내용 정리해줘" got
// ontology:quote/a-decision AGAIN, delivered in the first turn. Cause: the context selection, not turn memory. It asked about all 12 records
// again and attached the one it scored 0.57 (its bar is 0.5). With the internal flag EGDESK_TURN_MEMORY_PRUNE_HELD=on the records the model
// holds unchanged are not asked about, so the second turn sends nothing already in the conversation.
// The relevance answers below are the real ones of that run, by catalog title (the mock answers the same title the same way whatever its
// index, so a shorter catalog gets the same verdicts). Everything else is the journey's scripted Decision model. Offline, no key.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runJourney, loadJourneyPlan, PLAN_FILE_V3, SAYS } from './egdesk-all-on-live-measure.mjs'
import { scriptedDecisions } from './egdesk-all-on.support.mjs'

const REAL = {
  [SAYS.quote]: { 'A사 견적 요청 접수': 1, 'A사 견적서 v1 발송': 1, 'A사 단가 협의 메모': 1, 'A사 견적서 v2 수정 계획': 0.36, 'A사 건 결정 메모': 1 },
  [SAYS.tidy]: { 'A사 견적 요청 접수': 0, 'A사 견적서 v1 발송': 0.01, 'A사 단가 협의 메모': 0.03, 'A사 견적서 v2 수정 계획': 0.01, 'A사 건 결정 메모': 0.57,
    'PostgreSQL 전환 설계': 0.11, 'PostgreSQL 마이그레이션 배포 계획': 0.06, '헬스체크 3종 체크리스트': 0.09, '현재 SQLite 스키마(운영)': 0.19,
    '배포 후 후속 체크리스트': 0.02, '롤백 절차': 0.03, '전환 벤치마크 결과': 0.01 },
}
const flat = c => (typeof c === 'string' ? c : c.map(p => p.text ?? '').join('\n'))

function transport() {
  const scripted = scriptedDecisions(), asked = []
  const fetchImpl = async (_url, init) => {
    const wire = JSON.parse(init.body), names = wire.questions.map(q => q.name)
    let answers = await scripted.answer(wire)
    if (names.includes('answer_type')) {
      const text = wire.input.map(m => flat(m.content)).join('\n'), message = text.slice(text.lastIndexOf('Message:\n') + 9).trim()
      const titles = Object.fromEntries([...text.matchAll(/^#(\d+) \| [^|]+ \| [^|]+ \| ([^|\n]+?)(?: \| |$)/gm)].map(m => [`rel_${m[1]}`, m[2].trim()]))
      asked.push({ message, titles: Object.values(titles), bytes: init.body.length })
      answers = answers.map(a => (/^rel_\d+$/.test(a.name) && titles[a.name] ? { ...a, probability: REAL[message]?.[titles[a.name]] ?? 0 } : a))
    }
    return new Response(JSON.stringify({ model: 'gpt-6-luna', answers, usage: { input_tokens: 10, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetchImpl, asked }
}
const plan = () => { const p = loadJourneyPlan(PLAN_FILE_V3); return { ...p, steps: p.steps.filter(s => s.id === 's1-first-turn' || s.id === 's2-follow-up') } }
const pagesOf = step => [...new Set(step.seen.packets.flatMap(p => p.pageIds))]

test('flag off (default): the follow-up asks about all 12 records again and re-sends the decision memo (the real s2.no-repeat)', async () => {
  const { fetchImpl, asked } = transport()
  const out = await runJourney({ plan: plan(), send: true, key: 'egd-synthetic-not-a-key-0019', fetchImpl })
  const [s1, s2] = out.steps
  assert.ok(pagesOf(s1).includes('ontology:quote/a-decision'))
  assert.equal(asked[1].message, SAYS.tidy)
  assert.equal(asked[1].titles.length, 12)
  assert.ok(pagesOf(s2).includes('ontology:quote/a-decision'))
  assert.equal(s2.checks.find(c => c.id === 's2.no-repeat')?.pass, false)
})

test('EGDESK_TURN_MEMORY_PRUNE_HELD=on: the follow-up is not asked about what the first turn sent, and nothing is sent again', async () => {
  const { fetchImpl, asked } = transport()
  const out = await runJourney({ plan: plan(), send: true, key: 'egd-synthetic-not-a-key-0019', fetchImpl, env: { EGDESK_TURN_MEMORY_PRUNE_HELD: 'on' } })
  const [s1, s2] = out.steps
  const first = pagesOf(s1)
  assert.equal(asked[0].titles.length, 12, 'the first turn holds nothing: same 12 candidates')
  // every record delivered in s1 (by the selection or by turn memory) is missing from the second catalog; the rest is still asked
  assert.equal(asked[1].titles.length, 12 - first.length)
  for (const title of ['A사 견적 요청 접수', 'A사 견적서 v1 발송', 'A사 단가 협의 메모', 'A사 건 결정 메모']) assert.ok(!asked[1].titles.includes(title), title)
  assert.ok(asked[1].bytes < asked[0].bytes)
  assert.deepEqual(pagesOf(s2).filter(id => first.includes(id)), [])
  assert.equal(s2.checks.find(c => c.id === 's2.no-repeat')?.pass, true)
})
