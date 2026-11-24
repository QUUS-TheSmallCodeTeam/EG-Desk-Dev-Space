// A separate collaboration authority. Never reads the local Desk, Agent, or browser store.
import { DatabaseSync } from 'node:sqlite';
import {teamAppTypes,appLabels,nextAppStates,isAppState,isAppRef} from '../overlay/resources/EGDeskJointMiniappSchema.sys.mjs';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
export class JointError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const fail = (n, c) => {
  throw new JointError(n, c);
};
const requireThat = (ok, n = 404, c = 'unavailable') => {
  if (!ok) fail(n, c);
};
const digest = (s) => createHash('sha256').update(s).digest('hex');
const uid = () => randomUUID();
const text = (s, max) => {
  requireThat(
    typeof s === 'string' &&
      s.trim().length > 0 &&
      s.length <= max &&
      !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(s),
    400,
    'invalid-text',
  );
  return s.trim();
};
const oneLine = (s, max) => {
  s = text(s, max);
  requireThat(!s.includes('\n'), 400, 'invalid-text');
  return s;
};
const login = (v) => {
  requireThat(typeof v === 'string' && /^[a-z][a-z0-9._-]{0,39}$/.test(v), 400, 'invalid-account');
  return v;
};
const id = (v) => {
  requireThat(
    typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v),
    400,
    'invalid-id',
  );
  return v;
};
const schema = `PRAGMA foreign_keys=ON; PRAGMA busy_timeout=4000;
CREATE TABLE IF NOT EXISTS identity(one INTEGER PRIMARY KEY CHECK(one=1),instance TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY,name TEXT NOT NULL,hash TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS boards(id TEXT PRIMARY KEY,title TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS seats(board TEXT REFERENCES boards(id),person TEXT REFERENCES people(id),epoch TEXT NOT NULL,role TEXT NOT NULL, PRIMARY KEY(board,person));
CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY,board TEXT NOT NULL REFERENCES boards(id),author TEXT NOT NULL,epoch TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,kind TEXT NOT NULL,rev INTEGER NOT NULL DEFAULT 1,x INTEGER,y INTEGER,removed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY,kind TEXT NOT NULL,src TEXT NOT NULL,dst TEXT NOT NULL,ref TEXT,title TEXT,expires INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',basis TEXT);
CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY,card TEXT NOT NULL REFERENCES cards(id),person TEXT NOT NULL,scope TEXT NOT NULL,basis TEXT NOT NULL,UNIQUE(card,person));
CREATE TABLE IF NOT EXISTS appitems(card TEXT PRIMARY KEY REFERENCES cards(id),type TEXT NOT NULL,ref TEXT NOT NULL,state TEXT NOT NULL,rev INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS photogrants(grantId TEXT PRIMARY KEY REFERENCES grants(id) ON DELETE CASCADE,stamp TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS appedit(grantId TEXT PRIMARY KEY REFERENCES grants(id) ON DELETE CASCADE,stamp TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS appruns(actor TEXT NOT NULL,request TEXT NOT NULL,sig TEXT NOT NULL,card TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(actor,request));
CREATE TABLE IF NOT EXISTS cardlinks(child TEXT PRIMARY KEY REFERENCES cards(id), parent TEXT NOT NULL REFERENCES cards(id), kind TEXT NOT NULL, parentAccess TEXT NOT NULL, stamp TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS claims(grantId TEXT PRIMARY KEY REFERENCES grants(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS replies(id TEXT PRIMARY KEY,card TEXT NOT NULL,src TEXT NOT NULL,dst TEXT NOT NULL,body TEXT NOT NULL,grantId TEXT NOT NULL,rev INTEGER NOT NULL,at INTEGER NOT NULL, UNIQUE(grantId,rev));
CREATE TABLE IF NOT EXISTS ops(actor TEXT NOT NULL,request TEXT NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(actor,request));
CREATE INDEX IF NOT EXISTS invites_dst ON invites(dst,state);CREATE INDEX IF NOT EXISTS seat_person ON seats(person);CREATE INDEX IF NOT EXISTS card_board ON cards(board);CREATE INDEX IF NOT EXISTS grants_person ON grants(person);`;
export function createJointStore(path, { now = Date.now, teamApps=null } = {}) {
  const db = new DatabaseSync(path);
  db.exec(schema);
  // An earlier local MVP can keep its data. Old, unbound single-card offers fail closed.
  if (
    !db
      .prepare('PRAGMA table_info(invites)')
      .all()
      .some((c) => c.name === 'cardRev')
  )
    db.exec('ALTER TABLE invites ADD COLUMN cardRev INTEGER');
  if (
    !db
      .prepare('PRAGMA table_info(cards)')
      .all()
      .some((c) => c.name === 'layoutRev')
  )
    db.exec('ALTER TABLE cards ADD COLUMN layoutRev INTEGER NOT NULL DEFAULT 0');
  db.prepare('INSERT OR IGNORE INTO identity VALUES (1,?)').run(uid());
  const one = (sql, ...v) => db.prepare(sql).get(...v),
    all = (sql, ...v) => db.prepare(sql).all(...v),
    run = (sql, ...v) => db.prepare(sql).run(...v);
  const person = (p) => one('SELECT id,name FROM people WHERE id=?', p);
  const seat = (b, p) => one('SELECT * FROM seats WHERE board=? AND person=?', b, p);
  const activeCard = (k) =>
    one(
      'SELECT c.* FROM cards c JOIN seats s ON s.board=c.board AND s.person=c.author AND s.epoch=c.epoch WHERE c.id=? AND c.removed=0',
      k,
    );
  const grant = (k, p) => one('SELECT * FROM grants WHERE card=? AND person=?', k, p);
  const board = (b) => one('SELECT id,title FROM boards WHERE id=?', b);
  function right(g, c) {
    if (!g || !c) return false;
    return g.scope === 'single' ? g.basis === c.epoch : seat(c.board, g.person)?.epoch === g.basis;
  }
  function safeInvite(i) {
    if (!i || i.state !== 'pending' || i.expires <= now()) return false;
    if (i.kind === 'form') return true;
    if (i.kind === 'join') return seat(i.ref, i.src)?.epoch === i.basis && seat(i.ref, i.src)?.role === 'founder';
    const c = activeCard(i.ref);
    return c?.author === i.src && c.epoch === i.basis && c.rev === i.cardRev;
  }
  function boardAccess(c,p){if(!c||!seat(c.board,p))return null;if(c.author===p)return c.epoch;const g=grant(c.id,p);return g?.scope==='board'&&right(g,c)?g.id:null;}
  function linkFor(child){const ref=one('SELECT parent,kind,parentAccess,stamp FROM cardlinks WHERE child=?',child.id);if(!ref)return null;const parent=activeCard(ref.parent);if(!parent||parent.board!==child.board||boardAccess(parent,child.author)!==ref.parentAccess)return null;return ref;}
  const appCatalog=teamApps?teamAppTypes.filter(t=>teamApps.catalog?.includes(t)):[];
  const appItem=k=>one('SELECT type,ref,state,rev FROM appitems WHERE card=?',k);
  const editStamp=(c,p,g)=>c.author===p?c.epoch:(g?.scope==='board'&&right(g,c)?one('SELECT stamp FROM appedit WHERE grantId=?',g.id)?.stamp:null);
  function renderCard(c, p, g, scope) {
    const own = c.author === p,
      showPos = scope !== 'single' && c.x !== null;
    // Rebuild explicitly. In particular an item-only recipient gets no Board ID, title, neighbours, geometry or roster.
    const data = {
      id: c.id,
      title: c.title,
      body: c.body,
      kind: c.kind,
      author: c.author,
      version: c.rev,
      access: own ? c.epoch : g.id,
      own,
      scope,
      claimed: !own && !!one('SELECT 1 FROM claims WHERE grantId=?', g.id),
      replied: !own && !!one('SELECT 1 FROM replies WHERE grantId=? AND rev=?', g.id, c.rev),
    };
    const app=appItem(c.id);if(app){const editor=editStamp(c,p,g);data.app={...app,mayEdit:!!editor&&appCatalog.includes(app.type),available:appCatalog.includes(app.type),...(editor?{editStamp:editor}:{})};}
    if(scope==='board'&&g){const pg=one('SELECT stamp FROM photogrants WHERE grantId=?',g.id);if(pg)data.layoutPhotoGrant=pg.stamp;}
    if (scope === 'board') data.layoutVersion = c.layoutRev;
    if (showPos) data.position = { x: c.x, y: c.y };
    if (own) {
      data.grants = all('SELECT id,person,scope FROM grants WHERE card=? ORDER BY person', c.id);for(const grant of data.grants)grant.photo=!!one('SELECT 1 FROM photogrants WHERE grantId=?',grant.id);if(app)for(const grant of data.grants)grant.appEdit=!!one('SELECT 1 FROM appedit WHERE grantId=?',grant.id);
      data.replies = all('SELECT id,src,body,at,rev FROM replies WHERE card=? AND dst=? ORDER BY at,id', c.id, p);
    }
    return data;
  }
  function view(p) {
    const self = person(p);
    requireThat(self, 401, 'authentication');
    const boards = all(
      'SELECT b.id,b.title,s.role,s.epoch FROM boards b JOIN seats s ON s.board=b.id WHERE s.person=? ORDER BY b.rowid',
      p,
    ).map((b) => {
      const cards = [];
      for (const c of all(
        'SELECT c.* FROM cards c JOIN seats s ON s.board=c.board AND s.person=c.author AND s.epoch=c.epoch WHERE c.board=? AND c.removed=0 ORDER BY c.rowid',
        b.id,
      )) {
        const g = grant(c.id, p);
        if (c.author === p || (g?.scope === 'board' && right(g, c))) cards.push(renderCard(c, p, g, 'board'));
      }
      // Even a relationship's existence is private unless both live endpoints are board-visible to this viewer.
      const visible=new Set(cards.map(c=>c.id));const links=[];for(const c of cards){const ref=linkFor({...c,board:b.id});if(ref&&visible.has(ref.parent))links.push({child:c.id,parent:ref.parent,kind:ref.kind,stamp:ref.stamp});}
      return {
        ...b,
        cards,links,
        people:
          b.role === 'founder' ? all('SELECT person,role FROM seats WHERE board=? ORDER BY person', b.id) : [],
      };
    });
    const singles = [];
    for (const g of all("SELECT * FROM grants WHERE person=? AND scope='single' ORDER BY rowid", p)) {
      const c = activeCard(g.card);
      if (right(g, c)) singles.push(renderCard(c, p, g, 'single'));
    }
    const invites = all(
      "SELECT * FROM invites WHERE dst=? AND state='pending' AND expires>? ORDER BY rowid",
      p,
      now(),
    )
      .filter(safeInvite)
      .map((i) => ({
        id: i.id,
        kind: i.kind,
        from: i.src,
        expires: i.expires,
        title: i.kind === 'form' ? i.title : i.kind === 'join' ? board(i.ref).title : activeCard(i.ref).title,
      }));
    const sent = all("SELECT * FROM invites WHERE src=? AND state='pending' AND expires>? ORDER BY rowid", p, now())
      .filter(safeInvite)
      .map((i) => ({
        id: i.id,
        kind: i.kind,
        to: i.dst,
        title: i.kind === 'form' ? i.title : i.kind === 'join' ? board(i.ref).title : activeCard(i.ref).title,
      }));
    return {
      version: 1,
      instance: one('SELECT instance FROM identity WHERE one=1').instance,
      self,appCatalog:[...appCatalog],
      boards,
      singles,
      invites,
      sent,
    };
  }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const v = fn();
      db.exec('COMMIT');
      return v;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  function issueAccount(v, n, { rotate = false } = {}) {
    const p = login(v),
      name = oneLine(n, 60),
      key = 'jb1.' + randomBytes(32).toString('base64url');
    transaction(() => {
      if (rotate) {
        requireThat(person(p));
        run('UPDATE people SET hash=?,name=? WHERE id=?', digest(key), name, p);
      } else {
        requireThat(!person(p), 409, 'account-exists');
        run('INSERT INTO people VALUES (?,?,?)', p, name, digest(key));
      }
    });
    return key;
  }
  function authentic(key) {
    return typeof key === 'string' && /^jb1\.[A-Za-z0-9_-]{43}$/.test(key)
      ? one('SELECT id FROM people WHERE hash=?', digest(key))?.id || null
      : null;
  }
  function newInvite(kind, src, dst, ref, title, basis, cardRev = null) {
    requireThat(person(dst) && dst !== src, 400, 'invalid-recipient');
    const old = one(
      "SELECT id FROM invites WHERE kind=? AND src=? AND dst=? AND ref IS ? AND title IS ? AND basis IS ? AND state='pending' AND expires>?",
      kind,
      src,
      dst,
      ref,
      title,
      basis,
      now(),
    );
    if (old) return;
    requireThat(
      ['src', 'dst'].every(
        (column, i) =>
          one(
            'SELECT count(*) n FROM invites WHERE ' + column + "=? AND state='pending' AND expires>?",
            [src, dst][i],
            now(),
          ).n < 150,
      ),
      409,
      'limit',
    );
    run(
      'INSERT INTO invites(id,kind,src,dst,ref,title,basis,expires,cardRev) VALUES(?,?,?,?,?,?,?,?,?)',
      uid(),
      kind,
      src,
      dst,
      ref,
      title,
      basis,
      now() + 7 * 86400000,
      cardRev,
    );
  }
  function addSeat(b, p, role) {
    if (seat(b, p)) return;
    requireThat(
      one('SELECT count(*) n FROM seats WHERE board=?', b).n < 500 &&
        one('SELECT count(*) n FROM seats WHERE person=?', p).n < 500,
      409,
      'limit',
    );
    run('INSERT INTO seats VALUES(?,?,?,?)', b, p, uid(), role);
  }
  function cancelSingle(k, dst = null) {
    run(
      "UPDATE invites SET state='cancelled' WHERE state='pending' AND kind='single' AND ref=? AND (? IS NULL OR dst=?)",
      k,
      dst,
      dst,
    );
  }
  const own = (a, k) => {
    const c = activeCard(id(k));
    requireThat(c && c.author === a);
    return c;
  };
  function myGrant(p, a) {
    const g = one('SELECT * FROM grants WHERE id=? AND person=?', id(a.grant), p),
      c = g && activeCard(g.card);
    requireThat(right(g, c));
    requireThat(c.rev === a.version, 409, 'changed');
    return { c, g };
  }
  function unseat(b, p) {
    const s = seat(b, p);
    requireThat(s);
    if (s.role === 'founder')
      requireThat(
        one("SELECT count(*) n FROM seats WHERE board=? AND role='founder'", b).n > 1,
        409,
        'last-founder',
      );
    run(
      "DELETE FROM grants WHERE card IN(SELECT id FROM cards WHERE board=?) AND ((person=? AND scope='board') OR card IN(SELECT id FROM cards WHERE board=? AND author=?))",
      b,
      p,
      b,
      p,
    );
    run(
      "UPDATE invites SET state='cancelled' WHERE state='pending' AND ((kind='join' AND ref=? AND (src=? OR dst=?)) OR (kind='single' AND ref IN(SELECT id FROM cards WHERE board=? AND author=?)))",
      b,
      p,
      p,
      b,
      p,
    );
    run('DELETE FROM cardlinks WHERE parent IN(SELECT id FROM cards WHERE board=? AND author=? AND epoch=?) OR child IN(SELECT id FROM cards WHERE board=? AND author=? AND epoch=?)',b,p,s.epoch,b,p,s.epoch);
    run('UPDATE cards SET removed=1 WHERE board=? AND author=? AND epoch=?', b, p, s.epoch);
    run('DELETE FROM seats WHERE board=? AND person=?', b, p);
  }
  function mutate(p, a) {
    requireThat(person(p), 401, 'authentication');
    requireThat(a && typeof a === 'object' && !Array.isArray(a), 400, 'invalid-action');
    const req = id(a.request),
      sig = digest(
        JSON.stringify(
          Object.fromEntries(
            Object.keys(a)
              .sort()
              .map((key) => [key, a[key]]),
          ),
        ),
      );
    transaction(() => {
      const was = one('SELECT signature FROM ops WHERE actor=? AND request=?', p, req);
      if (was) {
        requireThat(was.signature === sig, 409, 'request-conflict');
        return;
      }
      switch (a.action) {
        case 'propose':
          newInvite('form', p, login(a.to), null, oneLine(a.title, 100), null);
          break;
        case 'inviteBoard': {
          const b = id(a.board),
            s = seat(b, p);
          requireThat(s?.role === 'founder');
          const dst = login(a.to);
          requireThat(!seat(b, dst), 409, 'already-member');
          newInvite('join', p, dst, b, null, s.epoch);
          break;
        }
        case 'accept':
        case 'decline': {
          const i = one('SELECT * FROM invites WHERE id=? AND dst=?', id(a.invite), p);
          requireThat(i);
          if (i.state === 'accepted' && a.action === 'accept') break;
          requireThat(safeInvite(i), 409, 'invite-closed');
          if (a.action === 'decline') {
            run("UPDATE invites SET state='declined' WHERE id=?", i.id);
            break;
          }
          if (i.kind === 'form') {
            const b = uid();
            run('INSERT INTO boards VALUES(?,?)', b, i.title);
            addSeat(b, i.src, 'founder');
            addSeat(b, p, 'founder');
            run('UPDATE invites SET ref=? WHERE id=?', b, i.id);
          } else if (i.kind === 'join') {
            addSeat(i.ref, p, 'member');
          } else {
            const c = activeCard(i.ref);
            requireThat(!grant(c.id, p), 409, 'already-granted');
            requireThat(
              one('SELECT count(*) n FROM grants WHERE card=?', c.id).n < 500 &&
                one("SELECT count(*) n FROM grants WHERE person=? AND scope='single'", p).n < 500,
              409,
              'limit',
            );
            run('INSERT INTO grants VALUES(?,?,?,?,?)', uid(), c.id, p, 'single', c.epoch);
          }
          run("UPDATE invites SET state='accepted' WHERE id=?", i.id);
          break;
        }
        case 'cancelInvite':
          requireThat(
            run("UPDATE invites SET state='cancelled' WHERE id=? AND src=? AND state='pending'", id(a.invite), p)
              .changes === 1,
          );
          break;
        case 'addApp':{const board=id(a.board),member=seat(board,p);requireThat(member);requireThat(appCatalog.includes(a.type)&&isAppRef(a.ref),400,'invalid-app');requireThat(one('SELECT count(*) n FROM cards WHERE board=? AND removed=0',board).n<120,409,'limit');const k=uid(),title=appLabels[a.type]+' · '+a.ref;run('INSERT INTO cards(id,board,author,epoch,title,body,kind) VALUES(?,?,?,?,?,?,?)',k,board,p,member.epoch,title,'팀 앱 업무 항목: '+a.ref,'task');run('INSERT INTO appitems(card,type,ref,state) VALUES(?,?,?,?)',k,a.type,a.ref,a.type==='shipment'?'ready':'waiting');break;}
        case 'photoPermission':{const c=own(p,a.card),g=one('SELECT * FROM grants WHERE id=? AND card=?',id(a.grant),c.id);requireThat(right(g,c)&&g.scope==='board');requireThat(c.rev===a.version,409,'changed');requireThat(typeof a.allow==='boolean',400,'invalid-role');if(a.allow)run('INSERT OR IGNORE INTO photogrants VALUES(?,?)',g.id,uid());else run('DELETE FROM photogrants WHERE grantId=?',g.id);break;}
        case 'appPermission':{const c=own(p,a.card),g=one('SELECT * FROM grants WHERE id=? AND card=?',id(a.grant),c.id);requireThat(appItem(c.id)&&right(g,c)&&g.scope==='board');requireThat(c.rev===a.version,409,'changed');requireThat(typeof a.allow==='boolean',400,'invalid-role');if(a.allow)run('INSERT OR IGNORE INTO appedit VALUES(?,?)',g.id,uid());else run('DELETE FROM appedit WHERE grantId=?',g.id);break;}
        case 'addCard': {
          const b = id(a.board),
            s = seat(b, p);
          requireThat(s);
          const title = oneLine(a.title, 120),
            body = text(a.body, 4000);
          requireThat(['note', 'task', 'excerpt'].includes(a.kind), 400, 'invalid-kind');
          requireThat(one('SELECT count(*) n FROM cards WHERE board=? AND removed=0', b).n < 120, 409, 'limit');
          run(
            'INSERT INTO cards(id,board,author,epoch,title,body,kind) VALUES(?,?,?,?,?,?,?)',
            uid(),
            b,
            p,
            s.epoch,
            title,
            body,
            a.kind,
          );
          break;
        }
        case 'editCard':
        case 'place': {
          const c = own(p, a.card);
          requireThat(a.version === c.rev, 409, 'changed');
          if (a.action === 'editCard') {
            requireThat(!appItem(c.id),403,'app-fields');
            run(
              'UPDATE cards SET title=?,body=?,rev=rev+1 WHERE id=?',
              oneLine(a.title, 120),
              text(a.body, 4000),
              c.id,
            );
            cancelSingle(c.id);
          } else {
            requireThat(a.layoutVersion === c.layoutRev, 409, 'changed');
            requireThat(
              [a.x, a.y].every((n) => Number.isSafeInteger(n) && Math.abs(n) <= 20000),
              400,
              'invalid-placement',
            );
            run('UPDATE cards SET x=?,y=?,layoutRev=layoutRev+1 WHERE id=?', a.x, a.y, c.id);
          }
          break;
        }
        case 'linkCard':case 'unlinkCard':{const c=own(p,a.card);requireThat(c.rev===a.version,409,'changed');const prev=linkFor(c);requireThat((prev?.stamp||null)===(a.prior??null),409,'changed');
          if(a.action==='unlinkCard'){requireThat(prev);run('DELETE FROM cardlinks WHERE child=?',c.id);break;}
          const parent=activeCard(id(a.parent)),access=boardAccess(parent,p);requireThat(parent&&parent.board===c.board&&access&&parent.id!==c.id);requireThat(['waits','refers'].includes(a.kind),400,'invalid-kind');
          // Each child has one named upstream. A structural link never executes, publishes or grants access to its parent.
          if(a.kind==='waits'){const visited=new Set([c.id]);let cur=parent;while(cur){requireThat(!visited.has(cur.id),409,'cycle');visited.add(cur.id);const next=linkFor(cur);cur=next?.kind==='waits'?activeCard(next.parent):null;}}
          run('INSERT INTO cardlinks VALUES(?,?,?,?,?) ON CONFLICT(child) DO UPDATE SET parent=excluded.parent,kind=excluded.kind,parentAccess=excluded.parentAccess,stamp=excluded.stamp',c.id,parent.id,a.kind,access,uid());break;}
        case 'share': {
          const c = own(p, a.card),
            dst = login(a.to);
          requireThat(person(dst) && dst !== p, 400, 'invalid-recipient');
          requireThat(a.version === c.rev, 409, 'changed');
          requireThat(!grant(c.id, dst), 409, 'already-granted');
          if (a.scope === 'board') {
            const s = seat(c.board, dst);
            requireThat(s, 409, 'not-member');
            requireThat(one('SELECT count(*) n FROM grants WHERE card=?', c.id).n < 500, 409, 'limit');
            cancelSingle(c.id, dst);
            run('INSERT INTO grants VALUES(?,?,?,?,?)', uid(), c.id, dst, 'board', s.epoch);
          } else {
            requireThat(a.scope === 'single', 400, 'invalid-scope');
            newInvite('single', p, dst, c.id, null, c.epoch, c.rev);
          }
          break;
        }
        case 'revoke': {
          const c = own(p, a.card);
          const g = one('SELECT person FROM grants WHERE id=? AND card=?', id(a.grant), c.id);
          requireThat(g);
          cancelSingle(c.id, g.person);
          run('DELETE FROM grants WHERE id=? AND card=?', a.grant, c.id);
          break;
        }
        case 'removeCard': {
          const c = own(p, a.card);
          requireThat(a.version === c.rev, 409, 'changed');
          cancelSingle(c.id);
          run('DELETE FROM grants WHERE card=?', c.id);
          run('DELETE FROM cardlinks WHERE child=? OR parent=?',c.id,c.id);run('UPDATE cards SET removed=1 WHERE id=?', c.id);
          break;
        }
        case 'claim': {
          const { g } = myGrant(p, a);
          run('INSERT OR IGNORE INTO claims VALUES(?)', g.id);
          break;
        }
        case 'reply': {
          const { g, c } = myGrant(p, a);
          requireThat(c.author === a.to && !!one('SELECT 1 FROM claims WHERE grantId=?', g.id), 409, 'not-claimed');
          requireThat(!one('SELECT 1 FROM replies WHERE grantId=? AND rev=?', g.id, c.rev), 409, 'already-replied');
          requireThat(one('SELECT count(*) n FROM replies WHERE card=?', c.id).n < 5000, 409, 'limit');
          run(
            'INSERT INTO replies VALUES(?,?,?,?,?,?,?,?)',
            uid(),
            c.id,
            p,
            c.author,
            text(a.body, 2000),
            g.id,
            c.rev,
            now(),
          );
          break;
        }
        case 'leave':
          unseat(id(a.board), p);
          break;
        case 'exclude': {
          const b = id(a.board),
            dst = login(a.to);
          requireThat(seat(b, p)?.role === 'founder' && seat(b, dst)?.role === 'member');
          unseat(b, dst);
          break;
        }
        default:
          fail(400, 'invalid-action');
      }
      run('INSERT INTO ops VALUES(?,?,?)', p, req, sig);
    });
    return view(p);
  }
  // This operator service has one process per DB. Interrupted pure computations are never replayed on restart.
  if(teamApps)db.exec("UPDATE appruns SET state='interrupted' WHERE state='pending'");const pending=new Map();let stopped=false;
  function appPermit(p,a){const c=activeCard(id(a.card)),app=c&&appItem(c.id),g=c&&grant(c.id,p);requireThat(c&&app&&appCatalog.includes(app.type));const actorStamp=editStamp(c,p,g);requireThat(actorStamp&&a.editStamp===actorStamp&&(c.author===p?c.epoch:g.id)===a.access);requireThat(app.rev===a.appRev&&c.rev===a.version,409,'changed');requireThat(isAppState(app.type,a.to)&&nextAppStates(app.type,app.state).includes(a.to),400,'invalid-transition');return {c,app,actorStamp};}
  async function stepApp(p,a,{current=()=>true,signal=null}={}){requireThat(a?.action==='appStep'&&!!teamApps&&!stopped&&current());const request=id(a.request),k=p+'/'+request;const sig=digest(JSON.stringify([id(a.card),a.access,a.editStamp,a.version,a.appRev,a.to]));
    const admission=transaction(()=>{const prior=one('SELECT sig,state FROM appruns WHERE actor=? AND request=?',p,request);if(prior){requireThat(prior.sig===sig,409,'request-conflict');if(prior.state==='done')return null;fail(409,prior.state==='pending'?'app-busy':'app-interrupted');}requireThat(!one('SELECT 1 FROM ops WHERE actor=? AND request=?',p,request),409,'request-conflict');const permit=appPermit(p,a);requireThat(pending.size<24&&!one("SELECT 1 FROM appruns WHERE card=? AND state='pending'",a.card),409,'app-busy');run("INSERT INTO appruns VALUES(?,?,?,?,'pending')",p,request,sig,a.card);return permit;});if(!admission)return view(p);
    const controller=new AbortController();const abort=()=>controller.abort();if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});pending.set(k,{controller,actor:p,a});
    try{requireThat(!controller.signal.aborted&&current(),409,'app-interrupted');const reply=await teamApps.step({type:admission.app.type,from:admission.app.state,to:a.to},{signal:controller.signal});transaction(()=>{requireThat(!stopped&&!controller.signal.aborted&&current()&&one('SELECT state FROM appruns WHERE actor=? AND request=?',p,request)?.state==='pending',409,'app-interrupted');const now=appPermit(p,a);requireThat(reply&&reply.type===now.app.type&&reply.state===a.to,503,'app-unavailable');run('UPDATE appitems SET state=?,rev=rev+1 WHERE card=?',reply.state,a.card);run('UPDATE cards SET rev=rev+1 WHERE id=?',a.card);cancelSingle(a.card);run("UPDATE appruns SET state='done' WHERE actor=? AND request=?",p,request);run('INSERT INTO ops VALUES(?,?,?)',p,request,sig);});return view(p);
    }catch(err){if(!stopped)run("UPDATE appruns SET state='interrupted' WHERE actor=? AND request=? AND state='pending'",p,request);if(err instanceof JointError)throw err;if(stopped||controller.signal.aborted||!current())fail(409,'app-interrupted');fail(503,'app-unavailable');}finally{signal?.removeEventListener('abort',abort);pending.delete(k);}}
  function cancelStale(){for(const rec of pending.values()) {try{appPermit(rec.actor,rec.a);}catch{rec.controller.abort();}}}
  // Read-only (SELECT only) check for the ephemeral presence feed: is this person seated on this Board, and which of the
  // given cards can they see there. It never writes, and presence itself is never stored in this database.
  function presenceAccess(p, b, cards = []) {
    if (typeof b !== 'string' || !person(p)) return null;
    const s = seat(b, p);
    if (!s) return null;
    const visible = [];
    for (const k of Array.isArray(cards) ? cards.slice(0, 64) : []) {
      const c = typeof k === 'string' ? activeCard(k) : null;
      if (c && c.board === b && boardAccess(c, p)) visible.push(k);
    }
    return { epoch: s.epoch, visible };
  }
  return {presenceAccess,issueAccount,authentic,view,mutate(p,a){if(a?.request)requireThat(!one('SELECT 1 FROM appruns WHERE actor=? AND request=?',p,a.request),409,'request-conflict');const v=mutate(p,a);cancelStale();return v;},stepApp,close(){stopped=true;for(const rec of pending.values())rec.controller.abort();db.close();}};
}
