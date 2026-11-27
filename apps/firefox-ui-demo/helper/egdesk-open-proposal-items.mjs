import { compactText, predicateQuestion } from './egdesk-decision-questions.mjs'
import { NO } from './egdesk-wiki-reconstruction.mjs'

// L1 c32 + L3 c33: the assistant's open proposals, questions and waiting actions (L3's registry: chat.openItemsFor / closeOpenItem, provider 'proposals') as items of the open-item
// resolver. The registry decides nothing: code lists, the Decision model reads. For a proposal with steps the message is read against the whole proposal (accept, decline) and, one
// question per step (R4), whether it leaves that step out ("응 근데 테스트는 빼고"). Applying only CLOSES the item and hands the engine closed words (which steps stay out): the engine
// does the accepted steps itself, as today. No copy for the person.
export const PROPOSAL_BARS = Object.freeze({ yes: 0.85, no: NO })
const KIND_OF = Object.freeze({ proposal: 'proposal', waiting_action: 'proposal', person_request: 'question' })
const quote = text => JSON.stringify(compactText(text, 300))

export function createProposalOpenItems({ chat, bars = PROPOSAL_BARS }) {
  const rows = key => { try { return chat.openItemsFor(key?.cid).filter(item => item.provider === 'proposals' && KIND_OF[item.kind] && typeof item.id === 'string').slice(-2) } catch { return [] } }
  return {
    id: 'proposals', builtin: true,
    items: key => rows(key).map(item => ({ id: item.id, kind: KIND_OF[item.kind], summary: compactText(`${item.kind === 'person_request' ? 'The assistant waits for the person to do or tell something' : 'The assistant proposed something and waits for the person\'s go-ahead'}: ${item.text}${item.steps?.length ? ` Steps: ${item.steps.map(s => `${s.n}) ${s.text}`).join(' ')}` : ''}`, 300) })),
    // names open_prop_<i>_accept / _decline / _skip_<n> (i = this provider's item number): the message is quoted in each, and only that proposal or that one step
    questions: (key, message) => rows(key).flatMap((item, i) => item.kind === 'person_request' ? [] : [
      predicateQuestion(`open_prop_${i}_accept`, `Message of the person: ${quote(message)}\nProposal of the assistant: ${quote(item.text)}\nDoes the message tell the assistant to go ahead with the proposal?`),
      predicateQuestion(`open_prop_${i}_decline`, `Message of the person: ${quote(message)}\nProposal of the assistant: ${quote(item.text)}\nDoes the message refuse the proposal or tell the assistant not to do it?`),
      ...(item.steps ?? []).map(step => predicateQuestion(`open_prop_${i}_skip_${step.n}`, `Message of the person: ${quote(message)}\nOne step of a proposed plan: ${quote(step.text)}\nDoes the message leave this one step out?`))]),
    read(answers, key, thresholds, item) {
      const list = rows(key), i = list.findIndex(x => x.id === item?.itemId)
      if (i < 0) return { kind: 'none' }
      if (list[i].kind === 'person_request') return { kind: 'settled', itemId: item.itemId, optionId: 'answer', skipped: [] }
      const p = name => { const a = answers?.[name]; return a?.type === 'predicate' && Number.isFinite(a.probability) ? a.probability : null }
      const accept = p(`open_prop_${i}_accept`), decline = p(`open_prop_${i}_decline`)
      if (accept === null || decline === null) return { kind: 'uncertain' }
      const steps = (list[i].steps ?? []).map(step => ({ n: step.n, p: p(`open_prop_${i}_skip_${step.n}`) }))
      if (steps.some(s => s.p === null)) return { kind: 'uncertain' }
      if (decline >= bars.yes && accept <= bars.no) return { kind: 'settled', itemId: item.itemId, optionId: 'decline', skipped: [] }
      if (accept >= bars.yes && decline <= bars.no) {
        if (steps.some(s => s.p > bars.no && s.p < bars.yes)) return { kind: 'uncertain' } // a step the Decision is unsure about is never guessed
        return { kind: 'settled', itemId: item.itemId, optionId: 'accept', skipped: steps.filter(s => s.p >= bars.yes).map(s => s.n) }
      }
      return { kind: 'uncertain' }
    },
    // closes the item; the engine is told the outcome in closed words and acts as it does today
    async apply({ cid, item, optionId, read }) {
      const skipped = Array.isArray(read?.skipped) ? read.skipped : []
      chat.closeOpenItem(cid, item.itemId, optionId)
      const settled = optionId === 'decline' ? 'declined' : optionId === 'answer' ? 'answered' : skipped.length ? 'accepted_without_steps' : 'accepted'
      return { handled: true, settled, note: `${item.id} ${settled}${skipped.length ? `; steps left out: ${skipped.join(', ')}` : ''}` }
    },
  }
}
