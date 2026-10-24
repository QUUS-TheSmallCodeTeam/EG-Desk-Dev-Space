// 1-D: '바뀐 줄 보기'(EGDeskDiffView) and '테스트·빌드 결과 카드'(EGDeskRunResult).
// Run: cd /Users/minsoocha/Projects/EG-Desk-Dev-Space && node --test apps/firefox-ui-demo/scripts/egdesk-diff-run-result.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import * as Diff from '../overlay/resources/EGDeskDiffView.sys.mjs'
import * as Run from '../overlay/resources/EGDeskRunResult.sys.mjs'
import { structuredPatch } from '../overlay/resources/vendor/jsdiff/index.js'

const resources = new URL('../overlay/resources/', import.meta.url)
const ROOT = '/work/proj'

// ---- a tiny DOM: enough for createElement/textContent/setAttribute/append ----
class FakeNode {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map(); this.listeners = new Map(); this.ownText = ''; this.className = '' }
  set textContent(value) { this.ownText = String(value); this.children = [] }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join('') }
  set innerHTML(_) { throw new Error('innerHTML must not be used') }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  append(...nodes) { for (const node of nodes) { assert.ok(node instanceof FakeNode, 'only nodes are appended'); this.children.push(node) } }
  appendChild(node) { this.append(node); return node }
  addEventListener(type, listener) { this.listeners.set(type, listener) }
  click() { this.listeners.get('click')?.() }
}
const fakeDocument = { createElement: tag => new FakeNode(tag) }
function all(node, className, out = []) {
  if (node.className.split(' ').includes(className)) out.push(node)
  for (const child of node.children) all(child, className, out)
  return out
}
function tags(node, tagName, out = []) {
  if (node.tagName === tagName.toUpperCase()) out.push(node)
  for (const child of node.children) tags(child, tagName, out)
  return out
}

// ============================ vendor / licences ============================

