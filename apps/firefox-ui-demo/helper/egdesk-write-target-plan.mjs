import { createHash } from 'node:crypto'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'
import { buildWiki } from './egdesk-wiki-reconstruction.mjs'
import { SYNTHETIC_PAGES } from './egdesk-wiki-reconstruction.fixture.mjs'
import { judgeTurnWrite, triageTurn } from './egdesk-turn-memory.mjs'
import { speechSegments } from './egdesk-speech-grounding.mjs'

// The re-measurement of the write target ('about' design) as a DECLARATIVE plan for the generic runner
// (scripts/egdesk-decision-real-measure.mjs, helper/egdesk-decision-real-runner.mjs). Nothing here sends anything.
// Every body is built by the product code itself (judgeTurnWrite with targetDesign 'about', triageTurn) through a recording client;
// the expectations are registered here, before any call. Public synthetic Korean text only.
export const WRITE_TARGET_SET = 'write-target-about-v1'
export const ASKED_AT = Date.parse('2026-11-24T14:30:00+09:00')
const estimate = (choice, predicate, bytes) => Math.round(56.5 * choice + 134.8 * predicate + 0.1983 * bytes) // the typed model of 2026-11-24
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

// Two look-alike delivery records (two customers, two dates): the correction names only a date.
const ORDER_PAGES = [
  { id: 'order/b-due', title: 'B사 납품 일정', body: 'B사 스피커 모듈 납기는 12월 3일로 정했다. 수량은 200개다.', revision: '1', time: { slice: 'planned' }, provenance: { kind: 'own_record' }, status: 'plan', scope: 'dm:this-room' },
  { id: 'order/a-due', title: 'A사 납품 일정', body: 'A사 스피커 모듈 납기는 12월 20일로 정했다. 수량은 200개다.', revision: '1', time: { slice: 'planned' }, provenance: { kind: 'own_record' }, status: 'plan', scope: 'dm:this-room' }]

const top = (name, value, note) => ({ name, kind: 'choice', equals: value, severity: 'hard', note })
const installed = (name, value, note) => ({ name, kind: 'choice', equals: value, minConfidence: 0.85, severity: 'soft', note })
// One sentence: its three labels. hard = the top choice is the registered one (a wrong top choice can become a wrong stored label);
// soft = it clears the product's bar (0.85) and would be installed. The bar itself is the owner's and is not changed here.
const labels = ({ source, form, time }) => [
  top('speech_source_0', source, 'registered source label is the top choice'), installed('speech_source_0', source, 'installed at the 0.85 bar'),
  top('speech_form_0', form, 'registered form label is the top choice'), installed('speech_form_0', form, 'installed at the 0.85 bar'),
  top('speech_time_0', time, 'registered time label is the top choice'), installed('speech_time_0', time, 'installed at the 0.85 bar')]
const notACorrection = { name: 'tw_status', kind: 'choice', oneOf: ['done', 'plan', 'unknown'], severity: 'hard', note: 'a plain report is not read as a correction of a record' }

