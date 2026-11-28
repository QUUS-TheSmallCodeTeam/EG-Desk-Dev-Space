import { fieldDisplaySafe, isSensitiveLabel } from './egdesk-browser-reflex.mjs'

// Round g (L59): Browser procedures. A procedure is what an agent did in a Browser card, saved as editable JSON. Pure: no I/O.
// Contract: specs/round-g-procedures.md section 1. Flag EGDESK_BROWSER_PROCEDURES=on, default off.
export const PROCEDURE_FLAG = 'EGDESK_BROWSER_PROCEDURES'
export const procedureFlagOn = (env = process.env) => env?.[PROCEDURE_FLAG] === 'on'

export const PROCEDURE_LIMITS = Object.freeze({ bytes: 1024 * 1024, steps: 100, name: 80, param: 60, label: 120 })
export const PROCEDURE_OPS = Object.freeze(['navigate', 'fill', 'select', 'click', 'press', 'scroll', 'history'])
export const PROCEDURE_CONFIRMS = Object.freeze(['submit', 'payment', 'delete'])
const NEEDS_TARGET = new Set(['fill', 'select', 'click', 'press'])
const EXPECT_KINDS = ['target-value', 'url', 'visible-text', 'changed']
const DIRECTIONS = ['up', 'down', 'top', 'bottom']
const ACTIONS = ['back', 'forward', 'reload']
const ID = /^proc-[0-9a-f]{12,32}$/

// Proposed copy (one place): default names.
export const PROCEDURE_COPY = Object.freeze({ fallbackName: '브라우저 절차' })

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value, max) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
const httpUrl = value => { try { return /^https?:$/.test(new URL(value).protocol) } catch { return false } }
const hostOf = value => { try { return new URL(value).host.toLowerCase() } catch { return '' } }
const ms = value => Number.isFinite(value) && value >= 0

// The words that make a press a confirmed one (contract vocabulary), split into the three kinds.
const DELETE_WORDS = /삭제|탈퇴|해지|\b(?:delete|remove|unsubscribe)/i
const PAYMENT_WORDS = /결제|지불|송금|이체|구매|주문|\b(?:pay|payment|checkout|purchase|buy|order)/i
const SUBMIT_WORDS = /제출|신청|\b(?:submit|confirm)/i

/**
 * confirmKindOf(target, facts) -> 'submit' | 'payment' | 'delete' | null
 * facts: { type: button type, formMethod, regionLabel, sensitiveRegion }, the element's own observed facts (may be absent).
 */
export function confirmKindOf(target, facts = null) {
  const words = [target?.label, target?.name, facts?.regionLabel].filter(value => typeof value === 'string').join(' ')
  if (DELETE_WORDS.test(words)) return 'delete'
  if (PAYMENT_WORDS.test(words)) return 'payment'
  if (SUBMIT_WORDS.test(words)) return 'submit'
  const type = String(facts?.type ?? '').toLowerCase()
  if (['submit', 'image'].includes(type) && String(facts?.formMethod ?? '').toLowerCase() === 'post') return 'submit'
  return null
}

function normalizeTarget(raw, errors, at) {
  if (!record(raw)) return null
  const label = text(raw.label, PROCEDURE_LIMITS.label)
  if (!label) { errors.push(`${at}.target.label is required`); return null }
  const out = { label }
  for (const key of ['role', 'tag', 'name', 'href']) if (typeof raw[key] === 'string' && raw[key]) out[key] = key === 'href' ? raw[key].slice(0, 2000) : text(raw[key], PROCEDURE_LIMITS.label)
  return out
}

/**
 * normalizeProcedure(raw, { now }) -> { ok: true, procedure } | { ok: false, errors }
 * Builds a fresh object (unknown keys are dropped). A sensitive value is never kept: a person step or a sensitive param loses its text.
 */
