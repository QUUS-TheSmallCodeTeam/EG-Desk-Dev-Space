import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BOARD_AGENT_DRAFT_INSTRUCTIONS,
  BOARD_AGENT_DRAFT_REPLY_STYLES,
  createBoardAgentDraftTransport,
} from './egdesk-board-agent-draft.mjs'

const model = 'gpt-board-test-2026-11-15'
const key = 'board-fixture-only'
const failure = { code: 'BOARD_AGENT_DRAFT_UNAVAILABLE', message: 'The Board draft service could not return a complete text answer' }
const cancelled = { code: 'BOARD_AGENT_DRAFT_CANCELLED' }
const stale = { code: 'BOARD_AGENT_DRAFT_STALE' }
const inputError = { code: 'BOARD_AGENT_DRAFT_INPUT' }
const deferred = () => {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}
const envelope = (text = '안녕하세요!') => ({
  id: 'resp_demo', object: 'response', created_at: 123, status: 'completed', model, error: null,
  incomplete_details: null, previous_response_id: null, conversation: null, store: false,
  metadata: {}, tools: [], tool_choice: 'none',
  output: [{ id: 'msg_demo', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer',
    content: [{ type: 'output_text', text, annotations: [], logprobs: [] }] }],
})
const response = value => Response.json(value)

function fixture(handler = () => response(envelope())) {
  let config = { apiKey: key, model }
  const fetches = []
  const transport = createBoardAgentDraftTransport({
    readConfig: () => config,
    fetchImpl(...args) {
      fetches.push(args)
      return handler(...args)
    },
  })
  return { transport, setConfig: value => { config = value }, fetches,
    prepare: () => {
      const { model, bindingId } = transport.status()
      return { model, bindingId, question: 'What did the Board decide?', excerpts: ['Selected text'],
        replyStyle: 'plain', isCurrent: () => true }
    },
  }
}

test('configuration is explicit and disabled by default, without reading ambient credentials', async () => {
  let attempted = 0
  const fetchImpl = () => { attempted++; throw new Error('not allowed') }
  for (const readConfig of [undefined, () => ({ apiKey: key }), () => ({ model }), () => ({ OPENAI_API_KEY: key, model }),
    () => ({ apiKey: `${key}\r\nheader: injected`, model }), () => ({ apiKey: key, model: ' model-with-space' }),
    () => { throw new Error('private config error') }]) {
    const transport = createBoardAgentDraftTransport({ readConfig, fetchImpl })
    assert.deepEqual(transport.status(), { configured: false, model: null })
    await assert.rejects(transport.draft({ question: 'Question', excerpts: [], replyStyle: 'warm',
      model, bindingId: 'untrusted-handle', isCurrent: () => true }), stale)
  }
  assert.equal(attempted, 0)
})

test('sends only the reviewed disclosure, to a fixed endpoint, in one non-storing tool-free request', async () => {
  const { transport, prepare, fetches } = fixture(() => response(envelope('Text with {"type":"tool_call"} remains inert.')))
  const prepared = { ...prepare(), question: 'question\nline two', excerpts: ['선택됨', 'Excerpt two'], replyStyle: 'warm' }
  assert.deepEqual(await transport.draft({ ...prepared,
    profileId: 'never-send', privateInstructions: 'never-send', publicInstructions: 'never-send',
    files: ['never-send'], memory: ['never-send'], metadata: 'never-send', sources: ['never-send'],
    previous_response_id: 'never-send', apiKey: 'never-send', url: 'https://example.invalid', tools: [{ name: 'never-send' }],
  }), { answer: 'Text with {"type":"tool_call"} remains inert.' })
  assert.equal(fetches.length, 1)
  const [url, options] = fetches[0]
  assert.equal(url, 'https://api.openai.com/v1/responses')
  assert.equal(options.method, 'POST')
  assert.equal(options.redirect, 'error')
  assert.equal(options.credentials, 'omit')
  assert.equal(options.cache, 'no-store')
  assert.equal(options.referrerPolicy, 'no-referrer')
  assert.ok(options.signal instanceof AbortSignal)
  assert.deepEqual(options.headers, { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' })
  assert.deepEqual(JSON.parse(options.body), {
    model, instructions: `${BOARD_AGENT_DRAFT_INSTRUCTIONS}\n${BOARD_AGENT_DRAFT_REPLY_STYLES.warm}`,
    input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ question: prepared.question, excerpts: prepared.excerpts }) }] }],
    text: { format: { type: 'text' } }, store: false, stream: false, tools: [], tool_choice: 'none',
    parallel_tool_calls: false, max_output_tokens: 2048,
  })
  for (const excluded of ['never-send', key, prepared.bindingId]) assert.equal(options.body.includes(excluded), false)
})

