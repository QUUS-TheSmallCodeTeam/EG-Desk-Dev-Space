import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';
import { compileFunction, runInNewContext } from 'node:vm';
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs';
import * as Surface from '../overlay/resources/EGDeskSurfaceState.sys.mjs';
import * as AccountSettingsView from '../overlay/resources/EGDeskAccountSettingsView.sys.mjs';
import * as ProfileTransfer from '../overlay/resources/EGDeskProfileTransfer.sys.mjs';
import * as ProfileTransferView from '../overlay/resources/EGDeskProfileTransferView.sys.mjs';
import {
  PROFILE_FORM_LIMITS, profileFormFromBody, validateProfileForm, profileDiffRows,
} from '../overlay/resources/EGDeskChatState.sys.mjs';
import {
  PERSONALITY_LIMITS, normalizeProfileBody, openProfileStore, profileHash, diffProfileBodies,
} from '../helper/egdesk-profile-store.mjs';
import { handleProfileHttp } from '../helper/egdesk-profile-http.mjs';
import { createPrivateQaTempDirectory } from './egdesk-qa-platform.mjs';
import { readSurfaceSource } from './egdesk-surface-source.mjs';

const fields = [['personalityExamples', 'examples'], ['personalityAvoid', 'avoid']];
const voice = {
  examples: [{ user: '검토해 주세요', reply: '근거부터 확인하겠습니다.\n불확실한 내용은 구분하겠습니다.' }],
  avoid: ['확인 없이 단정하기', '원본 덮어쓰기'],
};
const savedBody = (personality = voice, extra = {}) => normalizeProfileBody({
  name: '보존 검증', avatar: { kind: 'initial', value: 'V', color: '#252a26' }, role: '기존 역할',
  personality: { tone: 'concise', traits: ['정확함'], speechNotes: '짧게', ...personality },
  expertise: ['검토'], instructions: '원본을 보존하세요.', toolPreferences: ['browser'],
  model: { engine: 'codex', modelId: 'gpt-5.5', effort: 'high' }, ...extra,
});
function checked(form) {
  const result = validateProfileForm(form);
  assert.deepEqual(Object.keys(result), ['ok', 'errors', 'body']);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
  return result.body;
}
function rejected(field, value, row) {
  const form = { ...profileFormFromBody(savedBody()), [field]: value };
  const result = validateProfileForm(form);
  assert.deepEqual(Object.keys(result), ['ok', 'errors', 'body']);
  assert.equal(result.ok, false); assert.equal(result.body, null);
  assert.equal(result.errors.length, 1);
  const error = result.errors[0];
  assert.deepEqual(Object.keys(error), ['field', 'message']);
  assert.equal(error.field, field); assert.match(error.message, /[가-힣]/);
  if (row !== undefined) assert.match(error.message, new RegExp(`${row}행`));
  return result;
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const part of Object.values(value)) freeze(part); Object.freeze(value); }
  return value;
}

// Reuse the existing Settings fake DOM and real production handlers without
// changing that shared test file or launching a browser or provider.
function imageSettingsHarness() {
  const testSource = readFileSync(new URL('./egdesk-surface-state.test.mjs', import.meta.url), 'utf8');
  const between = (start, end) => {
    const first = testSource.indexOf(start), last = testSource.indexOf(end, first + start.length);
    assert.ok(first >= 0 && last > first, `Settings fixture section missing: ${start}`);
    return testSource.slice(first, last);
  };
  const surfaceSource = readSurfaceSource();
  const declaration = name => {
    const first = surfaceSource.indexOf(`  function ${name}(`), last = surfaceSource.indexOf('\n  }\n', first);
    assert.ok(first >= 0 && last > first, `Settings handler missing: ${name}`);
    return surfaceSource.slice(first, last + 4);
  };
  const nativeTextGlueHarness = () => ({ files: new Map(), pickers: [],
    adapter: { readText: async () => ({ cancelled: true }), saveText: async () => ({ cancelled: true }) } });
  return compileFunction([
    // This section also carries the shared fixture's bridge-notice helper, which
    // the Settings account tab reads through the real Surface and account view modules.
    between('function settingsFakeDocument()', "test('production Settings card"),
    between('function profileTransferBridgeMethods(', 'function portableSettingsHarness('),
    between('function portableSettingsHarness(', 'async function duplicateSettingsHarness('),
    'return { portableSettingsHarness, settingsButton, settingsNodes, settle };',
  ].join('\n'), ['surfaceSource', 'declaration', 'assert', 'compileFunction', 'Chat', 'ProfileTransfer', 'ProfileTransferView',
    'nativeTextGlueHarness', 'normalizeProfileBody', 'profileHash', 'Surface', 'AccountSettingsView'])(
    surfaceSource, declaration, assert, compileFunction, ChatState, ProfileTransfer, ProfileTransferView,
    nativeTextGlueHarness, normalizeProfileBody, profileHash, Surface, AccountSettingsView);
}

