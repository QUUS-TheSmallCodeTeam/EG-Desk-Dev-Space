import test from 'node:test'
import assert from 'node:assert/strict'
import { PROCEDURE_RULE, PROCEDURE_TOOL_NAMES, PROCEDURE_TOOL_SPECS, applyProcedureEdit, createProcedureTools, validateProcedureArgs } from './egdesk-browser-procedure-tools.mjs'
import { createPageToolsProvider, pageToolBrowserEquivalent, pageToolGate } from './egdesk-page-tools.mjs'
import { createPageToolsWiring } from './egdesk-page-tools-wiring.mjs'

// Round g (L60): the chat tools, with a fake procedure service and a fake Browser scope (L59's service is injected in the real app).
const ON = { EGDESK_BROWSER_PROCEDURES: 'on' }
const RUN = { runId: 'r1', answerId: 'a1', conversationId: 'c1', clientThreadId: 't1', status: 'inProgress', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }
const parse = response => JSON.parse(response.contentItems[0].text)
const PROC = () => ({ id: 'proc-abcdef123456', version: 1, name: '배송지', createdAt: 1, updatedAt: 1, start: { url: 'https://shop.example.test/form', host: 'shop.example.test' },
  params: [{ name: '받는 분', default: '이하늘', sensitive: false }, { name: '암호', default: null, sensitive: true }],
  steps: [{ id: 's1', op: 'fill', target: { label: '받는 분', role: 'textbox' }, value: { param: '받는 분' } }, { id: 's2', op: 'click', target: { label: '보내기', role: 'button' }, expect: { kind: 'changed' }, confirm: 'submit' }] })
function service() {
  const store = new Map([['proc-abcdef123456', PROC()]]); const log = []
  return { store, log,
    list: async () => [...store.values()].map(p => ({ id: p.id, name: p.name, host: p.start.host, stepCount: p.steps.length, paramNames: p.params.map(x => x.name), updatedAt: 1 })),
    get: async id => store.get(id) ?? null,
    save: async raw => { log.push(['save', raw]); const p = { ...raw, id: 'proc-0123456789ab' }; store.set(p.id, p); return p },
    update: async (id, raw) => { log.push(['update', id, raw]); store.set(id, raw); return raw },
    remove: async id => store.delete(id),
    captureDraft: async ({ clientThreadId, cardId, name }) => { log.push(['capture', clientThreadId, cardId, name]); return { ...PROC(), name: name ?? '초안' } } }
}
function browser() {
  const calls = []
  return { calls, reflexScope: () => ({ client: null, authorizeDispatch: () => true, callTool: async (name, args) => {
    calls.push([name, args])
    if (name === 'egdesk_browser_observe') return { observationId: 'o' + calls.length, snapshot: { url: 'https://shop.example.test/form', revision: 1, interactiveElements: [{ ref: 'e1', label: '받는 분', role: 'textbox', tag: 'input', value: '' }, { ref: 'e2', label: '보내기', role: 'button', tag: 'button' }] } }
    return {} } }) }
}

test('flag and host: no tools unless the flag is on AND the service is present', () => {
  assert.equal(createProcedureTools({ procedures: service(), browser: browser(), env: {} }), null)
  assert.equal(createProcedureTools({ procedures: service(), browser: browser(), env: { EGDESK_BROWSER_PROCEDURES: 'off' } }), null)
  assert.equal(createProcedureTools({ procedures: null, browser: browser(), env: ON }), null)
  assert.equal(createProcedureTools({ procedures: { list() {} }, browser: browser(), env: ON }), null)
  const tools = createProcedureTools({ procedures: service(), browser: browser(), env: ON })
  assert.deepEqual(tools.specs.map(spec => spec.name), ['egdesk_browser_procedure_list', 'egdesk_browser_procedure_run', 'egdesk_browser_procedure_save', 'egdesk_browser_procedure_update'])
})

