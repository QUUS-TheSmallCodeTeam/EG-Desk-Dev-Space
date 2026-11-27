import test from 'node:test'
import assert from 'node:assert/strict'
import { createPageToolsWiring } from './egdesk-page-tools-wiring.mjs'
import { PAGE_TOOL_NAMES as T } from './egdesk-page-tools.mjs'
import { pageStateAnswers } from './egdesk-browser-page-state.fixture.mjs'
import { NAMED_CHANGE } from './egdesk-browser-tool-runtime.mjs'

const controls = [
  ...[['r','radio','Medium'], ['c','checkbox','Bacon']].map(([ref,role,label]) => ({ref, role, label, tag:'input', checked:false, value:'unchecked', choice:{inForm:true}})),
  {ref:'s',role:'combobox',label:'List',tag:'select',value:'1',choice:{},options:[{label:'One',value:'1'},{label:'Two',value:'2'}]},
  ...['Start','Login','Pay','Delete','POST'].map(label => ({ref:label,role:'button',tag:'button',label,nav:{standalone:label !== 'POST',form:label === 'POST' ? {method:'post'} : null,sensitiveRegion:false,regionLabel:'',regionLabels:[]}})),
  {ref:'setting',role:'checkbox',label:'Notifications',tag:'input',checked:false,choice:{inForm:false}},
]
function rig({message='피자 크기 중간으로 골라줘, 제출하지 마',pick='check Medium',explicit=true,state='content',receipt='postcondition-observed'}={}) {
  let seq=0, decisions=0, current=true; const actions=[]
  const run={runId:'r',browserBinding:{cards:[{cardId:'c',permission:'interact'}]}}
  const scope={isDecisionCurrent:()=>current, authorizeDispatch:()=>current,client:{decide:async ({input,questions})=>{
    decisions++; assert.ok(input[1].content.includes('Goal: '+message)); assert.ok(!input[1].content.includes('SECRET_BODY'))
    const value=questions[0].choices.find(o=>o.value.endsWith(pick))?.value ?? 'blocked'
    return {answers:{...pageStateAnswers(state),next_step:{type:'choice',choice:value,confidence:.99,probabilities:[{value,probability:.99},{value:'other',probability:.01}]},goal_met:{type:'predicate',probability:.01},choice_requested:{type:'predicate',probability:explicit?.99:.01}}}
  }}}
  const browser={runDirectTask(){},reflexScope:()=>scope,dispatch:async (_,event)=>{
    if(event.tool!== 'egdesk_browser_observe') actions.push(event)
    const data=event.tool==='egdesk_browser_observe'?{observationId:'o',snapshot:{revision:1,url:'https://example.org/form',text:['SECRET_BODY'],interactiveElements:controls}}:{status:receipt}
    return {success:true,contentItems:[{text:JSON.stringify(data)}]}
  }}
  const page=createPageToolsWiring({env:{EGDESK_PAGE_TOOLS:'on'},getChat:()=>({browserToolProvider:()=>browser,browserTaskMessage:()=>message})}).toolProviders[0]
  const call=async(tool,args)=>JSON.parse((await page.dispatch(run,{tool,arguments:args,callId:String(++seq)})).contentItems[0].text)
  return {call,actions,revoke:()=>{current=false},count:()=>decisions, marks:async()=>Object.fromEntries((await call(T.read,{mode:'structure'})).elements.map(e=>[e.ref,e.act]))}
}
test('only the loop-selected choice gets auto; select uses the actual value, never a press or arbitrary fill',async()=>{
  for(const [ref,message,pick,desired] of [['r','피자 크기 중간으로 골라줘, 제출하지 마','check Medium','checked'],['c','Check Bacon','check Bacon','checked'],['s','Select Two','List: Two','2']]) {
    const h=rig({message,pick}); const marks=await h.marks(); assert.equal(marks[ref],'auto'); assert.equal(marks.Login,'person'); assert.equal(marks.Pay,'person'); assert.equal(marks.Delete,'approval'); assert.equal(marks.POST,'approval'); assert.equal(marks.setting,'approval')
    if(ref==='s'){await h.call(T.type,{ref,text:'One'}); await h.call(T.press,{ref}); assert.equal(h.actions.length,0)}
    const result=await h.call(ref==='s'?T.type:T.press,{ref,text:'Two'});assert.equal(result.via,'auto');assert.equal(h.actions[0].arguments.postcondition.value,desired);assert.equal(h.count(),1)
  }
})
test('one named click per run, verified same-document postcondition only; no automatic retry',async()=>{
  const h=rig({message:'Press Start',pick:'Start',receipt:'postcondition-unverified'});assert.equal((await h.marks()).Start,'auto');assert.equal((await h.call(T.press,{ref:'Start'})).status,'not_done');assert.equal(h.actions[0].arguments.postcondition,NAMED_CHANGE);assert.equal((await h.marks()).Start,'approval');await h.call(T.press,{ref:'Start'});assert.equal(h.actions.length,1)
})
test('no real message, undisclosed choice, sensitive page or expired scope: no tool argument can create proof',async()=>{
  for(const opts of [{message:null},{explicit:false},{state:'login_required'}]){const h=rig(opts);assert.equal((await h.marks()).r,'approval');await h.call(T.press,{ref:'r',message:'check Medium',goal:'check Medium'});assert.equal(h.actions.length,0)}
  const h=rig();await h.marks();h.revoke();await h.call(T.press,{ref:'r'});assert.equal(h.actions.length,0)
})
