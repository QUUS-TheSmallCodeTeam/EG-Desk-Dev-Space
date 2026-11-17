import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as RailSearchView from '../overlay/resources/EGDeskRailSearchView.sys.mjs';

const surfaceSource = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const surfaceCss = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
const declaration = name => {
  const start = surfaceSource.indexOf(`  function ${name}(`);
  const end = start < 0 ? -1 : surfaceSource.indexOf('\n  }\n', start);
  assert.ok(end > 0, `${name} must remain directly testable`);
  return surfaceSource.slice(start, end + 4);
};
const compile = (names, deps) => new Function(...Object.keys(deps),
  `${names.map(declaration).join('\n')}\nreturn { ${names.join(', ')} };`)(...Object.values(deps));

const codex = { id: 't-codex', type: 'dm', title: 'Codex', pinned: true };
const analyst = { id: 't-analyst', type: 'dm', title: '분석가' };
const room = { id: 't-room', type: 'group', title: '견적 검토' };
const row = (type, key, extra = {}) => ({ key: `${type}:${key}`, type, section: type, title: key, subtitle: '', active: false, ...extra });

// ------------------------------------------------------------------ scopes

test('scope: three choices, unknown values read as 전체', () => {
  assert.deepEqual(RailSearchView.RAIL_SEARCH_SCOPES.map(scope => [scope.id, scope.label]),
    [['all', '전체'], ['canvas', 'Canvas'], ['boards', '저장한 Board']]);
  assert.ok(RailSearchView.RAIL_SEARCH_SCOPES.every(scope => scope.title), 'every chip explains itself');
  for (const value of [undefined, null, '', 'library', 'constructor']) assert.equal(RailSearchView.normalizeScope(value), 'all');
  assert.equal(RailSearchView.normalizeScope('boards'), 'boards');
  assert.equal(RailSearchView.scopeLabel('canvas'), 'Canvas');
  assert.equal(RailSearchView.scopeLabel('nope'), '전체');
});

test('scope: Canvas keeps open windows, 저장한 Board keeps saved Boards and their saved Browser pages', () => {
  const local = [row('agenda', 'saved', { saved: true }), row('agenda', 'unsaved', { saved: false }), row('card', 'c1'),
    row('history', 'h1'), row('file', 'f1'), row('thread', 't1')];
  const web = row('web', 'w');
  const keys = scope => RailSearchView.composeResults({ scope, local, web, ask: null }).map(result => result.key);
  assert.deepEqual(keys('all'), ['agenda:saved', 'agenda:unsaved', 'card:c1', 'history:h1', 'file:f1', 'thread:t1', 'web:w']);
  assert.deepEqual(keys('canvas'), ['card:c1']);
  assert.deepEqual(keys('boards'), ['agenda:saved', 'history:h1'], 'an unsaved Board is not a saved Board');
  assert.deepEqual(RailSearchView.composeResults({ scope: 'all', local, web, ask: null, navigation: true }).map(result => result.key)[0], 'web:w',
    'an address still leads the list');
});

// ---------------------------------------------------------------- ask row

test('ask recipient: the open conversation wins, otherwise the pinned Agent DM, never a guess', () => {
  const threads = [codex, analyst, room];
  assert.deepEqual(RailSearchView.askRecipient({ threads, activeThreadId: 't-analyst', conversationOpen: true }),
    { threadId: 't-analyst', name: '분석가', label: '분석가에게 요청', source: 'open' });
  assert.deepEqual(RailSearchView.askRecipient({ threads, activeThreadId: 't-room', conversationOpen: true }),
    { threadId: 't-room', name: '견적 검토', label: '견적 검토 대화에 요청', source: 'open' });
  assert.deepEqual(RailSearchView.askRecipient({ threads, activeThreadId: 't-analyst', conversationOpen: false }),
    { threadId: 't-codex', name: 'Codex', label: 'Codex에게 요청', source: 'pinned' }, 'a closed Chat does not make its last room the recipient');
  assert.equal(RailSearchView.askRecipient({ threads: [analyst, room], activeThreadId: 't-analyst', conversationOpen: false }), null);
  assert.equal(RailSearchView.askRecipient({ threads: [{ ...room, pinned: true }], conversationOpen: false }), null, 'a pinned room is not the fixed Agent');
  assert.equal(RailSearchView.askRecipient({}), null);
});

