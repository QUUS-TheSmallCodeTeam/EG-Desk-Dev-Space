import { createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync } from 'node:fs'
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

export function fingerprintNativeExecutable(executable) {
  const hash = createHash('sha256')
  const native = bundledNativePath(executable)
  const firstBytes = Buffer.alloc(2), fd = openSync(executable, 'r')
  try { readSync(fd, firstBytes, 0, 2, 0) } finally { closeSync(fd) }
  if (firstBytes.toString() === '#!' && !native) throw new Error('Unrecognized Codex launcher cannot be fingerprinted')
  addFileFingerprint(hash, executable)
  if (native) addFileFingerprint(hash, native)
  return hash.digest('hex')
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
  return { contextContract, qaContract, schemaFingerprint: digest.digest('hex') }
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
