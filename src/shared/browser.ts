/**
 * Shared browser entity types — OSR-based embedded browser (POC)
 *
 * Contract between main process (IPC handlers) and renderer (BrowserAdapter).
 * Phase 1: display-only (no interaction). useSharedTexture deferred to next iteration.
 */

// ── Entity type props ────────────────────────────────────────────────
export interface BrowserEntityTypeProps {
  /** Initial / current URL */
  url: string
  /** Assigned by main after browser:create. Undefined before creation. */
  browserId?: number
}

// ── IPC frame event ──────────────────────────────────────────────────
export interface BrowserFrameEvent {
  browserId: number
  // PNG buffer transmitted as Uint8Array (IPC serializes Buffer → Uint8Array).
  // renderer converts to Blob URL to avoid large dataURL in img.src.
  buffer: Uint8Array
  width: number
  height: number
}

// ── Preload API contract ─────────────────────────────────────────────
export interface BrowserApi {
  /**
   * Create an off-screen BrowserWindow for the given URL.
   * Returns the webContents id (browserId).
   */
  create: (url: string) => Promise<number>
  /** Destroy the off-screen window. */
  destroy: (browserId: number) => Promise<void>
  /** Navigate to a new URL (future use). */
  navigate: (browserId: number, url: string) => Promise<void>
  /**
   * Subscribe to paint frames from main.
   * Returns an unsubscribe function.
   */
  onFrame: (listener: (event: BrowserFrameEvent) => void) => () => void
}