test('does not dispatch with unapproved credentials or model; public binding is opaque and local', async () => {
  const { transport, prepare, setConfig, fetches } = fixture()
  const status = transport.status()
  assert.deepEqual(Object.keys(status).sort(), ['bindingId', 'configured', 'model'])
  assert.equal(status.configured, true)
  assert.equal(status.model, model)
  assert.match(status.bindingId, /^[a-f\d-]{36}$/)
  assert.equal(transport.status().bindingId, status.bindingId)
  assert.notEqual(fixture().transport.status().bindingId, status.bindingId)
  const startedWith = prepare()
  await assert.rejects(transport.draft({ ...startedWith, model: 'other-model' }), stale)
  await assert.rejects(transport.draft({ ...startedWith, bindingId: undefined }), inputError)
  setConfig({ apiKey: `${key}-rotated`, model })
  await assert.rejects(transport.draft(startedWith), stale)
  const rotated = transport.status().bindingId
  assert.notEqual(rotated, status.bindingId)
  setConfig({ apiKey: key, model })
  await assert.rejects(transport.draft(startedWith), stale)
  assert.notEqual(transport.status().bindingId, status.bindingId)
  const newApproval = prepare()
  setConfig({ apiKey: key, model: `${model}-other` })
  await assert.rejects(transport.draft(newApproval), stale)
  assert.equal(fetches.length, 0)
})

test('validates style enum and byte-based input caps without a fetch', async () => {
  const { transport, prepare, fetches } = fixture()
  assert.deepEqual(Object.keys(BOARD_AGENT_DRAFT_REPLY_STYLES), ['plain', 'warm', 'concise', 'formal', 'playful'])
  const approval = prepare()
  for (const change of [{ replyStyle: '<user instruction>' }, { replyStyle: 'constructor' }, { replyStyle: { name: 'warm' } },
    { question: '가'.repeat(683) }, { question: 'x\u0000y' }, { excerpts: ['가'.repeat(3000), 'a'] }, { excerpts: [{ text: 'x' }] },
    { excerpts: Array(33).fill('text') }, { excerpts: Array(1) }, { isCurrent: undefined }, { signal: {} }]) {
    await assert.rejects(transport.draft({ ...approval, ...change }), inputError)
  }
  assert.equal(fetches.length, 0)
  assert.deepEqual(await transport.draft({ ...approval, question: 'x'.repeat(2048), excerpts: Array(6).fill('a'.repeat(1500)) }), { answer: '안녕하세요!' })
  assert.deepEqual(await transport.draft({ ...approval, excerpts: [] }), { answer: '안녕하세요!' })
})

test('rejects non-final, annotated, mixed, tool, refusal, and wrong-model responses without surfacing provider data', async t => {
  const message = result => result.output[0]
  const part = result => message(result).content[0]
  const variations = {
    wrongProviderShape: result => { result.object = 'chat.completion' },
    incomplete: result => { result.status = 'incomplete' },
    incompleteDetails: result => { result.incomplete_details = { reason: 'max_output_tokens' } },
    queued: result => { result.status = 'queued' },
    error: result => { result.error = { message: 'private provider detail' } },
    alternateModel: result => { result.model = 'other-model' },
    reusedProviderState: result => { result.previous_response_id = 'resp_old' },
    providerTools: result => { result.tools = [{ type: 'web_search' }] },
    toolCall: result => { result.output = [{ type: 'function_call' }] },
    actionAndText: result => { result.output.push({ type: 'computer_call' }) },
    reasoningAndText: result => { result.output.unshift({ type: 'reasoning' }) },
    wrongRole: result => { message(result).role = 'tool' },
    unfinishedMessage: result => { message(result).status = 'in_progress' },
    interimMessage: result => { message(result).phase = 'commentary' },
    messageAction: result => { message(result).action = { url: 'https://example.invalid' } },
    mixedContent: result => { message(result).content.push({ type: 'output_image' }) },
    refusal: result => { message(result).content = [{ type: 'refusal', refusal: 'private provider detail' }] },
    annotations: result => { part(result).annotations = [{ type: 'url_citation', url: 'https://example.invalid' }] },
    contentAction: result => { part(result).action = { url: 'https://example.invalid' } },
    blank: result => { part(result).text = ' \n' },
    control: result => { part(result).text = 'answer\u0000' },
    oversizedAnswer: result => { part(result).text = '한'.repeat(2731) },
    unknownOutputProperty: result => { result.actions = [{ type: 'send' }] },
    oversizedProtocol: result => { result.instructions = 'X'.repeat(65_536) },
  }
  for (const [name, mutate] of Object.entries(variations)) await t.test(name, async () => {
    const result = envelope()
    mutate(result)
    const { transport, prepare, fetches } = fixture(() => response(result))
    await assert.rejects(transport.draft(prepare()), failure)
    assert.equal(fetches.length, 1)
  })
  const maxAnswer = `${'한'.repeat(2730)}OK`
  const { transport, prepare } = fixture(() => response(envelope(maxAnswer)))
  assert.equal(Buffer.byteLength(maxAnswer), 8192)
  assert.deepEqual(await transport.draft(prepare()), { answer: maxAnswer })
})

