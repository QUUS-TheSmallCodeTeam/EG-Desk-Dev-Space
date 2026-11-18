// Local Board policy and one-shot preparation. No Chat/CLI or delivery adapter.
const route = '/v1/board-agent-ask/';
const encoder = new TextEncoder();
export const MAX_EXCERPTS = 8;
export const MAX_EXCERPT_BYTES = 1500;
export const boardAgentAskSupported = state => Array.isArray(state?.capabilities?.portable) && state.capabilities.portable.includes('boardAgentAsk');
const stale = 'Board, Agent 또는 공개 설정이 바뀌었습니다. 다시 열어 확인해 주세요.';
const unavailable = '이 기기에서 Board Agent 답변을 사용할 수 없습니다. 직접 회신은 계속 쓸 수 있습니다.';
const cleanExcerpt = value => value.replace(/\r\n?/g, '\n').normalize('NFC').trim();
const validExcerpt = value => typeof value === 'string' && value === cleanExcerpt(value) && !!value &&
  !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value.replace(/[\n\t]/g, '')) && encoder.encode(value).length <= MAX_EXCERPT_BYTES;
const validExcerpts = values => Array.isArray(values) && values.length <= MAX_EXCERPTS && values.every(validExcerpt);
const codePattern = /^egask1-[0-9a-f]{32}$/;
const styles = { plain: '기본', warm: '따뜻하게', concise: '간결하게', formal: '격식 있게', playful: '가볍고 친근하게' };
const isRevision = value => Number.isSafeInteger(value) && value > 0;
const isText = value => typeof value === 'string' && !!value.trim();
const toDate = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const draftAvailable = availability => availability?.draft === true && isText(availability.model);

function readPolicy(body) {
  const policy = body?.policy, availability = body?.availability;
  if (policy !== null && !(policy && isText(policy.version) && isText(policy.profileId) && isText(policy.profileName) &&
    isRevision(policy.profileRevision) && validExcerpts(policy.excerpts) && typeof policy.stale === 'boolean' && typeof policy.publicInstructions === 'string')) return null;
  if (typeof availability?.decision !== 'boolean' || typeof availability.draft !== 'boolean' ||
    (availability.model !== null && !isText(availability.model))) return null;
  return { policy, availability };
}

