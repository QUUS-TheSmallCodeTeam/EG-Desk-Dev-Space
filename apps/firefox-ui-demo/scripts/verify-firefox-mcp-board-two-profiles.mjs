// Opt-in human collaboration E2E. Two new, marked Firefox profiles; NO Agent/profile/provider credentials.
// Starts only owned headless processes. Real service and Firefox chrome DOM handlers; not a physical-mouse test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { bootstrapQaProfile, assertQaProfile } from './egdesk-chat-qa-profile.mjs';
import { prepareQaFirefox } from './run-firefox-mcp-target.mjs';
import { validateQaFixtureIsolation } from './egdesk-qa-fixture-isolation.mjs';
import { FirefoxMcpChatHarness } from './firefox-mcp-chat-harness.mjs';
import { captureHeadlessScreenshot } from './verify-firefox-mcp-headless-ui-regression.mjs';
import { createJointStore } from '../helper/egdesk-joint-board-store.mjs';
import { startJointServer } from '../helper/egdesk-joint-board-server.mjs';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const bounded = async (fn, goal, label, ms = 18000) => {
  const until = Date.now() + ms;
  let last;
  do {
    last = await fn();
    if (goal(last)) return last;
    await wait(160);
  } while (Date.now() < until);
  throw Error('not observed: ' + label);
};
const listen = (s) =>
  new Promise((ok, no) => {
    s.once('error', no);
    s.listen(0, '127.0.0.1', () => ok(s.address().port));
  });
async function free(port) {
  const guard = net.createServer();
  await new Promise((ok, no) => {
    guard.once('error', no);
    guard.listen(port, '127.0.0.1', () => guard.close(ok));
  });
}
const id = (n) => `[data-testid="${n}"]`,
  j = (n) => id('joint-' + n);
const boardTitle = '배송 인계 QA',
  taskTitle = 'SH-42 집하 전표',
  privateTitle = '정산 검토 전용 QA',
  body = '집하 예정 · 합성 건 42',
  result = 'SH-42 집하 완료 확인',
  draft = '쪽지 초안 · 아직 보내지 않음';
