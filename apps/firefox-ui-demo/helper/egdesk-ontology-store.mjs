import { createHash } from 'node:crypto';
import { constants, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isOwnedAndPrivate } from './egdesk-private-files.mjs';
import { assertPatchedSqliteRuntime } from './egdesk-sqlite-runtime.mjs';

export const ONTOLOGY_STORE_SCHEMA_VERSION = 1;
const APPLICATION_ID = 0x45474f4e; // EGON; separate from the imported graph's schemaVersion.
const COLLECTIONS = {
  nodes: ['ontology_concepts', { id: 'id', type: 'type', layer: 'layer', source_path: 'path', body: 'body' }],
  edges: ['ontology_edges', { id: 'id', source: 'source', target: 'target', relation: 'relation', declared_by: 'declaredBy' }],
  snapshots: ['ontology_snapshots', { snapshot_id: 'snapshotId', document_id: 'id', subject_id: 'subjectId', time_slice: 'timeSlice', status: 'status', root_ref: 'rootRef', continues_from: 'continuesFrom' }],
  occurrences: ['ontology_occurrences', { ref_id: 'refId', concept_id: 'conceptId', snapshot_id: 'snapshotId', parent_ref: 'parentRef', layer: 'layer', relation: 'relation' }],
  referenceEdges: ['ontology_reference_edges', { id: 'id', source_ref: 'sourceRef', target_ref: 'targetRef', relation: 'relation', declared_by: 'declaredBy' }],
};
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message, httpStatus = 400, cause) => { throw Object.assign(new Error(message, cause ? { cause } : undefined), { code, httpStatus }); };
const invalid = message => fail('INVALID_ONTOLOGY_GRAPH', message);
const textId = (value, name) => { if (typeof value !== 'string' || !value.trim() || value.includes('\0')) invalid(`${name} must be a nonempty string`); };

// Reject values JSON.stringify would silently drop or alter. JSON object key order,
// array order, unknown properties, and redundant nested structures are preserved.
function jsonText(value) {
  const ancestors = new Set();
  function visit(item, depth) {
    if (depth > 200) invalid('JSON nesting exceeds 200 levels');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return;
    if ((!Array.isArray(item) && !plain(item)) || ancestors.has(item)) invalid('Graph must contain only lossless finite JSON values');
    if (Reflect.ownKeys(item).some(key => typeof key === 'symbol')) invalid('JSON cannot preserve symbol properties');
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) invalid('Sparse arrays or array properties cannot be preserved');
      for (const child of item) visit(child, depth + 1);
    } else {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
        if (!descriptor.enumerable || !('value' in descriptor)) invalid('JSON properties must be enumerable data properties');
        visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(item);
  }
  visit(value, 0);
  return JSON.stringify(value);
}

function indexed(records, key, name) {
  const result = new Map();
  for (const record of records) {
    if (!plain(record)) invalid(`${name} entries must be objects`);
    textId(record[key], `${name}.${key}`);
    if (result.has(record[key])) invalid(`Duplicate ${name}.${key}: ${record[key]}`);
    result.set(record[key], record);
  }
  return result;
}
function sameCore(left, right, fields, name) {
  for (const field of fields) if ((left[field] ?? null) !== (right[field] ?? null)) invalid(`${name}: inconsistent ${field}`);
}

