import {
  createJointClient,
  localBoardId,
  jointSnapshot,
  scrubJointSession,
} from './EGDeskJointBoardClient.sys.mjs';
import {appLabels,appStates,nextAppStates,isAppRef} from './EGDeskJointMiniappSchema.sys.mjs';
import {createJointAudit} from './EGDeskJointSpatialAuditView.sys.mjs';
import {describeSpatialObservation} from './EGDeskJointSpatialLabels.sys.mjs';
import {boardCardAction, boardMaterials, createBoardStructure} from './EGDeskJointBoardStructure.sys.mjs';
import {createJointPresence, projectionPresence} from './EGDeskJointPresence.sys.mjs';
const errors = {'invalid-app':'승인된 앱과 40자 이내의 항목 번호를 확인하세요.','app-unavailable':'팀 앱에 연결할 수 없습니다. 변경은 반영되지 않았습니다.','app-interrupted':'권한 또는 연결이 바뀌어 변경을 마치지 않았습니다. 현재 상태를 확인하세요.','app-busy':'이 항목의 다른 변경이 진행 중입니다.','invalid-transition':'현재 상태에서는 선택할 수 없는 변경입니다.',cycle:'서로를 기다리는 순환 관계는 만들 수 없습니다.',
  'invalid-address': 'HTTPS 주소 또는 이 컴퓨터의 loopback 주소를 입력하세요.',
  'invalid-key': '협업 서비스에서 발급한 계정 키를 입력하세요.',
  authentication: '키가 유효하지 않습니다. 다시 연결하세요.',
  unconfirmed: '서비스 연결을 확인하지 못했습니다. 공유 화면을 숨겼습니다. 쓰기 결과는 동기화 후 확인하세요.',
  unavailable: '이 항목에 접근할 수 없습니다.',
  changed: '자료가 바뀌었습니다. 최신 내용을 확인한 뒤 다시 진행하세요.',
  'already-granted': '이미 공개한 사람입니다.',
  'not-member': '이 보드의 참가자가 아닙니다. 카드만 전달하려면 단독 초대를 선택하세요.',
  'last-founder': '마지막 공동 개설자는 여기서 탈퇴할 수 없습니다.',
  'invite-closed': '종료되었거나 만료된 초대입니다.',
  'invalid-recipient': '대상 계정을 확인하세요.',
  'invalid-account': '대상 계정 ID를 확인하세요.',
  'invalid-text': '제목과 본문 또는 답을 확인하세요.',
  'already-member': '이미 참여하고 있습니다.',
  limit: '이 작업의 한도에 도달했습니다.',
};
export function createUI(h) {
  const { window: w, document: d, el } = h;
  let view = null,
    page = null,
    materialsContext = null,
    refreshing = false,
    busy = false,
    closed = false,
    lastOrigin = 'http://127.0.0.1:47631',
    warn = '',
    instanceScope = '',
    advance = '',
    proposalTitle = '';
  const local = h.readLayout() || {},
    drafts = new Map(),
    panes = new Map();
  let layouts = {};
  const api = createJointClient({
    request: (u, o) => w.fetch(u, o),
    timeoutSignal: () => w.AbortSignal.timeout(7000),
    uuid: () => w.crypto.randomUUID(),
    apply,
    unavailable: (c) => {
      warn = errors[c] || '접근 상태를 확인하세요.';
      if (page) draw();
    },
  });
  const kindName = (k) => ({ task: '업무 전표', note: '공용 메모', excerpt: '텍스트 발췌' })[k] || '자료';
  const key = (b) => localBoardId(view.instance, b.id),
    boards = () => view?.boards || [],
    getB = (k) => boards().find((b) => key(b) === k || b.id === k);
  const structure=createBoardStructure({...h,getBoard:getB});
  // Multi-user presence for the placement runtime (EGDeskJointPresence). It only reads this module's state. It stays inert,
  // with no request at all, until the host supplies this person's own row (h.selfPresence, the single-user provider), and
  // every Board starts with sharing 'off'. A card's alias is its view id on this Desk unless the host maps it otherwise.
  const placed = projectionPresence({ projections: () => h.allProjections(), boardOf: (p) => getB(p.boardId), node: (id) => d.getElementById(id), geometry: (node) => h.geometry(node) });
  const presence = createJointPresence({
    send: (body) => api.presence(body),
    self: () => (typeof h.selfPresence === 'function' ? h.selfPresence() : null),
    boards: placed.boards,
    cardAlias: (board, card) => (typeof h.presenceCardAlias === 'function' ? h.presenceCardAlias(board, card) : placed.cardAlias(board, card)),
    cardId: (alias) => (typeof h.presenceCardId === 'function' ? h.presenceCardId(alias) : placed.cardId(alias)),
  });
  const audit=createJointAudit({...h,getBoard:getB,identity:()=>instanceScope,describe:describeSpatialObservation});
  function findCard(id, scope = null) {
    for (const b of boards()) {
      const c = b.cards.find((c) => c.id === id);
      if (c && scope !== 'single') return { b, c };
    }
    if (!scope || scope === 'single') {
      const c = view?.singles.find((c) => c.id === id);
      if (c) return { b: null, c };
    }
    return null;
  }
  const lease = (c) => c.access + ':' + c.id;
  const draftKey = (c) => lease(c) + ':' + c.version;
  function boardLayout(b) {
    return (layouts['b:' + b.epoch] ??= {});
  }
  function saveGeometry() {
    if (!instanceScope) return;
    local[instanceScope] = layouts;
    h.writeLayout(local);
  }
  function pose(root) {
    const c = findCard(root?.dataset.jointItem)?.c;
    if (!c || root.dataset.jointLease !== c.access) return;
    const p = root.dataset.projectionId && h.allProjections().find((z) => z.id === root.dataset.projectionId),
      g = h.geometry(root);
    if (p) {
      const b = getB(p.boardId);
      if (!b) return;
      g.x -= p.offset.x;
      g.y -= p.offset.y;
      boardLayout(b)[lease(c)] = g;
      boardLayout(b).offset = { ...p.offset };
    } else layouts[(root.dataset.jointManaged === 'reply' ? 'r:' : 's:') + lease(c)] = g;
    saveGeometry();
    if (p) h.refreshRegion(p);
  }
  function snapshot(b) {
    return jointSnapshot(view.instance, b, boardLayout(b));
  }
  function closeB(k) {
    const p = h.byId(k);
    if (!p) return false;
    for (const m of p.members) {
      const v = d.getElementById(m.viewId);
      if (v) pose(v);
      const q = panes.get(m.sourceId);
      if (q) h.dispose(q);
    }
    structure.removed(p);h.removeProjection(p);audit.sync();
    h.updateRows();
    d.querySelector('[data-testid="rail-board-list"]')?.focus();
    return true;
  }
  function openLocal(k) {
    const b = getB(k);
    if (!b) return false;
    const previous = h.byId(key(b));
    if (previous) h.reconcile(previous, snapshot(b));
    const out = h.open(snapshot(b), b.epoch, boardLayout(b).offset);
    if (out) {
      boardLayout(b).offset = { ...out.offset };
      saveGeometry();
    }
    return out;
  }
  async function fresh() {
    if (!api.connected) throw Error('disconnected');
    return api.refresh();
  }
  async function openB(k) {
    await fresh();
    hidePanel();
    return openLocal(k);
  }
  function drop(root) {
    if (root?.isConnected) h.dispose(root);
  }
  function apply(v) {
    const previous = view;
    view = v;audit.sync();
    if (!v) {
      presence.reset();
      structure.clear();
      if (materialsContext) hidePanel();
      for (const p of h.allProjections()) h.removeProjection(p);
      for (const el of d.querySelectorAll('[data-joint-managed]')) drop(el);
      drafts.clear();
      panes.clear();
      instanceScope = '';
      layouts = {};
      if (page) page = { type: 'hub' };
      h.updateRows();
      if (page) draw();
      return;
    }
    const ns = v.instance + '/' + v.self.id;
    if (ns !== instanceScope) {
      instanceScope = ns;
      layouts = local[ns] && typeof local[ns] === 'object' ? local[ns] : {};
    }
    const allowedLayouts = new Map();
    for (const b of v.boards) {
      allowedLayouts.set('b:' + b.epoch, new Set(b.cards.map(lease)));
    }
    for (const c of [...v.singles, ...v.boards.flatMap((b) => b.cards)]) {
      allowedLayouts.set('r:' + lease(c), true);
      if (c.scope === 'single') allowedLayouts.set('s:' + lease(c), true);
    }
    let pruned = false;
    for (const [k, record] of Object.entries(layouts)) {
      const ok = allowedLayouts.get(k);
      if (!ok) {
        delete layouts[k];
        pruned = true;
      } else if (ok !== true)
        for (const item of Object.keys(record)) {
          if (item !== 'offset' && !ok.has(item)) {
            delete record[item];
            pruned = true;
          }
        }
    }
    if (pruned) saveGeometry();
    for (const p of h.allProjections()) {
      const b = getB(p.boardId);
      if (!b || p.jointAccess !== b.epoch) {
        structure.removed(p);h.removeProjection(p);
        continue;
      }
      h.reconcile(p, snapshot(b));
    }
    const validDraft = new Set();
    for (const b of v.boards) for (const c of b.cards) validDraft.add(draftKey(c));
    for (const c of v.singles) validDraft.add(draftKey(c));
    for (const k of drafts.keys()) if (!validDraft.has(k)) drafts.delete(k);
    for (const root of d.querySelectorAll('[data-joint-managed]')) {
      const c = findCard(root.dataset.jointItem)?.c;
      if (!c || c.access !== root.dataset.jointLease) {
        drop(root);
        continue;
      }
      if (root.dataset.jointManaged === 'reply') {
        if (c.replied || !c.claimed || +root.dataset.jointVersion !== c.version) drop(root);
      } else renderItem(root, c);
    }
    if (!materialsContext && (
      (page?.board && !getB(page.board)) ||
      (page?.card && !findCard(page.card)) ||
      (page?.invite && !v.invites.some((i) => i.id === page.invite))
    )) {
      page = { type: 'hub' };
    }
    if (materialsContext) {
      const b = activeMaterialsBoard();
      if (!b) hidePanel();
      else if (page.binding && !materialEntry(page.binding)) showMaterials();
      else if (page.type === 'materials' && page.signature !== materialsSignature(b)) draw();
    } else if (page && ['hub', 'board', 'card','appReview'].includes(page.type)) draw();
    h.updateRows();
    h.presentationSync?.();
    if (previous && v.invites.some((i) => !previous.invites.some((o) => o.id === i.id)))
      h.notice('새 협업 초대가 있습니다. Desk → 사람과 공유에서 확인하세요.');
  }
  function showError(e) {
    if (closed) return;
    warn = errors[e?.message] || '작업을 완료하지 못했습니다. 연결과 권한을 다시 확인하세요.';
    if (page) draw();
    else h.notice(warn);
  }
  const on = (fn) => (ev) => {
    ev?.stopPropagation?.();
    Promise.resolve().then(fn).catch(showError);
  };
  const btn = (label, id, fn, extra = {}) =>
    el(
      'button',
      {
        type: 'button',
        class: 'egd-joint-button',
        data: { testid: 'joint-' + id, noWindowDrag: 'true' },
        onclick: on(fn),
        ...extra,
      },
      label,
    );
  function itemRoot(c, scope) {
    const sh = h.makeWindow('card'),
      root = sh.root;
    root.dataset.jointItem = c.id;
    root.dataset.jointLease = c.access;
    root.dataset.jointScope = scope;
    root.dataset.testid = 'joint-card';
    root._jointShell = sh;
    renderItem(root, c);
    return root;
  }
  function renderItem(root, c) {
    const entry=findCard(c.id,c.scope),b=entry?.b,edge=b?.links.find(e=>e.child===c.id),parent=edge&&b.cards.find(x=>x.id===edge.parent);const order=b?b.cards.findIndex(x=>x.id===c.id)+1:0;
    const signature = JSON.stringify([c,b?.title,order,edge,parent?.title]);
    if (root._jointSignature === signature) return;
    const sh = root._jointShell;
    if (!sh) return;
    root._jointSignature = signature;
    root.dataset.jointVersion = String(c.version);
    root.setAttribute('aria-label', c.title);
    sh.slots.identity.replaceChildren(el('strong', {}, c.title));
    const head = el(
      'div',
      { class: 'egd-joint-caption' },
      kindName(c.kind) +
        ' · ' +
        (c.scope === 'single' ? '카드 단독 공유' : c.own ? '내가 제공한 자료' : '나에게 공개됨'),
    );
    const work=c.app&&el('section',{class:'egd-joint-app-paper','aria-label':appLabels[c.app.type],data:{testid:'joint-app-paper',state:c.app.state}},el('div',{class:'egd-joint-app-meta'},el('small',{},appLabels[c.app.type]),el('code',{},c.app.ref)),el('strong',{class:'egd-joint-app-state',data:{testid:'joint-app-state'}},appStates[c.app.state]),el('small',{data:{testid:'joint-app-role'}},!c.app.available?'팀 앱 꺼짐 · 저장된 상태':c.app.mayEdit?'변경 허용':'읽기 전용'));
    if(work&&c.app.mayEdit)for(const to of nextAppStates(c.app.type,c.app.state))work.append(btn(appStates[to]+'로 변경…','app-change',()=>{const live=findCard(c.id,c.scope)?.c;if(live?.app?.editStamp!==c.app.editStamp||live.version!==c.version)throw Error('changed');form('appReview',{card:c.id,operation:{action:'appStep',card:c.id,access:c.access,editStamp:c.app.editStamp,appRev:c.app.rev,version:c.version,to}});},{data:{testid:'joint-app-change',next:to}}));
    sh.slots.content.replaceChildren(
      b ? el('button',{type:'button',class:'egd-joint-membership',data:{testid:'joint-membership'},title:'이 보드의 실제 구성 보기',onclick:on(()=>{const p=h.byId(key(b));if(p){h.select(p);inspect(p);}})},el('strong',{},'공용 보드'),el('span',{},b.title),el('small',{},'자료 '+String(order).padStart(2,'0'))) : el('small',{class:'egd-joint-private-label'},'카드 한 장만 공유됨'),
      work||el('h3', {}, c.title),
      parent?btn((edge.kind==='waits'?'선행 자료: ':'참조 자료: ')+parent.title,'relation-target',()=>structure.jump(key(b),parent.id)):head,
      ...(c.own&&c.replies.length?[el('details',{class:'egd-joint-reply-slip',data:{testid:'joint-received-reply'}},el('summary',{},'이 전표에 온 회신 '+c.replies.length+'건'),el('small',{},c.replies[c.replies.length-1].src+' → '+c.title),el('p',{class:'egd-joint-text'},c.replies[c.replies.length-1].body))]:[]),
      ...(work?[]:[el('p', { class: 'egd-joint-text' }, c.body),el('small', {}, '작성자: ' + c.author)]),
      el(
        'div',
        { class: 'egd-joint-actions' },
        c.own
          ? btn('공개·회신 관리', 'item-manage', () => panel('card', c.id))
          : c.replied
            ? el('span', {}, '회신 보냄')
            : !c.claimed
              ? btn('이 일 맡기', 'claim', () => act({ action: 'claim', grant: c.access, version: c.version }))
              : btn('회신 쪽지 열기', 'draft', () => openDraft(c.id, root)),
      ),
    );
  }
  function mount(ref, k) {
    const b = getB(k),
      c = b?.cards.find((c) => c.id === ref?.item && c.access === ref.access);
    if (!c) return null;
    return itemRoot(c, 'board');
  }
  async function openSingle(id) {
    await fresh();
    const c = view?.singles.find((c) => c.id === id);
    if (!c) return;
    hidePanel();
    let root = [...d.querySelectorAll('[data-joint-scope="single"]')].find(
      (r) => r.dataset.jointItem === id && r.dataset.jointLease === c.access,
    );
    if (!root) {
      root = itemRoot(c, 'single');
      if (layouts['s:' + lease(c)]) h.applyGeometry(root, layouts['s:' + lease(c)]);
      else h.placeFree(root);
    }
    h.reveal(root);
  }
  async function openDraft(id, parent) {
    await fresh();
    const c = findCard(id)?.c;
    if (!c || !c.claimed || c.own || c.replied) return;
    const existing = panes.get(id);
    if (existing?.isConnected) {
      h.reveal(existing);
      return;
    }
    const sh = h.makeWindow('reply'),
      root = sh.root;
    root.dataset.jointItem = c.id;
    root.dataset.jointLease = c.access;
    root.dataset.jointVersion = String(c.version);
    root.dataset.testid = 'joint-reply-window';
    root.setAttribute('aria-label', '개인 회신 초안');
    sh.slots.identity.append(el('strong', {}, '개인 회신 · '+c.title));
    const input = el('textarea', {
      'aria-label': '보낼 답',
      maxlength: 2000,
      data: { testid: 'joint-draft-text' },
    });
    input.value = drafts.get(draftKey(c)) || '';
    input.addEventListener('input', () => drafts.set(draftKey(c), input.value));
    sh.slots.content.append(
      el('small', {}, '받는 사람: ' + c.author),
      el('h3', {data:{testid:'joint-reply-origin'}}, c.title+'에 대한 회신'),
      input,
      btn('회신 내용 확인', 'reply-review', () => {
        const body = input.value.trim();
        if (!body) return;
        const beforeVersion = c.version;
        sh.slots.content.replaceChildren(
          el('strong', {}, '받는 사람: ' + c.author),
          el('p', { class: 'egd-joint-text' }, body),
          btn('다시 쓰기', 'draft-back', () => {
            drop(root);
            return openDraft(id, parent);
          }),
          btn('이 사람에게 회신', 'reply-send', async () => {
            const current = findCard(id)?.c;
            if (!current || current.version !== beforeVersion || current.access !== c.access)
              throw Error('changed');
            await act({ action: 'reply', grant: c.access, version: c.version, to: c.author, body });
            drafts.delete(draftKey(c));
          }),
        );
      }),
    );
    const at = h.geometry(parent);
    h.applyGeometry(
      root,
      layouts['r:' + lease(c)] || { x: at.x + 140, y: at.y + 84, width: 316, height: 230, zIndex: at.zIndex + 1 },
    );
    panes.set(id, root);
    sh.registerCleanup(() => {
      if (panes.get(id) === root) panes.delete(id);
    });
    h.reveal(root);
    input.focus();
  }
  async function act(data) {
    if (busy) throw Error('busy');
    busy = true;
    try {
      warn = '';
      return await api.act(data);
    } finally {
      busy = false;
    }
  }
  function rows() {
    return boards().map((b) => ({
      id: key(b),
      title: b.title + ' · 공용',
      current:
        !!h.byId(key(b))?.id &&
        h.allProjections().some((p) => p.boardId === key(b) && d.getElementById(p.id)?.dataset.active === 'true'),
      saved: true,
      joint: true,
      closed: !h.byId(key(b)),
      archived: false,
      dirty: false,
      count: b.cards.length,
      activityAt: 0,
    }));
  }
  const railMaterials = () => d.querySelector('[data-testid="joint-board-structure"]');
  function selectedJointBoard(p = h.selected()) {
    const b = api.connected && p?.jointAccess && getB(p.boardId);
    return b && p.jointAccess === b.epoch && h.byId(p.boardId) === p ? b : null;
  }
  function activeMaterialsBoard() {
    const p = h.selected(), b = selectedJointBoard(p);
    return b && materialsContext?.projectionId === p.id && materialsContext.scope === instanceScope ? b : null;
  }
  function materialEntry(binding) {
    const b = activeMaterialsBoard();
    const c = b?.cards.find(x => x.id === binding.id && x.access === binding.access);
    return c && JSON.stringify(c) === binding.snapshot && boardCardAction(c) === binding.action ? {b,c} : null;
  }
  const materialsSignature = b => JSON.stringify([b.title, b.cards.map(c => [c.id,c.title,c.access,c.version,boardCardAction(c)]), b.links]);
  function syncMaterialsControl() {
    if (materialsContext && !activeMaterialsBoard()) hidePanel();
    const control = railMaterials(), b = selectedJointBoard();
    if (!control) return;
    if (!b && d.activeElement === control) d.querySelector('.egd-rail-switcher')?.focus({preventScroll:true});
    control.hidden = !b;
    control.setAttribute('aria-label', b ? b.title + ' · 구성/자료' : '구성/자료');
    control.setAttribute('aria-expanded', String(!!materialsContext));
  }
  function showMaterials(focusCard = page?.binding?.id) {
    page = {type:'materials'};
    warn = '';
    draw();
    const rowAction = focusCard && [...d.querySelectorAll('[data-testid="joint-material-action"]')]
      .find(n => n.dataset.materialId === focusCard);
    (rowAction || d.querySelector('#egd-joint-panel h3'))?.focus({preventScroll:!rowAction});
  }
  async function openMaterials(p, anchor) {
    if (!selectedJointBoard(p)) return;
    h.select(p);
    hidePanel({restoreFocus:false});
    materialsContext = {projectionId:p.id,scope:instanceScope,anchor};
    const context = materialsContext;
    page = {type:'materials-loading'};
    draw();
    syncMaterialsControl();
    try {
      await fresh();
      if (materialsContext === context && activeMaterialsBoard()) showMaterials();
    } catch (error) {
      if (materialsContext === context) hidePanel();
      showError(error);
    }
  }
  async function openMaterialAction(card, action) {
    const currentPage = page;
    const binding = {id:card.id,access:card.access,action,snapshot:JSON.stringify(card)};
    await fresh();
    if (page !== currentPage || !materialsContext) return;
    if (!materialEntry(binding)) { showMaterials(card.id); return; }
    form(action === 'manage' ? 'card' : 'material-' + action, {card:card.id,binding});
  }
  function hidePanel({restoreFocus = true} = {}) {
    const context = materialsContext;
    materialsContext = null;
    d.getElementById('egd-joint-panel')?.remove();
    page = null;
    warn = '';
    if (context) {
      syncMaterialsControl();
      if (restoreFocus) {
        const rail = railMaterials();
        const original = context.anchor;
        const r = original?.getBoundingClientRect();
        const hit = r && d.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const anchor = hit && original.contains(hit) ? original : rail && !rail.hidden ? rail : d.querySelector('.egd-rail-switcher');
        anchor?.focus({preventScroll:true});
      }
    }
  }
  function panel(type = 'hub', ref = null) {
    if (materialsContext) {
      if (type === 'card' && ref === page?.binding?.id) return form(type, {card:ref});
      hidePanel({restoreFocus:false});
    }
    warn = '';
    if (!view && type !== 'hub') {
      advance = type;
      type = 'hub';
    }
    page = { type, ...(type === 'board' ? { board: ref } : type === 'card' ? { card: ref } : {}) };
    draw();
  }
  function form(type, info = {}) {
    warn = '';
    const binding = page?.binding;
    page = { type, ...(binding ? {binding} : {}), ...info };
    draw();
    if (materialsContext) (d.querySelector('#egd-joint-panel h3') || d.querySelector('[data-testid="joint-panel-close"]'))?.focus();
  }
  const ptxt = (t) => el('p', { class: 'egd-joint-help' }, t),
    fld = (label, id, { multi = false, val = '', secret = false } = {}) => {
      const input = el(multi ? 'textarea' : 'input', {
        'aria-label': label,
        autocomplete: 'off',
        spellcheck: 'false',
        ...(multi ? { rows: 4 } : { type: secret ? 'password' : 'text' }),
        data: { testid: 'joint-' + id },
      });
      input.value = val;
      return { input, row: el('label', { class: 'egd-joint-field' }, el('span', {}, label), input) };
    };
  function draw() {
    if (!page || closed) return;
    let box = d.getElementById('egd-joint-panel');
    if (!box) {
      box = el('section', {
        id: 'egd-joint-panel',
        class: 'egd-edge egd-frosted',
        role: 'dialog',
        'aria-label': '사람과 공유',
      });
      d.documentElement.append(box);
      box.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          hidePanel();
        }
      });
    }
    box.setAttribute('aria-label', materialsContext ? 'Board · 구성/자료' : '사람과 공유');
    const main = el('div', { class: 'egd-joint-panel-body' });
    box.replaceChildren(
      el('header', {}, el('strong', {}, materialsContext ? '구성/자료' : '사람과 공유'), btn('닫기', 'panel-close', hidePanel)),
      main,
    );
    if (warn) main.append(el('p', { role: 'status' }, warn));
    const add = (...nodes) => main.append(...nodes.filter(Boolean));
    const heading = (t) => el('h3', materialsContext ? {tabindex:'-1'} : {}, t);
    const back = () => materialsContext ? showMaterials() : panel('hub');
    if (page.type === 'materials-loading') {
      add(el('p', {role:'status'}, '현재 자료 권한 확인 중…'));
      box.querySelector('[data-testid="joint-panel-close"]')?.focus({preventScroll:true});
      return;
    }
    if (page.type === 'materials') {
      const board = activeMaterialsBoard();
      if (!board) { hidePanel(); return; }
      const previousFocus = page.focusCard;
      page.signature = materialsSignature(board);
      add(heading(board.title), board.cards.length ? boardMaterials(el, board, (card, action) => {
        const label = {manage:'공개·회신 관리',claim:'이 일 맡기',reply:'회신 쪽지 열기'}[action];
        return btn(label, 'material-action', () => openMaterialAction(card, action), {
          'aria-label':card.title + ' · ' + label,
          onfocus: () => {page.focusCard = card.id;},
          data:{testid:'joint-material-action',materialId:card.id,action},
        });
      }) : ptxt('현재 내게 열린 자료가 없습니다.'));
      if (previousFocus) ([...main.querySelectorAll('[data-material-id]')].find(n => n.dataset.materialId === previousFocus) || main.querySelector('h3'))?.focus();
      return;
    }
    if (!view) {
      if (api.connected) {
        add(
          ptxt('현재 권한을 확인할 수 없어 자료를 숨겼습니다.'),
          btn('다시 연결 확인', 'sync', fresh),
          btn('연결 끊기', 'disconnect', disconnect),
        );
        return;
      }
      const address = fld('협업 서비스 주소', 'origin', { val: lastOrigin }),
        token = fld('이 서비스의 계정 키', 'key', { secret: true });
      add(
        heading('협업 서비스 연결'),
        ptxt(
          '운영자가 제공한 주소와 이 서비스 전용 키를 사용합니다. AI·브라우저 계정과 별개이며 키는 Firefox 창에만 보관하며 연결 해제나 Firefox 종료 때 잊습니다.',
        ),
        address.row,
        token.row,
        btn('이 주소에 연결', 'connect', async () => {
          const o = address.input.value.trim(),
            k = token.input.value;
          token.input.value = '';
          await api.connect(o, k);
          lastOrigin = o;
          if (advance === 'propose') {
            advance = '';
            form('propose');
          } else panel('hub');
        }),
      );
      return;
    }
    const b = page.board ? getB(page.board) : null,
      entry = page.binding ? materialEntry(page.binding) : page.card ? findCard(page.card) : null,
      c = entry?.c;
    const drawnPage = page;
    const send = async (action, after = back) => {
      const current = page;
      if (drawnPage.binding && current !== drawnPage) return;
      if (current.binding) {
        await fresh();
        if (page !== current) return;
        if (!materialEntry(current.binding)) { showMaterials(); return; }
      }
      await act(action);
      if (!current.binding || page === current) after();
      return true;
    };
    if (page.type === 'material-claim' && c) {
      add(heading(c.title), ptxt(c.body), btn('확인하고 맡기', 'material-claim-confirm', () => send({action:'claim',grant:c.access,version:c.version})),
        btn('취소', 'material-decline', back));
      return;
    }
    if (page.type === 'material-reply' && c) {
      const current = page;
      const reply = fld('보낼 답', 'material-reply-text', {multi:true,val:drafts.get(draftKey(c)) || ''});
      reply.input.maxLength = 2000;
      reply.input.addEventListener('input', () => drafts.set(draftKey(c),reply.input.value));
      const review = btn('회신 내용 확인', 'material-reply-review', () => {
        if (page === current && reply.input.value.trim()) form('material-reply-review', {card:c.id,body:reply.input.value.trim()});
      });
      add(heading(c.title + '에 대한 회신'), ptxt('받는 사람: ' + c.author), reply.row, review, btn('취소', 'material-decline', back));
      return;
    }
    if (page.type === 'material-reply-review' && c) {
      const body = page.body;
      add(heading(c.title + '에 대한 회신 확인'), ptxt('받는 사람: ' + c.author), el('p',{class:'egd-joint-text'},page.body),
        btn('이 사람에게 회신', 'material-reply-send', async () => {
          if (await send({action:'reply',grant:c.access,version:c.version,to:c.author,body})) drafts.delete(draftKey(c));
        }), btn('다시 쓰기', 'material-reply-back', () => form('material-reply',{card:c.id})),
        btn('취소', 'material-decline', back));
      return;
    }
    if (page.type === 'hub') {
      add(
        heading(view.self.name + ' · ' + view.self.id),
        btn('공용 Board 함께 만들기', 'propose', () => form('propose')),
        btn('지금 동기화', 'sync', fresh),
        btn('연결 끊기', 'disconnect', disconnect),
      );
      if (view.invites.length) add(heading('받은 초대'));
      for (const i of view.invites)
        add(
          btn(
            (i.kind === 'single' ? '카드만: ' : i.kind === 'form' ? '공동 개설: ' : '보드 참여: ') +
              i.title +
              ' · ' +
              i.from,
            'invite-detail',
            () => form('invite', { invite: i.id }),
          ),
        );
      if (boards().length) add(heading('참여 중인 보드'));
      for (const b of boards()) add(btn(b.title + ' · 공용', 'open', () => openB(key(b))));
      if (view.singles.length) add(heading('보드 없이 받은 카드'));
      for (const c of view.singles) add(btn(c.title, 'single', () => openSingle(c.id)));
      for (const i of view.sent)
        add(
          el(
            'div',
            { class: 'egd-joint-line' },
            ptxt('수락 대기: ' + i.title + ' → ' + i.to),
            btn('제안 취소', 'cancel-invite', () => send({ action: 'cancelInvite', invite: i.id })),
          ),
        );
      return;
    }
    if (page.type === 'propose') {
      const title = fld('새 공용 Board 이름', 'title', { val: proposalTitle }),
        to = fld('함께 만들 사람의 계정 ID', 'to');
      proposalTitle = '';
      add(
        heading('함께 만들기'),
        ptxt('두 사람이 수락한 뒤 빈 공용 Board 하나를 만듭니다. 개인 원본이나 배치는 복사하지 않습니다.'),
        title.row,
        to.row,
        btn('공동 개설 제안 보내기', 'send-proposal', () =>
          send({ action: 'propose', title: title.input.value, to: to.input.value.trim() }),
        ),
        btn('뒤로', 'back', back),
      );
      return;
    }
    if (page.type === 'invite') {
      const i = view.invites.find((x) => x.id === page.invite);
      if (!i) {
        back();
        return;
      }
      add(
        heading(i.title),
        ptxt('보낸 사람: ' + i.from + ' · 받는 사람: ' + view.self.id),
        ptxt(
          i.kind === 'single'
            ? '이 텍스트 카드 한 장에만 접근합니다.'
            : i.kind === 'form'
              ? '두 사람이 함께 만드는 빈 Board입니다.'
              : '보드에 참여합니다. 자료는 별도로 공개받습니다.',
        ),
        ptxt('수락 기한: ' + new Date(i.expires).toLocaleString()),
        btn('수락하고 열기', 'accept', async () => {
          const old = new Set(i.kind === 'single' ? view.singles.map((x) => x.id) : boards().map((x) => x.id));
          await act({ action: 'accept', invite: i.id });
          const target = (i.kind === 'single' ? view.singles : boards()).find((x) => !old.has(x.id));
          if (!target) {
            back();
            return;
          }
          try {
            if (i.kind === 'single') await openSingle(target.id);
            else await openB(key(target));
          } catch {
            back();
            h.notice('수락 결과와 화면 열기를 구분합니다. 연결을 확인하고 받은 항목을 다시 여세요.');
          }
        }),
        btn('거절', 'decline', () => send({ action: 'decline', invite: i.id })),
      );
      return;
    }
    if (page.type === 'board' && b) {
      add(
        heading(b.title),
        ptxt('현재 내게 허용된 카드 ' + b.cards.length + '개'),
        btn('카드 추가', 'add', () => form('add', { board: key(b) })),
        ...(view.appCatalog?.length?[btn('팀 앱 항목 놓기','add-app',()=>form('addApp',{board:key(b)}))]:[]),
        b.role === 'founder' ? btn('사람 초대', 'join', () => form('join', { board: key(b) })) : null,
      );
      for (const c of b.cards)
        add(
          btn(c.title + ' · ' + (c.own ? '내 자료' : '받은 자료'), 'board-item', () => {
            if (c.own) panel('card', c.id);
            else {
              hidePanel();
              openLocal(key(b));
              const p = h.byId(key(b));
              const m = p?.members.find((m) => m.sourceId === c.id);
              h.reveal(m && d.getElementById(m.viewId));
            }
          }),
        );
      for (const person of b.people.filter((z) => z.role === 'member'))
        add(
          btn(person.person + ' 참여 회수…', 'exclude', () =>
            form('confirm', {
              board: key(b),
              operation: { action: 'exclude', board: b.id, to: person.person },
              copy: person.person + '의 보드 참여와 해당 권한을 회수합니다.',
            }),
          ),
        );
      add(
        btn('탈퇴…', 'leave', () =>
          form('confirm', {
            board: key(b),
            operation: { action: 'leave', board: b.id },
            copy: '창 닫기와 다릅니다. 내 보드 참여와 내가 제공한 자료의 공개가 종료됩니다.',
          }),
        ),
      );
      return;
    }
    if (page.type === 'join' && b) {
      const to = fld('초대할 계정 ID', 'to');
      add(
        heading('이 Board에 참여 요청'),
        ptxt(b.title + ' · 자료를 자동 공개하지 않습니다.'),
        to.row,
        btn('보드 초대 보내기', 'invite-board', () =>
          send({ action: 'inviteBoard', board: b.id, to: to.input.value.trim() }),
        ),
      );
      return;
    }
    if(page.type==='addApp'&&b){const ref=fld('업무 항목 번호','app-ref'),kind=el('select',{'aria-label':'승인된 팀 앱',data:{testid:'joint-app-type'}},...view.appCatalog.map(t=>el('option',{value:t},appLabels[t])));add(heading('팀 앱 항목을 책상에 놓기'),ptxt('운영자가 이미 실행한 팀 앱입니다. 새 항목은 이 서버에 저장됩니다. 다른 사람의 읽기·변경은 별도입니다.'),kind,ref.row,btn('업무 항목 놓기','save-app',()=>{if(!isAppRef(ref.input.value.trim()))throw Error('invalid-app');return send({action:'addApp',board:b.id,type:kind.value,ref:ref.input.value.trim()},()=>{hidePanel();openLocal(key(b));});}),btn('취소','back',()=>panel('board',key(b))));return;}
    if(page.type==='appReview'&&c?.app){const a=page.operation;if(!c.app.mayEdit||c.app.rev!==a.appRev||c.app.editStamp!==a.editStamp||c.access!==a.access||c.version!==a.version){hidePanel();h.notice('권한이나 항목이 바뀌어 변경 요청을 닫았습니다.');return;}add(heading(c.app.ref+' 상태 변경'),ptxt(appStates[c.app.state]+' → '+appStates[a.to]),ptxt('이 한 항목이 팀 서버에 저장되고, 읽을 권한이 있는 사람에게 갱신됩니다.'),btn('이 변경 공유','app-commit',()=>send(a,hidePanel)),btn('취소','back',hidePanel));return;}
    if ((page.type === 'add' && b) || (page.type === 'edit' && c&&!c.app)) {
      const editing = page.type === 'edit',
        t = fld('카드 제목', 'title', { val: editing ? c.title : '' }),
        body = fld('카드 본문', 'body', { multi: true, val: editing ? c.body : '' }),
        select = el(
          'select',
          { 'aria-label': '카드 종류', data: { testid: 'joint-kind' } },
          ...['task', 'note', 'excerpt'].map((k) => el('option', { value: k }, kindName(k))),
        );
      if (editing) select.value = c.kind;
      add(
        heading(editing ? '공개 중인 원문 수정' : '카드 추가'),
        ptxt(
          editing
            ? '이 카드를 이미 받은 사람에게 새 내용이 보입니다.'
            : '추가하면 ' +
                lastOrigin +
                ' 협업 서버에 제목·본문을 저장합니다. 다른 참가자에게는 아직 공개하지 않습니다.',
        ),
        editing ? null : select,
        t.row,
        body.row,
      );
      if (!editing)
        for (const m of h.memos())
          add(
            btn(m.label + ' 본문 가져오기', 'copy-memo', () => {
              body.input.value = m.text;
              select.value = 'excerpt';
              body.input.focus();
            }),
          );
      add(
        btn(editing ? '수정 반영' : '이 Board에 추가', 'save-card', () =>
          send(
            editing
              ? { action: 'editCard', card: c.id, version: c.version, title: t.input.value, body: body.input.value }
              : {
                  action: 'addCard',
                  board: b.id,
                  title: t.input.value,
                  body: body.input.value,
                  kind: select.value,
                },
            () => panel('board', key(editing ? entry.b : b)),
          ),
        ),
      );
      return;
    }
    if (page.type === 'card' && c?.own) {
      add(
        heading(c.title),
        ptxt(c.body),
        materialsContext ? btn('구성/자료로 돌아가기','material-back',back) : null,
        btn('공개할 사람 선택', 'share', () => form('share', { card: c.id })),
        btn('자료 연결 편집','link-edit',()=>form('relation',{card:c.id})),
        c.app?null:btn('내용 수정', 'edit', () => form('edit', { card: c.id })),
        btn('현재 위치를 공용 배치로 제안…', 'place', () => {
          const p = h.byId(key(entry.b)),
            m = p?.members.find((m) => m.sourceId === c.id),
            e = m && d.getElementById(m.viewId);
          if (!e) throw Error('unavailable');
          const g = h.geometry(e);
          form('confirm', {
            card: c.id,
            copy: '이 카드의 보드 안 위치만 공유합니다. 다른 카드, 참가자의 개인 책상·시점은 움직이지 않습니다.',
            operation: {
              action: 'place',
              card: c.id,
              version: c.version,
              layoutVersion: c.layoutVersion,
              x: Math.round(g.x - p.offset.x),
              y: Math.round(g.y - p.offset.y),
            },
          });
        }),
      );
      for (const g of c.grants)
        add(
          el(
            'div',
            { class: 'egd-joint-line' },
            ptxt(g.person + ' · ' + (g.scope === 'single' ? '카드 단독' : '보드 안')),
            ...(g.scope==='board'?[btn(g.photo?'배치 사진 사용 허용 회수…':'배치 사진에서 사용 허용…','photo-permission',()=>form('confirm',{card:c.id,copy:g.person+' · '+c.title+'의 보이는 글자와 위치를 OpenAI Decisions용 배치 사진에 넣을 수 있는 권한을 '+(g.photo?'회수':'허용')+'합니다. 당사자가 사진을 확인하고 전송해야 하며, 이미 전송한 사진을 지우지는 못합니다.',operation:{action:'photoPermission',card:c.id,grant:g.id,version:c.version,allow:!g.photo}}))]:[]),
            ...(c.app&&g.scope==='board'?[btn(g.appEdit?'변경 권한 회수…':'상태 변경 허용…','app-permission',()=>form('confirm',{card:c.id,copy:g.person+' · '+c.app.ref+' 한 건의 상태 변경만 '+(g.appEdit?'회수':'허용')+'합니다. 다른 자료에는 적용하지 않습니다.',operation:{action:'appPermission',card:c.id,grant:g.id,version:c.version,allow:!g.appEdit}}))]:[]),
            btn('공개 회수…', 'revoke', () =>
              form('confirm', {
                card: c.id,
                copy: g.person + '의 이 카드 공개를 회수합니다. 이미 확인한 내용을 되돌릴 수는 없습니다.',
                operation: { action: 'revoke', card: c.id, grant: g.id },
              }),
            ),
          ),
        );
      if (c.replies.length) add(heading(c.title+'에 대한 회신'));
      for (const r of c.replies) add(ptxt(r.src + ': ' + r.body));
      add(
        btn('카드 제거…', 'remove', () =>
          form('confirm', {
            card: c.id,
            copy: '제공한 카드를 보드와 현재 공개 대상에서 제거합니다.',
            operation: { action: 'removeCard', card: c.id, version: c.version },
          }),
        ),
      );
      return;
    }
    if(page.type==='relation'&&c?.own&&entry.b){const board=entry.b,prior=board.links.find(x=>x.child===c.id),others=board.cards.filter(x=>x.id!==c.id);const kind=el('select',{'aria-label':'연결 의미',data:{testid:'joint-link-kind'}},el('option',{value:'waits'},'이 카드 작업의 선행 자료'),el('option',{value:'refers'},'이 카드에서 참고하는 자료'));const target=el('select',{'aria-label':'같은 보드에서 연결할 자료',data:{testid:'joint-link-to'}},...others.map(x=>el('option',{value:x.id},x.title)));if(prior){target.value=prior.parent;kind.value=prior.kind;}add(heading(c.title+'의 자료 연결'),ptxt('내가 명시한 관계입니다. 두 자료를 모두 볼 수 있는 사람에게만 보이며, 열람권이나 자동 실행을 추가하지 않습니다.'),others.length?kind:null,others.length?target:ptxt('같은 보드에 열 수 있는 다른 카드가 없습니다.'),others.length?btn('관계 저장','link-save',()=>send({action:'linkCard',card:c.id,version:c.version,prior:prior?.stamp??null,parent:target.value,kind:kind.value},()=>panel('card',c.id))):null,prior?btn('이 관계 지우기','link-remove',()=>send({action:'unlinkCard',card:c.id,version:c.version,prior:prior.stamp},()=>panel('card',c.id))):null,btn('뒤로','back',()=>panel('card',c.id)));return;}
    if (page.type === 'share' && c?.own) {
      const to = fld('받는 사람의 계정 ID', 'to'),
        scope = el(
          'select',
          { 'aria-label': '공개 방식', data: { testid: 'joint-scope' } },
          el('option', { value: 'board' }, '이미 참여한 사람에게 보드 안에서 공개'),
          el('option', { value: 'single' }, '카드 한 장만 별도로 초대'),
        );
      add(
        heading('공개 범위'),
        ptxt(c.app?'선택한 앱 항목의 번호·현재 상태를 읽기 전용으로 공개합니다. 변경 권한은 보드 참가자에게만 따로 줄 수 있습니다.':'선택한 카드의 제목과 본문만 공개합니다.'),
        to.row,
        scope,
        btn('보내기 전 확인', 'share-preview', () => {
          const dst = to.input.value.trim();
          form('confirm', {
            card: c.id,
            copy:
              '받는 사람: ' +
              dst +
              ' · ' +
              (scope.value === 'single' ? '카드만, 부모 보드 정보 제외' : '보드 안의 이 카드만') +
              '\n' +
              c.title +
              '\n' +
              (c.app?appLabels[c.app.type]+' · '+c.app.ref+' · '+appStates[c.app.state]+' · 읽기 전용':c.body),
            operation: { action: 'share', card: c.id, version: c.version, to: dst, scope: scope.value },
          });
        }),
      );
      return;
    }
    if (page.type === 'confirm') {
      const { copy, operation } = page;
      add(
        heading('확인'),
        el('p', { class: 'egd-joint-text' }, copy),
        btn('확인하고 적용', 'confirm', () => send(operation)),
        btn('취소', 'back', back),
      );
      return;
    }
    page = { type: 'hub' };
    draw();
  }
  function disconnect() {
    if (instanceScope) {
      delete local[instanceScope];
      h.writeLayout(local);
    }
    api.disconnect();
    draw();
  }
  function inspect(p){structure.toggle(p);h.refreshRegion(p);}
  const timer = w.setInterval(() => {
    if (api.connected && typeof h.selfPresence === 'function') void presence.tick().catch(() => {});
    if (api.connected && !refreshing && !busy) {
      refreshing = true;
      fresh()
        .catch(() => {})
        .finally(() => {
          refreshing = false;
        });
    }
  }, 3000);
  w.addEventListener(
    'unload',
    () => {
      closed = true;
      w.clearInterval(timer);
      page = null;
      api.disconnect();
    },
    { once: true },
  );
  return {
    presence: { snapshot: () => presence.snapshot(), share: (board) => presence.share(board), setShare: (board, level) => presence.setShare(board, level) },
    audit,structure,inspect,panel,fresh,openMaterials,syncMaterialsControl,presentationBoard(p){const b=api.connected&&p&&getB(p.boardId);return b&&b.epoch===p.jointAccess?{scope:instanceScope,board:b}:null;},
    propose(title) {
      proposalTitle = title || '';
      panel('propose');
    },
    rows,
    hasBoard: (k) => !!getB(k),
    permits: (k, epoch) => getB(k)?.epoch === epoch,
    openBoard: (k) => openB(k).catch(showError),
    closeBoard: closeB,
    mount,
    recordPose: pose,
    scrub: (s) =>
      scrubJointSession(
        s,
        [...d.querySelectorAll('[data-joint-managed]')].map((n) => n.id),
      ),
  };
}
