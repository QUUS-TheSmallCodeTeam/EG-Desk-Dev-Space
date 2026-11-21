// Independent authority, not a route on the local Codex/Desk bridge.
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJointStore, JointError } from './egdesk-joint-board-store.mjs';
const routeBase = '/v1/joint';
export function jointHttp(store, { tlsAuthority = null } = {}) {
  return async (req, res) => {
    const send = (status, value) => {
      if (!res.writableEnded) {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        });
        res.end(JSON.stringify(value));
      }
    };
    try {
      const host = req.headers.host || '';
      if (
        tlsAuthority
          ? host.toLowerCase() !== tlsAuthority
          : !/^(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?$/.test(host)
      )
        throw new JointError(403, 'origin');
      if (req.headers.origin && !['null', 'chrome://browser'].includes(req.headers.origin))
        throw new JointError(403, 'origin');
      const auth = req.headers.authorization?.match(/^Bearer (jb1\.[A-Za-z0-9_-]{43})$/)?.[1];
      const actor = store.authentic(auth);
      if (!actor) throw new JointError(401, 'authentication');
      if (req.url === routeBase + '/view' && req.method === 'GET') return send(200, store.view(actor));
      if (req.url !== routeBase + '/action' || req.method !== 'POST') throw new JointError(404, 'unavailable');
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
        throw new JointError(415, 'json-required');
      const chunks = [];
      let n = 0;
      for await (const b of req) {
        n += b.length;
        if (n > 30000) throw new JointError(413, 'too-large');
        chunks.push(b);
      }
      let data;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new JointError(400, 'invalid-json');
      }
      if (store.authentic(auth) !== actor) throw new JointError(401, 'authentication');
      if(data?.action==='appStep'){const controller=new AbortController();const lost=()=>{if(!res.writableEnded)controller.abort();};res.once('close',lost);try{return send(200,await store.stepApp(actor,data,{current:()=>!res.destroyed&&store.authentic(auth)===actor,signal:controller.signal}));}finally{res.off('close',lost);}}
      return send(200, store.mutate(actor, data));
    } catch (e) {
      return send(e instanceof JointError ? e.status : 500, {
        error: e instanceof JointError ? e.code : 'operation-failed',
      });
    }
  };
}
export function startJointServer(store, port = 47631) {
  const h = http.createServer({ requestTimeout: 10000, headersTimeout: 8000 }, jointHttp(store));
  h.maxHeadersCount = 32;
  h.keepAliveTimeout = 1800;
  return new Promise((resolve, reject) => {
    h.once('error', reject);
    h.listen(port, '127.0.0.1', () => resolve(h));
  });
}
// Opt-in self-hosting: a public origin never serves plain HTTP. No HTTP service account issuance.
export function startJointTlsServer(store, { origin, bind, cert, key }) {
  const u = new URL(origin);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.pathname !== '/' ||
    u.hash ||
    u.search ||
    !isIP(bind)
  )
    throw Error('expected a bare HTTPS origin and an explicit bind IP');
  const h = https.createServer(
    { cert, key, minVersion: 'TLSv1.2', requestTimeout: 10000, headersTimeout: 8000 },
    jointHttp(store, { tlsAuthority: u.host.toLowerCase() }),
  );
  h.maxHeadersCount = 32;
  h.keepAliveTimeout = 1800;
  return new Promise((resolve, reject) => {
    h.once('error', reject);
    h.listen(Number(u.port || 443), bind, () => resolve(h));
  });
}
async function main(argv) {
  process.umask(0o077);
  const [cmd, dir, ...args] = argv;
  if (!['serve', 'serve-tls', 'issue', 'rotate'].includes(cmd) || !path.isAbsolute(dir || ''))
    throw Error(
      'usage: serve ABS_DATA_DIR [PORT] | serve-tls ABS_DATA_DIR HTTPS_ORIGIN BIND_IP CERT_CHAIN_PEM KEY_PEM | issue/rotate ABS_DATA_DIR ACCOUNT DISPLAY_NAME ABS_NEW_KEY_FILE',
    );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (
    fs.lstatSync(dir).isSymbolicLink() ||
    !fs.statSync(dir).isDirectory() ||
    (process.platform !== 'win32' && fs.statSync(dir).mode & 0o077)
  )
    throw Error('use a private data directory (mode 0700)');
  const file = path.join(dir, 'joint.sqlite');
  if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw Error('database must be a regular file');
  let teamApps=null;const descriptor=process.env.EGDESK_TEAM_APPS_DESCRIPTOR;if(descriptor&&['serve','serve-tls'].includes(cmd)){const {loadTeamApps}=await import('./egdesk-joint-miniapp-runner.mjs');teamApps=await loadTeamApps(descriptor);await teamApps.verify();}
  const store = createJointStore(file,{teamApps});
  if (cmd === 'serve' || cmd === 'serve-tls') {
    let h, label;
    if (cmd === 'serve') {
      const port = Number(args[0] ?? 47631);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('invalid port');
      h = await startJointServer(store, port);
      label = 'http://127.0.0.1:' + port;
    } else {
      const [origin, bind, chain, secret] = args;
      if (!path.isAbsolute(chain || '') || !path.isAbsolute(secret || ''))
        throw Error('absolute TLS certificate and key paths required');
      h = await startJointTlsServer(store, {
        origin,
        bind,
        cert: fs.readFileSync(chain),
        key: fs.readFileSync(secret),
      });
      label = new URL(origin).origin;
    }
    console.log('협업 서비스 준비: ' + label);
    for (const sig of ['SIGINT', 'SIGTERM'])
      process.once(sig, () => {
        h.close(() => {
          store.close();
          process.exit(0);
        });
        h.closeIdleConnections?.();
      });
  } else {
    const [account, name, out] = args;
    if (!path.isAbsolute(out || '')) throw Error('a NEW absolute key file path is required');
    const fd = fs.openSync(out, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, store.issueAccount(account, name, { rotate: cmd === 'rotate' }) + '\n');
      fs.fsyncSync(fd);
    } catch (e) {
      fs.unlinkSync(out);
      throw e;
    } finally {
      fs.closeSync(fd);
      store.close();
    }
    console.log('계정 키를 지정한 새 파일에 저장했습니다. 키는 출력하지 않습니다.');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof JointError ? e.code : e.message);
    process.exitCode = 1;
  });
