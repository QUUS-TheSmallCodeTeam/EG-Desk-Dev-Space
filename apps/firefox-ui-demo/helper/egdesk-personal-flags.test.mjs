import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyPersonalFlags, readPersonalFlags, describePersonalFlags, PERSONAL_FLAGS_FILE } from './egdesk-personal-flags.mjs'

const tmpFile = content => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-personal-flags-')); const file = path.join(dir, PERSONAL_FLAGS_FILE); if (content !== undefined) fs.writeFileSync(file, content); return { dir, file } }

test('the file fills flags the env does not set; an explicit env value (including off) wins; empty string is not explicit', () => {
  const { dir, file } = tmpFile(JSON.stringify({ flags: { EGDESK_UPPER: 'on', EGDESK_NUNCHI: 'on', EGDESK_PAGE_TOOLS: 'on', EGDESK_DRAFT_CHECK: 'on' } }))
  try {
    const env = { EGDESK_NUNCHI: 'off', EGDESK_PAGE_TOOLS: '', OTHER: 'x' }
    const out = applyPersonalFlags(env, file)
    assert.deepEqual(out.applied.sort(), ['EGDESK_DRAFT_CHECK', 'EGDESK_PAGE_TOOLS', 'EGDESK_UPPER'])
    assert.deepEqual(out.kept, ['EGDESK_NUNCHI'])
    assert.equal(env.EGDESK_UPPER, 'on'); assert.equal(env.EGDESK_NUNCHI, 'off'); assert.equal(env.EGDESK_PAGE_TOOLS, 'on'); assert.equal(env.OTHER, 'x')
    assert.equal(describePersonalFlags(out), 'personal flags: 3 set from settings, 1 kept (explicitly set)')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('only EGDESK_ names with short word values are read: paths, other names, non-strings and long values are ignored; a bare object works', () => {
  const { dir, file } = tmpFile(JSON.stringify({ EGDESK_UPPER: 'on', EGDESK_CODEX_BIN: '/Applications/x/codex', PATH: '/usr/bin', OPENAI_API_KEY: 'sk-x', EGDESK_N: 1, EGDESK_LONG: 'a'.repeat(40), egdesk_lower: 'on' }))
  try { assert.deepEqual(readPersonalFlags(file), { EGDESK_UPPER: 'on' }) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('no file, a broken file or a non-object changes nothing', () => {
  const missing = tmpFile(); const broken = tmpFile('{ not json'); const array = tmpFile('["EGDESK_UPPER"]')
  try {
    for (const f of [missing.file, broken.file, array.file]) { const env = {}; assert.deepEqual(applyPersonalFlags(env, f), { applied: [], kept: [] }); assert.deepEqual(env, {}) }
  } finally { for (const t of [missing, broken, array]) fs.rmSync(t.dir, { recursive: true, force: true }) }
})