test('vendored jsdiff 9.0.0 is byte-identical to the VENDOR.md record and carries its licence', () => {
  const record = readFileSync(new URL('vendor/VENDOR.md', resources), 'utf8')
  assert.match(record, /jsdiff \(npm `diff`\) \| 9\.0\.0 \| BSD-3-Clause/)
  assert.match(record, /sha512-svtcdpS8CgJyqAjEQIXdb3OjhFVVYjzGAPO8WGCmRbrml64SPw\/jJD4GoE98aR7r25A0XcgrK3F02yw9R\/vhQw==/)
  const listed = new Map([...record.matchAll(/^\| `(jsdiff\/[^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map(([, file, hash]) => [file, hash]))
  const base = new URL('vendor/', resources)
  const files = readdirSync(new URL('jsdiff/', base), { recursive: true })
    .map(name => `jsdiff/${String(name).replace(/\\/g, '/')}`)
    .filter(name => statSync(new URL(name, base)).isFile())
    .sort()
  assert.deepEqual(files, [...listed.keys()].sort(), 'every vendored file is listed, and nothing else is there')
  for (const file of files) {
    const hash = createHash('sha256').update(readFileSync(new URL(file, base))).digest('hex')
    assert.equal(hash, listed.get(file), `${file} is unmodified`)
  }
  const licence = readFileSync(new URL('jsdiff/LICENSE', base), 'utf8')
  assert.match(licence, /BSD 3-Clause License/)
  assert.match(licence, /Copyright \(c\) 2009-2015, Kevin Decker/)
  assert.deepEqual(JSON.parse(readFileSync(new URL('jsdiff/package.json', base), 'utf8')), { type: 'module', sideEffects: false })
  // Firefox system modules: no CommonJS, no node: imports in the vendored ESM.
  for (const file of files.filter(name => name.endsWith('.js'))) {
    const source = readFileSync(new URL(file, base), 'utf8')
    assert.equal(/\brequire\(|from ['"]node:/.test(source), false, `${file} stays browser ESM`)
    for (const [, specifier] of source.matchAll(/^(?:import|export)\b[^\n]*?\bfrom ['"]([^'"]+)['"]/gm)) assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), `${file} imports only relative files (${specifier})`)
  }
})

test('the two overlay modules keep their licence notices and stay Firefox-loadable', () => {
  const runSource = readFileSync(new URL('EGDeskRunResult.sys.mjs', resources), 'utf8')
  const diffSource = readFileSync(new URL('EGDeskDiffView.sys.mjs', resources), 'utf8')
  assert.match(runSource, /Copyright \(c\) Microsoft Corporation\. All rights reserved\.\n \*  Licensed under the MIT License\./)
  assert.match(runSource, /terminalLinkParsing\.ts\n\/\/   at commit da20a6d0ddd819136575cd284741993a9e724c2f/)
  const record = readFileSync(new URL('vendor/VENDOR.md', resources), 'utf8')
  assert.match(record, /Copyright \(c\) 2015 - present Microsoft Corporation/)
  assert.match(record, /Copyright \(c\) 2017-2019, The xterm\.js authors/)
  for (const source of [runSource, diffSource]) {
    assert.equal(/from ['"]node:|\brequire\(|innerHTML|console\./.test(source), false)
  }
  assert.match(diffSource, /from '\.\/vendor\/jsdiff\/index\.js'/)
})

// ============================ EGDeskDiffView ============================

// codex apply-patch: update diff = hunk-only, 1 line of context.
const CODEX_UPDATE = '@@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n@@ -9,2 +9,3 @@\n nine\n+nine-and-half\n ten\n'

test('a Codex update (hunk-only diff) becomes numbered −/+ lines', () => {
  const file = Diff.fileDiffFromCodexChange({ path: `${ROOT}/src/list.txt`, kind: 'update', diff: CODEX_UPDATE })
  assert.equal(file.change, 'update')
  assert.equal(file.status, 'ok')
  assert.equal(file.path, `${ROOT}/src/list.txt`)
  assert.equal(file.oldPath, file.newPath)
  assert.equal(file.added, 2)
  assert.equal(file.removed, 1)
  assert.equal(file.hunks.length, 2)
  assert.equal(file.hunks[0].header, '@@ -2,3 +2,3 @@')
  assert.deepEqual(file.hunks[0].lines, [
    { kind: 'context', text: 'two', oldLine: 2, newLine: 2 },
    { kind: 'delete', text: 'three', oldLine: 3, newLine: null },
    { kind: 'add', text: 'THREE', oldLine: null, newLine: 3 },
    { kind: 'context', text: 'four', oldLine: 4, newLine: 4 },
  ])
  assert.deepEqual(file.hunks[1].lines[1], { kind: 'add', text: 'nine-and-half', oldLine: null, newLine: 10 })
  assert.equal(Diff.firstChangedLine(file), 3)
})

test("'Moved to:' is taken off before parsing and turns the change into a rename", () => {
  const moved = Diff.fileDiffFromCodexChange({ path: `${ROOT}/src/old.txt`, kind: 'update', diff: `${CODEX_UPDATE}\n\nMoved to: ${ROOT}/src/new.txt` })
  assert.equal(moved.change, 'rename')
  assert.equal(moved.status, 'ok')
  assert.equal(moved.oldPath, `${ROOT}/src/old.txt`)
  assert.equal(moved.newPath, `${ROOT}/src/new.txt`)
  assert.equal(moved.path, `${ROOT}/src/new.txt`)
  assert.equal(moved.added, 2)
  assert.deepEqual(Diff.splitMovedTo('\n\nMoved to: /a/b.txt'), { diff: '', movePath: '/a/b.txt' })
  const pureMove = Diff.fileDiffFromCodexChange({ path: '/a/x.txt', kind: 'update', diff: '\n\nMoved to: /a/y.txt' })
  assert.deepEqual([pureMove.change, pureMove.status, pureMove.hunks.length], ['rename', 'ok', 0])
  const viaKind = Diff.fileDiffFromCodexChange({ path: '/a/x.txt', kind: { type: 'update', move_path: '/a/z.txt' }, diff: CODEX_UPDATE })
  assert.deepEqual([viaKind.change, viaKind.newPath], ['rename', '/a/z.txt'])
  // A context line that happens to read 'Moved to:' is diff content, not a move.
  const content = Diff.splitMovedTo('@@ -1 +1 @@\n-a\n+ Moved to: x\n')
  assert.equal(content.movePath, null)
})

test('add/delete carry the whole file and diff against an empty document', () => {
  const added = Diff.fileDiffFromCodexChange({ path: `${ROOT}/new.txt`, kind: { type: 'add' }, diff: 'alpha\nbeta\n' })
  assert.deepEqual([added.change, added.oldPath, added.newPath, added.added, added.removed], ['add', null, `${ROOT}/new.txt`, 2, 0])
  assert.equal(added.hunks[0].header, '@@ -0,0 +1,2 @@')
  assert.deepEqual(added.hunks[0].lines.map(line => [line.kind, line.text, line.newLine]), [['add', 'alpha', 1], ['add', 'beta', 2]])
  const deleted = Diff.fileDiffFromCodexChange({ path: `${ROOT}/gone.txt`, kind: 'delete', diff: 'bye\n' })
  assert.deepEqual([deleted.change, deleted.newPath, deleted.removed], ['delete', null, 1])
  assert.equal(deleted.hunks[0].header, '@@ -1 +0,0 @@')
  assert.equal(Diff.firstChangedLine(Diff.fileDiffFromTexts({ path: 'd.txt', oldText: 'a\nb\nc\n', newText: 'a\nc\n' })), 2, 'a deletion points at the line now in its place')
  const noNewline = Diff.fileDiffFromCodexChange({ path: '/n.txt', kind: 'add', diff: 'x\ny' })
  assert.deepEqual(noNewline.hunks[0].lines.map(line => line.kind), ['add', 'add', 'note'])
  assert.equal(noNewline.hunks[0].lines[2].text, '파일 끝에 줄바꿈이 없습니다')
  assert.equal(Diff.fileDiffFromCodexChange({ path: '/e.txt', kind: 'add', diff: '' }).status, 'empty')
  const item = Diff.fileDiffsFromCodexItem({ type: 'fileChange', changes: [{ path: '/a', kind: 'add', diff: 'a\n' }, { path: '/b', kind: 'delete', diff: 'b\n' }] })
  assert.deepEqual(item.map(file => file.change), ['add', 'delete'])
  assert.equal(Diff.diffSummaryText(item), '파일 2개 · +1 \u22121')
})

const TURN_DIFF = [
  'diff --git a/src/app.js b/src/app.js', 'index 1111111..2222222 100644', '--- a/src/app.js', '+++ b/src/app.js',
  '@@ -1,3 +1,3 @@', ' const a = 1', '-const b = 2', '+const b = 3', ' export { a, b }',
  'diff --git a/docs/new.md b/docs/new.md', 'new file mode 100644', 'index 0000000..3333333', '--- /dev/null', '+++ b/docs/new.md',
  '@@ -0,0 +1,2 @@', '+# New', '+text',
  'diff --git a/old.txt b/old.txt', 'deleted file mode 100644', 'index 4444444..0000000', '--- a/old.txt', '+++ /dev/null',
  '@@ -1 +0,0 @@', '-bye',
  'diff --git a/img.png b/img.png', 'index 5555555..6666666 100644', 'Binary files a/img.png and b/img.png differ',
  'diff --git a/a.txt b/b.txt', 'similarity index 100%', 'rename from a.txt', 'rename to b.txt', '',
].join('\n')

test('a git-style turn diff splits into files with add/delete/rename/binary kept apart', () => {
  const files = Diff.fileDiffsFromUnifiedDiff(TURN_DIFF)
  assert.deepEqual(files.map(file => [file.path, file.change, file.status, file.added, file.removed]), [
    ['src/app.js', 'update', 'ok', 1, 1],
    ['docs/new.md', 'add', 'ok', 2, 0],
    ['old.txt', 'delete', 'ok', 0, 1],
    ['img.png', 'update', 'binary', 0, 0],
    ['b.txt', 'rename', 'ok', 0, 0],
  ])
  assert.equal(files[2].newPath, null)
  assert.equal(files[1].oldPath, null)
  assert.deepEqual([files[4].oldPath, files[4].newPath], ['a.txt', 'b.txt'])
  assert.equal(Diff.diffSummaryText(files), '파일 5개 · +3 \u22122')
  const hunkOnly = Diff.fileDiffsFromUnifiedDiff(CODEX_UPDATE, { path: 'src/list.txt' })
  assert.deepEqual(hunkOnly.map(file => [file.path, file.change, file.added]), [['src/list.txt', 'update', 2]])
  assert.deepEqual(Diff.fileDiffsFromUnifiedDiff(''), [])
})

test('two texts (ACP/Claude shape) skip the shared head and tail but give the same hunks as a full diff', () => {
  const before = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`)
  const after = [...before]
  after[99] = 'line 100 changed'
  after.splice(150, 0, 'inserted')
  const oldText = `${before.join('\n')}\n`
  const newText = `${after.join('\n')}\n`
  const file = Diff.fileDiffFromTexts({ path: 'a.txt', oldText, newText })
  const full = structuredPatch('', '', oldText, newText, '', '', { context: 3 })
  assert.deepEqual(file.hunks.map(hunk => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines]),
    full.hunks.map(hunk => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines]))
  assert.deepEqual(file.hunks.map(hunk => hunk.lines.length), full.hunks.map(hunk => hunk.lines.length))
  assert.deepEqual([file.change, file.added, file.removed], ['update', 2, 1])
  assert.equal(Diff.fileDiffFromTexts({ path: 'n.txt', oldText: null, newText: 'hello\n' }).change, 'add')
  assert.equal(Diff.fileDiffFromTexts({ path: 's.txt', oldText: 'same\n', newText: 'same\n' }).status, 'empty')
})