test('ask row: names the recipient and the sentence, says it is a draft, and is absent without words or recipient', () => {
  const recipient = RailSearchView.askRecipient({ threads: [codex], conversationOpen: false });
  const ask = RailSearchView.askRow('  이번 주   견적서 정리해줘 ', recipient);
  assert.equal(ask.key, 'ask:t-codex');
  assert.equal(ask.type, 'ask');
  assert.equal(ask.section, 'Agent 요청');
  assert.equal(ask.typeLabel, 'Agent');
  assert.equal(ask.title, 'Codex에게 요청: 이번 주 견적서 정리해줘');
  assert.match(ask.subtitle, /초안/);
  assert.match(ask.subtitle, /보내기는 직접/);
  assert.equal(ask.threadId, 't-codex');
  assert.equal(ask.text, '이번 주 견적서 정리해줘');
  assert.ok(ask.hint);
  assert.equal(RailSearchView.askRow('   ', recipient), null);
  assert.equal(RailSearchView.askRow('정리해줘', null), null);
});

test('ask row: always last, never cut by the row limit, and first only when nothing else was found', () => {
  const ask = RailSearchView.askRow('정리', RailSearchView.askRecipient({ threads: [codex] }));
  const local = Array.from({ length: 20 }, (_, index) => row('card', `c${index}`));
  const full = RailSearchView.composeResults({ scope: 'all', local, web: row('web', 'w'), ask });
  assert.equal(full.length, 14);
  assert.equal(full.at(-1), ask);
  assert.equal(full.filter(result => result.type === 'ask').length, 1);
  assert.deepEqual(RailSearchView.composeResults({ scope: 'canvas', local: [row('file', 'f')], web: row('web', 'w'), ask }), [ask],
    'with no other row the request is the default Enter target');
  const withWeb = RailSearchView.composeResults({ scope: 'all', local: [], web: row('web', 'w'), ask });
  assert.deepEqual(withWeb.map(result => result.type), ['web', 'ask'], 'the existing web row keeps its Enter');
});

test('ask draft: an existing draft is kept and the request goes on a new line, once', () => {
  assert.equal(RailSearchView.mergeAskDraft('', ' 정리해줘 '), '정리해줘');
  assert.equal(RailSearchView.mergeAskDraft('  \n', '정리해줘'), '정리해줘');
  assert.equal(RailSearchView.mergeAskDraft('쓰던 글', '정리해줘'), '쓰던 글\n정리해줘');
  assert.equal(RailSearchView.mergeAskDraft('쓰던 글\n\n', '정리해줘'), '쓰던 글\n정리해줘');
  assert.equal(RailSearchView.mergeAskDraft('쓰던 글\n정리해줘', '정리해줘'), '쓰던 글\n정리해줘', 'the same request is not stacked twice');
  assert.equal(RailSearchView.mergeAskDraft('정리해줘', '정리해줘'), '정리해줘');
  assert.equal(RailSearchView.mergeAskDraft('쓰던 글', '   '), '쓰던 글');
  assert.equal(RailSearchView.mergeAskDraft(undefined, '정리해줘'), '정리해줘');
});

// ------------------------------------------------------------ empty state

