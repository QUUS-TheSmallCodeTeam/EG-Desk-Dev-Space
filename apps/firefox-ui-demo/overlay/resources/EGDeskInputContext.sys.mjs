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
  return JSON.stringify([source?.kind, ref.viewId || null, ref.path || null, ref.uri || null,
    ref.boardId || null, ref.fileId || null, ref.draftId || null]);
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

export function captureAttachment(source, snapshot = null, capturedAt = Date.now(), managedFileView = null) {
  const ref = source.sourceRef;
  const kind = source.kind === 'board-element' ? 'board' : source.kind;
  if (kind === 'file' && ref.draftId && !managedFileView) {
    throw new Error('작업사본의 현재 내용을 확인한 뒤 첨부해 주세요.');
  }
  if (managedFileView && (kind !== 'file' || !ref.viewId || ref.path || ref.uri || ref.url
      || managedFileView.fileId !== ref.fileId || managedFileView.draftId !== ref.draftId
      || typeof managedFileView.head !== 'string' || !managedFileView.head
      || !Number.isSafeInteger(managedFileView.revision) || managedFileView.revision < 0
      || Object.keys(managedFileView).some(key => !['fileId', 'draftId', 'head', 'revision'].includes(key)))) {
    throw new Error('선택한 작업사본의 고정 캡처를 확인하지 못했습니다. 다시 첨부해 주세요.');
  }
  const attachment = { id: source.id, kind, label: source.label, capturedAt: snapshot?.capturedAt || capturedAt,
    sourceRef: { kind, resourceId: managedFileView?.fileId || ref.path || ref.uri || ref.viewId,
      ...(ref.path ? { path: ref.path } : {}), ...(ref.uri ? { url: ref.uri } : {}),
      ...(kind === 'browser' && ref.profileId ? { browserProfileId: ref.profileId } : {}),
      ...(kind === 'browser' && ref.accountId ? { siteAccount: ref.accountId } : {}),
      ...(ref.viewId ? { viewId: ref.viewId } : {}) },
    captureScope: { type: kind === 'file' ? 'file' : kind === 'browser' ? 'document-text' : 'board-selection' },
  };
  if (managedFileView) attachment.managedFileView = clone(managedFileView);
  if (source.kind !== 'file') {
    if (!snapshot?.content || snapshot.sourceId !== source.id) throw new Error('선택한 자료의 실제 캡처가 필요합니다.');
    attachment.content = { text: snapshot.content.text, mime: snapshot.content.mime, truncated: snapshot.content.truncated };
    attachment.captureScope.locator = snapshot.content.boundary;
  }
  return attachment;
}

export function assertInputContextScope(reference, scope) {
  if (reference?.contextScope && ['engineId', 'engineProfileId', 'clientThreadId'].some(key => reference.contextScope[key] !== scope?.[key])) {
    throw new Error('이 고정 캡처는 다른 엔진 또는 대화에 속해 있습니다. 원래 대화에서 확인해 주세요.');
  }
}

// Snapshot the read boundary, never remap a client ID or grant permission.
// Restored rooms now use the same stable pair for reads, resume and new
// captures. The helper still verifies its durable binding/account/profile.
export function inputReadContext(reference, currentScope, { thread, accountKey = null, cachedAccountKey = null } = {}) {
  const origin = reference?.contextScope, retained = thread?.retainedNativeBinding;
  assertInputContextScope(reference, currentScope);
  const restored = currentScope?.engineId === 'codex' && !!retained?.conversationId;
  if (restored) {
    if (origin?.engineId !== 'codex'
        || !currentScope.engineProfileId || origin.engineProfileId !== currentScope.engineProfileId
        || !currentScope.conversationId || thread?.conversationId !== currentScope.conversationId
        || retained?.conversationId !== currentScope.conversationId
        || !origin.clientThreadId || retained.clientThreadId !== origin.clientThreadId || currentScope.clientThreadId !== origin.clientThreadId
        || origin.conversationId && origin.conversationId !== currentScope.conversationId
        || !accountKey || thread.bindingState !== 'verified' || thread.bindingAccountKey !== accountKey
        || retained.accountKey !== accountKey || cachedAccountKey && cachedAccountKey !== accountKey
        || !reference.sourceId || reference.snapshotId !== reference.sourceId || !reference.hash) {
      throw new Error('복원된 대화와 고정 캡처의 원래 연결을 확인하지 못했습니다.');
    }
  }
  // Freeze copies of both current and retained scopes. Recomputing this value
  // after an await detects mutation without rewriting the persisted reference.
  return freeze({ scope: clone(currentScope), restored, fence: {
    threadId: thread?.id || null, currentScope: clone(currentScope), accountKey, cachedAccountKey,
    bindingAccountKey: thread?.bindingAccountKey || null, bindingState: thread?.bindingState || null,
    retained: clone(retained || null), reference: clone({ sourceId: reference?.sourceId, snapshotId: reference?.snapshotId,
      hash: reference?.hash, contextScope: origin || null }),
  } });
}

