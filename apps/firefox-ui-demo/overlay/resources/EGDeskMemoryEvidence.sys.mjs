import { canResumeNativeThread, chatSessionKind, clientThreadBinding, nativeBindingHeld } from './EGDeskChatState.sys.mjs';

// Routing hints only. The local helper verifies every operation against the signed-in owner.
export function evidenceRoute(thread, codex) {
  if (!thread || thread.type !== 'dm' || thread.id !== codex.activeThreadId || codex.hudView !== 'conversation'
      || !codex.connected || thread.profileEnabled !== true || typeof thread.agentProfileId !== 'string' || !thread.agentProfileId.trim()
      || !thread.conversationId || !clientThreadBinding(thread) || nativeBindingHeld(thread) || chatSessionKind(thread)
      || !canResumeNativeThread(thread, codex.authStatus, codex)) return null;
  return { clientThreadId: clientThreadBinding(thread), conversationId: thread.conversationId, expectedProfileId: thread.agentProfileId };
}

const RELATIONS = new Map(Object.entries({ counted: '집계', posted: '전표 반영', coverage: '적용 범위', scheduled: '예정',
  recorded: '기록', copied: '그대로 인용', derived: '계산·도출' }));
const actions = new Set(['state', 'preview', 'bind', 'read', 'revoke']);
export function scopedEvidenceRequest({ fetchJson, route, signal, current }) {
  return async (action, fields = {}) => {
    if (!actions.has(action) || signal.aborted || !current()) throw new Error('닫힌 근거 패널');
    const value = await fetchJson(`/memory-evidence/${action}`, { method: 'POST', signal, body: JSON.stringify({ ...fields, ...route }) });
    if (signal.aborted || !current()) throw new Error('닫힌 근거 패널');
    return value;
  };
}
const positive = n => Number.isSafeInteger(n) && n > 0;
const text = value => typeof value === 'string' && !!value.trim();
const termsOf = value => [...new Set(value.split(/[,，\n]/u).map(t => t.trim()).filter(Boolean))];
const marker = key => ({ data: { egMemory: key } });

