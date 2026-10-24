// 회차별 git checkpoint (CODE-05; bundle 2-X). 대표님 결정 D-X4: off by default.
//
// When the user turns it on for a project, the start and end of an Agent turn
// are recorded as commits under refs/egdesk/checkpoints/<id> in the project's
// own repository. The user's index, HEAD, branches and working files are not
// touched: staging happens in a scratch index file. The diff between two
// checkpoints also shows files changed by shell commands, which the engines'
// own file-change items miss.
//
// Adapted from pingdotgg/t3code (MIT License, Copyright (c) 2026 T3 Tools Inc.)
// apps/server/src/vcs/GitVcsDriver.ts:809-1170 captureCheckpoint: a scratch
// GIT_INDEX_FILE in the common git dir seeded from HEAD (read-tree), `add -A`
// into it, write-tree, commit-tree with HEAD as parent, update-ref; durable
// object/ref fsync config (core.fsync, fsyncMethod batch on macOS/Windows) and
// the split-index/fsmonitor guards for the scratch index. Not ported: the
// index-reuse fast path, sparse-checkout handling, the embedded-repository
// retry, and restoreCheckpoint (git restore + git clean deletes files; review
// reverts go through the File view's conditional write instead).
//
// Every command runs through execFile with an argument array, no shell, with
// the hardened config and environment of egdesk-git-review.mjs. stderr and
// absolute paths never leave this module.
import { randomUUID } from 'node:crypto'
import { execFile as nodeExecFile } from 'node:child_process'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { egdeskGitEnv, GitReviewError, parseNumstat } from './egdesk-git-review.mjs'

