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

/** The reading of the last own command in the evidence, or null. */
export function lastRunFacts(evidence) {
  const facts = (Array.isArray(evidence) ? evidence : []).filter(item => item && item.opaque !== true && item.facts?.kind === 'own_command')
  return facts.length ? { facts: facts.at(-1).facts, id: facts.at(-1).id } : null
}

/** Findings of kind 'contradicted' for the sentences (claims: [{ text }]) that say the tests passed while the last run says otherwise. */
export function runFactFindings({ claims, evidence }) {
  const last = lastRunFacts(evidence)
  if (!last) return []
  const f = last.facts
  const contradicted = f.stopped === true || (Number.isFinite(f.failed) && f.failed >= 1) || (Number.isSafeInteger(f.exitCode) && f.exitCode !== 0) || (f.exitCode === null && !(Number.isFinite(f.failed) && f.hasSummary))
  if (!contradicted) return []
  return (Array.isArray(claims) ? claims : []).map((span, span_i) => ({ span, span_i })).filter(({ span }) => claimsPass(span.text))
    .map(({ span_i }) => ({ kind: 'contradicted', span: span_i, evidence: [last.id], reason: 'run_facts' }))
}
