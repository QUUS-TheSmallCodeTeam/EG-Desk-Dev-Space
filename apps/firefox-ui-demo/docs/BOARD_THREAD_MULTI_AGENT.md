# Board Thread: several Agents in one room (CHAT-10, CHAT-03 tail)

Decisions: D-M2 (only @mentioned Agents answer; with no mention only the Lead), D-M4 (at most 2 Board turns per room).

## Where a Board Thread message goes

The composer's recipient line and the submit path use the same pure `boardDeliveryIntent` in `overlay/resources/EGDeskBoardThread.sys.mjs`. Opening the scope details does not send or attach anything. `boardSendPlan` builds a routed request only after the draft passes this check. A bridge advertising `capabilities.boardDeliveryIntent` compares the expected route, room, roster and recipients to its own resolution; a stale plan is not permission to choose a replacement.

| Message | Room Agent (Lead) | Route |
|-|-|-|
| `@이름` of an invited profile on a supported Codex Board route | any | `POST /chat/board/send`: only the named Agents are requested, subject to each one's profile, account and concurrency checks |
| no mention, supported unbounded Codex route | an Agent profile | `POST /chat/board/send`: only the Lead is requested; its policy determines whether the Board block is included |
| no mention, or only `@Codex` | plain Codex | ordinary `POST /chat/send` (same single answer as before) |
| a targeted `@Agent` + a live Browser selection | any | refused: the Board dispatch path must not drop the Browser execution boundary |
| a targeted `@Agent` in an unsupported engine or stateless mode | any | refused: do not send the same text as an ordinary engine turn or discard the selected mode |
| selected room attachments or chosen suggestions on a Board member request | any | accepted for validation only when the sole target is the room's Lead; otherwise refused (`BOARD_CONTEXT_SCOPE`), never copied to a separate member conversation |
| `@all` or an unresolved deliberate Agent address | any | correct the address first; no broadcast or substitute recipient |
| ordinary unaddressed engine message in a Claude room with no Agent Lead | plain room engine | ordinary `/chat/send`, not member fan-out |

A Board member list is not a delivery list. Inviting an Agent does not send it a message, and a member label is not an authenticated employee. With no saved Agent Lead, an ordinary room send can still start a real engine turn; it is not a private note.

A routed request carries the room's members (`members`, same shape as the store), the Lead (`leadProfileId`) and up to 12 eligible recent room messages (`recentMessages`, quoted in the Board block where the recipient's execution policy permits). This block does not contain every card or file on the Board. Manually attached material, suggested-but-unselected sources, the execution project and each target's existing runtime context are distinct. Displaying a recipient or resource in the composer does not grant that target new account, project or source permissions.

## What the room shows

- The Lead answers in the room's own conversation. Each other member answers in its own conversation (`board-member:*`); the screen registers that run under the room (`localThreadId`) with the Agent's name and face, so its answer appears in the room as that Agent. It never rebinds the room's conversation (`run.boardMember`).
- Every recipient's outcome is kept on the room (`thread.boardRoutes[profileId]`), and runs carry `run.board` (from the send answer and from `run.started` details).
- Member chips and the floating Chat head show each Agent's state: 작업 중 · 승인 대기 · 답변 대기 · 막힘 · 완료, and 차례 대기 when the D-M4 limit deferred it.
- A member being requested is not proof that it started or answered. Partial acceptance, deferral, rejection and an unconfirmed start are different outcomes. An uncertain or partial batch must not be replayed as though nobody received it.

## Where members live

`GET/POST /chat/board/members` (`helper/egdesk-board-members.mjs`, route block in `codex-bridge-http.mjs`) read and replace chat-store v3 `room_members` under the room's durable ID. No engine account check. A room never saved reads `{members: [], saved: false}`; the first write creates it.

- Invite, remove and role change write the room's members to the store.
- Opening a Board Thread reads them back: a different list in the store replaces the screen's (faces captured at invite are kept); a room whose roster has never been saved can receive its Desk members once. An explicitly cleared saved roster stays empty on reopen; the presence of a native conversation alone is not evidence of a saved roster. A save that did not reach the bridge is retried on the next open instead of being overwritten.
- `thread.participants` / `participantAgents` stay in the Desk pref as the screen's copy.

## Speech, profiles and native history