export function validateOntologyGraph(graph) {
  if (!plain(graph)) invalid('Graph must be an object');
  const serialized = jsonText(graph);
  if (!Number.isSafeInteger(graph.schemaVersion) || graph.schemaVersion < 1) invalid('A positive graph schemaVersion is required');
  for (const [name, [, columns]] of Object.entries(COLLECTIONS)) {
    if (!Array.isArray(graph[name])) invalid(`${name} must be an array`);
    for (const record of graph[name]) {
      if (!plain(record)) invalid(`${name} entries must be objects`);
      for (const field of Object.values(columns)) if (record[field] != null && typeof record[field] !== 'string') invalid(`${name}.${field} must be text or null`);
    }
  }
  if (graph.nodeCount !== undefined && graph.nodeCount !== graph.nodes.length) invalid('nodeCount does not match nodes');
  if (graph.edgeCount !== undefined && graph.edgeCount !== graph.edges.length) invalid('edgeCount does not match edges');
  const concepts = indexed(graph.nodes, 'id', 'nodes');
  indexed(graph.edges, 'id', 'edges');
  const snapshots = indexed(graph.snapshots, 'snapshotId', 'snapshots');
  const documents = indexed(graph.snapshots, 'id', 'snapshot documents');
  const occurrences = indexed(graph.occurrences, 'refId', 'occurrences');
  indexed(graph.referenceEdges, 'id', 'referenceEdges');
  for (const edge of graph.edges) {
    textId(edge.relation, 'edge.relation');
    if (!concepts.has(edge.source) || !concepts.has(edge.target)) invalid(`Unknown concept edge endpoint: ${edge.id}`);
    if (edge.declaredBy != null && !concepts.has(edge.declaredBy)) invalid(`Unknown edge declaration: ${edge.id}`);
  }
  for (const snapshot of graph.snapshots) {
    for (const field of ['subjectId', 'timeSlice', 'status', 'rootRef']) textId(snapshot[field], `snapshot.${field}`);
    if (!concepts.has(snapshot.id)) invalid(`Unknown snapshot document: ${snapshot.id}`);
    if (snapshot.continuesFrom != null && !snapshots.has(snapshot.continuesFrom)) invalid(`Unknown continuesFrom: ${snapshot.snapshotId}`);
    if (!Array.isArray(snapshot.occurrences) || !Array.isArray(snapshot.referenceEdges)) invalid('Snapshot occurrences/referenceEdges must be arrays');
    const local = indexed(snapshot.occurrences, 'refId', 'snapshot occurrences');
    const root = local.get(snapshot.rootRef);
    if (!root || root.parentRef != null) invalid(`Invalid snapshot root: ${snapshot.snapshotId}`);
    const flat = graph.occurrences.filter(item => item.snapshotId === snapshot.snapshotId);
    if (flat.length !== local.size) invalid(`Snapshot occurrence membership differs: ${snapshot.snapshotId}`);
    for (const occurrence of local.values()) {
      const current = occurrences.get(occurrence.refId);
      if (!current || current.snapshotId !== snapshot.snapshotId) invalid(`Unknown snapshot occurrence: ${occurrence.refId}`);
      sameCore(occurrence, current, ['conceptId', 'parentRef', 'relation', 'layer'], occurrence.refId);
    }
    const node = concepts.get(snapshot.id);
    sameCore(node, snapshot, ['snapshotId', 'subjectId', 'timeSlice', 'rootRef', 'continuesFrom'], snapshot.id);
    if (node.snapshotStatus !== undefined && node.snapshotStatus !== snapshot.status) invalid(`Inconsistent snapshot status: ${snapshot.id}`);
    if (!Array.isArray(node.occurrences) || !Array.isArray(node.referenceEdges)) invalid(`Snapshot document lacks nested data: ${snapshot.id}`);
    const nested = indexed(node.occurrences, 'refId', 'document occurrences');
    if (nested.size !== local.size) invalid(`Document occurrence membership differs: ${snapshot.id}`);
    for (const [id, occurrence] of local) {
      if (!nested.has(id)) invalid(`Missing document occurrence: ${id}`);
      sameCore(nested.get(id), occurrence, ['conceptId', 'parentRef', 'relation', 'layer'], id);
    }
    const signature = edges => edges.map(edge => JSON.stringify([edge.sourceRef, edge.relation, edge.targetRef])).sort();
    const topEdges = graph.referenceEdges.filter(edge => edge.declaredBy === snapshot.id);
    if (JSON.stringify(signature(topEdges)) !== JSON.stringify(signature(snapshot.referenceEdges))
        || JSON.stringify(signature(node.referenceEdges)) !== JSON.stringify(signature(snapshot.referenceEdges))) invalid(`Reference edge membership differs: ${snapshot.id}`);
  }
  for (const occurrence of graph.occurrences) {
    const snapshot = snapshots.get(occurrence.snapshotId);
    if (!snapshot || !concepts.has(occurrence.conceptId)) invalid(`Unknown occurrence snapshot/concept: ${occurrence.refId}`);
    for (const field of ['layer', 'relation']) textId(occurrence[field], `occurrence.${field}`);
    sameCore(occurrence, { snapshotDocId: snapshot.id, subjectId: snapshot.subjectId, timeSlice: snapshot.timeSlice, status: snapshot.status }, ['snapshotDocId', 'subjectId', 'timeSlice', 'status'], occurrence.refId);
    if (occurrence.parentRef != null && occurrences.get(occurrence.parentRef)?.snapshotId !== occurrence.snapshotId) invalid(`Missing or cross-snapshot parent: ${occurrence.refId}`);
  }
  const done = new Set();
  for (const occurrence of graph.occurrences) {
    const visited = new Set();
    let current = occurrence;
    while (current && !done.has(current.refId)) {
      if (visited.has(current.refId)) invalid(`Occurrence parent cycle: ${current.refId}`);
      visited.add(current.refId);
      current = occurrences.get(current.parentRef);
    }
    for (const id of visited) done.add(id);
  }
  for (const edge of graph.referenceEdges) {
    textId(edge.relation, 'reference edge.relation');
    if (!occurrences.has(edge.sourceRef) || !occurrences.has(edge.targetRef) || !documents.has(edge.declaredBy)) invalid(`Invalid reference edge: ${edge.id}`);
  }
  for (const node of graph.nodes) {
    const homes = new Set();
    if (node.viewCells != null && !Array.isArray(node.viewCells)) invalid('viewCells must be an array');
    for (const cell of node.viewCells || []) {
      if (!plain(cell)) invalid('viewCells entries must be objects');
      const home = JSON.stringify([cell.view, cell.node]);
      if (homes.has(home)) invalid(`Duplicate home cell in ${node.id}`);
      homes.add(home);
    }
  }
  return serialized;
}

