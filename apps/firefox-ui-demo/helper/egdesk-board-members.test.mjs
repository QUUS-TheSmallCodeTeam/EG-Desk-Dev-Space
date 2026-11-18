import test from 'node:test'
import assert from 'node:assert/strict'
import { realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { openChatStore } from './egdesk-chat-store.mjs'
import { createChatHttpHandler } from './codex-bridge-http.mjs'
import { BOARD_MEMBERS_PATH, readBoardMembers, writeBoardMembers } from './egdesk-board-members.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const T = 1_800_000_000_000

function storeChat(t) {
  const dataDir = createPrivateQaTempDirectory('egdesk-board-members-test-')
  const store = openChatStore({ dataDir, ownerScope: 'desktop/profile-a' })
  t.after(() => {
    store.close()
    assert.equal(realpathSync.native(dataDir), dataDir)
    assert.match(path.basename(dataDir), /^egdesk-board-members-test-/)
    rmSync(dataDir, { recursive: true, force: true })
  })
  return { store, chat: { assertStore: () => store, now: () => T } }
}

function request(method, url, body = '', headers = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : [])
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:39218', 'content-type': 'application/json', ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}
function response() {
  return { headers: {}, setHeader(key, value) { this.headers[key] = value }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers) }, end(body) { this.body = body ? JSON.parse(body) : null } }
}

const members = [
  { kind: 'user', role: 'owner' },
  { kind: 'agent', profileId: 'designer', label: '디자이너', role: 'member' },
  { kind: 'agent', label: 'Codex', role: 'member' },
]

test('CHAT-10: a room never saved reads empty; the first write creates it and keeps members in order', (t) => {
  const { store, chat } = storeChat(t)
  assert.deepEqual(readBoardMembers(chat, 'room-1'), { clientThreadId: 'room-1', members: [], saved: false, rosterSaved: false })
  assert.equal(store.getConversation('room-1'), null, 'reading never creates the room')
  const written = writeBoardMembers(chat, { clientThreadId: 'room-1', members })
  assert.equal(written.accepted, true)
  assert.deepEqual(written.members.map(member => [member.memberKey.split(':')[0], member.kind, member.profileId, member.label, member.role]), [
    ['user', 'user', null, null, 'owner'], ['agent', 'agent', 'designer', '디자이너', 'member'], ['legacy', 'agent', null, 'Codex', 'member'],
  ])
  assert.ok(store.getConversation('room-1'))
  const read = readBoardMembers(chat, 'room-1')
  assert.equal(read.saved, true)
  assert.deepEqual(read.members, written.members)
  // The list read back can be written again as is (memberKey and addedAt kept).
  const again = writeBoardMembers(chat, { clientThreadId: 'room-1', members: read.members.slice(0, 2) })
  assert.deepEqual(again.members, read.members.slice(0, 2))
})

test('Board roster recovery distinguishes a native conversation with no saved roster from one explicitly cleared', (t) => {
  const { store, chat } = storeChat(t)
  const clientThreadId = 'synthetic-board'
  store.createConversation({ clientThreadId, createdAt: T })
  assert.deepEqual(readBoardMembers(chat, clientThreadId), { clientThreadId, members: [], saved: false, rosterSaved: false })
  writeBoardMembers(chat, { clientThreadId, members })
  assert.equal(readBoardMembers(chat, clientThreadId).rosterSaved, true)
  writeBoardMembers(chat, { clientThreadId, members: [] })
  for (let read = 0; read < 2; read++) {
    assert.deepEqual(readBoardMembers(chat, clientThreadId), { clientThreadId, members: [], saved: true, rosterSaved: true })
  }
})

