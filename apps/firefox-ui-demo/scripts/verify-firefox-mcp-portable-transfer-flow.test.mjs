import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createPortableTransferFixture } from './egdesk-portable-transfer-fixture.mjs';
import { bootstrapQaProfile, canonicalTempRoot, LOADER_FILES } from './egdesk-chat-qa-profile.mjs';
import { createPrivateQaTempDirectory } from './egdesk-qa-platform.mjs';
import { assertPortableEnvironment, assertPortableStoreInvariant, assertPortableImportedDraft,
  assertPortableExportFile, assertPortablePinnedExport, assertPortableNoReplay,
  assertPortableMissingHead,
  portableObservationSources, PORTABLE_OBSERVATION_BUDGET, portableTextVisible } from './verify-firefox-mcp-portable-transfer-flow.mjs';

const TOKEN = 'portable-verifier-unit-only-token';
const ENV = { EGDESK_QA_PORTABLE_TRANSFER_FIXTURE: '1', EGDESK_QA_FIXTURE_TRANSPORT: '1',
  EGDESK_QA_REAL_TURN: '0', EGDESK_QA_FIXTURE_PORT: '49318', EGDESK_QA_FIXTURE_TOKEN: TOKEN };
function setup(t) {
  const loader = createPrivateQaTempDirectory('egdesk-portable-verifier-loader-');
  for (const name of LOADER_FILES) fs.writeFileSync(path.join(loader, name), `unit loader ${name}\n`, { mode: 0o600 });
  const { profile } = bootstrapQaProfile({ loaderSource: loader });
  const fixture = createPortableTransferFixture({ profile, token: TOKEN, env: ENV }), root = fixture.snapshot().root;
  t.after(() => {
    fixture.dispose();
    for (const [directory, prefix] of [[root, 'egdesk-portable-transfer-'], [profile, 'egdesk-chat-test-'], [loader, 'egdesk-portable-verifier-loader-']]) {
      assert.equal(path.dirname(directory), canonicalTempRoot()); assert.equal(fs.realpathSync.native(directory), directory);
      assert.ok(path.basename(directory).startsWith(prefix)); fs.rmSync(directory, { recursive: true });
    }
  });
  return fixture;
}
async function request(fixture, method, route, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url: route, socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:49318', 'content-type': 'application/json', 'x-egdesk-qa-token': TOKEN } });
  let status, value;
  const res = { setHeader() {}, writeHead(code) { status = code; }, end(text) { value = JSON.parse(text); } };
  assert.equal(await fixture.handle(req, res), true);
  return { status, value };
}

test('verifier requires canonical token and exclusive portable mode, never a real provider turn', () => {
  assert.equal(assertPortableEnvironment(ENV), true);
  for (const delta of [{ EGDESK_QA_FIXTURE_TOKEN: undefined }, { EGDESK_QA_REAL_TURN: '1' },
    { EGDESK_QA_PROJECT_FILE_FIXTURE: '1' }, { EGDESK_QA_TASK_GATE_FIXTURE: '1' },
    { EGDESK_QA_RUN_OUTPUTS_FIXTURE: '1' }, { EGDESK_QA_PORTABLE_TRANSFER_FIXTURE: '0' }]) {
    assert.throws(() => assertPortableEnvironment({ ...ENV, ...delta }));
  }
});

