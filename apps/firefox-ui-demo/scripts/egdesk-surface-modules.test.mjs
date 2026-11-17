import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { readSurfaceSource, surfaceModuleFiles } from './egdesk-surface-source.mjs';

const overlay = new URL('../overlay/', import.meta.url);
const read = file => readFileSync(new URL(file, overlay), 'utf8').replace(/\r\n/g, '\n');
const core = read('JS/eg-desk-surface.uc.js');
const zones = [
  { key: 'ontology', file: 'EGDeskSurfaceOntology.mjs', factory: 'createOntologyZone', method: 'spawnOntologyMapCard' },
  { key: 'fileCard', file: 'EGDeskSurfaceFileCard.mjs', factory: 'createFileCardZone', method: 'spawnFileCard' },
  { key: 'terminal', file: 'EGDeskSurfaceTerminal.mjs', factory: 'createTerminalZone', method: 'spawnTerminalCard' },
];
const modulePath = zone => `resources/surface/${zone.file}`;
const sorted = values => [...values].sort();
const own = (object, name) => Object.hasOwn(object, name);
const environmentNames = [
  'window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'queueMicrotask',
  'Cc', 'Ci', 'Cu', 'ChromeUtils', 'Services', 'console', 'CustomEvent', 'KeyboardEvent',
  'MutationObserver', 'ResizeObserver', 'EventSource', 'WebSocket', 'XMLHttpRequest',
];

function forbidden(events, label) {
  return () => { events.push(label); throw new Error(`Early execution: ${label}`); };
}

function poisonValue(name, events) {
  return new Proxy(function () {}, {
    apply: forbidden(events, `deps.${name}()`),
    construct: forbidden(events, `new deps.${name}`),
    get: forbidden(events, `deps.${name} property read`),
    set: forbidden(events, `deps.${name} property write`),
  });
}

function poisonGlobals(target, events, allowed = {}) {
  for (const name of environmentNames) {
    Object.defineProperty(target, name, {
      configurable: true,
      get: own(allowed, name) ? () => allowed[name] : forbidden(events, name),
      set: forbidden(events, `${name} assignment`),
    });
  }
}

