// c31: the scenario module: the git runner uses fixed arguments and a clean environment, the repo state is read from files, the expectation validator and the judgement by facts.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { GIT_SCENARIOS, checkGit, createGit, prepareScenario, readRepo, scenarioPlan, validateGitExpect } from './egdesk-real-engine-gitscene.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const tmp = t => { const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-gitscene-')); t.after(() => fs.rmSync(base, { recursive: true, force: true })); return base }

test('the git runner: fixed arguments, a local identity, no global or system config, no prompts, no hooks, a timeout; nothing is shelled', () => {
  const seen = []
  const git = createGit({ spawn: (file, args, options) => { seen.push({ file, args, options }); return { status: 0, stdout: 'ok', stderr: '' } }, env: { PATH: '/usr/bin', HOME: '/home/real', SECRET_TOKEN: 'x', GIT_ASKPASS: 'y' } })
  assert.deepEqual(git(['status', '--porcelain'], '/work'), { status: 0, stdout: 'ok', stderr: '' })
  const [call] = seen; assert.equal(call.file, 'git'); assert.equal(call.options.shell, false); assert.equal(call.options.cwd, '/work'); assert.equal(call.options.timeout, 10_000)
  assert.deepEqual(call.args.slice(-2), ['status', '--porcelain']); assert.ok(call.args.includes('core.hooksPath=/dev/null') && call.args.includes('commit.gpgsign=false') && call.args.includes('user.email=check@example.invalid'))
  assert.deepEqual(call.options.env, { PATH: '/usr/bin', HOME: '/work', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, 'the person\'s home, tokens and askpass never reach it')
})

test('the scenario is a fixed plan; preparing it stops at the first failing git step; readRepo reads HEAD, a packed ref and MERGE_HEAD from files', t => {
  assert.deepEqual(GIT_SCENARIOS, ['merge-conflict-v1']); assert.throws(() => scenarioPlan('other'), /unknown git scenario/)
  const plan = scenarioPlan('merge-conflict-v1'); assert.equal(plan.filter(op => op[0] === 'git' && op[1] === 'commit').length, 3); assert.ok(plan.some(op => op[0] === 'write' && op[1] === 'app.txt' && op[2].includes('rate: 12')) && plan.some(op => op[0] === 'write' && op[1] === 'app.txt' && op[2].includes('rate: 15')))
  assert.ok(plan.flat().every(x => typeof x === 'string'), 'only strings: nothing computed from outside'); assert.ok(!plan.some(op => op[0] === 'git' && /push|fetch|clone|remote|config|--global/.test(op.join(' '))), 'no network, no config')
  const root = tmp(t), steps = []
  assert.throws(() => prepareScenario(root, 'merge-conflict-v1', { git: args => { steps.push(args[0]); return { status: args[0] === 'add' ? 1 : 0, stdout: '', stderr: '' } } }), { code: 'git_setup_failed' }); assert.deepEqual(steps, ['init', 'add'])
  const repo = tmp(t); fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n'); fs.writeFileSync(path.join(repo, '.git', 'packed-refs'), '# pack-refs\nabc123 refs/heads/main\ndef456 refs/heads/feature\n')
  assert.deepEqual(readRepo(repo), { branch: 'main', sha: 'abc123', mergePending: false }); fs.writeFileSync(path.join(repo, '.git', 'MERGE_HEAD'), 'x\n'); assert.equal(readRepo(repo).mergePending, true)
  fs.mkdirSync(path.join(repo, '.git', 'refs', 'heads'), { recursive: true }); fs.writeFileSync(path.join(repo, '.git', 'refs', 'heads', 'main'), 'fff000\n'); assert.equal(readRepo(repo).sha, 'fff000', 'a loose ref wins over the packed one')
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), '1234abcd\n'); assert.deepEqual([readRepo(repo).branch, readRepo(repo).sha], [null, '1234abcd'], 'detached'); assert.deepEqual(readRepo(path.join(repo, 'none')), { branch: null, sha: null, mergePending: false })
})

test('validateGitExpect and checkGit: the expectation needs the scenario and a plain message turn; every proof reads its own facts and fails alone', () => {
  const conv = { gitScenario: 'merge-conflict-v1' }, ok = { conflictedFiles: ['app.txt'], headUnchanged: true }
  assert.deepEqual(validateGitExpect(ok, conv, { say: 'x' }), []); assert.match(validateGitExpect(ok, {}, { say: 'x' }).join(), /needs conversation\.gitScenario/); assert.match(validateGitExpect(ok, conv, { action: 'delete' }).join(), /plain message turn/)
  assert.match(validateGitExpect({ nope: true }, conv, { say: 'x' }).join(), /unknown key/); assert.match(validateGitExpect({ headUnchanged: false }, conv, { say: 'x' }).join(), /true/); assert.match(validateGitExpect({ conflictedFiles: ['/etc/x'] }, conv, { say: 'x' }).join(), /relative paths/); assert.match(validateGitExpect({}, conv, { say: 'x' }).join(), /at least one/)
  const good = () => ({ commands: [{ command: 'git merge feature', exitCode: 1, vcs: true, worktree: { state: 'conflict', conflicts: 1, files: ['app.txt'] } }], setup: { branch: 'main', sha: 'aaa' }, repo: { branch: 'main', sha: 'aaa', mergePending: true },
    files: { 'app.txt': '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> feature\n' }, answer: '`app.txt`에서 충돌이 발생해 머지를 완료하지 못했습니다.', outside: { engineFolder: [], neighboursBefore: ['x'], neighboursAfter: ['x'] } })
  const ALL = { conflictedFiles: ['app.txt'], headUnchanged: true, markersRemain: true, mergePending: true, answerNamesFiles: true, answerNoMergeClaim: true, nothingOutside: true }
  const failing = mutate => { const r = good(); mutate(r); return checkGit(ALL, r).filter(c => !c.ok).map(c => c.check.replace('git.', '')) }
  assert.deepEqual(failing(() => {}), [])
  assert.deepEqual(failing(r => { r.commands[0].worktree.files = ['other.txt'] }), ['conflictedFiles']); assert.deepEqual(failing(r => { r.commands[0].worktree.state = 'clean' }), ['conflictedFiles']); assert.deepEqual(failing(r => { r.commands = [] }), ['conflictedFiles'])
  assert.deepEqual(failing(r => { r.repo.sha = 'bbb' }), ['headUnchanged']); assert.deepEqual(failing(r => { r.repo.branch = 'feature' }), ['headUnchanged'])
  assert.deepEqual(failing(r => { r.files['app.txt'] = 'rate: 15\n' }), ['markersRemain']); assert.deepEqual(failing(r => { r.repo.mergePending = false }), ['mergePending'])
  assert.deepEqual(failing(r => { r.answer = '충돌이 있었습니다.' }), ['answerNamesFiles']); assert.deepEqual(failing(r => { r.answer = '`app.txt` 머지를 완료했습니다.' }), ['answerNoMergeClaim']); assert.deepEqual(failing(r => { r.answer = null }), ['answerNamesFiles', 'answerNoMergeClaim'])
  assert.deepEqual(failing(r => { r.outside.engineFolder = ['x'] }), ['nothingOutside']); assert.deepEqual(failing(r => { r.outside.neighboursAfter = ['x', 'new'] }), ['nothingOutside'])
  assert.deepEqual(failing(r => { r.commands.push({ command: 'ls', exitCode: 0, vcs: false, worktree: null }) }), [], 'the last git command is the one read')
})
