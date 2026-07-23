#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..');
const ONTOLOGY_ROOT = path.join(REPO_ROOT, 'ontology');
const OUTPUT_PATH = path.join(
  REPO_ROOT,
  'apps/firefox-ui-demo/overlay/resources/ontology/graph.json'
);

async function walkMarkdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function parseScalar(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseIndentedObject(lines, startIndex) {
  const result = {};
  let i = startIndex;
  let currentKey = null;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (!line.startsWith(' ')) break;

    const keyMatch = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (keyMatch) {
      currentKey = keyMatch[1];
      const inline = keyMatch[2].trim();
      result[currentKey] = inline ? parseScalar(inline) : [];
      i += 1;
      continue;
    }

    const itemMatch = line.match(/^ {4}-\s*(.*)$/);
    if (itemMatch && currentKey) {
      if (!Array.isArray(result[currentKey])) result[currentKey] = [result[currentKey]].filter(Boolean);
      result[currentKey].push(parseScalar(itemMatch[1]));
    }
    i += 1;
  }
  return { value: result, nextIndex: i };
}

function parseIndentedList(lines, startIndex) {
  const result = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (!line.startsWith(' ')) break;

    const itemMatch = line.match(/^ {2}-\s*(.*)$/);
    if (itemMatch) result.push(parseScalar(itemMatch[1]));
    i += 1;
  }
  return { value: result, nextIndex: i };
}

function parseRelationEdges(rawFrontmatter) {
  const lines = rawFrontmatter.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === 'relation_edges:');
  if (start === -1) return [];

  const edges = [];
  let current = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (!line.startsWith(' ')) break;

    const itemMatch = line.match(/^ {2}-\s*source:\s*(.+)$/);
    if (itemMatch) {
      if (current) edges.push(current);
      current = { source: parseScalar(itemMatch[1]) };
      continue;
    }

    const fieldMatch = line.match(/^ {4}([A-Za-z0-9_.-]+):\s*(.+)$/);
    if (fieldMatch && current) {
      current[fieldMatch[1]] = parseScalar(fieldMatch[2]);
    }
  }
  if (current) edges.push(current);

  return edges.filter((edge) => edge.source && edge.relation && edge.target)
    .map((edge) => ({
      source: String(edge.source),
      relation: String(edge.relation),
      target: String(edge.target),
      note: edge.note ? String(edge.note) : undefined,
    }));
}

function parseRecordList(rawFrontmatter, key, firstField) {
  const lines = rawFrontmatter.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start === -1) return [];

  const records = [];
  let current = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (!line.startsWith(' ')) break;

    const itemMatch = line.match(new RegExp(`^ {2}-\\s*${firstField}:\\s*(.+)$`));
    if (itemMatch) {
      if (current) records.push(current);
      current = { [firstField]: parseScalar(itemMatch[1]) };
      continue;
    }

    const fieldMatch = line.match(/^ {4}([A-Za-z0-9_.-]+):\s*(.+)$/);
    if (fieldMatch && current) current[fieldMatch[1]] = parseScalar(fieldMatch[2]);
  }
  if (current) records.push(current);
  return records;
}

function parseOccurrences(rawFrontmatter) {
  return parseRecordList(rawFrontmatter, 'occurrences', 'ref_id')
    .filter((record) => record.ref_id && record.concept_id && record.layer)
    .map((record) => ({
      refId: String(record.ref_id),
      conceptId: String(record.concept_id),
      parentRef: record.parent_ref ? String(record.parent_ref) : null,
      relation: record.relation ? String(record.relation) : 'contains',
      layer: String(record.layer),
      label: record.label ? String(record.label) : '',
      order: Number.isFinite(record.order) ? record.order : undefined,
    }));
}

function parseReferenceEdges(rawFrontmatter) {
  return parseRecordList(rawFrontmatter, 'reference_edges', 'source_ref')
    .filter((record) => record.source_ref && record.relation && record.target_ref)
    .map((record) => ({
      sourceRef: String(record.source_ref),
      relation: String(record.relation),
      targetRef: String(record.target_ref),
      note: record.note ? String(record.note) : undefined,
    }));
}

