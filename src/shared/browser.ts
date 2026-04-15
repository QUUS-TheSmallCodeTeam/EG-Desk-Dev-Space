/**
 * Shared browser entity types for the OSR browser POC.
 *
 * Contract between main process (IPC handlers/preload) and renderer
 * (BrowserAdapter). The renderer prefers Electron shared textures and falls
 * back to bitmap frames when the experimental path is unavailable.
 */

export interface BrowserEntityTypeProps {
  /** Initial / current URL */
  url: string
  /** Assigned by main after browser:create. Undefined before creation. */
  browserId?: number
}

export interface BrowserCreateRequest {
  url: string
  width: number
  height: number
}

export type BrowserPresentationMode = 'canvas' | 'window'

export interface BrowserBitmapFrameEvent {
  browserId: number
  kind: 'bitmap'
  /**
   * PNG buffer transmitted as Uint8Array.
   * Renderer converts it to ImageBitmap for the fallback path.
   */
  buffer: Uint8Array
  width: number
  height: number
  frameCount?: number
  timestamp?: number
}

export interface BrowserSharedTextureFrameEvent {
  browserId: number
  kind: 'shared-texture'
  width: number
  height: number
  frameCount?: number
  timestamp?: number
  pixelFormat?: string
  /**
   * Delivered as a VideoFrame in the renderer. Kept as unknown here because the
   * node-side tsconfig does not include DOM typings.
   */
  frame: unknown
}

export type BrowserFrameEvent = BrowserBitmapFrameEvent | BrowserSharedTextureFrameEvent

export interface BrowserStateEvent {
  browserId: number
  url: string
  title: string | null
  mode: BrowserPresentationMode
}

export interface BrowserApi {
  /**
   * Create an off-screen BrowserWindow for the given URL.
   * Returns a stable logical browser id that survives promote/demote.
   */
  create: (request: BrowserCreateRequest) => Promise<number>
  /** Destroy the browser runtime. */
  destroy: (browserId: number) => Promise<void>
  /** Navigate the active presentation target to a new URL. */
  navigate: (browserId: number, url: string) => Promise<void>
  /** Update the backing canvas resolution for this browser. */
  resize: (browserId: number, width: number, height: number) => Promise<void>
  /** Show or hide the active BrowserWindow while preserving the canvas runtime. */
  setPresentationMode: (browserId: number, mode: BrowserPresentationMode) => Promise<void>
  /** Capture a fresh PNG snapshot from the active browser surface. */
  captureSnapshot: (browserId: number) => Promise<string>
  /**
   * Subscribe to rendered frames. Shared texture frames are delivered through
   * preload while bitmap frames arrive through IPC fallback.
   */
  onFrame: (listener: (event: BrowserFrameEvent) => void) => () => void
  /** Subscribe to URL/title/mode changes from the main process. */
  onState: (listener: (event: BrowserStateEvent) => void) => () => void
}
