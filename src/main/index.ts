import * as electron from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import type {
  CodexAuthStatus,
  CodexChatMessage,
  SendCodexChatMessageRequest,
  SendCodexChatMessageResult
} from '../shared/codex.js'
import type {
  BrowserBitmapFrameEvent,
  BrowserCreateRequest,
  BrowserPresentationMode
} from '../shared/browser.js'

const { app, shell, BrowserWindow, ipcMain, screen } = electron
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
type SharedTextureMainApi = {
  importSharedTexture: (options: {
    textureInfo: Electron.TextureInfo
    allReferencesReleased?: () => void
  }) => {
    release: () => void
  }
  sendSharedTexture: (
    options: {
      frame: Electron.WebFrameMain
      importedSharedTexture: {
        release: () => void
      }
    },
    ...args: any[]
  ) => Promise<void>
}
const sharedTextureApi = (
  electron as typeof electron & {
    sharedTexture?: SharedTextureMainApi
  }
).sharedTexture
const hasSharedTextureApi =
  typeof sharedTextureApi?.importSharedTexture === 'function' &&
  typeof sharedTextureApi?.sendSharedTexture === 'function'

type OffscreenPaintEvent = Electron.Event & {
  texture?: Electron.OffscreenSharedTexture
}

// Enable Chrome DevTools Protocol for playwright MCP attach (renderer CDP on :9222)
app.commandLine.appendSwitch('remote-debugging-port', '9222')

// ── OSR Browser Windows (POC) ────────────────────────────────────────
// Map from browserId (webContents.id) to the hidden OSR BrowserWindow.
const BROWSER_PARTITION = 'persist:egdesk-browser'

interface BrowserSnapshot {
  url: string
  scrollX: number
  scrollY: number
}

interface BrowserRuntime {
  browserId: number
  mode: BrowserPresentationMode
  title: string | null
  snapshot: BrowserSnapshot
  canvasSize: { width: number; height: number }
  osrWindow: Electron.BrowserWindow | null
  promotedWindow: Electron.BrowserWindow | null
  closingPromotedWindow: boolean
}

const browserRuntimes = new Map<number, BrowserRuntime>()
const sharedTextureReadyWebContentsIds = new Set<number>()
let nextBrowserId = 1

function emitBrowserState(runtime: BrowserRuntime, mainWindow: Electron.BrowserWindow): void {
  const payload = {
    browserId: runtime.browserId,
    url: runtime.snapshot.url,
    title: runtime.title,
    mode: runtime.mode
  }

  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('browser:state', payload)
  }
}

function getActiveBrowserWindow(runtime: BrowserRuntime): Electron.BrowserWindow | null {
  const candidate = runtime.mode === 'window' ? runtime.promotedWindow : runtime.osrWindow
  if (!candidate || candidate.isDestroyed()) {
    return null
  }
  return candidate
}

async function captureBrowserSnapshot(
  webContents: Electron.WebContents
): Promise<BrowserSnapshot> {
  const fallback: BrowserSnapshot = {
    url: webContents.getURL() || 'about:blank',
    scrollX: 0,
    scrollY: 0
  }

  if (webContents.isDestroyed()) {
    return fallback
  }

  try {
    const result = await webContents.executeJavaScript(
      `(() => ({
        url: location.href,
        scrollX: Math.round(window.scrollX || 0),
        scrollY: Math.round(window.scrollY || 0)
      }))()`,
      true
    )

    if (!result || typeof result !== 'object') {
      return fallback
    }

    const snapshot = result as Partial<BrowserSnapshot>
    return {
      url: typeof snapshot.url === 'string' ? snapshot.url : fallback.url,
      scrollX: typeof snapshot.scrollX === 'number' ? snapshot.scrollX : 0,
      scrollY: typeof snapshot.scrollY === 'number' ? snapshot.scrollY : 0
    }
  } catch {
    return fallback
  }
}

