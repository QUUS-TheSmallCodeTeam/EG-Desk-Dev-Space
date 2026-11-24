import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { main as seedsMain } from '../scripts/egdesk-scenario-seeds.mjs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TAEHWA_ALLOWED, SOURCE_APPROVALS, buildManifest, extractDev, extractTaehwa, iGa, iYa, maskSecrets, namesMasked, parseGitMerges, privacyOf, secretsIn, seedGraph, validateSeed } from './egdesk-scenario-seeds.mjs'
import { createSeedGuard, seedFingerprints, seedRefusal } from './egdesk-scenario-seed-guard.mjs'
import { SEED_GIT_LOG, SEED_LOOP, SEED_REPO, listOf } from './egdesk-scenario-seeds.fixture.mjs'
import { createGuardedFetch } from './egdesk-memory-live-runner.mjs'
import { main as realRunnerMain } from './egdesk-decision-real-runner.mjs'
import { DECISION_MODEL } from './egdesk-decision-client.mjs'

const app = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const taehwa = (extra = {}) => { const read = []; const seeds = extractTaehwa({ read: f => { read.push(f); if (!(f in SEED_REPO)) throw new Error(`no fixture ${f}`); return SEED_REPO[f] }, ...extra }); return { seeds, read } }
const dev = (extra = {}) => extractDev({ readRepo: f => SEED_REPO[f], listRepo: listOf(SEED_REPO), readLoop: f => SEED_LOOP[f], listLoop: listOf(SEED_LOOP), gitMerges: parseGitMerges(SEED_GIT_LOG), ...extra })
const seed = (list, id) => list.find(s => s.id === id)

test('taehwa-ontology: only the named files are read; cases are dated evidence of their as-of date, unknown claims stay unknown, packets promoted', () => {
  const { seeds, read } = taehwa()
  assert.deepEqual([...new Set(read)].sort(), [...TAEHWA_ALLOWED].sort())
  assert.deepEqual(seeds.map(s => s.id), ['taehwa/ecs-07', 'taehwa/rws-0026', 'taehwa/rws-0027', 'taehwa/rws-0010', 'taehwa/company-server'])
  for (const s of seeds) { assert.deepEqual(validateSeed(s), [], s.id); assert.equal(s.privacy, 'owner-approved'); assert.ok(s.expectations.length && s.expectations.every(e => e.status === 'proposed')) }
  const c27 = seed(seeds, 'taehwa/rws-0027')
  assert.ok(c27.pages.every(p => p.time.slice === 'past' && p.time.at === '2026-08-13'), 'never present: the case is evidence of its date')
  assert.equal(c27.pages.find(p => p.id === 'taehwa/rws-0027/c03').status, 'unknown')
  assert.equal(c27.pages.find(p => p.id === 'taehwa/rws-0027/c01').status, 'done')
  assert.match(c27.pages.find(p => p.id === 'taehwa/rws-0027/c03').body, /\[email\], \[phone\]/, 'secrets masked, the rest kept')
  assert.deepEqual(c27.facts.find(f => f.change === 'candidate->promoted'), { id: 'ORG-SD04->RWS-0027', subject: 'ORG-SD04', change: 'candidate->promoted', at: '2026-08-31', text: 'ORG-SD04 이관 재감사: PROMOTED(RWS-0027)',
    provenance: { source: 'taehwa-ontology', file: TAEHWA_ALLOWED[1], line: 9 } })
  assert.ok(!JSON.stringify(seeds).includes('RWS-0099'), 'an index row of another case is not taken')
  assert.equal(c27.pages.find(p => p.id === 'taehwa/rws-0027/c01').source.line, 21)
  assert.deepEqual(c27.turns.map(t => t.type), ['recall', 'referential', 'governance'])
  assert.equal(c27.expectations.find(e => e.kind === 'answer_avoids').pages[0], 'taehwa/rws-0027/c03')
  const c10 = seed(seeds, 'taehwa/rws-0010')
  assert.equal(c10.pages.find(p => p.id === 'taehwa/rws-0010/c02').body, 'handoff에는 packet이 필요하다.', 'a claim continued on the next line')
  assert.equal(c10.facts.find(f => f.subject === 'ORG-SD03').change, 'candidate->merged')
  const ecs = seed(seeds, 'taehwa/ecs-07')
  assert.equal(ecs.pages.filter(p => /^taehwa\/ecs-07\/\d+$/.test(p.id)).length, 3)
  assert.deepEqual(ecs.turns.map(t => t.text).slice(-2), ['RWS-0026 결과가 뭐였지?', '아니 그거 RWS-0026이 아니라 RWS-0027이야'], 'both cited cases (the second on a continued line)')
  assert.ok(ecs.rules.some(r => /현재 조직 상태로 주장하지 않는다/.test(r.text)))
  assert.ok(ecs.expectations.some(e => e.kind === 'no_promotion'), 'nothing auto-promotes')
  const server = seed(seeds, 'taehwa/company-server')
  assert.deepEqual(server.pages.map(p => [p.id, p.time.slice, p.status]), [['taehwa/company-server/future', 'planned', 'plan'], ['taehwa/company-server/present', 'present', 'done']])
  assert.deepEqual(seedGraph(server).edges, [{ source: 'taehwa/company-server/future', target: 'taehwa/company-server/present', relation: 'follows_from' }])
})