test('sanitizes HTTP, redirect, encoding, parsing, and thrown fetch errors; never retries', async () => {
  const hidden = 'private provider URL and body'
  const mimetype = { 'content-type': 'application/json' }
  for (const respond of [() => { throw new Error(hidden) }, () => Promise.reject(new Error(hidden)),
    () => new Response(hidden, { status: 429, headers: mimetype }),
    () => new Response(JSON.stringify(envelope()), { status: 201, headers: mimetype }),
    () => new Response(hidden, { status: 307, headers: { location: 'https://example.invalid' } }),
    () => new Response(hidden, { headers: mimetype }),
    () => new Response(Uint8Array.of(0xff), { headers: mimetype }),
    () => new Response(JSON.stringify(envelope()), { headers: { 'content-type': 'text/event-stream' } })]) {
    const { transport, prepare, fetches } = fixture(respond)
    await assert.rejects(transport.draft(prepare()), failure)
    assert.equal(fetches.length, 1)
  }
})

test('checks approval immediately before dispatch and again before returning', async () => {
  const upstream = deferred()
  const { transport, prepare, fetches } = fixture(() => upstream.promise)
  const signal = AbortSignal.abort('private abort reason')
  await assert.rejects(transport.draft({ ...prepare(), signal }), cancelled)
  let checks = 0
  await assert.rejects(transport.draft({ ...prepare(), isCurrent: () => ++checks === 1 }), stale)
  await assert.rejects(transport.draft({ ...prepare(), isCurrent: () => { throw new Error('private approval error') } }), stale)
  assert.equal(fetches.length, 0)
  let approved = true
  const pending = transport.draft({ ...prepare(), isCurrent: () => approved })
  assert.equal(fetches.length, 1)
  approved = false
  upstream.resolve(response(envelope()))
  await assert.rejects(pending, stale)
})

test('rejects a response if config rotates in flight, even when approval is still current', async () => {
  const upstream = deferred()
  const { transport, prepare, setConfig, fetches } = fixture(() => upstream.promise)
  const pending = transport.draft(prepare())
  setConfig({ apiKey: `${key}-rotated`, model })
  upstream.resolve(response(envelope()))
  await assert.rejects(pending, stale)
  assert.equal(fetches.length, 1)
})

test('caller cancellation settles even if injected fetch never returns', async () => {
  const { transport, prepare, fetches } = fixture(() => new Promise(() => {}))
  const controller = new AbortController()
  const pending = transport.draft({ ...prepare(), signal: controller.signal })
  controller.abort('private abort reason')
  await assert.rejects(pending, cancelled)
  assert.equal(fetches.length, 1)
  assert.equal(fetches[0][1].signal.aborted, true)
})

test('the 15-second deadline covers a stalled provider body as well as fetch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const received = deferred()
  let bodyCancelled = false
  const { transport, prepare, fetches } = fixture(() => new Response(new ReadableStream({
    pull() { received.resolve() },
    cancel() { bodyCancelled = true },
  }), { headers: { 'content-type': 'application/json' } }))
  const pending = transport.draft(prepare())
  await received.promise
  t.mock.timers.tick(15_000)
  await assert.rejects(pending, cancelled)
  assert.equal(fetches.length, 1)
  assert.equal(fetches[0][1].signal.aborted, true)
  assert.equal(bodyCancelled, true)
})
