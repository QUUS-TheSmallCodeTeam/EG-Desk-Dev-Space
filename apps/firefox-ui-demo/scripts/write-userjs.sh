#!/usr/bin/env bash
set -euo pipefail

PROFILE="${EGDESK_FIREFOX_PROFILE:-$HOME/Library/Application Support/Firefox/Profiles/egtc3irr.egdesk.default-release}"
LAUNCH_MODE="${EGDESK_FIREFOX_MODE:-automation}"

case "$LAUNCH_MODE" in
  normal|automation) ;;
  *) echo "[ERROR] EGDESK_FIREFOX_MODE must be normal or automation" >&2; exit 1 ;;
esac

if [[ ! -d "$PROFILE" ]]; then
  echo "[ERROR] Firefox profile not found: $PROFILE" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="$(node "$SCRIPT_DIR/validate-firefox-profile.mjs" "$PROFILE")"

# Preserve unrelated preferences; explicit false values also override prefs.js
# settings left over from an earlier automation session on the next startup.
node - "$PROFILE" "$LAUNCH_MODE" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [profile, mode] = process.argv.slice(2);
const port = (name, fallback) => {
  const value = process.env[name] ?? String(fallback);
  if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return Number(value);
};
const marionettePort = port('EGDESK_FIREFOX_MARIONETTE_PORT', 2828);
const remoteAgentPort = port('EGDESK_FIREFOX_REMOTE_AGENT_PORT', 6000);
if (marionettePort === remoteAgentPort) {
  throw new Error('Firefox automation ports must differ');
}
const target = path.join(profile, 'user.js');
const exists = fs.existsSync(target);
if (exists && fs.lstatSync(target).isSymbolicLink()) {
  throw new Error('Refusing to replace a symlinked user.js');
}
const automation = mode === 'automation';
const managed = new Map([
  ['devtools.debugger.remote-enabled', automation],
  ['devtools.debugger.remote-port', remoteAgentPort],
  ['devtools.debugger.prompt-connection', !automation],
  ['devtools.chrome.enabled', true],
  ['devtools.debugger.remote-host', '127.0.0.1'],
  ['marionette.enabled', automation],
  ['marionette.port', marionettePort],
  // EG-Desk is an app built on Firefox, not the person's web browser: never ask to become the default browser. Set on every
  // start (user.js wins over prefs.js), so the answer cannot come back after an automation session or an unsaved quit (owner, 2026-11-26).
  ['browser.shell.checkDefaultBrowser', false],
  ['browser.shell.skipDefaultBrowserCheckOnFirstRun', true],
  ['browser.startup.upgradeDialog.enabled', false],
]);
const marker = '// EG-Desk remote automation (managed by write-userjs.sh).';
const original = exists ? fs.readFileSync(target, 'utf8') : '';
const retained = original.split(/\r?\n/).filter(line => {
  if (line === marker) return false;
  const match = line.match(/^\s*user_pref\(\s*["']([^"']+)["']\s*,[^;]*\);\s*(?:\/\/.*)?$/);
  return !match || !managed.has(match[1]);
}).join('\n').replace(/\n*$/, '');
const settings = [...managed].map(([key, value]) =>
  `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n');
const content = `${retained ? retained + '\n\n' : ''}${marker}\n${settings}\n`;
const temporary = `${target}.egdesk-${process.pid}.tmp`;
try {
  fs.writeFileSync(temporary, content, {
    flag: 'wx', mode: exists ? fs.statSync(target).mode & 0o777 : 0o600,
  });
  fs.renameSync(temporary, target);
} finally {
  if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
}
console.log(`[info] Firefox preferences updated (${mode}): ${target}`);
NODE
