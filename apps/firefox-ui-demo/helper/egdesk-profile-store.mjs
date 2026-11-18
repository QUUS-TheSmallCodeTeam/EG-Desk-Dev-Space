import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { crc32, inflateSync } from 'node:zlib'
import { DEFAULT_ENGINE_PROFILE_IDS, PROFILE_ENGINES } from './egdesk-engine-profiles.mjs'
import { isOwnedAndPrivate } from './egdesk-private-files.mjs'

// Local Agent Profile store. A profile has a stable ID and an append-only
// chain of revisions; Runs bind to {profileId, revision, hash}. Public body
// keys are fixed so no stored object key is model- or user-chosen.
//
// Schema versions (PRAGMA user_version). Older files are upgraded in place by
// MIGRATIONS, one numbered step after another inside the opening write
// transaction (ordered-sequence pattern from tldraw store/src/lib/migrate.ts,
// pattern only; ADD COLUMN steps as in openai/codex state/migrations, Apache-2.0):
//   1  profiles, profile_revisions (immutable, kept), store_meta
//   2  profiles.source_json — where a profile came from, append-only
//      (the `source` rule of kwaroran/character-card-spec-v3 SPEC_V3.md, MIT)
//   3  profile_assets — avatar photos by content id (D-A3); bodies keep only
//      the id, never image bytes or a data URL (paperclip customAvatarAssetId, pattern only)
const VERSION = 3
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
const BODY_KEYS = ['name', 'avatar', 'role', 'personality', 'expertise', 'instructions', 'toolPreferences', 'model', 'toolCeiling']
// AGENT-04: the most an Agent may do per tool kind. Values run narrowest
// first; `open` is today's behavior and fills an axis the input leaves out.
// A profile without a ceiling (null) keeps today's behavior on every axis.
export const TOOL_CEILING_AXES = Object.freeze([
  Object.freeze({ axis: 'browser', values: Object.freeze(['none', 'observe', 'interact']), open: 'interact' }),
  Object.freeze({ axis: 'files', values: Object.freeze(['read', 'write']), open: 'write' }),
  Object.freeze({ axis: 'terminal', values: Object.freeze(['none', 'ask', 'allow']), open: 'ask' }),
  Object.freeze({ axis: 'network', values: Object.freeze(['off', 'on']), open: 'on' }),
  Object.freeze({ axis: 'mcp', values: Object.freeze(['none', 'inherited']), open: 'inherited' }),
])
const CEILING_KEYS = TOOL_CEILING_AXES.map(item => item.axis)
// AGENT-02·06: "이렇게 말한다" example exchanges and "하지 말 것" rules, kept
// apart from the free-form instructions (character-card-spec-v3 mes_example,
// awesome-openclaw-agents SOUL.md "Don't" / "Example Interactions"). With
// every other field at its cap the composed text still fits MAX_COMPOSED.
export const PERSONALITY_LIMITS = Object.freeze({ examples: 3, exampleUser: 100, exampleReply: 280, avoid: 8, avoidItem: 80 })
// AGENT-04·D-A1: named ceilings a new Agent can start from. Only createDraft
// reads them and only to fill a missing toolCeiling, so nothing already saved
// changes (create-time default, never backfilled: paperclip
// server/src/lib/agent-permissions.ts:60-76, pattern only). D-A1 is still
// open: the default stays 'open' (no ceiling, today's behaviour) unless the
// store is opened with another defaultToolPreset.
const preset = (id, label, description, toolCeiling) => Object.freeze({ id, label, description, toolCeiling: toolCeiling && Object.freeze(toolCeiling) })
export const TOOL_CEILING_PRESETS = Object.freeze([
  preset('read-only', '읽기만', '파일과 브라우저를 보기만 한다. 명령·인터넷·외부 도구는 쓰지 않는다.', { browser: 'observe', files: 'read', terminal: 'none', network: 'off', mcp: 'none' }),
  preset('research', '리서치', '인터넷과 브라우저로 찾아보고 읽기만 한다. 파일을 고치거나 명령을 실행하지 않는다.', { browser: 'observe', files: 'read', terminal: 'none', network: 'on', mcp: 'none' }),
  preset('writing', '문서 작업', '자료를 찾아보고 파일을 만들거나 고친다. 명령은 실행하지 않는다.', { browser: 'observe', files: 'write', terminal: 'none', network: 'on', mcp: 'none' }),
  preset('coding', '코딩', '파일을 만들고 고치며, 터미널 명령은 매번 묻는다.', { browser: 'observe', files: 'write', terminal: 'ask', network: 'on', mcp: 'inherited' }),
  preset('open', '제한 없음', '지금과 같다. 이 Agent만 따로 막지 않는다.', null),
])
export const DEFAULT_TOOL_PRESET = 'open'
function toolPreset(id, name = 'toolPreset') {
  const found = TOOL_CEILING_PRESETS.find(item => item.id === id)
  if (!found) fail('INVALID_PROFILE', `${name} must be one of ${TOOL_CEILING_PRESETS.map(item => item.id).join(', ')}`)
  return found
}
// D-A3 avatar photos. Size cap and plain-base64 rule from paperclipai/paperclip
// packages/shared/src/agent-avatar-upload.ts:3-9 (MIT License, Copyright (c)
// 2025 Paperclip AI). The helper has no image codec, so a photo is not
// re-encoded: its container is read chunk by chunk and written again with only
// the parts that draw the picture (no EXIF/XMP/text/thumbnail, nothing after
// the end marker), and PNG pixel data is inflated to its exact expected size.
export const AVATAR_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp'])
export const MAX_AVATAR_IMAGE_BYTES = 512 * 1024
export const MAX_AVATAR_IMAGE_SIDE = 2048
export const MAX_AVATAR_IMAGES = 200
const AVATAR_IMAGE_GRACE_MS = 10 * 60 * 1000 // An upload not yet saved in any revision is kept at least this long.
const AVATAR_ASSET_ID = /^img-[0-9a-f]{64}$/
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
// Provenance chain carried by a copy: the newest entries win.
export const MAX_SOURCE_ENTRIES = 8
// 'egdesk' = an .egdesk bundle; 'md' = one Agent file (egdesk-profile-file.mjs).
const IMPORT_FORMATS = ['egdesk', 'md']
const IMPORT_FLAVORS = ['egdesk', 'agency-agents', 'claude-code']
const COPY_SUFFIX = ' 사본'
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
  const image = value?.kind === 'image'
  // A photo is named by its asset id; `value` is the initial drawn when the photo cannot be.
  shape(value, image ? ['kind', 'value', 'color', 'assetId'] : ['kind', 'value', 'color'], 'avatar')
  if (!['emoji', 'initial', 'image'].includes(value.kind)) fail('INVALID_PROFILE', 'avatar.kind must be emoji, initial or image')
  if (typeof value.value !== 'string') fail('INVALID_PROFILE', 'avatar.value must be text')
  const text = value.value.normalize('NFC').trim()
  if (value.kind === 'emoji') {
    const parts = [...graphemes.segment(text)]
    // One pictographic grapheme (ZWJ sequences and flags included).
    if (parts.length !== 1 || text.length > 32 || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text)) fail('INVALID_PROFILE', 'avatar.value must be exactly one emoji')
  } else if (!/^[\p{L}\p{N}]{1,2}$/u.test(text)) fail('INVALID_PROFILE', 'avatar.value must be 1–2 letters or digits')
  const color = value.color === undefined ? AVATAR_PALETTE[0] : typeof value.color === 'string' ? value.color.toLowerCase() : null
  if (!AVATAR_PALETTE.includes(color)) fail('INVALID_PROFILE', 'avatar.color must be one of the approved palette colors')
  if (!image) return { kind: value.kind, value: text, color }
  if (typeof value.assetId !== 'string' || !AVATAR_ASSET_ID.test(value.assetId)) fail('INVALID_PROFILE', 'avatar.assetId must name an uploaded avatar image')
  return { kind: 'image', value: text, color, assetId: value.assetId }
}
function examples(value) {
  const { examples: max, exampleUser, exampleReply } = PERSONALITY_LIMITS
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > max) fail('INVALID_PROFILE', `personality.examples must be a list of at most ${max} items`)
  const pairs = new Map() // Keep first-seen order; a repeated pair carries no meaning.
  for (const item of value) {
    shape(item, ['user', 'reply'], 'personality.examples item')
    const pair = { user: line(item.user, 'personality.examples user', { min: 1, max: exampleUser }), reply: block(item.reply, 'personality.examples reply', exampleReply) }
    if (!pair.reply) fail('INVALID_PROFILE', 'personality.examples reply is required')
    const key = JSON.stringify(pair)
    if (!pairs.has(key)) pairs.set(key, pair)
  }
  return [...pairs.values()]
}
function personality(value) {
  if (value === undefined || value === null) value = {}
  shape(value, ['tone', 'traits', 'speechNotes', 'examples', 'avoid'], 'personality')
  const tone = value.tone === undefined || value.tone === null ? 'plain' : value.tone
  if (!PROFILE_TONES.includes(tone)) fail('INVALID_PROFILE', 'personality.tone is not supported')
  const result = {
    tone,
    traits: list(value.traits, 'personality.traits', { max: 6, itemMax: 40 }),
    speechNotes: block(value.speechNotes, 'personality.speechNotes', 500),
  }
  const shown = examples(value.examples)
  const avoid = list(value.avoid, 'personality.avoid', { max: PERSONALITY_LIMITS.avoid, itemMax: PERSONALITY_LIMITS.avoidItem })
  // Empty lists are left out, so a body saved before these fields keeps its bytes and hash.
  if (shown.length) result.examples = shown
  if (avoid.length) result.avoid = avoid
  return result
}
function model(value) {
  if (value === undefined || value === null) return null
  shape(value, ['engine', 'modelId', 'effort', 'engineProfileId'], 'model')
  const { engine, engineProfileId } = value
  if (!PROFILE_ENGINES.includes(engine)) fail('INVALID_PROFILE', 'model.engine must be codex or claude')
  // AGENT-08: modelId null keeps the engine's own default model; the engine still decides who answers.
  const modelId = value.modelId === undefined ? null : value.modelId
  if (modelId !== null && (typeof modelId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(modelId))) fail('INVALID_PROFILE', 'model.modelId is invalid')
  const effort = value.effort === undefined ? null : value.effort
  if (effort !== null && !REASONING_EFFORTS.has(effort)) fail('INVALID_PROFILE', 'model.effort is not supported')
  if (effort !== null && modelId === null) fail('INVALID_PROFILE', 'model.effort needs a model.modelId')
  // Store only a slot ID, never its directory or credentials. Match the owned
  // ID format in egdesk-engine-profiles; availability is checked at runtime.
  if (engineProfileId !== undefined) {
    const prefix = engine + '-'
    if (typeof engineProfileId !== 'string' || (engineProfileId !== DEFAULT_ENGINE_PROFILE_IDS[engine] &&
      (!engineProfileId.startsWith(prefix) || !/^[a-z0-9]{8,32}$/.test(engineProfileId.slice(prefix.length))))) {
      fail('INVALID_PROFILE', 'model.engineProfileId must be an engine profile ID for model.engine')
    }
  }
  // Omission keeps the canonical JSON and hashes of existing revisions.
  return { engine, modelId, effort, ...(engineProfileId === undefined ? {} : { engineProfileId }) }
}
/** Fixed five keys in fixed order, or null for no ceiling. */
export function normalizeToolCeiling(value) {
  if (value === undefined || value === null) return null
  shape(value, CEILING_KEYS, 'toolCeiling')
  const ceiling = {}
  for (const { axis, values, open } of TOOL_CEILING_AXES) {
    const chosen = value[axis] === undefined || value[axis] === null ? open : value[axis]
    if (!values.includes(chosen)) fail('INVALID_PROFILE', `toolCeiling.${axis} must be one of ${values.join(', ')}`)
    ceiling[axis] = chosen
  }
  return ceiling
}