// This test file has its own Node process. Restore every descriptor, including
// Node's fetch/timers, before asserting or reporting any failure.
async function withoutEnvironment(action) {
  const saved = new Map(environmentNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const events = [];
  let result, failure;
  try {
    poisonGlobals(globalThis, events);
    result = await action();
    await Promise.resolve();
  } catch (error) { failure = error; }
  finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
  assert.deepEqual(events, [], 'import/factory touched a poisoned environment global, even if it caught the error');
  if (failure) throw failure;
  return result;
}

function namesAtCoreScope(script) {
  // R1 preserves two-space core declarations. This is a lexical approximation,
  // not an AST or a claim to resolve arbitrary JavaScript scopes.
  return new Set([...script.matchAll(/^  (?:(?:async )?function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)]
    .map(match => match[1]));
}

function dependencyList(text, expression, label) {
  const matches = [...text.matchAll(expression)];
  assert.equal(matches.length, 1, `${label}: exactly one dependency declaration`);
  const lines = matches[0][1].trim().split('\n').map(line => line.trim());
  for (const line of lines) assert.match(line, /^[A-Za-z_$][\w$]*,$/, `${label}: one shorthand name per line`);
  const names = lines.map(line => line.slice(0, -1));
  assert.deepEqual(names, sorted(new Set(names)), `${label}: unique, alphabetically ordered deps`);
  return names;
}

const installerDeps = script => dependencyList(script,
  /\bconst deps = Object\.freeze\(\{([\s\S]*?)\}\);/g, 'installer');
const factoryDeps = source => dependencyList(source,
  /\bconst\s*\{([\s\S]*?)\}\s*=\s*deps\s*;/g, 'factory');

function installerSource(script) {
  const start = script.indexOf('  const SURFACE_MODULE_BASE = ');
  const end = script.indexOf("\n  if (document.readyState === 'complete') boot();", start);
  assert.ok(start >= 0 && end > start, 'installer immediately precedes the existing boot gate');
  const source = script.slice(start, end);
  assert.equal((source.match(/\binstallSurfaceZones\(\);/g) || []).length, 1, 'one installation before boot');
  assert.equal((script.match(/\binstallSurfaceZones\(\);/g) || []).length, 1, 'no other installation site');
  assert.ok(script.indexOf('  function boot()') < start, 'all core declarations precede installation');
  return source;
}

function forwardsIn(script) {
  return [...script.matchAll(/^  const (\w+) = surfaceForward\((['"])(\w+)\2,\s*(['"])(\w+)\4\);$/gm)]
    .map(match => ({ declaration: match[0], binding: match[1], zone: match[3], method: match[5], index: match.index }));
}

let importId = 0;
async function importModules() {
  const result = new Map();
  for (const zone of zones) {
    assertNoStaticImports(read(modulePath(zone)));
    assertFactoryDefinitionOnly(read(modulePath(zone)), zone.factory);
    const url = new URL(modulePath(zone), overlay);
    url.searchParams.set('stage1-guard', String(++importId));
    const namespace = await withoutEnvironment(() => import(url.href));
    assert.deepEqual(Object.keys(namespace), [zone.factory], `${zone.file}: actual ESM export`);
    result.set(zone.file, namespace);
  }
  return result;
}

async function install(script, namespaces, { transformNamespace = (_, namespace) => namespace } = {}) {
  const dependencies = installerDeps(script);
  const coreNames = namesAtCoreScope(script);
  for (const name of dependencies) assert.ok(coreNames.has(name), `installer dependency ${name} is declared by core`);
  const forwards = forwardsIn(script);
  const expectedForwards = zones.map(zone => [zone.method, zone.key, zone.method]);
  expectedForwards.splice(2, 0, ['openBoardProjectFile', 'fileCard', 'openBoardProjectFile'],
    ['openBoardProjectFileAt', 'fileCard', 'openBoardProjectFileAt'], ['openVerifiedRunFile', 'fileCard', 'openVerifiedRunFile']);
  assert.deepEqual(forwards.map(({ binding, zone, method }) => [binding, zone, method]),
    expectedForwards, 'every stage1 forwarding declaration');
  const footer = installerSource(script);
  for (const forward of forwards) assert.ok(forward.index < script.indexOf(footer), 'forwarders are constructed before zones');
  const events = [], imports = [], received = [];
  const bindings = Object.fromEntries([...coreNames].map(name => [name, poisonValue(name, events)]));
  // A forwarded function is declared in the actual evaluated installer scope,
  // not the host's poisoned placeholder. Capture that exact lexical identity
  // before installation so a wrong or wrapped callback still fails the guard.
  const forwardReferences = {};
  bindings.captureForwardReferences = references => Object.assign(forwardReferences, references);
  const chromeUtils = Object.freeze({
    importESModule(url, options) {
      imports.push(url);
      assert.equal(url, `chrome://userchrome/content/surface/${zones[imports.length - 1]?.file}`, 'actual load order and URL');
      assert.deepEqual(Object.keys(options), ['global']);
      assert.equal(options.global, 'current', 'window-scoped import');
      const zone = zones.find(item => url.endsWith(`/${item.file}`));
      assert.ok(zone, 'only stage1 modules load');
      const namespace = transformNamespace(zone, namespaces.get(zone.file));
      return new Proxy(namespace, {
        get(target, name) {
          assert.equal(name, zone.factory, 'installer calls the actual factory export');
          assert.equal(typeof target[name], 'function');
          return deps => {
            assert.ok(Object.isFrozen(deps), 'installer freezes the shared dependency object');
            assert.deepEqual(Object.keys(deps), dependencies);
            for (const key of dependencies) assert.equal(deps[key], own(forwardReferences, key) ? forwardReferences[key] : bindings[key], `core reference identity: ${key}`);
            if (received.length) assert.equal(deps, received[0].deps, 'all zones share one deps object');
            const reads = [];
            const strictDeps = new Proxy(deps, {
              get(object, key) {
                assert.ok(own(object, key), `missing installer dependency: ${String(key)}`);
                reads.push(key);
                return object[key];
              },
              set() { assert.fail('factory must not mutate deps'); },
            });
            const api = target[name](strictDeps);
            const expected = factoryDeps(read(modulePath(zone)));
            assert.deepEqual(sorted(reads), expected, `${zone.file}: actual factory reads exactly its declared deps`);
            assert.deepEqual(Object.keys(api), zone.key === 'fileCard' ? [zone.method, 'openVerifiedRunFile', 'openBoardProjectFile', 'openBoardProjectFileAt', 'onWorkflowEvent'] : [zone.method], `${zone.file}: actual returned interface`);
            assert.equal(typeof api[zone.method], 'function');
            if (zone.key === 'fileCard') assert.equal(typeof api.onWorkflowEvent, 'function', 'File watcher receiver is callable');
            received.push({ zone, deps, api, reads });
            return api;
          };
        },
      });
    },
  });
  // Surface's production catch must not hide the underlying failing guard.
  // Module code still sees the separately poisoned Node console.
  const installerConsole = { error: (...args) => { throw args.at(-1); } };
  poisonGlobals(bindings, events, { ChromeUtils: chromeUtils, console: installerConsole });
  const result = await withoutEnvironment(() => runInNewContext(
    `${forwards.map(item => item.declaration).join('\n')}\ncaptureForwardReferences({ ${forwards.map(item => item.binding).join(', ')} });\n${footer}\n` +
    `;({ surfaceZones, surfaceForward, forwards: { ${forwards.map(item => item.binding).join(', ')} } });`,
    bindings, { timeout: 1000, filename: 'production-surface-installer.js' }));
  assert.deepEqual(events, [], 'installation defines zones without calling dependencies or touching window globals');
  assert.deepEqual(imports, surfaceModuleFiles(script).map(file => `chrome://userchrome/content/surface/${file.split('/').at(-1)}`));
  assert.deepEqual(received.map(item => item.zone.key), zones.map(zone => zone.key));
  assert.deepEqual(Object.keys(result.surfaceZones), zones.map(zone => zone.key));
  assert.equal(Object.getPrototypeOf(result.surfaceZones), null);
  return { ...result, received, bindings };
}

// Skip comments, strings and regex literals, but visit template expressions.
// These tokens support the bounded dependency guard, not a general JS parser.
function tokensOf(source) {
  const tokens = [];
  let i = 0;
  const push = (value, kind = 'code') => tokens.push({ value, kind });
  function quoted(quote) {
    const start = i++;
    while (i < source.length) {
      if (source[i] === '\\') { i += 2; continue; }
      if (source[i++] === quote) break;
    }
    push(source.slice(start, i), 'literal');
  }
  function template() {
    i++;
    while (i < source.length) {
      if (source[i] === '\\') { i += 2; continue; }
      if (source[i] === '`') { i++; return; }
      if (source[i] === '$' && source[i + 1] === '{') { i += 2; code(true); }
      else i++;
    }
  }
  function code(interpolation = false) {
    let braces = 0;
    while (i < source.length) {
      const ch = source[i], next = source[i + 1];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '/' && next === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
      if (ch === '/' && next === '*') { i = source.indexOf('*/', i + 2); assert.ok(i >= 0); i += 2; continue; }
      if (ch === "'" || ch === '"') { quoted(ch); continue; }
      if (ch === '`') { template(); continue; }
      const previous = tokens.at(-1)?.value;
      if (ch === '/' && (!previous || /^(?:[=(:,!;{[?]|=>|return|throw|case|\|\||&&)$/.test(previous))) {
        i++;
        let inClass = false;
        while (i < source.length) {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === '[') inClass = true;
          if (source[i] === ']') inClass = false;
          if (source[i++] === '/' && !inClass) break;
        }
        while (i < source.length && /[a-z]/i.test(source[i])) i++;
        push('/regexp/', 'literal');
        continue;
      }
      const identifier = source.slice(i).match(/^[A-Za-z_$][\w$]*/)?.[0];
      if (identifier) { push(identifier, 'identifier'); i += identifier.length; continue; }
      if (ch === '}' && interpolation && braces === 0) { i++; return; }
      if (ch === '{') braces++;
      if (ch === '}') braces--;
      const pair = source.slice(i, i + 2);
      if (['=>', '?.', '++', '--', '&&', '||'].includes(pair)) { push(pair); i += 2; }
      else { push(ch); i++; }
    }
  }
  code();
  return tokens;
}

function assertNoStaticImports(source) {
  const tokens = tokensOf(source);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value === 'import' && !['(', '.'].includes(tokens[i + 1]?.value)) {
      assert.fail('static import is forbidden in window surface modules');
    }
    if (tokens[i].value === 'from' && tokens[i + 1]?.kind === 'literal') {
      assert.fail('static re-export/import is forbidden in window surface modules');
    }
  }
}

function assertFactoryDefinitionOnly(source, factory) {
  const tokens = tokensOf(source).map(token => token.value);
  assert.deepEqual(tokens.slice(0, 7), ['export', 'function', factory, '(', 'deps', ')', '{'],
    'module scope contains only the exported factory definition');
  let depth = 1, end = 7;
  for (; end < tokens.length && depth; end++) {
    if (tokens[end] === '{') depth++;
    if (tokens[end] === '}') depth--;
  }
  assert.equal(depth, 0, 'factory body has a closing boundary');
  assert.equal(end, tokens.length, 'no execution or declarations outside the factory');
}

function undeclaredCoreReferences(source, coreNames) {
  const tokens = tokensOf(source);
  const code = tokens.map(token => token.kind === 'literal' ? '""' : token.value).join(' ');
  const locals = new Set(factoryDeps(source));
  // Nested locals/parameters are recognized file-wide. This approximates the
  // module/core boundary; it does not replace full shadowing/scope analysis.
  for (const match of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) locals.add(match[1]);
  for (const match of code.matchAll(/\b(?:const|let|var)\s+[{\[]([^=;]+)[}\]]\s*=/g)) {
    for (const name of match[1].match(/[A-Za-z_$][\w$]*/g) || []) locals.add(name);
  }
  for (const match of code.matchAll(/\bfunction(?:\s+\w+)?\s*\(([^)]*)\)|\(([^()]*)\)\s*=>|\b([A-Za-z_$][\w$]*)\s*=>/g)) {
    for (const name of (match[1] ?? match[2] ?? match[3]).match(/[A-Za-z_$][\w$]*/g) || []) locals.add(name);
  }
  return sorted(new Set(tokens.filter((token, i) => token.kind === 'identifier' &&
    coreNames.has(token.value) && !locals.has(token.value) &&
    !['.', '?.'].includes(tokens[i - 1]?.value) && tokens[i + 1]?.value !== ':').map(token => token.value)));
}

// Captured from the pre-split boot assignment. No git/HEAD is read at runtime.
const apiKeys = {
  root: 'state semantic codexBridge cardRuntime browserRuntime browserAgent browserAgentTools sourceRefs railSearch minimap agenda boards shapes surface deskSession',
  cardRuntime: 'focusCard closeCard openBrowserCard openUrl openSettingsCard openFileCard openOntologyMapCard openTerminalCard toggleFullscreen syncFullscreenLayout',
  browserRuntime: 'resolveCard state navigate back forward reload stop home duplicate copyUrl agentSnapshot agentAct agentHistory agentNotifications agentClearHistory agentDebug',
  browserAgent: 'snapshot act history notifications clearHistory debug',
  browserAgentTools: 'selectedSources dispatch attachTransport authorizePhysicalAction fixtureActionDiagnostic fixtureObserveDiagnostic rootSseReady',
  sourceRefs: 'keyFor browser findCard listOpenCards',
  railSearch: 'results setQuery open close execute',
  minimap: 'toggle close refresh snapshot',
  agenda: 'serialize save restore restoreSnapshot clearSavedState close clearView closeGuard list create switchTo rename duplicate delete markOpened markClosed toggleSwitcher readStore markDirty storagePref',
  boards: 'open close save openHistory revertVersion projections viewport',
  shapes: 'serialize restore',
  surface: 'enterDesk snapshot lifecyclePref',
  deskSession: 'serialize restore persist storagePref retryRecovery continueRecovery recoveryRecords storeStatus openHistory restoreGeneration mergeGeneration',
};

function readBootApi(script, forwards = {}) {
  const assignments = [...script.matchAll(/      window\.__egdesk = \{[\s\S]*?\n      \};/g)];
  assert.equal(assignments.length, 1, 'one existing window.__egdesk boot assignment');
  const events = [];
  const bindings = Object.fromEntries([...namesAtCoreScope(script)].map(name => [name, poisonValue(name, events)]));
  Object.assign(bindings, forwards, { state: { codexBridge: {} }, semantic: {}, window: {} });
  const api = runInNewContext(`${assignments[0][0]}\nwindow.__egdesk;`, bindings, { timeout: 1000 });
  assert.deepEqual(events, [], 'reading the API contract must not execute its methods');
  for (const [namespace, expected] of Object.entries(apiKeys)) {
    assert.deepEqual(Object.keys(namespace === 'root' ? api : api[namespace]), expected.split(' '), `window.__egdesk.${namespace} keys`);
  }
  return api;
}

test('stage1 source loader includes exact current module sources, once each and in actual load order', () => {
  const files = surfaceModuleFiles(core);
  assert.deepEqual(files, zones.map(modulePath));
  // Window zones are the three factories below; any other .mjs here is a pure
  // rule module the core imports directly (no factory, no deps, no load()).
  const present = readdirSync(new URL('resources/surface/', overlay)).filter(file => file.endsWith('.mjs'));
  assert.deepEqual(sorted(present.filter(file => zones.some(zone => zone.file === file))),
    sorted(zones.map(zone => zone.file)), 'stage1 has exactly three production window modules');
  for (const file of present.filter(name => !zones.some(zone => zone.file === name))) {
    const source = read(`resources/surface/${file}`);
    assert.doesNotMatch(source, /^\s*import\s/m, `${file}: a pure module imports nothing`);
    assert.doesNotMatch(source, /\bconst\s*\{[^}]*\}\s*=\s*deps\b/, `${file}: not a zone factory`);
    assert.doesNotMatch(core, new RegExp(`load\\(\\s*['"]${file.replace('.', '\\.')}`), `${file}: not loaded as a zone`);
  }
  assert.equal(readSurfaceSource(), [core, ...files.map(read)].join('\n'));
  for (const zone of zones) {
    assert.equal((readSurfaceSource().match(new RegExp(`  function ${zone.method}\\(`, 'g')) || []).length, 1);
    assert.doesNotMatch(core, new RegExp(`  function ${zone.method}\\(`), 'no old renderer copy remains in core');
  }
});

test('loader keeps negative assertions effective after a move, normalizes CRLF, and fails on a missing module', () => {
  const directory = mkdtempSync(join(tmpdir(), 'egdesk-surface-source-'));
  const root = pathToFileURL(`${directory}/`);
  const write = (file, source) => writeFileSync(new URL(file, root), source);
  try {
    mkdirSync(new URL('JS/', root), { recursive: true });
    mkdirSync(new URL('resources/surface/', root), { recursive: true });
    // Loader-only fixtures, never executed as a substitute renderer.
    write('JS/eg-desk-surface.uc.js', zones.map(zone => `load('${zone.file}');\r\n`).join(''));
    for (const zone of zones) write(modulePath(zone), `// ${zone.key}\r\n`);
    assert.doesNotMatch(readSurfaceSource(root), /\r/);
    for (const zone of zones) {
      write(modulePath(zone), '// FORBIDDEN_SURFACE_BEHAVIOR\r\n');
      assert.throws(() => assert.doesNotMatch(readSurfaceSource(root), /FORBIDDEN_SURFACE_BEHAVIOR/),
        { code: 'ERR_ASSERTION' }, `${zone.key}: negative assertions see moved source`);
      write(modulePath(zone), `// ${zone.key}\r\n`);
    }
    rmSync(new URL(modulePath(zones[1]), root));
    assert.throws(() => readSurfaceSource(root), { code: 'ENOENT' }, 'never silently omit an unreadable loaded module');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('real ESM factories and actual installer use one frozen dependency object without early execution', async () => {
  const installed = await install(core, await importModules());
  const required = sorted(new Set(zones.flatMap(zone => factoryDeps(read(modulePath(zone))))));
  assert.deepEqual(installerDeps(core), required, 'installer supplies exactly the actual factory dependency union');
  assert.equal(required.length, 30, 'stage1 plus explicit project target, Terminal Card callbacks and the CODE-06 result card (RunResult, openBoardProjectFileAt); the Terminal window now takes its frame, drag, resize and close from the shared Desk Window shell');
  assert.equal(installed.received[1].deps.getProjectTarget, installed.bindings.getProjectTarget);
  assert.equal(installed.received[1].deps.spawnTerminalCard, installed.forwards.spawnTerminalCard);
  const api = readBootApi(core, installed.forwards);
  for (const [key, method] of [
    ['openOntologyMapCard', 'spawnOntologyMapCard'], ['openFileCard', 'spawnFileCard'], ['openTerminalCard', 'spawnTerminalCard'],
  ]) assert.equal(api.cardRuntime[key], installed.forwards[method], `boot API retains ${key}'s forwarded function`);
});

test('every actual surfaceForward resolves late and preserves arguments, results, receiver and errors', async () => {
  const installed = await install(core, await importModules());
  for (const zone of zones) {
    assert.equal(typeof installed.surfaceZones[zone.key][zone.method], 'function', 'factory supplied the actual renderer');
    // Enter the real renderer and stop at its first injected dependency. No DOM
    // fixture or copied renderer is needed to prove the forwarding connection.
    const firstDependency = { ontology: 'singletonSourceRef', fileCard: 'resolveCanvasCardPlacement', terminal: 'allocCardSeq' }[zone.key];
    await assert.rejects(() => withoutEnvironment(() => installed.forwards[zone.method]({ openMode: 'new' })),
      new RegExp('Early execution: deps\\.' + firstDependency + '\\(\\)'));
    const args = [{ zone: zone.key }, 7, undefined], returned = {}, calls = [];
    const replacement = {
      [zone.method](...received) { calls.push({ receiver: this, received }); return returned; },
    };
    installed.surfaceZones[zone.key] = replacement;
    assert.equal(installed.forwards[zone.method](...args), returned);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].receiver, replacement);
    assert.deepEqual(calls[0].received, args);
    const error = new Error(`forwarded-${zone.key}`);
    replacement[zone.method] = () => { throw error; };
    assert.throws(() => installed.forwards[zone.method](), caught => caught === error);
  }
});

test('the real SSE receiver reaches the installed FileCard zone only for the current workflow frame', async () => {
  const installed = await install(core, await importModules());
  const fileCard = installed.surfaceZones.fileCard, queries = [], forwarded = [], other = [];
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll(selector) { queries.push(selector); return []; } } });
  try {
    const start = core.indexOf('      const fileEventStreamCurrent = () =>');
    const end = core.indexOf("      source.addEventListener('codex', receive);", start);
    assert.ok(start > 0 && end > start, 'actual File workflow receiver boundary');
    const connection = { readyState: 1 }, epoch = { live: true };
    const zones = { fileCard: { onWorkflowEvent(frame, current) {
      forwarded.push({ frame, current }); return fileCard.onWorkflowEvent(frame, current);
    } } };
    const receiver = runInNewContext(`
      let source = connection, streamReady = true;
      const connectionSource = connection, streamEpoch = 1;
      const epochScope = { valid: value => value === streamEpoch && epoch.live };
      const window = { EventSource: { OPEN: 1 } }, surfaceZones = zones, TAG = 'test';
      const handleEvent = event => other.push(event), console = { warn() {} };
      ${core.slice(start, end)}
      ({ receive, setSource: value => { source = value; } });
    `, { connection, epoch, zones, other });
    const frame = { type: 'workflow.event', v: 1, event: { topic: 'file.changed', source: 'file',
      payload: { rootId: 'root', relativePath: 'file.txt', change: 'change' } } };
    receiver.receive({ data: JSON.stringify(frame) });
    assert.equal(forwarded.length, 1); assert.equal(forwarded[0].current(), true);
    assert.deepEqual(queries, ['.egd-file-card'], 'the actual installed zone receives the current frame');
    connection.readyState = 0;
    assert.equal(forwarded[0].current(), false, 'the same delayed guard sees a closed stream');
    receiver.receive({ data: JSON.stringify(frame) }); assert.equal(queries.length, 1);
    connection.readyState = 1; receiver.setSource({ readyState: 1 });
    receiver.receive({ data: JSON.stringify(frame) }); assert.equal(forwarded.length, 2, 'old source cannot forward');
    receiver.setSource(connection); epoch.live = false;
    receiver.receive({ data: JSON.stringify(frame) }); assert.equal(forwarded.length, 2, 'old epoch cannot forward');
    epoch.live = true; receiver.receive({ data: JSON.stringify({ type: 'task.native' }) });
    assert.equal(other.length, 1); assert.equal(other[0].type, 'task.native');
  } finally {
    if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument);
    else delete globalThis.document;
  }
});

test('installer guards reject missing/wrong deps, wrong imports, factory mismatches and absent forwarded exports', async () => {
  const namespaces = await importModules();
  const dependencyBlock = core.match(/\bconst deps = Object\.freeze\(\{([\s\S]*?)\}\);/)[0];
  const withoutEl = core.replace(dependencyBlock, dependencyBlock.replace(/^[ \t]+el,\n/m, ''));
  assert.notEqual(withoutEl, core);
  await assert.rejects(() => install(withoutEl, namespaces), /missing installer dependency: el/);
  const wrongReference = core.replace('  function installSurfaceZones() {\n',
    '  function installSurfaceZones() {\n    const el = svgEl;\n');
  assert.notEqual(wrongReference, core);
  await assert.rejects(() => install(wrongReference, namespaces), /core reference identity: el/);
  for (const callback of ['getProjectTarget', 'spawnTerminalCard']) {
    const wrongCallback = core.replace('  function installSurfaceZones() {\n',
      `  function installSurfaceZones() {\n    const ${callback} = el;\n`);
    assert.notEqual(wrongCallback, core);
    await assert.rejects(() => install(wrongCallback, namespaces), new RegExp(`core reference identity: ${callback}`));
  }
  const wrongGlobal = core.replace("{ global: 'current' }", "{ global: 'shared' }");
  assert.notEqual(wrongGlobal, core);
  await assert.rejects(() => install(wrongGlobal, namespaces), /window-scoped import/);
  const wrongFile = core.replace("load('EGDeskSurfaceTerminal.mjs')", "load('EGDeskSurfaceMissing.mjs')");
  assert.notEqual(wrongFile, core);
  await assert.rejects(() => install(wrongFile, namespaces), /actual load order and URL/);
  const wrongFactory = core.replace('.createTerminalZone(deps)', '.createFileCardZone(deps)');
  assert.notEqual(wrongFactory, core);
  await assert.rejects(() => install(wrongFactory, namespaces), /actual factory export/);
  await assert.rejects(() => install(core, namespaces, {
    transformNamespace: (zone, namespace) => zone.key === 'fileCard'
      ? { [zone.factory]: deps => { namespace[zone.factory](deps); return {}; } } : namespace,
  }), /actual returned interface/);
});

test('poison checks reject early import/factory execution even when production catches the error', async () => {
  const zone = zones[0], source = read(modulePath(zone));
  const importSource = async text => import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);
  await assert.rejects(() => withoutEnvironment(() => importSource(
    `try { void document; } catch {}\n${source}`)), /poisoned environment global/);
  const mutated = source.replace(`export function ${zone.factory}(deps) {`,
    `export function ${zone.factory}(deps) {\n  try { void window; } catch {}`);
  assert.notEqual(mutated, source);
  const namespace = await withoutEnvironment(() => importSource(mutated));
  const namespaces = await importModules();
  namespaces.set(zone.file, namespace);
  await assert.rejects(() => install(core, namespaces), /poisoned environment global/);
  const eagerDependency = source.replace('  } = deps;\n', '  } = deps;\n  try { el(); } catch {}\n');
  assert.notEqual(eagerDependency, source);
  const eagerNamespace = await withoutEnvironment(() => importSource(eagerDependency));
  namespaces.set(zone.file, eagerNamespace);
  await assert.rejects(() => install(core, namespaces), /without calling dependencies/);
});

test('module scope contains only a factory definition, with controls for extra top-level work', () => {
  for (const zone of zones) {
    const source = read(modulePath(zone));
    assertFactoryDefinitionOnly(source, zone.factory);
    assert.throws(() => assertFactoryDefinitionOnly('const early = 1;\n' + source, zone.factory), /module scope/);
    assert.throws(() => assertFactoryDefinitionOnly(source + '\nvoid 0;', zone.factory), /outside the factory/);
  }
});

test('window modules reject static imports and re-exports, with mutation controls', () => {
  for (const zone of zones) {
    const source = read(modulePath(zone));
    assertNoStaticImports(source);
    for (const statement of [
      "import * as Shared from '../EGDeskChatState.sys.mjs';",
      "import '../EGDeskChatState.sys.mjs';",
      "export { x } from '../EGDeskChatState.sys.mjs';",
      "import\n{ x }\nfrom '../EGDeskChatState.sys.mjs';",
    ]) assert.throws(() => assertNoStaticImports(`${statement}\n${source}`), /static/);
    assert.doesNotThrow(() => assertNoStaticImports(`// import X from 'x.sys.mjs';\n${source}`));
  }
});

test('module/core name boundary catches missing deps and undeclared reads, including template expressions', () => {
  const names = namesAtCoreScope(core);
  for (const name of ['state', 'ChatState', 'cardSeq', 'cardZ', 'boot', 'browserToolAuthorityEpoch']) assert.ok(names.has(name));
  for (const zone of zones) {
    const source = read(modulePath(zone));
    assert.deepEqual(undeclaredCoreReferences(source, names), [], `${zone.file}: all core references are explicit deps`);
    const withoutEl = source.replace(/^    el,\n/m, '');
    assert.notEqual(withoutEl, source);
    assert.ok(undeclaredCoreReferences(withoutEl, names).includes('el'), 'removing a real dependency must fail');
    for (const expression of ['++cardSeq;', 'cardZ += 1;', 'ChatState.createState();', 'boot();',
      'browserToolAuthorityEpoch++;', '`${ChatState.createState()}`;']) {
      assert.notDeepEqual(undeclaredCoreReferences(`${source}\n${expression}`, names), [], expression);
    }
    assert.deepEqual(undeclaredCoreReferences(
      `${source}\n// ChatState cardSeq\nconst harmless = "ChatState cardZ"; other.ChatState; ({ cardSeq: 1 });`, names), [],
    'comments, literal text, property accesses and property names are not free core references');
  }
});

test('window.__egdesk preserves every pre-split public key and detects removal or rename', () => {
  readBootApi(core);
  for (const [before, after] of [
    ['        semantic,\n', ''],
    ['          openFileCard: spawnFileCard,', '          renamedFileCard: spawnFileCard,'],
    ['          openTerminalCard: spawnTerminalCard,\n', ''],
    ['          fixtureObserveDiagnostic: browserToolFixtureObserveDiagnostic,\n', ''],
  ]) {
    const mutated = core.replace(before, after);
    assert.notEqual(mutated, core);
    assert.throws(() => readBootApi(mutated), /window\.__egdesk\..*keys/);
  }
});

test('shared sequence and z-order helpers retain the live core counters', () => {
  const declarations = [...core.matchAll(/^  function (?:allocCardSeq|raiseCardZ)\(\) \{[^}]+\}/gm)].map(match => match[0]);
  assert.equal(declarations.length, 2);
  const actual = runInNewContext(`let cardSeq = 40, cardZ = 100;\n${declarations.join('\n')}\n` +
    'const before = [allocCardSeq(), allocCardSeq(), raiseCardZ()]; cardSeq = 80; cardZ = 200;\n' +
    '({ before, after: [allocCardSeq(), raiseCardZ()], cardSeq, cardZ });');
  assert.deepEqual(Array.from(actual.before), [41, 42, 101]);
  assert.deepEqual(Array.from(actual.after), [81, 201]);
  assert.equal(actual.cardSeq, 81);
  assert.equal(actual.cardZ, 201);
});