test('empty state: a narrowed scope with nothing found names the scope and offers 범위를 전체로', () => {
  const ask = RailSearchView.askRow('정리', RailSearchView.askRecipient({ threads: [codex] }));
  assert.equal(RailSearchView.emptyState({ scope: 'canvas', results: [row('card', 'c')] }), null);
  assert.deepEqual(RailSearchView.emptyState({ scope: 'canvas', results: [ask] }),
    { message: "'Canvas' 범위에서 찾은 것이 없습니다", widenLabel: '범위를 전체로' });
  assert.deepEqual(RailSearchView.emptyState({ scope: 'boards', results: [] }),
    { message: "'저장한 Board' 범위에서 찾은 것이 없습니다", widenLabel: '범위를 전체로' });
  assert.deepEqual(RailSearchView.emptyState({ scope: 'all', results: [] }), { message: '결과 없음', widenLabel: null });
  assert.deepEqual(RailSearchView.emptyState({ scope: 'all', results: [ask] }), { message: '결과 없음', widenLabel: null });
});

// -------------------------------------------------- production wiring slices

function wiring({ threads = [codex, analyst], activeThreadId = 't-codex', hudOpen = false, hudApp = null, hudView = 'list',
  chatCardEntityId = null, drafts = {}, scope = 'all', local = [], bridge = true } = {}) {
  const calls = [];
  const state = {
    hudOpen, hudApp,
    railSearch: { query: '', scope, activeIndex: 0 },
    codex: { threads, activeThreadId, hudView, chatCardEntityId, threadDrafts: { ...drafts } },
    codexBridge: bridge ? {
      setDraft: (value, threadId) => { calls.push(['setDraft', threadId, value]); state.codex.threadDrafts[threadId] = value; },
      sendMessage: () => { calls.push(['sendMessage']); },
    } : null,
  };
  const composer = { dataset: { threadId: null }, disabled: false, value: '', focus: () => calls.push(['focus']), setSelectionRange: (...args) => calls.push(['caret', ...args]) };
  const api = compile(['railSearchQuery', 'railSearchAskRecipient', 'draftRailSearchAsk', 'buildRailSearchAskResult', 'buildRailSearchResults'], {
    state, RailSearchView,
    getCodexThreadById: (value, threadId) => value.threads.find(thread => thread.id === threadId) || null,
    getCodexThreadDraft: (value, threadId) => value.threadDrafts[threadId] || '',
    openCodexThreadFromRailSearch: (threadId) => { calls.push(['open', threadId]); state.codex.activeThreadId = threadId; composer.dataset.threadId = threadId; composer.value = state.codex.threadDrafts[threadId]; return true; },
    boardNotice: (message) => calls.push(['notice', message]),
    document: { querySelectorAll: () => [composer] },
    window: { requestAnimationFrame: (callback) => callback() },
    buildRailSearchAgendaResults: () => local.filter(result => result.type === 'agenda'),
    buildRailSearchCardResults: () => local.filter(result => result.type === 'card'),
    buildRailSearchHistoryResults: () => local.filter(result => result.type === 'history'),
    buildRailSearchFileResults: () => local.filter(result => result.type === 'file'),
    buildRailSearchThreadResults: () => local.filter(result => result.type === 'thread'),
    buildRailSearchWebResult: (q) => q ? row('web', q) : null,
    railSearchLooksLikeNavigation: () => false,
  });
  return { ...api, state, calls };
}

test('wiring: the request row is last, names the pinned Codex DM, and running it only drafts', () => {
  const { buildRailSearchResults, calls, state } = wiring({ local: [row('card', 'c1')], drafts: { 't-codex': '쓰던 글' } });
  assert.deepEqual(buildRailSearchResults('').map(result => result.type), ['card'], 'no words, no request row');
  const results = buildRailSearchResults('견적서 정리해줘');
  assert.deepEqual(results.map(result => result.type), ['card', 'web', 'ask']);
  const ask = results.at(-1);
  assert.equal(ask.title, 'Codex에게 요청: 견적서 정리해줘');
  assert.equal(ask.execute(), true);
  assert.deepEqual(calls.slice(0, 2), [['setDraft', 't-codex', '쓰던 글\n견적서 정리해줘'], ['open', 't-codex']], 'the draft is in place before the room opens');
  assert.ok(calls.some(([name]) => name === 'focus'), 'the composer takes focus so 보내기 is one step away');
  assert.ok(!calls.some(([name]) => name === 'sendMessage'), 'nothing is sent');
  assert.equal(state.codex.threadDrafts['t-codex'], '쓰던 글\n견적서 정리해줘');
});

