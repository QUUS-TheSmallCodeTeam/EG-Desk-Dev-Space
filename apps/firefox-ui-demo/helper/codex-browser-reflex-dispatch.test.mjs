import test from 'node:test'
import assert from 'node:assert/strict'
import { createDecisionHttpHandler } from './egdesk-decision-http.mjs'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { createDecisionClient, decisionTopicRecipient } from './egdesk-decision-client.mjs'
import { PS_NAMES, pageStateAnswers, pageStateProbabilities, pageStateWire } from './egdesk-browser-page-state.fixture.mjs'

const marker = 'B10_SYNTHETIC_OBSERVATION'
const url = 'https://example.test/b10'
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

async function scenario(target, change, t) {
  const fixtureKey = 'synthetic-fixture-key-B10'
  let owner = 'codex:fixture-owner', mode = 'on', key = fixtureKey, savedAt = 1, reads = 0, generation = 0
  const late = change.startsWith('late-')
  const revokes = ['mode-cycle', 'late-mode-cycle', 'same-key', 'restore-key'].includes(change)
  const failWrites = change === 'failed-writes'
  const handler = createDecisionHttpHandler({
    mode: { get mode() { return mode }, saved: true, persisted: true,
      save: value => { if (failWrites) return false; mode = value; return true } },
    store: { status: 'fixture', writable: true, getApiKey: () => key, savedAt: () => savedAt, hint: () => null,
      save: value => { if (failWrites) return false; key = value; savedAt = 1; return true },
      clear: () => { if (failWrites) return false; key = null; savedAt = null; return true } },
    verifyKey: async () => ({ status: change === 'rejected-key' ? 'invalid_key' : 'verified' }),
    onSettingsChanged: () => { generation++ },
  })
  async function settings(method, path, expected, body) {
    const req = { method, url: path, headers: { host: '127.0.0.1:39218', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } }
    const res = { writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
    assert.equal(await handler(req, res, new URL(path, 'http://127.0.0.1:39218')), true)
    assert.equal(res.status, expected)
    return res.body
  }
  const dispatches = [], ui = [], activity = []
  const reached = deferred(), resume = deferred()
  const recipientForKey = (value, endpoint, model) => decisionTopicRecipient(value, savedAt, endpoint, model)
  const targetRead = target === 'next_step' ? 1 : 2
  const choose = (name, choice) => ({ name, type: 'choice', choice, confidence: 1, probabilities: [{ value: choice, probability: 1 }] })
  const client = createDecisionClient({
    recipientForKey,
    getApiKey: async () => {
      const selected = key
      if (++reads === targetRead && !late) { reached.resolve(); await resume.promise }
      return selected
    },
    fetchImpl: async (_endpoint, { body }) => {
      const wire = JSON.parse(body)
      const question = wire.questions[0].name
      dispatches.push({ question, observation: wire.input[1].content.includes(marker), value: body.includes('synthetic-fill-value') })
      const firstChoice = wire.questions[0].choices[0].value
      const answers = question === 'field_0' ? [choose(question, firstChoice)] : [
        choose('next_step', target === 'field_0' ? firstChoice : 'goal_met'), ...pageStateWire('content'),
        { type: 'predicate', name: 'goal_met', probability: target === 'field_0' ? 0 : 1 },
      ]
      if (late && question === target && reads === targetRead) { reached.resolve(); await resume.promise }
      return { ok: true, text: async () => JSON.stringify({ answers }) }
    },
  })
  const snapshot = { cardId: 'card', documentId: 'doc', revision: 1, url, text: [marker],
    viewport: { width: 300, height: 200, devicePixelRatio: 1 },
    interactiveElements: target === 'field_0' ? [{ ref: 'el_1', label: 'Nickname', role: 'textbox', tag: 'input', href: '', value: '' }] : [] }
  const transport = { runs: new Map(), hasClient: id => id === 'ui',
    bindRun: (id, thread, transportId) => transport.runs.set(id, { clientThreadId: thread, transportId, ownerKey: owner }),
    unbindRun: id => transport.runs.delete(id),
    async sendToUi(request) {
      ui.push(request.kind)
      const reply = { requestId: request.requestId }
      if (request.kind === 'bind') return { ...reply, status: 'bound', binding: { cardId: 'card', cardEpoch: 'epoch', profileId: 'fixture',
        accountId: '', userContextId: 0, url, engineAccountKey: owner, authorityEpoch: 1 } }
      if (request.kind === 'observe') return { ...reply, status: 'observed', snapshot }
      if (request.kind === 'act') return { ...reply, status: 'acted', receipt: {
        after: { ...snapshot, interactiveElements: [{ ...snapshot.interactiveElements[0], value: 'synthetic-fill-value' }] }, observation: {},
        dispatchReceipt: { actor: 'JSWindowActor', eventDispatched: true, documentStillCurrent: true, inputRoute: 'dom-value-setter' } } }
      if (request.kind === 'cancel') return { ...reply, status: 'cancelled' }
      assert.fail(`unexpected fixture request: ${request.kind}`)
    },
  }
  // Use the actual provider, Browser service and default runBrowserReflex; only the UI and Decisions I/O are in-process doubles.
  const provider = createCodexBrowserToolProvider({ transport, getOwnerKey: () => owner, decision: {
    mode: () => mode, configured: () => key !== null, client,
    recipient: () => recipientForKey(key, undefined, client.model), generation: () => generation,
  } })
  provider.runtime = { emit: (_run, name) => activity.push(name) }
  const run = { answerId: 'answer', runId: 'run', clientThreadId: 'thread', status: 'inProgress', executionPolicy: { mode: 'browserBounded' } }
  const prepared = provider.prepare({ clientThreadId: 'thread', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui', selectedSources: [{
    id: 'source', kind: 'browser', selectedByUser: true, browserToolPermission: 'interact', browserToolSelection: { token: 'selection', threadId: 'thread' },
    browserToolIdentity: { cardEpoch: 'epoch', userContextId: 0, engineAccountKey: owner, authorityEpoch: 1 },
    sourceRef: { viewId: 'card', profileId: 'fixture', accountId: '', uri: url },
  }] })
  await provider.bindRun(run, prepared)
  if (change === 'initial-off') mode = 'off'
  const start = callId => provider.dispatch(run, { tool: 'egdesk_browser_reflex', callId, arguments: {
    cardId: 'card', goal: 'Check the fixture', maxSteps: 1, ...(target === 'field_0' ? { values: { nickname: 'synthetic-fill-value' } } : {}),
  } })
  const operation = start('decision')
  if (change !== 'initial-off') {
    assert.equal(await Promise.race([reached.promise.then(() => 'paused'), operation.then(() => 'early return')]), 'paused')
    assert.equal(dispatches.length, targetRead - (late ? 0 : 1), 'dispatch count before changing authority')
    try {
      if (change === 'off' || change === 'late-off') mode = 'off'
      if (change === 'advisory' || change === 'late-advisory') mode = 'advisory'
      if (change === 'cancel') await provider.cancelRun(run)
      if (change === 'owner') owner = 'codex:other-fixture-owner'
      if (change === 'key') { key = 'rotated-synthetic-key'; savedAt++ }
      if (['mode-cycle', 'late-mode-cycle'].includes(change)) {
        assert.equal((await settings('POST', '/decision/mode', 200, { mode: 'off' })).mode, 'off')
        assert.equal((await settings('POST', '/decision/mode', 200, { mode: 'on' })).mode, 'on')
      }
      if (change === 'restore-key') assert.equal((await settings('DELETE', '/decision/credential', 200)).configured, false)
      if (['same-key', 'restore-key'].includes(change)) {
        assert.equal((await settings('POST', '/decision/credential', 200, { apiKey: fixtureKey })).savedAt, 1)
        assert.equal(key, fixtureKey)
      }
      if (change === 'read-only') {
        assert.equal((await settings('GET', '/decision/mode', 200)).mode, 'on')
        assert.equal((await settings('GET', '/decision/status', 200)).configured, true)
      }
      if (change === 'same-mode') await settings('POST', '/decision/mode', 200, { mode: 'on' })
      if (change === 'failed-writes') {
        await settings('POST', '/decision/mode', 500, { mode: 'off' })
        await settings('POST', '/decision/credential', 500, { apiKey: fixtureKey })
        await settings('DELETE', '/decision/credential', 500)
      }
      if (change === 'rejected-key') await settings('POST', '/decision/credential', 422, { apiKey: fixtureKey })
    } finally { resume.resolve() }
  }
  const response = await operation
  const result = JSON.parse(response.contentItems[0].text)
  const targetDispatches = dispatches.filter(call => call.question === target).length
  const acts = ui.filter(kind => kind === 'act').length
  const cancels = activity.filter(name => name === 'browser.cancel.requested').length
  t.diagnostic(JSON.stringify({ reads, generation, dispatches, targetDispatches, acts, cancels, outcome: result.outcome, reason: result.reason, code: result.code, decisions: result.decisions }))
  if (change === 'initial-off') {
    assert.equal(result.error.code, 'BROWSER_REFLEX_UNAVAILABLE')
    assert.equal(reads, 0)
    assert.deepEqual(ui, ['bind'])
    assert.equal(dispatches.length, 0)
    return
  }
  assert.equal(reads, targetRead)
  assert.equal(cancels, Number(change === 'cancel'))
  assert.equal(ui.filter(kind => kind === 'cancel').length, cancels)
  assert.ok(dispatches.every(call => call.observation && !call.value), 'mock fetch received the synthetic observation, not the caller value')
  const allowed = ['on', 'read-only', 'same-mode', 'failed-writes', 'rejected-key'].includes(change)
  const expectedTarget = Number(allowed || late)
  assert.equal(targetDispatches, expectedTarget, 'target mock fetch calls after the existing authority boundary')
  assert.equal(dispatches.length, targetRead - 1 + expectedTarget)
  assert.equal(acts, Number(allowed && target === 'field_0'), 'only the still-authorized mapping may be used for a UI action')
  assert.equal(result.decisions, target === 'field_0' || allowed ? 1 : 0, 'do not consume a result after revocation')
  if (allowed) assert.equal(result.outcome, target === 'next_step' ? 'done' : 'max_steps')
  else {
    assert.equal(result.outcome, 'fallback')
    assert.equal(result.reason, 'evidence_unavailable')
  }
  if (revokes) {
    const fresh = JSON.parse((await start('fresh-on')).contentItems[0].text)
    const freshDispatches = dispatches.slice(targetRead - 1 + expectedTarget).map(call => call.question)
    t.diagnostic(JSON.stringify({ freshDispatches, freshOutcome: fresh.outcome }))
    assert.deepEqual(freshDispatches, target === 'field_0' ? ['next_step', 'field_0'] : ['next_step'])
    assert.equal(fresh.outcome, target === 'field_0' ? 'max_steps' : 'done')
    assert.equal(generation, ['same-key'].includes(change) ? 1 : 2)
  } else assert.equal(generation, 0)
}

for (const target of ['next_step', 'field_0']) {
  for (const change of ['on', 'off', 'advisory', 'cancel', 'late-off', 'late-advisory']) {
    test(`B-10 ${target}: ${change}`, { timeout: 3000 }, t => scenario(target, change, t))
  }
}
for (const change of ['initial-off', 'owner', 'key']) {
  test(`B-10 next_step: ${change}`, { timeout: 3000 }, t => scenario('next_step', change, t))
}

for (const target of ['next_step', 'field_0']) {
  for (const change of ['mode-cycle', 'late-mode-cycle']) {
    test(`B-10 v2 ${target}: ${change}`, { timeout: 3000 }, t => scenario(target, change, t))
  }
}
for (const change of ['same-key', 'restore-key', 'read-only', 'same-mode', 'failed-writes', 'rejected-key']) {
  test(`B-10 v2 next_step: ${change}`, { timeout: 3000 }, t => scenario('next_step', change, t))
}
