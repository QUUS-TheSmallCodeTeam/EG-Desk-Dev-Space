# EG-Desk Chat Design Grammar v1

**Date**: 2026-05-19
**Status**: Product/UI decision note
**Scope**: Firefox shell Chat HUD, canvas chat cards, agent profile entrypoints, Board routing

> **Terminology correction (2026-08-05):** references below to `Run Playback`,
> `Canvas Run Playback`, `Result Walkthrough`, or `Walkthrough Chip` are legacy
> labels. The current concept is Answer Briefing as defined by Contract §8 and
> Atlas `OBJ-038` / `AI-05`; it explains one Answer through ordered Canvas
> targets and Focus Scopes and does not replay a Run or hidden reasoning.

## Approved Visual Baseline (2026-10-20)

The approved desktop style reference is [the screenshot](./egdesk-approved-desktop-style.jpg)
and [its interactive HTML proposal](./egdesk-approved-desktop-style.html). The
HTML contains *example data*, not product state or a replacement runtime.
For production, `overlay/CSS/eg-desk-surface.uc.css` owns the accepted token
values; this note explains their intent. The approved **style** does not freeze
every menu, component, or window position shown in the proposal.

- Chat shares the Desk's warm-neutral materials: `#FFFEFA` paper,
  `#F9F9F6` received-bubble surface, `#E6EBE3` user bubble,
  `#49634F` action accent, `#252A26` ink, `#646A61` secondary text,
  and `#DEDFD8` / `#EAEAE4` separators. The system Korean font stack is
  `-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`.
- Conversation rhythm: `13px/1.45` shell text, `12px/1.52` bubbles,
  `11px` sender/time metadata, `17px 16px 14px` message-area padding,
  `14px` between turns, `8px` between avatar and content, `9px 11px`
  bubble inset. A `24px` circular avatar starts at the sender's first
  message, rather than trailing a long attachment. User bubbles stay right.
- The canvas Chat window keeps its real `우측` HUD move action. HUD and Canvas
  are two presentations of the same conversation, not duplicated messages.
  The document/result affordance focuses the real artifact when available;
  activity detail is subordinate to the conversation.
- The movable canvas frame is a quiet 32px secondary strip with a type icon,
  visual grab handle, and unchanged `우측`/close actions. The live conversation
  head beneath it is the primary title (44px in the canvas card); the HUD has
  the same hierarchy without losing its own move/close controls. A logged-out
  empty thread keeps `로그인` and `상태 새로고침` visible but uses 16px heading,
  compact supporting copy, and upper-body placement rather than a hero panel.
  The one-line composer remains compact by default and grows for a long draft.
- Preserve actual connection, login, local-record coverage, error, stop,
  attachment, tool, and permission feedback. Visual restraint must not hide
  facts or imply a successful provider connection.

---

## Core Sentence

Chat is the work-entry surface. It is not the workspace, not the result viewer, and not the raw execution console.

```text
Chat      = where the user speaks and receives conversationally complete replies
Board     = where work belongs
Canvas    = where work objects live
Run       = one execution record
Profile   = who the agent is and how it is configured
Context   = what was available to the run
```

The default chat should read like a messenger. Technical process is available, but it is reached by drilling into a run, profile, or diagnostic surface.

---

## Agent, channel, work and speech

The saved Agent is the speaker, not the chat window. One profile can participate in a direct chat and a Board at the same time. The channel belongs to the submitted turn; docking the view or focusing a different room cannot redirect its reply. The native conversations remain separate: identity continuity is not a grant to recall private dialogue across channels.

For a named Agent on a supported unbounded route, the helper adds a per-turn `egdesk_channel` context alongside the normal persona. The block names the reply destination and describes only verified preparation facts: a resolved project workspace, number of prepared source snapshots, and batches of explicitly shared messages. A source being attached is not proof it was read; a plan is not an executed action. No screen coordinates, unrelated cards, private memories, or new tool permissions come from this block. A new direct reply explicitly selected by the UI is recorded at the native binding; old unmarked native histories are not retrospectively called DMs. The channel is not proof of who may access stored records. Claude translates the block into application-labelled input text; it is not a separate Claude system prompt.

Typed assistant commentary is a **work note**: read its public progress text under the run's activity record, not in the conversation or a later Board excerpt. It is not raw model reasoning. Published final answers and compatible completed items from phase-less engines remain speech. The original historical event log is not rewritten. A chat with nothing new to say need not fill its transcript with work updates.

This is the channel/speech boundary, not a global Agent memory, an autonomous follow-up scheduler or an active-turn steering implementation.

---

## Two Entry Modes

EG-Desk needs both person-like direct messages and Board-based work rooms.

```text
Agent DM
  -> user talks to a specific agent/profile
  -> agent may answer directly
  -> agent may route work into a Board Thread

Board Thread
  -> user starts from a work room
  -> multiple agents, cards, outputs, prior runs, and decisions can be present
  -> only scope-relevant agents should act
```

An Agent DM is a reception and delegation surface. It is not always the final work location.

A Board Thread is the visible room for a task, project, or work pairing. It behaves like a group chat, but the product label should be `Board`, not generic `group`.

