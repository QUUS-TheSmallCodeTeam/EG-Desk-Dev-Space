// u1: real-engine check hook for the order of a turn (U13: memory/action -> engine -> check). After each turn it records the stages the runtime marked for that turn's request
// (names only, in the order marked, plus whether the times never go backwards) and judges expect.stages = { order: [...] } (exactly these stages in this order) or { includes: [...] }.
// An expectation that cannot be evaluated FAILS (the lesson of the proposals hook: a hook whose result is never read must not let a check pass).
import { TURN_STAGES } from './egdesk-upper-bundle.mjs'

export const STAGES_EXPECT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false, minProperties: 1, properties: {
  order: { type: 'array', minItems: 1, maxItems: 4, items: { enum: [...TURN_STAGES] } }, includes: { type: 'array', minItems: 1, maxItems: 4, items: { enum: [...TURN_STAGES] } } } })

export function validateStagesExpect(expect, where = '$.expect.stages') {
  return expect?.order !== undefined && expect?.includes !== undefined ? [`${where}: order and includes exclude each other`] : []
}

export function judgeStages(expect, stages) {
  const names = (stages ?? []).map(s => s.stage), out = [], put = (check, ok, detail) => out.push({ check, ok: ok === true, detail })
  if (expect.order) put('stages.order', JSON.stringify(names) === JSON.stringify(expect.order), { wanted: expect.order, seen: names })
  if (expect.includes) put('stages.includes', expect.includes.every(s => names.includes(s)), { wanted: expect.includes, seen: names })
  put('stages.inTimeOrder', (stages ?? []).every((s, i) => i === 0 || s.at >= stages[i - 1].at), { seen: names })
  return out
}

export function createStagesHook() {
  let chat = null
  return {
    attach: deps => { chat = deps.chat ?? null },
    async afterTurn(ctx) {
      const want = ctx.expect?.stages, requestId = ctx.run?.requestId
      if (!chat || typeof chat.turnStagesFor !== 'function' || !requestId) return want ? { record: null, expectations: [{ check: 'stages.evaluated', ok: false, detail: { why: !chat ? 'no runtime attached' : 'no request id' } }] } : null
      const stages = chat.turnStagesFor(requestId)
      return { record: { stages: stages.map(s => s.stage), inTimeOrder: stages.every((s, i) => i === 0 || s.at >= stages[i - 1].at) }, expectations: want ? judgeStages(want, stages) : [] }
    },
  }
}
