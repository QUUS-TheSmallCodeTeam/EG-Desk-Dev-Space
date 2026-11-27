import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';
export async function verifySpatialCases({a,b,id,j,bounded,screenshot,boardTitle,store,mark,decisions,mode,resetByOpen,closePanel}){
 const pres=n=>j('presentation-'+n),evidence=process.env.EGDESK_JOINT_EVIDENCE;
 const poses=()=>[...document.querySelectorAll('[data-testid="joint-card"]')].map(n=>[n.id,n.style.left,n.style.top,n.style.width,n.style.height,n.style.zIndex]);
 const open=async x=>{await x.click(id('board-menu'));await x.click(pres('open'));await x.see(pres('tool'));};
 const shot=async(x,n)=>screenshot(x,n);
 const currentCompare=()=>JSON.stringify(store.view('sender').boards[0].cards.map(c=>[c.id,c.layoutVersion,c.position]));
 await resetByOpen(a);await closePanel(a);
 // Reproducible *synthetic* work: position approved real Desk windows around existing fixed chrome. No new surfaces or fabricated model image.
 const fixture=await a.evaluate(()=>{const nodes=[...document.querySelectorAll('[data-testid="joint-card"]')],l=document.getElementById('egd-canvas-layer'),r=l.getBoundingClientRect(),m=new DOMMatrix(getComputedStyle(l).transform);const z=m.a||1;const baseX=145,baseY=140;const slots=[[baseX,baseY],[baseX+170,baseY+32],[baseX+52,baseY+190],[baseX+286,baseY+200]];nodes.forEach((n,i)=>{const [x,y]=slots[i%4];Object.assign(n.style,{left:Math.round((x-r.left)/z)+'px',top:Math.round((y-r.top)/z)+'px',width:Math.round(312/z)+'px',height:Math.round(197/z)+'px'});});return nodes.map(n=>({title:n.dataset.jointManaged,rect:n.getBoundingClientRect().toJSON()}));});assert.ok(fixture.length>=2);
 const normal=await a.evaluate(poses),other=await b.evaluate(poses),shared=currentCompare();await shot(a,'joint-layout-before');
 await a.click(id('board-menu'));await a.click(j('inspect-render'));await a.see(j('audit'));
 const audit=await a.evaluate(()=>JSON.parse(document.querySelector('[data-testid="joint-audit-json"]').textContent));assert.equal(audit.status,'observed');assert.ok(audit.items.some(i=>i.aabbOverlap.slots.length));assert.ok(audit.items.some(i=>[i.card,...i.controls].some(t=>t.samples.miss||t.samples.clipped)));if(evidence)fs.writeFileSync(path.join(evidence,'spatial-observation.json'),JSON.stringify(audit,null,2));await a.click(j('audit-close'));mark('actual Firefox read: rectangle overlap is separated from viewport/overflow clipping and per-action hit probes');
 mode('off');await open(a);assert.equal(await a.has(pres('decision')),false);await a.click(pres('overview'));await a.see(pres('frame'));assert.deepEqual(await a.evaluate(poses),normal);await a.click(pres('cancel'));assert.equal(await a.has(pres('world')),false);assert.equal(decisions(),0);mark('model off: on-canvas frame preview, cancel and no transport or geometry changes');
 mode('on');await open(a);await a.see(pres('prepare'));const started=Date.now();await a.fill(pres('cue'),'인계하기 쉽게 정리해줘');await a.click(pres('prepare'));
 const result=await bounded(()=>a.evaluate(()=>({photo:!!document.querySelector('[data-testid="joint-presentation-photo"]'),status:document.querySelector('[data-testid="joint-presentation-status"]')?.textContent,open:!!document.getElementById('egd-joint-presentation')})),v=>v.photo||!v.open||!!v.status&&/전송하지|불러오지|수동으로|사진에 담을/.test(v.status),'photo local review',10000);if(!result.photo){console.error('review reason',result.status);const debug=await a.evaluate(()=>[...document.querySelectorAll('[data-testid="joint-card"]')].map(n=>{const sh=n._jointShell;const r=n.getBoundingClientRect();return {tag:n.localName,ns:n.namespaceURI,cls:n.className,parent:n.parentElement.id,kind:n.dataset.deskWindowKind,slots:Object.entries(sh?.slots||{}).map(([k,v])=>[k,v?.localName,v?.className,v?.parentElement===n]),x:r.x,y:r.y,w:r.width,h:r.height,off:n.offsetWidth,z:n.style.zIndex,pin:n.dataset.egdSemanticLevel};}));throw Error('actual photo review failed: '+JSON.stringify([result,debug]));}await a.see(pres('confirm'));assert.equal(decisions(),0);const reviewMs=Date.now()-started;
 const pixels=await a.evaluate(()=>{const n=document.querySelector('[data-testid="joint-presentation-photo"]');const c=document.createElementNS('http://www.w3.org/1999/xhtml','canvas');c.width=n.naturalWidth;c.height=n.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(n,0,0);const rgba=ctx.getImageData(0,0,c.width,c.height).data;const colors=new Set();for(let i=0;i<rgba.length;i+=64)colors.add([rgba[i],rgba[i+1],rgba[i+2]].join(','));return {w:c.width,h:c.height,colors:colors.size};});assert.ok(pixels.w>120&&pixels.h>80&&pixels.colors>6);await shot(a,'joint-photo-review');await a.click(pres('decision-cancel'));assert.equal(decisions(),0);
 await a.click(pres('prepare'));await a.see(pres('photo'));const beforeRun=Date.now();await a.click(pres('confirm'));await a.see(pres('status'),'아직 적용하지');const answerMs=Date.now()-beforeRun;assert.equal(decisions(),1);assert.deepEqual(await a.evaluate(poses),normal);await shot(a,'joint-layout-preview');const marks=await a.evaluate(()=>{const n=document.getElementById('egd-joint-presentation');return {...n.dataset};});const chosen=await a.evaluate(()=>document.querySelector('[name="joint-presentation-option"]:checked')?.value);assert.ok(['tidy','handoff','workbench','pair'].includes(chosen),'fixture chose meaningful current feasible layout: '+chosen);await a.click(pres('apply'));assert.equal(await a.has(pres('tool')),false);const changed=await a.evaluate(poses);assert.notDeepEqual(changed,normal);assert.deepEqual(await b.evaluate(poses),other);assert.equal(currentCompare(),shared);await shot(a,'joint-layout-after');await a.click(id('board-menu'));await a.click(j('inspect-render'));await a.see(j('audit'));const post=await a.evaluate(()=>JSON.parse(document.querySelector('[data-testid="joint-audit-json"]').textContent));await a.click(j('audit-close'));await open(a);await a.click(pres('undo'));assert.deepEqual(await a.evaluate(poses),normal);
 if(evidence)fs.writeFileSync(path.join(evidence,'layout-acceptance.json'),JSON.stringify({fixture:true,approvedImage:pixels,mode:'on',chosen,reviewObservedMs:reviewMs,fixtureAnswerObservedMs:answerMs,uiTiming:marks,initialOverlapPairs:audit.items.reduce((n,i)=>n+i.aabbOverlap.slots.length,0)/2,finalOverlapPairs:post.items.reduce((n,i)=>n+i.aabbOverlap.slots.length,0)/2,viewCount:normal.length,liveProviderCalls:0,undoRestoredAll:true},null,2));mark('actual approved PNG with measured visual context takes one fixture Decision, own-layout apply and undo; other Desk and published positions unchanged');
 // Reopening locally revalidates mode. A pending review whose Desk geometry changes must not dispatch.
 await open(a);await a.click(pres('prepare'));await a.see(pres('photo'));await a.evaluate(()=>{const n=document.querySelector('[data-testid="joint-card"]');n.style.left=(n.offsetLeft+7)+'px';return true;});await bounded(()=>a.has(pres('tool')),v=>!v,'stale approval gone on pose change');assert.equal(decisions(),1);mode('advisory');await open(a);await a.click(pres('prepare'));await a.see(pres('photo'));const chosenBefore=await a.evaluate(()=>document.querySelector('[name="joint-presentation-option"]:checked')?.value);await a.click(pres('confirm'));await a.see(pres('status'),'참고 제안');assert.equal(await a.evaluate(()=>document.querySelector('[name="joint-presentation-option"]:checked')?.value),chosenBefore);assert.equal(decisions(),2);await a.click(pres('cancel'));mark('stale photo review is dropped; advisory returns suggestion without moving or changing preview');mode('off');
}

