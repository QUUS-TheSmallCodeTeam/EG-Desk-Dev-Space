import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { replaceFieldText } from './egdesk-qa-ui-flow.mjs';

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
  const preflight = source.slice(source.indexOf('async function returnFromArtifactRoomToHome'), source.indexOf('function qaThreadSelectionCandidate('));
  assert.equal((preflight.match(/harness\.click\(/g) || []).length, 1);
  assert.ok(preflight.indexOf('createChatNavigationReadiness(threadId)') < preflight.indexOf('await harness.click(back)'));
  assert.ok(preflight.indexOf("observe('.egd-codex-thread-home-new')") > preflight.indexOf('await harness.click(back)'));
  assert.ok(source.indexOf('await returnFromArtifactRoomToHome(harness, result, threadA.id)') < source.indexOf('const threadB = await newQaThread'));
  const observation = source.slice(source.indexOf('async function observeChatNavigation'), source.indexOf('async function returnFromArtifactRoomToHome'));
  assert.ok(!/dispatchEvent|\.click\(|\.focus\(|\.style\.[a-z]+\s*=/.test(observation));
  assert.ok(preflight.includes('timeoutMs: 15000') && preflight.includes('timeoutMs: 10000'));
});

const candidateSource = source.slice(source.indexOf('function qaThreadSelectionCandidate('), source.indexOf('async function observeQaThreadSelection('));
const selectionSource = source.slice(source.indexOf('async function selectQaThread('), source.indexOf('async function messages('));
const observationSource = source.slice(source.indexOf('async function observeQaThreadSelection('), source.indexOf('async function selectQaThread('));

// These are in-memory native-adapter observations, not a Firefox run or DOM
// injection. The real replaceFieldText drives click/select-all/type; only the
// fake native adapter changes its own test state in response to those inputs.
function selectionFixture(options = {}) {
  const thread = { id: 'qa-target-91', title: 'QA same-provider account exact-91' };
  const threads = Array.from({ length: 100 }, (_, i) => i === 91 ? thread : { id: `room-${i}`, title: `Other room ${i}` });
  if (options.duplicateTitle) threads[12] = { id: 'foreign-same-title', title: thread.title };
  let query = '', searchValue = '', activeId = 'original-room', filteredReads = 0, pendingRender = 0;
  const events = [], selections = [], observations = [];
  const observe = () => {
    if (pendingRender && --pendingRender === 0) query = searchValue;
    const filtered = threads.filter(item => !query || item.title.toLowerCase().includes(query.toLowerCase()));
    if (query === thread.title) filteredReads++;
    const rows = filtered.map((item, index) => {
      const value = sample();
      value.selector = `#chat-card > div:nth-child(${index + 1})`;
      value.threadId = activeId; value.title = item.title; value.focusKey = `room-${item.id}`;
      value.target.rect = { left: 100, top: 100 + index * 70, right: 400, bottom: 150 + index * 70 };
      value.target.clipped = index > 2 || !!options.stillClipped;
      value.target.inside = index < 8;
      value.target.hitCount = value.target.clipped ? 0 : 9;
      if (query === thread.title && filteredReads === 4 && options.beforeClick) options.beforeClick(value);
      return value;
    });
    const value = { threads, rows, query, searchCount: 1, searchValue };
    observations.push(structuredClone(value));
    return value;
  };
  const harness = {
    async inspect(selector) {
      if (selector === '.egd-codex-conversation-back') return [];
      if (selector === '.egd-codex-thread-search') return [{ value: searchValue, visible: true }];
      throw new Error(`Unexpected inspection: ${selector}`);
    },
    async click(selector) {
      events.push(['click', selector]);
      if (selector === '.egd-codex-thread-search') return;
      const row = observations.at(-1).rows.find(value => value.selector === selector);
      assert.ok(row && row.focusKey === `room-${thread.id}`);
      assert.equal(row.target.clipped, false, 'clipped room must never be clicked');
      selections.push(selector); activeId = options.wrongPostClick ? 'wrong-room' : thread.id;
    },
    async press(key, selector) { events.push(['press', key, selector]); },
    async typeText(text) {
      events.push(['type', text]); searchValue = text;
      // First observed sample still has the old product query/render.
      pendingRender = options.renderDelay ?? 2;
    },
  };
  const select = runInNewContext(`${pure}\n${candidateSource}\n${selectionSource}\nselectQaThread`, {
    assert, replaceFieldText,
    openChat: async () => { events.push(['open']); },
    observeChatNavigation: async (_harness, selector) => {
      const value = sample(); value.selector = selector; value.threadId = activeId;
      if (options.searchClipped) value.target.clipped = true;
      return value;
    },
    observeQaThreadSelection: async () => observe(),
    visible: async (_harness, selector) => { events.push(['visible', selector]); },
    chatIdentity: async () => ({ threadId: activeId }),
    waitUntil: async (read, accept, limits) => {
      assert.ok(limits.timeoutMs <= 10000 && limits.intervalMs === 120);
      for (let i = 0; i < 12; i++) { const value = await read(); if (accept(value)) return value; }
      throw new Error('bounded selection readiness timeout');
    },
  });
  return { thread, threads, harness, select: () => select(harness, thread), events, selections, observations, observe };
}

test('100-room offscreen target is natively searched by its exact QA name, freshly bound and selected once', async () => {
  const fixture = selectionFixture();
  const original = fixture.observe().rows.find(row => row.focusKey === `room-${fixture.thread.id}`);
  assert.equal(original.target.clipped, true); assert.equal(original.target.hitCount, 0);
  await fixture.select();
  assert.deepEqual(fixture.events.filter(event => event[0] === 'type'), [['type', fixture.thread.title]]);
  assert.ok(fixture.events.some(event => event[0] === 'press' && /(?:meta|Control)\+a/.test(event[1])));
  assert.equal(fixture.selections.length, 1);
  const fresh = fixture.observations.at(-1);
  assert.equal(fresh.query, fixture.thread.title); assert.equal(fresh.rows.length, 1);
  assert.equal(fresh.rows[0].focusKey, `room-${fixture.thread.id}`);
  assert.ok(fixture.observations.filter(value => value.query === fixture.thread.title).length >= 4, 'three stable samples plus fresh pre-click read');
  assert.ok(fixture.observations.some(value => value.searchValue === fixture.thread.title && value.query === ''), 'input value alone does not prove filtering');
});

test('searched row still clipped times out with zero room clicks, never scrolling or forcing geometry', async () => {
  const fixture = selectionFixture({ stillClipped: true });
  await assert.rejects(fixture.select(), /bounded selection readiness timeout/);
  assert.equal(fixture.selections.length, 0);
  assert.deepEqual(fixture.events.filter(event => event[0] === 'type'), [['type', fixture.thread.title]]);
  assert.equal(fixture.events.filter(event => event[0] === 'click').length, 1, 'only the native search input was clicked');
});

test('clipping, target reordering or a wrong room ID on the fresh fourth sample abort before the room click', async () => {
  for (const beforeClick of [row => { row.target.clipped = true; }, row => { row.selector = '#chat-card > div:nth-child(2)'; },
    row => { row.focusKey = 'room-foreign'; }, row => { row.target.hitCount = 8; }]) {
    const fixture = selectionFixture({ beforeClick, renderDelay: 1 });
    await assert.rejects(fixture.select(), /changed or became clipped/);
    assert.equal(fixture.selections.length, 0);
  }
});

test('ambiguous model labels and clipped native search refuse selection; post-click wrong identity still fails', async () => {
  const ambiguous = selectionFixture({ duplicateTitle: true });
  await assert.rejects(ambiguous.select(), /not unique for its local ID/); assert.equal(ambiguous.selections.length, 0);
  const clippedSearch = selectionFixture({ searchClipped: true });
  await assert.rejects(clippedSearch.select(), /bounded selection readiness timeout/);
  assert.equal(clippedSearch.events.some(event => ['click', 'type', 'press'].includes(event[0])), false);
  const wrong = selectionFixture({ wrongPostClick: true });
  await assert.rejects(wrong.select(), /UI selected a different Chat thread/); assert.equal(wrong.selections.length, 1);
});

test('room readiness preserves exact label/ID, unique DOM binding, nine hit points, bounds and stable camera', () => {
  const { qaThreadSelectionCandidate: candidate, createQaThreadSelectionReadiness: readiness } = runInNewContext(
    `${pure}\n${candidateSource}\n({qaThreadSelectionCandidate, createQaThreadSelectionReadiness})`, { assert });
  const fixture = selectionFixture(), valid = fixture.observe();
  const row = valid.rows.find(value => value.focusKey === `room-${fixture.thread.id}`);
  row.target = sample().target; valid.rows = [row]; valid.query = valid.searchValue = fixture.thread.title;
  assert.equal(candidate(fixture.thread, valid).focusKey, `room-${fixture.thread.id}`);
  for (const mutate of [value => { value.searchCount = 2; }, value => { value.query = ''; }, value => { value.searchValue += ' other'; },
    value => { value.rows[0].count = 2; }, value => { value.rows[0].title = 'Other room'; }, value => { value.rows[0].focusKey = 'room-wrong'; },
    value => { value.rows[0].target.disabled = true; }, value => { value.rows[0].target.inside = false; },
    value => { value.rows[0].target.clipped = true; }, value => { value.rows[0].target.hitCount = 8; },
    value => { value.rows[0].camera.x += 10; }, value => { value.rows[0].rootId = null; }]) {
    const ready = readiness(fixture.thread), bad = structuredClone(valid); mutate(bad);
    assert.equal(ready(valid), false); assert.equal(ready(valid), false); assert.equal(ready(valid), true);
    assert.equal(ready(bad), false); assert.equal(ready(valid), false);
  }
  assert.throws(() => candidate({ ...fixture.thread, id: 'foreign' }, valid), /not unique for its local ID/);
});

test('duplicate list sections for the same verified ID remain supported, but a different room never substitutes', () => {
  const candidate = runInNewContext(`${candidateSource}\nqaThreadSelectionCandidate`, { assert });
  const fixture = selectionFixture(), value = fixture.observe();
  const target = value.rows.find(row => row.focusKey === `room-${fixture.thread.id}`);
  const second = structuredClone(target); second.target = sample().target; second.selector = '#chat-card > div:nth-child(2)';
  value.rows = [target, second]; value.query = value.searchValue = fixture.thread.title;
  assert.equal(candidate(fixture.thread, value).selector, second.selector);
  second.focusKey = 'room-different';
  assert.equal(candidate(fixture.thread, value), null);
});

test('actual read-only observer detects ancestor clipping, all nine hit points and unique structural binding', async () => {
  const box = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
  const style = { display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible' };
  let rowBox = box(30, 900, 400, 950), bindings = 1, hitTests = 0;
  const root = { id: 'chat-card', localName: 'div', parentElement: null, children: [],
    getBoundingClientRect: () => box(0, 0, 500, 400) };
  const list = { localName: 'div', parentElement: root, children: [], getBoundingClientRect: () => box(10, 80, 490, 280) };
  const row = { localName: 'div', parentElement: list, dataset: { focusKey: 'room-qa-id' }, disabled: false,
    getBoundingClientRect: () => rowBox, getAttribute: () => null,
    closest: selector => selector === '#egd-hud, .egd-chat-card' ? root : null,
    querySelector: selector => selector === '.egd-codex-thread-title' ? { textContent: 'QA exact name' } : null,
    contains: node => node === row };
  root.children = [list]; list.children = [row];
  const state = { codex: { threadQuery: 'QA exact name', activeThreadId: 'previous-room', threads: [{ id: 'qa-id', title: 'QA exact name' }] },
    pan: { x: 0, y: 0 }, panTarget: { x: 0, y: 0 }, zoom: 1, zoomTarget: 1 };
  const before = structuredClone(state);
  const observe = runInNewContext(`${observationSource}\nobserveQaThreadSelection`, {
    chrome: async (_harness, fn) => fn(), window: { __egdesk: { state } }, innerWidth: 800, innerHeight: 600,
    CSS: { escape: value => value }, getComputedStyle: node => node === list ? { ...style, overflowY: 'auto' } : style,
    document: {
      querySelectorAll(selector) {
        if (selector === '.egd-codex-thread-search') return [{ value: 'QA exact name' }];
        if (selector === '.egd-codex-thread-item') return [row];
        assert.equal(selector, '#chat-card > div:nth-child(1) > div:nth-child(1)');
        return Array.from({ length: bindings }, () => row);
      },
      elementFromPoint(x, y) {
        hitTests++;
        return x >= 10 && x <= 490 && y >= 80 && y <= 280 && y >= rowBox.top && y <= rowBox.bottom ? row : null;
      },
    },
  });
  let result = await observe({});
  assert.equal(hitTests, 9); assert.equal(result.rows[0].target.clipped, true); assert.equal(result.rows[0].target.hitCount, 0);
  rowBox = box(30, 120, 400, 170);
  result = await observe({});
  assert.equal(hitTests, 18); assert.equal(result.rows[0].target.clipped, false); assert.equal(result.rows[0].target.hitCount, 9);
  assert.equal(result.rows[0].focusKey, 'room-qa-id'); assert.equal(result.rows[0].count, 1);
  bindings = 2; result = await observe({}); assert.equal(result.rows[0].count, 2);
  assert.deepEqual(state, before, 'observation never mutates application state');
});

test('selection observation is read-only and callers use the bounded local fix without changing common transport', () => {
  assert.match(observationSource, /document\.elementFromPoint/);
  assert.match(observationSource, /node\.dataset\.focusKey/);
  assert.match(observationSource, /querySelectorAll\(selector\)\.length/);
  assert.match(observationSource, /overflowX/); assert.match(observationSource, /overflowY/);
  assert.doesNotMatch(observationSource + selectionSource, /dispatchEvent|\.scroll(?:IntoView|To|By)\(|\.scrollTop\s*=|\.value\s*=|\.threadQuery\s*=|\.style\.[a-z]+\s*=|\.focus\(/);
  assert.ok(selectionSource.indexOf('replaceFieldText(harness, search, thread.title)') < selectionSource.indexOf('const observed = await waitUntil'));
  assert.ok(selectionSource.indexOf('const fresh = await observeQaThreadSelection') < selectionSource.indexOf('await harness.click(current.selector)'));
  assert.match(source, /await selectQaThread\(harness, accountThread\)/);
  assert.match(source, /await selectQaThread\(harness, authThread\)/);
  assert.doesNotMatch(source.slice(0, source.indexOf('const token')), /runUiFlow, selectQaThread,/);
});
