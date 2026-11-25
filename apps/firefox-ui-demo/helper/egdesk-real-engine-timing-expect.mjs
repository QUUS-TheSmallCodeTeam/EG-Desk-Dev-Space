// L2 c32: timing expectations for a scripted turn of the real-engine check (U13 "끼릭끼릭 탁탁"), judged by code on the record the check made of that turn, with the measure of helper/egdesk-real-engine-timing.mjs.
// A turn may carry   "expect": { "timing": { "layersMaxMs": 3000, "answerMaxMs": 8000, "firstVisibleMaxMs": 4000, "maxEngineRounds": 1, "engineStarted": false } }
//   layersMaxMs        the memory and action layers (turn start to the moment the engine was asked to start; the whole turn when no engine turn ran) took at most this long
//   answerMaxMs        the last posted message arrived within this long of the turn start
//   firstVisibleMaxMs  the first change the person can see (a posted message or an activity row of the work) came within this long
//   maxEngineRounds    the engine made at most this many model rounds (a round ends with a tool call or the final text)
//   engineStarted      the engine was (true) or was not (false) asked to start a turn: false is the decision-first path that ends locally
// Numbers are bounds, not targets: write one only from a measured number (the baseline table of scripts/egdesk-real-engine-timing.mjs) and say so in the script's description.
import { turnTiming } from './egdesk-real-engine-timing.mjs'

export const TIMING_EXPECT_KEYS = Object.freeze(['layersMaxMs', 'answerMaxMs', 'firstVisibleMaxMs', 'maxEngineRounds', 'engineStarted'])
const ms = { type: 'integer', minimum: 100, maximum: 600_000 }
export const TIMING_EXPECT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, minProperties: 1, properties: { layersMaxMs: ms, answerMaxMs: ms, firstVisibleMaxMs: ms, maxEngineRounds: { type: 'integer', minimum: 0, maximum: 30 }, engineStarted: { type: 'boolean' } } })

/** validateTimingExpect(expect, turn, where) → ['<where>: <reason>'] (empty when valid). */
export function validateTimingExpect(expect, turn = {}, where = '$.expect.timing') {
  const errors = [], bad = (at, why) => { if (errors.length < 20) errors.push(`${at}: ${why}`) }
  if (expect === null || typeof expect !== 'object' || Array.isArray(expect)) return [`${where}: an object`]
  if (!Object.keys(expect).length) bad(where, 'at least one key')
  for (const k of Object.keys(expect)) if (!TIMING_EXPECT_KEYS.includes(k)) bad(`${where}.${k}`, 'unknown key')
  for (const k of ['layersMaxMs', 'answerMaxMs', 'firstVisibleMaxMs']) if (expect[k] !== undefined && !(Number.isInteger(expect[k]) && expect[k] >= 100 && expect[k] <= 600_000)) bad(`${where}.${k}`, 'an integer 100-600000')
  if (expect.maxEngineRounds !== undefined && !(Number.isInteger(expect.maxEngineRounds) && expect.maxEngineRounds >= 0 && expect.maxEngineRounds <= 30)) bad(`${where}.maxEngineRounds`, 'an integer 0-30')
  if (expect.engineStarted !== undefined && typeof expect.engineStarted !== 'boolean') bad(`${where}.engineStarted`, 'true or false')
  if (expect.engineStarted === false && expect.maxEngineRounds !== undefined && expect.maxEngineRounds > 0) bad(where, 'engineStarted false and maxEngineRounds above 0 contradict')
  if (turn.whileRunning !== undefined || turn.action !== undefined) bad(where, 'only on a plain message turn (a message typed into the run has no window of its own)')
  return errors
}

/** judgeTiming(expect, timingRow) → [{ check, ok, detail }]; timingRow is turnTiming(). An expectation about a number the record does not have fails (never guessed). */
export function judgeTiming(expect, t) {
  const out = [], put = (check, ok, detail) => out.push({ check: `timing.${check}`, ok: ok === true, detail })
  if (!t) return [{ check: 'timing', ok: false, detail: { why: 'no timing for this turn' } }]
  if (expect.layersMaxMs !== undefined) put('layersMaxMs', Number.isFinite(t.layers.ms) && t.layers.ms <= expect.layersMaxMs, { wanted: expect.layersMaxMs, layersMs: t.layers.ms, calls: t.layers.calls })
  if (expect.answerMaxMs !== undefined) put('answerMaxMs', Number.isFinite(t.finalAnswerMs) && t.finalAnswerMs <= expect.answerMaxMs, { wanted: expect.answerMaxMs, finalAnswerMs: t.finalAnswerMs })
  if (expect.firstVisibleMaxMs !== undefined) put('firstVisibleMaxMs', Number.isFinite(t.firstVisibleMs) && t.firstVisibleMs <= expect.firstVisibleMaxMs, { wanted: expect.firstVisibleMaxMs, firstVisibleMs: t.firstVisibleMs })
  if (expect.maxEngineRounds !== undefined) put('maxEngineRounds', t.engine.rounds <= expect.maxEngineRounds, { wanted: expect.maxEngineRounds, rounds: t.engine.rounds, roundMs: t.engine.roundMs })
  if (expect.engineStarted !== undefined) put('engineStarted', t.layers.engineStarted === expect.engineStarted, { wanted: expect.engineStarted, engineStarted: t.layers.engineStarted, engineStartMs: t.engine.startMs })
  return out
}

/** The turn hook: judges expect.timing at the end of the turn from the sub-turn record the check hands it (ctx.timingTurn = { posted, subTurns: [the turn's record] }). Inert without expect.timing. */
export function createTimingHook() {
  return { finishTurn(ctx = {}) { return ctx.expect?.timing === undefined ? null : { expectations: judgeTiming(ctx.expect.timing, turnTiming({ index: 0, ...ctx.timingTurn })) } } }
}
