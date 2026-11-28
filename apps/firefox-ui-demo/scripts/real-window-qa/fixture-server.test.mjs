import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'
import { rewriteFixtureUrls, spawnFixtureServer, startFixtureServer, decodeDataUrl, isDataUrl } from './fixture-server.mjs'
import { CASES as RWS } from './cases-rws.mjs'; import { CASES as ALL } from './cases.mjs'
const get = (port, p) => new Promise((res, bad) => http.get({ host: '127.0.0.1', port, path: p }, m => { const b = []; m.on('data', d => b.push(d)); m.on('end', () => res({ status: m.statusCode, type: m.headers['content-type'], body: Buffer.concat(b) })) }).on('error', bad))
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'egd-fx-')), PORT = 18770 + Math.floor(Math.random() * 500)
test('rws cases: data: urls become http urls and files hold the exact UTF-8 html', () => {
  const dir = tmp()
  for (const [id, c] of Object.entries(RWS)) {
    const { c: r, files } = rewriteFixtureUrls(c, id, { dir, port: PORT }); assert.ok(files.length >= 1, id)
    assert.equal(r.url, `http://127.0.0.1:${PORT}/${id}.html`); assert.ok(!isDataUrl(r.url))
    assert.equal(fs.readFileSync(path.join(dir, files[0]), 'utf8'), decodeDataUrl(c.url).buf.toString('utf8')); assert.ok(fs.readFileSync(path.join(dir, files[0]), 'utf8').includes('<meta charset="utf-8">'))
    if (c.also) { assert.equal(files.length, 2, id); assert.equal(r.also.url, `http://127.0.0.1:${PORT}/${id}-2.html`); assert.equal(r.also.card, c.also.card); assert.match(fs.readFileSync(path.join(dir, files[1]), 'utf8'), /테스트 서버/) }
    assert.deepEqual(r.checks, c.checks); assert.equal(r.msg, c.msg)
  }
})
test('case 21 (change fixture) is rewritten; numeric http cases are untouched', () => {
  const dir = tmp(), { c, files } = rewriteFixtureUrls(ALL[21], 21, { dir, port: PORT })
  assert.deepEqual(files, ['21.html']); assert.equal(c.url, `http://127.0.0.1:${PORT}/21.html`); assert.match(fs.readFileSync(path.join(dir, '21.html'), 'utf8'), /변화 폼/)
  for (const [id, x] of Object.entries(ALL)) { if (isDataUrl(x.url) || isDataUrl(x.then) || isDataUrl(x.also?.url)) continue; const r = rewriteFixtureUrls(x, id, { dir }); assert.deepEqual(r.files, [], id); assert.deepEqual(r.c, x, id) }
  assert.deepEqual(fs.readdirSync(dir), ['21.html'])
})
test('then url is rewritten too', () => { const d = 'data:text/html;charset=utf-8,%3Cp%3E%ED%95%9C%3C%2Fp%3E', { c, files } = rewriteFixtureUrls({ url: 'https://x.test/', then: d }, 'z', { dir: tmp(), port: PORT }); assert.equal(c.url, 'https://x.test/'); assert.equal(c.then, `http://127.0.0.1:${PORT}/z.html`); assert.deepEqual(files, ['z.html']) })
test('server serves UTF-8 files, 404 for escapes, reuses a running one (child process)', async () => {
  const dir = tmp(); fs.writeFileSync(path.join(dir, 'a.html'), '<meta charset="utf-8"><p>한글</p>')
  const s1 = await spawnFixtureServer({ dir, port: PORT }); assert.equal(s1.reused, false)
  try {
    const r = await get(PORT, '/a.html'); assert.equal(r.status, 200); assert.match(r.type, /utf-8/); assert.match(r.body.toString('utf8'), /한글/)
    assert.equal((await get(PORT, '/../etc/passwd')).status, 404); assert.equal((await get(PORT, '/nope.html')).status, 404)
    const s2 = await spawnFixtureServer({ dir, port: PORT }); assert.equal(s2.reused, true); await s2.stop(); assert.equal((await get(PORT, '/a.html')).status, 200)
  } finally { await s1.stop() }
  await new Promise(r => setTimeout(r, 300)); await assert.rejects(get(PORT, '/a.html'))
})
