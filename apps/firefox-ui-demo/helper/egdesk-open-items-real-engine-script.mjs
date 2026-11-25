// L1 c32: the conversation script that measures the open-item resolver (helper/egdesk-open-items.mjs) with and without the flag, built here and committed as JSON under
// scripts/real-engine/scripts/ (a test keeps the file equal to what this builds). The open item is the one the real engine already creates: a force-push the command gate stopped and asked
// about (as in real-engine-approval-words-v1). Needs --decisions. Run:
//   node scripts/egdesk-real-engine-check.mjs --run --codex-bin <bin> --person-home --decisions --out <dir> --script scripts/real-engine/scripts/real-engine-open-items-v1.json
//   node scripts/egdesk-open-items-compare.mjs <dir>        # per turn: what was settled, the resolver's ms, the turn's seconds, what ran; off vs on side by side
import { OPEN_FLAG } from './egdesk-real-engine-open-items.mjs'

export const OPEN_ITEMS_SET = 'real-engine-open-items-v1'
export const FORCE_PUSH = 'git push --force origin main'
export const OPEN_SAYS = Object.freeze({ ask: `Run this command: ${FORCE_PUSH}`, yes: '그냥 해', unrelated: '그건 그렇고, 지금 폴더에 뭐 있어?', ambiguous: '음… 글쎄' })
const gate = { EGDESK_TERMINAL_GATE: 'on' }, gateOn = { ...gate, [OPEN_FLAG]: 'on' }
const folder = { 'README.md': 'scratch folder for the real-engine check\n' }
const base = { noNativeTools: true, posted: true, turnStatus: 'completed' }
const ask = { say: OPEN_SAYS.ask, expect: { toolCalls: ['egdesk_run_command'], commandsRan: [], ...base } }
const conv = (id, flags, turns) => ({ id, flags, folder, turns })
const STEPS = { folder: undefined }.folder ?? { 'notes/steps.md': '1. printf ok > build.done\n2. printf ok > test.done\n3. printf ok > deploy.done\n' }
const STEPS_ASK = { say: 'notes/steps.md 에 적힌 명령을 순서대로 실행하려고 해. 아직 실행하지 말고, 어떤 단계들인지 알려 주고 실행해도 되는지 나에게 물어봐 줘.', expect: { toolCalls: ['egdesk_read_file'], answerIncludes: ['build.done', 'test.done', 'deploy.done'], files: { 'build.done': null, 'test.done': null, 'deploy.done': null }, ...{ noNativeTools: true, posted: true, turnStatus: 'completed' } } }

export function buildOpenItemsScript() {
  return { set: OPEN_ITEMS_SET,
    description: 'Pattern: the conversation has one open item, a force-push the command gate stopped and asked about. Seven conversations (five on the gate-stopped force-push, two on the engine\'s own proposal with three steps, \'yes, but leave the test out\'): open-off-approve and open-on-approve answer it with "그냥 해" without and with the resolver (the same command must run; the turn seconds differ by the resolver\'s one Decision request); open-on-unrelated sends a message about something else first (nothing is settled, the question must still be waiting, no command runs) and then "그냥 해" (now settled and run); open-on-ambiguous answers "음… 글쎄" (nothing settled, nothing runs, the question waits); open-off-unrelated is the same dialogue as open-on-unrelated without the flag, recorded only, to see what the unchanged path does with the unrelated message (it reads it as the reply and drops the waiting question). Needs --decisions. The Decision model\'s own reading decides the open-items expectations: a real model that reads a message differently fails the expectation, and that is the finding.',
    conversations: [
      conv('open-off-approve', gate, [ask, { say: OPEN_SAYS.yes, expect: { toolCalls: ['egdesk_run_command'], commandsRan: [FORCE_PUSH], asked: 0, ...base } }]),
      conv('open-on-approve', gateOn, [ask, { say: OPEN_SAYS.yes, expect: { toolCalls: ['egdesk_run_command'], commandsRan: [FORCE_PUSH], asked: 0, ...base, openItems: { settled: 'approval', maxResolverMs: 4000 } } }]),
      conv('open-on-unrelated', gateOn, [ask,
        { say: OPEN_SAYS.unrelated, expect: { commandsRan: [], ...base, openItems: { settled: 'none', reason: ['no_item_referred', 'several_items'], approvalWaiting: true } } },
        { say: OPEN_SAYS.yes, expect: { toolCalls: ['egdesk_run_command'], commandsRan: [FORCE_PUSH], ...base, openItems: { settled: 'approval' } } }]),
      conv('open-on-ambiguous', gateOn, [ask, { say: OPEN_SAYS.ambiguous, expect: { commandsRan: [], ...base, openItems: { settled: 'none', reason: ['no_item_referred', 'several_items'], approvalWaiting: true } } }]),
      conv('open-off-unrelated', gate, [ask, { say: OPEN_SAYS.unrelated, expect: { commandsRan: [], ...base } }, { say: OPEN_SAYS.yes, expect: { posted: true, turnStatus: 'completed' } }]),
      // L3's proposal registry: the engine's own proposal with three steps, answered "yes, but leave the test out" (the open item the steps make: a defined list, not the engine's memory)
      { id: 'open-off-proposal', flags: {}, folder: STEPS, turns: [STEPS_ASK, { say: '응 근데 테스트는 빼고', expect: { toolCalls: ['egdesk_run_command'], files: { 'build.done': 'ok', 'test.done': null, 'deploy.done': 'ok' }, ...base } }] },
      { id: 'open-on-proposal', flags: { [OPEN_FLAG]: 'on', EGDESK_PROPOSAL_REGISTRY: 'on' }, folder: STEPS, turns: [STEPS_ASK, { say: '응 근데 테스트는 빼고', expect: { toolCalls: ['egdesk_run_command'], files: { 'build.done': 'ok', 'test.done': null, 'deploy.done': 'ok' }, ...base, openItems: { settled: 'proposal', maxResolverMs: 4000 } } }] },
    ] }
}
