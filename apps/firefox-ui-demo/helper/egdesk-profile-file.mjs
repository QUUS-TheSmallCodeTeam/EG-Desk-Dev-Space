import { Buffer } from 'node:buffer'
import {
  AVATAR_PALETTE, TOOL_CEILING_AXES, composeDeveloperInstructions, normalizeProfileBody, withoutAvatarImage,
} from './egdesk-profile-store.mjs'

// AGENT-02·04 (D-A2): one Agent as a file other tools read, and another tool's
// Agent file as an EG-Desk draft.
//
// Export .md — the agency-agents / Claude Code sub-agent shape: YAML front
//   matter (name, description, color, emoji, vibe, tools, model; agency-agents
//   engineering/engineering-code-reviewer.md:1-7) and, as the body, the
//   developer instructions EG-Desk composes, in composition order. One more
//   field, `egdesk`, holds the structured fields as a one-line JSON flow
//   mapping (valid YAML), so EG-Desk reads its own file back exactly; other
//   tools ignore it.
// Export .toml — a Codex custom agent role file: name, description,
//   developer_instructions, model, model_reasoning_effort, sandbox_mode
//   (openai/codex codex-rs/agent-roles/src/agent_role_config.rs:20-27, Apache-2.0,
//   key names only). Codex .toml files are not imported.
// Import .md — read by the small front matter reader below (no YAML library).
//   An imported Agent is always a draft (the store marks it reviewRequired).
//   A Claude Code `tools` / `disallowedTools` list can only narrow the tool
//   ceiling, never widen it. Unknown fields are listed by name only; their
//   values are never echoed or kept.
// Photos never leave EG-Desk (D-A3): a photo avatar is written as its initial.
//
// yamlQuote / tomlString: logic ported from msitarzewski/agency-agents
// scripts/convert.sh:111-129 (yaml_quote, toml_escape_string).
//   MIT License — Copyright (c) 2025 AgentLand Contributors. Permission is
//   hereby granted, free of charge, to any person obtaining a copy of this
//   software ... THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

export const AGENT_EXPORT_FORMATS = Object.freeze(['md', 'codex-toml'])
export const MAX_AGENT_FILE_BYTES = 56 * 1024
// The instructions field holds at most 8000 characters; a longer file is refused, not cut.
export const MAX_IMPORTED_INSTRUCTIONS = 8000
const MAX_FRONT_MATTER_LINES = 200
const MAX_LISTED_NAMES = 20
const MEDIA_TYPES = Object.freeze({ md: 'text/markdown; charset=utf-8', 'codex-toml': 'application/toml; charset=utf-8' })
const EGDESK_BLOCK_KEYS = ['v', 'avatar', 'role', 'personality', 'expertise', 'toolPreferences', 'model', 'toolCeiling']
const KNOWN_FIELDS = new Set(['name', 'description', 'color', 'emoji', 'vibe', 'tools', 'disallowedTools', 'model', 'egdesk'])
const USER_SECTION = '\n\n# 사용자 지침\n'
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_.-]{0,63})[ \t]*:(?:[ \t]+(.*))?$/s
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' })
const chars = value => Array.from(value).length

// Claude Code tool names. An allow-list names what an Agent may use, so what
// it leaves out is closed; EG-Desk's own browser tools are never in one.
const CLAUDE_READ_TOOLS = ['Read', 'Grep', 'Glob']
const CLAUDE_WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit']
const CLAUDE_WEB_TOOLS = ['WebFetch', 'WebSearch']
const CLAUDE_WRITE_NAMES = new Set([...CLAUDE_WRITE_TOOLS, 'MultiEdit'])
const CLAUDE_KNOWN = new Set([...CLAUDE_READ_TOOLS, 'LS', ...CLAUDE_WRITE_NAMES, 'Bash', ...CLAUDE_WEB_TOOLS, 'TodoWrite', 'Task', 'Agent'])
const AXES = TOOL_CEILING_AXES.map(item => item.axis)
const OPEN_CEILING = Object.freeze(Object.fromEntries(TOOL_CEILING_AXES.map(({ axis, open }) => [axis, open])))
const rank = (axis, value) => TOOL_CEILING_AXES.find(item => item.axis === axis).values.indexOf(value)

