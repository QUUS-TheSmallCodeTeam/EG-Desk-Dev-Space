// c31: a merge that stopped on a conflict. The arbiter reads the conflict from `git status --porcelain` (names git itself reports), the answer's check is offered it as readable run
// evidence with the file names, and a claim that the merge is done (or the conflict resolved) is contradicted by code. Honest reports of the conflict are never flagged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkDraft } from './egdesk-draft-check.mjs'
import { claimsMerge, mergeClaimFindings, runFactFindings } from './egdesk-draft-run-facts.mjs'
import { ownCommandEntry, ownCommandEvidence } from './egdesk-own-command-evidence.mjs'

const MERGE = 'git merge feature'
const entry = (command, exitCode, worktree) => ownCommandEntry({ command, exitCode, durationMs: 120, health: { health: exitCode === 0 ? 'healthy' : 'unhealthy', reasons: [], summary: null }, worktree })
const conflict = entry(MERGE, 1, { state: 'conflict', conflicts: 2, uncommitted: 1, untracked: 0, files: ['app.txt', 'docs/guide.md'] })
const clean = entry(MERGE, 0, { state: 'clean', conflicts: 0, uncommitted: 0, untracked: 0 })
const evidence = (...entries) => entries.map((e, i) => ownCommandEvidence(e, i))

test('the entry and the evidence name the conflicted files from git status, say the merge is not finished and nothing was committed; a clean merge says the worktree is clean', () => {
  assert.deepEqual([conflict.worktree.state, conflict.worktree.conflicts, [...conflict.worktree.files], conflict.vcs], ['conflict', 2, ['app.txt', 'docs/guide.md'], true]); assert.ok(Object.isFrozen(conflict.worktree.files))
  const [item] = evidence(conflict)
  assert.match(item.text, /ran `git merge feature` with EG-Desk's own command tool; it finished with exit code 1/)
  assert.match(item.text, /Git status reports 2 files in conflict: `app\.txt`, `docs\/guide\.md`; the merge is not finished and nothing was committed by the command\./)
  assert.deepEqual([item.facts.worktree, item.facts.conflicts, item.facts.vcs], ['conflict', 2, true])
  assert.match(evidence(entry(MERGE, 1, { state: 'conflict', conflicts: 1, files: ['a.txt'] }))[0].text, /1 file in conflict: `a\.txt`/)
  assert.match(evidence(clean)[0].text, /Git status reports a clean worktree after it\./); assert.equal(evidence(entry('ls', 0, { state: 'clean' }))[0].text.includes('clean worktree'), false, 'only for a git command that changes history')
  assert.equal(entry('npm test', 0, null).worktree, null); assert.equal(entry('echo git merge x', 0, null).vcs, false); assert.equal(entry('git -C sub merge feature', 1, null).vcs, true); assert.equal(entry('git status', 0, null).vcs, false)
})

test('claimsMerge: a claim that the merge is done or the conflict resolved; a report of the conflict, a failure, a plan or a question is not', () => {
  for (const yes of ['머지 완료했습니다.', 'feature 브랜치를 머지했습니다.', '병합이 완료되었습니다.', '충돌 없이 합쳤습니다.', '충돌을 모두 해결했습니다.', 'The merge is complete.', 'I merged feature into main.', 'All conflicts resolved.']) assert.equal(claimsMerge(yes), true, yes)
  for (const no of ['머지 중 충돌이 발생했습니다.', '`app.txt`에서 충돌이 나서 머지를 완료하지 못했습니다.', '머지가 아직 끝나지 않았습니다.', '충돌이 남아 있습니다.', '충돌을 해결한 뒤 머지를 완료할 예정입니다.', '머지를 진행할까요?', '충돌을 해결하면 머지를 완료할 수 있습니다.', '수동으로 해결한 뒤 머지를 마칠 수 있습니다.', 'The merge stopped on a conflict in app.txt.', 'The merge did not complete.', 'Merge failed with a conflict.', '파일을 읽었습니다.']) assert.equal(claimsMerge(no), false, no)
})

test('mergeClaimFindings: contradicted when git status says conflict (or the last merge-like command failed and no status was read); a clean status or no git fact is not', () => {
  const claims = [{ text: 'app.txt와 docs/guide.md에서 충돌이 발생했습니다.' }, { text: '머지 완료했습니다.' }]
  assert.deepEqual(mergeClaimFindings({ claims, evidence: evidence(conflict) }).map(f => [f.kind, f.span, f.reason]), [['contradicted', 1, 'run_facts']])
  assert.deepEqual(mergeClaimFindings({ claims, evidence: evidence(clean) }), [], 'a clean worktree supports it')
  assert.deepEqual(mergeClaimFindings({ claims, evidence: evidence(entry(MERGE, 1, null)) }).length, 1, 'no status, the merge exited 1')
  assert.deepEqual(mergeClaimFindings({ claims, evidence: evidence(entry('git merge feature', 0, null)) }), [], 'no status, exit 0: nothing contradicts it')
  assert.deepEqual(mergeClaimFindings({ claims, evidence: evidence(entry('npm test', 1, null)) }), [], 'a failed non-git command says nothing about a merge')
  assert.deepEqual(mergeClaimFindings({ claims, evidence: evidence(conflict, clean) }), [], 'the last command decides (the conflict was resolved and the merge finished later)')
  assert.deepEqual(mergeClaimFindings({ claims, evidence: [] }), []); assert.deepEqual(runFactFindings({ claims, evidence: evidence(conflict) }).map(f => f.span), [1], 'it is part of the run-facts findings')
})

const model = () => ({ decide: async request => ({ answers: request.questions.map(q => ({ name: q.name, type: 'predicate', probability: /^sup_/.test(q.name) ? 0.95 : 0.03 })), usage: { input_tokens: 10 } }) })

test('checkDraft: "머지 완료했습니다" after a conflict is revised even though the model says it is supported; the honest report passes untouched', async () => {
  const honest = '`app.txt`, `docs/guide.md`에서 충돌이 발생해 머지를 완료하지 못했습니다.'
  const ok = await checkDraft({ draft: honest, evidence: evidence(conflict), mode: 'on', client: model(), revise: async () => 'x' })
  assert.equal(ok.outcome, 'passed'); assert.equal(ok.text, honest)
  const bad = await checkDraft({ draft: '머지 완료했습니다.', evidence: evidence(conflict), mode: 'on', client: model(), revise: async () => '`app.txt`, `docs/guide.md`에서 충돌이 발생해 머지가 끝나지 않았습니다.' })
  assert.equal(bad.outcome, 'revised'); assert.deepEqual(bad.findings.map(f => f.reason), ['run_facts']); assert.match(bad.text, /끝나지 않았/)
  const stubborn = await checkDraft({ draft: '머지 완료했습니다.', evidence: evidence(conflict), mode: 'on', client: model(), revise: async () => '충돌 없이 합쳤습니다.' })
  assert.notEqual(stubborn.text, '충돌 없이 합쳤습니다.', 'a rewrite that says it again is not posted')
  const clean2 = await checkDraft({ draft: '머지 완료했습니다.', evidence: evidence(clean), mode: 'on', client: model(), revise: async () => 'x' })
  assert.equal(clean2.outcome, 'passed', 'a clean merge makes the same sentence true')
})
