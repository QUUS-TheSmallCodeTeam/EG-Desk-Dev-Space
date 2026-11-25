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

/** The reading of the last own command in the evidence, or null. */
export function lastRunFacts(evidence, topic = null) {
  const facts = (Array.isArray(evidence) ? evidence : []).filter(item => item && item.opaque !== true && item.facts?.kind === 'own_command')
    .filter(item => topic === null || (topic === 'any' ? item.facts.topic !== 'other' : item.facts.topic === topic || (topic === 'test' && (item.facts.topic ?? null) === null)))
  return facts.length ? { facts: facts.at(-1).facts, id: facts.at(-1).id } : null
}

const didNotPass = f => f.stopped === true || (Number.isFinite(f.failed) && f.failed >= 1) || (Number.isSafeInteger(f.exitCode) && f.exitCode !== 0) || (f.exitCode === null && !(Number.isFinite(f.failed) && f.hasSummary))

/** Findings of kind 'contradicted' for the sentences (claims: [{ text }]) that state a pass while the last command of that topic did not pass. */
export function runFactFindings({ claims, evidence }) {
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
