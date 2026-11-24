import { createHash } from 'node:crypto'
import { choiceQuestion, decisionThresholds, predicateQuestion, readChoice, readPredicate, tableOptions } from './egdesk-decision-questions.mjs'
import { stripAnsi } from './egdesk-run-result-parse.mjs'

// Terminal state judge (system level; JEV Pillar 2). The Decision model is not a recommender shown to the user:
// the RUNTIME enumerates the states that are possible for this process right now, the model picks one, and the
// SYSTEM responds per state (wait / hand the answer to the human / quit the pager / report / repair).
//   Options exist first: they come from process facts (alive, exit code) and the real output tail, never from the model.
//   Rules stay: a password prompt is recognised by rule and the tail is then not sent anywhere.
//   Mode: off = zero calls and today's behaviour. advisory = the model is asked and the result is only recorded; the
//   system still acts on the deterministic fallback. on = the system acts on an accepted choice.
//   Any failure (deadline, budget, bad answer, the run's model permissions do not allow terminal output) falls back to today's behaviour: wait for the
//   process, and let the reasoning model read the output itself.
export const TERMINAL_STATES = Object.freeze({
  running_output: 'The command is still running and printing progress or logs. Nothing is asked of the person.',
  waiting_yn_input: 'The command stopped and waits for a yes or no answer (y/n, [Y/n], confirm, continue?).',
  waiting_password: 'The command waits for a password, passphrase, token or other secret.',
  stuck_in_pager: 'A pager (less, more, man, a git log or diff view, (END), --More--) holds the terminal and waits for a key.',
  completed_ok: 'The command finished and its output shows success.',
  completed_error: 'The command finished and its output shows a failure, error or failed tests, even if the exit code is 0.',
  need_user_context: 'The output asks for information only the user can give (a choice, a value, a path) that is not a plain yes or no and not a secret.',
  cannot_proceed: 'The command cannot continue and no listed action will fix it (missing tool, permission denied, no network).',
})
export const TERMINAL_STATE_NAMES = Object.freeze(Object.keys(TERMINAL_STATES))
export const TERMINAL_JUDGE_TIMEOUT_MS = 1500
export const TERMINAL_JUDGE_LIMITS = Object.freeze({ tailLines: 30, tailChars: 2400, lineChars: 200, blocks: 12, blockChars: 700, picked: 4, pickedChars: 4000, quietMs: 1500, maxQuietMs: 30_000 })

const PASSWORD_PROMPT = /(?:password|passphrase|passcode|pin|token|secret)[^\n]{0,40}[:?]\s*$/i
const SECRET = [/\b(?:sk|pk|ghp|gho|github_pat|xox[abprs]|AKIA|AIza)[A-Za-z0-9_\-]{10,}/g, /\bBearer\s+[A-Za-z0-9._\-~+/=]{8,}/gi,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi, /\b[A-Za-z0-9+/_\-]{40,}={0,2}/g]

/** The states that are possible for this process now. Decided from process facts only. */
export function enumerateStateOptions({ alive, exitCode = null }) {
  if (alive) return ['running_output', 'waiting_yn_input', 'waiting_password', 'stuck_in_pager', 'need_user_context', 'cannot_proceed']
  if (Number.isInteger(exitCode) && exitCode !== 0) return ['completed_error', 'need_user_context', 'cannot_proceed']
  return ['completed_ok', 'completed_error', 'need_user_context', 'cannot_proceed']
}

/** Bounded, ANSI-free, secret-masked tail. This is the only terminal text a judge request may carry. */
export function redactTail(text, limits = TERMINAL_JUDGE_LIMITS) {
  const lines = stripAnsi(String(text ?? '')).replace(/\r(?!\n)/g, '\n').split('\n').map(line => line.replace(/\s+$/, ''))
  while (lines.length && !lines.at(-1)) lines.pop()
  let out = lines.slice(-limits.tailLines).map(line => line.length > limits.lineChars ? line.slice(0, limits.lineChars) + '…' : line).join('\n')
  for (const pattern of SECRET) out = out.replace(pattern, '[redacted]')
  return out.length > limits.tailChars ? out.slice(-limits.tailChars) : out
}

