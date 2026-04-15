/**
 * useViewportIntersection — center-based viewport out detection + dwell timer
 * (ADR-006 §5.4, SPEC §9-3-4)
 *
 * Supervisor-level hook (runs once in EntityLayer).
 * For each hydrated entity, computes screen-coord of center, flags isOut, and
 * fires `onSuspendTrigger(id)` when dwell time (default 3s) is exceeded.
 *
 * Hysteresis: if an entity re-enters viewport before dwell elapses, timer resets.
 * Static entities are ignored (re-entry does NOT auto-hydrate — click only).
 */
import { useEffect, useRef } from 'react'
import type { CanvasEntity, ViewportTrackingState, ViewportTransform } from '../types'

export interface UseViewportIntersectionOptions {
  entities: CanvasEntity[]
  viewport: ViewportTransform
  viewportSize: { w: number; h: number }
  dwellMs?: number
  onSuspendTrigger: (id: string) => void
}

export function useViewportIntersection({
  entities,
  viewport,
  viewportSize,
  dwellMs = 3000,
  onSuspendTrigger
}: UseViewportIntersectionOptions): void {
  // Per-entity tracking state (kept in ref so re-renders don't reset timers).
  const trackingRef = useRef<Map<string, ViewportTrackingState>>(new Map())
  // Timers keyed by entity id.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    const tracking = trackingRef.current
    const timers = timersRef.current
    const now = Date.now()

    // Remove tracking for entities that no longer exist (discarded etc.)
    const aliveIds = new Set(entities.map((e) => e.id))
    for (const id of Array.from(tracking.keys())) {
      if (!aliveIds.has(id)) {
        tracking.delete(id)
        const t = timers.get(id)
        if (t) clearTimeout(t)
        timers.delete(id)
      }
    }

    for (const entity of entities) {
      // Only hydrated entities participate in out-detection.
      // suspended: already in transition — skip. static/discarded: ignore.
      if (entity.lifecycle !== 'hydrated') {
        // Clear any stale timer if lifecycle changed away from hydrated.
        const t = timers.get(entity.id)
        if (t) {
          clearTimeout(t)
          timers.delete(entity.id)
        }
        tracking.delete(entity.id)
        continue
      }

      // ADR-006 §5.4 steps 1-3: compute center in canvas space, project to screen.
      const centerX = entity.position.x + entity.size.w / 2
      const centerY = entity.position.y + entity.size.h / 2
      const screenX = centerX * viewport.k + viewport.x
      const screenY = centerY * viewport.k + viewport.y
      const isOut =
        screenX < 0 ||
        screenX > viewportSize.w ||
        screenY < 0 ||
        screenY > viewportSize.h

      const prev = tracking.get(entity.id)
      if (isOut) {
        if (!prev || !prev.isOut) {
          // New out — start dwell timer (step 4)
          tracking.set(entity.id, {
            entityId: entity.id,
            isOut: true,
            outStartedAt: now,
            lastInAt: prev?.lastInAt ?? now
          })
          const timer = setTimeout(() => {
            onSuspendTrigger(entity.id)
            timers.delete(entity.id)
          }, dwellMs)
          timers.set(entity.id, timer)
        }
        // Already out — timer in flight, do nothing.
      } else {
        // In viewport
        if (prev?.isOut) {
          // Step 5: hysteresis — cancel pending suspend
          const t = timers.get(entity.id)
          if (t) {
            clearTimeout(t)
            timers.delete(entity.id)
          }
        }
        tracking.set(entity.id, {
          entityId: entity.id,
          isOut: false,
          outStartedAt: null,
          lastInAt: now
        })
      }
    }
  }, [entities, viewport, viewportSize.w, viewportSize.h, dwellMs, onSuspendTrigger])

  // Cleanup all timers on unmount
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }, [])
}