test('form limits expose the exact backend personality limits without changing the established limits', () => {
  assert.deepEqual(Object.fromEntries(Object.keys(PERSONALITY_LIMITS).map(key => [key, PROFILE_FORM_LIMITS[key]])),
    { examples: 3, exampleUser: 100, exampleReply: 280, avoid: 8, avoidItem: 80 });
  const { examples, exampleUser, exampleReply, avoid, avoidItem, ...established } = PROFILE_FORM_LIMITS;
  assert.deepEqual(established, { name: 40, role: 80, traits: 6, traitLength: 40, speechNotes: 500,
    expertise: 8, expertiseLength: 80, instructions: 8000, toolPreferences: 20, toolLength: 64 });
});

test('unchanged and role-only forms preserve every other canonical field and the expected hash', () => {
  for (const personality of [{}, { examples: voice.examples }, { avoid: voice.avoid }, voice]) {
    for (const toolCeiling of [null, { browser: 'observe', files: 'read', terminal: 'none', network: 'off', mcp: 'none' }]) {
      const saved = freeze(savedBody(personality, { toolCeiling })), original = structuredClone(saved), oldHash = profileHash(saved);
      const form = profileFormFromBody(saved), result = checked(form);
      assert.deepEqual(normalizeProfileBody(result), original);
      assert.equal(profileHash(result), oldHash);
      for (const [field, key] of fields) {
        assert.equal(Object.hasOwn(form, field), Object.hasOwn(saved.personality, key));
        assert.equal(Object.hasOwn(result.personality, key), Object.hasOwn(saved.personality, key));
      }
      form.role = '새 역할';
      const edited = checked(form), expected = { ...original, role: '새 역할' };
      assert.deepEqual(normalizeProfileBody(edited), expected);
      assert.equal(profileHash(edited), profileHash(expected));
      assert.notEqual(profileHash(edited), oldHash, 'only the requested role changes the canonical hash');
      assert.deepEqual(saved, original); assert.equal(profileHash(saved), oldHash);
    }
  }
});

test('an existing image reference survives an unchanged form and unrelated personality or model edits', () => {
  const avatar = { kind: 'image', value: '보', color: '#252a26', assetId: `img-${'a'.repeat(64)}` };
  const saved = freeze(savedBody(voice, { avatar })), original = structuredClone(saved);
  const edits = [
    () => {},
    form => { form.role = '새 역할'; },
    form => { form.tone = 'warm'; form.traits = ['신중함']; },
    form => { form.model = { ...form.model, effort: 'low' }; },
  ];
  for (const edit of edits) {
    const form = profileFormFromBody(saved);
    edit(form);
    const result = checked(form), normalized = normalizeProfileBody(result);
    assert.deepEqual(result.avatar, avatar);
    assert.deepEqual(normalized.avatar, avatar);
    const expected = structuredClone(original);
    if (form.role !== original.role) expected.role = form.role;
    if (form.tone !== original.personality.tone) expected.personality.tone = form.tone;
    if (JSON.stringify(form.traits) !== JSON.stringify(original.personality.traits)) expected.personality.traits = form.traits;
    expected.model = form.model;
    assert.deepEqual(normalized, expected);
    assert.equal(profileHash(result), profileHash(expected));
    assert.deepEqual(saved, original);
  }
});

test('an explicit change from an image to an initial or emoji replaces the image reference', () => {
  const avatar = { kind: 'image', value: '보', color: '#252a26', assetId: `img-${'b'.repeat(64)}` };
  const saved = freeze(savedBody(voice, { avatar }));
  for (const change of [
    { kind: 'initial', value: '보', color: '#252a26' },
    { kind: 'initial', value: '새', color: '#49634f' },
    { kind: 'emoji', value: '🧭', color: '#a9c5a9' },
  ]) {
    const form = profileFormFromBody(saved);
    form.avatarKind = change.kind; form.avatarValue = change.value; form.avatarColor = change.color;
    const result = checked(form);
    assert.deepEqual(result.avatar, change);
    assert.deepEqual(normalizeProfileBody(result).avatar, change);
    assert.equal(Object.hasOwn(result.avatar, 'assetId'), false);
  }
  assert.deepEqual(saved.avatar, avatar);
});

test('editing the image fallback initial or color preserves the photo reference', () => {
  const avatar = { kind: 'image', value: '보', color: '#252a26', assetId: `img-${'d'.repeat(64)}` };
  const saved = freeze(savedBody(voice, { avatar }));
  for (const [field, value, expected] of [
    ['avatarValue', '새', { ...avatar, value: '새' }],
    ['avatarColor', '#49634f', { ...avatar, color: '#49634f' }],
    ['avatarValue', '', avatar],
  ]) {
    const form = profileFormFromBody(saved);
    form[field] = value;
    const result = checked(form);
    assert.deepEqual(result.avatar, expected);
    assert.deepEqual(normalizeProfileBody(result).avatar, expected);
  }
});

