/**
 * Preset Bag — Left Edge (DESIGN_SYSTEM_SPEC.md §7-3)
 *
 * Frosted glass vertical bag. 48-56px collapsed (v1), 280px expanded (P2 — not impl).
 * Holds saved entity presets (files + tabs + apps bundled together).
 *
 * Icon unification: all presets render with the same neutral chip (Primary bg + 2-char
 * initials) so shape never implies category. Name is conveyed via hover preview popover.
 * Bag header + New preset use tooltips; list items use PresetPreview popover (richer —
 * preset name + static preview thumbnail) per §7-3 "preset mini-map preferred".
 */
import { useState } from 'react'
import Tooltip from '../Tooltip'
import { Bag, Plus } from '../icons'

// Placeholder preset list — v1 hardcoded demo.
// initials: 2-char label drawn from preset name (unified chip, no varying icon shapes).
const presets = [
  { id: 'react-dev', name: 'React 개발', initials: 'RE' },
  { id: 'meeting', name: '회의 준비', initials: '회의' },
  { id: 'writing', name: '집필', initials: '집필' }
]

function PresetBag(): JSX.Element {
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  return (
    <div
      data-testid="preset-bag"
      className="glass pointer-events-auto fixed left-3 top-1/2 z-40 flex w-14 -translate-y-1/2 flex-col items-center gap-2 rounded-xl py-3"
      style={{ height: 'min(80vh, 720px)' }}
    >
      {/* Bag header */}
      <Tooltip label="Preset Bag" side="right">
        <div
          className="flex h-10 w-10 items-center justify-center text-[var(--on-surface-variant)]"
          aria-label="Preset Bag"
        >
          <Bag className="h-5 w-5" />
        </div>
      </Tooltip>

      <span className="h-px w-8 bg-[var(--outline-variant)]" />

      {/* Preset list — unified chips + hover preview */}
      <div className="flex flex-1 flex-col items-center gap-2 overflow-y-auto">
        {presets.map((preset) => (
          <div key={preset.id} className="relative">
            <button
              type="button"
              aria-label={preset.name}
              onMouseEnter={() => setHoveredId(preset.id)}
              onMouseLeave={() => setHoveredId((id) => (id === preset.id ? null : id))}
              onContextMenu={(e) => {
                e.preventDefault()
                // v1 placeholder: right-click context menu (Rename / Delete / Duplicate).
                // TODO: wire into context menu system.
              }}
              className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--primary)] text-[10px] font-semibold leading-none text-white shadow-sm ring-1 ring-[var(--outline-variant)] transition hover:scale-105"
            >
              {preset.initials}
            </button>
            {hoveredId === preset.id && <PresetPreview name={preset.name} />}
          </div>
        ))}
      </div>

      <span className="h-px w-8 bg-[var(--outline-variant)]" />

      {/* New preset */}
      <Tooltip label="New preset" side="right">
        <button
          type="button"
          aria-label="New preset"
          className="flex h-10 w-10 items-center justify-center rounded-lg border border-dashed border-[var(--outline)] text-[var(--on-surface-variant)] transition hover:border-[var(--primary)] hover:text-[var(--primary)]"
        >
          <Plus className="h-4 w-4" />
        </button>
      </Tooltip>
    </div>
  )
}

/**
 * PresetPreview — Right-side hover popover for preset chips.
 *
 * 200×140px paper-tone card with preset name header + static placeholder thumbnail
 * (gradient bg represents the preset's workspace snapshot, v1 stub).
 * Positioned right of the chip with 16px offset. Fade-in 200ms.
 * Richer than Tooltip (name + visual) — per SPEC §7-3 "mini-map preferred for presets".
 */
function PresetPreview({ name }: { name: string }): JSX.Element {
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute left-full top-1/2 z-50 ml-4 w-[200px] -translate-y-1/2 overflow-hidden rounded-lg border border-[var(--outline-variant)] bg-[var(--surface-elevated)] shadow-[var(--shadow-card)]"
    >
      {/* Header — preset name */}
      <div className="border-b border-[var(--outline-variant)] px-3 py-2 text-[12px] font-semibold text-[var(--on-surface)]">
        {name}
      </div>
      {/* Preview thumbnail — static gradient placeholder (v1) */}
      <div
        className="h-[100px] w-full"
        style={{
          background:
            'linear-gradient(135deg, var(--primary-container) 0%, var(--surface) 100%)'
        }}
      />
    </div>
  )
}

export default PresetBag
