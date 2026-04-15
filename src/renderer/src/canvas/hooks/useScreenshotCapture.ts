/**
 * useScreenshotCapture — DOM screenshot helper (ADR-006 §5.5, ADR-005 §5.5 shared)
 *
 * Wraps html-to-image `toPng` for DOM entities (note, chat, file-preview).
 * Returned utility is a plain async function so it can be invoked from adapters
 * or supervisor without React hook rules.
 *
 * v1: in-memory data URL. JPG quality/FS cache deferred to v2 (ADR-006 §5.5).
 */
import { toPng } from 'html-to-image'

export interface CaptureOptions {
  /** Max bitmap pixel width. Shrinks if source larger. */
  maxWidth?: number
  /** Transparent background. Default false (matches paper-surface). */
  transparent?: boolean
}

/**
 * Capture a DOM node to a PNG data URL.
 * Used by NoteAdapter.suspend / captureSnapshot, and later by ADR-005 preset pack.
 */
export async function captureDomSnapshot(
  node: HTMLElement,
  opts: CaptureOptions = {}
): Promise<string> {
  const { maxWidth = 1280, transparent = false } = opts
  const rect = node.getBoundingClientRect()
  const pixelRatio = Math.min(
    window.devicePixelRatio || 1,
    maxWidth > 0 && rect.width > 0 ? maxWidth / rect.width : 1
  )
  return toPng(node, {
    pixelRatio,
    backgroundColor: transparent ? undefined : '#faf9f6', // paper-surface fallback
    cacheBust: true,
    // Skip hydration-only overlays tagged with data-screenshot-skip
    filter: (child: HTMLElement): boolean => {
      if (!(child instanceof HTMLElement)) return true
      return !child.dataset.screenshotSkip
    }
  })
}
