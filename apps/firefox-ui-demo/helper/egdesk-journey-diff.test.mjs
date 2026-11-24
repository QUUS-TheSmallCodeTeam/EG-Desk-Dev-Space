// L6 c22: the journey regression diff. Synthetic journeys and fake git; the replay of the current tree is checked end to end once.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ANSWER_MOVE, FAMILY_FILES, drawsOf, FAMILY_SYMBOLS, buildDiffReport, definitionRegex, diffLines, familyFiles, flattenBody, formatReport, hintsOf, pickaxeText } from './egdesk-journey-diff.mjs'
import { EXIT, run } from '../scripts/egdesk-journey-diff.mjs'
import { BODY_ANCHOR, findPlanFile, instrument, replay } from '../scripts/egdesk-journey-replay-driver.mjs'
import { loadJourneyPlan, resultsPayload, runJourney } from '../scripts/egdesk-all-on-live-measure.mjs'

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---- the pieces ----
test('flattenBody: one line per text line with its path, the cache key left out, array items named', () => {
  const body = { model: 'm', input: [{ role: 'user', content: 'Held:\n- A\n- B' }], questions: [{ type: 'predicate', name: 'q_1', instructions: 'Is it so?' }], prompt_cache_key: 'egd-ctx-abc' }
  assert.deepEqual(flattenBody(JSON.stringify(body)), ['model | m', 'input[user].role | user', 'input[user].content | Held:', 'input[user].content | - A', 'input[user].content | - B', 'questions[q_1].type | predicate', 'questions[q_1].name | q_1', 'questions[q_1].instructions | Is it so?'])
  assert.deepEqual(flattenBody('not json\nsecond'), ['not json', 'second'])
  assert.deepEqual(flattenBody({ n: 3, ok: true }), ['n = 3', 'ok = true'])
})

test('diffLines: changed lines grouped in hunks, each with the unchanged line before it; identical inputs have none; huge inputs fall back to one hunk', () => {
  assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'b', 'c']), { hunks: [], changed: 0 })
  const d = diffLines(['h', 'a', 'x', 'b', 'c', 'd'], ['h', 'a', 'y', 'z', 'b', 'd'])
  assert.deepEqual(d.hunks, [{ removed: ['x'], added: ['y', 'z'], after: 'a' }, { removed: ['c'], added: [], after: 'b' }]); assert.equal(d.changed, 4)
  assert.deepEqual(diffLines([], ['a']).hunks, [{ removed: [], added: ['a'], after: null }])
  const big = Array.from({ length: 2100 }, (_, i) => `l${i}`)
  const r = diffLines(big, big.map(x => `${x}!`)); assert.equal(r.truncated, true); assert.equal(r.hunks.length, 1)
})

test('pickaxeText: the longest stretch with no number or id (the code fills those in), none for data-like or short lines', () => {
  assert.equal(pickaxeText('questions[tense_0].instructions | Does sentence S1 present something as already carried out, or as true right now'), 'present something as already carried out, or as true right now')
  assert.equal(pickaxeText('input[user].content | [E2 time=past status=done]'), null)
  assert.equal(pickaxeText('input[user].content | - A사 건 결정 메모 | status=done'), null)
  assert.equal(pickaxeText('x | short words only'), null)
  assert.equal(pickaxeText('x | 12,800 3 4 5 6 7 8 9 10 11 12 13 14 15 16'), null)
  assert.ok(pickaxeText('a | ' + 'word '.repeat(30)).length <= 80)
})

