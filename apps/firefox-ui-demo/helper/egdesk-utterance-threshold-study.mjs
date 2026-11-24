import { createHash } from 'node:crypto'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { independentEstimate } from './egdesk-decision-real-runner.mjs'
import { SPEECH_THRESHOLDS, speechSegments } from './egdesk-speech-grounding.mjs'
import { judgeTurnWrite } from './egdesk-turn-memory.mjs'

// PREPARED, NOT SENT. The utterance-axis threshold study: how often would an installed speech label (source / form / time of one
// sentence) be wrong at each candidate confidence bar? Today's bar is SPEECH_THRESHOLDS (confidence 0.85, margin 0.20); the 11/24
// measurement could support a lower bar only with 6 distinct sentences. This study: 60 independent one-sentence messages, 16 of them
// deliberately ambiguous, each its own request built by the product (judgeTurnWrite, 'about' design, no stored record: the same call
// that labels an utterance in the product, the same body shape as the 11/24 u1-u3 requests). Public synthetic Korean, no real person.
// The labels below are fixed BEFORE anything is sent; labels.json carries them with their hash, and every chunk plan cites that hash.
export const STUDY_SET = 'utterance-threshold-v1'
export const STUDY_DIR = 'proofs/decision-real-measure/utterance-threshold'
export const STUDY_ASKED_AT = Date.parse('2026-11-27T10:00:00+09:00')
export const STUDY_CHUNK_CEILING = 12000
export const STUDY_CHUNKS = 8
export const CANDIDATE_BARS = Object.freeze([0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95])
export const AXES = Object.freeze(['source', 'form', 'time'])
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

export const LABEL_RULES = Object.freeze([
  'L1 A label is judged against the option descriptions the product sends (helper/egdesk-speech-grounding.mjs axes), for the one sentence alone, with the request clock 2026-11-27 10:00 KST.',
  'L2 Each sentence has, per axis, a set of ALLOWED labels: every label the option descriptions admit for that sentence. When two labels both fit, both are allowed. "unknown" is always tolerated: the product never installs it.',
  'L3 An axis whose allowed set is only ["unknown"] is deliberately ambiguous (mixed basis, conflicting times, mixed form): installing ANY label there is a wrong install.',
  'L4 source: own seeing, hearing or doing = self_reported_observation; credited to a named or implied other person/team = attributed_report; a conclusion ("~것 같아", "~걸 보니", "아마") = inference; a cited record, log, mail, memo, notice or document = record_based; a bare claim, a plan or a question with no basis given = unspecified.',
  'L5 form: claim = assertion; intention, proposal, commitment or instruction = plan; "~면" contingency = conditional (and plan when the conditional itself proposes an action); request for information = question.',
  'L6 time: a stated absolute or relative anchor (어제, 방금, 지난주 화요일, 다음 달) = *_anchored; an approximate anchor ("내일쯤", "어제인가 그저께인가") also allows *_unspecified; "지금" = at_utterance; explicitly ongoing ("요즘 계속", "3년째 ~고 있어") = ongoing_no_end; a sentence that places two events at different times is ambiguous (L3).',
  'L7 tw_status (soft only, not part of the threshold question): done / plan / corrected as the sentence states; unknown when it states no state.',
  'L8 The labels were written by one analyst (lane L6) before any request was built or sent. The owner may change them BEFORE the first chunk is sent (the hash then changes and the plans are rebuilt); after the first send they are frozen.',
  'L9 Unit of independence: the sentence. Axes of one sentence are not independent of each other; rates are reported per install AND per sentence (a sentence counts once if any of its installs is wrong).',
])

