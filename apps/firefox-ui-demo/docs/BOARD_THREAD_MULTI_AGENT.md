# Board Thread: several Agents in one room (CHAT-10, CHAT-03 tail)

Decisions: D-M2 (only @mentioned Agents answer; with no mention only the Lead), D-M4 (at most 2 Board turns per room).

## Where a Board Thread message goes

`overlay/resources/EGDeskBoardThread.sys.mjs` `boardSendPlan` (pure), called from the composer send in `eg-desk-surface.uc.js`.

| Message | Room Agent (Lead) | Route |
|-|-|-|
| `@이름` of an invited Agent (profile) | any | `POST /chat/board/send`: only the mentioned Agents answer |
| no mention | an Agent profile | `POST /chat/board/send`: the Lead answers with the Board block |
| no mention, or only `@Codex` | plain Codex | ordinary `POST /chat/send` (same single answer as before) |
| `@이름` + a Browser-bounded selection | any | refused (`BOARD_BROWSER_BOUNDED`): the bridge's Board send takes no execution policy |

A Board member list is not a delivery list. Inviting an Agent does not send it a message, and a member label is not an authenticated employee. With no saved Agent Lead, an ordinary room send can still start a real engine turn; it is not a private note.

A routed request carries the room's members (`members`, same shape as the store), the Lead (`leadProfileId`) and up to 12 eligible recent room messages (`recentMessages`, quoted in the Board block where the recipient's execution policy permits). This block does not contain every card or file on the Board. Manually attached material, suggested-but-unselected sources, the execution project and each target's existing runtime context are distinct. Displaying a recipient or resource in the composer does not grant that target new account, project or source permissions.

## What the room shows

- The Lead answers in the room's own conversation. Each other member answers in its own conversation (`board-member:*`); the screen registers that run under the room (`localThreadId`) with the Agent's name and face, so its answer appears in the room as that Agent. It never rebinds the room's conversation (`run.boardMember`).
- Every recipient's outcome is kept on the room (`thread.boardRoutes[profileId]`), and runs carry `run.board` (from the send answer and from `run.started` details).
- Member chips and the floating Chat head show each Agent's state: 작업 중 · 승인 대기 · 답변 대기 · 막힘 · 완료, and 차례 대기 when the D-M4 limit deferred it.
- Only mentioned members answering: the person's bubble is marked sent; there is no Lead run.

## Where members live

`GET/POST /chat/board/members` (`helper/egdesk-board-members.mjs`, route block in `codex-bridge-http.mjs`) read and replace chat-store v3 `room_members` under the room's durable ID. No engine account check. A room never saved reads `{members: [], saved: false}`; the first write creates it.

- Invite, remove and role change write the room's members to the store.
- Opening a Board Thread reads them back: a different list in the store replaces the screen's (faces captured at invite are kept); an empty store receives the Desk members once. A save that did not reach the bridge is retried on the next open instead of being overwritten.
- `thread.participants` / `participantAgents` stay in the Desk pref as the screen's copy.

## Known limits

- Early member events are buffered per pending Board send (up to 64 for 15 seconds) and replayed in arrival order once the runs are registered. A handler failure is logged; that event is not retried, and it does not stop later events.
- After a restart, the room's `board.routed` lines identify member conversations whose completed answers are folded back into the room. Each member scan reads at most 20 pages of 100 events per load. If it cannot reach the last page, only the owning room shows a partial-history notice; the scan does not fetch additional pages on its own.
- While any member's run is busy the room's composer waits (same busy rule as a single run).
- Not checked with a live Codex account or in Firefox.