export function assertRestoredInputCapture(snapshot, capture, reference, context) {
  if (!context.restored) return;
  const scope = context.scope, deliveredConversation = snapshot.delivered?.binding?.conversationId;
  if (snapshot.id !== reference.sourceId || snapshot.id !== reference.snapshotId || snapshot.hash !== reference.hash
      || capture?.sourceId !== snapshot.id || capture.hash !== snapshot.hash || capture.clientThreadId !== scope.clientThreadId
      || capture.engine?.engineId !== scope.engineId || capture.engine?.engineProfileId !== scope.engineProfileId
      || snapshot.delivered && deliveredConversation !== scope.conversationId
      || !(deliveredConversation === scope.conversationId || snapshot.bindings?.some(binding => binding?.conversationId === scope.conversationId))) {
    throw new Error('복원된 대화와 고정 캡처의 원래 연결을 확인하지 못했습니다.');
  }
}

export function capturedInputReference(source, receipt, contextScope = null) {
  if (!receipt?.sourceId || receipt.snapshotId !== receipt.sourceId || !receipt.hash || !receipt.sourceRef
      || receipt.id !== source.id) throw new Error('캡처 저장 확인이 올바르지 않습니다.');
  if (contextScope) assertInputContextScope(receipt, contextScope);
  if (contextScope?.engineId === 'claude' && receipt.truncated === true) throw new Error('선택한 자료가 일부만 캡처되어 보내지 않았습니다. 초안과 선택 자료는 유지됩니다.');
  return freeze({ ...clone(receipt), localSource: clone(source), ...(contextScope ? { contextScope: clone(contextScope) } : {}) });
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
  if (source?.kind === 'file' && source?.sourceRef?.draftId) return '파일 작업 창 · 현재 작업사본';
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
export function inputEvidenceSnapshot(stored, reference) {
  const snapshot = storedSnapshotForView(stored, reference);
  if (snapshot.binary) throw new Error('이 원문은 텍스트 근거로 표시할 수 없습니다.');
  const requested = reference.presentationRange || {};
  const { startLine, endLine } = projectionRange(requested);
  if (snapshot.range.startLine !== startLine || (requested.endLine !== undefined && snapshot.range.endLine !== endLine)) {
    throw new Error('저장된 근거의 요청 행 범위와 응답이 달라 로드하지 않았습니다.');
  }
  return snapshot;
}
export const inputEvidenceKey = reference => {
  const requested = reference.presentationRange;
  const range = projectionRange(requested);
  // An omitted end can be clipped to the capture length, while an explicitly
  // requested end must be returned exactly. Keep explicit keys unchanged,
  // including a present null end, which the reader normalizes as explicit.
  const endKey = requested?.endLine === undefined ? null : range.endLine;
  return JSON.stringify([reference.sourceId, reference.hash, range.startLine, endKey]);
};

// Tracking is separate from the immutable capture. Absence is not freshness,
// and an active entry only describes the helper's declared tracking boundary.
export function inputSourceTrackingConversation(snapshot, capture, referenceScope, scope) {
  const conversationId = scope?.conversationId;
  if (scope?.engineId !== 'codex' || !conversationId || capture?.sourceId !== snapshot.id || capture.hash !== snapshot.hash) return null;
  const claims = [capture.engine, referenceScope].filter(Boolean);
  if (!claims.length || claims.some(claim => claim.engineId !== scope.engineId || claim.engineProfileId !== scope.engineProfileId
      || claim.clientThreadId && claim.clientThreadId !== scope.clientThreadId || claim.conversationId && claim.conversationId !== conversationId)) return null;
  if (capture.clientThreadId && capture.clientThreadId !== scope.clientThreadId) return null;
  const deliveredConversation = snapshot.delivered?.binding?.conversationId;
  // One capture can be bound to A and B with different tracking states. Never
  // label B's historical payload using A's state, even when the source matches.
  if (snapshot.delivered && deliveredConversation !== conversationId) return null;
  return deliveredConversation === conversationId || snapshot.bindings?.some(binding => binding?.conversationId === conversationId)
    ? conversationId : null;
}

export function inputSourceChangeState(response, { conversationId, sourceId }) {
  if (!conversationId || !sourceId || response?.conversationId !== conversationId || !Array.isArray(response.sources)) {
    throw new Error('Source tracking response does not match this conversation');
  }
  const matches = response.sources.filter(source => source?.sourceId === sourceId);
  if (!matches.length) return Object.freeze({ state: 'missing', conversationId, sourceId });
  if (matches.length !== 1 || !['active', 'stale'].includes(matches[0].state)) throw new Error('Invalid source tracking state');
  const source = matches[0];
  const changedAt = source.state === 'stale' && Number.isFinite(source.changedAt) && source.changedAt >= 0
    && Number.isFinite(new Date(source.changedAt).getTime()) ? source.changedAt : null;
  return Object.freeze({ state: source.state, conversationId, sourceId, changedAt,
    reason: source.state === 'stale' ? ['fileChanged', 'navigated'].includes(source.reason) ? source.reason : 'unknown' : null });
}

export function updateInputSourceChange(node, value, scrollBody = null) {
  const messages = {
    loading: '원본 변경 정보 확인 중', active: '추적 범위에서 감지된 변경 없음',
    missing: '변경 추적 기록 없음 · 최신 여부 미확인', failed: '원본 변경 정보를 확인하지 못했습니다',
  };
  const text = value.state === 'stale' ? ({ fileChanged: '캡처 후 파일 변경 감지', navigated: '캡처 후 브라우저 페이지 이동 감지' })[value.reason]
    || '캡처 후 원본 변경 감지' : messages[value.state] || messages.failed;
  const before = scrollBody?.getBoundingClientRect?.(), top = scrollBody?.scrollTop, left = scrollBody?.scrollLeft;
  const scale = before?.height / scrollBody?.offsetHeight;
  const anchor = top > 0 && scale > 0 ? [...scrollBody.querySelectorAll('[data-testid="chat-input-delivery"], [data-testid="chat-input-source-details"], pre')]
    .find(part => part.getBoundingClientRect().bottom > before.top) : null;
  const offset = anchor ? anchor.getBoundingClientRect().top - before.top : null;
  node.setAttribute('data-state', value.state);
  node.setAttribute('data-source-id', value.sourceId);
  node.setAttribute('data-conversation-id', value.conversationId || '');
  node.setAttribute('data-reason', value.state === 'stale' ? value.reason : '');
  // Only this line changes. The source, delivery, selection and focused input
  // nodes are never replaced or focused by a tracking response.
  node.textContent = text;
  if (value.state === 'stale' && Number.isFinite(value.changedAt)) {
    const time = node.ownerDocument.createElement('time');
    time.setAttribute('data-testid', 'chat-input-change-detected-at');
    time.setAttribute('datetime', new Date(value.changedAt).toISOString());
    time.textContent = new Date(value.changedAt).toLocaleString();
    node.appendChild(node.ownerDocument.createTextNode(' · 감지 시각 ')); node.appendChild(time);
  }
  if (scrollBody) {
    const next = anchor ? scrollBody.scrollTop + (anchor.getBoundingClientRect().top - scrollBody.getBoundingClientRect().top - offset) / scale : top;
    if (Number.isFinite(next) && scrollBody.scrollTop !== next) scrollBody.scrollTop = next;
    if (Number.isFinite(left) && scrollBody.scrollLeft !== left) scrollBody.scrollLeft = left;
  }
}

// Small DOM projections shared by the draft preview and historical inspector.
export function inputSnapshotView(doc, snapshot, { includeDelivered = true, sourceChange = null } = {}) {
  const make = (tag, value, attributes = {}) => {
    const node = doc.createElement(tag);
    for (const [key, val] of Object.entries(attributes)) node.setAttribute(key, String(val));
    if (value != null) node.appendChild(doc.createTextNode(String(value)));
    return node;
  };
  const root = make('article', null, { class: 'egd-input-snapshot', 'data-testid': 'chat-input-snapshot', 'data-snapshot-id': snapshot.id });
  root.appendChild(make('h4', snapshot.label));
  const range = snapshot.range ? ` · ${snapshot.range.startLine}–${snapshot.range.endLine} / ${snapshot.range.totalLines ?? '?'}행` : '';
  root.appendChild(make('p', `원문 캡처${range}${snapshot.content.truncated ? ' · 일부 캡처' : ''}${snapshot.binary ? ' · 텍스트 보기 없음' : ''}`,
    { role: 'status', class: 'egd-input-snapshot-status', 'data-testid': 'chat-input-source-label' }));
  if (sourceChange) {
    const change = make('p', null, { role: 'status', class: 'egd-input-snapshot-status', 'data-testid': 'chat-input-source-change' });
    updateInputSourceChange(change, sourceChange);
    root.appendChild(change);
  }
  if (includeDelivered && snapshot.storedRole === 'source') {
    if (!snapshot.delivered) root.appendChild(make('p', '전달 기록 없음', { class: 'egd-input-snapshot-status', 'data-testid': 'chat-input-delivery-status' }));
    else {
      const delivery = snapshot.delivered;
      const details = make('details', null, { 'data-testid': 'chat-input-delivery', 'data-packet-id': delivery.packetId });
      details.appendChild(make('summary', '전달된 입력 보기'));
      const metadata = make('details', null, { class: 'egd-input-snapshot-metadata', 'data-testid': 'chat-input-delivery-details' });
      metadata.appendChild(make('summary', '전달 정보'));
      metadata.appendChild(make('p', 'App Server 전달 기록입니다. 모델의 수신·완독·작업 완료를 뜻하지 않습니다.'));
      metadata.appendChild(make('p', `${delivery.mode || '입력'} · packet ${delivery.packetId} · hash ${delivery.hash}`));
      metadata.appendChild(make('p', `Answer: ${delivery.binding?.answerId || '미확인'} · Run: ${delivery.binding?.runId || '미확인'}`));
      details.appendChild(metadata);
      details.appendChild(make('pre', delivery.text, { tabindex: '0', 'aria-label': '실제로 전달된 payload 원문' }));
      root.appendChild(details);
    }
  }
  const metadata = make('details', null, { class: 'egd-input-snapshot-metadata', 'data-testid': 'chat-input-source-details' });
  metadata.appendChild(make('summary', '출처 및 캡처 정보'));
  metadata.appendChild(make('p', new Date(snapshot.capturedAt).toLocaleString()));
  metadata.appendChild(make('p', inputSourceLocation(snapshot), { class: 'egd-input-source-location' }));
  metadata.appendChild(make('p', snapshot.content.boundary));
  if (snapshot.hash) metadata.appendChild(make('p', `캡처 hash: ${snapshot.hash}`));
  if (snapshot.rangeHash) metadata.appendChild(make('p', `표시 범위 hash: ${snapshot.rangeHash}`));
  metadata.appendChild(make('p', '명시된 원문 캡처 범위입니다. 전달된 입력과 모델의 완독 여부는 별개입니다.'));
  root.appendChild(metadata);
  if (snapshot.content.text !== null) root.appendChild(make('pre', snapshot.content.text, { tabindex: '0', 'aria-label': '당시 캡처 본문' }));
  return root;
}
