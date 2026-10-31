// Pure screenshot masking policy for the Browser agent actor (BRW-09, D-B6,
// REA 웹6 / decision 3). No Gecko globals: the parent actor captures and
// paints, the child actor measures, and this module decides what may leave.
//
// Rule (2026-10-24, 대표님): a Card with an observe grant may send a
// screenshot once secret and sensitive fields, other-site frames and any
// region the actor could not read are covered. When covering fails, nothing
// is sent (fail-closed).

export const SCREENSHOT_DEFAULTS = Object.freeze({
  // Longest edge of the encoded image, in image pixels, and the smallest
  // long edge the encoder may fall back to while fitting the budget.
  maxEdge: 1280,
  minEdge: 480,
  // The UI response must stay inside the transport bound
  // (codex-browser-tool-transport.mjs: 180000 JSON characters per response).
  budgetChars: 150000,
  format: "jpeg",
  quality: 0.7,
  // CSS pixels added around every covered box, for anti-aliased edges,
  // text that overhangs its box and subpixel layout.
  marginPx: 3,
});
export const MASK_COLOR = "#000000";
// Region kinds a child report may carry and the reasons each may give.
export const MASK_REGION_KINDS = Object.freeze({
  "sensitive-field": Object.freeze(["password", "sensitive-hint", "sensitive-autocomplete"]),
  frame: Object.freeze(["cross-origin", "unreadable", "private", "depth-limit", "unscanned"]),
  "embedded-object": Object.freeze(["embedded-object"]),
});
// Reasons the child may give for an incomplete (never sendable) report.
export const MASK_INCOMPLETE_REASONS = Object.freeze(["scan-budget", "scan-failed", "rect-unavailable", "frame-transform"]);
const MAX_REGIONS = 400;
// A capture whose size differs from the viewport by at most this many pixels
// per axis is treated as the same CSS pixel grid (scrollbar area), with the
// difference added to every mask. Beyond it the capture must be a uniform
// rescale of the viewport, else nothing is sent.
const NEAR_SIZE_PX = 24;
const SCALE_TOLERANCE = 0.01;
const ENCODE_STEP = 0.8;
const FALLBACK_QUALITY = 0.5;
const MAX_ENCODE_ATTEMPTS = 8;

const finite = value => typeof value === "number" && Number.isFinite(value);
const record = value => !!value && typeof value === "object" && !Array.isArray(value);
const positiveInt = value => Number.isSafeInteger(value) && value > 0;

// HTML autocomplete tokens that name payment or one-time secrets. Any cc-*
// field token is covered (card holder name and expiry included), beyond the
// hint words the actor already treats as sensitive.
export function isSensitiveAutocomplete(value) {
  if (typeof value !== "string" || !value) return false;
  return value.trim().toLowerCase().split(/\s+/).some(token =>
    token.startsWith("cc-") || ["one-time-code", "current-password", "new-password"].includes(token));
}