/** Canonical public body: fixed keys in fixed order, so equal input gives equal JSON and hash. */
export function normalizeProfileBody(input) {
  shape(input, BODY_KEYS, 'profile body')
  const body = {
    name: line(input.name, 'name', { min: 1, max: 40 }),
    avatar: avatar(input.avatar),
    role: line(input.role, 'role', { max: 80 }),
    personality: personality(input.personality),
    expertise: list(input.expertise, 'expertise', { max: 8, itemMax: 80 }),
    instructions: block(input.instructions, 'instructions', 8000),
    toolPreferences: list(input.toolPreferences, 'toolPreferences', { max: 20, itemMax: 64, pattern: /^[A-Za-z0-9_.:-]+$/ }),
    model: model(input.model),
  }
  // No ceiling keeps the bytes (and hash) a body had before AGENT-04, so an
  // older revision re-saved unchanged is still "unchanged".
  const toolCeiling = normalizeToolCeiling(input.toolCeiling)
  return toolCeiling ? { ...body, toolCeiling } : body
}
export const profileHash = body => digest(JSON.stringify(normalizeProfileBody(body)))
/** The same body with a photo avatar written as its initial: photos never leave this install (D-A3). */
export function withoutAvatarImage(body) {
  if (body?.avatar?.kind !== 'image') return body
  const { value, color } = body.avatar
  return { ...body, avatar: { kind: 'initial', value, color } }
}

