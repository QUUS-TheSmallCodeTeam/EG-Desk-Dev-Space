#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EGDESK_APP_ROOT, PINNED_NODE_VERSION, nodeDistributionName, pinnedNodeExecutable } from '../helper/egdesk-node-runtime.mjs';

// SHA-256 values from https://nodejs.org/dist/v24.22.1/SHASUMS256.txt.
// A pin change requires a separately verified checksum for every distribution.
const CHECKSUMS = Object.freeze({
  'node-v24.22.1-darwin-arm64.tar.gz': '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7',
  'node-v24.22.1-darwin-x64.tar.gz': 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035',
  'node-v24.22.1-linux-arm64.tar.gz': '33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3',
  'node-v24.22.1-linux-x64.tar.gz': 'eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c',
  'node-v24.22.1-win-arm64.zip': 'a0c807319fede24c4a0d8f84564c82a619bd313b16b10c007c383c2609e99171',
  'node-v24.22.1-win-x64.zip': 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5',
});

export function nodeDistribution({ platform = process.platform, arch = process.arch } = {}) {
  const name = nodeDistributionName({ platform, arch });
  const filename = name + (platform === 'win32' ? '.zip' : '.tar.gz');
  const sha256 = CHECKSUMS[filename];
  if (!sha256) throw new Error(`No verified Node checksum for ${filename}`);
  return { name, filename, sha256, url: `https://nodejs.org/dist/v${PINNED_NODE_VERSION}/${filename}` };
}

export async function sha256File(filename) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadArchive(url, destination) {
  const response = await new Promise((resolve, reject) => {
    const request = https.get(url, resolve);
    request.on('error', reject);
    request.setTimeout(120000, () => request.destroy(new Error('Node download timed out')));
  });
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`Node download failed with HTTP ${response.statusCode}`);
  }
  await pipeline(response, fs.createWriteStream(destination, { flags: 'wx' }));
}

function safeDirectory(directory) {
  try { fs.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe runtime cache directory: ${directory}`);
}

export function verifyPinnedNode(executable) {
  const guard = fileURLToPath(new URL('../helper/egdesk-sqlite-runtime.mjs', import.meta.url));
  const script = `import { pathToFileURL } from 'node:url';
    const { assertPatchedSqliteRuntime } = await import(pathToFileURL(process.argv[1]).href);
    const runtime = assertPatchedSqliteRuntime();
    if (runtime.nodeVersion !== process.argv[2]) throw new Error('Node version does not match the project pin');
    console.log(JSON.stringify(runtime));`;
  const result = spawnSync(executable, ['--input-type=module', '-e', script, guard, PINNED_NODE_VERSION],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`The pinned Node runtime could not be verified at ${executable}: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  }
  try { return JSON.parse(result.stdout.trim()); }
  catch { throw new Error(`Unexpected runtime verification output from ${executable}`); }
}

export async function installPinnedNode({ appRoot = EGDESK_APP_ROOT, platform = process.platform, arch = process.arch,
  download = downloadArchive } = {}) {
  const artifact = nodeDistribution({ platform, arch });
  const tmp = path.join(appRoot, '.tmp'), cache = path.join(tmp, 'node-runtime');
  safeDirectory(tmp);
  safeDirectory(cache);
  const destination = path.join(cache, artifact.name);
  const executable = pinnedNodeExecutable({ appRoot, platform, arch });
  const lock = path.join(cache, `.install-${artifact.name}.lock`);
  try { fs.mkdirSync(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Node installation is already locked: ${lock}`);
    throw error;
  }
  let stage;
  try {
    if (fs.existsSync(destination)) {
      const existing = fs.lstatSync(destination);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`Unsafe existing runtime directory: ${destination}`);
      return { status: 'already-present', executable, runtime: verifyPinnedNode(executable), archiveSha256: null };
    }
    stage = fs.mkdtempSync(path.join(cache, '.download-'));
    const archive = path.join(stage, artifact.filename);
    await download(artifact.url, archive);
    const actualSha256 = await sha256File(archive);
    if (actualSha256 !== artifact.sha256) throw new Error(`Node archive checksum mismatch for ${artifact.filename}`);
    // Extraction is performed only after checking the entire official archive.
    execFileSync('tar', ['-xf', archive, '-C', stage], { stdio: 'pipe', windowsHide: true });
    const extracted = path.join(stage, artifact.name);
    const stagedExecutable = path.join(extracted, ...(platform === 'win32' ? ['node.exe'] : ['bin', 'node']));
    const runtime = verifyPinnedNode(stagedExecutable);
    // mkdir is exclusive: never replace a pre-existing runtime directory.
    fs.mkdirSync(destination);
    try {
      for (const entry of fs.readdirSync(extracted)) {
        fs.cpSync(path.join(extracted, entry), path.join(destination, entry),
          { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
      }
    }
    catch (error) { throw new Error(`Runtime copy failed; inspect the incomplete directory ${destination}: ${error.message}`); }
    return { status: 'installed', executable, runtime, archiveSha256: actualSha256 };
  } finally {
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
    fs.rmdirSync(lock);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installPinnedNode().then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
