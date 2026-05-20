# Browser Agent Observation Runtime

**Date**: 2026-05-20
**Status**: Implemented runtime contract
**Scope**: Firefox browser cards, browser agent actions, DOM-change notification summaries

---

## Product Rule

When an AI agent controls a Browser Card, EG-Desk should summarize what changed after the action.

The agent should not have to click a button and then rediscover the page from scratch. The browser runtime already sees before/after page state, so it should provide a compact observation back to the agent.

```text
Agent action
  -> before snapshot
  -> perform click/fill/type/press/scroll/navigate
  -> settle
  -> after snapshot
  -> diff
  -> notification summary
```

## Runtime Contract

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

## Notification Shape

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

## Summary Behavior

The summary is intentionally compact and agent-readable.

Examples:

```text
title changed to "Agent Observation Updated"; new visible text: "Details ready for the agent"; new controls: button "Continue"; focus: textbox "Search note"
```

```text
new controls: textbox "Search note" value "한글 입력"; removed controls: textbox "Search note"; focus: textbox "Search note" value "한글 입력"
```

If no meaningful page change is detected:

```text
No meaningful DOM, text, control, or focus change detected.
```

## Why This Matters

This is the Firefox-shell equivalent of the browser-agent pattern the user wanted:

```text
AI acts on visible browser state
EG-Desk observes the browser outcome
EG-Desk summarizes the outcome back to the agent
```

It keeps repeated browser control loops cheaper and more reliable than forcing the model to re-scan the whole page after every action.

## Verification

The repeatable verification script is:

```bash
node apps/firefox-ui-demo/scripts/verify-firefox-mcp-browser-agent-observation.mjs /tmp/egdesk-browser-agent-observation.png
```

It verifies:

- initial snapshot and element refs
- click action and DOM/title/control diff
- notification summary after click
- Hangul fill action
- notification summary after input value change
- action history order
- notification history and limit behavior
- `egdesk:browser-agent-action` event payloads
