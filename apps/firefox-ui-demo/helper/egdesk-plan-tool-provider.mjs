import { MAX_GATE_ANSWER_CHARS, MAX_GATE_CHOICES } from './egdesk-task-graph.mjs'
import { MAX_PLAN_INSTRUCTIONS, MAX_PLAN_TASKS } from './egdesk-task-plans.mjs'

/**
 * Dynamic tool egdesk_propose_plan for ordinary (not bounded/QA) Agent threads.
 * The Agent proposes steps and the conditions they wait for; the plan is saved
 * as 'proposed' and nothing runs until 대표님 approves it on screen
 * (POST /tasks/plans/:planId/approve). Bounded and QA threads never see the
 * tool: the chat runtime filters their catalogs and refuses their calls, and
 * dispatch refuses any run that carries an execution policy.
 *
 * Tool result (inputText JSON):
 *   proposed  { status: 'proposed', planId, graphId, taskCount, message, next }
 *   invalid   { status: 'invalid', code: 'PLAN_INVALID', reason }   (success: true, so the Agent can fix it)
 *   failure   success: false, { error: { code } }                   (signed out, storage unavailable, ...)
 * A proposal also emits the chat event 'plan.proposed' on the run.
 *
 * CHAT-06: a userAction gate may ask 대표님 a question instead of a plain
 * confirm (response: 2-6 choices, or a short written answer). The step waits
 * for the answer and starts with it; nothing else changes about the gate.
 */

export const PLAN_TOOL_NAME = 'egdesk_propose_plan'
export const PLAN_PROVIDER_ID = 'egdesk-plan'

const gateSchema = {
  type: 'object', additionalProperties: false, required: ['gateId', 'kind'],
  properties: {
    gateId: { type: 'string', description: 'Short ID of this condition, unique within the step.' },
    kind: { type: 'string', enum: ['userAction', 'oauth', 'file', 'terminalExit'] },
    label: { type: 'string', description: 'userAction: what 대표님 confirms, or the question 대표님 answers when response is given (<=200 chars).' },
    response: {
      type: 'object', additionalProperties: false, required: ['kind'],
      description: `userAction only: ask instead of a plain confirm. choice = 대표님 picks one of 2-${MAX_GATE_CHOICES} options; text = 대표님 writes a short answer (<=${MAX_GATE_ANSWER_CHARS} chars). The answer is given to this step when it starts. Never ask for passwords, keys or personal numbers: such answers are refused.`,
      properties: {
        kind: { type: 'string', enum: ['choice', 'text'] },
        options: {
          type: 'array', minItems: 2, maxItems: MAX_GATE_CHOICES, description: 'choice: the options in the order 대표님 sees them.',
          items: { type: 'object', additionalProperties: false, required: ['id', 'label'], properties: {
            id: { type: 'string', description: 'Short option ID such as fast (letters, digits, ".", "_", "-").' },
            label: { type: 'string', description: 'What 대표님 sees on the option (<=120 chars).' },
          } },
        },
        maxLength: { type: 'integer', minimum: 1, maximum: MAX_GATE_ANSWER_CHARS, description: `text: optional shorter limit (default ${MAX_GATE_ANSWER_CHARS}).` },
      },
    },
    origin: { type: 'string', description: 'oauth: exact origin such as https://github.com.' },
    pathPrefix: { type: 'string', description: 'oauth: callback path with at least one segment, such as /login/oauth/callback.' },
    cardId: { type: 'string', description: 'oauth: optional Browser card that must finish the login.' },
    root: { type: 'string', description: 'file: connected folder rootId.' },
    relativeGlob: { type: 'string', description: 'file: pattern inside that folder, such as reports/*.pdf.' },
    sessionId: { type: 'string', description: 'terminalExit: Terminal session id (term-...).' },
    exitCode: { type: 'integer', description: 'terminalExit: optional exit code to wait for.' },
    timeoutMs: { type: 'integer', description: 'Optional: stop waiting after this many ms (<=7 days) and ask 대표님 to continue or cancel.' },
    expiresAt: { type: 'string', description: 'Optional instead of timeoutMs: ISO time when the wait runs out (<=7 days away).' },
  },
}

