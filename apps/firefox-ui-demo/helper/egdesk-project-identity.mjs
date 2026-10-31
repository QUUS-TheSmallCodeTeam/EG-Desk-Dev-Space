// Folder identity for Board project folders (CODE-02, D-X3). Pure: no I/O.
//
// A project folder is remembered by its verified real path plus the
// filesystem identity (dev/ino) seen when the user picked it. After a restart
// the folder reconnects by itself only when the folder now at the stored path
// still has that identity; a missing, replaced or renamed-over folder is
// reported so the screen asks the user to pick it again. Nothing here grants
// a root, registers a path or reads the filesystem — callers pass the lstat.
//
// Used by egdesk-project-store.mjs (stored identity) and egdesk-file-http.mjs
// (live root ↔ stored project comparison before every project use).

export const PROJECT_RECONNECT_STATES = Object.freeze(['connected', 'missing', 'not-a-directory', 'identity-changed'])

/** {dev, ino} as number, bigint or digit string → {dev, ino} as digit strings; null when it is not an identity. */
export function normalizeFolderIdentity(identity) {
  if (!identity || typeof identity !== 'object') return null
  const dev = String(identity.dev), ino = String(identity.ino)
  if (!/^\d+$/.test(dev) || !/^\d+$/.test(ino)) return null
  return { dev, ino }
}

export function sameFolderIdentity(left, right) {
  const a = normalizeFolderIdentity(left), b = normalizeFolderIdentity(right)
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino
}

/**
 * A described live root {absolutePath, identity} against a stored project
 * {workspaceRoot, identity}: the same real path and the same dev/ino. A path
 * match alone is never enough (a folder replaced at the same path differs).
 */
export function sameProjectFolder(described, project) {
  return !!described && !!project && typeof described.absolutePath === 'string' && described.absolutePath !== ''
    && described.absolutePath === project.workspaceRoot && sameFolderIdentity(described.identity, project.identity)
}

/**
 * Stored project + the current lstat of its workspaceRoot (bigint or number
 * stat; null when the path is gone) → reconnect state. Only 'connected'
 * allows the automatic reconnect of D-X3.
 */
export function projectReconnectState(project, stat) {
  if (!stat) return 'missing'
  if (!stat.isDirectory?.() || stat.isSymbolicLink?.()) return 'not-a-directory'
  return sameFolderIdentity({ dev: stat.dev, ino: stat.ino }, project?.identity) ? 'connected' : 'identity-changed'
}
