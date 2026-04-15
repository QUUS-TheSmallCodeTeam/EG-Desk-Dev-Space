/**
 * useCanvasTransform — d3-zoom wrapper (ADR-006 §5.1, §4A)
 *
 * Attaches d3-zoom to a target element (Canvas root), publishes viewport
 * transform (x, y, k) to the canvas store via onTransform callback.
 *
 * Gesture semantics:
 *  - Trackpad pan (two-finger) + wheel zoom (Ctrl/⌘-wheel) handled by d3-zoom
 *  - Click-drag pan allowed only when Pan Immersion key held (Space/Meta/Ctrl)
 *    → filter() gate. Prevents Note-card selection collisions.
 *  - Scale bounds: 0.2 … 4 (SPEC §9-3 v2 tuning candidate)
 */
import { useEffect, type RefObject } from 'react'
import { select } from 'd3-selection'
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior } from 'd3-zoom'
import type { ViewportTransform } from '../types'

export interface UseCanvasTransformOptions {
  targetRef: RefObject<HTMLElement>
  onTransform: (vt: ViewportTransform) => void
  minScale?: number
  maxScale?: number
}

// Module-level flag: Space 키 hold 상태. d3-zoom filter가 MouseEvent만 받아
// Space keydown을 직접 확인할 수 없으므로 전역 document 리스너로 추적.
// usePanImmersion과 동일한 의도 (Space/Cmd/Ctrl hold → pan 허용)를 filter에서도 재현.
let spaceHeld = false

export function useCanvasTransform({
  targetRef,
  onTransform,
  minScale = 0.2,
  maxScale = 4
}: UseCanvasTransformOptions): void {
  useEffect(() => {
    const el = targetRef.current
    if (!el) return

    // Space 키 전역 추적 — text input focused 시 무시 (usePanImmersion과 동일 정책)
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return
      const active = document.activeElement
      const isInput =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active as HTMLElement | null)?.isContentEditable === true
      if (isInput) return
      spaceHeld = true
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space') spaceHeld = false
    }
    const onBlur = (): void => {
      spaceHeld = false
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)

    const behavior: ZoomBehavior<HTMLElement, unknown> = zoom<HTMLElement, unknown>()
      .scaleExtent([minScale, maxScale])
      // Filter: allow pan on (Space | Meta | Ctrl | Shift) hold, or wheel/touch/pinch.
      // Prevents plain click-drag on a Note card from triggering canvas pan.
      .filter((event: Event) => {
        if (event.type === 'wheel' || event.type.startsWith('touch')) return true
        const me = event as MouseEvent
        // Space는 MouseEvent에 노출되지 않으므로 module-level `spaceHeld` flag 참조.
        return me.metaKey || me.ctrlKey || me.shiftKey || spaceHeld
      })
      .on('zoom', (event: D3ZoomEvent<HTMLElement, unknown>) => {
        const t = event.transform
        onTransform({ x: t.x, y: t.y, k: t.k })
      })

    const selection = select(el)
    selection.call(behavior)
    // Initialize at identity so dispatch fires once
    selection.call(behavior.transform, zoomIdentity)

    return () => {
      selection.on('.zoom', null)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetRef, minScale, maxScale])
}
