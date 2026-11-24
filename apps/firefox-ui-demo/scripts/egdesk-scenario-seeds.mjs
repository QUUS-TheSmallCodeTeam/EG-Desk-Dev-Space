#!/usr/bin/env node
// Extracts scenario seeds from the two named sources (helper/egdesk-scenario-seeds.mjs) into a directory OUTSIDE the repository.
//
//   node scripts/egdesk-scenario-seeds.mjs --out <dir> [--repo <EG-Desk repo>] [--loop <decision-loop dir>] [--ref <git ref>]
//        [--source taehwa-ontology|egdesk-dev|all] [--since <ISO date>] [--names-masked]
//
// --repo  the EG-Desk repository (default: this checkout); --ref the ref whose first-parent merges are read (default HEAD).
// --loop  the directory holding LEDGER.md, PHILOSOPHY.md and reports/ (egdesk-dev only; without it the dev seeds come from git and
//         ideas/confirmed only).
// Writes <out>/<seed id>.json (0600, directories 0700), manifest.json (content hashes, source file hashes, the owner's approvals),
// fingerprints.json (hashes only, read by the real-measure runners' guard) and changes.json (new / changed / removed against the
// manifest that was there before), and prints the same summary. Same sources, same bytes. Reads only the allowed files; runs only
// `git log` (read-only, no optional locks). Nothing is sent anywhere.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEV_ALLOWED, TAEHWA_ALLOWED, buildManifest, extractDev, extractTaehwa, namesMasked, parseGitMerges, seedFileOf, validateSeed } from '../helper/egdesk-scenario-seeds.mjs'
import { defaultSeedDir, seedFingerprints } from '../helper/egdesk-scenario-seed-guard.mjs'

/** main(argv, { print, printError, home }) → exit code (the command line calls it; tests call it in-process). */
export async function main(argv = process.argv.slice(2), { print = line => console.log(line), printError = line => console.error(line), home = os.homedir() } = {}) {
  const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
  const here = path.dirname(fileURLToPath(import.meta.url))
  const repo = path.resolve(opt('--repo') ?? path.join(here, '..', '..', '..'))
  const loop = opt('--loop') ? path.resolve(opt('--loop')) : null
  const out = path.resolve(opt('--out') ?? defaultSeedDir(home))
  const ref = opt('--ref') ?? 'HEAD', which = opt('--source') ?? 'all', since = opt('--since')
  if (since && Number.isNaN(Date.parse(since))) { printError('--since must be an ISO date'); return 2 }
  const rel = path.relative(repo, out)
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) { printError(`refused: --out ${out} is inside the repository ${repo}`); return 2 }

  const sha = text => createHash('sha256').update(text).digest('hex')
  const files = {}
  const readIn = (root, prefix = '') => file => { const text = readFileSync(path.join(root, file), 'utf8'); files[`${prefix}${file}`] = sha(text); return text }
  const seeds = []
  let git = null
  if (which === 'all' || which === 'taehwa-ontology') seeds.push(...extractTaehwa({ read: readIn(repo), since }))
  if (which === 'all' || which === 'egdesk-dev') {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
    const head = execFileSync('git', ['-C', repo, 'rev-parse', ref], { env, encoding: 'utf8' }).trim()
    const log = execFileSync('git', ['-C', repo, 'log', '--first-parent', '--merges', '--format=%H%x09%P%x09%aI%x09%s', head], { env, encoding: 'utf8', maxBuffer: 64 << 20 })
    git = { ref, head }
    const listIn = root => dir => (existsSync(path.join(root, dir)) ? readdirSync(path.join(root, dir)).sort() : [])
    seeds.push(...extractDev({ readRepo: readIn(repo), listRepo: listIn(repo), gitMerges: parseGitMerges(log), since,
      readLoop: loop ? readIn(loop, 'loop:') : file => { if (file === 'LEDGER.md' || file === 'PHILOSOPHY.md') return ''; throw new Error('no --loop') }, listLoop: loop ? listIn(loop) : () => [] }))
  }
  const all = argv.includes('--names-masked') ? [...seeds, ...seeds.map(namesMasked)] : seeds
  for (const s of all) { const bad = validateSeed(s); if (bad.length) { printError(`invalid seed ${s.id}: ${bad.join('; ')}`); return 1 } }

  mkdirSync(out, { recursive: true, mode: 0o700 }); chmodSync(out, 0o700)
  const write = (file, text) => { const target = path.join(out, file); mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); const tmp = `${target}.tmp`; writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, target) }
  const previous = existsSync(path.join(out, 'manifest.json')) ? JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8')) : null
  const allowed = Object.keys(files).sort()
  for (const f of allowed) if (!(TAEHWA_ALLOWED.includes(f) || DEV_ALLOWED.repo.test(f) || DEV_ALLOWED.loop.test(f.replace(/^loop:/, '')))) throw new Error(`read outside the allowed sources: ${f}`)
  const { manifest, changes } = buildManifest({ seeds: all, previous, since, only: which === 'all' ? null : which, sources: { files: Object.fromEntries(allowed.map(f => [f, files[f]])), ...(git ? { git } : {}) } })
  for (const s of all) write(seedFileOf(s), `${JSON.stringify(s, null, 1)}\n`)
  const prints = existsSync(path.join(out, 'fingerprints.json')) && (since || which !== 'all') ? JSON.parse(readFileSync(path.join(out, 'fingerprints.json'), 'utf8')) : {}
  for (const s of all) prints[`${s.id}|${s.variant}`] = seedFingerprints(s)
  write('fingerprints.json', `${JSON.stringify(Object.fromEntries(Object.entries(prints).sort()))}\n`)
  write('manifest.json', `${JSON.stringify(manifest, null, 1)}\n`)
  write('changes.json', `${JSON.stringify(changes, null, 1)}\n`)
  const count = key => all.reduce((n, s) => n + s[key].length, 0)
  print(JSON.stringify({ out, seeds: all.length, pages: count('pages'), turns: count('turns'), facts: count('facts'), expectations: count('expectations'),
    privacy: Object.fromEntries(['owner-approved', 'local-only'].map(p => [p, all.filter(s => s.privacy === p).length])), changes }))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main()
