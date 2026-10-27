import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EGDESK_APP_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const PINNED_NODE_VERSION = fs.readFileSync(path.join(EGDESK_APP_ROOT, '.node-version'), 'utf8').trim();
if (!/^24\.\d+\.\d+$/.test(PINNED_NODE_VERSION)) throw new Error('Invalid EG-Desk Node 24 version pin');

export function nodeDistributionName({ platform = process.platform, arch = process.arch } = {}) {
  const osName = { darwin: 'darwin', linux: 'linux', win32: 'win' }[platform];
  if (!osName || !['arm64', 'x64'].includes(arch)) {
    throw new Error(`No pinned EG-Desk Node distribution for ${platform}/${arch}`);
  }
  return `node-v${PINNED_NODE_VERSION}-${osName}-${arch}`;
}

export function pinnedNodeExecutable({ appRoot = EGDESK_APP_ROOT, platform = process.platform, arch = process.arch } = {}) {
  const name = nodeDistributionName({ platform, arch });
  return path.join(appRoot, '.tmp', 'node-runtime', name, ...(platform === 'win32' ? ['node.exe'] : ['bin', 'node']));
}
