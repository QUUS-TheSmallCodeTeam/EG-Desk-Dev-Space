import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// SQLite fixed the WAL-reset bug in 3.51.3 and backported the fix only to
// the 3.50.x and 3.44.x branches. Do not treat the intervening versions as safe.
export function isPatchedSqliteVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major, minor, patch] = version.split('.').map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger) || major !== 3) return false;
  return minor > 51 || (minor === 51 && patch >= 3)
    || (minor === 50 && patch >= 7) || (minor === 44 && patch >= 6);
}

// Probe the actual SQLite library, not merely the Node release number. The
// database is in memory and no user database, journal, or profile is opened.
export function inspectSqliteRuntime() {
  const nodeVersion = process.versions.node || 'unknown';
  let sqliteVersion = null;
  let error = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(':memory:');
    try {
      sqliteVersion = database.prepare('SELECT sqlite_version() AS version').get().version;
    } finally {
      database.close();
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const patched = error === null && isPatchedSqliteVersion(sqliteVersion);
  const nodeMajor = /^\d+\./.test(nodeVersion) ? Number(nodeVersion.split('.')[0]) : 0;
  return { nodeVersion, sqliteVersion, patched, supported: nodeMajor >= 24 && patched, error };
}

// Call before opening any persistent EG-Desk store. Callers may use the
// returned information for diagnostics, but cannot bypass a failed probe.
export function assertPatchedSqliteRuntime() {
  const runtime = inspectSqliteRuntime();
  if (!runtime.supported) {
    const detail = runtime.error ? `; probe failed: ${runtime.error}` : '';
    throw Object.assign(new Error(`EG-Desk requires Node.js 24+ and SQLite 3.51.3+, `
      + `3.50.x >= 3.50.7, or 3.44.x >= 3.44.6. Found Node ${runtime.nodeVersion}, `
      + `SQLite ${runtime.sqliteVersion || 'unavailable'}${detail}. Use the project's pinned Node runtime.`),
    { code: 'EGDESK_SQLITE_RUNTIME_UNSAFE' });
  }
  return runtime;
}
