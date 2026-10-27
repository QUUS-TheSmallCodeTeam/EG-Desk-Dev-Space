import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readOntologySeed, migrateOntologyGraph } from './egdesk-ontology-migration.mjs';
import { openOntologyStore } from './egdesk-ontology-store.mjs';

function fixture(t) {
  const directory = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'egdesk-ontology-migration-test-')));
  const ontologyRoot = path.join(directory, 'ontology'); mkdirSync(ontologyRoot, { mode: 0o700 });
  const source = Buffer.from('# 원본\r\n\r\nOriginal Markdown.\n');
  const extra = Buffer.from('# Preserved even without a node path\n');
  writeFileSync(path.join(ontologyRoot, 'a.md'), source);
  writeFileSync(path.join(ontologyRoot, 'z.md'), extra);
  const graph = { schemaVersion: 3, sourceRoot: 'ontology', sourceHash: createHash('sha1').update([source, extra].map(b => b.toString('utf8')).join('\n---SOURCE---\n')).digest('hex'), nodeCount: 1, edgeCount: 0,
    nodes: [{ id: 'example', type: 'concept', layer: 'runtime', path: 'ontology/a.md', ontologyPath: 'a.md', body: '# 원본', unknown: 'preserve' }], edges: [], snapshots: [], occurrences: [], referenceEdges: [] };
  const raw = Buffer.from(`${JSON.stringify(graph, null, 4)}\n`);
  const graphPath = path.join(directory, 'graph.json'); writeFileSync(graphPath, raw);
  const dbPath = path.join(directory, 'profile', 'ontology.sqlite');
  t.after(() => { assert.match(path.basename(directory), /^egdesk-ontology-migration-test-/); rmSync(directory, { recursive: true, force: true }); });
  return { directory, ontologyRoot, graphPath, dbPath, raw, graph, source, extra };
}

test('migration archives all original Markdown bytes, paths, hashes and raw graph; source files remain byte-identical', t => {
  const f = fixture(t);
  const seed = readOntologySeed(f);
  assert.deepEqual(seed.sourceDocuments.map(d => d.path), ['ontology/a.md', 'ontology/z.md']);
  assert.deepEqual(seed.sourceDocuments.map(d => d.bytes), [f.source, f.extra]);
  assert.ok(seed.sourceDocuments.every(d => d.sha256 === createHash('sha256').update(d.bytes).digest('hex')));
  assert.equal(existsSync(f.dbPath), false, 'source preparation is read-only');
  const first = migrateOntologyGraph(f);
  assert.equal(first.imported, true); assert.equal(first.integrity.ok, true);
  assert.equal(migrateOntologyGraph(f).imported, false);
  const store = openOntologyStore({ dbPath: f.dbPath });
  try {
    assert.deepEqual(store.readGraph(), f.graph);
    assert.deepEqual(store.exportArchive().rawGraphJson, f.raw);
    assert.deepEqual(store.exportArchive().sourceDocuments, seed.sourceDocuments);
  } finally { store.close(); }
  assert.deepEqual(readFileSync(f.graphPath), f.raw);
  assert.deepEqual(readFileSync(path.join(f.ontologyRoot, 'a.md')), f.source);
});

test('changed, added, or removed Markdown makes the seed stale before any database creation', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.ontologyRoot, 'a.md'), '# changed');
  assert.throws(() => migrateOntologyGraph(f), error => error.code === 'ONTOLOGY_STALE_SEED' && /Regenerate/.test(error.message));
  assert.equal(existsSync(path.dirname(f.dbPath)), false);
  writeFileSync(path.join(f.ontologyRoot, 'a.md'), f.source);
  writeFileSync(path.join(f.ontologyRoot, 'new.md'), '# new');
  assert.throws(() => readOntologySeed(f), { code: 'ONTOLOGY_STALE_SEED' });
  rmSync(path.join(f.ontologyRoot, 'new.md'));
  rmSync(path.join(f.ontologyRoot, 'z.md'));
  assert.throws(() => readOntologySeed(f), { code: 'ONTOLOGY_STALE_SEED' });
});

test('regenerated changed seed cannot replace an already initialized canonical DB', t => {
  const f = fixture(t); migrateOntologyGraph(f);
  const changed = { ...f.graph, description: 'new generated metadata' };
  writeFileSync(f.graphPath, JSON.stringify(changed));
  assert.throws(() => migrateOntologyGraph(f), { code: 'ONTOLOGY_ALREADY_INITIALIZED' });
  const store = openOntologyStore({ dbPath: f.dbPath });
  try { assert.deepEqual(store.readGraph(), f.graph); }
  finally { store.close(); }
});

test('source path traversal is refused without opening a DB', t => {
  const f = fixture(t);
  f.graph.nodes[0].ontologyPath = '../outside.md';
  writeFileSync(f.graphPath, JSON.stringify(f.graph));
  assert.throws(() => migrateOntologyGraph(f), { code: 'INVALID_ONTOLOGY_SOURCE' });
  assert.equal(existsSync(f.dbPath), false);
});
