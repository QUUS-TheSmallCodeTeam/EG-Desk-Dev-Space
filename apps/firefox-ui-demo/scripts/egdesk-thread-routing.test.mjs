import test from 'node:test';
import assert from 'node:assert/strict';
import * as Routing from '../overlay/resources/EGDeskThreadRouting.sys.mjs';
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs';

const dm = (overrides = {}) => ({
  id: 'thread-dm-1', type: 'dm', title: 'Rio', participants: ['나', 'Rio'], updatedAt: 10, localConversationId: 'local-1',
  messages: [
    { id: 'msg-a', localMessageId: 'msg-a', role: 'user', content: '시안 A가 낫다', status: 'complete', localSeq: 2, createdAt: 1000 },
    { id: 'msg-b', localMessageId: 'msg-b', role: 'assistant', content: '네, A안이 대비가 좋습니다.', status: 'complete', localSeq: 4, createdAt: 2000 },
    { id: 'live-c', role: 'user', content: '그럼 B는?', status: 'complete', createdAt: 3000 },
    { id: 'stream-d', role: 'assistant', content: '생각 중', status: 'streaming', createdAt: 3500 },
  ],
  ...overrides,
});
const board = (overrides = {}) => ({
  id: 'thread-group-1', type: 'group', title: '회의 준비', participants: ['나', '코덱스 어시스턴트', '디자인 리뷰어'], updatedAt: 20, localConversationId: 'local-2',
  messages: [
    { id: 'b-1', localMessageId: 'b-1', role: 'user', content: 'Board 시작', status: 'complete', localSeq: 1, createdAt: 500 },
    { id: 'b-2', localMessageId: 'b-2', role: 'assistant', content: '@나 확인해 주세요', status: 'complete', localSeq: 3, createdAt: 1500 },
  ],
  unreadCount: 0, ...overrides,
});

