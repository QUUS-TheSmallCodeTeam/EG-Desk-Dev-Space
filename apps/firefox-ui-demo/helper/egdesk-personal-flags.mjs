// Personal developer flags (owner request 2026-11-26: "항상 킴으로 마치 내 개인 설정 하듯"). The person's own choice of EG-Desk feature flags is kept
// in their EG-Desk data folder (<data>/settings/egdesk-personal-flags.json) and applied when the bridge starts, like a personal setting:
// - only names EGDESK_[A-Z0-9_] with a short word value (on, off, files, advisory, none, waiting ...) are read; paths and anything else are ignored,
// - a flag set explicitly in the environment wins (the launch command can still override the file),
// - a missing, unreadable or broken file changes nothing (no file = no effect, the default).
// It runs before applyUpperBundle so EGDESK_UPPER from the file switches the bundle the same way an explicit value does.
// File shape: { "flags": { "EGDESK_UPPER": "on", ... } } (a bare object of flags is accepted too).
import fs from 'node:fs'

export const PERSONAL_FLAGS_FILE = 'egdesk-personal-flags.json'
const NAME = /^EGDESK_[A-Z0-9_]{1,64}$/
const VALUE = /^[A-Za-z0-9_-]{1,32}$/

/** The valid flags in the file, or {} when there is no usable file. */
export function readPersonalFlags(file, { readFile = fs.readFileSync } = {}) {
  let data
  try { data = JSON.parse(readFile(file, 'utf8')) } catch { return {} }
  const source = data && typeof data === 'object' && !Array.isArray(data) ? (data.flags && typeof data.flags === 'object' && !Array.isArray(data.flags) ? data.flags : data) : {}
  const flags = {}
  for (const [name, value] of Object.entries(source)) if (NAME.test(name) && typeof value === 'string' && VALUE.test(value)) flags[name] = value
  return flags
}

/** Fills the env with the file's flags that the env does not already set (an empty string counts as not set). Returns { applied, kept }. */
export function applyPersonalFlags(env, file, options) {
  const applied = [], kept = []
  for (const [name, value] of Object.entries(readPersonalFlags(file, options))) {
    if (typeof env[name] === 'string' && env[name] !== '') { kept.push(name); continue }
    env[name] = value; applied.push(name)
  }
  return { applied, kept }
}

export const describePersonalFlags = ({ applied, kept }) => `personal flags: ${applied.length} set from settings, ${kept.length} kept (explicitly set)`
