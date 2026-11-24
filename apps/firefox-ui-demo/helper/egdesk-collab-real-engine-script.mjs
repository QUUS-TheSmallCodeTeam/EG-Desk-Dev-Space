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
