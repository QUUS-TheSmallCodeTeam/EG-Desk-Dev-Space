import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appDataDirectory } from './egdesk-context-store.mjs'
import { CALIBRATION_FILE } from './egdesk-decision-calibration-log.mjs'
import { CODEX_HOOK_SOURCE_CHECK } from './egdesk-codex-version-pin.mjs'

// The first-run checklist for EG-Desk's own tools (c20). It PRINTS the steps and checks preconditions; it runs nothing (no process, no
// network, no install, no login) and never looks inside ~/.codex. The person does every step themselves, in this order:
// shadow → own tools in a throwaway folder → the real folder. Official sources:
//   install   https://github.com/openai/codex (README: install script, `npm install -g @openai/codex`, `brew install --cask codex`, or the
//             platform archive from the latest GitHub Release, e.g. codex-aarch64-apple-darwin.tar.gz)
//   sign in   https://developers.openai.com/codex/auth ("Sign in with ChatGPT … the sign-in flow opens a browser window"; credentials in
//             auth.json under CODEX_HOME with cli_auth_credentials_store = "file"; "treat auth.json like a password")
export const FIRST_RUN_SOURCES = Object.freeze({
  install: 'https://github.com/openai/codex#installing-and-running-codex-cli',
  releases: 'https://github.com/openai/codex/releases/latest',
  auth: 'https://developers.openai.com/codex/auth',
})

/** The EG-Desk-owned places a first run would use. Nothing is created here. */
export function firstRunPaths(dataDir) {
  return { dataDir, install: path.join(dataDir, 'engines', 'codex'), home: path.join(dataDir, 'engine-homes', 'codex-default'),
    engineFolder: path.join(dataDir, 'engine-folders', 'empty'), calibration: path.join(dataDir, 'settings', CALIBRATION_FILE) }
}

/** Read-only checks: existence, emptiness, executability, flags. Never reads a file's contents; never touches ~/.codex. */
export function firstRunChecks({ env = process.env, home = os.homedir(), platform = os.platform(), fsImpl = fs, nodeVersion = process.versions.node } = {}) {
  let dataDir = null, dataError = null
  try { dataDir = appDataDirectory(env, home, platform) } catch (error) { dataError = error?.code ?? 'INVALID_DATA_DIR' }
  const p = dataDir ? firstRunPaths(dataDir) : null
  const exists = target => { try { fsImpl.statSync(target); return true } catch { return false } }
  const empty = target => { try { return fsImpl.readdirSync(target).length === 0 } catch { return null } }
  const executable = target => { try { fsImpl.accessSync(target, fs.constants.X_OK); return true } catch { return false } }
  const bin = env.EGDESK_CODEX_BIN || null
  const userHome = path.join(home, '.codex')
  const codexHome = env.CODEX_HOME || null
  const checks = [
    { id: 'node', ok: Number(nodeVersion.split('.')[0]) >= 20, detail: `node ${nodeVersion}` },
    { id: 'data_dir', ok: Boolean(dataDir) && exists(dataDir), detail: dataDir ?? dataError },
    { id: 'install_dir', ok: Boolean(p) && exists(p.install), detail: p?.install ?? null, todo: 'step 1' },
    { id: 'codex_bin', ok: Boolean(bin) && path.isAbsolute(bin) && Boolean(p) && bin.startsWith(`${p.install}${path.sep}`) && executable(bin),
      detail: bin ? (p && bin.startsWith(`${p.install}${path.sep}`) ? bin : `${bin} (not under ${p?.install})`) : 'EGDESK_CODEX_BIN not set', todo: 'step 2' },
    { id: 'codex_home', ok: Boolean(codexHome) && Boolean(p) && codexHome === p.home && exists(codexHome),
      detail: !codexHome ? 'CODEX_HOME not set (the shared app-server would use ~/.codex)' : codexHome === userHome ? 'CODEX_HOME is ~/.codex: the person\'s own home, not an EG-Desk one' : codexHome, todo: 'step 2' },
    { id: 'signed_in', ok: Boolean(p) && exists(path.join(p.home, 'auth.json')), detail: 'auth.json present in the EG-Desk home (existence only; never read)', todo: 'step 3' },
    { id: 'engine_folder', ok: Boolean(p) && (!exists(p.engineFolder) || empty(p.engineFolder) === true), detail: p?.engineFolder ?? null },
    { id: 'flags', ok: true, detail: `EGDESK_OWN_TOOLS=${env.EGDESK_OWN_TOOLS ?? '(off)'} EGDESK_TERMINAL_GATE=${env.EGDESK_TERMINAL_GATE ?? '(off)'}` },
  ]
  return { dataDir, paths: p, checks }
}

