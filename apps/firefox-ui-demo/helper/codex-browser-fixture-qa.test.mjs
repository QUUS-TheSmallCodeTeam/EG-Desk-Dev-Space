import test from 'node:test'
import assert from 'node:assert/strict'
import { fixtureBrowserQaFromEnv, fixtureSnapshotMatches } from './codex-browser-fixture-qa.mjs'

const url = 'http://127.0.0.1:43210/egdesk-qa/fixture_7f41ad982b6903ab'
const marker = 'EGDESK_FIXTURE_MARKER_94ab7d28'
const config = { EGDESK_BROWSER_FIXTURE_QA: '1', EGDESK_BROWSER_FIXTURE_QA_URL: url, EGDESK_BROWSER_FIXTURE_QA_MARKER: marker }

test('fixture policy requires explicit opt-in and an exact random-path loopback target', () => {
  assert.equal(fixtureBrowserQaFromEnv({}), null)
  assert.deepEqual(fixtureBrowserQaFromEnv(config), { url, marker })
  for (const bad of [
    'https://example.com/egdesk-qa/fixture_7f41ad982b6903ab',
    'http://localhost:43210/egdesk-qa/fixture_7f41ad982b6903ab',
    'http://127.0.0.1:43210/',
    'http://127.0.0.1:43210/egdesk-qa/fixture_7f41ad982b6903ab?redirect=example.com',
  ]) assert.equal(fixtureBrowserQaFromEnv({ ...config, EGDESK_BROWSER_FIXTURE_QA_URL: bad }), null)
  assert.equal(fixtureBrowserQaFromEnv({ ...config, EGDESK_BROWSER_FIXTURE_QA_MARKER: 'short' }), null)
})

test('live observation must match both exact fixture URL and page marker', () => {
  const fixture = fixtureBrowserQaFromEnv(config)
  assert.equal(fixtureSnapshotMatches({ url, text: [marker] }, fixture), true)
  assert.equal(fixtureSnapshotMatches({ url: 'https://example.com/', text: [marker] }, fixture), false)
  assert.equal(fixtureSnapshotMatches({ url, text: [`prefix ${marker}`] }, fixture), false)
})