const U = 'unknown'
// [id, text, source[], form[], time[], status[]]; ids a* are the deliberately ambiguous ones.
export const SENTENCES = Object.freeze([
  ['c01', '어제 오후에 3층 회의실 프로젝터가 꺼져 있는 걸 내가 봤어.', ['self_reported_observation'], ['assertion'], ['past_anchored'], [U]],
  ['c02', '민지 씨가 그러는데 어제 배포는 문제없이 끝났대.', ['attributed_report'], ['assertion'], ['past_anchored'], ['done']],
  ['c03', '로그에 오늘 새벽 2시에 백업이 끝났다고 찍혀 있어.', ['record_based'], ['assertion'], ['past_anchored'], ['done']],
  ['c04', '다음 주 화요일에 고객사에 견적서를 보낼게.', ['unspecified'], ['plan'], ['future_anchored'], ['plan']],
  ['c05', '비가 오면 금요일 행사는 실내에서 할 거야.', ['unspecified'], ['conditional', 'plan'], ['future_anchored'], ['plan', U]],
  ['c06', '어제 회의에서 예산 얘기 나왔어?', ['unspecified'], ['question'], ['past_anchored'], [U]],
  ['c07', '요즘 계속 빌드가 느려.', ['self_reported_observation', 'unspecified'], ['assertion'], ['ongoing_no_end'], [U]],
  ['c08', '지금 사내 위키에 접속이 안 돼.', ['self_reported_observation', 'unspecified'], ['assertion'], ['at_utterance'], [U]],
  ['c09', '언젠가 문서 정리를 한 번 해야겠어.', ['unspecified'], ['plan'], ['future_unspecified'], ['plan']],
  ['c10', '주문 내역을 보니 지난달 15일에 결제가 두 번 됐어.', ['record_based'], ['assertion'], ['past_anchored'], [U, 'done']],
  ['c11', '팀장님 말로는 지난주 금요일에 계약서에 서명했대.', ['attributed_report'], ['assertion'], ['past_anchored'], ['done']],
  ['c12', '서버 응답이 느린 걸 보니 트래픽이 몰린 것 같아.', ['inference'], ['assertion'], ['at_utterance', 'past_unspecified'], [U]],
  ['c13', '내일 오전 10시에 점검 회의를 하자.', ['unspecified'], ['plan'], ['future_anchored'], ['plan']],
  ['c14', '보고서 초안은 내가 방금 다 썼어.', ['self_reported_observation'], ['assertion'], ['past_anchored'], ['done']],
  ['c15', '택배가 언제 도착해?', ['unspecified'], ['question'], ['future_unspecified'], [U]],
  ['c16', '회의록에 따르면 지난 회의에서 출시일을 정했어.', ['record_based'], ['assertion'], ['past_anchored', 'past_unspecified'], ['done', U]],
  ['c17', '그 버그는 내가 고쳤어.', ['self_reported_observation'], ['assertion'], ['past_unspecified'], ['done']],
  ['c18', '수빈 씨한테 들었는데 프린터가 또 고장 났대.', ['attributed_report'], ['assertion'], ['past_unspecified'], [U]],
  ['c19', '만약 오늘 안에 승인이 안 나면 출시를 미루자.', ['unspecified'], ['conditional', 'plan'], ['future_anchored', 'future_unspecified'], ['plan', U]],
  ['c20', '다음 달부터 매주 월요일에 주간 보고를 올릴게.', ['unspecified'], ['plan'], ['future_anchored'], ['plan']],
  ['c21', '지난주 화요일에 고객 문의가 평소의 두 배였어.', ['unspecified'], ['assertion'], ['past_anchored'], [U]],
  ['c22', '메일 보니까 견적 회신이 이미 와 있어.', ['record_based'], ['assertion'], ['past_unspecified', 'at_utterance'], ['done', U]],
  ['c23', '아마 내일쯤 비가 올 것 같아.', ['inference'], ['assertion'], ['future_anchored', 'future_unspecified'], [U]],
  ['c24', '이번 주 안에 계약서 검토를 끝낼 계획이야.', ['unspecified'], ['plan'], ['future_anchored'], ['plan']],
  ['c25', '점심 먹으러 갈래?', ['unspecified'], ['question', 'plan'], ['future_unspecified', 'at_utterance'], [U, 'plan']],
  ['c26', '작년 이맘때도 서버가 한 번 크게 멈췄었어.', ['unspecified'], ['assertion'], ['past_anchored'], [U]],
  ['c27', '센서 기록을 확인했는데 창고 온도가 밤새 30도를 넘었어.', ['record_based', 'self_reported_observation'], ['assertion'], ['past_anchored'], [U]],
  ['c28', '재고가 줄어드는 속도를 보면 다음 주면 다 떨어지겠어.', ['inference'], ['assertion'], ['future_anchored'], [U]],
  ['c29', '고객센터 운영 시간을 바꾸는 건 어때?', ['unspecified'], ['question', 'plan'], ['future_unspecified'], [U, 'plan']],
  ['c30', '우리 팀은 3년째 같은 배포 도구를 쓰고 있어.', ['unspecified'], ['assertion'], ['ongoing_no_end'], [U]],
  ['c31', '공지 게시판에 어제 정전이 있었다고 올라와 있어.', ['record_based'], ['assertion'], ['past_anchored'], [U]],
  ['c32', '방금 고객한테 전화해서 일정을 확인했어.', ['self_reported_observation'], ['assertion'], ['past_anchored'], ['done']],
  ['c33', '다음 주에 휴가 쓸 수 있을까?', ['unspecified'], ['question'], ['future_anchored'], [U]],
  ['c34', '내가 보기엔 이 디자인이 더 읽기 쉬워.', ['inference', 'self_reported_observation'], ['assertion'], ['at_utterance'], [U]],
  ['c35', '협력사 담당자가 납품을 어제 마쳤다고 전해 왔어.', ['attributed_report'], ['assertion'], ['past_anchored'], ['done']],
  ['c36', '시험 결과가 좋으면 다음 달에 정식으로 출시하자.', ['unspecified'], ['conditional', 'plan'], ['future_anchored'], ['plan', U]],
  ['c37', '오늘 아침부터 메신저 알림이 안 와.', ['self_reported_observation', 'unspecified'], ['assertion'], ['ongoing_no_end', 'at_utterance'], [U]],
  ['c38', '회의실 예약은 내가 아까 해 뒀어.', ['self_reported_observation'], ['assertion'], ['past_anchored'], ['done']],
  ['c39', '이번 달 매출이 지난달보다 줄었다는 보고서를 읽었어.', ['record_based'], ['assertion'], ['past_unspecified', 'past_anchored'], [U]],
  ['c40', '혹시 그 파일 어디에 저장했는지 알아?', ['unspecified'], ['question'], ['past_unspecified'], [U]],
  ['c41', '예전에 이 방식으로 해 봤는데 잘 안 됐어.', ['self_reported_observation'], ['assertion'], ['past_unspecified', 'past_anchored'], [U]],
  ['c42', '출입 기록상으로는 그날 밤 아무도 사무실에 없었어.', ['record_based'], ['assertion'], ['past_anchored', 'past_unspecified'], [U]],
  ['c43', '다들 바쁘면 이번 회식은 다음으로 미루자.', ['unspecified'], ['conditional', 'plan'], ['future_unspecified'], ['plan', U]],
  ['c44', '인사팀에서 연말 정산 서류를 이번 주 금요일까지 내래.', ['attributed_report'], ['assertion'], ['future_anchored'], [U]],
  ['a01', '회의가 취소됐다고 들은 것 같기도 하고 메일에서 본 것 같기도 해.', [U], ['assertion'], ['past_unspecified'], [U]],
  ['a02', '그거 끝냈나 아니 끝냈을 거야.', ['inference'], [U], ['past_unspecified'], ['done', U]],
  ['a03', '금요일에 배포해.', ['unspecified'], ['plan', 'assertion'], ['future_anchored'], ['plan', U]],
  ['a04', '어제인가 그저께인가 서버가 한 번 멈췄어.', ['unspecified', 'self_reported_observation'], ['assertion'], ['past_anchored', 'past_unspecified'], [U]],
  ['a05', '그 건은 처리된 걸로 알고 있어.', ['unspecified', 'inference'], ['assertion'], ['past_unspecified'], ['done', U]],
  ['a06', '비가 왔으면 행사를 미뤘을 텐데 안 미뤘네.', ['inference', 'unspecified'], [U], ['past_unspecified'], [U]],
  ['a07', '지금쯤이면 도착했겠지.', ['inference'], ['assertion'], ['at_utterance', 'past_unspecified'], [U]],
  ['a08', '계속 이렇게 하면 되나.', ['unspecified'], ['question'], [U], [U]],
  ['a09', '민수 씨가 한다고 했는데 결국 내가 하기로 했어.', [U], ['assertion', 'plan'], [U], ['plan', U]],
  ['a10', '다음 주였나 이번 주였나 점검이 있대.', ['attributed_report'], ['assertion'], ['future_unspecified'], [U]],
  ['a11', '그때 말한 대로 해 줘.', ['unspecified'], [U, 'plan'], [U, 'future_unspecified'], [U]],
  ['a12', '그 회의 오늘이야, 아니 내일이었나.', ['unspecified'], [U], [U], [U]],
  ['a13', '요즘은 괜찮은데 어제는 또 느렸어.', ['unspecified', 'self_reported_observation'], ['assertion'], [U], [U]],
  ['a14', '다 됐다고 하던데 내가 보기엔 아직이야.', [U], ['assertion'], ['at_utterance', U], [U]],
  ['a15', '보고서를 보냈다는 건지 보낸다는 건지 모르겠어.', ['unspecified'], ['assertion'], [U], [U]],
  ['a16', '내일 비 오면 오늘 했어야 했나 싶어.', ['unspecified', 'inference'], [U], [U], [U]],
].map(([id, text, source, form, time, status]) => Object.freeze({ id, text, ambiguous: id.startsWith('a'), allowed: Object.freeze({ source, form, time, status }) })))

