import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openOntologyStore, validateOntologyGraph } from './egdesk-ontology-store.mjs';

const fail = (message, code = 'INVALID_ONTOLOGY_SOURCE') => { throw Object.assign(new Error(message), { code, httpStatus: 400 }); };

function markdownFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail(`Symlinks are not allowed in the source archive: ${filename}`);
    if (entry.isDirectory()) files.push(...markdownFiles(filename));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(filename);
  }
  // Match generate-ontology-graph.mjs, including its locale ordering.
  return files.sort((a, b) => a.localeCompare(b));
}

/** Read-only source preparation. No database is opened and no source is rewritten. */
export function readOntologySeed({ graphPath, ontologyRoot, sourceLabel = graphPath } = {}) {
  if (typeof graphPath !== 'string' || !path.isAbsolute(graphPath) || typeof ontologyRoot !== 'string' || !path.isAbsolute(ontologyRoot)) fail('Absolute graphPath and ontologyRoot are required');
  if (!lstatSync(graphPath).isFile() || lstatSync(graphPath).isSymbolicLink()) fail('Graph source must be a regular, non-symlink file');
  const root = realpathSync.native(ontologyRoot);
  if (!lstatSync(ontologyRoot).isDirectory() || lstatSync(ontologyRoot).isSymbolicLink()) fail('Ontology source root must be a non-symlink directory');
  const rawGraphJson = readFileSync(graphPath);
  let graph;
  try { graph = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawGraphJson).replace(/^\uFEFF/, '')); }
  catch { fail('Graph source is not UTF-8 JSON'); }
  validateOntologyGraph(graph);
  if (typeof graph.sourceRoot !== 'string' || !graph.sourceRoot || path.isAbsolute(graph.sourceRoot)
      || graph.sourceRoot.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) fail('Graph sourceRoot must be a relative source directory');
  const sources = new Map();
  const sourceParts = [];
  for (const filename of markdownFiles(root)) {
    const content = readFileSync(filename);
    const sourcePath = path.posix.join(graph.sourceRoot, path.relative(root, filename).split(path.sep).join('/'));
    sources.set(sourcePath, { path: sourcePath, bytes: content, sha256: createHash('sha256').update(content).digest('hex') });
    sourceParts.push(content.toString('utf8'));
  }
  const sourceHash = createHash('sha1').update(sourceParts.join('\n---SOURCE---\n')).digest('hex');
  if (graph.sourceHash !== sourceHash) fail('Ontology graph and Markdown sources differ. Regenerate the graph (npm run ontology:graph) before importing; no database was opened.', 'ONTOLOGY_STALE_SEED');
  for (const node of graph.nodes) {
    if (node.path == null) continue;
    if (typeof node.path !== 'string' || typeof node.ontologyPath !== 'string' || !node.ontologyPath || path.isAbsolute(node.ontologyPath)) fail(`Invalid source path for ${node.id}`);
    const filename = path.resolve(root, node.ontologyPath);
    const relative = path.relative(root, filename);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) fail(`Source escapes ontology root: ${node.id}`);
    if (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink() || realpathSync.native(filename) !== filename) fail(`Source must be a non-symlink file: ${node.id}`);
    const expectedPath = path.posix.join(graph.sourceRoot, relative.split(path.sep).join('/'));
    if (node.path !== expectedPath || !sources.has(node.path)) fail(`Graph source path does not match the archived document: ${node.id}`);
  }
  return { graph, rawGraphJson, sourceDocuments: [...sources.values()], sourceLabel };
}

/** Explicit one-time migration only. An initialized store is never reseeded. */
export function migrateOntologyGraph({ dbPath, graphPath, ontologyRoot, sourceLabel } = {}) {
  const seed = readOntologySeed({ graphPath, ontologyRoot, sourceLabel });
  const store = openOntologyStore({ dbPath });
  try {
    const imported = store.importGraph(seed.graph, seed);
    return { ...imported, integrity: store.integrity() };
  } finally { store.close(); }
}