test('actual Terminal Card background options keep Canvas representation without activation, reveal or ready focus', async () => {
  const { createTerminalZone } = await import(new URL('resources/surface/EGDeskSurfaceTerminal.mjs', overlay));
  for (const options of [{}, { activate: false, reveal: false }, { activate: false }, { reveal: false }]) {
    const events = [], messages = new Map();
    const state = { activeEntityId: 'previous-active-card' };
    const node = (tag, props = {}, ...children) => {
      const value = { tag, ...props, className: props.class || '', style: props.style || {}, dataset: props.data || {}, children: [], listeners: new Map(),
        appendChild(child) { this.children.push(child); child.parent = this; return child; },
        insertBefore(child, before) { const at = this.children.indexOf(before); this.children.splice(at < 0 ? this.children.length : at, 0, child); child.parent = this; return child; },
        addEventListener(type, callback) { const list = this.listeners.get(type) || []; list.push(callback); this.listeners.set(type, list); },
        removeEventListener() {},
        querySelector(selector) { return this.children.find(child => child.className.split(' ').includes(selector.slice(1)))
          || this.children.map(child => child.querySelector?.(selector)).find(Boolean) || null; },
        focus() { events.push('frame-focus'); },
      };
      for (const child of children) if (child && typeof child === 'object') value.appendChild(child);
      if (tag === 'iframe') {
        value.isConnected = true; value.contentDocument = { documentURI: props.src };
        value.contentWindow = { terminalAPI: { hostEventKey: 'document-key', focus: () => events.push('terminal-focus') } };
      }
      return value;
    };
    const host = node('main');
    const deps = Object.fromEntries(factoryDeps(read('resources/surface/EGDeskSurfaceTerminal.mjs')).map(name => [name, () => {}]));
    // The shared Desk Window shell, reduced to what a kind adapter receives:
    // it owns the Canvas mount, the saved-record mark and activation.
    const shellCalls = [];
    const fakeShell = options => {
      shellCalls.push(options);
      const root = node('div', { id: options.id, class: `egd-canvas-card egd-desk-window ${options.className}`, style: options.style });
      const slots = { topbar: node('div', { class: 'egd-card-topbar' }), identity: node('div', { class: 'egd-desk-window-identity' }),
        actions: node('div', { class: 'egd-desk-window-actions' }), content: node('div', { class: `egd-card-body ${options.bodyClassName}` }) };
      slots.header = node('div', { class: `egd-card-header ${options.headerClassName}` }, slots.topbar);
      slots.topbar.appendChild(slots.identity); slots.topbar.appendChild(slots.actions);
      root.appendChild(slots.header); root.appendChild(slots.content);
      host.appendChild(root);
      deps.markAgendaDirty(options.createDirtyReason, root);
      if (options.activate !== false) deps.setActiveEntity(root);
      return { root, slots, requestClose: () => events.push('shell-close'), registerCleanup: dispose => { root._cleanup = dispose; } };
    };
    Object.assign(deps, { TAG: 'unit', allocCardSeq: () => 1, el: node, raiseCardZ: () => 2, spawnDeskWindowShell: fakeShell,
      makeSourceRef: (kind, details) => ({ kind, ...details }), resolveCanvasCardPlacement: () => ({ x: 1, y: 2, width: 400, height: 300 }),
      setActiveEntity: card => { events.push('activate'); state.activeEntityId = card.id; },
      revealPlacedCanvasCard: () => events.push('reveal'),
      markAgendaDirty: () => events.push('persist-card'), boardCloseRequests: new Set(), state });
    const globals = { document: { getElementById: () => host, addEventListener() {}, removeEventListener() {} },
      window: { addEventListener: (type, callback) => messages.set(type, callback), removeEventListener() {} }, console: { warn() {} } };
    const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    try {
      for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
      const card = createTerminalZone(deps).spawnTerminalCard(options);
      assert.equal(host.children.includes(card), true, 'background execution remains a real Canvas Card');
      assert.equal(shellCalls.length, 1, 'one shared Desk Window per Terminal');
      assert.equal(shellCalls[0].kind, 'terminal');
      assert.equal(shellCalls[0].activate, options.activate !== false, 'the shell, not the adapter, activates');
      assert.deepEqual([shellCalls[0].createDirtyReason, shellCalls[0].moveDirtyReason, shellCalls[0].resizeDirtyReason],
        ['create-terminal-card', 'move-terminal-card', 'resize-terminal-card'], 'saved-record reasons stay the Terminal ones');
      assert.deepEqual(shellCalls[0].sourceRef, { kind: 'terminal-session', id: card.id, scope: 'local-pty' });
      assert.equal(events.filter(event => event === 'persist-card').length, 1);
      assert.equal(events.includes('activate'), options.activate !== false);
      assert.equal(state.activeEntityId, options.activate !== false ? card.id : 'previous-active-card');
      assert.equal(events.includes('reveal'), options.reveal !== false);
      assert.equal(new URL(card._termBrowser.src).searchParams.get('autofocus'), options.activate === false ? '0' : null);
      const deliver = event => messages.get('message')({ origin: 'chrome://userchrome', ...event, data: { hostEventKey: 'document-key', ...event.data } });
      deliver({ source: {}, data: { type: 'terminal-ready' } });
      assert.equal(events.includes('frame-focus'), false, 'foreign frame cannot focus this Card');
      deliver({ source: card._termBrowser.contentWindow, data: { type: 'terminal-ready', shellLabel: 'zsh' } });
      assert.equal(events.includes('frame-focus'), options.activate !== false);
      assert.equal(events.includes('terminal-focus'), options.activate !== false);
      const focusCount = events.filter(event => event.endsWith('-focus')).length;
      state.activeEntityId = 'different-card';
      deliver({ source: card._termBrowser.contentWindow, data: { type: 'terminal-ready' } });
      assert.equal(events.filter(event => event.endsWith('-focus')).length, focusCount,
        'late ready cannot steal focus from another active Card');
      if (options.activate === false) {
        state.activeEntityId = card.id;
        deliver({ source: card._termBrowser.contentWindow, data: { type: 'terminal-ready' } });
        assert.equal(events.filter(event => event.endsWith('-focus')).length, 0,
          'background creation never requests ready focus, even if selected later');
      }
    } finally {
      for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    }
  }
});