// One region's cover box in integer CSS pixels of the top viewport: the
// element box grown by marginPx and clipped to the viewport. null when the
// box does not touch the viewport (nothing of it is in the capture).
export function maskRegionInViewport(rect, viewport, marginPx = SCREENSHOT_DEFAULTS.marginPx) {
  if (!record(rect) || !record(viewport)) return null;
  const { left, top, width, height } = rect;
  if (![left, top, width, height].every(finite) || width < 0 || height < 0) return null;
  if (!finite(viewport.width) || !finite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) return null;
  const margin = finite(marginPx) && marginPx >= 0 ? marginPx : SCREENSHOT_DEFAULTS.marginPx;
  const x0 = Math.max(0, Math.floor(left - margin));
  const y0 = Math.max(0, Math.floor(top - margin));
  const x1 = Math.min(viewport.width, Math.ceil(left + width + margin));
  const y1 = Math.min(viewport.height, Math.ceil(top + height + margin));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function validRegion(region) {
  if (!record(region) || !record(region.rect)) return false;
  const reasons = MASK_REGION_KINDS[region.kind];
  if (!reasons || !reasons.includes(region.reason)) return false;
  const { left, top, width, height } = region.rect;
  return [left, top, width, height].every(finite) && width >= 0 && height >= 0;
}

// Validates one child mask report. ok:false carries the reason the report
// cannot back a screenshot; ok:true carries the normalized report.
export function normalizeMaskReport(report) {
  if (!record(report)) return { ok: false, reason: "mask-unavailable" };
  if (report.complete !== true) {
    const reason = MASK_INCOMPLETE_REASONS.includes(report.incompleteReason) ? report.incompleteReason : "mask-incomplete";
    return { ok: false, reason };
  }
  if (typeof report.documentId !== "string" || !report.documentId || report.documentId.length > 160 ||
      !Number.isSafeInteger(report.revision) || report.revision < 0) return { ok: false, reason: "mask-unavailable" };
  const viewport = report.viewport;
  if (!record(viewport) || !positiveInt(viewport.width) || !positiveInt(viewport.height)) return { ok: false, reason: "viewport-unavailable" };
  if (!Array.isArray(report.regions) || report.regions.length > MAX_REGIONS || !report.regions.every(validRegion)) {
    return { ok: false, reason: "mask-unavailable" };
  }
  const identity = {};
  for (const key of ["innerWindowId", "browsingContextId"]) {
    if (Object.hasOwn(report, key)) {
      if (!positiveInt(report[key])) return { ok: false, reason: "mask-unavailable" };
      identity[key] = report[key];
    }
  }
  return { ok: true, report: { documentId: report.documentId, revision: report.revision,
    viewport: { width: viewport.width, height: viewport.height }, ...identity,
    regions: report.regions.map(region => ({ kind: region.kind, reason: region.reason,
      rect: { left: region.rect.left, top: region.rect.top, width: region.rect.width, height: region.rect.height } })) } };
}

function coverBoxes(report, marginPx) {
  const boxes = [];
  for (const region of report.regions) {
    const box = maskRegionInViewport(region.rect, report.viewport, marginPx);
    if (box) boxes.push({ ...box, kind: region.kind, reason: region.reason });
  }
  return boxes.sort((a, b) => a.y - b.y || a.x - b.x || a.width - b.width || a.height - b.height ||
    a.kind.localeCompare(b.kind) || a.reason.localeCompare(b.reason));
}

function sameBoxes(left, right) {
  return left.length === right.length && left.every((box, index) => {
    const other = right[index];
    return box.x === other.x && box.y === other.y && box.width === other.width && box.height === other.height &&
      box.kind === other.kind && box.reason === other.reason;
  });
}

// How the capture's pixel grid relates to the viewport's CSS pixel grid, or
// null when the capture is neither the viewport nor a uniform rescale of it.
function captureScale(image, viewport) {
  if (!record(image) || !positiveInt(image.width) || !positiveInt(image.height)) return null;
  const dw = image.width - viewport.width, dh = image.height - viewport.height;
  if (dw === 0 && dh === 0) return { x: 1, y: 1, extraPx: 0 };
  if (Math.abs(dw) <= NEAR_SIZE_PX && Math.abs(dh) <= NEAR_SIZE_PX) return { x: 1, y: 1, extraPx: Math.max(Math.abs(dw), Math.abs(dh)) };
  const sx = image.width / viewport.width, sy = image.height / viewport.height;
  if (Math.abs(sx - sy) > SCALE_TOLERANCE) return null;
  return { x: sx, y: sy, extraPx: 2 };
}

// Decides whether a capture taken between two child mask reports may be
// sent, and where to paint. before/after are the child reports around the
// capture; image is the captured bitmap size. Every failure withholds the
// image and names one reason.
export function screenshotDecision({ before, after, image, marginPx = SCREENSHOT_DEFAULTS.marginPx } = {}) {
  const first = normalizeMaskReport(before);
  if (!first.ok) return { send: false, reason: first.reason };
  const second = normalizeMaskReport(after);
  if (!second.ok) return { send: false, reason: second.reason };
  const a = first.report, b = second.report;
  if (a.documentId !== b.documentId) return { send: false, reason: "document-changed" };
  for (const key of ["innerWindowId", "browsingContextId"]) {
    if ((Object.hasOwn(a, key) || Object.hasOwn(b, key)) && a[key] !== b[key]) return { send: false, reason: "document-changed" };
  }
  if (a.viewport.width !== b.viewport.width || a.viewport.height !== b.viewport.height) return { send: false, reason: "viewport-changed" };
  const boxes = coverBoxes(a, marginPx);
  if (!sameBoxes(boxes, coverBoxes(b, marginPx))) return { send: false, reason: "mask-moved" };
  const scale = captureScale(image, a.viewport);
  if (!scale) return { send: false, reason: "image-size-mismatch" };
  const masks = [];
  for (const box of boxes) {
    const x0 = Math.max(0, Math.floor((box.x - scale.extraPx) * scale.x));
    const y0 = Math.max(0, Math.floor((box.y - scale.extraPx) * scale.y));
    const x1 = Math.min(image.width, Math.ceil((box.x + box.width + scale.extraPx) * scale.x));
    const y1 = Math.min(image.height, Math.ceil((box.y + box.height + scale.extraPx) * scale.y));
    if (x1 <= x0 || y1 <= y0) return { send: false, reason: "mask-unavailable" };
    masks.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  }
  return { send: true, documentId: a.documentId, revision: b.revision, viewport: { ...a.viewport },
    ...(Object.hasOwn(a, "innerWindowId") ? { innerWindowId: a.innerWindowId } : {}),
    imageScale: Math.round(Math.min(scale.x, scale.y) * 1000) / 1000, masks,
    maskedRegions: boxes.map(box => ({ kind: box.kind, reason: box.reason, bounds: { x: box.x, y: box.y, width: box.width, height: box.height } })) };
}

// Output sizes to try, largest first, until the encoded image fits the
// character budget: the long edge capped at maxEdge, then shrunk by 20%
// steps down to minEdge, and finally the smallest size at a lower quality.
export function encodeAttempts({ width, height, maxEdge = SCREENSHOT_DEFAULTS.maxEdge, minEdge = SCREENSHOT_DEFAULTS.minEdge,
  quality = SCREENSHOT_DEFAULTS.quality } = {}) {
  if (!positiveInt(width) || !positiveInt(height)) return [];
  const longEdge = Math.max(width, height);
  const cap = positiveInt(maxEdge) ? maxEdge : SCREENSHOT_DEFAULTS.maxEdge;
  const floor = positiveInt(minEdge) ? Math.min(minEdge, cap) : SCREENSHOT_DEFAULTS.minEdge;
  const q = finite(quality) && quality > 0 && quality <= 1 ? quality : SCREENSHOT_DEFAULTS.quality;
  const attempts = [];
  let factor = Math.min(1, cap / longEdge);
  while (attempts.length < MAX_ENCODE_ATTEMPTS - 1) {
    const size = { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) };
    attempts.push({ ...size, factor, quality: q });
    if (Math.max(size.width, size.height) * ENCODE_STEP < floor) break;
    factor *= ENCODE_STEP;
  }
  const last = attempts[attempts.length - 1];
  if (q > FALLBACK_QUALITY) attempts.push({ ...last, quality: FALLBACK_QUALITY });
  return attempts;
}

