// c29: a completion claim about tests that the run's own command contradicts is found by CODE, not asked of a model. The facts decide (the arbiter's reading of the command,
// egdesk-run-conditions.mjs): the draft check's predicate design asks "does the evidence say what this sentence says" and acts only on a sentence that carries a concrete detail
// (a number, a name, an identifier) and only while no evidence is a content-free reference; "모든 테스트가 통과했습니다." has no concrete detail and the engine's other tool steps
// are references, so a false "all passed" was never found (measured by the c29 negative: the check passed it, "would_pass"). A sentence that says the tests passed, with no word
// of failure, is contradicted when the last command EG-Desk ran for the run counted a failing test, exited non-zero, or did not finish.
// facts (on an evidence item from egdesk-own-command-evidence.mjs): { kind: 'own_command', passed, failed, exitCode, stopped, hasSummary } (numbers and booleans only).
// c30 (L3 review of the c29 rule; probe in evidence/l3-c30/): the first version flagged every sentence that said "passed" against the LAST own command of any kind, which
// misfired on: an earlier pass quoted as such ("수정 전에는 통과했습니다", "Before my change the tests passed."), a plan or prediction ("통과하도록 고치겠습니다", "Tests should pass once
// this is fixed."), a question ("통과했나요?"), the negation "안 됐어요", another suite or thing ("A 모듈 테스트는", "연결 테스트에 성공했습니다"), and a last command that was no test run at all
// (a `grep` that exited 1 contradicting "테스트가 통과했습니다"). Now a sentence is contradicted only when (1) it STATES a pass now (no word of failure, contrast, earlier time, plan, condition or
// question), (2) it names a topic (tests, build, lint, type check; or says everything did), (3) the last own command OF THAT TOPIC failed, was stopped or never finished, and (4) a scope the
// sentence names ("payroll 테스트") is one the command's own line carries; a named scope the command does not carry is another suite: not this rule's business.
// facts (on an evidence item from egdesk-own-command-evidence.mjs): { kind: 'own_command', passed, failed, exitCode, stopped, hasSummary, topic, command } (numbers, booleans, a closed word and
// the command line the evidence text already quotes; in-process only, never sent as a field).
const NEGATED = /(?:^|\s)안\s?(?:됐|돼|되|했|함|통과|성공|패스)/
const FAIL_WORDS = /실패|오류|에러|않|못|아니|아닙|아닌|제외|빼고|제외하고|예외|(?:^|\s)안\s?(?:됐|돼|되|했|함|통과|성공|패스)|fail|error|not\b|n't|\bnever\b|except|but\b|still|지만|는데|하나|일부/i
const EARLIER = /이전|앞서|예전|지난|처음에는|처음엔|원래|수정 전|고치기 전|바꾸기 전|전에는|전엔|그때|\bearlier\b|\bbefore\b|\bpreviously\b|\bused to\b|\boriginally\b|\bat first\b|\blast time\b|\bthen\b|\bhad passed\b/i
const PLAN = /겠|ㄹ 것|을 것|할 것|될 것|예정|도록|하면|되면|려면|면 됩니다|\bif\b|\bonce\b|\bshould\b|\bwill\b|\bwould\b|\bcould\b|'ll\b|\bgoing to\b|\bneed(?:s)? to\b|\bhope\b|확인해 보|해 보|해볼|돌려 보|지켜보/i
const QUESTION = /[?？]|나요|까요|ㄴ가요|는지|인지|\bwhether\b|\bdid\b|\bdoes\b|\bdo\b.*\?/i
const PASS_WORD = /통과|성공|패스|\bpass(?:ed|es|ing)?\b|\bsucce(?:ss|ed|eded|eds)\b|\bgreen\b/i
const TOPICS = Object.freeze([
  { topic: 'test', words: /테스트|\btests?\b|\bsuites?\b|\bspecs?\b/i },
  { topic: 'build', words: /빌드|\bbuild\b|컴파일|\bcompil/i },
  { topic: 'lint', words: /린트|\blint(?:er|ing)?\b|\beslint\b/i },
  { topic: 'typecheck', words: /타입 ?체크|타입 검사|\btype[- ]?check|\btsc\b/i },
])
const UNIVERSAL = /모든|전부|모두|전체|\ball\b|\bevery\b|\beverything\b/i
// words before the topic word that are not a scope: quantifiers, deictics and the like
const GENERIC = new Set(['모든', '전체', '모두', '전부', '이번', '방금', '요청하신', '실행한', '해당', '위', '그', '이', '다시', '지금', '현재', '최종', '마지막', '기존', '새', '새로운', '모든', 'all', 'every', 'the', 'these', 'those', 'my', 'our', 'your', 'new', 'full', 'whole', 'final', 'last', 'latest', 'now', 'also', 'and', 'both', 'of', 'a', 'an', 'did', '도', '를', '을', '는', '은', '이', '가', '와', '과'])
const words = text => String(text ?? '').toLowerCase().match(/[\p{L}\p{N}_.\/-]+/gu) ?? []

