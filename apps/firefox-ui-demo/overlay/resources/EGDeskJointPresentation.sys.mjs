import {worksitePlans} from './EGDeskAdjacentWorkbench.sys.mjs';
import {overallPlans,describeComposition} from './EGDeskCompositionChoice.sys.mjs';
// Privileged Joint Board preview. No preferences, network primitives or direct card mutations.
export const PRESENTATION_OPTIONS = Object.freeze({ keep: '현재 배치 유지', overview: '선택 자료 전체 보기',
  focus: '지정 자료 한 장에 집중', pair: '선택한 두 장 나란히 비교',front:'지정 자료만 앞으로',tidy:'자리를 살려 전체 정돈',handoff:'업무 순서대로 인계 보기',workbench:'주 작업과 참고 자료 함께 보기' });
export const PRESENTATION_DECISION_PATHS = Object.freeze(Object.fromEntries(['prepare', 'run', 'cancel']
  .map(k => [k, `/decision/board-presentation/${k}`])));
const QUESTION = '요청의 목적에 맞는 내 화면 구성 한 가지를 고르세요. 근거가 없으면 현재 배치 유지입니다. 자료 내용 추론이나 권한 변경은 하지 마세요.';
const MODEL = 'gpt-6-luna';
const DESTINATION = 'https://api.openai.com/v1/decisions';
const KINDS = new Set(['업무 전표', '메모', '자료', '상태표']);
const TICKET = /^[0-9a-f]{48}$/;
const modeOK = m => m === 'on' || m === 'advisory';
const numeric = Number.isFinite;
const validRect = r => !!r && [r.x, r.y, r.width, r.height].every(numeric) && r.width > 0 && r.height > 0;
const rect = ({ x, y, width, height }) => ({ x, y, width, height });
const right = r => r.x + r.width;
const bottom = r => r.y + r.height;
const overlaps = (a, b) => a.x < right(b) && right(a) > b.x && a.y < bottom(b) && bottom(a) > b.y;
const inside = (a, b) => a.x >= b.x && a.y >= b.y && right(a) <= right(b) && bottom(a) <= bottom(b);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const expand = (r, n) => ({ x: r.x - n, y: r.y - n, width: r.width + 2 * n, height: r.height + 2 * n });
const cover = rs => { const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y));
  return { x, y, width: Math.max(...rs.map(right)) - x, height: Math.max(...rs.map(bottom)) - y }; };
const isWide = s => s.viewport.width >= 664;
const isTall = s => s.viewport.height >= 200;
const canMove = c => c.movable === true && c.pinned === false;

