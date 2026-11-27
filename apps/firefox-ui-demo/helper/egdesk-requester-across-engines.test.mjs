// L1 c17, owner decision (c): Codex is a model engine; profile, subscription account, folder and screen combine freely. A run's requester, heartbeat,
// placements and data permissions follow the PERSON and the CONVERSATION (the local chat), never an engine profile, CODEX_HOME or a folder.
// Mid-session the engine profile (account) changes: the same local chat continues on a NEW native conversation id under another profile/home/folder.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import * as JP from '../overlay/resources/EGDeskJointPresence.sys.mjs'
import * as WP from '../overlay/resources/EGDeskWorkPlacement.sys.mjs'
import * as SurfaceState from '../overlay/resources/EGDeskSurfaceState.sys.mjs'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'
import { createRunRequesters as bridgeRunRequesters } from './egdesk-presence-mirror.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { EGRESS_KINDS } from './egdesk-decision-egress.mjs'

const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const decl = name => { const at = surface.indexOf(`  function ${name}(`), s = at >= 0 ? at : surface.indexOf(`  async function ${name}(`); assert.ok(s >= 0, name); return surface.slice(s, surface.indexOf('\n  }', s) + 4) }
const BOARD = '0b6f3f1e-2d4c-4a5b-8c7d-9e0f1a2b3c4d', B = 'm-0123456789abcdef', CHAT = 'local-dm'
const r = (x, y, width, height) => ({ x, y, width, height })
const OWNER = { member: 'self', self: true, active: true, viewport: r(0, 0, 1200, 800), focusCard: null, lastInputAgeMs: 400 }
const MEMBER = { member: B, self: false, active: true, viewport: r(2400, 200, 1200, 800), focusCard: null, lastInputAgeMs: 900 }
// Before and after the switch: same person, same local chat; another engine profile, account home and folder; a new native conversation
const BEFORE = { runId: 'run-1', conversationId: 'native-conv-a', clientThreadId: CHAT, engine: { id: 'codex', engineProfileId: 'codex-profile-a' }, codexHome: '/synthetic/home-a', cwd: '/synthetic/folder-a' }
const AFTER = { runId: 'run-2', conversationId: 'native-conv-b', clientThreadId: CHAT, engine: { id: 'codex', engineProfileId: 'codex-profile-b' }, codexHome: '/synthetic/home-b', cwd: '/synthetic/folder-b' }

function windowRig() {
  const posts = []
  const runs = { [ChatState.runKey(AFTER.conversationId, AFTER.runId)]: { runId: AFTER.runId, conversationId: AFTER.conversationId, clientThreadId: CHAT, localThreadId: CHAT } }
  const requesters = JP.createRunRequesters({ snapshot: () => [OWNER, MEMBER], seated: (board, alias) => board === BOARD && alias === B })
  const state = { activeEntityId: null, panTarget: { x: 0, y: 0 }, zoomTarget: 1, agenda: {}, surface: {}, presence: { snapshot: () => [OWNER, MEMBER].map(p => ({ ...p, viewport: { ...p.viewport } })) },
    codex: { chatProtocol: { runs } }, runRequesters: requesters, setCanvasPanTarget() {}, setCanvasViewportTarget() {} }
  const view = OWNER.viewport, clock = { now: 0 }
  const deps = { WorkPlacement: WP, SurfaceState, ChatState, state, readSurfacePref: () => 'on', document: { querySelectorAll: () => [] }, window: { addEventListener() {}, setTimeout: () => 1 },
    persistentEntityGeometry: n => ({ ...n._rect, zIndex: 1 }), cardKindForPersistence: () => 'file',
    safeViewportWorldRect: () => ({ left: view.x, top: view.y, right: view.x + view.width, bottom: view.y + view.height }), viewportToCanvasPoint: (x, y) => ({ x, y }),
    safeViewportRect: () => ({ left: 0, top: 0, right: view.width, bottom: view.height }),
    deskStoreRequest: async (method, path, body) => { posts.push({ path, body }); return { status: 200, body: { status: 'queued', id: 'wp-1' } } },
    workWaitNow: () => clock.now, workWaitSleep: async ms => { clock.now += ms } }
  const body = `let workInputAt = null, workInputWatch = false;\n${decl('workPresence')}\n${decl('workSceneInputs')}\n${decl('workRunRef')}\n${decl('noteWorkSurfacePlacement')}\nstate.noteWorkSurfacePlacement = noteWorkSurfacePlacement;\n${decl('placeWorkSurface')}\n${decl('resolveCanvasCardPlacement')}\nreturn { placeWorkSurface, workRunRef, noteWorkSurfacePlacement };`
  return { ...new Function(...Object.keys(deps), body)(...Object.values(deps)), posts, requesters, state }
}

