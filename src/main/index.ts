import { app, shell, BrowserWindow, ipcMain, screen } from 'electron'
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
import type { BrowserFrameEvent } from '../shared/browser.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Enable Chrome DevTools Protocol for playwright MCP attach (renderer CDP on :9222)
app.commandLine.appendSwitch('remote-debugging-port', '9222')

// ── OSR Browser Windows (POC) ────────────────────────────────────────
// Map from browserId (webContents.id) to the hidden OSR BrowserWindow.
const osrWindows = new Map<number, BrowserWindow>()

function createOsrWindow(url: string, mainWindow: BrowserWindow): number {
  const osr = new BrowserWindow({
    // OSR requires explicit size for paint events to fire.
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      sandbox: false
    }
  })

  osr.webContents.setFrameRate(30)

  const browserId = osr.webContents.id
  osrWindows.set(browserId, osr)

  console.log(`[OSR] created window browserId=${browserId} url=${url}`)

  osr.webContents.on('paint', (_event, _dirty, image) => {
    // Skip empty frames (fired before page first paints) to avoid X-box broken image
    if (image.isEmpty()) return
    const size = image.getSize()
    if (!mainWindow.isDestroyed()) {
      const payload: BrowserFrameEvent = {
        browserId,
        // toPNG() Buffer is ~3-5x smaller than toDataURL() base64 string over IPC
        buffer: image.toPNG(),
        width: size.width,
        height: size.height
      }
      mainWindow.webContents.send('browser:frame', payload)
    }
  })

  osr.webContents.on('did-fail-load', (_e, errorCode, errorDescription, url) => {
    console.error(`[OSR] did-fail-load browserId=${browserId} code=${errorCode} desc=${errorDescription} url=${url}`)
  })

  osr.webContents.loadURL(url)
  return browserId
}

function destroyOsrWindow(browserId: number): void {
  const osr = osrWindows.get(browserId)
  if (osr && !osr.isDestroyed()) {
    osr.close()
  }
  osrWindows.delete(browserId)
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

function createWindow(): BrowserWindow {
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

  return mainWindow
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.egdesk')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('ping', () => console.log('pong'))

  const mainWindow = createWindow()

  // ── OSR Browser IPC handlers ────────────────────────────────────────
  ipcMain.handle('browser:create', async (_event, url: string): Promise<number> => {
    return createOsrWindow(url, mainWindow)
  })

  ipcMain.handle('browser:destroy', async (_event, browserId: number): Promise<void> => {
    destroyOsrWindow(browserId)
  })

  ipcMain.handle('browser:navigate', async (_event, browserId: number, url: string): Promise<void> => {
    const osr = osrWindows.get(browserId)
    if (osr && !osr.isDestroyed()) {
      await osr.webContents.loadURL(url)
    }
  })

  // Dev-only: capture current OSR frame to disk for verification
  ipcMain.handle('browser:save-frame', async (_event, browserId: number, path: string): Promise<string> => {
    const osr = osrWindows.get(browserId)
    if (!osr || osr.isDestroyed()) return 'no-osr-window'
    return new Promise((resolve) => {
      osr.webContents.once('paint', async (_e, _dirty, image) => {
        const png = image.toPNG()
        await writeFile(path, png)
        resolve(`saved ${png.length} bytes to ${path}`)
      })
    })
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
