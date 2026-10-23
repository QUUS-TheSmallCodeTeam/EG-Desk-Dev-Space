import { publicEpochMs } from './codex-account-usage.mjs'
import { chatError } from './codex-chat-values.mjs'

// One chat runtime drives every AI engine through this adapter contract
// (docs/references/engine-adapter-design.md §4). The internal reference is the
// Codex app-server vocabulary: thread/turn/item notifications plus approval,
// question and EG-Desk tool requests. The Codex adapter passes it through; a
// later Claude adapter translates into it. The runtime keeps cleanNotification
// and safeItem, so no adapter can bypass the public sanitizers.
//
// EngineAdapter {
//   id                              'codex' | 'claude'
//   describe()                      one /v1/state engines[] row, synchronous and cached;
//                                   never secrets, credential paths or executable paths
//   refresh()                       Promise<descriptor>; static re-checks only (executable, version, login)
//   capabilities(engineProfileId?)  Set of ENGINE_CAPABILITIES names
//   ownerKey(engineProfileId?)      account identity text or null; the runtime hashes it
//   isReady(engineProfileId?)       boolean
//   startThread(params)             internal-reference thread/start params → { thread: { id }, model?, cwd? }
//   resumeThread(params)            thread/resume params (with threadId) → { thread: { id, turns } }
//   releaseThread(threadId)         → { status: 'unsubscribed' | 'notLoaded' }
//   startTurn(params)               turn/start params → { turn: { id, status } }
//   interruptTurn(threadId, turnId)
//   forkThread?(params)             optional ('threadFork'): thread/fork params (threadId, lastTurnId?)
//                                   → { thread: { id, forkedFromId? } }; a new thread, not loaded history
//   steerTurn?(...)                 optional capability
//   models?()                       optional: [{ id, displayName, isDefault, supportedEfforts, defaultEffort }]
//                                   the models a turn may name, or null when unknown (no check then)
//   respond(rpcId, result, error?)  answers an engine request (approval, question, EG-Desk tool)
//   subscribe(sink) → unsubscribe   sink.notification(engineId, { method, params }),
//                                   sink.serverRequest(engineId, { id, method, params }),
//                                   sink.connection(engineId, { ready, processLost? }) (whole-engine state only)
//   dispose(reason?)
// }
export const ENGINE_IDS = Object.freeze(['codex', 'claude'])

export const ENGINE_CAPABILITIES = Object.freeze([
  'stream', 'resume', 'nativeHistory', 'interrupt',
  'approvals.command', 'approvals.fileChange', 'approvals.tool',
  'userInput', 'userInput.multiSelect', 'subagents', 'dynamicTools', 'boundedQa',
  'modelSelect.perTurn', 'effortSelect.perTurn', 'usage.rateLimits',
  // CHAT-09: a conversation without saved native history (thread/start
  // ephemeral) and a branch of an existing conversation (forkThread).
  'ephemeralThreads', 'threadFork',
])

export const ENGINE_STATUSES = Object.freeze(['ready', 'starting', 'offline', 'notInstalled', 'versionUnsupported', 'loginRequired', 'decisionPending', 'disabled'])

// Errors raised before a turn starts (engine state) or while binding a
// conversation to an engine. kind is the existing ERROR_KINDS vocabulary.
export const ENGINE_ERRORS = Object.freeze({
  ENGINE_NOT_INSTALLED: { httpStatus: 503, kind: 'unknown', message: 'This engine is not installed on this computer' },
  ENGINE_VERSION_UNSUPPORTED: { httpStatus: 503, kind: 'unknown', message: 'The installed engine version is not supported' },
  ENGINE_LOGIN_REQUIRED: { httpStatus: 401, kind: 'auth', message: 'Sign in to this engine first' },
  ENGINE_DECISION_PENDING: { httpStatus: 403, kind: 'unknown', message: 'This engine waits for a connection decision' },
  ENGINE_BUSY: { httpStatus: 429, kind: 'unknown', message: 'Another conversation is using this engine' },
  ENGINE_UNAVAILABLE: { httpStatus: 503, kind: 'network', message: 'This engine is unavailable' },
  ENGINE_MISMATCH: { httpStatus: 409, kind: 'unknown', message: 'This conversation is bound to a different engine' },
  ENGINE_PROFILE_MISMATCH: { httpStatus: 403, kind: 'auth', message: 'This conversation was started with a different engine account' },
})

