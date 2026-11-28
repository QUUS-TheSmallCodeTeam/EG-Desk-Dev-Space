import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReflexCandidates, reflexActionArgs, runBrowserReflex, controlLines } from './egdesk-browser-reflex.mjs'
import { pageStateAnswers } from './egdesk-browser-page-state.fixture.mjs'
globalThis.JSWindowActorChild ||= class {}
const { EGDeskBrowserAgentRuntimeChild } = await import('../overlay/resources/EGDeskBrowserAgentRuntimeChild.sys.mjs')
const a = new EGDeskBrowserAgentRuntimeChild()
const input = (type, name, value, label, form = {}) => ({ tagName: 'INPUT', type, checked: false, form, value, getAttribute: k => ({type,name})[k] ?? null,
  labels: [{ cloneNode: () => ({ textContent: label, querySelectorAll: () => [] }) }] })
const bacon = input('checkbox','topping','bacon','Bacon'), onion = input('checkbox','topping','onion','Onion'), medium = input('radio','size','medium','Medium'), time = input('time','delivery','','Preferred delivery time')
const select = { tagName:'SELECT', getAttribute:k => k === 'id' ? 'dropdown' : null, value:'1', selectedOptions:[{label:'Option 1'}], options:['1','2'].map(value=>({label:'Option '+value,value})) }
const observe = (n, ref) => ({ ref, tag:n.tagName.toLowerCase(), label:a.labelFor(n), value:a.valueFor(n), role:a.roleFor(n), ...a.choiceFacts(n) })
const page = els => ({documentId:'d',url:'https://httpbin.org/forms/post',revision:1,text:['PAGE BODY SENTINEL'],interactiveElements:els})
const args = option => reflexActionArgs(option, {cardId:'card', snapshot:{revision:1}, observationId:'obs', text:'저녁 7시 반'})
test('native observations and bounded guarded edits: wrapping labels, distinct states, select raw value (not its display label), time',()=>{
 const els=[medium,bacon,onion,time,select].map((n,i)=>observe(n,'el_'+i)); const options=buildReflexCandidates(page(els)).options
 assert.deepEqual(els.map(e=>e.label), ['Medium','Bacon','Onion','Preferred delivery time','dropdown']); assert.equal(els[1].choiceValue,'bacon'); assert.equal(els[1].checked,false)
 assert.deepEqual(options.map(o=>[args(o).tool,args(o).args.postcondition.value]), [['egdesk_browser_click','checked'],['egdesk_browser_click','checked'],['egdesk_browser_click','checked'],['egdesk_browser_fill','19:30'],['egdesk_browser_fill','2']]); assert.match(options.at(-1).value,/Option 2/)
 const on = {...els[1],checked:true,value:'checked'}; assert.equal(args(buildReflexCandidates(page([on])).options[0]).args.postcondition.value,'unchecked'); assert.match(controlLines(page([on])).join(' '),/Bacon.*checked/)
 const long = observe({...select, options:Array(40).fill({label:'same',value:'2'})},'s'); assert.equal(long.options.length,40); const longer = observe({...select, options:Array(70).fill({label:'same',value:'2'})},'s'); assert.equal(longer.options.length,64, 'L57: a list is carried up to 64 options (was 32)'); assert.equal(longer.choice.truncated,true); assert.equal(long.choice.truncated,false); assert.equal(buildReflexCandidates(page([long])).options.length,0)
 for (const e of [{...els[1],role:'switch'}, {...els[1],choice:{inForm:false}}, {...els[1],choice:{inForm:true,immediate:true}}, {...els[1],choice:{inForm:true,regionLabels:['Billing']}}, {...els[1],choice:{inForm:true,sensitiveRegion:true}}]) assert.equal(buildReflexCandidates(page([e])).options.length,0)
})
const choice = value => ({ type:'choice',choice:value,confidence:.99,probabilities:[{value,probability:.99},{value:'other',probability:.01}] })
async function toppings({explicit=true,verified=true}={}) {
 const controls=[{...bacon},{...onion}]; let seq=0; const calls=[]
 const callTool=async(name,arg)=>{ if(name==='egdesk_browser_observe')return {observationId:'o'+(++seq),snapshot:{...page(controls.map((n,i)=>observe(n,'el_'+i))),revision:seq}}
   assert.equal(name,'egdesk_browser_click'); assert.equal(arg.observationId,'o'+seq); assert.equal(arg.expectedTarget.value,'unchecked'); const n=controls[+arg.ref.at(-1)]; calls.push(n.value); n.checked=true
   assert.equal(a.valueFor(n),arg.postcondition.value);return {status:verified?'postcondition-observed':'postcondition-unverified'} }
 const client={decide:async ({input,questions})=>{assert.doesNotMatch(JSON.stringify(input),/PAGE BODY SENTINEL/);const q=questions.find(q=>q.name==='next_step'), pick=q.choices.find(o=>/\] check (Bacon|Onion)$/.test(o.value));return {answers:{...pageStateAnswers('content',.99),next_step:choice(pick?.value??'goal_met'),goal_met:{type:'predicate',probability:pick?.01:.99},choice_requested:{type:'predicate',probability:explicit?.99:.01}},latencyMs:1}}}
 return {result:await runBrowserReflex({cardId:'c',goal:'베이컨이랑 양파로 체크해줘, 제출하지 마',client,callTool,pageText:false}),calls,seq}
}
test('two separately observed checks, no load wait or submission; uncertain readback never advances', async()=>{
 const done=await toppings();assert.deepEqual(done.calls,['bacon','onion']);assert.equal(done.seq,3);assert.equal(done.result.outcome,'done'); assert.deepEqual((await toppings({explicit:false})).calls,[]); const bad=await toppings({verified:false});assert.deepEqual(bad.calls,['bacon']);assert.equal(bad.result.outcome,'escalated')
})
test('chosen delivery time consumes the one explicit clock, no chat fill or submission',async()=>{
 const field={...time}; let observed=0,typed=0
 const callTool=async(name,arg)=>{if(name==='egdesk_browser_observe') return {observationId:'o'+(++observed),snapshot:page([observe(field,'t')])};assert.equal(name,'egdesk_browser_fill');assert.equal(arg.text,'19:30');field.value=arg.text;typed++;assert.equal(observe(field,'t').value,arg.postcondition.value);return {status:'postcondition-observed'}}
 const client={decide:async({questions})=>({answers:{...pageStateAnswers('content',.99),next_step:choice(typed?'goal_met':questions[0].choices[0].value),goal_met:{type:'predicate',probability:typed?.99:.01}},latencyMs:1})}
 const r=await runBrowserReflex({cardId:'c',goal:'배달 시간 저녁 7시 반으로 넣어줘, 제출하지 마',client,callTool,pageText:false});assert.deepEqual([r.outcome,typed,observed],['done',1,2])
})