async function loadBrowserSnapshot(
  webContents: Electron.WebContents,
  snapshot: BrowserSnapshot
): Promise<void> {
  if (webContents.isDestroyed()) {
    return
  }

  await webContents.loadURL(snapshot.url || 'about:blank')

  if (webContents.isDestroyed()) {
    return
  }

  try {
    await webContents.executeJavaScript(
      `window.scrollTo(${Math.round(snapshot.scrollX)}, ${Math.round(snapshot.scrollY)});`,
      true
    )
  } catch (error) {
    console.warn('[Browser] failed to restore scroll position', error)
  }
}

function attachTrackedWebContents(
  runtime: BrowserRuntime,
  webContents: Electron.WebContents,
  mainWindow: Electron.BrowserWindow
): void {
  const syncState = (): void => {
    if (webContents.isDestroyed()) {
      return
    }

    runtime.snapshot = {
      ...runtime.snapshot,
      url: webContents.getURL() || runtime.snapshot.url
    }
    runtime.title = webContents.getTitle() || runtime.title
    emitBrowserState(runtime, mainWindow)
  }

  webContents.on('did-navigate', syncState)
  webContents.on('did-navigate-in-page', syncState)
  webContents.on('did-finish-load', syncState)
  webContents.on('page-title-updated', (_event, title) => {
    runtime.title = title || runtime.title
    emitBrowserState(runtime, mainWindow)
  })
}

function getFrameConsumerWindows(
  mainWindow: Electron.BrowserWindow
): Electron.BrowserWindow[] {
  const targets: Electron.BrowserWindow[] = []

  if (!mainWindow.isDestroyed()) {
    targets.push(mainWindow)
  }

  return targets
}

async function sendFrameToConsumers(
  runtime: BrowserRuntime,
  mainWindow: Electron.BrowserWindow,
  event: OffscreenPaintEvent,
  image: Electron.NativeImage,
  width: number,
  height: number,
  frameCount: number | undefined,
  timestamp: number | undefined
): Promise<boolean> {
  const targets = getFrameConsumerWindows(mainWindow)
  const readySharedTargets =
    hasSharedTextureApi && event.texture
      ? targets.filter((target) => sharedTextureReadyWebContentsIds.has(target.webContents.id))
      : []

  if (hasSharedTextureApi && event.texture && readySharedTargets.length > 0) {
    const api = sharedTextureApi
    if (!api) {
      throw new Error('sharedTexture API not available at runtime')
    }

    const importedSharedTexture = api.importSharedTexture({
      textureInfo: event.texture.textureInfo,
      allReferencesReleased: () => {
        event.texture?.release()
      }
    })

    try {
      await Promise.all(
        readySharedTargets.map((target) =>
          api.sendSharedTexture(
            {
              frame: target.webContents.mainFrame,
              importedSharedTexture
            },
            {
              browserId: runtime.browserId,
              width,
              height,
              frameCount,
              timestamp,
              pixelFormat: event.texture?.textureInfo.pixelFormat
            }
          )
        )
      )
      return true
    } finally {
      importedSharedTexture.release()
    }
  }

  event.texture?.release()

  if (image.isEmpty()) {
    return false
  }

  const payload: BrowserBitmapFrameEvent = {
    browserId: runtime.browserId,
    kind: 'bitmap',
    buffer: image.toPNG(),
    width,
    height,
    frameCount,
    timestamp
  }

  for (const target of targets) {
    target.webContents.send('browser:frame', payload)
  }

  return true
}

