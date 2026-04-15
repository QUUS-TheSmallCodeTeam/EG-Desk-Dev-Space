/**
 * BrowserAdapter — OSR-based embedded browser (POC, display-only)
 *
 * Architecture:
 *  - BrowserFrame: React component that:
 *      1. On mount, calls window.api.browser.create() to spin up the OSR window
 *      2. Subscribes to onFrame events from main, decodes PNG buffer via ImageBitmap,
 *         and draws each frame directly onto a <canvas> element (bypasses img.src issues)
 *  - adapter.hydrate: delegates to the same ensureHydrated path (for re-hydration)
 *  - adapter.suspend: exports canvas toDataURL as snapshot
 *  - releaseBrowserInstance: tears down the OSR window on entity discard
 *
 * Phase 1 constraints:
 *  - Display-only (no click/keyboard interaction forwarding)
 *  - CPU bitmap mode (useSharedTexture deferred)
 *  - 30fps from main via OSR paint event
 *
 * Rendering pipeline:
 *  main: NativeImage.toPNG() → IPC Buffer → Uint8Array
 *  renderer: Blob + createImageBitmap() → canvas.drawImage()
 *  Rationale: img.src with blob:// or data: URLs fails in Electron contextIsolation mode
 *  when the Uint8Array originates from contextBridge. Canvas + ImageBitmap works reliably.
 */
import { createElement, useEffect, useRef } from 'react'
import type { BrowserFrameEvent } from '../../../../shared/browser.js'
import type { CanvasEntity, EntityAdapter } from '../types'

// ── Instance state ────────────────────────────────────────────────────
interface BrowserInstance {
  browserId: number | null
  // Canvas ref for direct frame rendering
  canvasRef: HTMLCanvasElement | null
  // Last raw PNG buffer — used for suspend snapshot
  lastBuffer: Uint8Array | null
  unsubscribe: (() => void) | null
  // Prevents duplicate create() calls during StrictMode double-effect or HMR
  creating: boolean
}

// Registry keyed by entity id
const instances = new Map<string, BrowserInstance>()

export function getBrowserInstance(id: string): BrowserInstance | undefined {
  return instances.get(id)
}

/** Draw a PNG Uint8Array onto a canvas via ImageBitmap (works in Electron contextIsolation). */
async function drawPNGBuffer(canvas: HTMLCanvasElement, buffer: Uint8Array): Promise<void> {
  const ab = new ArrayBuffer(buffer.byteLength)
  new Uint8Array(ab).set(buffer)
  const blob = new Blob([ab], { type: 'image/png' })
  const bitmap = await createImageBitmap(blob)
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
  }
}

// ── BrowserFrame component ─────────────────────────────────────────────
interface BrowserFrameProps {
  entityId: string
  url: string
  width: number
  height: number
}

