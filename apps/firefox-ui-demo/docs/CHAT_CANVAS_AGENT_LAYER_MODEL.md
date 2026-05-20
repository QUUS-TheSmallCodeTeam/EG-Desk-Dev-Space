# Chat, Canvas, and Agent Layer Model

**Date**: 2026-05-18
**Status**: Product/UX architecture note
**Scope**: EG-Desk chat UI, canvas outcomes, agent profile/config, run inspection

---

## Core Principle

EG-Desk chat is not the place where final work lives.

Chat is the human communication layer. Canvas is the work surface. Agent profile and run inspection are where process, configuration, and context are inspected.

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

---

## Canvas Outcome

Final output belongs on the Desk/canvas, not inside the chat bubble.

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

```ts
Card = {
  id: string;
  viewType: "agenda" | "browser" | "file" | "chat" | "terminal" | "ppt" | "excel" | "notes";
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

If the user says "어? 이거 아닌데" during playback, EG-Desk should record a divert event. The agent can branch from that step if the result is wrong, or steer the user back to an earlier evidence step if the confusion is resolved there.

Run Playback details are modeled separately in [`CANVAS_RUN_PLAYBACK_MODEL.md`](./CANVAS_RUN_PLAYBACK_MODEL.md).

---

## Agent Profile

The agent avatar/profile behaves like a friend's profile in a chat app.

Clicking an agent profile should show:

- display name and avatar
- role / agent type
- model
- provider
- current Agenda binding
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
- Agenda: 태화 5월 리포트
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
