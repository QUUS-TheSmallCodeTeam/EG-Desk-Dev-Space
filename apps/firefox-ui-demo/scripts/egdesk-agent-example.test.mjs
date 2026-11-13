import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const surfaceSource = fs.readFileSync(path.join(root, 'overlay/JS/eg-desk-surface.uc.js'), 'utf8');
const surfaceCss = fs.readFileSync(path.join(root, 'overlay/CSS/eg-desk-surface.uc.css'), 'utf8');

const slice = (from, to) => {
  const first = surfaceSource.indexOf(from), last = surfaceSource.indexOf(to, first);
  assert.ok(first >= 0 && last > first, `source markers: ${from.trim().slice(0, 40)}`);
  return surfaceSource.slice(first, last);
};

test('AGENT-02 a blank new Agent form gets a name, two tasks and one speech note', () => {
  const form = ChatState.profileFormFromBody(null);
  const fill = ChatState.profileExampleFill(form);
  assert.equal(fill.label, '예시로 채우기');
  assert.equal(fill.disabled, false);
  assert.deepEqual(Object.keys(fill.patch), ['name', 'expertise', 'speechNotes']);
  assert.equal(fill.patch.expertise.length, 2);
  assert.deepEqual(fill.filled, ['담당자 이름', '맡길 일', '말투 메모']);
  assert.match(fill.note, /빈칸에만/);
  assert.match(fill.note, /\[초안 저장\]/, 'the note says nothing is saved yet');
  assert.match(fill.notice, /담당자 이름 · 맡길 일 · 말투 메모/);
  assert.match(fill.notice, /\[초안 저장\]/);
  assert.deepEqual(form, ChatState.profileFormFromBody(null), 'the form is not touched until the patch is applied');
  const checked = ChatState.validateProfileForm({ ...form, ...fill.patch });
  assert.deepEqual(checked.errors, [], 'the example passes the same checks as a typed draft');
});

test('AGENT-02 the example never replaces what the user already typed', () => {
  const form = { ...ChatState.profileFormFromBody(null), name: '  내 담당자 ', expertise: ['계약서 검토'] };
  const fill = ChatState.profileExampleFill(form);
  assert.deepEqual(Object.keys(fill.patch), ['speechNotes']);
  assert.deepEqual(fill.filled, ['말투 메모']);
  assert.equal(fill.disabled, false);

  const full = ChatState.profileExampleFill({ ...form, speechNotes: '짧게' });
  assert.deepEqual(full.patch, {});
  assert.equal(full.disabled, true);
  assert.equal(full.notice, null);
  assert.equal(full.note, '담당자 이름·맡길 일·말투 메모가 이미 채워져 있습니다.');

  const blanks = ChatState.profileExampleFill({ name: '   ', expertise: [' ', ''], speechNotes: '\n' });
  assert.deepEqual(blanks.filled, ['담당자 이름', '맡길 일', '말투 메모'], 'whitespace counts as blank');
  assert.deepEqual(ChatState.profileExampleFill(null).filled, ['담당자 이름', '맡길 일', '말투 메모']);
});

test('AGENT-02 two fills hand out separate task lists', () => {
  const a = ChatState.profileExampleFill({}), b = ChatState.profileExampleFill({});
  assert.notEqual(a.patch.expertise, b.patch.expertise);
  a.patch.expertise.push('x');
  assert.equal(b.patch.expertise.length, 2);
});

// --- DOM wiring: the row in Settings > Agent 관리 > Agent 만들기 ---

const el = (tag, props = {}, ...children) => ({ tag, props, children: children.filter(child => child != null) });
const rowFor = (form, agents, redraw) => new Function('el', 'ChatState', 'form', 'agents', 'renderAgentsTab',
  `${slice('      const exampleFillRow = ', '      const section = el(\'section\', { class: \'egd-settings-section egd-settings-agent-form\'')}\nreturn exampleFillRow;`)(
  el, ChatState, form, agents, redraw)();

test('AGENT-02 pressing [예시로 채우기] fills the blanks in place, says so, and saves nothing', () => {
  const form = { ...ChatState.profileFormFromBody(null), name: '내 담당자' };
  const agents = { profileId: null, notice: null, focusField: null, busy: false };
  let redraws = 0;
  const row = rowFor(form, agents, () => { redraws++; });
  const [button, note] = row.children;
  assert.equal(button.tag, 'button');
  assert.equal(button.props.type, 'button');
  assert.equal(button.props.data.testid, 'settings-agent-example-fill');
  assert.equal(button.props.disabled, null);
  assert.equal(button.children[0], '예시로 채우기');
  assert.match(note.children[0], /빈칸에만/);

  const before = form;
  button.props.onclick();
  assert.equal(form, before, 'same form object: typed text, chips and scroll stay with it');
  assert.equal(form.name, '내 담당자', 'the typed name stays');
  assert.equal(form.expertise.length, 2);
  assert.ok(form.speechNotes);
  assert.match(agents.notice, /맡길 일 · 말투 메모/);
  assert.equal(agents.focusField, 'expertise', 'focus lands on the first filled field');
  assert.equal(redraws, 1);
  assert.deepEqual(Object.keys(agents).sort(), ['busy', 'focusField', 'notice', 'profileId'], 'no save, no activation');

  // Everything is filled now: the redrawn row is off and a stale click does nothing.
  const again = rowFor(form, agents, () => { redraws++; });
  assert.equal(again.children[0].props.disabled, 'true');
  assert.match(again.children[1].children[0], /이미 채워져 있습니다/);
  agents.notice = null;
  button.props.onclick();
  assert.equal(agents.notice, null);
  assert.equal(form.expertise.length, 2);
});

test('AGENT-02 the row shows only while making a new Agent, above the first field', () => {
  const formSource = slice('    const renderAgentForm = () => {', '    const renderAgentsTab = () => {');
  assert.match(formSource, /agents\.profileId \? null : exampleFillRow\(\),\s*field\('name', '담당자 이름 \(필수\)', nameInput\),/);
  assert.doesNotMatch(slice('      const exampleFillRow = ', '      const section = el('), /saveDraft|profileSave|activate/,
    'the example only fills the draft');
  assert.match(surfaceCss, /\.egd-settings-reset-row, \.egd-settings-example-row \{ display: flex;/);
});
