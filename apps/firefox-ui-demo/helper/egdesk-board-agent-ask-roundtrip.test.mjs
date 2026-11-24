import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { createReviewFlow, createReviewStore } from '../overlay/resources/EGDeskReviewHandoff.sys.mjs'
import { createBoardAgentAskService } from './egdesk-board-agent-ask.mjs'
import { selectBoardAgentContext } from './egdesk-board-agent-context.mjs'
import { BOARD_AGENT_DRAFT_INSTRUCTIONS, BOARD_AGENT_DRAFT_REPLY_STYLES, createBoardAgentDraftTransport } from './egdesk-board-agent-draft.mjs'
import { createDecisionClient, DECISIONS_ENDPOINT, DECISION_MODEL } from './egdesk-decision-client.mjs'
import { openDeskStore } from './egdesk-desk-store.mjs'
import { loadEGDeskPortableDependencies, REVIEW_BUNDLE_FORMAT } from './egdesk-portable-bundle.mjs'
import { createPortableReviewService } from './egdesk-portable-review.mjs'
import { openProfileStore, PROFILE_TEMPLATES } from './egdesk-profile-store.mjs'

const dependencies = await loadEGDeskPortableDependencies().catch(() => null)
const needsBundle = { skip: !dependencies && 'portable ZIP/envelope dependencies are not installed' }
const START = Date.UTC(2026, 10, 18)
const PHRASE = 'synthetic ask file passphrase'
const DECISION_KEY = 'sk-proj-SyntheticDecisionFixtureOnly'
const DRAFT_KEY = 'sk-proj-SyntheticDraftFixtureOnly'
const DRAFT_MODEL = 'synthetic-responses-model'
const PROFILE_NAME = 'Unshared synthetic host Agent name'
const PRIVATE_INSTRUCTIONS = 'Synthetic full host instructions that must stay on the host.'
const PRIVATE_BOARD = 'Synthetic host planning card that was not approved for sharing.'
const GUIDANCE = 'Use one brief sentence.'
const EXCERPT = 'The rehearsal will take place in the atrium on Friday.'
const IRRELEVANT = 'A catering invoice totals seventy synthetic credits.'
const QUESTION = 'Where is the rehearsal?'
const GUEST_TEXT = 'Synthetic guest disclosure for the human reviewer only.'
const DRAFT_ANSWER = 'The rehearsal is in the atrium.'
const md = text => createHash('sha256').update(text).digest('hex')
const bundle = bytes => ({ bundle: bytes.toString('base64') })
const noDisclosure = (value, excluded, label) => {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
  for (const item of excluded) assert.ok(!data.includes(item), label) // Never dump fixture plaintext or bearer values on failure.
}
const exactJson = (actual, expected, label) => assert.ok(JSON.stringify(actual) === JSON.stringify(expected), label)

function install(t, name, now, notes) {
  const root = createPrivateQaTempDirectory(`egdesk-board-ask-${name}-`)
  const desk = openDeskStore({ dataDir: path.join(root, 'desk'), ownerScope: 'local-desktop-v1', now, utcOffsetMinutes: 0 })
  const profiles = openProfileStore({ dataDir: path.join(root, 'profiles'), ownerHash: 'local-desktop-v1' })
  t.after(() => { desk.close(); profiles.close(); rmSync(root, { recursive: true, force: true }) })
  const boards = [{ id: `agenda-${name}-primary`, title: `${name} primary Board` }, { id: `agenda-${name}-other`, title: `${name} alternate Board` }]
  for (const board of boards) desk.saveBoard(board.id, { expectedRevision: null, body: {
    version: 1, savedAt: now(), agenda: { ...board, memberCardIds: ['note'], contextBindings: [] },
    cards: [{ id: 'note', type: 'result', runtimeState: { text: notes } }], shapes: [],
  } })
  const directory = path.join(root, 'exports')
  const service = createPortableReviewService({ dependencies, home: root, location: () => ({ directory }) })
  const prefsFile = path.join(root, 'review-preference.json')
  const read = () => existsSync(prefsFile) ? readFileSync(prefsFile, 'utf8') : ''
  const write = value => writeFileSync(prefsFile, value, { mode: 0o600 })
  const store = createReviewStore({ read, write })
  return { root, desk, profiles, boards, service, read, store, file: output => readFileSync(path.join(directory, output.fileName)) }
}