export const EGDESK_CHECKPOINT_REF_PREFIX = 'refs/egdesk/checkpoints/'
export const EGDESK_CHECKPOINT_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  metadataMaxBytes: 1024 * 1024,
  patchMaxBytes: 1024 * 1024,
})
const CHECKPOINT_REF = /^refs\/egdesk\/checkpoints\/[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const HARDENED_ARGS = Object.freeze(['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'safe.bareRepository=explicit', '-c', 'core.quotePath=false'])
const SCRATCH_INDEX_ARGS = Object.freeze(['-c', 'core.splitIndex=false', '-c', 'splitIndex.sharedIndexExpire=never', '-c', 'sparse.expectFilesOutsideOfPatterns=false'])
const fail = (code, message) => { throw new GitReviewError(code, message) }
const decode = bytes => new TextDecoder('utf-8').decode(bytes || new Uint8Array())

async function findGit(env, platform) {
  const names = platform === 'win32' ? ['git.exe'] : ['git']
  for (const directory of String(env.PATH || env.Path || '').split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue
    for (const name of names) {
      const candidate = path.join(directory, name)
      try { await fs.access(candidate, constants.X_OK); if ((await fs.stat(candidate)).isFile()) return candidate } catch {}
    }
  }
  return null
}

/**
 * createEGDeskGitCheckpoint({ enabled = false, execFile?, gitExecutable?, env?, platform?, limits? })
 *   capture(rootPath, {label?}) → {enabled:false} | {enabled:true, isRepo:false} | {enabled:true, isRepo:true, ref, commit}
 *   diff(rootPath, {fromRef, toRef}) → {enabled:false} | {enabled:true, patch, files:[{relativePath, previousPath, additions, deletions, binary}], truncated}
 *   remove(rootPath, ref) → {enabled, removed}
 * rootPath is the verified real project folder (it may be a subfolder of the
 * repository; the diff is relative to it).
 */
export function createEGDeskGitCheckpoint({ enabled = false, execFile = nodeExecFile, gitExecutable = null, env = process.env, platform = process.platform, limits = {}, makeId = randomUUID } = {}) {
  const bounds = { ...EGDESK_CHECKPOINT_LIMITS, ...limits }
  const baseEnv = egdeskGitEnv(env)
  const durable = ['-c', 'core.fsync=objects,reference', '-c', 'core.fsyncMethod=fsync', ...(platform === 'darwin' || platform === 'win32' ? ['-c', 'core.fsyncMethod=batch'] : [])]
  let executable = null
  // As in egdesk-git-review.mjs: on macOS /usr/bin/git is a shim that opens
  // the Command Line Tools installer when they are missing; never pop it.
  const resolveGit = async () => gitExecutable || (executable ||= (async () => {
    const found = await findGit(env, platform)
    if (!found || platform !== 'darwin' || found !== '/usr/bin/git') return found
    const developer = await new Promise(resolve => {
      execFile('/usr/bin/xcode-select', ['-p'], { timeout: 2000, windowsHide: true, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : String(stdout).trim()))
    })
    if (!developer || !path.isAbsolute(developer)) return null
    try { await fs.access(path.join(developer, 'usr', 'bin', 'git'), constants.X_OK); return found }
    catch { return null }
  })())

  async function run(cwd, args, { extraEnv = {}, maxBytes = bounds.metadataMaxBytes } = {}) {
    const file = await resolveGit()
    if (!file) fail('GIT_UNAVAILABLE', 'git is not available')
    return new Promise((resolve, reject) => {
      execFile(file, [...HARDENED_ARGS, ...args], { cwd, env: { ...baseEnv, ...extraEnv }, timeout: bounds.timeoutMs, maxBuffer: maxBytes, encoding: 'buffer', windowsHide: true, killSignal: 'SIGKILL' }, (error, stdout) => {
        const output = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '')
        if (!error) return resolve({ code: 0, stdout: output, truncated: false })
        if (error.code === 'ENOENT' || error.code === 'EACCES') return reject(new GitReviewError('GIT_UNAVAILABLE', 'git is not available'))
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ code: null, stdout: output, truncated: true })
        if (error.killed || error.signal) return reject(new GitReviewError('GIT_TIMEOUT', 'git did not answer in time'))
        if (Number.isInteger(error.code)) return resolve({ code: error.code, stdout: output, truncated: false })
        reject(new GitReviewError('GIT_FAILED', 'git could not be started'))
      })
    })
  }
  const must = async (cwd, args, options) => {
    const result = await run(cwd, args, options)
    if (result.code !== 0) fail('GIT_FAILED', 'git checkpoint step failed')
    return decode(result.stdout).trim()
  }
  const checkedRoot = rootPath => { if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) fail('INVALID_PATH', 'An absolute verified root is required'); return rootPath }
  const checkedRef = ref => { if (typeof ref !== 'string' || !CHECKPOINT_REF.test(ref)) fail('INVALID_REF', 'Only EG-Desk checkpoint refs are accepted'); return ref }

  async function isRepository(rootPath) {
    const result = await run(rootPath, ['rev-parse', '--show-prefix'], { maxBytes: 64 * 1024 })
    return result.code === 0
  }

  async function capture(rootPath, { label = '' } = {}) {
    if (!enabled) return { enabled: false }
    const cwd = checkedRoot(rootPath)
    if (!await isRepository(cwd)) return { enabled: true, isRepo: false }
    let commonDir = await must(cwd, ['rev-parse', '--git-common-dir'])
    if (!path.isAbsolute(commonDir)) commonDir = path.resolve(await fs.realpath(cwd), commonDir)
    const id = String(makeId()).replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) || `${Date.now()}`
    const ref = `${EGDESK_CHECKPOINT_REF_PREFIX}${id}`
    checkedRef(ref)
    const scratch = path.join(commonDir, `egdesk-checkpoint-index-${id}`)
    const indexEnv = {
      GIT_INDEX_FILE: scratch,
      GIT_AUTHOR_NAME: 'EG-Desk', GIT_AUTHOR_EMAIL: 'checkpoint@egdesk.invalid',
      GIT_COMMITTER_NAME: 'EG-Desk', GIT_COMMITTER_EMAIL: 'checkpoint@egdesk.invalid',
    }
    try {
      const head = await run(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { maxBytes: 64 * 1024 })
      const headExists = head.code === 0
      if (headExists) await must(cwd, [...SCRATCH_INDEX_ARGS, 'read-tree', 'HEAD'], { extraEnv: indexEnv })
      await must(cwd, [...SCRATCH_INDEX_ARGS, ...durable, 'add', '-A', '--', '.'], { extraEnv: indexEnv })
      const tree = await must(cwd, [...SCRATCH_INDEX_ARGS, ...durable, 'write-tree'], { extraEnv: indexEnv })
      if (!/^[0-9a-f]{40,64}$/.test(tree)) fail('GIT_FAILED', 'git write-tree returned no tree')
      const message = `egdesk checkpoint${label ? ` ${String(label).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80)}` : ''}`
      const commit = await must(cwd, [...durable, 'commit-tree', tree, ...(headExists ? ['-p', 'HEAD'] : []), '-m', message], { extraEnv: indexEnv })
      if (!/^[0-9a-f]{40,64}$/.test(commit)) fail('GIT_FAILED', 'git commit-tree returned no commit')
      await must(cwd, [...durable, 'update-ref', ref, commit])
      return { enabled: true, isRepo: true, ref, commit }
    } finally {
      await fs.rm(scratch, { force: true }).catch(() => {})
      await fs.rm(`${scratch}.lock`, { force: true }).catch(() => {})
    }
  }

  async function diff(rootPath, { fromRef, toRef } = {}) {
    if (!enabled) return { enabled: false }
    const cwd = checkedRoot(rootPath)
    checkedRef(fromRef); checkedRef(toRef)
    const range = [`${fromRef}^{commit}`, `${toRef}^{commit}`]
    const patch = await run(cwd, ['diff', '-M', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--relative', ...range, '--', '.'], { maxBytes: bounds.patchMaxBytes })
    if (patch.code !== 0 && !patch.truncated) fail('GIT_FAILED', 'git diff failed')
    let text = decode(patch.stdout)
    if (patch.truncated) text = text.slice(0, text.lastIndexOf('\n') + 1)
    const counted = await run(cwd, ['diff', '-M', '--numstat', '-z', '--relative', ...range, '--', '.'])
    const files = counted.code === 0 ? [...parseNumstat(decode(counted.stdout))].map(([relativePath, count]) => ({ relativePath, previousPath: count.previousPath, additions: count.additions, deletions: count.deletions, binary: count.binary })) : []
    return { enabled: true, patch: text, files, truncated: patch.truncated }
  }

  async function remove(rootPath, ref) {
    if (!enabled) return { enabled: false, removed: false }
    const cwd = checkedRoot(rootPath)
    checkedRef(ref)
    const result = await run(cwd, ['update-ref', '-d', ref])
    return { enabled: true, removed: result.code === 0 }
  }

  return { enabled: enabled === true, capture, diff, remove }
}