- In the transcript, the person's label can be **나**. In a member's input, the same person is **사람**. Only confirmed public user and assistant text is quoted (up to 12 entries, then the block size cap); an unknown assistant is **Agent**, never a guessed Lead or engine. Typed assistant commentary is a work note even when it has a known author and is complete. It can be inspected under the run’s activity record, but is not a chat message, shareable DM excerpt or Decision Model conversation candidate. Reasoning, activity, unconfirmed text and the private input behind a plan-resume notice are not room speech.
- An answer opens its own recorded author's identity. The Board never loads the Lead's full profile just because someone clicked another member's name. Test expectations and fixture identifiers belong in the test observer, not in the answer text.
- Board turn fields are allow-listed at both the browser and helper. A member's account, conversations and tools are not inherited from the Lead. The room's chosen per-turn model/effort and project still apply as disclosed; this is not a stateless or account-free execution. Only the sole Lead can receive selected room sources.
- An established native Board conversation belongs to its original speaker, independently of mutable room settings. A new Lead requires a new conversation; an @mention of a different member still uses that member's own conversation. A branch inherits the same speaker. Legacy named histories are eligible only with consistent starts for every recorded dispatch. Unknown or conflicting histories stay readable, not resumable as another speaker.

## Peer speech during the same active turn

Two explicitly mentioned named Agents in one checked Board send can start their own turns without waiting for an answer. If the saved roster, both accepted runs, their identities and the exact Codex transport contracts are still verified, the first confirmed native `final_answer` from each direction can be delivered to the other **still active** turn. There is no assigned speaking order. It is an opportunity to respond, not a promise of another reply. Different sends (even in the same room), DMs, work notes, deltas, restored output and post-restart runs cannot join the temporary pair.

**When is speech public?** For this handoff the owning helper has stored the final `message.completed` and emitted that same message on its UI-facing stream. This is not a Firefox paint acknowledgement and does not require the speaker’s native `turn/completed`. Waiting for that later event can miss an otherwise active listener. The two account processes can use an identical native turn ID: the actual destination must still match the selected account transport, conversation and expected active turn. A successful peer receipt does not prove that a model read the quote. In the Board UI the same conversation/turn pair identifies each answer’s activity button, its focused heading (or item) and its working row. “현재 작업 화면” only uses Browser Card bindings from that run’s own member conversation. A missing Board conversation ID cannot focus another member’s record.

- The adapter sends `turn/steer` with the recipient’s own thread, expected active turn and account slot. Only a fixed app cue is user input; the author and already-public text are JSON in `additionalContext.egdesk_board_peer` with `kind: "untrusted"`. The excerpt is capped at 4,000 characters and marked if shortened. It is not a new message from the person, a system instruction, a permission grant, or a copy of either member’s tools or history. Neither the cue nor the quote is added as a second chat bubble.
- The code is gated on the [0.162.1 steer handler](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/src/request_processors/turn_processor.rs), the installed binary fingerprint, and its **experimental generated** request/response schemas (including the untrusted entry type). Stable schemas without that field, different/unverified versions, Claude, unverified slots and bounded execution stay independent; no blind RPC or substitute transport. A dedicated slot is eligible only if its launch is bound to the same verified executable bytes and that slot is still ready.
- One attempt at most per direction per original send. While an approval or a human response is pending, after a stop/recipient change, or if the recipient is no longer active, do not send. Native rejection, unknown delivery and timeouts never start a replacement turn, interrupt an existing one or schedule a retry. A matching `turnId` receipt confirms queued input only, not that the model used it; if observed while still active it is kept under activity, not speech. No pending delivery is rebuilt or replayed from SQLite.

## Known limits

- Early member events are buffered per pending Board send (up to 64 for 15 seconds) and replayed in arrival order once the runs are registered. A handler failure is logged; that event is not retried, and it does not stop later events.
- After a restart, the room's `board.routed` lines identify member conversations whose completed answers are folded back into the room. Each member scan reads at most 20 pages of 100 events per load. If it cannot reach the last page, only the owning room shows a partial-history notice; the scan does not fetch additional pages on its own.
- While any member's run is busy the room's composer waits (same busy rule as a single run).
- Isolated Firefox was checked end to end with the production chat dispatcher and two local synthetic Agent profiles. A single mention, a Lead-only question and a two-member question produced responses under the matching authors and run IDs in the same Board; an unaddressed room with no Agent Lead used ordinary Codex chat. The engine emitted synthetic responses in-process. This checks routing and rendering, not live Codex/Claude accounts or delivery to people.
- A normal restart can display the saved Desk transcript before the helper returns. A member answer absent from that transcript is rebuilt from the member’s own SQLite history. The stored message ID (`localMessageId`) stays the same; a DB-only row uses it as its view `id` and keeps the provider item ID separately. `localRunId` links the row to the public native run identity in that same conversation. Missing or contradictory evidence is not filled from the room’s latest run or `board.routed` recipient.
- `scripts/egdesk-board-thread.test.mjs` closes and reopens SQLite, then sends the real history page through the screen adapter and Board fold without a Desk cache. The final answer appears once. Only a work note joined to its Board, member, stored answer and native run is restored in the owning Board’s activity panel, never as a second answer or a copy of the member’s private inputs or tools. Members can reuse provider item IDs without sharing a run. A later checkpoint may complete the same stored row’s identity without replacing its display or content.
