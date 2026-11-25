// Support module (not a test): host rig for Answer Briefing journeys. ONE credential store, mode, budget and calibration log behind the production
// Board/Decisions HTTP handler; provider fetch is a synthetic script (key egd-synthetic-not-a-key-0004, no network). Copied from the cycle-6 flow test and
// extended with the reuse judge's answers (component_<alias> choices, new_<part> predicates).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTEXT_TOOL_SPECS } from '../helper/egdesk-context-runtime.mjs';
import { createBoardPresentationHttpHandler } from '../helper/egdesk-board-presentation-http.mjs';
import { createDecisionHttpHandler } from '../helper/egdesk-decision-http.mjs';
import { createDecisionBudget, DECISION_MODEL } from '../helper/egdesk-decision-client.mjs';
import { openCalibrationLog } from '../helper/egdesk-decision-calibration-log.mjs';
export const KEY = 'egd-synthetic-not-a-key-0004';
// the schema of the EXISTING publish tool: a proposal must fit it, nothing new
export function fits(schema, value, at = 'args') {
  if (schema.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), at + ' is an object');
    for (const k of schema.required || []) assert.ok(Object.hasOwn(value, k), `${at}.${k} required`);
    if (schema.additionalProperties === false) for (const k of Object.keys(value)) assert.ok(Object.hasOwn(schema.properties || {}, k), `${at}.${k} not allowed`);
    for (const [k, v] of Object.entries(value)) if (schema.properties?.[k]) fits(schema.properties[k], v, `${at}.${k}`);
  } else if (schema.type === 'array') {
    assert.ok(Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity), at + ' array bounds');
    value.forEach((v, i) => schema.items && fits(schema.items, v, `${at}[${i}]`));
  } else if (schema.type === 'string') { assert.equal(typeof value, 'string', at); if (schema.enum) assert.ok(schema.enum.includes(value), at + ' enum'); }
  else if (schema.type === 'integer') assert.ok(Number.isInteger(value), at);
}
export const publishSchema = CONTEXT_TOOL_SPECS.find(t => t.name === 'egdesk_publish_briefing_multi').inputSchema;

// ---------------- host rig ----------------
export function answerFor(body, script, n) {
  const step = typeof script === 'function' ? script(n, body) : script;
  return body.questions.map(q => {
    if (q.name === 'placement') { const p = step.placement ?? { value: 'board', p: .9 }; return { name: 'placement', type: 'choice', choice: p.value, confidence: p.p, probabilities: [{ value: p.value, probability: p.p }, { value: p.value === 'board' ? 'bubble' : 'board', probability: 1 - p.p }] }; }
    if (q.name.startsWith('component_')) { const d = step.components?.[q.name.slice(10)] ?? { value: 'irrelevant', p: .9 }, other = q.choices.map(c => c.value).find(v => v !== d.value); return { name: q.name, type: 'choice', choice: d.value, confidence: d.p, probabilities: [{ value: d.value, probability: d.p }, { value: other, probability: 1 - d.p }] }; }
    if (q.name.startsWith('new_')) return { name: q.name, type: 'predicate', probability: step.parts?.[q.name.slice(4)] ?? .05 };
    if (q.type === 'predicate') return { name: q.name, type: 'predicate', probability: q.name === 'understandable' ? step.u : (step.issues?.[q.name.replace('issue_', '')] ?? .05) };
    const values = q.choices.map(c => c.value), pick = step.where?.value && values.includes(step.where.value) ? step.where.value : 'none', p = step.where?.p ?? .5, other = values.find(v => v !== pick);
    return { name: q.name, type: 'choice', choice: pick, confidence: p, probabilities: [{ value: pick, probability: p }, { value: other, probability: 1 - p }] };
  });
}
export function rig(t, { mode = 'on', script, cap = 100000, hang = false, handlerOptions = {} } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egdesk-briefing-flow-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const S = { key: KEY, mode };
  const store = { status: 'configured', writable: true, getApiKey: () => S.key, savedAt: () => 17, hint: () => null, save: k => { S.key = k; return true; }, clear: () => { S.key = null; return true; } };
  const modeStore = { get mode() { return S.mode; }, saved: true, persisted: true, save: m => { S.mode = m; return true; } };
  const budget = createDecisionBudget({ monthlyInputTokenCap: cap });
  const calibration = openCalibrationLog({ dataDir: path.join(dir, 'settings'), log() {} });
  const calls = [];
  const provider = async (_u, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    if (hang) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
    return Response.json({ answers: answerFor(body, script, calls.length - 1), usage: { input_tokens: 11 } });
  };
  const board = createBoardPresentationHttpHandler({ credentials: store, getMode: () => modeStore.mode, budget, fetchImpl: provider, calibrationLog: calibration, ...handlerOptions });
  const settings = createDecisionHttpHandler({ store, mode: modeStore, model: DECISION_MODEL, budget, verifyKey: async () => ({ status: 'verified' }), boardPresentation: board });
  const http = async (method, p, body) => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { url: p, method, headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', 'content-type': 'application/json' } });
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writeHead(s) { this.status = s; }, end(j) { this.body = JSON.parse(j); this.writableEnded = true; } });
    assert.equal(await settings(req, res, new URL(p, 'http://127.0.0.1:39218')) || await board(req, res, new URL(p, 'http://127.0.0.1:39218')), true, p);
    return { status: res.status, body: res.body };
  };
  const route = root => ({ prepare: async dto => (await http('POST', `${root}/prepare`, dto)).body, run: async ticket => (await http('POST', `${root}/run`, { ticket, confirm: true })).body, cancel: async ticket => (await http('POST', `${root}/cancel`, { ticket })).body });
  return { S, calls, budget, calibration, http, board, decide: { placement: route('/decision/briefing-placement'), reuse: route('/decision/briefing-reuse'), check: route('/decision/briefing-check') } };
}
export const engineOf = (log, fn) => async request => { log.push(request); return fn(request, log.length - 1); };