function createCanvasPresentation(
  runtime: BrowserRuntime,
  mainWindow: Electron.BrowserWindow
): void {
  const osr = new BrowserWindow({
    width: runtime.canvasSize.width,
    height: runtime.canvasSize.height,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      partition: BROWSER_PARTITION,
      offscreen: hasSharedTextureApi
        ? {
            useSharedTexture: true
          }
        : true,
      backgroundThrottling: false,
      contextIsolation: true,
      sandbox: false
    }
  })

  runtime.mode = 'canvas'
  runtime.osrWindow = osr

  osr.webContents.setFrameRate(60)
  osr.webContents.startPainting()

  attachTrackedWebContents(runtime, osr.webContents, mainWindow)

  osr.on('closed', () => {
    if (runtime.osrWindow === osr) {
      runtime.osrWindow = null
    }
  })

  osr.webContents.on('did-finish-load', () => {
    osr.webContents.invalidate()
  })

  let sharedTextureTransferInFlight = false

  osr.webContents.on('paint', async (event, _dirty, image) => {
    const textureInfo = event.texture?.textureInfo
    const width = textureInfo?.visibleRect.width ?? textureInfo?.codedSize.width ?? image.getSize().width
    const height =
      textureInfo?.visibleRect.height ?? textureInfo?.codedSize.height ?? image.getSize().height

    if (!event.texture && image.isEmpty()) {
      return
    }
    const frameCount =
      typeof event.texture?.textureInfo.metadata?.frameCount === 'number'
        ? event.texture.textureInfo.metadata.frameCount
        : undefined
    const timestamp = event.texture?.textureInfo.timestamp

    if (!sharedTextureTransferInFlight) {
      sharedTextureTransferInFlight = true
      try {
        const delivered = await sendFrameToConsumers(
          runtime,
          mainWindow,
          event,
          image,
          width,
          height,
          frameCount,
          timestamp
        )
        if (delivered) {
          return
        }
      } catch (error) {
        console.warn(
          `[OSR] frame transfer failed for browserId=${runtime.browserId}`,
          error
        )
      } finally {
        sharedTextureTransferInFlight = false
      }
    }
  })

  osr.webContents.on('did-fail-load', (_e, errorCode, errorDescription, url) => {
    console.error(
      `[OSR] did-fail-load browserId=${runtime.browserId} code=${errorCode} desc=${errorDescription} url=${url}`
    )
  })

  void loadBrowserSnapshot(osr.webContents, runtime.snapshot).catch((error) => {
    console.error(`[Browser] failed to load canvas presentation browserId=${runtime.browserId}`, error)
  })
}

function destroyCanvasPresentation(runtime: BrowserRuntime): void {
  const osr = runtime.osrWindow
  runtime.osrWindow = null

  if (osr && !osr.isDestroyed()) {
    osr.close()
  }
}

function destroyWindowPresentation(runtime: BrowserRuntime): void {
  const promoted = runtime.promotedWindow
  runtime.promotedWindow = null

  if (promoted && !promoted.isDestroyed()) {
    runtime.closingPromotedWindow = true
    promoted.close()
  }
}

function createWindowPresentation(
  runtime: BrowserRuntime,
  mainWindow: Electron.BrowserWindow
): void {
  const [mainX, mainY] = mainWindow.getPosition()
  const [mainWidth, mainHeight] = mainWindow.getSize()
  const bounds = {
    x: mainX + Math.max(24, Math.round((mainWidth - runtime.canvasSize.width) / 2)),
    y: mainY + Math.max(48, Math.round((mainHeight - runtime.canvasSize.height) / 2)),
    width: runtime.canvasSize.width,
    height: runtime.canvasSize.height
  }

  const promoted = new BrowserWindow({
    ...bounds,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: BROWSER_PARTITION,
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false
    }
  })

  runtime.mode = 'window'
  runtime.promotedWindow = promoted

  attachTrackedWebContents(runtime, promoted.webContents, mainWindow)

  promoted.on('close', (event) => {
    if (runtime.closingPromotedWindow || !browserRuntimes.has(runtime.browserId)) {
      return
    }

    event.preventDefault()
    void setBrowserPresentationMode(runtime.browserId, 'canvas', mainWindow)
  })

  promoted.on('closed', () => {
    if (runtime.promotedWindow === promoted) {
      runtime.promotedWindow = null
    }
    runtime.closingPromotedWindow = false
  })

  void loadBrowserSnapshot(promoted.webContents, runtime.snapshot)
    .then(() => {
      if (promoted.isDestroyed()) {
        return
      }
      promoted.show()
      promoted.focus()
      emitBrowserState(runtime, mainWindow)
    })
    .catch((error) => {
      console.error(`[Browser] failed to load window presentation browserId=${runtime.browserId}`, error)
    })
}