/** The topic of a command line, by its program and arguments (code, no judgment): 'test' | 'build' | 'lint' | 'typecheck' | 'other' (clearly no check: ls, cat, git, ...) | null (unknown). */
export function commandTopic(command, { hasSummary = false } = {}) {
  const c = String(command ?? '').toLowerCase()
  if (!c.trim()) return hasSummary ? 'test' : null
  if (/\b(?:tsc\b.*--noemit|tsc\s+-p\b.*--noemit|typecheck|type-check|check:types|mypy|pyright)\b|\btsc\s+--noemit/.test(c)) return 'typecheck'
  if (/\b(?:eslint|lint|ruff|flake8|pylint|clippy|stylelint|prettier\s+--check)\b/.test(c)) return 'lint'
  if (/\b(?:test|tests|jest|vitest|pytest|mocha|rspec|phpunit|ctest)\b|--test\b|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b|\bmake\s+(?:check|test)\b/.test(c) || hasSummary) return 'test'
  if (/\b(?:build|compile|tsc|webpack|vite\s+build|cargo\s+build|make|gradle|mvn|cmake)\b/.test(c)) return 'build'
  if (/^(?:\s*(?:cd\s+\S+\s*(?:&&|;)\s*)?)(?:ls|cat|grep|rg|git|echo|sed|awk|head|tail|find|pwd|which|wc|mkdir|touch|cp|mv|rm|diff|sleep|printf|stat|file|tree)\b/.test(c)) return 'other'
  return null
}

/** A sentence that STATES a pass now, as { topics, scope } (topics: 'test' | 'build' | 'lint' | 'typecheck' | 'any'; scope: words naming a particular suite or thing), or null. */
export function passClaim(text) {
  const t = String(text ?? '')
  if (!PASS_WORD.test(t) || FAIL_WORDS.test(t) || EARLIER.test(t) || PLAN.test(t) || QUESTION.test(t)) return null
  const topics = TOPICS.filter(x => x.words.test(t)).map(x => x.topic)
  if (!topics.length && !UNIVERSAL.test(t)) return null // a lone "성공했습니다" about something else
  // the scope: the words just before the topic word that are no quantifier or deictic ("payroll 테스트" -> payroll)
  const scope = []
  if (topics.length) {
    const w = words(t), at = w.findIndex(x => TOPICS.some(y => y.words.test(x)))
    for (const x of w.slice(Math.max(0, at - 3), Math.max(0, at))) if (!GENERIC.has(x) && !/^(?:was|were|is|are|has|have)$/.test(x) && !PASS_WORD.test(x)) scope.push(x)
  }
  return { topics: topics.length ? topics : ['any'], scope }
}

/** Does a sentence say that the tests (or the run) passed, with no word of failure? */
export const claimsPass = text => passClaim(text) !== null