test('over 1 MiB, binary or unreadable input is reported, not diffed', () => {
  assert.equal(Diff.utf8LengthExceeds('가'.repeat(350000)), true, '1,050,000 UTF-8 bytes')
  assert.equal(Diff.utf8LengthExceeds('가'.repeat(349525)), false, '1,048,575 UTF-8 bytes')
  assert.equal(Diff.fileDiffFromCodexChange({ path: '/big', kind: 'add', diff: 'x'.repeat(1024 * 1024 + 1) }).status, 'too-large')
  assert.equal(Diff.fileDiffFromTexts({ path: '/bin', oldText: 'a\u0000b', newText: 'c' }).status, 'binary')
  const broken = Diff.fileDiffFromCodexChange({ path: '/w', kind: 'update', diff: '@@ -1,2 +1,2 @@\n*not a diff line\n' })
  assert.equal(broken.status, 'unparsable')
  assert.equal(broken.raw, '@@ -1,2 +1,2 @@\n*not a diff line\n')
  assert.match(Diff.fileStatusNote(broken), /그대로/)
  const many = Diff.fileDiffFromCodexChange({ path: '/many', kind: 'add', diff: `${Array.from({ length: 5000 }, (_, i) => `l${i}`).join('\n')}\n` })
  assert.equal(many.truncated, true)
  assert.equal(many.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0), Diff.DIFF_VIEW_LIMITS.maxLinesPerFile)
})

test('the chat runtime GET /chat/run-changes response maps straight to file diffs', () => {
  const packet = {
    retained: true,
    turn: { diff: TURN_DIFF, bytes: TURN_DIFF.length, omitted: null },
    items: [{
      itemId: 'item-1', status: 'completed', truncated: false,
      files: [
        { path: `${ROOT}/a.txt`, kind: 'update', movePath: `${ROOT}/b.txt`, diff: CODEX_UPDATE, bytes: 80, omitted: null },
        { path: `${ROOT}/big.txt`, kind: 'update', movePath: null, diff: null, bytes: 300000, omitted: 'fileLimit' },
        { path: `${ROOT}/x.txt`, kind: 'add', movePath: null, diff: null, bytes: 0, omitted: 'unavailable' },
      ],
    }],
    commands: [], limits: {},
  }
  const view = Diff.diffViewFromRunChanges(packet)
  assert.equal(view.retained, true)
  assert.deepEqual(view.items.map(item => [item.itemId, item.status, item.truncated]), [['item-1', 'completed', false]])
  assert.deepEqual(view.items[0].files.map(file => [file.path, file.change, file.status, file.added]), [
    [`${ROOT}/b.txt`, 'rename', 'ok', 2], [`${ROOT}/big.txt`, 'update', 'omitted', 0], [`${ROOT}/x.txt`, 'add', 'unavailable', 0]])
  assert.match(Diff.fileStatusNote(view.items[0].files[1]), /보관하지 않았습니다/)
  assert.equal(view.turn.length, 5)
  assert.equal(view.turnOmitted, null)
  const limited = Diff.diffViewFromRunChanges({ retained: true, turn: { diff: null, bytes: 2000000, omitted: 'turnLimit' }, items: [] })
  assert.deepEqual([limited.turn, limited.turnOmitted], [[], 'turnLimit'])
  assert.equal(Diff.diffViewFromRunChanges({ retained: false, turn: null, items: [] }).turn, null)
})

test('fileViewHunks matches the File view review panel shape', () => {
  const file = Diff.fileDiffFromCodexChange({ path: '/x', kind: 'update', diff: CODEX_UPDATE })
  assert.deepEqual(Diff.fileViewHunks(file), [
    { baseStartLine: 2, baseLines: ['two', 'three', 'four'], currentStartLine: 2, currentLines: ['two', 'THREE', 'four'] },
    { baseStartLine: 9, baseLines: ['nine', 'ten'], currentStartLine: 9, currentLines: ['nine', 'nine-and-half', 'ten'] },
  ])
})

test('renderDiffView draws files with <ins>/<del> through textContent only, and opens a file at its first change', () => {
  const files = [...Diff.fileDiffsFromUnifiedDiff(TURN_DIFF), Diff.fileDiffFromCodexChange({ path: `${ROOT}/w.txt`, kind: 'update', diff: '@@ -1 +1 @@\n*x\n' })]
  const opened = []
  const view = Diff.renderDiffView({ document: fakeDocument, files, root: ROOT, onOpenFile: target => opened.push(target) })
  assert.equal(view.className, 'egdesk-diff-view')
  assert.equal(view.getAttribute('aria-label'), '바뀐 줄 보기')
  assert.equal(all(view, 'egdesk-diff-summary')[0].textContent, '파일 6개 · +3 \u22122')
  const details = all(view, 'egdesk-diff-file')
  assert.deepEqual(details.map(node => [node.getAttribute('data-change'), node.getAttribute('data-status')]), [
    ['update', 'ok'], ['add', 'ok'], ['delete', 'ok'], ['update', 'binary'], ['rename', 'ok'], ['update', 'unparsable']])
  assert.deepEqual(details.map(node => Boolean(node.open)), [true, true, true, false, false, false])
  assert.deepEqual(tags(details[0], 'del').map(node => node.textContent), ['const b = 2'])
  assert.deepEqual(tags(details[0], 'ins').map(node => node.textContent), ['const b = 3'])
  assert.equal(all(details[0], 'egdesk-diff-hunk-header')[0].getAttribute('data-range'), '@@ -1,3 +1,3 @@')
  assert.equal(all(details[0], 'egdesk-diff-hunk-header')[0].textContent, '원본 1행 · 바뀐 뒤 1행')
  assert.equal(all(details[0], 'egdesk-diff-file-summary')[0].getAttribute('aria-label'), 'src/app.js · 수정 · 1줄 추가 · 1줄 삭제')
  assert.equal(all(details[2], 'egdesk-diff-open').length, 0, 'a deleted file has nothing to open')
  assert.match(all(details[3], 'egdesk-diff-note')[0].textContent, /바이너리/)
  assert.equal(all(details[4], 'egdesk-diff-file-move')[0].textContent, 'a.txt → b.txt')
  assert.equal(all(details[5], 'egdesk-diff-raw')[0].textContent, '@@ -1 +1 @@\n*x\n')
  all(details[0], 'egdesk-diff-open')[0].click()
  assert.deepEqual(opened, [{ path: 'src/app.js', line: 2 }])
  assert.equal(Diff.displayDiffPath(`${ROOT}/src/a.js`, `${ROOT}/`), 'src/a.js')
  assert.equal(Diff.displayDiffPath('/elsewhere/a.js', ROOT), '/elsewhere/a.js')
})

