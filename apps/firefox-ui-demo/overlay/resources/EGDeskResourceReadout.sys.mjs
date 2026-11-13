// Pure view-model for the host resource readouts (CPU · 메모리 · 디스크 · 네트워크).
// A value is drawn as fixed cells — number | unit — so a new sample changes only
// the text inside a cell: 9 -> 10, 99 -> 100 %, KiB -> MiB never move a neighbour.
// No DOM globals here; the surface passes the node factory in.

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

// Widest number a cell holds: "1.23", "12.3", "999", "0.98".
export const RESOURCE_NUMBER_CH = 4;

const numeric = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// Three significant digits; a value that would need a fourth integer digit
// moves to the next unit (1000 B -> 0.98 KiB), so the number is never wider than four characters.
export function sizeParts(bytes) {
  if (!numeric(bytes)) return null;
  let value = bytes;
  let unit = 0;
  while (value >= 999.5 && unit < UNITS.length - 1) { value /= 1024; unit += 1; }
  if (unit === 0) return { number: String(Math.round(value)), unit: UNITS[0] };
  const number = value < 9.995 ? value.toFixed(2) : value < 99.95 ? value.toFixed(1) : String(Math.round(value));
  return { number, unit: UNITS[unit] };
}

export function percentParts(percent) {
  if (!numeric(percent)) return null;
  return { number: String(Math.round(Math.min(100, percent))), unit: '%' };
}

// Words for title / aria-label.
export function amountText(parts, suffix = '') {
  if (!parts) return '—';
  return parts.unit === '%' ? `${parts.number}%` : `${parts.number} ${parts.unit}${suffix}`;
}

const amountCells = (parts, suffix) => [
  { kind: 'num', text: parts ? parts.number : '—' },
  { kind: 'unit', text: parts ? `${parts.unit}${suffix}` : '' },
];

export function textValue(text) {
  return { layout: 'text', cells: [{ kind: 'text', text: String(text) }] };
}

// One number with its unit. An unmeasured value keeps both cells: — and an empty unit.
export function amountValue(parts, suffix = '') {
  return { layout: suffix ? 'rate' : 'size', cells: amountCells(parts, suffix) };
}

export function percentValue(parts) {
  return { layout: 'percent', cells: amountCells(parts, '') };
}

// Two labelled numbers stacked on two lines (읽기 / 쓰기, 수신 / 송신).
export function pairValue(firstLabel, firstParts, secondLabel, secondParts, suffix = '') {
  return {
    layout: 'pair',
    cells: [
      { kind: 'label', text: firstLabel }, ...amountCells(firstParts, suffix),
      { kind: 'label', text: secondLabel }, ...amountCells(secondParts, suffix),
    ],
  };
}

// Words in the place of two stacked speeds (지원하지 않음 · 측정 준비 중): keeps the two-line height.
export function pairStatusValue(text) {
  return { layout: 'pair-status', cells: [{ kind: 'text', text: String(text) }] };
}

// used / total.
export function rangeValue(usedParts, totalParts) {
  return { layout: 'range', cells: [...amountCells(usedParts, ''), { kind: 'sep', text: '/' }, ...amountCells(totalParts, '')] };
}

const drawn = new WeakMap();

// Draws a value into its host once, then only rewrites the cells whose text
// changed. Returns how many nodes were written (0 when nothing changed).
export function syncValue(host, value, makeCell) {
  const signature = `${value.layout}:${value.cells.map(cell => cell.kind).join(',')}`;
  const state = drawn.get(host);
  if (!state || state.signature !== signature) {
    const nodes = value.cells.map(cell => makeCell(cell));
    host.className = `egd-resource-figure egd-resource-figure-${value.layout}`;
    host.replaceChildren(...nodes);
    drawn.set(host, { signature, nodes, texts: value.cells.map(cell => cell.text) });
    return nodes.length;
  }
  let writes = 0;
  value.cells.forEach((cell, index) => {
    if (state.texts[index] === cell.text) return;
    state.nodes[index].textContent = cell.text;
    state.texts[index] = cell.text;
    writes += 1;
  });
  return writes;
}

// put(key, value, write) calls write only when the value differs from the last one written for that key.
export function createWriteGate() {
  const last = new Map();
  return (key, value, write) => {
    if (last.has(key) && last.get(key) === value) return false;
    last.set(key, value);
    write(value);
    return true;
  };
}
