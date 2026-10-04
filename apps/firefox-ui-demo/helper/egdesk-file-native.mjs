import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUEST_MAGIC = Buffer.from('EGDCRQ01');
const RESPONSE_MAGIC = Buffer.from('EGDCRS01');
const REQUEST_HEADER_BYTES = 64;
const RESPONSE_HEADER_BYTES = 40;
const MAX_CONTENT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_U64 = (1n << 64n) - 1n;
const DEFAULT_EXECUTABLE = fileURLToPath(
  new URL('./posix-file-helper/build/egdesk-file-create', import.meta.url),
);

const NATIVE_STATUS = new Map([
  [1, 'bad request'],
  [2, 'root identity mismatch or root unavailable'],
  [3, 'directory path refused'],
  [4, 'directory identity mismatch'],
  [5, 'target already exists'],
  [6, 'create refused'],
  [7, 'created file metadata failed'],
  [8, 'write failed'],
  [9, 'sync failed'],
  [10, 'readback failed'],
  [11, 'close failed'],
]);

function failure(code, message, { created = null, nativeStatus, dev, ino } = {}) {
  const error = new Error(message);
  error.code = code;
  error.created = created;
  error.fileMayExist = created !== false;
  if (nativeStatus !== undefined) error.nativeStatus = nativeStatus;
  if (dev !== undefined) error.dev = dev;
  if (ino !== undefined) error.ino = ino;
  return error;
}