function fileFail(code, message, httpStatus = 400) {
  throw Object.assign(new Error(message), { code, httpStatus })
}

// ---- writing ----
const yamlQuote = value => `'${String(value).replace(/'/g, "''")}'`
const TOML_ESCAPES = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\f': '\\f', '\b': '\\b' }
const tomlString = value => `"${String(value).replace(/[\\"\u0000-\u001f\u007f]/g, char => TOML_ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)}"`
// JSON with ", " and ": " separators: a YAML flow mapping every YAML parser reads, and still JSON.
const jsonString = value => JSON.stringify(value).replace(/[\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16)}`)
function flow(value) {
  if (Array.isArray(value)) return `[${value.map(flow).join(', ')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${jsonString(key)}: ${flow(item)}`).join(', ')}}`
  return typeof value === 'string' ? jsonString(value) : JSON.stringify(value)
}
/** The Claude Code allow-list that stays inside a ceiling (null when there is no ceiling). */
function claudeTools(ceiling) {
  if (!ceiling) return null
  return [
    ...CLAUDE_READ_TOOLS, ...(ceiling.files === 'write' ? CLAUDE_WRITE_TOOLS : []),
    ...(ceiling.terminal === 'none' ? [] : ['Bash']), ...(ceiling.network === 'on' ? CLAUDE_WEB_TOOLS : []),
  ]
}
// U+2028/2029 end a line for YAML 1.1 readers, so a one-line value stops there too.
const firstLine = text => text.split(/[\n\u2028\u2029]/).map(line => line.trim()).find(Boolean) ?? ''

function markdownText(body) {
  const { name, instructions, ...structured } = body
  const vibe = firstLine(body.personality.speechNotes) || body.personality.traits.join(', ')
  const tools = claudeTools(body.toolCeiling)
  const lines = [
    '---',
    `name: ${yamlQuote(name)}`,
    `description: ${yamlQuote(body.role || name)}`,
    `color: ${yamlQuote(body.avatar?.color ?? AVATAR_PALETTE[0])}`,
    ...(body.avatar?.kind === 'emoji' ? [`emoji: ${yamlQuote(body.avatar.value)}`] : []),
    ...(vibe ? [`vibe: ${yamlQuote(vibe)}`] : []),
    ...(tools ? [`tools: ${tools.join(', ')}`] : []),
    ...(body.model?.engine === 'claude' ? [`model: ${yamlQuote(body.model.modelId)}`] : []),
    `egdesk: ${flow({ v: 1, ...structured })}`,
    '---',
  ]
  return `${lines.join('\n')}\n${composeDeveloperInstructions(body)}\n`
}
function codexToml(body) {
  const lines = [
    `# EG-Desk에서 내보낸 Codex 에이전트 파일 — ${body.name}`,
    '# 이름·설명·답변 지침·모델만 옮긴다. 사진 아바타와 EG-Desk 전용 설정은 담기지 않는다.',
    '# sandbox_mode는 파일 쓰기 범위만 나타낸다. EG-Desk의 터미널·브라우저·인터넷·외부 도구(MCP) 상한은',
    '# 이 파일에 담기지 않으며 Codex가 지키지 않는다. 지침 본문의 "# 쓸 수 있는 도구" 문장으로만 전해진다.',
    `name = ${tomlString(body.name)}`,
    `description = ${tomlString(body.role || body.name)}`,
    `developer_instructions = ${tomlString(composeDeveloperInstructions(body))}`,
  ]
  if (body.model?.engine === 'codex') {
    lines.push(`model = ${tomlString(body.model.modelId)}`)
    if (body.model.effort) lines.push(`model_reasoning_effort = ${tomlString(body.model.effort)}`)
  }
  // Never danger-full-access: an exported file is at most as open as the ceiling.
  if (body.toolCeiling) lines.push(`sandbox_mode = ${tomlString(body.toolCeiling.files === 'write' ? 'workspace-write' : 'read-only')}`)
  return `${lines.join('\n')}\n`
}

/** "Code Reviewer" → "code-reviewer.md"; letters of any script are kept. */
export function agentFileName(name, format = 'md') {
  const base = Array.from(String(name ?? '').normalize('NFC').trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '-').replace(/\s+/g, '-').replace(/-{2,}/g, '-').toLowerCase())
    .slice(0, 60).join('').replace(/^[.-]+|[.-]+$/g, '')
  return `${base || 'agent'}.${format === 'codex-toml' ? 'toml' : 'md'}`
}