// ============================ EGDeskRunResult ============================

// ---- the ported VS Code link parser, checked with cases ported from its own tests ----
// Cases below are from microsoft/vscode
// src/vs/workbench/contrib/terminalContrib/links/test/browser/terminalLinkParsing.test.ts
// Copyright (c) Microsoft Corporation. Licensed under the MIT License (full text: overlay/resources/vendor/VENDOR.md).
test('terminalLinkParsing port: suffixes and links match the VS Code test cases', () => {
  const suffixCases = [
    ['foo:339', ':339', 339, undefined], ['foo:339:12', ':339:12', 339, 12], ['foo:339.12', ':339.12', 339, 12],
    ['foo#339', '#339', 339, undefined], ['foo 339', ' 339', 339, undefined], ['foo, 339', ', 339', 339, undefined],
    ['"foo",339', '",339', 339, undefined], ['"foo", line 339, col 12', '", line 339, col 12', 339, 12],
    ['foo:line 339', ':line 339', 339, undefined], ['foo on line 339, column 12', ' on line 339, column 12', 339, 12],
    ['foo(339)', '(339)', 339, undefined], ['foo(339,12)', '(339,12)', 339, 12], ['foo (339, 12)', ' (339, 12)', 339, 12],
  ]
  for (const [link, suffix, row, col] of suffixCases) {
    const found = Run.getLinkSuffix(link)
    assert.equal(found?.suffix.text, suffix, link)
    assert.equal(found?.row, row, link)
    assert.equal(found?.col, col, link)
    assert.equal(Run.removeLinkSuffix(link), link.slice(0, link.length - suffix.length), link)
  }
  assert.equal(Run.getLinkSuffix('foo'), null)
  assert.equal(Run.removeLinkQueryString('foo?a=b'), 'foo')
  assert.equal(Run.removeLinkQueryString('\\\\?\\C:\\foo?a=b'), '\\\\?\\C:\\foo')
  assert.deepEqual(Run.detectLinks('foo(1, 2) bar[3, 4] "baz" on line 5', 'linux'), [
    { path: { index: 0, text: 'foo' }, prefix: undefined, suffix: { col: 2, row: 1, rowEnd: undefined, colEnd: undefined, suffix: { index: 3, text: '(1, 2)' } } },
    { path: { index: 10, text: 'bar' }, prefix: undefined, suffix: { col: 4, row: 3, rowEnd: undefined, colEnd: undefined, suffix: { index: 13, text: '[3, 4]' } } },
    { path: { index: 21, text: 'baz' }, prefix: { index: 20, text: '"' }, suffix: { col: undefined, row: 5, rowEnd: undefined, colEnd: undefined, suffix: { index: 24, text: '" on line 5' } } },
  ])
  assert.deepEqual(Run.detectLinks('PS C:\\Github\\microsoft\\vscode> echo \'"foo", line 5, col 6\'', 'windows'), [
    { path: { index: 3, text: 'C:\\Github\\microsoft\\vscode' }, prefix: undefined, suffix: undefined },
    { path: { index: 38, text: 'foo' }, prefix: { index: 37, text: '"' }, suffix: { row: 5, col: 6, rowEnd: undefined, colEnd: undefined, suffix: { index: 41, text: '", line 5, col 6' } } },
  ])
  assert.deepEqual(Run.detectLinks('|C:\\Github\\microsoft\\vscode:400|', 'windows'), [
    { path: { index: 1, text: 'C:\\Github\\microsoft\\vscode' }, prefix: undefined, suffix: { col: undefined, row: 400, rowEnd: undefined, colEnd: undefined, suffix: { index: 27, text: ':400' } } },
  ])
  for (const prefix of ['a', 'c', 'w', 'i', 'o']) {
    assert.deepEqual(Run.detectLinks(`--- ${prefix}/foo/bar`, 'linux'), [{ path: { index: 6, text: 'foo/bar' }, prefix: undefined, suffix: undefined }])
  }
  assert.deepEqual(Run.detectLinks('diff --git a/foo/bar b/foo/baz', 'linux'), [
    { path: { index: 13, text: 'foo/bar' }, prefix: undefined, suffix: undefined },
    { path: { index: 23, text: 'foo/baz' }, prefix: undefined, suffix: undefined },
  ])
  assert.deepEqual(Run.detectLinks('foo 1/bar', 'linux'), [{ path: { index: 4, text: '1/bar' }, prefix: undefined, suffix: undefined }])
  assert.equal(Run.detectLinkSuffixes('foo(1, 2) bar[3, 4] baz on line 5').length, 3)
})
// ---- end of cases ported from VS Code ----

test('commands are classified by what they run, through shell wrappers, cd, env and npx', () => {
  const kind = (command, options) => { const c = Run.classifyCommand(command, options); return [c.kind, c.runner, c.label] }
  assert.deepEqual(kind('/bin/zsh -lc "cd app && npm test"'), ['test', null, '테스트'])
  assert.deepEqual(kind("/bin/zsh -lc 'node --test scripts/a.test.mjs'"), ['test', 'node-test', '테스트'])
  assert.deepEqual(kind('npx tsc --noEmit'), ['typecheck', 'tsc', '타입 검사'])
  assert.deepEqual(kind('tsc -b'), ['build', 'tsc', '빌드'])
  assert.deepEqual(kind('pnpm run lint'), ['lint', null, '코드 검사'])
  assert.deepEqual(kind('npm run build'), ['build', null, '빌드'])
  assert.deepEqual(kind('npm run typecheck'), ['typecheck', null, '타입 검사'])
  assert.deepEqual(kind('yarn test:unit'), ['test', null, '테스트'])
  assert.deepEqual(kind('npm run inspect'), ['other', null, '명령'], "'spec' inside a word is not a test script")
  assert.deepEqual(kind('CI=1 npx jest --ci'), ['test', 'jest', '테스트'])
  assert.deepEqual(kind('npx vitest run'), ['test', 'vitest', '테스트'])
  assert.deepEqual(kind('python3 -m pytest -q'), ['test', 'pytest', '테스트'])
  assert.deepEqual(kind('uv run pytest'), ['test', 'pytest', '테스트'])
  assert.deepEqual(kind('cargo test --lib'), ['test', 'cargo-test', '테스트'])
  assert.deepEqual(kind('go test ./...'), ['test', 'go-test', '테스트'])
  assert.deepEqual(kind('bun test'), ['test', 'bun-test', '테스트'])
  assert.deepEqual(kind('npx playwright test'), ['test', 'playwright', '테스트'])
  assert.deepEqual(kind('npm ci'), ['install', null, '설치'])
  assert.deepEqual(kind('git status --short'), ['git', null, 'git'])
  assert.deepEqual(kind("sed -n '1,40p' src/a.js"), ['read', null, '파일 읽기'])
  assert.deepEqual(kind('rg -n "TODO" src'), ['search', null, '검색'])
  assert.deepEqual(kind('npm run build && npm test'), ['test', null, '테스트'], 'the strongest step wins')
  assert.deepEqual(kind("bash -lc 'echo hi'"), ['other', null, '명령'])
  assert.deepEqual(kind('./tool --x', { commandActions: [{ type: 'read', command: 'x', name: 'a', path: '/a' }] }), ['read', null, '파일 읽기'])
  assert.equal(Run.unwrapShellCommand("/bin/zsh -lc 'echo '\\''hi'\\'''"), "echo 'hi'")
  assert.equal(Run.unwrapShellCommand(`/bin/bash -c 'echo '"'"'x'"'"''`), "echo 'x'")
  assert.deepEqual(Run.splitShellSegments('a && b || c; d | e "x && y"'), ['a', 'b', 'c', 'd', 'e "x && y"'])
})

