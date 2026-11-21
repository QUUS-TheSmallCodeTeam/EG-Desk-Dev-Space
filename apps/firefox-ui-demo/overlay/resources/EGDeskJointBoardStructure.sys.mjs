// Receives only a recipient's validated board projection. All coordinates are local Canvas coordinates.
export function createBoardStructure({document:d,el,geometry,getBoard,byId,reveal}){
 let inspecting=null;const layer=()=>d.getElementById('egd-canvas-layer');
 const svg=(tag,attrs)=>{const e=d.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value] of Object.entries(attrs))e.setAttribute(key,String(value));return e;};
 function rootFor(p,c){const m=p?.members.find(m=>m.sourceId===c.id),node=m&&d.getElementById(m.viewId);return node?.dataset.projectionId===p.id&&node.dataset.jointLease===c.access?node:null;}
 function jump(k,id){const p=byId(k),c=getBoard(k)?.cards.find(c=>c.id===id);const node=c&&p&&rootFor(p,c);if(node){reveal(node);node.querySelector('.egd-desk-window-titlebar')?.setAttribute('tabindex','-1');node.querySelector('.egd-desk-window-titlebar')?.focus({preventScroll:true});}}
 function clear(){const previous=inspecting;inspecting=null;if(previous){const r=d.getElementById(previous),count=r?.querySelector('.egd-joint-board-count');if(count){count.setAttribute('aria-pressed','false');count.textContent=count.textContent.replace('구성 닫기','구성 보기');}}for(const e of d.querySelectorAll('[data-joint-inspected]'))e.removeAttribute('data-joint-inspected');for(const e of d.querySelectorAll('.egd-joint-structure-strip,.egd-joint-link-layer'))e.remove();for(const e of d.querySelectorAll('.egd-board-region[data-joint-board] .egd-board-region-title'))e.setAttribute('aria-pressed','false');}
 function draw(p){const b=getBoard(p.boardId),region=d.getElementById(p.id);if(!region||!b)return;region.dataset.jointBoard='true';const button=region.querySelector('.egd-board-region-title');const active=inspecting===p.id;button.setAttribute('aria-pressed',String(active));button.setAttribute('aria-label',b.title+' · 내게 열린 카드 '+b.cards.length+'장 · 구성 보기');button.title='보드 구성 보기 또는 닫기';const head=region.querySelector('.egd-board-region-head');let badge=head.querySelector('.egd-joint-board-count');if(!badge){badge=el('button',{class:'egd-joint-board-count',type:'button',onclick:e=>{e.stopPropagation();button.click();},data:{testid:'joint-inspect'}},'');head.insertBefore(badge,head.querySelector('.egd-board-region-menu-button'));}badge.textContent=(active?'구성 닫기':'구성 보기')+' · '+b.cards.length+'장';badge.setAttribute('aria-pressed',String(active));region.querySelector('.egd-joint-link-layer')?.remove();const nodes=new Map();for(const [i,c] of b.cards.entries()){const node=rootFor(p,c);if(!node)continue;nodes.set(c.id,node);node.toggleAttribute('data-joint-inspected',active);}
 if(!active){region.querySelector('.egd-joint-structure-strip')?.remove();return;}region.setAttribute('data-joint-inspected','');let strip=region.querySelector('.egd-joint-structure-strip');const sig=JSON.stringify(b.cards.map(c=>[c.id,c.title,c.access]));if(!strip||strip._sig!==sig){strip?.remove();strip=el('nav',{class:'egd-joint-structure-strip','aria-label':b.title+' 소속 카드',data:{testid:'joint-members'}},el('strong',{},'소속 자료'),...b.cards.map((c,i)=>el('button',{type:'button',title:c.title,data:{testid:'joint-member-jump'},onclick:e=>{e.stopPropagation();jump(p.boardId,c.id);}},String(i+1).padStart(2,'0')+'  '+c.title)));strip._sig=sig;region.append(strip);}
 if(!b.links.length)return;const r=geometry(region);const art=svg('svg',{class:'egd-joint-link-layer',width:r.width,height:r.height,viewBox:`0 0 ${r.width} ${r.height}`,'aria-hidden':'true'});const marker=svg('marker',{id:'joint-tip-'+p.id,markerWidth:8,markerHeight:8,refX:7,refY:4,orient:'auto'});marker.append(svg('path',{d:'M0 1 L7 4 L0 7 z',class:'egd-joint-arrowhead'}));const defs=svg('defs',{});defs.append(marker);art.append(defs);
 for(const [i,e] of b.links.entries()){const a=nodes.get(e.parent),z=nodes.get(e.child);if(!a||!z)continue;const x=geometry(a),y=geometry(z);const sx=x.x-r.x+Math.min(x.width*.68,x.width-11),ex=y.x-r.x+Math.min(y.width*.30,y.width-11),sy=x.y-r.y-1,ey=y.y-r.y-3;const lane=Math.max(49,Math.min(sy,ey)-11-(i%3)*5);const line=svg('path',{d:`M ${sx} ${sy} V ${lane} H ${ex} V ${ey}`,class:'egd-joint-connector '+(e.kind==='refers'?'reference':'prerequisite'),'data-testid':'joint-connector','marker-end':`url(#joint-tip-${p.id})`});art.append(line);}region.prepend(art);}
 function toggle(p){const off=inspecting===p.id;clear();if(!off)inspecting=p.id;return !off;}
 return {clear,draw,jump,toggle,is:p=>inspecting===p?.id,leave:p=>{if(inspecting&&inspecting!==p?.id)clear();},removed:p=>{if(inspecting===p.id)clear();}};
}

// The viewport list is generated from the checked service projection, not Canvas windows.
export function boardCardAction(card) {
  return card.own ? 'manage' : card.replied ? null : card.claimed ? 'reply' : 'claim';
}

export function boardMaterials(el, board, actionButton) {
  const cards = new Map(board.cards.map(card => [card.id, card]));
  const links = new Map(board.links.filter(edge => cards.has(edge.child) && cards.has(edge.parent))
    .map(edge => [edge.child, edge]));
  return el('ul', {class:'egd-joint-materials', data:{testid:'joint-board-materials'}}, ...board.cards.map(card => {
    const edge = links.get(card.id), target = edge && cards.get(edge.parent);
    return el('li', {class:'egd-joint-material', data:{testid:'joint-material-row'}},
      el('h4', {}, card.title),
      target ? el('p', {class:'egd-joint-material-edge', data:{testid:'joint-material-edge'}},
        card.title + (edge.kind === 'waits' ? ' → 완료를 기다리는 선행 자료: ' : ' → 참조하는 자료: ') + target.title) : null,
      boardCardAction(card) ? actionButton(card, boardCardAction(card)) : el('small', {}, '회신 보냄'));
  }));
}
