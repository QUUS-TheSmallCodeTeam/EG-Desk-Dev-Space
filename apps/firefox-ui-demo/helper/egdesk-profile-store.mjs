import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isOwnedAndPrivate } from './egdesk-private-files.mjs'

// Local Agent Profile store. A profile has a stable ID and an append-only
// chain of revisions; Runs bind to {profileId, revision, hash}. Public body
// keys are fixed so no stored object key is model- or user-chosen.
const VERSION = 1
export const MAX_PROFILES = 200
const MAX_PROFILE_ROWS = 1000 // Live + soft-deleted rows; deleted rows keep their history.
export const MAX_REVISIONS = 500
export const MAX_COMPOSED = 12000
export const PROFILE_LIFECYCLES = ['draft', 'active', 'disabled', 'archived', 'deleted']
export const PROFILE_TONES = ['plain', 'warm', 'concise', 'formal', 'playful']
export const LIFECYCLE_ACTIONS = ['disable', 'archive', 'restore', 'delete']
// Six swatches from docs/egdesk-approved-desktop-style.html :root tokens.
export const AVATAR_PALETTE = [
  '#49634f', // --eg-accent (light)
  '#a9c5a9', // --eg-accent (dark)
  '#958879', // --eg-wood-line (light)
  '#7b8079', // --eg-muted (light)
  '#252a26', // --eg-ink (light)
  '#f5f0df', // --eg-note (light)
]
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const BODY_KEYS = ['name', 'avatar', 'role', 'personality', 'expertise', 'instructions', 'toolPreferences', 'model']
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/
const SINGLE_LINE_BAD = /[\u0000-\u001f\u007f\u2028\u2029]/
const MULTI_LINE_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' })

function fail(code, message, httpStatus = 400, extra) {
  throw Object.assign(new Error(message), { code, httpStatus }, extra)
}
const digest = value => createHash('sha256').update(value).digest('hex')
const chars = value => Array.from(value).length

function shape(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('INVALID_PROFILE', `${name} must be an object`)
  const unknown = Object.keys(value).find(key => !keys.includes(key))
  if (unknown !== undefined) fail('INVALID_PROFILE', `${name} has an unsupported field`)
}
function line(value, name, { min = 0, max }) {
  if (value === undefined || value === null) value = ''
  if (typeof value !== 'string') fail('INVALID_PROFILE', `${name} must be text`)
  const text = value.normalize('NFC').trim()
  if (SINGLE_LINE_BAD.test(text)) fail('INVALID_PROFILE', `${name} must be a single line`)
  const length = chars(text)
  if (length < min || length > max) fail('INVALID_PROFILE', min ? `${name} must be ${min}–${max} characters` : `${name} must be at most ${max} characters`)
  return text
}
function block(value, name, max) {
  if (value === undefined || value === null) value = ''
  if (typeof value !== 'string') fail('INVALID_PROFILE', `${name} must be text`)
  const text = value.normalize('NFC').replace(/\r\n?/g, '\n').trim()
  if (MULTI_LINE_BAD.test(text)) fail('INVALID_PROFILE', `${name} contains control characters`)
  if (chars(text) > max) fail('INVALID_PROFILE', `${name} must be at most ${max} characters`)
  return text
}
function list(value, name, { max, itemMax, pattern }) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > max) fail('INVALID_PROFILE', `${name} must be a list of at most ${max} items`)
  const items = value.map(item => line(item, `${name} item`, { min: 1, max: itemMax }))
  if (pattern && items.some(item => !pattern.test(item))) fail('INVALID_PROFILE', `${name} has an invalid item`)
  return [...new Set(items)] // Keep first-seen order; duplicates carry no meaning.
}
function avatar(value) {
  if (value === undefined || value === null) return null
  shape(value, ['kind', 'value', 'color'], 'avatar')
  if (!['emoji', 'initial'].includes(value.kind)) fail('INVALID_PROFILE', 'avatar.kind must be emoji or initial')
  if (typeof value.value !== 'string') fail('INVALID_PROFILE', 'avatar.value must be text')
  const text = value.value.normalize('NFC').trim()
  if (value.kind === 'emoji') {
    const parts = [...graphemes.segment(text)]
    // One pictographic grapheme (ZWJ sequences and flags included); no image uploads.
    if (parts.length !== 1 || text.length > 32 || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text)) fail('INVALID_PROFILE', 'avatar.value must be exactly one emoji')
  } else if (!/^[\p{L}\p{N}]{1,2}$/u.test(text)) fail('INVALID_PROFILE', 'avatar.value must be 1–2 letters or digits')
  const color = value.color === undefined ? AVATAR_PALETTE[0] : typeof value.color === 'string' ? value.color.toLowerCase() : null
  if (!AVATAR_PALETTE.includes(color)) fail('INVALID_PROFILE', 'avatar.color must be one of the approved palette colors')
  return { kind: value.kind, value: text, color }
}
function personality(value) {
  if (value === undefined || value === null) value = {}
  shape(value, ['tone', 'traits', 'speechNotes'], 'personality')
  const tone = value.tone === undefined || value.tone === null ? 'plain' : value.tone
  if (!PROFILE_TONES.includes(tone)) fail('INVALID_PROFILE', 'personality.tone is not supported')
  return {
    tone,
    traits: list(value.traits, 'personality.traits', { max: 6, itemMax: 40 }),
    speechNotes: block(value.speechNotes, 'personality.speechNotes', 500),
  }
}
function model(value) {
  if (value === undefined || value === null) return null
  shape(value, ['engine', 'modelId', 'effort'], 'model')
  if (!['codex', 'claude'].includes(value.engine)) fail('INVALID_PROFILE', 'model.engine must be codex or claude')
  if (typeof value.modelId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(value.modelId)) fail('INVALID_PROFILE', 'model.modelId is invalid')
  const effort = value.effort === undefined ? null : value.effort
  if (effort !== null && !REASONING_EFFORTS.has(effort)) fail('INVALID_PROFILE', 'model.effort is not supported')
  return { engine: value.engine, modelId: value.modelId, effort }
}

