import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accountPickerModel,
  MAX_SITE_DEFAULTS,
  normalizeSiteDefaults,
  planAccountSwitch,
  pruneSiteDefaults,
  resolveSiteDefault,
  setSiteDefault,
  siteKeyForUrl,
} from '../overlay/resources/EGDeskBrowserAccountContext.sys.mjs';

const SCOPE = '11111111-2222-4333-8444-555555555555';
const KEY_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const KEY_B = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const baseDomain = host => {
  if (/^[\d.]+$/.test(host) || !host.includes('.')) throw new Error('no base domain');
  const parts = host.split('.');
  return parts.slice(host.endsWith('.co.kr') ? -3 : -2).join('.');
};

test('site key is the registrable domain of an http(s) URL only', () => {
  assert.equal(siteKeyForUrl('https://mail.Google.com/a?b=1', baseDomain), 'google.com');
  assert.equal(siteKeyForUrl('https://shop.example.co.kr/', baseDomain), 'example.co.kr');
  assert.equal(siteKeyForUrl('http://192.168.0.1:8080/', baseDomain), '192.168.0.1');
  assert.equal(siteKeyForUrl('https://intranet/', baseDomain), 'intranet');
  assert.equal(siteKeyForUrl('https://a.example.com/'), 'a.example.com');
  for (const bad of ['about:blank', 'file:///etc/passwd', 'https://u:p@example.com/', 'javascript:alert(1)',
    ' https://example.com', '', null]) {
    assert.equal(siteKeyForUrl(bad, baseDomain), null, String(bad));
  }
  // A base domain that is not a suffix of the host is ignored.
  assert.equal(siteKeyForUrl('https://www.example.com/', () => 'evil.com'), 'www.example.com');
});

test('stored map keeps only valid always entries for this profile scope', () => {
  const raw = JSON.stringify({ version: 1, profileScopeId: SCOPE, sites: {
    'google.com': { mode: 'always', context: { kind: 'container', browserIdentityKey: KEY_A } },
    'naver.com': { mode: 'always', context: { kind: 'default' } },
    'ask.com': { mode: 'ask', context: { kind: 'default' } },
    'bad.com': { mode: 'always', context: { kind: 'container', browserIdentityKey: 'nope' } },
    'cookie.com': { mode: 'always', context: { kind: 'container', browserIdentityKey: KEY_A }, cookies: 'x=1' },
    'BAD KEY': { mode: 'always', context: { kind: 'default' } },
  } });
  const store = normalizeSiteDefaults(raw, { profileScopeId: SCOPE });
  assert.deepEqual(Object.keys(store.sites).sort(), ['cookie.com', 'google.com', 'naver.com']);
  // Extra fields (anything secret-looking) never survive normalization.
  assert.deepEqual(store.sites['cookie.com'], { mode: 'always', context: { kind: 'container', browserIdentityKey: KEY_A } });
  assert.deepEqual(normalizeSiteDefaults(raw, { profileScopeId: KEY_B }).sites, {});
  assert.deepEqual(normalizeSiteDefaults('{broken', { profileScopeId: SCOPE }).sites, {});
  assert.equal(normalizeSiteDefaults(raw, {}).profileScopeId, null);
});

test('setting a site default: always stores a context, ask removes it', () => {
  let store = normalizeSiteDefaults(null, { profileScopeId: SCOPE });
  store = setSiteDefault(store, 'google.com', { mode: 'always', context: { kind: 'container', browserIdentityKey: KEY_A } });
  assert.equal(store.sites['google.com'].context.browserIdentityKey, KEY_A);
  const roundTrip = normalizeSiteDefaults(JSON.stringify(store), { profileScopeId: SCOPE });
  assert.deepEqual(roundTrip, store);
  store = setSiteDefault(store, 'google.com', { mode: 'ask' });
  assert.deepEqual(store.sites, {});
  assert.throws(() => setSiteDefault(store, 'google.com', { mode: 'always', context: { kind: 'container' } }));
  assert.throws(() => setSiteDefault(store, 'x y', { mode: 'ask' }));
  assert.throws(() => setSiteDefault(store, 'x.com', { mode: 'sometimes' }));
  let full = store;
  for (let i = 0; i < MAX_SITE_DEFAULTS; i++) full = setSiteDefault(full, `s${i}.com`, { mode: 'always', context: { kind: 'default' } });
  assert.throws(() => setSiteDefault(full, 'more.com', { mode: 'always', context: { kind: 'default' } }), RangeError);
  assert.doesNotThrow(() => setSiteDefault(full, 's1.com', { mode: 'always', context: { kind: 'container', browserIdentityKey: KEY_B } }));
});

