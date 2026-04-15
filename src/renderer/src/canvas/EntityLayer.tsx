/**
 * EntityLayer — lifecycle supervisor (ADR-006 §5.3, §5.4, Option 3A)
 *
 * Central owner of:
 *  - viewport intersection + dwell timer (via useViewportIntersection)
 *  - hydrated→suspended→static transitions (screenshot capture then lifecycle flip)
 *  - static→hydrated on click request
 *  - dev-mode memory warning (hydrated > 20, §5.9)
 *
 * Entities are dumb; supervisor enforces global policy.
 */
import { useCallback, useEffect, useRef } from 'react'
import { ChatAdapter, getChatInstance } from './adapters/ChatAdapter'
import { BrowserAdapter, getBrowserInstance, releaseBrowserInstance } from './adapters/BrowserAdapter'
import Entity from './Entity'
import { useCanvasStore } from './store'
import { NoteAdapter, getNoteInstance } from './adapters/NoteAdapter'
import { useViewportIntersection } from './hooks/useViewportIntersection'
import type { CanvasEntity, EntityAdapter, EntityType } from './types'

// Adapter registry. Extended in ADR-007+ (Browser, IDE, Chat, etc.).
const adapters: { [K in EntityType]?: EntityAdapter<K> } = {
  chat: ChatAdapter,
  note: NoteAdapter,
  browser: BrowserAdapter
}

function getAdapter<T extends EntityType>(type: T): EntityAdapter<T> | undefined {
  return adapters[type] as EntityAdapter<T> | undefined
}

interface EntityLayerProps {
  /** Viewport pixel size (the Canvas root's clientWidth/clientHeight). */
  viewportSize: { w: number; h: number }
}

export default function EntityLayer({ viewportSize }: EntityLayerProps): JSX.Element {
  const { state, dispatch } = useCanvasStore()
  const { entities, viewport } = state

  // Track last-warned hydrated count so we don't spam console.
  const lastWarnedRef = useRef<number>(0)

  // ── suspend trigger: viewport-out dwell elapsed ───────────────────
  const onSuspendTrigger = useCallback(
    async (id: string): Promise<void> => {
      const entity = entities.find((e) => e.id === id)
      if (!entity || entity.lifecycle !== 'hydrated') return
      const adapter = getAdapter(entity.type)
      if (!adapter) return

      // Mark suspended immediately (DOM teardown 중 상태). §5.3 transition 2.
      dispatch({ type: 'SET_LIFECYCLE', id, lifecycle: 'suspended' })

      // Capture snapshot, then flip to static.
      try {
        // Adapter-specific instance lookup.
        const instance =
          entity.type === 'note'
            ? getNoteInstance(id)
            : entity.type === 'chat'
              ? getChatInstance(id)
              : entity.type === 'browser'
                ? getBrowserInstance(id)
                : undefined
        if (!instance) {
          // Instance missing — skip to static without snapshot (graceful).
          dispatch({ type: 'SET_LIFECYCLE', id, lifecycle: 'static' })
          return
        }
        const snapshot = await adapter.suspend(instance as never)
        dispatch({ type: 'SET_LIFECYCLE', id, lifecycle: 'static', snapshot })
      } catch (err) {
        // Screenshot failed — revert to hydrated so user isn't stuck with blank card.
        console.warn('[Canvas] screenshot capture failed for', id, err)
        dispatch({ type: 'SET_LIFECYCLE', id, lifecycle: 'hydrated' })
      }
    },
    [entities, dispatch]
  )

  useViewportIntersection({
    entities,
    viewport,
    viewportSize,
    onSuspendTrigger
  })

  // ── static → hydrated on click ────────────────────────────────────
  const onHydrateRequest = useCallback(
    (id: string): void => {
      const entity = entities.find((e) => e.id === id)
      if (!entity || entity.lifecycle !== 'static') return
      const adapter = getAdapter(entity.type)
      if (!adapter) return
      // Adapter.hydrate is sync-or-async; in Note's case it just reserves a slot.
      Promise.resolve(adapter.hydrate(entity as never)).then(() => {
        dispatch({ type: 'SET_LIFECYCLE', id, lifecycle: 'hydrated' })
        dispatch({ type: 'TOUCH_ENTITY', id })
      })
    },
    [entities, dispatch]
  )

  const onTouch = useCallback(
    (id: string): void => {
      dispatch({ type: 'TOUCH_ENTITY', id })
    },
    [dispatch]
  )

  // ── browser entity cleanup on discard ────────────────────────────
  // When a browser entity transitions to 'discarded', release its OSR window.
  useEffect(() => {
    const discardedBrowserIds = entities
      .filter((e) => e.type === 'browser' && e.lifecycle === 'discarded')
      .map((e) => e.id)
    for (const id of discardedBrowserIds) {
      releaseBrowserInstance(id).catch((err) =>
        console.warn('[Canvas] failed to release browser instance', id, err)
      )
    }
  }, [entities])

  // ── dev memory warning (§5.9) ─────────────────────────────────────
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const hydratedCount = entities.filter((e) => e.lifecycle === 'hydrated').length
    if (hydratedCount > 20 && hydratedCount !== lastWarnedRef.current) {
      console.warn(
        `[Canvas] Hydrated entities exceed 20 (${hydratedCount}), consider pan-out to release memory.`
      )
      lastWarnedRef.current = hydratedCount
    } else if (hydratedCount <= 20 && lastWarnedRef.current > 0) {
      lastWarnedRef.current = 0 // allow re-warning next time
    }
  }, [entities])

  // ── render ────────────────────────────────────────────────────────
  return (
    <div
      className="absolute inset-0"
      data-testid="entity-layer"
      style={{ pointerEvents: 'none' }}
    >
      {entities.map((entity) => {
        if (entity.lifecycle === 'discarded') return null
        const adapter = getAdapter(entity.type)
        if (!adapter) return null
        return (
          <div key={entity.id} style={{ pointerEvents: 'auto' }}>
            <Entity
              entity={entity as CanvasEntity<typeof entity.type>}
              adapter={adapter as EntityAdapter<typeof entity.type>}
              onHydrateRequest={onHydrateRequest}
              onTouch={onTouch}
            />
          </div>
        )
      })}
    </div>
  )
}
