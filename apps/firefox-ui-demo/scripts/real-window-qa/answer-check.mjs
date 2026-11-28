// QA tooling: negation-robust answer check. claimsPositively(text, re) is true only if a sentence matches `re` and is not negated (않/없/못/아니/불가/확인되지/뜻하지...), so "승인됐다고 확인할 수 없습니다" is not a positive claim of approval.
const NEG = /않|없|못\s|못한|아니|불가|확인되지|뜻하지|미확인|아직|전에는|기다|안 됐|안됐/
export const splitSentences = t => String(t).replace(/\s+/g, ' ').split(/[.!?。]\s*|(?<=(?:니다|세요|어요|아요|해요|예요|이에요|입니다))\s+/).map(s => s.trim()).filter(Boolean)
export const claimsPositively = (text, re) => { const r = new RegExp(re); return splitSentences(text).some(s => r.test(s) && !NEG.test(s)) }
