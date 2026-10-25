// Data-only fixture: real Profile/Desk HTTP handlers and SQLite stores.
// No listener, provider, shell, picker, profile activation or room assignment.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { openProfileStore } from '../helper/egdesk-profile-store.mjs';
import { openDeskStore } from '../helper/egdesk-desk-store.mjs';
import { createProfileHttpHandler } from '../helper/egdesk-profile-http.mjs';
import { createDeskHttpHandler } from '../helper/egdesk-desk-http.mjs';
import { exportAgentFile } from '../helper/egdesk-profile-file.mjs';
import { guardBridgeRequest, sendJson, setBridgeCors } from '../helper/codex-bridge-http.mjs';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { createPrivateQaTempDirectory, isOwnedAndPrivate } from './egdesk-qa-platform.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const STATE_ROUTE = '/__qa/portable-transfer/state';
const TRACE_LIMIT = 256;
const IMPORT_TRACE_BYTES = 128 * 1024;
const PROFILE = '[a-z0-9][a-z0-9-]{0,79}';
const BOARD = '[A-Za-z0-9][A-Za-z0-9._-]{0,127}';
const GET_PROFILE = new RegExp(`^/profiles(?:/(?:tool-presets|${PROFILE}(?:/revisions(?:/[1-9]\\d{0,8})?|/export)?))?$`);
const GET_BOARD = new RegExp(`^/v1/boards(?:/${BOARD}(?:/export)?)?$`);
const failure = (code, message, httpStatus = 403) => Object.assign(new Error(message), { code, httpStatus });

export function portableTransferFixtureEnabled(env = process.env) {
  const flag = env.EGDESK_QA_PORTABLE_TRANSFER_FIXTURE;
  if (flag == null || flag === '0') return false;
  if (flag !== '1') throw failure('QA_PORTABLE_OPT_IN', 'Portable-transfer fixture flag must be 0 or 1');
  if (env.EGDESK_QA_FIXTURE_TRANSPORT !== '1' || env.EGDESK_QA_REAL_TURN !== '0') {
    throw failure('QA_PORTABLE_OPT_IN', 'Portable transfer requires isolated fixture transport and REAL_TURN=0');
  }
  for (const [key, value] of Object.entries(env)) {
    const otherMode = /^EGDESK_QA_.*_FIXTURE$/.test(key) && key !== 'EGDESK_QA_PORTABLE_TRANSFER_FIXTURE'
      || ['EGDESK_QA_BROWSER_NEGATIVE', 'EGDESK_QA_BROWSER_RELAY'].includes(key);
    if (otherMode && value != null && value !== '' && value !== '0') {
      throw failure('QA_PORTABLE_MODE_CONFLICT', `Portable transfer excludes ${key}`);
    }
  }
  return true;
}

function configuration(env) {
  assert.equal(portableTransferFixtureEnabled(env), true, 'Explicit portable-transfer fixture opt-in is required');
  const value = env.EGDESK_QA_FIXTURE_PORT;
  assert.ok(typeof value === 'string' && /^[1-9][0-9]{0,4}$/.test(value) && Number(value) <= 65535 && Number(value) !== 39218,
    'Explicit nonproduction EGDESK_QA_FIXTURE_PORT is required');
  return { host: '127.0.0.1', port: Number(value), origin: `http://127.0.0.1:${value}` };
}

function privateFile(filename) {
  const info = fs.lstatSync(filename);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && fs.realpathSync.native(filename) === filename &&
    isOwnedAndPrivate(filename, info, 0o077), 'Owned portable fixture files must remain private, canonical and unlinked');
}

