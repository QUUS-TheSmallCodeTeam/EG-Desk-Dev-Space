// Which Codex builds the command-gate hook's source facts were checked against (c14 source check, repeated per release in c15).
//
// The hook path depends on Codex implementation details that the hooks page does not promise (reports/l5-c14.md): the hook gets the
// Codex process environment snapshot (hooks/src/registry.rs), model commands drop *TOKEN* names by default
// (protocol/src/shell_environment.rs), and PreToolUse session_id/turn_id are the root thread id and the turn's sub_id
// (core/src/hook_runtime.rs, core/src/session/session.rs). The same facts were checked, as greps over the downloaded files
// (evidence/l5-c15/facts-check.sh), in each release below and in main at the commit. A build outside this list is not refused:
// the gate keeps working and records `unverified_engine_version` once per session, so the owner sees when the check must be repeated.
//
// The version is read from what the app-server already returns at initialize: InitializeResponse.userAgent
// (app-server-protocol/schema/json/v1/InitializeResponse.json), built as "<originator>/<CARGO_PKG_VERSION> (<os> <ver>; <arch>) …"
// (login/src/auth/default_client.rs get_codex_user_agent). Nothing is run to find it.
export const CODEX_HOOK_SOURCE_CHECK = Object.freeze({
  commit: 'a0d5b0a661db3b34cd87bdf1c93736b90fd3694b', // openai/codex main on 2026-11-24
  versions: Object.freeze(['0.170.0', '0.171.0', '0.172.0', '0.173.0-alpha.5', '0.174.0-alpha.1']),
})
export const ENGINE_VERSION_NOTICE = 'unverified_engine_version'

/** "codex_cli_rs/0.172.0 (Mac OS 15.1.0; arm64) …" → { originator, version } or null. Only the two leading fields are kept. */
export function parseCodexUserAgent(userAgent) {
  if (typeof userAgent !== 'string') return null
  const match = /^([A-Za-z0-9_.-]{1,64})\/(\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,40})?)(?=[\s(]|$)/.exec(userAgent.trim())
  return match ? { originator: match[1], version: match[2] } : null
}

/** { status: 'verified' | 'unverified', version } — unverified also when the version cannot be read. */
export function checkEngineVersion(userAgent, check = CODEX_HOOK_SOURCE_CHECK) {
  const parsed = parseCodexUserAgent(userAgent)
  if (!parsed) return { status: 'unverified', version: null }
  return { status: check.versions.includes(parsed.version) ? 'verified' : 'unverified', version: parsed.version }
}
