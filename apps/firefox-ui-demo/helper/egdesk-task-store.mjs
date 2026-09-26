import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const FILE_NAME = 'task-events.json';

function digest(events) {
  return createHash('sha256').update(JSON.stringify(events)).digest('hex');
}

function corrupt(message) {
  const error = new Error(message);
  error.code = 'E_TASK_STORE_CORRUPT';
  return error;
}

/**
 * Single-writer, app-owned local journal. The caller chooses a dedicated absolute
 * directory; this module never discovers a user directory or stores task payloads.
 * A corrupt journal is left in place for inspection, not reset or overwritten.
 */
export async function openTaskStore(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory === path.parse(directory).root) {
    throw new TypeError('A dedicated absolute task-store directory is required');
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new TypeError('Task-store directory must be a real directory');
  }
  if ((typeof process.getuid === 'function' && directoryStat.uid !== process.getuid()) ||
      (directoryStat.mode & 0o077) !== 0) {
    throw new TypeError('Task-store directory must be owned by this user and private (0700)');
  }

  const file = path.join(directory, FILE_NAME);
  let knownDigest;

  async function readEnvelope() {
    let bytes;
    try {
      bytes = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
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
    return envelope;
  }

  return {
    directory,
    async load() {
      const envelope = await readEnvelope();
      knownDigest = envelope?.digest ?? null;
      return envelope ? structuredClone(envelope.events) : [];
    },
    async save(events) {
      if (!Array.isArray(events) || knownDigest === undefined) {
        throw new TypeError('Load the task journal before saving events');
      }
      const current = await readEnvelope();
      if ((current?.digest ?? null) !== knownDigest) {
        const error = new Error('Task journal changed outside this writer');
        error.code = 'E_TASK_STORE_CONFLICT';
        throw error;
      }
      const nextDigest = digest(events);
      const temporary = path.join(directory, `.task-events-${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ version: 1, digest: nextDigest, events }));
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporary, file);
        const dirHandle = await fs.open(directory, 'r');
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
        knownDigest = nextDigest;
      } catch (error) {
        if (handle) await handle.close();
        await fs.unlink(temporary).catch((unlinkError) => {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        });
        throw error;
      }
    },
  };
}
