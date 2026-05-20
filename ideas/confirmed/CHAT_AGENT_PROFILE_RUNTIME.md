# Chat Agent Profile Runtime

## Runtime Model

EG-Desk chat threads carry three runtime fields:

- `agentProfileId`: the selected reusable profile.
- `toolMode`: a compact label for the expected operation mode.
- `systemPrompt`: the instruction block generated from the selected profile.

The visible chat UI should stay lightweight. It shows short profile and tool-mode chips, while the full prompt remains runtime configuration.

## Seed Profiles

- `conversational-coding`: default Agent DM profile for short conversational replies, basic tool use, and coding-context awareness.
- `tool-operator`: focused tool-call profile that reports only observed tool results.
- `coding-project-manager`: default Agenda Thread profile for high-level coding project coordination.
- `codebase-explorer`: read-first codebase investigation profile.
- `implementation-worker`: scoped implementation and targeted verification profile.
- `review-verifier`: review and regression-verification profile.

## Bridge Boundary

The current Codex SDK thread API accepts user input and thread options, but not a dedicated system-prompt field. EG-Desk therefore sends the profile prompt through the bridge as an application runtime-context envelope before the user message.

The displayed user bubble remains the user's raw message. The hidden runtime envelope is only sent to the Codex SDK turn.

## Product Rule

Agent DM is the lightweight reception surface. Agenda Thread is the project/work room. A profile can be attached to either, but the default is:

- Agent DM: `conversational-coding`
- Agenda Thread: `coding-project-manager`