test('wiring: an open Chat conversation is the recipient, in the HUD or as a Canvas window', () => {
  const hud = wiring({ activeThreadId: 't-analyst', hudOpen: true, hudApp: 'chat', hudView: 'conversation' });
  assert.equal(hud.buildRailSearchResults('요약').at(-1).title, '분석가에게 요청: 요약');
  const card = wiring({ activeThreadId: 't-analyst', chatCardEntityId: 'card-1', hudView: 'conversation' });
  assert.equal(card.buildRailSearchResults('요약').at(-1).title, '분석가에게 요청: 요약');
  const list = wiring({ activeThreadId: 't-analyst', hudOpen: true, hudApp: 'chat', hudView: 'list' });
  assert.equal(list.buildRailSearchResults('요약').at(-1).title, 'Codex에게 요청: 요약', 'the room list is not an open conversation');
  const otherPanel = wiring({ activeThreadId: 't-analyst', hudOpen: true, hudApp: 'settings', hudView: 'conversation' });
  assert.equal(otherPanel.buildRailSearchResults('요약').at(-1).title, 'Codex에게 요청: 요약');
});

test('wiring: a narrowed scope filters rows but keeps the request row; a failed draft says so and keeps the words', () => {
  const scoped = wiring({ scope: 'canvas', local: [row('agenda', 'b', { saved: true }), row('thread', 't')] });
  assert.deepEqual(scoped.buildRailSearchResults('정리').map(result => result.type), ['ask']);
  const gone = wiring({ bridge: false });
  const ask = gone.buildRailSearchResults('정리').at(-1);
  assert.equal(ask.execute(), false);
  assert.deepEqual(gone.calls, [['notice', '요청을 넣을 대화를 열지 못했습니다. Chat을 연 뒤 다시 시도해 주세요.']]);
  assert.equal(wiring({ threads: [analyst] }).buildRailSearchResults('정리').some(result => result.type === 'ask'), false,
    'without a fixed recipient there is no request row');
});

function keyboard({ results, activeIndex = 0, existingCard = false }) {
  const calls = [];
  const state = { railSearch: { query: '', open: true, activeIndex } };
  const { handleRailSearchKeydown } = compile(['handleRailSearchKeydown'], {
    state,
    railSearchQuery: value => String(value || '').trim(),
    buildRailSearchResults: () => results,
    executeRailSearchResult: (result) => { calls.push(['execute', result.key]); return true; },
    closeRailSearchPanel: () => calls.push(['close']),
    openRailSearchPanel: () => calls.push(['open']),
    railSearchBrowserUrl: q => `https://${q}`,
    browserSourceRef: uri => ({ uri }),
    focusOpenSourceCard: () => { calls.push(['tab-focus']); return existingCard; },
    RailSearchView,
    setRailSearchScope: (scope) => calls.push(['scope', scope]),
  });
  const press = (key, extra = {}) => {
    const ev = { key, metaKey: false, ctrlKey: false, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...extra };
    handleRailSearchKeydown(ev, { value: '견적서 정리해줘' });
    return ev;
  };
  return { press, calls, state };
}

