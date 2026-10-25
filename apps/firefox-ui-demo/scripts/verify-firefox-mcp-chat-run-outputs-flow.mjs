#!/usr/bin/env node
// Main-only execution. Importing this verifier starts no browser, process,
// listener or profile. The product UI is never injected or replaced.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { qaBridgeConfig, validateQaFixtureIsolation } from './egdesk-qa-fixture-isolation.mjs'
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs'
import { chatRunOutputsFixtureEnabled, chatRunOutputFixtureIds, CHAT_RUN_OUTPUT_MARKER,
  CHAT_RUN_DIFF_MARKER, CHAT_RUN_OUTPUT_DELTA } from './egdesk-chat-run-outputs-fixture.mjs'

const PANEL = '#egd-codex-activity-panel'
const ACTIVITY_BODY = `${PANEL} .egd-codex-activity-body`
const RUN_OUTPUT_MODULES = Object.freeze(['EGDeskChatRunResult.sys.mjs', 'EGDeskChatChangeReview.sys.mjs',
  'EGDeskRunResult.sys.mjs', 'EGDeskDiffView.sys.mjs', 'EGDeskChangeReview.mjs'].map(name => `resources/${name}`))
export const runOutputActivitySelector = id => `${PANEL} .egd-codex-activity-row[data-activity-id=${JSON.stringify(id)}]`
export const runOutputApprovalSelector = id => `${PANEL} [data-testid="chat-approval"][data-approval-id=${JSON.stringify(id)}]`

// Call only with the standard validator's return value: that validator compares
// the manifest to current repository sources AND hashes the actual profile copy.
// These five presentation modules must be present and byte-identical, with no
// endpoint substitution or synthetic function-body replacement of their own.
export function assertRunOutputModuleProvenance(manifest) {
  const modules = {}
  for (const name of RUN_OUTPUT_MODULES) {
    assert.ok(manifest?.files && Object.hasOwn(manifest.files, name), `Missing run-output module provenance: ${name}`)
    const entry = manifest.files[name]
    assert.match(entry?.originalSha256 || '', /^[a-f0-9]{64}$/, `Invalid original module hash: ${name}`)
    assert.equal(entry.transformedSha256, entry.originalSha256, `Presentation module must be byte-identical: ${name}`)
    assert.deepEqual(entry.replacements, { endpointUrls: 0, helperPortConstants: 0 }, `Presentation module must not be rewritten: ${name}`)
    assert.equal(Object.hasOwn(entry, 'projectPickerTransform'), false, `No synthetic body replacement: ${name}`)
    modules[name] = { originalSha256: entry.originalSha256, transformedSha256: entry.transformedSha256,
      replacements: { ...entry.replacements } }
  }
  return modules
}

export function chatRunOutputsOptions(argv, env = process.env, now = Date.now()) {
  const values = new Map()
  for (let i = 0; i < argv.length; i += 2) {
    assert.ok(['--profile', '--deadline-utc'].includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--') && !values.has(argv[i]),
      'Expected --profile PATH and optional --deadline-utc UTC_ISO_TIMESTAMP')
    values.set(argv[i], argv[i + 1])
  }
  const profile = values.get('--profile')
  assert.ok(profile && path.isAbsolute(profile), 'An explicit absolute QA profile is required')
  assert.equal(chatRunOutputsFixtureEnabled(env), true, 'Explicit run-outputs fixture mode required')
  assert.notEqual(env.EGDESK_QA_CLAUDE_FIXTURE, '1', 'This verifier uses the ordinary synthetic Codex scenario, not a Claude fixture')
  assert.equal(env.MOZ_HEADLESS, '1', 'This verifier is Main-owned headless-only QA')
  assert.equal(String(env.EGDESK_MARIONETTE_PORT || '2829'), '2829', 'Only the Main-owned QA Marionette port is allowed')
  const bridge = qaBridgeConfig(env)
  assert.ok(![2828, 2829, 6000, 6001].includes(bridge.port), 'Fixture cannot share an automation port')
  assert.ok(typeof env.EGDESK_QA_FIXTURE_TOKEN === 'string' && env.EGDESK_QA_FIXTURE_TOKEN.length >= 16, 'Fixture control token required')
  const utc = values.get('--deadline-utc')
  if (utc) assert.match(utc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/, 'Expected an explicit UTC deadline')
  const deadlineMs = utc ? Date.parse(utc) : now + 6 * 60_000
  assert.ok(Number.isFinite(deadlineMs) && deadlineMs > now && deadlineMs - now <= 15 * 60_000, 'QA deadline must be future and within 15 minutes')
  return { profile, bridge, deadlineMs }
}