test('CHAT-03: only finished, saved bubbles resolve to store ids; live or streaming ones are reported missing', () => {
  const picked = Routing.resolveShareMessages(dm(), ['stream-d', 'live-c', 'msg-b', 'msg-a']);
  assert.deepEqual(picked.localMessageIds, ['msg-a', 'msg-b'], 'room order, not pick order');
  assert.deepEqual(picked.missing, ['live-c', 'stream-d']);
  assert.deepEqual(picked.messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(Routing.shareableMessage({ role: 'user', content: '  ', status: 'complete' }), false);
});

test('CHAT-03: the share request names both rooms by their bridge binding and keeps at most 20 distinct ids', () => {
  const from = dm({ clientBindingId: 'thread-dm-1-binding-3' });
  const body = Routing.buildShareRequest(from, board(), ['msg-a', 'msg-b', 'msg-a']);
  assert.deepEqual(body, { fromClientThreadId: 'thread-dm-1-binding-3', toClientThreadId: 'thread-group-1', localMessageIds: ['msg-a', 'msg-b'] });
  assert.equal(body.fromClientThreadId, ChatState.clientThreadBinding(from));
  const many = Routing.buildShareRequest(dm(), board(), Array.from({ length: 25 }, (_, index) => `m-${index}`), 'share-x');
  assert.equal(many.localMessageIds.length, Routing.MAX_SHARED_MESSAGES);
  assert.equal(many.shareId, 'share-x');
});

test('CHAT-03: Board Thread choices list group rooms newest first and never the sending DM', () => {
  const rooms = [dm(), board(), board({ id: 'thread-group-2', title: '옛 Board', updatedAt: 5, localConversationId: null }), { id: 'x', type: 'dm', title: 'Codex' }];
  assert.deepEqual(Routing.boardThreadChoices(rooms, dm()), [
    { id: 'thread-group-1', title: '회의 준비', memberCount: 3, saved: true },
    { id: 'thread-group-2', title: '옛 Board', memberCount: 3, saved: false },
  ]);
});

test('CHAT-03: store events build the routing view on both sides and the immediate result matches it', () => {
  const inEvent = { seq: 6, ts: 4000, event: 'messages.shared.in', details: { shareId: 'share-1', link: { clientThreadId: 'thread-dm-1', localMessageIds: ['msg-a', 'msg-b'] },
    messageCount: 2, messages: [{ localMessageId: 'msg-a', role: 'user', text: '시안 A가 낫다' }, { localMessageId: 'msg-b', role: 'assistant', text: '네, A안이 대비가 좋습니다.' }] } };
  const outEvent = { seq: 9, ts: 4000, event: 'messages.shared.out', details: { shareId: 'share-1', link: { clientThreadId: 'thread-group-1' }, messageCount: 2, localMessageIds: ['msg-a', 'msg-b'] } };
  const received = Routing.routingWithEvents(Routing.emptyRouting(), [{ event: 'run.started', details: {} }, inEvent]);
  assert.equal(received.sharedIn.length, 1);
  assert.deepEqual(received.sharedIn[0].localMessageIds, ['msg-a', 'msg-b']);
  assert.equal(received.sharedIn[0].fromClientThreadId, 'thread-dm-1');
  assert.equal(received.sharedIn[0].messages[1].role, 'assistant');
  // The same event read again (a second page or a restart) does not duplicate the block.
  assert.equal(Routing.routingWithEvents(received, [inEvent]).sharedIn.length, 1);
  const sent = Routing.routingWithEvents(Routing.emptyRouting(), [outEvent]);
  assert.deepEqual(Object.keys(sent.sharedOut), ['msg-a', 'msg-b']);
  assert.equal(Routing.sharedOutMark(sent, { localMessageId: 'msg-a' }).toClientThreadId, 'thread-group-1');
  assert.equal(Routing.sharedOutMark(sent, { localMessageId: 'live-c' }), null);

  const result = { accepted: true, shareId: 'share-1', fromClientThreadId: 'thread-dm-1', toClientThreadId: 'thread-group-1', messageCount: 2, attach: 'nextTurn' };
  const copies = Routing.resolveShareMessages(dm(), ['msg-a', 'msg-b']).messages;
  const liveReceived = Routing.routingAfterReceive(Routing.emptyRouting(), result, copies, 4000);
  assert.deepEqual(liveReceived.sharedIn[0].messages.map(message => message.text), received.sharedIn[0].messages.map(message => message.text));
  assert.equal(liveReceived.sharedIn[0].seq, null, 'not saved yet; the store names the seq later');
  const liveSent = Routing.routingAfterSend(Routing.emptyRouting(), result, ['msg-a', 'msg-b'], 4000);
  assert.deepEqual(Object.keys(liveSent.sharedOut), Object.keys(sent.sharedOut));
  // The store's read later replaces the live entry under the same shareId.
  assert.equal(Routing.routingWithEvents(liveReceived, [inEvent]).sharedIn[0].seq, 6);
});

test('CHAT-03: copied blocks sit before the first bubble saved after them; unsaved ones close the room', () => {
  const routing = Routing.routingWithEvents(Routing.emptyRouting(), [
    { seq: 2, ts: 900, event: 'messages.shared.in', details: { shareId: 'early', link: { clientThreadId: 'thread-dm-1', localMessageIds: ['msg-a'] }, messages: [{ localMessageId: 'msg-a', role: 'user', text: 'x' }] } },
    { seq: 0, ts: 100, event: 'messages.shared.in', details: { shareId: 'first', link: { clientThreadId: 'thread-dm-1', localMessageIds: [] }, messages: [{ role: 'user', text: 'y' }] } },
  ]);
  const live = Routing.routingAfterReceive(routing, { shareId: 'live', fromClientThreadId: 'thread-dm-1' }, [{ localMessageId: 'msg-b', role: 'assistant', text: 'z' }]);
  const placed = Routing.sharedBlockPlacement(live, board().messages);
  assert.deepEqual(placed.beforeMessageId.get('b-1').map(share => share.shareId), ['first'], 'saved before every bubble');
  assert.deepEqual(placed.beforeMessageId.get('b-2').map(share => share.shareId), ['early'], 'between b-1 (seq 1) and b-2 (seq 3)');
  assert.deepEqual(placed.trailing.map(share => share.shareId), ['live']);
  assert.deepEqual(Routing.sharedBlockPlacement(live, []).trailing.map(share => share.shareId), ['first', 'early', 'live']);
  const late = Routing.routingWithEvents(Routing.emptyRouting(), [{ seq: 9, ts: 9000, event: 'messages.shared.in', details: { shareId: 'late', link: {}, messages: [{ role: 'user', text: 'w' }] } }]);
  assert.deepEqual(Routing.sharedBlockPlacement(late, board().messages).trailing.map(share => share.shareId), ['late'], 'newer than every bubble');
});

test('CHAT-03: the Board Thread returns to the DM that last sent to it, and the origin link finds the copied bubble', () => {
  const routing = Routing.routingWithEvents(Routing.emptyRouting(), [{ seq: 6, ts: 4000, event: 'messages.shared.in',
    details: { shareId: 'share-1', link: { clientThreadId: 'thread-dm-1', localMessageIds: ['msg-b'] }, messages: [{ localMessageId: 'msg-b', role: 'assistant', text: 'z' }] } }]);
  const room = board({ routing });
  const rooms = [dm(), room];
  assert.equal(Routing.returnToDmTarget(room, rooms).id, 'thread-dm-1');
  assert.equal(Routing.returnToDmTarget(room, [room]), null, 'the DM left this device');
  assert.equal(Routing.returnToDmTarget(dm(), rooms), null);
  assert.deepEqual(Routing.sharedOriginTarget(routing.sharedIn[0], rooms), { threadId: 'thread-dm-1', messageId: 'msg-b' });
  assert.equal(Routing.sharedOriginTarget(routing.sharedIn[0], [room]), null);
  // A rebound DM is found by its bridge binding as well.
  assert.equal(Routing.threadByClientId([dm({ id: 'other', clientBindingId: 'thread-dm-1' })], 'thread-dm-1').id, 'other');
});

test('D-M2: mentions follow the helper rules — agent:// links, plain @이름 with word bounds, longest name first', () => {
  const agents = ['디자인 리뷰어', '디자인', 'Rio'];
  const text = '[@Rio](agent://rio-1) 그리고 @디자인 리뷰어, @나 확인. email@디자인 아님. (@Rio) @Rio.';
  const spans = Routing.mentionSpans(text, { agentNames: agents });
  assert.deepEqual(spans.map(span => [span.kind, span.name, span.profileId]), [
    ['agent', 'Rio', 'rio-1'], ['agent', '디자인 리뷰어', null], ['user', '나', null], ['agent', 'Rio', null], ['agent', 'Rio', null],
  ]);
  assert.deepEqual(Routing.mentionedAgents(text, agents), ['Rio', '디자인 리뷰어']);
  assert.equal(Routing.mentionsUser(text), true);
  assert.equal(Routing.mentionsUser('@나중에 봐요'), false, '@나 inside a longer word is not a call');
  assert.equal(Routing.mentionsUser('@사람, 봐 주세요'), true);
  const segments = Routing.mentionSegments('안녕 @나 — [@Rio](agent://rio-1)!', { agentNames: agents });
  assert.deepEqual(segments.map(segment => segment.type === 'text' ? segment.text : `<${segment.kind}:${segment.name}>`), ['안녕 ', '<user:나>', ' — ', '<agent:Rio>', '!']);
  assert.deepEqual(Routing.threadAgentNames(board()), ['코덱스 어시스턴트', '디자인 리뷰어']);
});

test('D-M2: the room badge counts unread Agent lines that call the person, and clears with the unread count', () => {
  const room = board({ unreadCount: 2, messages: [
    { id: 'b-0', role: 'assistant', content: '@나 봐 주세요', status: 'complete' },
    { id: 'b-1', role: 'user', content: '@나 라고 내가 쓴 건 아님', status: 'complete' },
    { id: 'b-2', role: 'assistant', content: '@사용자 결정 부탁드립니다', status: 'complete' },
  ] });
  assert.equal(Routing.userMentionBadge(room), 1, 'only the unread tail counts, and only Agent lines');
  assert.equal(Routing.userMentionBadge({ ...room, unreadCount: 3 }), 2);
  assert.equal(Routing.userMentionBadge({ ...room, unreadCount: 0 }), 0);
  assert.equal(Routing.userMentionBadge({ ...room, type: 'dm', unreadCount: 3 }), 0, 'a DM has no one else to call the person');
});

test('CHAT-03: share errors read in the person\'s words', () => {
  assert.match(Routing.shareErrorText({ code: 'MESSAGE_NOT_FOUND' }), /저장되지 않은/);
  assert.match(Routing.shareErrorText('SHARE_TOO_LARGE'), /너무 길어/);
  assert.match(Routing.shareErrorText(new Error('boom')), /옮기지 못했습니다/);
  assert.match(Routing.moveDoneText(2, '회의 준비'), /2개를 ‘회의 준비’/);
});
