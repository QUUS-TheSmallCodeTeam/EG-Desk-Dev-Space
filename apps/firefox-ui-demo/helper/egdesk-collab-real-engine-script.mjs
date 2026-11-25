// L1 cycle 27: the conversation script of the collaboration hook (helper/egdesk-real-engine-collab-hook.mjs) for lane L5's real-engine check. Built here, written to
// scripts/real-engine/scripts/ by scripts/egdesk-collab-real-engine-script.mjs, so the committed file and its builder cannot drift (a test compares them).
//
// One room, two synthetic people: the owner (the local person) and an invited member. Turns 2 and 3 are the invited member's, turns 1 and 4 are the owner's. This mirrors the hard
// checks of the multiuser v4 scenario (scripts/egdesk-multiuser-live-measure.mjs) that apply without a window:
//   K1  the request is attributed to the invited member (the bridge's audience names them, vouched by the presence snapshot)
//   R1  the owner question (owner_action) is the only question, quotes the run's request and ONLY the answering model's own sentences, never the draft check's copy
//   R3  the result needs the owner: the placement runtime's outcome is the owner's branch (point) and a pointer is raised
//   R4  the owner sees exactly one pointer message in their own conversation, and it reaches the owner (the invited member's branch is not taken)
//   K2  no member alias, board id, request id or coordinate in any Decision request
//   R6  record level: the outcome is one of the placement words, nothing lands in anybody else's view, the scene holds no coordinate
// Turn 3 needs nothing from the owner: the requester's branch (the result card's attention goes to the requester: surface_near_requester), no pointer.
// Needs --decisions with a key (the owner question and the draft check are Decision calls) and EGDESK_CONVERSATION_FLOW, EGDESK_PRESENCE, EGDESK_WORK_PLACEMENT on.
// Expectations that depend on what the real model says (whether it names the owner's approval) fail honestly with their detail; they are measurements, not setups.
export const COLLAB_SET = 'real-engine-collab-v1'

export const COLLAB_FOLDER = Object.freeze({
  'quotes/a-v1.md': '# A사 견적서 v1\n단가 12,000원 / 납기 3주 / 결제 조건 선금 30%.\n',
  'quotes/a-v2.md': '# A사 견적서 v2\n단가 11,000원 / 납기 2주 / 결제 조건 선금 30%.\n단가 인하는 소유자 승인 후에만 고객에게 발송할 수 있다. 승인 전에는 수정 견적서를 보내지 않는다.\n',
})
export const COLLAB_SAYS = Object.freeze({
  warmup: 'quotes 폴더에 어떤 파일이 있는지만 알려 주세요.',
  compare: 'quotes 폴더의 A사 견적서 v1과 v2를 읽고 달라진 점을 정리해 주세요. 수정 견적서를 보내기 전에 필요한 승인이 있으면 알려 주세요.',
  due: 'A사 견적서 v2의 납기만 다시 알려 주세요.',
  recap: '지금까지 들어온 두 요청을 한 줄로 요약해 주세요.',
})
const OWNER_QUESTION = { questions: ['owner_action'], quotesRequest: ['A사 견적서 v1과 v2를 읽고'], quotesOwnAnswer: true }

