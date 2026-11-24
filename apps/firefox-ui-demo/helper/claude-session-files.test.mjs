// Deleting the files Claude Code keeps for one conversation (helper/claude-session-files.mjs), on fake files in a temp folder. No Claude
// binary, no real ~/.claude. The layout is the one Anthropic's public docs name (see the module header).
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClaudeEngineAdapter } from './claude-engine-adapter.mjs'
import { belongsToSession, deleteClaudeSessionFiles } from './claude-session-files.mjs'

const ID = '5b16ffd3-c8e8-462b-8223-849a55a92f92', OTHER = '26795d81-809d-4077-b09b-b9afb9ce7f91'
const world = t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'egd-claude-')); chmodSync(root, 0o700)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const config = path.join(root, '.claude'), put = (rel, text = 'x') => { const f = path.join(config, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); return f }
  return { root, config, put, has: rel => existsSync(path.join(config, rel)) }
}
const fill = (w, id, project = '-Users-me-code-app') => {
  for (const rel of [`projects/${project}/${id}.jsonl`, `projects/${project}/${id}.jsonl.superseded-20261101`, `projects/${project}/${id}.orphaned-20261101-ab12.jsonl`,
    `projects/${project}/${id}/subagents/a.jsonl`, `projects/${project}/${id}/tool-results/r.txt`, `projects/${project}/${id}/mcp-tasks/t.json`,
    `file-history/${id}/snap1`, `image-cache/${id}/i.png`, `uploads/${id}/u.png`, `dev-mods/${id}/m.js`]) w.put(rel, `secret of ${id}`)
}

test('exact names of one session id, nothing else', () => {
  for (const name of [`${ID}.jsonl`, ID, `${ID}.orphaned-1-ab.jsonl`, `${ID}.jsonl.superseded-1`]) assert.equal(belongsToSession(name, ID), true, name)
  for (const name of [`${OTHER}.jsonl`, `x${ID}.jsonl`, `${ID}.txt`, `${ID}x`, `${ID}.orphaned-1.json`, 'memory', `${ID.slice(0, 30)}.jsonl`]) assert.equal(belongsToSession(name, ID), false, name)
})

test('removes the session\'s transcripts and keyed folders from every project folder, and leaves everything else', t => {
  const w = world(t)
  fill(w, ID); fill(w, ID, '-Users-me-other'); fill(w, OTHER)
  w.put('projects/-Users-me-code-app/memory/MEMORY.md'); w.put('history.jsonl', '{"prompt":"hi"}'); w.put('settings.json', '{}'); w.put('projects/-Users-me-code-app/notes.jsonl'); w.put('debug/d.log'); w.put('plans/p.md')
  const keep = ['projects/-Users-me-code-app/memory/MEMORY.md', 'history.jsonl', 'settings.json', 'projects/-Users-me-code-app/notes.jsonl', 'debug/d.log', 'plans/p.md']
  const out = deleteClaudeSessionFiles({ configDir: w.config, sessionId: ID, recorded: true })
  assert.deepEqual(out, { state: 'deleted', files: 2 * 4 + 4 }, 'entries removed: per project the transcript, its two set-aside copies and the session folder; the four keyed folders once')
  for (const project of ['-Users-me-code-app', '-Users-me-other']) assert.deepEqual(readdirSync(path.join(w.config, 'projects', project)).filter(n => n.startsWith(ID)), [])
  for (const dir of ['file-history', 'image-cache', 'uploads', 'dev-mods']) assert.equal(w.has(`${dir}/${ID}`), false)
  for (const rel of keep) assert.equal(w.has(rel), true, `kept ${rel}`)
  for (const rel of [`projects/-Users-me-code-app/${OTHER}.jsonl`, `projects/-Users-me-code-app/${OTHER}/subagents/a.jsonl`, `file-history/${OTHER}/snap1`, `dev-mods/${OTHER}/m.js`]) assert.equal(w.has(rel), true, `another session: ${rel}`)
  assert.deepEqual(deleteClaudeSessionFiles({ configDir: w.config, sessionId: ID, recorded: true }), { state: 'deleted', files: 0 }, 'again: nothing is left to remove')
})

