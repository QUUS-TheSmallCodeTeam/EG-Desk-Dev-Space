// L1 c25 (owner decision U11): captures of a room on an Agent profile are stored under THAT account. Behind EGDESK_ROOM_ACCOUNT the .egdesk export lists the
// captures of the default sign-in AND of the signed-in Agent profile accounts (each read with its own key); a profile room's captures are exported while the
// default is signed out; flag off, only the default sign-in's, as before. The ImmutableContextStore is real. Mocks only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { ImmutableContextStore } from './egdesk-context-store.mjs'
import { createContextAttachmentProvider } from './egdesk-portable-providers.mjs'

const T0 = Date.UTC(2026, 10, 17, 12, 0, 0)
async function seed(context, owner, label, raw, clientThreadId) {
  const hash = await context.blob(owner, Buffer.from(raw)), sourceId = randomUUID()
  await context.putRecord(owner, 'sources', { version: 1, sourceId, clientThreadId, hash, storedAt: T0 + label.length, label,
    shape: { readable: true, format: 'text', mime: 'text/plain' }, payloads: { source: { hash, byteLength: raw.length }, projection: { hash, byteLength: raw.length } } }, sourceId)
}
async function world(t) {
  const dir = createPrivateQaTempDirectory('egdesk-portable-room-')
  const context = new ImmutableContextStore({ dataDir: dir, allowedRoots: [dir] })
  t.after(() => { assert.equal(realpathSync.native(dir), dir); rmSync(dir, { recursive: true, force: true }) })
  const w = { defaultOwner: 'email:a@example.test', profiles: ['email:work@example.test'] }
  await seed(context, 'email:a@example.test', 'default room capture', 'default text', 'thread-d')
  await seed(context, 'email:work@example.test', 'work room capture', 'work text', 'thread-w')
  return { context, w }
}
const names = async provider => (await provider.exportList({})).map(item => item.name).sort()

test('the export lists a profile room\'s captures too (flag on), each read under its own account, also while the default is signed out; thread filter applies to all', async t => {
  const { context, w } = await world(t)
  const provider = createContextAttachmentProvider({ store: context, ownerKey: () => w.defaultOwner, ownerKeys: () => [w.defaultOwner, ...w.profiles] })
  assert.deepEqual(await names(provider), ['default room capture.txt', 'work room capture.txt'])
  const list = await provider.exportList({})
  assert.deepEqual((await Promise.all(list.map(async item => (await item.read()).toString()))).sort(), ['default text', 'work text'])
  const work = list.find(item => item.name.startsWith('work'))
  assert.equal((await work.read()).toString(), 'work text', 'read with the profile account\'s key')
  assert.deepEqual((await provider.exportList({ threadIds: ['thread-w'] })).map(item => item.name), ['work room capture.txt'])
  w.defaultOwner = null
  assert.deepEqual(await names(provider), ['work room capture.txt'], 'default signed out: the profile room\'s captures still export')
  w.defaultOwner = 'email:someone-else@example.test'
  assert.deepEqual(await names(provider), ['work room capture.txt'], 'default is someone else: only the profile room\'s')
  w.profiles = []; w.defaultOwner = null
  await assert.rejects(provider.exportList({}), { code: 'PORTABLE_ATTACHMENT_STORE_UNAVAILABLE' }, 'nobody signed in: unavailable as before')
})

test('another account on the profile: the old account\'s captures are not exported under the new one; a duplicated key is listed once', async t => {
  const { context, w } = await world(t)
  const provider = createContextAttachmentProvider({ store: context, ownerKey: () => w.defaultOwner, ownerKeys: () => [w.defaultOwner, ...w.profiles, w.defaultOwner] })
  w.profiles = ['email:z@example.test']
  assert.deepEqual(await names(provider), ['default room capture.txt'])
  w.profiles = ['email:a@example.test']
  assert.deepEqual(await names(provider), ['default room capture.txt'], 'the same account on both slots: once')
})

test('without ownerKeys (flag off), exactly the default sign-in\'s captures, as before; the bridge adds ownerKeys only behind the flag', async t => {
  const { context, w } = await world(t)
  const provider = createContextAttachmentProvider({ store: context, ownerKey: () => w.defaultOwner })
  assert.deepEqual(await names(provider), ['default room capture.txt'])
  w.defaultOwner = null
  await assert.rejects(provider.exportList({}), { code: 'PORTABLE_ATTACHMENT_STORE_UNAVAILABLE' })
  const server = readFileSync(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.match(server, /\.\.\.\(process\.env\.EGDESK_ROOM_ACCOUNT === 'on' \? \{ ownerKeys: \(\) => \[publicAuthIdentityKey\(authState\), \.\.\.codexProfileServers\.residentIds\(\)\.map\(id => codexEngine\.ownerKey\(id\)\)\] \} : \{\}\)/)
})
