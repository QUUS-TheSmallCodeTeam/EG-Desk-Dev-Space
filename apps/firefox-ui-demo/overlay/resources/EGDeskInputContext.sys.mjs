// Local source selection/capture. Wire serialization belongs to the bridge
// contract, not to this module. Captured content never becomes instructions,
// credentials, cwd, or a grant to act on the source.
const clone = value => JSON.parse(JSON.stringify(value));
const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

export function inputSourceKey(source) {
  const ref = source?.sourceRef || {};
  return JSON.stringify([source?.kind, ref.viewId || null, ref.path || null, ref.uri || null, ref.boardId || null]);
}

export function addInputSources(current = [], sources = []) {
  const next = current.map(clone);
  const keys = new Set(next.map(inputSourceKey));
  for (const source of sources) {
    if (!source?.id || !['browser', 'file', 'board-element'].includes(source.kind) || !source.sourceRef) continue;
    const key = inputSourceKey(source);
    if (!keys.has(key)) { next.push(clone(source)); keys.add(key); }
  }
  return next;
}

export const removeInputSource = (sources, id) => (sources || []).filter(source => source.id !== id).map(clone);

export function captureAttachment(source, snapshot = null, capturedAt = Date.now()) {
  const ref = source.sourceRef;
  const kind = source.kind === 'board-element' ? 'board' : source.kind;
  const attachment = { id: source.id, kind, label: source.label, capturedAt: snapshot?.capturedAt || capturedAt,
    sourceRef: { kind, resourceId: ref.path || ref.uri || ref.viewId,
      ...(ref.path ? { path: ref.path } : {}), ...(ref.uri ? { url: ref.uri } : {}),
      ...(ref.viewId ? { viewId: ref.viewId } : {}) },
    captureScope: { type: kind === 'file' ? 'file' : kind === 'browser' ? 'document-text' : 'board-selection' },
  };
  if (source.kind !== 'file') {
    if (!snapshot?.content || snapshot.sourceId !== source.id) throw new Error('선택한 자료의 실제 캡처가 필요합니다.');
    attachment.content = { text: snapshot.content.text, mime: snapshot.content.mime, truncated: snapshot.content.truncated };
    attachment.captureScope.locator = snapshot.content.boundary;
  }
  return attachment;
}

export function capturedInputReference(source, receipt) {
  if (!receipt?.sourceId || receipt.snapshotId !== receipt.sourceId || !receipt.hash || !receipt.sourceRef
      || receipt.id !== source.id) throw new Error('캡처 저장 확인이 올바르지 않습니다.');
  return freeze({ ...clone(receipt), localSource: clone(source) });
}

// A named, bounded rendered-text capture, not a raw DOM dump or whole-page
// coverage claim. Text-node bytes/whitespace are retained; form/editable values
// and hidden/script/style content are deliberately outside this boundary.
export function captureDocumentText(doc, { maxChars = Infinity } = {}) {
  const limit = Number.isFinite(maxChars) ? Math.max(1, maxChars) : Infinity;
  const win = doc.defaultView;
  const root = doc.body || doc.documentElement;
  if (!root || !win) throw new Error('페이지 본문을 읽을 수 없습니다.');
  const filter = win.NodeFilter;
  const visibility = new WeakMap();
  const visible = node => {
    if (!node) return true;
    if (visibility.has(node)) return visibility.get(node);
    const excluded = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|INPUT|TEXTAREA|SELECT|OPTION)$/i.test(node.tagName || '')
      || node.isContentEditable || node.hidden || node.getAttribute?.('aria-hidden') === 'true';
    const style = win.getComputedStyle(node);
    const result = !excluded && style.display !== 'none' && style.visibility !== 'hidden'
      && style.visibility !== 'collapse' && Number(style.opacity) !== 0 && visible(node.parentElement);
    visibility.set(node, result);
    return result;
  };
  const walker = doc.createTreeWalker(root, filter.SHOW_TEXT, {
    acceptNode: node => node.nodeValue?.trim() && visible(node.parentElement) ? filter.FILTER_ACCEPT : filter.FILTER_REJECT,
  });
  let text = '', truncated = false, nodes = 0;
  while (true) {
    const node = walker.nextNode();
    if (!node) break;
    const value = `${nodes ? '\n' : ''}${node.nodeValue}`;
    if (text.length + value.length > limit) {
      text += value.slice(0, limit - text.length); truncated = true; break;
    }
    text += value; nodes++;
  }
  return {
    text, mime: 'text/plain', truncated, capturedAt: Date.now(),
    url: win.location.href, title: doc.title || '',
    boundary: `loaded DOM visible text nodes; excludes form/editable/hidden content, child frames and not-loaded content${truncated ? `; partial prefix ${text.length} characters; remaining text not captured` : '; all text within this boundary'}`,
    capturedChars: text.length,
    coverage: { scope: 'loaded-dom-visible-text', completeDocument: false, completeWithinBoundary: !truncated,
      excluded: ['form-values', 'editable-content', 'hidden-content', 'child-frames', 'not-loaded-content'] },
  };
}

