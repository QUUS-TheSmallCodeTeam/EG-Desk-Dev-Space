import { createHash } from 'node:crypto';
import path from 'node:path';
import { LEDGER_COLLECTIONS, openWorkflowStore, readLegacyFile } from './egdesk-workflow-store.mjs';

const LEGACY_FILE = 'native-task-ledger.json';

export function nativeTaskError(code, message, httpStatus = 409) {
  return Object.assign(new Error(message), { code, httpStatus });
}

export function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function nativeHash(value) {
  return createHash('sha256').update(stableJSON(value)).digest('hex');
}

function shape(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key))) {
    throw nativeTaskError('NATIVE_LEDGER_CORRUPT', 'Invalid native ledger record');
  }
}

const SCOPE = ['graphId', 'requestId', 'runId', 'parentTaskId', 'requestedBy'];
const BINDING = [...SCOPE, 'taskId', 'ownerId', 'sourceRef', 'attemptId'];
function refs(value, keys) {
  shape(value, keys);
  if (keys.some((key) => !Object.hasOwn(value, key) ||
      (value[key] !== null && (typeof value[key] !== 'string' || value[key].length > 2048 ||
        /[\u0000-\u001f]/.test(value[key]))))) {
    throw nativeTaskError('NATIVE_LEDGER_CORRUPT', 'Invalid native ledger reference');
  }
}

function receipt(value) {
  if (value === null) return;
  shape(value, ['receiptId', 'outcome', 'binding', 'evidenceRefs']);
  refs(value.binding, BINDING);
  if (typeof value.receiptId !== 'string' ||
      !['completed', 'failed', 'cancelled', 'approved', 'rejected'].includes(value.outcome) ||
      !Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 32 ||
      value.evidenceRefs.some((ref) => typeof ref !== 'string' || ref.length > 256)) {
    throw nativeTaskError('NATIVE_LEDGER_CORRUPT', 'Invalid native receipt');
  }
}

function proof(value) {
  if (value === null) return;
  shape(value, ['kind', 'native', 'requestId', 'status', 'stopConfirmed', 'streamId', 'seq']);
  refs(value.native, ['conversationId', 'runId', 'answerId']);
  if (!['run.started', 'run.completed', 'resume-snapshot'].includes(value.kind) ||
      ![null, 'inProgress', 'completed', 'failed', 'interrupted'].includes(value.status) ||
      typeof value.stopConfirmed !== 'boolean' || typeof value.streamId !== 'string' ||
      !Number.isSafeInteger(value.seq) || value.seq < 0) {
    throw nativeTaskError('NATIVE_LEDGER_CORRUPT', 'Invalid native proof');
  }
}

function authority(value, generation = true) {
  shape(value, ['ownerKey', 'delegationKey', ...(generation ? ['generation'] : [])]);
  if (typeof value.ownerKey !== 'string' || typeof value.delegationKey !== 'string' ||
      (generation && !['string', 'number'].includes(typeof value.generation))) {
    throw nativeTaskError('NATIVE_LEDGER_CORRUPT', 'Invalid task authority reference');
  }
}

