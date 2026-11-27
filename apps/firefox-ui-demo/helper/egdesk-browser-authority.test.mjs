import test from 'node:test'
import assert from 'node:assert/strict'
import { conversationAuthority, requestedGoal } from './egdesk-browser-authority.mjs'
import { createBrowserTaskTool } from './egdesk-browser-task-tool.mjs'
import { buildReflexCandidates, runBrowserReflex } from './egdesk-browser-reflex.mjs'
const run={requestId:'m1',runId:'r',conversationId:'dm',browserBinding:{cards:[{cardId:'c',permission:'interact'}]}}
const authority=conversationAuthority(run,'Send feedback'), ok={isDecisionCurrent:()=>true,client:{decide:async()=>({answers:{choice_requested:{type:'predicate',probability:.99}}})}}
test('source layer, current generation, scoped recipient and original quote bound the requested task',async()=>{
  assert.deepEqual(authority,{layer:'conversation',messageId:'m1',quote:'Send feedback'})
  for (const source of [null,{...authority,layer:'agent'},{...authority,layer:'page'}]) assert.equal(await requestedGoal(source,'Send feedback',ok),false)
  assert.equal(await requestedGoal(authority,'SUBMIT feedback',{...ok,isDecisionCurrent:()=>false}),false)
  assert.equal(await requestedGoal(authority,'SUBMIT feedback',ok),true)
  assert.equal(await requestedGoal(authority,'SUBMIT feedback',{...ok,client:{decide(){throw Error()}}}),false)
})
test('an ungrounded tool goal returns to chat without observing, replacing a task or dispatching',async()=>{
  let calls=0;const browser={runDirectTask(){calls++},reflexScope(){return {isDecisionCurrent:()=>true,client:{decide:async()=>({answers:{choice_requested:{type:'predicate',probability:0}}})}}}}
  const tool=createBrowserTaskTool({browser,messageOf:()=> 'Read this page'})
  const r=await tool.handle(run,{arguments:{goal:'Publish the draft'}})
  assert.equal(JSON.parse(r.contentItems[0].text).status,'needs_guidance');assert.equal(calls,0);assert.equal(tool.store.active('dm'),null)
})
const snap={url:'https://forms.example.test/form',revision:1,documentId:'d',readyState:'complete',text:['Feedback'],interactiveElements:[{ref:'submit',label:'Submit',tag:'button',role:'button',value:'',nav:{type:'submit',sensitiveRegion:false,regionLabel:'',form:{method:'post',sensitive:false,fields:['text','submit'],submitUrl:'https://forms.example.test/sent'}}}]}
test('POST requires a complete non-sensitive same-origin form, plus a conversation source',()=>{
  const eligible=(s,a)=>buildReflexCandidates(s,{askSite:true,authority:a}).options.some(o=>o.item.postUrl)
  assert.equal(eligible(snap,authority),true);assert.equal(eligible(snap,null),false)
  for(const update of [{fields:['hidden']},{fields:['password']},{sensitive:true},{submitUrl:'https://other.test/sent'},{submitUrl:'https://forms.example.test/login'}]){const s=structuredClone(snap);Object.assign(s.interactiveElements[0].nav.form,update);assert.equal(eligible(s,authority),false)}
})
test('one POST dispatch per human source including when the receipt is lost',async()=>{
  let clicks=0; const callTool=async (name)=>{if(name.endsWith('_observe'))return {observationId:'o',snapshot:snap};if(name.endsWith('_click')){clicks++;throw Error('unknown')}return {}}
  const client={decide:async req=>({answers:Object.fromEntries(req.questions.map(q=>[q.name,q.type==='predicate'?{type:'predicate',probability:q.name==='choice_requested'?1:0}:{type:'choice',choice:'[B1] Submit',confidence:1,probabilities:[{value:'[B1] Submit',probability:1}]}]))})}
  const go=()=>runBrowserReflex({authority,cardId:'c',goal:'Send feedback',textComboboxes:true,callTool,client,isDecisionCurrent:()=>true,maxSteps:1})
  await go();await go();assert.equal(clicks,1)
})