test('commandDisplay drops the shell wrapper and leading cd, masks tokens and stays short', () => {
  assert.equal(Run.commandDisplay("/bin/zsh -lc 'cd /work/proj && npm test'"), 'npm test')
  assert.equal(Run.commandDisplay('curl -H "Authorization: Bearer abcdefghijklmnop" x'), 'curl -H "Authorization: Bearer •••" x')
  assert.equal(Run.commandDisplay(`echo ${'x'.repeat(300)}`).length, 201)
})

// Real `node --test` (v24.11.1) output, captured on this machine; only the path was replaced.
const NODE_SPEC = `✔ adds numbers (0.235375ms)
✖ subtracts numbers (0.28075ms)
﹣ skipped one (0.028584ms) # SKIP
✔ multiplies (0.029792ms)
ℹ tests 4
ℹ suites 0
ℹ pass 2
ℹ fail 1
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 28.148125

✖ failing tests:

test at test/math.test.mjs:4:1
✖ subtracts numbers (0.28075ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  2 !== 1

      at TestContext.<anonymous> (file:///work/proj/test/math.test.mjs:4:42)
      at Test.runInAsyncScope (node:async_hooks:214:14)
      at Test.run (node:internal/test_runner/test:1106:25)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:358:3) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 2,
    expected: 1,
    operator: 'strictEqual',
    diff: 'simple'
  }
`

// Real `node --test --test-reporter=tap` (v24.11.1) output; only the path was replaced.
const NODE_TAP = `TAP version 13
# Subtest: adds numbers
ok 1 - adds numbers
  ---
  duration_ms: 0.231875
  type: 'test'
  ...
# Subtest: subtracts numbers
not ok 2 - subtracts numbers
  ---
  duration_ms: 0.417958
  type: 'test'
  location: '/work/proj/test/math.test.mjs:4:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    2 !== 1

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  stack: |-
    TestContext.<anonymous> (file:///work/proj/test/math.test.mjs:4:42)
    Test.runInAsyncScope (node:async_hooks:214:14)
  ...
# Subtest: skipped one
ok 3 - skipped one # SKIP
  ---
  duration_ms: 0.03825
  type: 'test'
  ...
1..4
# tests 4
# suites 0
# pass 2
# fail 1
# cancelled 0
# skipped 1
# todo 0
# duration_ms 28.0165
`

