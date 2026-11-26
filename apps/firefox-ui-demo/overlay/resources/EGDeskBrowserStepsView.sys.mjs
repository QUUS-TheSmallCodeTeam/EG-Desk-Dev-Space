// a1 (L1): who did what in a Browser task, shown in Chat and on the Card (display only).
//
// Chat: the runtime reports each step of a Browser task as { threadId|clientThreadId, taskId, cardId, seq, op, target,
// valueName, ok, ms, by: 'decision'|'model', status? } (the bridge frame 'browser.task.step', or the chat event
// 'browserTask.step' on a run). The lines sit in the conversation where they happened (between the messages, by time),
// grouped by task; a long task folds to its summary and newest line.
// Card: an Agent request the Card carried out gets a short caption at the Card's edge (who chose it: the request's actor,
// else its reflex call name) and, while the page is the one it was read on, a frame around its target (the observed
// bounds, in percent of the observed viewport).
// Nothing here decides, sends or authorizes anything; the words are proposals (the owner confirms them).

export const BROWSER_STEP_FRAME_TYPE = 'browser.task.step';
export const BROWSER_STEP_CHAT_EVENT = 'browserTask.step';
export const BROWSER_STEPS_LIMIT = 200; // all rooms together, oldest dropped first
export const BROWSER_STEPS_COLLAPSE_AFTER = 4;
export const BROWSER_STEP_BOX_MS = 1400;
export const BROWSER_STEP_CAPTION_MS = 2600;

const OP_ALIASES = Object.freeze({
  fill: 'fill', type: 'fill', type_text: 'fill', input: 'fill', enter_value: 'fill',
  click: 'click', pointer_click: 'click', press_button: 'click', tap: 'click',
  press: 'press', key: 'press', press_key: 'press', press_enter: 'press',
  select: 'select', select_option: 'select', choose: 'select',
  scroll: 'scroll', scroll_up: 'scroll', scroll_down: 'scroll',
  navigate: 'navigate', open: 'navigate', goto: 'navigate', open_url: 'navigate',
  observe: 'observe', snapshot: 'observe', read: 'observe',
  wait: 'wait', submit: 'submit', done: 'done', finish: 'done', blocked: 'blocked', cannot: 'blocked',
  handoff: 'handoff', ask: 'handoff', escalate: 'handoff',
});
// The words for why the conversation model takes the task over (op 'handoff', or one of these statuses).
const HANDOFF_REASONS = Object.freeze({ handoff: '', needs_value: '값 필요', value_needed: '값 필요', low_confidence: '확신 낮음',
  needs_user: '사용자 확인 필요', ask_user: '사용자 확인 필요', human_step: '사용자 차례', blocked: '막힘' });
const HANDOFF_STATUSES = new Set(['handoff', 'needs_value', 'value_needed', 'low_confidence', 'needs_user', 'ask_user', 'human_step']);
const ENGINE_NAMES = Object.freeze({ claude: 'Claude', codex: 'Codex' });
const SCROLL_WORDS = Object.freeze({ down: '아래로', up: '위로', bottom: '맨 아래로', top: '맨 위로' });

function plain(value, max) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}
const word = (value, max = 40) => (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(value) && value.length <= max ? value : null);
const id = (value, max = 160) => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : null);

/** 'egdesk_browser_fill', 'TYPE_TEXT', 'fill' -> 'fill'; unknown -> 'other'. */
export function browserStepOp(value) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/^egdesk_browser_/, '').replace(/[\s-]+/g, '_');
  return OP_ALIASES[raw] || 'other';
}

/** 'decision' when the Browser request came from the Decision model's reflex loop (its calls are named
 * '<call>.reflex-<n>-<uuid>' by the Browser provider), else 'model' (the conversation model's own tool call). */
export function browserStepByCallId(callId) {
  return typeof callId === 'string' && /\.reflex-\d+-/.test(callId) ? 'decision' : 'model';
}

