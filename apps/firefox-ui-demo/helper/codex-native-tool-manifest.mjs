import { createHash } from 'node:crypto'

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const short = (value, max = 160) => typeof value === 'string' && value.length > 0 && value.length <= max
const keyFor = (namespace, name) => `${namespace || ''}\0${name}`

export function specManifestEntries(spec, providerId) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(providerId || '') || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(spec?.name || '')) return null
  const functions = spec.type === 'function' ? [{ name: spec.name, inputSchema: spec.inputSchema }]
    : spec.type === 'namespace' && Array.isArray(spec.tools) && spec.tools.length
      ? spec.tools.map(tool => tool?.type === 'function' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(tool.name || '') ? { name: tool.name, inputSchema: tool.inputSchema } : null)
      : null
  if (!functions?.length || functions.some(tool => !tool || tool.inputSchema === undefined)) return null
  return functions.map(tool => ({
    key: keyFor(spec.type === 'namespace' ? spec.name : null, tool.name), providerId,
    schemaHash: digest({ type: 'function', inputSchema: tool.inputSchema }),
  }))
}

export function verifiedManifestOwners(recorded, current, currentOwners) {
  if (!Array.isArray(recorded)) return { status: 'legacy-unverified', owners: new Map() }
  if (recorded.length > 64 || !Array.isArray(current)) return { status: 'mismatch', owners: new Map() }
  const candidates = new Map(current.map(entry => [entry.key, entry]))
  const owners = new Map()
  for (const entry of recorded) {
    if (!short(entry?.key, 350) || !short(entry?.providerId) || !/^[a-f0-9]{64}$/.test(entry?.schemaHash || '') || owners.has(entry.key)) {
      return { status: 'mismatch', owners: new Map() }
    }
    const candidate = candidates.get(entry.key)
    const owner = currentOwners.get(entry.key)
    if (!candidate || !owner || candidate.providerId !== entry.providerId || candidate.schemaHash !== entry.schemaHash) {
      return { status: 'mismatch', owners: new Map() }
    }
    owners.set(entry.key, owner)
  }
  return { status: 'verified', owners }
}