test('CHAT-10: Board member writes refuse bad input plainly and never half-save', (t) => {
  const { store, chat } = storeChat(t)
  for (const [body, code] of [
    [{ clientThreadId: '', members }, 'INVALID_BOARD_MEMBERS'],
    [{ clientThreadId: 'room-1' }, 'INVALID_BOARD_MEMBERS'],
    [{ clientThreadId: 'room-1', members, extra: 1 }, 'INVALID_BOARD_MEMBERS'],
    [{ clientThreadId: 'room-1', members: [{ kind: 'user' }, { kind: 'user' }] }, 'INVALID_BOARD_MEMBERS'],
    [{ clientThreadId: 'room-1', members: [{ kind: 'agent', profileId: 'Bad ID' }] }, 'INVALID_BOARD_MEMBERS'],
    [[], 'INVALID_BOARD_MEMBERS'],
  ]) assert.throws(() => writeBoardMembers(chat, body), error => error.code === code && error.httpStatus === 400, JSON.stringify(body))
  assert.deepEqual(readBoardMembers(chat, 'room-1').members, [])
  assert.throws(() => readBoardMembers({}, 'room-1'), error => error.code === 'CHAT_ACTION_UNAVAILABLE' && error.httpStatus === 501)
  const broken = { assertStore: () => ({ ...store, getConversation() { throw new Error('disk gone') }, createConversation: store.createConversation, listRoomMembers: store.listRoomMembers, setRoomMembers: store.setRoomMembers }) }
  assert.throws(() => readBoardMembers(broken, 'room-1'), error => error.code === 'CHAT_STORE_UNAVAILABLE' && error.httpStatus === 503 && !/disk gone/.test(error.message))
})

test('CHAT-10: GET/POST /chat/board/members go through the loopback guard, need no account check and answer the store', async (t) => {
  const { chat } = storeChat(t)
  let auth = 0
  const handler = createChatHttpHandler(chat, async () => { auth++ })
  const call = async (method, target, body = '', headers = {}) => {
    const res = response()
    assert.equal(await handler(request(method, target, body, headers), res, new URL(`http://localhost${target}`)), true)
    return res
  }
  const empty = await call('GET', `${BOARD_MEMBERS_PATH}?clientThreadId=room-1`)
  assert.deepEqual([empty.status, empty.body.saved, empty.body.members], [200, false, []])
  const saved = await call('POST', BOARD_MEMBERS_PATH, JSON.stringify({ clientThreadId: 'room-1', members }))
  assert.deepEqual([saved.status, saved.body.accepted, saved.body.members.length], [200, true, 3])
  const read = await call('GET', `${BOARD_MEMBERS_PATH}?clientThreadId=room-1`)
  assert.deepEqual(read.body.members.map(member => member.label), [null, '디자이너', 'Codex'])
  assert.equal(auth, 0)
  for (const [method, target, body, headers, status, code] of [
    ['GET', `${BOARD_MEMBERS_PATH}?clientThreadId=room-1&x=1`, '', {}, 400, 'INVALID_BOARD_MEMBERS'],
    ['GET', BOARD_MEMBERS_PATH, '', {}, 400, 'INVALID_BOARD_MEMBERS'],
    ['POST', BOARD_MEMBERS_PATH, '{"clientThreadId":"room-1","members":[{"kind":"robot"}]}', {}, 400, 'INVALID_BOARD_MEMBERS'],
    ['POST', BOARD_MEMBERS_PATH, 'not json', {}, 400, 'INVALID_JSON'],
    ['POST', BOARD_MEMBERS_PATH, '{}', { origin: 'https://evil.example' }, 403, 'BOARD_MEMBERS_LOOPBACK_REQUIRED'],
    ['GET', `${BOARD_MEMBERS_PATH}?clientThreadId=room-1`, '', { 'sec-fetch-site': 'cross-site' }, 403, 'BOARD_MEMBERS_LOOPBACK_REQUIRED'],
  ]) {
    const res = await call(method, target, body, headers)
    assert.deepEqual([res.status, res.body.code], [status, code], `${method} ${target} ${body}`)
  }
  assert.equal((await call('GET', `${BOARD_MEMBERS_PATH}?clientThreadId=room-1`)).body.members.length, 3, 'refused writes changed nothing')
  // Other methods on the path are not this route.
  const res = response()
  assert.equal(await handler(request('PUT', BOARD_MEMBERS_PATH, '{}'), res, new URL(`http://localhost${BOARD_MEMBERS_PATH}`)), false)
  // A bridge without a chat store answers 501, not a crash.
  const bare = createChatHttpHandler({}, async () => {})
  const bareRes = response()
  await bare(request('GET', `${BOARD_MEMBERS_PATH}?clientThreadId=room-1`), bareRes, new URL(`http://localhost${BOARD_MEMBERS_PATH}?clientThreadId=room-1`))
  assert.deepEqual([bareRes.status, bareRes.body.code], [501, 'CHAT_ACTION_UNAVAILABLE'])
})
