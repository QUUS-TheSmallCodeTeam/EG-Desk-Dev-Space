/* One synchronous, read-only observation of caller-authorized Joint Board chrome elements. */
export const SPATIAL_AUDIT_LIMITS = Object.freeze({ items: 120, controlsPerItem: 8,
  overlapsPerItem: 16, ancestors: 64, samplesPerTarget: 18 });
const ROLES = new Set(['title','manage','change','change-alternate','claim','reply', 'reply-button', 'open', 'close', 'minimize', 'maximize', 'restore',
  'expand', 'collapse', 'send', 'pin', 'unpin']);
const FRACTIONS = [0.2, 0.5, 0.8];
const OVERFLOW = new Set(['auto', 'scroll', 'hidden', 'clip']);

export function spatialSlot(index) {
  if (!Number.isInteger(index) || index < 0 || index >= SPATIAL_AUDIT_LIMITS.items) return null;
  let slot = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    slot = String.fromCharCode(65 + (n - 1) % 26) + slot;
  }
  return slot;
}

function rectOf(r) {
  if (!r) return null;
  const { left, top, right, bottom } = r;
  return [left, top, right, bottom].every(Number.isFinite) && right >= left && bottom >= top
    ? { left, top, right, bottom } : null;
}
const area = r => !!r && r.right > r.left && r.bottom > r.top;
export function intersectSpatialRects(a, b) {
  if (!a || !b) return null;
  const result = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return area(result) ? result : null;
}
const sameRect = (a, b) => !!a && !!b && a.left === b.left && a.top === b.top &&
  a.right === b.right && a.bottom === b.bottom;
const extent = (r, clip) => !r ? 'unknown' : !area(r) ? 'no-area' : !clip ? 'full' : sameRect(r, clip) ? 'inside' : 'partial';
const pointInside = (r, x, y) => area(r) && x >= r.left && y >= r.top && x < r.right && y < r.bottom;

export function spatialSamplePoints(rect, available) {
  if (!area(rect)) return [];
  const points = [];
  const addGrid = r => {
    for (const fy of FRACTIONS) for (const fx of FRACTIONS) {
      const x = r.left + (r.right - r.left) * fx, y = r.top + (r.bottom - r.top) * fy;
      if (!points.some(p => p.x === x && p.y === y)) points.push({ x, y });
    }
  };
  addGrid(rect);
  if (area(available) && !points.some(p => pointInside(available, p.x, p.y))) addGrid(available);
  return points;
}

function inDocument(document, node) {
  return !!node && node.nodeType === 1 && node.ownerDocument === document;
}
function supportedTransform(css) {
  if ((css.perspective && css.perspective !== 'none') || (css.rotate && css.rotate !== 'none') ||
      (css.scale && css.scale !== 'none')) return false;
  if (!css.transform || css.transform === 'none') return true;
  const m = /^matrix\(([^)]+)\)$/.exec(css.transform)?.[1].split(',').map(Number);
  return m?.length === 6 && m.every(Number.isFinite) && m[0] > 0 && m[3] > 0 && m[1] === 0 && m[2] === 0;
}
const nonNone = val => !!val && val !== 'none';
function containingBlock(css, fixed) {
  return (!fixed && !!css.position && css.position !== 'static') ||
    [css.transform, css.translate, css.rotate, css.scale, css.perspective, css.filter,
      css.backdropFilter].some(nonNone) || /\b(layout|paint|strict|content)\b/.test(css.contain || '') ||
    /\b(transform|translate|rotate|scale|perspective|filter|backdrop-filter|contain)\b/.test(css.willChange || '') ||
    (!!css.contentVisibility && css.contentVisibility !== 'visible') ||
    (!!css.containerType && css.containerType !== 'normal');
}