export function inputSnapshot(source, captured, { id, capturedAt = Date.now() } = {}) {
  if (typeof captured?.text !== 'string') throw new Error('실제 캡처 본문이 없습니다.');
  if (source.kind === 'browser' && source.sourceRef.uri !== captured.url) {
    throw new Error('첨부 후 페이지 주소가 바뀌었습니다. 현재 페이지를 다시 첨부해 주세요.');
  }
  const text = captured.text;
  return freeze({
    id, sourceId: source.id, kind: source.kind, label: source.label,
    sourceRef: clone(source.sourceRef), capturedAt: captured.capturedAt || capturedAt,
    content: { mime: captured.mime || 'text/plain', text,
      truncated: captured.truncated === true || captured.text.length > text.length,
      boundary: captured.boundary || 'selected-source-text', capturedChars: text.length,
      coverage: { ...clone(captured.coverage || { scope: 'selected-source-text', completeDocument: false }),
        completeWithinBoundary: captured.truncated !== true && captured.text.length === text.length },
      ...(Number.isFinite(captured.totalBytes) ? { totalBytes: captured.totalBytes } : {}),
    },
    // Spatial context is a separate relevance signal, never canonical content.
    executionContext: captured.executionContext ? clone(captured.executionContext) : null,
  });
}

export async function captureInputSources(sources, adapters, options = {}) {
  const result = [];
  for (const source of sources || []) {
    const capture = adapters[source.kind];
    if (typeof capture !== 'function') throw new Error(`지원하지 않는 첨부: ${source.label || source.kind}`);
    try {
      const captured = await capture(clone(source));
      result.push(inputSnapshot(source, captured, { id: options.nextId(), capturedAt: options.now?.() }));
    } catch (error) {
      throw Object.assign(new Error(`${source.label || source.kind}: ${error.message}`), { sourceId: source.id });
    }
  }
  return freeze(result);
}

export function inputSourceLocation(source) {
  return source?.sourceRef?.path || source?.sourceRef?.uri || source?.sourceRef?.url || source?.sourceRef?.viewId || '';
}

export function storedSnapshotForView(stored, reference = null) {
  const capture = stored?.capture;
  const source = stored?.source;
  const binary = source?.text === null && source.range === null && source.rangeHash === null;
  if (!capture?.sourceId || !capture.hash || source?.role !== 'source' || source.hash !== capture.hash
      || (!binary && (!source.rangeHash || typeof source.text !== 'string'
        || !Number.isInteger(source.range?.startLine) || !Number.isInteger(source.range?.endLine)))) throw new Error('저장된 원문 응답을 읽을 수 없습니다.');
  if (reference && (reference.sourceId !== capture.sourceId || reference.hash !== capture.hash)) throw new Error('요청한 고정 캡처와 다른 응답입니다.');
  const delivered = stored.delivered;
  if (delivered != null && (delivered.role !== 'agent_input' || !delivered.packetId || !delivered.hash
      || typeof delivered.text !== 'string' || delivered.deliveryStatus !== 'sent-to-app-server')) throw new Error('전달 payload 기록을 확인할 수 없습니다.');
  return freeze({ id: capture.sourceId, hash: capture.hash, rangeHash: source.rangeHash, label: reference?.localSource?.label || '저장된 입력',
    sourceRef: clone(capture.sourceRef || {}), capturedAt: capture.capturedAt,
    storedRole: 'source', binary, range: source.range ? clone(source.range) : null, nextLine: source.nextLine ?? null,
    delivered: delivered == null ? null : clone(delivered), bindings: clone(stored.bindings || []),
    content: { text: source.text, mime: source.mime, truncated: capture.truncated === true,
      boundary: binary ? `보관된 바이너리 원문 · ${source.byteLength} bytes · 텍스트 미리보기 없음`
        : `${capture.captureScope?.type || 'capture'} · 원문 ${source.range.startLine}–${source.range.endLine} / ${source.range.totalLines ?? '?'}행${capture.captureScope?.locator ? ` · ${capture.captureScope.locator}` : ''}`,
      coverage: { completeDocument: false, scope: 'stored-source-page' } },
  });
}

