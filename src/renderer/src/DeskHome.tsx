import { useState } from 'react'
import Canvas from './canvas/Canvas'
import { CanvasStoreProvider } from './canvas/store'
import ContextualHUD from './components/edges/ContextualHUD'
import DeskRail from './components/edges/DeskRail'
import Dock from './components/edges/Dock'
import PresetBag from './components/edges/PresetBag'
import { usePanImmersion } from './hooks/usePanImmersion'

function DeskHome(): JSX.Element {
  const [hudOpen, setHudOpen] = useState(false)
  const isPanning = usePanImmersion()

  const edgeWrapperClass = `transition-opacity duration-150 ease-out ${
    isPanning ? 'pointer-events-none opacity-0' : 'opacity-100'
  }`

  return (
    <CanvasStoreProvider>
      <div id="desk-home" className="relative h-screen w-screen overflow-hidden">
        <Canvas />

        <div className={edgeWrapperClass}>
          <DeskRail />
        </div>
        <div className={edgeWrapperClass}>
          <Dock onChatClick={() => setHudOpen((value) => !value)} chatActive={hudOpen} />
        </div>
        <div className={edgeWrapperClass}>
          <PresetBag />
        </div>

        {hudOpen && <ContextualHUD onClose={() => setHudOpen(false)} />}
      </div>
    </CanvasStoreProvider>
  )
}

export default DeskHome