// No approved call here: this case proves a normal Desk can review one saved native memo
// along with Board cards in Firefox, not merely the pure photo adapter/Board-only route.
export async function verifyDeskPhoto({a,id,j,bounded,decisions,mode,mark,evidence}) {
  const p = n => j('presentation-' + n), note='오후 인계 순서를 메모합니다';
  const before=decisions(); mode('on');
  if (await a.has('#egd-joint-panel')) await a.click(j('panel-close'));
  await a.click('.egd-dock-btn[data-id="memo"]'); await a.see(id('memo-text'));
  await a.fill(id('memo-text'),note); await a.evaluate(()=>{document.querySelector('[data-testid="memo-text"]').blur();return true;});
  await bounded(()=>a.evaluate(t=>{const raw=Services.prefs.getStringPref('egdesk.deskSession.v1','');return !!raw&&JSON.parse(raw).cards.some(c=>c.type==='memo'&&c.runtimeState?.text===t);},note),Boolean,'exact memo body locally persisted before optional photo');
  await a.evaluate(()=>{const layer=document.getElementById('egd-canvas-layer'),r=layer.getBoundingClientRect(),z=new DOMMatrix(getComputedStyle(layer).transform).a||1;const cards=[...layer.querySelectorAll(':scope > [data-testid="joint-card"]'),layer.querySelector(':scope > [data-testid="memo-card"]')].filter(Boolean);cards.forEach((el,i)=>{const x=145+225*(i%4),y=166+100*Math.floor(i/4);Object.assign(el.style,{left:Math.round((x-r.left)/z)+'px',top:Math.round((y-r.top)/z)+'px'});});return true;});
  if (!(await a.has('#egd-agenda-switcher'))) await a.click(id('rail-board-list'));
  await a.click(id('desk-fast-arrange')); await a.see(p('prepare')); await a.click(p('prepare'));
  const outcome=await bounded(()=>a.evaluate(()=>({ready:!!document.querySelector('[data-testid="joint-presentation-photo"]'),status:document.querySelector('[data-testid="joint-presentation-status"]')?.textContent||''})),v=>v.ready||/수동으로/.test(v.status),'exact mixed Desk image available');
  if(!outcome.ready) {const d=await a.evaluate(()=>{const n=document.querySelector('[data-testid="memo-card"]'),e=n?.querySelector('textarea'),l=document.getElementById('egd-canvas-layer'),cs=e&&getComputedStyle(e);return {root:!!n,rect:n?.getBoundingClientRect().toJSON(),shell:n?._deskWindowShell?.root===n,rec:[n?._memoRecord?.author?.kind,n?._memoRecord?.revision],sizes:[e?.clientHeight,e?.scrollHeight,cs?.whiteSpace,cs?.lineHeight,cs?.textAlign],workplane:l?.parentElement?.id,projection:n?.dataset.projectionId,slot:n?._deskWindowShell?.slots?.content?.className,selected:[...document.querySelectorAll('#egd-joint-presentation input[type="checkbox"]')].filter(x=>x.checked).length};});throw Error('mixed Desk local photo unavailable: '+JSON.stringify([outcome,d]));}
  const proof=await a.evaluate(()=>{const p=document.querySelector('[data-testid="joint-presentation-photo"]'),rows=[...document.querySelectorAll('#egd-joint-presentation input[type="checkbox"]')].filter(i=>i.checked);return {image:p?.getAttribute('src'),count:rows.length,localMemo:rows.some(i=>i.parentElement.textContent.includes('개인 메모'))};});
  assert.equal(proof.localMemo,true);assert.ok(proof.count>=3);assert.ok(proof.image?.startsWith('data:image/png;base64,')); if(evidence)fs.writeFileSync(path.join(evidence,'desk-approved-scope.png'),Buffer.from(proof.image.split(',')[1],'base64'));await a.click(p('decision-cancel'));await a.click(p('cancel'));assert.equal(decisions(),before);
  mark('Desk menu: locally saved personal memo plus authorized Board cards render in one reviewed PNG, cancelled without a model call');mode('off');
}

