# Browser Agent Observation Runtime

**Date**: 2026-05-20, updated 2026-10-24 (guarded tool path, BRW-05/BRW-06)
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
| `egdesk_browser_click` | `act` | document, revision, viewport, focused ref, URL, exact live target, not obscured | `dom-click-no-pointerdown` (DOM `click()`, no mousedown, no focus) | `postcondition-observed` / `postcondition-unverified` |
| `egdesk_browser_fill` | `act` | as click, plus editable non-sensitive field | DOM value + `input`/`change`, no focus | same |
| `egdesk_browser_navigate` | `act` | document guard, and the target URL on the **current document's site** (Gecko Public Suffix List; IP, single-label or unknown suffix = exact origin), http(s) only, no https-to-http downgrade | `location.href` | same, plus `navigationScope: "same-site"`, `pageLoadVerified: false` |
| `egdesk_browser_scroll` | `act` | document guard plus the observed scroll offset (a human scroll in between is stale). `direction` (up/down/top/bottom, `amount` page/half) scrolls the document; `ref` + `expectedTarget` brings that element into view | `dom-scroll-api` (`scrollBy`/`scrollTo`/`scrollIntoView`, no focus, no pointer) | `postcondition-observed` (scrollY moved in that direction / target in view), `scroll-at-limit`, `postcondition-unverified` |
| `egdesk_browser_press` | `act` | as fill's target checks (non-sensitive, bounded value), and the target is **already focused** or is **the field the last guarded action filled** | `dom-keyboard-event` (synthetic, `trustedInput: false`, no focus). Only Enter on a form text field emulates HTML implicit submission (`default-button-click` or `form-request-submit`); no other default key action happens | with postcondition: as click; without: `key-dispatched` |
| `egdesk_browser_wait` | `observe` with `options.wait` | read-only; `selector-visible` needs the ref's own document | none | `wait-condition-met`, `wait-timeout`, `wait-condition-unverified` |

Press keys: Enter, Escape, Tab, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Backspace, Space. Enter and Space require a testable postcondition (they can submit or activate); other keys may omit it.

Wait: `for` is `load` (readyState complete), `idle` (complete and no DOM mutation for 500 ms) or `selector-visible` (an observed ref becomes visible), with `timeoutMs` 100 to 10000. The helper refuses a wait that does not leave 2000 ms inside the UI response deadline. After an unconfirmed navigation the actor will not accept the old document as loaded (`notDocumentId`).

Navigation scope is anchored to the current document, not the originally selected URL. A guarded click on a cross-site link can therefore move the Card to another site, after which navigation is limited to that site.

### Shared Rules (REA section 6, EG-01 to EG-04)

- **One observation, one dispatch.** Every action spends the Card's single fresh observation; a repeated native call ID returns the same receipt and never re-sends. Nothing is retried automatically.
- **Unknown is not failure (EG-01).** A UI timeout is `BROWSER_UI_TIMEOUT` (outcome unknown). An effectful action (click, fill, navigate, press) with an unknown or unconfirmed outcome locks the Card for that run (`BROWSER_OUTCOME_UNKNOWN`) until an observation of a new document satisfies the original URL/visible-text postcondition. A scroll's unknown outcome only requires a fresh observation, because the next snapshot reports the whole viewport state. A wait never locks the Card; a lost or replaced-document wait is `BROWSER_WAIT_OUTCOME_UNKNOWN`.
- **Recheck right before input (EG-02).** The actor re-runs its guard after the asynchronous parent approval and immediately before perform. Navigation scope, scroll offset and press focus policy are part of that guard.
- **Display is not effect (EG-03).** The target marker is display-only (click/fill only) and never feeds input. A result is confirmed only by the actor-reported route plus a current-document readback; `externalEffectVerified` is always `false`.
- **Stop layers (EG-04).** After Stop or cancel the helper binding is closed before any deferred UI send (zero new dispatches), the surface tombstones the run, and the parent denies any pending lease. An input already dispatched is not rolled back; its result is reported as unknown.

### Snapshot Fields

The actor snapshot now includes `scroll: { x, y, maxY }` (CSS pixels, integers). A wait response carries `wait: { for, outcome: "met" | "timeout", elapsedMs }`; the helper validates and removes it before storing the observation.

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
| Actor parent: `browserToolDispatchReceiptFields` receipt filter | Implemented, unit-tested |
| Wait through the existing surface observe path | Works without surface changes (unit-tested on the extracted surface dispatch) |
| Surface `browserToolDispatchOnce` action allow-list for `scroll`/`press` | Pending Main; until then the UI rejects them |
| Surface `browserToolAct` receipt route for scroll/press | Pending Main; until then scroll/press results are `postcondition-unverified` |
| `codex-chat-runtime.mjs` catalog and per-call allow-list | Pending Main; until then the model is not offered navigate/scroll/press/wait |
| Public error codes in `codex-tool-errors.mjs` | Pending Main |
| Real Firefox run (trusted page behavior, Gecko PSL, implicit submission on real forms) | Not verified |

Unit tests: `helper/egdesk-browser-tool-runtime.test.mjs`, `helper/codex-browser-tool-provider.test.mjs`, `scripts/egdesk-browser-agent-guard.test.mjs`, `scripts/egdesk-browser-tool-transport.test.mjs` (two tests there skip with a visible reason until the surface wiring lands).

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
