import test from 'node:test'
import assert from 'node:assert/strict'
import { runBrowserReflex } from './egdesk-browser-reflex.mjs'
import { codeEntryCard, readBrowserEntry } from './egdesk-browser-task.mjs'
import { requestedMotion } from './egdesk-browser-motion.mjs'
import { pageStateAnswers } from './egdesk-browser-page-state.fixture.mjs'
const base = 'https://example.com/'
async function exercise(goal, { read, target = base, state = 'content' }) {
  const motion = requestedMotion(goal), calls = [], requests = []; let i = 0
  const out = await runBrowserReflex({ goal, cardId: 'card', client: { async decide(r) {
    requests.push(r); const v = 'move_' + motion
    assert.ok(r.questions.find(q => q.name === 'next_step').choices.some(o => o.value === v))
    return { latencyMs: 1, answers: { ...pageStateAnswers(state, 0.99), goal_met: { type: 'predicate', probability: 1 }, next_step: { type: 'choice', choice: v, confidence: .99, probabilities: [{ value: v, probability: .99 }, { value: 'blocked', probability: .01 }] } } }
  } }, callTool: async (tool, args) => {
    calls.push({ tool, args }); if (tool === 'egdesk_browser_history') return { status: 'history-dispatched', dispatchReceipt: { targetUrl: target } }
    if (tool === 'egdesk_browser_observe') { const snapshot = { url: base, revision: i+1, documentId: 'doc', interactiveElements: [], ...read(i++) }; return { observationId: 'obs'+i, snapshot } }
    assert.equal(tool,'egdesk_browser_scroll'); return {status:'postcondition-observed'}
  } }); return { out, calls, requests }
}
test('single granted card named for a standalone motion, not multi-card or quoted instructions', () => {
 const cards = [{cardId:'card', host:'example.com'}], codeCard = codeEntryCard('뒤로 가줘',cards)
 assert.equal(codeCard,'card'); assert.equal(readBrowserEntry({browser_entry:{type:'predicate',probability:.99}}, cards,{codeCard}).kind,'browser')
 assert.equal(codeEntryCard('뒤로 가줘',[...cards,...cards]),null)
 for (const g of ['뒤로 가지 말아줘','뒤로 가줘 영어로 어떻게 말해?', '맨 아래까지 내려줘 그리고 링크 열어줘']) assert.equal(requestedMotion(g),null)
})
for (const [goal, dir] of [['뒤로 가줘','back'],['앞으로 가줘','forward']]) test(goal+' verifies expected card history URL', async () => {
 const {out,calls} = await exercise(goal,{read: i => ({url:i ? base : base+'checkboxes'})}); assert.equal(out.outcome,'done'); assert.equal(out.observationId,'obs2'); assert.equal(out.url,base)
 assert.deepEqual(calls.map(c=>c.tool),['egdesk_browser_observe','egdesk_browser_history','egdesk_browser_observe']); assert.equal(calls[1].args.action,dir)
})
test('a changed but wrong history URL never proves the move', async () => {
 const {out,calls} = await exercise('뒤로 가줘',{read: i => ({url:base+(i?'unexpected':'checkboxes')})}); assert.equal(out.code,'BROWSER_ACTION_UNVERIFIED'); assert.equal(calls.filter(c=>c.tool.endsWith('history')).length,1)
})
for (const [goal,dir,before,after] of [['이 문서 맨 아래까지 내려줘','bottom',0,12900],['맨 위로 올려줘','top',12900,0],['조금 내려줘','down',20,740],['한 화면 올려줘','up',880,160]]) test(goal+' one guarded motion and fresh coordinates', async () => {
 const {out,calls,requests} = await exercise(goal,{read:i=>({scroll:{y:i?after:before,maxY:12900}})}); assert.equal(out.outcome,'done'); assert.equal(out.observationId,'obs2'); assert.equal(requests.length,1)
 assert.deepEqual(calls[1].args,{cardId:'card',observationId:'obs1',expectedRevision:1,direction:dir,amount:'page'}); assert.equal(calls.length,3)
})
test('bottom already reached: no dispatched action; no more model steps', async () => {
 const {out,calls} = await exercise('끝까지 내려줘',{read:()=>({scroll:{y:12900,maxY:12900}})}); assert.equal(out.outcome,'done'); assert.equal(calls.length,1)
})
test('append-on-scroll gives up with a closed reason after three fresh guarded moves', async () => {
 const {out,calls} = await exercise('끝까지 내려줘',{read:i=>({scroll:{y:i*1000,maxY:(i+1)*1000}})}); assert.equal(out.reason,'step_limit'); assert.deepEqual(calls.filter(c=>c.tool.endsWith('scroll')).map(c=>c.args.observationId),['obs1','obs2','obs3'])
})
test('no coordinates or a replacement document cannot satisfy a scroll goal', async () => {
 for(const read of [()=>({}),i=>({documentId:'doc'+i,scroll:{y:i*100,maxY:100}})]) { const {out}=await exercise('끝까지 내려줘',{read});assert.equal(out.code,'BROWSER_ACTION_UNVERIFIED') }
})
test('sensitive page state wins over a motion choice and even a high goal_met', async () => {
 const {out,calls} = await exercise('뒤로 가줘',{state:'two_factor_required',read:()=>({})}); assert.equal(out.outcome,'handoff'); assert.equal(calls.length,1)
})
// Exercise the chrome handler with its own closure dependencies, without starting Firefox.
test('chrome checks the card history target before dispatch, retains the redirect guard, and receipts only the permitted target', async () => {
 const {readFile} = await import('node:fs/promises'); const js = await readFile(new URL('../overlay/JS/eg-desk-surface.uc.js',import.meta.url),'utf8')
 const fn = js.split('const browserToolHistory = ')[1].split('\n    };')[0]+'\n    }'
 const log = []; const targetUrl = 'https://other.test/private'; const ctx = {assertBrowserToolBinding(){},assertGuardedDocumentCurrent(){},browserState:{history:[targetUrl,base],historyIndex:1},showAgentActivity(){},goBrowserBack(){log.push('back');return true},setAgentNavigationGuard(){log.push('guard')}}
 const handler = Function(...Object.keys(ctx),'return '+fn)(...Object.values(ctx))
 for (const permitted of [false,true]) { const run = handler({},'back',{url:base},{allowed:(to,from)=>{assert.equal(to,targetUrl);assert.equal(from,base);return {allowed:permitted}}}); if(permitted){assert.equal((await run).dispatchReceipt.targetUrl,targetUrl);assert.deepEqual(log,['back','guard'])} else {await assert.rejects(run);assert.deepEqual(log,[])} }
})
