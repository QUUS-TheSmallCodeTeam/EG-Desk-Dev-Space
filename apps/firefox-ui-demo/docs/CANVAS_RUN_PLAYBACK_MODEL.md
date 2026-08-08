# Legacy Canvas Run Playback Model — superseded terminology

**Date**: 2026-05-19
**Status**: `SUPERSEDED / HISTORICAL REFERENCE`
**Scope**: EG-Desk chat summaries, result links, temporal/spatial canvas walkthrough, and step comments

> **2026-08-05 correction:** Do not implement this document's `RunPlayback`,
> `PlaybackStep`, or Run-centered derivation model as the current product
> contract. The current concept is an optional, user-controlled **Answer
> Briefing** for one logical Answer: an Agent may propose the Canvas output set,
> Briefing Order, Focus Scope, and Step Explanation; the System validates and
> performs viewport/focus transitions when the user selects previous, next,
> overview, a direct step, or exit. Moving between Briefing Steps is not a new
> Agent Run and does not replay hidden reasoning or the Run trace.
>
> Current sources: [Interaction Contract §8](../../../ideas/confirmed/EGDESK_INTERACTION_AND_ORCHESTRATION_CONTRACT.md#8-canvas-answer-briefing-and-briefing-comments),
> [Atlas OBJ-038](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-obj-038),
> and [Atlas AI-05](../../../ideas/confirmed/EGDESK_PRODUCT_INTERACTION_TRACE_ATLAS.md#atlas-ai-05).
> The remainder of this file is retained only to audit earlier terminology and
> interaction ideas; where it conflicts, the Contract and manual-first Atlas win.

---

## Core Problem

Long AI answers are slow and frustrating to read in a chat bubble.

EG-Desk already separates:

```text
Chat Bubble = conversationally complete explanation and conclusion
Canvas Card = final work artifact
Run Bubble  = inspectable plan/action/context
Profile     = agent identity and configuration
```

But some outputs still need a readable derivation path. The user may need to see how the agent got from request to final output without reading a long paragraph.

Canvas Run Playback is the guided, step-by-step way to inspect that derivation on the canvas.

---

## Core Sentence

```text
Chat gives the conversational answer.
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
Step Comment        = user annotation anchored to one playback step or focused target
Add to Next Chat    = action that inserts selected step comments and references into the next message
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
  -> medium-appropriate conversational answer
  -> [Result Walkthrough] [Final Card] [Run]

Canvas Run Playback
  -> step-by-step canvas follow-up
  -> focuses cards, annotations, intermediate outputs
  -> collects step comments for the next conversation turn

Run Bubble / Plan Bubble
  -> structured inspection of plan, action history, context, blockers, output bindings

Agent Profile
  -> agent identity, model/provider, config, recent runs
```

Run Playback sits between the conversational Chat answer and the detailed Run Bubble.

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
8. User can continue, jump, comment, add comments to the next Chat message, or open the final card
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
  comments: PlaybackStepComment[];
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

type PlaybackStepComment = {
  id: string;
  playbackId: string;
  stepId: string;
  targetId?: string;
  userText: string;
  includeInNextChat: boolean;
  createdAt: string;
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

## Step Comment Behavior

The user can pause on any playback step and annotate what they see:

```text
"여기 해석이 달라"
"이 근거를 다음 답변에서 먼저 다뤄줘"
"이 화면의 표시된 부분을 수정해줘"
"이 단계는 설명을 더 붙여줘"
```

The comment remains anchored to the playback step and, when applicable, to a
focused card, annotation, or evidence target. It does not automatically create
a new run or branch.

```text
pause on step
-> write comment
-> optionally select Add to Next Chat
-> next Chat composer shows selected comments and step references
-> user sends one follow-up message
-> agent receives the comments with the relevant playback context
```

General workflow branching can be designed independently of Playback. Playback
comments are an annotation-to-conversation mechanism.

---

## Personalization Signal

Playback navigation and explicit comment choices can be useful local
personalization signals.

Examples:

```text
User often clicks "final only"
  -> default future walkthroughs should start collapsed

User often says "근거 먼저"
  -> future result summaries should put evidence chips first

User often comments on interpretation steps
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
  source: "step_comment" | "step_navigation" | "result_link_click" | "manual_preference";
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
Comment on this step
Add selected comments to next Chat
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
- Step comments can be recorded as local data and inserted into the next Chat message.

P1:

- Playback can show/hide annotations per step.
- Step comments can anchor to focused cards, annotations, or evidence.
- Selected comments carry their step context into the next agent turn.
- Explicit navigation and comment choices can update local follow-up style signals.

P2:

- Automatic playback outline generation from run plans.
- Personalization layer changes future answer format.
- Collaborative step comments and presentation control.
- Optional export of playback as report/deck/walkthrough artifact.

---

## Acceptance Checks

The feature is aligned only if:

- Long chat answers stay compact by default.
- Clicking a result summary opens a guided walkthrough, not a wall of artifacts.
- Each playback step is spatially anchored to cards, annotations, or outputs.
- User can comment on any step and explicitly add selected comments to the next Chat message.
- Step comments retain their playback and target references.
- A step comment does not automatically create a branch or new run.
- Explicit comment/navigation events may become local personalization signals.
- Raw hidden reasoning is not exposed as `Thinking`; only plan, rationale, evidence, action, and context are surfaced.