// A fresh profile intentionally starts in the Browser's focus view with the
// Dock hidden. Use the same native zoom-out as the existing Chat/Project QA;
// never reveal the Dock by editing state, styles, DOM, or product functions.
export async function prepareRunOutputDesk(harness, { deadlineMs, readFirstUse, waitUntil, now = Date.now }) {
  const deadline = () => assert.ok(now() < deadlineMs, 'Run-outputs initial Desk deadline reached')
  const read = async () => {
    deadline()
    const first = await readFirstUse(harness)
    const dock = await harness.inspect('#egd-dock .egd-dock-btn[data-id="chat"]')
    return { initialBrowserFocus: first.initialBrowserFocus, fullscreen: first.fullscreen,
      cardId: first.cardId, browserContextId: first.browserContextId,
      dockCount: dock.length, dockVisible: dock.length === 1 && dock[0].visible && !dock[0].disabled }
  }
  const before = await read()
  const needsExit = before.initialBrowserFocus === true || before.fullscreen === true
  if (needsExit) { deadline(); await harness.press('meta+-') }
  const ready = value => value.initialBrowserFocus === false && value.fullscreen === false && value.dockVisible === true
  const after = !needsExit && ready(before) ? before : await waitUntil(read, ready, { timeoutMs: 10000, intervalMs: 100 })
  deadline()
  assert.ok(ready(after), 'The native Desk must expose one usable Chat Dock control before creating a room')
  assert.equal(after.cardId, before.cardId, 'Leaving focus preserves the existing Browser')
  assert.equal(after.browserContextId, before.browserContextId, 'Leaving focus must not recreate the Browser context')
  return { action: needsExit ? 'native first-use zoom-out' : 'already-ready', before, after }
}

export function assertRunOutputsPeer(peer, options) {
  assert.equal(peer.fixture, true)
  assert.equal(peer.runOutputsFixture, true, 'The run-outputs sidecar must be explicitly enabled')
  assert.notEqual(peer.projectFileFixture, true, 'Project and retained-output scenarios must remain disjoint')
  assert.notEqual(peer.claudeFixture, true)
  assert.equal(peer.profile, options.profile)
  for (const key of ['host', 'port', 'origin']) assert.equal(peer[key], options.bridge[key])
  assert.equal(peer.providerTurns, 0)
  assert.equal(peer.runOutputs?.enabled, true)
  assert.equal(peer.runOutputs.disposed, false)
  assert.deepEqual(peer.runOutputs.effects, { providerTurns: 0, shellExecutions: 0, fileWrites: 0, approvalPosts: 0 })
  assert.equal(peer.observed?.approvalPostAttempts, 0, 'Approval POST attempts, including rejected requests, must remain zero')
  assert.equal(peer.observed.approvals.length, 0, 'Recorded approval submissions must remain zero')
}

export function assertRunOutputReadOnly(before, after) {
  for (const peer of [before, after]) {
    assert.equal(peer.observed?.approvalPostAttempts, 0, 'Before and after viewing, even rejected approval POST attempts must be zero')
    assert.equal(peer.observed.approvals.length, 0, 'Before and after viewing, recorded approval submissions must be zero')
  }
  assert.deepEqual(after.observed, before.observed, 'Opening retained data must not send, approve, resume, interrupt or emit SSE')
  assert.deepEqual(after.runs, before.runs, 'Viewing cannot mutate pending approvals or run state')
  assert.deepEqual(after.runOutputs.scenarios, before.runOutputs.scenarios)
  assert.deepEqual(after.runOutputs.effects, { providerTurns: 0, shellExecutions: 0, fileWrites: 0, approvalPosts: 0 })
  assert.deepEqual(after.runOutputs.retainedRunKeys, before.runOutputs.retainedRunKeys)
  assert.equal(after.runOutputs.retainedBytes, before.runOutputs.retainedBytes)
}

export function assertRunOutputRead(before, after, { run, route, itemId, status = 200 }) {
  assertRunOutputReadOnly(before, after)
  const previous = before.runOutputs.requests, current = after.runOutputs.requests
  assert.deepEqual(current.slice(0, previous.length), previous)
  assert.equal(current.length, previous.length + 1, 'One explicit result/diff open must issue exactly one GET')
  assert.deepEqual(current.at(-1), { method: 'GET', path: route,
    query: { conversationId: run.conversationId, runId: run.runId, itemId }, status })
}

