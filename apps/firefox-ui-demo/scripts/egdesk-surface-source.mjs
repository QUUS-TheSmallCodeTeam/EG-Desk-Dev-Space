import { readFileSync } from 'node:fs';

const overlay = new URL('../overlay/', import.meta.url);
const read = (relative, root) => readFileSync(new URL(relative, root), 'utf8').replace(/\r\n/g, '\n');

// Include every loaded zone so source assertions (especially negative ones)
// still cover the code moved out of the core. Preserve the installer's order.
export function surfaceModuleFiles(script = read('JS/eg-desk-surface.uc.js', overlay)) {
  return [...script.matchAll(/\bload\(\s*(['"])(EGDeskSurface[A-Za-z0-9]+\.mjs)\1\s*\)/g)]
    .map(match => `resources/surface/${match[2]}`);
}

export function readSurfaceSource(root = overlay) {
  const script = read('JS/eg-desk-surface.uc.js', root);
  return [script, ...surfaceModuleFiles(script).map(file => read(file, root))].join('\n');
}
