import { predicateQuestion, choiceQuestion, readPredicate, readChoice, DEFAULT_DECISION_THRESHOLDS } from './egdesk-decision-questions.mjs'
import { CANVAS_CHECK_BARS, CANVAS_CHECK_ITEMS, CHECK_ITEM_NAMES, MAX_CHECK_CARDS, MAX_CHECK_GROUPS } from '../overlay/resources/EGDeskCanvasDesignCheck.sys.mjs'

// Decision step of the canvas design check. The Decision model is a system-level judge: it answers closed questions about items the canvas
// runtime enumerated (EGDeskCanvasDesignCheck.sys.mjs) and picks among the runtime's location candidates. It never proposes a layout.
// One request: predicate `understandable`, one predicate `issue_<item>` per enumerated item, one choice `where` over the candidate aliases.
// Raw probability is not permission: the caller re-checks mode, key and grants; nothing here writes anything.

const KINDS = new Set(['업무 전표', '메모', '자료', '상태표'])
const KIND_TEXT = { '업무 전표': 'work slip', 메모: 'note', 자료: 'material', 상태표: 'status table' }
const CARD_ALIAS = /^[A-L]$/, GROUP_ALIAS = /^G[1-6]$/
const exactKeys = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const plainText = (t, max) => typeof t === 'string' && t.length > 0 && t.length <= max && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(t)

/** Closed wire shape from the chrome. Anything else (extra field, unknown item name, alias not declared) is refused. */
export function normalizeCanvasCheckDto(raw) {
  try {
    if (!exactKeys(raw, ['purpose', 'cards', 'groups', 'items']) || !plainText(raw.purpose, 280) || raw.purpose !== raw.purpose.normalize('NFC') || raw.purpose.trim() !== raw.purpose) return null
    if (!Array.isArray(raw.cards) || raw.cards.length < 1 || raw.cards.length > MAX_CHECK_CARDS || !Array.isArray(raw.groups) || raw.groups.length > MAX_CHECK_GROUPS ||
        !Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > CHECK_ITEM_NAMES.length) return null
    const declared = new Set()
    const cards = raw.cards.map(c => {
      if (!exactKeys(c, Object.hasOwn(c ?? {}, 'label') ? ['alias', 'kind', 'label'] : ['alias', 'kind']) || !CARD_ALIAS.test(c.alias) || !KINDS.has(c.kind) || declared.has(c.alias)) throw 0
      if (Object.hasOwn(c, 'label') && !plainText(c.label, 40)) throw 0
      declared.add(c.alias); return { alias: c.alias, kind: c.kind, ...(Object.hasOwn(c, 'label') ? { label: c.label } : {}) }
    })
    const groups = raw.groups.map(g => {
      if (!exactKeys(g, ['alias', 'size']) || !GROUP_ALIAS.test(g.alias) || declared.has(g.alias) || !Number.isInteger(g.size) || g.size < 2 || g.size > MAX_CHECK_CARDS) throw 0
      declared.add(g.alias); return { alias: g.alias, size: g.size }
    })
    const seen = new Set()
    const items = raw.items.map(i => {
      if (!exactKeys(i, ['name', 'aliases', 'measure']) || !CHECK_ITEM_NAMES.includes(i.name) || seen.has(i.name) || !Array.isArray(i.aliases) || !i.aliases.length ||
          i.aliases.length > MAX_CHECK_CARDS + MAX_CHECK_GROUPS || new Set(i.aliases).size !== i.aliases.length || !i.aliases.every(a => declared.has(a)) ||
          !exactKeys(i.measure, ['count']) || !Number.isInteger(i.measure.count) || i.measure.count < 1 || i.measure.count > 99) throw 0
      seen.add(i.name); return { name: i.name, aliases: [...i.aliases], measure: { count: i.measure.count } }
    })
    return { purpose: raw.purpose, cards, groups, items }
  } catch { return null }
}

const WHERE_NONE = 'none'
const ITEM_FRAME = 'Judge only from the provided aliases, kinds and counts. Do not infer card content or invent locations.'
const flowQuestion = 'Given the board purpose, the card kinds, the listed relations and the measured layout issues, would a first-time reader understand the current flow of this canvas?'

