// L1 c32: the open-item resolver (helper/egdesk-open-items.mjs) in the real-engine check, through the extension API (registered in helper/egdesk-real-engine-registrations.mjs).
// A conversation turns it on with  "flags": { "EGDESK_OPEN_ITEMS": "on" }  (needs --decisions). A turn may carry
//   "expect": { "openItems": { "settled": "approval" | "none" | "<kind>", "reason": "<word>" | ["<word>", …], "approvalWaiting": true|false, "maxResolverMs": n } }
//   settled          the kind of the open item the Decision model said this message settles, or none (nothing settled, the item stays open);
//   reason           for none: why (no_item_referred, several_items, unanswered, ...);
//   approvalWaiting  after the turn, the command-approval broker still holds the waiting question (true: the message did not consume it);
//   maxResolverMs    the resolver's one Decision request took at most this many ms.
// The turn record carries openItems = { flag, status, reason, kind, id, p, calls, resolverMs, items, states, today, seconds, engineTurns, approvalWaiting, commandsRan } for every turn of a
// conversation with the flag on, and for a turn that expects it, so the same dialogue with the flag off can be compared (scripts/egdesk-open-items-compare.mjs).
export const OPEN_FLAG = 'EGDESK_OPEN_ITEMS'
const WORD = /^[a-z][a-z_]{2,39}$/
const KINDS = ['approval', 'question', 'browser_task', 'run', 'memory', 'none']
export const OPEN_EXPECT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, minProperties: 1, properties: {
  settled: { enum: KINDS }, reason: { anyOf: [{ type: 'string', pattern: WORD.source }, { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', pattern: WORD.source } }] },
  approvalWaiting: { type: 'boolean' }, maxResolverMs: { type: 'number', exclusiveMinimum: 0, maximum: 60000 } } })
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

/** validateOpenExpect(value, conv, turn, where) → ['<where>: <reason>'] */
export function validateOpenExpect(value, conv, turn, where = '$.expect.openItems') {
  const errors = [], bad = (at, why) => errors.push(`${at}: ${why}`)
  if (!isObject(value)) return [`${where}: an object`]
  for (const k of Object.keys(value)) if (!Object.keys(OPEN_EXPECT_SCHEMA.properties).includes(k)) bad(`${where}.${k}`, 'unknown key')
  if (value.settled !== undefined && !KINDS.includes(value.settled)) bad(`${where}.settled`, `one of ${KINDS.join(' / ')}`)
  if (value.approvalWaiting !== undefined && typeof value.approvalWaiting !== 'boolean') bad(`${where}.approvalWaiting`, 'true or false')
  if (value.maxResolverMs !== undefined && !(typeof value.maxResolverMs === 'number' && value.maxResolverMs > 0 && value.maxResolverMs <= 60000)) bad(`${where}.maxResolverMs`, 'milliseconds, 1 to 60000')
  for (const r of [].concat(value.reason ?? [])) if (typeof r !== 'string' || !WORD.test(r)) bad(`${where}.reason`, 'closed words like no_item_referred')
  if (conv.flags?.[OPEN_FLAG] !== 'on') bad(where, `needs flags.${OPEN_FLAG} = "on" in this conversation`)
  if (turn.whileRunning !== undefined || turn.action !== undefined) bad(where, 'not checked on a whileRunning or action turn')
  if (value.reason !== undefined && value.settled !== 'none') bad(`${where}.reason`, 'a reason is why nothing was settled: it belongs to settled: "none"')
  return errors
}

export function createOpenItemsHook(conversation) {
  let chat = null, starts = 0, rec = null, waiting = null, ran = []
  const on = conversation?.flags?.[OPEN_FLAG] === 'on'
  return {
    attach: deps => { chat = deps.chat },
    observe: method => { if (method === 'turn/start') starts += 1 },
    beginTurn: () => { starts = 0; rec = null; waiting = null; ran = [] },
    afterTurn: ctx => {
      try { rec = chat.openItemRecord(ctx.run?.requestId) } catch { rec = null }
      try { waiting = chat.gateHookBroker()?.awaitingReply(ctx.run?.conversationId) ?? null } catch { waiting = null }
      return null
    },
    finishTurn: ctx => {
      const want = ctx.expect?.openItems
      if (!on && !want) return null
      const record = { flag: on, status: rec?.status ?? 'none', reason: rec ? rec.reason : 'no_items', kind: rec?.kind ?? null, id: rec?.id ?? null, p: rec?.p ?? null, calls: rec?.calls ?? 0, resolverMs: rec?.ms ?? null,
        items: rec?.items ?? [], states: rec?.states ?? {}, today: rec?.today ?? null, seconds: Number.isFinite(ctx.latencyMs) ? Math.round(ctx.latencyMs / 100) / 10 : null, engineTurns: starts, approvalWaiting: waiting }
      const expectations = [], put = (check, ok, detail) => expectations.push({ check: `openItems.${check}`, ok, detail })
      if (want?.settled !== undefined) put('settled', (record.status === 'settled' ? record.kind : 'none') === want.settled, { status: record.status, kind: record.kind, reason: record.reason })
      if (want?.reason !== undefined) put('reason', record.status === 'none' && [].concat(want.reason).includes(record.reason), { reason: record.reason, wanted: [].concat(want.reason) })
      if (want?.approvalWaiting !== undefined) put('approvalWaiting', record.approvalWaiting === want.approvalWaiting, { approvalWaiting: record.approvalWaiting })
      if (want?.maxResolverMs !== undefined) put('maxResolverMs', record.resolverMs !== null && record.resolverMs <= want.maxResolverMs, { resolverMs: record.resolverMs, max: want.maxResolverMs })
      return { record, expectations }
    },
  }
}