export async function verifyOverlappedMaterials({a,b,j,bounded,screenshot,store,taskTitle,privateTitle,resetByOpen,manageCard,grant,closePanel,mark}) {
  const control = j('board-structure'), action = j('material-action'), list = j('board-materials');
  const card = (who,title) => store.view(who).boards[0].cards.find(c => c.title === title);
  const selected = (who,title) => `${action}[data-material-id="${card(who,title).id}"]`;
  const active = x => x.evaluate(() => document.activeElement?.dataset.testid);
  await grant(privateTitle);
  await resetByOpen(a); await resetByOpen(b);
  // Cover all four Board cards with one real, unrelated Desk memo. This is only a synthetic
  // Canvas pose fixture; the Board surface, authorization and both input paths are product code.
  const original = await a.evaluate(() => [...document.querySelectorAll('#egd-canvas-layer > [data-testid="joint-card"], #egd-canvas-layer > .egd-memo-card')].map(n => [n.id,n.style.cssText]));
  await a.click('.egd-dock-btn[data-id="memo"]');
  await a.see('.egd-memo-card');
  const coverId = await a.evaluate(() => document.querySelector('#egd-canvas-layer > .egd-memo-card')?.id);
  const overlap = await a.evaluate(() => {
    const layer = document.getElementById('egd-canvas-layer'), r = layer.getBoundingClientRect();
    const zoom = new DOMMatrix(getComputedStyle(layer).transform).a || 1;
    const cards = [...layer.querySelectorAll('[data-testid="joint-card"]')], memo = layer.querySelector('.egd-memo-card');
    const nodes = [...cards,memo];
    nodes.forEach((n,i) => Object.assign(n.style, {left:Math.round((170-r.left)/zoom)+'px',top:Math.round((132-r.top)/zoom)+'px',width:Math.round((i===4?550:400)/zoom)+'px',height:Math.round((i===4?560:390)/zoom)+'px',zIndex:String(16000+i)}));
    const probes = node => {
      const b = node.getBoundingClientRect(), samples = [0.2,0.5,0.8].flatMap(x => [0.2,0.5,0.8].map(y => [b.left+x*b.width,b.top+y*b.height]));
      return {hit:samples.filter(([x,y]) => node.contains(document.elementFromPoint(x,y))).length,total:samples.length};
    };
    return cards.map(n => ({card:probes(n),manage:probes(n.querySelector('[data-testid="joint-item-manage"]'))}));
  });
  assert.equal(overlap.length,4);
  assert.ok(overlap.every(p => p.card.hit === 0 && p.manage.hit === 0),JSON.stringify(overlap));
  const poses = () => [...document.querySelectorAll('#egd-canvas-layer > .egd-canvas-card')].map(n=>[n.id,n.style.cssText]);
  const before = await a.evaluate(poses);
  const pointer = await a.pointer(control);
  const relation = privateTitle + ' → 완료를 기다리는 선행 자료: ' + taskTitle;
  await a.see(j('material-edge'),relation);
  assert.equal(await a.evaluate(() => document.querySelectorAll('[data-testid="joint-material-row"]').length),4);
  await screenshot(a,'joint-four-overlap-materials');
  await a.pointer(selected('sender',privateTitle));
  await a.see(j('share'));
  assert.equal(await a.evaluate(()=>document.querySelector('#egd-joint-panel h3')?.textContent),privateTitle);
  await screenshot(a,'joint-four-overlap-selected-manage');
  const escape = await a.key('Escape');
  assert.equal(await a.has('#egd-joint-panel'),false);
  assert.equal(await active(a),'joint-board-structure');
  assert.deepEqual(await a.evaluate(poses),before);
  // The fixed rail is keyboard reachable via normal tab traversal, not by dispatching to the button.
  await a.key('Tab','.egd-rail-switcher');
  for(let i=0;i<7 && await active(a)!=='joint-board-structure';i++) await a.key('Tab');
  assert.equal(await active(a),'joint-board-structure');
  const keyboard = await a.key('Enter');
  await a.see(j('material-edge'),relation);
  await a.key('Escape');
  await resetByOpen(a);
  await a.pointer(control); await a.see(j('material-edge'),relation);
  await screenshot(a,'joint-four-materials-reopened');
  await closePanel(a);
  const recipient = await b.pointer(control);
  await b.see(j('material-edge'),relation);
  assert.equal(await b.has(`${action}[data-action="manage"]`),false);
  const child = selected('partner',privateTitle);
  await b.key('Enter',child); await b.see(j('material-claim-confirm'));
  assert.equal(await b.evaluate(()=>document.querySelector('#egd-joint-panel h3')?.textContent),privateTitle);
  await b.pointer(j('material-decline'));
  await b.see(list);
  assert.equal(card('partner',privateTitle).claimed,false);
  assert.equal(await active(b),'joint-material-action');
  await b.key('Enter'); await b.pointer(j('material-claim-confirm'));
  await b.see(`${child}[data-action="reply"]`);
  await b.key('Enter',child); await b.see(j('material-reply-text'));
  await screenshot(b,'joint-materials-recipient-reply');
  await manageCard(a,privateTitle); await a.click(j('revoke')); await a.click(j('confirm')); await closePanel(a);
  await bounded(() => b.evaluate(title => {
    const panel = document.getElementById('egd-joint-panel');
    return !!panel?.querySelector('[data-testid="joint-board-materials"]') && !panel.textContent.includes(title)
      && !panel.querySelector('[data-testid="joint-material-edge"]') && !panel.querySelector('[data-testid="joint-material-reply-text"]')
      && panel.querySelectorAll('[data-testid="joint-material-row"]').length === 1 && panel.contains(document.activeElement);
  },privateTitle),Boolean,'revocation purges stale reply and edge, updates list and restores safe focus');
  await screenshot(b,'joint-materials-recipient-revoked');
  await b.key('Escape'); await resetByOpen(b);
  await b.pointer(control); await b.see(list,taskTitle);
  assert.equal(await b.has(j('material-edge')),false);
  assert.equal(await b.evaluate(t=>document.getElementById('egd-joint-panel').textContent.includes(t),privateTitle),false);
  await closePanel(b);
  await a.evaluate(styles => {for (const [id,style] of styles) {const n = document.getElementById(id); if (n) n.style.cssText = style;} return true;},original);
  if (!original.some(([id]) => id === coverId)) await a.click('#' + coverId + ' .egd-card-dot-close');
  const evidence=process.env.EGDESK_JOINT_EVIDENCE;
  if(evidence)fs.writeFileSync(path.join(evidence,'board-materials-acceptance.json'),JSON.stringify({overlap,pointer,keyboard,escape,recipient,relation,selected:privateTitle,unchangedPoses:true,claimDeclined:true,replyOpened:true,revocationClearedReplyAndLink:true,reopen:true},null,2));
  mark('4 owner cards and all manage targets: 0/9 Gecko hits each; fixed Board control hits and trusted input opens exact live action, with no geometry changes');
  mark('recipient claim/decline/reply reaches selected card only; live endpoint revoke purges reply, title and edge, also after Board reopen');
}