test('hintsOf: wording of a question, a changed question set, a section that is gone (with where it sat), held-page lines gone', () => {
  const entry = { names: { old: ['a', 'b', 'c'], new: ['a'] }, nameChanges: { added: [], removed: ['b', 'c'] }, hunks: [
    { removed: ['questions[tn_need].instructions | old words'], added: ['questions[tn_need].instructions | new words'], after: null },
    { removed: ['input[user].content | - one', 'input[user].content | - two', 'input[user].content | - three'], added: ['input[user].content | (nothing)'], after: "input[user].content | Held in the answering model's context:" }] }
  const hints = hintsOf(entry)
  assert.ok(hints.includes('wording of tn_need changed')); assert.ok(hints.includes('question set changed (3 -> 1)'))
  assert.ok(hints.some(h => /^a section of 3 lines is gone and reads \(nothing\), after "Held in the answering model's context:"$/.test(h)), hints.join(' / '))
  // a list that was replaced (removed in one hunk, added in the next) is not a section that is gone
  const moved = { names: { old: ['a'], new: ['a'] }, nameChanges: { added: [], removed: [] }, hunks: [{ removed: ['c | l1', 'c | l2', 'c | l3', 'c | l4'], added: [], after: null }, { removed: [], added: ['c | m1', 'c | m2', 'c | m3'], after: null }] }
  assert.deepEqual(hintsOf(moved), [])
  assert.deepEqual(hintsOf({ names: { old: ['a'], new: ['a'] }, nameChanges: { added: [], removed: [] }, hunks: [{ removed: ['x | held pages one'], added: [], after: null }] }), ['lines about held (already delivered) pages are gone'])
  assert.deepEqual(hintsOf({ names: { old: ['a'], new: ['a'] }, nameChanges: { added: [], removed: [] }, hunks: [{ removed: ['x | one'], added: ['x | two'], after: null }] }), [])
})

// ---- the report ----
const body = (...lines) => JSON.stringify({ model: 'm', input: [{ role: 'user', content: lines.join('\n') }], questions: [{ type: 'predicate', name: 'sup_0', instructions: 'Is it supported?' }] })
const sha = text => `sha-${text.length}-${text.charCodeAt(text.length - 3)}`
const row = (family, names, answers, text) => ({ family, questions: names, sha256: sha(text), status: 200, answers })
const pred = (name, p) => ({ type: 'predicate', name, probability: p })
const check = (id, pass, extra = {}) => ({ id, severity: 'hard', owner: 'L7', text: `${id} text`, pass, ...extra })

function world() {
  const bOld = { dc: body('Held:', '- page A', '- page B', 'Question one', 'A long sentence in its old wording that the code writes'), tm: body('Held:', '- page A', 'old line') }
  const bNew = { dc: body('Held:', '(nothing)', 'Question one', 'A long sentence in its new wording that the code writes'), tm: body('Held:', '- page A', 'old line') }
  const old = { at: '2026-11-24T16:00:00.000Z', plan: { sha256: 'a'.repeat(64) }, scorecard: { hard: { passed: 2, failed: [], notRun: 0 }, soft: { passed: 1, missed: [], notRun: 0 } }, steps: [
    { id: 's1', title: 'first', checks: [check('s1.answer', true), check('s1.keep', true)], seen: { newMessages: [{ by: 'person' }, { by: 'agent' }] }, requests: [row('draft_check', ['sup_0'], [pred('sup_0', 0.4)], bOld.dc), row('memory_triage', ['tn_need'], [pred('tn_need', 0.9)], bOld.tm)] },
    { id: 's2', title: 'second', checks: [check('s2.board', true)], seen: { newMessages: [] }, requests: [] }] }
  const next = { at: '2026-11-24T17:00:00.000Z', plan: { sha256: 'b'.repeat(64) }, scorecard: { hard: { passed: 2, failed: ['s1.answer', 's1.extra'], notRun: 0 }, soft: { passed: 0, missed: ['s1.soft'], notRun: 0 } }, steps: [
    { id: 's1', title: 'first', checks: [check('s1.answer', false, { observed: { agentMessages: [] } }), check('s1.keep', true), check('s1.extra', false, { predicted: 'fails' })], seen: { newMessages: [{ by: 'person' }], flows: [{}] },
      requests: [row('draft_check', ['sup_0'], [pred('sup_0', 0.9)], bNew.dc), row('memory_triage', ['tn_need'], [pred('tn_need', 0.85)], bNew.tm), row('heartbeat', ['message__note'], [pred('message__note', 0.1)], 'hb-body-new')] },
    { id: 's2', title: 'second', checks: [check('s2.board', true)], seen: { newMessages: [] }, requests: [] },
    { id: 's3', title: 'new step', checks: [check('s3.x', true)], seen: {}, requests: [] }] }
  const mk = (results, text, extra = []) => [{ step: 's1', family: 'draft_check', names: ['sup_0'], body: text.dc, sha256: sha(text.dc) }, { step: 's1', family: 'memory_triage', names: ['tn_need'], body: text.tm, sha256: sha(text.tm) }, ...extra]
  return { old: { label: 'old.json', sha: 'a'.repeat(40), results: old, bodies: mk(old, bOld) },
    new: { label: 'new.json', sha: 'b'.repeat(40), results: next, bodies: mk(next, bNew, [{ step: 's1', family: 'heartbeat', names: ['message__note'], body: body('hb'), sha256: 'not-recorded' }]) } }
}

