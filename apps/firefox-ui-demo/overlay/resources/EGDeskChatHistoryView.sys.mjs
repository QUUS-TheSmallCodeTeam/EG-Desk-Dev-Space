// Chat history view model: the day line between messages, the room kind
// badge (Agent DM / Board Thread) and the '새 메시지' button rule. Pure: the
// surface passes times and ids in and draws what comes back.

const KIND_VIEWS = Object.freeze({
  dm: Object.freeze({ kind: 'dm', label: 'Agent DM', createLabel: '새 Agent DM', title: 'Agent 하나와 나누는 개인 대화' }),
  group: Object.freeze({ kind: 'group', label: 'Board Thread', createLabel: '새 Board Thread', title: 'Board에서 여러 Agent와 함께 쓰는 대화' }),
});

// Product names come first; Codex·Claude stay on the engine badge.
export function threadKindView(type) {
  return type === 'group' ? KIND_VIEWS.group : KIND_VIEWS.dm;
}

const validTime = (value) => Number.isFinite(value) && value > 0;

// Local calendar day, so a line appears where the reader's date changes.
export function dayKey(at) {
  if (!validTime(at)) return null;
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function fallbackTime(at) {
  const date = new Date(at);
  const hour = date.getHours();
  return `${hour < 12 ? '오전' : '오후'} ${hour % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// '오늘 · 오전 9:41', '어제', '11월 13일', and the year once it differs.
export function dayLabel(at, now, { formatTime = fallbackTime } = {}) {
  if (!validTime(at)) return '';
  const date = new Date(at);
  const today = new Date(validTime(now) ? now : at);
  if (dayKey(at) === dayKey(today.getTime())) return `오늘 · ${formatTime(at)}`;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(at) === dayKey(yesterday.getTime())) return '어제';
  const monthDay = `${date.getMonth() + 1}월 ${date.getDate()}일`;
  return date.getFullYear() === today.getFullYear() ? monthDay : `${date.getFullYear()}년 ${monthDay}`;
}

// The line that goes above a message: the first dated message of the
// conversation, and every message whose day differs from the one before it.
// `previousAt` is the last dated message already shown (null at the top).
export function dayDivider(previousAt, at, now, options = {}) {
  const key = dayKey(at);
  if (!key || key === dayKey(previousAt)) return null;
  return { key, label: dayLabel(at, now, options) };
}

// The newest answer the log shows. A streaming answer with no words yet is not
// drawn, so it does not count until its first words arrive.
export function latestAnswerId(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (!message || message.role === 'user' || !message.id) continue;
    if (message.status === 'streaming' && !message.content) continue;
    return message.id;
  }
  return '';
}

// '새 메시지' stays while 대표님 reads further up and an answer arrived below.
// At the bottom, in another room, or right after 대표님 sends, there is none
// (the log follows the newest message on its own there).
export function nextNewMessageNotice(prior, { threadId, readingAbove, previousAnswerId, answerId } = {}) {
  if (!threadId || !readingAbove) return null;
  if (prior?.threadId === threadId) return prior;
  if (!answerId || answerId === (previousAnswerId || '')) return null;
  return { threadId, messageId: answerId };
}

export const NEW_MESSAGE_LABEL = '새 메시지';
export const NEW_MESSAGE_HINT = '최신 메시지로 이동';
// Same slack the log uses to decide it is following the newest message.
export const BOTTOM_SLACK_PX = 24;

export function atLogBottom({ scrollHeight, scrollTop, clientHeight } = {}) {
  return (Number(scrollHeight) || 0) - (Number(scrollTop) || 0) - (Number(clientHeight) || 0) < BOTTOM_SLACK_PX;
}
