// EG-Desk's own file tools (c18 prototype). Every file operation happens inside a private temporary folder made for the test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { FILE_TOOL_NAMES, FILE_TOOL_SPECS, applyUnifiedDiff, createFileToolsProvider, previewDiff } from './egdesk-file-tools.mjs'
import { createGateHookBroker } from './egdesk-gate-hook-broker.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const OPEN = { allows: () => true }
const replyClient = (runs, declines) => ({ decide: async () => ({ answers: { reply_runs_command: { type: 'predicate', probability: runs }, reply_declines_command: { type: 'predicate', probability: declines } } }) })
const sha = text => createHash('sha256').update(text).digest('hex')
function setup(t, { mode = 'on', inspect = null } = {}) {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-file-tools-test-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'project'), outside = path.join(base, 'outside')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true }); fs.mkdirSync(path.join(root, '.git'), { recursive: true }); fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true })
  fs.mkdirSync(path.join(root, '.ssh'), { recursive: true }); fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'const a = 1\nconst b = 2\nconsole.log(a + b)\n')
  fs.writeFileSync(path.join(root, 'src', 'twice.js'), 'x()\nx()\n')
  fs.writeFileSync(path.join(root, 'notes.md'), 'TODO: ship it\n')
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n')
  fs.writeFileSync(path.join(root, '.ssh', 'id_test'), 'secret')
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'TODO in a dependency\n')
  fs.writeFileSync(path.join(root, 'logo.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside TODO\n')
  fs.symlinkSync(outside, path.join(root, 'linked-out'))
  fs.symlinkSync(path.join(root, 'notes.md'), path.join(root, 'notes-link.md'))
  const checks = []
  const ledger = createGateHookBroker({ mode: () => 'on', home: '/home/synthetic' })
  const spied = { ...ledger, check: async args => { checks.push(args); return ledger.check(args) } }
  const provider = createFileToolsProvider({ mode: () => mode, ledger: spied, workspaceOf: run => ('folder' in run ? run.folder : root), inspect })
  let n = 0
  const call = async (run, tool, args) => JSON.parse((await provider.dispatch(run, { callId: `f${++n}`, tool, arguments: args })).contentItems[0].text)
  const turn = (conversationId, turnId, extra = {}) => { ledger.turnStarted({ conversationId, turnId }); return { conversationId, runId: turnId, answerId: `${conversationId}/${turnId}`, ...extra } }
  return { root, outside, ledger, checks, provider, call, turn }
}

test('read: pages of numbered lines, cut long lines, binary described not dumped; never outside the folder, through a link or into a secret store', async t => {
  const h = setup(t)
  const run = h.turn('c', 'T')
  const read = await h.call(run, FILE_TOOL_NAMES.read, { path: 'src/app.js', offset: 2, limit: 1 })
  assert.deepEqual([read.status, read.content, read.totalLines, read.next], ['read', '2: const b = 2', 4, 3])
  assert.equal(read.sha256, sha('const a = 1\nconst b = 2\nconsole.log(a + b)\n'))
  fs.writeFileSync(path.join(h.root, 'long.txt'), 'y'.repeat(5000))
  assert.match((await h.call(run, FILE_TOOL_NAMES.read, { path: 'long.txt' })).content, /^1: y{2000}… \(line cut at 2000 chars\)$/)
  const bin = await h.call(run, FILE_TOOL_NAMES.read, { path: 'logo.bin' })
  assert.deepEqual([bin.status, bin.size, Buffer.from(bin.headBase64, 'base64').length], ['binary', 5, 5])
  for (const [p, code] of [['../outside/secret.txt', 'FILE_OUTSIDE_FOLDER'], ['linked-out/secret.txt', 'FILE_SYMLINK_ESCAPE'], ['.ssh/id_test', 'FILE_PROTECTED'], ['missing.txt', 'FILE_NOT_FOUND'], [path.join(h.outside, 'secret.txt'), 'FILE_OUTSIDE_FOLDER']]) {
    assert.equal((await h.call(run, FILE_TOOL_NAMES.read, { path: p })).code, code, p)
  }
  assert.equal((await h.call(run, FILE_TOOL_NAMES.read, { path: '.git/config' })).status, 'read', 'reading version-control internals is allowed; editing them is not')
  assert.equal((await h.call(run, FILE_TOOL_NAMES.read, { path: 'notes-link.md' })).status, 'read', 'a link that stays inside may be read')
  assert.equal(h.checks.length, 0, 'reads never ask')
})

