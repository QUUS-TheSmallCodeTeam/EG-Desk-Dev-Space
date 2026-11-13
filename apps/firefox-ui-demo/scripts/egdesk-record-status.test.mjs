// 기록 상태 (top bar): "이 PC에 기록됨 10:34" after a real save, "기록 실패" + [다시 기록] after a failed one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RECORD_STATUS_INITIAL, nextRecordStatus, recordClock, recordStatusView } from '../overlay/resources/EGDeskRecordStatus.sys.mjs';

const surfaceSource = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const surfaceCss = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
const topLevelFunction = name => surfaceSource.match(new RegExp(`  function ${name}\\([^]*?\\n  }\\n`))?.[0];
const at = (h, m, s = 0) => new Date(2026, 10, 14, h, m, s).getTime();

test('nothing is shown until this Desk has really been written once', () => {
  assert.deepEqual(RECORD_STATUS_INITIAL, { savedAt: null, failed: false });
  assert.deepEqual(recordStatusView(RECORD_STATUS_INITIAL), { state: 'none', hidden: true, text: '', title: '', retry: false });
  for (const junk of [undefined, null, {}, { savedAt: 'yesterday' }, { savedAt: NaN }, { savedAt: -1 }]) {
    assert.equal(recordStatusView(junk).hidden, true, 'no made-up time');
  }
});

test('a successful write shows its own clock time, quietly', () => {
  const saved = nextRecordStatus(RECORD_STATUS_INITIAL, { saved: true, at: at(10, 34, 2) });
  assert.deepEqual(saved, { savedAt: at(10, 34, 2), failed: false });
  assert.deepEqual(recordStatusView(saved), {
    state: 'saved', hidden: false, text: '이 PC에 기록됨 10:34', title: '이 PC에 기록됨 10:34:02', retry: false,
  });
  assert.equal(recordClock(at(9, 5, 7)), '09:05');
  assert.equal(recordClock(at(0, 0, 0), { seconds: true }), '00:00:00');
  assert.equal(recordClock(NaN), '');
});

test('a failed write keeps the last good time and offers [다시 기록]; the next good write clears it', () => {
  const saved = nextRecordStatus(RECORD_STATUS_INITIAL, { saved: true, at: at(10, 34) });
  const failed = nextRecordStatus(saved, { saved: false, at: at(10, 40) });
  assert.deepEqual(failed, { savedAt: at(10, 34), failed: true }, 'a failure never moves the recorded time');
  assert.deepEqual(recordStatusView(failed), {
    state: 'failed', hidden: false, text: '기록 실패', retry: true,
    title: '이 PC에 기록하지 못했습니다. 마지막 기록 10:34:00',
  });
  const neverSaved = nextRecordStatus(RECORD_STATUS_INITIAL, { saved: false, at: at(10, 40) });
  assert.equal(recordStatusView(neverSaved).title, '이 PC에 기록하지 못했습니다.');
  assert.deepEqual(nextRecordStatus(failed, { saved: true, at: at(10, 41) }), { savedAt: at(10, 41), failed: false });
  // A save that did not run (Desk still being drawn, no clock) changes nothing.
  assert.equal(nextRecordStatus(saved, { saved: undefined, at: at(11, 0) }), saved);
  assert.equal(nextRecordStatus(saved, { saved: true, at: NaN }), saved);
});

test('production top bar draws the record status from real saves only', () => {
  // persistDeskSession reports each preference write; an early return (Desk being drawn) reports nothing.
  const persist = surfaceSource.match(/  function persistDeskSession\([^]*?\n  }\n/)?.[0];
  assert.match(persist, /const saved = writeSurfacePref\(DESK_SESSION_PREF, snapshot\);\n    noteDeskRecord\(saved\);/);
  assert.ok(persist.indexOf('return false;') < persist.indexOf('noteDeskRecord('));

  const node = name => ({ name, hidden: true, textContent: '', title: '', dataset: {}, attrs: {},
    setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; } });
  const status = node('status'), text = node('text'), retry = node('retry');
  const found = { '.egd-rail-record-status': status };
  status.querySelector = selector => ({ '.egd-rail-record-text': text, '.egd-rail-record-retry': retry })[selector] || null;
  let now = at(10, 34, 2);
  const source = `let deskRecordStatus = RecordStatus.RECORD_STATUS_INITIAL;\n${topLevelFunction('noteDeskRecord')}\n${topLevelFunction('syncDeskRecordStatus')}\nreturn { noteDeskRecord, syncDeskRecordStatus };`;
  const api = new Function('RecordStatus', 'document', 'Date', source)(
    { RECORD_STATUS_INITIAL, nextRecordStatus, recordStatusView },
    { querySelector: selector => found[selector] || null }, { now: () => now });

  api.syncDeskRecordStatus();
  assert.equal(status.hidden, true, 'first run: no saved time, nothing on the bar');
  api.noteDeskRecord(true);
  assert.deepEqual([status.hidden, status.dataset.state, text.textContent, status.title, retry.hidden, status.attrs.role],
    [false, 'saved', '이 PC에 기록됨 10:34', '이 PC에 기록됨 10:34:02', true, undefined]);
  now = at(10, 40);
  api.noteDeskRecord(false);
  assert.deepEqual([status.hidden, status.dataset.state, text.textContent, retry.hidden, status.attrs.role],
    [false, 'failed', '기록 실패', false, 'alert']);
  now = at(10, 41);
  api.noteDeskRecord(true);
  assert.deepEqual([status.dataset.state, text.textContent, retry.hidden, status.attrs.role],
    ['saved', '이 PC에 기록됨 10:41', true, undefined]);
  delete found['.egd-rail-record-status'];
  assert.doesNotThrow(() => api.noteDeskRecord(true), 'saves before the top bar exists are still remembered');

  const rail = topLevelFunction('buildDeskRail');
  assert.match(rail, /class: 'egd-rail-record-status', hidden: true/);
  assert.match(rail, /class: 'egd-rail-record-retry', hidden: true, title: '이 PC에 다시 기록', 'aria-label': '이 PC에 다시 기록'/);
  assert.match(rail, /if \(!persistDeskSession\(\{ reason: 'explicit' \}\)\) boardNotice\(/);
  assert.match(rail, /queueMicrotask\(syncDeskRecordStatus\);/);
});

test('record status is muted text; only a failure is coloured, and the retry button has hover and focus states', () => {
  const rule = selector => surfaceCss.match(new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]+)\\}`))?.[1] || '';
  assert.match(rule('.egd-rail-record-status'), /color: var\(--egd-on-surface-variant\);/);
  assert.match(rule('.egd-rail-record-status[data-state="failed"]'), /color: var\(--egd-danger-ink\);/);
  assert.match(rule('.egd-rail-record-status[hidden]'), /display: none;/);
  assert.match(rule('.egd-rail-record-retry[hidden]'), /display: none;/);
  assert.match(rule('.egd-rail-record-retry'), /-moz-window-dragging: no-drag;/);
  assert.match(rule('.egd-rail-record-retry:hover'), /background: var\(--egd-hover\);/);
  assert.match(rule('.egd-rail-record-retry:focus-visible'), /outline: var\(--egd-focus-outline\);/);
  // Below the centred-search width (1200px) the quiet time gives its room to search; a failure stays.
  assert.match(surfaceCss, /@media \(max-width: 1199px\) \{\n  \.egd-rail-record-status:not\(\[data-state="failed"\]\) \{ display: none; \}\n\}/);
  assert.match(surfaceCss, /@media \(min-width: 1200px\) \{\n  \.egd-rail-left \{ min-width: 0; max-width: calc\(50% - 224px\); \}/);
});
