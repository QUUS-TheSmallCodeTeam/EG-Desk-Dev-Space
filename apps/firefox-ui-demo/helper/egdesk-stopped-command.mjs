// c26: the command the person stopped. EG-Desk's own command tool (helper/egdesk-command-executor.mjs) stops the process when the run is interrupted; the engine's turn is already
// interrupted, so the tool result (stopped, how long, the signal, the output so far) never reaches it, and on the next turn the model cannot say what happened to the command
// (Main's check-7w: "whether it completed or was cut off cannot be confirmed"). The runtime keeps this one fact per conversation and gives it to the NEXT turn once, as EG-Desk
// context (the way the posted-answer note is), and to the draft check as known evidence, so a plain statement of it is supported. Facts only; no instruction to the model.
export const STOPPED_COMMAND_KEY = 'egdesk_stopped_command'
export const STOPPED_COMMAND_LIMITS = Object.freeze({ commandChars: 300, outputChars: 800 })
const clip = (v, n) => String(v ?? '').replace(/\r/g, '').slice(0, n)
const tailOf = (v, n) => { const t = String(v ?? '').replace(/\r/g, '').replace(/\s+$/, ''); return t.length > n ? `…${t.slice(-n)}` : t }

/** The fact from the executor's record of a stopped command (null when it was not stopped or there is no command line). */
export function stoppedCommandFact(record) {
  if (!record || record.stopped !== true || typeof record.command !== 'string' || !record.command.trim()) return null
  const L = STOPPED_COMMAND_LIMITS
  return Object.freeze({
    command: clip(record.command.trim(), L.commandChars),
    durationMs: Number.isFinite(record.durationMs) && record.durationMs >= 0 ? Math.round(record.durationMs) : null,
    signal: typeof record.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(record.signal) ? record.signal : null,
    exitCode: Number.isSafeInteger(record.exitCode) ? record.exitCode : null,
    outputTail: tailOf(record.outputTail, L.outputChars),
  })
}

export const seconds = ms => `${(Math.round(ms / 100) / 10).toFixed(1)} s`

/** The sentences, shared by the next turn's block and the draft check's evidence. */
function lines(fact, { output = true } = {}) {
  const out = [`The command \`${fact.command}\` was stopped at the person's request${fact.durationMs !== null ? ` after ${seconds(fact.durationMs)}` : ''}.`,
    `EG-Desk ended its process${fact.signal ? ` with signal ${fact.signal}` : ''}: the command did not run to its end${fact.exitCode === null ? ' and has no exit code' : ''}, and its process has exited.`]
  if (output) out.push(fact.outputTail ? `Output printed before it was stopped (last part):\n${fact.outputTail}` : 'It had printed no output before it was stopped.')
  return out
}

/** What the next turn gets (EG-Desk context for the engine only; never shown in the chat). */
export const stoppedCommandBlock = fact => ['EG-Desk fact about the last command you started in this conversation:', ...lines(fact)].join('\n')

/** What the draft check may know about the answer's statement of it; the output only where the run's models may receive terminal data. */
export const stoppedCommandEvidence = (fact, { outputAllowed = false } = {}) => ({ id: 'stopped', kind: 'terminal', time: 'past', source: 'run', text: lines(fact, { output: outputAllowed }).join('\n') })