test('search: bounded, literal or regex, skips .git, node_modules, secret stores and links', async t => {
  const h = setup(t)
  const run = h.turn('c', 'T')
  const found = await h.call(run, FILE_TOOL_NAMES.search, { pattern: 'TODO' })
  assert.deepEqual(found.matches.map(m => [m.path, m.line]), [['notes.md', 1]], 'not node_modules, not the linked outside folder, not the binary')
  assert.deepEqual((await h.call(run, FILE_TOOL_NAMES.search, { pattern: '^const [ab]', regex: true })).matches.map(m => m.line), [1, 2])
  assert.equal((await h.call(run, FILE_TOOL_NAMES.search, { pattern: '(', regex: true })).code, 'SEARCH_PATTERN_INVALID')
  assert.equal((await h.call(run, FILE_TOOL_NAMES.search, { pattern: 'x', path: '../outside' })).code, 'FILE_OUTSIDE_FOLDER')
  const many = setup(t)
  fs.writeFileSync(path.join(many.root, 'many.txt'), 'hit\n'.repeat(500))
  const capped = await many.call(many.turn('c', 'T'), FILE_TOOL_NAMES.search, { pattern: 'hit' })
  assert.deepEqual([capped.matches.length, capped.stoppedBy], [200, 'matches'])
  assert.equal(h.checks.length + many.checks.length, 0)
})

test('edit: exact string (unique unless replaceAll), stale check, dry run writes nothing; refuses .git, engine internals and links', async t => {
  const h = setup(t)
  const run = h.turn('c', 'T')
  const file = path.join(h.root, 'src', 'app.js')
  const preview = await h.call(run, FILE_TOOL_NAMES.edit, { path: 'src/app.js', mode: 'replace', oldString: 'const b = 2', newString: 'const b = 3', dryRun: true })
  assert.deepEqual([preview.status, preview.kind, preview.needsPerson], ['preview', 'update', false]); assert.match(preview.diff, /-const b = 2\n\+const b = 3/)
  assert.match(fs.readFileSync(file, 'utf8'), /const b = 2/, 'dry run wrote nothing')
  for (const [args, code] of [[{ oldString: 'nope', newString: 'x' }, 'EDIT_NO_MATCH'], [{ oldString: 'a', newString: 'a' }, 'EDIT_NO_CHANGE'], [{ oldString: '', newString: 'x' }, 'EDIT_STRINGS_INVALID']]) {
    assert.equal((await h.call(run, FILE_TOOL_NAMES.edit, { path: 'src/app.js', mode: 'replace', ...args })).code, code)
  }
  assert.equal((await h.call(run, FILE_TOOL_NAMES.edit, { path: 'src/twice.js', mode: 'replace', oldString: 'x()', newString: 'y()' })).code, 'EDIT_AMBIGUOUS')
  assert.equal((await h.call(run, FILE_TOOL_NAMES.edit, { path: 'src/twice.js', mode: 'replace', oldString: 'x()', newString: 'y()', replaceAll: true })).status, 'edited')
  assert.equal(fs.readFileSync(path.join(h.root, 'src', 'twice.js'), 'utf8'), 'y()\ny()\n')
  assert.equal((await h.call(run, FILE_TOOL_NAMES.edit, { path: 'src/app.js', mode: 'replace', oldString: 'const b = 2', newString: 'const b = 3', expectedSha256: 'f'.repeat(64) })).status, 'stale')
  const edited = await h.call(run, FILE_TOOL_NAMES.edit, { path: 'src/app.js', mode: 'replace', oldString: 'const b = 2', newString: 'const b = 3' })
  assert.equal(edited.status, 'edited'); assert.match(fs.readFileSync(file, 'utf8'), /const b = 3/)
  for (const [p, code] of [['.git/config', 'FILE_PROTECTED'], ['.codex/config.toml', 'FILE_PROTECTED'], ['.agents/x.md', 'FILE_PROTECTED'], ['.ssh/id_test', 'FILE_PROTECTED'],
    ['notes-link.md', 'FILE_SYMLINK'], ['linked-out/secret.txt', 'FILE_SYMLINK_ESCAPE'], ['../outside/secret.txt', 'FILE_OUTSIDE_FOLDER']]) {
    assert.equal((await h.call(run, FILE_TOOL_NAMES.edit, { path: p, mode: 'write', content: 'x' })).code, code, p)
  }
  assert.equal(fs.readFileSync(path.join(h.outside, 'secret.txt'), 'utf8'), 'outside TODO\n'); assert.equal(fs.readFileSync(path.join(h.root, '.git', 'config'), 'utf8'), '[core]\n')
  assert.deepEqual(fs.readdirSync(path.join(h.root, 'src')).filter(name => name.startsWith('.egdesk-write-')), [], 'atomic writes leave no temporary file')
  assert.equal(h.checks.length, 0, 'targeted edits do not ask')
})