/** Canonical public body: fixed keys in fixed order, so equal input gives equal JSON and hash. */
export function normalizeProfileBody(input) {
  shape(input, BODY_KEYS, 'profile body')
  return {
    name: line(input.name, 'name', { min: 1, max: 40 }),
    avatar: avatar(input.avatar),
    role: line(input.role, 'role', { max: 80 }),
    personality: personality(input.personality),
    expertise: list(input.expertise, 'expertise', { max: 8, itemMax: 80 }),
    instructions: block(input.instructions, 'instructions', 8000),
    toolPreferences: list(input.toolPreferences, 'toolPreferences', { max: 20, itemMax: 64, pattern: /^[A-Za-z0-9_.:-]+$/ }),
    model: model(input.model),
  }
}
export const profileHash = body => digest(JSON.stringify(normalizeProfileBody(body)))

const TONE_DIRECTIVES = {
  plain: '꾸밈 없이 평이한 말투로 답한다.',
  warm: '따뜻하고 친절한 말투로 답하되 내용은 정확하게 유지한다.',
  concise: '핵심부터 짧고 간결하게 답한다.',
  formal: '격식 있는 존댓말로 정중하게 답한다.',
  playful: '가볍고 유쾌한 말투로 답하되 사실과 판단은 흐리지 않는다.',
}
/** Deterministic developer instructions: identity → tone → work → user instructions. */
export function composeDeveloperInstructions(input) {
  const body = normalizeProfileBody(input)
  const { tone, traits, speechNotes } = body.personality
  const sections = [
    ['아래는 사용자가 EG-Desk에서 정한 담당자 설정이다. 이 설정에 맞춰 일한다.'],
    ['# 담당자', `이름: ${body.name}`, body.role && `역할: ${body.role}`],
    ['# 말투와 성격', TONE_DIRECTIVES[tone], traits.length && `성격: ${traits.join(', ')}`, speechNotes && `말하기 메모:\n${speechNotes}`],
    body.expertise.length && ['# 맡길 일', ...body.expertise.map(item => `- ${item}`)],
    body.instructions && ['# 사용자 지침', body.instructions],
  ]
  // Field caps keep the total below MAX_COMPOSED; the slice is a guard only.
  return sections.filter(Boolean).map(lines => lines.filter(Boolean).join('\n')).join('\n\n').slice(0, MAX_COMPOSED)
}

