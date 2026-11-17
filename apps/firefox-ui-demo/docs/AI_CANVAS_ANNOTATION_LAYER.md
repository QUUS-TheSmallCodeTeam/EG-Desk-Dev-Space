# AI Canvas Annotation Layer

**Date**: 2026-05-19 (갱신 2026-10-24 1-N 상태 모듈, 2026-10-31 CNV-06 메모 화면 연결)
**Status**: 표식(CNV-05)은 상태 모듈만, 메모(CNV-06)는 화면까지 연결됨 [런타임: node --test만 · 실화면 미검증]
**Scope**: EG-Desk Firefox shell, canvas shapes, card-local visual analysis, AI-generated annotations, Canvas 메모(CNV-06)

---

## 2026-10-24 갱신 — 지금 있는 것과 남은 것

**대표님이 보게 될 결과 (화면 연결 S7 뒤)**: Agent가 카드 위에 올린 표식이 '제안'으로 뜨고, [모두 받기]·하나씩 받기·지우기·옮기기를 할 수 있으며, 받은 표식만 Board와 함께 저장된다. Canvas 메모에 [Rio에게 묻기]를 누르면 메모 내용이 Chat 질문으로 가고, Rio의 답은 그 메모 안 답글로 한 번만 붙는다. **표식은 아직 계산 모듈만 있다. 메모는 2026-10-31에 화면에 연결됐다** — Dock [메모]로 만들고, 카드 위에 붙어 따라다니고, 접힘 240×160·펼침 320×280, [<Agent>에게 묻기]가 그 Agent의 방으로 실제 전송되고, 답이 메모 답글로 붙는다(D-K5). node 시험만 통과했고 Firefox 실화면은 아직 보지 않았다.

| 무엇 | 파일 | 상태 |
|---|---|---|
| 표식 묶음 상태 | `overlay/resources/EGDeskAnnotationState.sys.mjs` | 모듈·node 시험 통과 [런타임: node --test만] |
| 메모·답글 상태 | `overlay/resources/EGDeskMemoState.sys.mjs` | 모듈·node 시험 통과 [런타임: node --test만] · 2026-10-31 두 고정 크기·requestId 라우팅 추가 |
| 시험 | `scripts/egdesk-annotation-memo.test.mjs` | 18개 |
| 화면(표식 레이어) | `eg-desk-surface.uc.js` | S7 차례, 미구현 |
| 화면(메모 카드) | `eg-desk-surface.uc.js` 'Canvas Memo (CNV-06)' 구역: `spawnMemoCard`·`askMemoAgent`·`attachMemoRepliesFromRun`, Dock '메모', `.egd-memo-*` CSS | 연결됨(2026-10-31) [실화면 미검증] |
| Agent가 표식을 올리는 도구 | helper 2차 묶음 2-BH | 미구현, D-K1 뒤 |

**결정**: 2026-10-24에 D-K1(카드 위 점선 '제안'으로 바로)과 D-K5(메모 질문의 답은 메모 답글로 자동)가 정해졌다. 메모 화면은 D-K5대로 askId와 함께 `appendMemoReply()`를 부르고, Chat에는 '메모 #N 답글로 붙음' 칩만 남긴다(D-K4).

### 표식 묶음 (CNV-05) — 모듈이 정본

아래 '## Annotation Spec'의 2026-05 개념 타입은 참고용이다. 실제 모양은 `normalizeAnnotationSet()`가 돌려주는 것이다.

```ts
type AnnotationSet = {
  version: 1;
  id: string;                       // 토큰 [A-Za-z0-9][A-Za-z0-9_.:-]{0,127}
  space: 'card' | 'canvas';         // targetCardId가 있으면 'card', 없으면 자유 Canvas
  targetCardId?: string;
  targetKind?: 'browser' | 'image' | 'pdf' | 'deck' | 'file' | 'canvas-region';
  agendaId?: string; sourceRunId?: string; sourceMessageId?: string; createdByAgentId?: string;
  grounding?: 'dom' | 'visual' | 'both';           // 표식이 무엇을 보고 나왔는지
  source?: {                                       // 'card'만. Browser 관찰 당시의 문서 신원
    documentId?: string; revision?: number;
    viewport?: { width: number; height: number }; scroll?: { x: number; y: number };
  };
  createdAt: number;                               // epoch ms (Desk 스냅샷 savedAt과 같은 단위)
  items: AnnotationItem[];                         // 1~32개
};
type AnnotationItem = {
  id: string;
  type: 'box' | 'ellipse' | 'highlight' | 'line' | 'arrow' | 'label';
  rect?: { x: number; y: number; w: number; h: number };   // box·ellipse·highlight
  from?: { x: number; y: number }; to?: { x: number; y: number }; // line·arrow
  at?: { x: number; y: number };                           // label
  label?: string;          // 이름표(≤120자). label 종류는 필수
  note?: string;           // 마우스를 올리면 보이는 설명(≤280자)
  purpose?: 'locate' | 'critique' | 'evidence' | 'instruction' | 'diff' | 'warning';
  confidence?: number;     // 0~1
  ref?: string;            // Browser 관찰 요소 ref. 다시 찾기용이며 입력 대상이 아니다
  fromItemId?: string; toItemId?: string;  // 화살표가 같은 묶음의 다른 표식을 가리킬 때
  status: 'proposed' | 'accepted' | 'edited' | 'dismissed';
  edit?: { original: {...geometry, label?}; editedBy: 'user' | 'agent'; editedAt?: number };
};
```

