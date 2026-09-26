# AI Canvas Annotation Layer

**Date**: 2026-05-19
**Status**: Product/runtime concept note
**Scope**: EG-Desk Firefox shell, canvas shapes, card-local visual analysis, AI-generated annotations

---

## Core Idea

EG-Desk should support an AI annotation layer where an agent can visually mark work objects on the canvas.

This is similar in spirit to asking a multimodal model to find a target in an uploaded image and draw a box around it. In EG-Desk, the product abstraction should not be "AI draws pixels." It should be:

```text
AI returns an annotation spec
EG-Desk renders it as editable canvas primitives
User can accept, move, edit, delete, or persist it
```

The current shape tools are the first primitive foundation:

```text
rect
ellipse
line
```

Next primitives should be:

```text
arrow
label
highlight
freehand path
```

---

## Product Meaning

AI annotations are not final truth. They are visible, editable work marks created by an agent.

Examples:

```text
User: "이 화면에서 로그인 버튼 찾아서 표시해줘"
AI: creates a box + label on the Browser Card

User: "이 UI에서 어색한 부분 박스쳐줘"
AI: creates multiple critique annotations

User: "이 사진에서 라벨/전선/부품 찾아줘"
AI: creates bounding boxes with confidence

User: "보고서 근거가 되는 차트 영역 표시해줘"
AI: creates highlight regions over a file/PDF/deck card
```

This fits the EG-Desk principle that chat is the communication layer and canvas is where work objects live. The AI answer can stay short in chat, while the visual evidence appears directly on the Desk.

---

## Runtime Ownership

The AI should not mutate raw card content directly.

```text
Browser/PDF/Image/File Card
  owns source content

Annotation Layer
  owns marks over that content

Shape Primitive
  owns editable visual geometry
```

The annotation layer may be rendered above:

- browser cards
- image cards
- PDF/file preview cards
- deck/report cards
- whole Board regions
- the free canvas

---

## Coordinate Model

Annotations must use card-local normalized coordinates when they target a card.

```ts
type NormalizedRect = {
  x: number; // 0..1 relative to target content bounds
  y: number; // 0..1
  w: number; // 0..1
  h: number; // 0..1
};
```

Why normalized card-local coordinates:

- canvas pan does not break annotations
- canvas zoom does not break annotations
- card movement does not break annotations
- card resize can reproject annotations
- persisted annotations do not depend on current viewport pixels

Free-canvas annotations can use Desk canvas coordinates:

```ts
type CanvasPoint = {
  x: number;
  y: number;
};
```

Do not store AI annotation geometry as viewport screen pixels except for short-lived drag state.

---

## Annotation Spec

Agents should return a structured annotation spec, not imperative drawing commands.

```ts
type AnnotationSet = {
  id: string;
  agendaId?: string;
  targetCardId?: string;
  sourceRunId?: string;
  sourceMessageId?: string;
  createdByAgentId?: string;
  createdAt: string;
  items: AnnotationItem[];
};

type AnnotationItem =
  | BoxAnnotation
  | EllipseAnnotation
  | LineAnnotation
  | ArrowAnnotation
  | LabelAnnotation
  | HighlightAnnotation;

type BaseAnnotation = {
  id: string;
  label?: string;
  confidence?: number;
  purpose?: "locate" | "critique" | "evidence" | "instruction" | "diff" | "warning";
  status: "proposed" | "accepted" | "edited" | "dismissed";
};

type BoxAnnotation = BaseAnnotation & {
  type: "box";
  rect: NormalizedRect;
};

type EllipseAnnotation = BaseAnnotation & {
  type: "ellipse";
  rect: NormalizedRect;
};

type LineAnnotation = BaseAnnotation & {
  type: "line";
  from: { x: number; y: number };
  to: { x: number; y: number };
};
```

For non-card canvas marks:

```ts
type CanvasAnnotationItem = BaseAnnotation & {
  target: "canvas";
  geometry: {
    type: "rect" | "ellipse" | "line" | "arrow" | "label" | "path";
    points?: CanvasPoint[];
    rect?: { x: number; y: number; width: number; height: number };
  };
};
```