function createBrowserRuntime(
  request: BrowserCreateRequest,
  mainWindow: Electron.BrowserWindow
): number {
  const browserId = nextBrowserId
  nextBrowserId += 1

  const runtime: BrowserRuntime = {
    browserId,
    mode: 'canvas',
    title: null,
    snapshot: {
      url: request.url,
      scrollX: 0,
      scrollY: 0
    },
    canvasSize: {
      width: Math.max(1, Math.round(request.width)),
      height: Math.max(1, Math.round(request.height))
    },
    osrWindow: null,
    promotedWindow: null,
    closingPromotedWindow: false
  }

  browserRuntimes.set(browserId, runtime)
  createCanvasPresentation(runtime, mainWindow)
  emitBrowserState(runtime, mainWindow)
  return browserId
}

function destroyBrowserRuntime(browserId: number): void {
  const runtime = browserRuntimes.get(browserId)
  if (!runtime) {
    return
  }

  browserRuntimes.delete(browserId)
  destroyWindowPresentation(runtime)
  destroyCanvasPresentation(runtime)
}

async function resizeBrowserRuntime(
  browserId: number,
  width: number,
  height: number
): Promise<void> {
  const runtime = browserRuntimes.get(browserId)
  if (!runtime) {
    return
  }

  runtime.canvasSize = {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height))
  }

  if (runtime.osrWindow && !runtime.osrWindow.isDestroyed()) {
    runtime.osrWindow.setContentSize(runtime.canvasSize.width, runtime.canvasSize.height)
    runtime.osrWindow.webContents.invalidate()
  }
}

async function setBrowserPresentationMode(
  browserId: number,
  mode: BrowserPresentationMode,
  mainWindow: Electron.BrowserWindow
): Promise<void> {
  const runtime = browserRuntimes.get(browserId)
  if (!runtime) {
    return
  }

  if (runtime.mode === mode) {
    if (mode === 'window' && runtime.promotedWindow && !runtime.promotedWindow.isDestroyed()) {
      runtime.promotedWindow.show()
      runtime.promotedWindow.focus()
    }
    return
  }

  const currentWindow = getActiveBrowserWindow(runtime)
  if (currentWindow) {
    runtime.snapshot = await captureBrowserSnapshot(currentWindow.webContents)
    runtime.title = currentWindow.webContents.getTitle() || runtime.title
  }

  if (mode === 'window') {
    destroyCanvasPresentation(runtime)
    createWindowPresentation(runtime, mainWindow)
  } else {
    destroyWindowPresentation(runtime)
    createCanvasPresentation(runtime, mainWindow)
  }

  runtime.mode = mode
  emitBrowserState(runtime, mainWindow)
}

let loginProcess: ReturnType<typeof spawn> | null = null

function createMessageId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