test('egdesk-dev: merges are dated facts with their commit; a status remark plays against the page before the merge, then the correction; gap rows and rules', () => {
  const seeds = dev()
  assert.deepEqual(seeds.map(s => s.id), ['egdesk/l3', 'egdesk/l5', 'egdesk/gap-ledger', 'egdesk/philosophy'])
  for (const s of seeds) { assert.deepEqual(validateSeed(s), [], s.id); assert.equal(s.privacy, 'owner-approved') }
  const l3 = seed(seeds, 'egdesk/l3')
  assert.deepEqual(l3.facts.filter(f => f.change === 'planned->done').map(f => [f.subject, f.at, f.commit]), [['L3 c1', '2026-11-24T20:10:00+09:00', 'aaaa1110000000000000000000000000000000000'], ['L3 c2', '2026-11-24T21:00:00+09:00', 'bbbb2220000000000000000000000000000000000']])
  assert.deepEqual(l3.pages.map(p => [p.id, p.status]), [['egdesk/l3/c1', 'done'], ['egdesk/l3/c2', 'plan']], 'c2 as it stood before its merge')
  assert.ok(!l3.pages[1].body.includes('병합'), 'the remark brings the merge')
  assert.deepEqual(l3.turns.map(t => t.text), ['L3 c1 병합됐어', '그거 c1이 아니라 c2야', 'L3 c2 결과가 뭐였지?', '방금 그 내용 정리해줘'])
  assert.ok(l3.facts.some(f => f.change === 'candidate' && f.text === '둘째 결정 요청.'))
  assert.equal(seed(seeds, 'egdesk/l5').pages[0].status, 'unknown', 'a report with no merge recorded: unknown, not planned')
  const gap = seed(seeds, 'egdesk/gap-ledger')
  assert.deepEqual(gap.facts.map(f => [f.subject, f.at, f.change, f.commits]), [['ABC-02', '2026-11-17', 'plan->plan', ['bbbbbbb']], ['ABC-01', '2026-11-18', 'plan->done', ['aaaaaaa']]])
  assert.deepEqual(gap.turns.map(t => t.text), ['ABC-01 어떻게 됐지?', '방금 그 내용 정리해줘'])
  assert.deepEqual(seed(seeds, 'egdesk/philosophy').turns.map(t => t.text), ['U1이 뭐였지?', '아 그거 U1이 아니라 U4야'])
  assert.throws(() => extractDev({ readRepo: () => '', listRepo: () => ['../x.md'], readLoop: f => SEED_LOOP[f], listLoop: listOf(SEED_LOOP) }), /not an egdesk-dev repo source/)
  assert.deepEqual([iGa('c19'), iYa('c20'), iGa('RWS-0026'), iYa('RWS-0027')], ['c19가', 'c20이야', 'RWS-0026이', 'RWS-0027이야'])
})

