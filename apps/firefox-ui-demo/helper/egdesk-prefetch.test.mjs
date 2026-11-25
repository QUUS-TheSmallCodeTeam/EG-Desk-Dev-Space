// L7 c37: prefetch of the working folder's files through the context selection (flag EGDESK_TURN_MEMORY_PREFETCH=files, default off).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PREFETCH_LIMITS, listWorkspaceFiles, readWorkspaceFile, workspaceCandidates } from './egdesk-prefetch.mjs'
import { allOnWorld, scriptedDecisions } from '../scripts/egdesk-all-on.support.mjs'

const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-prefetch-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir }
const put = (dir, rel, text) => { const full = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text); return full }

test('listing: text-like files only, newest first, bounded; no dot or build folders, no symlinks, no empty, binary-named or oversized files; three folder levels', async t => {
  const dir = tmp(t)
  put(dir, 'notes/a.md', 'a'); put(dir, 'notes/b.md', 'bb'); put(dir, 'src/price.mjs', 'export const p = 1'); put(dir, 'deep/1/2/ok.md', 'x'); put(dir, 'deep/1/2/3/too-deep.md', 'x')
  put(dir, '.git/config', 'x'); put(dir, '.hidden.md', 'x'); put(dir, 'node_modules/m/index.js', 'x'); put(dir, 'dist/out.js', 'x'); put(dir, 'logo.png', 'x'); put(dir, 'empty.md', ''); put(dir, 'package-lock.json', '{}')
  put(dir, 'huge.md', 'x'.repeat(PREFETCH_LIMITS.maxFileBytes + 1)); fs.symlinkSync(path.join(dir, 'notes/a.md'), path.join(dir, 'link.md'))
  const old = new Date('2026-01-01'); fs.utimesSync(path.join(dir, 'notes/a.md'), old, old)
  const files = await listWorkspaceFiles(dir)
  assert.deepEqual(files.map(f => f.rel).sort(), ['deep/1/2/ok.md', 'notes/a.md', 'notes/b.md', 'src/price.mjs'])
  assert.equal(files.at(-1).rel, 'notes/a.md', 'the oldest last'); assert.deepEqual(await listWorkspaceFiles(path.join(dir, 'nope')), [])
  for (let i = 0; i < 80; i++) put(dir, `many/f${String(i).padStart(2, '0')}.txt`, 'x')
  assert.equal((await listWorkspaceFiles(dir)).length, PREFETCH_LIMITS.maxFiles)
})

test('reading: the text of an unchanged regular file inside the folder; null when it changed, left the folder, is binary, or is gone', async t => {
  const dir = tmp(t), outside = tmp(t)
  put(dir, 'a.md', '# 제목\n본문'); put(dir, 'bin.txt', 'ab\0cd'); put(outside, 'secret.md', 'secret')
  const [a] = (await listWorkspaceFiles(dir)).filter(f => f.rel === 'a.md'), [bin] = (await listWorkspaceFiles(dir)).filter(f => f.rel === 'bin.txt')
  assert.equal(await readWorkspaceFile(dir, a), '# 제목\n본문'); assert.equal(await readWorkspaceFile(dir, bin), null)
  fs.writeFileSync(path.join(dir, 'a.md'), 'changed after the listing'); assert.equal(await readWorkspaceFile(dir, a), null, 'changed since the listing')
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(dir, 'esc.md'))
  assert.equal(await readWorkspaceFile(dir, { rel: 'esc.md', size: 6, mtimeMs: 0 }), null, 'a link out of the folder')
  assert.equal(await readWorkspaceFile(dir, { rel: '../x.md', size: 1, mtimeMs: 0 }), null); fs.rmSync(path.join(dir, 'a.md')); assert.equal(await readWorkspaceFile(dir, a), null)
  put(dir, 'long.md', 'ㄱ'.repeat(30000)); const [long] = (await listWorkspaceFiles(dir)).filter(f => f.rel === 'long.md')
  assert.ok(Buffer.byteLength(await readWorkspaceFile(dir, long)) <= PREFETCH_LIMITS.readBytes, 'the read is capped')
})

test('candidates: one unguarded document per file, catalog line = path, size and date only; the text is read when asked', async t => {
  const dir = tmp(t); put(dir, 'docs/spec.md', '납기는 12월 9일이다.')
  const [c] = await workspaceCandidates(dir)
  assert.deepEqual({ id: c.id, kind: c.kind, title: c.title, timeSlice: c.timeSlice, guarded: 'mayRead' in c }, { id: 'workspace:docs/spec.md', kind: 'document', title: 'docs/spec.md', timeSlice: 'present', guarded: false })
  assert.match(c.summary, /^\d+ bytes, \d{4}-\d{2}-\d{2}$/); assert.ok(!c.summary.includes('납기')); assert.equal(await c.loadText(), '납기는 12월 9일이다.')
})

