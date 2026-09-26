// Transport-independent JSON-RPC. Importing this module never starts Codex.
export class AppServerRpc {
  constructor({ send, onNotification = () => {}, onRequest = () => {}, timeoutMs = 30000 }) {
    this.send = send
    this.onNotification = onNotification
    this.onRequest = onRequest
    this.timeoutMs = timeoutMs
    this.pending = new Map()
    this.nextId = 1
    this.ready = false
    this.closed = false
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'egdesk-firefox-bridge', version: '0.2.0' },
      capabilities: { experimentalApi: false },
    }, true)
    if (this.closed) throw new Error('Codex app-server disconnected')
    this.send(JSON.stringify({ method: 'initialized', params: {} }))
    this.ready = true
  }

  request(method, params, initializing = false) {
    if (this.closed || (!this.ready && !initializing)) {
      return Promise.reject(new Error('Codex app-server is not connected'))
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(Object.assign(new Error(`${method} timed out`), { code: 'RPC_TIMEOUT' }))
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try { this.send(JSON.stringify({ id, method, params })) } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  respond(id, result, error) {
    if (this.closed || !this.ready) throw new Error('Codex app-server is not connected')
    this.send(JSON.stringify(error ? { id, error } : { id, result }))
  }

  receive(raw) {
    if (this.closed) return
    let message
    try { message = JSON.parse(String(raw)) } catch { return }
    if (!message || typeof message !== 'object') return
    // Server requests also carry an id; never consume them as client responses.
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) this.onRequest(message)
      else this.onNotification(message)
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    if (!Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error')) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) {
      pending.reject(Object.assign(new Error(message.error.message || 'Codex request failed'), { code: message.error.code }))
    } else pending.resolve(message.result)
  }

  close(error = new Error('Codex app-server disconnected')) {
    this.closed = true
    this.ready = false
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(error)
    }
    this.pending.clear()
  }
}
