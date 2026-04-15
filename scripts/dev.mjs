import { spawn } from 'node:child_process'
import process from 'node:process'

const rootDir = '/Users/minsoocha/Projects/EG-Desk-Dev-Space'
const rendererUrl = 'http://127.0.0.1:5173'
const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const electronCommand = process.platform === 'win32' ? 'electron.cmd' : 'electron'
const electronEntry = `${rootDir}/dist-electron/main/index.js`
const shouldLaunchElectron = !process.argv.includes('--no-electron')

let viteReady = false
let electronBuildReady = false
let shuttingDown = false
let electronProcess = null

function pipeLogs(child, prefix) {
  child.stdout?.on('data', (chunk) => {
    process.stdout.write(`[${prefix}] ${chunk}`)
  })
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(`[${prefix}] ${chunk}`)
  })
}

function launchElectron() {
  if (!shouldLaunchElectron) return
  if (!viteReady || !electronBuildReady || shuttingDown) return

  if (electronProcess) {
    electronProcess.kill('SIGTERM')
  }

  electronProcess = spawn(npxCommand, [electronCommand, electronEntry], {
    cwd: rootDir,
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: rendererUrl
    },
    stdio: ['inherit', 'pipe', 'pipe']
  })
  pipeLogs(electronProcess, 'electron')

  electronProcess.on('exit', (code, signal) => {
    if (!shuttingDown) {
      process.stderr.write(
        `[electron] exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})\n`
      )
    }
  })
}

const viteProcess = spawn(
  npxCommand,
  ['vite', '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
  {
    cwd: rootDir,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe']
  }
)
pipeLogs(viteProcess, 'vite')

viteProcess.stdout.on('data', (chunk) => {
  const text = chunk.toString()
  if (!viteReady && (text.includes('Local:') || text.includes('ready in'))) {
    viteReady = true
    launchElectron()
  }
})

const tscProcess = spawn(
  npxCommand,
  ['tsc', '-p', 'tsconfig.node.json', '--watch', '--preserveWatchOutput', '--pretty', 'false'],
  {
    cwd: rootDir,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe']
  }
)
pipeLogs(tscProcess, 'tsc')

tscProcess.stdout.on('data', (chunk) => {
  const text = chunk.toString()
  if (!text.includes('Found 0 errors. Watching for file changes.')) return
  electronBuildReady = true
  launchElectron()
})

function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  electronProcess?.kill('SIGTERM')
  viteProcess.kill('SIGTERM')
  tscProcess.kill('SIGTERM')
  process.exit(exitCode)
}

viteProcess.on('exit', (code) => {
  if (!shuttingDown) shutdown(code ?? 1)
})

tscProcess.on('exit', (code) => {
  if (!shuttingDown) shutdown(code ?? 1)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0))
}
