import { CLAUDE_MCP_OUTPUT_LIMIT_TOKENS, claudeToolResultBound } from './egdesk-claude-limits.mjs'
import { callToolResultFromResponse } from './egdesk-claude-mcp.mjs'
import { WM_KINDS, WM_LIMITS, enumerateBlockOptions, gateToolOutput, gateToolResponse, ruleAction, toolResponseText } from './egdesk-working-memory-gate.mjs'

// Working-memory gate at the EG-Desk tool-result boundary (codex-chat-runtime dispatchToolProvider).
//
// What passes here: the result an EG-Desk tool provider RETURNS for a model's tool call, before it is handed to the engine.
// What never passes here, by construction:
//   - context reads (egdesk_read_source / egdesk_list_context): the context runtime answers those itself with receipt-hashed
//     packets and returns nothing to this boundary; this module also refuses that provider explicitly;
//   - anything engine-native (the engine's own shell, MCP, sub-agents, history): it never reaches EG-Desk code.
// A provider opts a tool in by declaring what its result is:  provider.workingMemory = { tool_name: { kind, jsonTextArray? } }
// (kind is a WM_KINDS word; jsonTextArray is the one array of strings inside a JSON result that is free text). An undeclared
// tool is untouched, except for the Claude over-limit case below.
//
// Flag (decisionContext.workingMemory.mode, default absent = off; with it off this module is never called):
//   advisory  the result is unchanged; one content-free record says what the code rules would have done
//   on        the CODE RULES act (no Decision call decides anything): anchors stay verbatim, repetitive blocks become fixed lines,
//             with a re-read pointer when this run can really re-read (context binding with read), otherwise only process output collapses
// In both modes the Decision judge is advisory only, never awaited, and asked only about non-repetitive text the rules left in
// place (>= WM_JUDGE_MIN_TOKENS), and only when the Decision mode is advisory/on, a key is saved and the run's own model
// permissions allow that kind of text (shared egress gate).
// Claude over-limit: a result whose MCP bound exceeds the Claude tool-output limit would become an error downstream. With the flag
// on it is gated regardless of size first; if it is still over the limit it is returned unchanged and today's error applies.

export const WM_JUDGE_MIN_TOKENS = 2750

/** The declared consumer of a tool result, or null. Own properties only; an unknown kind is ignored. */
export function toolResultConsumer({ provider, tool, namespace = null, contexts = null }) {
  if (!provider || provider === contexts || namespace || typeof tool !== 'string') return null
  const table = provider.workingMemory
  const entry = table && typeof table === 'object' && Object.hasOwn(table, tool) ? table[tool] : null
  if (!entry || !Object.hasOwn(WM_KINDS, entry.kind)) return null
  const path = Array.isArray(entry.jsonTextArray) && entry.jsonTextArray.length && entry.jsonTextArray.every(key => typeof key === 'string') ? [...entry.jsonTextArray] : null
  return { kind: entry.kind, jsonTextArray: path }
}

export function claudeOverLimit(response, engineId, limitTokens = CLAUDE_MCP_OUTPUT_LIMIT_TOKENS) {
  return engineId === 'claude' && claudeToolResultBound(callToolResultFromResponse(response)) > limitTokens
}

/**
 * gateRuntimeToolResult({ response, flag, provider, tool, namespace, engineId, run, contexts, goal?, paths?, egress?, decision?, calibrationLog?, limits? })
 *  → { response, touched, reason?, report?, judge? }
 * `response` is returned as the same object whenever nothing is applied. `judge` is the not-awaited advisory promise (tests only).
 */