function parentClip(document, rect, chain, capped) {
  // The root scrolling box is accounted for in viewport; HTML body overflow may propagate to it.
  const html = document.documentElement;
  const htmlCss = chain.find(entry => entry.node === html)?.css;
  const clipParents = [];
  for (let i = 1; i < chain.length; i++) {
    const { node, css } = chain[i];
    if (!(OVERFLOW.has(css.overflowX) || OVERFLOW.has(css.overflowY)) || node === html ||
        css.display === 'inline' || css.display === 'contents') continue;
    if (node === document.body && htmlCss?.overflowX === 'visible' && htmlCss?.overflowY === 'visible') {
      if ([css.contain, htmlCss.contain].some(nonNone)) return { known: false, clip: null };
      continue;
    }
    // Positioned descendants may escape an overflow box between them and their containing block.
    // Don't turn that ambiguity into a definitive clip, even if the AABBs suggest one.
    const mayEscape = chain.slice(0, i).some(({ css: lower }, child) => {
      if (lower.position !== 'fixed' && lower.position !== 'absolute') return false;
      return !chain.slice(child + 1, i + 1).some(({ css: middle }) => containingBlock(middle, lower.position === 'fixed'));
    });
    if (mayEscape) return { known: false, clip: null };
    clipParents.push({ node, css, i });
  }
  if (capped) return { known: false, clip: null };
  let clip = rect;
  for (const { node, css, i } of clipParents) {
    if (![css.overflowClipMargin, css.borderTopLeftRadius, css.borderTopRightRadius,
      css.borderBottomLeftRadius, css.borderBottomRightRadius].every(s => !s || s === '0px' || s === '0px 0px') ||
        chain.slice(i).some(({ css: upper }) => !supportedTransform(upper))) return { known: false, clip: null };
    const box = rectOf(node.getBoundingClientRect());
    const { offsetWidth, offsetHeight, clientLeft, clientTop, clientWidth, clientHeight } = node;
    if (!box || ![offsetWidth, offsetHeight, clientLeft, clientTop, clientWidth, clientHeight].every(Number.isFinite) ||
        offsetWidth <= 0 || offsetHeight <= 0) return { known: false, clip: null };
    const sx = (box.right - box.left) / offsetWidth, sy = (box.bottom - box.top) / offsetHeight;
    clip = intersectSpatialRects(clip, {
      left: OVERFLOW.has(css.overflowX) ? box.left + clientLeft * sx : -Infinity,
      right: OVERFLOW.has(css.overflowX) ? box.left + (clientLeft + clientWidth) * sx : Infinity,
      top: OVERFLOW.has(css.overflowY) ? box.top + clientTop * sy : -Infinity,
      bottom: OVERFLOW.has(css.overflowY) ? box.top + (clientTop + clientHeight) * sy : Infinity,
    });
  }
  return { known: true, clip };
}

const blankSamples = () => ({ planned: 0, offscreen: 0, clipped: 0, hit: 0, miss: 0, unknown: 0, obscuredHits: 0 });
function baseTarget(mount, code) {
  return { mount, visibility: 'unknown', action: 'unknown', pointerEvents: 'unknown', viewport: 'unknown',
    overflowClip: 'unknown', samples: blankSamples(), reachability: 'unknown', warnings: code ? [code] : [] };
}
function readTarget(document, node, viewport, styleFor) {
  if (!node) return { public: baseTarget('unmounted', 'TARGET_UNMOUNTED') };
  if (!inDocument(document, node)) return { public: baseTarget('unknown', 'TARGET_OUT_OF_SCOPE') };
  if (!node.isConnected) return { public: baseTarget('unmounted', 'TARGET_UNMOUNTED') };
  const out = baseTarget('mounted');
  let rect;
  try {
    // The adapter intentionally doesn't traverse shadow trees or cross a document boundary.
    if (node.getRootNode() !== document) return { public: baseTarget('mounted', 'TARGET_TREE_UNSUPPORTED') };
    const chain = [];
    let current = node;
    while (current && chain.length < SPATIAL_AUDIT_LIMITS.ancestors) {
      chain.push({ node: current, css: styleFor(current) });
      current = current.parentElement;
    }
    const capped = !!current;
    if (capped) out.warnings.push('ANCESTOR_LIMIT_REACHED');
    const css = chain[0].css;
    const hidden = css.visibility === 'hidden' || css.visibility === 'collapse' || chain.some(entry =>
      entry.css.display === 'none' || (entry.css.opacity !== '' && Number(entry.css.opacity) === 0)) ||
      chain.slice(1).some(entry => entry.css.contentVisibility === 'hidden');
    out.visibility = hidden ? 'hidden' : capped ? 'unknown' : 'visible';
    if (hidden) out.warnings.push('TARGET_HIDDEN');
    const inert = chain.some(entry => entry.node.hasAttribute('inert'));
    const disabled = node.matches(':disabled') || chain.some(entry => entry.node.getAttribute('aria-disabled') === 'true');
    out.action = inert ? 'inert' : disabled ? 'disabled' : capped ? 'unknown' : 'not-disabled';
    if (inert) out.warnings.push('TARGET_INERT');
    if (disabled) out.warnings.push('TARGET_DISABLED');
    out.pointerEvents = css.pointerEvents === 'none' ? 'none' : css.pointerEvents ? 'other' : 'unknown';
    if (out.pointerEvents === 'none') out.warnings.push('TARGET_POINTER_EVENTS_NONE');
    rect = rectOf(node.getBoundingClientRect());
    if (!rect) throw new Error('No usable rect');
    const within = intersectSpatialRects(rect, viewport);
    out.viewport = viewport ? extent(rect, within) : 'unknown';
    if (out.viewport === 'full') out.warnings.push('VIEWPORT_OFFSCREEN');
    if (out.viewport === 'partial') out.warnings.push('VIEWPORT_PARTIAL');
    if (!area(rect)) out.warnings.push('TARGET_NO_AREA');
    const overflow = area(rect) ? parentClip(document, rect, chain, capped) : { known: true, clip: null };
    out.overflowClip = overflow.known ? extent(rect, overflow.clip) : 'unknown';
    if (!overflow.known) out.warnings.push('OVERFLOW_CLIP_UNKNOWN');
    if (out.overflowClip === 'full') out.warnings.push('OVERFLOW_FULL');
    if (out.overflowClip === 'partial') out.warnings.push('OVERFLOW_PARTIAL');
    return { public: out, rect, within, overflow, node, ancestors: new Set(chain.slice(1).map(entry => entry.node)) };
  } catch {
    out.warnings.push('TARGET_READ_UNKNOWN');
    return { public: out, rect };
  }
}