export function firstRunSteps(paths) {
  const p = paths ?? firstRunPaths('<EG-Desk data folder>')
  const versions = CODEX_HOOK_SOURCE_CHECK.versions.join(', ')
  return [
    { step: 0, title: 'Preconditions', do: ['Run this checklist again after each step; every check above should turn ok in order.'] },
    { step: 1, title: 'Install the official Codex into an EG-Desk-owned folder (the person does this; nothing here installs)',
      do: [`Download the archive for this machine from ${FIRST_RUN_SOURCES.releases} (README: ${FIRST_RUN_SOURCES.install}).`,
        `Extract it into ${p.install}/<version>/ and name the executable codex. Do not use the repository's own Codex binary.`,
        `Prefer a release whose source facts were checked (${versions}); any other version works but records unverified_engine_version once per session.`] },
    { step: 2, title: 'Point EG-Desk at it and give it its own home',
      do: [`Create ${p.home} (owner-only).`, `Start the bridge with EGDESK_CODEX_BIN=${p.install}/<version>/codex and CODEX_HOME=${p.home}.`,
        'Never copy ~/.codex/auth.json or any other file from ~/.codex.'] },
    { step: 3, title: 'Sign in once through Codex\'s own flow',
      do: [`Use EG-Desk's AI engine connection (it starts Codex's own browser sign-in through the app-server); choose Sign in with ChatGPT (${FIRST_RUN_SOURCES.auth}).`,
        `Credentials stay in ${p.home} (auth.json, a password-like file). Check: the signed_in check turns ok; the account shown is the intended one.`] },
    { step: 4, title: 'Shadow: measure without changing anything',
      do: ['Restart with EGDESK_OWN_TOOLS=shadow (and EGDESK_TERMINAL_GATE=advisory so the content predicates are judged too). Work as usual for a while.',
        `Watch: ${p.calibration} entries with feature own_tools_shadow (would_run / would_ask / would_refuse per command and file change); terminal_gate notice unverified_engine_version.`,
        'Expect: everyday commands would_run; destructive ones would_ask; nothing would_refuse inside the project folder.'] },
    { step: 5, title: 'Own tools in a throwaway folder',
      do: ['Make a throwaway git repository outside any real project and bind a Board to it.',
        'Restart with EGDESK_OWN_TOOLS=on. Ask for: read a file, search, an exact edit, a diff edit, an undo, run the tests, and a destructive command (e.g. git push --force).',
        `Watch: the destructive command stops and the model asks in the chat; "응" runs it once, "아니" runs nothing; ${p.engineFolder} stays empty; no native approval card appears; command output shows in the run's output view.`] },
    { step: 6, title: 'The real folder', do: ['Bind the real project folder; keep EGDESK_OWN_TOOLS=on; keep watching the same signals for the first sessions.'] },
    { step: 7, title: 'Roll back (any time)',
      do: ['Unset EGDESK_OWN_TOOLS and restart: Codex uses its own tools again, exactly as before.',
        'Unset EGDESK_CODEX_BIN and CODEX_HOME to return to the earlier Codex and home. ~/.codex was never touched.',
        `Undo edits with the undo records (one step back per edit, while the file is unchanged). The owned folders ${p.install}, ${p.home} and ${p.engineFolder} can be deleted.`] },
  ]
}

export function formatFirstRun({ checks, paths }) {
  const lines = ['EG-Desk own tools: first-run checklist (prints only; runs nothing)', '']
  for (const check of checks) lines.push(`  [${check.ok ? 'ok' : '--'}] ${check.id.padEnd(13)} ${check.detail ?? ''}${!check.ok && check.todo ? `  → ${check.todo}` : ''}`)
  lines.push('')
  for (const step of firstRunSteps(paths)) { lines.push(`${step.step}. ${step.title}`); for (const line of step.do) lines.push(`   - ${line}`) }
  return lines.join('\n')
}
