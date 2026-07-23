# Human-in-the-Loop Workflow Await Model

**Date**: 2026-05-20
**Status**: Product/runtime model
**Scope**: EG-Desk agent workflow pause/resume, OAuth/login waits, terminal-browser handoff, cross-app sync

---

## Core Problem

Some AI workflows cannot continue until the user completes an action outside the current agent response.

Common examples:

```text
Terminal command opens OAuth URL
  -> user logs in through browser
  -> CLI waits for redirect/token
  -> agent session times out or stops
  -> user has to type "계속" manually
```

This is not just an OAuth issue. It is a cross-app sync issue:

```text
agent / terminal / browser / OS app / file system / user action
```

EG-Desk should treat these as first-class workflow waits, not as chat failures.

## Product Rule

When an agent needs user action, it should pause the workflow with an explicit await state.

The user should see what is waiting, complete the action in the right card/app, and EG-Desk should resume the workflow automatically when the awaited condition is satisfied. Manual "Continue" remains as a fallback, not the default path.

```text
Agent starts task
  -> detects user action needed
  -> creates Await Token
  -> UI shows waiting state
  -> EG-Desk observes browser/terminal/auth/file events
  -> awaited condition becomes satisfied
  -> EG-Desk resumes the agent with an observation summary
```

## Await Token

The runtime primitive is an `AwaitToken`.

```ts
type AwaitToken = {
  id: string;
  agendaId?: string;
  threadId?: string;
  runId?: string;
  createdByAgentId?: string;
  createdAt: string;
  updatedAt: string;
  status: "waiting" | "satisfied" | "expired" | "cancelled" | "failed";
  reason: string;
  userInstruction: string;
  target: AwaitTarget;
  condition: AwaitCondition;
  resume: AwaitResumePolicy;
  evidence: AwaitEvidence[];
};
```

`reason` is for the agent/runtime. `userInstruction` is the short visible copy.

Example:

```json
{
  "reason": "GitHub CLI OAuth login is required before the command can continue.",
  "userInstruction": "GitHub login을 완료하면 작업을 이어갑니다."
}
```

## Await Targets

```ts
type AwaitTarget =
  | { kind: "browser"; cardId?: string; sourceRef?: string }
  | { kind: "terminal"; cardId?: string; sessionId?: string }
  | { kind: "auth"; provider: string; accountId?: string }
  | { kind: "file"; path: string }
  | { kind: "external-app"; appName?: string; bundleId?: string }
  | { kind: "manual"; label: string };
```

The target is where EG-Desk should watch for completion.

For browser and terminal waits, `cardId` is only the current visible surface. The durable wait target should be the runtime identity when available:

```text
terminal await target
  prefer sessionId
  cardId is optional foreground view

browser await target
  prefer runtimeId/sourceRef
  cardId is optional foreground view
```

If the visible card is closed while an await token is active, EG-Desk should detach the view rather than kill the runtime. The runtime moves to `background-live` and keeps emitting observation events until the await token is satisfied, cancelled, expired, or explicitly killed.

```text
user closes awaited Terminal Card
  -> remove visible card
  -> keep terminal session alive
  -> continue watching terminal output / exit

user closes awaited Browser Card
  -> remove visible card
  -> keep BrowserRuntime in hidden host when feasible
  -> continue watching URL / DOM / auth state
```

When the user opens the waiting item again, EG-Desk should create a new foreground card attached to the existing runtime. This is attach/reattach, not a new terminal session or new browser tab.

## Await Conditions

```ts
type AwaitCondition =
  | { kind: "auth-status"; provider: string; state: "logged-in" }
  | { kind: "browser-url"; pattern: string }
  | { kind: "browser-dom"; selector?: string; textIncludes?: string }
  | { kind: "terminal-output"; includes?: string; regex?: string }
  | { kind: "terminal-exit"; code?: number }
  | { kind: "file-exists"; path: string }
  | { kind: "manual-confirm" };
```

OAuth examples:

```text
Browser URL matches localhost callback
Browser DOM says "Authentication complete"
Terminal output contains "Authentication complete"
Auth provider state becomes logged-in
```

## Resume Policy

```ts
type AwaitResumePolicy = {
  mode: "auto" | "ask-user" | "manual-only";
  resumeThreadId?: string;
  resumeMessageTemplate: string;
  timeoutMs?: number;
  onTimeout: "keep-waiting" | "ask-user" | "fail";
};
```

Default behavior:

```text
mode: auto
onTimeout: ask-user
```

The workflow should not keep an LLM stream open while waiting for the user. It should checkpoint the run, release the model call, and resume by sending a compact observation summary into the same thread/run context when the condition is satisfied.

## Resume Message

When the await completes, EG-Desk resumes the agent with structured context.

```xml
<egdesk-await-resume>
  <await_id>await_123</await_id>
  <status>satisfied</status>
  <target>terminal:session_456</target>
  <summary>User completed GitHub OAuth. Terminal now shows authentication complete.</summary>
  <evidence>
    <terminal_output>Authentication complete. You may close this browser.</terminal_output>
    <browser_url>http://127.0.0.1:...</browser_url>
  </evidence>
</egdesk-await-resume>
```

The agent should continue from the previous task, not ask the user to restate the task.

## UI Behavior

Chat bubble:

```text
로그인이 필요합니다.
[GitHub 로그인 열기] [대기 상태 보기] [수동으로 계속]
```

Canvas:

```text
Await Card
  status: Waiting for user
  target: Browser Card / Terminal Card
  condition: Auth complete
  evidence: recent terminal/browser events
```

When satisfied:

```text
Login complete. Continuing...
```

Then the agent resumes automatically.

## Cross-App Watchers

EG-Desk should collect watcher events from:

- Browser Agent observation notifications
- Codex/auth bridge lifecycle events
- Terminal session output and process exit
- file watcher events
- OS/app foreground or URL-open events where available
- manual user confirmation

Watchers should produce normalized events:

```ts
type WorkflowEvent = {
  id: string;
  at: string;
  source: "browser" | "terminal" | "auth" | "file" | "os" | "manual";
  targetId?: string;
  summary: string;
  payload: Record<string, unknown>;
};
```

Await conditions match against these events.

## Initial Implementation Path

1. Add in-memory Await Token registry in the Firefox shell runtime.
2. Surface a small waiting chip/card in chat/canvas.
3. Wire watchers for existing auth lifecycle, browser-agent notifications, and terminal output.
4. Add manual continue/cancel buttons.
5. Auto-resume by posting a structured resume message to the existing Codex thread.
6. Persist pending Await Tokens in the Agenda snapshot.

## Non-Goals

- Do not hold a streaming LLM call open during long user waits.
- Do not require every OAuth flow to be implemented as a special case.
- Do not rely on the user typing "계속" as the normal success path.
- Do not hide the reason for waiting behind helper diagnostics.

## Verification Target

The first repeatable test should simulate:

```text
Terminal card prints "Open http://127.0.0.1:PORT/login"
Browser card opens login fixture
User/test clicks "Authorize"
Terminal output changes to "Authentication complete"
Await Token becomes satisfied
Chat thread receives auto-resume payload
```
