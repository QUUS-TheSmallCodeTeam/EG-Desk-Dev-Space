import { randomUUID } from 'node:crypto'

const fail = (code, message, httpStatus = 409) => Object.assign(new Error(message), { code, httpStatus })
const short = (value, max = 160) => typeof value === 'string' && value.length > 0 && value.length <= max
// Optional same-clock fields from the helper: a run-scoped seq (positive
// integer) and sentAtMs (performance.timeOrigin + performance.now()).
const badSeq = request => Object.hasOwn(request, 'seq') && !(Number.isSafeInteger(request.seq) && request.seq > 0)
const badSentAt = request => Object.hasOwn(request, 'sentAtMs') && !(Number.isFinite(request.sentAtMs) && request.sentAtMs > 0)

// One SSE client, one run and one native Browser request are bound together.
// A response from another window or a stale stream cannot satisfy the call.
export class BrowserToolTransport {
  constructor({ getOwnerKey, now = Date.now, clock = () => performance.timeOrigin + performance.now(),
    setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if (typeof getOwnerKey !== 'function') throw new TypeError('Current owner key is required')
    Object.assign(this, { getOwnerKey, now, clock, setTimer, clearTimer })
    this.clients = new Map()
    this.runs = new Map()
    this.pending = new Map()
  }

  registerClient(client) {
    if (!client || typeof client.send !== 'function' || client.chatProtocol !== 2) throw new TypeError('Browser transport requires a v2 SSE client')
    const transportId = randomUUID()
    this.clients.set(transportId, client)
    return transportId
  }

  hasClient(transportId) { return short(transportId) && this.clients.has(transportId) && !this.clients.get(transportId).closed }

  closeClient(transportId) {
    this.clients.delete(transportId)
    for (const [requestId, entry] of this.pending) if (entry.transportId === transportId) {
      this.clearTimer(entry.timer)
      this.pending.delete(requestId)
      entry.reject(fail('BROWSER_UI_DISCONNECTED', 'Selected Browser UI stream disconnected'))
    }
    for (const [runId, entry] of this.runs) if (entry.transportId === transportId) this.runs.delete(runId)
  }

  bindRun(runId, clientThreadId, transportId) {
    const ownerKey = this.getOwnerKey()
    if (!short(runId, 300) || !short(clientThreadId) || !short(ownerKey, 256) || !this.hasClient(transportId)) {
      throw fail('BROWSER_UI_UNAVAILABLE', 'A selected, connected Browser UI stream is required')
    }
    if (this.runs.has(runId)) throw fail('BROWSER_RUN_BOUND', 'Browser run already has a UI stream')
    this.runs.set(runId, { transportId, clientThreadId, ownerKey })
  }

  unbindRun(runId) {
    const binding = this.runs.get(runId)
    this.runs.delete(runId)
    if (!binding) return
    for (const [requestId, entry] of this.pending) if (entry.runId === runId && entry.runBinding === binding) {
      this.clearTimer(entry.timer)
      this.pending.delete(requestId)
      entry.reject(fail('BROWSER_RUN_ENDED', 'Browser run ended while awaiting its UI response; outcome is unknown'))
    }
  }

  async sendToUi(request) {
    if (!request || typeof request !== 'object' || !short(request.requestId) || !short(request.runId, 300) ||
        !short(request.clientThreadId) ||
        !short(request.cardId) || !short(request.targetCardEpoch) || !Number.isSafeInteger(request.deadlineMs) ||
        request.deadlineMs <= this.now() || request.deadlineMs > this.now() + 60000 || badSeq(request) || badSentAt(request)) {
      throw fail('BROWSER_UI_PROTOCOL', 'Browser UI request has invalid correlation, target or deadline', 400)
    }
    const bound = this.runs.get(request.runId)
    const client = bound && this.clients.get(bound.transportId)
    if (!client || client.closed || bound.ownerKey !== this.getOwnerKey() || bound.clientThreadId !== request.clientThreadId) {
      throw fail('BROWSER_UI_UNAVAILABLE', 'Bound Browser UI stream, Chat thread or account is unavailable')
    }
    if ([...this.pending.values()].some(entry => entry.requestId === request.requestId) || this.pending.size >= 64) {
      throw fail('BROWSER_UI_BUSY', 'Browser UI request channel is busy')
    }
    // The UI echoes a unique handoff ID; caller IDs may be reused after a run
    // ends. No retired-ID history is needed, and an old response stays stale.
    const wireRequestId = randomUUID()
    const data = JSON.stringify({ ...request, requestId: wireRequestId })
    if (data.length > 48000) throw fail('BROWSER_UI_PROTOCOL', 'Browser UI request exceeds the bounded transport size', 413)
    return new Promise((resolve, reject) => {
      // Capture the binding generation, not just a reusable run ID.
      const entry = { requestId: request.requestId, runId: request.runId, runBinding: bound, transportId: bound.transportId,
        ownerKey: bound.ownerKey, deadlineMs: request.deadlineMs, resolve, reject, timer: null,
        sent: { ...(Object.hasOwn(request, 'seq') ? { seq: request.seq } : {}),
          ...(Object.hasOwn(request, 'sentAtMs') ? { sentAtMs: request.sentAtMs } : {}) } }
      const timer = this.setTimer(() => {
        if (this.pending.get(wireRequestId) !== entry) return
        this.pending.delete(wireRequestId)
        this.clearTimer(entry.timer)
        reject(this.timedOut(entry, 'Browser UI response deadline passed; outcome is unknown'))
      }, Math.max(1, request.deadlineMs - this.now()))
      timer?.unref?.()
      entry.timer = timer
      this.pending.set(wireRequestId, entry)
      if (!client.send(`event: browser-tool-request\ndata: ${data}\n\n`)) {
        this.clearTimer(timer)
        this.pending.delete(wireRequestId)
        reject(fail('BROWSER_UI_DISCONNECTED', 'Browser UI stream could not accept the request'))
      }
    })
  }

  receive(transportId, response) {
    const requestId = response?.requestId
    const entry = this.pending.get(requestId)
    if (!short(transportId) || !short(requestId) || !entry || entry.transportId !== transportId ||
        !this.hasClient(transportId) || entry.ownerKey !== this.getOwnerKey() ||
        this.runs.get(entry.runId) !== entry.runBinding) {
      throw fail('BROWSER_UI_RESPONSE_STALE', 'No matching Browser request is awaiting this UI response')
    }
    if (this.now() >= entry.deadlineMs) {
      this.pending.delete(requestId)
      this.clearTimer(entry.timer)
      entry.reject(this.timedOut(entry, 'Browser UI response arrived after its deadline'))
      throw fail('BROWSER_UI_RESPONSE_STALE', 'Browser UI response arrived after its deadline')
    }
    if (!response || typeof response !== 'object' || Array.isArray(response) || JSON.stringify(response).length > 180000) {
      throw fail('BROWSER_UI_PROTOCOL', 'Browser UI response exceeds the bounded contract', 400)
    }
    this.pending.delete(requestId)
    this.clearTimer(entry.timer)
    entry.resolve({ ...response, requestId: entry.requestId })
    return { accepted: true, requestId }
  }

  // A timeout ends the wait, not the input (REA T-03): the record says when it
  // was sent and when this transport stopped waiting, on the same clock.
  timedOut(entry, message) {
    return Object.assign(fail('BROWSER_UI_TIMEOUT', message), { ...entry.sent, timedOutAtMs: this.clock() })
  }

  reset({ dropClients = false } = {}) {
    for (const [requestId, entry] of this.pending) {
      this.clearTimer(entry.timer)
      entry.reject(fail('BROWSER_UI_DISCONNECTED', 'Browser transport was reset'))
      this.pending.delete(requestId)
    }
    this.runs.clear()
    // The SSE connection belongs to the visible UI, not to the native
    // account. Its next run must still pass a fresh owner/Card binding.
    if (dropClients) this.clients.clear()
  }
}
