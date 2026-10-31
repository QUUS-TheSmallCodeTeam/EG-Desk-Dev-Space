# Browser Agent Observation Runtime

**Date**: 2026-05-20, updated 2026-10-24 (guarded tool path, BRW-05/BRW-06; frames, shadow DOM, editors and long values, BRW-08), 2026-10-31 (masked screenshot, BRW-09)
**Status**: Two runtime paths. The guarded model tool path is implemented in the helper and actor and unit-tested; its scroll/press chrome wiring and native catalog exposure are pending (see Wiring Status).
**Scope**: Firefox Browser Cards, model (Codex) Browser tools, legacy internal agent actions and DOM-change summaries

---

## Two Paths

| Path | Who uses it | Authority |
|---|---|---|
| Guarded tool path | A Codex run with an explicit per-run Browser selection | Run/Card/account binding, fresh observation, exact target, parent `authorizeAct` lease, postcondition |
| Legacy `browserAgent.act` | Internal QA/developer scripts | None beyond the chrome caller; may focus, use coordinates, scroll by delta. Never reachable from a model run |

A model run only reaches the guarded path. Nothing below changes the legacy path.

## Guarded Tool Path

```text
Codex dynamic tool call
  -> helper/codex-chat-runtime.mjs        catalog + per-run tool allow-list (browserBounded)
  -> helper/codex-browser-tool-provider.mjs  interact grant per selected Card and tool name
  -> helper/egdesk-browser-tool-runtime.mjs  fresh observation, exact target, same-site scope,
                                             focus policy, one dispatch per observation, postcondition
  -> helper/codex-browser-tool-transport.mjs SSE `browser-tool-request`, one response per request
  -> overlay/JS/eg-desk-surface.uc.js        browserToolDispatch: run/Card/epoch binding, Stop and
                                             cancel tombstones, one Card lease, display-only projection
  -> EGDeskBrowserAgentRuntimeChild.act      guard -> Parent authorizeAct -> guard again -> perform
                                             -> settle -> after snapshot + diff
```

### Tools

| Tool | UI request | Actor guard (checked before and after parent approval) | Dispatch route | Result `status` |
|---|---|---|---|---|
| `egdesk_browser_observe` | `observe` | none (read-only) | none | `observed` |
| `egdesk_browser_click` | `act` | document, revision, viewport, focused ref, URL, exact live target, not obscured | `dom-click-no-pointerdown` (DOM `click()`, no mousedown, no focus). The actor calls it from system code, so Gecko marks the click `isTrusted: true`, but there is no pointer sequence (pointerdown/mousedown/mouseup) and no coordinates (`docs/references/rea-mechanism-adoption.md` section 2) | `postcondition-observed` / `postcondition-unverified` |
| `egdesk_browser_fill` | `act` | as click (without the hit test), plus a non-sensitive field or contenteditable editing host, text up to 8000 characters, current value up to 8000 characters | `dom-value-setter` (value setter, then `input`/`change`) or `dom-editor-replace` (cancelable `beforeinput`; EG-Desk replaces the editor text and sends `input` only if the page did not cancel it). No focus, no Selection API call | same; the `target-value` postcondition is the full expected value (see BRW-08 below) |
| `egdesk_browser_navigate` | `act` | document guard, and the target URL on the **current document's site** (Gecko Public Suffix List; IP, single-label or unknown suffix = exact origin), http(s) only, no https-to-http downgrade | `location.href` | same, plus `navigationScope: "same-site"`, `pageLoadVerified: false` |
| `egdesk_browser_scroll` | `act` | document guard plus the observed scroll offset (a human scroll in between is stale). `direction` (up/down/top/bottom, `amount` page/half) scrolls the document; `ref` + `expectedTarget` brings that element into view | `dom-scroll-api` (`scrollBy`/`scrollTo`/`scrollIntoView`, no focus, no pointer) | `postcondition-observed` (scrollY moved in that direction / target in view), `scroll-at-limit`, `postcondition-unverified` |
| `egdesk_browser_press` | `act` | as fill's target checks (non-sensitive, bounded value), and the target is **already focused** or is **the field the last guarded action filled** | `dom-keyboard-event` (synthetic, `trustedInput: false`, no focus). Only Enter on a form text field emulates HTML implicit submission (`default-button-click` or `form-request-submit`); no other default key action happens | with postcondition: as click; without: `key-dispatched` |
| `egdesk_browser_wait` | `observe` with `options.wait` | read-only; `selector-visible` needs the ref's own document | none | `wait-condition-met`, `wait-timeout`, `wait-condition-unverified` |
| `egdesk_browser_screenshot` | `observe` with `options.screenshot` | read-only; the parent actor captures only on its own one-time ticket, covers what the child reports, and sends nothing when a cover box cannot be trusted (see Masked Screenshot) | none | `screenshot-observed`, `screenshot-withheld` (with `screenshot.reason`) |

