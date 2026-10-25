import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

// Load only the pure readiness function. The verifier's explicit fixture CLI
// entrypoint must never run or attach to Firefox during these unit tests.
const source = fs.readFileSync(new URL('./verify-firefox-mcp-chat-fixture-flow.mjs', import.meta.url), 'utf8');
const pure = source.slice(source.indexOf('function createChatNavigationReadiness('), source.indexOf('async function observeChatNavigation('));
const makeReady = runInNewContext(`(${pure.trim()})`);
const sample = () => ({ selector: '.egd-codex-conversation-back', count: 1, threadId: 'room-a', rootId: 'chat-card',
  target: { visible: true, disabled: false, hitCount: 9, clipped: false, inside: true,
    rect: { left: 570, top: 130, right: 596, bottom: 158 } },
  camera: { x: 100, y: 200, zoom: 0.96, targetX: 100, targetY: 200, targetZoom: 0.96 } });

test('post-artifact Back requires three stable, fully hit-tested samples in the original room', () => {
  const ready = makeReady('room-a'), value = sample();
  assert.equal(ready(value), false); assert.equal(ready(value), false); assert.equal(ready(value), true);
  for (const mutate of [row => row.threadId = 'room-b', row => row.target.hitCount = 6,
    row => row.target.inside = false, row => row.target.clipped = true,
    row => row.target.visible = false, row => row.camera.y = -360, row => row.count = 0]) {
    const bad = sample(); mutate(bad); assert.equal(ready(bad), false);
    assert.equal(ready(value), false); assert.equal(ready(value), false); assert.equal(ready(value), true);
  }
});

test('target movement resets readiness even if every individual sample is clickable', () => {
  const ready = makeReady('room-a'), first = sample(), moving = sample();
  assert.equal(ready(first), false); assert.equal(ready(first), false);
  moving.target.rect.top -= 10; moving.target.rect.bottom -= 10;
  assert.equal(ready(moving), false); assert.equal(ready(moving), false); assert.equal(ready(moving), true);
});

test('Back preflight performs one native click and verifies home before the existing new-room helper', () => {
  const preflight = source.slice(source.indexOf('async function returnFromArtifactRoomToHome'), source.indexOf('async function messages('));
  assert.equal((preflight.match(/harness\.click\(/g) || []).length, 1);
  assert.ok(preflight.indexOf('createChatNavigationReadiness(threadId)') < preflight.indexOf('await harness.click(back)'));
  assert.ok(preflight.indexOf("observe('.egd-codex-thread-home-new')") > preflight.indexOf('await harness.click(back)'));
  assert.ok(source.indexOf('await returnFromArtifactRoomToHome(harness, result, threadA.id)') < source.indexOf('const threadB = await newQaThread'));
  const observation = source.slice(source.indexOf('async function observeChatNavigation'), source.indexOf('async function returnFromArtifactRoomToHome'));
  assert.ok(!/dispatchEvent|\.click\(|\.focus\(|\.style\.[a-z]+\s*=/.test(observation));
  assert.ok(preflight.includes('timeoutMs: 15000') && preflight.includes('timeoutMs: 10000'));
});
