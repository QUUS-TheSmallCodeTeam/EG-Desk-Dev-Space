// L4 cycle 30: the JSON Schema that constrains the answering model's FINAL message when the briefing asks it to fill (skeleton order) or design (design-first order)
// the board. The official Codex TurnStartParams carries `outputSchema` ("Optional JSON Schema used to constrain the final assistant message for this turn"); with it
// the engine's final message must be a valid fill / design, not prose around a JSON object.
//
// Built from the accepted shape of the existing render components, nothing invented: the guide's items and their slot descriptors (helper/egdesk-briefing-catalog.mjs:
// text / material / list slots, STEP_SLOTS) for a fill; the board's target aliases and the parts a new component may take for a design. The result is STRICT-MODE
// compatible (assumption, to be confirmed against the real engine by the real-engine script): every object has additionalProperties:false and lists all of its
// properties as required; only type / properties / required / additionalProperties / items / enum / anyOf are used - NO minLength, maxLength, pattern, format,
// minItems, maxItems (the code's validators keep those limits). Because a strict schema cannot leave a field out, a slot the material does not hold is `null`
// (the same thing as a slot left out and reported "unfillable"): stripNulls turns it back before the flow's own validator (validateFill / shapeDesign) reads it.
//
// This module only builds and checks. Which request gets a schema, and whether the flag is on, is decided by the engine (egdesk-briefing-engine.mjs).

const NULL = Object.freeze({ type: 'null' })
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties })
const nullable = schema => ({ anyOf: [schema, NULL] })

/** The schema of ONE slot as the catalog describes it: a text, one of the item's material aliases, or a list of rows with exactly the listed fields. */
export function slotSchema(slot, item) {
  if (slot.type === 'text') return { type: 'string' }
  if (slot.type === 'material') return { type: 'string', enum: [...item.materials] }
  if (slot.type === 'list') return { type: 'array', items: obj(Object.fromEntries(slot.of.map(f => [f.name, slotSchema(f, item)]))) }
  throw new TypeError(`unknown slot type ${slot?.type}`)
}
const optionalSlot = (slot, item) => nullable(slotSchema(slot, item))

/**
 * fillOutputSchema(guide, { only }) -> the schema of a briefing_fill reply: { title, items: { <item id>: { text, fallback, slots: { <slot>: value|null } } }, unfillable }.
 * Only the guide's items (those in `only` for a partial fill) are listed, each with exactly the slots of its component; a step's own text / fallback are strings.
 */
export function fillOutputSchema(guide, { only = null } = {}) {
  const items = (guide?.items ?? []).filter(i => !only || only.has(i.id))
  if (!items.length) throw new TypeError('the guide has no item to fill')
  const ids = items.map(i => i.id)
  const itemSchema = item => obj({ text: { type: 'string' }, fallback: { type: 'string' }, slots: obj(Object.fromEntries((item.slots ?? []).map(s => [s.name, optionalSlot(s, item)]))) })
  return obj({ title: { type: 'string' }, items: obj(Object.fromEntries(items.map(i => [i.id, itemSchema(i)]))),
    unfillable: { type: 'array', items: obj({ item: { type: 'string', enum: ids }, slot: { type: 'string' }, reason: { type: 'string' } }) } })
}

/**
 * designOutputSchema(request) -> the schema of a briefing_design / briefing_redesign reply: { title, steps: [{ text, targets, emphasis, fallback }], newComponents }.
 * targets: the board aliases the request lists (and "new:<part>" for a part the request allows a new component for); emphasis is one of the closed words or null.
 */
