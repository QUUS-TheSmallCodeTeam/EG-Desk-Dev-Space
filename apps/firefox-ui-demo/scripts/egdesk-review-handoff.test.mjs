#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewFlow, createReviewStore, reviewDialogContent, reviewHandoffSupported, REVIEW_RECORD_LIMIT } from '../overlay/resources/EGDeskReviewHandoff.sys.mjs';

const ID = 'f7e41ccd-40bf-44fe-8dbf-11590f5d4358';
const DIGEST = 'c'.repeat(64);
const pair = { requestId: ID, requestDigest: DIGEST };
const draft = { recipient: '검토 담당', question: '질문?', excerpt: '첫 줄\n<문서> & 본문', expectedReply: '의견' };
const request = { kind: 'request', ...pair, ...draft };
const reply = { kind: 'reply', ...pair, answer: '좋습니다.\n<b>문자 그대로</b>' };
const bytes = new Uint8Array([10, 20, 30]);
const fakeElement = (tag, props, ...children) => ({ tag, props, children: children.filter(child => child != null), value: '' });
const descendants = list => list.flatMap(node => typeof node === 'object' ? [node, ...descendants(node.children)] : []);
const text = node => typeof node === 'string' ? node : node.children.map(text).join('');
const deferred = () => { let release; const done = new Promise(resolve => { release = resolve; }); return { done, release }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const ledger = () => ({ serialized: '', writes: 0 });
function host({ disk = ledger(), withBoard = true } = {}) {
  const a = { id: 'A', title: '원래 Board' }, b = { id: 'B', title: '다른 Board' };
  const boards = new Map(withBoard ? [[a.id, a], [b.id, b]] : []);
  const mock = { epoch: 0, supported: true, incoming: request, picked: { bytes }, calls: [] };
  const store = createReviewStore({ read: () => disk.serialized, write: value => { disk.serialized = value; disk.writes++; } });
  const flow = createReviewFlow({ store, supported: () => mock.supported,
    getContext: () => ({ epoch: mock.epoch }), isContextCurrent: context => context.epoch === mock.epoch,
    getBoard: id => boards.get(id), isBoardCurrent: board => boards.get(board.id) === board,
    pickFile: ({ signal }) => { mock.pickerSignal = signal; return mock.picked; },
    request: async (_method, path, body, { signal }) => {
      mock.calls.push({ path, body, signal });
      if (path.endsWith('/inspect')) {
        if (mock.locked && !body.passphrase) return { status: 200, body: { encrypted: true, locked: true } };
        if (mock.locked && body.passphrase !== '공유파일-테스트') return { status: 400, body: { code: 'PORTABLE_PASSPHRASE_INVALID' } };
        return { status: 200, body: { review: mock.incoming, locked: false, encrypted: !!mock.locked } };
      }
      if (mock.pending) await mock.pending;
      return { status: 201, body: { review: body.review.kind === 'request' ? { ...body.review, ...pair } : body.review,
        fileName: 'mock.egdesk', displayPath: '~/Downloads/mock.egdesk', encrypted: !!body.passphrase } };
    },
  });
  let tree = [];
  function panel() { tree = reviewDialogContent(fakeElement, flow.view(), flow).children; }
  const find = id => descendants(tree).find(node => node.props?.data?.testid === `review-${id}`);
  function field(id, value) { const input = find(id); assert.ok(input, id); input.value = value; }
  function click(id) {
    const control = find(id); assert.ok(control, id);
    if (control.props.type === 'submit') descendants(tree).find(node => node.tag === 'form').props.onsubmit({ preventDefault() {} });
    else control.props.onclick();
  }
  async function choose() { flow.openFile(); panel(); click('choose'); await tick(); panel(); }
  function compose(values = draft) { flow.openRequest(a); panel(); for (const [key, value] of Object.entries(values)) field(key, value); click('preview'); panel(); }
  return { disk, store, a, b, boards, mock, flow, panel, find, click, field, choose, compose };
}

test('manual round trip: blank Board form, exact previews, two profiles and explicit durable return', async () => {
  const sender = host();
  sender.flow.openRequest(sender.a); sender.panel();
  for (const key of Object.keys(draft)) assert.equal(sender.find(key).value, '');
  sender.compose({ ...draft, question: ' 질문? ', excerpt: ' 첫 줄\r\n<문서> & 본문 ' });
  for (const [key, value] of Object.entries(draft)) assert.equal(text(sender.find(`value-${key}`)), value);
  assert.equal(sender.mock.calls.length, 0);
  sender.click('export'); await tick(); sender.panel();
  assert.equal(sender.flow.view().step, 'exported');
  assert.deepEqual(sender.mock.calls[0].body, { review: { kind: 'request', ...draft } });
  assert.equal(sender.disk.writes, 1);

  const recipient = host({ withBoard: false });
  await recipient.choose();
  assert.equal(recipient.flow.view().step, 'request-inspected');
  assert.equal(text(recipient.find('value-excerpt')), draft.excerpt);
  assert.equal(recipient.disk.writes, 0);
  recipient.click('reply'); recipient.panel();
  assert.equal(recipient.find('answer').value, '');
  recipient.field('answer', reply.answer); recipient.click('preview'); recipient.panel();
  assert.equal(text(recipient.find('value-answer')), reply.answer);
  assert.equal(recipient.find('value-question'), undefined);
  recipient.click('export'); await tick();
  assert.deepEqual(recipient.mock.calls.at(-1).body, { review: reply });
  assert.equal(recipient.disk.writes, 0);
  recipient.mock.incoming = reply;
  await recipient.choose();
  assert.equal(recipient.find('return'), undefined);

  const reopened = host({ disk: sender.disk });
  reopened.mock.incoming = { ...reply, requestDigest: 'a'.repeat(64) };
  await reopened.choose();
  assert.equal(reopened.find('return'), undefined);
  reopened.mock.incoming = reply;
  await reopened.choose();
  assert.equal(reopened.flow.view().boardTitle, reopened.a.title);
  assert.equal(reopened.disk.writes, 1);
  reopened.click('return'); reopened.panel();
  assert.equal(reopened.flow.view().step, 'returned');
  assert.equal(reopened.disk.writes, 2);
  await reopened.choose();
  assert.equal(reopened.find('return'), undefined);
  assert.equal(reopened.disk.writes, 2);
  const secondReopen = host({ disk: sender.disk });
  secondReopen.flow.openResults(secondReopen.a); secondReopen.panel();
  assert.equal(text(secondReopen.find('value-answer')), reply.answer);
  secondReopen.flow.openResults(secondReopen.b); secondReopen.panel();
  assert.equal(secondReopen.find('value-answer'), undefined);
});

test('cancel or change same-profile context while choosing: no inspect or mutation', async () => {
  const h = host();
  h.mock.picked = null;
  await h.choose();
  assert.equal(h.flow.view().step, 'choose');
  assert.equal(h.mock.calls.length, 0);
  const picker = deferred(); h.mock.picked = picker.done;
  h.click('choose'); h.panel(); h.click('close');
  assert.equal(h.mock.pickerSignal.aborted, true);
  picker.release({ bytes }); await tick();
  assert.equal(h.flow.view(), null);
  const next = deferred(); h.mock.picked = next.done;
  h.flow.openFile(); h.panel(); h.click('choose');
  h.mock.epoch++; h.flow.invalidate(); next.release({ bytes }); await tick();
  assert.equal(h.flow.view().step, 'stopped');
  assert.equal(h.mock.calls.length, 0);
  assert.equal(h.disk.writes, 0);
  h.compose(); h.panel(); h.click('close');
  assert.equal(h.mock.calls.length, 0);
});

test('accept revalidates the same mounted Board; import invalidation cannot rebind', async () => {
  const h = host(); h.store.issue(h.a.id, request);
  h.mock.incoming = reply;
  await h.choose();
  h.boards.delete(h.a.id);
  h.click('return');
  assert.equal(h.flow.view().step, 'stopped');
  assert.equal(h.disk.writes, 1);
  await h.choose(); assert.equal(h.find('return'), undefined);
  h.store.forgetBoards([h.a.id]);
  h.boards.set(h.a.id, { id: h.a.id, title: '가져온 Board' });
  await h.choose(); assert.equal(h.find('return'), undefined);
  assert.equal(h.disk.writes, 2);
});

test('export receipt is not registered after context changes; a double-submit sends one request', async () => {
  const h = host(); const wait = deferred(); h.mock.pending = wait.done;
  h.compose(); h.click('export'); h.click('export');
  assert.equal(h.mock.calls.length, 1);
  h.mock.epoch++; h.flow.invalidate();
  assert.equal(h.mock.calls[0].signal.aborted, true);
  wait.release(); await tick();
  assert.equal(h.flow.view().step, 'stopped');
  assert.equal(h.disk.writes, 0);
});

test('optional excerpt, password retry without persistence, byte size, unsupported bridge and bounded records', async () => {
  const h = host(); h.compose({ ...draft, excerpt: '' });
  assert.equal(text(h.find('value-excerpt')), '');
  h.field('passphrase', '다른-파일암호들이'); h.click('export'); h.panel();
  assert.equal(h.mock.calls.length, 0);
  assert.equal(h.find('passphrase').value, '');
  h.mock.locked = true; await h.choose(); assert.equal(h.flow.view().step, 'locked');
  h.field('passphrase', 'wrong'); h.click('unlock'); await tick(); h.panel();
  assert.equal(h.flow.view().step, 'locked'); assert.equal(h.find('passphrase').value, '');
  h.field('passphrase', '공유파일-테스트'); h.click('unlock'); await tick();
  assert.equal(h.flow.view().step, 'request-inspected'); assert.equal(h.disk.writes, 0);
  h.compose({ ...draft, recipient: '한'.repeat(86) });
  assert.equal(h.flow.view().step, 'request-draft'); assert.ok(h.find('error'));
  h.mock.supported = false; h.flow.invalidate(); assert.equal(h.flow.view().step, 'stopped');
  assert.equal(h.flow.openRequest(h.a), null);
  assert.equal(reviewHandoffSupported({ capabilities: { portable: ['inspect'] } }), false);
  assert.equal(reviewHandoffSupported({ capabilities: { portable: ['reviewHandoff'] } }), true);
  const first = { ...pair, requestId: ID.slice(0, -4) + '0000' };
  for (let i = 0; i <= REVIEW_RECORD_LIMIT; i++) h.store.issue(h.a.id, { ...pair, requestId: ID.slice(0, -4) + i.toString(16).padStart(4, '0') });
  assert.equal(h.store.find(first), null);
  assert.equal(JSON.parse(h.disk.serialized).rows.length, REVIEW_RECORD_LIMIT);
});