export function engineError(code, message) {
  const known = ENGINE_ERRORS[code]
  if (!known) throw chatError('INVALID_ENGINE_ERROR', 'Unknown engine error code', 500)
  return chatError(code, message || known.message, known.httpStatus)
}

const REQUIRED_METHODS = ['describe', 'refresh', 'capabilities', 'ownerKey', 'isReady', 'startThread', 'resumeThread', 'releaseThread', 'startTurn', 'interruptTurn', 'respond', 'subscribe', 'dispose']

export function validateEngineAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || !ENGINE_IDS.includes(adapter.id)) throw chatError('INVALID_ENGINE_ADAPTER', 'Engine adapter has an unknown engine id', 500)
  const missing = REQUIRED_METHODS.find(name => typeof adapter[name] !== 'function')
  if (missing) throw chatError('INVALID_ENGINE_ADAPTER', `Engine adapter ${adapter.id} lacks ${missing}()`, 500)
  for (const name of ['steerTurn', 'forkThread', 'models']) {
    if (adapter[name] !== undefined && typeof adapter[name] !== 'function') throw chatError('INVALID_ENGINE_ADAPTER', `Engine adapter ${adapter.id} has an invalid ${name}`, 500)
  }
  const capabilities = adapter.capabilities()
  if (!(capabilities instanceof Set) || [...capabilities].some(name => !ENGINE_CAPABILITIES.includes(name))) throw chatError('INVALID_ENGINE_ADAPTER', `Engine adapter ${adapter.id} reports unknown capabilities`, 500)
  return adapter
}

// Claude output → ERROR_KINDS (design §4.3). Values follow the documented
// SDKMessage family shared by `claude -p --output-format stream-json` and the
// Agent SDK. Only a short code token leaves this function, never raw text.
const CLAUDE_API_ERROR_KINDS = new Map([
  ['authentication_failed', 'auth'], ['oauth_org_not_allowed', 'auth'], ['cloud_credential_error', 'auth'],
  ['rate_limit', 'quota'], ['billing_error', 'quota'],
  // Signing in again does not lift an account hold.
  ['account_on_hold', 'permission'],
  ['overloaded', 'network'], ['server_error', 'network'],
  ['invalid_request', 'model'], ['model_not_found', 'model'], ['max_output_tokens', 'model'],
  ['unknown', 'unknown'],
])
const CLAUDE_RESULT_KINDS = new Map([
  ['error_max_budget_usd', 'quota'],
  ['error_max_turns', 'model'], ['error_max_structured_output_retries', 'model'],
  // The caller prefers an accompanying api_retry/assistant error when present.
  ['error_during_execution', 'unknown'],
])
const claudeCode = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : 'unknown'

/**
 * null when the message is not an error (success, allowed usage, warnings).
 * willRetry: Claude retries by itself (becomes Codex `error {willRetry:true}`).
 * runFailure false: a skipped tool, shown as an activity, not a failed Run.
 */
export function classifyClaudeError(message) {
  if (!message || typeof message !== 'object') return null
  if (message.type === 'system' && message.subtype === 'api_retry') {
    const code = claudeCode(message.error)
    return { kind: CLAUDE_API_ERROR_KINDS.get(code) || 'unknown', code, willRetry: true, runFailure: false }
  }
  if (message.type === 'assistant' && typeof message.error === 'string') {
    const code = claudeCode(message.error)
    return { kind: CLAUDE_API_ERROR_KINDS.get(code) || 'unknown', code, willRetry: false, runFailure: true }
  }
  if (message.type === 'rate_limit_event') {
    const info = message.rate_limit_info
    if (info?.status === 'rejected') {
      const retryAt = publicEpochMs(info.resetsAt)
      return { kind: 'quota', code: info.errorCode === 'credits_required' ? 'credits_required' : 'rate_limit', willRetry: false, runFailure: true, ...(retryAt !== null ? { retryAt } : {}) }
    }
    if (info?.errorCode === 'credits_required') return { kind: 'quota', code: 'credits_required', willRetry: false, runFailure: true }
    return null
  }
  if (message.type === 'result' && CLAUDE_RESULT_KINDS.has(message.subtype)) {
    return { kind: CLAUDE_RESULT_KINDS.get(message.subtype), code: message.subtype, willRetry: false, runFailure: true }
  }
  if (message.type === 'system' && message.subtype === 'permission_denied') return { kind: 'permission', code: 'permission_denied', willRetry: false, runFailure: false }
  return null
}
