import { createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const SCHEMAS = [
  'v2/ThreadStartParams.json', 'v2/ThreadStartResponse.json',
  'v2/ThreadResumeParams.json', 'v2/ThreadResumeResponse.json',
  'v2/TurnStartParams.json', 'v2/TurnStartResponse.json',
  'v2/ConfigReadParams.json', 'v2/ConfigReadResponse.json',
  'v2/ModelListResponse.json', 'v2/ListMcpServerStatusParams.json', 'v2/ListMcpServerStatusResponse.json',
  'DynamicToolCallParams.json', 'DynamicToolCallResponse.json',
]
const has = (object, ...keys) => keys.every(key => object && Object.hasOwn(object, key))
const requires = (schema, ...keys) => keys.every(key => schema?.required?.includes(key))
const readOnly = schema => schema?.definitions?.SandboxPolicy?.oneOf?.find(item => item.title === 'ReadOnlySandboxPolicy')

function addFileFingerprint(hash, filename) {
  const stat = lstatSync(filename)
  if (!stat.isFile() || stat.size > 500 * 1024 * 1024) throw new Error('Selected Codex runtime is not a bounded regular file')
  const buffer = Buffer.allocUnsafe(1024 * 1024), fd = openSync(filename, 'r')
  hash.update(`${filename}\0${stat.size}\0`)
  try { let count; while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count)) }
  finally { closeSync(fd) }
}

function bundledNativePath(executable) {
  if (path.basename(executable) !== 'codex.js' || !executable.includes(`${path.sep}@openai${path.sep}codex${path.sep}bin${path.sep}`)) return null
  const targets = {
    'darwin:arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin'],
    'darwin:x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin'],
    'linux:arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl'],
    'linux:x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl'],
    'win32:arm64': ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc'],
    'win32:x64': ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc'],
  }
  const target = targets[`${process.platform}:${process.arch}`]
  if (!target) throw new Error('Selected Codex wrapper target is unknown')
  const resolve = createRequire(executable).resolve
  let vendorRoot
  try { vendorRoot = path.join(path.dirname(resolve(`${target[0]}/package.json`)), 'vendor') }
  catch { vendorRoot = path.join(path.dirname(executable), '..', 'vendor') }
  return path.join(vendorRoot, target[1], 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
}

// The ChatGPT desktop app's own CLI launcher (c25; Main's check-6 on the person's real install, official 0.171.0-alpha.13): Contents/Resources/codex-cli/bin/codex is a
// 328-byte /bin/sh script that follows its own symlinks and execs ../CodexCLI.app/Contents/MacOS/codex. Until now every "#!" launcher was refused, which made the
// binary's schema capabilities (thread/delete, turn/steer) unreadable on exactly the install the person has. It is recognised ONLY when every line of the script is
// one of the lines of that launcher (any other script stays "Unrecognized Codex launcher"); the native binary it execs is then fingerprinted together with the launcher,
// so a replaced binary changes the fingerprint.
const CHATGPT_LAUNCHER_LINES = Object.freeze(new Set([
  '#!/bin/sh', 'set -eu', 'entry="$0"', 'while [ -L "$entry" ]; do', 'parent=$(CDPATH= cd -P -- "$(dirname -- "$entry")" && pwd)', 'entry=$(readlink "$entry")',
  'case "$entry" in /*) ;; *) entry="$parent/$entry" ;; esac', 'done', 'bin_dir=$(CDPATH= cd -P -- "$(dirname -- "$entry")" && pwd)',
  'exec "$bin_dir/../CodexCLI.app/Contents/MacOS/codex" "$@"',
]))
function chatgptAppNativePath(executable) {
  let text = ''
  try {
    const fd = openSync(executable, 'r')
    try { const buffer = Buffer.alloc(4096), count = readSync(fd, buffer, 0, buffer.length, 0); if (count >= buffer.length) return null; text = buffer.subarray(0, count).toString('utf8') } finally { closeSync(fd) }
  } catch { return null }
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  if (lines[0] !== '#!/bin/sh' || lines.filter(line => line.startsWith('exec ')).length !== 1 || !lines.every(line => CHATGPT_LAUNCHER_LINES.has(line))) return null
  // the launcher's own logic: follow the symlinks of $0 to the last entry; bin_dir is that entry's physical directory
  return path.join(path.dirname(realpathSync(executable)), '..', 'CodexCLI.app', 'Contents', 'MacOS', 'codex')
}