/** labels.json: the rules and every allowed set, fixed before sending. */
export function labelsFile() {
  const body = { set: STUDY_SET, fixedBefore: 'any request of this set was sent', rules: LABEL_RULES, productBar: { confidence: SPEECH_THRESHOLDS.confidence, margin: SPEECH_THRESHOLDS.margin },
    candidateBars: CANDIDATE_BARS, sentences: SENTENCES.map(s => ({ id: s.id, text: s.text, ambiguous: s.ambiguous, allowed: s.allowed })) }
  const bytes = Buffer.from(JSON.stringify(body, null, 2) + '\n')
  return { body, bytes, sha256: sha(bytes) }
}

// Spread the ambiguous sentences evenly: clear and ambiguous sentences are dealt round-robin into the chunks separately, so every chunk
// is a small sample with 2 ambiguous sentences; within a chunk they are interleaved (an ambiguous sentence after every third clear one).
export function studyChunks(count = STUDY_CHUNKS) {
  const clear = SENTENCES.filter(s => !s.ambiguous), amb = SENTENCES.filter(s => s.ambiguous)
  return Array.from({ length: count }, (_, k) => {
    const c = clear.filter((_, i) => i % count === k), a = amb.filter((_, i) => i % count === k), out = []
    c.forEach((s, i) => { out.push(s); if (i % 3 === 2 && a.length) out.push(a.shift()) })
    return [...out, ...a]
  })
}
export const studyOrder = () => studyChunks().flat()

