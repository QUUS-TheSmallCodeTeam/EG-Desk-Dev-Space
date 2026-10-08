import test from 'node:test'
import assert from 'node:assert/strict'
import { specManifestEntries, verifiedManifestOwners } from './codex-native-tool-manifest.mjs'

test('a persisted provider identity and input contract, not a current name alone, owns a native tool', () => {
  const spec = { type: 'function', name: 'shared_tool', inputSchema: { type: 'object', properties: { cardId: { type: 'string' } } } }
  const recorded = specManifestEntries(spec, 'original-provider')
  const original = { id: 'original' }, replacement = { id: 'replacement' }
  assert.equal(verifiedManifestOwners(recorded, specManifestEntries(spec, 'original-provider'), new Map([[recorded[0].key, original]])).owners.get(recorded[0].key), original)
  assert.equal(verifiedManifestOwners(recorded, specManifestEntries(spec, 'browser-provider'), new Map([[recorded[0].key, replacement]])).status, 'mismatch')
  assert.equal(verifiedManifestOwners(recorded, specManifestEntries({ ...spec, inputSchema: { type: 'string' } }, 'original-provider'), new Map([[recorded[0].key, original]])).status, 'mismatch')
  assert.equal(verifiedManifestOwners(null, specManifestEntries(spec, 'original-provider'), new Map([[recorded[0].key, original]])).owners.size, 0)
})

test('namespace tools and malformed or duplicate persisted entries fail closed', () => {
  const namespace = { type: 'namespace', name: 'egdesk_browser', tools: [{ type: 'function', name: 'observe', inputSchema: { type: 'object' } }] }
  const entries = specManifestEntries(namespace, 'browser-provider')
  assert.equal(entries[0].key, 'egdesk_browser\0observe')
  assert.equal(verifiedManifestOwners([...entries, ...entries], entries, new Map([[entries[0].key, {}]])).status, 'mismatch')
  assert.equal(verifiedManifestOwners([{ ...entries[0], schemaHash: 'bad' }], entries, new Map([[entries[0].key, {}]])).status, 'mismatch')
})