export function fingerprintNativeExecutable(executable) {
  const hash = createHash('sha256')
  const native = bundledNativePath(executable) ?? chatgptAppNativePath(executable)
  const firstBytes = Buffer.alloc(2), fd = openSync(executable, 'r')
  try { readSync(fd, firstBytes, 0, 2, 0) } finally { closeSync(fd) }
  if (firstBytes.toString() === '#!' && !native) throw new Error('Unrecognized Codex launcher cannot be fingerprinted')
  addFileFingerprint(hash, executable)
  if (native) addFileFingerprint(hash, native)
  return hash.digest('hex')
}

// Optional, independent of ordinary context and QA. A stable schema which
// omits experimental additionalContext is NOT a weaker peer delivery path.
export function verifyBoardPeerSchema(params, response) {
  if (params?.title !== 'TurnSteerParams' || response?.title !== 'TurnSteerResponse') return false
  const resolve = s => {
    const name = s?.$ref?.match(/^#\/definitions\/([A-Za-z0-9_]+)$/)?.[1]
    return name ? params.definitions?.[name] : s
  }
  const shape = s => resolve(s?.allOf?.length === 1 ? s.allOf[0] : s)
  const hasType = (s, type) => s?.type === type || Array.isArray(s?.type) && s.type.includes(type)
  const p = params.properties || {}, map = p.additionalContext?.anyOf?.find(x => hasType(x, 'object')) || p.additionalContext
  const entry = shape(map?.additionalProperties), kind = shape(entry?.properties?.kind)
  const text = shape(p.input?.items)?.oneOf?.find(x => x.properties?.type?.enum?.length === 1 && x.properties.type.enum[0] === 'text')
  return Boolean(requires(params, 'threadId', 'input', 'expectedTurnId') && params.required.every(k => ['threadId','input','expectedTurnId','additionalContext','clientUserMessageId'].includes(k))
    && p.threadId?.type === 'string' && p.expectedTurnId?.type === 'string' && hasType(p.clientUserMessageId, 'string') && p.input?.type === 'array'
    && requires(text, 'type', 'text') && text.properties?.text?.type === 'string' && text.properties?.text_elements?.type === 'array'
    && text.required.every(k => ['type','text','text_elements'].includes(k)) && hasType(map, 'object') && requires(entry, 'kind', 'value')
    && entry.required.every(k => ['kind','value'].includes(k)) && entry.properties?.value?.type === 'string' && kind?.type === 'string' && kind?.enum?.includes('untrusted')
    && requires(response, 'turnId') && response.properties?.turnId?.type === 'string')
}
function optionalBoardPeerFingerprint(directory) {
  try {
    const digest = createHash('sha256')
    const schemas = ['v2/TurnSteerParams.json', 'v2/TurnSteerResponse.json'].map(name => {
      const filename = path.join(directory, name), stat = lstatSync(filename)
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw Error('invalid optional schema')
      const bytes = readFileSync(filename); digest.update(name).update('\0').update(bytes).update('\0')
      return JSON.parse(bytes.toString('utf8'))
    })
    return verifyBoardPeerSchema(...schemas) ? digest.digest('hex') : null
  } catch { return null }
}

export function verifyNativeSchemaDirectory(directory) {
  const schemas = new Map(), digest = createHash('sha256')
  try {
    for (const name of SCHEMAS) {
      const filename = path.join(directory, name)
      const stat = lstatSync(filename)
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return null
      const content = readFileSync(filename, 'utf8')
      digest.update(name).update('\0').update(content).update('\0')
      schemas.set(name, JSON.parse(content))
    }
  } catch { return null }
  const get = name => schemas.get(name)
  const start = get('v2/ThreadStartParams.json'), startOut = get('v2/ThreadStartResponse.json')
  const resume = get('v2/ThreadResumeParams.json'), resumeOut = get('v2/ThreadResumeResponse.json')
  const turn = get('v2/TurnStartParams.json'), turnOut = get('v2/TurnStartResponse.json')
  const configIn = get('v2/ConfigReadParams.json'), configOut = get('v2/ConfigReadResponse.json')
  const models = get('v2/ModelListResponse.json'), mcpIn = get('v2/ListMcpServerStatusParams.json'), mcp = get('v2/ListMcpServerStatusResponse.json')
  const toolIn = get('DynamicToolCallParams.json'), toolOut = get('DynamicToolCallResponse.json')
  const functionSpec = start?.definitions?.DynamicToolSpec?.oneOf?.find(item => item.title === 'FunctionDynamicToolSpec')
  const dynamicItem = startOut?.definitions?.ThreadItem?.oneOf?.find(item => item.title === 'DynamicToolCallThreadItem')
  const toolText = toolOut?.definitions?.DynamicToolCallOutputContentItem?.oneOf?.find(item => item.title === 'InputTextDynamicToolCallOutputContentItem')
  const model = models?.definitions?.Model?.properties
  const contextContract = Boolean(
    has(start?.properties, 'dynamicTools', 'config', 'model', 'sandbox', 'approvalPolicy', 'ephemeral') &&
    has(resume?.properties, 'threadId', 'config', 'model', 'sandbox', 'approvalPolicy') &&
    has(turn?.properties, 'threadId', 'input', 'model', 'effort', 'additionalContext', 'outputSchema', 'sandboxPolicy', 'approvalPolicy') &&
    requires(turn, 'threadId', 'input') && has(turnOut?.properties, 'turn') &&
    requires(functionSpec, 'name', 'inputSchema', 'description', 'type') &&
    requires(dynamicItem, 'id', 'tool', 'status', 'type') &&
    requires(toolIn, 'threadId', 'turnId', 'callId', 'tool', 'arguments') &&
    has(toolIn?.properties, 'threadId', 'turnId', 'callId', 'tool', 'arguments') &&
    requires(toolOut, 'success', 'contentItems') && has(toolOut?.properties, 'success', 'contentItems') &&
    requires(toolText, 'type', 'text') &&
    toolText?.properties?.type?.enum?.includes('inputText') &&
    has(configIn?.properties, 'cwd', 'includeLayers') &&
    has(configOut?.definitions?.Config?.properties, 'model', 'model_reasoning_effort', 'developer_instructions') &&
    has(model, 'id', 'model', 'defaultReasoningEffort', 'supportedReasoningEfforts') &&
    models?.definitions?.ReasoningEffort?.type === 'string' &&
    has(mcpIn?.properties, 'threadId', 'limit', 'cursor') &&
    has(mcp?.definitions?.McpServerStatus?.properties, 'name', 'pluginId', 'tools', 'toolsError', 'resources', 'resourceTemplates')
  )
  const responsePolicy = schema => requires(schema, 'thread', 'sandbox', 'approvalPolicy') &&
    readOnly(schema)?.properties?.type?.enum?.includes('readOnly') &&
    readOnly(schema)?.properties?.networkAccess?.type === 'boolean'
  const qaContract = Boolean(contextContract && responsePolicy(startOut) && responsePolicy(resumeOut) &&
    start?.definitions?.SandboxMode?.enum?.includes('read-only') &&
    start?.definitions?.AskForApproval?.oneOf?.some(item => item.enum?.includes('never')) &&
    readOnly(turn)?.properties?.type?.enum?.includes('readOnly') &&
    readOnly(turn)?.properties?.networkAccess?.type === 'boolean')
  return { contextContract, qaContract, schemaFingerprint: digest.digest('hex'), boardPeerSchemaFingerprint: optionalBoardPeerFingerprint(directory),
    threadDeleteSchemaFingerprint: optionalThreadDeleteFingerprint(directory), turnSteerSchemaFingerprint: optionalTurnSteerFingerprint(directory) }
}

// thread/delete (Codex app-server, e.g. 0.171): the request is in the client request union, its params are exactly { threadId: string }
// and its response is an object. Optional: a binary without it keeps every other contract. (L2 c18: deleting a conversation.)
export function verifyThreadDeleteSchema(request, params, response) {
  const listed = (request?.oneOf ?? request?.anyOf ?? []).some(item => item?.properties?.method?.enum?.length === 1 && item.properties.method.enum[0] === 'thread/delete')
  return Boolean(listed && params?.title === 'ThreadDeleteParams' && params.type === 'object' && requires(params, 'threadId') && params.required.length === 1 &&
    params.properties?.threadId?.type === 'string' && Object.keys(params.properties).length === 1 && response?.title === 'ThreadDeleteResponse' && response.type === 'object')
}
// turn/steer by schema capability (c23; Main's smoke-3 proved turn/steer { threadId, expectedTurnId, input } -> { turnId } on the official 0.171, whose
// generated schema also passes verifyBoardPeerSchema; the version pin, not the schema, kept the steer contract to 0.162.1). A message steered into the
// working turn needs only this: the request is in the client request union; its params require nothing beyond threadId, expectedTurnId and input
// (clientUserMessageId and the rest optional), threadId and expectedTurnId are strings, input is an array whose text variant is { type: 'text', text,
// text_elements }; the response requires turnId (string). No additionalContext: a plain message is not the board's untrusted peer input.
export function verifyTurnSteerSchema(request, params, response) {
  const listed = (request?.oneOf ?? request?.anyOf ?? []).some(item => item?.properties?.method?.enum?.length === 1 && item.properties.method.enum[0] === 'turn/steer')
  const p = params?.properties ?? {}
  const resolve = s => { const name = s?.$ref?.match(/^#\/definitions\/([A-Za-z0-9_]+)$/)?.[1]; return name ? params.definitions?.[name] : s }
  const hasType = (s, type) => s?.type === type || (Array.isArray(s?.type) && s.type.includes(type))
  const text = resolve(p.input?.items)?.oneOf?.find(x => x.properties?.type?.enum?.length === 1 && x.properties.type.enum[0] === 'text')
  return Boolean(listed && params?.title === 'TurnSteerParams' && params.type === 'object' && requires(params, 'threadId', 'input', 'expectedTurnId')
    && params.required.every(k => ['threadId', 'input', 'expectedTurnId'].includes(k))
    && hasType(p.threadId, 'string') && hasType(p.expectedTurnId, 'string') && (p.clientUserMessageId === undefined || hasType(p.clientUserMessageId, 'string'))
    && p.input?.type === 'array' && requires(text, 'type', 'text') && hasType(text.properties?.text, 'string') && text.properties?.text_elements?.type === 'array'
    && text.required.every(k => ['type', 'text', 'text_elements'].includes(k))
    && response?.title === 'TurnSteerResponse' && requires(response, 'turnId') && hasType(response.properties?.turnId, 'string'))
}
export function optionalTurnSteerFingerprint(directory) {
  try {
    const digest = createHash('sha256')
    const schemas = ['ClientRequest.json', 'v2/TurnSteerParams.json', 'v2/TurnSteerResponse.json'].map(name => {
      const filename = path.join(directory, name), stat = lstatSync(filename)
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw Error('invalid optional schema')
      const bytes = readFileSync(filename); digest.update(name).update('\0').update(bytes).update('\0')
      return JSON.parse(bytes.toString('utf8'))
    })
    return verifyTurnSteerSchema(...schemas) ? digest.digest('hex') : null
  } catch { return null }
}

function optionalThreadDeleteFingerprint(directory) {
  try {
    const digest = createHash('sha256')
    const schemas = ['ClientRequest.json', 'v2/ThreadDeleteParams.json', 'v2/ThreadDeleteResponse.json'].map(name => {
      const filename = path.join(directory, name), stat = lstatSync(filename)
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw Error('invalid optional schema')
      const bytes = readFileSync(filename); digest.update(name).update('\0').update(bytes).update('\0')
      return JSON.parse(bytes.toString('utf8'))
    })
    return verifyThreadDeleteSchema(...schemas) ? digest.digest('hex') : null
  } catch { return null }
}

// Only the optional thread/delete contract, for a binary whose version this source does not otherwise trust (the context contract is never
// granted from shape; see inspectNativeCapabilities). Returns the thread/delete fingerprint or null.
export function probeThreadDeleteSchema({ executable, env, cwd, run }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'egdesk-native-schema-'))
  try {
    const result = run(executable, ['app-server', 'generate-json-schema', '--experimental', '--out', directory], {
      env, cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return result.status === 0 ? optionalThreadDeleteFingerprint(directory) : null
  } catch { return null }
  finally { rmSync(directory, { recursive: true, force: true }) }
}

// Only the optional turn/steer contract, for any identified binary version (a steer capability of THIS binary's generated schema; it grants nothing
// else). Returns the turn/steer fingerprint or null.
export function probeTurnSteerSchema({ executable, env, cwd, run }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'egdesk-native-schema-'))
  try {
    const result = run(executable, ['app-server', 'generate-json-schema', '--experimental', '--out', directory], {
      env, cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return result.status === 0 ? optionalTurnSteerFingerprint(directory) : null
  } catch { return null }
  finally { rmSync(directory, { recursive: true, force: true }) }
}

export function probeGeneratedNativeSchema({ executable, env, cwd, run }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'egdesk-native-schema-'))
  try {
    const result = run(executable, ['app-server', 'generate-json-schema', '--experimental', '--out', directory], {
      env, cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return result.status === 0 ? verifyNativeSchemaDirectory(directory) : null
  } catch { return null }
  finally { rmSync(directory, { recursive: true, force: true }) }
}
