import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openOntologyStore, ONTOLOGY_STORE_SCHEMA_VERSION } from './egdesk-ontology-store.mjs';
import { inspectSqliteRuntime } from './egdesk-sqlite-runtime.mjs';

const rawGraph = readFileSync(new URL('../overlay/resources/ontology/graph.json', import.meta.url));
const graph = () => JSON.parse(rawGraph.toString('utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const directory = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'egdesk-ontology-store-test-')));
  const dbPath = path.join(directory, 'ontology.sqlite');
  const handles = [];
  t.after(() => {
    for (const handle of handles) handle.close();
    assert.match(path.basename(directory), /^egdesk-ontology-store-test-/);
    assert.equal(realpathSync.native(directory), directory);
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, dbPath, open: () => { const store = openOntologyStore({ dbPath }); handles.push(store); return store; } };
}
const rejects = (action, code) => assert.throws(action, error => error.code === code);
function alterOccurrence(g, id, patch) {
  Object.assign(g.occurrences.find(o => o.refId === id), patch);
  for (const snapshot of g.snapshots) {
    const item = snapshot.occurrences.find(o => o.refId === id);
    if (item) Object.assign(item, patch);
  }
  for (const node of g.nodes) {
    const item = node.occurrences?.find(o => o.refId === id);
    if (item) Object.assign(item, patch);
  }
}

test('runtime is genuinely patched; full existing graph and original bytes survive reopen', t => {
  assert.equal(inspectSqliteRuntime().supported, true, 'Run with the project pinned/patched Node; do not bypass the gate');
  const { open } = fixture(t);
  const store = open();
  assert.equal(store.readGraph(), null);
  assert.equal(store.status().initialized, false);
  const sourceBytes = Buffer.from('# 원본\r\n\r\nunknown: unchanged\n', 'utf8');
  const sourceDocuments = [{ path: 'ontology/test.md', bytes: sourceBytes, sha256: digest(sourceBytes) }];
  const input = graph();
  const result = store.importGraph(input, { sourceDocuments, rawGraphJson: rawGraph, sourceLabel: 'original fixture' });
  assert.equal(result.imported, true);
  assert.equal(result.schemaVersion, ONTOLOGY_STORE_SCHEMA_VERSION);
  assert.equal(result.graphSchemaVersion, input.schemaVersion);
  assert.equal(result.sourceHash, input.sourceHash);
  assert.deepEqual(result.counts, Object.fromEntries(['nodes', 'edges', 'snapshots', 'occurrences', 'referenceEdges'].map(key => [key, input[key].length])));
  assert.deepEqual(store.readGraph(), input);
  assert.equal(JSON.stringify(store.readGraph()), JSON.stringify(input));
  assert.deepEqual(store.exportArchive().rawGraphJson, rawGraph);
  assert.deepEqual(store.exportArchive().sourceDocuments, sourceDocuments);
  assert.deepEqual(store.integrity(), { ok: true, issues: [] });
  store.close();
  const reopened = open();
  assert.deepEqual(reopened.readGraph(), input);
  assert.deepEqual(reopened.exportArchive().sourceDocuments, sourceDocuments);
  assert.equal(reopened.importGraph(input, { rawGraphJson: rawGraph, sourceDocuments }).imported, false);
  assert.equal(reopened.status().import.importedAt, result.import.importedAt);
});

test('unknown fields, key/array order, body, and redundant nested structures round trip without flattening', t => {
  const { open } = fixture(t);
  const input = graph();
  input.unrecognized = { z: [null, true, '가상'], a: { retained: 'yes' } };
  input.nodes.reverse();
  input.edges.reverse();
  input.occurrences.reverse();
  input.nodes[0].extra = { independent: ['node-only'] };
  input.snapshots[0].occurrences[0].localOnly = 'keep this nested value';
  input.referenceEdges[0].unexpected = { future: 7 };
  const store = open();
  store.importGraph(input);
  assert.equal(JSON.stringify(store.readGraph()), JSON.stringify(input));
  assert.deepEqual(store.integrity(), { ok: true, issues: [] });
});

test('same seed is a no-op; changed graph, raw bytes, or source archive is refused without overwriting', t => {
  const { open } = fixture(t);
  const store = open();
  const input = graph();
  const docs = [{ path: 'original.md', bytes: Buffer.from('original') }];
  store.importGraph(input, { sourceDocuments: docs, rawGraphJson: rawGraph });
  const before = store.status();
  assert.equal(store.importGraph(input).unchanged, true);
  const changed = structuredClone(input);
  changed.nodes[0].body += '\nchanged';
  rejects(() => store.importGraph(changed), 'ONTOLOGY_ALREADY_INITIALIZED');
  rejects(() => store.importGraph(input, { sourceDocuments: [{ path: 'original.md', bytes: 'changed' }] }), 'ONTOLOGY_ALREADY_INITIALIZED');
  rejects(() => store.importGraph(input, { rawGraphJson: JSON.stringify(input) }), 'ONTOLOGY_ALREADY_INITIALIZED');
  assert.deepEqual(store.status(), before);
  assert.deepEqual(store.readGraph(), input);
});

test('current rows are canonical, not frozen to original import archive; reimport never rolls them back', t => {
  const { open, dbPath } = fixture(t);
  const store = open();
  const input = graph();
  store.importGraph(input);
  const edited = structuredClone(input.nodes.find(node => node.body));
  edited.body += '\nAn intentional database-side edit.';
  const db = new DatabaseSync(dbPath);
  try { db.prepare('UPDATE ontology_concepts SET body=?,payload_json=? WHERE id=?').run(edited.body, JSON.stringify(edited), edited.id); }
  finally { db.close(); }
  assert.equal(store.readGraph().nodes.find(n => n.id === edited.id).body, edited.body);
  assert.deepEqual(store.exportArchive().graph, input);
  assert.equal(store.integrity().ok, true);
  assert.equal(store.importGraph(input).unchanged, true);
  store.close();
  const reopened = open();
  assert.equal(reopened.readGraph().nodes.find(n => n.id === edited.id).body, edited.body);
  assert.notEqual(reopened.status().graphHash, reopened.status().import.graphHash);
});

test('structural errors fail with no partial import, and a valid retry still works', t => {
  const { open } = fixture(t);
  const store = open();
  const mutations = [
    g => g.occurrences.push({ ...g.occurrences[0] }),
    g => { g.edges[0].target = 'missing.concept'; },
    g => { g.snapshots[0].continuesFrom = 'missing@snapshot'; },
    g => alterOccurrence(g, g.occurrences.find(o => o.parentRef).refId, { parentRef: 'missing.parent' }),
    g => { const o = g.occurrences.find(o => o.parentRef); alterOccurrence(g, o.refId, { parentRef: g.occurrences.find(p => p.snapshotId !== o.snapshotId).refId }); },
    g => { const o = g.occurrences.find(o => o.parentRef); alterOccurrence(g, o.refId, { parentRef: o.refId }); },
    g => { g.referenceEdges[0].targetRef = 'missing.reference'; },
    g => { g.snapshots[0].rootRef = 'missing.root'; },
    g => { g.snapshots[0].occurrences.pop(); },
  ];
  for (const mutate of mutations) {
    const input = graph(); mutate(input);
    rejects(() => store.importGraph(input), 'INVALID_ONTOLOGY_GRAPH');
    assert.equal(store.readGraph(), null);
    assert.equal(store.status().initialized, false);
    assert.ok(Object.values(store.status().counts).every(n => n === 0));
  }
  assert.equal(store.importGraph(graph()).imported, true);
});

test('cyclic reference edges are allowed while parent cycles remain forbidden', t => {
  const { open } = fixture(t);
  const input = graph();
  const snapshot = input.snapshots[0];
  const nested = { sourceRef: snapshot.occurrences[1].refId, relation: 'refers_to', targetRef: snapshot.rootRef };
  snapshot.referenceEdges.push(nested);
  input.nodes.find(n => n.id === snapshot.id).referenceEdges.push(structuredClone(nested));
  input.referenceEdges.push({ id: 'explicit-cycle-reference', ...nested, declaredBy: snapshot.id });
  const store = open();
  store.importGraph(input);
  assert.deepEqual(store.readGraph(), input);
  assert.equal(store.integrity().ok, true);
});

test('transaction rolls back all rows and archives on a mid-import SQL failure', t => {
  const { open, dbPath } = fixture(t);
  const store = open();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON ontology_occurrences BEGIN SELECT RAISE(ABORT,'injected mid-import failure'); END");
    assert.throws(() => store.importGraph(graph(), { sourceDocuments: [{ path: 'a.md', bytes: 'source' }] }), /injected/);
    assert.equal(store.status().initialized, false);
    assert.equal(store.status().sourceDocumentCount, 0);
    assert.ok(Object.values(store.status().counts).every(n => n === 0));
    assert.equal(store.exportArchive(), null);
    db.exec('DROP TRIGGER fail_import');
    assert.equal(store.importGraph(graph()).imported, true);
  } finally { db.close(); }
});

test('SQL uniqueness/FKs protect global refs, same-snapshot parents, and snapshot links; lookup indexes exist', t => {
  const { open, dbPath } = fixture(t);
  const store = open(); store.importGraph(graph());
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys=ON');
    assert.throws(() => db.exec('INSERT INTO ontology_occurrences SELECT * FROM ontology_occurrences LIMIT 1'), /UNIQUE/);
    assert.throws(() => db.exec("UPDATE ontology_snapshots SET continues_from='missing'"), /FOREIGN KEY/);
    const g = graph();
    const o = g.occurrences.find(item => item.parentRef);
    const other = g.occurrences.find(item => item.snapshotId !== o.snapshotId);
    assert.throws(() => db.prepare('UPDATE ontology_occurrences SET parent_ref=? WHERE ref_id=?').run(other.refId, o.refId), /FOREIGN KEY/);
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT ref_id FROM ontology_occurrences WHERE snapshot_id=? AND parent_ref=?').all(o.snapshotId, o.parentRef);
    assert.ok(plan.some(row => row.detail.includes('ontology_occurrences_children')));
    assert.equal(store.integrity().ok, true);
  } finally { db.close(); }
});