/** A normalized body for another install: no image or local engine-slot binding. */
export function portableProfileBody(body) {
  const portable = withoutAvatarImage(body)
  if (!portable.model || !Object.hasOwn(portable.model, 'engineProfileId')) return portable
  const { engineProfileId, ...model } = portable.model
  return { ...portable, model }
}

const TONE_DIRECTIVES = {
  plain: '꾸밈 없이 평이한 말투로 답한다.',
  warm: '따뜻하고 친절한 말투로 답하되 내용은 정확하게 유지한다.',
  concise: '핵심부터 짧고 간결하게 답한다.',
  formal: '격식 있는 존댓말로 정중하게 답한다.',
  playful: '가볍고 유쾌한 말투로 답하되 사실과 판단은 흐리지 않는다.',
}
// Only narrowed axes are named; EG-Desk also enforces them at run time.
const CEILING_DIRECTIVES = {
  browser: { none: '브라우저는 쓰지 않는다.', observe: '브라우저는 보기만 하고 클릭·입력·이동은 하지 않는다.' },
  files: { read: '파일은 읽기만 하고 만들거나 고치지 않는다.' },
  terminal: { none: '터미널 명령은 실행하지 않는다.' },
  network: { off: '인터넷에 연결하지 않는다.' },
  mcp: { none: '연결된 외부 도구(MCP)는 쓰지 않는다.' },
}
const EXAMPLE_NOTICE = '아래 대화는 말투와 답하는 모양만 보여 주는 예시다. 예시에 나온 내용을 사실로 삼거나 그대로 되풀이하지 않는다.'
/**
 * Deterministic developer instructions: identity → tone (+ examples) → work
 * (+ what not to do) → tool limits → user instructions. A body without
 * examples or avoid composes exactly what it did before those fields existed.
 */
export function composeDeveloperInstructions(input) {
  const body = normalizeProfileBody(input)
  const { tone, traits, speechNotes, examples: shown = [], avoid = [] } = body.personality
  const limits = body.toolCeiling ? CEILING_KEYS.map(axis => CEILING_DIRECTIVES[axis][body.toolCeiling[axis]]).filter(Boolean) : []
  const sections = [
    ['아래는 사용자가 EG-Desk에서 정한 담당자 설정이다. 이 설정에 맞춰 일한다.'],
    ['# 담당자', `이름: ${body.name}`, body.role && `역할: ${body.role}`],
    ['# 말투와 성격', TONE_DIRECTIVES[tone], traits.length && `성격: ${traits.join(', ')}`, speechNotes && `말하기 메모:\n${speechNotes}`],
    shown.length && ['# 말투 예시', EXAMPLE_NOTICE, ...shown.map((pair, index) => `예시 ${index + 1}\n사용자: ${pair.user}\n${body.name}: ${pair.reply}`)],
    body.expertise.length && ['# 맡길 일', ...body.expertise.map(item => `- ${item}`)],
    avoid.length && ['# 하지 말 것', ...avoid.map(item => `- ${item}`)],
    limits.length && ['# 쓸 수 있는 도구', ...limits.map(item => `- ${item}`)],
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
  ['personality.speechNotes', body => body.personality.speechNotes],
  ['personality.examples', body => body.personality.examples ?? []], ['personality.avoid', body => body.personality.avoid ?? []],
  ['expertise', body => body.expertise],
  ['instructions', body => body.instructions], ['toolPreferences', body => body.toolPreferences], ['model', body => body.model],
  ['toolCeiling', body => body.toolCeiling ?? null],
]
/** Field-level changes as an array of fixed-key records. */
export function diffProfileBodies(fromBody, toBody) {
  const before = normalizeProfileBody(fromBody), after = normalizeProfileBody(toBody)
  const changes = []
  const missingFrom = (items, others) => { const keys = new Set(others.map(item => JSON.stringify(item))); return items.filter(item => !keys.has(JSON.stringify(item))) }
  for (const [field, read] of DIFF_FIELDS) {
    const a = read(before), b = read(after)
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    // List items compare by value, so example pairs diff like plain strings.
    changes.push(Array.isArray(a)
      ? { field, before: a, after: b, added: missingFrom(b, a), removed: missingFrom(a, b) }
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
/** "리오" → "리오 사본", shortening the name (whole graphemes) so it stays within 40 characters. */
export function copyName(name) {
  const room = 40 - chars(COPY_SUFFIX)
  let base = ''
  for (const { segment } of graphemes.segment(String(name ?? '').normalize('NFC').trim())) {
    if (chars(base + segment) > room) break
    base += segment
  }
  return `${base.trim()}${COPY_SUFFIX}`.trim()
}

// ---- Avatar photos (D-A3): check the container, keep only what draws the picture ----
const imageFail = message => fail('INVALID_PROFILE_IMAGE', message)
function imageSide(width, height) {
  if (!(width >= 1 && height >= 1 && width <= MAX_AVATAR_IMAGE_SIDE && height <= MAX_AVATAR_IMAGE_SIDE)) imageFail(`Image must be 1–${MAX_AVATAR_IMAGE_SIDE} pixels on each side`)
}
const startsWithText = (data, text) => data.length >= text.length && data.toString('latin1', 0, text.length) === text

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// Chunks that draw or colour the picture. Text, EXIF, time and other ancillary chunks are dropped.
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs'])
const PNG_DEPTHS = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]])
const PNG_CHANNELS = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]])
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
/** Scanline runs of the inflated image data: one run, or seven Adam7 passes (empty passes have no bytes). */
function pngPasses({ width, height, interlace, bitsPerPixel }) {
  return (interlace ? ADAM7 : [[0, 0, 1, 1]])
    .map(([x, y, dx, dy]) => ({ columns: width > x ? Math.ceil((width - x) / dx) : 0, rows: height > y ? Math.ceil((height - y) / dy) : 0 }))
    .filter(pass => pass.columns && pass.rows)
    .map(pass => ({ rows: pass.rows, rowBytes: 1 + Math.ceil(pass.columns * bitsPerPixel / 8) }))
}
function cleanPng(input) {
  const kept = [PNG_SIGNATURE], idat = []
  let offset = PNG_SIGNATURE.length, header = null, palette = false, idatClosed = false, ended = false
  while (!ended) {
    if (offset + 12 > input.length) imageFail('PNG ends before its last chunk')
    const length = input.readUInt32BE(offset), type = input.toString('latin1', offset + 4, offset + 8)
    if (!/^[A-Za-z]{4}$/.test(type) || length > input.length - offset - 12) imageFail('PNG chunk is damaged')
    const dataEnd = offset + 8 + length
    if (crc32(input.subarray(offset + 4, dataEnd)) !== input.readUInt32BE(dataEnd)) imageFail('PNG chunk checksum does not match')
    const data = input.subarray(offset + 8, dataEnd)
    if (!header && type !== 'IHDR') imageFail('PNG must start with its header chunk')
    if (type === 'IHDR') {
      if (header || length !== 13) imageFail('PNG header is damaged')
      const [depth, colorType, compression, filter, interlace] = data.subarray(8)
      if (!PNG_DEPTHS.get(colorType)?.includes(depth) || compression !== 0 || filter !== 0 || interlace > 1) imageFail('PNG header is not supported')
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), colorType, interlace, bitsPerPixel: depth * PNG_CHANNELS.get(colorType) }
      imageSide(header.width, header.height)
    } else if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') imageFail('Moving images cannot be used as an avatar')
    else if (type === 'IDAT') {
      if (idatClosed) imageFail('PNG image data must be in one run')
      idat.push(data)
    } else {
      if (idat.length) idatClosed = true
      if (type === 'PLTE') {
        if (idat.length || palette || !length || length % 3 || length > 768) imageFail('PNG palette is damaged')
        palette = true
      }
      ended = type === 'IEND'
    }
    if (PNG_KEEP.has(type)) kept.push(input.subarray(offset, dataEnd + 4))
    else if (type.charCodeAt(0) < 0x61) imageFail('PNG has a required part EG-Desk cannot read') // Upper-case first letter: critical chunk.
    offset = dataEnd + 4
  }
  if (!idat.length || (header.colorType === 3 && !palette)) imageFail('PNG has no image data')
  const passes = pngPasses(header)
  const expected = passes.reduce((sum, pass) => sum + pass.rows * pass.rowBytes, 0)
  let raw
  try { raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 }) } catch { imageFail('PNG image data is damaged') }
  if (raw.length !== expected) imageFail('PNG image data does not match its size')
  let at = 0
  for (const { rows, rowBytes } of passes) {
    for (let row = 0; row < rows; row++, at += rowBytes) if (raw[at] > 4) imageFail('PNG image data is damaged')
  }
  return { mediaType: 'image/png', bytes: Buffer.concat(kept), width: header.width, height: header.height }
}

