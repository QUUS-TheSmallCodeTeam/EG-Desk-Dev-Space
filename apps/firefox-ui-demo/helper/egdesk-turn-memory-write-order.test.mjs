// Which pages the write judgment may name in a long session (writeCandidateOrder). L2's dry run: judgeTurnWrite reads the first 8, and the
// list was this turn's picks then the held pages in delivery order, so the page a remark is about could be 9th and not recordable.
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeCandidateOrder } from './egdesk-turn-memory.mjs'

const page = (id, title) => ({ id, title, body: `${title} 본문`, time: { slice: 'past' }, status: 'done', provenance: 'own_record', boardIds: [] })
const ids = list => list.map(p => p.id)
const held = Array.from({ length: 12 }, (_, i) => `ontology:p${i}`)
const pages = new Map([...held.map((id, i) => [id, page(id, `기록 ${i}번 항목`)]), ['ontology:roll', page('ontology:roll', '롤백 절차')]])

test('up to the cap the list (and so the request) is the old one: picks, then held pages in delivery order', () => {
  const out = writeCandidateOrder({ message: '아무 말', picks: ['ontology:p5'], held: held.slice(0, 7), pages })
  assert.deepEqual(ids(out), ['ontology:p5', ...held.slice(0, 7).filter(id => id !== 'ontology:p5')])
})

test('over the cap: picks, then held pages the message names, then the previous reply\'s pages, then the most recent held pages', () => {
  const longHeld = ['ontology:roll', ...held] // the named page was delivered first: 13th of 13 in the old order
  const old = [...new Set(longHeld)].slice(0, 8)
  assert.ok(!old.includes('ontology:p11'))
  const out = writeCandidateOrder({ message: '롤백 절차는 끝났어', picks: [], held: [...held, 'ontology:roll'], previous: ['ontology:p0'], pages })
  assert.equal(out.length, 8)
  assert.ok(ids(out).includes('ontology:roll'), 'the page the message names stays although it is 13th')
  assert.ok(ids(out).includes('ontology:p0'), 'the previous reply\'s page stays although it was delivered first')
  // the rest are the most recently delivered; the kept pages are listed in the old order
  assert.deepEqual(ids(out), ['ontology:p0', 'ontology:p6', 'ontology:p7', 'ontology:p8', 'ontology:p9', 'ontology:p10', 'ontology:p11', 'ontology:roll'])
})

test('this turn\'s picks always stay, and a page outside the scope never appears', () => {
  const scoped = new Map(pages); scoped.set('ontology:board', { ...page('ontology:board', '보드 기록'), scope: 'board:B1' })
  const out = writeCandidateOrder({ message: '보드 기록', picks: ['ontology:p11', 'ontology:p10'], held: ['ontology:board', ...held], pages: scoped, scope: { allowedScopes: ['dm'] } })
  assert.ok(!ids(out).includes('ontology:board'))
  assert.deepEqual(ids(out).slice(0, 2), ['ontology:p11', 'ontology:p10'])
  assert.equal(out.length, 8)
})
