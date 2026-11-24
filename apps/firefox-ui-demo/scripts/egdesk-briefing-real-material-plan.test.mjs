// L4 cycle 24: the two scripts end to end on a TINY SYNTHETIC loop record (never the real one): pages are built by code, kept outside the repository, and the plan
// built from them loads in lane L6's runner (product bars declared per family, grouping lint) with hard checks at the product bars. Nothing is sent.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPlan } from '../helper/egdesk-decision-real-runner.mjs'
import { main as buildMaterials } from './egdesk-briefing-loop-materials.mjs'
import { main as buildPlan } from './egdesk-briefing-real-material-plan.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
// in-process (the gate's guard forbids child processes): the same main() the command line runs
const refusal = async fn => { try { await fn(); return null } catch (e) { return e.message } }
const LEDGER = ['# 원장', '## 이벤트',
  '- 11-24 21:00 L4 c19(7571661) 병합 → int/c14 95987ea, 326개 파일 6586건 0 실패. 보드 규칙이 combines와 관련 자료 수로 바뀜.',
  '- 11-24 21:10 사용자 결정: 대체 문구에서 고정 문장을 전부 뺌.',
  '- 11-24 21:20 L7 c19(e930372) 병합 → int/c14 c680638. 이미 받은 기록 재전송 제거.',
  '- 11-24 21:30 배정: L4 c24 실자료 브리핑 실측 계획, L5 c17 자체 명령 실행기.'].join('\n')
const REPORT = (n, change) => `# L4 사이클 ${n}: ${change}\n\n- 브랜치 \`lane/c${n}\`\n${change}을 했습니다. 토큰 token=abc12345 은 가림.\n\n## 1. 내용\n세부.`

test('materials and plan scripts on a synthetic record: outside the repo only, pages masked, plan accepted by the runner at the product bars', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'egd-c24-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const loop = path.join(root, 'loop'); mkdirSync(path.join(loop, 'reports'), { recursive: true })
  writeFileSync(path.join(loop, 'LEDGER.md'), LEDGER)
  for (const [n, c] of [[18, '답변 내용 place'], [19, '보드 규칙 변경'], [20, '계획 형식 수정']]) writeFileSync(path.join(loop, 'reports', `l4-c${n}.md`), REPORT(n, c))
  // refusals: inside the repository, or a declared year without its basis
  assert.match(await refusal(() => buildMaterials(['--loop', loop, '--out', path.join(here, 'x')])), /outside the repository/)
  assert.match(await refusal(() => buildMaterials(['--loop', loop, '--out', path.join(root, 'm'), '--year', '2026'])), /basis/)
  const summary = buildMaterials(['--loop', loop, '--out', path.join(root, 'm'), '--year', '2026', '--year-basis', 'synthetic fixture'])
  assert.deepEqual([summary.pages, summary.bySource, summary.dated], [7, { report: 3, ledger: 4 }, 5]); assert.match(summary.builtFrom.ledgerSha256, /^[a-f0-9]{64}$/)
  assert.equal(statSync(path.join(root, 'm', 'pages.json')).mode & 0o777, 0o600)
  const pages = readFileSync(path.join(root, 'm', 'pages.json'), 'utf8'); assert.ok(!pages.includes('abc12345'), 'masked')
  const spec = { set: 'synthetic', tokenCeiling: 12000, passRule: 'synthetic', requests: [
    { id: 'today', request: '오늘 진행 상황 정리해줘', answer: '21:00 L4 c19가 병합되었습니다. 21:20 L7 c19가 병합되었습니다. 남은 일로 21:30에 L4 c24가 배정되었습니다.', select: { rule: 'newest-ledger', n: 4 },
      expect: { place: [{ match: 'combines', severity: 'hard', yes: true, note: 'three facts' }], coverage: [{ match: 'onboard_F\\d', severity: 'hard', yes: true, note: 'copied' }] } },
    { id: 'one', request: 'L7 c19 언제 병합됐지?', answer: 'L7 c19는 11월 24일 21:20에 병합되었습니다.', select: { rule: 'naming', laneCycle: 'l7-c19' }, expect: { place: [{ match: 'combines', severity: 'hard', yes: false, note: 'one fact' }] } }] }
  writeFileSync(path.join(root, 'spec.json'), JSON.stringify(spec))
  assert.match(await refusal(() => buildPlan(['--pages', path.join(root, 'm', 'pages.json'), '--spec', path.join(root, 'spec.json'), '--out', path.join(here, 'y')])), /outside the repository/)
  const out = path.join(root, 'plan'), log = (await buildPlan(['--pages', path.join(root, 'm', 'pages.json'), '--spec', path.join(root, 'spec.json'), '--out', out])).log.join('\n')
  assert.match(log, /today: 4 pages \(newest-ledger\) -> presented/); assert.match(log, /one: 1 pages \(naming\)/)
  const plan = loadPlan(path.join(out, 'plan.json')) // throws on an undeclared bar, a hard check looser than it, or a grouping-lint failure
  assert.deepEqual(plan.requests.map(r => r.id), ['today-place', 'today-coverage', 'one-place'])
  assert.ok(plan.requests.every(r => r.expect.every(e => (e.min === undefined || e.min >= 0.7) && (e.max === undefined || e.max <= 0.3))))
  assert.ok(readdirSync(path.join(out, 'requests')).some(f => f.endsWith('.unsent.json')), 'the stages the spec does not register are kept as evidence only')
  assert.ok(!readFileSync(path.join(out, 'requests', 'today-place.json'), 'utf8').includes('abc12345'))
})
