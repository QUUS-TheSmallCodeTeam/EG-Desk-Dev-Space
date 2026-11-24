// L6 c25: the run-chain counts of the two-passing-runs rule, on synthetic results of the three shapes (journey, multiuser, browser-live).
import assert from 'node:assert/strict'
import test from 'node:test'
import { FRESH_BELOW, chain, requestKeys, runOutcome, summarize } from './egdesk-run-chain.mjs'
import { run } from '../scripts/egdesk-run-chain.mjs'

const row = (family, names, sha256) => ({ family, questions: names, sha256 })
const journey = (failed, rows) => ({ scorecard: { hard: { passed: 5, failed, notRun: 0 } }, steps: [{ id: 's1', requests: rows.slice(0, 2) }, { id: 's2', requests: rows.slice(2) }] })
const browser = (pass, shas, hardFailures = []) => ({ scorecard: { pass, hardFailures }, requests: shas.map(sha256 => ({ sha256 })) })

test('requestKeys: a journey request is keyed by step, family, question names and bytes; a browser-live request by its bytes; rows without bytes are not counted', () => {
  assert.deepEqual(requestKeys(journey([], [row('a', ['q1'], 'h1'), row('b', ['q2', 'q3'], 'h2'), { family: 'c', questions: [] }])), ['s1|a|q1|h1', 's1|b|q2,q3|h2'])
  assert.deepEqual(requestKeys(browser(true, ['x', 'y'])), ['x', 'y']); assert.deepEqual(requestKeys({}), []); assert.deepEqual(requestKeys(null), [])
  // the same bytes in another step are another request (the step is part of what the model read)
  assert.notDeepEqual(requestKeys(journey([], [row('a', ['q'], 'h')]))[0], requestKeys({ steps: [{ id: 's9', requests: [row('a', ['q'], 'h')] }] })[0])
})

test('runOutcome: browser-live reads scorecard.pass, a journey reads the hard failures; a file with neither is a failure and says so', () => {
  assert.deepEqual(runOutcome(browser(true, [])), { pass: true, hardFailures: 0 })
  assert.deepEqual(runOutcome(browser(false, [], ['a', 'b'])), { pass: false, hardFailures: 2 })
  assert.deepEqual(runOutcome(journey(['s1.answer'], [])), { pass: false, hardFailures: 1 })
  assert.deepEqual(runOutcome(journey([], [])), { pass: true, hardFailures: 0 })
  assert.deepEqual(runOutcome({}), { pass: false, hardFailures: null, unreadable: true })
})

test('chain: a pass whose requests repeat an earlier pass is not fresh; a failed run does not make later requests "seen"; the first pass is fresh', () => {
  const a = journey([], [row('f', ['q'], '1'), row('f', ['q'], '2'), row('g', ['q'], '3')])
  const failed = journey(['s2.x'], [row('f', ['q'], '1'), row('f', ['q'], '8'), row('g', ['q'], '9')])
  const repeat = journey([], [row('f', ['q'], '1'), row('f', ['q'], '2'), row('g', ['q'], '4')])   // 2 of 3 identical to the first pass
  const mostlyNew = journey([], [row('f', ['q'], '1'), row('f', ['q'], '5'), row('g', ['q'], '6')]) // 1 of 3 identical
  const list = chain([{ name: 'a', results: a }, { name: 'failed', results: failed }, { name: 'repeat', results: repeat }, { name: 'new', results: mostlyNew }])
  assert.deepEqual(list.map(x => [x.name, x.pass, x.fresh, x.sameAsEarlierPass]), [['a', true, true, 0], ['failed', false, false, 1], ['repeat', true, false, 2], ['new', true, true, 1]])
  assert.equal(FRESH_BELOW, 0.5)
  // 8 of 8 identical (a duplicate send) and 6 of 9 identical, as measured on the stability runs
  const same = browser(true, Array.from({ length: 8 }, (_, i) => `s${i}`))
  assert.deepEqual(chain([{ name: 'r1', results: same }, { name: 'r2', results: same }]).map(x => x.fresh), [true, false])
  assert.deepEqual(summarize(chain([{ name: 'r1', results: same }, { name: 'r2', results: same }])), { passed: 2, failed: 0, freshPasses: 1, last: 'r2 pass' })
})

test('summarize: counts and the last run; an empty chain has no last', () => {
  assert.deepEqual(summarize([]), { passed: 0, failed: 0, freshPasses: 0, last: null })
  const list = chain([{ name: 'a', results: browser(true, ['1']) }, { name: 'b', results: browser(false, ['2'], ['x']) }])
  assert.deepEqual(summarize(list), { passed: 1, failed: 1, freshPasses: 1, last: 'b FAIL 1' })
})

test('the command: prints each run and the counts, --json prints the same as one line, usage and unreadable files exit 2', () => {
  const files = { 'a-results.json': browser(true, ['1', '2']), 'b-results.json': browser(true, ['1', '2']), 'c.json': journey(['s1.x'], [row('f', ['q'], '3')]) }
  const out = [], err = []
  const io = { print: l => out.push(l), printError: l => err.push(l), read: f => { const x = files[f.split('/').at(-1)]; if (!x) throw new Error('no file'); return x } }
  assert.equal(run(['/r/a-results.json', '/r/b-results.json', '/r/c.json'], io), 0)
  assert.match(out[0], /^a\s+pass\s+hard 0\s+requests\s+2\s+identical to an earlier pass\s+0\s+FRESH$/)
  assert.match(out[1], /^b\s+pass\s+hard 0\s+requests\s+2\s+identical to an earlier pass\s+2$/)
  assert.match(out[2], /^c\s+FAIL\s+hard 1\s+requests\s+1/)
  assert.equal(out[3], 'passed 2, failed 1, fresh passes 1, last c FAIL 1')
  out.length = 0
  assert.equal(run(['--json', '/r/a-results.json'], io), 0); assert.deepEqual(JSON.parse(out[0]), { runs: [{ name: 'a', pass: true, hardFailures: 0, requests: 2, sameAsEarlierPass: 0, fresh: true }], passed: 1, failed: 0, freshPasses: 1, last: 'a pass' })
  assert.equal(run([], io), 2); assert.equal(run(['--bogus'], io), 2); assert.equal(run(['/r/missing.json'], io), 2); assert.equal(err.length, 3)
})
