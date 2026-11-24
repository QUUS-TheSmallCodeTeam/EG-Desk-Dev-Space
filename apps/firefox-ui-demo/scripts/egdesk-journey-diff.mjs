#!/usr/bin/env node
// Regression diff of two all-on journey runs, so the next regression is diagnosed in minutes (lane L6 c22; analysis only).
//
//   node scripts/egdesk-journey-diff.mjs <old results.json> <old int SHA> <new results.json> <new int SHA> [--repo DIR] [--app apps/firefox-ui-demo]
//        [--workdir DIR] [--keep] [--full] [--json] [--out report.json]
//
// Per step: checks newly failed / newly passed, the Decision request bodies that changed (the changed lines, not whole bodies), answers that moved by
// 0.2 or more, how many messages the person was shown, and for every changed body family the commits between the two SHAs that touched its
// builder files, plus the commits that added or removed the words of a changed line (helper/egdesk-journey-diff.mjs, FAMILY_FILES).
// The results files keep only each request's sha256, so the bodies are rebuilt: each SHA is extracted (git archive) into a throwaway directory
// and the results file is replayed against that code with its recorded answers (scripts/egdesk-journey-replay-driver.mjs). Nothing is sent, the
// key is never read, and the repository is not touched (the extraction is under --workdir, default a new temporary directory, removed at the end).
// Environment: EGDESK_JOURNEY_DIFF_PRELOAD=<file> adds `node --import <file>` to the replay (a process/network guard, for example).
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildDiffReport, definitionRegex, formatReport } from '../helper/egdesk-journey-diff.mjs'

export const EXIT = Object.freeze({ ok: 0, usage: 2, replay: 3 })
const HERE = path.dirname(fileURLToPath(import.meta.url))
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' }
const SHA = /^[0-9a-f]{7,40}$/i