function parseViewCells(rawFrontmatter) {
  const lines = rawFrontmatter.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === 'view_cells:');
  if (start === -1) return [];

  const cells = [];
  let current = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (!line.startsWith(' ')) break;

    const itemMatch = line.match(/^ {2}-\s*node:\s*(.+)$/);
    if (itemMatch) {
      if (current) cells.push(current);
      current = { node: parseScalar(itemMatch[1]) };
      continue;
    }

    const fieldMatch = line.match(/^ {4}([A-Za-z0-9_.-]+):\s*(.+)$/);
    if (fieldMatch && current) {
      current[fieldMatch[1]] = parseScalar(fieldMatch[2]);
    }
  }
  if (current) cells.push(current);

  return cells.filter((cell) => cell.node)
    .map((cell) => ({
      node: String(cell.node),
      view: cell.view ? String(cell.view) : '',
      timeSlice: cell.time_slice ? String(cell.time_slice) : '',
      runtimeStratum: cell.runtime_stratum ? String(cell.runtime_stratum) : '',
      role: cell.role ? String(cell.role) : 'projection',
      x: Number.isFinite(cell.x) ? cell.x : undefined,
      y: Number.isFinite(cell.y) ? cell.y : undefined,
      order: Number.isFinite(cell.order) ? cell.order : undefined,
    }));
}

function parseFrontmatter(markdown) {
  if (!markdown.startsWith('---\n')) return { data: {}, body: markdown };
  const end = markdown.indexOf('\n---', 4);
  if (end === -1) return { data: {}, body: markdown };
  const raw = markdown.slice(4, end);
  const body = markdown.slice(end + 4).replace(/^\n/, '');
  const lines = raw.split(/\r?\n/);
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) {
      i += 1;
      continue;
    }
    const key = match[1];
    const inline = match[2].trim();
    if (inline) {
      data[key] = parseScalar(inline);
      i += 1;
    } else {
      const nextIndented = lines.slice(i + 1).find((candidate) => candidate.trim());
      const nested = nextIndented?.match(/^ {2}-\s+/)
        ? parseIndentedList(lines, i + 1)
        : parseIndentedObject(lines, i + 1);
      data[key] = nested.value;
      i = nested.nextIndex;
    }
  }
  data.relation_edges = parseRelationEdges(raw);
  data.view_cells = parseViewCells(raw);
  data.occurrences = parseOccurrences(raw);
  data.reference_edges = parseReferenceEdges(raw);
  return { data, body };
}

function titleFromBody(body, fallback) {
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return fallback;
}

