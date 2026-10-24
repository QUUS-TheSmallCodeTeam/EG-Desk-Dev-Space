import { publicText } from './codex-chat-values.mjs'

/**
 * What an approved plan step is told when it starts, built only from public
 * gate facts: the gate kind and its exact target (origin + path, connected
 * folder + pattern, Terminal session, a label), which event opened it and when.
 * Raw event payloads, URL queries and any credential-looking text never enter.
 *
 * composeAwaitResume(...)  -> the contract's <egdesk-await-resume> message, sent
 *                             as the next turn of the conversation that proposed
 *                             the plan (resumeIn: 'sameThread').
 * composePlanStep(...)     -> the message for a step that runs in a new
 *                             conversation (resumeIn: 'newThread').
 * appendAnswers(message, answers) -> a graph task's own message plus 대표님's
 *                             answers, for graphs that are not plans.
 *
 * answers (CHAT-06 question gates, in gate order):
 *   { gateId, question, kind: 'choice', choice, label }   the option 대표님 picked
 *   { gateId, question, kind: 'text', text }              대표님's written answer (<= 500)
 * The step continues with these answers. Each is escaped (or CDATA for written
 * text) and credential-looking text is redacted, so it cannot break the block.
 */

const escapeXml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = value => escapeXml(value).replace(/"/g, '&quot;')
// Long free text keeps its length: CDATA, with any "]]>" split across sections.
const cdata = value => `<![CDATA[${String(value).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`
const clean = (value, limit) => publicText(String(value ?? ''), limit).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')

const BY = {
  'browser.oauthCompleted': 'login finished in the Browser',
  'file.changed': 'a matching file changed',
  'terminal.exit': 'the Terminal exited',
  'user.action': 'continued by hand',
}

function when(gate) {
  return gate.satisfiedAt ? ` at ${gate.satisfiedAt}` : ''
}

/** One public sentence for a visible gate (task graph gates[] entry). */
export function describeGate(gate, { taskTitles = new Map() } = {}) {
  const byHand = gate.satisfiedBy === 'user.action'
  const expired = gate.expiredAt ? ` (its wait ran out at ${gate.expiredAt})` : ''
  switch (gate.kind) {
    case 'task': {
      const title = taskTitles.get(gate.taskId)
      return `Step ${title ? `"${clean(title, 200)}" ` : ''}(${gate.taskId}) completed.`
    }
    case 'approval':
      return gate.status === 'satisfied' ? 'Approved.' : 'Approval is still pending.'
    case 'oauth':
      return byHand
        ? `Continued by hand instead of waiting for the login at ${gate.origin}${gate.pathPrefix}${expired}${when(gate)}.`
        : `Login finished at ${gate.origin}${gate.pathPrefix}${when(gate)}.`
    case 'file':
      return byHand
        ? `Continued by hand instead of waiting for "${clean(gate.relativeGlob, 512)}" in connected folder ${gate.root}${expired}${when(gate)}.`
        : `A file matching "${clean(gate.relativeGlob, 512)}" changed in connected folder ${gate.root}${when(gate)}.`
    case 'terminalExit':
      return byHand
        ? `Continued by hand instead of waiting for Terminal ${gate.sessionId} to exit${expired}${when(gate)}.`
        : `Terminal ${gate.sessionId} exited${gate.exitCode === undefined ? '' : ` with code ${gate.exitCode}`}${when(gate)}.`
    case 'userAction':
      if (gate.answer) return `${gate.label ? `"${clean(gate.label, 200)}" was answered` : 'Answered'} by 대표님${expired}${when(gate)} (see answers).`
      return `${gate.label ? `"${clean(gate.label, 200)}" was confirmed` : 'Confirmed'}${byHand ? ' by hand' : ''}${expired}${when(gate)}.`
    default:
      return `${BY[gate.satisfiedBy] || 'Condition met'}${when(gate)}.`
  }
}

function summaryOf({ planTitle, gates, taskTitles }) {
  const met = gates.filter(gate => gate.status === 'satisfied')
  if (!met.length) return `대표님 approved the plan "${clean(planTitle, 200)}"; this is its first step.`
  return met.map(gate => describeGate(gate, { taskTitles })).join(' ')
}

// Only well-formed answers, at most one per gate and eight in all.
function answerList(answers) {
  if (!Array.isArray(answers)) return []
  const seen = new Set()
  return answers.filter(answer => answer && typeof answer.gateId === 'string' && !seen.has(answer.gateId) && seen.add(answer.gateId) &&
    ((answer.kind === 'choice' && typeof answer.choice === 'string') || (answer.kind === 'text' && typeof answer.text === 'string'))).slice(0, 8)
}
const answerValue = answer => answer.kind === 'choice' ? clean(answer.label || answer.choice, 200) : clean(answer.text, 500)
const questionOf = answer => typeof answer.question === 'string' && answer.question ? clean(answer.question, 200) : 'Question'

function answerLines(answers) {
  if (!answers.length) return []
  return [
    '  <answers>',
    ...answers.map(answer => answer.kind === 'choice'
      ? `    <answer gate="${escapeAttr(answer.gateId)}" kind="choice" option="${escapeAttr(answer.choice)}" question="${escapeAttr(questionOf(answer))}">${escapeXml(answerValue(answer))}</answer>`
      : `    <answer gate="${escapeAttr(answer.gateId)}" kind="text" question="${escapeAttr(questionOf(answer))}">${cdata(answerValue(answer))}</answer>`),
    '  </answers>',
  ]
}

// Plain lines naming each answer, for a message that is not the XML block.
function answerSentences(answers) {
  return answers.map(answer => `- "${questionOf(answer)}": ${answer.kind === 'choice' ? `"${answerValue(answer)}" (option ${answer.choice})` : answerValue(answer)}`)
}

/**
 * composeAwaitResume({ graphId, planId, planTitle, task: { taskId, title }, instructions, gates, taskTitles, answers? })
 * gates: the step's visible gates (task graph gates[]); taskTitles: Map taskId -> title.
 */
export function composeAwaitResume({ graphId, planId, planTitle, task, instructions, gates = [], taskTitles = new Map(), answers = [] }) {
  const met = gates.filter(gate => gate.status === 'satisfied')
  const given = answerList(answers)
  const lines = [
    '<egdesk-await-resume>',
    `  <await_id>${escapeXml(`${graphId}/${task.taskId}`)}</await_id>`,
    '  <status>satisfied</status>',
    `  <target>${escapeXml(`agent-task:${task.taskId}`)}</target>`,
    `  <summary>${escapeXml(summaryOf({ planTitle, gates, taskTitles }))}</summary>`,
    '  <evidence>',
    ...(met.length ? met.map(gate => `    <condition kind="${escapeAttr(gate.kind)}" gate="${escapeAttr(gate.gateId)}"${gate.satisfiedBy ? ` by="${escapeAttr(gate.satisfiedBy)}"` : ''}>${escapeXml(describeGate(gate, { taskTitles }))}</condition>`)
      : ['    <condition kind="approval">대표님 approved this plan.</condition>']),
    '  </evidence>',
    ...answerLines(given),
    `  <plan id="${escapeAttr(planId)}">${escapeXml(clean(planTitle, 200))}</plan>`,
    `  <next_task id="${escapeAttr(task.taskId)}">`,
    `    <title>${escapeXml(clean(task.title, 200))}</title>`,
    `    <instructions>${cdata(clean(instructions, 4000))}</instructions>`,
    '  </next_task>',
    '</egdesk-await-resume>',
    given.length
      ? 'Continue the approved plan with next_task above, following 대표님\'s answers above and using what this conversation already knows. Do not ask 대표님 to restate the task or the answers.'
      : 'Continue the approved plan with next_task above, using what this conversation already knows. Do not ask 대표님 to restate the task.',
  ]
  return lines.join('\n')
}

/** composePlanStep({ planTitle, task, instructions, gates, taskTitles, answers? }) for a step in a new conversation. */
export function composePlanStep({ planTitle, task, instructions, gates = [], taskTitles = new Map(), answers = [] }) {
  const given = answerList(answers)
  return [
    `[EG-Desk approved plan "${clean(planTitle, 200)}" — step "${clean(task.title, 200)}" (${task.taskId})]`,
    `Conditions met: ${summaryOf({ planTitle, gates, taskTitles })}`,
    ...(given.length ? ['대표님\'s answers (follow them in this step):', ...answerSentences(given)] : []),
    '',
    clean(instructions, 4000),
  ].join('\n')
}

/** A graph task's own message with 대표님's answers after it; the message alone when there are none. */
export function appendAnswers(message, answers = []) {
  const given = answerList(answers)
  if (!given.length) return message
  return [message, '', '[EG-Desk: 대표님 answered before this task started — follow these answers]', ...answerSentences(given)].join('\n')
}
