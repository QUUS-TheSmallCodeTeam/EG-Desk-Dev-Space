// a1 (round '교대'): a Claude BROWSER conversation (browserBounded) under EG-Desk's harness.
//   D27 (real window 11-26 07:00): its answer came in English. The thread had no EG-Desk instruction at all (a bounded thread is not an own-tools thread, so the harness instructions never reached it), and
//   everything EG-Desk puts in its turns for the model (the browser task's note, tool results with their markings, a page's lines) is English or the page's language: nothing said which language the person
//   reads. Now the thread is started (and reloaded on every turn) with EG-Desk's browser-thread instructions: how to talk between tool calls (u8's line) and which language to write to the person in.
//   Hold (U8: no streaming, complete messages only): a bounded turn held only while the draft check was on and the Decision model configured (browserTaskHoldEligible); with the check off the talk between tool
//   calls was posted as its own bubble before the answer. Now a Claude browser turn under the harness holds whatever the check's setting, as its other turns do (u8 claudeHarnessHold): the talk is a work note
//   (the existing activity row) and one message, the answer (or the question to the person), is posted.
// Replays on lane L8's browser world (real runtime, adapter, MCP bridge, Browser and page-tool providers; the CLI is a script, the page is fake). Nothing real runs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { world, callTool } from './egdesk-claude-browser-world.fixture.mjs'
import { text, toolUse, userResult, until } from './egdesk-claude-harness.fixture.mjs'
import { COMMENTARY, REPLY_LANGUAGE, claudeBoundedHarnessInstructions, claudeHarnessInstructions } from './egdesk-claude-harness.mjs'

const NARRATION = 'Value is "우산" (replaced). Reading the card first.'
const ANSWER = '검색창에 우산을 입력했습니다.'
const QUESTION = '어떤 상품을 검색할까요?'
const bubbles = w => w.chat.store.listMessages('ui-claude', { limit: 50 }).messages.filter(m => m.role === 'assistant').map(m => String(m.text ?? ''))
const notes = (w, sent) => (w.runOf(sent)?.activities ?? []).filter(a => a.kind === 'workNote').map(a => String(a.detail?.text ?? ''))
const settle = async (w, sent) => { await w.settled(sent); await new Promise(r => setTimeout(r, 200)); await w.drain() }

/** Drives the open turn of a world made with hold: true as Claude's process would: the steps are texts (strings), tool calls ({ tool, args }) and finally the result. */
async function play(w, steps) {
  await until(() => typeof w.transports.at(-1)?.finish === 'function')
  const transport = w.transports.at(-1), sid = transport.options.sessionId || transport.options.resume
  const emit = message => transport.options.onMessage({ session_id: sid, ...message })
  let n = 0
  for (const step of steps) {
    n++
    if (typeof step === 'string') { for (const part of text(n, step)) emit(part.msg); continue }
    const id = `toolu_${n}`
    emit(toolUse(id, step.tool, step.args).msg)
    await callTool(w, step.tool, step.args)
    emit(userResult(id).msg)
  }
  emit({ type: 'result', subtype: 'success', is_error: false })
}

test('D27, the pure rule: a browser thread\'s instructions are the Agent\'s text first, then the commentary line, then the reply-language line; no own-tools block, no memory line', () => {
  for (const base of ['Be brief.', null, '  ']) {
    const out = claudeBoundedHarnessInstructions(base)
    assert.equal(out, [typeof base === 'string' && base.trim() ? base.trim() : null, COMMENTARY, REPLY_LANGUAGE].filter(Boolean).join('\n\n'))
    assert.equal(out.split(REPLY_LANGUAGE).length, 2, 'once'); assert.ok(out.indexOf(COMMENTARY) < out.indexOf(REPLY_LANGUAGE))
    for (const absent of ['egdesk_run_command', 'keeps the person\'s memory', 'Bash, Edit, Write']) assert.ok(!out.includes(absent), absent)
  }
  assert.match(REPLY_LANGUAGE, /in the language they write to you in/); assert.match(REPLY_LANGUAGE, /do not set the language/)
})

test('D27: the harness instructions of an ordinary Claude thread end with the same reply-language line; everything before it is unchanged', () => {
  for (const base of ['Be brief.', null]) {
    const out = claudeHarnessInstructions(base)
    assert.ok(out.endsWith(`${COMMENTARY}\n\n${REPLY_LANGUAGE}`))
    assert.equal(out.split(REPLY_LANGUAGE).length, 2, 'once')
  }
  assert.ok(claudeHarnessInstructions('Be brief.').startsWith('Be brief.\n\n'))
})