Press keys: Enter, Escape, Tab, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Backspace, Space. Enter and Space require a testable postcondition (they can submit or activate); other keys may omit it.

Wait: `for` is `load` (readyState complete), `idle` (complete and no DOM mutation for 500 ms) or `selector-visible` (an observed ref becomes visible), with `timeoutMs` 100 to 10000. The helper refuses a wait that does not leave 2000 ms inside the UI response deadline. After an unconfirmed navigation the actor will not accept the old document as loaded (`notDocumentId`).

Navigation scope is anchored to the current document, not the originally selected URL. A guarded click on a cross-site link can therefore move the Card to another site, after which navigation is limited to that site.

### Shared Rules (REA section 6, EG-01 to EG-04)

- **One observation, one dispatch.** Every action spends the Card's single fresh observation; a repeated native call ID returns the same receipt and never re-sends. Nothing is retried automatically.
- **Unknown is not failure (EG-01).** A UI timeout is `BROWSER_UI_TIMEOUT` (outcome unknown). An effectful action (click, fill, navigate, press) with an unknown or unconfirmed outcome locks the Card for that run (`BROWSER_OUTCOME_UNKNOWN`) until an observation of a new document satisfies the original URL/visible-text postcondition. A scroll's unknown outcome only requires a fresh observation, because the next snapshot reports the whole viewport state. A wait never locks the Card; a lost or replaced-document wait is `BROWSER_WAIT_OUTCOME_UNKNOWN`.
- **Recheck right before input (EG-02).** The actor re-runs its guard after the asynchronous parent approval and immediately before perform. Navigation scope, scroll offset and press focus policy are part of that guard.
- **Display is not effect (EG-03).** The target marker is display-only (click/fill only) and never feeds input. A result is confirmed only by the actor-reported route plus a current-document readback; `externalEffectVerified` is always `false`.
- **Stop layers (EG-04).** After Stop or cancel the helper binding is closed before any deferred UI send (zero new dispatches), the surface tombstones the run, and the parent denies any pending lease. An input already dispatched is not rolled back; its result is reported as unknown.

### Frames, Shadow DOM, Editors and Long Values (BRW-08)

The actor is still registered for the top frame only (`allFrames: false` in `eg-desk-surface.uc.js`). It reads further documents from that one actor, in the same process, and never through a cross-origin boundary.

