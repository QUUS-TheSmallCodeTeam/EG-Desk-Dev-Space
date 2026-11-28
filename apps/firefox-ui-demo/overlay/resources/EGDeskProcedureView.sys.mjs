// Round g (L61): Browser procedures in the UI, pure view logic (no DOM, no network).
// A procedure is the JSON of the round-g contract (section 1): { id, name, start, params, steps, ... }.
// This module builds the list rows, the editor model, the edit ops (each returns a NEW procedure plus
// validation messages), the parameter form and the chat message that runs a procedure.
// A sensitive parameter is never shown with a value and never goes into the message.
// All visible words are PROPOSALS (the owner confirms them) and live in COPY below, in one place.

export const COPY = Object.freeze({
  saveButton: '절차로 저장',
  saveButtonTitle: '이 브라우저 작업을 다시 쓸 수 있는 절차로 저장',
  toolbarButton: '절차',
  toolbarTitle: '저장한 절차 보기',
  listTitle: '저장한 절차',
  listEmpty: '저장한 절차가 없습니다. 브라우저 작업 뒤에 "절차로 저장"을 눌러 만들 수 있어요.',
  listLoading: '불러오는 중…',
  actionRun: '실행',
  actionEdit: '편집',
  actionDelete: '삭제',
  deleteConfirm: '삭제할까요?',
  deleteYes: '삭제',
  deleteNo: '취소',
  editorTitleNew: '절차 저장',
  editorTitleEdit: '절차 편집',
  nameLabel: '이름',
  startLabel: '시작 주소',
  stepsLabel: '단계',
  confirmToggle: '실행 때 확인',
  stepDelete: '삭제',
  stepUp: '위로',
  stepDown: '아래로',
  sensitiveValue: '실행 중 직접 입력',
  personStep: '직접 해야 하는 단계',
  save: '저장',
  cancel: '취소',
  close: '닫기',
  runTitle: '절차 실행',
  runNoParams: '입력할 값이 없습니다.',
  run: '실행',
  siteUnknown: '사이트 미상',
  stepCount: (n) => `${n}단계`,
  today: '오늘',
  capturing: '단계를 정리하는 중…',
  captureFailed: '절차로 만들지 못했습니다',
  saveFailed: '저장하지 못했습니다',
  deleteFailed: '삭제하지 못했습니다',
  loadFailed: '불러오지 못했습니다',
  runSent: '실행 요청을 채팅으로 보냈습니다.',
  runBusy: '채팅이 작업 중이라 지금은 실행을 보내지 않았습니다.',
  runNoRoom: '실행을 보낼 대화를 찾지 못했습니다.',
  runDraftBusy: '입력 중인 내용이 있어 보내지 않았습니다. 입력창을 비운 뒤 다시 시도해 주세요.',
  msgNameEmpty: '이름을 입력해 주세요.',
  msgNameLong: (max) => `이름은 ${max}자 이하여야 합니다.`,
  msgNoSteps: '단계가 하나 이상 있어야 저장할 수 있습니다.',
  msgTooManySteps: (max) => `단계는 ${max}개까지 저장할 수 있습니다.`,
  msgSensitiveDefault: '민감한 값은 저장하지 않습니다.',
  msgParamDropped: (name) => `'${name}' 값은 더 이상 쓰는 단계가 없어 뺐습니다.`,
  runMessage: (name) => `‘${name}’ 절차를 실행해줘.`,
});

export const PROCEDURE_NAME_MAX = 80;
export const PROCEDURE_STEPS_MAX = 100;

const OP_LABELS = Object.freeze({
  fill: '입력', select: '선택', click: '누름', navigate: '이동', press: '키', scroll: '스크롤', history: '뒤로',
});
const HISTORY_LABELS = Object.freeze({ back: '뒤로', forward: '앞으로', reload: '새로고침' });
const ACT_OPS = new Set(Object.keys(OP_LABELS));

const text = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));
const oneLine = (value) => text(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const clone = (value) => JSON.parse(JSON.stringify(value));
const stepsOf = (p) => (Array.isArray(p?.steps) ? p.steps : []);
const paramsOf = (p) => (Array.isArray(p?.params) ? p.params : []);

/** 'fill' -> '입력', 'history' with action 'forward' -> '앞으로'; unknown ops -> the op text itself. */
export function opLabel(opOrStep) {
  const step = opOrStep && typeof opOrStep === 'object' ? opOrStep : { op: opOrStep };
  if (step.op === 'history') return HISTORY_LABELS[step.action] || OP_LABELS.history;
  return OP_LABELS[step.op] || oneLine(step.op) || '단계';
}

function timeText(ms, now) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const n = Number.isFinite(now) ? new Date(now) : new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const same = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return same ? `${COPY.today} ${hm}` : `${d.getMonth() + 1}월 ${d.getDate()}일 ${hm}`;
}

