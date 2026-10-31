import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeFolderIdentity, sameFolderIdentity, sameProjectFolder, projectReconnectState, PROJECT_RECONNECT_STATES } from './egdesk-project-identity.mjs'
import { projectReconnectState as storeReconnectState } from './egdesk-project-store.mjs'

const stat = ({ dev, ino, directory = true, symlink = false }) => ({ dev, ino, isDirectory: () => directory, isSymbolicLink: () => symlink })
const project = { id: 'p', workspaceRoot: '/work/shop', identity: { dev: '16777220', ino: '4201' } }

test('folder identity: numbers, bigints and digit strings normalize to the same strings; anything else is not an identity', () => {
  assert.deepEqual(normalizeFolderIdentity({ dev: 16777220, ino: 4201 }), { dev: '16777220', ino: '4201' })
  assert.deepEqual(normalizeFolderIdentity({ dev: 16777220n, ino: 4201n }), { dev: '16777220', ino: '4201' })
  assert.deepEqual(normalizeFolderIdentity({ dev: '16777220', ino: '4201', extra: true }), { dev: '16777220', ino: '4201' })
  for (const bad of [null, undefined, 'x', 42, {}, { dev: 1 }, { ino: 1 }, { dev: -1, ino: 2 }, { dev: '1.5', ino: '2' }, { dev: 'a', ino: 'b' }, { dev: NaN, ino: 1 }, { dev: '', ino: '' }]) {
    assert.equal(normalizeFolderIdentity(bad), null, JSON.stringify(bad))
  }
  assert.equal(sameFolderIdentity({ dev: 1n, ino: 2n }, { dev: '1', ino: '2' }), true)
  assert.equal(sameFolderIdentity({ dev: 1, ino: 2 }, { dev: 1, ino: 3 }), false)
  assert.equal(sameFolderIdentity({ dev: 1, ino: 2 }, { dev: 2, ino: 2 }), false)
  assert.equal(sameFolderIdentity(null, { dev: 1, ino: 2 }), false)
  assert.equal(sameFolderIdentity({ dev: 'a', ino: 'b' }, { dev: 'a', ino: 'b' }), false, 'two invalid identities never match each other')
})

test('same project folder requires the same real path and the same dev/ino', () => {
  const described = { rootId: 'r', absolutePath: '/work/shop', name: 'shop', identity: { dev: '16777220', ino: '4201' } }
  assert.equal(sameProjectFolder(described, project), true)
  assert.equal(sameProjectFolder({ ...described, identity: { dev: 16777220n, ino: 4201n } }, project), true, 'bigint identity from a fresh lstat')
  assert.equal(sameProjectFolder({ ...described, identity: { dev: '16777220', ino: '9999' } }, project), false, 'a folder replaced at the same path')
  assert.equal(sameProjectFolder({ ...described, absolutePath: '/work/shop-old' }, project), false, 'the same inode renamed elsewhere')
  assert.equal(sameProjectFolder({ ...described, absolutePath: '' }, { ...project, workspaceRoot: '' }), false)
  assert.equal(sameProjectFolder(null, project), false)
  assert.equal(sameProjectFolder(described, null), false)
  assert.equal(sameProjectFolder(described, { ...project, identity: undefined }), false)
})

test('reconnect state: only the folder with the stored dev/ino at the stored path reconnects (D-X3)', () => {
  assert.deepEqual(PROJECT_RECONNECT_STATES, ['connected', 'missing', 'not-a-directory', 'identity-changed'])
  assert.equal(projectReconnectState(project, null), 'missing')
  assert.equal(projectReconnectState(project, undefined), 'missing')
  assert.equal(projectReconnectState(project, stat({ dev: 16777220n, ino: 4201n, directory: false })), 'not-a-directory')
  assert.equal(projectReconnectState(project, stat({ dev: 16777220n, ino: 4201n, symlink: true })), 'not-a-directory', 'a symlink at the path is never followed')
  assert.equal(projectReconnectState(project, stat({ dev: 16777220n, ino: 7777n })), 'identity-changed')
  assert.equal(projectReconnectState(project, stat({ dev: 1n, ino: 4201n })), 'identity-changed')
  assert.equal(projectReconnectState(project, stat({ dev: 16777220n, ino: 4201n })), 'connected')
  assert.equal(projectReconnectState(project, stat({ dev: 16777220, ino: 4201 })), 'connected', 'number stat')
  assert.equal(projectReconnectState({ ...project, identity: null }, stat({ dev: 16777220n, ino: 4201n })), 'identity-changed', 'a project without identity never reconnects')
  assert.equal(projectReconnectState(project, { dev: 16777220n, ino: 4201n }), 'not-a-directory', 'a stat without type methods is not trusted as a directory')
  assert.equal(storeReconnectState, projectReconnectState, 'the project store re-exports the same decision')
})