test('a cross-realm image reference stays independent of the source and emitted bodies', () => {
  const avatar = { kind: 'image', value: '보', color: '#252a26', assetId: `img-${'e'.repeat(64)}` };
  const saved = savedBody(voice, { avatar }), json = JSON.stringify(saved);
  const foreign = freeze(runInNewContext('JSON.parse(json)', { json }));
  const form = profileFormFromBody(foreign);
  form.tone = 'warm';
  const first = checked(form), second = checked(form);
  assert.deepEqual(first.avatar, avatar);
  assert.deepEqual(second.avatar, avatar);
  assert.notEqual(first.avatar, second.avatar);
  first.avatar.assetId = `img-${'f'.repeat(64)}`;
  assert.deepEqual(second.avatar, avatar);
  assert.equal(JSON.stringify(foreign), json);
});

test('Settings handlers and a private store preserve the photo across personality and fallback-color edits', async t => {
  const dataDir = createPrivateQaTempDirectory('egdesk-avatar-form-');
  const store = openProfileStore({ dataDir, ownerHash: 'synthetic-avatar-form-test' });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  // Synthetic 1x1 PNG, accepted by the existing image validator in this test store only.
  const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQiKoAAAGoAPuznd66AAAAAElFTkSuQmCC';
  const asset = store.putAvatarImage({ mediaType: 'image/png', imageBase64 });
  const avatar = { kind: 'image', value: '보', color: '#252a26', assetId: asset.assetId };
  const created = store.createDraft(savedBody(voice, { avatar }));
  store.activate(created.id, created.revision, null);
  const originalBytes = store.getAvatarImage(asset.assetId).bytes;
  const { portableSettingsHarness, settingsButton, settingsNodes, settle } = imageSettingsHarness();
  const h = portableSettingsHarness({ initialDetail: store.get(created.id), respond: async (path, options = {}) => {
    const req = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]);
    Object.assign(req, { method: options.method || 'GET', url: path, socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:39218', ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) } });
    let response;
    assert.equal(await handleProfileHttp(req, new URL(path, 'http://127.0.0.1:39218'), { store,
      send: (status, body) => { response = { status, body }; } }), true);
    if (response.status >= 400) throw Object.assign(new Error('Profile request refused'), { status: response.status, ...response.body });
    return response.body;
  } });
  const field = name => h.document.getElementById(`${h.card.getAttribute('id')}-profile-${name}`);
  const edit = async () => { settingsButton(h.card, '편집').fire('click'); await settle(); };
  const save = async () => { h.part('settings-agent-save').fire('click'); await settle(); };
  await settle(); await edit();
  assert.equal(field('avatarKind-initial').getAttribute('aria-pressed'), 'false');
  assert.equal(field('avatarKind-emoji').getAttribute('aria-pressed'), 'false');
  h.emit();
  field('tone-warm').fire('click'); // Production click handler re-renders the edit form.
  assert.equal(field('avatarKind-initial').getAttribute('aria-pressed'), 'false');
  assert.equal(field('avatarKind-emoji').getAttribute('aria-pressed'), 'false');
  await save();
  let head = store.get(created.id).head;
  assert.equal(head.profileId, created.id);
  assert.equal(head.parentRevision, created.revision);
  assert.equal(head.body.personality.tone, 'warm');
  assert.deepEqual(head.body.avatar, avatar);
  assert.deepEqual(head.body.model, created.profile.head.body.model);
  assert.deepEqual(store.getAvatarImage(asset.assetId).bytes, originalBytes);

  await edit();
  const swatch = settingsNodes(h.card, node => node.getAttribute('aria-label') === '색 1')[0];
  assert.ok(swatch); swatch.fire('click'); await save();
  head = store.get(created.id).head;
  assert.deepEqual(head.body.avatar, { ...avatar, color: '#49634f' });
  assert.deepEqual(store.getAvatarImage(asset.assetId).bytes, originalBytes);

  const missing = profileFormFromBody(head.body);
  missing.avatarImage.assetId = `img-${'f'.repeat(64)}`; missing.role = 'missing synthetic asset';
  assert.throws(() => store.saveDraft(created.id, checked(missing), head.revision), { code: 'PROFILE_ASSET_NOT_FOUND' });
  assert.equal(store.get(created.id).headRevision, head.revision);
  assert.throws(() => store.putAvatarImage({ mediaType: 'image/png', imageBase64: 'AAAA' }), { code: 'INVALID_PROFILE_IMAGE' });

  await edit(); field('avatarKind-initial').fire('click'); await save();
  assert.deepEqual(store.get(created.id).head.body.avatar, { kind: 'initial', value: '보', color: '#49634f' });
  assert.deepEqual(store.getAvatarImage(asset.assetId).bytes, originalBytes);

  await edit(); field('avatarKind-emoji').fire('click');
  const avatarInput = field('avatar'); avatarInput.value = '🧭'; avatarInput.fire('input');
  await save();
  assert.deepEqual(store.get(created.id).head.body.avatar, { kind: 'emoji', value: '🧭', color: '#49634f' });
  assert.equal(store.list().profiles.length, 1, 'the same profile is edited, not replaced');
});

