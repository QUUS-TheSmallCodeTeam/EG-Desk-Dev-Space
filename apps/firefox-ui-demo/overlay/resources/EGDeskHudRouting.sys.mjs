// Desk HUD routing, window half (L1 c20; Decision Model design Pillar 4 as reviewed: "명시 대상과 허용 command 우선. 추천 도착만으로 실행·focus 전환하지
// 않음", CHAT-01 / AGENT-01 / UX-01). The Desk's search field (Ctrl/⌘ K, UX-04) already lists rows for what is typed: open cards, rooms,
// Boards, history and files, the web row, and the "ask an Agent" row, and plain Enter runs the highlighted row (the first one unless the
// person moved it). This module only decides WHICH ROW IS HIGHLIGHTED:
//   1. code first (R3): an address, or the exact name of one open card / room / Board, routes by rule with no model call; a slash word or a
//      terminal-looking command is recognised by rule and left as it is today (this field has no slash commands and no terminal row);
//   2. for the rest the candidates are built from the rows that exist now (U2): an open card whose words may leave (maySend, the same
//      per-card rule as every canvas text), the web row, the "ask an Agent" row; the bridge asks one yes/no predicate per candidate;
//   3. code ranks (R2): exactly one desk item yes and every other item no; else the request row or the web row when exactly one of them is
//      yes and the other no; anything else keeps today's highlight.
// Hard rules: nothing runs, opens, sends or takes focus because an answer arrived. A suggestion only moves the highlight in the open list,
// only while the typed text is unchanged and the person has not moved the highlight themselves. An Enter that lands within one reaction
// time after the highlight moved runs the row the person saw before it moved. Default off (pref egdesk.hudRouting).

export const HUD_ROUTING_PREF = 'egdesk.hudRouting';
export const HUD_ROUTING_LIMITS = Object.freeze({ debounceMs: 300, waitMs: 1500, enterGuardMs: 300, items: 4 });
export const HUD_ROUTING_BARS = Object.freeze({ yes: 0.8, no: 0.2 });
export const hudRoutingMode = value => (value === 'advisory' || value === 'on' ? value : 'off');

const norm = text => String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const NAMED = new Set(['card', 'thread', 'agenda']);
// A command line, by its shape (R3): a prompt sign, a path to run, a common CLI word first, chained or piped commands, or a flag.
const COMMAND = /^(?:\$\s+|\.{1,2}\/|~\/)|^(?:sudo|git|npm|npx|pnpm|yarn|node|deno|bun|python3?|pip3?|brew|docker|kubectl|make|cargo|go|ls|cd|cat|rm|mv|cp|mkdir|curl|wget|kill|lsof|ps|grep|chmod|ssh)(?:\s|$)|\s(?:&&|\|\||\|)\s|\s--?[a-z][\w-]*/i;
export const looksLikeCommand = query => COMMAND.test(String(query ?? '').trim());

/**
 * explicitRoute(query, rows, { looksLikeNavigation }) -> { rule, key } | null. Code only; no model call for any of these.
 *   address: the field's own navigation test (the web row then opens that address)
 *   name:    exactly one open card / room / Board whose name is exactly the typed text
 *   slash / command: recognised and left as today (key null): nothing to route to in this field
 */
export function explicitRoute(query, rows = [], { looksLikeNavigation = () => false } = {}) {
  const q = norm(query);
  if (!q) return null;
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (looksLikeNavigation(String(query ?? '').trim())) { const web = list.find(row => row.type === 'web'); return web ? { rule: 'address', key: web.key } : null; }
  const named = list.filter(row => NAMED.has(row.type) && norm(row.title) === q);
  if (named.length === 1) return { rule: 'name', key: named[0].key };
  if (q.startsWith('/')) return { rule: 'slash', key: null };
  if (looksLikeCommand(query)) return { rule: 'command', key: null };
  return null;
}

/**
 * routingCandidates(rows, { quoteOf }) -> { wire, keyOf } | null. U2: only what the list holds right now.
 *   quoteOf(row) -> { label, excerpt } for an open card whose words may leave (maySend), else null (that card is not asked about).
 *   wire: what the bridge receives (aliases I1.. and closed kinds; no card id, no key); keyOf: alias/kind -> the row key, kept here.
 */
export function routingCandidates(rows = [], { quoteOf = () => null } = {}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const wire = [], keyOf = new Map();
  for (const row of list) {
    if (row.type !== 'card' || wire.filter(c => c.kind === 'item').length >= HUD_ROUTING_LIMITS.items) continue;
    let quote = null;
    try { quote = quoteOf(row); } catch { quote = null; }
    if (!quote?.label) continue;
    const alias = `I${wire.length + 1}`;
    wire.push({ kind: 'item', alias, label: String(quote.label), ...(quote.excerpt ? { excerpt: String(quote.excerpt) } : {}) });
    keyOf.set(alias, row.key);
  }
  const web = list.find(row => row.type === 'web'), ask = list.find(row => row.type === 'ask');
  if (web) { wire.push({ kind: 'web' }); keyOf.set('web', web.key); }
  if (ask) { wire.push({ kind: 'ask' }); keyOf.set('ask', ask.key); }
  return wire.length ? { wire, keyOf } : null;
}

const nameOf = c => (c.kind === 'item' ? `goes_to_${c.alias}` : c.kind === 'web' ? 'web_search' : 'assistant_request');
/** rankRoute(candidates, answers, bars) -> { key, kind } | null. Code combines the predicates (R2); undecided keeps today's highlight. */
export function rankRoute(candidates, answers = {}, bars = HUD_ROUTING_BARS) {
  if (!candidates?.wire?.length) return null;
  const p = c => (typeof answers?.[nameOf(c)] === 'number' ? answers[nameOf(c)] : null);
  const yes = c => p(c) !== null && p(c) >= bars.yes, no = c => p(c) !== null && p(c) <= bars.no;
  const items = candidates.wire.filter(c => c.kind === 'item');
  const itemYes = items.filter(yes);
  if (itemYes.length === 1 && items.every(c => c === itemYes[0] || no(c))) return { key: candidates.keyOf.get(itemYes[0].alias), kind: 'item' };
  if (itemYes.length > 1 || items.some(c => !yes(c) && !no(c))) return null; // two desk items, or one undecided: not ours to pick
  const web = candidates.wire.find(c => c.kind === 'web'), ask = candidates.wire.find(c => c.kind === 'ask');
  if (ask && yes(ask) && (!web || no(web))) return { key: candidates.keyOf.get('ask'), kind: 'ask' };
  if (web && yes(web) && (!ask || no(ask))) return { key: candidates.keyOf.get('web'), kind: 'web' };
  return null;
}

/** The row an Enter runs: the highlighted one, except within enterGuardMs after a suggestion moved it (then the row seen before). */
export function hudEnterIndex({ activeIndex = 0, suggestion = null, now = 0, guardMs = HUD_ROUTING_LIMITS.enterGuardMs } = {}) {
  if (suggestion && Number.isInteger(suggestion.previous) && suggestion.index === activeIndex && now - suggestion.at >= 0 && now - suggestion.at < guardMs) return suggestion.previous;
  return activeIndex;
}
