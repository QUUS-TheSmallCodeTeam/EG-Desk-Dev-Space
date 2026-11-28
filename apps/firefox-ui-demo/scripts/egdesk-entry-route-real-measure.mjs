// L51: real-model measurement of the entry's ROUTING decision (decideBrowserEntry) for the first-step cases, one open card each (shown lines as the live card gives them).
// usage: node scripts/egdesk-entry-route-real-measure.mjs <runs> [check|time|late|all]. The key is read from the stored attachment file and never printed.
import fs from 'node:fs'
import { createDecisionClient, decisionTopicRecipient } from '../helper/egdesk-decision-client.mjs'
import { decideBrowserEntry, observeCardLines } from '../helper/egdesk-browser-task.mjs'
const key = fs.readFileSync('/Users/minsoocha/.aside/u/0/sessions/2026-11-15_5yGDgeI9gUvBBXY9/attachments/openai-api-key-20261122.txt', 'utf8').split('\n').find(l => l.startsWith('OPENAI_API_KEY=')).slice(15).trim()
const client = createDecisionClient({ getApiKey: async () => key, recipientForKey: (v, e, m) => decisionTopicRecipient(v, 1, e, m), timeoutMs: 15000 })
let calls = 0
const counted = { decide: async a => { calls++; return client.decide(a) } }
import { formPage, latePage } from './egdesk-entry-first-step-pages.mjs'
const provider = page => ({ reflexScope: () => ({ callTool: async () => ({ observationId: 'o', snapshot: page }) }) })
const form0 = { cardId: 'c13', host: 'httpbin.org', pageTitle: '', title: '', shows: ['Customer name:', 'Telephone:', 'E-mail address:'], controls: [] }
const internet0 = { cardId: 'c6', host: 'the-internet.herokuapp.com', pageTitle: 'The Internet', title: 'The Internet', shows: ['Dynamically Loaded Page Elements', 'Example 2: Element rendered after the fact', 'Start'], controls: [] }
const formC = { cardId: 'c13', host: 'httpbin.org' }, netC = { cardId: 'c6', host: 'the-internet.herokuapp.com' }
const CASES = { check: ['토핑은 베이컨이랑 양파로 체크해줘, 제출하지 마', formC, formPage({ rev: 1, checked: {} })], time: ['배달 시간 저녁 7시 반으로 넣어줘, 제출하지 마', formC, formPage({ rev: 1, checked: {} })], late: ['Start 누르고 나오는 글자 알려줘', netC, latePage({ rev: 1, phase: 'idle' })] }
const n = +process.argv[2] || 3, which = process.argv[3] ?? 'all'
for (const [name, [message, card, page]] of Object.entries(CASES)) { if (which !== 'all' && which !== name) continue
  const rows = []
  for (let i = 0; i < n; i++) {
    const cards = await observeCardLines({ provider: provider(page), run: {}, message, cards: [card], enabled: true })
    const r = await decideBrowserEntry({ message, cards, client: counted })
    rows.push({ kind: r.kind, web: r.web, answerP: r.answerP, cards: r.cardsP, followUp: !!r.followUp, walls: r.wallsP })
  }
  console.log(JSON.stringify({ case: name, kinds: rows.map(r => r.kind), rows }))
}
console.log('total calls', calls)
