import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openEGDeskManagedDraftStore } from './egdesk-managed-drafts.mjs'

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-drafts-test-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

test('SQLite draft head persists across reopen and conditional update is atomic', async t => {
  const directory = await fixture(t)
  const first = await openEGDeskManagedDraftStore({ directory, ownerScope: 'person-a' })
  const rival = await openEGDeskManagedDraftStore({ directory, ownerScope: 'person-a' })
  const record = { id: 'draft-1', head: 'head-0', text: 'original', bufferRevision: 0 }
  await first.create(record)
  const changed = { ...record, head: 'head-1', text: 'changed', bufferRevision: 1 }
  const attempts = await Promise.allSettled([
    first.compareAndSwap('draft-1', 'head-0', changed),
    rival.compareAndSwap('draft-1', 'head-0', { ...changed, head: 'rival-head', text: 'rival' }),
  ])
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(attempts.filter(result => result.status === 'rejected' && result.reason.code === 'DRAFT_CONFLICT').length, 1)
  const winner = await first.get('draft-1')
  assert.equal(winner.bufferRevision, 1)
  first.close(); rival.close()
  const reopened = await openEGDeskManagedDraftStore({ directory, ownerScope: 'person-a' })
  assert.deepEqual(await reopened.get('draft-1'), winner)
  assert.equal(await reopened.get('missing'), null)
  reopened.close()
})

test('owner scopes use distinct databases without raw scope names in filenames', async t => {
  const directory = await fixture(t)
  const one = await openEGDeskManagedDraftStore({ directory, ownerScope: 'person-a' })
  const two = await openEGDeskManagedDraftStore({ directory, ownerScope: 'person-b' })
  await one.create({ id: 'same-id', head: 'one', text: 'A' })
  assert.equal(await two.get('same-id'), null)
  await two.create({ id: 'same-id', head: 'two', text: 'B' })
  assert.equal((await one.get('same-id')).text, 'A')
  assert.equal((await two.get('same-id')).text, 'B')
  const names = await fs.readdir(directory)
  assert.equal(names.some(name => name.includes('person-')), false)
  one.close(); two.close()
})

test('duplicate create and stale head never replace the saved record', async t => {
  const directory = await fixture(t)
  const store = await openEGDeskManagedDraftStore({ directory, ownerScope: 'one' })
  await store.create({ id: 'draft', head: 'h1', text: 'keep' })
  await assert.rejects(store.create({ id: 'draft', head: 'h2', text: 'overwrite' }), { code: 'DRAFT_EXISTS' })
  await assert.rejects(store.compareAndSwap('draft', 'stale', { id: 'draft', head: 'h2', text: 'overwrite' }), { code: 'DRAFT_CONFLICT' })
  assert.equal((await store.get('draft')).text, 'keep')
  store.close()
})