export function createBoardAgentAsk({ post, loadProfiles, isCurrent, onState, onAnswer, now = Date.now }) {
  let active = null;
  const view = () => active?.view || null;
  function update(s, delta) {
    if (s !== active) return;
    s.view = { ...s.view, ...delta };
    onState(s.view);
  }
  async function call(path, body) {
    try {
      const response = await post(`${route}${path}`, body);
      return response?.status >= 200 && response.status < 300 ? response.body : null;
    } catch { return null; }
  }
  const cancelTicket = ticket => { if (isText(ticket)) void call('cancel', { ticket }); };
  function discard(s) {
    const ticket = s?.view?.prepared?.ticket;
    if (ticket) cancelTicket(ticket);
  }
  function close({ force = false } = {}) {
    const s = active;
    if (!s) return true;
    if (s.view.step === 'writing' && !force) return false;
    active = null;
    discard(s);
    onState(null);
    return true;
  }
  function current(s) {
    if (!s || s !== active || s.view.step === 'stopped') return false;
    if (isCurrent(s.binding)) return true;
    discard(s);
    s.view = { boardTitle: s.binding.board.title, owner: !s.binding.review };
    update(s, { step: 'stopped', error: stale });
    return false;
  }
  const forStep = (s, step) => current(s) && s.view.step === step;
  async function open(binding) {
    if (!binding || active || !isCurrent(binding)) return;
    const s = { binding, view: { boardTitle: binding.board.title, owner: !binding.review } };
    active = s;
    update(s, { step: 'loading' });
    const [snapshot, profiles] = await Promise.all([
      call('policy', { boardId: binding.board.id, action: 'get' }).then(readPolicy),
      binding.review ? [] : Promise.resolve().then(loadProfiles).catch(() => []),
    ]);
    if (!forStep(s, 'loading')) return;
    if (!snapshot) { update(s, { step: 'stopped', error: unavailable }); return; }
    if (binding.review) {
      update(s, { ...snapshot, step: 'choose', mode: 'extract', decisionEgress: false, error: null });
    } else {
      const { policy } = snapshot;
      update(s, { ...snapshot, step: 'policy', profiles, profileId: policy?.profileId ?? '',
        inputs: policy?.excerpts.length ? [...policy.excerpts] : [''], publicInstructions: policy?.publicInstructions ?? '', error: null });
    }
  }
  function pickProfile(id) {
    const s = active;
    if (forStep(s, 'policy') && (id === '' || s.view.profiles.some(profile => profile.id === id))) s.view.profileId = id;
  }
  function editExcerpt(index, text) {
    const s = active;
    if (forStep(s, 'policy') && index < s.view.inputs.length) s.view.inputs[index] = text;
  }
  function editInstructions(value) {
    if (forStep(active, 'policy')) active.view.publicInstructions = value;
  }
  function addExcerpt() {
    const s = active;
    if (forStep(s, 'policy') && s.view.inputs.length < MAX_EXCERPTS) update(s, { inputs: [...s.view.inputs, ''], focusKey: `excerpt-${s.view.inputs.length}` });
  }
  async function changePolicy(action) {
    const s = active;
    if (!forStep(s, 'policy') || !['save', 'revoke', 'issue'].includes(action)) return;
    const { policy, profileId, inputs, profiles, publicInstructions } = s.view;
    const body = { boardId: s.binding.board.id, action, expectedVersion: policy?.version ?? null };
    if (action === 'save') {
      if (!profiles.some(profile => profile.id === profileId)) {
        update(s, { error: '현재 사용 중인 Agent를 선택해 주세요.', focusKey: 'profile' }); return;
      }
      const excerpts = inputs.map(cleanExcerpt);
      const invalid = excerpts.findIndex(value => value && !validExcerpt(value));
      if (invalid !== -1) {
        update(s, { error: '발췌문은 각각 UTF-8 1,500바이트 이하여야 하며 특수 제어 문자를 넣을 수 없습니다.', focusKey: `excerpt-${invalid}` }); return;
      }
      const instructions = cleanExcerpt(publicInstructions);
      if (encoder.encode(instructions).length > 1200 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(instructions.replace(/[\n\t]/g, ''))) {
        update(s, { error: '공개 답변 지침은 UTF-8 1,200바이트 이하여야 하며 제어 문자를 넣을 수 없습니다.', focusKey: 'instructions' }); return;
      }
      Object.assign(body, { profileId, excerpts: excerpts.filter(Boolean), publicInstructions: instructions });
    } else if (!policy) return;
    else if (action === 'issue' && (policy.stale || policy.profileId !== profileId || publicInstructions !== policy.publicInstructions ||
      JSON.stringify(inputs.map(cleanExcerpt).filter(Boolean)) !== JSON.stringify(policy.excerpts))) {
      update(s, { error: '코드를 만들기 전에 변경한 설정을 저장해 주세요.' }); return;
    }
    update(s, { step: 'writing', error: null });
    const raw = await call('policy', body);
    const result = readPolicy(raw);
    if (!forStep(s, 'writing')) return;
    if (!result || (action === 'revoke' ? result.policy !== null : result.policy?.profileId !== profileId || result.policy.stale)) {
      update(s, { step: 'stopped', error: '저장 결과를 확인하지 못했습니다. 설정을 다시 열어 최신 상태를 확인해 주세요.' }); return;
    }
    if (action === 'issue') {
      if (!codePattern.test(raw.askCode || '') || !Number.isFinite(raw.expiresAt) || raw.expiresAt <= now()) {
        update(s, { step: 'stopped', error: '질문 코드 생성 결과를 확인하지 못했습니다.' }); return;
      }
      update(s, { step: 'issued', askCode: raw.askCode, codeExpiresAt: raw.expiresAt, focusKey: 'issued-code' });
    } else if (action === 'save') {
      update(s, { ...result, step: 'policy', inputs: [...body.excerpts, ...(body.excerpts.length ? [] : [''])],
        publicInstructions: body.publicInstructions, message: '외부 질문 설정을 저장했습니다.', focusKey: 'issue' });
    } else update(s, { step: 'done', message: '외부 질문 설정을 해제했습니다.' });
  }
  function chooseMode(mode) {
    const s = active;
    if (forStep(s, 'choose') && (mode === 'extract' || (mode === 'draft' && draftAvailable(s.view.availability)))) update(s, { mode, error: null, focusKey: `mode-${mode}` });
  }
  function chooseDecision(value) {
    const s = active;
    if (forStep(s, 'choose') && s.view.availability.decision) s.view.decisionEgress = value === true;
  }
  async function prepare() {
    const s = active;
    if (!forStep(s, 'choose') || !s.view.policy || s.view.policy.stale) return;
    const { mode, decisionEgress, policy, availability } = s.view;
    if ((mode === 'draft' && !draftAvailable(availability)) || (decisionEgress && !availability.decision)) return;
    update(s, { step: 'preparing', error: null });
    // Do not abort the prepare response: a ticket that arrives after Escape
    // or a Board change still needs best-effort cancellation, never a run.
    const p = await call('prepare', { boardId: s.binding.board.id, request: s.binding.review, mode, decisionEgress });
    if (!forStep(s, 'preparing')) { cancelTicket(p?.ticket); return; }
    const expiry = toDate(p?.expiresAt);
    if (!isText(p?.ticket) || !Number.isFinite(expiry) || expiry <= now() || p.mode !== mode || p.decisionEgress !== decisionEgress ||
      p.question !== s.binding.review.question || p.profileName !== policy.profileName || p.profileRevision !== policy.profileRevision ||
      !validExcerpts(p.excerpts) || p.excerpts.some(value => !policy.excerpts.includes(value)) ||
      !Object.hasOwn(styles, p.replyStyle) || p.publicInstructions !== (mode === 'draft' ? policy.publicInstructions : '') ||
      (mode === 'draft' ? p.provider !== 'openai' || p.draftModel !== availability.model || p.model !== p.draftModel : p.draftModel !== null || p.model !== p.decisionModel) ||
      (decisionEgress ? !isText(p.decisionModel) || JSON.stringify(p.excerpts) !== JSON.stringify(policy.excerpts) : p.decisionModel !== null) ||
      (p.policyVersion != null && p.policyVersion !== policy.version)) {
      cancelTicket(p?.ticket);
      update(s, { step: 'stopped', error: stale }); return;
    }
    update(s, { step: 'preview', prepared: p, expiry, focusKey: 'preview-heading' });
  }
  function back() {
    const s = active;
    if (!forStep(s, 'preview')) return;
    discard(s);
    update(s, { step: 'choose', prepared: null, mode: 'extract', decisionEgress: false, focusKey: 'mode-extract' });
  }
  async function run() {
    const s = active;
    if (!forStep(s, 'preview')) return;
    if (s.view.expiry <= now()) {
      discard(s);
      update(s, { step: 'choose', prepared: null, mode: 'extract', decisionEgress: false, error: '확인 시간이 지났습니다. 다시 준비해 주세요.' }); return;
    }
    const { ticket, mode, decisionEgress } = s.view.prepared;
    update(s, { step: 'running', error: null });
    // No retry: a timeout or failed response does not prove nothing ran.
    const result = await call('run', { ticket, confirm: true });
    if (!forStep(s, 'running')) return;
    if (result?.mode !== mode || typeof result.answer !== 'string' || !['local', 'decision', 'draft'].includes(result.source)) {
      discard(s);
      update(s, { step: 'stopped', prepared: null, error: '실행 결과를 확인하지 못했습니다. 자동으로 다시 실행하지 않습니다.' }); return;
    }
    s.view.prepared = null;
    const binding = s.binding;
    close();
    onAnswer(binding, { answer: result.answer, mode, decisionEgress, source: result.source });
  }
  return { view, open, close, invalidate: () => current(active), pickProfile, editExcerpt, editInstructions, addExcerpt,
    save: () => changePolicy('save'), revoke: () => changePolicy('revoke'), issue: () => changePolicy('issue'), chooseMode, chooseDecision, prepare, back, run };
}

