// PRIVILEGED, LOCAL ONLY. An approved-layer recomposite, not a window screenshot.
// Caller authorizes the exact roots (same active Board/projection/profile, live grants,
// selected for pixel disclosure) and binds that entire authority/revision to isCurrent.
// No DOM insertions/clones, HTML/SVG, image sources, generic descendant traversal, or IO.
const XHTML = 'http://www.w3.org/1999/xhtml';
const PNG = 'data:image/png;base64,';
const MAX_JSON = 192 * 1024;
const NEUTRAL = '#e4e7eb';
const MAX_ITEMS = 12;
const MAX_WORK = 14000;
const px = (value) => typeof value === 'string' && /^-?\d+(?:\.\d+)?px$/.test(value) ? parseFloat(value) : 0;
const unit = (x) => Math.min(1, Math.max(0, x));
const valid = (r) => r && [r.x, r.y, r.width, r.height, r.x + r.width, r.y + r.height]
  .every((v) => Number.isFinite(v) && Math.abs(v) <= 1000000) && r.width > 0 && r.height > 0;
const sameRect = (a, b) => a && b && ['x','y','width','height'].every(k => a[k] === b[k]);
const right = r => r.x + r.width;
const bottom = r => r.y + r.height;
function intersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = { x, y, width: Math.min(right(a), right(b)) - x, height: Math.min(bottom(a), bottom(b)) - y };
  return valid(r) ? r : null;
}
const readRect = n => { const r = n.getBoundingClientRect(); return valid(r) ? r : null; };
function is(n, tag, cls, testid) {
  return n?.namespaceURI === XHTML && n.localName === tag && (!cls || n.classList.contains(cls)) &&
    (!testid || n.dataset?.testid === testid);
}
const children = n => n?.children || [];
const child = (n, ...args) => Array.prototype.find.call(children(n), x => is(x, ...args));
const approvedRoot = (n, layer, document) => is(n, 'div', 'egd-joint-window', 'joint-card') &&
  n.classList.contains('egd-canvas-card') && n.classList.contains('egd-desk-window') &&
  n.ownerDocument === document && n.isConnected && n.parentElement === layer &&
  n.dataset.jointManaged === 'card' && n.dataset.jointScope === 'board' && n.dataset.deskWindowKind === 'joint-card' &&
  typeof n.dataset.projectionId === 'string' && !!n.dataset.projectionId && n._jointShell?.root === n &&
  !n.hasAttribute('data-capture-private') && !n.hasAttribute('data-private') && !n.isContentEditable;

