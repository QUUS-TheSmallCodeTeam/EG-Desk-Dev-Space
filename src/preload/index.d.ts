import { ElectronAPI } from '@electron-toolkit/preload'
import type { CodexDesktopApi } from '../shared/codex.js'
import type { BrowserApi } from '../shared/browser.js'

interface EgDeskApi extends CodexDesktopApi {
  browser: BrowserApi
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: EgDeskApi
  }
}

export {}
