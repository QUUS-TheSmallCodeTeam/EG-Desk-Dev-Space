import { publicText } from './codex-chat-values.mjs'

// CODE-05·06 (1-R): the changed lines and command output of live runs, kept
// in memory only and handed out when the screen asks (GET /chat/run-changes,
// GET /chat/command-output). Nothing here enters SSE, snapshots or the chat
// store; text is redacted with publicText when it is read, not when stored.
//
// Bounds follow the reference adoption map (1-R) and the patterns read from:
// - openai/codex (Apache-2.0) codex-rs/core/src/turn_diff_tracker.rs:14-17 —
//   bounded diff work; codex-rs/app-server-protocol/src/protocol/item_builders.rs:365-380 —
//   an update is a hunk-only diff, add/delete carry the whole text, a move
//   appends "Moved to: …".
// - agentclientprotocol/claude-agent-acp (Apache-2.0) src/diff.ts:18-34 — a
//   file over the limit gets no patch at all rather than a cut one.
// - pingdotgg/t3code (MIT) apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:428-447 —
//   long command output keeps its tail.
// Only the patterns are used; no code was copied.

export const RUN_OUTPUT_LIMITS = Object.freeze({
  fileDiffBytes: 256 * 1024,
  runDiffBytes: 1024 * 1024,
  turnDiffBytes: 1024 * 1024,
  commandHeadBytes: 8 * 1024,
  commandTailBytes: 64 * 1024,
  commandsPerRun: 24,
  filesPerItem: 64,
  itemsPerRun: 100,
  totalBytes: 8 * 1024 * 1024,
})

const KINDS = new Set(['add', 'delete', 'update'])
const STATUS = new Set(['inProgress', 'completed', 'failed', 'declined'])
const byteLength = text => Buffer.byteLength(text, 'utf8')
const redact = text => typeof text === 'string' ? publicText(text, text.length) : null
const idOf = value => typeof value === 'string' && value && value.length <= 300 ? value : null

// The longest prefix of at most max UTF-8 bytes, never splitting a character.
export function prefixBytes(text, max) {
  if (max <= 0) return ''
  if (byteLength(text) <= max) return text
  const buffer = Buffer.from(text, 'utf8')
  let end = max
  while (end > 0 && (buffer[end] & 0xC0) === 0x80) end--
  return buffer.subarray(0, end).toString('utf8')
}

// The longest suffix of at most max UTF-8 bytes, never splitting a character.
export function suffixBytes(text, max) {
  if (max <= 0) return ''
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= max) return text
  let start = buffer.length - max
  while (start < buffer.length && (buffer[start] & 0xC0) === 0x80) start++
  return buffer.subarray(start).toString('utf8')
}

/**
 * Per-run store, keyed by the run's answerId (`${conversationId}/${runId}`).
 * - File changes: one entry per fileChange item; each file's diff is kept
 *   whole up to fileDiffBytes, and a run keeps at most runDiffBytes of them.
 *   A diff over either limit is dropped with omitted 'fileLimit' or 'runLimit'.
 * - Turn diff: the latest turn/diff/updated text, up to turnDiffBytes, else
 *   omitted 'turnLimit'.
 * - Command output: the first commandHeadBytes and the last commandTailBytes
 *   of each command's output, plus how many bytes fell in between.
 * - All runs together keep at most totalBytes; the oldest other run goes first.
 */
export class RunOutputStore {
  constructor({ limits = RUN_OUTPUT_LIMITS } = {}) {
    this.limits = { ...RUN_OUTPUT_LIMITS, ...limits }
    this.entries = new Map()
    this.totalBytes = 0
  }

  entry(key, create = true) {
    let entry = this.entries.get(key)
    if (!entry && create) {
      entry = { items: new Map(), fileBytes: 0, turn: null, commands: new Map(), commandBytes: 0 }
      this.entries.set(key, entry)
    }
    return entry || null
  }

  bytesOf(entry) { return entry.fileBytes + (entry.turn?.diff ? entry.turn.bytes : 0) + entry.commandBytes }

  // Applies a change to one run and keeps the total within bounds.
  change(key, action) {
    const entry = this.entry(key)
    const before = this.bytesOf(entry)
    action(entry)
    this.totalBytes += this.bytesOf(entry) - before
    for (const [other] of this.entries) {
      if (this.totalBytes <= this.limits.totalBytes) break
      if (other !== key) this.forget(other)
    }
  }

  // changes: native FileUpdateChange rows ({path, kind: {type, move_path}, diff}).
  setFileChanges(key, itemId, changes, status = null) {
    if (!idOf(itemId) || !Array.isArray(changes)) return
    this.change(key, entry => {
      const previous = entry.items.get(itemId)
      if (previous) { entry.fileBytes -= previous.bytes; entry.items.delete(itemId) }
      const { fileDiffBytes, runDiffBytes, filesPerItem, itemsPerRun } = this.limits
      while (entry.items.size >= itemsPerRun) {
        const [oldest, old] = entry.items.entries().next().value
        entry.fileBytes -= old.bytes
        entry.items.delete(oldest)
      }
      const files = []
      let bytes = 0
      for (const change of changes.slice(0, filesPerItem)) {
        if (!change || typeof change !== 'object' || typeof change.path !== 'string' || !change.path) continue
        const kind = KINDS.has(change.kind?.type) ? change.kind.type : 'update'
        const movePath = kind === 'update' && typeof change.kind?.move_path === 'string' ? change.kind.move_path.slice(0, 4096) : null
        const diff = typeof change.diff === 'string' ? change.diff : null
        const size = diff === null ? 0 : byteLength(diff)
        let omitted = diff === null ? 'unavailable' : null
        if (!omitted && size > fileDiffBytes) omitted = 'fileLimit'
        else if (!omitted && entry.fileBytes + bytes + size > runDiffBytes) omitted = 'runLimit'
        if (!omitted) bytes += size
        files.push({ path: change.path.slice(0, 4096), kind, movePath, diff: omitted ? null : diff, bytes: size, omitted })
      }
      entry.items.set(itemId, {
        itemId, status: STATUS.has(status) ? status : previous?.status || 'inProgress',
        files, truncated: changes.length > filesPerItem, bytes,
      })
      entry.fileBytes += bytes
    })
  }

