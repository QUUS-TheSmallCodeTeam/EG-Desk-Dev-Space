// CNV-06 memo links: several link lines, [연결 끊기], the keyboard path of
// [다시 연결] and [다시 묻기] for a failed answer.
// Rules: overlay/resources/surface/EGDeskSurfaceMemoLink.mjs + EGDeskMemoState.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Memo from '../overlay/resources/EGDeskMemoState.sys.mjs';
import * as MemoLink from '../overlay/resources/surface/EGDeskSurfaceMemoLink.mjs';
import * as SurfaceKeys from '../overlay/resources/surface/EGDeskSurfaceKeys.mjs';

const source = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
function surfaceFunction(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = source.indexOf('\n  }', start);
  return source.slice(start, end + 4);
}
function fakeNode(attrs = {}) {
  const node = { dataset: attrs.data || {}, style: {}, children: [], parentNode: null, hidden: attrs.hidden === true, isConnected: true,
    classList: { contains: name => (attrs.class || '').split(/\s+/).includes(name) }, ...attrs,
    insertBefore(child, before) { child.parentNode = node; node.children.splice(Math.max(0, node.children.indexOf(before)), 0, child); return child; },
    remove() { node.isConnected = false; if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(item => item !== node); } };
  return node;
}

const cardA = { id: 'card-a', label: '보고서', rect: { x: 0, y: 0, width: 400, height: 300 } };
const cardB = { id: 'card-b', label: '표', rect: { x: 1000, y: 0, width: 400, height: 300 } };
const cardC = { id: 'card-c', label: '그림', rect: { x: 0, y: 900, width: 400, height: 300 } };
const memoAt = (extra = {}) => Memo.normalizeMemoRecord({ id: 'memo-1', anchor: { kind: 'card', cardId: 'card-a', x: 1, y: 0, at: { x: 600, y: 0 }, offset: { x: 200, y: 0 }, label: '보고서' },
  text: '확인', createdAt: 1, ...extra });

test('memo links: one line to the anchor window and one per extra link, skipping closed or touching windows', () => {
  const memo = memoAt({ links: [{ targetViewId: 'card-b', label: '표' }, { targetViewId: 'card-c' }, { targetViewId: 'gone' }] });
  const rects = new Map([cardA, cardB, cardC].map(card => [card.id, card.rect]));
  const lines = MemoLink.memoLinkLines(memo, { memoRect: { x: 600, y: 0, width: 240, height: 160 }, rectOf: id => rects.get(id) || null, segment: Memo.memoTetherSegment });
  assert.deepEqual(lines.map(line => [line.key, line.kind]), [['anchor:card-a', 'anchor'], ['link:card-b', 'link'], ['link:card-c', 'link']]);
  assert.equal(lines[1].label, '표');
  assert.ok(lines.every(line => line.segment.length > 0));
  // A '대상 없음' memo draws no anchor line; a link to the anchor window is not drawn twice.
  const detached = MemoLink.memoLinkLines({ ...memo, links: [{ targetViewId: 'card-a' }] }, { memoRect: { x: 600, y: 0, width: 240, height: 160 },
    rectOf: id => rects.get(id), segment: Memo.memoTetherSegment, anchorAttached: false });
  assert.deepEqual(detached.map(line => line.key), ['link:card-a']);
  assert.deepEqual(MemoLink.memoLinkLines(memo, { memoRect: null, rectOf: () => null, segment: Memo.memoTetherSegment }), []);
});

test('memo unlink: the anchor window comes off (the memo stays put), an extra link is cut, names follow open windows', () => {
  const memo = memoAt({ links: [{ targetViewId: 'card-b', label: '옛 표' }] });
  const choices = MemoLink.memoUnlinkChoices(memo, { titleOf: id => (id === 'card-b' ? '새 표' : '') });
  assert.deepEqual(choices.map(choice => [choice.kind, choice.targetId, choice.label]), [['anchor', 'card-a', '보고서에서 떼기'], ['link', 'card-b', '새 표 연결 끊기']]);
  const free = Memo.detachMemo(memo, { x: 610, y: 5 }, { now: 50 });
  assert.deepEqual(free.anchor, { kind: 'canvas', x: 610, y: 5 });
  assert.deepEqual(free.links, memo.links, 'extra links stay');
  assert.equal(free.updatedAt, 50);
  assert.deepEqual(Memo.detachMemo(memo, null).anchor, { kind: 'canvas', x: 600, y: 0 }, 'without a point the last world point is kept');
  assert.equal(Memo.detachMemo(free, { x: 0, y: 0 }), free, 'a free memo is unchanged');
  assert.deepEqual(Memo.unlinkMemo(memo, 'card-b').links, []);
  assert.deepEqual(MemoLink.memoUnlinkChoices(free).map(choice => choice.kind), ['link']);
});

