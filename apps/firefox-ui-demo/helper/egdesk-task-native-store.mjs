import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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

/** Single writer; dedicated app-owned directory, separate from the graph journal.
 * Only IDs, intent hashes and native evidence metadata are allowed. No resolved
 * message, profile prompt, context payload, credentials, or event text is stored.
 * Corruption is preserved and reported; opening never resets a failed ledger.
 */
export async function openNativeTaskLedger(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory === path.parse(directory).root) {
    throw new TypeError('A dedicated absolute native-ledger directory is required');
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new TypeError('Native ledger directory must be private and owned by this user');
  }
  const filename = path.join(directory, 'native-task-ledger.json');
  async function read() {
    let bytes;
    try { bytes = await fs.readFile(filename, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const envelope = JSON.parse(bytes);
      validate(envelope.state);
      if (envelope.digest !== nativeHash(envelope.state)) throw new Error('checksum');
      return envelope;
    } catch { throw nativeTaskError('NATIVE_LEDGER_CORRUPT', 'Native task ledger failed validation'); }
  }
  const loaded = await read();
  let state = loaded?.state ?? { version: 1, revision: 0, graphs: [], attempts: [], approvals: [], boardFences: [] };
  let digest = loaded?.digest ?? null;
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
        if ((await read())?.digest !== (digest ?? undefined)) {
          throw nativeTaskError('NATIVE_LEDGER_CONFLICT', 'Native ledger changed outside this writer');
        }
        const nextDigest = nativeHash(next);
        const temporary = path.join(directory, `.native-task-${randomUUID()}.tmp`);
        let handle;
        try {
          handle = await fs.open(temporary, 'wx', 0o600);
          await handle.writeFile(JSON.stringify({ digest: nextDigest, state: next }));
          await handle.sync();
          await handle.close();
          handle = null;
          await fs.rename(temporary, filename);
          const directoryHandle = await fs.open(directory, 'r');
          try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
          state = next;
          digest = nextDigest;
          return structuredClone(result);
        } finally {
          if (handle) await handle.close();
          await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        }
      });
      queue = work.catch(() => {});
      return work;
    },
  };
}