// The decision model stand-in: a catalog item is needed when its path is named in the message; everything else is the all-on scripted model's.
function transport() {
  const scripted = scriptedDecisions(), seen = []
  return { seen, fn: async ({ wire }) => {
    const answers = await scripted.answer(wire)
    if (wire.questions.some(q => q.name === 'answer_type')) {
      const text = JSON.stringify(wire.input), catalog = /Catalog:\\n([\s\S]*?)"\}/.exec(text)?.[1].replace(/\\n/g, '\n') ?? '', message = /Message:\\n([\s\S]*?)"\}\]|Message:\\n(.*)$/.exec(text)?.[0] ?? ''
      seen.push(catalog)
      return { status: 200, json: { answers: answers.map(a => { const m = /^rel_(\d+)$/.exec(a.name); if (!m) return a; const line = new RegExp(`#${m[1]} \\|[^\\n]*`).exec(catalog)?.[0] ?? ''; const named = /workspace|\.md|\.mjs/.test(line) && message.includes(line.split(' | ')[3] ?? '\u0000'); return { ...a, probability: named ? 0.97 : 0.02 } }), usage: { input_tokens: 10 } } }
    }
    return { status: 200, json: { answers, usage: { input_tokens: 10 } } }
  } }
}
const decisionText = w => Object.values(w.turnStarts().at(-1).params.additionalContext ?? {}).map(v => v.value).join('\n')

test('through the runtime: the picked file reaches the engine in the turn context, the others only as catalog lines for the decision model; flag off: no workspace candidate at all', async t => {
  const dir = tmp(t); void dir
  const run = async env => {
    const tr = transport(), w = allOnWorld(t, { env, transport: tr.fn })
    put(w.cwd, 'docs/spec.md', '납기는 12월 9일이다. 담당은 한유진.'); put(w.cwd, 'docs/other.md', '점심 메뉴는 비빔밥.')
    await w.settings.turnMemory.save('on'); await w.send('docs/spec.md 에서 납기가 언제야?')
    return { w, tr }
  }
  const on = await run({ EGDESK_TURN_MEMORY_PREFETCH: 'files' }), off = await run({})
  assert.match(on.tr.seen.at(-1), /document \| time=present \| docs\/spec\.md \| \d+ bytes, \d{4}-\d{2}-\d{2}/); assert.match(on.tr.seen.at(-1), /docs\/other\.md/)
  assert.ok(!on.tr.seen.at(-1).includes('12월 9일') && !on.tr.seen.at(-1).includes('비빔밥'), 'no file text goes to the decision model')
  const sent = decisionText(on.w)
  assert.match(sent, /\[item id=workspace:docs\/spec\.md /); assert.ok(sent.includes('납기는 12월 9일이다. 담당은 한유진.')); assert.ok(!sent.includes('비빔밥'), 'a file below the bar is not attached: the engine reads it as today')
  assert.ok(!off.tr.seen.at(-1).includes('docs/spec.md')); assert.ok(!decisionText(off.w).includes('12월 9일'))
})

test('egress: the listing is offered only to a run whose Agent ceiling does not shut both terminal and files; an unbound folder offers nothing', async t => {
  const dir = tmp(t); put(dir, 'a.md', 'x')
  const w = allOnWorld(t, { env: { EGDESK_TURN_MEMORY_PREFETCH: 'files' } })
  assert.equal((await w.chat.prefetchCandidates({ prefetchFolder: dir })).length, 1)
  assert.equal((await w.chat.prefetchCandidates({ prefetchFolder: dir, profileRun: { toolCeiling: { terminal: 'none', files: 'none' } } })).length, 0)
  assert.equal((await w.chat.prefetchCandidates({ prefetchFolder: dir, profileRun: { toolCeiling: { terminal: 'none', files: 'allow' } } })).length, 1)
  assert.deepEqual(await w.chat.prefetchCandidates({ prefetchFolder: null }), []); assert.deepEqual(await w.chat.prefetchCandidates({}), [])
  const off = allOnWorld(t, { env: {} }); assert.deepEqual(await off.chat.prefetchCandidates({ prefetchFolder: dir }), [])
})
