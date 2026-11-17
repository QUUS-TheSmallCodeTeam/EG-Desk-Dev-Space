// EG-Desk attention notice model (UX-06 remainder).
// Pure: no DOM, no storage, no imports. The screen file passes chat events in
// and draws the one notice under the top bar; clicking it opens the Chat peek
// through state.peekChatForAttention.
//
// Which chat events need the person:
//  - approval.required / userInput.required: the Agent waits for an answer;
//  - run.completed with status 'blocked': the run stopped and needs the person;
//  - run.completed (any other end) while the Chat is not visible.
// One notice per run (repeats of the same run do not count twice); only one
// notice is shown at a time, with how many runs are waiting.

const LINES = Object.freeze({
  approval: '승인을 기다리고 있습니다.',
  input: '답변을 기다리고 있습니다.',
  blocked: '작업이 막혀 확인이 필요합니다.',
  finished: '작업을 마쳤습니다.',
  failed: '작업이 실패했습니다.',
});

export function emptyAttention() {
  return Object.freeze({ items: Object.freeze([]) });
}

// event: a chat.event v2 ({ event, runId, details }); context: { chatVisible }.
// Returns the reason string or null.
export function attentionReason(event, context = {}) {
  const name = event?.event;
  if (name === 'approval.required') return 'approval';
  if (name === 'userInput.required') return 'input';
  if (name === 'run.completed') {
    const status = event.details?.status || 'completed';
    if (status === 'blocked') return 'blocked';
    if (context.chatVisible) return null;
    if (status === 'completed') return 'finished';
    if (status === 'failed') return 'failed';
  }
  return null;
}

function runKey(event) {
  const id = event?.runId || event?.details?.runId;
  return typeof id === 'string' && id ? id : null;
}

export function noteChatEvent(model, event, context = {}) {
  const current = model?.items || [];
  const runId = runKey(event);
  if (!runId) return model || emptyAttention();
  const reason = attentionReason(event, context);
  if (!reason) {
    // The person answered here; that run no longer waits.
    if (['approval.resolved', 'userInput.resolved'].includes(event.event)
      && current.some(item => item.runId === runId && (item.reason === 'approval' || item.reason === 'input'))) {
      return Object.freeze({ items: Object.freeze(current.filter(item => item.runId !== runId)) });
    }
    return model || emptyAttention();
  }
  const agentName = typeof context.agentName === 'string' && context.agentName.trim() ? context.agentName.trim() : 'Agent';
  const item = Object.freeze({ runId, reason, agentName });
  const rest = current.filter(entry => entry.runId !== runId);
  return Object.freeze({ items: Object.freeze([...rest, item]) });
}

export function dismissAttention() {
  return emptyAttention();
}

// What the screen draws: null, or { agentName, line, count, label }.
export function attentionNotice(model) {
  const items = model?.items || [];
  if (!items.length) return null;
  const latest = items[items.length - 1];
  const count = items.length;
  const line = LINES[latest.reason] || LINES.finished;
  const more = count > 1 ? ` 외 ${count - 1}건` : '';
  return Object.freeze({
    runId: latest.runId, reason: latest.reason, agentName: latest.agentName, line, count,
    label: `${latest.agentName}: ${line}${more} Chat 열기`,
  });
}

// Which Agent name the notice shows, from what the chat event's run carries:
// the run's own name, then the room's Board Thread member for the run's Agent
// profile, then the room's selected Agent profile. 'Agent' stays the fallback.
// sources: { run, members (Board Thread room members), roomProfile ({ name }) }.
export function attentionAgentName({ run = null, members = null, roomProfile = null } = {}) {
  const clean = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const direct = clean(run?.agentName) || clean(run?.profileName);
  if (direct) return direct;
  const profileId = clean(run?.agentProfileId) || clean(run?.agentId);
  const agents = Array.isArray(members) ? members.filter(member => member?.kind === 'agent' && clean(member.label)) : [];
  const member = (profileId && agents.find(entry => entry.profileId === profileId)) || (agents.length === 1 ? agents[0] : null);
  return clean(member?.label) || clean(roomProfile?.name) || 'Agent';
}

// Where the notice sits: just under the top bar's bottom edge (its real rect),
// 52px when the bar is not there to measure.
export function attentionNoticeTop(topBarRect, gap = 8) {
  const bottom = Number(topBarRect?.bottom);
  return Number.isFinite(bottom) && bottom > 0 ? Math.round(bottom + gap) : 52;
}