test('unsupported image references and extra avatar fields remain invalid instead of being silently repaired', () => {
  const avatar = { kind: 'image', value: '보', color: '#252a26', assetId: `img-${'c'.repeat(64)}` };
  const invalid = [
    { ...avatar, assetId: 'data:image/png;base64,AAAA' },
    { ...avatar, assetId: '../profile.png' },
    { ...avatar, assetId: `img-${'A'.repeat(64)}` },
    { ...avatar, assetId: `img-${'c'.repeat(63)}` },
    { ...avatar, assetId: null },
    { ...avatar, value: null },
    { ...avatar, value: 'not-an-initial' },
    { ...avatar, color: null },
    { ...avatar, color: '#123456' },
    { ...avatar, extra: undefined },
    Object.assign([], avatar),
    Object.assign(new Date(0), avatar),
    Object.assign(Object.create({ unsupported: true }), avatar),
  ];
  for (const bad of invalid) {
    const saved = { ...savedBody(), avatar: bad };
    assert.throws(() => normalizeProfileBody(saved), { code: 'INVALID_PROFILE' });
    const form = profileFormFromBody(saved);
    form.role = '다른 설정만 수정';
    const result = validateProfileForm(form);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.body, null);
    assert.ok(result.errors.some(error => error.field === 'avatar' || error.field === 'avatarColor'));
  }
  const noReference = { ...profileFormFromBody(savedBody()), avatarKind: 'image' };
  assert.equal(validateProfileForm(noReference).ok, false);
  const badEditorValue = profileFormFromBody(savedBody(voice, { avatar }));
  badEditorValue.avatarValue = 12;
  assert.equal(validateProfileForm(badEditorValue).ok, false);
});

test('cross-realm saved JSON opens and saves unchanged or role-only without losing the canonical hash or sharing example rows', () => {
  for (const personality of [{}, { examples: voice.examples }, { avoid: voice.avoid }, voice]) {
    const saved = savedBody(personality), json = JSON.stringify(saved);
    const foreign = runInNewContext('JSON.parse(json)', { json });
    assert.notEqual(Object.getPrototypeOf(foreign), Object.prototype, 'exercise an actual other realm');
    const form = profileFormFromBody(freeze(foreign)), result = checked(form);
    assert.deepEqual(normalizeProfileBody(result), saved);
    assert.equal(profileHash(result), profileHash(saved));
    assert.equal(JSON.stringify(foreign), json);
    for (const [field, key] of fields) assert.equal(Object.hasOwn(form, field), Object.hasOwn(saved.personality, key));
    if (saved.personality.examples) {
      assert.notEqual(form.personalityExamples, foreign.personality.examples);
      assert.notEqual(form.personalityExamples[0], foreign.personality.examples[0]);
      assert.notEqual(result.personality.examples[0], form.personalityExamples[0]);
      assert.equal(Object.getPrototypeOf(result.personality.examples[0]), Object.prototype, 'the emitted pair belongs to the local canonical body');
    }
    form.role = '새 역할';
    const edited = checked(form), expected = { ...saved, role: '새 역할' };
    assert.deepEqual(normalizeProfileBody(edited), expected); assert.equal(profileHash(edited), profileHash(expected));
    assert.equal(JSON.stringify(foreign), json);
  }
});