test('keyboard: Enter runs the request only when it is the selected row; Ctrl/⌘ Enter always asks; Tab is unchanged', () => {
  const ask = row('ask', 't-codex');
  const web = row('web', 'w');
  const only = keyboard({ results: [ask] });
  assert.equal(only.press('Enter').prevented, true);
  assert.deepEqual(only.calls, [['execute', 'ask:t-codex']]);
  const mixed = keyboard({ results: [web, ask] });
  mixed.press('Enter');
  assert.deepEqual(mixed.calls, [['execute', 'web:w']], 'plain Enter keeps opening the first result');
  mixed.calls.length = 0;
  assert.equal(mixed.press('Enter', { ctrlKey: true }).prevented, true);
  mixed.press('Enter', { metaKey: true });
  assert.deepEqual(mixed.calls, [['execute', 'ask:t-codex'], ['execute', 'ask:t-codex']]);
  const noAsk = keyboard({ results: [web] });
  noAsk.press('Enter', { ctrlKey: true });
  assert.deepEqual(noAsk.calls, [['execute', 'web:w']], 'without a request row the shortcut is ordinary Enter');
  const tab = keyboard({ results: [web, ask], existingCard: true });
  assert.equal(tab.press('Tab').prevented, true);
  assert.deepEqual(tab.calls, [['tab-focus'], ['close']]);
  const arrows = keyboard({ results: [web, ask] });
  arrows.press('ArrowUp');
  assert.equal(arrows.state.railSearch.activeIndex, 1, 'one ↑ from the top reaches the request row');
});

test('keyboard: Alt/⌥ 1·2·3 picks the scope from the field and leaves other keys alone', () => {
  const pad = keyboard({ results: [row('web', 'w')] });
  assert.equal(pad.press('™', { altKey: true, code: 'Digit2' }).prevented, true, 'the key is read by position, not by the typed symbol');
  pad.press('£', { altKey: true, code: 'Digit3' });
  pad.press('¡', { altKey: true, code: 'Digit1' });
  assert.deepEqual(pad.calls.filter(([name]) => name === 'scope'), [['scope', 'canvas'], ['scope', 'boards'], ['scope', 'all']]);
  assert.equal(pad.state.railSearch.query, '견적서 정리해줘', 'the typed words stay');
  pad.calls.length = 0;
  for (const extra of [{ altKey: true, code: 'Digit4' }, { altKey: true, ctrlKey: true, code: 'Digit1' },
    { altKey: true, isComposing: true, code: 'Digit1' }, { code: 'Digit1' }]) {
    assert.equal(pad.press('1', extra).prevented, false);
  }
  assert.deepEqual(pad.calls, []);
});

// A minimal element stand-in: enough to read what the panel was told to draw.
function fakeEl(tag, props = {}, ...children) {
  const classes = String(props.class || '').split(' ');
  return { tag, props, children: children.filter(child => child != null), dataset: props.data || {},
    classList: { contains: name => classes.includes(name) } };
}
const walk = (node, visit) => { if (!node || typeof node === 'string') return; visit(node); node.children.forEach(child => walk(child, visit)); };
const collect = (nodes, className) => { const found = []; nodes.forEach(node => walk(node, item => { if (item.classList.contains(className)) found.push(item); })); return found; };
const textOf = node => typeof node === 'string' ? node : node.children.map(textOf).join('');
const click = node => node.props.onclick({ preventDefault() {}, stopPropagation() {} });