// Same camera-relative world plane as the cards. At rest viewport = chrome safe area in client coordinates.
export function presentationWorldBounds(s) {
  const { viewport: v, camera: { x, y, zoom } } = s;
  return { x: (v.x - x) / zoom, y: (v.y - y) / zoom, width: v.width / zoom, height: v.height / zoom };
}
function fitCamera(s, bounds) {
  const { viewport: v, camera: c } = s;
  const wanted = Math.min(v.width / bounds.width, v.height / bounds.height, c.maxZoom);
  if (wanted < c.minZoom) return null;
  const zoom = wanted, x = v.x + v.width / 2 - (bounds.x + bounds.width / 2) * zoom;
  const y = v.y + v.height / 2 - (bounds.y + bounds.height / 2) * zoom;
  return { x, y, zoom };
}
function pairTargets(s, cards) {
  if (cards.length !== 2 || !cards.every(canMove) || !isWide(s) || !isTall(s)) return null;
  const { zoom } = s.camera, safe = expand(presentationWorldBounds(s), -Math.ceil(8 / zoom));
  const gap = Math.ceil(24 / zoom), half = Math.floor((safe.width - gap) / 2);
  const ids = new Set(cards.map(c => c.id));
  const blockers = [ ...s.cards.filter(c => !ids.has(c.id)).map(c => c.rect), ...s.obstacles ].map(r => expand(r, 2));
  const minima = cards.map(c => [Math.max(c.minWidth, Math.ceil(160 / zoom)), Math.max(c.minHeight, Math.ceil(96 / zoom))]);
  if (minima.some(([w, h]) => w > half || h > safe.height)) return null;
  for (const density of [1, .8, .6, .4, 0]) {
    const dims = cards.map(({ rect: r }, i) => {
      const [minW, minH] = minima[i];
      const scale = Math.min(density, half / r.width, safe.height / r.height);
      return [Math.max(minW, Math.floor(r.width * scale)), Math.max(minH, Math.floor(r.height * scale))];
    });
    const [a, b] = dims, dx = a[0] + gap, width = dx + b[0], height = Math.max(a[1], b[1]);
    const cx = Math.round(safe.x + (safe.width - width) / 2), cy = Math.round(safe.y + (safe.height - height) / 2);
    const yOff = dims.map(([, h]) => Math.floor((height - h) / 2));
    const xs = new Set([cx, Math.ceil(safe.x), Math.floor(right(safe) - width)]);
    const ys = new Set([cy, Math.ceil(safe.y), Math.floor(bottom(safe) - height)]);
    const relevant = blockers.filter(o => overlaps(o, safe));
    for (const o of relevant) for (let i = 0; i < 2; i++) {
      const ox = i ? dx : 0;
      xs.add(Math.ceil(right(o) - ox)); xs.add(Math.floor(o.x - dims[i][0] - ox));
      ys.add(Math.ceil(bottom(o) - yOff[i])); ys.add(Math.floor(o.y - dims[i][1] - yOff[i]));
    }
    const nearest = (values, ctr, lo, hi) => [...values].filter(n => n >= lo && n <= hi)
      .sort((a, b) => Math.abs(a - ctr) - Math.abs(b - ctr)).slice(0, 32);
    for (const y of nearest(ys, cy, safe.y, bottom(safe) - height))
      for (const x of nearest(xs, cx, safe.x, right(safe) - width)) {
        const next = dims.map(([width, height], i) => ({ x: x + (i ? dx : 0), y: y + yOff[i], width, height }));
        if (next.every(r => inside(r, safe) && relevant.every(o => !overlaps(o, r))))
          return next.map((r, i) => ({ id: cards[i].id, rect: r }));
      }
  }
  return null;
}
export function presentationPlan(s, cards, focusId, option) {
  const empty = { option, framing: null, camera: null, targets: [] };
  if (option === 'keep') return empty;
  if(['tidy','handoff','workbench'].includes(option))return s.overall?overallPlans(s,cards,focusId)[option]??null:null;
  if(option==='front'){const c=cards.find(x=>x.id===focusId);if(!c||!canMove(c)||!s.overall)return null;return {...empty,targets:[{id:c.id,rect:rect(c.rect),z:Math.max(s.topZ??0,...s.cards.map(x=>x.z||0))+1}]};}
  if (option === 'pair') {
    const targets = pairTargets(s, cards);
    return targets ? { ...empty, targets } : null;
  }
  const framed = option === 'overview' ? cards : option === 'focus' ? cards.filter(c => c.id === focusId) : [];
  if (!framed.length) return null;
  const bounds = expand(cover(framed.map(c => c.rect)), 28 / s.camera.zoom);
  const camera = fitCamera(s, bounds);
  return camera ? { ...empty, framing: presentationWorldBounds({ ...s, camera }), camera } : null;
}

// Copy a closed, primitive-only projection snapshot before retaining it. raw.revision is an opaque host key.
function snapshot(raw) {
  if (!raw || typeof raw.revision !== 'string' || !raw.revision || raw.ready !== true || !validRect(raw.viewport) ||
      !Array.isArray(raw.cards) || !Array.isArray(raw.obstacles)) return null;
  const { x, y, zoom, minZoom, maxZoom } = raw.camera || {};
  if (![x, y, zoom, minZoom, maxZoom].every(numeric) || zoom <= 0 || minZoom <= 0 || maxZoom < minZoom) return null;
  const seen = new Set();
  const cards = raw.cards.filter(c => c.visible === true && c.canRead === true && validRect(c.rect) &&
      typeof c.id === 'string' && c.id && typeof c.revision === 'string' && c.revision)
    .flatMap(c => {
      if (seen.has(c.id)) return [];
      seen.add(c.id);
      return [{ id: c.id, revision: c.revision, rect: rect(c.rect),z:Number.isFinite(c.z)?c.z:0,inFrame:c.inFrame!==false, title: String(c.title || '자료'),
        kind: KINDS.has(c.kind) ? c.kind : null, maySendDescriptor: c.maySendDescriptor === true,
        movable: c.movable === true, pinned: c.pinned !== false,
        minWidth: numeric(c.minWidth) && c.minWidth > 0 ? c.minWidth : 230,
        minHeight: numeric(c.minHeight) && c.minHeight > 0 ? c.minHeight : 150 }];
    });
  const decision = raw.decision?.available === true && modeOK(raw.decision.mode) && typeof raw.decision.revision === 'string' && raw.decision.revision
    ? { mode: raw.decision.mode, revision: raw.decision.revision } : null;
  return { revision: raw.revision, viewport: rect(raw.viewport), camera: { x, y, zoom, minZoom, maxZoom }, cards,overall:raw.overall===true,topZ:raw.topZ||0,links:(raw.links||[]).filter(e=>seen.has(e.child)&&seen.has(e.parent)).map(({child,parent,kind})=>({child,parent,kind})),
    obstacles: raw.obstacles.filter(validRect).map(rect), decision };
}
export function decisionReviewPacket(p) {
  return { model: MODEL, input: [{ role: 'user', content: [{ type: 'input_text', text: p.cue },
    { type: 'input_json', data: { selected: p.items.map(({ slot, kind, focus }) => ({ slot, kind, designatedFocus: focus })),
      availableWidth: p.wide ? '두 장 폭' : '한 장 폭' } }] }],
    questions: [{ type: 'choice', name: 'board_view', instructions: QUESTION,
      choices: p.options.map(k => ({ value: PRESENTATION_OPTIONS[k] })) }] };
}
const normalizeCue = cue => {
  if (typeof cue !== 'string') return '';
  const normalized = cue.normalize('NFC').trim();
  return normalized.length <= 280 && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(normalized) ? normalized : '';
};

