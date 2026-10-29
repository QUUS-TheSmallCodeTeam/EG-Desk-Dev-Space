// Privileged, user-initiated Chrome cookie migration. No HTTP, logging, extension,
// profile writes, or secret-bearing result objects. This module never exposes
// its source rows, decrypted bytes, or cookie readback to its caller.
//
// Upstream interfaces and storage format:
// https://github.com/mozilla-firefox/firefox/blob/main/browser/components/migration/nsKeychainMigrationUtils.mm
// https://github.com/mozilla-firefox/firefox/blob/main/browser/components/migration/ChromeMacOSLoginCrypto.sys.mjs
// https://github.com/mozilla-firefox/firefox/blob/main/toolkit/modules/Sqlite.sys.mjs
// https://github.com/mozilla-firefox/firefox/blob/main/netwerk/cookie/nsICookieManager.idl
// https://github.com/mozilla-firefox/firefox/blob/main/netwerk/cookie/nsICookie.idl
// https://chromium.googlesource.com/chromium/src/net/+/HEAD/extras/sqlite/sqlite_persistent_cookie_store.cc
// https://chromium.googlesource.com/chromium/src/+/HEAD/net/cookies/cookie_base.cc

const MAX_ROWS = 20000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_DB_BYTES = 512 * 1024 * 1024;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_PROFILES = 100;
const MAX_FIELD_BYTES = 16384;
const MAX_READ_MS = 15000;
const WINDOWS_EPOCH_MICROS = 11644473600000000n;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const DIRECTORY = /^(?:Default|Profile [1-9][0-9]{0,5})$/;
const COOKIE_COLUMNS = [
  'creation_utc', 'host_key', 'top_frame_site_key', 'name', 'value',
  'encrypted_value', 'path', 'expires_utc', 'is_secure', 'is_httponly',
  'last_access_utc', 'has_expires', 'is_persistent', 'priority', 'samesite',
  'source_scheme', 'source_port', 'last_update_utc', 'source_type',
  'has_cross_site_ancestor',
];
const TEXT_COLUMNS = new Set(['host_key', 'top_frame_site_key', 'name', 'value', 'path']);
const READ_COLUMNS = [
  'host_key', 'top_frame_site_key', 'name', 'value', 'encrypted_value', 'path',
  'expires_utc', 'is_secure', 'is_httponly', 'has_expires', 'is_persistent',
  'samesite', 'source_scheme', 'source_port', 'has_cross_site_ancestor',
];
const byteEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const NATIVE_INIT_FAILURE = Symbol('native-init-failure');

class ImportFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new ImportFailure(code); };
const counts0 = () => ({ imported: 0, skipped: 0, unsupported: 0, failed: 0 });
const validId = n => Number.isSafeInteger(n) && n > 0 && n < 0xffffffff;
const isBooleanInteger = n => n === 0 || n === 1;
const sizeOf = value => typeof value === 'string' ? (value.length > MAX_FIELD_BYTES ?
  MAX_FIELD_BYTES + 1 : byteEncoder.encode(value).length) :
  value instanceof Uint8Array ? value.byteLength : Array.isArray(value) ? value.length : 0;

function safeName(value) {
  if (typeof value !== 'string') return 'Chrome profile';
  const name = value.trim();
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f-\u009f]/u.test(name) ||
      /:\/\/|[\u202a-\u202e\u2066-\u2069]/u.test(name)) return 'Chrome profile';
  return name;
}

function safeEmail(value) {
  return typeof value === 'string' && value.length <= 254 &&
    /^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/u.test(value) ? value : undefined;
}

function safeReason(error, fallback = 'unavailable') {
  const allowed = new Set(['permission-denied', 'unavailable', 'source-busy', 'unsafe-path',
    'source-wal-unsupported', 'resource-limit', 'unsupported-schema', 'keychain-unavailable-or-denied',
    'keychain-permission-denied', 'cookie-capacity-exceeded', 'cookie-capacity-unverified',
    'cookie-validation-failed', 'cookie-expiry-cap-exceeded', 'cookie-readback-mismatch', 'source-timeout', 'cancelled']);
  if (error instanceof ImportFailure && allowed.has(error.code)) return error.code;
  if (error?.code === 'permission-denied' || error?.name === 'NotAllowedError' ||
      error?.name === 'SecurityError') return 'permission-denied';
  if (error?.code === 'unavailable' || error?.name === 'NotFoundError') return 'unavailable';
  return fallback;
}

function interrupted(signal) {
  if (signal?.aborted) fail('cancelled');
}

