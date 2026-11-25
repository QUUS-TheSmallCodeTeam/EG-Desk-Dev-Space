// c29: a completion claim about tests that the run's own command contradicts is found by CODE, not asked of a model. The facts decide (the arbiter's reading of the command,
// egdesk-run-conditions.mjs): the draft check's predicate design asks "does the evidence say what this sentence says" and acts only on a sentence that carries a concrete detail
// (a number, a name, an identifier) and only while no evidence is a content-free reference; "모든 테스트가 통과했습니다." has no concrete detail and the engine's other tool steps
// are references, so a false "all passed" was never found (measured by the c29 negative: the check passed it, "would_pass"). A sentence that says the tests passed, with no word
// of failure, is contradicted when the last command EG-Desk ran for the run counted a failing test, exited non-zero, or did not finish.
// facts (on an evidence item from egdesk-own-command-evidence.mjs): { kind: 'own_command', passed, failed, exitCode, stopped, hasSummary } (numbers and booleans only).
const PASS_CLAIM = /(?:테스트|검사|빌드|test|tests|suite|build)[^.!?\n]{0,40}(?:통과|성공|패스|pass(?:ed|es)?|succe(?:ss|ed|eded))|(?:통과|성공|패스)(?:했|됐|되었|하였|함|입니다|했습니다)|\bpass(?:ed|es)?\b|\bsucce(?:ss|ed|eded)\b/i
const FAIL_WORDS = /실패|오류|에러|않|못|아니|아닙|아닌|제외|빼고|제외하고|예외|fail|error|not\b|n't|except|but\b|still/i
// the sentence is about the tests or the build, or says that everything did: a lone "성공했습니다" about something else is not this rule's business
const TESTWORD = /테스트|검사|빌드|\btests?\b|\bsuite\b|\bbuild\b/i
const UNIVERSAL = /모든|전부|모두|전체|\ball\b|\bevery\b|\beverything\b/i

/** Does a sentence say that the tests (or the run) passed, with no word of failure? */
export const claimsPass = text => { const t = String(text ?? ''); return PASS_CLAIM.test(t) && !FAIL_WORDS.test(t) && (TESTWORD.test(t) || UNIVERSAL.test(t)) }

// c30b: a claim that a file was changed, against the edits EG-Desk made (facts of kind own_edit: path, state previewed | applied | undone | not_applied | not_undone, tool, editId).
// A sentence that says a change was made (no negation, no plan, no mention of a preview) is contradicted when the file it names was only previewed, undone or never applied, when it names
// a file the run made no edit to, or, naming no file, when the run applied no edit at all. A sentence about a preview ("dryRun 미리보기로 확인했습니다") is not a claim of a change.
const EDIT_DONE = /수정했|고쳤|고쳐 ?놓|바꿨|바꾸었|변경했|적용했|반영했|편집했|교체했|추가했|삭제했|지웠|작성했|만들었|\b(?:edited|changed|fixed|applied|updated|modified|replaced|wrote|written|patched)\b/i
const EDIT_NOT_CLAIM = /하지 않|않았|않습|못했|안 했|아직|예정|할 수 있|하겠|할게|하려|계획|제안|가능|필요|미리보기|dryRun|\bpreview|\bwould\b|\bwill\b|\bcould\b|\bnot\b|n't|되돌|undo|undid|restor|복원|취소|\?|\bif\b|다면|면 /i
const PATH_TOKEN = /[\w./-]+\.(?:mjs|cjs|js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|sh|json|md|css|scss|html|yml|yaml|toml|txt|sql|xml)\b/gi
const base = p => String(p).split('/').pop()
export const claimsEdit = text => { const t = String(text ?? ''); return EDIT_DONE.test(t) && !EDIT_NOT_CLAIM.test(t) }

// c31: a claim that a merge (or a conflict resolution) is done, against git status after the run's last command: the arbiter reads it from `git status --porcelain`, not from the model.
// Contradicted when the last own command left the worktree in conflict, or when the last merge-like git command exited non-zero and no status was read. A sentence that reports the conflict,
// a failure, a plan or a question is not a claim of completion.
const MERGE_DONE = /머지(?:를|가|는)?\s*(?:완료|끝|성공|마쳤|됐|되었)|머지했|병합(?:을|이|은)?\s*(?:완료|끝|성공|마쳤|됐|되었)|병합했|합쳤|합쳐졌|충돌(?:을|이|은)?\s*(?:모두\s*)?(?:해결|정리)(?:했|됐|되었|완료)|해결했|\bmerged\b|\bmerge (?:is |was |has been )?(?:complete|completed|done|finished|succeeded|successful)|\bconflicts? (?:is |are |was |were |have been )?resolved|\bresolved (?:all|the) conflicts?/i
const MERGE_NOT_CLAIM = /않|못|아직|실패|중단|취소|예정|하겠|할까|할게|하려|해야|필요|할 수|하면|한 뒤|한 후|수 있|발생했|발생하여|남아|남았|미해결|해결되지|\?|\bnot\b|n't|\bfail|\bunable|\bif\b|\bunresolved\b|\bremain|\bconflict(?:s|ed)? (?:in|detected|found)|\babort/i
export const claimsMerge = text => { const t = String(text ?? ''); return MERGE_DONE.test(t) && !MERGE_NOT_CLAIM.test(t) }

