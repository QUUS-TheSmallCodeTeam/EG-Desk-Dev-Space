// Claude approvals and questions over the stdio control channel (SUB-09).
//
// Patterns followed (rewritten here, not copied):
//   anthropics/claude-agent-sdk-python (MIT, Copyright (c) Anthropic, PBC):
//     _internal/query.py _handle_control_request — control_request/can_use_tool
//     in, control_response {subtype:'success'|'error'} out, PermissionResult wire
//     fields (behavior, updatedInput defaulting to the original input,
//     updatedPermissions, message, interrupt); types.py SDKControlPermissionRequest
//     and PermissionUpdate (destination 'session').
//   agentclientprotocol/claude-agent-acp (Apache-2.0):
//     src/elicitation.ts applyAskElicitationResponse — a skipped question is an
//     allow with empty answers (Claude is told the user skipped), cancel aborts,
//     multi-select answers are comma joined with JSON-quoted items;
//     src/permissions/normalization.ts — suggestions are validated and snapshot.
//   pingdotgg/t3code (MIT, Copyright (c) 2026 T3 Tools Inc.):
//     ClaudeAdapterV2.ts permissionResultFromDecision / toSessionPermissionUpdates
//     — acceptForSession turns suggestions into destination 'session' rules,
//     cancel is deny + interrupt.
//
// Direction: the Claude CLI started with `--permission-prompt-tool stdio` (what
// the official SDK does when a canUseTool callback is set) writes
// control_request lines. This module turns one can_use_tool request into the
// Codex-shaped server request the chat runtime already handles
// (item/commandExecution/requestApproval, item/fileChange/requestApproval,
// item/tool/requestUserInput) and turns the runtime's reply back into the
// control_response line. The runtime keeps every existing rule (run binding,
// bounded QA refusals, Agent ceiling, redaction).
//
// Pure: no I/O, no clock, no process, no logging. Tool inputs and question
// texts live only in the in-memory pending record until the reply; they are
// never put in a notification and must never be persisted (question texts are
// object keys in the answer Claude reads, see askAnswersToUpdatedInput).

export const CLAUDE_PERMISSION_LIMITS = Object.freeze({
  maxPending: 100, // the runtime keeps at most 100 pending approvals (MAX_ITEMS)
  maxInputChars: 8 * 1024 * 1024, // same as one translated stream-json line
  maxQuestions: 8, // runtime MAX_INPUT_QUESTIONS (Claude itself sends 1-4)
  maxOptions: 12, // runtime MAX_INPUT_OPTIONS (Claude itself sends 2-4)
  maxHeader: 200,
  maxQuestion: 2000,
  maxLabel: 200,
  maxDescription: 1000,
  maxAnswer: 4000, // runtime MAX_INPUT_ANSWER
  maxReason: 2000,
  maxSuggestions: 100,
  maxRules: 100,
  maxRuleContent: 10000,
  maxDirectory: 4096,
})

// The chat runtime answers a skipped question with this JSON-RPC error
// (codex-chat-runtime.mjs replyUserInput). It is the only error that means
// "skip"; every other error is a refusal.
export const USER_SKIPPED_CODE = -32000
export const USER_SKIPPED_MESSAGE = 'User skipped the question'

export const APPROVAL_DECISIONS = Object.freeze(['accept', 'acceptForSession', 'decline', 'cancel'])

const COMMAND_TOOLS = new Set(['Bash', 'PowerShell'])
// Same table as claude-stream-translate.mjs FILE_TOOLS (path field per tool).
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const QUESTION_TOOL = 'AskUserQuestion'
// Outgoing control requests the SDK sends (query.py); anything else is refused.
const OUTGOING_SUBTYPES = new Set(['initialize', 'interrupt', 'set_model', 'set_permission_mode', 'mcp_status', 'get_context_usage', 'stop_task'])
const SESSION_MODES = new Set(['acceptEdits', 'default', 'plan'])

const METHOD = Object.freeze({
  commandExecution: 'item/commandExecution/requestApproval',
  fileChange: 'item/fileChange/requestApproval',
  userInput: 'item/tool/requestUserInput',
})

// Messages Claude reads after a refusal. Fixed wording; never input text.
const TEXT = Object.freeze({
  declined: 'User declined tool execution.',
  cancelled: 'User cancelled tool execution.',
  notGranted: 'EG-Desk did not grant this tool.',
  unreadable: 'EG-Desk could not read this permission request; nothing was granted.',
  tooMany: 'Too many pending EG-Desk approvals; nothing was granted.',
  approvalUnavailable: 'EG-Desk could not show this approval; nothing was granted.',
  sessionUnavailable: 'No valid session permission rule is available; choose a one-time approval instead.',
  questionUnavailable: 'EG-Desk could not show this question to the user.',
  invalidQuestions: 'AskUserQuestion called with no valid questions.',
  unsupportedTool: 'EG-Desk cannot ask the user to approve this tool yet; it was not run.',
  unsupportedControl: 'Unsupported control request subtype',
})

