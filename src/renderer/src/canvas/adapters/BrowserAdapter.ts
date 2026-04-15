/**
 * BrowserAdapter - OSR-based embedded browser.
 *
 * Preferred pipeline:
 *   main: offscreen BrowserWindow(useSharedTexture=true)
 *   preload: sharedTexture receiver -> VideoFrame
 *   renderer: draw VideoFrame directly to <canvas>
 *
 * Fallback pipeline:
 *   main: NativeImage.toPNG() -> IPC Uint8Array
 *   renderer: Blob + createImageBitmap() -> canvas.drawImage()
 */
import { createElement, useEffect, useRef, useState } from 'react'
import type {
  BrowserCreateRequest,
  BrowserFrameEvent,
  BrowserPresentationMode,
  BrowserStateEvent
} from '../../../../shared/browser.js'
import type { CanvasEntity, EntityAdapter } from '../types'
import { useCanvasStore } from '../store'

interface BrowserInstance {
  browserId: number | null
  canvasRef: HTMLCanvasElement | null
  lastBuffer: Uint8Array | null
  lastWidth: number
  lastHeight: number
  currentUrl: string
  presentationMode: BrowserPresentationMode
  ownsRuntime: boolean
  unsubscribe: (() => void) | null
  creating: boolean
  pendingFrame: BrowserFrameEvent | null
  drawScheduled: number | null
  drawing: boolean
}

const instances = new Map<string, BrowserInstance>()

function createBrowserInstance(): BrowserInstance {
  return {
    browserId: null,
    canvasRef: null,
    lastBuffer: null,
    lastWidth: 1280,
    lastHeight: 800,
    currentUrl: 'about:blank',
    presentationMode: 'canvas',
    ownsRuntime: false,
    unsubscribe: null,
    creating: false,
    pendingFrame: null,
    drawScheduled: null,
    drawing: false
  }
}

export function getBrowserInstance(id: string): BrowserInstance | undefined {
  return instances.get(id)
}

function isVideoFrame(frame: unknown): frame is VideoFrame {
  return typeof VideoFrame !== 'undefined' && frame instanceof VideoFrame
}

function closeVideoFrame(frame: unknown): void {
  if (
    typeof frame === 'object' &&
    frame !== null &&
    'close' in frame &&
    typeof (frame as { close: unknown }).close === 'function'
  ) {
    ;(frame as { close: () => void }).close()
  }
}

function updateCanvasSize(canvas: HTMLCanvasElement, width: number, height: number): void {
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
}

function get2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  return canvas.getContext('2d', {
    alpha: false,
    desynchronized: true
  } as CanvasRenderingContext2DSettings)
}

async function drawBitmapFrame(canvas: HTMLCanvasElement, event: BrowserFrameEvent): Promise<void> {
  if (event.kind !== 'bitmap') return

  updateCanvasSize(canvas, event.width, event.height)

  const ab = new ArrayBuffer(event.buffer.byteLength)
  new Uint8Array(ab).set(event.buffer)
  const blob = new Blob([ab], { type: 'image/png' })
  const bitmap = await createImageBitmap(blob)

  try {
    const ctx = get2dContext(canvas)
    if (!ctx) return
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  } finally {
    bitmap.close()
  }
}

function drawSharedTextureFrame(canvas: HTMLCanvasElement, event: BrowserFrameEvent): void {
  if (event.kind !== 'shared-texture') return
  if (!isVideoFrame(event.frame)) {
    closeVideoFrame(event.frame)
    return
  }

  updateCanvasSize(canvas, event.width, event.height)

  const ctx = get2dContext(canvas)
  if (!ctx) {
    event.frame.close()
    return
  }

  try {
    ctx.drawImage(event.frame as unknown as CanvasImageSource, 0, 0, canvas.width, canvas.height)
  } finally {
    event.frame.close()
  }
}

async function drawFrame(instance: BrowserInstance, event: BrowserFrameEvent): Promise<void> {
  const canvas = instance.canvasRef
  if (!canvas) {
    if (event.kind === 'shared-texture') {
      closeVideoFrame(event.frame)
    }
    return
  }

  instance.lastWidth = event.width
  instance.lastHeight = event.height

  if (event.kind === 'shared-texture') {
    drawSharedTextureFrame(canvas, event)
    return
  }

  instance.lastBuffer = event.buffer
  await drawBitmapFrame(canvas, event)
}

function scheduleNextDraw(instance: BrowserInstance): void {
  if (instance.drawScheduled !== null || instance.drawing) return

  instance.drawScheduled = window.requestAnimationFrame(() => {
    instance.drawScheduled = null

    const event = instance.pendingFrame
    instance.pendingFrame = null
    if (!event) return

    instance.drawing = true
    void drawFrame(instance, event)
      .catch((error) => {
        console.warn('[BrowserAdapter] failed to draw frame', error)
        if (event.kind === 'shared-texture') {
          closeVideoFrame(event.frame)
        }
      })
      .finally(() => {
        instance.drawing = false
        if (instance.pendingFrame) {
          scheduleNextDraw(instance)
        }
      })
  })
}