test('continuity: same sources, same bytes; the manifest reports new / changed / unchanged; --since keeps only newer facts and carries the rest', () => {
  const a = [...taehwa().seeds, ...dev()], b = [...taehwa().seeds, ...dev()]
  assert.equal(JSON.stringify(a), JSON.stringify(b))
  const first = buildManifest({ seeds: a, sources: { files: {} } })
  assert.equal(first.changes.new.length, a.length)
  const again = buildManifest({ seeds: b, sources: { files: {} }, previous: first.manifest })
  assert.deepEqual([again.changes.new, again.changes.changed, again.changes.removed, again.changes.unchanged], [[], [], [], a.length])
  const edited = extractDev({ readRepo: f => SEED_REPO[f], listRepo: listOf(SEED_REPO), readLoop: f => (f === 'reports/l3-c2.md' ? SEED_LOOP[f].replace('셋째', '넷째') : SEED_LOOP[f]), listLoop: listOf(SEED_LOOP), gitMerges: parseGitMerges(SEED_GIT_LOG) })
  const third = buildManifest({ seeds: [...taehwa().seeds, ...edited], sources: { files: {} }, previous: first.manifest })
  assert.deepEqual(third.changes.changed, ['egdesk/l3|original'])
  const since = dev({ since: '2026-11-24T20:30:00+09:00' })
  assert.deepEqual(since.map(s => s.id), ['egdesk/l3', 'egdesk/l5'])
  assert.deepEqual(seed(since, 'egdesk/l3').pages.map(p => p.id), ['egdesk/l3/c2'], 'only the cycle with a newer event')
  assert.deepEqual(taehwa({ since: '2026-09-01' }).seeds, [], 'nothing of the cases is newer')
  const carried = buildManifest({ seeds: since, sources: { files: {} }, previous: first.manifest, since: '2026-11-24T20:30:00+09:00' })
  assert.equal(carried.manifest.seeds.length, first.manifest.seeds.length, 'the others keep their entry')
  assert.deepEqual(carried.changes.removed, [])
  assert.equal(first.manifest.approvals['taehwa-ontology'], SOURCE_APPROVALS['taehwa-ontology'])
})

test('privacy: owner-approved only when every provenance is a file or commit of its approved source; secrets are masked, names stay', () => {
  const s = seed(taehwa().seeds, 'taehwa/rws-0026')
  assert.equal(privacyOf(s), 'owner-approved')
  assert.equal(privacyOf({ ...s, pages: [...s.pages, { ...s.pages[0], source: { source: 'taehwa-ontology', file: 'docs/references/real-work-scenarios/cases/rws-0029-mail.md', line: 1 } }] }), 'local-only')
  assert.equal(privacyOf({ ...s, facts: [...s.facts, { ...s.facts[0], provenance: { source: 'taehwa-ontology', file: '/Users/x/Projects/Taehwa_Gmail_PoC/mail.sql', line: 1 } }] }), 'local-only')
  assert.equal(privacyOf({ ...s, source: 'other' }), 'local-only')
  const text = '태화트랜스 담당 kim@example.co.kr, 010-2345-6789, sk-proj-abcdefghijklmnop1234, https://x.example/a?token=1, account_id: AB12CD34, Bearer: xyz'
  const masked = maskSecrets(text)
  assert.equal(masked, '태화트랜스 담당 [email], [phone], [key], [url], [account], [token]')
  assert.deepEqual(secretsIn(masked), [])
  assert.deepEqual(secretsIn(text).sort(), ['[account]', '[email]', '[key]', '[phone]', '[token]', '[url]'])
  assert.ok(validateSeed({ ...s, pages: [{ ...s.pages[0], body: 'mail kim@example.com' }] }).some(p => /unmasked secret/.test(p)))
  const named = namesMasked({ ...s, title: '태화트랜스 사례' })
  assert.equal(named.title, '[조직A] 사례'); assert.equal(named.variant, 'names-masked'); assert.equal(named.privacy, s.privacy)
})

const localSeed = () => { const s = seed(taehwa().seeds, 'taehwa/rws-0027'); return { ...s, privacy: 'local-only' } }
const bodyWith = text => JSON.stringify({ model: DECISION_MODEL, input: [{ role: 'developer', content: 'Judge the sentence.' }, { role: 'user', content: `Evidence:\n"""\n${text}\n"""` }], questions: [{ type: 'predicate', name: 'sup_0', instructions: 'Does the evidence say what sentence S1 says?' }] })

test('guard: a body carrying a local-only seed is refused; an owner-approved one passes unless a secret is left; declarations are checked', () => {
  const approved = seed(taehwa().seeds, 'taehwa/rws-0026'), local = localSeed()
  const guard = createSeedGuard([{ id: approved.id, variant: 'original', privacy: approved.privacy, prints: seedFingerprints(approved) }, { id: local.id, variant: 'original', privacy: 'local-only', prints: seedFingerprints(local) }])
  assert.match(guard.check(bodyWith(`잘린 인용: ${local.pages.find(p => p.id === 'taehwa/rws-0027/c02').body}`)), /local-only scenario seed taehwa\/rws-0027/)
  assert.match(guard.check(bodyWith('RWS-0027-C02 [OBSERVED]')), /local-only/, 'a short unit (a title) is matched whole')
  assert.equal(guard.check(bodyWith(approved.pages.find(p => p.id === 'taehwa/rws-0026/c01').body)), null)
  assert.match(guard.check(bodyWith(`${approved.pages.find(p => p.id === 'taehwa/rws-0026/c01').body} 연락: lee@example.com`)), /still holds \[email\]/)
  assert.equal(guard.check(bodyWith('A사 견적서 v1 발송 11월 6일 단가 12,800원으로 견적서 v1을 발송했다.')), null, 'unrelated synthetic material')
  assert.match(guard.check(bodyWith('x'), [{ id: 'taehwa/rws-0027', privacy: 'local-only' }]), /only owner-approved/)
  assert.match(guard.check(bodyWith('x'), [{ id: 'taehwa/rws-0027', privacy: 'owner-approved' }]), /the manifest says local-only/)
  assert.equal(seedRefusal(bodyWith('x'), { declared: [{ id: 'z', privacy: 'owner-approved' }], guard: null }), null)
  assert.match(seedRefusal(bodyWith('x'), { declared: [{ id: 'z' }], guard: null }), /privacy none/)
})