// A deliberately separate mutation window. Unlike a GET read window, exactly
// one fixed guidance delta is expected here; no other state is ignored.
export function assertRunOutputDelta(before, after, { run, messageId }) {
  assert.ok(Number.isSafeInteger(before.seq) && typeof before.streamId === 'string' && before.streamId)
  assert.equal(messageId, `${run.runId}-output-message`)
  assert.equal(after.observed.events.length, before.observed.events.length + 1, 'Exactly one designated SSE event is allowed')
  const event = after.observed.events.at(-1)
  assert.ok(Number.isSafeInteger(event?.ts) && event.ts > 0)
  assert.deepEqual(event, { type: 'chat.event', v: 2, provider: 'codex', event: 'message.delta',
    streamId: before.streamId, seq: before.seq + 1, ts: event.ts,
    requestId: run.requestId, clientThreadId: run.clientThreadId, conversationId: run.conversationId,
    runId: run.runId, answerId: run.answerId, itemId: messageId,
    details: { messageId, delta: CHAT_RUN_OUTPUT_DELTA, phase: 'answer' } })
  const expected = structuredClone(before)
  const matches = expected.runs.filter(value => value.runId === run.runId && value.conversationId === run.conversationId)
  assert.equal(matches.length, 1)
  const messages = matches[0].messages.filter(message => message.id === messageId)
  assert.equal(messages.length, 1)
  const message = messages[0]
  assert.equal(message.role, 'assistant')
  assert.equal(message.status, 'streaming')
  assert.equal(typeof message.text, 'string')
  assert.equal(message.text.includes(CHAT_RUN_OUTPUT_DELTA.trim()), false, 'The fixed marker must not already exist')
  message.text += CHAT_RUN_OUTPUT_DELTA
  expected.seq++
  expected.observed.events.push(structuredClone(event))
  for (const peer of [before, after]) {
    assert.equal(peer.observed.approvalPostAttempts, 0)
    assert.equal(peer.observed.approvals.length, 0)
  }
  // Includes all requests, OPTIONS, approval/run state, output storage and
  // every observed operation. Only the exact message/seq/event above differs.
  assert.deepEqual(after, expected, 'Only the designated guidance message delta may mutate fixture state')
  return event
}

export function assertRunOutputViewPersistence(before, after) {
  assert.ok(before.length >= 2 && before.some(entry => entry.ui.result) && before.some(entry => entry.ui.diffCount === 1),
    'Open command output and retained diff must both participate')
  assert.ok(before.some(entry => entry.ui.localScroll.some(node => node.className.split(' ').includes('egdesk-run-result-tail')
    && node.top > 0 && node.scrollHeight > node.clientHeight)), 'Native local output scroll must be nonzero before SSE')
  const readingState = entries => entries.map(({ scope, ui }) => {
    assert.equal(ui.count, 1)
    assert.equal(ui.fileOpenButtons, 0)
    assert.ok(ui.details.length > 0 && ui.details.every(detail => detail.open), 'Previously opened disclosures must remain open')
    return { scope, count: ui.count, text: ui.text, commandState: ui.commandState, details: ui.details, localScroll: ui.localScroll,
      result: ui.result ? { outcome: ui.result.outcome, headline: ui.result.headline, tail: ui.result.tail, tailVisible: ui.result.tailVisible } : null,
      diffCount: ui.diffCount, diffVisible: ui.diffVisible, diffLines: ui.diffLines, fileOpenButtons: ui.fileOpenButtons }
  })
  assert.deepEqual(readingState(after), readingState(before), 'The same opened content and local scroll must survive unrelated SSE')
}

export function assertRunOutputUi(ui, { outcome, headline, marker, unavailable = false, diff = false }) {
  assert.equal(ui.count, 1, 'Result belongs to one original activity or approval row')
  assert.equal(ui.fileOpenButtons, 0, 'Unknown original project origin cannot enable file movement')
  if (unavailable) {
    assert.equal(ui.result, null)
    assert.equal(ui.commandState, 'missing')
    assert.match(ui.text, /저장된 명령 출력을 사용할 수 없습니다|보관된 출력 내용이 없어|출력을.*확인/)
  } else if (diff) {
    assert.equal(ui.diffCount, 1)
    assert.ok(ui.diffLines.some(line => line.kind === 'add' && line.text.includes(CHAT_RUN_DIFF_MARKER)))
    assert.ok(ui.diffLines.some(line => line.kind === 'delete' && line.text.includes('before fixture')))
    assert.equal(ui.diffVisible, true)
    assert.match(ui.text, /보존된 변경 기록 · 읽기 전용/)
    assert.match(ui.text, /현재 파일이나 적용 완료를 확인한 결과는 아닙니다/)
  } else {
    assert.equal(ui.result?.outcome, outcome)
    assert.equal(ui.result.headline, headline)
    assert.equal(ui.result.headlineVisible, true)
    assert.equal(ui.result.tailVisible, true, 'The output tail must be opened by its native summary control')
    assert.ok(ui.result.tail.includes(marker))
    assertRunOutputMetaLayout(ui.result.metadata)
    if (outcome === 'failed') assert.match(ui.text, /프로젝트 연결을 확인하지 못해 파일 열기를 제공하지 않습니다/)
  }
}

