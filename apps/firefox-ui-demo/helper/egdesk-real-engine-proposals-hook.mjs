// c33: real-engine check hook for the proposal registry (flag EGDESK_PROPOSAL_REGISTRY). After each turn it waits for the registration to settle and records what the answer left
// open, as defined items. expect.proposals judges it: { kinds: ['proposal', ...] (exactly these, in order), stepsAtLeast, optionsAtLeast, none: true }.
export const PROPOSALS_EXPECT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, minProperties: 1, properties: {
  kinds: { type: 'array', minItems: 1, maxItems: 4, items: { enum: ['proposal', 'person_request', 'waiting_action'] } },
  stepsAtLeast: { type: 'integer', minimum: 1, maximum: 8 }, optionsAtLeast: { type: 'integer', minimum: 2, maximum: 4 }, none: { const: true } } })

export function validateProposalsExpect(expect, { conv = {} } = {}, where = '$.expect.proposals') {
  const out = []
  if (conv.flags?.EGDESK_PROPOSAL_REGISTRY !== 'on') out.push(`${where}: needs flags.EGDESK_PROPOSAL_REGISTRY = "on" in this conversation`)
  if (expect?.none === true && Object.keys(expect).length > 1) out.push(`${where}: none excludes every other key`)
  return out
}

export function judgeProposals(expect, items) {
  const open = Array.isArray(items) ? items : []
  const check = (name, pass, observed) => ({ check: name, ok: pass === true, detail: observed })
  const out = []
  if (expect.none === true) out.push(check('proposals.none', open.length === 0, open.map(i => i.kind)))
  if (expect.kinds) out.push(check('proposals.kinds', JSON.stringify(open.map(i => i.kind)) === JSON.stringify(expect.kinds), open.map(i => i.kind)))
  if (expect.stepsAtLeast) out.push(check('proposals.stepsAtLeast', open.some(i => (i.steps ?? []).length >= expect.stepsAtLeast), open.map(i => (i.steps ?? []).length)))
  if (expect.optionsAtLeast) out.push(check('proposals.optionsAtLeast', open.some(i => (i.options ?? []).length >= expect.optionsAtLeast), open.map(i => (i.options ?? []).length)))
  return out
}

export function createProposalsHook() {
  return {
    async finishTurn(ctx) {
      const chat = ctx.chat?.(), cid = ctx.state().conversationId
      if (!chat || !cid) return { record: null, expectations: [] }
      await chat.proposalRegistryIdle?.()
      const items = (chat.openItemsFor?.(cid) ?? []).filter(i => i.provider === 'proposals')
      return { record: { items: items.map(i => ({ kind: i.kind, text: String(i.text).slice(0, 200), steps: (i.steps ?? []).map(s => s.text), options: (i.options ?? []).map(o => o.text) })) },
        expectations: ctx.expect?.proposals ? judgeProposals(ctx.expect.proposals, items) : [] }
    },
  }
}