test('offered through the page tools provider (Codex and Claude read the same specs) only with the flag and the host; unchanged otherwise', () => {
  const base = createPageToolsProvider({ mode: () => 'on', browser: { dispatch: async () => ({}) } }).specs().map(spec => spec.name)
  const tools = createProcedureTools({ procedures: service(), browser: browser(), env: ON })
  const withTools = createPageToolsProvider({ mode: () => 'on', browser: { dispatch: async () => ({}) }, procedureTools: tools }).specs().map(spec => spec.name)
  assert.deepEqual(withTools.slice(0, base.length), base); assert.deepEqual(withTools.slice(base.length), tools.names)
  const none = createPageToolsProvider({ mode: () => 'on', browser: { dispatch: async () => ({}) }, procedureTools: createProcedureTools({ procedures: service(), browser: browser(), env: {} }) }).specs().map(spec => spec.name)
  assert.deepEqual(none, base)
  for (const name of tools.names) assert.equal(pageToolBrowserEquivalent(name), 'egdesk_browser_navigate')
  assert.equal(pageToolGate(RUN, { tool: PROCEDURE_TOOL_NAMES.run, arguments: {} }).cardId, 'card')
})

test('wiring: flag off or no host = no tools; the host is read lazily', () => {
  const getChat = () => null
  const specsOf = (env, procedures) => createPageToolsWiring({ env: { EGDESK_PAGE_TOOLS: 'on', ...env }, getChat, procedures }).toolProviders[0].specs().map(spec => spec.name)
  const base = specsOf({}, null)
  assert.deepEqual(specsOf({}, service()), base)
  assert.deepEqual(specsOf(ON, null), base)
  assert.ok(specsOf(ON, service()).includes(PROCEDURE_TOOL_NAMES.run))
  let host = null
  const provider = createPageToolsWiring({ env: { EGDESK_PAGE_TOOLS: 'on', ...ON }, getChat, procedures: () => host }).toolProviders[0]
  assert.ok(!provider.specs().some(spec => spec.name === PROCEDURE_TOOL_NAMES.run)); host = service()
  assert.ok(provider.specs().some(spec => spec.name === PROCEDURE_TOOL_NAMES.run))
})

test('the rule text is in every spec description and every reply, the same words for both engines', async () => {
  for (const spec of PROCEDURE_TOOL_SPECS) assert.ok(spec.description.includes(PROCEDURE_RULE), spec.name)
  for (const word of ['needs_confirm', 'needs_value', 'human_step', 'cannot_proceed', 'Never claim a step ran when it did not']) assert.ok(PROCEDURE_RULE.includes(word), word)
  const tools = createProcedureTools({ procedures: service(), browser: browser(), env: ON })
  const out = parse(await tools.handle(RUN, { tool: PROCEDURE_TOOL_NAMES.list, arguments: {} }))
  assert.ok(out.forYouOnly.includes(PROCEDURE_RULE))
})

test('list and argument checks', async () => {
  const tools = createProcedureTools({ procedures: service(), browser: browser(), env: ON })
  const out = parse(await tools.handle(RUN, { tool: PROCEDURE_TOOL_NAMES.list, arguments: {} }))
  assert.deepEqual(out.procedures, [{ id: 'proc-abcdef123456', name: '배송지', host: 'shop.example.test', stepCount: 2, paramNames: ['받는 분', '암호'] }])
  assert.equal(parse(await tools.handle(RUN, { tool: PROCEDURE_TOOL_NAMES.run, arguments: {} })).code, 'PROCEDURE_ARGS_INVALID')
  assert.match(validateProcedureArgs(PROCEDURE_TOOL_NAMES.run, { procedureId: 'x', extra: 1 }), /unknown/)
  assert.match(validateProcedureArgs(PROCEDURE_TOOL_NAMES.update, { procedureId: 'x', setConfirm: { s1: 'boom' } }), /setConfirm/)
  assert.equal(validateProcedureArgs(PROCEDURE_TOOL_NAMES.run, { procedureId: 'x', values: { a: 'b' }, fromStep: 's2', confirmed: ['s2'] }), null)
})