// One chrome-local panel. It owns its DOM, drafts and replies, not ChatState or the transcript.
export function mountEvidencePanel({ el, host, request, current, close, agentName }) {
  const button = (key, title, onclick) => el('button', { type: 'button', ...marker(key), onclick }, title);
  const field = (name, input) => el('label', { class: 'egd-memory-field' }, el('span', {}, name), input);
  const option = (value, title) => el('option', { value: String(value) }, title);
  const control = (tag, key, name, extra = {}) => el(tag, { ...marker(key), 'aria-label': name, ...extra });
  const status = el('p', { ...marker('status'), role: 'status' });
  const note = el('p', { ...marker('mode') });
  const rows = el('section', { ...marker('rows'), 'aria-label': '허용한 행' });
  const trace = el('section', { ...marker('trace'), 'aria-label': '고정된 근거' });
  const form = el('section', { ...marker('form'), 'aria-label': '새 행 등록' });
  const exit = button('close', '닫기', () => close(true));
  const panel = el('section', { id: 'egd-memory-evidence', ...marker('panel'), role: 'dialog', 'aria-label': '기억 근거' },
    el('header', {}, el('strong', {}, '기억 근거'), exit),
    el('div', { class: 'egd-codex-input-panel-body' }, status, note, rows, trace, form));
  const alive = () => panel.isConnected && current();
  panel.addEventListener('mousedown', ev => ev.stopPropagation());
  panel.addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.stopPropagation(); close(true); } });
  host.appendChild(panel); exit.focus();
  let captures = [], readEpoch = 0, formEpoch = 0;

  const tracePart = (name, pin) => {
    if (!pin || typeof pin.text !== 'string' || !text(pin.sourceId) || !text(pin.revision) || !positive(pin.startLine)
        || !positive(pin.endLine) || pin.endLine < pin.startLine) throw new Error('invalid trace');
    const doc = captures.find(cap => cap.sourceId === pin.sourceId && cap.revision === pin.revision);
    return el('div', { class: 'egd-memory-pin' }, el('strong', {}, `${name} · ${doc?.label || '고정 문서'} · ${pin.startLine === pin.endLine ? pin.startLine : `${pin.startLine}~${pin.endLine}`}줄`),
      el('small', {}, `캡처 ${pin.sourceId} · 리비전 ${pin.revision}`), el('pre', {}, pin.text));
  };
  const read = async row => {
    if (!alive()) return;
    const seq = ++readEpoch; trace.replaceChildren(); status.textContent = '허용 상태와 고정된 줄을 확인하는 중…';
    try {
      const { trace: t } = await request('read', { id: row.id });
      if (!alive() || seq !== readEpoch) return;
      if (t?.version !== 1 || !Array.isArray(t.sources) || !t.sources.length || t.sources.length > 6) throw new Error('invalid trace');
      const parts = [tracePart('장부 행', t.ledger), ...t.sources.map(pin => tracePart(`근거 · ${RELATIONS.get(pin.relation) || '기타'}`, pin))];
      trace.replaceChildren(el('h3', {}, row.label), ...parts, button('revoke', '허용 철회', async ev => {
        if (!alive() || seq !== readEpoch) return;
        ev.currentTarget.disabled = true;
        try {
          if ((await request('revoke', { id: row.id }))?.revoked !== true) throw new Error('not revoked');
          if (alive()) await load('이 행의 재사용 허용을 철회했습니다.');
        } catch { if (alive()) await load('철회 여부를 확인할 수 없어 목록을 다시 확인했습니다.'); }
      }));
      status.textContent = '등록 당시의 줄만 표시합니다.';
    } catch { if (alive() && seq === readEpoch) await load('이 행을 열 수 없습니다. 현재 허용 목록을 다시 확인했습니다.'); }
  };

  const buildForm = () => {
    if (!captures.length) { form.replaceChildren(el('h3', {}, '등록할 캡처가 없습니다'), el('p', {},
      '이 DM에서 ＋ 첨부 → 파일 선택…으로 장부와 근거 문서를 첨부하세요. 자료를 담은 메시지를 보낸 뒤 이 패널을 다시 열면 캡처에서 줄을 고를 수 있습니다.')); return; }
    const stamp = formEpoch, editors = [];
    const label = control('input', 'label', '행 이름', { maxlength: '80', placeholder: '예: 3월 재고 정산' });
    const terms = control('input', 'terms', '찾을 말', { maxlength: '240', placeholder: '예: 재고 차이, 3월 정산' });
    const consent = control('input', 'consent', '이 DM에서 이 Agent의 재사용 허용', { type: 'checkbox' });
    consent.checked = false;
    const sources = el('div', { ...marker('sources') });
    const add = button('add-source', '근거 추가', () => appendSource());
    const busy = el('fieldset', { class: 'egd-memory-form-fields' });
    const bind = button('bind', '재사용 허용하고 등록', async () => {
      if (!alive() || stamp !== formEpoch || busy.disabled || !ready()) return;
      const fields = { consent: true, label: label.value.trim(), terms: termsOf(terms.value), ledger: ledger.pin(),
        sources: editors.map(item => ({ ...item.pin(), relation: item.relation.value })) };
      busy.disabled = true; consent.checked = false; update();
      status.textContent = '선택한 줄을 등록하는 중…';
      try {
        if (!text((await request('bind', fields))?.id)) throw new Error('not registered');
        if (alive()) await load('이 DM에서 찾을 수 있는 행으로 등록했습니다.');
      } catch { if (alive() && stamp === formEpoch) { busy.disabled = false; update(); status.textContent = '등록을 확인하지 못했습니다. 같은 줄을 중복 선택하지 않았는지 확인하고, 다시 시도하기 전에 허용 목록을 확인하세요.'; } }
    });
    const ready = () => consent.checked && text(label.value) && termsOf(terms.value).length > 0 && [ledger, ...editors].every(item => item.previewed());
    const update = () => { bind.disabled = !ready(); add.disabled = editors.length >= 6; for (const item of editors) item.remove.disabled = editors.length === 1; };
    const changed = () => { consent.checked = false; update(); };
    const editor = (isLedger, initial) => {
      const name = isLedger ? '장부 행' : '근거', box = el('fieldset', marker(isLedger ? 'ledger' : 'source'));
      const cap = control('select', 'capture', `${name} 캡처`);
      cap.append(...captures.map((c, i) => option(i, `${c.label} · ${c.lineCount}줄 · ${c.revision.slice(0, 8)}`))); cap.value = String(initial);
      let doc = captures[initial], first = !isLedger && captures.length === 1 && doc.lineCount > 1 ? 2 : 1, last = first, version = 0, seen = -1;
      const title = el('legend', {}, name);
      const lines = el('div', { class: 'egd-memory-lines' });
      const output = el('pre', marker('text'));
      const pin = () => ({ sourceId: doc.sourceId, revision: doc.revision, startLine: first, endLine: last });
      const invalidate = () => { version++; seen = -1; output.textContent = ''; changed(); };
      // A document can contain many lines. Two native selects keep each line accessible without mounting an option per line.
      const picker = (key, caption, value, set) => {
        const select = control('select', key, `${name} ${caption}`), block = Math.floor((value - 1) / 100);
        const fill = n => { const low = n * 100 + 1; select.replaceChildren(...Array.from({ length: Math.min(100, doc.lineCount - low + 1) }, (_, i) => option(low + i, String(low + i)))); };
        fill(block); select.value = String(value); select.addEventListener('change', () => set(Number(select.value)));
        const group = el('div', {}, field(caption, select));
        if (doc.lineCount > 100) {
          // Number input pages even exceptionally large captures without allocating a second huge option list.
          const max = Math.ceil(doc.lineCount / 100), page = control('input', `${key}-page`, `${name} ${caption} 구간 (100줄씩)`, { type: 'number', min: '1', max: String(max), value: String(block + 1) });
          page.addEventListener('change', () => { const n = Number(page.value); if (positive(n) && n <= max) set((n - 1) * 100 + 1); else page.value = String(block + 1); });
          group.append(field(`100줄씩 · 구간 1~${max}`, page));
        }
        return group;
      };
      const drawLines = () => { lines.replaceChildren(picker('start', isLedger ? '줄 번호' : '시작 줄', first, n => {
        first = n; last = isLedger ? n : Math.max(last, n); invalidate(); drawLines(); }));
        if (!isLedger) lines.append(picker('end', '끝 줄', last, n => { last = n; first = Math.min(first, n); invalidate(); drawLines(); })); };
      const relation = isLedger ? null : control('select', 'relation', '근거 관계');
      if (relation) { relation.append(...[...RELATIONS].map(([id, title]) => option(id, title))); relation.addEventListener('change', changed); }
      const remove = button('remove-source', '근거 삭제', () => { const at = editors.findIndex(e => e.box === box); if (at < 0 || editors.length === 1) return;
        editors.splice(at, 1); box.remove(); changed(); });
      const preview = button('preview', '선택한 줄 미리보기', async () => {
        if (!alive() || !box.isConnected) return;
        const ticket = ++version; seen = -1; output.textContent = '줄을 확인하는 중…'; changed();
        try { const result = await request('preview', { pin: pin() });
          if (!alive() || !box.isConnected || ticket !== version) return;
          if (typeof result?.text !== 'string') throw new Error('invalid preview');
          output.textContent = result.text; seen = ticket; update();
        } catch { if (alive() && box.isConnected && ticket === version) output.textContent = '이 줄을 확인할 수 없습니다. 범위를 줄이거나 다른 줄을 선택하세요.'; }
      });
      cap.addEventListener('change', () => { const next = captures[Number(cap.value)]; if (!next) return; doc = next; first = last = 1; invalidate(); drawLines(); });
      drawLines(); box.append(title, field('캡처', cap), lines); if (relation) box.append(field('관계', relation), remove); box.append(preview, output);
      return { box, pin, previewed: () => seen === version, relation, remove };
    };
    const ledger = editor(true, 0);
    const appendSource = () => { if (editors.length >= 6) return; const item = editor(false, Math.min(editors.length + 1, captures.length - 1)); editors.push(item); sources.append(item.box); changed(); };
    appendSource(); label.addEventListener('input', changed); terms.addEventListener('input', changed); consent.addEventListener('change', update);
    busy.append(ledger.box, sources, add, field('행 이름', label), field('찾을 말 (쉼표로 구분)', terms), el('label', { class: 'egd-memory-consent' }, consent,
      el('span', {}, `이 DM에서 ${agentName} Agent가 찾을 말에 맞는 요청을 받으면, 선택한 줄을 다시 사용할 수 있도록 허용합니다.`)), bind);
    form.replaceChildren(el('h3', {}, '새 행 등록'), el('p', {}, '장부 한 줄과 근거 1~6개를 고르고 각각 미리보세요.'), busy); update();
  };
  async function load(message = '') {
    const stamp = ++formEpoch; ++readEpoch; trace.replaceChildren(); rows.replaceChildren(); form.replaceChildren(); note.textContent = ''; captures = [];
    status.textContent = '이 대화에 허용된 자료를 확인하는 중…';
    try {
      const state = await request('state'); if (!alive() || stamp !== formEpoch) return;
      if (!Array.isArray(state?.captures) || !Array.isArray(state.rows)) throw new Error('invalid state');
      captures = state.captures.filter(c => text(c?.sourceId) && text(c.revision) && text(c.label) && positive(c.lineCount));
      const permitted = state.rows.filter(row => text(row?.id) && text(row.label));
      rows.replaceChildren(el('h3', {}, '현재 허용한 행'), ...(permitted.length ? permitted.map(row => button('read', row.label, () => read(row))) : [el('p', {}, '아직 허용한 행이 없습니다.')]));
      if (['off', 'advisory'].includes(state.decisionMode)) note.textContent = '현재 문맥 설정에서는 등록한 근거가 자동 첨부되지 않습니다. 문맥 설정이 켜짐(on)일 때만 첨부됩니다.';
      buildForm(); status.textContent = message;
    } catch { if (alive() && stamp === formEpoch) { status.textContent = '이 대화의 허용 목록을 확인하지 못했습니다.'; rows.replaceChildren(button('retry', '다시 확인', () => load())); } }
  }
  void load(); return panel;
}
