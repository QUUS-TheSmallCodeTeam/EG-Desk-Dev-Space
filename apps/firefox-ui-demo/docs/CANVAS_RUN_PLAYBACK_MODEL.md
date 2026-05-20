# Canvas Run Playback Model

**Date**: 2026-05-19
**Status**: Product/UX architecture concept note
**Scope**: EG-Desk chat summaries, result chips, canvas outputs, run walkthrough, branch/divert feedback

---

## Core Problem

Long AI answers are slow and frustrating to read in a chat bubble.

EG-Desk already separates:

```text
Chat Bubble = compact conclusion and summary
Canvas Card = final work artifact
Run Bubble  = inspectable plan/action/context
Profile     = agent identity and configuration
```

But some outputs still need a readable derivation path. The user may need to see how the agent got from request to final output without reading a long paragraph.

Canvas Run Playback is the guided, step-by-step way to inspect that derivation on the canvas.

---

## Core Sentence

```text
Chat gives the short answer.
Canvas shows the work.
Run Playback lets the user follow how the work was derived.
Run Bubble shows the inspectable plan/action/context record.
```

Run Playback is not raw hidden thinking. It is a user-visible, checkable walkthrough of the answer's derivation, evidence, intermediate outputs, and final result.

---

## Product Labels

Preferred internal/product terms:

```text
Run Playback        = the guided canvas replay for one run
Result Walkthrough  = user-facing chip/action label
Playback Step       = one stage of the derivation
Step Rail           = left/right or vertical step navigation
Divert              = user interrupts the walkthrough with "not this" or a correction
Branch              = alternate follow-up path created from a divert
Steer Back          = AI returns the user to an earlier step when the current confusion is resolved there
```

Avoid exposing this as `Thinking`. If a UI label is needed, use:

```text
Plan
Rationale
Evidence
Action
Context
```

---

## Layer Position

```text
Chat Bubble
  -> compact answer
  -> [Result Walkthrough] [Final Card] [Run]

Canvas Run Playback
  -> step-by-step canvas follow-up
  -> focuses cards, annotations, intermediate outputs
  -> allows divert/branch

Run Bubble / Plan Bubble
  -> structured inspection of plan, action history, context, blockers, output bindings

Agent Profile
  -> agent identity, model/provider, config, recent runs
```

Run Playback sits between a compact chat answer and the detailed Run Bubble.

It should answer:

```text
"Show me how this result unfolded."
```

Run Bubble should answer:

```text
"What exactly did the run plan/use/do?"
```

---

## Default Flow

```text
1. User asks in Agent DM or Agenda Thread
2. Agent replies with a compact chat bubble
3. Chat bubble includes result chips
4. User clicks [Result Walkthrough]
5. Canvas enters Run Playback mode
6. Step rail appears
7. Each step focuses the relevant card/annotation/output
8. User can continue, jump, divert, or open the final card
```

Example:

```text
Chat Bubble:
5월 리포트 초안을 만들었습니다.
[Result Walkthrough] [Report Card] [Evidence Notes] [Run]
```

Clicking `[Result Walkthrough]` should not dump every artifact onto the canvas at once. It should start a guided sequence.

---

## Playback Step Shape

Each step should be short, spatial, and inspectable.

```ts
type RunPlayback = {
  id: string;
  runId: string;
  agendaId?: string;
  sourceThreadId?: string;
  sourceMessageId?: string;
  title: string;
  summary: string;
  steps: PlaybackStep[];
  branches: PlaybackBranch[];
  feedbackEvents: PlaybackFeedbackEvent[];
  createdAt: string;
};

type PlaybackStep = {
  id: string;
  index: number;
  title: string;
  summary: string;
  purpose: "interpret" | "collect" | "analyze" | "decide" | "compose" | "verify" | "deliver";
  focusTargets: PlaybackFocusTarget[];
  visibleCardIds: string[];
  annotationIds?: string[];
  producedCardIds?: string[];
  evidenceRefs?: ResourceBinding[];
  runPlanStepIds?: string[];
  availableActions?: PlaybackAction[];
};

type PlaybackFocusTarget = {
  cardId?: string;
  annotationId?: string;
  canvasRect?: { x: number; y: number; width: number; height: number };
  zoom?: number;
  reason?: string;
};
```

The step `summary` is for the visible walkthrough. It should be shorter than a normal answer paragraph.

---

## Step Examples

For a report run:

```text
Step 1. Request interpretation
  Focus: chat bubble + Agenda card
  Summary: "The task was interpreted as a management-facing May report draft."

Step 2. Evidence collection
  Focus: GA4/browser/file cards
  Summary: "Traffic and inquiry sources were collected."

Step 3. Validation
  Focus: email/evidence notes
  Summary: "Inquiry count was checked against mailbox evidence."

Step 4. Draft composition
  Focus: report card
  Summary: "The report was assembled using the validated evidence."

Step 5. Final output
  Focus: final report/deck cards
  Summary: "Final draft is ready for review."
```

For a UI design review:

```text
Step 1. Target screen
  Focus: Browser Card or screenshot card

Step 2. Visual issues
  Focus: AI annotation boxes

Step 3. Proposed grammar
  Focus: redesigned section/card

Step 4. Final state
  Focus: updated UI preview
```

---

## Divert Behavior

The user can interrupt a playback step with reactions like:

```text
"어? 이거 아닌데"
"여기서부터 다시"
"이 근거 먼저 보여줘"
"최종본 말고 중간 판단 보여줘"
"이 단계는 스킵"
```

This should create a `Divert` event, not just a new plain chat message.

