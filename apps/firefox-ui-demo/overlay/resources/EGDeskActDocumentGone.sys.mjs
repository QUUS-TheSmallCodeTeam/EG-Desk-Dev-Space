// L52: an input that navigates the top-level document away (a POST form submit answered by a JSON viewer or any new
// document) destroys the page actor that was asked to act, and its reply may never arrive: the helper then waited for its
// whole UI budget (~15 s) before the call threw. This races the actor request against "the document this request ran in
// is no longer the current one". The actor's own reply still wins when it arrives (also during the short grace); only a
// silent actor after the document went away is turned into a prompt rejection. The rejection claims nothing about
// dispatch ('unknown'): the helper's settle() judges arrival from the top-level address, and never presses again.
export const ACT_DOCUMENT_GONE_GRACE_MS = 1200
export const ACT_DOCUMENT_GONE_POLL_MS = 100
export const GONE_ACTION_TYPES = Object.freeze(['click', 'pointer-click', 'press'])

export function actCanLeaveDocument(action) {
  return GONE_ACTION_TYPES.includes(action?.type)
}

export function raceActWithDocumentGone(request, { isReplaced, graceMs = ACT_DOCUMENT_GONE_GRACE_MS, pollMs = ACT_DOCUMENT_GONE_POLL_MS,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
  return new Promise((resolve, reject) => {
    let done = false, timer = null, goneAt = null
    const finish = fn => value => { if (done) return; done = true; if (timer !== null) clearTimer(timer); fn(value) }
    const ok = finish(resolve), fail = finish(reject)
    Promise.resolve(request).then(ok, fail)
    const tick = () => {
      if (done) return
      let replaced = false
      try { replaced = isReplaced() === true } catch { replaced = true }
      if (replaced) {
        goneAt ??= now()
        if (now() - goneAt >= graceMs) {
          fail(Object.assign(new Error('Browser document went away after the input; outcome is unknown'),
            { name: 'DocumentGone', browserToolActor: { dispatchPhase: 'unknown' } }))
          return
        }
      }
      timer = setTimer(tick, pollMs)
    }
    timer = setTimer(tick, pollMs)
  })
}