/** List rows from procedureSummary() results, newest update first. */
export function procedureListRows(summaries, { now } = {}) {
  const rows = (Array.isArray(summaries) ? summaries : [])
    .filter((s) => s && typeof s.id === 'string' && s.id)
    .map((s) => {
      const count = Number.isFinite(s.stepCount) ? s.stepCount : 0;
      return {
        id: s.id,
        name: oneLine(s.name) || s.id,
        site: oneLine(s.host) || COPY.siteUnknown,
        stepCount: count,
        stepsText: COPY.stepCount(count),
        paramNames: Array.isArray(s.paramNames) ? s.paramNames.map(oneLine).filter(Boolean) : [],
        updatedAt: Number.isFinite(s.updatedAt) ? s.updatedAt : 0,
        updatedText: timeText(s.updatedAt, now),
        actions: [COPY.actionRun, COPY.actionEdit, COPY.actionDelete],
      };
    });
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Messages that say why the procedure cannot be saved as it is (empty when it can). */
export function validateProcedure(procedure) {
  const messages = [];
  const name = oneLine(procedure?.name);
  if (!name) messages.push(COPY.msgNameEmpty);
  else if ([...name].length > PROCEDURE_NAME_MAX) messages.push(COPY.msgNameLong(PROCEDURE_NAME_MAX));
  const count = stepsOf(procedure).length;
  if (count < 1) messages.push(COPY.msgNoSteps);
  if (count > PROCEDURE_STEPS_MAX) messages.push(COPY.msgTooManySteps(PROCEDURE_STEPS_MAX));
  return messages;
}

function sensitiveNames(procedure) {
  const names = new Set(paramsOf(procedure).filter((p) => p?.sensitive === true).map((p) => p.name));
  for (const step of stepsOf(procedure)) if (step?.person === true && step.value?.param) names.add(step.value.param);
  return names;
}

function stepTargetText(step) {
  if (step.op === 'navigate') return oneLine(step.url);
  if (step.op === 'scroll') return [{ up: '위', down: '아래', top: '맨 위', bottom: '맨 아래' }[step.direction] || '', Number.isFinite(step.amount) ? String(step.amount) : ''].filter(Boolean).join(' ');
  if (step.op === 'history') return '';
  if (step.op === 'press') return [oneLine(step.target?.label), oneLine(step.key)].filter(Boolean).join(' · ');
  return oneLine(step.target?.label);
}

/** The editor's view of a procedure: name, start, one row per step (with its param field), and validity. */
export function procedureEditorModel(procedure) {
  const steps = stepsOf(procedure);
  const sensitive = sensitiveNames(procedure);
  const byName = new Map(paramsOf(procedure).map((p) => [p.name, p]));
  const rows = steps.map((step, index) => {
    const paramName = step.value && typeof step.value.param === 'string' ? step.value.param : null;
    const isSensitive = step.person === true || (paramName != null && sensitive.has(paramName));
    let field = null;
    if (paramName != null) {
      const param = byName.get(paramName);
      field = isSensitive
        ? { param: paramName, sensitive: true, editable: false, value: null, placeholder: COPY.sensitiveValue }
        : { param: paramName, sensitive: false, editable: true, value: text(param?.default), placeholder: '' };
    }
    return {
      id: step.id,
      number: index + 1,
      op: step.op,
      opLabel: opLabel(step),
      targetLabel: stepTargetText(step),
      field,
      fixedText: step.value && typeof step.value.text === 'string' ? step.value.text : null,
      confirm: step.confirm || null,
      confirmOn: !!step.confirm,
      canConfirm: step.person !== true && ACT_OPS.has(step.op),
      person: step.person === true,
      canUp: index > 0,
      canDown: index < steps.length - 1,
    };
  });
  const messages = validateProcedure(procedure);
  return {
    id: procedure?.id || null,
    name: text(procedure?.name),
    startUrl: text(procedure?.start?.url),
    startHost: text(procedure?.start?.host),
    steps: rows,
    messages,
    valid: messages.length === 0,
  };
}

function dropUnusedParams(procedure, messages) {
  const used = new Set(stepsOf(procedure).map((s) => s.value?.param).filter(Boolean));
  const kept = [];
  for (const p of paramsOf(procedure)) {
    if (used.has(p.name)) kept.push(p);
    else messages.push(COPY.msgParamDropped(p.name));
  }
  procedure.params = kept;
}

function result(next, extra = []) {
  return { procedure: next, messages: [...extra, ...validateProcedure(next)] };
}

/** Rename. The typed name is kept as typed (the messages say when it is not savable yet). */
export function renameProcedure(procedure, name) {
  const next = clone(procedure);
  next.name = text(name);
  return result(next);
}

/** Set one parameter's default. A sensitive parameter keeps `default: null`. */
export function setParamDefault(procedure, paramName, value) {
  const next = clone(procedure);
  const param = paramsOf(next).find((p) => p.name === paramName);
  const extra = [];
  if (param) {
    if (param.sensitive === true || sensitiveNames(next).has(paramName)) { param.default = null; extra.push(COPY.msgSensitiveDefault); }
    else param.default = text(value);
  }
  return result(next, extra);
}

/** Toggle "실행 때 확인" on one step. Switching on keeps the earlier kind, else 'submit'. */
export function toggleStepConfirm(procedure, stepId, kind = 'submit') {
  const next = clone(procedure);
  const step = stepsOf(next).find((s) => s.id === stepId);
  if (step && step.person !== true) {
    if (step.confirm) delete step.confirm;
    else step.confirm = ['submit', 'payment', 'delete'].includes(kind) ? kind : 'submit';
  }
  return result(next);
}

/** Delete one step; a parameter no step uses any more is dropped with a message. */
export function deleteStep(procedure, stepId) {
  const next = clone(procedure);
  const before = stepsOf(next).length;
  next.steps = stepsOf(next).filter((s) => s.id !== stepId);
  const extra = [];
  if (next.steps.length !== before) dropUnusedParams(next, extra);
  return result(next, extra);
}

/** Move one step up (-1) or down (+1); at the ends nothing changes. */
export function moveStep(procedure, stepId, delta) {
  const next = clone(procedure);
  const steps = stepsOf(next);
  const from = steps.findIndex((s) => s.id === stepId);
  const to = from + (delta < 0 ? -1 : 1);
  if (from >= 0 && to >= 0 && to < steps.length) [steps[from], steps[to]] = [steps[to], steps[from]];
  return result(next);
}
export const moveStepUp = (procedure, stepId) => moveStep(procedure, stepId, -1);
export const moveStepDown = (procedure, stepId) => moveStep(procedure, stepId, 1);

/** The run form: one field per parameter, with its default; a sensitive one has no field ("실행 중 직접 입력"). */
export function procedureRunForm(procedure, overrides = {}) {
  const sensitive = sensitiveNames(procedure);
  const fields = paramsOf(procedure).map((p) => {
    if (p.sensitive === true || sensitive.has(p.name)) {
      return { name: p.name, sensitive: true, editable: false, value: null, placeholder: COPY.sensitiveValue };
    }
    const own = overrides && Object.prototype.hasOwnProperty.call(overrides, p.name) ? text(overrides[p.name]) : text(p.default);
    return { name: p.name, sensitive: false, editable: true, value: own, placeholder: '' };
  });
  return { title: COPY.runTitle, fields, empty: fields.length === 0, emptyText: COPY.runNoParams, runLabel: COPY.run };
}

/** The chat message that runs a procedure: ‘{name}’ 절차를 실행해줘. {param}: {value}, ...
 * Sensitive parameters (and empty values) are left out. `values` overrides the defaults. */
export function procedureRunMessage(procedure, values = {}) {
  const form = procedureRunForm(procedure, values);
  const parts = form.fields
    .filter((f) => !f.sensitive && oneLine(f.value) !== '')
    .map((f) => `${oneLine(f.name)}: ${oneLine(f.value)}`);
  const head = COPY.runMessage(oneLine(procedure?.name));
  return parts.length ? `${head} ${parts.join(', ')}` : head;
}

/** Whether a finished Browser task block (browserStepPlacement block) can be saved as a procedure, and for which
 * (clientThreadId, cardId). Needs at least one successful act step, a card id, and no run still going. */
export function procedureSaveOffer(block, { busy = false } = {}) {
  if (busy) return null;
  const steps = Array.isArray(block?.steps) ? block.steps : [];
  const acted = steps.filter((s) => s && s.ok === true && ACT_OPS.has(String(s.op || '').replace(/^egdesk_browser_/, '')));
  if (!acted.length) return null;
  const last = steps.findLast((s) => typeof s?.cardId === 'string' && s.cardId && typeof s?.clientThreadId === 'string' && s.clientThreadId);
  if (!last) return null;
  return { clientThreadId: last.clientThreadId, cardId: last.cardId };
}