test('refuses anything it cannot prove: no record, a bad id, a relative folder; never follows a link; a folder that does not exist is nothing to delete', t => {
  const w = world(t); fill(w, ID)
  const before = () => JSON.stringify(readdirSync(path.join(w.config, 'projects', '-Users-me-code-app')).sort())
  const snap = before()
  assert.deepEqual(deleteClaudeSessionFiles({ configDir: w.config, sessionId: ID }), { state: 'remains', files: 0, reason: 'not_recorded' })
  assert.deepEqual(deleteClaudeSessionFiles({ configDir: w.config, sessionId: ID, recorded: false }), { state: 'remains', files: 0, reason: 'not_recorded' })
  for (const sessionId of ['../etc', ID.toUpperCase(), `${ID}/..`, '', null, 'projects']) assert.equal(deleteClaudeSessionFiles({ configDir: w.config, sessionId, recorded: true }).reason, 'invalid', String(sessionId))
  assert.equal(deleteClaudeSessionFiles({ configDir: 'relative/.claude', sessionId: ID, recorded: true }).reason, 'invalid')
  assert.equal(before(), snap, 'nothing was removed by a refusal')
  assert.deepEqual(deleteClaudeSessionFiles({ configDir: path.join(w.root, 'no-such'), sessionId: ID, recorded: true }), { state: 'deleted', files: 0 })
  // A link named like the session is not followed or removed; the rest is removed and the result says something remains.
  const target = path.join(w.root, 'outside.txt'); writeFileSync(target, 'precious')
  rmSync(path.join(w.config, `projects/-Users-me-code-app/${ID}.jsonl`)); symlinkSync(target, path.join(w.config, `projects/-Users-me-code-app/${ID}.jsonl`))
  const out = deleteClaudeSessionFiles({ configDir: w.config, sessionId: ID, recorded: true })
  assert.deepEqual([out.state, out.reason], ['remains', 'linked']); assert.equal(out.files, 3 + 4)
  assert.equal(existsSync(target), true, 'the link target is untouched'); assert.equal(w.has(`file-history/${ID}`), false)
  // A linked projects/ folder is not entered.
  const w2 = world(t); fill(w2, ID)
  const real = path.join(w2.root, 'real-projects'); mkdirSync(path.dirname(real), { recursive: true })
  rmSync(real, { recursive: true, force: true }); mkdirSync(real); writeFileSync(path.join(real, `${ID}.jsonl`), 'x')
  rmSync(path.join(w2.config, 'projects'), { recursive: true }); symlinkSync(real, path.join(w2.config, 'projects'))
  assert.equal(deleteClaudeSessionFiles({ configDir: w2.config, sessionId: ID, recorded: true }).reason, 'linked'); assert.equal(existsSync(path.join(real, `${ID}.jsonl`)), true)
})

test('a file owned by someone else is not removed', t => {
  const w = world(t); fill(w, ID)
  const out = deleteClaudeSessionFiles({ configDir: w.config, sessionId: ID, recorded: true, uid: (process.getuid?.() ?? 0) + 1 })
  assert.deepEqual([out.state, out.reason, out.files], ['remains', 'not_owner', 0]); assert.equal(w.has(`file-history/${ID}/snap1`), true)
})