/** The six cases. candidates: page ids of `pages` shown as stored records, in this order (P1, P2, ...). */
export const WRITE_TARGET_CASES = Object.freeze([
  { id: 'u1-relayed-past', kind: 'write', message: '거래처 D사가 어제 단가를 올렸다고 들었어.', candidates: [], derived: 'new',
    expect: [notACorrection, ...labels({ source: 'attributed_report', form: 'assertion', time: 'past_anchored' })] },
  { id: 'u2-own-plan', kind: 'write', message: '다음 주 화요일에 은모래 창고 재고를 다시 셀 예정이야.', candidates: [], derived: 'new',
    expect: [{ name: 'tw_status', kind: 'choice', equals: 'plan', minConfidence: 0.75, severity: 'hard', note: 'an intention is a plan (0.99 in the earlier run)' }, ...labels({ source: 'unspecified', form: 'plan', time: 'future_anchored' })] },
  { id: 'u3-own-observation', kind: 'write', message: '내가 달그림 상자 수량을 직접 세어 봤는데 42개였어.', candidates: [], derived: 'new',
    expect: [notACorrection, ...labels({ source: 'self_reported_observation', form: 'assertion', time: 'past_unspecified' })] },
  { id: 'pg-done-report', kind: 'write', message: 'PostgreSQL 마이그레이션 배포 끝났어', pages: 'wiki', candidates: ['db/pg-plan', 'db/pg-health', 'db/pg-followup'], derived: 'db/pg-plan',
    expect: [{ name: 'tw_about_0', kind: 'predicate', min: 0.8, severity: 'hard', note: 'the report is about the plan record it completes' },
      { name: 'tw_about_1', kind: 'predicate', max: 0.2, severity: 'hard', note: 'the health checklist is the same task, not the record reported on; undecided would block the write' },
      { name: 'tw_about_2', kind: 'predicate', max: 0.2, severity: 'hard', note: 'the follow-up checklist is the same task, not the record reported on; undecided would block the write' },
      { name: 'tw_status', kind: 'choice', equals: 'done', minConfidence: 0.75, severity: 'hard', note: 'finished' },
      top('speech_form_0', 'assertion', 'a report is an assertion'), { name: 'speech_time_0', kind: 'choice', oneOf: ['past_unspecified', 'past_anchored', 'at_utterance'], severity: 'soft', note: 'finished before or at the utterance' }] },
  { id: 'due-date-correction', kind: 'write', message: '아니, 납기는 12월 3일이 아니라 10일이야.', pages: 'orders', candidates: ['order/b-due', 'order/a-due'], derived: 'order/b-due',
    expect: [{ name: 'tw_about_0', kind: 'predicate', min: 0.8, severity: 'hard', note: 'the record that holds "12월 3일" is the one corrected' },
      { name: 'tw_about_1', kind: 'predicate', max: 0.2, severity: 'hard', note: 'the look-alike delivery record (another customer, another date) is not it' },
      { name: 'tw_status', kind: 'choice', equals: 'corrected', minConfidence: 0.75, severity: 'hard', note: 'a detail is replaced: read as a correction, not as done or plan' },
      top('speech_form_0', 'assertion', 'a correction is an assertion')] },
  { id: 'small-talk', kind: 'triage', message: '고마워, 오늘은 여기까지 하자.', candidates: [], derived: 'none',
    expect: [{ name: 'tn_record', kind: 'predicate', max: 0.2, severity: 'hard', note: '"do not add" is decided here, before any write judgment runs' },
      { name: 'tn_courtesy', kind: 'predicate', min: 0.8, severity: 'soft', note: 'thanks and closing' }] },
])
export const WRITE_TARGET_PASS_RULE = 'Every request passes (no failed hard check): each registered record gets a decided yes and each other record a decided no, '
  + 'the status reading is the registered one, no label top choice is wrong, and small talk is a decided "do not record". '
  + 'Soft checks (labels installed at the 0.85 bar, same-task links) are reported, not required. A target of "new" for the three utterances is derived by code from having no stored record: there is no question to pass or fail.'

const recorder = () => { const seen = []; return { seen, async decide(request) { seen.push(request); return { answers: {} } } } }
async function bodyOf(def) {
  const client = recorder()
  if (def.kind === 'triage') await triageTurn({ message: def.message, client, askedAt: ASKED_AT })
  else {
    const wiki = def.pages === 'orders' ? buildWiki(ORDER_PAGES) : buildWiki(SYNTHETIC_PAGES)
    await judgeTurnWrite({ message: def.message, candidates: def.candidates.map(id => wiki.pages.get(id)), client, askedAt: ASKED_AT, targetDesign: 'about' })
  }
  // The first request is the one under test (the target and the status). A new page's same-task links are a second, separate request of
  // the product (only when a new page is proposed); it is not part of this measurement.
  if (client.seen.length < 1) throw new Error(`${def.id}: no request was built`)
  return { model: DECISION_MODEL, input: client.seen[0].input, questions: client.seen[0].questions }
}

/** -> { plan (the declarative object), files: [{ file, bytes (Buffer) }] }. Deterministic: the same code gives the same bytes. */
export async function buildWriteTargetPlan() {
  const requests = [], files = []
  for (const def of WRITE_TARGET_CASES) {
    if (def.kind === 'write' && speechSegments(def.message).length !== 1) throw new Error(`${def.id}: one sentence expected`)
    const body = await bodyOf(def), bytes = Buffer.from(JSON.stringify(body), 'utf8')
    const choice = body.questions.filter(q => q.type === 'choice').length, predicate = body.questions.length - choice
    const names = new Set(body.questions.map(q => q.name))
    for (const e of def.expect) if (!names.has(e.name)) throw new Error(`${def.id}: no question named ${e.name}`)
    const file = `requests/${def.id}.json`
    files.push({ file, bytes })
    requests.push({ id: def.id, file, sha256: sha(bytes), estInputTokens: estimate(choice, predicate, bytes.length), expect: def.expect.map(e => ({ ...e })) })
  }
  const total = requests.reduce((n, r) => n + r.estInputTokens, 0)
  // tokenCeiling: the runner stops above it; real usage ran about 4% over this estimate model so far, so 15% leaves room without doubling the spend.
  return { plan: { set: WRITE_TARGET_SET, tokenCeiling: Math.ceil(total * 1.15 / 100) * 100, passRule: WRITE_TARGET_PASS_RULE, requests }, files, estInputTokens: total }
}