/** Who chose one Browser request the Card carried out: the request's own actor ('decision' | 'model', sent with act
 * requests on the task tool's path) when it says, else the call name (browserStepByCallId). The actor comes first: a
 * conversation model's guided step still runs through the reflex scope and so has a reflex call name. */
export function browserStepActor(request) {
  return request?.actor === 'decision' || request?.actor === 'model' ? request.actor : browserStepByCallId(request?.callId);
}

export function browserEngineName(engineId) {
  return ENGINE_NAMES[engineId] || '대화 모델';
}

/** One step as shown, or null when it cannot be placed (no room, task or order). Never keeps a typed value. */
export function normalizeBrowserStep(raw, { ts = null, clientThreadId = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const thread = id(raw.clientThreadId, 200) || id(raw.threadId, 200) || id(clientThreadId, 200);
  const taskId = id(raw.taskId);
  const seq = Number.isSafeInteger(raw.seq) && raw.seq >= 0 ? raw.seq : null;
  if (!thread || !taskId || seq === null) return null;
  const opSource = word(raw.op, 60) || word(raw.tool, 60) || word(raw.action, 60);
  const op = browserStepOp(opSource);
  const target = raw.target && typeof raw.target === 'object' ? plain(raw.target.label ?? raw.target.name, 60) : plain(raw.target, 60);
  const valueName = plain(raw.valueName, 40);
  const status = word(raw.status) ? raw.status.toLowerCase() : null;
  const reason = word(raw.reason) ? raw.reason.toLowerCase() : null;
  const when = Number.isFinite(ts) ? ts : Number.isFinite(raw.ts) ? raw.ts : Date.now();
  return {
    clientThreadId: thread, taskId, seq, op,
    ...(id(raw.cardId) ? { cardId: raw.cardId } : {}),
    ...(target ? { target } : {}),
    ...(valueName ? { valueName } : {}),
    ...(typeof raw.key === 'string' && /^[A-Za-z]{1,12}$/.test(raw.key) ? { key: raw.key } : {}),
    ...(Object.hasOwn(SCROLL_WORDS, raw.direction) ? { direction: raw.direction } : {}),
    ok: typeof raw.ok === 'boolean' ? raw.ok : null,
    ms: Number.isFinite(raw.ms) && raw.ms >= 0 ? Math.round(raw.ms) : null,
    by: raw.by === 'model' ? 'model' : 'decision',
    ...(status ? { status } : {}),
    ...(reason ? { reason } : {}),
    ts: when,
  };
}

const stepKey = step => `${step.clientThreadId}\u0000${step.taskId}\u0000${step.seq}`;
const byTime = (a, b) => a.ts - b.ts || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0) || a.seq - b.seq;

/** The list with one step added (the same task and seq replaces the earlier copy), oldest dropped past the limit.
 * The same array comes back when the step is unusable, so a caller can tell "nothing changed". */