export function assertRunOutputMetaLayout(layout) {
  assert.ok(layout?.visible && Array.isArray(layout.parts) && layout.parts.length === 3, 'Command, duration and exit metadata must all render')
  assert.ok(layout.cardOverflowX <= 1 && layout.metaOverflowX <= 1, 'Result metadata must not overflow horizontally')
  const card = layout.card
  assert.ok(card && card.width > 0 && card.height > 0)
  for (const part of layout.parts) {
    assert.ok(part.width > 0 && part.height > 0 && part.left >= card.left - 0.5 && part.right <= card.right + 0.5,
      'Each metadata label must fit its result card')
  }
  for (let i = 0; i < layout.parts.length; i++) for (let j = i + 1; j < layout.parts.length; j++) {
    const a = layout.parts[i], b = layout.parts[j]
    const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
    if (overlapY <= 0.5) continue // Wrapped metadata is valid, overlapping labels are not.
    const gap = Math.max(a.left, b.left) - Math.min(a.right, b.right)
    assert.ok(gap >= 1, 'Same-line metadata requires a visible gap, not touching or overlapping text')
  }
}

export function runOutputClickAction(value) {
  const valid = box => box && ['left', 'right', 'top', 'bottom', 'width', 'height'].every(key => Number.isFinite(box[key]))
    && box.width > 0 && box.height > 0 && box.right > box.left && box.bottom > box.top
  const rect = value?.rect, body = value?.bodyRect, viewport = value?.viewport
  if (value?.count !== 1 || !value.visible || value.disabled || !valid(rect) || !valid(body) || !valid(viewport)
    || !Number.isFinite(value.scrollTop) || !Number.isFinite(value.maxScroll) || !Array.isArray(value.clips)) return 'blocked'
  const inside = (outer, x = true, y = true) => valid(outer)
    && (!x || rect.left >= outer.left && rect.right <= outer.right)
    && (!y || rect.top >= outer.top && rect.bottom <= outer.bottom)
  if (!inside(body, true, false) || !inside(viewport, true, false)) return 'blocked'
  if (rect.top < body.top && value.scrollTop > 0.5) return 'PageUp'
  if (rect.bottom > body.bottom && value.scrollTop < value.maxScroll - 0.5) return 'PageDown'
  return inside(body) && inside(viewport) && value.clips.every(clip => inside(clip.rect, clip.x, clip.y))
    && value.hittable === true ? 'ready' : 'blocked'
}

export async function observeRunOutputClickTarget(harness, selector) {
  return harness.evaluateChrome(`() => {
    const box = node => { const r = node?.getBoundingClientRect(); return r ?
      { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height } : null; };
    const matches = [...document.querySelectorAll(${JSON.stringify(selector)})], node = matches.length === 1 ? matches[0] : null;
    const body = node?.closest('.egd-codex-activity-body'), rect = box(node);
    const hit = rect && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const clips = [];
    let visible = !!node && node.isConnected;
    for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) visible = false;
      if (ancestor === node) continue;
      const x = /^(auto|scroll|hidden|clip)$/.test(style.overflowX), y = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
      if (x || y) clips.push({ rect: box(ancestor), x, y });
    }
    return { count: matches.length, tag: node?.localName, text: node?.textContent?.trim(), visible, disabled: !!node?.disabled,
      rect, bodyRect: box(body), scrollTop: body?.scrollTop, maxScroll: body ? body.scrollHeight - body.clientHeight : null, clips,
      viewport: { left:0, top:0, right:innerWidth, bottom:innerHeight, width:innerWidth, height:innerHeight },
      hittable: !!node && !!hit && (node === hit || node.contains(hit)) };
  }`)
}

