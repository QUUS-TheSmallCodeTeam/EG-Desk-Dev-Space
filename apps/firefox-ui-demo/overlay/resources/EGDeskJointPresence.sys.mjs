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
  only(raw, ['version', 'board', 'self', 'share', 'staleMs', 'expireMs', 'members']);
  if (raw.version !== 1 || raw.board !== board || !alias.test(raw.self) || !Array.isArray(raw.members) || raw.members.length > PRESENCE.maxMembers) bad();
  const seen = new Set([raw.self]);
  return {
    self: raw.self,
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
    if (mode === 'off') return { board: board.id, share: 'off' };
    const body = { board: board.id, share: mode, inputAgeMs: Math.max(0, Math.round(me.lastInputAgeMs)) };
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
    /** Replace every Board's sharing level at once (a saved choice read after connecting). Does not report back to the host. */
    loadShare(map) {
      share.clear();
      for (const [k, v] of Object.entries(map && typeof map === 'object' ? map : {})) if (uuid.test(k) && SHARE_LEVELS.includes(v) && v !== 'off') share.set(k, v);
      sentAt.clear();
    },
    reset() {
      feeds.clear();
      sentAt.clear();
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