async function readCodexAuthStatus(): Promise<CodexAuthStatus> {
  const authPath = join(app.getPath('home'), '.codex', 'auth.json')

  try {
    const raw = await readFile(authPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>

    return {
      isLoggedIn: typeof parsed['auth_mode'] === 'string',
      authMode: typeof parsed['auth_mode'] === 'string' ? (parsed['auth_mode'] as string) : null,
      accountId:
        typeof parsed['account_id'] === 'string' ? (parsed['account_id'] as string) : null,
      accountEmail:
        typeof parsed['account_email'] === 'string'
          ? (parsed['account_email'] as string)
          : typeof parsed['email'] === 'string'
            ? (parsed['email'] as string)
            : null,
      lastRefresh:
        typeof parsed['last_refresh'] === 'number' ? (parsed['last_refresh'] as number) : null,
      source: 'auth-json',
      statusText:
        typeof parsed['auth_mode'] === 'string'
          ? `Logged in using ${parsed['auth_mode'] as string}`
          : 'Login required'
    }
  } catch {
    return {
      isLoggedIn: false,
      authMode: null,
      accountId: null,
      accountEmail: null,
      lastRefresh: null,
      source: 'none',
      statusText: 'Login required'
    }
  }
}

function runCodexCommand(
  args: string[],
  onChunk?: (chunk: string) => void
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout += text
      onChunk?.(text)
    })

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      onChunk?.(text)
    })

    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

function extractChunkLines(buffer: string): { lines: string[]; remainder: string } {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n')
  const remainder = parts.pop() ?? ''
  return { lines: parts, remainder }
}

async function startCodexChatExecution(
  event: Electron.IpcMainInvokeEvent,
  request: SendCodexChatMessageRequest
): Promise<SendCodexChatMessageResult> {
  const authStatus = await readCodexAuthStatus()
  const fallbackConversationId = request.conversationId ?? createMessageId('conversation')

  if (!authStatus.isLoggedIn) {
    const messageId = createMessageId('assistant')
    event.sender.send('codex-chat:event', {
      type: 'assistant-start',
      conversationId: fallbackConversationId,
      message: {
        id: messageId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        createdAt: Date.now()
      } satisfies CodexChatMessage
    })
    event.sender.send('codex-chat:event', {
      type: 'assistant-error',
      conversationId: fallbackConversationId,
      messageId,
      error: 'Codex login is required before sending messages.'
    })

    return {
      accepted: false,
      conversationId: fallbackConversationId,
      error: 'Codex login is required before sending messages.'
    }
  }

  return new Promise((resolve) => {
    const messageId = createMessageId('assistant')
    const args = request.conversationId
      ? ['exec', 'resume', '--json', request.conversationId, request.message]
      : ['exec', '--json', request.message]

    const child = spawn('codex', args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let conversationId = request.conversationId ?? ''
    let stdoutBuffer = ''
    let stderrText = ''
    let resolved = false
    let started = false
    let sawAgentMessage = false
    let pendingItemError: string | null = null

    const ensureStarted = (): void => {
      if (started) return
      if (!conversationId) return
      started = true
      event.sender.send('codex-chat:event', {
        type: 'assistant-start',
        conversationId,
        message: {
          id: messageId,
          role: 'assistant',
          content: '',
          status: 'streaming',
          createdAt: Date.now()
        } satisfies CodexChatMessage
      })
      if (!resolved) {
        resolved = true
        resolve({ accepted: true, conversationId })
      }
    }

    if (conversationId) {
      ensureStarted()
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString()
      const { lines, remainder } = extractChunkLines(stdoutBuffer)
      stdoutBuffer = remainder

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line.startsWith('{')) continue

        try {
          const parsed = JSON.parse(line) as Record<string, unknown>
          const type = parsed['type']

          if (type === 'thread.started' && typeof parsed['thread_id'] === 'string') {
            conversationId = parsed['thread_id'] as string
            ensureStarted()
            continue
          }

          if (type === 'item.completed' && parsed['item'] && typeof parsed['item'] === 'object') {
            const item = parsed['item'] as Record<string, unknown>
            if (item['type'] === 'agent_message' && typeof item['text'] === 'string') {
              ensureStarted()
              sawAgentMessage = true
              event.sender.send('codex-chat:event', {
                type: 'assistant-delta',
                conversationId: conversationId || fallbackConversationId,
                messageId,
                delta: item['text'] as string
              })
              event.sender.send('codex-chat:event', {
                type: 'assistant-complete',
                conversationId: conversationId || fallbackConversationId,
                messageId
              })
              continue
            }

            if (item['type'] === 'error' && typeof item['message'] === 'string') {
              const message = item['message'] as string
              if (!message.includes('[features].collab')) {
                pendingItemError = message
              }
            }
          }
        } catch {
          // Ignore non-JSON/non-event stdout fragments.
        }
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString()
    })

    child.on('error', (error) => {
      const finalConversationId = conversationId || fallbackConversationId
      ensureStarted()
      event.sender.send('codex-chat:event', {
        type: 'assistant-error',
        conversationId: finalConversationId,
        messageId,
        error: `Failed to start Codex chat execution: ${error.message}`
      })
      if (!resolved) {
        resolved = true
        resolve({
          accepted: false,
          conversationId: finalConversationId,
          error: error.message
        })
      }
    })

    child.on('close', (code) => {
      const finalConversationId = conversationId || fallbackConversationId
      if (!resolved) {
        resolved = true
        resolve({
          accepted: code === 0,
          conversationId: finalConversationId,
          error:
            code === 0
              ? undefined
              : (pendingItemError ?? stderrText.trim()) || 'Codex chat failed'
        })
      }

      if (!sawAgentMessage) {
        ensureStarted()
        event.sender.send('codex-chat:event', {
          type: 'assistant-error',
          conversationId: finalConversationId,
          messageId,
          error:
            (pendingItemError ?? stderrText.trim()) || 'Codex did not return a chat response.'
        })
      }
    })
  })
}

