import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import {
  AVATAR_PALETTE, MAX_COMPOSED, PROFILE_TEMPLATES, PROFILE_TONES, composeDeveloperInstructions,
  diffProfileBodies, normalizeProfileBody, openProfileStore, profileBinding, profileHash,
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
  const shapes = {
    list: store.list({ includeArchived: true }), view: store.get(id), revisions: store.revisions(id),
    revision: store.getRevision(id, 2), diff: store.diff(id, 1, 2), run: store.runProfile(id),
    templates: PROFILE_TEMPLATES.map(item => normalizeProfileBody(item.body)),
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