function utf8Field(value, label, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label} must be a ${allowEmpty ? '' : 'nonempty '}string`);
  }
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length > maximum || encoded.includes(0) ||
      encoded.toString('utf8') !== value) {
    throw new TypeError(`${label} is not a valid bounded UTF-8 field`);
  }
  return encoded;
}

function identityValue(value, label) {
  let normalized;
  if (typeof value === 'bigint') {
    normalized = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    normalized = BigInt(value);
  } else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    normalized = BigInt(value);
  } else {
    throw new TypeError(`${label} must be an exact unsigned integer`);
  }
  if (normalized < 0n || normalized > MAX_U64) {
    throw new RangeError(`${label} is outside the unsigned 64-bit range`);
  }
  return normalized;
}

function validateArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new TypeError('createFile requires an argument object');
  }
  const root = utf8Field(args.rootPath, 'rootPath', 4096);
  if (!path.posix.isAbsolute(args.rootPath) ||
      (root.length > 1 && args.rootPath.endsWith('/'))) {
    throw new TypeError('rootPath must be an absolute path without a trailing slash');
  }

  const relative = utf8Field(args.relativeDirectory, 'relativeDirectory', 4096,
    { allowEmpty: true });
  if (args.relativeDirectory !== '' &&
      args.relativeDirectory.split('/').some((part) =>
        part === '' || part === '.' || part === '..')) {
    throw new TypeError('relativeDirectory must contain only ordinary components');
  }

  const name = utf8Field(args.fileName, 'fileName', 255);
  if (args.fileName === '.' || args.fileName === '..' || args.fileName.includes('/')) {
    throw new TypeError('fileName must be one ordinary component');
  }
  const operation = utf8Field(args.operationId, 'operationId', 128);
  const rootIdentity = args.rootIdentity;
  const directoryIdentity = args.directoryIdentity;
  if (!rootIdentity || typeof rootIdentity !== 'object' ||
      !directoryIdentity || typeof directoryIdentity !== 'object') {
    throw new TypeError('rootIdentity and directoryIdentity are required');
  }

  if (!(args.bytes instanceof Uint8Array)) {
    throw new TypeError('bytes must be a Buffer or Uint8Array');
  }
  if (args.bytes.byteLength > MAX_CONTENT_BYTES) {
    throw new RangeError(`bytes exceed the ${MAX_CONTENT_BYTES}-byte limit`);
  }
  const bytes = Buffer.from(args.bytes); // Snapshot before hashing or dispatch.
  return {
    root, relative, name, operation, bytes,
    rootDev: identityValue(rootIdentity.dev, 'rootIdentity.dev'),
    rootIno: identityValue(rootIdentity.ino, 'rootIdentity.ino'),
    directoryDev: identityValue(directoryIdentity.dev, 'directoryIdentity.dev'),
    directoryIno: identityValue(directoryIdentity.ino, 'directoryIdentity.ino'),
  };
}

function requestBuffer(request) {
  const header = Buffer.alloc(REQUEST_HEADER_BYTES);
  REQUEST_MAGIC.copy(header);
  header.writeUInt32BE(request.root.length, 8);
  header.writeUInt32BE(request.relative.length, 12);
  header.writeUInt32BE(request.name.length, 16);
  header.writeUInt32BE(request.operation.length, 20);
  header.writeBigUInt64BE(request.rootDev, 24);
  header.writeBigUInt64BE(request.rootIno, 32);
  header.writeBigUInt64BE(request.directoryDev, 40);
  header.writeBigUInt64BE(request.directoryIno, 48);
  header.writeBigUInt64BE(BigInt(request.bytes.length), 56);
  return Buffer.concat([
    header, request.root, request.relative, request.name,
    request.operation, request.bytes,
  ]);
}

function verifyReceipt(output, request, exitCode, signal, inputError) {
  if (output.length < RESPONSE_HEADER_BYTES ||
      !output.subarray(0, 8).equals(RESPONSE_MAGIC)) {
    throw failure('EGDESK_NATIVE_PROTOCOL',
      'Native create returned an invalid receipt; a new file may remain.');
  }
  const status = output.readUInt32BE(8);
  const flags = output.readUInt32BE(12);
  const size = output.readBigUInt64BE(16);
  const dev = output.readBigUInt64BE(24);
  const ino = output.readBigUInt64BE(32);
  if ((flags & ~1) !== 0 || size > BigInt(MAX_CONTENT_BYTES) ||
      (!NATIVE_STATUS.has(status) && status !== 0)) {
    throw failure('EGDESK_NATIVE_PROTOCOL',
      'Native create returned invalid metadata; a new file may remain.');
  }
  const created = (flags & 1) !== 0;
  const body = output.subarray(RESPONSE_HEADER_BYTES);

  if (status !== 0) {
    if (body.length !== 0 || size !== 0n || exitCode !== 1 || signal !== null) {
      throw failure('EGDESK_NATIVE_PROTOCOL',
        'Native create returned inconsistent failure metadata; a new file may remain.');
    }
    throw failure('EGDESK_NATIVE_REFUSED',
      `Native create ${NATIVE_STATUS.get(status)}; ${created
        ? 'the new file was left in place and may be partial.'
        : 'no new file was created.'}`,
      { created, nativeStatus: status,
        ...(created ? { dev: dev.toString(), ino: ino.toString() } : {}) });
  }

  if (!created || exitCode !== 0 || signal !== null || inputError ||
      size !== BigInt(request.bytes.length) ||
      body.length !== request.bytes.length || dev === 0n || ino === 0n) {
    throw failure('EGDESK_NATIVE_PROTOCOL',
      'Native create returned inconsistent success metadata; a new file may remain.');
  }
  const sha256 = createHash('sha256').update(body).digest('hex');
  const expectedSha256 = createHash('sha256').update(request.bytes).digest('hex');
  if (!body.equals(request.bytes) || sha256 !== expectedSha256) {
    throw failure('EGDESK_NATIVE_READBACK_MISMATCH',
      'Native readback differed from the requested bytes; the new file was left in place.',
      { created: true, dev: dev.toString(), ino: ino.toString() });
  }
  return { created: true, sha256, size: body.length,
    dev: dev.toString(), ino: ino.toString() };
}

function execute(executable, timeoutMs, request) {
  const input = requestBuffer(request);
  const maxOutputBytes = RESPONSE_HEADER_BYTES + request.bytes.length;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, [], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      reject(failure('EGDESK_NATIVE_UNAVAILABLE',
        'Native create could not start; no path-based fallback was used.',
        { created: false }));
      return;
    }

    let settled = false;
    let spawned = false;
    let inputError = false;
    let outputBytes = 0;
    let stderrBytes = 0;
    const outputChunks = [];
    const timer = setTimeout(() => {
      if (settled) return;
      finish(reject, failure('EGDESK_NATIVE_TIMEOUT',
        'Native create timed out; a partial new file may remain and was not removed.'));
      child.kill('SIGKILL');
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }, timeoutMs);

    function finish(settle, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    }

    child.once('spawn', () => { spawned = true; });
    child.once('error', () => {
      finish(reject, failure('EGDESK_NATIVE_UNAVAILABLE',
        'Native create executable is unavailable; no path-based fallback was used.',
        { created: spawned ? null : false }));
    });
    child.stdin.on('error', () => { inputError = true; });
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        finish(reject, failure('EGDESK_NATIVE_OUTPUT_LIMIT',
          'Native create exceeded its output bound; a partial new file may remain.'));
        child.kill('SIGKILL');
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        return;
      }
      outputChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (settled) return;
      stderrBytes += chunk.length;
      // Never include native stderr (or file contents/paths) in logs or errors.
      if (stderrBytes > MAX_STDERR_BYTES) {
        finish(reject, failure('EGDESK_NATIVE_OUTPUT_LIMIT',
          'Native create exceeded its error-output bound; a partial new file may remain.'));
        child.kill('SIGKILL');
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      try {
        const result = verifyReceipt(Buffer.concat(outputChunks, outputBytes),
          request, exitCode, signal, inputError);
        finish(resolve, result);
      } catch (error) {
        finish(reject, error);
      }
    });
    child.stdin.end(input);
  });
}

export function createEGDeskNativeCreateOnlyAdapter({
  executable = DEFAULT_EXECUTABLE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof executable !== 'string' || !path.posix.isAbsolute(executable)) {
    throw new TypeError('executable must be an absolute path');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
  }
  return {
    capability: 'descriptor-relative-create-only',
    createFile(args) {
      return execute(executable, timeoutMs, validateArgs(args));
    },
  };
}