export function normalizeProcedure(raw, { now = Date.now() } = {}) {
  const errors = []
  if (!record(raw)) return { ok: false, errors: ['procedure must be an object'] }
  const out = { version: 1 }
  if (raw.id !== undefined) { if (typeof raw.id === 'string' && ID.test(raw.id)) out.id = raw.id; else errors.push('id must be proc-<hex 12..32>') }
  if (raw.version !== undefined && raw.version !== 1) errors.push('version must be 1')
  const name = text(raw.name, 4096)
  if (!name || name.length > PROCEDURE_LIMITS.name) errors.push('name must be 1..80 characters')
  out.name = name.slice(0, PROCEDURE_LIMITS.name)
  const stamp = ms(now) ? now : Date.now()
  out.createdAt = ms(raw.createdAt) ? raw.createdAt : stamp
  out.updatedAt = ms(raw.updatedAt) ? raw.updatedAt : stamp
  if (record(raw.source)) {
    const source = {}
    for (const key of ['clientThreadId', 'cardId']) if (typeof raw.source[key] === 'string' && raw.source[key]) source[key] = raw.source[key].slice(0, 160)
    if (Object.keys(source).length) out.source = source
  }
  const startUrl = record(raw.start) ? raw.start.url : undefined
  if (!httpUrl(startUrl)) errors.push('start.url must be an http(s) URL')
  else {
    out.start = { url: startUrl, host: hostOf(startUrl) }
    if (typeof raw.start.title === 'string' && raw.start.title) out.start.title = text(raw.start.title, PROCEDURE_LIMITS.label)
  }

  const params = []
  const byName = new Map()
  if (!Array.isArray(raw.params)) errors.push('params must be a list')
  else raw.params.forEach((param, index) => {
    const pname = record(param) ? text(param.name, 4096) : ''
    if (!pname || pname.length > PROCEDURE_LIMITS.param) { errors.push(`params[${index}].name must be 1..60 characters`); return }
    if (byName.has(pname)) { errors.push(`params[${index}].name is a duplicate`); return }
    const sensitive = param.sensitive === true
    if (param.default !== null && param.default !== undefined && typeof param.default !== 'string') { errors.push(`params[${index}].default must be text or null`); return }
    const entry = { name: pname, default: sensitive ? null : (param.default ?? null), sensitive }
    params.push(entry); byName.set(pname, entry)
  })
  out.params = params

  const steps = []
  const ids = new Set()
  if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > PROCEDURE_LIMITS.steps) errors.push('steps must be 1..100 items')
  else raw.steps.forEach((step, index) => {
    const at = `steps[${index}]`
    if (!record(step)) { errors.push(`${at} must be an object`); return }
    if (typeof step.id !== 'string' || !/^s\d+$/.test(step.id) || ids.has(step.id)) { errors.push(`${at}.id must be a unique s<n>`); return }
    ids.add(step.id)
    if (!PROCEDURE_OPS.includes(step.op)) { errors.push(`${at}.op is unknown`); return }
    const next = { id: step.id, op: step.op }
    const target = normalizeTarget(step.target, errors, at)
    if (NEEDS_TARGET.has(step.op) && !target) { if (!errors.some(e => e.startsWith(`${at}.target`))) errors.push(`${at}.target is required`) }
    if (target) next.target = target
    if (step.op === 'fill' || step.op === 'select') {
      const valueParam = record(step.value) && typeof step.value.param === 'string' ? text(step.value.param, 4096) : null
      const valueText = record(step.value) && typeof step.value.text === 'string' ? step.value.text : null
      if (valueParam === null && valueText === null) errors.push(`${at}.value needs param or text`)
      else if (valueParam !== null) {
        const param = byName.get(valueParam)
        if (!param) errors.push(`${at}.value.param is not in params`)
        else { next.value = { param: valueParam }; if (param.sensitive || step.person === true) { next.person = true; param.sensitive = true; param.default = null } }
      } else if (target && isSensitiveLabel(target.label)) errors.push(`${at}: a sensitive field's value is not stored`)
      else if (step.person === true) errors.push(`${at}: a person step carries no text`)
      else next.value = { text: valueText }
    }
    if (step.op === 'navigate') { if (httpUrl(step.url)) next.url = step.url; else errors.push(`${at}.url must be an http(s) URL`) }
    if (step.op === 'press') { if (typeof step.key === 'string' && step.key) next.key = step.key.slice(0, 40); else errors.push(`${at}.key is required`) }
    if (step.op === 'scroll') {
      if (DIRECTIONS.includes(step.direction)) next.direction = step.direction; else errors.push(`${at}.direction is invalid`)
      if (step.amount !== undefined) { if (typeof step.amount === 'number' && Number.isFinite(step.amount) || ['page', 'half'].includes(step.amount)) next.amount = step.amount; else errors.push(`${at}.amount is invalid`) }
    }
    if (step.op === 'history') { if (ACTIONS.includes(step.action)) next.action = step.action; else errors.push(`${at}.action is invalid`) }
    if (step.expect !== undefined) {
      if (record(step.expect) && EXPECT_KINDS.includes(step.expect.kind) && (step.expect.value === undefined || typeof step.expect.value === 'string')) {
        next.expect = { kind: step.expect.kind, ...(step.expect.value !== undefined ? { value: step.expect.value } : {}) }
      } else errors.push(`${at}.expect is invalid`)
    }
    if (step.confirm !== undefined && step.confirm !== null) { if (PROCEDURE_CONFIRMS.includes(step.confirm)) next.confirm = step.confirm; else errors.push(`${at}.confirm is invalid`) }
    if (step.person === true) next.person = true
    steps.push(next)
  })
  out.steps = steps
  if (errors.length) return { ok: false, errors }
  if (Buffer.byteLength(JSON.stringify(out)) > PROCEDURE_LIMITS.bytes) return { ok: false, errors: ['procedure is larger than 1 MB'] }
  return { ok: true, procedure: out }
}

