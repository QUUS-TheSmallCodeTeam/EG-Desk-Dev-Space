// The real-measure runners' guard for requests built from scenario seeds (helper/egdesk-scenario-seeds.mjs).
//
// Every request body a runner is about to send (or a plan it loads) is compared with the fingerprints of the seeds it can see:
//   - a body that carries material of a 'local-only' seed is REFUSED (dry run and send alike);
//   - a body that carries material of an 'owner-approved' seed must hold no secret maskSecrets() would mask (credentials, tokens, API keys,
//     emails, phone numbers, account ids, URLs with a query string), else it is refused;
//   - a plan or request that DECLARES seeds ("seeds": [{ id, privacy }]) is refused unless every declared seed is owner-approved and,
//     when the manifest is visible, known to it with that privacy.
// Fingerprints: every 24-character window of the seed's page titles and bodies, turns and facts after normalisation (NFKC, lower case,
// whitespace and punctuation removed); a unit shorter than 24 characters (but at least 10) is one fingerprint of its own length. Only the
// hashes are kept (fingerprints.json next to the manifest), never the text. Seen seed directories: EGDESK_SCENARIO_SEEDS (paths separated
// by ':') and the extractor's default output directory (defaultSeedDir()).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { secretsIn } from './egdesk-scenario-seeds.mjs'

export const FINGERPRINT_WINDOW = 24
export const FINGERPRINT_MIN = 10
export const defaultSeedDir = (home = os.homedir()) => path.join(home, '.cache', 'egdesk', 'scenario-seeds')
const h = text => createHash('sha256').update(text).digest('hex').slice(0, 16)
export const normalize = text => String(text).normalize('NFKC').toLowerCase().replace(/[\s"'`“”‘’.,:;!?()[\]{}<>|*_#~\-–—/\\=+…·→]+/g, '')

function windowsOf(norm, size) { const out = []; for (let i = 0; i + size <= norm.length; i++) out.push(norm.slice(i, i + size)); return out }
/** seedFingerprints(seed) → { long: [hash], short: { [length]: [hash] } } */
export function seedFingerprints(seed) {
  const units = [seed.title, ...seed.pages.flatMap(p => [p.title, p.body]), ...seed.turns.map(t => t.text), ...seed.facts.map(f => f.text)].filter(Boolean)
  const long = new Set(), short = {}
  for (const unit of units) {
    const norm = normalize(unit)
    if (norm.length >= FINGERPRINT_WINDOW) for (const w of windowsOf(norm, FINGERPRINT_WINDOW)) long.add(h(w))
    else if (norm.length >= FINGERPRINT_MIN) (short[norm.length] ??= new Set()).add(h(norm))
  }
  return { long: [...long].sort(), short: Object.fromEntries(Object.entries(short).map(([k, v]) => [k, [...v].sort()])) }
}

/** loadSeedGuard({ env, home, dirs }) → guard | null when no seed directory with a manifest is visible. */
export function loadSeedGuard({ env = process.env, home = os.homedir(), dirs = null } = {}) {
  const list = dirs ?? [...String(env.EGDESK_SCENARIO_SEEDS ?? '').split(':').filter(Boolean), defaultSeedDir(home)]
  const seeds = []
  for (const dir of [...new Set(list)]) {
    const m = path.join(dir, 'manifest.json'), f = path.join(dir, 'fingerprints.json')
    if (!existsSync(m)) continue
    let manifest, prints
    try { manifest = JSON.parse(readFileSync(m, 'utf8')); prints = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {} } catch { throw new Error(`scenario seed manifest unreadable: ${m}`) }
    for (const row of manifest.seeds ?? []) seeds.push({ ...row, dir, prints: prints[`${row.id}|${row.variant}`] ?? null })
  }
  return seeds.length ? createSeedGuard(seeds) : null
}

/** createSeedGuard(seeds: [{ id, variant, privacy, prints }]) → { check(body, declared?) → null | refusal text, seeds } */
export function createSeedGuard(seeds) {
  const indexed = seeds.map(s => ({ ...s, long: new Set(s.prints?.long ?? []), short: Object.entries(s.prints?.short ?? {}).map(([n, list]) => [Number(n), new Set(list)]) }))
  const lengths = [...new Set(indexed.flatMap(s => s.short.map(([n]) => n)))]
  const strings = value => { const out = []; const walk = v => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk) }; walk(value); return out }
  function matches(body) {
    if (!indexed.length) return []
    let parsed
    try { parsed = JSON.parse(body) } catch { parsed = body }
    const norms = strings(parsed).map(normalize).filter(Boolean)
    const long = new Set(norms.flatMap(n => windowsOf(n, FINGERPRINT_WINDOW).map(h)))
    const short = new Map(lengths.map(n => [n, new Set(norms.flatMap(x => windowsOf(x, n).map(h)))]))
    return indexed.filter(s => [...s.long].some(x => long.has(x)) || s.short.some(([n, set]) => [...set].some(x => short.get(n).has(x))))
  }
  return {
    seeds: indexed.map(({ id, variant, privacy }) => ({ id, variant, privacy })),
    check(body, declared = []) {
      for (const d of declared ?? []) {
        if (d?.privacy !== 'owner-approved') return `declares seed ${d?.id ?? '?'} with privacy ${d?.privacy ?? 'none'} (only owner-approved seeds may be sent)`
        const known = indexed.find(s => s.id === d.id)
        if (known && known.privacy !== 'owner-approved') return `declares seed ${d.id} as owner-approved, the manifest says ${known.privacy}`
      }
      const hit = matches(String(body))
      const local = hit.find(s => s.privacy !== 'owner-approved')
      if (local) return `built from the ${local.privacy} scenario seed ${local.id} (${local.variant})`
      if (hit.length) { const left = secretsIn(String(body)); if (left.length) return `built from the scenario seed ${hit[0].id} and still holds ${left.join(', ')}` }
      return null
    },
  }
}

/**
 * seedRefusal(body, { declared, guard }) → null | refusal text. The one call each real-measure runner makes before a body leaves
 * (and at plan load where the bodies are known). guard: loadSeedGuard() (undefined: loaded here, once per process); declared: the seeds
 * a plan or request says it was built from. Without any visible manifest only the declaration is checked.
 */
let loaded = null
export function seedRefusal(body, { declared = [], guard } = {}) {
  const at = `${process.env.EGDESK_SCENARIO_SEEDS ?? ''}|${os.homedir()}`
  if (guard === undefined && loaded?.at !== at) loaded = { at, guard: loadSeedGuard() }
  const g = guard !== undefined ? guard : loaded.guard
  return (g ?? createSeedGuard([])).check(body, declared)
}
