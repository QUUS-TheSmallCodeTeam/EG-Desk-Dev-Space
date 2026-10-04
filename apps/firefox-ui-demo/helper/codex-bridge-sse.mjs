// A false write() result means this frame was accepted into Node's buffer.
// Queue only later frames, then resume on drain; never write the accepted frame twice.
export class BoundedSseClient {
  constructor(response, {
    chatProtocol = 1,
    maxBufferedBytes = 256 * 1024,
    drainTimeoutMs = 15000,
    onClose = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    Object.assign(this, { response, chatProtocol, maxBufferedBytes, drainTimeoutMs, onClose, setTimer, clearTimer })
    this.queue = []
    this.queuedBytes = 0
    this.blockedBytes = 0
    this.blocked = false
    this.closed = false
    this.timer = null
    this.onDrain = () => this.drain()
    this.onResponseClose = () => this.close('closed')
    this.onResponseError = () => this.close('write_error', true)
    response.on('drain', this.onDrain)
    response.on('close', this.onResponseClose)
    response.on('error', this.onResponseError)
  }

  send(payload) {
    if (this.closed) return false
    if (this.response.destroyed || this.response.writableEnded) {
      this.close('closed')
      return false
    }
    const bytes = Buffer.byteLength(payload)
    const buffered = Math.max(this.response.writableLength || 0, this.blockedBytes)
    if (bytes + this.queuedBytes + buffered > this.maxBufferedBytes) {
      // The client can reconnect and hydrate /chat/state. Runtime state and
      // native turns are independent of this subscriber's transport lifetime.
      this.close('buffer_limit', true)
      return false
    }
    if (this.blocked) {
      this.queue.push({ payload, bytes })
      this.queuedBytes += bytes
      return true
    }
    return this.write(payload, bytes)
  }

  write(payload, bytes) {
    try {
      if (!this.response.write(payload)) {
        this.blocked = true
        this.blockedBytes = bytes
        this.timer = this.setTimer(() => this.close('drain_timeout', true), this.drainTimeoutMs)
        this.timer?.unref?.()
      }
      return true
    } catch {
      this.close('write_error', true)
      return false
    }
  }

  drain() {
    if (this.closed) return
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    this.blocked = false
    this.blockedBytes = 0
    while (!this.closed && !this.blocked && this.queue.length) {
      const frame = this.queue.shift()
      this.queuedBytes -= frame.bytes
      this.write(frame.payload, frame.bytes)
    }
  }

  close(reason = 'closed', destroy = false) {
    if (this.closed) return
    this.closed = true
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    this.queue = []
    this.queuedBytes = 0
    this.blockedBytes = 0
    this.response.removeListener('drain', this.onDrain)
    this.response.removeListener('close', this.onResponseClose)
    this.response.removeListener('error', this.onResponseError)
    if (destroy && !this.response.destroyed) this.response.destroy()
    this.onClose(reason)
  }
}