---

## Rendering Rule

Annotation spec is converted into shape primitives.

```text
box       -> rect shape
ellipse   -> ellipse shape
line      -> line shape
arrow     -> line + arrowhead
label     -> text/label primitive
highlight -> translucent rect
path      -> freehand vector path
```

Rendered shapes should remain user-editable. A user edit should change the annotation item status:

```text
proposed -> accepted
proposed -> edited
proposed -> dismissed
```

If an annotation is edited, keep provenance:

```ts
type AnnotationEditHistory = {
  originalGeometry: unknown;
  editedGeometry: unknown;
  editedBy: "user" | "agent";
  editedAt: string;
};
```

---

## Agent Workflow

Default flow:

```text
1. User asks in Chat / Agent DM / Board Thread
2. Agent identifies target card or current selection
3. EG-Desk captures visual state for the target
4. Multimodal model returns annotation spec
5. EG-Desk renders editable annotations on canvas
6. Chat bubble returns a compact summary + result chip
7. Run Bubble stores model, prompt, capture, and annotation output
```

Chat should not contain a long coordinate dump. It should show:

```text
Agent:
표시했습니다.
[3 annotations] [Open target card] [Run]
```

Run/Plan inspection can show the detailed capture and annotation JSON.

---

## Source Capture

The capture source should be explicit.

```ts
type AnnotationCapture = {
  targetCardId: string;
  targetKind: "browser" | "image" | "pdf" | "deck" | "file" | "canvas-region";
  captureKind: "screenshot" | "dom-snapshot" | "pdf-page-render" | "image-bitmap";
  viewportRect?: { x: number; y: number; width: number; height: number };
  contentRect?: { x: number; y: number; width: number; height: number };
  scale?: number;
  sourceRef?: SourceRef;
};
```

For browser cards, the model may need both:

```text
screenshot for visual grounding
DOM/accessibility tree for semantic grounding
```

The annotation spec should state whether the mark came from visual detection, DOM semantics, or both.

---

## UI Behavior

Minimum behavior:

- Click an annotation to select it.
- Drag to move it.
- Delete removes selected annotation.
- Annotation selection should not focus the underlying browser/card unless explicitly requested.
- Annotation hover can show label, confidence, and source run.
- Annotation can be hidden/shown per card or per Board.

Suggested controls:

```text
Show annotations
Hide annotations
Accept all
Dismiss all
Convert to note
Open source run
```

The annotation layer should not block normal card interaction when hidden or disabled.

---

## Persistence

Annotations are Board work objects when they explain or modify the work state.

```text
temporary annotation
  -> dirty overlay only

accepted annotation
  -> Board saved state

dismissed annotation
  -> removed from visible canvas
  -> optional run history remains
```

Persist:

- annotation spec
- target card/source binding
- provenance run/message
- user edits
- accepted/dismissed status

Do not persist:

- transient mouse drag state
- viewport pixel coordinates
- temporary screenshot files unless they are promoted to evidence

---

## MVP Cut

MVP should reuse the current shape system.

P0:

- AI/manual API can create `box`, `ellipse`, and `line` annotations.
- Annotations render over the canvas using existing shape primitives.
- Shapes are selectable, movable, and deletable.
- Annotation items can be attached to a target card id.
- Repeatable verification script confirms create/move/delete.

P1:

- Card-local normalized reprojection on card move/resize.
- Label primitive.
- Arrow primitive.
- Screenshot capture pipeline for selected card.
- Run Bubble provenance link.

P2:

- Multimodal provider integration.
- DOM + screenshot hybrid grounding for browser cards.
- Confidence display.
- Accept/dismiss workflow.
- Annotation search and evidence export.

---

## Acceptance Checks

The feature is aligned only if:

- AI returns structured annotation data, not arbitrary DOM mutations.
- User can edit or delete every AI-created mark.
- Card movement/resize does not break accepted annotations.
- Chat remains compact and links to the annotated card/run.
- Run Bubble contains enough provenance to understand why the annotation exists.
- The annotation layer can be hidden so the underlying work object remains usable.

