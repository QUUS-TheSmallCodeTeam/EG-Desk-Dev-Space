// Moved verbatim from overlay/JS/eg-desk-surface.uc.js.
// Loaded once per window: ChromeUtils.importESModule(url, { global: 'current' }).
// Never statically import a .sys.mjs here; shared modules arrive through deps.
export function createOntologyZone(deps) {
  const {
    ONTOLOGY_GRAPH_URL,
    allocCardSeq,
    el,
    focusCanvasCard,
    focusOpenSourceCard,
    raiseCardZ,
    resolveCanvasCardPlacement,
    revealPlacedCanvasCard,
    singletonSourceRef,
    spawnDeskWindowShell,
    svgEl,
    syncOntologyPresentationState,
  } = deps;

  const ONTOLOGY_TIME_PANE_ORDER = ['past', 'present', 'future'];
  const ONTOLOGY_GRAPH_SCHEMA_VERSION = 3;
  const ONTOLOGY_TIME_PANE_LABELS = {
    past: '과거',
    present: '현재',
    future: '미래',
    multiverse: '분기',
  };
  const ONTOLOGY_LAYER_ORDER = ['virtual', 'physical'];
  const ONTOLOGY_CAMERA_ZOOM_MIN = 0.72;
  const ONTOLOGY_CAMERA_ZOOM_MAX = 2.2;
  const ONTOLOGY_CAMERA_ZOOM_STEP = 0.12;
  const ontologyModelCache = new WeakMap();

  function ontologyTitleCase(value) {
    return String(value || '')
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  function createOntologyPlaneGeometry(point, extra = {}) {
    const corners = {
      tl: point(0, 0),
      tr: point(1, 0),
      br: point(1, 1),
      bl: point(0, 1),
    };
    const pathFromPoints = (points) => `M ${points.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ')} Z`;
    const rectPath = (u, v, w, h) => pathFromPoints([
      point(u, v),
      point(u + w, v),
      point(u + w, v + h),
      point(u, v + h),
    ]);
    return { corners, point, rectPath, ...extra };
  }

  function createOntologyDeckGeometry(bounds) {
    const corner = (name) => ({
      x: Number(bounds.x || 0) + Number(bounds.corners[name]?.x || 0),
      y: Number(bounds.y || 0) + Number(bounds.corners[name]?.y || 0),
    });
    const sourceCorners = {
      tl: corner('tl'),
      tr: corner('tr'),
      br: corner('br'),
      bl: corner('bl'),
    };
    const lerpPoint = (a, b, t) => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    });
    const point = (u, v) => {
      const top = lerpPoint(sourceCorners.tl, sourceCorners.tr, u);
      const bottom = lerpPoint(sourceCorners.bl, sourceCorners.br, u);
      return lerpPoint(top, bottom, v);
    };
    return createOntologyPlaneGeometry(point);
  }

  function ontologyUnprojectDeckPoint(geometry, target, initial = { u: 0.5, v: 0.5 }) {
    let u = Number.isFinite(initial.u) ? initial.u : 0.5;
    let v = Number.isFinite(initial.v) ? initial.v : 0.5;
    const epsilon = 0.0005;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const current = geometry.point(u, v);
      const alongU = geometry.point(u + epsilon, v);
      const alongV = geometry.point(u, v + epsilon);
      const ux = (alongU.x - current.x) / epsilon;
      const uy = (alongU.y - current.y) / epsilon;
      const vx = (alongV.x - current.x) / epsilon;
      const vy = (alongV.y - current.y) / epsilon;
      const determinant = ux * vy - uy * vx;
      if (Math.abs(determinant) < 0.000001) break;
      const errorX = target.x - current.x;
      const errorY = target.y - current.y;
      u += (errorX * vy - errorY * vx) / determinant;
      v += (ux * errorY - uy * errorX) / determinant;
    }
    return { u, v };
  }

  function createOntologyLayerGeometry(geometry, frame) {
    const point = (u, v) => geometry.point(
      frame.u + u * frame.w,
      frame.v + v * frame.h,
    );
    return createOntologyPlaneGeometry(point, { frame });
  }

  function createOntologyCameraGeometry(geometry, camera, focusSpec) {
    const origin = {
      u: focusSpec.u + focusSpec.w / 2,
      v: focusSpec.v + focusSpec.h / 2,
    };
    const originPoint = geometry.point(origin.u, origin.v);
    const cameraCenter = ontologyUnprojectDeckPoint(geometry, {
      x: originPoint.x + (Number(camera.x) || 0),
      y: originPoint.y + (Number(camera.y) || 0),
    }, origin);
    const zoom = Math.max(0.01, Number(camera.zoom) || 1);
    const mapCoordinates = (u, v) => ({
      u: cameraCenter.u + (u - origin.u) * zoom,
      v: cameraCenter.v + (v - origin.v) * zoom,
    });
    const point = (u, v) => {
      const mapped = mapCoordinates(u, v);
      return geometry.point(mapped.u, mapped.v);
    };
    const viewportSpec = {
      u: origin.u + (focusSpec.u - cameraCenter.u) / zoom,
      v: origin.v + (focusSpec.v - cameraCenter.v) / zoom,
      w: focusSpec.w / zoom,
      h: focusSpec.h / zoom,
    };
    return createOntologyPlaneGeometry(point, { cameraCenter, viewportSpec });
  }

  function validateOntologyGraph(graph) {
    if (graph?.schemaVersion !== ONTOLOGY_GRAPH_SCHEMA_VERSION) {
      throw new Error(`Unsupported ontology graph schema: ${graph?.schemaVersion ?? 'missing'}`);
    }
    for (const field of ['nodes', 'snapshots', 'occurrences', 'referenceEdges']) {
      if (!Array.isArray(graph[field])) throw new Error(`Ontology graph field must be an array: ${field}`);
    }
    return graph;
  }

  function getOntologyModel(graph) {
    const cached = ontologyModelCache.get(graph);
    if (cached) return cached;
    const nodesById = new Map((graph?.nodes || []).map((node) => [node.id, node]));
    const snapshots = (graph?.snapshots || []).slice();
    const occurrences = (graph?.occurrences || []).slice();
    const byRef = new Map(occurrences.map((occurrence) => [occurrence.refId, occurrence]));
    const childrenByRef = new Map();
    occurrences.forEach((occurrence) => {
      if (!occurrence.parentRef) return;
      if (!childrenByRef.has(occurrence.parentRef)) childrenByRef.set(occurrence.parentRef, []);
      childrenByRef.get(occurrence.parentRef).push(occurrence);
    });
    childrenByRef.forEach((children) => children.sort((a, b) => (
      (Number(a.order) || 0) - (Number(b.order) || 0) || a.refId.localeCompare(b.refId)
    )));
    const labelFor = (occurrence) => occurrence?.label
      || nodesById.get(occurrence?.conceptId)?.label
      || ontologyTitleCase(occurrence?.conceptId || occurrence?.refId || 'concept');
    const rootsByPhase = new Map();
    snapshots.forEach((snapshot) => {
      const root = byRef.get(snapshot.rootRef);
      if (root && !rootsByPhase.has(snapshot.timeSlice)) rootsByPhase.set(snapshot.timeSlice, root);
    });
    const isPlaneRoot = (occurrence) => {
      if (!occurrence) return false;
      const parent = occurrence.parentRef ? byRef.get(occurrence.parentRef) : null;
      return !parent || parent.timeSlice !== occurrence.timeSlice || parent.snapshotId !== occurrence.snapshotId;
    };
    const planeRootsByCell = new Map();
    occurrences.forEach((occurrence) => {
      if (!isPlaneRoot(occurrence)) return;
      const key = `${occurrence.timeSlice}:${occurrence.layer}`;
      if (!planeRootsByCell.has(key)) planeRootsByCell.set(key, []);
      planeRootsByCell.get(key).push(occurrence);
    });
    planeRootsByCell.forEach((roots) => roots.sort((a, b) => (
      (Number(a.order) || 0) - (Number(b.order) || 0) || a.refId.localeCompare(b.refId)
    )));
    const model = {
      snapshots,
      occurrences,
      byRef,
      childrenByRef,
      rootsByPhase,
      isPlaneRoot,
      planeRootsFor: (phase, layer) => planeRootsByCell.get(`${phase}:${layer}`) || [],
      labelFor,
      referenceEdges: graph?.referenceEdges || [],
    };
    ontologyModelCache.set(graph, model);
    return model;
  }

  function getOntologyCamera(localState) {
    const key = `${localState.activePane || 'present'}:coupled-layers`;
    if (!localState.cameraByCell) localState.cameraByCell = {};
    if (!localState.cameraByCell[key]) localState.cameraByCell[key] = { x: 0, y: 0, zoom: 1 };
    const camera = localState.cameraByCell[key];
    localState.pan = { x: camera.x, y: camera.y };
    localState.zoom = camera.zoom;
    return camera;
  }

  function setOntologyLayer(localState, layer) {
    if (!ONTOLOGY_LAYER_ORDER.includes(layer)) return false;
    localState.activeLayer = layer;
    localState.activeStratum = layer;
    localState.activeDepth = layer;
    return true;
  }

  function adjustOntologyCameraZoom(camera, direction) {
    camera.zoom = Math.max(
      ONTOLOGY_CAMERA_ZOOM_MIN,
      Math.min(ONTOLOGY_CAMERA_ZOOM_MAX, camera.zoom + direction * ONTOLOGY_CAMERA_ZOOM_STEP),
    );
  }

  function resetOntologyCamera(camera) {
    camera.x = 0;
    camera.y = 0;
    camera.zoom = 1;
  }

  function selectOntologyOccurrence(localState, model, refId, options = {}) {
    const occurrence = model.byRef.get(refId);
    if (!occurrence) return false;
    localState.selectedRefId = occurrence.refId;
    localState.selectedId = occurrence.refId;
    localState.selectedConceptId = occurrence.conceptId;
    localState.activePane = occurrence.timeSlice;
    if (options.keepLayer !== true) setOntologyLayer(localState, occurrence.layer);
    return true;
  }

  function activateOntologyPane(localState, model, phase, preferredConceptId = null) {
    if (!ONTOLOGY_TIME_PANE_ORDER.includes(phase)) return false;
    const candidates = model.occurrences.filter((occurrence) => occurrence.timeSlice === phase);
    const target = candidates.find((occurrence) => occurrence.conceptId === preferredConceptId)
      || model.rootsByPhase.get(phase)
      || candidates[0];
    localState.activePane = phase;
    if (target) {
      selectOntologyOccurrence(localState, model, target.refId);
    } else {
      localState.selectedRefId = null;
      localState.selectedId = null;
      localState.selectedConceptId = null;
    }
    return true;
  }

  function getOntologySideItems(model, phase, visibleRefs, selected) {
    const phaseOccurrences = model.occurrences.filter((occurrence) => occurrence.timeSlice === phase);
    const visibleConcepts = new Set(visibleRefs.map((occurrence) => occurrence.conceptId));
    const edgeEndpointRefs = new Set();
    model.referenceEdges.forEach((edge) => {
      if (visibleRefs.some((occurrence) => occurrence.refId === edge.sourceRef)) edgeEndpointRefs.add(edge.targetRef);
      if (visibleRefs.some((occurrence) => occurrence.refId === edge.targetRef)) edgeEndpointRefs.add(edge.sourceRef);
    });
    return phaseOccurrences.filter((occurrence) => (
      model.isPlaneRoot(occurrence)
      || edgeEndpointRefs.has(occurrence.refId)
      || visibleConcepts.has(occurrence.conceptId)
    )).sort((a, b) => {
      const rank = (occurrence) => {
        if (occurrence.conceptId === selected?.conceptId) return 0;
        if (visibleConcepts.has(occurrence.conceptId)) return 1;
        if (edgeEndpointRefs.has(occurrence.refId)) return 2;
        if (model.isPlaneRoot(occurrence)) return 3;
        return 4;
      };
      return rank(a) - rank(b)
        || (Number(a.order) || 0) - (Number(b.order) || 0)
        || a.refId.localeCompare(b.refId);
    });
  }

  function drawOntologyText(parent, geometry, u, v, textValue, attrs = {}) {
    const { anchor = 'middle', ...svgAttrs } = attrs;
    const point = geometry.point(u, v);
    const angle = Math.atan2(
      geometry.corners.tr.y - geometry.corners.tl.y,
      geometry.corners.tr.x - geometry.corners.tl.x,
    ) * 180 / Math.PI;
    const node = svgEl('text', {
      x: point.x,
      y: point.y,
      transform: Math.abs(angle) > 0.1 ? `rotate(${angle.toFixed(2)} ${point.x.toFixed(1)} ${point.y.toFixed(1)})` : null,
      'text-anchor': anchor,
      fill: '#252A26',
      'font-family': 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif',
      'font-size': '12',
      'font-weight': '800',
      ...svgAttrs,
    }, textValue);
    parent.appendChild(node);
    return node;
  }

  function drawOntologyChildPips(parent, geometry, spec, count, layer) {
    const columns = 9;
    const anchorU = spec.u + spec.w - 0.025;
    const anchorV = spec.v + spec.h - 0.025;
    const origin = geometry.point(anchorU, anchorV);
    const alongU = geometry.point(anchorU + 0.01, anchorV);
    const alongV = geometry.point(anchorU, anchorV + 0.01);
    const pixelsPerU = Math.max(1, Math.hypot(alongU.x - origin.x, alongU.y - origin.y) / 0.01);
    const pixelsPerV = Math.max(1, Math.hypot(alongV.x - origin.x, alongV.y - origin.y) / 0.01);
    const pipSizePx = 7;
    const pipGapPx = 4;
    const pipW = Math.min(pipSizePx / pixelsPerU, spec.w / 14);
    const pipH = Math.min(pipSizePx / pixelsPerV, spec.h / 5);
    const gapX = pipW + pipGapPx / pixelsPerU;
    const gapY = pipH + pipGapPx / pixelsPerV;
    for (let index = 0; index < count; index += 1) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const u = spec.u + spec.w - 0.025 - pipW - column * gapX;
      const v = spec.v + spec.h - 0.025 - pipH - row * gapY;
      parent.appendChild(svgEl('path', {
        class: `egd-ontology-v2-pip egd-ontology-v2-pip-${layer}`,
        d: geometry.rectPath(u, v, pipW, pipH),
        fill: layer === 'virtual' ? 'rgba(103, 67, 166, 0.82)' : 'rgba(63, 83, 68, 0.84)',
        stroke: 'rgba(255, 255, 255, 0.90)',
        'stroke-width': '0.6',
        'data-pip-index': String(index),
      }));
    }
  }

  function drawOntologyOccurrenceBox(parent, model, geometry, spec, occurrence, options = {}) {
    const childCount = model.childrenByRef.get(occurrence.refId)?.length || 0;
    const expandedRoot = !!(options.root && options.expanded);
    const group = svgEl('g', {
      class: `egd-ontology-v2-box${options.root ? ' egd-ontology-v2-box-root' : ''}${expandedRoot ? ' egd-ontology-v2-box-root-expanded' : ''}${options.side ? ' egd-ontology-v2-box-side' : ''}${options.overview ? ' egd-ontology-v2-box-overview' : ''}${options.context ? ' egd-ontology-v2-box-context' : ''}${options.behind ? ' egd-ontology-v2-box-behind' : ''}`,
      data: {
        refId: occurrence.refId,
        conceptId: occurrence.conceptId,
        phase: occurrence.timeSlice,
        layer: occurrence.layer,
        contextRole: options.contextRole || '',
      },
      onclick: options.onclick,
    });
    const boxPath = geometry.rectPath(spec.u, spec.v, spec.w, spec.h);
    const boxFill = options.root ? 'rgba(255, 254, 250, 0.88)' : options.side ? 'rgba(255, 255, 255, 0.88)' : options.overview ? 'rgba(255, 255, 255, 0.92)' : 'rgba(255, 255, 255, 0.95)';
    const boxStroke = occurrence.layer === 'virtual' ? 'rgba(103, 67, 166, 0.68)' : 'rgba(63, 83, 68, 0.70)';
    group.appendChild(svgEl('path', {
      class: `egd-ontology-v2-box-path egd-ontology-v2-box-path-${occurrence.layer}${expandedRoot ? ' egd-ontology-v2-box-fill' : ''}`,
      d: boxPath,
      fill: boxFill,
      stroke: expandedRoot ? 'none' : boxStroke,
      'stroke-width': options.root ? '2.3' : options.side ? '1.2' : '1.7',
    }));
    if (expandedRoot) {
      const labelWidth = Math.min(spec.w * 0.60, Math.max(0.105, model.labelFor(occurrence).length * 0.013) * (options.labelScale || 1));
      const gapStartU = spec.u + 0.035;
      const gapEndU = gapStartU + labelWidth;
      const topLeft = geometry.point(spec.u, spec.v);
      const gapStart = geometry.point(gapStartU, spec.v);
      const gapEnd = geometry.point(gapEndU, spec.v);
      const topRight = geometry.point(spec.u + spec.w, spec.v);
      const bottomRight = geometry.point(spec.u + spec.w, spec.v + spec.h);
      const bottomLeft = geometry.point(spec.u, spec.v + spec.h);
      group.appendChild(svgEl('path', {
        class: `egd-ontology-v2-box-outline egd-ontology-v2-box-outline-${occurrence.layer}`,
        d: `M ${gapEnd.x.toFixed(1)} ${gapEnd.y.toFixed(1)} L ${topRight.x.toFixed(1)} ${topRight.y.toFixed(1)} L ${bottomRight.x.toFixed(1)} ${bottomRight.y.toFixed(1)} L ${bottomLeft.x.toFixed(1)} ${bottomLeft.y.toFixed(1)} L ${topLeft.x.toFixed(1)} ${topLeft.y.toFixed(1)} L ${gapStart.x.toFixed(1)} ${gapStart.y.toFixed(1)}`,
        fill: 'none',
        stroke: boxStroke,
        'stroke-width': '2.3',
      }));
      group.appendChild(svgEl('path', {
        class: 'egd-ontology-v2-legend-gap',
        d: `M ${gapStart.x.toFixed(1)} ${gapStart.y.toFixed(1)} L ${gapEnd.x.toFixed(1)} ${gapEnd.y.toFixed(1)}`,
        fill: 'none',
        stroke: boxFill,
        'stroke-width': '3.2',
      }));
      drawOntologyText(group, geometry, gapStartU + 0.012, spec.v + 0.018, model.labelFor(occurrence), {
        class: 'egd-ontology-v2-label egd-ontology-v2-label-root',
        anchor: 'start',
        'font-size': '14',
        'font-weight': '900',
      });
    } else if (options.root) {
      drawOntologyText(group, geometry, spec.u + spec.w / 2, spec.v + spec.h * 0.52, model.labelFor(occurrence), {
        class: 'egd-ontology-v2-label egd-ontology-v2-label-root egd-ontology-v2-label-root-centered',
        'font-size': '15',
        'font-weight': '900',
      });
    } else {
      drawOntologyText(group, geometry, spec.u + spec.w / 2, spec.v + spec.h * 0.48, model.labelFor(occurrence), {
        class: 'egd-ontology-v2-label',
        'font-size': options.side || options.context || options.overview ? '10' : '12',
      });
    }
    if (childCount && !options.root && !options.side && (!options.context || options.contextRole === 'child')) {
      drawOntologyChildPips(group, geometry, spec, childCount, occurrence.layer);
    }
    parent.appendChild(group);
    return group;
  }

  function renderOntologyMap(stage, graph, localState) {
    const model = getOntologyModel(graph);
    if (!model.snapshots.length) {
      stage.textContent = '';
      stage.appendChild(el('div', { class: 'egd-ontology-empty' }, '표시할 composite snapshot이 없습니다.'));
      return;
    }
    const rerender = () => renderOntologyMap(stage, graph, localState);
    syncOntologyPresentationState();
    if (!ONTOLOGY_TIME_PANE_ORDER.includes(localState.activePane)) localState.activePane = 'present';
    if (!ONTOLOGY_LAYER_ORDER.includes(localState.activeLayer)) setOntologyLayer(localState, 'virtual');
    let selected = model.byRef.get(localState.selectedRefId || localState.selectedId);
    if (!selected || selected.timeSlice !== localState.activePane) {
      selected = model.rootsByPhase.get(localState.activePane) || null;
    }
    const emptyPhase = !selected;
    if (selected) {
      selectOntologyOccurrence(localState, model, selected.refId, { keepLayer: true });
    } else {
      localState.selectedRefId = null;
      localState.selectedId = null;
      localState.selectedConceptId = null;
    }
    setOntologyLayer(
      localState,
      ONTOLOGY_LAYER_ORDER.includes(localState.activeLayer) ? localState.activeLayer : selected?.layer || 'virtual',
    );
    const layerPovShiftV = localState.activeLayer === 'physical' ? -0.170 : 0;
    const camera = getOntologyCamera(localState);
    const directChildren = emptyPhase ? [] : (model.childrenByRef.get(selected.refId) || []);
    const mainChildren = directChildren.filter((occurrence) => occurrence.layer === localState.activeLayer);
    const visibleRefs = selected ? [selected, ...directChildren] : [];
    const visibleRefIds = new Set(visibleRefs.map((occurrence) => occurrence.refId));
    const temporallyCoupledRefIds = new Set();
    model.referenceEdges.forEach((edge) => {
      const source = model.byRef.get(edge.sourceRef);
      const target = model.byRef.get(edge.targetRef);
      if (!source || !target || source.timeSlice === target.timeSlice) return;
      if (visibleRefIds.has(source.refId) && target.timeSlice !== localState.activePane) {
        temporallyCoupledRefIds.add(target.refId);
      }
      if (visibleRefIds.has(target.refId) && source.timeSlice !== localState.activePane) {
        temporallyCoupledRefIds.add(source.refId);
      }
    });
    const card = stage.closest?.('.egd-ontology-card');
    if (card) {
      card.classList.add('egd-ontology-canvas-first', 'egd-ontology-v2');
      card.dataset.activePane = localState.activePane;
      card.dataset.activeLayer = localState.activeLayer;
      card.dataset.layerPovShiftV = layerPovShiftV.toFixed(3);
    }

    const stageRect = stage.getBoundingClientRect?.();
    const height = 760;
    const aspect = stageRect?.height > 100 ? stageRect.width / stageRect.height : 1.65;
    const width = Math.max(1120, Math.min(1580, Math.round(height * aspect)));
    // SVG user units shrink with the stage. Keep labels readable at the
    // window's minimum size without changing the projected plane geometry.
    const screenScale = stageRect?.width > 0 && stageRect?.height > 0
      ? Math.min(stageRect.width / width, stageRect.height / height)
      : 1;
    const textScale = Math.max(1, Math.min(2, 1 / screenScale));
    stage.style.setProperty('--egd-ontology-text-scale', String(textScale));
    const paneBounds = {};
    const timeShares = localState.activePane === 'past'
      ? [0.18, 0.82, 0.91, 1]
      : localState.activePane === 'future'
        ? [0, 0.09, 0.18, 0.82]
        : [0, 0.18, 0.82, 1];
    const activeTimeIndex = ONTOLOGY_TIME_PANE_ORDER.indexOf(localState.activePane);
    const topY = 96;
    // Keep the trailing layer above the Desk Dock instead of letting the
    // projected plane disappear through the card's lower edge.
    const bottomY = height - 72;
    const topLeft = -48;
    const topRight = width + 48;
    const bottomLeft = -170;
    const bottomRight = width + 170;
    const sideTimeTiltY = 72;
    const interpolateX = (left, right, t) => left + (right - left) * t;
    const boundaryTiltY = (boundaryIndex) => {
      if (boundaryIndex < activeTimeIndex) {
        return sideTimeTiltY * (activeTimeIndex - boundaryIndex) / Math.max(1, activeTimeIndex);
      }
      if (boundaryIndex > activeTimeIndex + 1) {
        return sideTimeTiltY * (boundaryIndex - activeTimeIndex - 1)
          / Math.max(1, ONTOLOGY_TIME_PANE_ORDER.length - activeTimeIndex - 1);
      }
      return 0;
    };
    ONTOLOGY_TIME_PANE_ORDER.forEach((phase, index) => {
      const leftTiltY = boundaryTiltY(index);
      const rightTiltY = boundaryTiltY(index + 1);
      paneBounds[phase] = {
        x: 0,
        y: 0,
        w: width,
        h: height,
        corners: {
          tl: {
            x: interpolateX(topLeft, topRight, timeShares[index]),
            y: topY - leftTiltY,
          },
          tr: {
            x: interpolateX(topLeft, topRight, timeShares[index + 1]),
            y: topY - rightTiltY,
          },
          br: {
            x: interpolateX(bottomLeft, bottomRight, timeShares[index + 1]),
            y: bottomY - rightTiltY,
          },
          bl: {
            x: interpolateX(bottomLeft, bottomRight, timeShares[index]),
            y: bottomY - leftTiltY,
          },
        },
      };
    });
    const geometries = new Map(Object.entries(paneBounds).map(([phase, bounds]) => [
      phase,
      createOntologyDeckGeometry(bounds),
    ]));
    // Virtual and physical keep a stable world-space order. Selecting physical
    // lowers the POV by one depth step; it never swaps the two plane frames.
    const virtualLayerFrame = { u: 0, v: 0.055 + layerPovShiftV, w: 1, h: 0.620 };
    const physicalLayerFrame = { u: 0, v: 0.225 + layerPovShiftV, w: 1, h: 0.620 };
    const layerFrameSpecs = {
      virtual: virtualLayerFrame,
      physical: physicalLayerFrame,
    };
    const planeSpec = { u: 0, v: 0, w: 1, h: 1 };
    const layerSpecs = {
      virtual: { ...planeSpec },
      physical: { ...planeSpec },
    };
    const sideLayerSpecs = layerSpecs;
    const layerGeometries = new Map();
    ONTOLOGY_TIME_PANE_ORDER.forEach((phase) => {
      ONTOLOGY_LAYER_ORDER.forEach((layer) => {
        layerGeometries.set(
          `${phase}:${layer}`,
          createOntologyLayerGeometry(geometries.get(phase), layerFrameSpecs[layer]),
        );
      });
    });
    const layerGeometryFor = (phase, layer) => layerGeometries.get(`${phase}:${layer}`);
    const layerRenderOrder = ONTOLOGY_LAYER_ORDER
      .filter((layer) => layer !== localState.activeLayer)
      .concat(localState.activeLayer);

    stage.textContent = '';
    const svg = svgEl('svg', {
      class: 'egd-ontology-svg egd-ontology-v2-svg',
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': '시간 및 가상 물리 층을 탐색하는 온톨로지 복합 렌즈',
    });
    const cameraGroup = svgEl('g', {
      class: 'egd-ontology-v2-camera',
      data: { cameraSpace: 'plane' },
    });
    const surfaceGroup = svgEl('g', { class: 'egd-ontology-v2-surfaces' });
    const edgeGroup = svgEl('g', { class: 'egd-ontology-v2-reference-edges' });
    const depthEdgeGroup = svgEl('g', { class: 'egd-ontology-v2-reference-edges egd-ontology-v2-depth-edges' });
    const coupledBehindNodeGroup = svgEl('g', { class: 'egd-ontology-v2-nodes egd-ontology-v2-coupled-behind-nodes' });
    const frontLayerVeilGroup = svgEl('g', { class: 'egd-ontology-v2-front-layer-veil' });
    const activeNodeGroup = svgEl('g', { class: 'egd-ontology-v2-nodes egd-ontology-v2-active-nodes' });
    const fixedNodeGroup = svgEl('g', { class: 'egd-ontology-v2-side-nodes' });
    const cameraOverlayGroup = svgEl('g', { class: 'egd-ontology-v2-camera-overlays' });
    const overlayGroup = svgEl('g', { class: 'egd-ontology-v2-overlays' });
    const layerControlGroup = svgEl('g', { class: 'egd-ontology-v2-layer-controls' });
    const timeAxisGroup = svgEl('g', { class: 'egd-ontology-v2-time-axis-controls' });
    const placements = new Map();
    const sideInventories = new Map();

    ONTOLOGY_TIME_PANE_ORDER.forEach((phase) => {
      const geometry = geometries.get(phase);
      const active = phase === localState.activePane;
      const pane = svgEl('g', {
        class: `egd-ontology-time-coordinate egd-ontology-time-coordinate-${phase}${active ? ' egd-ontology-time-coordinate-active' : ''}`,
        data: { phase },
      });
      const activateLayerAtPhase = (layer, ev) => {
        ev?.preventDefault?.();
        ev?.stopPropagation?.();
        if (phase !== localState.activePane) activateOntologyPane(localState, model, phase, selected?.conceptId || null);
        setOntologyLayer(localState, layer);
        const related = model.occurrences.find((occurrence) => (
          occurrence.timeSlice === phase && occurrence.layer === layer && occurrence.conceptId === selected?.conceptId
        )) || model.occurrences.find((occurrence) => occurrence.timeSlice === phase && occurrence.layer === layer);
        if (related) selectOntologyOccurrence(localState, model, related.refId, { keepLayer: true });
        rerender();
      };
      const activateTime = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        activateOntologyPane(localState, model, phase, selected?.conceptId || null);
        rerender();
      };
      const labelV = active ? 0.035 : 0.08;
      const centerPoint = geometry.point(0.5, labelV);
      const centerAlongU = geometry.point(0.51, labelV);
      const visibleWidth = stageRect?.width > 0 ? stageRect.width / screenScale : width;
      const visibleLeft = (width - visibleWidth) / 2;
      const safeLabelX = Math.max(visibleLeft + 22 / screenScale, Math.min(visibleLeft + visibleWidth - 22 / screenScale, centerPoint.x));
      const labelU = Math.max(0.05, Math.min(0.95, 0.5 + (safeLabelX - centerPoint.x) * 0.01 / (centerAlongU.x - centerPoint.x || 1)));
      const labelPoint = geometry.point(labelU, labelV);
      const alongU = geometry.point(labelU + 0.01, labelV);
      const alongV = geometry.point(labelU, labelV + 0.01);
      const pixelsPerU = Math.max(1, Math.hypot(alongU.x - labelPoint.x, alongU.y - labelPoint.y) * screenScale / 0.01);
      const pixelsPerV = Math.max(1, Math.hypot(alongV.x - labelPoint.x, alongV.y - labelPoint.y) * screenScale / 0.01);
      const hitHalfU = Math.min(0.38, 24 / pixelsPerU);
      const hitHalfV = Math.min(0.08, 12 / pixelsPerV);
      timeAxisGroup.appendChild(svgEl('path', {
        class: `egd-ontology-pane-hit egd-ontology-v2-time-axis-hit egd-ontology-v2-pane-hit-${phase}`,
        d: geometry.rectPath(labelU - hitHalfU, labelV - hitHalfV - 4 / pixelsPerV, hitHalfU * 2, hitHalfV * 2),
        fill: 'transparent',
        stroke: 'transparent',
        role: 'button',
        tabindex: '0',
        'aria-label': `${ONTOLOGY_TIME_PANE_LABELS[phase]} 시점으로 이동`,
        onclick: activateTime,
        onkeydown: (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') activateTime(ev);
        },
      }));
      const timeLabel = drawOntologyText(timeAxisGroup, geometry, labelU, labelV, ONTOLOGY_TIME_PANE_LABELS[phase], {
        class: 'egd-ontology-v2-time-coordinate-label',
        fill: active ? 'rgba(39, 48, 56, 0.82)' : 'rgba(59, 66, 73, 0.58)',
        'font-size': active ? '15' : '13',
        'font-weight': '900',
      });
      if (active) timeLabel.classList.add('egd-ontology-v2-time-coordinate-label-active');
      const strutGroup = svgEl('g', {
        class: `egd-ontology-v2-layer-struts${active ? ' egd-ontology-v2-layer-struts-active' : ''}`,
        data: { phase },
      });
      [0.075, 0.925].forEach((u) => {
        const from = layerGeometryFor(phase, localState.activeLayer).point(u, 0.060);
        const trailingLayer = localState.activeLayer === 'virtual' ? 'physical' : 'virtual';
        const to = layerGeometryFor(phase, trailingLayer).point(u, 0.060);
        strutGroup.appendChild(svgEl('path', {
          class: 'egd-ontology-v2-layer-strut',
          d: `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} L ${to.x.toFixed(1)} ${to.y.toFixed(1)}`,
          fill: 'none',
          stroke: active ? 'rgba(73, 99, 79, 0.34)' : 'rgba(73, 99, 79, 0.22)',
          'stroke-width': active ? '1.35' : '0.95',
          'stroke-dasharray': '5 5',
          data: { phase, anchorU: u },
        }));
      });
      pane.appendChild(strutGroup);
      if (active) {
        layerRenderOrder.forEach((layer) => {
          const spec = layerSpecs[layer];
          const layerGeometry = layerGeometryFor(phase, layer);
          const layerActive = localState.activeLayer === layer;
          pane.appendChild(svgEl('path', {
            class: `egd-ontology-v2-layer-shadow egd-ontology-v2-layer-shadow-${layer}${layerActive ? ' egd-ontology-v2-layer-shadow-active' : ''}`,
            d: layerGeometry.rectPath(spec.u, spec.v, spec.w, spec.h),
            transform: 'translate(0 12)',
            fill: layer === 'virtual' ? 'rgba(73, 52, 110, 0.045)' : 'rgba(27, 58, 78, 0.055)',
            stroke: 'none',
            data: { phase, layer },
          }));
          pane.appendChild(svgEl('path', {
            class: `egd-ontology-v2-layer-pane egd-ontology-v2-layer-surface egd-ontology-v2-layer-surface-${layer}${layerActive ? ' egd-ontology-v2-layer-surface-active' : ' egd-ontology-v2-layer-surface-behind'}`,
            d: layerGeometry.rectPath(spec.u, spec.v, spec.w, spec.h),
            fill: layer === 'virtual' ? 'rgba(126, 87, 194, 0.078)' : 'rgba(73, 99, 79, 0.085)',
            stroke: layer === 'virtual'
              ? (layerActive ? 'rgba(103, 67, 166, 0.64)' : 'rgba(126, 87, 194, 0.38)')
              : (layerActive ? 'rgba(63, 83, 68, 0.66)' : 'rgba(73, 99, 79, 0.40)'),
            'stroke-width': layerActive ? '2.1' : '1.15',
            data: { phase, layer, planeRole: layerActive ? 'main' : 'trailing' },
            onclick: (ev) => {
              if (localState.suppressNextSurfaceClick) {
                localState.suppressNextSurfaceClick = false;
                return;
              }
              activateLayerAtPhase(layer, ev);
            },
          }));
        });
        // Keep both layer selectors above the overlapping surfaces. Otherwise
        // the front surface steals clicks from the visible trailing label.
        layerRenderOrder.forEach((layer) => {
          const spec = layerSpecs[layer];
          const layerGeometry = layerGeometryFor(phase, layer);
          const layerActive = localState.activeLayer === layer;
          const activateLayerLabel = (ev) => activateLayerAtPhase(layer, ev);
          const labelControl = svgEl('g', {
            class: `egd-ontology-v2-layer-label-control egd-ontology-v2-layer-label-control-${layer}`,
            data: { phase, layer },
            role: 'button',
            tabindex: '0',
            'aria-label': `${layer === 'virtual' ? '가상' : '물리'} 층으로 이동`,
            onclick: activateLayerLabel,
            onkeydown: (ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') activateLayerLabel(ev);
            },
          });
          labelControl.appendChild(svgEl('path', {
            class: 'egd-ontology-v2-layer-label-hit',
            d: layerGeometry.rectPath(spec.u + 0.012, spec.v + 0.012, 0.13, 0.11),
            fill: 'transparent',
            stroke: 'none',
          }));
          drawOntologyText(labelControl, layerGeometry, spec.u + 0.025, spec.v + 0.055, layer === 'virtual' ? '가상' : '물리', {
            class: `egd-ontology-v2-layer-label egd-ontology-v2-layer-label-${layer}`,
            anchor: 'start',
            fill: layer === 'virtual'
              ? (layerActive ? 'rgba(103, 67, 166, 0.88)' : 'rgba(103, 67, 166, 0.48)')
              : (layerActive ? 'rgba(63, 83, 68, 0.90)' : 'rgba(63, 83, 68, 0.52)'),
            'font-size': '11',
            'font-weight': '900',
          });
          layerControlGroup.appendChild(labelControl);
          if (!layerActive) {
            const switchV = layer === 'physical' ? 0.86 : 0.02;
            layerControlGroup.appendChild(svgEl('path', {
              class: `egd-ontology-v2-layer-switch-hit egd-ontology-v2-layer-switch-hit-${layer}`,
              d: layerGeometry.rectPath(spec.u + 0.08, spec.v + switchV, 0.84, 0.10),
              fill: 'rgba(255, 255, 255, 0.001)',
              stroke: 'none',
              data: { phase, layer },
              role: 'button',
              tabindex: '0',
              'aria-label': `${layer === 'virtual' ? '가상' : '물리'} 층으로 이동`,
              onclick: activateLayerLabel,
              onkeydown: (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') activateLayerLabel(ev);
              },
            }));
          }
        });
      } else {
        layerRenderOrder.forEach((layer) => {
          const spec = sideLayerSpecs[layer];
          const layerGeometry = layerGeometryFor(phase, layer);
          const layerActive = localState.activeLayer === layer;
          pane.appendChild(svgEl('path', {
            class: `egd-ontology-v2-layer-shadow egd-ontology-v2-side-layer-shadow egd-ontology-v2-layer-shadow-${layer}`,
            d: layerGeometry.rectPath(spec.u, spec.v, spec.w, spec.h),
            transform: 'translate(0 8)',
            fill: layer === 'virtual' ? 'rgba(73, 52, 110, 0.030)' : 'rgba(27, 58, 78, 0.036)',
            stroke: 'none',
            data: { phase, layer },
          }));
          pane.appendChild(svgEl('path', {
            class: `egd-ontology-v2-layer-pane egd-ontology-v2-side-layer egd-ontology-v2-side-layer-${layer}${layerActive ? ' egd-ontology-v2-side-layer-front' : ' egd-ontology-v2-side-layer-behind'}`,
            d: layerGeometry.rectPath(spec.u, spec.v, spec.w, spec.h),
            fill: layer === 'virtual' ? 'rgba(126, 87, 194, 0.025)' : 'rgba(73, 99, 79, 0.030)',
            stroke: layer === 'virtual' ? 'rgba(126, 87, 194, 0.26)' : 'rgba(73, 99, 79, 0.28)',
            'stroke-width': layerActive ? '1.25' : '0.95',
            data: { phase, layer, planeRole: layerActive ? 'main' : 'trailing' },
            onclick: (ev) => activateLayerAtPhase(layer, ev),
          }));
          drawOntologyText(pane, layerGeometry, spec.u + 0.06, spec.v + 0.085, layer === 'virtual' ? '가상' : '물리', {
            class: `egd-ontology-v2-side-layer-label egd-ontology-v2-layer-label-${layer}`,
            anchor: 'start',
            fill: layer === 'virtual' ? 'rgba(103, 67, 166, 0.58)' : 'rgba(63, 83, 68, 0.62)',
            'font-size': '8.5',
            'font-weight': '900',
          });
        });
      }
      surfaceGroup.appendChild(pane);
    });

    const activeGeometry = layerGeometryFor(localState.activePane, localState.activeLayer);
    const mainSpec = layerSpecs[localState.activeLayer];
    const activeCameraGeometry = createOntologyCameraGeometry(activeGeometry, camera, mainSpec);
    const cameraGeometriesByCell = new Map();
    ONTOLOGY_TIME_PANE_ORDER.forEach((phase) => {
      ONTOLOGY_LAYER_ORDER.forEach((layer) => {
        cameraGeometriesByCell.set(
          `${phase}:${layer}`,
          createOntologyCameraGeometry(layerGeometryFor(phase, layer), camera, layerSpecs[layer]),
        );
      });
    });
    const activeLayerCameraGeometries = new Map(ONTOLOGY_LAYER_ORDER.map((layer) => [
      layer,
      cameraGeometriesByCell.get(`${localState.activePane}:${layer}`),
    ]));
    const cameraClipId = `egd-ontology-v2-camera-clip-${String(card?.id || 'card').replace(/[^a-z0-9_-]/gi, '-')}`;
    const defs = svgEl('defs');
    const cameraClip = svgEl('clipPath', { id: cameraClipId });
    ONTOLOGY_LAYER_ORDER.forEach((layer) => {
      const geometry = layerGeometryFor(localState.activePane, layer);
      const spec = layerSpecs[layer];
      cameraClip.appendChild(svgEl('path', { d: geometry.rectPath(spec.u, spec.v, spec.w, spec.h) }));
    });
    defs.appendChild(cameraClip);
    const layerClipIds = new Map();
    const layerClipBaseId = `egd-ontology-v2-layer-clip-${String(card?.id || 'card').replace(/[^a-z0-9_-]/gi, '-')}`;
    ONTOLOGY_TIME_PANE_ORDER.forEach((phase) => {
      ONTOLOGY_LAYER_ORDER.forEach((layer) => {
        const clipId = `${layerClipBaseId}-${phase}-${layer}`;
        const clip = svgEl('clipPath', { id: clipId });
        clip.appendChild(svgEl('path', {
          d: layerGeometryFor(phase, layer).rectPath(
            layerSpecs[layer].u,
            layerSpecs[layer].v,
            layerSpecs[layer].w,
            layerSpecs[layer].h,
          ),
        }));
        defs.appendChild(clip);
        layerClipIds.set(`${phase}:${layer}`, clipId);
      });
    });
    svg.appendChild(defs);
    cameraGroup.setAttribute('clip-path', `url(#${cameraClipId})`);
    depthEdgeGroup.setAttribute('clip-path', `url(#${cameraClipId})`);
    const trailingCameraLayer = localState.activeLayer === 'virtual' ? 'physical' : 'virtual';
    const activeNodeClipId = layerClipIds.get(`${localState.activePane}:${localState.activeLayer}`);
    const trailingNodeClipId = layerClipIds.get(`${localState.activePane}:${trailingCameraLayer}`);
    activeNodeGroup.setAttribute('clip-path', `url(#${activeNodeClipId})`);
    activeNodeGroup.dataset.clipLayer = localState.activeLayer;
    coupledBehindNodeGroup.setAttribute('clip-path', `url(#${trailingNodeClipId})`);
    coupledBehindNodeGroup.dataset.clipLayer = trailingCameraLayer;
    cameraOverlayGroup.setAttribute('clip-path', `url(#${activeNodeClipId})`);
    cameraOverlayGroup.dataset.clipLayer = localState.activeLayer;
    frontLayerVeilGroup.appendChild(svgEl('path', {
      class: `egd-ontology-v2-layer-occlusion egd-ontology-v2-layer-occlusion-${localState.activeLayer}`,
      d: activeGeometry.rectPath(mainSpec.u, mainSpec.v, mainSpec.w, mainSpec.h),
      fill: localState.activeLayer === 'virtual'
        ? 'rgba(248, 246, 252, 0.48)'
        : 'rgba(244, 248, 250, 0.48)',
      data: { phase: localState.activePane, layer: localState.activeLayer },
    }));
    const rootExpanded = mainChildren.length > 0;
    const rootWidth = rootExpanded ? Math.min(0.56, mainSpec.w - 0.18) : Math.min(0.34, mainSpec.w - 0.22);
    const rootHeight = rootExpanded ? Math.min(0.30, mainSpec.h - 0.13) : Math.min(0.16, mainSpec.h - 0.20);
    const rootSpec = selected ? {
      u: mainSpec.u + (mainSpec.w - rootWidth) / 2,
      v: mainSpec.v + (rootExpanded ? 0.18 : 0.23),
      w: rootWidth,
      h: rootHeight,
    } : null;
    if (selected && rootSpec) {
      placements.set(selected.refId, { occurrence: selected, geometry: activeCameraGeometry, spec: rootSpec, kind: 'root', camera: true });
    }
    const parent = selected?.parentRef ? model.byRef.get(selected.parentRef) : null;
    const crossLayerContextRefIds = new Set([
      ...(parent && parent.layer !== localState.activeLayer ? [parent.refId] : []),
      ...directChildren.filter((child) => child.layer !== localState.activeLayer).map((child) => child.refId),
    ]);
    if (parent) {
      const labelScale = textScale / camera.zoom;
      const parentLabelWidth = Math.max(0.14, Math.min(0.30, model.labelFor(parent).length * 0.016 * labelScale));
      const tabSpec = { u: rootSpec.u + 0.025, v: rootSpec.v - 0.115, w: parentLabelWidth, h: 0.062 };
      const tab = svgEl('g', {
        class: 'egd-ontology-v2-breadcrumb',
        data: { refId: parent.refId },
        onclick: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          selectOntologyOccurrence(localState, model, parent.refId);
          rerender();
        },
      });
      tab.appendChild(svgEl('path', {
        class: 'egd-ontology-v2-breadcrumb-path',
        d: activeCameraGeometry.rectPath(tabSpec.u, tabSpec.v, tabSpec.w, tabSpec.h),
        fill: 'rgba(248, 244, 236, 0.98)',
        stroke: 'rgba(116, 104, 91, 0.44)',
        'stroke-width': '1.4',
      }));
      drawOntologyText(tab, activeCameraGeometry, tabSpec.u + 0.025, tabSpec.v + tabSpec.h * 0.64, `← ${model.labelFor(parent)}`, {
        class: 'egd-ontology-v2-breadcrumb-label', anchor: 'start', fill: 'rgba(47, 55, 63, 0.82)', 'font-size': '10', 'font-weight': '850',
      });
      cameraOverlayGroup.appendChild(tab);
    }

    if (emptyPhase) {
      const marker = activeCameraGeometry.point(0.38, 0.34);
      const markerTail = activeCameraGeometry.point(0.415, 0.34);
      const emptyState = svgEl('g', {
        class: 'egd-ontology-v2-empty-state',
        data: { phase: localState.activePane, layer: localState.activeLayer },
        role: 'status',
        'aria-label': `${ONTOLOGY_TIME_PANE_LABELS[localState.activePane]} 시점에는 snapshot이 없습니다`,
      });
      emptyState.appendChild(svgEl('circle', {
        class: 'egd-ontology-v2-empty-state-mark',
        cx: marker.x,
        cy: marker.y,
        r: 4,
        fill: localState.activeLayer === 'virtual' ? 'rgba(103, 67, 166, 0.56)' : 'rgba(63, 83, 68, 0.58)',
      }));
      emptyState.appendChild(svgEl('path', {
        class: 'egd-ontology-v2-empty-state-line',
        d: `M ${marker.x.toFixed(1)} ${marker.y.toFixed(1)} L ${markerTail.x.toFixed(1)} ${markerTail.y.toFixed(1)}`,
        fill: 'none',
        stroke: localState.activeLayer === 'virtual' ? 'rgba(103, 67, 166, 0.34)' : 'rgba(63, 83, 68, 0.36)',
        'stroke-width': '1.4',
      }));
      const emptyTitleV = 0.343;
      const emptyTitlePoint = activeCameraGeometry.point(0.43, emptyTitleV);
      const emptyBelowPoint = activeCameraGeometry.point(0.43, emptyTitleV + 0.01);
      const emptyPixelsPerV = Math.hypot(emptyBelowPoint.x - emptyTitlePoint.x, emptyBelowPoint.y - emptyTitlePoint.y) * screenScale / 0.01;
      const emptyHelpV = emptyTitleV + Math.max(0.043, 15 / Math.max(1, emptyPixelsPerV));
      drawOntologyText(emptyState, activeCameraGeometry, 0.43, emptyTitleV, '이 시점에는 snapshot이 없습니다', {
        class: 'egd-ontology-v2-empty-state-title',
        anchor: 'start',
        fill: 'rgba(47, 55, 63, 0.68)',
        'font-size': '12',
        'font-weight': '850',
      });
      drawOntologyText(emptyState, activeCameraGeometry, 0.43, emptyHelpV, '상단 시간축에서 다른 시점을 선택할 수 있습니다', {
        class: 'egd-ontology-v2-empty-state-help',
        anchor: 'start',
        fill: 'rgba(76, 83, 90, 0.46)',
        'font-size': '9.5',
        'font-weight': '700',
      });
      cameraOverlayGroup.appendChild(emptyState);
    }

    const childSpecs = [];
    if (mainChildren.length) {
      const columns = mainChildren.length === 1 ? 1 : Math.min(3, mainChildren.length);
      const rows = Math.ceil(mainChildren.length / columns);
      const areaU = rootSpec.u + 0.05;
      const areaV = rootSpec.v + 0.09;
      const areaW = rootSpec.w - 0.10;
      const areaH = rootSpec.h - 0.13;
      const gapU = 0.025;
      const gapV = 0.025;
      const cellW = Math.min(mainChildren.length === 1 ? areaW * 0.54 : areaW, (areaW - gapU * (columns - 1)) / columns);
      const cellH = Math.min(0.10, (areaH - gapV * (rows - 1)) / rows);
      mainChildren.forEach((child, index) => {
        const row = Math.floor(index / columns);
        const column = index % columns;
        const usedW = columns * cellW + (columns - 1) * gapU;
        const spec = {
          u: areaU + (areaW - usedW) / 2 + column * (cellW + gapU),
          v: areaV + Math.max(0, (areaH - (rows * cellH + (rows - 1) * gapV)) / 2) + row * (cellH + gapV),
          w: cellW,
          h: cellH,
        };
        childSpecs.push({ occurrence: child, spec });
        placements.set(child.refId, { occurrence: child, geometry: activeCameraGeometry, spec, kind: 'child', camera: true });
      });
    }

    const overviewSpecs = [];
    ONTOLOGY_TIME_PANE_ORDER.forEach((phase) => {
      const active = phase === localState.activePane;
      const items = active
        ? ONTOLOGY_LAYER_ORDER.flatMap((layer) => model.planeRootsFor(phase, layer))
        : getOntologySideItems(model, phase, visibleRefs, selected);
      if (!active) sideInventories.set(phase, items);
      const layerIndexes = { virtual: 0, physical: 0 };
      const visibleItems = items.slice(0, active ? 12 : 5).filter((occurrence) => (
        !active || (occurrence.refId !== selected?.refId && !crossLayerContextRefIds.has(occurrence.refId))
      ));
      const layerCounts = {
        virtual: visibleItems.filter((occurrence) => occurrence.layer !== 'physical').length,
        physical: visibleItems.filter((occurrence) => occurrence.layer === 'physical').length,
      };
      visibleItems.forEach((occurrence) => {
        const layer = occurrence.layer === 'physical' ? 'physical' : 'virtual';
        const layerSpec = sideLayerSpecs[layer];
        const geometry = layerGeometryFor(phase, layer);
        const layerIndex = layerIndexes[layer]++;
        const count = Math.max(1, layerCounts[layer]);
        let spec;
        let placementGeometry = geometry;
        let cameraBound = false;
        if (active) {
          const focusOccupiesLayer = !!selected && selected.layer === layer;
          const columns = focusOccupiesLayer ? 1 : Math.min(3, count);
          const rows = Math.ceil(count / columns);
          const areaU = focusOccupiesLayer ? 0.66 : 0.13;
          const areaW = focusOccupiesLayer ? 0.25 : 0.74;
          const gapU = 0.035;
          const gapV = 0.035;
          const cellW = Math.min(0.24, (areaW - gapU * (columns - 1)) / columns);
          const cellH = Math.min(0.14, layerSpec.h * 0.26);
          const usedW = columns * cellW + gapU * (columns - 1);
          const usedH = rows * cellH + gapV * (rows - 1);
          const column = layerIndex % columns;
          const row = Math.floor(layerIndex / columns);
          spec = {
            u: areaU + (areaW - usedW) / 2 + column * (cellW + gapU),
            v: layerSpec.v + Math.max(0.06, (layerSpec.h - usedH) / 2) + row * (cellH + gapV),
            w: cellW,
            h: cellH,
          };
          placementGeometry = activeLayerCameraGeometries.get(layer);
          cameraBound = true;
        } else {
          const sideSafeArea = phase === 'past'
            ? { u: 0.50, w: 0.46 }
            : phase === 'future'
              ? { u: 0.04, w: 0.46 }
              : { u: 0.12, w: 0.76 };
          const topPadding = Math.min(0.11, layerSpec.h * 0.24);
          const availableHeight = Math.max(0.10, layerSpec.h - topPadding - 0.08);
          const cellH = Math.min(0.12, availableHeight / count * 0.78);
          const step = availableHeight / count;
          spec = {
            u: sideSafeArea.u,
            v: layerSpec.v + topPadding + layerIndex * step,
            w: sideSafeArea.w,
            h: cellH,
          };
          if (temporallyCoupledRefIds.has(occurrence.refId)) {
            placementGeometry = cameraGeometriesByCell.get(`${phase}:${layer}`);
            cameraBound = true;
          }
        }
        overviewSpecs.push({
          occurrence,
          geometry: placementGeometry,
          spec,
          phase,
          active,
          cameraBound,
          behind: active && layer !== localState.activeLayer,
        });
        placements.set(occurrence.refId, {
          occurrence,
          geometry: placementGeometry,
          spec,
          kind: active ? 'overview' : 'side',
          camera: cameraBound,
        });
      });
    });

    const centerOf = (placement) => {
      return placement.geometry.point(
        placement.spec.u + placement.spec.w / 2,
        placement.spec.v + placement.spec.h / 2,
      );
    };
    const anchorOf = (placement, anchor = 'center') => {
      const { spec, geometry } = placement;
      if (anchor === 'left') return geometry.point(spec.u, spec.v + spec.h / 2);
      if (anchor === 'right') return geometry.point(spec.u + spec.w, spec.v + spec.h / 2);
      if (anchor === 'top') return geometry.point(spec.u + spec.w / 2, spec.v);
      if (anchor === 'bottom') return geometry.point(spec.u + spec.w / 2, spec.v + spec.h);
      return centerOf(placement);
    };
    const planeUForScreenX = (geometry, v, screenX) => {
      const left = geometry.point(0, v);
      const right = geometry.point(1, v);
      const span = right.x - left.x;
      if (Math.abs(span) < 0.001) return 0.5;
      return Math.max(0, Math.min(1, (screenX - left.x) / span));
    };
    const timeBoundarySegmentFor = (sourcePhase, targetPhase, layer) => {
      const sourceIndex = ONTOLOGY_TIME_PANE_ORDER.indexOf(sourcePhase);
      const targetIndex = ONTOLOGY_TIME_PANE_ORDER.indexOf(targetPhase);
      if (sourceIndex < 0 || targetIndex < 0 || Math.abs(sourceIndex - targetIndex) !== 1) return null;
      const leftPhase = ONTOLOGY_TIME_PANE_ORDER[Math.min(sourceIndex, targetIndex)];
      const rightPhase = ONTOLOGY_TIME_PANE_ORDER[Math.max(sourceIndex, targetIndex)];
      const boundaryGeometry = layerGeometryFor(leftPhase, layer);
      if (!boundaryGeometry) return null;
      return {
        key: `${leftPhase}|${rightPhase}|${layer}`,
        top: boundaryGeometry.corners.tr,
        bottom: boundaryGeometry.corners.br,
      };
    };
    const pointOnTimeBoundaryAtY = (boundary, screenY) => {
      const spanY = boundary.bottom.y - boundary.top.y;
      const t = Math.abs(spanY) < 0.001
        ? 0.5
        : Math.max(0, Math.min(1, (screenY - boundary.top.y) / spanY));
      return {
        x: boundary.top.x + (boundary.bottom.x - boundary.top.x) * t,
        y: boundary.top.y + spanY * t,
      };
    };
    const routeViaTimeBoundary = (start, end, sourcePhase, targetPhase, layer) => {
      const boundary = timeBoundarySegmentFor(sourcePhase, targetPhase, layer);
      if (!boundary) return null;
      const entry = pointOnTimeBoundaryAtY(boundary, start.y);
      const exit = pointOnTimeBoundaryAtY(boundary, end.y);
      return {
        boundary,
        entry,
        exit,
        d: `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} L ${entry.x.toFixed(1)} ${entry.y.toFixed(1)} L ${exit.x.toFixed(1)} ${exit.y.toFixed(1)} L ${end.x.toFixed(1)} ${end.y.toFixed(1)}`,
      };
    };
    const edgeKeys = new Set();
    const drawEdge = (sourceRef, targetRef, relation) => {
      const source = placements.get(sourceRef);
      const target = placements.get(targetRef);
      if (!source || !target) return;
      const key = `${sourceRef}|${relation}|${targetRef}`;
      if (edgeKeys.has(key)) return;
      edgeKeys.add(key);
      const sourceOccurrence = source.occurrence;
      const targetOccurrence = target.occurrence;
      const temporal = sourceOccurrence.timeSlice !== targetOccurrence.timeSlice;
      const crossLayer = sourceOccurrence.layer !== targetOccurrence.layer;
      let kind = 'reference';
      let sourceAnchor = 'right';
      let targetAnchor = 'left';
      let start;
      let end;
      let d;
      let temporalBoundaryRoute = null;
      let forward = true;
      if (temporal) {
        kind = 'temporal';
        const sourceIndex = ONTOLOGY_TIME_PANE_ORDER.indexOf(sourceOccurrence.timeSlice);
        const targetIndex = ONTOLOGY_TIME_PANE_ORDER.indexOf(targetOccurrence.timeSlice);
        forward = targetIndex >= sourceIndex;
        sourceAnchor = forward ? 'right' : 'left';
        targetAnchor = forward ? 'left' : 'right';
        start = anchorOf(source, sourceAnchor);
        end = anchorOf(target, targetAnchor);
        const boundaryLayer = sourceOccurrence.layer === targetOccurrence.layer
          ? sourceOccurrence.layer
          : localState.activeLayer;
        temporalBoundaryRoute = routeViaTimeBoundary(
          start,
          end,
          sourceOccurrence.timeSlice,
          targetOccurrence.timeSlice,
          boundaryLayer,
        );
        if (temporalBoundaryRoute) {
          d = temporalBoundaryRoute.d;
        } else {
          const busX = (start.x + end.x) / 2;
          d = `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} L ${busX.toFixed(1)} ${start.y.toFixed(1)} L ${busX.toFixed(1)} ${end.y.toFixed(1)} L ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
        }
      } else if (crossLayer) {
        kind = 'layer';
        const depthCoordinates = source.depthCoordinates || target.depthCoordinates;
        sourceAnchor = 'depth';
        targetAnchor = 'depth';
        const sourceDepthCoordinate = depthCoordinates?.[sourceRef];
        const targetDepthCoordinate = depthCoordinates?.[targetRef];
        start = sourceDepthCoordinate
          ? source.geometry.point(sourceDepthCoordinate.u, sourceDepthCoordinate.v)
          : centerOf(source);
        end = targetDepthCoordinate
          ? target.geometry.point(targetDepthCoordinate.u, targetDepthCoordinate.v)
          : centerOf(target);
        const sharedX = sourceOccurrence.layer === localState.activeLayer
          ? start.x
          : targetOccurrence.layer === localState.activeLayer
            ? end.x
            : (start.x + end.x) / 2;
        start = { x: sharedX, y: start.y };
        end = { x: sharedX, y: end.y };
        d = `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} L ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
      } else {
        const sourceCenter = centerOf(source);
        const targetCenter = centerOf(target);
        forward = targetCenter.x >= sourceCenter.x;
        sourceAnchor = forward ? 'right' : 'left';
        targetAnchor = forward ? 'left' : 'right';
        start = anchorOf(source, sourceAnchor);
        end = anchorOf(target, targetAnchor);
        const busX = (start.x + end.x) / 2;
        d = `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} L ${busX.toFixed(1)} ${start.y.toFixed(1)} L ${busX.toFixed(1)} ${end.y.toFixed(1)} L ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
      }
      const edgeStroke = kind === 'temporal'
        ? 'rgba(111, 90, 154, 0.46)'
        : kind === 'layer'
          ? 'rgba(63, 83, 68, 0.48)'
          : 'rgba(82, 89, 98, 0.26)';
      let temporalPaneClipId = null;
      if (kind === 'temporal') {
        temporalPaneClipId = `${layerClipBaseId}-temporal-${edgeKeys.size}`;
        const temporalPaneClip = svgEl('clipPath', { id: temporalPaneClipId });
        [sourceOccurrence, targetOccurrence].forEach((occurrence) => {
          const clipGeometry = layerGeometryFor(occurrence.timeSlice, occurrence.layer);
          const clipSpec = layerSpecs[occurrence.layer];
          temporalPaneClip.appendChild(svgEl('path', {
            d: clipGeometry.rectPath(clipSpec.u, clipSpec.v, clipSpec.w, clipSpec.h),
          }));
        });
        defs.appendChild(temporalPaneClip);
      }
      const targetEdgeGroup = kind === 'layer' ? depthEdgeGroup : edgeGroup;
      targetEdgeGroup.appendChild(svgEl('path', {
        class: `egd-ontology-v2-edge egd-ontology-v2-edge-${kind}`,
        d,
        'clip-path': temporalPaneClipId ? `url(#${temporalPaneClipId})` : null,
        fill: 'none',
        stroke: edgeStroke,
        'stroke-width': kind === 'temporal' ? '1.55' : kind === 'layer' ? '1.7' : '1.1',
        'stroke-dasharray': kind === 'layer' ? '6 5' : null,
        data: {
          sourceRef,
          targetRef,
          sourceAnchor,
          targetAnchor,
          relation,
          temporalBoundaryKey: temporalBoundaryRoute?.boundary.key || '',
          temporalBoundaryAligned: temporalBoundaryRoute ? 'true' : 'false',
          paneClipped: temporalPaneClipId ? 'true' : 'false',
          depthDx: kind === 'layer' ? (end.x - start.x).toFixed(2) : '',
          depthDy: kind === 'layer' ? (end.y - start.y).toFixed(2) : '',
        },
      }));
      if (kind !== 'layer') {
        edgeGroup.appendChild(svgEl('polygon', {
          class: 'egd-ontology-v2-edge-arrow',
          points: `${end.x},${end.y} ${end.x - (forward ? 6 : -6)},${end.y - 3} ${end.x - (forward ? 6 : -6)},${end.y + 3}`,
          'clip-path': temporalPaneClipId ? `url(#${temporalPaneClipId})` : null,
          fill: edgeStroke,
        }));
      }
    };
    model.referenceEdges.forEach((edge) => {
      const source = model.byRef.get(edge.sourceRef);
      const target = model.byRef.get(edge.targetRef);
      const nestedOnOnePlane = source && target
        && source.timeSlice === target.timeSlice
        && source.layer === target.layer
        && (source.parentRef === target.refId || target.parentRef === source.refId);
      if (!nestedOnOnePlane) drawEdge(edge.sourceRef, edge.targetRef, edge.relation);
    });

    const contextualRefs = [];
    if (parent && parent.layer !== localState.activeLayer) contextualRefs.push({ occurrence: parent, role: 'parent' });
    directChildren.filter((child) => child.layer !== localState.activeLayer).forEach((child) => contextualRefs.push({ occurrence: child, role: 'child' }));
    const visibleContextualRefs = contextualRefs.slice(0, 5);
    visibleContextualRefs.forEach(({ occurrence, role }, index) => {
      if (placements.has(occurrence.refId)) return;
      const contextSpec = layerSpecs[occurrence.layer];
      if (!contextSpec) return;
      const mainPlacement = placements.get(selected?.refId);
      if (!mainPlacement) return;
      const w = Math.min(0.16, mainPlacement.spec.w * 0.38);
      const h = Math.min(0.16, Math.max(0.13, mainPlacement.spec.h * 0.58));
      const slot = (index + 1) / (visibleContextualRefs.length + 1);
      const contextIsBelow = occurrence.layer === 'physical';
      const contextCenterV = mainPlacement.spec.v + mainPlacement.spec.h * 0.58 + (contextIsBelow ? 0.025 : -0.025);
      const trailingAnchorV = contextCenterV + (contextIsBelow ? -h / 2 : h / 2);
      const activeDepthCoordinate = {
        u: mainPlacement.spec.u + mainPlacement.spec.w * slot,
        v: contextIsBelow ? mainPlacement.spec.v + mainPlacement.spec.h : mainPlacement.spec.v,
      };
      const activeDepthPoint = mainPlacement.geometry.point(activeDepthCoordinate.u, activeDepthCoordinate.v);
      const contextGeometry = activeLayerCameraGeometries.get(occurrence.layer);
      const trailingAnchorU = Math.max(
        w / 2,
        Math.min(1 - w / 2, planeUForScreenX(contextGeometry, trailingAnchorV, activeDepthPoint.x)),
      );
      const spec = {
        u: trailingAnchorU - w / 2,
        v: contextCenterV - h / 2,
        w,
        h,
      };
      const trailingDepthCoordinate = {
        u: spec.u + spec.w / 2,
        v: trailingAnchorV,
      };
      drawOntologyOccurrenceBox(coupledBehindNodeGroup, model, contextGeometry, spec, occurrence, {
        context: true,
        contextRole: role,
        behind: true,
        onclick: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          selectOntologyOccurrence(localState, model, occurrence.refId);
          rerender();
        },
      });
      const contextPlacement = {
        occurrence,
        geometry: contextGeometry,
        spec,
        camera: true,
        kind: 'context',
        depthCoordinates: {
          [selected.refId]: activeDepthCoordinate,
          [occurrence.refId]: trailingDepthCoordinate,
        },
      };
      placements.set(occurrence.refId, contextPlacement);
      if (selected) {
        const explicitEdge = model.referenceEdges.find((edge) => (
          (edge.sourceRef === selected.refId && edge.targetRef === occurrence.refId)
          || (edge.sourceRef === occurrence.refId && edge.targetRef === selected.refId)
        ));
        const sourceRef = explicitEdge?.sourceRef || (role === 'parent' ? occurrence.refId : selected.refId);
        const targetRef = explicitEdge?.targetRef || (role === 'parent' ? selected.refId : occurrence.refId);
        drawEdge(sourceRef, targetRef, explicitEdge?.relation || occurrence.relation || 'contains');
      }
    });

    ONTOLOGY_TIME_PANE_ORDER.filter((phase) => phase !== localState.activePane).forEach((phase) => {
      const items = sideInventories.get(phase) || [];
      if (items.length <= 5) return;
      const fromPlacement = placements.get(selected?.refId);
      if (!fromPlacement) return;
      const forward = ONTOLOGY_TIME_PANE_ORDER.indexOf(phase) > ONTOLOGY_TIME_PANE_ORDER.indexOf(localState.activePane);
      const from = anchorOf(fromPlacement, forward ? 'right' : 'left');
      const sideGeometry = layerGeometryFor(phase, localState.activeLayer);
      const to = sideGeometry.point(phase === 'past' ? 0.96 : 0.04, 0.52);
      const boundaryRoute = routeViaTimeBoundary(
        from,
        to,
        localState.activePane,
        phase,
        localState.activeLayer,
      );
      const busX = (from.x + to.x) / 2;
      const d = boundaryRoute?.d
        || `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} L ${busX.toFixed(1)} ${from.y.toFixed(1)} L ${busX.toFixed(1)} ${to.y.toFixed(1)} L ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
      edgeGroup.appendChild(svgEl('path', {
        class: 'egd-ontology-v2-edge egd-ontology-v2-edge-bundle', d,
        fill: 'none', stroke: 'rgba(111, 90, 154, 0.38)', 'stroke-width': '1.7',
        data: {
          temporalBoundaryKey: boundaryRoute?.boundary.key || '',
          temporalBoundaryAligned: boundaryRoute ? 'true' : 'false',
        },
      }));
      const labelPoint = boundaryRoute
        ? {
          x: (boundaryRoute.entry.x + boundaryRoute.exit.x) / 2,
          y: (boundaryRoute.entry.y + boundaryRoute.exit.y) / 2 - 8,
        }
        : { x: busX, y: (from.y + to.y) / 2 - 8 };
      edgeGroup.appendChild(svgEl('rect', {
        class: 'egd-ontology-v2-bundle-label-bg', x: labelPoint.x - 18, y: labelPoint.y - 13, width: 36, height: 22, rx: 7,
        fill: 'rgba(255, 255, 255, 0.94)', stroke: 'rgba(111, 90, 154, 0.46)', 'stroke-width': '1',
      }));
      edgeGroup.appendChild(svgEl('text', {
        class: 'egd-ontology-v2-bundle-label', x: labelPoint.x, y: labelPoint.y + 3, 'text-anchor': 'middle',
        fill: 'rgba(89, 69, 132, 0.94)', 'font-size': '10', 'font-weight': '900',
      }, `+${items.length - 5}`));
    });

    if (selected && rootSpec) drawOntologyOccurrenceBox(activeNodeGroup, model, activeCameraGeometry, rootSpec, selected, {
      root: true,
      expanded: mainChildren.length > 0,
      labelScale: textScale / camera.zoom,
    });
    childSpecs.forEach(({ occurrence, spec }) => {
      drawOntologyOccurrenceBox(activeNodeGroup, model, activeCameraGeometry, spec, occurrence, {
        onclick: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          selectOntologyOccurrence(localState, model, occurrence.refId);
          rerender();
        },
      });
    });
    overviewSpecs.forEach(({ occurrence, geometry, spec, phase, active, cameraBound, behind }) => {
      const targetGroup = active
        ? (behind ? coupledBehindNodeGroup : activeNodeGroup)
        : fixedNodeGroup;
      const renderedBox = drawOntologyOccurrenceBox(targetGroup, model, geometry, spec, occurrence, {
        side: !active,
        overview: active,
        behind: behind || (!active && occurrence.layer !== localState.activeLayer),
        onclick: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (!active) activateOntologyPane(localState, model, phase, occurrence.conceptId);
          selectOntologyOccurrence(localState, model, occurrence.refId);
          rerender();
        },
      });
      if (!active) {
        const clipId = layerClipIds.get(`${phase}:${occurrence.layer}`);
        if (clipId) renderedBox.setAttribute('clip-path', `url(#${clipId})`);
        renderedBox.dataset.clipLayer = occurrence.layer;
        if (cameraBound) renderedBox.dataset.cameraCoupled = 'temporal';
      }
    });

    const arrowY = 62;
    const paneCenters = ONTOLOGY_TIME_PANE_ORDER.map((phase) => {
      const geometry = geometries.get(phase);
      return { phase, point: geometry.point(0.5, 0) };
    }).sort((a, b) => a.point.x - b.point.x);
    for (let index = 0; index < paneCenters.length - 1; index += 1) {
      const from = paneCenters[index].point;
      const to = paneCenters[index + 1].point;
      overlayGroup.appendChild(svgEl('path', {
        class: 'egd-ontology-v2-time-axis-arrow',
        d: `M ${from.x + 24} ${arrowY} L ${to.x - 24} ${arrowY}`,
        fill: 'none', stroke: 'rgba(111, 90, 154, 0.30)', 'stroke-width': '1.5', 'stroke-dasharray': '7 6',
      }));
      overlayGroup.appendChild(svgEl('polygon', {
        class: 'egd-ontology-v2-time-axis-arrow-head',
        points: `${to.x - 24},${arrowY} ${to.x - 34},${arrowY - 5} ${to.x - 34},${arrowY + 5}`,
        fill: 'rgba(111, 90, 154, 0.66)',
      }));
    }

    cameraGroup.appendChild(coupledBehindNodeGroup);
    cameraGroup.appendChild(frontLayerVeilGroup);
    cameraGroup.appendChild(activeNodeGroup);
    cameraGroup.appendChild(cameraOverlayGroup);
    svg.appendChild(surfaceGroup);
    svg.appendChild(edgeGroup);
    svg.appendChild(cameraGroup);
    svg.appendChild(depthEdgeGroup);
    svg.appendChild(fixedNodeGroup);
    svg.appendChild(overlayGroup);
    // Interaction controls stay above visual occlusion and shading layers.
    svg.appendChild(layerControlGroup);
    svg.appendChild(timeAxisGroup);
    stage.appendChild(svg);
    stage.appendChild(el('div', {
      class: 'egd-ontology-stage-hint',
      'aria-hidden': 'true',
    }, '드래그 이동  ·  휠 스크롤  ·  ⌘/Ctrl + 휠 확대'));

    const minimap = el('div', {
      class: 'egd-ontology-minimap egd-ontology-v2-minimap',
      data: {
        activePane: localState.activePane,
        activeStratum: localState.activeLayer,
        zoom: camera.zoom.toFixed(2),
      },
      role: 'navigation',
      'aria-label': `${ONTOLOGY_TIME_PANE_LABELS[localState.activePane]} pane 개념 분포 미니맵`,
    });
    const miniCorners = ONTOLOGY_LAYER_ORDER.flatMap((layer) => (
      Object.values(layerGeometryFor(localState.activePane, layer).corners)
    ));
    const miniMinX = Math.min(...miniCorners.map((point) => point.x));
    const miniMaxX = Math.max(...miniCorners.map((point) => point.x));
    const miniMinY = Math.min(...miniCorners.map((point) => point.y));
    const miniMaxY = Math.max(...miniCorners.map((point) => point.y));
    const miniPadX = Math.max(8, (miniMaxX - miniMinX) * 0.018);
    const miniPadY = Math.max(6, (miniMaxY - miniMinY) * 0.025);
    const miniViewWidth = miniMaxX - miniMinX + miniPadX * 2;
    const miniViewHeight = miniMaxY - miniMinY + miniPadY * 2;
    const miniSvg = svgEl('svg', {
      class: 'egd-ontology-minimap-map',
      viewBox: `${(miniMinX - miniPadX).toFixed(1)} ${(miniMinY - miniPadY).toFixed(1)} ${(miniMaxX - miniMinX + miniPadX * 2).toFixed(1)} ${(miniMaxY - miniMinY + miniPadY * 2).toFixed(1)}`,
      preserveAspectRatio: 'none',
      data: { scope: 'active-pane', phase: localState.activePane },
    });
    layerRenderOrder.forEach((layer) => {
      const miniGeometry = layerGeometryFor(localState.activePane, layer);
      const spec = layerSpecs[layer];
      const activateMiniRegion = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        setOntologyLayer(localState, layer);
        rerender();
      };
      miniSvg.appendChild(svgEl('path', {
        class: `egd-ontology-minimap-layer-pane egd-ontology-minimap-time-active${layer === localState.activeLayer ? ' egd-ontology-minimap-layer-pane-active' : ''}`,
        d: miniGeometry.rectPath(spec.u, spec.v, spec.w, spec.h),
        fill: layer === 'virtual' ? '#7E57C2' : '#49634F',
        data: { phase: localState.activePane, layer },
        tabindex: '0',
        role: 'button',
        'aria-label': `${ONTOLOGY_TIME_PANE_LABELS[localState.activePane]} ${layer === 'virtual' ? '가상' : '물리'} 층으로 이동`,
        onclick: activateMiniRegion,
        onkeydown: (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') activateMiniRegion(ev);
        },
      }));
    });
    const minimapRefs = new Set();
    placements.forEach((placement, refId) => {
      if (placement.occurrence.timeSlice !== localState.activePane) return;
      if (minimapRefs.has(refId)) return;
      minimapRefs.add(refId);
      const occurrence = placement.occurrence;
      const geometry = layerGeometryFor(occurrence.timeSlice, occurrence.layer);
      const point = geometry.point(
        placement.spec.u + placement.spec.w / 2,
        placement.spec.v + placement.spec.h / 2,
      );
      const isSelected = refId === selected?.refId;
      const markerSize = isSelected ? 5 : 3.5;
      miniSvg.appendChild(svgEl('ellipse', {
        class: `egd-ontology-minimap-node${isSelected ? ' egd-ontology-minimap-node-selected' : ''}`,
        cx: point.x,
        cy: point.y,
        rx: markerSize * miniViewWidth / 168,
        ry: markerSize * miniViewHeight / 110,
        fill: occurrence.layer === 'virtual' ? '#6F469F' : '#3F5344',
        stroke: 'rgba(255, 255, 255, 0.94)',
        'stroke-width': isSelected ? '4' : '2.5',
        data: { refId, phase: occurrence.timeSlice, layer: occurrence.layer },
        role: 'button',
        tabindex: '0',
        'aria-label': `${model.labelFor(occurrence)} 개념으로 이동`,
        onclick: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          selectOntologyOccurrence(localState, model, refId);
          rerender();
        },
        onkeydown: (ev) => {
          if (ev.key !== 'Enter' && ev.key !== ' ') return;
          ev.preventDefault();
          ev.stopPropagation();
          selectOntologyOccurrence(localState, model, refId);
          rerender();
        },
      }));
    });
    miniSvg.appendChild(svgEl('path', {
      class: 'egd-ontology-minimap-viewport-halo',
      d: activeGeometry.rectPath(
        activeCameraGeometry.viewportSpec.u,
        activeCameraGeometry.viewportSpec.v,
        activeCameraGeometry.viewportSpec.w,
        activeCameraGeometry.viewportSpec.h,
      ),
      fill: 'none', stroke: 'rgba(255, 255, 255, 0.92)', 'stroke-width': '4.2',
    }));
    miniSvg.appendChild(svgEl('path', {
      class: 'egd-ontology-minimap-viewport',
      d: activeGeometry.rectPath(
        activeCameraGeometry.viewportSpec.u,
        activeCameraGeometry.viewportSpec.v,
        activeCameraGeometry.viewportSpec.w,
        activeCameraGeometry.viewportSpec.h,
      ),
      fill: 'none',
      stroke: localState.activeLayer === 'virtual' ? 'rgba(103, 67, 166, 0.96)' : 'rgba(63, 83, 68, 0.96)',
      'stroke-width': '2.2',
      'stroke-dasharray': '5 3',
    }));
    const minimapSummaryId = `${String(card?.id || 'ontology')}-minimap-summary`;
    minimap.setAttribute('aria-describedby', minimapSummaryId);
    minimap.appendChild(miniSvg);
    minimap.appendChild(el('div', {
      id: minimapSummaryId,
      class: 'egd-ontology-minimap-context',
    },
      el('span', { class: 'egd-ontology-minimap-context-title', title: selected ? `${model.labelFor(selected)} 주변` : '선택된 개념 없음' },
        selected ? `${model.labelFor(selected)} 주변` : '선택된 개념 없음'),
      el('span', { class: 'egd-ontology-minimap-context-coordinate' },
        `${ONTOLOGY_TIME_PANE_LABELS[localState.activePane]} · ${localState.activeLayer === 'virtual' ? '가상' : '물리'}`,
      ),
    ));
    minimap.appendChild(el('div', {
      class: 'egd-ontology-minimap-legend',
      'aria-hidden': 'true',
    },
      el('span', { class: 'egd-ontology-minimap-legend-item' },
        el('i', { class: 'egd-ontology-minimap-legend-swatch egd-ontology-minimap-legend-swatch-virtual' }), '가상'),
      el('span', { class: 'egd-ontology-minimap-legend-item' },
        el('i', { class: 'egd-ontology-minimap-legend-swatch egd-ontology-minimap-legend-swatch-physical' }), '물리'),
      el('span', { class: 'egd-ontology-minimap-legend-item' },
        el('i', { class: 'egd-ontology-minimap-legend-swatch egd-ontology-minimap-legend-swatch-selected' }), '선택'),
      el('span', { class: 'egd-ontology-minimap-legend-item' },
        el('i', { class: 'egd-ontology-minimap-legend-swatch egd-ontology-minimap-legend-swatch-viewport' }), '화면'),
    ));
    stage.appendChild(minimap);
    const tools = el('div', { class: 'egd-ontology-stage-mini-tools' },
      el('button', { class: 'egd-ontology-stage-mini-tool egd-ontology-stage-mini-tool-zoom-in', title: '확대', onclick: (ev) => {
        ev.stopPropagation(); adjustOntologyCameraZoom(camera, 1); rerender();
      } }, '+'),
      el('button', { class: 'egd-ontology-stage-mini-tool egd-ontology-stage-mini-tool-reset', title: '맞춤', onclick: (ev) => {
        ev.stopPropagation(); resetOntologyCamera(camera); rerender();
      } }, '⌂'),
      el('button', { class: 'egd-ontology-stage-mini-tool egd-ontology-stage-mini-tool-zoom-out', title: '축소', onclick: (ev) => {
        ev.stopPropagation(); adjustOntologyCameraZoom(camera, -1); rerender();
      } }, '−'),
    );
    stage.appendChild(tools);
    stage.appendChild(el('div', { class: 'egd-ontology-stage-zoom-label' }, `${Math.round(camera.zoom * 100)}%`));
  }

  async function loadOntologyGraph() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      // This private, launcher-created marker belongs to this Firefox profile;
      // it is never used as a path or copied into a bridge response.
      const markerResponse = await fetch('chrome://userchrome/content/egdesk-ontology-binding.json', {
        cache: 'no-store', signal: controller.signal,
      });
      if (!markerResponse.ok) throw Object.assign(new Error('Profile binding unavailable'), { code: 'ONTOLOGY_PROFILE_UNAVAILABLE' });
      const marker = await markerResponse.json();
      if (marker?.version !== 1 || !/^[a-f0-9]{64}$/.test(marker.profileId || '') || !/^[a-f0-9]{64}$/.test(marker.token || '')) {
        throw Object.assign(new Error('Invalid profile binding'), { code: 'ONTOLOGY_PROFILE_UNAVAILABLE' });
      }
      const response = await fetch('http://127.0.0.1:39218/ontology/graph', {
        cache: 'no-store', credentials: 'omit', signal: controller.signal,
        headers: { 'X-EGDesk-Ontology-Profile': marker.profileId, 'X-EGDesk-Ontology-Token': marker.token },
      });
      if (!response.ok) {
        let payload = null;
        try { payload = await response.json(); } catch {}
        throw Object.assign(new Error('Ontology storage unavailable'), { code: payload?.code || 'ONTOLOGY_STORE_UNAVAILABLE' });
      }
      if (response.headers.get('X-EGDesk-Ontology-Profile') !== marker.profileId) {
        throw Object.assign(new Error('Ontology response profile mismatch'), { code: 'ONTOLOGY_PROFILE_MISMATCH' });
      }
      return validateOntologyGraph(await response.json());
    } finally { clearTimeout(timer); }
  }

  function spawnOntologyMapCard(initialState = {}) {
    const sourceRef = singletonSourceRef('ontology-map', {
      kind: 'ontology-map',
      path: 'ontology/index.md',
      openMode: 'interactive',
    });
    const existing = focusOpenSourceCard(sourceRef);
    if (existing) return existing;

    const id = `egd-ontology-card-${allocCardSeq()}`;
    const placement = resolveCanvasCardPlacement('ontology', { avoidHud: false, margin: 12 });
    const deskWindow = spawnDeskWindowShell({
      id,
      kind: 'ontology',
      className: 'egd-ontology-card',
      headerClassName: 'egd-ontology-header',
      bodyClassName: 'egd-ontology-body',
      inputPolicy: 'adapter-owned',
      sourceRef,
      minWidth: 680,
      minHeight: 440,
      createDirtyReason: 'create-ontology-card',
      moveDirtyReason: 'move-ontology-card',
      resizeDirtyReason: 'resize-ontology-card',
      style: {
        top: placement.y + 'px',
        left: placement.x + 'px',
        width: placement.width + 'px',
        height: placement.height + 'px',
        zIndex: String(raiseCardZ()),
      },
    });
    const card = deskWindow.root;
    revealPlacedCanvasCard(card, placement);
    deskWindow.slots.identity.classList.add('egd-ontology-titlebar-identity');
    deskWindow.slots.identity.append(
      el('div', { class: 'egd-ontology-title' }, '온톨로지'),
      el('div', { class: 'egd-ontology-header-lens' }, '과거 · 현재 · 미래  /  가상 · 물리'),
    );

    const initialSelectedRefId = initialState.selectedRefId || initialState.selectedId || 'present.server';
    const initialPane = ONTOLOGY_TIME_PANE_ORDER.includes(initialState.activePane) ? initialState.activePane : 'present';
    const initialLayer = ONTOLOGY_LAYER_ORDER.includes(initialState.activeLayer || initialState.activeStratum)
      ? (initialState.activeLayer || initialState.activeStratum)
      : 'virtual';
    const localState = {
      mode: 'composite',
      selectedId: initialSelectedRefId,
      selectedRefId: initialSelectedRefId,
      selectedConceptId: initialState.selectedConceptId || 'server',
      focusTarget: 'object',
      activePane: initialPane,
      activeLayer: initialLayer,
      activeStratum: initialLayer,
      activeDepth: initialLayer,
      pan: initialState.pan || { x: 0, y: 0 },
      zoom: Number.isFinite(initialState.zoom) ? initialState.zoom : 1,
      cameraByCell: initialState.cameraByCell || {},
    };
    card._ontologyState = localState;

    let stage;
    card._ontologyRender = () => {
      if (stage && card._ontologyGraph) renderOntologyMap(stage, card._ontologyGraph, localState);
    };
    card._ontologyApplyWheelDelta = (deltaX = 0, deltaY = 0, modifiers = {}) => {
      const camera = getOntologyCamera(localState);
      if (modifiers.ctrlKey || modifiers.metaKey) {
        adjustOntologyCameraZoom(camera, deltaY < 0 ? 1 : -1);
      } else {
        camera.x -= deltaX;
        camera.y -= deltaY;
      }
      if (stage && card._ontologyGraph) renderOntologyMap(stage, card._ontologyGraph, localState);
      return {
        activePane: localState.activePane,
        activeLayer: localState.activeLayer,
        activeDepth: localState.activeLayer,
        activeStratum: localState.activeLayer,
        pan: { x: camera.x, y: camera.y },
        zoom: camera.zoom,
      };
    };
    card._ontologyPanBy = (deltaX = 0, deltaY = 0) => {
      const camera = getOntologyCamera(localState);
      camera.x += deltaX;
      camera.y += deltaY;
      card._ontologyRender();
      return { x: camera.x, y: camera.y };
    };
    stage = el('div', {
      class: 'egd-ontology-stage',
      tabindex: '0',
      'aria-label': 'EG-Desk ontology interaction canvas',
    },
      el('div', { class: 'egd-ontology-loading' }, '온톨로지 그래프를 불러오는 중...'),
    );
    const body = deskWindow.slots.content;
    body.style.position = 'relative';
    body.appendChild(stage);
    deskWindow.onResize(() => {
      if (card._ontologyGraph) renderOntologyMap(stage, card._ontologyGraph, localState);
    });

    let viewDrag = null;
    const beginViewPan = (ev) => {
      if (ev.button !== 0 || ev.target.closest('.egd-ontology-v2-breadcrumb, .egd-ontology-v2-time-axis-hit, .egd-ontology-v2-layer-label-control, .egd-ontology-v2-layer-switch-hit, .egd-ontology-minimap, .egd-ontology-stage-mini-tools, .egd-ontology-stage-zoom-label')) return;
      const conceptBox = ev.target.closest('.egd-ontology-v2-box');
      if (conceptBox && !conceptBox.classList.contains('egd-ontology-v2-box-root')) return;
      const paneHit = ev.target.closest('.egd-ontology-time-coordinate');
      if (paneHit && paneHit.dataset.phase !== localState.activePane) return;
      if (viewDrag) return;
      focusCanvasCard(card);
      try { stage.focus({ preventScroll: true }); } catch { stage.focus(); }
      const camera = getOntologyCamera(localState);
      viewDrag = { x: ev.clientX, y: ev.clientY, panX: camera.x, panY: camera.y, moved: false, pointerId: ev.pointerId ?? null };
      ev.preventDefault();
    };
    stage.addEventListener('pointerdown', beginViewPan, { capture: true });
    stage.addEventListener('mousedown', beginViewPan, { capture: true });
    stage.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.target.closest('.egd-ontology-minimap, .egd-ontology-stage-mini-tools, .egd-ontology-stage-zoom-label')) return;
      card._ontologyApplyWheelDelta(ev.deltaX, ev.deltaY, { ctrlKey: ev.ctrlKey, metaKey: ev.metaKey });
    }, { capture: true, passive: false });
    body.addEventListener('wheel', (ev) => {
      if (!stage.contains(ev.target)) ev.stopPropagation();
    }, { capture: true, passive: false });
    stage.addEventListener('keydown', (ev) => {
      let handled = true;
      const camera = getOntologyCamera(localState);
      if (ev.key === 'ArrowLeft') {
        camera.x += 36;
      } else if (ev.key === 'ArrowRight') {
        camera.x -= 36;
      } else if (ev.key === 'ArrowUp') {
        camera.y += 36;
      } else if (ev.key === 'ArrowDown') {
        camera.y -= 36;
      } else if (ev.key === '0') {
        resetOntologyCamera(camera);
      } else {
        handled = false;
      }
      if (!handled) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (card._ontologyGraph) renderOntologyMap(stage, card._ontologyGraph, localState);
    });

    const onMove = (ev) => {
      if (viewDrag) {
        const distance = Math.hypot(ev.clientX - viewDrag.x, ev.clientY - viewDrag.y);
        if (!viewDrag.moved) {
          if (distance <= 3) return;
          viewDrag.moved = true;
          if (viewDrag.pointerId != null) {
            try { stage.setPointerCapture(viewDrag.pointerId); } catch {}
          }
        }
        const camera = getOntologyCamera(localState);
        camera.x = viewDrag.panX + (ev.clientX - viewDrag.x);
        camera.y = viewDrag.panY + (ev.clientY - viewDrag.y);
        if (card._ontologyGraph) renderOntologyMap(stage, card._ontologyGraph, localState);
        stage.classList.add('egd-ontology-stage-panning');
      }
    };
    const onUp = () => {
      if (viewDrag?.moved) {
        localState.suppressNextSurfaceClick = true;
        setTimeout(() => { localState.suppressNextSurfaceClick = false; }, 0);
      }
      viewDrag = null;
      stage.classList.remove('egd-ontology-stage-panning');
    };
    stage.addEventListener('mousemove', onMove, { capture: true });
    stage.addEventListener('mouseup', onUp, { capture: true });
    stage.addEventListener('pointermove', onMove, { capture: true });
    stage.addEventListener('pointerup', onUp, { capture: true });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    deskWindow.registerCleanup(() => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      stage.removeEventListener('pointerdown', beginViewPan, { capture: true });
      stage.removeEventListener('mousedown', beginViewPan, { capture: true });
      stage.removeEventListener('mousemove', onMove, { capture: true });
      stage.removeEventListener('mouseup', onUp, { capture: true });
      stage.removeEventListener('pointermove', onMove, { capture: true });
      stage.removeEventListener('pointerup', onUp, { capture: true });
    });

    let notice = null;
    let loadGeneration = 0;
    let disposed = false;
    const loadGraph = async () => {
      const generation = ++loadGeneration;
      try {
        const graph = await loadOntologyGraph();
        if (disposed || generation !== loadGeneration) return;
        const previous = card._ontologyGraph;
        try { renderOntologyMap(stage, graph, localState); }
        catch (error) {
          if (previous) {
            try { renderOntologyMap(stage, previous, localState); } catch {}
          }
          throw error;
        }
        card._ontologyGraph = graph;
        notice?.remove();
        notice = null;
      } catch (error) {
        if (disposed || generation !== loadGeneration) return;
        if (!card._ontologyGraph) stage.textContent = '';
        notice?.remove();
        const message = error?.code === 'ONTOLOGY_PROFILE_MISMATCH'
          ? '다른 Firefox 프로필의 브리지가 실행 중입니다. 해당 연결을 확인해 주세요.'
          : error?.code === 'ONTOLOGY_TOKEN_REQUIRED' || error?.code === 'ONTOLOGY_PROFILE_UNAVAILABLE'
            ? '이 Firefox 프로필의 온톨로지 연결을 확인할 수 없습니다.'
            : '온톨로지 저장소를 불러오지 못했습니다. 저장소와 브리지를 확인해 주세요.';
        notice = el('div', {
          class: 'egd-ontology-error', role: 'alert',
          style: { position: 'absolute', inset: 'auto', top: '12px', left: '50%', transform: 'translateX(-50%)', zIndex: '20',
            display: 'flex', gap: '10px', alignItems: 'center', maxWidth: 'min(90%, 620px)', padding: '10px 14px',
            borderRadius: '8px', background: '#fff8f5', boxShadow: '0 2px 12px rgba(30, 38, 45, 0.18)' },
        }, el('span', {}, message), el('button', { type: 'button', onclick: () => { void loadGraph(); } }, '다시 시도'));
        body.appendChild(notice);
      }
    };
    card._ontologyReload = loadGraph;
    deskWindow.registerCleanup(() => { disposed = true; loadGeneration += 1; });
    void loadGraph();

    return card;
  }

  return { spawnOntologyMapCard };
}
