#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DECISION_MODEL } from '../helper/egdesk-decision-client.mjs'
import { independentEstimate } from '../helper/egdesk-decision-real-runner.mjs'
import { SPEECH_SPLIT_BARS, speechSegments, speechSplitQuestions } from '../helper/egdesk-speech-grounding.mjs'
import { SECOND_LABEL_RULES } from '../helper/egdesk-turn-memory.mjs'
import { NO, YES, clockLine } from '../helper/egdesk-wiki-reconstruction.mjs'
import { SENTENCES, STUDY_ASKED_AT } from '../helper/egdesk-utterance-threshold-study.mjs'
import { PREVIOUS_REPLY_CASES, triageBodyAfter } from './egdesk-previous-reply-plan.mjs'

// terse-record-v1 (L7 c23). PREPARED, NOT SENT: never sends, never reads a key. Four requests:
//   approval  "ㅇㅇ" after "… 계속 갈까요?" (L3 real case), triage with the previous message and the c23 courtesy sentence.
//             c26: tn_courtesy .66. HARD tn_courtesy <= .2. SOFT tn_record <= .2, tn_need <= .2.
//   praise    "좋다. 다음 진행" after "… OK면 … 8번 갑니다." (L3 real case), triage with the c23 record sentence.
//             c26: tn_record .95, courtesy .01, need .01. HARD tn_record <= .2, tn_courtesy <= .2, tn_need <= .2.
//   own-c10   guard "주문 내역을 보니 지난달 15일에 결제가 두 번 됐어." own v3 only (two-step second request shape). c26 v2: .16. HARD own <= .15.
//   own-c12   target "서버 응답이 느린 걸 보니 트래픽이 몰린 것 같아." own v3 only. c26 v2: .19. HARD own <= .15
//             (with guess 1.0 from c26 it installs inference; with record .97 from c23 c10 installs record_based in the split reading).
// The two triage texts are the person's own conversation (masked by L3): the plan is written OUTSIDE the repository.
//   usage: node scripts/egdesk-terse-record-plan.mjs <L3 mock-results.json> <out dir>
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const TRIAGE_EXPECT = {
  approval: [{ name: 'tn_courtesy', kind: 'predicate', max: NO, severity: 'hard', note: 'a yes to the assistant\'s yes/no question is an answer (c26: .66)' },
    { name: 'tn_record', kind: 'predicate', max: NO, severity: 'soft', note: 'a go-ahead is not a record by itself' },
    { name: 'tn_need', kind: 'predicate', max: NO, severity: 'soft', note: 'no stored page is about the slide deck' }],
  praise: [{ name: 'tn_record', kind: 'predicate', max: NO, severity: 'hard', note: 'the person only approves what the assistant proposed (c26: .95)' },
    { name: 'tn_courtesy', kind: 'predicate', max: NO, severity: 'hard', note: 'a go-ahead, not only praise (c26: .01)' },
    { name: 'tn_need', kind: 'predicate', max: NO, severity: 'hard', note: 'the next slide needs no stored page (c26: .01)' }],
}
export function ownRequest(id) {
  const s = SENTENCES.find(x => x.id === id), spans = speechSegments(s.text)
  const questions = speechSplitQuestions(spans, s.text, { wording: { other: 'v2', own: 'v3', guess: 'v2' } }).filter(q => q.name === 'speechs_own_0')
  return { model: DECISION_MODEL, input: [{ role: 'developer', content: SECOND_LABEL_RULES }, { role: 'user', content: `${clockLine(STUDY_ASKED_AT)}\nMessage:\n${s.text}` }], questions }
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('egdesk-terse-record-plan.mjs')) {
  const [examplesFile, outDir] = process.argv.slice(2)
  const examples = Object.values(JSON.parse(readFileSync(examplesFile, 'utf8'))).map(r => r.example).filter(e => e && PREVIOUS_REPLY_CASES[e.id])
  const requests = []
  const add = (id, body, expect) => {
    const bytes = Buffer.from(body, 'utf8'), wire = JSON.parse(body), file = `requests/${id}.json`
    mkdirSync(path.join(outDir, 'requests'), { recursive: true }); writeFileSync(path.join(outDir, file), bytes)
    requests.push({ id, file, sha256: sha(bytes), estInputTokens: independentEstimate(0, wire.questions.length, bytes.length), expect })
  }
  for (const e of examples) { const id = PREVIOUS_REPLY_CASES[e.id].id; add(id, await triageBodyAfter({ before: e.before, prev: e.prev, user: e.user }), TRIAGE_EXPECT[id]) }
  for (const [id, note] of [['c10', 'guard: read in the order history, not seen (c26 v2: .16)'], ['c12', 'target: the traffic is a conclusion, not seen (c26 v2: .19)']])
    add(`own-${id}`, JSON.stringify(ownRequest(id)), [{ name: 'speechs_own_0', kind: 'predicate', max: SPEECH_SPLIT_BARS.no, severity: 'hard', note }])
  const est = requests.reduce((n, r) => n + r.estInputTokens, 0)
  if (requests.length !== 4 || est > 5000) throw new Error(`${requests.length} requests, ${est} estimated tokens`)
  const bars = { yes: YES, no: NO, source: 'egdesk-wiki-reconstruction.mjs ternary YES / NO (.8 / .2)' }
  const plan = { set: 'terse-record-v1', tokenCeiling: 5000,
    productBars: { tn_courtesy: bars, tn_need: bars, tn_record: bars, 'speechs_own_#': { yes: SPEECH_SPLIT_BARS.yes, no: SPEECH_SPLIT_BARS.no, source: 'egdesk-speech-grounding.mjs SPEECH_SPLIT_BARS (.85 / .15)' } },
    passRule: 'Every hard check passes. The triage bodies are the product\'s (lane L2 all-on world, EGDESK_TURN_MEMORY_PREVIOUS_REPLY=on) after L3\'s real assistant messages; the own requests are the two-step second request with own v3 only.',
    requests }
  writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n')
  console.log(`written: ${requests.map(r => `${r.id}:${r.estInputTokens}`).join(' ')}, est ${est} of 5000 -> ${outDir}`)
}
