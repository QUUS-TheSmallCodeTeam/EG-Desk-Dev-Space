import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  contentMatchRanges, contentSnippet, createEGDeskGitReview, egdeskGitEnv, newFilePatch,
  parseGitGrep, parseNumstat, parsePorcelainV2Status, unifiedPatchToHunks,
} from './egdesk-git-review.mjs'

// Each repository gets its own HOME and empty global config so the user's git
// settings never change results. Only temp folders are touched.
async function sandbox(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-git-review-')))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const home = path.join(base, 'home')
  await fs.mkdir(home)
  const globalConfig = path.join(home, 'gitconfig')
  await fs.writeFile(globalConfig, '')
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }
  delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE
  return { base, env }
}
async function repository(t, options = {}) {
  const { base, env } = await sandbox(t)
  const root = path.join(base, 'repo')
  await fs.mkdir(root)
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'review@example.invalid')
  git('config', 'user.name', 'Review Test')
  git('config', 'commit.gpgsign', 'false')
  return { base, root, env, git, review: createEGDeskGitReview({ env, ...options }) }
}
const write = (root, relative, text) => fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }).then(() => fs.writeFile(path.join(root, relative), text))

test('porcelain v2 parsing keeps spaces, rename pairs, untracked folders and the root prefix', () => {
  const text = [
    '# branch.oid 0123', '# branch.head main',
    '1 .M N... 100644 100644 100644 aaaa aaaa app/my file.txt',
    '2 R. N... 100644 100644 100644 bbbb bbbb R100 app/new name.txt', 'app/old name.txt',
    '1 D. N... 100644 000000 000000 cccc 0000 app/gone.txt',
    '1 A. N... 000000 100644 100644 0000 dddd app/added.txt',
    'u UU N... 100644 100644 100644 100644 e1 e2 e3 app/conflict.txt',
    '? app/new folder/',
    '? outside.txt',
    '',
  ].join('\0')
  const parsed = parsePorcelainV2Status(text, 'app/')
  assert.equal(parsed.branch, 'main')
  assert.equal(parsed.truncated, false)
  assert.deepEqual(parsed.entries.map(entry => [entry.relativePath, entry.state, entry.previousPath, entry.directory]), [
    ['my file.txt', 'modified', null, false],
    ['new name.txt', 'renamed', 'old name.txt', false],
    ['gone.txt', 'deleted', null, false],
    ['added.txt', 'added', null, false],
    ['conflict.txt', 'conflicted', null, false],
    ['new folder', 'untracked', null, true],
  ])
  assert.deepEqual(parsed.entries.slice(0, 2).map(entry => [entry.staged, entry.unstaged]), [[false, true], [true, false]])
  assert.equal(parsePorcelainV2Status('# branch.head (detached)\0', '').branch, null)
  const capped = parsePorcelainV2Status(text, '', { maxEntries: 2 })
  assert.equal(capped.entries.length, 2)
  assert.equal(capped.truncated, true)
  // A cut-off stream drops its last (possibly partial) record.
  assert.deepEqual(parsePorcelainV2Status('1 .M N... 100644 100644 100644 a a one.txt\x001 .M N... 100644 100644 100644 a a tw', '', { partial: true }).entries.map(entry => entry.relativePath), ['one.txt'])
})

test('numstat parsing reads rename pairs and binary markers', () => {
  const files = parseNumstat('3\t1\tsrc/a.js\x000\t0\t\x00old.txt\x00new.txt\x00-\t-\timage.png\x00')
  assert.deepEqual(files.get('src/a.js'), { additions: 3, deletions: 1, binary: false, previousPath: null })
  assert.deepEqual(files.get('new.txt'), { additions: 0, deletions: 0, binary: false, previousPath: 'old.txt' })
  assert.deepEqual(files.get('image.png'), { additions: null, deletions: null, binary: true, previousPath: null })
})

test('unified patches become lineDiff-shaped blocks, including header-looking content lines', () => {
  const patch = [
    'diff --git a/x.txt b/x.txt', 'index 1..2 100644', '--- a/x.txt', '+++ b/x.txt',
    '@@ -1,6 +1,7 @@', ' keep', '-old two', '+new two', ' keep', ' keep', '+inserted', ' keep', '--- dash line',
    '@@ -20,0 +22,2 @@', '+tail one', '+tail two',
    '\\ No newline at end of file', '',
  ].join('\n')
  assert.deepEqual(unifiedPatchToHunks(patch), [
    { baseStartLine: 2, baseLines: ['old two'], currentStartLine: 2, currentLines: ['new two'] },
    { baseStartLine: 5, baseLines: [], currentStartLine: 5, currentLines: ['inserted'] },
    { baseStartLine: 6, baseLines: ['-- dash line'], currentStartLine: 7, currentLines: [] },
    { baseStartLine: 21, baseLines: [], currentStartLine: 22, currentLines: ['tail one', 'tail two'] },
  ])
  assert.deepEqual(unifiedPatchToHunks('diff --git a/a b/a\nsimilarity index 100%\nrename from a\nrename to b\n'), [])
})