test('panel drawing: chips show the chosen scope; an empty narrowed scope offers 범위를 전체로 above the request row', () => {
  const ask = { ...RailSearchView.askRow('정리', RailSearchView.askRecipient({ threads: [codex] })), execute: () => true };
  const found = [row('agenda', '견적 Board', { saved: true })];
  const state = { railSearch: { query: '정리', scope: 'canvas', activeIndex: 3 } };
  const executed = [];
  const panel = { nodes: [], contains: () => false, replaceChildren(...nodes) { this.nodes = nodes; }, querySelectorAll: () => [] };
  const { renderRailSearchPanel } = compile(['setRailSearchScope', 'renderRailSearchPanel'], {
    state, RailSearchView, el: fakeEl,
    document: { activeElement: null, getElementById: () => panel },
    SurfaceState: { railSearchSectionLabel: type => `kind:${type}` },
    buildRailSearchResults: () => RailSearchView.composeResults({ scope: state.railSearch.scope, local: found, web: row('web', 'w'), ask }),
    updateRailSearchActiveRow: () => {}, updateRailSearchPanelPlacement: () => {},
    executeRailSearchResult: (result) => executed.push(result.key),
  });
  renderRailSearchPanel(panel);
  const chips = () => collect(panel.nodes, 'egd-rail-search-scope');
  assert.deepEqual(chips().map(chip => [textOf(chip), chip.props['aria-pressed'], chip.props.type]),
    [['전체', 'false', 'button'], ['Canvas', 'true', 'button'], ['저장한 Board', 'false', 'button']]);
  assert.ok(chips().every((chip, index) => chip.props.title.endsWith(`(Alt/⌥ ${index + 1})`)), 'each chip names its key');
  assert.equal(panel.nodes[0].props.role, 'group');
  assert.equal(textOf(collect(panel.nodes, 'egd-rail-search-empty')[0].children[0]), "'Canvas' 범위에서 찾은 것이 없습니다");
  const rows = () => collect(panel.nodes, 'egd-rail-search-result');
  assert.deepEqual(rows().map(item => item.dataset.type), ['ask']);
  assert.ok(rows()[0].classList.contains('egd-rail-search-result-active'), 'the lone request row is the Enter target');
  assert.equal(state.railSearch.activeIndex, 0);
  assert.deepEqual(rows()[0].children.map(textOf), ['Agent', `Codex에게 요청: 정리${ask.subtitle}`, 'Ctrl/⌘ Enter']);
  click(rows()[0]);
  assert.deepEqual(executed, ['ask:t-codex']);

  click(collect(panel.nodes, 'egd-rail-search-empty-action')[0]);
  assert.equal(state.railSearch.scope, 'all');
  assert.equal(chips()[0].props['aria-pressed'], 'true');
  assert.deepEqual(collect(panel.nodes, 'egd-rail-search-empty'), [], 'widening found rows, so the empty note is gone');
  assert.deepEqual(rows().map(item => item.dataset.type), ['agenda', 'web', 'ask']);
  assert.equal(textOf(rows()[0].children[0]), 'kind:agenda', 'found rows keep their own kind label');
  click(chips()[2]);
  assert.equal(state.railSearch.scope, 'boards');
  assert.deepEqual(rows().map(item => item.dataset.type), ['agenda', 'ask']);
});

test('panel: scope chips, the widen button and the request row are real buttons with labels, focus and token colors', () => {
  const render = declaration('renderRailSearchPanel');
  assert.match(render, /role: 'group', 'aria-label': '찾기 범위'/);
  assert.match(render, /'aria-pressed': String\(scope\.id === activeScope\)/);
  assert.match(render, /title: `\$\{scope\.title\} \(Alt\/⌥ \$\{index \+ 1\}\)`/);
  assert.match(render, /setRailSearchScope\('all'\)/);
  assert.match(render, /result\.typeLabel \|\| SurfaceState\.railSearchSectionLabel\(result\.type\)/);
  assert.match(declaration('executeRailSearchResult'), /result\.type === 'ask' && outcome === false\) return false;/,
    'a request that could not be drafted leaves the typed words in place');
  assert.match(declaration('openRailSearchPanel'), /ev\.key !== 'Escape'/, 'Esc from a chip closes the panel');
  const rule = selector => surfaceCss.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]+)\\}`, 'm'))?.[1] || '';
  // Buttons in the panel are written under its id: `.egd-edge button` would otherwise reset them.
  const panel = '#egd-rail-search-results ';
  for (const selector of ['.egd-rail-search-scopes', `${panel}.egd-rail-search-scope`, `${panel}.egd-rail-search-scope[aria-pressed="true"]`,
    '.egd-rail-search-type-ask', '.egd-rail-search-hint', `${panel}.egd-rail-search-empty-action`, `${panel}.egd-rail-search-result`]) {
    const body = rule(selector);
    assert.ok(body, `${selector} is styled`);
    assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|rgba?\(/i, `${selector} uses tokens only`);
  }
  assert.match(surfaceCss, /#egd-rail-search-results \.egd-rail-search-result:hover,\n#egd-rail-search-results \.egd-rail-search-result-active \{[^}]*background: color-mix\(in srgb, var\(--egd-primary\) 8%, transparent\)/,
    'the row Enter will run is visibly marked, also without the pointer');
  for (const selector of ['.egd-rail-search-scope', '.egd-rail-search-empty-action', '.egd-rail-search-result']) {
    assert.match(surfaceCss, new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:focus-visible[^{]*\\{[^}]*outline: var\\(--egd-focus-outline\\)`),
      `${selector} shows keyboard focus`);
  }
  assert.match(surfaceSource, /placeholder: '검색 또는 AI에게 요청\.\.\.'/, 'the promise on the field stays, now kept');
});

