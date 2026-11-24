// Secret masking for material that leaves the person's machine in a Decision request (conversation examples; any future scenario source).
// Always applied: credentials, tokens, API keys, email addresses, phone numbers, account ids, URLs with a query string. Names stay.
// (Moved out of the docs-based seed extractor, which was dropped in L3 c20: the owner re-scoped the scenarios to conversation behaviour.)
const SECRET_PATTERNS = [
  ['[key]', /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g],
  ['[key]', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ['[key]', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ['[key]', /\bAKIA[0-9A-Z]{16}\b/g],
  ['[url]', /\bhttps?:\/\/[^\s)"'`,]*\?[^\s)"'`,]*/g],
  ['[token]', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g],
  ['[token]', /\b(?:bearer|token|password|passwd|secret|api[_-]?key)\s*[:=]\s*\S+/gi],
  ['[email]', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ['[phone]', /(?<![\d.-])(?:\+?82[-\s]?)?0\d{1,2}[-\s]\d{3,4}[-\s]\d{4}(?![\d-])/g],
  ['[account]', /\b(?:acct|account|acc)[_-]?(?:id)?\s*[:=#]\s*[A-Za-z0-9-]{4,}/gi],
]
/** maskSecrets(text) → text with credentials, tokens, API keys, emails, phone numbers, account ids and query-string URLs masked. */
export function maskSecrets(text) {
  let out = String(text)
  for (const [mark, pattern] of SECRET_PATTERNS) out = out.replace(pattern, mark)
  return out
}
/** secretsIn(text) → the kinds of secret still present (empty when maskSecrets has nothing left to do). */
export function secretsIn(text) {
  return [...new Set(SECRET_PATTERNS.filter(([, pattern]) => new RegExp(pattern.source, pattern.flags.replace('g', '')).test(String(text))).map(([mark]) => mark))]
}
