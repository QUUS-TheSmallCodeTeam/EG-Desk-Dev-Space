import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'

const js = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length
const big = (n, tag) => Array.from({ length: n }, (_, i) => ({ id: `${tag}-m${i}`, role: i % 2 ? 'assistant' : 'user', text: `메시지 ${i} `.repeat(40) }))
function bigSnapshot({ localIds = true } = {}) {
  const threads = Array.from({ length: 142 }, (_, i) => ({
    id: `t${i}`, title: `방 ${i}`, engineId: 'codex', ...(localIds ? { localConversationId: `local-${i}` } : {}),
    messages: big(i === 7 ? 300 : 12, `t${i}`), inputSources: [{ id: 's', note: 'x'.repeat(i === 7 ? 40000 : 200) }],
  }))
  const cards = Array.from({ length: 16 }, (_, i) => ({ id: `egd-card-${i}`, type: 'browser', geometry: { x: i * 10, y: 5, w: 800, h: 600 }, url: `https://example.com/${i}` }))
  return { version: 1, savedAt: 1, cards, shapes: [], boardProjections: { projections: {} }, chat: { threads, activeThreadId: 't3', threadDrafts: { t3: 'draft' }, hudView: 'conversation' } }
}

test('142 rooms with a 100KB room: a bridge-backed record drops text and keeps rooms and Card layout', () => {
  const snap = bigSnapshot()
  assert.ok(bytes(snap) > 900_000, 'fixture is as large as the real record')
  const out = ChatState.compactDeskChatForRecord(snap, { bridgeBacked: true })
  assert.ok(bytes(out) <= ChatState.DESK_RECORD_MAX_BYTES, String(bytes(out)))
  assert.deepEqual(out.chat.threads.map(t => t.id), snap.chat.threads.map(t => t.id))
  assert.deepEqual(out.chat.threads.map(t => t.localConversationId), snap.chat.threads.map(t => t.localConversationId))
  assert.ok(out.chat.threads.every(t => t.messages.length === 0), 'text stays in the bridge store')
  assert.deepEqual(out.cards, snap.cards)
  assert.equal(out.chat.activeThreadId, 't3')
  assert.deepEqual(out.chat.threadDrafts, { t3: 'draft' })
})

test('rooms the bridge does not hold keep text while it fits; over the cap the largest fields go first, Cards always stay', () => {
  const snap = bigSnapshot({ localIds: false })
  const out = ChatState.compactDeskChatForRecord(snap, { bridgeBacked: true })
  assert.ok(bytes(out) <= ChatState.DESK_RECORD_MAX_BYTES)
  assert.deepEqual(out.cards, snap.cards)
  assert.deepEqual(out.chat.threads.map(t => t.id), snap.chat.threads.map(t => t.id))
  assert.ok(out.chat.threads.some(t => t.messages.length > 0), 'small rooms keep their text')
  assert.equal(out.chat.threads[7].messages.length, 0, 'the largest room is trimmed first')
  const small = { ...snap, chat: { ...snap.chat, threads: snap.chat.threads.slice(0, 3).map(t => ({ ...t, inputSources: [] })) } }
  assert.deepEqual(ChatState.compactDeskChatForRecord(small, { bridgeBacked: false }), small, 'a small record is untouched')
  assert.deepEqual(ChatState.compactDeskChatForRecord(small, { bridgeBacked: false }).chat.threads.map(t => t.messages.length), [12, 12, 12])
})

test('a room saved without text gets it back from the bridge history on restore', () => {
  const current = { id: 't1', title: 'a', localConversationId: 'local-1', messages: [], engineId: 'codex' }
  const history = { clientThreadId: 't1', localConversationId: 'local-1', messages: [{ id: 'm1', role: 'user', text: 'hi', localMessageId: 'L1', localHistory: true }], runs: [], threadSnapshot: { id: 't1' } }
  const next = ChatState.hydrateLocalChatThread(current, history, {})
  assert.equal(next.messages.length, 1)
  assert.equal(next.messages[0].text, 'hi')
})

test('the surface saves the record compacted, only text of loaded rooms is dropped', () => {
  assert.match(js, /deskRecordBridgeBacked = state\.codex\.localHistoryStatus === 'ready'/)
  assert.match(js, /ChatState\.compactDeskChatForRecord\(snapshot, \{ bridgeBacked: deskRecordBridgeBacked \}\)/)
  assert.ok(!js.includes('lastPersistedDeskRecordKey'), 'every save still writes the pref and hands the Desk to the store')
  assert.match(js, /localHistoryBackupKey: state\.codex\.legacyChatBackupKey \|\| null/)
})
