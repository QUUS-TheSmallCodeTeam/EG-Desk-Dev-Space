import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  CodexDesktopApi,
  CodexDesktopEvent,
  SendCodexChatMessageRequest
} from '../shared/codex.js'
import type { BrowserApi, BrowserFrameEvent } from '../shared/browser.js'

const browserApi: BrowserApi = {
  create: (url: string) => ipcRenderer.invoke('browser:create', url),
  destroy: (browserId: number) => ipcRenderer.invoke('browser:destroy', browserId),
  navigate: (browserId: number, url: string) =>
    ipcRenderer.invoke('browser:navigate', browserId, url),
  onFrame: (listener: (event: BrowserFrameEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: BrowserFrameEvent) =>
      listener(payload)
    ipcRenderer.on('browser:frame', handler)
    return () => ipcRenderer.removeListener('browser:frame', handler)
  }
}

interface EgDeskApi extends CodexDesktopApi {
  browser: BrowserApi
}

const api: EgDeskApi = {
  browser: browserApi,
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