test('edit: a unified diff is verified before anything is written; create and targeted hunks do not ask', async t => {
  const h = setup(t)
  const run = h.turn('c', 'T')
  const hunk = '--- a/src/app.js\n+++ b/src/app.js\n@@ -1,3 +1,3 @@\n const a = 1\n-const b = 2\n+const b = 20\n console.log(a + b)\n'
  assert.equal((await h.call(run, FILE_TOOL_NAMES.edit, { path: 'src/app.js', mode: 'diff', diff: hunk })).status, 'edited')
  assert.equal(fs.readFileSync(path.join(h.root, 'src', 'app.js'), 'utf8'), 'const a = 1\nconst b = 20\nconsole.log(a + b)\n')
  assert.equal((await h.call(run, FILE_TOOL_NAMES.edit, { path: 'src/app.js', mode: 'diff', diff: hunk })).code, 'DIFF_NO_MATCH', 'the old lines are gone: nothing is applied')
  assert.equal((await h.call(run, FILE_TOOL_NAMES.edit, { path: 'src/twice.js', mode: 'diff', diff: '@@ -1 +1 @@\n-x()\n+z()\n' })).code, 'DIFF_AMBIGUOUS')
  assert.equal((await h.call(run, FILE_TOOL_NAMES.edit, { path: 'src/new.js', mode: 'diff', diff: '--- /dev/null\n+++ b/src/new.js\n@@ -0,0 +1,2 @@\n+one\n+two\n' })).kind, 'create')
  assert.equal(fs.readFileSync(path.join(h.root, 'src', 'new.js'), 'utf8'), 'one\ntwo\n')
  assert.equal((await h.call(run, FILE_TOOL_NAMES.edit, { path: 'src/fresh.js', mode: 'write', content: 'new\n' })).kind, 'create')
  assert.equal(applyUnifiedDiff('a\n', 'garbage').error, 'DIFF_EMPTY'); assert.equal(applyUnifiedDiff('a\n', '@@ nonsense @@\n').error, 'DIFF_INVALID')
  assert.match(previewDiff('x', null, 'a\n').diff, /^--- \/dev\/null\n\+\+\+ b\/x/)
  assert.equal(h.checks.length, 0)
})