test('the report: newly failed / new / passed checks, posted counts, requests, changed bodies as lines, answers that moved, commits per changed family', () => {
  const calls = []
  const commit = (sha, subject) => ({ sha, author: 'L3', subject })
  const report = buildDiffReport({ ...world(),
    commitsFor: files => { calls.push(['files', files]); return files.includes('helper/egdesk-draft-check.mjs') ? [commit('c1', 'draft tense')] : files.includes('helper/codex-chat-runtime.mjs') ? [commit('c2', 'runtime change')] : [] },
    pickaxe: (text, files) => { calls.push(['pickaxe', text, files]); return text.includes('wording') ? [commit('c3', 'the wording commit')] : [] },
    symbolCommits: (file, name) => (name === 'turnPosition' ? [commit('c4', 'turnPosition counts posted messages')] : []) })
  const s1 = report.steps.find(s => s.id === 's1')
  assert.deepEqual(s1.checks.newlyFailed.map(c => c.id), ['s1.answer']); assert.deepEqual(s1.checks.newFailing.map(c => c.id), ['s1.extra']); assert.deepEqual(s1.checks.newlyPassed, [])
  assert.deepEqual(s1.posted, { oldAgent: 1, newAgent: 0, oldFlows: 0, newFlows: 1 })
  assert.deepEqual(s1.requests.new, { draft_check: 1, memory_triage: 1, heartbeat: 1 })
  const dc = s1.bodies.find(b => b.family === 'draft_check')
  assert.equal(dc.status, 'changed'); assert.deepEqual(dc.hunks[0].removed, ['input[user].content | - page A', 'input[user].content | - page B']); assert.deepEqual(dc.hunks[0].added, ['input[user].content | (nothing)'])
  assert.ok(dc.hints.some(h => /a section of 2 lines is gone/.test(h)) === false, 'two lines are not a section')
  assert.deepEqual(s1.bodies.map(b => [b.family, b.status]), [['draft_check', 'changed'], ['heartbeat', 'added']], 'an unchanged body is not listed')
  assert.equal(s1.bodies.find(b => b.family === 'heartbeat').reproduced.new, false)
  assert.deepEqual(s1.answers.map(a => [a.family, a.name, a.old.p, a.new.p]), [['draft_check', 'sup_0', 0.4, 0.9]], 'tn_need moved 0.05: not listed')
  assert.equal(report.steps.find(s => s.id === 's3').presence, 'new step')
  assert.deepEqual([report.old.hard, report.new.hard, report.new.soft], ['2/2', '2/4', '0/1'])
  assert.deepEqual([report.old.replay.reproduced, report.old.replay.built, report.new.replay.reproduced, report.new.replay.built], [2, 2, 2, 3])
  assert.deepEqual(report.new.replay.notReproduced, [{ step: 's1', family: 'heartbeat', names: ['message__note'] }])
  // commits are asked per changed family, builder files apart from wiring files; function commits too
  const dcFam = report.families.find(f => f.family === 'draft_check')
  assert.deepEqual(dcFam.builderCommits.map(c => c.sha), ['c1']); assert.deepEqual(dcFam.wiringCommits.map(c => c.sha), ['c2'])
  assert.ok(report.families.every(f => f.mapped)); assert.equal(report.families.some(f => f.family === 'memory_triage'), false, 'its body did not change')
  assert.ok(calls.some(c => c[0] === 'files' && c[1].includes('helper/egdesk-draft-check.mjs')))
  assert.equal(ANSWER_MOVE, 0.2)
  // the words of a changed line are searched in the family's files, and the commits that added or removed them are named on the body
  const asked = calls.filter(c => c[0] === 'pickaxe')
  assert.ok(asked.length >= 1 && asked.every(c => c[2].includes('helper/egdesk-draft-check.mjs')), 'searched in the family files')
  assert.match(formatReport(report).join('\n'), /likely causes \(details below\):\n  draft_check in s1: body text changed  <- c3 the wording commit \| c1 draft tense/, 'the digest names the pickaxe commit first, then the builder commit')
  assert.deepEqual(dc.pickaxe.map(p => [p.text, p.commits[0].sha]), [['A long sentence in its old wording that the code writes', 'c3'], ['A long sentence in its new wording that the code writes', 'c3']])
})