test('corrupt or unrelated existing databases are never reset or silently reseeded', t => {
  const { open, dbPath } = fixture(t);
  const store = open(); store.importGraph(graph()); store.close();
  const db = new DatabaseSync(dbPath);
  try { db.prepare('UPDATE ontology_concepts SET body=? WHERE id=?').run('mismatch', graph().nodes[0].id); }
  finally { db.close(); }
  const before = readFileSync(dbPath);
  rejects(open, 'ONTOLOGY_STORE_CORRUPT');
  assert.deepEqual(readFileSync(dbPath), before);

  const second = fixture(t);
  const unrelated = new DatabaseSync(second.dbPath);
  unrelated.exec('CREATE TABLE user_data(value TEXT); INSERT INTO user_data VALUES (\'keep\')'); unrelated.close();
  chmodSync(second.dbPath, 0o600);
  const original = readFileSync(second.dbPath);
  rejects(second.open, 'UNSUPPORTED_ONTOLOGY_STORE');
  assert.deepEqual(readFileSync(second.dbPath), original);
});

test('source byte hashes and raw-graph equality are checked before import', t => {
  const { open } = fixture(t); const store = open();
  rejects(() => store.importGraph(graph(), { sourceDocuments: [{ path: 'a.md', bytes: 'x', sha256: 'wrong' }] }), 'INVALID_ONTOLOGY_SOURCE');
  rejects(() => store.importGraph(graph(), { sourceDocuments: [{ path: 'a.md', bytes: 'x' }, { path: 'a.md', bytes: 'y' }] }), 'INVALID_ONTOLOGY_SOURCE');
  rejects(() => store.importGraph(graph(), { rawGraphJson: '{}' }), 'INVALID_ONTOLOGY_SOURCE');
  for (const value of [undefined, Infinity, -0, new Date()]) {
    const input = graph(); input.nonJSON = value;
    rejects(() => store.importGraph(input), 'INVALID_ONTOLOGY_GRAPH');
  }
  assert.equal(store.readGraph(), null);
});

