import * as electron from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  CodexDesktopApi,
  CodexDesktopEvent,
  SendCodexChatMessageRequest
} from '../shared/codex.js'
import type {
  BrowserApi,
  BrowserCreateRequest,
  BrowserFrameEvent,
  BrowserPresentationMode,
  BrowserStateEvent
} from '../shared/browser.js'

const { contextBridge, ipcRenderer } = electron
type SharedTextureRendererApi = {
  setSharedTextureReceiver: (
    callback: (
      data: {
        importedSharedTexture: {
          getVideoFrame: () => unknown
          release: () => void
        }
      },
      ...args: any[]
    ) => Promise<void> | void
  ) => void
}
const sharedTextureApi = (
  electron as typeof electron & {
    sharedTexture?: SharedTextureRendererApi
  }
).sharedTexture
const browserFrameListeners = new Set<(event: BrowserFrameEvent) => void>()
let sharedTextureReceiverReady = false
const hasSharedTextureApi = typeof sharedTextureApi?.setSharedTextureReceiver === 'function'

function ensureSharedTextureReceiver(): void {
  if (!hasSharedTextureApi || sharedTextureReceiverReady) return

  const api = sharedTextureApi
  if (!api) return

  api.setSharedTextureReceiver(async ({ importedSharedTexture }, payload) => {
    const frame = importedSharedTexture.getVideoFrame()
    importedSharedTexture.release()

    const event: BrowserFrameEvent = {
      ...((payload ?? {}) as Record<string, unknown>),
      kind: 'shared-texture',
      frame
    } as BrowserFrameEvent

    for (const listener of browserFrameListeners) {
      listener(event)
    }
  })

  ipcRenderer.send('browser:shared-texture-ready')
  sharedTextureReceiverReady = true
}

const browserApi: BrowserApi = {
  create: (request: BrowserCreateRequest) => ipcRenderer.invoke('browser:create', request),
  destroy: (browserId: number) => ipcRenderer.invoke('browser:destroy', browserId),
  navigate: (browserId: number, url: string) =>
    ipcRenderer.invoke('browser:navigate', browserId, url),
  resize: (browserId: number, width: number, height: number) =>
    ipcRenderer.invoke('browser:resize', browserId, width, height),
  setPresentationMode: (browserId: number, mode: BrowserPresentationMode) =>
    ipcRenderer.invoke('browser:set-presentation-mode', browserId, mode),
  captureSnapshot: (browserId: number) => ipcRenderer.invoke('browser:capture-snapshot', browserId),
  onFrame: (listener: (event: BrowserFrameEvent) => void) => {
    ensureSharedTextureReceiver()
    browserFrameListeners.add(listener)

    const handler = (_event: Electron.IpcRendererEvent, payload: BrowserFrameEvent) =>
      listener(payload)
    ipcRenderer.on('browser:frame', handler)
    return () => {
      browserFrameListeners.delete(listener)
      ipcRenderer.removeListener('browser:frame', handler)
    }
  },
  onState: (listener: (event: BrowserStateEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: BrowserStateEvent) =>
      listener(payload)
    ipcRenderer.on('browser:state', handler)
    return () => {
      ipcRenderer.removeListener('browser:state', handler)
    }
  }
}

interface EgDeskApi extends CodexDesktopApi {
  browser: BrowserApi
  debug: {
    log: (level: 'log' | 'warn' | 'error', entries: string[]) => void
  }
}

const api: EgDeskApi = {
  browser: browserApi,
  debug: {
    log: (level, entries) => ipcRenderer.send('renderer:log', { level, entries })
  },
  codex: {
    getAuthStatus: () => ipcRenderer.invoke('codex-auth:get-status'),
    startDeviceAuth: () => ipcRenderer.invoke('codex-auth:start-device-auth'),
    signOut: () => ipcRenderer.invoke('codex-auth:sign-out'),
    sendMessage: (request: SendCodexChatMessageRequest) =>
      ipcRenderer.invoke('codex-chat:send-message', request),
    subscribe: (listener: (event: CodexDesktopEvent) => void) => {
      const handleAuth = (_event: Electron.IpcRendererEvent, event: CodexDesktopEvent) =>
        listener(event)
      const handleChat = (_event: Electron.IpcRendererEvent, event: CodexDesktopEvent) =>
        listener(event)

      ipcRenderer.on('codex-auth:event', handleAuth)
      ipcRenderer.on('codex-chat:event', handleChat)

      return () => {
        ipcRenderer.removeListener('codex-auth:event', handleAuth)
        ipcRenderer.removeListener('codex-chat:event', handleChat)
      }
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