test('runners: the plan runner refuses a plan built from a local-only seed (dry run too); the live runner\'s fetch refuses it before the network', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-seed-guard-')); t.after(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.EGDESK_SCENARIO_SEEDS })
  const local = localSeed(), seedsDir = path.join(dir, 'seeds'); mkdirSync(seedsDir)
  writeFileSync(path.join(seedsDir, 'manifest.json'), JSON.stringify({ seeds: [{ id: local.id, variant: 'original', privacy: 'local-only' }] }))
  writeFileSync(path.join(seedsDir, 'fingerprints.json'), JSON.stringify({ [`${local.id}|original`]: seedFingerprints(local) }))
  process.env.EGDESK_SCENARIO_SEEDS = seedsDir
  const body = bodyWith(local.pages.find(p => p.id === 'taehwa/rws-0027/c02').body)
  writeFileSync(path.join(dir, 'r1.json'), body)
  const { createHash } = await import('node:crypto')
  writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ set: 'seed-guard', tokenCeiling: 1000, passRule: 'x', requests: [{ id: 'r1', file: 'r1.json', sha256: createHash('sha256').update(body).digest('hex'), estInputTokens: 100,
    expect: [{ name: 'sup_0', kind: 'predicate', min: 0.8, severity: 'hard' }] }] }))
  const errors = []
  const code = await realRunnerMain([path.join(dir, 'plan.json')], { env: {}, print() {}, printError: line => errors.push(line), fetchImpl: async () => { throw new Error('no network in tests') } })
  assert.equal(code, 2); assert.match(errors.join('\n'), /r1: built from the local-only scenario seed taehwa\/rws-0027/)
  const state = { sent: 0, tokens: 0, requests: [], turn: 1 }
  const guarded = createGuardedFetch(state, { fetchImpl: async () => { throw new Error('reached the network') }, ceiling: 100000, maxRequests: 10 })
  await assert.rejects(guarded('https://api.openai.com/v1/decisions', { body }), error => error.name === 'MeasurementStopped' && /scenario_seed/.test(error.message))
  assert.equal(state.sent, 0)
})

test('CLI: refuses an output inside the repository; writes 0600 files outside it; a second run reports nothing new', async t => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'egd-seed-repo-')); t.after(() => rmSync(repo, { recursive: true, force: true }))
  for (const [f, text] of Object.entries(SEED_REPO)) { mkdirSync(path.join(repo, path.dirname(f)), { recursive: true }); writeFileSync(path.join(repo, f), text) }
  const run = async (...args) => { const lines = [], errors = []; const code = await seedsMain(['--repo', repo, '--source', 'taehwa-ontology', ...args], { print: l => lines.push(l), printError: l => errors.push(l), home: repo })
    if (code !== 0) throw new Error(errors.join('\n')); return lines.at(-1) }
  await assert.rejects(run('--out', path.join(repo, 'seeds')), /inside the repository/)
  const out = path.join(repo, '..', `${path.basename(repo)}-out`); t.after(() => rmSync(out, { recursive: true, force: true }))
  const first = JSON.parse(await run('--out', out))
  assert.equal(first.seeds, 5); assert.equal(first.privacy['owner-approved'], 5)
  assert.equal(statSync(path.join(out, 'taehwa', 'rws-0027.json')).mode & 0o777, 0o600)
  const second = JSON.parse(await run('--out', out))
  assert.deepEqual([second.changes.new, second.changes.changed, second.changes.unchanged], [[], [], 5])
  assert.ok(existsSync(path.join(out, 'fingerprints.json')))
  assert.ok(!readFileSync(path.join(out, 'fingerprints.json'), 'utf8').includes('재감사'), 'hashes only')
})