test('the adapter: off by default (refused); on, it closes the session, removes the files of a recorded id under the profile\'s config folder, and says what remains', async t => {
  const w = world(t), profileDir = path.join(w.root, 'profile-a'), mk = (extra = {}) => createClaudeEngineAdapter({ defaultCwd: w.root, env: { HOME: w.root }, claudeHome: w.root, platform: process.platform, ...extra })
  fill(w, ID)
  const off = mk()
  assert.equal(off.threadDeleteSupported(), false)
  await assert.rejects(off.deleteThread(ID, undefined, { recorded: true }), { code: 'THREAD_DELETE_UNSUPPORTED' }); assert.equal(w.has(`file-history/${ID}`), true)
  const on = mk({ deleteSessionFiles: () => true })
  assert.equal(on.threadDeleteSupported(), true)
  assert.deepEqual(await on.deleteThread(ID, undefined, { recorded: false }), { state: 'remains', files: 0, reason: 'not_recorded' }); assert.equal(w.has(`file-history/${ID}`), true)
  assert.deepEqual(await on.deleteThread(ID.toUpperCase(), 'claude-default', { recorded: true }), { state: 'deleted', files: 8 }, 'the default folder is <home>/.claude')
  // An owned profile's folder; an unknown profile touches nothing.
  const dir = path.join(profileDir); mkdirSync(path.join(dir, 'projects/-p'), { recursive: true }); writeFileSync(path.join(dir, `projects/-p/${ID}.jsonl`), 'x')
  const profiles = () => [{ id: 'claude-default', owned: false, active: false, configDir: null }, { id: 'claude-a', owned: true, active: true, configDir: dir }]
  const withProfile = mk({ deleteSessionFiles: () => true, profiles })
  assert.deepEqual(await withProfile.deleteThread(ID, 'claude-zz', { recorded: true }), { state: 'remains', files: 0, reason: 'profile_unavailable' }); assert.equal(existsSync(path.join(dir, `projects/-p/${ID}.jsonl`)), true)
  assert.deepEqual(await withProfile.deleteThread(ID, 'claude-a', { recorded: true }), { state: 'deleted', files: 1 }); assert.equal(existsSync(path.join(dir, `projects/-p/${ID}.jsonl`)), false)
  // CLAUDE_CONFIG_DIR moves the default folder (docs); a relative value is ignored.
  const moved = path.join(w.root, 'moved'); mkdirSync(path.join(moved, 'projects/-q'), { recursive: true }); writeFileSync(path.join(moved, `projects/-q/${ID}.jsonl`), 'x')
  assert.deepEqual(await mk({ deleteSessionFiles: () => true, env: { HOME: w.root, CLAUDE_CONFIG_DIR: moved } }).deleteThread(ID, undefined, { recorded: true }), { state: 'deleted', files: 1 })
})

// ---- through the runtime: the conversation delete asks the Claude adapter, with the id EG-Desk's own chat store bound -------------------
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'

test('runtime: deleting a stored Claude conversation reports deleted|remains per the flag and the record; Codex is not asked to delete Claude files', async t => {
  const w = world(t); fill(w, ID); fill(w, OTHER)
  const dataDir = path.join(w.root, 'chat'); mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const store = openChatStore({ dataDir, ownerScope: 'synthetic-claude-delete' }); t.after(() => store.close())
  const calls = []
  const runtime = flag => new CodexChatRuntime({ store, requireStore: true, getOwnerKey: () => 'k', respond() {}, emit() {}, emitLegacy() {},
    request: async method => { calls.push(method); return {} },
    engines: [createCodexEngineAdapter({ request: async method => { calls.push(method); return {} }, respond() {} }),
      createClaudeEngineAdapter({ defaultCwd: w.root, env: { HOME: w.root }, claudeHome: w.root, deleteSessionFiles: () => flag })] })
  const room = (name, conversationId) => { store.createConversation({ clientThreadId: name, localConversationId: `local-${name}`, title: name, createdAt: 1 })
    store.bindNative({ clientThreadId: name, conversationId, engineId: 'claude', engineProfileId: 'claude-default' }) }
  room('claude-room', ID)
  const off = await runtime(false).forgetConversation('claude-room')
  assert.deepEqual(off.engineHistory, [{ conversationId: ID, engineId: 'claude', state: 'remains', reason: 'unsupported' }])
  assert.equal(off.history.deleted, true); assert.equal(w.has(`file-history/${ID}`), true, 'flag off: no Claude file is touched')
  room('claude-room-2', ID)
  const on = await runtime(true).forgetConversation('claude-room-2')
  assert.deepEqual(on.engineHistory, [{ conversationId: ID, engineId: 'claude', state: 'deleted', files: 8 }])
  assert.equal(w.has(`file-history/${ID}`), false); assert.equal(w.has(`projects/-Users-me-code-app/${ID}.jsonl`), false)
  assert.equal(w.has(`projects/-Users-me-code-app/${OTHER}.jsonl`), true, 'another session is untouched')
  assert.deepEqual(calls.filter(m => m === 'thread/delete'), [], 'the Codex adapter is never asked to delete a Claude thread')
})
