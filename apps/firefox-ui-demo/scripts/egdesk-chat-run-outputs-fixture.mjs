// Opt-in data-only sidecar for the existing QA transport. No listener, file,
// provider, shell, terminal, approval reply or arbitrary event-injection API.
import { RunOutputStore } from '../helper/codex-run-outputs.mjs'

export const CHAT_RUN_OUTPUT_SCENARIOS = Object.freeze(['RUN_OUTPUTS', 'RUN_OUTPUTS_LOST'])
export const CHAT_RUN_OUTPUT_ROUTES = Object.freeze(['/chat/command-output', '/chat/run-changes'])
export const CHAT_RUN_OUTPUT_MARKER = 'EGDESK_QA_RETAINED_COMMAND_OUTPUT'
export const CHAT_RUN_DIFF_MARKER = 'EGDESK_QA_RETAINED_DIFF_ADDED'
export const CHAT_RUN_OUTPUT_DELTA = '\nEGDESK_QA_RETAINED_VIEW_PERSISTENCE\n'
const ROOT = '/egdesk-qa-synthetic-never-created'
// Enough inert retained text to exercise the production output's local scroll
// using native keys, without injecting UI styles or running any command.
const PASS = `${Array.from({ length: 72 }, (_, index) => `Synthetic retained log line ${index + 1}.`).join('\n')}\n${CHAT_RUN_OUTPUT_MARKER}: pass\nTests:       3 passed, 3 total\n`
const FAIL = `FAIL src/fixture.test.js\n  ● synthetic fixture failure\n\n    Expected: 1\n    Received: 2\n\n      at fixture (src/fixture.test.js:7:3)\n\nTests:       1 failed, 2 passed, 3 total\n${CHAT_RUN_OUTPUT_MARKER}: fail\n`
const DIFF = `@@ -1 +1 @@\n-before fixture\n+${CHAT_RUN_DIFF_MARKER}\n`
const copy = value => structuredClone(value)
const validId = value => typeof value === 'string' && !!value.trim() && value.length <= 300

export function chatRunOutputsFixtureEnabled(env = process.env) {
  const flag = env.EGDESK_QA_RUN_OUTPUTS_FIXTURE
  if (flag != null && !['0', '1'].includes(flag)) throw new Error('Invalid run-outputs fixture gate')
  if (flag !== '1') return false
  if (env.EGDESK_QA_FIXTURE_TRANSPORT !== '1' || env.EGDESK_QA_REAL_TURN !== '0'
    || env.EGDESK_QA_PROJECT_FILE_FIXTURE === '1') {
    throw new Error('Run outputs require isolated model-free transport, separate from project File fixtures')
  }
  return true
}

export function chatRunOutputFixtureIds(runId) {
  if (!validId(runId) || runId.length > 240) throw new TypeError('Invalid synthetic run ID')
  return Object.freeze({ pass: `${runId}-output-pass`, fail: `${runId}-output-fail`,
    change: `${runId}-file-change`, proposed: `${runId}-proposed-file`, approval: `${runId}-file-approval` })
}

/**
 * Singer integration:
 * - add RUN_OUTPUTS / RUN_OUTPUTS_LOST only when the gate is enabled;
 * - call seed(run) after runs.set and the transport's own run.started/ACK;
 * - after the existing loopback gate, route(method, URL) returns null or
 *   {status, body}; pass it through the transport's existing JSON/CORS writer;
 * - /__qa/state exposes runOutputsFixture:true and runOutputs:stats();
 * - dispose() clears only this sidecar's in-memory output, never the runs map.
 * envelope is the transport's sole existing SSE envelope function.
 */
