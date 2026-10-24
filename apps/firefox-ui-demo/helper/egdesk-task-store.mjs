import { createHash } from 'node:crypto';
import { openWorkflowStore, readLegacyFile } from './egdesk-workflow-store.mjs';

const LEGACY_FILE = 'task-events.json';

function digest(events) {
  return createHash('sha256').update(JSON.stringify(events)).digest('hex');
}

function corrupt(message) {
  const error = new Error(message);
  error.code = 'E_TASK_STORE_CORRUPT';
  return error;
}

function conflict(message) {
  const error = new Error(message);
  error.code = 'E_TASK_STORE_CONFLICT';
  return error;
}

function checkSequence(events, offset = 0) {
  events.forEach((event, index) => {
    if (!event || typeof event !== 'object' || Array.isArray(event) || event.seq !== offset + index + 1 ||
        typeof event.at !== 'string' || typeof event.type !== 'string') {
      throw corrupt('Task journal events are out of sequence');
    }
  });
}

// The JSON journal written before RT-07, checked exactly as it was read then.
function legacyJournal(directory) {
  const bytes = readLegacyFile(directory, LEGACY_FILE);
  if (bytes === null) return null;
  let envelope;
  try {
    envelope = JSON.parse(bytes);
  } catch {
    throw corrupt('Task journal is not valid JSON');
  }
  if (envelope?.version !== 1 || !Array.isArray(envelope.events) ||
      typeof envelope.digest !== 'string' || envelope.digest !== digest(envelope.events)) {
    throw corrupt('Task journal failed its version or checksum check');
  }
  checkSequence(envelope.events);
  return envelope;
}

/**
 * Single-writer, app-owned local journal on the workflow SQLite store
 * (egdesk-workflow-store.mjs): each save appends only the events after the
 * last saved one, so saving does not grow with the history.
 *
 * openTaskStore(directory)                       own store in that dedicated directory
 * openTaskStore({ store, legacyDirectory? })     a shared workflow store
 *   -> { directory, load(), save(events), close() }
 *
 * The first load imports a task-events.json written before (in the directory,
 * or legacyDirectory) once and leaves that file untouched. A corrupt journal,
 * old or new, is reported by load() and left in place for inspection, never
 * reset or overwritten. save() refuses a writer whose view is stale
 * (E_TASK_STORE_CONFLICT) and any change to saved history.
 */
export async function openTaskStore(target) {
  const shared = target !== null && typeof target === 'object';
  if (shared && typeof target.store?.events?.append !== 'function') throw new TypeError('A workflow store is required');
  const store = shared ? target.store : openWorkflowStore({ directory: target });
  const legacyDirectory = shared ? target.legacyDirectory ?? null : target;
  let knownCount;
  let lastJson = null;

  function importLegacy() {
    if (!legacyDirectory) return;
    store.legacy.importOnce('task-events', () => {
      const envelope = legacyJournal(legacyDirectory);
      if (!envelope) return { source: 'none' };
      // Rows written here are newer than any file; never mix the two.
      if (store.events.count() > 0) return { source: 'kept-existing' };
      store.events.append(0, envelope.events);
      return { source: LEGACY_FILE, events: envelope.events.length, digest: envelope.digest };
    });
  }

  return {
    directory: shared ? store.directory : target,
    async load() {
      importLegacy();
      const rows = store.events.rows();
      const events = rows.map((row) => {
        try {
          return JSON.parse(row.json);
        } catch {
          throw corrupt('Task journal row is not valid JSON');
        }
      });
      checkSequence(events);
      knownCount = events.length;
      lastJson = rows.at(-1)?.json ?? null;
      return events;
    },
    async save(events) {
      if (!Array.isArray(events) || knownCount === undefined) {
        throw new TypeError('Load the task journal before saving events');
      }
      if (events.length < knownCount ||
          (knownCount > 0 && JSON.stringify(events[knownCount - 1]) !== lastJson)) {
        throw conflict('Saved task history cannot be rewritten');
      }
      const tail = events.slice(knownCount);
      if (!tail.length) return;
      try {
        checkSequence(tail, knownCount);
      } catch {
        throw new TypeError('New task events must continue the journal sequence');
      }
      try {
        store.events.append(knownCount, tail);
      } catch (error) {
        if (error.code === 'WORKFLOW_STORE_CONFLICT') throw conflict('Task journal changed outside this writer');
        throw error;
      }
      knownCount = events.length;
      lastJson = JSON.stringify(events.at(-1));
    },
    close() {
      if (!shared) store.close();
    },
  };
}
