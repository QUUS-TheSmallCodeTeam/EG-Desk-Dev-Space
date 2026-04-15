/**
 * NoteAdapter — first concrete EntityAdapter (ADR-006 §5.10)
 *
 * Note entity is the simplest type: DOM-only paper card, no external resource.
 * - hydrate: returns a reference container (DOM ref attached by Entity wrapper)
 * - suspend: captures PNG screenshot of the rendered card
 * - render: simple card w/ text; on static lifecycle renders snapshot <img>
 * - captureSnapshot: reusable by ADR-005 preset pack
 *
 * Render is intentionally minimal — design-agent may restyle later.
 */
import { createElement } from 'react'
import { captureDomSnapshot } from '../hooks/useScreenshotCapture'
import type { CanvasEntity, EntityAdapter } from '../types'

interface NoteInstance {
  /** Live DOM node mounted via Entity wrapper's ref. Adapter sets this after render. */
  element: HTMLElement | null
}

// Instance registry keyed by entity id.
// EntityLayer supervisor uses adapter.hydrate() once per entity, keeping the
// returned NoteInstance. The Entity wrapper writes the real DOM ref into it
// via a side-channel callback (see Entity.tsx).
const instances = new Map<string, NoteInstance>()

export function getNoteInstance(id: string): NoteInstance | undefined {
  return instances.get(id)
}

export function setNoteElement(id: string, el: HTMLElement | null): void {
  const existing = instances.get(id)
  if (existing) existing.element = el
  else if (el) instances.set(id, { element: el })
}

export const NoteAdapter: EntityAdapter<'note'> = {
  type: 'note',

  hydrate(entity) {
    // Ensure a registry slot exists; element is populated by Entity wrapper.
    if (!instances.has(entity.id)) instances.set(entity.id, { element: null })
    return instances.get(entity.id) as NoteInstance
  },

  async suspend(instance) {
    const note = instance as NoteInstance
    if (!note.element) {
      // Fallback: empty placeholder data URL (1x1 transparent PNG)
      return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQIW2NkAAIAAAoAAv/lxKUAAAAASUVORK5CYII='
    }
    return captureDomSnapshot(note.element, { maxWidth: 640 })
  },

  async captureSnapshot(instance) {
    const note = instance as NoteInstance
    if (!note.element) throw new Error('NoteAdapter.captureSnapshot: element not mounted')
    return captureDomSnapshot(note.element, { maxWidth: 640 })
  },

  render(entity) {
    // Keep adapter.render simple — the Entity wrapper handles position/size +
    // lifecycle-based rendering (static→<img>, hydrated→this JSX).
    const text = entity.typeProps.text
    return createElement(
      'div',
      {
        className:
          'paper-surface shadow-card flex h-full w-full items-start rounded-lg p-3 text-sm text-[var(--on-surface)] leading-relaxed whitespace-pre-wrap break-words select-none',
        'data-note-id': entity.id
      },
      text
    )
  }
}

/** Release instance when entity is discarded (called by supervisor). */
export function releaseNoteInstance(id: string): void {
  instances.delete(id)
}

/**
 * Default text factory for "Add Note" button. Kept here so DeskHome/dev UI
 * doesn't need to know Note's typeProps shape.
 */
export function defaultNoteProps(index: number): { text: string } {
  return { text: `Note #${index}\n\nClick to edit (v1 placeholder)` }
}

/**
 * Narrowing helper — asserts entity is a note. Used by EntityLayer to pass
 * the correctly typed entity into NoteAdapter.render.
 */
export function isNoteEntity(entity: CanvasEntity): entity is CanvasEntity<'note'> {
  return entity.type === 'note'
}