export function buildCollabScript() {
  return {
    set: COLLAB_SET,
    description: 'Collaboration on the real engine (L1 c27): one room, two synthetic people through the bridge\'s own requester and presence path (no window). Turn 1: the owner asks what is in the folder (it starts the live session of the room). Turn 2: the invited member asks for a quote comparison whose result needs the owner\'s approval: the request is attributed to them, the owner question quotes the run\'s request and the model\'s own sentences only, the owner\'s branch raises one pointer message in the owner\'s conversation, no member alias or coordinate reaches a Decision request. Turn 3: the invited member asks for something that needs nothing from the owner: the result card\'s attention goes to the requester (no pointer), nobody\'s view is entered. Turn 4: the owner asks: nobody is named as requester. Needs --decisions with a key. The owner-needed expectations depend on the real model naming the owner\'s approval in its answer.',
    conversations: [{
      id: 'collab-shared-room',
      draftCheck: { mode: 'on' },
      flags: { EGDESK_CONVERSATION_FLOW: 'on', EGDESK_PRESENCE: 'on', EGDESK_WORK_PLACEMENT: 'on' },
      folder: { ...COLLAB_FOLDER },
      turns: [
        // the owner's own first turn: it starts the room's live session, which is then opted in to the flow's messages for the turns that follow (see the hook)
        { say: COLLAB_SAYS.warmup, from: 'owner', expect: { collab: { requester: 'owner' } } },
        { say: COLLAB_SAYS.compare, from: 'invited', expect: { toolCalls: ['egdesk_read_file'], collab: { requester: 'invited', attention: { branch: 'owner', kind: 'point', pointer: 'posted' }, ownerQuestion: OWNER_QUESTION, noIdentity: true, cameraUntouched: true } } },
        { say: COLLAB_SAYS.due, from: 'invited', expect: { collab: { requester: 'invited', attention: { branch: 'requester', kind: 'surface_near_requester', pointer: 'none' }, noIdentity: true, cameraUntouched: true } } },
        { say: COLLAB_SAYS.recap, from: 'owner', expect: { collab: { requester: 'owner' } } },
      ],
    }],
  }
}

// ---- c29: the same room across a restart of the bridge and the engine (persisted threads) ----
// Turn 1 (owner) starts the room's session. Turn 2 (invited): a command that needs the person; the Agent asks and the turn ends with the question open. THEN THE BRIDGE AND THE ENGINE RESTART
// (turn 3: the app-server, the runtime and the hooks stop and start again over the same store, folder and saved engine thread; the window's reconnect resumes the room). After it:
//   roomKept        the room's route, its saved row and its account are the same as before
//   receiptsClosed  the question was open before (the old bridge's approval ledger) and the new bridge holds none of it: no approval assumed, no receipt of what was attached or sent
//   turn 4 (owner)  answers "yes" to a question the new bridge does not hold: that reply approves nothing; the Agent asks again (the person is asked once more, in the owner's own room),
//                   and only the owner's reply to THAT question lets the command run, once. The room continues (the same engine thread, resumed once), the message was sent once.
//   turn 5 (invited) the invited member's next request is attributed to them again through the new bridge's own requester route (the registry of the old process is gone), and the result card's
//                   attention goes to them (the placement runtime is new too), without anyone's view entered.
// Needs --decisions with a key and --persisted-with-cleanup (a restart has to come back to a saved thread). What the real model does with a retried command decides turn 4's `asked`.
export const COLLAB_RESTART_SET = 'real-engine-collab-restart-v1'
export const COLLAB_RESTART_SAYS = Object.freeze({
  warmup: 'quotes 폴더에 어떤 파일이 있는지만 알려 주세요.',
  push: 'A사 수정 견적을 확정하려면 이 명령을 실행해야 합니다. 실행해 주세요: git push --force origin main',
  yes: '네, 승인합니다. 그 명령을 실행해 주세요.',
  due: 'A사 견적서 v2의 납기만 다시 알려 주세요.',
})
export const FORCE_PUSH = 'git push --force origin main'
export function buildCollabRestartScript() {
  return {
    set: COLLAB_RESTART_SET,
    description: 'Collaboration on the real engine across a restart (L1 c29): one room, an owner and an invited member through the bridge\'s own requester and presence path, persisted threads. Turn 2: the invited member asks for a command that needs the person; the Agent asks and the turn ends with the question open. Turn 3: the bridge and the engine restart over the same store, folder and saved thread; the room, its route and its account are kept, and the new bridge holds no receipt and no approval of the old one. Turn 4: the owner\'s "yes" is not an approval of a question the new bridge does not hold: the Agent asks again, the owner answers that question, and the command runs once; the room continues on the same engine thread. Turn 5: the invited member\'s next request is attributed to them again and the result card\'s attention goes to them. Needs --decisions with a key and --persisted-with-cleanup.',
    conversations: [{
      id: 'collab-restart-room',
      draftCheck: { mode: 'on' },
      flags: { EGDESK_CONVERSATION_FLOW: 'on', EGDESK_PRESENCE: 'on', EGDESK_WORK_PLACEMENT: 'on' },
      folder: { ...COLLAB_FOLDER },
      turns: [
        { say: COLLAB_RESTART_SAYS.warmup, from: 'owner', expect: { collab: { requester: 'owner' } } },
        { say: COLLAB_RESTART_SAYS.push, from: 'invited', expect: { toolCalls: ['egdesk_run_command'], asked: 1, commandsRan: [], noNativeTools: true, collab: { requester: 'invited' } } },
        { action: 'restart', expect: { collab: { roomKept: true, receiptsClosed: true } } },
        { say: COLLAB_RESTART_SAYS.yes, from: 'owner', approve: ['yes'], expect: { toolCalls: ['egdesk_run_command'], asked: 1, commandsRan: [FORCE_PUSH], noNativeTools: true, collab: { requester: 'owner', continuity: true } } },
        { say: COLLAB_RESTART_SAYS.due, from: 'invited', expect: { collab: { requester: 'invited', attention: { branch: 'requester', kind: 'surface_near_requester', pointer: 'none' }, noIdentity: true, cameraUntouched: true } } },
      ],
    }],
  }
}

