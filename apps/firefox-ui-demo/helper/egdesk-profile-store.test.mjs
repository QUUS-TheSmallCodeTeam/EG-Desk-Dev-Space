import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import {
  AVATAR_PALETTE, MAX_COMPOSED, MAX_SOURCE_ENTRIES, PERSONALITY_LIMITS, PROFILE_TEMPLATES, PROFILE_TONES, composeDeveloperInstructions,
  copyName, diffProfileBodies, normalizeProfileBody, openProfileStore, profileBinding, profileHash,
} from './egdesk-profile-store.mjs'

function fixture(t) {
  const dataDir = createPrivateQaTempDirectory('egdesk-profile-store-test-')
  const handles = []
  t.after(() => {
    for (const handle of handles) handle.close()
    assert.equal(realpathSync.native(dataDir), dataDir)
    assert.match(path.basename(dataDir), /^egdesk-profile-store-test-/)
    rmSync(dataDir, { recursive: true, force: true })
  })
  const open = (ownerHash = 'local-desktop-v1') => { const store = openProfileStore({ dataDir, ownerHash }); handles.push(store); return store }
  return { dataDir, open, handles }
}
const rio = (extra = {}) => ({
  name: '리오', avatar: { kind: 'emoji', value: '🦊', color: AVATAR_PALETTE[1] }, role: '회의 준비 담당',
  personality: { tone: 'warm', traits: ['꼼꼼함', '차분함'], speechNotes: '결론부터 말한다.' },
  expertise: ['회의 자료 정리', '일정 확인'], instructions: '대표님께는 존댓말을 쓴다.',
  toolPreferences: ['browser.read', 'files.search'], model: { engine: 'codex', modelId: 'gpt-5.5', effort: 'medium' },
  ...extra,
})
const rejects = (action, code = 'INVALID_PROFILE') => assert.throws(action, error => error.code === code)
const voice = {
  examples: [{ user: '내일 회의 뭐 있어?', reply: '내일은 회의가 두 개 있어요.\n10시 기획 회의, 3시 고객 미팅입니다.' }],
  avoid: ['확인하지 않은 일정을 확정처럼 말하기', '회의 내용을 외부에 옮기기'],
}
const sha = value => createHash('sha256').update(value).digest('hex')
// Version 1 schema exactly as shipped before source_json (helper/egdesk-profile-store.mjs at 9dbfa51).
const V1_SCHEMA = `
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, active_revision INTEGER,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft','active','disabled','archived','deleted')),
      origin TEXT NOT NULL CHECK (origin IN ('user','template')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      FOREIGN KEY(id, active_revision) REFERENCES profile_revisions(profile_id, revision)
    );
    CREATE TABLE profile_revisions (
      profile_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
      parent_revision INTEGER, hash TEXT NOT NULL,
      author TEXT NOT NULL CHECK (author IN ('user','template')),
      body_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(profile_id, revision),
      FOREIGN KEY(profile_id) REFERENCES profiles(id)
    );
    CREATE TRIGGER profile_revisions_immutable BEFORE UPDATE ON profile_revisions
      BEGIN SELECT RAISE(ABORT, 'profile revisions are immutable'); END;
    CREATE TRIGGER profile_revisions_kept BEFORE DELETE ON profile_revisions
      BEGIN SELECT RAISE(ABORT, 'profile revisions are kept'); END;
    CREATE TABLE store_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);`
/** A private profile file as an older EG-Desk left it: rows written straight into the given schema. */
function writeOldStore(dataDir, ownerHash, { version = 1, schema = V1_SCHEMA, rows = true } = {}) {
  const owner = sha(ownerHash)
  const filename = path.join(dataDir, `profiles-${owner}.sqlite`)
  const db = new DatabaseSync(filename)
  db.exec(`PRAGMA journal_mode=DELETE; BEGIN; ${schema} PRAGMA user_version=${version}; COMMIT;`)
  const json = JSON.stringify(normalizeProfileBody(rio())), template = JSON.stringify(normalizeProfileBody(PROFILE_TEMPLATES[0].body))
  if (rows) {
    db.prepare('INSERT INTO profiles VALUES (?, ?, ?, ?, ?, ?, ?)').run('prof-old-1', owner, null, 'draft', 'user', 10, 10)
    db.prepare('INSERT INTO profile_revisions VALUES (?, ?, ?, ?, ?, ?, ?)').run('prof-old-1', 1, null, sha(json), 'user', json, 10)
    db.prepare('UPDATE profiles SET lifecycle=?, active_revision=? WHERE id=?').run('active', 1, 'prof-old-1')
    db.prepare('INSERT INTO profiles VALUES (?, ?, ?, ?, ?, ?, ?)').run(PROFILE_TEMPLATES[0].id, owner, null, 'active', 'template', 5, 5)
    db.prepare('INSERT INTO profile_revisions VALUES (?, ?, ?, ?, ?, ?, ?)').run(PROFILE_TEMPLATES[0].id, 1, null, sha(template), 'template', template, 5)
    db.prepare("INSERT INTO store_meta VALUES ('templates_seeded', '5')").run()
  }
  db.close()
  chmodSync(filename, 0o600)
  return { filename, hash: sha(json) }
}
const schemaOf = filename => {
  const db = new DatabaseSync(filename, { readOnly: true })
  try {
    const objects = db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table','trigger','index') ORDER BY name").all().map(row => `${row.type}:${row.name}`)
    const columns = ['profiles', 'profile_revisions', 'store_meta'].map(table => db.prepare(`PRAGMA table_info(${table})`).all().map(row => `${table}.${row.name}:${row.type}:${row.notnull}:${row.dflt_value}`))
    return { version: db.prepare('PRAGMA user_version').get().user_version, objects, columns }
  } finally { db.close() }
}

