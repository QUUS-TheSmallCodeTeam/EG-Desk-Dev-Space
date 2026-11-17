import assert from 'node:assert/strict';
import { test } from 'node:test';

// Importing the verify script must not start the MCP server or a fixture
// server: main() runs only when the file is executed (BRW-08, Firefox NOT run here).
const { LONG_NOTE_VALUE, brw08Failures, frameHtml, pageHtml } = await import('./verify-firefox-mcp-browser-agent-observation.mjs');
const { boundedFieldValue } = await import('../helper/egdesk-browser-tool-runtime.mjs');

test('BRW-08 fixture page carries an iframe, an open shadow root, a contenteditable editor and a long value', () => {
  assert.match(pageHtml, /<iframe id="compose-frame" title="Compose" src="\/agent-observation\/frame"/);
  assert.match(pageHtml, /attachShadow\(\{ mode: 'open' \}\)\.innerHTML = '<button type="button">Shadow save<\/button>'/);
  assert.match(pageHtml, /<div id="editor" contenteditable="true" aria-label="Message body">/);
  assert.ok(LONG_NOTE_VALUE.length > 120, 'longer than the 120-character observation prefix');
  assert.ok(pageHtml.includes(`aria-label="Long note">${LONG_NOTE_VALUE}</textarea>`));
  assert.match(frameHtml, /Frame send/);
  assert.match(frameHtml, /aria-label="Frame note"/);
  // The original reveal/fill page is still there.
  assert.match(pageHtml, /id="reveal"/);
});

const good = () => ({
  frameButton: { ref: 'f1/el_7', role: 'button', tag: 'button', value: '' },
  frameInput: { ref: 'f1/el_8', role: 'textbox', tag: 'input', value: '' },
  shadowButton: { ref: 'el_9', role: 'button', tag: 'button', value: '' },
  editor: { ref: 'el_10', role: 'textbox', tag: 'div', value: boundedFieldValue('Draft body', { editor: true }) },
  longNote: { ref: 'el_11', role: 'textbox', tag: 'textarea', value: boundedFieldValue(LONG_NOTE_VALUE) },
  frameClickOk: true, shadowClickOk: true, editorFillOk: true, fillLongNoteOk: true, longNoteAfterLength: 8000,
});

test('BRW-08 checks pass a complete observation and name each missing case', () => {
  assert.deepEqual(brw08Failures(good()), []);
  const cases = [
    [b => { b.frameButton.ref = 'el_7'; }, 'iframe element ref with frame path'],
    [b => { b.frameInput = null; }, 'iframe field ref'],
    [b => { b.shadowButton = null; }, 'open shadow root element'],
    [b => { b.editor.value = 'Draft body'; }, 'contenteditable editor value hidden by length and fingerprint'],
    [b => { b.longNote.value = LONG_NOTE_VALUE; }, 'long value never shown whole'],
    [b => { b.longNote.value = boundedFieldValue(`${LONG_NOTE_VALUE}!`); }, 'long value as prefix, length and fingerprint'],
    [b => { b.longNoteAfterLength = 7999; }, 'long fill up to 8000 characters'],
    [b => { b.editorFillOk = false; }, 'editor fill'],
    [b => { b.frameClickOk = false; }, 'frame and shadow click'],
  ];
  for (const [mutate, name] of cases) {
    const value = good();
    mutate(value);
    assert.ok(brw08Failures(value).includes(name), name);
  }
  assert.ok(brw08Failures(undefined).length >= 5, 'no data is a failure, not a pass');
});

test('harness: escaped chars regex, privileged context argument, chrome:// remount', async () => {
  const { readFileSync } = await import('node:fs');
  const assert = (await import('node:assert/strict')).default;
  for (const name of ['verify-firefox-mcp-browser-agent-observation.mjs', 'verify-firefox-mcp-shapes.mjs']) {
    const source = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
    assert.ok(source.includes('context: privilegedContext'), name);
  }
  const source = readFileSync(new URL('./verify-firefox-mcp-browser-agent-observation.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('match(/\\\\[(\\\\d+) chars/)'));
  assert.ok(source.includes("'chrome://userscripts/content/eg-desk-surface.uc.js'"));
});
