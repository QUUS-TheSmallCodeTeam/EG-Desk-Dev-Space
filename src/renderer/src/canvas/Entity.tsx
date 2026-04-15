/**
 * Entity — per-entity wrapper (ADR-006 §5.1, §5.6 click-to-reload)
 *
 * Renders an absolutely-positioned <div> at canvas-space coordinates. Inside:
 *  - hydrated   : adapter.render(entity) — live DOM
 *  - suspended  : adapter.render(entity) (screenshot capture in-flight)
 *  - static     : <img src={snapshot} /> — click to hydrate
 *  - discarded  : not reached (filtered out in EntityLayer)
 *
 * Click handler:
 *  - static: dispatch rehydrate request
 *  - hydrated: TOUCH (lastActiveAt) for LRU signals (supervisor uses it, v2 tuning)
 */
import { useCallback, useEffect, useRef } from 'react'
import { setChatElement } from './adapters/ChatAdapter'
import type { CanvasEntity, EntityAdapter, EntityType } from './types'
import { setNoteElement } from './adapters/NoteAdapter'

interface EntityProps<T extends EntityType> {
  entity: CanvasEntity<T>
  adapter: EntityAdapter<T>
  onHydrateRequest: (id: string) => void
  onTouch: (id: string) => void
}

export default function Entity<T extends EntityType>({
  entity,
  adapter,
  onHydrateRequest,
  onTouch
}: EntityProps<T>): JSX.Element {
  const domRef = useRef<HTMLDivElement | null>(null)

  // Register the real DOM node with the adapter's instance (so screenshot
  // capture can read it). Only Note type currently — generalise when more
  // adapters land in ADR-007+.
  useEffect(() => {
    if (entity.type === 'note') {
      setNoteElement(entity.id, domRef.current)
      return () => setNoteElement(entity.id, null)
    }
    if (entity.type === 'chat') {
      setChatElement(entity.id, domRef.current)
      return () => setChatElement(entity.id, null)
    }
    return undefined
  }, [entity.id, entity.type])

  const handleClick = useCallback(
    (e: React.MouseEvent): void => {
      if (entity.lifecycle === 'static') {
        e.stopPropagation()
        onHydrateRequest(entity.id)
      } else if (entity.lifecycle === 'hydrated') {
        onTouch(entity.id)
      }
    },
    [entity.id, entity.lifecycle, onHydrateRequest, onTouch]
  )

  const style: React.CSSProperties = {
    position: 'absolute',
    left: entity.position.x,
    top: entity.position.y,
    width: entity.size.w,
    height: entity.size.h,
    zIndex: entity.zIndex
  }

  // Static → show snapshot. ADR-006 §5.6 Chrome discarded tab pattern.
  if (entity.lifecycle === 'static' && entity.snapshot) {
    return (
      <div
        ref={domRef}
        style={style}
        onClick={handleClick}
        className="overflow-hidden rounded-lg cursor-pointer transition-opacity hover:opacity-90"
        data-testid={`entity-static-${entity.id}`}
        data-entity-id={entity.id}
        data-lifecycle="static"
      >
        <img
          src={entity.snapshot}
          alt=""
          className="h-full w-full object-cover pointer-events-none"
          draggable={false}
        />
      </div>
    )
  }

  // Hydrated / suspended — adapter renders live DOM.
  // We intentionally render the same markup during suspended so the pending
  // screenshot can capture the final state without DOM teardown race.
  return (
    <div
      ref={domRef}
      style={style}
      onClick={handleClick}
      data-entity-id={entity.id}
      data-lifecycle={entity.lifecycle}
      data-testid={`entity-${entity.lifecycle}-${entity.id}`}
    >
      {adapter.render(entity)}
    </div>
  )
}