// Three stable observations precede either native scrolling or a single click.
// display/size alone is insufficient: the activity body may clip the target.
export async function ensureRunOutputTarget(harness, selector, { waitUntil, deadlineMs, trace = [], expected = null }) {
  assert.equal(typeof waitUntil, 'function')
  const deadline = () => assert.ok(Date.now() < deadlineMs, 'Native result control deadline reached')
  for (let scrolls = 0; scrolls <= 8; scrolls++) {
    let previous = null, stable = 0
    const target = await waitUntil(async () => { deadline(); return observeRunOutputClickTarget(harness, selector) }, value => {
      const snapshot = JSON.stringify(value)
      stable = snapshot === previous ? stable + 1 : 1
      previous = snapshot
      return stable >= 3
    }, { timeoutMs: 5000, intervalMs: 100 })
    trace.push({ phase: 'observed', selector, target })
    if (expected) { assert.equal(target.tag, expected.tag); assert.equal(target.text, expected.label) }
    const action = runOutputClickAction(target)
    if (action === 'ready') return target
    assert.ok(['PageDown', 'PageUp'].includes(action) && scrolls < 8,
      `Result control is not wholly visible and hit-testable: ${JSON.stringify(target)}`)
    deadline()
    const scroll = await harness.scrollWithKey(ACTIVITY_BODY, action)
    trace.push({ phase: 'native-scroll', selector: ACTIVITY_BODY, action, scroll })
    assert.ok(scroll.overflow && scroll.moved, 'Native activity-panel scrolling must measurably move its own viewport')
  }
}

export async function clickRunOutputSelector(harness, selector, options) {
  const target = await ensureRunOutputTarget(harness, selector, options)
  options.trace?.push({ phase: 'native-click', selector, target })
  await harness.click(selector)
  return selector
}

// Chrome evaluation only observes controls and computes an unambiguous CSS
// path. Every click is delegated to the existing native MCP harness.
export async function clickRunOutputControl(harness, scope, label, tag = 'button', options) {
  assert.ok(['button', 'summary'].includes(tag), 'Only actual native result controls may be clicked')
  const selector = await harness.evaluateChrome(`() => {
    const scope = ${JSON.stringify(scope)}, label = ${JSON.stringify(label)};
    const roots = [...document.querySelectorAll(scope)];
    if (roots.length !== 1) throw new Error('Expected exactly one original result row');
    const root = roots[0];
    const choices = [...root.querySelectorAll(${JSON.stringify(tag)})].filter(node => node.textContent.trim() === label);
    if (choices.length !== 1 || choices[0].disabled) throw new Error('Expected one enabled native result control');
    const parts = [];
    for (let node = choices[0]; node !== root; node = node.parentElement) {
      if (!node?.parentElement) throw new Error('Result control left its original row');
      parts.unshift(node.localName + ':nth-child(' + ([...node.parentElement.children].indexOf(node) + 1) + ')');
    }
    return scope + ' > ' + parts.join(' > ');
  }`)
  return clickRunOutputSelector(harness, selector, { ...options, expected: { label, tag } })
}

export async function observeRunOutputUi(harness, scope) {
  return harness.evaluateChrome(`() => {
    const roots = [...document.querySelectorAll(${JSON.stringify(scope)})];
    const root = roots.length === 1 ? roots[0] : null;
    const shown = node => {
      if (!node?.isConnected) return false;
      const box = node.getBoundingClientRect(), style = getComputedStyle(node);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const card = root?.querySelector('.egdesk-run-result');
    const headline = card?.querySelector('.egdesk-run-result-headline'), tail = card?.querySelector('.egdesk-run-result-tail');
    const meta = card?.querySelector('.egdesk-run-result-meta');
    const box = node => { const r = node?.getBoundingClientRect(); return r ?
      { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height } : null; };
    const diffs = [...(root?.querySelectorAll('.egdesk-diff-view') || [])];
    return { count: roots.length, text: root?.textContent || '',
      commandState: root?.querySelector('[data-testid="chat-command-result"]')?.getAttribute('data-state') || null,
      result: card ? { outcome: card.getAttribute('data-outcome'), headline: headline?.textContent || '',
        headlineVisible: shown(headline), tail: tail?.textContent || '', tailVisible: shown(tail),
        metadata: { visible: shown(meta), card: box(card), cardOverflowX: card.scrollWidth - card.clientWidth,
          metaOverflowX: meta ? meta.scrollWidth - meta.clientWidth : Infinity,
          parts: [...(meta?.children || [])].map(box) } } : null,
      diffCount: diffs.length, diffVisible: diffs.length === 1 && shown(diffs[0]),
      diffLines: [...(root?.querySelectorAll('.egdesk-diff-line') || [])].map(line => ({ kind: line.getAttribute('data-kind'), text: line.textContent })),
      details: [...(root?.querySelectorAll('.egdesk-run-result-output, .egdesk-chat-change-review details') || [])]
        .map(node => ({ className: node.className, open: node.open })),
      localScroll: [...(root?.querySelectorAll('.egdesk-run-result-tail, .egdesk-run-result-command, .egdesk-diff-hunk, .egdesk-diff-raw') || [])]
        .map(node => ({ className: node.className, top: node.scrollTop, left: node.scrollLeft,
          scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth })),
      fileOpenButtons: [...(root?.querySelectorAll('button') || [])].filter(node =>
        node.classList.contains('egdesk-run-result-location') || node.classList.contains('egdesk-diff-open') || node.textContent.trim() === '파일 열기').length };
  }`)
}