test('memo relink list: open windows nearest the memo first, the current window marked, memos themselves excluded', () => {
  const memo = memoAt();
  const rows = MemoLink.memoRelinkCandidates(memo, [cardC, cardB, cardA, { id: 'memo-1', label: '메모', rect: cardA.rect }, { id: 'bad', rect: null }],
    { memoRect: { x: 600, y: 0, width: 240, height: 160 } });
  // Centres: memo (720, 80), 표 (1200, 150) is nearer than 보고서 (200, 150).
  assert.deepEqual(rows.map(row => row.id), ['card-b', 'card-a', 'card-c']);
  assert.deepEqual(rows[1], { id: 'card-a', label: '보고서 (지금 연결됨)', current: true });
  assert.equal(MemoLink.memoRelinkCandidates(memo, [cardA, cardB], { limit: 1 }).length, 1);
});

test('memo failed answer: a failed run keeps a [다시 묻기] row; cancelled closes; closing the row clears it', () => {
  assert.equal(MemoLink.memoAskEndStatus('failed'), 'failed');
  assert.equal(MemoLink.memoAskEndStatus('interrupted'), 'failed');
  assert.equal(MemoLink.memoAskEndStatus('unavailable'), 'failed');
  assert.equal(MemoLink.memoAskEndStatus('cancelled'), 'cancelled');
  assert.equal(MemoLink.memoAskEndStatus('completed'), null);
  const asked = Memo.recordMemoAsk(memoAt(), Memo.memoAskDraft(memoAt(), { agentId: 'agent-1', question: '요약?' }), { now: 10, requestId: 'req-1' });
  const failed = Memo.failMemoAsk(asked, 'ask-1', { now: 20 });
  assert.equal(failed.asks[0].status, 'failed');
  assert.equal(Memo.failMemoAsk(failed, 'ask-1'), failed, 'only a pending ask fails');
  assert.deepEqual(Memo.failedMemoAsks(failed).map(ask => ask.askId), ['ask-1']);
  assert.equal(Memo.normalizeMemoRecord(failed).asks[0].status, 'failed', 'kept through save and restore');
  assert.deepEqual(MemoLink.memoFailedAskRows(failed, { nameOf: () => '리서처' }), [{ askId: 'ask-1', agentId: 'agent-1', text: '리서처 답을 받지 못했습니다',
    retry: '다시 묻기', retryTitle: '리서처에게 이 메모를 지금 내용으로 다시 보냅니다.', dismiss: '닫기' }]);
  const cleared = Memo.clearFailedMemoAsk(failed, 'ask-1');
  assert.equal(cleared.asks[0].status, 'cancelled');
  assert.deepEqual(MemoLink.memoFailedAskRows(cleared), []);
  // A new question after a failure gets a new ask id.
  assert.equal(Memo.memoAskDraft(cleared, { agentId: 'agent-1' }).askId, 'ask-2');
});

test('memo wiring: extra links draw dashed lines in the Canvas layer and leave with their link', () => {
  const layer = fakeNode({ id: 'egd-canvas-layer' });
  const nodes = new Map();
  for (const card of [cardA, cardB, cardC]) {
    const node = fakeNode({ id: card.id, class: 'egd-canvas-card', geometry: { ...card.rect } });
    node.parentNode = layer; layer.children.push(node); nodes.set(card.id, node);
  }
  const root = fakeNode({ id: 'egd-memo-card-1', class: 'egd-canvas-card egd-memo-card', geometry: { x: 600, y: 0, width: 240, height: 160 },
    data: { memoAnchor: 'attached' }, _memoRecord: memoAt({ links: [{ targetViewId: 'card-b' }, { targetViewId: 'card-c' }] }) });
  root.parentNode = layer; layer.children.push(root);
  const scope = { document: { getElementById: id => nodes.get(id) || null }, MemoState: Memo, MemoLink,
    persistentEntityGeometry: node => node.geometry, el: (tag, attrs) => fakeNode(attrs) };
  const sync = Function(...Object.keys(scope), `${surfaceFunction('syncMemoExtraLinkLines')}\n${surfaceFunction('syncMemoTether')}\nreturn syncMemoTether;`)(...Object.values(scope));
  sync(root);
  const dashed = layer.children.filter(node => node.data?.testid === 'memo-link-line');
  assert.deepEqual(dashed.map(node => [node.data.kind, node.data.targetId]), [['link', 'card-b'], ['link', 'card-c']]);
  assert.ok(root._memoTether, 'the anchor line is still the solid tether');
  sync(root);
  assert.equal(layer.children.filter(node => node.data?.testid === 'memo-link-line').length, 2, 'lines are reused, not duplicated');
  root._memoRecord = Memo.unlinkMemo(root._memoRecord, 'card-c');
  sync(root);
  assert.deepEqual(layer.children.filter(node => node.data?.testid === 'memo-link-line').map(node => node.data.targetId), ['card-b']);
  nodes.delete('card-b');
  sync(root);
  assert.equal(layer.children.filter(node => node.data?.testid === 'memo-link-line').length, 0, 'a closed window loses its line');
});