test('the report text: head, replay line, checks line, a section per changed step, and the commit section', () => {
  const commit = (sha, subject) => ({ sha, author: 'L3', subject })
  const report = buildDiffReport({ ...world(), commitsFor: files => (files.includes('helper/egdesk-draft-check.mjs') ? [commit('c1', 'draft tense')] : []), pickaxe: () => [], symbolCommits: (file, name) => (name === 'checkDraft' ? [commit('c4', 'checkDraft change')] : []) })
  const lines = formatReport(report), text = lines.join('\n')
  assert.match(lines[0], /^journey diff: old\.json @ aaaaaaa \(2026-11-24T16:00Z\): hard 2\/2, soft 1\/1  ->  new\.json @ bbbbbbb \(2026-11-24T17:00Z\): hard 2\/4, soft 0\/1$/)
  assert.match(lines[1], /^replay old: 2\/2 bodies rebuilt exactly \(2 requests recorded\)$/)
  assert.match(lines[2], /^replay new: 2\/3 bodies rebuilt exactly .*NOT rebuilt exactly: s1 heartbeat/)
  assert.match(lines[3], /^checks: newly failed 1 \(s1\.answer\); newly passed 0; new in the plan 2 \(failing 1\)$/)
  assert.match(text, /== s1\n  FAILED   s1\.answer \(hard, L7\): s1\.answer text   observed \{"agentMessages":\[\]\}/)
  assert.match(text, /new check, failing: s1\.extra \(hard, L7\)   \(the plan predicted it\)/)
  assert.match(text, /posted   agent messages 1 -> 0; flow messages 0 -> 1/)
  assert.match(text, /body     draft_check #1 changed: .* bytes, 5 changed lines/)
  assert.match(text, /- input\[user\]\.content \| - page A\n +- input\[user\]\.content \| - page B\n +\+ input\[user\]\.content \| \(nothing\)/)
  assert.match(text, /answer   draft_check #1 sup_0: 0\.4 -> 0\.9/)
  assert.match(text, /== s3 \(new step\)/); assert.ok(!/== s2/.test(text), 'a step with no change is not printed')
  assert.match(text, /draft_check \(1 changed body\): builder helper\/egdesk-draft-check\.mjs: 1 commit\n    c1 L3: draft tense\n    function checkDraft \(egdesk-draft-check\.mjs\) changed by: c4 checkDraft change/)
  assert.match(text, /heartbeat \(1 changed body\): builder helper\/egdesk-heartbeat-judge\.mjs: 0 commits/)
})

test('the report: a family with no file map is named so it can be added; the same wiring commit is listed once', () => {
  const w = world(); w.new.bodies.push({ step: 's1', family: 'brand_new_family', names: ['x'], body: body('x'), sha256: 'n1' }); w.new.results.steps[0].requests.push(row('brand_new_family', ['x'], [pred('x', 1)], 'n'))
  w.new.bodies.push({ step: 's1', family: 'turn_context', names: ['a'], body: body('tc'), sha256: 'n2' }); w.new.results.steps[0].requests.push(row('turn_context', ['a'], [pred('a', 1)], 'n2'))
  const commit = { sha: 'dup', author: 'L1', subject: 'touches the runtime' }
  const report = buildDiffReport({ ...w, commitsFor: files => (files.includes('helper/codex-chat-runtime.mjs') ? [commit] : []) })
  assert.equal(report.families.find(f => f.family === 'brand_new_family').mapped, false)
  const text = formatReport(report).join('\n')
  assert.match(text, /brand_new_family \(1 changed\): no file map for this family: add it to FAMILY_FILES/)
  assert.equal((text.match(/dup L1: touches the runtime/g) ?? []).length, 1); assert.match(text, /\(1 listed under an earlier family\)/)
})

// ---- the maps are the current code ----
test('FAMILY_FILES and FAMILY_SYMBOLS match the current code: every file exists, every question-name probe is in a builder or wiring file, every function is defined where it says', () => {
  const read = file => readFileSync(path.join(app, file), 'utf8')
  for (const [family, spec] of Object.entries(FAMILY_FILES)) {
    const files = familyFiles(family)
    assert.ok(files.length > 0); for (const f of files) assert.ok(existsSync(path.join(app, f)), `${family}: ${f} does not exist`)
    for (const probe of spec.probes) assert.ok(files.some(f => read(f).includes(probe)), `${family}: no file of the map contains the question name fragment "${probe}"`)
    assert.ok(FAMILY_SYMBOLS[family]?.length > 0, `${family} has no key function`)
  }
  assert.deepEqual(Object.keys(FAMILY_SYMBOLS).sort(), Object.keys(FAMILY_FILES).sort())
  for (const [family, list] of Object.entries(FAMILY_SYMBOLS)) for (const [file, name] of list) {
    assert.ok(familyFiles(family).includes(file), `${family}: ${file} is not in its file map`)
    assert.ok(read(file).split('\n').some(line => definitionRegex(name).test(line)), `${family}: ${name} is not defined in ${file}`)
  }
  assert.equal(familyFiles('unknown_family'), null)
})

// ---- the command ----
function fakeDeps(over = {}) {
  const calls = { git: [], materialize: [], replay: [], rm: [], writes: [] }
  const results = { old: { plan: { sha256: 'a'.repeat(64) }, steps: [{ id: 's1', checks: [], requests: [] }] }, new: { plan: { sha256: 'b'.repeat(64) }, steps: [{ id: 's1', checks: [], requests: [] }] } }
  const files = { '/r/old.json': results.old, '/r/new.json': results.new }
  const deps = { app: 'apps/x', calls,
    resolve: ref => ({ aaaaaaa: 'a'.repeat(40), bbbbbbb: 'b'.repeat(40) })[ref] ?? '',
    git(args) { calls.git.push(args); if (args[0] === 'show') return 'x\nexport async function checkDraft({ draft }) {\n  turnPosition(context) {\n}\n'; return args[0] === 'log' ? 'c1\tL3\tsubject one\n' : '' },
    materialize: (sha, dir) => calls.materialize.push([sha, dir]),
    replay({ checkout, resultsFile, out }) { calls.replay.push([checkout, resultsFile, out]); files[out] = { bodies: [], built: 0, reproduced: 0, recorded: 0 }; return { status: 0, stderr: '' } },
    mkdtemp: () => '/tmp/work', rm: dir => calls.rm.push(dir), readJson: file => { if (!(file in files)) throw new Error('no file'); return files[file] }, writeJson: (file, value) => calls.writes.push([file, value]), ...over }
  return deps
}
const cli = async (argv, deps) => { const out = [], err = []; const code = await run(argv, deps, { print: l => out.push(l), printError: l => err.push(l) }); return { code, out, err } }

test('the command: usage errors, unresolved commits, unreadable or wrong results files', async () => {
  const good = ['/r/old.json', 'aaaaaaa', '/r/new.json', 'bbbbbbb']
  for (const argv of [[], good.slice(0, 3), [...good, 'extra'], ['/r/old.json', 'not-a-sha', '/r/new.json', 'bbbbbbb'], [...good, '--bogus'], [...good, '--workdir']]) assert.equal((await cli(argv, fakeDeps())).code, EXIT.usage, argv.join(' '))
  const r = await cli(['/r/old.json', 'ccccccc', '/r/new.json', 'bbbbbbb'], fakeDeps()); assert.equal(r.code, EXIT.usage); assert.match(r.err[0], /cannot resolve ccccccc/)
  assert.equal((await cli(['/r/missing.json', 'aaaaaaa', '/r/new.json', 'bbbbbbb'], fakeDeps())).code, EXIT.usage)
  const wrong = fakeDeps({ readJson: () => ({ steps: [] }) }); const w = await cli(good, wrong); assert.equal(w.code, EXIT.usage); assert.match(w.err[0], /is not an all-on journey results file/)
})

test('the command: each SHA is extracted and replayed once, the report is printed, git is asked for commits, functions and text between the two SHAs, and the work directory is removed', async () => {
  const deps = fakeDeps(), r = await cli(['/r/old.json', 'aaaaaaa', '/r/new.json', 'bbbbbbb'], deps)
  assert.equal(r.code, EXIT.ok); assert.match(r.out[0], /^journey diff: old\.json @ aaaaaaa/)
  assert.deepEqual(deps.calls.materialize.map(([sha, dir]) => [sha, path.basename(dir)]), [['a'.repeat(40), `co-${'a'.repeat(12)}`], ['b'.repeat(40), `co-${'b'.repeat(12)}`]])
  assert.deepEqual(deps.calls.replay.map(c => c[1]), ['/r/old.json', '/r/new.json']); assert.deepEqual(deps.calls.rm, ['/tmp/work'])
  const keep = fakeDeps(); await cli(['/r/old.json', 'aaaaaaa', '/r/new.json', 'bbbbbbb', '--keep'], keep); assert.deepEqual(keep.calls.rm, [])
  const dir = fakeDeps(); await cli(['/r/old.json', 'aaaaaaa', '/r/new.json', 'bbbbbbb', '--workdir', os.tmpdir() + '/egdesk-jd-test'], dir); assert.deepEqual(dir.calls.rm, [], 'a given workdir is left')
  // a replay that fails: exit 3, the reason, and nothing printed as a report
  const bad = fakeDeps({ replay: () => ({ status: 3, stderr: 'anchor missing' }), readJson: file => (file.endsWith('.json') && !file.includes('bodies-') ? { plan: { sha256: 'a'.repeat(64) }, steps: [] } : (() => { throw new Error('no file') })()) })
  const f = await cli(['/r/old.json', 'aaaaaaa', '/r/new.json', 'bbbbbbb'], bad); assert.equal(f.code, EXIT.replay); assert.match(f.err[0], /replay of old\.json against aaaaaaa failed: anchor missing/); assert.equal(f.out.length, 0)
  const j = await cli(['/r/old.json', 'aaaaaaa', '/r/new.json', 'bbbbbbb', '--json', '--out', '/r/report.json'], fakeDeps()); assert.equal(JSON.parse(j.out.join('\n')).old.sha, 'a'.repeat(40))
})

test('the command: git is asked about the range old..new and the app path; a function is searched by the literal of its definition line at the new SHA', async () => {
  const w = world()
  const results = { old: w.old.results, new: w.new.results }, files = { '/r/old.json': results.old, '/r/new.json': results.new }
  const deps = fakeDeps({ readJson: file => (file in files ? files[file] : file.includes('a'.repeat(12)) ? { bodies: w.old.bodies, built: 2, reproduced: 2, recorded: 2 } : { bodies: w.new.bodies, built: 3, reproduced: 2, recorded: 3 }) })
  const r = await cli(['/r/old.json', 'aaaaaaa', '/r/new.json', 'bbbbbbb'], deps); assert.equal(r.code, EXIT.ok)
  const logs = deps.calls.git.filter(a => a[0] === 'log')
  assert.ok(logs.every(a => a.includes(`${'a'.repeat(40)}..${'b'.repeat(40)}`)), 'every log is of the range old..new')
  assert.ok(logs.some(a => a.includes('--') && a.includes('apps/x/helper/egdesk-draft-check.mjs')), 'file lists carry the app path')
  assert.ok(logs.some(a => a.some(x => /^-S.*wording/.test(x))), 'the pickaxe is used for the changed words')
  assert.ok(logs.some(a => a.includes('-L/export async function checkDraft/,+120:apps/x/helper/egdesk-draft-check.mjs')), 'the function is searched with -L on the literal of its definition line')
  assert.ok(deps.calls.git.some(a => a[0] === 'show' && a[1] === `${'b'.repeat(40)}:apps/x/helper/egdesk-draft-check.mjs`), 'the definition is read at the new SHA')
})

// ---- the replay driver ----
test('the replay driver: the instrumentation follows the anchor line once, a harness without the anchor is refused, the plan is found by its sha256', () => {
  const text = `before\n    ${BODY_ANCHOR}\nafter`
  const out = instrument(text); assert.ok(out.includes(`${BODY_ANCHOR};`)); assert.ok(out.includes('globalThis.__egdeskJourneyBodies?.push(')); assert.equal(out.split('__egdeskJourneyBodies?.push').length, 2)
  assert.equal(instrument('nothing here'), null); assert.equal(instrument(`${BODY_ANCHOR}\n${BODY_ANCHOR}`), null, 'two anchors are ambiguous')
  const harness = readFileSync(path.join(app, 'scripts', 'egdesk-all-on-live-measure.mjs'), 'utf8')
  assert.equal(harness.split(BODY_ANCHOR).length, 2, 'the current harness has the anchor exactly once: if it moved, update BODY_ANCHOR in scripts/egdesk-journey-replay-driver.mjs')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egdesk-plan-find-'))
  try { writeFileSync(path.join(dir, 'egdesk-all-on-live-measure.plan-v9.json'), 'plan nine'); writeFileSync(path.join(dir, 'egdesk-all-on-live-measure.plan.json'), 'plan one')
    const sha = text => require_sha(text)
    assert.equal(path.basename(findPlanFile(dir, sha('plan nine'))), 'egdesk-all-on-live-measure.plan-v9.json'); assert.equal(findPlanFile(dir, 'f'.repeat(64)), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
import { createHash } from 'node:crypto'
const require_sha = text => createHash('sha256').update(text).digest('hex')

test('the replay driver, end to end on the current tree: a dry run of the journey, replayed with its own answers, rebuilds every body exactly; the instrumented copy is removed', async () => {
  const plan = loadJourneyPlan()
  const outcome = await runJourney({ plan })
  const results = JSON.parse(JSON.stringify(resultsPayload({ outcome, plan, send: false, caps: { tokenCeiling: 80000, maxRequests: 80 } })))
  const out = await replay({ checkout: path.join(app, '..', '..'), results })
  assert.equal(out.error, undefined, out.message)
  assert.ok(out.built > 10, `${out.built} bodies`); assert.equal(out.reproduced, out.built, 'every body is the recorded one'); assert.equal(out.recorded, out.built)
  assert.ok(out.bodies.every(b => typeof b.body === 'string' && b.names.length > 0))
  assert.deepEqual(out.rows.map(r => r.id), results.steps.map(s => s.id))
  const leftovers = (await import('node:fs')).readdirSync(path.join(app, 'scripts')).filter(f => f.startsWith('.egdesk-journey-replay-'))
  assert.deepEqual(leftovers, [], 'no instrumented copy is left behind')
  // a results file whose plan the checkout does not have is refused
  const other = await replay({ checkout: path.join(app, '..', '..'), results: { ...results, plan: { sha256: '0'.repeat(64) } } })
  assert.equal(other.error, 'plan_missing')
})

// ---- draws ----
test('drawsOf: bodies identical to the old run are counted per family and checked for identical answers; changed bodies and new steps are fresh', () => {
  const row = (family, names, sha256, ps) => ({ family, questions: names, sha256, answers: ps.map((p, i) => ({ name: names[i], type: 'predicate', probability: p })) })
  const oldR = { steps: [{ id: 's1', requests: [row('draft_check', ['a'], 'h1', [0.4]), row('heartbeat', ['b'], 'h2', [0.1])] }, { id: 's2', requests: [row('draft_check', ['a'], 'h3', [0.2])] }] }
  const newR = { steps: [{ id: 's1', requests: [row('draft_check', ['a'], 'h1', [0.4]), row('heartbeat', ['b'], 'h9', [0.1])] }, { id: 's2', requests: [row('draft_check', ['a'], 'h3', [0.5])] }, { id: 's3', requests: [row('draft_check', ['a'], 'h1', [0.4])] }] }
  const d = drawsOf(oldR, newR)
  assert.deepEqual([d.requests, d.identical, d.fresh, d.freshInNewSteps], [4, 2, 2, 1], 'the same sha in a new step is fresh: the step is new')
  assert.deepEqual([d.identicalAnswersSame, d.identicalAnswersDiffer], [1, 1], 'the s2 twin has the same body but a different answer: reported, not hidden')
  assert.deepEqual(d.byFamily, { draft_check: { requests: 3, identical: 2, fresh: 1 }, heartbeat: { requests: 1, identical: 0, fresh: 1 } })
  assert.deepEqual(drawsOf(null, null), { requests: 0, identical: 0, fresh: 0, freshInNewSteps: 0, identicalAnswersSame: 0, identicalAnswersDiffer: 0, byFamily: {} })
})

test('the report carries the draws line: identical share, whether the identical bodies had identical answers, and the fresh requests by family', () => {
  const w = world()
  const report = buildDiffReport({ ...w })
  const lines = formatReport(report)
  const line = lines.find(l => l.startsWith('draws: '))
  assert.ok(line, lines.slice(0, 6).join(' / '))
  assert.match(line, /^draws: \d+ of \d+ request bodies are byte-identical to the old run \(answers (identical in all of them|identical in \d+, different in \d+)\); fresh by family: /)
  assert.equal(report.draws.requests, w.new.results.steps.reduce((n, s) => n + s.requests.length, 0))
})
