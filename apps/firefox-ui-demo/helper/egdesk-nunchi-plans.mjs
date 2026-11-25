import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { DECISION_MODEL, normalizeDecisionResponse } from './egdesk-decision-client.mjs'
import { LABEL_BAR, TYPE_NAMES } from './egdesk-conversation-examples.mjs'
import { ACTIONABLE_KINDS, NUNCHI_BAR, nunchiRequest, readNunchi } from './egdesk-nunchi.mjs'
import { adder, finish } from './egdesk-c36-plans.mjs'

// L7 u1 (U17): the measurement of the nunchi judgment (egdesk-nunchi.mjs) on the person's REAL reactions, Decisions only. NOTHING here sends or reads a key; Main sends after approval.
//
// What is measured: does the decision model read a reaction the way the person meant it? The examples are the masked conversation examples the owner approved for real sends (U12, 2026-11-24):
// the assistant's message before the person's turn and the turn, as the extractor kept them. The owner's local exclusion file (evidence/conversation-examples/local/exclude.json) is applied to
// every example, its source folder and its text BEFORE anything is built; what it excludes is counted and never named. A request body holds the masked example text and nothing about where it came from.
//
// There is no human gold label for these turns. Two instruments, said plainly:
//   * eight SYNTHETIC controls (written here, with the expectation each one's own meaning gives): hard checks at the product's bar. They say whether the question set works at all.
//   * the REAL examples, stratified by the prior reading the earlier Decision labelling gave them (the conv_* labels at their .8 bar: correction, instruction_change, pushback, frustration,
//     approval, praise, ambiguous, and the turns that point back / switch topics / check earlier, which are no reaction): recordOnly. The report (nunchiAgreement) counts, per prior class,
//     how often the nunchi reading agrees with it, disagrees, or does not reach the bar, and lists the disagreements by id for the owner to read. Agreement with an earlier model labelling is
//     an instrument, not accuracy against the person's intent; the disagreements are where a human looks.
export const NUNCHI_EVAL_SET = 'nunchi-eval-v1'
export const NUNCHI_CHUNK = Object.freeze({ tokenCeiling: 12_000, estimateCap: 9_200 })
const KIND_FIELDS = ['nk_kind', 'nk_about', 'nk_strength', 'nk_direction', 'nk_language']
const BAR = Object.freeze({ minConfidence: NUNCHI_BAR.confidence, minMargin: NUNCHI_BAR.margin })
const inSet = (name, oneOf, severity, note) => ({ name, kind: 'choice', oneOf, whenAccepted: { minConfidence: BAR.minConfidence, minMargin: BAR.minMargin }, severity, note })