function validate(state) {
  shape(state, ['version', 'revision', 'graphs', 'attempts', 'approvals', 'boardFences']);
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      ['graphs', 'attempts', 'approvals', 'boardFences'].some((key) =>
        !Array.isArray(state[key]) || state[key].length > 10000)) {
    throw nativeTaskError('NATIVE_LEDGER_CORRUPT', 'Invalid native ledger version or collections');
  }
  for (const graph of state.graphs) {
    shape(graph, ['boardId', 'scope', 'tasks', 'fingerprint', 'fenced', 'authority']);
    refs(graph.scope, SCOPE);
    authority(graph.authority, false);
    if (typeof graph.boardId !== 'string' || typeof graph.fingerprint !== 'string' ||
        typeof graph.fenced !== 'boolean' || !Array.isArray(graph.tasks) || graph.tasks.length > 256) {
      throw nativeTaskError('NATIVE_LEDGER_CORRUPT', 'Invalid graph ownership');
    }
    for (const task of graph.tasks) {
      shape(task, ['taskId', 'ownerId', 'sourceRef', 'dependsOn', 'approvalRequired']);
      if (!Array.isArray(task.dependsOn) || task.dependsOn.some((id) => typeof id !== 'string')) {
        throw nativeTaskError('NATIVE_LEDGER_CORRUPT', 'Invalid task dependencies');
      }
    }
  }
  for (const attempt of state.attempts) {
    shape(attempt, ['key', 'binding', 'boardId', 'requestId', 'clientThreadId', 'candidateConversationId', 'inputHash',
      'phase', 'native', 'observed', 'interruptRequested', 'interruptSent', 'receipt', 'proof', 'authority']);
    refs(attempt.binding, BINDING);
    authority(attempt.authority);
    if (attempt.native !== null) refs(attempt.native, ['conversationId', 'runId', 'answerId']);
    if (attempt.candidateConversationId !== null &&
        (typeof attempt.candidateConversationId !== 'string' || !attempt.candidateConversationId ||
          attempt.candidateConversationId.length > 2048 || /[\u0000-\u001f]/.test(attempt.candidateConversationId))) {
      throw nativeTaskError('NATIVE_LEDGER_CORRUPT', 'Invalid candidate native conversation');
    }
    if (!['intent', 'accepted', 'unknown', 'terminal'].includes(attempt.phase) ||
        !Array.isArray(attempt.observed) || attempt.observed.length > 16 ||
        typeof attempt.interruptRequested !== 'boolean' || typeof attempt.interruptSent !== 'boolean') {
      throw nativeTaskError('NATIVE_LEDGER_CORRUPT', 'Invalid native attempt');
    }
    attempt.observed.forEach(proof);
    receipt(attempt.receipt);
    proof(attempt.proof);
  }
  for (const approval of state.approvals) {
    shape(approval, ['approvalId', 'boardId', 'binding', 'status', 'receipt', 'authority']);
    refs(approval.binding, BINDING);
    authority(approval.authority);
    if (!['pending', 'approved', 'rejected', 'cancelled'].includes(approval.status)) {
      throw nativeTaskError('NATIVE_LEDGER_CORRUPT', 'Invalid task preapproval');
    }
    receipt(approval.receipt);
  }
  for (const fence of state.boardFences) refs(fence, ['boardId', 'requestedBy']);
}

/**
 * Single writer on the workflow SQLite store (egdesk-workflow-store.mjs).
 * Only IDs, intent hashes and native evidence metadata are allowed. No resolved
 * message, profile prompt, context payload, credentials, or event text is stored.
 * Each change writes only the ledger rows that changed plus the new revision and
 * digest, in one transaction; a writer whose revision is stale is refused.
 * Corruption is preserved and reported; opening never resets a failed ledger.
 *
 * openNativeTaskLedger(directory)                    own store in that dedicated directory
 * openNativeTaskLedger({ store, legacyDirectory? })  a shared workflow store
 *   -> { snapshot(), transact(change), drain(), close() }
 * Opening imports a native-task-ledger.json written before (in the directory, or
 * legacyDirectory) once; that file is left untouched.
 */