test('cross-realm editor pairs normalize and deduplicate while preserving Unicode boundaries and strict raw caps', () => {
  const values = runInNewContext(`({
    examples: [{ user: ' e\\u0301 ', reply: '첫 줄\\r\\n둘째 줄' },
      { user: 'é', reply: '다른 답변' }, { user: 'é', reply: '첫 줄\\n둘째 줄' }],
    avoid: [' e\\u0301 ', '두 번째', 'é'],
    limit: { user: '😀'.repeat(100), reply: '🧭'.repeat(139) + '\\n' + '😀'.repeat(140) },
    nullPrototype: Object.assign(Object.create(null), { user: 'q', reply: 'a' }),
  })`);
  assert.notEqual(Object.getPrototypeOf(values.examples[0]), Object.prototype);
  const original = JSON.stringify(values), base = profileFormFromBody(savedBody({}));
  const result = checked({ ...base, personalityExamples: values.examples, personalityAvoid: values.avoid });
  assert.deepEqual(result.personality.examples, [{ user: 'é', reply: '첫 줄\n둘째 줄' }, { user: 'é', reply: '다른 답변' }]);
  assert.deepEqual(result.personality.avoid, ['é', '두 번째']);
  const boundary = checked({ ...base, personalityExamples: [values.limit] });
  assert.equal([...boundary.personality.examples[0].user].length, 100);
  assert.equal([...boundary.personality.examples[0].reply].length, 280);
  assert.deepEqual(normalizeProfileBody(boundary).personality.examples, boundary.personality.examples);
  assert.deepEqual(checked({ ...base, personalityExamples: [values.nullPrototype] }).personality.examples, [{ user: 'q', reply: 'a' }]);
  rejected('personalityExamples', runInNewContext('Array.from({ length: 4 }, () => ({ user: "q", reply: "a" }))'), 4);
  rejected('personalityAvoid', runInNewContext('Array(9).fill("same")'), 9);
  rejected('personalityExamples', runInNewContext('[{ user: "😀".repeat(101), reply: "a" }]'), 1);
  rejected('personalityExamples', runInNewContext('[{ user: "q", reply: "😀".repeat(281) }]'), 1);
  assert.equal(JSON.stringify(values), original);
});

test('cross-realm diff JSON renders normal example pairs exactly like local JSON and continues skipping unknown paths', () => {
  const changes = diffProfileBodies(savedBody({}), savedBody(voice));
  changes.push({ field: 'personality.examples.user', before: 'unknown', after: 'ignored' });
  const json = JSON.stringify(changes), foreign = runInNewContext('JSON.parse(json)', { json });
  assert.notEqual(Object.getPrototypeOf(foreign[0].after[0]), Object.prototype);
  // flatMap can retain the input array's realm; compare the serializable view.
  const rows = profileDiffRows(freeze(foreign));
  assert.equal(JSON.stringify(rows), JSON.stringify(profileDiffRows(changes)));
  assert.match(rows[0].after, /1\. 질문: 검토해 주세요\n답변: 근거부터/);
  assert.doesNotMatch(rows[0].after, /확인 안 됨|\[object Object\]/);
  assert.equal(rows.length, 2); assert.equal(JSON.stringify(foreign), json);
});

test('cross-realm support does not admit classes, nonplain prototypes, extra keys or invalid member types', () => {
  const invalid = runInNewContext(`(() => {
    class Pair { constructor() { this.user = 'q'; this.reply = 'a'; } }
    class RootPair extends null { constructor() { return Object.assign(Object.create(new.target.prototype), { user: 'q', reply: 'a' }); } }
    const fakeRoot = Object.create(null);
    Object.defineProperty(fakeRoot, 'constructor', { value: Object });
    const accessorRoot = Object.create(null);
    Object.defineProperty(accessorRoot, 'constructor', { get() { throw new Error('must not call a prototype constructor getter'); } });
    return [new Pair(), new RootPair(), Object.assign(new Date(0), { user: 'q', reply: 'a' }),
      Object.assign(new Map(), { user: 'q', reply: 'a' }), Object.assign(new String('q'), { user: 'q', reply: 'a' }),
      Object.assign(Object.create({}), { user: 'q', reply: 'a' }), Object.create({ user: 'q', reply: 'a' }),
      Object.assign(Object.create(fakeRoot), { user: 'q', reply: 'a' }),
      Object.assign(Object.create(accessorRoot), { user: 'q', reply: 'a' }),
      { user: 'q', reply: 'a', extra: undefined }, { user: 42, reply: 'a' }, { user: 'q', reply: {} }];
  })()`);
  for (const pair of invalid) {
    rejected('personalityExamples', [pair], 1);
    const saved = savedBody(); saved.personality.examples = [pair];
    const copied = profileFormFromBody(saved);
    assert.equal(validateProfileForm(copied).body, null, 'copying the prototype is not a validation bypass');
    const row = profileDiffRows([{ field: 'personality.examples', before: [], after: [pair] }])[0];
    assert.match(row.after, /확인 안 됨/); assert.doesNotMatch(row.after, /\[object Object\]/);
  }
});

test('source, form and every emitted body own independent arrays and nested example pairs', () => {
  const saved = freeze(savedBody()), original = structuredClone(saved), form = profileFormFromBody(saved);
  assert.notEqual(form.personalityExamples, saved.personality.examples);
  assert.notEqual(form.personalityExamples[0], saved.personality.examples[0]);
  assert.notEqual(form.personalityAvoid, saved.personality.avoid);
  form.personalityExamples[0].reply = '폼만 수정'; form.personalityAvoid.push('폼에서 추가');
  assert.deepEqual(saved, original);
  const before = structuredClone(form), first = checked(freeze(form)), second = checked(form);
  assert.notEqual(first.personality.examples, form.personalityExamples);
  assert.notEqual(first.personality.examples[0], form.personalityExamples[0]);
  assert.notEqual(first.personality.avoid, form.personalityAvoid);
  first.personality.examples[0].reply = '출력만 수정'; first.personality.avoid.push('출력에서 추가');
  assert.deepEqual(form, before); assert.deepEqual(second, checked(form)); assert.deepEqual(saved, original);
});

