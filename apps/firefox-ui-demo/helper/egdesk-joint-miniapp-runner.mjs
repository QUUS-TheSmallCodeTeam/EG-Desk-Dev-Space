import { createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';

const TYPES = Object.freeze(['shipment', 'inspection']);
const STATES = { shipment: ['ready', 'picked', 'delivered'], inspection: ['waiting', 'pass', 'hold'] };
const SIGNATURE = 'x-egdesk-signature';
const HEX_MAC = /^[a-f0-9]{64}$/;
const JSON_TYPE = 'application/json';
const LIMIT = 256;
const TIMEOUT = 2000;
const agent = new Agent({ keepAlive: false }); // Do not use the proxy-configurable global agent.

function readDescriptor(file) {
  if (typeof process.getuid !== 'function' || typeof file !== 'string' || !isAbsolute(file) ||
      file.endsWith('/') || ['.', '..'].includes(basename(file)) || normalize(file) !== file) {
    throw Error('Expected an absolute runner descriptor path');
  }
  const uid = process.getuid();
  const path = dirname(file);
  const source = lstatSync(path);
  const canonical = realpathSync(path);
  const parent = lstatSync(canonical);
  if (!source.isDirectory() || source.dev !== parent.dev || source.ino !== parent.ino ||
      parent.uid !== uid || (parent.mode & 0o7777) !== 0o700) {
    throw Error('Runner descriptor directory must be owner-only (0700)');
  }
  for (let dir = canonical;; dir = dirname(dir)) {
    const st = lstatSync(dir);
    if (!st.isDirectory() || (st.uid !== uid && st.uid !== 0) ||
        ((st.mode & 0o022) && !(st.mode & 0o1000))) throw Error('Unsafe runner descriptor directory ancestry');
    if (dir === dirname(dir)) break;
  }

  const fd = openSync(join(canonical, basename(file)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== uid || (st.mode & 0o7777) !== 0o600 || st.size < 1 || st.size > LIMIT) {
      throw Error('Runner descriptor must be an owner-only (0600) regular file');
    }
    const buf = Buffer.alloc(LIMIT + 1);
    let size = 0;
    for (let n; size < buf.length && (n = readSync(fd, buf, size, buf.length - size, null));) size += n;
    const raw = buf.toString('utf8', 0, size);
    const match = /^\{"origin":"http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})","secret":"([a-f0-9]{64})"\}$/.exec(raw);
    if (size !== st.size || !match || match[0] !== raw || +match[1] > 65535) throw Error('Invalid runner descriptor');
    return { port: +match[1], key: Buffer.from(match[2], 'hex') };
  } finally {
    closeSync(fd);
  }
}

export function loadTeamApps(file) {
  const { port, key } = readDescriptor(file);
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const mac = (...parts) => createHmac('sha256', key).update(parts.join('\n')).digest('hex');

  function exchange(method, path, body, expected, signal) {
    const expectedBody = JSON.stringify(expected);
    const signature = mac('egdesk-request-v1', method, path, origin, body);
    const expectedMac = Buffer.from(mac('egdesk-response-v1', signature, expectedBody), 'hex');
    const timeout = AbortSignal.timeout(TIMEOUT);
    const abort = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    return new Promise((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1', family: 4, port, method, path, agent, maxHeaderSize: 4096, signal: abort,
        headers: { Host: host, Origin: origin, Connection: 'close', [SIGNATURE]: signature,
          ...(body ? { 'Content-Type': JSON_TYPE, 'Content-Length': Buffer.byteLength(body) } : {}) },
      }, async res => {
        const headers = res.headersDistinct;
        const one = (name) => headers[name]?.length === 1 ? headers[name][0] : undefined;
        const fail = (message) => { res.destroy(); reject(Error(message)); };
        if (res.statusCode !== 200) return fail(`Runner returned HTTP ${res.statusCode}`);
        const length = Buffer.byteLength(expectedBody);
        const receivedMac = one(SIGNATURE);
        if (one('content-type') !== JSON_TYPE || one('content-length') !== String(length) ||
            headers['transfer-encoding'] || headers['content-encoding'] || headers['set-cookie'] ||
            !HEX_MAC.test(receivedMac ?? '') || !timingSafeEqual(Buffer.from(receivedMac, 'hex'), expectedMac)) {
          return fail('Invalid runner response headers or signature');
        }
        try {
          let size = 0;
          const chunks = [];
          for await (const chunk of res) {
            size += chunk.length;
            if (size > length) return fail('Oversized runner response');
            chunks.push(chunk);
          }
          if (!res.complete || !Buffer.concat(chunks).equals(Buffer.from(expectedBody))) {
            return fail('Invalid runner response body');
          }
          resolve(expected);
        } catch (err) { reject(err); }
      });
      req.on('error', reject);
      req.end(body || undefined);
    });
  }

  return Object.freeze({
    catalog: TYPES,
    async verify() {
      await exchange('GET', '/v1/catalog', '', { catalog: TYPES });
      return true;
    },
    async step(input, { signal } = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Reflect.ownKeys(input).length !== 3 ||
          !['type', 'from', 'to'].every(field => Object.hasOwn(input, field))) throw Error('Invalid runner step fields');
      const { type, from, to } = input;
      if (!TYPES.includes(type) || !STATES[type].includes(from) || !STATES[type].includes(to)) {
        throw Error('Invalid runner step values');
      }
      return exchange('POST', '/v1/step', JSON.stringify({ type, from, to }), { type, state: to }, signal);
    },
  });
}
