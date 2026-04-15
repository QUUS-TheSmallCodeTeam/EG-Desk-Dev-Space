import { createElement } from 'react'
import { captureDomSnapshot } from '../hooks/useScreenshotCapture'
import type { CanvasEntity, EntityAdapter } from '../types'

interface ChatInstance {
  element: HTMLElement | null
}

const instances = new Map<string, ChatInstance>()

export function getChatInstance(id: string): ChatInstance | undefined {
  return instances.get(id)
}

export function setChatElement(id: string, el: HTMLElement | null): void {
  const existing = instances.get(id)
  if (existing) existing.element = el
  else if (el) instances.set(id, { element: el })
}

export const ChatAdapter: EntityAdapter<'chat'> = {
  type: 'chat',

  hydrate(entity) {
    if (!instances.has(entity.id)) instances.set(entity.id, { element: null })
    return instances.get(entity.id) as ChatInstance
  },

  async suspend(instance) {
    const chat = instance as ChatInstance
    if (!chat.element) {
      return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQIW2NkAAIAAAoAAv/lxKUAAAAASUVORK5CYII='
    }
    return captureDomSnapshot(chat.element, { maxWidth: 720 })
  },

  async captureSnapshot(instance) {
    const chat = instance as ChatInstance
    if (!chat.element) throw new Error('ChatAdapter.captureSnapshot: element not mounted')
    return captureDomSnapshot(chat.element, { maxWidth: 720 })
  },

  render(entity) {
    return createElement(
      'div',
      {
        className:
          'glass flex h-full w-full flex-col rounded-xl border border-[var(--outline-variant)] p-3 text-[12px] text-[var(--on-surface)] shadow-card'
      },
      createElement(
        'div',
        { className: 'mb-2 flex items-center justify-between gap-2' },
        createElement('div', { className: 'text-[13px] font-semibold' }, 'Codex Chat'),
        createElement(
          'span',
          {
            className:
              'rounded bg-[var(--primary-container)] px-2 py-0.5 text-[10px] text-[var(--primary)]'
          },
          'Entity'
        )
      ),
      createElement(
        'div',
        { className: 'text-[11px] text-[var(--on-surface-variant)]' },
        `Conversation ${entity.typeProps.conversationId}`
      ),
      createElement(
        'div',
        {
          className:
            'mt-3 flex-1 rounded-lg bg-white/60 p-2 text-[11px] text-[var(--on-surface-variant)]'
        },
        'HUD conversation snapshot placeholder. Embedded transcript hydration lands next.'
      )
    )
  }
}

export function releaseChatInstance(id: string): void {
  instances.delete(id)
}

export function isChatEntity(entity: CanvasEntity): entity is CanvasEntity<'chat'> {
  return entity.type === 'chat'
}