export function createChatRunOutputsFixture({ runs, envelope, env = process.env } = {}) {
  if (!chatRunOutputsFixtureEnabled(env)) throw new Error('Explicit run-outputs fixture opt-in required')
  if (!(runs instanceof Map) || typeof envelope !== 'function') throw new TypeError('Existing runs map and SSE envelope required')
  const store = new RunOutputStore()
  const seeded = new Map()
  const requests = [], options = []
  let disposed = false
  const accepts = scenario => CHAT_RUN_OUTPUT_SCENARIOS.includes(scenario)

  function seed(run) {
    if (disposed) throw new Error('Run-outputs fixture disposed')
    if (!accepts(run?.scenario) || runs.get(run.runId) !== run || !validId(run.conversationId)
      || run.answerId !== `${run.conversationId}/${run.runId}` || !(run.activities instanceof Map)
      || !(run.messages instanceof Map) || !Array.isArray(run.pendingApprovals)) throw new TypeError('Expected an existing owned scenario run')
    if (seeded.has(run.runId)) return false
    if (run.activities.size || run.pendingApprovals.length) throw new Error('Scenario run already contains activity or approvals')
    const ids = chatRunOutputFixtureIds(run.runId)
    const lost = run.scenario === 'RUN_OUTPUTS_LOST'
    const commands = lost ? [[ids.fail, 1, FAIL]] : [[ids.pass, 0, PASS], [ids.fail, 1, FAIL]]
    for (const [id, exitCode, text] of commands) {
      store.completeCommand(run.answerId, id, text)
      const activity = { id, kind: 'commandExecution', status: 'completed', title: 'npm test (synthetic, never executed)',
        detail: { command: 'npm test', cwd: ROOT, exitCode, durationMs: 1250 }, sourceRefs: [] }
      run.activities.set(id, activity)
      envelope(run, 'activity.completed', copy(activity), id)
    }
    if (!lost) {
      const path = `${ROOT}/src/fixture.test.js`
      for (const [itemId, status] of [[ids.change, 'completed'], [ids.proposed, 'inProgress']]) {
        store.setFileChanges(run.answerId, itemId, [{ path, kind: { type: 'update' }, diff: DIFF }], status)
      }
      store.setTurnDiff(run.answerId, `diff --git a/src/fixture.test.js b/src/fixture.test.js\n--- a/src/fixture.test.js\n+++ b/src/fixture.test.js\n${DIFF}`)
      const activity = { id: ids.change, kind: 'fileChange', status: 'completed', title: 'Synthetic file change (no file written)',
        detail: { changeCount: 1, changes: [{ path, kind: 'update' }] }, sourceRefs: [] }
      run.activities.set(ids.change, activity)
      envelope(run, 'activity.completed', copy(activity), ids.change)
      const approval = { approvalId: ids.approval, kind: 'fileChange', status: 'pending', choices: ['decline', 'cancel'],
        itemId: ids.proposed, reason: 'Synthetic proposed change; viewing never approves or writes it', cwd: ROOT, paths: [path] }
      run.pendingApprovals.push(approval)
      envelope(run, 'approval.required', { approval: copy(approval) }, ids.proposed)
    } else store.forget(run.answerId)
    const messageId = `${run.runId}-output-message`
    const text = lost ? 'Synthetic retained output was discarded. Open its result to verify unavailable state.'
      : 'Synthetic command results and proposed changes are ready to inspect. No command or file operation ran.'
    run.messages.set(messageId, { id: messageId, role: 'assistant', status: lost ? 'completed' : 'streaming', text })
    envelope(run, 'message.started', { messageId, phase: 'answer' }, messageId)
    // Normal guidance remains streaming for ONE explicit, fixed-marker use of
    // the transport's existing token-protected /__qa/delta seam. No timers,
    // output-read side effects, control endpoint or callback are added here.
    if (lost) envelope(run, 'message.completed', { messageId, text, phase: 'answer' }, messageId)
    else envelope(run, 'message.delta', { messageId, delta: text, phase: 'answer' }, messageId)
    run.fixtureStage = lost ? 'run-outputs-lost' : 'run-outputs-ready'
    if (lost) { run.status = 'completed'; envelope(run, 'run.completed', { status: 'completed' }) }
    seeded.set(run.runId, { scenario: run.scenario, conversationId: run.conversationId, runId: run.runId, ids: { ...ids }, lost })
    return true
  }

  function route(method, url) {
    if (!CHAT_RUN_OUTPUT_ROUTES.includes(url?.pathname)) return null
    if (method === 'OPTIONS') { options.push({ method, path: url.pathname }); return { status: 204, body: {} } }
    const query = Object.fromEntries(url.searchParams)
    let response
    const error = (status, code) => ({ status, body: { code, error: code } })
    if (disposed) response = error(410, 'RUN_OUTPUT_FIXTURE_DISPOSED')
    else if (method !== 'GET') response = error(405, 'METHOD_NOT_ALLOWED')
    else if ([...url.searchParams.keys()].some(key => !['conversationId', 'runId', 'itemId'].includes(key)
      || url.searchParams.getAll(key).length !== 1)
      || !validId(query.conversationId) || !validId(query.runId)
      || (url.pathname === '/chat/command-output' || query.itemId !== undefined) && !validId(query.itemId)) {
      response = error(400, 'INVALID_RUN_OUTPUT_QUERY')
    } else {
      const run = runs.get(query.runId), record = seeded.get(query.runId)
      if (!run || !record || run.conversationId !== query.conversationId || record.conversationId !== query.conversationId
        || run.answerId !== `${query.conversationId}/${query.runId}`) response = error(404, 'RUN_NOT_FOUND')
      else if (url.pathname === '/chat/command-output') {
        const output = store.commandOutput(run.answerId, query.itemId)
        response = output ? { status: 200, body: { protocolVersion: 1, conversationId: run.conversationId, runId: run.runId, ...output } }
          : error(404, 'COMMAND_OUTPUT_UNAVAILABLE')
      } else response = { status: 200, body: { protocolVersion: 1, conversationId: run.conversationId, runId: run.runId,
        ...store.changes(run.answerId, { itemId: query.itemId ?? null }) } }
    }
    requests.push({ method, path: url.pathname, query, status: response.status })
    return response
  }

  function stats() {
    return copy({ enabled: true, disposed, scenarios: [...seeded.values()], requests, options,
      retainedRunKeys: store.keys(), retainedBytes: store.totalBytes,
      effects: { providerTurns: 0, shellExecutions: 0, fileWrites: 0, approvalPosts: 0 } })
  }
  function dispose() {
    for (const key of store.keys()) store.forget(key)
    disposed = true
  }
  return Object.freeze({ accepts, seed, route, stats, dispose })
}
