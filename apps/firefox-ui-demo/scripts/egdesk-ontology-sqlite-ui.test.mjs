import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createOntologyZone } from '../overlay/resources/surface/EGDeskSurfaceOntology.mjs'
import { transformQaFixtureSource } from './egdesk-qa-fixture-isolation.mjs'

class Element {
  constructor(tag, props = {}, children = []) {
    this.tag = tag
    this.props = props
    this.className = props.class || ''
    this.style = typeof props.style === 'object' ? { ...props.style } : {}
    this.children = []
    this.parent = null
    this.listeners = {}
    this.classList = { add() {}, remove() {}, contains() { return false } }
    this.append(...children)
  }
  append(...children) { for (const child of children) this.appendChild(child) }
  appendChild(child) { if (child instanceof Element) child.parent = this; this.children.push(child); return child }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null }
  addEventListener(name, handler) { this.listeners[name] = handler }
  removeEventListener() {}
  set textContent(value) { this.children = value ? [value] : [] }
  get textContent() { return this.children.map(child => child instanceof Element ? child.textContent : child).join('') }
}

function fixture(t, respond) {
  const oldFetch = globalThis.fetch
  const oldDocument = globalThis.document
  const requests = []
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return respond(url, options) }
  globalThis.document = { addEventListener() {}, removeEventListener() {} }
  const identity = new Element('div'), body = new Element('div'), root = new Element('div')
  const cleanup = []
  const desk = { root, slots: { identity, content: body }, onResize() {}, registerCleanup(fn) { cleanup.push(fn) } }
  const zone = createOntologyZone({
    ONTOLOGY_GRAPH_URL: 'chrome://userchrome/content/ontology/graph.json',
    allocCardSeq: () => 1,
    el: (tag, props, ...children) => new Element(tag, props, children),
    focusCanvasCard() {}, focusOpenSourceCard: () => null, raiseCardZ: () => 1,
    resolveCanvasCardPlacement: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    revealPlacedCanvasCard() {}, singletonSourceRef: () => ({}), spawnDeskWindowShell: () => desk,
    svgEl: () => { throw new Error('Empty snapshots should not create SVG elements') },
    syncOntologyPresentationState() {},
  })
  const card = zone.spawnOntologyMapCard()
  t.after(() => {
    cleanup.forEach(fn => fn())
    globalThis.fetch = oldFetch
    globalThis.document = oldDocument
  })
  return { card, body, requests }
}

const profile = 'a'.repeat(64), token = 'b'.repeat(64)
const marker = { version: 1, profileId: profile, token }
const graph = label => ({ schemaVersion: 3, nodes: [], snapshots: [], occurrences: [], referenceEdges: [], label })
const response = (status, body, responseProfile = profile) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
  headers: { get: name => name.toLowerCase() === 'x-egdesk-ontology-profile' ? responseProfile : null },
})
const settled = () => new Promise(resolve => setImmediate(resolve))

test('ontology UI reads the profile-bound bridge and preserves the existing graph on a failed retry', async t => {
  let mode = 'first'
  const { card, body, requests } = fixture(t, url => {
    if (url.endsWith('egdesk-ontology-binding.json')) return response(200, marker)
    if (url.endsWith('/ontology/graph')) return mode === 'fail' ? response(503, { code: 'ONTOLOGY_STORE_UNAVAILABLE', error: '/private/path' }) : response(200, graph(mode))
    throw new Error(`Unexpected source ${url}`)
  })
  await settled()
  assert.equal(card._ontologyGraph.label, 'first')
  assert.equal(card._ontologyState.activeLayer, 'virtual')
  const bridge = requests.find(entry => entry.url.endsWith('/ontology/graph'))
  assert.equal(bridge.options.headers['X-EGDesk-Ontology-Profile'], profile)
  assert.equal(bridge.options.headers['X-EGDesk-Ontology-Token'], token)
  assert.equal(requests.some(entry => entry.url.endsWith('/ontology/graph.json')), false)
  mode = 'fail'
  await card._ontologyReload()
  assert.equal(card._ontologyGraph.label, 'first')
  assert.match(body.textContent, /저장소를 불러오지 못했습니다/)
  assert.doesNotMatch(body.textContent, /private|path/)
  const alert = body.children.find(child => child.props?.role === 'alert')
  assert.ok(alert)
  mode = 'second'
  alert.children.find(child => child.tag === 'button').props.onclick()
  await settled()
  assert.equal(card._ontologyGraph.label, 'second')
  assert.equal(body.children.some(child => child.props?.role === 'alert'), false)
})

test('a wrong-profile bridge produces a bounded retryable error without loading the bundled graph', async t => {
  const { card, body, requests } = fixture(t, url => url.endsWith('egdesk-ontology-binding.json')
    ? response(200, marker) : response(409, { code: 'ONTOLOGY_PROFILE_MISMATCH' }))
  await settled()
  assert.equal(card._ontologyGraph, undefined)
  assert.match(body.textContent, /다른 Firefox 프로필/)
  assert.match(body.textContent, /다시 시도/)
  assert.equal(requests.length, 2)
  assert.ok(requests.every(entry => !entry.url.endsWith('/ontology/graph.json')))
})

test('invalid bridge graph fails schema validation without replacing the existing view', async t => {
  let failure = null
  const { card, body } = fixture(t, url => url.endsWith('egdesk-ontology-binding.json')
    ? response(200, marker) : response(200, failure === 'schema' ? { schemaVersion: 2 } : failure === 'render' ? { ...graph('invalid'), nodes: [null] } : graph('saved')))
  await settled()
  failure = 'schema'
  await card._ontologyReload()
  assert.equal(card._ontologyGraph.label, 'saved')
  assert.match(body.textContent, /저장소를 불러오지 못했습니다/)
  failure = 'render'
  await card._ontologyReload()
  assert.equal(card._ontologyGraph.label, 'saved', 'a rendering failure cannot replace the last good graph')
  assert.match(body.textContent, /composite snapshot/)
})

test('missing or wrong response binding is rejected before graph JSON can replace the view', async t => {
  let responseProfile = profile
  let jsonReads = 0
  const { card, body } = fixture(t, url => {
    if (url.endsWith('egdesk-ontology-binding.json')) return response(200, marker)
    const result = response(200, graph('saved'), responseProfile)
    result.json = async () => { jsonReads++; return graph('saved') }
    return result
  })
  await settled()
  assert.equal(jsonReads, 1)
  assert.equal(card._ontologyGraph.label, 'saved')
  for (const bad of [null, 'f'.repeat(64)]) {
    responseProfile = bad
    await card._ontologyReload()
    assert.equal(jsonReads, 1, 'an unbound response body is never trusted')
    assert.equal(card._ontologyGraph.label, 'saved')
    assert.match(body.textContent, /다른 Firefox 프로필/)
  }
})

test('isolated Firefox copies rewrite only the exact ontology endpoint to the fixture port', () => {
  const source = readFileSync(new URL('../overlay/resources/surface/EGDeskSurfaceOntology.mjs', import.meta.url), 'utf8')
  const result = transformQaFixtureSource('resources/surface/EGDeskSurfaceOntology.mjs', source, 39220)
  assert.equal(result.replacements.endpointUrls, 1)
  assert.match(result.text, /http:\/\/127\.0\.0\.1:39220\/ontology\/graph/)
  assert.doesNotMatch(result.text, /http:\/\/127\.0\.0\.1:39218/)
  assert.throws(() => transformQaFixtureSource('resources/surface/EGDeskSurfaceOntology.mjs', "fetch('http://127.0.0.1:39218/not-ontology')", 39220), /unapproved/)
})