test('node --test (spec and TAP): counts, failing test, message and the project line', () => {
  const spec = Run.summarizeRunResult({ command: "/bin/zsh -lc 'node --test test/'", exitCode: 1, status: 'failed', durationMs: 412, cwd: ROOT, projectRoot: ROOT, output: NODE_SPEC })
  assert.deepEqual([spec.kind, spec.runner, spec.outcome], ['test', 'node-test', 'failed'])
  assert.deepEqual(spec.counts, { passed: 2, failed: 1, skipped: 1, todo: 0, total: 4, unit: 'test' })
  assert.equal(spec.headline, '2 통과 · 1 실패 · 1 건너뜀')
  assert.equal(spec.failures.length, 1)
  assert.equal(spec.failures[0].name, 'subtracts numbers')
  assert.equal(spec.failures[0].message, 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:')
  assert.deepEqual(spec.failures[0].location, { path: `${ROOT}/test/math.test.mjs`, relativePath: 'test/math.test.mjs', line: 4, column: 42, label: 'test/math.test.mjs:4:42', inProject: true })
  assert.equal(spec.firstLocation, spec.failures[0].location)
  assert.equal(spec.durationLabel, '0.4초')
  assert.equal(spec.command, 'node --test test/')
  const tap = Run.summarizeRunResult({ command: 'node --test --test-reporter=tap test/', exitCode: 1, cwd: ROOT, projectRoot: ROOT, output: NODE_TAP })
  assert.deepEqual(tap.counts, spec.counts)
  assert.equal(tap.failures[0].name, 'subtracts numbers')
  assert.equal(tap.failures[0].message, 'Expected values to be strictly equal:')
  assert.equal(tap.failures[0].location.label, 'test/math.test.mjs:4:1')
})

// The fixtures below are hand-written from each runner's documented output format.
const JEST = `FAIL src/math.test.js
  math
    ✓ adds (2 ms)
    ✕ subtracts (3 ms)

  ● math › subtracts

    expect(received).toBe(expected) // Object.is equality

    Expected: 1
    Received: 2

      10 |   test('subtracts', () => {
    > 11 |     expect(3 - 1).toBe(1)
         |                   ^
      12 |   })

      at Object.toBe (node_modules/expect/build/index.js:1:1)
      at Object.toBe (src/math.test.js:11:19)

PASS src/other.test.js

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 12 passed, 13 total
Snapshots:   0 total
Time:        1.234 s
Ran all test suites.
`

test("jest: '12 통과 · 1 실패' and the first project frame (node_modules skipped)", () => {
  const result = Run.summarizeRunResult({ command: 'npm test', exitCode: 1, cwd: ROOT, projectRoot: ROOT, output: JEST })
  assert.deepEqual([result.kind, result.runner, result.headline], ['test', 'jest', '12 통과 · 1 실패'])
  assert.deepEqual(result.counts, { passed: 12, failed: 1, skipped: 0, todo: 0, total: 13, unit: 'test' })
  assert.deepEqual(result.failures.map(failure => [failure.name, failure.message, failure.location?.label]), [
    ['math › subtracts', 'expect(received).toBe(expected) // Object.is equality', 'src/math.test.js:11:19']])
  assert.equal(Run.runResultTitle(result), '테스트 · npm test')
  assert.equal(Run.runResultAriaLabel(result), '테스트 결과: 12 통과 · 1 실패, 첫 실패 위치 src/math.test.js 11행')
})

const VITEST = ` ❯ src/math.test.ts (2 tests | 1 failed) 5ms
   ✓ math > adds 1ms
   × math > subtracts 3ms
     → expected 2 to be 1 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/math.test.ts > math > subtracts
AssertionError: expected 2 to be 1 // Object.is equality

- Expected
+ Received

 ❯ src/math.test.ts:9:19
      7|   })
      8|   it('subtracts', () => {
      9|     expect(3 - 1).toBe(1)
       |                   ^

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Start at  10:00:00
   Duration  300ms
`

const MOCHA = `
  math
    ✔ adds
    1) subtracts


  1 passing (5ms)
  1 failing

  1) math
       subtracts:

      AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

2 !== 1

      at Context.<anonymous> (test/math.spec.js:9:12)
      at process.processImmediate (node:internal/timers:483:21)
`

const PYTEST = `============================= test session starts ==============================
platform darwin -- Python 3.12.0, pytest-8.3.0, pluggy-1.5.0
rootdir: /work/proj
collected 3 items

tests/test_math.py .F.                                                   [100%]

=================================== FAILURES ===================================
________________________________ test_subtract _________________________________

    def test_subtract():
>       assert 3 - 1 == 1
E       assert 2 == 1

tests/test_math.py:7: AssertionError
=========================== short test summary info ============================
FAILED tests/test_math.py::test_subtract - assert 2 == 1
========================= 1 failed, 2 passed in 0.03s ==========================
`

const CARGO = `running 2 tests
test tests::adds ... ok
test tests::subtracts ... FAILED

failures:

---- tests::subtracts stdout ----

thread 'tests::subtracts' panicked at src/lib.rs:12:9:
assertion \`left == right\` failed
  left: 2
 right: 1

failures:
    tests::subtracts

test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests proj

running 1 test
test src/lib.rs - add (line 3) ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s
`

const GO_VERBOSE = `=== RUN   TestAdd
--- PASS: TestAdd (0.00s)
=== RUN   TestSubtract
    math_test.go:12: expected 1, got 2
--- FAIL: TestSubtract (0.00s)
FAIL
FAIL	example.com/proj/math	0.005s
FAIL
`

const PLAYWRIGHT = `Running 3 tests using 1 worker

  ✓  1 [chromium] › tests/home.spec.ts:3:5 › home loads (1.2s)
  ✘  2 [chromium] › tests/home.spec.ts:8:5 › login works (3.4s)
  ✓  3 [chromium] › tests/home.spec.ts:15:5 › logout (0.9s)


  1) [chromium] › tests/home.spec.ts:8:5 › login works ─────────────────────────────

    Error: expect(locator).toBeVisible() failed

    Locator: getByText('Welcome')

      10 |   await page.click('text=Login')
    > 11 |   await expect(page.getByText('Welcome')).toBeVisible()
         |                                           ^

        at /work/proj/tests/home.spec.ts:11:43

  1 failed
    [chromium] › tests/home.spec.ts:8:5 › login works ──────────────────────────────
  2 passed (6.1s)
`

const BUN = `src/math.test.ts:
✓ adds [0.12ms]
1 | import { test, expect } from "bun:test";
2 | test("subtracts", () => {
3 |   expect(3 - 1).toBe(1);
                    ^
error: expect(received).toBe(expected)

Expected: 1
Received: 2

      at <anonymous> (/work/proj/src/math.test.ts:3:17)
(fail) subtracts [0.31ms]

 1 pass
 1 fail
 2 expect() calls
Ran 2 tests across 1 file. [12.00ms]
`

test('vitest, mocha, pytest, cargo, go -v, playwright, bun: counts and the failing line', () => {
  const run = (command, output) => Run.summarizeRunResult({ command, exitCode: 1, cwd: ROOT, projectRoot: ROOT, output })
  const rows = [
    ['npx vitest run', VITEST, 'vitest', '1 통과 · 1 실패', 'src/math.test.ts > math > subtracts', 'AssertionError: expected 2 to be 1 // Object.is equality', 'src/math.test.ts:9:19'],
    ['npx mocha', MOCHA, 'mocha', '1 통과 · 1 실패', 'math › subtracts', 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:', 'test/math.spec.js:9:12'],
    ['pytest -q', PYTEST, 'pytest', '2 통과 · 1 실패', 'tests/test_math.py::test_subtract', 'assert 2 == 1', 'tests/test_math.py:7'],
    ['cargo test', CARGO, 'cargo-test', '2 통과 · 1 실패', 'tests::subtracts', "thread 'tests::subtracts' panicked at src/lib.rs:12:9:", 'src/lib.rs:12:9'],
    ['go test -v ./...', GO_VERBOSE, 'go-test', '1 통과 · 1 실패', 'TestSubtract', 'math_test.go:12: expected 1, got 2', 'math_test.go:12'],
    ['npx playwright test', PLAYWRIGHT, 'playwright', '2 통과 · 1 실패', '[chromium] › tests/home.spec.ts:8:5 › login works', 'Error: expect(locator).toBeVisible() failed', 'tests/home.spec.ts:11:43'],
    ['bun test', BUN, 'bun-test', '1 통과 · 1 실패', 'subtracts', 'error: expect(received).toBe(expected)', 'src/math.test.ts:3:17'],
  ]
  for (const [command, output, runner, headline, name, message, label] of rows) {
    const result = run(command, output)
    assert.equal(result.runner, runner, command)
    assert.equal(Run.detectRunner(output), runner, `${command} is recognised from its output alone`)
    assert.equal(result.headline, headline, command)
    assert.equal(result.failures.length, 1, command)
    assert.equal(result.failures[0].name, name, command)
    assert.equal(result.failures[0].message, message, command)
    assert.equal(result.failures[0].location?.label, label, command)
  }
  assert.deepEqual(Run.parseRunnerCounts('ok  \texample.com/a\t0.1s\nFAIL\texample.com/b\t0.2s\n', 'go-test'), { passed: 1, failed: 1, skipped: 0, todo: 0, total: 2, unit: 'package' })
  assert.deepEqual(Run.parseRunnerCounts('FAILED | 2 passed | 1 failed (12ms)', 'deno-test'), { passed: 2, failed: 1, skipped: 0, todo: 0, total: 3, unit: 'test' })
  assert.equal(Run.summarizeRunResult({ command: 'go test ./...', exitCode: 1, output: 'ok  \texample.com/a\t0.1s\nFAIL\texample.com/b\t0.2s\n' }).headline, '패키지 1 통과 · 1 실패')
})

const TSC = `src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/b.ts:10:3 - error TS2304: Cannot find name 'foo'.

10   foo()
     ~~~

Found 2 errors in 2 files.

Errors  Files
     1  src/a.ts:3
     1  src/b.ts:10
`

const ESLINT = `
/work/proj/src/a.js
  3:7   error    'x' is assigned a value but never used  no-unused-vars
  5:1   warning  Unexpected console statement            no-console

/work/proj/src/b.js
  1:10  error  Missing semicolon  semi

✖ 3 problems (2 errors, 1 warning)
  1 error and 0 warnings potentially fixable with the \`--fix\` option.
`

test('tsc and eslint: problem counts and each error as a jump target', () => {
  const tsc = Run.summarizeRunResult({ command: 'npx tsc --noEmit', exitCode: 2, cwd: ROOT, projectRoot: ROOT, output: TSC })
  assert.deepEqual([tsc.kind, tsc.outcome, tsc.headline], ['typecheck', 'failed', '타입 오류 2개 · 파일 2개'])
  assert.deepEqual(tsc.problems, { errors: 2, warnings: 0, files: 2 })
  assert.deepEqual(tsc.failures.map(failure => [failure.name, failure.location.label]), [['TS2322', 'src/a.ts:3:5'], ['TS2304', 'src/b.ts:10:3']])
  assert.equal(tsc.failures[1].message, "Cannot find name 'foo'.")
  assert.equal(Run.parseProblemCounts('Found 1 error in src/a.ts:3\n', 'tsc').files, 1)
  const clean = Run.summarizeRunResult({ command: 'npx tsc --noEmit', exitCode: 0, output: '' })
  assert.equal(clean.headline, '타입 오류 없음')
  const lint = Run.summarizeRunResult({ command: 'npx eslint src', exitCode: 1, cwd: ROOT, projectRoot: ROOT, output: ESLINT })
  assert.deepEqual([lint.kind, lint.headline], ['lint', '문제 3개 · 오류 2 · 경고 1'])
  assert.deepEqual(lint.failures.map(failure => [failure.name, failure.message, failure.location.label]), [
    ['no-unused-vars', "'x' is assigned a value but never used", 'src/a.js:3:7'],
    ['semi', 'Missing semicolon', 'src/b.js:1:10'],
  ])
})

test('outcome and headline follow status and exit code when there are no counts', () => {
  const card = input => Run.summarizeRunResult(input)
  assert.equal(card({ command: 'npm run build', exitCode: 0, status: 'completed', output: 'built in 1.2s' }).headline, '빌드 성공')
  assert.equal(card({ command: 'npm run build', exitCode: 2, status: 'failed', output: 'Error: Cannot resolve ./x' }).headline, '빌드 실패 · 종료 코드 2')
  assert.equal(card({ command: 'npm test', status: 'inProgress', output: '' }).outcome, 'running')
  assert.equal(card({ command: 'npm test', status: 'declined' }).headline, '실행하지 않음 · 거절됨')
  assert.equal(card({ command: 'ls', exitCode: 0 }).headline, '완료')
  assert.equal(card({ command: './run.sh', exitCode: 3 }).headline, '실패 · 종료 코드 3')
  assert.equal(card({ command: 'echo', status: 'completed' }).outcome, 'unknown')
  // Coverage threshold or a wrapper can fail the run with every test passing.
  assert.equal(card({ command: 'npm test', exitCode: 1, output: 'Tests:       5 passed, 5 total\n' }).headline, '5 통과 · 종료 코드 1')
  assert.deepEqual([Run.durationLabel(65000), Run.durationLabel(120000), Run.durationLabel(NaN)], ['1분 5초', '2분', ''])
})

test("the runtime's bounded capture {head, tail, omittedBytes} is read as one output", () => {
  const head = JEST.slice(0, JEST.indexOf('PASS src/other.test.js'))
  const tail = 'Test Suites: 1 failed, 1 passed, 2 total\nTests:       1 failed, 12 passed, 13 total\n'
  const result = Run.summarizeRunResult({ command: 'npx jest', exitCode: 1, cwd: ROOT, projectRoot: ROOT, output: { head, tail, omittedBytes: 40000 } })
  assert.equal(result.headline, '12 통과 · 1 실패')
  assert.equal(result.outputTruncated, true)
  assert.equal(result.firstLocation.label, 'src/math.test.js:11:19')
  // With nothing omitted the head and tail are one stream (no line is split).
  assert.equal(Run.normalizeRunOutput({ head: 'Tests:  ', tail: '2 passed, 2 total\n', omittedBytes: 0 }).text, 'Tests:  2 passed, 2 total\n')
  assert.equal(Run.normalizeRunOutput({ head: 'abc', tail: 'def', omittedBytes: 9 }).text, 'abc\ndef')
  const packet = { itemId: 'cmd-1', head: JEST, tail: '', omittedBytes: 0, totalBytes: JEST.length, complete: true, limits: {} }
  assert.equal(Run.summarizeRunResult({ command: 'npm test', exitCode: 1, output: packet }).headline, '12 통과 · 1 실패')
})

test('a Python traceback (no runner) points at the innermost project frame', () => {
  const output = `Traceback (most recent call last):
  File "/work/proj/app/main.py", line 10, in <module>
    main()
  File "/work/proj/app/main.py", line 7, in main
    helper()
  File "/usr/lib/python3.12/site-packages/lib/x.py", line 3, in helper
    raise ValueError("bad input")
ValueError: bad input
`
  const result = Run.summarizeRunResult({ command: 'python app/main.py', exitCode: 1, cwd: ROOT, projectRoot: ROOT, output })
  assert.deepEqual([result.kind, result.outcome, result.headline], ['other', 'failed', '실패 · 종료 코드 1'])
  assert.deepEqual(result.failures, [{ name: null, message: 'ValueError: bad input', location: { path: `${ROOT}/app/main.py`, relativePath: 'app/main.py', line: 7, column: null, label: 'app/main.py:7', inProject: true } }])
})

test('locations outside the project, in node_modules or node internals are never the jump target', () => {
  const ctx = { cwd: ROOT, projectRoot: ROOT }
  assert.equal(Run.firstProjectFrame('    at x (node:internal/a:1:1)\n    at y (/work/proj/node_modules/z/i.js:3:4)\n    at w (/other/place/k.js:5:6)', ctx), null)
  assert.equal(Run.firstProjectFrame('    at q (/work/proj/src/q.js:8:2)', ctx).label, 'src/q.js:8:2')
  assert.deepEqual(Run.resolveOutputLocation('../outside/a.js', 3, 1, ctx), { path: '/work/outside/a.js', relativePath: null, line: 3, column: 1, label: '../outside/a.js:3:1', inProject: false })
  assert.equal(Run.resolveOutputLocation('https://example.com/a.js', 3, 1, ctx), null)
  assert.equal(Run.resolveOutputLocation('foo', 3, 1, ctx), null, 'a bare word is not a file')
  const win = Run.resolveOutputLocation('src\\a.ts', 4, 2, { cwd: 'C:\\work\\proj', projectRoot: 'C:\\work\\proj' })
  assert.deepEqual([win.path, win.relativePath, win.inProject], ['C:\\work\\proj\\src\\a.ts', 'src/a.ts', true])
  const noRoot = Run.resolveOutputLocation('src/a.ts', 4, null, {})
  assert.deepEqual([noRoot.path, noRoot.relativePath, noRoot.label], ['src/a.ts', 'src/a.ts', 'src/a.ts:4'])
})

test('tokens are masked in the tail and in failure messages; ANSI colour codes are removed', () => {
  const output = `\u001b[31mError: request failed with Authorization: Bearer abcdefghijklmnopqrstuvwxyz\u001b[0m
OPENAI_API_KEY=sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA
    at call (/work/proj/src/api.js:4:2)
`
  const result = Run.summarizeRunResult({ command: 'node src/api.js', exitCode: 1, cwd: ROOT, projectRoot: ROOT, output })
  for (const text of [result.tail, result.failures[0].message]) {
    assert.equal(text.includes('abcdefghijklmnop'), false)
    assert.equal(text.includes('sk-proj-AAAA'), false)
    assert.equal(text.includes('\u001b'), false)
  }
  assert.equal(result.failures[0].location.label, 'src/api.js:4:2')
  assert.equal(Run.maskSecrets('token=ghp_abcdefghijklmnopqrstuvwxyz0123'), 'token=•••')
})

test('large or pathological output stays bounded and fast', () => {
  const long = `${'a/'.repeat(60000)}:1:2\n`
  const many = `${'    at f (/work/proj/src/x.js:1:1)\n'.repeat(4000)}${JEST}`
  const started = Date.now()
  const result = Run.summarizeRunResult({ command: 'npm test', exitCode: 1, cwd: ROOT, projectRoot: ROOT, output: long + many + 'z'.repeat(400000) + JEST })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 3000, `took ${elapsed}ms`)
  assert.equal(result.outputTruncated, true)
  assert.equal(result.headline, '12 통과 · 1 실패')
  assert.ok(result.tail.length <= Run.RUN_RESULT_LIMITS.tailChars + 1)
  assert.ok(result.failures.length <= Run.RUN_RESULT_LIMITS.maxFailures)
  // Lines are cut to maxLineChars before the link regexes run; the worst shapes stay quick.
  const worst = ['a/'.repeat(1000), 'a:1 '.repeat(500), 'a.'.repeat(1000) + ':1', 'C:\\' + 'a\\'.repeat(998), '"a", line 1, '.repeat(150)]
  for (const line of worst) {
    for (const os of ['linux', 'windows']) {
      const begin = Date.now()
      Run.detectLinks(line.slice(0, Run.RUN_RESULT_LIMITS.maxLineChars), os)
      assert.ok(Date.now() - begin < 250, `${line.slice(0, 12)}… on ${os}`)
    }
  }
  const errorish = Array.from({ length: 4000 }, () => `Error ${'a/'.repeat(997)}`).join('\n')
  const begin = Date.now()
  assert.equal(Run.summarizeRunResult({ command: './x', exitCode: 1, cwd: ROOT, projectRoot: ROOT, output: errorish }).failures.length, 1)
  assert.ok(Date.now() - begin < 1500)
})

test('renderRunResultCard: headline, failure buttons that open the line, and a collapsed tail', () => {
  const result = Run.summarizeRunResult({ command: 'npm test', exitCode: 1, durationMs: 3200, cwd: ROOT, projectRoot: ROOT, output: JEST })
  const opened = []
  const card = Run.renderRunResultCard({ document: fakeDocument, result, onOpenLocation: location => opened.push(location) })
  assert.equal(card.className, 'egdesk-run-result')
  assert.equal(card.getAttribute('data-outcome'), 'failed')
  assert.equal(card.getAttribute('data-kind'), 'test')
  assert.equal(all(card, 'egdesk-run-result-kind')[0].textContent, '테스트')
  assert.equal(all(card, 'egdesk-run-result-headline')[0].textContent, '12 통과 · 1 실패')
  assert.equal(all(card, 'egdesk-run-result-command')[0].textContent, 'npm test')
  assert.equal(all(card, 'egdesk-run-result-duration')[0].textContent, '3.2초')
  assert.equal(all(card, 'egdesk-run-result-exit')[0].textContent, '종료 코드 1')
  const button = all(card, 'egdesk-run-result-location')[0]
  assert.equal(button.tagName, 'BUTTON')
  assert.equal(button.textContent, 'src/math.test.js:11:19')
  button.click()
  assert.deepEqual(opened.map(location => [location.path, location.line, location.column]), [[`${ROOT}/src/math.test.js`, 11, 19]])
  const output = all(card, 'egdesk-run-result-output')[0]
  assert.equal(output.tagName, 'DETAILS')
  assert.equal(Boolean(output.open), false)
  assert.match(all(card, 'egdesk-run-result-tail')[0].textContent, /Ran all test suites\.$/)
  const passive = Run.renderRunResultCard({ document: fakeDocument, result })
  assert.equal(all(passive, 'egdesk-run-result-location')[0].tagName, 'SPAN', 'no handler, no button')
  const passed = Run.renderRunResultCard({ document: fakeDocument, result: Run.summarizeRunResult({ command: 'npm run build', exitCode: 0 }) })
  assert.equal(all(passed, 'egdesk-run-result-failures').length, 0)
  assert.equal(all(passed, 'egdesk-run-result-output').length, 0)
})

test('runResultFromCodexItem reads a Codex commandExecution item', () => {
  const item = { type: 'commandExecution', id: 'i1', command: "/bin/zsh -lc 'npx jest'", cwd: ROOT, exitCode: 1, durationMs: 1500, status: 'failed', aggregatedOutput: JEST, commandActions: [{ type: 'unknown', command: 'npx jest' }] }
  const result = Run.runResultFromCodexItem(item, { projectRoot: ROOT })
  assert.deepEqual([result.kind, result.runner, result.headline, result.firstLocation.label, result.durationLabel], ['test', 'jest', '12 통과 · 1 실패', 'src/math.test.js:11:19', '1.5초'])
  const fromCapture = Run.runResultFromCodexItem({ ...item, aggregatedOutput: null }, { projectRoot: ROOT, output: { head: '', tail: JEST } })
  assert.equal(fromCapture.headline, '12 통과 · 1 실패')
})
