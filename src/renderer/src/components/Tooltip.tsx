/**
 * Tooltip — Edge-away hover label (DESIGN_SYSTEM_SPEC.md §12)
 *
 * Wraps a hover target (IconButton etc.) and renders a paper-tone label
 * positioned *away* from the hosting Edge:
 *   - Dock (bottom)   → side="top"    (label above)
 *   - DeskRail (top)  → side="bottom" (label below)
 *   - HUD (right)     → side="left"   (label to the left)
 *   - PresetBag (left)→ side="right"  (rarely used — preset mini-map preferred)
 *
 * Design: paper-tone (surface-elevated + outline-variant + shadow-card)
 * contrasts with frosted Edge glass — same treatment as Canvas Toolbar.
 *
 * Interaction: 500ms hover hold → fade-in 150ms (CSS transition-delay).
 * Z-index: 50 (above Edges z-40).
 * Accessibility: role="tooltip", preserves child's aria-label.
 */

type Side = 'top' | 'bottom' | 'left' | 'right'

interface TooltipProps {
  label: string
  side?: Side
  children: React.ReactNode
}

const sidePosition: Record<Side, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  left: 'right-full top-1/2 -translate-y-1/2 mr-2',
  right: 'left-full top-1/2 -translate-y-1/2 ml-2'
}

function Tooltip({ label, side = 'top', children }: TooltipProps): JSX.Element {
  return (
    <span className="group relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-50 whitespace-nowrap rounded-md border border-[var(--outline-variant)] bg-[var(--surface-elevated)] px-2 py-1 text-[11px] font-medium text-[var(--on-surface)] opacity-0 shadow-[var(--shadow-card)] transition-opacity duration-150 delay-0 group-hover:opacity-100 group-hover:delay-500 ${sidePosition[side]}`}
      >
        {label}
      </span>
    </span>
  )
}

export default Tooltip
