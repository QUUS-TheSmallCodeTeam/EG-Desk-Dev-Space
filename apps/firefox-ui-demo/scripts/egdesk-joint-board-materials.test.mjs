import test from 'node:test';
import assert from 'node:assert/strict';
import {boardCardAction, boardMaterials} from '../overlay/resources/EGDeskJointBoardStructure.sys.mjs';

const el = (tag, attrs, ...children) => ({tag, attrs, children:children.filter(child => child != null)});
const action = (card, kind) => el('button', {kind}, card.title);
const waiting = {id:'child', title:'접수 확인'};
const prerequisite = {id:'parent', title:'서류 제출', own:true};
const link = {child:'child', parent:'parent', kind:'waits'};

test('Board materials use only projected card rows and authorized directed relationships', () => {
  const list = boardMaterials(el,{cards:[waiting,prerequisite],links:[link]},action);
  assert.equal(list.tag,'ul');
  assert.equal(list.children.length,2);
  assert.equal(list.children[0].tag,'li');
  assert.equal(list.children[0].children[1].children[0],'접수 확인 → 완료를 기다리는 선행 자료: 서류 제출');
  assert.equal(list.children[0].children[2].attrs.kind,'claim');
  assert.equal(list.children[1].children[1].attrs.kind,'manage');
  for (const cards of [[waiting],[prerequisite]]) {
    const filtered = boardMaterials(el,{cards,links:[link]},action);
    assert.equal(filtered.children.length,1);
    assert.ok(!JSON.stringify(filtered).includes(cards[0]===waiting ? prerequisite.title : waiting.title));
    assert.ok(!JSON.stringify(filtered).includes('joint-material-edge'));
  }
  const reference = boardMaterials(el,{cards:[waiting,prerequisite],links:[{...link,kind:'refers'}]},action);
  assert.equal(reference.children[0].children[1].children[0],'접수 확인 → 참조하는 자료: 서류 제출');
});

test('Card action reflects current projected ownership and recipient lifecycle', () => {
  assert.equal(boardCardAction({own:true}),'manage');
  assert.equal(boardCardAction({}),'claim');
  assert.equal(boardCardAction({claimed:true}),'reply');
  assert.equal(boardCardAction({claimed:true,replied:true}),null);
});