// Baseline, extended and progressive Huffman frames: the ones every browser draws.
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2])
const JPEG_TABLES = new Set([0xc4, 0xdb, 0xdd]) // Huffman tables, quantization tables, restart interval.
/** EXIF orientation (tag 0x0112) from a TIFF block; everything else in EXIF (place, camera, time) is dropped. */
function exifOrientation(tiff) {
  try {
    const order = tiff.toString('latin1', 0, 2)
    if (order !== 'II' && order !== 'MM') return 1
    const u16 = at => order === 'II' ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at)
    const u32 = at => order === 'II' ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at)
    if (u16(2) !== 42) return 1
    const ifd = u32(4)
    for (let index = 0, count = Math.min(u16(ifd), 512); index < count; index++) {
      const entry = ifd + 2 + index * 12
      if (u16(entry) === 0x0112 && u16(entry + 2) === 3 && u32(entry + 4) === 1) {
        const value = u16(entry + 8)
        return value >= 1 && value <= 8 ? value : 1
      }
    }
  } catch { /* A damaged EXIF block only loses its orientation. */ }
  return 1
}
/** A 36-byte APP1 holding only the orientation, so a phone photo still stands the right way up. */
function orientationSegment(orientation) {
  const segment = Buffer.alloc(36)
  segment.writeUInt16BE(0xffe1, 0)
  segment.writeUInt16BE(34, 2)
  segment.write('Exif\0\0MM', 4, 'latin1')
  segment.writeUInt16BE(42, 12)
  segment.writeUInt32BE(8, 14) // IFD0 right after the TIFF header
  segment.writeUInt16BE(1, 18) // one entry
  segment.writeUInt16BE(0x0112, 20)
  segment.writeUInt16BE(3, 22) // SHORT
  segment.writeUInt32BE(1, 24)
  segment.writeUInt16BE(orientation, 28) // bytes 32-35 stay 0: no next IFD
  return segment
}
function cleanJpeg(input) {
  const parts = []
  let offset = 2, frame = null, scans = 0, orientation = 1, jfif = null
  for (;;) {
    if (offset + 2 > input.length || input[offset] !== 0xff) imageFail('JPEG is damaged')
    while (input[offset + 1] === 0xff) offset++ // fill bytes before a marker
    const marker = input[offset + 1]
    offset += 2
    if (marker === 0xd9) break
    if (marker === undefined || offset + 2 > input.length) imageFail('JPEG is damaged')
    const length = input.readUInt16BE(offset)
    if (length < 2 || offset + length > input.length) imageFail('JPEG is damaged')
    const segment = input.subarray(offset - 2, offset + length), payload = input.subarray(offset + 2, offset + length)
    offset += length
    if (marker === 0xe0 && !jfif && payload.length >= 14 && startsWithText(payload, 'JFIF\0')) {
      // JFIF header kept, its embedded thumbnail dropped (thumbnail size 0×0).
      jfif = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), payload.subarray(0, 12), Buffer.from([0, 0])])
    } else if (marker === 0xe1 && startsWithText(payload, 'Exif\0\0')) orientation = exifOrientation(payload.subarray(6))
    else if ((marker === 0xe2 && startsWithText(payload, 'ICC_PROFILE\0')) || (marker === 0xee && startsWithText(payload, 'Adobe'))) parts.push(segment)
    else if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) { /* Other application blocks and comments are dropped. */ }
    else if (JPEG_FRAMES.has(marker)) {
      const components = payload[5]
      if (frame || payload[0] !== 8 || ![1, 3, 4].includes(components) || payload.length !== 6 + 3 * components) imageFail('JPEG frame is not supported')
      frame = { height: payload.readUInt16BE(1), width: payload.readUInt16BE(3) }
      imageSide(frame.width, frame.height)
      parts.push(segment)
    } else if (JPEG_TABLES.has(marker)) parts.push(segment)
    else if (marker === 0xda) {
      if (!frame) imageFail('JPEG picture data comes before its frame')
      let end = offset
      // Entropy-coded data runs to the next marker; FF00 is a stuffed byte and FFD0–FFD7 are restart markers.
      while (end < input.length && !(input[end] === 0xff && end + 1 < input.length && input[end + 1] !== 0x00 && (input[end + 1] < 0xd0 || input[end + 1] > 0xd7))) end++
      parts.push(segment, input.subarray(offset, end))
      offset = end
      scans++
    } else imageFail('JPEG uses a part EG-Desk cannot read')
  }
  if (!frame || !scans) imageFail('JPEG has no image data')
  const head = [Buffer.from([0xff, 0xd8]), ...(jfif ? [jfif] : []), ...(orientation === 1 ? [] : [orientationSegment(orientation)])]
  return { mediaType: 'image/jpeg', bytes: Buffer.concat([...head, ...parts, Buffer.from([0xff, 0xd9])]), width: frame.width, height: frame.height }
}