test('path boundary rejects symlink files and close is idempotent', t => {
  const { directory, dbPath } = fixture(t);
  const target = path.join(directory, 'original'); writeFileSync(target, 'untouched', { mode: 0o600 });
  symlinkSync(target, dbPath);
  rejects(() => openOntologyStore({ dbPath }), 'INVALID_STORE_SCOPE');
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
  const store = openOntologyStore({ dbPath: ':memory:' });
  store.close(); store.close();
  rejects(() => store.readGraph(), 'ONTOLOGY_STORE_CLOSED');
  assert.equal(existsSync(path.join(directory, ':memory:')), false);
});

test('preexisting empty files are not automatically initialized or reseeded', t => {
  const { dbPath, open } = fixture(t);
  writeFileSync(dbPath, '', { mode: 0o600 });
  rejects(open, 'ONTOLOGY_STORE_CORRUPT');
  assert.equal(readFileSync(dbPath).length, 0);
});

test('two open connections seed once without overwriting, and archive damage fails integrity/export', t => {
  const { open, dbPath } = fixture(t);
  const first = open(); const second = open();
  assert.equal(first.importGraph(graph(), { sourceDocuments: [{ path: 'original.md', bytes: 'original' }] }).imported, true);
  assert.equal(second.importGraph(graph()).imported, false);
  assert.deepEqual(first.readGraph(), second.readGraph());
  const db = new DatabaseSync(dbPath);
  try { db.prepare('UPDATE ontology_source_documents SET bytes=?').run(Buffer.from('corrupted')); }
  finally { db.close(); }
  assert.equal(first.integrity().ok, false);
  rejects(() => first.exportArchive(), 'ONTOLOGY_STORE_CORRUPT');
  rejects(() => second.importGraph(graph()), 'ONTOLOGY_STORE_CORRUPT');
});
