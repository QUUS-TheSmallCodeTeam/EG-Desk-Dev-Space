import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import RootErrorBoundary from './components/RootErrorBoundary'
import './styles/globals.css'

function serializeLogEntry(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`
  }
  if (typeof value === 'string') {
    return value
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function forwardRendererLog(level: 'log' | 'warn' | 'error', values: unknown[]): void {
  try {
    window.api.debug.log(level, values.map(serializeLogEntry))
  } catch {
    // Ignore forwarding failures and keep the local console path alive.
  }
}

const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
}

console.log = (...args: unknown[]) => {
  originalConsole.log(...args)
  forwardRendererLog('log', args)
}

console.warn = (...args: unknown[]) => {
  originalConsole.warn(...args)
  forwardRendererLog('warn', args)
}

console.error = (...args: unknown[]) => {
  originalConsole.error(...args)
  forwardRendererLog('error', args)
}

window.addEventListener('error', (event) => {
  console.error('[window.error]', event.error ?? event.message)
})

window.addEventListener('unhandledrejection', (event) => {
  console.error('[window.unhandledrejection]', event.reason)
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>
)