function queueFrame(instance: BrowserInstance, event: BrowserFrameEvent): void {
  const previousPending = instance.pendingFrame
  if (previousPending?.kind === 'shared-texture') {
    closeVideoFrame(previousPending.frame)
  }

  instance.pendingFrame = event
  scheduleNextDraw(instance)
}

function attachFrameSubscription(instance: BrowserInstance, browserId: number): void {
  if (instance.unsubscribe) return

  instance.unsubscribe = window.api.browser.onFrame((event: BrowserFrameEvent) => {
    if (event.browserId !== browserId) return
    queueFrame(instance, event)
  })
}

async function ensureBrowserInstance(
  entityId: string,
  url: string,
  width: number,
  height: number
): Promise<BrowserInstance> {
  let instance = instances.get(entityId)
  if (!instance) {
    instance = createBrowserInstance()
    instances.set(entityId, instance)
  }

  if (instance.browserId !== null) {
    attachFrameSubscription(instance, instance.browserId)
    if (instance.ownsRuntime) {
      void window.api.browser.resize(instance.browserId, width, height)
    }
    if (instance.ownsRuntime && url !== instance.currentUrl) {
      instance.currentUrl = url
      void window.api.browser.navigate(instance.browserId, url)
    }
    return instance
  }

  if (instance.creating) return instance

  instance.creating = true
  try {
    const request: BrowserCreateRequest = { url, width, height }
    const browserId = await window.api.browser.create(request)

    if (instances.get(entityId) !== instance) {
      await window.api.browser.destroy(browserId)
      return createBrowserInstance()
    }

    instance.browserId = browserId
    instance.currentUrl = url
    instance.presentationMode = 'canvas'
    instance.ownsRuntime = true
    attachFrameSubscription(instance, browserId)
    console.log(`[BrowserAdapter] created entityId=${entityId} browserId=${browserId}`)
    return instance
  } finally {
    instance.creating = false
  }
}

interface BrowserFrameProps {
  entity: CanvasEntity<'browser'>
  width: number
  height: number
}

function BrowserFrame({ entity, width, height }: BrowserFrameProps): JSX.Element {
  const { dispatch } = useCanvasStore()
  const entityId = entity.id
  const url = entity.typeProps.url
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [browserId, setBrowserId] = useState<number | null>(null)
  const [presentationMode, setPresentationModeState] = useState<BrowserPresentationMode>('canvas')
  const entityRef = useRef(entity)

  entityRef.current = entity

  useEffect(() => {
    const instance = instances.get(entityId)
    if (instance) {
      instance.canvasRef = canvasRef.current
      setBrowserId(instance.browserId)
      setPresentationModeState(instance.presentationMode)
      if (canvasRef.current) {
        updateCanvasSize(canvasRef.current, width, height)
      }
      if (instance.lastBuffer && canvasRef.current) {
        void drawBitmapFrame(canvasRef.current, {
          browserId: instance.browserId ?? -1,
          kind: 'bitmap',
          buffer: instance.lastBuffer,
          width: instance.lastWidth,
          height: instance.lastHeight
        }).catch(console.warn)
      }
    }

    return () => {
      const current = instances.get(entityId)
      if (current) {
        current.canvasRef = null
      }
    }
  }, [entityId, width, height])

  useEffect(() => {
    void ensureBrowserInstance(entityId, url, width, height).then((instance) => {
      instance.canvasRef = canvasRef.current
      setBrowserId(instance.browserId)
      setPresentationModeState(instance.presentationMode)
      if (instance.browserId !== null && entityRef.current.typeProps.browserId !== instance.browserId) {
        dispatch({
          type: 'UPDATE_ENTITY',
          id: entityId,
          patch: {
            typeProps: {
              ...entityRef.current.typeProps,
              browserId: instance.browserId
            } as CanvasEntity<'browser'>['typeProps']
          }
        })
      }
      if (canvasRef.current) {
        updateCanvasSize(canvasRef.current, width, height)
      }
    })
    // Browser lifecycle is owned by releaseBrowserInstance on discard.
  }, [dispatch, entityId, url, width, height])

  useEffect(() => {
    if (browserId === null) {
      return
    }

    return window.api.browser.onState((event: BrowserStateEvent) => {
      if (event.browserId !== browserId) {
        return
      }

      const instance = instances.get(entityId)
      if (instance) {
        instance.currentUrl = event.url
        instance.presentationMode = event.mode
      }

      setPresentationModeState(event.mode)

      const currentTypeProps = entityRef.current.typeProps
      const nextTitle = event.title ?? undefined
      if (
        currentTypeProps.url !== event.url ||
        currentTypeProps.title !== nextTitle ||
        currentTypeProps.browserId !== browserId
      ) {
        dispatch({
          type: 'UPDATE_ENTITY',
          id: entityId,
          patch: {
            typeProps: {
              ...currentTypeProps,
              url: event.url,
              title: nextTitle,
              browserId
            } as CanvasEntity<'browser'>['typeProps']
          }
        })
      }
    })
  }, [browserId, dispatch, entityId])

  useEffect(() => {
    if (browserId === null) {
      return
    }

    void window.api.browser.resize(browserId, width, height)
  }, [browserId, height, width])

  useEffect(() => {
    return () => {
      if (browserId !== null && presentationMode === 'window') {
        void window.api.browser.setPresentationMode(browserId, 'canvas')
      }
    }
  }, [browserId, presentationMode])

  const handlePresentationToggle = (): void => {
    if (browserId === null) return
    const nextMode: BrowserPresentationMode = presentationMode === 'canvas' ? 'window' : 'canvas'
    void window.api.browser.setPresentationMode(browserId, nextMode)
  }

  return createElement(
    'div',
    {
      style: {
        position: 'relative',
        width,
        height
      }
    },
    createElement('canvas', {
      ref: canvasRef,
      width,
      height,
      style: {
        width,
        height,
        display: 'block',
        pointerEvents: 'none',
        userSelect: 'none',
        borderRadius: 12,
        background: '#ffffff',
        border: '1px solid rgba(212, 208, 202, 0.9)',
        boxShadow: '0 16px 40px rgba(0, 0, 0, 0.08)'
      }
    }),
    createElement(
      'button',
      {
        type: 'button',
        onClick: handlePresentationToggle,
        disabled: browserId === null,
        style: {
          position: 'absolute',
          top: 12,
          right: 12,
          zIndex: 2,
          padding: '6px 10px',
          borderRadius: 999,
          border: '1px solid rgba(212, 208, 202, 0.9)',
          background: 'rgba(255, 255, 255, 0.92)',
          color: '#1a1a1a',
          fontSize: 12,
          fontWeight: 600,
          boxShadow: '0 6px 18px rgba(0, 0, 0, 0.08)',
          cursor: browserId === null ? 'not-allowed' : 'pointer'
        }
      },
      presentationMode === 'window' ? 'Hide active browser' : 'Show active browser'
    )
  )
}