/** What the system does for each state. `key`/`input` are instructions for the runtime, never text from the model. */
export function stateResponse(state, { agentOwned = false } = {}) {
  switch (state) {
    case 'running_output': return { action: 'wait' }
    case 'waiting_yn_input': return { action: 'handoff_human', input: 'yes_no' }
    case 'waiting_password': return { action: 'handoff_human', input: 'secret' }
    case 'stuck_in_pager': return agentOwned ? { action: 'send_key', key: 'q' } : { action: 'handoff_human', input: 'close_pager' }
    case 'completed_ok': return { action: 'report', result: 'ok' }
    case 'completed_error': return { action: 'repair' }
    case 'need_user_context': return { action: 'handoff_subjective', reason: 'need_user_context' }
    case 'cannot_proceed': return { action: 'handoff_subjective', reason: 'cannot_proceed' }
    default: return { action: 'wait' }
  }
}

const hashOf = text => createHash('sha256').update(text).digest('hex').slice(0, 16)
const fallbackState = ({ alive, exitCode, quietMs }, limits) => {
  if (!alive) return Number.isInteger(exitCode) && exitCode !== 0 ? 'completed_error' : 'completed_ok'
  return quietMs >= limits.maxQuietMs ? 'need_user_context' : 'running_output' // long silence: let the reasoning model look
}

function record(calibration, mode, judgments, fallback) {
  try { calibration?.record?.({ feature: 'terminal_state', mode, judgments, ...(fallback ? { fallback } : {}) }) } catch { /* never changes behaviour */ }
}

/**
 * judgeTerminalState({ tail, alive, exitCode, quietMs, mode, client, thresholds?, timeoutMs?, signal?, calibration?, egress?, cache?, limits? })
 *  → { state, source: 'runtime'|'rule'|'decision'|'fallback', requests, fallback?, shadow? }
 * `egress` is the run's shared gate (egdesk-decision-egress.mjs): terminal text leaves only when the models of this run may receive terminal output; there is no Decision-specific consent. Without a gate nothing is sent.
 */
export async function judgeTerminalState({ tail = '', alive, exitCode = null, quietMs = 0, mode = 'off', client = null, thresholds, timeoutMs = TERMINAL_JUDGE_TIMEOUT_MS,
  signal, calibration = null, egress = null, cache = null, limits = TERMINAL_JUDGE_LIMITS } = {}) {
  const options = enumerateStateOptions({ alive, exitCode })
  const base = fallbackState({ alive, exitCode, quietMs }, limits)
  const text = redactTail(tail, limits)
  // Rule first: a secret prompt is never sent to a model.
  if (alive && PASSWORD_PROMPT.test(stripAnsi(String(tail)).trimEnd().split('\n').at(-1) || '')) return { state: 'waiting_password', source: 'rule', requests: 0 }
  if (options.length === 1) return { state: options[0], source: 'runtime', requests: 0 }
  // Silence has not lasted long enough to say anything yet; a still-running process with no output is just running.
  if (alive && (quietMs < limits.quietMs || !text)) return { state: 'running_output', source: 'runtime', requests: 0 }
  const key = `${alive}|${exitCode}|${hashOf(text)}`
  const cached = cache?.get(key)
  if (cached) return { ...cached, requests: 0, cached: true }
  const done = (result, store = true) => { if (store && cache) cache.set(key, result); return result }
  if (mode !== 'advisory' && mode !== 'on') return { state: base, source: 'fallback', fallback: 'mode_off', requests: 0 }
  if (!client?.decide) return { state: base, source: 'fallback', fallback: 'not_configured', requests: 0 }
  if (egress?.allows?.('terminal_output') !== true) return { state: base, source: 'fallback', fallback: 'evidence_unavailable', requests: 0 }
  const th = decisionThresholds(thresholds)
  let answer
  try {
    answer = await client.decide({
      input: [{ role: 'user', content: [{ type: 'input_json', data: { process: { alive, exit_code: exitCode, quiet_ms: Math.round(quietMs) }, output_tail: text } }] }],
      questions: [choiceQuestion('terminal_state', 'Which state is this terminal process in, judging from the output tail and process facts? Pick only a listed state.',
        tableOptions(Object.fromEntries(options.map(name => [name, TERMINAL_STATES[name]]))))],
      timeoutMs, signal })
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'unreachable'
    record(calibration, mode, [], code)
    return { state: base, source: 'fallback', fallback: code, requests: 1 }
  }
  const read = readChoice(answer.answers, 'terminal_state', { minConfidence: th.choice, minMargin: th.margin })
  const valid = read.state === 'accepted' && options.includes(read.value)
  record(calibration, mode, [{ q: 'terminal_state', would: valid ? 'act' : 'hold', top: read.ranked[0]?.probability, second: read.ranked[1]?.probability, threshold: th.choice,
    minMargin: th.margin, confidence: read.confidence, margin: read.margin, options: options.length }])
  if (mode === 'advisory') return { state: base, source: 'fallback', fallback: 'advisory', shadow: valid ? read.value : null, requests: 1 }
  return done(valid ? { state: read.value, source: 'decision', requests: 1 } : { state: base, source: 'fallback', fallback: 'low_confidence', requests: 1 })
}