test('absent, null, undefined and empty lists have backend empty semantics; only the two established keys carry through', () => {
  for (const value of [null, undefined, []]) for (const [field, key] of fields) {
    const saved = savedBody(), source = { ...saved, personality: { ...saved.personality, [key]: value } };
    const form = profileFormFromBody(source);
    assert.ok(Object.hasOwn(form, field)); assert.deepEqual(form[field], value);
    const result = checked(form);
    assert.equal(Object.hasOwn(result.personality, key), false);
    assert.deepEqual(normalizeProfileBody(result), normalizeProfileBody(source));
    assert.equal(profileHash(result), profileHash(source));
  }
  const old = savedBody({}), form = profileFormFromBody(old);
  for (const [field, key] of fields) {
    assert.equal(Object.hasOwn(form, field), false);
    assert.equal(Object.hasOwn(checked(form).personality, key), false);
    assert.equal(Object.hasOwn(profileFormFromBody(null), field), false);
  }
  const empty = validateProfileForm(profileFormFromBody(null));
  assert.deepEqual(empty, { ok: false, errors: [{ field: 'name', message: '담당자 이름을 입력해 주세요.' }], body: null });
  const extra = savedBody(); extra.personality.unknown = { nested: true };
  const extraForm = profileFormFromBody(extra);
  extraForm.personality = { examples: [{ user: 'untrusted alias', reply: 'ignored' }] }; extraForm.unknown = true;
  const result = checked(extraForm);
  assert.deepEqual(result.personality, savedBody().personality);
  assert.equal(Object.hasOwn(result, 'unknown'), false);
});

test('all positive boundaries and one-character minima round-trip without clipping UTF-16 surrogate pairs', () => {
  const L = PERSONALITY_LIMITS;
  const personality = {
    examples: Array.from({ length: L.examples }, (_, i) => ({
      user: `${i}${'😀'.repeat(L.exampleUser - 1)}`,
      reply: `${i}${'🧭'.repeat(138)}\n${'😀'.repeat(140)}`,
    })),
    avoid: Array.from({ length: L.avoid }, (_, i) => `${i}${'😀'.repeat(L.avoidItem - 1)}`),
  };
  assert.equal([...personality.examples[0].user].length, L.exampleUser);
  assert.equal([...personality.examples[0].reply].length, L.exampleReply);
  assert.ok(personality.examples[0].reply.length > L.exampleReply);
  const source = savedBody(personality), form = profileFormFromBody(source), result = checked(form);
  assert.deepEqual(result.personality, source.personality);
  assert.deepEqual(normalizeProfileBody(result), source);
  assert.equal(profileHash(result), profileHash(source));
  const minimum = savedBody({ examples: [{ user: '가', reply: '😀' }], avoid: ['나'] });
  assert.deepEqual(normalizeProfileBody(checked(profileFormFromBody(minimum))), minimum);
});

test('every limit plus one is rejected; raw duplicate counts are checked before deduplication', () => {
  const L = PERSONALITY_LIMITS, pair = { user: 'q', reply: 'a' };
  const cases = [
    ['personalityExamples', Array.from({ length: L.examples + 1 }, () => ({ ...pair })), L.examples + 1],
    ['personalityExamples', [{ user: '😀'.repeat(L.exampleUser + 1), reply: 'a' }], 1],
    ['personalityExamples', [{ user: 'q', reply: '😀'.repeat(L.exampleReply + 1) }], 1],
    ['personalityAvoid', Array.from({ length: L.avoid + 1 }, () => 'same'), L.avoid + 1],
    ['personalityAvoid', ['😀'.repeat(L.avoidItem + 1)], 1],
  ];
  for (const [field, value, row] of cases) {
    const copy = structuredClone(value); rejected(field, value, row); assert.deepEqual(value, copy);
    const key = fields.find(([candidate]) => candidate === field)[1];
    assert.throws(() => savedBody({ [key]: value }), { code: 'INVALID_PROFILE' });
    const raw = savedBody(); raw.personality[key] = value;
    const form = profileFormFromBody(raw);
    assert.deepEqual(form[field], value, 'opening the form does not slice or deduplicate the evidence');
    assert.equal(validateProfileForm(form).body, null);
  }
});