/** The synthetic controls: the assistant's message, the person's turn, and what the turn means. */
export const NUNCHI_CONTROLS = Object.freeze([
  { id: 'control-language', prev: 'Here is the weekly summary in English: the review meeting moved to Tuesday, the vendor visit is still open, and the legal deadline is not set yet. Let me know if you want details on any item.', user: '야 한글로 보고해',
    expect: [inSet('nk_kind', ['correction', 'instruction_change'], 'hard', 'tells the assistant which language to use'), inSet('nk_about', ['language'], 'hard', 'about the language'), inSet('nk_language', ['korean'], 'hard', 'names Korean'), inSet('nk_strength', ['clear', 'strong'], 'soft', 'a plain instruction')] },
  { id: 'control-praise', prev: '테스트를 모두 통과했고 보고서를 남겼습니다.', user: '고마워요, 깔끔하게 잘했어', expect: [inSet('nk_kind', ['praise'], 'hard', 'thanks and praise')] },
  { id: 'control-approval', prev: '배포 전 체크리스트를 정리했습니다. 이대로 진행할까요?', user: '응 진행해', expect: [inSet('nk_kind', ['short_approval'], 'hard', 'a brief go-ahead that answers the question')] },
  { id: 'control-repeated-question', prev: '알겠습니다. 그럼 지금 바로 진행해도 될까요? 다시 한번 확인드립니다.', user: '아 몇 번을 물어보는 거야, 그냥 해', expect: [inSet('nk_kind', ['complaint', 'urging'], 'hard', 'annoyed at being asked again'), inSet('nk_about', ['repeated_question'], 'hard', 'about the repeated question')] },
  { id: 'control-length', prev: '요청하신 내용을 정리하면 다음과 같습니다. 첫째, 배포 일정은 12월 첫째 주이며 사전 점검이 필요합니다. 둘째, 롤백 절차는 이미 문서화되어 있고 담당자는 두 명입니다. 셋째, 모니터링 대시보드는 이번 주 안에 준비됩니다. 넷째, 고객사 공지는 배포 사흘 전에 나갑니다. 마지막으로 위험 요소는 데이터 이전 시간과 캐시 워밍입니다. 자세한 항목별 설명이 필요하시면 말씀해 주세요.', user: '너무 길어, 짧게 말해', expect: [inSet('nk_kind', ['complaint', 'instruction_change', 'correction'], 'hard', 'asks for shorter replies'), inSet('nk_about', ['length'], 'hard', 'about the length'), inSet('nk_direction', ['less'], 'hard', 'wants less')] },
  { id: 'control-new-question', prev: '회의는 화요일 오후 2시입니다.', user: '그럼 내일 일정은 어떻게 돼?', expect: [inSet('nk_kind', ['none'], 'hard', 'a new question: no reaction'), inSet('nk_about', ['no_particular'], 'soft', 'about nothing in particular')] },
  { id: 'control-wrong-fact', prev: '신제품 리뷰 회의는 수요일 오후에 있습니다.', user: '아니야, 화요일이야', expect: [inSet('nk_kind', ['correction'], 'hard', 'says the stated day is wrong'), inSet('nk_about', ['factual_error'], 'hard', 'a wrong fact')] },
  { id: 'control-ambiguous', prev: 'A안과 B안 중 어느 쪽으로 진행할까요?', user: '음.. 글쎄', expect: [inSet('nk_kind', ['ambiguous', 'none'], 'hard', 'cannot be read as a choice or a reaction: never a correction, praise or urge (wrong installs only)'), inSet('nk_about', ['no_particular', 'other'], 'soft', 'about nothing in particular')] },
])

// The prior class of a real example: the earlier Decision labelling (conv_* at its .8 bar). Reactions first, then turns that are no reaction.
export const PRIOR_CLASSES = Object.freeze([
  { id: 'correction', labels: ['correction'], allow: ['correction', 'instruction_change', 'complaint'] },
  { id: 'instruction_change', labels: ['instruction_change'], allow: ['instruction_change', 'correction'] },
  { id: 'pushback', labels: ['pushback'], allow: ['urging', 'complaint'] },
  { id: 'frustration', labels: ['frustration'], allow: ['complaint', 'urging'] },
  { id: 'approval', labels: ['approval'], allow: ['short_approval'] },
  { id: 'praise', labels: ['praise'], allow: ['praise'] },
  { id: 'ambiguous', labels: ['ambiguous'], allow: ['ambiguous', 'short_approval'] },
  { id: 'no_reaction', labels: ['referential', 'topic_switch', 'topic_return', 'check_earlier'], allow: ['none'], without: ['correction', 'instruction_change', 'pushback', 'frustration', 'approval', 'praise', 'interruption', 'reask'] },
])
export const priorClassOf = scores => {
  const yes = name => typeof scores?.[name] === 'number' && scores[name] >= LABEL_BAR
  for (const c of PRIOR_CLASSES) if (c.labels.some(yes) && !(c.without ?? []).some(yes)) return c
  return null
}

/** loadExamples(files, { exclusions }) -> { examples, counts }: the owner's exclusions applied to the example, its source folder and file, and every text it holds; counts only. */
export function loadExamples(files, { exclusions }) {
  if (!exclusions) throw new TypeError('the owner exclusions are required (loadOwnerExclusions)')
  const examples = [], counts = { read: 0, excludedByOwner: 0, noPrevious: 0, unreadable: 0 }
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let e
      try { e = JSON.parse(line) } catch { counts.unreadable++; continue }
      counts.read++
      const texts = [e.user?.text, e.prev?.text, e.next?.text, e.before?.text, e.source?.file, e.source?.cwd].filter(t => typeof t === 'string')
      if ((e.source?.cwd && exclusions.cwdExcluded(e.source.cwd)) || texts.some(t => exclusions.textExcluded(t))) { counts.excludedByOwner++; continue }
      if (typeof e.id !== 'string' || typeof e.user?.text !== 'string' || typeof e.prev?.text !== 'string' || !e.prev.text.trim()) { counts.noPrevious++; continue }
      examples.push(e)
    }
  }
  return { examples, counts }
}