export function createPortableTransferFixture({ profile, token, env = process.env } = {}) {
  // All opt-in/manifest/token checks precede any new directory or database.
  const config = configuration(env);
  assert.ok(typeof token === 'string' && token.length >= 16, 'Owned fixture token is required');
  if (env.EGDESK_QA_FIXTURE_TOKEN != null) assert.equal(token, env.EGDESK_QA_FIXTURE_TOKEN, 'Canonical fixture token mismatch');
  const manifest = assertQaFixtureManifest(profile);
  // The shared Windows private-directory helper launches an ACL utility. This
  // bounded no-process lane intentionally does not enable that platform yet.
  assert.notEqual(process.platform, 'win32', 'Portable fixture no-process lane is not enabled on Windows');
  const root = createPrivateQaTempDirectory('egdesk-portable-transfer-');
  const dataDir = path.join(root, 'store'), filesDir = path.join(root, 'files'), exportsDir = path.join(root, 'exports');
  for (const directory of [dataDir, filesDir, exportsDir]) fs.mkdirSync(directory, { mode: 0o700 });
  let profiles, desk;
  try {
    const scope = `qa-portable-transfer:${randomUUID()}`;
    profiles = openProfileStore({ dataDir, ownerHash: scope });
    desk = openDeskStore({ dataDir, ownerScope: scope, now: () => Date.parse('2026-10-25T00:00:00Z'), utcOffsetMinutes: 0 });
    const marker = `QA_PORTABLE_${randomUUID().replaceAll('-', '')}`;
    const revision1 = profiles.createDraft({ name: 'Owned QA portable profile', role: 'Portable fixture only',
      instructions: `${marker}_REVISION_1\nRead the owned sample; do not execute commands.`,
      toolCeiling: { browser: 'none', files: 'read', terminal: 'none', network: 'off', mcp: 'none' } });
    profiles.saveDraft(revision1.id, { ...revision1.profile.head.body,
      instructions: `${marker}_REVISION_2\nThis later draft must not replace a pinned earlier export.` }, 1);
    const importFilename = 'owned-portable-import.md';
    const importText = ['---', 'name: owned-portable-import', 'description: Owned QA import, never activated.',
      'tools: Read, Grep, Glob', '---', `${marker}_IMPORT_ORIGINAL`, 'Inspect this owned sample without running anything.', ''].join('\n');
    const importPath = path.join(filesDir, importFilename);
    fs.writeFileSync(importPath, importText, { flag: 'wx', mode: 0o600 });
    const boardId = `qa-portable-board-${randomUUID()}`, title = 'Owned QA portable Board';
    const boardBody = { version: 1, savedAt: Date.parse('2026-10-25T00:00:00Z'),
      agenda: { id: boardId, title, memberCardIds: ['qa-result', 'qa-file'] },
      cards: [
        { id: 'qa-result', type: 'result', geometry: { x: 20, y: 30, width: 320, height: 180, zIndex: 1 },
          runtimeState: { title: 'Saved QA result', text: `${marker}_SAVED_BOARD_HEAD` } },
        { id: 'qa-file', type: 'file', geometry: { x: 400, y: 30, width: 240, height: 180, zIndex: 2 },
          sourceRef: { path: importPath }, runtimeState: { root: { name: 'Owned import sample', displayPath: filesDir } } },
      ], shapes: [] };
    desk.saveBoard(boardId, { body: boardBody, expectedRevision: null, title });
    const databases = { profiles: path.join(dataDir, `profiles-${profiles.ownerHash}.sqlite`),
      desk: path.join(dataDir, `desk-${desk.ownerScopeHash}.sqlite`) };
    const seed = { profileId: revision1.id, boardId, marker, importFilename, importPath, importText, importSha256: sha256(importText),
      revisions: [1, 2].map(revision => {
        const source = profiles.exportRevision(revision1.id, revision);
        return { revision, hash: source.hash, body: source.body,
          exports: Object.fromEntries(['md', 'codex-toml'].map(format => {
            const exported = exportAgentFile(source.body, format);
            return [format, { ...exported, sha256: sha256(exported.text), bytes: Buffer.byteLength(exported.text) }];
          })) };
      }) };
    const persisted = () => {
      const read = (filename, inspect) => {
        privateFile(filename);
        const db = new DatabaseSync(filename, { readOnly: true });
        try { return inspect(db); } finally { db.close(); }
      };
      return {
        profiles: read(databases.profiles, db => ({
          records: db.prepare('SELECT id, active_revision, lifecycle, origin, source_json FROM profiles ORDER BY id').all().map(row => ({ ...row })),
          revisions: db.prepare('SELECT profile_id, revision, parent_revision, hash, body_json FROM profile_revisions ORDER BY profile_id, revision').all().map(row => ({ ...row })),
        })),
        desk: read(databases.desk, db => ({
          boards: db.prepare('SELECT board_id, title, head_revision, metadata_version, lifecycle FROM boards ORDER BY board_id').all().map(row => ({ ...row })),
          revisions: db.prepare('SELECT board_id, revision, parent_revision, hash, body_json FROM board_revisions ORDER BY board_id, revision').all().map(row => ({ ...row })),
          generations: db.prepare('SELECT generation, state_hash FROM desk_generations ORDER BY generation').all().map(row => ({ ...row })),
        })),
      };
    };
    const initial = persisted();
    const profileHandler = createProfileHttpHandler({ store: () => profiles, port: config.port });
    const deskHandler = createDeskHttpHandler({ store: () => desk, port: config.port });
    const requests = [], forbiddenPosts = [];
    let disposed = false, sequence = 0;
    const snapshot = () => {
      privateFile(importPath);
      return { kind: 'egdesk-portable-transfer-fixture', profile: manifest.profile, ...config, root, dataDir, filesDir, exportsDir, databases,
        seed: structuredClone(seed), initial: structuredClone(initial), persisted: persisted(), disposed,
        currentImportSha256: sha256(fs.readFileSync(importPath)), requests: structuredClone(requests), forbiddenPosts: structuredClone(forbiddenPosts),
        providerTurns: 0, nativePickerInvocations: 0, nativeProcessSpawns: 0,
        actual: ['Profile HTTP handler', 'Desk HTTP handler', 'Profile/Desk SQLite', 'owned Markdown input bytes'],
        unverified: ['native UI', 'picker result boundary', 'native export-file write', 'provider execution'] };
    };
    async function handle(req, res, suppliedUrl) {
      const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      let url;
      try { url = new URL(req.url, config.origin); } catch { return false; }
      const route = url.pathname;
      const ownedRoute = route === STATE_ROUTE || /^\/(?:profiles(?:\/|$)|v1\/(?:boards|desk)(?:\/|$)|terminal(?:\/|$)|providers?(?:\/|$)|records?(?:\/|$)|rooms?(?:\/|$))/.test(route);
      if (!ownedRoute && !mutation) return false;
      let entry;
      try {
        if (requests.length >= TRACE_LIMIT) throw failure('QA_TRACE_LIMIT', 'Bounded portable fixture trace is full', 429);
        entry = { sequence: ++sequence, method: req.method, path: route, query: url.search, delegated: false, status: null };
        requests.push(entry);
        if (disposed) throw failure('QA_FIXTURE_CLOSED', 'Portable fixture is closed', 503);
        if (!guardBridgeRequest(req, config.port) || url.origin !== config.origin || suppliedUrl && suppliedUrl.href !== url.href) {
          throw failure('QA_LOOPBACK_REQUIRED', 'Owned loopback fixture request required');
        }
        setBridgeCors(req, res);
        if (route === STATE_ROUTE) {
          if (req.method !== 'GET' || url.search) throw failure('QA_METHOD', 'State is read-only', 405);
          if (req.headers['x-egdesk-qa-token'] !== token) throw failure('QA_TOKEN_REQUIRED', 'Fixture control token required');
          entry.status = 200; sendJson(res, 200, snapshot()); return true;
        }
        const profileRoute = req.method === 'GET' && GET_PROFILE.test(route) || req.method === 'POST' && route === '/profiles/import';
        const boardRoute = req.method === 'GET' && GET_BOARD.test(route);
        if (!profileRoute && !boardRoute) throw failure('QA_PORTABLE_ROUTE_BLOCKED', 'Only profile reads/import and saved Board reads/export are permitted');
        if (req.method === 'POST' && url.search) throw failure('QA_PORTABLE_ROUTE_BLOCKED', 'Profile import has no fixture query controls');
        entry.before = persisted();
        // Observe the very bytes consumed by the actual handler. Do not replace
        // its parser, store result or HTTP success envelope with fixture data.
        const chunks = []; let bytes = 0;
        const input = Readable.from((async function* () {
          for await (const part of req) {
            const chunk = Buffer.from(part); bytes += chunk.length;
            if (bytes <= IMPORT_TRACE_BYTES) chunks.push(chunk);
            yield chunk;
          }
        })());
        Object.assign(input, { method: req.method, url: req.url, headers: req.headers, socket: req.socket });
        const response = {
          writeHead(status, headers) { entry.status = status; return res.writeHead(status, headers); },
          end(body) {
            entry.responseSha256 = sha256(body);
            entry.response = JSON.parse(body);
            return res.end(body);
          },
        };
        entry.delegated = true;
        const handled = await (profileRoute ? profileHandler : deskHandler)(input, response, url);
        assert.equal(handled, true, 'Allowlisted route must be owned by the real handler');
        const raw = Buffer.concat(chunks);
        entry.requestBytes = bytes; entry.requestTruncated = bytes > IMPORT_TRACE_BYTES;
        if (!entry.requestTruncated) {
          entry.requestSha256 = sha256(raw);
          try {
            const body = JSON.parse(raw.toString('utf8'));
            entry.request = { ...(Object.hasOwn(body, 'dryRun') ? { dryRun: body.dryRun } : {}),
              ...(Object.hasOwn(body, 'filename') ? { filename: body.filename } : {}),
              ...(typeof body.text === 'string' ? { textSha256: sha256(body.text), textBytes: Buffer.byteLength(body.text) } : {}) };
          } catch { /* Real handler records invalid JSON; do not invent a body. */ }
        }
        entry.after = persisted();
        if (req.method === 'POST' && entry.status >= 400) {
          forbiddenPosts.push({ sequence: entry.sequence, path: route, code: entry.response?.code || 'PROFILE_ERROR' });
        }
        return true;
      } catch (cause) {
        const status = cause.httpStatus || 500;
        if (entry) {
          entry.status = status; entry.code = cause.code || 'QA_PORTABLE_ERROR';
          if (req.method === 'POST') forbiddenPosts.push({ sequence: entry.sequence, path: route, code: entry.code });
        }
        sendJson(res, status, { code: cause.code || 'QA_PORTABLE_ERROR', error: cause.message });
        return true;
      }
    }
    return { handle, snapshot, dispose() { if (!disposed) { disposed = true; profiles.close(); desk.close(); } } };
  } catch (cause) {
    profiles?.close(); desk?.close();
    throw new Error(`${cause.message}; owned portable fixture preserved at ${root}`, { cause });
  }
}
