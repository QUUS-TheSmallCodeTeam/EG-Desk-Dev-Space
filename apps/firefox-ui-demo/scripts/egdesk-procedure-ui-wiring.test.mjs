import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const js = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8')
const slice = (from, to) => { const a = js.indexOf(from); assert.ok(a >= 0, from); const b = js.indexOf(to, a); assert.ok(b > a, to); return js.slice(a, b) }

test('gate: only capabilities.browserProcedures === true turns the UI on', () => {
  assert.match(js, /function bridgeProceduresField\(bridgeState\) \{\n    return \{ proceduresUi: bridgeState\?\.capabilities\?\.browserProcedures === true \};\n  \}/)
  assert.equal(js.split('...bridgeProceduresField(bridgeState),').length - 1, 2, 'both state updates carry the field')
  assert.match(js, /ChromeUtils\.importESModule\('chrome:\/\/userchrome\/content\/EGDeskProcedureView\.sys\.mjs'\)/)
})

test('steps block: the save button needs the gate and goes through the capture route', () => {
  assert.match(js, /const saveOffer = codex\.proceduresUi === true \? ProcedureView\.procedureSaveOffer\(block, \{ busy: threadBusy\(activeThread\) \}\) : null;/)
  assert.match(js, /saveOffer \? el\('button'/)
  assert.match(js, /procedureCapture\(saveOffer\.clientThreadId, saveOffer\.cardId\)/)
  const cap = slice('async procedureCapture(', 'procedureEdit(')
  assert.match(cap, /state\.codex\.proceduresUi !== true/)
  assert.match(cap, /fetchJson\('\/v1\/procedures\/capture', \{ method: 'POST', body: JSON\.stringify\(\{ clientThreadId, cardId \}\) \}\)/)
  assert.match(cap, /mode: 'editor', procedure: draft, isNew: true/)
})

test('save calls POST for a draft and PUT for an existing procedure; delete and list use the routes', () => {
  const save = slice('async procedureSave()', 'async procedureRemove(')
  assert.match(save, /fetchJson\('\/v1\/procedures', \{ method: 'POST'/)
  assert.match(save, /\{ method: 'PUT'/)
  assert.match(save, /validateProcedure\(ui\.procedure\)\.length\) return/)
  assert.match(slice('async procedureRemove(', 'async procedureRun('), /\{ method: 'DELETE' \}/)
  assert.match(slice('async procedureOpenList()', 'async procedureLoad('), /fetchJson\('\/v1\/procedures', \{ method: 'GET' \}\)/)
})

test('run: the message goes through setDraft + sendMessage of the active room, not a new transport', () => {
  const run = slice('async procedureRun(', '// a1 (L1): a folded Browser task')
  assert.match(run, /ProcedureView\.procedureRunMessage\(procedure, values \|\| \{\}\)/)
  assert.match(run, /this\.setDraft\(/)
  assert.match(run, /await this\.sendMessage\(\)/)
  assert.match(run, /getActiveCodexThread\(state\.codex\)/)
  assert.doesNotMatch(run, /fetchJson|fetch\(/)
  assert.match(run, /threadBusy\(thread\)/)
})

test('toolbar: the 절차 control is added and removed by the gate; the panel is removed when off', () => {
  const sync = slice('const syncChatFrameTitle = (codex) => {', 'const title =')
  assert.match(sync, /codex\.proceduresUi === true && !existing/)
  assert.match(sync, /data: \{ testid: 'chat-procedures' \}/)
  assert.match(sync, /codex\.proceduresUi !== true && existing\) existing\.remove\(\)/)
  const panel = slice('function renderProcedurePanel()', 'function renderCodexActivityPanel()')
  assert.match(panel, /state\.codex\?\.proceduresUi === true \? bridge\?\.procedureUi\?\.\(\) : null/)
  assert.match(panel, /if \(!ui\) \{ existing\?\.remove\(\); return; \}/)
  assert.match(js, /state\.codexBridge\.subscribe\(\(\) => renderProcedurePanel\(\)\)/)
  assert.doesNotMatch(js, /renderCodexActivityPanel\(\);\n\s+renderProcedurePanel\(\);/, 'emit stays as it was')
  const ui = slice('procedureUi() {', 'procedureSet(')
  assert.match(ui, /proceduresUi === true \? procedureUiState : null/)
})

test('gate off: every bridge method returns before any request', () => {
  for (const [from, to] of [['async procedureOpenList()', 'async procedureLoad('], ['async procedureLoad(', '// "절차로 저장"'], ['async procedureSave()', 'async procedureRemove('], ['async procedureRemove(', 'async procedureRun('], ['async procedureRun(', '// a1 (L1): a folded Browser task']]) {
    const body = slice(from, to)
    assert.ok(body.indexOf('proceduresUi !== true') >= 0 && body.indexOf('proceduresUi !== true') < body.indexOf('fetchJson') + (body.includes('fetchJson') ? 0 : 1e9), from)
  }
})

test('sensitive params: no input is rendered for them', () => {
  const panel = slice('function renderProcedurePanel()', 'function renderCodexActivityPanel()')
  assert.equal(panel.split('f.sensitive ? el(').length - 1, 1)
  assert.match(panel, /row\.field\.sensitive\n\s+\? el\('span'/)
})

test('css: procedure styles sit next to the browser steps chat styles', () => {
  const steps = css.indexOf('.egd-codex-browser-steps-head {'), proc = css.indexOf('.egd-proc-panel {'), toggle = css.indexOf('\n.egd-codex-browser-steps-toggle {')
  assert.ok(steps > 0 && proc > steps && proc - steps < 2000 && toggle > proc)
  for (const cls of ['.egd-proc-row', '.egd-proc-step', '.egd-proc-input', '.egd-proc-sensitive', '.egd-proc-toolbar', '.egd-proc-save']) assert.ok(css.includes(cls), cls)
})
