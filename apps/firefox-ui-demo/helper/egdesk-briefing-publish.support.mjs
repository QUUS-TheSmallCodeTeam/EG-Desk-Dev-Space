// Support module (not a test): the mounted bridge side for briefing `on` journeys. Real ImmutableContextStore + ContextRuntime + CodexChatRuntime; only the native
// app-server is a mock (thread/start, turn/start, thread/fork and fork turns answered by a scripted reply through the real notification path, as in the held-answers
// tests). A scene is a finished run whose room published four outputs, three of which the user kept as provenance-carrying result cards on a synthetic canvas.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ImmutableContextStore } from './egdesk-context-store.mjs'
import { ContextRuntime } from './egdesk-context-runtime.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'
import * as WorkbenchArrange from '../overlay/resources/EGDeskWorkbenchArrange.sys.mjs'
import { world } from '../scripts/egdesk-board-world.support.mjs'

export const toolJson = reply => JSON.parse(reply.result.contentItems[0].text)
const r = (x, y, width, height) => ({ x, y, width, height })
export const REPORT = ['## Billing', 'The Invoice totals show the Q3 amount that was billed to the customer.', '', '## Delivery', 'The Delivery log shows the shipment was two days late.', '',
  '## Next steps', 'Refund the delay fee and ship the replacement as soon as possible.'].join('\n')
export const design = () => ({ title: 'Why the shipment is late', steps: [
  { text: 'The invoice total shows the Q3 amount that was billed.', targets: ['T1'], fallback: 'Open the invoice totals.' },
  { text: 'The delivery log shows the shipment was two days late.', targets: ['T2'], emphasis: 'outline', fallback: 'Open the delivery log.' }] })
export const designWithNew = () => ({ ...design(), steps: [...design().steps, { text: 'The next steps summary lists what to do about it.', targets: ['new:P3'], fallback: 'See the next steps in chat.' }],
  newComponents: [{ part: 'P3', title: 'Next steps summary', summary: 'Refund the delay fee and ship the replacement' }] })
export const reuseScript = (parts = {}, check = () => ({ u: .96, issues: {} })) => n => n === 0 ? { placement: { value: 'board', p: .94 } }
  : n === 1 ? { components: { T1: { value: 'reuse', p: .92 }, T2: { value: 'reuse', p: .92 }, T3: { value: 'retrieve', p: .92 } }, parts } : check(n)

/**
 * harness(t, { forkReply, forkOk, decisionContext }) → the bridge side with one run in progress.
 *   forkReply(prompt, index) → the text the private fork turn answers with (null = the fork turn fails; undefined = forks are not expected).
 */
export async function harness(t, { forkReply = null, forkOk = true, decisionContext = undefined } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-briefing-publish-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cwd = path.join(dir, 'workspace'); await mkdir(cwd)
  let nativeSeq = 0, forks = 0, turns = 0
  const store = new ImmutableContextStore({ dataDir: path.join(dir, 'state'), allowedRoots: [cwd] })
  const contexts = new ContextRuntime({ store, getOwnerKey: () => 'email:a@example.com' })
  const replies = [], events = [], native = [], forkPrompts = []
  let chat
  const notify = (method, params) => chat.handleNotification({ method, params })
  chat = new CodexChatRuntime({ contexts, respond: (id, result, error) => replies.push({ id, result, error }), emit: e => events.push(e), ...(decisionContext ? { decisionContext } : {}),
    request: async (method, params) => {
      native.push([method, params?.threadId ?? null])
      if (method === 'thread/start') return { thread: { id: `parent-${++nativeSeq}` }, cwd, model: 'configured-model' }
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] }, cwd }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      if (method === 'thread/fork') { if (!forkOk) throw Object.assign(new Error('no fork'), { code: -32601 }); return { thread: { id: `fork-${++forks}`, forkedFromId: params.threadId } } }
      if (method === 'turn/start' && String(params.threadId).startsWith('fork-')) {
        const prompt = params.input[0].text, index = forkPrompts.length
        forkPrompts.push(prompt)
        assert.equal(typeof forkReply, 'function', 'a private fork turn was started but none was expected')
        const text = forkReply(prompt, index), turnId = `fturn-${index + 1}`
        setTimeout(async () => {
          if (text != null) await notify('item/completed', { threadId: params.threadId, turnId, item: { id: 'f1', type: 'agentMessage', phase: 'final_answer', text } })
          await notify('turn/completed', { threadId: params.threadId, turn: { id: turnId, status: text == null ? 'failed' : 'completed', items: [] } })
        }, 1)
        return { turn: { id: turnId, status: 'inProgress', items: [] } }
      }
      if (method === 'turn/start') return { turn: { id: `turn-${++turns}`, status: 'inProgress', items: [] } }
      if (method === 'turn/interrupt') return {}
      throw new Error(`Unexpected native method ${method}`)
    } })
  chat.setConnection(true)
  const source = (await contexts.capture({ clientThreadId: 'ui', attachments: [{ id: 'attachment', kind: 'browser', label: 'Selected page', sourceRef: { viewId: 'view-1', resourceId: 'page-1', url: 'https://example.com/p' },
    capturedAt: 10, captureScope: { type: 'dom-range', locator: '#selected' }, content: { mime: 'text/plain', text: 'Original selected text', truncated: false } }] })).captures[0]
  const run = await chat.send({ message: 'Use selected sources', requestId: 'req-1', clientThreadId: 'ui', cwd, contextSnapshotIds: [source.sourceId], contextCapabilities: { read: true, reader: true, publishBriefing: true } })
  const tool = async (name, args, id) => { await chat.handleServerRequest({ id, method: 'item/tool/call', params: { threadId: run.conversationId, turnId: run.runId, callId: id, tool: name, arguments: args } }); await contexts.calls.get(`${run.answerId}/${id}`); return replies.find(x => x.id === id) }
  // The answer is posted and the turn ends: from here on the run is finished (status 'completed').
  const finish = async (text = REPORT) => {
    const timing = { threadId: run.conversationId, turnId: run.runId }
    await notify('item/started', { ...timing, item: { id: 'ans', type: 'agentMessage', phase: 'final_answer', text: '' } })
    await notify('item/agentMessage/delta', { ...timing, itemId: 'ans', delta: text })
    await notify('item/completed', { ...timing, item: { id: 'ans', type: 'agentMessage', phase: 'final_answer', text } })
    await notify('turn/completed', { threadId: timing.threadId, turn: { id: timing.turnId, status: 'completed', items: [] } })
    for (let i = 0; i < 8; i++) { await chat.draftCheckIdle?.(); await new Promise(res => setTimeout(res, 2)) }
  }
  return { dir, cwd, store, contexts, chat, events, native, forkPrompts, run, tool, finish, ids: { conversationId: run.conversationId, runId: run.runId, answerId: run.answerId } }
}