/** Runtime-enumerated log blocks: paragraphs and failure markers, each with the runtime's own facts. */
export function enumerateLogBlocks(output, limits = TERMINAL_JUDGE_LIMITS) {
  const lines = stripAnsi(String(output ?? '')).split('\n')
  const blocks = []
  let current = []
  const flush = () => { const text = current.join('\n').trim(); if (text) blocks.push(text); current = [] }
  for (const line of lines) {
    if (!line.trim()) { flush(); continue }
    if (/^(?:not ok|✖|FAIL\b|\s*AssertionError|\s*Error:|\s*TypeError:)/.test(line) && current.some(l => !/^\s+at /.test(l) && !/^\s/.test(l))) flush()
    current.push(line)
  }
  flush()
  return blocks.slice(-limits.blocks).map((text, i) => ({ id: `b${i + 1}`, text: text.length > limits.blockChars ? text.slice(0, limits.blockChars) + '…' : text,
    failureMarker: /(?:not ok|✖|FAIL\b|AssertionError|Error:|error TS\d+|expected|actual)/i.test(text) }))
}

/**
 * pickRelevantBlocks({ blocks, command, exitCode, mode, client, ... }) → { blocks, source, requests }
 * One predicate per runtime block. Fallback (and advisory): the blocks the runtime marked as failures plus the last block.
 */
export async function pickRelevantBlocks({ blocks, mode = 'off', client = null, thresholds, timeoutMs = TERMINAL_JUDGE_TIMEOUT_MS, signal, calibration = null,
  egress = null, limits = TERMINAL_JUDGE_LIMITS } = {}) {
  const fallback = () => {
    const marked = blocks.filter(b => b.failureMarker), last = blocks.at(-1)
    return [...new Map([...marked, ...(last ? [last] : [])].map(b => [b.id, b])).values()].slice(0, limits.picked)
  }
  const trim = list => { let total = 0; return list.filter(b => (total += b.text.length) <= limits.pickedChars) }
  if (!blocks.length) return { blocks: [], source: 'runtime', requests: 0 }
  if ((mode !== 'advisory' && mode !== 'on') || !client?.decide || egress?.allows?.('terminal_output') !== true) return { blocks: trim(fallback()), source: 'fallback', requests: 0 }
  const th = decisionThresholds(thresholds)
  let answer
  try {
    const safe = blocks.map(b => ({ ...b, text: redactTail(b.text, { ...limits, tailLines: 12, tailChars: limits.blockChars }) }))
    answer = await client.decide({ input: [{ role: 'user', content: [{ type: 'input_json', data: { blocks: safe.map(b => ({ id: b.id, text: b.text })) } }] }],
      questions: safe.map(b => predicateQuestion(`log_${b.id}`, `Is log block ${b.id} needed to understand and fix the failure of this command?`)), timeoutMs, signal })
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'unreachable'
    try { calibration?.record?.({ feature: 'terminal_state', mode, judgments: [], fallback: code }) } catch { /* ignore */ }
    return { blocks: trim(fallback()), source: 'fallback', requests: 1 }
  }
  const verdicts = blocks.map(b => ({ id: b.id, ...readPredicate(answer.answers, `log_${b.id}`, th.relevant) }))
  try { calibration?.record?.({ feature: 'terminal_state', mode, judgments: verdicts.map(v => ({ q: 'log_block', would: v.state === 'yes' ? 'attach' : 'skip', p: v.probability ?? undefined, threshold: th.relevant })) }) } catch { /* ignore */ }
  if (mode === 'advisory') return { blocks: trim(fallback()), source: 'fallback', requests: 1 }
  const picked = blocks.filter(b => verdicts.find(v => v.id === b.id)?.state === 'yes').slice(0, limits.picked)
  return { blocks: trim(picked.length ? picked : fallback()), source: picked.length ? 'decision' : 'fallback', requests: 1 }
}