const PAYLOAD = 'position INTEGER NOT NULL UNIQUE CHECK(position >= 0), payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json) = \'object\')';
const SCHEMA = `
CREATE TABLE ontology_meta (id INTEGER PRIMARY KEY CHECK(id=1), envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)));
CREATE TABLE ontology_imports (id INTEGER PRIMARY KEY CHECK(id=1), graph_hash TEXT NOT NULL, raw_graph BLOB NOT NULL, raw_graph_hash TEXT NOT NULL, source_label TEXT, imported_at TEXT NOT NULL);
CREATE TABLE ontology_source_documents (path TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE, bytes BLOB NOT NULL, sha256 TEXT NOT NULL);
CREATE TABLE ontology_concepts (id TEXT PRIMARY KEY NOT NULL, type TEXT, layer TEXT, source_path TEXT, body TEXT, ${PAYLOAD});
CREATE TABLE ontology_edges (id TEXT PRIMARY KEY NOT NULL, source TEXT NOT NULL REFERENCES ontology_concepts(id), target TEXT NOT NULL REFERENCES ontology_concepts(id), relation TEXT NOT NULL, declared_by TEXT REFERENCES ontology_concepts(id), ${PAYLOAD});
CREATE TABLE ontology_snapshots (snapshot_id TEXT PRIMARY KEY NOT NULL, document_id TEXT NOT NULL UNIQUE REFERENCES ontology_concepts(id), subject_id TEXT NOT NULL, time_slice TEXT NOT NULL, status TEXT NOT NULL, root_ref TEXT NOT NULL, continues_from TEXT REFERENCES ontology_snapshots(snapshot_id) DEFERRABLE INITIALLY DEFERRED, ${PAYLOAD}, FOREIGN KEY(snapshot_id,root_ref) REFERENCES ontology_occurrences(snapshot_id,ref_id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE ontology_occurrences (ref_id TEXT PRIMARY KEY NOT NULL, concept_id TEXT NOT NULL REFERENCES ontology_concepts(id), snapshot_id TEXT NOT NULL REFERENCES ontology_snapshots(snapshot_id) DEFERRABLE INITIALLY DEFERRED, parent_ref TEXT, layer TEXT NOT NULL, relation TEXT NOT NULL, ${PAYLOAD}, UNIQUE(snapshot_id,ref_id), FOREIGN KEY(snapshot_id,parent_ref) REFERENCES ontology_occurrences(snapshot_id,ref_id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE ontology_reference_edges (id TEXT PRIMARY KEY NOT NULL, source_ref TEXT NOT NULL REFERENCES ontology_occurrences(ref_id), target_ref TEXT NOT NULL REFERENCES ontology_occurrences(ref_id), relation TEXT NOT NULL, declared_by TEXT NOT NULL REFERENCES ontology_snapshots(document_id), ${PAYLOAD});
CREATE INDEX ontology_edges_out ON ontology_edges(source,relation,target);
CREATE INDEX ontology_edges_in ON ontology_edges(target,relation,source);
CREATE INDEX ontology_snapshots_subject_time ON ontology_snapshots(subject_id,time_slice);
CREATE INDEX ontology_occurrences_children ON ontology_occurrences(snapshot_id,parent_ref,position);
CREATE INDEX ontology_occurrences_concept ON ontology_occurrences(concept_id,snapshot_id);
CREATE INDEX ontology_refs_out ON ontology_reference_edges(source_ref,relation,target_ref);
CREATE INDEX ontology_refs_in ON ontology_reference_edges(target_ref,relation,source_ref);
`;