function validSignal(signal) {
  return signal == null || (typeof signal.aborted === 'boolean' &&
    typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function');
}

function fileError(error) {
  if (error instanceof ImportFailure) throw error;
  const result = error?.result;
  if (typeof result === 'number' && globalThis.Cr && (result === Cr.NS_ERROR_FILE_ACCESS_DENIED ||
      result === Cr.NS_ERROR_FILE_IS_LOCKED || result === Cr.NS_ERROR_STORAGE_BUSY)) fail(result === Cr.NS_ERROR_FILE_ACCESS_DENIED ?
    'permission-denied' : 'source-busy');
  fail(safeReason(error));
}

/* Constructed only in Gecko. There is deliberately no production path, root,
 * profile, Keychain-service, or environment override. */
function geckoAdapter(browserWindow) {
  let failure = 'native-module-loader-unavailable';
  try {
    if (typeof globalThis.ChromeUtils?.importESModule !== 'function') throw new Error();
    const importer = url => globalThis.ChromeUtils.importESModule(url);
    failure = 'native-platform-unavailable';
    const { AppConstants } = importer('resource://gre/modules/AppConstants.sys.mjs');
    if (typeof AppConstants?.platform !== 'string' || !AppConstants.platform) throw new Error();
    if (AppConstants.platform !== 'macosx') return { platform: AppConstants.platform };
    failure = 'native-services-unavailable';
    const services = globalThis.Services;
    if (!services) throw new Error();
    failure = 'native-version-unavailable';
    const version = services.appinfo?.platformVersion;
    if (typeof version !== 'string' || !/^\d{1,3}(?:[.ab]|$)/i.test(version)) throw new Error();
    const majorVersion = Number.parseInt(version, 10);
    if (majorVersion < 142) return { [NATIVE_INIT_FAILURE]: 'gecko-version-unsupported' };
    failure = 'native-private-browsing-unavailable';
    const { PrivateBrowsingUtils } = importer('resource://gre/modules/PrivateBrowsingUtils.sys.mjs');
    if (typeof PrivateBrowsingUtils?.isWindowPrivate !== 'function') throw new Error();
    failure = 'native-contextual-identity-unavailable';
    let identities;
    try {
      identities = importer('moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs')
        .ContextualIdentityService;
      if (!identities) throw new Error();
    } catch {
      // Firefox versions before the moz-src migration used this module URI.
      identities = importer('resource://gre/modules/ContextualIdentityService.sys.mjs')
        .ContextualIdentityService;
    }
    if (typeof identities?.create !== 'function' || typeof identities?.remove !== 'function' ||
        typeof identities?.getPublicIdentities !== 'function') throw new Error();
    failure = 'native-sqlite-unavailable';
    const { Sqlite } = importer('resource://gre/modules/Sqlite.sys.mjs');
    if (typeof Sqlite?.openConnection !== 'function') throw new Error();
    failure = 'native-components-unavailable';
    const ci = globalThis.Ci ?? globalThis.Components?.interfaces;
    const cc = globalThis.Cc ?? globalThis.Components?.classes;
    if (!ci || !cc) throw new Error();
    failure = 'native-cookie-api-unavailable';
    if (typeof ci.nsICookieValidation?.eOK !== 'number' ||
        typeof services.cookies?.add !== 'function' ||
        typeof services.cookies?.getCookiesWithOriginAttributes !== 'function' ||
        typeof services.cookies?.removeCookiesWithOriginAttributes !== 'function') throw new Error();
    failure = 'native-io-unavailable';
    const io = globalThis.IOUtils;
    if (!io || typeof io.read !== 'function') throw new Error();
    failure = 'native-crypto-unavailable';
    const crypt = globalThis.crypto;
    if (!crypt?.subtle || typeof crypt.randomUUID !== 'function') throw new Error();

    function checkAccess() {
      try {
        if (AppConstants.platform !== 'macosx') return 'platform-unsupported';
        // Newer Gecko excludes expired entries from its public cookie getter;
        // its total in-memory quota count cannot be proven from that getter.
        if (majorVersion > 158) return 'cookie-capacity-unverified';
        if (!browserWindow || browserWindow.closed !== false || browserWindow.isChromeWindow !== true ||
            !browserWindow.docShell || browserWindow.document?.nodePrincipal?.isSystemPrincipal !== true ||
            PrivateBrowsingUtils.isWindowPrivate(browserWindow) !== false) return 'private-context-unverified';
        if (typeof services?.policies?.isAllowed !== 'function') return 'policy-unavailable';
        if (services.policies.isAllowed('profileImport') !== true) return 'policy-denied';
        if (services.prefs.getBoolPref('privacy.userContext.enabled', false) !== true) return 'containers-disabled';
        // CookieStorage's Debug logger prints cookie values. Refuse all logging
        // configurations we can observe rather than modifying the user's prefs.
        // Rechecked immediately before every add. This also covers the profiler
        // when configured through about:logging.
        if (typeof services.env?.get !== 'function' || typeof services.prefs.getChildList !== 'function') {
          return 'logging-unverified';
        }
        for (const name of ['MOZ_LOG', 'MOZ_LOG_MODULES', 'NSPR_LOG', 'NSPR_LOG_MODULES']) {
          if (services.env.get(name)) return 'logging-enabled';
        }
        const logPrefs = services.prefs.getChildList('logging.');
        if (!Array.isArray(logPrefs)) return 'logging-unverified';
        if (logPrefs.some(name => !name.startsWith('logging.config.'))) return 'logging-enabled';
        if (!services.cookies || !ci || !cc || !io || !crypt?.subtle || !crypt?.randomUUID ||
            typeof identities?.create !== 'function' || typeof identities?.remove !== 'function' ||
            typeof identities?.getPublicIdentities !== 'function') return 'unavailable';
        return true;
      } catch { return 'unavailable'; }
    }

    function appendChecked(parent, leaf, kind, optional = false) {
      try {
        const file = parent.clone();
        file.append(leaf);
        // isSymlink is checked before exists so even a dangling link is rejected.
        let link = false;
        try { link = file.isSymlink(); } catch (error) {
          if (!optional || !globalThis.Cr || typeof error?.result !== 'number' ||
              error.result !== Cr.NS_ERROR_FILE_NOT_FOUND) throw error;
          return null;
        }
        if (link) fail('unsafe-path');
        if (!file.exists()) {
          if (optional) return null;
          fail('unavailable');
        }
        if ((kind === 'directory' && !file.isDirectory()) ||
            (kind === 'file' && !file.isFile())) fail('unsafe-path');
        if (!file.isReadable()) fail('permission-denied');
        const resolved = file.clone();
        resolved.normalize();
        if (resolved.path !== file.path) fail('unsafe-path');
        return file;
      } catch (error) { return fileError(error); }
    }

    function root() {
      try {
        let current = services.dirsvc.get('Home', ci.nsIFile).clone();
        if (!current.exists() || !current.isDirectory() || current.isSymlink()) fail('unsafe-path');
        const resolved = current.clone();
        resolved.normalize();
        if (resolved.path !== current.path) fail('unsafe-path');
        for (const segment of ['Library', 'Application Support', 'Google', 'Chrome']) {
          current = appendChecked(current, segment, 'directory');
        }
        return current;
      } catch (error) { return fileError(error); }
    }

    function profileDirectory(directory) {
      if (!DIRECTORY.test(directory)) fail('unsafe-path');
      return appendChecked(root(), directory, 'directory');
    }

    async function readRoot() {
      const base = root();
      const localState = appendChecked(base, 'Local State', 'file');
      try {
        if (localState.fileSize > MAX_STATE_BYTES) fail('resource-limit');
        const bytes = await io.read(localState.path, { maxBytes: MAX_STATE_BYTES + 1 });
        if (bytes.byteLength > MAX_STATE_BYTES) fail('resource-limit');
        const state = JSON.parse(textDecoder.decode(bytes));
        const cache = state?.profile?.info_cache;
        if (!cache || typeof cache !== 'object' || Array.isArray(cache)) fail('unavailable');
        const labs = state?.browser?.enabled_labs_experiments;
        if (labs !== undefined && (!Array.isArray(labs) || labs.length > 10000)) fail('resource-limit');
        // Recognize positive about:flags evidence only. Missing flags do not
        // prove the runtime features, command line or enterprise state is off.
        const scopeBindings = {
          port: Array.isArray(labs) && (labs.includes('bind-cookies-to-port@1') ||
            labs.includes('bind-cookies-to-port')) ? true : undefined,
          scheme: Array.isArray(labs) && (labs.includes('bind-cookies-to-scheme@1') ||
            labs.includes('bind-cookies-to-scheme')) ? true : undefined,
        };
        const entries = Object.entries(cache);
        if (entries.length > MAX_PROFILES) fail('resource-limit');
        const profiles = [];
        for (const [directory, meta] of entries) {
          if (!DIRECTORY.test(directory) || !meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
          // Recheck the directory at import time as well; the opaque UI id is
          // never interpreted as, or concatenated into, a filesystem path.
          const dir = appendChecked(base, directory, 'directory', true);
          if (!dir) continue;
          profiles.push({ directory, name: safeName(meta.name), email: safeEmail(meta.user_name), scopeBindings });
        }
        return profiles;
      } catch (error) { return fileError(error); }
    }

    function cookieFile(directory) {
      const dir = profileDirectory(directory);
      const direct = appendChecked(dir, 'Cookies', 'file', true);
      const network = appendChecked(dir, 'Network', 'directory', true);
      const nested = network && appendChecked(network, 'Cookies', 'file', true);
      if (direct && nested) fail('unsupported-schema');
      const file = direct || nested;
      if (!file) fail('unavailable');
      const parent = direct ? dir : network;
      const wal = appendChecked(parent, 'Cookies-wal', 'file', true);
      const shm = appendChecked(parent, 'Cookies-shm', 'file', true);
      const journal = appendChecked(parent, 'Cookies-journal', 'file', true);
      if (journal && journal.fileSize > 0) fail('source-busy');
      const sizes = [file.fileSize, wal?.fileSize ?? 0, shm?.fileSize ?? 0];
      if (sizes.some(size => !Number.isSafeInteger(size) || size < 0) ||
          sizes.reduce((sum, size) => sum + size, 0) > MAX_DB_BYTES) fail('resource-limit');
      return file;
    }

    async function readSqlite(directory, { maxRows, maxBytes, signal }) {
      let connection, timer, timedOut = false;
      const { setTimeout: startTimer, clearTimeout: stopTimer } = importer('resource://gre/modules/Timer.sys.mjs');
      if (typeof startTimer !== 'function' || typeof stopTimer !== 'function') fail('unavailable');
      function interrupt() { try { connection?.interrupt(); } catch { /* open or close may still be pending */ } }
      function check() {
        interrupted(signal);
        if (timedOut) fail('source-timeout');
      }
      const onAbort = () => interrupt();
      try {
        timer = startTimer(() => { timedOut = true; interrupt(); }, MAX_READ_MS);
        signal?.addEventListener('abort', onAbort, { once: true });
        check();
        // Refresh only narrow profile/experiment metadata after consent.
        const source = (await readRoot()).find(item => item.directory === directory);
        check();
        if (!source) fail('unavailable');
        const file = cookieFile(directory);
        const header = await io.read(file.path, { maxBytes: 20 });
        check();
        const signature = byteEncoder.encode('SQLite format 3\u0000');
        if (header.length < 20 || signature.some((byte, index) => header[index] !== byte)) fail('unsupported-schema');
        if (header[18] !== header[19] || ![1, 2].includes(header[18])) fail('unsupported-schema');
        if (cookieFile(directory).path !== file.path) fail('unsafe-path');
        // Gecko's storage initialization sets connection PRAGMAs internally;
        // this importer issues no source-data/schema writes or checkpoint.
        connection = await Sqlite.openConnection({ path: file.path, readOnly: true,
          ignoreLockingMode: false, sharedMemoryCache: false, openNotExclusive: true });
        check();
        const snapshot = await connection.executeTransaction(async db => {
          check();
          const tables = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('meta','cookies')");
          check();
          const tableNames = new Set(tables.map(item => item.getResultByName('name')));
          if (!tableNames.has('cookies')) return { version: 0, rows: [], totalRows: 0, schemaSupported: false };
          const countRows = await db.execute('SELECT COUNT(*) AS n FROM (SELECT 1 FROM cookies LIMIT :limit)',
            { limit: maxRows + 1 });
          check();
          const totalRows = countRows[0].getResultByName('n');
          if (!Number.isSafeInteger(totalRows) || totalRows > maxRows) fail('resource-limit');
          if (!tableNames.has('meta')) return { version: 0, rows: [], totalRows, schemaSupported: false };
          const meta = await db.execute("SELECT CAST(value AS TEXT) AS v FROM meta WHERE key = 'version' LIMIT 2");
          check();
          const versionText = meta.length === 1 ? meta[0].getResultByName('v') : '';
          const version = /^[0-9]+$/.test(versionText) ? Number(versionText) : 0;
          const info = await db.execute('PRAGMA table_xinfo(cookies)');
          check();
          const columnsByName = new Map(info.map(row => [row.getResultByName('name'), row]));
          const supported = (version === 23 || version === 24) &&
            info.length === COOKIE_COLUMNS.length &&
            COOKIE_COLUMNS.every(name => {
              const column = columnsByName.get(name);
              const type = name === 'encrypted_value' ? 'BLOB' : TEXT_COLUMNS.has(name) ? 'TEXT' : 'INTEGER';
              return column && column.getResultByName('type')?.toUpperCase() === type &&
                column.getResultByName('notnull') === 1 && column.getResultByName('hidden') === 0;
            });
          if (!supported) return { version, rows: [], totalRows, schemaSupported: false };
          const sizeTerms = ['host_key', 'top_frame_site_key', 'name', 'value', 'encrypted_value', 'path']
            .map(name => `COALESCE(length(CAST(${name} AS BLOB)),0)`).join(' + ');
          const sizeRows = await db.execute(`SELECT CAST(COALESCE(SUM(${sizeTerms}),0) AS TEXT) AS n FROM cookies`);
          check();
          const sizeText = sizeRows[0].getResultByName('n');
          if (!/^[0-9]+$/.test(sizeText) || BigInt(sizeText) > BigInt(maxBytes)) fail('resource-limit');
          const columns = READ_COLUMNS.map(name => name === 'expires_utc' ?
            "CASE WHEN typeof(expires_utc) = 'integer' THEN CAST(expires_utc AS TEXT) ELSE NULL END AS expires_utc" : `${name} AS ${name}`);
          const result = await db.execute(`SELECT ${columns.join(', ')} FROM cookies`);
          check();
          return { version, totalRows, rows: result.map(row => Object.fromEntries(
            READ_COLUMNS.map(name => [name, row.getResultByName(name)]))) };
        }, connection.TRANSACTION_DEFERRED);
        check();
        return { ...snapshot, scopeBindings: source.scopeBindings };
      } catch (error) {
        check();
        return fileError(error);
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (timer !== undefined) stopTimer(timer);
        if (connection) await connection.close();
      }
    }

    return {
      platform: AppConstants.platform, crypto: crypt,
      randomUUID: () => crypt.randomUUID(), now: () => Date.now(), checkAccess, readRoot, readSqlite,
      getKeychainPassword() {
        try {
          // Mozilla's implementation uses SecItemCopyMatching only; it does not
          // create an item. It maps missing and denied alike to NS_ERROR_FAILURE.
          return cc['@mozilla.org/profile/migrator/keychainmigrationutils;1']
            .getService(ci.nsIKeychainMigrationUtils).getGenericPassword('Chrome Safe Storage', 'Chrome');
        } catch { fail('keychain-unavailable-or-denied'); }
      },
      getIdentityIds: () => identities.getPublicIdentities().map(identity => identity.userContextId),
      getCookieCapacity() {
        // Firefox 142-158 GetCookies includes expired in-memory entries, so
        // this length matches the persistent storage's mCookieCount. Later
        // Gecko versions changed that contract; don't guess a safe count.
        try {
          if (majorVersion > 158) fail('cookie-capacity-unverified');
          const all = services.cookies.cookies;
          if (!Array.isArray(all)) fail('cookie-capacity-unverified');
          const configured = services.prefs.getIntPref('network.cookie.maxNumber', 3000);
          const max = Number.isInteger(configured) && configured >= 1 && configured <= 65535 ? configured : 3000;
          return { current: all.length, max };
        } catch { fail('cookie-capacity-unverified'); }
      },
      createIdentity: name => identities.create(name, 'fingerprint', 'blue'),
      removeIdentity: id => identities.remove(id),
      cookies: {
        add(cookie, attrs) {
          const result = services.cookies.add(cookie.host, cookie.path, cookie.name, cookie.value,
            cookie.isSecure, cookie.isHttpOnly, cookie.isSession, cookie.expiry, attrs,
            cookie.sameSite, cookie.schemeMap, false);
          if (typeof ci.nsICookieValidation.eRejectedAttributeExpiryOversize === 'number' &&
              result?.result === ci.nsICookieValidation.eRejectedAttributeExpiryOversize) return 'cookie-expiry-cap-exceeded';
          return result?.result === ci.nsICookieValidation.eOK;
        },
        list: attrs => services.cookies.getCookiesWithOriginAttributes(JSON.stringify(attrs)),
        removeAll: attrs => services.cookies.removeCookiesWithOriginAttributes(JSON.stringify(attrs)),
      },
    };
  } catch { return { [NATIVE_INIT_FAILURE]: failure }; }
}

function rowIdentity(row) {
  const values = [row?.host_key, row?.name, row?.path];
  return values.every(value => typeof value === 'string' && value.length <= MAX_FIELD_BYTES) ?
    JSON.stringify(values) : null;
}

function rowBytes(row) {
  return ['host_key', 'top_frame_site_key', 'name', 'value', 'encrypted_value', 'path']
    .reduce((total, name) => total + sizeOf(row?.[name]), 0);
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) && value.length <= MAX_FIELD_BYTES &&
      value.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return Uint8Array.from(value);
  return null;
}

function classify(row, now, scopeMode, scopeBindings) {
  if (!row || typeof row !== 'object') return { category: 'failed' };
  const { host_key: host, name, path, value, top_frame_site_key: partition,
    has_cross_site_ancestor: ancestor, is_secure: secure, is_httponly: httpOnly,
    has_expires: hasExpires, is_persistent: persistent, samesite, source_scheme: scheme,
    source_port: port, expires_utc: expiry } = row;
  const encrypted = asBytes(row.encrypted_value);
  if (typeof host !== 'string' || typeof name !== 'string' || typeof path !== 'string' ||
      typeof value !== 'string' || typeof partition !== 'string' || !encrypted ||
      [host, name, path, value, partition].some(s => sizeOf(s) > MAX_FIELD_BYTES) ||
      encrypted.byteLength > MAX_FIELD_BYTES) return { category: 'failed' };
  if (partition !== '' || !isBooleanInteger(ancestor)) return { category: 'unsupported' };
  if (!isBooleanInteger(secure) || !isBooleanInteger(httpOnly) || !isBooleanInteger(hasExpires) ||
      !isBooleanInteger(persistent) || (persistent && !hasExpires) ||
      ![-1, 0, 1, 2, 3].includes(samesite) || ![0, 1, 2].includes(scheme) ||
      !Number.isInteger(port) || port < -1 || port > 65535) return { category: 'unsupported' };
  // Gecko has no equivalent port scope or enforced source-scheme scope.
  // Domain cookies are not port-bound in Chromium; secure cookies already
  // enforce a secure source scheme. An unrepresentable scope can only use
  // standard web semantics after separate explicit compatibility consent.
  const boundPort = !host.startsWith('.') && port !== -1;
  const boundScheme = scheme === 1 || (scheme === 2 && !secure);
  if ((boundPort && (scopeMode === 'preserve' || scopeBindings?.port === true)) ||
      (boundScheme && (scopeMode === 'preserve' || scopeBindings?.scheme === true))) {
    return { category: 'unsupported' };
  }
  if (!/^\.?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(host) ||
      host.includes('..') || !path.startsWith('/') || /[\u0000-\u001f\u007f]/u.test(host + name + path + value) ||
      (host.startsWith('.') && !host.slice(1).includes('.'))) return { category: 'unsupported' };
  if (encrypted.length && value !== '') return { category: 'failed' };
  if (encrypted.length && (encrypted.length < 19 || (encrypted.length - 3) % 16 !== 0 ||
      encrypted[0] !== 0x76 || encrypted[1] !== 0x31 || encrypted[2] !== 0x30)) {
    return { category: 'unsupported' };
  }
  let expiryMs = Number.MAX_SAFE_INTEGER;
  if (hasExpires) {
    if (typeof expiry !== 'string' || !/^[0-9]{1,20}$/.test(expiry)) return { category: 'failed' };
    const unixMicros = BigInt(expiry) - WINDOWS_EPOCH_MICROS;
    if (unixMicros <= 0n) return { category: 'skipped' };
    const unixMs = unixMicros / 1000n;
    if (unixMs > MAX_SAFE_BIGINT) return { category: 'unsupported' };
    expiryMs = Number(unixMs);
    if (expiryMs <= now) return { category: 'skipped' };
  }
  return { encrypted, cookie: { host, name, path, value, isSecure: !!secure, isHttpOnly: !!httpOnly,
    isSession: !persistent, expiry: expiryMs, sameSite: samesite === -1 || samesite === 3 ? 256 : samesite,
    schemeMap: scheme === 2 ? 2 : scheme === 1 ? 1 : 0 } };
}

async function deriveKey(crypt, password) {
  if (typeof password !== 'string' || !password || sizeOf(password) > 4096) fail('keychain-unavailable-or-denied');
  const pass = byteEncoder.encode(password);
  try {
    const material = await crypt.subtle.importKey('raw', pass, 'PBKDF2', false, ['deriveKey']);
    return await crypt.subtle.deriveKey({ name: 'PBKDF2', salt: byteEncoder.encode('saltysalt'),
      iterations: 1003, hash: 'SHA-1' }, material, { name: 'AES-CBC', length: 128 }, false, ['decrypt']);
  } finally { pass.fill(0); }
}

async function decryptCookie(crypt, key, encrypted, host, version) {
  let plain;
  try {
    plain = new Uint8Array(await crypt.subtle.decrypt({ name: 'AES-CBC', iv: new Uint8Array(16).fill(32) },
      key, encrypted.subarray(3)));
    let valueBytes = plain;
    if (version === 24) {
      if (plain.length < 32) fail('invalid-cookie');
      const expected = new Uint8Array(await crypt.subtle.digest('SHA-256', byteEncoder.encode(host)));
      let diff = 0;
      for (let i = 0; i < 32; i++) diff |= expected[i] ^ plain[i];
      expected.fill(0);
      if (diff) fail('invalid-cookie');
      valueBytes = plain.subarray(32);
    }
    const value = textDecoder.decode(valueBytes);
    if (/[\u0000-\u001f\u007f]/u.test(value)) fail('invalid-cookie');
    return value;
  } finally { plain?.fill(0); }
}

function sameCookie(expected, actual, id) {
  return actual?.host === expected.host && actual?.path === expected.path && actual?.name === expected.name &&
    actual?.value === expected.value && actual?.isSecure === expected.isSecure &&
    actual?.isHttpOnly === expected.isHttpOnly && actual?.isSession === expected.isSession &&
    actual?.expiry === expected.expiry && actual?.sameSite === expected.sameSite &&
    actual?.schemeMap === expected.schemeMap && actual?.isPartitioned === false &&
    actual?.originAttributes?.userContextId === id && actual?.originAttributes?.privateBrowsingId === 0;
}

/**
 * The injected adapter is a privileged test seam, not a public IPC API. It has
 * platform, crypto, randomUUID(), now(), checkAccess(), readRoot(),
 * readSqlite(directory,{maxRows,maxBytes,signal?}), getKeychainPassword(),
 * getIdentityIds(), getCookieCapacity(), createIdentity(name), removeIdentity(id), and cookies
 * {add(cookie,attrs), list(attrs), removeAll(attrs)}. getCookieCapacity and add
 * are synchronous; the latter returns true or a fixed validation reason.
 * Adapters must use only
 * synthetic data in tests. Native access and policy are independently checked
 * in Gecko; there are no native-path or native-Keychain overrides.
 */
export function createBrowserCookieImporter(options = {}) {
  const adapter = options.adapter === undefined ? geckoAdapter(options.browserWindow) : options.adapter;
  const profiles = new Map();
  let busy = false;

  function availability() {
    if (options.profileImportPolicy !== 'allow') return { supported: false, reason: 'policy-unverified' };
    if (options.privateBrowsingId !== 0) return { supported: false, reason: 'private-context-unverified' };
    if (adapter?.[NATIVE_INIT_FAILURE]) return { supported: false, reason: adapter[NATIVE_INIT_FAILURE] };
    if (!adapter || typeof adapter.platform !== 'string' || !adapter.platform) return { supported: false, reason: 'unavailable' };
    if (adapter.platform !== 'macosx') return { supported: false, reason: 'platform-unsupported' };
    if (!adapter.crypto?.subtle || typeof adapter.randomUUID !== 'function' || typeof adapter.now !== 'function' ||
        typeof adapter.checkAccess !== 'function' || typeof adapter.readRoot !== 'function' ||
        typeof adapter.readSqlite !== 'function' || typeof adapter.getKeychainPassword !== 'function' ||
        typeof adapter.getIdentityIds !== 'function' || typeof adapter.getCookieCapacity !== 'function' ||
        typeof adapter.createIdentity !== 'function' ||
        typeof adapter.removeIdentity !== 'function' || typeof adapter.cookies?.add !== 'function' ||
        typeof adapter.cookies?.list !== 'function' || typeof adapter.cookies?.removeAll !== 'function') {
      return { supported: false, reason: 'unavailable' };
    }
    try {
      const access = adapter.checkAccess();
      if (access !== true) return { supported: false, reason: ['platform-unsupported', 'policy-denied',
        'policy-unavailable', 'private-context-unverified', 'containers-disabled', 'permission-denied',
        'logging-enabled', 'logging-unverified', 'cookie-capacity-unverified'].includes(access) ? access : 'unavailable' };
    } catch { return { supported: false, reason: 'unavailable' }; }
    return { supported: true, scopeModes: ['preserve', 'standard-web'] };
  }

  async function listProfiles({ explicitUserRequest = false } = {}) {
    profiles.clear();
    const available = availability();
    if (!available.supported) return { ...available, profiles: [] };
    if (explicitUserRequest !== true) return { supported: false, profiles: [], reason: 'explicit-user-request-required' };
    if (busy) return { supported: false, profiles: [], reason: 'busy' };
    busy = true;
    try {
      const source = await adapter.readRoot();
      if (!availability().supported) return { supported: false, profiles: [], reason: 'access-changed' };
      if (!Array.isArray(source) || source.length > MAX_PROFILES) fail('resource-limit');
      const result = [];
      const seen = new Set();
      for (const item of source) {
        if (!item || typeof item.directory !== 'string' || !DIRECTORY.test(item.directory) || seen.has(item.directory)) continue;
        seen.add(item.directory);
        const id = adapter.randomUUID();
        if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || profiles.has(id)) {
          fail('unavailable');
        }
        const name = safeName(item.name), email = safeEmail(item.email);
        profiles.set(id, { directory: item.directory, name });
        result.push(email ? { id, name, email } : { id, name });
      }
      return { supported: true, profiles: result };
    } catch (error) {
      profiles.clear();
      return { supported: false, profiles: [], reason: safeReason(error) };
    } finally { busy = false; }
  }

  async function cleanup(id) {
    const attrs = { userContextId: id, privateBrowsingId: 0 };
    let wiped = false;
    for (let attempt = 0; attempt < 2 && !wiped; attempt++) {
      try {
        await adapter.cookies.removeAll(attrs);
        const remaining = await adapter.cookies.list(attrs);
        wiped = Array.isArray(remaining) && remaining.length === 0;
      } catch { /* Never include native errors or cookie details in receipts. */ }
    }
    // Keep the new identity visible if its cookie cleanup is unconfirmed, so
    // there is no invisible orphan of potentially live authentication data.
    if (!wiped) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { if (await adapter.removeIdentity(id) === true) return true; } catch { /* retry */ }
    }
    return false;
  }

  async function importProfile({ profileId, explicitUserConsent = false, scopeMode = 'preserve',
    explicitScopeCompatibilityConsent = false, signal } = {}) {
    const counts = counts0();
    const receipt = (status, reason, extra = {}) => ({ status, counts: { ...counts },
      ...(reason ? { reason } : {}), ...extra });
    const available = availability();
    if (!available.supported) return receipt('unsupported', available.reason);
    if (explicitUserConsent !== true) return receipt('failed', 'explicit-user-consent-required');
    if (!['preserve', 'standard-web'].includes(scopeMode)) return receipt('failed', 'scope-mode-unsupported');
    if (scopeMode === 'standard-web' && explicitScopeCompatibilityConsent !== true) {
      return receipt('failed', 'scope-compatibility-consent-required');
    }
    if (!validSignal(signal)) return receipt('failed', 'invalid-signal');
    if (signal?.aborted) return receipt('cancelled');
    const profile = typeof profileId === 'string' ? profiles.get(profileId) : null;
    if (!profile) return receipt('failed', 'profile-not-enumerated');
    if (busy) return receipt('failed', 'busy');
    busy = true;
    let ownedId = null, containerName = null, emptyBeforeWrites = false;
    const prepared = [];
    try {
      const data = await adapter.readSqlite(profile.directory, { maxRows: MAX_ROWS, maxBytes: MAX_BYTES,
        ...(signal ? { signal } : {}) });
      interrupted(signal);
      if (!availability().supported) fail('unavailable');
      if (!data || !Array.isArray(data.rows) || data.rows.length > MAX_ROWS ||
          (data.totalRows !== undefined && (!Number.isSafeInteger(data.totalRows) || data.totalRows < 0 || data.totalRows > MAX_ROWS))) {
        fail('resource-limit');
      }
      if (data.schemaSupported === false || ![23, 24].includes(data.version)) {
        counts.unsupported = data.totalRows ?? data.rows.length;
        return receipt('failed', 'unsupported-schema');
      }
      if (data.totalRows !== undefined && data.totalRows !== data.rows.length) fail('unavailable');
      let totalBytes = 0;
      for (const row of data.rows) {
        totalBytes += rowBytes(row);
        if (totalBytes > MAX_BYTES) fail('resource-limit');
      }
      const duplicates = new Map();
      for (const row of data.rows) {
        const key = rowIdentity(row);
        if (key !== null) {
          duplicates.set(key, (duplicates.get(key) || 0) + 1);
        }
      }
      const now = adapter.now();
      if (!Number.isSafeInteger(now) || now < 0) fail('unavailable');
      let key = null;
      for (const row of data.rows) {
        interrupted(signal);
        if (duplicates.get(rowIdentity(row)) > 1) { counts.unsupported++; continue; }
        const result = classify(row, now, scopeMode, data.scopeBindings);
        if (result.category) { counts[result.category]++; continue; }
        if (result.encrypted.length) {
          if (!key) {
            if (!availability().supported) fail('unavailable');
            let password;
            try { password = await adapter.getKeychainPassword(); }
            catch (error) {
              if (error?.code === 'permission-denied') fail('keychain-permission-denied');
              fail('keychain-unavailable-or-denied');
            }
            interrupted(signal);
            try { key = await deriveKey(adapter.crypto, password); }
            finally { password = null; }
          }
          try { result.cookie.value = await decryptCookie(adapter.crypto, key, result.encrypted, result.cookie.host, data.version); }
          catch { counts.failed++; continue; }
        }
        prepared.push(result.cookie);
      }
      interrupted(signal);
      if (!prepared.length) {
        if (counts.unsupported || counts.failed) return receipt('failed', 'no-importable-cookies');
        return receipt('empty');
      }
      if (!availability().supported) fail('unavailable');
      function requireCapacity(remaining) {
        const capacity = adapter.getCookieCapacity();
        if (!capacity || capacity.then || !Number.isSafeInteger(capacity.current) || capacity.current < 0 ||
            !Number.isSafeInteger(capacity.max) || capacity.max < 1 || capacity.max > 65535) {
          fail('cookie-capacity-unverified');
        }
        if (capacity.current + remaining > capacity.max) fail('cookie-capacity-exceeded');
      }
      requireCapacity(prepared.length);
      const existing = adapter.getIdentityIds();
      if (!Array.isArray(existing) || existing.some(id => !validId(id))) fail('unavailable');
      containerName = `Chrome - ${profile.name}`;
      interrupted(signal);
      if (!availability().supported) fail('unavailable');
      // Synchronous to avoid an ownership gap between create and receipt.
      const identity = adapter.createIdentity(containerName);
      if (!identity || identity.then || !validId(identity.userContextId) || existing.includes(identity.userContextId)) {
        fail('unavailable');
      }
      ownedId = identity.userContextId;
      const idsAfter = adapter.getIdentityIds();
      if (!Array.isArray(idsAfter) || !idsAfter.includes(ownedId)) fail('unavailable');
      const attrs = { userContextId: ownedId, privateBrowsingId: 0 };
      const initial = await adapter.cookies.list(attrs);
      // If any preexisting data was found, do not remove it or this container.
      if (!Array.isArray(initial) || initial.length) {
        const id = ownedId; ownedId = null;
        return receipt('failed', 'container-not-empty', { userContextId: id, containerName });
      }
      emptyBeforeWrites = true;
      for (let index = 0; index < prepared.length; index++) {
        const cookie = prepared[index];
        interrupted(signal);
        if (!availability().supported) fail('unavailable');
        // No await between the quota check and native add: the old cookies in
        // other contexts must not be evicted by a global quota-triggered purge.
        requireCapacity(prepared.length - index);
        const added = adapter.cookies.add(cookie, attrs);
        if (added === 'cookie-expiry-cap-exceeded') fail('cookie-expiry-cap-exceeded');
        if (added !== true) fail('cookie-validation-failed');
      }
      interrupted(signal);
      if (!availability().supported) fail('unavailable');
      const actual = await adapter.cookies.list(attrs);
      interrupted(signal);
      if (!availability().supported) fail('unavailable');
      if (!Array.isArray(actual) || actual.length !== prepared.length) fail('cookie-readback-mismatch');
      const byKey = new Map(actual.map(cookie => [JSON.stringify([cookie.host, cookie.name, cookie.path]), cookie]));
      if (byKey.size !== prepared.length || prepared.some(cookie =>
        !sameCookie(cookie, byKey.get(JSON.stringify([cookie.host, cookie.name, cookie.path])), ownedId))) fail('cookie-readback-mismatch');
      counts.imported = prepared.length;
      const status = counts.skipped || counts.unsupported || counts.failed ? 'partial' : 'imported';
      return receipt(status, undefined, { userContextId: ownedId, containerName });
    } catch (error) {
      const cancelled = signal?.aborted || error?.code === 'cancelled';
      if (ownedId !== null) {
        if (!emptyBeforeWrites) return receipt('failed', 'cleanup-incomplete', { userContextId: ownedId, containerName });
        const clean = await cleanup(ownedId);
        if (!clean) return receipt('failed', 'cleanup-incomplete', { userContextId: ownedId, containerName });
      }
      if (cancelled) return receipt('cancelled');
      counts.failed++;
      return receipt('failed', safeReason(error, 'import-failed'));
    } finally {
      for (const cookie of prepared) cookie.value = '';
      busy = false;
    }
  }

  return Object.freeze({ availability, listProfiles, importProfile });
}
