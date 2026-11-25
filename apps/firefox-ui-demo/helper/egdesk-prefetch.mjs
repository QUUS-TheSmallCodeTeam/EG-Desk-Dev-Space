// L7 c37 (owner direction U13, "끼릭끼릭 탁탁"; L6 c29 audit R-B): at the start of a turn CODE builds the read options of the working folder (files the turn could need), the
// Decision model picks (the context selection that already exists: a catalog line per file, relevance at its bar; below it nothing is attached and the engine reads as today), and
// CODE reads the picked files and hands their text to the engine in the turn context, so the engine answers without read rounds (each ~3.0 s in the measured runs; the tool itself ~0.01 s).
// This module is the first step only: it lists the folder (bounded) and turns each file into a selection candidate whose text is read when picked. Nothing here asks a model.
//   - What the Decision model sees is the catalog line: the relative path, size and date of each listed file (a new data class 'files', egress kind 'workspace_names'). Never file text.
//   - What the engine receives is the file text of the picked ones (itemChars of the selection, 6,000 characters, split into entries under the engine's byte limit by EGDESK_TURN_MEMORY_ENGINE_CONTEXT=split).
//   - Bounds: text-like files only, at most MAX_FILES listed (the most recently changed first), depth 3, 100 KB each, no dot or build folders, no symlinks; a file that changed or left the folder since the
//     listing is not read (null: the engine reads it as today).
// Off unless EGDESK_TURN_MEMORY_PREFETCH=files (developer flag, bridge and check).
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'

export const PREFETCH_LIMITS = Object.freeze({ maxFiles: 60, maxDepth: 3, maxFileBytes: 100 * 1024, maxScan: 2000, readBytes: 24 * 1024 })
export const PREFETCH_EXT = Object.freeze(['.md', '.txt', '.json', '.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.css', '.html', '.yml', '.yaml', '.toml', '.csv', '.log', '.sh', '.sql', '.ini', '.env.example'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'target', 'vendor', '__pycache__', 'out'])
const SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'])

const dateOf = ms => new Date(ms).toISOString().slice(0, 10)
const sameFile = (a, b) => a && b && a.size === b.size && a.mtimeMs === b.mtimeMs

/** listWorkspaceFiles(folder) → [{ rel, size, mtimeMs }] sorted by most recent change, at most maxFiles; [] when the folder cannot be read. */
export async function listWorkspaceFiles(folder, limits = PREFETCH_LIMITS) {
  let root
  try { root = await realpath(folder) } catch { return [] }
  const found = []
  let scanned = 0
  const walk = async (dir, depth) => {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (scanned++ >= limits.maxScan) return
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { if (depth < limits.maxDepth && !SKIP_DIRS.has(entry.name)) await walk(full, depth + 1); continue }
      if (!entry.isFile() || SKIP_FILES.has(entry.name) || !PREFETCH_EXT.includes(path.extname(entry.name).toLowerCase())) continue
      try {
        const stat = await lstat(full)
        if (stat.isFile() && stat.size > 0 && stat.size <= limits.maxFileBytes) found.push({ rel: path.relative(root, full).split(path.sep).join('/'), size: stat.size, mtimeMs: stat.mtimeMs })
      } catch { /* gone */ }
    }
  }
  await walk(root, 0)
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.rel.localeCompare(b.rel)).slice(0, limits.maxFiles)
}

/** The text of one listed file, or null: inside the folder (real path), a regular file, unchanged since the listing, text (no NUL byte), valid UTF-8 as far as read. */
export async function readWorkspaceFile(folder, listed, limits = PREFETCH_LIMITS) {
  try {
    const root = await realpath(folder), full = path.join(root, ...listed.rel.split('/'))
    const real = await realpath(full)
    if (real !== full && !real.startsWith(root + path.sep)) return null
    const stat = await lstat(real)
    if (!stat.isFile() || !sameFile({ size: stat.size, mtimeMs: stat.mtimeMs }, listed)) return null
    const handle = await open(real, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, limits.readBytes)), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const bytes = buffer.subarray(0, bytesRead)
      if (bytes.includes(0)) return null
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\uFFFD+$/u, '')
      return text.trim() ? text : null
    } finally { await handle.close() }
  } catch { return null }
}

/** Selection candidates for the files of a folder: one per file, unguarded (a file delivered unchanged is held and not asked again), text read only when picked. */
export async function workspaceCandidates(folder, limits = PREFETCH_LIMITS) {
  const files = await listWorkspaceFiles(folder, limits)
  return files.map(file => ({ id: `workspace:${file.rel}`, kind: 'document', title: file.rel, summary: `${file.size} bytes, ${dateOf(file.mtimeMs)}`, timeSlice: 'present',
    loadText: () => readWorkspaceFile(folder, file, limits) }))
}
