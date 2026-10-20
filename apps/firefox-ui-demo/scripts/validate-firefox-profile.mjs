#!/usr/bin/env node
// The existing EG-Desk profile is grandfathered in. Other profiles require an
// explicit marker placed in a newly created, isolated Firefox profile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isOwnedAndPrivate } from './egdesk-qa-platform.mjs';

const markerName = '.egdesk-dedicated-firefox-profile';
const markerContents = 'EGDESK_DEDICATED_FIREFOX_PROFILE_V1\n';
const defaultProfile = path.join(
  os.userInfo().homedir,
  'Library/Application Support/Firefox/Profiles/egtc3irr.egdesk.default-release',
);

function reject(message) {
  throw new Error(`Unsafe Firefox profile: ${message}`);
}

try {
  const input = process.argv[2];
  if (!input || !path.isAbsolute(input) || /[\r\n]/.test(input)) {
    reject('provide an absolute profile path');
  }

  const profile = path.resolve(input);
  const stat = fs.lstatSync(profile);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    reject('profile must be a real directory, not a symlink');
  }
  if (!isOwnedAndPrivate(profile, stat)) {
    reject('profile must be owned by this user and not group/world writable');
  }
  if (fs.realpathSync.native(profile) !== profile) {
    reject('profile path must not traverse symlinks; use its canonical path');
  }

  const realHome = fs.realpathSync.native(os.userInfo().homedir);
  const runtimeHome = fs.realpathSync.native(os.homedir());
  const isAncestorOf = (candidate, target) =>
    candidate === target || target.startsWith(candidate + path.sep);
  if (
    profile === path.parse(profile).root ||
    isAncestorOf(profile, realHome) ||
    isAncestorOf(profile, runtimeHome) ||
    (profile !== defaultProfile && isAncestorOf(profile, defaultProfile))
  ) {
    reject('root, home, and Firefox profile-parent directories are not profiles');
  }

  if (profile !== defaultProfile) {
    const marker = path.join(profile, markerName);
    if (!fs.existsSync(marker)) {
      reject(`alternate profile needs ${markerName} containing EGDESK_DEDICATED_FIREFOX_PROFILE_V1`);
    }
    const markerStat = fs.lstatSync(marker);
    if (!markerStat.isFile() || markerStat.isSymbolicLink() ||
        !isOwnedAndPrivate(marker, markerStat) ||
        fs.readFileSync(marker, 'utf8') !== markerContents) {
      reject(`alternate profile needs a user-owned ${markerName} with the exact V1 marker`);
    }
  }

  process.stdout.write(`${profile}\n`);
} catch (error) {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 1;
}
