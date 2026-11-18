import test from 'node:test'
import assert from 'node:assert/strict'
import { AVATAR_PALETTE, PERSONALITY_LIMITS, composeDeveloperInstructions, normalizeProfileBody, profileHash } from './egdesk-profile-store.mjs'
import {
  MAX_AGENT_FILE_BYTES, MAX_IMPORTED_INSTRUCTIONS, agentFileName, exportAgentFile, exportAgentMarkdown, exportCodexAgentToml, importAgentFile,
} from './egdesk-profile-file.mjs'

const rio = (extra = {}) => ({
  name: '리오', avatar: { kind: 'emoji', value: '🦊', color: AVATAR_PALETTE[1] }, role: '회의 준비 담당',
  personality: {
    tone: 'warm', traits: ['꼼꼼함', '차분함'], speechNotes: '결론부터 말한다.  \n숫자는 표로 정리한다.',
    examples: [{ user: '내일 회의 뭐 있어?', reply: '내일은 회의가 두 개 있어요.\n10시 기획, 3시 고객.' }], avoid: ['확인 안 된 일정을 확정처럼 말하기'],
  },
  expertise: ['회의 자료 정리', '일정 확인'], instructions: '대표님께는 존댓말을 쓴다.\n"인용" 과 \\ 백슬래시도 그대로.\t탭',
  toolPreferences: ['browser.read'], model: { engine: 'claude', modelId: 'claude-opus-5-5', effort: 'high' },
  toolCeiling: { browser: 'observe', files: 'read', terminal: 'allow', network: 'on', mcp: 'inherited' },
  ...extra,
})
const rejects = (action, code) => assert.throws(action, error => error.code === code, code)
const parts = text => {
  const close = text.indexOf('\n---\n', 4)
  return { head: text.slice(4, close).split('\n'), body: text.slice(close + 5) }
}
const fieldOf = (head, key) => head.find(line => line.startsWith(`${key}: `))?.slice(key.length + 2)

test('an exported .md has agency-agents / Claude Code front matter and the composed instructions as its body', () => {
  const body = rio()
  const file = exportAgentMarkdown(body)
  assert.deepEqual([file.format, file.filename, file.mediaType, file.omitted], ['md', '리오.md', 'text/markdown; charset=utf-8', []])
  assert.ok(file.text.startsWith('---\n'))
  const { head, body: text } = parts(file.text)
  assert.equal(text, `${composeDeveloperInstructions(body)}\n`, 'the body is what the Agent is told, in composition order')
  assert.deepEqual(head.map(line => line.slice(0, line.indexOf(':'))), ['name', 'description', 'color', 'emoji', 'vibe', 'tools', 'model', 'egdesk'])
  assert.deepEqual([fieldOf(head, 'name'), fieldOf(head, 'description'), fieldOf(head, 'color'), fieldOf(head, 'emoji'), fieldOf(head, 'vibe')], ["'리오'", "'회의 준비 담당'", `'${AVATAR_PALETTE[1]}'`, "'🦊'", "'결론부터 말한다.'"])
  assert.equal(fieldOf(head, 'tools'), 'Read, Grep, Glob, Bash, WebFetch, WebSearch', 'the Claude Code allow-list stays inside the ceiling')
  assert.equal(fieldOf(head, 'model'), "'claude-opus-5-5'")
  const { name, instructions, ...structured } = normalizeProfileBody(body)
  assert.deepEqual(JSON.parse(fieldOf(head, 'egdesk')), { v: 1, ...structured })
  assert.ok(!fieldOf(head, 'egdesk').includes(instructions.slice(0, 8)), 'instructions live in the body only')

  const minimal = parts(exportAgentMarkdown({ name: "O'Neil" }).text).head
  assert.deepEqual(minimal.map(line => line.slice(0, line.indexOf(':'))), ['name', 'description', 'color', 'egdesk'], 'no ceiling: no tools line, so other tools inherit as before')
  assert.equal(fieldOf(minimal, 'name'), "'O''Neil'")
  const codex = parts(exportAgentMarkdown(rio({ model: { engine: 'codex', modelId: 'gpt-5.5', effort: null }, toolCeiling: { browser: 'none', files: 'write', terminal: 'none', network: 'off', mcp: 'none' } })).text).head
  assert.equal(fieldOf(codex, 'model'), undefined, 'a Codex model is not a Claude Code model')
  assert.equal(fieldOf(codex, 'tools'), 'Read, Grep, Glob, Write, Edit, NotebookEdit')
})