/**
 * bindProcedureParams(procedure, values) -> { steps, missing, personSteps }
 * values: { [paramName]: text }. A fill/select step gets value { text }. A person step keeps value { param } and is listed in personSteps.
 * missing: names of used, non-sensitive params that have neither a value nor a default.
 */
export function bindProcedureParams(procedure, values = {}) {
  const byName = new Map((procedure?.params ?? []).map(param => [param.name, param]))
  const given = record(values) ? values : {}
  const missing = []
  const personSteps = []
  const steps = (procedure?.steps ?? []).map(step => {
    if (!record(step.value) || typeof step.value.param !== 'string') return { ...step }
    const param = byName.get(step.value.param)
    if (step.person === true || param?.sensitive) { personSteps.push(step.id); return { ...step } }
    const own = typeof given[step.value.param] === 'string' ? given[step.value.param] : null
    const resolved = own ?? (typeof param?.default === 'string' ? param.default : null)
    if (resolved === null) { if (!missing.includes(step.value.param)) missing.push(step.value.param); return { ...step } }
    return { ...step, value: { text: resolved } }
  })
  return { steps, missing, personSteps }
}

/** procedureSummary(p) -> { id, name, host, stepCount, paramNames, updatedAt } */
export const procedureSummary = p => ({ id: p.id, name: p.name, host: p.start?.host ?? '', stepCount: p.steps?.length ?? 0,
  paramNames: (p.params ?? []).map(param => param.name), updatedAt: p.updatedAt })

const OP_OF_TOOL = Object.freeze({ egdesk_browser_navigate: 'navigate', egdesk_browser_click: 'click', egdesk_browser_pointer_click: 'click', egdesk_browser_fill: 'fill',
  egdesk_browser_select: 'select', egdesk_browser_press: 'press', egdesk_browser_scroll: 'scroll', egdesk_browser_history: 'history' })
const targetOf = expected => record(expected) ? { label: text(expected.label, PROCEDURE_LIMITS.label) || text(expected.role, 40) || 'field',
  ...(expected.role ? { role: text(expected.role, 40) } : {}), ...(expected.tag ? { tag: text(expected.tag, 40) } : {}), ...(expected.href ? { href: expected.href } : {}) } : null
const fieldKey = t => `${t?.role ?? ''}|${t?.tag ?? ''}|${(t?.label ?? '').toLowerCase()}`

/**
 * draftFromJournal(entries, { now, name }) -> Procedure (not saved, no id)
 * entries: the acts of ONE run, oldest first (see the act journal). Failed acts (ok === false) are dropped; a field filled several times keeps its last value.
 */
