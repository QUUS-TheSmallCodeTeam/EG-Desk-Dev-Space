// Closed, deterministic contrasts for the current Topic Memory UI and state
// transitions, not general fact checking. Sources: EGDeskMemoryEvidence.sys.mjs
// (topic controls and labels), egdesk-memory-http.mjs (topic-enable/disable),
// egdesk-memory-evidence.mjs (fresh generation after clear, no recovery).
export const TOPIC_ANSWER_LIMIT = 32 * 1024
export const TOPIC_ANSWER_HOLD_MS = 120_000
const term = /(?:동의\s*세대|consent\s+generation)/iu
const topic = /(?:주제\s*기억|topic\s+memory|membrain)/iu
const setting = /(?:공식|설정|메뉴|기능|항목|옵션|버튼|official|settings?|menu|feature|option|button)/iu
const recovery = /(?:자동으로\s*(?:복[구원]|되살|되돌|다시\s*(?:활성|켜))|자동\s*복[구원]|automatical(?:ly|l).*?(?:restor|recover|re-enabl))/iu
const revoke = /(?:철회|삭제|revok|revoc|withdraw|delet)/iu
const noPermission = /(?:동의|허용|권한|consent|permission|opt-in).{0,12}(?:없어도|필요\s*없|없이도?|무관|불필요)|(?:no|without|does not require)\s+(?:explicit\s+)?(?:consent|permission|opt-in)/iu
const assertion = /(?:입니다|있습니다|됩니다|합니다|[이에]요|다|죠|할 수 있(?:어|다|습니다)|(?:\bis\b|\bare\b|\bhas\b|\bcan\b|\bwill\b|\bdoes\b|\benables?\b|\brestores?\b|\brecovers?\b|\bworks?\b|\brequires?\b))(?=[\s.*_~]*$)|\b(?:is|are|has|can|will|does|enables?|restores?|recovers?|works?|requires?)\b/iu
const negativeIdentityOrRecovery = /(?:아니|아닙|아닌|않|못(?:해|하|합)|할 수 없|하지 마|안\s*(?:돼|됩|되|해|합)|\bnot\b|\bnever\b|\bno\b|\bcannot\b|\bcan't\b|\bdoesn't\b|\bisn't\b|\baren't\b|\bwon't\b)/iu
const local = /(?:이\s*(?:대화|채팅|문서)에서만|우리끼리|임시\s*(?:이름|표현|용어)|(?:대화|채팅)\s*한정|(?:only|just)\s+(?:in|for)\s+this\s+(?:chat|conversation)|local\s+(?:shorthand|nickname)|working\s+name)/iu
const report = /(?:라는\s*(?:말|표현|단어|문장|인용)|라고\s*(?:말|물|했|쓴|인용)|\b(?:quoted|wrote|asked|said|the phrase|the quote)\b)/iu

// These Korean forms distinguish what is denied from what is asserted. Do not
// treat every occurrence of '없다' or '아니라' as sentence-wide negation.
const missingSetting = /동의\s*세대[”"’']?라는\s*(?:설정|메뉴|기능|항목|옵션|버튼)(?:이|가|은|는)?\s*없(?:습니다|어요|다)$/u
const officialCorrection = /^[“"‘']?동의\s*세대[”"’']?(?:는|란|라는)\s*임시\s*(?:이름|표현|용어)(?:이|가)\s*아니라\s*공식\s*설정(?:입니다|이에요|이다)$/u
const cannotUse = /(?:켤|쓸|사용할|활성화할)\s*수\s*없(?:습니다|어요|다)$/u
const permissionNotNeeded = /(?:동의|허용|권한)(?:가|이|은|는)?\s*필요\s*없어요$/u
const recoveryImpossible = /(?:자동\s*복[구원]|자동으로\s*복[구원](?:되|하)는\s*것)(?:가|이|은|는)?\s*불가능(?:합니다|해요|하다)$/u
const recoveryCorrection = /자동\s*복[구원]가\s*안\s*되는\s*(?:게|것이)\s*아니라\s*자동\s*복[구원](?:됩니다|돼요|된다)$/u

export function topicAnswerContradiction(text) {
  // Only normalize a scan copy. Preserve the original approved bytes. Keep a
  // quoted *name* available for predication, but skip standalone/report quotes.
  const scan = text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/gu, '').replace(/[\t ]+/gu, ' ')
  for (const match of scan.matchAll(/[^.!?。！？;\n]+(?:[.!?。！？][”’"'`]?)?/gu)) {
    const sentence = match[0].trim().replace(/^\s*(?:[-*]\s+|\d+\.\s+)/u, '')
    if (!sentence || /[?？]\s*$/u.test(sentence) || /^(?:>\s*|[“"‘'`])[^]*[”"’'`]\s*[.!。]?$/u.test(sentence)) continue
    const clause = sentence.replace(/[.!。！]\s*$/u, '')
    if (officialCorrection.test(clause)) return 'term-identity'
    if (report.test(sentence)) continue
    if (topic.test(clause) && permissionNotNeeded.test(clause)) return 'permission'
    if (!assertion.test(clause)) continue
    // Permission-negative here is the *contradiction*; don't exempt it as a
    // grammatical negation. Statements denying automatic recovery are safe.
    if (topic.test(clause) && noPermission.test(clause) && !cannotUse.test(clause) && !/(?:않|아니|아닙|안\s*(?:돼|됩|되)|cannot|can't|does not work)/iu.test(clause)) return 'permission'
    const recoveryClaim = topic.test(clause) && revoke.test(clause) && recovery.test(clause)
    if (recoveryClaim && recoveryCorrection.test(clause)) return 'recovery'
    if (negativeIdentityOrRecovery.test(clause)) continue
    if (recoveryClaim && !recoveryImpossible.test(clause)) return 'recovery'
    if (term.test(clause) && setting.test(clause) && !local.test(clause) && !missingSetting.test(clause)) return 'term-identity'
  }
  return null
}