export function projectionRange(range = {}) {
  const startLine = range.startLine ?? 1;
  const endLine = range.endLine ?? startLine + 199;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine - startLine >= 500
      || Object.keys(range).some(key => !['startLine', 'endLine'].includes(key))) throw new Error('지원하지 않는 캡처 행 범위입니다. 한 페이지는 최대 500행입니다.');
  return { startLine, endLine };
}
export const inputEvidenceKey = reference => {
  const range = projectionRange(reference.presentationRange);
  return JSON.stringify([reference.sourceId, reference.hash, range.startLine, range.endLine]);
};

// Small DOM projections shared by the draft preview and historical inspector.
export function inputSnapshotView(doc, snapshot, { includeDelivered = true } = {}) {
  const make = (tag, value, attributes = {}) => {
    const node = doc.createElement(tag);
    for (const [key, val] of Object.entries(attributes)) node.setAttribute(key, String(val));
    if (value != null) node.appendChild(doc.createTextNode(String(value)));
    return node;
  };
  const root = make('article', null, { class: 'egd-input-snapshot', 'data-testid': 'chat-input-snapshot', 'data-snapshot-id': snapshot.id });
  root.appendChild(make('h4', snapshot.label));
  root.appendChild(make('p', `당시 캡처 · ${new Date(snapshot.capturedAt).toLocaleString()}`));
  root.appendChild(make('p', inputSourceLocation(snapshot), { class: 'egd-input-source-location' }));
  root.appendChild(make('p', snapshot.content.truncated ? '부분 캡처 — 전체 원문이 아닙니다.' : '명시된 범위의 캡처', { role: 'status' }));
  root.appendChild(make('p', snapshot.content.boundary));
  if (snapshot.storedRole === 'source') root.appendChild(make('p', '원문 캡처 페이지입니다. 모델에 전달된 자료·완독 여부와 구별합니다.', { 'data-testid': 'chat-input-source-label' }));
  root.appendChild(make('p', snapshot.content.coverage?.completeDocument === true ? '원문 전체 범위' : '전체 문서를 읽었다는 의미는 아닙니다.'));
  if (snapshot.content.text !== null) root.appendChild(make('pre', snapshot.content.text, { tabindex: '0', 'aria-label': '당시 캡처 본문' }));
  if (includeDelivered && snapshot.storedRole === 'source') {
    if (!snapshot.delivered) root.appendChild(make('p', '이 조회에 확인된 전달 payload가 없습니다.', { 'data-testid': 'chat-input-delivery-status' }));
    else {
      const delivery = snapshot.delivered;
      const details = make('details', null, { 'data-testid': 'chat-input-delivery', 'data-packet-id': delivery.packetId });
      details.appendChild(make('summary', 'App Server로 전달된 입력 payload 보기'));
      details.appendChild(make('p', '전달 요청 상태입니다. 모델의 수신·완독·작업 완료를 뜻하지 않습니다.'));
      details.appendChild(make('p', `${delivery.mode || '입력'} · packet ${delivery.packetId} · hash ${delivery.hash}`));
      details.appendChild(make('p', `Answer: ${delivery.binding?.answerId || '미확인'} · Run: ${delivery.binding?.runId || '미확인'}`));
      details.appendChild(make('pre', delivery.text, { tabindex: '0', 'aria-label': '실제로 전달된 payload 원문' }));
      root.appendChild(details);
    }
  }
  return root;
}