test('window: the requester B was set for the chat; after the engine profile switch the run file viewer (which carries only the NEW native id) still finds B through the local chat', async () => {
  const rig = windowRig()
  assert.equal(rig.requesters.set({ clientThreadId: CHAT, conversationId: BEFORE.conversationId }, { board: BOARD, alias: B }), true)
  // the coupling c17 removed: looked up by the engine's native conversation id alone, the requester is lost at the switch
  assert.equal(rig.requesters.for({ runId: AFTER.runId, conversationId: AFTER.conversationId }), null)
  // the product now resolves the person's conversation first
  assert.deepEqual(rig.workRunRef({ runId: AFTER.runId, conversationId: AFTER.conversationId }), { runId: AFTER.runId, conversationId: AFTER.conversationId, clientThreadId: CHAT })
  assert.equal(rig.requesters.for(rig.workRunRef({ runId: AFTER.runId, conversationId: AFTER.conversationId })), B)
  // the file viewer's bounded wait (openVerifiedRunFile passes { kind, runId, conversationId }): the request is keyed by the local chat and names B as requester
  await rig.placeWorkSurface('file', { kind: 'file', runId: AFTER.runId, conversationId: AFTER.conversationId })
  const posted = rig.posts.find(p => p.path === '/decision/work-placement/request')
  assert.deepEqual([posted.body.clientThreadId, posted.body.conversationId], [CHAT, AFTER.conversationId])
  assert.ok(posted.body.dto.requester && posted.body.dto.members.some(m => m.alias === posted.body.dto.requester && !m.self), 'the requester is B (an alias), not the local person')
  assert.ok(!JSON.stringify(posted.body).includes('profile') && !JSON.stringify(posted.body).includes('/synthetic/'), 'no engine profile, home or folder in the request')
  // the advisory hook: same keys
  rig.posts.length = 0; rig.noteWorkSurfacePlacement('file', { x: 0, y: 0, width: 720, height: 520 }, { kind: 'file', runId: AFTER.runId, conversationId: AFTER.conversationId })
  assert.equal(rig.posts[0]?.body.clientThreadId, CHAT)
})

test('bridge: the requester registry and the heartbeat follow the local chat across the switch; data permissions do not depend on the engine profile, home or folder', () => {
  const rows = [{ member: B, self: false, active: true, viewport: null }]
  const reg = bridgeRunRequesters({ presence: { snapshot: () => rows } })
  assert.equal(reg.set([CHAT, BEFORE.conversationId], { board: BOARD, alias: B }), 'held')
  assert.deepEqual(reg.audience({ run: AFTER }), { requester: B, owner: 'self', participants: ['self'] }, 'the new native conversation, the same chat: B is still the requester')
  assert.equal(reg.audience({ run: { ...AFTER, clientThreadId: 'another-chat' } }), null, 'another conversation of the same engine profile: not B\'s')
  // the runtime keys a session heartbeat by the local chat (startHeartbeat: context.clientThreadId || cid) and maps every native id to it
  assert.match(surface.length ? readFileSync(new URL('./codex-chat-runtime.mjs', import.meta.url), 'utf8') : '', /const key = context\.clientThreadId \|\| cid\n      const live = this\.heartbeats\.get\(key\)/)
  const hb = { state: 'running' }
  const self = { heartbeats: new Map([[CHAT, hb]]), heartbeatThreads: new Map([[BEFORE.conversationId, hb], [AFTER.conversationId, hb]]) }
  for (const key of [CHAT, BEFORE.conversationId, AFTER.conversationId]) assert.equal(CodexChatRuntime.prototype.heartbeatFor.call(self, key), hb, key)
  // the run's data permissions (the egress gate the placement and the owner question use): the same for both runs
  const kinds = Object.values(EGRESS_KINDS)
  const allows = run => kinds.map(kind => CodexChatRuntime.prototype.decisionEgressFor.call({}, run, { canvasMaySend: true }).allows(kind))
  assert.deepEqual(allows(AFTER), allows(BEFORE))
})

test('code paths: nothing in the placement runtime, the requester registries or the presence mirror reads an engine profile, CODEX_HOME or a folder', () => {
  for (const file of ['./egdesk-work-placement.mjs', './egdesk-presence-mirror.mjs', '../overlay/resources/EGDeskWorkPlacement.sys.mjs', '../overlay/resources/EGDeskJointPresence.sys.mjs']) {
    const code = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
    for (const word of [/engineProfile/i, /CODEX_HOME/, /codexHome/i, /\bcwd\b/, /\bfolder/i, /ownerKey/, /accountKey/]) assert.ok(!word.test(code), `${file}: ${word}`)
  }
  for (const name of ['workRunRef', 'workSceneInputs', 'noteWorkSurfacePlacement', 'placeWorkSurface', 'noteWorkChatEvent', 'workSurfaceMark', 'resultCardPlacement']) {
    const code = decl(name)
    for (const word of [/engineProfile/i, /CODEX_HOME/, /codexHome/i, /\bcwd\b/, /bindingAccountKey/, /ownerKey/]) assert.ok(!word.test(code), `${name}: ${word}`)
  }
})
