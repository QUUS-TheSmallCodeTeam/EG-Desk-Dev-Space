import test from 'node:test'
import assert from 'node:assert/strict'
import { AUTH_OPAQUE_FLAG, authOpaqueOn, isAuthOpaqueUrl } from './egdesk-auth-opaque.mjs'

test('AI providers\' auth and account domains (host and subdomains) are opaque; look-alikes, other schemes and garbage are not', () => {
  for (const url of ['https://claude.ai/login', 'https://claude.com/cai/oauth/authorize?x=1', 'https://platform.claude.com/oauth/code/callback?code=c', 'https://console.anthropic.com/', 'https://anthropic.com', 'https://auth.openai.com/log-in', 'https://auth0.openai.com/u/login', 'https://chatgpt.com/auth/login', 'https://platform.openai.com/', 'HTTPS://CLAUDE.AI./x']) assert.equal(isAuthOpaqueUrl(url), true, url)
  for (const url of ['https://claude.com.evil.example/x', 'https://notclaude.ai/', 'https://example.com/claude.ai', 'https://openai.com/', 'file:///claude.ai', 'chrome://browser/content', 'about:blank', '', null, undefined, 'not a url']) assert.equal(isAuthOpaqueUrl(url), false, String(url))
})
test('the flag is the terminal opener\'s, exactly "on"', () => {
  assert.equal(AUTH_OPAQUE_FLAG, 'EGDESK_TERMINAL_OPEN_URL'); assert.equal(authOpaqueOn({ [AUTH_OPAQUE_FLAG]: 'on' }), true)
  for (const v of ['1', 'true', 'ON', '', undefined]) assert.equal(authOpaqueOn({ [AUTH_OPAQUE_FLAG]: v }), false)
  assert.equal(authOpaqueOn({}), false)
})

import { withoutAuthOpaqueSources } from './egdesk-auth-opaque.mjs'
import { readFileSync } from 'node:fs'
test('selected Browser Cards on a sign-in domain are dropped from the request when the flag is on, and the body is otherwise the same object', () => {
  const on = { [AUTH_OPAQUE_FLAG]: 'on' }, card = (id, uri) => ({ kind: 'browser', sourceRef: { viewId: id, uri } })
  const body = { message: 'x', selectedSources: [card('a', 'https://claude.com/cai/oauth/authorize?state=s'), card('b', 'https://example.test/'), { kind: 'file', sourceRef: {} }] }
  assert.deepEqual(withoutAuthOpaqueSources(body, on).selectedSources.map(s => s.sourceRef.viewId), ['b', undefined]); assert.equal(withoutAuthOpaqueSources(body, on).message, 'x')
  assert.equal(withoutAuthOpaqueSources(body, {}), body, 'flag off: the same object'); assert.equal(withoutAuthOpaqueSources({ message: 'y' }, on).message, 'y')
  const clean = { selectedSources: [card('b', 'https://example.test/')] }; assert.equal(withoutAuthOpaqueSources(clean, on), clean)
  assert.match(readFileSync(new URL('./codex-chat-runtime.mjs', import.meta.url), 'utf8'), /async startTurn\(body, context\) \{\n    body = withoutAuthOpaqueSources\(body\)/)
})