test('D27: a Claude browser conversation under the harness is started with EG-Desk\'s browser-thread instructions, and its next turn (a reloaded process) still has them', async t => {
  const w = world(t)
  const first = await w.browserSend('이 페이지 제목 알려줘'); await w.settled(first)
  assert.equal(w.transports.at(-1).options.appendPrompt, claudeBoundedHarnessInstructions(null))
  assert.equal(w.transports.at(-1).options.bounded, true, 'still a bounded process: the instructions add no tool and no setting')
  const second = await w.browserSend('검색창에 우산 입력해줘', { conversationId: first.conversationId }); await w.settled(second)
  assert.equal(w.transports.at(-1).options.appendPrompt, claudeBoundedHarnessInstructions(null))
  assert.deepEqual([w.transports.at(-1).options.bounded, w.transports.at(-1).options.tools], [true, []])
})

test('D27, unchanged without the harness: a bounded Claude thread (the SUB-10 contract alone) gets no instruction from EG-Desk', async t => {
  const w = world(t, { harness: false, codexReady: true })
  assert.equal(w.chat.claudeBrowserLive(), false)
  const sent = await w.browserSend('이 페이지 제목 알려줘'); await w.settled(sent)
  assert.equal(w.transports.at(-1).options.appendPrompt ?? null, null)
})

test('hold: with the draft check off, a browser turn\'s talk before a tool is a work note and only the answer is posted (before: two bubbles, the English line first)', async t => {
  const w = world(t, { hold: true })
  assert.equal(w.chat.browserTaskHoldEligible(), false, 'no check, no Decision model: the old hold would not apply')
  const sent = await w.browserSend('검색창에 우산 입력해줘')
  await play(w, [NARRATION, { tool: 'egdesk_card_read', args: { mode: 'structure' } }, ANSWER]); await settle(w, sent)
  assert.deepEqual(bubbles(w), [ANSWER])
  assert.deepEqual(notes(w, sent), [NARRATION])
})

test('hold: several tools with talk between them, ending in a question to the person (a value is missing): one bubble, the question; every line before it is a work note', async t => {
  const w = world(t, { hold: true })
  const sent = await w.browserSend('검색해줘')
  await play(w, ['페이지를 먼저 읽어 보겠습니다.', { tool: 'egdesk_card_read', args: {} }, '검색창을 찾고 있습니다.', { tool: 'egdesk_card_read', args: { mode: 'structure' } }, QUESTION]); await settle(w, sent)
  assert.deepEqual(bubbles(w), [QUESTION])
  assert.deepEqual(notes(w, sent), ['페이지를 먼저 읽어 보겠습니다.', '검색창을 찾고 있습니다.'])
})

test('hold: a browser turn without a tool posts its one text, as before', async t => {
  const w = world(t, { hold: true })
  const sent = await w.browserSend('안녕')
  await play(w, ['안녕하세요. 이 페이지에서 무엇을 할까요?']); await settle(w, sent)
  assert.deepEqual(bubbles(w), ['안녕하세요. 이 페이지에서 무엇을 할까요?']); assert.deepEqual(notes(w, sent), [])
})

test('the draft check and a browser run (D26 stays as it is, owner decision): a bounded turn is not checked, and the evidence a check would have for its tool steps is content-free references only (no step record)', async t => {
  const w = world(t, { hold: true, decisions: {} })
  w.chat.decisionContext.draftCheck = { mode: () => 'on' } // the check on, the Decision model on: the hold that existed before (browserTaskHoldEligible)
  assert.equal(w.chat.browserTaskHoldEligible(), true)
  const sent = await w.browserSend('검색창에 우산 입력해줘')
  await play(w, [NARRATION, { tool: 'egdesk_card_read', args: { mode: 'structure' } }, ANSWER]); await settle(w, sent)
  const run = w.runOf(sent)
  assert.deepEqual(bubbles(w), [ANSWER]); assert.deepEqual(notes(w, sent), [NARRATION])
  assert.equal(w.chat.draftCheckTurns.get(run)?.skip, 'ineligible', 'a bounded turn is never checked (the bounded branch, D26)')
  assert.ok(!w.decisionBodies.some(body => body.questions.some(q => /^(claim_|sup_|present_)/.test(q.name))), 'no check question was asked')
  const evidence = w.chat.answerFactsEvidence(run)
  assert.ok(evidence.length >= 1 && evidence.every(item => item.opaque === true && item.kind === 'tool'), JSON.stringify(evidence))
  const row = run.activities.find(a => a.kind === 'dynamicToolCall'); assert.deepEqual(Object.keys(row.detail).sort(), ['executedBy', 'tool'], 'the run keeps no result of a page tool call: nothing a claim like "검색했습니다" could be held against')
})

test('hold, unchanged outside the harness: a bounded Claude turn with the check off still posts its talk as it comes (this change acts only under the harness)', async t => {
  const w = world(t, { harness: false, codexReady: true, hold: true })
  const sent = await w.browserSend('검색창에 우산 입력해줘')
  await play(w, [NARRATION, { tool: 'egdesk_browser_observe', args: {} }, ANSWER]); await settle(w, sent)
  assert.deepEqual(bubbles(w), [NARRATION, ANSWER]); assert.deepEqual(notes(w, sent), [])
})
