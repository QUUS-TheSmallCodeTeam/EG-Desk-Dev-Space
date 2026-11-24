#!/bin/bash
# Repeats the command-gate hook's source check for one Codex release (c14/c15/c16). It downloads seven files of openai/codex at
# <ref> (a release tag such as rust-v0.175.0, or a commit) with curl, and greps the ten facts the hook design relies on. It never
# runs Codex and never reads any Codex configuration. Exit 0: all facts hold (the version may be added to
# CODEX_HOOK_SOURCE_CHECK.versions in helper/egdesk-codex-version-pin.mjs). Exit 1: a fact is missing (read the changed source
# before adding anything). Exit 2: a download failed.
#   usage: scripts/codex-hooks/source-facts-check.sh rust-v0.175.0 [work-dir]
set -u
ref="${1:?usage: $0 <tag-or-commit> [work-dir]}"; dir="${2:-$(mktemp -d)}"; mkdir -p "$dir"
base="https://raw.githubusercontent.com/openai/codex/$ref/codex-rs"
files=(
  "hooks/src/registry.rs:registry.rs"
  "hooks/src/engine/command_runner.rs:command_runner.rs"
  "protocol/src/shell_environment.rs:shell_environment.rs"
  "core/src/session/session.rs:session.rs"
  "core/src/hook_runtime.rs:hook_runtime.rs"
  "hooks/schema/generated/pre-tool-use.command.input.schema.json:pre-tool-use.schema.json"
  "app-server-protocol/schema/json/v1/InitializeResponse.json:InitializeResponse.json"
)
for pair in "${files[@]}"; do
  src="${pair%%:*}"; out="$dir/${pair##*:}"
  code=$(curl -sS -m 60 -w '%{http_code}' -o "$out" "$base/$src") || { echo "download failed: $src"; exit 2; }
  [ "$code" = "200" ] || { echo "download failed ($code): $src"; exit 2; }
done
ok=0
fact() { if grep -qE "$2" "$dir/$1"; then echo "ok    $3"; else echo "MISS  $3  ($1)"; ok=1; fi; }
fact registry.rs 'Arc::new\(std::env::vars_os\(\)\.collect\(\)\)' 'hooks get a snapshot of the Codex process environment'
fact command_runner.rs 'is_non_inheritable_env_var' 'hook commands drop only the non-inheritable names'
fact command_runner.rs 'command\.envs\(' 'the snapshot is replayed into the hook command'
fact shell_environment.rs 'new_case_insensitive\("\*TOKEN\*"\)' 'model commands drop *TOKEN* names by default'
fact shell_environment.rs '"CODEX_GUARDIAN_DECISIONS_API_KEY"' 'the non-inheritable list is the one read in c14'
fact session.rs 'session_id is equal to the root thread' 'session_id is the root thread id'
fact hook_runtime.rs 'session_id: sess\.session_id\(\)\.into\(\)' 'PreToolUse session_id comes from the session'
fact hook_runtime.rs 'turn_id: turn_context\.sub_id\.clone\(\)' 'PreToolUse turn_id is the turn sub_id'
fact pre-tool-use.schema.json '"turn_id"' 'the PreToolUse input schema has turn_id'
fact pre-tool-use.schema.json '"session_id"' 'the PreToolUse input schema has session_id'
fact InitializeResponse.json '"userAgent"' 'initialize still returns userAgent (where the version is read)'
echo "ref=$ref files=$dir result=$([ $ok = 0 ] && echo all-facts-hold || echo facts-missing)"
exit $ok
