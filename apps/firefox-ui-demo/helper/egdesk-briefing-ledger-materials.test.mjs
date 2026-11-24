// L4 cycle 24: briefing materials built by code from the loop's own record. Tiny synthetic fixtures only (the real ledger and reports are read by the script,
// read-only, and their pages are written outside the repository).
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLoopPages, laneCyclesIn, maskSecrets, mergedLaneCycles, parseLedger, parseReport, statedStatus } from './egdesk-briefing-ledger-materials.mjs'
import { normalizeMaterials } from './egdesk-briefing-skeleton.mjs'

const LEDGER = [
  '# 원장', '', '## 이벤트',
  '- 11-24 21:54 병합: L7 c17(df72679), L4 c19(7571661). int/c14 = 95987ea, 326개 파일 6586건 0 실패.',
  '- 11-24 21:28 병합: L2 c11(267e9e4), L1 c12(49be194)는 충돌 2파일 → L1 c13에서 재병합.',
  '- 11-24 21:30 배정: L4 c20(계획 형식 수정), L6 c10.',
  '- 11-24 21:31 L3 수신: 키 sk-proj-abcdefghijklmnopqrstuvwx 와 메일 lane-l4@egdesk.invalid, token=abc123secret 경로 /Users/someone/x',
  '- 11-24 21:32 실호출 3건·2,399토큰 3/3.',
  '  들여쓴 줄은 사건이 아님', '- 날짜 없는 줄',
].join('\n')
const REPORT = (n, extra = '') => `# L4 사이클 ${n}: 브리핑 ${n}\n\n- 브랜치 \`lane/c${n}\` 커밋 \`abc1234\`\n- 게이트: 0 fail\n${extra}이번 사이클은 커버리지를 바꿨습니다.\n\n## 1. 내용\n| 항목 | 값 |\n|-|-|\n| 질문 | 사실별 |\n\n## 2. 다음\n둘째 절은 발췌에 안 들어감`