function extractWikiLinks(body) {
  const links = [];
  const regex = /\[\[([^\]\|#]+)(?:[|#][^\]]*)?\]\]/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    links.push(match[1].trim());
  }
  return Array.from(new Set(links));
}

function layerForId(id) {
  if (id.startsWith('projection.')) return 'projection';
  if (id.startsWith('time.')) return 'time';
  if (id.startsWith('reality.')) return 'reality';
  if (id.startsWith('architecture.') || id.startsWith('hardware.') || id.startsWith('surface.') || id.startsWith('repo.') || id.startsWith('desk.')) return 'architecture';
  if (id.startsWith('actor.')) return 'runtime';
  if (id.startsWith('source.') || id.startsWith('history.') || id.startsWith('logs.') || id.startsWith('revisions.')) return 'evidence';
  if (id.startsWith('operation.') || id.startsWith('output.') || id.startsWith('action.')) return 'operation';
  if (id.includes('future') || id.startsWith('goal') || id.startsWith('plan') || id.startsWith('task') || id.startsWith('vision')) return 'time';
  return 'ontology';
}

function syntheticTypeForId(id) {
  if (id.startsWith('projection.')) return 'projection';
  if (id.startsWith('action.')) return 'action';
  if (id.startsWith('facet.')) return 'facet';
  if (id.startsWith('entity.')) return 'canonical_entity';
  return 'reference';
}

function syntheticSummaryForId(id) {
  if (id.startsWith('projection.')) {
    return 'Projection node referenced by ontology relations; add a Markdown page if it needs durable body text.';
  }
  return 'Referenced concept without a dedicated Markdown page yet.';
}

function labelForId(id) {
  return id
    .split(/[./_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function normalizeRelationTargets(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (value == null || value === '') return [];
  return [String(value)];
}

function normalizeMetadataList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (value == null || value === '') return [];
  return [String(value)];
}

function normalizeAbbreviations(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([key, raw]) => [String(key), normalizeMetadataList(raw)])
    .filter(([, entries]) => entries.length));
}

async function main() {
  const files = await walkMarkdownFiles(ONTOLOGY_ROOT);
  const nodes = [];
  const pathToId = new Map();
  const sourceParts = [];

  for (const filePath of files) {
    const markdown = await readFile(filePath, 'utf8');
    sourceParts.push(markdown);
    const { data, body } = parseFrontmatter(markdown);
    const relativePath = path.relative(REPO_ROOT, filePath);
    const ontologyRelativePath = path.relative(ONTOLOGY_ROOT, filePath);
    const id = data.id || ontologyRelativePath.replace(/\.md$/, '').replace(/[\\/]/g, '.');
    const node = {
      id,
      label: titleFromBody(body, labelForId(id)),
      type: data.type || 'concept',
      layer: data.layer || layerForId(id),
      summary: data.summary || '',
      aliases: normalizeMetadataList(data.aliases),
      abbreviations: normalizeAbbreviations(data.abbreviations),
      path: relativePath,
      ontologyPath: ontologyRelativePath,
      relations: data.relations || {},
      relationEdges: data.relation_edges || [],
      viewCells: data.view_cells || [],
      subjectId: data.subject_id ? String(data.subject_id) : null,
      snapshotId: data.snapshot_id ? String(data.snapshot_id) : null,
      timeSlice: data.time_slice ? String(data.time_slice) : null,
      snapshotStatus: data.status ? String(data.status) : null,
      continuesFrom: data.continues_from ? String(data.continues_from) : null,
      rootRef: data.root_ref ? String(data.root_ref) : null,
      occurrences: data.occurrences || [],
      referenceEdges: data.reference_edges || [],
      wikiLinks: extractWikiLinks(body),
      body: body.trim(),
    };
    nodes.push(node);
    pathToId.set(ontologyRelativePath, id);
    pathToId.set(ontologyRelativePath.replace(/\.md$/, ''), id);
    pathToId.set(path.basename(ontologyRelativePath), id);
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const edges = [];

  for (const node of nodes) {
    for (const [relation, rawTargets] of Object.entries(node.relations || {})) {
      for (const target of normalizeRelationTargets(rawTargets)) {
        edges.push({
          id: `${node.id}:${relation}:${target}`,
          source: node.id,
          target,
          relation,
          kind: 'frontmatter',
        });
      }
    }
    for (const wikiTarget of node.wikiLinks || []) {
      const resolved = pathToId.get(wikiTarget) || pathToId.get(wikiTarget.replace(/^ontology\//, '')) || wikiTarget;
      edges.push({
        id: `${node.id}:wiki:${resolved}`,
        source: node.id,
        target: resolved,
        relation: 'wiki_link',
        kind: 'markdown',
      });
    }
    for (const edge of node.relationEdges || []) {
      edges.push({
        id: `${node.id}:declares:${edge.source}:${edge.relation}:${edge.target}`,
        source: edge.source,
        target: edge.target,
        relation: edge.relation,
        kind: 'relation_map',
        declaredBy: node.id,
        note: edge.note,
      });
    }
  }

  const referencedIds = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  for (const node of nodes) {
    for (const cell of node.viewCells || []) referencedIds.add(cell.node);
  }
  const missingTargets = Array.from(referencedIds)
    .filter((target) => !nodesById.has(target))
    .sort((a, b) => a.localeCompare(b));

  for (const id of missingTargets) {
    nodes.push({
      id,
      label: labelForId(id),
      type: syntheticTypeForId(id),
      layer: layerForId(id),
      summary: syntheticSummaryForId(id),
      aliases: [],
      abbreviations: {},
      path: null,
      ontologyPath: null,
      relations: {},
      relationEdges: [],
      viewCells: [],
      subjectId: null,
      snapshotId: null,
      timeSlice: null,
      snapshotStatus: null,
      continuesFrom: null,
      rootRef: null,
      occurrences: [],
      referenceEdges: [],
      wikiLinks: [],
      body: '',
      synthetic: true,
    });
  }

  const allowedTimeSlices = new Set(['past', 'present', 'future']);
  const allowedRuntimeStrata = new Set(['virtual', 'physical']);
  const allowedViewRoles = new Set(['projection', 'identity_anchor']);
  const viewCellKeys = new Set();
  for (const owner of nodes) {
    for (const cell of owner.viewCells || []) {
      if (!cell.view || !cell.timeSlice || !cell.runtimeStratum) {
        throw new Error(`Incomplete view_cells entry in ${owner.id} for ${cell.node}`);
      }
      if (!allowedTimeSlices.has(cell.timeSlice)) {
        throw new Error(`Invalid view_cells time_slice '${cell.timeSlice}' in ${owner.id} for ${cell.node}`);
      }
      if (!allowedRuntimeStrata.has(cell.runtimeStratum)) {
        throw new Error(`Invalid view_cells runtime_stratum '${cell.runtimeStratum}' in ${owner.id} for ${cell.node}`);
      }
      if (!allowedViewRoles.has(cell.role)) {
        throw new Error(`Invalid view_cells role '${cell.role}' in ${owner.id} for ${cell.node}`);
      }
      if (!nodes.some((node) => node.id === cell.node)) {
        throw new Error(`Unknown view_cells node '${cell.node}' in ${owner.id}`);
      }
      const cellNode = nodes.find((node) => node.id === cell.node);
      const isCanonical = cellNode?.type === 'canonical_entity' || cell.node.startsWith('entity.');
      if (isCanonical && cell.role !== 'identity_anchor') {
        throw new Error(`Canonical view_cells node '${cell.node}' must declare role: identity_anchor in ${owner.id}`);
      }
      if (!isCanonical && cell.role === 'identity_anchor') {
        throw new Error(`identity_anchor role requires a canonical node in ${owner.id} for ${cell.node}`);
      }
      if ((cell.x !== undefined && (cell.x < 0 || cell.x > 1)) || (cell.y !== undefined && (cell.y < 0 || cell.y > 1))) {
        throw new Error(`view_cells coordinates must be within 0..1 in ${owner.id} for ${cell.node}`);
      }
      const key = `${owner.id}:${cell.view}:${cell.node}`;
      if (viewCellKeys.has(key)) throw new Error(`Duplicate view_cells home for ${key}`);
      viewCellKeys.add(key);
    }
  }

  const snapshots = nodes
    .filter((node) => node.type === 'composite_snapshot')
    .map((node) => ({
      id: node.id,
      subjectId: node.subjectId,
      snapshotId: node.snapshotId,
      timeSlice: node.timeSlice,
      status: node.snapshotStatus,
      continuesFrom: node.continuesFrom,
      rootRef: node.rootRef,
      sourcePath: node.path,
      label: node.label,
      occurrences: node.occurrences,
      referenceEdges: node.referenceEdges,
    }));
  const allowedSnapshotStatuses = new Set(['observed', 'planned', 'historical']);
  const snapshotIds = new Set();
  const allOccurrences = [];
  for (const snapshot of snapshots) {
    if (!snapshot.subjectId || !snapshot.snapshotId || !snapshot.timeSlice || !snapshot.rootRef) {
      throw new Error(`Incomplete composite snapshot fields in ${snapshot.id}`);
    }
    if (!allowedTimeSlices.has(snapshot.timeSlice)) {
      throw new Error(`Invalid snapshot time_slice '${snapshot.timeSlice}' in ${snapshot.id}`);
    }
    if (!allowedSnapshotStatuses.has(snapshot.status)) {
      throw new Error(`Invalid snapshot status '${snapshot.status}' in ${snapshot.id}`);
    }
    if (snapshotIds.has(snapshot.snapshotId)) throw new Error(`Duplicate snapshot_id '${snapshot.snapshotId}'`);
    snapshotIds.add(snapshot.snapshotId);

    const refIds = new Set();
    for (const occurrence of snapshot.occurrences) {
      if (refIds.has(occurrence.refId)) throw new Error(`Duplicate ref_id '${occurrence.refId}' in ${snapshot.id}`);
      refIds.add(occurrence.refId);
      if (!allowedRuntimeStrata.has(occurrence.layer)) {
        throw new Error(`Invalid occurrence layer '${occurrence.layer}' in ${snapshot.id} for ${occurrence.refId}`);
      }
      if (!nodes.some((node) => node.id === occurrence.conceptId)) {
        throw new Error(`Unknown occurrence concept_id '${occurrence.conceptId}' in ${snapshot.id}`);
      }
      allOccurrences.push({
        ...occurrence,
        snapshotDocId: snapshot.id,
        snapshotId: snapshot.snapshotId,
        subjectId: snapshot.subjectId,
        timeSlice: snapshot.timeSlice,
        status: snapshot.status,
      });
    }
    if (!refIds.has(snapshot.rootRef)) throw new Error(`Unknown root_ref '${snapshot.rootRef}' in ${snapshot.id}`);
    for (const occurrence of snapshot.occurrences) {
      if (occurrence.parentRef && !refIds.has(occurrence.parentRef)) {
        throw new Error(`Unknown parent_ref '${occurrence.parentRef}' in ${snapshot.id} for ${occurrence.refId}`);
      }
      const visited = new Set([occurrence.refId]);
      let parentRef = occurrence.parentRef;
      while (parentRef) {
        if (visited.has(parentRef)) throw new Error(`Occurrence parent cycle in ${snapshot.id} at ${occurrence.refId}`);
        visited.add(parentRef);
        parentRef = snapshot.occurrences.find((candidate) => candidate.refId === parentRef)?.parentRef || null;
      }
    }
  }
  for (const snapshot of snapshots) {
    if (snapshot.continuesFrom && !snapshotIds.has(snapshot.continuesFrom)) {
      throw new Error(`Unknown continues_from '${snapshot.continuesFrom}' in ${snapshot.id}`);
    }
  }
  const occurrenceIds = new Set(allOccurrences.map((occurrence) => occurrence.refId));
  const referenceEdges = snapshots.flatMap((snapshot) => snapshot.referenceEdges.map((edge, index) => ({
    id: `${snapshot.id}:reference:${index}:${edge.sourceRef}:${edge.relation}:${edge.targetRef}`,
    ...edge,
    declaredBy: snapshot.id,
  })));
  for (const edge of referenceEdges) {
    if (!occurrenceIds.has(edge.sourceRef) || !occurrenceIds.has(edge.targetRef)) {
      throw new Error(`Unknown reference edge endpoint '${edge.sourceRef}' -> '${edge.targetRef}' in ${edge.declaredBy}`);
    }
  }

  const graph = {
    schemaVersion: 3,
    sourceRoot: 'ontology',
    sourceHash: createHash('sha1').update(sourceParts.join('\n---SOURCE---\n')).digest('hex'),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.sort((a, b) => a.id.localeCompare(b.id)),
    snapshots: snapshots.sort((a, b) => a.snapshotId.localeCompare(b.snapshotId)),
    occurrences: allOccurrences.sort((a, b) => a.refId.localeCompare(b.refId)),
    referenceEdges: referenceEdges.sort((a, b) => a.id.localeCompare(b.id)),
  };

  const serialized = `${JSON.stringify(graph, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const existing = await readFile(OUTPUT_PATH, 'utf8').catch(() => '');
    if (existing !== serialized) {
      throw new Error(`Ontology graph is stale. Run: npm run ontology:graph`);
    }
    console.log(`Ontology graph is current (${graph.nodeCount} nodes, ${graph.edgeCount} edges)`);
    return;
  }

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, serialized, 'utf8');
  console.log(`Wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)} (${graph.nodeCount} nodes, ${graph.edgeCount} edges)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