function BrowserFrame({ entityId, url, width, height }: BrowserFrameProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const hasFrameRef = useRef(false)

  // Register canvas with instance so drawPNGBuffer can target it
  useEffect(() => {
    const instance = instances.get(entityId)
    if (instance) {
      instance.canvasRef = canvasRef.current
      // Replay last frame if available
      if (instance.lastBuffer && canvasRef.current) {
        drawPNGBuffer(canvasRef.current, instance.lastBuffer).catch(console.warn)
        hasFrameRef.current = true
      }
    }
    return () => {
      const inst = instances.get(entityId)
      if (inst) inst.canvasRef = null
    }
  }, [entityId])

  useEffect(() => {
    const existing = instances.get(entityId)

    // Already have a browserId (fully created) — just re-subscribe to frames.
    if (existing && existing.browserId !== null) {
      const unsub = window.api.browser.onFrame((event: BrowserFrameEvent) => {
        if (event.browserId === existing.browserId && existing.canvasRef) {
          existing.lastBuffer = event.buffer
          drawPNGBuffer(existing.canvasRef, event.buffer).catch(console.warn)
        }
      })
      return unsub
    }

    // Already in the middle of create() — guard against StrictMode double-fire.
    if (existing && existing.creating) {
      return undefined
    }

    // New entity — create slot and call browser:create
    const instance: BrowserInstance = {
      browserId: null,
      canvasRef: canvasRef.current,
      lastBuffer: null,
      unsubscribe: null,
      creating: true
    }
    instances.set(entityId, instance)

    window.api.browser.create(url).then((browserId) => {
      if (instances.get(entityId) !== instance) {
        window.api.browser.destroy(browserId)
        return
      }
      instance.browserId = browserId
      instance.creating = false
      console.log(`[BrowserFrame] created entityId=${entityId} browserId=${browserId}`)

      const unsub = window.api.browser.onFrame((event: BrowserFrameEvent) => {
        if (event.browserId === browserId) {
          instance.lastBuffer = event.buffer
          if (instance.canvasRef) {
            drawPNGBuffer(instance.canvasRef, event.buffer).catch(console.warn)
          }
        }
      })
      instance.unsubscribe = unsub
    })

    return () => {
      // Do NOT delete from instances here — cleanup is handled solely by
      // releaseBrowserInstance() on entity discard, so HMR/StrictMode
      // re-mounts can pick up the existing instance.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId])

  return createElement('canvas', {
    ref: canvasRef,
    width,
    height,
    style: {
      width,
      height,
      display: 'block',
      pointerEvents: 'none',
      userSelect: 'none',
      borderRadius: 8
    }
  })
}

// ── Adapter ──────────────────────────────────────────────────────────
export const BrowserAdapter: EntityAdapter<'browser'> = {
  type: 'browser',

  async hydrate(entity) {
    let instance = instances.get(entity.id)
    if (instance) return instance

    instance = { browserId: null, canvasRef: null, lastBuffer: null, unsubscribe: null, creating: true }
    instances.set(entity.id, instance)

    const browserId = await window.api.browser.create(entity.typeProps.url)
    instance.browserId = browserId
    instance.creating = false

    const unsub = window.api.browser.onFrame((event: BrowserFrameEvent) => {
      if (event.browserId === browserId) {
        instance!.lastBuffer = event.buffer
        if (instance!.canvasRef) {
          drawPNGBuffer(instance!.canvasRef, event.buffer).catch(console.warn)
        }
      }
    })
    instance.unsubscribe = unsub

    return instance
  },

  async suspend(instance) {
    const b = instance as BrowserInstance
    if (b.canvasRef) {
      return b.canvasRef.toDataURL('image/png')
    }
    if (b.lastBuffer) {
      // Fallback: draw buffer onto a temp canvas
      const canvas = document.createElement('canvas')
      canvas.width = 1280
      canvas.height = 800
      await drawPNGBuffer(canvas, b.lastBuffer)
      return canvas.toDataURL('image/png')
    }
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQIW2NkAAIAAAoAAv/lxKUAAAAASUVORK5CYII='
  },

  async captureSnapshot(instance) {
    const b = instance as BrowserInstance
    if (b.canvasRef) return b.canvasRef.toDataURL('image/png')
    if (b.lastBuffer) {
      const canvas = document.createElement('canvas')
      canvas.width = 1280
      canvas.height = 800
      await drawPNGBuffer(canvas, b.lastBuffer)
      return canvas.toDataURL('image/png')
    }
    throw new Error('BrowserAdapter.captureSnapshot: no frame received yet')
  },

  render(entity) {
    return createElement(BrowserFrame, {
      entityId: entity.id,
      url: entity.typeProps.url,
      width: entity.size.w,
      height: entity.size.h
    })
  }
}

/** Called when entity is discarded — tear down OSR window + listener */
export async function releaseBrowserInstance(id: string): Promise<void> {
  const instance = instances.get(id)
  if (!instance) return

  instance.unsubscribe?.()
  instance.unsubscribe = null
  instance.canvasRef = null
  instance.lastBuffer = null

  if (instance.browserId !== null) {
    await window.api.browser.destroy(instance.browserId)
    instance.browserId = null
  }

  instances.delete(id)
}

export function isBrowserEntity(entity: CanvasEntity): entity is CanvasEntity<'browser'> {
  return entity.type === 'browser'
}