export async function observeRunOutputDelta(harness, run, messageId) {
  return harness.evaluateChrome(`() => {
    const target = ${JSON.stringify({ conversationId: run.conversationId, runId: run.runId, messageId })};
    const marker = ${JSON.stringify(CHAT_RUN_OUTPUT_DELTA.trim())};
    const protocol = window.__egdesk?.state?.codex?.chatProtocol;
    const runs = Object.values(protocol?.runs || {}).filter(run => run.conversationId === target.conversationId && run.runId === target.runId);
    const run = runs.length === 1 ? runs[0] : null;
    const message = run?.messages?.find(value => value.id === target.messageId);
    const rows = [...document.querySelectorAll('[data-testid="chat-message"]')].filter(node =>
      node.dataset.messageId === target.messageId && node.dataset.runId === target.runId && node.dataset.role === 'assistant');
    const content = rows.length === 1 ? rows[0].querySelector('.egd-codex-bubble-content') : null;
    let visibleMarker = false;
    if (content?.isConnected) {
      const walker = document.createTreeWalker(content, 4);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const offset = text.data.indexOf(marker);
        if (offset < 0) continue;
        const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + marker.length);
        visibleMarker = [...range.getClientRects()].some(rect => {
          if (!(rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight)) return false;
          for (let node = text.parentElement; node; node = node.parentElement) {
            const style = getComputedStyle(node), clip = node.getBoundingClientRect();
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (rect.top < clip.top || rect.bottom > clip.bottom)) return false;
            if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (rect.left < clip.left || rect.right > clip.right)) return false;
          }
          return true;
        });
        if (visibleMarker) break;
      }
    }
    return { runCount: runs.length, streamId: run?.streamId, seq: run?.seq, messageStatus: message?.status,
      rawText: message?.content || '', rowCount: rows.length, text: content?.innerText || '', visibleMarker };
  }`)
}

