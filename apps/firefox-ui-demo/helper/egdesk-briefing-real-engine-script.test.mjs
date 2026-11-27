// L4 cycle 30: the progress-summary script for lane L5's real-engine check. Offline: the committed JSON is what the builder writes, every expectation is derived from
// the folder's notes by code, the format is the check's own (validated by its validator when that file is in this tree).
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { PROGRESS_ENTRIES, PROGRESS_SET, buildProgressScript } from './egdesk-briefing-real-engine-script.mjs'
import { SCRIPT_FILE, scriptBytes } from '../scripts/egdesk-briefing-real-engine-script.mjs'

const script = buildProgressScript(), conversation = script.conversations[0]
const EXPECT_KEYS = ['toolCalls', 'noToolCalls', 'posted', 'answerIncludes', 'answerExcludes', 'noNativeTools', 'asked', 'commandsRan', 'files', 'undoRecords', 'turnStatus', 'compacted']

test('the committed script is what the builder writes, in the check\'s format (set, conversations [{ id, folder, flags?, turns [{ say, expect }] }])', () => {
  assert.ok(readFileSync(SCRIPT_FILE).equals(scriptBytes()), 'stale: node scripts/egdesk-briefing-real-engine-script.mjs --write')
  assert.match(script.set, /^real-engine-[a-z0-9][a-z0-9-]{0,40}-v\d{1,3}$/); assert.equal(script.set, PROGRESS_SET)
  assert.deepEqual(Object.keys(script), ['set', 'description', 'conversations']); assert.equal(script.conversations.length, 1)
  assert.deepEqual(Object.keys(conversation), ['id', 'folder', 'turns'], 'no flags: the check does not reproduce the briefing path, so a briefing flag would silently do nothing')
  for (const t of conversation.turns) { assert.deepEqual(Object.keys(t), ['say', 'expect']); assert.ok(Object.keys(t.expect).every(k => EXPECT_KEYS.includes(k))); assert.ok(t.say.length <= 4000) }
  for (const p of Object.keys(conversation.folder)) assert.ok(!p.startsWith('/') && !p.split('/').some(s => ['', '.', '..', '.git', '.codex', '.agents', '.egdesk'].includes(s)), p)
  assert.doesNotMatch(JSON.stringify(script), /\/Users\/|sk-|@|http/, 'synthetic: no real path, key, address or link')
})
test('expectations are derived by code from the notes: every merged topic, commit id and test count, every open item, and the files unchanged', () => {
  const folderText = Object.values(conversation.folder).join('\n'), [first, second] = conversation.turns
  for (const token of [...first.expect.answerIncludes, ...second.expect.answerIncludes]) assert.ok(folderText.includes(token), `${token} is in the notes`)
  assert.deepEqual(first.expect.answerIncludes, ['로그인 화면', 'a1b2c3d', '120', '결제 모듈', 'e4f5a6b', '98', '검색 화면'])
  assert.deepEqual(second.expect.answerIncludes, ['알림 설정 구현', '검색 성능 점검', '배포 체크리스트 작성'])
  assert.deepEqual(first.expect.files, conversation.folder); assert.deepEqual(second.expect.files, conversation.folder, 'read-only: both turns')
  assert.deepEqual([first.expect.toolCalls, first.expect.noNativeTools, first.expect.undoRecords, first.expect.turnStatus], [['egdesk_read_file'], true, 0, 'completed'])
  // a different set of notes gives different expectations (nothing is typed in by hand)
  const other = buildProgressScript([{ file: 'devlog/12-01.md', day: '12-01', status: 'done', topic: '리포트', commit: 'ffff000', tests: 7 }, { file: 'devlog/12-02.md', day: '12-02', status: 'plan', topic: '내보내기', open: ['PDF 출력'] }]).conversations[0].turns
  assert.deepEqual(other[0].expect.answerIncludes, ['리포트', 'ffff000', '7', '내보내기']); assert.deepEqual(other[1].expect.answerIncludes, ['PDF 출력'])
  assert.equal(PROGRESS_ENTRIES.filter(e => e.status === 'done').length, 2)
})
test('lane L5\'s own validator accepts it (checked whenever helper/egdesk-real-engine-script.mjs is in this tree; it is on lane/c22-real-engine-check, not yet merged here)', async t => {
  const file = new URL('./egdesk-real-engine-script.mjs', import.meta.url)
  if (!existsSync(file)) return t.skip('the real-engine check is not in this tree yet; it was validated against lane/c22-real-engine-check in the cycle 30 evidence (l5-validator-check.txt)')
  const { validateEngineScript } = await import(file.href)
  assert.deepEqual(validateEngineScript(script), { ok: true, errors: [] })
})
