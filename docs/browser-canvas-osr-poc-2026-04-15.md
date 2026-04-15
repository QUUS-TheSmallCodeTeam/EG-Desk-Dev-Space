# Browser Canvas OSR POC

Last updated: 2026-04-15

## Goal

Document the current Electron browser-on-canvas POC and the architectural conclusions reached while testing OSR, shared texture delivery, and native window handoff.

## Current Implementation

- Renderer shell runs inside Electron 41.2.0.
- Browser cards default to a read-only canvas surface.
- Each browser card owns a stable logical `browserId`.
- Main process maintains one `BrowserRuntime` per `browserId`.
- Canvas mode uses an offscreen `BrowserWindow` with `offscreen.useSharedTexture = true` when Electron shared textures are available.
- Fallback mode uses `NativeImage.toPNG()` over IPC and redraws in the renderer with `createImageBitmap()`.
- Window mode shows a native `BrowserWindow` for the same logical browser runtime.
- Canvas and window presentations share the same persistent Chromium profile via `persist:egdesk-browser`.

## Why The Windows Blank Screen Happened

The renderer was loaded with `BrowserWindow.loadFile(...)`, but Vite emitted absolute `/assets/...` paths. On Windows `file://` loads, that caused the renderer bundle to fail to load and left only the oak background visible.

Fix:

- `vite.config.ts` now sets `base: './'`
- `src/renderer/index.html` now uses relative asset and entry paths

## Frame Pipeline

### Preferred path

1. Chromium renders into an offscreen surface.
2. Main process receives `paint` events with `event.texture`.
3. Main imports the shared texture and forwards it to the renderer.
4. Preload converts the imported texture into a `VideoFrame`.
5. Renderer draws that `VideoFrame` into the card canvas.

### Fallback path

1. Chromium renders offscreen.
2. Main receives a `NativeImage`.
3. Main serializes the frame as PNG.
4. Renderer rebuilds an `ImageBitmap`.
5. Renderer draws into the card canvas.

## Confirmed Findings

- A browser visible inside the canvas does not imply `WebContentsView`. The current POC uses offscreen `BrowserWindow` plus shared texture delivery.
- A canvas-visible live browser still requires Chromium to render. The extra cost comes from frame transfer and canvas composition, not from replacing browser rendering.
- `OSR + shared texture` is the most realistic live-canvas path available in stock Electron.
- `PNG/ImageBitmap` fallback works, but it is more CPU-heavy because it adds readback, encode, transfer, decode, and redraw overhead.
- Stock Electron does not provide a clean way to show the exact same live tab simultaneously as:
  - an offscreen canvas surface
  - and a normal interactive `BrowserWindow`
- The current `Show active browser` flow is therefore a presentation handoff, not a simultaneous live mirror.

## Current UX

- Default state: browser card renders read-only inside the canvas.
- Button state:
  - `Show active browser` opens the active native browser window.
  - `Hide active browser` returns to canvas mode.
- The button is presentation-oriented. It does not provide a second live mirror surface.

## What Survives When Toggling Canvas/Window

### Preserved

- Persistent Chromium session, cookies, and login state via `persist:egdesk-browser`
- URL
- Scroll position

### Not preserved as exact live continuity

- In-flight DOM state
- Form input values
- `sessionStorage`
- JS heap/runtime continuity
- Popup/focus/IME state

The current implementation captures and restores `url + scrollX + scrollY`. It is a best-effort promote/demote flow, not a true single-surface live move.

## Renderer Diagnostics Added

- Renderer `console.log`, `console.warn`, `console.error` are forwarded to main.
- `window.error` and `window.unhandledrejection` are forwarded to main.
- A root error boundary renders a visible crash panel instead of a blank window.

## Relationship To ABP / BrowserOS

- ABP or BrowserOS can improve browser automation and control.
- They do not automatically solve Electron host-side canvas composition problems.
- Even with a stronger automation runtime, popup, IME, focus, file chooser, and native browser UI inside a canvas remain host-compositor problems.

## What This POC Proves

- Electron can render a browser card onto the spatial canvas using a GPU-centric shared texture path.
- Electron can hand that logical browser runtime off to a normal `BrowserWindow`.
- Windows `file://` packaging issues were addressed.

## What This POC Does Not Prove

- Exact live continuity between canvas and native window
- Full human-interactive browser UX inside the canvas
- Popup or IME fidelity inside the canvas
- ABP or BrowserOS integration

## Files To Inspect

- `src/main/index.ts`
- `src/preload/index.cts`
- `src/shared/browser.ts`
- `src/renderer/src/canvas/adapters/BrowserAdapter.ts`
- `src/renderer/src/canvas/Canvas.tsx`
- `src/renderer/src/main.tsx`
- `src/renderer/src/components/RootErrorBoundary.tsx`
- `vite.config.ts`
