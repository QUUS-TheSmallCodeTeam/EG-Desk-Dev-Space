/**
 * usePanImmersion — Space/Cmd+drag 중 Edge fade-out 감지 hook (Task #13)
 *
 * Trigger: (Space | Meta | Ctrl) hold + mouse down → isPanning=true
 * Reset: keyup / mouseup / 5s idle / window blur → isPanning=false
 * Text input focused 시 Space는 무시 (주석 입력 대비).
 */
import { useEffect, useRef, useState } from 'react'

export function usePanImmersion(): boolean {
  const [isPanning, setIsPanning] = useState(false)
  const keyRef = useRef(false)
  const mouseRef = useRef(false)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const resetIdle = (): void => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
      idleTimerRef.current = setTimeout(() => {
        setIsPanning(false)
        keyRef.current = false
        mouseRef.current = false
      }, 5000)
    }

    const updatePan = (): void => {
      const shouldPan = keyRef.current && mouseRef.current
      setIsPanning((prev) => (prev === shouldPan ? prev : shouldPan))
      if (shouldPan) resetIdle()
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      // Pan trigger: Space OR Meta(Cmd) OR Control
      // - `e.code === 'Space'` → Space 키 실제 press
      // - `e.key === 'Meta'` / `'Control'` → Cmd/Ctrl 키 자체 press
      // - `e.metaKey || e.ctrlKey` → Cmd/Ctrl이 눌려있는 상태 (다른 키 press 시에도 true)
      const isPanKey =
        e.code === 'Space' || e.key === 'Meta' || e.key === 'Control' || e.metaKey || e.ctrlKey
      if (!isPanKey) return

      // 텍스트 input focused면 Space 무시 (향후 주석 입력 대비). Cmd/Ctrl은 통과.
      if (e.code === 'Space') {
        const active = document.activeElement
        const isInput =
          active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          (active as HTMLElement | null)?.isContentEditable === true
        if (isInput) return
      }
      keyRef.current = true
      updatePan()
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      // Cmd/Ctrl 떼면 metaKey/ctrlKey는 false가 됨 — key 이름 기준으로 체크
      if (e.code === 'Space' || e.key === 'Meta' || e.key === 'Control') {
        keyRef.current = false
        updatePan()
      }
    }
    const onMouseDown = (): void => {
      mouseRef.current = true
      // Key 안 눌린 일반 클릭이면 updatePan 호출 자체를 스킵 (불필요 reconcile 방지)
      if (keyRef.current) updatePan()
    }
    const onMouseUp = (): void => {
      mouseRef.current = false
      // isPanning이 true였을 때만 업데이트 필요
      if (keyRef.current) updatePan()
    }
    const onBlur = (): void => {
      keyRef.current = false
      mouseRef.current = false
      setIsPanning(false)
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('blur', onBlur)
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    }
  }, [])

  return isPanning
}