test('EG-Desk reads its own .md back to the same body and hash', () => {
  const L = PERSONALITY_LIMITS
  const full = {
    name: '가'.repeat(40), avatar: { kind: 'initial', value: '가', color: AVATAR_PALETTE[5] }, role: "나'\"#: ".repeat(13),
    personality: {
      tone: 'formal', traits: Array.from({ length: 6 }, (_, i) => `${i}${'다'.repeat(39)}`), speechNotes: `라\u2028${'라'.repeat(490)}`,
      examples: Array.from({ length: L.examples }, (_, i) => ({ user: `${i}${'사'.repeat(L.exampleUser - 1)}`, reply: `${i}${'아'.repeat(L.exampleReply - 1)}` })),
      avoid: Array.from({ length: L.avoid }, (_, i) => `${i}${'자'.repeat(L.avoidItem - 1)}`),
    },
    expertise: Array.from({ length: 8 }, (_, i) => `${i}${'마'.repeat(79)}`), instructions: '바'.repeat(8000),
    toolCeiling: { browser: 'none', files: 'read', terminal: 'none', network: 'off', mcp: 'none' },
  }
  for (const body of [rio(), { name: 'A' }, full, rio({ avatar: null, toolCeiling: undefined }), rio({ instructions: '' })]) {
    const text = exportAgentMarkdown(body).text
    assert.ok(Buffer.byteLength(text) <= MAX_AGENT_FILE_BYTES, `${Buffer.byteLength(text)} bytes`)
    const back = importAgentFile(text, { filename: 'agent.md' })
    assert.deepEqual([back.format, back.flavor, back.preview.adjusted], ['md', 'egdesk', []])
    assert.deepEqual(back.body, normalizeProfileBody(body))
    assert.equal(profileHash(back.body), profileHash(body))
  }
  // Saved again by an editor: BOM, CRLF and trailing spaces dropped from lines.
  const edited = `\uFEFF${exportAgentMarkdown(rio()).text.replace(/[ \t]+$/gm, '').replace(/\n/g, '\r\n')}`
  const back = importAgentFile(edited)
  assert.deepEqual(back.preview.adjusted, [])
  assert.equal(back.body.instructions, normalizeProfileBody(rio()).instructions)
})

test('photos stay home: a photo avatar is written as its initial and listed in omitted', () => {
  const photo = rio({ avatar: { kind: 'image', value: '리', color: AVATAR_PALETTE[3], assetId: `img-${'a'.repeat(64)}` } })
  for (const format of ['md', 'codex-toml']) {
    const file = exportAgentFile(photo, format)
    assert.deepEqual(file.omitted, ['avatarImage'])
    assert.ok(!file.text.includes('img-') && !file.text.includes('assetId'))
  }
  assert.deepEqual(importAgentFile(exportAgentMarkdown(photo).text).body.avatar, { kind: 'initial', value: '리', color: AVATAR_PALETTE[3] })
  rejects(() => exportAgentFile(rio(), 'docx'), 'INVALID_AGENT_FILE_FORMAT')
})

