// L8 c44 (action layer, U13 correction: what code can compute stays in code, R3): the person was asked to choose between listed candidates (a browser task paused with
// `choice_needed`) and answers with an ordinal ("두번째", "2번", "둘째", "마지막", "두 번째 사업자로 해 줘"). The ordinal means something only against the order of the asked list, which the step
// request did not carry (real, c63, V4: the step read the bare "두번째" at 0.60, under the 0.75 bar, so nothing was clicked and the person was asked the same question again; the
// same page and options read "두 번째 사업자로 해 줘" at 0.98). When the reply is NOTHING BUT an ordinal over a list that holds it, code resolves it; anything else is left to the model,
// which is given the asked list.
// the leading ordinal, longest forms first; the digit forms are 1 to 3 (a question lists at most three candidates). "이번" (this time) is deliberately not an ordinal.
const LEADS = [
  [/^맨 ?마지막/, 'last'], [/^맨 ?끝/, 'last'], [/^마지막/, 'last'],
  [/^(?:첫 ?번째|첫 ?번|첫째|1 ?번째|1 ?번|처음|1(?![0-9]))/, 0],
  [/^(?:두 ?번째|두 ?번|둘째|2 ?번째|2 ?번|2(?![0-9]))/, 1],
  [/^(?:세 ?번째|세 ?번|셋째|3 ?번째|3 ?번|3(?![0-9]))/, 2],
]
const NOUN = '(?: ?(?:사업자|항목|옵션|번호|거|것|걸|꺼|껄))?'
const PARTICLE = '(?:(?:으)?로|이요|이에요|예요|입니다|요)?'
const ENDING = '(?: ?(?:해 ?줘|해 ?주세요|해요|할게요?|할래요?|갈게요?|부탁해요?|부탁드려요|진행해 ?줘|진행해 ?주세요))?'
const REST = new RegExp(`^${NOUN}${PARTICLE}${ENDING}[.!~ ]*$`)

const cleanLabel = text => String(text ?? '').replace(/^\[[A-Z]\d+\]\s*/, '').replace(/\s+/g, ' ').trim()

/**
 * resolveChoiceReply(message, candidates) -> { index, label, how: 'ordinal' | 'last' } | null
 * Only a message that is nothing but an ordinal (optionally with the noun, a particle and a polite verb) over a list that holds it. "마지막" is the last of the list. Anything with another word
 * ("2번 말고", "두번째 말고 첫번째", "아래 거", "두번째로 하고 나중에 알려줘"), an ordinal beyond the list, an empty list, or a single candidate: null (nothing is guessed).
 */
export function resolveChoiceReply(message, candidates) {
  const list = (Array.isArray(candidates) ? candidates : []).map(cleanLabel).filter(Boolean)
  if (list.length < 2 || typeof message !== 'string') return null
  const text = message.normalize('NFC').trim().replace(/\s+/g, ' ')
  if (!text || text.length > 40) return null
  for (const [lead, which] of LEADS) {
    const m = lead.exec(text)
    if (!m || !REST.test(text.slice(m[0].length))) continue
    const index = which === 'last' ? list.length - 1 : which
    return index < list.length ? { index, label: list[index], how: which === 'last' ? 'last' : 'ordinal' } : null
  }
  return null
}

/** The reply with the asked list in the order the person saw it (what the step gets when code cannot resolve the reply). */
export function choiceListLine(message, candidates, { maxChars = 400 } = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).map(cleanLabel).filter(Boolean)
  const said = String(message ?? '').replace(/\s+/g, ' ').trim().slice(0, maxChars)
  return list.length < 2 ? said : `${said}\n(The person had been asked to choose between, in this order: ${list.map((label, i) => `${i + 1}. ${label}`).join(' / ')})`
}

/** The user-context line for the step: the resolved choice by name, or the reply with the asked list in the order the person saw it. */
export function choiceContextLine(message, candidates, { maxChars = 400 } = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).map(cleanLabel).filter(Boolean)
  const said = String(message ?? '').replace(/\s+/g, ' ').trim().slice(0, maxChars)
  if (list.length < 2) return said
  const hit = resolveChoiceReply(message, list)
  if (!hit) return choiceListLine(message, list, { maxChars })
  const order = list.map((label, i) => `${i + 1}. ${label}`).join(' / ')
  return `Chose "${hit.label}" (option ${hit.index + 1} of the options the person was asked to choose between, in this order: ${order}); the person said: ${said}`
}
