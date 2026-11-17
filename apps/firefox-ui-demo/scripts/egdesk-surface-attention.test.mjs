import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as Attention from '../overlay/resources/surface/EGDeskSurfaceAttention.mjs';
import * as Keys from '../overlay/resources/surface/EGDeskSurfaceKeys.mjs';

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const surfaceJs = read('../overlay/JS/eg-desk-surface.uc.js');
const css = read('../overlay/CSS/eg-desk-surface.uc.css');
const ev = (event, runId, details = {}) => ({ v: 2, event, runId, details });

test('UX-06 attention: only events that need the person', () => {
  assert.equal(Attention.attentionReason(ev('approval.required', 'r1')), 'approval');
  assert.equal(Attention.attentionReason(ev('userInput.required', 'r1')), 'input');
  assert.equal(Attention.attentionReason(ev('run.completed', 'r1', { status: 'blocked' }), { chatVisible: true }), 'blocked');
  assert.equal(Attention.attentionReason(ev('run.completed', 'r1'), { chatVisible: false }), 'finished');
  assert.equal(Attention.attentionReason(ev('run.completed', 'r1', { status: 'failed' }), { chatVisible: false }), 'failed');
  assert.equal(Attention.attentionReason(ev('run.completed', 'r1'), { chatVisible: true }), null);
  assert.equal(Attention.attentionReason(ev('message.delta', 'r1')), null);
  assert.equal(Attention.attentionReason(ev('run.completed', 'r1', { status: 'cancelled' }), { chatVisible: false }), null);
});

test('UX-06 attention: dedupe per run, one notice with a count, dismiss clears', () => {
  let model = Attention.emptyAttention();
  assert.equal(Attention.attentionNotice(model), null);
  model = Attention.noteChatEvent(model, ev('approval.required', 'r1'), { agentName: '리서치' });
  model = Attention.noteChatEvent(model, ev('approval.required', 'r1'), { agentName: '리서치' });
  assert.equal(Attention.attentionNotice(model).count, 1);
  const same = Attention.noteChatEvent(model, ev('message.delta', 'r1'));
  assert.equal(same, model, 'unrelated events leave the model as is');
  model = Attention.noteChatEvent(model, ev('run.completed', 'r2'), { chatVisible: false });
  const notice = Attention.attentionNotice(model);
  assert.equal(notice.count, 2);
  assert.equal(notice.agentName, 'Agent');
  assert.equal(notice.line, '작업을 마쳤습니다.');
  assert.match(notice.label, /외 1건/);
  model = Attention.noteChatEvent(model, ev('approval.resolved', 'r1'));
  assert.equal(Attention.attentionNotice(model).count, 1);
  assert.equal(Attention.noteChatEvent(model, { event: 'approval.required' }), model, 'no run id, no notice');
  assert.equal(Attention.attentionNotice(Attention.dismissAttention()), null);
});

test('UX-06 attention: wired into the surface through the peek hook and the Esc registry', () => {
  assert.match(surfaceJs, /ChromeUtils\.importESModule\('chrome:\/\/userchrome\/content\/surface\/EGDeskSurfaceAttention\.mjs', \{ global: 'current' \}\)/);
  assert.match(surfaceJs, /if \(run\) \{ syncProtocolRun\(run\); emit\(\); \}\n\s+state\.noteChatAttention\?\.\(event, run\);/);
  assert.match(surfaceJs, /state\.peekChatForAttention\?\.\(\)/);
  assert.match(surfaceJs, /registerEscapeLayer\(\{ id: 'attention-notice', kind: 'popover',/);
  assert.equal(Keys.escapeLayerSpec('attention-notice').kind, 'popover');
  const block = surfaceJs.slice(surfaceJs.indexOf('let attentionModel'), surfaceJs.indexOf("id: 'attention-notice'"));
  assert.doesNotMatch(block, /\.focus\(|Audio|play\(|localStorage|Services\.prefs|setStringPref/, 'no focus steal, sound or storage');
  assert.ok(css.indexOf('#egd-attention-notice {') > 0 && css.indexOf('#egd-attention-notice {') < css.indexOf(':root.egd-maximize-hud-peek #egd-hud {'),
    'CSS sits next to the Chat peek rules');
});

test('UX-06 attention: Agent name from the run, room members or room profile; top from the top bar', () => {
  assert.equal(Attention.attentionAgentName({ run: { agentName: ' Mina ' } }), 'Mina');
  const members = [{ kind: 'user', role: 'owner' }, { kind: 'agent', profileId: 'p-a', label: 'Ara' }, { kind: 'agent', profileId: 'p-b', label: 'Bo' }];
  assert.equal(Attention.attentionAgentName({ run: { agentProfileId: 'p-b' }, members }), 'Bo');
  assert.equal(Attention.attentionAgentName({ run: {}, members: [{ kind: 'agent', label: 'Solo' }] }), 'Solo');
  assert.equal(Attention.attentionAgentName({ run: {}, members, roomProfile: { name: 'Room' } }), 'Room');
  assert.equal(Attention.attentionAgentName({ run: null }), 'Agent');
  assert.equal(Attention.attentionNoticeTop({ bottom: 44.4 }), 52);
  assert.equal(Attention.attentionNoticeTop({ bottom: 60 }), 68);
  assert.equal(Attention.attentionNoticeTop(null), 52);
  assert.match(surfaceJs, /agentName: attentionAgentNameFor\(run\)/);
  assert.match(surfaceJs, /node\.style\.top = `\$\{SurfaceAttention\.attentionNoticeTop\(document\.getElementById\('egd-desk-rail'\)\?\.getBoundingClientRect\(\)\)\}px`/);
});

import { test as attentionScopeTest } from 'node:test';
import attentionScopeAssert from 'node:assert/strict';
import { readFileSync as attentionScopeRead } from 'node:fs';
attentionScopeTest('attention notice never calls the escape-layer-scoped byId helper', () => {
  const surface = attentionScopeRead(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
  const start = surface.indexOf('function renderAttentionNotice'), hook = surface.indexOf('state.noteChatAttention =');
  attentionScopeAssert.ok(start > 0 && hook > start, 'attention notice block');
  const block = surface.slice(start - 600, hook + 1500);
  attentionScopeAssert.doesNotMatch(block, /(^|[^\w.])byId\(/m, 'byId exists only inside installEscapeLayers; chat.event would throw');
});