const recorder = () => { const seen = []; return { seen, async decide(request) { seen.push(request); return { answers: {} } } } }
const withUnknown = list => [...new Set([...list, U])]

/** -> { labels, chunks: [{ dir, plan, planBytes, files: [{ file, bytes }] }], totals } — deterministic; sends nothing. */
export async function buildStudy() {
  const labels = labelsFile(), order = studyOrder()
  const chunks = studyChunks().map((items, k) => ({ dir: `chunk-${String(k + 1).padStart(2, '0')}`, items }))
  for (const chunk of chunks) {
    chunk.files = []; const requests = []
    for (const s of chunk.items) {
      if (speechSegments(s.text).length !== 1) throw new Error(`${s.id}: the product does not read this as exactly one sentence`)
      const client = recorder()
      await judgeTurnWrite({ message: s.text, candidates: [], client, askedAt: STUDY_ASKED_AT, targetDesign: 'about' })
      if (client.seen.length !== 1) throw new Error(`${s.id}: expected one request`)
      const body = { model: DECISION_MODEL, input: client.seen[0].input, questions: client.seen[0].questions }
      const bytes = Buffer.from(JSON.stringify(body), 'utf8'), names = body.questions.map(q => q.name)
      for (const axis of AXES) if (!names.includes(`speech_${axis}_0`)) throw new Error(`${s.id}: no ${axis} question`)
      const expect = []
      for (const axis of AXES) {
        const allowed = s.allowed[axis], onlyUnknown = allowed.length === 1 && allowed[0] === U
        expect.push({ name: `speech_${axis}_0`, kind: 'choice', oneOf: withUnknown(allowed), whenAccepted: { minConfidence: SPEECH_THRESHOLDS.confidence, minMargin: SPEECH_THRESHOLDS.margin }, severity: 'hard',
          note: onlyUnknown ? `${axis}: deliberately ambiguous; installing any label at today's bar is a wrong install` : `${axis}: no label outside ${allowed.join('/')} installed at today's bar` })
        expect.push(onlyUnknown
          ? { name: `speech_${axis}_0`, kind: 'choice', equals: U, severity: 'soft', note: `${axis}: the top choice is unknown` }
          : { name: `speech_${axis}_0`, kind: 'choice', oneOf: allowed.filter(v => v !== U), minConfidence: SPEECH_THRESHOLDS.confidence, severity: 'soft', note: `${axis}: an allowed label at confidence >= ${SPEECH_THRESHOLDS.confidence} (coverage)` })
      }
      expect.push({ name: 'tw_status', kind: 'choice', oneOf: withUnknown(s.allowed.status), severity: 'soft', note: 'status reading (not part of the threshold question)' })
      const file = `requests/${s.id}.json`
      chunk.files.push({ file, bytes })
      requests.push({ id: s.id, file, sha256: sha(bytes), estInputTokens: independentEstimate(body.questions.filter(q => q.type === 'choice').length, body.questions.filter(q => q.type === 'predicate').length, bytes.length), expect })
    }
    const est = requests.reduce((n, r) => n + r.estInputTokens, 0)
    if (est > STUDY_CHUNK_CEILING) throw new Error(`${chunk.dir}: ${est} estimated input tokens, over ${STUDY_CHUNK_CEILING}`)
    chunk.plan = { set: `${STUDY_SET}/${chunk.dir}`, tokenCeiling: STUDY_CHUNK_CEILING,
      passRule: `Labels fixed in labels.json sha256 ${labels.sha256} before sending. A hard check fails only on a WRONG INSTALL at today's speech bar ` +
        `(confidence >= ${SPEECH_THRESHOLDS.confidence} and margin >= ${SPEECH_THRESHOLDS.margin}, runner-up including unreported mass): a label outside the sentence's allowed set. ` +
        'Soft checks: an allowed label at confidence >= the bar (coverage), unknown on a deliberately ambiguous axis, the status reading. ' +
        'This is a study: the outcome is the wrong-install rate per candidate bar from scripts/egdesk-utterance-threshold-study.mjs analyze, not pass/fail.',
      requests }
    chunk.planBytes = Buffer.from(JSON.stringify(chunk.plan, null, 2) + '\n')
    chunk.est = est
  }
  return { labels, chunks, totals: { sentences: order.length, ambiguous: order.filter(s => s.ambiguous).length, estInputTokens: chunks.reduce((n, c) => n + c.est, 0), maxChunk: Math.max(...chunks.map(c => c.est)) } }
}

