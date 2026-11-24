#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { independentEstimate } from '../helper/egdesk-decision-real-runner.mjs'
import { NO, YES } from '../helper/egdesk-wiki-reconstruction.mjs'
import { allOnWorld } from './egdesk-all-on.support.mjs'

// The previous assistant message in the turn-memory triage (L7 c22, owner rule U9; flag EGDESK_TURN_MEMORY_PREVIOUS_REPLY=on). PREPARED, NOT
// SENT: never sends, never reads a key. Two of lane L3's real cases (c20 scenarios, real c25 answers WITHOUT the previous message):
//   approval  "ㅇㅇ" after a reply ending "다음은 7번(효과 미리보기) … 계속 갈까요?"          c25: tn_courtesy .99 (read as small talk)
//   praise    "좋다. 다음 진행" after a reply ending "OK면 … 8번(시스템 구조도) 갑니다."    c25: tn_courtesy .05, tn_need .81
// Each request is the product's own triage body for that turn, replayed in lane L2's all-on world (draft check off, so the assistant message
// is stored as written) after the real assistant message, with the flag on. The texts are the person's own conversation (masked by L3), so the
// plan is written OUTSIDE the repository: usage  node scripts/egdesk-previous-reply-plan.mjs <L3 mock-results.json> <out dir>
// Pre-registered (HARD, product bars .8 / .2): approval tn_courtesy <= .2 (a go-ahead answering a proposal decides something);
// praise tn_need <= .2 (the next step is the next slide, which none of the stored pages is about) and tn_courtesy <= .2. SOFT: approval tn_need <= .2.
// The turn context is not in this plan (a 12-item request is about 2,500 tokens; the 4k cap holds the two triage requests).
export const PREVIOUS_REPLY_CASES = Object.freeze({
  '4d0c2160293f207f': { id: 'approval', expect: [
    { name: 'tn_courtesy', kind: 'predicate', max: NO, severity: 'hard', note: 'a go-ahead answering the assistant\'s "계속 갈까요?" (c25 without it: .99)' },
    { name: 'tn_need', kind: 'predicate', max: NO, severity: 'soft', note: 'continuing the slide deck needs none of the stored pages' }] },
  '0a1621521ec4364b': { id: 'praise', expect: [
    { name: 'tn_need', kind: 'predicate', max: NO, severity: 'hard', note: 'the next step is slide 8, which no stored page is about (c25 without the previous message: .81)' },
    { name: 'tn_courtesy', kind: 'predicate', max: NO, severity: 'hard', note: 'a go-ahead, not only praise (c25: .05)' }] },
})
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

export async function triageBodyAfter({ before, prev, user }) {
  const cleanups = [], t = { after: fn => cleanups.push(fn) }
  try {
    const w = allOnWorld(t, { env: { EGDESK_TURN_MEMORY_PREVIOUS_REPLY: 'on', EGDESK_DRAFT_CHECK: 'off' } })
    await w.settings.turnMemory.save('on')
    w.step('before'); await w.send(before); await w.idle(); await w.answer(prev); await w.idle()
    w.step('turn'); await w.send(user); await w.idle()
    const rows = w.decisionsIn('turn').filter(d => /"tn_need"/.test(d.raw))
    if (rows.length !== 1) throw new Error(`expected one triage request, got ${rows.length}`)
    return rows[0].raw
  } finally { for (const fn of cleanups.reverse()) { try { fn() } catch { /* cleanup */ } } }
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('egdesk-previous-reply-plan.mjs')) {
  const [examplesFile, outDir] = process.argv.slice(2)
  const examples = Object.values(JSON.parse(readFileSync(examplesFile, 'utf8'))).map(r => r.example).filter(e => e && PREVIOUS_REPLY_CASES[e.id])
  const requests = []
  for (const e of examples) {
    const c = PREVIOUS_REPLY_CASES[e.id], body = await triageBodyAfter({ before: e.before, prev: e.prev, user: e.user })
    const wire = JSON.parse(body)
    if (!wire.input.some(m => typeof m.content === 'string' && m.content.startsWith('The assistant\'s message right before this one'))) throw new Error(`${c.id}: no previous message in the body`)
    const bytes = Buffer.from(body, 'utf8'), file = `requests/${c.id}.json`
    mkdirSync(path.join(outDir, 'requests'), { recursive: true }); writeFileSync(path.join(outDir, file), bytes)
    requests.push({ id: c.id, file, sha256: sha(bytes), estInputTokens: independentEstimate(0, wire.questions.length, bytes.length), expect: c.expect })
  }
  const est = requests.reduce((n, r) => n + r.estInputTokens, 0)
  if (requests.length !== 2 || est > 4000) throw new Error(`${requests.length} requests, ${est} estimated tokens`)
  const bars = { yes: YES, no: NO, source: 'egdesk-wiki-reconstruction.mjs ternary YES / NO (.8 / .2): the triage acts on a decided yes or no' }
  const plan = { set: 'previous-reply-v1', tokenCeiling: 4000, productBars: { tn_courtesy: bars, tn_need: bars },
    passRule: 'Every hard check passes: with the assistant message right before the turn, "ㅇㅇ" is not read as small talk and "좋다. 다음 진행" is not read as needing stored pages. Product-built triage bodies (lane L2 all-on world, flag EGDESK_TURN_MEMORY_PREVIOUS_REPLY=on), the real assistant messages of L3 c20.', requests }
  writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n')
  console.log(`written: ${requests.length} requests (${requests.map(r => `${r.id}:${r.estInputTokens}`).join(' ')}), est ${est} of 4000 -> ${outDir}`)
}