// ------------------------------------------- UX-04 remainder (2026-11-17)

test('paging: 6 rows first with the request row last, [더 보기] adds 6, and a short list has no button', () => {
  const ask = row('ask', 't-codex');
  const found = Array.from({ length: 13 }, (_, index) => row('history', `h${index}`));
  const first = RailSearchView.pageResults([...found, ask]);
  assert.equal(RailSearchView.RAIL_SEARCH_PAGE_ROWS, 6);
  assert.deepEqual(first.rows.map(item => item.key), ['history:h0', 'history:h1', 'history:h2', 'history:h3', 'history:h4', 'ask:t-codex']);
  assert.deepEqual([first.hidden, first.moreLabel], [8, '더 보기 (8개)']);
  const second = RailSearchView.pageResults([...found, ask], RailSearchView.nextVisibleLimit(6));
  assert.deepEqual([second.rows.length, second.rows.at(-1).type, second.hidden], [12, 'ask', 2]);
  const third = RailSearchView.pageResults([...found, ask], RailSearchView.nextVisibleLimit(12));
  assert.deepEqual([third.rows.length, third.hidden, third.moreLabel], [14, 0, null]);
  assert.deepEqual(RailSearchView.pageResults(found.slice(0, 6)).hidden, 0, 'without a request row all 6 places are found rows');
  assert.deepEqual(RailSearchView.pageResults([ask]).rows, [ask]);
  for (const bad of [undefined, 0, 3, 7.5, 'x']) assert.equal(RailSearchView.pageResults(found, bad).rows.length, 6);
  assert.equal(RailSearchView.nextVisibleLimit(undefined), 12);
});

test('IME: a composing key or the Enter that commits it never runs a row; a later Enter does', () => {
  const hold = RailSearchView.imeHoldsKey;
  assert.equal(hold({ key: 'Enter', isComposing: true }), true);
  assert.equal(hold({ key: 'Enter', keyCode: 229 }), true);
  assert.equal(hold({ key: 'Enter', composing: true }), true);
  assert.equal(hold({ key: 'Enter', endedAt: 1000, now: 1030 }), true, 'compositionend arrived just before its Enter');
  assert.equal(hold({ key: 'Enter', endedAt: 1000, now: 1000 + RailSearchView.RAIL_SEARCH_IME_COMMIT_GUARD_MS }), false);
  assert.equal(hold({ key: 'ArrowDown', endedAt: 1000, now: 1010 }), false, 'only Enter is held after the composition');
  assert.equal(hold({ key: 'Enter' }), false);

  const ask = row('ask', 't-codex');
  const kb = keyboard({ results: [ask] });
  assert.equal(kb.press('Enter', { isComposing: true }).prevented, false);
  assert.equal(kb.press('Enter', { keyCode: 229 }).prevented, false);
  assert.equal(kb.press('Enter', { ctrlKey: true, isComposing: true }).prevented, false, 'the request shortcut waits too');
  assert.equal(kb.press('ArrowDown', { isComposing: true }).prevented, false);
  assert.deepEqual(kb.calls, [], 'nothing ran while composing');
  assert.equal(kb.press('Enter').prevented, true);
  assert.deepEqual(kb.calls, [['execute', 'ask:t-codex']]);
  const source = declaration('handleRailSearchKeydown');
  assert.ok(source.indexOf('RailSearchView.imeHoldsKey') < source.indexOf("ev.key === 'Escape'"), 'the IME check comes before every key');
  assert.match(surfaceSource, /oncompositionstart: \(\) => \{ searchInput\._egdImeComposing = true; \}/);
  assert.match(surfaceSource, /oncompositionend: \(\) => \{ searchInput\._egdImeComposing = false; searchInput\._egdImeEndedAt = Date\.now\(\); \}/);
});