function createWindow(): Electron.BrowserWindow {
  // macOS 메뉴바/OS Dock 제외한 실제 사용 가능 영역 (Task #16)
  const workArea = screen.getPrimaryDisplay().workAreaSize

  const mainWindow = new BrowserWindow({
    width: Math.min(1440, workArea.width),
    height: Math.min(900, workArea.height),
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    // LIGHT mode only — warm off-white surface per DESIGN_SYSTEM_SPEC.md §2
    backgroundColor: '#F5F3EF',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[renderer console:${level}] ${sourceId}:${line} ${message}`)
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer gone]', details)
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(
      `[renderer did-fail-load] code=${errorCode} desc=${errorDescription} url=${validatedURL}`
    )
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']

  if (!app.isPackaged && rendererUrl) {
    mainWindow.loadURL(rendererUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  return mainWindow
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.egdesk')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('ping', () => console.log('pong'))
  ipcMain.on('renderer:log', (_event, payload: { level?: string; entries?: string[] }) => {
    const level = payload.level === 'warn' || payload.level === 'error' ? payload.level : 'log'
    const entries = Array.isArray(payload.entries) ? payload.entries : []
    const line = entries.join(' | ')
    if (level === 'error') {
      console.error(`[renderer forwarded:error] ${line}`)
    } else if (level === 'warn') {
      console.warn(`[renderer forwarded:warn] ${line}`)
    } else {
      console.log(`[renderer forwarded:log] ${line}`)
    }
  })
  ipcMain.on('browser:shared-texture-ready', (event) => {
    sharedTextureReadyWebContentsIds.add(event.sender.id)
  })

  const mainWindow = createWindow()

  // ── OSR Browser IPC handlers ────────────────────────────────────────
  ipcMain.handle('browser:create', async (_event, request: BrowserCreateRequest): Promise<number> => {
    return createBrowserRuntime(request, mainWindow)
  })

  ipcMain.handle('browser:destroy', async (_event, browserId: number): Promise<void> => {
    destroyBrowserRuntime(browserId)
  })

  ipcMain.handle('browser:navigate', async (_event, browserId: number, url: string): Promise<void> => {
    const runtime = browserRuntimes.get(browserId)
    const targetWindow = runtime ? getActiveBrowserWindow(runtime) : null
    if (runtime && targetWindow) {
      runtime.snapshot = { url, scrollX: 0, scrollY: 0 }
      await loadBrowserSnapshot(targetWindow.webContents, runtime.snapshot)
      emitBrowserState(runtime, mainWindow)
    }
  })

  ipcMain.handle('browser:resize', async (_event, browserId: number, width: number, height: number): Promise<void> => {
    await resizeBrowserRuntime(browserId, width, height)
  })

  ipcMain.handle(
    'browser:set-presentation-mode',
    async (_event, browserId: number, mode: BrowserPresentationMode): Promise<void> => {
      await setBrowserPresentationMode(browserId, mode, mainWindow)
    }
  )

  ipcMain.handle('browser:capture-snapshot', async (_event, browserId: number): Promise<string> => {
    const runtime = browserRuntimes.get(browserId)
    const targetWindow = runtime ? getActiveBrowserWindow(runtime) : null
    if (!targetWindow) {
      throw new Error(`Browser runtime ${browserId} is not available`)
    }

    const image = await targetWindow.webContents.capturePage()
    return image.toDataURL()
  })

  // Dev-only: capture current browser frame to disk for verification
  ipcMain.handle('browser:save-frame', async (_event, browserId: number, path: string): Promise<string> => {
    const runtime = browserRuntimes.get(browserId)
    const targetWindow = runtime ? getActiveBrowserWindow(runtime) : null
    if (!targetWindow) return 'no-browser-window'
    const image = await targetWindow.webContents.capturePage()
    const png = image.toPNG()
    await writeFile(path, png)
    return `saved ${png.length} bytes to ${path}`
  })

  ipcMain.handle('codex-auth:get-status', async () => readCodexAuthStatus())

  ipcMain.handle('codex-auth:start-device-auth', async (event) => {
    if (loginProcess) {
      return {
        started: false,
        message: 'Codex device auth is already running.'
      }
    }

    const authStatusBefore = await readCodexAuthStatus()
    if (authStatusBefore.isLoggedIn) {
      event.sender.send('codex-auth:event', {
        type: 'auth-status',
        status: authStatusBefore
      })
      return {
        started: false,
        message: authStatusBefore.statusText
      }
    }

    const child = spawn('codex', ['login', '--device-auth'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    loginProcess = child

    event.sender.send('codex-auth:event', { type: 'login-started' })

    const handleChunk = (chunk: Buffer): void => {
      event.sender.send('codex-auth:event', {
        type: 'login-output',
        chunk: chunk.toString()
      })
    }

    child.stdout.on('data', handleChunk)
    child.stderr.on('data', handleChunk)

    child.on('close', async (code) => {
      loginProcess = null
      const status = await readCodexAuthStatus()
      event.sender.send('codex-auth:event', {
        type: 'login-finished',
        success: code === 0 && status.isLoggedIn,
        status
      })
      event.sender.send('codex-auth:event', {
        type: 'auth-status',
        status
      })
    })

    child.on('error', async (error) => {
      loginProcess = null
      event.sender.send('codex-auth:event', {
        type: 'login-output',
        chunk: `Failed to start codex login: ${error.message}\n`
      })
      const status = await readCodexAuthStatus()
      event.sender.send('codex-auth:event', {
        type: 'login-finished',
        success: false,
        status
      })
    })

    return {
      started: true,
      message: 'Device auth started. Complete the browser flow, then return to EG-Desk.'
    }
  })

  ipcMain.handle('codex-auth:sign-out', async (event) => {
    await runCodexCommand(['logout'])
    const status = await readCodexAuthStatus()
    event.sender.send('codex-auth:event', {
      type: 'auth-status',
      status
    })
    return status
  })

  ipcMain.handle(
    'codex-chat:send-message',
    async (event, request: SendCodexChatMessageRequest): Promise<SendCodexChatMessageResult> =>
      startCodexChatExecution(event, request)
  )

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
