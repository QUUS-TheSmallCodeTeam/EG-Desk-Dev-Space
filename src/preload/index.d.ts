import { ElectronAPI } from '@electron-toolkit/preload'
import type { CodexDesktopApi } from '../shared/codex.js'
import type { BrowserApi } from '../shared/browser.js'

interface EgDeskApi extends CodexDesktopApi {
  browser: BrowserApi
  debug: {
    log: (level: 'log' | 'warn' | 'error', entries: string[]) => void
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: EgDeskApi
  }
}

export {}