test('run: stops at the confirm step (needs_confirm, nothing pressed), then fromStep + confirmed finishes', async () => {
  const b = browser(); const tools = createProcedureTools({ procedures: service(), browser: b, env: ON })
  const frames = []; const tools2 = createProcedureTools({ procedures: service(), browser: b, env: ON, onStep: (run, event) => frames.push(event) })
  const first = parse(await tools2.handle(RUN, { tool: PROCEDURE_TOOL_NAMES.run, arguments: { procedureId: 'proc-abcdef123456', values: { '받는 분': '차민수' } } }))
  assert.deepEqual([first.status, first.stepId, first.confirm, first.done], ['needs_confirm', 's2', 'submit', ['s1']])
  assert.equal(b.calls.find(([name]) => name === 'egdesk_browser_fill')[1].text, '차민수')
  assert.ok(!b.calls.some(([name]) => name === 'egdesk_browser_click'))
  assert.deepEqual([frames[0].op, frames[0].phase], ['activity', 'start']); assert.equal(frames.at(-1).phase, 'stop')
  const second = parse(await tools.handle(RUN, { tool: PROCEDURE_TOOL_NAMES.run, arguments: { procedureId: 'proc-abcdef123456', fromStep: 's2', confirmed: ['s2'] } }))
  assert.deepEqual([second.status, second.done], ['done', ['s2']])
  assert.ok(b.calls.some(([name]) => name === 'egdesk_browser_click'))
})

test('run: card and procedure refusals are closed codes', async () => {
  const tools = createProcedureTools({ procedures: service(), browser: browser(), env: ON })
  const noCard = parse(await tools.handle({ ...RUN, browserBinding: { cards: [{ cardId: 'c', permission: 'observe' }] } }, { tool: PROCEDURE_TOOL_NAMES.run, arguments: { procedureId: 'proc-abcdef123456' } }))
  assert.equal(noCard.code, 'TASK_NO_INTERACT_CARD')
  assert.equal(parse(await tools.handle(RUN, { tool: PROCEDURE_TOOL_NAMES.run, arguments: { procedureId: 'nope' } })).code, 'procedure_unknown')
})

test('save: captures the last task on that card in this thread and saves it', async () => {
  const s = service(); const tools = createProcedureTools({ procedures: s, browser: browser(), env: ON })
  const out = parse(await tools.handle(RUN, { tool: PROCEDURE_TOOL_NAMES.save, arguments: { name: '내 배송지' } }))
  assert.deepEqual([out.status, out.id, out.name, out.stepCount, out.confirmSteps], ['saved', 'proc-0123456789ab', '내 배송지', 2, ['s2']])
  assert.deepEqual(s.log[0], ['capture', 't1', 'card', '내 배송지'])
  const empty = createProcedureTools({ procedures: { ...s, captureDraft: async () => { throw new Error('none') } }, browser: browser(), env: ON })
  assert.equal(parse(await empty.handle(RUN, { tool: PROCEDURE_TOOL_NAMES.save, arguments: {} })).code, 'nothing_to_save')
})

test('update: rename, remove a step, set a default, mark a confirm; a sensitive param takes no default', async () => {
  const s = service(); const tools = createProcedureTools({ procedures: s, browser: browser(), env: ON })
  const out = parse(await tools.handle(RUN, { tool: PROCEDURE_TOOL_NAMES.update, arguments: { procedureId: 'proc-abcdef123456', name: '새 이름', setDefaults: { '받는 분': '박서준' }, setConfirm: { s1: 'delete', s2: null } } }))
  assert.equal(out.status, 'updated')
  const saved = s.store.get('proc-abcdef123456')
  assert.equal(saved.name, '새 이름'); assert.equal(saved.params[0].default, '박서준'); assert.equal(saved.steps[0].confirm, 'delete'); assert.equal(saved.steps[1].confirm, undefined)
  const edit = applyProcedureEdit(PROC(), { removeSteps: ['s2'] })
  assert.deepEqual(edit.procedure.steps.map(step => step.id), ['s1']); assert.deepEqual(edit.procedure.params.map(p => p.name), ['받는 분'], 'a param no step uses is dropped')
  assert.equal(applyProcedureEdit(PROC(), { setDefaults: { 암호: 'x' } }).error, 'param_sensitive')
  assert.equal(applyProcedureEdit(PROC(), { removeSteps: ['s9'] }).error, 'step_unknown')
  assert.equal(applyProcedureEdit(PROC(), { removeSteps: ['s1', 's2'] }).error, 'no_steps_left')
})