test('draft revisions are append-only and immutable even at the database layer', t => {
  const { dataDir, open } = fixture(t)
  const store = open()
  const created = store.createDraft(rio())
  assert.equal(created.revision, 1)
  assert.match(created.id, /^prof-[0-9a-f-]{36}$/)
  assert.equal(created.profile.lifecycle, 'draft')
  assert.equal(created.profile.activeRevision, null)
  assert.equal(created.profile.hasDraft, true)
  const second = store.saveDraft(created.id, rio({ role: '회의와 일정 담당' }), 1)
  assert.deepEqual([second.revision, second.unchanged, second.profile.head.parentRevision], [2, false, 1])
  assert.equal(store.getRevision(created.id, 1).body.role, '회의 준비 담당')
  assert.equal(store.getRevision(created.id, 1).hash, created.hash)
  assert.deepEqual(store.revisions(created.id).revisions.map(item => [item.revision, item.parentRevision, item.author]), [[2, 1, 'user'], [1, null, 'user']])
  // Same body at the head makes no new revision.
  const same = store.saveDraft(created.id, rio({ role: '회의와 일정 담당' }), 2)
  assert.deepEqual([same.revision, same.unchanged], [2, true])

  const raw = new DatabaseSync(path.join(dataDir, `profiles-${store.ownerHash}.sqlite`))
  t.after(() => raw.close())
  assert.throws(() => raw.prepare('UPDATE profile_revisions SET body_json=? WHERE profile_id=?').run('{}', created.id), /immutable/)
  assert.throws(() => raw.prepare('DELETE FROM profile_revisions WHERE profile_id=?').run(created.id), /kept/)
  assert.equal(store.revisions(created.id).revisions.length, 2)
})

test('hash and canonical body are deterministic across key order, whitespace, case and Unicode form', t => {
  const { open } = fixture(t)
  const reordered = {
    model: { effort: 'medium', modelId: 'gpt-5.5', engine: 'codex' },
    toolPreferences: ['browser.read', 'files.search', 'browser.read'], instructions: '  대표님께는 존댓말을 쓴다.\r\n',
    expertise: ['회의 자료 정리', '일정 확인'], personality: { speechNotes: '결론부터 말한다.', traits: ['꼼꼼함', '차분함'], tone: 'warm' },
    role: ' 회의 준비 담당 ', avatar: { color: AVATAR_PALETTE[1].toUpperCase(), value: '🦊', kind: 'emoji' },
    name: '\u1105\u1175\u110b\u1169', // 리오 in NFD
  }
  assert.deepEqual(normalizeProfileBody(reordered), normalizeProfileBody(rio()))
  assert.equal(profileHash(reordered), profileHash(rio()))
  assert.deepEqual(Object.keys(normalizeProfileBody({ name: 'A' })), ['name', 'avatar', 'role', 'personality', 'expertise', 'instructions', 'toolPreferences', 'model'])
  const a = open('owner-a').createDraft(reordered), b = open('owner-b').createDraft(rio())
  assert.equal(a.hash, b.hash)
  assert.equal(a.hash, profileHash(rio()))
  assert.notEqual(profileHash(rio({ role: '다른 역할' })), a.hash)
})

test('stale expectedRevision and expectedActiveRevision are rejected with 409 and current revisions', t => {
  const { open } = fixture(t)
  const store = open()
  const { id } = store.createDraft(rio())
  store.saveDraft(id, rio({ role: '창 A' }), 1)
  assert.throws(() => store.saveDraft(id, rio({ role: '창 B' }), 1), error =>
    error.code === 'PROFILE_REVISION_CONFLICT' && error.httpStatus === 409 && error.headRevision === 2 && error.activeRevision === null)
  // A retried save of the edit that already landed returns that revision.
  const replay = store.saveDraft(id, rio({ role: '창 A' }), 1)
  assert.deepEqual([replay.revision, replay.unchanged], [2, true])
  assert.equal(store.revisions(id).revisions.length, 2)

  const active = store.activate(id, 2, null)
  assert.deepEqual([active.lifecycle, active.activeRevision, active.hasDraft], ['active', 2, false])
  assert.equal(store.activate(id, 2, null).activeRevision, 2, 'replayed activation is idempotent')
  assert.throws(() => store.activate(id, 1, null), error => error.code === 'PROFILE_REVISION_CONFLICT' && error.activeRevision === 2)
  rejects(() => store.activate(id, 1), 'INVALID_PROFILE_REVISION')
  rejects(() => store.activate(id, 9, 2), 'PROFILE_REVISION_NOT_FOUND')
  // Rolling back is activating an older immutable revision.
  assert.equal(store.activate(id, 1, 2).activeRevision, 1)
  rejects(() => store.saveDraft(id, rio(), 0), 'INVALID_PROFILE_REVISION')
  rejects(() => store.saveDraft('prof-missing', rio(), 1), 'PROFILE_NOT_FOUND')
})