/**
 * One saved body as a file → {format, filename, mediaType, text, omitted}.
 * omitted lists what the file leaves out on purpose (today: 'avatarImage').
 */
export function exportAgentFile(input, format = 'md') {
  if (!AGENT_EXPORT_FORMATS.includes(format)) fileFail('INVALID_AGENT_FILE_FORMAT', `format must be one of ${AGENT_EXPORT_FORMATS.join(', ')}`)
  const saved = normalizeProfileBody(input)
  const omitted = saved.avatar?.kind === 'image' ? ['avatarImage'] : []
  const body = withoutAvatarImage(saved)
  return { format, filename: agentFileName(body.name, format), mediaType: MEDIA_TYPES[format], text: format === 'md' ? markdownText(body) : codexToml(body), omitted }
}
export const exportAgentMarkdown = input => exportAgentFile(input, 'md')
export const exportCodexAgentToml = input => exportAgentFile(input, 'codex-toml')

// ---- reading: a small YAML front matter subset ----
// Read: `key: value` lines with plain, 'single' or "double" quoted scalars;
// block scalars (| and >); flow lists on one line; block lists of scalars;
// one-line JSON flow mappings. Anything else under a key (nested mappings,
// anchors spread over lines) is left unread and reported as such.
const YAML_ESCAPES = { 0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029' }
const HEX_ESCAPES = { x: 2, u: 4, U: 8 }
function quoted(value) {
  const quote = value[0]
  let out = '', index = 1, closed = false
  for (; index < value.length; index++) {
    const char = value[index]
    if (quote === "'") {
      if (char === "'") {
        if (value[index + 1] === "'") { out += "'"; index++; continue }
        closed = true
        break
      }
      out += char
    } else if (char === '"') { closed = true; break }
    else if (char === '\\') {
      const code = value[index + 1]
      if (Object.hasOwn(YAML_ESCAPES, code)) { out += YAML_ESCAPES[code]; index++; continue }
      const width = HEX_ESCAPES[code]
      const hex = width ? value.slice(index + 2, index + 2 + width) : ''
      if (!width || !new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex)) fileFail('AGENT_FILE_INVALID', 'A quoted value has an escape EG-Desk cannot read')
      const point = Number.parseInt(hex, 16)
      if (point > 0x10ffff) fileFail('AGENT_FILE_INVALID', 'A quoted value has an escape EG-Desk cannot read')
      out += String.fromCodePoint(point)
      index += 1 + width
    } else out += char
  }
  if (!closed) fileFail('AGENT_FILE_INVALID', 'A quoted value is not closed')
  const rest = value.slice(index + 1)
  if (rest.trim() && !/^\s+#/.test(rest)) fileFail('AGENT_FILE_INVALID', 'Text follows a quoted value')
  return out
}
function scalar(text) {
  const value = text.trim()
  if (value.startsWith("'") || value.startsWith('"')) return quoted(value)
  const plain = value.replace(/(^|\s)#.*$/s, '').trim() // " #" starts a comment in a plain value
  return ['~', 'null', 'Null', 'NULL'].includes(plain) ? '' : plain
}
function flowList(text) {
  const match = /^\[(.*)\]\s*(?:#.*)?$/s.exec(text)
  if (!match) return null
  const items = []
  let current = '', quote = null
  for (const char of match[1]) {
    if (quote) {
      current += char
      if (char === quote) quote = null
    } else if (char === "'" || char === '"') { quote = char; current += char }
    else if (char === '[' || char === '{') return null // nested flow collections are not read
    else if (char === ',') { items.push(current); current = '' }
    else current += char
  }
  if (quote) return null
  items.push(current)
  return items.map(scalar).filter(Boolean)
}
function blockScalar(folded, nested) {
  const filled = nested.filter(line => line.trim())
  if (!filled.length) return ''
  const indent = Math.min(...filled.map(line => /^[ \t]*/.exec(line)[0].length))
  const text = nested.map(line => line.slice(indent)).join('\n')
  // Folded: a single line break becomes a space; a blank line stays a line break.
  return folded ? text.replace(/\n(\n*)/g, (_, extra) => extra || ' ') : text
}
function readValue(raw, nested) {
  const text = raw.trim()
  const content = nested.filter(line => line.trim() && !/^\s*#/.test(line))
  if (/^[|>]/.test(text)) {
    if (!/^[|>](?:[+-]?[1-9]?|[1-9][+-])(?:\s+#.*)?$/.test(text)) fileFail('AGENT_FILE_INVALID', 'A block value header cannot be read')
    return { kind: 'text', value: blockScalar(text[0] === '>', nested) }
  }
  if (!text) {
    if (!content.length) return { kind: 'text', value: '' }
    if (content.every(line => /^\s+-(\s|$)/.test(line))) return { kind: 'list', value: content.map(line => scalar(line.replace(/^\s+-\s*/, ''))).filter(Boolean) }
    return { kind: 'unread' }
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    if (content.length) return { kind: 'unread' }
    if (text.startsWith('[')) { const items = flowList(text); return items ? { kind: 'list', value: items } : { kind: 'unread' } }
    try { return { kind: 'map', value: JSON.parse(text.replace(/\s+#[^"}]*$/, '')) } } catch { return { kind: 'unread' } }
  }
  if (/^[&*!%@`]/.test(text)) return { kind: 'unread' } // anchors, aliases, tags and reserved indicators
  // A value continued on indented lines is folded with spaces, as YAML does.
  return { kind: 'text', value: scalar([text, ...content.map(line => line.trim())].join(' ')) }
}
function frontMatter(text) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  if (lines[0].trimEnd() !== '---') fileFail('AGENT_FILE_FORMAT', 'An Agent file starts with a --- front matter block (Codex .toml files can be exported but not imported)')
  const close = lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---')
  if (close < 0) fileFail('AGENT_FILE_INVALID', 'The front matter block is not closed with ---')
  if (close - 1 > MAX_FRONT_MATTER_LINES) fileFail('AGENT_FILE_INVALID', `The front matter block is longer than ${MAX_FRONT_MATTER_LINES} lines`)
  const head = lines.slice(1, close), fields = new Map()
  for (let index = 0; index < head.length;) {
    const line = head[index]
    if (!line.trim() || /^\s*#/.test(line)) { index++; continue }
    const match = /^\s/.test(line) ? null : KEY_LINE.exec(line)
    if (!match) fileFail('AGENT_FILE_INVALID', `Front matter line ${index + 2} cannot be read`)
    if (fields.has(match[1])) fileFail('AGENT_FILE_INVALID', `The front matter repeats the field ${match[1]}`)
    index++
    const nested = []
    while (index < head.length && (/^[ \t]/.test(head[index]) || !head[index].trim())) nested.push(head[index++])
    while (nested.length && !nested.at(-1).trim()) nested.pop()
    fields.set(match[1], readValue(match[2] ?? '', nested))
  }
  return { fields, body: lines.slice(close + 1).join('\n') }
}

// ---- reading: mapping onto a profile body ----
const oneLine = text => text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()
/** Whole characters up to max, ending in "…" when something was cut. */
function shorten(text, max) {
  if (chars(text) <= max) return text
  let out = ''
  for (const { segment } of graphemes.segment(text)) {
    if (chars(out + segment) > max - 1) break
    out += segment
  }
  return `${out.trimEnd()}…`
}
const toolName = entry => entry.replace(/\(.*$/s, '').trim()
/** The most a Claude Code allow-list lets an Agent do, per ceiling axis. */
const allowedBound = names => ({
  browser: 'none',
  files: names.some(name => CLAUDE_WRITE_NAMES.has(name)) ? 'write' : 'read',
  terminal: names.includes('Bash') ? 'allow' : 'none',
  network: names.some(name => CLAUDE_WEB_TOOLS.includes(name)) ? 'on' : 'off',
  mcp: names.some(name => name.startsWith('mcp__')) ? 'inherited' : 'none',
})
/** The most a Claude Code deny-list still lets an Agent do. */
const deniedBound = names => ({
  browser: 'interact',
  files: names.some(name => CLAUDE_WRITE_NAMES.has(name)) ? 'read' : 'write',
  terminal: names.includes('Bash') ? 'none' : 'allow',
  network: names.some(name => CLAUDE_WEB_TOOLS.includes(name)) ? 'off' : 'on',
  mcp: names.some(name => name.startsWith('mcp__')) ? 'none' : 'inherited',
})
const NARROWEST = Object.freeze(Object.fromEntries(TOOL_CEILING_AXES.map(({ axis, values }) => [axis, values[0]])))
function narrow(base, bound, axes) {
  const result = { ...base }
  for (const axis of axes) if (rank(axis, bound[axis]) < rank(axis, result[axis])) result[axis] = bound[axis]
  return result
}
/**
 * The user instructions an EG-Desk-exported body was composed with, or null
 * when the body was changed outside EG-Desk. An editor that only dropped
 * trailing spaces on save does not count as a change.
 */
function userInstructions(markdown, structured) {
  const composed = composeDeveloperInstructions({ ...structured, instructions: '' })
  const trimLines = text => text.replace(/[ \t]+$/gm, '')
  for (const [text, prefix] of [[markdown, composed], [trimLines(markdown), trimLines(composed)]]) {
    if (text === prefix) return ''
    if (text.startsWith(prefix + USER_SECTION)) return text.slice(prefix.length + USER_SECTION.length)
  }
  return null
}
const safeName = name => /^[A-Za-z0-9_.:*@/-]{1,64}$/.test(name) ? name : '(읽을 수 없는 이름)'

/**
 * Another tool's Agent file (.md with front matter) → {format: 'md', flavor,
 * body, preview}. body is a normalized profile body ready for
 * store.importDraft(body, {format: 'md', flavor}); nothing is written here.
 * flavor: 'egdesk' (exported by EG-Desk), 'agency-agents' or 'claude-code'.
 * preview: what the user checks before the draft is made — names, the
 * resulting avatar, model and ceiling, sizes, fields left out (names only),
 * tool names with no EG-Desk meaning, and every adjustment with its reason.
 */
export function importAgentFile(text, { filename } = {}) {
  if (typeof text !== 'string' || !text.trim()) fileFail('AGENT_FILE_INVALID', 'The Agent file is empty')
  if (Buffer.byteLength(text) > MAX_AGENT_FILE_BYTES) fileFail('AGENT_FILE_TOO_LARGE', `An Agent file must be at most ${MAX_AGENT_FILE_BYTES / 1024} KB`, 413)
  if (filename !== undefined && filename !== null) {
    if (typeof filename !== 'string' || filename.length > 255) fileFail('AGENT_FILE_INVALID', 'filename must be text of at most 255 characters')
    if (/\.toml\s*$/i.test(filename)) fileFail('AGENT_FILE_FORMAT', 'Codex .toml files can be exported but not imported')
  }
  const { fields, body: rawBody } = frontMatter(text)
  const adjusted = []
  const note = (field, reason) => adjusted.push({ field, reason })
  const textOf = key => {
    const field = fields.get(key)
    if (!field) return ''
    if (field.kind === 'text') return field.value
    note(key, 'unreadable')
    return ''
  }
  // Allow/deny lists: one that cannot be read is taken as the narrowest.
  const listOf = key => {
    const field = fields.get(key)
    if (!field) return null
    if (field.kind === 'list') return field.value.map(toolName).filter(Boolean)
    if (field.kind === 'text') return field.value.split(',').map(toolName).filter(Boolean)
    note(key, 'unreadable')
    return ['(unreadable)']
  }

  let name = oneLine(textOf('name'))
  if (!name) fileFail('AGENT_FILE_INVALID', 'The Agent file has no name')
  if (chars(name) > 40) { name = shorten(name, 40); note('name', 'shortened') }
  const markdown = rawBody.normalize('NFC').trim()

  let flavor, structured, instructions
  const block = fields.get('egdesk')
  if (block) {
    const value = block.kind === 'map' ? block.value : null
    if (!value || typeof value !== 'object' || Array.isArray(value)) fileFail('AGENT_FILE_INVALID', 'The egdesk field cannot be read')
    if (value.v !== 1 || Object.keys(value).some(key => !EGDESK_BLOCK_KEYS.includes(key))) fileFail('AGENT_FILE_INVALID', 'The egdesk field was written by a different EG-Desk version')
    const { v, ...rest } = value
    flavor = 'egdesk'
    if (rest.avatar?.kind === 'image') note('avatar', 'photo-not-included')
    structured = withoutAvatarImage(normalizeProfileBody({ ...rest, name, instructions: '' }))
    instructions = userInstructions(markdown, structured)
    if (instructions === null) {
      // Changed in another tool: the text is the instructions, and the fields
      // it already spells out are not composed a second time.
      instructions = markdown
      structured = { ...structured, personality: { tone: structured.personality.tone }, expertise: [] }
      note('instructions', 'edited-outside-egdesk')
    }
  } else {
    flavor = fields.has('emoji') || fields.has('vibe') ? 'agency-agents' : 'claude-code'
    instructions = markdown
    let role = oneLine(textOf('description'))
    if (chars(role) > 80) { role = shorten(role, 80); note('description', 'shortened') }
    const colorText = oneLine(textOf('color')).toLowerCase()
    const color = AVATAR_PALETTE.includes(colorText) ? colorText : AVATAR_PALETTE[0]
    if (colorText && color !== colorText) note('color', 'not-in-palette')
    let avatar = null
    const emoji = oneLine(textOf('emoji'))
    if (emoji) {
      try { avatar = normalizeProfileBody({ name, avatar: { kind: 'emoji', value: emoji, color } }).avatar } catch { note('emoji', 'not-one-emoji') }
    }
    let speechNotes = textOf('vibe').normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
    if (chars(speechNotes) > 500) { speechNotes = shorten(speechNotes, 500); note('vibe', 'shortened') }
    let model = null
    const modelText = oneLine(textOf('model'))
    if (modelText && modelText !== 'inherit') {
      try { model = normalizeProfileBody({ name, model: { engine: 'claude', modelId: modelText } }).model } catch { note('model', 'unsupported') }
    }
    structured = { avatar, role, personality: { speechNotes }, model }
  }
  if (chars(instructions) > MAX_IMPORTED_INSTRUCTIONS) {
    fileFail('AGENT_FILE_TOO_LONG', `The instructions are ${chars(instructions)} characters; an Agent holds at most ${MAX_IMPORTED_INSTRUCTIONS}`)
  }

  // Tool lists only narrow. EG-Desk's own export writes `tools` from the ceiling,
  // so for its files only the axes Claude Code can say (files, terminal, web) are read.
  const allowed = listOf('tools'), denied = listOf('disallowedTools')
  const axes = flavor === 'egdesk' ? ['files', 'terminal', 'network'] : AXES
  const before = structured.toolCeiling ?? null
  let ceiling = before ?? OPEN_CEILING
  if (allowed && !(allowed.length === 1 && allowed[0] === '*')) ceiling = narrow(ceiling, allowed[0] === '(unreadable)' ? NARROWEST : allowedBound(allowed), axes)
  if (denied) ceiling = narrow(ceiling, denied[0] === '(unreadable)' ? NARROWEST : deniedBound(denied), axes)
  const narrowed = AXES.some(axis => ceiling[axis] !== (before ?? OPEN_CEILING)[axis])
  if (narrowed) note('toolCeiling', 'narrowed-by-tool-list')
  const toolCeiling = before || narrowed ? ceiling : null

  const { toolCeiling: _ignored, ...kept } = structured
  const body = normalizeProfileBody({ ...kept, name, instructions, toolCeiling })
  const unknown = [...fields.keys()].filter(key => !KNOWN_FIELDS.has(key))
  const unmapped = [...new Set([...(allowed ?? []), ...(denied ?? [])])]
    .filter(item => item !== '*' && item !== '(unreadable)' && !CLAUDE_KNOWN.has(item) && !item.startsWith('mcp__'))
  return {
    format: 'md',
    flavor,
    body,
    preview: {
      format: 'md', flavor, reviewRequired: true,
      name: body.name, role: body.role, avatar: body.avatar, model: body.model, toolCeiling: body.toolCeiling ?? null,
      instructionsChars: chars(body.instructions), composedChars: composeDeveloperInstructions(body).length,
      unknownFields: unknown.slice(0, MAX_LISTED_NAMES), unknownFieldCount: unknown.length,
      unmappedTools: unmapped.slice(0, MAX_LISTED_NAMES).map(safeName),
      adjusted,
    },
  }
}
