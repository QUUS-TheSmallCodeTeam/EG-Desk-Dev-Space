// Test doubles for the c20 entry predicates (egdesk-browser-task.mjs entryQuestions): the request predicate `browser_entry` (is it
// something to do in a web page) and one `browser_entry_card_N` per card. A double that means "card N" answers that card decided yes
// and the others decided no; one that means "not a browser task" answers the request decided no.
export const ENTRY_NAME = /^browser_entry(_card_\d+|_wall_\d+|_answer)?$/
export const isEntryQuestion = name => ENTRY_NAME.test(name)
/** Wire answers ([{ name, type, probability }]) for the entry questions in `questions`; other questions are left out. */
export function entryWire(questions, { card = 0, web = 0.95, cardP = 0.95, otherP = 0.03 } = {}) {
  return questions.filter(q => isEntryQuestion(q.name)).map(q => {
    if (q.name === 'browser_entry') return { name: q.name, type: 'predicate', probability: web }
    // c29: "answerable without any open page": decided yes exactly when the double means "not a browser task" (the request decided no)
    if (q.name === 'browser_entry_answer') return { name: q.name, type: 'predicate', probability: web <= 0.25 ? 0.95 : 0.03 }
    if (/^browser_entry_wall_\d+$/.test(q.name)) return { name: q.name, type: 'predicate', probability: otherP } // c23: an ordinary page is not an interruption
    const index = Number(q.name.slice('browser_entry_card_'.length))
    return { name: q.name, type: 'predicate', probability: card === index ? cardP : otherP }
  })
}
/** The same as a normalized answers object (the client's answers form). */
export const entryAnswersOf = (questions, options) => Object.fromEntries(entryWire(questions, options).map(({ name, ...rest }) => [name, rest]))