function observeTarget(document, target, viewport, knownOtherSlot) {
  const { public: out, rect, within, overflow, node, ancestors } = target;
  if (!node || !area(rect)) return;
  const sample = out.samples;
  const effective = overflow.known ? intersectSpatialRects(within, overflow.clip) : within;
  const points = spatialSamplePoints(rect, effective);
  sample.planned = points.length;
  let known;
  for (const { x, y } of points) {
    if (!viewport) { sample.unknown++; continue; }
    if (!pointInside(viewport, x, y)) { sample.offscreen++; continue; }
    const modeledClip = overflow.known && !pointInside(overflow.clip, x, y);
    try {
      const hit = document.elementFromPoint(x, y);
      if (!hit) { sample.unknown++; continue; }
      if (hit === node || node.contains(hit)) {
        sample.hit++;
        if (modeledClip && !out.warnings.includes('OVERFLOW_MODEL_DISAGREES_WITH_HIT')) {
          out.warnings.push('OVERFLOW_MODEL_DISAGREES_WITH_HIT');
        }
      } else if (modeledClip) {
        sample.clipped++;
      } else {
        sample.miss++;
        if (overflow.known && out.visibility === 'visible' && out.action === 'not-disabled' &&
            out.pointerEvents === 'other' && !ancestors.has(hit)) {
          // Sample count, never a blocker count. No styles/attrs/text/bounds read from the hit.
          sample.obscuredHits++;
          if (!known) known = knownOtherSlot(hit);
        }
      }
    } catch { sample.unknown++; }
  }
  if (known) out.knownObscuringSlot = known;
  if (out.warnings.includes('OVERFLOW_MODEL_DISAGREES_WITH_HIT')) {
    out.overflowClip = 'unknown';
    out.warnings = out.warnings.filter(code => code !== 'OVERFLOW_FULL' && code !== 'OVERFLOW_PARTIAL');
    sample.unknown += sample.clipped;
    sample.clipped = 0;
    sample.obscuredHits = 0;
    delete out.knownObscuringSlot;
  }
  // A sampled hit is not a guarantee that a command succeeds or that the entire region is reachable.
  out.reachability = sample.hit ? sample.hit === sample.planned ? 'sampled-hit' : 'partial-sampled-hit'
    : sample.unknown || !(sample.miss || sample.clipped || sample.offscreen) ? 'unknown' : 'no-sampled-hit';
  if (sample.unknown) out.warnings.push('POINTER_SAMPLE_UNKNOWN');
  if (out.reachability === 'partial-sampled-hit') out.warnings.push('POINTER_PARTIAL_SAMPLE_HIT');
  if (out.reachability === 'no-sampled-hit') out.warnings.push('POINTER_NO_SAMPLE_HIT');
  if (sample.obscuredHits) out.warnings.push('POINTER_SAMPLED_OBSCURED');
}

/**
 * `items` and `isCurrent` must come from trusted chrome code holding a single grant, not
 * model input or DOM discovery. The roots must be disjoint, board-owned light DOM elements.
 * `isCurrent()` must synchronously return true only while that grant and snapshot are current.
 */
