// CODE-04: the vendored CodeMirror 6 bundle and the File view editor adapter
// (EGDeskCodeEditor) with its textarea fallback.
// Run: node --test apps/firefox-ui-demo/scripts/egdesk-code-editor.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'

const resources = new URL('../overlay/resources/', import.meta.url)
const vendor = new URL('vendor/', resources)

// ============================ vendor / licences ============================

test('vendored CodeMirror bundle is byte-identical to its VENDOR.md record', () => {
  const record = readFileSync(new URL('VENDOR.md', vendor), 'utf8')
  assert.match(record, /\| CodeMirror 6 \(`codemirror` 묶음\) \| 6\.0\.2 .*\| MIT \|/)
  const listed = new Map([...record.matchAll(/^\| `(codemirror\/[^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map(([, file, hash]) => [file, hash]))
  const files = readdirSync(new URL('codemirror/', vendor)).map(name => `codemirror/${name}`).sort()
  assert.deepEqual(files, [...listed.keys()].sort(), 'every vendored file is listed, and nothing else is there')
  for (const file of files) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(file, vendor))).digest('hex'), listed.get(file), `${file} is unmodified`)
  }
  // Every directly pinned package and its exact version is recorded.
  for (const [name, version] of [['codemirror', '6.0.2'], ['@codemirror/state', '6.7.6'], ['@codemirror/view', '6.43.15'], ['@codemirror/commands', '6.11.1'],
    ['@codemirror/language', '6.13.1'], ['@codemirror/search', '6.7.2'], ['@codemirror/lang-javascript', '6.2.5'], ['@codemirror/lang-json', '6.0.2'],
    ['@codemirror/lang-css', '6.3.1'], ['@codemirror/lang-html', '6.4.12'], ['@codemirror/lang-markdown', '6.5.2'], ['@codemirror/lang-python', '6.2.1']]) {
    assert.ok(record.includes(`| \`${name}\` | ${version} | MIT |`), `${name}@${version} recorded`)
    assert.ok(record.includes(`${name}@${version}`), `${name}@${version} in the rebuild command`)
  }
  assert.match(record, /esbuild entry\.mjs --bundle --format=esm --minify --legal-comments=none/)
  const licence = readFileSync(new URL('codemirror/LICENSE', vendor), 'utf8')
  assert.match(licence, /==== @codemirror\/view@6\.43\.15 ====\nMIT License\n\nCopyright \(C\) 2018-2021 by Marijn Haverbeke/)
  assert.equal((licence.match(/^==== /gm) || []).length, 26)
})

test('the bundle is self-contained browser ESM that exports what the adapter needs', async () => {
  const source = readFileSync(new URL('codemirror/codemirror.bundle.mjs', vendor), 'utf8')
  assert.equal(/\brequire\(|from ['"]node:|^import\b|\bimport\(/m.test(source), false, 'no imports of any kind')
  const bundle = await import(new URL('codemirror/codemirror.bundle.mjs', vendor).href)
  for (const name of ['EditorState', 'EditorView', 'Compartment', 'lineNumbers', 'history', 'undo', 'redo', 'search', 'openSearchPanel', 'searchKeymap',
    'syntaxHighlighting', 'HighlightStyle', 'tags', 'javascript', 'json', 'css', 'html', 'markdown', 'python']) {
    assert.ok(bundle[name], `exports ${name}`)
  }
})
