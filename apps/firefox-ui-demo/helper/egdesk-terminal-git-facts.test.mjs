// Read-only git facts for the command gate. `git` is a fake here (no process is started); only the argument lists and the parsing are under test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createGitTargetInspector } from './egdesk-terminal-git-facts.mjs'
import { classifyCommand } from './egdesk-terminal-command-gate.mjs'

function fakeGit({ repo = true, tracked = {}, ignored = [], dirty = false, fail = null } = {}) {
  const calls = []
  const execFile = (file, args, options, done) => {
    calls.push({ file, args, options })
    const [, , sub, ...rest] = args
    const target = rest.at(-1)
    if (fail === sub) return done(Object.assign(new Error('git failed'), { code: 128 }))
    if (sub === 'rev-parse') return repo ? done(null, 'true\n') : done(Object.assign(new Error('not a repo'), { code: 128 }))
    if (sub === 'ls-files') return done(null, (tracked[target] ?? []).map(name => `${name}\0`).join(''))
    if (sub === 'check-ignore') return ignored.includes(target) ? done(null, '') : done(Object.assign(new Error('not ignored'), { code: 1 }))
    if (sub === 'status') return done(null, dirty ? ' M src/a.mjs\0' : '')
    done(new Error('unexpected'))
  }
  const lstat = async target => { if (target.endsWith('/missing')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { isDirectory: () => !target.endsWith('.txt'), isFile: () => target.endsWith('.txt') } }
  return { calls, inspect: createGitTargetInspector({ execFile, lstat, env: { PATH: '/usr/bin', HOME: '/tmp/home', SECRET_TOKEN: 'zeta-synthetic-secret' } }) }
}

test('facts per target: tracked count, ignored, existence; only read-only git subcommands, no shell, no inherited secrets', async () => {
  const g = fakeGit({ tracked: { '/work/app/src': ['src/a.mjs', 'src/b.mjs'] }, ignored: ['/work/app/node_modules'], dirty: true })
  const facts = await g.inspect({ cwd: '/work/app', paths: ['/work/app/src', '/work/app/node_modules', '/work/app/missing', '/etc/passwd'] })
  assert.deepEqual(facts.targets['/work/app/src'], { exists: true, kind: 'dir', trackedFiles: 2, ignored: false })
  assert.deepEqual(facts.targets['/work/app/node_modules'], { exists: true, kind: 'dir', trackedFiles: 0, ignored: true })
  assert.deepEqual(facts.targets['/work/app/missing'], { exists: false, kind: null, trackedFiles: 0, ignored: false })
  assert.equal(Object.hasOwn(facts.targets, '/etc/passwd'), false, 'a target outside the working directory is not looked at')
  assert.deepEqual(facts.git, { dirty: true })
  assert.deepEqual([...new Set(g.calls.map(c => c.args[2]))].sort(), ['check-ignore', 'ls-files', 'rev-parse', 'status'])
  for (const call of g.calls) {
    assert.equal(call.file, 'git'); assert.deepEqual(call.args.slice(0, 2), ['-C', '/work/app'])
    assert.equal(call.options.shell, undefined); assert.ok(call.options.timeout > 0)
    assert.deepEqual(Object.keys(call.options.env).sort(), ['GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'HOME', 'LC_ALL', 'PATH'])
    assert.equal(call.options.env.GIT_OPTIONAL_LOCKS, '0')
  }
})

test('unknown stays unknown: not a repository or a failing git is never read as "untracked and clean"', async () => {
  const none = await fakeGit({ repo: false }).inspect({ cwd: '/work/app', paths: ['/work/app/src'] })
  assert.deepEqual(none, { targets: { '/work/app/src': { exists: true, kind: 'dir', trackedFiles: 0, ignored: false, unknown: true } }, git: null })
  const broken = await fakeGit({ fail: 'ls-files' }).inspect({ cwd: '/work/app', paths: ['/work/app/src'] })
  assert.equal(broken.targets['/work/app/src'].unknown, true)
  assert.deepEqual(await fakeGit().inspect({ cwd: 'relative', paths: ['x'] }), { targets: {}, git: null })
})

test('the facts drive the gate rules: tracked files and a dirty worktree require approval; an unknown working directory is never a pass', async () => {
  const g = fakeGit({ tracked: { '/work/app/src': ['src/a.mjs'] }, ignored: ['/work/app/node_modules'], dirty: true })
  const first = classifyCommand('rm -rf src node_modules', { cwd: '/work/app' })
  assert.deepEqual(first.paths, ['/work/app/src', '/work/app/node_modules'])
  const facts = await g.inspect({ cwd: '/work/app', paths: first.paths })
  assert.deepEqual(classifyCommand('rm -rf src node_modules', { cwd: '/work/app', inspect: p => facts.targets[p], git: facts.git }).floor, ['tracked_files'])
  assert.deepEqual(classifyCommand('rm -rf node_modules', { cwd: '/work/app', inspect: p => facts.targets[p], git: facts.git }).floor, [])
  assert.deepEqual(classifyCommand('git reset --hard', { cwd: '/work/app', git: facts.git }).floor, ['dirty_worktree'])
  assert.deepEqual(classifyCommand('git reset --hard', { cwd: '/work/app', git: null }).floor, [], 'unknown worktree state is left to the score, and told as unknown')
  assert.deepEqual(classifyCommand('rm -rf build', { cwd: null }).floor, ['unresolved_target'])
  assert.deepEqual(classifyCommand('rm -rf /work/app/build', { cwd: undefined }).floor, ['outside_cwd'])
})