test('lifecycle: disable, archive, restore and soft delete keep every revision', t => {
  const { open } = fixture(t)
  const store = open()
  const { id } = store.createDraft(rio())
  rejects(() => store.disable(id), 'PROFILE_LIFECYCLE_CONFLICT')
  store.activate(id, 1, null)
  assert.equal(store.runProfile(id).binding.revision, 1)
  assert.equal(store.disable(id).lifecycle, 'disabled')
  assert.equal(store.disable(id).lifecycle, 'disabled', 'repeat is a no-op')
  rejects(() => store.runProfile(id), 'PROFILE_NOT_RUNNABLE')
  assert.equal(store.restore(id).lifecycle, 'active')
  assert.equal(store.archive(id).lifecycle, 'archived')
  assert.deepEqual(store.list().profiles.map(item => item.id), [])
  assert.deepEqual(store.list({ includeArchived: true }).profiles.map(item => item.id), [id])
  rejects(() => store.saveDraft(id, rio({ role: '보관 중 편집' }), 1), 'PROFILE_LIFECYCLE_CONFLICT')
  rejects(() => store.activate(id, 1, 1), 'PROFILE_LIFECYCLE_CONFLICT')
  assert.equal(store.lifecycle(id, 'restore').lifecycle, 'active')
  store.saveDraft(id, rio({ role: '두 번째' }), 1)

  const deleted = store.delete(id)
  assert.equal(deleted.lifecycle, 'deleted')
  assert.equal(store.delete(id).lifecycle, 'deleted')
  assert.deepEqual(store.list({ includeArchived: true }).profiles, [])
  assert.equal(store.get(id).lifecycle, 'deleted')
  assert.equal(store.revisions(id).revisions.length, 2)
  assert.equal(store.getRevision(id, 1).body.name, '리오')
  rejects(() => store.restore(id), 'PROFILE_LIFECYCLE_CONFLICT')
  rejects(() => store.saveDraft(id, rio(), 2), 'PROFILE_LIFECYCLE_CONFLICT')
  rejects(() => store.lifecycle(id, 'purge'), 'INVALID_PROFILE_ACTION')
  const draft = store.createDraft({ name: '새 담당자' })
  assert.equal(store.restore(draft.id).lifecycle, 'draft', 'restore of a never-activated draft stays draft')
  assert.equal(store.archive(draft.id).lifecycle, 'archived')
  assert.equal(store.restore(draft.id).lifecycle, 'draft')
})