const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null
const idText = value => typeof value === 'string' && value.length > 0 && value.length <= 300 ? value : null
const toolName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : null
const subtypeToken = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null
const shortText = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit && !value.includes('\0') ? value : null
// Control characters other than tab, line feed and carriage return.
const plainString = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)

function snapshot(value, limit) {
  try {
    const text = JSON.stringify(value)
    if (typeof text !== 'string' || text.length > limit) return null
    return JSON.parse(text)
  } catch { return null }
}

/**
 * One parsed CLI stdout object → which channel it belongs to.
 *   { kind: 'canUseTool' | 'mcpMessage' | 'hookCallback' | 'otherRequest', requestId, subtype, request }
 *   { kind: 'controlCancel', requestId }
 *   { kind: 'controlResponse', requestId, ok, response, error }
 *   { kind: 'sdkMessage' }  — everything else goes to claude-stream-translate
 *   { kind: 'invalid' }
 */
export function classifyControlMessage(value) {
  const msg = plainObject(value)
  if (!msg || typeof msg.type !== 'string') return { kind: 'invalid' }
  if (msg.type === 'control_request') {
    const requestId = idText(msg.request_id)
    const request = plainObject(msg.request)
    const subtype = subtypeToken(request?.subtype)
    if (!requestId || !subtype) return { kind: 'invalid' }
    const kind = subtype === 'can_use_tool' ? 'canUseTool' : subtype === 'mcp_message' ? 'mcpMessage' : subtype === 'hook_callback' ? 'hookCallback' : 'otherRequest'
    return { kind, requestId, subtype, request }
  }
  if (msg.type === 'control_cancel_request') {
    const requestId = idText(msg.request_id)
    return requestId ? { kind: 'controlCancel', requestId } : { kind: 'invalid' }
  }
  if (msg.type === 'control_response') {
    const response = plainObject(msg.response)
    const requestId = idText(response?.request_id)
    if (!requestId) return { kind: 'invalid' }
    const ok = response.subtype === 'success'
    return { kind: 'controlResponse', requestId, ok, response: ok ? plainObject(response.response) || {} : null, error: ok ? null : (typeof response.error === 'string' ? response.error.slice(0, 500) : 'error') }
  }
  return { kind: 'sdkMessage' }
}

/** The control_response line object answering a CLI control request. */
export function controlSuccessResponse(requestId, response) {
  if (!idText(requestId)) throw new TypeError('controlSuccessResponse requires a request id')
  return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }
}

/** The error control_response (the CLI fails that one request). */
export function controlErrorResponse(requestId, message) {
  if (!idText(requestId)) throw new TypeError('controlErrorResponse requires a request id')
  return { type: 'control_response', response: { subtype: 'error', request_id: requestId, error: typeof message === 'string' && message ? message.slice(0, 500) : 'error' } }
}

/** An outgoing control request (interrupt, initialize, set_model, ...). */
export function buildControlRequest(requestId, subtype, fields = {}) {
  if (!idText(requestId)) throw new TypeError('buildControlRequest requires a request id')
  if (!OUTGOING_SUBTYPES.has(subtype)) throw new TypeError(`Unsupported outgoing control request: ${subtype}`)
  return { type: 'control_request', request_id: requestId, request: { ...(plainObject(fields) || {}), subtype } }
}

// Suggestions the CLI attached (permission_suggestions). Kept only when every
// entry is a known allow-side update; a session grant never widens to
// bypassPermissions/auto/dontAsk or to rule removal.
function normalizeSuggestions(value, L) {
  if (!Array.isArray(value) || !value.length || value.length > L.maxSuggestions) return null
  const out = []
  for (const raw of value) {
    const update = plainObject(raw)
    if (!update) return null
    if (update.type === 'addRules') {
      if (update.behavior !== 'allow' || !Array.isArray(update.rules) || !update.rules.length || update.rules.length > L.maxRules) return null
      const rules = []
      for (const rule of update.rules) {
        if (!plainObject(rule) || !plainString(rule.toolName, 512)) return null
        if (rule.ruleContent != null && !plainString(rule.ruleContent, L.maxRuleContent)) return null
        rules.push(rule.ruleContent == null ? { toolName: rule.toolName } : { toolName: rule.toolName, ruleContent: rule.ruleContent })
      }
      out.push({ type: 'addRules', rules, behavior: 'allow' })
    } else if (update.type === 'addDirectories') {
      if (!Array.isArray(update.directories) || !update.directories.length || update.directories.length > L.maxRules || !update.directories.every(dir => plainString(dir, L.maxDirectory))) return null
      out.push({ type: 'addDirectories', directories: [...update.directories] })
    } else if (update.type === 'setMode') {
      if (!SESSION_MODES.has(update.mode)) return null
      out.push({ type: 'setMode', mode: update.mode })
    } else return null
  }
  return out
}