/** Run record binding. Rejects a revision whose body no longer matches its hash. */
export function profileBinding(profile, revision = profile?.active) {
  if (!profile || typeof profile.id !== 'string' || !revision || revision.profileId !== profile.id || !Number.isSafeInteger(revision.revision) || typeof revision.hash !== 'string') fail('INVALID_PROFILE_BINDING', 'A saved revision of this profile is required')
  // Saved bodies are canonical JSON, so re-serializing reproduces the hashed bytes.
  if (digest(JSON.stringify(revision.body)) !== revision.hash) fail('PROFILE_CORRUPT', 'Profile revision does not match its hash', 500)
  return { profileId: profile.id, revision: revision.revision, hash: revision.hash }
}

const DIFF_FIELDS = [
  ['name', body => body.name], ['avatar', body => body.avatar], ['role', body => body.role],
  ['personality.tone', body => body.personality.tone], ['personality.traits', body => body.personality.traits],
  ['personality.speechNotes', body => body.personality.speechNotes], ['expertise', body => body.expertise],
  ['instructions', body => body.instructions], ['toolPreferences', body => body.toolPreferences], ['model', body => body.model],
]
/** Field-level changes as an array of fixed-key records. */
export function diffProfileBodies(fromBody, toBody) {
  const before = normalizeProfileBody(fromBody), after = normalizeProfileBody(toBody)
  const changes = []
  for (const [field, read] of DIFF_FIELDS) {
    const a = read(before), b = read(after)
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    changes.push(Array.isArray(a)
      ? { field, before: a, after: b, added: b.filter(item => !a.includes(item)), removed: a.filter(item => !b.includes(item)) }
      : { field, before: a, after: b })
  }
  return changes
}

// Example templates moved from overlay/JS/eg-desk-surface.uc.js
// CODEX_AGENT_PROFILE_DEFS. IDs stay equal so existing thread agentProfileId values resolve.
const templateAvatar = (value, index) => ({ kind: 'initial', value, color: AVATAR_PALETTE[index % AVATAR_PALETTE.length] })
export const PROFILE_TEMPLATES = Object.freeze([
  {
    id: 'conversational-coding',
    body: {
      name: 'Conversational Coding Agent', avatar: templateAvatar('C', 0),
      role: '짧은 대화 응답과 필요 시 기본 tool call을 수행하는 기본 채팅 프로필',
      instructions: [
        'You are EG-Desk\'s default conversational coding assistant.',
        'Keep chat replies short and direct: use chat for conclusions, brief summaries, and result links.',
        'When durable artifacts, reports, evidence, or long explanations are needed, prefer canvas cards or linked outputs instead of long chat bubbles.',
        'Use project context and available tools when needed, verify claims before presenting them as facts, and ask clarifying questions only when blocked.',
      ].join('\n'),
    },
  },
  {
    id: 'tool-operator',
    body: {
      name: 'Basic Tool Operator', avatar: templateAvatar('T', 1),
      role: '요청을 안전한 tool call 흐름으로 바꾸고 관찰 결과만 보고하는 프로필',
      instructions: [
        'You are EG-Desk\'s tool-operating assistant.',
        'Convert the user request into the smallest safe set of concrete tool actions.',
        'Report what was actually observed, separate failures from assumptions, and do not claim tool results without seeing them.',
        'Keep the visible chat response compact and route bulky outputs to canvas artifacts when available.',
      ].join('\n'),
    },
  },
  {
    id: 'coding-project-manager',
    body: {
      name: 'Coding Project Manager', avatar: templateAvatar('PM', 2),
      role: 'high-level 목표를 유지하면서 coding sub-goal, verification, agent routing을 관리하는 프로필',
      instructions: [
        'You are EG-Desk\'s coding project manager agent.',
        'Preserve the high-level objective and agenda context while decomposing work into scoped coding tasks.',
        'Decide whether work belongs in Agent DM, an Agenda Thread, a specialized agent, or a concrete implementation pass.',
        'Track risks, verification requirements, and unresolved decisions; keep final chat output brief with links or canvas cards for detailed artifacts.',
      ].join('\n'),
    },
  },
  {
    id: 'codebase-explorer',
    body: {
      name: 'Codebase Explorer', avatar: templateAvatar('E', 3),
      role: '수정 전에 코드베이스를 읽고 runtime boundary와 file ownership을 파악하는 프로필',
      instructions: [
        'You are EG-Desk\'s codebase explorer.',
        'Read existing source before proposing edits, identify ownership boundaries, and ground conclusions in file references or runtime evidence.',
        'Avoid speculative architecture claims and avoid modifying files unless the user explicitly requests implementation.',
        'Return concise findings that another coding agent can act on.',
      ].join('\n'),
    },
  },
  {
    id: 'implementation-worker',
    body: {
      name: 'Implementation Worker', avatar: templateAvatar('B', 4),
      role: 'scope가 정해진 코드 수정, 테스트, 회귀 확인을 수행하는 프로필',
      instructions: [
        'You are EG-Desk\'s implementation worker.',
        'Implement the scoped change using the existing codebase patterns and the smallest effective edit.',
        'Do not revert unrelated user changes; adapt to the current worktree and verify behavior with targeted tests or runtime checks.',
        'Report changed files, verification, and remaining risks succinctly.',
      ].join('\n'),
    },
  },
  {
    id: 'review-verifier',
    body: {
      name: 'Review and Verification Agent', avatar: templateAvatar('V', 5),
      role: '버그, 회귀, 누락 테스트, UI runtime evidence를 우선 점검하는 프로필',
      instructions: [
        'You are EG-Desk\'s review and verification agent.',
        'Lead with bugs, regressions, missing tests, and evidence; keep style commentary secondary unless it affects usability or correctness.',
        'Use screenshots, logs, runtime checks, and file references for UI or behavior claims.',
        'If no issues are found, say that clearly and name the remaining test gaps.',
      ].join('\n'),
    },
  },
])

