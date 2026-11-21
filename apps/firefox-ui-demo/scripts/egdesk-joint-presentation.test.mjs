import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPresentationController, presentationWorldBounds, PRESENTATION_DECISION_PATHS as paths }
  from '../overlay/resources/EGDeskJointPresentation.sys.mjs';
const ticket = 'a'.repeat(48);
const box = (x, y, width, height) => ({ x, y, width, height });
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const card = (id, x, y, extra = {}) => ({ id, title: `private ${id}`, rect: box(x,y,442,258), visible:true, canRead:true,
  revision:'lease:v1', kind:'자료', movable:true, pinned:false, maySendDescriptor:true, zIndex:21, body:'private body', ...extra });
function harness({mode = 'on', transport, mutate} = {}) {
  let scene = { ready:true, revision:'profile/board/layout', viewport:box(22,40,900,490), camera:{x:40,y:36,zoom:1,minZoom:.01,maxZoom:4},
    cards:[card('private-A',10,10),card('private-B',490,10),card('extra',700,386,{rect:box(700,386,100,80)}),
      card('hidden',12,14,{visible:false}),card('forbidden',12,14,{canRead:false})], obstacles:[],
    decision:{available:true,mode,revision:'decision-v1'} };
  mutate?.(scene);
  let time = 0;
  const commits = [], calls = [], dismissals = [];
  const prepared = body => ({status:'prepared', ticket, mode, expiresInMs:60_000, preview:{...body,
    items:body.items.map((c,i)=>({slot:String.fromCharCode(65+i),...c})),
    options:['keep','overview',...(body.items.some(c=>c.focus)? ['focus']:[]),
      ...(body.wide && body.tall && body.items.length===2 && body.items.every(c=>c.movable)? ['pair']:[])] }});
  const api = createPresentationController({now:()=>time, read:key=>key==='board' ? scene : null,
    dismiss:o=>dismissals.push(o), commit:(key,data)=>{
      commits.push({key,...structuredClone(data)});
      if (data.camera) Object.assign(scene.camera,data.camera);
      for (const t of data.targets) scene.cards.find(c=>c.id===t.id).rect = structuredClone(t.rect);
      return true;
    }, request:(path, body, {signal})=>{
      calls.push({path, body, signal});
      if(transport) { const custom=transport(path,body,signal,prepared); if(custom!==undefined) return custom; }
      if(path===paths.prepare) return prepared(body);
      if(path===paths.run) return mode==='advisory'? {status:'advisory-only',suggestion:'pair'} : {status:'preview',preview:'pair'};
      return {status:'cancelled'};
    }});
  return {api,get scene(){return scene;}, set scene(s){scene=s;}, set time(t){time=t;}, commits,calls,dismissals,prepared};
}

test('selected markers, real cards unchanged before explicit apply, selected-only pair and one inverse', () => {
  const {api, scene, commits, calls} = harness();
  const initial = structuredClone(scene);
  assert.equal(api.open('board'),true);
  assert.deepEqual(api.view().cards.map(c=>c.id),['private-A','private-B','extra']);
  assert.deepEqual(api.view().selected,['private-A','private-B']);
  assert.equal(api.view().plan.targets.length,0);
  api.select('forbidden',true);
  api.choose('pair');
  const {targets,camera} = api.view().plan;
  const bounds = presentationWorldBounds(scene);
  assert.equal(camera,null);
  assert.ok(targets[1].rect.x-(targets[0].rect.x+targets[0].rect.width)>=24);
  for(const {rect:r} of targets) {
    assert.ok(r.x>=bounds.x && r.y>=bounds.y && r.x+r.width<=bounds.x+bounds.width && r.y+r.height<=bounds.y+bounds.height);
    assert.ok(r.width<442 && r.height<=258 && r.width>=230 && r.height>=150);
  }
  assert.deepEqual(scene,initial);
  api.close(); assert.equal(commits.length,0); assert.equal(calls.length,0);
  api.open('board'); api.choose('pair'); assert.equal(api.apply(),true);
  assert.deepEqual(commits[0].targets,targets);
  assert.deepEqual(scene.cards.slice(2),initial.cards.slice(2));
  assert.deepEqual(scene.camera,initial.camera);
  assert.deepEqual(scene.cards.map(c=>c.zIndex),initial.cards.map(c=>c.zIndex));
  api.open('board'); assert.equal(api.view().undo,true); assert.equal(api.undo(),true);
  assert.deepEqual(scene,initial);
  api.open('board'); assert.equal(api.view().undo,false); assert.equal(api.undo(),false);
});