// Controller owns a single session and one local inverse. Dependency functions are privileged, synchronous except request.
export function createPresentationController(h) {
  let active = null, undo = null;
  const now = h.now || (() => performance.now());
  function read(key) { try { return snapshot(h.read(key)); } catch { return null; } }
  function cancelTicket(ticket, request) {
    if (!TICKET.test(ticket || '')) return;
    try { Promise.resolve(request(PRESENTATION_DECISION_PATHS.cancel, { ticket }, { signal: AbortSignal.timeout(2000) })).catch(() => {}); } catch {}
  }
  function discard(a) {
    const job = a.job;
    a.job = null;
    a.suggestion = null;
    if (job) {
      clearTimeout(job.timer);
      job.controller.abort();
      cancelTicket(job.ticket, job.request);
    }
  }
  function close({ restoreFocus = false, forgetUndo = false, reason = '' } = {}) {
    const a = active;
    active = null;
    if (forgetUndo) undo = null;
    if (a) {
      discard(a);
      h.dismiss?.({ restoreFocus, reason });
    }
  }
  function sync() {
    const a = active;
    const current = a ? read(a.key) : undo ? read(undo.key) : null;
    if (undo && !(same(undo.snapshot, a?.key === undo.key || !a ? current : read(undo.key)))) undo = null;
    if (a && !same(a.snapshot, current)) { close({ reason: 'Board 상태가 바뀌어 미리보기를 닫았습니다.' }); return false; }
    return !!a;
  }
  const selected = a => a.snapshot.cards.filter(c => a.ids.has(c.id));
  const choices=a=>{if(a.plans)return a.plans;const cards=selected(a),out={};for(const k of ['keep','overview','focus','pair','front'])out[k]=presentationPlan(a.snapshot,cards,a.focusId,k);if(a.snapshot.overall)Object.assign(out,worksitePlans(a.snapshot,cards,a.focusId));return a.plans=out;};
  function descriptor(a) {
    const cards = selected(a);
    if (!a.snapshot.decision || typeof h.request !== 'function' || !cards.length || cards.length > 12 ||
        cards.some(c => !c.maySendDescriptor || !c.kind)) return null;
    const items = cards.map(c => ({ kind: c.kind, focus: c.id === a.focusId, movable: canMove(c) }));
    const wide = isWide(a.snapshot), tall = isTall(a.snapshot);
    // No misleading partial selection or option the live desk cannot carry out.
    const options = ['keep', 'overview', ...(items.some(c => c.focus) ? ['focus'] : []),
      ...(items.length === 2 && wide && tall && items.every(c => c.movable) ? ['pair'] : [])];
    if(!a.snapshot.overall&&options.some(k=>!choices(a)[k]))return null;
    if(a.snapshot.overall&&!h.measure)return null;
    return { items, wide, tall, options };
  }
  function view() {
    if (!active) return null;
    const a = active, all = choices(a), job = a.job;
    return { cards: a.snapshot.cards, viewport: a.snapshot.viewport, zoom: a.snapshot.camera.zoom, selected: [...a.ids],
      focusId: a.focusId, choice: a.choice, options: Object.keys(all).filter(k => all[k]), plan: all[a.choice],
      undo: undo?.key === a.key, decision: a.snapshot.decision?.mode || null,
      canPrepare: !!descriptor(a), overall:a.snapshot.overall, localMs:a.localMs, photo:a.job?.phase==='review'?a.job.photo:null, phase: job?.phase || '', packet: job?.phase === 'review' ? job.packet : null,
      suggestion: a.suggestion, message: a.message };
  }
  const emit = () => h.render?.(view());
  function open(key, preferredId = null) {
    close();
    sync();
    const s = read(key);
    if (!s || (!s.cards.length && undo?.key !== key)) return false;
    const t0=now();const defaults = s.overall?Math.min(12,s.cards.length):(s.viewport.width >= 664 && s.viewport.height >= 200) ? 2 : 1;
    const ordered = s.cards.find(c => c.id === preferredId) ? [preferredId, ...s.cards.map(c => c.id).filter(id => id !== preferredId)] : s.cards.map(c => c.id);
    if(s.overall)ordered.sort((x,y)=>Number(!!s.cards.find(c=>c.id===y)?.inFrame)-Number(!!s.cards.find(c=>c.id===x)?.inFrame));
    active = { key, snapshot: s, ids: new Set(ordered.slice(0, defaults)), focusId: ordered[0] ?? null,
      choice: 'keep', job: null, message: '' };
    if(s.overall){const plans=choices(active);active.choice=plans.tidy?'tidy':plans.workbench?'workbench':'keep';active.localMs=Math.round(now()-t0);active.message=active.choice==='keep'?'현재 자리를 유지합니다. 다른 목적이면 보기를 고르세요.':'이 책상에서 계산한 미리보기입니다. 아직 창을 옮기지 않았습니다.';}
    emit();
    return true;
  }
  function select(id, checked) {
    if (!sync() || typeof checked !== 'boolean' || !active.snapshot.cards.some(c => c.id === id) || active.ids.has(id) === checked) return;
    const a = active;
    discard(a);
    if (checked) a.ids.add(id); else a.ids.delete(id);a.plans=null;
    a.focusId = a.ids.has(a.focusId) ? a.focusId : selected(a)[0]?.id ?? null;
    a.choice = 'keep'; a.message = ''; emit();
  }
  function focus(id) {
    if (!sync() || !active.ids.has(id) || active.focusId === id) return;
    discard(active);active.plans=null; active.focusId = id; active.choice = 'keep'; active.message = ''; emit();
  }
  function choose(option) {
    if (!sync() || !Object.hasOwn(PRESENTATION_OPTIONS, option) || !choices(active)[option]) return;
    discard(active); active.choice = option; active.message = ''; emit();
  }
  function expire(a, job) {
    if (active !== a || a.job !== job) return;
    discard(a); a.message = '검토 시간이 끝났습니다. 수동으로 구성을 고를 수 있습니다.'; emit();
  }
  const live = (a, job) => active === a && a.job === job && sync();
  async function prepare(cue) {
    if (!sync() || active.job) return;
    const a = active, dto = descriptor(a), text = normalizeCue(cue);
    if (!dto || !text) { a.message = '민감한 정보 없이 목적을 한 줄로 입력하세요 (280자 이내).'; emit(); return; }
    discard(a); a.message = '';
    let { options, ...send } = dto;const job = { phase: 'prepare', request: h.request, controller: new AbortController() };
    a.job = job;
    job.timer = setTimeout(() => expire(a, job), 8000);
    emit();
    try {
      if(a.snapshot.overall){const cs=selected(a),ids=cs.map(c=>c.id),measured=await h.measure(a.key,ids,{photo:true});if(!live(a,job))return;if(!measured?.photo||measured.scene?.length!==ids.length)throw Error('photo-unavailable');const scenes=measured.scene;const ix=cs.findIndex(c=>c.id===a.focusId),f=scenes[ix];const front=f&&['inside','partial'].includes(f.frame)&&['inside','partial'].includes(f.clip)&&f.obscured&&['partial','miss'].includes(f.reach)&&canMove(cs[ix]);const feasible=choices(a);const shareablePlans=worksitePlans({...a.snapshot,cards:cs,obstacles:[]},cs,a.focusId);const extra=['tidy','handoff','workbench'].filter(k=>!!shareablePlans[k]&&!!feasible[k]);const composition=describeComposition(a.snapshot,cs,a.focusId,feasible);
        options=[...options.filter(k=>k!=='pair'||feasible.pair),...(front&&feasible.front?['front']:[]),...extra];const shot=measured.photo;send={...send,items:send.items.map((c,i)=>({...c,scene:scenes[i]})),visual:{image:shot.image,width:shot.width,height:shot.height,composition,candidates:extra,allowPair:!!feasible.pair}};
        // A local obstacle can rule out a base plan. This is not data to send about the private obstacle.
        if(options.some(k=>!feasible[k])){throw Error('impossible-option');}job.scene=JSON.stringify(scenes);job.photo=shot.image;job.original=shot.image;}
      const data = await job.request(PRESENTATION_DECISION_PATHS.prepare, { cue: text, ...send }, { signal: job.controller.signal });
      if (!live(a, job)) { cancelTicket(data?.ticket, job.request); return; }
      const p = data?.preview;
      const canonicalItems = send.items.map((c, i) => ({ slot: String.fromCharCode(65 + i), ...c }));
      job.ticket = data?.ticket;
      if (data?.status !== 'prepared' || data.mode !== a.snapshot.decision.mode || !TICKET.test(job.ticket || '') ||
          !Number.isInteger(data.expiresInMs) || data.expiresInMs < 1 || data.expiresInMs > 60000 ||
          p?.cue !== text || p.wide !== send.wide || p.tall !== send.tall || !same(p.options, options) ||
          !Array.isArray(p.items) || p.items.length !== canonicalItems.length ||
          !p.items.every((item,i)=>item&&Object.keys(item).length===Object.keys(canonicalItems[i]).length&&Object.entries(canonicalItems[i]).every(([k,v])=>same(item[k],v)))) {
        discard(a); a.message = '외부 제안을 사용할 수 없습니다. 수동으로 구성을 고르세요.'; emit(); return;
      }
      job.options = [...p.options];
      if(a.snapshot.overall){const packet=p.packet,parts=packet?.input?.[0]?.content,photo=parts?.find(x=>x.type==='input_image');const equalPhoto=job.photo===photo?.image_url||await h.equalPixels?.(job.photo,photo?.image_url);if(!live(a,job))return;if(packet?.model!==MODEL||!Array.isArray(parts)||parts.length!==3||parts[0]?.text!==text||!equalPhoto||photo?.detail!=='low'||packet.questions?.length!==1||!Array.isArray(packet.questions[0].choices)||!same(packet.questions[0].choices.map(x=>x.value),p.options.map(k=>PRESENTATION_OPTIONS[k]))){discard(a);a.message='검토 자료가 실제 요청과 일치하지 않아 전송하지 않았습니다.';emit();return;}job.photo=photo.image_url;job.packet=packet;}else job.packet=decisionReviewPacket(p);
      job.phase = 'review';
      job.expires = now() + data.expiresInMs;
      clearTimeout(job.timer);
      job.timer = setTimeout(() => expire(a, job), data.expiresInMs);
      emit();
    } catch (err) {
      if(live(a,job)){discard(a);a.message=err?.message==='photo-unavailable'?'사진에 담을 수 있는 작업창이 아닙니다. 선택을 바꾸거나 수동으로 정리하세요.':err?.message==='impossible-option'?'다른 창을 건드리지 않고 적용할 수 없는 구성이 있습니다. 수동으로 정리하세요.':'검토를 불러오지 못했습니다. 수동으로 구성을 고르세요.';emit();}
    }
  }
  async function confirm() {
    if (!sync()) return;
    const a = active, job = a.job;
    if (job?.phase !== 'review') return;
    if (now() >= job.expires) { expire(a, job); return; }
    if(a.snapshot.overall){job.phase='recheck';emit();const m=await h.measure(a.key,selected(a).map(c=>c.id),{photo:true});if(!live(a,job))return;if(!m||m.photo?.image!==job.original||JSON.stringify(m.scene)!==job.scene){discard(a);a.message='측정한 장면이 바뀌어 전송하지 않았습니다.';emit();return;}}
    job.phase = 'run'; job.packet = null;job.photo=null; emit();
    try {
      const data = await job.request(PRESENTATION_DECISION_PATHS.run, { ticket: job.ticket, confirm: true }, { signal: job.controller.signal });
      if (!live(a, job)) return;
      if (now() >= job.expires) { expire(a, job); return; }
      clearTimeout(job.timer); a.job = null;
      if (a.snapshot.decision.mode === 'on' && data?.status === 'preview' && job.options.includes(data.preview) && choices(a)[data.preview]) {
        a.choice = data.preview; a.message = '제안한 구성을 미리 보는 중입니다. 아직 적용하지 않았습니다.';
      } else if (a.snapshot.decision.mode === 'advisory' && data?.status === 'advisory-only' && job.options.includes(data.suggestion)) {
        a.suggestion = data.suggestion; a.message = '참고 제안입니다. 미리보기는 바꾸지 않았습니다.';
      } else a.message = '사용할 제안이 없습니다. 수동으로 구성을 고르세요.';
      emit();
    } catch {
      if (live(a, job)) { discard(a); a.message = '제안을 받지 못했습니다. 다시 보내지 않았습니다.'; emit(); }
    }
  }
  function cancelDecision() {
    if (!sync() || !active.job) return;
    discard(active); active.message = ''; emit();
  }
  function apply() {
    if (!sync()) return false;
    const a = active, plan = choices(a)[a.choice];
    if (!plan || a.job) return false;
    if (plan.option === 'keep') { close({ restoreFocus: true }); return true; }
    const before = { camera: plan.camera ? { x: a.snapshot.camera.x, y: a.snapshot.camera.y, zoom: a.snapshot.camera.zoom } : null,
      targets: plan.targets.map(({id,z})=>{const c=a.snapshot.cards.find(c=>c.id===id);return {id,rect:rect(c.rect),...(Number.isFinite(z)?{z:c.z}:{})};}) };
    const { camera, targets } = plan, key = a.key;
    // Dismiss first: camera/geometry host notifications cannot invalidate a committing panel.
    close({ restoreFocus: true });
    if (!same(a.snapshot, read(key)) || h.commit(key, { camera, targets }) !== true) return false;
    const after = read(key);
    undo = after ? { key, snapshot: after, before } : null;
    return true;
  }
  function undoOnce() {
    if (!sync() || !undo || active.key !== undo.key || active.job) return false;
    const record = undo;
    close({ restoreFocus: true, forgetUndo: true });
    return same(record.snapshot, read(record.key)) && h.commit(record.key, record.before) === true;
  }
  return { open, close, sync, view, select, focus, choose, prepare, confirm, cancelDecision, apply, undo: undoOnce };
}