test('panel: [더 보기] is a button under the rows that shows 6 more and keeps the request row last', () => {
  const ask = { ...RailSearchView.askRow('정리', RailSearchView.askRecipient({ threads: [codex] })), execute: () => true };
  const found = Array.from({ length: 9 }, (_, index) => row('history', `h${index}`));
  const state = { railSearch: { query: '정리', scope: 'all', activeIndex: 0, visibleLimit: 6, moreCount: 0 } };
  const panel = { nodes: [], contains: () => false, replaceChildren(...nodes) { this.nodes = nodes; }, querySelectorAll: () => [] };
  const { renderRailSearchPanel } = compile(['renderRailSearchPanel'], {
    state, RailSearchView, el: fakeEl,
    document: { activeElement: null, getElementById: () => panel },
    SurfaceState: { railSearchSectionLabel: type => type },
    buildRailSearchResults: () => {
      const page = RailSearchView.pageResults([...found, ask], state.railSearch.visibleLimit);
      state.railSearch.moreCount = page.hidden;
      return page.rows;
    },
    setRailSearchScope: () => {}, updateRailSearchActiveRow: () => {}, updateRailSearchPanelPlacement: () => {}, executeRailSearchResult: () => {},
  });
  renderRailSearchPanel(panel);
  const rows = () => collect(panel.nodes, 'egd-rail-search-result');
  const more = () => collect(panel.nodes, 'egd-rail-search-more');
  assert.deepEqual([rows().length, rows().at(-1).dataset.type], [6, 'ask']);
  assert.deepEqual(more().map(node => [textOf(node), node.props.type]), [['더 보기 (4개)', 'button']]);
  click(more()[0]);
  assert.equal(state.railSearch.visibleLimit, 12);
  assert.deepEqual([rows().length, rows().at(-1).dataset.type], [10, 'ask']);
  assert.deepEqual(more(), [], 'everything is shown, so the button is gone');
});

test('wiring: [지우기] clears the words only and keeps the scope; paging resets on a new query or scope', () => {
  assert.match(surfaceSource, /class: 'egd-rail-search-clear',[\s\S]{0,400}setRailSearchQuery\(''\)[\s\S]{0,120}\}, '지우기'\)/);
  const clear = surfaceSource.slice(surfaceSource.indexOf("class: 'egd-rail-search-clear'"), surfaceSource.indexOf("}, '지우기')"));
  assert.doesNotMatch(clear, /scope/i, 'the scope is not touched');
  assert.match(surfaceCss, /\.egd-rail-search-input:placeholder-shown ~ \.egd-rail-search-clear \{ display: none; \}/);
  assert.match(declaration('setRailSearchQuery'), /!== state\.railSearch\.query\) state\.railSearch\.visibleLimit = RailSearchView\.RAIL_SEARCH_PAGE_ROWS/);
  assert.match(declaration('setRailSearchScope'), /state\.railSearch\.visibleLimit = RailSearchView\.RAIL_SEARCH_PAGE_ROWS/);
  assert.match(declaration('buildRailSearchResults'), /RailSearchView\.pageResults\(all, state\.railSearch\.visibleLimit\)/);
});
