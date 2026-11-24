// L2 c21: a world to run the journey's real-engine scripts (scripts/real-engine/scripts/real-engine-journey-*-v1.json) against the FAKE app-server, with
// the journey's own scripted Decision answers (scripts/egdesk-all-on.support.mjs scriptedDecisions) as the Decision provider. Nothing here starts a Codex,
// runs a command or sends anything: the app-server child, the command runner and the Decision provider are fakes living in this process.
// What it validates: that the scripts are well formed and drive the product's runtime as intended, and that every expectation is judged by code on a record
// the check wrote. It does NOT say how the real model behaves; the expectations on the real engine are Main's run. The fake "model" here answers what the
// script's expectations name, so a pass means the mechanics work, and the negative tests in egdesk-real-engine-journey.test.mjs show each expectation can fail.
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { runFakeAppServer } from './real-engine/fake-app-server.mjs'
import { DECISION_KEY_ENV, runConversation } from '../helper/egdesk-real-engine-check.mjs'
import { independentEstimate } from '../helper/egdesk-decision-real-runner.mjs'
import { createPrivateQaTempDirectory } from './egdesk-qa-platform.mjs'
import { scriptedDecisions } from './egdesk-all-on.support.mjs'
import { SAYS } from './egdesk-all-on-live-measure.mjs'

/** A script copy with every whileRunning afterMs shortened (the validation runs in real time, in seconds not tens of seconds). */
export function fastScript(script, { afterMs = 1200 } = {}) {
  const copy = structuredClone(script)
  for (const conversation of copy.conversations) for (const turn of conversation.turns) if (turn.whileRunning) turn.whileRunning.afterMs = afterMs
  return copy
}

// the fake model's answers to the memory conversation (what a model that read the attached pages would say)
export const MEMORY_FAKE = Object.freeze({ turns: [
  { match: SAYS.quote, final: 'A사 견적은 11월 6일에 단가 12,800원으로 견적서 v1을 보냈고, A사 회신을 기다리는 중입니다.' },
  { match: SAYS.tidy, final: '정리하면, A사에는 11월 6일에 12,800원으로 견적서 v1을 보냈고 회신 대기 중입니다.' },
  { match: SAYS.recall, final: 'PostgreSQL 전환 설계는 스키마 변환, 데이터 이관, 롤백 순서를 정해 두었습니다.' },
  { match: SAYS.deployed, final: '배포가 끝났다고 알려 주셔서 확인했습니다.' },
] })
const writerNotes = Array.from({ length: 8 }, () => ({ steps: [], final: '명령이 아직 실행 중이에요. 끝나는 대로 알려 드릴게요.' }))

/** The fake model's turns for one long-command conversation: it runs the command through EG-Desk's tool, then answers with what the command printed. */
export function commandFake({ command, final, steerFinal = undefined, delayMs = 0 }) {
  return { turns: [{ steps: [...(delayMs ? [{ delayMs }] : []), { toolCall: { tool: 'egdesk_run_command', arguments: { command } } }], final, ...(steerFinal !== undefined ? { steerFinal } : {}) }], forkTurns: writerNotes }
}

const sleepMs = command => { const m = /sleep (\d+)/.exec(command); return m ? Number(m[1]) : 0 }

/**
 * journeyWorld(t, fakeScript, { decisions = true, commandMs: (seconds) => ms }) → { options, deps, wire(), decisions, commands }
 * commandMs maps the "sleep N" of a scripted command to how long the fake command takes (real time); the fake command ends early when it is killed (an interrupt).
 */