export function addBrowserStep(list, raw, options = {}) {
  const step = normalizeBrowserStep(raw, options);
  const before = Array.isArray(list) ? list : [];
  if (!step) return before;
  const key = stepKey(step);
  const next = before.filter(item => stepKey(item) !== key);
  next.push(step);
  next.sort(byTime);
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : BROWSER_STEPS_LIMIT;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** One room's steps, from the bridge frames and from its runs' chat events, once each, in time order. */
export function browserStepsFor(list, clientThreadId, runs = []) {
  if (typeof clientThreadId !== 'string' || !clientThreadId) return [];
  const merged = new Map();
  for (const step of Array.isArray(list) ? list : []) if (step?.clientThreadId === clientThreadId) merged.set(stepKey(step), step);
  for (const run of Array.isArray(runs) ? runs : []) {
    for (const step of Array.isArray(run?.browserSteps) ? run.browserSteps : []) {
      if (step?.clientThreadId === clientThreadId) merged.set(stepKey(step), step);
    }
  }
  return [...merged.values()].sort(byTime);
}

/** Hands out the room's steps in conversation order: take(at) returns the blocks of steps up to that time not yet
 * given (one block per task between two messages), take() the rest. */
export function browserStepPlacement(steps) {
  const ordered = (Array.isArray(steps) ? steps : []).slice().sort(byTime);
  let index = 0;
  const take = (until = Infinity) => {
    const blocks = [];
    while (index < ordered.length && ordered[index].ts <= until) {
      const step = ordered[index++];
      const last = blocks.at(-1);
      if (last && last.taskId === step.taskId) last.steps.push(step);
      else blocks.push({ key: `${step.taskId}:${step.seq}`, taskId: step.taskId, steps: [step] });
    }
    return blocks;
  };
  return { take };
}

function seconds(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  return ms >= 10000 ? `${Math.round(ms / 1000)}초` : `${(Math.max(ms, 100) / 1000).toFixed(1)}초`;
}
const subject = name => `${name}${name === '대화 모델' ? '이' : '가'}`;

/** One line: "결정 모델 · 검색칸에 '검색어' 입력 · 0.3초", "Claude가 이어받음 (값 필요)". */
export function browserStepLine(step, { engineId = null } = {}) {
  const engine = browserEngineName(engineId);
  const handoffWord = step.op === 'handoff' ? HANDOFF_REASONS[step.reason] ?? HANDOFF_REASONS[step.status] ?? ''
    : HANDOFF_STATUSES.has(step.status) ? HANDOFF_REASONS[step.reason] ?? HANDOFF_REASONS[step.status] : null;
  if (handoffWord !== null) {
    const text = `${subject(engine)} 이어받음${handoffWord ? ` (${handoffWord})` : ''}`;
    return { kind: 'handoff', by: 'model', who: engine, text, time: '', ok: step.ok, line: text };
  }
  const who = step.by === 'model' ? engine : '결정 모델';
  const target = step.target || '';
  const value = step.valueName ? `'${step.valueName}' ` : '';
  const action = (() => {
    switch (step.op) {
      case 'fill': return target ? `${target}에 ${value}입력` : `${value}입력`;
      case 'click': return target ? `'${target}' 누름` : '누름';
      case 'press': return `${step.key || target || 'Enter'} 키 누름`;
      case 'select': return target ? `${target}에서 ${value}선택` : `${value}선택`;
      case 'scroll': return `${SCROLL_WORDS[step.direction] || ''} 스크롤`.trim();
      case 'navigate': return target ? `${target} 열기` : '페이지 이동';
      case 'observe': return '화면 읽음';
      case 'wait': return '페이지 기다림';
      case 'submit': return target ? `'${target}' 제출` : '제출';
      case 'done': return '작업 끝';
      case 'blocked': return '더 진행할 수 없음';
      default: return target ? `'${target}' 동작` : '동작';
    }
  })();
  const text = step.ok === false ? `${action} 실패` : action;
  const time = seconds(step.ms);
  return { kind: 'step', by: step.by === 'model' ? 'model' : 'decision', who, text, time, ok: step.ok,
    line: [who, text, time].filter(Boolean).join(' · ') };
}

/** One task block: its lines (folded past collapseAfter to the newest line), a summary and the toggle words. */
export function browserStepsBlockView(block, { engineId = null, open = false, collapseAfter = BROWSER_STEPS_COLLAPSE_AFTER } = {}) {
  const steps = Array.isArray(block?.steps) ? block.steps : [];
  const lines = steps.map(step => browserStepLine(step, { engineId }));
  const decided = steps.filter((step, index) => lines[index].kind === 'step' && step.by !== 'model').length;
  const modeled = steps.filter((step, index) => lines[index].kind === 'step' && step.by === 'model').length;
  const total = steps.reduce((sum, step) => sum + (Number.isFinite(step.ms) ? step.ms : 0), 0);
  const engine = browserEngineName(engineId);
  const summary = ['브라우저 작업', decided ? `결정 모델 ${decided}단계` : '', modeled ? `${engine} ${modeled}단계` : '',
    total > 0 ? seconds(total) : ''].filter(Boolean).join(' · ');
  const foldable = lines.length > collapseAfter;
  const collapsed = foldable && !open;
  const shown = collapsed ? lines.slice(-1) : lines;
  return {
    key: block?.key || '', summary, lines: shown, hiddenCount: lines.length - shown.length, foldable, collapsed,
    toggleLabel: foldable ? (collapsed ? `${lines.length - shown.length}단계 더 보기` : '접기') : '',
  };
}

/** The Card's caption for one Agent request it carried out, or null for a reading (observe/wait). */
export function browserActionCaption({ by = 'model', engineId = null, action = {}, target = null, outcome = null } = {}) {
  const label = plain(target?.label, 24);
  const type = String(action?.type || '');
  const text = (() => {
    switch (type) {
      case 'click': case 'pointer-click': return label ? `'${label}' 누름` : '누름';
      case 'fill': case 'type': case 'type-text': return `${label || '입력란'}에 입력`;
      case 'press': return `${action.key || 'Enter'} 키 누름`;
      case 'scroll': return `${SCROLL_WORDS[action.direction] || ''} 스크롤`.trim();
      case 'navigate': return action.host ? `${action.host} 열기` : '페이지 이동';
      case 'select': return label ? `${label}에서 선택` : '선택';
      default: return null;
    }
  })();
  if (!text) return null;
  const who = by === 'decision' ? '결정 모델' : browserEngineName(engineId);
  return `${who} · ${text}${outcome === 'refused' ? ' · 거부됨' : ''}`;
}

/** The target's frame in percent of the observed viewport (the Card's page wrap scales it), clipped to the page;
 * null when bounds or viewport are unreadable or the target is off the page. */
export function browserStepHighlightBox(bounds, viewport) {
  const width = viewport?.width, height = viewport?.height;
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height, width, height].every(Number.isFinite) ||
      width <= 0 || height <= 0 || bounds.width <= 0 || bounds.height <= 0) return null;
  const left = Math.max(0, bounds.x), top = Math.max(0, bounds.y);
  const right = Math.min(width, bounds.x + bounds.width), bottom = Math.min(height, bounds.y + bounds.height);
  if (right <= left || bottom <= top) return null;
  const pct = value => Math.round(value * 10000) / 100;
  return { left: pct(left / width), top: pct(top / height), width: pct((right - left) / width), height: pct((bottom - top) / height) };
}

