/**
 * Desk Home v1 — L0 Canvas Surface + 4-Edge Framework
 *
 * DESIGN_SYSTEM_SPEC.md §7 (Edge System), §8 (Visual Hierarchy), §9-3 (Canvas v1) 기반.
 * - L0 (Surface): Canvas (paper-surface + ViewportContainer + EntityLayer, ADR-006)
 * - L3 (Edge System): DeskRail(top) / Dock(bottom) / PresetBag(left) / ContextualHUD(right)
 * - Pan Immersion: Space/Cmd+drag 중 Edge 3개(DeskRail/Dock/PresetBag) fade-out
 *
 * Hard rules: LIGHT mode only, Inter font (globals.css), no dark classes.
 */
import { useState } from 'react'
import DeskRail from './components/edges/DeskRail'
import Dock from './components/edges/Dock'
import PresetBag from './components/edges/PresetBag'
import ContextualHUD from './components/edges/ContextualHUD'
import { usePanImmersion } from './hooks/usePanImmersion'
import Canvas from './canvas/Canvas'
import { CanvasStoreProvider } from './canvas/store'

function DeskHome(): JSX.Element {
  const [hudOpen, setHudOpen] = useState(false)
  const isPanning = usePanImmersion()

  // Pan 중 3 Edge (DeskRail/Dock/PresetBag) fade-out. HUD는 유지.
  const edgeWrapperClass = `transition-opacity duration-150 ease-out ${
    isPanning ? 'pointer-events-none opacity-0' : 'opacity-100'
  }`

  return (
    <CanvasStoreProvider>
      <div id="desk-home" className="relative h-screen w-screen overflow-hidden">
        {/* L0 Canvas — paper-surface + Canvas Entity Foundation (ADR-006) */}
        <Canvas />

        {/* L3 Edge System — 4-Edge Framework (Pan 중 fade-out) */}
        <div className={edgeWrapperClass}>
          <DeskRail />
        </div>
        <div className={edgeWrapperClass}>
          <Dock onChatClick={() => setHudOpen((v) => !v)} chatActive={hudOpen} />
        </div>
        <div className={edgeWrapperClass}>
          <PresetBag />
        </div>

        {/* Right HUD는 pan 중에도 유지 */}
        {hudOpen && <ContextualHUD onClose={() => setHudOpen(false)} />}
      </div>
    </CanvasStoreProvider>
  )
}

export default DeskHome
