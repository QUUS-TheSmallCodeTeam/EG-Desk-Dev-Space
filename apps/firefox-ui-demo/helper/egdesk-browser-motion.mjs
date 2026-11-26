import { isBrowserUserHold } from './egdesk-browser-tool-runtime.mjs'
// Whole requests only: never turn a quoted example, a negation or one part of a longer task into a completed motion.
export function requestedMotion(goal) {
  const text = String(goal ?? '').normalize('NFKC').trim().toLowerCase().replace(/[.!]+$/u, '').trim()
  const ko = text.replace(/\s+/gu, '').replace(/^(?:이|현재|지금)?(?:브라우저카드|브라우저|카드|문서|페이지|화면)(?:에서|를|을|의)?/u, '')
  if (/^(?:뒤로|뒤로가기|이전페이지로)(?:가|이동해)?(?:줘|주세요)?$/u.test(ko) || /^(?:please )?go back(?: one page)?$/u.test(text)) return 'back'
  if (/^(?:앞으로|앞으로가기)(?:가|이동해)?(?:줘|주세요)?$/u.test(ko) || /^(?:please )?go forward(?: one page)?$/u.test(text)) return 'forward'
  if (/^(?:맨아래|맨밑|최하단|끝까지)(?:까지|로)?(?:내려|내려가|스크롤해|이동해|가)?(?:줘|주세요)?$/u.test(ko) || /^(?:please )?scroll (?:all the way )?(?:down )?to (?:the )?(?:bottom|end)$/u.test(text)) return 'bottom'
  if (/^(?:맨위|최상단)(?:까지|로)?(?:올려|올라가|스크롤해|이동해|가)?(?:줘|주세요)?$/u.test(ko) || /^(?:please )?scroll (?:all the way )?(?:up )?to (?:the )?top$/u.test(text)) return 'top'
  if (/^(?:조금|한화면|한페이지)?(?:만)?(?:아래로)?(?:내려|내려가)(?:줘|주세요)?$/u.test(ko) || /^scroll down(?: (?:a little|one page))?$/u.test(text)) return 'down'
  if (/^(?:조금|한화면|한페이지)?(?:만)?(?:위로)?(?:올려|올라가)(?:줘|주세요)?$/u.test(ko) || /^scroll up(?: (?:a little|one page))?$/u.test(text)) return 'up'
  return null
}
export const isHistory = motion => motion === 'back' || motion === 'forward'
export const atEdge = (scroll, motion) => scroll && Number.isFinite(scroll.y) && Number.isFinite(scroll.maxY) && scroll.maxY >= 0 &&
  (motion === 'bottom' || motion === 'down' ? Math.abs(scroll.maxY - scroll.y) <= 1 : Math.abs(scroll.y) <= 1)

export async function runRequestedMotion({ motion, observed, cardId, callTool, act, entry, finish, signal, isDecisionCurrent }) {
  const { snapshot } = observed
  const complete = seen => finish('done', { url: seen.snapshot.url, observationId: seen.observationId })
  const unverified = () => finish('escalated', { reason: 'tool_failed', code: 'BROWSER_ACTION_UNVERIFIED' })
  if (!isHistory(motion) && (!Number.isFinite(snapshot.scroll?.y) || !Number.isFinite(snapshot.scroll?.maxY))) return unverified()
  if (!isHistory(motion) && atEdge(snapshot.scroll, motion)) return complete(observed)
  let before = observed
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) return finish('aborted')
    if (isDecisionCurrent && !isDecisionCurrent()) return finish('fallback', { reason: 'evidence_unavailable' })
    const args = { cardId, observationId: before.observationId, expectedRevision: before.snapshot.revision }
    const moved = isHistory(motion) ? await act(entry, 'egdesk_browser_history', { ...args, action: motion }, { op: 'open' })
      : await act(entry, 'egdesk_browser_scroll', { ...args, direction: motion, amount: 'page' })
    if (moved.held) return finish('escalated', { reason: 'human_step', staleBy: 'user-hold' })
    if (!moved.ok) return finish('escalated', { reason: 'tool_failed', code: moved.code })
    const target = moved.result?.dispatchReceipt?.targetUrl
    if (isHistory(motion) && (moved.result?.status !== 'history-dispatched' || !target)) return unverified()
    let fresh
    try {
      fresh = await callTool('egdesk_browser_observe', { cardId })
      // First observation may race the replacement document. Never dispatch the history move twice.
      if (isHistory(motion)) for (const delay of [80, 180, 400, 850]) {
        if (fresh?.snapshot?.url === target && (target !== snapshot.url || fresh.snapshot.documentId !== snapshot.documentId)) break
        if (signal?.aborted) return finish('aborted')
        await new Promise(resolve => setTimeout(resolve, delay))
        fresh = await callTool('egdesk_browser_observe', { cardId })
      }
    } catch (error) { return finish('escalated', isBrowserUserHold(error) ? { reason: 'human_step', staleBy: 'user-hold' } : { reason: 'observe_failed' }) }
    if (!fresh?.snapshot || !fresh.observationId || fresh.observationId === before.observationId) return unverified()
    const now = fresh.snapshot
    if (isHistory(motion)) return now.url === target && (now.url !== snapshot.url || now.documentId !== snapshot.documentId) ? complete(fresh) : unverified()
    if (now.documentId !== snapshot.documentId || now.url !== snapshot.url || !Number.isFinite(now.scroll?.y) || !Number.isFinite(now.scroll?.maxY)) return unverified()
    if (atEdge(now.scroll, motion)) return complete(fresh)
    if (motion === 'up' || motion === 'down') return (now.scroll.y - before.snapshot.scroll.y) * (motion === 'up' ? -1 : 1) > 0 ? complete(fresh) : unverified()
    if (motion !== 'bottom' || !(now.scroll.maxY > before.snapshot.scroll.maxY && now.scroll.y > before.snapshot.scroll.y)) return unverified()
    before = fresh // append-on-scroll: bounded, each further motion guarded by its own observation
  }
  return finish('escalated', { reason: 'step_limit' })
}