| Case | Observation | Action guard (both passes) |
|---|---|---|
| Open shadow root | Elements and text are included in document order at their host. Ref has no frame path (`el_12`). The shadow root joins the mutation watch | Hit test in the shadow root (`ShadowRoot.elementFromPoint`), then the host in its own tree |
| Closed shadow root | Not read | — |
| Same-origin frame (document principal equal to the top document's; sandboxed frames have their own) | Elements and text are included at the frame's position, bounds in top-viewport coordinates (frame border and padding added; frame CSS transforms not modeled). Ref carries the frame path, one key per frame element and document generation (`f2/el_9`, nested `f2/f5/el_9`). The frame document joins the mutation watch. Depth limit 4 | Every frame on the path must still hold the same document, be connected in its parent document and be same-origin; otherwise `Browser frame is stale` and the revision moves. Hit test in the frame document, then the frame element in its parent document at the translated point |
| Cross-origin, unreadable (no document, e.g. another process) or `data-sensitive`/`data-private` frame | Only `inaccessibleFrames: [{ label, reason, bounds }]` with `reason` `cross-origin`, `unreadable`, `private` or `depth-limit`; label from `title`/`aria-label`/`name`, never `src` | Never has refs; a forged frame path is `Browser frame is stale` |
| contenteditable editing host | Role `textbox`. Label from attributes only, `Editable text` if none. Value `[editor text hidden: N chars, #fingerprint]` or `[editor text hidden: empty]`; editor text never enters `text`. `data-sensitive`/`data-private`/secret hints keep it a sensitive field | Fill only on the editing host (not a nested editable), not `aria-readonly`, and only where `InputEvent` exists |
| Field value over 120 characters | `first 96 characters... [N chars, #fingerprint]`; over 8000 characters `[over 8000 chars]` | The fingerprint is part of the exact target, so a human edit past the first 120 characters is `Browser target changed`. Values over 8000 characters are refused |

Behavior change: contenteditable is no longer a sensitive field by itself, so guarded click, press (focused or just filled) and fill can reach an editor; for example Enter on a chat editor may send through the page's own key handler, which is why Enter still needs a postcondition. Editor text itself stays out of every observation.

Editor fill receipt (`result.dispatchDiagnostics`): `inputRoute`, `trustedInput: false`, `focusApi: "not-called"`, `selectionApi: "not-called"` (EG-Desk called neither; a page handler may still move focus itself), `eventOrder` (`["beforeinput", "input"]`, or `["beforeinput"]` when the page canceled it), `beforeInputCanceled`, `egdeskWroteContent`, `readbackMatches`. A field fill reports `["input", "change"]`; the value setter moves that field's own caret to the end, as any script assignment does. EG-Desk writes editor lines as text nodes separated by `<br>`, and reads editor text back the same way; an editor that rebuilds the text into paragraphs reads back as different, so the result stays `postcondition-unverified` rather than claiming success.

The fingerprint is a non-cryptographic 53-bit hash (cyrb53) used only to notice change. `helper/egdesk-browser-tool-runtime.mjs` `boundedFieldValue` reproduces the actor's observed form byte for byte, so a `target-value` postcondition holding the full expected text (up to 8000 characters) is compared in that form. Text plus postcondition must fit 40000 JSON characters, inside the 48000-character UI request bound; other tools keep the 512-character postcondition bound.

Scan bounds: 20000 elements per observation for discovering shadow roots and frames (interactive elements past that still count, in document order), shadow depth 16, 20 inaccessible frames listed.

### Masked Screenshot (BRW-09, D-B6, REA 웹6 decision 3)

A Card with an observe grant may give the model a picture of its visible viewport. Secret and sensitive fields, other-site and unread frames and embedded objects are painted over inside Firefox before the image leaves it; if any cover box cannot be trusted, no image is sent. Image pixels are never input coordinates: an action still needs a fresh `egdesk_browser_observe` and element refs.

```text
helper  egdesk_browser_screenshot
  -> observe request, options { textLimit: 1, elementLimit: 1, screenshot: { maxEdge, budgetChars, format, quality } }
  -> surface browserToolObserve (unchanged) -> actor.sendQuery("snapshot", { options })
  -> EGDeskBrowserAgentRuntimeParent.sendQuery   mints a one-time ticket into options.screenshot
  -> child snapshot(light) + sendQuery("captureScreenshot", { ticket, ... })
  -> parent: child screenshotMask (before) -> WindowGlobalParent.drawSnapshot(null, 1, "white")
             -> child screenshotMask (after) -> EGDeskScreenshotMask.screenshotDecision
             -> canvas: draw, paint covers, toDataURL within the budget
  -> child returns { ...snapshot, screenshot } -> helper result { status, screenshot }
  -> provider: inputText (JSON, imageUrl replaced) + inputImage (data URL)
```

| Covered | Child rule (`screenshotMask`) |
|---|---|
| Secret or sensitive field | `type=password`; the observation's sensitive control rule (secret, token, OTP, card hints, `data-sensitive`/`data-private`, sensitive editors); any `autocomplete` token `cc-*`, `one-time-code`, `current-password`, `new-password` |
| Frame the observation did not read | cross-origin, unreadable (no document), `data-sensitive`/`data-private`, past the frame depth limit, or not scanned (for example `aria-hidden`, which still paints) |
| `<object>` / `<embed>` | always |
| Not covered | plain fields and editors (their pixels show; their values stay out of the text observation as before), page text |

Fail-closed reasons (`screenshot.reason`): `scan-budget` (element budget ran out, so some shadow roots or frames went unread), `scan-failed`, `rect-unavailable` (a box could not be measured), `frame-transform` (a CSS-transformed same-origin frame on the path), `mask-moved` (the cover boxes differed before and after the capture), `document-changed`, `viewport-changed`, `image-size-mismatch` (the capture is neither the viewport nor a uniform rescale of it), `image-too-large` (no size down to a 480 px long edge fit the 150000-character budget), `capture-failed`, `capture-unsupported` (no `drawSnapshot`, e.g. headless), `unauthorized` (no ticket), `missing-embedder`, `not-top-document`, `mask-unavailable`.

Box geometry: child boxes are top-viewport CSS pixels (`viewportRect`, same-origin frame offsets added, frame transforms refused). Every box grows by 3 CSS pixels; a capture a scrollbar narrower than the viewport keeps the CSS grid and grows every box by the difference; a downscaled output grows every box outward again. The result's `maskedRegions` lists `{ kind, reason, bounds }` in CSS pixels and `imageScale` (image pixel = CSS pixel x imageScale). Capture scale is 1 (one capture pixel per CSS pixel); the output long edge is capped at 1280 and shrunk by 20% steps, then re-encoded at quality 0.5, until the JPEG data URL fits 150000 characters inside the 180000-character UI response bound.

Authority: a content process cannot start a capture. The parent actor mints the ticket only while forwarding the chrome side's own `snapshot` query that carries `options.screenshot`, spends it once, and captures only for the top document of a registered chrome Browser Card. The unmasked bitmap never leaves the parent process. Not changed: observe/act guards, the Card's fresh observation (a screenshot never becomes one), and the surface.

### Snapshot Fields

The actor snapshot now includes `scroll: { x, y, maxY }` (CSS pixels, integers) and `inaccessibleFrames` (see BRW-08). A wait response carries `wait: { for, outcome: "met" | "timeout", elapsedMs }`; the helper validates and removes it before storing the observation.

### Error Codes Added

| Code | Meaning |
|---|---|
| `BROWSER_NAVIGATE_OUT_OF_SCOPE` | Navigation target is not http(s) on the current document's site, or is a downgrade |
| `BROWSER_PRESS_TARGET_NOT_FOCUSED` | Key target is neither the observed focused element nor the field just filled |
| `BROWSER_WAIT_OUTCOME_UNKNOWN` | Wait ended without a verifiable observation |

Until `helper/codex-tool-errors.mjs` lists them, the public classification of these three is `BROWSER_TOOL_FAILED`.

### Wiring Status (2026-10-24)

| Piece | Status |
|---|---|
| B service (`egdesk-browser-tool-runtime.mjs`): specs, validation, scope, focus policy, wait, postconditions | Implemented, unit-tested |
| Provider (`codex-browser-tool-provider.mjs`): browserBounded interact grant for navigate/scroll/press/wait; fixture QA scope unchanged | Implemented, unit-tested |
| Actor child: guarded scroll/press, same-site navigation guard, read-only wait, `scroll` snapshot field | Implemented, unit-tested with a fake DOM |
| Actor parent: `browserToolDispatchReceiptFields` receipt filter | Implemented, unit-tested (scroll, press, and fill event order) |
| Actor child: same-origin frame and open shadow root refs, frame generation guard, editor fill, long values (BRW-08) | Implemented, unit-tested with a fake DOM |
| Helper: 8000-character fill, bounded `target-value` comparison, frame refs unchanged (BRW-08) | Implemented, unit-tested |
| Surface `browserToolAct` receipt route for fill (`['scroll', 'press']` -> add `'fill'`) | Pending Main; until then the fill event order stays in the actor result and the helper decides from the readback alone |
| Wait through the existing surface observe path | Works without surface changes (unit-tested on the extracted surface dispatch) |
| Surface `browserToolDispatchOnce` action allow-list for `scroll`/`press` | Pending Main; until then the UI rejects them |
| Surface `browserToolAct` receipt route for scroll/press | Pending Main; until then scroll/press results are `postcondition-unverified` |
| `codex-chat-runtime.mjs` catalog and per-call allow-list | Pending Main; until then the model is not offered navigate/scroll/press/wait |
| Public error codes in `codex-tool-errors.mjs` | Pending Main |
| Actor child: `screenshotMask` cover pass, `options.screenshot` on the snapshot query (BRW-09) | Implemented, unit-tested with a fake DOM |
| Actor parent: ticketed `captureScreenshot`, `drawSnapshot` + canvas cover + budgeted encode (BRW-09) | Implemented, unit-tested with a fake WindowGlobalParent and canvas; the real `drawSnapshot` call is not run |
| `EGDeskScreenshotMask.sys.mjs` cover and send policy (BRW-09) | Implemented, unit-tested |
| Helper: `egdesk_browser_screenshot` spec (appended, read tool), dispatch, `validScreenshot`; provider `inputImage` item (BRW-09) | Implemented, unit-tested. The chat runtime catalog already follows `BROWSER_READ_TOOL_NAMES`, so the tool is offered with readOnlyQa and browserBounded |
| Real Firefox run (trusted page behavior, Gecko PSL, implicit submission on real forms; BRW-08: same-process `contentDocument` under Fission, principal equality, `ShadowRoot.elementFromPoint`, real rich editors such as Gmail or Notion; BRW-09: `drawSnapshot` viewport size versus `innerWidth`/`innerHeight`, the `sendQuery` override on a JSWindowActorParent subclass, JPEG size of real pages, Codex `inputImage` round trip) | Not verified |

Unit tests: `helper/egdesk-browser-tool-runtime.test.mjs`, `helper/codex-browser-tool-provider.test.mjs`, `scripts/egdesk-browser-agent-guard.test.mjs`, `scripts/egdesk-browser-tool-transport.test.mjs`, `scripts/egdesk-screenshot-mask.test.mjs` (tests there skip with a visible reason until the matching surface wiring lands; today only the fill receipt test skips).

---

## Legacy Internal Path: `browserAgent.act`

### Product Rule

When an internal agent controls a Browser Card through the legacy API, EG-Desk summarizes what changed after the action instead of forcing a full rediscovery of the page.

```text
Agent action
  -> before snapshot
  -> perform click/fill/type/press/scroll/navigate
  -> settle
  -> after snapshot
  -> diff
  -> notification summary
```

This path has no run binding, observation freshness or focus policy, so it is not exposed to model runs.

### Runtime Contract

`window.__egdesk.browserAgent.act(cardId, action, options)` returns:

```ts
type BrowserAgentActResult = {
  ok: boolean;
  action: BrowserAgentAction;
  result: unknown;
  before: BrowserAgentSnapshot;
  after: BrowserAgentSnapshot;
  observation: BrowserAgentObservationDiff;
  notification: BrowserAgentDomChangeNotification;
  actionEntry: BrowserAgentActionEntry;
  actionHistoryLength: number;
};
```

The same notification is also stored in:

```text
actionEntry.notification
browserAgent.history(cardId)
browserAgent.notifications(cardId)
egdesk:browser-agent-action event detail
```

### Notification Shape

```ts
type BrowserAgentDomChangeNotification = {
  type: "browser-dom-change";
  cardId: string;
  actionType: string;
  source: "chrome-document" | "frame-script" | "jsactor" | "fallback" | string;
  ok: boolean;
  changed: boolean;
  summary: string;
  url: string;
  title: string;
  changes: {
    urlChanged: boolean;
    titleChanged: boolean;
    visibleTextChanged: boolean;
    interactiveChanged: boolean;
    focusedElementChanged: boolean;
    newVisibleText: string[];
    removedVisibleText: string[];
    newInteractiveElements: BrowserAgentElement[];
    removedInteractiveElements: BrowserAgentElement[];
    focusedElement: BrowserAgentElement | null;
  };
};
```

### Summary Behavior

The summary is compact and agent-readable, for example:

```text
title changed to "Agent Observation Updated"; new visible text: "Details ready for the agent"; new controls: button "Continue"; focus: textbox "Search note"
```

If no meaningful page change is detected:

```text
No meaningful DOM, text, control, or focus change detected.
```

### Verification

```bash
node apps/firefox-ui-demo/scripts/verify-firefox-mcp-browser-agent-observation.mjs /tmp/egdesk-browser-agent-observation.png
```

It verifies the initial snapshot and element refs, click and Hangul fill diffs, notification summaries, action and notification history order and limits, and `egdesk:browser-agent-action` event payloads. It does not exercise the guarded tool path.
