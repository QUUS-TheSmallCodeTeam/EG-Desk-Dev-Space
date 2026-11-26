// a1 (L1): the bridge's slot for Browser task step lines (display only).
//
// Developer flag EGDESK_BROWSER_STEPS_UI=on (default off). When on, /v1/state lists capabilities.browserSteps and the
// overlay shows the steps in Chat and frames the target on the Card; when off nothing is sent for them and the screen is
// as before.
//
// The runtime reports a step through decisionContext.browserSteps.publish({ threadId|clientThreadId, taskId, cardId,
// seq, op, target, valueName, ok, ms, by: 'decision'|'model', status?, reason? }) (or emits the same frame, type
// 'browser.task.step', through its emit callback; gate() below drops it while the flag is off). A chat event
// 'browserTask.step' on a run is not touched here: it is stored and numbered like any chat event, and the overlay reads it.
// The frame carries labels and the NAME of a value only (valueName), never what was typed.
import { BROWSER_STEP_FRAME_TYPE, normalizeBrowserStep } from '../overlay/resources/EGDeskBrowserStepsView.sys.mjs'

export { BROWSER_STEP_FRAME_TYPE }
export const BROWSER_STEPS_UI_FLAG = 'EGDESK_BROWSER_STEPS_UI'

export const browserStepsUiMode = (env = process.env) => (env?.[BROWSER_STEPS_UI_FLAG] === 'on' ? 'on' : 'off')

/** The frame the overlay receives for one step, or null when the step cannot be placed. */
export function browserStepFrame(step, { now = Date.now } = {}) {
  const normalized = normalizeBrowserStep(step, { ts: Number.isFinite(step?.ts) ? step.ts : now() })
  if (!normalized) return null
  const { clientThreadId, ...rest } = normalized
  return { type: BROWSER_STEP_FRAME_TYPE, v: 1, clientThreadId, ...rest }
}

/**
 * createBrowserStepsChannel({ mode, broadcast, now? }) -> { enabled(), publish(step), gate(event) }
 *   mode(): 'on' | anything else (off). broadcast(frame): sends to the chat-protocol-2 clients.
 *   publish(step) -> true when a frame was sent. gate(event) -> the event to send: a step frame is checked again
 *   (null while off or when unusable); every other event passes unchanged.
 */
export function createBrowserStepsChannel({ mode = () => 'off', broadcast, now = Date.now } = {}) {
  if (typeof broadcast !== 'function') throw new TypeError('broadcast must be a function')
  const enabled = () => { try { return mode() === 'on' } catch { return false } }
  return {
    enabled,
    publish(step) {
      if (!enabled()) return false
      const frame = browserStepFrame(step, { now })
      if (!frame) return false
      try { broadcast(frame) } catch { return false }
      return true
    },
    gate(event) {
      if (event?.type !== BROWSER_STEP_FRAME_TYPE) return event
      return enabled() ? browserStepFrame(event, { now }) : null
    },
  }
}
