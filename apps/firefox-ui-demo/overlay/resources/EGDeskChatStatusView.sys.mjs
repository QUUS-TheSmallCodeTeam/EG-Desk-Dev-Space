/* EG-Desk Chat status view: what the conversation says about a run's state.
 *
 * Pure view model. The Chat stays quiet like a messenger while nothing is
 * going on, and says what an Agent is waiting on when it waits for 대표님.
 * Nothing here sends, approves, answers or moves anything.
 */

const oneLine = (value, limit = 120) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  const points = [...text];
  return points.length > limit ? `${points.slice(0, limit - 1).join('')}…` : text;
};

const count = value => (Number.isSafeInteger(value) && value > 0 ? value : 0);

/**
 * The status line above the composer is hidden while nothing asks for
 * attention: no run yet, or a finished run whose result is whole. Anything in
 * progress, stopped, failed, unconfirmed or waiting on 대표님 keeps the line.
 */
export function statusRowQuiet({
  status = 'ready', bindingHeld = false, unobservedPreviousRun = false,
  approvals = 0, questions = 0, blocked = 0, scope = null,
} = {}) {
  if (status !== 'ready' && status !== 'completed') return false;
  if (bindingHeld || unobservedPreviousRun) return false;
  if (count(approvals) || count(questions) || count(blocked)) return false;
  return !scope || scope.completeness === 'full';
}

/** The small '…' beside an answer's time: only the last answer of a run carries it. */
export function answerActivityShown(message, lastAnswerId) {
  return message?.role === 'assistant' && typeof message.runId === 'string' && message.runId.length > 0
    && lastAnswerId === message.id;
}

const liveApprovals = run => (Array.isArray(run?.pendingApprovals) ? run.pendingApprovals : [])
  .filter(approval => approval && approval.stale !== true && (approval.status === undefined || approval.status === 'pending'));
const liveQuestions = run => (Array.isArray(run?.pendingUserInputs) ? run.pendingUserInputs : [])
  .filter(input => input && input.status === 'pending' && input.stale !== true);

/**
 * What a waiting run asks of 대표님, in one line, with the button that goes to
 * answer it. The decision itself stays in the activity record: this only says
 * what is asked and where to go. null while the run waits on nothing.
 */
export function waitingAsk(run) {
  if (!run || run.localHistory === true) return null;
  const approvals = liveApprovals(run);
  if (approvals.length) {
    const [first] = approvals;
    const command = oneLine(first.command, 96);
    const reason = oneLine(first.reason, 96);
    const detail = command ? `실행 요청 · ${command}` : reason || (first.kind === 'fileChange' ? '파일 변경을 적용해도 되는지 묻고 있습니다' : '실행해도 되는지 묻고 있습니다');
    return { kind: 'approval', detail, actionLabel: '확인하기', more: approvals.length - 1,
      activityId: typeof first.itemId === 'string' && first.itemId ? first.itemId : null };
  }
  const questions = liveQuestions(run);
  if (questions.length) {
    const [first] = questions;
    const question = Array.isArray(first.questions) ? first.questions[0] : null;
    const header = oneLine(question?.header, 40);
    const text = oneLine(question?.question, 96);
    const detail = [header, text].filter(Boolean).join(' · ') || '답변이 필요한 질문이 있습니다';
    const total = questions.reduce((sum, input) => sum + (Array.isArray(input.questions) ? input.questions.length : 1), 0);
    return { kind: 'question', detail, actionLabel: '답하기', more: Math.max(0, total - 1),
      activityId: typeof first.itemId === 'string' && first.itemId ? first.itemId : null };
  }
  return null;
}

/** '외 2건' for the asks the one line does not name. */
export const waitingMoreText = ask => (count(ask?.more) ? `외 ${ask.more}건` : '');

const SCOPE_NAMES = { full: '전체', partial: '부분', none: '없음' };

/**
 * Result scope of a finished run that split its work: how much of it actually
 * came back, apart from the run state itself. `statuses` are the sub-Agent
 * display states (done | blocked | stopped | active). null for a single answer
 * or a run still going — a partial result is not a run state.
 */
export function resultScope(run, statuses = []) {
  if (run?.status !== 'completed' || !Array.isArray(statuses) || !statuses.length) return null;
  const tally = name => statuses.filter(status => status === name).length;
  const done = tally('done'), failed = tally('blocked');
  // Stopped, closed early or no longer observed: not finished, cause not claimed.
  const unfinished = statuses.length - done - failed;
  const completeness = done === statuses.length ? 'full' : done === 0 ? 'none' : 'partial';
  const parts = [`완료 ${done}`, failed ? `실패 ${failed}` : '', unfinished ? `미완료 ${unfinished}` : ''].filter(Boolean);
  return { completeness, done, failed, unfinished, total: statuses.length,
    text: `${SCOPE_NAMES[completeness]} · ${parts.join(' / ')}` };
}

/** '03:12 확인' — when the connection state was last observed. null when never. */
export function checkedClockText(at) {
  if (!Number.isFinite(at) || at <= 0) return null;
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return null;
  const two = value => String(value).padStart(2, '0');
  return `${two(when.getHours())}:${two(when.getMinutes())} 확인`;
}

/** A state the screen cannot vouch for names when it was last checked. */
export function uncertainStatusText(text, checkedAt) {
  const label = typeof text === 'string' ? text : '';
  if (!/미확인|확인 필요|연결 끊김/.test(label)) return label;
  const checked = checkedClockText(checkedAt);
  return checked ? `${label} · ${checked}` : label;
}

/**
 * The connection state as one line: what is observed, when it was last
 * checked, and one retry. Everything else — a history read that failed while
 * the bridge was away, the raw transport error — folds under '자세히', so a
 * lost connection never stacks a second alert. null while the bridge answers.
 * `notice` is SurfaceState.bridgeConnectionNotice(); the cause is not claimed.
 */
export function connectionLine(notice, { localHistoryError = null, checkedAt = null } = {}) {
  if (!notice || typeof notice.state !== 'string' || notice.state === 'online') return null;
  const history = typeof localHistoryError === 'string' ? localHistoryError.trim() : '';
  const details = (Array.isArray(notice.details) ? notice.details : []).filter(line => typeof line === 'string' && line);
  return { state: notice.state, text: notice.text, action: notice.action || null,
    checked: checkedClockText(checkedAt), details: history ? [history, ...details] : details };
}

/**
 * Whether the task list opens by itself: once, when a wait that needs 대표님
 * (a question or an approval) appears that was not there before. Folding it
 * keeps it folded until a new one shows up.
 */
export function taskAttention({ keys = [], seen = [], open = false } = {}) {
  const current = [...new Set((Array.isArray(keys) ? keys : []).filter(key => typeof key === 'string' && key))];
  const known = new Set(Array.isArray(seen) ? seen : []);
  const fresh = current.some(key => !known.has(key));
  const changed = fresh || current.length !== known.size;
  return { open: open === true || fresh, opened: fresh && open !== true, seen: current, changed };
}