test('new-file patches, content ranges, long-line snippets and git grep records', () => {
  const created = newFilePatch('dir/new.txt', 'one\ntwo\n')
  assert.match(created.patch, /^diff --git a\/dir\/new.txt b\/dir\/new.txt\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/dir\/new.txt\n@@ -0,0 \+1,2 @@\n\+one\n\+two\n$/)
  assert.deepEqual(created.hunks, [{ baseStartLine: 1, baseLines: [], currentStartLine: 1, currentLines: ['one', 'two'] }])
  assert.deepEqual(unifiedPatchToHunks(created.patch), created.hunks)
  assert.match(newFilePatch('a.txt', 'no newline').patch, /\\ No newline at end of file\n$/)
  assert.deepEqual(newFilePatch('empty.txt', '').hunks, [])
  assert.throws(() => newFilePatch('../escape.txt', 'x'), { code: 'INVALID_PATH' })

  assert.deepEqual(contentMatchRanges('Needle and needle (x+1)', 'NEEDLE'), [{ start: 0, end: 6 }, { start: 11, end: 17 }])
  assert.deepEqual(contentMatchRanges('Needle and needle', 'needle', true), [{ start: 11, end: 17 }])
  assert.deepEqual(contentMatchRanges('a (x+1) b', '(x+1)'), [{ start: 2, end: 7 }])
  assert.deepEqual(contentMatchRanges('검색 결과 검색', '검색'), [{ start: 0, end: 2 }, { start: 6, end: 8 }])
  const long = `${'a'.repeat(1000)}NEEDLE${'b'.repeat(1000)}`
  const snippet = contentSnippet(long, contentMatchRanges(long, 'needle'))
  assert.equal(snippet.lineContent.length, 400)
  assert.equal(snippet.lineTruncated, true)
  assert.equal(snippet.column, 1000)
  assert.equal(snippet.lineContent.slice(snippet.matchRanges[0].start, snippet.matchRanges[0].end), 'NEEDLE')

  assert.deepEqual(parseGitGrep('a b.txt\x003\x00hello\r\nsub/c.txt\x0010\x00x\x00y\n'), [
    { relativePath: 'a b.txt', lineNumber: 3, lineContent: 'hello' },
    { relativePath: 'sub/c.txt', lineNumber: 10, lineContent: 'x\0y' },
  ])
  assert.equal(parseGitGrep('a.txt\x001\x00one\na.txt\x002\x00tw', { partial: true }).length, 1)
})

