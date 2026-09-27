import { accessSync, constants, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

export const NATIVE_SCHEMA_VERSION = '0.157.1'

export function resolveCodexExecutable(env = process.env) {
  const selected = env.EGDESK_CODEX_BIN || 'codex'
  const candidates = path.isAbsolute(selected) ? [selected] : selected.includes(path.sep) ? [] : (env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, selected))
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate) } catch {}
  }
  throw new Error('Configured Codex executable is unavailable; set EGDESK_CODEX_BIN to an existing absolute executable path')
}

export function inspectNativeCapabilities({ executable, env = process.env, cwd = process.cwd(), run = spawnSync }) {
  const result = run(executable, ['--version'], { env, cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] })
  const version = result.status === 0 ? String(result.stdout || '').trim().match(/^codex-cli (\d+\.\d+\.\d+)$/)?.[1] || null : null
  return { executable, version, schemaVersion: NATIVE_SCHEMA_VERSION, schemaMatch: version === NATIVE_SCHEMA_VERSION, experimentalApi: true, dynamicTools: version === NATIVE_SCHEMA_VERSION, readerReadOnly: version === NATIVE_SCHEMA_VERSION }
}