test('memo wiring: Enter on [다시 연결] opens a window list; arrows move and a pick pins the memo; [다시 묻기] and [연결] are on the memo', () => {
  const listeners = [];
  const windowStub = { addEventListener(type, handler, options = {}) { listeners.push({ type, handler, signal: options.signal }); }, setTimeout(fn) { fn(); } };
  const focused = [];
  const button = attrs => { const node = { ...attrs, focus() { focused.push(node.data.cardId); doc.activeElement = node; } }; return node; };
  const doc = { activeElement: null, documentElement: { setAttribute() {}, removeAttribute() {} }, getElementById: id => (id === 'card-b' ? cardNode : null) };
  const cardNode = { id: 'card-b', classList: { contains: () => false } };
  const list = { hidden: true, attrs: {}, children: [], replaceChildren(...items) { this.children = items; }, setAttribute(name, value) { this.attrs[name] = value; } };
  const part = () => ({ hidden: false, textContent: '', attrs: {}, setAttribute(name, value) { this.attrs[name] = value; }, focus() {} });
  const root = { _memoRecord: memoAt({ anchor: { kind: 'card', cardId: 'closed', x: 0.5, y: 0.5, at: { x: 600, y: 0 } } }), isConnected: true, offsetLeft: 600, offsetTop: 0,
    dataset: { memoAnchor: 'missing' }, contains: () => false, _memoRelinkList: list, _memoMissing: { row: part(), label: part(), relink: part(), remove: part() } };
  const scope = {
    document: doc, window: windowStub, AbortController, MemoState: Memo, MemoLink, SurfaceKeys, boardNotice() {},
    persistentEntityGeometry: node => (node === root ? { x: 600, y: 0, width: 240, height: 160 } : { ...cardB.rect, zIndex: 1 }),
    cardLabelForViewportRail: () => '표', syncMemoTether() {}, memoTargetLabel: () => '',
    memoAnchorCandidates: () => [cardC, cardB], el: (tag, attrs, text) => button({ ...attrs, text }),
    updateMemoRecord(target, next, reason) { target._memoRecord = next; target._reason = reason; },
  };
  const api = Function(...Object.keys(scope), `let memoRelink = null;\n${['syncMemoLinkUi', 'relinkMemoTo', 'renderMemoRelinkList', 'toggleMemoRelink'].map(surfaceFunction).join('\n')}\nreturn { toggleMemoRelink };`)(...Object.values(scope));
  api.toggleMemoRelink(root, { keyboard: true });
  assert.equal(list.hidden, false);
  assert.deepEqual(list.children.map(item => item.data.cardId), ['card-b', 'card-c'], 'nearest window first');
  assert.deepEqual(focused, ['card-b']);
  const down = { key: 'ArrowDown', preventDefault() { this.prevented = true; }, stopPropagation() {} };
  list.onkeydown(down);
  assert.deepEqual([focused.at(-1), down.prevented], ['card-c', true]);
  list.onkeydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  assert.equal(focused.at(-1), 'card-b', 'wraps');
  doc.activeElement.onclick({ stopPropagation() {} });
  assert.equal(root._memoRecord.anchor.cardId, 'card-b');
  assert.equal(root._reason, 'memo-relink');
  assert.equal(list.hidden, true, 'the list closes after a pick');
  // A mouse press on the button (detail 1) keeps the old "press a window" mode only.
  assert.match(source, /toggleMemoRelink\(root, \{ keyboard: ev\.detail === 0 \}\)/);
  assert.match(source, /data: \{ testid: 'memo-ask-retry' \}/);
  assert.match(source, /data: \{ testid: 'memo-links', noWindowDrag: 'true' \}/);
  assert.match(source, /MemoState\.failMemoAsk\(found\.memo, found\.ask\.askId\)/);
});