/** readPriorLabels(resultFiles) -> Map(example id -> { conv_<type>: probability }) from the runner results of the earlier labelling plans (ids "ex-<id>"). */
export function readPriorLabels(resultFiles) {
  const labels = new Map()
  for (const file of resultFiles) {
    let j
    try { j = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
    for (const [rid, r] of Object.entries(j?.results ?? {})) {
      if (!rid.startsWith('ex-') || !Array.isArray(r?.answers)) continue
      const id = rid.slice(3), scores = labels.get(id) ?? {}
      for (const a of r.answers) if (typeof a?.name === 'string' && /^conv_/.test(a.name) && typeof a.probability === 'number') scores[a.name.slice(5)] = a.probability
      labels.set(id, scores)
    }
  }
  return labels
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
/**
 * buildNunchiEvalPlans({ examples, labels, perClass }) -> [{ plan, files, estInputTokens, preregistration }]
 * Chunk 1 starts with the controls; real examples follow in a deterministic stratified order (a round over the prior classes, by id). Every chunk's declared ceiling is at most 12,000.
 */
export function buildNunchiEvalPlans({ examples = [], labels = new Map(), perClass = 4, setPrefix = NUNCHI_EVAL_SET } = {}) {
  const byClass = new Map(PRIOR_CLASSES.map(c => [c.id, []]))
  for (const e of [...examples].sort((a, b) => (a.id < b.id ? -1 : 1))) { const c = priorClassOf(labels.get(e.id)); if (c) byClass.get(c.id).push(e) }
  const real = []
  for (let round = 0; round < perClass; round++) for (const c of PRIOR_CLASSES) { const e = byClass.get(c.id)[round]; if (e) real.push({ e, c }) }
  const items = [...NUNCHI_CONTROLS.map(c => ({ control: c })), ...real.map(({ e, c }) => ({ example: e, prior: c }))]
  const chunks = []
  let cur = null
  for (const item of items) {
    const { input, questions } = nunchiRequest({ message: item.control ? item.control.user : item.example.user.text, previousReply: item.control?.prev ?? item.example?.prev?.text })
    const body = { model: DECISION_MODEL, input, questions }
    const size = Buffer.byteLength(JSON.stringify(body))
    if (!cur || cur.bytes + size > 36_000) { cur = { items: [], a: adder(), bytes: 0, pre: [] }; chunks.push(cur) }
    const id = item.control ? item.control.id : `ex-${item.example.id}`
    cur.a.add(id, body, item.control ? item.control.expect : [])
    // a request without expectations is refused unless it says recordOnly
    if (!item.control) cur.a.requests.at(-1).recordOnly = true
    cur.bytes += size
    cur.pre.push(item.control ? { id, control: true, turn: item.control.user, expect: item.control.expect.map(x => ({ name: x.name, oneOf: x.oneOf, severity: x.severity })) }
      : { id, recordOnly: true, area: item.example.area, at: item.example.at, priorClass: item.prior.id, priorScores: Object.fromEntries(TYPE_NAMES.map(n => [n, labels.get(item.example.id)?.[n] ?? null])), allow: item.prior.allow })
  }
  return chunks.map((c, i) => {
    const built = finish(`${setPrefix}-${String(i + 1).padStart(3, '0')}`, c.a.requests, c.a.files, { '*choice': { minConfidence: BAR.minConfidence, minMargin: BAR.minMargin, source: 'egdesk-nunchi.mjs NUNCHI_BAR (.85 / .2): a reading is installed only above it' } },
      i === 0 ? 'Pass: every hard expectation of the synthetic controls holds. The real examples are recordOnly: their answers are read by nunchiAgreement against the prior class (an instrument, not a gold label).'
        : 'Record only: the answers are read by nunchiAgreement against the prior class of each example (an instrument, not a gold label).')
    built.plan.seeds = [{ id: 'conversation-examples', privacy: 'owner-approved' }]
    built.plan.tokenCeiling = Math.min(built.plan.tokenCeiling, NUNCHI_CHUNK.tokenCeiling)
    built.plan.requests = built.plan.requests.map(r => (r.expect?.length ? r : { ...r, expect: [], recordOnly: true }))
    return { plan: built.plan, files: built.files, estInputTokens: built.estInputTokens, preregistration: c.pre }
  })
}

/**
 * readWire(answers) -> the reading of a runner results file's answers, the way the product reads them: the wire list is normalized first (the runner keeps the options in the order the
 * question listed them; the product's client sorts them by probability), then read at the bars. u2: the first report read the wire order and counted every answer as under the bar.
 */
export function readWire(answers) {
  try { return readNunchi(normalizeDecisionResponse({ answers }, nunchiRequest({ message: 'x' }).questions).answers) } catch { return readNunchi(null) }
}

/**
 * nunchiAgreement(results, preregistration) -> { rows, byClass, totals, controls, text }
 * results: the runner's results file (outcome of one chunk); preregistration: that chunk's list. For a real example the reading's KIND is the installed single kind, or "change" when the merged
 * options (correction, instruction_change, complaint, urging) are installed together (u2): agree when it is in the prior class's allowed set ("change" agrees with a prior class that allows
 * any asking-for-change kind), disagree, or unread (neither is installed at the bars). Controls are checked by the runner's hard checks; here only the installed reading is listed.
 */
export function nunchiAgreement(results, preregistration) {
  const res = results?.results ?? {}
  const kindOf = r => r.kind ?? (r.change === true ? 'change' : null)
  const rows = preregistration.filter(p => !p.control).map(p => {
    const answers = res[p.id]?.answers
    if (!Array.isArray(answers)) return { id: p.id, priorClass: p.priorClass, state: 'not_sent', reading: null }
    const reading = readWire(answers), kind = kindOf(reading)
    const ok = kind === null ? null : kind === 'change' ? p.allow.some(k => ACTIONABLE_KINDS.includes(k)) : p.allow.includes(kind)
    return { id: p.id, priorClass: p.priorClass, state: ok === null ? 'unread' : ok ? 'agree' : 'disagree', kind, reading }
  })
  const byClass = {}
  for (const r of rows) { const c = (byClass[r.priorClass] ??= { n: 0, agree: 0, disagree: 0, unread: 0, not_sent: 0 }); c.n++; c[r.state]++ }
  const sum = key => rows.filter(r => r.state === key).length, agree = sum('agree'), disagree = sum('disagree'), unread = sum('unread')
  const totals = { examples: rows.length, agree, disagree, unread, notSent: sum('not_sent'), agreementWhereRead: agree + disagree ? Number((agree / (agree + disagree)).toFixed(3)) : null, readRate: rows.length ? Number(((agree + disagree) / rows.length).toFixed(3)) : null }
  const controls = preregistration.filter(p => p.control).map(p => ({ id: p.id, reading: res[p.id]?.answers ? readWire(res[p.id].answers) : null, elapsedMs: res[p.id]?.elapsedMs ?? null }))
  const show = r => `kind ${r.kind ?? '-'}, change ${r.change === null ? '-' : r.change}${r.changeMass === null ? '' : ` (${r.changeMass})`}, about ${r.about ?? '-'}, strength ${r.strength ?? '-'}, forceful ${r.forceful === null ? '-' : r.forceful}, direction ${r.direction ?? '-'}, language ${r.language ?? '-'}`
  const lines = ['| prior class | examples | agree | disagree | unread (under the bars) |', '|---|---|---|---|---|', ...Object.entries(byClass).map(([k, v]) => `| ${k} | ${v.n} | ${v.agree} | ${v.disagree} | ${v.unread} |`), '',
    `agreement where the kind is read: ${totals.agreementWhereRead ?? '-'} (${agree}/${agree + disagree}); read rate: ${totals.readRate ?? '-'}; unread: ${unread}; not sent: ${totals.notSent}`,
    ...(rows.some(r => r.state === 'disagree') ? ['', 'disagreements (ids only; read the turns locally):', ...rows.filter(r => r.state === 'disagree').map(r => `- ${r.id} prior ${r.priorClass} -> ${show(r.reading)}`)] : []),
    ...(controls.length ? ['', 'controls:', ...controls.map(c => `- ${c.id}: ${c.reading ? show(c.reading) : 'not sent'}${c.elapsedMs ? ` (${c.elapsedMs} ms)` : ''}`)] : [])]
  return { rows, byClass, totals, controls, text: lines.join('\n') }
}

export const defaultExamplesDir = home => path.join(home, '.aside', 'u', '0', 'sessions', '2026-11-15_5yGDgeI9gUvBBXY9', 'tmp', 'decision-loop', 'evidence', 'conversation-examples', 'examples')
export const listFiles = (dir, pattern) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter(f => pattern.test(f)).map(f => path.join(dir, f)).sort() : [])
export { KIND_FIELDS, sha }

// ---- u2: validation of the merged reading on turns the rule was NOT tuned on ----
// The merged rule (egdesk-nunchi.mjs: a change is asked when correction + instruction_change + complaint + urging hold at least .85 together) was designed on the recorded answers of
// nunchi-eval-v1, so those 26 answers cannot validate it. These twelve synthetic turns are new: six that ask for a change (the person's own kinds of sentence in the window of 02:51 and
// after it: language, length, "don't ask, just do it", a format, fuller, English) and six that do not (a remark, a new question, thanks, an approval, a plain question, "ㅇㅋ").
// They are recordOnly for the runner (the merged reading is not a single answer a runner expectation can read); nunchiMergedReport checks them by code.
export const NUNCHI_MERGED_CONTROLS = Object.freeze([
  { id: 'm-language-ask', prev: 'Here is the summary in English: the review meeting is on Tuesday at 2 pm, the vendor visit is still open, and the legal deadline is not set. Let me know if you want details on any item.', user: '한국어로 말해줘', expect: { change: true, about: 'language', language: 'korean', severity: 'hard' } },
  { id: 'm-length-standing', prev: '요청하신 내용을 정리하면 다음과 같습니다. 첫째, 배포 일정은 12월 첫째 주이며 사전 점검이 필요합니다. 둘째, 롤백 절차는 문서화되어 있고 담당자는 두 명입니다. 셋째, 모니터링 대시보드는 이번 주 안에 준비됩니다. 넷째, 고객사 공지는 배포 사흘 전에 나갑니다. 자세한 설명이 필요하시면 말씀해 주세요.', user: '너무 길어. 앞으로는 짧게 말해', expect: { change: true, about: 'length', direction: 'less', severity: 'hard' } },
  { id: 'm-dont-ask', prev: '정리를 마쳤습니다. 이대로 저장해도 될까요? 다음 단계로 넘어가기 전에 한 번 더 확인드립니다.', user: '묻지 말고 그냥 알아서 해', expect: { change: true, about: 'repeated_question', severity: 'hard' } },
  { id: 'm-already-said', prev: '어떤 파일을 기준으로 할까요? 기준 파일을 알려 주세요.', user: '또 그 질문이야? 이미 말했잖아', expect: { change: true, about: 'repeated_question', severity: 'hard' } },
  { id: 'm-english-from-now', prev: '네, 알겠습니다. 오늘 일정은 오후 두 시 회의 하나입니다.', user: '앞으로는 영어로 답해', expect: { change: true, about: 'language', language: 'english', severity: 'hard' } },
  { id: 'm-table-format', prev: '항목은 세 가지입니다. 하나는 일정 관리, 둘은 비용 정리, 셋은 위험 목록이며 각각 담당자가 다릅니다. 일정은 12월, 비용은 11월 말, 위험 목록은 상시 갱신입니다.', user: '표로 정리해줘', expect: { change: true, about: 'format', severity: 'soft' } },
  { id: 'm-remark', prev: '회의는 화요일 오후 2시입니다.', user: '아 그렇구나', expect: { change: false, severity: 'hard' } },
  { id: 'm-other-way', prev: '그 방법은 시간이 많이 걸립니다.', user: '그럼 다른 방법은 없어?', expect: { change: false, severity: 'hard' } },
  { id: 'm-thanks', prev: '보고서를 저장했고 요약을 보냈습니다.', user: '고마워, 도움 됐어', expect: { change: false, severity: 'hard' } },
  { id: 'm-approval', prev: 'A안으로 진행할까요?', user: '응 A로 해줘', expect: { change: false, severity: 'hard' } },
  { id: 'm-plain-question', prev: '배포는 다음 주에 합니다.', user: '회의는 몇 시야?', expect: { change: false, severity: 'hard' } },
  { id: 'm-ok', prev: '파일 이름을 바꿨습니다.', user: 'ㅇㅋ', expect: { change: false, severity: 'hard' } },
])

/** buildNunchiMergedPlans() -> [{ plan, files, estInputTokens, preregistration }]: two chunks of six (the declared ceiling of each is at most 12,000). */
export function buildNunchiMergedPlans({ setPrefix = 'nunchi-merge-v1' } = {}) {
  const chunks = []
  for (let i = 0; i < NUNCHI_MERGED_CONTROLS.length; i += 6) {
    const a = adder(), pre = []
    for (const c of NUNCHI_MERGED_CONTROLS.slice(i, i + 6)) {
      const { input, questions } = nunchiRequest({ message: c.user, previousReply: c.prev })
      a.add(c.id, { model: DECISION_MODEL, input, questions }, [])
      a.requests.at(-1).recordOnly = true
      pre.push({ id: c.id, merged: true, expect: c.expect })
    }
    const built = finish(`${setPrefix}-${String(chunks.length + 1).padStart(3, '0')}`, a.requests, a.files, { '*choice': { minConfidence: BAR.minConfidence, minMargin: BAR.minMargin, source: 'egdesk-nunchi.mjs NUNCHI_BAR (.85 / .2) for single choices; the merged readings use NUNCHI_MASS (.85)' } },
      'Record only: nunchiMergedReport reads each answer the way the product does (the merged "asks for a change" and "forceful" readings at .85, the choices at their bar) and checks it against the expectation of its control: hard ones must hold, soft ones are reported. The twelve turns are new: the rule was not tuned on them.')
    built.plan.tokenCeiling = Math.min(built.plan.tokenCeiling, NUNCHI_CHUNK.tokenCeiling)
    built.plan.seeds = []
    chunks.push({ plan: built.plan, files: built.files, estInputTokens: built.estInputTokens, preregistration: pre })
  }
  return chunks
}

/**
 * nunchiMergedReport(results, preregistration) -> { rows, hard: { passed, total }, soft: { passed, total }, text }
 * A row passes when every field its expectation names is read as expected: change true / false exactly (undecided is a miss), and for a change the about, direction, language the expectation names.
 */
export function nunchiMergedReport(results, preregistration) {
  const res = results?.results ?? {}
  const rows = preregistration.filter(p => p.merged).map(p => {
    const answers = res[p.id]?.answers
    if (!Array.isArray(answers)) return { id: p.id, severity: p.expect.severity, pass: false, state: 'not_sent', reading: null }
    const r = readWire(answers), e = p.expect
    const misses = []
    if (r.change !== e.change) misses.push(`change ${r.change} (mass ${r.changeMass}), wanted ${e.change}`)
    for (const f of ['about', 'direction', 'language']) if (e[f] !== undefined && r[f] !== e[f]) misses.push(`${f} ${r[f] ?? 'unread'}, wanted ${e[f]}`)
    if (e.change === true && r.forceful !== true) misses.push(`forceful ${r.forceful} (mass ${r.forceMass})`)
    return { id: p.id, severity: e.severity, pass: misses.length === 0, state: 'read', misses, reading: r, elapsedMs: res[p.id]?.elapsedMs ?? null }
  })
  const tally = sev => ({ passed: rows.filter(r => r.severity === sev && r.pass).length, total: rows.filter(r => r.severity === sev).length })
  const text = ['| control | severity | result | change (mass) | about | forceful (mass) | direction | language |', '|---|---|---|---|---|---|---|---|',
    ...rows.map(r => (r.reading ? `| ${r.id} | ${r.severity} | ${r.pass ? 'pass' : `MISS: ${r.misses.join('; ')}`} | ${r.reading.change} (${r.reading.changeMass}) | ${r.reading.about ?? '-'} | ${r.reading.forceful} (${r.reading.forceMass}) | ${r.reading.direction ?? '-'} | ${r.reading.language ?? '-'} |` : `| ${r.id} | ${r.severity} | not sent | | | | | |`)),
    '', `hard: ${tally('hard').passed}/${tally('hard').total}; soft: ${tally('soft').passed}/${tally('soft').total}`].join('\n')
  return { rows, hard: tally('hard'), soft: tally('soft'), text }
}