test('small observation scripts are read-only and cannot install fabricated outcome or native picker IO', () => {
  for (const part of portableObservationSources()) {
    assert.ok(part.bytes < PORTABLE_OBSERVATION_BUDGET);
    assert.equal(part.bytes, Buffer.byteLength(part.source));
    assert.doesNotMatch(part.source, /(?:\.click\(|\.focus\(|scrollIntoView|dispatchEvent|setSelectionRange|\.openProfile\(|\.openProject\(|IOUtils|fetch\()/);
    new Function(`return (${part.source})`); // compile only; no simulated DOM acceptance
  }
});

test('paint predicates require actual full text rectangles, clipping and hit evidence, not container whitespace', () => {
  const good = { count: 1, text: 'first\nlast', needle: 'last', matches: 1, missing: 0, visible: true,
    fragments: [{ inside: true, hits: [true, true, true] }] };
  assert.equal(portableTextVisible(good, 'first\nlast', 'last'), true);
  for (const delta of [{ text: 'shortened' }, { matches: 0 }, { matches: 2 }, { missing: 1 }, { visible: false },
    { fragments: [] }, { fragments: [{ inside: false, hits: [true, true, true] }] },
    { fragments: [{ inside: true, hits: [true, false, true] }] }]) {
    assert.equal(portableTextVisible({ ...good, ...delta }, 'first\nlast', 'last'), false);
  }
});

test('store receipt assertions reject changed Board head, unexpected activation, provider or output injection', t => {
  const fixture = setup(t), before = fixture.snapshot();
  assert.equal(assertPortableStoreInvariant(before, before), true);
  const variants = [state => state.persisted.desk.boards[0].head_revision++,
    state => state.persisted.profiles.records[0].active_revision = 2,
    state => state.providerTurns++, state => state.currentImportSha256 = 'changed',
    state => state.requests.push({ method: 'POST', path: '/chat/send', status: 403 }),
    state => state.requests.push({ method: 'PUT', path: '/v1/desk/current', status: 200 })];
  for (const alter of variants) {
    const after = structuredClone(before); alter(after); assert.throws(() => assertPortableStoreInvariant(before, after));
  }
});

test('import proof reads real preview and confirmed SQLite draft with exact original Markdown', async t => {
  const fixture = setup(t), before = fixture.snapshot();
  const body = { text: before.seed.importText, filename: before.seed.importFilename };
  const preview = await request(fixture, 'POST', '/profiles/import', { ...body, dryRun: true });
  assert.equal(preview.status, 200);
  assert.equal(assertPortableStoreInvariant(before, fixture.snapshot()), true);
  const commit = await request(fixture, 'POST', '/profiles/import', { ...body, dryRun: false });
  assert.equal(commit.status, 201);
  const after = fixture.snapshot(), id = assertPortableImportedDraft(before, after);
  assert.notEqual(id, before.seed.profileId);
  const changed = structuredClone(after); changed.requests.find(row => row.request?.dryRun === false).request.textSha256 = 'substituted';
  assert.throws(() => assertPortableImportedDraft(before, changed));
  await request(fixture, 'POST', '/profiles/import', { ...body, dryRun: false });
  assert.throws(() => assertPortableImportedDraft(before, fixture.snapshot()), /strictly equal|exactly|profiles/);
});

test('pinned-export validator checks actual new head and exact old revision bytes; unit files are not UI proof', async t => {
  const fixture = setup(t), before = fixture.snapshot();
  const target = { profileId: before.seed.profileId, revision: '2', source: 'draft', text: '내보낼 Agent: Owned QA portable profile · 초안 버전 2' };
  assert.equal((await request(fixture, 'POST', '/__qa/portable-transfer/control', { operation: 'advance-profile-head', expectedHeadRevision: 2 })).status, 200);
  const packet = await request(fixture, 'GET', `/profiles/${before.seed.profileId}/export?format=md&revision=2`);
  assert.equal(packet.status, 200);
  // Pure assertion fixture only. The attach-only verifier never writes exports.
  fs.writeFileSync(path.join(before.exportsDir, 'owned-pinned-v2.md'), packet.value.text, { flag: 'wx', mode: 0o600 });
  const after = fixture.snapshot();
  assert.equal(assertPortablePinnedExport(before, after, { target }, { target }, 'owned-pinned-v2.md'), true);
  assert.throws(() => assertPortablePinnedExport(before, after, { target }, { target: { ...target, revision: '3' } }, 'owned-pinned-v2.md'));
  assert.throws(() => assertPortableExportFile(after, 'owned-pinned-v2.md', `${packet.value.text}changed`));
});

test('unknown/no-replay receipt validator rejects repeat export, file change and reenabled action', t => {
  const fixture = setup(t), before = fixture.snapshot();
  const sample = () => ({ state: structuredClone(before), ui: { transferState: 'unknown', transferButtons: [{ disabled: true }] } });
  assert.equal(assertPortableNoReplay(before, [sample(), sample(), sample()], 'unknown'), true);
  const variants = [row => row.state.requests.push({ path: `/profiles/${before.seed.profileId}/export`, delegated: true }),
    row => row.state.pickerResults.push({}), row => row.state.exports.push({ name: 'unexpected' }),
    row => row.ui.transferButtons[0].disabled = false, row => row.ui.transferState = 'saved'];
  for (const alter of variants) {
    const samples = [sample(), sample(), sample()]; alter(samples[2]);
    assert.throws(() => assertPortableNoReplay(before, samples, 'unknown'));
  }
});

test('missing-head proof requires actual Desk 404 and cannot stand in for a successful UI capture', async t => {
  const fixture = setup(t), before = fixture.snapshot(), boardId = 'owned-native-ui-no-saved-head';
  const read = await request(fixture, 'GET', `/v1/boards/${boardId}`);
  assert.equal(read.status, 404);
  const ui = { boardDialog: { state: 'needs-save', statusText: '먼저 이 Board를 저장한 뒤 다시 내보내세요.' } };
  assert.equal(assertPortableMissingHead(before, fixture.snapshot(), boardId, ui), true);
  assert.throws(() => assertPortableMissingHead(before, before, boardId, ui), /actual Desk handler/);
  assert.throws(() => assertPortableMissingHead(before, fixture.snapshot(), before.seed.boardId, ui));
});
