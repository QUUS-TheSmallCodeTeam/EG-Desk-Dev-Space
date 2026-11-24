import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPresentationController, presentationWorldBounds, PRESENTATION_DECISION_PATHS as paths }
  from '../overlay/resources/EGDeskJointPresentation.sys.mjs';
const ticket = 'a'.repeat(48);
const box = (x, y, width, height) => ({ x, y, width, height });
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const card = (id, x, y, extra = {}) => ({ id, title: `private ${id}`, rect: box(x,y,442,258), visible:true, canRead:true,
  revision:'lease:v1', kind:'자료', movable:true, pinned:false, maySendDescriptor:true, zIndex:21, body:'private body', ...extra });
function harness({mode = 'on', transport, mutate, render, readDecision, verifyDecisionAuthority} = {}) {
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
    render, readDecision, verifyDecisionAuthority,
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

const EMPTY_DESK_NOTICE = '정리 조건을 충족하는 공동 보드 자료나 이 기기에 저장된 개인 메모가 없습니다. 브라우저·채팅·터미널 창은 자동 정리 대상이 아닙니다.';
const DESK_HELP = '공동 보드에서 열람 권한이 있어 화면에 표시된 자료와 이 기기에 저장된 개인 메모 중 정리 조건을 충족하는 항목만 대상입니다. 브라우저·채팅·터미널 창은 자동으로 정리하지 않습니다. 점선은 미리보기이며, 적용은 내 화면의 시점과 배치에만 반영됩니다. 외부 사진 추천은 선택 사항입니다. 사진을 확인하고 별도로 전송을 승인해야 외부로 보냅니다.';
const BOARD_HELP = '캔버스의 점선은 미리보기입니다. 적용해도 다른 사람의 화면은 바뀌지 않습니다.';

// Synthetic element tree and status stub only: no layout engine, photo capture or HTTP.
async function deskCopyHost({mixed = false} = {}) {
  const {createWorkbenchArrange} = await import('../overlay/resources/EGDeskWorkbenchArrange.sys.mjs');
  const notices = [], requests = [];
  let doc;
  function node(tag, id = '', x = 0) {
    const kids = [], attrs = new Map();
    const rect = {x,y:20,width:250,height:160,left:x,right:x+250,top:20,bottom:180};
    return {tag,id,kids,rect,dataset:{},style:{setProperty(){}},classList:{contains:()=>false},isConnected:true,
      setAttribute:(k,v)=>attrs.set(k,v),getAttribute:k=>attrs.get(k),hasAttribute:k=>attrs.has(k),
      addEventListener(){},append(...ns){kids.push(...ns);},replaceChildren(...ns){kids.splice(0,kids.length,...ns);},
      querySelector:()=>null,contains:()=>false,focus(){doc.activeElement=this;},remove(){this.isConnected=false;},
      matches:()=>true,getBoundingClientRect:()=>rect,getClientRects:()=>[rect]};
  }
  const root = node('root'), canvas = node('canvas');
  const tools = ['browser','chat','terminal'].map((name,i)=>node('card',name,50+i*275));
  const board = node('card','board-view',50), memo = node('card','memo-view',350);
  board.dataset = {projectionId:'p',jointItem:'item',jointLease:'lease',jointVersion:'1'};
  memo._memoRecord = {id:'memo',seq:1,text:'synthetic',updatedAt:1};
  const nodes = mixed ? [board,memo,...tools] : tools;
  doc = {documentElement:root,createElementNS:(_ns, tag)=>node(tag),getElementById:id=>nodes.find(n=>n.id===id),
    querySelectorAll:sel=>sel==='.egd-memo-card' ? (mixed ? [memo] : []) : nodes};
  const p = {id:'p',jointAccess:'epoch',members:[{sourceId:'item',viewId:board.id}]};
  const workbench = createWorkbenchArrange({document:doc,window:{innerWidth:1000,innerHeight:700,addEventListener(){},removeEventListener(){},
    setInterval:()=>1,clearInterval(){},getComputedStyle:()=>({visibility:'visible'})}, canvas:()=>canvas, moving:()=>false, context:()=>null,
    safe:()=>({left:0,top:0,right:1000,bottom:700,width:1000,height:700}),camera:()=>({x:0,y:0,zoom:1,minZoom:.1,maxZoom:4}),
    projections:()=>mixed?[p]:[], meta:()=>({board:{epoch:'epoch',cards:[{id:'item',access:'lease',version:1,own:true,title:'합성 보드 자료'}]}}),
    geometry:n=>({...n.rect,zIndex:1}),notice:text=>notices.push(text),
    http:async (method,path)=>{requests.push([method,path]);return {status:200,body:{configured:true,model:'gpt-6-luna',mode:'on',boardRevision:'a'.repeat(64)}};}});
  const texts = n => n.kids.filter(child=>child.isConnected).flatMap(child=>[child.textContent,...texts(child)]).filter(Boolean);
  return {workbench,notices,requests,root,canvas,texts:()=>texts(root)};
}

test('L-01 empty Desk tells the operator its scope and opens no review', async () => {
  const {workbench,notices,requests,root,canvas} = await deskCopyHost();
  await workbench.open('@desk');
  assert.deepEqual(notices,[EMPTY_DESK_NOTICE]);
  assert.deepEqual(root.kids,[]);
  assert.deepEqual(canvas.kids,[]);
  assert.deepEqual(requests,[['GET','/decision/status']]); // Local config lookup only; no decision POST.
});

test('L-01 mixed Desk lists eligible synthetic material and memo, with Desk-only help', async t => {
  const {workbench,notices,requests,texts} = await deskCopyHost({mixed:true});
  t.after(()=>workbench.close());
  await workbench.open('@desk');
  assert.deepEqual(notices,[]);
  assert.ok(texts().includes('대상 자료 (2장 선택)'));
  assert.ok(texts().includes('1 · 합성 보드 자료'));
  assert.ok(texts().includes('2 · 개인 메모 1'));
  assert.ok(texts().includes(DESK_HELP));
  assert.ok(!texts().includes('외부 전송 내용 확인'));
  assert.deepEqual(requests,[['GET','/decision/status']]);
  await workbench.open('p');
  assert.ok(texts().includes(BOARD_HELP));
  assert.ok(!texts().includes(DESK_HELP));
  assert.deepEqual(requests,[['GET','/decision/status'],['GET','/decision/status']]);
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

for (const scenario of ['on', 'advisory', 'expired', 'stale']) {
  test(`reviewed synthetic pair vs operator keep: ${scenario}`, async t => {
    const mode = scenario === 'advisory' ? 'advisory' : 'on';
    const gate = defer(), views = [];
    const h = harness({mode, transport: path => path === paths.run ? gate.promise : undefined,
      render: v => views.push(structuredClone(v))});
    const {api, scene, commits, calls} = h;
    t.after(() => api.close());
    const initial = structuredClone(scene);
    const keep = {option:'keep', framing:null, camera:null, targets:[]};
    // Fixed world-plane oracles for this fixture, not DOM positions or values read from the plan.
    const pair = {option:'pair', framing:null, camera:null, targets:[
      {id:'private-A', rect:box(-10,124,430,250)}, {id:'private-B', rect:box(444,124,430,250)},
    ]};
    const assertNoWrite = (expected = initial) => {
      assert.deepEqual(commits, [], 'fake host received no commits');
      assert.deepEqual(scene, expected, 'host fixture geometry, camera, stacking and bodies are unchanged');
    };
    assert.equal(api.open('board'), true);
    api.choose('keep'); // Explicit operator preselection, never choose pair manually in this test.
    await api.prepare('synthetic comparison fixture');
    assert.deepEqual(calls.map(c => c.path), [paths.prepare]);
    assert.equal(api.view().phase, 'review');
    assert.equal(api.view().choice, 'keep');
    assert.deepEqual(api.view().plan, keep);
    assert.ok(api.view().packet.questions[0].choices.some(c => c.value === '선택한 두 장 나란히 비교'));
    assertNoWrite();

    const pending = api.confirm();
    assert.equal(api.view().phase, 'run');
    assert.deepEqual(calls.map(c => c.path), [paths.prepare, paths.run]);
    assert.deepEqual(api.view().plan, keep);
    assert.equal(api.apply(), false, 'cannot apply while the reviewed result is pending');
    assertNoWrite();
    if (scenario === 'expired') h.time = 60_000; // Expire in flight, not before confirm.
    if (scenario === 'stale') scene.cards[1].rect.x += 7; // No explicit sync before reply.
    const beforeReply = structuredClone(scene);
    gate.resolve(mode === 'advisory' ? {status:'advisory-only', suggestion:'pair'} : {status:'preview', preview:'pair'});
    await pending;
    assertNoWrite(beforeReply);

    if (scenario !== 'on') {
      if (scenario === 'stale') {
        assert.equal(api.view(), null);
        assert.equal(api.apply(), false);
      } else {
        assert.equal(api.view().phase, '');
        assert.equal(api.view().choice, 'keep');
        assert.deepEqual(api.view().plan, keep);
        assert.equal(api.view().suggestion, scenario === 'advisory' ? 'pair' : null);
        assert.equal(api.apply(), true, 'still applies keep as a no-op');
      }
      assert.deepEqual(calls.map(c => c.path), ['expired','stale'].includes(scenario)
        ? [paths.prepare, paths.run, paths.cancel] : [paths.prepare, paths.run]);
      assert.ok(views.every(v => v.choice === 'keep'), 'no replacement preview reached the fake render hook');
      assertNoWrite(beforeReply);
      return;
    }

    assert.equal(api.view().phase, '');
    assert.equal(api.view().choice, 'pair', 'the reviewed reply replaces the operator preview only in on mode');
    assert.deepEqual(api.view().plan, pair);
    assert.deepEqual(views.at(-1).plan, pair, 'fake render hook receives the replacement plan');
    assertNoWrite();
    assert.equal(api.apply(), true);
    assert.deepEqual(commits, [{key:'board', camera:null, targets:pair.targets}]);
    const applied = structuredClone(initial);
    for (const {id, rect} of pair.targets) applied.cards.find(c => c.id === id).rect = rect;
    assert.deepEqual(scene, applied, 'only the two selected rectangles changed');

    assert.equal(api.open('board'), true);
    assert.equal(api.view().undo, true);
    assert.equal(api.undo(), true);
    assert.deepEqual(commits, [{key:'board', camera:null, targets:pair.targets},
      {key:'board', camera:null, targets:initial.cards.slice(0, 2).map(({id, rect}) => ({id, rect}))}]);
    assert.deepEqual(scene, initial);
    assert.equal(api.open('board'), true);
    assert.equal(api.undo(), false);
    assert.equal(commits.length, 2);
  });
}

// Production request handlers with only the request/response transport, stores and provider faked.
// Hold the UI delivery separately from the provider so HTTP may already have emitted a legal enum.
test('Board HTTP → Desk: live grants only, no resurrection of approved or returned recommendations', async t => {
  const { EventEmitter } = await import('node:events');
  const { Readable } = await import('node:stream');
  const { createBoardPresentationHttpHandler } = await import('../helper/egdesk-board-presentation-http.mjs');
  const { createDecisionHttpHandler } = await import('../helper/egdesk-decision-http.mjs');
  const { createDecisionBudget, DECISION_MODEL } = await import('../helper/egdesk-decision-client.mjs');
  const presentation = await import('../overlay/resources/EGDeskJointPresentation.sys.mjs');
  const pair = '선택한 두 장 나란히 비교', keep = '현재 배치 유지';
  for (const scenario of ['fresh on', 'off/on after review', 'same key after review', 'grant lost after review',
    'off/on while provider pending', 'off/on after legal reply', 'same key after legal reply',
    'grant lost after legal reply', 'off/on between preview and apply', 'same key between preview and apply',
    'grant lost between preview and apply', 'manual placement and Undo without model', 'advisory']) {
    await t.test(scenario, async t => {
      const key = 'synthetic-fixture-not-a-provider-key';
      let savedKey = key, savedMode = scenario === 'advisory' ? 'advisory' : 'on', providerGate, uiGate;
      let grant = true, h;
      const provider = [], inputs = [], renders = [];
      const runnerEntered = defer(), emitted = defer();
      const store = { status:'configured', writable:true, getApiKey:()=>savedKey, savedAt:()=>17, hint:()=>null,
        save:k=>{ savedKey=k; return true; }, clear:()=>{ savedKey=null; return true; } };
      const mode = { get mode(){ return savedMode; }, saved:true, persisted:true,
        save:m=>{ savedMode=m; return true; } };
      const board = createBoardPresentationHttpHandler({credentials:store, getMode:()=>mode.mode,
        // This test is about live grants, not spend: the cap only has to stay out of the way. A request that was sent and
        // then cancelled (off/on while pending) now adds a labelled estimate to the local guard, so a tiny cap would refuse
        // the next approved request for budget reasons and hide what the test checks.
        budget:createDecisionBudget({monthlyInputTokenCap:1_000_000}), fetchImpl:async (_endpoint, init)=>{
          provider.push(JSON.parse(init.body)); runnerEntered.resolve();
          if (providerGate) await providerGate.promise;
          return Response.json({ answers:[{name:'board_view', type:'choice', choice:pair, confidence:.94,
            probabilities:[{value:pair, probability:.94},{value:keep, probability:.06}]}], usage:{input_tokens:10} });
        }});
      const settings = createDecisionHttpHandler({store, mode, model:DECISION_MODEL, verifyKey:async ()=>({status:'verified'}),
        boardPresentation:board, // bridge's production connector
        onSettingsChanged:()=>{ if (!board.settingsRevision) board.invalidate(); } }); // compatibility with pre-fix bridge wrappers
      const http = async (method, path, body) => {
        const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
          {url:path,method,headers:{host:'127.0.0.1:39218',origin:'chrome://browser','content-type':'application/json'}});
        const res = Object.assign(new EventEmitter(), {
          writeHead(status) { this.status=status; }, end(json) { this.body=JSON.parse(json); this.writableEnded=true; },
        });
        const url = new URL(path, 'http://127.0.0.1:39218');
        assert.equal(await settings(req,res,url) || await board(req,res,url),true);
        assert.equal(res.status,200);
        return {status:res.status,body:res.body};
      };
      const readDecision = () => presentation.readPresentationDecision?.(http);
      const status = await http('GET','/decision/status');
      h = harness({mode:savedMode, render:v=>renders.push(v.choice),
        mutate:s=>{ s.decision.revision=status.body.boardRevision ?? 'baseline'; },
        transport:async (path, dto)=>{
          if(path!==paths.cancel) inputs.push(path);
          const {body} = await http('POST',path,dto);
          if(path===paths.run){emitted.resolve(body); if(uiGate) await uiGate.promise;}
          return body;
        }, readDecision, verifyDecisionAuthority:async ()=>{
          // Represents a live grant projection that has not polled yet.
          if(!grant) h.scene.cards[0].maySendDescriptor=false;
          return grant;
        }});
      t.after(()=>{ providerGate?.resolve(); uiGate?.resolve(); h.api.close(); board.invalidate(); });
      const flip = async () => {
        if(scenario.startsWith('off/on')) {
          await http('POST','/decision/mode',{mode:'off'});
          await http('POST','/decision/mode',{mode:'on'});
        } else if(scenario.startsWith('same key')) {
          const again=await http('POST','/decision/credential',{apiKey:key});
          assert.equal(again.body.savedAt,status.body.savedAt,'deliberate same-timestamp save');
        } else if(scenario.startsWith('grant lost')) grant=false;
      };
      const {api,scene,commits} = h;
      assert.equal(api.open('board'),true);
      if(scenario.startsWith('manual')) {
        const original=structuredClone(scene.cards.map(c=>c.rect));
        await http('POST','/decision/mode',{mode:'off'});
        scene.decision=null;
        assert.ok(api.open('board')); api.choose('pair');
        assert.equal(await api.apply(),true); assert.equal(commits.length,1);
        await http('POST','/decision/mode',{mode:'on'});
        scene.decision={available:true,mode:'on',revision:(await http('GET','/decision/status')).body.boardRevision ?? 'baseline'};
        assert.ok(api.open('board')); assert.equal(api.undo(),true);
        assert.deepEqual(scene.cards.map(c=>c.rect),original);
        assert.equal(commits.length,2); assert.deepEqual(inputs,[]); assert.deepEqual(provider,[]);
        return;
      }
      await api.prepare('두 합성 자료 비교');
      assert.equal(api.view().phase,'review');
      assert.equal(api.view().choice,'keep');
      assert.equal(provider.length,0);
      if(scenario.endsWith('after review')) {
        await flip();
        await api.confirm();
        assert.equal(provider.length,0,'old approval dispatched no model input');
        assert.deepEqual(inputs,[paths.prepare],'no extra run POST');
      } else if(scenario.endsWith('while provider pending')) {
        providerGate=defer(); const pending=api.confirm(); await runnerEntered.promise;
        await flip(); providerGate.resolve(); await pending;
        assert.deepEqual(await emitted.promise,{status:'manual'});
        assert.equal(provider.length,1);
      } else if(scenario.endsWith('after legal reply')) {
        uiGate=defer(); const pending=api.confirm();
        assert.deepEqual(await emitted.promise,{status:'preview',preview:'pair'});
        await flip(); uiGate.resolve(); await pending;
        assert.equal(provider.length,1);
      } else {
        await api.confirm();
        assert.equal(provider.length,1);
        if(scenario.endsWith('between preview and apply')) {
          assert.equal(api.view().choice,'pair');
          await flip();
          assert.equal(await api.apply(),false,'a previously rendered model choice is not an apply grant');
        }
      }
      assert.equal(commits.length,0,'no implicit geometry write');
      if(scenario==='fresh on') {
        assert.equal(api.view().choice,'pair');
        assert.equal(await api.apply(),true);
        assert.equal(commits.length,1);
      } else if(scenario==='advisory') {
        assert.deepEqual(await emitted.promise,{status:'advisory-only',suggestion:'pair'});
        assert.equal(api.view().choice,'keep'); assert.equal(api.view().suggestion,'pair');
        assert.equal(await api.apply(),true); assert.equal(commits.length,0);
      } else {
        assert.notEqual(api.view()?.choice,'pair','old enum is not presented or retained');
        if(!scenario.endsWith('between preview and apply')) assert.ok(!renders.includes('pair'));
        assert.equal(commits.length,0);
        const sent = provider.length;
        grant=true; scene.cards[0].maySendDescriptor=true;
        scene.decision.revision=(await http('GET','/decision/status')).body.boardRevision ?? 'baseline';
        assert.ok(api.open('board')); await api.prepare('새 승인으로 두 합성 자료 비교'); await api.confirm();
        assert.equal(provider.length,sent+1); assert.equal(api.view().choice,'pair');
        assert.equal(await api.apply(),true); assert.equal(commits.length,1);
      }
      for(const packet of provider) {
        assert.equal(packet.model,DECISION_MODEL);
        assert.equal(packet.input[0].content.length,2);
        assert.ok(packet.input[0].content.every(p=>p.type!=='input_image'));
        assert.equal(packet.questions[0].name,'board_view');
        assert.doesNotMatch(JSON.stringify(packet),/private-A|private-B|private body/);
      }
    });
  }
});
