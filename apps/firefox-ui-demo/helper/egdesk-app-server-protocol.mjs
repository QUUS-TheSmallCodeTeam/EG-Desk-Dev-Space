// c22: the Codex app-server 0.171 wire protocol as a schema check, for the fake app-server and the real-engine check.
// protocol-0171.json is a subset of the JSON schema Main generated from the official binary (scripts/real-engine/extract-protocol-subset.mjs).
// validateMessage(kind, method, value) → [] or ['<json path>: <reason>']. A small draft-07 reader: $ref, type, enum, const, properties,
// required, additionalProperties, items, oneOf / anyOf / allOf (a value matches a union when ANY branch accepts it), minimum, maximum.
// Unknown keywords are ignored, so a message passes when nothing in the subset forbids it; the check cannot say the real binary accepts it.
import fs from 'node:fs'

export const PROTOCOL_FIXTURE = new URL('../scripts/real-engine/protocol-0171.json', import.meta.url)
let loaded = null
export const loadProtocol = () => loaded ??= JSON.parse(fs.readFileSync(PROTOCOL_FIXTURE, 'utf8'))

const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v)
const typeOk = (want, v) => (Array.isArray(want) ? want : [want]).some(t => t === typeOf(v) || (t === 'number' && typeof v === 'number') || (t === 'integer' && Number.isInteger(v)))

function check(schema, value, at, defs, errors, depth = 0) {
  if (schema === true || schema === undefined) return
  if (schema === false) return void errors.push(`${at}: not allowed`)
  if (depth > 60) return void errors.push(`${at}: schema too deep`)
  if (schema.$ref) {
    const name = String(schema.$ref).replace(/^#\/definitions\//, '')
    if (!defs[name]) return void errors.push(`${at}: unknown schema ${name}`)
    return check(defs[name], value, at, defs, errors, depth + 1)
  }
  for (const key of ['oneOf', 'anyOf']) if (schema[key]) {
    const attempts = schema[key].map(branch => { const e = []; check(branch, value, at, defs, e, depth + 1); return e })
    if (!attempts.some(e => e.length === 0)) {
      const best = attempts.reduce((a, b) => (b.length < a.length ? b : a))
      errors.push(`${at}: matches none of ${schema[key].length} alternatives (closest: ${best[0] ?? 'n/a'})`)
    }
  }
  if (schema.allOf) for (const part of schema.allOf) check(part, value, at, defs, errors, depth + 1)
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${at}: must be ${JSON.stringify(schema.const)}`)
  if (schema.enum && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${at}: must be one of ${JSON.stringify(schema.enum).slice(0, 120)}`)
  if (schema.type !== undefined && !typeOk(schema.type, value)) return void errors.push(`${at}: expected ${JSON.stringify(schema.type)}, got ${typeOf(value)}`)
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above ${schema.maximum}`)
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => check(schema.items, item, `${at}[${i}]`, defs, errors, depth + 1))
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const name of schema.required ?? []) if (!(name in value)) errors.push(`${at}.${name}: required`)
    for (const [name, part] of Object.entries(schema.properties ?? {})) if (name in value) check(part, value[name], `${at}.${name}`, defs, errors, depth + 1)
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      for (const name of Object.keys(value)) if (!(name in (schema.properties ?? {}))) check(schema.additionalProperties, value[name], `${at}.${name}`, defs, errors, depth + 1)
    }
  }
}

export const MESSAGE_KINDS = Object.freeze(['notification', 'serverRequest', 'clientRequest', 'result', 'response'])

/** kind: notification | serverRequest (params) | clientRequest (params) | result (a method's result) | response (to a server request) */
export function validateMessage(kind, method, value) {
  const protocol = loadProtocol(), schema = protocol.messages[`${kind}:${method}`]
  if (!schema) return [`$: no ${kind} ${method} in the 0.171 subset`]
  const errors = []
  check(schema, value, '$', protocol.definitions, errors)
  return errors
}

export const knownMessage = (kind, method) => `${kind}:${method}` in loadProtocol().messages