test('edit: deleting or replacing a whole file a person keeps asks; the yes in the next message writes exactly that edit once; generated files do not ask', async t => {
  const h = setup(t)
  const t1 = h.turn('conv', 'T1')
  const asked = await h.call(t1, FILE_TOOL_NAMES.edit, { path: 'notes.md', mode: 'write', content: 'rewritten\n' })
  assert.deepEqual([asked.status, asked.kind, asked.written, asked.reasons], ['needs_person', 'overwrite', false, ['unresolved_target']])
  assert.match(asked.diff, /-TODO: ship it\n\+rewritten/); assert.equal(fs.readFileSync(path.join(h.root, 'notes.md'), 'utf8'), 'TODO: ship it\n')
  assert.equal(h.checks[0].command, 'overwrite file notes.md', 'the person\'s reply is read against a plain description; the exact content is the identity')
  h.ledger.turnEnded({ turnId: 'T1' })
  assert.equal((await h.ledger.readReply({ conversationId: 'conv', reply: 'yes', client: replyClient(0.97, 0.01), egress: OPEN })).approved, true)
  const t2 = h.turn('conv', 'T2')
  assert.equal((await h.call(t2, FILE_TOOL_NAMES.edit, { path: 'notes.md', mode: 'write', content: 'rewritten differently\n' })).status, 'needs_person', 'other content: a new question')
  assert.equal((await h.call(t2, FILE_TOOL_NAMES.edit, { path: 'notes.md', mode: 'write', content: 'rewritten\n' })).status, 'edited')
  assert.equal(fs.readFileSync(path.join(h.root, 'notes.md'), 'utf8'), 'rewritten\n')
  assert.notEqual((await h.call(t2, FILE_TOOL_NAMES.edit, { path: 'notes.md', mode: 'delete' })).status, 'edited')
  assert.ok(fs.existsSync(path.join(h.root, 'notes.md')))
  // facts: a tracked file says so; a generated (ignored, untracked) file is replaced or deleted without asking
  const facts = setup(t, { inspect: async ({ paths }) => ({ targets: Object.fromEntries(paths.map(p => [p, p.endsWith('app.js') ? { exists: true, trackedFiles: 1, ignored: false } : { exists: true, trackedFiles: 0, ignored: true }])), git: { dirty: false } }) })
  const run = facts.turn('c2', 'U')
  assert.deepEqual((await facts.call(run, FILE_TOOL_NAMES.edit, { path: 'src/app.js', mode: 'delete' })).reasons, ['tracked_files'])
  assert.equal((await facts.call(run, FILE_TOOL_NAMES.edit, { path: 'notes.md', mode: 'delete' })).status, 'edited', 'generated: no question')
  assert.ok(!fs.existsSync(path.join(facts.root, 'notes.md')))
})

test('identity and flag: the folder is the run\'s; profile and account play no part; off offers nothing; QA runs never edit', async t => {
  const results = []
  for (const extra of [{ engineProfileId: 'codex-11111111' }, { engineProfileId: 'codex-22222222', screen: 'board-2' }]) {
    const h = setup(t)
    results.push(await h.call(h.turn('c', 'T', extra), FILE_TOOL_NAMES.edit, { path: 'notes.md', mode: 'delete' }))
  }
  assert.deepEqual(results[1], results[0])
  const off = setup(t, { mode: 'off' })
  assert.deepEqual(off.provider.specs(), [])
  assert.match((await off.provider.dispatch(off.turn('c', 'T'), { callId: 'x', tool: FILE_TOOL_NAMES.read, arguments: { path: 'notes.md' } })).contentItems[0].text, /FILE_TOOLS_OFF/)
  const h = setup(t)
  assert.deepEqual(h.provider.specs().map(s => s.name), FILE_TOOL_SPECS.map(s => s.name))
  assert.match((await h.provider.dispatch(h.turn('d', 'U', { executionPolicy: 'read-only-qa' }), { callId: 'y', tool: FILE_TOOL_NAMES.edit, arguments: { path: 'notes.md', mode: 'delete' } })).contentItems[0].text, /FILE_EDIT_FORBIDDEN/)
  assert.equal((await h.call(h.turn('e', 'V', { folder: null }), FILE_TOOL_NAMES.read, { path: 'notes.md' })).code, 'FILE_NO_FOLDER')
})