export function mergeClaimFindings({ claims, evidence }) {
  const last = lastRunFacts(evidence)
  if (!last) return []
  const f = last.facts
  const contradicted = f.worktree === 'conflict' || (f.worktree === null && f.vcs === true && Number.isSafeInteger(f.exitCode) && f.exitCode !== 0)
  if (!contradicted) return []
  return (Array.isArray(claims) ? claims : []).map((span, index) => ({ span, index })).filter(({ span }) => claimsMerge(span.text)).map(({ index }) => ({ kind: 'contradicted', span: index, evidence: [last.id], reason: 'run_facts' }))
}

export function editFacts(evidence) {
  return (Array.isArray(evidence) ? evidence : []).filter(item => item && item.opaque !== true && item.facts?.kind === 'own_edit').map(item => ({ ...item.facts, id: item.id }))
}

/** Findings of kind 'contradicted' for the sentences that claim a change the run's edits do not show. */
export function editClaimFindings({ claims, evidence }) {
  const facts = editFacts(evidence)
  if (!facts.length) return []
  const finalState = new Map() // path → the state after the run's calls in order; an undo of an edit id takes that edit back
  for (const fact of facts) {
    if (!fact.path) continue
    if (fact.state === 'applied' || fact.state === 'previewed' || fact.state === 'not_applied') finalState.set(fact.path, fact.state)
    else if (fact.state === 'undone') finalState.set(fact.path, 'undone')
  }
  const anyApplied = [...finalState.values()].some(state => state === 'applied')
  const out = []
  ;(Array.isArray(claims) ? claims : []).forEach((span, index) => {
    const text = String(span?.text ?? '')
    if (!claimsEdit(text)) return
    const mentioned = [...finalState.keys()].filter(p => text.includes(p) || text.includes(base(p)))
    const tokens = (text.match(PATH_TOKEN) ?? []).filter(tok => ![...finalState.keys()].some(p => p === tok || base(p) === base(tok)))
    let bad = false
    if (mentioned.length) bad = !mentioned.some(p => finalState.get(p) === 'applied')
    else if (tokens.length) bad = true
    else bad = !anyApplied
    if (bad) out.push({ kind: 'contradicted', span: index, evidence: facts.map(f => f.id), reason: 'run_facts' })
  })
  return out
}

/** The reading of the last own command in the evidence, or null. */
export function lastRunFacts(evidence) {
  const facts = (Array.isArray(evidence) ? evidence : []).filter(item => item && item.opaque !== true && item.facts?.kind === 'own_command')
  return facts.length ? { facts: facts.at(-1).facts, id: facts.at(-1).id } : null
}

/** Findings of kind 'contradicted' for the sentences (claims: [{ text }]) that say the tests passed while the last run says otherwise. */
export function runFactFindings({ claims, evidence }) {
  const edits = editClaimFindings({ claims, evidence }), tests = testClaimFindings({ claims, evidence }), merges = mergeClaimFindings({ claims, evidence })
  const first = [...tests, ...merges.filter(m => !tests.some(t => t.span === m.span))]
  return [...first, ...edits.filter(e => !first.some(t => t.span === e.span))]
}

function testClaimFindings({ claims, evidence }) {
  const last = lastRunFacts(evidence)
  if (!last) return []
  const f = last.facts
  const contradicted = f.stopped === true || (Number.isFinite(f.failed) && f.failed >= 1) || (Number.isSafeInteger(f.exitCode) && f.exitCode !== 0) || (f.exitCode === null && !(Number.isFinite(f.failed) && f.hasSummary))
  if (!contradicted) return []
  return (Array.isArray(claims) ? claims : []).map((span, span_i) => ({ span, span_i })).filter(({ span }) => claimsPass(span.text))
    .map(({ span_i }) => ({ kind: 'contradicted', span: span_i, evidence: [last.id], reason: 'run_facts' }))
}