test('NFC, trim and CRLF normalization precede code-point limits and dedup keeps first-seen pair order', () => {
  const form = profileFormFromBody(savedBody({}));
  form.personalityExamples = [
    { user: ' e\u0301 ', reply: ' 첫 줄\r\n둘째 줄\r셋째 줄 ' },
    { user: 'é', reply: '다른 답변' },
    { user: 'é', reply: '첫 줄\n둘째 줄\n셋째 줄' },
  ];
  form.personalityAvoid = [' e\u0301 ', '두 번째', 'é', '두 번째'];
  const original = structuredClone(form), result = checked(freeze(form));
  assert.deepEqual(result.personality.examples, [{ user: 'é', reply: '첫 줄\n둘째 줄\n셋째 줄' }, { user: 'é', reply: '다른 답변' }]);
  assert.deepEqual(result.personality.avoid, ['é', '두 번째']);
  assert.deepEqual(result.personality, savedBody({ examples: original.personalityExamples, avoid: original.personalityAvoid }).personality);
  assert.deepEqual(form, original);
  const atLimit = { ...profileFormFromBody(savedBody()),
    personalityExamples: [{ user: ` ${'e\u0301'.repeat(100)} `, reply: ` ${'e\u0301'.repeat(280)} ` }],
    personalityAvoid: [` ${'e\u0301'.repeat(80)} `] };
  const normalized = checked(atLimit).personality;
  assert.deepEqual(normalized.examples, [{ user: 'é'.repeat(100), reply: 'é'.repeat(280) }]);
  assert.deepEqual(normalized.avoid, ['é'.repeat(80)]);
});

test('collection types, malformed pairs and extra object keys are errors, not filtered or repaired rows', () => {
  for (const value of ['', 'one', 0, 1, false, true, {}, { length: 1 }, new Set(), new Map()]) {
    for (const [field, key] of fields) {
      rejected(field, value);
      assert.throws(() => savedBody({ [key]: value }), { code: 'INVALID_PROFILE' });
    }
  }
  const invalidPairs = [null, undefined, 0, false, 'q → a', [], {}, { user: 'q' }, { reply: 'a' },
    { user: 'q', reply: 'a', extra: undefined }, { user: 'q', reply: 'a', extra: 'x' },
    new Date(0), new String('q'), Object.create({ user: 'q', reply: 'a' }),
    JSON.parse('{"user":"q","reply":"a","__proto__":{"x":true}}')];
  for (const pair of invalidPairs) {
    rejected('personalityExamples', [{ user: 'first', reply: 'valid' }, pair], 2);
    assert.throws(() => savedBody({ examples: [pair] }), { code: 'INVALID_PROFILE' });
  }
  const validNullPrototype = Object.assign(Object.create(null), { user: 'q', reply: 'a' });
  const source = savedBody(); source.personality.examples = [validNullPrototype];
  assert.deepEqual(checked(profileFormFromBody(source)).personality.examples, [{ user: 'q', reply: 'a' }]);
});

test('missing, non-text and empty pair members or avoid rows produce Korean row errors with a null body', () => {
  for (const value of [undefined, null, '', ' \r\n ', 1, false, {}, [], new String('text')]) {
    for (const member of ['user', 'reply']) {
      const pair = { user: 'q', reply: 'a', [member]: value };
      rejected('personalityExamples', [{ user: 'valid', reply: 'first' }, pair], 2);
      assert.throws(() => savedBody({ examples: [pair] }), { code: 'INVALID_PROFILE' });
    }
    rejected('personalityAvoid', ['first', 'second', value], 3);
    assert.throws(() => savedBody({ avoid: [value] }), { code: 'INVALID_PROFILE' });
  }
  rejected('personalityExamples', [{ user: '', reply: '' }], 1);
  const result = validateProfileForm({ ...profileFormFromBody(savedBody()),
    personalityExamples: [{ user: '', reply: 'a' }], personalityAvoid: ['valid', ''] });
  assert.equal(result.ok, false); assert.equal(result.body, null);
  assert.deepEqual(result.errors.map(row => row.field), ['personalityExamples', 'personalityAvoid']);
  assert.match(result.errors[0].message, /1행/); assert.match(result.errors[1].message, /2행/);
});

test('single-line and multiline control rules match the backend without losing valid tabs or line separators in replies', () => {
  for (const separator of ['\n', '\r', '\t', '\u0000', '\u001f', '\u007f', '\u2028', '\u2029']) {
    const text = `a${separator}b`;
    rejected('personalityExamples', [{ user: text, reply: 'a' }], 1);
    rejected('personalityAvoid', [text], 1);
    assert.throws(() => savedBody({ examples: [{ user: text, reply: 'a' }] }), { code: 'INVALID_PROFILE' });
    assert.throws(() => savedBody({ avoid: [text] }), { code: 'INVALID_PROFILE' });
  }
  for (const separator of ['\u0000', '\u0008', '\u000b', '\u000c', '\u000e', '\u001f', '\u007f']) {
    const pair = { user: 'q', reply: `a${separator}b` };
    rejected('personalityExamples', [pair], 1);
    assert.throws(() => savedBody({ examples: [pair] }), { code: 'INVALID_PROFILE' });
  }
  const examples = [{ user: '\n q \n', reply: ' a\tb\r\nc\rd\u2028e\u2029f ' }];
  const form = { ...profileFormFromBody(savedBody()), personalityExamples: examples, personalityAvoid: ['\n safe \n'] };
  assert.deepEqual(checked(form).personality, savedBody({ examples, avoid: ['safe'] }).personality);
});