// AskUserQuestion input → runtime questions (q<index> ids) + the private texts.
function questionsOf(input, L) {
  const list = Array.isArray(input.questions) ? input.questions : null
  if (!list || !list.length || list.length > L.maxQuestions) return null
  const seen = new Set(), questions = [], texts = []
  for (const [index, raw] of list.entries()) {
    const q = plainObject(raw)
    const text = q && shortText(q.question, L.maxQuestion)
    // Answers are keyed by question text, so texts must be unique.
    if (!text || seen.has(text)) return null
    seen.add(text)
    const header = q.header == null ? '' : typeof q.header === 'string' && q.header.length <= L.maxHeader ? q.header : null
    if (header === null) return null
    const options = Array.isArray(q.options) ? q.options : []
    if (options.length > L.maxOptions) return null
    const publicOptions = []
    for (const option of options) {
      const o = plainObject(option)
      const label = o && shortText(o.label, L.maxLabel)
      if (!label) return null
      const description = o.description == null ? null : typeof o.description === 'string' && o.description.length <= L.maxDescription ? o.description : null
      publicOptions.push({ label, description })
    }
    const multiSelect = q.multiSelect === true
    questions.push({ id: `q${index}`, header, question: text, options: publicOptions.length ? publicOptions : null, ...(multiSelect ? { multiSelect } : {}) })
    texts.push({ text, multiSelect })
  }
  return { questions, texts }
}

/**
 * routePermissionRequest(request, { threadId, turnId, rpcId, requestId?, cwd?, egdeskServer?, offerSessionGrant?, limits? })
 *
 * request is the `request` object of a can_use_tool control_request.
 * Returns one of
 *   { route: 'approval' | 'userInput', serverRequest: { id, method, params }, pending }
 *       → hand serverRequest to runtime.handleServerRequest; keep pending
 *         (private) until the runtime replies through respond(rpcId, ...)
 *   { route: 'allow' | 'deny', result, reason }
 *       → answer now with controlSuccessResponse(requestId, result)
 * EG-Desk's own MCP tools are allowed here: their authority is checked per
 * call by the runtime's item/tool/call path (run binding, execution policy,
 * Agent ceiling), exactly as Codex dynamic tools are.
 */
export function routePermissionRequest(request, { threadId, turnId = null, rpcId, requestId = null, cwd = null, egdeskServer = 'egdesk', offerSessionGrant = false, limits = {} } = {}) {
  const L = { ...CLAUDE_PERMISSION_LIMITS, ...limits }
  if (!idText(threadId)) throw new TypeError('routePermissionRequest requires a threadId')
  if (!(typeof rpcId === 'string' ? idText(rpcId) : Number.isSafeInteger(rpcId))) throw new TypeError('routePermissionRequest requires an rpcId')
  const deny = (reason, message) => ({ route: 'deny', reason, result: { behavior: 'deny', message } })
  const r = plainObject(request)
  const name = toolName(r?.tool_name)
  const toolUseId = idText(r?.tool_use_id)
  const rawInput = plainObject(r?.input)
  if (!name || !toolUseId || !rawInput) return deny('invalidRequest', TEXT.unreadable)
  const input = snapshot(rawInput, L.maxInputChars)
  if (!input) return deny('invalidRequest', TEXT.unreadable)

  const server = typeof egdeskServer === 'string' && egdeskServer ? egdeskServer : null
  if (server && name.startsWith(`mcp__${server}__`) && name.length > server.length + 7) {
    return { route: 'allow', reason: 'egdeskTool', result: { behavior: 'allow', updatedInput: input } }
  }
  const base = { threadId, turnId: idText(turnId), itemId: toolUseId }
  const pending = (kind, extra = {}) => Object.freeze({
    rpcId, requestId: idText(requestId), kind, toolName: name, toolUseId, agentId: idText(r.agent_id),
    threadId, turnId: base.turnId, input, ...extra,
  })

  if (name === QUESTION_TOOL) {
    const parsed = questionsOf(input, L)
    if (!parsed) return deny('invalidQuestions', TEXT.invalidQuestions)
    return {
      route: 'userInput',
      serverRequest: { id: rpcId, method: METHOD.userInput, params: { ...base, isBlocking: true, questions: parsed.questions } },
      pending: pending('userInput', { questions: Object.freeze(parsed.texts.map(Object.freeze)) }),
    }
  }
  const kind = COMMAND_TOOLS.has(name) ? 'commandExecution' : FILE_TOOLS.has(name) ? 'fileChange' : null
  if (!kind) return deny('unsupportedTool', TEXT.unsupportedTool)
  // The CLI's own short title of the request (e.g. "Claude wants to edit a.js").
  const reason = [r.title, r.description, r.decision_reason].find(value => shortText(value, L.maxReason)) || null
  const approval = pending(kind, { suggestions: normalizeSuggestions(r.permission_suggestions, L) })
  const canGrantSession = offerSessionGrant && sessionUpdates(approval).length > 0
  const params = {
    ...base,
    ...(reason ? { reason } : {}),
    ...(kind === 'commandExecution' ? { command: typeof input.command === 'string' ? input.command : null, cwd: typeof cwd === 'string' ? cwd : null } : {}),
    availableDecisions: canGrantSession ? ['accept', 'acceptForSession', 'decline', 'cancel'] : ['accept', 'decline', 'cancel'],
  }
  return {
    route: 'approval',
    serverRequest: { id: rpcId, method: METHOD[kind], params },
    pending: approval,
  }
}