test('compare requires both threshold dimensions, exactly two movable unpinned cards, and clear hit area', () => {
  for (const mutate of [s=>s.viewport.width=663, s=>s.viewport.height=199, s=>s.cards[0].pinned=true,
    s=>s.cards[1].movable=false, s=>s.obstacles.push(box(-100,-100,2000,2000))]) {
    const {api}=harness({mutate}); api.open('board');
    assert.ok(!api.view().options.includes('pair')); api.choose('pair'); assert.equal(api.view().choice,'keep');
  }
  const {api} = harness({mutate:s=>{s.viewport.width=664;s.viewport.height=200;}});
  api.open('board'); assert.ok(api.view().options.includes('pair'));
  api.select('extra',true); assert.ok(!api.view().options.includes('pair'));
  api.select('private-B',false); assert.ok(api.view().options.includes('pair'));
});

test('overview and designated focus compute ghost camera frame and do not commit any cards', () => {
  const {api,scene,commits} = harness(); const initial=structuredClone(scene);
  api.open('board'); api.choose('overview');
  const whole=api.view().plan.framing;
  api.focus('private-B'); api.choose('focus');
  assert.ok(api.view().plan.framing.width < whole.width);
  assert.deepEqual(scene,initial); assert.equal(api.apply(),true);
  assert.deepEqual(commits[0].targets,[]); assert.notDeepEqual(scene.camera,initial.camera);
  api.open('board'); assert.equal(api.undo(),true); assert.deepEqual(scene,initial);
});

test('off and unknown authority are manual; lack of descriptor grant does not silently submit subset', async () => {
  for(const config of [{mode:'off'},{mode:'unknown'},{mutate:s=>s.decision.available=false},{mutate:s=>s.cards[0].maySendDescriptor=false}]) {
    const {api,calls} = harness(config); api.open('board'); assert.equal(api.view().canPrepare,false);
    await api.prepare('synthetic'); await api.confirm(); assert.equal(calls.length,0);
    api.choose('pair'); assert.equal(api.view().choice,'pair');
  }
});

test('prepare only sends exact closed DTO and provides exact provider review, confirmation serializes only ticket', async () => {
  const {api,calls,commits}=harness(); api.open('board'); await api.confirm(); assert.equal(calls.length,0);
  api.choose('focus'); await api.prepare('  Cafe\u0301  ');
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].body,{cue:'Café',items:[{kind:'자료',focus:true,movable:true},{kind:'자료',focus:false,movable:true}],wide:true,tall:true});
  assert.equal(api.view().phase,'review'); assert.equal(api.view().choice,'focus');
  const p=api.view().packet;
  assert.equal(p.model,'gpt-6-luna'); assert.equal(p.input[0].content[0].text,'Café');
  assert.deepEqual(p.input[0].content[1].data.selected,[{slot:'A',kind:'자료',designatedFocus:true},{slot:'B',kind:'자료',designatedFocus:false}]);
  assert.equal(p.questions[0].name,'board_view'); assert.equal(p.questions[0].choices.length,4);
  assert.doesNotMatch(JSON.stringify(p),/private|movable|lease/);
  const one=api.confirm(); await api.confirm(); await one;
  assert.deepEqual(calls.map(c=>c.path),[paths.prepare,paths.run]);
  assert.deepEqual(calls[1].body,{ticket,confirm:true});
  assert.equal(api.view().choice,'pair'); assert.equal(api.view().packet,null); assert.equal(commits.length,0);
});

test('advisory preserves prior preview and reports suggestion; failed or bad status never retries', async () => {
  for(const result of ['advisory', 'fail', 'mismatch']) {
    const {api,calls}=harness({mode:'advisory',transport:path=>path===paths.run && result!=='advisory'?
      result==='fail' ? Promise.reject(Error('offline')) : {status:'preview',preview:'pair'} : undefined});
    api.open('board'); api.choose('focus'); await api.prepare('fixture'); await api.confirm(); await api.confirm();
    assert.equal(api.view().choice,'focus'); assert.equal(api.view().suggestion,result==='advisory'?'pair':null);
    assert.equal(calls.filter(c=>c.path===paths.run).length,1);
  }
});

