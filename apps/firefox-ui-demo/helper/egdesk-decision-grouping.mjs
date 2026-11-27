// Grouped-question lint (lane L6 cycle 11). Pure; no I/O. A request that asks the same question family about several items (one
// question per item: same_matter_R1, same_matter_R2, ...) must let each question carry ITS OWN item. Real evidence, 2026-11-25:
// L1's c12 work-placement request put every card in its own input message and gave all questions the SAME instruction text; grouped,
// the answers collapsed to one value (1/1/1, .03/.03/.03; and in the contamination study a "no" card flipped from 0 alone to .92
// among "yes" cards). L1's c13 construction quotes each card inside its own question; grouped answers were then identical to asking
// one card per request (.99/0/0, .04/.94/.02), as were the fill-slot (item quoted in the question) and excerpt (question names its
// labeled excerpt) families of the contamination study.
// A family group of >= 2 questions fails when
//   identical_instructions  two of its questions have the same instruction text (nothing in the question tells which item it is about), or
//   unresolved_reference    against some other question of the family, the part of its text that differs (widened to whole words) is
//                           neither inside a quoted string of the question nor at least ITEM_MIN_CHARS long, so it is a label rather
//                           than the item, and no such label appears in the input: the question names nothing the judge can find.
// A pass is "inline" (against every other question the differing part is quoted in the question or long: the item is in the question;
// two near-identical quoted lines such as "12월 15일" / "12월 20일" are still each their own item) or "reference" (the question differs by
// a short label, e.g. "c1", "#0", "b3", that the input carries).
export const ITEM_MIN_CHARS = 12
export const questionFamily = name => String(name).replace(/\d+/g, '#')
const tokens = text => new Set(String(text ?? '').match(/[\p{L}\p{N}_#]+/gu) ?? [])
function inputText(input) {
  const out = []
  const visit = v => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k !== 'role') visit(x) } }
  if (typeof input === 'string') out.push(input)
  else for (const m of Array.isArray(input) ? input : []) { if (m?.role === 'developer' || m?.role === 'system') continue; visit(m?.content) }
  return out.join('\n')
}

const isWord = ch => /[\p{L}\p{N}_#]/u.test(ch ?? '')
// Quoted regions of an instruction text: JSON-style "..." (escapes honoured), """...""", “...” and 「...」.
function quotedRegions(text) {
  const out = []
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('"""', i)) { const e = text.indexOf('"""', i + 3); if (e < 0) break; out.push([i, e + 3]); i = e + 2; continue }
    const close = { '"': '"', '“': '”', '「': '」' }[text[i]]
    if (!close) continue
    let j = i + 1
    while (j < text.length && text[j] !== close) j += text[j] === '\\' ? 2 : 1
    if (j >= text.length) break
    out.push([i, j + 1]); i = j
  }
  return out
}
/** The part of `a` that differs from `b` (common prefix and suffix removed), widened to whole words: { text, start, end }. */
function ownSpan(a, b) {
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  let start = p, end = a.length - s
  while (start > 0 && isWord(a[start - 1])) start--
  while (end < a.length && isWord(a[end])) end++
  return { text: a.slice(start, end), start, end }
}

/** lintGroupedRequest({ input, questions }) -> { ok, families: [{ family, names, kind: 'inline'|'reference'|null, problems: [{ name, problem }] }] } */
export function lintGroupedRequest(body) {
  const questions = Array.isArray(body?.questions) ? body.questions : []
  const seenInput = tokens(inputText(body?.input))
  const groups = new Map()
  for (const q of questions) { const f = questionFamily(q?.name); if (!groups.has(f)) groups.set(f, []); groups.get(f).push(q) }
  const families = []
  for (const [family, list] of groups) {
    if (list.length < 2) continue
    const problems = [], kinds = new Set()
    const texts = list.map(q => String(q.instructions ?? ''))
    list.forEach((q, i) => {
      if (texts.some((t, j) => j !== i && t === texts[i])) { problems.push({ name: q.name, problem: 'identical_instructions' }); return }
      const regions = quotedRegions(texts[i])
      const inline = sp => sp.text.length >= ITEM_MIN_CHARS || regions.some(([s, e]) => sp.start >= s && sp.end <= e)
      const labels = texts.filter((_, j) => j !== i).map(other => ownSpan(texts[i], other)).filter(sp => !inline(sp))
      if (!labels.length) { kinds.add('inline'); return }
      if (labels.every(sp => [...tokens(sp.text)].some(t => seenInput.has(t)))) { kinds.add('reference'); return }
      problems.push({ name: q.name, problem: 'unresolved_reference' })
    })
    families.push({ family, names: list.map(q => q.name), kind: problems.length ? null : kinds.has('reference') ? 'reference' : 'inline', problems })
  }
  return { ok: families.every(f => !f.problems.length), families }
}
