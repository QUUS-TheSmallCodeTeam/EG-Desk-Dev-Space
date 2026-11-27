#!/usr/bin/env node
// The re-check of the mid-session scan with the new line "the previous reply was given with these held pages" (L7 c17), as a declarative
// plan for the generic runner (scripts/egdesk-decision-real-measure.mjs). It only writes files; it never sends.
//   node scripts/egdesk-referent-plan.mjs <dir>
// 1. s2-followup-scan: the s2 scan of the all-on journey rebuilt on the product path (L2's world, the bridge's wiring, the same graph):
//    "방금 그 내용 정리해줘" after the A사 answer. Every PostgreSQL page must now be a decided no (the real run: 0.90 / 0.98 picked).
// 2. pg-mid-scan (control): the c10 pg-mid case with the line naming the held plan pages; the health and follow-up checklists must still be
//    picked (the line must not suppress what the next judgment needs; real before: 0.99 / 0.98).
// 3. j-mid-scan (control): "아까 jev hook 흐름 다시 정리해줘" holding the draft and an utterance; the flow note is not held and must be picked.
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { allOnWorld } from './egdesk-all-on.support.mjs'
import { DECISION_MODEL } from '../helper/egdesk-decision-client.mjs'
import { buildWiki, reconstructMemory } from '../helper/egdesk-wiki-reconstruction.mjs'
import { SYNTHETIC_PAGES } from '../helper/egdesk-wiki-reconstruction.fixture.mjs'

const dir = process.argv[2]
if (!dir) { console.error('usage: egdesk-referent-plan.mjs <output directory>'); process.exit(2) }
const sha = b => createHash('sha256').update(b).digest('hex')
const est = (q, bytes) => Math.round(134.8 * q + 0.1983 * bytes)
const aliases = body => Object.fromEntries([...JSON.stringify(body.input).matchAll(/(P\d+) \| [^|]*\| [^|]*\| rev=[^|]*\| ([^\\]+)\\n/g)].map(m => [m[1], m[2]]))
const ASKED = Date.parse('2026-11-24T14:30:00+09:00'), SCOPE = { allowedScopes: ['dm:this-room'] }
const hash = s => createHash('sha256').update(s).digest('hex')
const receipts = (wiki, ids) => ({ usable: true, pages: Object.fromEntries(ids.map(id => [id, { revision: wiki.pages.get(id).revision, hash: wiki.pages.get(id).contentKey ?? hash(wiki.pages.get(id).body) }])) })

async function scanOfPure(message, held) {
  const wiki = buildWiki(SYNTHETIC_PAGES)
  let body = null
  await reconstructMemory({ message, wiki, scope: SCOPE, askedAt: ASKED, delivered: receipts(wiki, held), mode: 'next', previous: held, budget: { linksFirst: true }, // the bridge config's budget
    client: { async decide(r) { if (!body && r.questions.some(q => q.name.startsWith('pg_'))) body = { model: DECISION_MODEL, input: r.input, questions: r.questions }; return { answers: {} } } } })
  return body
}
async function scanOfJourney() {
  const cleanups = [], t = { after: fn => cleanups.push(fn) }
  try {
    const w = allOnWorld(t)
    await w.settings.turnMemory.save('on')
    w.step('s1'); await w.send('지난주 A사 견적 건 어디까지 됐지?'); await w.idle(); await w.advance(3000); await w.answer('A사 견적은 v1 발송 후 v2 수정 계획 단계이며 팀장 승인 후 발송 예정입니다.'); await w.idle()
    w.step('s2'); await w.send('방금 그 내용 정리해줘'); await w.idle()
    const raw = w.decisionsIn('s2').find(d => d.feature === 'memory_fetch')?.raw
    if (!raw) throw new Error('no s2 scan was built')
    const parsed = JSON.parse(raw)
    return { model: DECISION_MODEL, input: parsed.input, questions: parsed.questions }
  } finally { for (const fn of cleanups.reverse()) { try { fn() } catch {} } }
}
const byTitle = (body, pred) => Object.entries(aliases(body)).filter(([, title]) => pred(title)).map(([alias]) => `pg_${Number(alias.slice(1)) - 1}`)
const cases = []
{
  const body = await scanOfJourney()
  const pg = byTitle(body, t => /PostgreSQL|SQLite|헬스체크|롤백|벤치마크|후속 체크리스트/.test(t))
  cases.push({ id: 's2-followup-scan', body, expect: pg.map(name => ({ name, kind: 'predicate', max: 0.2, severity: 'hard', note: 'a page of another matter: the follow-up points back to the A사 reply, given with the held A사 pages' })) })
}
{
  const body = await scanOfPure('PostgreSQL 마이그레이션 배포 끝났어', ['db/pg-design', 'db/pg-plan', 'db/pg-rollback', 'db/sqlite-schema'])
  cases.push({ id: 'pg-mid-scan', body, expect: [...byTitle(body, t => t === '헬스체크 3종 체크리스트'), ...byTitle(body, t => t === '배포 후 후속 체크리스트')].map(name => ({ name, kind: 'predicate', min: 0.8, severity: 'hard', note: 'control: what the next judgment needs is still picked although the held pages are named' })) })
}
{
  const body = await scanOfPure('아까 jev hook 흐름 다시 정리해줘', ['jev/draft', 'jev/utt-user'])
  cases.push({ id: 'j-mid-scan', body, expect: byTitle(body, t => t.startsWith('jev hook 흐름 메모')).map(name => ({ name, kind: 'predicate', min: 0.8, severity: 'hard', note: 'control: the earlier material asked for is not held and must still be picked' })) })
}
mkdirSync(path.join(dir, 'requests'), { recursive: true })
const requests = cases.map(c => {
  if (!c.expect.length) throw new Error(`${c.id}: no expectation could be registered`)
  const bytes = Buffer.from(JSON.stringify(c.body), 'utf8'), file = `requests/${c.id}.json`
  writeFileSync(path.join(dir, file), bytes)
  return { id: c.id, file, sha256: sha(bytes), estInputTokens: est(c.body.questions.length, bytes.length), expect: c.expect }
})
const total = requests.reduce((n, r) => n + r.estInputTokens, 0)
const plan = { set: 'mid-scan-previous-reply-v1', tokenCeiling: Math.ceil(total * 1.15 / 100) * 100,
  passRule: 'Every request passes (no failed hard check): the referential follow-up picks no page of another matter, and both controls still pick what the next judgment needs. The bars are the product\'s (yes >= 0.8, no <= 0.2).', requests }
writeFileSync(path.join(dir, 'plan.json'), `${JSON.stringify(plan, null, 1)}\n`)
console.log(JSON.stringify({ set: plan.set, requests: requests.map(r => ({ id: r.id, estInputTokens: r.estInputTokens, sha: r.sha256.slice(0, 12), hard: r.expect.length })), estInputTokens: total, tokenCeiling: plan.tokenCeiling }))
process.exit(0)
