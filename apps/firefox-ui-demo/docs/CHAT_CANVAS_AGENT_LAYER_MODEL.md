# Chat, Canvas, and Agent Layer Model

**Date**: 2026-05-18
**Status**: Product/UX architecture note
**Scope**: EG-Desk chat UI, canvas outcomes, agent profile/config, run inspection

> **Terminology correction (2026-08-05):** this note's `Run Playback` and
> derivation language is superseded. Use Answer Briefing from Contract §8 and
> Atlas `OBJ-038` / `AI-05`: Agent proposes the Answer's public target set,
> Briefing Order, Focus Scope, and Step Explanation; System performs
> user-controlled step transitions. It is not a Run replay.

---

## Core Principle

Chat and Canvas are medium-specific projections of one answer.

Chat is the conversational communication layer. Canvas is the spatial, visual,
interactive, and artifact work surface. Neither is a dumping ground for content
that belongs in the other. Agent profile and run inspection are where process,
configuration, and context are inspected.

```text
Conversation = what the user and agent said
Canvas       = what the agent produced or opened
Profile      = who/what the agent is
Run Bubble   = how this specific answer was planned and executed
Run Playback = how the user follows the answer step-by-step on the canvas
```

---

## Default Chat UX

The default chat timeline should feel closer to KakaoTalk or Slack than to a raw agent log.

It contains:

- user chat bubbles
- agent chat bubbles
- short final summaries
- result links/chips

It does not contain by default:

- full report bodies
- raw tool logs
- long action traces
- raw reasoning/thinking dumps
- full agent configuration

Example:

```text
User:
5월 리포트 만들어줘

Agent:
5월 리포트 초안을 만들었습니다.
[Report Card] [Deck Draft] [Evidence Notes]
```

Clicking a result chip opens the result on the canvas as a card.

`Result Chip` is a compact navigation affordance in the chat UI. It is not a
durable domain object. Its linked artifact, message, run, or view can be
durable.

---

<a id="agenda-thread"></a>
## Board Thread

A Board Thread is a work-scoped shared conversation. Multiple agents, the
user, and later authorized collaborators may participate like a group chat.
Messages, results, step comments, and run status share the Board context.

Moving work from Agent DM to a Board Thread must not expose an entire private
DM automatically. The system links or copies only the selected messages and
resolved context needed for the shared work.

**Implemented flow (2026-10-31, CHAT-03 · D-M3 · D-M2):**

```text
Agent DM bubble ⋯ menu
  -> [Board Thread로 옮기기]            one bubble
  -> [여러 메시지 골라 옮기기]           checkboxes + a bar above the log (max 20)
  -> picker: an existing Board Thread, or [새 Board Thread 만들기]
     (the new room is led by the DM's Agent)
  -> POST /chat/share { fromClientThreadId, toClientThreadId, localMessageIds }
```

- Board Thread: the copies appear as one block per move, placed where the
  store saved them, with `[원래 대화 보기]` back to the DM bubble. The
  receiving Agent reads the block once, with its next turn
  (`<egdesk-shared-messages>`); the person's saved message never changes.
- Agent DM: the original bubbles stay; each gets a `스레드로 보냄` chip
  that opens the Board Thread.
- Board Thread header: `[DM으로 돌아오기]` returns to the DM that last sent
  copies here.