// c30b: a claim that a file was changed, against the edits EG-Desk made (facts of kind own_edit: path, state previewed | applied | undone | not_applied | not_undone, tool, editId).
// A sentence that says a change was made (no negation, no plan, no mention of a preview) is contradicted when the file it names was only previewed, undone or never applied, when it names
// a file the run made no edit to, or, naming no file, when the run applied no edit at all. A sentence about a preview ("dryRun 미리보기로 확인했습니다") is not a claim of a change.
const EDIT_DONE = /수정했|고쳤|고쳐 ?놓|바꿨|바꾸었|변경했|적용했|반영했|편집했|교체했|추가했|삭제했|지웠|작성했|만들었|\b(?:edited|changed|fixed|applied|updated|modified|replaced|wrote|written|patched)\b/i
// one exclusion for both rules (c30): a plan or condition (PLAN), a question (QUESTION) and the negation "안 했/안 됐" (NEGATED); the edit rule adds what is its own (a preview, an undo, "not yet")
const EDIT_OWN_NOT_CLAIM = /하지 않|않았|않습|못했|아직|할 수 있|할게|하려|계획|제안|가능|필요|미리보기|dryRun|\bpreview|\bnot\b|n't|되돌|undo|undid|restor|복원|취소|다면|면 /i
const PATH_TOKEN = /[\w./-]+\.(?:mjs|cjs|js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|sh|json|md|css|scss|html|yml|yaml|toml|txt|sql|xml)\b/gi
const base = p => String(p).split('/').pop()
export const claimsEdit = text => { const t = String(text ?? ''); return EDIT_DONE.test(t) && !EDIT_OWN_NOT_CLAIM.test(t) && !PLAN.test(t) && !QUESTION.test(t) && !NEGATED.test(t) }

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
export function lastRunFacts(evidence, topic = null) {
  const facts = (Array.isArray(evidence) ? evidence : []).filter(item => item && item.opaque !== true && item.facts?.kind === 'own_command')
    .filter(item => topic === null || (topic === 'any' ? item.facts.topic !== 'other' : item.facts.topic === topic || (topic === 'test' && (item.facts.topic ?? null) === null)))
  return facts.length ? { facts: facts.at(-1).facts, id: facts.at(-1).id } : null
}

const didNotPass = f => f.stopped === true || (Number.isFinite(f.failed) && f.failed >= 1) || (Number.isSafeInteger(f.exitCode) && f.exitCode !== 0) || (f.exitCode === null && !(Number.isFinite(f.failed) && f.hasSummary))

/** Findings of kind 'contradicted' for the sentences (claims: [{ text }]) that state a pass while the last command of that topic did not pass. */
export function runFactFindings({ claims, evidence }) {
  const edits = editClaimFindings({ claims, evidence }), tests = testClaimFindings({ claims, evidence }), merges = mergeClaimFindings({ claims, evidence })
  const first = [...tests, ...merges.filter(m => !tests.some(t => t.span === m.span))]
  return [...first, ...edits.filter(e => !first.some(t => t.span === e.span))]
}

// c30: pass claims by topic (tests, build, lint, type check), each against the last own command of that topic
function testClaimFindings({ claims, evidence }) {
  const out = []
  ;(Array.isArray(claims) ? claims : []).forEach((span, index) => {
    const claim = passClaim(span?.text)
    if (!claim) return
    for (const topic of claim.topics) {
      const last = lastRunFacts(evidence, topic)
      if (!last || !didNotPass(last.facts)) continue
      // a suite or thing the sentence names that the command's own line does not carry is another one: not this rule's business
      const line = String(last.facts.command ?? '').toLowerCase()
      if (claim.scope.length && line && !claim.scope.some(word => line.includes(word))) continue
      out.push({ kind: 'contradicted', span: index, evidence: [last.id], reason: 'run_facts' }); return
    }
  })
  return out
}
