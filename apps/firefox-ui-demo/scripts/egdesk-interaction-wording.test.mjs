// A36 / B70 / B27 / B06 (UX-03, BRW-01): general words on screen are Korean,
// the way back to a conversation has one name.
// The surface source stays the source of truth; this file reads it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';


const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const surfaceJs = read('../overlay/JS/eg-desk-surface.uc.js');


function between(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing ${end} after ${start}`);
  return source.slice(from, to);
}
const occurrences = (source, needle) => source.split(needle).length - 1;

test('A36 built-in Agent labels are Korean except the product names Chat and PM', () => {
  const block = between(surfaceJs, 'const CODEX_AGENT_PROFILE_DEFS = [', 'const CODEX_AGENT_PROFILES =');
  const rows = [...block.matchAll(/id: '([^']+)',\n\s+label: '([^']+)'/g)].map(match => [match[1], match[2]]);
  assert.deepEqual(rows, [
    ['conversational-coding', 'Chat'], ['tool-operator', '도구'], ['coding-project-manager', 'PM'],
    ['codebase-explorer', '탐색'], ['implementation-worker', '구현'], ['review-verifier', '검증'],
  ], 'stored ids stay; only the label shown on screen changes');
});

test('A36 Settings and Ontology windows fall back to Korean names', () => {
  assert.ok(surfaceJs.includes("settings: ['.egd-settings-title', '설정'], ontology: ['.egd-ontology-title', '온톨로지']"));
  const rail = between(surfaceJs, 'function cardLabelForViewportRail(card) {', '\n  }\n');
  assert.match(rail, /egd-settings-card'\)\) return '설정';/);
  assert.match(rail, /egd-ontology-card'\)\) return '온톨로지';/);
  for (const english of ["'Settings'", "'Ontology'"]) assert.equal(occurrences(surfaceJs, english), 0, english);
});

test('B70 the way back to a conversation has one name', () => {
  assert.equal(occurrences(surfaceJs, "'대화로 돌아가기'"), 1);
  for (const old of ['채팅으로 돌아가기', "'← 돌아가기'"]) assert.equal(occurrences(surfaceJs, old), 0, old);
  // The Agent form says where its link goes instead of a bare "back".
  assert.ok(surfaceJs.includes("agents.profileId ? '← Agent 상세로' : '← Agent 목록으로'"));
});

test('B27 the side Chat panel is titled 채팅, not 코덱스 채팅', () => {
  assert.equal(occurrences(surfaceJs, '코덱스 채팅'), 0);
  assert.ok(surfaceJs.includes("textContent = appId === 'chat' ? '채팅' : appLabel;"));
});
