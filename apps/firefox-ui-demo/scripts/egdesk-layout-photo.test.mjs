import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import { captureLayoutPhoto } from '../overlay/resources/EGDeskLayoutPhoto.sys.mjs';
import { captureDeskPhoto, noteDeskMemoPhotoSaved, registerDeskMemoPhotoEditor } from '../overlay/resources/EGDeskDeskPhoto.sys.mjs';

const NS = 'http://www.w3.org/1999/xhtml';
const r = (x, y, width, height) => ({ x, y, width, height });
const full = r(0, 0, 160, 100);
const css = {display:'block', visibility:'visible', opacity:'1', overflowX:'visible', overflowY:'visible',
  fontSize:'12px', fontFamily:'system-ui', fontWeight:'400', fontStyle:'normal', whiteSpace:'normal',
  direction:'ltr', color:'#252932', backgroundColor:'transparent'};
const i32 = n => {const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const crc32 = b => { let v = -1; for (const x of b) { v ^= x; for (let i = 0; i < 8; i++) v = v >>> 1 ^ (v & 1 ? 0xedb88320 : 0); } return (v ^ -1) >>> 0; };
function chunk(key, data) { const type = Buffer.from(key); return Buffer.concat([i32(data.length), type, data, i32(crc32(Buffer.concat([type,data])))]); }
function png(w, h, bytes) {
  const hbytes = Buffer.concat([i32(w), i32(h), Buffer.from([8,2,0,0,0])]);
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'), chunk('IHDR', hbytes),
    chunk('IDAT', deflateSync(bytes)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
function decode(p) {
  const b = Buffer.from(p.image.split(',')[1], 'base64');
  assert.equal(b.readUInt32BE(16), p.width); assert.equal(b.readUInt32BE(20), p.height);
  const rows = inflateSync(b.subarray(41, 41 + b.readUInt32BE(33)));
  return (x,y) => rows.subarray(y*(p.width*3+1)+1+x*3,y*(p.width*3+1)+4+x*3).toString('hex');
}
// Test double only. Produces a real parseable PNG with synthetic glyphs from the same
// Canvas calls, so we check layered/clipped pixels as well as exclusion of unsafe reads.
// Production instead uses Firefox's native Canvas glyph rasterizer and PNG encoder.
function softwareCanvas(log, hook) {
  let width = 0, height = 0;
  const canvas = {isConnected:false, set width(v) { width=v; }, get width() {return width;},
    set height(v) { height=v; }, get height() {return height;},
    getContext(kind) { assert.equal(kind, '2d');
      let state = {sx:1,sy:1,x:0,y:0,left:0,top:0,right:width,bottom:height}, pending;
      const stack = [], bytes = Buffer.alloc(height * (width*3+1));
      const coords = (x,y,w,h) => [state.x+x*state.sx,state.y+y*state.sy,state.x+(x+w)*state.sx,state.y+(y+h)*state.sy];
      const ctx = { save() { stack.push({...state}); }, restore() { state=stack.pop(); }, beginPath(){},
        rect(...arg) { pending=coords(...arg); }, roundRect(...arg) { this.rect(...arg.slice(0,4)); },
        clip() { const [x,y,r,b]=pending; state.left=Math.max(state.left,x); state.top=Math.max(state.top,y);
          state.right=Math.min(state.right,r); state.bottom=Math.min(state.bottom,b); },
        scale(x,y){state.sx*=x; state.sy*=y;}, translate(x,y) {state.x+=x*state.sx;state.y+=y*state.sy;},
        fillRect(...arg) { const [x,y,right,bottom]=coords(...arg); const ink=Buffer.from(this.fillStyle.slice(1), 'hex');
          assert.equal(ink.length, 3, this.fillStyle);
          for (let j=Math.ceil(Math.max(y,state.top)); j<Math.min(bottom,state.bottom); j++)
            for(let i=Math.ceil(Math.max(x,state.left));i<Math.min(right,state.right);i++) ink.copy(bytes,j*(width*3+1)+1+i*3); },
        measureText(s) { return {width:s.length*6,fontBoundingBoxAscent:8,fontBoundingBoxDescent:2}; },
        fillText(s,x,y,maxWidth) { log.text.push({s,x:state.x,y:state.y,font:this.font,color:this.fillStyle});
          for (let i=0;i<s.length;i++) if(s[i]!==' ') for (let j=0;j<6;j++)
            if ((s.codePointAt(i) >> j) & 1) this.fillRect(x + i*6* Math.min(1,maxWidth/(6*s.length)),y-8+j,3,1); },
      };
      canvas.toDataURL = format => { assert.equal(format, 'image/png'); ++log.encode;
        return hook?.(log.encode) || png(width,height,bytes); };
      return ctx;
    }};
  return canvas;
}
function fixture({hook} = {}) {
  const log={text:[], measured:[], sized:[], encode:0, created:[]};
  const window={getComputedStyle(n) { assert(!n.forbidden, 'read a forbidden node style'); return n.css; },
    fetch() { assert.fail('network'); }, get localStorage() { assert.fail('persistence'); }};
  const document={ defaultView:window, documentURI:'chrome://browser/content/browser.xhtml', activeElement:null,
    getElementById(id) { if(id==='egd-canvas-viewport') return plane; assert.equal(id,'egd-canvas-layer');return layer;},
    createElementNS(ns,tag) { assert.equal(ns,NS); assert.equal(tag,'canvas'); const canvas=softwareCanvas(log,hook); log.created.push(canvas); return canvas; },
    createRange() {
      let node,start,end;
      return { setStart(n, i) { node=n; start=i; }, setEnd(n, i) { assert.equal(n,node);end=i; },
        getClientRects(){ log.measured.push(node.data); return node.wrap.filter(w=>w.end>start && w.start<end).map(l=>{
          const from=Math.max(start,l.start), to=Math.min(end,l.end);
          return r(l.rect.x+(from-l.start)*6,l.rect.y,(to-from)*6,l.rect.height);
        }); } };
    },
    get cookie() { assert.fail('persistence'); },
  };
  let index=0;
  function n(tag,classes,rect,options={}) {
    const set=new Set(classes.split(' ')), {data,style,parent,text,wrap,attrs} = options, order = index++;
    const e={ namespaceURI:NS, localName:tag, classList:{ contains: x=>set.has(x) }, dataset:data||{},
      css:{...css,...style}, parentElement:parent, children:[], ownerDocument:document, isConnected:true,
      hasAttribute: x => attrs?.includes(x) || false,
      offsetWidth:rect.width, offsetHeight:rect.height, clientWidth:rect.width, clientHeight:rect.height,
      compareDocumentPosition(other) {return order<other.order ? 4 : 2;}, order,
      getBoundingClientRect(){ assert(!this.forbidden,'read a forbidden node size'); log.sized.push(this);return rect; },
      get textContent() { assert.fail('generic or untrusted text read'); },
      append() {assert.fail('mutating live document');},
      cloneNode() {assert.fail('cloning live document');},
    };
    if (parent) parent.children.push(e);
    if (text != null) e.firstChild={nodeType:3,data:text,wrap:wrap||[{start:0,end:text.length,rect}]};
    return e;
  }
  const plane=n('div','',full);
  const layer=n('div','',full,{parent:plane});
  function card({ at = r(12, 10, 80, 78), fill = '#f3e4d0', z = '5', name = 'First card',
    prose = 'Route ready then check', scope = 'board', kind = 'card', projectionId = 'board-active', attrs } = {}) {
    const { x, y, width, height } = at;
    const root=n('div','egd-joint-window egd-canvas-card egd-desk-window',at,{parent:layer,attrs,
      data:{testid:'joint-card',jointManaged:kind,jointScope:scope,deskWindowKind:'joint-card',projectionId},
      style:{backgroundColor:fill,zIndex:z,backgroundImage:'url(https://ignored.invalid/x)'}});
    const header=n('div','egd-card-header',r(x,y,width,18),{parent:root,style:{backgroundColor:'#dae7f2'}});
    const topbar=n('div','egd-card-topbar',r(x,y,width,18),{parent:header});
    const identity=n('div','egd-desk-window-identity',r(x+7,y,width-9,16),{parent:topbar});
    const title=n('strong','',r(x+8,y+4,width-10,10),{parent:identity,text:name,style:{fontWeight:'700'}});
    const content=n('div','egd-joint-body',r(x,y+18,width,height-18),{parent:root,style:{overflowX:'hidden',overflowY:'auto'}});
    const p=n('p','egd-joint-text',r(x+5,y+24,width-10,30),{parent:content,text:prose,style:{whiteSpace:'normal'},
      wrap:[{start:0,end:11,rect:r(x+5,y+24,width-10,10)},{start:12,end:prose.length,rect:r(x+5,y+36,width-10,10)}]});
    root._jointShell={root,slots:{header,topbar,identity,content}};
    return {root,content,title,p};
  }
  const run=(roots, overrides={})=>captureLayoutPhoto({document,window,items:roots.map((root,i)=>({root,slot:`slot-${i}`})),
    viewport:full,isCurrent:()=>true,...overrides});
  function memo({at=r(38,20,86,74), z='11', id='memo-a', text='Saved body\nNext row', projectionId, shouldSave=true}={}) {
    const {x,y,width,height}=at;
    const root=n('div','egd-memo-card egd-canvas-card egd-desk-window',at,{parent:layer,
      data:{testid:'memo-card',deskWindowKind:'memo',memoId:id,projectionId},style:{backgroundColor:'#ffecc0',zIndex:z}});
    const header=n('div','egd-card-header',r(x,y,width,18),{parent:root,style:{backgroundColor:'#edd492'}});
    const topbar=n('div','egd-card-topbar',r(x,y,width,18),{parent:header});
    const identity=n('div','egd-desk-window-identity',r(x+7,y,width-9,16),{parent:topbar});
    n('strong','egd-memo-title',r(x+8,y+4,width-10,10),{parent:identity,text:'메모 #1'});
    const content=n('div','egd-memo-card-body',r(x,y+18,width,height-18),{parent:root});
    const body=n('div','egd-memo-body',r(x+2,y+19,width-4,height-21),{parent:content});
    const editor=n('textarea','egd-memo-text',r(x+4,y+22,width-8,height-26),{parent:body,data:{testid:'memo-text'},
      style:{backgroundColor:'#fff5d8',display:'block',whiteSpace:'pre-wrap',direction:'ltr',textTransform:'none',writingMode:'horizontal-tb',
        textAlign:'start',lineHeight:'16px',paddingLeft:'3px',paddingRight:'3px',paddingTop:'2px',paddingBottom:'2px'}});
    Object.assign(editor,{clientLeft:1,clientTop:1,scrollTop:0,scrollLeft:0,scrollHeight:editor.clientHeight});
    const ui={ value:text, valueReads:0, editing:false, safeToRead:true };
    Object.defineProperty(editor,'value',{get(){ ui.valueReads++; assert(ui.safeToRead,'editing draft read'); return ui.value; }});
    root._memoRecord={id,text,revision:3,author:{kind:'user'}};
    root._deskWindowShell={root,slots:{header,topbar,identity,content}};
    const detail=n('div','egd-memo-detail',r(x+10,y+40,65,10),{parent:content});
    for(const field of ['egd-memo-reply-text','egd-memo-ask-question','egd-memo-reply-input']) {
      const unknown=n(field==='egd-memo-reply-text'?'div':'input',field,r(x,y,50,25),{parent:detail,text:'unapproved private'});
      unknown.forbidden=true; Object.defineProperty(unknown,'value',{get(){assert.fail('read private memo reply/ask draft');}});
    }
    registerDeskMemoPhotoEditor(root,editor,()=>ui.editing);
    if(shouldSave) noteDeskMemoPhotoSaved(root,root._memoRecord);
    return {root,content,editor,ui};
  }
  function runDesk(roots, overrides={}) {
    return captureDeskPhoto({document,window,imageReview:true,items:roots.map((root,slot)=>({root,slot,
      kind:root.dataset.deskWindowKind,projectionId:root.dataset.projectionId||null})), viewport:full,
      isCurrent:()=>true,authorize:({root})=>roots.includes(root),...overrides});
  }
  return {document,window,log,layer,plane,n,card,memo,run,runDesk};
}

test('selected card text, actual line positions, colors and stacking are useful raster pixels', async () => {
  const f=fixture(); const high=f.card({at:r(55,27,75,65),fill:'#b4cedb',name:'Top plate',z:'12'});
  const low=f.card({z:'2'}); // DOM/input order contradicts visual stacking
  const p=await f.run([high.root, low.root]);
  const pixel=decode(p);
  assert.deepEqual([p.width,p.height],[160,100]);
  assert.equal(pixel(0,0),'e4e7eb'); assert.equal(pixel(14,17),'dae7f2');
  assert.equal(pixel(52,65),'f3e4d0'); assert.equal(pixel(57,74),'b4cedb'); assert.equal(pixel(90,32),'dae7f2');
  assert.equal(pixel(17,35),'252932'); assert.equal(pixel(17,48),'252932'); // separate measured text rows
  assert.deepEqual(f.log.text.slice(0,3).map(o=>o.s),['First card','Route ready','then check']);
  assert.match(f.log.text[0].font,/700 12px system-ui/);
  assert.deepEqual(f.log.text.slice(1,3).map(o=>o.y),[42,54]);
  assert.deepEqual(f.log.created.map(c=>[c.width,c.height,c.isConnected]),[[0,0,false]]);
});

test('positive selection omits excluded pixels, private reply, other profile, account fields and unknown content', async () => {
  const f=fixture(), a=f.card(), excluded=f.card({fill:'#ff00ff',at:r(92,32,65,67),name:'Unselected Board text'});
  const privateRoot=f.card({fill:'#ff00ff',at:r(92,32,65,67),name:'Private reply',kind:'reply'}).root;
  const single=f.card({scope:'single'}).root, other=f.card({projectionId:'other-profile'}).root;
  const explicitPrivate=f.card({attrs:['data-capture-private']}).root;
  const foreign=f.card().root; foreign.ownerDocument={};
  for (const x of [privateRoot,excluded.root,single,other,explicitPrivate,foreign]) x.forbidden=true;
  const add=(tag,cls,text,opts={})=>f.n(tag,cls,r(13,32,72,9),{parent:a.content,text,...opts,style:{backgroundColor:'#ff00ff'}});
  add('small','','작성자: private-account').forbidden=true;
  add('button','egd-joint-button','Unselected related title',{data:{testid:'joint-relation-target'}}).forbidden=true;
  add('details','egd-joint-reply-slip','Private reply body').forbidden=true;
  add('div','unknown-owned','Unknown pixel').forbidden=true;
  add('img','','https://remote.invalid/secret').forbidden=true;
  add('iframe','','https://remote.invalid/secret').forbidden=true;
  add('textarea','','Account key').forbidden=true;
  add('p','egd-joint-text','Do not paint https://remote.invalid/secret');
  add('p','egd-joint-text','token: no');
  add('p','egd-joint-text','No remote.invalid domain');
  const mixed=add('p','egd-joint-text','must never read nested markup');
  mixed.firstChild.nextSibling={nodeType:1};
  const p=await f.run([a.root]); assert(p);
  const pixel=decode(p); assert.equal(pixel(106,45),'e4e7eb');
  assert(!f.log.measured.some(s=>/account|reply|unknown|remote|token|never|related|unselected/i.test(s)));
  for (const x of [privateRoot,single,other,explicitPrivate,foreign]) assert.equal(await f.run([a.root,x]),null);
  assert.equal(f.log.created.length,1);
});

test('viewport trim, over-budget re-render, and serialized bound without persistence', async () => {
  const f=fixture({hook:i=>i===1?'data:image/png;base64,iVBORw0KGgo'+'A'.repeat(192*1024):null});
  const {root}=f.card({at:r(10,10,150,88)});
  const p=await f.run([root],{viewport:r(20,10,1150,780)});
  assert(p); assert.equal(f.log.encode,2); assert(p.width<768 && p.height<512);
  assert(JSON.stringify(p).length<=192*1024);
  assert.equal(decode(p)(0,0),'dae7f2'); assert.equal(decode(p)(p.width-1,p.height-1),'e4e7eb');
  assert.deepEqual(f.log.created.map(c=>[c.width,c.height,c.isConnected]),[[0,0,false]]);
});

test('invalidating grant/active revision before and after encoding returns null and zeroes any canvas', async () => {
  const a=fixture(); const ar=a.card().root; let granted=true;
  const before=a.run([ar],{isCurrent:()=>granted}); granted=false;
  assert.equal(await before,null); assert.equal(a.log.measured.length,0); assert.equal(a.log.created.length,0);
  let rev=1;
  const b=fixture({hook:()=>{queueMicrotask(()=>rev++);}}); const br=b.card().root;
  assert.equal(await b.run([br],{isCurrent:()=>rev===1}),null);
  assert.equal(b.log.encode,1); assert.deepEqual(b.log.created.map(c=>[c.width,c.height]),[[0,0]]);
});

test('blank, hidden, offscreen, semantic only, or memo-form-only input falls back rather than generating a map', async () => {
  const f=fixture();
  const empty=f.card({name:'',prose:''});
  f.n('div','egd-joint-caption',r(18,32,66,9),{parent:empty.content,text:'자료 · 나에게 공개됨'});
  assert.equal(await f.run([empty.root]),null);
  const offscreen=f.card({at:r(165,12,80,78)}).root;
  const hidden=f.card().root; hidden.css.display='none';
  const collapsed=f.card(); collapsed.content.css.opacity='0'; collapsed.title.css.opacity='0';
  const memo=f.n('div','egd-memo-card',r(24,22,90,60),{parent:f.layer,data:{deskWindowKind:'memo',testid:'memo-card'}});
  f.n('textarea','egd-memo-text',r(25,23,75,40),{parent:memo,text:'Never inspect a form field'}).forbidden=true;
  for (const root of [offscreen,hidden,collapsed.root,memo]) assert.equal(await f.run([root]),null);
  assert.equal(f.log.created.length,0);
});

test('Desk review paints native memo and separately approved joint bodies from two projections in one workplane', async () => {
  const f=fixture();
  const m=f.memo();
  const right=f.card({projectionId:'board-second',at:r(104,50,52,48),z:'15',name:'Front layer',fill:'#b4cedb'});
  const left=f.card({projectionId:'board-first',z:'2'});
  const omitted=f.card({projectionId:'board-third',at:r(1,1,158,95),z:'999',fill:'#ff00ff'});
  omitted.root.forbidden=true;
  const p=await f.runDesk([right.root,m.root,left.root]);
  const pixel=decode(p);
  assert.equal(pixel(0,0),'e4e7eb');
  assert.equal(pixel(15,78),'f3e4d0');
  assert.equal(pixel(41,72),'ffecc0');
  assert.equal(pixel(48,77),'fff5d8');
  assert.equal(pixel(105,60),'dae7f2');
  assert.equal(pixel(108,93),'b4cedb');
  assert(f.log.text.find(o=>o.s==='Saved body' && o.x===46));
  assert(f.log.text.find(o=>o.s==='Next row'));
  assert(f.log.text.findIndex(o=>o.s==='Saved body') < f.log.text.findIndex(o=>o.s==='Front layer'));
  assert(!f.log.measured.includes(m.root._memoRecord.text), 'saved memo is not measured from DOM text');
  assert.equal(await f.run([left.root,right.root]),null,'existing joint entry still forbids multiple projections');
});

test('ordinary Desk saved own memo works without joint/Board and requires explicit local review', async () => {
  const f=fixture(); const {root,ui}=f.memo();
  assert.equal(await f.runDesk([root],{imageReview:false}), null);
  assert.equal(await f.runDesk([root],{authorize:()=>false}),null);
  assert.equal(await f.runDesk([root],{items:[{root,kind:'memo',slot:1,projectionId:'not-its-home'}]}),null);
  f.window.docShell={usePrivateBrowsing:true};
  assert.equal(await f.runDesk([root]),null);
  assert.equal(ui.valueReads, 0);
  f.window.docShell.usePrivateBrowsing=false;
  const proof=await f.runDesk([root]);
  assert(proof); assert.equal(ui.valueReads,2);
  assert.equal(decode(proof)(39,67),'ffecc0');
  assert(f.log.text.some(o=>o.s==='Saved body'));
});

test('never reads freshly editing, composing, or unsaved textarea and rejects stale display and sensitive text', async () => {
  const f=fixture(), m=f.memo({shouldSave:false}), other=f.card();
  m.ui.safeToRead=false;
  const blocked=()=>f.runDesk([m.root,other.root]);
  assert.equal(await blocked(), null);
  noteDeskMemoPhotoSaved(m.root,m.root._memoRecord);
  f.document.activeElement=m.editor;
  assert.equal(await blocked(), null);
  f.document.activeElement=null;
  m.ui.editing=true;
  assert.equal(await blocked(), null);
  m.ui.editing=false; m.root._memoTextDirty=true;
  assert.equal(await blocked(), null);
  delete m.root._memoTextDirty;
  m.root._memoRecord={...m.root._memoRecord,revision:4};
  assert.equal(await blocked(), null);
  noteDeskMemoPhotoSaved(m.root,m.root._memoRecord);
  m.editor.scrollTop=2;
  assert.equal(await blocked(), null);
  m.editor.scrollTop=0; m.editor.scrollHeight+=20;
  assert.equal(await blocked(), null);
  assert.equal(m.ui.valueReads,0);
  m.ui.safeToRead=true; m.editor.scrollHeight=m.editor.clientHeight;
  m.ui.value='mismatching editor';
  assert.equal(await blocked(), null);
  assert.equal(m.ui.valueReads,1);
  m.root._memoRecord={...m.root._memoRecord,revision:5,text:'password: not for the preview'};
  m.ui.value=m.root._memoRecord.text;
  noteDeskMemoPhotoSaved(m.root,m.root._memoRecord);
  assert.equal(await blocked(), null);
  assert.deepEqual(f.log.text,[]);
});

test('rejects mixed revocation, memo replacement during encode, and roots from another workplane', async () => {
  let revoke, edit;
  const f=fixture({hook:()=>queueMicrotask(()=>{revoke?.(); edit?.();})});
  const m=f.memo(), j=f.card({projectionId:'board-a'});
  let authorized=true;
  revoke=()=>{authorized=false;};
  assert.equal(await f.runDesk([m.root,j.root],{authorize:({root})=>root===m.root||authorized}),null);
  assert(f.log.created.every(c=>c.width===0&&c.height===0));
  revoke=null; edit=()=>{m.root._memoRecord={...m.root._memoRecord,revision:4};};
  assert.equal(await f.runDesk([m.root,j.root]),null);
  assert(f.log.created.every(c=>c.width===0&&c.height===0));
  j.root.parentElement=f.plane; j.root.forbidden=true;
  assert.equal(await f.runDesk([j.root]),null);
});

test('Desk image cannot stand in for protected or missing joint body text using only a title', async () => {
  const f=fixture(), joint=f.card({prose:'password: do not paint this'});
  assert.equal(await f.runDesk([joint.root]),null);
  assert.equal(f.log.text.length,0);
  assert(await f.run([joint.root]), 'the pre-existing projection-scoped fallback retains its own eligibility');
});
