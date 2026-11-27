// Only these published adapters can have controls inside Firefox chrome. A package supplies no DOM, URL, script or commands.
export const teamAppTypes=Object.freeze(['shipment','inspection']);
export const appLabels=Object.freeze({shipment:'배송 현황',inspection:'검수 체크리스트'});
export const appStates=Object.freeze({ready:'집하 대기',picked:'집하 완료',delivered:'배송 완료',waiting:'검수 대기',pass:'검수 통과',hold:'보류'});
export function nextAppStates(type,state){return type==='shipment'?({ready:['picked'],picked:['delivered'],delivered:[]}[state]||[]):type==='inspection'?({waiting:['pass','hold'],hold:['pass'],pass:[]}[state]||[]):[];}
export function isAppState(type,state){return type==='shipment'&&['ready','picked','delivered'].includes(state)||type==='inspection'&&['waiting','pass','hold'].includes(state);}
export function isAppRef(ref){return typeof ref==='string'&&/^[A-Za-z0-9가-힣][A-Za-z0-9가-힣._ -]{0,39}$/.test(ref);}