/** What the Card remembers of its last reading, for a later frame: the viewport and each element's bounds by ref. */
export function browserStepReading(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const bounds = new Map();
  for (const item of Array.isArray(snapshot.interactiveElements) ? snapshot.interactiveElements.slice(0, 400) : []) {
    if (typeof item?.ref === 'string' && item.bounds && typeof item.bounds === 'object') bounds.set(item.ref, { ...item.bounds });
  }
  return { documentId: snapshot.documentId ?? null, viewport: snapshot.viewport ? { ...snapshot.viewport } : null, bounds };
}

/** The frame and caption one finished request gets: bounds from the request's observed target, else from the last
 * reading of the same document; no frame once the page changed. */
export function browserStepCardView({ request, response = null, reading = null, engineId = null, outcome = null } = {}) {
  if (request?.kind !== 'act') return null;
  const action = request.action || {};
  const guard = request.guard || {};
  const by = browserStepActor(request);
  const caption = browserActionCaption({ by, engineId, action: { ...action, host: hostOf(action.url) }, target: guard.target, outcome });
  if (!caption) return null;
  const sameReading = reading && reading.documentId && reading.documentId === guard.documentId ? reading : null;
  const bounds = guard.target?.ref && guard.target.ref === action.ref && guard.target.bounds ? guard.target.bounds
    : action.ref && sameReading ? sameReading.bounds.get(action.ref) : null;
  const viewport = guard.viewport || sameReading?.viewport || null;
  const afterDocument = response?.receipt?.after?.documentId;
  const pageChanged = action.type === 'navigate' || (afterDocument && guard.documentId && afterDocument !== guard.documentId);
  const box = pageChanged || outcome === 'refused' ? null : browserStepHighlightBox(bounds, viewport);
  return { by, caption, box };
}

function hostOf(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.hostname.replace(/^www\./, '') : '';
  } catch { return ''; }
}