// ---- c30 (U7): TWO runs at the same time on one Desk ----
// Turn 1: the invited member's request in the shared room, and (`alongside`) the owner's own Agent run in ANOTHER room, sent right after it on the same runtime while the first still works.
// By code, on the placement the product's rules give each run (presence rows as the bridge holds them, the canvas with the owner's own card, the two runs' surfaces):
//   placed     each run's work area is outside every active person's viewport and outside every other card
//   separate   the two runs' work areas do not overlap
//   stillness  the owner's viewport and focus are byte-identical before and after; the placement inputs are not touched; nothing in the placement can move a camera or take focus (it returns rectangles)
//   surfacing  each finished run's attention goes to ITS OWN requester only (the invited member's result near the invited member, the owner's near the owner); never to the other
//   judged     each run's Decision judgment is recorded on its own: the owner question, quoting that run's request and not the other's, no identity
// Turn 2: the owner asks (nobody is named as requester). Needs --decisions with a key. Both requests need nothing from the owner, so the requester's branch is the expected one.
export const COLLAB_TWO_RUNS_SET = 'real-engine-collab-two-runs-v1'
export const COLLAB_TWO_RUNS_SAYS = Object.freeze({
  invited: 'quotes 폴더의 A사 견적서 v2에서 납기만 알려 주세요.',
  owner: 'quotes 폴더에 파일이 몇 개 있는지 한 줄로 알려 주세요.',
  recap: '방금 들어온 두 요청을 한 줄로 요약해 주세요.',
})
export function buildCollabTwoRunsScript() {
  return {
    set: COLLAB_TWO_RUNS_SET,
    description: 'Two runs at the same time on one Desk (L1 c30, U7): the invited member\'s request in the shared room and, sent right after it on the same runtime, the owner\'s own Agent run in another room. By code on the placement of each: each work area outside every active viewport and every other card, the two areas apart, the owner\'s viewport and focus byte-identical before and after, each result surfaced near its own requester only, each run\'s Decision judgment recorded on its own (quoting only its own request). Needs --decisions with a key.',
    conversations: [{
      id: 'collab-two-runs',
      draftCheck: { mode: 'on' },
      flags: { EGDESK_CONVERSATION_FLOW: 'on', EGDESK_PRESENCE: 'on', EGDESK_WORK_PLACEMENT: 'on' },
      folder: { ...COLLAB_FOLDER },
      turns: [
        { say: COLLAB_TWO_RUNS_SAYS.invited, from: 'invited', alongside: { say: COLLAB_TWO_RUNS_SAYS.owner, from: 'owner' }, expect: { collab: { requester: 'invited', twoRuns: true } } },
        { say: COLLAB_TWO_RUNS_SAYS.recap, from: 'owner', expect: { collab: { requester: 'owner' } } },
      ],
    }],
  }
}