export function journeyWorld(t, fakeScript, { decisions = true, commandMs = seconds => (seconds >= 40 ? 8000 : 3500), steerContract = true } = {}) {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-journey-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const out = path.join(base, 'out'), stderrLines = [], spawns = [], commands = [], decisionRows = []
  const scripted = scriptedDecisions()
  const spawn = (bin, argv, options) => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(), child = new EventEmitter()
    Object.assign(child, { pid: 4242 + spawns.length, stdin, stdout, stderr, exitCode: null, signalCode: null, kill: () => true })
    spawns.push({ bin, argv })
    runFakeAppServer({ script: fakeScript, log: path.join(base, `fake-app-server-${spawns.length}.log`), input: stdin, output: stdout, stderr: { write: line => { stderrLines.push(line); stderr.write(line) } }, env: options.env,
      exit: code => { child.exitCode = code; child.emit('close', code, null) } })
    return child
  }
  const killGroup = async child => { child.stdin.end(); await new Promise(resolve => { if (child.exitCode != null) return resolve(); child.once('close', resolve); setTimeout(resolve, 500) }); return { signal: 'SIGTERM' } }
  // the command runner: the command "runs" for commandMs(sleep N) and prints what the model will report; kill() ends it at once (what an interrupt does)
  const runnerSpawn = (file, args) => {
    const command = String(args.at(-1)), child = new EventEmitter(), began = performance.now()
    let ended = false
    const end = (code, signal) => { if (ended) return; ended = true; clearTimeout(timer); child.stdout.end(); child.emit('close', code, signal) }
    const timer = setTimeout(() => { child.stdout.write(`${/echo (\S+)/.exec(command)?.[1] ?? 'done'}\n`); end(0, null) }, commandMs(sleepMs(command)))
    Object.assign(child, { pid: 9000 + commands.length, stdout: new PassThrough(), stderr: new PassThrough(), kill: signal => { commands.at(-1).killedAfterMs = Math.round(performance.now() - began); end(null, signal ?? 'SIGTERM'); return true } })
    commands.push({ command, killedAfterMs: null })
    return child
  }
  // the Decision provider: the journey's scripted answers; every request is counted with its estimated input tokens (what the real run would be charged about)
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body), choices = body.questions.filter(q => q.type === 'choice').length, predicates = body.questions.length - choices
    const answers = await scripted.answer(body), est = independentEstimate(choices, predicates, Buffer.byteLength(init.body))
    decisionRows.push({ names: body.questions.map(q => q.name), est })
    return Response.json({ answers, usage: { input_tokens: est } })
  }
  const options = { mode: 'run', codexBin: '/fake/codex', home: { kind: 'person', dir: null }, scripts: [], out, decisions, model: null, effort: null, appServerConfig: [], turnTimeoutMs: 20_000, json: false }
  const deps = { spawn, runnerSpawn, fetchImpl, killGroup, killGroupRunner: (child, signal) => { try { child.kill(signal) } catch { /* gone */ } }, // the product's kill of a command's process group: here, the fake command ends gitStatus: async () => null,
    inspectNative: () => ({ version: '0.171.0-alpha.13', schemaMatch: steerContract, boardPeerContract: steerContract ? 'c'.repeat(64) : null }),
    env: { PATH: '/usr/bin:/bin', HOME: path.join(base, 'home'), [DECISION_KEY_ENV]: 'egd-synthetic-not-a-key-0021', OPENAI_API_KEY: 'sk-synthetic-must-not-reach-the-child' } }
  const wire = () => spawns.flatMap((_, i) => { try { return fs.readFileSync(path.join(base, `fake-app-server-${i + 1}.log`), 'utf8').trim().split('\n').map(line => JSON.parse(line)) } catch { return [] } })
  return { base, out, options, deps, spawns, commands, decisionRows, stderrLines, wire }
}

/** Run one conversation of a script in a world; returns the check's own conversation record. */
export const runJourneyConversation = (w, script, conversationId) => runConversation({ options: w.options, set: script.set, conversation: script.conversations.find(c => c.id === conversationId), deps: w.deps })

/** What a run cost on the Decisions side and on the engine side: requests and estimated input tokens, main turns, writer forks, steers, interrupts. */
export function costOf(w, record) {
  const wire = w.wire(), inbound = name => wire.filter(m => m.dir === 'in' && m.method === name)
  const forks = new Set(wire.filter(m => m.dir === 'out' && m.result?.thread?.id?.startsWith?.('fork-')).map(m => m.result.thread.id))
  const turnStarts = inbound('turn/start'), forkTurns = turnStarts.filter(m => forks.has(m.params?.threadId))
  return { decisionRequests: w.decisionRows.length, decisionEstTokens: w.decisionRows.reduce((n, r) => n + r.est, 0), engineTurns: turnStarts.length - forkTurns.length, writerForkTurns: forkTurns.length,
    steers: inbound('turn/steer').length, interrupts: inbound('turn/interrupt').length, scriptedTurns: record.turns.length, byFamily: w.decisionRows.reduce((m, r) => { const k = r.names[0]?.replace(/_?\d+$/, '') ?? '?'; m[k] = (m[k] ?? 0) + 1; return m }, {}) }
}