// Firefox chrome UI: real HTML controls, modeless, with an independent, non-hit-testable world layer.
export function createJointPresentation(h) {
  const d = h.document, w = h.window;
  const ns = 'http://www.w3.org/1999/xhtml';
  let panel, layer, anchor, key, previousPhase = '', manualCue = '', listening = false;
  const make = (tag, text, attrs = {}) => {
    const n = d.createElementNS(ns, tag);
    if (text !== null) n.textContent = text;
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };
  const test = suffix => ({ 'data-testid': 'joint-presentation-' + suffix });
  const control = suffix => ({ ...test(suffix), 'data-presentation-control': suffix });
  const button = (label, suffix, fn) => {
    const n = make('button', label, { type: 'button', ...control(suffix) });
    n.addEventListener('click', ev => { ev.stopPropagation(); fn(); });
    return n;
  };
  const legend = text => make('legend', text);
  const nextFrame = (r, cls, text, zoom) => {
    const n = make('div', null, { class: cls, ...test(cls.split('--')[1]) });
    Object.assign(n.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
    n.style.setProperty('--joint-presentation-label-scale', `${1 / zoom}`);
    n.append(make('span', text));
    return n;
  };
  function onKey(ev) {
    if (ev.key !== 'Escape' || ev.defaultPrevented || ev.isComposing || ev.keyCode === 229 || ev.repeat ||
        (ev.target?.ownerDocument && ev.target.ownerDocument !== d) ||
        ['browser', 'iframe', 'webview'].includes(ev.target?.localName)) return false;
    ev.preventDefault(); ev.stopImmediatePropagation();
    api.close({ restoreFocus: true });
    return true;
  }
  function dismiss({ restoreFocus, reason }) {
    if (listening) { w.removeEventListener('keydown', onKey, true); listening = false; }
    const returnTo = anchor;
    const wasFocused = panel?.contains(d.activeElement);
    panel?.remove(); layer?.remove();
    if (returnTo?.isConnected) returnTo.setAttribute('aria-expanded', 'false');
    panel = layer = anchor = key = null;
    previousPhase = manualCue = '';
    if ((restoreFocus || (reason && wasFocused)) && returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    if (reason) h.notice?.(reason);
  }
  function position(v) {
    const safe = v.viewport, a = anchor?.getBoundingClientRect?.();
    const width = Math.min(330, Math.max(1, Math.min(w.innerWidth - 16, safe.width)));
    const baseline = a && a.left >= safe.x + width + 12 ? a.left - width - 12 : right(safe) - width;
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(8, Math.min(baseline, w.innerWidth - width - 8))}px`;
    panel.style.top = `${Math.max(8, safe.y)}px`;
    panel.style.maxHeight = `${Math.max(1, Math.min(safe.height, w.innerHeight - Math.max(8, safe.y) - 8))}px`;
  }
  function render(v) {
    const first = !panel;
    if (first) {
      const canvas = h.canvas();
      if (!canvas?.isConnected) return;
      layer = make('div', null, { class: 'egd-joint-presentation-world', 'aria-hidden': 'true', ...test('world') });
      canvas.append(layer);
      panel = make('aside', null, { id: 'egd-joint-presentation', class: 'egd-joint-presentation', role: 'dialog',
        'aria-labelledby': 'egd-joint-presentation-title', 'data-no-window-drag': 'true', ...test('tool') });
      (h.chromeRoot?.() || d.documentElement).append(panel);
      anchor?.setAttribute('aria-expanded', 'true');
      w.addEventListener('keydown', onKey, true); listening = true;
    }
    const focusKey = d.activeElement?.getAttribute('data-presentation-control');
    const activeInPanel = panel.contains(d.activeElement);
    const scroll = panel.scrollTop, listScroll = panel.querySelector('.egd-joint-presentation-cards')?.scrollTop || 0;
    position(v);if(v.overall&&Number.isFinite(v.localMs))panel.dataset.localPlanMs=String(v.localMs);
    const picked = new Set(v.selected), markers = v.cards.filter(c => picked.has(c.id));
    const number = new Map(markers.map((c, i) => [c.id, i + 1]));
    const world = [];
    if (v.plan?.framing) world.push(nextFrame(v.plan.framing, 'egd-joint-presentation-mark--frame', PRESENTATION_OPTIONS[v.choice], v.zoom));
    for (const t of v.plan?.targets || []) world.push(nextFrame(t.rect, 'egd-joint-presentation-mark--target', (v.choice==='front'?'앞으로':v.choice==='pair'?'비교 위치':'정리할 자리')+' '+number.get(t.id), v.zoom));
    for (const c of markers) world.push(nextFrame(c.rect, 'egd-joint-presentation-mark--selected', `${number.get(c.id)}${v.focusId === c.id ? ' · 초점' : ''}`, v.zoom));
    layer.replaceChildren(...world);
    const title = make('h2', v.overall?'빠른 책상 정리':'내 화면 구성', { id: 'egd-joint-presentation-title', tabindex: '-1', ...control('title') });
    const header = make('header', null);
    header.append(title, button('닫기', 'close', () => api.close({ restoreFocus: true })));
    const help = make('p', '캔버스의 점선은 미리보기입니다. 적용해도 다른 사람의 화면은 바뀌지 않습니다.');
    const cards = make('fieldset', null, { ...test('cards') });
    cards.append(legend(`대상 자료 (${markers.length}장 선택)`));
    const rows = make('div', null, { class: 'egd-joint-presentation-cards' });
    v.cards.forEach((c, i) => {
      const row = make('div', null, { class: 'egd-joint-presentation-card-row' });
      const label = make('label', null);
      const check = make('input', null, { type: 'checkbox', ...control(`card-${i}`) });
      check.checked = picked.has(c.id);
      check.addEventListener('change', () => { manualCue = ''; api.select(c.id, check.checked); });
      label.append(check, make('span', `${check.checked ? `${number.get(c.id)} · ` : ''}${c.title}${c.pinned ? ' (고정)' : ''}`));
      row.append(label);
      if (check.checked) {
        const focus = button('초점', `focus-${i}`, () => { manualCue = ''; api.focus(c.id); });
        focus.setAttribute('aria-label', `${c.title} 초점 지정`);
        focus.setAttribute('aria-pressed', String(c.id === v.focusId));
        row.append(focus);
      }
      rows.append(row);
    });
    cards.append(rows);
    const choices = make('fieldset', null, { ...test('choices') });
    choices.append(legend('로컬 미리보기'));
    for (const [option, label] of Object.entries(PRESENTATION_OPTIONS)) {
      const row = make('label', null, { class: 'egd-joint-presentation-choice' });
      const radio = make('input', null, { type: 'radio', name: 'joint-presentation-option', value: option, ...control(option) });
      radio.disabled = !v.options.includes(option); radio.checked = option === v.choice;
      radio.addEventListener('change', () => { if (radio.checked) { manualCue = ''; api.choose(option); } });
      row.append(radio, make('span', label)); choices.append(row);
    }
    if (!v.options.includes('pair')) choices.append(make('p', '비교하려면 고정되지 않은 두 장과 충분한 빈 화면이 필요합니다.'));
    const status = make('p', v.suggestion ? `${v.message} ${PRESENTATION_OPTIONS[v.suggestion]}` : v.message,
      { role: 'status', ...test('status') });
    if (!status.textContent) status.hidden = true;
    const actions = make('footer', null);
    const applyText = ({front:'이 자료만 앞으로',tidy:'내 책상 정돈 적용',handoff:'내 화면에 인계 순서 적용',workbench:'내 작업 공간에 적용', pair: '두 장을 내 화면에 배치', overview: '내 카메라에 적용', focus: '내 카메라에 적용' })[v.choice] || '변경 없이 닫기';
    const apply = button(applyText, 'apply', () => api.apply());
    apply.disabled = !!v.phase;
    actions.append(apply, button('취소', 'cancel', () => api.close({ restoreFocus: true })));
    if (v.undo) {
      const undo = button('마지막 적용 되돌리기', 'undo', () => api.undo()); undo.disabled = !!v.phase; actions.append(undo);
    }
    const children = [header, help, cards, choices, status, actions];if(v.plan?.adjacent&&v.plan.framing){const fr=v.plan.framing, map=make('div',null,{'aria-label':'옆 작업 공간의 제안',class:'egd-arrange-map'});for(const [i,t] of v.plan.targets.entries()){const m=make('span',String(i+1));Object.assign(m.style,{left:100*(t.rect.x-fr.x)/fr.width+'%',top:100*(t.rect.y-fr.y)/fr.height+'%',width:100*t.rect.width/fr.width+'%',height:100*t.rect.height/fr.height+'%'});map.append(m);}children.splice(2,0,make('p','현재 자리가 좁아 옆의 빈 작업 공간을 제안합니다. 적용하면 선택한 창과 내 시점만 이동합니다.'),map);}
    let reviewTitle;
    if (v.decision) {
      const external = make('section', null, { class: 'egd-joint-presentation-decision', ...test('decision') });
      reviewTitle = make('h3', v.phase === 'review' ? '외부 전송 내용 확인' : '외부 제안 (선택 사항)', { tabindex: '-1', ...control('decision-title') });
      external.append(reviewTitle);
      if (v.phase === 'review') {
        if(v.photo){const img=make('img',null,{src:v.photo,alt:'이번 한 번에 보낼 실제 배치 사진',...test('photo')});img.style.cssText='max-width:100%;height:auto;display:block';external.append(img,make('p','이 이미지에 보이는 자료의 글자도 OpenAI로 전달됩니다. 개인 메모를 골랐다면 저장된 메모 본문도 포함됩니다. 브라우저나 다른 사람의 화면을 찍은 사진은 아닙니다.'));}
        external.append(make('p', `수신처: OpenAI Decisions (${DESTINATION})`),
          make('p', '비용: 확인하면 API 요청을 한 번 보냅니다. 연결된 API 프로젝트의 크레딧이 차감되거나 요금이 발생할 수 있으며, 정확한 금액은 전송 전에 표시되지 않습니다.', test('cost')),
          make('p', v.decision === 'advisory' ? '참고만 표시합니다. 미리보기는 바뀌지 않습니다.' : '결과가 도착해도 로컬 미리보기만 바뀝니다.'),
          make('pre', JSON.stringify(v.packet,(k,val)=>k==='image_url'?'[위에서 확인한 동일한 PNG]':val,2), { tabindex: '0', 'aria-label': '전송할 요청과 그림 위의 실제 픽셀', ...control('packet') }),
          button('동의하고 OpenAI에 보내기', 'confirm', () => api.confirm()),
          button('전송하지 않기', 'decision-cancel', () => api.cancelDecision()));
      } else if (v.phase) {
        external.append(make('p', v.phase === 'prepare' ? '로컬에서 검토할 내용을 준비하는 중입니다.' : '제안을 기다리는 중입니다.'),
          button('요청 취소', 'decision-cancel', () => api.cancelDecision()));
      } else if (v.canPrepare) {
        const input = make('input', null, { id: 'egd-joint-presentation-cue', type: 'text', maxlength: '280', autocomplete: 'off',
          spellcheck: 'false', ...control('cue') });
        input.value = manualCue||(v.overall?'지금 하던 일을 이어가기 쉽게 책상 전체를 정돈해줘':'');
        input.addEventListener('input', () => { manualCue = input.value; });
        external.append(make('label', '목적 (민감한 정보 제외)', { for: input.id }), input,
          make('p', v.overall?'선택 자료의 현재 배치 사진·읽기 크기·여백·관계와 입력 상태를 로컬에서 준비합니다. 사진을 확인하고 보낼 때만 외부에 전달합니다.':'허용된 자료 유형과 직접 입력한 목적만 검토합니다. 아직 외부로 보내지 않습니다.'),
          button(v.overall?'배치 사진으로 추천받기…':'보낼 내용 검토…', 'prepare', () => { const cue = input.value; manualCue = ''; api.prepare(cue); }));
      } else external.append(make('p', '현재 선택은 외부 제안에 사용할 수 없습니다. 위에서 수동으로 구성하세요.'));
      children.push(external);
    }
    panel.replaceChildren(...children);
    panel.scrollTop = scroll; rows.scrollTop = listScroll;
    if (first) title.focus({ preventScroll: true });
    else if (v.phase === 'review' && previousPhase !== 'review') reviewTitle?.focus();
    else if (activeInPanel) {
      const next = [...panel.querySelectorAll('[data-presentation-control]')].find(n => n.getAttribute('data-presentation-control') === focusKey && !n.disabled);
      (next || (previousPhase !== v.phase ? reviewTitle : title) || title).focus({ preventScroll: true });
    }
    previousPhase = v.phase;
  }
  async function equalPixels(a,b){const dec=async url=>{if(typeof url!=='string'||url.length>2300000||!url.startsWith('data:image/png;base64,'))return null;const bin=w.atob(url.split(',')[1]),bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);const bmp=await w.createImageBitmap(new w.Blob([bytes],{type:'image/png'}));try{if(bmp.width>768||bmp.height>512)return null;const c=d.createElementNS(ns,'canvas');c.width=bmp.width;c.height=bmp.height;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(bmp,0,0);const pixels=ctx.getImageData(0,0,c.width,c.height).data;c.width=c.height=0;return {width:bmp.width,height:bmp.height,pixels};}finally{bmp.close();}};try{const [x,y]=await Promise.all([dec(a),dec(b)]);return !!x&&!!y&&x.width===y.width&&x.height===y.height&&x.pixels.every((v,i)=>v===y.pixels[i]);}catch{return false;}}
  const api = createPresentationController({ ...h, render, dismiss,equalPixels });
  return {
    open(boardKey, trigger = null, preferredId = null) {
      api.close();
      if (!h.canvas()?.isConnected) return false;
      key = boardKey; anchor = trigger;
      if (api.open(boardKey, preferredId)) return true;
      key = anchor = null;
      return false;
    },
    sync() { return api.sync(); },
    close(options) { api.close(options); },
    isOpen(boardKey) { return panel?.isConnected === true && (boardKey === undefined || key === boardKey); },
    handleEscape(ev) { return !!panel && onKey(ev); },
  };
}