/** The real dependencies: git, tar and node as child processes. Tests pass fakes. */
export function realDeps({ repo, app = 'apps/firefox-ui-demo', preload = process.env.EGDESK_JOURNEY_DIFF_PRELOAD } = {}) {
  const git = args => {
    const r = spawnSync('git', ['-C', repo, ...args], { env: GIT_ENV, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${String(r.stderr).trim().slice(0, 200)}`)
    return r.stdout
  }
  return {
    app,
    git,
    resolve: sha => git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).trim(),
    materialize(sha, dir) {
      const archive = spawnSync('git', ['-C', repo, 'archive', sha, app], { env: GIT_ENV, maxBuffer: 1024 * 1024 * 1024 })
      if (archive.status !== 0) throw new Error(`git archive ${sha} failed: ${String(archive.stderr).trim().slice(0, 200)}`)
      mkdirSync(dir, { recursive: true })
      const tar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout, maxBuffer: 1024 * 1024 })
      if (tar.status !== 0) throw new Error('tar could not extract the archive')
    },
    replay({ checkout, resultsFile, out }) {
      const driver = path.join(HERE, 'egdesk-journey-replay-driver.mjs')
      const r = spawnSync(process.execPath, [...(preload ? ['--import', preload] : []), driver, '--checkout', checkout, '--results', resultsFile, '--out', out], { encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 })
      return { status: r.status, stderr: String(r.stderr).trim().slice(0, 400) }
    },
    mkdtemp: () => mkdtempSync(path.join(os.tmpdir(), 'egdesk-journey-diff-')),
    rm: dir => rmSync(dir, { recursive: true, force: true }),
    readJson: file => JSON.parse(readFileSync(file, 'utf8')),
    writeJson: (file, value) => writeFileSync(file, JSON.stringify(value, null, 1) + '\n'),
  }
}

const commitLines = text => String(text).split('\n').filter(Boolean).map(line => { const [sha, author, ...rest] = line.split('\t'); return { sha, author, subject: rest.join('\t') } })

export async function run(argv, deps, { print = line => console.log(line), printError = line => console.error(line) } = {}) {
  const args = [...argv], valued = new Set(['--repo', '--app', '--workdir', '--out']), flags = new Set(['--keep', '--full', '--json'])
  const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]))
  const unknown = args.find((a, i) => a.startsWith('--') && !valued.has(a) && !flags.has(a))
  const valueOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null }
  if (unknown || positional.length !== 4 || [...valued].some(n => args.includes(n) && !valueOf(n)) || !SHA.test(positional[1]) || !SHA.test(positional[3])) {
    printError('usage: egdesk-journey-diff.mjs <old results.json> <old int SHA> <new results.json> <new int SHA> [--repo DIR] [--app apps/firefox-ui-demo] [--workdir DIR] [--keep] [--full] [--json] [--out report.json]')
    return EXIT.usage
  }
  const [oldFile, oldRef, newFile, newRef] = positional
  let oldSha, newSha, oldResults, newResults
  try { oldSha = deps.resolve(oldRef); newSha = deps.resolve(newRef); if (!oldSha || !newSha) throw new Error('unknown commit') } catch { printError(`cannot resolve ${!oldSha ? oldRef : newRef} in the repository`); return EXIT.usage }
  try { oldResults = deps.readJson(oldFile); newResults = deps.readJson(newFile) } catch { printError('a results file cannot be read'); return EXIT.usage }
  for (const [file, r] of [[oldFile, oldResults], [newFile, newResults]]) if (!Array.isArray(r?.steps) || !r?.plan?.sha256) { printError(`${path.basename(file)} is not an all-on journey results file (steps and plan.sha256 are needed)`); return EXIT.usage }
  const work = valueOf('--workdir') ?? deps.mkdtemp()
  if (valueOf('--workdir')) mkdirSync(work, { recursive: true })
  const sides = []
  try {
    for (const [label, sha, results, file] of [[path.basename(oldFile), oldSha, oldResults, oldFile], [path.basename(newFile), newSha, newResults, newFile]]) {
      const checkout = path.join(work, `co-${sha.slice(0, 12)}`), out = path.join(work, `bodies-${sha.slice(0, 12)}-${label.replace(/[^\w.-]/g, '_')}.json`)
      deps.materialize(sha, checkout)
      const r = deps.replay({ checkout, resultsFile: file, out })
      let bodies
      try { bodies = deps.readJson(out) } catch { bodies = null }
      if (r.status !== 0 || !bodies || bodies.error) { printError(`replay of ${label} against ${sha.slice(0, 7)} failed${bodies?.message ? `: ${bodies.message}` : r.stderr ? `: ${r.stderr}` : ''}`); return EXIT.replay }
      sides.push({ label, sha, results, bodies: bodies.bodies, replay: { built: bodies.built, reproduced: bodies.reproduced, recorded: bodies.recorded } })
    }
  } finally { if (!args.includes('--keep') && !valueOf('--workdir')) deps.rm(work) }
  const prefix = deps.app, withApp = files => files.map(f => `${prefix}/${f}`)
  const range = `${oldSha}..${newSha}`, format = '--format=%h%x09%an%x09%s'
  const report = buildDiffReport({ old: sides[0], new: sides[1],
    commitsFor: files => { try { return commitLines(deps.git(['log', '--no-merges', format, range, '--', ...withApp(files)])) } catch { return [] } },
    symbolCommits: (file, name) => {
      try {
        // the definition line at the new SHA, as a literal for git's -L (the first line that defines the function); none: no commits to name
        const text = deps.git(['show', `${newSha}:${prefix}/${file}`]).split('\n').find(line => definitionRegex(name).test(line))
        if (!text) return []
        const literal = text.slice(0, text.indexOf(`${name}`) + name.length).replace(/[.*[\]^$\\/]/g, ch => `\\${ch}`)
        return commitLines(deps.git(['log', '--no-merges', '-s', `-L/${literal}/,+120:${prefix}/${file}`, format, range]))
      } catch { return [] }
    },
    pickaxe: (text, files) => { try { return commitLines(deps.git(['log', '--no-merges', `-S${text}`, format, range, '--', ...withApp(files)])) } catch { return [] } } })
  const out = valueOf('--out')
  if (out) deps.writeJson(out, report)
  if (args.includes('--json')) print(JSON.stringify(report, null, 1))
  else for (const line of formatReport(report, { full: args.includes('--full') })) print(line)
  return EXIT.ok
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2), at = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
  let repo = at('--repo')
  if (!repo) { const r = spawnSync('git', ['-C', HERE, 'rev-parse', '--show-toplevel'], { env: GIT_ENV, encoding: 'utf8' }); repo = r.status === 0 ? r.stdout.trim() : null }
  if (!repo) { console.error('cannot find the repository: pass --repo DIR'); process.exit(EXIT.usage) }
  process.exitCode = await run(argv, realDeps({ repo, ...(at('--app') ? { app: at('--app') } : {}) }))
}