export async function openNativeTaskLedger(target) {
  const shared = target !== null && typeof target === 'object';
  if (shared && typeof target.store?.ledger?.write !== 'function') throw new TypeError('A workflow store is required');
  if (!shared && (typeof target !== 'string' || !path.isAbsolute(target) || target === path.parse(target).root)) {
    throw new TypeError('A dedicated absolute native-ledger directory is required');
  }
  let store;
  try {
    store = shared ? target.store : openWorkflowStore({ directory: target });
  } catch (error) {
    if (error instanceof TypeError) throw new TypeError('Native ledger directory must be private and owned by this user');
    throw error;
  }
  const legacyDirectory = shared ? target.legacyDirectory ?? null : target;
  const corrupt = () => nativeTaskError('NATIVE_LEDGER_CORRUPT', 'Native task ledger failed validation');
  const rowsOf = (state) => Object.fromEntries(LEDGER_COLLECTIONS.map((name) => [name, state[name].map((row) => JSON.stringify(row))]));
  let loaded;
  try {
    if (legacyDirectory) {
      store.legacy.importOnce('native-ledger', () => {
        const bytes = readLegacyFile(legacyDirectory, LEGACY_FILE);
        if (bytes === null) return { source: 'none' };
        let envelope;
        try {
          envelope = JSON.parse(bytes);
          validate(envelope.state);
          if (envelope.digest !== nativeHash(envelope.state)) throw new Error('checksum');
        } catch { throw corrupt(); }
        // Rows written here are newer than any file; never mix the two.
        if (store.ledger.read()) return { source: 'kept-existing' };
        const rows = rowsOf(envelope.state);
        store.ledger.write({ expectedDigest: null, revision: envelope.state.revision, digest: envelope.digest,
          changes: LEDGER_COLLECTIONS.flatMap((collection) => rows[collection].map((json, pos) => ({ collection, pos, json }))) });
        return { source: LEGACY_FILE, revision: envelope.state.revision, digest: envelope.digest };
      });
    }
    const stored = store.ledger.read();
    if (stored) {
      try {
        const state = { version: 1, revision: stored.revision };
        for (const name of LEDGER_COLLECTIONS) state[name] = stored.rows[name].map((json) => JSON.parse(json));
        validate(state);
        if (stored.digest !== nativeHash(state)) throw new Error('checksum');
        loaded = { state, digest: stored.digest, rows: stored.rows };
      } catch { throw corrupt(); }
    }
  } catch (error) {
    if (!shared) store.close();
    if (error.code === 'NATIVE_LEDGER_CORRUPT' || error instanceof TypeError) throw error;
    if (error.code === 'WORKFLOW_STORE_CORRUPT') throw corrupt();
    throw error;
  }
  let state = loaded?.state ?? { version: 1, revision: 0, graphs: [], attempts: [], approvals: [], boardFences: [] };
  let digest = loaded?.digest ?? null;
  let rows = loaded?.rows ?? rowsOf(state);
  let queue = Promise.resolve();
  return {
    snapshot() { return structuredClone(state); },
    transact(change) {
      const work = queue.then(async () => {
        const next = structuredClone(state);
        const result = change(next);
        if (result?.then) throw new TypeError('Ledger mutation must be synchronous');
        if (stableJSON(next) === stableJSON(state)) return structuredClone(result);
        next.revision = state.revision + 1;
        validate(next);
        const nextDigest = nativeHash(next);
        const nextRows = rowsOf(next);
        const changes = [];
        for (const collection of LEDGER_COLLECTIONS) {
          const before = rows[collection];
          const after = nextRows[collection];
          after.forEach((json, pos) => { if (before[pos] !== json) changes.push({ collection, pos, json }); });
          for (let pos = after.length; pos < before.length; pos += 1) changes.push({ collection, pos, json: null });
        }
        try {
          store.ledger.write({ expectedDigest: digest, revision: next.revision, digest: nextDigest, changes });
        } catch (error) {
          if (error.code === 'WORKFLOW_STORE_CONFLICT') {
            throw nativeTaskError('NATIVE_LEDGER_CONFLICT', 'Native ledger changed outside this writer');
          }
          throw error;
        }
        state = next;
        digest = nextDigest;
        rows = nextRows;
        return structuredClone(result);
      });
      queue = work.catch(() => {});
      return work;
    },
    /** Resolves once every change already queued has been written or refused. */
    drain() { return queue; },
    close() { if (!shared) store.close(); },
  };
}