export const BrowserAdapter: EntityAdapter<'browser'> = {
  type: 'browser',

  async hydrate(entity) {
    return ensureBrowserInstance(entity.id, entity.typeProps.url, entity.size.w, entity.size.h)
  },

  async suspend(instance) {
    const browser = instance as BrowserInstance
    if (browser.browserId !== null) {
      try {
        return await window.api.browser.captureSnapshot(browser.browserId)
      } catch (error) {
        console.warn('[BrowserAdapter] live snapshot capture failed during suspend', error)
      }
    }
    if (browser.canvasRef) {
      return browser.canvasRef.toDataURL('image/png')
    }
    if (browser.lastBuffer) {
      const canvas = document.createElement('canvas')
      updateCanvasSize(canvas, browser.lastWidth, browser.lastHeight)
      await drawBitmapFrame(canvas, {
        browserId: browser.browserId ?? -1,
        kind: 'bitmap',
        buffer: browser.lastBuffer,
        width: browser.lastWidth,
        height: browser.lastHeight
      })
      return canvas.toDataURL('image/png')
    }
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQIW2NkAAIAAAoAAv/lxKUAAAAASUVORK5CYII='
  },

  async captureSnapshot(instance) {
    const browser = instance as BrowserInstance
    if (browser.browserId !== null) {
      try {
        return await window.api.browser.captureSnapshot(browser.browserId)
      } catch (error) {
        console.warn('[BrowserAdapter] live snapshot capture failed', error)
      }
    }
    if (browser.canvasRef) return browser.canvasRef.toDataURL('image/png')
    if (browser.lastBuffer) {
      const canvas = document.createElement('canvas')
      updateCanvasSize(canvas, browser.lastWidth, browser.lastHeight)
      await drawBitmapFrame(canvas, {
        browserId: browser.browserId ?? -1,
        kind: 'bitmap',
        buffer: browser.lastBuffer,
        width: browser.lastWidth,
        height: browser.lastHeight
      })
      return canvas.toDataURL('image/png')
    }
    throw new Error('BrowserAdapter.captureSnapshot: no frame received yet')
  },

  render(entity) {
    return createElement(BrowserFrame, {
      entity,
      width: entity.size.w,
      height: entity.size.h
    })
  }
}

export async function releaseBrowserInstance(id: string): Promise<void> {
  const instance = instances.get(id)
  if (!instance) return

  instance.unsubscribe?.()
  instance.unsubscribe = null

  if (instance.drawScheduled !== null) {
    window.cancelAnimationFrame(instance.drawScheduled)
    instance.drawScheduled = null
  }

  if (instance.pendingFrame?.kind === 'shared-texture') {
    closeVideoFrame(instance.pendingFrame.frame)
  }
  instance.pendingFrame = null
  instance.canvasRef = null
  instance.lastBuffer = null

  if (instance.browserId !== null && instance.ownsRuntime) {
    await window.api.browser.destroy(instance.browserId)
  }
  instance.browserId = null

  instances.delete(id)
}

export function isBrowserEntity(entity: CanvasEntity): entity is CanvasEntity<'browser'> {
  return entity.type === 'browser'
}
