// L4 cycle 28: real requests found and paired by code. Synthetic rows only (the real examples stay outside the repository).
import assert from 'node:assert/strict'
import test from 'node:test'
import { briefingRequestKind, replayable, sameWindowPairs } from './egdesk-briefing-real-requests.mjs'

test('request kind by code: summary / progress requests, short one-fact questions; actions on files are not briefing requests', () => {
  for (const t of ['최신 업데이트 내역 정리해봐줘.', '오케이 정리해봐줘', '그래서 뭘 작업한거지 이때까지? 요약좀', '지금 어디까지 동작하는거지?', 'v1이랑 v2 비교해줘']) assert.equal(briefingRequestKind(t), 'summary', t)
  for (const t of ['브랜치 개수 몇개임?', 'L7 c19 언제 병합됐지?']) assert.equal(briefingRequestKind(t), 'one_fact', t)
  for (const t of ['오케이, 그럼 지금까지 커밋한 변경사항 푸시해줘.', '안전하게 삭제할 수 있는 것만 정리해줘.', '좋아', '```\ncode\n``` 비교']) assert.equal(briefingRequestKind(t), null, t)
})
test('same-window pairing: only material dated on the request\'s own day; none -> dropped and said so', () => {
  const pages = [{ id: 'a', time: { at: '2026-11-24' } }, { id: 'b', time: { at: null } }]
  const out = sameWindowPairs([{ id: 'r1', at: '2026-11-24T10:00:00Z' }, { id: 'r2', at: '2026-06-20T08:43:40.866Z' }, { id: 'r3', at: null }], pages)
  assert.deepEqual(out.map(x => [x.request.id, x.pages.map(p => p.id), x.dropped]), [['r1', ['a'], null], ['r2', [], 'no-material-in-window'], ['r3', [], 'no-material-in-window']])
})
test('replayable: a wording that names no subject of its own (generic summary / progress words only)', () => {
  for (const t of ['최신 업데이트 내역 정리해봐줘.', '오케이 정리해봐줘', '그래서 뭘 작업한거지 이때까지? 요약좀']) assert.equal(replayable(t), true, t)
  for (const t of ['지금 개선된 swarm 시스템은 어디까지 동작하는거지?', '폴더 구조 브리핑 및 git commit 현황 보고', '브랜치 개수 몇개임?', '']) assert.equal(replayable(t), false, t)
})
