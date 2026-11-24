// L7 c26: how many thread/resume calls a turn costs. Two call sites exist in the runtime's send path: the first hydrates history and the
// historical cwd; the second (the reload for a saved Agent profile, a profile switch or computer control off) detaches the thread and resumes it
// again with the ceiling / computer-off / own-tools overrides, because thread/resume cannot change the settings of a loaded thread. When that
// reload is certain and the send carries the cwd, the first resume is skipped (it only hydrated what the reload hydrates again). The reload
// itself (unsubscribe + resume on every turn of an Agent profile DM) is by design: it re-applies the Agent's tool ceiling and re-verifies it on
// the resumed thread every turn (AGENT-04). Offline.
import test from 'node:test'
import assert from 'node:assert/strict'
import { allOnWorld, DM } from './egdesk-all-on.support.mjs'

async function world(t, { restart = true, done = true } = {}) {
  const w = allOnWorld(t, { env: {} })
  await w.settings.turnMemory.save('on')
  await w.send('발표 자료 이어서 만들어 줘'); if (done) await w.answer('네, 시작합니다.')
  if (restart) w.chat.loadedThreads.clear() // a bridge restart: the process has loaded nothing
  return w
}
const methods = (w, from) => w.native.slice(from).map(c => c.method)
const resumes = (w, from) => w.native.slice(from).filter(c => c.method === 'thread/resume')

test('an Agent profile DM on an unloaded thread: ONE resume (it was two), carrying the reload\'s overrides and the cwd', async t => {
  const w = await world(t)
  const from = w.native.length
  await w.send('다음 장도 해 줘')
  assert.deepEqual(methods(w, from), ['thread/resume', 'turn/start'])
  assert.ok(resumes(w, from)[0].params.config && resumes(w, from)[0].params.cwd)
})

test('the profile reload on a LOADED thread is unchanged: unsubscribe + resume each turn (the ceiling is re-applied and re-verified)', async t => {
  const w = await world(t, { restart: false })
  const from = w.native.length
  await w.send('다음 장도 해 줘')
  assert.deepEqual(methods(w, from), ['thread/unsubscribe', 'thread/resume', 'turn/start'])
})

test('without a cwd in the send the first resume stays (it learns the historical cwd the settings reads need): two resumes', async t => {
  const w = await world(t)
  const orig = w.chat.send.bind(w.chat)
  w.chat.send = body => { const { cwd, ...rest } = body; return orig(rest) }
  const from = w.native.length
  await w.send('다음 장도 해 줘')
  assert.deepEqual(methods(w, from).filter(m => m !== 'turn/start'), ['thread/resume', 'thread/unsubscribe', 'thread/resume'])
})

test('the active-run check still refuses on an unloaded thread whose run has not finished (it runs again after the single resume)', async t => {
  const w = await world(t, { done: false })
  const from = w.native.length
  await assert.rejects(w.send('다음 장도 해 줘'), error => error.code === 'RUN_IN_PROGRESS')
  assert.equal(methods(w, from).includes('turn/start'), false)
})

test('with the skipped first resume the continuity check runs once, on the one hydration', async t => {
  const w = await world(t)
  w.appServer.turns = () => []
  w.appServer.cursor = () => 'c1'
  w.appServer.list = () => ({ data: [], nextCursor: null })
  await w.send('다음 장도 해 줘')
  assert.equal(w.appServer.listCalls.length, 1)
})