// Only actual, sanitized CLI allow rules for this tool can support a session
// choice. Never synthesize a broad rule, silently turn that choice into one-off
// permission, or treat a mode/directory change as a session rule for this tool.
function sessionUpdates(pending) {
  if (!pending.suggestions?.length || pending.suggestions.some(update => update.type !== 'addRules' ||
      update.rules.some(rule => rule.toolName !== pending.toolName))) return []
  return pending.suggestions.map(update => ({ ...structuredClone(update), destination: 'session' }))
}

/** Runtime approval decision → PermissionResult. Unknown decisions are refused. */
export function approvalToPermissionResult(pending, decision) {
  if (!pending || !['commandExecution', 'fileChange'].includes(pending.kind)) throw new TypeError('approvalToPermissionResult requires an approval pending record')
  if (decision === 'accept' || decision === 'acceptForSession') {
    const updates = decision === 'acceptForSession' ? sessionUpdates(pending) : []
    if (decision === 'acceptForSession' && !updates.length) return { behavior: 'deny', message: TEXT.sessionUnavailable }
    return { behavior: 'allow', updatedInput: structuredClone(pending.input), ...(updates.length ? { updatedPermissions: updates } : {}) }
  }
  if (decision === 'decline') return { behavior: 'deny', message: TEXT.declined }
  if (decision === 'cancel') return { behavior: 'deny', message: TEXT.cancelled, interrupt: true }
  return { behavior: 'deny', message: TEXT.notGranted }
}

// Comma join the way the CLI's own question UI does: an item holding ", " or a
// double quote is JSON-quoted so it stays one item (pattern from claude-agent-acp).
function joinMultiSelect(items) {
  return items.map(item => item.includes(', ') || item.includes('"') ? JSON.stringify(item) : item).join(', ')
}

/**
 * The AskUserQuestion updatedInput for the runtime's answers.
 *   answers: { q0: { answers: [label or text] }, ... } (runtime replyUserInput result.answers), or null for skip
 * Returns { ...originalInput, answers: { [question text]: answer } }. A
 * skipped or unanswered question has no key, so Claude reads "skipped" and the
 * turn continues. The answers object has no prototype: a question text such
 * as "__proto__" stays an ordinary key. Wire only; never persist it.
 */
export function askAnswersToUpdatedInput(pending, answers, limits = {}) {
  if (!pending || pending.kind !== 'userInput') throw new TypeError('askAnswersToUpdatedInput requires a question pending record')
  const L = { ...CLAUDE_PERMISSION_LIMITS, ...limits }
  const source = plainObject(answers)
  const out = Object.create(null)
  for (const [index, question] of pending.questions.entries()) {
    const entry = source && Object.hasOwn(source, `q${index}`) ? plainObject(source[`q${index}`]) : null
    const values = (Array.isArray(entry?.answers) ? entry.answers : [])
      .filter(value => typeof value === 'string' && value.trim() && value.length <= L.maxAnswer && !value.includes('\0'))
    if (!values.length) continue
    out[question.text] = question.multiSelect ? joinMultiSelect(values) : values.join(', ')
  }
  return { ...structuredClone(pending.input), answers: out }
}

