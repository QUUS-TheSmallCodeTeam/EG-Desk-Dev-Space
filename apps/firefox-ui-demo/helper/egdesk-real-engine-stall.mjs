// c33: the check's view of the first-event watchdog (registered in helper/egdesk-real-engine-registrations.mjs, slot L5). The record of every turn carries firstEventMs (from the turn/start
// answer to the first event of the conversation's thread; 0 when it came before the answer): across N turns of a real run that is the data N is chosen from. turn.expect.engineStall:
//   { stalled: boolean, recovered?: true, maxFirstEventMs?: integer }   stalled false: the watchdog never fired for this turn (no false positive); true + recovered: it fired, the retry worked
export const STALL_EXPECT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, minProperties: 1, properties: { stalled: { type: 'boolean' }, recovered: { const: true }, maxFirstEventMs: { type: 'integer', minimum: 1, maximum: 600000 } } })

export function validateStallExpect(value, conv, turn, where = '$.expect.engineStall') {
  const errors = []
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) return [`${where}: an object with at least one of stalled, recovered, maxFirstEventMs`]
  for (const key of Object.keys(value)) if (!['stalled', 'recovered', 'maxFirstEventMs'].includes(key)) errors.push(`${where}.${key}: unknown key`)
  if (value.stalled !== undefined && typeof value.stalled !== 'boolean') errors.push(`${where}.stalled: a boolean`)
  if (value.recovered === true && value.stalled !== true) errors.push(`${where}.recovered: needs stalled: true`)
  if (turn.action !== undefined) errors.push(`${where}: only on a message turn`)
  if ((value.stalled === true || value.recovered === true) && !/^\d{4,6}$/.test(conv.flags?.EGDESK_ENGINE_STALL_FIRST_EVENT_MS ?? '')) errors.push(`${where}: needs flags.EGDESK_ENGINE_STALL_FIRST_EVENT_MS in this conversation (the watchdog is off without it)`)
  return errors
}

export function checkStall(expect, record) {
  const out = [], put = (check, ok, detail) => out.push({ check: `engineStall.${check}`, ok: ok === true, detail })
  const fact = record?.fact ?? null
  if (expect.stalled !== undefined) put('stalled', (fact !== null) === expect.stalled, { stalled: fact !== null, outcome: fact?.outcome ?? null })
  if (expect.recovered) put('recovered', fact?.recovered === true, { outcome: fact?.outcome ?? null, count: fact?.count ?? null })
  if (expect.maxFirstEventMs !== undefined) put('maxFirstEventMs', Number.isFinite(record?.firstEventMs) && record.firstEventMs <= expect.maxFirstEventMs, { wanted: expect.maxFirstEventMs, firstEventMs: record?.firstEventMs ?? null })
  return out
}

export function createStallHook() {
  let deps = null
  return {
    attach(d) { deps = d },
    async afterTurn(ctx) {
      if (!ctx.expect?.engineStall || !deps) return null
      const run = deps.chat.runFor(ctx.run), fact = run?.engineStall ? { ...run.engineStall } : null, firstEventMs = ctx.firstEventMs ?? null
      return { record: { fact, firstEventMs }, expectations: checkStall(ctx.expect.engineStall, { fact, firstEventMs }) }
    },
  }
}