function safePath(dbPath) {
  if (dbPath === ':memory:') return { filename: dbPath, created: true };
  if (typeof dbPath !== 'string' || !path.isAbsolute(dbPath) || dbPath.includes('\0')) fail('INVALID_STORE_SCOPE', 'An absolute dbPath is required');
  const parent = path.dirname(dbPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const info = lstatSync(parent);
  const canonical = realpathSync.native(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || !isOwnedAndPrivate(canonical, info, 0o077)) fail('INVALID_STORE_SCOPE', 'Ontology directory must be private and not a symlink');
  const filename = path.join(canonical, path.basename(dbPath));
  const check = target => {
    try {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.nlink !== 1 || !isOwnedAndPrivate(target, stat, 0o077)) fail('INVALID_STORE_SCOPE', 'Ontology files must be private, unlinked regular files');
      return stat;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  for (const target of [filename, `${filename}-wal`, `${filename}-shm`]) check(target);
  let created = false;
  try {
    closeSync(openSync(filename, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600));
    created = true;
  } catch (cause) {
    if (cause.code !== 'EEXIST') throw cause;
    if (check(filename)?.size === 0) fail('ONTOLOGY_STORE_CORRUPT', 'Existing empty database was not initialized or reseeded', 500);
  }
  check(filename);
  return { filename, created };
}
function bytes(value, name) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof Uint8Array) return Buffer.from(value);
  fail('INVALID_ONTOLOGY_SOURCE', `${name} must be UTF-8 text or bytes`);
}
function parseRaw(raw) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/^\uFEFF/, '')); }
  catch (cause) { fail('INVALID_ONTOLOGY_SOURCE', 'Original graph bytes must contain UTF-8 JSON', 400, cause); }
}
function prepareDocuments(documents = []) {
  if (!Array.isArray(documents)) fail('INVALID_ONTOLOGY_SOURCE', 'sourceDocuments must be an array');
  const seen = new Set();
  return documents.map(document => {
    if (!plain(document) || typeof document.path !== 'string' || !document.path || document.path.includes('\0') || seen.has(document.path)) fail('INVALID_ONTOLOGY_SOURCE', 'Source document paths must be unique nonempty strings');
    seen.add(document.path);
    const content = bytes(document.bytes, `Source ${document.path}`);
    const hash = sha256(content);
    if (document.sha256 !== undefined && document.sha256 !== hash) fail('INVALID_ONTOLOGY_SOURCE', `Source hash mismatch: ${document.path}`);
    return { path: document.path, bytes: content, sha256: hash };
  });
}

