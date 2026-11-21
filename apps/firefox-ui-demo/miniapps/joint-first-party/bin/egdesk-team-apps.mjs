#!/usr/bin/env node
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync,
  realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';

const JSON_TYPE = 'application/json';
const LIMIT = 256;
const MAC = 'x-egdesk-signature';
const HEX_MAC = /^[a-f0-9]{64}$/;
const catalog = ['shipment', 'inspection'];
const transitions = new Set([
  'shipment:ready:picked', 'shipment:picked:delivered',
  'inspection:waiting:pass', 'inspection:waiting:hold', 'inspection:hold:pass',
]);

function reduce({ type, from, to }) {
  if (![type, from, to].every(value => typeof value === 'string' && /^[a-z]+$/.test(value))) return null;
  return transitions.has(`${type}:${from}:${to}`) ? { type, state: to } : null;
}

function mac(key, ...parts) {
  return createHmac('sha256', key).update(parts.join('\n')).digest('hex');
}

function equalMac(value, expected) {
  return typeof value === 'string' && HEX_MAC.test(value) &&
    timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(expected, 'hex'));
}

function checkAncestors(dir, uid) {
  for (;;) {
    const st = lstatSync(dir);
    if (!st.isDirectory() || (st.uid !== uid && st.uid !== 0) ||
        ((st.mode & 0o022) && !(st.mode & 0o1000))) throw Error('Unsafe directory ancestry');
    const parent = dirname(dir);
    if (dir === parent) return;
    dir = parent;
  }
}

function descriptorPath(arg, uid) {
  if (!arg || !isAbsolute(arg) || arg.endsWith('/') || ['.', '..'].includes(basename(arg)) ||
      normalize(arg) !== arg) throw Error('Expected a normalized absolute descriptor file path');
  const parent = dirname(arg);
  try {
    lstatSync(parent);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const ancestor = realpathSync(dirname(parent));
    checkAncestors(ancestor, uid);
    mkdirSync(join(ancestor, basename(parent)), { mode: 0o700 });
  }
  const source = lstatSync(parent);
  const canonical = realpathSync(parent);
  const st = lstatSync(canonical);
  if (!source.isDirectory() || source.dev !== st.dev || source.ino !== st.ino ||
      st.uid !== uid || (st.mode & 0o7777) !== 0o700) {
    throw Error('Descriptor directory must be owner-only (0700)');
  }
  checkAncestors(canonical, uid);
  const file = join(canonical, basename(arg));
  try {
    lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return file;
    throw err;
  }
  throw Error('Descriptor path already exists');
}

function publish(file, descriptor) {
  const tmp = join(dirname(file), `.egdesk-${randomBytes(16).toString('hex')}`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, JSON.stringify(descriptor));
    const identity = fstatSync(fd);
    linkSync(tmp, file);
    return identity;
  } finally {
    closeSync(fd);
    unlinkSync(tmp);
  }
}

async function main() {
  const [arg, portArg = '0', ...extra] = process.argv.slice(2);
  if (extra.length || !/^(0|[1-9][0-9]{0,4})$/.test(portArg) || String(+portArg) !== portArg || +portArg > 65535 ||
      typeof process.getuid !== 'function') throw Error('Usage: egdesk-team-apps ABS_NEW_DESCRIPTOR_PATH [PORT]');
  const file = descriptorPath(arg, process.getuid());
  const key = randomBytes(32);
  let origin, host, identity;
  const server = createServer({ maxHeaderSize: 4096, headersTimeout: 1500,
    requestTimeout: 1500, connectionsCheckingInterval: 500 }, async (req, res) => {
    const timer = setTimeout(() => res.destroy(), 1500);
    res.on('close', () => clearTimeout(timer));
    res.setHeader('Connection', 'close');
    res.setHeader('Cache-Control', 'no-store');
    const reject = (status) => { res.statusCode = status; res.end(); };
    const headers = req.headersDistinct;
    const one = (name) => headers[name]?.length === 1 ? headers[name][0] : undefined;
    const verify = req.method === 'GET' && req.url === '/v1/catalog';
    const step = req.method === 'POST' && req.url === '/v1/step';
    if (!verify && !step) return reject(404);
    if (!identity || one('host') !== host || one('origin') !== origin) return reject(403);
    if (headers['transfer-encoding'] || headers['content-encoding'] || headers.cookie || headers.expect) return reject(400);
    const length = one('content-length');
    if (verify && ((headers['content-length'] && length !== '0') || headers['content-type'])) return reject(400);
    if (step && (one('content-type') !== JSON_TYPE || !/^[1-9][0-9]{0,2}$/.test(length ?? ''))) return reject(400);
    if (+length > LIMIT) return reject(413);
    const signature = one(MAC);
    if (!HEX_MAC.test(signature ?? '')) return reject(401);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > LIMIT || (verify && size)) return res.destroy();
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      const body = raw.toString('utf8');
      if (!raw.equals(Buffer.from(body)) || size !== (step ? +length : 0)) return reject(400);
      if (!equalMac(signature, mac(key, 'egdesk-request-v1', req.method, req.url, origin, body))) return reject(401);
      let value = { catalog };
      if (step) {
        let data;
        try { data = JSON.parse(body); } catch { return reject(400); }
        if (!data || Array.isArray(data) || typeof data !== 'object') return reject(400);
        const { type, from, to } = data;
        // Canonical fields also reject duplicate keys, unknown keys and ambiguous JSON.
        if (![type, from, to].every(field => typeof field === 'string') ||
            body !== JSON.stringify({ type, from, to })) return reject(400);
        value = reduce({ type, from, to });
        if (!value) return reject(422);
      }
      const output = JSON.stringify(value);
      res.setHeader('Content-Type', JSON_TYPE);
      res.setHeader('Content-Length', Buffer.byteLength(output));
      res.setHeader(MAC, mac(key, 'egdesk-response-v1', signature, output));
      res.end(output);
    } catch {
      if (!res.destroyed) res.destroy();
    }
  });
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 1;
  server.setTimeout(1500, socket => socket.destroy());
  server.on('checkContinue', (_req, res) => { res.writeHead(417, { Connection: 'close' }); res.end(); });
  server.on('checkExpectation', (_req, res) => { res.writeHead(417, { Connection: 'close' }); res.end(); });
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());
  function cleanup() {
    if (!identity) return;
    try {
      const st = lstatSync(file);
      if (st.dev === identity.dev && st.ino === identity.ino) unlinkSync(file);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('egdesk-team-apps: could not remove descriptor');
    }
    identity = undefined;
  }
  function close() { cleanup(); server.close(); server.closeAllConnections(); }
  process.once('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, close);
  server.on('error', () => { close(); process.exitCode = 1; console.error('egdesk-team-apps: loopback startup failed'); });
  server.listen({ host: '127.0.0.1', port: +portArg, exclusive: true }, () => {
    host = `127.0.0.1:${server.address().port}`;
    origin = `http://${host}`;
    try {
      identity = publish(file, { origin, secret: key.toString('hex') });
      process.stdout.write(JSON.stringify({ready:true,pid:process.pid})+'\n');
    } catch {
      close(); process.exitCode = 1; console.error('egdesk-team-apps: descriptor creation failed');
    }
  });
}

main().catch((err) => {
  const message = err.code ? 'descriptor path unavailable' : err.message;
  console.error(`egdesk-team-apps: ${message}`);
  process.exitCode = 1;
});
