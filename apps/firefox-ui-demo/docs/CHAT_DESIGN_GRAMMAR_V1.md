# EG-Desk Chat Design Grammar v1

**Date**: 2026-05-19
**Status**: Product/UI decision note
**Scope**: Firefox shell Chat HUD, canvas chat cards, agent profile entrypoints, Agenda routing

---

## Core Sentence

Chat is the work-entry surface. It is not the workspace, not the result viewer, and not the raw execution console.

```text
Chat      = where the user speaks and receives compact replies
Agenda    = where work belongs
Canvas    = where work objects live
Run       = one execution record
Profile   = who the agent is and how it is configured
Context   = what was available to the run
```

The default chat should read like a messenger. Technical process is available, but it is reached by drilling into a run, profile, or diagnostic surface.

---

## Two Entry Modes

EG-Desk needs both person-like direct messages and Agenda-based work rooms.

```text
Agent DM
  -> user talks to a specific agent/profile
  -> agent may answer directly
  -> agent may route work into an Agenda Thread

Agenda Thread
  -> user starts from a work room
  -> multiple agents, cards, outputs, prior runs, and decisions can be present
  -> only scope-relevant agents should act
```

An Agent DM is a reception and delegation surface. It is not always the final work location.

An Agenda Thread is the visible room for a task, project, or work pairing. It behaves like a group chat, but the product label should be `Agenda`, not generic `group`.

---

## Routing Model

Keep these concepts separate in data and UI:

```ts
conversationLocation // where the user spoke
workOwner            // Agenda or thread where the work belongs
runOwner             // concrete execution/run record
replyDestination     // where the user should see the result or be tagged
```

Examples:

```text
User starts in Agent DM
  -> agent decides Agenda B is the right room
  -> agent collaborates there
  -> result returns to Agent DM, or user is tagged inside Agenda B

User starts in Agenda Thread
  -> only relevant agents respond
  -> outputs open as canvas cards
  -> follow-up stays agenda-scoped unless explicitly moved
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
| Type Badge | `Agent` or `Agenda` thread identity |
| Session Badge | `Fresh`, `Resumed`, `Forked`, or `Stateless` runtime memory state |
| Avatar/Profile | Agent identity and config entrypoint |
| Card | Work object on the canvas |
| Drawer/Panel | Inspection, diagnostics, config, or run detail |

Do not make every control look equally important. Bubbles and result chips are primary. System status and diagnostics are secondary.

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
- Same agent inside the same Agenda Thread: prefer `Resumed`.
- Agent DM routed into an existing Agenda: prefer the agenda-scoped session if available.
- Independent review or alternate viewpoint: prefer `Fresh` or `Forked`.
- Provider without session resume: show `Stateless`, and bind the explicit context bundle to the run.

---

## Layer Split

The chat timeline contains:

- user bubbles
- agent bubbles
- compact summaries
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
Agenda Thread  // not "group chat"
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

Avoid exposing provider implementation terms as the first UI layer. `Codex`, `Gemini`, or `Claude` can be visible as provider badges, but the user-facing workflow is Agent/Agenda first.

---

## UI Acceptance Checks

The current UI pass should be considered aligned only if:

- The user can tell whether a conversation is an Agent DM or Agenda Thread at a glance.
- The user can tell whether a runtime is Fresh or Resumed without reading a paragraph.
- The default chat surface reads as conversation, not a console.
- Diagnostics are reachable but not mixed into the normal message flow.
- A final result is represented as a chip/link that opens or focuses a canvas card.
- A long or complex result can be followed through a Walkthrough Chip without turning the chat bubble into a long report.
- Agent/profile configuration is accessible from profile surfaces, not stuffed into chat bubbles.