test('example templates seed once as active template revisions and never return after deletion', t => {
  const { open, handles } = fixture(t)
  const store = open()
  const first = store.seedTemplates()
  assert.deepEqual(first.seeded, ['conversational-coding', 'tool-operator', 'coding-project-manager', 'codebase-explorer', 'implementation-worker', 'review-verifier'])
  const listed = store.list().profiles
  assert.equal(listed.length, 6)
  assert.ok(listed.every(item => item.origin === 'template' && item.lifecycle === 'active' && item.activeRevision === 1))
  const pm = store.get('coding-project-manager')
  assert.equal(pm.active.author, 'template')
  assert.equal(pm.active.body.name, 'Coding Project Manager')
  assert.match(pm.active.body.instructions, /^You are EG-Desk's coding project manager agent\./)
  assert.deepEqual(store.seedTemplates(), { seeded: [], alreadySeeded: true })
  // A user edit of a template is a user revision on the same stable ID.
  const edited = store.saveDraft('tool-operator', { ...PROFILE_TEMPLATES[1].body, role: '도구 담당' }, 1)
  assert.deepEqual([edited.revision, edited.profile.head.author, edited.profile.activeRevision], [2, 'user', 1])
  store.delete('review-verifier')
  store.close(); handles.length = 0
  const reopened = open()
  assert.deepEqual(reopened.seedTemplates(), { seeded: [], alreadySeeded: true })
  assert.equal(reopened.get('review-verifier').lifecycle, 'deleted')
  assert.equal(reopened.get('tool-operator').headRevision, 2)
  rejects(() => open('other-owner').seedTemplates([{ id: 'prof-x', body: { name: 'X' } }]), 'INVALID_PROFILE_ID')
  rejects(() => open('third-owner').seedTemplates([{ id: 'a', body: { name: 'A' } }, { id: 'a', body: { name: 'B' } }]))
})

test('every public profile shape passes the chat store private-field gate', t => {
  const { dataDir, open } = fixture(t)
  const store = open()
  store.seedTemplates()
  const { id } = store.createDraft(rio())
  store.saveDraft(id, rio({ expertise: ['보고서 작성'] }), 1)
  store.activate(id, 2, null)
  const chat = openChatStore({ dataDir: path.join(dataDir, 'chat'), ownerScope: 'local-desktop-v1' })
  t.after(() => chat.close())
  chat.createConversation({ clientThreadId: 'client-profile', createdAt: 1 })
  const copy = store.duplicate(id), imported = store.importDraft(rio({ personality: { ...rio().personality, ...voice } }))
  const shapes = {
    list: store.list({ includeArchived: true }), view: store.get(id), revisions: store.revisions(id),
    revision: store.getRevision(id, 2), diff: store.diff(id, 1, 2), run: store.runProfile(id),
    templates: PROFILE_TEMPLATES.map(item => normalizeProfileBody(item.body)),
    copy, imported, copyOfImport: store.duplicate(imported.id),
  }
  const saved = chat.appendEvent({ clientThreadId: 'client-profile', eventKey: 'profile-shapes', ts: 2, event: 'profile.applied', details: shapes })
  assert.deepEqual(saved.details.run.binding, store.runProfile(id).binding)
  // Negative control: the same gate rejects the old inline field name.
  assert.throws(() => chat.appendEvent({ clientThreadId: 'client-profile', eventKey: 'legacy', ts: 3, event: 'profile.applied', details: { systemPrompt: 'x' } }), error => error.code === 'PRIVATE_CHAT_PAYLOAD')
  rejects(() => store.createDraft({ name: 'A', systemPrompt: 'x' }))
})

test('composeDeveloperInstructions is deterministic, ordered and bounded', () => {
  const text = composeDeveloperInstructions(rio())
  assert.equal(composeDeveloperInstructions(rio()), text)
  assert.equal(composeDeveloperInstructions(JSON.parse(JSON.stringify({ ...rio(), name: ' 리오 ' }))), text)
  const order = ['이름: 리오', '역할: 회의 준비 담당', '따뜻하고 친절한', '성격: 꼼꼼함, 차분함', '말하기 메모:\n결론부터 말한다.', '# 맡길 일\n- 회의 자료 정리\n- 일정 확인', '# 사용자 지침\n대표님께는 존댓말을 쓴다.']
  const positions = order.map(part => text.indexOf(part))
  assert.ok(positions.every(position => position >= 0), text)
  assert.deepEqual([...positions].sort((a, b) => a - b), positions)
  assert.doesNotMatch(text, /browser\.read|gpt-5\.5|🦊/, 'tool preferences, model and avatar are display-only')
  const tones = new Set(PROFILE_TONES.map(tone => composeDeveloperInstructions({ name: 'A', personality: { tone } })))
  assert.equal(tones.size, PROFILE_TONES.length)
  const minimal = composeDeveloperInstructions({ name: 'A' })
  assert.doesNotMatch(minimal, /역할:|성격:|# 맡길 일|# 사용자 지침/)
  const max = {
    name: '가'.repeat(40), role: '나'.repeat(80),
    personality: { tone: 'formal', traits: Array.from({ length: 6 }, (_, index) => `${index}${'다'.repeat(39)}`), speechNotes: '라'.repeat(500) },
    expertise: Array.from({ length: 8 }, (_, index) => `${index}${'마'.repeat(79)}`), instructions: '바'.repeat(8000),
  }
  const longest = composeDeveloperInstructions(max)
  assert.ok(longest.length <= MAX_COMPOSED)
  assert.ok(longest.endsWith('바'.repeat(8000)), 'the full user instructions survive at the caps')
})

test('input limits and formats are rejected before anything is written', t => {
  const { open } = fixture(t)
  const store = open()
  const bad = [
    null, [], 'text', {}, { name: '' }, { name: '   ' }, { name: '가'.repeat(41) }, { name: 'a\nb' }, { name: 1 },
    { name: 'A', role: '나'.repeat(81) }, { name: 'A', role: 'a\u2028b' },
    { name: 'A', personality: { tone: 'angry' } }, { name: 'A', personality: { traits: Array(7).fill('x').map((x, i) => x + i) } },
    { name: 'A', personality: { traits: ['가'.repeat(41)] } }, { name: 'A', personality: { speechNotes: '가'.repeat(501) } },
    { name: 'A', personality: { mood: 'x' } }, { name: 'A', expertise: Array.from({ length: 9 }, (_, i) => `일${i}`) },
    { name: 'A', expertise: [''] }, { name: 'A', expertise: 'one' }, { name: 'A', instructions: '가'.repeat(8001) },
    { name: 'A', instructions: 'a\u0000b' }, { name: 'A', toolPreferences: Array.from({ length: 21 }, (_, i) => `t${i}`) },
    { name: 'A', toolPreferences: ['rm -rf'] }, { name: 'A', avatar: { kind: 'emoji', value: 'ab' } },
    { name: 'A', avatar: { kind: 'emoji', value: '🦊🐻' } }, { name: 'A', avatar: { kind: 'initial', value: 'ABC' } },
    { name: 'A', avatar: { kind: 'initial', value: 'A', color: '#ff0000' } }, { name: 'A', avatar: { kind: 'image', value: 'a.png' } },
    { name: 'A', avatar: { kind: 'initial', value: 'A', url: 'x' } }, { name: 'A', model: { engine: 'gemini', modelId: 'x' } },
    { name: 'A', model: { engine: 'codex', modelId: 'bad id' } }, { name: 'A', model: { engine: 'claude', modelId: 'opus', effort: 'extreme' } },
    { name: 'A', instructionsText: 'x' }, Object.assign(Object.create({ name: 'A' }), {}),
  ]
  for (const body of bad) rejects(() => store.createDraft(body))
  assert.deepEqual(store.list({ includeArchived: true }).profiles, [])
  const ok = normalizeProfileBody({ name: 'A', avatar: { kind: 'initial', value: '김' }, model: { engine: 'claude', modelId: 'claude-opus-5-5' } })
  assert.deepEqual([ok.avatar.color, ok.model.effort, ok.personality.tone], [AVATAR_PALETTE[0], null, 'plain'])
  assert.equal(normalizeProfileBody({ name: 'A', avatar: { kind: 'emoji', value: '👩‍💻' } }).avatar.value, '👩‍💻')
  rejects(() => store.get('../etc'), 'INVALID_PROFILE_ID')
  rejects(() => store.list({ includeArchived: 'yes' }), 'INVALID_PROFILE_QUERY')
})

test('owner scopes are isolated files and bindings detect tampered revisions', t => {
  const { dataDir, open } = fixture(t)
  const a = open('owner-a'), b = open('owner-b')
  const { id } = a.createDraft(rio())
  assert.equal(b.get(id), null)
  assert.equal(readdirSync(dataDir).filter(name => name.endsWith('.sqlite')).length, 2)
  a.activate(id, 1, null)
  const view = a.get(id)
  const run = a.runProfile(id)
  assert.deepEqual(run.binding, profileBinding(view))
  assert.deepEqual(run.binding, { profileId: id, revision: 1, hash: profileHash(rio()) })
  assert.equal(run.developerInstructions, composeDeveloperInstructions(rio()))
  assert.deepEqual(run.model, rio().model)
  assert.throws(() => profileBinding(view, { ...view.active, body: { ...view.active.body, instructions: '바뀐 지침' } }), error => error.code === 'PROFILE_CORRUPT')
  assert.throws(() => profileBinding({ id: 'other' }, view.active), error => error.code === 'INVALID_PROFILE_BINDING')
  assert.deepEqual(a.diff(id, 1, 1).changes, [])
  a.saveDraft(id, rio({ expertise: ['일정 확인', '보고서 작성'], avatar: null }), 1)
  assert.deepEqual(a.diff(id, 1, 2).changes, [
    { field: 'avatar', before: rio().avatar, after: null },
    { field: 'expertise', before: ['회의 자료 정리', '일정 확인'], after: ['일정 확인', '보고서 작성'], added: ['보고서 작성'], removed: ['회의 자료 정리'] },
  ])
  assert.deepEqual(diffProfileBodies({ name: 'A' }, { name: 'B' }), [{ field: 'name', before: 'A', after: 'B' }])
  rejects(() => a.diff(id, 1, 3), 'PROFILE_REVISION_NOT_FOUND')
})

test('unsafe store locations are refused', t => {
  const { dataDir } = fixture(t)
  rejects(() => openProfileStore({ dataDir: 'relative', ownerHash: 'x' }), 'INVALID_STORE_SCOPE')
  rejects(() => openProfileStore({ dataDir, ownerHash: '' }), 'INVALID_STORE_SCOPE')
  if (process.platform === 'win32') return
  const shared = path.join(dataDir, 'shared')
  openProfileStore({ dataDir: shared, ownerHash: 'x' }).close()
  chmodSync(shared, 0o755)
  rejects(() => openProfileStore({ dataDir: shared, ownerHash: 'x' }), 'INVALID_STORE_SCOPE')
})

test('example exchanges and "하지 말 것" are kept only when set and compose as their own sections', () => {
  // Empty lists leave the body, its hash and its composed text exactly as before these fields.
  const empty = rio({ personality: { ...rio().personality, examples: [], avoid: null } })
  assert.deepEqual(normalizeProfileBody(empty), normalizeProfileBody(rio()))
  assert.deepEqual(Object.keys(normalizeProfileBody(rio()).personality), ['tone', 'traits', 'speechNotes'])
  assert.equal(profileHash(empty), profileHash(rio()))
  assert.equal(composeDeveloperInstructions(empty), composeDeveloperInstructions(rio()))

  const spoken = rio({ personality: { ...rio().personality, examples: [...voice.examples, { user: ' 내일 회의 뭐 있어? ', reply: '내일은 회의가 두 개 있어요.\r\n10시 기획 회의, 3시 고객 미팅입니다.' }], avoid: [...voice.avoid, voice.avoid[0]] } })
  const body = normalizeProfileBody(spoken)
  assert.deepEqual(Object.keys(body.personality), ['tone', 'traits', 'speechNotes', 'examples', 'avoid'])
  assert.deepEqual(body.personality.examples, voice.examples, 'trimmed, CRLF folded and repeated pairs dropped')
  assert.deepEqual(body.personality.avoid, voice.avoid)
  assert.notEqual(profileHash(spoken), profileHash(rio()))

  const text = composeDeveloperInstructions(spoken)
  const order = ['# 말투와 성격', '# 말투 예시', '사용자: 내일 회의 뭐 있어?\n리오: 내일은 회의가 두 개 있어요.\n10시 기획 회의', '# 맡길 일', '# 하지 말 것\n- 확인하지 않은 일정을 확정처럼 말하기\n- 회의 내용을 외부에 옮기기', '# 사용자 지침']
  const positions = order.map(part => text.indexOf(part))
  assert.ok(positions.every(position => position >= 0), text)
  assert.deepEqual([...positions].sort((a, b) => a - b), positions)
  assert.match(text, /# 말투 예시\n[^\n]*그대로 되풀이하지 않는다\.\n예시 1\n/, 'one line says the examples show the voice, not facts to repeat')
  assert.ok(text.endsWith('# 사용자 지침\n대표님께는 존댓말을 쓴다.'))

  const L = PERSONALITY_LIMITS
  const max = {
    name: '가'.repeat(40), role: '나'.repeat(80),
    personality: {
      tone: 'playful', traits: Array.from({ length: 6 }, (_, index) => `${index}${'다'.repeat(39)}`), speechNotes: '라'.repeat(500),
      examples: Array.from({ length: L.examples }, (_, index) => ({ user: `${index}${'사'.repeat(L.exampleUser - 1)}`, reply: `${index}${'아'.repeat(L.exampleReply - 1)}` })),
      avoid: Array.from({ length: L.avoid }, (_, index) => `${index}${'자'.repeat(L.avoidItem - 1)}`),
    },
    expertise: Array.from({ length: 8 }, (_, index) => `${index}${'마'.repeat(79)}`), instructions: '바'.repeat(8000),
    toolCeiling: { browser: 'observe', files: 'read', terminal: 'none', network: 'off', mcp: 'none' },
  }
  const longest = composeDeveloperInstructions(max)
  assert.ok(longest.length <= MAX_COMPOSED, `${longest.length}`)
  assert.ok(longest.endsWith('바'.repeat(8000)), 'every field at its cap still leaves the full user instructions')

  const personality = extra => ({ name: 'A', personality: extra })
  for (const bad of [
    personality({ examples: 'one' }), personality({ examples: Array.from({ length: L.examples + 1 }, (_, i) => ({ user: `q${i}`, reply: `a${i}` })) }),
    personality({ examples: [{ user: 'q' }] }), personality({ examples: [{ user: '', reply: 'a' }] }), personality({ examples: [{ user: 'q', reply: '  ' }] }),
    personality({ examples: [{ user: 'a\nb', reply: 'a' }] }), personality({ examples: [{ user: 'q', reply: 'a'.repeat(L.exampleReply + 1) }] }),
    personality({ examples: [{ user: 'q'.repeat(L.exampleUser + 1), reply: 'a' }] }), personality({ examples: [{ user: 'q', reply: 'a', speaker: 'x' }] }),
    personality({ examples: ['q → a'] }), personality({ avoid: Array.from({ length: L.avoid + 1 }, (_, i) => `x${i}`) }),
    personality({ avoid: ['가'.repeat(L.avoidItem + 1)] }), personality({ avoid: [''] }), personality({ avoid: 'x' }),
  ]) rejects(() => normalizeProfileBody(bad))

  assert.deepEqual(diffProfileBodies(rio(), spoken), [
    { field: 'personality.examples', before: [], after: voice.examples, added: voice.examples, removed: [] },
    { field: 'personality.avoid', before: [], after: voice.avoid, added: voice.avoid, removed: [] },
  ])
  const reworded = { ...spoken, personality: { ...spoken.personality, examples: [{ user: '내일 회의 뭐 있어?', reply: '두 개예요.' }] } }
  assert.deepEqual(diffProfileBodies(spoken, reworded)[0].removed, voice.examples, 'example pairs compare by value')
})

test('duplicate makes a new draft from one saved revision and leaves the original as it was', t => {
  const { open } = fixture(t)
  const store = open()
  store.seedTemplates()
  const template = PROFILE_TEMPLATES.find(item => item.id === 'codebase-explorer')
  const copy = store.duplicate('codebase-explorer')
  assert.match(copy.id, /^prof-[0-9a-f-]{36}$/)
  assert.deepEqual([copy.revision, copy.unchanged, copy.profile.lifecycle, copy.profile.origin, copy.profile.activeRevision, copy.profile.head.author], [1, false, 'draft', 'user', null, 'user'])
  assert.deepEqual(copy.profile.head.body, normalizeProfileBody({ ...template.body, name: 'Codebase Explorer 사본' }))
  assert.equal(copy.profile.reviewRequired, false)
  const [entry] = copy.profile.source
  assert.deepEqual(copy.profile.source, [{ kind: 'duplicate', origin: 'template', profileId: 'codebase-explorer', revision: 1, hash: profileHash(template.body), name: 'Codebase Explorer', at: entry.at }])
  assert.ok(Number.isSafeInteger(entry.at))
  store.saveDraft(copy.id, { ...template.body, name: '코드 탐색 담당' }, 1)
  const original = store.get('codebase-explorer')
  assert.deepEqual([original.headRevision, original.activeRevision, original.hasDraft, original.source], [1, 1, false, []], 'editing the copy never touches the example')
  assert.equal(store.list().profiles.find(item => item.id === copy.id).latestSource.profileId, 'codebase-explorer')

  // A user's own Agent: the active revision by default, or any saved revision and a chosen name.
  const { id } = store.createDraft(rio())
  store.saveDraft(id, rio({ role: '두 번째 역할' }), 1)
  assert.equal(store.duplicate(id).profile.head.body.role, '두 번째 역할', 'never activated: the latest revision')
  store.activate(id, 1, null)
  const fromActive = store.duplicate(id)
  assert.deepEqual([fromActive.profile.head.body.role, fromActive.profile.head.body.name, fromActive.profile.source[0].revision], ['회의 준비 담당', '리오 사본', 1])
  const chosen = store.duplicate(id, 2, { name: ' 리오 B ' })
  assert.deepEqual([chosen.profile.head.body.role, chosen.profile.head.body.name, chosen.profile.source[0].hash], ['두 번째 역할', '리오 B', store.getRevision(id, 2).hash])
  assert.equal(store.revisions(id).revisions.length, 2)

  // Copies of copies carry the chain, oldest first, newest MAX_SOURCE_ENTRIES kept.
  const second = store.duplicate(copy.id)
  assert.deepEqual(second.profile.source.map(item => [item.kind, item.origin, item.profileId, item.revision]), [['duplicate', 'template', 'codebase-explorer', 1], ['duplicate', 'user', copy.id, 2]], 'the copy was edited once and never activated: its latest revision')
  let last = second
  for (let index = 0; index < MAX_SOURCE_ENTRIES + 2; index++) last = store.duplicate(last.id, undefined, { name: `사본 ${index}` })
  assert.equal(last.profile.source.length, MAX_SOURCE_ENTRIES)
  assert.equal(last.profile.source.at(-1).name, `사본 ${MAX_SOURCE_ENTRIES}`)

  store.archive(chosen.id)
  assert.equal(store.duplicate(chosen.id).profile.lifecycle, 'draft', 'an archived Agent can still be copied')
  store.delete(chosen.id)
  rejects(() => store.duplicate(chosen.id), 'PROFILE_LIFECYCLE_CONFLICT')
  rejects(() => store.duplicate(id, 9), 'PROFILE_REVISION_NOT_FOUND')
  rejects(() => store.duplicate(id, '1'), 'INVALID_PROFILE_REVISION')
  rejects(() => store.duplicate(id, 1, { name: '' }))
  rejects(() => store.duplicate(id, 1, { name: '가'.repeat(41) }))
  rejects(() => store.duplicate('prof-missing'), 'PROFILE_NOT_FOUND')
  assert.equal(copyName('가'.repeat(40)), `${'가'.repeat(37)} 사본`)
  assert.equal(copyName(`${'가'.repeat(36)}👩‍💻`), `${'가'.repeat(36)} 사본`, 'a name is shortened by whole characters')
})

test('an imported Agent waits as a draft until the user activates it', t => {
  const { open } = fixture(t)
  const store = open()
  const imported = store.importDraft(rio({ personality: { ...rio().personality, ...voice } }), { format: 'egdesk' })
  assert.deepEqual([imported.profile.lifecycle, imported.profile.activeRevision, imported.profile.reviewRequired], ['draft', null, true])
  assert.deepEqual(imported.profile.source.map(({ at, ...rest }) => rest), [{ kind: 'import', format: 'egdesk', name: '리오' }])
  assert.deepEqual(imported.profile.head.body.personality.examples, voice.examples)
  rejects(() => store.runProfile(imported.id), 'PROFILE_NOT_RUNNABLE')
  store.saveDraft(imported.id, rio({ role: '고친 역할' }), 1)
  assert.equal(store.get(imported.id).reviewRequired, true, 'editing is not yet using it')
  assert.equal(store.duplicate(imported.id).profile.reviewRequired, true, 'a copy of unreviewed instructions is unreviewed too')
  const active = store.activate(imported.id, 2, null)
  assert.deepEqual([active.lifecycle, active.reviewRequired, active.source.length], ['active', false, 1])
  assert.equal(store.list().profiles.find(item => item.id === imported.id).reviewRequired, false)
  const before = store.list({ includeArchived: true }).profiles.length
  rejects(() => store.importDraft(rio(), { format: 'toml' }))
  rejects(() => store.importDraft({ name: 'A', systemPrompt: 'x' }))
  assert.equal(store.list({ includeArchived: true }).profiles.length, before)
})

test('a version 1 file is upgraded in place to version 2 and saved revisions keep their bytes', t => {
  const { dataDir, open, handles } = fixture(t)
  const { filename, hash } = writeOldStore(dataDir, 'local-desktop-v1')
  assert.equal(schemaOf(filename).version, 1)
  const store = open('local-desktop-v1')
  const upgraded = schemaOf(filename)
  assert.equal(upgraded.version, 2)
  assert.ok(upgraded.objects.includes('trigger:profiles_source_append_only'))
  const old = store.get('prof-old-1')
  assert.deepEqual([old.lifecycle, old.activeRevision, old.active.hash, old.source, old.reviewRequired], ['active', 1, hash, [], false])
  assert.deepEqual(store.runProfile('prof-old-1').binding, { profileId: 'prof-old-1', revision: 1, hash })
  assert.deepEqual(store.seedTemplates(), { seeded: [], alreadySeeded: true })
  assert.equal(store.duplicate(PROFILE_TEMPLATES[0].id).profile.source[0].origin, 'template')
  assert.equal(store.saveDraft('prof-old-1', rio({ role: '새 역할' }), 1).revision, 2)
  store.close(); handles.length = 0
  assert.equal(open('local-desktop-v1').get('prof-old-1').headRevision, 2, 'reopening an upgraded file does not upgrade again')

  // A file made new today ends with the same tables, columns and triggers as an upgraded one.
  const fresh = open('fresh-owner')
  fresh.createDraft(rio())
  const created = schemaOf(path.join(dataDir, `profiles-${fresh.ownerHash}.sqlite`))
  assert.deepEqual({ ...created, objects: created.objects.filter(name => !name.startsWith('index:sqlite_autoindex')) }, { ...upgraded, objects: upgraded.objects.filter(name => !name.startsWith('index:sqlite_autoindex')) })
})

test('a newer or damaged profile file is refused without being changed', t => {
  const { dataDir } = fixture(t)
  const newer = writeOldStore(dataDir, 'owner-newer', { version: 3 })
  assert.throws(() => openProfileStore({ dataDir, ownerHash: 'owner-newer' }), error => error.code === 'UNSUPPORTED_STORE_VERSION' && /newer EG-Desk/.test(error.message))
  assert.deepEqual([schemaOf(newer.filename).version, schemaOf(newer.filename).columns[0].some(column => column.startsWith('profiles.source_json'))], [3, false])

  const broken = writeOldStore(dataDir, 'owner-broken', { schema: V1_SCHEMA.replace(/CREATE TRIGGER profile_revisions_kept[^;]+;[^;]+;/, '') })
  assert.throws(() => openProfileStore({ dataDir, ownerHash: 'owner-broken' }), error => error.code === 'STORE_CORRUPT')
  const after = schemaOf(broken.filename)
  assert.deepEqual([after.version, after.columns[0].some(column => column.startsWith('profiles.source_json'))], [1, false], 'a damaged file is not built upon')

  const unknown = writeOldStore(dataDir, 'owner-unknown', { version: 0, schema: 'CREATE TABLE other (x);', rows: false })
  assert.throws(() => openProfileStore({ dataDir, ownerHash: 'owner-unknown' }), error => error.code === 'UNSUPPORTED_STORE_VERSION')
  assert.deepEqual(schemaOf(unknown.filename).objects, ['table:other'])
})

test('where a profile came from is append-only even at the database layer', t => {
  const { dataDir, open } = fixture(t)
  const store = open()
  const { id } = store.createDraft(rio())
  const copy = store.duplicate(id)
  const raw = new DatabaseSync(path.join(dataDir, `profiles-${store.ownerHash}.sqlite`))
  t.after(() => raw.close())
  const current = raw.prepare('SELECT source_json FROM profiles WHERE id=?').get(copy.id).source_json
  for (const rewrite of ['[]', current.replace('"duplicate"', '"import"'), '{}']) {
    assert.throws(() => raw.prepare('UPDATE profiles SET source_json=? WHERE id=?').run(rewrite, copy.id), /append-only|CHECK constraint/, rewrite)
  }
  raw.prepare('UPDATE profiles SET source_json=? WHERE id=?').run(`${current.slice(0, -1)},{"kind":"note","at":1}]`, copy.id)
  assert.deepEqual(store.get(copy.id).source.map(item => item.kind), ['duplicate', 'note'], 'appending is the one change allowed')
  assert.throws(() => raw.prepare("INSERT INTO profiles (id, owner_hash, lifecycle, origin, created_at, updated_at, source_json) VALUES ('prof-x', 'o', 'draft', 'user', 1, 1, 'x')").run(), /CHECK constraint/)
})
