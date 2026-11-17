// CNV-05: the AI Canvas annotation layer on screen.
// Loaded once per window: ChromeUtils.importESModule(url, { global: 'current' }).
// Never statically import a .sys.mjs here; shared modules arrive through deps.
//
// An Agent's AnnotationSet (helper egdesk_publish_annotation → chat event
// 'annotation.published') appears at once over its target card as a dotted
// '제안' (D-K1: the camera does not move). [받기]·[지우기] act on the whole
// set, [하나씩] on single marks. Only accepted marks are saved: with the
// target card's record (Desk session and Board), or with the Desk session for
// a free Canvas set. A chip under the answer points at the set (D-K4). Marks
// are display only: pointer events pass through to the card under them and
// their geometry is never an input coordinate. The screen-wide hide toggle
// (root data-egd-annotations-hidden) hides them through CSS. Each bar also
// has a per-card toggle ('이 카드 표식 숨기기'): it hides every AI mark on that
// card (a free Canvas set: only that set) and keeps the bar so it can come
// back. Like the screen-wide toggle it is never saved; opening a set from its
// chat chip shows it again.
//
// Stable id and API for Answer Briefing: every set keeps the id the helper
// gave it (restored sets keep their saved id unless another live set holds
// it). The layer is #egd-annotation-<safe id> with data-annotation-set-id.
// getAnnotationSet / listAnnotationSets / annotationTarget /
// revealAnnotationSet / emphasizeAnnotationSet read and point at a set
// without changing it.
export function createAnnotationZone(deps) {
  const {
    AnnotationState,
    el,
    focusCanvasCard,
    markAgendaDirty,
    revealOpenCanvasCard,
    scheduleDeskSessionSave,
    svgEl,
  } = deps;

  const ANNOTATION_SET_LIMIT = 200;
  const ANNOTATION_RESTORE_LIMIT = 64;
  const ANNOTATION_SUMMARY_MAX = 160;
  const annotationEntries = new Map();
  // Per-card hide (not saved): card elements, so a closed card's state goes with it.
  const annotationHiddenCards = new WeakSet();
  let annotationResizeObserver = null;

  const annotationSafeId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '-');
  const annotationLayerId = (id) => `egd-annotation-${annotationSafeId(id)}`;
  const annotationCopy = (value) => JSON.parse(JSON.stringify(value));

  function annotationSummaryOf(raw, set) {
    const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, ANNOTATION_SUMMARY_MAX) : '';
    return text || AnnotationState.annotationSummaryText(set);
  }

  function annotationCard(entry) {
    if (entry.set.space !== 'card') return null;
    if (entry.card?.isConnected) return entry.card;
    const found = document.getElementById(entry.set.targetCardId);
    if (found?.classList?.contains('egd-canvas-card')) {
      entry.card = found;
      // A proposal that meets its card later takes that page as its own.
      if (!entry.restored && !entry.receivedUri) entry.receivedUri = annotationBrowserUri(found);
      return found;
    }
    return null;
  }

  function annotationBrowserUri(card) {
    try {
      const uri = card?._browserControls?.getState?.()?.uri;
      return typeof uri === 'string' && uri ? uri : null;
    } catch { return null; }
  }

  // The screen cannot ask the page for its document identity. It keeps the
  // Browser card address seen when the set first met its card: the same address counts
  // as the observed document, another address as another document, and no
  // record (a restored set) as unknown, as AI_CANVAS_ANNOTATION_LAYER.md says.
  function annotationCurrent(entry, card) {
    const source = entry.set.source;
    if (!source?.documentId) return undefined;
    const uri = annotationBrowserUri(card);
    if (!card || !uri || !entry.receivedUri) return null;
    if (uri !== entry.receivedUri) return { documentId: `address:${uri}` };
    return {
      documentId: source.documentId,
      ...(Number.isSafeInteger(source.revision) ? { revision: source.revision } : {}),
      ...(source.viewport ? { viewport: { ...source.viewport } } : {}),
      ...(source.scroll ? { scroll: { ...source.scroll } } : {}),
    };
  }

  // Marks sit in the card's content: the scaled Browser page (1440-wide
  // logical wrap) or the window body. Controls stay unscaled in the body.
  function annotationMarkHost(card) {
    return card.querySelector('.egd-card-wrap') || card.querySelector('.egd-card-body') || card;
  }
  function annotationBarHost(card) {
    return card.querySelector('.egd-card-body') || card;
  }
  function annotationHostScale(host) {
    const match = /scale\(\s*([0-9.]+)/.exec(host?.style?.transform || '');
    const scale = match ? Number(match[1]) : 1;
    return Number.isFinite(scale) && scale > 0.01 ? scale : 1;
  }
  function annotationHostRect(host) {
    const width = host.offsetWidth || parseFloat(host.style?.width) || 0;
    const height = host.offsetHeight || parseFloat(host.style?.height) || 0;
    return { x: 0, y: 0, width, height };
  }

  function annotationTitle(item) {
    const parts = [item.label, item.note].filter(Boolean);
    if (Number.isFinite(item.confidence)) parts.push(`확신 ${Math.round(item.confidence * 100)}%`);
    if (item.status === 'proposed') parts.push('AI 제안');
    return parts.join(' · ');
  }

  function annotationMarkNodes(projected, ink, markerId) {
    const common = {
      class: `egd-annotation-mark egd-annotation-mark-${projected.type}`,
      'stroke-width': String(2 * ink),
      data: { annotationItemId: projected.id, status: projected.status },
    };
    const title = annotationTitle(projected);
    const withTitle = (node) => { if (title) node.appendChild(svgEl('title', {}, title)); return node; };
    const nodes = [];
    if (projected.rect) {
      const { x, y, width, height } = projected.rect;
      const dash = projected.status === 'proposed' ? `${6 * ink} ${4 * ink}` : null;
      if (projected.type === 'ellipse') {
        nodes.push(withTitle(svgEl('ellipse', { ...common, cx: String(x + width / 2), cy: String(y + height / 2),
          rx: String(width / 2), ry: String(height / 2), 'stroke-dasharray': dash })));
      } else {
        nodes.push(withTitle(svgEl('rect', { ...common, x: String(x), y: String(y), width: String(width), height: String(height),
          rx: String(3 * ink), 'stroke-dasharray': projected.type === 'highlight' ? null : dash })));
      }
    } else if (projected.line) {
      const { x1, y1, x2, y2 } = projected.line;
      nodes.push(withTitle(svgEl('line', { ...common, x1: String(x1), y1: String(y1), x2: String(x2), y2: String(y2),
        'stroke-dasharray': projected.status === 'proposed' ? `${6 * ink} ${4 * ink}` : null,
        'marker-end': projected.type === 'arrow' ? `url(#${markerId})` : null })));
    }
    return nodes;
  }

  function annotationLabelNode(projected, ink) {
    const at = projected.point || (projected.rect ? { x: projected.rect.x, y: projected.rect.y }
      : projected.line ? { x: projected.line.x1, y: projected.line.y1 } : null);
    if (!at || !projected.label) return null;
    const above = projected.type !== 'label';
    return el('span', {
      class: `egd-annotation-label${above ? ' egd-annotation-label-tag' : ''}`,
      title: annotationTitle(projected),
      data: { annotationItemId: projected.id, status: projected.status },
      style: { left: `${at.x}px`, top: `${at.y}px`, fontSize: `${12 * ink}px`, padding: `${1 * ink}px ${5 * ink}px`,
        borderRadius: `${4 * ink}px`, borderWidth: `${1 * ink}px`, transform: above ? 'translateY(-100%)' : null },
    }, projected.label);
  }

  function annotationRemoveViews(entry) {
    entry.layer?.remove();
    entry.bar?.remove();
    entry.layer = null;
    entry.bar = null;
  }

  function annotationObserve(card) {
    if (typeof ResizeObserver !== 'function') return;
    annotationResizeObserver ||= new ResizeObserver((records) => {
      const cards = new Set(records.map(record => record.target.closest?.('.egd-canvas-card')).filter(Boolean));
      const rerender = () => {
        for (const entry of annotationEntries.values()) if (cards.has(entry.card)) annotationRender(entry);
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(rerender);
      else rerender();
    });
    const body = annotationBarHost(card);
    if (body._egdAnnotationObserved) return;
    body._egdAnnotationObserved = true;
    annotationResizeObserver.observe(body);
  }

  function annotationBarStack(parent) {
    let stack = Array.from(parent.children).find(child => child.classList?.contains('egd-annotation-bars'));
    if (!stack) {
      stack = el('div', { class: 'egd-annotation-bars', data: { testid: 'annotation-bars' } });
      parent.appendChild(stack);
    }
    return stack;
  }

  function annotationIsHidden(entry, card = annotationCard(entry)) {
    return entry.set.space === 'card' ? !!card && annotationHiddenCards.has(card) : !!entry.hidden;
  }

  function annotationSetHidden(entry, hidden) {
    const card = annotationCard(entry);
    if (entry.set.space === 'card') {
      if (!card) return false;
      if (hidden) annotationHiddenCards.add(card); else annotationHiddenCards.delete(card);
      refreshAnnotations(card);
    } else {
      entry.hidden = !!hidden;
      annotationRender(entry);
    }
    return true;
  }

  function annotationRender(entry) {
    const status = AnnotationState.annotationSetStatus(entry.set);
    const card = annotationCard(entry);
    if (status === 'dismissed' || (entry.set.space === 'card' && !card)) { annotationRemoveViews(entry); return; }
    let markHost, barParent, contentRect, ink = 1;
    if (entry.set.space === 'card') {
      markHost = annotationMarkHost(card);
      barParent = annotationBarHost(card);
      contentRect = annotationHostRect(markHost);
      ink = 1 / annotationHostScale(markHost);
      annotationObserve(card);
    } else {
      markHost = document.getElementById('egd-canvas-layer');
      if (!markHost) return;
      barParent = markHost;
      contentRect = { x: 0, y: 0, width: 1, height: 1 };
    }
    const current = annotationCurrent(entry, card);
    const freshness = AnnotationState.annotationFreshness(entry.set, current);
    const projection = AnnotationState.projectAnnotationSet(entry.set, contentRect, current);
    const markerId = `${annotationLayerId(entry.set.id)}-arrow`;
    const svg = svgEl('svg', { class: 'egd-annotation-svg', 'aria-hidden': 'true' },
      svgEl('defs', {}, svgEl('marker', { id: markerId, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7',
        orient: 'auto-start-reverse', markerUnits: 'strokeWidth' }, svgEl('path', { class: 'egd-annotation-arrowhead', d: 'M0 0 10 5 0 10Z' }))));
    const labels = [];
    for (const projected of projection.items) {
      if (!projected.visible) continue;
      for (const node of annotationMarkNodes(projected, ink, markerId)) svg.appendChild(node);
      const label = annotationLabelNode(projected, ink);
      if (label) labels.push(label);
    }
    const layer = el('div', {
      id: annotationLayerId(entry.set.id),
      class: `egd-annotation-layer egd-annotation-layer-${entry.set.space}`,
      role: 'img',
      'aria-label': `${entry.summary} · ${AnnotationState.annotationSummaryText(entry.set)}`,
      data: { testid: 'annotation-layer', annotationSetId: entry.set.id, status, freshness: freshness.status,
        ...(entry.emphasis ? { emphasis: 'true' } : {}), ...(annotationIsHidden(entry, card) ? { cardHidden: 'true' } : {}) },
    }, svg, ...labels);
    if (entry.layer?.isConnected && entry.layer.parentNode === markHost) entry.layer.replaceWith(layer);
    else { entry.layer?.remove(); markHost.appendChild(layer); }
    entry.layer = layer;
    const bar = annotationBar(entry, status, freshness, projection);
    if (entry.set.space === 'canvas') {
      const first = projection.items.find(item => item.visible);
      const at = first?.rect || (first?.line ? { x: Math.min(first.line.x1, first.line.x2), y: Math.min(first.line.y1, first.line.y2) } : first?.point) || { x: 0, y: 0 };
      bar.classList.add('egd-annotation-bar-canvas');
      Object.assign(bar.style, { left: `${at.x}px`, top: `${at.y}px` });
      if (entry.bar?.isConnected && entry.bar.parentNode === barParent) entry.bar.replaceWith(bar);
      else { entry.bar?.remove(); barParent.appendChild(bar); }
    } else {
      const stack = annotationBarStack(barParent);
      if (entry.bar?.isConnected && entry.bar.parentNode === stack) entry.bar.replaceWith(bar);
      else { entry.bar?.remove(); stack.appendChild(bar); }
    }
    entry.bar = bar;
  }

  function annotationButton(label, testid, onclick, extra = {}) {
    return el('button', { type: 'button', class: 'egd-annotation-action', data: { testid },
      onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); onclick(ev); }, ...extra }, label);
  }

  function annotationBar(entry, status, freshness, projection) {
    const proposed = status === 'proposed' || status === 'partial';
    const counts = AnnotationState.annotationCounts(entry.set);
    const hiddenCount = projection.items.filter(item => !item.visible).length;
    const cardHidden = annotationIsHidden(entry);
    const badge = proposed ? (status === 'partial' ? 'AI 제안 · 일부 받음' : 'AI 제안') : '표식';
    const bar = el('div', {
      class: `egd-annotation-bar${proposed ? ' egd-annotation-bar-proposed' : ''}`,
      role: 'group',
      'aria-label': `${badge}: ${entry.summary}`,
      data: { testid: 'annotation-bar', annotationSetId: entry.set.id, status, freshness: freshness.status,
        ...(cardHidden ? { cardHidden: 'true' } : {}) },
      // A press on the bar never reaches the card under it.
      onpointerdown: (ev) => ev.stopPropagation(),
      onmousedown: (ev) => ev.stopPropagation(),
    });
    const head = el('div', { class: 'egd-annotation-bar-head' },
      el('span', { class: 'egd-annotation-badge' }, badge),
      el('span', { class: 'egd-annotation-summary', title: AnnotationState.annotationSummaryText(entry.set) }, entry.summary));
    bar.appendChild(head);
    if (freshness.reason) bar.appendChild(el('p', { class: 'egd-annotation-note', data: { testid: 'annotation-freshness' } }, freshness.reason));
    if (hiddenCount) bar.appendChild(el('p', { class: 'egd-annotation-note' }, `지금 화면 밖 표식 ${hiddenCount}개`));
    if (cardHidden) bar.appendChild(el('p', { class: 'egd-annotation-note', data: { testid: 'annotation-hidden-note' } },
      entry.set.space === 'card' ? '이 카드의 표식을 숨겼습니다' : '이 표식을 숨겼습니다'));
    if (entry.notice) bar.appendChild(el('p', { class: 'egd-annotation-note egd-annotation-notice', role: 'status', data: { testid: 'annotation-notice' } }, entry.notice));
    const actions = el('div', { class: 'egd-annotation-actions' });
    if (proposed) {
      actions.appendChild(annotationButton(counts.proposed === counts.total ? '모두 받기' : '남은 것 받기', 'annotation-accept',
        () => annotationAccept(entry.set.id), { disabled: freshness.stale ? 'true' : null,
          title: freshness.stale ? freshness.reason : '받은 표식만 Board와 함께 저장됩니다' }));
      actions.appendChild(annotationButton(counts.proposed === counts.total ? '모두 지우기' : '남은 것 지우기', 'annotation-dismiss',
        () => annotationDismiss(entry.set.id, null, { onlyProposed: true })));
      if (counts.total > 1 && counts.proposed) {
        actions.appendChild(annotationButton(entry.expanded ? '접기' : '하나씩', 'annotation-each', () => {
          entry.expanded = !entry.expanded;
          annotationRender(entry);
        }, { 'aria-expanded': String(!!entry.expanded) }));
      }
    } else {
      actions.appendChild(annotationButton('지우기', 'annotation-dismiss', () => annotationDismiss(entry.set.id)));
    }
    const hideWhat = entry.set.space === 'card' ? '이 카드 표식' : '이 표식';
    actions.appendChild(annotationButton(cardHidden ? '다시 보기' : '숨기기', 'annotation-card-hide',
      () => annotationSetHidden(entry, !cardHidden), { 'aria-pressed': String(cardHidden),
        'aria-label': cardHidden ? `${hideWhat} 다시 보기` : `${hideWhat} 숨기기`, title: '저장되지 않습니다' }));
    bar.appendChild(actions);
    if (proposed && entry.expanded) {
      const list = el('ul', { class: 'egd-annotation-items', data: { testid: 'annotation-items' } });
      for (const item of entry.set.items) {
        if (item.status === 'dismissed') continue;
        const name = item.label || { box: '상자', ellipse: '타원', highlight: '강조', line: '선', arrow: '화살표', label: '글자' }[item.type] || '표식';
        const row = el('li', { class: 'egd-annotation-item', data: { annotationItemId: item.id, status: item.status } },
          el('span', { class: 'egd-annotation-item-name' }, name));
        if (item.status === 'proposed') {
          row.append(
            annotationButton('받기', 'annotation-item-accept', () => annotationAccept(entry.set.id, [item.id]),
              { disabled: freshness.stale ? 'true' : null, 'aria-label': `${name} 받기` }),
            annotationButton('지우기', 'annotation-item-dismiss', () => annotationDismiss(entry.set.id, [item.id]), { 'aria-label': `${name} 지우기` }));
        } else row.appendChild(el('span', { class: 'egd-annotation-item-state' }, '받음'));
        list.appendChild(row);
      }
      bar.appendChild(list);
    }
    return bar;
  }

  const annotationKept = (set) => JSON.stringify(AnnotationState.annotationSetForBoard(set));

  // Saved state changes only when the kept marks change: accepting, or
  // removing a mark that was kept. A proposal coming or going is not a Board
  // change (proposals are a dirty overlay only).
  function annotationCommit(entry, next) {
    if (next === entry.set) return false;
    const before = annotationKept(entry.set);
    entry.set = next;
    entry.notice = null;
    if (AnnotationState.annotationSetStatus(next) !== 'proposed' && AnnotationState.annotationSetStatus(next) !== 'partial') entry.expanded = false;
    annotationRender(entry);
    annotationSyncChips(entry);
    if (annotationKept(next) !== before) {
      const card = annotationCard(entry);
      if (card) markAgendaDirty('annotation-change', card);
      else scheduleDeskSessionSave();
    }
    return true;
  }

  function annotationAccept(setId, itemIds = null) {
    const entry = annotationEntries.get(setId);
    if (!entry) return false;
    const card = annotationCard(entry);
    let next;
    try {
      next = AnnotationState.acceptAnnotations(entry.set, { itemIds, current: annotationCurrent(entry, card) });
    } catch (error) {
      entry.notice = error?.code === 'ANNOTATION_STALE' ? `받지 않았습니다: ${error.message}` : '표식을 받지 못했습니다.';
      annotationRender(entry);
      return false;
    }
    return annotationCommit(entry, next);
  }

  function annotationDismiss(setId, itemIds = null, { onlyProposed = false } = {}) {
    const entry = annotationEntries.get(setId);
    if (!entry) return false;
    const ids = itemIds || (onlyProposed ? entry.set.items.filter(item => item.status === 'proposed').map(item => item.id) : null);
    return annotationCommit(entry, AnnotationState.dismissAnnotations(entry.set, { itemIds: ids }));
  }

  function annotationTrim() {
    if (annotationEntries.size <= ANNOTATION_SET_LIMIT) return;
    // Oldest first, never a set that still holds kept marks.
    for (const [id, entry] of annotationEntries) {
      if (annotationEntries.size <= ANNOTATION_SET_LIMIT) break;
      if (AnnotationState.annotationSetForBoard(entry.set)) continue;
      annotationRemoveViews(entry);
      annotationEntries.delete(id);
    }
  }

  // chat.event 'annotation.published' on the run that published it. An
  // Agent can only propose: any status it sent becomes 'proposed'.
  function receivePublishedAnnotation(run, details) {
    const raw = details?.annotation;
    let set;
    try { set = AnnotationState.normalizeAnnotationSet(raw); } catch { return null; }
    if (annotationEntries.has(set.id)) return set.id;
    set = { ...set, items: set.items.map(({ edit, ...item }) => ({ ...item, status: 'proposed' })) };
    const entry = { set, summary: annotationSummaryOf(raw?.summary, set), answerId: typeof run?.answerId === 'string' ? run.answerId : null,
      card: null, receivedUri: null, notice: null, layer: null, bar: null, expanded: false, emphasis: false };
    annotationEntries.set(set.id, entry);
    annotationTrim();
    annotationRender(entry);
    return set.id;
  }

  // A saved set keeps its id unless another live card holds a set with it
  // (the same saved card opened twice). A holder whose card is gone yields.
  function annotationRestoredId(id, card) {
    const free = (holder) => !holder || holder.card === card || (holder.set.space === 'card' && !holder.card?.isConnected);
    if (free(annotationEntries.get(id))) return id;
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${id.slice(0, 120)}.r${n}`;
      if (free(annotationEntries.get(candidate))) return candidate;
    }
    return null;
  }

  function annotationRestore(records, card) {
    if (!Array.isArray(records)) return [];
    const restored = [];
    for (const record of records.slice(0, ANNOTATION_RESTORE_LIMIT)) {
      const set = AnnotationState.restoreAnnotationSet(record);
      if (!set || (card ? set.space !== 'card' : set.space !== 'canvas')) continue;
      const id = annotationRestoredId(set.id, card || null);
      if (!id) continue;
      const placed = card ? { ...set, id, targetCardId: card.id } : { ...set, id };
      const entry = { set: placed, summary: AnnotationState.annotationSummaryText(placed), answerId: null, card: card || null,
        restored: true, receivedUri: null, notice: null, layer: null, bar: null, expanded: false, emphasis: false };
      annotationRemoveViews(annotationEntries.get(id) || {});
      annotationEntries.set(id, entry);
      annotationRender(entry);
      restored.push(id);
    }
    annotationTrim();
    return restored;
  }

  // Card record field 'annotations': the kept marks of every set on it.
  function annotationRecordsForCard(card) {
    if (!card) return [];
    const records = [];
    for (const entry of annotationEntries.values()) {
      if (entry.set.space !== 'card') continue;
      const live = annotationCard(entry);
      if (live !== card) continue;
      const record = AnnotationState.annotationSetForBoard({ ...entry.set, targetCardId: card.id });
      if (record) records.push(record);
    }
    return records;
  }

  function annotationCanvasRecords() {
    const records = [];
    for (const entry of annotationEntries.values()) {
      if (entry.set.space !== 'canvas') continue;
      const record = AnnotationState.annotationSetForBoard(entry.set);
      if (record) records.push(record);
    }
    return records;
  }

  function annotationChipStatus(entry) {
    if (entry.set.space === 'card' && !annotationCard(entry)) return '대상 창 없음';
    return AnnotationState.annotationSummaryText(entry.set);
  }

  function annotationSyncChips(entry) {
    for (const chip of document.querySelectorAll('[data-testid="chat-annotation"]')) {
      if (chip.dataset.annotationSetId !== entry.set.id) continue;
      const status = chip.querySelector('.egd-codex-result-version');
      if (status) status.textContent = annotationChipStatus(entry);
    }
  }

  // D-K4: one chip per set under the answer that published it. Pressing it
  // brings the target card into view; publishing never moves the camera.
  function annotationChipsForAnswer(message, thread) {
    if (message?.role !== 'assistant' || !message.answerId || thread?.engineId === 'claude') return [];
    const chips = [];
    for (const entry of annotationEntries.values()) {
      if (entry.answerId !== message.answerId && entry.set.sourceMessageId !== message.answerId) continue;
      chips.push(el('button', {
        class: 'egd-codex-result-chip egd-codex-result-chip-annotation', type: 'button',
        'aria-label': `표식 보기: ${entry.summary}`,
        title: 'Agent가 카드 위에 올린 표식으로 갑니다',
        data: { testid: 'chat-annotation', annotationSetId: entry.set.id, answerId: message.answerId },
        onclick: (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          revealAnnotationSet(entry.set.id, { opener: ev.currentTarget?.closest?.('.egd-chat-card') || null });
        },
      }, el('span', { class: 'egd-codex-result-kind' }, '표식'),
      el('span', { class: 'egd-codex-result-label' }, entry.summary),
      el('span', { class: 'egd-codex-result-version' }, annotationChipStatus(entry))));
    }
    return chips;
  }

  function annotationPublic(entry) {
    const card = annotationCard(entry);
    return {
      ...annotationCopy(entry.set),
      status: AnnotationState.annotationSetStatus(entry.set),
      summary: entry.summary,
      cardId: card?.id ?? null,
      freshness: AnnotationState.annotationFreshness(entry.set, annotationCurrent(entry, card)).status,
    };
  }

  function getAnnotationSet(setId) {
    const entry = annotationEntries.get(setId);
    return entry ? annotationPublic(entry) : null;
  }

  function listAnnotationSets({ cardId = null, includeDismissed = false } = {}) {
    const list = [];
    for (const entry of annotationEntries.values()) {
      const view = annotationPublic(entry);
      if (cardId && view.cardId !== cardId) continue;
      if (!includeDismissed && view.status === 'dismissed') continue;
      list.push({ id: view.id, status: view.status, summary: view.summary, cardId: view.cardId, space: view.space,
        itemCount: view.items.filter(item => item.status !== 'dismissed').length, freshness: view.freshness });
    }
    return list;
  }

  // The Canvas place a set occupies (Canvas world pixels): its card's window
  // for a card set, the bounds of its visible marks for a free Canvas set.
  const annotationPx = (value, fallback) => {
    const number = parseFloat(value);
    return Number.isFinite(number) ? number : (Number.isFinite(fallback) ? fallback : NaN);
  };
  function annotationCanvasRect(entry, card) {
    let rect;
    if (card) {
      rect = { x: annotationPx(card.style?.left, card.offsetLeft ?? 0), y: annotationPx(card.style?.top, card.offsetTop ?? 0),
        width: annotationPx(card.style?.width, card.offsetWidth), height: annotationPx(card.style?.height, card.offsetHeight) };
    } else {
      const points = [];
      for (const item of AnnotationState.projectAnnotationSet(entry.set, { x: 0, y: 0, width: 1, height: 1 }, undefined).items) {
        if (item.rect) points.push([item.rect.x, item.rect.y], [item.rect.x + item.rect.width, item.rect.y + item.rect.height]);
        else if (item.line) points.push([item.line.x1, item.line.y1], [item.line.x2, item.line.y2]);
        else if (item.point) points.push([item.point.x, item.point.y]);
      }
      const xs = points.map(point => point[0]).filter(Number.isFinite), ys = points.map(point => point[1]).filter(Number.isFinite);
      if (!xs.length || !ys.length) return null;
      const x = Math.min(...xs), y = Math.min(...ys);
      // A lone point or a straight line still gets a visible area.
      rect = { x, y, width: Math.max(24, Math.max(...xs) - x), height: Math.max(24, Math.max(...ys) - y) };
    }
    return ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0 ? rect : null;
  }

  // Where a set is drawn, for an Answer Briefing step that targets it.
  function annotationTarget(setId) {
    const entry = annotationEntries.get(setId);
    if (!entry || AnnotationState.annotationSetStatus(entry.set) === 'dismissed') return null;
    const card = annotationCard(entry);
    if (entry.set.space === 'card' && !card) return null;
    return { setId: entry.set.id, space: entry.set.space, cardId: card?.id ?? null, card: card || null,
      layer: entry.layer?.isConnected ? entry.layer : null, rect: annotationCanvasRect(entry, card),
      summary: entry.summary,
      itemIds: entry.set.items.filter(item => item.status !== 'dismissed').map(item => item.id) };
  }

  function revealAnnotationSet(setId, options = {}) {
    const target = annotationTarget(setId);
    if (!target) return false;
    const entry = annotationEntries.get(setId);
    if (annotationIsHidden(entry, target.card)) annotationSetHidden(entry, false);
    if (target.card) {
      focusCanvasCard(target.card);
      revealOpenCanvasCard(target.card, { opener: options.opener || null, kind: 'annotation' });
    }
    emphasizeAnnotationSet(setId, true);
    if (typeof setTimeout === 'function') setTimeout(() => emphasizeAnnotationSet(setId, false), 1600);
    return true;
  }

  function emphasizeAnnotationSet(setId, on) {
    const entry = annotationEntries.get(setId);
    if (!entry) return false;
    entry.emphasis = !!on;
    if (entry.layer) {
      if (on) entry.layer.dataset.emphasis = 'true';
      else delete entry.layer.dataset.emphasis;
    }
    return true;
  }

  function refreshAnnotations(card = null) {
    for (const entry of annotationEntries.values()) if (!card || annotationCard(entry) === card) annotationRender(entry);
  }

  return {
    receivePublishedAnnotation,
    annotationChipsForAnswer,
    annotationRecordsForCard,
    restoreCardAnnotations: (card, records) => (card ? annotationRestore(records, card) : []),
    annotationCanvasRecords,
    restoreCanvasAnnotations: (records) => annotationRestore(records, null),
    acceptAnnotationSet: annotationAccept,
    dismissAnnotationSet: annotationDismiss,
    getAnnotationSet,
    listAnnotationSets,
    annotationTarget,
    revealAnnotationSet,
    emphasizeAnnotationSet,
    refreshAnnotations,
    annotationHidden: (setId) => { const entry = annotationEntries.get(setId); return entry ? annotationIsHidden(entry) : false; },
    setAnnotationHidden: (setId, hidden) => { const entry = annotationEntries.get(setId); return entry ? annotationSetHidden(entry, hidden) : false; },
  };
}