test('opening an invalid saved value preserves undefined extra keys, holes and nested arrays until validation', () => {
  const saved = savedBody(), extra = { user: 'q', reply: 'a', extra: undefined };
  saved.personality.examples = [extra];
  const form = profileFormFromBody(saved);
  assert.ok(Object.hasOwn(form.personalityExamples[0], 'extra'));
  assert.notEqual(form.personalityExamples[0], extra);
  assert.equal(validateProfileForm(form).ok, false);
  const holes = new Array(2); holes[0] = { user: 'q', reply: 'a' };
  saved.personality.examples = holes;
  const sparse = profileFormFromBody(saved);
  assert.equal(sparse.personalityExamples.length, 2); assert.equal(Object.hasOwn(sparse.personalityExamples, 1), false);
  assert.equal(validateProfileForm(sparse).body, null);
  rejected('personalityExamples', holes, 2);
  rejected('personalityAvoid', new Array(1), 1);
  const nested = [[{ user: 'q', reply: 'a' }]];
  saved.personality.examples = nested;
  const nestedForm = profileFormFromBody(saved);
  assert.notEqual(nestedForm.personalityExamples[0], nested[0]);
  assert.notEqual(nestedForm.personalityExamples[0][0], nested[0][0]);
  assert.equal(validateProfileForm(nestedForm).ok, false);
});

test('explicit removal omits both optional keys and does not alter other canonical fields', () => {
  const saved = freeze(savedBody()), form = profileFormFromBody(saved);
  form.personalityExamples = []; form.personalityAvoid = [];
  const result = checked(form), { examples, avoid, ...personality } = saved.personality;
  const expected = { ...saved, personality };
  assert.deepEqual(normalizeProfileBody(result), expected);
  assert.equal(profileHash(result), profileHash(expected));
  assert.deepEqual(saved.personality.examples, voice.examples);
});

test('diff exposes the two exact paths as readable pairs and phrases while retaining existing and unknown-field behavior', () => {
  const before = savedBody({}), after = savedBody(voice), changes = diffProfileBodies(before, after);
  const original = structuredClone(changes), rows = profileDiffRows(freeze(changes));
  assert.deepEqual(rows, [
    { field: 'personality.examples', label: '말투 예시', before: '없음',
      after: '1. 질문: 검토해 주세요\n답변: 근거부터 확인하겠습니다.\n불확실한 내용은 구분하겠습니다.' },
    { field: 'personality.avoid', label: '피할 표현', before: '없음', after: '확인 없이 단정하기, 원본 덮어쓰기' },
  ]);
  assert.deepEqual(changes, original); assert.doesNotMatch(JSON.stringify(rows), /\[object Object\]/);
  const paired = profileDiffRows([{ field: 'personality.examples', before: voice.examples,
    after: [{ user: 'first', reply: 'line one\nline two' }, { user: 'second', reply: 'answer' }] }])[0];
  assert.equal(paired.after, '1. 질문: first\n답변: line one\nline two\n\n2. 질문: second\n답변: answer');
  assert.deepEqual(profileDiffRows([
    { field: 'name', before: '검증', after: '검증 담당' }, { field: 'personality.tone', before: 'plain', after: 'warm' },
    { field: 'expertise', before: [], after: ['리뷰'] }, { field: 'constructor', before: 1, after: 2 },
    { field: 'personality.examples.user', before: 'x', after: 'y' }, null,
  ]).map(row => [row.label, row.before, row.after]), [
    ['담당자 이름', '검증', '검증 담당'], ['말투', '담백', '따뜻'], ['맡길 일', '없음', '리뷰'],
  ]);
  assert.deepEqual(profileDiffRows(null), []);
});

test('malformed diff values never render object coercions and empty values still read as absent', () => {
  for (const field of ['personality.examples', 'personality.avoid']) {
    for (const value of [null, undefined, []]) {
      assert.deepEqual(profileDiffRows([{ field, before: value, after: value }]).map(row => [row.before, row.after]), [['없음', '없음']]);
    }
    for (const value of [{}, 'unexpected', [null, {}, 1], new Array(1)]) {
      const row = profileDiffRows([{ field, before: value, after: value }])[0];
      assert.match(row.after, /확인 안 됨/); assert.doesNotMatch(row.after, /\[object Object\]/);
    }
  }
});