export function prepareCanvasDesignCheck({ mode = 'off', binding = '', dto } = {}) {
  const manual = { status: 'manual', packet: null }
  if (!binding || !['advisory', 'on'].includes(mode)) return manual
  const clean = normalizeCanvasCheckDto(dto)
  if (!clean) return manual
  const locations = [...new Set(clean.items.flatMap(i => i.aliases))]
  const describe = alias => { const c = clean.cards.find(x => x.alias === alias); return c ? KIND_TEXT[c.kind] : `group of ${clean.groups.find(g => g.alias === alias).size} cards` }
  const questions = [
    predicateQuestion('understandable', `${flowQuestion} ${ITEM_FRAME}`),
    ...clean.items.map(i => predicateQuestion(`issue_${i.name}`, `${CANVAS_CHECK_ITEMS[i.name]} Locations: ${i.aliases.join(', ')}. ${ITEM_FRAME}`)),
    choiceQuestion('where', `If the flow needs improvement, which one location needs it most? Choose ${WHERE_NONE} if no single location stands out. ${ITEM_FRAME}`,
      [...locations.map(alias => ({ value: alias, description: describe(alias) })), { value: WHERE_NONE, description: 'no single location stands out' }]),
  ]
  const packet = { input: [{ role: 'user', content: [{ type: 'input_text', text: clean.purpose },
    { type: 'input_json', data: { cards: clean.cards, groups: clean.groups, items: clean.items } }] }], questions }
  return { status: 'prepared', kind: 'check', mode, binding, dto: clean, locations, options: clean.items.map(i => i.name), packet }
}

/**
 * readCanvasDesignCheck(prepared, answers, currentBinding) →
 *   { status: 'ok' | 'findings' | 'inconclusive' | 'manual', understandable, findings:[{ item, aliases, p }], where, verdict }
 * 'findings' needs: understandable <= flawed bar AND at least one item at or over the issue bar. 'ok' needs understandable >= bar and no item over the issue
 * bar. Everything else (a middling answer, a contradiction, a flawed flow whose items all stay under the bar) is 'inconclusive': nothing is applied.
 * An unusable answer (refusal, missing, wrong type) is 'manual'. The result is mode-agnostic (the bar's own judgment, also for calibration); the HTTP
 * handler decides what a mode may return: advisory replies with the verdict kind only, never findings.
 */
export function readCanvasDesignCheck(prepared, answers, currentBinding) {
  const base = { status: 'manual', understandable: null, findings: [], where: null }
  if (prepared?.status !== 'prepared' || prepared.kind !== 'check' || currentBinding !== prepared.binding) return base
  const flow = readPredicate(answers, 'understandable', CANVAS_CHECK_BARS.understandable)
  const rows = prepared.dto.items.map(i => ({ item: i, ...readPredicate(answers, `issue_${i.name}`, CANVAS_CHECK_BARS.issue) }))
  if (flow.probability === null || rows.some(r => r.probability === null)) return base
  const applies = rows.filter(r => r.state === 'yes').sort((a, b) => b.probability - a.probability)
  const understood = flow.probability >= CANVAS_CHECK_BARS.understandable, flawed = flow.probability <= CANVAS_CHECK_BARS.flawed
  const verdict = understood && !applies.length ? 'ok' : flawed && applies.length ? 'findings' : 'inconclusive'
  const out = { status: verdict, verdict, understandable: flow.probability, findings: [], where: null }
  if (verdict !== 'findings') return out
  out.findings = applies.map(r => ({ item: r.item.name, aliases: [...r.item.aliases], p: r.probability }))
  const where = readChoice(answers, 'where', { minConfidence: CANVAS_CHECK_BARS.where, minMargin: CANVAS_CHECK_BARS.margin })
  const named = new Set(out.findings.flatMap(f => f.aliases))
  if (where.state === 'accepted' && where.value !== WHERE_NONE && named.has(where.value)) out.where = { alias: where.value, p: where.confidence }
  return out
}

/** Content-free calibration entry (egdesk-decision-calibration-log whitelist): numbers and closed words only. */
export function canvasCheckCalibrationEntry(prepared, answers, result) {
  const flow = answers?.understandable, where = answers?.where
  const rows = Array.isArray(where?.probabilities) ? where.probabilities : []
  return { feature: 'board_arrangement', mode: prepared.mode, candidates: prepared.dto.items.length, attached: prepared.mode === 'on' && result.status === 'findings',
    judgments: [
      { q: 'goal_met', would: result.verdict === 'findings' ? 'act' : result.verdict === 'ok' ? 'none' : 'hold', p: flow?.probability, threshold: CANVAS_CHECK_BARS.understandable, kind: 'board' },
      ...prepared.dto.items.map(i => { const p = answers?.[`issue_${i.name}`]?.probability; return { q: 'relevance', would: p >= CANVAS_CHECK_BARS.issue ? 'accept' : 'reject', p, threshold: CANVAS_CHECK_BARS.issue, kind: 'board' } }),
      { q: 'choice', would: result.where ? 'accept' : 'reject', top: rows[0]?.probability, second: rows[1]?.probability, p: where?.confidence, threshold: DEFAULT_DECISION_THRESHOLDS.choice, minMargin: DEFAULT_DECISION_THRESHOLDS.margin, kind: 'board' },
    ] }
}