test('ledger lines: a date only from "- MM-DD HH:MM"; the year only when declared (else unknown); status only from the words; lane-cycles named', () => {
  const noYear = parseLedger(LEDGER)
  assert.equal(noYear.length, 5, 'only dated event lines'); assert.ok(noYear.every(e => e.at === null), 'the lines state no year: unknown stays unknown')
  assert.equal(noYear[0].title.startsWith('11-24 21:54 '), true, 'the stated month-day and time stay visible in the title')
  const withYear = parseLedger(LEDGER, { year: 2026 })
  assert.deepEqual(withYear.map(e => [e.at, e.clock, e.status]), [['2026-11-24', '21:54', 'done'], ['2026-11-24', '21:28', 'done'], ['2026-11-24', '21:30', 'plan'], ['2026-11-24', '21:31', 'reported_by_other'], ['2026-11-24', '21:32', 'unknown']])
  assert.deepEqual(parseLedger('- 02-30 10:00 x', { year: 2026 })[0].at, null, 'no impossible date'); assert.deepEqual(parseLedger('- 11-24 10:00 x', { year: 1999 })[0].at, null)
  assert.deepEqual(withYear[0].lanes, ['l7-c17', 'l4-c19']); assert.deepEqual(laneCyclesIn('L4c19 와 L4 c19 그리고 L12 c1'), ['l4-c19'])
  assert.deepEqual([statedStatus('병합 완료'), statedStatus('배정: L4'), statedStatus('L3 수신'), statedStatus('실호출 통과')], ['done', 'plan', 'reported_by_other', 'unknown'])
})
test('merged lane-cycles: named with a commit id in a merge line; a conflict / hold right after it merges nothing', () => {
  assert.deepEqual(mergedLaneCycles('병합: L7 c17(df72679, 시험 파일 양쪽 유지), L4 c19(7571661).'), ['l7-c17', 'l4-c19'])
  assert.deepEqual(mergedLaneCycles('병합: L2 c11(267e9e4), L1 c12(49be194)는 충돌 2파일 → L1 c13에서 재병합'), ['l2-c11'])
  assert.deepEqual(mergedLaneCycles('배정: L4 c20(dc98bdf)'), [], 'no merge word'); assert.deepEqual(mergedLaneCycles('L4 c20 병합'), [], 'no commit id: not stated as merged')
})
test('secrets are always masked: keys, tokens, emails, credentials, home paths; commit ids stay', () => {
  const t = maskSecrets('sk-proj-abcdefghijklmnopqrstuvwx egd-synthetic-not-a-key-0004 ghp_abcdefghijklmnopqrstuvwxyz12 Bearer abcdefghijklmnop a.b@c.io token=xyz123 password: hunter2 /Users/me/p 7571661 eyJhbGciOiJIUzI1.eyJzdWIiOiIx.c2lnbmF0dXJl')
  for (const leak of ['abcdefghijklmnopqrstuvwx', 'not-a-key-0004', 'ghp_', 'a.b@c.io', 'xyz123', 'hunter2', '/Users/me', 'eyJhbGci']) assert.ok(!t.includes(leak), leak)
  assert.ok(t.includes('7571661')); assert.ok(t.includes('~/p'))
  const e = parseLedger(LEDGER, { year: 2026 })[3]; assert.doesNotMatch(e.excerpt, /sk-proj-|@egdesk|abc123secret|\/Users\//)
})
test('report pages: own H1 title, opening prose without bookkeeping lines; date and done from the ledger line that states the merge, else reported with no invented date', () => {
  const r = parseReport('l4-c19.md', REPORT(19)); assert.deepEqual([r.id, r.title, r.at], ['report-l4-c19', 'L4 사이클 19: 브리핑 19', null])
  assert.equal(r.excerpt, '이번 사이클은 커버리지를 바꿨습니다. 항목 값 질문 사실별', 'the opening prose and the first section (a table read as plain words), never the second section or bookkeeping'); assert.equal(parseReport('notes.md', REPORT(1)), null)
  assert.equal(parseReport('l4-c3.md', REPORT(3, '실측일 2026-11-20 기준.\n')).at, '2026-11-20', 'a date the report states')
  const rows = buildLoopPages({ ledger: LEDGER, reports: [{ fileName: 'l4-c18.md', text: REPORT(18) }, { fileName: 'l4-c19.md', text: REPORT(19) }, { fileName: 'l4-c20.md', text: REPORT(20) }, { fileName: 'l1-c12.md', text: REPORT(12) }], year: 2026 })
  const by = id => rows.find(x => x.id === id)
  assert.deepEqual([by('report-l4-c19').status, by('report-l4-c19').time.at], ['done', '2026-11-24'])
  assert.deepEqual([by('report-l4-c20').status, by('report-l4-c20').time.at], ['reported_by_other', null], 'assigned, not stated as merged: no date, no done')
  assert.deepEqual([by('report-l1-c12').status, by('report-l1-c12').time.at], ['reported_by_other', null], 'a conflict is not a merge')
  assert.deepEqual(by('report-l4-c19').links, [{ type: 'follows_from', toAlias: 'report-l4-c18' }, { type: 'refers_to', toAlias: 'ledger-1124-2154-1' }])
  assert.ok(by('ledger-1124-2154-1').links.some(l => l.type === 'refers_to' && l.toAlias === 'report-l4-c19'))
  // the skeleton takes the rows as they are: dates, statuses and links survive its normalisation
  const m = normalizeMaterials([by('report-l4-c18'), by('report-l4-c19'), by('ledger-1124-2154-1')])
  assert.deepEqual(m.map(x => [x.at, x.status]), [[null, 'reported_by_other'], ['2026-11-24', 'done'], ['2026-11-24', 'done']])
  assert.deepEqual(m[1].links, [{ type: 'follows_from', to: 'M1' }, { type: 'refers_to', to: 'M3' }])
})