// Copy only browser-resolved literal colors, never URL/image/var()/arbitrary CSS.
function color(value, fallback = '') {
  return typeof value === 'string' && value.length <= 120 &&
    /^(?:transparent|#[a-f\d]{3,8}|(?:rgba?|color|oklch|oklab|lab|lch)\([\w.,%+ /-]+\))$/i.test(value) ? value : fallback;
}
const clear = (c) => !c || c === 'transparent' || /(?:,\s*0(?:\.0+)?|\/\s*0(?:\.0+)?%?)\)$/.test(c);
const SAFE_FONT = /^(?:-apple-system|blinkmacsystemfont|system-ui|apple sd gothic neo|malgun gothic|sans-serif|serif|monospace|ui-monospace|arial|helvetica(?: neue)?|segoe ui|noto sans(?: cjk kr| kr)?|times new roman|menlo|consolas)$/i;
function fontFamily(css) {
  const allowed = String(css || '').split(',').map(f => f.trim().replace(/^['"]|['"]$/g, ''))
    .filter(f => SAFE_FONT.test(f)).map(f => f.includes(' ') ? `"${f}"` : f);
  return allowed.length ? allowed.join(', ') : 'system-ui, sans-serif';
}
const HIDE_OVERFLOW = /^(hidden|clip|auto|scroll)$/;
const CAPTIONS = /^(업무 전표|공용 메모|텍스트 발췌|자료) · (내가 제공한 자료|나에게 공개됨)$/;
const MEMBERSHIP = /^공용 보드$/;
const ACTIONS = /^(공개·회신 관리|이 일 맡기|회신 쪽지 열기|회신 보냄)$/;
const APP_LABEL = /^(배송 현황|검수 체크리스트)$/;
const APP_STATE = /^(집하 대기|집하 완료|배송 완료|검수 대기|검수 통과|보류)$/;
const APP_ROLE = /^(팀 앱 꺼짐 · 저장된 상태|변경 허용|읽기 전용)$/;
// Author/account/related-card/app-ref fields are excluded by structure. Additionally omit
// entire free-text leaves containing recognizable URI/domain/address/key material, not just
// the matched substring. The caller's pixel approval still governs free-form Board prose.
const SENSITIVE = /(?:[\p{Cc}&&[^\n\r\t]]|\p{Cf}|\p{Cs})/v;
const NETWORK_OR_SECRET = /(?:\b[A-Z][A-Z0-9+.-]{1,24}:\/{1,2}|\b(?:https?|ftp|file|data|javascript|about|mailto|tel|chrome|resource|blob|moz-extension):|\b(?:www\.|localhost\b)|[\p{L}\p{N}][\p{L}\p{N}_+-]*(?:\.[\p{L}\p{N}][\p{L}\p{N}_-]*)*\.[\p{L}]{2,63}\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|(?:[a-f0-9]{0,4}:){2,}[a-f0-9]{0,4}|[@<>\\]|\b(?:bearer|password|passwd|authorization|credential|api[ _-]?key|secret(?:[ _-]?key)?|token|host(?:name)?|user(?:name)?)\s*[:=]|\b(?:sk|pk|ghp|gho|xox[baprs])[-_][\w-]+|\b(?=[a-z0-9+/_=-]{20,}\b)(?=[a-z0-9+/_=-]*\d)[a-z0-9+/_=-]+\b|\b[a-f0-9]{24,}\b|(?:호스트(?:명)?|사용자(?:명)?|비밀번호|접근 키|계정(?:명|\s*ID)?|작성자)\s*[:=])/iu;
const safeCopy = s => !SENSITIVE.test(s) && !NETWORK_OR_SECRET.test(s);
function leaf(n) {
  // Exactly one text node, as produced by the first-party renderer. Never use textContent
  // (it would aggregate unknown elements, links, form/remote content, or hidden text).
  const t = n?.firstChild;
  return t?.nodeType === 3 && !t.nextSibling && typeof t.data === 'string' ? t : null;
}
function paintable(n, style) {
  return n && !n.hasAttribute?.('data-capture-private') && !n.hasAttribute?.('data-private') && !n.hidden && !n.isContentEditable && style.display !== 'none' && style.visibility === 'visible' &&
    style.contentVisibility !== 'hidden' && Number(style.opacity) > 0;
}
function clipOverflow(n, css, r, clip, sx, sy) {
  const x = HIDE_OVERFLOW.test(css.overflowX), y = HIDE_OVERFLOW.test(css.overflowY);
  if (!x && !y) return clip;
  const left = r.x + (n.clientLeft || 0) * sx, top = r.y + (n.clientTop || 0) * sy;
  return intersect(clip, { x: x ? left : clip.x, y: y ? top : clip.y,
    width: x ? n.clientWidth * sx : clip.width, height: y ? n.clientHeight * sy : clip.height });
}
function surface(ops, n, css, r, clip, sx, sy, allowBorder = true) {
  const fill = color(css.backgroundColor);
  const radius = Math.max(0, px(css.borderTopLeftRadius) * Math.min(sx, sy));
  const sides = allowBorder ? ['Top', 'Right', 'Bottom', 'Left'].map((k, i) => {
    const c = color(css[`border${k}Color`]);
    const w = css[`border${k}Style`] === 'solid' ? px(css[`border${k}Width`]) * (i % 2 ? sx : sy) : 0;
    return w > 0 && !clear(c) ? { c, w } : null;
  }) : [];
  if (!clear(fill) || sides.some(Boolean)) ops.push({ r, clip, fill, radius, sides, opacity: unit(Number(css.opacity)) });
}
function normalizeLine(s, css, language) {
  if (!['pre', 'pre-wrap', 'break-spaces'].includes(css.whiteSpace)) s = s.replace(/[\t\r\n\f ]+/g, ' ').trim();
  if (css.textTransform === 'uppercase') return s.toLocaleUpperCase(language);
  if (css.textTransform === 'lowercase') return s.toLocaleLowerCase(language);
  return s;
}
function bounds(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(right(a), right(b)) - x, height: Math.max(bottom(a), bottom(b)) - y };
}
function textOps(env, n, css, clip, ops, sx, sy, rule, ellipsisRight) {
  const node = leaf(n), text = node?.data;
  const ink = color(css.color);
  const size = px(css.fontSize);
  if (!text || text.length > 4000 || clear(ink) || size < 5 || size > 100 ||
      (rule === true ? !safeCopy(text) : !rule.test(text))) return 0;
  const { range, segmenter, language } = env;
  const weight = /^(?:normal|bold|[1-9]\d{0,2}|1000)$/.test(css.fontWeight) ? css.fontWeight : 'normal';
  const style = /^(?:italic|oblique)$/.test(css.fontStyle) ? css.fontStyle : 'normal';
  const font = `${style} ${weight} ${size}px ${fontFamily(css.fontFamily)}`;
  const direction = css.direction === 'rtl' ? 'rtl' : 'ltr';
  let count = 0;
  const emit = (raw, r) => {
    if (!r || !intersect(r, clip)) return;
    const s = normalizeLine(raw, css, language);
    if (!s.trim()) return;
    const ellipsis = direction === 'ltr' && right(r) > ellipsisRight + 0.5 ? ellipsisRight : null;
    ops.push({ text: s, r, clip, ink, font, sx, sy, direction, ellipsis, opacity: unit(Number(css.opacity)) });
    count++;
  };
  if ((env.work += text.length) > MAX_WORK) throw Error('photo-budget');
  range.setStart(node, 0); range.setEnd(node, text.length);
  const all = [...range.getClientRects()].filter(valid);
  if (all.length === 1) { emit(text, all[0]); return count; }
  if (!all.some(r => intersect(r, clip))) return 0;
  // A whole-node range exposes line rectangles, not offsets. Measure each grapheme only
  // for wrapped/bidi runs, then raster each measured row as a full shaped text string.
  let line = null;
  const flush = () => { if (line) emit(text.slice(line.start, line.end), line.r); line = null; };
  for (const { index, segment } of segmenter.segment(text)) {
    const end = index + segment.length;
    if (/^[\r\n]+$/.test(segment) && ['pre', 'pre-wrap', 'pre-line', 'break-spaces'].includes(css.whiteSpace)) { flush(); continue; }
    range.setStart(node, index); range.setEnd(node, end);
    const r = [...range.getClientRects()].find(valid);
    if (!r) continue;
    if (line && Math.abs(line.r.y - r.y) > Math.max(0.75, sy)) flush();
    if (!line) line = { start: index, end, r };
    else { line.end = end; line.r = bounds(line.r, r); }
  }
  flush();
  return count;
}
function collect(env, root, viewport, memo, requireBody) {
  const { window } = env, sh = memo ? root._deskWindowShell : root._jointShell, slots = sh.slots;
  const header = slots?.header, topbar = slots?.topbar, identity = slots?.identity, body = slots?.content;
  if (!(header?.parentElement === root && topbar?.parentElement === header && identity?.parentElement === topbar &&
      body?.parentElement === root && is(header, 'div', 'egd-card-header') && is(topbar, 'div', 'egd-card-topbar') &&
      is(identity, 'div', 'egd-desk-window-identity') && is(body, 'div', memo ? 'egd-memo-card-body' : 'egd-joint-body'))) return null;
  const rect = readRect(root), css = window.getComputedStyle(root);
  if (!rect || !paintable(root, css)) return null;
  const vis = intersect(rect, viewport);
  if (!vis) return null;
  // The canvas camera uses a translation + uniform scale. Measure its scale in client px.
  const sx = rect.width / root.offsetWidth, sy = rect.height / root.offsetHeight;
  if (!(sx >= .08 && sy >= .08 && sx <= 8 && sy <= 8 && Math.abs(sx - sy) <= .045 * Math.max(sx, sy))) return null;
  const ops = [];
  let usefulText = 0, memoBodyText = false;
  surface(ops, root, css, rect, vis, sx, sy);
  const rootClip = clipOverflow(root, css, rect, vis, sx, sy);
  function box(n, clip, { rule, meaningful = rule === true, boxColor = false, sub } = {}) {
    if (!n || !clip) return;
    const s = window.getComputedStyle(n);
    if (!paintable(n, s)) return;
    const r = readRect(n);
    if (!r || !intersect(r, clip)) return;
    if (boxColor) surface(ops, n, s, r, clip, sx, sy);
    const next = clipOverflow(n, s, r, clip, sx, sy);
    if (!next) return;
    if (rule) {
      const ellipsisRight = s.textOverflow === 'ellipsis' && HIDE_OVERFLOW.test(s.overflowX)
        ? r.x + (n.clientWidth + (n.clientLeft || 0)) * sx - px(s.paddingRight) * sx : Infinity;
      const count = textOps(env, n, s, next, ops, sx, sy, rule, ellipsisRight);
      if (meaningful) usefulText += count;
    }
    sub?.(next, s, r);
  }
  box(header, rootClip, { boxColor: true, sub: hc => box(topbar, hc, { boxColor: true, sub: tc => {
    const dots = child(child(topbar, 'div', 'egd-card-dots-shell'), 'div', 'egd-card-dots');
    for (const [k, cls] of [['close','close'], ['minimize','min'], ['maximize','max']]) {
      const n = sh.controls?.[k];
      if (dots && n?.parentElement === dots && is(n, 'span', 'egd-card-dot-' + cls)) box(n, tc, { boxColor: true });
    }
    box(identity, tc, { sub: ic => box(child(identity, 'strong', memo ? 'egd-memo-title' : null), ic, { rule: memo ? /^메모(?: #\d+)?$/ : true }) });
  } }) });
  const titleText = usefulText;
  box(body, rootClip, { boxColor: true, sub: bc => {
    if (memo) {
      const wrap = child(body, 'div', 'egd-memo-body'), editor = memo.editor;
      if (!wrap || editor.parentElement !== wrap || !is(editor, 'textarea', 'egd-memo-text', 'memo-text')) return;
      box(wrap, bc, { sub: wc => box(editor, wc, { boxColor: true, sub: (_ec, s, r) => {
        const ink = color(s.color), size = px(s.fontSize), line = px(s.lineHeight);
        const inner = { x: r.x + (editor.clientLeft + px(s.paddingLeft)) * sx,
          y: r.y + (editor.clientTop + px(s.paddingTop)) * sy,
          width: (editor.clientWidth - px(s.paddingLeft) - px(s.paddingRight)) * sx,
          height: (editor.clientHeight - px(s.paddingTop) - px(s.paddingBottom)) * sy };
        const clip = valid(inner) && intersect(wc, inner);
        // Match the normal native textarea layout. Suppress unsupported writing modes,
        // scrolling and unusual shaping rather than disclose text not presently shown.
        if (!clip || clear(ink) || size < 5 || size > 100 || line < size || line > 150 ||
            s.writingMode !== 'horizontal-tb' || s.direction !== 'ltr' || s.textTransform !== 'none' ||
            !/^(?:left|start)$/.test(s.textAlign) || s.whiteSpace !== 'pre-wrap' ||
            editor.scrollLeft !== 0 || editor.scrollTop !== 0) return;
        if ((env.work += memo.text.length) > MAX_WORK) throw Error('photo-budget');
        const weight = /^(?:normal|bold|[1-9]\d{0,2}|1000)$/.test(s.fontWeight) ? s.fontWeight : 'normal';
        const style = /^(?:italic|oblique)$/.test(s.fontStyle) ? s.fontStyle : 'normal';
        const font = `${style} ${weight} ${size}px ${fontFamily(s.fontFamily)}`;
        ops.push({ memoText: memo.text, r: inner, clip, ink, font, sx, sy, line,
          opacity: unit(Number(s.opacity) * Number(window.getComputedStyle(body).opacity)) });
        memoBodyText = true;
      } }) });
      return;
    }
    for (const n of children(body)) {
      if (is(n, 'h3')) box(n, bc, { rule: true });
      else if (is(n, 'p', 'egd-joint-text')) box(n, bc, { rule: true });
      else if (is(n, 'div', 'egd-joint-caption')) box(n, bc, { rule: CAPTIONS });
      else if (is(n, 'button', 'egd-joint-membership', 'joint-membership'))
        box(n, bc, { boxColor: true, sub: c => box(child(n, 'strong'), c, { rule: MEMBERSHIP }) });
      else if (is(n, 'section', 'egd-joint-app-paper', 'joint-app-paper'))
        box(n, bc, { boxColor: true, sub: c => {
          const meta = child(n, 'div', 'egd-joint-app-meta');
          box(meta, c, { sub: mc => box(child(meta, 'small'), mc, { rule: APP_LABEL }) });
          box(child(n, 'strong', 'egd-joint-app-state', 'joint-app-state'), c, { rule: APP_STATE, meaningful: true });
          box(child(n, 'small', null, 'joint-app-role'), c, { rule: APP_ROLE });
        } });
      else if (is(n, 'div', 'egd-joint-actions')) box(n, bc, { sub: c => {
        for (const a of children(n)) if (is(a, 'span') || is(a, 'button', 'egd-joint-button') &&
            ['joint-item-manage', 'joint-claim', 'joint-draft'].includes(a.dataset.testid))
          box(a, c, { boxColor: true, rule: ACTIONS });
      } });
    }
  } });
  // Unsupported/empty/semantic-proxy-only cards cannot become boxes in a successful photo.
  if (!(memo ? memoBodyText : usefulText > (requireBody ? titleText : 0)) || !ops.length) return null;
  const z = /^-?\d+$/.test(css.zIndex) ? Number(css.zIndex) : 0;
  return { ops, root, rect, z };
}
function pathRect(ctx, r, radius = 0) {
  ctx.beginPath();
  if (radius && typeof ctx.roundRect === 'function') ctx.roundRect(r.x, r.y, r.width, r.height, Math.min(radius, r.width / 2, r.height / 2));
  else ctx.rect(r.x, r.y, r.width, r.height);
}
// No live painting: text is supplied by the saved memo record. Wrap with the native
// canvas font metrics; make line/block clipping explicit and never render scrolled text.
function drawMemo(ctx, op) {
  ctx.font = op.font;
  ctx.direction = 'ltr';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = op.ink;
  const metrics = ctx.measureText('Mg');
  const a = Number.isFinite(metrics.fontBoundingBoxAscent) ? metrics.fontBoundingBoxAscent : .7 * op.line;
  const d = Number.isFinite(metrics.fontBoundingBoxDescent) ? metrics.fontBoundingBoxDescent : .2 * op.line;
  const baseline = (op.line - a - d) / 2 + a;
  const width = op.r.width / op.sx, height = op.r.height / op.sy;
  const start = (op.clip.y - op.r.y) / op.sy, end = (bottom(op.clip) - op.r.y) / op.sy;
  const graphemes = new Intl.Segmenter('ko', { granularity: 'grapheme' });
  const words = new Intl.Segmenter('ko', { granularity: 'word' });
  let y = 0, row = '', drew = false;
  ctx.translate(op.r.x, op.r.y); ctx.scale(op.sx, op.sy);
  const emit = () => {
    if (y < end && y < height && y + op.line > start && row.trim() && op.opacity >= .1) {
      ctx.fillText(row, 0, y + baseline, width);
      drew = true;
    }
    row = ''; y += op.line;
  };
  for (const paragraph of op.memoText.split('\n')) {
    for (const { segment } of words.segment(paragraph)) {
      if (y >= end || y >= height) return drew;
      if (ctx.measureText(row + segment).width <= width) { row += segment; continue; }
      if (row) emit();
      if (ctx.measureText(segment).width <= width) { row = segment; continue; }
      for (const { segment: g } of graphemes.segment(segment)) {
        if (row && ctx.measureText(row + g).width > width) emit();
        if (y >= end || y >= height) return drew;
        row += g;
      }
    }
    emit();
    if (y >= end || y >= height) break;
  }
  return drew;
}
function draw(ctx, op) {
  const { r } = op;
  ctx.save();
  pathRect(ctx, op.clip); ctx.clip();
  ctx.globalAlpha = op.opacity;
  if (op.memoText !== undefined) {
    const drew = drawMemo(ctx, op);
    ctx.restore();
    return drew;
  }
  if (op.text === undefined) {
    pathRect(ctx, r, op.radius); ctx.clip();
    if (!clear(op.fill)) { ctx.fillStyle = op.fill; ctx.fillRect(r.x, r.y, r.width, r.height); }
    for (const [i, side] of op.sides.entries()) if (side) {
      const { c, w } = side;
      ctx.fillStyle = c;
      if (i === 0 || i === 2) ctx.fillRect(r.x, i === 0 ? r.y : bottom(r) - w, r.width, w);
      else ctx.fillRect(i === 3 ? r.x : right(r) - w, r.y, w, r.height);
    }
  } else {
    ctx.font = op.font;
    ctx.direction = op.direction;
    ctx.textAlign = op.direction === 'rtl' ? 'right' : 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = op.ink;
    const { fontBoundingBoxAscent: a, fontBoundingBoxDescent: d } = ctx.measureText(op.text);
    const ascent = Number.isFinite(a) ? a * op.sy : .8 * r.height;
    const descent = Number.isFinite(d) ? d * op.sy : .2 * r.height;
    const baseline = r.y + (r.height - ascent - descent) / 2 + ascent;
    const width = r.width / op.sx;
    ctx.translate(op.direction === 'rtl' ? right(r) : r.x, baseline);
    ctx.scale(op.sx, op.sy);
    if (op.ellipsis !== null) {
      const room = (op.ellipsis - r.x) / op.sx;
      const mark = ctx.measureText('…').width;
      if (room > mark) {
        const points = Array.from(op.text);
        let lo = 0, hi = points.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (ctx.measureText(points.slice(0, mid).join('')).width <= room - mark) lo = mid;
          else hi = mid - 1;
        }
        ctx.fillText(points.slice(0, lo).join('') + '…', 0, 0, room);
      }
    } else ctx.fillText(op.text, 0, 0, width);
  }
  ctx.restore();
}

export function captureLayoutPhoto(params) { return capturePositivePhoto(params); }

// Internal sibling-module adapter. The legacy public entry point never accepts
// adapted roots or crosses projections. Keep caller authority separate from paint.
export async function capturePositivePhoto({ document, window, items, viewport, isCurrent } = {}, desk) {
  let canvas, env;
  try {
    if (!document || document.defaultView !== window || typeof isCurrent !== 'function' || isCurrent() !== true ||
        !Array.isArray(items) || !items.length || items.length > MAX_ITEMS || !valid(viewport)) return null;
    // This browser's privacy/document scope is established by the privileged caller, not by
    // content attributes. The remaining positive gate requires exact first-party shell/surface.
    const layer = document.getElementById('egd-canvas-layer');
    if (!layer?.isConnected || layer.ownerDocument !== document || !paintable(layer, window.getComputedStyle(layer))) return null;
    const first = items[0]?.root, projection = first?.dataset?.projectionId;
    const roots = new Set(), slots = new Set(), selected = [];
    const workplane = desk && document.getElementById('egd-canvas-viewport');
    const planeCurrent = () => !desk || (is(workplane, 'div') && workplane.isConnected &&
      workplane.ownerDocument === document && layer.parentElement === workplane &&
      document.getElementById('egd-canvas-layer') === layer &&
      document.getElementById('egd-canvas-viewport') === workplane &&
      paintable(workplane, window.getComputedStyle(workplane)) && paintable(layer, window.getComputedStyle(layer)));
    if (!planeCurrent()) return null;
    const eligible = entry => {
      if (!desk) return approvedRoot(entry.root, layer, document) && entry.root.dataset.projectionId === projection;
      const { root, kind, projectionId, slot } = entry;
      const nativeJoint = approvedRoot(root, layer, document);
      if (kind === 'joint-card' ? !nativeJoint : kind !== 'memo' || !desk.memoRoot(root, layer, document)) return false;
      if ((root.dataset.projectionId || null) !== projectionId) return false;
      return desk.authorize({ root, kind, projectionId, slot }) === true;
    };
    for (const item of items) {
      const { root, slot } = item || {};
      const entry = { root, slot, kind: item?.kind, projectionId: item?.projectionId };
      if (roots.has(root) || !eligible(entry) ||
          !((typeof slot === 'string' && slot.length > 0 && slot.length <= 64) || Number.isSafeInteger(slot)) || slots.has(slot)) return null;
      roots.add(root); slots.add(slot); selected.push(entry);
    }
    const requested = { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height };
    // Microtask checkpoint permits invalidation before any approved pixels are read.
    await Promise.resolve();
    if (isCurrent() !== true || !planeCurrent() || !selected.every(eligible)) return null;
    const plane = desk && readRect(workplane);
    const frame = desk ? plane && intersect(requested, plane) : requested;
    if (!frame) return null;
    const language = 'ko';
    env = { window, range: document.createRange(), language, segmenter: new Intl.Segmenter(language, { granularity: 'grapheme' }), work: 0 };
    const cards = selected.map(entry => {
      if (!eligible(entry)) return null;
      const memo = desk && entry.kind === 'memo' ? desk.readMemo(entry.root, document) : null;
      if (desk && entry.kind === 'memo' && (!memo || !safeCopy(memo.text))) return null;
      const card = collect(env, entry.root, frame, memo, !!desk);
      return card && { ...card, memo };
    });
    if (!cards.every(Boolean) || isCurrent() !== true) return null;
    cards.sort((a, b) => a.z - b.z || ((a.root.compareDocumentPosition(b.root) & 4) ? -1 : 1));
    canvas = document.createElementNS(XHTML, 'canvas');
    if (!canvas || canvas.isConnected) return null;
    let scale = Math.min(1, 768 / frame.width, 512 / frame.height);
    for (let tryNo = 0; tryNo < 4; tryNo++, scale *= .73) {
      const width = Math.floor(frame.width * scale), height = Math.floor(frame.height * scale);
      if (width < 48 || height < 36 || isCurrent() !== true) return null;
      canvas.width = width; canvas.height = height;
      const ctx = desk ? canvas.getContext('2d') : canvas.getContext('2d', { alpha: false });
      if (!ctx) return null;
      ctx.fillStyle = NEUTRAL; ctx.fillRect(0, 0, width, height);
      ctx.scale(width / frame.width, height / frame.height);
      ctx.translate(-frame.x, -frame.y);
      for (const card of cards) {
        let bodyDrew = false;
        for (const op of card.ops) if (draw(ctx, op)) bodyDrew = true;
        if (card.memo && !bodyDrew) return null;
      }
      const image = canvas.toDataURL('image/png');
      if (!image.startsWith(PNG + 'iVBORw0KGgo')) return null;
      if (image.length + 80 > MAX_JSON) continue;
      await Promise.resolve();
      return isCurrent() === true && planeCurrent() && selected.every(eligible) &&
        (!desk || sameRect(plane, readRect(workplane))) && cards.every(card => {
        if (desk && (!sameRect(card.rect, readRect(card.root)) ||
            (Number(window.getComputedStyle(card.root).zIndex) || 0) !== card.z)) return false;
        if (!card.memo) return true;
        const latest = desk.readMemo(card.root, document);
        return latest && latest.record === card.memo.record && latest.editor === card.memo.editor &&
          latest.revision === card.memo.revision && latest.text === card.memo.text;
      }) ? { image, width, height } : null;
    }
  } catch {
    // Missing native capabilities, render mismatches, stale roots or limits => manual choice.
  } finally {
    // Detached pixel buffer is one-shot, including timeout/revocation/failure paths.
    if (canvas && !canvas.isConnected) { canvas.width = 0; canvas.height = 0; }
  }
  return null;
}
