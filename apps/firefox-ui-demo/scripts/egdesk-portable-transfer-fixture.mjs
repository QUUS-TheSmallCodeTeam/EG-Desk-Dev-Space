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
import { guardBridgeRequest, sendJson, setBridgeCors, readJsonBody } from '../helper/codex-bridge-http.mjs';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { createPrivateQaTempDirectory, isOwnedAndPrivate } from './egdesk-qa-platform.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const STATE_ROUTE = '/__qa/portable-transfer/state';
const CONTROL_ROUTE = '/__qa/portable-transfer/control';
const PICKER_ROUTE = '/__qa/portable-transfer/picker';
const TRACE_LIMIT = 256;
const IMPORT_TRACE_BYTES = 128 * 1024;
const BOARD_CATALOG_PREF = 'egdesk.agendaState.v1';
const PROFILE = '[a-z0-9][a-z0-9-]{0,79}';
const BOARD = '[A-Za-z0-9][A-Za-z0-9._-]{0,127}';
const GET_PROFILE = new RegExp(`^/profiles(?:/(?:tool-presets|${PROFILE}(?:/revisions(?:/[1-9]\\d{0,8})?|/export)?))?$`);
const POST_DUPLICATE = new RegExp(`^/profiles/(${PROFILE})/duplicate$`);
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

function unusedCatalogTarget(profile) {
  for (const name of ['parent.lock', '.parentlock', 'lock', 'compatibility.ini', 'times.json', 'places.sqlite',
    'cookies.sqlite', 'sessionstore.jsonlz4', 'sessionstore-backups', 'startupCache', 'prefs.js']) {
    assert.equal(fs.existsSync(path.join(profile, name)) || !!fs.lstatSync(path.join(profile, name), { throwIfNoEntry: false }),
      false, `Portable Board catalog requires a new unused profile (${name})`);
  }
  const userPrefs = path.join(profile, 'user.js');
  if (fs.existsSync(userPrefs)) {
    privateFile(userPrefs);
    assert.equal(fs.readFileSync(userPrefs, 'utf8').includes(BOARD_CATALOG_PREF), false, 'No competing Board catalog preference');
  }
  return path.join(profile, 'prefs.js');
}