export function profileId(value) {
  if (typeof value !== 'string' || !PROFILE_ID.test(value)) fail('INVALID_PROFILE_ID', 'Profile ID is invalid')
  return value
}
function revisionNumber(value, name = 'revision') {
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_PROFILE_REVISION', `${name} must be a positive integer`)
  return value
}

function initialize(db) {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
  if (String(db.prepare('PRAGMA journal_mode=WAL').get().journal_mode).toLowerCase() !== 'wal') fail('STORE_OPEN_FAILED', 'WAL could not be enabled', 500)
  db.exec('PRAGMA synchronous=FULL;')
  if (db.prepare('PRAGMA synchronous').get().synchronous !== 2) fail('STORE_OPEN_FAILED', 'FULL durability could not be enabled', 500)
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('STORE_CORRUPT', 'Profile database failed integrity check; database was not reset', 500)
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (version === VERSION) {
    const found = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')").all().map(row => row.name))
    if (['profiles', 'profile_revisions', 'store_meta', 'profile_revisions_immutable', 'profile_revisions_kept'].some(name => !found.has(name))) fail('STORE_CORRUPT', 'Profile schema is incomplete; database was not reset', 500)
    return
  }
  if (version !== 0 || db.prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").get()) fail('UNSUPPORTED_STORE_VERSION', 'Existing profile database has an unsupported schema; database was not reset', 500)
  db.exec(`BEGIN IMMEDIATE;
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
    CREATE TABLE store_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version=${VERSION};
    COMMIT;`)
}

/** Synchronous local-only profile store for one owner scope (same file rules as the chat store). */
export function openProfileStore({ dataDir, ownerHash } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof ownerHash !== 'string' || !ownerHash.trim() || ownerHash.length > 512 || ownerHash.includes('\0')) fail('INVALID_STORE_SCOPE', 'Absolute dataDir and local owner scope are required')
  const owner = digest(ownerHash)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dataDir)
  const canonical = realpathSync.native(dataDir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedAndPrivate(canonical, stat, 0o077)) fail('INVALID_STORE_SCOPE', 'Profile directory must be private and not a symlink')
  const filename = path.join(canonical, `profiles-${owner}.sqlite`)
  const privateDatabase = info => info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && isOwnedAndPrivate(filename, info, 0o077)
  try {
    if (!privateDatabase(lstatSync(filename))) fail('INVALID_STORE_SCOPE', 'Profile database must be a private, unlinked regular file')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  closeSync(openSync(filename, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600))
  if (!privateDatabase(lstatSync(filename))) fail('INVALID_STORE_SCOPE', 'Profile database must be a private, unlinked regular file')
  let db
  try { db = new DatabaseSync(filename); initialize(db) }
  catch (error) {
    try { db?.close() } catch { /* Keep original error. */ }
    if (['STORE_CORRUPT', 'UNSUPPORTED_STORE_VERSION', 'STORE_OPEN_FAILED'].includes(error.code)) throw error
    fail('STORE_OPEN_FAILED', 'Profile database could not be opened; database was not reset', 500)
  }

  const q = {
    profile: db.prepare('SELECT * FROM profiles WHERE id=? AND owner_hash=?'),
    head: db.prepare('SELECT * FROM profile_revisions WHERE profile_id=? ORDER BY revision DESC LIMIT 1'),
    revision: db.prepare('SELECT * FROM profile_revisions WHERE profile_id=? AND revision=?'),
    insertProfile: db.prepare('INSERT INTO profiles VALUES (?, ?, ?, ?, ?, ?, ?)'),
    insertRevision: db.prepare('INSERT INTO profile_revisions VALUES (?, ?, ?, ?, ?, ?, ?)'),
    touch: db.prepare('UPDATE profiles SET lifecycle=?, active_revision=?, updated_at=? WHERE id=? AND owner_hash=?'),
  }
  let closed = false
  const ensureOpen = () => { if (closed) fail('STORE_CLOSED', 'Profile store is closed', 500) }
  const tx = action => {
    db.exec('BEGIN IMMEDIATE')
    try { const result = action(); db.exec('COMMIT'); return result }
    catch (error) { try { db.exec('ROLLBACK') } catch { /* Preserve original failure. */ } throw error }
  }
  const now = () => Date.now()
  const conflict = (message, row, head) => fail('PROFILE_REVISION_CONFLICT', message, 409, { headRevision: head?.revision ?? null, activeRevision: row?.active_revision ?? null })
  const lifecycleConflict = (message, row) => fail('PROFILE_LIFECYCLE_CONFLICT', message, 409, { lifecycle: row.lifecycle })

  function record(row) {
    if (!row) return null
    // body_json is the canonical serialization; verify it as stored so a later
    // validation change cannot rewrite what an old Run was bound to.
    if (digest(row.body_json) !== row.hash) fail('STORE_CORRUPT', 'Saved profile revision does not match its hash', 500)
    let body
    try { body = JSON.parse(row.body_json) } catch { fail('STORE_CORRUPT', 'Saved profile revision is unreadable; database was not reset', 500) }
    return { profileId: row.profile_id, revision: row.revision, parentRevision: row.parent_revision, hash: row.hash, author: row.author, createdAt: row.created_at, body }
  }
  const summaryOf = row => ({ profileId: row.profile_id, revision: row.revision, parentRevision: row.parent_revision, hash: row.hash, author: row.author, createdAt: row.created_at })
  function requireProfile(id) {
    const row = q.profile.get(profileId(id), owner)
    if (!row) fail('PROFILE_NOT_FOUND', 'Profile does not exist', 404)
    return row
  }
  function revisionOf(row, revision) {
    const found = record(q.revision.get(row.id, revisionNumber(revision)))
    if (!found) fail('PROFILE_REVISION_NOT_FOUND', 'Profile revision does not exist', 404)
    return found
  }
  function view(row) {
    const head = record(q.head.get(row.id))
    if (!head) fail('STORE_CORRUPT', 'Saved profile has no revisions; database was not reset', 500)
    const active = row.active_revision === null ? null : record(q.revision.get(row.id, row.active_revision))
    return {
      id: row.id, lifecycle: row.lifecycle, origin: row.origin,
      activeRevision: row.active_revision, headRevision: head.revision,
      hasDraft: head.revision !== row.active_revision,
      createdAt: row.created_at, updatedAt: row.updated_at, active, head,
    }
  }
  function summary(row) {
    const shown = view(row)
    const body = (shown.active ?? shown.head).body
    return {
      id: shown.id, lifecycle: shown.lifecycle, origin: shown.origin,
      activeRevision: shown.activeRevision, headRevision: shown.headRevision, hasDraft: shown.hasDraft,
      name: body.name, role: body.role, avatar: body.avatar,
      createdAt: shown.createdAt, updatedAt: shown.updatedAt,
    }
  }
  function saved(row, revision, hash, unchanged) {
    return { id: row.id, revision, hash, unchanged, profile: view(q.profile.get(row.id, owner)) }
  }
  function transition(id, action) {
    if (!LIFECYCLE_ACTIONS.includes(action)) fail('INVALID_PROFILE_ACTION', 'Lifecycle action must be disable, archive, restore or delete')
    return tx(() => {
      const row = requireProfile(id)
      const target = action === 'disable' ? 'disabled' : action === 'archive' ? 'archived' : action === 'delete' ? 'deleted'
        : row.active_revision === null ? 'draft' : 'active'
      if (row.lifecycle === target || (action === 'restore' && ['draft', 'active'].includes(row.lifecycle))) return view(row)
      if (row.lifecycle === 'deleted') lifecycleConflict('A deleted profile cannot change', row)
      if (action === 'disable' && row.lifecycle !== 'active') lifecycleConflict('Only an active profile can be disabled', row)
      q.touch.run(target, row.active_revision, Math.max(now(), row.updated_at), row.id, owner)
      return view(q.profile.get(row.id, owner))
    })
  }

  return {
    ownerHash: owner,
    list({ includeArchived = false } = {}) {
      ensureOpen()
      if (typeof includeArchived !== 'boolean') fail('INVALID_PROFILE_QUERY', 'includeArchived must be boolean')
      const rows = db.prepare(`SELECT * FROM profiles WHERE owner_hash=? AND lifecycle NOT IN (${includeArchived ? "'deleted'" : "'deleted','archived'"}) ORDER BY created_at, rowid LIMIT ?`).all(owner, MAX_PROFILE_ROWS)
      return { profiles: rows.map(summary) }
    },
    get(id) { ensureOpen(); const row = q.profile.get(profileId(id), owner); return row ? view(row) : null },
    getRevision(id, revision) { ensureOpen(); return revisionOf(requireProfile(id), revision) },
    revisions(id) {
      ensureOpen(); const row = requireProfile(id)
      return { profileId: row.id, revisions: db.prepare('SELECT * FROM profile_revisions WHERE profile_id=? ORDER BY revision DESC LIMIT ?').all(row.id, MAX_REVISIONS).map(summaryOf) }
    },
    createDraft(body) {
      ensureOpen()
      const normalized = normalizeProfileBody(body)
      const json = JSON.stringify(normalized), hash = digest(json)
      return tx(() => {
        if (db.prepare("SELECT COUNT(*) AS n FROM profiles WHERE owner_hash=? AND lifecycle<>'deleted'").get(owner).n >= MAX_PROFILES ||
            db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n >= MAX_PROFILE_ROWS) fail('PROFILE_LIMIT', `At most ${MAX_PROFILES} profiles can be kept`, 409)
        const id = `prof-${randomUUID()}`, ts = now()
        q.insertProfile.run(id, owner, null, 'draft', 'user', ts, ts)
        q.insertRevision.run(id, 1, null, hash, 'user', json, ts)
        return saved({ id }, 1, hash, false)
      })
    },
    saveDraft(id, body, expectedRevision) {
      ensureOpen()
      const expected = revisionNumber(expectedRevision, 'expectedRevision')
      const normalized = normalizeProfileBody(body)
      const json = JSON.stringify(normalized), hash = digest(json)
      return tx(() => {
        const row = requireProfile(id)
        if (!['draft', 'active', 'disabled'].includes(row.lifecycle)) lifecycleConflict('Restore this profile before editing it', row)
        const head = q.head.get(row.id)
        if (head.revision !== expected) {
          // A retried save of the same edit returns the revision it already made.
          if (head.parent_revision === expected && head.hash === hash && head.author === 'user') return saved(row, head.revision, hash, true)
          conflict('Profile changed since this edit started', row, head)
        }
        if (head.hash === hash) return saved(row, head.revision, hash, true)
        if (head.revision >= MAX_REVISIONS) fail('PROFILE_REVISION_LIMIT', `A profile keeps at most ${MAX_REVISIONS} revisions`, 409)
        const ts = Math.max(now(), row.updated_at)
        q.insertRevision.run(row.id, head.revision + 1, head.revision, hash, 'user', json, ts)
        q.touch.run(row.lifecycle, row.active_revision, ts, row.id, owner)
        return saved(row, head.revision + 1, hash, false)
      })
    },
    activate(id, revision, expectedActiveRevision) {
      ensureOpen()
      const target = revisionNumber(revision)
      if (expectedActiveRevision !== null) revisionNumber(expectedActiveRevision, 'expectedActiveRevision')
      return tx(() => {
        const row = requireProfile(id)
        if (row.active_revision === target && row.lifecycle === 'active') return view(row)
        if (!['draft', 'active', 'disabled'].includes(row.lifecycle)) lifecycleConflict('Restore this profile before activating it', row)
        if (row.active_revision !== expectedActiveRevision) conflict('Active revision changed since this view was loaded', row, q.head.get(row.id))
        revisionOf(row, target)
        q.touch.run('active', target, Math.max(now(), row.updated_at), row.id, owner)
        return view(q.profile.get(row.id, owner))
      })
    },
    lifecycle(id, action) { ensureOpen(); return transition(id, action) },
    disable(id) { ensureOpen(); return transition(id, 'disable') },
    archive(id) { ensureOpen(); return transition(id, 'archive') },
    restore(id) { ensureOpen(); return transition(id, 'restore') },
    delete(id) { ensureOpen(); return transition(id, 'delete') },
    diff(id, fromRevision, toRevision) {
      ensureOpen(); const row = requireProfile(id)
      const from = revisionOf(row, fromRevision), to = revisionOf(row, toRevision)
      return { profileId: row.id, from: from.revision, to: to.revision, changes: diffProfileBodies(from.body, to.body) }
    },
    /** What a Run needs: composed instructions plus the binding to record. */
    runProfile(id, revision) {
      ensureOpen(); const row = requireProfile(id)
      if (row.lifecycle !== 'active' || row.active_revision === null) fail('PROFILE_NOT_RUNNABLE', 'Profile is not active', 409, { lifecycle: row.lifecycle })
      const chosen = revisionOf(row, revision === undefined ? row.active_revision : revision)
      return {
        binding: profileBinding({ id: row.id }, chosen),
        developerInstructions: composeDeveloperInstructions(chosen.body),
        model: chosen.body.model,
      }
    },
    /** First run only: insert example templates as active. Never re-seeds after deletion. */
    seedTemplates(templates = PROFILE_TEMPLATES) {
      ensureOpen()
      if (!Array.isArray(templates) || templates.length > 20) fail('INVALID_PROFILE', 'Templates must be a list of at most 20 items')
      const prepared = templates.map(item => {
        shape(item, ['id', 'body'], 'template')
        if (profileId(item.id).startsWith('prof-')) fail('INVALID_PROFILE_ID', 'Template IDs cannot use the user profile prefix')
        const json = JSON.stringify(normalizeProfileBody(item.body))
        return { id: item.id, json, hash: digest(json) }
      })
      if (new Set(prepared.map(item => item.id)).size !== prepared.length) fail('INVALID_PROFILE', 'Template IDs must be unique')
      return tx(() => {
        if (db.prepare("SELECT value FROM store_meta WHERE name='templates_seeded'").get()) return { seeded: [], alreadySeeded: true }
        const ts = now(), seeded = []
        for (const item of prepared) {
          if (db.prepare('SELECT 1 FROM profiles WHERE id=?').get(item.id)) continue
          q.insertProfile.run(item.id, owner, null, 'active', 'template', ts, ts)
          q.insertRevision.run(item.id, 1, null, item.hash, 'template', item.json, ts)
          q.touch.run('active', 1, ts, item.id, owner)
          seeded.push(item.id)
        }
        db.prepare("INSERT INTO store_meta VALUES ('templates_seeded', ?)").run(String(ts))
        return { seeded, alreadySeeded: false }
      })
    },
    close() { if (!closed) { db.close(); closed = true } },
  }
}
