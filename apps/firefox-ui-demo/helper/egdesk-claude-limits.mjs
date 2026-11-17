// Limits shared by every Claude process EG-Desk starts (SUB-09 / SUB-10).
//
// 1. One process budget for parent conversations AND source Readers. Before
//    this, the adapter allowed two parent processes and the Reader client two
//    Readers independently, so four `claude` processes could run at once
//    (engine design §14.9 item 3). The budget is a plain counter: a lease is
//    taken before spawn and given back only when the owned process has exited
//    (or never spawned). A Reader whose stop is unconfirmed keeps its lease.
// 2. The MCP tool-output ceiling applied to the parent process. EG-Desk sets
//    the documented MAX_MCP_OUTPUT_TOKENS variable on the child it spawns and
//    its own 'sdk' MCP server refuses any result whose bound exceeds it, so
//    the ceiling Claude enforces and the one EG-Desk measures are the same
//    number (no clipping: an oversized result becomes a tool error).
//
// Pure: no I/O, no clock, no process.

/** Inferred (documented precedent: design §9 two parents; B3 two Readers).
 * Total 3 keeps one Reader possible while two parents are resident. */
export const CLAUDE_PROCESS_BUDGET_DEFAULTS = Object.freeze({ total: 3, parent: 2, reader: 2 })

/** MAX_MCP_OUTPUT_TOKENS EG-Desk gives the parent `claude`. Documented CLI
 * variable (code.claude.com/docs/en/mcp "MCP output limits"; default 25,000,
 * warning above 10,000). EG-Desk keeps it at the warning threshold. */
export const CLAUDE_MCP_OUTPUT_LIMIT_TOKENS = 10000
/** Per image block, the documented upper bound for an image at the default
 * resize (~1.15 MP / 750 ≈ 1,600 tokens, docs.claude.com vision). */
export const CLAUDE_IMAGE_TOKEN_BOUND = 1600
/** Version label for the byte bound below (see claudeToolResultBound). */
export const CLAUDE_UTF8_ESTIMATOR = Object.freeze({ kind: 'utf8-upper-bound', verified: true, version: 'utf8-bytes-per-bpe-token-v1' })

const positive = value => Number.isSafeInteger(value) && value > 0

/**
 * createClaudeProcessBudget({ total, parent, reader })
 *   tryAcquire(kind, owner?) → lease { kind, release() } | null
 *   available(kind) → boolean        snapshot() → { total, parent, reader, limits }
 * release() is idempotent; a lease released twice frees one slot only.
 */
export function createClaudeProcessBudget(options = {}) {
  const limits = { ...CLAUDE_PROCESS_BUDGET_DEFAULTS }
  for (const key of Object.keys(limits)) if (options[key] !== undefined) {
    if (!positive(options[key])) throw new TypeError(`Invalid Claude process budget: ${key}`)
    limits[key] = options[key]
  }
  if (limits.parent > limits.total || limits.reader > limits.total) throw new TypeError('A Claude process kind cannot exceed the total budget')
  const held = { parent: 0, reader: 0 }
  const total = () => held.parent + held.reader
  const available = kind => {
    if (!Object.hasOwn(held, kind)) throw new TypeError(`Unknown Claude process kind: ${kind}`)
    return held[kind] < limits[kind] && total() < limits.total
  }
  return {
    limits: Object.freeze({ ...limits }),
    available,
    tryAcquire(kind) {
      if (!available(kind)) return null
      held[kind]++
      let released = false
      return Object.freeze({ kind, release() {
        if (released) return false
        released = true
        held[kind]--
        return true
      } })
    },
    snapshot: () => ({ total: total(), parent: held.parent, reader: held.reader, limits: { ...limits } }),
  }
}

/**
 * Upper bound, in tokens, of one MCP CallToolResult as Claude counts it.
 * Text: UTF-8 bytes. Claude's tokenizer is a byte-level BPE, so every token
 * covers at least one byte and bytes >= tokens [추정: tokenizer property, not a
 * published Anthropic guarantee]. JSON framing of the result is counted too.
 * Image/audio blocks: CLAUDE_IMAGE_TOKEN_BOUND each (their base64 is not text).
 */
export function claudeToolResultBound(result) {
  const content = Array.isArray(result?.content) ? result.content : []
  let bound = Buffer.byteLength(JSON.stringify({ ...result, content: [] }), 'utf8')
  for (const block of content) {
    if (block?.type === 'image' || block?.type === 'audio') bound += CLAUDE_IMAGE_TOKEN_BOUND + 64
    else bound += Buffer.byteLength(JSON.stringify(block ?? null), 'utf8')
  }
  return bound
}

/** extraEnv for a parent `claude` (the value is EG-Desk's, never inherited). */
export function claudeParentLimitEnv(limit = CLAUDE_MCP_OUTPUT_LIMIT_TOKENS) {
  if (!positive(limit)) throw new TypeError('MCP output limit must be a positive integer')
  return { MAX_MCP_OUTPUT_TOKENS: String(limit) }
}