// Call before Firefox starts. Later prefs writes are normal product behavior,
// not a reason to rewrite or restore this fixture seed in a running profile.
export function assertPortableBoardCatalogSeed(state) {
  const proof = state.catalogSeed;
  assert.equal(proof?.kind, 'owned-prelaunch-board-catalog-v1');
  assert.equal(proof.path, path.join(state.profile, 'prefs.js'));
  privateFile(proof.path);
  const bytes = fs.readFileSync(proof.path, 'utf8');
  assert.equal(sha256(bytes), proof.sha256, 'Board catalog seed bytes changed before launch');
  const match = bytes.match(/^user_pref\("egdesk\.agendaState\.v1", ("(?:[^"\\]|\\.)*")\);$/m);
  assert.ok(match, 'One literal Board catalog seed required');
  const catalog = JSON.parse(JSON.parse(match[1]));
  assert.deepEqual(Object.keys(catalog.agendas), [state.seed.boardId]);
  const row = state.persisted.desk.revisions.find(row => row.board_id === state.seed.boardId && row.revision === proof.sqliteRevision);
  const head = state.persisted.desk.boards.find(row => row.board_id === state.seed.boardId);
  assert.equal(head.head_revision, 1); assert.equal(proof.sqliteRevision, 1);
  assert.equal(row.hash, proof.sqliteHash); assert.equal(proof.boardId, state.seed.boardId);
  assert.deepEqual(catalog.agendas[proof.boardId], JSON.parse(row.body_json), 'Catalog and real saved SQLite Board have the same content');
  assert.equal(sha256(JSON.stringify(catalog.agendas[proof.boardId])), proof.bodySha256);
  assert.equal(catalog.meta[proof.boardId].title, head.title);
  return true;
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
  const catalogPath = unusedCatalogTarget(manifest.profile);
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
      'tools: Read, Grep, Glob', '---', `${marker}_IMPORT_ORIGINAL`,
      ...Array.from({ length: 36 }, (_, index) => `Owned instruction ${index + 1}: inspect this sample without executing, activating or assigning anything.`),
      `${marker}_IMPORT_END`, ''].join('\n');
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
    const deskState = { version: 1, savedAt: Date.parse('2026-10-25T00:00:00Z'), cards: [], shapes: [], qaMarker: `${marker}_INITIAL_DESK` };
    const deskSeed = desk.saveCurrent({ state: deskState, parentGeneration: null, reason: 'explicit' });
    const databases = { profiles: path.join(dataDir, `profiles-${profiles.ownerHash}.sqlite`),
      desk: path.join(dataDir, `desk-${desk.ownerScopeHash}.sqlite`) };
    const seed = { profileId: revision1.id, boardId, marker, importFilename, importPath, importText, importSha256: sha256(importText),
      deskState, deskGeneration: deskSeed.generation,
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
    const catalog = { version: 2, updatedAt: boardBody.savedAt, activeAgendaId: boardId,
      agendas: { [boardId]: boardBody }, meta: { [boardId]: { id: boardId, title, createdAt: boardBody.savedAt, updatedAt: boardBody.savedAt } } };
    const catalogBytes = `// Explicit owned prelaunch portable Board catalog fixture, not UI-created evidence.\nuser_pref(${JSON.stringify(BOARD_CATALOG_PREF)}, ${JSON.stringify(JSON.stringify(catalog))});\n`;
    unusedCatalogTarget(manifest.profile);
    fs.writeFileSync(catalogPath, catalogBytes, { flag: 'wx', mode: 0o600 });
    const catalogSeed = { kind: 'owned-prelaunch-board-catalog-v1', path: catalogPath, sha256: sha256(catalogBytes),
      boardId, bodySha256: sha256(JSON.stringify(boardBody)), sqliteRevision: initial.desk.boards[0].head_revision,
      sqliteHash: initial.desk.revisions[0].hash, setupOnly: true };
    assertPortableBoardCatalogSeed({ profile: manifest.profile, seed, persisted: initial, catalogSeed });
    catalogSeed.coherentBeforeLaunch = true;
    const profileHandler = createProfileHttpHandler({ store: () => profiles, port: config.port });
    const deskHandler = createDeskHttpHandler({ store: () => desk, port: config.port });
    const requests = [], forbiddenPosts = [], pickerResults = [], headAdvances = [], duplicateEvents = [], receiptFaults = [];
    let duplicateReceiptFault = null;
    let queuedPicker = null;
    let disposed = false, sequence = 0;
    const exportFiles = () => {
      const names = fs.readdirSync(exportsDir);
      assert.ok(names.length <= 24, 'Portable export evidence is bounded');
      return names.sort().map(name => {
        const filename = path.join(exportsDir, name), info = fs.lstatSync(filename);
        // Gecko owns the actual create/write. The enclosing QA directory is
        // private even when a native new file uses the platform's normal mode.
        assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 &&
          fs.realpathSync.native(filename) === filename && info.uid === process.getuid() && info.size <= 1024 * 1024,
        'Export evidence must be one owned canonical regular file');
        return { name, path: filename, bytes: info.size, sha256: sha256(fs.readFileSync(filename)), mode: info.mode & 0o777 };
      });
    };
    const snapshot = () => {
      privateFile(importPath);
      return { kind: 'egdesk-portable-transfer-fixture', profile: manifest.profile, ...config, root, dataDir, filesDir, exportsDir, databases,
        seed: structuredClone(seed), catalogSeed: structuredClone(catalogSeed), initial: structuredClone(initial), persisted: persisted(), disposed,
        currentImportSha256: sha256(fs.readFileSync(importPath)), requests: structuredClone(requests), forbiddenPosts: structuredClone(forbiddenPosts),
        queuedPicker: structuredClone(queuedPicker), pickerResults: structuredClone(pickerResults),
        headAdvances: structuredClone(headAdvances), duplicateEvents: structuredClone(duplicateEvents), exports: exportFiles(),
        duplicateReceiptFault: structuredClone(duplicateReceiptFault), receiptFaults: structuredClone(receiptFaults),
        deskReadiness: { storeOpen: !disposed, seedGeneration: seed.deskGeneration,
          currentReads: requests.filter(row => row.method === 'GET' && row.path === '/v1/desk/current' && row.status === 200).length },
        providerTurns: 0, nativePickerInvocations: 0, nativeProcessSpawns: 0,
        actual: ['Profile HTTP handler', 'Desk HTTP handler', 'Profile/Desk SQLite', 'owned Markdown input bytes'],
        unverified: ['native UI', 'picker result boundary', 'native export-file write', 'provider execution'] };
    };
    async function handle(req, res, suppliedUrl) {
      const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      let url;
      try { url = new URL(req.url, config.origin); } catch { return false; }
      const route = url.pathname;
      const controlRoute = [STATE_ROUTE, CONTROL_ROUTE, PICKER_ROUTE].includes(route);
      const ownedRoute = controlRoute || /^\/(?:profiles(?:\/|$)|v1\/(?:boards|desk)(?:\/|$)|terminal(?:\/|$)|providers?(?:\/|$)|records?(?:\/|$)|rooms?(?:\/|$))/.test(route);
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
        if (controlRoute && url.search) throw failure('QA_METHOD', 'Fixture controls accept no URL parameters', 400);
        if (controlRoute && req.method === 'OPTIONS') { entry.status = 204; res.writeHead(204); res.end(); return true; }
        if (route === STATE_ROUTE) {
          if (req.method !== 'GET' || url.search) throw failure('QA_METHOD', 'State is read-only', 405);
          if (req.headers['x-egdesk-qa-token'] !== token) throw failure('QA_TOKEN_REQUIRED', 'Fixture control token required');
          entry.status = 200; sendJson(res, 200, snapshot()); return true;
        }
        if (route === CONTROL_ROUTE || route === PICKER_ROUTE) {
          if (req.method !== 'POST') throw failure('QA_METHOD', 'Fixture control requires POST', 405);
          if (route === CONTROL_ROUTE && req.headers['x-egdesk-qa-token'] !== token) {
            throw failure('QA_TOKEN_REQUIRED', 'Fixture control token required');
          }
          if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw failure('QA_BODY', 'JSON body required', 415);
          const body = await readJsonBody(req, { maxBytes: 2048 });
          const exactKeys = keys => body && typeof body === 'object' && !Array.isArray(body) &&
            Object.keys(body).length === keys.length && keys.every(key => Object.hasOwn(body, key));
          if (route === CONTROL_ROUTE) {
            if (body?.operation === 'arm-duplicate-receipt-fault') {
              if (!exactKeys(['operation', 'profileId', 'revision', 'hash']) || duplicateReceiptFault ||
                  body.profileId !== seed.profileId || !Number.isSafeInteger(body.revision) || body.revision < 1 || body.revision > 999999999 ||
                  typeof body.hash !== 'string' || !/^[a-f0-9]{64}$/.test(body.hash)) {
                throw failure('QA_RECEIPT_FAULT', 'One exact original-profile receipt fault may be armed once', 409);
              }
              const source = profiles.exportRevision(body.profileId, body.revision);
              if (source.hash !== body.hash) throw failure('QA_RECEIPT_FAULT', 'Saved revision hash must match', 409);
              entry.request = structuredClone(body); entry.requestSha256 = sha256(JSON.stringify(body));
              duplicateReceiptFault = { state: 'armed', armSequence: entry.sequence, profileId: body.profileId,
                revision: body.revision, hash: body.hash };
              entry.status = 200; sendJson(res, 200, { ...duplicateReceiptFault }); return true;
            }
            if (body?.operation === 'queue-picker') {
              const hasFilename = Object.hasOwn(body, 'filename');
              if (!exactKeys(['operation', 'kind', 'result', ...(hasFilename ? ['filename'] : [])]) || queuedPicker ||
                  !['open', 'save'].includes(body.kind) ||
                  !(body.result === 'cancel' && !hasFilename || body.kind === 'open' && body.result === 'input' && !hasFilename ||
                    body.kind === 'save' && ['path', 'replace'].includes(body.result) && hasFilename &&
                    typeof body.filename === 'string' && /^[a-z0-9][a-z0-9-]{0,59}\.(?:md|toml|canvas)$/.test(body.filename))) {
                throw failure('QA_PICKER_QUEUE', 'One exact owned picker result is required', 409);
              }
              if (body.result === 'replace' && !exportFiles().some(file => file.name === body.filename)) {
                throw failure('QA_PICKER_QUEUE', 'Replace result requires an existing owned export', 409);
              }
              queuedPicker = { kind: body.kind, result: body.result, ...(hasFilename ? { filename: body.filename } : {}) };
              entry.status = 200; sendJson(res, 200, { queued: true }); return true;
            }
            if (body?.operation === 'advance-profile-head' && exactKeys(['operation', 'expectedHeadRevision']) &&
                body.expectedHeadRevision === 2 && headAdvances.length === 0) {
              entry.before = persisted();
              const prior = profiles.exportRevision(seed.profileId, 2);
              const saved = profiles.saveDraft(seed.profileId, { ...prior.body,
                instructions: `${marker}_REVISION_3\nA later owned draft; the visible revision must stay pinned.` }, 2);
              entry.after = persisted();
              const receipt = { sequence: entry.sequence, profileId: seed.profileId, previousRevision: 2,
                revision: saved.revision, hash: saved.hash };
              headAdvances.push(receipt); entry.status = 200; sendJson(res, 200, receipt); return true;
            }
            throw failure('QA_CONTROL', 'Unsupported portable fixture control', 400);
          }
          const open = body?.kind === 'open';
          if (!(open ? exactKeys(['kind', 'accept']) && body.accept === '.md' :
            body?.kind === 'save' && exactKeys(['kind', 'fileName', 'contentType']) && typeof body.fileName === 'string' &&
            body.fileName.length > 0 && body.fileName.length <= 255 && !/[/\\\u0000-\u001f]/.test(body.fileName) &&
            ['application/json; charset=utf-8', 'text/markdown; charset=utf-8', 'application/toml; charset=utf-8'].includes(body.contentType))) {
            throw failure('QA_PICKER_INPUT', 'Unexpected native picker request', 400);
          }
          if (!queuedPicker || queuedPicker.kind !== body.kind) throw failure('QA_PICKER_UNARMED', 'No owned result armed for this picker', 409);
          const selected = queuedPicker; queuedPicker = null;
          const packet = { kind: 'egdesk-portable-picker-result', operation: body.kind, synthetic: true,
            ...(selected.result === 'replace' ? { error: 'EEXIST' } : { result: selected.result === 'cancel' ? { cancelled: true } :
              selected.result === 'input' ? { path: importPath, filename: importFilename } :
                { path: path.join(exportsDir, selected.filename), filename: selected.filename } }) };
          pickerResults.push({ sequence: entry.sequence, request: body, ...packet });
          entry.status = 200; sendJson(res, 200, packet); return true;
        }
        const duplicateMatch = req.method === 'POST' ? POST_DUPLICATE.exec(route) : null;
        const profileRoute = req.method === 'GET' && GET_PROFILE.test(route) || req.method === 'POST' && route === '/profiles/import' || !!duplicateMatch;
        const boardRoute = req.method === 'GET' && (GET_BOARD.test(route) || route === '/v1/desk/current');
        if (!profileRoute && !boardRoute) throw failure('QA_PORTABLE_ROUTE_BLOCKED', 'Only profile reads/import/duplicate and saved Board reads/export are permitted');
        if (req.method === 'POST' && url.search) throw failure('QA_PORTABLE_ROUTE_BLOCKED', 'Profile mutations have no fixture query controls');
        entry.before = persisted();
        // The optional fault buffers only the armed original's duplicate reply.
        // Parser/auth/store still run unchanged; only an exact real 201 receipt
        // may be malformed after SQLite and the actual event are recorded.
        const armedFault = duplicateMatch && duplicateReceiptFault?.state === 'armed' &&
          duplicateMatch[1] === duplicateReceiptFault.profileId ? duplicateReceiptFault : null;
        let bufferedHeaders, bufferedBody;
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
          writeHead(status, headers) { entry.status = status;
            if (armedFault) { bufferedHeaders = headers; return; }
            return res.writeHead(status, headers); },
          end(body) {
            entry.responseSha256 = sha256(body);
            entry.response = JSON.parse(body);
            if (armedFault) { bufferedBody = body; return; }
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
              ...(duplicateMatch && Object.hasOwn(body, 'revision') ? { revision: body.revision } : {}),
              ...(duplicateMatch && Object.hasOwn(body, 'name') ? { name: body.name } : {}),
              ...(typeof body.text === 'string' ? { textSha256: sha256(body.text), textBytes: Buffer.byteLength(body.text) } : {}) };
          } catch { /* Real handler records invalid JSON; do not invent a body. */ }
        }
        entry.after = persisted();
        if (duplicateMatch && entry.status === 201) {
          // Evidence from the real handler response; never a substitute DTO or
          // another store write. before/after retain the matching SQLite proof.
          const created = entry.response, source = created?.profile?.source?.at(-1);
          duplicateEvents.push({ sequence: entry.sequence, sourceProfileId: duplicateMatch[1],
            sourceRevision: source?.revision, sourceHash: source?.hash,
            profileId: created?.id, revision: created?.revision, hash: created?.hash,
            name: created?.profile?.head?.body?.name, lifecycle: created?.profile?.lifecycle,
            activeRevision: created?.profile?.activeRevision });
        }
        if (req.method === 'POST' && entry.status >= 400) {
          forbiddenPosts.push({ sequence: entry.sequence, path: route, code: entry.response?.code || 'PROFILE_ERROR' });
        }
        if (armedFault) {
          assert.equal(typeof bufferedBody, 'string');
          const created = entry.response, source = created?.profile?.source?.at(-1);
          if (duplicateReceiptFault === armedFault && armedFault.state === 'armed' && entry.status === 201 &&
              source?.kind === 'duplicate' && source.profileId === armedFault.profileId &&
              source.revision === armedFault.revision && source.hash === armedFault.hash) {
            const record = entry.after.profiles.records.find(row => row.id === created.id);
            assert.ok(record && !entry.before.profiles.records.some(row => row.id === created.id));
            assert.equal(record.lifecycle, 'draft'); assert.equal(record.active_revision, null);
            const delivered = { ...created, profile: null }, bytes = JSON.stringify(delivered);
            entry.deliveredStatus = 201; entry.deliveredResponse = delivered;
            entry.deliveredResponseSha256 = sha256(bytes); entry.deliveredResponseBytes = Buffer.byteLength(bytes);
            const fault = { kind: 'duplicate-receipt-profile-null', synthetic: true, armSequence: armedFault.armSequence,
              sequence: entry.sequence, sourceProfileId: source.profileId, sourceRevision: source.revision, sourceHash: source.hash,
              createdProfileId: created.id, actualResponseSha256: entry.responseSha256,
              deliveredResponseSha256: entry.deliveredResponseSha256 };
            // Consume before emitting; a second concurrent or later reply cannot
            // reuse this fault. The real receipt/event remain unmodified.
            armedFault.state = 'consumed'; armedFault.requestSequence = entry.sequence;
            receiptFaults.push(fault); entry.receiptFault = fault;
            sendJson(res, 201, delivered);
          } else {
            res.writeHead(entry.status, bufferedHeaders); res.end(bufferedBody);
          }
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
