import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Which helper build a running bridge is. The overlay sends the build it was
// installed with; /v1/state answers whether the running bridge is older or
// newer source (a bridge left running across an update).
export const OVERLAY_BUILD_HEADER = 'x-egdesk-overlay-build'
export const OVERLAY_BUILD_QUERY = 'overlayBuild'
export const BRIDGE_ENTRY = fileURLToPath(new URL('./codex-bridge-server.mjs', import.meta.url))

const BUILD_HASH = /^[a-f0-9]{64}$/
const MODULE_REFERENCE = [
  // import x from './a.mjs' · import './a.mjs' · export { x } from './a.mjs'
  /(?:\bfrom|\bimport)\s*['"](\.{1,2}\/[^'"\n]+)['"]/g,
  // import('./a.mjs') with a literal specifier
  /\bimport\s*\(\s*['"](\.{1,2}\/[^'"\n]+)['"]\s*\)/g,
  // new URL('./worker.mjs', import.meta.url): helper code started by path
  /\bnew URL\(\s*['"](\.{1,2}\/[^'"\n]+\.m?js)['"]\s*,\s*import\.meta\.url\s*\)/g,
]

export function localModuleReferences(source) {
  const found = new Set()
  for (const pattern of MODULE_REFERENCE) for (const match of source.matchAll(pattern)) found.add(match[1])
  return [...found]
}

// The helper modules the entry loads: its relative import graph, limited to
// the entry's directory. Packages and Node builtins are not helper source.
// Line endings are normalized so one checkout hashes the same on every OS.
export function bridgeSourceFiles({ entry = BRIDGE_ENTRY, readFile = readFileSync } = {}) {
  const root = path.dirname(entry)
  const files = new Map()
  const visit = file => {
    const name = path.relative(root, file).split(path.sep).join('/')
    if (files.has(name) || name.startsWith('../') || path.isAbsolute(name)) return
    let text
    try { text = readFile(file, 'utf8') } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    text = String(text).replace(/\r\n/g, '\n')
    files.set(name, text)
    for (const specifier of localModuleReferences(text)) visit(path.resolve(path.dirname(file), specifier))
  }
  visit(path.resolve(entry))
  return [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, text]) => ({ name, text }))
}

export function computeBridgeBuildHash(options = {}) {
  const hash = createHash('sha256')
  for (const { name, text } of bridgeSourceFiles(options)) {
    const bytes = Buffer.from(text, 'utf8')
    hash.update(`${name}\0${bytes.length}\0`)
    hash.update(bytes)
  }
  return hash.digest('hex')
}

// Read once when the bridge starts. A failed read leaves buildHash null and
// keeps the bridge running; it never reports a mismatch it cannot know.
export function startBridgeBuild({ now = Date.now, compute = computeBridgeBuildHash } = {}) {
  let buildHash = null
  try {
    const value = compute()
    if (BUILD_HASH.test(value)) buildHash = value
  } catch {}
  return Object.freeze({ buildHash, startedAt: now() })
}

// The overlay's expected build from the X-EGDesk-Overlay-Build header, or the
// overlayBuild query when a header cannot be sent. Anything else counts as
// not sent.
export function expectedOverlayBuild(headers = {}, searchParams = null) {
  const raw = headers?.[OVERLAY_BUILD_HEADER] ?? searchParams?.get?.(OVERLAY_BUILD_QUERY) ?? null
  if (typeof raw !== 'string') return null
  const value = raw.trim().toLowerCase()
  return BUILD_HASH.test(value) ? value : null
}

export function bridgeBuildState(build, expected = null) {
  const buildHash = build?.buildHash ?? null
  return {
    buildHash,
    startedAt: build?.startedAt ?? null,
    sourceMismatch: Boolean(buildHash && expected && expected !== buildHash),
  }
}

// `node helper/egdesk-bridge-build.mjs` prints the hash of this checkout's
// helper source, the value an installed overlay sends as its expected build.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(computeBridgeBuildHash() + '\n')
}