export const PLAN_TOOL_SPECS = Object.freeze([{
  type: 'function',
  name: PLAN_TOOL_NAME,
  description: [
    'Propose a multi-step plan for 대표님 to approve. Nothing runs until 대표님 approves it on screen.',
    'After approval each step starts by itself once the steps in dependsOn completed and its gates are met:',
    'userAction = 대표님 confirms, or answers a question when it has response (choice or short text; the answer reaches the step);',
    'oauth = a login finishes at origin+pathPrefix; file = a file matching relativeGlob changes in connected folder root;',
    'terminalExit = that Terminal session exits. resumeIn sameThread (default) continues the step in this conversation;',
    'newThread runs it in a fresh conversation, so its instructions must stand alone.',
    'After a successful proposal, end your turn and tell 대표님 the plan is waiting for approval. Do not start the steps yourself.',
  ].join(' '),
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['title', 'tasks'],
    properties: {
      title: { type: 'string', description: 'Plan name 대표님 sees (<=200 chars).' },
      tasks: {
        type: 'array', minItems: 1, maxItems: MAX_PLAN_TASKS,
        items: {
          type: 'object', additionalProperties: false, required: ['taskId', 'title', 'instructions', 'dependsOn'],
          properties: {
            taskId: { type: 'string', description: 'Short step ID such as collect-data (letters, digits, ".", "_", "-").' },
            title: { type: 'string', description: 'Step name 대표님 sees (<=200 chars).' },
            instructions: { type: 'string', description: `What the Agent does in this step (<=${MAX_PLAN_INSTRUCTIONS} chars).` },
            dependsOn: { type: 'array', maxItems: MAX_PLAN_TASKS, items: { type: 'string' }, description: 'taskIds of steps that must complete first.' },
            resumeIn: { type: 'string', enum: ['sameThread', 'newThread'] },
            gates: { type: 'array', maxItems: 8, items: gateSchema },
          },
        },
      },
    },
  },
}])

const respond = (success, value) => ({ success, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] })

/** createPlanToolProvider({ plans: () => planService | null, schemaReady? }) */
export function createPlanToolProvider({ plans, schemaReady = () => true } = {}) {
  if (typeof plans !== 'function') throw new TypeError('plans accessor is required')
  const calls = new Map()
  return {
    providerId: PLAN_PROVIDER_ID,
    runtime: null,
    specs(route) { return schemaReady(route) ? PLAN_TOOL_SPECS : [] },
    dispatch(run, event) {
      // The same native call delivered twice proposes once.
      const key = `${run?.answerId ?? ''}/${event?.callId ?? ''}`
      if (event?.callId && calls.has(key)) return calls.get(key)
      const work = this.propose(run, event)
      if (event?.callId) {
        calls.set(key, work)
        while (calls.size > 256) calls.delete(calls.keys().next().value)
      }
      return work
    },
    async propose(run, event) {
      if (event?.namespace || event?.tool !== PLAN_TOOL_NAME) return respond(false, { error: { code: 'PLAN_TOOL_UNKNOWN' } })
      if (run?.executionPolicy) return respond(false, { error: { code: 'PLAN_FORBIDDEN' } })
      const service = plans()
      if (!service) return respond(false, { error: { code: 'PLAN_UNAVAILABLE' } })
      let plan
      try {
        plan = await service.propose({ run, args: event.arguments })
      } catch (error) {
        if (error?.code === 'PLAN_INVALID') return respond(true, { status: 'invalid', code: 'PLAN_INVALID', reason: String(error.message).slice(0, 500) })
        return respond(false, { error: { code: typeof error?.code === 'string' ? error.code : 'PLAN_FAILED' } })
      }
      try {
        this.runtime?.emit?.(run, 'plan.proposed', { planId: plan.planId, graphId: plan.graphId, boardId: plan.boardId, title: plan.title,
          status: plan.status, callId: typeof event.callId === 'string' ? event.callId : null,
          tasks: plan.tasks.map(task => ({ taskId: task.taskId, title: task.title, resumeIn: task.resumeIn, dependsOn: task.dependsOn,
            gates: task.gates.filter(gate => gate.kind !== 'task').map(gate => ({ gateId: gate.gateId, kind: gate.kind,
              ...(gate.response ? { response: structuredClone(gate.response) } : {}) })) })) })
      } catch { /* the plan is saved; the screen also learns of it from SSE task.plan */ }
      return respond(true, {
        status: 'proposed', planId: plan.planId, graphId: plan.graphId, taskCount: plan.tasks.length,
        message: '대표님 승인을 기다립니다. 승인되면 단계가 조건대로 차례로 시작됩니다.',
        next: 'End this turn now and tell 대표님 the plan is waiting for approval. Approved same-thread steps continue in this conversation.',
      })
    },
  }
}