/**
 * The runtime's reply for one pending record → PermissionResult.
 *   result/error are exactly what the runtime passed to respond(rpcId, result, error).
 * Only the user's explicit cancel interrupts; every runtime refusal is a plain
 * deny, so nothing is granted and the runtime decides whether to stop the run.
 */
export function serverResponseToPermissionResult(pending, result, error) {
  if (!pending) throw new TypeError('serverResponseToPermissionResult requires a pending record')
  if (pending.kind === 'userInput') {
    if (error === undefined && plainObject(plainObject(result)?.answers)) return { behavior: 'allow', updatedInput: askAnswersToUpdatedInput(pending, result.answers) }
    if (error && error.code === USER_SKIPPED_CODE && error.message === USER_SKIPPED_MESSAGE) return { behavior: 'allow', updatedInput: askAnswersToUpdatedInput(pending, null) }
    return { behavior: 'deny', message: TEXT.questionUnavailable }
  }
  if (error === undefined && typeof plainObject(result)?.decision === 'string') return approvalToPermissionResult(pending, result.decision)
  return { behavior: 'deny', message: TEXT.approvalUnavailable }
}

/** serverRequest/resolved for a pending record the CLI abandoned. */
export function resolvedNotification(pending) {
  return { method: 'serverRequest/resolved', params: { threadId: pending.threadId, turnId: pending.turnId, requestId: pending.rpcId } }
}

/**
 * createClaudePermissionBroker({ threadId, egdeskServer?, offerSessionGrant?, nextRpcId?, limits? })
 * One per Claude session. Holds pending records; returns what to write or emit.
 *   request(controlMessage, { turnId, cwd }) → { write?: controlResponse, serverRequest?: {id, method, params} }
 *   respond(rpcId, result, error)            → { write } | null (not ours, settled or abandoned)
 *   cancel(requestId)                        → { notification } | null (control_cancel_request)
 *   abortAll()                               → [notification] (process ended; nothing to write)
 *   owns(rpcId) / size()
 * rpcIds are strings `claude:<threadId>:perm:<n>` unless nextRpcId is given,
 * so a bridge can route the runtime's respond() by prefix.
 */
export function createClaudePermissionBroker({ threadId, egdeskServer = 'egdesk', offerSessionGrant = false, nextRpcId = null, limits = {} } = {}) {
  if (!idText(threadId)) throw new TypeError('createClaudePermissionBroker requires a threadId')
  const L = { ...CLAUDE_PERMISSION_LIMITS, ...limits }
  let counter = 0
  const makeId = typeof nextRpcId === 'function' ? nextRpcId : () => `claude:${threadId}:perm:${++counter}`
  const pending = new Map() // rpcId → pending record
  const byRequest = new Map() // control request_id → rpcId

  return {
    request(message, { turnId = null, cwd = null } = {}) {
      const control = message?.kind ? message : classifyControlMessage(message)
      if (control.kind !== 'canUseTool') {
        return control.requestId && ['hookCallback', 'otherRequest'].includes(control.kind)
          ? { write: controlErrorResponse(control.requestId, `${TEXT.unsupportedControl}: ${control.subtype}`) } : {}
      }
      if (byRequest.has(control.requestId)) return {}
      if (pending.size >= L.maxPending) return { write: controlSuccessResponse(control.requestId, { behavior: 'deny', message: TEXT.tooMany }) }
      const rpcId = makeId()
      const routed = routePermissionRequest(control.request, { threadId, turnId, rpcId, requestId: control.requestId, cwd, egdeskServer, offerSessionGrant, limits: L })
      if (routed.route === 'allow' || routed.route === 'deny') return { write: controlSuccessResponse(control.requestId, routed.result) }
      pending.set(rpcId, routed.pending)
      byRequest.set(control.requestId, rpcId)
      return { serverRequest: routed.serverRequest }
    },
    respond(rpcId, result, error) {
      const entry = pending.get(rpcId)
      if (!entry) return null
      pending.delete(rpcId)
      byRequest.delete(entry.requestId)
      return { write: controlSuccessResponse(entry.requestId, serverResponseToPermissionResult(entry, result, error)) }
    },
    cancel(requestId) {
      const rpcId = byRequest.get(requestId)
      const entry = rpcId !== undefined && pending.get(rpcId)
      if (!entry) return null
      pending.delete(rpcId)
      byRequest.delete(requestId)
      return { notification: resolvedNotification(entry) }
    },
    abortAll() {
      const out = [...pending.values()].map(resolvedNotification)
      pending.clear()
      byRequest.clear()
      return out
    },
    owns: rpcId => pending.has(rpcId),
    size: () => pending.size,
  }
}
