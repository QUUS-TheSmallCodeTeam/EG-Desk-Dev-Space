#!/usr/bin/env node
// c22: writes scripts/real-engine/protocol-0171.json, the part of the Codex app-server JSON schema (0.171.0-alpha.13, generated with
// `codex app-server generate-json-schema --experimental`; Main generated it) that the fake app-server and the real-engine check use:
// the notifications and server requests the fake sends, the results it returns, and the client requests the check makes.
// This reads a schema folder; it runs nothing and starts no Codex. Usage: node extract-protocol-subset.mjs --schema <dir> [--out <file>]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROTOCOL_VERSION = '0.171.0-alpha.13'
// [kind, wire method, file relative to the schema folder, branch file for the union (ServerNotification / ServerRequest / ClientRequest) or null]
export const WANTED = Object.freeze([
  ['notification', 'turn/started', 'ServerNotification.json'], ['notification', 'turn/completed', 'ServerNotification.json'],
  ['notification', 'item/started', 'ServerNotification.json'], ['notification', 'item/completed', 'ServerNotification.json'],
  ['notification', 'thread/tokenUsage/updated', 'ServerNotification.json'], ['notification', 'thread/compacted', 'ServerNotification.json'],
  ['notification', 'error', 'ServerNotification.json'], ['notification', 'mcpServer/startupStatus/updated', 'ServerNotification.json'],
  ['serverRequest', 'item/tool/call', 'ServerRequest.json'], ['serverRequest', 'item/commandExecution/requestApproval', 'ServerRequest.json'],
  ['serverRequest', 'item/fileChange/requestApproval', 'ServerRequest.json'],
  ['clientRequest', 'initialize', 'ClientRequest.json'], ['clientRequest', 'thread/start', 'ClientRequest.json'], ['clientRequest', 'turn/start', 'ClientRequest.json'],
  ['clientRequest', 'thread/unsubscribe', 'ClientRequest.json'], ['clientRequest', 'turn/interrupt', 'ClientRequest.json'], ['clientRequest', 'turn/steer', 'ClientRequest.json'], ['clientRequest', 'thread/fork', 'ClientRequest.json'],
  ['clientRequest', 'config/read', 'ClientRequest.json'], ['clientRequest', 'mcpServerStatus/list', 'ClientRequest.json'],
  ['clientRequest', 'experimentalFeature/list', 'ClientRequest.json'], ['clientRequest', 'hooks/list', 'ClientRequest.json'],
  ['result', 'initialize', 'v1/InitializeResponse.json'], ['result', 'thread/start', 'v2/ThreadStartResponse.json'], ['result', 'turn/start', 'v2/TurnStartResponse.json'],
  ['result', 'thread/fork', 'v2/ThreadForkResponse.json'], ['result', 'thread/unsubscribe', 'v2/ThreadUnsubscribeResponse.json'], ['result', 'turn/interrupt', 'v2/TurnInterruptResponse.json'], ['result', 'turn/steer', 'v2/TurnSteerResponse.json'],
  ['result', 'config/read', 'v2/ConfigReadResponse.json'], ['result', 'mcpServerStatus/list', 'v2/ListMcpServerStatusResponse.json'],
  ['result', 'experimentalFeature/list', 'v2/ExperimentalFeatureListResponse.json'], ['result', 'hooks/list', 'v2/HooksListResponse.json'],
  ['response', 'item/tool/call', 'DynamicToolCallResponse.json'],
])

const refName = ref => String(ref).replace(/^#\/definitions\//, '')
const eachRef = (node, fn) => { if (Array.isArray(node)) node.forEach(n => eachRef(n, fn)); else if (node && typeof node === 'object') { for (const [k, v] of Object.entries(node)) { if (k === '$ref') fn(v); else eachRef(v, fn) } } }

/** The root schema of one wanted message: a union file is cut to the branch of that method (its params); others are the whole file. */
function rootOf(file, kind, method, schemaDir) {
  const json = JSON.parse(fs.readFileSync(path.join(schemaDir, file), 'utf8'))
  const definitions = json.definitions ?? {}
  if (!/^(ServerNotification|ServerRequest|ClientRequest)\.json$/.test(file)) { const { definitions: _d, $schema: _s, ...root } = json; return { root, definitions } }
  const branch = json.oneOf.find(b => b.properties?.method?.enum?.[0] === method)
  if (!branch) throw new Error(`${file} has no ${method}`)
  return { root: branch.properties.params ?? { type: 'object' }, definitions }
}

export function extractProtocolSubset(schemaDir) {
  const definitions = {}, messages = {}
  for (const [kind, method, file] of WANTED) {
    const { root, definitions: own } = rootOf(file, kind, method, schemaDir)
    const reach = new Set(), todo = []
    eachRef(root, r => todo.push(refName(r)))
    while (todo.length) { const name = todo.pop(); if (reach.has(name)) continue; reach.add(name); if (!own[name]) throw new Error(`${file}: unresolved ${name}`); eachRef(own[name], r => todo.push(refName(r))) }
    // one generator wrote every file: a name means the same schema everywhere. A name with two different bodies is a finding, not merged.
    for (const name of reach) {
      if (definitions[name] && JSON.stringify(definitions[name]) !== JSON.stringify(own[name])) throw new Error(`definition ${name} differs between files (${file}, ${method})`)
      definitions[name] = own[name]
    }
    messages[`${kind}:${method}`] = root
  }
  const sorted = o => Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : 1)))
  return { source: `codex-cli ${PROTOCOL_VERSION}: app-server generate-json-schema --experimental (generated by Main; this file is a subset)`, version: PROTOCOL_VERSION, definitions: sorted(definitions), messages: sorted(messages) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null }
  const schemaDir = arg('--schema'), out = arg('--out') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'protocol-0171.json')
  if (!schemaDir) { console.error('usage: extract-protocol-subset.mjs --schema <dir> [--out <file>]'); process.exit(2) }
  const subset = extractProtocolSubset(path.resolve(schemaDir))
  fs.writeFileSync(out, `${JSON.stringify(subset)}\n`)
  console.log(`wrote ${out}: ${Object.keys(subset.messages).length} messages, ${Object.keys(subset.definitions).length} definitions, ${fs.statSync(out).size} bytes`)
}
