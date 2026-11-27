import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const js = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8')

test('L38 perf flags are read from prefs, default off', () => {
  for (const key of ['egdesk.perf.staggerBrowserLoad', 'egdesk.perf.slowResourcePoll', 'egdesk.perf.flatFrost']) {
    const uses = js.split(`readSurfacePref('${key}') === 'on'`).length - 1
    assert.equal(uses, 1, key)
  }
  assert.match(js, /restoreInProgress === true && perfStaggerBrowserLoadEnabled\(\)/)
  assert.match(css, /:root\[egd-perf-flat-frost\] \.egd-frosted/)
})
