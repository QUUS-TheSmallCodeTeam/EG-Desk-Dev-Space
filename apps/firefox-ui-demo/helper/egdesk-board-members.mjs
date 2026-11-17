// CHAT-10: a Board room's members as the chat store keeps them (v3
// room_members), for the screen. The Desk pref kept them as names; the store
// is now where they live, so a restart or another window reads the same room.
//   GET  /chat/board/members?clientThreadId=  → { clientThreadId, members, saved }
//   POST /chat/board/members { clientThreadId, members } → { accepted, clientThreadId, members }
// Local-store reads/writes only: no engine, no turn, no account check. A room
// that has never been sent is created by the first write (like /chat/share),
// and reads as { members: [], saved: false } until then.
import { chatError } from './codex-chat-values.mjs'

export const BOARD_MEMBERS_PATH = '/chat/board/members'
const ROOM_FIELDS = new Set(['clientThreadId', 'members'])

function roomId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 300 || value.includes('\0')) {
    throw chatError('INVALID_BOARD_MEMBERS', 'clientThreadId of the Board room is required', 400)
  }
  return value
}

function boardStore(chat) {
  if (typeof chat?.assertStore !== 'function') throw chatError('CHAT_ACTION_UNAVAILABLE', 'This bridge does not keep Board members', 501)
  const store = chat.assertStore()
  for (const method of ['getConversation', 'createConversation', 'listRoomMembers', 'setRoomMembers']) {
    if (typeof store?.[method] !== 'function') throw chatError('CHAT_ACTION_UNAVAILABLE', 'This bridge does not keep Board members', 501)
  }
  return store
}

const storeFailure = (error, what) => {
  if (error?.code === 'INVALID_CHAT_RECORD' || error?.code === 'ROOM_MEMBER_LIMIT') return chatError('INVALID_BOARD_MEMBERS', error.message, 400)
  if (typeof error?.httpStatus === 'number' && error.httpStatus < 500 && typeof error.code === 'string') return error
  return chatError('CHAT_STORE_UNAVAILABLE', `Local chat history could not ${what} the Board members`, 503)
}

/** The room's saved members in order; a room never saved reads as empty. */
export function readBoardMembers(chat, clientThreadId) {
  const id = roomId(clientThreadId)
  const store = boardStore(chat)
  try {
    if (!store.getConversation(id)) return { clientThreadId: id, members: [], saved: false }
    return { ...store.listRoomMembers(id), saved: true }
  } catch (error) { throw storeFailure(error, 'read') }
}

/** Replace the room's members (in order) in one write; the room is created when new. */
export function writeBoardMembers(chat, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !ROOM_FIELDS.has(key))) {
    throw chatError('INVALID_BOARD_MEMBERS', 'Send {clientThreadId, members}', 400)
  }
  const id = roomId(body.clientThreadId)
  if (!Array.isArray(body.members)) throw chatError('INVALID_BOARD_MEMBERS', 'members must be a list', 400)
  const store = boardStore(chat)
  const now = typeof chat.now === 'function' ? chat.now() : Date.now()
  try {
    if (!store.getConversation(id)) store.createConversation({ clientThreadId: id, createdAt: now })
    return { accepted: true, ...store.setRoomMembers({ clientThreadId: id, members: body.members, ts: now }) }
  } catch (error) { throw storeFailure(error, 'save') }
}