function reviewFlow(machine, supported = () => true) {
  const binding = Object.freeze({}), [first, other] = machine.boards
  let bytes, output, view
  const flow = createReviewFlow({
    request: async (_, route, body, { signal }) => {
      if (route === '/v1/portable/review/export') {
        output = await machine.service.exportReview(body, { signal })
        return { status: 201, body: output }
      }
      if (route === '/v1/portable/review/inspect') return { status: 200, body: await machine.service.inspectReview(body, { signal }) }
      assert.fail('File exchange must only call Review routes')
    },
    pickFile: async () => ({ bytes }), getContext: () => binding, isContextCurrent: value => value === binding,
    getBoard: id => [first, other].find(board => board.id === id), isBoardCurrent: board => board === first || board === other,
    store: machine.store, supported, onState: next => { view = next },
  })
  return { flow, output: () => output, view: () => view, async openFile(file) { bytes = file; flow.openFile(); await flow.chooseFile(); return view } }
}

for (const mode of ['extract', 'draft']) test(`encrypted guest question and one explicitly returned reply (${mode})`, needsBundle, async t => {
  let time = START
  const now = () => time
  const host = install(t, `host-${mode}`, now, PRIVATE_BOARD)
  const guest = install(t, `guest-${mode}`, now, 'Synthetic guest Board contents not shared.')
  const [hostBoard, wrongBoard] = host.boards
  const [guestBoard, otherBoard] = guest.boards
  const allHeads = () => [host, guest].flatMap(machine => machine.boards.map(board => md(JSON.stringify(machine.desk.board(board.id).head))))
  const headsBefore = allHeads()
  const active = host.profiles.activate(host.profiles.createDraft({ ...PROFILE_TEMPLATES[0].body, name: PROFILE_NAME, instructions: PRIVATE_INSTRUCTIONS, model: null }).id, 1, null)
  const originalProfile = md(JSON.stringify(host.profiles.get(active.id)))
  assert.equal(guest.profiles.list().profiles.length, 0)

  const outgoing = []
  const decision = createDecisionClient({ getApiKey: () => DECISION_KEY, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body)
    outgoing.push({ kind: 'decision', url, body, ownKeyOnly: init.headers.authorization === `Bearer ${DECISION_KEY}` })
    return { ok: true, status: 200, text: async () => JSON.stringify({
      model: DECISION_MODEL, answers: body.questions.map(({ name, type }) => ({ name, type, probability: name === 'c1' ? 0.97 : 0.03 })),
    }) }
  } })
  const draft = createBoardAgentDraftTransport({ readConfig: () => ({ apiKey: DRAFT_KEY, model: DRAFT_MODEL }), fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body)
    outgoing.push({ kind: 'draft', url, body, ownKeyOnly: init.headers.authorization === `Bearer ${DRAFT_KEY}` })
    return Response.json({ object: 'response', status: 'completed', model: DRAFT_MODEL, output: [{
      type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: DRAFT_ANSWER }],
    }] })
  } })
  const ask = createBoardAgentAskService({ desk: host.desk, profiles: host.profiles, selectContext: selectBoardAgentContext, now,
    decisionStatus: () => ({ client: decision, mode: 'on', model: DECISION_MODEL, bindingId: 'fixture-decision-binding' }), draft,
    draftPreview: style => `${BOARD_AGENT_DRAFT_INSTRUCTIONS}\n${BOARD_AGENT_DRAFT_REPLY_STYLES[style]}`,
  })
  t.after(() => ask.close())
  const saved = ask.policy({ boardId: hostBoard.id, action: 'save', expectedVersion: null, profileId: active.id, excerpts: [EXCERPT, IRRELEVANT], publicInstructions: GUIDANCE })
  assert.equal(saved.policy.profileId, active.id)
  assert.equal(saved.policy.profileRevision, active.activeRevision)
  ask.policy({ boardId: wrongBoard.id, action: 'save', expectedVersion: null, profileId: active.id, excerpts: [], publicInstructions: '' })
  const change = (action, expectedVersion) => ask.policy({ boardId: hostBoard.id, action, expectedVersion })
  const issue = version => change('issue', version)
  const decisionEgress = mode === 'draft'
  const prepare = (request, boardId = hostBoard.id) => ask.prepare({ boardId, request, mode, decisionEgress })
  async function makeRequest(issued) {
    const request = reviewFlow(guest)
    request.flow.openRequest(guestBoard)
    assert.equal(request.flow.previewRequest({ askCode: issued.askCode, question: QUESTION, recipient: 'Host reviewer',
      excerpt: GUEST_TEXT, expectedReply: 'Give just the place.' }), true)
    await request.flow.exportFile({ passphrase: PHRASE, confirm: PHRASE })
    assert.equal(request.view().step, 'exported')
    const sent = request.output()
    return { sent, bytes: guest.file(sent) }
  }
  async function assertManual(bytes) {
    const manual = reviewFlow(host)
    assert.equal((await manual.openFile(bytes)).step, 'locked')
    await manual.flow.unlock(PHRASE)
    assert.equal(manual.view().step, 'request-inspected')
    assert.equal(manual.flow.beginReply(), true, 'rejected authorization does not remove manual reply')
    assert.equal(manual.flow.previewReply('Human review is still available.'), true)
    assert.equal(manual.output(), undefined, 'manual preview does not run or export a reply')
  }
  let issued = issue(saved.policy.version)
  assert.notEqual(issued.policy.version, saved.policy.version, 'issuance advances the CAS version')
  const issuedCodes = [issued.askCode]
  assert.ok(/^egask1-[0-9a-f]{32}$/.test(issued.askCode), 'issuer produced a canonical code')
  noDisclosure(ask.policy({ boardId: hostBoard.id, action: 'get' }), [issued.askCode, PRIVATE_INSTRUCTIONS], 'policy read did not echo code or private instructions')
  if (mode === 'draft') {
    const old = await makeRequest(issued)
    const expired = await host.service.inspectReview({ ...bundle(old.bytes), passphrase: PHRASE })
    time = issued.expiresAt
    assert.throws(() => prepare(expired.review), { code: 'BOARD_AGENT_ASK_CODE_INVALID' })
    assert.equal(ask.policy({ boardId: hostBoard.id, action: 'get' }).policy.codeActive, false)
    await assertManual(old.bytes)
    assert.equal(outgoing.length, 0)
    const previousVersion = issued.policy.version
    issued = issue(previousVersion)
    assert.notEqual(issued.policy.version, previousVersion)
    for (const action of ['issue', 'revoke']) {
      assert.throws(() => change(action, previousVersion), { code: 'BOARD_AGENT_ASK_POLICY_CONFLICT' })
    }
    issuedCodes.push(issued.askCode)
  }
  assert.equal(issued.policy.codeActive, true)
  const { sent, bytes } = await makeRequest(issued)
  assert.equal(sent.encrypted, true)
  const { requestId, requestDigest } = sent.review
  noDisclosure(bytes, [issued.askCode, QUESTION, PHRASE, requestId], 'request discloses no cleartext')
  const guestPending = guest.read()
  await assert.rejects(host.service.inspectReview({ fileRef: sent.fileRef, passphrase: PHRASE }), { code: 'PORTABLE_FILE_NOT_FOUND' })
  const ordinary = createPortableReviewService({ dependencies: {}, location: () => ({ directory: host.root }) })
  assert.equal(await ordinary.supported(), false)
  const unsupported = reviewFlow(host, () => false)
  await unsupported.openFile(bytes)
  assert.equal(unsupported.flow.beginReply(), false, 'a missing Review capability cannot authorize an answer')
  assert.equal(outgoing.length, 0)
  assert.deepEqual(await host.service.inspectReview(bundle(bytes)), { encrypted: true, locked: true })
  const checked = await host.service.inspectReview({ ...bundle(bytes), passphrase: PHRASE })
  assert.equal(checked.encrypted && !checked.locked, true)
  assert.ok(checked.review.askCode === issued.askCode, 'unlocked request contains the issued code')
  assert.throws(() => prepare(checked.review, wrongBoard.id), { code: 'BOARD_AGENT_ASK_CODE_INVALID' })
  await assertManual(bytes)
  const { askCode: _, ...ordinaryRequest } = checked.review
  assert.throws(() => prepare(ordinaryRequest), { code: 'BOARD_AGENT_ASK_CODE_REQUIRED' })
  const preview = prepare(checked.review)
  assert.equal(preview.mode, mode)
  exactJson(preview.excerpts, [EXCERPT, IRRELEVANT], 'preview lists the approved text only')
  noDisclosure(preview, [issued.askCode, requestId, requestDigest, PRIVATE_BOARD, PRIVATE_INSTRUCTIONS, DECISION_KEY, DRAFT_KEY], 'preview leaks private data')
  assert.equal(outgoing.length, 0, 'inspect and preview never invoke a provider')
  assert.equal(ask.policy({ boardId: hostBoard.id, action: 'get' }).policy.codeActive, true)
  await assert.rejects(ask.run({ ticket: preview.ticket, confirm: false }), { code: 'BOARD_AGENT_ASK_INPUT' })
  assert.equal(outgoing.length, 0)
  const siblingPreview = prepare(checked.review)
  const result = await ask.run({ ticket: preview.ticket, confirm: true })
  const answer = mode === 'draft' ? DRAFT_ANSWER : EXCERPT
  exactJson(result, { mode, answer, source: mode === 'draft' ? 'draft' : 'local', ...(mode === 'extract' ? { omittedCount: 0 } : { screening: 'decision' }) }, 'confirmed ask yields only an editable reply and disclosure mode')
  assert.equal(ask.policy({ boardId: hostBoard.id, action: 'get' }).policy.codeActive, false)
  for (const ticket of [preview.ticket, siblingPreview.ticket]) await assert.rejects(ask.run({ ticket, confirm: true }), { code: 'BOARD_AGENT_ASK_STALE' })
  assert.throws(() => prepare(checked.review), { code: 'BOARD_AGENT_ASK_CODE_INVALID' })
  assert.deepEqual(outgoing.map(call => call.kind), mode === 'draft' ? ['decision', 'draft'] : [])
  const privateValues = [...issuedCodes, PRIVATE_BOARD, PRIVATE_INSTRUCTIONS, PROFILE_NAME, active.id, active.active.hash,
    GUEST_TEXT, DECISION_KEY, DRAFT_KEY, PHRASE, hostBoard.id]
  if (mode === 'draft') {
    const [d, f] = outgoing
    assert.equal(d.url, DECISIONS_ENDPOINT)
    assert.equal(f.url, 'https://api.openai.com/v1/responses')
    assert.ok(d.ownKeyOnly && f.ownKeyOnly, 'only each provider’s dedicated fixture key is sent, exclusively in authorization')
    noDisclosure(outgoing, [...privateValues, requestId, requestDigest], 'provider JSON leaked unapproved data')
    exactJson(JSON.parse(d.body.input), { question: QUESTION, candidates: [{ alias: 'c1', text: EXCERPT }, { alias: 'c2', text: IRRELEVANT }] }, 'Decision sees the question and both approved candidates')
    noDisclosure(f.body, [IRRELEVANT], 'draft receives no owner-approved but unselected text')
    exactJson(JSON.parse(f.body.input[0].content[0].text), { question: QUESTION, excerpts: [EXCERPT], publicInstructions: GUIDANCE }, 'draft sees only selected evidence and approved guidance as user data')
    assert.ok(!f.body.instructions.includes(GUIDANCE), 'public guidance is not developer authority')
    assert.deepEqual([f.body.tools, f.body.store, f.body.tool_choice], [[], false, 'none'])
  }
  // The request ID/digest are the deliberately retained v2 reply correlation; unlike the code,
  // they must survive in the reply and the guest registry, but not in provider JSON.
  const reply = await host.service.exportReview({ review: { kind: 'reply', requestId, requestDigest, answer } })
  const replyFile = host.file(reply)
  noDisclosure(replyFile, [...privateValues, IRRELEVANT], 'reply file leaked unapproved data')
  assert.equal(reply.encrypted, false)
  const entryNames = []
  await dependencies.codec.read(replyFile, async entry => {
    const chunks = []
    for await (const chunk of entry.bytes()) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    entryNames.push(entry.name)
    if (entry.name === 'manifest.json') {
      noDisclosure(bytes, privateValues, 'reply manifest leaked unapproved data')
      exactJson(JSON.parse(bytes), { format: REVIEW_BUNDLE_FORMAT, version: 2,
        review: { kind: 'reply', requestId, requestDigest, answer } }, 'reply contains only the confirmed answer and its original correlation')
    } else assert.equal(bytes.length, 0, 'reply transcript and event entries are empty')
  })
  assert.deepEqual(entryNames, ['manifest.json', 'events.jsonl', 'transcript.md'])
  assert.equal(host.read(), '', 'host never issues or attaches a Board reply locally')
  const model = reviewFlow(guest)
  const view = await model.openFile(replyFile)
  assert.equal(view.step, 'reply-inspected')
  assert.equal(view.canReturn, true)
  assert.equal(view.boardTitle, guestBoard.title)
  assert.ok(guest.read() === guestPending, 'inspect has not stored the reply')
  assert.equal(model.flow.confirmReturn(), true)
  assert.equal((await model.openFile(replyFile)).canReturn, false)
  assert.equal(model.flow.confirmReturn(), false)
  exactJson(guest.store.results(guestBoard.id).map(row => row.answer), [answer], 'once-confirmed reply attaches only to the issuer Board')
  assert.equal(guest.store.results(otherBoard.id).length, 0)
  assert.equal(guest.profiles.list().profiles.length, 0, 'guest never imports an Agent')
  assert.equal(md(JSON.stringify(host.profiles.get(active.id))), originalProfile, 'profile unchanged')
  assert.deepEqual(allHeads(), headsBefore, 'no Board revision or edit rights transferred')
  noDisclosure(guest.read(), [...privateValues, IRRELEVANT], 'guest registry leaked unapproved data')
})
