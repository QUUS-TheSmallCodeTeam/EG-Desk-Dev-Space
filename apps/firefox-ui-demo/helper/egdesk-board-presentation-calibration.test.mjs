import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, chmodSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createDecisionBudget } from './egdesk-decision-client.mjs'
import { createBoardPresentationHttpHandler } from './egdesk-board-presentation-http.mjs'
import { openCalibrationLog, CALIBRATION_FILE } from './egdesk-decision-calibration-log.mjs'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

// Board arrangement calibration record (canon 5.3) through the production Board handler and the real log module.
const pair = '선택한 두 장 나란히 비교', keep = '현재 배치 유지'
const dto = { cue: '비공개 목적 문장 PRIVATE-CUE', items: [{ kind: '업무 전표', focus: true, movable: true }, { kind: '메모', focus: false, movable: true }], wide: true, tall: true }
const ans = (a, b, choice = pair) => ({ name: 'board_view', type: 'choice', choice, confidence: a,
  probabilities: [{ value: choice, probability: a }, { value: choice === pair ? keep : pair, probability: b }] })

function rig(mode, answers, { time } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egdesk-board-calib-')); chmodSync(dir, 0o700)
  const log = openCalibrationLog({ dataDir: dir })
  const s = { time: 0, mode }
  const board = createBoardPresentationHttpHandler({ credentials: { getApiKey: () => 'egd-synthetic-not-a-key-0004', savedAt: () => 5 }, getMode: () => s.mode,
    budget: createDecisionBudget({ monthlyInputTokenCap: 10000 }), now: () => s.time, calibrationLog: log,
    fetchImpl: async () => Response.json({ answers, usage: { input_tokens: 10 } }) })
  const post = async (action, body) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { url: `/decision/board-presentation/${action}`, method: 'POST',
      headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', 'content-type': 'application/json' } })
    const res = Object.assign(new EventEmitter(), { writeHead(c) { this.status = c }, end(j) { this.body = JSON.parse(j); this.writableEnded = true } })
    assert.equal(await board(req, res, new URL(req.url, 'http://127.0.0.1:39218')), true); return res.body
  }
  const go = async () => { const p = await post('prepare', dto); return post('run', { ticket: p.ticket, confirm: true }) }
  return { log, s, go, dir, board }
}
const file = dir => readFileSync(path.join(dir, CALIBRATION_FILE), 'utf8')

test('on: accepted answer records top/second/bar/would; entry carries no text, ids, geometry or image', async () => {
  const r = rig('on', [ans(.94, .06)]); assert.deepEqual(await r.go(), { status: 'preview', preview: 'pair' })
  const [e] = r.log.entries()
  assert.deepEqual({ feature: e.feature, mode: e.mode, candidates: e.candidates, attached: e.attached }, { feature: 'board_arrangement', mode: 'on', candidates: 4, attached: true })
  assert.deepEqual(e.judgments, [{ q: 'choice', would: 'accept', top: .94, second: .06, p: .94, threshold: .75, minMargin: .2 }])
  const raw = file(r.dir); for (const bad of ['PRIVATE-CUE', '선택한', '현재 배치', 'synthetic', 'slot', 'data:image', 'board_view']) assert.ok(!raw.includes(bad), bad)
})
test('on: below the confidence bar or margin => would reject, nothing attached', async () => {
  const r = rig('on', [ans(.6, .4)]); assert.deepEqual(await r.go(), { status: 'manual' })
  const [e] = r.log.entries(); assert.equal(e.attached, false); assert.deepEqual([e.judgments[0].would, e.judgments[0].top, e.judgments[0].second], ['reject', .6, .4])
})
test('advisory: records what the bar would have done; reply is advisory-only; attached stays false', async () => {
  const r = rig('advisory', [ans(.9, .1)]); assert.deepEqual(await r.go(), { status: 'advisory-only', suggestion: 'pair' })
  const [e] = r.log.entries(); assert.equal(e.mode, 'advisory'); assert.equal(e.attached, false); assert.equal(e.judgments[0].would, 'accept')
})
test('mode flipped while the provider answered: fallback mode_changed, no probabilities kept', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egdesk-board-calib-')); chmodSync(dir, 0o700)
  const log = openCalibrationLog({ dataDir: dir }); let mode = 'on'
  const board = createBoardPresentationHttpHandler({ credentials: { getApiKey: () => 'egd-synthetic-not-a-key-0004', savedAt: () => 5 }, getMode: () => mode,
    budget: createDecisionBudget({ monthlyInputTokenCap: 10000 }), calibrationLog: log,
    fetchImpl: async () => { mode = 'advisory'; return Response.json({ answers: [ans(.94, .06)], usage: { input_tokens: 10 } }) } })
  const post = async (action, body) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { url: `/decision/board-presentation/${action}`, method: 'POST',
      headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', 'content-type': 'application/json' } })
    const res = Object.assign(new EventEmitter(), { writeHead(c) { this.status = c }, end(j) { this.body = JSON.parse(j); this.writableEnded = true } })
    await board(req, res, new URL(req.url, 'http://127.0.0.1:39218')); return res.body }
  const p = await post('prepare', dto); assert.deepEqual(await post('run', { ticket: p.ticket, confirm: true }), { status: 'manual' })
  const [e] = log.entries(); assert.equal(e.fallback, 'mode_changed'); assert.deepEqual(e.judgments, [])
})
test('an answer with no usable numbers records a reject with no probabilities; a failing log never changes the reply', async () => {
  const r = rig('on', []); assert.deepEqual(await r.go(), { status: 'manual' }) // empty answers => rejected judgment with no numbers
  const [e] = r.log.entries(); assert.equal(e.judgments[0].would, 'reject'); assert.equal(e.judgments[0].top, undefined)
  const board = createBoardPresentationHttpHandler({ credentials: { getApiKey: () => 'egd-synthetic-not-a-key-0004', savedAt: () => 5 }, getMode: () => 'on',
    budget: createDecisionBudget({ monthlyInputTokenCap: 10000 }), calibrationLog: { record() { throw new Error('disk') } },
    fetchImpl: async () => Response.json({ answers: [ans(.94, .06)], usage: { input_tokens: 10 } }) })
  const post = async (action, body) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { url: `/decision/board-presentation/${action}`, method: 'POST',
      headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', 'content-type': 'application/json' } })
    const res = Object.assign(new EventEmitter(), { writeHead(c) { this.status = c }, end(j) { this.body = JSON.parse(j); this.writableEnded = true } })
    await board(req, res, new URL(req.url, 'http://127.0.0.1:39218')); return res.body }
  const p = await post('prepare', dto); assert.deepEqual(await post('run', { ticket: p.ticket, confirm: true }), { status: 'preview', preview: 'pair' })
})
