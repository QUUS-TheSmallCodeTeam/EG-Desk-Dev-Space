// L4 cycle 29: same-window cases from the person's own conversation - rules only, on SYNTHETIC turns (the real conversations stay outside the repository).
import assert from 'node:assert/strict'
import test from 'node:test'
import { askKind, excluded, finalAnswer, oneFactControl, pickDiverse, sameWindowCase, turnPages } from './egdesk-briefing-same-window.mjs'
import { briefingRequestKind } from './egdesk-briefing-real-requests.mjs'
import { answerFacts, answerUnits } from './egdesk-briefing-skeleton.mjs'
import { expectationsFor } from '../scripts/egdesk-briefing-same-window.mjs'

const T = (role, text, line, at = '2026-06-23T12:00:00Z') => ({ role, text, line, at })
const LONG = '맞아요, 비교가 엉성했습니다. char로 통일해서 다시 봤습니다. 주입은 10,000 char 고정이고, Read는 2,000줄입니다. 그래서 Read 쪽이 대체로 더 큽니다. 줄이 길면 잘립니다. '.repeat(4)

test('the real answer is the last assistant message before the person\'s next turn (D1: the completed one), not the preamble', () => {
  const turns = [T('user', 'q', 1), T('assistant', '확인하겠습니다.', 2), T('assistant', '최종 답입니다.', 3), T('user', '다음', 4), T('assistant', '그다음', 5)]
  assert.equal(finalAnswer(turns, 0).line, 3); assert.equal(finalAnswer(turns, 3).line, 5)
})
test('same-window case: the same conversation\'s preceding message turns are the materials (dated by the log, masked, linked in order); stated drops', () => {
  const turns = [T('user', '스켈레톤 출력 크기 알려줘', 10), T('assistant', '주입 한도는 10,000 char이고 Read는 2,000줄입니다. 파일은 /Users/someone/x.md 에 있습니다. 키 sk-proj-abcdefghijklmnopqrstuvwx', 11),
    T('user', '어, 2000줄이 더 큰거야? 유닛이 달라서 비교를 못하겠는데', 12), T('assistant', '확인하겠습니다.', 13), T('assistant', LONG, 14), T('user', 'ok', 15)]
  const c = sameWindowCase(turns, 12)
  assert.equal(c.dropped, null); assert.equal(c.answer.line, 14); assert.equal(c.pages.length, 2)
  assert.deepEqual(c.pages.map(p => [p.id, p.time.at, p.role, p.links]), [['t12-10', '2026-06-23', 'user', []], ['t12-11', '2026-06-23', 'assistant', [{ type: 'follows_from', toAlias: 't12-10' }]]])
  assert.ok(c.pages[1].title.startsWith('Agent 06-23 12:00 ')); assert.doesNotMatch(JSON.stringify(c.pages), /sk-proj-|\/Users\//)
  assert.equal(sameWindowCase(turns, 99).dropped, 'not-found'); assert.equal(sameWindowCase(turns, 10).dropped, 'short-answer')
  assert.equal(sameWindowCase([T('user', '정리해줘', 1), T('assistant', LONG, 2)], 1).dropped, 'no-material')
  assert.equal(sameWindowCase([T('user', 'a', 1), T('assistant', 'b', 2), T('user', '요약좀', 3), T('assistant', '<heartbeat>\n<decision>NOTIFY</decision>', 4)], 3).dropped, 'no-answer', 'an automation record is not an answer')
  assert.equal(sameWindowCase([T('user', 'a', 1), T('assistant', 'b', 2), T('user', '요약좀', 3), T('assistant', `연결 계정은 sales@taehwatrans.com 입니다. ${LONG}`, 4)], 3).dropped, 'excluded', '태화 customer mail is out of bounds')
  assert.ok(excluded('~/Projects/Taehwa_Gmail_PoC/x.jsonl'))
})
test('code pick: one case per kind of ask (compare, progress, summary), longer real answers first; a real one-fact control only when its answer is one fact', () => {
  const mk = (id, text, n, file) => ({ example: id, file, request: { text }, answer: { text: 'x'.repeat(n) }, pages: [], dropped: null })
  const cases = [mk('a', '요약좀', 900, 'f1'), mk('b', '비교를 못하겠는데', 700, 'f2'), mk('c', '어디까지 동작하는거지?', 1200, 'f2'), mk('d', '정리해줘', 400, 'f3'), { example: 'e', dropped: 'short-answer' }]
  assert.deepEqual(pickDiverse(cases, 3).map(c => c.example), ['b', 'c', 'a']); assert.deepEqual([askKind('비교'), askKind('현황 보고'), askKind('요약좀')], ['compare', 'progress', 'summary'])
  const list = [T('user', '브랜치 개수 몇개임?', 1), T('assistant', '현재 브랜치는 다음과 같아요.\n\n- 로컬: 17개\n- 원격: 3개', 2)]
  assert.equal(oneFactControl(list), null, 'two counts in a list are not one fact')
  const one = [T('user', '브랜치 개수 몇개임?', 1), T('assistant', '로컬 브랜치는 17개입니다.', 2)]
  assert.deepEqual(oneFactControl(one).answer.text, '로컬 브랜치는 17개입니다.')
  assert.equal(briefingRequestKind('어떤걸 캐시한다는거야? 아니면 요약본만?'), null, "'요약본' (a summary copy) is not a request to summarise")
})
test('the answer\'s own structure (cycle 29): one fact per bullet, numbered item or table row; headings, lead-ins, bold labels, table header and separator rows are no facts', () => {
  const md = '맞아요, 비교가 엉성했습니다. **char로 통일**해서 정리:\n\n| 채널 | 한도 | 의존? |\n|---|---|---|\n| **hook 주입** | **10,000 char 고정** | ✗ |\n| Read 툴 | 2,000줄 | ✓ |\n\n## 결론\n**요약**\n- 주입 10K는 고정입니다.\n1. Read는 줄 단위입니다.'
  assert.deepEqual(answerUnits(md), ['hook 주입 · 10,000 char 고정 · ✗', 'Read 툴 · 2,000줄 · ✓', '주입 10K는 고정입니다.', 'Read는 줄 단위입니다.'], 'the first line is a lead-in (it ends with a colon)')
  assert.deepEqual(answerFacts(md).facts, ['hook 주입 · 10,000 char 고정 · ✗', 'Read 툴 · 2,000줄 · ✓', '주입 10K는 고정입니다.', 'Read는 줄 단위입니다.'])
  assert.deepEqual(answerUnits('줄 바꿈 없는 답입니다. 둘째 문장.'), ['줄 바꿈 없는 답입니다. 둘째 문장.'], 'plain text is split by sentences as before')
})
test('expectations are set by code from the materials: a board only when three or more facts cite two or more preceding turns; a cited fact must not be decided absent (notDecidedNo); the control is the bubble', () => {
  const pages = [{ id: 'p1', title: '사람 06-23 12:00 한도', excerpt: '주입 한도는 10,000 char입니다.', time: { at: '2026-06-23' }, status: 'unknown', links: [] },
    { id: 'p2', title: 'Agent 06-23 12:01 Read', excerpt: 'Read는 2,000줄까지 읽습니다.', time: { at: '2026-06-23' }, status: 'unknown', links: [] }]
  const e = expectationsFor({ pages, answer: { text: '주입은 10,000 char 고정입니다. Read는 2,000줄입니다. 줄이 길면 잘립니다. 결론은 v9 기준입니다.' } })
  assert.deepEqual(e.place, [{ match: 'combines', severity: 'hard', yes: true, note: '4 facts, citing 2 preceding turns by code' }])
  assert.deepEqual(e.coverage.map(x => [x.match, x.severity, x.notDecidedNo ?? null, x.yes ?? null]), [['onboard_F1', 'hard', true, null], ['onboard_F2', 'hard', true, null], ['onboard_F3', 'soft', true, null], ['onboard_F4', 'soft', null, false]])
  assert.equal(expectationsFor({ pages, answer: { text: '주입은 10,000 char 고정입니다.' } }).place[0].severity, 'soft', 'one fact: not pre-registered as a board')
  assert.deepEqual(expectationsFor({}, { control: true }).place, [{ match: 'combines', severity: 'hard', yes: false, note: 'a real one-fact answer: the bubble at the product rule (combines not yes)' }])
})