```ts
type PlaybackFeedbackEvent = {
  id: string;
  playbackId: string;
  stepId: string;
  kind:
    | "not_this"
    | "show_evidence"
    | "skip_step"
    | "jump_to_step"
    | "branch_request"
    | "style_preference"
    | "accept_step";
  userText?: string;
  agentAssessment?: "agent_error" | "user_missed_context" | "ambiguous_requirement" | "preference_change";
  outcome?: "branch_created" | "steered_back" | "step_revised" | "final_revised" | "noted_for_style";
  createdAt: string;
};
```

The agent then chooses one of two broad paths.

### Branch

If the user found a real issue or changed direction:

```text
User: 어? 이거 아닌데
Agent: 맞습니다. Step 3 판단을 새로 분기하겠습니다.
Canvas: creates Branch B from Step 3
```

### Steer Back

If the current confusion is explained by an earlier step:

```text
User: 어? 이거 아닌데
Agent: 이 부분은 Step 2에서 확인한 근거에 기반했습니다. 그 단계로 돌아가겠습니다.
Canvas: jumps back to Step 2 and highlights the evidence
```

This is important because the user may not be wrong or right in a binary way. The product should make the derivation inspectable enough that the user and agent can converge.

---

## Branch Model

```ts
type PlaybackBranch = {
  id: string;
  parentPlaybackId: string;
  fromStepId: string;
  reason: string;
  createdBy: "user" | "agent";
  branchRunId?: string;
  status: "open" | "accepted" | "abandoned" | "merged";
  steps: PlaybackStep[];
};
```

Branching should remain visible:

```text
Main path
  Step 1 -> Step 2 -> Step 3 -> Step 4

Branch B
  from Step 3 -> revised Step 3B -> revised final
```

Do not silently overwrite the original path when the user diverts. Keep the original path so the agent can compare, steer back, or explain the difference.

---

## Personalization Signal

Divert events are valuable personalization data.

Examples:

```text
User often clicks "final only"
  -> default future walkthroughs should start collapsed

User often says "근거 먼저"
  -> future result summaries should put evidence chips first

User often diverts at interpretation steps
  -> future runs should confirm interpretation before execution

User often asks for visual walkthrough
  -> future long answers should generate Run Playback by default
```

Model this first as local product telemetry/preferences, not as automatic external fine-tuning.

```ts
type FollowupStyleSignal = {
  id: string;
  userId?: string;
  agentId?: string;
  agendaId?: string;
  source: "playback_divert" | "step_accept" | "chip_click" | "manual_preference";
  signal:
    | "prefers_final_first"
    | "prefers_evidence_first"
    | "prefers_step_by_step"
    | "skips_process"
    | "requires_interpretation_confirmation"
    | "prefers_visual_annotations";
  strength: number;
  createdAt: string;
};
```

If these events are later used for fine-tuning or cross-session learning, EG-Desk should make that boundary explicit. The safe default is local personalization and user-visible preference inference.

---

## Planning Impact

Generating a good playback requires the agent to plan better before answering.

The agent must identify:

```text
What was interpreted?
What evidence was used?
What intermediate decisions were made?
What artifact was produced?
What should be inspectable later?
Where could the user naturally challenge the result?
```

That planning improves answer quality even if the user never opens the walkthrough.

For non-trivial runs, the agent should produce both:

```text
Answer summary
Playback outline
Run record
```

---

## UI Behavior

Run Playback mode should feel like a canvas-native slide/wireframe walkthrough, not a document reader.

Core controls:

```text
Previous step
Next step
Step rail
Jump to final
Show evidence
Open Run
Divert from here
Exit playback
```

Each step may:

- pan/zoom the canvas to a relevant region
- focus one or more cards
- show/hide annotation layers
- reveal intermediate output cards
- highlight evidence
- show a short explanation bubble
- offer follow-up actions

The canvas should not be flooded. A playback step should reveal only what is needed for that step.

---

## Relationship To AI Annotation Layer

Run Playback can use annotations as visual anchors.

```text
Step 2: "문제 영역을 확인했습니다"
  -> show AI annotation boxes on target card

Step 3: "이 영역 때문에 버튼 위계가 애매합니다"
  -> focus annotation + show short rationale
```

Annotations are the visual marks. Run Playback is the temporal sequence that explains why and when those marks matter.

See [`AI_CANVAS_ANNOTATION_LAYER.md`](./AI_CANVAS_ANNOTATION_LAYER.md).

---

## Relationship To Run Bubble

Run Playback and Run Bubble are related but not the same.

```text
Run Playback
  user-facing guided derivation
  optimized for following the result visually
  step-by-step on canvas

Run Bubble / Plan Bubble
  structured run inspection
  optimized for audit/debug/config understanding
  plan/action/context records
```

The same run can power both views.

---

## MVP Cut

P0:

- Add `Result Walkthrough` chip type.
- Define `RunPlayback` and `PlaybackStep` data shape.
- Playback can focus existing canvas cards step-by-step.
- Playback can show short step summaries.
- User can go previous/next/final/exit.
- Divert event can be recorded as local data.

P1:

- Playback can show/hide annotations per step.
- Playback can branch from a selected step.
- Agent can steer user back to earlier evidence step.
- Step acceptance/rejection updates follow-up style signals.

P2:

- Automatic playback outline generation from run plans.
- Personalization layer changes future answer format.
- Branch comparison UI.
- Optional export of playback as report/deck/walkthrough artifact.

---

## Acceptance Checks

The feature is aligned only if:

- Long chat answers stay compact by default.
- Clicking a result summary opens a guided walkthrough, not a wall of artifacts.
- Each playback step is spatially anchored to cards, annotations, or outputs.
- User can divert from any step.
- The original path is preserved when a branch is created.
- The agent can steer back to prior evidence when the user's confusion is resolved there.
- Feedback events become local personalization signals.
- Raw hidden reasoning is not exposed as `Thinking`; only plan, rationale, evidence, action, and context are surfaced.

