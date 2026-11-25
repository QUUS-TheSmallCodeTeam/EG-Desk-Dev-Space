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