test('selection and manual preview changes abort review/run, erase private review and discard late response', async () => {
  const gate=defer(); const {api,calls,commits}=harness({transport:path=>path===paths.run ? gate.promise : undefined});
  api.open('board'); await api.prepare('fixture'); const pending=api.confirm();
  assert.equal(api.view().phase,'run'); api.select('private-B',false);
  assert.equal(api.view().packet,null); assert.equal(api.view().phase,''); assert.equal(calls[1].signal.aborted,true);
  assert.equal(calls[2].path,paths.cancel);
  gate.resolve({status:'preview',preview:'pair'}); await pending;
  assert.equal(api.view().choice,'keep'); assert.equal(commits.length,0);
  await api.prepare('fixture'); api.choose('overview'); assert.equal(api.view().packet,null);
  assert.equal(calls.at(-1).path,paths.cancel);
});

test('selection before delayed prepare cancels newly returned unused ticket and never exposes review', async () => {
  const gate=defer(); const {api,calls,prepared}=harness({transport:path=>path===paths.prepare?gate.promise:undefined});
  api.open('board'); const p=api.prepare('fixture'); api.select('private-A',false);
  assert.equal(calls[0].signal.aborted,true); gate.resolve(prepared(calls[0].body)); await p;
  assert.equal(api.view().packet,null); assert.deepEqual(calls.map(c=>c.path),[paths.prepare,paths.cancel]);
});

test('every drift invalidates before dispatch even without sync hook, and after dispatch with sync', async () => {
  const changes = [h=>h.scene.revision+=':profile', h=>h.scene.camera.x++, h=>h.scene.viewport.height--,
    h=>h.scene.cards[0].revision+=':content',h=>h.scene.cards[0].canRead=false,h=>h.scene.cards[1].rect.x++,
    h=>h.scene.cards[1].pinned=true,h=>h.scene.cards[1].maySendDescriptor=false,h=>h.scene.decision.revision+=':settings',h=>h.scene=null];
  for(const change of changes) for(const sent of [false,true]) {
    const gate=defer(); const h=harness({transport:path=>path===paths.run?gate.promise:undefined});
    h.api.open('board'); await h.api.prepare('fixture'); const p=sent?h.api.confirm():null;
    change(h);
    if(sent) { assert.equal(h.api.sync(),false); assert.equal(h.calls[1].signal.aborted,true); gate.resolve({status:'preview',preview:'pair'}); await p; }
    else await h.api.confirm();
    assert.equal(h.api.view(),null); assert.equal(h.commits.length,0); assert.equal(h.calls.filter(c=>c.path===paths.run).length,Number(sent));
    assert.equal(h.calls.at(-1).path,paths.cancel);
  }
});

test('expired consent or malformed review cannot send', async () => {
  const expiry=harness(); expiry.api.open('board'); await expiry.api.prepare('fixture'); expiry.time=60_000; await expiry.api.confirm();
  assert.deepEqual(expiry.calls.map(c=>c.path),[paths.prepare,paths.cancel]);
  const malformed=harness({transport:(path,body,signal,prepare)=>path===paths.prepare?{...prepare(body),preview:{...prepare(body).preview,cue:'altered'}}:undefined});
  malformed.api.open('board'); await malformed.api.prepare('fixture'); await malformed.api.confirm();
  assert.equal(malformed.api.view().packet,null); assert.deepEqual(malformed.calls.map(c=>c.path),[paths.prepare,paths.cancel]);
});

test('late local movement removes preview and undo rather than overwriting newer user layout', () => {
  const {api,scene,commits}=harness(); api.open('board'); api.choose('pair'); scene.cards[0].rect.x++;
  assert.equal(api.apply(),false); assert.equal(api.view(),null);
  api.open('board'); api.choose('pair'); assert.equal(api.apply(),true);
  scene.cards[0].rect.x+=7; api.open('board'); assert.equal(api.view().undo,false); assert.equal(api.undo(),false);
  assert.equal(commits.length,1);
});