- Mentions: `@이름` / `[@이름](agent://profileId)` chips under a Board
  Thread bubble (same rules as the helper's `boardMentions`); an unread
  Agent line that calls the person (`@나`, `@사용자`, `@사람`) puts an `@`
  badge on the room row. Which Agents answer stays the helper's D-M2 rule;
  routing several Agents from the composer is CHAT-10.
- Record: chat store events `messages.shared.in` (copies + link back) and
  `messages.shared.out` (ids + link forward); the screen reads them into
  `thread.routing` (`EGDeskThreadRouting.sys.mjs`).

---

## Canvas Outcome

Spatial, visual, interactive, and artifact-oriented parts of the answer belong
on the Desk/canvas. Conversational explanation, decisions, and next actions can
remain complete in Chat. Both surfaces bind to the same result and provenance.

Result chip behavior:

```text
[Report Card] click
  -> open report card on canvas

[Deck Draft] click
  -> open PPT/deck card on canvas

[Evidence Notes] click
  -> open notes/file card on canvas

[Annotations] click
  -> focus target card and show AI-created annotation layer

[Result Walkthrough] click
  -> open canvas Run Playback for this result
```

The result card keeps a binding back to the chat run that created it.

The model sketches retain `agendaId` and `"agenda"` as identifier spellings;
Board is the product label.

```ts
Card = {
  id: string;
  viewType: "agenda" | "browser" | "file" | "chat" | "terminal" | "ppt" | "excel" | "notes" | "ontology";
  target: ResourceBinding;
  agendaId?: string;
  runId?: string;
  createdFromMessageId?: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  viewState: Record<string, unknown>;
}
```

AI visual annotations also belong on the canvas, not in a long chat reply. The chat bubble should summarize the action and link to the annotated card/run.

```text
User:
이 화면에서 문제 있어 보이는 부분 표시해줘

Agent:
3곳을 표시했습니다.
[Annotations] [Target Card] [Run]
```

Annotation details are modeled separately in [`AI_CANVAS_ANNOTATION_LAYER.md`](./AI_CANVAS_ANNOTATION_LAYER.md).

---

## Canvas Run Playback

Some results need more than a final card but less than a long chat answer.

Canvas Run Playback is the step-by-step walkthrough layer for those cases. It lets the user follow the derivation spatially on the Desk:

```text
Step 1. Request interpretation
Step 2. Evidence collection
Step 3. Intermediate judgment
Step 4. Final artifact
Step 5. Next action
```

Each step can focus cards, reveal annotations, highlight evidence, and show a short explanation. The canvas should not open every artifact at once.

Example:

```text
User:
5월 리포트 만들어줘

Agent:
5월 리포트 초안을 만들었습니다.
[Result Walkthrough] [Report Card] [Evidence Notes] [Run]
```

The user can pause on any playback step and leave a comment anchored to that
step or its focused target. The user may insert selected step comments into the
next Chat message, which carries the step reference and relevant visible
context. This is an annotation-to-conversation flow, not an automatic run
branch.

Run Playback details are modeled separately in [`CANVAS_RUN_PLAYBACK_MODEL.md`](./CANVAS_RUN_PLAYBACK_MODEL.md).

---

## Agent Profile

The agent avatar/profile behaves like a friend's profile in a chat app.

Clicking an agent profile should show:

- display name and avatar
- role / agent type
- model
- provider
- current Board binding
- ontology/context bindings
- enabled tools
- recent runs
- settings entrypoint

The profile is for identity and configuration awareness. It is not the primary result viewer.

```ts
AgentProfile = {
  id: string;
  displayName: string;
  avatar?: string;
  provider: string;
  model: string;
  role: string;
  config: Record<string, unknown>;
  ontologyContexts: ResourceBinding[];
  permissions: string[];
  recentRunIds: string[];
}
```

---

## Run Bubble / Plan Bubble

The old "thinking" layer should be modeled as a user-visible Plan/Run inspection layer.

This is not raw hidden reasoning. It is a structured trace of:

- goal
- plan
- action history
- blockers
- decisions
- context snapshot
- output bindings

It is reached by drilling down from the agent profile, the run indicator, or an agent bubble.

```text
Agent Profile
  -> Recent Runs
      -> Run Bubble / Plan Bubble
```

Example:

```text
Run Bubble: 5월 리포트 초안 작성

Plan
✓ 데이터 파일 확인
✓ 문의 이메일 검증
✓ 리포트 초안 작성
✓ PPT 초안 생성

Actions
✓ Read report data
✓ Gmail search
✓ Created report.md
✓ Created deck.pptx

Context
- Board: 태화 5월 리포트
- Model: ...
- Ontology: ...
```

Plan is the human-readable work structure. Action is the runtime event trace.

```text
Plan Step: 문의 이메일 검증
  Actions:
  - Gmail search
  - thread read
  - duplicate filtering
  - evidence note creation
```

---

## Agent Config Editing

Agent configuration is inspected from the profile, but editing should happen on the canvas.

Flow:

```text
Agent avatar click
  -> Agent Profile
  -> Settings / Configure
  -> open Agent Config Card on canvas
```

Rationale:

- the profile is lightweight and chat-native
- configuration is a work object
- editing config may need context, examples, ontology bindings, permissions, and model choices
- canvas gives enough room for a proper configuration surface

---

## Interaction Map

| User action | Result |
|---|---|
| Click agent bubble text | Open message/result detail |
| Click result chip | Open/create linked canvas card |
| Click agent avatar | Open agent profile |
| Click run indicator | Open run bubble / plan bubble |
| Click profile settings | Open agent config card on canvas |
| Click canvas result card provenance | Jump back to source chat bubble/run |

---

## Data Model Sketch

```ts
ChatBubble = {
  id: string;
  role: "user" | "agent" | "system";
  textSummary: string;
  resultLinks: ResultLink[];
  agentId?: string;
  runId?: string;
  agendaId?: string;
}

ResultLink = {
  label: string;
  resourceId?: string;
  cardId?: string;
  openMode: "canvas-card" | "focus-existing-card" | "open-profile" | "open-run";
}

AgentRun = {
  id: string;
  agentId: string;
  agendaId?: string;
  sourceMessageId: string;
  goal: string;
  plan: Plan;
  actions: AgentAction[];
  contextSnapshot: AgentRunContext;
  outputs: ResultLink[];
}

Plan = {
  steps: PlanStep[];
  currentStepId?: string;
  nextStep?: string;
}

PlanStep = {
  id: string;
  title: string;
  status: "planned" | "running" | "done" | "blocked" | "skipped";
  linkedActionIds: string[];
  linkedCardIds: string[];
  decisionNote?: string;
  blocker?: string;
}

AgentAction = {
  id: string;
  runId: string;
  type: "tool_call" | "web_search" | "browser_action" | "file_edit" | "terminal_cmd" | "subagent";
  title: string;
  targetCardId?: string;
  status: "pending" | "running" | "done" | "failed";
  inputSummary?: string;
  outputSummary?: string;
  evidenceRef?: string;
}
```

---

## Product Language

Recommended user-facing terms:

```text
Chat Bubble     = 대화 버블
Result Chip     = 결과 링크 / 결과 칩
Canvas Card     = 카드
Agent Profile   = 에이전트 프로필
Run Bubble      = 실행 내역
Plan            = 계획
Action          = 액션
Context         = 맥락
Config Card     = 설정 카드
```

Avoid making "thinking" the main product label. Use Plan / Run / Action / Context instead.