test('the Codex .toml export carries name, description, instructions, model and a sandbox no wider than the ceiling', () => {
  const read = text => {
    const lines = text.trimEnd().split('\n')
    const comments = lines.filter(line => line.startsWith('#'))
    const keys = Object.fromEntries(lines.filter(line => !line.startsWith('#')).map(line => {
      const match = /^([a-z_]+) = (".*")$/.exec(line)
      assert.ok(match, line)
      return [match[1], JSON.parse(match[2])] // TOML basic-string escapes used here are a subset of JSON's
    }))
    return { comments, keys }
  }
  const body = rio({ model: { engine: 'codex', modelId: 'gpt-5.5', effort: 'medium' } })
  const file = exportCodexAgentToml(body)
  assert.deepEqual([file.format, file.filename, file.mediaType], ['codex-toml', '리오.toml', 'application/toml; charset=utf-8'])
  const { comments, keys } = read(file.text)
  assert.ok(comments.length >= 3 && comments.some(line => /sandbox_mode/.test(line)) && comments.some(line => /터미널·브라우저·인터넷·외부 도구\(MCP\)/.test(line)), 'the head comment says what the sandbox cannot carry')
  assert.deepEqual(Object.keys(keys), ['name', 'description', 'developer_instructions', 'model', 'model_reasoning_effort', 'sandbox_mode'])
  assert.deepEqual([keys.name, keys.description, keys.model, keys.model_reasoning_effort, keys.sandbox_mode], ['리오', '회의 준비 담당', 'gpt-5.5', 'medium', 'read-only'])
  assert.equal(keys.developer_instructions, composeDeveloperInstructions(body))
  assert.ok(!file.text.includes('\t'), 'control characters are escaped')
  const writer = read(exportCodexAgentToml(rio({ toolCeiling: { browser: 'interact', files: 'write', terminal: 'allow', network: 'on', mcp: 'inherited' } })).text).keys
  assert.deepEqual([writer.sandbox_mode, writer.model], ['workspace-write', undefined], 'a Claude model is not written for Codex')
  assert.equal(read(exportCodexAgentToml({ name: 'A' }).text).keys.sandbox_mode, undefined, 'no ceiling: Codex keeps its own setting')
  assert.ok(!exportCodexAgentToml(rio()).text.includes('danger-full-access'))
})

test('an agency-agents file becomes a draft body: emoji face, vibe as speech notes, no ceiling without a tool list', () => {
  const text = [
    '---', 'name: Release Planner', 'description: Plans releases and keeps the checklist honest.', 'color: purple', 'emoji: 🚀',
    'vibe: Calm under deadline pressure.', '---', '', '# Release Planner Agent', '', 'You plan releases.', '',
  ].join('\n')
  const { format, flavor, body, preview } = importAgentFile(text, { filename: 'release-planner.md' })
  assert.deepEqual([format, flavor], ['md', 'agency-agents'])
  assert.deepEqual([body.name, body.role, body.avatar, body.personality.speechNotes], ['Release Planner', 'Plans releases and keeps the checklist honest.', { kind: 'emoji', value: '🚀', color: AVATAR_PALETTE[0] }, 'Calm under deadline pressure.'])
  assert.equal(body.instructions, '# Release Planner Agent\n\nYou plan releases.')
  assert.equal(body.toolCeiling, undefined)
  assert.deepEqual(preview.adjusted, [{ field: 'color', reason: 'not-in-palette' }])
  assert.deepEqual([preview.reviewRequired, preview.unknownFields, preview.instructionsChars, preview.composedChars], [true, [], body.instructions.length, composeDeveloperInstructions(body).length])
})