// ---- analysis (after sending) ----
const binomCdf = (k, n, p) => { let sum = 0, term = (1 - p) ** n; for (let i = 0; i <= k; i++) { sum += term; term *= ((n - i) / (i + 1)) * (p / (1 - p || 1e-300)) } return sum }
/** One-sided 95% Clopper-Pearson upper bound for k events in n trials (k = 0: 1 - 0.05^(1/n)). */
export function upperBound95(k, n) {
  if (n <= 0) return 1
  if (k >= n) return 1
  let lo = k / n, hi = 1
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (binomCdf(k, n, mid) > 0.05) lo = mid; else hi = mid }
  return Math.round(hi * 10000) / 10000
}

/** The product's acceptance of one axis answer (egdesk-speech-grounding pick): never unknown; confidence and margin over the runner-up incl. unreported mass. */
export function wouldInstall(answer, bar, margin = SPEECH_THRESHOLDS.margin, optionCount = null) {
  if (answer?.type !== 'choice' || typeof answer.choice !== 'string' || answer.choice === U || !Number.isFinite(answer.confidence) || answer.confidence < bar) return false
  const rows = Array.isArray(answer.probabilities) ? answer.probabilities : []
  const chosen = rows.find(r => r.value === answer.choice)?.probability
  if (!Number.isFinite(chosen)) return false
  const total = rows.reduce((n, r) => n + (Number.isFinite(r.probability) ? r.probability : 0), 0)
  const other = Math.max(0, ...rows.filter(r => r.value !== answer.choice).map(r => r.probability), optionCount && rows.length < optionCount ? 1 - total : 0)
  return chosen - other >= margin - 1e-9
}