/**
 * Objective loop: run a command, judge its state, answer per state, and on an error hand a reconstructed context to the
 * subjective model, then come back and run the same command again. The loop has fixed exits that hand control to the chat
 * (need_user_context / cannot_proceed); the subjective model never decides what runs next, it only writes the fix.
 * deps: { assess(command) → gate result, judge(snapshot) → state result, pick(blocks, snapshot) → { blocks },
 *   runtime.start(command) → { poll() → { alive, exitCode, tail, output?, quietMs }, write(data) },
 *   human.approve({ command, reasons }) → boolean, human.answer(kind) → string | null,
 *   subjective({ task, ... }) → { fix } | { ask_user } | null, applyFix(fix) }
 * Returns { status, repairs, subjectiveTurns, humanHandoffs, trace } with no command text, answer or secret in `trace`.
 */
export async function runObjectiveLoop({ command, agentOwned = true, deps, maxRepairs = 2, maxPolls = 60 } = {}) {
  const trace = []
  const out = { repairs: 0, subjectiveTurns: 0, humanHandoffs: 0, trace }
  const finish = (status, extra = {}) => ({ status, ...out, ...extra })
  for (;;) {
    const gate = await deps.assess(command)
    trace.push({ step: 'gate', approval: gate.approval, source: gate.source })
    if (gate.approval) {
      out.humanHandoffs++
      if (await deps.human.approve({ command, reasons: gate.reasons }) !== true) return finish('declined')
    }
    const handle = await deps.runtime.start(command)
    let rerun = false
    for (let poll = 0; poll < maxPolls && !rerun; poll++) {
      const snap = await handle.poll()
      const judged = await deps.judge(snap)
      trace.push({ step: 'state', state: judged.state, source: judged.source })
      const response = stateResponse(judged.state, { agentOwned })
      switch (response.action) {
        case 'wait': continue
        case 'handoff_human': {
          out.humanHandoffs++
          const answer = await deps.human.answer(response.input)
          if (typeof answer !== 'string') return finish('waiting_for_human')
          await handle.write(answer) // typed by the human; never placed in the trace
          continue
        }
        case 'send_key': await handle.write(response.key); trace.push({ step: 'key', key: response.key }); continue
        case 'report': return finish('completed_ok')
        case 'handoff_subjective': out.subjectiveTurns++; await deps.subjective({ task: response.reason, command }); return finish('handoff', { reason: response.reason })
        case 'repair': {
          if (out.repairs >= maxRepairs) { out.subjectiveTurns++; await deps.subjective({ task: 'cannot_proceed', command }); return finish('handoff', { reason: 'cannot_proceed' }) }
          const blocks = enumerateLogBlocks(snap.output ?? snap.tail)
          const picked = await deps.pick(blocks, snap)
          trace.push({ step: 'context', blocks: picked.blocks.length, source: picked.source })
          out.subjectiveTurns++
          const fix = await deps.subjective({ task: 'fix', command, exitCode: snap.exitCode, blocks: picked.blocks })
          if (!fix || fix.ask_user) return finish('handoff', { reason: 'need_user_context' })
          await deps.applyFix(fix)
          out.repairs++
          rerun = true
        }
      }
    }
    if (!rerun) return finish('timed_out_waiting')
  }
}
