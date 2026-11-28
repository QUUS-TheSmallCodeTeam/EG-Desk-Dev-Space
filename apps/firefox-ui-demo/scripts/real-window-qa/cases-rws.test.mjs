import test from 'node:test'; import assert from 'node:assert/strict'; import vm from 'node:vm'
import { CASES } from './cases-rws.mjs'
const ids = Object.keys(CASES)
const urls = c => [c.url, c.also?.url].filter(Boolean)
const decode = u => decodeURIComponent(u.slice(u.indexOf(',') + 1))
const RWS = /^RWS-00(0[5-9]|[1-3]\d)$/
test('set size and ids', () => { assert.ok(ids.length >= 10 && ids.length <= 15, String(ids.length)); for (const id of ids) assert.match(id, /^rws-\d\d$/) })
test('case structure', () => {
  for (const [id, c] of Object.entries(CASES)) {
    for (const k of ['name', 'card', 'url', 'msg', 'expected']) assert.equal(typeof c[k], 'string', `${id}.${k}`)
    assert.ok(c.name && c.msg && c.expected, id); assert.match(c.card, /^egd-browser-card-\d+$/, id)
    assert.ok(Array.isArray(c.rws) && c.rws.length && c.rws.every(r => RWS.test(r)), `${id} rws`)
    assert.ok(Array.isArray(c.patterns) && c.patterns.length, `${id} patterns`); assert.ok(Array.isArray(c.handoffs), `${id} handoffs`)
    assert.ok((c.checks?.length || 0) + (c.alsoChecks?.length || 0) > 0, `${id} has no page check`)
    if (c.follow) assert.equal(typeof c.follow, 'string', id)
    if (c.also) { assert.match(c.also.card, /^egd-browser-card-\d+$/, id); assert.notEqual(c.also.card, c.card, id); assert.ok(c.alsoChecks?.length, id) }
    if (c.person) assert.ok(['pause-card', 'allow-site', 'touch-card', 'allow-site-follow'].includes(c.person), id)
    for (const k of ['answerRe', 'answerNotRe']) if (c[k]) new RegExp(c[k])
  }
})
test('data: urls are valid, ASCII-only and UTF-8 with meta charset', () => {
  for (const [id, c] of Object.entries(CASES)) for (const u of urls(c)) {
    assert.match(u, /^data:text\/html;charset=utf-8,/, id); assert.ok(/^[\x21-\x7e]+$/.test(u), `${id} non-ascii/space in url`); assert.ok(!/[!'()*]/.test(u), `${id} unescaped sub-delim`)
    const html = decode(u); assert.ok(html.includes('<meta charset="utf-8">'), id); assert.ok(/[가-힣]/.test(html), `${id} korean ui`)
    assert.ok(u.length < 20000, `${id} url too long ${u.length}`)
  }
})
test('inline scripts and check expressions parse', () => {
  for (const [id, c] of Object.entries(CASES)) {
    for (const u of urls(c)) for (const m of decode(u).matchAll(/<script>([^]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(m[1]), `${id} fixture script`)
    for (const e of [...(c.checks || []), ...(c.alsoChecks || [])]) assert.doesNotThrow(() => new vm.Script(`(${e})`), `${id}: ${e}`)
  }
})
test('no real-looking personal data', () => {
  for (const [id, c] of Object.entries(CASES)) { const t = JSON.stringify(c) + urls(c).map(decode).join(''); assert.ok(!/@[a-z0-9-]+\.(com|co\.kr|net)/i.test(t), id); assert.ok(!/\d{6}-\d{7}/.test(t), id); assert.ok(!/010-(?!0000-1234)\d{4}-\d{4}/.test(t), id) }
})
test('rws-13 is a plain two-turn chat case; rws-15 uses a positive-claim regex', () => { assert.ok(CASES['rws-13'].follow && !CASES['rws-13'].person); assert.ok(CASES['rws-15'].answerNotRe.includes('승인')) })
test('pattern coverage', () => { const all = ids.flatMap(i => CASES[i].patterns).join(' '); for (const p of ['save-vs-submit', 'modal', 'new window', 'event-driven wait', 'rich-text', 'upload', 'session expiry', 'changing page', 'identity', 'person-only']) assert.ok(all.includes(p), p) })