function webpPicture({ fourcc, data }) {
  if (fourcc === 'VP8 ') {
    // Key frame tag, then start code 9D 01 2A, then 14-bit width and height.
    if (data.length < 10 || (data[0] & 1) !== 0 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) imageFail('WebP picture is damaged')
    return { width: data.readUInt16LE(6) & 0x3fff, height: data.readUInt16LE(8) & 0x3fff }
  }
  if (data.length < 5 || data[0] !== 0x2f) imageFail('WebP picture is damaged')
  const bits = data.readUInt32LE(1)
  if (bits >>> 29 !== 0) imageFail('WebP picture is damaged')
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
}
function webpChunk(fourcc, data) {
  const header = Buffer.alloc(8)
  header.write(fourcc, 0, 'latin1')
  header.writeUInt32LE(data.length, 4)
  return Buffer.concat([header, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)])
}
function cleanWebp(input) {
  const end = 8 + input.readUInt32LE(4)
  if (end < 20 || end > input.length) imageFail('WebP is damaged')
  const chunks = []
  for (let offset = 12; offset < end;) {
    if (offset + 8 > end) imageFail('WebP is damaged')
    const fourcc = input.toString('latin1', offset, offset + 4), size = input.readUInt32LE(offset + 4)
    if (size > end - offset - 8) imageFail('WebP is damaged')
    chunks.push({ fourcc, data: input.subarray(offset + 8, offset + 8 + size) })
    offset += 8 + size + (size & 1)
  }
  const pictures = chunks.filter(chunk => chunk.fourcc === 'VP8 ' || chunk.fourcc === 'VP8L')
  if (chunks.some(chunk => chunk.fourcc === 'ANIM' || chunk.fourcc === 'ANMF')) imageFail('Moving images cannot be used as an avatar')
  if (pictures.length !== 1) imageFail('WebP must hold exactly one picture')
  const size = webpPicture(pictures[0])
  imageSide(size.width, size.height)
  let kept
  if (chunks[0].fourcc === 'VP8X') {
    const header = chunks[0].data
    if (header.length < 10 || header[0] & 0x02) imageFail('Moving images cannot be used as an avatar')
    if (1 + header.readUIntLE(4, 3) !== size.width || 1 + header.readUIntLE(7, 3) !== size.height) imageFail('WebP canvas does not match its picture')
    const icc = header[0] & 0x20 ? chunks.find(chunk => chunk.fourcc === 'ICCP') : null
    const alpha = chunks.find(chunk => chunk.fourcc === 'ALPH' && chunks.indexOf(chunk) < chunks.indexOf(pictures[0]))
    const flags = Buffer.from(header.subarray(0, 10))
    flags.fill(0, 0, 4)
    flags[0] = (header[0] & 0x10) | (icc ? 0x20 : 0) // keep alpha and colour profile; EXIF and XMP flags cleared
    kept = [webpChunk('VP8X', flags), ...(icc ? [webpChunk('ICCP', icc.data)] : []), ...(alpha ? [webpChunk('ALPH', alpha.data)] : []), webpChunk(pictures[0].fourcc, pictures[0].data)]
  } else if (chunks[0] === pictures[0]) kept = [webpChunk(pictures[0].fourcc, pictures[0].data)]
  else imageFail('WebP is damaged')
  const riff = Buffer.alloc(12)
  riff.write('RIFF', 0, 'latin1')
  riff.writeUInt32LE(4 + kept.reduce((sum, chunk) => sum + chunk.length, 0), 4)
  riff.write('WEBP', 8, 'latin1')
  return { mediaType: 'image/webp', bytes: Buffer.concat([riff, ...kept]), width: size.width, height: size.height }
}

/**
 * Checks one PNG/JPEG/WebP photo (≤ 512 KB, ≤ 2048 px a side, not moving) and
 * returns it written again without metadata → {mediaType, bytes, width, height}.
 * The type comes from the bytes; a declared mediaType must agree with them.
 */