---

## Routing Model

Keep these concepts separate in data and UI:

```ts
conversationLocation // where the user spoke
workOwner            // Board or thread where the work belongs
runOwner             // concrete execution/run record
replyDestination     // where the user should see the result or be tagged
```

Examples:

```text
User starts in Agent DM
  -> agent decides Board B is the right room
  -> agent collaborates there
  -> result returns to Agent DM, or user is tagged inside Board B

User starts in Board Thread
  -> only relevant agents respond
  -> outputs open as canvas cards
  -> follow-up stays Board-scoped unless explicitly moved
```

---

## Visual Grammar

Use one visible grammar across HUD chat and canvas chat cards.

| Element | Meaning |
|---|---|
| Bubble | What a user or agent said |
| Result Chip | Link to a canvas card or output |
| Walkthrough Chip | Link to canvas Run Playback |
| Run Chip | Link to plan/action/context inspection |
| Type Badge | `Agent` or `Board` thread identity |
| Session Badge | `Fresh`, `Resumed`, `Forked`, or `Stateless` runtime memory state |
| Avatar/Profile | Agent identity and config entrypoint |
| Card | Work object on the canvas |
| Drawer/Panel | Inspection, diagnostics, config, or run detail |

Do not make every control look equally important. Bubbles and result chips are primary. System status and diagnostics are secondary.

### Agent identity (AGENT-05, 2026-10-31)

Who is speaking or working is metadata outside the bubble, KakaoTalk-style,
never inside it.

- An Agent answer carries its author's face and name beside and above the
  bubble. The face is the saved photo (D-A3: PNG/JPEG/WebP, 512KB) once
  EG-Desk has read it, else the saved emoji or initial on its palette tone
  (D-G2: light background, dark ink). The avatar captured when the answer was
  sent wins; an older answer borrows the room Agent's face only while the name
  still matches. User bubbles keep their right alignment and no face.
- While an Agent works (turn running, tool in flight), `[···] Agent 작업 중`
  sits at the end of the conversation beside that Agent's face. Each busy run
  gets its own bubble, so a Board Thread with several Agents at work shows one
  per Agent, each named above its bubble. Pressing a bubble opens the activity
  record at that run; the bubble never shows thought text. It disappears when
  the run ends.
- A Browser Card an Agent is reading or operating names that Agent in its
  header: a small face and the name beside the BRW-13 badge, kept while the
  badge still counts recent activity, gone when 대표님 takes the Card back or
  the badge hides.
- Colours come from `--egd-*` tokens only.

---

## Session Badges

Thread and provider session are different things. Show provider/runtime behavior with compact badges.

```text
Fresh     = new runtime session for this run/thread
Resumed   = provider continued an existing runtime session
Forked    = provider branched from a previous session or context point
Stateless = provider cannot resume, so EG-Desk rebuilt context explicitly
```

Default policy:

- Simple follow-up inside the same Agent DM: prefer `Resumed`.
- Same agent inside the same Board Thread: prefer `Resumed`.
- Agent DM routed into an existing Board: prefer the Board-scoped session if available.
- Independent review or alternate viewpoint: prefer `Fresh` or `Forked`.
- Provider without session resume: show `Stateless`, and bind the explicit context bundle to the run.

---

## Layer Split

The chat timeline contains:

- user bubbles
- agent bubbles
- conversationally complete replies and medium-appropriate summaries
- result chips
- walkthrough chips
- run chips
- route/move notifications

The chat timeline does not contain by default:

- full reports
- full decks
- raw tool logs
- hidden reasoning dumps
- long action traces
- full agent configuration

Those belong here:

```text
Final report/deck/file -> Canvas Card
Step-by-step derivation -> Canvas Run Playback
Plan/Action/Context    -> Run Bubble or Run Panel
Agent config           -> Agent Profile, then Config Card
Tool logs/errors       -> Diagnostics Panel
```

---

## Naming Rules

Preferred product labels:

```text
Agent DM       // not "personal chat"
Board Thread   // not "group chat"
Chat Home
Run
Plan
Action
Context
Result Chip
Walkthrough Chip
Canvas Card
Profile
Diagnostics
```

Avoid `Thinking` as a surfaced product label. Use `Plan`, `Run`, `Action`, and `Context`.

Avoid exposing provider implementation terms as the first UI layer. `Codex`, `Gemini`, or `Claude` can be visible as provider badges, but the user-facing workflow is Agent/Board first.

---

## UI Acceptance Checks

The current UI pass should be considered aligned only if:

- The user can tell whether a conversation is an Agent DM or Board Thread at a glance.
- The user can tell whether a runtime is Fresh or Resumed without reading a paragraph.
- The default chat surface reads as conversation, not a console.
- Diagnostics are reachable but not mixed into the normal message flow.
- A final result keeps a conversationally complete Chat explanation and may use a chip/link to open or focus its canvas artifact.
- A Result Chip is a UI affordance and reference, not a separate durable domain object by default.
- A long or complex result can be followed through a Walkthrough Chip without duplicating the full artifact body in Chat.
- Agent/profile configuration is accessible from profile surfaces, not stuffed into chat bubbles.