test('child env drops inherited repository pointers and never takes optional locks', async () => {
  const env = egdeskGitEnv({ PATH: '/usr/bin', GIT_DIR: '/elsewhere/.git', GIT_WORK_TREE: '/elsewhere', GIT_INDEX_FILE: '/x', GIT_EXTERNAL_DIFF: 'evil', HOME: '/h' })
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0')
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_EXTERNAL_DIFF']) assert.equal(Object.hasOwn(env, key), false)
  assert.equal(env.HOME, '/h')

  const calls = []
  const execFile = (file, args, options, callback) => { calls.push({ file, args, options }); callback(Object.assign(new Error('not a repo'), { code: 128 }), Buffer.from(''), Buffer.from('fatal: secret path /Users/x')) }
  const review = createEGDeskGitReview({ execFile, gitExecutable: '/opt/git', env: { PATH: '/usr/bin', GIT_DIR: '/elsewhere/.git' } })
  assert.deepEqual(await review.status('/tmp/root'), { isRepo: false, branch: null, entries: [], truncated: false })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, '/opt/git')
  assert.deepEqual(calls[0].args.slice(0, 11), ['--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'safe.bareRepository=explicit', '-c', 'core.quotePath=false', 'rev-parse', '--show-prefix'])
  assert.equal(calls[0].options.shell, undefined)
  assert.equal(calls[0].options.cwd, '/tmp/root')
  assert.equal(calls[0].options.env.GIT_OPTIONAL_LOCKS, '0')
  assert.equal(calls[0].options.env.GIT_DIR, undefined)
  await assert.rejects(review.status('relative/root'), { code: 'INVALID_PATH' })

  const missing = createEGDeskGitReview({ gitExecutable: path.join(os.tmpdir(), 'egdesk-no-such-git', 'git') })
  await assert.rejects(missing.status(os.tmpdir()), { code: 'GIT_UNAVAILABLE' })
  const noPath = createEGDeskGitReview({ env: { PATH: '' }, platform: 'linux' })
  await assert.rejects(noPath.changes(os.tmpdir()), { code: 'GIT_UNAVAILABLE' })
})

test('uncommitted changes of a connected subfolder: counts, renames, deletions, untracked; ignored and touched-only files excluded', async t => {
  const { root, git, review, env } = await repository(t)
  await write(root, 'app/a.txt', 'one\ntwo\nthree\n')
  await write(root, 'app/gone.txt', 'bye\n')
  await write(root, 'app/old name.txt', 'same\ncontent\n')
  await write(root, 'app/touched.txt', 'unchanged\n')
  await write(root, 'app/한글 파일.txt', '가\n')
  await write(root, 'outside.txt', 'top\n')
  await write(root, '.gitignore', 'app/*.log\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  await write(root, 'app/a.txt', 'one\nTWO\nthree\nfour\n')
  await fs.unlink(path.join(root, 'app/gone.txt'))
  git('mv', 'app/old name.txt', 'app/new name.txt')
  await write(root, 'app/deep/new.txt', 'fresh needle\n')
  await write(root, 'app/debug.log', 'ignored needle\n')
  await write(root, 'app/한글 파일.txt', '가\n나\n')
  await write(root, 'outside.txt', 'changed outside\n')
  const future = new Date(Date.now() + 120_000)
  await fs.utimes(path.join(root, 'app/touched.txt'), future, future)
  const indexBefore = await fs.stat(path.join(root, '.git/index'))
  const appRoot = path.join(root, 'app')

  const status = await review.status(appRoot)
  assert.equal(status.isRepo, true)
  assert.equal(status.branch, 'main')
  assert.deepEqual(status.entries.map(entry => [entry.relativePath, entry.state, entry.directory]).sort(), [
    ['a.txt', 'modified', false], ['deep', 'untracked', true], ['gone.txt', 'deleted', false],
    ['new name.txt', 'renamed', false], ['한글 파일.txt', 'modified', false],
  ])
  const changes = await review.changes(appRoot)
  assert.equal(changes.countsAvailable, true)
  const byPath = Object.fromEntries(changes.files.map(file => [file.relativePath, file]))
  assert.deepEqual(Object.keys(byPath).sort(), ['a.txt', 'deep/new.txt', 'gone.txt', 'new name.txt', '한글 파일.txt'])
  assert.deepEqual([byPath['a.txt'].status, byPath['a.txt'].additions, byPath['a.txt'].deletions], ['modified', 2, 1])
  assert.deepEqual([byPath['gone.txt'].status, byPath['gone.txt'].deletions], ['deleted', 1])
  assert.deepEqual([byPath['new name.txt'].status, byPath['new name.txt'].previousPath], ['renamed', 'old name.txt'])
  assert.deepEqual([byPath['deep/new.txt'].status, byPath['deep/new.txt'].additions], ['untracked', null])
  // Status and diff-index must not refresh or rewrite the user's index.
  const indexAfter = await fs.stat(path.join(root, '.git/index'))
  assert.equal(indexAfter.mtimeMs, indexBefore.mtimeMs)
  assert.equal(indexAfter.size, indexBefore.size)

  const diff = await review.fileDiff(appRoot, { relativePath: 'a.txt' })
  assert.equal(diff.binary, false)
  assert.match(diff.patch, /^diff --git a\/a.txt b\/a.txt/m)
  assert.deepEqual(diff.hunks, [
    { baseStartLine: 2, baseLines: ['two'], currentStartLine: 2, currentLines: ['TWO'] },
    { baseStartLine: 4, baseLines: [], currentStartLine: 4, currentLines: ['four'] },
  ])
  assert.deepEqual((await review.fileDiff(appRoot, { relativePath: 'gone.txt' })).hunks, [{ baseStartLine: 1, baseLines: ['bye'], currentStartLine: 1, currentLines: [] }])
  const renamed = await review.fileDiff(appRoot, { relativePath: 'new name.txt', previousPath: 'old name.txt' })
  assert.match(renamed.patch, /rename from old name.txt/)
  assert.deepEqual(renamed.hunks, [])
  assert.deepEqual((await review.fileDiff(appRoot, { relativePath: '한글 파일.txt' })).hunks, [{ baseStartLine: 2, baseLines: [], currentStartLine: 2, currentLines: ['나'] }])
  await assert.rejects(review.fileDiff(appRoot, { relativePath: '../outside.txt' }), { code: 'INVALID_PATH' })

  const small = await createEGDeskGitReview({ env, limits: { patchMaxBytes: 120 } }).fileDiff(appRoot, { relativePath: 'a.txt' })
  assert.equal(small.truncated, true)
  assert.ok(Buffer.byteLength(small.patch) <= 120)
  assert.ok(small.patch.endsWith('\n'))
})

test('unborn branch compares against the empty tree; non-repositories are reported, not thrown', async t => {
  const { base, root, git, review, env } = await repository(t)
  await write(root, 'first.txt', 'a\nb\n')
  git('add', 'first.txt')
  const changes = await review.changes(root)
  assert.equal(changes.branch, 'main')
  assert.deepEqual(changes.files.map(file => [file.relativePath, file.status, file.additions]), [['first.txt', 'added', 2]])
  assert.deepEqual((await review.fileDiff(root, { relativePath: 'first.txt' })).hunks, [{ baseStartLine: 1, baseLines: [], currentStartLine: 1, currentLines: ['a', 'b'] }])

  const plain = path.join(base, 'plain')
  await fs.mkdir(plain)
  const outside = createEGDeskGitReview({ env: { ...env, GIT_CEILING_DIRECTORIES: base } })
  assert.deepEqual(await outside.status(plain), { isRepo: false, branch: null, entries: [], truncated: false })
  assert.equal((await outside.changes(plain)).isRepo, false)
  assert.equal(await outside.grep(plain, { query: 'x' }), null)
  assert.equal(await outside.listFiles(plain), null)
  await assert.rejects(outside.fileDiff(plain, { relativePath: 'x.txt' }), { code: 'NOT_A_REPOSITORY' })
})

test('repository config cannot run fsmonitor, and a bare-repository layout in the folder is not opened', async t => {
  const { root, git, review, env } = await repository(t)
  await write(root, 'a.txt', 'a\n')
  git('add', 'a.txt'); git('commit', '-qm', 'init')
  git('config', 'core.fsmonitor', 'echo ran >> fsmonitor-runs; false')
  await write(root, 'a.txt', 'b\n')
  assert.equal((await review.status(root)).entries[0].state, 'modified')
  await review.changes(root)
  await assert.rejects(fs.access(path.join(root, 'fsmonitor-runs')))

  const { base } = await sandbox(t)
  const bare = path.join(base, 'downloaded')
  await fs.mkdir(path.join(bare, 'objects', 'info'), { recursive: true })
  await fs.mkdir(path.join(bare, 'refs', 'heads'), { recursive: true })
  await fs.writeFile(path.join(bare, 'HEAD'), 'ref: refs/heads/main\n')
  await fs.writeFile(path.join(bare, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n\tfsmonitor = "echo ran >> fsmonitor-runs; false"\n')
  const isolated = createEGDeskGitReview({ env: { ...env, GIT_CEILING_DIRECTORIES: base } })
  assert.equal((await isolated.status(bare)).isRepo, false)
  await assert.rejects(fs.access(path.join(bare, 'fsmonitor-runs')))
})

test('git grep searches tracked and untracked text, skips ignored files, and honors case', async t => {
  const { root, git, review } = await repository(t)
  await write(root, '.gitignore', '*.log\n')
  await write(root, 'src/a.js', 'const Needle = 1\nneedle()\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  await write(root, 'src/new.txt', 'fresh needle\n')
  await write(root, 'debug.log', 'needle in a log\n')
  await write(root, 'dash.txt', '-e is not an option here\n')
  await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 110, 101, 101, 100, 108, 101]))
  const found = await review.grep(root, { query: 'needle', limit: 10 })
  assert.deepEqual(found.matches.map(match => `${match.relativePath}:${match.lineNumber}`).sort(), ['src/a.js:1', 'src/a.js:2', 'src/new.txt:1'])
  assert.equal(found.truncated, false)
  assert.deepEqual((await review.grep(root, { query: 'Needle', caseSensitive: true })).matches.map(match => match.lineContent), ['const Needle = 1'])
  assert.deepEqual((await review.grep(path.join(root, 'src'), { query: 'fresh' })).matches.map(match => match.relativePath), ['new.txt'])
  assert.deepEqual((await review.grep(root, { query: '-e is' })).matches.map(match => match.relativePath), ['dash.txt'])
  assert.deepEqual(await review.grep(root, { query: 'absent-text' }), { matches: [], truncated: false })
  const limited = await review.grep(root, { query: 'needle', limit: 1 })
  assert.equal(limited.matches.length, 1)
  assert.equal(limited.truncated, true)
  await assert.rejects(review.grep(root, { query: 'two\nlines' }), { code: 'INVALID_QUERY' })
  const listed = await review.listFiles(root)
  assert.deepEqual(listed.paths.sort(), ['.gitignore', 'blob.bin', 'dash.txt', 'src/a.js', 'src/new.txt'])
})
