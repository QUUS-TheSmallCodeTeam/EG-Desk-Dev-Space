/**
 * Canvas Entity Foundation v1 — Type definitions (ADR-006 §5.2, §5.10)
 *
 * Core types for entity-agnostic canvas infrastructure.
 * - CanvasEntity: discriminated union keyed by EntityType
 * - EntityAdapter: thin per-type adapter (hydrate/suspend/render/captureSnapshot)
 */

// ─── Entity type union ──────────────────────────────────────────────
export type EntityType = 'browser' | 'ide' | 'chat' | 'file-preview' | 'note' | 'gadget'

// Memory-state lifecycle (ADR-006 §5.3)
export type EntityLifecycle = 'hydrated' | 'suspended' | 'static' | 'discarded'

// Visual-size state (§7-4 L351-356)
export type EntityDisplayState = 'covered' | 'spread' | 'full'

// ─── Type-specific props per entity type ────────────────────────────
export interface EntityTypePropsMap {
  browser: { url: string; webContentsViewId?: string; title?: string; favicon?: string }
  ide: { sessionId: string; openFiles: string[]; language?: string }
  chat: { conversationId: string; agentConfig?: object }
  'file-preview': { filePath: string; mime: string; pageIndex?: number }
  note: { text: string }
  gadget: { gadgetId: string; config: object }
}

// ─── Canvas Entity (discriminated union) ────────────────────────────
export interface CanvasEntity<T extends EntityType = EntityType> {
  id: string
  type: T
  position: { x: number; y: number } // canvas-space
  size: { w: number; h: number }
  zIndex: number
  lifecycle: EntityLifecycle
  displayState: EntityDisplayState
  snapshot?: string // data URL (required when lifecycle === 'static')
  createdAt: number
  lastActiveAt: number
  typeProps: EntityTypePropsMap[T]
}

// ─── Viewport transform state (d3-zoom synced) ──────────────────────
export interface ViewportTransform {
  x: number // translate (px)
  y: number
  k: number // scale
}

// ─── Per-entity viewport tracking (§5.4) ────────────────────────────
export interface ViewportTrackingState {
  entityId: string
  isOut: boolean
  outStartedAt: number | null
  lastInAt: number
}

// ─── Entity Adapter (§5.10) ─────────────────────────────────────────
// HydratedInstance is opaque to supervisor (type-specific internal DOM refs).
// NoteAdapter e.g. uses { ref: HTMLDivElement | null }.
export interface EntityAdapter<T extends EntityType> {
  type: T
  /** Called on create or static→hydrated. Returns type-specific live instance. */
  hydrate: (entity: CanvasEntity<T>) => Promise<HydratedInstance<T>> | HydratedInstance<T>
  /** Called before hydrated→suspended. Must return screenshot data URL. */
  suspend: (instance: HydratedInstance<T>) => Promise<string>
  /** Render JSX. When static (no instance) should render snapshot fallback. */
  render: (entity: CanvasEntity<T>, instance?: HydratedInstance<T>) => JSX.Element
  /** Capture screenshot without tearing down (e.g. ADR-005 preset pack). */
  captureSnapshot: (instance: HydratedInstance<T>) => Promise<string>
}

// Opaque per-type hydrated instance (stored in EntityLayer supervisor).
// Kept as `unknown` to preserve isolation — adapters cast internally.
export type HydratedInstance<_T extends EntityType = EntityType> = unknown

// ─── Adapter registry ───────────────────────────────────────────────
// Partial because v1 only ships NoteAdapter. Registry extended as ADR-007+ land.
export type EntityAdapterRegistry = {
  [K in EntityType]?: EntityAdapter<K>
}