export async function gateRuntimeToolResult({ response, flag, provider, tool, namespace = null, engineId = 'codex', run = null, contexts = null, goal = '', paths = [],
  egress = null, decision = null, calibrationLog = null, limits = WM_LIMITS, claudeLimitTokens = CLAUDE_MCP_OUTPUT_LIMIT_TOKENS } = {}) {
  const same = reason => ({ response, touched: false, reason })
  if (flag !== 'advisory' && flag !== 'on') return same('flag_off')
  if (provider === contexts) return same('receipt_hashed')
  const declared = toolResultConsumer({ provider, tool, namespace, contexts })
  const overLimit = claudeOverLimit(response, engineId, claudeLimitTokens)
  const consumer = declared || (overLimit ? { kind: 'tool', jsonTextArray: null } : null)
  if (!consumer) return same('undeclared')
  const target = toolResponseText(response, consumer.jsonTextArray)
  if (target.reason) return same(target.reason)
  let canSpill = false
  try { canSpill = contexts?.canSpill?.(run) === true } catch { canSpill = false }
  const spill = canSpill ? { put: text => contexts.spillToolOutput(run, { text, tool }) } : null
  const useLimits = overLimit ? { ...limits, minTokens: 0, minGain: 0 } : limits
  const options = { jsonTextArray: consumer.jsonTextArray, kind: consumer.kind, goal, paths, rules: true, client: null, spill, limits: useLimits }
  let gated = await gateToolResponse(response, { ...options, mode: 'on', enabled: flag === 'on' })
  // The over-limit case exists to avoid an error. A result that is still too large is handed on unchanged (today's error).
  if (gated.touched && overLimit && claudeOverLimit(gated.response, engineId, claudeLimitTokens)) gated = { ...gated, touched: false, reason: 'still_over_limit', response }
  const plan = gated.plan || gated.shadow?.plan || []
  const tokensAfter = gated.touched ? gated.tokensAfter : gated.shadow?.tokensAfter ?? gated.tokensBefore
  const report = { kind: consumer.kind, by: plan.some(row => row.action !== 'inject_full') ? 'rules' : 'none', blocks: plan.length, omittedBlocks: plan.filter(row => row.action !== 'inject_full').length,
    linesBefore: target.text.split('\n').length, tokensBefore: gated.tokensBefore, tokensAfter, spill: canSpill, ...(overLimit ? { overLimit: true } : {}) }
  if (gated.reason !== 'below_threshold') {
    try { calibrationLog?.record?.({ feature: 'working_memory', mode: flag, judgments: [], attached: gated.touched === true, candidates: plan.length, wm: report }) } catch { /* recording never changes a result */ }
  }
  const judge = adviseOnProse({ text: target.text, consumer, goal, paths, egress, decision, calibrationLog, limits })
  return { response: gated.touched ? gated.response : response, touched: gated.touched === true, reason: gated.reason ?? null, report, ...(gated.spillId ? { spillId: gated.spillId } : {}), ...(judge ? { judge } : {}) }
}

// The advisory Decision judge. Never awaited by the tool result; it only writes a calibration record.
function adviseOnProse({ text, consumer, goal, paths, egress, decision, calibrationLog, limits }) {
  try {
    const mode = decision?.mode?.()
    if ((mode !== 'advisory' && mode !== 'on') || decision.configured?.() !== true || !decision.client?.decide) return null
    const kindEgress = WM_KINDS[consumer.kind].egress
    if (!kindEgress || egress?.allows?.(kindEgress) !== true) return null
    const { blocks } = enumerateBlockOptions(text, { kind: consumer.kind, paths, goal, canSpill: true, limits })
    const leftByRules = blocks.filter(block => block.options.length > 1 && ruleAction(block, consumer.kind) === 'inject_full').reduce((sum, block) => sum + block.tokens, 0)
    if (leftByRules < WM_JUDGE_MIN_TOKENS) return null
    const calibration = calibrationLog?.record ? { record: raw => calibrationLog.record({ ...raw, mode: 'advisory', attached: false }) } : null
    // mode 'advisory' in the gate: ask, record, change nothing, write nothing. The spill object only makes the option visible.
    return gateToolOutput({ text, kind: consumer.kind, goal, paths, mode: 'advisory', client: decision.client, egress, calibration, spill: { put: () => null }, limits })
      .then(result => ({ requests: result.requests, shadow: result.shadow ?? null, fallback: result.fallback ?? null }), () => null)
  } catch { return null }
}
