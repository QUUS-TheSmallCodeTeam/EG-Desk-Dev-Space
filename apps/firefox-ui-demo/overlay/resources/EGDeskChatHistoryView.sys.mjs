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

// u5: the log goes to the newest message (or the card) when the number of requests the room waits on changes: one arrived (a question or an approval 대표님 must answer: its card is at the foot
// of the log) or one was resolved (대표님 answered or decided: the engine's reply follows). Not when the room is drawn for the first time (`before` unknown), and not for the engine's own words,
// which keep '새 메시지' while 대표님 reads further up.
export function askChanged(before, now) {
  return Number.isFinite(before) && Number.isFinite(now) && before !== now;
}

export const NEW_MESSAGE_LABEL = '새 메시지';
export const NEW_MESSAGE_HINT = '최신 메시지로 이동';
// Same slack the log uses to decide it is following the newest message.
export const BOTTOM_SLACK_PX = 24;

export function atLogBottom({ scrollHeight, scrollTop, clientHeight } = {}) {
  return (Number(scrollHeight) || 0) - (Number(scrollTop) || 0) - (Number(clientHeight) || 0) < BOTTOM_SLACK_PX;
}

// A46: a message of mine the connection refused can go back to the composer.
// Only a known refusal ('failed') offers it; an unknown outcome might still
// have arrived, so it is not offered again.
export const RESEND_LABEL = '다시 보내기';
export const RESEND_HINT = '이 내용을 입력창에 다시 넣습니다. 보내기는 직접 누릅니다.';

export function resendAvailable(message) {
  return message?.role === 'user' && message.status === 'failed'
    && typeof message.content === 'string' && message.content.trim() !== '';
}

// What the composer should hold after '다시 보내기'. A draft in progress is
// kept and the refused words follow it; words already there are not doubled.
export function resendDraft(current, refused) {
  const draft = typeof current === 'string' ? current : '';
  const words = typeof refused === 'string' ? refused.trim() : '';
  const kept = draft.trimEnd();
  if (!words || kept === words || kept.endsWith(`\n\n${words}`)) return { draft, changed: false };
  return { draft: kept.trim() ? `${kept}\n\n${words}` : words, changed: true };
}
