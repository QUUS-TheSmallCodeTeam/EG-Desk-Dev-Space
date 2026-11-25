// L7 c37: the real-engine comparison of the prefetch (EGDESK_TURN_MEMORY_PREFETCH=files) against the same turns without it: notes, coding and ledger style questions about ONE named file of a
// small synthetic folder, each in a pair of conversations (-off, -on) that differ only in that flag. The engine's folder is the check's scratch folder (the conversation's `folder` files).
// Per turn the record has the engine's tool calls (toolCalls), its items, its latency and token usage: the comparison is scripts/egdesk-prefetch-compare.mjs.
// Expectations by code: both answer with the fact that only the named file holds; the -on conversations also expect NO EG-Desk tool call (the engine read nothing: the file text was in its turn context).
// Needs --decisions (the selection picks the file) and the whole check composition; the engine is not asked to edit anything (no approvals).
export const PREFETCH_SET = 'real-engine-prefetch-v1'
const filler = n => Array.from({ length: n }, (_, i) => `메모 ${i + 1}: 이 항목은 이번 건과 관계없는 일상 기록이며 참고용으로만 남긴다.`).join('\n')
export const PREFETCH_SCENARIOS = Object.freeze({
  notes: { say: 'notes/2026-11-20.md 에서 정한 예산이 얼마야?', fact: '4,730만 원', folder: {
    'notes/2026-11-18.md': `# 11월 18일 회의\n${filler(8)}\n결정: 본 전환 일정은 다음 주에 다시 이야기한다.\n`,
    'notes/2026-11-20.md': `# 11월 20일 회의\n${filler(6)}\n결정: 서버 이전 예산은 4,730만 원으로 승인한다.\n${filler(4)}\n`,
    'notes/2026-11-22.md': `# 11월 22일 회의\n${filler(8)}\n결정: 외주 업체 선정은 보류한다.\n`,
    'notes/todo.md': '# 할 일\n- 견적 정리\n- 주간 보고\n' } },
  code: { say: 'src/price.mjs 의 applyDiscount 는 10만 원 이상이면 몇 퍼센트를 깎아?', fact: '15%', folder: {
    'package.json': '{ "name": "price-demo", "type": "module", "scripts": { "test": "node --test" } }\n',
    'src/price.mjs': `// 가격 계산\nexport const round = value => Math.round(value)\n${filler(5).replace(/메모/g, '//')}\n// 할인: 10만 원 이상이면 15%, 5만 원 이상이면 5%를 깎는다.\nexport function applyDiscount(total) {\n  if (total >= 100000) return round(total * 0.85)\n  if (total >= 50000) return round(total * 0.95)\n  return total\n}\n`,
    'src/tax.mjs': '// 세금\nexport const tax = value => Math.round(value * 0.1)\n',
    'test/price.test.mjs': "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { applyDiscount } from '../src/price.mjs'\ntest('no discount under 50k', () => assert.equal(applyDiscount(40000), 40000))\n" } },
  ledger: { say: 'ledger/2026-11.md 기준으로 11월 식비 합계가 얼마야?', fact: '312,400원', folder: {
    'ledger/README.md': '# 장부\n월별 파일에 항목을 적는다.\n',
    'ledger/2026-08.md': `# 8월\n${filler(5)}\n식비 합계: 288,000원\n`,
    'ledger/2026-09.md': `# 9월\n${filler(5)}\n식비 합계: 301,500원\n`,
    'ledger/2026-10.md': `# 10월\n${filler(5)}\n식비 합계: 295,200원\n`,
    'ledger/2026-11.md': `# 11월\n${filler(7)}\n식비 합계: 312,400원\n${filler(3)}\n` } },
})
export function buildPrefetchScript() {
  const conv = (name, on) => ({ id: `${name}-${on ? 'on' : 'off'}`, folder: PREFETCH_SCENARIOS[name].folder,
    flags: { EGDESK_TURN_MEMORY_PRUNE_HELD: 'on', EGDESK_TURN_MEMORY_ENGINE_CONTEXT: 'split', ...(on ? { EGDESK_TURN_MEMORY_PREFETCH: 'files' } : {}) },
    turns: [{ say: PREFETCH_SCENARIOS[name].say, expect: { posted: true, answerIncludes: [PREFETCH_SCENARIOS[name].fact], turnStatus: 'completed', ...(on ? { noToolCalls: true } : {}) } }] })
  return { set: PREFETCH_SET,
    description: 'Pattern: the engine reads a named file of its folder (off) or is handed it in the turn context by code after the decision model picked it (on, EGDESK_TURN_MEMORY_PREFETCH=files). Notes, coding and ledger style questions about one named file of a small synthetic folder, a pair of conversations each (-off, -on, otherwise identical, the engine-context split on in both). Both must answer with the fact only that file holds; -on must make no EG-Desk tool call. The comparison is the record\'s tool calls, items, latency and tokens (scripts/egdesk-prefetch-compare.mjs). Needs --decisions.',
    conversations: ['notes', 'code', 'ledger'].flatMap(name => [conv(name, false), conv(name, true)]) }
}