export function readSpatialAudit({ document, items, isCurrent } = {}) {
  const curr = () => { try { return isCurrent() === true; } catch { return false; } };
  const unavailable = code => ({ version: 1, status: code === 'OBSERVATION_NOT_CURRENT' ? 'stale' : 'unknown',
    warnings: [code], items: [] });
  if (!curr()) return unavailable('OBSERVATION_NOT_CURRENT');
  if (!Array.isArray(items) || !document?.defaultView) return unavailable('OBSERVATION_INPUT_UNKNOWN');
  const warnings = [];
  const limit = SPATIAL_AUDIT_LIMITS;
  const truncation = { items: items.length > limit.items, controls: false, overlaps: false, ancestry: false };
  if (truncation.items) warnings.push('ITEM_LIMIT_REACHED');
  const view = document.defaultView;
  const vw = document.documentElement?.clientWidth ?? view.innerWidth;
  const vh = document.documentElement?.clientHeight ?? view.innerHeight;
  const viewport = rectOf({ left: 0, top: 0, right: vw, bottom: vh });
  if (!area(viewport)) warnings.push('VIEWPORT_UNKNOWN');
  const viewportRect = area(viewport) ? viewport : null;
  const styles = new Map();
  const styleFor = node => {
    if (!styles.has(node)) styles.set(node, view.getComputedStyle(node));
    return styles.get(node);
  };
  const staged = Array.from({ length: Math.min(items.length, limit.items) }, (_, i) => {
    const input = items[i];
    return { slot: spatialSlot(i), root: input?.root, descriptors: input?.controls };
  });
  // Never attribute a hit to one of two ambiguous authorized roots. No board DOM scan.
  const candidates = staged.filter(item => inDocument(document, item.root) && item.root.isConnected);
  const invalid = new Set();
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    const a = candidates[i].root, b = candidates[j].root;
    if (a.contains(b) || b.contains(a)) { invalid.add(a); invalid.add(b); }
  }
  for (const item of staged) {
    item.target = invalid.has(item.root) ? { public: baseTarget('unknown', 'CARD_ROOT_AMBIGUOUS') }
      : readTarget(document, item.root, viewportRect, styleFor);
    item.controls = [];
    item.warnings = [];
    if (!Array.isArray(item.descriptors)) continue;
    if (item.descriptors.length > limit.controlsPerItem) {
      truncation.controls = true;
      item.warnings.push('CONTROL_LIMIT_REACHED');
    }
    const seenRoles = new Set();
    for (const control of item.descriptors.slice(0, limit.controlsPerItem)) {
      if (!ROLES.has(control?.role) || seenRoles.has(control.role)) {
        if (!item.warnings.includes('CONTROL_INPUT_IGNORED')) item.warnings.push('CONTROL_INPUT_IGNORED');
        continue;
      }
      seenRoles.add(control.role);
      const node = control.node;
      let target;
      if (item.target.public.mount !== 'mounted') {
        target = { public: item.target.public.mount === 'unmounted' ? baseTarget('unmounted', 'TARGET_UNMOUNTED')
          : baseTarget('unknown', 'CONTROL_SCOPE_UNKNOWN') };
      } else if (node && (!inDocument(document, node) || node === item.root || (node.isConnected && !item.root.contains(node)))) {
        target = { public: baseTarget('unknown', 'CONTROL_OUT_OF_SCOPE') };
      } else {
        target = readTarget(document, node, viewportRect, styleFor);
      }
      item.controls.push({ role: control.role, target });
    }
  }
  if (!curr()) return unavailable('OBSERVATION_NOT_CURRENT');
  const hitCandidates = staged.filter(item => item.target.node);
  const slotByHit = new WeakMap();
  const result = [];
  for (const item of staged) {
    const overlapSlots = [];
    let overlapTruncated = false;
    for (const other of staged) {
      if (other !== item && intersectSpatialRects(item.target.rect, other.target.rect)) {
        if (overlapSlots.length < limit.overlapsPerItem) overlapSlots.push(other.slot);
        else overlapTruncated = true;
      }
    }
    if (overlapTruncated) truncation.overlaps = true;
    const knownOtherSlot = hit => {
      if (!slotByHit.has(hit)) slotByHit.set(hit, hitCandidates.find(other => other.root.contains(hit))?.slot);
      const slot = slotByHit.get(hit);
      return slot === item.slot ? undefined : slot;
    };
    observeTarget(document, item.target, viewportRect, knownOtherSlot);
    for (const { target } of item.controls) observeTarget(document, target, viewportRect, knownOtherSlot);
    if ([item.target, ...item.controls.map(control => control.target)].some(target =>
      target.public.warnings.includes('ANCESTOR_LIMIT_REACHED'))) truncation.ancestry = true;
    result.push({ slot: item.slot, aabbOverlap: { slots: overlapSlots, truncated: overlapTruncated },
      card: item.target.public, controls: item.controls.map(({ role, target }) => ({ role, ...target.public })), warnings: item.warnings });
  }
  const observation = { version: 1, status: 'observed', limits: { ...limit }, truncation, warnings, items: result };
  return curr() ? observation : unavailable('OBSERVATION_NOT_CURRENT');
}
