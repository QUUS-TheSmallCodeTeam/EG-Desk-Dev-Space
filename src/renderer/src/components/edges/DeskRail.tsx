/**
 * Desk Rail — Top Edge (DESIGN_SYSTEM_SPEC.md §7-1)
 *
 * Frosted glass capsule floating from top, horizontally centered (axis aligned with Dock).
 * Width clamps to viewport - 176px (traffic lights 88px × 2 side buffer), capped at 900/1100/1344.
 * Layout: [●●● traffic lights (native)] [Desk Switcher] [Search] [Minimap] [Bell] [Profile]
 * (Traffic lights are rendered by macOS titleBarStyle='hiddenInset' at ~16-80px from left.)
 */
import Tooltip from '../Tooltip'
import { Bell, Map, Search } from '../icons'

function DeskRail(): JSX.Element {
  return (
    <div
      data-testid="desk-rail"
      className="glass pointer-events-auto fixed left-1/2 top-4 z-40 flex h-12 w-[calc(min(100vw-176px,900px))] -translate-x-1/2 items-center gap-4 rounded-[24px] px-5 xl:w-[calc(min(100vw-176px,1100px))] 2xl:w-[calc(min(100vw-176px,1344px))]"
    >
      {/* Left: Desk Switcher */}
      <button
        type="button"
        className="flex min-w-0 items-center gap-2 text-left text-sm font-medium text-[var(--on-surface)] hover:text-[var(--primary)]"
      >
        <span className="truncate">EG-Desk</span>
        <span className="text-[10px] text-[var(--secondary)]">▾</span>
      </button>

      <span className="h-5 w-px bg-[var(--outline-variant)]" />

      {/* Center: Cmd+K Search */}
      <button
        type="button"
        className="flex flex-1 items-center gap-2 rounded-full bg-white/50 px-3 py-1.5 text-left text-[13px] text-[var(--on-surface-variant)] ring-1 ring-inset ring-[var(--outline-variant)] transition hover:bg-white/80"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="flex-1 truncate">Search or ask AI…</span>
        <kbd className="rounded bg-[var(--outline-variant)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--on-surface-variant)]">
          ⌘K
        </kbd>
      </button>

      <span className="h-5 w-px bg-[var(--outline-variant)]" />

      {/* Right: Minimap / Bell / Profile */}
      <div className="flex items-center gap-3">
        <Tooltip label="Minimap" side="bottom">
          <button
            type="button"
            className="text-[var(--on-surface-variant)] transition hover:text-[var(--primary)]"
            aria-label="Minimap"
          >
            <Map className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip label="Notifications" side="bottom">
          <button
            type="button"
            className="relative text-[var(--on-surface-variant)] transition hover:text-[var(--primary)]"
            aria-label="Notifications"
          >
            <Bell className="h-4 w-4" />
            <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-[var(--error)]" />
          </button>
        </Tooltip>
        <Tooltip label="Profile" side="bottom">
          <div
            className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--primary)] ring-2 ring-white/60"
            aria-label="Profile"
          >
            <span className="text-[10px] font-semibold leading-none text-white">M</span>
          </div>
        </Tooltip>
      </div>
    </div>
  )
}

export default DeskRail