test('resolve: default is ask; a gone container is reported, not replaced', () => {
  let store = normalizeSiteDefaults(null, { profileScopeId: SCOPE });
  assert.deepEqual(resolveSiteDefault(store, 'https://mail.google.com/', { baseDomain }), { mode: 'ask', site: 'google.com' });
  store = setSiteDefault(store, 'google.com', { mode: 'always', context: { kind: 'container', browserIdentityKey: KEY_A } });
  store = setSiteDefault(store, 'naver.com', { mode: 'always', context: { kind: 'default' } });
  assert.deepEqual(resolveSiteDefault(store, 'https://docs.google.com/x', { baseDomain, usableKeys: new Set([KEY_A]) }),
    { mode: 'always', site: 'google.com', context: { kind: 'container', browserIdentityKey: KEY_A } });
  assert.deepEqual(resolveSiteDefault(store, 'https://docs.google.com/x', { baseDomain, usableKeys: new Set([KEY_B]) }),
    { mode: 'ask', site: 'google.com', reason: 'context-unavailable' });
  assert.equal(resolveSiteDefault(store, 'https://m.naver.com/', { baseDomain }).context.kind, 'default');
  assert.equal(resolveSiteDefault(store, 'about:blank', { baseDomain }).mode, 'ask');
  assert.deepEqual(Object.keys(pruneSiteDefaults(store, new Set()).sites), ['naver.com']);
});

test('picker shows the current context, all switch targets and the remembered site row', () => {
  let store = normalizeSiteDefaults(null, { profileScopeId: SCOPE });
  const contexts = [
    { kind: 'container', userContextId: 7, browserIdentityKey: KEY_A, name: 'Chrome · 업무' },
    { kind: 'container', userContextId: 9, name: '개인\u0000' },
    { kind: 'container', userContextId: 7, name: 'dup' },
    { kind: 'container', userContextId: -1, name: 'bad' },
  ];
  let model = accountPickerModel({ currentUserContextId: 7, contexts, url: 'https://mail.google.com/', baseDomain, store });
  assert.equal(model.summary, '계정: Chrome · 업무');
  assert.deepEqual(model.items.map(item => [item.label, item.checked]),
    [['기본 환경', false], ['Chrome · 업무', true], ['개인', false]]);
  assert.equal(model.siteDefault, 'ask');
  assert.equal(model.remember.checked, false);
  assert.match(model.remember.label, /google\.com.*Chrome · 업무/);
  assert.match(model.note, /로그인 여부는 별도로 확인/);
  store = setSiteDefault(store, 'google.com', { mode: 'always', context: { kind: 'container', browserIdentityKey: KEY_A } });
  model = accountPickerModel({ currentUserContextId: 7, contexts, url: 'https://mail.google.com/', baseDomain, store });
  assert.equal(model.remember.checked, true);
  assert.equal(model.rememberedLabel, 'Chrome · 업무');
  assert.equal(model.items.find(item => item.remembered).userContextId, 7);
  // A context without a profile-local key cannot be remembered yet.
  model = accountPickerModel({ currentUserContextId: 9, contexts, url: 'https://mail.google.com/', baseDomain, store });
  assert.equal(model.remember, null);
  assert.equal(model.remember?.checked, undefined);
  model = accountPickerModel({ currentUserContextId: 0, contexts, url: 'about:blank', store });
  assert.equal(model.remember, null);
  assert.equal(accountPickerModel({ currentUserContextId: 42, contexts }).currentLabel, '확인할 수 없는 환경');
});

test('switch plan: same context is a no-op, entered or unknown forms ask first', () => {
  const url = 'https://example.com/form';
  assert.deepEqual(planAccountSwitch({ currentUserContextId: 0, targetUserContextId: 0, url, formState: 'entered' }), { action: 'unchanged' });
  assert.deepEqual(planAccountSwitch({ currentUserContextId: 0, targetUserContextId: 7, url, formState: 'clean' }), { action: 'reopen' });
  const entered = planAccountSwitch({ currentUserContextId: 0, targetUserContextId: 7, url, formState: 'entered' });
  assert.equal(entered.action, 'confirm');
  assert.equal(entered.reason, 'entered-form');
  assert.match(entered.message, /저장하지 않은 입력/);
  assert.equal(planAccountSwitch({ currentUserContextId: 0, targetUserContextId: 7, url, formState: 'unknown' }).reason, 'form-unknown');
  assert.equal(planAccountSwitch({ currentUserContextId: 0, targetUserContextId: 7, url: 'about:blank', formState: 'clean' }).action, 'blocked');
  assert.equal(planAccountSwitch({ currentUserContextId: 0, targetUserContextId: -3, url, formState: 'clean' }).reason, 'invalid-context');
});
