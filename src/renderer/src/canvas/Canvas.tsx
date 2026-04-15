/**
 * Canvas — root surface (ADR-006 §5.1, SPEC §9-3-1)
 *
 * Tree:
 *   <Canvas>                 ← paper-surface + d3-zoom target (this file)
 *     <ViewportContainer>    ← CSS transform layer
 *       <EntityLayer>        ← supervisor + entities
 *
 * Exposes:
 *  - d3-zoom attached to root (pan/zoom gestures)
 *  - viewport size measurement (for intersection math)
 */
import { useEffect, useRef, useState } from 'react'
import { useCanvasStore, createEntity } from './store'
import { useCanvasTransform } from './hooks/useCanvasTransform'
import ViewportContainer from './ViewportContainer'
import EntityLayer from './EntityLayer'

const ENABLE_BROWSER_SEED = true

export default function Canvas(): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { state, dispatch } = useCanvasStore()
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 })
  const browserSeededRef = useRef(false)

  // d3-zoom attach
  useCanvasTransform({
    targetRef: rootRef,
    onTransform: (vt) => dispatch({ type: 'SET_VIEWPORT', viewport: vt })
  })

  // Measure viewport on mount + resize (supervisor needs this for isOut math).
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const update = (): void => {
      setViewportSize({ w: el.clientWidth, h: el.clientHeight })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    console.log('[Canvas] shell mounted')
  }, [])

  // POC: Seed a default Browser entity (naver.com) on first mount.
  // Guard with ref so HMR / StrictMode double-fire doesn't create duplicates.
  useEffect(() => {
    if (!ENABLE_BROWSER_SEED) return
    if (browserSeededRef.current) return
    browserSeededRef.current = true

    const hasBrowser = state.entities.some((e) => e.type === 'browser')
    if (hasBrowser) return

    // Place the browser entity at a visible position in canvas-space.
    // 1280x800 is a reasonable initial OSR resolution.
    const size = { w: 1280, h: 800 }
    const position = { x: 60, y: 60 }

    dispatch({
      type: 'ADD_ENTITY',
      entity: createEntity('browser', position, { url: 'https://www.naver.com' }, size)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // intentionally empty: run once on mount only

  // Dev: entity count 변화 시 console 출력 (UI HUD 대체 — Failure_Modes #16: 디버그 정보는 콘솔에)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const total = state.entities.length
    const hydrated = state.entities.filter((e) => e.lifecycle === 'hydrated').length
    const staticCount = state.entities.filter((e) => e.lifecycle === 'static').length
    console.log('[Canvas]', { entities: total, hydrated, static: staticCount })
  }, [state.entities])

  return (
    <div
      ref={rootRef}
      data-testid="canvas-root"
      className="paper-surface absolute inset-0 overflow-hidden"
      style={{ touchAction: 'none' }} // d3-zoom handles gestures
    >
      <ViewportContainer viewport={state.viewport}>
        <EntityLayer viewportSize={viewportSize} />
      </ViewportContainer>
    </div>
  )
}