2026-05 초안에서 바뀐 점:

- **좌표**: 'card'는 카드 내용 영역의 0~1 비율(excalidraw FixedPointBinding처럼). 스크롤한 뒤 사용자가 옮긴 표식은 0~1 밖일 수 있어 ±100까지 허용한다. 'canvas'는 Desk 월드 좌표.
- **스크롤**: 같은 문서에서 스크롤만 바뀌면 `annotationScrollOffset()`이 표시 위치만 옮긴다. 저장된 좌표는 바뀌지 않는다.
- **신선도** `annotationFreshness(set, 현재 관찰)`: `unbound`(자유 Canvas·문서 신원 없음) / `current` / `revised`(같은 문서지만 내용·창 크기가 바뀜, 안내만) / `stale`(다른 문서: 이동·새로고침) / `unknown`(현재 신원을 모름). `stale`·`unknown`은 받기를 거절한다(`ANNOTATION_STALE`). 지우기는 언제나 된다. Browser actor의 documentId는 문서를 새로 읽을 때마다 바뀌므로 **재시작 뒤 저장된 Browser 표식은 stale로 보인다** — 화면은 흐리게 두고 지우기·다시 묻기를 제공한다.
- **받기**: `acceptAnnotations(set, {itemIds?, current})` — itemIds가 없으면 묶음 전체(tldraw의 묶음 받기). 사용자가 고친 표식은 `edited`로 남는다. 묶음 상태 `annotationSetStatus()`는 proposed / partial / accepted / dismissed.
- **저장**: `annotationSetForBoard()`는 accepted·edited만 남긴다(제안은 dirty overlay, 지운 것은 Canvas에서 빠짐). 저장하지 않는 표식을 가리키던 화살표 끝은 지운다. 되살리기는 `restoreAnnotationSet()`.
- **저장소 규칙**: 필드 이름은 helper chat/desk store의 PRIVATE_KEYS에 걸리지 않는다(시험이 확인). 모델·사용자 문자열을 객체 키로 쓰지 않는다.
- **Board를 새 id로 열 때**: 표식의 `targetCardId`, 메모의 `anchor.cardId`·`links[].targetViewId`는 `EGDeskSurfaceState.remapMemberReferences()`가 그대로 바꾼다(시험이 확인). 요소 `ref`는 바꾸지 않는다.
- **표시 규칙**: 표식은 표시층이다. 아래 카드에 아무 동작도 하지 않고, 표식 좌표를 입력 좌표로 다시 쓰지 않는다(REA EG-03, EG-08·B-05).

### 메모 (CNV-06)

```ts
type MemoRecord = {
  version: 1; id: string; seq?: number;            // Board 안 번호(#3)
  anchor: { kind: 'card'; cardId: string; x: number; y: number; at?: {x, y} }  // 카드 위 0~1 + 마지막 월드 위치
        | { kind: 'canvas'; x: number; y: number };
  expanded: boolean;                               // 접힘 240×160 / 펼침 320×280 (MEMO_FRAME); 본문은 틀 안에서 스크롤
  author: { kind: 'user' } | { kind: 'agent'; agentId: string; name?: string };
  text: string;                                    // ≤2000자
  resolved: boolean; createdAt: number; updatedAt: number;
  replies: { id; author; text; createdAt?; answerId?; askId?; runId?; truncated? }[];  // ≤200
  asks: { askId; agentId; status: 'pending' | 'answered' | 'cancelled'; askedAt?; answerId?; requestId?; threadId? }[];  // requestId: 질문이 나간 Chat 요청 — 답을 되돌리는 열쇠
  links: { targetViewId: string; label?: string }[]; // 메모 → 카드·도형 선(≤8), JSON Canvas edge로 내보냄
};
```

- 메모를 놓으면 그 아래 맨 위 카드에 붙는다(`memoAnchorAt`, Penpot이 옮긴 스레드의 frame을 다시 찾는 방식). 카드가 닫히면 마지막 위치에 남는다(`memoPosition().missing`).
- [Agent에게 묻기]: `memoAskDraft()` → Chat에 보낼 글 한 개(메모 번호·id, 본문, 최근 답글 3개, 질문)와 `askId`, 관련 카드 id. 보내기가 성공한 뒤에만 `recordMemoAsk()`로 대기 중 질문을 남긴다.
- 답글: `appendMemoReply()` → `{memo, appended, reason}`. 같은 answerId는 한 번만(`duplicate`). 질문에 대한 답은 그 질문이 대기 중일 때만, 물어본 Agent의 답만 붙는다(`ask-closed`·`ask-mismatch`, CopilotKit의 '실행 중일 때만 응답' 방식). Agent 답이 2000자를 넘으면 잘리고 `truncated`, 전체는 Chat의 answerId에 있다. `memoReplyFromRun(run)`이 완료된 Chat run(assistant 메시지 합침)을 답글 후보로 바꾸고, `findPendingMemoAsk(memos, requestId)`가 그 run이 답한 메모를 찾는다.