// Masks in capture pixels mapped onto an output canvas of width x height,
// grown outward so a downscaled edge never uncovers a capture pixel.
export function scaleMasks(masks, capture, output) {
  if (!Array.isArray(masks) || !record(capture) || !record(output) ||
      !positiveInt(capture.width) || !positiveInt(capture.height) || !positiveInt(output.width) || !positiveInt(output.height)) return null;
  const sx = output.width / capture.width, sy = output.height / capture.height;
  const scaled = [];
  for (const mask of masks) {
    if (!record(mask) || ![mask.x, mask.y, mask.width, mask.height].every(finite)) return null;
    const x0 = Math.max(0, Math.floor(mask.x * sx) - 1), y0 = Math.max(0, Math.floor(mask.y * sy) - 1);
    const x1 = Math.min(output.width, Math.ceil((mask.x + mask.width) * sx) + 1);
    const y1 = Math.min(output.height, Math.ceil((mask.y + mask.height) * sy) + 1);
    if (x1 <= x0 || y1 <= y0) return null;
    scaled.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  }
  return scaled;
}

// The data URL shape the helper accepts and whether it fits the budget.
export function fitsBudget(dataUrl, budgetChars = SCREENSHOT_DEFAULTS.budgetChars) {
  return typeof dataUrl === "string" && /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+=*$/.test(dataUrl) &&
    dataUrl.length <= (positiveInt(budgetChars) ? budgetChars : SCREENSHOT_DEFAULTS.budgetChars);
}