export class OntologyStore {
  #db;
  #runtime;
  #closed = false;
  constructor({ dbPath } = {}) {
    // Must precede opening or creating any persistent file; never bypassed in tests.
    this.#runtime = assertPatchedSqliteRuntime();
    const location = safePath(dbPath);
    this.dbPath = location.filename;
    try {
      this.#db = new DatabaseSync(this.dbPath);
      this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      this.#db.exec('BEGIN IMMEDIATE');
      const version = this.#db.prepare('PRAGMA user_version').get().user_version;
      const application = this.#db.prepare('PRAGMA application_id').get().application_id;
      const objects = this.#db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
      if (location.created && version === 0 && application === 0 && objects.length === 0) {
        this.#db.exec(SCHEMA);
        this.#db.exec(`PRAGMA user_version=${ONTOLOGY_STORE_SCHEMA_VERSION}; PRAGMA application_id=${APPLICATION_ID};`);
      } else if (version !== ONTOLOGY_STORE_SCHEMA_VERSION || application !== APPLICATION_ID) {
        fail('UNSUPPORTED_ONTOLOGY_STORE', 'Existing database is not a supported ontology store; it was not reset', 409);
      }
      this.#db.exec('COMMIT');
      const result = this.integrity();
      if (!result.ok) fail('ONTOLOGY_STORE_CORRUPT', `Ontology store was not reset: ${result.issues.join('; ')}`, 500);
      if (this.dbPath !== ':memory:' && this.#db.prepare('PRAGMA journal_mode=WAL').get().journal_mode !== 'wal') fail('STORE_OPEN_FAILED', 'WAL could not be enabled', 500);
      this.#db.exec('PRAGMA synchronous=FULL;');
    } catch (cause) {
      try { this.#db?.exec('ROLLBACK'); } catch { /* no transaction, preserve original error */ }
      try { this.#db?.close(); } catch { /* preserve original error */ }
      this.#closed = true;
      if (cause.code && !cause.code.startsWith('ERR_')) throw cause;
      fail('ONTOLOGY_STORE_CORRUPT', 'Ontology store could not be opened; existing data was not reset', 500, cause);
    }
  }
  #open() { if (this.#closed) fail('ONTOLOGY_STORE_CLOSED', 'Ontology store is closed', 409); }
  #read(action) {
    const nested = this.#db.isTransaction;
    if (!nested) this.#db.exec('BEGIN');
    try {
      const result = action();
      if (!nested) this.#db.exec('COMMIT');
      return result;
    } catch (cause) {
      if (!nested) { try { this.#db.exec('ROLLBACK'); } catch { /* preserve original error */ } }
      throw cause;
    }
  }
  #archiveRow() { return this.#db.prepare('SELECT * FROM ontology_imports WHERE id=1').get(); }
  #counts() { return Object.fromEntries(Object.entries(COLLECTIONS).map(([name, [table]]) => [name, this.#db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n])); }

  readGraph() {
    this.#open();
    return this.#read(() => { try {
      const row = this.#db.prepare('SELECT envelope_json FROM ontology_meta WHERE id=1').get();
      if (!row) return null;
      const graph = JSON.parse(row.envelope_json);
      for (const [name, [table]] of Object.entries(COLLECTIONS)) graph[name] = this.#db.prepare(`SELECT payload_json FROM ${table} ORDER BY position`).all().map(item => JSON.parse(item.payload_json));
      return graph;
    } catch (cause) { fail('ONTOLOGY_STORE_CORRUPT', 'Stored ontology graph is unreadable; it was not reset', 500, cause); } });
  }

  importGraph(graph, { sourceDocuments, sourceLabel = null, rawGraphJson } = {}) {
    this.#open();
    const graphJson = validateOntologyGraph(graph);
    const graphHash = sha256(graphJson);
    const raw = rawGraphJson === undefined ? Buffer.from(graphJson) : bytes(rawGraphJson, 'rawGraphJson');
    if (JSON.stringify(parseRaw(raw)) !== graphJson) fail('INVALID_ONTOLOGY_SOURCE', 'Original graph bytes differ from the supplied graph');
    const documents = prepareDocuments(sourceDocuments);
    if (sourceLabel !== null && typeof sourceLabel !== 'string') fail('INVALID_ONTOLOGY_SOURCE', 'sourceLabel must be a string or null');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const check = this.integrity();
      if (!check.ok) fail('ONTOLOGY_STORE_CORRUPT', `Import refused: ${check.issues.join('; ')}`, 500);
      const existing = this.#archiveRow();
      if (existing) {
        const archivedDocuments = this.#db.prepare('SELECT path,sha256 FROM ontology_source_documents ORDER BY position').all();
        const sameDocuments = sourceDocuments === undefined || JSON.stringify(archivedDocuments.map(row => [row.path, row.sha256])) === JSON.stringify(documents.map(row => [row.path, row.sha256]));
        if (existing.graph_hash !== graphHash || !sameDocuments || (rawGraphJson !== undefined && existing.raw_graph_hash !== sha256(raw))) fail('ONTOLOGY_ALREADY_INITIALIZED', 'Ontology already has a canonical database; changed seed import was refused', 409);
        this.#db.exec('COMMIT');
        return { imported: false, unchanged: true, ...this.status() };
      }
      const envelope = { ...graph };
      for (const name of Object.keys(COLLECTIONS)) envelope[name] = [];
      this.#db.prepare('INSERT INTO ontology_meta VALUES (1,?)').run(JSON.stringify(envelope));
      this.#db.prepare('INSERT INTO ontology_imports VALUES (1,?,?,?,?,?)').run(graphHash, raw, sha256(raw), sourceLabel, new Date().toISOString());
      const insertSource = this.#db.prepare('INSERT INTO ontology_source_documents VALUES (?,?,?,?)');
      documents.forEach((document, position) => insertSource.run(document.path, position, document.bytes, document.sha256));
      for (const [name, [table, columns]] of Object.entries(COLLECTIONS)) {
        const names = [...Object.keys(columns), 'position', 'payload_json'];
        const insert = this.#db.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`);
        graph[name].forEach((record, position) => insert.run(...Object.values(columns).map(key => record[key] ?? null), position, JSON.stringify(record)));
      }
      const result = this.integrity();
      if (!result.ok) fail('ONTOLOGY_STORE_CORRUPT', `Import validation failed: ${result.issues.join('; ')}`, 500);
      this.#db.exec('COMMIT');
      return { imported: true, unchanged: false, ...this.status() };
    } catch (cause) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw cause;
    }
  }

  status() {
    this.#open();
    return this.#read(() => {
    const archive = this.#archiveRow();
    const graph = this.readGraph();
    return {
      initialized: Boolean(archive), schemaVersion: ONTOLOGY_STORE_SCHEMA_VERSION,
      graphSchemaVersion: graph?.schemaVersion ?? null, sourceHash: graph?.sourceHash ?? null,
      graphHash: graph ? sha256(JSON.stringify(graph)) : null, counts: this.#counts(),
      sourceDocumentCount: this.#db.prepare('SELECT COUNT(*) AS n FROM ontology_source_documents').get().n,
      import: archive ? { graphHash: archive.graph_hash, rawGraphHash: archive.raw_graph_hash, sourceLabel: archive.source_label, importedAt: archive.imported_at } : null,
      runtime: { ...this.#runtime },
    };
    });
  }

  integrity() {
    this.#open();
    return this.#read(() => {
    const issues = [];
    try {
      for (const row of this.#db.prepare('PRAGMA integrity_check').all()) if (row.integrity_check !== 'ok') issues.push(row.integrity_check);
      for (const row of this.#db.prepare('PRAGMA foreign_key_check').all()) issues.push(`Foreign key violation in ${row.table}`);
      const archive = this.#archiveRow();
      const graph = this.readGraph();
      const sourceRows = this.#db.prepare('SELECT * FROM ontology_source_documents ORDER BY position').all();
      if (Boolean(archive) !== Boolean(graph)) issues.push('Import marker and current graph disagree');
      if (!graph && (sourceRows.length || Object.values(this.#counts()).some(Boolean))) issues.push('Uninitialized store contains data; reseeding refused');
      if (graph) {
        validateOntologyGraph(graph);
        for (const [name, [table, columns]] of Object.entries(COLLECTIONS)) {
          const rows = this.#db.prepare(`SELECT * FROM ${table} ORDER BY position`).all();
          rows.forEach((row, position) => {
            if (row.position !== position) issues.push(`Non-contiguous ${name} order`);
            for (const [column, field] of Object.entries(columns)) if (row[column] !== (graph[name][position][field] ?? null)) issues.push(`Normalized ${name}.${column} disagrees with payload`);
          });
        }
      }
      if (archive) {
        if (sha256(archive.raw_graph) !== archive.raw_graph_hash || sha256(JSON.stringify(parseRaw(archive.raw_graph))) !== archive.graph_hash) issues.push('Original graph archive hash mismatch');
      }
      for (const row of sourceRows) if (sha256(row.bytes) !== row.sha256) issues.push(`Source archive hash mismatch: ${row.path}`);
    } catch (cause) { issues.push(cause.message); }
    return { ok: issues.length === 0, issues };
    });
  }

  // Data-only export: caller chooses a destination and its own overwrite policy.
  exportArchive() {
    this.#open();
    return this.#read(() => {
    const archive = this.#archiveRow();
    if (!archive) return null;
    const sourceDocuments = this.#db.prepare('SELECT path,bytes,sha256 FROM ontology_source_documents ORDER BY position').all().map(row => ({ ...row, bytes: Buffer.from(row.bytes) }));
    if (sha256(archive.raw_graph) !== archive.raw_graph_hash || sha256(JSON.stringify(parseRaw(archive.raw_graph))) !== archive.graph_hash
        || sourceDocuments.some(document => sha256(document.bytes) !== document.sha256)) fail('ONTOLOGY_STORE_CORRUPT', 'Original archive checksum failed; export refused', 500);
    return {
      graph: parseRaw(archive.raw_graph), rawGraphJson: Buffer.from(archive.raw_graph),
      graphHash: archive.graph_hash, rawGraphHash: archive.raw_graph_hash,
      sourceLabel: archive.source_label, importedAt: archive.imported_at,
      sourceDocuments,
    };
    });
  }
  close() { if (!this.#closed) { this.#db.close(); this.#closed = true; } }
}

export const openOntologyStore = options => new OntologyStore(options);