const safeBrowserPrefs = {
  'network.proxy.type': 1,
  'network.proxy.http': '127.0.0.1',
  'network.proxy.http_port': 1,
  'network.proxy.ssl': '127.0.0.1',
  'network.proxy.ssl_port': 1,
  'network.proxy.no_proxies_on': 'localhost,127.0.0.1,::1',
  'network.trr.mode': 5,
  'network.prefetch-next': false,
  'network.dns.disablePrefetch': true,
  'app.update.auto': false,
  'identity.fxaccounts.enabled': false,
  'browser.startup.homepage': 'about:blank',
  'browser.startup.page': 0,
  'browser.search.update': false,
  'browser.crashReports.unsubmittedCheck.autoSubmit2': false,
};
export async function verify({ executable, loaderSource, evidence }) {
  assert.ok(
    path.isAbsolute(executable || '') && path.isAbsolute(loaderSource || ''),
    'give installed EG-Desk Firefox and dedicated six-file loader',
  );
  assert.ok(
    process.env.TMPDIR &&
      process.env.HOME &&
      fs.realpathSync(process.env.HOME).startsWith(fs.realpathSync(os.tmpdir()) + path.sep),
    'set HOME to an empty synthetic subdirectory of dedicated TMPDIR',
  );
  const owned = [],
    checks = [],
    profiles = [];
  let store, service, stub;
  const mark = (s) => {
    checks.push(s);
    console.log('ok:', s);
  };
  let providerCalls = 0;
  const qa = fs.mkdtempSync(path.join(os.tmpdir(), 'joint-board-proof-'));
  evidence = evidence || qa;
  fs.mkdirSync(evidence, { recursive: true });
  async function boot(index) {
    const p = profiles[index];
    assertQaProfile(p.profile);
    validateQaFixtureIsolation(p.profile, { env: p.env, requireFresh: false });
    await free(p.marionette);
    await free(p.remote);
    const env = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      TMPDIR: os.tmpdir(),
      MOZ_HEADLESS: '1',
      MOZ_HEADLESS_WIDTH: '1440',
      MOZ_HEADLESS_HEIGHT: '980',
      MOZ_DISABLE_CRASHREPORTER: '1',
      MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1',
      ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
    };
    const child = spawn(
      executable,
      [
        '-profile',
        p.profile,
        '--no-remote',
        '--purgecaches',
        '--marionette',
        '--remote-debugging-port',
        String(p.remote),
        '--remote-allow-hosts',
        'localhost',
        'about:blank',
      ],
      { env, stdio: ['ignore', 'ignore', fs.openSync(path.join(qa, 'firefox-' + index + '.log'), 'a', 0o600)] },
    );
    const proc = { child, h: null, exited: once(child, 'exit') };
    owned.push(proc);
    await bounded(
      async () => {
        if (child.exitCode !== null) throw Error('owned Firefox exited');
        return new Promise((r) => {
          const n = net.connect(p.marionette, '127.0.0.1');
          n.once('connect', () => {
            n.destroy();
            r(true);
          });
          n.once('error', () => r(false));
        });
      },
      Boolean,
      'owned Firefox listener',
    );
    const h = new FirefoxMcpChatHarness({ profile: p.profile, marionettePort: p.marionette });
    proc.h = h;
    await h.connect();
    const evaluate = (fn, ...args) => h.evaluateChrome(`()=>(${String(fn)})(...${JSON.stringify(args)})`);
    assert.equal(await evaluate(() => Cc['@mozilla.org/gfx/info;1'].getService(Ci.nsIGfxInfo).isHeadless), true);
    const see = async (sel, text) =>
      bounded(
        () =>
          evaluate(
            (q, t) => [...document.querySelectorAll(q)].some((n) => !t || n.textContent.includes(t)),
            sel,
            text || '',
          ),
        Boolean,
        sel + (text ? ' ' + text : ''),
      );
    const click = async (sel, text) => {
      await see(sel, text);
      const yes = await evaluate(
        (q, t) => {
          const e = [...document.querySelectorAll(q)].find((n) => !t || n.textContent.includes(t));
          if (!e || e.disabled) return false;
          e.click();
          return true;
        },
        sel,
        text || '',
      );
      assert.equal(yes, true);
    };
    const fill = async (sel, v) => {
      await see(sel);
      assert.ok(
        await evaluate(
          (q, v) => {
            const e = document.querySelector(q);
            if (!e) return false;
            e.value = v;
            e.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          },
          sel,
          v,
        ),
      );
    };
    const has = (sel) => evaluate((q) => !!document.querySelector(q), sel);
    const shut = async () => {
      await h.assertRemoteProfile();
      await evaluate(() => {
        window.setTimeout(() => Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit), 80);
        return true;
      });
      await bounded(
        () => Promise.resolve(child.exitCode),
        (v) => v !== null,
        'graceful Firefox shutdown',
        20000,
      );
      await h.close();
      proc.h = null;
    };
    await see(id('rail-board-list'));
    if (await evaluate(() => document.documentElement.classList.contains('egd-initial-browser-focus'))) {
      await h.click(id('first-run-desk-entry'));
      await bounded(
        () => evaluate(() => document.documentElement.classList.contains('egd-initial-browser-focus')),
        (v) => !v,
        'actual Desk entry',
      );
    }
    return { h, evaluate, see, click, fill, has, shut };
  }
  async function hub(x) {
    if (await x.has('#egd-joint-panel')) await x.click(j('panel-close'));
    if (!(await x.has('#egd-agenda-switcher'))) await x.click(id('rail-board-list'));
    await x.click(j('hub'));
  }
  async function sign(x, origin, k) {
    await hub(x);
    await x.fill(j('origin'), origin);
    await x.fill(j('key'), k);
    await x.click(j('connect'));
    await x.see(j('propose'));
  }
  async function manage(x) {
    if (await x.has('#egd-joint-panel')) await x.click(j('panel-close'));
    await x.click(id('board-menu'));
    await x.click(j('board-manage'));
    await x.see(j('add'));
  }
  async function add(x, title, txt) {
    await manage(x);
    await x.click(j('add'));
    await x.fill(j('title'), title);
    await x.fill(j('body'), txt);
    await x.click(j('save-card'));
    await x.see(j('board-item'), title);
  }
  async function screenshot(x, name) {
    if (await x.has('#egd-board-notice button')) await x.click('#egd-board-notice button');
    const caption = await captureHeadlessScreenshot(x.h, name, Date.now() + 80000);
    assert.equal(caption.status, 'captured');
    fs.copyFileSync(caption.path, path.join(evidence, name + '.png'));
  }
  try {
    stub = http.createServer((req, res) => {
      if (req.method === 'POST' && /\/(chat\/send|chat\/board\/send|decisions|responses)(?:\?|$)/.test(req.url))
        providerCalls++;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"available":false}');
    });
    const bridgePort = await listen(stub);
    const fixtureEnv = {
      EGDESK_QA_FIXTURE_TRANSPORT: '1',
      EGDESK_QA_FIXTURE_PORT: String(bridgePort),
      EGDESK_QA_REAL_TURN: '0',
    };
    for (let i = 0; i < 2; i++) {
      const p = bootstrapQaProfile({ loaderSource });
      fs.writeFileSync(
        path.join(p.profile, 'user.js'),
        Object.entries(safeBrowserPrefs)
          .map(([k, v]) => 'user_pref(' + JSON.stringify(k) + ',' + JSON.stringify(v) + ');')
          .join('\n') + '\n',
        { mode: 0o600 },
      );
      const m = 28831 + i,
        r = 60831 + i;
      prepareQaFirefox(p.profile, { mode: 'automation', marionette: m, remote: r, env: fixtureEnv });
      profiles.push({ profile: p.profile, env: fixtureEnv, marionette: m, remote: r });
    }
    store = createJointStore(path.join(qa, 'service.sqlite'));
    const keys = {
      a: store.issueAccount('sender', '서윤'),
      b: store.issueAccount('partner', '민재'),
      c: store.issueAccount('receiver', '지우'),
    };
    service = await startJointServer(store, 0);
    const origin = 'http://127.0.0.1:' + service.address().port;
    const a = await boot(0);
    let b = await boot(1);
    await sign(a, origin, keys.a);
    await sign(b, origin, keys.b);
    mark('two verified Firefox chrome profiles connect with independent operator-issued credentials');
    await a.click(j('propose'));
    await a.fill(j('title'), boardTitle);
    await a.fill(j('to'), 'partner');
    await a.click(j('send-proposal'));
    await b.click(j('invite-detail'));
    await b.click(j('accept'));
    await b.see(id('board-projection'), boardTitle);
    await a.click(j('open'), boardTitle);
    await a.see(id('board-projection'), boardTitle);
    mark('explicit joint acceptance opens one real Board region on both Desks');
    await add(a, taskTitle, body);
    await add(a, privateTitle, '공급가 차이 17 · 비공개');
    await a.click(j('panel-close'));
    await a.see(j('card'), privateTitle);
    assert.equal(await b.has(j('card')), false);
    await hub(a);
    await a.click(j('open'), boardTitle);
    await a.see(id('board-projection'));
    await bounded(
      () =>
        a.evaluate(
          () =>
            [...document.querySelectorAll('[data-testid="joint-card"]')].filter((e) => {
              const r = e.getBoundingClientRect();
              const hit = document.elementFromPoint(r.x + 55, r.y + 45);
              return !!hit && e.contains(hit);
            }).length,
        ),
      (n) => n === 2,
      'two visible and hittable owner cards',
    );
    await screenshot(a, 'joint-owner');
    mark('two independent card windows inside the owner Board; participant sees neither until grant');
    await manage(a);
    await a.click(j('board-item'), taskTitle);
    await a.click(j('share'));
    await a.fill(j('to'), 'partner');
    await a.click(j('share-preview'));
    await a.click(j('confirm'));
    await b.see(j('card'), taskTitle);
    assert.ok(
      !(await b.evaluate((t) => document.querySelector('#egd-canvas-layer').textContent.includes(t), privateTitle)),
    );
    const personalPose = await b.evaluate(() => {
      const e = document.querySelector('[data-testid="joint-card"]');
      const head = e.querySelector('.egd-desk-window-titlebar');
      const rect = head.getBoundingClientRect(),
        x = rect.left + 64,
        y = rect.top + 8,
        start = e.offsetLeft;
      for (const [target, type, dx, dy] of [
        [head, 'mousedown', 0, 0],
        [window, 'mousemove', 42, 31],
        [window, 'mouseup', 42, 31],
      ])
        target.dispatchEvent(
          new MouseEvent(type, {
            button: 0,
            buttons: type === 'mouseup' ? 0 : 1,
            bubbles: true,
            cancelable: true,
            clientX: x + dx,
            clientY: y + dy,
          }),
        );
      return { changed: e.offsetLeft !== start, x: e.offsetLeft, y: e.offsetTop };
    });
    assert.equal(personalPose.changed, true);
    assert.equal(store.view('sender').boards[0].cards[0].position, undefined);
    mark('moving a recipient window changes personal geometry, not published Board placement');
    await b.click(j('claim'));
    await b.click(j('draft'));
    await b.fill(j('draft-text'), draft);
    assert.equal(store.view('sender').boards[0].cards.find((c) => c.title === taskTitle).replies.length, 0);
    mark('claim opens a private draft; draft is not an author-visible reply');
    await b.fill(j('draft-text'), result);
    await b.click(j('reply-review'));
    assert.equal(store.view('sender').boards[0].cards[0].replies.length, 0);
    await b.click(j('reply-send'));
    await b.see(j('card'), '회신 보냄');
    await manage(a);
    await a.click(j('board-item'), taskTitle);
    await a.see('#egd-joint-panel', result);
    mark('only explicit send publishes reply to the provider');
    await b.click('.egd-dock-btn[data-id="memo"]');
    await b.see('.egd-memo-card');
    await bounded(
      () =>
        b.evaluate(() => {
          const p = Services.prefs.getStringPref('egdesk.deskSession.v1', '');
          if (!p) return false;
          const s = JSON.parse(p);
          return s.cards.some((c) => c.type === 'memo') && !!s.agenda?.id;
        }),
      Boolean,
      'persist unrelated personal memo',
    );
    const leak = await b.evaluate(
      (...needles) => {
        const raw = Services.prefs.getStringPref('egdesk.deskSession.v1', '');
        return needles.filter((text) => raw.includes(text)).length;
      },
      taskTitle,
      boardTitle,
      privateTitle,
      result,
      draft,
      keys.b,
    );
    assert.equal(leak, 0);
    await hub(b);
    await b.click(j('open'), boardTitle);
    await screenshot(b, 'joint-recipient');
    await b.shut();
    b = await boot(1);
    await b.see('.egd-memo-card');
    assert.equal(await b.has(j('card')), false);
    await sign(b, origin, keys.b);
    await b.click(j('open'), boardTitle);
    await b.see(j('card'), taskTitle);
    assert.deepEqual(
      await b.evaluate(() => {
        const e = document.querySelector('[data-testid="joint-card"]');
        return [e.offsetLeft, e.offsetTop];
      }),
      [personalPose.x, personalPose.y],
    );
    mark(
      'cold restart restores personal desk but no restricted view/key; authenticated reopen restores only authorized card',
    );
    await a.click(j('revoke'));
    await a.click(j('confirm'));
    await bounded(
      () => b.has(j('card')),
      (v) => !v,
      'revocation removes mounted card',
    );
    await hub(b);
    await b.click(j('open'), boardTitle);
    assert.equal(await b.has(j('card')), false);
    mark('revoke removes live card and authenticated Board reopen cannot restore it');
    await hub(b);
    await b.click(j('disconnect'));
    await sign(b, origin, keys.c);
    await manage(a);
    await a.click(j('board-item'), taskTitle);
    await a.click(j('share'));
    await a.fill(j('to'), 'receiver');
    await a.fill(j('scope'), 'single');
    await a.click(j('share-preview'));
    await a.click(j('confirm'));
    await b.click(j('invite-detail'));
    await b.click(j('accept'));
    await b.see('[data-joint-scope="single"]', taskTitle);
    assert.equal(await b.has(id('board-projection')), false);
    const single = store.view('receiver');
    assert.equal(single.boards.length, 0);
    assert.equal(single.singles.length, 1);
    assert.ok(!JSON.stringify(single).includes(boardTitle));
    assert.equal(providerCalls, 0);
    mark('third human receives only one card, no Board, geometry or roster; zero provider requests');
    await b.shut();
    await a.shut();
    const info = {
      checks,
      profileCount: 2,
      syntheticPeople: 3,
      providerCalls,
      evidence: ['joint-owner.png', 'joint-recipient.png'],
    };
    fs.writeFileSync(path.join(evidence, 'verification.json'), JSON.stringify(info, null, 2));
    return info;
  } finally {
    for (const p of owned.reverse()) {
      await p.h?.close().catch(() => {});
      if (p.child.exitCode === null && p.child.signalCode === null) {
        p.child.kill('SIGTERM');
        await Promise.race([p.exited.catch(() => {}), wait(4000)]);
      }
    }
    for (const server of [service, stub])
      if (server) {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
    store?.close();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verify({
      executable: process.env.EGDESK_FIREFOX_BIN,
      loaderSource: process.env.EGDESK_QA_LOADER_SOURCE,
      evidence: process.env.EGDESK_JOINT_EVIDENCE,
    });
    console.log(JSON.stringify(result));
  } catch (e) {
    console.error(e.stack || e.message);
    process.exitCode = 1;
  }
}
