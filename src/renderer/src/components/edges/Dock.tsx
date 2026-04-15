/**
 * Dock — Bottom Edge (DESIGN_SYSTEM_SPEC.md §7-2 v2, ADR-004)
 *
 * Frosted glass bar, content-aware width, centered.
 * Layout: [Chat] [Shelf] [Browser] [IDE] [Note] ── [Pencil] [Hand] [Square] [Arrow] ── [Trash]
 *   Left group (5): system apps + IDE + note launcher
 *   Center group (4): canvas tools (state-toggle, one active)
 *   Right group (1): trash
 *
 * 3-group structure hosts dual ontology axes (객체축 + 메타축) per ADR-004.
 * 5-element rule exception: Dock allows max 12 total, 5 per group (§7 L316 v2).
 * Left group now at per-group max 5 — further additions need ADR trigger.
 */
import { useCallback } from 'react'
import { defaultNoteProps } from '../../canvas/adapters/NoteAdapter'
import { createEntity, useCanvasStore } from '../../canvas/store'
import Tooltip from '../Tooltip'
import {
  Arrow,
  ChatBubble,
  Code,
  FolderStack,
  Globe,
  Hand,
  NoteCard,
  Pencil,
  Square,
  Trash
} from '../icons'

interface DockProps {
  onChatClick: () => void
  chatActive: boolean
}

function Dock(props: DockProps): JSX.Element {
  const { state, dispatch } = useCanvasStore()
  const noteCount = state.entities.filter((entity) => entity.type === 'note').length

  const handleCreateNote = useCallback(() => {
    const size = { w: 280, h: 180 }
    const position = {
      x: (window.innerWidth * 0.5 - state.viewport.x) / state.viewport.k - size.w / 2,
      y: (window.innerHeight * 0.42 - state.viewport.y) / state.viewport.k - size.h / 2
    }

    dispatch({
      type: 'ADD_ENTITY',
      entity: createEntity('note', position, defaultNoteProps(noteCount + 1), size)
    })
  }, [dispatch, noteCount, state.viewport])

  return (
    <div
      data-testid="dock"
      className="glass pointer-events-auto fixed bottom-4 left-1/2 z-40 flex h-14 w-auto max-w-[min(95vw,960px)] -translate-x-1/2 items-center gap-4 rounded-2xl px-5"
    >
      {/* Left group: Chat / Shelf / Browser / IDE / Note */}
      <div className="flex items-center gap-2">
        <DockIcon
          icon={ChatBubble}
          label="Chat / Agent"
          badge
          onClick={props.onChatClick}
          active={props.chatActive}
        />
        <DockIcon icon={FolderStack} label="Shelf (Library)" />
        <DockIcon icon={Globe} label="Browser" />
        <DockIcon icon={Code} label="IDE" />
        <DockIcon icon={NoteCard} label="Note" onClick={handleCreateNote} />
      </div>

      <span className="h-8 w-px bg-[var(--outline-variant)]" />

      {/* Center group: Canvas tools */}
      <div className="flex items-center gap-2">
        <DockIcon icon={Pencil} label="Pencil" />
        <DockIcon icon={Hand} label="Hand / Pan" />
        <DockIcon icon={Square} label="Square" />
        <DockIcon icon={Arrow} label="Arrow / Pointer" />
      </div>

      <span className="h-8 w-px bg-[var(--outline-variant)]" />

      {/* Right group: Trash */}
      <div className="flex items-center gap-2">
        <DockIcon icon={Trash} label="Trash" />
      </div>
    </div>
  )
}

interface DockIconProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  badge?: boolean
  onClick?: () => void
  active?: boolean
}

function DockIcon({ icon: Icon, label, badge, onClick, active }: DockIconProps): JSX.Element {
  const activeClass = active
    ? 'bg-white/60 text-[var(--primary)]'
    : 'text-[var(--on-surface-variant)]'
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={`relative flex h-10 w-10 items-center justify-center rounded-lg transition hover:bg-white/60 hover:text-[var(--primary)] ${activeClass}`}
      >
        <Icon className="h-5 w-5" />
        {badge && (
          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--primary)]" />
        )}
      </button>
    </Tooltip>
  )
}

export default Dock