/** results: { [sentenceId]: { status, answers: [...] } } merged across chunks. -> per bar: installs, wrong, coverage, bounds. */
export function analyzeStudy(results, { bars = CANDIDATE_BARS, margin = SPEECH_THRESHOLDS.margin } = {}) {
  const answered = SENTENCES.filter(s => results[s.id]?.status === 200)
  const byBar = bars.map(bar => {
    let installs = 0, wrong = 0, correctInstalls = 0, clearAxes = 0, ambInstalls = 0, ambWrong = 0
    const wrongSentences = new Set(), wrongRows = []
    for (const s of answered) for (const axis of AXES) {
      const allowed = s.allowed[axis], onlyUnknown = allowed.length === 1 && allowed[0] === U
      if (!onlyUnknown) clearAxes++
      const answer = (results[s.id].answers || []).find(a => a.name === `speech_${axis}_0`)
      if (!wouldInstall(answer, bar, margin, axis === 'source' ? 6 : axis === 'form' ? 5 : 7)) continue
      installs++
      const ok = allowed.includes(answer.choice)
      if (s.ambiguous) { ambInstalls++; if (!ok) ambWrong++ }
      if (ok) correctInstalls++
      else { wrong++; wrongSentences.add(s.id); wrongRows.push({ id: s.id, axis, installed: answer.choice, confidence: answer.confidence, allowed }) }
    }
    return { bar, margin, installs, wrong, wrongRate: installs ? wrong / installs : null, upper95PerInstall: upperBound95(wrong, installs),
      sentences: answered.length, wrongSentences: wrongSentences.size, upper95PerSentence: upperBound95(wrongSentences.size, answered.length),
      coverage: clearAxes ? correctInstalls / clearAxes : null, ambiguousInstalls: ambInstalls, ambiguousWrong: ambWrong, wrongRows }
  })
  return { answered: answered.length, missing: SENTENCES.length - answered.length, byBar }
}

/** What each outcome would support, computed before sending (the table the report quotes). */
export function outcomeTable({ sentences = SENTENCES.length, ambiguous = SENTENCES.filter(s => s.ambiguous).length, installs = [60, 120, 150] } = {}) {
  const rows = []
  for (const k of [0, 1, 2, 3, 5]) rows.push({ wrongSentences: k, perSentenceOf: sentences, upper95: upperBound95(k, sentences) })
  const inst = installs.flatMap(n => [0, 1, 2, 3, 5].map(k => ({ installs: n, wrong: k, upper95: upperBound95(k, n) })))
  const amb = [0, 1, 2].map(k => ({ ambiguousSentencesWithAnInstall: k, of: ambiguous, upper95: upperBound95(k, ambiguous) }))
  return { perSentence: rows, perInstall: inst, ambiguous: amb }
}
