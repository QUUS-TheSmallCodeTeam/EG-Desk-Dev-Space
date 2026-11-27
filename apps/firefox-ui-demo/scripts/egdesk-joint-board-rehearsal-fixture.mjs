// This is an offline rehearsal with synthetic data, not an authorization service.
export function makeRehearsal() {
  const names = { minjae: '민재', seoyun: '서윤', jiu: '지우' };
  const labels = {
    join: '초대 수락하기', leave: '보드에서 나가기', shipping: '지우에게 배송 카드 공개',
    withdraw: '배송 공개 회수', accept: '배송 확인 맡기', own: '내 배송 Agent에 묻기',
    lend: '민재의 검수 Agent 한 번 허용', unlending: '검수 Agent 허가 회수',
    borrowed: '민재의 검수 Agent에 묻기', finish: '가상 결과 도착', reply: '민재에게 배송 상태 회신',
    erpOff: 'ERP 조회 연결 회수', closeView: '내 보드 창 닫기', reopen: '내 보드 창 다시 열기', invite: '지우 다시 초대',
  };
  const init = () => ({ jiu: false, invited: true, memberVersion: 0, ship: false, shipVersion: 0,
    loan: 'none', loanVersion: 0, accepted: false, seoyun: true, sOpen: true, erp: true,
    serial: 0, task: null, receipt: null });
  const erpLive = s => s.seoyun && s.erp;
  const fresh = (s,t) => !!t && s.jiu && s.ship && s.accepted && t.memberVersion === s.memberVersion && t.shipVersion === s.shipVersion && (t.worker === 'own' || (t.loanVersion === s.loanVersion && s.loan === 'spent'));
  const pending = s => s.task?.status === 'pending';
  const isMember = (s, actor) => actor === 'minjae' || (actor === 'seoyun' && s.seoyun) || (actor === 'jiu' && s.jiu);
  function allowed(s, actor, verb) {
    if (actor === 'simulation') return verb === 'finish' && pending(s);
    if (!Object.hasOwn(names,actor)) return false;
    switch (verb) {
      case 'invite': return actor === 'minjae' && !s.jiu && !s.invited;
      case 'join': return actor === 'jiu' && s.invited && !s.jiu;
      case 'shipping': return actor === 'minjae' && s.jiu && !s.ship;
      case 'withdraw': return actor === 'minjae' && s.jiu && s.ship;
      case 'accept': return actor === 'jiu' && s.jiu && s.ship && !s.accepted;
      case 'lend': return actor === 'minjae' && s.jiu && s.ship && s.loan === 'none';
      case 'unlending': return actor === 'minjae' && s.jiu && s.loan !== 'none';
      case 'own': case 'borrowed': return actor === 'jiu' && s.jiu && s.ship && s.accepted && !pending(s) && (verb === 'own' || s.loan === 'ready');
      case 'reply': return actor === 'jiu' && s.task?.status === 'delivered' && fresh(s,s.task) && s.receipt?.id!==s.task.id;
      case 'leave': return (actor === 'jiu' || actor === 'seoyun') && isMember(s,actor);
      case 'erpOff': return actor === 'seoyun' && erpLive(s) && s.sOpen;
      case 'closeView': return actor === 'seoyun' && s.seoyun && s.sOpen;
      case 'reopen': return actor === 'seoyun' && s.seoyun && !s.sOpen;
      default: return false;
    }
  }
  // Each click uses the supplied actor. The reader switch and guide are demonstration controls only.
  function step(s, actor, verb, completionId) {
    if (!allowed(s,actor,verb)) return { ok:false,state:s };
    const n={...s};
    switch (verb) {
      case 'join': n.jiu=true; n.invited=false; n.memberVersion++; break;
      case 'invite': n.invited=true; break;
      case 'shipping': n.ship=true; n.shipVersion++; break;
      case 'withdraw': n.ship=false; n.shipVersion++; n.accepted=false; n.loan='none'; n.loanVersion++; break;
      case 'accept': n.accepted=true; break;
      case 'lend': n.loan='ready'; n.loanVersion++; break;
      case 'unlending': n.loan='none'; n.loanVersion++; break;
      case 'own': case 'borrowed':
        n.serial++; n.task={id:n.serial,worker:verb,memberVersion:n.memberVersion,shipVersion:n.shipVersion,loanVersion:n.loanVersion,status:'pending',input:{shipment:'SH-42',fields:['pickupStatus']},to:'jiu'};
        if(verb==='borrowed') n.loan='spent'; break;
      case 'finish':
        if(completionId!==s.task.id) return {ok:false,state:s};
        if(fresh(s,s.task) && s.task.to==='jiu' && s.task.input.shipment==='SH-42' && s.task.input.fields.length===1 && s.task.input.fields[0]==='pickupStatus'){
          n.task={...s.task,status:'delivered',output:{shipment:'SH-42',pickupStatus:'집하 준비됨'}};
        } else {n.task={...s.task,status:'withheld'};} break;
      case 'reply': n.receipt={id:s.task.id,shipment:s.task.output.shipment,pickupStatus:s.task.output.pickupStatus}; break;
      case 'leave':
        if(actor==='seoyun'){ n.seoyun=false; n.sOpen=false; }
        else{ n.jiu=false; n.invited=false; n.memberVersion++; n.ship=false; n.shipVersion++; n.accepted=false; n.loan='none'; n.loanVersion++; n.task=null; }
        break;
      case 'erpOff': n.erp=false; break;
      case 'closeView': n.sOpen=false; break;
      case 'reopen': n.sOpen=true; break;
    }
    return {ok:true,state:n};
  }
  // All participant-facing surfaces are built from this projection, not by hiding rows with CSS.
  function view(s, who) {
    const o={heading:'',lead:'',cards:[],updates:[],actions:[]};
    function card(label,title,copy) {o.cards.push({label,title,copy});}
    if (!Object.hasOwn(names,who)){o.heading='이용할 수 없음';return o;}
    if(!isMember(s,who)){
      o.heading=who==='jiu'&&s.invited?'공용 보드 초대가 왔어요':'이 보드에 참여하고 있지 않아요';
      o.lead=who==='jiu'&&s.invited?'수락하면 보드에 들어갑니다. 자료나 Agent 권한은 따로 받습니다.':'현재 받을 수 있는 카드나 알림이 없습니다.';
    } else if(who==='seoyun' && !s.sOpen){
      o.heading='보드 창을 닫았어요';o.lead='창 닫기는 멤버 탈퇴나 자료 연결 회수가 아닙니다.';
    } else {
      o.heading='출고 협업';o.lead=who==='jiu'?'내게 공개된 업무만 확인합니다.':'같은 보드에서 주문 대조와 배송 확인을 나누어 진행합니다.';
      if(who!=='jiu'){
        card('민재가 제공한 사본','발주서 · 주문 317','발주 수량 21개');
        if(erpLive(s)){card('서윤이 허용한 조회','ERP · 주문 317','저장 수량 8개');card('두 자료로 계산','수량 대조','차이 13개 · 원인 확인');}
        if(who==='minjae') card('민재의 배송 자료','출고 확인','운송 참조 SH-42');
        if(who==='minjae'&&s.ship) o.updates.push(s.accepted?'지우가 배송 확인을 맡았습니다.':'배송 카드를 지우에게 공개했습니다. 아직 맡지 않았습니다.');
        if(who==='minjae'&&s.receipt) {card('지우가 민재에게 회신','배송 확인 결과',s.receipt.shipment+' · '+s.receipt.pickupStatus);o.updates.push('지우의 배송 회신이 도착했습니다.');}
      } else {
        if(s.ship){card('민재가 지우에게 공개','배송 확인 요청','운송 참조 SH-42 · 집하 상태를 확인해 주세요.');o.updates.push(s.accepted?'지우가 배송 확인을 맡았습니다.':'배송 확인을 부탁받았습니다. 아직 맡지 않았습니다.');}
        if(s.loan==='ready')o.updates.push('민재의 검수 Agent가 이 배송 건에 한해 한 번 허용됐습니다.');
        if(s.task&&s.task.memberVersion===s.memberVersion){
          if(s.task.status==='pending'){o.updates.push('요청 접수 · 아직 답이 없습니다.');}
          if(s.task.status==='withheld' || (s.task.status==='delivered'&&!fresh(s,s.task))){o.updates.push('이 요청의 결과는 현재 열 수 없습니다.');}
          if(s.task.status==='delivered' && fresh(s,s.task)){card('지우에게만 도착',s.task.worker==='own'?'지우의 배송 Agent 답변':'민재의 검수 Agent 답변',s.task.output.shipment+' · '+s.task.output.pickupStatus);o.updates.push(s.receipt?.id===s.task.id?'민재에게 회신했습니다.':'아직 민재에게 보낸 답이 아닙니다.');}
        }
      }
      if(!o.cards.length) o.lead='아직 내게 공개된 업무 카드가 없습니다.';
    }
    o.actions=Object.keys(labels).filter(x=>allowed(s,who,x)); return o;
  }
  return {names,labels,init,step,view,allowed};
}