  setItemStatus(key, itemId, status) {
    const item = this.entry(key, false)?.items.get(itemId)
    if (item && STATUS.has(status)) item.status = status
  }

  setTurnDiff(key, diff) {
    if (typeof diff !== 'string') return
    this.change(key, entry => {
      const bytes = byteLength(diff)
      entry.turn = bytes > this.limits.turnDiffBytes ? { diff: null, bytes, omitted: 'turnLimit' } : { diff, bytes, omitted: null }
    })
  }

  command(entry, itemId) {
    let output = entry.commands.get(itemId)
    if (!output) {
      while (entry.commands.size >= this.limits.commandsPerRun) {
        const [oldest, old] = entry.commands.entries().next().value
        entry.commandBytes -= old.headBytes + old.tailBytes
        entry.commands.delete(oldest)
      }
      output = { itemId, head: '', tail: '', headBytes: 0, tailBytes: 0, totalBytes: 0, headClosed: false, complete: false }
      entry.commands.set(itemId, output)
    }
    return output
  }

  append(entry, output, text) {
    const before = output.headBytes + output.tailBytes
    output.totalBytes += byteLength(text)
    // Once text has spilled past the head, the head stays closed so the
    // kept bytes remain in output order.
    if (!output.headClosed) {
      const part = prefixBytes(text, this.limits.commandHeadBytes - output.headBytes)
      output.head += part
      output.headBytes += byteLength(part)
      text = text.slice(part.length)
    }
    if (text) {
      output.headClosed = true
      output.tail = suffixBytes(output.tail + text, this.limits.commandTailBytes)
      output.tailBytes = byteLength(output.tail)
    }
    entry.commandBytes += output.headBytes + output.tailBytes - before
  }

  appendCommandOutput(key, itemId, delta) {
    if (!idOf(itemId) || typeof delta !== 'string' || !delta) return
    this.change(key, entry => this.append(entry, this.command(entry, itemId), delta))
  }

  // aggregatedOutput replaces what streamed only when it is longer (deltas
  // were missed or never sent); either way the command is then complete.
  completeCommand(key, itemId, aggregatedOutput) {
    if (!idOf(itemId)) return
    const existing = this.entry(key, false)?.commands.get(itemId)
    if (!existing && typeof aggregatedOutput !== 'string') return
    this.change(key, entry => {
      const output = this.command(entry, itemId)
      if (typeof aggregatedOutput === 'string' && byteLength(aggregatedOutput) > output.totalBytes) {
        entry.commandBytes -= output.headBytes + output.tailBytes
        Object.assign(output, { head: '', tail: '', headBytes: 0, tailBytes: 0, totalBytes: 0, headClosed: false })
        this.append(entry, output, aggregatedOutput)
      }
      output.complete = true
    })
  }

  forget(key) {
    const entry = this.entries.get(key)
    if (!entry) return
    this.totalBytes -= this.bytesOf(entry)
    this.entries.delete(key)
  }

  keys() { return [...this.entries.keys()] }

  /**
   * Public copy for GET /chat/run-changes. With itemId only that item's files
   * (turn null). Diff text is redacted; omitted says why a diff is missing.
   */
  changes(key, { itemId = null } = {}) {
    const entry = this.entry(key, false)
    const items = entry ? [...entry.items.values()].filter(item => !itemId || item.itemId === itemId) : []
    return {
      retained: Boolean(entry),
      turn: !itemId && entry?.turn ? { diff: redact(entry.turn.diff), bytes: entry.turn.bytes, omitted: entry.turn.omitted } : null,
      items: items.map(item => ({
        itemId: item.itemId, status: item.status, truncated: item.truncated,
        files: item.files.map(file => ({ path: publicText(file.path, 4096), kind: file.kind, movePath: file.movePath === null ? null : publicText(file.movePath, 4096), diff: redact(file.diff), bytes: file.bytes, omitted: file.omitted })),
      })),
      commands: !itemId && entry ? [...entry.commands.values()].map(output => ({ itemId: output.itemId, totalBytes: output.totalBytes, complete: output.complete })) : [],
      limits: { fileDiffBytes: this.limits.fileDiffBytes, runDiffBytes: this.limits.runDiffBytes, turnDiffBytes: this.limits.turnDiffBytes },
    }
  }

  /** Public copy for GET /chat/command-output, or null when nothing is kept. */
  commandOutput(key, itemId) {
    const output = this.entry(key, false)?.commands.get(itemId)
    if (!output) return null
    return {
      itemId: output.itemId, head: redact(output.head), tail: redact(output.tail),
      omittedBytes: Math.max(0, output.totalBytes - output.headBytes - output.tailBytes),
      totalBytes: output.totalBytes, complete: output.complete,
      limits: { headBytes: this.limits.commandHeadBytes, tailBytes: this.limits.commandTailBytes },
    }
  }
}
