// Multi-user presence for the placement runtime, on top of the joint Board's ephemeral presence feed.
//   presence.snapshot() -> [{ member, self, active, viewport: { x, y, width, height } | null, focusCard, lastInputAgeMs }]
// The first row is this person (taken from the single-user provider, never from the network). The other rows are the
// members of the joint Boards open on this Desk who chose to share; their rectangles are converted from the Board's shared
// card-position space into this Desk's canvas coordinates with this person's own Board offset.
// This module only reads: it has no way to write the shared ledger, a card position, or any personal layout or camera.
// Nothing is kept beyond memory, and a row that is not refreshed turns inactive (staleMs) and then disappears (expireMs).
// activeInputMs: the single-user provider's bound (active within 5 minutes of input), so every row of a snapshot means the same by "active".
export const PRESENCE = Object.freeze({ publishMs: 3000, staleMs: 10_000, expireMs: 30_000, activeInputMs: 300_000, maxMembers: 64 });
/** Chrome pref for the whole feature. Default OFF: unless it is exactly "on" nothing of presence is installed in the window. */
export const PRESENCE_PREF = 'egdesk.presence';
export const presenceEnabled = (value) => value === 'on';
/** This person's own, private store of the per-Board sharing choice (a chrome pref of this profile; never the shared ledger). */
export const PRESENCE_SHARE_PREF = 'egdesk.jointBoard.presenceShare.v1';
export const SHARE_LEVELS = Object.freeze(['off', 'active', 'region']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const alias = /^m-[0-9a-f]{16}$/;
const tagShape = /^[0-9a-f]{64}$/;
/** Requester identity: how long this Desk keeps announcing a request it made, how long it keeps asking about one it received, and how long a run keeps its requester. */
export const REQUESTER = Object.freeze({ claimMs: 15 * 60_000, watchMs: 15 * 60_000, runMs: 30 * 60_000, maxTags: 4, maxRuns: 32 });
/**
 * The opaque tag of one review request: a hash of its id and digest, which only the holders of that request file know.
 * It says nothing about the question. sha256Hex(text) -> Promise<hex> is supplied by the host (WebCrypto in the window).
 */
export async function requestTag(review, sha256Hex) {
  if (!review || review.kind !== 'request' || typeof review.requestId !== 'string' || !uuid.test(review.requestId) || typeof review.requestDigest !== 'string' || !tagShape.test(review.requestDigest)) return null;
  const hex = await sha256Hex(JSON.stringify(['egdesk-ask-requester-v1', review.requestId, review.requestDigest]));
  return typeof hex === 'string' && tagShape.test(hex) ? hex : null;
}
const bad = () => {
  throw Error('invalid-presence');
};
const rect = (v) =>
  v && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(v[k])) && v.width > 0 && v.height > 0
    ? { x: v.x, y: v.y, width: v.width, height: v.height }
    : null;
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : bad());
const only = (v, keys) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((k) => keys.includes(k)) ? v : bad();

/** Whitelist rebuild of a presence answer. Anything else (a name, text, a URL, a pointer) makes the whole answer invalid. */
export function checkedPresence(raw, board) {
  only(raw, ['version', 'board', 'self', 'share', 'staleMs', 'expireMs', 'members', 'resolved']);
  const resolved = [];
  if (raw.resolved !== undefined) {
    if (!Array.isArray(raw.resolved) || raw.resolved.length > REQUESTER.maxTags) bad();
    for (const row of raw.resolved) {
      only(row, ['tag', 'member']);
      if (typeof row.tag !== 'string' || !tagShape.test(row.tag) || typeof row.member !== 'string' || !alias.test(row.member) || row.member === raw.self) bad();
      resolved.push({ tag: row.tag, member: row.member });
    }
  }
  if (raw.version !== 1 || raw.board !== board || !alias.test(raw.self) || !Array.isArray(raw.members) || raw.members.length > PRESENCE.maxMembers) bad();
  const seen = new Set([raw.self]);
  return {
    self: raw.self,
    resolved,
    members: raw.members.map((m) => {
      only(m, ['member', 'active', 'inputAgeMs', 'ageMs', 'viewport', 'focusCard']);
      if (typeof m.member !== 'string' || !alias.test(m.member) || seen.has(m.member) || typeof m.active !== 'boolean') bad();
      seen.add(m.member);
      if (m.viewport !== null) only(m.viewport, ['x', 'y', 'width', 'height']);
      if (m.viewport !== null && !rect(m.viewport)) bad();
      if (m.focusCard !== null && !(typeof m.focusCard === 'string' && uuid.test(m.focusCard))) bad();
      return { member: m.member, active: m.active, inputAgeMs: count(m.inputAgeMs), ageMs: count(m.ageMs), viewport: rect(m.viewport), focusCard: m.focusCard };
    }),
  };
}
/**
 * The joint Board projections of this Desk as presence inputs. Read-only: it looks at where this person put each Board
 * (offset), the cards mounted there (region) and their view ids (a card's local alias); it never changes any of them.
 *   projections() -> [{ boardId, jointAccess, offset, members: [{ sourceId, viewId }], idMap }]
 *   boardOf(projection) -> { id, epoch } | null     node(viewId) -> element | null     geometry(element) -> rect
 */