export function draftFromJournal(entries, { now = Date.now(), name = null, source = null } = {}) {
  const acts = (Array.isArray(entries) ? entries : []).filter(entry => record(entry) && entry.ok !== false && OP_OF_TOOL[entry.tool])
  const steps = []
  const params = []
  const paramName = base => {
    const root = text(base, PROCEDURE_LIMITS.param) || 'field'
    let candidate = root, n = 2
    while (params.some(param => param.name === candidate)) candidate = `${root.slice(0, PROCEDURE_LIMITS.param - 2 - String(n).length)} ${n++}`
    return candidate
  }
  const filled = new Map() // field key -> step
  acts.forEach((entry, index) => {
    const op = OP_OF_TOOL[entry.tool]
    const target = targetOf(entry.expectedTarget)
    if (NEEDS_TARGET.has(op) && !target) return
    if (op === 'fill' || op === 'select') {
      const key = fieldKey(target)
      const prior = filled.get(key)
      const safe = fieldDisplaySafe({ displayValueSafe: entry.displaySafe === true, label: target.label }) && target.role !== 'password'
      if (prior) {
        const param = params.find(p => p.name === prior.value.param)
        if (!param.sensitive) param.default = typeof entry.text === 'string' ? entry.text : param.default
        return
      }
      const pname = paramName(target.label)
      params.push({ name: pname, default: safe ? (typeof entry.text === 'string' ? entry.text : '') : null, sensitive: !safe })
      const step = { id: `s${steps.length + 1}`, op, target, value: { param: pname }, ...(op === 'fill' ? { expect: { kind: 'target-value' } } : {}), ...(safe ? {} : { person: true }) }
      filled.set(key, step); steps.push(step)
      return
    }
    const step = { id: `s${steps.length + 1}`, op }
    if (target) step.target = target
    if (op === 'navigate') { if (!httpUrl(entry.url)) return; step.url = entry.url; step.expect = { kind: 'url', value: entry.url } }
    if (op === 'press') { if (!entry.key) return; step.key = entry.key }
    if (op === 'scroll') { if (!DIRECTIONS.includes(entry.direction)) return; step.direction = entry.direction; if (entry.amount !== undefined) step.amount = entry.amount }
    if (op === 'history') { if (!ACTIONS.includes(entry.action)) return; step.action = entry.action }
    if (op === 'click' || op === 'press') {
      const condition = record(entry.postcondition) ? entry.postcondition : null
      const next = acts[index + 1]
      const navigated = condition?.kind === 'url' || (typeof entry.afterUrl === 'string' && entry.afterUrl !== entry.pageUrl) || (op === 'click' && next && next.pageUrl && next.pageUrl !== entry.pageUrl)
      if (op === 'click') {
        const landed = condition?.kind === 'url' ? condition.value : (entry.afterUrl && entry.afterUrl !== entry.pageUrl ? entry.afterUrl : next?.pageUrl)
        step.expect = navigated && httpUrl(landed) ? { kind: 'url', value: landed } : { kind: 'changed' }
      } else if (condition && ['url', 'visible-text'].includes(condition.kind) && condition.value) step.expect = { kind: condition.kind, value: condition.value }
      const confirm = confirmKindOf(target, entry.facts)
      if (confirm) step.confirm = confirm
    }
    steps.push(step)
  })
  const first = acts[0]
  const startUrl = httpUrl(first?.pageUrl) ? first.pageUrl : (httpUrl(first?.url) ? first.url : '')
  const host = hostOf(startUrl)
  const firstLabel = steps.find(step => step.target?.label)?.target.label ?? ''
  const base = text(first?.pageTitle, 80) || host
  const stamp = ms(now) ? now : Date.now()
  return { version: 1, name: (text(name, PROCEDURE_LIMITS.name) || text(`${base} ${firstLabel}`, PROCEDURE_LIMITS.name) || PROCEDURE_COPY.fallbackName),
    createdAt: stamp, updatedAt: stamp, ...(source ? { source } : {}),
    start: { url: startUrl, host, ...(first?.pageTitle ? { title: text(first.pageTitle, PROCEDURE_LIMITS.label) } : {}) }, params, steps }
}