export function designOutputSchema(request) {
  const aliases = (Array.isArray(request?.targets) ? request.targets : []).map(t => t?.alias).filter(a => typeof a === 'string')
  const parts = (Array.isArray(request?.newAllowed) ? request.newAllowed : []).map(n => n?.part).filter(p => typeof p === 'string')
  const allowed = [...aliases, ...parts.map(p => `new:${p}`)]
  if (!allowed.length) throw new TypeError('the request lists nothing to point at')
  return obj({ title: { type: 'string' },
    steps: { type: 'array', items: obj({ text: { type: 'string' }, targets: { type: 'array', items: { type: 'string', enum: allowed } }, emphasis: nullable({ type: 'string', enum: ['spotlight', 'outline'] }), fallback: { type: 'string' } }) },
    newComponents: { type: 'array', items: obj({ part: parts.length ? { type: 'string', enum: parts } : { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' } }) } })
}

/** The schema for an engine request, or null for a kind that is not constrained (a component text is markdown, not JSON). Throws only on a request that cannot be described. */
export function outputSchemaFor(request) {
  const kind = request?.kind
  if (kind === 'briefing_fill') return fillOutputSchema(request.guide, { only: Array.isArray(request.only) ? new Set(request.only) : null })
  if (kind === 'briefing_design' || kind === 'briefing_redesign' || kind === 'briefing_redesign_inconclusive') return designOutputSchema(request)
  return null
}

// ---- what a strict-mode schema may contain (checked in the tests; the engine would refuse anything else) ----
const FORBIDDEN = ['minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'default', '$ref', 'oneOf', 'allOf', 'not', 'patternProperties', 'const']
/** [] when the schema stays inside the strict subset; otherwise the problems, as short texts with their path. */
export function schemaProblems(schema, at = '$') {
  const out = []
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [`${at}: not an object`]
  for (const key of FORBIDDEN) if (Object.hasOwn(schema, key)) out.push(`${at}: ${key} is not allowed`)
  if (Array.isArray(schema.anyOf)) schema.anyOf.forEach((s, i) => out.push(...schemaProblems(s, `${at}.anyOf[${i}]`)))
  if (schema.type === 'object') {
    const props = schema.properties ?? {}, keys = Object.keys(props)
    if (schema.additionalProperties !== false) out.push(`${at}: additionalProperties must be false`)
    if (!Array.isArray(schema.required) || schema.required.length !== keys.length || keys.some(k => !schema.required.includes(k))) out.push(`${at}: every property must be required`)
    for (const k of keys) out.push(...schemaProblems(props[k], `${at}.${k}`))
  } else if (schema.type === 'array') {
    if (!schema.items) out.push(`${at}: items is required`)
    else out.push(...schemaProblems(schema.items, `${at}[]`))
  } else if (!Array.isArray(schema.anyOf) && !['string', 'null', 'boolean', 'integer', 'number'].includes(schema.type)) out.push(`${at}: unknown type ${String(schema.type)}`)
  return out
}

// ---- checking a value against the subset above (the engine does not trust the engine's constraint: a mock, an older engine or a refusal may not honour it) ----
/** null when the value fits the schema; otherwise a short reason code with its path. */
export function violation(value, schema, at = '$') {
  if (Array.isArray(schema.anyOf)) { const reasons = schema.anyOf.map(s => violation(value, s, at)); return reasons.some(r => r === null) ? null : reasons[0] }
  if (schema.type === 'null') return value === null ? null : `${at}: expected null`
  if (schema.enum && !schema.enum.includes(value)) return `${at}: not one of the allowed values`
  if (schema.type === 'string') return typeof value === 'string' ? null : `${at}: expected a string`
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${at}: expected an array`
    for (let i = 0; i < value.length; i++) { const r = violation(value[i], schema.items, `${at}[${i}]`); if (r) return r }
    return null
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${at}: expected an object`
    for (const k of Object.keys(value)) if (!Object.hasOwn(schema.properties, k)) return `${at}.${k}: not a listed property`
    for (const k of schema.required) if (!Object.hasOwn(value, k)) return `${at}.${k}: missing`
    for (const k of Object.keys(schema.properties)) { const r = violation(value[k], schema.properties[k], `${at}.${k}`); if (r) return r }
    return null
  }
  return `${at}: unsupported schema`
}

/**
 * stripNulls(request kind, value) -> the reply as the flow's own validators read it: a null slot is a slot left out ("unfillable"), a null emphasis is no emphasis,
 * an empty "unfillable" / "newComponents" is absent. Everything else is untouched.
 */
export function stripNulls(kind, value) {
  if (kind === 'briefing_fill') {
    const items = Object.fromEntries(Object.entries(value.items ?? {}).map(([id, item]) => [id, { ...item, slots: Object.fromEntries(Object.entries(item.slots ?? {}).filter(([, v]) => v !== null)) }]))
    return { title: value.title, items, ...(Array.isArray(value.unfillable) && value.unfillable.length ? { unfillable: value.unfillable } : {}) }
  }
  return { title: value.title, steps: (value.steps ?? []).map(s => ({ text: s.text, targets: s.targets, ...(s.emphasis ? { emphasis: s.emphasis } : {}), fallback: s.fallback })),
    ...(Array.isArray(value.newComponents) && value.newComponents.length ? { newComponents: value.newComponents } : {}) }
}