export function projectionPresence({ projections, boardOf, node, geometry }) {
  const live = () =>
    (projections() || [])
      .map((p) => ({ p, b: boardOf(p) }))
      .filter(({ p, b }) => b && typeof b.id === 'string' && uuid.test(b.id) && b.epoch === p.jointAccess && Number.isFinite(p.offset?.x) && Number.isFinite(p.offset?.y));
  return {
    boards: () =>
      live().map(({ p, b }) => {
        let region = null;
        for (const m of p.members || []) {
          const el = node(m.viewId);
          const g = el && el.isConnected !== false ? rect(geometry(el)) : null;
          if (!g) continue;
          if (!region) region = g;
          else {
            const right = Math.max(region.x + region.width, g.x + g.width),
              bottom = Math.max(region.y + region.height, g.y + g.height);
            region = { x: Math.min(region.x, g.x), y: Math.min(region.y, g.y), width: 0, height: 0 };
            region.width = right - region.x;
            region.height = bottom - region.y;
          }
        }
        return { id: b.id, offset: { x: p.offset.x, y: p.offset.y }, region };
      }),
    cardAlias: (board, card) => {
      const map = live().find(({ b }) => b.id === board)?.p.idMap;
      return map && Object.hasOwn(map, card) && typeof map[card] === 'string' ? map[card] : null;
    },
    cardId: (alias) => {
      for (const { p, b } of live()) {
        const m = (p.members || []).find((x) => x.viewId === alias);
        if (m) return { board: b.id, card: m.sourceId };
      }
      return null;
    },
  };
}
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * createJointPresence({ send, self, boards, cardAlias?, cardId?, now?, initialShare?, onShareChange? })
 *   send(body) -> Promise<answer>            the joint client's presence call
 *   self() -> { active, viewport, focusCard, lastInputAgeMs } | null   this person's row from the single-user provider
 *   boards() -> [{ id, offset: { x, y }, region: rect | null }]        joint Boards open on this Desk (id = the shared Board id;
 *                                                                      offset/region = where this person put it, canvas coordinates)
 *   cardAlias(boardId, cardId) -> local alias | null   and   cardId(localAlias) -> { board, card } | null
 * Sharing is per Board and starts 'off' (nothing leaves). 'active' sends only "here + input age"; 'region' adds the view
 * rectangle (only while it overlaps that Board's region on this Desk) and the focused card of that Board.
 */
export function createJointPresence({ send, self, boards, cardAlias = () => null, cardId = () => null, now = Date.now, initialShare = null, onShareChange = null }) {
  const share = new Map(
    Object.entries(initialShare && typeof initialShare === 'object' ? initialShare : {}).filter(([k, v]) => uuid.test(k) && SHARE_LEVELS.includes(v)),
  );
  const feeds = new Map(); // board id -> { at, members, self }
  const claimed = new Map(); // tag -> until (requests this person made and announces on the Boards they share presence on)
  const watched = new Map(); // tag -> until (requests this person received and asks the service about)
  const answered = new Map(); // tag -> { board, alias, at } (who the service vouches for)
  const fresh = (map) => {
    const time = now();
    for (const [tag, until] of map) if (until <= time) map.delete(tag);
    return [...map.keys()].slice(0, REQUESTER.maxTags);
  };
  const sentAt = new Map();
  const pending = new Set();
  let flight = Promise.resolve();
  const level = (board) => share.get(board) || 'off';
  const open = () => {
    try {
      return (boards() || []).filter((b) => b && typeof b.id === 'string' && uuid.test(b.id) && Number.isFinite(b.offset?.x) && Number.isFinite(b.offset?.y));
    } catch {
      return [];
    }
  };
  const mine = () => {
    try {
      const row = self();
      return row && rect(row.viewport) && Number.isFinite(row.lastInputAgeMs) ? row : null;
    } catch {
      return null;
    }
  };
  function outgoing(board, me) {
    const mode = level(board.id);
    const asking = fresh(watched), mine = fresh(claimed);
    if (mode === 'off') return { board: board.id, share: 'off', ...(asking.length ? { resolve: asking } : {}) };
    const body = { board: board.id, share: mode, inputAgeMs: Math.max(0, Math.round(me.lastInputAgeMs)), ...(mine.length ? { claim: mine } : {}), ...(asking.length ? { resolve: asking } : {}) };
    if (mode !== 'region') return body;
    const view = rect(me.viewport),
      region = rect(board.region);
    // Only while this person is looking at this Board: the rest of the Desk is not this Board's business.
    body.viewport = region && overlaps(view, region) ? { x: view.x - board.offset.x, y: view.y - board.offset.y, width: view.width, height: view.height } : null;
    let focus = null;
    try {
      focus = me.focusCard == null ? null : cardId(me.focusCard);
    } catch {
      focus = null;
    }
    body.focusCard = body.viewport && focus?.board === board.id && typeof focus.card === 'string' && uuid.test(focus.card) ? focus.card : null;
    return body;
  }
  /** One exchange per open joint Board, at most every publishMs. Failures are silent: the rows simply age out. */
  function tick() {
    const run = exchangeAll();
    flight = Promise.allSettled([flight, run]);
    return run;
  }
  async function exchangeAll() {
    const me = mine();
    if (!me) return 0;
    const live = open();
    for (const id of [...feeds.keys()]) if (!live.some((b) => b.id === id)) feeds.delete(id);
    let done = 0;
    await Promise.all(
      live.map(async (board) => {
        const time = now();
        if (pending.has(board.id) || (sentAt.has(board.id) && time - sentAt.get(board.id) < PRESENCE.publishMs)) return;
        pending.add(board.id);
        sentAt.set(board.id, time);
        try {
          const answer = checkedPresence(await send(outgoing(board, me)), board.id);
          feeds.set(board.id, { at: now(), members: answer.members, self: answer.self });
          for (const row of answer.resolved) if (watched.has(row.tag)) answered.set(row.tag, { board: board.id, alias: row.member, at: now() });
          done++;
        } catch {
          /* optional signal: keep working without it */
        } finally {
          pending.delete(board.id);
        }
      }),
    );
    return done;
  }
  function snapshot() {
    const me = mine();
    if (!me) return [];
    const time = now();
    const rows = [
      // the own alias is whatever the single-user provider calls this person; remote aliases are always 'm-…'
      { member: typeof me.member === 'string' && me.member && !alias.test(me.member) ? me.member : 'self', self: true, active: me.active === true, viewport: rect(me.viewport), focusCard: me.focusCard ?? null, lastInputAgeMs: Math.max(0, me.lastInputAgeMs) },
    ];
    for (const board of open()) {
      const feed = feeds.get(board.id);
      if (!feed) continue;
      const waited = Math.max(0, time - feed.at);
      for (const m of feed.members) {
        const age = m.ageMs + waited,
          inputAge = m.inputAgeMs + waited;
        if (age > PRESENCE.expireMs) continue;
        let card = null;
        try {
          card = m.focusCard ? (cardAlias(board.id, m.focusCard) ?? null) : null;
        } catch {
          card = null;
        }
        rows.push({
          member: m.member,
          self: false,
          active: m.active && age <= PRESENCE.staleMs && inputAge <= PRESENCE.activeInputMs,
          viewport: m.viewport ? { x: m.viewport.x + board.offset.x, y: m.viewport.y + board.offset.y, width: m.viewport.width, height: m.viewport.height } : null,
          focusCard: card,
          lastInputAgeMs: inputAge,
        });
      }
    }
    return rows;
  }
  return {
    snapshot,
    tick,
    share: level,
    setShare(board, value) {
      if (typeof board !== 'string' || !uuid.test(board) || !SHARE_LEVELS.includes(value)) return false;
      if (value === 'off') share.delete(board);
      else share.set(board, value);
      try {
        onShareChange?.(Object.fromEntries(share));
      } catch {
        /* a failed save never changes what is shared */
      }
      // Tell the service now rather than at the next cadence: turning sharing off withdraws the record there at once.
      sentAt.delete(board);
      void tick().catch(() => {});
      return true;
    },
    /** Resolves when no exchange is in flight (for a host that wants to act after a setting reached the service). */
    idle() {
      return flight.then(() => undefined);
    },
    /** This person's own alias on a Board, as the other members see it (null until an answer arrived). Theirs to hand out, e.g. with a request they make. */
    aliasOn(board) {
      return feeds.get(board)?.self ?? null;
    },
    /** Is this alias a member the service currently lists on that Board (a fresh answer names it)? The seat check is the service's. */
    seated(board, member) {
      const feed = feeds.get(board);
      return !!feed && now() - feed.at <= PRESENCE.staleMs && feed.members.some((m) => m.member === member);
    },
    /** Announce a request this person made (its opaque tag) on every Board they share presence on, for claimMs. Nothing is sent where sharing is off. */
    claimRequest(tag) {
      if (typeof tag !== 'string' || !tagShape.test(tag)) return false;
      if (claimed.size >= REQUESTER.maxTags && !claimed.has(tag)) claimed.delete(claimed.keys().next().value);
      claimed.set(tag, now() + REQUESTER.claimMs);
      return true;
    },
    /** Ask the service, at every exchange for watchMs, who claimed a request this person received. */
    watchRequest(tag) {
      if (typeof tag !== 'string' || !tagShape.test(tag)) return false;
      if (watched.size >= REQUESTER.maxTags && !watched.has(tag)) { const oldest = watched.keys().next().value; watched.delete(oldest); answered.delete(oldest); }
      watched.set(tag, now() + REQUESTER.watchMs);
      return true;
    },
    /** { board, alias } the service vouched for, while that member is still listed on that Board; else null. */
    requesterOf(tag) {
      const hit = answered.get(tag);
      if (!hit || !watched.has(tag)) return null;
      const feed = feeds.get(hit.board);
      if (!feed || now() - feed.at > PRESENCE.staleMs || !feed.members.some((m) => m.member === hit.alias)) return null;
      return { board: hit.board, alias: hit.alias };
    },
    /** Replace every Board's sharing level at once (a saved choice read after connecting). Does not report back to the host. */
    loadShare(map) {
      share.clear();
      for (const [k, v] of Object.entries(map && typeof map === 'object' ? map : {})) if (uuid.test(k) && SHARE_LEVELS.includes(v) && v !== 'off') share.set(k, v);
      sentAt.clear();
    },
    reset() {
      feeds.clear();
      sentAt.clear();
      claimed.clear();
      watched.clear();
      answered.clear();
    },
  };
}

/**
 * The per-Board sharing choice, kept in this person's own private settings.
 *   read() -> stored object | null     write(object)     (the host backs these with a pref of this profile)
 * Stored: { [scope]: { [boardId]: { level: 'active' | 'region', epoch } } } where scope = service instance + this account and
 * epoch = the seat the choice was made on. Default is off: only a deliberate non-off choice is ever stored. A choice made on an
 * earlier seat (the person left and joined again) or on a Board they are no longer on is dropped, not carried over.
 */
export function createShareStore({ read = null, write = null } = {}) {
  // Without a host store the choices live in this object only (and so reset to off with the window).
  let memory = {};
  if (typeof read !== 'function' || typeof write !== 'function') {
    read = () => memory;
    write = (value) => {
      memory = value;
    };
  }
  const all = () => {
    let raw = null;
    try {
      raw = read();
    } catch {
      raw = null;
    }
    return raw && typeof raw === 'object' && !Array.isArray(raw) && raw.unreadable !== true ? raw : {};
  };
  const put = (value) => {
    try {
      write(value);
      return true;
    } catch {
      return false;
    }
  };
  return {
    /** seats: [{ id, epoch }] of the Boards this person is on now -> { [boardId]: level } */
    load(scope, seats) {
      const mine = all()[scope];
      const out = {};
      if (!mine || typeof mine !== 'object' || Array.isArray(mine)) return out;
      for (const seat of Array.isArray(seats) ? seats : []) {
        const row = Object.hasOwn(mine, seat?.id) ? mine[seat.id] : null;
        if (row && typeof row === 'object' && row.epoch === seat.epoch && SHARE_LEVELS.includes(row.level) && row.level !== 'off' && uuid.test(seat.id)) out[seat.id] = row.level;
      }
      return out;
    },
    /** load(), and remove from the store whatever of this scope no longer applies (a Board left, an older seat). Writes only when something is removed. */
    prune(scope, seats) {
      const levels = this.load(scope, seats);
      const mine = all()[scope];
      const stored = mine && typeof mine === 'object' && !Array.isArray(mine) ? Object.keys(mine).length : mine === undefined ? 0 : -1;
      if (stored !== Object.keys(levels).length) this.save(scope, levels, seats);
      return levels;
    },
    /** levels: { [boardId]: level } as the presence module reports them; seats as above. Writes only this scope. */
    save(scope, levels, seats) {
      if (typeof scope !== 'string' || !scope) return false;
      const next = { ...all() };
      const mine = {};
      for (const seat of Array.isArray(seats) ? seats : []) {
        const level = levels && Object.hasOwn(levels, seat?.id) ? levels[seat.id] : 'off';
        if (uuid.test(seat?.id) && typeof seat.epoch === 'string' && SHARE_LEVELS.includes(level) && level !== 'off') mine[seat.id] = { level, epoch: seat.epoch };
      }
      if (Object.keys(mine).length) next[scope] = mine;
      else delete next[scope];
      return put(next);
    },
    /** Signing out of the service on this Desk forgets the choices made for it. */
    forget(scope) {
      const next = { ...all() };
      if (!Object.hasOwn(next, scope)) return true;
      delete next[scope];
      return put(next);
    },
  };
}

/**
 * ONE presence.snapshot() for this Desk and every consumer (the placement runtime in the window, the heartbeat's audience rule
 * through the bridge mirror): the joint provider's rows when it has any (own row first, then the members who share), else the
 * single-user provider's rows. The own row is always the single-user provider's.
 *   single: { snapshot() }            joint: () => ({ snapshot() } | null)
 */
export function createDeskPresence({ single, joint = () => null }) {
  return Object.freeze({
    snapshot() {
      let rows = null;
      try {
        rows = joint()?.snapshot() ?? null;
      } catch {
        rows = null;
      }
      if (Array.isArray(rows) && rows.length && rows[0]?.self === true) return rows;
      try {
        return single.snapshot();
      } catch {
        return [];
      }
    },
  });
}

/**
 * Whose task a live run is, for the two consumers of presence on this Desk. Memory only.
 *   snapshot() -> presence rows of this Desk      seated(board, alias) -> the service lists that alias on that Board right now
 *   post(body) -> tells the bridge (the heartbeat's audience rule): { clientThreadId, conversationId, requester: { board, alias } | null }
 * A requester is taken only when the service vouches for the alias on that Board (seated); it is dropped after runMs, when cleared,
 * and it is handed to the placement runtime only while the alias is in the live snapshot.
 */
export function createRunRequesters({ snapshot, seated, post = async () => null, now = Date.now }) {
  const runs = new Map(); // conversation key -> { board, alias, until }
  const keysOf = (ref) => [ref?.conversationId, ref?.clientThreadId].filter((k) => typeof k === 'string' && k && k.length <= 256);
  const find = (ref) => {
    for (const key of keysOf(ref)) {
      const hit = runs.get(key);
      if (hit && hit.until > now()) return hit;
      if (hit) runs.delete(key);
    }
    return null;
  };
  const tell = (ref, requester) => {
    try {
      void Promise.resolve(post({ clientThreadId: typeof ref?.clientThreadId === 'string' ? ref.clientThreadId : null, conversationId: typeof ref?.conversationId === 'string' ? ref.conversationId : null, requester })).catch(() => {});
    } catch {
      /* the window keeps its own record either way */
    }
  };
  const api = {
    /** set(ref, { board, alias }) for the run that starts in that conversation; set(ref, null) when it ends. Returns whether it was taken. */
    set(ref, requester) {
      const keys = keysOf(ref);
      if (!keys.length) return false;
      if (requester === null) {
        for (const key of keys) runs.delete(key);
        tell(ref, null);
        return true;
      }
      let ok = false;
      try {
        ok = typeof requester?.board === 'string' && uuid.test(requester.board) && typeof requester.alias === 'string' && alias.test(requester.alias) && seated(requester.board, requester.alias) === true;
      } catch {
        ok = false;
      }
      if (!ok) return false;
      while (runs.size >= REQUESTER.maxRuns) runs.delete(runs.keys().next().value);
      const entry = { board: requester.board, alias: requester.alias, until: now() + REQUESTER.runMs };
      for (const key of keys) runs.set(key, entry);
      tell(ref, { board: entry.board, alias: entry.alias });
      return true;
    },
    /** The requester alias for a work surface of that run, only while that member is in the live snapshot; else null (the local person, as before). */
    for(ref) {
      const hit = find(ref);
      if (!hit) return null;
      let rows = [];
      try {
        rows = snapshot() || [];
      } catch {
        rows = [];
      }
      return rows.some((row) => row && row.self !== true && row.member === hit.alias) ? hit.alias : null;
    },
    /** The placement hook with the requester filled in. The wrapped function and its callers are untouched. */
    wrap(note) {
      if (typeof note !== 'function') return note;
      return (kind, placement, work) => {
        let who = null;
        try {
          who = work && !work.requester ? api.for(work) : null;
        } catch {
          who = null;
        }
        return note(kind, placement, who ? { ...work, requester: who } : work);
      };
    },
    size: () => runs.size,
  };
  return api;
}

/**
 * A review request and its requester, on both Desks. joint() -> the joint presence API ({ claimRequest, watchRequest, requesterOf }) or null.
 *   exported(review)   this person wrote the request file: announce its tag on the Boards they share presence on
 *   inspected(review)  this person opened a received request: ask the service who claimed it
 *   of(review)         -> { board, alias } the service vouched for (still listed on that Board), else null
 * Only the tag (a hash) ever reaches the service; the request's text never does.
 */
export function createRequestRequesters({ joint, sha256Hex }) {
  const tags = new Map(); // requestId/requestDigest -> tag
  const keyOf = (review) => (review && typeof review.requestId === 'string' && typeof review.requestDigest === 'string' ? review.requestId + '/' + review.requestDigest : null);
  const withTag = async (review, act) => {
    const key = keyOf(review);
    if (!key) return false;
    let tag = tags.get(key);
    if (!tag) {
      tag = await requestTag(review, sha256Hex);
      if (!tag) return false;
      tags.set(key, tag);
      while (tags.size > 16) tags.delete(tags.keys().next().value);
    }
    let api = null;
    try {
      api = joint();
    } catch {
      api = null;
    }
    return api ? act(api, tag) === true : false;
  };
  return {
    exported: (review) => withTag(review, (api, tag) => api.claimRequest(tag)).catch(() => false),
    inspected: (review) => withTag(review, (api, tag) => api.watchRequest(tag)).catch(() => false),
    of(review) {
      const tag = tags.get(keyOf(review));
      if (!tag) return null;
      try {
        return joint()?.requesterOf(tag) ?? null;
      } catch {
        return null;
      }
    },
  };
}
