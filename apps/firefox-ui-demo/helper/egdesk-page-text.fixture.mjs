import { afterEach, beforeEach } from 'node:test'
import { PAGE_TEXT_FLAG } from './egdesk-browser-reflex.mjs'

// L8 a1 (Main 17:1x): the page's own text is not sent to the decision model by default (PAGE_TEXT_FLAG off). A test whose expectation pins what was sent WITH the page text (request
// bytes measured before this default, or a double that reads the page's lines) is not changed: it runs with the flag on, and only it. pageTextFor(prefixes) marks those tests of a file by
// the start of their names (a function of the name works too); every other test of the file runs with the default.
export function pageTextFor(match) {
  const hit = typeof match === 'function' ? match : name => match.some(prefix => String(name).startsWith(prefix))
  let set = false
  beforeEach(t => { if (hit(t.name)) { process.env[PAGE_TEXT_FLAG] = 'on'; set = true } })
  afterEach(() => { if (set) { delete process.env[PAGE_TEXT_FLAG]; set = false } })
}