**화면 연결(2026-10-31, uc.js 'Canvas Memo (CNV-06)' 구역)**

- 만들기: Dock [메모] → 선택한 카드의 오른쪽 위(없으면 보이는 Canvas 가운데)에 메모 카드(`spawnMemoCard`, Desk window kind 'memo', `--egd-note` 바탕). 크기 조절 손잡이는 없고 [펼치기]/[접기]가 두 틀을 오간다.
- 따라가기: Canvas 레이어의 `MutationObserver`(카드 style·childList)가 다음 프레임에 `memoPosition()`으로 메모를 옮긴다. 메모를 끌어 놓으면 `moveMemo()`가 그 아래 카드에 다시 고정하고, 카드가 닫히면 '대상 없음' 배지로 마지막 위치에 남는다.
- 저장·복원: `serializeCardState` type 'memo', runtimeState = MemoRecord. Board는 `mountBoardMember`, Desk 세션은 `restoreCardFromState`가 `spawnMemoCard({ restore: true, record })`를 부른다(읽을 수 없는 기록은 Board '구성원 다시 확인' 자리표시).
- [<Agent>에게 묻기]: Agent 선택(`codexAgentProfileChoices`) + 질문 → `memoAskDraft()`(본문·대상 카드 이름·최근 답글·질문) → 그 Agent의 DM 방(없으면 `createThread`)의 초안에 넣고 기존 `sendMessage()`를 부른다. 새로 접수된 요청(`chatProtocol.requests`, status 'accepted')의 requestId만 `recordMemoAsk()`에 남긴다. 본문 저장은 어떤 Agent도 부르지 않는다.
- 답(D-K5): `syncProtocolRun` 끝의 한 줄 `attachMemoRepliesFromRun(run)` → `findPendingMemoAsk()` → `memoReplyFromRun()` → `appendMemoReply()`(작성자 아바타·이름으로 쌓임, 자동 펼침). 실패·중단된 run은 그 질문을 `cancelled`로 닫는다. Chat 메시지에는 `memoChipForAnswer()`의 칩만(D-K4).
- 아직 없는 것: 메모 → 카드 `links` 그리기(JSON Canvas edge), 수정 전 메모에 대한 답 표시, 재촉 알림, Board 재개 시 카드 id 재배정에 따른 `anchor.cardId` 재매핑(기록은 `remapMemberReferences`를 통과하지만 복원 경로가 record를 재매핑하지 않음), Firefox 실화면 검증.

### 따른 레퍼런스

| 레퍼런스 | 라이선스 | 읽은 곳 | 가져온 것 |
|---|---|---|---|
| tldraw/agent-template | MIT | `shared/format/FocusedShape.ts:24-105`, `shared/types/ChatHistoryItem.ts:28-33`, `client/agent/managers/AgentActionManager.ts:90-158`, `client/components/chat-history/ChatHistoryGroupWithDiff.tsx:16-72`, `shared/types/ContextItem.ts:5-29` | 구조화 도형·note·대상 id 화살표, pending/accepted/rejected, 묶음 받기·묶음 상태 |
| excalidraw | MIT | `packages/element/src/types.ts:97-105`, `:316-333` | 0~1 비율 좌표 (sticky note baseHeight는 2026-10-31 CNV-06 결정의 두 고정 크기로 대체) |
| Penpot | MPL-2.0, 패턴만 | `backend/src/app/rpc/commands/comments.clj:42`, `:446-455`, `:494-548`, `:569-586`, `frontend/.../comments.cljs:155-193` | 위치·frame 고정 스레드, 번호, 해결 상태, 첫 글과 답글 분리 |
| CopilotKit | MIT | `packages/react-core/src/v2/hooks/use-human-in-the-loop.tsx:31-105` | 응답은 요청이 진행 중일 때만 |
| JSON Canvas 1.0 | MIT | `spec/1.0.md` Edges | fromNode·toNode·toEnd·label |

코드는 옮기지 않았다(모두 패턴만). 모듈 머리말에 출처를 적었다.

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

> 2026-10-24: 아래 타입은 2026-05 개념 초안이다. 정본은 위 '표식 묶음 (CNV-05) — 모듈이 정본'과 `EGDeskAnnotationState.sys.mjs`다(createdAt은 epoch ms, label 종류는 `at`+`label`, 신선도용 `source`가 추가됨).

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
  - Implemented (2026-11-17): screen-wide via 표식·메모 숨기기; per card via the set bar's 숨기기/다시 보기 toggle (every AI mark on that card; a free Canvas set hides only itself). Neither is saved; opening a set from its chat chip shows it again.

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

> 2026-10-24: P1의 카드 기준 비율 재투영과 P2의 받기·지우기 계산은 상태 모듈로 준비됐다(화면 미연결). 표식 종류 6개는 모두 지금 Canvas 도형 종류(rect·ellipse·highlight·line·arrow·label)로 그려진다.

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