export function sanitizeAvatarImage(input, declaredType) {
  const bytes = Buffer.isBuffer(input) ? input : input instanceof Uint8Array ? Buffer.from(input.buffer, input.byteOffset, input.byteLength) : null
  if (!bytes || !bytes.length) imageFail('Image is empty')
  if (bytes.length > MAX_AVATAR_IMAGE_BYTES) fail('PROFILE_IMAGE_TOO_LARGE', `Image must be at most ${MAX_AVATAR_IMAGE_BYTES / 1024} KB`, 413)
  const detected = bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) ? 'image/png'
    : bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'image/jpeg'
      : bytes.length >= 12 && startsWithText(bytes, 'RIFF') && bytes.toString('latin1', 8, 12) === 'WEBP' ? 'image/webp' : null
  if (!detected) imageFail('Only PNG, JPEG and WebP images can be used')
  if (declaredType !== undefined && declaredType !== detected) imageFail('Image type does not match its contents')
  return detected === 'image/png' ? cleanPng(bytes) : detected === 'image/jpeg' ? cleanJpeg(bytes) : cleanWebp(bytes)
}
function avatarUpload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'mediaType' && key !== 'imageBase64')) imageFail('Send {mediaType, imageBase64}')
  if (!AVATAR_IMAGE_TYPES.includes(input.mediaType)) imageFail(`mediaType must be one of ${AVATAR_IMAGE_TYPES.join(', ')}`)
  const text = input.imageBase64
  if (typeof text !== 'string' || text.length < 4) imageFail('imageBase64 must be base64 text')
  if (text.length > 4 * Math.ceil(MAX_AVATAR_IMAGE_BYTES / 3)) fail('PROFILE_IMAGE_TOO_LARGE', `Image must be at most ${MAX_AVATAR_IMAGE_BYTES / 1024} KB`, 413)
  if (!BASE64.test(text)) imageFail('imageBase64 must be plain base64, not a URL or data URL')
  return sanitizeAvatarImage(Buffer.from(text, 'base64'), input.mediaType)
}