test('a Claude Code sub-agent file: the tool list only narrows the ceiling, unknown fields are listed by name only', () => {
  const secret = `sk-test-${'x'.repeat(24)}`
  const text = [
    '---', 'name: code-reviewer',
    `description: "Use this agent after code changes.\\nExamples:\\n<example>Context: the user wrote code</example> ${'more '.repeat(20)}"`,
    'tools: Read, Grep, Glob, Bash(git diff:*), mcp__github__get_pr, FancyTool', 'model: sonnet', 'color: blue', 'permissionMode: plan',
    `api_key: ${secret}`, 'mcpServers:', '  github:', '    command: npx-secret-server', '---', 'You are a senior reviewer.',
  ].join('\n')
  const result = importAgentFile(text)
  const { body, preview } = result
  assert.equal(result.flavor, 'claude-code')
  assert.ok(body.role.length <= 80 && body.role.endsWith('…') && !body.role.includes('\n'))
  assert.deepEqual(body.toolCeiling, { browser: 'none', files: 'read', terminal: 'ask', network: 'off', mcp: 'inherited' })
  assert.deepEqual(body.model, { engine: 'claude', modelId: 'sonnet', effort: null })
  assert.equal(body.avatar, null)
  assert.deepEqual(preview.adjusted.map(item => `${item.field}:${item.reason}`), ['description:shortened', 'color:not-in-palette', 'toolCeiling:narrowed-by-tool-list'])
  assert.deepEqual([preview.unknownFields, preview.unknownFieldCount, preview.unmappedTools], [['permissionMode', 'api_key', 'mcpServers'], 3, ['FancyTool']])
  const json = JSON.stringify(result)
  assert.ok(!json.includes(secret) && !json.includes('npx-secret-server') && !json.includes('plan"'), 'values of unknown fields are never echoed')
  assert.match(composeDeveloperInstructions(body), /# 쓸 수 있는 도구[\s\S]*브라우저는 쓰지 않는다/)
})

test('tool lists never widen: an edited tools line or disallowedTools only narrows', () => {
  const body = rio({ toolCeiling: { browser: 'interact', files: 'read', terminal: 'allow', network: 'on', mcp: 'inherited' } })
  const widened = exportAgentMarkdown(body).text.replace(/^tools: .*$/m, 'tools: Read, Write, Edit, WebFetch')
  const back = importAgentFile(widened)
  assert.deepEqual(back.body.toolCeiling, { browser: 'interact', files: 'read', terminal: 'none', network: 'on', mcp: 'inherited' }, 'Write cannot open files; dropping Bash closes the terminal')
  assert.deepEqual(back.preview.adjusted, [{ field: 'toolCeiling', reason: 'narrowed-by-tool-list' }])
  const noLine = importAgentFile(exportAgentMarkdown(body).text.replace(/^tools: .*\n/m, ''))
  assert.deepEqual(noLine.body.toolCeiling, body.toolCeiling, 'removing the line widens nothing either: the egdesk field still holds')

  const denied = importAgentFile('---\nname: A\ndisallowedTools: [Bash, WebSearch]\n---\nbody')
  assert.deepEqual(denied.body.toolCeiling, { browser: 'interact', files: 'write', terminal: 'none', network: 'off', mcp: 'inherited' })
  const both = importAgentFile('---\nname: A\ntools: Read, Bash, WebFetch\ndisallowedTools:\n  - Bash\n---\nbody')
  assert.deepEqual(both.body.toolCeiling, { browser: 'none', files: 'read', terminal: 'none', network: 'on', mcp: 'none' })
  assert.equal(importAgentFile('---\nname: A\n---\nbody').body.toolCeiling, undefined, 'no list: no ceiling, as today')
  assert.equal(importAgentFile("---\nname: A\ntools: '*'\n---\nbody").body.toolCeiling, undefined)
  const unreadable = importAgentFile('---\nname: A\ntools:\n  read: yes\n---\nbody')
  assert.deepEqual(unreadable.body.toolCeiling, { browser: 'none', files: 'read', terminal: 'none', network: 'off', mcp: 'none' }, 'a list that cannot be read is taken as the narrowest')
  assert.ok(unreadable.preview.adjusted.some(item => item.field === 'tools' && item.reason === 'unreadable'))
})

test('a body changed in another tool becomes the instructions and is not composed twice', () => {
  const body = rio()
  const back = importAgentFile(exportAgentMarkdown(body).text.replace('따뜻하고 친절한 말투로', '아주 따뜻한 말투로'))
  assert.deepEqual(back.preview.adjusted, [{ field: 'instructions', reason: 'edited-outside-egdesk' }])
  assert.match(back.body.instructions, /^아래는 사용자가 EG-Desk에서 정한 담당자 설정이다\.[\s\S]*아주 따뜻한 말투로/)
  assert.deepEqual([back.body.personality, back.body.expertise], [{ tone: 'warm', traits: [], speechNotes: '' }, []])
  assert.deepEqual([back.body.avatar, back.body.model, back.body.toolCeiling], [body.avatar, body.model, body.toolCeiling])
  const onlyUserPart = importAgentFile(exportAgentMarkdown(body).text.replace('대표님께는 존댓말을 쓴다.', '대표님께는 짧게 답한다.'))
  assert.deepEqual(onlyUserPart.preview.adjusted, [], 'editing only the user instructions is still an exact read')
  assert.ok(onlyUserPart.body.instructions.startsWith('대표님께는 짧게 답한다.'))
})

test('the front matter reader handles block values, lists, comments and quoting', () => {
  const text = [
    '\uFEFF---', '# a comment line', 'name: "Doc \\"Writer\\" \\u00e9"', 'description: |', '  Writes docs.', '  Second line.', '',
    'vibe: >-', '  folded', '  text', '', '  new paragraph', 'tools:', '  - Read', '  - Write  # inline comment', "emoji: '📝'",
    'color: \'#49634f\' # palette', 'model: inherit', '---', '', 'Body line', '',
  ].join('\r\n')
  const { body, preview } = importAgentFile(text)
  assert.equal(body.name, 'Doc "Writer" é')
  assert.equal(body.role, 'Writes docs. Second line.', 'a multi-line description folds into one line')
  assert.equal(body.personality.speechNotes, 'folded text\nnew paragraph')
  assert.deepEqual(body.avatar, { kind: 'emoji', value: '📝', color: '#49634f' })
  assert.equal(body.model, null, "'inherit' leaves the model to EG-Desk")
  assert.deepEqual(body.toolCeiling, { browser: 'none', files: 'write', terminal: 'none', network: 'off', mcp: 'none' })
  assert.equal(body.instructions, 'Body line')
  assert.deepEqual(preview.adjusted, [{ field: 'toolCeiling', reason: 'narrowed-by-tool-list' }])
  const plainHash = importAgentFile('---\nname: A\ncolor: #49634f\nemoji: not an emoji\n---\nx')
  assert.deepEqual([plainHash.body.avatar, plainHash.preview.adjusted], [null, [{ field: 'emoji', reason: 'not-one-emoji' }]], "an unquoted '#' starts a YAML comment")
  const long = importAgentFile(`---\nname: ${'n'.repeat(50)}\nvibe: ${'v'.repeat(600)}\n---\nx`)
  assert.deepEqual([long.body.name.length, long.body.personality.speechNotes.length, long.preview.adjusted.map(item => item.field)], [40, 500, ['name', 'vibe']])
})

test('files that cannot become an Agent are refused before anything is made', () => {
  const ok = body => `---\nname: A\n---\n${body}`
  const cases = [
    ['', undefined, 'AGENT_FILE_INVALID'],
    ['# Just markdown\n\nNo front matter.', undefined, 'AGENT_FILE_FORMAT'],
    ['name = "reviewer"\ndeveloper_instructions = "x"\n', 'reviewer.toml', 'AGENT_FILE_FORMAT'],
    [ok('x'), 'reviewer.TOML', 'AGENT_FILE_FORMAT'],
    ['---\nname: A\nbody', undefined, 'AGENT_FILE_INVALID'],
    ['---\nname: A\nname: B\n---\nx', undefined, 'AGENT_FILE_INVALID'],
    ['---\nname A\n---\nx', undefined, 'AGENT_FILE_INVALID'],
    ['---\n  name: A\n---\nx', undefined, 'AGENT_FILE_INVALID'],
    ['---\ndescription: no name\n---\nx', undefined, 'AGENT_FILE_INVALID'],
    ["---\nname: 'unclosed\n---\nx", undefined, 'AGENT_FILE_INVALID'],
    ['---\nname: "bad \\q escape"\n---\nx', undefined, 'AGENT_FILE_INVALID'],
    ["---\nname: 'A' trailing\n---\nx", undefined, 'AGENT_FILE_INVALID'],
    ['---\nname: A\ndescription: |x\n---\nx', undefined, 'AGENT_FILE_INVALID'],
    [ok('가'.repeat(MAX_IMPORTED_INSTRUCTIONS + 1)), undefined, 'AGENT_FILE_TOO_LONG'],
    [ok('a'.repeat(MAX_AGENT_FILE_BYTES)), undefined, 'AGENT_FILE_TOO_LARGE'],
    [ok('a\u0000b'), undefined, 'INVALID_PROFILE'],
    ['---\nname: A\negdesk: {"v": 2}\n---\nx', undefined, 'AGENT_FILE_INVALID'],
    ['---\nname: A\negdesk: {"v": 1, "systemPrompt": "x"}\n---\nx', undefined, 'AGENT_FILE_INVALID'],
    ['---\nname: A\negdesk: {v: 1}\n---\nx', undefined, 'AGENT_FILE_INVALID'],
    ['---\nname: A\negdesk: {"v": 1, "personality": {"tone": "angry"}}\n---\nx', undefined, 'INVALID_PROFILE'],
    [`---\nname: A\n${Array.from({ length: 201 }, (_, i) => `k${i}: v`).join('\n')}\n---\nx`, undefined, 'AGENT_FILE_INVALID'],
  ]
  for (const [text, filename, code] of cases) rejects(() => importAgentFile(text, { filename }), code)
  rejects(() => importAgentFile(ok('x'), { filename: 7 }), 'AGENT_FILE_INVALID')
  assert.equal(importAgentFile(ok('가'.repeat(MAX_IMPORTED_INSTRUCTIONS))).body.instructions.length, MAX_IMPORTED_INSTRUCTIONS, 'exactly 8000 characters still fit')
})

test('file names keep letters of any script', () => {
  assert.equal(agentFileName('Code Reviewer'), 'code-reviewer.md')
  assert.equal(agentFileName('리오', 'codex-toml'), '리오.toml')
  assert.equal(agentFileName('../a/b:c'), 'a-b-c.md')
  assert.equal(agentFileName('...'), 'agent.md')
  assert.equal(agentFileName('가'.repeat(80)), `${'가'.repeat(60)}.md`)
})

test('Agent files omit local model slots even when an import explicitly names a valid slot', () => {
  for (const engineProfileId of ['claude-default', 'claude-abcdef01']) {
    const original = rio({ model: { ...rio().model, engineProfileId } })
    const md = exportAgentMarkdown(original)
    assert.deepEqual(md.omitted, ['engineProfileId'])
    assert.doesNotMatch(md.text, /engineProfileId|claude-default|claude-abcdef01/)
    assert.deepEqual(importAgentFile(md.text).body.model, rio().model)
    const encoded = fieldOf(parts(md.text).head, 'egdesk')
    const block = JSON.parse(encoded)
    const text = id => md.text.replace(encoded, () => JSON.stringify({ ...block, model: { ...block.model, engineProfileId: id } }))
    const incoming = importAgentFile(text(engineProfileId))
    assert.deepEqual(incoming.body.model, rio().model)
    assert.deepEqual(incoming.preview.model, rio().model)
    assert.ok(incoming.preview.adjusted.some(item => item.field === 'model.engineProfileId'))
    rejects(() => importAgentFile(text('codex-default')), 'INVALID_PROFILE')
  }
  const toml = exportCodexAgentToml(rio({ model: { engine: 'codex', modelId: 'gpt-5.5', engineProfileId: 'codex-default' } }))
  assert.deepEqual(toml.omitted, ['engineProfileId'])
  assert.doesNotMatch(toml.text, /engineProfileId|codex-default/)
})