export async function runChatRunOutputsFlow(options) {
  const moduleProvenance = assertRunOutputModuleProvenance(validateQaFixtureIsolation(options.profile))
  assertQaFixtureManifest(options.profile)
  const { runUiFlow, loopbackJson, newQaThread, sendFromComposer, visible, waitUntil } = await import('./egdesk-qa-ui-flow.mjs')
  const { observeFirstUse } = await import('./verify-firefox-mcp-headless-ui-regression.mjs')
  const deadline = () => assert.ok(Date.now() < options.deadlineMs, 'Run-outputs QA deadline reached')
  const readFixture = async () => {
    deadline()
    const peer = await loopbackJson('/__qa/state', { token: process.env.EGDESK_QA_FIXTURE_TOKEN })
    assertRunOutputsPeer(peer, options)
    return peer
  }
  await runUiFlow('chat-retained-run-outputs', async ({ harness, result, check, capture }) => {
    assert.equal(harness.profile, options.profile)
    result.nativeControls = []
    const clickOptions = { waitUntil, deadlineMs: options.deadlineMs, trace: result.nativeControls }
    result.runOutputModuleProvenance = moduleProvenance
    const initial = await waitUntil(readFixture, peer => peer.clients > 0, { timeoutMs: 10000 })
    assert.equal(initial.observed.sends.length, 0, 'Use a fresh sidecar fixture, not another QA round')
    assert.equal(initial.runs.length, 0)
    assert.equal(initial.runOutputs.requests.length, 0)
    result.initialDesk = await prepareRunOutputDesk(harness, { deadlineMs: options.deadlineMs,
      readFirstUse: observeFirstUse, waitUntil })
    check('native first-use exit exposes Chat Dock without replacing the Browser', true)
    const nonce = Date.now().toString(36)
    const thread = await newQaThread(harness, `Run outputs QA ${nonce}`)
    deadline()
    await sendFromComposer(harness, `EGDESK_QA_RUN_OUTPUTS ${nonce}`)
    const seeded = await waitUntil(readFixture, peer => peer.runs.some(run => run.clientThreadId === thread.wireClientThreadId
      && run.fixtureStage === 'run-outputs-ready'), { timeoutMs: 15000 })
    const run = seeded.runs.find(value => value.clientThreadId === thread.wireClientThreadId && value.fixtureStage === 'run-outputs-ready')
    const ids = chatRunOutputFixtureIds(run.runId)
    assert.equal(seeded.observed.sends.length, 1)
    assert.equal(seeded.runOutputs.requests.length, 0, 'Receiving metadata must not fetch retained output')
    assert.equal(run.pendingApprovals.length, 1)
    assert.equal(run.pendingApprovals[0].approvalId, ids.approval)
    assert.equal(run.pendingApprovals[0].status, 'pending')
    deadline()
    await visible(harness, '[data-testid="chat-activity-open"]')
    await harness.click('[data-testid="chat-activity-open"]')
    await visible(harness, PANEL)
    assert.equal((await readFixture()).runOutputs.requests.length, 0, 'Opening activity metadata must not fetch outputs')

    for (const [name, outcome, headline] of [['pass', 'passed', '3 통과'], ['fail', 'failed', '2 통과 · 1 실패']]) {
      const scope = runOutputActivitySelector(ids[name]), before = await readFixture()
      deadline()
      await clickRunOutputControl(harness, scope, '실행 결과 보기', 'button', clickOptions)
      await waitUntil(() => observeRunOutputUi(harness, scope), ui => ui.result?.outcome === outcome, { timeoutMs: 10000 })
      deadline()
      const summary = `${scope} .egdesk-run-result-output > summary`
      await clickRunOutputSelector(harness, summary, clickOptions)
      const ui = await waitUntil(() => observeRunOutputUi(harness, scope), value => value.result?.tailVisible, { timeoutMs: 5000 })
      const after = await readFixture()
      assertRunOutputRead(before, after, { run, route: '/chat/command-output', itemId: ids[name] })
      assertRunOutputUi(ui, { outcome, headline, marker: `${CHAT_RUN_OUTPUT_MARKER}: ${name}` })
      check(`native ${name} result opens one exact retained-output GET; no project-authority file action`, true)
      await capture(`retained-command-${name}`)
    }

    for (const [name, scope, itemId] of [['activity', runOutputActivitySelector(ids.change), ids.change],
      ['approval', runOutputApprovalSelector(ids.approval), ids.proposed]]) {
      const before = await readFixture()
      deadline()
      await clickRunOutputControl(harness, scope, '변경 보기', 'summary', clickOptions)
      const ui = await waitUntil(() => observeRunOutputUi(harness, scope), value => value.diffCount === 1 && value.diffVisible, { timeoutMs: 10000 })
      const after = await readFixture()
      assertRunOutputRead(before, after, { run, route: '/chat/run-changes', itemId })
      assertRunOutputUi(ui, { diff: true })
      check(`native ${name} diff viewing is one GET, pending approval unchanged and approval POST zero`, true)
      await capture(`retained-${name}-diff`)
    }

    // Native input establishes a meaningful local scroll position. Observing
    // or reading output never triggers SSE; only the existing explicit control
    // below advances the one still-streaming guidance message.
    const scopes = [runOutputActivitySelector(ids.pass), runOutputActivitySelector(ids.fail),
      runOutputActivitySelector(ids.change), runOutputApprovalSelector(ids.approval)]
    // Reveal the small disclosure control first; the following native key
    // targets the output scroller, not a pointer click on a large text block.
    await ensureRunOutputTarget(harness, `${scopes[0]} .egdesk-run-result-output > summary`, clickOptions)
    deadline()
    const localScroll = await harness.scrollWithKey(`${scopes[0]} .egdesk-run-result-tail`, 'End')
    assert.ok(localScroll.overflow && localScroll.moved && localScroll.after > 0, 'Native End must actually scroll the retained output locally')
    let previousTop = null, stableScroll = 0
    await waitUntil(() => observeRunOutputUi(harness, scopes[0]), ui => {
      const top = ui.localScroll.find(node => node.className.split(' ').includes('egdesk-run-result-tail'))?.top
      stableScroll = top > 0 && top === previousTop ? stableScroll + 1 : 0
      previousTop = top
      return stableScroll >= 2
    }, { timeoutMs: 5000, intervalMs: 100 })
    const readingViews = async () => {
      const views = []
      for (const scope of scopes) views.push({ scope, ui: await observeRunOutputUi(harness, scope) })
      return views
    }
    const beforeViews = await readingViews(), beforeDelta = await readFixture()
    assertRunOutputViewPersistence(beforeViews, beforeViews)
    assert.equal(beforeDelta.runOutputs.requests.length, 4)
    const messageId = `${run.runId}-output-message`
    deadline()
    assert.deepEqual(await loopbackJson('/__qa/delta', { method: 'POST', token: process.env.EGDESK_QA_FIXTURE_TOKEN,
      body: { runId: run.runId, delta: CHAT_RUN_OUTPUT_DELTA } }), { ok: true })
    const emitted = await waitUntil(readFixture, value => value.seq > beforeDelta.seq, { timeoutMs: 5000 })
    const deltaEvent = assertRunOutputDelta(beforeDelta, emitted, { run, messageId })
    const applied = await waitUntil(() => observeRunOutputDelta(harness, run, messageId), value =>
      value.runCount === 1 && value.streamId === deltaEvent.streamId && value.seq === deltaEvent.seq
      && value.messageStatus === 'streaming' && value.rowCount === 1 && value.visibleMarker
      && value.rawText.includes(CHAT_RUN_OUTPUT_DELTA) && value.text.includes(CHAT_RUN_OUTPUT_DELTA.trim()), { timeoutMs: 10000 })
    const afterViews = await readingViews(), afterDelta = await readFixture()
    assertRunOutputViewPersistence(beforeViews, afterViews)
    assertRunOutputDelta(beforeDelta, afterDelta, { run, messageId })
    check('one same-run guidance SSE preserves opened command/diff content and native local scroll without any refetch or approval POST', true)
    result.sameRunPersistence = { streamId: deltaEvent.streamId, seq: deltaEvent.seq, messageId,
      markerVisible: applied.visibleMarker, localScroll, viewsBefore: beforeViews, viewsAfter: afterViews,
      extraOutputGets: afterDelta.runOutputs.requests.length - beforeDelta.runOutputs.requests.length }
    await capture('retained-reading-survives-same-run-sse')

    deadline()
    await harness.click('[aria-label="활동 기록 닫기"]')
    const lostThread = await newQaThread(harness, `Lost run output QA ${nonce}`)
    deadline()
    await sendFromComposer(harness, `EGDESK_QA_RUN_OUTPUTS_LOST ${nonce}`)
    const forgotten = await waitUntil(readFixture, peer => peer.runs.some(value => value.clientThreadId === lostThread.wireClientThreadId
      && value.fixtureStage === 'run-outputs-lost'), { timeoutMs: 15000 })
    const lost = forgotten.runs.find(value => value.clientThreadId === lostThread.wireClientThreadId && value.fixtureStage === 'run-outputs-lost')
    const lostId = chatRunOutputFixtureIds(lost.runId).fail
    deadline()
    await visible(harness, '[data-testid="chat-activity-open"]')
    await harness.click('[data-testid="chat-activity-open"]')
    const beforeMissing = await readFixture(), scope = runOutputActivitySelector(lostId)
    await clickRunOutputControl(harness, scope, '실행 결과 보기', 'button', clickOptions)
    const missingUi = await waitUntil(() => observeRunOutputUi(harness, scope), ui => ui.commandState === 'missing', { timeoutMs: 10000 })
    const final = await readFixture()
    assertRunOutputRead(beforeMissing, final, { run: lost, route: '/chat/command-output', itemId: lostId, status: 404 })
    assertRunOutputUi(missingUi, { unavailable: true })
    assert.equal(final.observed.sends.length, 2)
    assert.equal(final.runOutputs.requests.length, 5)
    assert.deepEqual(final.runs.find(value => value.runId === run.runId).pendingApprovals, run.pendingApprovals)
    check('actually forgotten command output is unavailable, never a success or implicit execution', true)
    await capture('retained-output-unavailable')
    assert.deepEqual(assertRunOutputModuleProvenance(validateQaFixtureIsolation(options.profile)), moduleProvenance,
      'The actual profile modules must remain byte-identical throughout native QA')
    check('all five production presentation modules match their source and actual profile hashes without rewriting', true)
    result.providerTurn = 'not-run'
    result.runOutputs = { requests: final.runOutputs.requests, effects: final.runOutputs.effects,
      originalRunId: run.runId, lostRunId: lost.runId, pendingApprovalUnchanged: true,
      approvalPosts: final.observed.approvals.length, approvalPostAttempts: final.observed.approvalPostAttempts }
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runChatRunOutputsFlow(chatRunOutputsOptions(process.argv.slice(2))) }
  catch (error) { process.stderr.write(`Run-outputs fixture preflight: ${error.message}\n`); process.exitCode = 1 }
}
