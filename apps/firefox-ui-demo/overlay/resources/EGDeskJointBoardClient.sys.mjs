import {teamAppTypes,isAppState,isAppRef} from './EGDeskJointMiniappSchema.sys.mjs';
// Remote authority is never consulted for ordinary local Boards. No cookies, Agent token or automatic retries.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const acct = /^[a-z][a-z0-9._-]{0,39}$/;
const bad = () => {
  throw Error('invalid-response');
};
const ident = (v) => (typeof v === 'string' && uuid.test(v) ? v : bad());
const user = (v) => (typeof v === 'string' && acct.test(v) ? v : bad());
const str = (v, max) => (typeof v === 'string' && v.length && v.length <= max ? v : bad());
const list = (v, max = 500) => (Array.isArray(v) && v.length <= max ? v : bad());
export function serviceOrigin(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw Error('invalid-address');
  }
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== '/' ||
    !(
      u.protocol === 'https:' ||
      (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
    )
  )
    throw Error('invalid-address');
  return u.origin;
}
function checkedCard(raw, scope) {
  const c = {
    id: ident(raw.id),
    access: ident(raw.access),
    author: user(raw.author),
    title: str(raw.title, 120),
    body: str(raw.body, 4000),
    kind: ['note', 'task', 'excerpt'].includes(raw.kind) ? raw.kind : bad(),
    version: Number.isSafeInteger(raw.version) && raw.version > 0 ? raw.version : bad(),
    scope,
    own: raw.own === true,
    claimed: raw.claimed === true,
    replied: raw.replied === true,
  };
  if (scope === 'board')
    c.layoutVersion = Number.isSafeInteger(raw.layoutVersion) && raw.layoutVersion >= 0 ? raw.layoutVersion : bad();
  if (
    scope === 'board' &&
    raw.position &&
    [raw.position.x, raw.position.y].every((v) => Number.isSafeInteger(v) && Math.abs(v) <= 20000)
  )
    c.position = { x: raw.position.x, y: raw.position.y };
  if(scope==='board'&&raw.layoutPhotoGrant)c.layoutPhotoGrant=ident(raw.layoutPhotoGrant);
  if(raw.app){const a=raw.app;if(!teamAppTypes.includes(a.type)||!isAppState(a.type,a.state)||!isAppRef(a.ref)||!Number.isSafeInteger(a.rev)||a.rev<1)bad();c.app={type:a.type,state:a.state,ref:a.ref,rev:a.rev,available:a.available===true,mayEdit:a.mayEdit===true&&scope==='board',...(a.editStamp&&scope==='board'?{editStamp:ident(a.editStamp)}:{})};}
  if (c.own) {
    c.grants = list(raw.grants).map((g) => ({
      id: ident(g.id),
      person: user(g.person),
      scope: g.scope === 'single' ? 'single' : 'board',photo:g.photo===true,...(c.app?{appEdit:g.appEdit===true}:{}),
    }));
    c.replies = list(raw.replies, 5000).map((r) => ({
      id: ident(r.id),
      src: user(r.src),
      body: str(r.body, 2000),
      at: Number(r.at),
      rev: Number(r.rev),
    }));
  }
  return c;
}
export function checkedView(v) {
  if (v?.version !== 1) bad();
  const inv = (i, sent) => ({
    id: ident(i.id),
    kind: ['form', 'join', 'single'].includes(i.kind) ? i.kind : bad(),
    title: str(i.title, 120),
    [sent ? 'to' : 'from']: user(i[sent ? 'to' : 'from']),
    ...(sent ? {} : { expires: Number(i.expires) }),
  });
  return {
    version: 1,
    instance: ident(v.instance),
    self: { id: user(v.self.id), name: str(v.self.name, 60) },appCatalog:list(v.appCatalog??[],2).filter(t=>teamAppTypes.includes(t)),
    boards: list(v.boards).map((b) => {const cards=list(b.cards,120).map(c=>checkedCard(c,'board'));const members=new Set(cards.map(c=>c.id));const links=list(b.links??[],120).map(r=>{if(!members.has(r.child)||!members.has(r.parent)||r.child===r.parent||!['waits','refers'].includes(r.kind))bad();return {child:ident(r.child),parent:ident(r.parent),kind:r.kind,stamp:ident(r.stamp)};});return ({
      id: ident(b.id),
      title: str(b.title, 100),
      epoch: ident(b.epoch),
      role: b.role === 'founder' ? 'founder' : 'member',
      cards,links,
      people: list(b.people).map((p) => ({
        person: user(p.person),
        role: p.role === 'founder' ? 'founder' : 'member',
      })),
    });}),
    singles: list(v.singles).map((c) => checkedCard(c, 'single')),
    invites: list(v.invites).map((i) => inv(i, false)),
    sent: list(v.sent).map((i) => inv(i, true)),
  };
}
export const localBoardId = (instance, board) => 'joint-' + ident(instance) + '-' + ident(board);
export function jointSnapshot(instance, b, poses = {}) {
  let i = 0;
  const cards = b.cards.map((c) => {
    const n = i++,
      saved = poses[c.access + ':' + c.id],
      p = saved || c.position || { x: 36 + (n % 2) * 365, y: 49 + Math.floor(n / 2) * 249 };
    return {
      id: c.id,
      type: 'joint-item',
      geometry: {
        x: p.x,
        y: p.y,
        width: saved?.width || 342,
        height: saved?.height || 228,
        zIndex: saved?.zIndex || n + 1,
      },
      runtimeState: {
        item: c.id,
        access: c.access,
        published: c.position ? c.position.x + '/' + c.position.y : null,
        localPose: !!saved,
      },
    };
  });
  return {
    version: 1,
    agenda: {
      id: localBoardId(instance, b.id),
      title: b.title,
      memberCardIds: cards.map((c) => c.id),
      contextBindings: [],
    },
    cards,
    shapes: [],
  };
}
export function scrubJointSession(s, managedIds) {
  const projectionState = s.boardProjections || {};
  const ids = new Set(managedIds || []);
  const jointIds = new Set();
  const isJoint = (k) =>
    jointIds.has(k) || (typeof k === 'string' && /^joint-[0-9a-f-]{36}-[0-9a-f-]{36}$/.test(k));
  for (const [k, p] of Object.entries(projectionState.projections || {})) {
    if (!p.jointAccess && !isJoint(p.boardId)) continue;
    jointIds.add(p.boardId);
    ids.add(k);
    for (const m of p.members || []) ids.add(m.viewId);
    delete projectionState.projections[k];
    if (projectionState.activeProjectionId === k) projectionState.activeProjectionId = null;
  }
  const previous = projectionState.projections?.[projectionState.activeProjectionId];
  const neutral = previous?.boardId || 'agenda-default';
  if (isJoint(s.agenda?.id)) {
    s.agenda.id = neutral;
    s.agenda.title = previous?.title || 'Desk';
  }
  if (isJoint(s.desk?.activeAgendaId)) s.desk.activeAgendaId = neutral;
  if (ids.has(s.desk?.activeCardId)) s.desk.activeCardId = null;
  if (s.agenda) s.agenda.memberCardIds = (s.agenda.memberCardIds || []).filter((k) => !ids.has(k));
  if (s.desk) s.desk.collapsedViewIds = (s.desk.collapsedViewIds || []).filter((k) => !ids.has(k));
  s.cards = (s.cards || []).filter((c) => !ids.has(c.id) && c.type !== 'joint-item');
  return s;
}
export function createJointClient({ request, apply, unavailable, uuid: random, timeoutSignal }) {
  let gen = 0,
    session = null,
    chain = Promise.resolve(),
    known = '',
    verified = null;
  const reset = () => {
    gen++;
    session = null;
    known = '';
    verified = null;
    apply(null);
  };
  function run(method, body) {
    if (!session) return Promise.reject(Error('disconnected'));
    const g = gen,
      scope = session;
    const work = async () => {
      if (g !== gen) throw Error('disconnected');
      let res;
      try {
        res = await request(scope.origin + '/v1/joint/' + (method === 'GET' ? 'view' : 'action'), {
          method,
          headers: {
            Authorization: 'Bearer ' + scope.key,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: timeoutSignal(),
        });
      } catch {
        if (g === gen) {
          verified = null;
          known = '';
          apply(null);
          unavailable('unconfirmed');
        }
        throw Error('unconfirmed');
      }
      if (g !== gen) throw Error('disconnected');
      if (!res.ok) {
        const code = await res
          .json()
          .then((r) => String(r.error))
          .catch(() => 'unconfirmed');
        if (g !== gen) throw Error('disconnected');
        if (res.status === 401) {
          reset();
          unavailable('authentication');
        } else if (res.status >= 500 || res.status === 404 || res.status === 403 || res.status === 409) {
          verified = null;
          known = '';
          apply(null);
          unavailable(code);
        }
        throw Error(code);
      }
      let v;
      try {
        v = checkedView(await res.json());
        if (scope.binding && scope.binding !== v.instance + '/' + v.self.id) bad();
      } catch {
        if (g === gen) {
          reset();
          unavailable('invalid-response');
        }
        throw Error('invalid-response');
      }
      if (g !== gen) throw Error('disconnected');
      scope.binding = v.instance + '/' + v.self.id;
      verified = v;
      const sig = JSON.stringify(v);
      if (sig !== known) {
        try {
          apply(v);
          known = sig;
        } catch {
          known = '';
          verified = null;
          apply(null);
          unavailable('unconfirmed');
          throw Error('unconfirmed');
        }
      }
      return v;
    };
    const p = chain.then(work, work);
    chain = p.catch(() => {});
    return p;
  }
  return {
    get view() {
      return verified;
    },
    get connected() {
      return !!session;
    },
    connect(origin, key) {
      origin = serviceOrigin(origin);
      if (typeof key !== 'string' || !/^jb1\.[A-Za-z0-9_-]{43}$/.test(key.trim())) throw Error('invalid-key');
      reset();
      session = { origin, key: key.trim() };
      return run('GET');
    },
    refresh: () => run('GET'),
    // Optional ephemeral signal (EGDeskJointPresence). It is not a Board action: no request id, no view is applied, no
    // retry, and a failure never closes or resets the shared Board. Only sent while a verified view of this session exists.
    async presence(body) {
      if (!session || !verified) throw Error('disconnected');
      const g = gen,
        scope = session;
      let res;
      try {
        res = await request(scope.origin + '/v1/joint/presence', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + scope.key, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: timeoutSignal(),
        });
      } catch {
        throw Error('presence-unavailable');
      }
      if (g !== gen) throw Error('disconnected');
      if (!res.ok) throw Error('presence-unavailable');
      const value = await res.json().catch(() => null);
      if (g !== gen) throw Error('disconnected');
      return value;
    },
    act(input) {
      if (!verified) return Promise.reject(Error('disconnected'));
      return run('POST', { ...input, request: random() });
    },
    disconnect: reset,
  };
}
