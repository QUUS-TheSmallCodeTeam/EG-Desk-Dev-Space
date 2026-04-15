/**
 * ViewportContainer — single GPU-accelerated transform layer (ADR-006 §5.1)
 *
 * Consumes viewport transform from canvas store and applies CSS
 *   transform: translate(x, y) scale(k)
 * to its children. EntityLayer sits inside so all entity coords stay in
 * canvas-space; only this node's transform changes on pan/zoom.
 */
import type { ReactNode } from 'react'
import type { ViewportTransform } from './types'

interface ViewportContainerProps {
  viewport: ViewportTransform
  children: ReactNode
}

export default function ViewportContainer({
  viewport,
  children
}: ViewportContainerProps): JSX.Element {
  // translate3d / will-change hint ensure GPU layer (ADR-006 §5.1 Safari note).
  const style: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    transformOrigin: '0 0',
    transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.k})`,
    willChange: 'transform',
    // Children are absolutely positioned in canvas-space → no intrinsic size.
    pointerEvents: 'none'
  }
  return (
    <div data-testid="viewport-container" style={style}>
      {children}
    </div>
  )
}