const thread = { id: 'thread-1', title: 'Room', engineId: 'codex', profileEnabled: true, agentProfileId: 'prof-agent-1' }
/** The board: three result cards kept from this room's published outputs (two of this answer, one stale output of an earlier answer, superseded by v2 of its key). The run is finished unless finished:false. */
export async function scene(t, { withoutBriefingCapability = false, finished = true, ...options } = {}) {
  const h = await harness(t, options)
  const publish = async (title, markdown, outputKey, id) => toolJson(await h.tool('egdesk_publish_output', { title, markdown, outputKey }, id)).output
  const invoice = await publish('Invoice totals', '# Invoice totals\nQ3 invoice totals and the amount due', 'invoice-totals', 'o1')
  const delivery = await publish('Delivery log', '# Delivery log\nShipment log showing the delay of two days', 'delivery-log', 'o2')
  const oldV1 = await publish('Old shipment summary', '# Old shipment summary\nEarlier summary of the shipment', 'shipment-summary', 'o3')
  const oldV2 = await publish('Old shipment summary', '# Old shipment summary\nRevised summary of the shipment', 'shipment-summary', 'o4')
  if (finished) await h.finish(REPORT)
  const message = { id: 'm1', conversationId: h.run.conversationId, runId: h.run.runId, answerId: h.run.answerId, createdAt: 1 }
  const card = (meta, over = {}) => ChatState.publishedOutputCardRecord({ ...thread, conversationId: h.run.conversationId }, message, { ...meta, ...over }, `# ${meta.title}\nbody of ${meta.title}`, { now: 2 })
  const recA = card(invoice), recB = card(delivery)
  const recOld = ChatState.supersedeResultRecord(card(oldV1, { answerId: 'answer-earlier', runId: 'run-earlier' }), oldV2, { now: 9 })
  const spec = { cards: [{ id: 'vA', item: 'item-A', rect: r(100, 60, 260, 160), z: 1, kind: 'note' }], links: [],
    others: [{ id: 'res-a', rect: r(100, 300, 260, 160), z: 2, result: recA }, { id: 'res-b', rect: r(620, 300, 260, 160), z: 3, result: recB }, { id: 'res-old', rect: r(620, 60, 260, 160), z: 4, result: recOld }] }
  // The outputs above came from turns that had the capability. This answer's run is modelled as one the user sent WITHOUT the briefing capability: the field assertBound
  // checks is false for it (the same binding state a send without the grant produces), while the room's earlier outputs still exist in the store.
  if (withoutBriefingCapability) { const binding = h.contexts.bindings.get(h.contexts.bindingKey(h.chat.runFor(h.ids))); binding.capabilities = { ...binding.capabilities, publishBriefing: false } }
  const W = world({ WorkbenchArrange, http: async () => ({ status: 503, body: {} }), grant: () => true, spec })
  const cards = [{ id: 'res-a', kind: 'result', record: recA, rect: r(100, 300, 260, 160) }, { id: 'res-b', kind: 'result', record: recB, rect: r(620, 300, 260, 160) }, { id: 'res-old', kind: 'result', record: recOld, rect: r(620, 60, 260, 160) }]
  return { h, W, cards, recOld, outputs: { invoice, delivery, oldV1, oldV2 } }
}