// Version 1 exactly as it shipped; a new file is built as version 1 and then
// takes every step below, so new and upgraded files end with the same schema.
const SCHEMA_V1 = `
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
// Each step runs once, in order. Steps only add; nothing already saved is rewritten.
const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 2,
    // A JSON array of fixed-key entries. Rows written before version 2 start
    // empty. The trigger lets an update only extend the array, never shorten
    // or rewrite it (character-card-spec-v3: applications only append to `source`).
    sql: `
    ALTER TABLE profiles ADD COLUMN source_json TEXT NOT NULL DEFAULT '[]'
      CHECK (CASE WHEN json_valid(source_json) THEN json_type(source_json) = 'array' ELSE 0 END);
    CREATE TRIGGER profiles_source_append_only BEFORE UPDATE OF source_json ON profiles
      WHEN json_array_length(NEW.source_json) < json_array_length(OLD.source_json)
        OR substr(NEW.source_json, 1, length(OLD.source_json) - 1) IS NOT substr(OLD.source_json, 1, length(OLD.source_json) - 1)
      BEGIN SELECT RAISE(ABORT, 'profile source is append-only'); END;`,
  }),
  Object.freeze({
    version: 3,
    // Avatar photos already cleaned by sanitizeAvatarImage, named by the
    // sha256 of their bytes. Rows never change; one that any saved revision
    // names is kept for as long as that revision is.
    sql: `
    CREATE TABLE profile_assets (
      id TEXT PRIMARY KEY CHECK (length(id) = 68 AND substr(id, 1, 4) = 'img-'),
      owner_hash TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK (media_type IN ('image/png','image/jpeg','image/webp')),
      width INTEGER NOT NULL CHECK (width > 0), height INTEGER NOT NULL CHECK (height > 0),
      byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= ${MAX_AVATAR_IMAGE_BYTES}),
      bytes BLOB NOT NULL CHECK (typeof(bytes) = 'blob' AND length(bytes) = byte_size),
      created_at INTEGER NOT NULL
    );
    CREATE TRIGGER profile_assets_immutable BEFORE UPDATE ON profile_assets
      BEGIN SELECT RAISE(ABORT, 'profile assets are immutable'); END;
    CREATE TRIGGER profile_assets_in_use_kept BEFORE DELETE ON profile_assets
      WHEN EXISTS (SELECT 1 FROM profile_revisions WHERE json_extract(body_json, '$.avatar.assetId') = OLD.id)
      BEGIN SELECT RAISE(ABORT, 'profile assets in use are kept'); END;`,
  }),
])
// [first version that has it, table or trigger name]
const SCHEMA_OBJECTS = [
  [1, 'profiles'], [1, 'profile_revisions'], [1, 'store_meta'], [1, 'profile_revisions_immutable'], [1, 'profile_revisions_kept'],
  [2, 'profiles_source_append_only'],
  [3, 'profile_assets'], [3, 'profile_assets_immutable'], [3, 'profile_assets_in_use_kept'],
]
function requireSchema(db, version) {
  const found = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')").all().map(row => row.name))
  const columns = new Set(db.prepare('PRAGMA table_info(profiles)').all().map(row => row.name))
  if (SCHEMA_OBJECTS.some(([since, name]) => since <= version && !found.has(name)) || (version >= 2 && !columns.has('source_json'))) {
    fail('STORE_CORRUPT', 'Profile schema is incomplete; database was not reset', 500)
  }
}

function initialize(db) {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
  if (String(db.prepare('PRAGMA journal_mode=WAL').get().journal_mode).toLowerCase() !== 'wal') fail('STORE_OPEN_FAILED', 'WAL could not be enabled', 500)
  db.exec('PRAGMA synchronous=FULL;')
  if (db.prepare('PRAGMA synchronous').get().synchronous !== 2) fail('STORE_OPEN_FAILED', 'FULL durability could not be enabled', 500)
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('STORE_CORRUPT', 'Profile database failed integrity check; database was not reset', 500)
  const readVersion = () => {
    const version = db.prepare('PRAGMA user_version').get().user_version
    if (version > VERSION) fail('UNSUPPORTED_STORE_VERSION', 'Profile database was made by a newer EG-Desk; database was not reset', 500)
    return version
  }
  if (readVersion() < VERSION) {
    db.exec('BEGIN IMMEDIATE')
    try {
      // Read again under the write lock: another window may have upgraded the file meanwhile.
      let version = readVersion()
      if (version === 0) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").get()) fail('UNSUPPORTED_STORE_VERSION', 'Existing profile database has an unsupported schema; database was not reset', 500)
        db.exec(SCHEMA_V1)
        version = 1
      } else requireSchema(db, version) // Never build on a damaged older file.
      for (const step of MIGRATIONS) {
        if (step.version <= version) continue
        db.exec(step.sql)
        version = step.version
      }
      db.exec(`PRAGMA user_version=${VERSION}`)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* Preserve original failure; the file keeps its old version. */ }
      throw error
    }
  }
  requireSchema(db, VERSION)
}

/**
 * Synchronous local-only profile store for one owner scope (same file rules as the chat store).
 * defaultToolPreset: the TOOL_CEILING_PRESETS id createDraft uses when the caller names none
 * (D-A1 is undecided, so it stays 'open' = no ceiling unless Main changes it here).
 */
export function openProfileStore({ dataDir, ownerHash, defaultToolPreset = DEFAULT_TOOL_PRESET } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof ownerHash !== 'string' || !ownerHash.trim() || ownerHash.length > 512 || ownerHash.includes('\0')) fail('INVALID_STORE_SCOPE', 'Absolute dataDir and local owner scope are required')
  const defaultPreset = toolPreset(defaultToolPreset, 'defaultToolPreset')
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
    insertProfile: db.prepare('INSERT INTO profiles (id, owner_hash, active_revision, lifecycle, origin, created_at, updated_at, source_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    insertRevision: db.prepare('INSERT INTO profile_revisions (profile_id, revision, parent_revision, hash, author, body_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    touch: db.prepare('UPDATE profiles SET lifecycle=?, active_revision=?, updated_at=? WHERE id=? AND owner_hash=?'),
    asset: db.prepare('SELECT * FROM profile_assets WHERE id=? AND owner_hash=?'),
    assetMeta: db.prepare('SELECT id, media_type, width, height, byte_size FROM profile_assets WHERE id=? AND owner_hash=?'),
    insertAsset: db.prepare('INSERT INTO profile_assets (id, owner_hash, media_type, width, height, byte_size, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    countAssets: db.prepare('SELECT COUNT(*) AS n FROM profile_assets'),
    // Uploads no saved revision names, older than the grace period.
    pruneAssets: db.prepare("DELETE FROM profile_assets WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM profile_revisions WHERE json_extract(profile_revisions.body_json, '$.avatar.assetId') = profile_assets.id)"),
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
  /** Where this profile came from, oldest first: [] for one made here from scratch. */
  function sourceOf(row) {
    let entries
    try { entries = JSON.parse(row.source_json) } catch { fail('STORE_CORRUPT', 'Saved profile source is unreadable; database was not reset', 500) }
    if (!Array.isArray(entries) || !entries.every(entry => entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.kind === 'string')) {
      fail('STORE_CORRUPT', 'Saved profile source is unreadable; database was not reset', 500)
    }
    return entries
  }
  // Instructions that came from outside this install wait for the user to read
  // them: the profile runs nothing until a revision is activated here.
  const reviewRequired = (row, source) => row.active_revision === null && source.some(entry => entry.kind === 'import')
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
    const source = sourceOf(row)
    return {
      id: row.id, lifecycle: row.lifecycle, origin: row.origin,
      activeRevision: row.active_revision, headRevision: head.revision,
      hasDraft: head.revision !== row.active_revision,
      source, reviewRequired: reviewRequired(row, source),
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
      // AGENT-08: a new room with this Agent runs on its saved engine.
      engine: body.model?.engine ?? null,
      // The list carries only the nearest origin; GET /profiles/:id has the whole chain.
      latestSource: shown.source.at(-1) ?? null, reviewRequired: shown.reviewRequired,
      createdAt: shown.createdAt, updatedAt: shown.updatedAt,
    }
  }
  /** A photo avatar must name an image uploaded to this store (inside a transaction). */
  function requireAvatarAsset(body) {
    if (body.avatar?.kind === 'image' && !q.assetMeta.get(body.avatar.assetId, owner)) fail('PROFILE_ASSET_NOT_FOUND', 'Avatar image was not uploaded to this EG-Desk; upload it again', 400)
  }
  const assetSummary = (row, unchanged) => ({ assetId: row.id, mediaType: row.media_type, width: row.width, height: row.height, byteSize: row.byte_size, unchanged })
  /** One new user draft at revision 1 (inside a transaction). */
  function insertDraft(json, hash, source, ts) {
    if (db.prepare("SELECT COUNT(*) AS n FROM profiles WHERE owner_hash=? AND lifecycle<>'deleted'").get(owner).n >= MAX_PROFILES ||
        db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n >= MAX_PROFILE_ROWS) fail('PROFILE_LIMIT', `At most ${MAX_PROFILES} profiles can be kept`, 409)
    const id = `prof-${randomUUID()}`
    q.insertProfile.run(id, owner, null, 'draft', 'user', ts, ts, JSON.stringify(source.slice(-MAX_SOURCE_ENTRIES)))
    q.insertRevision.run(id, 1, null, hash, 'user', json, ts)
    return saved({ id }, 1, hash, false)
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
    /**
     * A new user draft. options.toolPreset (a TOOL_CEILING_PRESETS id, else the
     * store's defaultToolPreset) fills toolCeiling only when the body leaves it
     * out; a body that sets toolCeiling keeps its own. Nothing else reads presets.
     */
    createDraft(body, options = {}) {
      ensureOpen()
      if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_PROFILE', 'options must be an object')
      const chosen = options.toolPreset === undefined || options.toolPreset === null ? defaultPreset : toolPreset(options.toolPreset)
      shape(body, BODY_KEYS, 'profile body')
      const filled = chosen.toolCeiling && (body.toolCeiling === undefined || body.toolCeiling === null) ? { ...body, toolCeiling: chosen.toolCeiling } : body
      const normalized = normalizeProfileBody(filled)
      const json = JSON.stringify(normalized), hash = digest(json)
      return tx(() => { requireAvatarAsset(normalized); return insertDraft(json, hash, [], now()) })
    },
    /** The ceilings a new Agent can start from, and the one used when none is chosen. */
    toolPresets() {
      ensureOpen()
      return { defaultPreset: defaultPreset.id, presets: TOOL_CEILING_PRESETS.map(item => ({ ...item, toolCeiling: item.toolCeiling && { ...item.toolCeiling } })) }
    },
    /**
     * AGENT-02 "복제해서 새로 만들기": a new user draft from one saved revision
     * (the active one, else the latest). The original and its revisions stay
     * as they are (clone-keeps-original: openai-agents-python Agent.clone,
     * crewAI BaseAgent.copy drops the id). The copy's source is the original's
     * source plus one 'duplicate' entry naming the revision it came from.
     * options.name replaces the default "<name> 사본".
     */
    duplicate(id, revision, options = {}) {
      ensureOpen()
      const name = options?.name
      return tx(() => {
        const row = requireProfile(id)
        if (row.lifecycle === 'deleted') lifecycleConflict('A deleted profile cannot be duplicated', row)
        const from = revisionOf(row, revision === undefined || revision === null ? row.active_revision ?? q.head.get(row.id).revision : revision)
        const body = normalizeProfileBody({ ...from.body, name: name === undefined || name === null ? copyName(from.body.name) : name })
        requireAvatarAsset(body)
        const json = JSON.stringify(body), ts = now()
        const entry = { kind: 'duplicate', origin: row.origin, profileId: row.id, revision: from.revision, hash: from.hash, name: from.body.name, at: ts }
        return insertDraft(json, digest(json), [...sourceOf(row), entry], ts)
      })
    },
    /**
     * A body from outside this install: an .egdesk bundle ('egdesk') or one
     * Agent file ('md', with the flavor egdesk-profile-file.mjs detected). It is
     * always a draft with reviewRequired until the user activates a revision.
     * A photo avatar is kept as its initial; a machine-local engine slot is
     * dropped. No tool preset is applied: the file's own ceiling stays.
     */
    importDraft(body, { format = 'egdesk', flavor } = {}) {
      ensureOpen()
      if (!IMPORT_FORMATS.includes(format)) fail('INVALID_PROFILE', 'Profile import format is not supported')
      if (flavor !== undefined && (format !== 'md' || !IMPORT_FLAVORS.includes(flavor))) fail('INVALID_PROFILE', 'Profile import flavor is not supported')
      const normalized = portableProfileBody(normalizeProfileBody(body))
      const json = JSON.stringify(normalized), hash = digest(json)
      return tx(() => {
        const ts = now()
        return insertDraft(json, hash, [{ kind: 'import', format, ...(flavor ? { flavor } : {}), name: normalized.name, at: ts }], ts)
      })
    },
    /** One saved revision to write out as a file (default: active, else latest). Deleted profiles are not exported. */
    exportRevision(id, revision) {
      ensureOpen()
      const row = requireProfile(id)
      if (row.lifecycle === 'deleted') lifecycleConflict('A deleted profile cannot be exported', row)
      const chosen = revisionOf(row, revision === undefined || revision === null ? row.active_revision ?? q.head.get(row.id).revision : revision)
      return { profileId: row.id, lifecycle: row.lifecycle, revision: chosen.revision, hash: chosen.hash, body: chosen.body }
    },
    /**
     * D-A3: keep one avatar photo {mediaType, imageBase64} → {assetId, mediaType,
     * width, height, byteSize, unchanged}. The bytes are checked and written
     * again without metadata before they are kept; the same picture gives the
     * same assetId. At the cap, uploads no revision uses (older than 10 minutes) make room.
     */
    putAvatarImage(input) {
      ensureOpen()
      const image = avatarUpload(input)
      const id = `img-${digest(image.bytes)}`
      return tx(() => {
        const existing = q.assetMeta.get(id, owner)
        if (existing) return assetSummary(existing, true)
        const ts = now()
        if (q.countAssets.get().n >= MAX_AVATAR_IMAGES) q.pruneAssets.run(ts - AVATAR_IMAGE_GRACE_MS)
        if (q.countAssets.get().n >= MAX_AVATAR_IMAGES) fail('PROFILE_ASSET_LIMIT', `At most ${MAX_AVATAR_IMAGES} avatar images can be kept`, 409)
        q.insertAsset.run(id, owner, image.mediaType, image.width, image.height, image.bytes.length, image.bytes, ts)
        return assetSummary(q.assetMeta.get(id, owner), false)
      })
    },
    /** One kept avatar photo with its bytes (a Buffer). */
    getAvatarImage(assetId) {
      ensureOpen()
      if (typeof assetId !== 'string' || !AVATAR_ASSET_ID.test(assetId)) fail('INVALID_PROFILE_ASSET_ID', 'Avatar image ID is invalid')
      const row = q.asset.get(assetId, owner)
      if (!row) fail('PROFILE_ASSET_NOT_FOUND', 'Avatar image does not exist', 404)
      const bytes = Buffer.from(row.bytes)
      if (`img-${digest(bytes)}` !== row.id) fail('STORE_CORRUPT', 'Saved avatar image does not match its ID', 500)
      const { unchanged, ...meta } = assetSummary(row, true)
      return { ...meta, bytes }
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
        requireAvatarAsset(normalized)
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
        // A revision saved before AGENT-04 has no field: no ceiling.
        toolCeiling: normalizeToolCeiling(chosen.body.toolCeiling),
      }
    },
    /** First run only: insert example templates as active. Never re-seeds after deletion. */
    seedTemplates(templates = PROFILE_TEMPLATES) {
      ensureOpen()
      if (!Array.isArray(templates) || templates.length > 20) fail('INVALID_PROFILE', 'Templates must be a list of at most 20 items')
      const prepared = templates.map(item => {
        shape(item, ['id', 'body'], 'template')
        if (profileId(item.id).startsWith('prof-')) fail('INVALID_PROFILE_ID', 'Template IDs cannot use the user profile prefix')
        const body = normalizeProfileBody(item.body)
        if (body.avatar?.kind === 'image') fail('INVALID_PROFILE', 'Templates cannot use an avatar image')
        const json = JSON.stringify(body)
        return { id: item.id, json, hash: digest(json) }
      })
      if (new Set(prepared.map(item => item.id)).size !== prepared.length) fail('INVALID_PROFILE', 'Template IDs must be unique')
      return tx(() => {
        if (db.prepare("SELECT value FROM store_meta WHERE name='templates_seeded'").get()) return { seeded: [], alreadySeeded: true }
        const ts = now(), seeded = []
        for (const item of prepared) {
          if (db.prepare('SELECT 1 FROM profiles WHERE id=?').get(item.id)) continue
          q.insertProfile.run(item.id, owner, null, 'active', 'template', ts, ts, '[]')
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