export function boardAgentAskContent(el, view, flow, onClose) {
  const { step, policy, availability, boardTitle } = view;
  const owner = view.owner;
  const title = owner ? '외부 질문에 쓸 Agent' : 'Board Agent로 답변 준비';
  const text = (content, kind = 'copy') => el('p', { class: kind === 'warning' ? 'egd-portable-warning' : 'egd-store-panel-copy' }, content);
  const status = content => el('p', { role: 'status', class: 'egd-store-panel-status' }, content);
  const button = (id, label, onclick, primary = false) => el('button', { type: 'button', onclick,
    class: primary ? 'egd-store-primary' : null, data: { testid: `board-agent-ask-${id}`, focusKey: id } }, label);
  const row = (...buttons) => el('div', { class: 'egd-review-actions' }, ...buttons);
  const display = (name, value) => el('div', {}, el('dt', {}, name), el('dd', { class: 'egd-review-value', dir: 'auto' }, value));
  const list = (...items) => el('dl', { class: 'egd-review-preview' }, ...items);
  let content = [];
  if (step === 'policy') {
    const select = el('select', { class: 'egd-portable-input', onchange: ev => flow.pickProfile(ev.currentTarget.value),
      data: { testid: 'board-agent-ask-profile', focusKey: 'profile' } }, el('option', { value: '' }, 'Agent 선택'),
    ...view.profiles.map(p => el('option', { value: p.id }, `${p.name} · 버전 ${p.activeRevision}`)));
    select.value = view.profiles.some(p => p.id === view.profileId) ? view.profileId : '';
    const inputs = view.inputs.map((value, index) => {
      const id = `excerpt-${index}`;
      const input = el('textarea', { class: 'egd-portable-input', rows: '2', autocomplete: 'off',
        data: { testid: `board-agent-ask-${id}`, focusKey: id }, oninput: ev => flow.editExcerpt(index, ev.currentTarget.value) });
      input.value = value;
      return el('label', { class: 'egd-portable-field' }, `공개 발췌문 ${index + 1}`, input);
    });
    const instructions = el('textarea', { class: 'egd-portable-input', rows: '2', autocomplete: 'off',
      data: { testid: 'board-agent-ask-instructions', focusKey: 'instructions' }, oninput: ev => flow.editInstructions(ev.currentTarget.value) });
    instructions.value = view.publicInstructions;
    content = [text('이 Board에만 적용됩니다. Agent의 현재 버전을 고정하며, 파일을 보낸 사람에게 Agent 설정이나 Board 접근 권한을 주지 않습니다.'),
      text('직접 입력한 공개 발췌문만 사용합니다. 최대 8개, 각 UTF-8 1,500바이트입니다. 빈 칸은 저장하지 않습니다. 비밀번호·키·토큰을 넣지 마세요.'),
      policy ? text(`저장됨: ${policy.profileName} · 버전 ${policy.profileRevision}${policy.stale ? ' (다시 선택하고 저장해야 사용할 수 있음)' : ''}`, policy.stale ? 'warning' : 'copy') : null,
      view.message ? status(view.message) : null,
      !view.profiles.length ? status('선택할 수 있는 활성 Agent가 없습니다.') : null,
      el('div', { class: 'egd-review-form' }, el('label', { class: 'egd-portable-field' }, '고정할 Agent', select), ...inputs,
        el('label', { class: 'egd-portable-field' }, '공개 답변 지침 (선택, 초안에만 사용, UTF-8 1,200바이트)', instructions)),
      row(inputs.length < MAX_EXCERPTS ? button('add-excerpt', '발췌문 칸 추가', flow.addExcerpt) : null,
        policy ? button('revoke', '설정 해제', flow.revoke) : null, button('save', '설정 저장', flow.save, true)),
      policy && !policy.stale ? text(policy.codeActive ? '사용 가능한 일회용 코드가 있습니다.' : '사용 가능한 질문 코드가 없습니다.') : null,
      policy && !policy.stale ? text('코드를 가진 사람은 누구든 질문을 한 번 제출할 수 있습니다. 신원은 확인하지 않습니다. 비용이 드는 API는 Board 소유자가 별도로 확인하고 실행할 때만 사용합니다. 코드를 다시 만들거나 설정을 저장·해제하면 기존 코드는 무효가 됩니다.') : null,
      policy && !policy.stale ? row(button('issue', policy.codeActive ? '기존 코드를 무효화하고 다시 만들기' : '일회용 질문 코드 만들기', flow.issue)) : null];
  } else if (step === 'issued') {
    const code = el('input', { type: 'text', readonly: 'true', autocomplete: 'off', class: 'egd-portable-input', dir: 'ltr',
      data: { testid: 'board-agent-ask-issued-code', focusKey: 'issued-code' } });
    code.value = view.askCode;
    content = [text('이 화면에서만 코드를 볼 수 있습니다. 공유할 사람에게 직접 보내세요. 한 번 실행되면 다시 쓸 수 없습니다.'),
      text(`만료: ${new Date(view.codeExpiresAt).toLocaleString('ko-KR')}`), el('label', { class: 'egd-portable-field' }, '일회용 Board 질문 코드', code)];
  } else if (step === 'choose') {
    if (!policy || policy.stale) content = [text(policy ? '고정한 Agent를 지금 사용할 수 없습니다. Board ⋯에서 확인해 주세요.' : '이 Board에는 외부 질문에 쓸 Agent가 설정되어 있지 않습니다.'), text('창을 닫고 직접 회신을 쓸 수 있습니다.')];
    else {
      const mode = (value, caption) => {
        const input = el('input', { type: 'radio', name: 'egd-board-agent-ask-mode', value,
          data: { testid: `board-agent-ask-mode-${value}`, focusKey: `mode-${value}` }, onchange: () => flow.chooseMode(value) });
        input.checked = view.mode === value;
        return el('label', { class: 'egd-portable-check' }, input, caption);
      };
      const decision = el('input', { type: 'checkbox', data: { testid: 'board-agent-ask-decision', focusKey: 'decision' },
        onchange: ev => flow.chooseDecision(ev.currentTarget.checked) });
      decision.checked = view.decisionEgress;
      content = [list(display('고정 Agent', `${policy.profileName} · 버전 ${policy.profileRevision}`)),
        mode('extract', '관련 공개 발췌문만 찾기 (이 기기에서 처리, 문장 생성 안 함)'),
        draftAvailable(availability) ? mode('draft', `OpenAI로 초안 만들기 · ${availability.model}`) : text('OpenAI 초안: 전용 키 또는 모델이 설정되어 있지 않습니다.'),
        availability.decision ? el('label', { class: 'egd-portable-check' }, decision, '별도 Decisions API에 질문과 공개 발췌문을 보내 관련성을 판단하도록 허용') : null,
        row(button('prepare', '이 Board와 Agent로 실행 내용 확인', flow.prepare, true))];
    }
  } else if (step === 'preview' || step === 'running') {
    const p = view.prepared;
    content = [el('strong', { tabindex: '-1', data: { focusKey: 'preview-heading' } }, '실행에 사용하는 내용'),
      list(display('고정 Agent', `${p.profileName} · 버전 ${p.profileRevision}`), display('받은 질문', p.question),
        ...(p.excerpts.length ? p.excerpts.map((value, i) => display(`승인된 공개 발췌문 ${i + 1}`, value)) : [display('공개 발췌문', '없음')]),
        p.mode === 'draft' ? display('공개 답변 말투', styles[p.replyStyle]) : null,
        p.mode === 'draft' && p.publicInstructions ? display('공개 답변 지침', p.publicInstructions) : null),
      p.mode === 'draft' ? text(`OpenAI의 ${p.draftModel} 모델이 표시된 질문·관련 공개 발췌문·공개 말투 및 지침을 봅니다. Board 운영 쪽의 전용 API 키로 비용을 부담하며, 개인 Chat·CLI와 구독 사용량을 쓰지 않습니다.`, 'warning') : text('관련 공개 발췌문을 원문 그대로 찾습니다. 새 답변 문장을 만들지 않습니다.'),
      p.decisionEgress ? text(`관련성 판단을 위해 별도 Decisions API (${p.decisionModel})에 표시된 질문과 공개 발췌문 전부를 보냅니다. Board 운영 쪽의 Decisions API 설정을 사용합니다.`, 'warning') : text(p.mode === 'extract' ? '외부 API로 보내지 않습니다.' : '별도 Decisions API에는 보내지 않습니다.'),
      text('실행해도 회신 파일을 만들거나 전달하지 않습니다. 결과를 회신 작성 창에서 확인하고 편집할 수 있습니다.'),
      step === 'running' ? status('한 번 실행 중… 닫으면 결과를 회신에 넣지 않습니다.') : row(button('back', '뒤로', flow.back), button('run', '이 내용으로 한 번 실행', flow.run, true))];
  } else if (step === 'done') content = [status(view.message)];
  else if (step === 'loading' || step === 'preparing' || step === 'writing') {
    content = [status(step === 'loading' ? '이 Board의 설정을 확인하는 중…' : step === 'preparing' ? '실행 내용을 준비하는 중… 아직 모델을 호출하지 않습니다.' : '이 Board의 설정을 업데이트하는 중…')];
  }
  return { title, children: [el('header', { class: 'egd-store-panel-head' }, el('strong', {}, title),
    el('button', { class: 'egd-store-panel-close', type: 'button', 'aria-label': `${title} 닫기`, disabled: step === 'writing', onclick: onClose,
      data: { testid: 'board-agent-ask-close', focusKey: 'close' } }, '×')),
  list(display('선택한 Board', boardTitle)),
  view.error ? el('p', { role: 'alert', class: 'egd-store-panel-status egd-portable-error', data: { testid: 'board-agent-ask-error' } }, view.error) : null,
  ...content].filter(Boolean) };
}
